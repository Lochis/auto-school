#!/usr/bin/env node
/** Dual-write verification — DB-primary state checks for Phase 3 prep.
 *
 *  1. settings: hydrateSettings() seed-migrates fs settings.json →
 *     app_settings['settings'] when the row is absent, then a
 *     setSettings → settingsLoad round-trip proves the write path
 *     (setSettings' DB write is fire-and-forget, so we poll briefly).
 *  2. courses: every fs course folder has a courses row; a synthetic
 *     fs-only course proves the seed-migrate path (cleaned up after).
 *  3. sessions: recent rows with every reader-visible field + a synthetic
 *     full-field write through pipeline updateSession (stem __ISO →
 *     started_at/start_time derivation), cleaned up after.
 *
 *  Usage: DATABASE_URL=… [AUTO_SCHOOL_DATA=…] node scripts/dev-check-dualwrite.ts
 *  Writes only under a `__devcheck__` namespace (removed on exit) plus the
 *  one-time settings seed and an idempotent re-save of CURRENT settings. */
import "./_dualwrite-env.ts";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPool, closeDb } from "../src/db/client.ts";
import { settingsLoad } from "../src/db/state.ts";
import { DATA_DIR } from "../src/paths.ts";
import { hydrateSettings, getSettings, setSettings, type Settings } from "../src/status.ts";
import { hydrateCourseConfigs } from "../src/pipeline/materials.ts";
import { updateSession } from "../src/pipeline/sessions.ts";
import { sessionPaths } from "../src/pipeline/courses.ts";
import { courseId } from "../src/db/writes.ts";

const ok = (cond: boolean, msg: string): void => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) process.exitCode = 1; };
/** jsonb normalizes key order — compare with canonical key sorting. */
const stable = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? "-"));

// ── 1. settings: seed + round-trip ────────────────────────────────────────
const before = await settingsLoad();
console.log(`settings: app_settings row ${before ? "present" : "ABSENT — hydrate will seed from fs"}`);
await hydrateSettings();
ok(!!(await settingsLoad()), "settings: app_settings['settings'] row exists (seeded if needed)");

const cur = getSettings();
setSettings({ ...cur }); // idempotent write of current values → DB + fs mirror
let round: unknown = null;
for (let i = 0; i < 20 && stable(round ?? {}) !== stable(cur); i++) {
  await new Promise((r) => setTimeout(r, 100));
  round = await settingsLoad();
}
ok(stable(round ?? {}) === stable(cur), "settings: setSettings → DB read round-trip matches (jsonb-insensitive)");
const r2 = round as Partial<Settings>;
ok(typeof r2?.recordRetentionDays === "number" && r2.recordRetentionDays === cur.recordRetentionDays
  && r2?.transcribe === cur.transcribe && r2?.batchSegments === cur.batchSegments && r2?.geminiModels === cur.geminiModels,
  `settings: key fields intact (transcribe=${cur.transcribe}, retention=${cur.recordRetentionDays}d, chain=${cur.geminiModels})`);

// ── 2. courses: DB rows for every fs course + seed-migrate proof ──────────
const SLUG = "__devcheck__course";
const croot = join(DATA_DIR, "courses", SLUG);
mkdirSync(croot, { recursive: true });
writeFileSync(join(croot, "course.json"), JSON.stringify({ semesterStart: "2026-09-08", icon: "📚" }));
await hydrateCourseConfigs(); // must seed-migrate the synthetic fs-only course
const pool = getPool();
const dbCourses = (await pool.query(`select slug, semester_start::text as semester_start, icon from courses order by slug`)).rows as
  Array<{ slug: string; semester_start: string | null; icon: string | null }>;
