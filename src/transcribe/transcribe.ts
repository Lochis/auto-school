/**
 * Transcription via Google Gemini (AI Studio key, generous free tier) —
 * multimodal generateContent with inline audio/video. Same key/client later
 * powers the frame-understanding (VLM) pass.
 * ffmpeg chunks to keep inline payloads under the 20MB limit.
 */
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, writeFileSync, unlinkSync, readFile } from "node:fs";

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

async function transcribeChunk(mediaPath: string, mime: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.ASR_MODEL ?? "gemini-2.5-flash";
  if (!key) throw new Error("GEMINI_API_KEY not set in .env (aistudio.google.com/apikey — free)");

  const data = await readFile(mediaPath);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: "Transcribe this recording verbatim. Output ONLY the transcript text — no preamble, no timestamps, no speaker labels unless obvious multiple speakers (then 'Speaker A:' prefix)." },
            { inline_data: { mime_type: mime, data: data.toString("base64") } },
          ],
        }],
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as any;
  return json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
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
    console.log(`[asr] chunk ${i + 1}/${nChunks} (${offset}s+) -> Gemini ${process.env.ASR_MODEL ?? "gemini-2.5-flash"}`);
    const text = (await transcribeChunk(wav, "audio/wav")).trim();
    if (text) chunks.push({ offsetSec: offset, text });
    unlinkSync(wav);
  }
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
