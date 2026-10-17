/** Phase-4 state helpers — the last four filesystem JSON files moved into
 *  Postgres (2026-10-17). All functions are async DB accessors; when Postgres
 *  is not configured they degrade to empty/no-op so the daemon still boots in
 *  fs-only mode. Read-side shapes mirror the old JSON files exactly so the
 *  daemon's in-memory hydration + sync consumers stay unchanged.
 *
 *  Raw SQL via the shared Pool (matches writes.ts / reader.ts convention). */
import { getPool } from "./client.ts";
import { OWNER } from "./writes.ts";
import { pgConfigured } from "./reader.ts";

const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  at: string;                       // ISO-8601 (timestamptz round-trips)
}

/** Chat history for a scope ('global' or course slug), oldest → newest. */
export async function chatList(scope: string): Promise<ChatMsg[]> {
  if (!pgConfigured()) return [];
  const r = await q(
    `select role, content, at from chat_messages
     where scope = $1 and owner_user_id = $2 order by id`,
    [scope, OWNER],
  );
  return r.rows.map((x) => ({ role: x.role, content: x.content, at: new Date(x.at).toISOString() }));
}

/** Replace a scope's history with the last 100 messages (delete-then-insert). */
export async function chatSave(scope: string, msgs: ChatMsg[]): Promise<void> {
  if (!pgConfigured()) return;
  const keep = msgs.slice(-100);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`delete from chat_messages where scope = $1 and owner_user_id = $2`, [scope, OWNER]);
    for (const m of keep) {
      await client.query(
        `insert into chat_messages (scope, role, content, at, owner_user_id) values ($1,$2,$3,$4,$5)`,
        [scope, m.role, m.content, m.at, OWNER],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Clear a scope's chat history. */
export async function chatClear(scope: string): Promise<void> {
  if (!pgConfigured()) return;
  await q(`delete from chat_messages where scope = $1 and owner_user_id = $2`, [scope, OWNER]);
}

export interface AttendanceRow {
  date: string;                     // new Date().toDateString()
  title: string;
  joinedAt: number;                 // epoch-ms
  leftAt?: number;                  // epoch-ms; absent while the entry is open
}

/** Full attendance journal, oldest → newest. */
export async function attendanceLoad(): Promise<AttendanceRow[]> {
  if (!pgConfigured()) return [];
  const r = await q(
    `select date, title, joined_at as "joinedAt", left_at as "leftAt" from attendance
     where owner_user_id = $1 order by id`,
    [OWNER],
  );
  return r.rows.map((x) => ({
    date: x.date,
    title: x.title,
    joinedAt: Number(x.joinedAt),
    ...(x.leftAt != null ? { leftAt: Number(x.leftAt) } : {}),
  }));
}

/** Persist one journal entry; the caller resolves open-entry vs append.
 *  Keyed by (owner, date, title, joined_at): a join then its matching leave
 *  hit the same row, so the leave only fills in left_at. */
export async function attendanceUpsert(e: AttendanceRow): Promise<void> {
  if (!pgConfigured()) return;
  await q(
    `insert into attendance (date, title, joined_at, left_at, owner_user_id)
     values ($1,$2,$3,$4,$5)
     on conflict (owner_user_id, date, title, joined_at) do update set left_at = excluded.left_at`,
    [e.date, e.title, e.joinedAt, e.leftAt ?? null, OWNER],
  );
}

/** Titles manually left on a given 'YYYY-MM-DD' day. */
export async function leftLoad(day: string): Promise<string[]> {
  if (!pgConfigured()) return [];
  const r = await q(
    `select title from left_meetings where day = $1 and owner_user_id = $2 order by id`,
    [day, OWNER],
  );
  return r.rows.map((x) => x.title);
}

/** Record a title as left on a given day (idempotent). */
export async function leftAdd(day: string, title: string): Promise<void> {
  if (!pgConfigured()) return;
  await q(
    `insert into left_meetings (day, title, owner_user_id) values ($1,$2,$3)
     on conflict (owner_user_id, day, title) do nothing`,
    [day, title, OWNER],
  );
}

/** Keep only `day` (prune every other day's entries). */
export async function leftPruneExcept(day: string): Promise<void> {
  if (!pgConfigured()) return;
  await q(`delete from left_meetings where day <> $1 and owner_user_id = $2`, [day, OWNER]);
}

/** Clear all left-meetings (used by /scan?reset=1). */
export async function leftClear(): Promise<void> {
  if (!pgConfigured()) return;
  await q(`delete from left_meetings where owner_user_id = $1`, [OWNER]);
}

/** deadlines-meta.json → { docs: { '<course>/<relPath>': { m, s } } }. */
export async function metaLoad(): Promise<{ docs: Record<string, { m: number; s: number }> }> {
  if (!pgConfigured()) return { docs: {} };
  const r = await q(`select doc_key, mtime, size from deadlines_meta where owner_user_id = $1`, [OWNER]);
  const docs: Record<string, { m: number; s: number }> = {};
  for (const row of r.rows) docs[row.doc_key] = { m: Number(row.mtime), s: Number(row.size) };
  return { docs };
}

/** Replace the whole manifest (upsert every key + prune removed keys). */
export async function metaReplace(docs: Record<string, { m: number; s: number; course: string }>): Promise<void> {
  if (!pgConfigured()) return;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`delete from deadlines_meta where owner_user_id = $1`, [OWNER]);
    for (const [k, v] of Object.entries(docs)) {
      await client.query(
        `insert into deadlines_meta (doc_key, mtime, size, course, owner_user_id) values ($1,$2,$3,$4,$5)`,
        [k, v.m, v.s, v.course, OWNER],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
