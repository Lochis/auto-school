/** Avatar helpers — Gap 4, post-rework (2026-10-18)
 *  (docs/planning/personal-not-commercial-phase3-gaps.md §Gap 4).
 *
 *  The DB (users.avatar, via src/db/avatar.ts) holds the ONLY avatar state:
 *  a user upload, or nothing — in which case /api/me/avatar serves the
 *  FaceHash identicon. There is NO provider sync: the JWT picture-claim
 *  path was removed by owner decision. `avatar_synced_at` survives purely
 *  as a write-timestamp for cache-busting (?v=).
 *
 *  ensureUserRow stays: it is identity infrastructure (claims the pre-seeded
 *  row on first login / JIT-provisions new users, per
 *  docs/planning/authentik-federation.md §5) that Phase 1 will build on.
 *
 *  Nothing here throws: DB-down degrades to a plain /api/me/avatar URL
 *  (FaceHash), and /api/me still 200s.
 *
 *  Connection: shared Pool from src/db/pg.ts (same import as lib/db.ts). */
import type { AuthUser } from "./auth";
import { getPool } from "../../../src/db/pg.ts";
import {
  MAX_AVATAR_BYTES,
  clearAvatar,
  getAvatar,
  getUserIdBySub,
  upsertAvatar,
} from "../../../src/db/avatar.ts";

/** Gap 4 hardening: reject avatars over 256KB (re-exported storage cap). */
export {
  MAX_AVATAR_BYTES as AVATAR_MAX_BYTES,
  MAX_AVATAR_BYTES,
  clearAvatar,
  upsertAvatar,
};

/** Stored-XSS surface control: only these mimes may enter users.avatar. */
export const AVATAR_MIME_ALLOWLIST = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** Identity claim/JIT step: claim the pre-seeded identity row on first login
 *  (authentik_sub is NULL until then), JIT-provision rows for other users,
 *  then resolve the row id (idempotent, per authentik-federation.md §5).
 *  May throw on DB failure — callers wrap; null when the row can't be
 *  resolved. Shared by /api/me and the /api/me/avatar POST/DELETE handlers
 *  so no path duplicates the SQL. */
export async function ensureUserRow(user: AuthUser): Promise<string | null> {
  const pool = getPool();
  await pool.query(
    `update users set authentik_sub = $1 where authentik_sub is null and username = $2`,
    [user.uid, user.username],
  );
  // JIT-provision other users (username collision throws → caller degrades
  // gracefully).
  await pool.query(
    `insert into users (authentik_sub, username, display_name) values ($1, $2, $3)
     on conflict (authentik_sub) do nothing`,
    [user.uid, user.username, user.name ?? user.username],
  );
  return getUserIdBySub(user.uid);
}

/** Resolve a sub → user id → avatar write-timestamp, for /api/me's ?v=
 *  cache-buster. Also runs the idempotent claim/JIT first (the only write —
 *  at most once per user ever). Returns the epoch ms or null; never throws. */
export async function avatarEpoch(user: AuthUser): Promise<number | null> {
  try {
    const id = await ensureUserRow(user);
    if (!id) return null;
    const row = await getAvatar(id);
    return row.avatarSyncedAt?.getTime() ?? null;
  } catch {
    return null; // DB down — plain /api/me/avatar (FaceHash) is fine
  }
}

/** Serving path for /api/me/avatar: resolve sub → user id → stored bytes.
 *  Read-only; null when the user/avatar row is unknown or empty (→ FaceHash). */
export async function getAvatarFor(uid: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const id = await getUserIdBySub(uid);
  if (!id) return null;
  const row = await getAvatar(id);
  if (!row.avatar || !row.avatarMime) return null;
  return { bytes: row.avatar, mime: row.avatarMime };
}
