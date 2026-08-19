// relay: page (Playwright) -> window.postMessage -> background
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.autoschool) {
    chrome.runtime.sendMessage(e.data.autoschool, (resp) => {
      const err = chrome.runtime.lastError; // undefined = delivered
      if (err) console.warn("[auto-school] background unreachable:", err.message);
    });
  }
});

// surface capture errors into the page console (Node reads it via page.on console)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "capture-error") console.warn("[auto-school] capture-error:", msg.error);
});
