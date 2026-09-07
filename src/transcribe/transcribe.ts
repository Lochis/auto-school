/**
 * Transcription via Google Gemini (AI Studio key, generous free tier) —
 * multimodal generateContent with inline audio/video. Same key/client later
 * powers the frame-understanding (VLM) pass.
 * ffmpeg chunks to keep inline payloads under the 20MB limit.
 */
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { outPath } from "../paths.ts";
import { geminiCall } from "../pipeline/llm.ts";
import { pushEvent, setDetail } from "../status.ts";

const CHUNK_SEC = 300; // 5min @16k mono wav ≈ 10MB — under 20MB inline limit

export interface TranscriptChunk {
  offsetSec: number;
  text: string;
}
export interface Transcript {
  text: string;
  chunks: TranscriptChunk[];
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
    p.on("error", rej);
  });
}

async function durationSec(file: string): Promise<number> {
  const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  return new Promise((res, rej) => {
    p.on("close", (c) => (c === 0 ? res(parseFloat(out.trim()) || 0) : rej(new Error("ffprobe failed"))));
    p.on("error", rej);
  });
}

/** One request carries several opus chunks (multi-part) — a 5-min opus chunk
 *  is ~1.2MB base64 vs 12.8MB as WAV, so ~45 min of audio fits per request.
 *  That cuts RPD usage 5-10x vs one-request-per-chunk. */
const CHUNKS_PER_REQ = Math.max(1, Number(process.env.TRANSCRIBE_BATCH ?? 9));
const REQ_BYTES_CAP = 14 * 1024 * 1024; // stay clear of the 20MB inline ceiling after base64

const fmtMs = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Transcribe a batch of clips in ONE request; returns text per chunk index. */
async function transcribeBatch(files: string[], offsets: number[]): Promise<Map<number, string>> {
  const parts: any[] = [];
  for (let i = 0; i < files.length; i++) {
    const data = await readFile(files[i]);
    parts.push({ text: `Clip ${i + 1} (starts at ${fmtMs(offsets[i])} into the recording):` });
    parts.push({ inline_data: { mime_type: "audio/ogg", data: data.toString("base64") } });
  }
  parts.unshift({
    text:
      `These are sequential clips of the same recording. Transcribe each verbatim — word for word. ` +
      `Output ONLY a JSON array, one object per clip in order: ` +
      `[{"idx": <clip number>, "transcript": "..."}]. ` +
      `No preamble, no timestamps inside the transcript; use 'Speaker A:' prefixes only if multiple speakers are obvious. ` +
      `If a clip has no speech, use an empty string.`,
  });
  const raw = await geminiCall(parts, { json: true });
  const out = new Map<number, string>();
  try {
    const m = raw.match(/\[[\s\S]*\]/); // tolerate prose wrappers
    const parsed = JSON.parse(m ? m[0] : raw);
    for (const p of parsed) out.set(p.idx, String(p.transcript ?? "").trim());
  } catch {
    throw new Error(`unparseable transcript batch response: ${raw.slice(0, 120)}`);
  }
  return out;
}

/** Transcribe any media file ffmpeg can read. Returns text + per-chunk offsets. */
export async function transcribeFile(input: string): Promise<Transcript> {
  mkdirSync(outPath("transcribe"), { recursive: true });
  const total = await durationSec(input);
  console.log(`[asr] ${input} — ${Math.round(total)}s audio, ${CHUNK_SEC}s opus chunks, ≤${CHUNKS_PER_REQ} per request`);

  // 1) slice to 16k mono opus — ~10x smaller than WAV, speech quality unchanged
  const nChunks = Math.max(1, Math.ceil(total / CHUNK_SEC));
  const files: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < nChunks; i++) {
    const ogg = outPath("transcribe", `chunk_${String(i).padStart(3, "0")}.ogg`);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(i * CHUNK_SEC), "-t", String(CHUNK_SEC),
      "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", ogg]);
    files.push(ogg);
    offsets.push(i * CHUNK_SEC);
  }

  // 2) batch slices into as few requests as the size cap allows
  const chunks: TranscriptChunk[] = [];
  let batch = 0;
  const nBatches = Math.ceil(nChunks / CHUNKS_PER_REQ);
  for (let start = 0; start < files.length; start += CHUNKS_PER_REQ) {
    let end = start;
    let bytes = 0;
    while (end < files.length && end - start < CHUNKS_PER_REQ) {
      const sz = statSync(files[end]).size * 1.34; // base64 inflation
      if (end > start && bytes + sz > REQ_BYTES_CAP) break;
      bytes += sz;
      end++;
    }
    batch++;
    const slice = files.slice(start, end);
    console.log(`[asr] request ${batch}/${nBatches}: chunks ${start + 1}-${end} (${(bytes / 1e6).toFixed(1)} MB) → model chain`);
    const texts = await transcribeBatch(slice, offsets.slice(start, end));
    for (let i = start; i < end; i++) {
      const t = texts.get(i - start + 1) ?? "";
      if (t) chunks.push({ offsetSec: offsets[i], text: t });
    }
    for (const f of slice) unlinkSync(f);
    pushEvent(`transcribe: request ${batch}/${nBatches} ✓ (${slice.length} clip(s), model chain)`);
    setDetail({ transcribe: `request ${batch}/${nBatches}` });
  }
  for (const f of files) { try { unlinkSync(f); } catch { /* gone */ } }
  return { text: chunks.map((c) => c.text).join("\n\n"), chunks };
}

function base(): string {
  return "gemini";
}

/** CLI entry: node src/index.ts transcribe <file> */
export async function transcribeCli(file: string): Promise<void> {
  const t = await transcribeFile(file);
  const out = file.replace(/\.[^.]+$/, "") + ".transcript.txt";
  writeFileSync(out, t.text);
  writeFileSync(out.replace(".txt", ".json"), JSON.stringify(t, null, 2));
  console.log(`\n===== TRANSCRIPT (${t.chunks.length} chunk(s)) =====\n`);
  console.log(t.text || "(no speech detected)");
  console.log(`\n[asr] saved: ${out} + .json`);
}
