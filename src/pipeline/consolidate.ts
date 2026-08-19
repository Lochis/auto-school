/**
 * Session consolidation: after notes finalize, merge the 5-min webm segments
 * into ONE per-session mp4 (720p H.264 CRF 27 ≈ 10x smaller), filed under the
 * course tree. Raw segments are deleted ONLY after the mp4 exists and its
 * duration matches the sum of the sources (±3s).
 */
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sessionPaths } from "./courses.ts";
import { notify } from "../notify.ts";

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

/** Consolidate a session's segments. Returns { mp4, savedBytes } or null on failure. */
export async function consolidateSession(
  meetingTitle: string,
  segmentFiles: string[], // paths relative to repo (e.g. segments/xxx.webm)
): Promise<{ mp4: string; rawBytes: number; outBytes: number } | null> {
  const existing = segmentFiles.filter((f) => existsSync(f));
  if (!existing.length) return null;
  const paths = sessionPaths(meetingTitle);
  const dir = `recordings/${paths.course.slug}`;
  mkdirSync(dir, { recursive: true });
  const mp4 = `${dir}/${paths.stem}.mp4`;

  // concat list (absolute paths, in order)
  const list = existing.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync("out/concat.txt", list);

  const rawBytes = existing.reduce((a, f) => a + statSync(f).size, 0);
  console.log(`[consolidate] ${existing.length} segment(s), ${human(rawBytes)} -> merging into 720p mp4 ...`);

  // re-encode during concat: 10x smaller, and fixes any timestamp seams
  const enc = await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", "out/concat.txt",
    "-vf", "scale=1280:-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    mp4,
  ]);
  if (enc.code !== 0 || !existsSync(mp4)) {
    console.warn(`[consolidate] ! encode failed: ${enc.err}`);
    await notify(`⚠️ Consolidation failed for **${paths.course.name}** — raw segments kept`);
    return null;
  }

  // verify duration before deleting anything
  const expected = (
    await Promise.all(existing.map((f) => durationSec(f)))
  ).reduce((a, b) => a + b, 0);
  const got = await durationSec(mp4);
  if (Math.abs(got - expected) > 3) {
    console.warn(`[consolidate] ! duration mismatch (expected ${expected.toFixed(0)}s got ${got.toFixed(0)}s) — raw segments kept`);
    await notify(`⚠️ Consolidation duration mismatch for **${paths.course.name}** — raw segments kept`);
    return null;
  }

  const outBytes = statSync(mp4).size;
  for (const f of existing) {
    try { unlinkSync(f); } catch { /* leave it */ }
  }
  const ratio = rawBytes > 0 ? (rawBytes / outBytes).toFixed(1) : "?";
  console.log(`[consolidate] ✓ ${mp4} — ${human(rawBytes)} → ${human(outBytes)} (${ratio}x smaller), raw segments removed`);
  await notify(`📦 **${paths.course.name}** consolidated: ${human(rawBytes)} → ${human(outBytes)} (${ratio}×) — ${mp4}`);
  return { mp4, rawBytes, outBytes };
}
