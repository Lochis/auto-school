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
import { join, dirname, resolve, sep } from "node:path";
import { DATA_DIR } from "../paths.ts";
import { getPool } from "../db/client.ts";
import { pgConfigured } from "../db/reader.ts";
import { upsertCourseConfig, courseId } from "../db/writes.ts";
import { curOwner } from "../db/owner.ts";

export type MaterialCategory =
  | "syllabus" | "assignment" | "lecture-notes" | "reference" | "rubric" | "transcript" | "other";

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
  /** Emoji key chosen in the course icon picker (frontend course-icons.tsx) */
  icon?: string;
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

/** DB-primary course config: courses.semester_start/icon own the truth;
 *  hydrated once at daemon start (hydrateCourseConfigs) and mirrored to the
 *  fs course.json on every write (Phase 4 removes the mirror). Slugs without
 *  any config stay uncached → fs read (null when no file exists). */
const cfgCache = new Map<string, CourseConfig | null>();

function fsCourseConfig(course: string): CourseConfig | null {
  try { return JSON.parse(readFileSync(CONFIG_FILE(course), "utf8")); } catch { return null; }
}

/** pg prints `date` columns as Date — normalize back to the YYYY-MM-DD the
 *  fs file and every consumer (week math, UI) expects. */
const asDate = (v: unknown): string | undefined =>
  v == null ? undefined : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export function getCourseConfig(course: string): CourseConfig | null {
  if (cfgCache.has(course)) return cfgCache.get(course)!;
  return fsCourseConfig(course);
}

/** One-time boot hydration + seed-migration: every course.json on fs gets a
 *  courses row (fs values fill NULL columns); DB values win where present. */
export async function hydrateCourseConfigs(): Promise<void> {
  if (!pgConfigured()) return;
  const fsCfgs = new Map<string, CourseConfig | null>();
  // Course identity = union(recordings/, notes/) — matching data.ts.courses() and the
  // importer. courses/-only dirs (stale orphans) must NOT be re-registered here.
  const known = new Set<string>();
  for (const base of ["recordings", "notes"]) {
    try {
      for (const e of readdirSync(join(DATA_DIR, base), { withFileTypes: true }))
        if (e.isDirectory()) known.add(e.name);
    } catch { /* no recordings/notes root yet */ }
  }
  try {
    for (const e of readdirSync(join(DATA_DIR, "courses"), { withFileTypes: true }))
      if (e.isDirectory() && known.has(e.name)) fsCfgs.set(e.name, fsCourseConfig(e.name));
  } catch { /* no courses root yet */ }
  // Owner-scoped (2026-10-30 wave, resolveCourses pattern in pipeline/tools.ts):
  // boot hydration runs without an ALS store so curOwner() = seed owner, while
  // any request-time re-hydrate sees only the requesting user's rows.
  const owner = curOwner();
  const rows = (await getPool().query(`select slug, semester_start, icon from courses where owner_user_id = $1`, [owner])).rows;
  const bySlug = new Map(rows.map((r) => [String(r.slug), r]));
  for (const [slug, fs] of fsCfgs) {
    const row = bySlug.get(slug);
    if (!row || (row.semester_start == null && fs?.semesterStart) || (row.icon == null && fs?.icon)) {
      // seed-migrate: register the folder or backfill NULL columns from fs
      try {
        await upsertCourseConfig(slug, {
          ...(row?.semester_start == null && fs?.semesterStart ? { semesterStart: fs.semesterStart } : {}),
          ...(row?.icon == null && fs?.icon ? { icon: fs.icon } : {}),
        });
        const upd = (await getPool().query(`select semester_start, icon from courses where slug = $1 and owner_user_id = $2`, [slug, owner])).rows[0];
        if (upd) bySlug.set(slug, upd);
      } catch (e) { console.warn(`[materials] config seed-migrate failed for ${slug}: ${String(e).slice(0, 100)}`); }
    }
  }
  for (const [slug, row] of bySlug) {
    const semesterStart = asDate(row.semester_start) ?? fsCfgs.get(slug)?.semesterStart;
    const icon = row.icon ?? fsCfgs.get(slug)?.icon;
    if (semesterStart || icon) cfgCache.set(slug, { semesterStart: semesterStart ?? "", ...(icon ? { icon } : {}) });
    else cfgCache.set(slug, null);
  }
}

