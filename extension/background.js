// background: receives start/stop from the meeting page (via content relay),
// obtains a tabCapture streamId, hands it to the offscreen recorder.
let capturing = false;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "start" && sender.tab) {
    start(sender.tab.id, msg.port, msg.title).catch((e) =>
      console.error("capture start failed:", e));
    return false;
  }
  if (msg.type === "stop") {
    chrome.runtime.sendMessage({ type: "stop-recorder" }).catch(() => {});
    capturing = false;
  }
});

async function start(tabId, port, title) {
  if (capturing) return;
  capturing = true;

  // offscreen document must exist BEFORE the streamId is consumed
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Record the meeting tab via tabCapture",
      });
    }
  } catch { /* already exists */ }

  const streamId = await new Promise((res) =>
    chrome.tabCapture.getMediaStreamId({ target: { tabId } }, (id) => res(id)));
  if (!streamId) throw new Error("getMediaStreamId returned nothing (tab not capturable?)");

  await chrome.runtime.sendMessage({ type: "capture", streamId, port, title });
  console.log("auto-school: capture started for tab", tabId);
}
