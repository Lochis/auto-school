/** Incremental material embedding — the daemon's "embeddings are the standard"
 * path (2026-10-17). Both the upload route and the 6h maintenance sweep call
 * `embedPendingMaterials()`; it is a cheap no-op when everything is fresh
 * (documents.indexed_at watermark vs fs mtime), never throws into the caller,
 * and silently degrades to a no-op when PG or the Gemini key is absent.
 *
 * Shared extraction helpers live here; scripts/embed-backfill.ts imports them
 * so script and daemon can never drift apart. */
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { getPool } from "./client.ts";
import { embedTexts, geminiApiKey, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings.ts";
import { pgConfigured } from "./reader.ts";
import { courseId } from "./writes.ts";

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

/** PPTX → text (slide <a:t> runs, in slide order). jszip rides mammoth's
 *  transitive dependency — no direct dep to avoid lockfile churn. */
function decodeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
export async function pptxText(src: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(readFileSync(src));
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]));
  const out: string[] = [];
  for (const f of slides) {
    const xml = (await zip.file(f)!.async("string")) as string;
    const line = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(" ").trim();
    if (line) out.push(line);
  }
  return out.join("\n\n");
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
  else if (ext === ".pptx") pages = [await pptxText(abs)];
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
export const EMBEDDABLE = new Set([".pdf", ".docx", ".pptx", ".txt", ".md", ".csv", ".json"]);

export interface EmbedSweepResult {
  ok: boolean;
  reason?: "pg-not-configured" | "no-key" | string;
  docs: number;
  chunks: number;
}

/** Targeted upload/transcribe embed — one material only, no fs sweep.
 *  Metadata (week/category/size) is set by registerMaterial's upsert; this
 *  ensures the row, chunks + embeds it, and stamps indexed_at. */
