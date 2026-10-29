#!/usr/bin/env node
/** CLI over document_chunks: pgvector semantic search (default) or pg_trgm
 *  keyword mode for comparison.
 *  Usage: node scripts/semantic-search.ts "query" [--course slug] [--k 8]
 *           [--kind material|notes|transcript|timeline] [--keyword]
 *                [--data-dir ./dev-data] [--database-url URL] */
const USAGE = `usage: node scripts/semantic-search.ts "query" [options]
  --course slug    restrict to one course
  --k N            max results (default 8)
  --kind kind      material | notes | transcript | timeline
  --keyword        keyword mode (pg_trgm similarity + ilike) instead of semantic
  --data-dir DIR   default ./dev-data or $AUTO_SCHOOL_DATA (for settings.json)
  --database-url U default $DATABASE_URL`;

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const QUERY = args[0] && !args[0].startsWith("--") ? args[0].trim() : undefined;
if (!QUERY) { console.log(USAGE); process.exit(0); }

const KINDS = ["material", "notes", "transcript", "timeline"];
const kind = flag("kind");
if (kind && !KINDS.includes(kind)) { console.error(`invalid --kind '${kind}' (valid: ${KINDS.join(", ")})`); process.exit(1); }

const dbUrl = flag("database-url");
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const { vectorSearch, keywordSearch, chunkCount, closeReader } = await import("../src/db/reader.ts");
// owner-scoped search is mandatory now; default = system owner (single tenant),
// pass --owner <users.id> to search another tenant's corpus.
const { curOwner } = await import("../src/db/owner.ts");
const owner = flag("owner") ?? curOwner();

try {
  const n = await chunkCount();
  if (n === 0) {
    console.log("no chunks in document_chunks — run scripts/embed-backfill.ts first");
    await closeReader(); process.exit(0);
  }

  let hits;
  if (args.includes("--keyword")) {
    hits = await keywordSearch({ owner, query: QUERY, course: flag("course"), kind, k: Number(flag("k")) || 8 });
  } else {
    const { geminiApiKey, embedQuery } = await import("../src/db/embeddings.ts");
    const apiKey = geminiApiKey(flag("data-dir") ?? process.env.AUTO_SCHOOL_DATA ?? "./dev-data");
    if (!apiKey) { console.error("no Gemini API key — set GEMINI_API_KEY or geminiApiKey in <data-dir>/settings.json"); process.exit(1); }
    const embedding = await embedQuery(QUERY, { apiKey });
    hits = await vectorSearch({ owner, embedding, course: flag("course"), kind, k: Number(flag("k")) || 8 });
  }

  if (!hits.length) {
    console.log(`no matches for "${QUERY}"`);
    await closeReader(); process.exit(0);
  }
  const mode = args.includes("--keyword") ? "keyword" : "semantic";
  console.log(`${mode} results for "${QUERY}" (${hits.length} of ${n} chunks):\n`);
  hits.forEach((h, i) => {
    const where = h.stem ? `${h.slug} · session ${h.stem}` : `${h.slug} · ${h.rel_path}`;
    console.log(`${String(i + 1).padStart(2)}. [${h.score.toFixed(3)}] ${h.kind}  ${where}  p${h.page}#${h.chunk_index}`);
    console.log(`    ${h.preview.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  });
  await closeReader();
} catch (e) {
  console.error(`search failed: ${String(e).slice(0, 200)}`);
  await closeReader().catch(() => {});
  process.exit(1);
}
