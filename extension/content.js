// relay: page (Playwright) -> window.postMessage -> background
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.autoschool) {
    chrome.runtime.sendMessage(e.data.autoschool);
  }
});
