/** fs ↔ DB read-query parity (Phase-3 cutover gap report).
 *  Compares the src/db/queries/* read surface against the fs layer the
 *  frontend uses today (frontend/src/lib/data.ts with AUTO_SCHOOL_DATA
 *  pointing at dev-data): course listing, per-course session counts + stems +
 *  ordering, per-session artifact flags, readText equality, timelineToMd
 *  equality and joinUrl mapping. Mismatches are EXPECTED — this script is the
 *  gap report; do not "fix" the data by hand.
 *
 *  Usage: node scripts/parity-queries.ts [--data-dir ./dev-data]
 *                                       [--database-url URL] [--details N]
 *  Env:   AUTO_SCHOOL_DATA, DATABASE_URL (same resolution as verify-parity.ts).
 *  Exit:  0 on full parity, 1 on any mismatch. */

import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATA = flag("data-dir") ?? process.env.AUTO_SCHOOL_DATA ?? "./dev-data";
const DB_URL =
  flag("database-url") ??
  process.env.DATABASE_URL ??
  "postgres://autoschool:bddf68ayd8812c569d7bfea2b2126245860afc2a9050@127.0.0.1:15432/autoschool";
const DETAILS = Number(flag("details") ?? 8); // max examples printed per section

// Env must be set BEFORE the dynamic imports: data.ts resolves DATA_DIR at
// module load; src/db/client.ts resolves DATABASE_URL lazily at first query.
// resolve() matters: data.ts readText() has a startsWith(DATA_DIR) path guard
// that a relative "./dev-data" always fails (join() strips the "./").
process.env.AUTO_SCHOOL_DATA = resolve(DATA);
process.env.DATABASE_URL = DB_URL;

const fs = await import("../frontend/src/lib/data.ts");
const { listCourses } = await import("../src/db/queries/courses.ts");
const { listSessions } = await import("../src/db/queries/sessions.ts");
const { readText: dbReadText, timelineToMd: dbTimelineToMd } = await import("../src/db/queries/notes.ts");
const { closeDb } = await import("../src/db/client.ts");

