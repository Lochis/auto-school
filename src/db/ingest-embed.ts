/** Incremental material embedding — the daemon's "embeddings are the standard"
 * path (2026-10-17). Both the upload route and the 6h maintenance sweep call
 * `embedPendingMaterials()`; it is a cheap no-op when everything is fresh
 * (documents.indexed_at watermark vs fs mtime), never throws into the caller,
 * and silently degrades to a no-op when PG or the Gemini key is absent.
 *
 * Shared extraction helpers live here; scripts/embed-backfill.ts imports them
 * so script and daemon can never drift apart. */
import { execFile } from "node:child_process";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { getPool, closeDb } from "./client.ts";
import { embedTexts, geminiApiKey, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings.ts";
import { pgConfigured } from "./reader.ts";

/** lochis bootstrap owner (see ddl.sql seed) */
const OWNER = "00000000-0000-0000-0000-000000000001";

const run = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((res) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) =>
      res({ code: e ? 1 : 0, out: String(out ?? ""), err: String(err ?? "") })));

/** PDF → page texts. docindex indexPdf() does one pdftotext pass and splits
 *  on form-feeds — mirror that (source of truth: docindex.ts:44). */
export async function pdfPages(src: string): Promise<string[]> {
  const t = await run("pdftotext", ["-enc", "UTF-8", src, "-"]);
  if (t.code !== 0) throw new Error(`pdftotext exited ${t.code}: ${t.err.trim().slice(0, 120)}`);
  return t.out.split("\f");
}

/** DOCX → text (mammoth html→text, same as docindex's text-only fallback). */
export async function docxText(src: string): Promise<string> {
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml({ path: src });
  return html.replace(/<[^>]+>/g, " ");
}

export interface Chunk { page: number; chunk_index: number; content: string }

/** split ~at boundaries so chunks stay semantically whole */
export function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Materials: one page = one chunk; oversized pages split at ~6000 chars. */
export async function materialChunks(abs: string, filename: string): Promise<Chunk[]> {
  const ext = extname(filename).toLowerCase();
  let pages: string[] = [];
  if (ext === ".pdf") pages = await pdfPages(abs);
  else if (ext === ".docx") pages = [await docxText(abs)];
  else pages = [readFileSync(abs, "utf8")]; // txt/md/csv/json
  const chunks: Chunk[] = [];
  pages.forEach((raw, i) => {
    const txt = raw.trim();
    if (!txt) return; // scanned/empty page — no chunk
    const pieces = txt.length > 6000 ? splitLong(txt, 6000) : [txt];
    pieces.forEach((p, j) => chunks.push({ page: i + 1, chunk_index: j, content: p }));
  });
  return chunks;
}

/** extension whitelist — everything else is skipped as unembeddable */
export const EMBEDDABLE = new Set([".pdf", ".docx", ".txt", ".md", ".csv", ".json"]);

export interface EmbedSweepResult {
  ok: boolean;
  reason?: "pg-not-configured" | "no-key" | string;
  docs: number;
  chunks: number;
}

/** Sync documents rows for materials (fs walk × manifest overlay), then chunk +
 *  embed everything stale. Materials only — session kinds stay with the
 *  backfill script by design (they change continuously during class). */
