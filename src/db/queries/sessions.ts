/** Phase-3 read queries — per-course session listing.
 *  Postgres replacement for frontend/src/lib/data.ts sessions(): the fs scan
 *  unions recordings-dir and notes-dir files by stem; in Postgres a session
 *  row exists either way and artifacts attach as session_artifacts rows, so
 *  sessions with NO artifacts must still appear (scalar subselects — no join
 *  drop). Ordering: session_date DESC, start_time DESC NULLS LAST, matching
 *  data.ts's (date + time) newest-first sort where a missing time sorts last
 *  within its date. Style: raw template SQL via the shared Pool (writes.ts). */
import { getPool } from "../pg.ts";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await getPool().query(text, params)).rows as T[];

/** Shape-parity with data.ts Session (camelCase, optional fields absent). */
export interface SessionSummary {
  /** "2026-08-20__Java_Programming" */
  stem: string;
  date: string;
  /** rel_path of the mp4/webm artifact, if present */
  audio?: string;
  /** rel_path of the notes md (__notes.md preferred over __running.md), if present */
  notes?: string;
  /** rel_path of the raw transcript md, if present */
  transcript?: string;
  /** rel_path of the timeline json artifact, if present */
  timeline?: string;
  /** segments captured for this session (timeline length) */
  segmentCount?: number;
  /** HH:MM — sessions.start_time (importer seeded it from the stem's __THHMMSS
   *  suffix, else the notes file's first-write time — same sources as data.ts) */
  time?: string;
  hasTimeline: boolean;
  /** Teams meeting join URL — sessions.join_url, no fuzzy fs matching */
  joinUrl?: string;
  /** user-given display name (ingest "Title" — see notes below) */
  title?: string;
  /** pipeline stage (sessions.stage) — 'recording' means the capture is still
   *  in flight (the recording artifact only lands at consolidation), so an
   *  ingest must not adopt such a stem. */
  stage?: string;
}

/** NOTE on `title`: data.ts surfaces it ONLY when notes/<course>/<stem>__title.txt
 *  exists. The DB column is now NULLABLE and the importer seeds NULL (sets it
 *  only from __title.txt; the journal merge no longer overwrites), so provenance
 *  is recoverable from a read. */
export interface SessionRow {
  id: number;
  stem: string;
  session_date: string;
  start_time: string | null;
  title: string | null;
  join_url: string | null;
  stage: string | null;
  seg_count: number | null;
  seg_rows: number;
  recording_path: string | null;
  notes_path: string | null;
  running_path: string | null;
  transcript_path: string | null;
  timeline_path: string | null;
}

const SELECT_SESSIONS = `
  select s.id::int as id, s.stem, s.session_date::text as session_date,
         s.start_time::text as start_time, s.title, s.join_url, s.stage,
         s.seg_count,
         (select count(*)::int from transcript_segments ts where ts.session_id = s.id) as seg_rows,
         (select a.rel_path from session_artifacts a
           where a.session_id = s.id and a.kind = 'recording' and a.deleted_at is null
           order by a.rel_path limit 1) as recording_path,
         (select a.rel_path from session_artifacts a
           where a.session_id = s.id and a.kind = 'notes' and a.deleted_at is null
           order by a.updated_at desc limit 1) as notes_path,
         (select a.rel_path from session_artifacts a
           where a.session_id = s.id and a.kind = 'running_notes' and a.deleted_at is null
           order by a.updated_at desc limit 1) as running_path,
         (select a.rel_path from session_artifacts a
           where a.session_id = s.id and a.kind = 'transcript' and a.deleted_at is null
           order by a.updated_at desc limit 1) as transcript_path,
         (select a.rel_path from session_artifacts a
           where a.session_id = s.id and a.kind = 'timeline' and a.deleted_at is null
           order by a.updated_at desc limit 1) as timeline_path
  from sessions s
  join courses c on c.id = s.course_id`;

function toSummary(r: SessionRow): SessionSummary {
  const s: SessionSummary = {
    stem: r.stem,
    date: r.session_date,
    hasTimeline: !!r.timeline_path,
  };
  if (r.recording_path) s.audio = r.recording_path;
  // data.ts folds __notes.md and __running.md into one `notes` field — both
  // add() calls write it, last write wins; __running.md sorts after
  // __notes.md so it wins the fs scan. Prefer running_notes to mirror that.
  const notes = r.running_path ?? r.notes_path;
  if (notes) s.notes = notes;
  if (r.transcript_path) s.transcript = r.transcript_path;
  if (r.timeline_path) s.timeline = r.timeline_path;
  // data.ts segmentCount = timeline.json array length; transcript_segments
  // holds one row per timeline entry, so prefer the live count and only fall
  // back to the journal-maintained seg_count column.
  if (s.hasTimeline) {
    const n = r.seg_rows > 0 ? r.seg_rows : r.seg_count;
    if (typeof n === "number") s.segmentCount = n;
  }
  if (r.start_time) s.time = r.start_time.slice(0, 5); // HH:MM:SS → HH:MM
  if (r.join_url) s.joinUrl = r.join_url;
  if (r.title && r.title.trim()) s.title = r.title.slice(0, 80);
  if (r.stage) s.stage = r.stage;
  return s;
}

/** data.ts sessions(course): newest first.
 *  `owner` (users.id) filters to that user's sessions; undefined omits the
 *  filter (unauthenticated local dev / DB_READS=1 without auth parity). */
export async function listSessions(course: string, owner?: string): Promise<SessionSummary[]> {
  const rows = await q<SessionRow>(
    `${SELECT_SESSIONS}
     where c.slug = $1${owner ? " and s.owner_user_id = $2" : ""}
     order by s.session_date desc, s.start_time desc nulls last, s.id desc`,
    owner ? [course, owner] : [course],
  );
  return rows.map(toSummary);
}

/** Single-session variant (session detail pages). Null when unknown.
 *  `owner` — same optional filter as listSessions. */
export async function getSession(course: string, stem: string, owner?: string): Promise<SessionSummary | null> {
  const rows = await q<SessionRow>(
    `${SELECT_SESSIONS}
     where c.slug = $1 and s.stem = $2${owner ? " and s.owner_user_id = $3" : ""}`,
    owner ? [course, stem, owner] : [course, stem],
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

/** Internal: session id by (course, stem) — shared with queries/notes.ts.
 *  `owner` — same optional filter; notes.ts threads it through. */
export async function sessionRowId(course: string, stem: string, owner?: string): Promise<number | null> {
  const rows = await q<{ id: number }>(
    `select s.id::int as id from sessions s
     join courses c on c.id = s.course_id where c.slug = $1 and s.stem = $2${owner ? " and s.owner_user_id = $3" : ""}`,
    owner ? [course, stem, owner] : [course, stem],
  );
  return rows[0]?.id ?? null;
}
