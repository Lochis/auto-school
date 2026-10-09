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
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createReadStream, readdirSync, statSync, existsSync, rmSync, writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import archiver from "archiver";
import { join, dirname } from "node:path";
import { getBrowser, invalidateBrowser, closeBrowser, authAlive, lastLoginFailedAt } from "./meetings/browser.ts";
import { listMeetings } from "./meetings/list.ts";
import { joinMeeting, joinMeetingByUrl } from "./meetings/join.ts";
import { listTodayMeetings } from "./graph/meetings.ts";
import { startNetworkHarvest, harvestCalendarEvents } from "./graph/calendar.ts";
import { getAccessToken } from "./graph/auth.ts";
import { config } from "./config.ts";
import { parseMultipart, placePart, discardPart } from "./http/multipart.ts";
import { startRecording, quickStopRecording, stopRecording, stillInMeeting, rebuildSeekPoints, RECORD_DIR } from "./record/recorder.ts";
import { consolidateSession } from "./pipeline/consolidate.ts";
import { notify } from "./notify.ts";
import { setActivity, setDetail, pushEvent, snapshot, getSettings, setSettings, getModelQuotas, loadLeftToday, recordLeftToday, clearLeftToday, applySettingsPatch } from "./status.ts";
import { lastDeviceCode } from "./graph/auth.ts";
import { NOTES_DIR, RECORDINGS_DIR, OUT_DIR, SEGMENTS_DIR, outPath, DATA_DIR } from "./paths.ts";
import { listMaterials, registerMaterial, deleteMaterial, renameMaterial, sanitizeRelPath, weekFromPath, MATERIALS_DIR, getCourseConfig, setCourseConfig, weekOf, weekMonday } from "./pipeline/materials.ts";
import { glmChatRaw, type ChatMsg } from "./pipeline/llm.ts";
import { TOOL_DEFS, TOOL_DEFS_WITH_WEB, runTool, allCourses } from "./pipeline/tools.ts";
import { ensureIndex, indexDir, bundleFresh } from "./pipeline/docindex.ts";
import { readDoc } from "./pipeline/docindex.ts";
import { rebuildIndex, parseCourse, courseDir } from "./pipeline/courses.ts";
import { finalizeNotes } from "./pipeline/notes.ts";
import { updateSession } from "./pipeline/sessions.ts";
import { transcribeFile } from "./transcribe/transcribe.ts";
import { runRetention } from "./pipeline/retention.ts";

const POLL_MS = (Number(process.env.POLL_MINUTES ?? 2) || 2) * 60_000;
const DISCOVERY_MS = (Number(process.env.DISCOVERY_SECONDS ?? 60) || 60) * 1_000; // Graph poll cadence
// join this long before start — re-read at use so Settings applies without restart
const joinEarlyMs = () => Math.max(0, getSettings().joinEarlyMinutes) * 60_000;
const PORT = Number(process.env.CONTROLLER_PORT ?? 7800) || 7800;

/** Graph tokens live next to the browser profile — cheap HTTP polling is only
 *  possible after the one-time device-code approval (POST /auth/graph). */
const graphTokenFile = join(dirname(config.userDataDir), "graph-tokens.json");
function hasGraphToken(): boolean {
  return existsSync(graphTokenFile);
}

const handled = new Set<string>();
let state = "idle"; // "idle" | "attending: <title>" | "error"
let lastScan: string | null = null;
let lastSeen = 0;
let waker: (() => void) | null = null;
/** set by POST /leave — the meeting watch loop breaks and the bot leaves */
let leaveRequested = false;
/** non-null while a manual (web UI) transcription job runs — "course/stem" */
let transcribeJob: string | null = null;
/** the active meeting's page, for graceful shutdown */
let active: { page: import("playwright").Page; title: string } | null = null;

/** true while the loop's schedule build is walking the shared calendar page —
 *  /join must not walk the SAME page concurrently (old code was serialized
 *  by the profile lock; the singleton needs an explicit flag) */
let buildBusy = false;
/** one "session expired" Discord ping per process (login MFA pushes still
 *  ping per attempt — that's the actionable ask) */
