/** Bundleable checklist generator (5b-2 c, D5 — extracted from
 *  src/daemon.ts:2284-2338).
 *
 *  This is the ONE implementation of "build an execution checklist for one
 *  deadline from the real course files". src/daemon.ts's /checklists POST
 *  generate branch now delegates here (quota-aware GLM call + fs tool runner
 *  injected), so the recorder and the platform cannot drift.
 *
 *  Bundleable by construction (frontend/Dockerfile:9 copies only `src/db/`):
 *  imports `../pg.ts`-free modules only — `../llm.ts` (raw provider transport),
 *  `../llm-keys.ts` (env → app_settings key), `../deadlines.ts` (readCk /
 *  writeCk / itemId — pg+owner only) and `./tools.ts` (PG tool surface). No fs,
 *  no drizzle, no src/status.ts, no src/pipeline/*, no module-level side
 *  effects.
 *
 *  PROMPTS ARE BYTE-FOR-BYTE the daemon's (system + user messages, the 10-round
 *  tool loop, the 26 000-char tool-result trim, the `[[...]]`-free
 *  `[{"text": …}]` contract, the 5-12 item guidance, `today`). The only
 *  intentional difference, applied to BOTH paths: when the course corpus is
 *  EMPTY (PG is a filtered corpus — see doc-source.ts's header) one extra
 *  sentence is appended to the USER message telling the model it has no indexed
 *  text, and the same text is returned as `warning`.
 *
 *  LLM + TOOLS ARE INJECTED, same contract as gen/notes.ts:
 *    - `callTools` — daemon: pipeline/llm.ts `glmChatRaw` (429 learning, model
 *      rotation, activity feed); platform: `defaultCallTools` = raw
 *      db/llm.ts glmChatComplete with an env/app_settings key.
 *    - `runTool`   — daemon: pipeline/tools.ts `runTool` (fs + PG, .index/
 *      bundles, view_page VLM); platform: `runToolPgCall` (PG only).
 *    - `tools`     — daemon: pipeline/tools.ts `TOOL_DEFS`; platform:
 *      `TOOL_DEFS_PG` (byte-identical copy).
 *
 *  PERSISTENCE IS SHARED, NOT REIMPLEMENTED: state lives in `checklist_items`
 *  read/written by db/deadlines.ts `readCk`/`writeCk`. Item ids stay
 *  `itemId(deadlineId, text)` (djb2 of deadline+text), so a regenerated
 *  checklist keeps done-ness (same text → same id) and keeps the student's
 *  manual additions, exactly as the daemon did.
 */
import { type Ck, type CkItem, type Dl, itemId, readCk, writeCk } from "../deadlines.ts";
import { GLM_DEFAULT_BASE, glmChatComplete, type ChatMsg, type ToolCall } from "../llm.ts";
import { resolveApiKey } from "../llm-keys.ts";
import { getCourseDocCoverage, coverageNote } from "./doc-source.ts";
import { TOOL_DEFS_PG, runToolPgCall } from "./tools.ts";

// ── injectable LLM / tools ────────────────────────────────────────────────

/** One tool-loop round: `(messages, tools) => assistant message`. The daemon
 *  injects pipeline/llm.ts `glmChatRaw` (quota-aware); the platform uses
 *  `defaultCallTools` below. */
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

/** Raw GLM round-trip with tools — mirrors pipeline/llm.ts `glmChatRaw`
 *  (same model, base, temperature 0.4, same error string) minus quota policy.
 *  Keys come from env → app_settings (llm-keys.ts), never the filesystem. */
