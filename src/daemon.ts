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
import { readdirSync, statSync, existsSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loginTeams } from "./login/teams-login.ts";
import { listMeetings } from "./meetings/list.ts";
import { joinMeeting, joinMeetingByUrl } from "./meetings/join.ts";
import { listTodayMeetings } from "./graph/meetings.ts";
import { getAccessToken } from "./graph/auth.ts";
import { config } from "./config.ts";
import { startRecording, quickStopRecording, stopRecording, stillInMeeting, rebuildSeekPoints, RECORD_DIR } from "./record/recorder.ts";
import { consolidateSession } from "./pipeline/consolidate.ts";
import { notify } from "./notify.ts";
import { setActivity, setDetail, pushEvent, snapshot, getSettings, setSettings, getModelQuotas, loadLeftToday, recordLeftToday, clearLeftToday, applySettingsPatch } from "./status.ts";
import { lastDeviceCode } from "./graph/auth.ts";
import { NOTES_DIR, RECORDINGS_DIR, OUT_DIR, SEGMENTS_DIR, outPath } from "./paths.ts";
import { listMaterials, addMaterial, removeMaterial, MATERIALS_DIR, getCourseConfig, setCourseConfig, weekOf, weekMonday } from "./pipeline/materials.ts";
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
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** Rescue sessions orphaned by a hard kill (SIGKILL/OOM/host restart):
 *  webm groups in segments/ untouched for >10 min get remuxed + consolidated
 *  (mp4 keeps them listenable in the UI; no Gemini spend by default). */
