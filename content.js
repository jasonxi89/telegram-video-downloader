// Message bridge: MAIN world <-> Service Worker (ISOLATED world)

(() => {
  const BRIDGE_INSTANCE = crypto.randomUUID();
  globalThis.__TG_DL_BRIDGE_INSTANCE = BRIDGE_INSTANCE;

  const PAGE_ORIGIN = window.location.origin;
  const STATUS_TYPES = new Set([
    "dl-start",
    "dl-progress",
    "dl-complete",
    "dl-error",
    "dl-pause",
    "dl-resume",
    "dl-cancel",
  ]);
  const COMMAND_TYPES = new Set(["tg-dl-cmd", "tg-dl-init"]);

  function isCurrentBridge() {
    return globalThis.__TG_DL_BRIDGE_INSTANCE === BRIDGE_INSTANCE;
  }

  function reportBridgeError(err) {
    if (!isCurrentBridge()) return;
    console.warn(
      "[TG DL] Extension bridge unavailable:",
      err && err.message ? err.message : err
    );
  }

  // Upward: MAIN -> background (status updates)
  window.addEventListener("message", (event) => {
    if (!isCurrentBridge()) return;
    if (event.source !== window || event.origin !== PAGE_ORIGIN) return;
    const msg = event.data;
    if (!msg || msg.source !== "tg-dl" || !STATUS_TYPES.has(msg.type)) return;

    try {
      chrome.runtime.sendMessage(msg).catch(reportBridgeError);
    } catch (err) {
      reportBridgeError(err);
    }
  });

  // Downward: background -> MAIN (control commands + init data)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!isCurrentBridge()) return;
    if (!msg || !COMMAND_TYPES.has(msg.source)) return;
    window.postMessage(msg, PAGE_ORIGIN);
  });
})();
