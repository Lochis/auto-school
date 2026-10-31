#!/usr/bin/env node
/** End-to-end smoke suite — exercises the basic application flows against a
 *  LIVE daemon + Postgres, fully isolated under a dedicated smoke-test user
 *  and a `__smoke__` namespace. Never touches real data except read-only.
 *
 *  Usage (inside the backend container, where PG env + the daemon exist):
 *    node scripts/smoke.ts [--base http://127.0.0.1:7800] [--fe http://127.0.0.1:3000]
 *
 *  Requires SMOKE_OWNER_SUB (the authentik `sub`, a 64-char hex uid) and
 *  INTERNAL_HMAC_KEY (the internal daemon-hop HMAC key). EDGE_MARKER is
 *  optional and only needed for the frontend read-parity check (step 7).
 *  Every daemon call is signed like the frontend hop (lib/owner.ts
 *  daemonUserHeaders):
 *    X-Auto-School-User: <sub>
 *    X-Internal-Auth: hex(HMAC-SHA256(key, message = sub))
 *  The daemon 401s any request without a valid signature (resolveRequestOwner).
 *
 *  Every mutating step seeds scratch rows directly in PG or via daemon
 *  endpoints under the smoke owner, asserts the round-trip, and cleans up:
 *    delete from courses where slug like '__smoke__%'  (cascades sessions/…)
 *    delete from deadlines where owner_user_id = smoke (cascades folds/checks)
 *    rm -rf recordings/notes/courses __smoke__ dirs
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1]! : "http://127.0.0.1:7800";
const FE = process.argv.includes("--fe") ? process.argv[process.argv.indexOf("--fe") + 1]! : "http://127.0.0.1:3000";
const SMOKE_SUB = process.env.SMOKE_OWNER_SUB ?? "";
/** The internal daemon-hop HMAC key — the daemon verifies X-Internal-Auth
 *  against INTERNAL_HMAC_KEY (src/daemon.ts resolveRequestOwner). */
const HMAC_KEY = process.env.INTERNAL_HMAC_KEY ?? "";
/** Edge marker value for the optional frontend parity check (sent as
 *  x-edge-secret; the frontend's getAuthUser() compares against EDGE_MARKER).
 *  Optional — the frontend check is skipped when unset. */
const EDGE_MARKER = process.env.EDGE_MARKER ?? "";
/** users.id of the smoke owner — resolved from SMOKE_SUB after the pool opens. */
let SMOKE = "";
const AUTH_HDRS: Record<string, string> = {
  "X-Auto-School-User": SMOKE_SUB,
  "X-Internal-Auth": createHmac("sha256", HMAC_KEY || "").update(SMOKE_SUB).digest("hex"),
};
const HDRS: Record<string, string> = { ...AUTH_HDRS, "Content-Type": "application/json" };
const DATA = process.env.AUTO_SCHOOL_DATA ?? "/data";

if (!SMOKE_SUB || !HMAC_KEY) {
  console.error("✗ SMOKE_OWNER_SUB and INTERNAL_HMAC_KEY must be set — refusing (every daemon call would 401)");
  process.exit(2);
}

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
const { geminiApiKey } = await import("../src/db/embeddings.ts");
const pool = getPool();
const q = (text: string, params: unknown[] = []) => pool.query(text, params as never[]);

// users.id for the smoke sub (the daemon resolves sub → users.id, so the
// impersonation id is now derived, not supplied).
{
  // HARD GUARD (2026-10-31 incident): the cleanup deletes ALL
  // deadlines/checklists owned by the smoke user — running the suite as the
  // seed owner (the real user) therefore deletes the real user's deadlines.
  // The smoke owner must be a dedicated throwaway user, NEVER the seed
  // (SYSTEM_OWNER) account or the lochis sub. Refuse before touching data.
  const SEED_USER_ID = "00000000-0000-0000-0000-000000000001";
  const found = await q(`select id, username from users where authentik_sub = $1`, [SMOKE_SUB]);
  if (found.rows.length && String(found.rows[0].id) === SEED_USER_ID) {
    console.error(`✗ SMOKE_OWNER_SUB resolves to the SEED OWNER (${found.rows[0].username}) — refusing.
   The smoke suite deletes everything owned by its user (deadlines, checklists).
   Create a dedicated smoke user and pass ITS authentik_sub (never your own).`);
    process.exit(2);
  }
  SMOKE = found.rows.length
    ? String(found.rows[0].id)
    : String((await q(`insert into users (id, display_name, username, authentik_sub)
        values ($1, 'smoke test', 'smoke-test', $2)
        on conflict (authentik_sub) do update set display_name = 'smoke test' returning id`, [randomUUID(), SMOKE_SUB])).rows[0].id);
  if (SMOKE === SEED_USER_ID) {
    console.error("✗ smoke owner id collided with SEED_USER_ID — refusing.");
    process.exit(2);
  }
}