let authExpiredPinged = false;

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
    setActivity("rescuing orphaned session", { meeting: stem });
    console.log(`[daemon] orphan rescue: ${parts.length} segment(s) from ${stem}`);
    updateSession(stem, { stage: "consolidating", stageNote: "orphan rescue", segCount: parts.length });
    for (const p of paths) await rebuildSeekPoints(p.split(/[\\/]/).pop()!);
    // audio ogg is named with the SESSION-start timestamp: <slug>__<ISO>.audio.ogg
    const oggName = readdirSync(RECORD_DIR).find((f) => f.startsWith(`${stem}__`) && f.endsWith(".audio.ogg"));
    const ogg = oggName ? join(RECORD_DIR, oggName) : undefined;
    try {
      // title slug lives before the "__<ISO timestamp>" suffix — keeps
      // rescued sessions filed under the same course folder as live ones
      const title = stem.replace(/__\d{4}-\d{2}-\d{2}.*$/, "").replace(/_/g, " ") || stem;
      // dedupe guard: if the target course already has a consolidated file
      // from this date, the normal pipeline handled it — rescue would only
      // mint a "<stem>__<ts>" twin of the same class
      const dateTag = parts[0].match(/__(\d{4}-\d{2}-\d{2})T/)?.[1];
      if (dateTag) {
        const dest = join(RECORDINGS_DIR, parseCourse(title).slug);
        const dup = readdirSync(dest).find((f) => f.startsWith(`${dateTag}__`) && /\.(webm|mp4)$/.test(f));
        if (dup) {
          console.log(`[daemon] orphan rescue: ${stem} already consolidated as ${dest}/${dup} — skipping`);
          updateSession(stem, { stage: "done", stageNote: "duplicate — already consolidated" });
          continue;
        }
      }
      const r = await consolidateSession(title, paths, undefined, ogg && existsSync(ogg) ? ogg : undefined);
      pushEvent(r ? `orphan rescued ✓ ${r.mp4}` : `orphan rescue failed for ${stem} (segments kept)`);
      updateSession(stem, r ? { stage: "done", mp4: r.mp4, sizeMB: Math.round(r.outBytes / 1e6) } : { stage: "failed", stageNote: "rescue failed — segments kept" });
    } catch (e) {
      console.warn(`[daemon] orphan rescue failed: ${String(e).slice(0, 120)}`);
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

const JOURNAL = join(dirname(config.userDataDir), "attended.json");
/** attendance journal (persisted): [{date,title,joinedAt,leftAt?}] */
function loadJournal(): { date: string; title: string; joinedAt: number; leftAt?: number }[] {
  try { return JSON.parse(readFileSync(JOURNAL, "utf8")); } catch { return []; }
}
function journalEntry(title: string, patch: Partial<{ leftAt: number }>): void {
  const j = loadJournal();
  let e = j.find((x) => x.title === title && x.date === new Date().toDateString() && x.leftAt === undefined);
  if (!e) { e = { date: new Date().toDateString(), title, joinedAt: Date.now() }; j.push(e); }
  Object.assign(e, patch);
  try { writeFileSync(JOURNAL, JSON.stringify(j, null, 2)); } catch { /* read-only */ }
}
function attendedToday(): string[] {
  const today = new Date().toDateString();
  return loadJournal().filter((e) => e.date === today).map((e) => e.title);
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
        // Start intercepting Bearer tokens from Teams' own Graph API calls.
        // This MUST happen before listMeetings navigates to the calendar —
        // Teams makes graph.microsoft.com requests during calendar load.
        const drainNetwork = startNetworkHarvest(b.page);
        const ms = await listMeetings(b.page);
        lastScan = new Date().toISOString();
        lastSeen = ms.length;
        for (const m of ms) evs.push({ title: m.title, start: m.start.getTime(), end: m.end.getTime(), ...(m.joinUrl ? { joinUrl: m.joinUrl } : {}) });
        // PREFERRED: call Outlook REST API from the OWA frame (cookie-based)
        // or Graph API with a captured token — both give real join URLs.
        try {
          const apiEvts = await harvestCalendarEvents(b.page, drainNetwork);
          if (apiEvts.length) {
            // match by title + same calendar day (titles recur across days)
            const sameDay = (a: number, b: number): boolean =>
              new Date(a).toDateString() === new Date(b).toDateString();
            const used = new Set<number>();
            // calendar chips truncate titles at ~40 chars and drop "&" — match
            // API events to scraped ones by normalized containment so a
            // truncated chip never spawns a duplicate event, and the join
            // uses the FULL API title (mapping keys match those exactly)
            const nKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
            const sameEvt = (a: string, b: string): boolean => {
              const x = nKey(a), y = nKey(b);
              return x === y || (x.length >= 10 && (x.includes(y) || y.includes(x)));
            };
            for (const ae of apiEvts) {
              if (!ae.joinUrl) continue;
              const idx = evs.findIndex((e) =>
                !used.has(evs.indexOf(e)) &&
                sameDay(e.start, ae.start) &&
                (e.title.toLowerCase() === ae.title.toLowerCase() || sameEvt(e.title, ae.title)));
              if (idx >= 0) { evs[idx].joinUrl = ae.joinUrl; evs[idx].title = ae.title; used.add(idx); }
              else evs.push({ title: ae.title, start: ae.start, end: ae.end, joinUrl: ae.joinUrl });
            }
            // NOTE: no cross-day URL propagation — weekly-recurring classes
            // rotate meeting links per occurrence, so a URL-less event stays
            // URL-less; joinScheduled falls back to the DOM card click
            console.log(`[daemon] API enriched: ${apiEvts.filter((e) => e.joinUrl).length} event(s) with join URLs`);
          }
        } catch (e) {
          console.warn(`[daemon] Calendar API pull failed: ${String(e).slice(0, 120)} — using OWA scrape data`);
        }
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
      if (b2 && !(await authAlive(b2.page))) {
        if (!authExpiredPinged) {
          authExpiredPinged = true;
          void notify("🔑 **Teams session expired** — re-authenticating now (approve the MFA push if your phone buzzes; hourly retries until approved)").catch(() => {});
        }
        pushEvent("Teams session expired — recycling browser for fresh login");
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

/** next event whose join window (start - JOIN_EARLY) has arrived and isn't done */
function nextActionable(): Sched | null {
  const now = Date.now();
  return schedule.find((e) =>
    now >= e.start - joinEarlyMs() && now < e.end && !handled.has(e.title)
    && !attendedToday().includes(e.title) // one session per title per day — no auto-rejoin (manual /join recovers)
  ) ?? null;
}

/** Record + watch + stop for an already-joined meeting (both join paths).
 *  hardEndMs: scheduled end — the watch loop also exits at end+15min (safety
 *  cap for a meeting whose UI never dies), but never sooner than 10min in
 *  (a manual join right at/after the listed end still gets a real session). */
async function attendAndRecord(page: import("playwright").Page, title: string, joinUrl?: string, endMs?: number): Promise<void> {
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
    const leftRequested = leaveRequested; // capture why this session ended (manual vs natural)
    if (leaveRequested) {
      pushEvent(`leave requested — wrapping up ${title}`);
      console.log("[daemon] leave requested via UI");
      recordLeftToday(title); // persist: no auto re-join for the rest of today
      handled.add(title);
      leaveRequested = false;
      // immediate webhook — consolidation/transcription continue in background
      void notify(`🚪 Left **${title}** (manual leave) — consolidating & transcribing in background`).catch(() => {});
    }
    try {
      // quick stop (~2s): stops MediaRecorder + flushes audio, then LEAVE immediately
      const handle = await quickStopRecording(page);
      if (handle) {
        // close the browser tab NOW — leave the meeting instantly
        await page.close().catch(() => {});
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
    handled.add(title);
    leaveRequested = false;
  }
  // session complete — terminal for the day (no auto-rejoin; manual /join
  // or the next schedule window is the recovery path)
  handled.add(title);
  journalEntry(title, { leftAt: Date.now() });
  active = null;
  // persistent browser: this flow OWNS the meeting page — always close it
  // (covers recording-never-started and stop-failed paths; the success path
  // already closed it and the double-close is swallowed)
  await page.close().catch(() => {});
}

function startController(): void {
  // manually-left meetings (today) are seeded into `handled` so a restart
  // doesn't auto-join them again — manual Join via /join still overrides
  for (const t of loadLeftToday()) handled.add(t);
  const server = createServer(async (req, res) => {
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
          for (const f of readdirSync(fromR)) {
            if (mine.test(f)) { renameSync(join(fromR, f), join(toR, f)); moved++; }
          }
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
                if (["__notes.md", "__running.md", "__timeline.json", "__transcript.md"].some((s) => f === `${base}${s}`)) { renameSync(join(fromN, f), join(toN, f)); moved++; }
              }
            } catch { /* dir absent */ }
          }
          try { rebuildIndex(); } catch { /* index optional */ }
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
            if (["__notes.md", "__running.md", "__timeline.json", "__transcript.md"].some((s) => f === `${base}${s}`)) rm(join(ndir, f));
          }
        } catch { /* dir absent */ }
      }
      try { rebuildIndex(); } catch { /* index optional */ }
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
          const title = realStem.replace(/^\d{4}-\d{2}-\d{2}__/, "").replace(/__T?\d{6}$/, "").replace(/_/g, " ");
          // file under the course the USER clicked — never re-parse the title
          // (a filename-derived title files under a bogus slug like
          // testing_autoschool_180137)
          const ci = { code: "MAP", slug: course, name: course.replace(/_/g, " ") };
          const dir = courseDir(ci);
          const paths = { course: ci, dir, stem: realStem,
            notesMd: join(dir, `${realStem}__notes.md`),
            runningMd: join(dir, `${realStem}__running.md`),
            timelineJson: join(dir, `${realStem}__timeline.json`) };
          writeFileSync(join(dir, `${realStem}__transcript.md`), `# Transcript — ${title}\n\n${t.text}`);
          pushEvent(`transcribe ✓ ${course}/${stem} — ${t.chunks.length} chunk(s) → transcript.md`);
          if (!existsSync(paths.notesMd)) {
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
      const MAP = join(dirname(config.userDataDir), "mapping.json");
      const readMap = (): Record<string, string> => { try { return JSON.parse(readFileSync(MAP, "utf8")); } catch { return {}; } };
      if (req.method === "GET") return send(200, readMap());
      if (req.method === "PUT") {
        const body = await new Promise<Record<string, unknown>>((res) => {
          let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } });
        });
        const t = String(body.title ?? "").trim();
        const f = String(body.folder ?? "").trim().replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_");
        if (!t || !f) return send(400, { error: "title and folder required" });
        const m = readMap();
        const created = !existsSync(join(NOTES_DIR, f)) && !existsSync(join(RECORDINGS_DIR, f));
        m[t] = f;
        try { writeFileSync(MAP, JSON.stringify(m, null, 2) + "\n"); } catch (e) { return send(500, { error: `write failed: ${String(e).slice(0, 80)}` }); }
        try { mkdirSync(join(NOTES_DIR, f), { recursive: true }); } catch { /* next write creates it */ }
        pushEvent(`mapping: "${t}" → ${f}${created ? " (folder created)" : ""}`);
        return send(200, { ok: true, mapping: m, created });
      }
      if (req.method === "DELETE") {
        const t = url.searchParams.get("title")?.trim();
        if (!t) return send(400, { error: "title required" });
        const m = readMap();
        if (!(t in m)) return send(404, { error: "not mapped" });
        delete m[t];
        try { writeFileSync(MAP, JSON.stringify(m, null, 2) + "\n"); } catch { /* ro */ }
        return send(200, { ok: true, mapping: m });
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
        let wroteTranscript = false;
        if (tfileP) {
          const txt = (await import("node:fs/promises")).readFile(tfileP.path!, "utf8");
          writeFileSync(join(NOTES_DIR, course, `${stem}__transcript.md`),
            `# Transcript — ${course.replace(/_/g, " ")} (${date})\n\n${await txt}`);
          discardPart(tfileP.path!);
          wroteTranscript = true;
        }
        pushEvent(`ingest: ${mp4name} (${((fileP?.bytes ?? 0) / 1e6).toFixed(0)} MB)${wroteTranscript ? " + uploaded transcript" : ""}`);
        return send(200, { ok: true, mp4: mp4name, stem, date, course, transcript: wroteTranscript });
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
    // ── course materials (upload / list / delete) + course config ─────
    const MATERIALS_RE = /^\/courses\/([^/]+)\/materials$/;
    const mm = url.pathname.match(MATERIALS_RE);
    if (mm) {
      const slug = decodeURIComponent(mm[1]);
      if (req.method === "GET") return send(200, { materials: listMaterials(slug) });
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
            if (!rel || !leaf || leaf === "materials.json") {
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
        // meeting→folder mappings follow the rename
        const MAP = join(dirname(config.userDataDir), "mapping.json");
        try {
          const m = JSON.parse(readFileSync(MAP, "utf8")) as Record<string, string>;
          let remapped = 0;
          for (const k of Object.keys(m)) if (m[k] === from) { m[k] = to; remapped++; }
          if (remapped) writeFileSync(MAP, JSON.stringify(m, null, 2));
        } catch { /* no mapping file */ }
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
        pushEvent(`course created: ${slug}${s ? ` (semester starts ${s})` : ""}`);
        return send(200, { ok: true, slug });
      } catch (e) {
        return send(500, { error: `create failed: ${String(e).slice(0, 120)}` });
      }
    }
    // ── deadlines (AI-built calendar of due dates + spread-out items) ──
    if (url.pathname === "/deadlines") {
      const DEADLINES = join(config.userDataDir, "deadlines.json");
      type Dl = { id: string; course: string; title: string; due: string | null; kind: string; spread: boolean; startBy: string | null; note: string; source: string; confidence: string; done: boolean; doneAt: number | null; userNote?: string; dueManual?: boolean; stale?: number; parts?: { title: string; due: string | null; note: string; done: boolean }[] };
      const readDl = (): Dl[] => {
        try {
          const j = JSON.parse(readFileSync(DEADLINES, "utf8"));
          if (!Array.isArray(j)) return [];
          // backfill ids/done for files written before those fields existed
          const dl = j.map((d: Partial<Dl>) => ({ done: false, doneAt: null, ...d, id: d.id ?? dlId(String(d.course ?? ""), String(d.title ?? "")) }) as Dl);
          const before = dl.map((x) => x.id).join("\u0000");
          uniqIds(dl);
          if (dl.map((x) => x.id).join("\u0000") !== before) writeDl(dl); // self-heal legacy duplicate ids on first touch
          return dl;
        } catch { return []; }
      };
      const dlKey = (c: string, t: string): string => `${c}|${t.toLowerCase().trim()}`;
      const dlId = (c: string, t: string): string => { // stable: same course+title → same id
        let h = 5381;
        for (const ch of dlKey(c, t)) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
        return h.toString(16);
      };
      /** enforce unique ids IN PLACE — duplicate ids (same course+title twice
       *  in one build, or a hash collision) break every by-id lookup AND the
       *  UI's React keys (rows bleed across tabs until a hard refresh).
       *  First occurrence wins; later ones get a deterministic ~N suffix. */
      const uniqIds = (d: Dl[]): Dl[] => {
        const seen = new Set<string>();
        for (const x of d) {
          if (!x.id || seen.has(x.id)) {
            let n = 1;
            while (seen.has(`${x.id}~${n}`)) n++;
            x.id = `${x.id}~${n}`;
          }
          seen.add(x.id);
        }
        return d;
      };
      const writeDl = (d: Dl[]): void => { mkdirSync(config.userDataDir, { recursive: true }); writeFileSync(DEADLINES, JSON.stringify(uniqIds(d), null, 2)); };
      // ── sub-task folding: "A1 Part A" → checklist step of "Assignment 1" ──
      // LLM decides parent/child (see the rebuild pipeline); the fold itself is
      // deterministic so re-folds after checklist regeneration stay stable.
      const FOLDS = join(config.userDataDir, "deadlines-folds.json");
      type FoldSug = { parentId: string; parentTitle: string; childId: string; childTitle: string; childDue: string | null };
      // verdicts remember the user's decision AND the parent they chose — so
      // rebuilds re-bind to the user's fold, not the LLM's next nomination.
      // folded[] are tombstones: enough state to UNFOLD (restore the child,
      // remove exactly the steps the fold added, revert the enrichment).
      type Verdict = { v: "accepted" | "declined"; parent?: string; parentTitle?: string };
      type Tomb = { child: Dl; parentId: string; parentKey: string; parentTitle: string; addedItemIds: string[]; enriched?: { itemId: string; prevText: string; prevDone: boolean }; partTitles?: string[]; at: number };
      type FoldsFile = { verdicts: Record<string, Verdict>; pending: FoldSug[]; folded: Record<string, Tomb> };
      const readFolds = (): FoldsFile => {
        try {
          const j = JSON.parse(readFileSync(FOLDS, "utf8"));
          const verdicts: Record<string, Verdict> = {};
          for (const [k, val] of Object.entries<Verdict | string>(j.verdicts ?? {})) verdicts[k] = typeof val === "string" ? { v: val as "accepted" | "declined" } : val; // legacy string verdicts
          return { verdicts, pending: Array.isArray(j.pending) ? j.pending : [], folded: j.folded ?? {} };
        } catch { return { verdicts: {}, pending: [], folded: {} }; }
      };
      const writeFolds = (f: FoldsFile): void => writeFileSync(FOLDS, JSON.stringify({ ...f, updatedAt: Date.now() }, null, 2));
      const foldChildInto = (parent: Dl, child: Dl): { steps: number; addedItemIds: string[]; enriched?: { itemId: string; prevText: string; prevDone: boolean }; partTitles?: string[] } => {
        const CKS = join(config.userDataDir, "checklists.json");
        type CkItem = { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean };
        type Ck = { deadlineId: string; course: string; title: string; items: CkItem[]; updatedAt: number };
        let cks: Ck[] = [];
        try { const j = JSON.parse(readFileSync(CKS, "utf8")); if (Array.isArray(j)) cks = j; } catch { /* none */ }
        const childCkIdx = cks.findIndex((c) => c.deadlineId === child.id);
        const childSteps = childCkIdx >= 0 ? cks[childCkIdx]!.items : [];
        const pc = cks.find((c) => c.deadlineId === parent.id);
        const label = (child.title.match(/\b(?:part|phase|section|component|stage)\s+[a-z0-9]+\b/i)?.[0] ?? child.title.split(/[:\u2014-]/)[0] ?? child.title).trim().slice(0, 40);
        const dueTag = child.due && child.due !== parent.due ? ` (due ${child.due})` : "";
        if (!parent.userNote && child.userNote) parent.userNote = child.userNote;
        if (childCkIdx >= 0) cks.splice(childCkIdx, 1); // the child's checklist folds in / goes away
        if (!pc) {
          // no checklist yet — remember the parts; the next generation MUST
          // include them as steps (prompt reads deadline.parts)
          const partTitles = [child.title, ...childSteps.map((s) => s.text)];
          parent.parts = [...(parent.parts ?? []), ...partTitles.map((t, i) => ({ title: t, due: i === 0 ? child.due : null, note: i === 0 ? child.note : "", done: i === 0 ? child.done : childSteps[i - 1]!.done }))];
          writeFileSync(CKS, JSON.stringify(cks, null, 2));
          return { steps: 0, addedItemIds: [], partTitles };
        }
        const toks = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 1));
        const over = (a: Set<string>, b: Set<string>): number => { if (!a.size || !b.size) return 0; let hit = 0; for (const w of a) if (b.has(w)) hit++; return hit / Math.min(a.size, b.size); };
        const ct = toks(child.title);
        const mkItem = (text: string, done: boolean): CkItem => {
          let h = 5381;
          for (const ch of `${parent.id}|${text.toLowerCase().trim()}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
          return { id: h.toString(16), text: text.slice(0, 200), done, doneAt: done ? (child.doneAt ?? Date.now()) : null };
        };
        // idempotency: same text already folded → nothing to do
        if (pc.items.some((it) => it.text === `${child.title}${dueTag}`.slice(0, 200))) { writeFileSync(CKS, JSON.stringify(cks, null, 2)); return { steps: 0, addedItemIds: [] }; }
        let mi = -1, ms = 0;
        pc.items.forEach((it, i) => { const s = over(ct, toks(it.text)); if (s > ms) { ms = s; mi = i; } });
        const addedItemIds: string[] = [];
        let enriched: { itemId: string; prevText: string; prevDone: boolean } | undefined;
        if (mi >= 0 && ms >= 0.5) {
          // existing step covers this part → enrich it, don't duplicate
          const it = pc.items[mi]!;
          enriched = { itemId: it.id, prevText: it.text, prevDone: it.done };
          it.done = it.done || child.done;
          if (dueTag && !/due \d{4}/.test(it.text)) it.text = `${it.text}${dueTag}`.slice(0, 200);
          const added = childSteps.map((s) => mkItem(`${label}: ${s.text}`, s.done));
          addedItemIds.push(...added.map((a) => a.id));
          pc.items.splice(mi + 1, 0, ...added);
        } else {
          const newText = `${child.title}${dueTag}`;
          let at = pc.items.length;
          let last = -1;
          pc.items.forEach((it, i) => { if (over(ct, toks(it.text)) >= 0.25) last = i; });
          if (last >= 0) at = last + 1; // group with sibling steps of this part
          else if (pc.items.length > 1 && /submit|upload|hand in|post\b|verify|review/i.test(pc.items[pc.items.length - 1]!.text)) at = pc.items.length - 1; // before the final submit-ish step
          const fresh = mkItem(newText, child.done);
          const added = [fresh, ...childSteps.map((s) => mkItem(`${label}: ${s.text}`, s.done))];
          addedItemIds.push(...added.map((a) => a.id));
          pc.items.splice(at, 0, ...added);
        }
        pc.updatedAt = Date.now();
        writeFileSync(CKS, JSON.stringify(cks, null, 2));
        return { steps: 1 + childSteps.length, addedItemIds, enriched };
      };
      if (req.method === "GET") {
        const dl = readDl();
        const ids = new Set(dl.map((d) => d.id));
        const f = readFolds();
        const foldedChildren = Object.entries(f.folded)
          .filter(([, t]) => ids.has(t.parentId))
          .map(([key, t]) => ({ key, parentId: t.parentId, parentTitle: t.parentTitle ?? "", title: t.child.title, due: t.child.due, done: t.child.done, at: t.at }));
        return send(200, { deadlines: dl, suggestions: f.pending.filter((p) => ids.has(p.childId) && ids.has(p.parentId)), foldedChildren });
      }
      if (req.method === "DELETE") {
        try { rmSync(DEADLINES, { force: true }); } catch { /* gone */ }
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
              const dl = readDl();
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
              writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            if (typeof body.id === "string" && (body.delete === true || body.remove === true)) {
              // remove one entry — stale zombies the UI flags ("not in source")
              const dl = readDl();
              const i = dl.findIndex((d) => d.id === body.id);
              if (i < 0) return send(404, { error: "no such deadline id" });
              const [gone] = dl.splice(i, 1);
              writeDl(dl);
              return send(200, { ok: true, deleted: gone?.title ?? "", deadlines: dl });
            }
            // ── fold a sub-task into a parent's checklist (manual pick, or a
            //    suggestion accepted) — the verdict remembers the chosen parent
            //    so rebuilds re-bind to the USER's fold, not the LLM's pick ──
            if ((body.fold || body.acceptFold) && typeof (body.fold ?? body.acceptFold) === "object") {
              const { parent: pid, child: cid } = (body.fold ?? body.acceptFold) as { parent?: string; child?: string };
              const dl = readDl();
              const parent = dl.find((d) => d.id === pid);
              const child = dl.find((d) => d.id === cid);
              if (!parent || !child || parent.id === child.id) return send(404, { error: "no such parent/child id" });
              if (parent.course !== child.course) return send(400, { error: "can only fold within the same course" });
              if (parent.done) return send(400, { error: "can't fold into a done deadline" });
              const key = dlKey(child.course, child.title);
              const det = foldChildInto(parent, child);
              const f = readFolds();
              f.verdicts[key] = { v: "accepted", parent: dlKey(parent.course, parent.title), parentTitle: parent.title };
              f.folded[key] = { child: { ...child }, parentId: parent.id, parentKey: dlKey(parent.course, parent.title), parentTitle: parent.title, addedItemIds: det.addedItemIds, enriched: det.enriched, partTitles: det.partTitles, at: Date.now() };
              f.pending = f.pending.filter((p) => p.childId !== child.id);
              writeFolds(f);
              const out = dl.filter((d) => d.id !== child.id);
              writeDl(out);
              pushEvent(`deadlines: folded "${child.title}" into "${parent.title}" (${det.steps} step(s))`);
              return send(200, { ok: true, folded: det.steps, deadlines: out });
            }
            // ── unfold: restore a folded child; remove exactly the steps the
            //    fold added and revert any enrichment (tombstone-driven) ──
            if (body.unfold && typeof body.unfold === "object") {
              const key = String((body.unfold as { key?: string }).key ?? "");
              const f = readFolds();
              const t = f.folded[key];
              if (!t) return send(404, { error: "no such folded entry" });
              const CKS2 = join(config.userDataDir, "checklists.json");
              let cks: { deadlineId: string; items: { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean }[]; updatedAt: number }[] = [];
              try { const j = JSON.parse(readFileSync(CKS2, "utf8")); if (Array.isArray(j)) cks = j; } catch { /* none */ }
              const pc = cks.find((c) => c.deadlineId === t.parentId);
              if (pc) {
                if (t.addedItemIds.length) pc.items = pc.items.filter((it) => !t.addedItemIds.includes(it.id));
                if (t.enriched) {
                  const e = pc.items.find((it) => it.id === t.enriched!.itemId);
                  if (e) { e.text = t.enriched.prevText; e.done = t.enriched.prevDone; e.doneAt = e.done ? (e.doneAt ?? Date.now()) : null; }
                }
                pc.updatedAt = Date.now();
                writeFileSync(CKS2, JSON.stringify(cks, null, 2));
              }
              const dl = readDl();
              const parent = dl.find((d) => d.id === t.parentId);
              if (parent && t.partTitles?.length) {
                const rm = new Set(t.partTitles);
                parent.parts = (parent.parts ?? []).filter((p) => !rm.has(p.title));
                if (!parent.parts.length) delete parent.parts;
              }
              dl.push({ ...t.child }); // resurrect — writeDl's uniqIds guards id clashes
              delete f.verdicts[key];
              delete f.folded[key];
              writeFolds(f);
              writeDl(dl);
              pushEvent(`deadlines: unfolded "${t.child.title}" back out of "${parent?.title ?? t.parentId}"`);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── decline: never suggest this fold again (by course+title) ──
            if (body.declineFold && typeof body.declineFold === "object") {
              const cid = String((body.declineFold as { child?: string }).child ?? "");
              const dl = readDl();
              const child = dl.find((d) => d.id === cid);
              const f = readFolds();
              if (child) f.verdicts[dlKey(child.course, child.title)] = { v: "declined" };
              f.pending = f.pending.filter((p) => p.childId !== cid);
              writeFolds(f);
              return send(200, { ok: true, deadlines: dl });
            }
            if (typeof body.id === "string" && body.userNote === undefined) {
              const dl = readDl();
              const it = dl.find((d) => d.id === body.id);
              if (!it) return send(404, { error: "no such deadline id" });
              it.done = body.done !== false; // default true; explicit false un-checks
              it.doneAt = it.done ? Date.now() : null;
              writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── student context note (group members, roles, …) by id ──
            if (typeof body.id === "string" && typeof body.userNote === "string") {
              const dl = readDl();
              const it = dl.find((d) => d.id === body.id);
              if (!it) return send(404, { error: "no such deadline id" });
              const v = body.userNote.trim().slice(0, 2000);
              if (v) it.userNote = v; else delete it.userNote; // empty clears
              writeDl(dl);
              return send(200, { ok: true, deadlines: dl });
            }
            // ── rebuild: LLM sweep → JSON; full, or incremental (changed docs only) ──
            const mode: "full" | "update" = body.mode === "full" ? "full" : "update";
            // manifest: mtime+size of every course document at last build —
            // a stat walk (no LLM) tells us exactly what changed since
            const META = join(config.userDataDir, "deadlines-meta.json");
            type DocStat = { m: number; s: number };
            const readMeta = (): { docs: Record<string, DocStat> } => { try { return JSON.parse(readFileSync(META, "utf8")); } catch { return { docs: {} }; } };
            const snapshotDocs = (): Record<string, DocStat & { course: string }> => {
              const out: Record<string, DocStat & { course: string }> = {};
              for (const c of allCourses()) {
                const root = join(DATA_DIR, "courses", c, "materials");
                const walk = (rel: string): void => {
                  let names: string[] = [];
                  try { names = readdirSync(join(root, rel)); } catch { return; }
                  for (const n of names.sort()) {
                    if (n === "materials.json") continue;
                    const child = rel ? `${rel}/${n}` : n;
                    let st;
                    try { st = statSync(join(root, child)); } catch { continue; }
                    if (st.isDirectory()) walk(child);
                    else out[`${c}/${child}`] = { m: Math.round(st.mtimeMs), s: st.size, course: c };
                  }
                };
                walk("");
              }
              return out;
            };
            const prevMeta = readMeta();
            const changedDocs = new Map<string, string[]>(); // slug → rel paths changed/new
            const deletedKeys = new Set<string>();           // manifest keys whose file is gone
            let scoped = false;
            if (mode === "update" && readDl().length > 0 && Object.keys(prevMeta.docs).length > 0) {
              const cur = snapshotDocs();
              for (const [k, v] of Object.entries(cur)) {
                const p = prevMeta.docs[k];
                if (!p || p.m !== v.m || p.s !== v.s) changedDocs.set(v.course, [...(changedDocs.get(v.course) ?? []), k.slice(v.course.length + 1)]);
              }
              for (const k of Object.keys(prevMeta.docs)) if (!cur[k]) deletedKeys.add(k);
              if (changedDocs.size === 0 && deletedKeys.size === 0) {
                return send(200, { ok: true, mode: "update", count: readDl().length, added: [], changed: 0 });
              }
              scoped = true; // baseline exists → only rescan what moved
            }
            const scopeText = scoped ? `
This is an INCREMENTAL update — only these documents changed since the last full build (course slug → paths under materials/):
${[...changedDocs].map(([c, docs]) => `- ${c}: ${docs.join(", ")}`).join("\n")}
Read ONLY these documents (list_courses first to resolve slugs). Re-extract every deadline item each changed document defines — one entry per item, exact dates as before. Do NOT output items from unchanged documents; the rest of the calendar is already correct.`
: `Explore with tools first: list_courses, then week_overview / list_materials / read_document on anything likely to carry due dates (syllabi, intro/summary sheets, exercise and lab docs, course configs). Read enough to pin dates down; skim, don't quote.`;
            const systemPrompt = `You build the student's DEADLINE CALENDAR across ALL courses from the real files — never invent dates.
${scopeText}
JSON schedule files (quizzes.json, discussions.json, …) carry EXACT per-item due dates — always read them fully and emit ONE entry per item with its date; NEVER lump recurring weekly work (quizzes, discussion posts) into a single undated umbrella entry when individual dates exist.
Long text/JSON documents are served page by page (~12k characters per page). If a read ends with "…(truncated — request specific pages)", keep reading the remaining pages with read_document's page argument until you have seen the WHOLE file — never extract items from a partial read.
Then reply with ONLY a JSON array (no prose, no markdown fences), one object per task:
{"course": exact slug from list_courses, "title": short task name, "due": "YYYY-MM-DD" or null, "kind": "assignment"|"lab"|"reading"|"install"|"signup"|"post"|"quiz"|"exam"|"other", "spread": true if worth spreading out / starting early (installs, long projects, readings) else false, "startBy": "YYYY-MM-DD" or null, "note": "≤120 chars, key detail", "source": "exact file name or session stem", "confidence": "high"|"medium"|"low"}
Include hard deadlines AND soft/spread-out items. If a date is uncertain use confidence "low". Today is ${new Date().toISOString().slice(0, 10)}.`;
            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt },
              { role: "user", content: scoped ? `Update the deadline calendar now: read exactly the changed documents listed above, then output ONLY the JSON array of items they define.` : `Build the deadline calendar now. Explore the courses with tools, then output ONLY the JSON array.` },
            ];
            let raw = "";
            for (let step = 0; step < (scoped ? 18 : 26); step++) {
              const msg = await glmChatRaw(convo, TOOL_DEFS);
              if (msg.tool_calls?.length) {
                convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
                for (const tc of msg.tool_calls) {
                  const result = await runTool(tc);
                  pushEvent(`deadline tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
                  convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 52_000) });
                }
                continue;
              }
              raw = msg.content;
              break;
            }
            // tolerate fences / stray prose around the array
            const m = raw.match(/\[[\s\S]*\]/);
            if (!m) return send(500, { error: `model produced no JSON array: ${raw.slice(0, 120)}` });
            let items: unknown[];
            try { items = JSON.parse(m[0]); } catch (e) {
              return send(500, { error: `JSON parse failed: ${String(e).slice(0, 120)}` });
            }
            if (!Array.isArray(items) || !items.length) return send(500, { error: "empty deadline list" });
            // normalize: real course slugs, valid-ish dates, stable ids;
            // done-ness carries over from the previous build (by course+title)
            const slugs = allCourses();
            const prev = readDl();
            // ── fuzzy identity: the same real task can come back under a
            // different title next build ("Discussion: Wk3 Q1" vs "Week 3 -
            // Question One") — normalize + abbreviation-expand for matching
            const normTitle = (t: string): string =>
              t.toLowerCase().replace(/&/g, " and ")
                .replace(/\bwk\s*/g, "week ").replace(/\bw(\d+)\b/g, "week $1")
                .replace(/\bq\s*(\d+)\b/g, "question $1")
                .replace(/#/g, " ")
                .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
                  (mm) => String(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"].indexOf(mm) + 1))
                .replace(/\bquiz(zes)?\b/g, "quiz").replace(/\bdiscussions?\b/g, "discussion")
                .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
            const tokensOf = (t: string): Set<string> => new Set(normTitle(t).split(" ").filter((w) => w.length > 1));
            const sim = (a: string, b: string): number => {
              const A = tokensOf(a), B = tokensOf(b);
              if (!A.size || !B.size) return 0;
              let hit = 0;
              for (const w of A) if (B.has(w)) hit++;
              return hit / Math.min(A.size, B.size); // containment of the smaller
            };
            // numbers in titles are strong identity (Q1 vs Q2): every digit in
            // one title must appear in the other for a match
            const digitsOk = (a: string, b: string): boolean => {
              const d = (t: string) => new Set(normTitle(t).match(/\d+/g) ?? []);
              const A = d(a), B = d(b);
              if (!A.size || !B.size) return true;
              const [sm, bg] = A.size <= B.size ? [A, B] : [B, A];
              for (const n of sm) if (!bg.has(n)) return false;
              return true;
            };
            const RANGE = /\d\s*[-\u2013]\s*#?\s*\d/; // "#1-#11" umbrellas never re-match
            const sameTask = (a: string, b: string): boolean =>
              !RANGE.test(a) && !RANGE.test(b) && digitsOk(a, b) && sim(a, b) >= 0.5;
            const norm = items
              .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
              .map((it): Dl => ({
                id: "", // filled by carry-over / dedupe below
                course: slugs.includes(String(it.course)) ? String(it.course) : String(it.course ?? ""),
                title: String(it.title ?? "(untitled)").slice(0, 140),
                due: /^\d{4}-\d{2}-\d{2}$/.test(String(it.due ?? "")) ? String(it.due) : null,
                kind: ["assignment", "lab", "reading", "install", "signup", "post", "quiz", "exam", "other"].includes(String(it.kind)) ? String(it.kind) : "other",
                spread: Boolean(it.spread),
                startBy: /^\d{4}-\d{2}-\d{2}$/.test(String(it.startBy ?? "")) ? String(it.startBy) : null,
                note: String(it.note ?? "").slice(0, 160),
                source: String(it.source ?? "").slice(0, 160),
                confidence: ["high", "medium", "low"].includes(String(it.confidence)) ? String(it.confidence) : "medium",
                done: false,
                doneAt: null,
              }) satisfies Dl)
              .filter((it) => slugs.includes(it.course));
            // ── incremental split: prev entries sourced from CHANGED/DELETED
            // docs are up for re-extraction; everything else is kept verbatim
            const baseOf = (p: string): string => p.split("/").pop() ?? p;
            const touchedKeys = new Set<string>(); // "course|basename"
            if (scoped) {
              for (const [c, docs] of changedDocs) for (const d of docs) touchedKeys.add(`${c}|${baseOf(d)}`);
              for (const k of deletedKeys) touchedKeys.add(`${k.split("/")[0]}|${baseOf(k)}`);
            }
            const isTouched = (p: Dl): boolean => p.source.split(";").some((s) => touchedKeys.has(`${p.course}|${baseOf(s.trim())}`)); // merged entries can carry "a.pdf; b.json"
            const kept = scoped ? prev.filter((p) => !isTouched(p)) : [];
            // ── carry-over: inherit id/done/userNote from the previous build's
            // same task (exact key first, then fuzzy) — id stability is what
            // keeps checklists attached across rebuilds. Scoped mode only
            // matches against touched entries (kept ones stay verbatim).
            const pool = (scoped ? prev.filter(isTouched) : prev).filter((p) => !RANGE.test(p.title));
            const updatedDates: { course: string; title: string; due: string | null; was: string | null }[] = [];
            for (const it of norm) {
              const exact = pool.find((p) => p.course === it.course && dlKey(p.course, p.title) === dlKey(it.course, it.title));
              if (exact) {
                it.id = exact.id; it.done = exact.done; it.doneAt = exact.doneAt;
                if (exact.userNote) it.userNote = exact.userNote;
                if (exact.dueManual) { it.due = exact.due; it.startBy = exact.startBy; it.dueManual = true; it.confidence = "high"; }
                else if (exact.due !== it.due) updatedDates.push({ course: it.course, title: it.title, due: it.due, was: exact.due });
                pool.splice(pool.indexOf(exact), 1);
                continue;
              }
              let bi = -1, bs = 0;
              for (let i = 0; i < pool.length; i++) {
                const p = pool[i];
                if (p.course !== it.course || p.kind !== it.kind) continue;
                const sameDue = p.due === it.due;
                // manual dates shouldn't block identity — the whole point of the
                // override is that it differs from what the documents say.
                // Same for a re-scan citing the SAME source file: same task,
                // new date = the document was edited (due date moved), not a
                // new task — otherwise every date change spawns a stale zombie.
                const srcsOf = (p: string): Set<string> => new Set(p.split(";").map((s) => baseOf(s.trim())).filter(Boolean));
                const sameSource = !!p.source && !!it.source && [...srcsOf(p.source)].some((s) => srcsOf(it.source).has(s));
                if (!sameDue && p.due && it.due && !p.dueManual && !sameSource) continue; // both dated, different days, different files → different tasks
                const sv = sim(p.title, it.title) * (sameDue ? 1 : 0.85);
                const need = sameDue ? 0.5 : 0.7;
                if (sv > bs && sv >= need && sameTask(p.title, it.title)) { bs = sv; bi = i; }
              }
              if (bi >= 0) {
                const p = pool.splice(bi, 1)[0];
                if (p.due !== it.due && !p.dueManual) updatedDates.push({ course: it.course, title: it.title, due: it.due, was: p.due });
                it.id = p.id; it.done = p.done; it.doneAt = p.doneAt;
                if (p.userNote) it.userNote = p.userNote;
                if (p.dueManual) { it.due = p.due; it.startBy = p.startBy; it.dueManual = true; it.confidence = "high"; }
              }
            }
            // fresh ids for anything unmatched — these are the NEW items
            const freshIds = new Set<string>();
            for (const it of norm) if (!it.id) { it.id = dlId(it.course, it.title); freshIds.add(it.id); }
            // ── dedupe within this build: same course + kind + due + similar
            // title from two sources → keep the first (higher in the model's list)
            for (let i = 0; i < norm.length; i++) {
              for (let j = norm.length - 1; j > i; j--) {
                const a = norm[i], b = norm[j];
                if (a.course === b.course && a.kind === b.kind && a.due === b.due && sameTask(a.title, b.title)) {
                  if (!a.userNote && b.userNote) a.userNote = b.userNote; // never lose a note
                  norm.splice(j, 1);
                }
              }
            }
            // ── incremental cross-dedupe: an extracted item that duplicates a
            // KEPT entry (same task, same day) loses to the kept one — its
            // id/done/notes/checklists are the stable identity
            if (scoped) {
              outer: for (let i = norm.length - 1; i >= 0; i--) {
                const a = norm[i];
                for (const k of kept) {
                  if (a.course === k.course && a.kind === k.kind && a.due === k.due && sameTask(a.title, k.title)) { norm.splice(i, 1); continue outer; }
                }
              }
            }
            let merged: Dl[];
            if (scoped) {
              // touched entries the rescan no longer found: KEEP them (never
              // silently drop a deadline the student may know about) but flag
              // stale so the UI/chat can surface it
              const now = Date.now();
              for (const p of pool) { p.stale = p.stale ?? now; norm.push(p); }
              merged = [...kept, ...norm];
            } else {
              // full rebuild re-saw everything → stale flags are obsolete;
              // checked-off items the new build no longer finds still persist
              for (const it of norm) delete it.stale;
              for (const p of pool) if (p.done) norm.push(p);
              merged = norm;
            }
            merged.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.course.localeCompare(b.course));
            uniqIds(merged); // duplicate ids break by-id lookups + the UI's React keys
            // ── semantic dedup (LLM, deliberately conservative): same course +
            // kind + similar-title pairs the deterministic passes kept ONLY
            // because their dates disagree — ask the model whether they're
            // really one task. Merge only on same=true + confidence high. ──
            let semanticMerged = 0;
            const dupePairs: [Dl, Dl][] = [];
            for (let i = 0; i < merged.length; i++) {
              for (let j = i + 1; j < merged.length && dupePairs.length < 20; j++) {
                const a = merged[i]!, b = merged[j]!;
                if (a.course !== b.course || a.kind !== b.kind) continue;
                if (a.due === b.due) continue; // same-date dupes were already deduped deterministically
                if (sameTask(a.title, b.title)) dupePairs.push([a, b]);
              }
            }
            if (dupePairs.length) {
              try {
                const pairText = dupePairs
                  .map(([a, b], i) => `PAIR ${i + 1}:\nA: ${JSON.stringify({ title: a.title, due: a.due, startBy: a.startBy, note: a.note, source: a.source, manual: !!a.dueManual })}\nB: ${JSON.stringify({ title: b.title, due: b.due, startBy: b.startBy, note: b.note, source: b.source, manual: !!b.dueManual })}`)
                  .join("\n\n");
                const raw2 = await glmChatRaw([
                  { role: "system", content: `You deduplicate a student's deadline calendar. Each PAIR holds two entries extracted from different course documents. Decide whether both describe the SAME real task (one assignment/quiz/exam/post extracted twice, with wording or date conflicts) or two DIFFERENT tasks.
STRICT — only answer same=true with confidence "high" when you are certain: same task number AND same subject matter. "Assignment 1" vs "Assignment 1: Spring MVC car insurance app" = same. "Assignment 1" vs "Assignment 2", or "Week 3 discussion" vs "Week 4 discussion" = different. When in doubt, answer same=false.
For pairs you judge same, also pick the best evidence: due/startBy as "A", "B" or "none" (prefer the more specific and more recent source; a dated entry beats an undated one; never pick the side that is NOT manual if the other IS), a merged short title, and a merged note (≤160 chars, keep the most specific detail).
Reply with ONLY a JSON array, one object per pair in order: {"pair": <number>, "same": boolean, "confidence": "high"|"medium"|"low", "due": "A"|"B"|"none", "startBy": "A"|"B"|"none", "title": string, "note": string}` },
                  { role: "user", content: pairText },
                ]);
                const m2 = raw2.content.match(/\[[\s\S]*\]/);
                const verdicts: { pair: number; same: boolean; confidence: string; due?: string; startBy?: string; title?: string; note?: string }[] = m2 ? JSON.parse(m2[0]) : [];
                const removed = new Set<Dl>();
                for (const v of verdicts) {
                  if (v.same !== true || v.confidence !== "high") continue; // conservative: only certain merges
                  const pr = dupePairs[Number(v.pair) - 1];
                  if (!pr || removed.has(pr[0]) || removed.has(pr[1])) continue;
                  const [a, b] = pr; // keep a — its id keeps checklists/done attached
                  if (!a.dueManual && !b.dueManual) {
                    if (v.due === "B") a.due = b.due;
                    else if (v.due === "none") a.due = null;
                    if (v.startBy === "B") a.startBy = b.startBy;
                    else if (v.startBy === "none") a.startBy = null;
                  }
                  if (v.title) a.title = String(v.title).slice(0, 140);
                  if (v.note) a.note = String(v.note).slice(0, 160);
                  if (!a.userNote && b.userNote) a.userNote = b.userNote;
                  a.done = a.done || b.done;
                  if (a.done && !a.doneAt) a.doneAt = b.doneAt;
                  a.confidence = "high";
                  // keep BOTH source names: incremental scans key off them
                  a.source = [...new Set([...a.source.split(";"), ...b.source.split(";")].map((s) => s.trim()).filter(Boolean))].join("; ").slice(0, 200);
                  removed.add(b);
                  semanticMerged++;
                }
                if (removed.size) merged = merged.filter((d) => !removed.has(d));
                if (semanticMerged) pushEvent(`deadlines dedup: merged ${semanticMerged} duplicate pair${semanticMerged === 1 ? "" : "s"} (semantic check)`);
              } catch (e) {
                pushEvent(`deadlines dedup skipped: ${String(e).slice(0, 100)}`); // keep both — never block the rebuild
              }
            }
            // ── parent/child detection (LLM): sub-deliverables of a bigger
            // deadline. First detection only SUGGESTS (UI banner — user
            // accepts/declines once); accepted folds then re-apply on every
            // rebuild, because children re-extract from the docs each time. ──
            let foldedCount = 0;
            const newPending: FoldSug[] = [];
            try {
              const folds = readFolds();
              const PART_RE = /\b(part|phase|section|component|stage)\b/i;
              const nom: [Dl, Dl][] = [];
              for (let i = 0; i < merged.length && nom.length < 20; i++) {
                for (let j = i + 1; j < merged.length && nom.length < 20; j++) {
                  const a = merged[i]!, b = merged[j]!;
                  if (a.course !== b.course || a.kind !== b.kind) continue;
                  if (!digitsOk(a.title, b.title)) continue; // shared number anchor (A1 ↔ Assignment 1)
                  if (PART_RE.test(a.title) || PART_RE.test(b.title) || sim(a.title, b.title) >= 0.5) nom.push([a, b]);
                }
              }
              if (nom.length) {
                const raw3 = await glmChatRaw([
                  { role: "system", content: `You classify PAIRS of deadline entries from one student's course. Decide the relation between each pair:
- "same": both entries are THE SAME task extracted twice.
- "part-of": one entry is a distinct sub-deliverable OF the other — e.g. "A1 Part A: Venture vision paragraph" is part of "Assignment 1: Entrepreneurial Process" (separately evaluated, but belongs to the umbrella task). Name the umbrella via "parent": "A" or "B" — the umbrella is the BROADER whole, never the part.
- "unrelated": different tasks (different numbers, weeks, or deliverables).
STRICT: only "part-of" with confidence "high" when containment is explicit (Part/Phase/Section naming, or the child title is clearly one piece of the parent's deliverable). When in doubt, answer "unrelated".
Reply with ONLY a JSON array, one object per pair in order: {"pair": <number>, "relation": "same"|"part-of"|"unrelated", "parent": "A"|"B", "confidence": "high"|"medium"|"low"}` },
                  { role: "user", content: nom.map(([a, b], i) => `PAIR ${i + 1}:\nA: ${JSON.stringify({ title: a.title, due: a.due, kind: a.kind, note: a.note })}\nB: ${JSON.stringify({ title: b.title, due: b.due, kind: b.kind, note: b.note })}`).join("\n\n") },
                ]);
                const m3 = raw3.content.match(/\[[\s\S]*\]/);
                const rels: { pair: number; relation: string; parent?: string; confidence?: string }[] = m3 ? JSON.parse(m3[0]) : [];
                const folded = new Set<Dl>();
                for (const r of rels) {
                  if (r.relation !== "part-of" || r.confidence !== "high") continue;
                  const pr = nom[Number(r.pair) - 1];
                  if (!pr || folded.has(pr[0]) || folded.has(pr[1])) continue;
                  let parent = r.parent === "B" ? pr[1] : pr[0];
                  const child = r.parent === "B" ? pr[0] : pr[1];
                  if (parent.id === child.id || parent.done || child.done) continue;
                  const key = dlKey(child.course, child.title);
                  const verdict = folds.verdicts[key];
                  if (verdict?.v === "declined") continue;
                  if (verdict?.v === "accepted") { // re-apply every rebuild…
                    // …bound to the USER-chosen parent when one is recorded —
                    // exact title key first, then fuzzy (titles drift)
                    if (verdict.parent) {
                      const chosen = merged.find((d) => d !== child && d.course === child.course && !d.done && dlKey(d.course, d.title) === verdict.parent)
                        ?? (verdict.parentTitle ? merged.find((d) => d !== child && d.course === child.course && !d.done && sameTask(verdict.parentTitle!, d.title)) : undefined);
                      if (!chosen) continue; // parent gone this build — child stays visible
                      parent = chosen;
                    }
                    const det = foldChildInto(parent, child);
                    if (!folds.folded[key]) folds.folded[key] = { child: { ...child }, parentId: parent.id, parentKey: dlKey(parent.course, parent.title), parentTitle: parent.title, addedItemIds: det.addedItemIds, enriched: det.enriched, partTitles: det.partTitles, at: Date.now() };
                    folded.add(child);
                    foldedCount++;
                  } else if (!folds.pending.some((p) => p.childId === child.id) && !newPending.some((p) => p.childId === child.id)) {
                    newPending.push({ parentId: parent.id, parentTitle: parent.title, childId: child.id, childTitle: child.title, childDue: child.due });
                  }
                }
                if (folded.size) merged = merged.filter((d) => !folded.has(d));
                if (foldedCount) pushEvent(`deadlines: re-applied ${foldedCount} accepted fold(s)`);
              }
              writeFolds({ verdicts: folds.verdicts, pending: newPending, folded: folds.folded });
            } catch (e) {
              pushEvent(`deadlines fold-detection skipped: ${String(e).slice(0, 100)}`);
            }
            const added = merged.filter((d) => freshIds.has(d.id)).map((d) => ({ course: d.course, title: d.title, due: d.due, kind: d.kind }));
            // heal orphaned checklists: entries whose deadlineId vanished get
            // fuzzy-reattached to the current entry of the same task
            try {
              const ckPath = join(config.userDataDir, "checklists.json");
              const cks = JSON.parse(readFileSync(ckPath, "utf8")) as { deadlineId: string; course: string; title: string }[];
              if (Array.isArray(cks)) {
                const ids = new Set(merged.map((d) => d.id));
                let healed = 0;
                for (const c of cks) {
                  if (ids.has(c.deadlineId)) continue;
                  const t = merged.find((d) => d.course === c.course && dlKey(d.course, d.title) === dlKey(c.course, c.title))
                    ?? merged.filter((d) => d.course === c.course && sameTask(c.title, d.title))
                        .sort((x, y) => sim(y.title, c.title) - sim(x.title, c.title))[0];
                  if (t) { c.deadlineId = t.id; healed++; }
                }
                if (healed) {
                  writeFileSync(ckPath, JSON.stringify(cks, null, 2));
                  pushEvent(`checklists: re-attached ${healed} orphaned checklist(s) to renamed deadlines`);
                }
              }
            } catch { /* no checklists yet */ }
            writeDl(merged);
            writeFileSync(META, JSON.stringify({ docs: snapshotDocs(), builtAt: Date.now() }, null, 2));
            const changedCount = [...changedDocs.values()].reduce((n, ds) => n + ds.length, 0) + deletedKeys.size;
            pushEvent(scoped
              ? `deadlines updated: +${added.length} new, ${updatedDates.length} date(s) changed${semanticMerged ? `, ${semanticMerged} dup(s) merged` : ""}${foldedCount ? `, ${foldedCount} folded` : ""}${newPending.length ? `, ${newPending.length} fold suggestion(s)` : ""}, ${changedCount} changed doc(s) scanned — ${merged.length} item(s) total`
              : `deadlines rebuilt: ${merged.length} item(s)${semanticMerged ? `, ${semanticMerged} dup(s) merged` : ""}${foldedCount ? `, ${foldedCount} folded` : ""}${newPending.length ? `, ${newPending.length} fold suggestion(s)` : ""}`);
            return send(200, { ok: true, mode: scoped ? "update" : "full", count: merged.length, added, updated: updatedDates, deduped: semanticMerged, folded: foldedCount, suggestions: newPending, changed: changedCount });
          } catch (e) {
            return send(500, { error: `deadline rebuild failed: ${String(e).slice(0, 150)}` });
          }
        })();
        return; // async handler sends the response
      }
    }
    // ── checklists (AI-generated, per-deadline execution lists) ──
    if (url.pathname === "/checklists") {
      const CHECKLISTS = join(config.userDataDir, "checklists.json");
      const DEADLINES = join(config.userDataDir, "deadlines.json");
      const readDlAll = (): { id: string; course: string; title: string; kind: string; due: string | null; note: string; parts?: { title: string; due: string | null; note: string; done: boolean }[] }[] => {
        try {
          const j = JSON.parse(readFileSync(DEADLINES, "utf8"));
          return Array.isArray(j) ? j : [];
        } catch { return []; }
      };
      type Item = { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean };
      type Ck = { deadlineId: string; course: string; title: string; items: Item[]; updatedAt: number };
      const itemId = (dl: string, t: string): string => { // stable: same deadline+text → same id
        let h = 5381;
        for (const ch of `${dl}|${t.toLowerCase().trim()}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
        return h.toString(16);
      };
      const readCk = (): Ck[] => {
        try {
          const j = JSON.parse(readFileSync(CHECKLISTS, "utf8"));
          return Array.isArray(j) ? j : [];
        } catch { return []; }
      };
      const writeCk = (c: Ck[]): void => { mkdirSync(config.userDataDir, { recursive: true }); writeFileSync(CHECKLISTS, JSON.stringify(c, null, 2)); };
      if (req.method === "GET") return send(200, { checklists: readCk() });
      if (req.method === "DELETE") {
        const id = url.searchParams.get("deadlineId");
        if (!id) { try { rmSync(CHECKLISTS, { force: true }); } catch { /* gone */ } return send(200, { ok: true }); }
        const ck = readCk().filter((c) => c.deadlineId !== id);
        writeCk(ck);
        return send(200, { ok: true, checklists: ck });
      }
      if (req.method === "POST") {
        (async () => {
          try {
            const body = await new Promise<Record<string, unknown>>((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); });
            const ck = readCk();
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
              writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── manual add ──
            if (typeof body.add === "string" && body.add.trim()) {
              const text = body.add.trim().slice(0, 200);
              let c = mine();
              if (!c) {
                const dl = readDlAll().find((d) => d.id === dlId);
                c = { deadlineId: dlId, course: dl?.course ?? "", title: dl?.title ?? text, items: [], updatedAt: Date.now() };
                ck.push(c);
              }
              const id = itemId(dlId, text);
              if (!c.items.some((x) => x.id === id)) c.items.push({ id, text, done: false, doneAt: null, manual: true });
              c.updatedAt = Date.now();
              writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── remove an item ──
            if (typeof body.removeItemId === "string") {
              const c = mine();
              if (!c) return send(404, { error: "no such checklist" });
              c.items = c.items.filter((x) => x.id !== body.removeItemId);
              c.updatedAt = Date.now();
              writeCk(ck);
              return send(200, { ok: true, checklists: ck });
            }
            // ── generate / regenerate for a deadline ──
            const dl = readDlAll().find((d) => d.id === dlId);
            if (!dl) return send(404, { error: "no such deadline id" });
            const systemPrompt = `You build an EXECUTION CHECKLIST for one specific student task, from the real course files — never invent steps.
Task: "${dl.title}" (${dl.kind})${dl.due ? `, due ${dl.due}` : ""}${dl.note ? `. Known detail: ${dl.note}` : ""}${dl.parts?.length ? `\nThis task has KNOWN PARTS (folded sub-deliverables) — each MUST appear as its own step, with its due date when given:\n${dl.parts.map((p) => `- ${p.title}${p.due ? ` (due ${p.due})` : ""}${p.done ? " [already done]" : ""}${p.note ? ` — ${p.note}` : ""}`).join("\n")}` : ""}
Course slug: ${dl.course}
Explore with tools first: list_materials / read_document / view_page on anything related to THIS task (task sheets, lab specs, submission instructions). Read enough to know what concretely must be done; skim, don't quote.
Then reply with ONLY a JSON array (no prose, no markdown fences) of ordered steps:
[{"text": "short imperative step, individually verifiable"}]
5-12 items unless the source genuinely demands more. Split the work into its real parts (prepare → do → verify → submit) — a 1- or 2-item checklist is almost never useful. Steps must be concrete and checkable (e.g. "Complete Section 2 query exercises", "Upload the .zip to Moodle"), not vague ("understand the lab"). Include setup, the actual work, and submission. Today is ${new Date().toISOString().slice(0, 10)}.`;
            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Build the checklist for "${dl.title}" now. Explore the course materials with tools, then output ONLY the JSON array.` },
            ];
            let raw = "";
            for (let step = 0; step < 10; step++) {
              const msg = await glmChatRaw(convo, TOOL_DEFS);
              if (msg.tool_calls?.length) {
                convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
                for (const tc of msg.tool_calls) {
                  const result = await runTool(tc, dl.course);
                  pushEvent(`checklist tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
                  convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 26_000) });
                }
                continue;
              }
              raw = msg.content;
              break;
            }
            const m = raw.match(/\[[\s\S]*\]/);
            if (!m) return send(500, { error: `model produced no JSON array: ${raw.slice(0, 120)}` });
            let parsed: unknown[];
            try { parsed = JSON.parse(m[0]); } catch (e) {
              return send(500, { error: `JSON parse failed: ${String(e).slice(0, 120)}` });
            }
            const steps = parsed
              .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
              .map((s) => String(s.text ?? "").trim().slice(0, 200))
              .filter((t) => t.length > 1);
            if (!steps.length) return send(500, { error: "model returned no usable steps" });
            // done-ness + manual items carry over (id = deadlineId|text)
            const prev = mine();
            const prevDone = new Map((prev?.items ?? []).filter((x) => x.done).map((x) => [x.id, x]));
            const items: Item[] = steps.map((text) => {
              const id = itemId(dlId, text);
              const old = prevDone.get(id);
              return { id, text, done: Boolean(old?.done), doneAt: old?.doneAt ?? null };
            });
            for (const x of prev?.items ?? []) if (x.manual && !items.some((n) => n.id === x.id)) items.push(x); // keep manual adds
            const entry: Ck = { deadlineId: dlId, course: dl.course, title: dl.title, items, updatedAt: Date.now() };
            const out = ck.filter((c) => c.deadlineId !== dlId);
            out.push(entry);
            writeCk(out);
            pushEvent(`checklist built: ${dl.title} — ${items.length} step(s)`);
            return send(200, { ok: true, count: items.length, checklists: out });
          } catch (e) {
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
      const GLOBAL_CHAT = join(config.userDataDir, "chat.json");
      if (url.pathname === "/chat/lexicon" && req.method === "GET") {
        // leaf filename → ALL courses having it (ambiguous ones resolved by
        // the UI via context scoring) + per-course hint tokens for that scoring
        const lex: Record<string, { course: string; path: string }[]> = {};
        const hints: Record<string, string[]> = {};
        const m = allCourses();
        for (const c of m) {
          const toks = new Set<string>();
          for (const t of c.toLowerCase().replace(/[_\-.]+/g, " ").split(/\s+/)) if (t.length >= 4) toks.add(t);
          for (const mat of listMaterials(c)) {
            (lex[mat.filename] ??= []).push({ course: c, path: mat.path });
          }
          hints[c] = [...toks];
        }
        // mapped meeting titles are richer course names ("Data Warehs & …")
        try {
          const MAPF = join(dirname(config.userDataDir), "mapping.json");
          for (const [title, folder] of Object.entries(JSON.parse(readFileSync(MAPF, "utf8")) as Record<string, string>)) {
            if (!hints[folder]) continue;
            for (const t of title.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 5 && !hints[folder]!.includes(t)) hints[folder]!.push(t);
          }
        } catch { /* no mapping file */ }
        return send(200, { lexicon: lex, hints });
      }
      const loadChat = (): { role: "user" | "assistant"; content: string; at: string }[] => {
        try { return JSON.parse(readFileSync(GLOBAL_CHAT, "utf8")); } catch { return []; }
      };
      const saveChat = (msgs: { role: "user" | "assistant"; content: string; at: string }[]): void => {
        mkdirSync(config.userDataDir, { recursive: true });
        writeFileSync(GLOBAL_CHAT, JSON.stringify(msgs.slice(-100), null, 2));
      };
      if (req.method === "GET") return send(200, { messages: loadChat() });
      if (req.method === "DELETE") {
        try { rmSync(GLOBAL_CHAT, { force: true }); } catch { /* gone */ }
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
            const history = loadChat();
            history.push({ role: "user", content: message, at: new Date().toISOString() });

            const systemPrompt = `You are a study assistant for ALL of the student's courses (semester dates come from list_courses / week_overview).
For "what's due / what should I do next" questions, call list_deadlines FIRST — it's the student's curated calendar (items they finished are checked off and excluded — never re-suggest those).
For "what's left / where am I on X" questions also call list_checklists — it shows per-task step progress and the student's own context notes (group members, roles, …).
Start broad: list_deadlines, week_overview or list_courses, then inspect the promising documents with the course-scoped tools (they need a 'course' argument — use exact slugs from list_courses).
Read enough of the actual materials to answer concretely — never guess what a file contains. Cite EXACT file names so they can be previewed. If nothing exists for a week/course, say so honestly.${webSearch ? "\nWEB ACCESS enabled: when the course materials genuinely don't cover the question, you may web_search the public web and web_read a result. Always prefer course materials when they answer it; cite web sources by URL." : ""}
FORMATTING: any sequence of steps, priorities or due dates is a markdown list ("1. …" or "- …"), never an inline ①②③ run-on line.`;
            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt },
              ...history.slice(-16).map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
            ];
            let reply = "";
            let webReads = 0;
            for (let step = 0; step < 12; step++) {
              const msg = await glmChatRaw(convo, tools);
              if (msg.tool_calls?.length) {
                convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
                for (const tc of msg.tool_calls) {
                  if ((tc.function.name === "web_search" || tc.function.name === "web_read") && !webSearch) {
                    convo.push({ role: "tool", tool_call_id: tc.id, content: "web tools are disabled for this chat" });
                    continue;
                  }
                  if (tc.function.name === "web_read" && ++webReads > 4) {
                    convo.push({ role: "tool", tool_call_id: tc.id, content: "web_read limit reached (4) — answer with what you have" });
                    continue;
                  }
                  const result = await runTool(tc);
                  pushEvent(`global chat tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
                  convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 26_000) });
                }
                continue;
              }
              reply = msg.content;
              break;
            }
            if (!reply) reply = "(no answer — model hit the tool-step limit; try a more specific question)";
            history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
            saveChat(history);
            return send(200, { reply });
          } catch (e) {
            return send(500, { error: `chat failed: ${String(e).slice(0, 150)}` });
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
      const CHAT_FILE = () => join(config.userDataDir, "courses", slug, "chat.json");
      const loadChat = (): { role: "user" | "assistant"; content: string; at: string }[] => {
        try { return JSON.parse(readFileSync(CHAT_FILE(), "utf8")); } catch { return []; }
      };
      const saveChat = (msgs: { role: "user" | "assistant"; content: string; at: string }[]): void => {
        mkdirSync(join(config.userDataDir, "courses", slug), { recursive: true });
        writeFileSync(CHAT_FILE(), JSON.stringify(msgs.slice(-100), null, 2)); // cap history
      };
      if (req.method === "GET") return send(200, { messages: loadChat() });
      if (req.method === "POST") {
        (async () => {
          try {
            let body: Record<string, unknown> = {};
            try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res({}); } }); }); } catch { /* empty */ }
            const message = String(body.message ?? "").trim();
            if (!message) return send(400, { error: "message required" });
            const webSearch = body.webSearch === true;
            const tools = webSearch ? TOOL_DEFS_WITH_WEB : TOOL_DEFS;
            const history = loadChat();
            history.push({ role: "user", content: message, at: new Date().toISOString() });

            // ── tool-calling loop: the model explores the course itself ──
            const cfg = getCourseConfig(slug);
            const systemPrompt = `You are a study assistant for the course "${slug.replace(/_/g, " ")}".${cfg?.semesterStart ? ` Semester starts ${cfg.semesterStart}.` : ""}
For "what's due / what should I do next" questions, call list_deadlines FIRST — it's the student's curated calendar for THIS course (items they finished are checked off and excluded — never re-suggest those).
For "what's left / where am I on X" questions also call list_checklists — it shows per-task step progress and the student's own context notes (group members, roles, …).
Use the tools to inspect materials, documents and recorded sessions before answering — never guess what a file contains. When you reference a file, cite its EXACT file name (e.g. 1.1_ Data Warehousing - Dimensional Modeling.pdf) so it can be linked. If tools show nothing relevant, say so honestly.${webSearch ? "\nWEB ACCESS enabled: when the course materials genuinely don't cover the question, you may web_search the public web and web_read a result (docs, background). Always prefer course materials when they answer it; cite web sources by URL." : ""}
FORMATTING: any sequence of steps, priorities or due dates is a markdown list ("1. …" or "- …"), never an inline ①②③ run-on line.`;

            const convo: ChatMsg[] = [
              { role: "system", content: systemPrompt },
              ...history.slice(-16).map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
            ];
            let reply = "";
            let webReads = 0;
            for (let step = 0; step < 8; step++) {
              const msg = await glmChatRaw(convo, tools);
              if (msg.tool_calls?.length) {
                convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
                for (const tc of msg.tool_calls) {
                  if ((tc.function.name === "web_search" || tc.function.name === "web_read") && !webSearch) {
                    convo.push({ role: "tool", tool_call_id: tc.id, content: "web tools are disabled for this chat" });
                    continue;
                  }
                  if (tc.function.name === "web_read" && ++webReads > 4) {
                    convo.push({ role: "tool", tool_call_id: tc.id, content: "web_read limit reached (4) — answer with what you have" });
                    continue;
                  }
                  const result = await runTool(tc, slug);
                  pushEvent(`chat tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
                  convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 26_000) });
                }
                continue;
              }
              reply = msg.content;
              break;
            }
            if (!reply) reply = "(no answer — model hit the tool-step limit; try a more specific question)";
            history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
            saveChat(history);
            return send(200, { reply });
          } catch (e) {
            return send(500, { error: `chat failed: ${String(e).slice(0, 150)}` });
          }
        })();
        return; // async handler sends the response
      }
      if (req.method === "DELETE") {
        try { rmSync(CHAT_FILE(), { force: true }); } catch { /* gone */ }
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
        // strip mapping.json entries whose VALUE is this slug
        try {
          const MAP = join(dirname(config.userDataDir), "mapping.json");
          const m = JSON.parse(readFileSync(MAP, "utf8")) as Record<string, string>;
          let dropped = 0;
          for (const k of Object.keys(m)) if (m[k] === course) { delete m[k]; dropped++; }
          if (dropped) writeFileSync(MAP, JSON.stringify(m, null, 2));
        } catch { /* no mapping file */ }
        pushEvent(`course deleted: ${course} (had no sessions)`);
        return send(200, { ok: true, course, removed });
      } catch (e) {
        return send(500, { error: `course delete failed: ${String(e).slice(0, 120)}` });
      }
    }
    send(404, { error: "not found" });
  });
  server.listen(PORT, () => console.log(`[daemon] controller listening on :${PORT}`));
}

