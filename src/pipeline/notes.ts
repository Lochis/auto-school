/**
 * Incremental notes: fold each new timeline entry into a running summary.
 * State lives in Postgres (session_artifacts kind='running_notes', inline
 * content) — small per-fold, so context never explodes. Final pass polishes
 * into structured class notes (kind='notes') and writes the session timeline
 * (kind='timeline') plus transcript_segments rows.
 */
import { notify } from "../notify.ts";
import { pushEvent, apiKey } from "../status.ts";
import type { TimelineEntry } from "./segment.ts";
import { toSegmentInit } from "./segment.ts";
import { sessionPaths, rebuildIndex } from "./courses.ts";
import { textCall } from "./llm.ts";
import { getPool } from "../db/client.ts";
import { upsertArtifact, upsertSegments } from "../db/writes.ts";
import { resolveSession } from "./sessions.ts";

async function gemini(prompt: string): Promise<string> { return textCall(prompt); }
async function _unused_gemini(prompt: string): Promise<string> {
  const key = apiKey("GEMINI_API_KEY");
  const model = process.env.ASR_MODEL ?? "gemini-3.6-flash";
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as any;
  return (json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "").trim();
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

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

/** Fold entries (one call per batch — cheap on GLM). */
export async function foldSegment(meeting: string, entry: TimelineEntry): Promise<string> {
  return foldSegments(meeting, [entry]);
}

export async function foldSegments(meeting: string, entries: TimelineEntry[]): Promise<string> {
  let sid: number | null = null;
  let slug = "";
  let stem = "";
  try {
    const r = await resolveSession(meeting);
    sid = r.sessionId; slug = r.slug; stem = r.stem;
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

  const summary = await textCall(
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
      await upsertArtifact(sid, "running_notes", `notes/${slug}/${stem}__running.md`, { content: summary, mimeType: "text/markdown" });
    } catch (e) {
      console.warn(`[notes] DB running-notes write failed: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`[notes] running summary updated (${summary.split(/\s+/).length} words) — notes/${slug}/${stem}__running.md`);
  pushEvent(`notes: running summary updated (${summary.split(/\s+/).length} words)`);
  return summary;
}

/** Final pass: running summary + full timeline -> polished class notes. */
export async function finalizeNotes(
  meeting: string,
  timeline: TimelineEntry[],
  paths?: { notesMd: string; runningMd: string; timelineJson: string; dir: string; course: import("./courses.ts").CourseInfo; stem: string },
): Promise<string> {
  const p = paths ?? sessionPaths(meeting);
  let sid: number | null = null;
  try {
    sid = (await resolveSession(meeting, { slug: p.course.slug, stem: p.stem })).sessionId;
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

  const final = await textCall(
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
      await upsertArtifact(sid, "notes", `notes/${p.course.slug}/${p.stem}__notes.md`, { content: final, mimeType: "text/markdown" });
      await upsertArtifact(sid, "timeline", `notes/${p.course.slug}/${p.stem}__timeline.json`, { content: JSON.stringify(sorted, null, 2), mimeType: "application/json" });
      await upsertSegments(sid, sorted.map(toSegmentInit));
    } catch (e) {
      console.warn(`[notes] DB artifact/segment write failed: ${String(e).slice(0, 120)}`);
    }
  }
  rebuildIndex();
  console.log(`[notes] ✓ final notes written: notes/${p.course.slug}/${p.stem}__notes.md (course: ${p.course.slug})`);
  // EMBED — make the fresh notes/timeline semantically searchable right away
  // (fire-and-forget; no-op when PG/Gemini key absent).
  try {
    const { embedPendingSessions } = await import("../db/ingest-embed.ts");
    void embedPendingSessions().catch(() => { });
  } catch { /* db layer absent in fs-only dev */ }
  await notify(`📝 Class notes ready: **${p.course.name}** → notes/${p.course.slug}/${p.stem}__notes.md`);
  return final;
}
