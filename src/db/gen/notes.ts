/** Bundleable notes generator (5b-2 c, D4 — extracted from
 *  src/pipeline/notes.ts:57-155).
 *
 *  This is the ONE implementation of "fold a segment into the running summary"
 *  and "polish the running summary + timeline into final class notes".
 *  src/pipeline/notes.ts is now a thin daemon adapter that calls it (quota-aware
 *  text call + fs index/notify/embed tail), so the daemon and the platform can
 *  never drift.
 *
 *  Bundleable by construction (frontend/Dockerfile:15 copies only `src/db/`):
 *  imports `../pg.ts`, `../owner.ts`, `../llm.ts` (raw provider transport),
 *  `../llm-keys.ts` (env → app_settings key) and `../writes.ts` (artifact /
 *  segment upserts — itself pg+owner only). No fs, no drizzle, no
 *  src/status.ts, no src/pipeline/* — and no module-level side effects.
 *
 *  LLM POLICY IS INJECTED: `callText` (FoldOpts.callText) defaults to
 *  `defaultTextCall` = GLM-if-key-else-Gemini, no quota bookkeeping. The daemon
 *  passes pipeline/llm.ts `textCall` instead, keeping 429 learning, model
 *  rotation and activity-feed logging where they belong.
 *
 *  FS COUPLING IS GONE: paths are derived from PG (`resolveSessionTarget`) or
 *  passed explicitly (`target.slug` / `target.stem`). `rebuildIndex()`,
 *  `notify()` and the embed kick stay in the daemon adapter via the
 *  `onFinalized` callback. The write targets are unchanged and byte-for-byte:
 *  session_artifacts (running_notes / notes / timeline inline content) +
 *  transcript_segments upserts.
 */
import { getPool } from "../pg.ts";
import { curOwner } from "../owner.ts";
import { geminiGenerate, glmGenerate } from "../llm.ts";
import { resolveApiKey } from "../llm-keys.ts";
import { courseId, sessionId, upsertArtifact, upsertSegments } from "../writes.ts";

// ── injectable LLM call ───────────────────────────────────────────────────

export interface CallTextOpts {
  temperature?: number;
}

/** `(prompt) => string`. The daemon injects pipeline/llm.ts `textCall`
 *  (quota-aware); the platform uses `defaultTextCall` below. */
export type CallText = (prompt: string, opts?: CallTextOpts) => Promise<string>;

/** model ids mirror the daemon defaults without importing src/status.ts:
 *  GLM_MODEL (pipeline/llm.ts glmModel) and the head of GEMINI_MODELS
 *  (status.ts:51). */
const glmModel = (): string => process.env.GLM_MODEL?.trim() || "glm-5.3";
const geminiTextModel = (): string =>
  (process.env.GEMINI_MODELS ?? "").split(",")[0]?.trim() || "gemini-3.6-flash";

/** Raw text call: GLM when a key resolves, else Gemini (temperature 0.3).
 *  Same provider preference as pipeline/llm.ts `textCall`, minus quota policy —
 *  keys come from env → app_settings (llm-keys.ts), never the filesystem. */
export const defaultTextCall: CallText = async (prompt) => {
  const glmKey = await resolveApiKey("GLM_API_KEY");
  if (glmKey) {
    try {
      const r = await glmGenerate(glmModel(), glmKey, prompt);
      if (r.ok) return r.text;
      console.warn(`[notes] GLM ${r.status} (${r.body.slice(0, 120)}) → Gemini`);
    } catch (e) {
      console.warn(`[notes] GLM failed (${String(e).slice(0, 120)}) → Gemini`);
    }
  }
  const geminiKey = await resolveApiKey("GEMINI_API_KEY");
  if (!geminiKey) throw new Error("no GLM_API_KEY / GEMINI_API_KEY (env or app_settings)");
  const r = await geminiGenerate(geminiTextModel(), geminiKey, [{ text: prompt }], { temperature: 0.3 });
  if (!r.ok || r.body.includes("RESOURCE_EXHAUSTED")) throw new Error(`Gemini ${r.status}: ${r.body.slice(0, 200)}`);
  return r.text;
};

// ── shapes ────────────────────────────────────────────────────────────────

/** Structural twin of pipeline/segment.ts TimelineEntry (that module is
 *  fs-coupled and unbundleable). A daemon TimelineEntry is assignable as-is. */
export interface NotesTimelineEntry {
  offsetSec: number;
  file?: string | null;
  transcript: string;
  visualNotes: { t: string | number; note: string }[];
}

export interface SessionTarget {
  /** course slug ("26M-Java_Programming") */
  slug: string;
  /** session stem ("2026-08-20__26M-Java_Programming") */
  stem: string;
}

export interface FoldOpts {
  /** quota-aware text call (daemon) or omitted for `defaultTextCall` */
  callText?: CallText;
  /** explicit session identity; omitted halves are derived from PG */
  target?: Partial<SessionTarget>;
  /** date used for the derived stem (default: now) */
  date?: Date;
}

