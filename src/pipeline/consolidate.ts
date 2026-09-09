/**
 * Session consolidation: after notes finalize, merge the 5-min webm segments
 * into ONE per-session webm (VP9 stream-copy — no re-encode, runs in minutes,
 * not hours), filed under the course tree. Raw segments are deleted ONLY after
 * the output exists and its duration matches the wall-clock length (±5s).
 */
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { sessionPaths } from "./courses.ts";
import { ffSerial } from "./fflock.ts";
import { notify } from "../notify.ts";
import { RECORDINGS_DIR, outPath } from "../paths.ts";
import { pushEvent } from "../status.ts";

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
  const outFor = (s: string) => `${dir}/${s}.webm`;
  if (existsSync(outFor(stem))) {
    const m = real[0]?.match(/__(\d{4}-\d{2}-\d{2}T[\d-]+)?/);
    const tag = m?.[1]?.slice(11).replace(/-/g, "") ?? String(Date.now());
    stem = `${paths.stem}__${tag}`;
  }
  // still colliding = a previous copy of THESE segments died mid-write.
  // Quarantine the stale file instead of crashing the rescue.
  if (existsSync(outFor(stem))) {
    const stale = outFor(`${stem}.stale-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`);
    renameSync(outFor(stem), stale);
    pushEvent(`quarantined stale/partial webm → ${stale.split("/").pop()} (from an interrupted copy)`);
  }
  const out = outFor(stem);
  const cleanupConcat = () => { try { unlinkSync(concatFile); } catch { /* gone */ } };

  // concat list (absolute paths, in order)
  const list = real.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n");
  mkdirSync(outPath(), { recursive: true });
  const concatFile = outPath(`concat-${paths.stem}-${Date.now()}.txt`);
  writeFileSync(concatFile, list);

  const rawBytes = real.reduce((a, f) => a + statSync(f).size, 0);
  console.log(`[consolidate] ${real.length} segment(s), ${human(rawBytes)} -> stream-copying into webm ...`);
  pushEvent(`consolidating: ${real.length} segment(s), ${human(rawBytes)} → webm (stream copy)`);

  // VP9 segments are already webm — concat with -c copy: minutes instead of the
  // multi-hour x264 re-encode, identical quality, ~1:1 size (VP9 is already
  // compact). If a pulse-monitor ogg exists, mux it in as the audio track (webm
  // segments are video-only by design — Edge's getDisplayMedia audio is a fake
  // tone). Vorbis copies straight into the webm container.
  const hasAudio = !!audioFile && existsSync(audioFile);
  const ffArgs = [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    ...(hasAudio ? ["-i", audioFile!, "-map", "0:v", "-map", "1:a", "-shortest"] : ["-an"]),
    "-c", "copy",
    out,
  ];
  const enc = await ffSerial(() => run("nice", ["-n", "19", "ffmpeg", ...ffArgs]));
  if (enc.code !== 0 || !existsSync(out)) {
    cleanupConcat();
    console.warn(`[consolidate] ! copy failed: ${enc.err}`);
    pushEvent(`consolidation ✗ (${String(enc.err).slice(-140)}) — raw segments kept`);
    await notify(`⚠️ Consolidation failed for **${paths.course.name}** — raw segments kept`);
    return null;
  }
  cleanupConcat();

  // verify duration before deleting anything — only against wall-clock if given
  // (individual webm segments report bogus durations, but the concatenated
  // container carries an accurate one)
  const got = await durationSec(out);
  if (expectedSec && Math.abs(got - expectedSec) > 5) {
    console.warn(`[consolidate] ! duration mismatch (wall-clock ${expectedSec.toFixed(0)}s vs webm ${got.toFixed(0)}s) — raw segments kept`);
    await notify(`⚠️ Consolidation duration mismatch for **${paths.course.name}** — raw segments kept`);
    return null;
  }
  if (got < 10) {
    console.warn(`[consolidate] ! webm suspiciously short (${got.toFixed(0)}s) — raw segments kept`);
    return null;
  }

  const outBytes = statSync(out).size;
  for (const f of existing) {
    try { unlinkSync(f); } catch { /* leave it */ }
  }
  if (hasAudio) { try { unlinkSync(audioFile!); } catch { /* leave it */ } }
  const ratio = rawBytes > 0 ? (rawBytes / outBytes).toFixed(1) : "?";
  console.log(`[consolidate] ✓ ${out} — ${human(rawBytes)} → ${human(outBytes)} (${ratio}x), raw segments removed`);
  pushEvent(`consolidated ✓ ${human(rawBytes)} of segments → ${human(outBytes)} webm (stream copy)`);
  await notify(`📦 **${paths.course.name}** consolidated: ${human(rawBytes)} of segments → ${human(outBytes)} webm — \`${out}\``);
  // NB: field kept as "mp4" in sessions.json/UI for compatibility
  return { mp4: out, rawBytes, outBytes };
}
