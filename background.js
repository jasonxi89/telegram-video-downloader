// ── Service Worker: tab injection + download state management ──

const TELEGRAM_ORIGIN = "https://web.telegram.org";
let resolveStateReady;
const stateReady = new Promise((resolve) => {
  resolveStateReady = resolve;
});

function telegramVariant(url) {
  if (!url || !url.startsWith(TELEGRAM_ORIGIN + "/")) return null;
  const path = new URL(url).pathname;
  if (path.startsWith("/a")) return "a";
  if (path.startsWith("/k")) return "k";
  return null;
}

async function injectTab(tabId, url) {
  const variant = telegramVariant(url);
  if (!variant) return;

  try {
    // Reinstall the isolated-world bridge after an extension reload.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
      world: "ISOLATED",
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["downloader.js", variant === "a" ? "inject_a.js" : "inject_k.js"],
      world: "MAIN",
    });
    await stateReady;
    if (completedUrls.length > 0) {
      await chrome.tabs.sendMessage(tabId, {
        source: "tg-dl-init",
        completedUrls,
      });
    }
  } catch (err) {
    console.warn("[TG DL] Failed to inject tab", tabId, err);
  }
}

// ── Tab injection ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") injectTab(tabId, tab.url);
});

async function injectOpenTelegramTabs() {
  const tabs = await chrome.tabs.query({ url: TELEGRAM_ORIGIN + "/*" });
  await Promise.allSettled(tabs.map((tab) => injectTab(tab.id, tab.url)));
}

chrome.runtime.onInstalled.addListener(() => {
  injectOpenTelegramTabs().catch((err) => {
    console.warn("[TG DL] Failed to restore open tabs", err);
  });
});
chrome.runtime.onStartup.addListener(() => {
  injectOpenTelegramTabs().catch((err) => {
    console.warn("[TG DL] Failed to restore open tabs", err);
  });
});

// ── Download state ──
let downloads = {};
let completedUrls = [];
let popupPort = null;
const pendingCancelTimers = new Map();
const pendingCommandTimers = new Map();

function extractDocKey(url) {
  if (!url) return url;
  const m = url.match(/document(\d+)/);
  if (m) return "doc:" + m[1];
  if (url.includes("stream/")) {
    try {
      const json = JSON.parse(decodeURIComponent(url.split("stream/")[1]));
      if (json.location && json.location.id) return "doc:" + json.location.id;
    } catch {}
  }
  return url;
}

const STATUS_TYPES = new Set([
  "dl-start",
  "dl-progress",
  "dl-complete",
  "dl-error",
  "dl-pause",
  "dl-resume",
  "dl-cancel",
]);
const DOWNLOAD_ID_PATTERN = /^dl_\d+_[a-z0-9]{6}$/;

function isDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.origin === TELEGRAM_ORIGIN;
  } catch {
    return false;
  }
}

