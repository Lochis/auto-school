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
import { updateSession } from "../pipeline/sessions.ts";
/** stem of the CURRENT recording: <title>__<session-start ISO> (from seg 0). */
function stemOf(title: string): string {
  return liveStem ?? `${title.replace(/ /g, "_")}__${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}`;
}
let liveStem: string | null = null;
import { SEGMENTS_DIR, outPath } from "../paths.ts";
import { pushEvent, setDetail, getSettings } from "../status.ts";

// capture fps — 15 is plenty for slides/whiteboard and roughly halves the
// live-encode CPU vs 30. REC_FPS=30 for full motion.
const REC_FPS = Number(process.env.REC_FPS) || 15;
// 5-min rolling segments by default. SEGMENT_MS env shortens them for tests
// (e.g. SEGMENT_MS=60000 → 1 min); BATCH_SEGMENTS=1 sends each chunk to
// Gemini immediately instead of batching 4.
const SEGMENT_MS = Number(process.env.SEGMENT_MS) || 5 * 60_000;
export const RECORD_DIR = SEGMENTS_DIR;
const REC_SINK = process.env.REC_SINK ?? "rec"; // pulse sink monitor we tap for audio

export interface RecordingResult {
  segments: string[];
  bytes: number;
  ms: number;
  audio?: string; // session-wide ogg captured from the pulse sink monitor
}

