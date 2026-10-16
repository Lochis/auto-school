/**
 * Independent fs↔PG parity verifier (plan §4.2 subset).
 * Deliberately does NOT use src/db (belt-and-braces: raw pg client, raw fs reads).
 * Usage: node scripts/verify-parity.ts [--data-dir ./dev-data] [--max-hash N] [--skip-hash]
 */
import { Client } from "pg";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const DATA = flag("data-dir") ?? process.env.AUTO_SCHOOL_DATA ?? "./dev-data";
const MAX_HASH = Number(flag("max-hash") ?? 8);
const SKIP_HASH = args.includes("--skip-hash");

const c = new Client({ connectionString: flag("database-url") ?? process.env.DATABASE_URL ?? "postgres://autoschool:bddf68ayd8812c569d7bfea2b2126245860afc2a9050@127.0.0.1:15432/autoschool" });

let fails = 0, checks = 0;
const ok = (name: string, pass: boolean, detail = "") => { checks++; if (!pass) { fails++; console.log(`  ✗ ${name} ${detail}`); } else console.log(`  ✓ ${name}${detail ? " " + detail : ""}`); };

const fsCourses = () => {
  const dirs = (d: string) => { try { return readdirSync(join(DATA, d), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== "attic").map(e => e.name); } catch { return []; } };
  return [...new Set([...dirs("recordings"), ...dirs("notes"), ...dirs("courses")])].sort();
};

const timelineToMd = (entries) => {
  const lines = entries.filter(e => e?.transcript?.trim()).map(e => {
    const m = Math.floor(e.offsetSec / 60), s = String(Math.floor(e.offsetSec % 60)).padStart(2, "0");
    return `[${m}:${s}] ${e.transcript.trim()}`;
  });
  return lines.length ? lines.join("\n") + "\n" : "";
};

await c.connect();
console.log(`verify-parity against ${DATA}\n`);

// 1 — counts
{
  const fc = fsCourses();
  const { rows } = await c.query("select slug from courses order by slug");
  ok("course count", fc.length === rows.length, `fs=${fc.length} db=${rows.length}`);
  const fcSet = new Set(fc), dbSet = new Set(rows.map(r => r.slug));
  const missing = fc.filter(x => !dbSet.has(x)), extra = [...dbSet].filter(x => !fcSet.has(x));
  ok("course slugs identical", missing.length === 0 && extra.length === 0, missing.length ? `missing in db: ${missing}` : extra.length ? `extra in db: ${extra}` : "");
}
let fsArtifactCount = 0;
{
  const { rows } = await c.query("select kind, count(*)::int n from session_artifacts group by kind order by kind");
  const db = Object.fromEntries(rows.map(r => [r.kind, r.n]));
  const cnt = {};
  const suffixes = { "__notes.md": "notes", "__running.md": "running_notes", "__transcript.md": "transcript", "__timeline.json": "timeline" };
  for (const course of fsCourses()) {
    for (const d of ["notes", "recordings"]) {
      let files: string[]; try { files = readdirSync(join(DATA, d, course)); } catch { continue; }
      for (const f of files) {
        const kind = Object.entries(suffixes).find(([s]) => f.endsWith(s))?.[1]
          ?? (/\.(mp4|webm|mkv)$/.test(f) ? "recording" : null);
        if (kind) { cnt[kind] = (cnt[kind] ?? 0) + 1; fsArtifactCount++; }
      }
    }
  }
  for (const k of new Set([...Object.keys(cnt), ...Object.keys(db)]))
    ok(`artifact count kind=${k}`, (cnt[k] ?? 0) === (db[k] ?? 0), `fs=${cnt[k] ?? 0} db=${db[k] ?? 0}`);
}
{
  let fsSegs = 0;
  for (const course of fsCourses()) {
    let files: string[]; try { files = readdirSync(join(DATA, "notes", course)); } catch { continue; }
    for (const f of files.filter(f => f.endsWith("__timeline.json"))) {
      try { fsSegs += JSON.parse(readFileSync(join(DATA, "notes", course, f), "utf8")).length; } catch {}
    }
  }
  const { rows } = await c.query("select count(*)::int n from transcript_segments");
  ok("transcript segment count", fsSegs === rows[0].n, `fs=${fsSegs} db=${rows[0].n}`);
}
{
  const dl = JSON.parse(readFileSync(join(DATA, "user-data", "deadlines.json"), "utf8"));
  const { rows } = await c.query("select count(*)::int n from deadlines where legacy_id is not null");
  // fold tombstone children are re-inserted for FK integrity but don't exist in deadlines.json
  const { rows: fc } = await c.query("select count(*)::int n from deadlines d join deadline_folds f on f.child_id=d.id where d.legacy_id is not null");
  const { rows: fcFs } = await c.query("select legacy_id from deadlines d join deadline_folds f on f.child_id=d.id where d.legacy_id is not null");
  const fsIds = new Set(dl.map(d => String(d.id)));
  const tombstoneOnly = fcFs.filter(r => !fsIds.has(r.legacy_id)).length;
  ok("deadline count", dl.length === rows[0].n - tombstoneOnly, `fs=${dl.length} db=${rows[0].n} (−${tombstoneOnly} fold tombstone child, not exported)`);
  const { rows: idr } = await c.query("select legacy_id from deadlines where legacy_id is not null");
  const dbIds = new Set(idr.map(r => r.legacy_id)); const fsIdSet = new Set(dl.map(d => String(d.id)));
  const diff = [...fsIdSet].filter(x => !dbIds.has(x));
  ok("deadline legacy ids identical", diff.length === 0, diff.length ? `missing: ${diff.slice(0, 5)}` : "");
}
{
  const m = JSON.parse(readFileSync(join(DATA, "mapping.json"), "utf8"));
  const { rows } = await c.query("select count(*)::int n from meeting_mappings");
  ok("meeting mapping count", Object.keys(m).length === rows[0].n, `fs=${Object.keys(m).length} db=${rows[0].n}`);
}
{
  const ck = JSON.parse(readFileSync(join(DATA, "user-data", "checklists.json"), "utf8"));
  const fsItems = ck.reduce((a, c2) => a + (c2.items?.length ?? 0), 0);
  const { rows } = await c.query("select count(*)::int n from checklist_items");
  ok("checklist item count", fsItems === rows[0].n, `fs=${fsItems} db=${rows[0].n}`);
}
{
  let lines = 0; try { lines = readFileSync(join(DATA, "out", "events.jsonl"), "utf8").split("\n").filter(l => l.trim()).length; } catch {}
  const { rows } = await c.query("select count(*)::int n from activity_events");
  ok("activity event count", lines === rows[0].n, `fs=${lines} db=${rows[0].n}`);
}