const fsCourses: string[] = [];
try { for (const e of readdirSync(join(DATA_DIR, "courses"), { withFileTypes: true })) if (e.isDirectory()) fsCourses.push(e.name); } catch { /* none */ }
const dbSlugs = new Set(dbCourses.map((c) => c.slug));
for (const c of fsCourses) ok(dbSlugs.has(c), `courses: fs "${c}" has a DB row`);
const synth = dbCourses.find((c) => c.slug === SLUG);
ok(!!synth && synth.semester_start === "2026-09-08" && synth.icon === "📚", `courses: seed-migrate fs→DB (${SLUG}: ${synth?.semester_start}/${synth?.icon})`);
console.log(`courses: ${dbCourses.length} DB row(s); with config:`);
for (const c of dbCourses.filter((c) => c.semester_start || c.icon))
  console.log(`  ${c.slug}  semester_start=${c.semester_start ?? "-"}  icon=${c.icon ?? "-"}`);

// ── 3. sessions: field population + full synthetic write ──────────────────
const sess = (await pool.query(`
  select c.slug, s.stem, s.session_date::text as date, s.start_time::text as start_time,
         s.title, s.join_url, s.stage, s.stage_note, s.seg_count, s.duration_sec, s.size_mb,
         s.started_at, s.updated_at
  from sessions s join courses c on c.id = s.course_id
  order by s.updated_at desc limit 10`)).rows as Array<Record<string, unknown>>;
console.log(`\nsessions: ${sess.length} recent row(s):`);
for (const s of sess) {
  console.log(`  ${s.date} ${String(s.slug).slice(0, 42)} :: stage=${s.stage} seg=${s.seg_count ?? "-"} dur=${s.duration_sec ?? "-"}s ` +
    `size=${s.size_mb ?? "-"}MB start=${s.start_time ?? "-"} started=${iso(s.started_at).slice(0, 19)} ` +
    `join=${s.join_url ? "y" : "-"} note=${s.stage_note ? String(s.stage_note).slice(0, 24) : "-"}`);
}
// synthetic: full write through the real pipeline path, incl. __ISO → capture-time
const LIVE_STEM = "devcheckcapture__2026-10-20T13-05-00"; // UTC 13:05 → Toronto 09:05
const SESS_TITLE = SLUG; // parseCourse(SLUG).slug === SLUG → same namespace
await updateSession(LIVE_STEM, { stage: "done", title: SESS_TITLE, segCount: 3, durationSec: 900, sizeMB: 42, joinUrl: "https://join.example/x" });
const sessPaths = sessionPaths(SESS_TITLE);
const cid = await courseId(sessPaths.course.slug);
const w = (await pool.query(
  `select start_time::text as st, started_at, extract(epoch from started_at at time zone 'UTC')::bigint as ms,
          seg_count, duration_sec, size_mb, join_url, stage, stage_note
   from sessions where course_id = $1 and stem = $2 limit 1`, [cid, sessPaths.stem])).rows[0] as Record<string, unknown> | undefined;
ok(!!w, "sessions: synthetic write created the row (canonical stem)");
ok(!!w && Math.abs(Number(w.ms) * 1000 - Date.parse("2026-10-20T13:05:00Z")) < 2000,
  `sessions: started_at from stem __ISO (${iso(w?.started_at)})`);
ok(w?.st === "09:05:00", `sessions: start_time = Toronto wall clock from stem __ISO (${w?.st})`);
ok(!!w && Number(w.seg_count) === 3 && String(w.duration_sec) === "900.00" && String(w.size_mb) === "42.00"
  && w.join_url === "https://join.example/x" && w.stage === "done",
  "sessions: seg_count/duration_sec/size_mb/join_url/stage all populated");

// ── cleanup synthetic namespace ───────────────────────────────────────────
await pool.query(`delete from courses where slug = $1`, [SLUG]);
rmSync(croot, { recursive: true, force: true });
rmSync(join(DATA_DIR, "notes", sessPaths.course.slug), { recursive: true, force: true });
await closeDb();
console.log(`\ndev-check-dualwrite: ${process.exitCode ? "FAILED" : "all checks passed"}`);
