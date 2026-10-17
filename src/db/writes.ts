/** DB write path — single source of truth for the daemon's Phase-4 "DB-only"
 *  writes (2026-10-17). Recordings (blobs) and materials (source files) stay
 *  on the filesystem; everything else — sessions, artifacts (notes/transcripts/
 *  timelines as inline content), transcript segments, events, meeting mappings —
 *  lives in Postgres and is written here.
 *
 *  Raw SQL via the shared Pool (matches importer/ingest-embed convention; the
 *  daemon is long-lived so closeDb() is NOT called here). Every write is an
 *  idempotent upsert on the natural key, so re-runs converge. */
import { getPool } from "./client.ts";

/** lochis bootstrap owner (ddl.sql seed row). Multi-user claims rows later. */
export const OWNER = "00000000-0000-0000-0000-000000000001";

const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

/** Upsert a course and return its id (folder-union courses self-register). */
export async function courseId(slug: string, name?: string): Promise<number> {
  const r = await q(
    `insert into courses (slug, name, owner_user_id) values ($1,$2,$3)
     on conflict (slug) do update set name = excluded.name
     returning id`,
    [slug, name ?? slug.replace(/_/g, " "), OWNER],
  );
  return Number(r.rows[0].id);
}

export interface SessionInit {
  sessionDate: string;                 // "YYYY-MM-DD"
  startTime?: string | null;           // "HH:MM" or "HH:MM:SS"
  title?: string;
  joinUrl?: string | null;
  stage?: string;
  stageNote?: string | null;
  segCount?: number | null;
  durationSec?: number | null;
  sizeMb?: number | null;
}

/** Upsert a session by natural key (course_id, stem); return its id. */
export async function sessionId(courseId: number, stem: string, init: SessionInit = { sessionDate: stem.slice(0, 10) }): Promise<number> {
  const r = await q(
    `insert into sessions (course_id, stem, session_date, start_time, title, join_url, stage, stage_note, seg_count, duration_sec, size_mb, owner_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (course_id, stem) do update set
       session_date = excluded.session_date,
       start_time = coalesce(excluded.start_time, sessions.start_time),
       title = coalesce(nullif(excluded.title,''), sessions.title),
       join_url = coalesce(excluded.join_url, sessions.join_url),
       stage = excluded.stage,
       stage_note = coalesce(excluded.stage_note, sessions.stage_note),
       seg_count = coalesce(excluded.seg_count, sessions.seg_count),
       duration_sec = coalesce(excluded.duration_sec, sessions.duration_sec),
       size_mb = coalesce(excluded.size_mb, sessions.size_mb),
       updated_at = now()
     returning id`,
    [courseId, stem, init.sessionDate, init.startTime ?? null, init.title ?? "",
      init.joinUrl ?? null, init.stage ?? "recording", init.stageNote ?? null,
      init.segCount ?? null, init.durationSec ?? null, init.sizeMb ?? null, OWNER],
  );
  return Number(r.rows[0].id);
}

/** Partial session update (stage transitions etc.). */
export async function updateSession(courseId: number, stem: string, patch: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(", ");
  await q(
    `update sessions set ${sets}, updated_at = now() where course_id = $1 and stem = $2`,
    [courseId, stem, ...cols.map((c) => patch[c])],
  );
}

export interface ArtifactInit {
  content?: string | null;             // inline text (notes/transcripts/timeline md)
  storageUri?: string | null;          // file://… / s3://… (recordings)
  mimeType?: string | null;
  bytes?: number | null;
  checksum?: string | null;
  retainedUntil?: string | null;       // ISO timestamptz
}

/** Upsert a session artifact by (session_id, kind, rel_path). */
export async function upsertArtifact(sessionId: number, kind: string, relPath: string, init: ArtifactInit = {}): Promise<void> {
  await q(
    `insert into session_artifacts (session_id, kind, rel_path, content, storage_uri, mime_type, bytes, checksum, retained_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (session_id, kind, rel_path) do update set
       content = excluded.content,
       storage_uri = excluded.storage_uri,
       mime_type = excluded.mime_type,
       bytes = excluded.bytes,
       checksum = excluded.checksum,
       retained_until = excluded.retained_until,
       deleted_at = null,
       updated_at = now()`,
    [sessionId, kind, relPath, init.content ?? null, init.storageUri ?? null,
      init.mimeType ?? null, init.bytes ?? null, init.checksum ?? null, init.retainedUntil ?? null],
  );
}

export interface SegmentInit {
  segIndex: number;
  offsetSec: number;
  file?: string | null;
  transcript: string;
  visualNotes?: Array<{ t: number; note: string }>;
}

/** Upsert transcript segments by (session_id, offset_sec). */
export async function upsertSegments(sessionId: number, segs: SegmentInit[]): Promise<void> {
  if (!segs.length) return;
  const params: unknown[] = [];
  const tuples = segs.map((s) => {
    params.push(sessionId, s.segIndex, s.offsetSec, s.file ?? null, s.transcript, JSON.stringify(s.visualNotes ?? []));
    const b = params.length - 6;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb)`;
  });
  await q(
    `insert into transcript_segments (session_id, seg_index, offset_sec, file, transcript, visual_notes)
     values ${tuples.join(",")}
     on conflict (session_id, offset_sec) do update set
       seg_index = excluded.seg_index, file = excluded.file, transcript = excluded.transcript, visual_notes = excluded.visual_notes`,
    params,
  );
}

/** Append an activity event (status feed). */
export async function appendEvent(msg: string): Promise<void> {
  await q(`insert into activity_events (msg, owner_user_id) values ($1,$2)`, [msg, OWNER]);
}

/** Last N activity events, newest first. */
export async function listEvents(n = 60): Promise<{ ts: string; msg: string }[]> {
  const r = await q(`select ts, msg from activity_events order by ts desc limit $1`, [n]);
  return r.rows;
}

/** Upsert a meeting→course mapping (mapping.json replacement). */
export async function upsertMapping(matchTitle: string, normTitle: string, courseId: number, source = "manual"): Promise<void> {
  await q(
    `insert into meeting_mappings (match_title, norm_title, course_id, source, owner_user_id)
     values ($1,$2,$3,$4,$5)
     on conflict (match_title) do update set norm_title = excluded.norm_title, course_id = excluded.course_id, source = excluded.source`,
    [matchTitle, normTitle, courseId, source, OWNER],
  );
}

export async function deleteMapping(matchTitle: string): Promise<void> {
  await q(`delete from meeting_mappings where match_title = $1`, [matchTitle]);
}

export async function listMappings(): Promise<{ matchTitle: string; normTitle: string; courseId: number; source: string }[]> {
  const r = await q(`select match_title as "matchTitle", norm_title as "normTitle", course_id as "courseId", source from meeting_mappings order by match_title`);
  return r.rows;
}
