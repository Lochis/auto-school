/** Long-running scheduler for containers/VMs: poll for live meetings, join the
 *  first joinable one, record + run the pipeline, then go back to watching.
 *
 *  One meeting at a time (persistent-profile lock: only one Chromium may touch
 *  user-data). Titles already handled this run are skipped; restart resets.
 *
 *  Env: POLL_MINUTES (default 2) — idle poll cadence.
 *       CONTROLLER_PORT (default 7800) — tiny HTTP control surface for the UI:
 *         GET  /healthz        → {ok}
 *         GET  /status         → {state, lastScan, seen, handled}
 *         POST /scan?reset=1   → rescan now (reset clears the handled set —
 *                                use to re-attend a same-titled test meeting)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createReadStream, readdirSync, statSync, existsSync, rmSync, writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import archiver from "archiver";
import { join, dirname, extname, normalize, resolve, sep } from "node:path";
import { TEAMS_URL } from "./login/teams-login.ts";
import { getBrowser, invalidateBrowser, closeBrowser, authAlive, isSharedPage, lastLoginFailedAt, lastLoginFailDetail } from "./meetings/browser.ts";
import { listMeetings } from "./meetings/list.ts";
import { joinMeeting, joinMeetingByUrl } from "./meetings/join.ts";
import { listTodayMeetings } from "./graph/meetings.ts";
import { startNetworkHarvest } from "./graph/calendar.ts";
import { getAccessToken } from "./graph/auth.ts";
import { config } from "./config.ts";
import { parseMultipart, placePart, discardPart } from "./http/multipart.ts";
import { startRecording, quickStopRecording, stopRecording, stillInMeeting, rebuildSeekPoints, RECORD_DIR } from "./record/recorder.ts";
import { consolidateSession } from "./pipeline/consolidate.ts";
import { notify } from "./notify.ts";
import { setActivity, setDetail, pushEvent, snapshot, getSettings, setSettings, getModelQuotas, loadLeftToday, recordLeftToday, clearLeftToday, hydrateLeftToday, applySettingsPatch, hydrateSettings } from "./status.ts";
import { lastDeviceCode } from "./graph/auth.ts";
import { NOTES_DIR, RECORDINGS_DIR, OUT_DIR, SEGMENTS_DIR, outPath, DATA_DIR } from "./paths.ts";
import { listMaterials, listIndexFiles, registerMaterial, deleteMaterial, renameMaterial, sanitizeRelPath, weekFromPath, MATERIALS_DIR, getCourseConfig, setCourseConfig, weekOf, weekMonday, hydrateCourseConfigs } from "./pipeline/materials.ts";
import { glmChatRaw, glmChatStream, type ChatMsg, type ToolCall } from "./pipeline/llm.ts";
import { TOOL_DEFS, TOOL_DEFS_WITH_WEB, runTool, allCourses } from "./pipeline/tools.ts";
import { generateChecklist, ChecklistGenError } from "./db/gen/checklist.ts";
import { rebuildDeadlines, DeadlineGenError } from "./db/gen/deadlines.ts";
import { ensureIndex, indexDir, bundleFresh, supportsIndex } from "./pipeline/docindex.ts";
import { mdToPdf } from "./pipeline/render.ts";
import { readDoc } from "./pipeline/docindex.ts";
import { rebuildIndex, parseCourse, courseDir, refreshMappings, normTitle as normMappingTitle } from "./pipeline/courses.ts";
import { finalizeNotes } from "./pipeline/notes.ts";
import { updateSession, listSessions, hydrateSessions, stemTimes } from "./pipeline/sessions.ts";
import { transcribeFile } from "./transcribe/transcribe.ts";
import { runRetention, retainedUntilFrom } from "./pipeline/retention.ts";
import { embedPendingMaterials, embedPendingSessions, embedOneMaterial } from "./db/ingest-embed.ts";
import { getPool } from "./db/client.ts";
import { readDl, writeDl, readFolds, writeFolds, readCk, writeCk, foldChildInto, dlKey, dlId, itemId, uniqIds, type Dl, type Ck, type CkItem } from "./db/deadlines.ts";
import { OWNER, courseId, upsertMapping, deleteMapping, listMappings, sessionId, upsertArtifact, upsertCourseConfig } from "./db/writes.ts";
import { ownerALS, curOwner } from "./db/owner.ts";
import { getUserIdBySub } from "./db/avatar.ts";
import { chatList, chatSave, chatClear, attendanceLoad, attendanceUpsert } from "./db/state.ts";
import { startRecorderHeartbeat } from "./recorder-heartbeat.ts";

const POLL_MS = (Number(process.env.POLL_MINUTES ?? 2) || 2) * 60_000;
const DISCOVERY_MS = (Number(process.env.DISCOVERY_SECONDS ?? 60) || 60) * 1_000; // Graph poll cadence
// join this long before start — re-read at use so Settings applies without restart
const joinEarlyMs = () => Math.max(0, getSettings().joinEarlyMinutes) * 60_000;
const PORT = Number(process.env.CONTROLLER_PORT ?? 7800) || 7800;
/** Content types for the raw media route (kept in sync with the platform
 *  media route's table — the proxy forwards our Content-Type verbatim). */
const MEDIA_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// chat tool-calling rounds — deep transcript forensics (workshops, long Q&A)
// need more than a handful of search/read rounds; env-tunable per deployment
const CHAT_STEPS = Math.max(4, Number(process.env.CHAT_STEPS ?? 16) || 16);
const CHAT_STEPS_GLOBAL = Math.max(4, Number(process.env.CHAT_STEPS_GLOBAL ?? CHAT_STEPS + 4) || CHAT_STEPS + 4);
// chat context window: a CHAR budget over recent history instead of a fixed
// message count — long chats and jumbo pastes don't silently fall out just
// because "16 messages" ran out. USER messages are pinned back into the
// convo even outside the budget (collectively, until CHAT_PIN_CHARS is
// exhausted, most recent first) — the quiz-stems case: the user's own words
// are always in context; fat regenerable assistant replies are what trims.
const CHAT_CTX_CHARS = Math.max(8_000, Number(process.env.CHAT_CTX_CHARS ?? 60_000) || 60_000);
const CHAT_PIN_CHARS = Math.max(0, Number(process.env.CHAT_PIN_CHARS ?? 60_000) || 60_000);

/** Graph tokens live next to the browser profile — cheap HTTP polling is only
 *  possible after the one-time device-code approval (POST /auth/graph). */
const graphTokenFile = join(dirname(config.userDataDir), "graph-tokens.json");
function hasGraphToken(): boolean {
  return existsSync(graphTokenFile);
}

// handled is DAY-SCOPED ("<event day>|<title>"): a title given up on Tuesday
// must not suppress Thursday's occurrence of the same recurring class (that
// made nextActionable skip straight to Friday and killed the whole day).
const handledKey = (title: string, startMs: number = Date.now()): string =>
  `${new Date(startMs).toDateString()}|${title}`;
const handled = new Set<string>();
/** per-title count of EARLY call drops this process — bounds the auto-rejoin
 *  loop (a permanently dead room can't ping-pong the bot until e.end) */
const rejoinCounts = new Map<string, number>();
let state = "idle"; // "idle" | "attending: <title>" | "error"
let lastScan: string | null = null;
let lastSeen = 0;
let waker: (() => void) | null = null;
/** set by POST /leave — the meeting watch loop breaks and the bot leaves */
let leaveRequested = false;
/** non-null while a manual (web UI) transcription job runs — "course/stem" */
let transcribeJob: string | null = null;
/** in-flight material transcription jobs — keyed `${slug}|${relVideoPath}`;
 *  prevents double-transcription when the UI re-posts (or polls) mid-job. */
const materialTranscribeJobs = new Map<string, Promise<void>>();

/** "[m:ss]" timestamp render — the recordings timeline convention
 *  (notes.ts / segment.ts fmt). */
export function transcriptTs(offsetSec: number): string {
  return `${Math.floor(offsetSec / 60)}:${String(Math.floor(offsetSec % 60)).padStart(2, "0")}`;
}

/** Render a material transcript to markdown: header + one "[m:ss] text"
 *  line per non-empty chunk. Exported so the convention is unit-testable. */
export function transcriptToMd(filename: string, chunks: { offsetSec: number; text: string }[]): string {
  const lines = chunks
    .map((c) => ({ s: c.offsetSec, t: c.text.trim() }))
    .filter((c) => c.t.length > 0)
    .map((c) => `[${transcriptTs(c.s)}] ${c.t}`);
  return `# Transcript — ${filename}\n\n${lines.join("\n")}`;
}
/** the active meeting's page, for graceful shutdown */
let active: { page: import("playwright").Page; title: string } | null = null;

/** true while the loop's schedule build is walking the shared calendar page —
 *  /join must not walk the SAME page concurrently (old code was serialized
 *  by the profile lock; the singleton needs an explicit flag) */
let buildBusy = false;
/** one "session expired" Discord ping per process (login MFA pushes still
 *  ping per attempt — that's the actionable ask) */
let authExpiredPinged = false;
/** consecutive schedule builds that scraped the calendar via the browser and
 *  got ZERO events with no Graph token — the cached-shell trap: the page
 *  renders Teams but the session is dead, so authAlive stays true and the
 *  expiry guard never fires. 3 in a row ⇒ force a recycle + fresh login. */
let emptyScrapes = 0;

