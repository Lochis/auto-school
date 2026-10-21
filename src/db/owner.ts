/** Per-request owner context (authentik Phase 1, federation plan §8).
 *  Requests enter via `ownerALS.run(owner, ...)` in the daemon's server
 *  callback after `resolveRequestOwner` maps `X-Auto-School-User` → users.id.
 *  Outside a request (startup hydrate, timers, the join loop, retention pass)
 *  `curOwner()` falls back to the seed system user — that request-vs-system
 *  split is the whole mechanism: no owner params are threaded from job code.
 *
 *  Lives in db/ (not daemon.ts) so db/writes.ts, db/state.ts and
 *  pipeline/tools.ts can import curOwner() without pulling the daemon in. */
import { AsyncLocalStorage } from "node:async_hooks";
import { OWNER } from "./writes.ts";

export const ownerALS = new AsyncLocalStorage<string>();

/** The current data owner: the request's users.id, or the system user. */
export function curOwner(): string {
  return ownerALS.getStore() ?? OWNER;
}