function isDownloadKey(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  return /^(?:doc:\d+|msg:-?\d+:-?\d+)$/.test(value) || isDownloadUrl(value);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeStatusMessage(rawMsg, sender) {
  const senderUrl = sender.url || (sender.tab && sender.tab.url);
  if (!sender.tab || (sender.frameId ?? 0) !== 0 || !telegramVariant(senderUrl)) {
    return null;
  }
  if (!rawMsg || rawMsg.source !== "tg-dl" || !STATUS_TYPES.has(rawMsg.type)) {
    return null;
  }
  if (typeof rawMsg.id !== "string" || !DOWNLOAD_ID_PATTERN.test(rawMsg.id)) {
    return null;
  }

  const msg = { source: "tg-dl", type: rawMsg.type, id: rawMsg.id };
  if (typeof rawMsg.url === "string" && isDownloadUrl(rawMsg.url)) {
    msg.url = rawMsg.url;
  }
  if (isDownloadKey(rawMsg.key)) msg.key = rawMsg.key;
  if (
    (rawMsg.type === "dl-start" ||
      rawMsg.type === "dl-progress" ||
      rawMsg.type === "dl-complete") &&
    !msg.url
  ) {
    return null;
  }

  if (rawMsg.type === "dl-start" || rawMsg.type === "dl-complete") {
    msg.filename =
      typeof rawMsg.filename === "string"
        ? rawMsg.filename.slice(0, 512)
        : "unknown_video.mp4";
  }
  if (rawMsg.type === "dl-progress") {
    msg.offset = finiteNumber(rawMsg.offset);
    msg.total = finiteNumber(rawMsg.total);
    msg.pct = Math.min(100, finiteNumber(rawMsg.pct));
    msg.speed = finiteNumber(rawMsg.speed);
  }
  if (rawMsg.type === "dl-complete") {
    msg.total = finiteNumber(rawMsg.total);
  }
  if (rawMsg.type === "dl-error") {
    msg.error =
      typeof rawMsg.error === "string"
        ? rawMsg.error.slice(0, 1000)
        : "Download failed";
  }
  return msg;
}

// Persist state to local storage — throttled to max once per 2s
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ downloads, completedUrls }).catch(() => {});
    saveTimer = null;
  }, 2000);
}
function saveStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  chrome.storage.local.set({ downloads, completedUrls }).catch(() => {});
}

// Restore on startup — merge with any entries added during async gap
chrome.storage.local.get(["downloads", "completedUrls"], (data) => {
  try {
    if (Array.isArray(data.completedUrls)) {
      for (const url of data.completedUrls) {
        if (typeof url === "string" && !completedUrls.includes(url)) {
          completedUrls.push(url);
        }
      }
    }
    if (data.downloads && typeof data.downloads === "object") {
      const now = Date.now();
      for (const dl of Object.values(data.downloads)) {
        if (!dl) continue;
        // Transient command-feedback note must not survive a SW restart
        delete dl.commandError;
        if (
          (dl.status === "active" ||
            dl.status === "paused" ||
            dl.status === "cancelling") &&
          now - dl.updatedAt > 60000
        ) {
          dl.status = "error";
          dl.error = "Download interrupted";
          dl.speed = 0;
        }
      }
      // Merge: stored entries first, then any new ones added during async restore
      downloads = { ...data.downloads, ...downloads };
    }
    updateBadge();
    saveStateNow();
    sendToPopup({ type: "state-snapshot", downloads: { ...downloads } });
  } catch (err) {
    console.error("[TG DL] Failed to restore state", err);
  } finally {
    resolveStateReady();
  }
});

