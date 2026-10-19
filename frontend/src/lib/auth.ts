/**
 * Server-only Authentik identity (Phase 0 of the federation plan —
 * docs/planning/authentik-federation.md on branch plan/postgres-migration).
 *
 * Identity arrives as X-authentik-* headers set by the Authentik outpost and
 * copied onto the request by Traefik's forwardAuth middleware
 * (authResponseHeadersRegex strips any client-supplied spoofed copies).
 *
 * Trust rules:
 *  - Headers are only honored when TRUST_AUTHENTIK_HEADERS=1 (set in the
 *    frontend container env, NOT in local dev) — local `next dev` can't be
 *    spoofed by a stray curl.
 *  - If EDGE_SECRET is configured, src/middleware.ts additionally strips
 *    X-authentik-* from any request that didn't come through the Traefik
 *    edge middleware (e.g. kubectl port-forward hits the pod directly).
 */
import { headers } from "next/headers";

export interface AuthUser {
  /** stable authentik user pk — the ONLY key per-user data may hang off */
  uid: string;
  /** preferred_username (mutable handle) */
  username: string;
  name?: string;
  email?: string;
  groups: string[];
  role: "admin" | "member";
  /** avatar sync source only (Gap 4): the X-authentik-jwt `picture` claim
   *  (http(s) URL or data URI, or undefined). Consumed server-side by
   *  /api/me's lazy sync into users.avatar — never sent to the browser
   *  as-is; the browser gets /api/me/avatar?v=<epoch> from the DB. */
  avatarUrl?: string;
}

const ADMIN_GROUP = process.env.AUTHENTIK_ADMIN_GROUP || "auto-school-admins";

export function trustAuthentikHeaders(): boolean {
  return process.env.TRUST_AUTHENTIK_HEADERS === "1";
}

/** Decode the unverified JWT payload from X-authentik-jwt. Same trust model
 *  as the sibling headers (they only arrive via the trusted Traefik edge);
 *  JWKS verification via X-authentik-meta-jwks is a later hardening step. */
function jwtClaims(jwt: string | null): Record<string, unknown> | null {
  const part = jwt?.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Resolve the logged-in user from the edge-injected headers, or null. */
export async function getAuthUser(): Promise<AuthUser | null> {
  if (!trustAuthentikHeaders()) return null;
  const h = await headers();
  const uid = h.get("x-authentik-uid");
  if (!uid) return null; // not behind the authentik outpost
  const groups = (h.get("x-authentik-groups") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const picture = jwtClaims(h.get("x-authentik-jwt"))?.picture;
  const avatarUrl =
    typeof picture === "string" && /^(https?:\/\/|data:image\/)/i.test(picture) && picture.length < 8192
      ? picture
      : undefined;
  return {
    uid,
    username: h.get("x-authentik-username") ?? uid,
    name: h.get("x-authentik-name") || undefined,
    email: h.get("x-authentik-email") || undefined,
    groups,
    role: groups.includes(ADMIN_GROUP) ? "admin" : "member",
    avatarUrl,
  };
}