/** Poll a PG/API condition until true or timeout (fire-and-forget write races). */
async function waitFor(cond: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

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
    on conflict (slug, owner_user_id) do update set name = '__smoke__ dl' returning id`, [SMOKE])).rows[0].id;
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
  const cf = (await q(`insert into courses (slug, name, owner_user_id) values ($1,$1,$2) on conflict (slug, owner_user_id) do update set name=$1 returning id`, [from, SMOKE])).rows[0].id;
  const ct = (await q(`insert into courses (slug, name, owner_user_id) values ($1,$1,$2) on conflict (slug, owner_user_id) do update set name=$1 returning id`, [to, SMOKE])).rows[0].id;
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

console.log("\n6 · materials: upload → documents row + DB listing (Gap 3)");
{
  const M = `__smoke__Materials_${Date.now() % 100000}`;
  const c = await api("POST", "/courses/create", { name: M.replace(/_/g, " "), slug: M });
  ok("POST /courses/create (materials)", c.status === 200, JSON.stringify(c.json).slice(0, 120));

  // multipart upload (fetch sets the boundary; do NOT set Content-Type manually)
  const upHdrs: Record<string, string> = { ...AUTH_HDRS }; // multipart: no Content-Type
  const upload = async (filename: string, bytes: string, type: string) => {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), filename);
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(M)}/materials`, { method: "POST", headers: upHdrs, body: fd });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const docRow = (rel: string) => q(`select 1 from documents d join courses c on c.id=d.course_id where c.slug=$1 and d.rel_path=$2 and d.kind='material'`, [M, rel]);

  // non-embeddable file must STILL get a documents row (listing source of truth)
  const up1 = await upload("slide1.pptx", "PK dummy pptx bytes", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  ok("upload .pptx (non-embeddable)", up1.status === 200, JSON.stringify(up1.json).slice(0, 120));
  const row1 = await waitFor(async () => (await docRow("slide1.pptx")).rows.length === 1);
  ok("documents row created for .pptx", row1, "row never appeared (upsertDocumentRow)");

  // embeddable file → row + (if a Gemini key exists) chunks + indexed_at
  const up2 = await upload("readme.txt", "This is a smoke material for embedding.", "text/plain");
  ok("upload .txt (embeddable)", up2.status === 200, JSON.stringify(up2.json).slice(0, 120));
  const row2 = await waitFor(async () => (await docRow("readme.txt")).rows.length === 1);
  ok("documents row created for .txt", row2);

  // listing must come from the DB (documents) and include the non-embeddable file
  const list = await api("GET", `/courses/${encodeURIComponent(M)}/materials`);
  const paths = new Set(((list.json.materials ?? []) as any[]).map((m) => m.path));
  ok("listing includes non-embeddable .pptx (DB source)", paths.has("slide1.pptx"), JSON.stringify([...paths]));
  ok("listing includes .txt", paths.has("readme.txt"));

  const key = geminiApiKey(DATA);
  if (key) {
    const embedded = await waitFor(async () => {
      const r = await q(`select d.indexed_at, (select count(*) from document_chunks ch where ch.document_id=d.id)::int as n
        from documents d join courses c on c.id=d.course_id where c.slug=$1 and d.rel_path='readme.txt'`, [M]);
      return !!r.rows[0] && r.rows[0].indexed_at != null && Number(r.rows[0].n) > 0;
    }, 30000);
    ok("embeddable .txt chunked + embedded (indexed_at + chunks)", embedded, "embed pass never landed");
  } else {
    console.log("  (no Gemini key — embedding assertion skipped)");
  }

  await q(`delete from courses where slug = $1`, [M]).catch(() => {}); // cascades documents + chunks
}

console.log("\n7 · read-path parity (real data, read-only): daemon vs frontend vs PG");
{
  // same identity as the UI hop — every daemon call is signed now
  const daemonFeed = await fetch(`${BASE}/deadlines`, { headers: HDRS }).then((r) => r.json());
  const daemonIds = new Set(((daemonFeed.deadlines ?? []) as any[]).map((d) => `${d.id}|${d.done}`));
  let feIds: Set<string> | null = null;
  try {
    // edge-shaped identity for the frontend (honored only when the deployment
    // trusts authentik headers + the marker, i.e. TRUST_AUTHENTIK_HEADERS=1)
    const feHdrs: Record<string, string> = {
      "x-authentik-uid": SMOKE_SUB,
      "x-authentik-username": "smoke-test",
      ...(EDGE_MARKER ? { "x-edge-secret": EDGE_MARKER } : {}),
    };
    const fe = await fetch(`${FE}/api/deadlines`, { headers: feHdrs, signal: AbortSignal.timeout(5000) });
    const fj = await fe.json();
    if (!fe.ok) throw new Error(`frontend ${fe.status}`);
    feIds = new Set((fj.deadlines ?? []).map((d: any) => `${d.id}|${d.done}`));
  } catch { console.log("  (frontend unreachable or unauthenticated — skipping)"); }
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
