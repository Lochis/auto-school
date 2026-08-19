/**
 * Incremental notes: fold each new timeline entry into a running summary.
 * State: out/notes-<meeting>.running.md — small, so every fold is cheap and
 * context never explodes. Final pass polishes into structured class notes.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { notify } from "../notify.ts";
import type { TimelineEntry } from "./segment.ts";

function statePath(meeting: string) {
  mkdirSync("out", { recursive: true });
  return `out/notes-${meeting.replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_")}.running.md`;
}

async function gemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
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

/** Fold one segment's transcript+visuals into the running summary (called per segment). */
export async function foldSegment(meeting: string, entry: TimelineEntry): Promise<string> {
  const path = statePath(meeting);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "(nothing yet — this is the first segment)";

  const newMaterial =
    `## Segment @ ${fmt(entry.offsetSec)}\n` +
    (entry.transcript ? `Speech:\n${entry.transcript}\n` : `(no speech)\n`) +
    (entry.visualNotes.length
      ? `On screen:\n${entry.visualNotes.map((v) => `- [${v.t}] ${v.note}`).join("\n")}`
      : "(no visual notes)");

  const summary = await gemini(
    `You are building running notes for the class meeting "${meeting}".\n\n` +
    `CURRENT RUNNING SUMMARY (from earlier in the meeting):\n${existing}\n\n` +
    `NEW SEGMENT MATERIAL (starts at ${fmt(entry.offsetSec)} into the meeting):\n${newMaterial}\n\n` +
    `Update the running summary: merge the new material in, keep it compact (bullet points), ` +
    `chronological, and note the timestamp ranges of key topics. Do not invent content. ` +
    `If the new segment repeats earlier material, tighten rather than duplicate. ` +
    `Output ONLY the updated summary in markdown.`,
  );
  writeFileSync(path, summary);
  console.log(`[notes] running summary updated (${summary.split(/\s+/).length} words) — ${path}`);
  return summary;
}

/** Final pass: running summary + full timeline -> polished class notes. */
export async function finalizeNotes(meeting: string, timeline: TimelineEntry[]): Promise<string> {
  const path = statePath(meeting);
  const running = existsSync(path) ? readFileSync(path, "utf8") : "";
  const timelineText = timeline
    .sort((a, b) => a.offsetSec - b.offsetSec)
    .map((e) =>
      `[${fmt(e.offsetSec)}] ${e.transcript ? e.transcript.slice(0, 500) : "(no speech)"} ` +
      `| visuals: ${e.visualNotes.map((v) => v.note.slice(0, 100)).join(" / ")}`)
    .join("\n");

  const final = await gemini(
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

  const paths = sessionPaths(meeting);
  const outPath = paths.notesMd;
  writeFileSync(outPath, final);
  // keep the session timeline alongside the notes
  try { writeFileSync(paths.timelineJson, JSON.stringify(timeline, null, 2)); } catch { /* optional */ }
  rebuildIndex();
  console.log(`[notes] ✓ final notes written: ${outPath} (course: ${paths.course.slug})`);
  await notify(`📝 Class notes ready: **${paths.course.name}** → ${outPath}`);
  return final;
}
