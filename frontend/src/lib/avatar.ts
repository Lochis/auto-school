/** Avatar lazy-sync + hardened claim resolution — Gap 4
 *  (docs/planning/personal-not-commercial-phase3-gaps.md §Gap 4).
 *
 *  The DB (users.avatar, via src/db/avatar.ts) is the source of truth for
 *  serving; the JWT `picture` claim is only a *sync source*, consumed
 *  server-side by /api/me. Writes happen there — at most once per
 *  AVATAR_SYNC_INTERVAL_MS per user — never inside getAuthUser().
 *
 *  Nothing here throws: DB-down or a bad picture degrades to
 *  avatarUrl: undefined (UI initials), and /api/me still 200s.
 *
 *  Connection: shared Pool from src/db/pg.ts (same import as lib/db.ts). */
import type { AuthUser } from "./auth";
import { getPool } from "../../../src/db/pg.ts";
import {
  MAX_AVATAR_BYTES,
  getAvatar,
  getUserIdBySub,
  markAvatarSynced,
  upsertAvatar,
} from "../../../src/db/avatar.ts";

/** Gap 4 hardening: reject avatars over 256KB (re-exported storage cap). */
export { MAX_AVATAR_BYTES as AVATAR_MAX_BYTES };

/** Re-sync from the picture claim at most once a week (mirrors the 7d
 *  private cache on /api/me/avatar). */
export const AVATAR_SYNC_INTERVAL_MS = 7 * 24 * 3600 * 1000;
/** A hostile `picture` URL must not hang the /api/me request. */
export const AVATAR_FETCH_TIMEOUT_MS = 10_000;
/** Stored-XSS surface control: only these mimes may enter users.avatar. */
export const AVATAR_MIME_ALLOWLIST = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** Hardened claim → bytes: decode a data URI or fetch an http(s) URL under
 *  the size cap (enforced on the wire, not just via Content-Length), the
 *  mime allowlist, a fetch timeout, and redirect: "manual". Never throws —
 *  any failure returns null and the caller degrades to initials. */
export async function resolveAvatarBytes(
  picture: string | undefined,
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!picture) return null;
  try {
    // data URI (authentik's generated initials avatar)
    const m = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/.exec(picture);
    if (m) {
      if (!AVATAR_MIME_ALLOWLIST.includes(m[1])) return null;
      // cap applies to the *decoded* size: bound the base64 before decoding
      if (m[2].length > (MAX_AVATAR_BYTES * 4) / 3 + 4) return null;
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > MAX_AVATAR_BYTES) return null;
      return { bytes: buf, mime: m[1] };
    }

    // http(s) URL (gravatar / custom avatar attribute)
    if (/^https?:\/\//i.test(picture)) {
      const res = await fetch(picture, {
        cache: "no-store",
        signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
        redirect: "manual", // no bouncing a "picture" elsewhere
      });
      if (!res.ok || !res.body) return null;
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!AVATAR_MIME_ALLOWLIST.includes(mime)) return null;
      // cheap early reject when the header is honest; the count below is
      // the real cap — never trust Content-Length alone
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > MAX_AVATAR_BYTES) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_AVATAR_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length > MAX_AVATAR_BYTES) return null;
      return { bytes, mime };
    }
    return null;
  } catch {
    return null; // timeout / bad base64 / network failure
  }
}

/** Lazy avatar sync — called only from /api/me. Claims the identity row
 *  (seed 'lochis' row on first login, JIT row for other users; idempotent,
 *  per authentik-federation.md §5), then serves from DB unless
 *  avatar_synced_at is missing or older than 7 days, in which case it
 *  re-syncs from the picture claim. A missing/broken claim still bumps
 *  synced_at (marked "checked") so it isn't retried every page load.
 *  Returns the effective synced_at, or null on any failure. Never throws. */
export async function syncAvatarIfNeeded(user: AuthUser): Promise<Date | null> {
  try {
    const pool = getPool();
    // Claim the pre-seeded row once (authentik_sub is NULL until first login).
    await pool.query(
      `update users set authentik_sub = $1 where authentik_sub is null and username = $2`,
      [user.uid, user.username],
    );
    // JIT-provision other users (username collision throws → caught below,
    // degrade gracefully).
    await pool.query(
      `insert into users (authentik_sub, username, display_name) values ($1, $2, $3)
       on conflict (authentik_sub) do nothing`,
      [user.uid, user.username, user.name ?? user.username],
    );
    const id = await getUserIdBySub(user.uid);
    if (!id) return null;

    // Freshness gate: at most one write per 7 days.
    const row = await getAvatar(id);
    if (row.avatarSyncedAt && Date.now() - row.avatarSyncedAt.getTime() < AVATAR_SYNC_INTERVAL_MS) {
      return row.avatarSyncedAt;
    }

    const resolved = await resolveAvatarBytes(user.avatarUrl);
    if (resolved) await upsertAvatar(id, resolved.bytes, resolved.mime);
    else await markAvatarSynced(id);
    return new Date();
  } catch {
    return null; // DB down / claim-row collision — /api/me must still 200
  }
}

/** Serving path for /api/me/avatar: resolve sub → user id → cached bytes.
 *  Read-only; null when the user/avatar row is unknown or empty. */
export async function getAvatarFor(uid: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const id = await getUserIdBySub(uid);
  if (!id) return null;
  const row = await getAvatar(id);
  if (!row.avatar || !row.avatarMime) return null;
  return { bytes: row.avatar, mime: row.avatarMime };
}
