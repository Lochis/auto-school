/** Read-path switch: fs-impl (lib/data.ts + lib/deadlines.ts + lib/mapping.ts,
 *  byte-identical to today) vs db-impl (lib/db.ts, PostgreSQL). Selected per
 *  call via DB_READS=1 — no flag set ⇒ exactly the old code paths. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fsData from "./data";
import * as fsDeadlines from "./deadlines";
import * as fsMapping from "./mapping";
import * as db from "./db";
import type { Session } from "./data";
import type { DeadEntry } from "./deadlines";

export const dbReads = (): boolean => process.env.DB_READS === "1";

export const weekOf = fsData.weekOf; // pure fn, no io

// ── courses / sessions (parity with data.ts) ──────────────────────────────

export async function listCourses(): Promise<string[]> {
  return dbReads() ? db.courses() : fsData.courses();
}

export async function courseIconOf(slug: string): Promise<string | null> {
  return dbReads() ? db.courseIcon(slug) : fsData.courseIcon(slug);
}

export async function semesterStartOf(slug: string): Promise<string | null> {
  return dbReads() ? db.semesterStartOf(slug) : fsData.semesterStartOf(slug);
}

export async function listSessions(course: string): Promise<Session[]> {
  return dbReads() ? db.sessions(course) : fsData.sessions(course);
}

// ── notes / transcript markdown (parity with the /api/notes fs reads) ─────

export async function notesMarkdown(
  course: string,
  stem: string,
  kind: "notes" | "running" | "transcript",
): Promise<string | null> {
  if (dbReads()) return db.notesMarkdown(course, stem, kind);
  const file = (f: string): string | null => {
    try { return readFileSync(join(fsData.DATA_DIR, "notes", course, f), "utf8"); } catch { return null; }
  };
  if (kind === "notes") return file(`${stem}__notes.md`);
  if (kind === "running") return file(`${stem}__running.md`);
  return file(`${stem}__transcript.md`) ?? fsData.timelineToMd(`notes/${course}/${stem}__timeline.json`);
}

// ── timeline entries for the session detail page ──────────────────────────

export async function timelineEntries(course: string, stem: string, rel?: string): Promise<db.TimelineEntry[]> {
  if (dbReads()) return db.timelineEntries(course, stem);
  if (!rel) return [];
  try {
    const j = JSON.parse(readFileSync(join(fsData.DATA_DIR, rel), "utf8"));
    return Array.isArray(j) ? (j as db.TimelineEntry[]) : [];
  } catch {
    return [];
  }
}

// ── deadlines / checklists / mapping ──────────────────────────────────────

export async function deadlinesList(): Promise<DeadEntry[]> {
  return dbReads() ? db.readDeadlines() : fsDeadlines.readDeadlines();
}

export async function mappingSnap(): Promise<{ mapping: fsMapping.Mapping; folders: string[]; candidates: string[] }> {
  if (dbReads()) return db.mappingSnap();
  const mapping = fsMapping.readMapping();
  return { mapping, folders: fsMapping.folders(), candidates: fsMapping.candidateTitles(mapping) };
}
