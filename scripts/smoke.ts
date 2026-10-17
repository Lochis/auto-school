#!/usr/bin/env node
/** End-to-end smoke suite — exercises the basic application flows against a
 *  LIVE daemon + Postgres, fully isolated under a dedicated smoke-test user
 *  and a `__smoke__` namespace. Never touches real data except read-only.
 *
 *  Usage (inside the backend container, where PG env + the daemon exist):
 *    node scripts/smoke.ts [--base http://127.0.0.1:7800] [--fe http://127.0.0.1:3000]
 *
 *  Requires SMOKE_OWNER_UUID to be set identically in THIS process and the
 *  daemon env — the daemon then honors `x-owner-uuid` for owner-scoped
 *  endpoints (deadlines/folds/checklists). Unset env = header ignored.
 *
 *  Every mutating step seeds scratch rows directly in PG or via daemon
 *  endpoints under the smoke owner, asserts the round-trip, and cleans up:
 *    delete from courses where slug like '__smoke__%'  (cascades sessions/…)
 *    delete from deadlines where owner_user_id = smoke (cascades folds/checks)
 *    rm -rf recordings/notes/courses __smoke__ dirs
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1]! : "http://127.0.0.1:7800";
const FE = process.argv.includes("--fe") ? process.argv[process.argv.indexOf("--fe") + 1]! : "http://127.0.0.1:3000";
const SMOKE = process.env.SMOKE_OWNER_UUID ?? "";
const HDRS: Record<string, string> = SMOKE ? { "x-owner-uuid": SMOKE, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
const DATA = process.env.AUTO_SCHOOL_DATA ?? "/data";

if (!SMOKE) { console.error("✗ SMOKE_OWNER_UUID not set — refusing (would run as the real owner)"); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
};

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: HDRS, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const { getPool } = await import("../src/db/client.ts");
const pool = getPool();
const q = (text: string, params: unknown[] = []) => pool.query(text, params as never[]);

// ── seed + cleanup ──────────────────────────────────────────────────────────
async function seed(): Promise<void> {
  await q(
    `insert into users (id, display_name, username, role) values ($1, 'smoke test', 'smoke-test', 'member')
     on conflict (id) do update set display_name = 'smoke test'`,
    [SMOKE]);
}
async function cleanup(): Promise<void> {
  await q(`delete from courses where slug like '\\_\\_smoke\\_\\_%'`).catch(() => {}); // eslint-disable-line
  await q(`delete from courses where slug like '__smoke__%'`).catch(() => {});
  await q(`delete from deadlines where owner_user_id = $1`, [SMOKE]).catch(() => {});
  for (const root of ["recordings", "notes", "courses"]) {
    try {
      for (const d of readdirSync(join(DATA, root))) if (d.startsWith("__smoke__")) rmSync(join(DATA, root, d), { recursive: true, force: true });
    } catch { /* dir absent */ }
  }
}

// ── the suite ───────────────────────────────────────────────────────────────
await cleanup(); await seed();

console.log("\n1 · health + status board");
{
  const h = await api("GET", "/healthz");
  ok("GET /healthz", h.status === 200 && h.json.ok === true);
  const s = await api("GET", "/status");
  ok("GET /status has rehydrated board", Array.isArray(s.json.sessions), `sessions=${typeof s.json.sessions}`);
}

console.log("\n2 · course lifecycle (create → config → rename)");
const A = `__smoke__Course_${Date.now() % 100000}`;
const B = `__smoke__Renamed_${Date.now() % 100000}`;
{
  const c = await api("POST", "/courses/create", { name: A.replace(/_/g, " "), slug: A });
  ok("POST /courses/create", c.status === 200, JSON.stringify(c.json).slice(0, 120));
  const rowA = await q(`select id, semester_start from courses where slug = $1`, [A]);
  ok("course row exists in PG (create registers)", rowA.rows.length === 1);
  await api("PUT", `/courses/${encodeURIComponent(A)}/config`, { semesterStart: "2026-09-08", icon: "📌" });
  const cfg = await q(`select semester_start::text, icon from courses where slug = $1`, [A]);
  ok("config PUT mirrors into PG", cfg.rows[0]?.semester_start === "2026-09-08", JSON.stringify(cfg.rows[0]));
  const idA = rowA.rows[0]?.id;
  const r = await api("POST", `/courses/${encodeURIComponent(A)}/rename`, { to: B });
  ok("POST /courses/rename", r.status === 200, JSON.stringify(r.json).slice(0, 120));
  const rows = await q(`select id, slug from courses where slug = any($1) order by id`, [[A, B]]);
  ok("rename updates the SAME row (no dup/ghost)", rows.rows.length === 1 && String(rows.rows[0].slug) === B && String(rows.rows[0].id) === String(idA), JSON.stringify(rows.rows));
}

console.log("\n3 · mapping");
{
  const m = await api("PUT", "/mapping", { title: "__smoke__ Meeting", folder: B });
  ok("PUT /mapping", m.status === 200 && m.json.mapping?.["__smoke__ Meeting"] === B, JSON.stringify(m.json).slice(0, 120));
  const d = await api("DELETE", `/mapping?title=${encodeURIComponent("__smoke__ Meeting")}`);
  ok("DELETE /mapping", d.status === 200);
}

