/** Read-path switch: fs-impl (lib/data.ts + lib/deadlines.ts + lib/mapping.ts,
 *  byte-identical to today) vs db-impl (lib/db.ts, PostgreSQL). Selected per
 *  call via DB_READS=1. Additionally, when PG is merely *configured*
 *  (pgAvailable) the fs-mode readers below delegate/merge with lib/db.ts —
 *  the pipeline now writes only to Postgres, so out/sessions.json,
 *  mapping.json and user-data/deadlines.json no longer receive updates. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fsData from "./data";
import * as fsDeadlines from "./deadlines";
import * as fsMapping from "./mapping";
import * as db from "./db";
import type { Session } from "./data";
import type { DeadEntry } from "./deadlines";

export const dbReads = (): boolean => process.env.DB_READS === "1";

/** True when a Postgres is configured (DATABASE_URL or PG* env) — i.e. the
 *  daemon's PG writer is the live data source, even in fs read mode. Used to
 *  stop fs-mode readers from returning files nothing writes anymore. */
export const pgAvailable = (): boolean =>
  Boolean(process.env.DATABASE_URL || process.env.PGHOST);

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
  if (dbReads()) return db.sessions(course);
  const fsList = fsData.sessions(course);
  if (!pgAvailable()) return fsList;
  // PG is configured: merge in artifact-derived notes/transcript/timeline and
  // joinUrls (session_artifacts + sessions.join_url) that the fs scan can no
  // longer discover — the pipeline no longer writes those files to disk. The
  // fs list still contributes recordings and fills fields PG lacks (import
  // pending / pre-PG sessions), so nothing regresses while tables fill.
  const pgList = await db.sessions(course);
  if (!pgList.length) return fsList;
  const overlay = (pg: Session, fs: Session): Session => {
    const m = { ...fs };
    if (pg.audio !== undefined) m.audio = pg.audio;
    if (pg.notes !== undefined) m.notes = pg.notes;
    if (pg.transcript !== undefined) m.transcript = pg.transcript;
    if (pg.timeline !== undefined) m.timeline = pg.timeline;
    if (pg.segmentCount !== undefined) m.segmentCount = pg.segmentCount;
    if (pg.time !== undefined) m.time = pg.time;
    if (pg.title !== undefined) m.title = pg.title;
    if (pg.joinUrl !== undefined) m.joinUrl = pg.joinUrl;
    if (pg.hasTimeline) m.hasTimeline = true;
    return m;
  };
  const byStem = new Map(fsList.map((s) => [s.stem, s]));
  for (const pg of pgList) {
    const fs = byStem.get(pg.stem);
    byStem.set(pg.stem, fs ? overlay(pg, fs) : pg);
  }
  return [...byStem.values()].sort((a, b) => (b.date + (b.time ?? "")).localeCompare(a.date + (a.time ?? "")));
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
  // user-data/deadlines.json has no writer anymore — when PG is configured
  // the deadlines table is the only live copy.
  if (dbReads() || pgAvailable()) return db.readDeadlines();
  return fsDeadlines.readDeadlines();
}

export async function mappingSnap(): Promise<{ mapping: fsMapping.Mapping; folders: string[]; candidates: string[] }> {
  if (dbReads()) return db.mappingSnap();
  if (pgAvailable()) {
    // mapping.json has no writer anymore — meeting_mappings is the source of
    // truth. Keep fs folders (recordings dirs may exist pre-import) and the
    // fs candidate scan (still reads the daemon's calendar/timeline artifacts).
    const snap = await db.mappingSnap();
    return {
      mapping: snap.mapping,
      folders: [...new Set([...snap.folders, ...fsMapping.folders()])].sort(),
      candidates: fsMapping.candidateTitles(snap.mapping),
    };
  }
  const mapping = fsMapping.readMapping();
  return { mapping, folders: fsMapping.folders(), candidates: fsMapping.candidateTitles(mapping) };
}
