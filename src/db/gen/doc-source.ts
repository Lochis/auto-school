/** Bundleable PG doc sourcing for the platform generators (5b-2 c, D2).
 *
 *  Why it exists: the platform pod copies ONLY `src/db/` into the frontend
 *  image (frontend/Dockerfile:15), so every generation input has to be read
 *  through raw `pg` — never through `src/pipeline/materials.ts` (fs walk,
 *  `node:fs`, settings.json). `documents` + `document_chunks` already hold the
 *  material page text (ingest-embed.ts / embed-sessions.ts write them), so a
 *  course's corpus is one aggregate query.
 *
 *  Bundleable by construction: imports `./pg.ts` + `./owner.ts` only. No fs,
 *  no drizzle, no src/status.ts, no module-level side effects.
 *
 *  OWNER SCOPING: `owner_user_id` defaults to `curOwner()` (the request's
 *  users.id via ownerALS, system user outside a request). Pass `owner`
 *  explicitly only for backfills/tests.
 *
 *  ⚠ Known quality risk (platform-ai-generation.md "Known quality risk"):
 *  PG is a FILTERED corpus — only embeddable extensions are chunked, PDFs need
 *  `pdftotext` on the recorder, scanned pages yield no text, and nothing is
 *  chunked post-cutover until the embed key path works. A course can therefore
 *  have `documents` rows with ZERO chunks; `getCourseDocCoverage()` +
 *  `coverageNote()` exist so callers warn "no indexed text" instead of
 *  silently generating from an empty corpus.
 */
import { getPool } from "../pg.ts";
import { curOwner } from "../owner.ts";

/** One material document with its chunk text re-assembled. */
export interface CourseDoc {
  /** "Week 1/1.1 Modeling.pdf" — documents.rel_path */
  rel_path: string;
  filename: string;
  /** chunk contents joined in (page, chunk_index) order; "" when unindexed */
  text: string;
  /** number of document_chunks rows (0 = filtered out of the corpus) */
  chunks: number;
  week: number | null;
  category: string;
  page_count: number | null;
}

/** Corpus coverage probe — the "no indexed text" warning source. */
export interface DocCoverage {
  course: string;
  /** material documents owned by the owner */
  total: number;
  /** documents with at least one chunk */
  indexed: number;
  /** documents that contribute NO text to generation */
  unindexed: { rel_path: string; filename: string }[];
}

/** Separator between chunks of one document (page breaks are implicit). */
export const CHUNK_JOINER = "\n\n";

interface DocRow {
  rel_path: string;
  filename: string;
  week: number | null;
  category: string;
  page_count: number | null;
  chunk_count: number;
  parts: string[] | null;
}

/** One aggregate round-trip: documents LEFT JOIN their chunks, chunks ordered
 *  page → chunk_index (the docindex reading order). LEFT so unindexed docs are
 *  visible to the coverage probe instead of silently vanishing. */
const SELECT_DOCS = `
  select d.rel_path,
         d.filename,
         d.week,
         d.category,
         d.page_count,
         count(c.id)::int as chunk_count,
         coalesce(
           json_agg(c.content order by c.page, c.chunk_index)
             filter (where c.id is not null), '[]'::json
         ) as parts
    from documents d
    left join document_chunks c on c.document_id = d.id
   where d.course_id = (select id from courses where slug = $1)
     and d.kind = 'material'
     and d.owner_user_id = $2
   group by d.id, d.rel_path, d.filename, d.week, d.category, d.page_count
   order by d.rel_path`;

const toDoc = (r: DocRow): CourseDoc => {
  const parts = Array.isArray(r.parts) ? r.parts : [];
  return {
    rel_path: String(r.rel_path),
    filename: String(r.filename),
    text: parts.join(CHUNK_JOINER),
    chunks: Number(r.chunk_count ?? 0),
    week: r.week == null ? null : Number(r.week),
    category: r.category == null ? "other" : String(r.category),
    page_count: r.page_count == null ? null : Number(r.page_count),
  };
};

const coverageOf = (course: string, docs: CourseDoc[]): DocCoverage => {
  const unindexed = docs.filter((d) => d.chunks === 0).map((d) => ({ rel_path: d.rel_path, filename: d.filename }));
  return { course, total: docs.length, indexed: docs.length - unindexed.length, unindexed };
};

/** Docs + coverage from ONE query (prefer this when the caller warns). */
export async function getCourseDocsWithCoverage(
  course: string,
  owner?: string,
): Promise<{ docs: CourseDoc[]; coverage: DocCoverage; note: string | null }> {
  const { rows } = await getPool().query<DocRow>(SELECT_DOCS, [course, owner ?? curOwner()]);
  const docs = rows.map(toDoc);
  const coverage = coverageOf(course, docs);
  return { docs, coverage, note: coverageNote(coverage) };
}

/** The course's material documents, chunk text re-assembled per document.
 *  Includes UNINDEXED docs (text: "", chunks: 0) so the caller sees them —
 *  filter on `chunks > 0` for a text-only corpus. Never throws on a missing
 *  course: an unknown slug simply has no rows. */
export async function getCourseDocs(course: string, owner?: string): Promise<CourseDoc[]> {
  const { rows } = await getPool().query<DocRow>(SELECT_DOCS, [course, owner ?? curOwner()]);
  return rows.map(toDoc);
}

/** Coverage probe alone (same query, docs discarded). */
export async function getCourseDocCoverage(course: string, owner?: string): Promise<DocCoverage> {
  return coverageOf(course, await getCourseDocs(course, owner));
}

/** Human warning for the generator/tool surface, or null when the corpus is
 *  fully indexed (or the course simply has no materials — that is a different
 *  message and belongs to the caller). */
export function coverageNote(cov: DocCoverage): string | null {
  if (!cov.total || !cov.unindexed.length) return null;
  const names = cov.unindexed.slice(0, 5).map((d) => d.rel_path).join(", ");
  const more = cov.unindexed.length > 5 ? ` (+${cov.unindexed.length - 5} more)` : "";
  return `no indexed text for ${cov.unindexed.length}/${cov.total} material document(s) in ${cov.course}: ${names}${more}` +
    ` — unembeddable extension, scanned/image PDF, or the embed sweep has not run`;
}

/** Plain-text corpus for a prompt: "## <rel_path>" headers + body, unindexed
 *  docs skipped. Pure (no IO) so both the routes and the daemon can share it. */
export function corpusText(docs: readonly CourseDoc[]): string {
  return docs
    .filter((d) => d.chunks > 0 && d.text.trim())
    .map((d) => `## ${d.rel_path}\n${d.text}`)
    .join("\n\n");
}
