/** Per-request owner resolution (Authentik Phase 1) — the single uid→id seam
 *  shared by the direct-PG read paths and the daemon-proxy hop.
 *
 *  TWO rules, both fail-closed (docs/planning/security-hardening.md §"Shared
 *  contract" 1+2 — fix wave A):
 *  - Identity is never guessed. `requireUser()` returns the authenticated
 *    owner's users.id or `null`; a route that gets `null` MUST answer 401
 *    (`unauthorized()`), never the seed owner's rows. `ownerId()` returns
 *    `undefined` (no owner filter) for the fs/dev read paths — it NEVER
 *    returns SYSTEM_OWNER.
 *  - The frontend→daemon hop is authenticated: `daemonUserHeaders()` sets
 *    X-Auto-School-User: <sub> AND
 *    X-Internal-Auth: HMAC-SHA256(key=INTERNAL_HMAC_KEY, message=sub) hex. The
 *    daemon verifies the same HMAC (src/daemon.ts resolveRequestOwner) and
 *    401s on absent/mismatch. No user / no secret → throw (routes 401 first).
 *
 *  `SYSTEM_OWNER` survives ONLY for a deployment without any Authentik edge
 *  (localIdentity: neither TRUST_AUTHENTIK_HEADERS nor EDGE_MARKER set —
 *  `next dev`, the standalone docker-compose install). No user-facing route
 *  may fall back to it, and an edge-fronted deployment (TRUST=1 + EDGE_MARKER,
 *  the platform manifest) never reaches it: a request without a resolvable
 *  edge identity gets 401.
 *
 *  Never leaks: DB-down degrades to `undefined`/`null` (caller 401s), not to
 *  an unfiltered view. */
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser, trustAuthentikHeaders } from "./auth";
import { ensureUserRow } from "./avatar";

/** The seed system owner (src/db/writes.ts OWNER). Local single-user
 *  deployments only — never returned by ownerId(), never a route fallback. */
export const SYSTEM_OWNER = "00000000-0000-0000-0000-000000000001";

/** The one 401 body every user-facing route emits when no owner resolves. */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Internal hop proof: hex(HMAC-SHA256(key = INTERNAL_HMAC_KEY, message = sub)).
 *  Mirrored by the daemon's resolveRequestOwner (src/daemon.ts). */
export function internalAuthHmac(secret: string, sub: string): string {
  return createHmac("sha256", secret).update(sub).digest("hex");
}

/** Single-user identity for a deployment that has NO Authentik edge at all
 *  (local `next dev`, deploy/docker-compose.yml, the pre-Phase-0 standalone
 *  image): neither TRUST_AUTHENTIK_HEADERS nor EDGE_MARKER is set there, so
 *  there is no identity to spoof and the seed owner is the only user —
 *  exactly the pre-federation behavior. As soon as EDGE_MARKER exists an edge
 *  is deployed, so a deployment that forgot TRUST_AUTHENTIK_HEADERS=1 is a
 *  misconfiguration: `undefined` here makes requireUser() fail closed (401)
 *  rather than silently becoming a single-user install behind a login wall. */
function localIdentity(): string | undefined {
  if (trustAuthentikHeaders()) return undefined; // edge deployment — no fallback
  if (process.env.EDGE_MARKER) return undefined; // edge without header trust → 401
  return SYSTEM_OWNER;
}

/** users.id for the authenticated user, or undefined when no identity
 *  resolves. `undefined` means "no owner filter" — the pre-Phase-1 read shape
 *  used by the fs/dev readers (lib/backend.ts). Deliberately NOT SYSTEM_OWNER:
 *  an unauthenticated request must never be scoped to the seed owner. */
export async function ownerId(): Promise<string | undefined> {
  const u = await getAuthUser();
  if (!u) return undefined;
  try {
    return (await ensureUserRow(u)) ?? undefined;
  } catch {
    return undefined; // DB down → no owner filter, never a fabricated owner
  }
}

/** The gate for user-facing routes: the authenticated owner's users.id, or
 *  null → the caller returns unauthorized() (401). Fails closed on every
 *  uncertainty of a trusted-edge deployment: missing identity, missing
 *  EDGE_MARKER (spoofable edge — the marker chain is broken), or a DB
 *  failure.
 *
  *  `SYSTEM_OWNER` is returned ONLY for a deployment with no Authentik edge at
 *  all (localIdentity). Every other case either resolves a real owner or gets
 *  401. */
export async function requireUser(): Promise<string | null> {
  const local = localIdentity();
  if (local) return local; // no authentik in this deployment: single account
  // Header trust without the edge marker is spoofable: no shared secret means
  // src/middleware.ts cannot prove the X-authentik-* headers came from the
  // outpost. Fail closed (the platform manifest makes EDGE_MARKER required).
  if (!process.env.EDGE_MARKER) return null;
  const u = await getAuthUser();
  if (!u) return null;
  try {
    return (await ensureUserRow(u)) ?? null;
  } catch {
    return null; // DB down → 401, not the seed owner's data
  }
}

/** Headers for a daemon hop:
 *    X-Auto-School-User: <authentik sub>
 *    X-Internal-Auth:    hex(HMAC-SHA256(INTERNAL_HMAC_KEY, sub))
 *  Throws when the hop cannot be authenticated (no user in a trusted-edge
 *  build, or INTERNAL_HMAC_KEY unset) — guarded routes 401 before reaching this, so
 *  a throw here is a misconfiguration, never a silent fallback to the daemon's
 *  seed OWNER. A deployment with no Authentik edge (TRUST unset) forwards no
 *  identity and its co-located daemon runs as the system owner, as before. */
export async function daemonUserHeaders(): Promise<Record<string, string>> {
  const u = await getAuthUser();
  if (!u) {
    if (!trustAuthentikHeaders()) return {}; // no edge: co-located daemon runs as OWNER
    throw new Error("unauthorized: no authenticated user for the daemon hop");
  }
  const secret = process.env.INTERNAL_HMAC_KEY;
  if (!secret) throw new Error("unauthorized: INTERNAL_HMAC_KEY unset (daemon hop unprovable)");
  try {
    await ensureUserRow(u); // JIT before the daemon resolves sub→id
  } catch {
    // DB down: still forward the header. The daemon 401s an unresolvable sub
    // (fail closed) instead of silently writing this user's data as OWNER.
  }
  return {
    "X-Auto-School-User": u.uid,
    "X-Internal-Auth": internalAuthHmac(secret, u.uid),
  };
}
