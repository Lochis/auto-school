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

const COURSE_PARAM = {
  type: "string",
  description: "course slug — required in the all-courses chat, optional per-course",
};

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
      name: "list_materials",
      description: "List the course material files (folder tree with week tags). Paths are relative to the materials root. Some entries show an available page count.",
      parameters: { type: "object", properties: { course: COURSE_PARAM }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Read the text of a material file. Pass a page number for one page, or omit it for the whole document (truncated if long). PDF/DOCX/text supported.",
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
      description: "List recorded class sessions for the course (date, which artifacts exist: recording/transcript/notes/timeline).",
      parameters: { type: "object", properties: { course: COURSE_PARAM }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_notes",
      description: "Read session notes / running notes / transcript for a session date. Omit date for the most recent session.",
      parameters: {
        type: "object",
        properties: { course: COURSE_PARAM, date: { type: "string", description: "YYYY-MM-DD from list_sessions" }, kind: { type: "string", description: "notes | running | transcript (default notes)" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_transcripts",
      description: "Keyword-search session transcripts and timelines; returns matching snippets with dates.",
      parameters: { type: "object", properties: { course: COURSE_PARAM, query: { type: "string" } }, required: ["query"] },
    },
  },
];

/** Scan the notes + recordings dirs (NOT sessions.json — the journal only
 *  tracks recordings, and pruned/failed sessions would vanish from chat). */
export function scanCourseSessions(slug: string): { stem: string; recording?: string; notes?: string; running?: string; transcript?: string; timeline?: string }[] {
  const out = new Map<string, { stem: string; recording?: string; notes?: string; running?: string; transcript?: string; timeline?: string }>();
  const add = (stem: string, patch: Partial<{ recording: string; notes: string; running: string; transcript: string; timeline: string }>) => {
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
    }
  } catch { /* none */ }
  return [...out.values()].sort((a, b) => b.stem.localeCompare(a.stem));
}

async function execTool(name: string, args: Record<string, unknown>, fallbackSlug?: string): Promise<string> {
  // course scoping: explicit tool arg wins, else the chat's own course
  // (all-courses chat passes none — the model must name the course)
  const slug = typeof args.course === "string" && args.course.trim() ? args.course.trim() : fallbackSlug;
  switch (name) {
    case "list_deadlines": {
      try {
        const dl = JSON.parse(readFileSync(join(config.userDataDir, "deadlines.json"), "utf8")) as { course: string; title: string; due: string | null; kind: string; spread: boolean; startBy: string | null; note: string; confidence: string; done: boolean }[];
        if (!Array.isArray(dl) || !dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
        const rows = dl
          .filter((d) => !d.done)
          .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
          .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — [${d.course}] ${d.title} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
        return rows.length ? `Open deadlines across all courses (done items already checked off by the student — don't re-suggest those):\n${rows.join("\n")}` : "no open deadlines — everything on the calendar is done";
      } catch { return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)"; }
    }
    case "list_courses": {
      return allCourses().map((c) => {
        const cfg = getCourseConfig(c);
        const n = scanCourseSessions(c).length;
        const m = listMaterials(c).length;
        return `- ${c}${cfg?.semesterStart ? ` — semester starts ${cfg.semesterStart}` : ""} [${n} session${n === 1 ? "" : "s"}, ${m} material${m === 1 ? "" : "s"}]`;
      }).join("\n") || "no courses exist yet";
    }
    case "week_overview": {
      const week = Math.max(1, Math.round(Number(args.week ?? 1)));
      const blocks: string[] = [];
      for (const c of allCourses()) {
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
        const sess = scanCourseSessions(c).filter((s) => s.stem.slice(0, 10) >= from && s.stem.slice(0, 10) <= toStr);
        const mats = listMaterials(c).filter((m) => m.week === week);
        const lines = [`### ${c} (${from} … ${toStr})`];
        lines.push(sess.length
          ? sess.map((s) => {
              const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
              return `- session ${s.stem} (${what})`;
            }).join("\n")
          : "- no recorded session in this week");
        lines.push(mats.length
          ? mats.map((m) => `- material: ${m.path}${supportsIndex(m.path) ? " (readable via read_document)" : ""}`).join("\n")
          : "- no materials tagged for this week");
        blocks.push(lines.join("\n"));
      }
      return `Week ${week} across all courses:\n\n${blocks.join("\n\n")}`;
    }
    default:
      // ── course-scoped tools ──
      if (!slug) return "no course given — pass the 'course' argument (see list_courses for exact slugs)";
      if (!allCourses().includes(slug)) return `unknown course "${slug}" — valid: ${allCourses().join(", ")}`;
      return courseTool(name, args, slug);
  }
}

/** Course-scoped tools — execTool validated the slug. */
async function courseTool(name: string, args: Record<string, unknown>, slug: string): Promise<string> {
  switch (name) {
    case "list_deadlines": {
      try {
        const dl = JSON.parse(readFileSync(join(config.userDataDir, "deadlines.json"), "utf8")) as { course: string; title: string; due: string | null; kind: string; spread: boolean; startBy: string | null; note: string; confidence: string; done: boolean }[];
        if (!Array.isArray(dl) || !dl.length) return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)";
        const rows = dl
          .filter((d) => d.course === slug && !d.done)
          .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
          .map((d) => `- ${d.due ?? "no date"}${d.startBy && !d.due ? ` (start by ${d.startBy})` : ""} — ${d.title} (${d.kind}${d.spread ? ", spread out" : ""})${d.note ? `: ${d.note}` : ""}${d.confidence !== "high" ? ` (${d.confidence} confidence)` : ""}`);
        return rows.length ? `Open deadlines for this course (done items already checked off by the student):\n${rows.join("\n")}` : "all deadlines for this course are done (or none exist)";
      } catch { return "deadline calendar is empty — rebuild it from the Courses page (it may just not exist yet)"; }
    }
    case "list_materials": {
      const mats = listMaterials(slug);
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
      const sess = scanCourseSessions(slug);
      if (!sess.length) return "no recorded sessions";
      return sess.map((s) => {
        const what = [s.recording && "recording", s.transcript && "transcript", s.notes && "notes", s.timeline && "timeline"].filter(Boolean).join(", ");
        return `- ${s.stem} (${what})`;
      }).join("\n");
    }
    case "read_notes": {
      const sess = scanCourseSessions(slug);
      if (!sess.length) return "no sessions";
      const kind = String(args.kind ?? "notes") as "notes" | "running" | "transcript";
      const want = String(args.date ?? "");
      const hit = want ? sess.find((s) => s.stem.startsWith(want)) : sess[0]!;
      const file = hit && (kind === "running" ? hit.running : kind === "transcript" ? hit.transcript : hit.notes);
      if (!file) return `no ${kind} for ${want || hit?.stem || "latest"} (available: notes=${!!hit?.notes}, running=${!!hit?.running}, transcript=${!!hit?.transcript})`;
      return readFileSync(join(NOTES_DIR, slug, file), "utf8").slice(0, 20_000);
    }
    case "search_transcripts": {
      const q = String(args.query ?? "").toLowerCase();
      if (!q) return "query required";
      const hits: string[] = [];
      for (const s of scanCourseSessions(slug)) {
        for (const f of [s.transcript, s.timeline].filter(Boolean) as string[]) {
          try {
            const txt = readFileSync(join(NOTES_DIR, slug, f), "utf8");
            if (txt.toLowerCase().includes(q)) {
              const idx = txt.toLowerCase().indexOf(q);
              hits.push(`- ${s.stem} (${f.endsWith(".json") ? "timeline" : "transcript"}): …${txt.slice(Math.max(0, idx - 150), idx + 350).replace(/\s+/g, " ")}…`);
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
