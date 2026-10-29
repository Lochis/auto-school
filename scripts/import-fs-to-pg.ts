#!/usr/bin/env node
/** fs → Postgres importer (plan §4.1 steps 1–8 + settings gap-fill).
 *  Usage: node scripts/import-fs-to-pg.ts [--data-dir ./dev-data] [--database-url URL]
 *         [--lazy-blobs] [--prune] [--verbose] [--embed]
 *  Idempotent: every write is an upsert on the natural keys from ddl.sql
 *  (re-running converges; activity_events is mirrored delete+insert since it
 *  has no natural key).  fs mtimes are authoritative for started_at /
 *  updated_at (the DB→fs exporter restores them). */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VERBOSE = args.includes("--verbose");
if (args.includes("--embed")) {
  console.log("embeddings backfill not implemented yet");
  process.exit(0);
}
const DATA_DIR = flag("data-dir") ?? process.env.AUTO_SCHOOL_DATA ?? "./dev-data";
const dbUrl = flag("database-url");
if (dbUrl) process.env.DATABASE_URL = dbUrl; // must precede importing src/db/client.ts
const LAZY_BLOBS = args.includes("--lazy-blobs");
const PRUNE = args.includes("--prune");

const OWNER = "00000000-0000-0000-0000-000000000001";
const log = (...m: unknown[]) => console.log(...m);
const vlog = (...m: unknown[]) => { if (VERBOSE) console.log(...m); };

const { getPool, closeDb } = await import("../src/db/client.ts");
type Pool = Awaited<ReturnType<typeof getPool>>;
let pool: Pool;

