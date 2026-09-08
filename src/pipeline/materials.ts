/** Course materials — PDFs, syllabi, assignments, rubrics uploaded via the
 *  course page's Materials tab.  Stored at DATA_DIR/courses/<slug>/materials/
 *  WEEK-FOLDERS (materials/week-01/…) so the future study Q&A can slice by
 *  week range: "weeks 1-3" = files in those folders + transcripts whose
 *  session dates fall in the same Mondays.
 *
 *  Per-course config (semesterStart) lives at courses/<slug>/course.json —
 *  weeks are derived from it (Week 1 = the week semester starts, Toronto tz).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../paths.ts";

export type MaterialCategory =
  | "syllabus" | "assignment" | "lecture-notes" | "reference" | "rubric" | "other";

export interface MaterialEntry {
  filename: string;
  week: number;          // 1-based semester week the file belongs to
  category: MaterialCategory;
  description: string;
  uploadedAt: string;    // ISO 8601
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

/** "week-01" folder name for a week number. */
export const weekFolder = (week: number): string => `week-${String(Math.max(1, week)).padStart(2, "0")}`;

// ── per-course config ───────────────────────────────────────────────────────

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

// ── materials manifest ──────────────────────────────────────────────────────

const MATERIALS_DIR = (course: string): string => join(COURSES_ROOT(course), "materials");
const META_FILE = (course: string): string => join(MATERIALS_DIR(course), "materials.json");

export function listMaterials(course: string): MaterialEntry[] {
  try { return JSON.parse(readFileSync(META_FILE(course), "utf8")); } catch { return []; }
}

function saveMaterials(course: string, entries: MaterialEntry[]): void {
  mkdirSync(MATERIALS_DIR(course), { recursive: true });
  writeFileSync(META_FILE(course), JSON.stringify(entries, null, 2));
}

export function addMaterial(course: string, entry: MaterialEntry): void {
  const list = listMaterials(course);
  // replace if same filename+week already exists (re-upload)
  const idx = list.findIndex((e) => e.filename === entry.filename && e.week === entry.week);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveMaterials(course, list);
}

export function removeMaterial(course: string, filename: string, week: number): boolean {
  const list = listMaterials(course);
  const idx = list.findIndex((e) => e.filename === filename && e.week === week);
  if (idx < 0) return false;
  list.splice(idx, 1);
  saveMaterials(course, list);
  try { unlinkSync(join(MATERIALS_DIR(course), weekFolder(week), filename)); } catch { /* gone */ }
  return true;
}

export { MATERIALS_DIR };
