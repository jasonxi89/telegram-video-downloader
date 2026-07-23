// Message bridge: MAIN world <-> Service Worker (ISOLATED world)

(() => {
  const BRIDGE_INSTANCE = crypto.randomUUID();
  globalThis.__TG_DL_BRIDGE_INSTANCE = BRIDGE_INSTANCE;

  const PAGE_ORIGIN = "https://web.telegram.org";
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

  function reportBridgeError(msg, err) {
    if (!isCurrentBridge()) return;
    window.postMessage(
      {
        source: "tg-dl-bridge",
        type: "bridge-error",
        id: typeof msg.id === "string" ? msg.id : "",
        error: err && err.message ? err.message : "Extension bridge unavailable",
      },
      PAGE_ORIGIN
    );
  }

  // Upward: MAIN -> background (status updates)
  window.addEventListener("message", (event) => {
    if (!isCurrentBridge()) return;
    if (event.source !== window || event.origin !== PAGE_ORIGIN) return;
    const msg = event.data;
    if (!msg || msg.source !== "tg-dl" || !STATUS_TYPES.has(msg.type)) return;

    try {
      chrome.runtime.sendMessage(msg).catch((err) => reportBridgeError(msg, err));
    } catch (err) {
      reportBridgeError(msg, err);
    }
  });

  // Downward: background -> MAIN (control commands + init data)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!isCurrentBridge()) return;
    if (!msg || !COMMAND_TYPES.has(msg.source)) return;
    window.postMessage(msg, PAGE_ORIGIN);
  });
})();
