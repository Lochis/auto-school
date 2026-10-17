#!/usr/bin/env node
/** Embedding backfill (plan §4.1 step 9): chunk document text and embed it
 *  into document_chunks via Gemini text-embedding-004 (768 dims).
 *  Usage: node scripts/embed-backfill.ts [--data-dir ./dev-data] [--database-url URL]
 *           [--dry-run] [--limit N] [--kinds material,notes,transcript,timeline]
 *           [--batch-size 80] [--rpm 200]
 *  --dry-run enumerates chunks and prints per-kind totals but embeds nothing
 *  (documents upserts still run — they're the prerequisite for enumeration).
 *  Resumable/idempotent: a document whose indexed_at >= source mtime is
 *  skipped; re-embedding deletes the doc's old chunks first (no dupes).
 *  Session-kind source mtime = session_artifacts.updated_at; materials use
 *  the fs file mtime. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// ── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes("--dry-run");
const DATA_DIR = flag("data-dir") ?? process.env.AUTO_SCHOOL_DATA ?? "./dev-data";
const dbUrl = flag("database-url");
if (dbUrl) process.env.DATABASE_URL = dbUrl; // must precede importing src/db/client.ts
const ALL_KINDS = ["material", "notes", "transcript", "timeline"] as const;
type Kind = (typeof ALL_KINDS)[number];
const KINDS = (flag("kinds") ?? "material,notes,transcript,timeline")
  .split(",").map((k) => k.trim()).filter((k): k is Kind => (ALL_KINDS as readonly string[]).includes(k));
const LIMIT = Number(flag("limit")) > 0 ? Number(flag("limit")) : Infinity;
const BATCH = Math.max(1, Math.min(Number(flag("batch-size")) || 80, 100));
const RPM = Math.max(1, Number(flag("rpm")) || 200);

const OWNER = "00000000-0000-0000-0000-000000000001";
const log = (...m: unknown[]) => console.log(...m);

const { getPool, closeDb } = await import("../src/db/client.ts");
type Pool = Awaited<ReturnType<typeof getPool>>;
let pool: Pool;

const { geminiApiKey, embedTexts, toVectorLiteral, EMBEDDING_MODEL } = await import("../src/db/embeddings.ts");

/** connect with the mandated retry (tunnel may be warming up) — importer pattern */
async function connect(): Promise<Pool> {
  const { getPool: gp, closeDb: cd } = await import("../src/db/client.ts");
  for (let attempt = 1; ; attempt++) {
    const p = gp();
    try { await p.query("select 1"); return p; }
    catch (e: any) {
      await cd().catch(() => {});
      if (attempt >= 3) throw new Error(`DB unreachable after 3 attempts: ${e.message}`);
      log(`DB refused connection (attempt ${attempt}/3), retrying in 10s: ${e.message}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
const q = (sqlText: string, params: unknown[] = []) => pool.query(sqlText, params);

// ── text extraction: SHARED with the daemon path (src/db/ingest-embed.ts) ──
const { pdfPages, docxText, splitLong, materialChunks, EMBEDDABLE } = await import("../src/db/ingest-embed.ts");
type Chunk = { page: number; chunk_index: number; content: string; embedding?: number[] };

/** Notes/transcripts: ~4000-char chunks at paragraph boundaries (page=1). */
const paragraphChunks = (text: string, max = 4000): Chunk[] =>
  splitLong(text, max).map((p, j) => ({ page: 1, chunk_index: j, content: p }));

/** Timelines: one chunk per transcript segment (chunk_index = segment order). */
function timelineChunks(json: string): Chunk[] {
  let segs: unknown;
  try { segs = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(segs)) return [];
  const out: Chunk[] = [];
  segs.forEach((e, i) => {
    const t = typeof (e as any)?.transcript === "string" ? (e as any).transcript.trim() : "";
    if (t) out.push({ page: 1, chunk_index: i, content: t });
  });
  return out;
}

// ── work list ──────────────────────────────────────────────────────────────
interface DocRow {
  id: string; kind: Kind; rel_path: string; filename: string; indexed_at: string | null;
  slug: string; artifact_mtime: string | null; content: string | null;
}
interface WorkItem { doc: DocRow; chunks: Chunk[]; remaining: number; written?: boolean }

async function main() {
  pool = await connect();
  log(`embed backfill ${DRY ? "(DRY RUN — nothing embedded) " : ""}data=${DATA_DIR} kinds=${KINDS.join(",")} batch=${BATCH} rpm=${RPM} model=${EMBEDDING_MODEL}`);

  // step a: ensure documents rows for session text artifacts (importer natural
  // key (course_id, kind, rel_path)); artifacts kind maps 1:1 to documents kind
  const sessionKinds = KINDS.filter((k) => k !== "material");
  if (sessionKinds.length) {
    const r = await q(`insert into documents (course_id, kind, session_id, rel_path, filename, owner_user_id, updated_at)
      select s.course_id, a.kind, s.id, a.rel_path, regexp_replace(a.rel_path, '^.*/', ''), $1, now()
      from session_artifacts a join sessions s on s.id = a.session_id
      where a.kind = any($2) and a.content is not null
      on conflict (course_id, kind, rel_path) do update set session_id = excluded.session_id, updated_at = now()`,
      [OWNER, sessionKinds]);
    log(`documents upsert: ${r.rowCount} session-kind row(s) ensured`);
  }

  const { rows } = await q(`select d.id, d.kind, d.rel_path, d.filename, d.indexed_at, c.slug,
      a.updated_at as artifact_mtime, a.content
    from documents d
    join courses c on c.id = d.course_id
    left join session_artifacts a on a.session_id = d.session_id and a.kind = d.kind and a.rel_path = d.rel_path
    where d.kind = any($1) and c.slug <> 'attic'
      and d.rel_path not like '%.index/%' and d.rel_path not like '%/attic/%' and d.rel_path not like 'attic/%'
    order by d.kind, c.slug, d.rel_path`, [KINDS]);

  const work: WorkItem[] = [];
  const totals: Record<string, number> = {};
  const bump = (k: string, n = 1) => { totals[k] = (totals[k] ?? 0) + n; };
  const byKind = new Map<Kind, { docs: number; chunks: number }>();
  for (const k of KINDS) byKind.set(k, { docs: 0, chunks: 0 });
  const emptyDocs: string[] = [];

  for (const r of rows as DocRow[]) {
    if (work.length >= LIMIT) break;
    const indexed = r.indexed_at ? Date.parse(r.indexed_at) : 0;
    let mtimeMs: number;
    if (r.kind === "material") {
      const abs = join(DATA_DIR, "courses", r.slug, "materials", r.rel_path);
      let st; try { st = statSync(abs); } catch { bump("skipped_missing_file"); continue; }
      mtimeMs = st.mtimeMs;
      if (!EMBEDDABLE.has(extname(r.filename).toLowerCase())) { bump("skipped_unsupported_ext"); continue; }
    } else {
      if (r.content == null) { bump("skipped_no_content"); continue; }
      mtimeMs = r.artifact_mtime ? Date.parse(r.artifact_mtime) : 0;
    }
    if (indexed >= mtimeMs) { bump("skipped_fresh"); continue; }
    let chunks: Chunk[];
    try {
      chunks = r.kind === "material"
        ? await materialChunks(join(DATA_DIR, "courses", r.slug, "materials", r.rel_path), r.filename)
        : r.kind === "timeline" ? timelineChunks(r.content!) : paragraphChunks(r.content!);
    } catch (e) {
      log(`  warn: extraction failed for ${r.slug}/${r.rel_path}: ${String(e).slice(0, 120)} — skipped (retried on next run)`);
      bump("skipped_extract_error");
      continue;
    }
    bump(`docs:${r.kind}`);
    byKind.get(r.kind)!.docs++; byKind.get(r.kind)!.chunks += chunks.length;
    if (!chunks.length) emptyDocs.push(`${r.kind} ${r.slug}/${r.rel_path}`);
    work.push({ doc: r, chunks, remaining: chunks.length });
  }

  // per-kind enumeration report (exact — text was really extracted)
  log("\n─ ENUMERATION ─────────────────────────────────────");
  for (const k of ALL_KINDS) {
    if (!byKind.has(k)) continue;
    const t = byKind.get(k)!;
    log(`${k.padEnd(11)} docs needing embed: ${String(t.docs).padStart(4)}   chunks: ${String(t.chunks).padStart(6)}`);
  }
  log(`skipped: ${Object.entries(totals).filter(([k]) => k.startsWith("skipped")).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
  if (emptyDocs.length) log(`docs with no extractable text (${emptyDocs.length}): ${emptyDocs.slice(0, 5).join("; ")}${emptyDocs.length > 5 ? " …" : ""}`);

  if (DRY) { log("dry run — no embeddings requested, no chunks written."); await closeDb(); return; }

  // ── embed + write ───────────────────────────────────────────────────────
  const apiKey = geminiApiKey(DATA_DIR);
  if (!apiKey) {
    log("ABORT: no Gemini API key — set GEMINI_API_KEY or geminiApiKey in <data-dir>/settings.json");
    await closeDb(); process.exit(1);
  }
  const refs = work.flatMap((w) => w.chunks.map((c) => ({ w, c })));
  const nonzero = work.filter((w) => w.chunks.length);
  log(`\nembedding ${refs.length} chunk(s) from ${nonzero.length} doc(s) (batches of ${BATCH}, ${RPM} rpm)…`);

  const flush = async (w: WorkItem) => {
    if (w.written || w.remaining > 0) return;
    w.written = true;
    const d = w.doc;
    await q(`delete from document_chunks where document_id = $1`, [d.id]);
    if (w.chunks.length) {
      const params: unknown[] = [];
      const tuples = w.chunks.map((c) => {
        params.push(d.id, c.page, c.chunk_index, c.content, Math.ceil(c.content.length / 4), toVectorLiteral(c.embedding!));
        const b = params.length - 6; // first param index of this tuple
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::vector,'${EMBEDDING_MODEL}')`;
      });
      await q(`insert into document_chunks (document_id, page, chunk_index, content, token_count, embedding, embedding_model)
        values ${tuples.join(",")}`, params);
    }
    await q(`update documents set indexed_at = now(), page_count = $2 where id = $1`,
      [d.id, d.kind === "material" ? Math.max(...w.chunks.map((c) => c.page), 0) : null]);
    bump("chunks_written", w.chunks.length);
  };

  // zero-chunk docs: stamp immediately so re-runs skip them
  for (const w of work.filter((x) => !x.chunks.length)) await flush(w);

  let embedCalls = 0;
  try {
    for (let i = 0; i < refs.length; i += BATCH) {
      const batch = refs.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch.map((r) => r.c.content), {
        apiKey, rpm: RPM,
        onRetry: (a, waitMs, why) => log(`  retry ${a}: ${why} — waiting ${waitMs}ms`),
      });
      embedCalls++;
      const touched = new Set<WorkItem>();
      batch.forEach((r, j) => { r.c.embedding = embeddings[j]!; if (--r.w.remaining === 0) touched.add(r.w); });
      for (const w of touched) {
        await flush(w);
        log(`  [${w.doc.kind}] ${w.doc.slug}/${w.doc.filename} → ${w.chunks.length} chunk(s) ✓`);
      }
      if ((i / BATCH) % 10 === 0 && i > 0) log(`  … ${Math.min(i + BATCH, refs.length)}/${refs.length} chunks (${embedCalls} embed calls)`);
    }
  } catch (e) {
    log(`\nABORT: ${String(e).slice(0, 300)}`);
    log(`resume: re-run the same command — ${totals["chunks_written"] ?? 0} chunk(s) already written are kept; ` +
      `docs with fresh indexed_at are skipped automatically.`);
    await closeDb(); process.exit(1);
  }

  log("\n─ DONE ─────────────────────────────────────────────");
  for (const k of ALL_KINDS) {
    if (!byKind.has(k)) continue;
    const t = byKind.get(k)!;
    log(`${k.padEnd(11)} docs: ${String(t.docs).padStart(4)}   chunks: ${String(t.chunks).padStart(6)}`);
  }
  log(`total chunks written: ${totals["chunks_written"] ?? 0}   embed calls: ${embedCalls}   docs stamped: ${work.length}`);
  await closeDb();
}

main().catch(async (e) => { console.error("BACKFILL FAILED:", e); await closeDb().catch(() => {}); process.exit(1); });
