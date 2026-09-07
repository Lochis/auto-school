/** Variant test: which launch ingredient breaks tab-audio capture?
 *  Modes: plain | persistent | realargs | ext  (cumulative)
 *  Usage: node test-audio-capture.cjs [msedge|chromium] */
const { chromium } = require("playwright");
const http = require("node:http");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const channel = process.argv[2] ?? "msedge";
const EXT = "/app/extension"; // copied in for the ext variant
const html = `<html><body>no audio here<script>document.title="x"</script></body></html>`;

const server = http.createServer((_q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end(html); }).listen(8899, "127.0.0.1");

const REAL_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--window-size=1920,1080",
  "--start-maximized",
  "--use-fake-ui-for-media-stream",
];

(async () => {
  for (const mode of ["plain", "persistent", "realargs", "ext"]) {
    const userDataDir = mkdtempSync(join(tmpdir(), "pw-"));
    const useExt = mode === "ext";
    const args = [...REAL_ARGS];
    if (useExt) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
    const opts = {
      headless: false,
      channel: channel === "msedge" ? "msedge" : undefined,
      args,
      viewport: null,
    };
    const ctx = await chromium.launchPersistentContext(userDataDir, opts);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("http://127.0.0.1:8899/");
    await page.waitForTimeout(1200);
    const r = await page.evaluate(async () => {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser", selfBrowserSurface: "include", monitorTypeSurfaces: "exclude" },
          audio: true,
          preferCurrentTab: true,
        });
        const n = s.getAudioTracks().length;
        s.getTracks().forEach((t) => t.stop());
        return { ok: true, audioTracks: n };
      } catch (e) { return { ok: false, error: String(e).split("\n")[0] }; }
    });
    console.log(`[${channel}] launch=${mode.padEnd(10)} → ${JSON.stringify(r)}`);
    await ctx.close();
  }
  server.close();
})().catch((e) => { console.error("launch failed:", String(e).slice(0, 300)); process.exit(2); });
