// ── Service Worker: tab injection + download state management ──

// ── Tab injection ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (!tab.url.startsWith("https://web.telegram.org/")) return;

  const isWebA = tab.url.includes("/a");
  const isWebK = tab.url.includes("/k");
  if (!isWebA && !isWebK) return;

  const files = ["downloader.js"];
  if (isWebA) files.push("inject_a.js");
  if (isWebK) files.push("inject_k.js");

  chrome.scripting
    .executeScript({ target: { tabId }, files, world: "MAIN" })
    .then(() => {
      if (completedUrls.length > 0) {
        chrome.tabs
          .sendMessage(tabId, {
            source: "tg-dl-init",
            completedUrls,
          })
          .catch(() => {});
      }
    })
    .catch(() => {});
});

// ── Download state ──
let downloads = {};
let completedUrls = [];
let popupPort = null;

// Persist state to local storage (survives browser restart)
function saveState() {
  chrome.storage.local.set({ downloads, completedUrls }).catch(() => {});
}

// Restore on startup — merge with any entries added during async gap
chrome.storage.local.get(["downloads", "completedUrls"], (data) => {
  if (data.completedUrls) {
    for (const u of data.completedUrls) {
      if (!completedUrls.includes(u)) completedUrls.push(u);
    }
  }
  if (data.downloads) {
    const now = Date.now();
    for (const dl of Object.values(data.downloads)) {
      if (
        (dl.status === "active" || dl.status === "paused") &&
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
  saveState();
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

// Status updates from content script
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.source !== "tg-dl") return;

  const { type, id } = msg;
  const tabId = sender.tab ? sender.tab.id : null;

  if (type === "dl-start") {
    downloads[id] = {
      id,
      filename: msg.filename,
      url: msg.url || "",
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
        status: "active",
        offset: 0,
        total: 0,
        pct: 0,
        speed: 0,
        tabId,
        updatedAt: Date.now(),
      };
    }
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
      downloads[id].status = "complete";
      downloads[id].pct = 100;
      downloads[id].speed = 0;
      downloads[id].filename = msg.filename;
      downloads[id].total = msg.total;
      downloads[id].updatedAt = Date.now();
      // Persist completed URL for inline button state (normalize to doc ID)
      const dlUrl = downloads[id].url;
      if (dlUrl) {
        const m = dlUrl.match(/document(\d+)/);
        const key = m ? "doc:" + m[1] : dlUrl;
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
    delete downloads[id];
  }

  updateBadge();
  saveState();
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

  // Stale detection: 30s no update → error
  const now = Date.now();
  for (const dl of Object.values(downloads)) {
    if (dl.status === "active" && now - dl.updatedAt > 30000) {
      dl.status = "error";
      dl.error = "Download stalled (no update for 30s)";
      dl.speed = 0;
    }
  }
  updateBadge();

  port.postMessage({ type: "state-snapshot", downloads: { ...downloads } });

  // Commands from popup — wait for confirmation, don't optimistically update
  port.onMessage.addListener((msg) => {
    const dl = downloads[msg.id];

    if (msg.action === "pause" && dl) {
      sendCommand(dl.tabId, "pause", msg.id).catch(() => {
        // Command failed to reach downloader — notify popup
        sendToPopup({ type: "dl-update", download: dl });
      });
      // Don't update status here — wait for dl-pause confirmation from downloader
    } else if (msg.action === "resume" && dl) {
      sendCommand(dl.tabId, "resume", msg.id).catch(() => {
        sendToPopup({ type: "dl-update", download: dl });
      });
      // Don't update status here — wait for dl-resume confirmation from downloader
    } else if (msg.action === "cancel") {
      if (dl) sendCommand(dl.tabId, "cancel", msg.id).catch(() => {});
      delete downloads[msg.id];
      updateBadge();
      saveState();
      sendToPopup({ type: "dl-delete", id: msg.id });
    } else if (msg.action === "delete") {
      delete downloads[msg.id];
      updateBadge();
      saveState();
      sendToPopup({ type: "dl-delete", id: msg.id });
    } else if (msg.action === "clear-completed") {
      for (const id of Object.keys(downloads)) {
        const status = downloads[id].status;
        if (status === "active" || status === "paused") continue;
        delete downloads[id];
      }
      completedUrls = [];
      updateBadge();
      saveState();
      sendToPopup({ type: "state-snapshot", downloads: { ...downloads } });
    }
  });

  port.onDisconnect.addListener(() => {
    popupPort = null;
  });
});
