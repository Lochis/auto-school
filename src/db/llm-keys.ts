/** LLM API-key resolution for the platform process (5b-2 c, D1 in
 *  docs/planning/platform-ai-generation.md).
 *
 *  Order: `process.env[name]` → `app_settings` SYSTEM row → null.
 *  NEVER the filesystem: the platform pod has no /data mount (settings.json
 *  does not exist there), and hosted user keys stay keychain-side on the
 *  recorder — the daemon keeps its own fs-first resolution
 *  (src/status.ts apiKey() and src/db/embeddings.ts geminiApiKey()), which this
 *  module deliberately does NOT touch or subsume.
 *
 *  Bundleable by construction: node builtins + `pg` (via ./pg.ts) only, no
 *  drizzle, no src/status.ts. Safe to import from a Next route.
 *
 *  Row shapes understood (both have been used for this table):
 *    key = 'GEMINI_API_KEY'  value = "AIza…"        (per-key row)
 *    key = 'settings'        value = {"geminiApiKey":"AIza…", …}  (settings.json blob)
 *  A per-key row wins over the blob field. */

import { getPool } from "./pg.ts";
import { OWNER } from "./writes.ts";

export type LlmKeyName = "GEMINI_API_KEY" | "GLM_API_KEY";

/** settings.json field name for each provider key (the app_settings 'settings'
 *  blob mirrors that file's shape — see src/status.ts Settings). */
const SETTINGS_FIELD: Record<LlmKeyName, string> = {
  GEMINI_API_KEY: "geminiApiKey",
  GLM_API_KEY: "glmApiKey",
};

const pick = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; key?: unknown };
    if (typeof o.value === "string") return o.value.trim();
    if (typeof o.key === "string") return o.key.trim();
  }
  return "";
};

/** The key to call a provider with, or null when neither env nor the DB has
 *  one (callers fail closed — no key means the generation route rejects). */
export async function resolveApiKey(name: LlmKeyName): Promise<string | null> {
  const env = process.env[name]?.trim();
  if (env) return env;
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return null; // no PG → env-only
  try {
    const r = await getPool().query(
      `select key, value from app_settings
       where owner_user_id = $1 and key = any($2::text[])`,
      [OWNER, [name, "settings"]],
    );
    const direct = pick(r.rows.find((x) => x.key === name)?.value);
    if (direct) return direct;
    const blob = r.rows.find((x) => x.key === "settings")?.value as Record<string, unknown> | undefined;
    const field = pick(blob?.[SETTINGS_FIELD[name]]);
    return field || null;
  } catch {
    return null; // DB down/unmigrated → treated as "no key" (fail closed)
  }
}
