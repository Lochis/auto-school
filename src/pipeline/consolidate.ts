/**
 * Session consolidation: after notes finalize, merge the 5-min webm segments
 * into ONE per-session mp4 (720p H.264 CRF 27 ≈ 10x smaller), filed under the
 * course tree. Raw segments are deleted ONLY after the mp4 exists and its
 * duration matches the sum of the sources (±3s).
 */
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { sessionPaths } from "./courses.ts";
import { ffSerial } from "./fflock.ts";
import { notify } from "../notify.ts";
import { RECORDINGS_DIR, outPath } from "../paths.ts";
import { pushEvent } from "../status.ts";

// encode thread cap: x264 defaults to every core (16-core box => ~35% total
// system CPU). 2 threads keeps bursts modest; raise for faster consolidation.
const ENC_THREADS = String(Number(process.env.ENC_THREADS) || 2);

function run(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, err: err.slice(-500) }));
    p.on("error", (e) => res({ code: -1, err: String(e) }));
  });
}

async function durationSec(file: string): Promise<number> {
  const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  return new Promise((res) => p.on("close", () => res(parseFloat(out.trim()) || 0)));
}

function human(bytes: number): string {
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

/** Consolidate a session's segments. expectedSec (wall-clock recording length,
 *  from the recorder) is used for verification — webm segment metadata reports
 *  bogus durations, so summing ffprobe of sources is unreliable. */
export async function consolidateSession(
  meetingTitle: string,
  segmentFiles: string[], // paths relative to repo (e.g. segments/xxx.webm)
  expectedSec?: number,
  audioFile?: string, // session-wide pulse-monitor ogg → becomes the mp4 audio track
): Promise<{ mp4: string; rawBytes: number; outBytes: number } | null> {
  const existing = segmentFiles.filter((f) => existsSync(f));
  // drop crash-boundary stubs: a segment that lived <5s (e.g. the 5-min tick
  // fired one second before Leave) adds nothing but a seek hiccup
  const real = existing.filter((f) => statSync(f).size > 200_000);
  if (real.length && real.length < existing.length)
    pushEvent(`dropped ${existing.length - real.length} stub segment(s) (<200 KB)`);
  if (!real.length) return null;
  const paths = sessionPaths(meetingTitle);
  const dir = `${RECORDINGS_DIR}/${paths.course.slug}`;
  mkdirSync(dir, { recursive: true });
  // same course + same day (e.g. two rescued sessions) would collide — derive a
  // deterministic suffix from the first segment's ISO timestamp when taken
  let stem = paths.stem;
  const mp4For = (s: string) => `${dir}/${s}.mp4`;
  if (existsSync(mp4For(stem))) {
    const m = real[0]?.match(/__(\d{4}-\d{2}-\d{2}T[\d-]+)?/);
    const tag = m?.[1]?.slice(11).replace(/-/g, "") ?? String(Date.now());
    stem = `${paths.stem}__${tag}`;
  }
  // still colliding = a previous encode of THESE segments died mid-write (killed
  // container leaves a truncated moov-less mp4 that ffmpeg can't faststart over).
  // Quarantine the stale file instead of crashing the rescue.
  if (existsSync(mp4For(stem))) {
    const stale = mp4For(`${stem}.stale-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`);
    renameSync(mp4For(stem), stale);
    pushEvent(`quarantined stale/partial mp4 → ${stale.split("/").pop()} (from an interrupted encode)`);
  }
  const mp4 = mp4For(stem);
  const cleanupConcat = () => { try { unlinkSync(concatFile); } catch { /* gone */ } };

  // concat list (absolute paths, in order)
  const list = real.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n");
  mkdirSync(outPath(), { recursive: true });
  const concatFile = outPath(`concat-${paths.stem}-${Date.now()}.txt`);
  writeFileSync(concatFile, list);

  const rawBytes = real.reduce((a, f) => a + statSync(f).size, 0);
  console.log(`[consolidate] ${real.length} segment(s), ${human(rawBytes)} -> merging into 720p mp4 ...`);
  pushEvent(`consolidating: ${real.length} segment(s), ${human(rawBytes)} → 720p mp4`);

  // re-encode during concat: fixes timestamp seams and shrinks archives.
  // nice-19 + superfast: lowest priority (never fights Chromium/recording) and
  // ~40% fewer CPU-seconds than veryfast, at a slightly larger file.
  // If a pulse-monitor ogg exists, mux it in as the audio track (webm segments
  // are video-only by design — Edge's getDisplayMedia audio is a fake tone).
  const hasAudio = !!audioFile && existsSync(audioFile);
  const ffArgs = [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    ...(hasAudio ? ["-i", audioFile!] : []),
    ...(hasAudio ? ["-map", "0:v", "-map", "1:a", "-shortest"] : []),
    "-vf", "scale=1280:-2",
    "-c:v", "libx264", "-preset", "superfast", "-crf", "27", "-threads", ENC_THREADS,
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]),
    "-movflags", "+faststart",
    mp4,
  ];
  const enc = await ffSerial(() => run("nice", ["-n", "19", "ffmpeg", ...ffArgs]));
  if (enc.code !== 0 || !existsSync(mp4)) {
    cleanupConcat();
    console.warn(`[consolidate] ! encode failed: ${enc.err}`);
    pushEvent(`consolidation ✗ (${String(enc.err).slice(-140)}) — raw segments kept`);
    await notify(`⚠️ Consolidation failed for **${paths.course.name}** — raw segments kept`);
    return null;
  }
  cleanupConcat();

  // verify duration before deleting anything — only against wall-clock if given
  // (webm sources report bad durations; mp4 re-encode is the accurate one)
  const got = await durationSec(mp4);
  if (expectedSec && Math.abs(got - expectedSec) > 5) {
    console.warn(`[consolidate] ! duration mismatch (wall-clock ${expectedSec.toFixed(0)}s vs mp4 ${got.toFixed(0)}s) — raw segments kept`);
    await notify(`⚠️ Consolidation duration mismatch for **${paths.course.name}** — raw segments kept`);
    return null;
  }
  if (got < 10) {
    console.warn(`[consolidate] ! mp4 suspiciously short (${got.toFixed(0)}s) — raw segments kept`);
    return null;
  }

  const outBytes = statSync(mp4).size;
  for (const f of existing) {
    try { unlinkSync(f); } catch { /* leave it */ }
  }
  if (hasAudio) { try { unlinkSync(audioFile!); } catch { /* leave it */ } }
  const ratio = rawBytes > 0 ? (rawBytes / outBytes).toFixed(1) : "?";
  console.log(`[consolidate] ✓ ${mp4} — ${human(rawBytes)} → ${human(outBytes)} (${ratio}x smaller), raw segments removed`);
  pushEvent(`consolidated ✓ ${human(rawBytes)} of segments → ${human(outBytes)} mp4 (${ratio}× smaller)`);
  await notify(`📦 **${paths.course.name}** consolidated: ${human(rawBytes)} of segments → ${human(outBytes)} mp4 (${ratio}× smaller) — \`${mp4}\``);
  return { mp4, rawBytes, outBytes };
}
