/**
 * Cloud transcription via any OpenAI-compatible /audio/transcriptions endpoint
 * (Groq whisper-large-v3-turbo default — free & fast; Zhipu/OpenAI work too).
 * ffmpeg locally flattens to 16k mono wav and chunks to fit API limits.
 */
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, writeFileSync, unlinkSync } from "node:fs";

const CHUNK_SEC = 600; // 10 min per request (25MB API limit ≈ 13min @16k mono wav)

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

async function transcribeChunk(wav: string): Promise<string> {
  const base = process.env.ASR_BASE_URL ?? "https://api.groq.com/openai/v1";
  const key = process.env.ASR_API_KEY;
  const model = process.env.ASR_MODEL ?? "whisper-large-v3-turbo";
  if (!key) throw new Error("ASR_API_KEY not set in .env (Groq: console.groq.com — free tier)");

  const form = new FormData();
  form.append("file", new Blob([await (await import("node:fs/promises")).readFile(wav)], { type: "audio/wav" }), "chunk.wav");
  form.append("model", model);
  form.append("response_format", "json");
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`ASR ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as any).text ?? "";
}

/** Transcribe any media file ffmpeg can read. Returns text + per-chunk offsets. */
export async function transcribeFile(input: string): Promise<Transcript> {
  mkdirSync("out/transcribe", { recursive: true });
  const total = await durationSec(input);
  console.log(`[asr] ${input} — ${Math.round(total)}s audio, chunks of ${CHUNK_SEC}s`);

  const chunks: TranscriptChunk[] = [];
  const nChunks = Math.max(1, Math.ceil(total / CHUNK_SEC));
  for (let i = 0; i < nChunks; i++) {
    const offset = i * CHUNK_SEC;
    const wav = `out/transcribe/chunk_${i}.wav`;
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(offset), "-t", String(CHUNK_SEC),
      "-i", input, "-vn", "-ac", "1", "-ar", "16000", wav]);
    console.log(`[asr] chunk ${i + 1}/${nChunks} (${offset}s+) -> ${base()}`);
    const text = (await transcribeChunk(wav)).trim();
    if (text) chunks.push({ offsetSec: offset, text });
    unlinkSync(wav);
  }
  return { text: chunks.map((c) => c.text).join("\n\n"), chunks };
}

function base(): string {
  return process.env.ASR_BASE_URL?.includes("groq") ? "groq" : process.env.ASR_BASE_URL?.includes("bigmodel") ? "zhipu" : "cloud";
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
