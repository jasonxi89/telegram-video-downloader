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
let stateRestored = false;
// Preserve event order until stored ownership and download state are available.
const restoringMessages = [];

function refreshActivity(dl, tabId, observedAt) {
  if (!dl || dl.tabId !== tabId || !["active", "paused"].includes(dl.status)) return false;
  const previous = Number.isFinite(dl.updatedAt) ? dl.updatedAt : 0;
  dl.updatedAt = Math.max(previous, observedAt);
  delete dl.activityWarning;
  return true;
}

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

function rememberCompletedKey(key) {
  if (!key || completedUrls.includes(key)) return;
  completedUrls.push(key);
  if (completedUrls.length > 500) completedUrls.shift();
}

const STATUS_TYPES = new Set([
  "dl-start",
  "dl-progress",
  "dl-activity",
  "dl-retry-error",
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
  if (rawMsg.retryOf !== undefined) {
    if (typeof rawMsg.retryOf !== "string" || !DOWNLOAD_ID_PATTERN.test(rawMsg.retryOf)) return null;
    msg.retryOf = rawMsg.retryOf;
  }
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
  if (rawMsg.type === "dl-error" || rawMsg.type === "dl-retry-error") {
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
  if (!stateRestored || saveTimer) return;
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ downloads, completedUrls }).catch(() => {});
    saveTimer = null;
  }, 2000);
}
function saveStateNow() {
  if (!stateRestored) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  chrome.storage.local.set({ downloads, completedUrls }).catch(() => {});
}

// Restore first, replay received events in order, then classify stale rows.
chrome.storage.local.get(["downloads", "completedUrls"], (data) => {
  try {
    data = data && typeof data === "object" ? data : {};
    if (Array.isArray(data.completedUrls)) {
      for (const url of data.completedUrls) {
        if (typeof url === "string" && !completedUrls.includes(url)) {
          completedUrls.push(url);
        }
      }
    }
    if (data.downloads && typeof data.downloads === "object") {
      for (const [id, dl] of Object.entries(data.downloads)) {
        if (!DOWNLOAD_ID_PATTERN.test(id) || !dl || typeof dl !== "object" ||
            Array.isArray(dl) || dl.id !== id) continue;
        downloads[id] = { ...dl };
        delete downloads[id].commandError;
        delete downloads[id].retrying;
      }
    }
    // Use the same handler as live delivery; activity followed by error/cancel
    // must not become a resurrected active row, even across worker startup.
    for (const event of restoringMessages) {
      try {
        applyStatusMessage(event.msg, event.tabId, event.observedAt);
      } catch (err) {
        console.error("[TG DL] Failed to replay status", event.msg.id, err);
      }
    }
    const now = Date.now();
    for (const dl of Object.values(downloads)) {
      if (dl && ["active", "paused", "cancelling"].includes(dl.status) &&
          now - dl.updatedAt > 60000) {
        dl.status = "error";
        dl.error = "Download interrupted";
        dl.speed = 0;
      }
    }
    stateRestored = true;
    // Badge/UI failures must not suppress authoritative persistence/snapshot.
    try { updateBadge(); } catch (err) { console.warn("[TG DL] Badge unavailable", err); }
    saveStateNow();
    sendToPopup({ type: "state-snapshot", downloads: { ...downloads } });
  } catch (err) {
    console.error("[TG DL] Failed to restore state", err);
  } finally {
    restoringMessages.length = 0;
    stateRestored = true;
    resolveStateReady();
  }
});

function updateBadge() {
  const activeCount = Object.values(downloads).filter(
    (d) => d && d.status === "active"
  ).length;
  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: String(activeCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#3390ec" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function sendToPopup(msg) {
  if (!stateRestored || !popupPort) return;
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

// Status updates from content script
chrome.runtime.onMessage.addListener((rawMsg, sender) => {
  const msg = normalizeStatusMessage(rawMsg, sender);
  if (!msg) return;

  const tabId = sender.tab.id;
  const observedAt = Date.now();
  if (!stateRestored) {
    restoringMessages.push({ msg, tabId, observedAt });
    return;
  }
  applyStatusMessage(msg, tabId, observedAt);
});

function applyStatusMessage(msg, tabId, observedAt) {
  const { type, id } = msg;
  if (downloads[id] && downloads[id].tabId !== tabId) return;
  if (type === "dl-retry-error") {
    retryFailed(id, msg.error);
    return;
  }
  if (type === "dl-start" && msg.retryOf) {
    const old = downloads[msg.retryOf];
    if (!old || old.tabId !== tabId || old.url !== msg.url || old.status !== "error") {
      sendCommand(tabId, "cancel", id).catch(() => {});
      return;
    }
    removeDownload(old.id, false);
  }
  if (type === "dl-activity") {
    if (refreshActivity(downloads[id], tabId, observedAt)) saveState();
    return;
  }
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
      updatedAt: observedAt,
    };
  } else if (type === "dl-progress") {
    // Only dl-start creates a task. Late progress cannot resurrect deleted rows.
    if (!downloads[id]) return;
    if (!downloads[id].key && msg.key) downloads[id].key = msg.key;
    downloads[id].offset = msg.offset;
    downloads[id].total = msg.total;
    downloads[id].pct = msg.pct;
    downloads[id].updatedAt = observedAt;

    // Paused: ignore residual progress from in-flight chunk
    if (downloads[id].status === "paused") {
      downloads[id].speed = 0;
      saveState();
      return;
    }
    downloads[id].speed = msg.speed;
    delete downloads[id].activityWarning;
  } else if (type === "dl-complete") {
    if (downloads[id]) {
      if (!downloads[id].key && msg.key) downloads[id].key = msg.key;
      clearRetry(id);
      downloads[id].status = "complete";
      downloads[id].pct = 100;
      downloads[id].speed = 0;
      downloads[id].filename = msg.filename;
      downloads[id].total = msg.total;
      downloads[id].updatedAt = observedAt;
      // Persist completed URL for inline button state (normalize to doc ID)
      const dlUrl = downloads[id].url;
      if (dlUrl) rememberCompletedKey(downloads[id].key || msg.key || extractDocKey(dlUrl));
    } else {
      // The file was saved even if its row was deleted or never persisted;
      // keep the inline Done state without resurrecting history.
      rememberCompletedKey(msg.key || extractDocKey(msg.url));
    }
  } else if (type === "dl-error") {
    if (downloads[id]) {
      clearRetry(id);
      downloads[id].status = "error";
      downloads[id].error = msg.error;
      downloads[id].speed = 0;
      downloads[id].updatedAt = observedAt;
    }
  } else if (type === "dl-pause") {
    if (downloads[id]) {
      downloads[id].status = "paused";
      downloads[id].speed = 0;
      downloads[id].updatedAt = observedAt;
    }
  } else if (type === "dl-resume") {
    if (downloads[id]) {
      downloads[id].status = "active";
      downloads[id].updatedAt = observedAt;
    }
  } else if (type === "dl-cancel") {
    clearPendingCancel(id);
    clearRetry(id);
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
}

// Keep control/UI lifecycle separate from storage and status ingestion.
// Must stay a synchronous top-level import: applyStatusMessage and the storage
// restore callback call functions defined there, and MV3 rejects late imports.
importScripts("download-actions.js");
