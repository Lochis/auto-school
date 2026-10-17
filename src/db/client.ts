/** Postgres access — lazy singletons.
 *  Importing this module is side-effect free: the Pool is created on first
 *  use, so scripts can pull in the schema/db without a running server.
 *  The raw Pool lives in ./pg.ts (drizzle-free — the frontend imports that);
 *  this module adds the drizzle instance for daemon/scripts.
 *  Works under Node 24 type-stripping (`node src/…`) and Bun alike; relative
 *  imports carry the .ts extension per repo convention. */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";
import { getPool, closePool } from "./pg.ts";

export { getPool, closePool };

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
  _db = null;
  await closePool();
}