export async function embedPendingMaterials(opts: {
  dataDir?: string; batch?: number; rpm?: number; log?: (m: string) => void;
} = {}): Promise<EmbedSweepResult> {
  const DATA = opts.dataDir ?? process.env.AUTO_SCHOOL_DATA ?? ".";
  const log = opts.log ?? (() => { });
  if (!pgConfigured()) return { ok: false, reason: "pg-not-configured", docs: 0, chunks: 0 };
  const key = geminiApiKey(DATA);
  if (!key) return { ok: false, reason: "no-key", docs: 0, chunks: 0 };

  const pool = getPool();
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  try {
    // ── 1. sync documents rows: walk fs, overlay manifest fields ──────────
    const courses = readdirSync(join(DATA, "courses"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    let ensured = 0;
    for (const slug of courses) {
      const mRoot = join(DATA, "courses", slug, "materials");
      let manifest: Record<string, Record<string, unknown>> = {};
      try {
        manifest = Object.fromEntries((JSON.parse(readFileSync(join(mRoot, "materials.json"), "utf8")) as { path: string }[])
          .map((e) => [e.path, e as unknown as Record<string, unknown>]));
      } catch { /* no manifest — bare tree still syncs */ }
      const walk = (d: string, rel = ""): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) return e.name.startsWith(".") || e.name === "attic" ? [] : walk(join(d, e.name), r);
          if (e.name === "materials.json" || e.name.startsWith(".")) return []; // manifest ≠ material
          return EMBEDDABLE.has(extname(e.name).toLowerCase()) ? [r] : [];
        });
      let files: string[] = [];
      try { files = walk(mRoot); } catch { continue; }
      if (!files.length) continue;
      await q(`insert into courses (slug, name, owner_user_id) values ($1,$2,$3)
        on conflict (slug) do nothing`, [slug, slug.replace(/_/g, " "), OWNER]);
      const cid = (await q(`select id from courses where slug=$1`, [slug])).rows[0]?.id as number | undefined;
      if (!cid) continue;
      for (const rel of files) {
        const m = manifest[rel] ?? {};
        let size: number | null = null, mtime = new Date();
        try { const st = statSync(join(mRoot, rel)); size = st.size; mtime = st.mtime; } catch { continue; }
        await q(`insert into documents (course_id, kind, rel_path, filename, week, category, description, size_bytes, uploaded_at, owner_user_id, updated_at)
          values ($1,'material',$2,$3,$4,$5,$6,$7,$8,$9,$10)
          on conflict (course_id, kind, rel_path) do update set
            filename=excluded.filename, week=excluded.week, category=excluded.category,
            description=excluded.description, size_bytes=excluded.size_bytes`,
          [cid, rel, (m.filename as string) ?? rel.split("/").pop()!, (m.week as number) ?? null,
            (m.category as string) ?? "other", (m.description as string) ?? "", size,
            m.uploadedAt ? new Date(String(m.uploadedAt)) : null, OWNER, mtime]);
        ensured++;
      }
    }

    // ── 2. pending = indexed_at null or older than file mtime ─────────────
    const { rows } = await q(`select d.id, d.rel_path, d.filename, d.indexed_at, c.slug
      from documents d join courses c on c.id=d.course_id
      where d.kind='material' and c.slug <> 'attic' and d.rel_path not like '%.index/%'
      order by c.slug, d.rel_path`);
    const work: { id: string; slug: string; filename: string; rel_path: string; chunks: Chunk[]; remaining: number }[] = [];
    for (const r of rows) {
      // videos/images/code are real materials (list_materials must show them) but
      // are NEVER chunked/embedded — readFileSync-utf8 on binary produced 1663
      // garbage chunks in the 2026-10-17 incident. Enforce the whitelist here.
      if (!EMBEDDABLE.has(extname(String(r.filename)).toLowerCase())) continue;
      // dot-paths / hidden files / node_modules trees are never real materials
      if (String(r.rel_path).split("/").some((s) => s.startsWith("."))) continue;
      const abs = join(DATA, "courses", String(r.slug), "materials", String(r.rel_path));
      let st; try { st = statSync(abs); } catch { continue; }
      const indexed = r.indexed_at ? Date.parse(String(r.indexed_at)) : 0;
      if (indexed >= st.mtimeMs) continue;
      let chunks: Chunk[];
      try { chunks = await materialChunks(abs, String(r.filename)); }
      catch (e) { log(`embed: extract failed ${r.slug}/${r.rel_path}: ${String(e).slice(0, 80)}`); continue; }
      work.push({ id: String(r.id), slug: String(r.slug), filename: String(r.filename), rel_path: String(r.rel_path), chunks, remaining: chunks.length });
      if (work.length >= 200) break; // sweep guard: uploads trigger fresh passes anyway
    }
    if (!work.length) return { ok: true, reason: "fresh", docs: 0, chunks: 0 };

    // ── 3. embed + write (remaining-count flush: a doc is only written once,
    //      after ALL its chunks carry embeddings — mirrors the backfill) ────
    const BATCH = opts.batch ?? 25;
    const flush = async (w: typeof work[number]) => {
      await q(`delete from document_chunks where document_id=$1`, [w.id]);
      if (w.chunks.length) {
        const params: unknown[] = [];
        const tuples = w.chunks.map((c) => {
          params.push(w.id, c.page, c.chunk_index, c.content, Math.ceil(c.content.length / 4), toVectorLiteral((c as { embedding?: number[] }).embedding!));
          const b = params.length - 6;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::vector,'${EMBEDDING_MODEL}')`;
        });
        await q(`insert into document_chunks (document_id, page, chunk_index, content, token_count, embedding, embedding_model)
          values ${tuples.join(",")}`, params);
      }
      await q(`update documents set indexed_at=now(), page_count=$2 where id=$1`,
        [w.id, Math.max(...w.chunks.map((c) => c.page), 0)]);
    };
    // zero-chunk docs: stamp immediately so re-runs skip them
    for (const w of work.filter((x) => !x.chunks.length)) await flush(w);
    const refs = work.flatMap((w) => w.chunks.map((c) => ({ w, c })));
    let written = 0;
    for (let i = 0; i < refs.length; i += BATCH) {
      const batch = refs.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch.map((r) => r.c.content), { apiKey: key, rpm: opts.rpm ?? 60 });
      const done = new Set<typeof work[number]>();
      batch.forEach((r, j) => { (r.c as { embedding?: number[] }).embedding = embeddings[j]!; if (--r.w.remaining === 0) done.add(r.w); });
      for (const w of done) { await flush(w); written += w.chunks.length; log(`embed: ${w.slug}/${w.filename} → ${w.chunks.length} chunk(s)`); }
    }
    return { ok: true, docs: work.length, chunks: written };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 200), docs: 0, chunks: 0 };
  } finally {
    await closeDb().catch(() => { });
  }
}