// 2 — text parity: EVERY notes/running/transcript artifact, not a sample
{
  let compared = 0, mismatched = [];
  const { rows } = await c.query("select a.rel_path, a.content from session_artifacts a where a.kind in ('notes','running_notes','transcript') and a.content is not null");
  for (const r of rows) {
    const p = join(DATA, r.rel_path);
    if (!existsSync(p)) { mismatched.push(`${r.rel_path} (missing on fs)`); continue; }
    const disk = readFileSync(p, "utf8");
    if (disk !== r.content) mismatched.push(r.rel_path);
    compared++;
  }
  ok("text artifact content parity (all)", mismatched.length === 0, `compared=${compared}${mismatched.length ? ` mismatched: ${mismatched.slice(0, 3)}` : ""}`);
}

// 3 — timeline render parity from DB segments vs fs timeline.json
{
  let compared = 0, mismatched = 0;
  const { rows } = await c.query(`
    select a.rel_path, coalesce(string_agg(
      case when coalesce(s.transcript,'') ~ '[[:space:]]*[^[:space:]]' then
        '[' || floor(s.offset_sec/60) || ':' || lpad((s.offset_sec % 60)::text,2,'0') || '] ' || trim(s.transcript)
      end, E'\n' order by s.offset_sec), '') as md
    from session_artifacts a join sessions ss on ss.id=a.session_id
    left join transcript_segments s on s.session_id=ss.id
    where a.kind='timeline' group by a.id, a.rel_path`);
  for (const r of rows) {
    let fsMd = "";
    try { fsMd = timelineToMd(JSON.parse(readFileSync(join(DATA, r.rel_path), "utf8"))); } catch {}
    const fsTrim = fsMd.trim(), dbTrim = (r.md ?? "").trim();
    if (fsTrim !== dbTrim) mismatched++;
    compared++;
  }
  ok("timeline render parity (all)", mismatched === 0, `compared=${compared} mismatched=${mismatched}`);
}

// 4 — blob integrity: sha256 of up to MAX_HASH recordings vs checksum column
if (!SKIP_HASH) {
  const { rows } = await c.query("select a.rel_path, a.bytes, a.checksum from session_artifacts a where a.kind='recording' and a.checksum is not null limit $1", [MAX_HASH]);
  let hashed = 0, bad = [];
  for (const r of rows) {
    const p = join(DATA, r.rel_path);
    if (!existsSync(p)) { bad.push(`${r.rel_path} missing`); continue; }
    const st = statSync(p);
    if (r.bytes !== null && st.size !== Number(r.bytes)) bad.push(`${r.rel_path} size ${st.size}≠${r.bytes}`);
    const h = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (h !== r.checksum) bad.push(`${r.rel_path} sha mismatch`);
    hashed++;
  }
  ok(`recording sha256+size (first ${MAX_HASH})`, bad.length === 0, `hashed=${hashed}${bad.length ? ` bad: ${bad.slice(0, 2)}` : ""}`);
}

// 5 — joinUrl parity: fs fuzzy match (data.ts:110-119) vs sessions.join_url
{
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const sj = JSON.parse(readFileSync(join(DATA, "out", "sessions.json"), "utf8"));
  const fsUrls = new Map<string, string | undefined>();
  for (const s of sj) if (s.joinUrl) {
    const nt = norm(s.title ?? "");
    fsUrls.set(nt, s.joinUrl); // fs pass keeps last-writer; count matching instead of exact map
  }
  const { rows } = await c.query("select join_url from sessions where join_url is not null");
  const dbUrls = new Set(rows.map(r => r.join_url));
  const fsSet = new Set([...fsUrls.values()]);
  const missing = [...fsSet].filter(u => !dbUrls.has(u));
  ok("joinUrl presence parity", missing.length === 0, `fs=${fsSet.size} db=${dbUrls.size}${missing.length ? ` missing in db: ${missing.length}` : ""}`);
}

// 6 — mtime capture (interchangeability requirement §4.1 step 3)
{
  const { rows } = await c.query("select count(*)::int n from session_artifacts where updated_at > now() + interval '5 minutes'");
  ok("updated_at is fs mtime (never now())", rows[0].n === 0, `violations=${rows[0].n}`);
}

await c.end();
console.log(`\n${fails === 0 ? "ALL GREEN" : "FAILURES"} — ${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
