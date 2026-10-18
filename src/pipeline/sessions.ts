/** Per-session pipeline state, persisted to Postgres (sessions table).
 *  Every stage transition upserts one row; the UI shows a live progress line
 *  per session (recording → remuxing → transcribing k/n → noting →
 *  consolidating → done | failed). Durable state lives in PG; the synchronous
 *  readers (status.ts /status, render.ts mdToPdf guard, docindex.ts, daemon.ts
 *  recording guard) are served from an in-memory mirror because they are all
 *  sync call sites and describe process-local live state anyway. */
import { getPool } from "../db/client.ts";
import { courseId, sessionId } from "../db/writes.ts";
import { sessionPaths } from "./courses.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RECORDINGS_DIR } from "../paths.ts";

export type Stage = "recording" | "remuxing" | "transcribing" | "noting" | "consolidating" | "done" | "failed";

export interface SessionState {
  stem: string; // canonical stem: <localdate>__<courseSlug> (sessionPaths.stem)
  title: string;
  course?: string;
  startedAt: number;
  updatedAt: number;
  stage: Stage;
  stageNote?: string; // e.g. "3/12 segments through Gemini"
  segCount?: number;
  mp4?: string; // recordings/<course>/<file>.webm once done (live UI only)
  durationSec?: number;
  sizeMB?: number;
  joinUrl?: string; // Teams meeting link for this session (from Graph or calendar scrape)
}

// In-memory mirror for the synchronous readers. Durable rows live in PG.
let sessions: SessionState[] = [];

/** Real capture time from a stem/filename. Live + rescue stems carry the
 *  session-start instant: "<slug>__YYYY-MM-DDTHH-MM-SS" (UTC ISO, seg-0
 *  birth); uploaded/rescued files instead carry a Toronto-local "__HHMMSS"
 *  (or "__THHMMSS") suffix → time-of-day only. Mirrors the fs-mtime
 *  semantics the importer used for started_at / start_time. */