/** Graceful shutdown on SIGTERM/SIGINT (docker stop / compose recreate):
 *  stop the recorder (remux + notes + consolidate) BEFORE dying, so a
 *  redeploy never orphans a session again. Docker gives us the grace period. */
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[daemon] ${sig} — graceful shutdown...`);
  if (active) {
    const { page, title } = active;
    active = null;
    try {
      const done = await stopRecording(page);
      if (done) await notify(`⏹️ Session closed by shutdown: **${title}** — ${done.segments.length} segment(s) consolidated`);
    } catch (e) {
      console.warn(`[daemon] graceful stop failed: ${String(e).slice(0, 150)} — segments left for orphan rescue`);
    }
  }
  await closeBrowser(); // release the persistent profile cleanly
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** Rescue sessions orphaned by a hard kill (SIGKILL/OOM/host restart):
 *  webm groups in segments/ untouched for >10 min get remuxed + consolidated
 *  (mp4 keeps them listenable in the UI; no Gemini spend by default). */
async function rescueOrphans(): Promise<void> {
  let files: string[];
  try { files = readdirSync(RECORD_DIR).filter((f) => f.endsWith(".webm") && !f.endsWith(".cued.webm")); } catch { return; }
  const groups = new Map<string, string[]>();
  for (const f of files) {
    // segment files: <titleSlug>__<seg-start-ISO>__<NNN>.webm — each 5-min
    // segment carries its OWN start timestamp, so group by title slug alone
    // (stripping only __NNN left one "session" per segment)
    const slug = f.replace(/__\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}__\d{3}\.webm$/, "");
    groups.set(slug, [...(groups.get(slug) ?? []), f]);
  }
  for (const [stem, parts] of groups) {
    // explicit order by segment index (__NNN), then map to full paths
    parts.sort((a, b) => Number(a.match(/__(\d{3})\.webm$/)?.[1] ?? 0) - Number(b.match(/__(\d{3})\.webm$/)?.[1] ?? 0));
    const paths = parts.map((p) => join(RECORD_DIR, p));
    const newest = Math.max(...paths.map((p) => statSync(p).mtimeMs));
    if (Date.now() - newest < 10 * 60_000) continue; // possibly still live
    // audio ogg is named with the SESSION-start timestamp: <slug>__<ISO>.audio.ogg
    const oggName = readdirSync(RECORD_DIR).find((f) => f.startsWith(`${stem}__`) && f.endsWith(".audio.ogg"));
    const ogg = oggName ? join(RECORD_DIR, oggName) : undefined;
    // real capture start: the ogg carries the session-start ISO (audio on);
    // fall back to seg 0's own start timestamp (video-only). Both are the
    // "<slug>__<ISO>" shape stemTimes() reads, so started_at/start_time land
    // in the sessions row as the capture instant — not the rescue time.
    const capStem = oggName?.replace(/\.audio\.ogg$/, "")
      ?? parts[0].split(/[\\/]/).pop()!.replace(/__\d{3}\.webm$/, "");
    // title slug lives before the "__<ISO timestamp>" suffix — keeps
    // rescued sessions filed under the same course folder as live ones
    const title = stem.replace(/__\d{4}-\d{2}-\d{2}.*$/, "").replace(/_/g, " ") || stem;
    // dedupe guard FIRST — before any updateSession: if the target course
    // already has a consolidated file from this date, the normal pipeline
    // handled it and rescue must not mint a "<stem>__<ts>" twin NOR leave a
    // session row behind. Drop the raw segments (they're inside the
    // consolidated file) and move on — they used to linger forever,
    // re-triggering rescue (and phantom session rows) on every boot.
    const dateTag = parts[0].match(/__(\d{4}-\d{2}-\d{2})T/)?.[1];
    if (dateTag) {
      const dest = join(RECORDINGS_DIR, parseCourse(title).slug);
      // readdir in try/catch: the course folder may legitimately not exist
      // yet (first recording / emptied course) — that means no dup, not a crash
      let dup: string | undefined;
      try { dup = readdirSync(dest).find((f) => f.startsWith(`${dateTag}__`) && /\.(webm|mp4)$/.test(f)); } catch { /* dir absent — nothing consolidated yet */ }
      if (dup) {
        console.log(`[daemon] orphan rescue: ${stem} already consolidated as ${dest}/${dup} — dropping ${parts.length} raw segment(s)`);
        for (const p of paths) { try { rmSync(p); } catch { /* gone */ } }
        if (ogg) { try { rmSync(ogg); } catch { /* gone */ } }
        continue;
      }
    }
    setActivity("rescuing orphaned session", { meeting: stem });
    console.log(`[daemon] orphan rescue: ${parts.length} segment(s) from ${stem}`);
    updateSession(capStem, { stage: "consolidating", stageNote: "orphan rescue", segCount: parts.length });
    for (const p of paths) await rebuildSeekPoints(p.split(/[\\/]/).pop()!);
    try {
      const r = await consolidateSession(title, paths, undefined, ogg && existsSync(ogg) ? ogg : undefined);
      pushEvent(r ? `orphan rescued ✓ ${r.mp4}` : `orphan rescue failed for ${stem} (segments kept)`);
      updateSession(capStem, r ? { stage: "done", mp4: r.mp4, sizeMB: Math.round(r.outBytes / 1e6) } : { stage: "failed", stageNote: "rescue failed — segments kept" });
    } catch (e) {
      console.warn(`[daemon] orphan rescue failed: ${String(e).slice(0, 120)}`);
      // mark it failed so the sessions row doesn't linger as "consolidating"
      // forever (the row exists — updateSession ran before the failure)
      try { await updateSession(capStem, { stage: "failed", stageNote: `rescue failed — ${String(e).slice(0, 60)}` }); } catch { /* best effort */ }
    }
  }
}

/** interruptible sleep — /scan wakes it immediately */
const nap = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    // NaN/undefined guard: a bad computation upstream must not become a 1ms hot loop
    const t = setTimeout(resolve, Number.isFinite(ms) && ms > 0 ? Math.min(ms, 24 * 3_600_000) : 60_000);
    waker = () => { clearTimeout(t); waker = null; resolve(); };
  }).then(() => { waker = null; });

/** ── Schedule-driven discovery ────────────────────────────────────────────
 *  Morning pull builds today's schedule; the daemon then SLEEPS until the
 *  next join window (start - JOIN_EARLY). At the window it re-pulls the
 *  calendar (catches changes), then joins. Manual /scan = wake + rebuild.
 *  Graph = live HTTP truth; no token = one browser scrape per rebuild
 *  (REBUILD_MINUTES, default 360 = morning + manual only). */
interface Sched { title: string; start: number; end: number; joinUrl?: string }

/** attendance journal — in-memory, hydrated from Postgres once at startup
 *  (attendedToday() is read synchronously in /status + the join loop). */
let journal: { date: string; title: string; joinedAt: number; leftAt?: number }[] = [];
async function hydrateAttendance(): Promise<void> {
  try { journal = await attendanceLoad(); } catch (e) { console.warn(`[daemon] attendance hydrate failed: ${String(e).slice(0, 120)}`); }
}
function journalEntry(title: string, patch: Partial<{ leftAt: number }>): void {
  const today = new Date().toDateString();
  let e = journal.find((x) => x.title === title && x.date === today && x.leftAt === undefined);
  if (!e) { e = { date: today, title, joinedAt: Date.now() }; journal.push(e); }
  Object.assign(e, patch);
  const row = { date: e.date, title: e.title, joinedAt: e.joinedAt, ...(e.leftAt !== undefined ? { leftAt: e.leftAt } : {}) };
  void attendanceUpsert(row).catch(() => { /* durable tail best-effort */ });
}
function attendedToday(): string[] {
  const today = new Date().toDateString();
  return journal.filter((e) => e.date === today).map((e) => e.title);
}

let schedule: Sched[] = [];
let scheduleBuiltAt = 0;
/** Rebuild policy: REBUILD_AT="HH:MM[,HH:MM]" (local wall-clock anchors, e.g.
 *  "07:00,19:00") wins; otherwise interval every REBUILD_MINUTES (default
 *  360) since the last build. Anchors use the pod's TZ (America/Toronto). */
function nextRebuildAt(): number {
  const anchors = (process.env.REBUILD_AT ?? "")
    .split(",").map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => { const [h, m] = s.split(":").map(Number); return { h: Math.min(h, 23), m: Math.min(m, 59) }; });
  const now = new Date();
  const today = (h: number, m: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
  for (const a of anchors.sort((x, y) => x.h * 60 + x.m - (y.h * 60 + y.m))) {
    const t = today(a.h, a.m);
    if (t > scheduleBuiltAt && t > Date.now() - 5 * 60_000) return t; // next anchor still ahead today
  }
  if (anchors.length) return today(anchors[0].h, anchors[0].m) + 24 * 3_600_000; // tomorrow's first anchor
  return scheduleBuiltAt + (Number(process.env.REBUILD_MINUTES ?? 720) || 720) * 60_000; // interval default: 12h
}
/** interval-mode gap in minutes, for the startup log line */
function nextRebuildGapMin(): number {
  return Number(process.env.REBUILD_MINUTES ?? 720) || 720;
}

/** Write calendar-events.txt so the frontend calendar works in Graph mode too. */
function writeCalendarDump(evs: Sched[]): void {
  try {
    mkdirSync(outPath(), { recursive: true });
    writeFileSync(outPath("calendar-events.txt"),
      evs.map((e) => `${new Date(e.start).toISOString()} | ${new Date(e.end).toISOString()} | 1 | ${Date.now() >= e.start && Date.now() < e.end ? 1 : 0} | ${e.title}`).join("\n") + "\n");
  } catch { /* best effort */ }
}

async function buildSchedule(): Promise<Sched[]> {
  const evs: Sched[] = [];
  if (hasGraphToken()) {
    try {
      for (const e of await listTodayMeetings(7)) { // week view — the UI groups by day
        if (!e.isOnline) continue;
        evs.push({ title: e.subject, start: new Date(e.start).getTime(), end: new Date(e.end).getTime(), joinUrl: e.joinUrl });
      }
      writeCalendarDump(evs);
      lastScan = new Date().toISOString();
      lastSeen = evs.length;
    } catch (e) {
      console.warn(`[daemon] Graph schedule pull failed: ${String(e).slice(0, 120)} — falling back to browser scrape`);
    }
  }
  if (!evs.length && !hasGraphToken()) {
    // shared persistent browser (singleton) — no login per rebuild
    const b = await getBrowser();
    if (b) {
      try {
        // Bearer interception stays (Graph token capture) — but the schedule
        // itself is DOM-scrape only now: the OWA/REST join-URL harvest was
        // removed (it never captured URLs and pinged every restart).
        const drainNetwork = startNetworkHarvest(b.page);
        const ms = await listMeetings(b.page);
        lastScan = new Date().toISOString();
        lastSeen = ms.length;
        emptyScrapes = ms.length ? 0 : emptyScrapes + 1; // cached-shell trap detector input
        for (const m of ms) evs.push({ title: m.title, start: m.start.getTime(), end: m.end.getTime(), ...(m.joinUrl ? { joinUrl: m.joinUrl } : {}) });
        // drain captured events into the graph-token store (join URLs are NOT
        // harvested — joinScheduled falls back to the calendar card click)
        await drainNetwork().catch(() => {});
      } catch (e) {
        if (/Target closed|Browser.*(closed|crashed)|context destroyed/i.test(String(e))) invalidateBrowser();
        console.warn(`[daemon] schedule scrape failed: ${String(e).slice(0, 120)}`);
      }
      // shared browser stays open — no close
    }
    // SILENT-DEATH GUARD: an empty scrape on a logged-OUT page means the
    // Teams session expired mid-pod-life. Recover NOW (fresh login, MFA
    // push waits up to 10 min) instead of discovering it at class time.
    // Never recycle while a meeting is live (active session shares the ctx).
    if (!evs.length && !hasGraphToken() && !active) {
      const b2 = await getBrowser();
      const shellDead = b2 && emptyScrapes >= 3; // cached-shell trap: alive probe passes but the calendar never loads
      if (b2 && (!(await authAlive(b2.page)) || shellDead)) {
        if (!authExpiredPinged) {
          authExpiredPinged = true;
          // screenshot of the dead page accompanies the ping; the Approve
          // sign-in page (with the number to enter) follows from the login
          // state machine ~a minute later, once the fresh login reaches MFA
          const expiredShot = await b2.page.screenshot({ type: "png" }).catch(() => undefined);
          void notify("🔑 **Teams session expired** — re-authenticating now. **Approve-sign-in screenshot + number follows in ~a minute — enter the number on your phone to approve.**", expiredShot).catch(() => {});
        }
        pushEvent(shellDead ? "cached Teams shell never loads (3 empty scrapes) — recycling for a fresh login" : "Teams session expired — recycling browser for fresh login");
        if (shellDead) emptyScrapes = 0; // escalation fired — give the fresh login a clean slate
        invalidateBrowser();
        const b3 = await getBrowser(); // fresh login — full auth state machine
        if (b3 && (await authAlive(b3.page).catch(() => true))) authExpiredPinged = false; // recovered — a future expiry pings again
        if (b3) {
          try {
            const ms = await listMeetings(b3.page);
            lastScan = new Date().toISOString();
            lastSeen = ms.length;
            for (const m of ms) evs.push({ title: m.title, start: m.start.getTime(), end: m.end.getTime(), ...(m.joinUrl ? { joinUrl: m.joinUrl } : {}) });
          } catch { /* empty is fine — retry cadence covers it */ }
        }
      }
    }
  }
  schedule = evs.sort((a, b) => a.start - b.start);
  scheduleBuiltAt = Date.now();
  return schedule;
}

/** next event whose join window (start - JOIN_EARLY) has arrived and isn't done.
 *  NO attendedToday check: a mid-class call drop must REJOIN until e.end
 *  (the 15-min-leave failure mode) — only an explicit /leave or the bounded
 *  give-up/rejoin guards add a day-scoped handled key. */
function nextActionable(): Sched | null {
  const now = Date.now();
  return schedule.find((e) =>
    now >= e.start - joinEarlyMs() && now < e.end && !handled.has(handledKey(e.title, e.start))
  ) ?? null;
}

/** Record + watch + stop for an already-joined meeting (both join paths).
 *  hardEndMs: scheduled end — the watch loop also exits at end+15min (safety
 *  cap for a meeting whose UI never dies), but never sooner than 10min in
 *  (a manual join right at/after the listed end still gets a real session). */
async function attendAndRecord(page: import("playwright").Page, title: string, joinUrl?: string, endMs?: number): Promise<void> {
  const sessionStart = Date.now();
  let cappedFlag = false;
  let leaveWasRequested = false;
  active = { page, title };
  journalEntry(title, {}); // persistent attendance — survives restarts
  setActivity("in meeting — starting recorder", { meeting: title });
  pushEvent(`joined: ${title}`);

  let rec: Awaited<ReturnType<typeof startRecording>> | null = null;
  try {
    rec = await startRecording(page, title, joinUrl);
  } catch (e) {
    console.error(`[rec] ! ${e}`);
    // same evidence pattern as the join ping — screenshot shows the meeting state
    const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
    const shotFile = `fail-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`;
    if (shot) { try { writeFileSync(outPath(shotFile), shot); } catch { /* read-only */ } }
    pushEvent(`recording failed to start: ${String(e).slice(0, 90)} — 📸 out/${shotFile}`);
    await notify(`⚠️ Recording failed to start for **${title}**: \`${String(e).slice(0, 120)}\``, shot);
  }

  if (rec) {
    setActivity("recording", { meeting: title });
    // safety cap: leave-marker death (60s) is the normal class-end signal;
    // the cap only fires when the meeting UI refuses to die (runaway guard)
    const hardEnd = endMs
      ? Math.max(endMs + 15 * 60_000, Date.now() + 10 * 60_000)
      : Date.now() + 8 * 3_600_000;
    // call-end watch: leave-marker gone for >60s → meeting over (or /leave)
    let misses = 0;
    while (misses < 30 && !leaveRequested && Date.now() < hardEnd) {
      await new Promise((res) => setTimeout(res, 2_000));
      if (await stillInMeeting(page)) misses = 0;
      else misses++;
    }
    const capped = !leaveRequested && Date.now() >= hardEnd; // hit the runaway cap
    cappedFlag = capped;
    const leftRequested = leaveRequested; // capture why this session ended (manual vs natural)
    leaveWasRequested = leftRequested;
    if (leaveRequested) {
      pushEvent(`leave requested — wrapping up ${title}`);
      console.log("[daemon] leave requested via UI");
      recordLeftToday(title); // persist: no auto re-join for the rest of today
      handled.add(handledKey(title));
      leaveRequested = false;
      // immediate webhook — consolidation/transcription continue in background
      void notify(`🚪 Left **${title}** (manual leave) — consolidating & transcribing in background`).catch(() => {});
    }
    try {
      // quick stop (~2s): stops MediaRecorder + flushes audio, then LEAVE immediately
      const handle = await quickStopRecording(page);
      if (handle) {
        // leave the meeting NOW — close the tab, unless the call ended up on
        // the SHARED calendar tab (card-click join fallback): closing that
        // kills the singleton home page and every later join dies with
        // "Target page, context or browser has been closed". Navigate it
        // back to the Teams home instead.
        await leaveMeetingPage(page);
        console.log(`[daemon] left ${title}`);
        // heavy post-processing runs in the background (no page needed)
        const { result: done, postProcess } = handle;
        void postProcess().then(() => {
          // a background completion must never clobber a NEWER live session's
          // activity (back-to-back classes: this fires while the next class is
          // already recording) — only speak up when idle or still on this one
          if (!active || active.title === title) setActivity("idle — post-processing complete", { meeting: title });
          console.log(`[daemon] recording done: ${done.segments.length} segment(s), ${(done.bytes / 1e6).toFixed(0)} MB, ${Math.round(done.ms / 60000)} min`);
          notify(`⏹️ Recording ended: **${title}** — ${done.segments.length} segment(s), ${Math.round(done.ms / 60000)} min (${leftRequested ? "manual leave" : capped ? "runaway cap — meeting outlived its slot by 15+ min" : "meeting ended"})`).catch(() => {});
        }).catch((e) => {
          console.error(`[rec] post-process failed: ${e}`);
          notify(`⚠️ Post-processing failed for **${title}**: \`${String(e).slice(0, 120)}\``).catch(() => {});
        });
      }
    } catch (e) {
      console.error(`[rec] stop failed: ${e}`);
      await notify("⚠️ Recorder stop failed — last segment may need repair (`ffmpeg -err_detect ignore_err -i <file> -c copy fixed.webm`)");
    }
  }
  // Leave hit before/without recording (flag not consumed by the watch loop)
  if (leaveRequested) {
    recordLeftToday(title);
    handled.add(handledKey(title));
    leaveRequested = false;
  }
  // Did the call die EARLY (leave-marker gone long before the scheduled
  // end — Teams reconnect glitch, professor re-hosting the call)? Then this
  // is NOT terminal: the autopilot must rejoin until e.end. Only an explicit
  // /leave, a natural end (window over) or an exhausted rejoin budget parks
  // the title for the rest of the day.
  const earlyExit = !leaveWasRequested && !cappedFlag && endMs !== undefined && Date.now() < endMs - 2 * 60_000;
  if (earlyExit) {
    const n = (rejoinCounts.get(title) ?? 0) + 1;
    rejoinCounts.set(title, n);
    if (n >= 5) {
      handled.add(handledKey(title));
      pushEvent(`meeting dropped early ${n}× — giving up on "${title}" until the next window`);
      void notify(`⚠️ **${title}** keeps dropping early — gave up rejoining (manual Join is available)`).catch(() => {});
    } else {
      pushEvent(`meeting dropped early after ${Math.round((Date.now() - sessionStart) / 60_000)} min — autopilot will rejoin (${n}/5)`);
    }
  } else {
    handled.add(handledKey(title)); // session ran its window (or /leave) — done for the day
    rejoinCounts.delete(title); // a full session resets the drop counter
  }
  journalEntry(title, { leftAt: Date.now() });
  active = null;
  // persistent browser: this flow OWNS the meeting page — always close it
  // (covers recording-never-started and stop-failed paths; the success path
  // already closed it and the double-close is swallowed) — but NEVER the
  // shared home page (see leaveMeetingPage)
  await leaveMeetingPage(page);
}

/** Close a meeting tab — or, if the call ended up living on the shared
 *  singleton calendar page, navigate that back to the Teams home instead of
 *  closing it (a closed singleton page poisons every future join). */
async function leaveMeetingPage(page: import("playwright").Page): Promise<void> {
  if (isSharedPage(page)) {
    await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    return;
  }
  await page.close().catch(() => {});
}

/* ── streaming chat loop (shared by both chat endpoints) ─────────────
 * SSE event protocol: {type:"status"} while tools run, {type:"delta"} for
 * answer tokens, {type:"reset"} when a round turned out to be tool-preface
 * text the client must discard, {type:"done"|"error"} to finish. Returns
 * the final reply (null on error) so the caller can persist it. */
function toolPhrase(tc: ToolCall): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(tc.function.arguments || "{}"); } catch { /* bad json */ }
  const arg = typeof a.path === "string" ? a.path
    : typeof a.query === "string" ? `"${a.query}"`
    : typeof a.date === "string" ? a.date
    : typeof a.course === "string" ? a.course
    : typeof a.url === "string" ? a.url.slice(0, 60)
    : "";
  return `${tc.function.name.replace(/_/g, " ")}${arg ? ` · ${arg}` : ""}`;
}

/** Context-window plan for one chat turn: which history messages the model
 *  sees. USER MESSAGES ARE NEVER EVICTED (they're the irreplaceable source
 *  of truth — question stems, pastes — and they're small; collectively capped
 *  by CHAT_PIN_CHARS, most recent first). The char budget governs ASSISTANT
 *  replies instead: they're regenerable summaries, and fat ones (answer
 *  cards, repeated final-answers) are what should trim when a chat grows.
 *  The live window walks backward within CHAT_CTX_CHARS (newest message
 *  always kept), opens on a user turn, then all evicted user messages are
 *  pinned back in at their chronological position. */
interface ChatWindow {
  msgs: { role: "user" | "assistant"; content: string }[];
  keptFrom: number; // first index of the live window (history indices)
  pinned: number[]; // user-message indices re-included above the window, chronological
  dropped: number; // ASSISTANT messages the model cannot see
}
function buildChatWindow(history: readonly { role: string; content: string }[]): ChatWindow {
  const n = history.length;
  if (n === 0) return { msgs: [], keptFrom: 0, pinned: [], dropped: 0 };
  let used = 0;
  let start = n;
  for (let i = n - 1; i >= 0; i--) {
    const len = history[i]!.content.length;
    if (i < n - 1 && used + len > CHAT_CTX_CHARS) break; // newest msg is exempt from the cap
    used += len;
    start = i;
  }
  while (start < n && history[start]!.role === "assistant") start++; // pair alignment
  // pin EVERY evicted user message (jumbo pastes and small incremental stems
  // alike), most recent first, until the pin budget is exhausted
  const pinned: number[] = [];
  let pinUsed = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (history[i]!.role !== "user") continue;
    const len = history[i]!.content.length;
    if (pinUsed + len > CHAT_PIN_CHARS) continue;
    pinned.push(i);
    pinUsed += len;
  }
  pinned.reverse();
  const pinnedSet = new Set(pinned);
  const msgs = history
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => i >= start || pinnedSet.has(i))
    .map(({ m }) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const droppedAssist = history.reduce((acc, m, i) => acc + (i < start && m.role === "assistant" && !pinnedSet.has(i) ? 1 : 0), 0);
  return { msgs, keptFrom: start, pinned, dropped: droppedAssist };
}

/** Honesty note appended to the system prompt when the window cuts history:
 *  the model must say it can't see something rather than guess at it. */
