/** Bundleable deadline-rebuild generator (5b-2 c, D5 — extracted from
 *  src/daemon.ts:1850-2227).
 *
 *  This is the ONE implementation of "sweep every course document and rebuild
 *  the student's deadline calendar". src/daemon.ts's /deadlines POST rebuild
 *  branch now delegates here (quota-aware GLM client + fs/VLM tool runner
 *  injected), so the recorder and the platform cannot drift.
 *
 *  Bundleable by construction (frontend/Dockerfile:15 copies only `src/db/`):
 *  imports `../pg.ts`, `../owner.ts`, `../llm.ts` (raw provider transport),
 *  `../llm-keys.ts` (env → app_settings key), `../deadlines.ts` (readDl /
 *  writeDl / readFolds / writeFolds / readCk / writeCk / foldChildInto — pg +
 *  owner only), `../state.ts` (deadlines_meta manifest), `./doc-source.ts` (PG
 *  documents) and `./tools.ts` (PG tool surface). No fs, no drizzle, no
 *  src/status.ts, no src/pipeline/*, no module-level side effects.
 *
 *  PROMPTS ARE BYTE-FOR-BYTE the daemon's: the incremental/full `scopeText`,
 *  the calendar system prompt (JSON schedule files carry exact dates, page-by-
 *  page reads, the `{"course", "title", "due", …}` item contract, `today`),
 *  both user messages, the semantic-dedup prompt and the parent/child fold
 *  prompt. The tool loop bounds (18 incremental / 26 full rounds) and the
 *  52 000-char per-result trim are unchanged. The only intentional difference,
 *  applied to BOTH paths: when the PG corpus has no/patchy indexed text (PG is
 *  a FILTERED corpus — see doc-source.ts's header) one `NOTE:` sentence listing
 *  the unindexed documents is appended to the USER message (same wording family
 *  as gen/checklist.ts) and surfaced as `warning`.
 *
 *  FS INPUTS BECAME PG INPUTS (the only two fs couplings) — both are
 *  INJECTABLE via `RebuildDeadlinesOpts.snapshotDocs` / `.courseList`, so the
 *  daemon passes its ORIGINAL fs reads back in (byte-identical pre-5b2c sweep)
 *  while the platform takes these PG defaults:
 *    - `snapshotDocs` (daemon `:1857-1875`) stat-walked
 *      `DATA_DIR/courses/<slug>/materials` into the `deadlines_meta` manifest
 *      of `{m, s}` per `${course}/${relPath}`; now it aggregates
 *      `documents` (kind='material') → `updated_at` epoch-ms + `size_bytes`,
 *      SAME manifest keys, so incremental mode still detects exactly the
 *      changed/new/deleted documents.
 *    - `allCourses()` (fs dir union, `pipeline/tools.ts:71-79`) became
 *      `courseList()` — `select slug from courses order by slug`. It gates the
 *      slug allow-list used to normalize the model's `course` field.
 *  Everything else (fold verdicts, checklists, deadline writes) already lived
 *  in db/deadlines.ts and is reused, not reimplemented.
 *
 *  LLM + TOOLS ARE INJECTED (same contract as gen/checklist.ts):
 *    - `callTools` — daemon: pipeline/llm.ts `glmChatRaw` (429 learning, model
 *      rotation, activity feed); platform: `defaultCallTools` = raw
 *      db/llm.ts glmChatComplete with an env/app_settings key.
 *    - `runTool`   — daemon: pipeline/tools.ts `runTool` (fs + PG, .index/
 *      bundles, view_page VLM); platform: `runToolPgCall` (PG only).
 *    - `tools`     — daemon: pipeline/tools.ts `TOOL_DEFS`; platform:
 *      `TOOL_DEFS_PG` (byte-identical copy).
 *    - `onEvent`   — daemon `pushEvent`; platform: console or a route log.
 */
import { getPool } from "../pg.ts";
import { curOwner } from "../owner.ts";
import { GLM_DEFAULT_BASE, glmChatComplete, type ChatMsg, type ToolCall } from "../llm.ts";
import { resolveApiKey } from "../llm-keys.ts";
import {
  type Dl,
  type FoldSug,
  dlId,
  dlKey,
  foldChildInto,
  readCk,
  readDl,
  readFolds,
  uniqIds,
  writeCk,
  writeDl,
  writeFolds,
} from "../deadlines.ts";
import { metaLoad, metaReplace } from "../state.ts";
import { type DocCoverage, coverageNote, getCourseDocsWithCoverage } from "./doc-source.ts";
import { TOOL_DEFS_PG, runToolPgCall } from "./tools.ts";

const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

// ── injectable LLM / tools ────────────────────────────────────────────────

/** One tool-loop round: `(messages, tools) => assistant message`. The daemon
 *  injects pipeline/llm.ts `glmChatRaw` (quota-aware); the platform uses
 *  `defaultCallTools` below. Also used for the two tool-less helper calls
 *  (semantic dedup, fold classification). */
export type CallTools = (
  messages: ChatMsg[],
  tools?: unknown[],
) => Promise<{ content: string; tool_calls?: ToolCall[] }>;