export function setCourseConfig(course: string, patch: Partial<CourseConfig>): CourseConfig {
  const next = { ...getCourseConfig(course), ...patch } as CourseConfig;
  cfgCache.set(course, next);
  try {
    mkdirSync(COURSES_ROOT(course), { recursive: true });
    writeFileSync(CONFIG_FILE(course), JSON.stringify(next, null, 2));
  } catch { /* read-only fs: DB row below is the primary copy */ }
  if (pgConfigured()) void upsertCourseConfig(course, next).catch((e) => console.warn(`[materials] DB config write failed: ${String(e).slice(0, 120)}`));
  return next;
}

// ── materials tree ──────────────────────────────────────────────────────────

export const MATERIALS_DIR = (course: string): string => join(COURSES_ROOT(course), "materials");

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
      // skip the manifest + anything hidden — the .index/ page cache is a
      // machine artifact (extracted text/PNGs), never a human material
      if (name === "materials.json" || name.startsWith(".")) continue;
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

export async function listMaterials(course: string): Promise<MaterialEntry[]> {
  if (pgConfigured()) {
    try {
      const { rows } = await getPool().query(
        `select rel_path, filename, week, category, description, size_bytes, uploaded_at
         from documents
         where course_id = (select id from courses where slug=$1 and owner_user_id=$2) and kind='material'
         order by rel_path`,
        [course, curOwner()],
      );
      if (rows.length > 0) {
        return rows.map((r) => ({
          path: String(r.rel_path),
          filename: String(r.filename),
          week: r.week == null ? null : Number(r.week),
          category: DOC_CATEGORIES.has(r.category) ? (r.category as MaterialCategory) : "other",
          description: r.description == null ? "" : String(r.description),
          uploadedAt: r.uploaded_at ? new Date(String(r.uploaded_at)).toISOString() : "",
          size: Number(r.size_bytes ?? 0),
        }));
      }
    } catch (e) {
      console.error(`materials: DB list failed (${course}), falling back to fs tree:`, e);
    }
  }
  // no PG, no rows yet (pre-import/cold), or query failed — fs tree is the fallback
  return rebuildTree(course);
}

/** The derived text-page cache (materials/.index/**) as pseudo-entries —
 *  NEVER part of the default listing; the API appends these only for the
 *  explicit "show indexed cache" toggle. Not persisted in materials.json. */
export function listIndexFiles(course: string): MaterialEntry[] {
  const root = join(MATERIALS_DIR(course), ".index");
  const out: MaterialEntry[] = [];
  const walk = (rel: string): void => {
    let names: string[] = [];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const name of names.sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(join(root, childRel)); } catch { continue; }
      if (st.isDirectory()) walk(childRel);
      else if (/^page-\d+\.(txt|png)$/.test(name)) {
        out.push({
          path: `.index/${childRel}`,
          filename: name,
          week: null,
          category: "other",
          description: "indexed page cache (machine-extracted)",
          uploadedAt: st.mtime.toISOString(),
          size: st.size,
        });
      }
    }
  };
  walk("");
  return out;
}

/** Register a freshly placed file (upload path) — merge into the manifest. */
export function registerMaterial(course: string, entry: MaterialEntry): void {
  const list = listManifest(course);
  const idx = list.findIndex((e) => e.path === entry.path);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveManifest(course, list);
  void upsertDocumentRow(course, entry); // immediate documents row (embeddable or not)
}

// ── Postgres documents-row sync ─────────────────────────────────────────────
// documents.category CHECK whitelist — manifest categories outside it coerce to "other".
const DOC_CATEGORIES = new Set(["syllabus", "assignment", "lecture-notes", "reference", "rubric", "transcript", "other"]);

/** Immediate documents-row upsert for a freshly uploaded material (embeddable
 *  or not). Fire-and-forget + fully guarded: an fs-only caller must NEVER fail
 *  because PG is down. embedPendingMaterials() later chunks/embeds stale rows;
 *  this call only guarantees the LISTING row exists the moment upload lands. */
async function upsertDocumentRow(course: string, entry: MaterialEntry): Promise<void> {
  try {
    if (!pgConfigured()) return;
    const cid = await courseId(course);
    await getPool().query(
      `insert into documents (course_id, kind, rel_path, filename, week, category, description, size_bytes, uploaded_at, owner_user_id, updated_at)
       values ($1,'material',$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (course_id, kind, rel_path, owner_user_id) do update set
         filename=excluded.filename, week=excluded.week, category=excluded.category,
         description=excluded.description, size_bytes=excluded.size_bytes, updated_at=now()`,
      [cid, entry.path, entry.filename, entry.week,
        DOC_CATEGORIES.has(entry.category) ? entry.category : "other",
        entry.description ?? "",
        Number(entry.size) || 0,
        entry.uploadedAt ? new Date(entry.uploadedAt) : null,
        curOwner()],
    );
  } catch (e) {
    console.error(`materials: document row upsert failed (${course}/${entry.path}):`, e);
  }
}

