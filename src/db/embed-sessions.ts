/** Incremental SESSION embedding — notes/transcripts/timelines written by the
 *  live pipeline become semantically searchable without the backfill script.
 *  Split out of ingest-embed.ts so the FRONTEND can import `embedPendingSessions`
 *  without pulling the materials-parsing deps (mammoth/jszip) that live only in
 *  the daemon's root node_modules. Do NOT add mammoth/jszip/pdf deps here. */
import { getPool } from "./pg.ts";
import { embedTexts, geminiApiKey, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings.ts";
import { pgConfigured } from "./reader.ts";
import { courseId } from "./writes.ts";
import { resolveApiKey } from "./llm-keys.ts";

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

/** Chunk a session text artifact (notes/transcript) at paragraph boundaries. */
function paragraphChunks(text: string, max = 4000): Chunk[] {
  return splitLong(text, max).map((p, j) => ({ page: 1, chunk_index: j, content: p }));
}

export interface EmbedSweepResult {
  ok: boolean;
  reason?: "pg-not-configured" | "no-key" | string;
  docs: number;
  chunks: number;
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
  // fs-first (daemon: settings.json → env), app_settings as the platform's last
  // resort — the platform pod has no /data mount, so fs resolution fails there.
  const key = geminiApiKey(DATA) ?? (await resolveApiKey("GEMINI_API_KEY"));
  if (!key) return { ok: false, reason: "no-key", docs: 0, chunks: 0 };

  const pool = getPool();
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  try {
    // 1. ensure documents rows for session text artifacts (mirror backfill step a).
    //    Owner is derived from the SESSION row (s.owner_user_id) — the SELECT spans
    //    every owner's artifacts, so a sweep kicked by owner B can never stamp (or
    //    re-own, pre-2026-10-30-wave) owner A's documents rows.
    await q(`insert into documents (course_id, kind, session_id, rel_path, filename, owner_user_id, updated_at)
      select s.course_id, a.kind, s.id, a.rel_path, regexp_replace(a.rel_path, '^.*/', ''), s.owner_user_id, now()
      from session_artifacts a join sessions s on s.id = a.session_id
      where a.kind = any($1) and a.content is not null
      on conflict (course_id, kind, rel_path, owner_user_id) do update set session_id = excluded.session_id, updated_at = now()`,
      [["notes", "transcript", "timeline"]]);

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