let checks = 0;
let fails = 0;
const section = (t: string) => console.log(`\n── ${t} ──`);
const check = (name: string, pass: boolean, detail = "") => {
  checks++;
  if (!pass) fails++;
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const head = (xs: string[], n = DETAILS) =>
  xs.length ? `${xs.length} (e.g. ${xs.slice(0, n).join(", ")})` : "";

/** Compare one optional field; record "<fs>→<db>" when they differ. */
const cmpFlag = (out: string[], name: string, a: string | undefined, b: string | undefined) => {
  if ((a ?? null) !== (b ?? null)) out.push(`${name}: ${a ?? "—"} → ${b ?? "—"}`);
};

console.log(`parity-queries — fs: ${DATA}  db: ${DB_URL.replace(/:[^:@/]+@/, ":***@")}`);

// ── 1. course listing ──────────────────────────────────────────────────────
section("course listing");
const fsCourses = fs.courses();
const dbCourses = await listCourses();
const fsSet = new Set(fsCourses);
const dbSet = new Set(dbCourses);
const onlyFsCourses = fsCourses.filter((c) => !dbSet.has(c));
const onlyDbCourses = dbCourses.filter((c) => !fsSet.has(c));
check("course count", fsCourses.length === dbCourses.length, `fs=${fsCourses.length} db=${dbCourses.length}`);
check("fs-only courses (missing in db)", onlyFsCourses.length === 0, head(onlyFsCourses));
check("db-only courses (missing on fs)", onlyDbCourses.length === 0, head(onlyDbCourses));

// ── 2. per-course sessions: counts, stems, ordering, artifact flags ───────
section("sessions per course (counts / stems / ordering / artifact flags)");
const unionCourses = [...new Set([...fsCourses, ...dbCourses])].sort();
const flagMismatches: string[] = [];
let stemsFlagged = 0;
for (const course of unionCourses) {
  const fsS = fs.sessions(course);
  const dbS = await listSessions(course);
  const fsStems = fsS.map((s) => s.stem);
  const dbStems = dbS.map((s) => s.stem);
  const fsOnly = fsStems.filter((s) => !dbStems.includes(s));
  const dbOnly = dbStems.filter((s) => !fsStems.includes(s));
  check(
    `${course}: session stems`,
    fsOnly.length === 0 && dbOnly.length === 0,
    `fs=${fsS.length} db=${dbS.length}` +
      (fsOnly.length ? ` | only-fs: ${head(fsOnly)}` : "") +
      (dbOnly.length ? ` | only-db: ${head(dbOnly)}` : ""),
  );
  const common = fsStems.filter((s) => dbStems.includes(s));
  const dbCommon = dbStems.filter((s) => fsStems.includes(s));
  check(`${course}: ordering`, JSON.stringify(common) === JSON.stringify(dbCommon), "session_date DESC, start_time DESC NULLS LAST");
  const dbMap = new Map(dbS.map((s) => [s.stem, s]));
  for (const s of fsS) {
    const d = dbMap.get(s.stem);
    if (!d) continue;
    const diff: string[] = [];
    cmpFlag(diff, "audio", s.audio, d.audio);
    cmpFlag(diff, "notes", s.notes, d.notes);
    cmpFlag(diff, "transcript", s.transcript, d.transcript);
    cmpFlag(diff, "timeline", s.timeline, d.timeline);
    if (s.hasTimeline !== d.hasTimeline) diff.push(`hasTimeline: ${s.hasTimeline} → ${d.hasTimeline}`);
    if ((s.segmentCount ?? null) !== (d.segmentCount ?? null))
      diff.push(`segmentCount: ${s.segmentCount ?? "—"} → ${d.segmentCount ?? "—"}`);
    if ((s.time ?? null) !== (d.time ?? null)) diff.push(`time: ${s.time ?? "—"} → ${d.time ?? "—"}`);
    if ((s.title ?? null) !== (d.title ?? null))
      diff.push(`title: ${JSON.stringify(s.title ?? null)} → ${JSON.stringify(d.title ?? null)}`);
    if (diff.length) flagMismatches.push(`${course}/${s.stem}: ${diff.join("; ")}`);
    else stemsFlagged++;
  }
}
check("artifact flags (common stems)", flagMismatches.length === 0, `ok=${stemsFlagged} bad=${flagMismatches.length}`);
for (const m of flagMismatches.slice(0, DETAILS)) console.log(`      · ${m}`);

// ── 3. readText parity (every fs notes/transcript path) ───────────────────
section("readText (notes / transcript content)");
let textChecked = 0;
const textMismatched: string[] = [];
for (const course of unionCourses) {
  for (const s of fs.sessions(course)) {
    for (const p of [s.notes, s.transcript]) {
      if (!p) continue;
      textChecked++;
      const a = fs.readText(p);
      const b = await dbReadText(p);
      if (a !== b)
        textMismatched.push(
          `${p}: fs=${a === null ? "null" : `${a.length}ch`} db=${b === null ? "null" : `${b.length}ch`}`,
        );
    }
  }
}
check("content equality", textMismatched.length === 0, `checked=${textChecked} mismatched=${textMismatched.length}`);
for (const m of textMismatched.slice(0, DETAILS)) console.log(`      · ${m}`);

// ── 4. timelineToMd parity ─────────────────────────────────────────────────
section("timelineToMd render");
let tlChecked = 0;
const tlMismatched: string[] = [];
for (const course of unionCourses) {
  for (const s of fs.sessions(course)) {
    if (!s.hasTimeline || !s.timeline) continue;
    tlChecked++;
    const fsMd = fs.timelineToMd(s.timeline);
    const dbMd = await dbTimelineToMd(course, s.stem);
    if (fsMd !== dbMd)
      tlMismatched.push(
        `${course}/${s.stem}: fs=${fsMd === null ? "null" : `${fsMd.length}ch`} db=${dbMd === null ? "null" : `${dbMd.length}ch`}`,
      );
  }
}
check("timeline markdown equality", tlMismatched.length === 0, `checked=${tlChecked} mismatched=${tlMismatched.length}`);
for (const m of tlMismatched.slice(0, DETAILS)) console.log(`      · ${m}`);

// ── 5. joinUrl parity ──────────────────────────────────────────────────────
section("joinUrl mapping (fs fuzzy sessions.json vs sessions.join_url)");
let urlChecked = 0;
const urlMismatches: string[] = [];
for (const course of unionCourses) {
  const dbMap = new Map((await listSessions(course)).map((s) => [s.stem, s]));
  for (const s of fs.sessions(course)) {
    const d = dbMap.get(s.stem);
    if (!d) continue;
    urlChecked++;
    if ((s.joinUrl ?? null) !== (d.joinUrl ?? null))
      urlMismatches.push(
        `${course}/${s.stem}: fs=${s.joinUrl ? "url" : "—"} db=${d.joinUrl ? "url" : "—"}` +
          (s.joinUrl && d.joinUrl && s.joinUrl !== d.joinUrl ? " (different urls)" : ""),
      );
  }
}
check("joinUrl equality", urlMismatches.length === 0, `checked=${urlChecked} mismatched=${urlMismatches.length}`);
for (const m of urlMismatches.slice(0, DETAILS)) console.log(`      · ${m}`);

await closeDb();
console.log(`\n${fails === 0 ? "ALL GREEN" : "GAPS FOUND"} — ${checks} checks, ${fails} mismatched`);
process.exit(fails ? 1 : 0);