export async function embedOneMaterial(course: string, relPath: string, opts: {
  dataDir?: string; rpm?: number; log?: (m: string) => void;
} = {}): Promise<EmbedSweepResult> {
  const DATA = opts.dataDir ?? process.env.AUTO_SCHOOL_DATA ?? ".";
  const log = opts.log ?? (() => { });
  if (!pgConfigured()) return { ok: false, reason: "pg-not-configured", docs: 0, chunks: 0 };
  const key = geminiApiKey(DATA);
  if (!key) return { ok: false, reason: "no-key", docs: 0, chunks: 0 };
  const pool = getPool();
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  try {
    const cid = await courseId(course);
    const filename = relPath.split("/").pop()!;
    if (!EMBEDDABLE.has(extname(filename).toLowerCase()))
      return { ok: true, reason: "not-embeddable", docs: 1, chunks: 0 };
    const chunks = await materialChunks(join(DATA, "courses", course, "materials", relPath), filename);
    const row = (await q(`insert into documents (course_id, kind, rel_path, filename, owner_user_id, updated_at)
      values ($1,'material',$2,$3,$4, now())
      on conflict (course_id, kind, rel_path) do update set filename = excluded.filename, updated_at = now()
      returning id`, [cid, relPath, filename, OWNER])).rows[0];
    await q(`delete from document_chunks where document_id = $1`, [row.id]);
    if (chunks.length) {
      const embeddings = await embedTexts(chunks.map((c) => c.content), { apiKey: key, rpm: opts.rpm ?? 60 });
      const params: unknown[] = [];
      const tuples = chunks.map((c, j) => {
        params.push(row.id, c.page, c.chunk_index, c.content, Math.ceil(c.content.length / 4), toVectorLiteral(embeddings[j]!));
        const b = params.length - 6;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::vector,'${EMBEDDING_MODEL}')`;
      });
      await q(`insert into document_chunks (document_id, page, chunk_index, content, token_count, embedding, embedding_model)
        values ${tuples.join(",")}`, params);
    }
    await q(`update documents set indexed_at = now(), page_count = $2 where id = $1`, [row.id, Math.max(...chunks.map((c) => c.page), 0)]);
    log(`embed: ${course}/${filename} → ${chunks.length} chunk(s)`);
    return { ok: true, docs: 1, chunks: chunks.length };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 200), docs: 0, chunks: 0 };
  }
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
    // ── 1. prune: material rows whose fs file vanished (crash net) ────────
    const all = (await q(`select d.id, d.rel_path, c.slug from documents d join courses c on c.id = d.course_id where d.kind='material'`)).rows;
    let pruned = 0;
    for (const r of all) {
      if (!existsSync(join(DATA, "courses", String(r.slug), "materials", String(r.rel_path)))) {
        await q(`delete from documents where id = $1`, [r.id]);
        pruned++;
      }
    }
    if (pruned) log(`embed: pruned ${pruned} vanished material row(s)`);

    // ── 2. retry never-embedded rows (embed failed at upload, e.g. no key) ──
    const { rows } = await q(`select d.id, d.rel_path, d.filename, c.slug
      from documents d join courses c on c.id=d.course_id
      where d.kind='material' and d.indexed_at is null and c.slug <> 'attic' and d.rel_path not like '%.index/%'
      order by c.slug, d.rel_path limit 200`);
    const work: { id: string; slug: string; filename: string; rel_path: string; chunks: Chunk[]; remaining: number }[] = [];
    for (const r of rows) {
      // videos/images/code are real materials (list_materials must show them) but
      // are NEVER chunked/embedded — readFileSync-utf8 on binary produced 1663
      // garbage chunks in the 2026-10-17 incident. Enforce the whitelist here.
      if (!EMBEDDABLE.has(extname(String(r.filename)).toLowerCase())) continue;
      // dot-paths / hidden files / node_modules trees are never real materials
      if (String(r.rel_path).split("/").some((s) => s.startsWith("."))) continue;
      const abs = join(DATA, "courses", String(r.slug), "materials", String(r.rel_path));
      let chunks: Chunk[];
      try { chunks = await materialChunks(abs, String(r.filename)); }
      catch (e) { log(`embed: extract failed ${r.slug}/${r.rel_path}: ${String(e).slice(0, 80)}`); continue; }
      work.push({ id: String(r.id), slug: String(r.slug), filename: String(r.filename), rel_path: String(r.rel_path), chunks, remaining: chunks.length });
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
  }
}

/** Chunk a session text artifact (notes/transcript) at paragraph boundaries. */
function paragraphChunks(text: string, max = 4000): Chunk[] {
  return splitLong(text, max).map((p, j) => ({ page: 1, chunk_index: j, content: p }));
}

/** Incremental SESSION embedding — the missing half of "embeddings are the
 *  standard": notes/transcripts/timelines written by the live pipeline become
 *  semantically searchable without running the backfill script. Timelines are
 *  chunked per transcript_segment (authoritative + incremental); notes/
 *  transcripts chunk from session_artifacts.content. Watermarks: indexed_at vs
 *  artifact.updated_at (notes/transcript) and vs max(segments.created_at)
 *  (timeline). Call it from the 6h sweep AND right after finalizeNotes. */
export async function embedPendingSessions(opts: {
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
    // 1. ensure documents rows for session text artifacts (mirror backfill step a)
    await q(`insert into documents (course_id, kind, session_id, rel_path, filename, owner_user_id, updated_at)
      select s.course_id, a.kind, s.id, a.rel_path, regexp_replace(a.rel_path, '^.*/', ''), $1, now()
      from session_artifacts a join sessions s on s.id = a.session_id
      where a.kind = any($2) and a.content is not null
      on conflict (course_id, kind, rel_path) do update set session_id = excluded.session_id, updated_at = now()`,
      [OWNER, ["notes", "transcript", "timeline"]]);

    // 2. pending docs (notes/transcript by artifact mtime; timeline by newest segment)
    const { rows } = await q(`select d.id, d.kind, d.session_id, d.rel_path, d.filename, d.indexed_at, c.slug,
        a.content, a.updated_at as art_mtime,
        (select max(ts.created_at) from transcript_segments ts where ts.session_id = d.session_id) as seg_newest
      from documents d join courses c on c.id = d.course_id
      left join session_artifacts a on a.session_id = d.session_id and a.kind = d.kind and a.rel_path = d.rel_path
      where d.kind in ('notes','transcript','timeline')`);

    const work: { id: string; slug: string; filename: string; kind: string; chunks: Chunk[]; remaining: number }[] = [];
    for (const r of rows) {
      const indexed = r.indexed_at ? Date.parse(String(r.indexed_at)) : 0;
      if (r.kind === "timeline") {
        const newest = r.seg_newest ? Date.parse(String(r.seg_newest)) : 0;
        if (indexed && (!newest || indexed >= newest)) continue; // fresh or empty
        const segs = (await q(`select offset_sec, transcript from transcript_segments where session_id=$1 order by offset_sec`, [r.session_id])).rows;
        const chunks: Chunk[] = segs.filter((s) => s.transcript?.trim())
          .map((s, i) => ({ page: 1, chunk_index: i, content: String(s.transcript).trim() }));
        if (!chunks.length) continue; // nothing yet — leave unindexed so it retries next sweep
        work.push({ id: String(r.id), slug: String(r.slug), filename: String(r.filename), kind: "timeline", chunks, remaining: chunks.length });
      } else {
        if (r.content == null) continue;
        const mtime = r.art_mtime ? Date.parse(String(r.art_mtime)) : 0;
        if (indexed && mtime && indexed >= mtime) continue;
        const chunks = paragraphChunks(String(r.content));
        if (!chunks.length) continue;
        work.push({ id: String(r.id), slug: String(r.slug), filename: String(r.filename), kind: String(r.kind), chunks, remaining: chunks.length });
      }
      if (work.length >= 200) break;
    }
    if (!work.length) return { ok: true, reason: "fresh", docs: 0, chunks: 0 };

    // 3. embed + write (remaining-count flush, one write per doc)
    const BATCH = opts.batch ?? 25;
    const flush = async (w: typeof work[number]) => {
      await q(`delete from document_chunks where document_id=$1`, [w.id]);
      const params: unknown[] = [];
      const tuples = w.chunks.map((c) => {
        params.push(w.id, c.page, c.chunk_index, c.content, Math.ceil(c.content.length / 4), toVectorLiteral((c as { embedding?: number[] }).embedding!));
        const b = params.length - 6;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::vector,'${EMBEDDING_MODEL}')`;
      });
      await q(`insert into document_chunks (document_id, page, chunk_index, content, token_count, embedding, embedding_model)
        values ${tuples.join(",")}`, params);
      await q(`update documents set indexed_at=now() where id=$1`, [w.id]);
    };
    const refs = work.flatMap((w) => w.chunks.map((c) => ({ w, c })));
    let written = 0;
    for (let i = 0; i < refs.length; i += BATCH) {
      const batch = refs.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch.map((r) => r.c.content), { apiKey: key, rpm: opts.rpm ?? 60 });
      const done = new Set<typeof work[number]>();
      batch.forEach((r, j) => { (r.c as { embedding?: number[] }).embedding = embeddings[j]!; if (--r.w.remaining === 0) done.add(r.w); });
      for (const w of done) { await flush(w); written += w.chunks.length; log(`embed: ${w.slug}/${w.filename} [${w.kind}] → ${w.chunks.length} chunk(s)`); }
    }
    return { ok: true, docs: work.length, chunks: written };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 200), docs: 0, chunks: 0 };
  }
}
