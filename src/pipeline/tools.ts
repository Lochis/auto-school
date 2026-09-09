/**
 * Standard chat tools — the same five verbs for every course and every
 * document type. The model discovers materials (list_materials), reads text
 * (read_document), looks at figures (view_page → VLM), and reaches session
 * artifacts (list_sessions / read_notes / search_transcripts). Nothing here
 * knows course-specific structure; the document-bundle layout does the work.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOTES_DIR, RECORDINGS_DIR } from "../paths.ts";
import { listMaterials } from "./materials.ts";
import { ensureIndex, indexedPages, pageImage, readDoc, supportsIndex } from "./docindex.ts";
import { vlmDescribe } from "./llm.ts";

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_materials",
      description: "List the course material files (folder tree with week tags). Paths are relative to the materials root. Some entries show an available page count.",
      parameters: { type: "object", properties: {}, required: [] },
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
        properties: { path: { type: "string" }, page: { type: "number" } },
        required: ["path", "page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List recorded class sessions for the course (date, which artifacts exist: recording/transcript/notes/timeline).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_notes",
      description: "Read session notes / running notes / transcript for a session date. Omit date for the most recent session.",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD from list_sessions" }, kind: { type: "string", description: "notes | running | transcript (default notes)" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_transcripts",
      description: "Keyword-search session transcripts and timelines; returns matching snippets with dates.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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

async function execTool(name: string, args: Record<string, unknown>, slug: string): Promise<string> {
  switch (name) {
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
      if (!img) return `no page image for ${rel} p${page} (PDFs/DOCXs only)`;
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

export async function runTool(call: { id: string; function: { name: string; arguments: string } }, slug: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* model sent bad json */ }
  try {
    return await execTool(call.function.name, args, slug);
  } catch (e) {
    return `tool error: ${String(e).slice(0, 150)}`;
  }
}

export const ensureIndexForChat = ensureIndex; // re-export keeps daemon imports tidy
