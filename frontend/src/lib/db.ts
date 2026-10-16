/** PostgreSQL read path (opt-in via DB_READS=1) — mirrors the shapes that
 *  lib/data.ts + lib/deadlines.ts + lib/mapping.ts produce from the fs
 *  today. Schema: src/db/schema.ts (root repo). All queries tolerate empty
 *  tables (import may still be running) and return [] gracefully.
 *
 *  Connection: DATABASE_URL, or PG* env vars when unset (pg native). The
 *  pool is lazy — processes that never hit a db fn never connect. */
import { Pool } from "pg";
import type { Session } from "./data";
import type { DeadEntry } from "./deadlines";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL, // undefined → pg falls back to PG* env
      max: 5,
      connectionTimeoutMillis: 3000,
    });
    pool.on("error", () => { /* keep dev server alive on idle disconnects */ });
  }
  return pool;
}

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  try {
    const res = await getPool().query(text, params as never[]);
    return res.rows as T[];
  } catch (e) {
    console.error(`[db] ${String(e).slice(0, 200)}`);
    return [];
  }
}

// ── shared helpers (ports of the fs-path logic — parity, not LIKE-magic) ──

/** lib/data.ts joinUrl fuzzy-match normalizer */
const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/** daemon deadline id hash (src/daemon.ts dlId) — stable course|title → hex */
export function dlId(course: string, title: string): string {
  let h = 5381;
  for (const ch of `${course}|${title.toLowerCase().trim()}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(16);
}

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

// ── courses ───────────────────────────────────────────────────────────────

export async function courses(): Promise<string[]> {
  const rows = await q<{ slug: string }>(`SELECT slug FROM courses ORDER BY slug`);
  return rows.map((r) => r.slug);
}

export async function courseIcon(slug: string): Promise<string | null> {
  const rows = await q<{ icon: string | null }>(`SELECT icon FROM courses WHERE slug = $1`, [slug]);
  return rows[0]?.icon ?? null;
}

export async function semesterStartOf(slug: string): Promise<string | null> {
  const rows = await q<{ semester_start: Date | null }>(`SELECT semester_start FROM courses WHERE slug = $1`, [slug]);
  const d = rows[0]?.semester_start;
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

// ── sessions (+ artifacts) — shape-parity with lib/data.ts sessions() ─────

interface SessionRow {
  stem: string;
  date: string;
  start_time: string | null;
  title: string;
  join_url: string | null;
  seg_count: number | null;
  seg_rows: number;
  kind: string | null;
  rel_path: string | null;
}

export async function sessions(course: string): Promise<Session[]> {
  const rows = await q<SessionRow>(
    `SELECT s.stem, s.session_date::text AS date, s.start_time::text AS start_time,
            s.title, s.join_url, s.seg_count,
            (SELECT COUNT(*)::int FROM transcript_segments ts WHERE ts.session_id = s.id) AS seg_rows,
            a.kind, a.rel_path
     FROM sessions s
     JOIN courses c ON c.id = s.course_id
     LEFT JOIN session_artifacts a ON a.session_id = s.id AND a.deleted_at IS NULL
     WHERE c.slug = $1
     ORDER BY s.id, a.id`,
    [course],
  );
  const byStem = new Map<string, Session>();
  for (const r of rows) {
    const s: Session = byStem.get(r.stem) ?? { stem: r.stem, date: r.date, hasTimeline: false };
    if (r.kind === "recording") s.audio = r.rel_path ?? undefined;
    if (r.kind === "notes" || r.kind === "running_notes") s.notes = r.rel_path ?? undefined;
    if (r.kind === "transcript") s.transcript = r.rel_path ?? undefined;
    if (r.kind === "timeline") {
      s.hasTimeline = true;
      s.timeline = r.rel_path ?? undefined;
    }
    if (typeof r.seg_count === "number") s.segmentCount = r.seg_count;
    else if (s.hasTimeline && r.seg_rows > 0) s.segmentCount = r.seg_rows;
    if (r.start_time) s.time = r.start_time.slice(0, 5); // HH:MM:SS → HH:MM
    if (r.title && r.title.trim()) s.title = r.title.slice(0, 80);
    if (r.join_url) s.joinUrl = r.join_url;
    byStem.set(r.stem, s);
  }
  // joinUrl fallback for rows the importer left null — port of data.ts's
  // fuzzy sessions.json title match (same normalize + frag.slice(0,20) logic),
  // against session titles that DO carry a join_url.
  const missing = [...byStem.values()].filter((s) => !s.joinUrl);
  if (missing.length) {
    const withUrl = await q<{ title: string; join_url: string }>(
      `SELECT DISTINCT title, join_url FROM sessions WHERE join_url IS NOT NULL`,
    );
    for (const s of missing) {
      const frag = norm(s.stem.split("__")[1] ?? "");
      if (!frag) continue;
      const hit = withUrl.find((t) => norm(t.title).includes(frag.slice(0, 20)));
      if (hit) s.joinUrl = hit.join_url;
    }
  }
  return [...byStem.values()].sort((a, b) => (b.date + (b.time ?? "")).localeCompare(a.date + (a.time ?? ""))); // newest first, as data.ts
}

// ── artifact text (notes / transcript markdown) — /api/notes parity ───────

async function artifactContent(course: string, stem: string, kind: string): Promise<string | null> {
  const rows = await q<{ content: string | null }>(
    `SELECT a.content FROM session_artifacts a
     JOIN sessions s ON s.id = a.session_id
     JOIN courses c ON c.id = s.course_id
     WHERE c.slug = $1 AND s.stem = $2 AND a.kind = $3 AND a.deleted_at IS NULL
     ORDER BY a.updated_at DESC LIMIT 1`,
    [course, stem, kind],
  );
  return rows[0]?.content ?? null;
}

async function sessionId(course: string, stem: string): Promise<number | null> {
  const rows = await q<{ id: string }>(
    `SELECT s.id FROM sessions s JOIN courses c ON c.id = s.course_id WHERE c.slug = $1 AND s.stem = $2`,
    [course, stem],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

interface SegRow { offset_sec: number; transcript: string }

/** Render transcript_segments as the same "[m:ss] text" markdown timelineToMd
 *  produces from timeline.json. */
export async function timelineToMd(course: string, stem: string): Promise<string | null> {
  const sid = await sessionId(course, stem);
  if (!sid) return null;
  const segs = await q<SegRow>(
    `SELECT offset_sec, transcript FROM transcript_segments WHERE session_id = $1 ORDER BY offset_sec`,
    [sid],
  );
  const lines = segs
    .filter((e) => e.transcript?.trim())
    .map((e) => {
      const m = Math.floor(e.offset_sec / 60);
      const s = String(Math.round(e.offset_sec % 60)).padStart(2, "0");
      return `**[${m}:${s}]** ${e.transcript.trim()}`;
    });
  return lines.length ? `# Transcript\n\n${lines.join("\n\n")}` : null;
}

/** /api/notes kinds — fs path: notes→__notes.md only, running→__running.md,
 *  transcript→__transcript.md ?? timeline render. */
export async function notesMarkdown(course: string, stem: string, kind: "notes" | "running" | "transcript"): Promise<string | null> {
  if (kind === "notes") return artifactContent(course, stem, "notes");
  if (kind === "running") return artifactContent(course, stem, "running_notes");
  return (await artifactContent(course, stem, "transcript")) ?? (await timelineToMd(course, stem));
}

// ── timeline entries for the session detail page (transcript-timeline.tsx) ─

export interface TimelineEntry {
  meeting: string;
  offsetSec: number;
  transcript: string;
  visualNotes: { t: string; note: string }[];
}

export async function timelineEntries(course: string, stem: string): Promise<TimelineEntry[]> {
  const sid = await sessionId(course, stem);
  if (!sid) return [];
  const rows = await q<{ file: string | null; offset_sec: number; transcript: string; visual_notes: { t: number; note: string }[] }>(
    `SELECT file, offset_sec, transcript, visual_notes FROM transcript_segments WHERE session_id = $1 ORDER BY offset_sec`,
    [sid],
  );
  const meetingTitle = stem.split("__")[1]?.replace(/_/g, " ").trim() ?? "";
  return rows.map((r) => ({
    meeting: r.file ?? meetingTitle,
    offsetSec: r.offset_sec,
    transcript: r.transcript ?? "",
    visualNotes: (r.visual_notes ?? []).map((v) => ({
      t: `${Math.floor(v.t / 60)}:${String(Math.round(v.t % 60)).padStart(2, "0")}`,
      note: v.note,
    })),
  }));
}

// ── deadlines (+ parts) — lib/deadlines.ts + daemon /deadlines GET shapes ─

export type DbDeadline = DeadEntry & {
  userNote?: string;
  dueManual?: boolean;
  parts?: { title: string; due: string | null; note: string; done: boolean }[];
};

interface DlRow {
  id: string;
  legacy_id: string | null;
  course: string;
  title: string;
  due: string | null;
  due_manual: boolean;
  kind: string;
  spread: boolean;
  start_by: string | null;
  note: string;
  source: string;
  confidence: string;
  done: boolean;
  done_at: Date | null;
  user_note: string | null;
  stale: number | null;
}

const legacyId = (r: Pick<DlRow, "legacy_id" | "course" | "title">): string =>
  r.legacy_id ?? dlId(r.course, r.title);

export async function readDeadlines(): Promise<DbDeadline[]> {
  const rows = await q<DlRow>(
    `SELECT d.id::text, d.legacy_id, c.slug AS course, d.title, d.due::text AS due, d.due_manual,
            d.kind, d.spread, d.start_by::text AS start_by, d.note, d.source, d.confidence,
            d.done, d.done_at, d.user_note, d.stale
     FROM deadlines d JOIN courses c ON c.id = d.course_id
     ORDER BY c.slug, d.due NULLS LAST, d.title`,
  );
  if (!rows.length) return [];
  const parts = await q<{ deadline_id: string; title: string; due: string | null; note: string; done: boolean }>(
    `SELECT p.deadline_id::text, p.title, p.due::text AS due, p.note, p.done
     FROM deadline_parts p ORDER BY p.id`,
  );
  const byDl = new Map<string, DbDeadline[]>();
  for (const r of rows) {
    const e: DbDeadline = {
      id: legacyId(r),
      course: r.course,
      title: r.title,
      due: r.due,
      kind: r.kind,
      spread: r.spread,
      startBy: r.start_by,
      note: r.note,
      source: r.source,
      confidence: r.confidence,
      done: r.done,
      doneAt: ms(r.done_at),
      ...(r.user_note != null ? { userNote: r.user_note } : {}),
      dueManual: r.due_manual,
      ...(r.stale != null ? { stale: r.stale } : {}),
    };
    const list = byDl.get(r.id) ?? [];
    list.push(e);
    byDl.set(r.id, list);
  }
  for (const p of parts) {
    const dl = byDl.get(p.deadline_id);
    if (dl?.[0]) dl[0].parts = [...(dl[0].parts ?? []), { title: p.title, due: p.due, note: p.note, done: p.done }];
  }
  // duplicate-id guard, same as readDeadlines()/uniqIds(): first wins, ~N suffix
  const seen = new Set<string>();
  const out: DbDeadline[] = [];
  for (const group of byDl.values()) {
    for (const e of group) {
      let id = e.id;
      if (!id || seen.has(id)) {
        let n = 1;
        while (seen.has(`${id}~${n}`)) n++;
        id = `${id}~${n}`;
      }
      seen.add(id);
      out.push({ ...e, id });
    }
  }
  return out;
}

/** daemon /deadlines GET merged shape: { deadlines, suggestions, foldedChildren } */
export async function deadlinesFeed(): Promise<{
  deadlines: DbDeadline[];
  suggestions: { parentId: string; parentTitle: string; childId: string; childTitle: string; childDue: string | null }[];
  foldedChildren: { key: string; parentId: string; parentTitle: string; title: string; due: string | null; done: boolean; at: number }[];
}> {
  const deadlines = await readDeadlines();
  const ids = new Set(deadlines.map((d) => d.id));
  const sug = await q<{ parent_id: string; p_legacy: string | null; p_course: string; p_title: string; child_id: string; c_legacy: string | null; c_course: string; c_title: string; c_due: string | null }>(
    `SELECT f.parent_id::text AS parent_id, p.legacy_id AS p_legacy, pc.slug AS p_course, p.title AS p_title,
            f.child_id::text AS child_id, ch.legacy_id AS c_legacy, cc.slug AS c_course, ch.title AS c_title, ch.due::text AS c_due
     FROM deadline_folds f
     JOIN deadlines p ON p.id = f.parent_id JOIN courses pc ON pc.id = p.course_id
     JOIN deadlines ch ON ch.id = f.child_id JOIN courses cc ON cc.id = ch.course_id
     WHERE f.status = 'pending'`,
  );
  const suggestions = sug
    .map((r) => ({
      parentId: r.p_legacy ?? dlId(r.p_course, r.p_title),
      parentTitle: r.p_title,
      childId: r.c_legacy ?? dlId(r.c_course, r.c_title),
      childTitle: r.c_title,
      childDue: r.c_due,
    }))
    .filter((s) => ids.has(s.childId) && ids.has(s.parentId)); // daemon filters to live rows
  const folds = await q<{ p_legacy: string | null; p_course: string; p_title: string; c_legacy: string | null; c_course: string; c_title: string; child_snapshot: Record<string, unknown>; folded_at: Date | null }>(
    `SELECT p.legacy_id AS p_legacy, pc.slug AS p_course, p.title AS p_title,
            ch.legacy_id AS c_legacy, cc.slug AS c_course, ch.title AS c_title,
            f.child_snapshot, f.folded_at
     FROM deadline_folds f
     JOIN deadlines p ON p.id = f.parent_id JOIN courses pc ON pc.id = p.course_id
     LEFT JOIN deadlines ch ON ch.id = f.child_id LEFT JOIN courses cc ON cc.id = ch.course_id
     WHERE f.status = 'accepted'`,
  );
  const foldedChildren = folds.map((r) => {
    const snap = r.child_snapshot ?? {};
    const parentId = r.p_legacy ?? dlId(r.p_course, r.p_title);
    const childId = r.c_legacy ?? (r.c_course && typeof r.c_title === "string" ? dlId(r.c_course, r.c_title) : "");
    return {
      key: childId,
      parentId,
      parentTitle: r.p_title,
      title: String(snap.title ?? ""),
      due: typeof snap.due === "string" ? snap.due : null,
      done: Boolean(snap.done),
      at: ms(r.folded_at) ?? 0,
    };
  }).filter((f) => ids.has(f.parentId)); // daemon keeps only parents still present
  return { deadlines, suggestions, foldedChildren };
}

// ── checklists — daemon /checklists GET shape ─────────────────────────────

export interface ChecklistItem { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean }
export interface Checklist { deadlineId: string; course: string; title: string; items: ChecklistItem[]; updatedAt: number }

export async function checklists(): Promise<Checklist[]> {
  const rows = await q<{ deadline_id: string; legacy_id: string | null; course: string; title: string; legacy_key: string; text: string; done: boolean; done_at: Date | null; manual: boolean; position: number; updated_at: Date }>(
    `SELECT ci.deadline_id::text AS deadline_id, d.legacy_id, c.slug AS course, d.title,
            ci.legacy_key, ci.text, ci.done, ci.done_at, ci.manual, ci.position, ci.updated_at
     FROM checklist_items ci
     JOIN deadlines d ON d.id = ci.deadline_id
     JOIN courses c ON c.id = d.course_id
     ORDER BY d.id, ci.position, ci.id`,
  );
  const byDl = new Map<string, Checklist>();
  for (const r of rows) {
    const did = r.legacy_id ?? dlId(r.course, r.title);
    const ck = byDl.get(r.deadline_id) ?? {
      deadlineId: did,
      course: r.course,
      title: r.title,
      items: [],
      updatedAt: r.updated_at.getTime(),
    };
    ck.items.push({
      id: r.legacy_key,
      text: r.text,
      done: r.done,
      doneAt: ms(r.done_at),
      ...(r.manual ? { manual: true } : {}),
    });
    ck.updatedAt = Math.max(ck.updatedAt, r.updated_at.getTime());
    byDl.set(r.deadline_id, ck);
  }
  return [...byDl.values()];
}

// ── mapping — daemon GET { mapping, folders, candidates } shape ───────────
// (candidates come from out/calendar-events.txt on the fs; there is no DB
//  table for the raw calendar dump → empty list in db mode.)

export async function mappingSnap(): Promise<{ mapping: Record<string, string>; folders: string[]; candidates: string[] }> {
  const rows = await q<{ match_title: string; slug: string }>(
    `SELECT m.match_title, c.slug FROM meeting_mappings m JOIN courses c ON c.id = m.course_id ORDER BY m.match_title`,
  );
  const mapping: Record<string, string> = {};
  for (const r of rows) mapping[r.match_title.trim()] = r.slug;
  return { mapping, folders: await courses(), candidates: [] };
}