function contextNote(win: ChatWindow): string {
  if (win.dropped <= 0) return "";
  const pin = win.pinned.length ? " ALL of the user's own messages (questions, pastes) are included at their original positions" : "";
  return `\nCONTEXT WINDOW: ${win.dropped} earlier assistant answer(s) are omitted from this conversation for context budget —${pin}. Your read_conversation tool can show ANY of them verbatim (including every user message). If the user references something you cannot see, read it or say so — never guess its contents.`;
}

/** Discovery shortcut for follow-up questions: harvest [[path]] citations
 *  from recent assistant replies and hand them back in the system prompt —
 *  similar questions skip list/search rounds and read_document the known
 *  files directly (page text from the on-disk .index bundle; embeddings are
 *  never involved — they only power discovery, which this replaces). */
function citationReuseLine(history: { role: string; content: string }[]): string {
  const paths = new Set<string>();
  for (const m of history.slice(-16)) {
    if (m.role !== "assistant") continue;
    for (const c of m.content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const p = c[1]!.trim();
      if (p && !/^https?:/i.test(p)) paths.add(p); // web URLs aren't material paths
      if (paths.size >= 10) break;
    }
  }
  return paths.size
    ? `\nMATERIALS ALREADY CITED in this conversation — for anything about these, skip discovery (list_materials / search) and read_document the exact path directly, or lean on your earlier answer: ${[...paths].map((p) => `[[${p}]]`).join(", ")}.`
    : "";
}

async function streamChatLoop(
  res: ServerResponse,
  convo: ChatMsg[],
  opts: { tools: unknown[]; webSearch: boolean; fallbackSlug?: string; maxSteps: number; toolLabel: string; ctx?: (reply: string) => Record<string, unknown> },
): Promise<string | null> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Traefik/nginx: don't buffer the stream
  });
  const event = (o: Record<string, unknown>): void => {
    try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* client gone — finish anyway so history is kept */ }
  };
  // CANCEL: the client aborting the fetch closes the socket — kill the
  // in-flight GLM call too (no wasted quota) and keep whatever streamed
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const stopped = (): boolean => res.destroyed;
  // keepalive: SSE comment every 20s so silent stretches (slow tools, model
  // thinking before its first content token) never trip proxy idle timeouts —
  // undici's 300s bodyTimeout killed 5-minute chats as "request failed".
  // ": ping" lines are ignored by SSE parsers (client only reads data: lines).
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* client gone */ } }, 20_000);
  let reply = "";
  let partial = ""; // text streamed by the round in progress
  let webReads = 0;
  let nudges = 0; // continuation nudges for narrate-without-calling rounds
  try {
    const half = Math.floor(opts.maxSteps / 2);
    for (let step = 0; step < opts.maxSteps; step++) {
      if (stopped()) break; // cancelled — stop burning model calls
      const final = step === opts.maxSteps - 1;
      if (step === half)
        convo.push({ role: "user", content: "Tool budget is half used. If you already have the key facts, answer now — at most two more tool rounds for critical gaps. Your answer must be COMPLETE and self-contained: anything you streamed in earlier rounds was discarded and the student never saw it." });
      if (final)
        convo.push({ role: "user", content: "FINAL ROUND — tool budget is exhausted. Answer now with what you already have; say what you could not verify. Your answer must be COMPLETE and self-contained: anything you streamed in earlier rounds was discarded and the student never saw it." });
      partial = "";
      const msg = await glmChatStream(convo, final ? undefined : opts.tools, (t) => { partial += t; event({ type: "delta", text: t }); }, ac.signal);
      if (msg.tool_calls?.length) {
        // that round's streamed text was tool-preface — client discards it
        event({ type: "reset" });
        // tools run in PARALLEL — a read-heavy round waits on its slowest
        // call, not the sum of all of them
        const results = await Promise.all(msg.tool_calls.map(async (tc) => {
          if ((tc.function.name === "web_search" || tc.function.name === "web_read") && !opts.webSearch)
            return "web tools are disabled for this chat";
          if (tc.function.name === "web_read" && ++webReads > 4)
            return "web_read limit reached (4) — answer with what you have";
          event({ type: "status", text: toolPhrase(tc) });
          const r = await runTool(tc, opts.fallbackSlug);
          pushEvent(`${opts.toolLabel}: ${tc.function.name} → ${String(r).slice(0, 80).replace(/\s+/g, " ")}…`);
          return String(r).slice(0, 26_000);
        }));
        if (stopped()) break; // cancelled mid-tools — don't start another round
        convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
        msg.tool_calls.forEach((tc, i) => convo.push({ role: "tool", tool_call_id: tc.id, content: results[i]! }));
        continue;
      }
      // text-only round — GLM sometimes narrates its next step ("let me check
      // X…") without emitting a tool call; accepting that as the answer
      // truncates the investigation. Push it back once or twice while
      // budget remains, then accept whatever comes. LENGTH HEURISTIC: a short
      // no-tool reply is narration, but a LONG one is a complete deliverable
      // ("write me a playbook" with no lookup needed) — resetting that wiped
      // whole answers the user watched stream, while the model still saw them
      // in convo and kept claiming it had already delivered them.
      if (step < half && nudges < 2 && msg.content.trim().length < 600) {
        nudges++;
        event({ type: "reset" }); // client discards the narration text
        convo.push({ role: "assistant", content: msg.content || "(no reply)" });
        convo.push({ role: "user", content: `That text was NOT shown to the student. You still have ${opts.maxSteps - step - 1} tool rounds. If you need more information, call the tools NOW in this round. Otherwise reply with your COMPLETE final answer — the student sees only that reply.` });
        continue;
      }
      reply = msg.content;
      break;
    }
  } catch (e) {
    if (stopped() || (e instanceof Error && e.name === "AbortError")) {
      // user cancelled: persist exactly the partial answer they saw
      clearInterval(beat);
      try { res.end(); } catch { /* already closed */ }
      return partial.trim() || null;
    }
    event({ type: "error", error: `chat failed: ${String(e).slice(0, 150)}` });
    clearInterval(beat);
    res.end();
    return null;
  }
  if (!reply) reply = partial.trim() || "(no answer — model hit the tool-step limit; try a more specific question)";
  clearInterval(beat);
  if (opts.ctx) { try { event({ type: "ctx", ...opts.ctx(reply) }); } catch { /* best-effort divider info */ } }
  event({ type: "done", reply });
  res.end();
  return reply;
}

/** Background index warm-up: pre-build .index bundles for every supported
 *  material of every course, so the first chat read of a doc never pays
 *  pdftotext/pdftoppm. Sequential (the renderer is CPU-heavy); fresh bundles
 *  are a cheap .src-marker check. Reschedules itself while a class is being
 *  recorded — a browser launch mid-capture is the one real risk. */
async function sweepIndexes(): Promise<void> {
  if (listSessions().some((s) => s.stage === "recording")) {
    setTimeout(() => void sweepIndexes(), 30 * 60_000).unref?.();
    return;
  }
  let built = 0;
  for (const c of allCourses()) {
    for (const m of await listMaterials(c)) {
      if (!supportsIndex(m.path)) continue;
      if (listSessions().some((s) => s.stage === "recording")) break; // recheck per file
      try {
        const pages = await ensureIndex(c, m.path);
        if (pages > 0) { built++; pushEvent(`eager-indexed ${c}/${m.path} (${pages} pages)`); }
      } catch { /* keep sweeping */ }
    }
  }
  if (built > 0) pushEvent(`index sweep done — ${built} bundle(s) built`);
}

// ── Phase 4: user-data (deadlines / folds / checklists) in Postgres ────────
// Request-scoped owner lives in db/owner.ts (ownerALS + curOwner) so db/
// and pipeline/ modules can share it without importing the daemon.

// The /deadlines and /checklists routes keep their exact mutation semantics
// (id hashing, dedupe, fold/unfold, carry-over); the read/write primitives and
// the trivial-mutation entrypoints live in db/deadlines.ts so the platform
// frontend routes + the ingestion API share ONE implementation. `q` stays here
// for the handler-local SQL below.
const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

