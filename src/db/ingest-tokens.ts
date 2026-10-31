/** Per-user ingest tokens (docs/planning/per-user-ingest-tokens.md §1-§3) —
 *  drizzle-free Pool, matching src/db/recorders.ts style so the frontend
 *  image can import it without the drizzle-orm dependency. Only `token_hash`
 *  is stored: the raw `asi_…` bearer is shown ONCE at mint (GitHub-PAT
 *  model), so the DB can never leak a usable credential. Lookups are
 *  hash-then-index (no compare, no state oracle — revoked/expired/unknown
 *  all read as a miss → the route's single 401). No token→owner cache:
 *  every ingest hits PG, so revocation is immediate (§6). */
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./pg.ts";

export interface IngestTokenMeta {
  id: string;
  prefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ResolvedIngestToken {
  ownerUserId: string;
  tokenId: string;
  prefix: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Active-token soft cap per owner (§6 Over-issuance) — cheap, avoids
 *  unbounded rows. Revoked/expired rows don't count. */
const MAX_ACTIVE_TOKENS = 20;

/** Mint a token for `ownerUserId`: generate `asi_<base64url(32 random
 *  bytes)>` (256-bit), store ONLY the sha256 hex hash + 12-char display
 *  prefix, and return the RAW token — it leaves the server exactly once.
 *  Returns null when the owner is at the active-token cap. */
export async function createIngestToken(
  ownerUserId: string,
  label: string,
  expiresAt: Date | null,
): Promise<{ id: string; token: string; prefix: string; label: string } | null> {
  const pool = getPool();
  const cap = await pool.query(
    `select count(*)::int as n from ingest_tokens
     where owner_user_id = $1 and revoked_at is null
       and (expires_at is null or expires_at > now())`,
    [ownerUserId],
  );
  if ((cap.rows[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS) return null;

  const token = `asi_${randomBytes(32).toString("base64url")}`;
  const cleanLabel = label.slice(0, 64);
  const r = await pool.query(
    `insert into ingest_tokens (owner_user_id, token_hash, prefix, label, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id, prefix, label`,
    [ownerUserId, sha256hex(token), token.slice(0, 12), cleanLabel, expiresAt],
  );
  const row = r.rows[0];
  return {
    id: row.id as string,
    token, // raw — shown once in the create response, never stored
    prefix: row.prefix as string,
    label: row.label as string,
  };
}

/** Bearer → active token row → owner. NULL on miss/revoked/expired — one
 *  response shape upstream, no state oracle (§6). Joins users so a token
 *  whose owner row vanished resolves as a miss (fail closed). */
export async function resolveIngestToken(raw: string): Promise<ResolvedIngestToken | null> {
  if (!raw) return null;
  const r = await getPool().query(
    `select t.id, t.prefix, t.owner_user_id
     from ingest_tokens t
     join users u on u.id = t.owner_user_id
     where t.token_hash = $1 and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())`,
    [sha256hex(raw)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Fire-and-forget audit bump (§1 last_used_at): never awaited into the
  // response path, never fails the ingest.
  void getPool()
    .query(`update ingest_tokens set last_used_at = now() where id = $1`, [row.id])
    .catch(() => {});
  return {
    ownerUserId: row.owner_user_id as string,
    tokenId: row.id as string,
    prefix: row.prefix as string,
  };
}

/** Profile list for an owner — metadata only, NEVER token_hash (§1). */
export async function listIngestTokens(ownerUserId: string): Promise<IngestTokenMeta[]> {
  const r = await getPool().query(
    `select id, prefix, label, created_at, last_used_at, expires_at, revoked_at
     from ingest_tokens
     where owner_user_id = $1
     order by created_at desc`,
    [ownerUserId],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    prefix: row.prefix as string,
    label: row.label as string,
    createdAt: row.created_at as Date,
    lastUsedAt: (row.last_used_at as Date | null) ?? null,
    expiresAt: (row.expires_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
  }));
}

/** Revoke owner-scoped: `where id AND owner_user_id` — another user's token
 *  id is indistinguishable from a nonexistent one. Returns rows affected
 *  (0 → the caller 404s). */
export async function revokeIngestToken(ownerUserId: string, id: string): Promise<number> {
  const r = await getPool().query(
    `update ingest_tokens set revoked_at = now()
     where id = $1 and owner_user_id = $2`,
    [id, ownerUserId],
  );
  return r.rowCount ?? 0;
}
