/** Recorder heartbeat poster (recorder-split.md §3 step 1) — the daemon
 *  registers itself in the platform's recorder registry so per-owner proxy
 *  resolution can find it once the pod split lands. Small and self-contained
 *  on purpose: imported once from daemon() boot, no coupling to the join loop.
 *
 *  Env:
 *   PLATFORM_URL       (default http://localhost:3000 — same pod, transitional)
 *   RECORDER_TOKEN     bearer token for /api/recorder/heartbeat
 *   RECORDER_OWNER_UID optional override; else the seed owner's authentik_sub
 *   RECORDER_ENDPOINT  default http://localhost:7800 (the controller base)
 */
import { getPool } from "./db/pg.ts";
import { OWNER } from "./db/writes.ts";

const PLATFORM_URL = () => process.env.PLATFORM_URL ?? "http://localhost:3000";
const INTERVAL_MS = 30_000;

/** The owner uid this recorder acts as. Resolved once (cached): the
 *  RECORDER_OWNER_UID override wins, else the seed owner's authentik_sub is
 *  read from the users table. Null while unclaimed (seed sub still NULL) —
 *  heartbeat is skipped until a login claims it. */
let cachedOwnerSub: string | null | undefined; // undefined = not yet resolved
async function resolveOwnerSub(): Promise<string | null> {
  const override = process.env.RECORDER_OWNER_UID;
  if (override) return override;
  if (cachedOwnerSub !== undefined) return cachedOwnerSub;
  try {
    const r = await getPool().query(
      `select authentik_sub from users where id = $1`,
      [OWNER],
    );
    const sub = (r.rows[0]?.authentik_sub as string | null) ?? null;
    if (sub) cachedOwnerSub = sub; // cache the success; retry on null
    return sub;
  } catch {
    return null; // DB down — retry next tick, do not cache the failure
  }
}

/** Log at most once per outage streak: first failure logs, success clears. */
let outaged = false;

async function beat(): Promise<void> {
  const owner = await resolveOwnerSub();
  if (!owner) return; // seed identity unclaimed — nothing to register yet
  const url = `${PLATFORM_URL()}/api/recorder/heartbeat`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RECORDER_TOKEN
          ? { Authorization: `Bearer ${process.env.RECORDER_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        owner,
        name: "personal",
        mode: "inbound",
        endpoint: process.env.RECORDER_ENDPOINT ?? "http://localhost:7800",
        capabilities: { liveStatus: true, joinControl: true, mediaServe: true },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) outaged = false;
    else if (!outaged) { console.warn(`[heartbeat] platform responded ${res.status}`); outaged = true; }
  } catch {
    if (!outaged) { console.warn(`[heartbeat] ${url} unreachable`); outaged = true; }
  }
}

/** Boot hook: immediate first beat, then every 30s. Never throws, unref'd so
 *  it never keeps the process alive. */
export function startRecorderHeartbeat(): void {
  void beat();
  setInterval(() => void beat(), INTERVAL_MS).unref();
}