async function rescueOrphans(): Promise<void> {
  let files: string[];
  try { files = readdirSync(RECORD_DIR).filter((f) => f.endsWith(".webm")); } catch { return; }
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const stem = f.replace(/__\d{3}\.webm$/, "");
    groups.set(stem, [...(groups.get(stem) ?? []), f]);
  }
  for (const [stem, parts] of groups) {
    const paths = parts.map((p) => join(RECORD_DIR, p));
    const newest = Math.max(...paths.map((p) => statSync(p).mtimeMs));
    if (Date.now() - newest < 10 * 60_000) continue; // possibly still live
    setActivity("rescuing orphaned session", { meeting: stem });
    console.log(`[daemon] orphan rescue: ${parts.length} segment(s) from ${stem}`);
    updateSession(stem, { stage: "consolidating", stageNote: "orphan rescue", segCount: parts.length });
    for (const p of paths) await rebuildSeekPoints(p.split(/[\\/]/).pop()!);
    const ogg = join(RECORD_DIR, `${stem}.audio.ogg`);
    try {
      // title slug lives before the "__<ISO timestamp>" suffix — keeps
      // rescued sessions filed under the same course folder as live ones
      const title = stem.replace(/__\d{4}-\d{2}-\d{2}.*$/, "").replace(/_/g, " ") || stem;
      const r = await consolidateSession(title, paths, undefined, existsSync(ogg) ? ogg : undefined);
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
const REBUILD_MS = (Number(process.env.REBUILD_MINUTES ?? 360) || 360) * 60_000;

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
    // one browser scrape per rebuild (morning / manual / join-window verify)
    const r = await loginTeams({ keepOpen: true });
    if (r.ok && r.ctx && r.page) {
      try {
        await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
        const ms = await listMeetings(r.page);
        lastScan = new Date().toISOString();
        lastSeen = ms.length;
        for (const m of ms) evs.push({ title: m.title, start: m.start.getTime(), end: m.end.getTime() });
      } finally { await r.ctx.close().catch(() => {}); }
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
    now >= e.start - joinEarlyMs() && now < e.end && !handled.has(e.title) && !attendedToday().includes(e.title)) ?? null;
}

/** Record + watch + stop for an already-joined meeting (both join paths). */
async function attendAndRecord(page: import("playwright").Page, title: string): Promise<void> {
  active = { page, title };
  journalEntry(title, {}); // persistent attendance — survives restarts
  setActivity("in meeting — starting recorder", { meeting: title });
  pushEvent(`joined: ${title}`);

  let rec: Awaited<ReturnType<typeof startRecording>> | null = null;
  try {
    rec = await startRecording(page, title);
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
    // call-end watch: leave-marker gone for >60s → meeting over (or /leave)
    let misses = 0;
    while (misses < 30 && !leaveRequested) {
      await new Promise((res) => setTimeout(res, 2_000));
      if (await stillInMeeting(page)) misses = 0;
      else misses++;
    }
    if (leaveRequested) {
      pushEvent(`leave requested — wrapping up ${title}`);
      console.log("[daemon] leave requested via UI");
      recordLeftToday(title); // persist: no auto re-join for the rest of today
      leaveRequested = false;
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
          setActivity("idle — post-processing complete", { meeting: title });
          console.log(`[daemon] recording done: ${done.segments.length} segment(s), ${(done.bytes / 1e6).toFixed(0)} MB, ${Math.round(done.ms / 60000)} min`);
          notify(`⏹️ Recording ended: **${title}** — ${done.segments.length} segment(s), ${Math.round(done.ms / 60000)} min`).catch(() => {});
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
    leaveRequested = false;
  }
  handled.add(title);
  journalEntry(title, { leftAt: Date.now() });
  active = null;
}

/** Graph discovery: cheap HTTP — no browser. Only called with a cached token. */
async function graphJoinable(): Promise<{ title: string; joinUrl: string } | null | "error"> {
  try {
    const evs = await listTodayMeetings();
    lastScan = new Date().toISOString();
    lastSeen = evs.length;
    const now = Date.now();
    for (const e of evs) {
      if (!e.isOnline || !e.joinUrl || handled.has(e.subject)) continue;
      const s = new Date(e.start).getTime();
      const en = new Date(e.end).getTime();
      if (now >= s - joinEarlyMs() && now < en) return { title: e.subject, joinUrl: e.joinUrl };
    }
    return null;
  } catch (e) {
    console.warn(`[daemon] Graph poll failed: ${String(e).slice(0, 120)} — browser scan this cycle`);
    return "error";
  }
}

/** Graph path: the browser launches ONLY when a meeting is actually joinable. */
async function attendViaGraph(): Promise<boolean | "error" | null> {
  const g = await graphJoinable();
  if (g && g !== "error") {
    console.log(`[daemon] (graph) joinable now: ${g.title}`);
    const r = await loginTeams({ keepOpen: true });
    if (!r.ok || !r.ctx) return false;
    try {
      await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
      state = `attending: ${g.title}`;
      setActivity("joining meeting", { meeting: g.title });
      const page = await joinMeetingByUrl(r.ctx, g.title, g.joinUrl);
      if (!page) return false;
      await attendAndRecord(page, g.title);
      return true;
    } finally {
      state = "idle";
      await r.ctx.close().catch(() => {});
    }
  }
  return g; // null = nothing joinable, "error" = Graph unavailable
}

/** Browser-scrape path (fallback until Graph is approved once). */
async function attendViaScrape(): Promise<boolean> {
  const r = await loginTeams({ keepOpen: true });
  if (!r.ok || !r.ctx || !r.page) return false;
  try {
    await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
    const meetings = await listMeetings(r.page);
    lastScan = new Date().toISOString();
    lastSeen = meetings.length;
    const live = meetings.filter((m) => m.joinableNow && !handled.has(m.title));
    if (!live.length) return false;

    const m = live[0];
    state = `attending: ${m.title}`;
    setActivity("joining meeting", { meeting: m.title });
    console.log(`[daemon] live meeting found: ${m.title}`);
    const page = await joinMeeting(r.ctx, m);
    if (!page) return false;
    await attendAndRecord(page, m.title);
    return true; // re-poll immediately — another class may be live too
  } finally {
    state = "idle";
    await r.ctx.close().catch(() => {});
  }
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
    if (req.method === "POST" && url.pathname === "/auth/graph") {
      if (hasGraphToken()) return send(200, { ok: true, note: "token already present" });
      // fire-and-forget: device code is pinged to Discord; approval may take minutes
      void getAccessToken()
        .then(() => { pushEvent("Graph approved ✓ — cheap polling active"); console.log("[daemon] Graph token approved"); })
        .catch((e) => pushEvent(`Graph approval failed: ${String(e).slice(0, 100)}`));
      return send(202, { ok: true, note: "device code sent to Discord — approve to enable cheap polling" });
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
      const mine = new RegExp(`^${esc}(__T?\\d{6}|\\.stale-\\d{6})?\\.mp4$`);
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
        sameDayLeft = readdirSync(rdir).some((f) => f.endsWith(".mp4") && f.replace(/\.mp4$/, "").replace(/(__T?\d{6}|\.stale-\d{6})$/, "") === base);
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
      let body: Record<string, unknown> = {};
      try { body = await new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(JSON.parse(b))); }); } catch { /* empty */ }
      const want = String(body.title ?? "").toLowerCase().trim();
      if (!want) return send(400, { error: "title required" });
      handled.delete(body.title as string); // re-join allowed
      void (async () => {
        try {
          state = "attending (manual join)";
          setActivity("joining meeting (manual)", { meeting: String(body.title) });
          const r = await loginTeams({ keepOpen: true });
          if (!r.ok || !r.ctx || !r.page) throw new Error("login failed");
          try {
            await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
            const meetings = await listMeetings(r.page);
            lastScan = new Date().toISOString();
            lastSeen = meetings.length;
            const m = meetings.find((x) => x.title.toLowerCase().includes(want));
            if (!m) throw new Error(`"${body.title}" not on the calendar`);
            const page = await joinMeeting(r.ctx, m);
            if (!page) throw new Error("join flow failed (not started yet?)");
            await attendAndRecord(page, m.title);
          } finally {
            state = "idle";
            await r.ctx.close().catch(() => {});
          }
        } catch (e) {
          state = "idle";
          pushEvent(`manual join failed: ${String(e).slice(0, 120)}`);
          console.warn(`[daemon] manual join failed: ${String(e).slice(0, 200)}`);
        }
      })();
      return send(202, { ok: true, note: `joining "${body.title}" — watch status` });
    }
    if (req.method === "POST" && url.pathname === "/leave") {
      if (!state.startsWith("attending")) return send(200, { ok: true, note: "not in a meeting" });
      leaveRequested = true;
      return send(200, { ok: true, note: "leaving — stopping recorder + consolidating first (won't re-join today)" });
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
          if (f === `${stem}.mp4` || (f.startsWith(`${stem}__T`) && f.endsWith(".mp4"))) { mp4 = join(dir, f); break; }
        }
      } catch { /* no course dir */ }
      if (!mp4) return send(404, { error: "no recording (mp4) for this session — consolidate first" });
      transcribeJob = `${course}/${stem}`;
      pushEvent(`transcribe: manual job started — ${course}/${stem}`);
      void (async () => {
        try {
          const t = await transcribeFile(mp4);
          const realStem = mp4.split(/[\\/]/).pop()!.replace(/\.mp4$/, "");
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
            const entries = t.chunks.map((c) => ({ meeting: title, offsetSec: c.offsetSec, file: `${realStem}.mp4`, transcript: c.text, visualNotes: [] as { t: string; note: string }[] }));
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
      if (req.method === "GET") return send(200, getSettings());
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
        if (prev.encThreads !== s.encThreads) changes.push(`encode threads ${s.encThreads}`);
        if (prev.joinEarlyMinutes !== s.joinEarlyMinutes) changes.push(`join early ${s.joinEarlyMinutes}min`);
        if (prev.geminiModels !== s.geminiModels) changes.push(`model chain → ${s.geminiModels}`);
        if (changes.length) pushEvent(`settings: ${changes.join(" · ")}`);
        return send(200, s);
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
        const r = new Request(`http://localhost:${PORT}/ingest`, {
          method: "POST", headers: req.headers,
          body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half",
        } as RequestInit);
        const form = await r.formData();
        const file = form.get("file") as File | null;
        const tfile = form.get("transcript") as File | null;
        const course = String(form.get("course") || "").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_");
        if (!file?.name || !course) return send(400, { error: "file and course required" });
        if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) return send(400, { error: "video must be mp4/webm/mov/m4v" });

        // date: explicit > week-derived (Monday of week N) > today
        const cfg = getCourseConfig(course);
        let date = String(form.get("date") || "");
        const week = Number(form.get("week"));
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
        let seq = Number(new Date().toLocaleTimeString("en-CA", { hour12: false, timeZone: "America/Toronto" }).replace(/:/g, ""));
        if (!Number.isFinite(seq)) seq = 0;
        let mp4name = `${stem}__${String(seq).padStart(6, "0")}.mp4`;
        while (existsSync(join(rdir, mp4name))) mp4name = `${stem}__${String(++seq).padStart(6, "0")}.mp4`;

        const buf = Buffer.from(await file.arrayBuffer());
        writeFileSync(join(rdir, mp4name), buf);
        let wroteTranscript = false;
        if (tfile?.name) {
          const txt = Buffer.from(await tfile.arrayBuffer()).toString("utf8");
          writeFileSync(join(NOTES_DIR, course, `${stem}__transcript.md`),
            `# Transcript — ${course.replace(/_/g, " ")} (${date})\n\n${txt}`);
          wroteTranscript = true;
        }
        pushEvent(`ingest: ${mp4name} (${(buf.length / 1e6).toFixed(0)} MB)${wroteTranscript ? " + uploaded transcript" : ""}`);
        return send(200, { ok: true, mp4: mp4name, stem, date, course, transcript: wroteTranscript });
      } catch (e) { return send(500, { error: `ingest failed: ${String(e).slice(0, 120)}` }); }
    }
    // ── course materials (upload / list / delete) + course config ─────
    const MATERIALS_RE = /^\/courses\/([^/]+)\/materials$/;
    const mm = url.pathname.match(MATERIALS_RE);
    if (mm) {
      const slug = decodeURIComponent(mm[1]);
      if (req.method === "GET") return send(200, listMaterials(slug));
      if (req.method === "POST") {
        try {
          // IncomingMessage isn't a fetch Request — wrap the stream so the
          // native multipart parser (undici) can read formData()
          const r = new Request(`http://localhost:${PORT}${url.pathname}`, {
            method: "POST",
            headers: req.headers,
            body: Readable.toWeb(req) as unknown as ReadableStream,
            duplex: "half",
          } as RequestInit);
          const form = await r.formData();
          const file = form.get("file") as File | null;
          const category = String(form.get("category") || "other");
          const description = String(form.get("description") || "");
          if (!file || !file.name) return send(400, { error: "file required" });
          const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, "_");
          if (safeName === "materials.json") return send(400, { error: "reserved filename" });
          // week: explicit from the form, else derived from semesterStart + today
          const cfg = getCourseConfig(slug);
          let week = Number(form.get("week"));
          if (!Number.isFinite(week) || week < 1) week = cfg ? weekOf(new Date().toISOString().slice(0, 10), cfg.semesterStart) : 1;
          week = Math.min(15, Math.floor(week));
          const dir = join(MATERIALS_DIR(slug), weekFolder(week));
          mkdirSync(dir, { recursive: true });
          const buf = Buffer.from(await file.arrayBuffer());
          writeFileSync(join(dir, safeName), buf);
          addMaterial(slug, { filename: safeName, week, category, description, uploadedAt: new Date().toISOString(), size: buf.length });
          pushEvent(`material uploaded: ${safeName} → ${slug} week ${week} (${category})`);
          return send(200, { ok: true, filename: safeName, week });
        } catch (e) { return send(500, { error: `upload failed: ${String(e).slice(0, 100)}` }); }
      }
      if (req.method === "DELETE") {
        const filename = url.searchParams.get("file");
        const week = Number(url.searchParams.get("week"));
        if (!filename || !Number.isFinite(week)) return send(400, { error: "file and week params required" });
        if (filename.includes("/") || filename.includes("..") || filename.includes("\\")) return send(400, { error: "invalid filename" });
        const ok = removeMaterial(slug, filename, week);
        if (ok) { pushEvent(`material deleted: ${filename} (week ${week}) from ${slug}`); return send(200, { ok: true }); }
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
        const s = String(body.semesterStart ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return send(400, { error: "semesterStart must be YYYY-MM-DD" });
        const cfg = setCourseConfig(slug, { semesterStart: s });
        pushEvent(`course config: ${slug} semester starts ${s}`);
        return send(200, cfg);
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
  console.log(`[daemon] schedule-driven: morning pull, sleep until join windows (join ${joinEarlyMs() / 60_000} min early, rebuild every ${REBUILD_MS / 60_000} min)`);
  for (;;) {
    try {
      // stale check only — never force-rebuild just because schedule is empty,
      // that creates a login loop on every 800ms tick
      const backoffMs = schedule.length ? REBUILD_MS : 5 * 60_000;
      if (Date.now() - scheduleBuiltAt > backoffMs) {
        setActivity(hasGraphToken() ? "building today's schedule (Graph)" : "building today's schedule (browser)", {});
        await buildSchedule();
        pushEvent(`schedule built: ${schedule.length} event(s)${hasGraphToken() ? " via Graph" : " via browser"}`);
      }
      const next = nextActionable();
      if (next) {
        // re-pull right before joining to catch changes/cancellations
        setActivity("refreshing schedule before join", { meeting: next.title });
        await buildSchedule();
        const re = nextActionable();
        if (re) {
          state = `attending: ${re.title}`;
          const ok = await joinScheduled(re);
          state = "idle";
          if (ok) continue; // back-to-back classes
        }
      }
      // sleep until the NEXT join window (or next rebuild), interruptible by /scan
      const now = Date.now();
      const upcoming = schedule.filter((e) => e.start - joinEarlyMs() > now && !attendedToday().includes(e.title));
      const nextAt = upcoming[0]?.start - joinEarlyMs();
      const wakeAt = Math.min(nextAt ?? Infinity, scheduleBuiltAt + REBUILD_MS);
      const sleepMs = Math.max(5_000, Math.min(wakeAt - now, 60 * 60_000));
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
  const r = await loginTeams({ keepOpen: true });
  if (!r.ok || !r.ctx) return false;
  try {
    await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
    setActivity("joining meeting", { meeting: ev.title });
    let page: import("playwright").Page | null = null;
    if (ev.joinUrl) {
      page = await joinMeetingByUrl(r.ctx, ev.title, ev.joinUrl);
    } else {
      // fallback: find it live on the calendar and join via the DOM flow
      const meetings = await listMeetings(r.page!);
      const m = meetings.find((x) => x.title === ev.title && x.joinableNow);
      if (!m) { pushEvent(`"${ev.title}" not joinable at join time — skipping`); return false; }
      page = await joinMeeting(r.ctx, m);
    }
    if (!page) return false;
    await attendAndRecord(page, ev.title);
    return true;
  } finally {
    await r.ctx.close().catch(() => {});
  }
}
