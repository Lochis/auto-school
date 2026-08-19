/**
 * Tab-isolated recorder: 1080p video + tab audio captured INSIDE the meeting
 * tab via getDisplayMedia (auto-select flag set at launch — no picker UI),
 * MediaRecorder -> 1s chunks -> page binding -> rolling 5-min webm segments.
 * Browser-only: no OS capture drivers, no system audio.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { notify } from "../notify.ts";

const SEGMENT_MS = 5 * 60_000; // 5 min, per architecture
export const RECORD_DIR = "segments";

export interface RecordingResult {
  segments: string[];
  bytes: number;
  ms: number;
}

/** Inject the recorder into the meeting page. Resolves when first segment starts. */
export async function startRecording(page: Page, meetingTitle: string): Promise<RecordingResult> {
  mkdirSync(RECORD_DIR, { recursive: true });

  const state: RecordingResult = { segments: [], bytes: 0, ms: 0 };
  const files: string[] = []; // indexed by PAGE's segment idx — no timer drift possible
  const t0 = Date.now();

  // Node-side chunk sink: page pushes base64 chunks + its segment index.
  // Filenames are created lazily on first chunk of each idx — the first chunk
  // carries the webm header, so it must NEVER be dropped to timer drift.
  await page.exposeFunction("__seg", (idx: number, b64: string) => {
    if (!files[idx]) {
      files[idx] = `${meetingTitle.replace(/[^\w -]/g, "").slice(0, 40).trim().replace(/ /g, "_") || "meeting"}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}__${String(idx).padStart(3, "0")}.webm`;
      state.segments.push(files[idx]);
      console.log(`[rec] segment -> ${files[idx]}`);
    }
    const buf = Buffer.from(b64, "base64");
    if (buf.length) {
      writeFileSync(`${RECORD_DIR}/${files[idx]}`, buf, { flag: "a" });
      state.bytes += buf.length;
    }
  });

  // page-side recorder logic
  await page.evaluate(({ segMs }: { segMs: number }) => {
    (window as any).__rec = { idx: 0, stopped: false };
    (async () => {
      // tab/window capture, 1080p, with audio (tab audio when capturing a tab)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      (window as any).__recStream = stream;
      const track = stream.getVideoTracks()[0];
      (window as any).__recSetting = track?.getSettings?.() ?? {};

      const startSegment = () => {
        const rec = new MediaRecorder(stream, {
          mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm;codecs=vp8,opus",
          videoBitsPerSecond: 4_000_000,
          audioBitsPerSecond: 128_000,
        });
        rec.ondataavailable = (e) => {
          if (e.data.size) {
            const r = new FileReader();
            r.onload = () => (window as any).__seg((window as any).__rec.idx, r.result.split(",")[1]);
            r.readAsDataURL(e.data);
          }
        };
        rec.start(1000); // 1s chunks
        (window as any).__rec.cur = rec;
      };
      startSegment();

      // rotate segments
      (window as any).__rec.timer = setInterval(() => {
        const r = (window as any).__rec;
        if (r.stopped) return;
        r.cur.onstop = () => {
          r.idx++;
          startSegment();
        };
        r.cur.stop();
      }, segMs);
    })().catch((e) => {
      (window as any).__recError = String(e);
    });
  }, { segMs: SEGMENT_MS });

  // wait for capture to actually start (or fail)
  let started = false;
  for (let i = 0; i < 30; i++) {
    const st = await page.evaluate(() => {
      const r = (window as any).__rec ?? {};
      return { running: !!r.cur, err: (window as any).__recError, setting: (window as any).__recSetting };
    }).catch(() => ({ running: false, err: "page gone", setting: {} }));
    if (st.err) throw new Error(`capture failed: ${st.err}`);
    if (st.running) {
      const s = st.setting as any;
      console.log(`[rec] ✓ capture running @ ${s?.width ?? "?"}x${s?.height ?? "?"} ${s?.frameRate ?? "?"}fps (audio: ${s ? "see segments" : "?"})`);
      started = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!started) throw new Error("capture never started (getDisplayMedia blocked — check launch flags)");

  // stop function returned via page handle
  const stop = async (): Promise<RecordingResult> => {
    state.ms = Date.now() - t0;
    await page.evaluate(() => {
      const r = (window as any).__rec;
      if (r) { r.stopped = true; clearInterval(r.timer); r.cur?.stop(); }
      (window as any).__recStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    }).catch(() => {});
    // wait for last chunks to flush
    await new Promise((res) => setTimeout(res, 1_500));
    return state;
  };
  (page as any).__recStop = stop;

  await notify(`🔴 Recording started: **${meetingTitle}** (tab-isolated, 1080p)`);
  return state;
}

/** Stop + finalize; returns stats. Safe to call multiple times. */
export async function stopRecording(page: Page): Promise<RecordingResult | null> {
  const stop = (page as any).__recStop as (() => Promise<RecordingResult>) | undefined;
  if (!stop) return null;
  (page as any).__recStop = undefined;
  return stop();
}

/** Is the call still alive? (Leave button / call screen present) */
export async function stillInMeeting(page: Page): Promise<boolean> {
  return page
    .locator('button[aria-label*="Leave"], [data-tid="call-screen"], [data-tid="presentation-status"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}
