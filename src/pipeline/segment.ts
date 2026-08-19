/**
 * Per-segment processing: after a 5-min webm finalizes (seek points rebuilt),
 * compact it (360p @2fps, small audio) and send to Gemini as VIDEO — one call
 * returns transcript + visual scene notes. Results append to out/timeline.jsonl
 * with meeting-relative offsets. Runs concurrently with ongoing recording.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { readFile as rf } from "node:fs/promises";

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

/** Compact a segment for upload: 360p, 2fps, tiny audio → ~8MB per 5min. */
async function compact(input: string, output: string): Promise<void> {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input,
    "-vf", "scale=640:-2,fps=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-c:a", "aac", "-b:a", "48k", output]);
}

async function geminiVideo(media: Buffer, mime: string, prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.ASR_MODEL ?? "gemini-3.6-flash";
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: media.toString("base64") } }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as any;
  return json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
}

const SEG_SEC = 300;

/** Process one finalized segment (called after seek-point remux). Fire-and-forget safe. */
export async function processSegment(
  file: string,
  segIdx: number,
  meetingTitle: string,
  onDone?: (e: TimelineEntry) => void,
): Promise<TimelineEntry> {
  mkdirSync("out", { recursive: true });
  const compactPath = `out/transcribe/seg_${String(segIdx).padStart(3, "0")}_compact.mp4`;
  const offsetSec = segIdx * SEG_SEC;
  const mmss = `${Math.floor(offsetSec / 60)}:${String(offsetSec % 60).padStart(2, "0")}`;

  console.log(`[pipe] segment ${segIdx}: compacting for Gemini...`);
  await compact(`${file}`, compactPath);
  const media = await rf(compactPath);
  console.log(`[pipe] segment ${segIdx}: ${mmss}+ → Gemini as video (${(media.length / 1e6).toFixed(1)} MB)`);

  const prompt =
    `This is a 5-minute clip of a recorded online class. The clip starts at ${mmss} into the meeting. ` +
    `Analyze BOTH audio and visuals. Return ONLY JSON: ` +
    `{"transcript": "verbatim speech transcript; empty string if silence", ` +
    `"visualNotes": [{"t": "m:ss (time within this clip)", "note": "what is shown on screen — slides, code, diagrams, whiteboard, shared content; be specific about titles/numbers/visible text"}]}. ` +
    `visualNotes covers scene changes — every distinct screen state gets one entry.`;

  let parsed: { transcript?: string; visualNotes?: { t: string; note: string }[] };
  try {
    const raw = await geminiVideo(media, "video/mp4", prompt);
    parsed = JSON.parse(raw);
  } finally {
    try { unlinkSync(compactPath); } catch { /* already gone */ }
  }

  const entry: TimelineEntry = {
    meeting: meetingTitle,
    offsetSec,
    file,
    transcript: (parsed.transcript ?? "").trim(),
    visualNotes: Array.isArray(parsed.visualNotes) ? parsed.visualNotes : [],
  };

  // append to timeline (one JSON per line)
  const line = JSON.stringify(entry) + "\n";
  const { appendFileSync } = await import("node:fs");
  appendFileSync("out/timeline.jsonl", line);

  console.log(`[pipe] ✓ segment ${segIdx} done — transcript ${entry.transcript.split(/\s+/).length} words, ${entry.visualNotes.length} visual notes → out/timeline.jsonl`);
  if (entry.visualNotes.length) {
    for (const v of entry.visualNotes.slice(0, 3)) console.log(`        [${v.t}] ${v.note.slice(0, 90)}`);
  }
  onDone?.(entry);
  return entry;
}
