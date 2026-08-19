/**
 * Tab-isolated recorder (tabCapture extension edition).
 *
 * getDisplayMedia auto-select captured the SCREEN (osu leaked in) and window
 * sources get no audio — so instead: an unpacked extension uses chrome.tabCapture
 * to record the meeting TAB (video+audio, perfectly isolated), its offscreen
 * document runs MediaRecorder in rolling 5-min segments, and chunks are POSTed
 * to this module's localhost sink. ffmpeg rebuilds seek points per segment.
 */
import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { notify } from "../notify.ts";

const SEGMENT_MS = 5 * 60_000;
export const RECORD_DIR = "segments";
export const EXTENSION_DIR = resolve("extension");

export interface RecordingResult {
  segments: string[];
  bytes: number;
  ms: number;
}

/** MediaRecorder webm lacks Cues — remux with -c copy to rebuild (fast, lossless). */
async function rebuildSeekPoints(file: string): Promise<boolean> {
  const tmp = file.replace(/\.webm$/, ".cued.webm");
  const ok = await new Promise<boolean>((res) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-err_detect", "ignore_err", "-i", file, "-c", "copy", tmp], { cwd: RECORD_DIR });
    p.on("close", (c) => res(c === 0));
    p.on("error", () => res(false));
  });
  if (ok && existsSync(`${RECORD_DIR}/${tmp}`)) {
    renameSync(`${RECORD_DIR}/${tmp}`, `${RECORD_DIR}/${file}`);
    return true;
  }
  return false;
}

export async function startRecording(page: Page, meetingTitle: string): Promise<RecordingResult> {
  mkdirSync(RECORD_DIR, { recursive: true });

  const state: RecordingResult = { segments: [], bytes: 0, ms: 0 };
  const files: string[] = [];
  let meta = "";
  let firstChunk: (() => void) | null = null;
  const firstChunkP = new Promise<void>((res) => (firstChunk = res));
  const t0 = Date.now();

  const fileFor = (idx: number, title: string) =>
    `${title.replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_") || "meeting"}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}__${String(idx).padStart(3, "0")}.webm`;

  const server: Server = createServer(async (req, res) => {
    res.writeHead(204);
    if (req.method === "POST" && req.url === "/chunk") {
      try {
        const { idx, b64, title } = JSON.parse((await readFile(req)).toString());
        if (!files[idx]) {
          files[idx] = fileFor(idx, title ?? meetingTitle);
          state.segments.push(files[idx]);
          console.log(`[rec] segment -> ${files[idx]}`);
          if (files[idx - 1]) {
            void rebuildSeekPoints(files[idx - 1]).then((ok) =>
              ok ? console.log(`[rec] seek points rebuilt: ${files[idx - 1]}`) : console.warn(`[rec] ! remux failed: ${files[idx - 1]}`));
          }
        }
        const buf = Buffer.from(b64, "base64");
        if (buf.length) {
          writeFileSync(`${RECORD_DIR}/${files[idx]}`, buf, { flag: "a" });
          state.bytes += buf.length;
          firstChunk?.();
          firstChunk = null;
        }
      } catch (e) {
        console.warn(`[rec] chunk parse failed: ${String(e).slice(0, 100)}`);
      }
    } else if (req.method === "POST" && req.url === "/log") {
      const msg = (await readFile(req)).toString();
      if (msg.startsWith("META")) {
        meta = msg.slice(5);
        console.log(`[rec] capture settings: ${meta}`);
        firstChunk?.();
        firstChunk = null;
      } else console.log(`[rec:ext] ${msg}`);
    }
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as any).port;

  // tell the extension (via page -> content script -> background) to start
  await page.evaluate(
    ({ p, t }) => window.postMessage({ autoschool: { type: "start", port: p, title: t } }, "*"),
    { p: port, t: meetingTitle },
  );

  // wait for capture to actually begin (meta or first chunk) — 20s
  const timedOut = await Promise.race([
    firstChunkP.then(() => false),
    new Promise<boolean>((res) => setTimeout(() => res(true), 20_000)),
  ]);
  if (timedOut) {
    await page.evaluate(() => window.postMessage({ autoschool: { type: "stop" } }, "*")).catch(() => {});
    server.close();
    throw new Error("extension capture never started — is --load-extension active and the content script injected?");
  }
  console.log(`[rec] ✓ tab capture running${meta ? ` @ ${meta}` : ""} (sink :${port})`);
  await notify(`🔴 Recording (tab-isolated): **${meetingTitle}**${meta ? ` @ ${meta}` : ""}`);

  const stop = async (): Promise<RecordingResult> => {
    state.ms = Date.now() - t0;
    await page.evaluate(() => window.postMessage({ autoschool: { type: "stop" } }, "*")).catch(() => {});
    await new Promise((res) => setTimeout(res, 2_000)); // flush last chunks
    server.close();
    console.log("[rec] rebuilding seek points (ffmpeg remux)...");
    for (const seg of state.segments) {
      if (!(await rebuildSeekPoints(seg))) console.warn(`[rec] ! remux failed: ${seg} (raw copy kept)`);
    }
    console.log("[rec] ✓ all segments finalized with seek index");
    return state;
  };
  (page as any).__recStop = stop;
  return state;
}

/** Stop + finalize; safe multiple times. */
export async function stopRecording(page: Page): Promise<RecordingResult | null> {
  const stop = (page as any).__recStop as (() => Promise<RecordingResult>) | undefined;
  if (!stop) return null;
  (page as any).__recStop = undefined;
  return stop();
}

/** Is the call still alive? */
export async function stillInMeeting(page: Page): Promise<boolean> {
  return page
    .locator('button[aria-label*="Leave"], [data-tid="call-screen"], [data-tid="presentation-status"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}