export interface FinalizeOpts extends FoldOpts {
  /** daemon tail: rebuildIndex / embed kick / notify. Runs after the DB
   *  writes (+ the console log), in the caller's order. */
  onFinalized?: (info: SessionTarget & { sessionId: number | null }) => void | Promise<void>;
}

// ── session identity (PG only — replaces sessionPaths/resolveSession) ─────

const normTitle = (s: string): string =>
  s.toLowerCase().replace(/&/g, " ").replace(/\(\s*sec\.?\s*\d+\s*\)|sec\.?\s*\d+/gi, " ").replace(/[^a-z0-9]+/g, "");

/** Copy of pipeline/courses.ts:79-81 (that module imports node:fs). */
const slugify = (s: string): string =>
  s.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_").slice(0, 60);

/** meeting_mappings lookup, exact then normalized-containment — the PG
 *  equivalent of courses.ts `mappingLookup` (which serves the same table
 *  through an in-memory cache). Undefined when the title is unmapped. */
async function mappedSlug(meeting: string): Promise<string | undefined> {
  try {
    const { rows } = await getPool().query<{ match_title: string; slug: string }>(
      `select m.match_title, c.slug
         from meeting_mappings m
         join courses c on c.id = m.course_id
        order by m.match_title`,
    );
    const exact = rows.find((r) => r.match_title.trim() === meeting.trim())?.slug;
    if (exact) return exact;
    const n = normTitle(meeting);
    if (!n) return undefined;
    for (const r of rows) {
      const nk = normTitle(r.match_title);
      if (!nk) continue;
      // containment either way absorbs chip truncation ("…sec 4" ⊂ "…sec 402")
      if (n.includes(nk) || nk.includes(n)) return r.slug;
    }
  } catch { /* no DB / unmigrated → regex fallback below */ }
  return undefined;
}

/** Title → slug with the daemon's parseCourse regexes (courses.ts:61-77). */
function parsedSlug(meeting: string): string {
  const t = meeting.replace(/\(SEC\.?\s*[^)]*\)/gi, "").trim();
  const m = t.match(/(\b[A-Z0-9]{2,4}[A-Z0-9]*)\s*--\s*(.+)/) ?? t.match(/(\b[A-Z0-9]{2,4})\s*[-–]\s*(.+)/);
  if (m) return `${m[1]}-${slugify(m[2].trim())}`;
  const words = t.split(/\s+/).slice(0, 4).join(" ") || "General";
  return slugify(words) || "General";
}

/** course slug + dated stem for a meeting title, PG-first (no fs). The daemon
 *  adapter passes both explicitly from sessionPaths() instead, so its folder
 *  naming is untouched. */
export async function resolveSessionTarget(
  meeting: string,
  target: Partial<SessionTarget> = {},
  date = new Date(),
): Promise<SessionTarget> {
  const slug = target.slug ?? (await mappedSlug(meeting)) ?? parsedSlug(meeting);
  // local date ("sv-SE" → YYYY-MM-DD), matching courses.ts sessionPaths()
  const stem = target.stem ?? `${date.toLocaleDateString("sv-SE")}__${slug}`;
  return { slug, stem };
}

/** (course, stem, owner) → session id, creating the row when missing —
 *  identical to pipeline/sessions.ts resolveSession() minus the fs paths. */
async function resolveSessionId(target: SessionTarget, meeting: string): Promise<number> {
  const cid = await courseId(target.slug);
  const found = await getPool().query(
    `select id from sessions where course_id = $1 and stem = $2 and owner_user_id = $3`,
    [cid, target.stem, curOwner()],
  );
  if (found.rows[0]) return Number(found.rows[0].id);
  return sessionId(cid, target.stem, { sessionDate: target.stem.slice(0, 10), title: meeting, stage: "recording" });
}

// ── helpers (verbatim from pipeline/notes.ts:39-54) ───────────────────────

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Inline artifact content read (mirrors frontend lib/db.ts artifactContent). */
async function artifactContent(sessionId: number, kind: string): Promise<string | null> {
  const r = await getPool().query(
    `select content from session_artifacts
     where session_id = $1 and kind = $2 and deleted_at is null
     order by updated_at desc limit 1`,
    [sessionId, kind],
  );
  return r.rows[0]?.content ?? null;
}

/** "m:ss …" (or bare integer) → seconds. Copy of pipeline/segment.ts:26-34
 *  `noteT` (that module imports node:child_process/node:fs). */
