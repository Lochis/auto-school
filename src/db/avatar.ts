/** users.avatar storage — Gap 4 (docs/planning/personal-not-commercial-phase3-gaps.md).
 *  The avatar lives in `users` (bytea + mime + synced_at), not behind the
 *  auth provider's API, so a provider swap loses nothing. Storage only —
 *  lazy sync / serving live elsewhere (frontend/src/lib/auth.ts + /api/me/avatar).
 *
 *  Raw SQL via the drizzle-free Pool (matches queries/*.ts convention, safe for
 *  the frontend image which has no drizzle-orm dependency). */
import { getPool } from "./pg.ts";

/** Gap 4 hardening: reject avatars over 256KB before they reach the row. */
export const MAX_AVATAR_BYTES = 256 * 1024;

export interface AvatarRow {
  avatar: Buffer | null;
  avatarMime: string | null;
  avatarSyncedAt: Date | null;
}

/** Read the cached avatar for a user; all-null when the user is unknown. */
export async function getAvatar(userId: string): Promise<AvatarRow> {
  const r = await getPool().query(
    `select avatar, avatar_mime, avatar_synced_at from users where id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { avatar: null, avatarMime: null, avatarSyncedAt: null };
  return {
    avatar: row.avatar ?? null,
    avatarMime: row.avatar_mime ?? null,
    avatarSyncedAt: row.avatar_synced_at ?? null,
  };
}

/** Set a user's cached avatar (all three columns; synced_at = now()). Users are
 *  pre-seeded (bootstrap owner), so this updates an existing row. */
export async function upsertAvatar(userId: string, bytes: Buffer, mime: string): Promise<void> {
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `avatar is ${bytes.length} bytes, exceeds ${MAX_AVATAR_BYTES} byte cap`,
    );
  }
  await getPool().query(
    `update users set avatar = $2, avatar_mime = $3, avatar_synced_at = now() where id = $1`,
    [userId, bytes, mime],
  );
}

/** Mark the avatar as checked without storing bytes — claim absent or fetch
 *  failed; bumps synced_at so a missing/broken picture isn't retried on every
 *  page load (Gap 4 freshness gate). */
export async function markAvatarSynced(userId: string): Promise<void> {
  await getPool().query(
    `update users set avatar = null, avatar_mime = null, avatar_synced_at = now() where id = $1`,
    [userId],
  );
}

/** Resolve a user id by authentik_sub — the value stored is X-authentik-uid
 *  (the authentik user pk, per authentik-federation.md §5), the stable key
 *  Gap 4's claim/JIT step writes. Null when the sub is unknown. */
export async function getUserIdBySub(sub: string): Promise<string | null> {
  const r = await getPool().query(`select id from users where authentik_sub = $1`, [sub]);
  return (r.rows[0]?.id as string) ?? null;
}
