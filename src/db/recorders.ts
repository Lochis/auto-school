/** Recorder registry (recorder-split.md §3) — drizzle-free Pool, matching
 *  src/db/avatar.ts style so the frontend image can import it without the
 *  drizzle-orm dependency. Rows are keyed (owner_user_id, name): the personal
 *  pod heartbeats once per 30s as `personal` (inbound mode), and the platform
 *  resolves a fresh row to learn where to proxy daemon traffic. */
import { getPool } from "./pg.ts";

export interface RecorderHeartbeat {
  ownerUserId: string;
  name: string;
  mode: "inbound" | "poll";
  endpoint: string | null;
  capabilities: Record<string, unknown>;
}

export interface ActiveRecorder {
  name: string;
  mode: string;
  endpoint: string | null;
  lastSeen: Date;
  capabilities: Record<string, unknown>;
}

/** Upsert a heartbeat on (owner_user_id, name) and bump last_seen. */
export async function upsertRecorderHeartbeat(p: RecorderHeartbeat): Promise<void> {
  await getPool().query(
    `insert into recorders (owner_user_id, name, mode, endpoint, last_seen, capabilities)
     values ($1, $2, $3, $4, now(), $5::jsonb)
     on conflict (owner_user_id, name)
     do update set mode = excluded.mode, endpoint = excluded.endpoint,
                   last_seen = now(), capabilities = excluded.capabilities`,
    [p.ownerUserId, p.name, p.mode, p.endpoint, JSON.stringify(p.capabilities)],
  );
}

/** Latest fresh INBOUND row for an owner (null when absent/stale/other mode).
 *  mode='inbound' filter is belt-and-braces: poll recorders are never
 *  proxy targets (their endpoints are unreachable by design — NAT), so a
 *  fresh poll row must read as daemon-less, not as a 502-storm base
 *  (review 2026-10-21). */
export async function getActiveRecorder(
  ownerUserId: string,
  maxAgeMs = 60_000,
): Promise<ActiveRecorder | null> {
  const r = await getPool().query(
    `select name, mode, endpoint, last_seen, capabilities
     from recorders
     where owner_user_id = $1 and mode = 'inbound'
       and last_seen > now() - ($2 || ' milliseconds')::interval
     order by last_seen desc
     limit 1`,
    [ownerUserId, String(maxAgeMs)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    name: row.name as string,
    mode: row.mode as string,
    endpoint: (row.endpoint as string | null) ?? null,
    lastSeen: row.last_seen as Date,
    capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
  };
}
