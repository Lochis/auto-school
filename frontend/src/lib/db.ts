/** PostgreSQL read path (opt-in via DB_READS=1) — mirrors the shapes that
 *  lib/data.ts + lib/deadlines.ts + lib/mapping.ts produce from the fs
 *  today. courses()/sessions()/notesMarkdown()/timelineToMd()/timelineEntries()
 *  delegate to src/db/queries/* (the parity-validated single source of truth);
 *  deadlines/checklists/mapping have no src/db/queries equivalent yet and keep
 *  their inline SQL here.
 *
 *  Connection: shared Pool from src/db/pg.ts (DATABASE_URL or PG* env). */
import type { Session } from "./data";
import type { DeadEntry } from "./deadlines";
import { getPool } from "../../../src/db/pg.ts";
import { listCourses, courseMeta } from "../../../src/db/queries/courses.ts";
import { listSessions } from "../../../src/db/queries/sessions.ts";
import {
  notesMarkdown as pgNotesMarkdown,
  timelineToMd as pgTimelineToMd,
  timelineEntries as pgTimelineEntries,
  type TimelineEntry,
} from "../../../src/db/queries/notes.ts";

export { getPool };

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  try {
    const res = await getPool().query(text, params as never[]);
    return res.rows as T[];
  } catch (e) {
    console.error(`[db] ${String(e).slice(0, 200)}`);
    return [];
  }
}

// ── shared helpers (deadline id hash — parity with src/daemon.ts dlId) ─────

/** daemon deadline id hash (src/daemon.ts dlId) — stable course|title → hex */
export function dlId(course: string, title: string): string {
  let h = 5381;
  for (const ch of `${course}|${title.toLowerCase().trim()}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(16);
}

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

// ── courses — delegate to src/db/queries/courses.ts ───────────────────────

export async function courses(owner: string): Promise<string[]> {
  return listCourses(owner);
}

export async function courseIcon(slug: string): Promise<string | null> {
  return (await courseMeta(slug))?.icon ?? null;
}

export async function semesterStartOf(slug: string): Promise<string | null> {
  return (await courseMeta(slug))?.semesterStart ?? null;
}

// ── sessions — delegate to src/db/queries/sessions.ts ─────────────────────

export async function sessions(course: string, owner: string): Promise<Session[]> {
  return listSessions(course, owner);
}

// ── artifact text — delegate to src/db/queries/notes.ts ───────────────────

export async function timelineToMd(course: string, stem: string, owner: string): Promise<string | null> {
  return pgTimelineToMd(course, stem, owner);
}

export async function notesMarkdown(course: string, stem: string, kind: "notes" | "running" | "transcript", owner: string): Promise<string | null> {
  return pgNotesMarkdown(course, stem, kind, owner);
}

// ── timeline entries for the session detail page (transcript-timeline.tsx) ─

export type { TimelineEntry };

export async function timelineEntries(course: string, stem: string, owner: string): Promise<TimelineEntry[]> {
  return pgTimelineEntries(course, stem, owner);
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

export async function readDeadlines(owner: string | undefined): Promise<DbDeadline[]> {
  const rows = await q<DlRow>(
    `SELECT d.id::text, d.legacy_id, c.slug AS course, d.title, d.due::text AS due, d.due_manual,
            d.kind, d.spread, d.start_by::text AS start_by, d.note, d.source, d.confidence,
            d.done, d.done_at, d.user_note, d.stale
     FROM deadlines d JOIN courses c ON c.id = d.course_id
     WHERE NOT EXISTS (SELECT 1 FROM deadline_folds f WHERE f.child_id = d.id AND f.status = 'accepted')
       -- ^ same fold-tombstone filter as the daemon's readDl(): folded children
       -- are not standalone deadlines; without this the UI lists them as
       -- toggleable items whose ids the daemon rejects (404 "no such id")
       ${owner ? "AND d.owner_user_id = $1" : ""}
     ORDER BY c.slug, d.due NULLS LAST, d.title`,
    owner ? [owner] : [],
  );
  if (!rows.length) return [];
  const parts = await q<{ deadline_id: string; title: string; due: string | null; note: string; done: boolean }>(
    `SELECT p.deadline_id::text, p.title, p.due::text AS due, p.note, p.done
     FROM deadline_parts p
     ${owner ? "WHERE p.deadline_id IN (SELECT id FROM deadlines WHERE owner_user_id = $1)" : ""}
     ORDER BY p.id`,
    owner ? [owner] : [],
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
export async function deadlinesFeed(owner: string | undefined): Promise<{
  deadlines: DbDeadline[];
  suggestions: { parentId: string; parentTitle: string; childId: string; childTitle: string; childDue: string | null }[];
  foldedChildren: { key: string; parentId: string; parentTitle: string; title: string; due: string | null; done: boolean; at: number }[];
}> {
  const deadlines = await readDeadlines(owner);
  const ids = new Set(deadlines.map((d) => d.id));
  const sug = await q<{ parent_id: string; p_legacy: string | null; p_course: string; p_title: string; child_id: string; c_legacy: string | null; c_course: string; c_title: string; c_due: string | null }>(
    `SELECT f.parent_id::text AS parent_id, p.legacy_id AS p_legacy, pc.slug AS p_course, p.title AS p_title,
            f.child_id::text AS child_id, ch.legacy_id AS c_legacy, cc.slug AS c_course, ch.title AS c_title, ch.due::text AS c_due
     FROM deadline_folds f
     JOIN deadlines p ON p.id = f.parent_id JOIN courses pc ON pc.id = p.course_id
     JOIN deadlines ch ON ch.id = f.child_id JOIN courses cc ON cc.id = ch.course_id
     WHERE f.status = 'pending'${owner ? " AND p.owner_user_id = $1" : ""}`,
    owner ? [owner] : [],
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
     WHERE f.status = 'accepted'${owner ? " AND p.owner_user_id = $1" : ""}`,
    owner ? [owner] : [],
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

export async function checklists(owner: string | undefined): Promise<Checklist[]> {
  const rows = await q<{ deadline_id: string; legacy_id: string | null; course: string; title: string; legacy_key: string; text: string; done: boolean; done_at: Date | null; manual: boolean; position: number; updated_at: Date }>(
    `SELECT ci.deadline_id::text AS deadline_id, d.legacy_id, c.slug AS course, d.title,
            ci.legacy_key, ci.text, ci.done, ci.done_at, ci.manual, ci.position, ci.updated_at
     FROM checklist_items ci
     JOIN deadlines d ON d.id = ci.deadline_id
     JOIN courses c ON c.id = d.course_id
     ${owner ? "WHERE d.owner_user_id = $1" : ""}
     ORDER BY d.id, ci.position, ci.id`,
    owner ? [owner] : [],
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

export async function mappingSnap(owner: string): Promise<{ mapping: Record<string, string>; folders: string[]; candidates: string[] }> {
  const rows = await q<{ match_title: string; slug: string }>(
    `SELECT m.match_title, c.slug FROM meeting_mappings m JOIN courses c ON c.id = m.course_id
     WHERE m.owner_user_id = $1 ORDER BY m.match_title`,
    [owner],
  );
  const mapping: Record<string, string> = {};
  for (const r of rows) mapping[r.match_title.trim()] = r.slug;
  return { mapping, folders: await courses(owner), candidates: [] };
}
