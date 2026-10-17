/** Raw pg Pool — drizzle-free so the frontend can import it without the
 *  drizzle-orm dependency (it lives only in the root package.json, which is
 *  not installed in the frontend image). Daemon/scripts keep getting the
 *  full client (Pool + drizzle) from ./client.ts, which re-exports these.
 *
 *  Connection resolution order: DATABASE_URL → PG* env vars (PGHOST/PGPORT/
 *  PGUSER/PGPASSWORD/PGDATABASE) → local docker defaults 127.0.0.1:15432,
 *  user/db autoschool (deploy/docker-compose Postgres port).
 *  Importing this module is side-effect free: the Pool is created on first
 *  use. Works under Node 24 type-stripping and Bun alike. */
import { Pool, type PoolConfig } from "pg";

function poolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (url) return { connectionString: url };
  return {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 15432),
    user: process.env.PGUSER ?? "autoschool",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "autoschool",
  };
}

let _pool: Pool | null = null;
export function getPool(): Pool {
  if (!_pool) _pool = new Pool(poolConfig());
  return _pool;
}

/** Drain the pool (scripts call this before exit; safe to call repeatedly). */
export async function closePool(): Promise<void> {
  const pool = _pool;
  _pool = null;
  if (pool) await pool.end();
}
