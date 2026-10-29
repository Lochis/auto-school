/**
 * Standard chat tools — the same five verbs for every course and every
 * document type. The model discovers materials (list_materials), reads text
 * (read_document), looks at figures (view_page → VLM), and reaches session
 * artifacts (list_sessions / read_notes / search_transcripts). Nothing here
 * knows course-specific structure; the document-bundle layout does the work.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOTES_DIR, RECORDINGS_DIR, DATA_DIR } from "../paths.ts";
import { config } from "../config.ts";
import { listMaterials, getCourseConfig } from "./materials.ts";
import { ensureIndex, indexedPages, pageImage, readDoc, supportsIndex } from "./docindex.ts";
import { vlmDescribe } from "./llm.ts";
import { pgConfigured, vectorSearch, keywordSearch, type ChunkHit } from "../db/reader.ts";
import { curOwner } from "../db/owner.ts";
import { embedQuery, geminiApiKey } from "../db/embeddings.ts";

/** One search hit rendered for the model: kind + course + file/session +
 *  page + snippet + score (shared by search_transcripts / semantic_search). */
function chunkHitLines(hits: ChunkHit[]): string[] {
  return hits.map((h) => {
    const where = h.stem ? `session ${h.stem}` : h.rel_path;
    const loc = h.kind === "material" ? ` p${h.page}` : "";
    // preview caps at 1200 chars (reader.ts) — hitting the cap means the chunk
    // continues; flag it so the model knows the text is partial, not whole
    const trimmed = h.preview.length >= 1200 ? " [trimmed — chunk continues]" : "";
    return `- [${h.kind}] ${h.slug} · ${where}${loc} (score ${h.score.toFixed(2)}): …${h.preview.replace(/\s+/g, " ").trim()}…${trimmed}`;
  });
}

/** Near-duplicate removal for search hits. Similarity search (HNSW, trgm)
 *  loves returning adjacent chunks of the same passage — near-identical text,
 *  wasted tokens, no new facts. Safe by construction:
 *  • callers over-fetch (3×k) so this trims a fatter list down to k DISTINCT
 *    hits — freed slots get recycled, never returned as fewer results
 *  • podium: the top 3 by score are immune — the strongest matches survive
 *  • exact-answer guard: any hit literally containing the query stays
 *  • drop criterion is containment, not sameness: a hit is dropped only when
 *    ≥90% of its tokens are already covered by KEPT hits — by definition it
 *    adds nothing the model isn't already seeing. */
function dedupHits(hitsIn: ChunkHit[], k: number, query: string): ChunkHit[] {
  if (hitsIn.length <= k) return hitsIn;
  // exact-answer hits lead — a literal match must never be starved by the
  // k-budget no matter where it ranked (stable: relative order otherwise kept)
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
        if (covered / toks.size >= 0.9) continue; // redundant with kept hits — recycle the slot
      }
    }
    kept.push(h);
    for (const t of tokens(h.preview)) union.add(t);
  }
  return kept;
}

/** Every known course (union of recordings/, notes/ and materials roots). */
export function allCourses(): string[] {
  const out = new Set<string>();
  for (const base of [RECORDINGS_DIR, NOTES_DIR, join(DATA_DIR, "courses")]) {
    try {
      for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) out.add(d.name);
    } catch { /* none */ }
  }
  return [...out].sort();
}

/** DB-aware course list for the async chat tools. `allCourses()` stays
 *  synchronous (daemon.ts request handlers call it directly and pg has no
 *  sync API), so the DB read lives here and is awaited in execTool/courseTool. */
async function resolveCourses(): Promise<string[]> {
  if (!pgConfigured()) return allCourses();
  try {
    const pool = await dbPool();
    const { rows } = await pool.query("select slug from courses order by slug");
    const slugs = rows.map((r: { slug: string }) => r.slug);
    // union the live recordings dir so a course on disk but not yet in the DB stays reachable
    return [...new Set([...slugs, ...allCourses()])].sort();
  } catch {
    return allCourses();
  }
}

const COURSE_PARAM = {
  type: "string",
  description: "course slug — required in the all-courses chat, optional per-course",
};