function noteT(t: string | number): number {
  if (typeof t === "number") return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
  const m = String(t).match(/^(\d{1,3}):(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseInt(String(t), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** transcript_segments insert shape — copy of pipeline/segment.ts:37-46. */
function toSegmentInit(e: NotesTimelineEntry, segIndex: number) {
  return {
    segIndex,
    offsetSec: Math.round(e.offsetSec),
    file: e.file ?? null,
    transcript: e.transcript ?? "",
    visualNotes: (e.visualNotes ?? []).map((v) => ({ t: noteT(v.t), note: v.note })),
  };
}

// ── incremental fold ──────────────────────────────────────────────────────

/** Fold a single entry (cheap wrapper — one GLM call). */
export async function foldSegment(meeting: string, entry: NotesTimelineEntry, opts: FoldOpts = {}): Promise<string> {
  return foldSegments(meeting, [entry], opts);
}

/** Fold entries (one call per batch — cheap on GLM). */
export async function foldSegments(meeting: string, entries: NotesTimelineEntry[], opts: FoldOpts = {}): Promise<string> {
  const callText = opts.callText ?? defaultTextCall;
  let sid: number | null = null;
  const target = await resolveSessionTarget(meeting, opts.target, opts.date);
  try {
    sid = await resolveSessionId(target, meeting);
  } catch (e) {
    console.warn(`[notes] DB resolve failed (running summary in-memory only): ${String(e).slice(0, 120)}`);
  }

  const existing = sid != null
    ? ((await artifactContent(sid, "running_notes")) ?? "(nothing yet — this is the first segment)")
    : "(nothing yet — this is the first segment)";

  const newMaterial = entries.map((entry) =>
    `## Segment @ ${fmt(entry.offsetSec)}\n` +
    (entry.transcript ? `Speech:\n${entry.transcript}\n` : `(no speech)\n`) +
    (entry.visualNotes.length
      ? `On screen:\n${entry.visualNotes.map((v) => `- [${v.t}] ${v.note}`).join("\n")}`
      : "(no visual notes)")
  ).join("\n\n");

  const summary = await callText(
    `You are building running notes for the class meeting "${meeting}".\n\n` +
    `CURRENT RUNNING SUMMARY (from earlier in the meeting):\n${existing}\n\n` +
    `NEW SEGMENT MATERIAL (${entries.length} new segment(s), each headed by its meeting-relative timestamp):\n${newMaterial}\n\n` +
    `Update the running summary: merge the new material in, keep it compact (bullet points), ` +
    `chronological, and note the timestamp ranges of key topics. Do not invent content. ` +
    `If a new segment repeats earlier material, tighten rather than duplicate. ` +
    `Output ONLY the updated summary in markdown.`,
  );

  if (sid != null) {
    try {
      await upsertArtifact(sid, "running_notes", `notes/${target.slug}/${target.stem}__running.md`, { content: summary, mimeType: "text/markdown" });
    } catch (e) {
      console.warn(`[notes] DB running-notes write failed: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`[notes] running summary updated (${summary.split(/\s+/).length} words) — notes/${target.slug}/${target.stem}__running.md`);
  return summary;
}

// ── final pass ────────────────────────────────────────────────────────────

/** Final pass: running summary + full timeline -> polished class notes. */
export async function finalizeNotes(
  meeting: string,
  timeline: NotesTimelineEntry[],
  opts: FinalizeOpts = {},
): Promise<string> {
  const callText = opts.callText ?? defaultTextCall;
  const target = await resolveSessionTarget(meeting, opts.target, opts.date);
  let sid: number | null = null;
  try {
    sid = await resolveSessionId(target, meeting);
  } catch (e) {
    console.warn(`[notes] DB resolve failed (final notes in-memory only): ${String(e).slice(0, 120)}`);
  }

  const running = sid != null ? ((await artifactContent(sid, "running_notes")) ?? "") : "";
  const sorted = [...timeline].sort((a, b) => a.offsetSec - b.offsetSec);
  const timelineText = sorted
    .map((e) =>
      `[${fmt(e.offsetSec)}] ${e.transcript ? e.transcript.slice(0, 500) : "(no speech)"} ` +
      `| visuals: ${e.visualNotes.map((v) => v.note.slice(0, 100)).join(" / ")}`)
    .join("\n");

  const final = await callText(
    `Produce final study notes for the class "${meeting}".\n\n` +
    `RUNNING SUMMARY (built incrementally during the meeting):\n${running}\n\n` +
    `RAW TIMELINE (for verification and detail):\n${timelineText}\n\n` +
    `Output ONLY polished markdown with these sections:\n` +
    `# Class Notes — ${meeting}\n## Overview (2-3 sentences)\n` +
    `## Key Topics (each with timestamp reference like [12:30] where it was discussed)\n` +
    `## On-Screen Material (slides/code/diagrams shown, with timestamps)\n` +
    `## Likely Assignments / Exam Relevance (only if explicitly mentioned; else omit)\n` +
    `## Action Items (only if mentioned)\n`,
  );

  if (sid != null) {
    try {
      await upsertArtifact(sid, "notes", `notes/${target.slug}/${target.stem}__notes.md`, { content: final, mimeType: "text/markdown" });
      await upsertArtifact(sid, "timeline", `notes/${target.slug}/${target.stem}__timeline.json`, { content: JSON.stringify(sorted, null, 2), mimeType: "application/json" });
      await upsertSegments(sid, sorted.map(toSegmentInit));
    } catch (e) {
      console.warn(`[notes] DB artifact/segment write failed: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`[notes] ✓ final notes written: notes/${target.slug}/${target.stem}__notes.md (course: ${target.slug})`);
  if (opts.onFinalized) await opts.onFinalized({ ...target, sessionId: sid });
  return final;
}