export const defaultCallTools: CallTools = async (messages, tools) => {
  const key = await resolveApiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const r = await glmChatComplete(glmModel(), key, messages, { base: glmBase(), tools, temperature: 0.4 });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${r.body.slice(0, 200)}`);
  return { content: r.text, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) };
};

// ── error contract (the daemon's exact 500 bodies) ────────────────────────

/** A generation failure with the daemon's user-visible wording. `status` is
 *  always 500 today; it exists so the routes can map it without string
 *  matching. */
export class ChecklistGenError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "ChecklistGenError";
    this.status = status;
  }
}

// ── shapes ────────────────────────────────────────────────────────────────

/** The deadline being expanded — structurally `db/deadlines.ts` `Dl`; only the
 *  fields the prompt reads are required, so a route can pass a lite object. */
export type ChecklistDeadline = Pick<Dl, "id" | "course" | "title" | "kind"> &
  Partial<Pick<Dl, "due" | "note" | "parts">>;

export interface GenerateChecklistOpts {
  /** quota-aware tool-loop call (daemon) or omitted for `defaultCallTools` */
  callTools?: CallTools;
  /** fs/VLM tool runner (daemon) or omitted for the PG surface */
  runTool?: CallTool;
  /** tool schemas for the LLM; defaults to `TOOL_DEFS_PG` */
  tools?: unknown[];
  /** board / activity-feed sink (daemon `pushEvent`); also used for the
   *  "no indexed text" warning */
  onEvent?: (msg: string) => void;
  /** explicit owner; defaults to `curOwner()` inside readCk/writeCk/queries */
  owner?: string;
  /** "today" for the prompt (default: now) */
  now?: Date;
  /** persist to checklist_items (default true) — false is for a dry run */
  persist?: boolean;
}

export interface GenerateChecklistResult {
  /** the checklist row written (or that would have been written) */
  entry: Ck;
  items: CkItem[];
  /** the full checklist set after the write (what the route returns) */
  checklists: Ck[];
  /** the raw step texts the model produced */
  steps: string[];
  /** "no indexed text" warning, or null when the corpus is fine */
  warning: string | null;
}

// ── prompt (byte-for-byte the daemon's system prompt) ─────────────────────

/** `src/daemon.ts:2284-2293` — unchanged wording, `now` instead of `new Date()`
 *  so a test/dry-run can pin the date. */
export function checklistSystemPrompt(dl: ChecklistDeadline, now: Date = new Date()): string {
  return `You build an EXECUTION CHECKLIST for one specific student task, from the real course files — never invent steps.
Task: "${dl.title}" (${dl.kind})${dl.due ? `, due ${dl.due}` : ""}${dl.note ? `. Known detail: ${dl.note}` : ""}${dl.parts?.length ? `\nThis task has KNOWN PARTS (folded sub-deliverables) — each MUST appear as its own step, with its due date when given:\n${dl.parts.map((p) => `- ${p.title}${p.due ? ` (due ${p.due})` : ""}${p.done ? " [already done]" : ""}${p.note ? ` — ${p.note}` : ""}`).join("\n")}` : ""}
Course slug: ${dl.course}
Explore with tools first: list_materials / read_document / view_page on anything related to THIS task (task sheets, lab specs, submission instructions). Read enough to know what concretely must be done; skim, don't quote.
Then reply with ONLY a JSON array (no prose, no markdown fences) of ordered steps:
[{"text": "short imperative step, individually verifiable"}]
5-12 items unless the source genuinely demands more. Split the work into its real parts (prepare → do → verify → submit) — a 1- or 2-item checklist is almost never useful. Steps must be concrete and checkable (e.g. "Complete Section 2 query exercises", "Upload the .zip to Moodle"), not vague ("understand the lab"). Include setup, the actual work, and submission. Today is ${now.toISOString().slice(0, 10)}.`;
}

/** `src/daemon.ts:2295-2297` user message. */
export function checklistUserPrompt(dl: ChecklistDeadline, warning?: string | null): string {
  return `Build the checklist for "${dl.title}" now. Explore the course materials with tools, then output ONLY the JSON array.` +
    (warning ? `\n\nNOTE: ${warning} — the course materials may be unreadable here, so base steps only on what the tools actually return.` : "");
}

/** Max tool rounds (daemon loop bound) and the per-result trim. */
const MAX_STEPS = 10;
const TOOL_RESULT_CAP = 26_000;

// ── generator ─────────────────────────────────────────────────────────────

/** Build the checklist for ONE deadline from the course materials.
 *
 *  - `course` defaults to `deadline.course` (slugs must match `courses.slug`,
 *    otherwise every tool answers "unknown course …").
 *  - Throws `ChecklistGenError` with the daemon's exact messages when the model
 *    returns no JSON array / broken JSON / no usable steps.
 */
export async function generateChecklist(
  deadline: ChecklistDeadline,
  course?: string | null,
  opts: GenerateChecklistOpts = {},
): Promise<GenerateChecklistResult> {
  const dl: ChecklistDeadline = { ...deadline, course: course || deadline.course };
  const callTools = opts.callTools ?? defaultCallTools;
  const runTool = opts.runTool ?? ((name, argsJson) => runToolPgCall({ function: { name, arguments: argsJson } }, dl.course, opts.owner));
  const tools = opts.tools ?? TOOL_DEFS_PG;

  // corpus probe — PG is a FILTERED corpus (embeddable exts only, PDFs need
  // pdftotext, nothing chunked post-cutover until the embed key path works).
  // An empty corpus makes the tool loop read nothing; say so once, upfront.
  let warning: string | null = null;
  try {
    const cov = await getCourseDocCoverage(dl.course, opts.owner);
    warning = cov.indexed === 0
      ? `no indexed text for this course (${cov.total} material document(s), 0 indexed) — the embed sweep has not run or nothing is chunked`
      : coverageNote(cov);
  } catch { /* no DB / unmigrated → the tools will report it themselves */ }
  if (warning) opts.onEvent?.(`checklist warning: ${warning}`);

  const convo: ChatMsg[] = [
    { role: "system", content: checklistSystemPrompt(dl, opts.now) },
    { role: "user", content: checklistUserPrompt(dl, warning) },
  ];

  let raw = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await callTools(convo, tools);
    if (msg.tool_calls?.length) {
      convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const result = await runTool(tc.function.name, tc.function.arguments ?? "{}");
        opts.onEvent?.(`checklist tool: ${tc.function.name} → ${String(result).slice(0, 80).replace(/\s+/g, " ")}…`);
        convo.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, TOOL_RESULT_CAP) });
      }
      continue;
    }
    raw = msg.content;
    break;
  }

  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new ChecklistGenError(`model produced no JSON array: ${raw.slice(0, 120)}`);
  let parsed: unknown[];
  try { parsed = JSON.parse(m[0]) as unknown[]; } catch (e) {
    throw new ChecklistGenError(`JSON parse failed: ${String(e).slice(0, 120)}`);
  }
  const steps = (Array.isArray(parsed) ? parsed : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => String(s.text ?? "").trim().slice(0, 200))
    .filter((t) => t.length > 1);
  if (!steps.length) throw new ChecklistGenError("model returned no usable steps");

  // Persistence: carry over done-ness + manual items (id = deadlineId|text).
  const prevCk = opts.persist === false ? [] : await readCk(opts.owner);
  const prev = prevCk.find((c) => c.deadlineId === dl.id);
  const prevDone = new Map((prev?.items ?? []).filter((x) => x.done).map((x) => [x.id, x]));
  const items: CkItem[] = steps.map((text) => {
    const id = itemId(dl.id, text);
    const old = prevDone.get(id);
    return { id, text, done: Boolean(old?.done), doneAt: old?.doneAt ?? null };
  });
  for (const x of prev?.items ?? []) if (x.manual && !items.some((n) => n.id === x.id)) items.push(x); // keep manual adds

  const entry: Ck = { deadlineId: dl.id, course: dl.course, title: dl.title, items, updatedAt: Date.now() };
  const out = prevCk.filter((c) => c.deadlineId !== dl.id);
  out.push(entry);
  if (opts.persist !== false) await writeCk(out, opts.owner);
  opts.onEvent?.(`checklist built: ${dl.title} — ${items.length} step(s)`);
  return { entry, items, checklists: out, steps, warning };
}
