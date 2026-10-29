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
import { ownerId, SYSTEM_OWNER } from "./owner";
import { getActiveRecorder } from "../../../src/db/recorders.ts";
import type { Session } from "./data";
import type { DeadEntry } from "./deadlines";

export const dbReads = (): boolean => process.env.DB_READS === "1";

/** True when a Postgres is configured (DATABASE_URL or PG* env) — i.e. the
 *  daemon's PG writer is the live data source, even in fs read mode. Used to
 *  stop fs-mode readers from returning files nothing writes anymore. */
export const pgAvailable = (): boolean =>
  Boolean(process.env.DATABASE_URL || process.env.PGHOST);

/** Resolve the daemon base URL for a request (recorder-split.md §5 step 2).
 *  Registry-first: a fresh heartbeat row for this owner → its endpoint;
 *  otherwise the transitional BACKEND_URL; null = daemon-less (no recorder
 *  attached — callers return their existing offline/502 shape). */
export interface ResolvedRecorder {
  base: string | null;
  mode: string | null;
}

export async function resolveRecorder(
  ownerId: string | undefined,
): Promise<ResolvedRecorder> {
  if (ownerId) {
    try {
      const rec = await getActiveRecorder(ownerId);
      if (rec?.endpoint) return { base: rec.endpoint, mode: rec.mode };
    } catch {
      // DB down — fall through to BACKEND_URL, do not fail the request
    }
  }
  const fallback = process.env.BACKEND_URL ?? null;
  return { base: fallback, mode: fallback ? "inbound" : null };
}

export async function resolveRecorderBase(
  ownerId: string | undefined,
): Promise<string | null> {
  return (await resolveRecorder(ownerId)).base;
}

/** Per-request base for the current authenticated owner (ownerId() degrades
 *  to the seed/system owner when auth is untrusted, matching Phase 1). */
export async function daemonBase(): Promise<string | null> {
  return resolveRecorderBase(await ownerId());
}

/** daemonBase() that throws when no recorder is attached — lets proxy routes
 *  reuse their existing catch blocks as the daemon-less degradation shape. */
export async function daemonBaseOrThrow(): Promise<string> {
  const base = await daemonBase();
  if (!base) throw new Error("no recorder attached");
  return base;
}

export const weekOf = fsData.weekOf; // pure fn, no io

/** Owner for the mandatory-owner DB reads. ownerId() returns undefined only in
 *  untrusted-auth local dev; the db layer no longer accepts an unfiltered
 *  "all tenants" read, so that case degrades to the seed system view. */
const requireOwner = async (): Promise<string> => (await ownerId()) ?? SYSTEM_OWNER;

// ── courses / sessions (parity with data.ts) ──────────────────────────────

export async function listCourses(): Promise<string[]> {
  return dbReads() ? db.courses(await requireOwner()) : fsData.courses();
}

export async function courseIconOf(slug: string): Promise<string | null> {
  return dbReads() ? db.courseIcon(slug) : fsData.courseIcon(slug);
}

export async function semesterStartOf(slug: string): Promise<string | null> {
  return dbReads() ? db.semesterStartOf(slug) : fsData.semesterStartOf(slug);
}

export async function listSessions(course: string): Promise<Session[]> {
  const owner = await requireOwner();
  if (dbReads()) return db.sessions(course, owner);
  const fsList = fsData.sessions(course);
  if (!pgAvailable()) return fsList;
  // PG is configured: merge in artifact-derived notes/transcript/timeline and
  // joinUrls (session_artifacts + sessions.join_url) that the fs scan can no
  // longer discover — the pipeline no longer writes those files to disk. The
  // fs list still contributes recordings and fills fields PG lacks (import
  // pending / pre-PG sessions), so nothing regresses while tables fill.
  const pgList = await db.sessions(course, owner);
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
  if (dbReads()) return db.notesMarkdown(course, stem, kind, await requireOwner());
  const file = (f: string): string | null => {
    try { return readFileSync(join(fsData.DATA_DIR, "notes", course, f), "utf8"); } catch { return null; }
  };
  if (kind === "notes") return file(`${stem}__notes.md`);
  if (kind === "running") return file(`${stem}__running.md`);
  return file(`${stem}__transcript.md`) ?? fsData.timelineToMd(`notes/${course}/${stem}__timeline.json`);
}

// ── timeline entries for the session detail page ──────────────────────────

export async function timelineEntries(course: string, stem: string, rel?: string): Promise<db.TimelineEntry[]> {
  if (dbReads()) return db.timelineEntries(course, stem, await requireOwner());
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
  if (dbReads() || pgAvailable()) return db.readDeadlines(await ownerId());
  return fsDeadlines.readDeadlines();
}

export async function mappingSnap(): Promise<{ mapping: fsMapping.Mapping; folders: string[]; candidates: string[] }> {
  if (dbReads()) return db.mappingSnap(await requireOwner());
  if (pgAvailable()) {
    // mapping.json has no writer anymore — meeting_mappings is the source of
    // truth. Keep fs folders (recordings dirs may exist pre-import) and the
    // fs candidate scan (still reads the daemon's calendar/timeline artifacts).
    const snap = await db.mappingSnap(await requireOwner());
    return {
      mapping: snap.mapping,
      folders: [...new Set([...snap.folders, ...fsMapping.folders()])].sort(),
      candidates: fsMapping.candidateTitles(snap.mapping),
    };
  }
  const mapping = fsMapping.readMapping();
  return { mapping, folders: fsMapping.folders(), candidates: fsMapping.candidateTitles(mapping) };
}
