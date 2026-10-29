/** Bundleable PG tool surface for the platform generators (5b-2 c, D2 + B2).
 *
 *  WHY: `src/pipeline/tools.ts` is the chat tool surface the checklist / notes /
 *  deadline LLMs are prompt-tuned against, but it is UNBUNDLEABLE — it imports
 *  `node:fs`, `src/paths.ts`, `src/config.ts`, `pipeline/docindex.ts`
 *  (pdftoppm/pdftotext spawn) and `pipeline/materials.ts` (fs tree walk). The
 *  platform pod copies only `src/db/` into the frontend image
 *  (frontend/Dockerfile:9) and has neither a materials mount nor poppler (D3).
 *
 *  This module is the same tool surface backed by Postgres:
 *    - materials  → `documents` / `document_chunks` (via ./doc-source.ts)
 *    - deadlines  → `deadlines` / `deadline_folds`
 *    - checklists → `checklist_items` (live progress, same as the daemon)
 *    - sessions   → `sessions` / `session_artifacts` / `transcript_segments`
 *    - search     → `db/reader.ts` vectorSearch / keywordSearch (pgvector)
 *
 *  OUTPUT SHAPES ARE BYTE-FOR-BYTE COPIES of pipeline/tools.ts (`courseTool` /
 *  `execTool`), because the model was tuned on them — including the error
 *  strings. Each implementation notes its source line range.
 *
 *  PG-BACKED vs ERROR-STUBBED:
 *    PG-backed: list_courses, week_overview, list_deadlines, list_checklists,
 *               list_materials, read_document, list_sessions, read_notes,
 *               search_transcripts, read_conversation, semantic_search
 *    error-stub: view_page — a page IMAGE cannot exist in PG: `pageImage()`
 *               needs the .index/ raster bundle or poppler, neither of which
 *               the platform has (D3). It returns the exact same string the fs
 *               tool returns when it has no image.
 *
 *  Bundleable by construction: imports `../pg.ts`, `../owner.ts`,
 *  `../reader.ts`, `../state.ts`, `../embeddings.ts`, `../llm-keys.ts` and
 *  `./doc-source.ts` only — all under src/db, no fs, no drizzle, no
 *  src/status.ts, no module-level side effects.
 *
 *  OWNER SCOPING: every query runs as `owner ?? curOwner()`, matching
 *  doc-source.ts / db/deadlines.ts. Pass `owner` explicitly only for backfills
 *  and tests — inside a request ownerALS already carries the right user.
 */
import { getPool } from "../pg.ts";
import { curOwner } from "../owner.ts";
import { pgConfigured, vectorSearch, keywordSearch, type ChunkHit } from "../reader.ts";
import { embedQuery } from "../embeddings.ts";
import { resolveApiKey } from "../llm-keys.ts";
import { chatList } from "../state.ts";
import { getCourseDocs } from "./doc-source.ts";

// ── tool schemas (verbatim copy of pipeline/tools.ts:97-267) ───────────────
//
// The model is prompt-tuned to these exact descriptions/param docs, so this is
// a byte-for-byte copy, NOT a rewrite. The daemon path does not use it: the
// daemon injects pipeline/tools.ts `TOOL_DEFS` via ChecklistOpts.tools, so the
// recorder path cannot drift from these definitions — only the platform (which
// cannot import pipeline/*) falls back to this copy.

const COURSE_PARAM = {
  type: "string",
  description: "course slug — required in the all-courses chat, optional per-course",
};


