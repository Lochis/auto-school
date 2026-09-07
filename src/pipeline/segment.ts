/**
 * Batched per-segment analysis: several finalized segments go to Gemini as ONE
 * request (multiple inline videos) — cuts quota usage ~2x. Each batch returns
 * one timeline entry per segment. Batches append to out/timeline.jsonl.
 */
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, unlinkSync, statSync } from "node:fs";
import { readFile as rf } from "node:fs/promises";
import { geminiCall } from "./llm.ts";
import { ffSerial } from "./fflock.ts";
import { outPath } from "../paths.ts";
import { pushEvent } from "../status.ts";

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

/** ~14MB of media → ~19MB base64: the last size that safely fits one request. */
const INLINE_CAP = 14 * 1024 * 1024;

/** Prepare a segment for Gemini. Remux-first: stream-copy the VP9 video and
 *  the matching ogg-audio slice into an .mkv — zero decode/encode, so no CPU
 *  during class. Gemini samples at 1fps regardless, and native resolution
 *  actually reads slides/code BETTER than the old 640px re-encode. Only if a
 *  remux busts the inline cap do we fall back to the old x264 encode. */
async function compact(input: string, base: string, audio?: { file: string; offsetSec: number }): Promise<{ file: string; mime: string }> {
  const mkv = `${base}.mkv`;
  const args = ["-y", "-loglevel", "error"];
  if (audio) args.push("-ss", String(audio.offsetSec), "-i", audio.file);
  args.push("-i", input);
  if (audio) args.push("-map", "1:v", "-map", "0:a", "-c", "copy", "-shortest");
  else args.push("-map", "0:v", "-c", "copy");
  args.push(mkv);
  try {
    await ffSerial(() => run("ffmpeg", args));
    if (statSync(mkv).size > INLINE_CAP) throw new Error(`remux ${(statSync(mkv).size / 1e6).toFixed(1)}MB > cap`);
    return { file: mkv, mime: "video/x-matroska" };
  } catch (e) {
    try { unlinkSync(mkv); } catch { /* gone */ }
    console.warn(`[pipe] remux fell back to encode (${String(e).slice(0, 80)})`);
  }
  // fallback: the old re-encode (screen 640px / 2fps — small but costs CPU)
  const mp4 = `${base}.mp4`;
  if (audio) {
    await ffSerial(() => run("ffmpeg", ["-y", "-loglevel", "error",
      "-ss", String(audio.offsetSec), "-i", audio.file, "-i", input,
      "-map", "1:v", "-map", "0:a",
      "-vf", "scale=640:-2,fps=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-b:a", "48k", "-shortest", mp4]));
  } else {
    await ffSerial(() => run("ffmpeg", ["-y", "-loglevel", "error", "-i", input,
      "-vf", "scale=640:-2,fps=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-b:a", "48k", mp4]));
  }
  return { file: mp4, mime: "video/mp4" };
}

// keep segment-relative timestamps in sync with recorder SEGMENT_MS (tests)
const SEG_SEC = Math.round((Number(process.env.SEGMENT_MS) || 300_000) / 1000);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Analyze a batch of finalized segments in ONE Gemini request. */
export async function processSegments(
  items: { file: string; idx: number; audio?: { file: string; offsetSec: number } }[],
  meetingTitle: string,
  onDone?: (e: TimelineEntry) => void,
): Promise<TimelineEntry[]> {
  mkdirSync(outPath("transcribe"), { recursive: true });
  const parts: any[] = [];
  const tmps: string[] = [];

  for (const it of items) {
    const base = outPath("transcribe", `seg_${String(it.idx).padStart(3, "0")}_compact`);
    const { file: tmp, mime } = await compact(it.file, base, it.audio);
    const media = await rf(tmp);
    tmps.push(tmp);
    parts.push({ text: `Clip ${it.idx} (starts at ${fmt(it.idx * SEG_SEC)} into the meeting):` });
    parts.push({ inline_data: { mime_type: mime, data: media.toString("base64") } });
  }

  console.log(`[pipe] batch of ${items.length} segment(s) [${items.map((i) => i.idx).join(",")}] → Gemini`);
  parts.unshift({
    text:
      `These are sequential 5-minute clips of the recorded class "${meetingTitle}". ` +
      `For EACH clip, describe everything you can perceive — both what you can SEE and what is SAID.\n` +
      `VISION: what type of content is on screen (app, website, slide deck, code editor, video, game, camera feed, shared screen), ` +
      `what it shows specifically (titles, headings, file names, code content, numbers, buttons, diagrams), any text you can read, ` +
      `and changes over time within the clip.\n` +
      `AUDIO: verbatim speech transcript — capture what is being said word for word; include who seems to be speaking if discernible; ` +
      `note significant non-speech sounds (music, game sounds, notifications) briefly.\n` +
      `Return ONLY a JSON array, one object per clip in order: ` +
      `[{"idx": <clip number>, "transcript": "...", ` +
      `"visualNotes": [{"t": "m:ss within clip", "note": "content type + what is specifically visible"}]}]. ` +
      `Every distinct screen state gets a visual note; prefer specific detail over generic description.`,
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
    appendFileSync(outPath("timeline.jsonl"), JSON.stringify(e) + "\n");
    console.log(`[pipe] ✓ segment ${it.idx} analyzed — ${e.transcript.split(/\s+/).length} words, ${e.visualNotes.length} visual notes`);
    return e;
  });
  entries.forEach((e) => onDone?.(e));
  pushEvent(`Gemini ✓ segments [${items.map((i) => i.idx).join(",")}] — ${entries.reduce((a, e) => a + e.transcript.split(/\s+/).filter(Boolean).length, 0)} words, ${entries.reduce((a, e) => a + e.visualNotes.length, 0)} visual notes`);
  return entries;
}