export async function daemon(): Promise<void> {
  startController();
  // fresh volume guarantee: the whole dir skeleton exists before anything writes
  // (k8s PVCs start empty — compose had these pre-created by the seed volume)
  for (const d of [OUT_DIR, SEGMENTS_DIR, NOTES_DIR, RECORDINGS_DIR]) mkdirSync(d, { recursive: true });
  // retention: first pass AFTER rescue (orphans older than the cutoff are
  // past retention anyway), then every 6h. Videos only — transcripts stay.
  const retentionPass = (): void => {
    const r = runRetention();
    if (r && r.removed > 0)
      pushEvent(`retention: removed ${r.removed} video file(s), freed ${(r.freedBytes / 1e6).toFixed(0)} MB — transcripts & notes kept`);
  };
  setInterval(retentionPass, 6 * 3_600_000).unref();
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
        for (const m of listMaterials(c)) {
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
            handled.add(next.title);
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
      // unless the LOGIN itself failed (MFA unapproved), then stretch to 60
      // so unattended mornings don't spam MFA pushes every 10 minutes.
      const loginDown = lastLoginFailedAt > 0 && Date.now() - lastLoginFailedAt < 15 * 60_000;
      const sleepMs = Math.max(5_000, Math.min(wakeAt - now, schedule.length ? 60 * 60_000 : loginDown ? 60 * 60_000 : 10 * 60_000));
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