/** One tool execution: `(name, rawArgumentsJson) => result string`. The daemon
 *  injects pipeline/tools.ts `runTool` (fs-capable, VLM view_page); the
 *  platform uses `runToolPgCall` (Postgres-only surface). */
export type CallTool = (name: string, argsJson: string) => Promise<string>;

/** model/endpoint defaults mirror the daemon without importing src/status.ts:
 *  GLM_MODEL (pipeline/llm.ts glmModel), GLM_BASE (status.ts glmBase). */
const glmModel = (): string => process.env.GLM_MODEL?.trim() || "glm-5.3";
const glmBase = (): string => process.env.GLM_BASE?.trim() || GLM_DEFAULT_BASE;

/** Raw GLM round-trip with tools — mirrors pipeline/llm.ts `glmChatRaw` (same
 *  model, base, temperature 0.4, same error string) minus quota policy. Keys
 *  come from env → app_settings (llm-keys.ts), never the filesystem. */
export const defaultCallTools: CallTools = async (messages, tools) => {
  const key = await resolveApiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const r = await glmChatComplete(glmModel(), key, messages, { base: glmBase(), tools, temperature: 0.4 });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${r.body.slice(0, 200)}`);
  return { content: r.text, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) };
};

// ── error contract (the daemon's exact in-body 500s) ──────────────────────

/** A rebuild failure that used to be an inline `send(500, { error })` — the
 *  adapter sends `e.message` verbatim so the pre-5b2c bodies survive
 *  ("model produced no JSON array: …", "JSON parse failed: …", "empty deadline
 *  list"). Everything else stays wrapped by the daemon's
 *  "deadline rebuild failed: …" catch. */
export class DeadlineGenError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "DeadlineGenError";
    this.status = status;
  }
}

// ── PG inputs (replacements for the daemon's two fs reads) ────────────────

/** Manifest entry — `deadlines_meta` row shape (`state.ts:175-181`). */
export type DocStat = { m: number; s: number };
export type DocSnapshot = Record<string, DocStat & { course: string }>;

/** Manifest snapshot source — the PG default below, or the daemon's pre-5b2c
 *  fs stat walk. `owner` is forwarded so an explicit-owner caller never needs
 *  the ALS context. */
export type SnapshotDocsFn = (owner?: string, course?: string | null) => Promise<DocSnapshot> | DocSnapshot;
/** Slug allow-list source — `select slug from courses` (below), or the daemon's
 *  fs dir union (`pipeline/tools.ts` `allCourses()`). */
export type CourseListFn = () => Promise<string[]> | string[];

/** Course slugs — replacement for pipeline/tools.ts `allCourses()` (a readdir
 *  union of recordings/notes/courses). PG is the only source on the platform;
 *  the recorder's PG already holds every course it has seen. Owner-scoped
 *  (2026-10-30 wave, resolveCourses pattern): platform calls run inside
 *  ownerALS.run so each user probes only their own courses; system jobs fall
 *  back to the seed owner. */
export async function courseList(): Promise<string[]> {
  const { rows } = await q(`select slug from courses where owner_user_id = $1 order by slug`, [curOwner()]);
  return (rows as { slug: string }[]).map((r) => String(r.slug));
}

/** Manifest snapshot — replacement for the daemon's `snapshotDocs()` stat walk
 *  over `DATA_DIR/courses/<slug>/materials` (`:1857-1875`).
 *
 *  Keys stay `${course}/${relPath}` and values stay `{m, s}`, so an existing
 *  incremental baseline keeps working: `m` is `documents.updated_at` in epoch
 *  ms (the re-ingest watermark) and `s` is `documents.size_bytes` (0 when the
 *  row never carried a size). `materials.json` / dot-files have no `documents`
 *  row, matching the daemon's skip list. */
export async function snapshotDocs(owner?: string, course?: string | null): Promise<DocSnapshot> {
  const { rows } = await q(
    `select c.slug as course,
            d.rel_path,
            (extract(epoch from d.updated_at) * 1000)::bigint as m,
            coalesce(d.size_bytes, 0)::bigint as s
       from documents d
       join courses c on c.id = d.course_id
      where d.kind = 'material'
        and d.owner_user_id = $1
        and ($2::text is null or c.slug = $2)
      order by c.slug, d.rel_path`,
    [owner ?? curOwner(), course ?? null],
  );
  const out: DocSnapshot = {};
  for (const r of rows as Record<string, unknown>[]) {
    const slug = String(r.course);
    out[`${slug}/${String(r.rel_path)}`] = { m: Number(r.m ?? 0), s: Number(r.s ?? 0), course: slug };
  }
  return out;
}

// ── prompts (byte-for-byte the daemon's) ──────────────────────────────────

/** `src/daemon.ts:1883-1886` — the scoped (incremental) hint. */
export function incrementalScopeText(changedDocs: Map<string, string[]>): string {
  return `
This is an INCREMENTAL update — only these documents changed since the last full build (course slug → paths under materials/):
${[...changedDocs].map(([c, docs]) => `- ${c}: ${docs.join(", ")}`).join("\n")}
Read ONLY these documents (list_courses first to resolve slugs). Re-extract every deadline item each changed document defines — one entry per item, exact dates as before. Do NOT output items from unchanged documents; the rest of the calendar is already correct.`;
}

/** `src/daemon.ts:1887` — the full-sweep hint (no leading newline). */
export const FULL_SCOPE_TEXT = `Explore with tools first: list_courses, then week_overview / list_materials / read_document on anything likely to carry due dates (syllabi, intro/summary sheets, exercise and lab docs, course configs). Read enough to pin dates down; skim, don't quote.`;

/** `src/daemon.ts:1888-1896` — the calendar system prompt. `now` replaces
 *  `new Date()` so a dry run/test can pin the date. */
export function deadlineSystemPrompt(scopeText: string, now: Date = new Date()): string {
  return `You build the student's DEADLINE CALENDAR across ALL courses from the real files — never invent dates.
${scopeText}
JSON schedule files (quizzes.json, discussions.json, …) carry EXACT per-item due dates — always read them fully and emit ONE entry per item with its date; NEVER lump recurring weekly work (quizzes, discussion posts) into a single undated umbrella entry when individual dates exist.
Long text/JSON documents are served page by page (~12k characters per page). If a read ends with "…(truncated — request specific pages)", keep reading the remaining pages with read_document's page argument until you have seen the WHOLE file — never extract items from a partial read.
Then reply with ONLY a JSON array (no prose, no markdown fences), one object per task:
{"course": exact slug from list_courses, "title": short task name, "due": "YYYY-MM-DD" or null, "kind": "assignment"|"lab"|"reading"|"install"|"signup"|"post"|"quiz"|"exam"|"other", "spread": true if worth spreading out / starting early (installs, long projects, readings) else false, "startBy": "YYYY-MM-DD" or null, "note": "≤120 chars, key detail", "source": "exact file name or session stem", "confidence": "high"|"medium"|"low"}
Include hard deadlines AND soft/spread-out items. If a date is uncertain use confidence "low". Today is ${now.toISOString().slice(0, 10)}.`;
}

/** `src/daemon.ts:1897-1900` — user message; the trailing `NOTE:` is the one
 *  intentional addition (see the header: PG is a filtered corpus). */
export function deadlineUserPrompt(scoped: boolean, warning?: string | null): string {
  return (scoped
    ? `Update the deadline calendar now: read exactly the changed documents listed above, then output ONLY the JSON array of items they define.`
    : `Build the deadline calendar now. Explore the courses with tools, then output ONLY the JSON array.`) +
    (warning ? `\n\nNOTE: ${warning} — the course materials may be unreadable here, so base items only on what the tools actually return.` : "");
}

/** `src/daemon.ts:2043` — semantic dedup system prompt. */
export const DEDUPE_SYSTEM_PROMPT = `You deduplicate a student's deadline calendar. Each PAIR holds two entries extracted from different course documents. Decide whether both describe the SAME real task (one assignment/quiz/exam/post extracted twice, with wording or date conflicts) or two DIFFERENT tasks.
STRICT — only answer same=true with confidence "high" when you are certain: same task number AND same subject matter. "Assignment 1" vs "Assignment 1: Spring MVC car insurance app" = same. "Assignment 1" vs "Assignment 2", or "Week 3 discussion" vs "Week 4 discussion" = different. When in doubt, answer same=false.
For pairs you judge same, also pick the best evidence: due/startBy as "A", "B" or "none" (prefer the more specific and more recent source; a dated entry beats an undated one; never pick the side that is NOT manual if the other IS), a merged short title, and a merged note (≤160 chars, keep the most specific detail).
Reply with ONLY a JSON array, one object per pair in order: {"pair": <number>, "same": boolean, "confidence": "high"|"medium"|"low", "due": "A"|"B"|"none", "startBy": "A"|"B"|"none", "title": string, "note": string}`;

/** `src/daemon.ts:2101` — parent/child (fold) classification system prompt. */
export const FOLD_SYSTEM_PROMPT = `You classify PAIRS of deadline entries from one student's course. Decide the relation between each pair:
- "same": both entries are THE SAME task extracted twice.
- "part-of": one entry is a distinct sub-deliverable OF the other — e.g. "A1 Part A: Venture vision paragraph" is part of "Assignment 1: Entrepreneurial Process" (separately evaluated, but belongs to the umbrella task). Name the umbrella via "parent": "A" or "B" — the umbrella is the BROADER whole, never the part.
- "unrelated": different tasks (different numbers, weeks, or deliverables).
STRICT: only "part-of" with confidence "high" when containment is explicit (Part/Phase/Section naming, or the child title is clearly one piece of the parent's deliverable). When in doubt, answer "unrelated".
Reply with ONLY a JSON array, one object per pair in order: {"pair": <number>, "relation": "same"|"part-of"|"unrelated", "parent": "A"|"B", "confidence": "high"|"medium"|"low"}`;

/** Tool-round bounds (daemon: `scoped ? 18 : 26`) and the per-result trim. */
const MAX_ROUNDS_SCOPED = 18;
const MAX_ROUNDS_FULL = 26;
const TOOL_RESULT_CAP = 52_000;

// ── identity helpers (verbatim from the daemon) ───────────────────────────

/** Fuzzy identity: the same real task can come back under a different title
 *  next build ("Discussion: Wk3 Q1" vs "Week 3 - Question One") — normalize +
 *  abbreviation-expand for matching. */
export function normTitle(t: string): string {
  return t.toLowerCase().replace(/&/g, " and ")
    .replace(/\bwk\s*/g, "week ").replace(/\bw(\d+)\b/g, "week $1")
    .replace(/\bq\s*(\d+)\b/g, "question $1")
    .replace(/#/g, " ")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
      (mm) => String(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"].indexOf(mm) + 1))
    .replace(/\bquiz(zes)?\b/g, "quiz").replace(/\bdiscussions?\b/g, "discussion")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const tokensOf = (t: string): Set<string> => new Set(normTitle(t).split(" ").filter((w) => w.length > 1));

/** Token containment of the smaller title. */
export function sim(a: string, b: string): number {
  const A = tokensOf(a), B = tokensOf(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size); // containment of the smaller
}

/** Numbers in titles are strong identity (Q1 vs Q2): every digit in one title
 *  must appear in the other for a match. */
export function digitsOk(a: string, b: string): boolean {
  const d = (t: string) => new Set(normTitle(t).match(/\d+/g) ?? []);
  const A = d(a), B = d(b);
  if (!A.size || !B.size) return true;
  const [sm, bg] = A.size <= B.size ? [A, B] : [B, A];
  for (const n of sm) if (!bg.has(n)) return false;
  return true;
}

/** "#1-#11" umbrellas never re-match. */
export const RANGE = /\d\s*[-\u2013]\s*#?\s*\d/;

export const sameTask = (a: string, b: string): boolean =>
  !RANGE.test(a) && !RANGE.test(b) && digitsOk(a, b) && sim(a, b) >= 0.5;

/** "Week 1/1.1 Modeling.pdf" → "1.1 Modeling.pdf" */
const baseOf = (p: string): string => p.split("/").pop() ?? p;

// ── generator ─────────────────────────────────────────────────────────────

export interface RebuildDeadlinesOpts {
  /** restrict the sweep to ONE course slug (default: every PG course) */
  course?: string;
  /** "full" re-extracts everything; "update" only rescans changed documents
   *  (default "update", matching the daemon's body.mode default) */
  mode?: "full" | "update";
  /** quota-aware tool-loop call (daemon) or omitted for `defaultCallTools` */
  callTools?: CallTools;
  /** fs/VLM tool runner (daemon) or omitted for the PG surface */
  runTool?: CallTool;
  /** tool schemas for the LLM; defaults to `TOOL_DEFS_PG` */
  tools?: unknown[];
  /** board / activity-feed sink (daemon `pushEvent`) */
  onEvent?: (msg: string) => void;
  /** explicit owner; defaults to `curOwner()` inside the db/* helpers */
  owner?: string;
  /** "today" for the prompt (default: now) */
  now?: Date;
  /** material-manifest source for the incremental diff; defaults to the PG
   *  `documents` aggregate (`snapshotDocs` export). The DAEMON injects its fs
   *  stat walk so a material on disk with no `documents` row is not mistaken
   *  for a deleted document. */
  snapshotDocs?: SnapshotDocsFn;
  /** course-slug allow-list; defaults to `select slug from courses`
   *  (`courseList` export). The DAEMON injects the fs dir union so fs-only
   *  courses keep normalizing. */
  courseList?: CourseListFn;
}

export interface RebuildDeadlinesResult {
  /** update mode found nothing changed → no LLM call, calendar untouched */
  unchanged: boolean;
  /** the mode actually run ("full" when there was no baseline to diff) */
  mode: "full" | "update";
  /** item count after the rebuild */
  count: number;
  added: { course: string; title: string; due: string | null; kind: string }[];
  updated: { course: string; title: string; due: string | null; was: string | null }[];
  deduped: number;
  folded: number;
  suggestions: FoldSug[];
  /** changed + deleted documents scanned (0 for a full rebuild) */
  changed: number;
  /** the calendar after the rebuild (what the route returns) */
  deadlines: Dl[];
  /** PG corpus warning ("no indexed text for …"), or null when fine */
  warning: string | null;
  /** per-course coverage probed for the warning */
  coverage: DocCoverage[];
}

/** Sweep the course corpus and rebuild the deadline calendar.
 *
 *  Stages, in order (all from the daemon, unchanged):
 *    1. incremental diff — PG manifest vs current PG documents;
 *    2. LLM tool loop → JSON array;
 *    3. normalize (slug allow-list, dates, kinds) + fuzzy carry-over of
 *       id/done/userNote/manual dates from the previous build;
 *    4. deterministic dedupe, then the conservative LLM semantic dedupe;
 *    5. accepted-fold re-application + new fold suggestions (`deadline_folds`);
 *    6. orphaned-checklist heal + `writeDl` + manifest rewrite.
 */
export async function rebuildDeadlines(opts: RebuildDeadlinesOpts = {}): Promise<RebuildDeadlinesResult> {
  const owner = opts.owner;
  const mode: "full" | "update" = opts.mode === "full" ? "full" : "update";
  const now = opts.now ?? new Date();
  const callTools = opts.callTools ?? defaultCallTools;
  const scopeSlug = opts.course?.trim() || null;
  const runTool = opts.runTool ??
    ((name, argsJson) => runToolPgCall({ function: { name, arguments: argsJson } }, scopeSlug ?? undefined, owner));
  const tools = opts.tools ?? TOOL_DEFS_PG;
  const onEvent = opts.onEvent;
  // inputs are injectable: PG defaults (platform) vs the daemon's fs reads
  const snapshotDocsOf = opts.snapshotDocs ?? snapshotDocs;
  const courseListOf = opts.courseList ?? courseList;

  // manifest: updated_at+size of every course document at last build — a PG
  // query (no LLM) tells us exactly what changed since
  const prevMeta = await metaLoad(owner);
  const prev0 = await readDl(owner);
  const changedDocs = new Map<string, string[]>(); // slug → rel paths changed/new
  const deletedKeys = new Set<string>();           // manifest keys whose doc is gone
  let scoped = false;
  if (mode === "update" && prev0.length > 0 && Object.keys(prevMeta.docs).length > 0) {
    const cur = await snapshotDocsOf(owner, scopeSlug);
    for (const [k, v] of Object.entries(cur)) {
      const p = prevMeta.docs[k];
      if (!p || p.m !== v.m || p.s !== v.s) changedDocs.set(v.course, [...(changedDocs.get(v.course) ?? []), k.slice(v.course.length + 1)]);
    }
    for (const k of Object.keys(prevMeta.docs)) {
      if (scopeSlug && k.split("/")[0] !== scopeSlug) continue; // other courses aren't in this run's snapshot
      if (!cur[k]) deletedKeys.add(k);
    }
    if (changedDocs.size === 0 && deletedKeys.size === 0) {
      return {
        unchanged: true, mode: "update", count: prev0.length, added: [], updated: [],
        deduped: 0, folded: 0, suggestions: [], changed: 0, deadlines: prev0,
        warning: null, coverage: [],
      };
    }
    scoped = true; // baseline exists → only rescan what moved
  }

  // corpus probe — PG is a FILTERED corpus (embeddable exts only, PDFs need
  // pdftotext, nothing chunked post-cutover until the embed key path works).
  // Unindexed documents make the tool loop read nothing; say so once, upfront.
  const probeCourses = scopeSlug ? [scopeSlug] : scoped ? [...changedDocs.keys()] : await courseListOf();
  const coverage: DocCoverage[] = [];
  const notes: string[] = [];
  for (const c of probeCourses) {
    try {
      const cov = (await getCourseDocsWithCoverage(c, owner)).coverage;
      if (!cov.total) continue; // no materials is a different message (tools say it)
      coverage.push(cov);
      if (cov.indexed === 0) {
        notes.push(`no indexed text for ${cov.course} (${cov.total} material document(s), 0 indexed) — the embed sweep has not run or nothing is chunked`);
      } else {
        const n = coverageNote(cov);
        if (n) notes.push(n);
      }
    } catch { /* no DB / unmigrated → the tools will report it themselves */ }
  }
  const warning = notes.length ? notes.join("; ") : null;
  if (warning) onEvent?.(`deadline warning: ${warning}`);

  const scopeText = scoped ? incrementalScopeText(changedDocs) : FULL_SCOPE_TEXT;
  const convo: ChatMsg[] = [
    { role: "system", content: deadlineSystemPrompt(scopeText, now) },
    { role: "user", content: deadlineUserPrompt(scoped, warning) },
  ];
  let raw = "";
  for (let step = 0; step < (scoped ? MAX_ROUNDS_SCOPED : MAX_ROUNDS_FULL); step++) {
    const msg = await callTools(convo, tools);
    if (msg.tool_calls?.length) {
      convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const result = await runTool(tc.function.name, tc.function.arguments ?? "{}");
        onEvent?.(`deadline tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
        convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, TOOL_RESULT_CAP) });
      }
      continue;
    }
    raw = msg.content;
    break;
  }
  // tolerate fences / stray prose around the array
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new DeadlineGenError(`model produced no JSON array: ${raw.slice(0, 120)}`);
  let items: unknown[];
  try { items = JSON.parse(m[0]) as unknown[]; } catch (e) {
    throw new DeadlineGenError(`JSON parse failed: ${String(e).slice(0, 120)}`);
  }
  if (!Array.isArray(items) || !items.length) throw new DeadlineGenError("empty deadline list");

  // normalize: real course slugs, valid-ish dates, stable ids;
  // done-ness carries over from the previous build (by course+title)
  const slugs = await courseListOf();
  const prev = prev0;
  const norm = items
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it): Dl => ({
      id: "", // filled by carry-over / dedupe below
      course: slugs.includes(String(it.course)) ? String(it.course) : String(it.course ?? ""),
      title: String(it.title ?? "(untitled)").slice(0, 140),
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(it.due ?? "")) ? String(it.due) : null,
      kind: ["assignment", "lab", "reading", "install", "signup", "post", "quiz", "exam", "other"].includes(String(it.kind)) ? String(it.kind) : "other",
      spread: Boolean(it.spread),
      startBy: /^\d{4}-\d{2}-\d{2}$/.test(String(it.startBy ?? "")) ? String(it.startBy) : null,
      note: String(it.note ?? "").slice(0, 160),
      source: String(it.source ?? "").slice(0, 160),
      confidence: ["high", "medium", "low"].includes(String(it.confidence)) ? String(it.confidence) : "medium",
      done: false,
      doneAt: null,
    }) satisfies Dl)
    .filter((it) => slugs.includes(it.course));

  // ── incremental split: prev entries sourced from CHANGED/DELETED docs are
  // up for re-extraction; everything else is kept verbatim
  const touchedKeys = new Set<string>(); // "course|basename"
  if (scoped) {
    for (const [c, docs] of changedDocs) for (const d of docs) touchedKeys.add(`${c}|${baseOf(d)}`);
    for (const k of deletedKeys) touchedKeys.add(`${k.split("/")[0]}|${baseOf(k)}`);
  }
  const isTouched = (p: Dl): boolean => p.source.split(";").some((s) => touchedKeys.has(`${p.course}|${baseOf(s.trim())}`)); // merged entries can carry "a.pdf; b.json"
  const kept = scoped ? prev.filter((p) => !isTouched(p)) : [];
  // ── carry-over: inherit id/done/userNote from the previous build's same
  // task (exact key first, then fuzzy) — id stability is what keeps
  // checklists attached across rebuilds. Scoped mode only matches against
  // touched entries (kept ones stay verbatim).
  const pool = (scoped ? prev.filter(isTouched) : prev).filter((p) => !RANGE.test(p.title));
  const updatedDates: { course: string; title: string; due: string | null; was: string | null }[] = [];
  for (const it of norm) {
    const exact = pool.find((p) => p.course === it.course && dlKey(p.course, p.title) === dlKey(it.course, it.title));
    if (exact) {
      it.id = exact.id; it.done = exact.done; it.doneAt = exact.doneAt;
      if (exact.userNote) it.userNote = exact.userNote;
      if (exact.dueManual) { it.due = exact.due; it.startBy = exact.startBy; it.dueManual = true; it.confidence = "high"; }
      else if (exact.due !== it.due) updatedDates.push({ course: it.course, title: it.title, due: it.due, was: exact.due });
      pool.splice(pool.indexOf(exact), 1);
      continue;
    }
    let bi = -1, bs = 0;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!;
      if (p.course !== it.course || p.kind !== it.kind) continue;
      const sameDue = p.due === it.due;
      // manual dates shouldn't block identity — the whole point of the
      // override is that it differs from what the documents say.
      // Same for a re-scan citing the SAME source file: same task,
      // new date = the document was edited (due date moved), not a
      // new task — otherwise every date change spawns a stale zombie.
      const srcsOf = (p: string): Set<string> => new Set(p.split(";").map((s) => baseOf(s.trim())).filter(Boolean));
      const sameSource = !!p.source && !!it.source && [...srcsOf(p.source)].some((s) => srcsOf(it.source).has(s));
      if (!sameDue && p.due && it.due && !p.dueManual && !sameSource) continue; // both dated, different days, different files → different tasks
      const sv = sim(p.title, it.title) * (sameDue ? 1 : 0.85);
      const need = sameDue ? 0.5 : 0.7;
      if (sv > bs && sv >= need && sameTask(p.title, it.title)) { bs = sv; bi = i; }
    }
    if (bi >= 0) {
      const p = pool.splice(bi, 1)[0]!;
      if (p.due !== it.due && !p.dueManual) updatedDates.push({ course: it.course, title: it.title, due: it.due, was: p.due });
      it.id = p.id; it.done = p.done; it.doneAt = p.doneAt;
      if (p.userNote) it.userNote = p.userNote;
      if (p.dueManual) { it.due = p.due; it.startBy = p.startBy; it.dueManual = true; it.confidence = "high"; }
    }
  }
  // fresh ids for anything unmatched — these are the NEW items
  const freshIds = new Set<string>();
  for (const it of norm) if (!it.id) { it.id = dlId(it.course, it.title); freshIds.add(it.id); }
  // ── dedupe within this build: same course + kind + due + similar
  // title from two sources → keep the first (higher in the model's list)
  for (let i = 0; i < norm.length; i++) {
    for (let j = norm.length - 1; j > i; j--) {
      const a = norm[i]!, b = norm[j]!;
      if (a.course === b.course && a.kind === b.kind && a.due === b.due && sameTask(a.title, b.title)) {
        if (!a.userNote && b.userNote) a.userNote = b.userNote; // never lose a note
        norm.splice(j, 1);
      }
    }
  }
  // ── incremental cross-dedupe: an extracted item that duplicates a
  // KEPT entry (same task, same day) loses to the kept one — its
  // id/done/notes/checklists are the stable identity
  if (scoped) {
    outer: for (let i = norm.length - 1; i >= 0; i--) {
      const a = norm[i]!;
      for (const k of kept) {
        if (a.course === k.course && a.kind === k.kind && a.due === k.due && sameTask(a.title, k.title)) { norm.splice(i, 1); continue outer; }
      }
    }
  }
  let merged: Dl[];
  if (scoped) {
    // touched entries the rescan no longer found: KEEP them (never
    // silently drop a deadline the student may know about) but flag
    // stale so the UI/chat can surface it
    const staleAt = Date.now();
    for (const p of pool) { p.stale = p.stale ?? staleAt; norm.push(p); }
    merged = [...kept, ...norm];
  } else {
    // full rebuild re-saw everything → stale flags are obsolete;
    // checked-off items the new build no longer finds still persist
    for (const it of norm) delete it.stale;
    for (const p of pool) if (p.done) norm.push(p);
    merged = norm;
  }
  merged.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.course.localeCompare(b.course));
  uniqIds(merged); // duplicate ids break by-id lookups + the UI's React keys
  // ── semantic dedup (LLM, deliberately conservative): same course +
  // kind + similar-title pairs the deterministic passes kept ONLY
  // because their dates disagree — ask the model whether they're
  // really one task. Merge only on same=true + confidence high. ──
  let semanticMerged = 0;
  const dupePairs: [Dl, Dl][] = [];
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length && dupePairs.length < 20; j++) {
      const a = merged[i]!, b = merged[j]!;
      if (a.course !== b.course || a.kind !== b.kind) continue;
      if (a.due === b.due) continue; // same-date dupes were already deduped deterministically
      if (sameTask(a.title, b.title)) dupePairs.push([a, b]);
    }
  }
  if (dupePairs.length) {
    try {
      const pairText = dupePairs
        .map(([a, b], i) => `PAIR ${i + 1}:\nA: ${JSON.stringify({ title: a.title, due: a.due, startBy: a.startBy, note: a.note, source: a.source, manual: !!a.dueManual })}\nB: ${JSON.stringify({ title: b.title, due: b.due, startBy: b.startBy, note: b.note, source: b.source, manual: !!b.dueManual })}`)
        .join("\n\n");
      const raw2 = await callTools([
        { role: "system", content: DEDUPE_SYSTEM_PROMPT },
        { role: "user", content: pairText },
      ]);
      const m2 = raw2.content.match(/\[[\s\S]*\]/);
      const verdicts: { pair: number; same: boolean; confidence: string; due?: string; startBy?: string; title?: string; note?: string }[] = m2 ? JSON.parse(m2[0]) : [];
      const removed = new Set<Dl>();
      for (const v of verdicts) {
        if (v.same !== true || v.confidence !== "high") continue; // conservative: only certain merges
        const pr = dupePairs[Number(v.pair) - 1];
        if (!pr || removed.has(pr[0]) || removed.has(pr[1])) continue;
        const [a, b] = pr; // keep a — its id keeps checklists/done attached
        if (!a.dueManual && !b.dueManual) {
          if (v.due === "B") a.due = b.due;
          else if (v.due === "none") a.due = null;
          if (v.startBy === "B") a.startBy = b.startBy;
          else if (v.startBy === "none") a.startBy = null;
        }
        if (v.title) a.title = String(v.title).slice(0, 140);
        if (v.note) a.note = String(v.note).slice(0, 160);
        if (!a.userNote && b.userNote) a.userNote = b.userNote;
        a.done = a.done || b.done;
        if (a.done && !a.doneAt) a.doneAt = b.doneAt;
        a.confidence = "high";
        // keep BOTH source names: incremental scans key off them
        a.source = [...new Set([...a.source.split(";"), ...b.source.split(";")].map((s) => s.trim()).filter(Boolean))].join("; ").slice(0, 200);
        removed.add(b);
        semanticMerged++;
      }
      if (removed.size) merged = merged.filter((d) => !removed.has(d));
      if (semanticMerged) onEvent?.(`deadlines dedup: merged ${semanticMerged} duplicate pair${semanticMerged === 1 ? "" : "s"} (semantic check)`);
    } catch (e) {
      onEvent?.(`deadlines dedup skipped: ${String(e).slice(0, 100)}`); // keep both — never block the rebuild
    }
  }
  // ── parent/child detection (LLM): sub-deliverables of a bigger
  // deadline. First detection only SUGGESTS (UI banner — user
  // accepts/declines once); accepted folds then re-apply on every
  // rebuild, because children re-extract from the docs each time. ──
  let foldedCount = 0;
  const newPending: FoldSug[] = [];
  try {
    const folds = await readFolds(owner);
    const PART_RE = /\b(part|phase|section|component|stage)\b/i;
    const nom: [Dl, Dl][] = [];
    for (let i = 0; i < merged.length && nom.length < 20; i++) {
      for (let j = i + 1; j < merged.length && nom.length < 20; j++) {
        const a = merged[i]!, b = merged[j]!;
        if (a.course !== b.course || a.kind !== b.kind) continue;
        if (!digitsOk(a.title, b.title)) continue; // shared number anchor (A1 ↔ Assignment 1)
        if (PART_RE.test(a.title) || PART_RE.test(b.title) || sim(a.title, b.title) >= 0.5) nom.push([a, b]);
      }
    }
    if (nom.length) {
      const raw3 = await callTools([
        { role: "system", content: FOLD_SYSTEM_PROMPT },
        { role: "user", content: nom.map(([a, b], i) => `PAIR ${i + 1}:\nA: ${JSON.stringify({ title: a.title, due: a.due, kind: a.kind, note: a.note })}\nB: ${JSON.stringify({ title: b.title, due: b.due, kind: b.kind, note: b.note })}`).join("\n\n") },
      ]);
      const m3 = raw3.content.match(/\[[\s\S]*\]/);
      const rels: { pair: number; relation: string; parent?: string; confidence?: string }[] = m3 ? JSON.parse(m3[0]) : [];
      const folded = new Set<Dl>();
      for (const r of rels) {
        if (r.relation !== "part-of" || r.confidence !== "high") continue;
        const pr = nom[Number(r.pair) - 1];
        if (!pr || folded.has(pr[0]) || folded.has(pr[1])) continue;
        let parent = r.parent === "B" ? pr[1] : pr[0];
        const child = r.parent === "B" ? pr[0] : pr[1];
        if (parent.id === child.id || parent.done || child.done) continue;
        const key = dlKey(child.course, child.title);
        const verdict = folds.verdicts[key];
        if (verdict?.v === "declined") continue;
        if (verdict?.v === "accepted") { // re-apply every rebuild…
          // …bound to the USER-chosen parent when one is recorded —
          // exact title key first, then fuzzy (titles drift)
          if (verdict.parent) {
            const chosen = merged.find((d) => d !== child && d.course === child.course && !d.done && dlKey(d.course, d.title) === verdict.parent)
              ?? (verdict.parentTitle ? merged.find((d) => d !== child && d.course === child.course && !d.done && sameTask(verdict.parentTitle!, d.title)) : undefined);
            if (!chosen) continue; // parent gone this build — child stays visible
            parent = chosen;
          }
          const det = await foldChildInto(parent, child, owner);
          if (!folds.folded[key]) folds.folded[key] = { child: { ...child }, parentId: parent.id, parentKey: dlKey(parent.course, parent.title), parentTitle: parent.title, addedItemIds: det.addedItemIds, enriched: det.enriched, partTitles: det.partTitles, at: Date.now() };
          folded.add(child);
          foldedCount++;
        } else if (!folds.pending.some((p) => p.childId === child.id) && !newPending.some((p) => p.childId === child.id)) {
          newPending.push({ parentId: parent.id, parentTitle: parent.title, childId: child.id, childTitle: child.title, childDue: child.due });
        }
      }
      if (folded.size) merged = merged.filter((d) => !folded.has(d));
      if (foldedCount) onEvent?.(`deadlines: re-applied ${foldedCount} accepted fold(s)`);
    }
    await writeFolds({ verdicts: folds.verdicts, pending: newPending, folded: folds.folded }, owner);
  } catch (e) {
    onEvent?.(`deadlines fold-detection skipped: ${String(e).slice(0, 100)}`);
  }
  const added = merged.filter((d) => freshIds.has(d.id)).map((d) => ({ course: d.course, title: d.title, due: d.due, kind: d.kind }));
  // heal orphaned checklists: entries whose deadlineId vanished get
  // fuzzy-reattached to the current entry of the same task
  try {
    const cks = await readCk(owner);
    const ids = new Set(merged.map((d) => d.id));
    let healed = 0;
    for (const c of cks) {
      if (ids.has(c.deadlineId)) continue;
      const t = merged.find((d) => d.course === c.course && dlKey(d.course, d.title) === dlKey(c.course, c.title))
        ?? merged.filter((d) => d.course === c.course && sameTask(c.title, d.title))
            .sort((x, y) => sim(y.title, c.title) - sim(x.title, c.title))[0];
      if (t) { c.deadlineId = t.id; healed++; }
    }
    if (healed) {
      await writeCk(cks, owner);
      onEvent?.(`checklists: re-attached ${healed} orphaned checklist(s) to renamed deadlines`);
    }
  } catch { /* no checklists yet */ }
  await writeDl(merged, owner);
  // manifest rewrite — a course-scoped run must not prune the other courses'
  // keys (`metaReplace` replaces the owner's whole manifest)
  const nextMeta = await snapshotDocsOf(owner, scopeSlug);
  if (scopeSlug) {
    for (const [k, v] of Object.entries(prevMeta.docs)) {
      const c = k.split("/")[0]!;
      if (c !== scopeSlug) nextMeta[k] = { ...v, course: c };
    }
  }
  await metaReplace(nextMeta, owner);
  const changedCount = [...changedDocs.values()].reduce((n, ds) => n + ds.length, 0) + deletedKeys.size;
  onEvent?.(scoped
    ? `deadlines updated: +${added.length} new, ${updatedDates.length} date(s) changed${semanticMerged ? `, ${semanticMerged} dup(s) merged` : ""}${foldedCount ? `, ${foldedCount} folded` : ""}${newPending.length ? `, ${newPending.length} fold suggestion(s)` : ""}, ${changedCount} changed doc(s) scanned — ${merged.length} item(s) total`
    : `deadlines rebuilt: ${merged.length} item(s)${semanticMerged ? `, ${semanticMerged} dup(s) merged` : ""}${foldedCount ? `, ${foldedCount} folded` : ""}${newPending.length ? `, ${newPending.length} fold suggestion(s)` : ""}`);
  return {
    unchanged: false,
    mode: scoped ? "update" : "full",
    count: merged.length,
    added,
    updated: updatedDates,
    deduped: semanticMerged,
    folded: foldedCount,
    suggestions: newPending,
    changed: changedCount,
    deadlines: merged,
    warning,
    coverage,
  };
}
