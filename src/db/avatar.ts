/** users.avatar storage — Gap 4 (docs/planning/personal-not-commercial-phase3-gaps.md).
 *  The avatar lives in `users` (bytea + mime + synced_at) and is either a
 *  user upload or nothing (FaceHash identicon default). There is NO provider
 *  sync — the JWT picture-claim path was removed by owner decision (2026-10-18):
 *  provider-agnostic by construction, not by mapping.
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

/** Store a user-uploaded avatar (bytes + mime; synced_at = now(), returned so
 *  callers can emit an exact ?v= epoch). Users are pre-seeded (bootstrap
 *  owner) or JIT-provisioned, so this updates an existing row. */
export async function upsertAvatar(
  userId: string,
  bytes: Buffer,
  mime: string,
): Promise<Date | null> {
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `avatar is ${bytes.length} bytes, exceeds ${MAX_AVATAR_BYTES} byte cap`,
    );
  }
  const r = await getPool().query(
    `update users set avatar = $2, avatar_mime = $3, avatar_synced_at = now()
     where id = $1 returning avatar_synced_at`,
    [userId, bytes, mime],
  );
  return r.rows[0]?.avatar_synced_at ?? null;
}

/** Remove a user-uploaded avatar (DELETE /api/me/avatar): nulls the blob so
 *  /api/me/avatar falls back to the FaceHash identicon. synced_at is bumped
 * (not nulled) so the client's next /api/me gets a fresh ?v= cache-buster. */
export async function clearAvatar(userId: string): Promise<void> {
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