export function stemTimes(stem: string): { startedAt?: number; startTime?: string } {
  const iso = stem.match(/__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (iso) {
    const startedAt = Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}Z`);
    if (Number.isFinite(startedAt)) {
      const startTime = new Date(startedAt).toLocaleTimeString("en-CA", { hour12: false, timeZone: "America/Toronto" });
      return { startedAt, startTime };
    }
  }
  const seq = stem.match(/__T?(\d{2})(\d{2})(\d{2})$/);
  if (seq) return { startTime: `${seq[1]}:${seq[2]}:${seq[3]}` };
  return {};
}

/** Recover a meeting title from a stem. Live stems are "<title>__<ISO>";
 *  rescue stems (daemon orphan rescue) are "<titleSlug>" with no ISO suffix. */
function deriveTitle(stem: string): string {
  return stem.replace(/__\d{4}-\d{2}-\d{2}T[\d-]+$/, "").replace(/_/g, " ").trim() || stem;
}

/** Resolve a session's DB identity from a meeting title (or an explicit
 *  slug/stem override for manual transcription). Creates the row if missing,
 *  but never overwrites an existing row's stage (partial-patch semantics). */
export async function resolveSession(
  meetingTitle: string,
  opts: { slug?: string; stem?: string; name?: string } = {},
): Promise<{ courseId: number; sessionId: number; slug: string; stem: string }> {
  const paths = sessionPaths(meetingTitle);
  const slug = opts.slug ?? paths.course.slug;
  const stem = opts.stem ?? paths.stem;
  const cid = await courseId(slug, opts.name);
  const found = await getPool().query(
    `select id from sessions where course_id = $1 and stem = $2`,
    [cid, stem],
  );
  let sid = found.rows[0] ? Number(found.rows[0].id) : null;
  if (sid == null) {
    sid = await sessionId(cid, stem, {
      sessionDate: stem.slice(0, 10),
      title: meetingTitle,
      stage: "recording",
    });
  }
  return { courseId: cid, sessionId: sid, slug, stem };
}

export async function updateSession(stem: string, patch: Partial<Omit<SessionState, "stem">>): Promise<SessionState> {
  const title = patch.title ?? deriveTitle(stem);
  const paths = sessionPaths(title);
  const canonicalStem = paths.stem;
  // real capture start: explicit patch (mtime) > stem's __ISO suffix > now()
  const t = stemTimes(stem);

  // durable upsert on (course_id, stem); coalesce semantics match partial patches
  try {
    const cid = await courseId(paths.course.slug);
    await sessionId(cid, canonicalStem, {
      sessionDate: canonicalStem.slice(0, 10),
      title,
      joinUrl: patch.joinUrl,
      stage: patch.stage,
      stageNote: patch.stageNote,
      segCount: patch.segCount,
      durationSec: patch.durationSec,
      sizeMb: patch.sizeMB,
      startTime: t.startTime,
      startedAt: patch.startedAt ?? t.startedAt,
    });
  } catch (e) {
    console.warn(`[sessions] DB write failed — in-memory only: ${String(e).slice(0, 120)}`);
  }

  // in-memory mirror (synchronous /status + recording guards)
  let s = sessions.find((x) => x.stem === canonicalStem);
  if (!s) {
    s = { stem: canonicalStem, title, startedAt: Date.now(), updatedAt: Date.now(), stage: patch.stage ?? "recording" };
    sessions.unshift(s);
  }
  Object.assign(s, { title, ...patch, updatedAt: Date.now() });
  sessions = sessions.slice(0, 100);
  return s;
}

export function listSessions(): SessionState[] {
  return sessions.slice(0, 50);
}

const MID_FLIGHT: readonly string[] = ["recording", "remuxing", "transcribing", "noting", "consolidating"];

/** Consolidated recording for a stem, if one exists under
 *  recordings/<slug>/ — the exact <stem>.webm/.mp4/.mkv, or a rescue twin
 *  "<stem>__<ts>.<ext>". Its presence proves the capture finished: the
 *  fs→PG importer seeded historic rows as stage='recording' and the
 *  pre-heal hydrate blanket-failed them as "interrupted by restart" even
 *  though the classes were consolidated. */
function consolidatedFor(slug: string, stem: string): { rel: string; sizeMB: number } | null {
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const twin = new RegExp(`^${esc}__[\\w.-]+\\.(webm|mp4|mkv)$`);
  let fallback: { rel: string; sizeMB: number } | null = null;
  try {
    const dir = join(RECORDINGS_DIR, slug);
    for (const f of readdirSync(dir)) {
      if (!(f === `${stem}.webm` || f === `${stem}.mp4` || f === `${stem}.mkv` || twin.test(f))) continue;
      const hit = { rel: `recordings/${slug}/${f}`, sizeMB: Math.round(statSync(join(dir, f)).size / 1e6) };
      if (f.startsWith(`${stem}.`)) return hit; // exact file wins over a twin
      fallback ??= hit;
    }
  } catch { /* course dir absent — nothing consolidated */ }
  return fallback;
}

/** Rehydrate the in-memory board from the durable sessions rows at daemon
 *  startup. Without this the "Completed Sessions" panel (daemon /status ←
 *  listSessions()) shows "No captures yet" after every restart even though
 *  the classes are consolidated + indexed — the board only ever saw
 *  process-local updates. Rows in a mid-flight stage from a previous process
 *  (recording/consolidating/…) are failed ONLY when no consolidated
 *  recording exists on disk; when one does, the row is healed to done (the
 *  fs→PG importer seeded past sessions as 'recording', which used to be
 *  blanket-failed as "interrupted by restart"). */
export async function hydrateSessions(): Promise<void> {
  try {
    const rows = (await getPool().query(
      `select c.slug, s.stem, s.title, s.join_url, s.stage, s.stage_note, s.seg_count,
              s.duration_sec, s.size_mb, extract(epoch from s.started_at)::bigint * 1000 as started_ms,
              extract(epoch from s.updated_at)::bigint * 1000 as updated_ms
       from sessions s join courses c on c.id = s.course_id
       order by s.updated_at desc limit 50`,
    )).rows as Record<string, unknown>[];
    const healed: { slug: string; stem: string; sizeMB: number }[] = [];
    sessions = rows.map((r) => {
      const stem = String(r.stem);
      const mid = MID_FLIGHT.includes(String(r.stage));
      // rows previously mis-failed by the blanket hydrate carry our own
      // 'interrupted by restart' note — heal those too when the file exists
      const misFailed = r.stage === "failed" && r.stage_note === "interrupted by restart";
      if (mid || misFailed) {
        const got = consolidatedFor(String(r.slug), stem);
        if (got) {
          healed.push({ slug: String(r.slug), stem, sizeMB: got.sizeMB });
          return {
            stem,
            title: String(r.title ?? deriveTitle(stem)),
            course: String(r.slug),
            startedAt: Number(r.started_ms) || Date.now(),
            updatedAt: Number(r.updated_ms) || Date.now(),
            stage: "done" as Stage,
            mp4: got.rel,
            sizeMB: got.sizeMB,
            segCount: r.seg_count == null ? undefined : Number(r.seg_count),
            durationSec: r.duration_sec == null ? undefined : Number(r.duration_sec),
            joinUrl: r.join_url == null ? undefined : String(r.join_url),
          };
        }
        return {
          stem,
          title: String(r.title ?? deriveTitle(stem)),
          course: String(r.slug),
          startedAt: Number(r.started_ms) || Date.now(),
          updatedAt: Number(r.updated_ms) || Date.now(),
          stage: "failed" as Stage,
          stageNote: "interrupted by restart",
          segCount: r.seg_count == null ? undefined : Number(r.seg_count),
          joinUrl: r.join_url == null ? undefined : String(r.join_url),
        };
      }
      return {
        stem,
        title: String(r.title ?? deriveTitle(stem)),
        course: String(r.slug),
        startedAt: Number(r.started_ms) || Date.now(),
        updatedAt: Number(r.updated_ms) || Date.now(),
        stage: r.stage as Stage,
        stageNote: typeof r.stage_note === "string" && r.stage_note ? r.stage_note : undefined,
        segCount: r.seg_count == null ? undefined : Number(r.seg_count),
        durationSec: r.duration_sec == null ? undefined : Number(r.duration_sec),
        sizeMB: r.size_mb == null ? undefined : Number(r.size_mb),
        joinUrl: r.join_url == null ? undefined : String(r.join_url),
      };
    });
    if (sessions.length) console.log(`[sessions] board rehydrated: ${sessions.length} session(s) from Postgres`);
    // persist heals: consolidated file present → done (+ size). updated_at is
    // deliberately left alone so rows keep sorting by their real class time.
    for (const h of healed) {
      await getPool().query(
        `update sessions s set stage = 'done', stage_note = null, size_mb = coalesce(s.size_mb, $3)
         from courses c where c.id = s.course_id and c.slug = $1 and s.stem = $2`,
        [h.slug, h.stem, h.sizeMB],
      );
    }
    if (healed.length) console.log(`[sessions] hydrate healed ${healed.length} mislabeled session(s) → done (consolidated recording present)`);
    // persist the interrupted→failed verdict so the durable rows agree with
    // the board (a recording/consolidating row from a dead process is failed;
    // orphan rescue rewrites genuine rescues to done afterwards). updated_at
    // untouched: the restart time is not the session's time.
    await getPool().query(
      `update sessions set stage = 'failed', stage_note = 'interrupted by restart'
       where stage in ('recording','remuxing','transcribing','noting','consolidating')`,
    );
  } catch (e) {
    console.warn(`[sessions] board rehydrate skipped: ${String(e).slice(0, 120)}`);
  }
}
