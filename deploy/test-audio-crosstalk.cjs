/** Isolation test (post-fix): browser A plays a loud beep on its OWN throwaway
 *  PulseAudio server. Browser B (main server, single rec sink — what the
 *  recorder uses) captures its own SILENT tab. Pass = B's recording is silent.
 *  Usage: node test-audio-crosstalk.cjs [msedge|chromium] */
const { chromium } = require("playwright");
const http = require("node:http");
const { execSync, spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const channel = process.argv[2] ?? "msedge";
const beep = `<html><body><script>
  const a = new AudioContext();
  const o = a.createOscillator(); o.frequency.value = 440;
  const g = a.createGain(); g.gain.value = 0.3;
  o.connect(g).connect(a.destination); o.start();
</script></body></html>`;
const silent = `<html><body>silent<script>document.title="s"</script></body></html>`;

const server = http.createServer((q, s) => {
  s.writeHead(200, { "Content-Type": "text/html" });
  s.end(q.url === "/beep" ? beep : silent);
}).listen(8899, "127.0.0.1");

const launch = (extraEnv) => chromium.launch({
  headless: false,
  channel: channel === "msedge" ? "msedge" : undefined,
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  env: { ...process.env, ...extraEnv },
});

(async () => {
  // throwaway PA server for the noisy browser — separate socket, separate world
  const tmpSock = mkdtempSync(join(tmpdir(), "tpulse-"));
  const sock = join(tmpSock, "testpulse");
  spawn("pulseaudio", [
    "--daemonize", "--exit-idle-time=-1", "-n",
    `--load=module-native-protocol-unix socket=${sock}`,
    "--load=module-null-sink sink_name=junk",
  ]);
  await new Promise((r) => setTimeout(r, 800));

  const noisy = await launch({ PULSE_SERVER: sock, XDG_RUNTIME_DIR: tmpSock }); // junk server
  const beepPage = await noisy.newPage();
  await beepPage.goto("http://127.0.0.1:8899/beep");
  await beepPage.waitForTimeout(1200);

  // recorder browser: main server, single default sink — exactly like production
  const rec = await launch({});
  const silentPage = await rec.newPage();
  await silentPage.goto("http://127.0.0.1:8899/silent");
  await silentPage.waitForTimeout(800);

  const b64 = await silentPage.evaluate(async () => {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", selfBrowserSurface: "include", monitorTypeSurfaces: "exclude" },
      audio: true,
      preferCurrentTab: true,
    });
    const r = new MediaRecorder(s, { mimeType: "video/webm" });
    const chunks = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((res) => (r.onstop = res));
    r.start();
    await new Promise((res) => setTimeout(res, 3000));
    r.stop();
    await done;
    s.getTracks().forEach((t) => t.stop());
    const buf = await new Blob(chunks).arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  });

  require("node:fs").writeFileSync("/tmp/iso.webm", Buffer.from(b64, "base64"));
  console.log(`[${channel}] isolated browser captured while OTHER browser beeped → /tmp/iso.webm`);
  await Promise.all([noisy.close(), rec.close()]);
  server.close();
  try { execSync(`pactl -s ${sock} exit 2>/dev/null || pulseaudio -k 2>/dev/null || true`); } catch { /* fine */ }
})().catch((e) => { console.error("failed:", String(e).slice(0, 250)); process.exit(2); });
