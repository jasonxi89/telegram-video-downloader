// Message bridge: MAIN world <-> Service Worker (ISOLATED world)

// Upward: MAIN → background (status updates)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "tg-dl") return;
  chrome.runtime.sendMessage(event.data);
});

// Downward: background → MAIN (control commands + init data)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source !== "tg-dl-cmd" && msg.source !== "tg-dl-init") return;
  window.postMessage(msg, "*");
});
