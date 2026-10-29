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
 *  - Edge marker (OWNER of the trust decision, security fix wave E): when
 *    EDGE_SECRET is configured (required in the platform manifest) the
 *    request must ALSO carry X-Edge-Secret: <EDGE_SECRET> or getAuthUser()
 *    returns null → every caller 401s. The marker is checked HERE, in the
 *    node runtime, from headers only (no body): the streaming upload routes
 *    (/api/ingest, /api/courses/<slug>/materials) are excluded from
 *    src/middleware.ts because Next's edge runtime clones+buffers every
 *    non-GET body it sees and truncates at 10MB — a lecture-sized upload
 *    would be silently cut. Those two routes therefore rely on this check.
 *  - src/middleware.ts keeps stripping client-supplied X-authentik-* /
 *    X-Auto-School-User / X-Internal-Auth on every OTHER route as
 *    defense-in-depth; it is no longer the only enforcement point.
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
  /** /api/me fills this with /api/me/avatar[?v=<epoch>] — the DB-backed
   *  avatar route (upload or FaceHash identicon). Not derived from any
   *  provider claim (Gap 4 rework, 2026-10-18). */
  avatarUrl?: string;
}

const ADMIN_GROUP = process.env.AUTHENTIK_ADMIN_GROUP || "auto-school-admins";

export function trustAuthentikHeaders(): boolean {
  return process.env.TRUST_AUTHENTIK_HEADERS === "1";
}

/** Resolve the logged-in user from the edge-injected headers, or null. */
export async function getAuthUser(): Promise<AuthUser | null> {
  if (!trustAuthentikHeaders()) return null;
  const h = await headers();
  // Edge-marker trust: with EDGE_SECRET configured, headers that the
  // authentik outpost did not stamp (kubectl port-forward, direct pod hit,
  // spoofed curl) are unauthenticated — fail closed. No secret ⇒ no edge to
  // prove (local `next dev`, docker-compose) and TRUST_AUTHENTIK_HEADERS
  // already gates the rest.
  const secret = process.env.EDGE_SECRET;
  if (secret && h.get("x-edge-secret") !== secret) return null;
  const uid = h.get("x-authentik-uid");
  if (!uid) return null; // not behind the authentik outpost
  const groups = (h.get("x-authentik-groups") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    uid,
    username: h.get("x-authentik-username") ?? uid,
    name: h.get("x-authentik-name") || undefined,
    email: h.get("x-authentik-email") || undefined,
    groups,
    role: groups.includes(ADMIN_GROUP) ? "admin" : "member",
  };
}
