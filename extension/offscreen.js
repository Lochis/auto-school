// offscreen: owns the MediaRecorder. tabCapture stream -> 5-min webm segments
// -> base64 chunks -> http POST to the local auto-school sink.
const SEG_MS = 5 * 60_000;
let rec = null;

const log = (m) => fetch(`http://127.0.0.1:${rec?.port ?? 0}/log`, {
  method: "POST", body: m,
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "capture") begin(msg).catch((e) => log("ERROR " + e));
  if (msg.type === "stop-recorder") stop();
});

async function begin({ streamId, port, title }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
      },
    },
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });
  // tabCapture quirk: audio track stalls unless attached to an element
  const keepAlive = new Audio();
  keepAlive.srcObject = new MediaStream(stream.getAudioTracks());
  keepAlive.muted = true; // don't double-play; muted element still drives the track
  keepAlive.play();

  const vt = stream.getVideoTracks()[0];
  const st = vt?.getSettings?.() ?? {};
  rec = { port, idx: 0, stopped: false, stream, keepAlive };
  log(`META ${st.width ?? "?"}x${st.height ?? "?"} ${st.frameRate ?? "?"}fps`);

  const send = (idx, b64) =>
    fetch(`http://127.0.0.1:${port}/chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idx, b64, title }),
    }).catch((e) => log("CHUNK-ERR " + e));

  const startSegment = () => {
    const mr = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm;codecs=vp8,opus",
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    });
    mr.ondataavailable = (e) => {
      // capture idx NOW — reading it in onload races rotation
      const segIdx = rec.idx;
      if (!e.data.size) return;
      const r = new FileReader();
      // data-URL MIME contains commas ("codecs=vp8,opus") — slice from ;base64,
      r.onload = () => {
        const s = String(r.result);
        const i = s.indexOf(";base64,");
        send(segIdx, i >= 0 ? s.slice(i + 8) : s);
      };
      r.readAsDataURL(e.data);
    };
    mr.start(1000);
    rec.cur = mr;
  };
  startSegment();

  rec.timer = setInterval(() => {
    if (rec.stopped) return;
    rec.cur.onstop = () => {
      if (rec.stopped) return;
      rec.idx++;
      startSegment();
    };
    rec.cur.stop();
  }, SEG_MS);

  vt.addEventListener("ended", () => stop()); // tab closed / capture revoked
}

function stop() {
  if (!rec || rec.stopped) return;
  rec.stopped = true;
  clearInterval(rec.timer);
  const cur = rec.cur;
  const stream = rec.stream;
  rec = { ...rec, cur: null, stream: null };
  setTimeout(() => {
    try { cur?.state !== "inactive" && cur?.stop(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
  }, 800); // let last chunks flush through readers first
}
