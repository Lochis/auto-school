/** Per-request owner resolution (Authentik Phase 1) — the single uid→id seam
 *  shared by the direct-PG read paths and the daemon-proxy hop.
 *
 *  Two directions, one resolution chain:
 *  - PG reads (surface a): the query layer takes `owner?: string`
 *    (users.id). `ownerId()` resolves getAuthUser() → ensureUserRow() → id;
 *    undefined means "no authenticated user" and the SQL omits its owner
 *    filter — i.e. the pre-Phase-1 system-owner view (OWNER, src/db/writes.ts)
 *    stays the degradation path (dev / TRUST unset / unauth), never a 401.
 *  - Daemon hop (surface b): `daemonUserHeaders()` forwards the *authentik uid*
 *    (sub) as X-Auto-School-User; the daemon owns sub→id resolution
 *    (src/db/avatar.ts getUserIdBySub). ensureUserRow() JIT-provisions the row
 *    first so a first-ever login resolves on the daemon instead of falling
 *    back to the seed OWNER.
 *
 *  Never throws: DB-down degrades to undefined (unfiltered) / still-forwarded
 *  header (daemon 401s an unresolvable sub rather than miswriting as OWNER). */
import { getAuthUser } from "./auth";
import { ensureUserRow } from "./avatar";

/** users.id for the authenticated user, or undefined when there is none.
 *  undefined is the "system owner / unfiltered" path — the query layer's
 *  `owner?: string` omits its predicate on undefined (legacy parity). */
export async function ownerId(): Promise<string | undefined> {
  const u = await getAuthUser();
  if (!u) return undefined;
  try {
    return (await ensureUserRow(u)) ?? undefined;
  } catch {
    return undefined; // DB down → degrade to unfiltered (system view)
  }
}

/** Headers for a daemon hop: X-Auto-School-User = authentik uid (sub), or {}
 *  when unauthenticated (daemon then runs as the system OWNER — dev parity). */
export async function daemonUserHeaders(): Promise<Record<string, string>> {
  const u = await getAuthUser();
  if (!u) return {};
  try {
    await ensureUserRow(u); // JIT before the daemon resolves sub→id
  } catch {
    // DB down: still forward the header. The daemon 401s an unresolvable sub
    // (fail closed) instead of silently writing this user's data as OWNER.
  }
  return { "X-Auto-School-User": u.uid };
}
