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

/** Gap 4b provenance: where the stored bytes came from. 'claim' rows are
 *  re-synced from the provider picture claim; 'upload' rows are user-set
 *  and never overwritten by the sync. */
export type AvatarSource = "claim" | "upload";

export interface AvatarRow {
  avatar: Buffer | null;
  avatarMime: string | null;
  avatarSyncedAt: Date | null;
  avatarSource: AvatarSource;
}

/** Read the cached avatar for a user; all-null when the user is unknown. */
export async function getAvatar(userId: string): Promise<AvatarRow> {
  const r = await getPool().query(
    `select avatar, avatar_mime, avatar_synced_at, avatar_source from users where id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { avatar: null, avatarMime: null, avatarSyncedAt: null, avatarSource: "claim" };
  return {
    avatar: row.avatar ?? null,
    avatarMime: row.avatar_mime ?? null,
    avatarSyncedAt: row.avatar_synced_at ?? null,
    avatarSource: row.avatar_source === "upload" ? "upload" : "claim",
  };
}

/** Set a user's cached avatar (bytes + mime + provenance; synced_at = now(),
 *  returned so callers can emit an exact ?v= epoch). Users are pre-seeded
 *  (bootstrap owner), so this updates an existing row. Source defaults to
 *  "claim" — the sync path; POST /api/me/avatar passes "upload" (Gap 4b). */
export async function upsertAvatar(
  userId: string,
  bytes: Buffer,
  mime: string,
  source: AvatarSource = "claim",
): Promise<Date | null> {
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `avatar is ${bytes.length} bytes, exceeds ${MAX_AVATAR_BYTES} byte cap`,
    );
  }
  const r = await getPool().query(
    `update users set avatar = $2, avatar_mime = $3, avatar_source = $4, avatar_synced_at = now()
     where id = $1 returning avatar_synced_at`,
    [userId, bytes, mime, source],
  );
  return r.rows[0]?.avatar_synced_at ?? null;
}

/** Mark the avatar as checked without storing bytes — claim absent or fetch
 *  failed; bumps synced_at so a missing/broken picture isn't retried on every
 *  page load (Gap 4 freshness gate). Also (re)asserts 'claim' provenance —
 *  this is the sync path (Gap 4b). */
export async function markAvatarSynced(userId: string): Promise<void> {
  await getPool().query(
    `update users set avatar = null, avatar_mime = null, avatar_source = 'claim', avatar_synced_at = now() where id = $1`,
    [userId],
  );
}

/** Gap 4b reset action (DELETE /api/me/avatar): drop a user-set upload and
 *  return the row to provider-sync state. synced_at is nulled — not bumped —
 *  so the immediately following syncAvatarIfNeeded re-fetches the picture
 *  claim instead of passing the 7-day freshness gate. */
export async function resetAvatarToClaim(userId: string): Promise<void> {
  await getPool().query(
    `update users set avatar = null, avatar_mime = null, avatar_synced_at = null, avatar_source = 'claim' where id = $1`,
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