console.log("\n4 · deadlines (owner-scoped): feed · toggle · fold");
{
  // seed parent + child under the smoke owner, as the importer would
  const cid = (await q(`insert into courses (slug, name, owner_user_id) values ('__smoke__dl', '__smoke__ dl', $1)
    on conflict (slug) do update set name = '__smoke__ dl' returning id`, [SMOKE])).rows[0].id;
  const parent = (await q(`insert into deadlines (legacy_id, course_id, title, due, kind, owner_user_id)
    values ('smokeparent', $1, '__smoke__ Parent Assignment', '2026-11-01', 'assignment', $2) returning id`, [cid, SMOKE])).rows[0].id;
  await q(`insert into deadlines (legacy_id, course_id, title, due, kind, owner_user_id)
    values ('smokechild', $1, '__smoke__ Child Part', '2026-11-02', 'assignment', $2)`, [cid, SMOKE]);
  const feed = await api("GET", "/deadlines");
  const ids = (feed.json.deadlines ?? []).map((d: any) => d.id);
  ok("GET /deadlines shows smoke rows", ids.includes("smokeparent") && ids.includes("smokechild"));
  const f = await api("POST", "/deadlines", { fold: { parent: "smokeparent", child: "smokechild" } });
  ok("fold child into parent", f.status === 200, JSON.stringify(f.json).slice(0, 120));
  const after = await api("GET", "/deadlines");
  const left = (after.json.deadlines ?? []).filter((d: any) => ["smokeparent", "smokechild"].includes(d.id));
  ok("folded child no longer a standalone item", left.length === 1 && left[0].id === "smokeparent", JSON.stringify(left.map((x: any) => x.id)));
  const t = await api("POST", "/deadlines", { id: "smokeparent", done: true });
  ok("toggle done accepted", t.status === 200, JSON.stringify(t.json).slice(0, 120));
  const back = await api("GET", "/deadlines");
  const mine = (back.json.deadlines ?? []).find((d: any) => d.id === "smokeparent");
  ok("toggle PERSISTS across a fresh read", mine?.done === true, JSON.stringify(mine).slice(0, 80));
  await q(`delete from courses where slug = '__smoke__dl'`).catch(() => {});
}

console.log("\n5 · session move + delete (fs + PG)");
{
  const from = "__smoke__From", to = "__smoke__To";
  mkdirSync(join(DATA, "recordings", from), { recursive: true });
  mkdirSync(join(DATA, "notes", from), { recursive: true });
  mkdirSync(join(DATA, "recordings", to), { recursive: true }); // /session/move requires the target to exist in allCourses()
  writeFileSync(join(DATA, "recordings", from, "2026-10-17____smoke__.webm"), "x");
  writeFileSync(join(DATA, "notes", from, "2026-10-17____smoke____notes.md"), "# notes");
  const cf = (await q(`insert into courses (slug, name, owner_user_id) values ($1,$1,$2) on conflict (slug) do update set name=$1 returning id`, [from, SMOKE])).rows[0].id;
  const ct = (await q(`insert into courses (slug, name, owner_user_id) values ($1,$1,$2) on conflict (slug) do update set name=$1 returning id`, [to, SMOKE])).rows[0].id;
  const sid = (await q(`insert into sessions (course_id, stem, session_date, title, stage, owner_user_id)
    values ($1, '2026-10-17____smoke__', '2026-10-17', '__smoke__ session', 'done', $2) returning id`, [cf, SMOKE])).rows[0].id;
  const m = await api("POST", "/session/move", { from, to, stem: "2026-10-17____smoke__" });
  ok("POST /session/move", m.status === 200, JSON.stringify(m.json).slice(0, 120));
  const moved = await q(`select course_id from sessions where id = $1`, [sid]);
  ok("session row reassigned in PG", String(moved.rows[0]?.course_id) === String(ct), JSON.stringify(moved.rows));
  ok("recording file moved on fs", existsSync(join(DATA, "recordings", to, "2026-10-17____smoke__.webm")));
  const d = await api("DELETE", `/session?course=${to}&stem=2026-10-17____smoke__`);
  ok("DELETE /session", d.status === 200, JSON.stringify(d.json).slice(0, 120));
  const gone = await q(`select 1 from sessions where id = $1`, [sid]);
  ok("session row deleted in PG", gone.rows.length === 0);
}

console.log("\n6 · read-path parity (real data, read-only): daemon vs frontend vs PG");
{
  const daemonFeed = await fetch(`${BASE}/deadlines`, { headers: { "Content-Type": "application/json" } }).then((r) => r.json()); // NO smoke header — real owner, like the UI
  const daemonIds = new Set(((daemonFeed.deadlines ?? []) as any[]).map((d) => `${d.id}|${d.done}`));
  let feIds: Set<string> | null = null;
  try {
    const fe = await fetch(`${FE}/api/deadlines`, { signal: AbortSignal.timeout(5000) });
    const fj = await fe.json();
    feIds = new Set((fj.deadlines ?? []).map((d: any) => `${d.id}|${d.done}`));
  } catch { console.log("  (frontend unreachable — skipping)"); }
  if (feIds) {
    const missing = [...daemonIds].filter((x) => !feIds.has(x));
    const extra = [...feIds].filter((x) => !daemonIds.has(x));
    ok("frontend feed ≡ daemon feed (ids + done flags)", missing.length === 0 && extra.length === 0,
      `daemon-only: ${missing.slice(0, 3)} fe-only: ${extra.slice(0, 3)}`);
  }
}

await cleanup();
console.log(`\n${fail === 0 ? "✅" : "❌"} smoke: ${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
