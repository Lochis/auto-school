/** Gemini text-embedding-004 client shared by scripts/embed-backfill.ts,
 *  scripts/semantic-search.ts and the daemon's vector-search tools.
 *  Key resolution mirrors src/status.ts apiKey(): `geminiApiKey` from
 *  <dataDir>/settings.json first, GEMINI_API_KEY env fallback (scripts pass
 *  an explicit dataDir since --data-dir may differ from the daemon's).
 *  No module-level side effects — safe to import anywhere. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Default gemini-embedding-001 (768-dim): the deployed key exposes ONLY this model —
// text-embedding-004 404s on it (verified 2026-10-17). Both are 768-dim; override with
// GEMINI_EMBED_MODEL if the key changes. Per-chunk embedding_model keeps generations separate.
export const EMBEDDING_MODEL = process.env.GEMINI_EMBED_MODEL?.trim() || "gemini-embedding-001";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_PER_REQUEST = 100; // batchEmbedContents hard cap
const DIMS = 768; // document_chunks.embedding is pinned vector(768)
/** gemini-embedding-* models emit 3072 dims natively — request 768 to match
 *  the pinned column (text-embedding-004 is 768 natively, no param needed). */
const dimsParam = () => EMBEDDING_MODEL.startsWith("gemini-embedding") ? { outputDimensionality: DIMS } : {};
export const EMBEDDING_DIMS = DIMS;

/** settings.json geminiApiKey → GEMINI_API_KEY env (status.ts apiKey() precedence). */
export function geminiApiKey(dataDir?: string): string | undefined {
  const dir = dataDir ?? process.env.AUTO_SCHOOL_DATA ?? ".";
  try {
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { geminiApiKey?: string };
    const stored = s.geminiApiKey?.trim();
    if (stored) return stored;
  } catch { /* no/invalid settings.json */ }
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

/** pgvector string literal '[1.23,4.56e-7,…]' — rounded to 6 dp to keep rows small. */
export const toVectorLiteral = (v: readonly number[]): string => {
  if (!Array.isArray(v) || v.length === 0) throw new Error("toVectorLiteral: embedding is empty/undefined — embed step failed or returned nothing");
  return "[" + v.map((x) => String(+x.toFixed(6))).join(",") + "]";
};

export interface EmbedOpts {
  apiKey: string;
  /** requests/min throttle (default 200); shared per process */
  rpm?: number;
  onRetry?: (attempt: number, waitMs: number, why: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0; // rpm throttle watermark (module-level: one clock per process)

const MAX_TRIES = 6;

/** POST with rpm throttle + exponential backoff on 429/5xx/network errors. */
async function embedFetch(path: string, body: unknown, opts: EmbedOpts): Promise<unknown> {
  let lastWhy = "";
  for (let attempt = 1; ; attempt++) {
    const gap = 60_000 / Math.max(1, opts.rpm ?? 200);
    const throttle = lastRequestAt + gap - Date.now();
    if (throttle > 0) await sleep(throttle);
    let res: Response;
    try {
      res = await fetch(`${BASE}/${path}?key=${encodeURIComponent(opts.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastWhy = `network: ${String(e).slice(0, 120)}`;
      res = null as unknown as Response;
    }
    if (res) {
      lastRequestAt = Date.now();
      if (res.ok) return (await res.json()) as unknown;
      lastWhy = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        if (res.status === 404 && EMBEDDING_MODEL === "text-embedding-004") {
          lastWhy += " — this key may only expose the gemini-embedding-* family; set GEMINI_EMBED_MODEL=gemini-embedding-001 (same 768 dims)";
        }
        break; // 400/403/404 … — retrying won't help
      }
    }
    if (attempt >= MAX_TRIES) {
      throw new Error(`embedding request failed after ${attempt} attempts (${lastWhy}). ` +
        `Progress is resumable: documents already stamped indexed_at are skipped — re-run the same command.`);
    }
    const waitMs = Math.min(2 ** (attempt - 1) * 1_000, 30_000);
    opts.onRetry?.(attempt, waitMs, lastWhy);
    await sleep(waitMs);
  }
  throw new Error(`embedding request rejected (${lastWhy})`);
}

/** Embed many texts via batchEmbedContents (≤100 per request, spec-capped
 *  again here by MAX_PER_REQUEST). Returns embeddings in input order. */
export async function embedTexts(texts: string[], opts: EmbedOpts): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_PER_REQUEST) {
    const slice = texts.slice(i, i + MAX_PER_REQUEST);
    const j = (await embedFetch(`${EMBEDDING_MODEL}:batchEmbedContents`, {
      requests: slice.map((text) => ({ model: `models/${EMBEDDING_MODEL}`, ...dimsParam(), content: { parts: [{ text }] } })),
    }, opts)) as { embeddings?: { values?: number[] }[] };
    const vals = j.embeddings ?? [];
    if (vals.length !== slice.length || vals.some((v) => !Array.isArray(v.values))) {
      throw new Error(`batchEmbedContents returned ${vals.length}/${slice.length} embeddings`);
    }
    if (vals.some((v) => v.values!.length !== DIMS)) {
      throw new Error(`embedding dimension mismatch — expected ${DIMS}, got ${vals[0]!.values!.length} (model ${EMBEDDING_MODEL})`);
    }
    out.push(...vals.map((v) => v.values as number[]));
  }
  return out;
}

/** Embed a single text (queries) via embedContent. */
export async function embedQuery(text: string, opts: EmbedOpts): Promise<number[]> {
  const j = (await embedFetch(`${EMBEDDING_MODEL}:embedContent`, {
    model: `models/${EMBEDDING_MODEL}`, ...dimsParam(),
    content: { parts: [{ text }] },
  }, opts)) as { embedding?: { values?: number[] } };
  const values = j.embedding?.values;
  if (!Array.isArray(values) || !values.length) throw new Error("embedContent returned no values");
  if (values.length !== DIMS) throw new Error(`embedding dimension mismatch — expected ${DIMS}, got ${values.length} (model ${EMBEDDING_MODEL})`);
  return values;
}