export async function rebuildSeekPoints(file: string): Promise<boolean> {
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

export async function startRecording(page: Page, meetingTitle: string, joinUrl?: string): Promise<RecordingResult> {
  mkdirSync(RECORD_DIR, { recursive: true });

  const state: RecordingResult = { segments: [], bytes: 0, ms: 0 };
  const files: string[] = [];
  const timeline: TimelineEntry[] = [];
  let started = false;
  const inFlight = new Set<Promise<void>>();
  const t0 = Date.now();

  // AUDIO: Edge/Linux getDisplayMedia audio is a FAKE TONE in this environment
  // (verified) — real audio comes from tapping the browser's PulseAudio sink
  // monitor directly. One ogg for the whole session; slices mux into per-segment
  // Gemini clips and the final mp4.
  const stemBase = `${(meetingTitle).replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_") || "meeting"}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const audioFile = `${RECORD_DIR}/${stemBase}.audio.ogg`;
  const audioRec = spawn("parecord", ["--file-format=ogg", "-d", `${REC_SINK}.monitor`, audioFile]);
  audioRec.on("error", (e) => console.warn(`[rec] ! parecord failed to start: ${e} — recording will be video-only`));
  state.audio = audioFile;
  console.log(`[rec] audio: parecord → ${REC_SINK}.monitor (${audioFile.split("/").pop()})`);

  // kick off Gemini video processing for a finalized segment (fire-and-forget,
  // tracked so stop() can await stragglers)
  // BATCHED Gemini pipeline: segments queue up, flush when the batch is full
  // or at stop. Token math (measured): 5-min segment ≈ 25k input tokens, peak
  // allowance 250k — so 4 segments/request uses <half the budget while cutting
  // request count 4x. Quota is per-DAY requests, not tokens.
  // Re-read from settings at each close so the Settings page applies mid-class.
  const batchSize = () => Math.min(6, Math.max(1, getSettings().batchSegments));
  const pending: { file: string; idx: number; audio?: { file: string; offsetSec: number } }[] = [];

  const flush = (): void => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    pushEvent(`Gemini: analyzing segment(s) [${batch.map((b) => b.idx).join(",")}] (transcript + slides)`);
    setDetail({ batchInFlight: inFlight.size + 1 });
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
    p.finally(() => { inFlight.delete(p); setDetail({ batchInFlight: inFlight.size, batchQueued: pending.length }); });
  };

  const queueProcessing = (file: string, idx: number): void => {
    if (!getSettings().transcribe) {
      setDetail({ segments: state.segments.length });
      pushEvent(`segment ${idx} kept — transcription OFF (quota guard)`);
      return;
    }
    pending.push({ file: `${RECORD_DIR}/${file}`, idx, audio: { file: audioFile, offsetSec: (idx * SEGMENT_MS) / 1000 } });
    setDetail({ batchQueued: pending.length, segments: state.segments.length });
    pushEvent(`segment ${idx} closed → queued (${pending.length}/${batchSize()} for next Gemini batch)`);
    if (pending.length >= batchSize()) flush();
  };

  await page.exposeFunction("__seg", (idx: number, b64: string, title: string) => {
    if (!files[idx]) {
      files[idx] = `${(title ?? meetingTitle).replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_") || "meeting"}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}__${String(idx).padStart(3, "0")}.webm`;
      state.segments.push(files[idx]);
      if (!liveStem) liveStem = files[idx]?.replace(/__\d{3}\.webm$/, "") ?? null;
      updateSession(stemOf(meetingTitle), { stage: "recording", segCount: state.segments.length, title: meetingTitle, ...(joinUrl ? { joinUrl } : {}) });
      console.log(`[rec] segment -> ${files[idx]}`);
      pushEvent(`segment ${idx} recording (${Math.round(SEGMENT_MS / 60_000)} min, ~${(state.bytes / 1e6).toFixed(0)} MB so far)`);
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

  await page.evaluate(([segMs, fps]: [number, number]) => {
    (window as any).__rec = { idx: 0, stopped: false };
    (async () => {
      // CURRENT-TAB-ONLY capture: preferCurrentTab + browser surface. Audio: tab audio.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser",        // tabs only — screens/windows excluded
          selfBrowserSurface: "include",    // allow capturing our own tab (required)
          monitorTypeSurfaces: "exclude",   // never offer the monitor
          surfaceSwitching: "exclude",
          // capture at target resolution — we re-encode to 720p anyway, so
          // capturing 1080p doubles pixels (and CPU) for nothing
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { ideal: fps },
        } as MediaTrackConstraints,
        // video-only: Edge/Linux returns a FAKE TONE track for getDisplayMedia
        // audio here (verified). Real audio = parecord on the pulse sink monitor.
        audio: false,
        preferCurrentTab: true,            // self-capture: the ONLY choice is this tab
      });
      (window as any).__recStream = stream;
      const vs = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
      console.log(`[rec] captured ${vs.width}x${vs.height}@${vs.frameRate}`);
      const vt = stream.getVideoTracks()[0];
      const st = vt?.getSettings?.() ?? {};
      console.log(`[auto-school] capture surface=${st.displaySurface} ${st.width}x${st.height} ${st.frameRate}fps audio=${stream.getAudioTracks().length}`);
      vt.addEventListener("ended", () => { (window as any).__rec && ((window as any).__rec.stopped = true); });

      const startSegment = () => {
        const rec = new MediaRecorder(stream, {
          mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm;codecs=vp8,opus",
          videoBitsPerSecond: fps >= 30 ? 4_000_000 : 3_000_000,
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
        rec.start(5000); // 5s timeslices: same bytes, 5x fewer base64 IPC messages than 1s
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
  }, [SEGMENT_MS, REC_FPS] as [number, number]);

  page.on("console", (m) => { if (m.text().includes("auto-school") || m.text().startsWith("[rec]")) console.log(`[rec:page] ${m.text()}`); });
  await page.evaluate((title: string) => {
    if ((window as any).__rec) (window as any).__rec.title = title;
    else (window as any).__recTitle = title;
  }, meetingTitle).catch(() => {});

  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const r = (window as any).__rec ?? {};
      return { running: !!r.cur, err: (window as any).__recError, title: r.title ?? (window as any).__recTitle };
    }).catch(() => ({ running: false, err: "page gone", title: meetingTitle }));
    if (st.err) { audioRec.kill("SIGKILL"); throw new Error(`capture failed: ${st.err}`); }
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
  if (!started) { audioRec.kill("SIGKILL"); throw new Error("capture never started (getDisplayMedia denied?)"); }

  // ── Phase 1: quick stop — only needs the live page (~2s) ────────
  const quickStop = async (): Promise<{ result: RecordingResult; postProcess: () => Promise<void> }> => {
    state.ms = Date.now() - t0;
    audioRec.kill("SIGTERM"); // flush the ogg
    await new Promise((res) => setTimeout(res, 500));
    await page.evaluate(() => {
      const r = (window as any).__rec;
      if (r) { r.stopped = true; clearInterval(r.timer); r.cur?.state !== "inactive" && r.cur?.stop(); }
      (window as any).__recStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1_500));
    // ── Phase 2: heavy post-processing — no page needed ─────────────
    const postProcess = async (): Promise<void> => {
      console.log("[rec] rebuilding seek points (ffmpeg remux)...");
      pushEvent("meeting ended — remuxing segments (seek index)");
      updateSession(stemOf(meetingTitle), { stage: "remuxing", title: meetingTitle });
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
        pushEvent(`waiting for ${inFlight.size} in-flight Gemini batch(es)`);
        await Promise.allSettled([...inFlight]);
      }
      if (timeline.length) {
        const { writeFileSync } = await import("node:fs");
        mkdirSync(outPath(), { recursive: true });
        writeFileSync(outPath("timeline.json"), JSON.stringify(timeline.sort((a, b) => a.offsetSec - b.offsetSec), null, 2));
        console.log(`[pipe] ✓ timeline complete: ${timeline.length} segment(s) → ${outPath("timeline.json")} + timeline.jsonl`);
        // final polish pass on the notes
        try {
          await finalizeNotes(meetingTitle, timeline);
          pushEvent("final notes written");
        } catch (e) {
          console.warn(`[notes] ! finalize failed: ${String(e).slice(0, 150)} — running summary remains at notes/**/...running.md`);
          await notify(`⚠️ Notes finalize failed — raw running summary kept`);
        }
      }
      // ALWAYS consolidate (transcription may be off; the mp4 is the listenable
      // archive) — muxes the pulse-monitor ogg in as the audio track
      try {
        updateSession(stemOf(meetingTitle), { stage: "consolidating", title: meetingTitle });
        const done = await consolidateSession(meetingTitle, state.segments.map((s) => `${RECORD_DIR}/${s}`), state.ms / 1000, audioFile);
        if (done) updateSession(stemOf(meetingTitle), { stage: "done", title: meetingTitle, mp4: done.mp4, sizeMB: Math.round(done.outBytes / 1e6) });
        else updateSession(stemOf(meetingTitle), { stage: "failed", stageNote: "consolidation failed — raws kept", title: meetingTitle });
      } catch (e) {
        console.warn(`[consolidate] ! ${String(e).slice(0, 150)} — segments left in ${RECORD_DIR}/`);
      }
    };
    return { result: state, postProcess };
  };
  (page as any).__recStop = quickStop;

  await notify(`🔴 Recording (tab-only): **${meetingTitle}**`);
  return state;
}

/** Quick stop only (~2s) — stops MediaRecorder + flushes audio, returns a
 *  handle with a `.postProcess()` method for the heavy remux/consolidate work.
 *  Use this when you want to leave the meeting immediately. */
export async function quickStopRecording(page: Page): Promise<{ result: RecordingResult; postProcess: () => Promise<void> } | null> {
  const fn = (page as any).__recStop as (() => Promise<{ result: RecordingResult; postProcess: () => Promise<void> }>) | undefined;
  if (!fn) return null;
  (page as any).__recStop = undefined;
  return fn();
}

/** Legacy: stops recording AND runs all post-processing (blocking). */
export async function stopRecording(page: Page): Promise<RecordingResult | null> {
  const fn = (page as any).__recStop as (() => Promise<{ result: RecordingResult; postProcess: () => Promise<void> }>) | undefined;
  if (!fn) return null;
  (page as any).__recStop = undefined;
  const { result, postProcess } = await fn();
  await postProcess();
  return result;
}

export async function stillInMeeting(page: Page): Promise<boolean> {
  return page
    .locator('button[aria-label*="Leave"], [data-tid="call-screen"], [data-tid="presentation-status"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}
