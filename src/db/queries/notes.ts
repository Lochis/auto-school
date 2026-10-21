/** Phase-3 read queries — artifact text (readText parity), transcript timeline
 *  rendering. Postgres replacement for frontend/src/lib/data.ts readText() +
 *  timelineToMd(), and for the timeline.json shape consumed by the session
 *  detail page (transcript-timeline.tsx). Content lives inline in
 *  session_artifacts.content — no filesystem access. */
import { getPool } from "../pg.ts";
import { sessionRowId } from "./sessions.ts";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await getPool().query(text, params)).rows as T[];

/** data.ts readText(rel): raw text behind a DATA_DIR-relative path, or null.
 *  DB equivalent: the artifact's content column (notes / running_notes /
 *  transcript / timeline kinds are imported with inline content). Recordings
 *  have content = null and fs-only files that were never imported as
 *  artifacts (e.g. __title.txt — the importer folds it into sessions.title)
 *  return null — that divergence is a known Phase-3 gap, not a crash.
 *  `owner` (users.id) restricts to that user's session's artifacts; undefined
 *  omits the filter (local dev parity — frontend gates null on untrusted
 *  auth headers). */
export async function readText(rel: string, owner?: string): Promise<string | null> {
  const rows = await q<{ content: string | null }>(
    `select a.content from session_artifacts a
     join sessions s on s.id = a.session_id
     where a.rel_path = $1 and a.deleted_at is null${owner ? " and s.owner_user_id = $2" : ""}
     order by a.updated_at desc limit 1`,
    owner ? [rel, owner] : [rel],
  );
  const c = rows[0]?.content;
  return typeof c === "string" ? c : null;
}

/** Latest artifact of a kind for a (course, stem) — content column.
 *  `owner` — optional owner filter on the session row. */
export async function artifactContent(course: string, stem: string, kind: string, owner?: string): Promise<string | null> {
  const rows = await q<{ content: string | null }>(
    `select a.content from session_artifacts a
     join sessions s on s.id = a.session_id
     join courses c on c.id = s.course_id
     where c.slug = $1 and s.stem = $2 and a.kind = $3 and a.deleted_at is null${owner ? " and s.owner_user_id = $4" : ""}
     order by a.updated_at desc limit 1`,
    owner ? [course, stem, kind, owner] : [course, stem, kind],
  );
  const c = rows[0]?.content;
  return typeof c === "string" ? c : null;
}

/** /api/notes kinds — fs path: notes→__notes.md, running→__running.md,
 *  transcript→__transcript.md ?? timeline render. `owner` threads through. */
export async function notesMarkdown(
  course: string,
  stem: string,
  kind: "notes" | "running" | "transcript",
  owner?: string,
): Promise<string | null> {
  if (kind === "notes") return artifactContent(course, stem, "notes", owner);
  if (kind === "running") return artifactContent(course, stem, "running_notes", owner);
  return (await artifactContent(course, stem, "transcript", owner)) ?? (await timelineToMd(course, stem, owner));
}

interface SegRow {
  file: string | null;
  offset_sec: number;
  transcript: string;
  visual_notes: Array<{ t: number | string; note: string }> | null;
}

/** Transcript_segments for a session, offset-ordered (shared by timelineToMd +
 *  timelineEntries). Empty when the session is unknown. */
async function segments(sid: number): Promise<SegRow[]> {
  return q<SegRow>(
    `select file, offset_sec, transcript, visual_notes
     from transcript_segments where session_id = $1 order by offset_sec`,
    [sid],
  );
}

/** data.ts timelineToMd(rel) rendering, sourced from transcript_segments
 *  instead of the timeline.json file: one "**[m:ss]** text" block per segment,
 *  segments with no speech skipped, "# Transcript" header, null when nothing
 *  renders. Seconds rounding mirrors data.ts exactly (Math.round, pad 2). */
export async function timelineToMd(course: string, stem: string, owner?: string): Promise<string | null> {
  const sid = await sessionRowId(course, stem, owner);
  if (!sid) return null;
  const segs = await segments(sid);
  const lines = segs
    .filter((e) => e.transcript?.trim())
    .map((e) => {
      const m = Math.floor(e.offset_sec / 60);
      const s = String(Math.round(e.offset_sec % 60)).padStart(2, "0");
      return `**[${m}:${s}]** ${e.transcript.trim()}`;
    });
  return lines.length ? `# Transcript\n\n${lines.join("\n\n")}` : null;
}

/** timeline.json shape for the session detail page: one entry per segment with
 *  visualNotes timestamps normalized to "m:ss" STRINGS (the fs timeline.json
 *  legacy format stored them that way; the importer converted to seconds —
 *  this converts back, same math as frontend/src/lib/db.ts). */
export interface TimelineEntry {
  meeting: string;
  offsetSec: number;
  transcript: string;
  visualNotes: { t: string; note: string }[];
}

export async function timelineEntries(course: string, stem: string, owner?: string): Promise<TimelineEntry[]> {
  const sid = await sessionRowId(course, stem, owner);
  if (!sid) return [];
  const segs = await segments(sid);
  const meetingTitle = stem.split("__")[1]?.replace(/_/g, " ").trim() ?? "";
  return segs.map((r) => ({
    meeting: r.file ?? meetingTitle, // fs timeline.json "file" per segment
    offsetSec: r.offset_sec,
    transcript: r.transcript ?? "",
    visualNotes: (r.visual_notes ?? []).map((v) => {
      const sec = typeof v.t === "number" ? v.t : parseMs(v.t);
      return { t: `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`, note: v.note };
    }),
  }));
}

/** "m:ss" (or bare seconds) → seconds; unparseable → 0. */
function parseMs(t: string): number {
  const m = t.match(/^(\d{1,3}):(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
