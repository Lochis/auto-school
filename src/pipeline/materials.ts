/** Course materials — a REAL folder tree under
 *  DATA_DIR/courses/<slug>/materials/. Uploads may carry subpaths
 *  ("Week 1/1.1 Modeling.pdf") which are preserved verbatim (sanitized).
 *  Week tags are derived from FOLDER NAMES only (/week\s*(\d+)/i on any
 *  path segment) — fool-proof mapping: drop "Week 3" folder → everything
 *  inside is week 3. No folder-name match → week comes from the upload
 *  form's explicit week (or null → unsorted).
 *
 *  Per-course config (semesterStart) lives at courses/<slug>/course.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "../paths.ts";

export type MaterialCategory =
  | "syllabus" | "assignment" | "lecture-notes" | "reference" | "rubric" | "other";

export interface MaterialEntry {
  /** full relative path from materials root ("Week 1/1.1 Modeling.pdf") */
  path: string;
  filename: string;
  week: number | null;    // from folder name only; null = unsorted
  category: MaterialCategory;
  description: string;
  uploadedAt: string;
  size: number;
}

export interface CourseConfig {
  /** Monday-ish anchor: Week 1 = the week containing this date (YYYY-MM-DD) */
  semesterStart: string;
}

// ── week math (Toronto-local weeks; dates are plain YYYY-MM-DD) ─────────────

/** Monday of the week containing dateStr, as YYYY-MM-DD. */
export function weekMonday(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon anchor — no tz edges
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

/** 1-based semester week of dateStr given a semester start (clamped ≥ 1). */
export function weekOf(dateStr: string, semesterStart: string): number {
  const w0 = weekMonday(semesterStart);
  const w = weekMonday(dateStr);
  return Math.max(1, Math.floor((Date.parse(`${w}T00:00:00Z`) - Date.parse(`${w0}T00:00:00Z`)) / 604_800_000) + 1);
}

/** "week-01" folder name for a week number. (legacy helper) */
export function weekFolder(week: number): string {
  return `week-${String(Math.max(1, Math.min(15, week))).padStart(2, "0")}`;
}

const COURSES_ROOT = (course: string): string => join(DATA_DIR, "courses", course);
const CONFIG_FILE = (course: string): string => join(COURSES_ROOT(course), "course.json");

export function getCourseConfig(course: string): CourseConfig | null {
  try { return JSON.parse(readFileSync(CONFIG_FILE(course), "utf8")); } catch { return null; }
}

export function setCourseConfig(course: string, patch: Partial<CourseConfig>): CourseConfig {
  const next = { ...getCourseConfig(course), ...patch } as CourseConfig;
  mkdirSync(COURSES_ROOT(course), { recursive: true });
  writeFileSync(CONFIG_FILE(course), JSON.stringify(next, null, 2));
  return next;
}

// ── materials tree ──────────────────────────────────────────────────────────

const MATERIALS_DIR = (course: string): string => join(COURSES_ROOT(course), "materials");

/** Week number from a relative path's FOLDER segments only (fool-proof:
 *  "Week 1/…" → 1; "Lab week 3 stuff/x.pdf" → 3 via last match). Null if none. */
export function weekFromPath(relPath: string): number | null {
  const segs = relPath.split("/").slice(0, -1); // folders only, drop filename
  let week: number | null = null;
  for (const seg of segs) {
    const m = seg.match(/week\s*[_\-]?(\d{1,2})/i);
    if (m) week = Math.max(1, Math.min(15, Number(m[1])));
  }
  return week;
}

/** Sanitize an upload subpath: keep folders/letters/digits/spaces/dots/dashes,
 *  collapse repeats, forbid traversal. Returns null if unusable. */
export function sanitizeRelPath(raw: string): string | null {
  const segs = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim().replace(/[^\w .\-()]/g, "_").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segs.length === 0) return null;
  const path = segs.join("/");
  if (path.includes("..")) return null;
  return path.slice(0, 512);
}

