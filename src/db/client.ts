/** Postgres access — lazy singletons.
 *  Importing this module is side-effect free: the Pool is created on first
 *  use, so scripts can pull in the schema/db without a running server.
 *  Connection resolution order: DATABASE_URL → PG* env vars (PGHOST/PGPORT/
 *  PGUSER/PGPASSWORD/PGDATABASE) → local docker defaults 127.0.0.1:15432,
 *  user/db autoschool (deploy/docker-compose Postgres port).
 *
 *  Works under Node 24 type-stripping (`node src/…`) and Bun alike; relative
 *  imports carry the .ts extension per repo convention. */
import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

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

let _db: NodePgDatabase<typeof schema> | null = null;
export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

/** Lazy proxy — `import { db } from "./client.ts"` reads naturally but defers
 *  Pool construction (and any connection error) to the first actual use. */
export const db: NodePgDatabase<typeof schema> = new Proxy(
  {} as NodePgDatabase<typeof schema>,
  {
    get(_target, prop) {
      const target = getDb() as unknown as object;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

/** Drain the pool (scripts call this before exit; safe to call repeatedly). */
export async function closeDb(): Promise<void> {
  const pool = _pool;
  _pool = null;
  _db = null;
  if (pool) await pool.end();
}
