/**
 * Batched per-segment analysis: several finalized segments go to Gemini as ONE
 * request (multiple inline videos) — cuts quota usage ~2x. Each batch returns
 * one timeline entry per segment. Batches append to out/timeline.jsonl.
 */
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { readFile as rf } from "node:fs/promises";
import { geminiCall } from "./llm.ts";

export interface TimelineEntry {
  meeting: string;
  offsetSec: number; // segment start, relative to meeting
  file: string;
  transcript: string;
  visualNotes: { t: string; note: string }[];
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
    p.on("error", rej);
  });
}

async function compact(input: string, output: string): Promise<void> {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input,
    "-vf", "scale=640:-2,fps=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-c:a", "aac", "-b:a", "48k", output]);
}

const SEG_SEC = 300;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Analyze a batch of finalized segments in ONE Gemini request. */
export async function processSegments(
  items: { file: string; idx: number }[],
  meetingTitle: string,
  onDone?: (e: TimelineEntry) => void,
): Promise<TimelineEntry[]> {
  mkdirSync("out/transcribe", { recursive: true });
  const parts: any[] = [];
  const tmps: string[] = [];

  for (const it of items) {
    const tmp = `out/transcribe/seg_${String(it.idx).padStart(3, "0")}_compact.mp4`;
    await compact(it.file, tmp);
    const media = await rf(tmp);
    tmps.push(tmp);
    parts.push({ text: `Clip ${it.idx} (starts at ${fmt(it.idx * SEG_SEC)} into the meeting):` });
    parts.push({ inline_data: { mime_type: "video/mp4", data: media.toString("base64") } });
  }

  console.log(`[pipe] batch of ${items.length} segment(s) [${items.map((i) => i.idx).join(",")}] → Gemini`);
  parts.unshift({
    text:
      `These are sequential 5-minute clips of the recorded class "${meetingTitle}". ` +
      `Analyze BOTH audio and visuals of each clip. Return ONLY a JSON array, one object per clip in order: ` +
      `[{"idx": <clip number>, "transcript": "verbatim speech; empty string if silence", ` +
      `"visualNotes": [{"t": "m:ss within clip", "note": "what is on screen — slides, code, diagrams; be specific"}]}]. ` +
      `Every distinct screen state gets a visual note.`,
  });

  const raw = await geminiCall(parts, { json: true });
  let parsed: any[];
  try {
    const m = raw.match(/\[[\s\S]*\]/); // tolerate prose wrappers
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    throw new Error(`unparseable batch response: ${raw.slice(0, 120)}`);
  } finally {
    for (const t of tmps) { try { unlinkSync(t); } catch { /* gone */ } }
  }

  const entries: TimelineEntry[] = items.map((it) => {
    const p = parsed.find((x: any) => x.idx === it.idx) ?? {};
    const e: TimelineEntry = {
      meeting: meetingTitle,
      offsetSec: it.idx * SEG_SEC,
      file: it.file.split("/").pop() ?? it.file,
      transcript: (p.transcript ?? "").trim(),
      visualNotes: Array.isArray(p.visualNotes) ? p.visualNotes : [],
    };
    appendFileSync("out/timeline.jsonl", JSON.stringify(e) + "\n");
    console.log(`[pipe] ✓ segment ${it.idx} analyzed — ${e.transcript.split(/\s+/).length} words, ${e.visualNotes.length} visual notes`);
    return e;
  });
  entries.forEach((e) => onDone?.(e));
  return entries;
}
