/**
 * Tab-isolated recorder — in-page getDisplayMedia with preferCurrentTab.
 *
 * Why: tabCapture extension hit MV3 user-invocation walls; plain getDisplayMedia
 * grabbed the whole screen (osu leaked). preferCurrentTab + displaySurface:"browser"
 * constrains the source to THE CURRENT TAB ONLY — video + tab audio, picker-free
 * under our automation launch flags. All recorder fixes retained: idx captured at
 * dataavailable time, rotation-stop guard, lazy segment naming, ffmpeg seek remux.
 */
import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Page } from "playwright";
import { notify } from "../notify.ts";
import { processSegments, type TimelineEntry } from "../pipeline/segment.ts";
import { foldSegments, finalizeNotes } from "../pipeline/notes.ts";
import { consolidateSession } from "../pipeline/consolidate.ts";

const SEGMENT_MS = 5 * 60_000;
export const RECORD_DIR = "segments";

export interface RecordingResult {
  segments: string[];
  bytes: number;
  ms: number;
}

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
  const timeline: TimelineEntry[] = [];
  let started = false;
  const inFlight = new Set<Promise<void>>();
  const t0 = Date.now();

  // kick off Gemini video processing for a finalized segment (fire-and-forget,
  // tracked so stop() can await stragglers)
  // BATCHED Gemini pipeline: segments queue up, flush when the batch is full
  // or at stop. Token math (measured): 5-min segment ≈ 25k input tokens, peak
  // allowance 250k — so 4 segments/request uses <half the budget while cutting
  // request count 4x. Quota is per-DAY requests, not tokens.
  const BATCH = Math.min(6, Math.max(1, Number(process.env.BATCH_SEGMENTS ?? 4) || 4));
  const pending: { file: string; idx: number }[] = [];
  
  const inFlight = new Set<Promise<void>>();
  let started = false;
  const t0 = Date.now();

  const flush = (): void => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    const p = (async () => {
      const run = () => processSegments(batch, meetingTitle, (e) => timeline.push(e));
      let entries: TimelineEntry[];
      try {
        entries = await run();
      } catch (e) {
        console.warn(`[pipe] ! batch [${batch.map((b) => b.idx).join(",")}] failed: ${String(e).slice(0, 150)} — retry in 30s`);
        await new Promise((r) => setTimeout(r, 30_000));
        try { entries = await run(); }
        catch (e2) {
          console.warn(`[pipe] !! batch failed twice — segments skipped this pass`);
          return;
        }
      }
      try { await foldSegments(meetingTitle, entries); }
      catch (err) { console.warn(`[notes] ! fold failed: ${String(err).slice(0, 120)}`); }
    })();
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  };

  const queueProcessing = (file: string, idx: number): void => {
    pending.push({ file: `${RECORD_DIR}/${file}`, idx });
    if (pending.length >= BATCH) flush();
  };

  await page.exposeFunction("__seg", (idx: number, b64: string, title: string) => {
    if (!files[idx]) {
      files[idx] = `${(title ?? meetingTitle).replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_") || "meeting"}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}__${String(idx).padStart(3, "0")}.webm`;
      state.segments.push(files[idx]);
      console.log(`[rec] segment -> ${files[idx]}`);
      if (files[idx - 1]) {
        void rebuildSeekPoints(files[idx - 1]).then((ok) => {
          if (ok) {
            console.log(`[rec] seek points rebuilt: ${files[idx - 1]}`);
            queueProcessing(files[idx - 1], idx - 1); // segment complete → Gemini
          } else console.warn(`[rec] ! remux failed: ${files[idx - 1]}`);
        });
      }
    }
    const buf = Buffer.from(b64, "base64");
    if (buf.length) {
      writeFileSync(`${RECORD_DIR}/${files[idx]}`, buf, { flag: "a" });
      state.bytes += buf.length;
    }
  });

  await page.evaluate((segMs: number) => {
    (window as any).__rec = { idx: 0, stopped: false };
    (async () => {
      // CURRENT-TAB-ONLY capture: preferCurrentTab + browser surface. Audio: tab audio.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser",        // tabs only — screens/windows excluded
          selfBrowserSurface: "include",    // allow capturing our own tab (required)
          monitorTypeSurfaces: "exclude",   // never offer the monitor
          surfaceSwitching: "exclude",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        } as MediaTrackConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        preferCurrentTab: true,            // self-capture: the ONLY choice is this tab
      });
      (window as any).__recStream = stream;
      const vt = stream.getVideoTracks()[0];
      const st = vt?.getSettings?.() ?? {};
      console.log(`[auto-school] capture surface=${st.displaySurface} ${st.width}x${st.height} ${st.frameRate}fps audio=${stream.getAudioTracks().length}`);
      vt.addEventListener("ended", () => { (window as any).__rec && ((window as any).__rec.stopped = true); });

      const startSegment = () => {
        const rec = new MediaRecorder(stream, {
          mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm;codecs=vp8,opus",
          videoBitsPerSecond: 4_000_000,
          audioBitsPerSecond: 128_000,
        });
        rec.ondataavailable = (e) => {
          // capture idx NOW — reading it in onload races rotation
          const segIdx = (window as any).__rec.idx;
          if (!e.data.size) return;
          const r = new FileReader();
          // data-URL MIME contains commas ("codecs=vp8,opus") — slice from ;base64,
          r.onload = () => {
            const s = String(r.result);
            const i = s.indexOf(";base64,");
            (window as any).__seg(segIdx, i >= 0 ? s.slice(i + 8) : s, (window as any).__rec.title);
          };
          r.readAsDataURL(e.data);
        };
        rec.start(1000);
        (window as any).__rec.cur = rec;
      };
      startSegment();

      (window as any).__rec.timer = setInterval(() => {
        const r = (window as any).__rec;
        if (r.stopped) return;
        r.cur.onstop = () => {
          if (r.stopped) return; // shutting down — never start another segment
          r.idx++;
          startSegment();
        };
        r.cur.stop();
      }, segMs);
    })().catch((e) => { (window as any).__recError = String(e); });
  }, SEGMENT_MS);

  page.on("console", (m) => { if (m.text().includes("auto-school")) console.log(`[rec:page] ${m.text()}`); });
  await page.evaluate((title: string) => {
    if ((window as any).__rec) (window as any).__rec.title = title;
    else (window as any).__recTitle = title;
  }, meetingTitle).catch(() => {});

  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const r = (window as any).__rec ?? {};
      return { running: !!r.cur, err: (window as any).__recError, title: r.title ?? (window as any).__recTitle };
    }).catch(() => ({ running: false, err: "page gone", title: meetingTitle }));
    if (st.err) throw new Error(`capture failed: ${st.err}`);
    if (st.running) {
      if (st.title && !(page as any).__recTitle) {
        // ensure title known for segment naming (title may have been set late)
        (page as any).__recTitle = st.title;
      }
      started = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!started) throw new Error("capture never started (getDisplayMedia denied?)");

  const stop = async (): Promise<RecordingResult> => {
    state.ms = Date.now() - t0;
    await page.evaluate(() => {
      const r = (window as any).__rec;
      if (r) { r.stopped = true; clearInterval(r.timer); r.cur?.state !== "inactive" && r.cur?.stop(); }
      (window as any).__recStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1_500));
    console.log("[rec] rebuilding seek points (ffmpeg remux)...");
    const lastIndex = state.segments.length - 1;
    for (const seg of state.segments) {
      if (!(await rebuildSeekPoints(seg))) console.warn(`[rec] ! remux failed: ${seg} (raw copy kept)`);
    }
    console.log("[rec] ✓ all segments finalized with seek index");
    if (lastIndex >= 0) queueProcessing(state.segments[lastIndex], lastIndex); // tail segment
    flush(); // send any partial batch immediately
    // wait for in-flight Gemini jobs before final report
    if (inFlight.size) {
      console.log(`[pipe] waiting for ${inFlight.size} in-flight segment analysis...`);
      await Promise.allSettled([...inFlight]);
    }
    if (timeline.length) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("out/timeline.json", JSON.stringify(timeline.sort((a, b) => a.offsetSec - b.offsetSec), null, 2));
      console.log(`[pipe] ✓ timeline complete: ${timeline.length} segment(s) → out/timeline.json + timeline.jsonl`);
      // final polish pass on the notes, then consolidate the recording
      try {
        await finalizeNotes(meetingTitle, timeline);
      } catch (e) {
        console.warn(`[notes] ! finalize failed: ${String(e).slice(0, 150)} — running summary remains at notes/**/...running.md`);
        await notify(`⚠️ Notes finalize failed — raw running summary kept`);
      }
      try {
        await consolidateSession(meetingTitle, state.segments.map((s) => `${RECORD_DIR}/${s}`), state.ms / 1000);
      } catch (e) {
        console.warn(`[consolidate] ! ${String(e).slice(0, 150)} — segments left in ${RECORD_DIR}/`);
      }
    }
    return state;
  };
  (page as any).__recStop = stop;

  await notify(`🔴 Recording (tab-only): **${meetingTitle}**`);
  return state;
}

export async function stopRecording(page: Page): Promise<RecordingResult | null> {
  const stop = (page as any).__recStop as (() => Promise<RecordingResult>) | undefined;
  if (!stop) return null;
  (page as any).__recStop = undefined;
  return stop();
}

export async function stillInMeeting(page: Page): Promise<boolean> {
  return page
    .locator('button[aria-label*="Leave"], [data-tid="call-screen"], [data-tid="presentation-status"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}