/** Walk the materials tree and rebuild the entry list (path, size, mtime).
 *  Category/description survive via the existing materials.json when the
 *  path matches (regeneration keeps human edits). */
export function rebuildTree(course: string): MaterialEntry[] {
  const root = MATERIALS_DIR(course);
  const prev = new Map(listManifest(course).map((e) => [e.path, e]));
  const out: MaterialEntry[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let entries: string[] = [];
    try { entries = readdirSync(abs); } catch { return; }
    for (const name of entries.sort()) {
      if (name === "materials.json") continue;
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(join(abs, name)); } catch { continue; }
      if (st.isDirectory()) walk(childRel);
      else {
        const old = prev.get(childRel);
        out.push({
          path: childRel,
          filename: name,
          week: weekFromPath(childRel),
          category: old?.category ?? guessCategory(name),
          description: old?.description ?? "",
          uploadedAt: old?.uploadedAt ?? st.mtime.toISOString(),
          size: st.size,
        });
      }
    }
  };
  walk("");
  saveManifest(course, out);
  return out;
}

function guessCategory(name: string): MaterialCategory {
  const n = name.toLowerCase();
  if (/syllabus|outline|evaluation scheme/.test(n)) return "syllabus";
  if (/assign|exercise|lab|homework|project/.test(n)) return "assignment";
  if (/summary|notes|lecture|^\d+\.\d+/.test(n)) return "lecture-notes";
  if (/rubric|marking/.test(n)) return "rubric";
  return "other";
}

interface ManifestRow { path: string; filename?: string; week?: number | null; category?: MaterialCategory; description?: string; uploadedAt?: string; size?: number }

function listManifest(course: string): MaterialEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(MATERIALS_DIR(course), "materials.json"), "utf8")) as ManifestRow[];
    return raw.map((r) => ({
      path: r.path,
      filename: r.filename ?? r.path.split("/").pop() ?? r.path,
      week: r.week ?? weekFromPath(r.path),
      category: r.category ?? "other",
      description: r.description ?? "",
      uploadedAt: r.uploadedAt ?? "",
      size: r.size ?? 0,
    }));
  } catch { return []; }
}

function saveManifest(course: string, entries: MaterialEntry[]): void {
  mkdirSync(MATERIALS_DIR(course), { recursive: true });
  writeFileSync(join(MATERIALS_DIR(course), "materials.json"), JSON.stringify(entries, null, 2));
}

export function listMaterials(course: string): MaterialEntry[] {
  // live tree is the source of truth; rebuild cheaply on every list
  return rebuildTree(course);
}

/** Register a freshly placed file (upload path) — merge into the manifest. */
export function registerMaterial(course: string, entry: MaterialEntry): void {
  const list = listManifest(course);
  const idx = list.findIndex((e) => e.path === entry.path);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveManifest(course, list);
}

/** Delete a file or FOLDER (recursive) by relative path. */
export function deleteMaterial(course: string, relPath: string): boolean {
  const root = MATERIALS_DIR(course);
  const abs = join(root, relPath);
  if (!abs.startsWith(root)) return false;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) rmSync(abs, { recursive: true, force: true });
    else unlinkSync(abs);
  } catch { return false; }
  saveManifest(course, listManifest(course).filter((e) => e.path !== relPath && !e.path.startsWith(relPath + "/")));
  return true;
}

/** Rename/move a file or folder. Keeps manifest rows in sync. */
export function renameMaterial(course: string, from: string, to: string): boolean {
  const root = MATERIALS_DIR(course);
  const absFrom = join(root, from);
  const absTo = join(root, to);
  if (!absFrom.startsWith(root) || !absTo.startsWith(root)) return false;
  try {
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
  } catch { return false; }
  // re-derive the manifest from the tree (cheap, keeps weeks/categories)
  rebuildTree(course);
  return true;
}

export { MATERIALS_DIR };