export const TOOL_DEFS_PG = [
  {
    type: "function",
    function: {
      name: "list_courses",
      description: "List every course with its semester start, session count and material count. Use this first in the all-courses chat to plan which courses to inspect.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "week_overview",
      description: "One call for the whole week ACROSS ALL courses: per course, which sessions fall in that week (with artifacts) and which materials are tagged that week. Requires each course to have a semester start. Best first move for 'what do I have to do in week N'.",
      parameters: {
        type: "object",
        properties: { week: { type: "number", description: "1-based week of the semester" } },
        required: ["week"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_deadlines",
      description: "The student's AI-built deadline calendar (due dates + spread-out items across all courses). Read this before answering 'when is X due' / 'what should I do next'. Rebuilt from course files via the Courses page.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_checklists",
      description: "The student's per-task execution checklists with live step progress (which steps are already done) and their own context notes (e.g. group members and their roles). Read this before answering 'what's left on X' / 'where am I on X' / 'help me plan X'.",
      parameters: { type: "object", properties: { course: COURSE_PARAM }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_materials",
      description: "List the course material files (folder tree with week tags). Paths are relative to the materials root. Some entries show an available page count.",
      parameters: { type: "object", properties: { course: COURSE_PARAM }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Read the text of a material file. Pass a page number for one page, or omit it for the whole document (truncated if long). Supports PDF, DOCX, spreadsheets, and plain text / code / config files (.txt, .md, .csv, .json, .xml, .yml, .config, .cs, .csproj, .py, .sql, …).",
      parameters: {
        type: "object",
        properties: {
          course: COURSE_PARAM,
          path: { type: "string", description: "material path from list_materials" },
          page: { type: "number", description: "1-based page number (PDFs)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_page",
      description: "Look at a page image with a vision model — use when read_document returns little/no text (slides, diagrams, charts) or when the student asks about a figure/screenshot. Works for PDF and DOCX pages.",
      parameters: {
        type: "object",
        properties: { course: COURSE_PARAM, path: { type: "string" }, page: { type: "number" } },
        required: ["path", "page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List recorded class sessions for the course (date, display name if the student titled one, which artifacts exist: recording/transcript/notes/timeline).",
      parameters: { type: "object", properties: { course: COURSE_PARAM }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_notes",
      description: "Read session notes / running notes / transcript for a session. 'date' is the YYYY-MM-DD from list_sessions, or part of a session's display name.",
      parameters: {
        type: "object",
        properties: { course: COURSE_PARAM, date: { type: "string", description: "YYYY-MM-DD or (part of) the session name" }, kind: { type: "string", description: "notes | running | transcript (default notes)" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_transcripts",
      description: "Search session transcripts and timelines; returns matching snippets with dates. Semantic vector search when the DB index is available, else keyword substring match.",
      parameters: { type: "object", properties: { course: COURSE_PARAM, query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_conversation",
      description: "Read THIS chat's own stored history verbatim — every user and assistant message, oldest first, with message numbers. Use it whenever you're asked to quote, repeat, or list something said earlier in the conversation, and BEFORE EVER claiming you 'no longer have access' to earlier messages: the full history is stored and readable even when the CONTEXT WINDOW note says parts were omitted from your working context. The message you are currently answering may not be saved yet — everything before it is.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "number", description: "0-based message number to start from (for paging past a truncation)" },
          role: { type: "string", description: "filter: user | assistant" },
          needle: { type: "string", description: "only return messages whose text contains this (case-insensitive)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "semantic_search",
      description: "Semantic (meaning-based) search across ALL course materials, notes, transcripts and timelines via vector similarity. Finds content keyword search misses (different phrasing). Returns kind, course, file/session, page and up to ~1200 chars of source text with similarity score — enough for pinpoint facts; read_document/read_notes for synthesis, full sections or trimmed hits.",
      parameters: {
        type: "object",
        properties: {
          course: COURSE_PARAM,
          query: { type: "string", description: "search query — a phrase or question" },
          k: { type: "number", description: "max results (default 8)" },
        },
        required: ["query"],
      },
    },
  },
];

// ── shared render helpers (verbatim copies of pipeline/tools.ts:21-68) ─────

/** One search hit rendered for the model: kind + course + file/session +
 *  page + snippet + score (shared by search_transcripts / semantic_search). */
function chunkHitLines(hits: ChunkHit[]): string[] {
  return hits.map((h) => {
    const where = h.stem ? `session ${h.stem}` : h.rel_path;
    const loc = h.kind === "material" ? ` p${h.page}` : "";
    const trimmed = h.preview.length >= 1200 ? " [trimmed — chunk continues]" : "";
    return `- [${h.kind}] ${h.slug} · ${where}${loc} (score ${h.score.toFixed(2)}): …${h.preview.replace(/\s+/g, " ").trim()}…${trimmed}`;
  });
}

/** Near-duplicate removal for search hits — verbatim from pipeline/tools.ts:42-68
 *  (pure: no IO, so it is safe in the bundle). */
function dedupHits(hitsIn: ChunkHit[], k: number, query: string): ChunkHit[] {
  if (hitsIn.length <= k) return hitsIn;
  const q = query.toLowerCase().trim();
  const lit = (h: ChunkHit): boolean => q.length >= 4 && h.preview.toLowerCase().includes(q);
  const hits = q.length >= 4 ? [...hitsIn.filter(lit), ...hitsIn.filter((h) => !lit(h))] : hitsIn;
  const tokens = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const kept: ChunkHit[] = [];
  const union = new Set<string>();
  for (let i = 0; i < hits.length && kept.length < k; i++) {
    const h = hits[i]!;
    const immune = i < Math.min(3, k) || lit(h);
    if (!immune) {
      const toks = tokens(h.preview);
      if (toks.size > 0) {
        let covered = 0;
        for (const t of toks) if (union.has(t)) covered++;
        if (covered / toks.size >= 0.9) continue;
      }
    }
    kept.push(h);
    for (const t of tokens(h.preview)) union.add(t);
  }
  return kept;
}

/** "[m:ss]" timestamp render (pipeline/tools.ts:293). */
const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** transcript_segments → "[m:ss] text" markdown (pipeline/tools.ts:296-306). */
function timelineToMarkdown(
  segments: { offset_sec: number; transcript: string; visual_notes: Array<{ t: number | string; note: string }> | null }[],
): string {
  return segments
    .map((s) => {
      const txt = (s.transcript ?? "").trim();
      const vis = s.visual_notes ?? [];
      const visTxt = vis.length ? ` | visuals: ${vis.map((v) => v.note).join(" / ")}` : "";
      return `[${fmtSec(s.offset_sec)}] ${txt || "(no speech)"}${visTxt}`;
    })
    .join("\n");
}

// ── read-only queries ─────────────────────────────────────────────────────

const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

/** Course slugs (PG only — no fs union on the platform). */
async function courseSlugs(): Promise<string[]> {
  const { rows } = await q(`select slug from courses order by slug`);
  return rows.map((r: { slug: string }) => r.slug);
}

/** courses.semester_start equivalent of pipeline/materials.ts getCourseConfig(). */
async function semesterStart(slug: string): Promise<string | null> {
  const { rows } = await q(
    `select semester_start::text as start from courses where slug = $1`,
    [slug],
  );
  const raw = rows[0]?.start as string | null | undefined;
  return raw ? raw.slice(0, 10) : null;
}

/** SessionScan shape the model consumes (pipeline/tools.ts:277-285). */
interface SessionScan {
  stem: string;
  title?: string;
  recording?: string;
  notes?: string;
  running?: string;
  transcript?: string;
  timeline?: string;
}

/** Verbatim port of pipeline/tools.ts:337-370 (scanCourseSessionsDb). */
async function scanSessions(slug: string, owner: string): Promise<SessionScan[]> {
  const { rows } = await q(
    `select s.id as sid, s.stem, s.title,
            a.kind, a.rel_path,
            (select count(*)::int from transcript_segments ts where ts.session_id = s.id) as seg_count
     from sessions s
     join courses c on c.id = s.course_id
     left join session_artifacts a on a.session_id = s.id and a.deleted_at is null
     where c.slug = $1 and s.owner_user_id = $2
     order by s.session_date desc, s.start_time desc nulls last, s.id desc`,
    [slug, owner],
  );
  const map = new Map<number, SessionScan & { segCount: number }>();
  for (const r of rows as { sid: number; stem: string; title: string | null; kind: string | null; rel_path: string | null; seg_count: number | null }[]) {
    let e = map.get(r.sid);
    if (!e) {
      e = { stem: r.stem, segCount: r.seg_count ?? 0 };
      if (r.title) e.title = r.title;
      map.set(r.sid, e);
    }
    if (!r.kind || !r.rel_path) continue;
    const base = r.rel_path.split("/").pop() ?? r.rel_path;
    if (r.kind === "recording") e.recording = base;
    else if (r.kind === "notes") e.notes = base;
    else if (r.kind === "running_notes") e.running = base;
    else if (r.kind === "transcript") e.transcript = base;
    else if (r.kind === "timeline") e.timeline = base;
  }
  for (const e of map.values()) if (!e.timeline && e.segCount > 0) e.timeline = `${e.segCount} segments`;
  return [...map.values()].map(({ segCount: _segCount, ...rest }) => rest);
}

/** Verbatim port of pipeline/tools.ts:308-334 (readSessionContent). */
async function readSessionContent(
  slug: string,
  stem: string,
  kind: "notes" | "running" | "transcript" | "timeline",
): Promise<string | null> {
  if (kind === "timeline") {
    const { rows } = await q(
      `select ts.offset_sec, ts.transcript, ts.visual_notes
       from transcript_segments ts
       join sessions s on s.id = ts.session_id
       join courses c on c.id = s.course_id
       where c.slug = $1 and s.stem = $2
       order by ts.offset_sec asc`,
      [slug, stem],
    );
    return rows.length ? timelineToMarkdown(rows) : null;
  }
  const kindMap = { notes: "notes", running: "running_notes", transcript: "transcript" } as const;
  const { rows } = await q(
    `select a.content
     from session_artifacts a
     join sessions s on s.id = a.session_id
     join courses c on c.id = s.course_id
     where c.slug = $1 and s.stem = $2 and a.kind = $3 and a.deleted_at is null
     order by a.created_at desc
     limit 1`,
    [slug, stem, kindMap[kind]],
  );
  return (rows[0]?.content as string | null) ?? null;
}

/** Deadline row (pipeline/tools.ts:561-566). */
interface DeadlineRow {
  course: string; title: string; due: string | null; kind: string; spread: boolean;
  startBy: string | null; note: string; confidence: string; done: boolean;
  userNote?: string | null; stale?: number | string | null;
}

/** Verbatim SQL of pipeline/tools.ts:578-595 (readDeadlineRowsDb) — PG only,
 *  so the fs deadlines.json fallback is dropped. */
async function readDeadlineRows(slug: string | undefined, owner: string): Promise<DeadlineRow[]> {
  const { rows } = await q(
    `select c.slug as course, d.title, d.due::text as due, d.kind, d.spread,
            d.start_by::text as "startBy", d.note, d.confidence, d.done,
            d.user_note as "userNote", d.stale
     from deadlines d
     join courses c on c.id = d.course_id
     ${slug ? "where c.slug = $1 and d.owner_user_id = $2 and" : "where d.owner_user_id = $1 and"} not exists
       (select 1 from deadline_folds f where f.child_id = d.id and f.status = 'accepted')
     order by d.due asc nulls last, d.id`,
    slug ? [slug, owner] : [owner],
  );
  return rows as DeadlineRow[];
}

/** Verbatim port of pipeline/tools.ts:611-641 (checklistRows, PG branch). */
async function checklistRows(slug: string | undefined, owner: string): Promise<string> {
  const { rows } = await q(
    `select d.id, c.slug as course, d.title, d.due::text as due, d.user_note as "userNote",
            ci.text as item_text, ci.done as item_done, ci.manual as item_manual
     from checklist_items ci
     join deadlines d on d.id = ci.deadline_id
     join courses c on c.id = d.course_id
     where d.done = false and d.owner_user_id = $1 ${slug ? "and c.slug = $2" : ""}
     order by d.due asc nulls last, d.id, ci.position, ci.id`,
    slug ? [owner, slug] : [owner],
  );
  const byDl = new Map<number, { course: string; title: string; due: string | null; userNote: string | null; items: { text: string; done: boolean; manual: boolean }[] }>();
  for (const r of rows as { id: number; course: string; title: string; due: string | null; userNote: string | null; item_text: string; item_done: boolean; item_manual: boolean }[]) {
    let e = byDl.get(r.id);
    if (!e) { e = { course: r.course, title: r.title, due: r.due, userNote: r.userNote, items: [] }; byDl.set(r.id, e); }
    e.items.push({ text: r.item_text, done: r.item_done, manual: r.item_manual });
  }
  const out = [...byDl.values()].map((c) => {
    const prog = `${c.items.filter((i) => i.done).length}/${c.items.length}`;
    const steps = c.items.map((i) => `    ${i.done ? "[x]" : "[ ]"} ${i.text}${i.manual ? " (added by the student)" : ""}`).join("\n");
    return `- ${c.due ?? "no date"} — ${slug ? "" : `[${c.course}] `}${c.title} (${prog} steps done${c.userNote ? `; student note: ${c.userNote}` : ""}):\n${steps}`;
  });
  return out.length
    ? `Checklists (per-task step progress, checked off by the student — unchecked = still to do):\n${out.join("\n")}`
    : "no checklists built yet (build them from the Deadlines panel on the Courses page)";
}

// ── material text (document_chunks, NOT the .index/ bundle) ───────────────

/** Extension whitelist — copy of pipeline/docindex.ts:19-26 TEXTUAL/SHEETLY
 *  (`supportsIndex`, docindex.ts:41-44). Kept as data so the read_document
 *  error string ("… files aren't readable") stays identical. */
const TEXTUAL = new Set([".md", ".txt", ".csv", ".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".sql", ".xml", ".yml", ".yaml", ".log",
  ".config", ".cs", ".cshtml", ".razor", ".csproj", ".sln", ".props", ".targets", ".resx",
  ".ini", ".toml", ".env", ".sh", ".ps1", ".html", ".htm", ".css", ".java", ".cpp", ".cc", ".h", ".hpp", ".go", ".rs", ".rb", ".php"]);
const SHEETLY = new Set([".xlsx", ".xls"]);

const extOf = (rel: string): string => {
  const base = rel.split("/").pop() ?? rel;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
};

const supportsIndex = (rel: string): boolean => {
  const e = extOf(rel);
  return e === ".pdf" || e === ".docx" || SHEETLY.has(e) || TEXTUAL.has(e);
};

/** read_document whole-doc cap (docindex.ts:205 default `cap` = 48_000). */
const DOC_CAP = 48_000;
/** read_document single-page cap (docindex.ts:220). */
const PAGE_CAP = 13_000;

/** Page texts of one material, ordered (ingest-embed.ts:67-82: one page = one
 *  chunk, oversized pages split at ~6000 chars into chunk_index 0..n — so a
 *  page's text is its chunks joined in chunk_index order). Empty pages have no
 *  row (the fs .index/ bundle still writes an empty page-N.txt for them, which
 *  is the one unavoidable difference: PG pages are dense). */
async function docPages(slug: string, rel: string, owner: string): Promise<{ total: number; pages: Map<number, string> }> {
  const { rows } = await q(
    `select coalesce(d.page_count, 0) as page_count, c.page, c.content
       from documents d
       left join document_chunks c on c.document_id = d.id
      where d.course_id = (select id from courses where slug = $1)
        and d.kind = 'material'
        and d.rel_path = $2
        and d.owner_user_id = $3
      order by c.page, c.chunk_index`,
    [slug, rel, owner],
  );
  const pages = new Map<number, string[]>();
  let total = 0;
  for (const r of rows as { page_count: number; page: number | null; content: string | null }[]) {
    total = Math.max(total, Number(r.page_count ?? 0));
    if (r.page == null) continue;
    const p = Number(r.page);
    total = Math.max(total, p);
    const parts = pages.get(p) ?? [];
    parts.push(String(r.content ?? ""));
    pages.set(p, parts);
  }
  return { total, pages: new Map([...pages.entries()].map(([p, parts]) => [p, parts.filter(Boolean).join("\n\n")])) };
}

/** read_document over PG. Output shape is docindex.ts readDoc()'s:
 *  `(N page(s))\n` + either "--- page i/N ---\n<text>" blocks (whole doc,
 *  48k cap) or the single page's text (13k cap). Error strings are verbatim. */
async function readDocument(slug: string, rel: string, page: number | undefined, owner: string): Promise<string> {
  if (!supportsIndex(rel)) return `${rel}: ${extOf(rel) || "unknown"} files aren't readable`;
  const mats = await getCourseDocs(slug, owner);
  if (!mats.some((d) => d.rel_path === rel)) return `no such file: ${rel} — list_materials shows the exact paths`;
  const { total, pages } = await docPages(slug, rel, owner);
  if (!total) return `indexing failed for ${rel}`;
  if (page !== undefined) {
    if (page < 1 || page > total) return `page ${page} out of range (1-${total})`;
    const text = pages.get(page) ?? "";
    return `(${total} page(s))\n${text.slice(0, PAGE_CAP) || "(no extractable text — try view_page for the image)"}`;
  }
  let out = "";
  for (let i = 1; i <= total && out.length < DOC_CAP; i++) {
    out += `--- page ${i}/${total} ---\n${pages.get(i) ?? ""}\n`;
    if (out.length > DOC_CAP) out = out.slice(0, DOC_CAP) + "\n…(truncated — request specific pages)";
  }
  return `(${total} page(s))\n${out.trim() || "(no extractable text)"}`;
}

// ── per-course tools (pipeline/tools.ts:660-775, PG-backed) ───────────────

async function courseTool(
  name: string,
  args: Record<string, unknown>,
  slug: string,
  owner: string,
): Promise<string> {
  switch (name) {
    case "list_deadlines": {
      const dl = await readDeadlineRows(slug, owner);
      if (!dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
      const rows = dl
        .filter((d) => d.course === slug && !d.done)
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — ${d.title}${d.stale ? " [STALE — not seen in its source at the last update; verify before relying on it]" : ""} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.userNote ? ` — student note: ${d.userNote}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
      return rows.length ? `Open deadlines for this course (done items already checked off by the student):\n${rows.join("\n")}` : "all deadlines for this course are done (or none exist)";
    }
    case "list_checklists": return checklistRows(slug, owner);
    case "list_materials": {
      const mats = await getCourseDocs(slug, owner);
      if (!mats.length) return "no materials uploaded";
      return mats.map((m) => {
        const pages = Math.max(m.page_count ?? 0, 0);
        return `- ${m.rel_path}${m.week ? `  [week ${m.week}]` : ""}${supportsIndex(m.rel_path) ? (pages ? ` (${pages} pages indexed)` : " (readable)") : ""}`;
      }).join("\n");
    }
    case "read_document": {
      const rel = String(args.path ?? "");
      const raw = args.page !== undefined && args.page !== null ? Number(args.page) : undefined;
      return readDocument(slug, rel, raw !== undefined && Number.isFinite(raw) ? raw : undefined, owner);
    }
    case "view_page": {
      // NOT PG-BACKABLE: pageImage() needs the .index/ raster bundle (pdftoppm)
      // or poppler at runtime — neither exists on the platform (D3). Byte-for-byte
      // the fs tool's "no image" answers, so the model reacts exactly as before.
      const rel = String(args.path ?? "");
      const page = Number(args.page ?? 1);
      if (/\.(xlsx|xls)$/i.test(rel)) return `"${rel}" is a spreadsheet — no page images. Use read_document (page N = sheet N) to read its cells as CSV.`;
      return `no page image for ${rel} p${page} (PDFs/DOCXs only)`;
    }
    case "list_sessions": {
      const sess = await scanSessions(slug, owner);
      if (!sess.length) return "no recorded sessions";
      return sess.map((s) => {
        const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
        return `- ${s.stem}${s.title ? ` — “${s.title}”` : ""} (${what})`;
      }).join("\n");
    }
    case "read_notes": {
      const sess = await scanSessions(slug, owner);
      if (!sess.length) return "no sessions";
      const kind = String(args.kind ?? "notes") as "notes" | "running" | "transcript" | "timeline";
      const want = String(args.date ?? "");
      const hit = want
        ? sess.find((s) => s.stem.startsWith(want)) ?? sess.find((s) => s.title?.toLowerCase().includes(want.toLowerCase()))
        : sess[0]!;
      if (!hit) return `no ${kind} for ${want || "latest"}`;
      try {
        const content = await readSessionContent(slug, hit.stem, kind);
        if (content == null) return `no ${kind} for ${want || hit.stem} (available: notes=${!!hit.notes}, running=${!!hit.running}, transcript=${!!hit.transcript}, timeline=${!!hit.timeline})`;
        return content.slice(0, 20_000);
      } catch (e) { return `read_notes failed: ${String(e).slice(0, 150)}`; }
    }
    case "search_transcripts": {
      const query = String(args.query ?? "");
      const ql = query.toLowerCase();
      if (!ql) return "query required";
      try {
        const key = await resolveApiKey("GEMINI_API_KEY");
        if (key) {
          const embedding = await embedQuery(query, { apiKey: key });
          const hits = dedupHits(await vectorSearch({ owner, embedding, kind: "timeline", course: slug, k: 24 }), 8, query);
          if (hits.length) {
            return `Transcript/timeline matches for "${args.query}" (semantic, most similar first):\n${chunkHitLines(hits).join("\n")}`;
          }
        }
      } catch { /* DB/embedding hiccup — keyword below */ }
      try {
        const [tr, tl] = await Promise.all([
          keywordSearch({ owner, query, kind: "transcript", course: slug, k: 8 }),
          keywordSearch({ owner, query, kind: "timeline", course: slug, k: 8 }),
        ]);
        const hits = dedupHits([...tr, ...tl].sort((a, b) => b.score - a.score).slice(0, 24), 8, query);
        if (hits.length) return `Transcript/timeline matches for "${args.query}" (keyword, most relevant first):\n${chunkHitLines(hits).join("\n")}`;
      } catch { /* DB hiccup */ }
      return `no matches for "${args.query}"`;
    }
    default:
      return `unknown tool ${name}`;
  }
}

// ── the public entry point ────────────────────────────────────────────────

/** Run one LLM tool call against Postgres. Same contract as pipeline/tools.ts
 *  `execTool`: course from `args.course` (fallbackSlug second), unknown course
 *  rejected with the valid-slug list, and every failure rendered as a STRING
 *  (the model reads it) — this function only rejects on a broken pool. */
export async function runToolPg(
  toolName: string,
  args: Record<string, unknown>,
  owner?: string,
  fallbackSlug?: string,
): Promise<string> {
  const who = owner ?? curOwner();
  const slug = typeof args.course === "string" && args.course.trim() ? args.course.trim() : fallbackSlug;
  switch (toolName) {
    case "list_deadlines": {
      const dl = await readDeadlineRows(undefined, who);
      if (!dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
      const rows = dl
        .filter((d) => !d.done)
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — [${d.course}] ${d.title}${d.stale ? " [STALE — not seen in its source at the last update; verify before relying on it]" : ""} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.userNote ? ` — student note: ${d.userNote}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
      return rows.length ? `Open deadlines across all courses (done items already checked off by the student — don't re-suggest those):\n${rows.join("\n")}` : "no open deadlines — everything on the calendar is done";
    }
    case "list_checklists": return checklistRows(slug, who);
    case "list_courses": {
      const rows: string[] = [];
      for (const c of await courseSlugs()) {
        const start = await semesterStart(c);
        const n = (await scanSessions(c, who)).length;
        const m = (await getCourseDocs(c, who)).length;
        rows.push(`- ${c}${start ? ` — semester starts ${start}` : ""} [${n} session${n === 1 ? "" : "s"}, ${m} material${m === 1 ? "" : "s"}]`);
      }
      return rows.join("\n") || "no courses exist yet";
    }
    case "week_overview": {
      const week = Math.max(1, Math.round(Number(args.week ?? 1)));
      const blocks: string[] = [];
      for (const c of await courseSlugs()) {
        const start = await semesterStart(c);
        if (!start) {
          blocks.push(`### ${c}\n(no semester start set — weeks unknown; use list_sessions for dates)`);
          continue;
        }
        const mon = new Date(`${start}T00:00:00Z`);
        mon.setUTCDate(mon.getUTCDate() + (mon.getUTCDay() === 0 ? -6 : 1 - mon.getUTCDay()) + (week - 1) * 7);
        const from = mon.toISOString().slice(0, 10);
        const to = new Date(mon); to.setUTCDate(to.getUTCDate() + 6);
        const toStr = to.toISOString().slice(0, 10);
        const sess = (await scanSessions(c, who)).filter((s) => s.stem.slice(0, 10) >= from && s.stem.slice(0, 10) <= toStr);
        const mats = (await getCourseDocs(c, who)).filter((m) => m.week === week);
        const lines = [`### ${c} (${from} … ${toStr})`];
        lines.push(sess.length
          ? sess.map((s) => {
              const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
              return `- session ${s.stem}${s.title ? ` — “${s.title}”` : ""} (${what})`;
            }).join("\n")
          : "- no recorded session in this week");
        lines.push(mats.length
          ? mats.map((m) => `- material: ${m.rel_path}${supportsIndex(m.rel_path) ? " (readable via read_document)" : ""}`).join("\n")
          : "- no materials tagged for this week");
        blocks.push(lines.join("\n"));
      }
      return `Week ${week} across all courses:\n\n${blocks.join("\n\n")}`;
    }
    case "read_conversation": {
      try {
        const h = await chatList(slug ?? "global");
        if (h.length === 0) return "conversation history is empty (or no database configured)";
        const from = Math.max(0, Math.min(Number(args.from ?? 0) || 0, h.length - 1));
        const role = args.role === "user" || args.role === "assistant" ? String(args.role) : undefined;
        const needle = args.needle ? String(args.needle).toLowerCase() : undefined;
        let out = "";
        let lastShown = -1;
        let matched = 0;
        for (let i = from; i < h.length; i++) {
          const m = h[i]!;
          if (role && m.role !== role) continue;
          if (needle && !m.content.toLowerCase().includes(needle)) continue;
          matched++;
          const line = `[${i}] ${m.role}: ${m.content}\n`;
          if (out.length + line.length > 24_000) break;
          out += line;
          lastShown = i;
        }
        const flt = `${role ? `, filtered to role=${role}` : ""}${needle ? `, containing "${String(args.needle)}"` : ""}`;
        if (matched === 0) return `no messages match${flt} from message ${from} onward (history has ${h.length})`;
        const more = lastShown >= 0 && lastShown < h.length - 1
          ? `\n…truncated — call again with from=${lastShown + 1} to continue`
          : "";
        return `Conversation history, ${h.length} message(s) stored, oldest first (numbers are message indices${flt}):\n\n${out}${more}`;
      } catch (e) {
        return `read_conversation failed: ${String(e).slice(0, 120)}`;
      }
    }
    case "semantic_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return "query required";
      const k = Math.min(Math.max(Number(args.k ?? 8) || 8, 1), 20);
      const known = await courseSlugs();
      if (args.course != null && (!slug || !known.includes(slug))) {
        return slug ? `unknown course "${slug}" — valid: ${known.join(", ")}` : "no course given — pass the 'course' argument (see list_courses for exact slugs)";
      }
      if (!pgConfigured()) return "semantic search unavailable — Postgres not configured (DATABASE_URL/PGHOST unset); use read_document/search_transcripts instead";
      const key = await resolveApiKey("GEMINI_API_KEY");
      if (!key) return "semantic search unavailable — no Gemini API key (settings or GEMINI_API_KEY)";
      try {
        const embedding = await embedQuery(query, { apiKey: key });
        const hits = dedupHits(await vectorSearch({ owner: who, embedding, course: slug, k: Math.min(k * 3, 50) }), k, query);
        return hits.length
          ? `Semantic matches for "${query}" (kind · course · source · page, most similar first). Each hit includes up to ~1200 chars of source text — usually enough for pinpoint facts. For synthesis across sources, full sections, or hits marked [trimmed], still read_document/read_notes. CITE material hits inline as [[<full path from source>]] — the path shown includes its folders; cite it verbatim:
${chunkHitLines(hits).join("\n")}`
          : `no semantic matches for "${query}" — the embedding index may be empty; try search_transcripts (keyword) or list_materials`;
      } catch (e) { return `semantic search failed: ${String(e).slice(0, 150)}`; }
    }
    default: {
      if (!slug) return "no course given — pass the 'course' argument (see list_courses for exact slugs)";
      const known = await courseSlugs();
      if (!known.includes(slug)) return `unknown course "${slug}" — valid: ${known.join(", ")}`;
      return courseTool(toolName, args, slug, who);
    }
  }
}

/** Tool-call shaped variant — the exact semantics of pipeline/tools.ts:776-785
 *  `runTool`: parse `function.arguments` (bad JSON → {}), run, and render a
 *  thrown failure as `tool error: …` instead of propagating it. */
export async function runToolPgCall(
  call: { function: { name: string; arguments: string } },
  fallbackSlug?: string,
  owner?: string,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* model sent bad json */ }
  try {
    return await runToolPg(call.function.name, args, owner, fallbackSlug);
  } catch (e) {
    return `tool error: ${String(e).slice(0, 150)}`;
  }
}
