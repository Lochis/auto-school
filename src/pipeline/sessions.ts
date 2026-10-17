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