function updateBadge() {
  const activeCount = Object.values(downloads).filter(
    (d) => d.status === "active"
  ).length;
  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: String(activeCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#3390ec" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function sendToPopup(msg) {
  if (!popupPort) return;
  try {
    popupPort.postMessage(msg);
  } catch {
    popupPort = null;
  }
}

function sendCommand(tabId, action, id) {
  if (!tabId) return Promise.reject(new Error("No tabId"));
  return chrome.tabs.sendMessage(tabId, { source: "tg-dl-cmd", action, id });
}

function clearPendingCancel(id) {
  const timer = pendingCancelTimers.get(id);
  if (timer) clearTimeout(timer);
  pendingCancelTimers.delete(id);
}

function markCancelFailed(id, error) {
  clearPendingCancel(id);
  const dl = downloads[id];
  if (!dl) return;
  dl.status = "error";
  dl.error = error || "Unable to cancel download";
  dl.speed = 0;
  dl.updatedAt = Date.now();
  updateBadge();
  saveStateNow();
  sendToPopup({ type: "dl-update", download: dl });
}

function requestCancel(dl) {
  if (pendingCancelTimers.has(dl.id) || dl.status === "cancelling") return;
  dl.status = "cancelling";
  dl.speed = 0;
  dl.updatedAt = Date.now();
  updateBadge();
  saveStateNow();
  sendToPopup({ type: "dl-update", download: dl });

  const timer = setTimeout(() => {
    markCancelFailed(dl.id, "Cancel was not confirmed by the page");
  }, 2000);
  pendingCancelTimers.set(dl.id, timer);
  sendCommand(dl.tabId, "cancel", dl.id).catch((err) => {
    markCancelFailed(
      dl.id,
      err && err.message ? err.message : "Unable to cancel download"
    );
  });
}

function clearPendingCommand(id) {
  const timer = pendingCommandTimers.get(id);
  if (timer) clearTimeout(timer);
  pendingCommandTimers.delete(id);
}

// Pause/resume are not destructive, so an unconfirmed command keeps the
// truthful status and surfaces a transient note instead of flipping to error.
function markCommandUnconfirmed(id, action) {
  clearPendingCommand(id);
  const dl = downloads[id];
  if (!dl) return;
  dl.commandError =
    (action === "pause" ? "Pause" : "Resume") +
    " was not confirmed by the page";
  dl.updatedAt = Date.now();
  sendToPopup({ type: "dl-update", download: dl });
}

function requestPauseResume(dl, action) {
  if (pendingCommandTimers.has(dl.id)) return;
  delete dl.commandError;
  const timer = setTimeout(() => {
    markCommandUnconfirmed(dl.id, action);
  }, 2000);
  pendingCommandTimers.set(dl.id, timer);
  // Status is not updated here — the dl-pause/dl-resume ack does it.
  sendCommand(dl.tabId, action, dl.id).catch(() => {
    markCommandUnconfirmed(dl.id, action);
  });
}

// Status updates from content script
chrome.runtime.onMessage.addListener((rawMsg, sender) => {
  const msg = normalizeStatusMessage(rawMsg, sender);
  if (!msg) return;

  const { type, id } = msg;
  const tabId = sender.tab.id;
  if (downloads[id] && downloads[id].tabId !== tabId) return;
  if (type === "dl-complete" || type === "dl-error" || type === "dl-cancel") {
    clearPendingCancel(id);
  }
  // Acks and terminal states settle any pending pause/resume command.
  // dl-progress deliberately does not: it proves the bridge is alive but not
  // that the command was applied.
  if (type !== "dl-start" && type !== "dl-progress") {
    clearPendingCommand(id);
    if (downloads[id]) delete downloads[id].commandError;
  }

  if (type === "dl-start") {
    downloads[id] = {
      id,
      filename: msg.filename,
      url: msg.url || "",
      key: msg.key || extractDocKey(msg.url),
      status: "active",
      offset: 0,
      total: 0,
      pct: 0,
      speed: 0,
      tabId,
      updatedAt: Date.now(),
    };
  } else if (type === "dl-progress") {
    if (!downloads[id]) {
      downloads[id] = {
        id,
        filename: "unknown_video.mp4",
        url: msg.url,
        key: msg.key || extractDocKey(msg.url),
        status: "active",
        offset: 0,
        total: 0,
        pct: 0,
        speed: 0,
        tabId,
        updatedAt: Date.now(),
      };
    }
    if (!downloads[id].key && msg.key) downloads[id].key = msg.key;
    downloads[id].offset = msg.offset;
    downloads[id].total = msg.total;
    downloads[id].pct = msg.pct;
    downloads[id].updatedAt = Date.now();

    // Paused: ignore residual progress from in-flight chunk
    if (downloads[id].status === "paused") {
      downloads[id].speed = 0;
      saveState();
      return;
    }
    downloads[id].speed = msg.speed;
  } else if (type === "dl-complete") {
    if (downloads[id]) {
      if (!downloads[id].key && msg.key) downloads[id].key = msg.key;
      downloads[id].status = "complete";
      downloads[id].pct = 100;
      downloads[id].speed = 0;
      downloads[id].filename = msg.filename;
      downloads[id].total = msg.total;
      downloads[id].updatedAt = Date.now();
      // Persist completed URL for inline button state (normalize to doc ID)
      const dlUrl = downloads[id].url;
      if (dlUrl) {
        const key = downloads[id].key || msg.key || extractDocKey(dlUrl);
        if (!completedUrls.includes(key)) {
          completedUrls.push(key);
          if (completedUrls.length > 500) completedUrls.shift();
        }
      }
    }
  } else if (type === "dl-error") {
    if (downloads[id]) {
      downloads[id].status = "error";
      downloads[id].error = msg.error;
      downloads[id].speed = 0;
      downloads[id].updatedAt = Date.now();
    }
  } else if (type === "dl-pause") {
    if (downloads[id]) {
      downloads[id].status = "paused";
      downloads[id].speed = 0;
      downloads[id].updatedAt = Date.now();
    }
  } else if (type === "dl-resume") {
    if (downloads[id]) {
      downloads[id].status = "active";
      downloads[id].updatedAt = Date.now();
    }
  } else if (type === "dl-cancel") {
    clearPendingCancel(id);
    delete downloads[id];
  }

  updateBadge();
  if (type === "dl-progress") {
    saveState(); // throttled
  } else {
    saveStateNow(); // immediate for status transitions
  }
  if (type === "dl-cancel") {
    sendToPopup({ type: "dl-delete", id });
  } else if (downloads[id]) {
    sendToPopup({ type: "dl-update", download: downloads[id] });
  }
});

// Popup connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;

  // Stale detection: 30s no update or 5s without cancel ACK -> error
  const now = Date.now();
  let staleStateChanged = false;
  for (const dl of Object.values(downloads)) {
    if (dl.status === "active" && now - dl.updatedAt > 30000) {
      dl.status = "error";
      dl.error = "Download stalled (no update for 30s)";
      dl.speed = 0;
      dl.updatedAt = now;
      staleStateChanged = true;
    } else if (
      dl.status === "cancelling" &&
      now - dl.updatedAt > 5000
    ) {
      dl.status = "error";
      dl.error = "Cancel was not confirmed by the page";
      dl.speed = 0;
      dl.updatedAt = now;
      staleStateChanged = true;
    }
  }
  updateBadge();
  if (staleStateChanged) saveStateNow();

  port.postMessage({ type: "state-snapshot", downloads: { ...downloads } });

  // Commands from popup — wait for confirmation, don't optimistically update
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string") return;
    if (msg.id !== undefined && typeof msg.id !== "string") return;
    const dl = downloads[msg.id];

    if (msg.action === "pause" && dl && dl.status === "active") {
      requestPauseResume(dl, "pause");
    } else if (msg.action === "resume" && dl && dl.status === "paused") {
      requestPauseResume(dl, "resume");
    } else if (
      msg.action === "cancel" &&
      dl &&
      (dl.status === "active" || dl.status === "paused")
    ) {
      // Keep the entry until downloader.js confirms dl-cancel. If delivery or
      // acknowledgement fails, retain a visible error instead of hiding it.
      requestCancel(dl);
    } else if (
      msg.action === "delete" &&
      dl &&
      dl.status !== "active" &&
      dl.status !== "paused"
    ) {
      delete downloads[msg.id];
      updateBadge();
      saveStateNow();
      sendToPopup({ type: "dl-delete", id: msg.id });
    } else if (msg.action === "clear-completed") {
      for (const id of Object.keys(downloads)) {
        const status = downloads[id].status;
        if (
          status === "active" ||
          status === "paused" ||
          status === "cancelling"
        ) {
          continue;
        }
        delete downloads[id];
      }
      completedUrls = [];
      updateBadge();
      saveStateNow();
      sendToPopup({ type: "state-snapshot", downloads: { ...downloads } });
    }
  });

  port.onDisconnect.addListener(() => {
    if (popupPort === port) popupPort = null;
  });
});