// deleteMaterial/renameMaterial mutate the fs tree + materials.json, but
// vector/keyword search reads the `documents` table — without these syncs
// deleted materials keep surfacing with dead rel_paths and renames leave
// duplicate rows. Fire-and-forget + fully guarded: an fs-only operation must
// NEVER fail because PG is down. document_chunks cascades on delete
// (ddl.sql: document_chunks.document_id → documents ON DELETE CASCADE).

/** Escape LIKE metacharacters (% _ \) in a user-supplied rel path. */
const escapeLike = (s: string): string => s.replace(/([%_\\])/g, "\\$1");

async function forgetDocumentRows(course: string, relPath: string): Promise<void> {
  try {
    if (!pgConfigured()) return;
    const pool = getPool();
    const cid = (await pool.query(`select id from courses where slug=$1 and owner_user_id=$2`, [course, curOwner()])).rows[0]?.id;
    if (!cid) return;
    const r = await pool.query(
      `delete from documents where course_id=$1 and kind='material'
        and (rel_path=$2 or rel_path like $3 escape '\\')`,
      [cid, relPath, `${escapeLike(relPath)}/%`]); // row itself + children (folder delete)
    if (r.rowCount) console.log(`materials: dropped ${r.rowCount} document row(s) for deleted ${course}/${relPath}`);
  } catch (e) { console.error(`materials: documents prune failed (${course}/${relPath}):`, e); }
}

async function moveDocumentRows(course: string, from: string, to: string): Promise<void> {
  try {
    if (!pgConfigured()) return;
    const pool = getPool();
    const cid = (await pool.query(`select id from courses where slug=$1 and owner_user_id=$2`, [course, curOwner()])).rows[0]?.id;
    if (!cid) return;
    // folder rename rewrites the "from/" prefix POSITIONALLY (replace() could
    // re-hit an identical segment deeper in the path); file rename rewrites the
    // exact row and its filename. Children keep their own filenames.
    const r = await pool.query(
      `update documents set
         rel_path = case when rel_path=$2 then $3 else $3 || substring(rel_path from char_length($2) + 1) end,
         filename = case when rel_path=$2 then $4 else filename end,
         updated_at = now()
       where course_id=$1 and kind='material' and (rel_path=$2 or rel_path like $5 escape '\\')`,
      [cid, from, to, to.split("/").pop() ?? to, `${escapeLike(from)}/%`]);
    if (r.rowCount) console.log(`materials: re-pointed ${r.rowCount} document row(s): ${course} ${from} → ${to}`);
  } catch (e) { console.error(`materials: documents rename failed (${course} ${from}→${to}):`, e); }
}

/** join + containment: the RESOLVED path must stay inside root. Catches
 *  `..` escapes and the sibling-prefix trick (`materials-evil/` also
 *  `startsWith("materials")`). null → caller treats it as "not found". */
const underRoot = (root: string, rel: string): string | null => {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("%")) return null;
  const base = resolve(root);
  const abs = resolve(base, rel);
  return abs !== base && abs.startsWith(base + sep) ? abs : null;
};

/** Delete a file or FOLDER (recursive) by relative path — materials dir only. */
export function deleteMaterial(course: string, relPath: string): boolean {
  const root = MATERIALS_DIR(course);
  const abs = underRoot(root, relPath);
  if (!abs) return false;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) rmSync(abs, { recursive: true, force: true });
    else unlinkSync(abs);
  } catch { return false; }
  saveManifest(course, listManifest(course).filter((e) => e.path !== relPath && !e.path.startsWith(relPath + "/")));
  void forgetDocumentRows(course, relPath); // keep search index in step (best-effort)
  return true;
}

/** Rename/move a file or folder. Keeps manifest rows in sync. */
export function renameMaterial(course: string, from: string, to: string): boolean {
  const root = MATERIALS_DIR(course);
  const absFrom = underRoot(root, from);
  const absTo = underRoot(root, to);
  if (!absFrom || !absTo) return false;
  try {
    mkdirSync(dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
  } catch { return false; }
  // re-derive the manifest from the tree (cheap, keeps weeks/categories)
  rebuildTree(course);
  void moveDocumentRows(course, from, to); // keep search index in step (best-effort)
  return true;
}