/** Firecrawl base URL (self-hosted by default; override via FIRECRAWL_BASE). */
const webBase = (): string | undefined => process.env.FIRECRAWL_BASE?.trim() || undefined;

const WEB_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web (titles, URLs, snippets). Use when the course materials don't cover the question (external background, API/library docs, current info). Always prefer course materials when they answer the question.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "search query" },
          limit: { type: "number", description: "max results (default 5, max 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_read",
      description: "Fetch one web page as markdown (after web_search, to read a promising result). Cite the source URL in your answer when you use web content.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL to read" } },
        required: ["url"],
      },
    },
  },
] as const;

export const TOOL_DEFS = [
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

/** All tools including web search (opt-in — the chat endpoints add these
 *  only when the request sets webSearch: true). */
export const TOOL_DEFS_WITH_WEB = [...TOOL_DEFS, ...WEB_TOOL_DEFS];

/** One session's artifact availability — the shape the model consumes today:
 *  `stem` (YYYY-MM-DD__slug), optional `title`, and one field per artifact
 *  (truthy value = present). DB mode sets each field to the artifact's
 *  rel_path basename; fs mode sets it to the filename, as before. */
export interface SessionScan {
  stem: string;
  title?: string;
  recording?: string;
  notes?: string;
  running?: string;
  transcript?: string;
  timeline?: string;
}

async function dbPool() {
  const { getPool } = await import("../db/client.ts");
  return getPool();
}

/** "[m:ss]" timestamp render — same convention as notes.ts / segment.ts. */
const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Render transcript_segments to the "[m:ss] text" markdown the model reads. */
function timelineToMarkdown(segments: { offset_sec: number; transcript: string; visual_notes: Array<{ t: number | string; note: string }> | null }[]): string {
  return segments
    .map((s) => {
      const txt = (s.transcript ?? "").trim();
      const vis = s.visual_notes ?? [];
      const visTxt = vis.length ? ` | visuals: ${vis.map((v) => v.note).join(" / ")}` : "";
      return `[${fmtSec(s.offset_sec)}] ${txt || "(no speech)"}${visTxt}`;
    })
    .join("\n");
}

/** DB read of one session's artifact/timeline content (Phase 4 read path). */
async function readSessionContent(slug: string, stem: string, kind: "notes" | "running" | "transcript" | "timeline"): Promise<string | null> {
  const pool = await dbPool();
  if (kind === "timeline") {
    const { rows } = await pool.query(
      `select ts.offset_sec, ts.transcript, ts.visual_notes
       from transcript_segments ts
       join sessions s on s.id = ts.session_id
       join courses c on c.id = s.course_id
       where c.slug = $1 and s.stem = $2
       order by ts.offset_sec asc`,
      [slug, stem]);
    return rows.length ? timelineToMarkdown(rows) : null;
  }
  const kindMap = { notes: "notes", running: "running_notes", transcript: "transcript" } as const;
  const { rows } = await pool.query(
    `select a.content
     from session_artifacts a
     join sessions s on s.id = a.session_id
     join courses c on c.id = s.course_id
     where c.slug = $1 and s.stem = $2 and a.kind = $3 and a.deleted_at is null
     order by a.created_at desc
     limit 1`,
    [slug, stem, kindMap[kind]]);
  return (rows[0]?.content as string | null) ?? null;
}

/** Phase-4 DB scan: sessions + session_artifacts + transcript_segments → the
 *  same { stem, title?, recording?, notes?, running?, transcript?, timeline? }
 *  list the fs scanner returned. */
async function scanCourseSessionsDb(slug: string): Promise<SessionScan[]> {
  const pool = await dbPool();
  const { rows } = await pool.query(
    `select s.id as sid, s.stem, s.title,
            a.kind, a.rel_path,
            (select count(*)::int from transcript_segments ts where ts.session_id = s.id) as seg_count
     from sessions s
     join courses c on c.id = s.course_id
     left join session_artifacts a on a.session_id = s.id and a.deleted_at is null
     where c.slug = $1 and s.owner_user_id = $2
     order by s.session_date desc, s.start_time desc nulls last, s.id desc`,
    [slug, curOwner()]);
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
  for (const e of map.values()) {
    if (!e.timeline && e.segCount > 0) e.timeline = `${e.segCount} segments`;
  }
  return [...map.values()].map(({ segCount: _segCount, ...rest }) => rest);
}

/** fs scanner (unchanged from pre-migration) — used when Postgres is absent. */
function scanCourseSessionsFs(slug: string): SessionScan[] {
  const out = new Map<string, SessionScan>();
  const add = (stem: string, patch: Partial<{ title: string; recording: string; notes: string; running: string; transcript: string; timeline: string }>) => {
    const s = out.get(stem) ?? { stem };
    out.set(stem, { ...s, ...patch });
  };
  try {
    for (const f of readdirSync(join(RECORDINGS_DIR, slug))) {
      if (/\.(mp4|webm)$/.test(f)) add(f.replace(/\.(mp4|webm)$/, ""), { recording: f });
    }
  } catch { /* none */ }
  try {
    for (const f of readdirSync(join(NOTES_DIR, slug))) {
      const m = f.match(/^(.+)__(notes|running|transcript|timeline)\.(md|json)$/);
      if (m) add(m[1]!, { ...(m[2] === "notes" ? { notes: f } : m[2] === "running" ? { running: f } : m[2] === "transcript" ? { transcript: f } : { timeline: f }) });
      // user-given display name (ingest "Title" field) — chat matches on it
      if (f.endsWith("__title.txt")) {
        try {
          const t = readFileSync(join(NOTES_DIR, slug, f), "utf8").trim();
          if (t) add(f.replace(/__title\.txt$/, ""), { title: t });
        } catch { /* unreadable */ }
      }
    }
  } catch { /* none */ }
  return [...out.values()].sort((a, b) => b.stem.localeCompare(a.stem));
}

/** Scan the notes + recordings dirs — now backed by Postgres when configured
 *  (NOT sessions.json — the journal only tracks recordings, and pruned/failed
 *  sessions would vanish from chat). */
export async function scanCourseSessions(slug: string): Promise<SessionScan[]> {
  if (!pgConfigured()) return scanCourseSessionsFs(slug);
  try {
    return await scanCourseSessionsDb(slug);
  } catch {
    return scanCourseSessionsFs(slug); // DB hiccup → whatever fs still has
  }
}

export async function execTool(name: string, args: Record<string, unknown>, fallbackSlug?: string): Promise<string> {
  // course scoping: explicit tool arg wins, else the chat's own course
  // (all-courses chat passes none — the model must name the course)
  const slug = typeof args.course === "string" && args.course.trim() ? args.course.trim() : fallbackSlug;
  switch (name) {
    case "web_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return "query required";
      const base = webBase();
      if (!base) return "web search disabled — FIRECRAWL_BASE not set";
      try {
        const res = await fetch(`${base}/v2/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FIRECRAWL_KEY ?? "selfhosted"}` },
          body: JSON.stringify({ query, limit: Math.min(Number(args.limit ?? 5) || 5, 8) }),
        });
        if (!res.ok) return `web_search ${res.status}: ${(await res.text()).slice(0, 120)}`;
        const j = (await res.json()) as { data?: { web?: { url: string; title: string; description: string }[] } };
        const hits = j.data?.web ?? [];
        if (!hits.length) return `no web results for "${query}"`;
        return hits.map((h) => `- ${h.title}\n  ${h.url}\n  ${h.description?.slice(0, 200) ?? ""}`).join("\n");
      } catch (e) { return `web_search failed: ${String(e).slice(0, 120)}`; }
    }
    case "web_read": {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) return "url required (http/https)";
      const base = webBase();
      if (!base) return "web read disabled — FIRECRAWL_BASE not set";
      try {
        const res = await fetch(`${base}/v2/scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FIRECRAWL_KEY ?? "selfhosted"}` },
          body: JSON.stringify({ url, formats: ["markdown"] }),
        });
        if (!res.ok) return `web_read ${res.status}: ${(await res.text()).slice(0, 120)}`;
        const j = (await res.json()) as { data?: { markdown?: string } };
        const md = (j.data?.markdown ?? "").trim();
        if (!md) return `no readable content at ${url}`;
        return md.length > 20_000 ? md.slice(0, 20_000) + "\n…(truncated)" : md;
      } catch (e) { return `web_read failed: ${String(e).slice(0, 120)}`; }
    }
    case "list_deadlines": {
      const dl = await readDeadlineRows();
      if (!dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
      const rows = dl
        .filter((d) => !d.done)
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — [${d.course}] ${d.title}${d.stale ? " [STALE — not seen in its source at the last update; verify before relying on it]" : ""} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.userNote ? ` — student note: ${d.userNote}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
      return rows.length ? `Open deadlines across all courses (done items already checked off by the student — don't re-suggest those):\n${rows.join("\n")}` : "no open deadlines — everything on the calendar is done";
    }
    case "list_checklists": return checklistRows(slug || undefined);
    case "list_courses": {
      const rows: string[] = [];
      for (const c of await resolveCourses()) {
        const cfg = getCourseConfig(c);
        const n = (await scanCourseSessions(c)).length;
        const m = (await listMaterials(c)).length;
        rows.push(`- ${c}${cfg?.semesterStart ? ` — semester starts ${cfg.semesterStart}` : ""} [${n} session${n === 1 ? "" : "s"}, ${m} material${m === 1 ? "" : "s"}]`);
      }
      return rows.join("\n") || "no courses exist yet";
    }
    case "week_overview": {
      const week = Math.max(1, Math.round(Number(args.week ?? 1)));
      const blocks: string[] = [];
      for (const c of await resolveCourses()) {
        const cfg = getCourseConfig(c);
        const start = cfg?.semesterStart;
        if (!start) {
          blocks.push(`### ${c}\n(no semester start set — weeks unknown; use list_sessions for dates)`);
          continue;
        }
        // week N = Monday of semester start + (N-1)*7 … +6d
        const mon = new Date(`${start}T00:00:00Z`);
        mon.setUTCDate(mon.getUTCDate() + (mon.getUTCDay() === 0 ? -6 : 1 - mon.getUTCDay()) + (week - 1) * 7);
        const from = mon.toISOString().slice(0, 10);
        const to = new Date(mon); to.setUTCDate(to.getUTCDate() + 6);
        const toStr = to.toISOString().slice(0, 10);
        const sess = (await scanCourseSessions(c)).filter((s) => s.stem.slice(0, 10) >= from && s.stem.slice(0, 10) <= toStr);
        const mats = (await listMaterials(c)).filter((m) => m.week === week);
        const lines = [`### ${c} (${from} … ${toStr})`];
        lines.push(sess.length
          ? sess.map((s) => {
              const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
              return `- session ${s.stem}${s.title ? ` — “${s.title}”` : ""} (${what})`;
            }).join("\n")
          : "- no recorded session in this week");
        lines.push(mats.length
          ? mats.map((m) => `- material: ${m.path}${supportsIndex(m.path) ? " (readable via read_document)" : ""}`).join("\n")
          : "- no materials tagged for this week");
        blocks.push(lines.join("\n"));
      }
      return `Week ${week} across all courses:\n\n${blocks.join("\n\n")}`;
    }
    case "read_conversation": {
      // this chat's own stored history, verbatim — the mechanical cure for
      // context-anchoring: the model can pull what it actually said/was told
      // instead of trusting its self-summarized claims about what it can see
      try {
        const { chatList } = await import("../db/state.ts");
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
      // optional course scoping validated like the course-scoped tools
      const known = await resolveCourses();
      if (args.course != null && (!slug || !known.includes(slug))) {
        return slug ? `unknown course "${slug}" — valid: ${known.join(", ")}` : "no course given — pass the 'course' argument (see list_courses for exact slugs)";
      }
      if (!pgConfigured()) return "semantic search unavailable — Postgres not configured (DATABASE_URL/PGHOST unset); use read_document/search_transcripts instead";
      const key = geminiApiKey();
      if (!key) return "semantic search unavailable — no Gemini API key (settings or GEMINI_API_KEY)";
      try {
        const embedding = await embedQuery(query, { apiKey: key });
        const hits = dedupHits(await vectorSearch({ owner: curOwner(), embedding, course: slug, k: Math.min(k * 3, 50) }), k, query);
        return hits.length
          ? `Semantic matches for "${query}" (kind · course · source · page, most similar first). Each hit includes up to ~1200 chars of source text — usually enough for pinpoint facts. For synthesis across sources, full sections, or hits marked [trimmed], still read_document/read_notes. CITE material hits inline as [[<full path from source>]] — the path shown includes its folders; cite it verbatim:
${chunkHitLines(hits).join("\n")}`
          : `no semantic matches for "${query}" — the embedding index may be empty; try search_transcripts (keyword) or list_materials`;
      } catch (e) { return `semantic search failed: ${String(e).slice(0, 150)}`; }
    }
    default:
      // ── course-scoped tools ──
      if (!slug) return "no course given — pass the 'course' argument (see list_courses for exact slugs)";
      const known = await resolveCourses();
      if (!known.includes(slug)) return `unknown course "${slug}" — valid: ${known.join(", ")}`;
      return courseTool(name, args, slug);
  }
}

/** Course-scoped tools — execTool validated the slug. */
/** Unified deadline row — mirrors the legacy fs deadlines.json entry shape so the
 *  PG and fs paths feed the same renderer (model-visible output is identical). */
interface DeadlineRow {
  course: string; title: string; due: string | null; kind: string; spread: boolean;
  startBy: string | null; note: string; confidence: string; done: boolean;
  userNote?: string | null; stale?: number | string | null;
}

/** Live deadlines from Postgres; null ⇒ caller falls back to the fs reader. */
async function readDeadlineRowsDb(slug?: string): Promise<DeadlineRow[] | null> {
  try {
    const pool = await dbPool();
    const { rows } = await pool.query(
      `select c.slug as course, d.title, d.due::text as due, d.kind, d.spread,
              d.start_by::text as "startBy", d.note, d.confidence, d.done,
              d.user_note as "userNote", d.stale
       from deadlines d
       join courses c on c.id = d.course_id
       ${slug ? "where c.slug = $1 and d.owner_user_id = $2 and" : "where d.owner_user_id = $1 and"} not exists
         (select 1 from deadline_folds f where f.child_id = d.id and f.status = 'accepted')
       order by d.due asc nulls last, d.id`,
      slug ? [slug, curOwner()] : [curOwner()]);
    return rows as DeadlineRow[];
  } catch { return null; }
}

/** Deadline rows: Postgres first (daemon's source of truth since the PG
 *  migration), legacy user-data/deadlines.json only when PG is absent/fails. */
async function readDeadlineRows(slug?: string): Promise<DeadlineRow[]> {
  if (pgConfigured()) {
    const db = await readDeadlineRowsDb(slug);
    if (db) return db;
  }
  try {
    const dl = JSON.parse(readFileSync(join(config.userDataDir, "deadlines.json"), "utf8")) as DeadlineRow[];
    return Array.isArray(dl) ? dl : [];
  } catch { return []; }
}

/** Checklist listing shared by both scopes: per-task steps with live progress
 *  + the student's own context note (group members, roles, …). Postgres first
 *  (checklist_items is the live state), fs checklists.json as fallback. */
async function checklistRows(slug?: string): Promise<string> {
  if (pgConfigured()) {
    try {
      const pool = await dbPool();
      const { rows } = await pool.query(
        `select d.id, c.slug as course, d.title, d.due::text as due, d.user_note as "userNote",
                ci.text as item_text, ci.done as item_done, ci.manual as item_manual
         from checklist_items ci
         join deadlines d on d.id = ci.deadline_id
         join courses c on c.id = d.course_id
         where d.done = false and d.owner_user_id = $1 ${slug ? "and c.slug = $2" : ""}
         order by d.due asc nulls last, d.id, ci.position, ci.id`,
        slug ? [curOwner(), slug] : [curOwner()]);
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
    } catch { /* PG hiccup — fs fallback below */ }
  }
  try {
    const dl = JSON.parse(readFileSync(join(config.userDataDir, "deadlines.json"), "utf8")) as { id: string; course: string; title: string; due: string | null; kind: string; done: boolean; userNote?: string }[];
    const cks = JSON.parse(readFileSync(join(config.userDataDir, "checklists.json"), "utf8")) as { deadlineId: string; course: string; title: string; items: { text: string; done: boolean; manual?: boolean }[]; updatedAt: number }[];
    const byId = new Map(dl.map((d) => [d.id, d]));
    const rows = cks
      .filter((c) => (!slug || c.course === slug) && !byId.get(c.deadlineId)?.done)
      .map((c) => {
        const d = byId.get(c.deadlineId);
        const prog = `${c.items.filter((i) => i.done).length}/${c.items.length}`;
        const steps = c.items.map((i) => `    ${i.done ? "[x]" : "[ ]"} ${i.text}${i.manual ? " (added by the student)" : ""}`).join("\n");
        return `- ${d?.due ?? "no date"} — ${slug ? "" : `[${c.course}] `}${c.title} (${prog} steps done${d?.userNote ? `; student note: ${d.userNote}` : ""}):\n${steps}`;
      });
    return rows.length
      ? `Checklists (per-task step progress, checked off by the student — unchecked = still to do):\n${rows.join("\n")}`
      : "no checklists built yet (build them from the Deadlines panel on the Courses page)";
  } catch {
    return "no checklists built yet (build them from the Deadlines panel on the Courses page)";
  }
}

async function courseTool(name: string, args: Record<string, unknown>, slug: string): Promise<string> {
  switch (name) {
    case "list_deadlines": {
      const dl = await readDeadlineRows(slug);
      if (!dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
      const rows = dl
        .filter((d) => d.course === slug && !d.done)
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — ${d.title}${d.stale ? " [STALE — not seen in its source at the last update; verify before relying on it]" : ""} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.userNote ? ` — student note: ${d.userNote}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
      return rows.length ? `Open deadlines for this course (done items already checked off by the student):\n${rows.join("\n")}` : "all deadlines for this course are done (or none exist)";
    }
    case "list_checklists": return checklistRows(slug || undefined);
    case "list_materials": {
      const mats = await listMaterials(slug);
      if (!mats.length) return "no materials uploaded";
      return mats.map((m) => {
        const pages = indexedPages(slug, m.path);
        return `- ${m.path}${m.week ? `  [week ${m.week}]` : ""}${supportsIndex(m.path) ? (pages ? ` (${pages} pages indexed)` : " (readable)") : ""}`;
      }).join("\n");
    }
    case "read_document": {
      const rel = String(args.path ?? "");
      const page = args.page !== undefined && args.page !== null ? Number(args.page) : undefined;
      const r = await readDoc(slug, rel, Number.isFinite(page) ? page : undefined);
      return "error" in r ? r.error : `(${r.pages} page(s))\n${r.text}`;
    }
    case "view_page": {
      const rel = String(args.path ?? "");
      const page = Number(args.page ?? 1);
      const img = await pageImage(slug, rel, page);
      if (!img) {
        if (/\.(xlsx|xls)$/i.test(rel)) return `"${rel}" is a spreadsheet — no page images. Use read_document (page N = sheet N) to read its cells as CSV.`;
        return `no page image for ${rel} p${page} (PDFs/DOCXs only)`;
      }
      const b64 = readFileSync(img).toString("base64");
      return await vlmDescribe(
        "Describe this page of a course document precisely and completely: text content, diagrams, charts (read values), tables, and any formulas. Structure the answer as markdown.",
        b64,
      );
    }
    case "list_sessions": {
      const sess = await scanCourseSessions(slug);
      if (!sess.length) return "no recorded sessions";
      return sess.map((s) => {
        const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
        return `- ${s.stem}${s.title ? ` — “${s.title}”` : ""} (${what})`;
      }).join("\n");
    }
    case "read_notes": {
      const sess = await scanCourseSessions(slug);
      if (!sess.length) return "no sessions";
      const kind = String(args.kind ?? "notes") as "notes" | "running" | "transcript" | "timeline";
      const want = String(args.date ?? "");
      // stem-date match first; else a display-name match ("the git workshop")
      const hit = want
        ? sess.find((s) => s.stem.startsWith(want)) ?? sess.find((s) => s.title?.toLowerCase().includes(want.toLowerCase()))
        : sess[0]!;
      if (!pgConfigured()) {
        const file = hit && (kind === "running" ? hit.running : kind === "transcript" ? hit.transcript : hit.notes);
        if (!file) return `no ${kind} for ${want || hit?.stem || "latest"} (available: notes=${!!hit?.notes}, running=${!!hit?.running}, transcript=${!!hit?.transcript})`;
        return readFileSync(join(NOTES_DIR, slug, file), "utf8").slice(0, 20_000);
      }
      if (!hit) return `no ${kind} for ${want || "latest"}`;
      try {
        const content = await readSessionContent(slug, hit.stem, kind);
        if (content == null) return `no ${kind} for ${want || hit.stem} (available: notes=${!!hit.notes}, running=${!!hit.running}, transcript=${!!hit.transcript}, timeline=${!!hit.timeline})`;
        return content.slice(0, 20_000);
      } catch (e) { return `read_notes failed: ${String(e).slice(0, 150)}`; }
    }
    case "search_transcripts": {
      const q = String(args.query ?? "").toLowerCase();
      if (!q) return "query required";
      if (pgConfigured()) {
        // semantic path: pgvector over timeline chunks — then a DB keyword
        // fallback (the fs transcripts/timelines are gone in Phase 4)
        try {
          const key = geminiApiKey();
          if (key) {
            const embedding = await embedQuery(String(args.query ?? ""), { apiKey: key });
            const hits = dedupHits(await vectorSearch({ owner: curOwner(), embedding, kind: "timeline", course: slug, k: 24 }), 8, String(args.query ?? ""));
            if (hits.length) {
              return `Transcript/timeline matches for "${args.query}" (semantic, most similar first):
${chunkHitLines(hits).join("\n")}`;
            }
          }
        } catch { /* DB/embedding hiccup — keyword below */ }
        try {
          const query = String(args.query ?? "");
          const [tr, tl] = await Promise.all([
            keywordSearch({ owner: curOwner(), query, kind: "transcript", course: slug, k: 8 }),
            keywordSearch({ owner: curOwner(), query, kind: "timeline", course: slug, k: 8 }),
          ]);
          const hits = dedupHits([...tr, ...tl].sort((a, b) => b.score - a.score).slice(0, 24), 8, query);
          if (hits.length) return `Transcript/timeline matches for "${args.query}" (keyword, most relevant first):\n${chunkHitLines(hits).join("\n")}`;
        } catch { /* DB hiccup */ }
        return `no matches for "${args.query}"`;
      }
      const hits: string[] = [];
      for (const s of await scanCourseSessions(slug)) {
        for (const f of [s.transcript, s.timeline].filter(Boolean) as string[]) {
          try {
            const txt = readFileSync(join(NOTES_DIR, slug, f), "utf8");
            if (txt.toLowerCase().includes(q)) {
              const idx = txt.toLowerCase().indexOf(q);
              hits.push(`- ${s.stem}${s.title ? ` — “${s.title}”` : ""} (${f.endsWith(".json") ? "timeline" : "transcript"}): …${txt.slice(Math.max(0, idx - 150), idx + 350).replace(/\s+/g, " ")}…`);
            }
          } catch { /* gone */ }
        }
      }
      return hits.length ? hits.slice(0, 8).join("\n") : `no matches for "${q}"`;
    }
    default:
      return `unknown tool ${name}`;
  }
}

export async function runTool(call: { id: string; function: { name: string; arguments: string } }, slug?: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* model sent bad json */ }
  // strip the course arg — execTool consumes it via args
  try {
    return await execTool(call.function.name, args, slug);
  } catch (e) {
    return `tool error: ${String(e).slice(0, 150)}`;
  }
}

export const ensureIndexForChat = ensureIndex; // re-export keeps daemon imports tidy
