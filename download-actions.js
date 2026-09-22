// Popup commands and download controls (loaded by background.js).

const retryTimers = new Map();

function clearRetry(id) {
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
  if (downloads[id]) delete downloads[id].retrying;
}

function retryFailed(id, error) {
  const dl = downloads[id];
  if (!dl || !dl.retrying) return;
  clearRetry(id);
  dl.commandError = error || "Retry not confirmed. Refresh Telegram before trying again.";
  saveStateNow();
  sendToPopup({ type: "dl-update", download: dl });
}

function requestRetry(dl) {
  if (dl.retrying || dl.status !== "error") return;
  if (!isDownloadUrl(dl.url) || !dl.tabId) {
    dl.commandError = "Open the video in Telegram and download it again (source unavailable).";
    sendToPopup({ type: "dl-update", download: dl });
    return;
  }
  dl.retrying = true;
  delete dl.commandError;
  sendToPopup({ type: "dl-update", download: dl });
  retryTimers.set(dl.id, setTimeout(() => retryFailed(dl.id), 5000));
  chrome.tabs.sendMessage(dl.tabId, {
    source: "tg-dl-cmd", action: "retry", id: dl.id, url: dl.url, key: dl.key,
  }).catch(() => retryFailed(dl.id, "Cannot reach Telegram. Refresh the original tab and try again."));
}

// Drop a row and its timers without persisting; callers batch save/notify.
function forgetDownload(id, stop) {
  const dl = downloads[id];
  if (!dl) return false;
  // Error may be an old timeout, not an engine terminal. Best-effort stop;
  // deletion is history removal, not a promise that an unreachable tab stopped.
  if (stop && dl.status === "error") sendCommand(dl.tabId, "cancel", id).catch(() => {});
  clearPendingCancel(id);
  clearPendingCommand(id);
  clearRetry(id);
  delete downloads[id];
  return true;
}

function removeDownload(id, stop = true) {
  if (!forgetDownload(id, stop)) return;
  updateBadge();
  persistDeletedDownload(id);
  sendToPopup({ type: "dl-delete", id });
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

// Popup connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;

  // Missing progress is a warning, not proof of engine failure.
  const now = Date.now();
  let staleStateChanged = false;
  for (const dl of Object.values(downloads)) {
    if (dl.status === "active" && now - dl.updatedAt > 30000) {
      dl.activityWarning = "No recent progress; the download may still be running.";
      dl.speed = 0;
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
    if (!stateRestored) {
      void stateReady.then(() => handlePopupCommand(msg));
      return;
    }
    handlePopupCommand(msg);
  });
  port.onDisconnect.addListener(() => {
    if (popupPort === port) {
      popupPort = null;
      if (deletedDownloadIds.size) saveStateNow();
    }
  });
});

function handlePopupCommand(msg) {
  if (msg.id !== undefined && typeof msg.id !== "string") return;
  const dl = downloads[msg.id];

  if (msg.action === "retry" && dl) {
    requestRetry(dl);
  } else if (msg.action === "pause" && dl && dl.status === "active") {
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
    dl.status !== "paused" && dl.status !== "cancelling" && !dl.retrying
  ) {
    removeDownload(msg.id);
  } else if (msg.action === "clear-completed") {
    for (const id of Object.keys(downloads)) {
      const status = downloads[id].status;
      if (
        status === "active" ||
        status === "paused" ||
        status === "cancelling" || downloads[id].retrying
      ) {
        continue;
      }
      forgetDownload(id, true);
    }
    completedUrls = [];
    updateBadge();
    saveStateNow();
    sendToPopup({ type: "state-snapshot", downloads: { ...downloads } });
  }
}