function startController(): void {
  // manually-left meetings (today) are seeded into `handled` so a restart
  // doesn't auto-join them again — manual Join via /join still overrides
  for (const t of loadLeftToday()) handled.add(handledKey(t));
  const server = createServer((req, res) => {
    void (async () => {
      const owner = await resolveRequestOwner(req);
      if (!owner) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unknown X-Auto-School-User" }));
        return;
      }
      ownerALS.run(owner, () => { void handleRequest(req, res); });
    })();
  });

  /** Phase-1 owner resolution (federation plan §8):
   *  X-Auto-School-User <authentik-uid> → users.id via authentik_sub;
   *  absent header → system OWNER (daemon-internal jobs / unauthenticated pod-local calls);
   *  present-but-unresolvable uid → null (→ 401) — never silently fall back to OWNER,
   *    that would leak the seed user's data to a misprovisioned identity.
   *  x-owner-uuid SMOKE_OWNER_UUID exact-match override stays (scripts/smoke.ts). */
  async function resolveRequestOwner(req: IncomingMessage): Promise<string | null> {
    const sub = String(req.headers["x-auto-school-user"] ?? "").trim();
    if (sub) {
      const id = await getUserIdBySub(sub).catch(() => null);
      if (id) return id;
      return null; // 401 — never fall back to OWNER (data leak)
    }
    const h = String(req.headers["x-owner-uuid"] ?? "");
    return h && h === process.env.SMOKE_OWNER_UUID ? h : OWNER;
  }

  /** The full controller body (was the createServer callback). Runs inside
   *  ownerALS so curOwner() resolves the request's owner everywhere below. */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/healthz") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/status") {
      return send(200, {
          state, lastScan, seen: lastSeen, handled: [...handled],
          joinPaused: getSettings().joinPaused,
          graph: hasGraphToken(),
          graphCode: lastDeviceCode && Date.now() - lastDeviceCode.at < 15 * 60_000 ? lastDeviceCode : null,
          attended: attendedToday(),
          degraded: [
            ...(!getSettings().transcribe ? ["transcription OFF (quota guard) — toggle in Settings"] : []),
            ...getModelQuotas().filter((q) => q.exhausted && q.exhaustedUntil && q.exhaustedUntil > Date.now())
              .map((q) => `${q.model} cooling until ${new Date(q.exhaustedUntil!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })} (${q.exhaustedReason})`),
          ],
          schedule: schedule.map((e) => ({ title: e.title, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() })),
          ...snapshot(),
        });
    }
    if (req.method === "POST" && url.pathname === "/scan") {
      if (url.searchParams.get("reset") === "1") {
        handled.clear();
        clearLeftToday();
        console.log("[daemon] handled set cleared (reset=1)");
      }
      waker?.(); // wake the poll loop now (no-op if currently attending)
      return send(200, { ok: true, state, note: state.startsWith("attending") ? "busy — scan queued" : "scanning now" });
    }
    if (req.method === "POST" && url.pathname === "/pause") {
      const body = await new Promise<Record<string, unknown>>((res) => {
        let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
      });
      const paused = typeof body.paused === "boolean" ? body.paused : !getSettings().joinPaused; // bare POST toggles
      applySettingsPatch({ joinPaused: paused });
      waker?.(); // wake loop so the new state takes effect immediately
      return send(200, { ok: true, joinPaused: paused, note: paused ? "auto-join PAUSED — daemon will not enter meetings" : "auto-join resumed" });
    }
    if (req.method === "POST" && url.pathname === "/auth/graph") {
      if (hasGraphToken()) return send(200, { ok: true, note: "token already present" });
      // fire-and-forget: device code is pinged to Discord; approval may take minutes
      void getAccessToken()
        .then(() => { pushEvent("Graph approved ✓ — cheap polling active"); console.log("[daemon] Graph token approved"); })
        .catch((e) => pushEvent(`Graph approval failed: ${String(e).slice(0, 100)}`));
      return send(202, { ok: true, note: "device code sent to Discord — approve to enable cheap polling" });
    }
    if (req.method === "POST" && url.pathname === "/session/move") {
      // refile a session to a different course: mp4/webm + notes + timeline + transcript
      (async () => {
        try {
          const body = await new Promise<Record<string, unknown>>((res) => {
            let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
          });
          const from = String(body.from ?? "");
          const to = String(body.to ?? "");
          const stem = String(body.stem ?? "");
          if (!from || !to || !stem) return send(400, { error: "from, to, stem required" });
          if (from === to) return send(400, { error: "session is already in that course" });
          if (!allCourses().includes(to)) return send(404, { error: `unknown course: ${to}` });
          const safe = (s: string) => s.replace(/[^A-Za-z0-9 _.-]/g, "");
          const base = safe(stem).replace(/(__T?\d{6}|\.stale-\d{6})$/, "");
          const esc = safe(stem).replace(/[.\^$*+?()[\]{}|]/g, "\\$&");
          const mine = new RegExp(`^${esc}(__T?\d{6}|\.stale-\d{6})?\.(mp4|webm)$`);
          let moved = 0;
          // recordings
          const fromR = join(RECORDINGS_DIR, safe(from));
          const toR = join(RECORDINGS_DIR, safe(to));
          mkdirSync(toR, { recursive: true });
          // from-dir may be absent (rescued/transcript-only session, emptied
          // course) — skip the recordings pass instead of failing the move
          try {
            for (const f of readdirSync(fromR)) {
              if (mine.test(f)) { renameSync(join(fromR, f), join(toR, f)); moved++; }
            }
          } catch { /* from-dir absent — nothing to move on disk */ }
          // notes (keyed by day stem — move the whole day set if no sibling recording stays)
          const fromN = join(NOTES_DIR, safe(from));
          const toN = join(NOTES_DIR, safe(to));
          let sameDayLeft = false;
          try {
            sameDayLeft = readdirSync(fromR).some((f) => (f.endsWith(".mp4") || f.endsWith(".webm")) && f.replace(/\.(mp4|webm)$/, "").replace(/(__T?\d{6}|\.stale-\d{6})$/, "") === base);
          } catch { /* dir gone */ }
          if (!sameDayLeft) {
            mkdirSync(toN, { recursive: true });
            try {
              for (const f of readdirSync(fromN)) {
                if (["__notes.md", "__running.md", "__timeline.json", "__transcript.md", "__title.txt"].some((s) => f === `${base}${s}`)) { renameSync(join(fromN, f), join(toN, f)); moved++; }
              }
            } catch { /* dir absent */ }
          }
          try { rebuildIndex(); } catch { /* index optional */ }
          // DB: reassign the session + its artifacts/docs to the target course
          try {
            const cid = await courseId(safe(to));
            const r = await getPool().query(
              `update sessions set course_id=$1 where course_id=(select id from courses where slug=$2) and stem=$3 and owner_user_id=$4`,
              [cid, safe(from), base, curOwner()]);
            if (r.rowCount) {
              await getPool().query(
                `update session_artifacts set rel_path = replace(rel_path, 'notes/'||$1||'/', 'notes/'||$2||'/')
                 where session_id in (select id from sessions where course_id=$3 and stem=$4 and owner_user_id=$5)`,
                [safe(from), safe(to), cid, base, curOwner()]);
              await getPool().query(
                `update session_artifacts set rel_path = replace(rel_path, 'recordings/'||$1||'/', 'recordings/'||$2||'/')
                 where session_id in (select id from sessions where course_id=$3 and stem=$4 and owner_user_id=$5)`,
                [safe(from), safe(to), cid, base, curOwner()]);
              await getPool().query(
                `update documents set course_id=$1, rel_path = replace(rel_path, 'notes/'||$2||'/', 'notes/'||$3||'/')
                 where session_id in (select id from sessions where course_id=$1 and stem=$4 and owner_user_id=$5)`,
                [cid, safe(from), safe(to), base, curOwner()]);
            }
          } catch (e) { console.error(`[daemon] DB session move failed: ${String(e)}`); }
          pushEvent(`moved ${moved} file(s): ${stem} ${from} → ${to}`);
          console.log(`[daemon] session moved: ${stem} ${from} → ${to} (${moved} files)`);
          return send(200, { ok: true, moved });
        } catch (e) { return send(500, { error: `move failed: ${String(e).slice(0, 120)}` }); }
      })();
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/session") {
      // purge a session everywhere: mp4(s) + notes + running + timeline + index
      const course = url.searchParams.get("course")?.replace(/[^\w -]/g, "");
      const stem = url.searchParams.get("stem")?.replace(/[^\w .-]/g, ""); // dot: .stale-HHMMSS twins
      if (!course || !stem) return send(400, { error: "course and stem required" });
      let removed = 0;
      const rm = (f: string) => { try { rmSync(f); removed++; } catch { /* gone */ } };
      // A session's mp4 is EXACTLY `${stem}.mp4` (or its own __THHMMSS variant).
      // Same-day recordings share the stem prefix (`<date>__<course>__HHMMSS`),
      // so prefix matching here would wipe every other recording of that day.
      const rdir = join(RECORDINGS_DIR, course);
      const esc = stem.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&"); // stem may contain dots (.stale)
      const mine = new RegExp(`^${esc}(__T?\\d{6}|\\.stale-\\d{6})?\\.(mp4|webm)$`);
      try {
        for (const f of readdirSync(rdir)) {
          if (mine.test(f)) rm(join(rdir, f));
        }
      } catch { /* dir absent */ }
      // notes/timeline/transcript are keyed by the DAY stem — remove them only
      // when no other recording of the same day+course remains
      const base = stem.replace(/(__T?\d{6}|\.stale-\d{6})$/, "");
      let sameDayLeft = false;
      try {
        sameDayLeft = readdirSync(rdir).some((f) => (f.endsWith(".mp4") || f.endsWith(".webm")) && f.replace(/\.(mp4|webm)$/, "").replace(/(__T?\d{6}|\.stale-\d{6})$/, "") === base);
      } catch { /* dir gone */ }
      if (!sameDayLeft) {
        const ndir = join(NOTES_DIR, course);
        try {
          for (const f of readdirSync(ndir)) {
            if (["__notes.md", "__running.md", "__timeline.json", "__transcript.md", "__title.txt"].some((s) => f === `${base}${s}`)) rm(join(ndir, f));
          }
        } catch { /* dir absent */ }
      }
      try { rebuildIndex(); } catch { /* index optional */ }
      // DB: purge the session row (cascade removes artifacts + segments + session docs)
      // — gated on the same sibling-recording condition as the fs notes purge
      try {
        if (!sameDayLeft) await getPool().query(
          `delete from sessions where course_id=(select id from courses where slug=$1) and stem=$2 and owner_user_id=$3`,
          [course, base, curOwner()]);
      } catch (e) { console.error(`[daemon] DB session purge failed: ${String(e)}`); }
      pushEvent(`purged ${removed} file(s) — ${course}/${stem}`);
      console.log(`[daemon] purged ${removed} file(s) for ${course}/${stem}`);
      return send(200, { ok: true, removed });
    }
    if (req.method === "DELETE" && url.pathname === "/segments") {
      // TEST/OPS: wipe every raw segment + audio ogg (mp4s in recordings/ stay)
      let removed = 0;
      try {
        for (const f of readdirSync(RECORD_DIR)) {
          try { rmSync(join(RECORD_DIR, f)); removed++; } catch { /* busy file */ }
        }
      } catch { /* dir absent */ }
      pushEvent(`TEST: purged ${removed} raw file(s) from segments/`);
      console.log(`[daemon] segments purged: ${removed} file(s)`);
      return send(200, { ok: true, removed });
    }
    if (req.method === "POST" && url.pathname === "/join") {
      // manual join by title (UI "Join" button) — bypasses joinableNow/handled
      if (state.startsWith("attending")) return send(409, { ok: false, note: `busy attending: ${state}` });
      if (buildBusy) return send(409, { ok: false, note: "busy building schedule — retry in ~a minute" });
      let body: Record<string, unknown> = {};
      try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
      const want = String(body.title ?? "").toLowerCase().trim();
      if (!want) return send(400, { error: "title required" });
      // NOTE: no handled.delete — manual join is a one-shot; suppression from
      // an earlier give-up/user-leave stays so the loop can't re-arm the title
      void (async () => {
        try {
          state = "attending (manual join)";
          setActivity("joining meeting (manual)", { meeting: String(body.title) });
          const b = await getBrowser();
          if (!b) throw new Error("browser unavailable");
          try {
            const meetings = await listMeetings(b.page);
            lastScan = new Date().toISOString();
            lastSeen = meetings.length;
            const m = meetings.find((x) => x.title.toLowerCase().includes(want));
            if (!m) throw new Error(`"${body.title}" not on the calendar`);
            const page = m.joinUrl
              ? await joinMeetingByUrl(b.ctx, m.title, m.joinUrl)
              : await joinMeeting(b.ctx, m);
            if (!page) throw new Error("join flow failed (not started yet?)");
            await attendAndRecord(page, m.title, m.joinUrl, m.end.getTime());
          } finally {
            state = "idle";
            // shared browser stays open — only this flow's pages are done
          }
        } catch (e) {
          state = "idle";
          leaveRequested = false; // void any leave pressed mid-join — no session to leave
          pushEvent(`manual join failed: ${String(e).slice(0, 120)}`);
          console.warn(`[daemon] manual join failed: ${String(e).slice(0, 200)}`);
          // browser-level failure (page/context closed under us) → recycle so
          // the user's NEXT Join click relaunches instead of dying forever
          if (/Target closed|Browser.*(closed|crashed)|context destroyed|Target page, context or browser has been closed/i.test(String(e))) {
            pushEvent("browser context was closed — recycling; retry Join (fresh login if the session expired)");
            invalidateBrowser();
            return;
          }
          // if the session died, recycle so the user's NEXT Join click logs in fresh
          const bb = await getBrowser().catch(() => null);
          if (bb && !active && !(await authAlive(bb.page).catch(() => true))) {
            pushEvent("session expired — browser recycled; retry Join to re-login");
            invalidateBrowser();
          }
        }
      })();
      return send(202, { ok: true, note: `joining "${body.title}" — watch status` });
    }
    if (req.method === "POST" && url.pathname === "/leave") {
      if (!active && !state.startsWith("attending")) return send(200, { ok: true, note: "not in a meeting" });
      leaveRequested = true; // consumed by the watch loop within ~2s; consolidation + transcription continue
      return send(200, { ok: true, note: "leaving now — webhook will confirm; consolidating & transcribing in background" });
    }
    if (req.method === "POST" && url.pathname === "/transcribe") {
      const course = url.searchParams.get("course")?.replace(/[^\w -]/g, "");
      const stem = url.searchParams.get("stem")?.replace(/[^\w .-]/g, ""); // dot: .stale-HHMMSS twins
      if (!course || !stem) return send(400, { error: "course and stem required" });
      if (transcribeJob) return send(409, { error: `already transcribing ${transcribeJob}` });
      let mp4: string | null = null;
      try {
        const dir = join(RECORDINGS_DIR, course);
        for (const f of readdirSync(dir)) {
          if (f === `${stem}.mp4` || f === `${stem}.webm` || (f.startsWith(`${stem}__T`) && (f.endsWith(".mp4") || f.endsWith(".webm")))) { mp4 = join(dir, f); break; }
        }
      } catch { /* no course dir */ }
      if (!mp4) return send(404, { error: "no recording (mp4) for this session — consolidate first" });
      transcribeJob = `${course}/${stem}`;
      pushEvent(`transcribe: manual job started — ${course}/${stem}`);
      void (async () => {
        try {
          const t = await transcribeFile(mp4);
          const realFile = mp4.split(/[\\/]/).pop()!;
          const realStem = realFile.replace(/\.(mp4|webm)$/, "");
          let title = realStem.replace(/^\d{4}-\d{2}-\d{2}__/, "").replace(/__T?\d{6}$/, "").replace(/_/g, " ");
          // file under the course the USER clicked — never re-parse the title
          // (a filename-derived title files under a bogus slug like
          // testing_autoschool_180137)
          const ci = { code: "MAP", slug: course, name: course.replace(/_/g, " ") };
          const dir = courseDir(ci);
          const paths = { course: ci, dir, stem: realStem,
            notesMd: join(dir, `${realStem}__notes.md`),
            runningMd: join(dir, `${realStem}__running.md`),
            timelineJson: join(dir, `${realStem}__timeline.json`) };
          const cid = await courseId(course);
          const sid = await sessionId(cid, realStem, {
            sessionDate: realStem.slice(0, 10),
            ...stemTimes(realStem), // __THHMMSS suffix → time-of-day (mtime semantics)
          });
          await upsertArtifact(sid, "transcript", `notes/${course}/${realStem}__transcript.md`, { content: `# Transcript — ${title}\n\n${t.text}` });
          pushEvent(`transcribe ✓ ${course}/${stem} — ${t.chunks.length} chunk(s) → transcript.md`);
          // notes live in PG now (session_artifacts kind='notes') — the fs
          // probe never fires since the pipeline stopped writing notesMd; ask
          // PG instead and skip finalizeNotes when notes already exist
          let hasNotes = false;
          try {
            hasNotes = (await q(
              `select 1 from session_artifacts sa
               join sessions s on s.id = sa.session_id
               join courses c on c.id = s.course_id
               where c.slug = $1 and s.stem = $2 and s.owner_user_id = $3 and sa.kind = 'notes' limit 1`,
              [course, realStem, curOwner()])).rows.length > 0;
          } catch { /* DB down — regenerate rather than skip */ }
          if (!hasNotes) {
            setActivity("transcribing (manual) — generating notes", { meeting: title });
            const entries = t.chunks.map((c) => ({ meeting: title, offsetSec: c.offsetSec, file: realFile, transcript: c.text, visualNotes: [] as { t: string; note: string }[] }));
            await finalizeNotes(title, entries, paths);
          } else rebuildIndex();
        } catch (e) {
          console.error(`[transcribe] failed: ${e}`);
          pushEvent(`transcribe ✗ ${course}/${stem}: ${String(e).slice(0, 120)}`);
          await notify(`⚠️ Manual transcription failed for **${stem}**: \`${String(e).slice(0, 120)}\``);
        } finally {
          transcribeJob = null;
          setDetail({ transcribe: "" });
        }
      })();
      return send(202, { ok: true, note: "transcribing in background — watch the activity feed on the home page" });
    }
    if (url.pathname === "/mapping") {
      const readMap = async (): Promise<Record<string, string>> => {
        const m: Record<string, string> = {};
        for (const r of await listMappings()) {
          const slug = (await q(`select slug from courses where id = $1`, [r.courseId])).rows[0]?.slug;
          if (slug) m[r.matchTitle.trim()] = slug;
        }
        return m;
      };
      if (req.method === "GET") return send(200, await readMap());
      if (req.method === "PUT") {
        const body = await new Promise<Record<string, unknown>>((res) => {
          let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
        });
        const t = String(body.title ?? "").trim();
        const f = String(body.folder ?? "").trim().replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_");
        if (!t || !f) return send(400, { error: "title and folder required" });
        const created = !existsSync(join(NOTES_DIR, f)) && !existsSync(join(RECORDINGS_DIR, f));
        const cid = await courseId(f);
        try { await upsertMapping(t, normMappingTitle(t), cid); } catch (e) { return send(500, { error: `write failed: ${String(e).slice(0, 80)}` }); }
        await refreshMappings().catch(() => {});
        try { mkdirSync(join(NOTES_DIR, f), { recursive: true }); } catch { /* next write creates it */ }
        pushEvent(`mapping: "${t}" → ${f}${created ? " (folder created)" : ""}`);
        return send(200, { ok: true, mapping: await readMap(), created });
      }
      if (req.method === "DELETE") {
        const t = url.searchParams.get("title")?.trim();
        if (!t) return send(400, { error: "title required" });
        const m = await readMap();
        if (!(t in m)) return send(404, { error: "not mapped" });
        await deleteMapping(t);
        await refreshMappings().catch(() => {});
        return send(200, { ok: true, mapping: await readMap() });
      }
    }
    if (url.pathname === "/settings") {
      // masked view: raw keys never leave the daemon — the page only sees
      // where each key comes from + its last 4 chars
      const maskedSettings = (s: ReturnType<typeof getSettings>) => {
        const hint = (v?: string): string | null => (!v ? null : v.length <= 8 ? "••••" : `••••${v.slice(-4)}`);
        const gemini = s.geminiApiKey || process.env.GEMINI_API_KEY || "";
        const glm = s.glmApiKey || process.env.GLM_API_KEY || "";
        return {
          ...s, geminiApiKey: undefined, glmApiKey: undefined,
          keys: {
            gemini: { from: s.geminiApiKey ? "settings" : gemini ? "env" : null, hint: hint(gemini) || null },
            glm: { from: s.glmApiKey ? "settings" : glm ? "env" : null, hint: hint(glm) || null },
            glmBase: s.glmBase || process.env.GLM_BASE || "",
          },
        };
      };
      if (req.method === "GET") return send(200, maskedSettings(getSettings()));
      if (req.method === "PUT") {
        const body = await new Promise<Record<string, unknown>>((res) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
        });
        const { prev, next: s } = applySettingsPatch(body);
        // every changed knob lands in the activity feed
        const changes: string[] = [];
        if (prev.transcribe !== s.transcribe) changes.push(`transcription ${s.transcribe ? "ON" : "OFF (quota guard)"}`);
        if (prev.recordRetentionDays !== s.recordRetentionDays) changes.push(`retention ${s.recordRetentionDays === 0 ? "forever" : `${s.recordRetentionDays}d`}`);
        if (prev.batchSegments !== s.batchSegments) changes.push(`live batch ${s.batchSegments}/req`);
        if (prev.transcribeBatch !== s.transcribeBatch) changes.push(`asr batch ${s.transcribeBatch}/req`);
        if (prev.joinEarlyMinutes !== s.joinEarlyMinutes) changes.push(`join early ${s.joinEarlyMinutes}min`);
        if (prev.joinPaused !== s.joinPaused) changes.push(s.joinPaused ? "⛔ auto-join PAUSED" : "▶️ auto-join resumed");
        if (prev.geminiModels !== s.geminiModels) changes.push(`model chain → ${s.geminiModels}`);
        if (prev.geminiApiKey !== s.geminiApiKey) changes.push(`Gemini key ${s.geminiApiKey ? "updated (settings)" : "cleared → env"}`);
        if (prev.glmApiKey !== s.glmApiKey) changes.push(`GLM key ${s.glmApiKey ? "updated (settings)" : "cleared → env"}`);
        if (prev.glmBase !== s.glmBase) changes.push(`GLM base ${s.glmBase ? "updated" : "cleared → default"}`);
        if (changes.length) pushEvent(`settings: ${changes.join(" · ")}`);
        if (prev.joinPaused !== s.joinPaused) waker?.(); // take effect immediately (esp. UNpause — loop may be sleeping)
        return send(200, maskedSettings(s));
      }
    }
    if (url.pathname === "/models") {
      if (req.method === "GET") return send(200, getModelQuotas());
    }
    // ── ingest: bring-your-own Teams recording + optional transcript ────
    // Form gives week# + course → we derive the standard stem so the UI
    // (player, transcript, week grouping) picks it up like a native session.
    if (url.pathname === "/ingest" && req.method === "POST") {
      try {
        // streaming multipart: file parts land on disk, never in RAM
        // (undici formData() buffers the whole video — OOM in 4Gi pod)
        const TMP = join(config.userDataDir, "tmp-ingest");
        const parts = await parseMultipart(req, TMP);
        const fileP = parts.find((x) => x.name === "file" && x.path);
        const tfileP = parts.find((x) => x.name === "transcript" && x.path);
        const field = (n: string): string => parts.find((x) => x.name === n)?.text ?? "";
        const file = { name: fileP?.filename };
        const course = field("course").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_");
        // optional display name (e.g. "Git workshop") — stored as a sidecar
        // so sessions/chat can reference the recording by name, not just stem
        const name = field("name").replace(/[\\/\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!file?.name || !course) {
          for (const p of parts) if (p.path) discardPart(p.path);
          return send(400, { error: "file and course required" });
        }
        if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
          for (const p of parts) if (p.path) discardPart(p.path);
          return send(400, { error: "video must be mp4/webm/mov/m4v" });
        }

        // date: explicit > week-derived (Monday of week N) > today
        const cfg = getCourseConfig(course);
        let date = field("date");
        // filename wins if it carries a timestamp (auto-school webm stem or
        // Teams-style suffix ...-20260917_103216-...): hand-named files then
        // land on the right day without touching the form
        let seqFromFile = NaN;
        const mIso = file.name!.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        const mTeams = file.name!.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
        if (mIso) {
          date = `${mIso[1]}-${mIso[2]}-${mIso[3]}`;
          seqFromFile = Number(`${mIso[4]}${mIso[5]}${mIso[6]}`);
        } else if (mTeams) {
          date = `${mTeams[1]}-${mTeams[2]}-${mTeams[3]}`;
          seqFromFile = Number(`${mTeams[4]}${mTeams[5]}${mTeams[6]}`);
        }
        const week = Number(field("week"));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          if (Number.isFinite(week) && week >= 1 && cfg && /^\d{4}-\d{2}-\d{2}$/.test(cfg.semesterStart)) {
            const mon = new Date(`${weekMonday(cfg.semesterStart)}T00:00:00Z`);
            mon.setUTCDate(mon.getUTCDate() + (Math.min(15, Math.floor(week)) - 1) * 7);
            date = mon.toISOString().slice(0, 10);
          } else date = new Date().toISOString().slice(0, 10);
        }

        const rdir = join(RECORDINGS_DIR, course);
        mkdirSync(rdir, { recursive: true });
        mkdirSync(join(NOTES_DIR, course), { recursive: true });
        const stem = `${date}__${course}`;
        // unique 6-digit time suffix — collisions bump to the next "second"
        // filename timestamp > upload clock
        let seq = Number.isFinite(seqFromFile) ? seqFromFile : Number(new Date().toLocaleTimeString("en-CA", { hour12: false, timeZone: "America/Toronto" }).replace(/:/g, ""));
        if (!Number.isFinite(seq)) seq = 0;
        let mp4name = `${stem}__${String(seq).padStart(6, "0")}`;
        while (existsSync(join(rdir, mp4name + ".mp4")) || existsSync(join(rdir, mp4name + ".webm"))) mp4name = `${stem}__${String(++seq).padStart(6, "0")}`;
        mp4name += file.name!.match(/\.webm$/i) ? ".webm" : ".mp4";

        // move the streamed temp files into place (no RAM copies)
        placePart(fileP!.path!, join(rdir, mp4name));
        // display name → sessions.title, transcript.md → session_artifacts;
        // capture time from the placed file's mtime (preserved by the move)
        // and the HHMMSS sequence (Toronto-local, like the importer's start_time)
        let placedMtime: number | null = null;
        try { placedMtime = statSync(join(rdir, mp4name)).mtimeMs; } catch { /* just moved — should exist */ }
        const seqTime = Number.isFinite(seq) && seq > 0
          ? `${String(Math.floor(seq / 10000)).padStart(2, "0")}:${String(Math.floor(seq / 100) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`
          : null;
        const cid = await courseId(course);
        // session stem matches the on-disk filename (incl. the __HHMMSS suffix)
        // so the DB row keys exactly what data.ts / the importer derive for the
        // same recording — two uploads on one day stay two sessions.
        const mp4Stem = mp4name.replace(/\.(mp4|webm)$/, "");
        const sid = await sessionId(cid, mp4Stem, {
          sessionDate: date,
          title: name,
          startTime: seqTime,
          startedAt: placedMtime,
        });
        // Phase-4: the recording blob itself stays on fs, but its artifact
        // row must exist (mirrors consolidate.ts' post-copy upsert)
        await upsertArtifact(sid, "recording", `recordings/${course}/${mp4name}`, {
          storageUri: `file://recordings/${course}/${mp4name}`,
          mimeType: mp4name.endsWith(".webm") ? "video/webm" : "video/mp4",
          bytes: fileP?.bytes ?? null,
          retainedUntil: retainedUntilFrom(),
        });
        let wroteTranscript = false;
        if (tfileP) {
          const txt = (await import("node:fs/promises")).readFile(tfileP.path!, "utf8");
          await upsertArtifact(sid, "transcript", `notes/${course}/${mp4Stem}__transcript.md`,
            { content: `# ${name || "Transcript"}${name ? " — transcript" : ""} — ${course.replace(/_/g, " ")} (${date})\n\n${await txt}` });
          discardPart(tfileP.path!);
          wroteTranscript = true;
        }
        pushEvent(`ingest: ${mp4name}${name ? ` — "${name}"` : ""} (${((fileP?.bytes ?? 0) / 1e6).toFixed(0)} MB)${wroteTranscript ? " + uploaded transcript" : ""}`);
        return send(200, { ok: true, mp4: mp4name, stem, date, course, ...(name ? { name } : {}), transcript: wroteTranscript });
      } catch (e) { return send(500, { error: `ingest failed: ${String(e).slice(0, 120)}` }); }
    }
    // ── material download: one file streamed, many files/folders zipped ──
    // GET /courses/<slug>/materials/download?p=<rel>&p=<rel>… (repeat p per
    // selection; folders expand recursively server-side)
    const DL_RE = /^\/courses\/([^/]+)\/materials\/download$/;
    const dlm = url.pathname.match(DL_RE);
    if (dlm && req.method === "GET") {
      const slug = decodeURIComponent(dlm[1]!);
      const picks = [...new Set(url.searchParams.getAll("p").map((p) => sanitizeRelPath(p)).filter((p): p is string => !!p))];
      if (!picks.length) return send(400, { error: "p params required" });
      const root = MATERIALS_DIR(slug);
      const files: { abs: string; rel: string }[] = [];
      const seen = new Set<string>();
      const walk = (abs: string, rel: string): void => {
        let names: string[] = [];
        try { names = readdirSync(abs); } catch { return; }
        for (const n of names.sort()) {
          if (n === ".index" || n === "materials.json") continue; // derived caches / registry
          const crel = rel ? `${rel}/${n}` : n;
          if (seen.has(crel)) continue;
          seen.add(crel);
          let st;
          try { st = statSync(join(abs, n)); } catch { continue; }
          if (st.isDirectory()) walk(join(abs, n), crel);
          else files.push({ abs: join(abs, n), rel: crel });
        }
      };
      for (const rel of picks) {
        const abs = join(root, rel);
        if (!abs.startsWith(root + "/") && abs !== root) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) walk(abs, rel);
        else if (!seen.has(rel)) { seen.add(rel); files.push({ abs, rel }); }
      }
      if (!files.length) return send(404, { error: "no such files" });
      pushEvent(`material download: ${files.length} file(s) from ${slug}`);
      if (files.length === 1) {
        const st = statSync(files[0]!.abs);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${files[0]!.rel.split("/").pop()!.replace(/[^\w.\- ]+/g, "_")}"`,
          "Content-Length": st.size,
        });
        createReadStream(files[0]!.abs).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${slug}-materials-${new Date().toISOString().slice(0, 10)}.zip"`,
      });
      const zip = archiver("zip", { zlib: { level: 6 } });
      zip.on("error", () => res.destroy());
      zip.pipe(res);
      for (const f of files) zip.file(f.abs, { name: f.rel });
      zip.finalize().catch(() => { try { res.destroy(); } catch { /* gone */ } }); // never an unhandled rejection — that would kill the daemon
      return;
    }
    // ── save AI output (chat answer, sheet, …) as a course material ──
    // Markdown under Generated/ — instantly indexed + previewable + citable.
    const GEN_RE = /^\/courses\/([^/]+)\/materials\/generated$/;
    const genM = url.pathname.match(GEN_RE);
    if (genM && req.method === "POST") {
      const slug = decodeURIComponent(genM[1]);
      try {
        let body: Record<string, unknown> = {};
        try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
        const markdown = String(body.markdown ?? "").trim();
        if (!markdown) return send(400, { error: "markdown required" });
        // single-segment name: user may type a path — take the last segment
        let name = sanitizeRelPath(String(body.name ?? "").split("/").pop() ?? "") ?? "";
        if (!name) name = `AI note ${new Date().toISOString().slice(0, 10)}`;
        if (!/\.md$/i.test(name)) name += ".md";
        const rel = `Generated/${name}`;
        const abs = join(MATERIALS_DIR(slug), rel);
        if (!abs.startsWith(MATERIALS_DIR(slug))) return send(400, { error: "bad name" });
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, markdown);
        registerMaterial(slug, {
          path: rel, filename: name, week: null, category: "other",
          description: "saved from Ask AI", uploadedAt: new Date().toISOString(), size: markdown.length,
        });
        pushEvent(`saved AI answer as material: ${slug}/${rel}`);
        return send(200, { ok: true, path: rel });
      } catch (e) {
        return send(500, { error: `save failed: ${String(e).slice(0, 120)}` });
      }
    }

    // ── study-sheet generator: tool-loop LLM → dense markdown (+ PDF) ──
    const SHEET_RE = /^\/courses\/([^/]+)\/study-sheet$/;
    const sheetM = url.pathname.match(SHEET_RE);
    if (sheetM && req.method === "POST") {
      const slug = decodeURIComponent(sheetM[1]);
      void (async () => {
        try {
          let body: Record<string, unknown> = {};
          try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
          // regenerate: topic comes from the existing sheet's header comment
          let topic = String(body.topic ?? "").trim();
          if (!topic && typeof body.path === "string") {
            try {
              const head = readFileSync(join(MATERIALS_DIR(slug), sanitizeRelPath(body.path) ?? ""), "utf8").slice(0, 300);
              topic = head.match(/study-sheet topic:\s*(.+?)\s*-->/)?.[1]?.trim() ?? "";
            } catch { /* gone */ }
          }
          if (!topic) return send(400, { error: "topic required" });
          const stem = `study-sheet-${topic.toLowerCase().replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "") || "course"}`;
          const rel = `Generated/${stem}.md`;
          const cfg = getCourseConfig(slug);

          const systemPrompt = `You write PRINTABLE CHEAT SHEETS for the course "${slug.replace(/_/g, " ")}".${cfg?.semesterStart ? ` Semester starts ${cfg.semesterStart}.` : ""}
TOPIC: "${topic}".
First EXPLORE with tools: list_materials, then read_document / view_page on everything relevant; read_notes and search_transcripts for what the professor actually emphasized in class (exam hints, promised question types, lab content). Read enough for course-SPECIFIC facts — never guess.
Then output ONLY the cheat sheet itself as GitHub-flavored markdown (no preamble, no closing remarks):
- Dense and compact: tables, one-line definitions, formula boxes, micro worked examples. NO filler prose, NO study advice, NO "good luck".
- Organized by topic with ## headings; formulas in code spans; bold the exam-critical terms.
- Course-SPECIFIC content only (numbers, tools, naming and examples from these actual materials), never generic textbook filler.
- Budget: the sheet prints as ONE A4 page in two columns — prioritize ruthlessly, cut prose before cutting facts.
- End with a "## ⚡ Rapid recall" list of the ~10 most likely exam items as one-liners.`;
          const convo: ChatMsg[] = [
            { role: "system", content: systemPrompt },
            // GLM rejects a system-only messages array (400 code 1214) — the
            // chat endpoints carry history, this one needs an explicit kickoff
            { role: "user", content: `Build the "${topic}" cheat sheet now — explore with the tools first, then output only the sheet.` },
          ];
          // broad topics ("Test 1") legitimately need many tool rounds, but the
          // model will happily explore forever — steering + a tool-less final
          // round guarantee the sheet actually gets written
          const MAX_STEPS = 18;
          const WRITE_BY = 12;
          let reply = "";
          for (let step = 0; step < MAX_STEPS; step++) {
            const final = step === MAX_STEPS - 1;
            if (step === WRITE_BY) {
              convo.push({ role: "user", content: "Tool budget is over half used. If you have the key facts, stop exploring and WRITE THE CHEAT SHEET now — at most two more tool rounds for critical gaps." });
            }
            if (final) {
              convo.push({ role: "user", content: "FINAL ROUND — tool budget is exhausted. Output only the finished cheat sheet markdown now, using what you already read." });
            }
            const msg = await glmChatRaw(convo, final ? undefined : TOOL_DEFS);
            if (!final && msg.tool_calls?.length) {
              // tools in PARALLEL — read-heavy rounds finish at the slowest
              // call, not the sum
              const results = await Promise.all(msg.tool_calls.map(async (tc) => {
                const r = await runTool(tc, slug);
                pushEvent(`study-sheet tool: ${tc.function.name} → ${String(r).slice(0, 80).replace(/\s+/g, " ")}…`);
                return String(r).slice(0, 26_000);
              }));
              convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
              msg.tool_calls.forEach((tc, i) => convo.push({ role: "tool", tool_call_id: tc.id, content: results[i]! }));
              continue;
            }
            reply = msg.content;
            break;
          }
          if (!reply) return send(500, { error: "generation failed — model hit the tool-step limit; try a narrower topic" });
          // models sometimes wrap the whole sheet in one fence — unwrap
          const fence = reply.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
          if (fence) reply = fence[1]!;
          const md = `<!-- auto-school study-sheet topic: ${topic} -->\n\n# ${slug.replace(/_/g, " ")} — ${topic}\n\n${reply.trim()}\n`;

          const abs = join(MATERIALS_DIR(slug), rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, md);
          // PDF twin (skipped while recording — the .md still lands)
          const pdfRel = `Generated/${stem}.pdf`;
          const pdfOk = await mdToPdf(md, join(MATERIALS_DIR(slug), pdfRel));
          const reg = (p: string, f: string, size: number, desc: string): void =>
            registerMaterial(slug, { path: p, filename: f, week: null, category: "other", description: desc, uploadedAt: new Date().toISOString(), size });
          reg(rel, `${stem}.md`, md.length, `AI study sheet — ${topic}`);
          if (pdfOk) reg(pdfRel, `${stem}.pdf`, statSync(join(MATERIALS_DIR(slug), pdfRel)).size, `AI study sheet — ${topic} (printable)`);
          pushEvent(`study sheet generated: ${slug}/${rel}${pdfOk ? " +pdf" : ""}`);
          return send(200, { ok: true, path: rel, pdf: pdfOk ? pdfRel : null, topic });
        } catch (e) {
          return send(500, { error: `study sheet failed: ${String(e).slice(0, 150)}` });
        }
      })();
      return; // async handler sends the response
    }

    // ── course materials (upload / list / delete) + course config ─────
    const MATERIALS_RE = /^\/courses\/([^/]+)\/materials$/;
    const mm = url.pathname.match(MATERIALS_RE);
    if (mm) {
      const slug = decodeURIComponent(mm[1]);
      if (req.method === "GET") {
        // ?indexed=1 appends the derived .index/ page cache — opt-in only
        // (machine-extracted text, not meant for human browsing by default)
        const withIndex = url.searchParams.get("indexed") === "1";
        return send(200, { materials: withIndex ? [...await listMaterials(slug), ...listIndexFiles(slug)] : await listMaterials(slug) });
      }
      if (req.method === "POST") {
        try {
          // streaming multipart — multi-file with optional subpaths
          const TMP = join(config.userDataDir, "tmp-materials");
          const parts = await parseMultipart(req, TMP);
          const field = (n: string): string => parts.find((x) => x.name === n)?.text ?? "";
          const explicitWeek = Number(field("week"));
          const description = field("description");
          const files = parts.filter((x) => x.name === "file" && x.path);
          if (files.length === 0) {
            for (const p of parts) if (p.path) discardPart(p.path);
            return send(400, { error: "file required" });
          }
          const saved: { path: string; week: number | null }[] = [];
          for (let fi = 0; fi < files.length; fi++) {
            const f = files[fi]!;
            // subpath: per-file "pathN" field (webkitRelativePath), else filename
            const rawSub = field(`path${fi}`) || f.filename!;
            const rel = sanitizeRelPath(rawSub);
            const leaf = rel?.split("/").pop();
            if (!rel || !leaf || leaf === "materials.json" || rel.split("/").some((s) => s.startsWith("."))) {
              // hidden/derived paths (.index/…) are not user materials
              discardPart(f.path!);
              continue;
            }
            const dest = join(MATERIALS_DIR(slug), rel);
            if (!dest.startsWith(MATERIALS_DIR(slug))) { discardPart(f.path!); continue; }
            mkdirSync(dirname(dest), { recursive: true });
            placePart(f.path!, dest);
            // week: FOLDER NAME first (fool-proof), else the form's explicit week
            const week = weekFromPath(rel) ?? (Number.isFinite(explicitWeek) && explicitWeek >= 1 ? Math.min(15, Math.floor(explicitWeek)) : null);
            registerMaterial(slug, {
              path: rel, filename: leaf, week,
              category: "other", description, uploadedAt: new Date().toISOString(), size: f.bytes,
            });
            saved.push({ path: rel, week });
          }
          if (saved.length === 0) return send(400, { error: "no usable files" });
          pushEvent(`material upload: ${saved.length} file(s) → ${slug}${saved[0]?.week ? ` (week ${saved[0].week})` : ""}`);
          // EAGER INDEX — pay pdftotext/pdftoppm right after upload (in the
          // background, sequential), so the first chat read of a fresh doc
          // never stalls mid-answer. Fire-and-forget: the response is already
          // sent; failures surface in the activity feed.
          void (async () => {
            for (const s of saved) {
              if (!supportsIndex(s.path)) continue;
              try {
                const pages = await ensureIndex(slug, s.path);
                if (pages > 0) pushEvent(`eager-indexed ${s.path} (${pages} pages)`);
              } catch { /* next file */ }
            }
            // EMBED PASS — targeted: embed each fresh upload right after eager-index
            // so semantic search covers it immediately. Best-effort.
            for (const s of saved) {
              const er = await embedOneMaterial(slug, s.path, { log: (m) => pushEvent(`embed: ${m}`) });
              if (er.ok && er.chunks) pushEvent(`embedded ${er.chunks} chunk(s) from ${s.path}`);
            }
          })();
          return send(200, { ok: true, saved });
        } catch (e) { return send(500, { error: `upload failed: ${String(e).slice(0, 100)}` }); }
      }
      if (req.method === "PATCH") {
        // rename/move a file or folder: { from, to } relative paths
        try {
          let body: Record<string, unknown> = {};
          try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
          const from = sanitizeRelPath(String(body.from ?? ""));
          const to = sanitizeRelPath(String(body.to ?? ""));
          if (!from || !to) return send(400, { error: "from/to required" });
          const ok = renameMaterial(slug, from, to);
          if (ok) { pushEvent(`material renamed: ${from} → ${to} (${slug})`); return send(200, { ok: true }); }
          return send(404, { error: "not found" });
        } catch (e) { return send(500, { error: `rename failed: ${String(e).slice(0, 100)}` }); }
      }
      if (req.method === "DELETE") {
        const rel = sanitizeRelPath(url.searchParams.get("path") ?? "");
        if (!rel) return send(400, { error: "path param required" });
        const ok = deleteMaterial(slug, rel);
        if (ok) { pushEvent(`material deleted: ${rel} from ${slug}`); return send(200, { ok: true }); }
        return send(404, { error: "not found" });
      }
    }
    // ── optional video transcription → sibling .transcript.md material ──
    // POST /courses/<slug>/materials/transcribe {path} — starts background job
    // GET  /courses/<slug>/materials/transcribe?path=<rel> — poll status
    const TRANSCRIBE_RE = /^\/courses\/([^/]+)\/materials\/transcribe$/;
    const tm = url.pathname.match(TRANSCRIBE_RE);
    if (tm) {
      const slug = decodeURIComponent(tm[1]!);
      const videoExtOk = (leaf: string): boolean => [".mp4", ".webm", ".mkv"].includes(leaf.slice(leaf.lastIndexOf(".")).toLowerCase());
      const transcriptRel = (rel: string): string => `${rel}.transcript.md`;
      if (req.method === "GET") {
        const rel = sanitizeRelPath(url.searchParams.get("path") ?? "");
        if (!rel) return send(400, { error: "path param required" });
        const done = existsSync(join(MATERIALS_DIR(slug), transcriptRel(rel)));
        return send(200, { done, inFlight: materialTranscribeJobs.has(`${slug}|${rel}`), transcript: done ? transcriptRel(rel) : null });
      }
      if (req.method === "POST") {
        try {
          let body: Record<string, unknown> = {};
          try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
          const rel = sanitizeRelPath(String(body.path ?? ""));
          const leaf = rel?.split("/").pop() ?? "";
          if (!rel || !leaf || !videoExtOk(leaf)) return send(400, { error: "path must be a .mp4/.webm/.mkv material" });
          if (!allCourses().includes(slug)) return send(400, { error: "unknown course" });
          const absVideo = join(MATERIALS_DIR(slug), rel);
          if (!absVideo.startsWith(MATERIALS_DIR(slug) + "/") || !existsSync(absVideo)) return send(400, { error: "video not found" });
          const tRel = transcriptRel(rel);
          const absTranscript = join(MATERIALS_DIR(slug), tRel);
          if (existsSync(absTranscript)) return send(200, { done: true, exists: true, transcript: tRel });
          const key = `${slug}|${rel}`;
          if (materialTranscribeJobs.has(key)) return send(202, { started: true, inFlight: true });
          const filename = leaf;
          const job = (async () => {
            try {
              const t = await transcribeFile(absVideo);
              writeFileSync(absTranscript, transcriptToMd(filename, t.chunks));
              registerMaterial(slug, {
                path: tRel, filename: `${leaf}.transcript.md`, week: weekFromPath(tRel) ?? weekFromPath(rel),
                category: "transcript", description: "", uploadedAt: new Date().toISOString(), size: statSync(absTranscript).size,
              });
              pushEvent(`material transcribe: ${filename} done`);
              const er = await embedOneMaterial(slug, tRel, { log: (m) => pushEvent(`embed: ${m}`) });
              if (er.ok && er.chunks) pushEvent(`embedded ${er.chunks} chunk(s) from ${tRel}`);
            } catch (e) {
              const msg = String(e).slice(0, 120);
              pushEvent(`material transcribe FAILED: ${filename}: ${msg}`);
              console.error(`[material transcribe] ${filename}: ${e}`);
            } finally {
              materialTranscribeJobs.delete(key);
            }
          })();
          materialTranscribeJobs.set(key, job);
          return send(202, { started: true });
        } catch (e) { return send(500, { error: `transcribe failed: ${String(e).slice(0, 100)}` }); }
      }
    }
    const CONFIG_RE = /^\/courses\/([^/]+)\/config$/;
    const cm = url.pathname.match(CONFIG_RE);
    if (cm) {
      const slug = decodeURIComponent(cm[1]);
      if (req.method === "GET") return send(200, getCourseConfig(slug) ?? { semesterStart: "" });
      if (req.method === "PUT") {
        const body = await new Promise<Record<string, unknown>>((res) => {
          let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
        });
        const patch: { semesterStart?: string; icon?: string } = {};
        if ("semesterStart" in body) {
          const s = String(body.semesterStart ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return send(400, { error: "semesterStart must be YYYY-MM-DD" });
          patch.semesterStart = s;
        }
        if ("icon" in body) {
          const ic = String(body.icon ?? "");
          if (ic.length > 16) return send(400, { error: "icon must be ≤16 chars" });
          patch.icon = ic;
        }
        if (patch.semesterStart === undefined && patch.icon === undefined) return send(400, { error: "provide semesterStart and/or icon" });
        const cfg = setCourseConfig(slug, patch);
        // mirror into PG (DB-primary) — only the keys this patch actually includes
        try { await upsertCourseConfig(slug, patch); }
        catch (e) { console.error(`[daemon] DB course config failed: ${String(e)}`); }
        pushEvent(`course config: ${slug} updated (${Object.keys(patch).join(", ")})`);
        return send(200, cfg);
      }
    }
    // ── rename a course (folders + mapping follow) ───────────────────
    const REN_RE = /^\/courses\/([^/]+)\/rename$/;
    if (REN_RE.test(url.pathname) && req.method === "POST") {
      const from = decodeURIComponent(url.pathname.split("/")[2]!);
      const body = await new Promise<Record<string, unknown>>((res) => {
        let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
      });
      const to = String(body.to ?? "").trim().replace(/\s+/g, "_");
      if (!to || to === "." || to.includes("/") || to.includes("..")) return send(400, { error: "invalid new name" });
      if (to === from) return send(200, { ok: true, slug: to });
      const targets = [join(RECORDINGS_DIR, from), join(NOTES_DIR, from), join(DATA_DIR, "courses", from), join(config.userDataDir, "courses", from)];
      if (!targets.some((t) => existsSync(t))) return send(404, { error: `no course folder named ${from}` });
      for (const base of [RECORDINGS_DIR, NOTES_DIR, join(DATA_DIR, "courses"), join(config.userDataDir, "courses")]) {
        if (existsSync(join(base, to))) return send(409, { error: `"${to}" already exists` });
      }
      try {
        let moved = 0;
        for (const t of targets) if (existsSync(t)) { renameSync(t, join(dirname(t), to)); moved++; }
        // DB: rename the SAME courses row (id/FKs hold) — remap mappings by
        // that id, then rewrite rel_path prefixes in artifacts + documents
        try {
          const oldId = (await q(`select id from courses where slug = $1`, [from])).rows[0]?.id as number | undefined;
          const upd = await q(
            `update courses set slug=$1, name=$2, updated_at=now() where slug=$3 returning id`,
            [to, to.replace(/_/g, " "), from]);
          const toCid = upd.rows.length ? Number(upd.rows[0].id) : await courseId(to); // course absent from PG — register it
          if (oldId) await q(`update meeting_mappings set course_id = $1 where course_id = $2`, [toCid, oldId]);
          await q(
            `update session_artifacts set rel_path = replace(rel_path, 'notes/'||$1||'/', 'notes/'||$2||'/')
             where session_id in (select id from sessions where course_id=$3)`,
            [from, to, toCid]);
          await q(
            `update session_artifacts set rel_path = replace(rel_path, 'recordings/'||$1||'/', 'recordings/'||$2||'/')
             where session_id in (select id from sessions where course_id=$3)`,
            [from, to, toCid]);
          await q(
            `update documents set rel_path = replace(rel_path, 'notes/'||$1||'/', 'notes/'||$2||'/')
             where course_id=$3`,
            [from, to, toCid]);
          await refreshMappings().catch(() => {});
        } catch (e) { console.error(`[daemon] DB course rename failed: ${String(e)}`); }
        pushEvent(`course renamed: ${from} → ${to}`);
        return send(200, { ok: true, slug: to, moved });
      } catch (e) {
        return send(500, { error: `rename failed: ${String(e).slice(0, 120)}` });
      }
    }
    // ── create a course shell (manual-only courses: upload materials +
    //    ingest recordings/transcripts by hand until the bot can join) ──
    if (url.pathname === "/courses/create" && req.method === "POST") {
      const body = await new Promise<Record<string, unknown>>((res) => {
        let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
      });
      const slug = String(body.slug ?? "").trim().replace(/\s+/g, "_");
      if (!slug || slug === "." || slug.includes("/") || slug.includes("..")) return send(400, { error: "invalid name" });
      if (existsSync(join(RECORDINGS_DIR, slug)) || existsSync(join(NOTES_DIR, slug)) || existsSync(join(config.userDataDir, "courses", slug)))
        return send(409, { error: `"${slug}" already exists` });
      const s = String(body.semesterStart ?? "");
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return send(400, { error: "semesterStart must be YYYY-MM-DD" });
      try {
        // empty recordings/notes dirs make the course visible in the UI without
        // counting as "has sessions" (delete guard checks dir contents)
        mkdirSync(join(RECORDINGS_DIR, slug), { recursive: true });
        mkdirSync(join(NOTES_DIR, slug), { recursive: true });
        mkdirSync(MATERIALS_DIR(slug), { recursive: true });
        if (s) setCourseConfig(slug, { semesterStart: s });
        // register in PG (folder-union parity; semester_start when given)
        try { await upsertCourseConfig(slug, s ? { semesterStart: s } : {}); }
        catch (e) { console.error(`[daemon] DB course create failed: ${String(e)}`); }
        pushEvent(`course created: ${slug}${s ? ` (semester starts ${s})` : ""}`);
        return send(200, { ok: true, slug });
      } catch (e) {
        return send(500, { error: `create failed: ${String(e).slice(0, 120)}` });
      }
    }
    // ── deadlines (AI-built calendar of due dates + spread-out items) ──
    if (url.pathname === "/deadlines") {
      if (req.method === "GET") {
        const dl = await readDl();
        const ids = new Set(dl.map((d) => d.id));
        const f = await readFolds();
        const foldedChildren = Object.entries(f.folded)
          .filter(([, t]) => ids.has(t.parentId))
          .map(([key, t]) => ({ key, parentId: t.parentId, parentTitle: t.parentTitle ?? "", title: t.child.title, due: t.child.due, done: t.child.done, at: t.at }));
        return send(200, { deadlines: dl, suggestions: f.pending.filter((p) => ids.has(p.childId) && ids.has(p.parentId)), foldedChildren });
      }
      if (req.method === "DELETE") {
        await q(`delete from deadlines where owner_user_id = $1`, [curOwner()]);
        return send(200, { ok: true });
      }
      if (req.method === "POST") {
        (async () => {
          try {
            let body: Record<string, unknown> = {};
            try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
            // ── toggle done-ness by id (survives rebuilds) ──
            // ── manual date override: { id, due?, startBy?, revert? } ──
            // professor moved the due date → user sets it by hand; survives
            // rebuilds (merge keeps it, sweep can't clobber). revert clears it.
            // NOTE: must come BEFORE the done-toggle branch — its guard
            // (userNote === undefined) would otherwise swallow {id, due} bodies.
            if (typeof body.id === "string" && ("due" in body || "startBy" in body || body.revert === true)) {
              const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
              if ("due" in body && body.due !== null && !DATE_RE.test(String(body.due)))
                return send(400, { error: "due must be YYYY-MM-DD or null" });
              if ("startBy" in body && body.startBy !== null && !DATE_RE.test(String(body.startBy)))
                return send(400, { error: "startBy must be YYYY-MM-DD or null" });
              const dl = await readDl();
              const it = dl.find((d) => d.id === body.id);
              if (!it) return send(404, { error: "no such deadline id" });
              if (body.revert === true) {
                delete it.dueManual;
                it.confidence = "medium"; // until the next rebuild re-extracts
              } else {
                if ("due" in body) it.due = body.due === null ? null : String(body.due);
                if ("startBy" in body) it.startBy = body.startBy === null ? null : String(body.startBy);
                it.dueManual = true;
                it.confidence = "high"; // human-confirmed beats document text
              }
              await writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            if (typeof body.id === "string" && (body.delete === true || body.remove === true)) {
              // remove one entry — stale zombies the UI flags ("not in source")
              const dl = await readDl();
              const i = dl.findIndex((d) => d.id === body.id);
              if (i < 0) return send(404, { error: "no such deadline id" });
              const [gone] = dl.splice(i, 1);
              await writeDl(dl);
              return send(200, { ok: true, deleted: gone?.title ?? "", deadlines: dl });
            }
            // ── fold a sub-task into a parent's checklist (manual pick, or a
            //    suggestion accepted) — the verdict remembers the chosen parent
            //    so rebuilds re-bind to the USER's fold, not the LLM's pick ──
            if ((body.fold || body.acceptFold) && typeof (body.fold ?? body.acceptFold) === "object") {
              const { parent: pid, child: cid } = (body.fold ?? body.acceptFold) as { parent?: string; child?: string };
              const dl = await readDl();
              const parent = dl.find((d) => d.id === pid);
              const child = dl.find((d) => d.id === cid);
              if (!parent || !child || parent.id === child.id) return send(404, { error: "no such parent/child id" });
              if (parent.course !== child.course) return send(400, { error: "can only fold within the same course" });
              if (parent.done) return send(400, { error: "can't fold into a done deadline" });
              const key = dlKey(child.course, child.title);
              const det = await foldChildInto(parent, child);
              const f = await readFolds();
              f.verdicts[key] = { v: "accepted", parent: dlKey(parent.course, parent.title), parentTitle: parent.title };
              f.folded[key] = { child: { ...child }, parentId: parent.id, parentKey: dlKey(parent.course, parent.title), parentTitle: parent.title, addedItemIds: det.addedItemIds, enriched: det.enriched, partTitles: det.partTitles, at: Date.now() };
              f.pending = f.pending.filter((p) => p.childId !== child.id);
              await writeFolds(f);
              const out = dl.filter((d) => d.id !== child.id);
              await writeDl(out);
              pushEvent(`deadlines: folded "${child.title}" into "${parent.title}" (${det.steps} step(s))`);
              return send(200, { ok: true, folded: det.steps, deadlines: out });
            }
            // ── unfold: restore a folded child; remove exactly the steps the
            //    fold added and revert any enrichment (tombstone-driven) ──
            if (body.unfold && typeof body.unfold === "object") {
              const key = String((body.unfold as { key?: string }).key ?? "");
              const f = await readFolds();
              const t = f.folded[key];
              if (!t) return send(404, { error: "no such folded entry" });
              const cks = await readCk();
              const pc = cks.find((c) => c.deadlineId === t.parentId);
              if (pc) {
                if (t.addedItemIds.length) pc.items = pc.items.filter((it) => !t.addedItemIds.includes(it.id));
                if (t.enriched) {
                  const e = pc.items.find((it) => it.id === t.enriched!.itemId);
                  if (e) { e.text = t.enriched.prevText; e.done = t.enriched.prevDone; e.doneAt = e.done ? (e.doneAt ?? Date.now()) : null; }
                }
                pc.updatedAt = Date.now();
                await writeCk(cks);
              }
              const dl = await readDl();
              const parent = dl.find((d) => d.id === t.parentId);
              if (parent && t.partTitles?.length) {
                const rm = new Set(t.partTitles);
                parent.parts = (parent.parts ?? []).filter((p) => !rm.has(p.title));
                if (!parent.parts.length) delete parent.parts;
              }
              dl.push({ ...t.child }); // resurrect — writeDl's uniqIds guards id clashes
              delete f.verdicts[key];
              delete f.folded[key];
              await q(`delete from deadline_folds where child_id = (select id from deadlines where legacy_id = $1 and owner_user_id = $2 order by id limit 1)`, [t.child.id, curOwner()]);
              await writeDl(dl);
              pushEvent(`deadlines: unfolded "${t.child.title}" back out of "${parent?.title ?? t.parentId}"`);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── decline: never suggest this fold again (by course+title) ──
            if (body.declineFold && typeof body.declineFold === "object") {
              const cid = String((body.declineFold as { child?: string }).child ?? "");
              const dl = await readDl();
              const child = dl.find((d) => d.id === cid);
              const f = await readFolds();
              if (child) f.verdicts[dlKey(child.course, child.title)] = { v: "declined" };
              f.pending = f.pending.filter((p) => p.childId !== cid);
              await writeFolds(f);
              return send(200, { ok: true, deadlines: dl });
            }
            if (typeof body.id === "string" && body.userNote === undefined) {
              const dl = await readDl();
              const it = dl.find((d) => d.id === body.id);
              if (!it) return send(404, { error: "no such deadline id" });
              it.done = body.done !== false; // default true; explicit false un-checks
              it.doneAt = it.done ? Date.now() : null;
              await writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── student context note (group members, roles, …) by id ──
            if (typeof body.id === "string" && typeof body.userNote === "string") {
              const dl = await readDl();
              const it = dl.find((d) => d.id === body.id);
              if (!it) return send(404, { error: "no such deadline id" });
              const v = body.userNote.trim().slice(0, 2000);
              if (v) it.userNote = v; else delete it.userNote; // empty clears
              await writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── rebuild: LLM sweep → JSON; full, or incremental (changed docs only) ──
            // Delegated to the bundleable generator (5b-2 c, D5): the daemon injects
            // its quota-aware GLM client (429 learning, model rotation, activity
            // feed), its fs/VLM tool runner and the fs tool schemas, so the recorder
            // behaves exactly as before while the platform runs the SAME generator
            // over PG documents (src/db/gen/deadlines.ts).
            try {
              const rebuilt = await rebuildDeadlines({
                mode: body.mode === "full" ? "full" : "update",
                callTools: (messages, tools) => glmChatRaw(messages, tools),
                runTool: (name, argsJson) => runTool({ id: "deadlines", function: { name, arguments: argsJson } }),
                tools: TOOL_DEFS,
                onEvent: pushEvent,
              });
              // early exit: update mode with nothing changed since the last build
              if (rebuilt.unchanged) return send(200, { ok: true, mode: "update", count: rebuilt.count, added: [], changed: 0 });
              return send(200, { ok: true, mode: rebuilt.mode, count: rebuilt.count, added: rebuilt.added, updated: rebuilt.updated, deduped: rebuilt.deduped, folded: rebuilt.folded, suggestions: rebuilt.suggestions, changed: rebuilt.changed });
            } catch (e) {
              // in-body failures keep their exact pre-5b2c bodies (no JSON array /
              // JSON parse failed / empty deadline list)
              if (e instanceof DeadlineGenError) return send(e.status, { error: e.message });
              return send(500, { error: `deadline rebuild failed: ${String(e).slice(0, 150)}` });
            }
          } catch (e) {
            return send(500, { error: `deadline rebuild failed: ${String(e).slice(0, 150)}` });
          }
        })();
        return; // async handler sends the response
      }
    }
    // ── checklists (AI-generated, per-deadline execution lists) ──
    if (url.pathname === "/checklists") {
      if (req.method === "GET") return send(200, { checklists: await readCk() });
      if (req.method === "DELETE") {
        const id = url.searchParams.get("deadlineId");
        if (!id) { await q(`delete from checklist_items where deadline_id in (select id from deadlines where owner_user_id = $1)`, [curOwner()]); return send(200, { ok: true }); }
        const ck = (await readCk()).filter((c) => c.deadlineId !== id);
        await writeCk(ck);
        return send(200, { ok: true, checklists: ck });
      }
      if (req.method === "POST") {
        (async () => {
          try {
            const body = await new Promise<Record<string, unknown>>((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); });
            const ck = await readCk();
            const dlId = String(body.deadlineId ?? "");
            const mine = (): Ck | undefined => ck.find((c) => c.deadlineId === dlId);
            // ── toggle an item ──
            if (typeof body.itemId === "string") {
              const c = mine();
              const it = c?.items.find((x) => x.id === body.itemId);
              if (!c || !it) return send(404, { error: "no such checklist item" });
              it.done = body.done !== false;
              it.doneAt = it.done ? Date.now() : null;
              c.updatedAt = Date.now();
              await writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── manual add ──
            if (typeof body.add === "string" && body.add.trim()) {
              const text = body.add.trim().slice(0, 200);
              let c = mine();
              if (!c) {
                const dl = (await readDl()).find((d) => d.id === dlId);
                c = { deadlineId: dlId, course: dl?.course ?? "", title: dl?.title ?? text, items: [], updatedAt: Date.now() };
                ck.push(c);
              }
              const id = itemId(dlId, text);
              if (!c.items.some((x) => x.id === id)) c.items.push({ id, text, done: false, doneAt: null, manual: true });
              c.updatedAt = Date.now();
              await writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── remove an item ──
            if (typeof body.removeItemId === "string") {
              const c = mine();
              if (!c) return send(404, { error: "no such checklist" });
              c.items = c.items.filter((x) => x.id !== body.removeItemId);
              c.updatedAt = Date.now();
              await writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── generate / regenerate for a deadline ──
            const dl = (await readDl()).find((d) => d.id === dlId);
            if (!dl) return send(404, { error: "no such deadline id" });
            // DELEGATED to src/db/gen/checklist.ts (5b-2 c, B2): ONE generator
            // shared with the platform. The policy this daemon owns is injected:
            //   • quota-aware GLM call  → pipeline/llm.ts glmChatRaw
            //   • fs-capable tool runner → pipeline/tools.ts runTool (the .index/
            //     page bundles + VLM view_page the platform cannot have)
            // Prompts, the 10-round tool loop, the JSON contract and the
            // checklist_items carry-over (done-ness + manual adds, id =
            // deadlineId|text) are byte-for-byte the pre-5b2c code, now living in
            // gen/checklist.ts. Only delta on both paths: when the course corpus
            // has NO indexed text the user message gains one warning sentence.
            const gen = await generateChecklist(dl, dl.course, {
              callTools: (messages, tools) => glmChatRaw(messages, tools),
              runTool: (name, argsJson) => runTool({ id: "checklist", function: { name, arguments: argsJson } }, dl.course),
              tools: TOOL_DEFS,
              onEvent: pushEvent,
            });
            return send(200, { ok: true, count: gen.items.length, checklists: gen.checklists });
          } catch (e) {
            // generation failures keep their exact pre-5b2c bodies (no JSON array /
            // JSON parse failed / no usable steps)
            if (e instanceof ChecklistGenError) return send(e.status, { error: e.message });
            return send(500, { error: `checklist failed: ${String(e).slice(0, 150)}` });
          }
        })();
        return; // async handler sends the response
      }
    }
    // ── ALL-COURSES chat (/chat) ─────────────────────────────────
    // Same tool loop, no fixed course: the model must pass course= per
    // tool call (list_courses / week_overview help it navigate).
    if (url.pathname === "/chat" || url.pathname === "/chat/lexicon") {
      if (url.pathname === "/chat/lexicon" && req.method === "GET") {
        // leaf filename → ALL courses having it (ambiguous ones resolved by
        // the UI via context scoring) + per-course hint tokens for that scoring
        const lex: Record<string, { course: string; path: string }[]> = {};
        const hints: Record<string, string[]> = {};
        const m = allCourses();
        for (const c of m) {
          const toks = new Set<string>();
          for (const t of c.toLowerCase().replace(/[_\-.]+/g, " ").split(/\s+/)) if (t.length >= 4) toks.add(t);
          for (const mat of await listMaterials(c)) {
            (lex[mat.filename] ??= []).push({ course: c, path: mat.path });
          }
          hints[c] = [...toks];
        }
        // mapped meeting titles are richer course names ("Data Warehs & …")
        try {
          for (const r of await listMappings()) {
            const folder = (await q(`select slug from courses where id = $1`, [r.courseId])).rows[0]?.slug;
            if (!folder || !hints[folder]) continue;
            for (const t of r.matchTitle.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 5 && !hints[folder]!.includes(t)) hints[folder]!.push(t);
          }
        } catch { /* no mappings */ }
        return send(200, { lexicon: lex, hints });
      }
      const loadChat = (): Promise<{ role: "user" | "assistant"; content: string; at: string }[]> => chatList("global");
      const saveChat = (msgs: { role: "user" | "assistant"; content: string; at: string }[]): Promise<void> => chatSave("global", msgs);
      if (req.method === "GET") {
        const h = await loadChat();
        const w = buildChatWindow(h);
        return send(200, { messages: h, ctx: { keptFrom: w.keptFrom, pinned: w.pinned } });
      }
      if (req.method === "DELETE") {
        await chatClear("global");
        return send(200, { ok: true });
      }
      if (req.method === "POST") {
        (async () => {
          try {
            let body: Record<string, unknown> = {};
            try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
            const message = String(body.message ?? "").trim();
            if (!message) return send(400, { error: "message required" });
            const webSearch = body.webSearch === true;
            const tools = webSearch ? TOOL_DEFS_WITH_WEB : TOOL_DEFS;
            const history = await loadChat();
            history.push({ role: "user", content: message, at: new Date().toISOString() });

            const systemPrompt = `You are a study assistant for ALL of the student's courses (semester dates come from list_courses / week_overview).
For "what's due / what should I do next" questions, call list_deadlines FIRST — it's the student's curated calendar (items they finished are checked off and excluded — never re-suggest those).
For "what's left / where am I on X" questions also call list_checklists — it shows per-task step progress and the student's own context notes (group members, roles, …).
Start broad: list_deadlines, week_overview or list_courses, then inspect the promising documents with the course-scoped tools (they need a 'course' argument — use exact slugs from list_courses).
Recorded sessions may carry a display name the student gave at upload (workshops etc.) — list_sessions shows them; read_notes also accepts (part of) a name as 'date' (e.g. "the git workshop").
Read enough of the actual materials to answer concretely — never guess what a file contains. CITATIONS: every file you reference in your answer MUST be cited inline as [[exact/path.pdf]] using the EXACT path shown by list_materials (keep folders + extension, e.g. [[Week 1/1.1_ Data Warehousing - Dimensional Modeling.pdf]]) so it becomes a clickable link. Cite each file at first mention; never invent or shorten paths. NEVER write document links as markdown like [label](#doc:…) — the app renders citations itself; write them ONLY as [[path]]. If nothing exists for a week/course, say so honestly. TRANSCRIPTION: when asked to quote, repeat or list something from earlier in the conversation, call read_conversation (or scan your context) and quote directly — never claim you 'no longer have access' to earlier messages: they are stored and readable via read_conversation even if a CONTEXT WINDOW note says some were omitted.${webSearch ? "\nWEB ACCESS enabled: when the course materials genuinely don't cover the question, you may web_search the public web and web_read a result. Always prefer course materials when they answer it; cite web sources by URL." : ""}
FORMATTING: any sequence of steps, priorities or due dates is a markdown list ("1. …" or "- …"), never an inline ①②③ run-on line.`;
            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt + citationReuseLine(history) },
              ...history.slice(-16).map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
            ];
            // SSE stream: tool statuses + live answer tokens
            const reply = await streamChatLoop(res, convo, { tools, webSearch, maxSteps: CHAT_STEPS_GLOBAL, toolLabel: "global chat tool" });
            if (reply !== null) {
              history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
              await saveChat(history);
            }
          } catch (e) {
            try {
              if (!res.headersSent) return send(500, { error: `chat failed: ${String(e).slice(0, 150)}` });
              res.write(`data: ${JSON.stringify({ type: "error", error: `chat failed: ${String(e).slice(0, 150)}` })}\n\n`);
              res.end();
            } catch { /* client gone */ }
          }
        })();
        return; // async handler sends the response
      }
    }
    // ── document preview text (chat linkifier modal) ──────────────
    const docM = url.pathname.match(/^\/courses\/([^/]+)\/doc$/);
    if (docM && req.method === "GET") {
      const slug = decodeURIComponent(docM[1]!);
      const rel = url.searchParams.get("path") ?? "";
      const page = Number(url.searchParams.get("page") ?? "") || undefined;
      void (async () => {
        try {
          const r = await readDoc(slug, rel, page);
          return send(200, "error" in r ? { error: r.error } : r);
        } catch (e) { return send(500, { error: String(e).slice(0, 120) }); }
      })();
      return;
    }

    // ── course chat (GLM) ─────────────────────────────────────────────
    const CHAT_RE = /^\/courses\/([^/]+)\/chat$/;
    const chatM = url.pathname.match(CHAT_RE);
    if (chatM) {
      const slug = decodeURIComponent(chatM[1]!);
      const loadChat = (): Promise<{ role: "user" | "assistant"; content: string; at: string }[]> => chatList(slug);
      const saveChat = (msgs: { role: "user" | "assistant"; content: string; at: string }[]): Promise<void> => chatSave(slug, msgs);
      if (req.method === "GET") {
        const h = await loadChat();
        const w = buildChatWindow(h);
        return send(200, { messages: h, ctx: { keptFrom: w.keptFrom, pinned: w.pinned } });
      }
      if (req.method === "POST") {
        (async () => {
          try {
            let body: Record<string, unknown> = {};
            try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
            const message = String(body.message ?? "").trim();
            if (!message) return send(400, { error: "message required" });
            const webSearch = body.webSearch === true;
            const tools = webSearch ? TOOL_DEFS_WITH_WEB : TOOL_DEFS;
            const history = await loadChat();
            history.push({ role: "user", content: message, at: new Date().toISOString() });

            // ── tool-calling loop: the model explores the course itself ──
            const cfg = getCourseConfig(slug);
            const systemPrompt = `You are a study assistant for the course "${slug.replace(/_/g, " ")}".${cfg?.semesterStart ? ` Semester starts ${cfg.semesterStart}.` : ""}
For "what's due / what should I do next" questions, call list_deadlines FIRST — it's the student's curated calendar for THIS course (items they finished are checked off and excluded — never re-suggest those).
For "what's left / where am I on X" questions also call list_checklists — it shows per-task step progress and the student's own context notes (group members, roles, …).
Use the tools to inspect materials, documents and recorded sessions before answering — never guess what a file contains. Recorded sessions may carry a display name the student gave at upload (workshops etc.) — list_sessions shows them; read_notes also accepts (part of) a name as 'date'. CITATIONS: every material file you reference MUST be cited inline as [[exact/path.pdf]] using the EXACT path shown by list_materials (keep folders + extension, e.g. [[Week 1/1.1_ Data Warehousing - Dimensional Modeling.pdf]]) — the exact filename alone is fine when it is unambiguous. Cite each file at first mention; never invent or shorten paths. NEVER write document links as markdown like [label](#doc:…) — the app renders citations itself; write them ONLY as [[path]]. If tools show nothing relevant, say so honestly. TRANSCRIPTION: when asked to quote, repeat or list something from earlier in the conversation, call read_conversation (or scan your context) and quote directly — never claim you 'no longer have access' to earlier messages: they are stored and readable via read_conversation even if a CONTEXT WINDOW note says some were omitted.${webSearch ? "\nWEB ACCESS enabled: when the course materials genuinely don't cover the question, you may web_search the public web and web_read a result (docs, background). Always prefer course materials when they answer it; cite web sources by URL." : ""}
FORMATTING: any sequence of steps, priorities or due dates is a markdown list ("1. …" or "- …"), never an inline ①②③ run-on line.`;

            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt + citationReuseLine(history) },
              ...history.slice(-16).map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
            ];
            // SSE stream: tool statuses + live answer tokens
            const reply = await streamChatLoop(res, convo, { tools, webSearch, fallbackSlug: slug, maxSteps: CHAT_STEPS, toolLabel: "chat tool" });
            if (reply !== null) {
              history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
              await saveChat(history);
            }
          } catch (e) {
            try {
              if (!res.headersSent) return send(500, { error: `chat failed: ${String(e).slice(0, 150)}` });
              res.write(`data: ${JSON.stringify({ type: "error", error: `chat failed: ${String(e).slice(0, 150)}` })}\n\n`);
              res.end();
            } catch { /* client gone */ }
          }
        })();
        return; // async handler sends the response
      }
      if (req.method === "DELETE") {
        await chatClear(slug);
        return send(200, { ok: true });
      }
    }
    // ── delete a whole course folder ────────────────────────────────
    // ── delete a whole course folder ────────────────────────────────
    // Allowed ONLY when the course has no sessions (no recordings, no
    // transcripts/notes/timeline anywhere). Materials + config go too.
    if (/^\/courses\/([^/]+)$/.test(url.pathname) && req.method === "DELETE") {
      const course = decodeURIComponent(url.pathname.split("/")[2]!);
      try {
        const recDir = join(RECORDINGS_DIR, course);
        const hasRecordings = existsSync(recDir) && readdirSync(recDir).length > 0;
        const noteDir = join(NOTES_DIR, course);
        const hasNotes = existsSync(noteDir) && readdirSync(noteDir).length > 0;
        if (hasRecordings || hasNotes) {
          return send(409, {
            error: "course still has sessions — delete its recordings/notes first",
            recordings: hasRecordings, notes: hasNotes,
          });
        }
        let removed = 0;
        for (const root of [recDir, noteDir, join(DATA_DIR, "courses", course), join(config.userDataDir, "courses", course)]) {
          if (existsSync(root)) { rmSync(root, { recursive: true, force: true }); removed++; }
        }
        // drop the course row — ON DELETE CASCADE removes its meeting_mappings /
        // sessions / documents / deadlines (the fs check above guarantees no
        // live sessions). Without this the course reappears in the PG-backed
        // course list (DB_READS=1) even after its folders are gone.
        try {
          await q(`delete from courses where slug = $1`, [course]);
          await refreshMappings().catch(() => {});
        } catch (e) { console.error(`[daemon] db course delete failed: ${String(e)}`); }
        pushEvent(`course deleted: ${course} (had no sessions)`);
        return send(200, { ok: true, course, removed });
      } catch (e) {
        return send(500, { error: `course delete failed: ${String(e).slice(0, 120)}` });
      }
    }
    // ── raw media / file streaming (5b-1 recorder media route) ───────────
    // Serves any file under DATA_DIR by relative path so the platform's
    // /api/media/[...path] proxy can stream straight from this recorder
    // instead of a shared volume. It requests `${RECORDER_ENDPOINT}/<rel>`
    // with rel like `recordings/<COURSE>/<file>.webm`, `out/<file>.png`, or
    // `courses/<slug>/materials/<file>`.
    //
    // ROUTE SHAPE — root-mounted, no `/media` prefix: the platform proxy's
    // URL build already has no prefix, so this needs zero frontend change.
    // It lives LAST in handleRequest, immediately before the 404, so the
    // more specific routes registered above (`/courses/<slug>/materials`,
    // `.../materials/download`, `.../materials/generated`, the PATCH/DELETE
    // forms using `?path=`) always win and this GET/HEAD-only prefix can
    // never shadow them. Prefixes limited to recordings/ | out/ | courses/.
    //
    // Path safety mirrors frontend/src/app/api/media/[...path]/route.ts:
    // normalize, reject `..`/absolute escape; the resolved path must stay
    // under DATA_DIR. Streaming + HTTP Range match the material-download
    // handler above (createReadStream, no buffering).
    //
    // X-Auto-School-User is sent on this hop but IGNORED this phase:
    // per-owner recorder resolution already happened platform-side, and this
    // daemon is single-owner until the recorder-split lands.
    const MEDIA_RE = /^\/(?:recordings|out|courses)\/.+/;
    if ((req.method === "GET" || req.method === "HEAD") && MEDIA_RE.test(url.pathname)) {
      let rel: string;
      try { rel = normalize(decodeURIComponent(url.pathname).replace(/^\/+/, "")); } catch { return send(400, { error: "bad path" }); }
      const root = resolve(DATA_DIR);
      const abs = resolve(root, rel);
      // `..` segments collapse before the prefix check, so `/out/../settings.json`
      // normalizes to `settings.json` — keep the served set to the three
      // advertised prefixes (settings.json holds API keys).
      if (!/^(?:recordings|out|courses)(?:\/|$)/.test(rel) || rel.startsWith("..") || rel.includes("\0") || (abs !== root && !abs.startsWith(root + sep))) {
        return send(404, { error: "not found" }); // traversal / absolute escape / off-prefix
      }
      let st;
      try { st = statSync(abs); } catch { return send(404, { error: "not found" }); }
      if (!st.isFile()) return send(404, { error: "not found" });
      const size = st.size;
      const type = MEDIA_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
      const rng = req.headers.range ? /bytes=(\d+)?-(\d+)?/.exec(req.headers.range) : null;
      if (rng && size > 0) {
        const start = rng[1] ? parseInt(rng[1], 10) : 0;
        const end = rng[2] ? Math.min(parseInt(rng[2], 10), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "Content-Type": type, "Content-Range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        });
        if (req.method === "HEAD") { res.end(); return; }
        const rs = createReadStream(abs, { start, end });
        // file deleted mid-stream (retention / move) must not take the daemon down
        rs.on("error", () => res.destroy());
        rs.pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
      if (req.method === "HEAD") { res.end(); return; }
      const fsStream = createReadStream(abs);
      fsStream.on("error", () => res.destroy());
      fsStream.pipe(res);
      return;
    }
    send(404, { error: "not found" });
  }

  server.listen(PORT, () => console.log(`[daemon] controller listening on :${PORT}`));
  // index warm-up sweep — delayed so boot/restore stays snappy; skipped
  // (and retried later) while a class recording is live
  setTimeout(() => void sweepIndexes(), 45_000).unref?.();
}

export async function daemon(): Promise<void> {
  await refreshMappings().catch(() => { /* DB down → empty mapping cache until first write */ });
  await hydrateAttendance();
  await hydrateLeftToday();
  // DB-primary state: settings (seed-migrated from fs on first boot — must
  // precede retentionPass, whose schedule reads them) and course configs
  await hydrateSettings();
  await hydrateCourseConfigs().catch(() => { /* DB down → fs configs answer */ });
  startController();
  // recorder registry heartbeat (recorder-split.md §3): register this personal
  // pod every 30s so the platform can resolve the owner's recorder endpoint.
  startRecorderHeartbeat();
  // fresh volume guarantee: the whole dir skeleton exists before anything writes
  // (k8s PVCs start empty — compose had these pre-created by the seed volume)
  for (const d of [OUT_DIR, SEGMENTS_DIR, NOTES_DIR, RECORDINGS_DIR]) mkdirSync(d, { recursive: true });
  // retention: first pass AFTER rescue (orphans older than the cutoff are
  // past retention anyway), then every 6h. Videos only — transcripts stay.
  const retentionPass = (): void => {
    const r = runRetention();
    if (r && r.removed > 0)
      pushEvent(`retention: removed ${r.removed} video file(s), freed ${(r.freedBytes / 1e6).toFixed(0)} MB — transcripts & notes kept`);
    // piggyback: incremental material embedding sweep (no-op when fresh; PG/key
    // absent → silent skip — uploads still embed when config returns)
    void embedPendingMaterials().then((er) => {
      if (er.ok && er.chunks) pushEvent(`embed sweep: +${er.chunks} chunk(s) from ${er.docs} material(s)`);
    }).catch(() => { });
    // same for session notes/timelines (finished or running sessions become
    // searchable within the sweep window)
    void embedPendingSessions().then((er) => {
      if (er.ok && er.chunks) pushEvent(`embed sweep: +${er.chunks} session chunk(s) from ${er.docs} session doc(s)`);
    }).catch(() => { });
  };
  setInterval(retentionPass, 6 * 3_600_000).unref();
  // rehydrate the session board from PG first — /status's Completed Sessions
  // panel must show past captures, not just this process's updates
  await hydrateSessions().catch(() => { });
  // background queue: rescue old segments WITHOUT blocking discovery —
  // consolidations are serial (2 encode threads) and can take minutes
  void rescueOrphans().finally(() => { retentionPass(); setActivity("idle — finished orphan rescue", {}); });

  /** Convert every .docx that lacks a finished PDF twin in its bundle.
   *  Runs at startup + every rebuild interval; defers while recording
   *  (the guard lives inside ensureIndex, which retries next pass). */
  let twinBusy = false;
  const docxTwinPass = async (): Promise<void> => {
    if (twinBusy) return;
    twinBusy = true;
    try {
      for (const c of allCourses()) {
        for (const m of await listMaterials(c)) {
          if (!m.path.toLowerCase().endsWith(".docx")) continue;
          const dir = indexDir(c, m.path);
          if (existsSync(join(dir, "source.pdf")) && !existsSync(join(dir, ".textonly")) && bundleFresh(c, m.path)) continue; // twin done + source unchanged
          pushEvent(`docx twin: converting ${m.filename}`);
          await ensureIndex(c, m.path);
        }
      }
    } catch (e) {
      pushEvent(`docx twin pass failed: ${String(e).slice(0, 90)}`);
    } finally { twinBusy = false; }
  };
  // consecutive join failures per title — 3 strikes then give up loudly.
  // Day-keyed: strikes must NOT survive to next week's occurrence of the
  // same recurring title (a long-lived pod would otherwise 1-strike it)
  const joinFails = new Map<string, { n: number; day: string }>();
  // DOCX→PDF twin pass: every .docx gets a viewable PDF twin in its bundle
  // (source.pdf). ensureIndex has the recording guard — during class it defers
  void docxTwinPass();
  setInterval(() => void docxTwinPass(), 12 * 3_600_000); // docx twins: twice daily is plenty
console.log(`[daemon] schedule-driven: ${process.env.REBUILD_AT ? `wall-clock rebuilds at ${process.env.REBUILD_AT}` : `rebuild every ${nextRebuildGapMin()} min`}, sleep until join windows (join ${joinEarlyMs() / 60_000} min early)`);
  for (;;) {
    try {
      // manual join (/join) owns the shared browser while it runs — the old
      // per-action logins were serialized by the profile lock; the singleton
      // needs an explicit guard against concurrent calendar walks on one page
      if (active || state.startsWith("attending")) { await nap(30_000); continue; }
      // rebuild only when an anchor has actually PASSED since the last
      // build (empty schedule → 10-min retry; 60-min when the LOGIN itself
      // is failing, so unattended MFA waits don't buzz every 10 minutes).
      // against remaining-to-anchor rebuilds at every midpoint — a halving
      // login+scrape spam converging on each anchor.
      if (!schedule.length || Date.now() >= nextRebuildAt()) {
        setActivity(hasGraphToken() ? "building today's schedule (Graph)" : "building today's schedule (browser)", {});
        buildBusy = true;
        try {
          await buildSchedule();
          pushEvent(`schedule built: ${schedule.length} event(s)${hasGraphToken() ? " via Graph" : " via browser"}`);
        } finally { buildBusy = false; }
      }
      const next = nextActionable();
      if (next) {
        if (getSettings().joinPaused) {
          // pause is a PURE GATE — never mutates event state, so unpausing
          // restores exactly what was pending. Console-only: no event spam.
          console.log(`[daemon] join paused — ${next.title} stays pending`);
        } else {
          state = `attending: ${next.title}`;
          const ok = await joinScheduled(next);
          state = "idle";
          if (ok) { joinFails.delete(next.title); continue; } // back-to-back classes
          // bounded retry: 3 attempts 2 min apart, then give up loudly
          const today = new Date().toDateString();
          const prevFails = joinFails.get(next.title);
          const fails = prevFails?.day === today ? prevFails.n + 1 : 1;
          joinFails.set(next.title, { n: fails, day: today });
          if (fails >= 3) {
            handled.add(handledKey(next.title, next.start));
            pushEvent(`gave up joining "${next.title}" after ${fails} attempts`);
            void notify(`⚠️ Gave up joining **${next.title}** after ${fails} attempts — manual Join is available`).catch(() => {});
          } else {
            await nap(2 * 60_000);
          }
          continue;
        }
      }
      // sleep until the NEXT join window (or next rebuild), interruptible by /scan
      const now = Date.now();
      const upcoming = schedule.filter((e) => e.start - joinEarlyMs() > now && !attendedToday().includes(e.title));
      const nextAt = upcoming[0]?.start - joinEarlyMs();
      const wakeAt = Math.min(nextAt ?? Infinity, nextRebuildAt());
      // empty schedule = build failed. Browser/login down: retry 10 min —
      // unless the LOGIN itself failed, then stretch so unattended mornings
      // don't spam MFA pushes every 10 minutes… EXCEPT when the failure was
      // an unapproved MFA push: the user is actively waiting to approve, so
      // bring the next push back quickly instead of an hour later.
      const loginDown = lastLoginFailedAt > 0 && Date.now() - lastLoginFailedAt < 15 * 60_000;
      const mfaWaited = loginDown && /state "mfa/i.test(lastLoginFailDetail);
      // unverified-shell: the login "worked" but nothing authenticated — the
      // browser module wipes the poisoned profile on the 2nd occurrence and
      // the NEXT attempt is a full SSO; retry at the short MFA cadence so the
      // wipe+recovery isn't gated behind the 60-min generic backoff.
      const unverified = loginDown && /unverified-shell/.test(lastLoginFailDetail);
      const loginRetryMs = (Number(process.env.MFA_RETRY_MINUTES ?? 12) || 12) * 60_000;
      const sleepMs = Math.max(5_000, Math.min(wakeAt - now, schedule.length ? 60 * 60_000 : loginDown ? (mfaWaited || unverified ? loginRetryMs : 60 * 60_000) : 10 * 60_000));
      state = "idle";
      const rescueBusy = scheduleBuiltAt === 0; // rescue may still be pre-schedule
      const t12 = (d: number) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
      const dayOf = (d: number) => new Date(d).toDateString() === new Date().toDateString()
        ? "" : ` ${new Date(d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at`;
      setActivity(nextAt ? `idle — next: ${upcoming[0].title}${dayOf(nextAt)} ${t12(nextAt)}` : "idle — no more meetings today (Scan to refresh)", {});
      await nap(sleepMs);
    } catch (e) {
      state = "error";
      console.warn(`[daemon] cycle error: ${String(e).slice(0, 200)}`);
      await nap(60_000);
    }
  }
}

/** Join one scheduled event — by URL (Graph) or by scrape+DOM (fallback). */
async function joinScheduled(ev: Sched): Promise<boolean> {
  const b = await getBrowser();
  if (!b) { pushEvent("browser unavailable — cannot join"); leaveRequested = false; return false; } // void any leave pressed mid-join — no session to leave
  const { ctx, page: home } = b;
  try {
    setActivity("joining meeting", { meeting: ev.title });
    // per-occurrence URLs: donor propagation is gone, so enriched URLs are
    // same-day-scoped and trustworthy. nKey/sameTitle below handle truncated
    // calendar-chip titles when the card fallback is needed
    const nKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const sameTitle = (a: string, b: string): boolean => {
      if (a === b) return true;
      const x = nKey(a), y = nKey(b);
      return x.length >= 10 && y.length >= 10 && (x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x));
    };
    const early = joinEarlyMs() + 60_000; // match the card slightly before its window opens
    // URL-first (works regardless of calendar view), then the calendar card
    // click as fallback (the day-view walk can leave the calendar parked on
    // another day, which makes today's card invisible)
    let page: import("playwright").Page | null = ev.joinUrl
      ? await joinMeetingByUrl(ctx, ev.title, ev.joinUrl)
      : null;
    if (!page) {
      const meetings = await listMeetings(home);
      const m = meetings.find((x) => sameTitle(x.title, ev.title)
        && Date.now() >= x.start.getTime() - early && Date.now() < x.end.getTime());
      if (m?.joinUrl) {
        page = await joinMeetingByUrl(ctx, m.title, m.joinUrl); // fresh per-occurrence URL
      } else if (m) {
        page = await joinMeeting(ctx, m); // event card click — no URL involved
      }
    }
    if (!page) {
      // session can die between morning build and class time — detect it on
      // the home page so strike 2 logs in fresh instead of burning all 3
      if (!active && !(await authAlive(home).catch(() => true))) {
        pushEvent(`session expired at join time (${ev.title}) — recycling browser; next attempt re-logins`);
        invalidateBrowser();
      }
      pushEvent(`"${ev.title}" not joinable at join time — skipping`);
      leaveRequested = false; // void any leave pressed mid-join — no session to leave (else NEXT class insta-leaves)
      return false;
    }
    await attendAndRecord(page, ev.title, ev.joinUrl, ev.end);
    return true;
  } catch (e) {
    // browser-level failure → recycle the shared context for the next attempt
    if (/Target closed|Browser.*(closed|crashed)|context destroyed/i.test(String(e))) invalidateBrowser();
    console.warn(`[join] attempt failed: ${String(e).slice(0, 150)}`);
    leaveRequested = false; // void any leave pressed mid-join — no session to leave
    return false;
  }
}
