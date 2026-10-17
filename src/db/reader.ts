/** Read-only Postgres access for daemon code paths (tools.ts vector search).
 *  Deliberately its own module so daemon imports stay side-effect free:
 *  src/db/client.ts (and its pg Pool) is imported dynamically ONLY when a
 *  database is actually configured (DATABASE_URL or PGHOST) — the daemon
 *  runs unchanged without Postgres, exactly as before the migration. */

import { EMBEDDING_MODEL, toVectorLiteral } from "./embeddings.ts";

/** True when Postgres env is present — gates every DB-backed code path. */
export function pgConfigured(): boolean {
  return !!(process.env.DATABASE_URL || process.env.PGHOST);
}

export interface ChunkHit {
  kind: string;
  slug: string;
  stem: string | null;
  rel_path: string;
  page: number;
  chunk_index: number;
  preview: string;
  score: number;
}

const SELECT = `
  select d.kind, c.slug, s.stem, d.rel_path, dc.page, dc.chunk_index,
         left(dc.content, 240) as preview, $score$ as score
  from document_chunks dc
  join documents d on d.id = dc.document_id
  join courses c on c.id = d.course_id
  left join sessions s on s.id = d.session_id`;

/** pgvector cosine-similarity search (plan §3 search path). */
export async function vectorSearch(opts: {
  embedding: readonly number[];
  course?: string;
  kind?: string;
  k?: number;
  model?: string;
}): Promise<ChunkHit[]> {
  const { getPool } = await import("./client.ts");
  const params: unknown[] = [toVectorLiteral(opts.embedding), opts.model ?? EMBEDDING_MODEL];
  const where = ["dc.embedding is not null", "dc.embedding_model = $2"];
  if (opts.course) { params.push(opts.course); where.push(`c.slug = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); where.push(`d.kind = $${params.length}`); }
  params.push(Math.max(1, Math.min(opts.k ?? 8, 50)));
  const sql = SELECT.replace("$score$", "1 - (dc.embedding <=> $1)") + `
    where ${where.join(" and ")} order by dc.embedding <=> $1 limit $${params.length}::int`;
  const { rows } = await getPool().query(sql, params);
  return rows as ChunkHit[];
}

/** Keyword comparison mode: pg_trgm similarity + ilike substring. */
export async function keywordSearch(opts: {
  query: string;
  course?: string;
  kind?: string;
  k?: number;
}): Promise<ChunkHit[]> {
  const { getPool } = await import("./client.ts");
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const score = `similarity(dc.content, ${p(opts.query)})`; // score param first — LIMIT index comes last
  where.push(`(dc.content ilike ${p(`%${opts.query.replace(/[%_]/g, (m) => "\\" + m)}%`)} or ${score} > 0.2)`);
  if (opts.course) where.push(`c.slug = ${p(opts.course)}`);
  if (opts.kind) where.push(`d.kind = ${p(opts.kind)}`);
  params.push(Math.max(1, Math.min(opts.k ?? 8, 50)));
  const sql = SELECT.replace("$score$", score) + `
    where ${where.join(" and ")} order by score desc limit $${params.length}::int`;
  const { rows } = await getPool().query(sql, params);
  return rows as ChunkHit[];
}

/** Total chunk count (UIs/CLIs use this to detect "nothing embedded yet"). */
export async function chunkCount(): Promise<number> {
  const { getPool } = await import("./client.ts");
  const { rows } = await getPool().query("select count(*)::int n from document_chunks");
  return rows[0].n as number;
}

/** Drain the pool before exit (scripts only; safe when never connected). */
export async function closeReader(): Promise<void> {
  const { closeDb } = await import("./client.ts");
  await closeDb();
}