/** connect with the mandated retry (tunnel may be warming up) */
async function connect(): Promise<Pool> {
  const { getPool: gp } = await import("../src/db/client.ts");
  for (let attempt = 1; ; attempt++) {
    const p = gp();
    try { await p.query("select 1"); return p; }
    catch (e: any) {
      await closeDb().catch(() => {});
      if (attempt >= 3) throw new Error(`DB unreachable after 3 attempts: ${e.message}`);
      log(`DB refused connection (attempt ${attempt}/3), retrying in 10s: ${e.message}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function q(sqlText: string, params: unknown[] = []) {
  return pool.query(sqlText, params);
}

// ── fs helpers ─────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["attic", "segments", "transcribe", ".index"]);
const dirs = (base: string): string[] => {
  try {
    return readdirSync(join(DATA_DIR, base), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch { return []; }
};
/** data.ts courses() dir listing — same as `dirs` but WITHOUT the SKIP_DIRS
 *  filter: fs lists 'attic' as a course (it just has no flat artifacts), and
 *  data.ts never skips it. */
const courseDirs = (base: string): string[] => {
  try {
    return readdirSync(join(DATA_DIR, base), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
};
const files = (base: string): string[] => {
  try {
    return readdirSync(join(DATA_DIR, base), { withFileTypes: true })
      .filter((d) => d.isFile()).map((d) => d.name);
  } catch { return []; }
};
const readJson = <T,>(rel: string): T | null => {
  try { return JSON.parse(readFileSync(join(DATA_DIR, rel), "utf8")) as T; } catch { return null; }
};
const sha256 = (abs: string): string => {
  const h = createHash("sha256");
  h.update(readFileSync(abs)); // recordings are ≤ ~2 GB; fine for a one-shot importer
  return h.digest("hex");
};
const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const normTitle = (s: string): string => // src/pipeline/courses.ts:20-21
  s.toLowerCase().replace(/&/g, " ").replace(/\(\s*sec\.?\s*\d+\s*\)|sec\.?\s*\d+/gi, " ").replace(/[^a-z0-9]+/g, "");

// ── data shapes (daemon.ts:1343/1384/1402, status.ts) ─────────────────────
interface Dl { id: string; course: string; title: string; due: string | null; kind: string; spread: boolean;
  startBy: string | null; note: string; source: string; confidence: string; done: boolean; doneAt: number | null;
  userNote?: string; dueManual?: boolean; stale?: number;
  parts?: { title: string; due: string | null; note: string; done: boolean }[] }
interface Verdict { v: "accepted" | "declined"; parent?: string; parentTitle?: string }
interface Tomb { child: Dl; parentId: string; parentKey: string; parentTitle: string; addedItemIds: string[];
  enriched?: { itemId: string; prevText: string; prevDone: boolean }; partTitles?: string[]; at: number }
interface CkItem { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean }
interface Ck { deadlineId: string; course: string; title: string; items: CkItem[]; updatedAt: number }
interface SessionState { stem: string; title: string; startedAt: number; updatedAt: number; stage: string;
  segCount?: number; joinUrl?: string; mp4?: string; sizeMB?: number; durationSec?: number }
interface TlSeg { meeting?: string; offsetSec: number; file?: string; transcript?: string;
  visualNotes?: { t: string | number; note: string }[] }

const VIDEO_EXT = /\.(webm|mp4|mkv)$/;
const timeFromStem = (stem: string): string | undefined => {
  const m = stem.match(/__T?(\d{2})(\d{2})\d{2}$/);
  return m ? `${m[1]}:${m[2]}` : undefined;
};

// ── state ──────────────────────────────────────────────────────────────────
const courseIds = new Map<string, number>();          // slug → courses.id
const sessionIds = new Map<string, number>();          // `${slug}|${stem}` → sessions.id
const deadlineIds = new Map<string, number>();         // legacy Dl.id → deadlines.id
const dlByCourseTitle = new Map<string, number>();     // `${course}|${title.toLowerCase()}` → id
const seen = { artifacts: new Set<string>(), sessions: new Set<string>(),
  documents: new Set<string>(), mappings: new Set<string>() }; // prune keys
const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  pool = await connect();
  log(`importing ${DATA_DIR} → ${LAZY_BLOBS ? "DB (lazy blobs)" : "DB (full checksums)"}${PRUNE ? " + prune" : ""}`);

  await q(`insert into users (id, display_name, username, role) values ($1,'lochis','lochis','owner')
           on conflict (id) do nothing`, [OWNER]); // step 1 seed (ddl.sql also seeds)

  await importCourses();
  await importMappings();
  await importSessionsAndArtifacts();
  await applyFsJoinUrls();
  await importMaterials();
  await importDeadlines();
  await importFolds();
  await importChecklists();
  await mergeSessionJournal();
  await importEvents();
  await importSettings();
  if (PRUNE) await prune();

  await parity();
  await closeDb();
}

// ── 2. courses from folder union ───────────────────────────────────────────
async function importCourses() {
  // data.ts courses() = union of recordings/ + notes/ dirs ONLY (frontend/src/lib/data.ts:60-62).
  // courses/ holds course.json + materials and can contain slugs with no fs artifacts
  // (e.g. 26F-COMP231_-_SEC_401_-_Lab, COMP303-Lesson_12) that data.ts never surfaces as courses;
  // including it here would fabricate db-only courses. code/icon/semester_start default when
  // course.json is absent (data.ts courseIcon()/semesterStartOf() return null).
  const union = [...new Set([...courseDirs("recordings"), ...courseDirs("notes")])].sort();
  for (const slug of union) {
    const cfg = readJson<{ semesterStart?: string; icon?: string; code?: string }>(join("courses", slug, "course.json")) ?? {};
    const r = await q(`insert into courses (slug, name, code, icon, semester_start, owner_user_id, updated_at)
      values ($1,$2,$3,$4,$5,$6, now())
      on conflict (slug) do update set name=excluded.name, code=excluded.code,
        icon=excluded.icon, semester_start=excluded.semester_start, updated_at=now()
      returning id`, [slug, slug.replace(/_/g, " "), cfg.code ?? "GEN", cfg.icon ?? null, cfg.semesterStart ?? null, OWNER]);
    courseIds.set(slug, Number(r.rows[0].id));
    bump("courses");
  }
  vlog(`courses: ${union.length} (${union.join(", ")})`);
}
async function courseId(slug: string, autoCreate = false): Promise<number | null> {
  const id = courseIds.get(slug);
  if (id) return id;
  if (!autoCreate) return null;
  const r = await q(`insert into courses (slug, name, code, owner_user_id) values ($1,$2,'GEN',$3)
    on conflict (slug) do update set name=excluded.name returning id`, [slug, slug.replace(/_/g, " "), OWNER]);
  courseIds.set(slug, Number(r.rows[0].id));
  log(`  note: created course '${slug}' referenced outside the folder union`);
  bump("courses");
  return courseIds.get(slug)!;
}

// ── 9. mapping.json → meeting_mappings ─────────────────────────────────────
async function importMappings() {
  const map = readJson<Record<string, string>>("mapping.json") ?? {};
  for (const [title, slug] of Object.entries(map)) {
    const cid = await courseId(slug, true);
    if (!cid) { log(`  skip mapping '${title}': no course '${slug}'`); continue; }
    await q(`insert into meeting_mappings (match_title, norm_title, course_id, source, owner_user_id)
      values ($1,$2,$3,'manual',$4)
      on conflict (match_title) do update set norm_title=excluded.norm_title, course_id=excluded.course_id`,
      [title.trim(), normTitle(title.trim()), cid, OWNER]);
    seen.mappings.add(title.trim());
    bump("meeting_mappings");
  }
}

// ── 3+4. sessions / artifacts / segments ───────────────────────────────────
interface Sess { course: string; stem: string; date: string; time?: string; title?: string;
  startedAt?: Date; updatedAt?: Date; stage?: string }
async function upsertSession(s: Sess): Promise<number> {
  const key = `${s.course}|${s.stem}`;
  const existing = sessionIds.get(key);
  if (existing) {
    // A later pass may know more than the first (recordings run before notes).
    // data.ts sessions() is last-write-wins: each add() overwrites `time`, so the
    // final value is timeFromStem(stem) ?? mtime of the LAST notes/running file
    // (__notes.md and __running.md can differ by a minute — consolidated notes
    // land after the live running file). Replicate that by overwriting, not
    // coalescing; re-runs are deterministic (same files, same order, same value).
    if (s.time) await q(`update sessions set start_time = $2 where id = $1`, [existing, s.time]);
    // title provenance: fs surfaces it ONLY from __title.txt (data.ts:104-109).
    if (s.title !== undefined) await q(`update sessions set title = $2 where id = $1`, [existing, s.title]);
    return existing;
  }
  // No stem-derived title: data.ts has none — sessions.title is null unless a
  // __title.txt exists (or the row is a journal-only meeting-title seed).
  const title = s.title !== undefined ? s.title : null;
  const startedAt = s.startedAt ?? new Date(`${s.date}T${s.time ?? "12:00"}:00`);
  // fs-discovered rows are historical sessions — the capture is over by
  // definition. 'recording' here was a bug: the daemon's startup hydrate
  // read those rows as "process died mid-session" and mass-failed every
  // past class as "interrupted by restart". The journal merge below still
  // overwrites stage from out/sessions.json when a row matches.
  const stage = s.stage ?? "done";
  const r = await q(`insert into sessions (course_id, stem, session_date, start_time, title,
      join_url, stage, seg_count, duration_sec, size_mb, started_at, updated_at, owner_user_id)
    values ($1,$2,$3,$4,$5,null,$6,null,null,null,$7,$8,$9)
    on conflict (course_id, stem, owner_user_id) do update set session_date=excluded.session_date,
      start_time=excluded.start_time, title=excluded.title, started_at=excluded.started_at
    returning id`,
    [courseIds.get(s.course), s.stem, s.date, s.time ?? null, title,
      stage, startedAt, s.updatedAt ?? startedAt, OWNER]);
  const id = Number(r.rows[0].id);
  sessionIds.set(key, id);
  seen.sessions.add(key);
  bump("sessions");
  return id;
}

async function upsertArtifact(sessionId: number, kind: string, relPath: string, st: { mtime: Date; size: number },
  content: string | null, checksum: string | null, retainedUntil: Date | null, mime: string | null) {
  await q(`insert into session_artifacts (session_id, kind, rel_path, mime_type, bytes, checksum,
      content, updated_at, retained_until, storage_uri)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (session_id, kind, rel_path) do update set
      mime_type=excluded.mime_type, bytes=excluded.bytes, checksum=excluded.checksum,
      content=excluded.content, updated_at=excluded.updated_at, retained_until=excluded.retained_until,
      storage_uri=excluded.storage_uri`,
    [sessionId, kind, relPath, mime, st.size, checksum, content, st.mtime, retainedUntil,
      kind === "recording" ? `file://${relPath}` : null]);
  seen.artifacts.add(`${sessionId}|${kind}|${relPath}`);
  bump("session_artifacts");
}

async function importSessionsAndArtifacts() {
  const retentionDays = (() => {
    const s = readJson<{ recordRetentionDays?: number }>("settings.json");
    // task mandates mtime+365d; honor an explicit positive setting, note 0 (=forever) in report
    return s?.recordRetentionDays && s.recordRetentionDays > 0 ? s.recordRetentionDays : 365;
  })();
  const coursesWithFs = [...new Set([...courseDirs("recordings"), ...courseDirs("notes")])];
  let skippedSubdirs = 0;
  for (const course of coursesWithFs) {
    const cid = courseIds.get(course);
    if (!cid) continue;
    const byStem = new Map<string, Sess>();
    const sess = (stem: string): Sess => {
      let s = byStem.get(stem);
      if (!s) { s = { course, stem, date: stem.slice(0, 10) }; byStem.set(stem, s); }
      return s;
    };
    // recordings (flat files only — data.ts:62-79 reads no subdirs)
    for (const f of files(join("recordings", course))) {
      if (!VIDEO_EXT.test(f)) continue;
      const stem = f.replace(VIDEO_EXT, "");
      const abs = join(DATA_DIR, "recordings", course, f);
      const st = statSync(abs);
      const s = sess(stem);
      s.time = timeFromStem(stem) ?? s.time;
      const sid = await upsertSession(s);
      const sum = LAZY_BLOBS ? null : sha256(abs);
      await upsertArtifact(sid, "recording", `recordings/${course}/${f}`,
        { mtime: st.mtime, size: st.size }, null, sum,
        new Date(st.mtime.getTime() + retentionDays * 86400_000),
        f.endsWith(".webm") ? "video/webm" : f.endsWith(".mp4") ? "video/mp4" : "video/x-matroska");
    }
    for (const d of readdirSync(join(DATA_DIR, "recordings", course), { withFileTypes: true }))
      if (d.isDirectory()) skippedSubdirs++;
    // notes
    for (const f of files(join("notes", course))) {
      const abs = join(DATA_DIR, "notes", course, f);
      const st = statSync(abs);
      const rel = `notes/${course}/${f}`;
      const hh = String(st.mtime.getHours()).padStart(2, "0");
      const mm = String(st.mtime.getMinutes()).padStart(2, "0");
      if (f.endsWith("__notes.md") || f.endsWith("__running.md")) {
        const kind = f.endsWith("__notes.md") ? "notes" : "running_notes";
        const stem = f.replace(/__(notes|running)\.md$/, "");
        const s = sess(stem);
        s.time = timeFromStem(stem) ?? `${hh}:${mm}`;         // data.ts:80-97 fallback
        s.startedAt ??= new Date(`${s.date}T${s.time}:00`);
        s.updatedAt = st.mtime;
        const sid = await upsertSession(s);
        await upsertArtifact(sid, kind, rel, { mtime: st.mtime, size: st.size },
          readFileSync(abs, "utf8"), null, null, "text/markdown");
      } else if (f.endsWith("__transcript.md")) {
        const sid = await upsertSession(sess(f.replace(/__transcript\.md$/, "")));
        await upsertArtifact(sid, "transcript", rel, { mtime: st.mtime, size: st.size },
          readFileSync(abs, "utf8"), null, null, "text/markdown");
      } else if (f.endsWith("__timeline.json")) {
        const sid = await upsertSession(sess(f.replace(/__timeline\.json$/, "")));
        await upsertArtifact(sid, "timeline", rel, { mtime: st.mtime, size: st.size },
          readFileSync(abs, "utf8"), null, null, "application/json");
        await importTimeline(sid, abs);
      } else if (f.endsWith("__title.txt")) {                  // data.ts:104-109 display title
        try {
          const t = readFileSync(abs, "utf8").trim();
          const s = sess(f.replace(/__title\.txt$/, ""));
          if (t) { s.title = t.slice(0, 80); await upsertSession(s); } // persist title (creates title-only sessions too)
        } catch { /* unreadable */ }
      }
    }
  }
  if (skippedSubdirs) log(`  note: skipped ${skippedSubdirs} recording subfolder(s) (data.ts reads flat files only)`);
  if (LAZY_BLOBS) log("  --lazy-blobs: recording checksums NULL (bytes/size/mtime still recorded)");
}

async function importTimeline(sessionId: number, abs: string) {
  /** legacy timeline.json stores visual-note t as "m:ss" strings; the DB
   *  wants seconds (same normalization as src/pipeline/segment.ts noteT —
   *  inlined here to keep this script's import graph tiny). */
  const noteT = (t: string | number): number => {
    if (typeof t === "number") return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
    const m = String(t).match(/^(\d{1,3}):(\d{1,2})/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const n = parseInt(String(t), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  let segs: TlSeg[];
  try { segs = JSON.parse(readFileSync(abs, "utf8")); } catch { vlog(`  bad timeline json: ${abs}`); return; }
  if (!Array.isArray(segs)) return;
  for (let i = 0; i < segs.length; i++) {
    const e = segs[i];
    if (typeof e?.offsetSec !== "number") continue;
    await q(`insert into transcript_segments (session_id, seg_index, offset_sec, file, transcript, visual_notes)
      values ($1,$2,$3,$4,$5,$6::jsonb)
      on conflict (session_id, offset_sec) do update set seg_index=excluded.seg_index,
        file=excluded.file, transcript=excluded.transcript, visual_notes=excluded.visual_notes`,
      [sessionId, i, Math.round(e.offsetSec), e.file ?? null, e.transcript ?? "",
        JSON.stringify((e.visualNotes ?? []).map((v) => ({ t: noteT(v.t), note: v.note })))]);
    bump("transcript_segments");
  }
}

// ── 5. materials → documents ───────────────────────────────────────────────
const weekFromPath = (p: string): number | null => { // materials.ts: folder names only
  for (const seg of p.split("/")) { const m = seg.match(/week\s*(\d+)/i); if (m) return Number(m[1]); }
  return null;
};
const guessCategory = (name: string): string => { // materials.ts:139-145
  const n = name.toLowerCase();
  if (/syllabus|outline|evaluation scheme/.test(n)) return "syllabus";
  if (/assign|exercise|lab|homework|project/.test(n)) return "assignment";
  if (/summary|notes|lecture|^\d+\.\d+/.test(n)) return "lecture-notes";
  if (/rubric|marking/.test(n)) return "rubric";
  return "other";
};
interface ManifestRow { path: string; category?: string; description?: string; uploadedAt?: string }
async function importMaterials() {
  for (const slug of dirs("courses")) {
    const cid = courseIds.get(slug);
    if (!cid) continue;
    const root = join("courses", slug, "materials");
    if (!existsSync(join(DATA_DIR, root))) continue;
    const manifest = new Map<string, ManifestRow>(
      ((readJson<ManifestRow[]>(join(root, "materials.json")) ?? []).map((r) => [r.path, r])));
    const walk = async (rel: string): Promise<void> => {
      for (const d of readdirSync(join(DATA_DIR, root, rel), { withFileTypes: true })) {
        if (d.name === "materials.json" || d.name.startsWith(".") || SKIP_DIRS.has(d.name)) continue;
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { await walk(child); continue; }
        const st = statSync(join(DATA_DIR, root, child));
        const old = manifest.get(child); // materials.ts:143-160 precedence: manifest keeps human edits
        const week = weekFromPath(child);
        await q(`insert into documents (course_id, kind, rel_path, filename, week, category,
            description, size_bytes, uploaded_at, owner_user_id)
          values ($1,'material',$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict (course_id, kind, rel_path) do update set filename=excluded.filename,
            week=excluded.week, category=excluded.category, description=excluded.description,
            size_bytes=excluded.size_bytes, uploaded_at=excluded.uploaded_at`,
          [cid, child, d.name, week && week >= 1 && week <= 15 ? week : null,
            old?.category ?? guessCategory(d.name), old?.description ?? "", st.size,
            old?.uploadedAt ?? st.mtime.toISOString(), OWNER]);
        seen.documents.add(`${cid}|material|${child}`);
        bump("documents");
      }
    };
    await walk("");
  }
}

// ── 6. deadlines ───────────────────────────────────────────────────────────
async function importDeadlines() {
  const list = readJson<Dl[]>("user-data/deadlines.json") ?? [];
  const dup = new Set<string>();
  for (const d of list) {
    const cid = await courseId(d.course, true);
    if (!cid) { log(`  skip deadline ${d.id}: no course`); continue; }
    const r = await q(`insert into deadlines (legacy_id, course_id, title, due, due_manual, kind,
        spread, start_by, note, source, confidence, done, done_at, user_note, stale, owner_user_id, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      on conflict (course_id, title, legacy_id, owner_user_id) do update set due=excluded.due,
        due_manual=excluded.due_manual, kind=excluded.kind, spread=excluded.spread,
        start_by=excluded.start_by, note=excluded.note, source=excluded.source,
        confidence=excluded.confidence, done=excluded.done, done_at=excluded.done_at,
        user_note=excluded.user_note, stale=excluded.stale, updated_at=now()
      returning id`,
      [d.id, cid, d.title, d.due, d.dueManual ?? false, d.kind, d.spread, d.startBy, d.note,
        d.source, d.confidence, d.done, d.doneAt ? new Date(d.doneAt) : null, d.userNote ?? null,
        d.stale ?? null, OWNER]);
    const id = Number(r.rows[0].id);
    deadlineIds.set(d.id, id);
    const k = `${d.course}|${d.title.toLowerCase()}`;
    if (k && !dlByCourseTitle.has(k)) dlByCourseTitle.set(k, id); // first occurrence wins for fold-parent lookup
    bump("deadlines");
    if (d.parts?.length) {
      await q(`delete from deadline_parts where deadline_id=$1`, [id]); // no natural key → mirror
      for (const p of d.parts)
        await q(`insert into deadline_parts (deadline_id, title, due, note, done) values ($1,$2,$3,$4,$5)`,
          [id, p.title, p.due, p.note, p.done]);
      bump("deadline_parts", d.parts.length);
    }
  }
  if (dup.size) log(`  note: ${dup.size} duplicate (course,title) key(s) encountered; UNIQUE(course_id,title,legacy_id,owner_user_id) keeps both — dlKey() uniqueness is enforced app-side, mirroring fs`);
}

async function importFolds() {
  const f = readJson<{ verdicts?: Record<string, Verdict>; pending?: unknown[]; folded?: Record<string, Tomb> }>("user-data/deadlines-folds.json");
  if (!f) return;
  // tombstoned children were removed from deadlines.json — re-insert so the fold FKs resolve
  for (const tomb of Object.values(f.folded ?? {})) {
    if (deadlineIds.has(tomb.child.id)) continue;
    const cid = await courseId(tomb.child.course, true);
    if (!cid) continue;
    const r = await q(`insert into deadlines (legacy_id, course_id, title, due, due_manual, kind,
        spread, start_by, note, source, confidence, done, done_at, user_note, stale, owner_user_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      on conflict (course_id, title, legacy_id, owner_user_id) do update set legacy_id=excluded.legacy_id returning id`,
      [tomb.child.id, cid, tomb.child.title, tomb.child.due, tomb.child.dueManual ?? false,
        tomb.child.kind, tomb.child.spread, tomb.child.startBy, tomb.child.note, tomb.child.source,
        tomb.child.confidence, tomb.child.done, tomb.child.doneAt ? new Date(tomb.child.doneAt) : null,
        tomb.child.userNote ?? null, tomb.child.stale ?? null, OWNER]);
    deadlineIds.set(tomb.child.id, Number(r.rows[0].id));
    bump("deadlines");
  }
  const verdict = (key: string): Verdict | undefined => f.verdicts?.[key];
  for (const [key, tomb] of Object.entries(f.folded ?? {})) {
    const childId = deadlineIds.get(tomb.child.id);
    let parentId = deadlineIds.get(tomb.parentId) ?? null;
    let chosen = parentId;
    const v = verdict(key);
    if (v?.parent) { // user's chosen parent overrides the nomination
      chosen = dlByCourseTitle.get(v.parent) ?? null;
      parentId = parentId ?? chosen;
    }
    if (!childId || !parentId) { log(`  skip fold ${key}: parent/child unresolved`); continue; }
    await q(`insert into deadline_folds (parent_id, child_id, status, chosen_parent_id,
        added_item_ids, enriched, child_snapshot, folded_at)
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)
      on conflict (parent_id, child_id) do update set status=excluded.status,
        chosen_parent_id=excluded.chosen_parent_id, added_item_ids=excluded.added_item_ids,
        enriched=excluded.enriched, child_snapshot=excluded.child_snapshot, folded_at=excluded.folded_at`,
      [parentId, childId, v?.v ?? "accepted", chosen, JSON.stringify(tomb.addedItemIds ?? []),
        tomb.enriched ? JSON.stringify(tomb.enriched) : null, JSON.stringify(tomb.child),
        tomb.at ? new Date(tomb.at) : null]);
    bump("deadline_folds");
  }
  // verdicts without a tombstone: declined → no fold ever happened; accepted-but-unfolded → pending
  for (const [key, v] of Object.entries(f.verdicts ?? {})) {
    if (f.folded?.[key]) continue;
    if (v.v === "declined") { vlog(`  declined verdict (no fold row): ${key}`); continue; }
    const childId = dlByCourseTitle.get(key);
    const parentId = v.parent ? dlByCourseTitle.get(v.parent) : null;
    if (!childId || !parentId) { vlog(`  verdict without resolvable rows: ${key}`); continue; }
    await q(`insert into deadline_folds (parent_id, child_id, status, chosen_parent_id,
        added_item_ids, child_snapshot)
      values ($1,$2,'pending',$3,'[]'::jsonb,$4::jsonb)
      on conflict (parent_id, child_id) do update set status=excluded.status,
        chosen_parent_id=excluded.chosen_parent_id`,
      [parentId, childId, parentId, JSON.stringify({ key, verdict: v })]);
    bump("deadline_folds");
  }
  if (f.pending?.length) log(`  note: ${f.pending.length} pending fold suggestion(s) not imported (ephemeral LLM nominations)`);
}

async function importChecklists() {
  const list = readJson<Ck[]>("user-data/checklists.json") ?? [];
  for (const ck of list) {
    const did = deadlineIds.get(ck.deadlineId);
    if (!did) { log(`  skip checklist ${ck.deadlineId} (${ck.title}): deadline not found`); continue; }
    for (let i = 0; i < ck.items.length; i++) {
      const it = ck.items[i];
      await q(`insert into checklist_items (deadline_id, legacy_key, text, done, done_at, manual, position, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (deadline_id, legacy_key) do update set text=excluded.text, done=excluded.done,
          done_at=excluded.done_at, manual=excluded.manual, position=excluded.position,
          updated_at=excluded.updated_at`,
        [did, it.id, it.text, it.done, it.doneAt ? new Date(it.doneAt) : null, it.manual ?? false,
          i, new Date(ck.updatedAt)]);
      bump("checklist_items");
    }
  }
}

// ── 6b. joinUrl fuzzy match (data.ts:110-119) ───────────────────────────────
/** data.ts sessions() attaches the live pipeline's joinUrls by normalized
 *  title ⊇ normalized stem-fragment: title index is last-write-wins (duplicate
 *  titles), and each session takes the FIRST matching title.  Replicates that
 *  exactly so sessions.join_url == fs reads.  Runs before mergeSessionJournal
 *  so only fs-derived sessions are in sessionIds (journal-only rows keep their
 *  own row.joinUrl, set in mergeSessionJournal). */
async function applyFsJoinUrls() {
  const journal = readJson<SessionState[]>("out/sessions.json") ?? [];
  const idx = new Map<string, string>();
  for (const row of journal) if (row.joinUrl && row.title) idx.set(row.title, row.joinUrl);
  if (!idx.size) return;
  for (const [key, sid] of sessionIds) {
    const [, stem] = key.split("|");
    const frag = norm(stem.split("__")[1] ?? "");
    if (!frag) continue;
    for (const [title, url] of idx) {
      if (norm(title).includes(frag.slice(0, 20))) {
        await q(`update sessions set join_url = $2 where id = $1`, [sid, url]);
        break;
      }
    }
  }
}

// ── 7. out/sessions.json merge (stage/seg_count/duration/size state) ────────
async function mergeSessionJournal() {
  const journal = readJson<SessionState[]>("out/sessions.json") ?? [];
  let unmatched = 0;
  for (const row of journal) {
    const nt = norm(row.title);
    let matched = false;
    for (const [key, sid] of sessionIds) {
      const [slug, stem] = key.split("|");
      const frag = norm(stem.split("__")[1] ?? "");
      if (!frag || !nt.includes(frag.slice(0, 20))) continue;
      // join_url is applied by applyFsJoinUrls (exact data.ts algorithm);
      // title is __title.txt-only (never the journal meeting title).
      await q(`update sessions set
          stage = $2, seg_count = coalesce($3, seg_count),
          duration_sec = coalesce($4, duration_sec),
          size_mb = coalesce($5, size_mb), updated_at = $6
        where id = $1`,
        [sid, row.stage, row.segCount ?? null,
          row.durationSec != null ? String(row.durationSec) : null,
          row.sizeMB != null ? String(row.sizeMB) : null, new Date(row.updatedAt)]);
      matched = true;
      break;
    }
    if (matched) continue;
    // journal-only row → session if a course resolves (mapping lookup, else slug containment)
    const map = readJson<Record<string, string>>("mapping.json") ?? {};
    let slug: string | undefined = map[row.title.trim()];
    if (!slug) {
      const n = normTitle(row.title);
      for (const [t, s] of Object.entries(map)) { // courses.ts:25-32 containment
        const nk = normTitle(t);
        if (nk && (n.includes(nk) || nk.includes(n))) { slug = s; break; }
      }
    }
    if (!slug) {
      for (const s of courseIds.keys()) if (nt.includes(norm(s))) { slug = s; break; }
    }
    const cid = slug ? await courseId(slug) : null;
    if (!cid) { unmatched++; vlog(`  journal row unmatched, no course: ${row.stem} (${row.title})`); continue; }
    const st = new Date(row.startedAt);
    await upsertSession({ course: slug!, stem: row.stem,
      date: st.toISOString().slice(0, 10),
      time: `${String(st.getHours()).padStart(2, "0")}:${String(st.getMinutes()).padStart(2, "0")}`,
      title: row.title, startedAt: st, updatedAt: new Date(row.updatedAt) });
    await q(`update sessions set stage=$2, join_url=coalesce($3, join_url), seg_count=coalesce($4, seg_count),
      duration_sec=coalesce($5, duration_sec), size_mb=coalesce($6, size_mb) where id=$1`,
      [(sessionIds.get(`${slug}|${row.stem}`))!, row.stage, row.joinUrl ?? null, row.segCount ?? null,
        row.durationSec != null ? String(row.durationSec) : null,
        row.sizeMB != null ? String(row.sizeMB) : null]);
    bump("sessions_journal_only");
  }
  if (unmatched) log(`  note: ${unmatched} journal row(s) had no fs session and no resolvable course — logged, skipped`);
}

// ── 8. events.jsonl → activity_events ──────────────────────────────────────
async function importEvents() {
  const lines: { ts: string; msg: string }[] = [];
  let bad = 0;
  try {
    const raw = readFileSync(join(DATA_DIR, "out", "events.jsonl"), "utf8").split("\n");
    for (const l of raw) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j?.ts && j?.msg != null) lines.push({ ts: j.ts, msg: String(j.msg) }); else bad++; }
      catch { bad++; }
    }
  } catch { log("  no out/events.jsonl — accepted loss (plan §4.1 step 8)"); return; }
  // no natural key → full mirror of the file for this owner keeps re-runs idempotent
  await q(`delete from activity_events where owner_user_id=$1 or owner_user_id is null`, [OWNER]);
  const BATCH = 500;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const vals: unknown[] = [];
    const tuples = chunk.map((e, j) => { vals.push(e.ts, e.msg, OWNER); return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`; });
    await q(`insert into activity_events (ts, msg, owner_user_id) values ${tuples.join(",")}`, vals);
  }
  bump("activity_events", lines.length);
  if (bad) log(`  note: ${bad} malformed event line(s) skipped`);
}

// ── 10. opaque settings (plan gap: not in §4.1 — imported so nothing is lost)
async function importSettings() {
  const entries: [string, string][] = [
    ["settings", "settings.json"], ["attended", "attended.json"], ["left-meetings", "left-meetings.json"],
    ["chat", "user-data/chat.json"], ["deadlines-meta", "user-data/deadlines-meta.json"],
  ];
  for (const [key, rel] of entries) {
    const v = readJson<unknown>(rel);
    if (v === null) { vlog(`  no ${rel}`); continue; }
    await q(`insert into app_settings (key, value, updated_at) values ($1,$2::jsonb,now())
      on conflict (key) do update set value=excluded.value, updated_at=now()`, [key, JSON.stringify(v)]);
    bump("app_settings");
  }
}

// ── --prune ────────────────────────────────────────────────────────────────
async function prune() {
  const artifacts = await q(`select a.id, s.stem, a.kind, a.rel_path from session_artifacts a
    join sessions s on s.id=a.session_id`);
  let n = 0;
  for (const r of artifacts.rows) {
    if (seen.artifacts.has(`${r.id}|${r.kind}|${r.rel_path}`)) continue;
    const abs = join(DATA_DIR, r.rel_path);
    if (existsSync(abs)) continue; // multi-owner safety: file exists → keep
    log(`  prune artifact #${r.id} ${r.rel_path}`);
    await q(`delete from session_artifacts where id=$1`, [r.id]); n++;
  }
  const sessions = await q(`select s.id, c.slug, s.stem from sessions s join courses c on c.id=s.course_id`);
  for (const r of sessions.rows) {
    if (seen.sessions.has(`${r.slug}|${r.stem}`)) continue;
    log(`  prune session #${r.id} ${r.slug}|${r.stem}`);
    await q(`delete from sessions where id=$1`, [r.id]); n++;
  }
  const docs = await q(`select d.id, d.course_id, d.rel_path, c.slug from documents d join courses c on c.id=d.course_id
    where d.kind='material'`);
  for (const r of docs.rows) {
    if (seen.documents.has(`${r.course_id}|material|${r.rel_path}`)) continue;
    if (existsSync(join(DATA_DIR, "courses", r.slug, "materials", r.rel_path))) continue;
    log(`  prune document #${r.id} courses/${r.slug}/materials/${r.rel_path}`);
    await q(`delete from documents where id=$1`, [r.id]); n++;
  }
  const maps = await q(`select id, match_title from meeting_mappings`);
  for (const r of maps.rows) {
    if (seen.mappings.has(r.match_title)) continue;
    log(`  prune mapping #${r.id} '${r.match_title}'`);
    await q(`delete from meeting_mappings where id=$1`, [r.id]); n++;
  }
  log(`prune: removed ${n} row(s)`);
}

// ── parity table ───────────────────────────────────────────────────────────
async function parity() {
  const tables = ["courses", "meeting_mappings", "sessions", "session_artifacts", "transcript_segments",
    "documents", "deadlines", "deadline_parts", "deadline_folds", "checklist_items",
    "activity_events", "app_settings"];
  log("\n─ PARITY ────────────────────────────────────────────");
  for (const t of tables) {
    const db = await q(`select count(*)::int n from ${t}`);
    const src = stats[t] ?? 0;
    log(`${t.padEnd(20)} db=${String(db.rows[0].n).padStart(6)}  imported=${String(src).padStart(6)}${db.rows[0].n !== src ? "  ◀ MISMATCH" : ""}`);
  }
  if (stats["sessions_journal_only"]) log(`${"(+journal-only)".padEnd(20)} ${stats["sessions_journal_only"]}`);
  log("─────────────────────────────────────────────────────");
}

main().catch(async (e) => { console.error("IMPORT FAILED:", e); await closeDb().catch(() => {}); process.exit(1); });
