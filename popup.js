const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const clearBtn = document.getElementById("clearBtn");
const moreBtn = document.getElementById("moreBtn");
const HISTORY_PAGE_SIZE = 100;
let historyLimit = HISTORY_PAGE_SIZE;
const downloads = {};
const downloadItems = new Map();
const itemNodes = new WeakMap();
let renderScheduled = false;
let connectionLost = false;

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "";
  if (bytesPerSec < 1024 * 1024)
    return (bytesPerSec / 1024).toFixed(0) + " KB/s";
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + " MB/s";
}

function sortOrder(status) {
  if (status === "active") return 0;
  if (status === "paused" || status === "cancelling") return 1;
  if (status === "error") return 2;
  return 3;
}

const VALID_STATUSES = new Set([
  "active",
  "paused",
  "cancelling",
  "complete",
  "error",
]);

function safeStatus(status) {
  return VALID_STATUSES.has(status) ? status : "error";
}

function safePercent(value) {
  const pct = Number(value);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
}

function createActionButton(action, id, label, text, destructive = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dl-btn";
  if (destructive) button.classList.add("dl-btn-delete");
  button.dataset.action = action;
  button.dataset.id = id;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

function updateDownloadItem(download, existingItem = null) {
  const dl = download && typeof download === "object" ? download : {};
  const id = typeof dl.id === "string" ? dl.id : "";
  const filename =
    typeof dl.filename === "string" ? dl.filename : "unknown_video.mp4";
  const status = safeStatus(dl.status);
  const pct = safePercent(dl.pct);
  const speedText = dl.speed ? " \u00b7 " + formatSpeed(dl.speed) : "";

  const statusLabel = dl.retrying ? "Retrying…" :
    status === "active"
      ? Math.round(pct) + "%"
      : status === "paused"
        ? "Paused"
        : status === "cancelling"
          ? "Cancelling"
          : status === "complete"
          ? "Done"
          : "Failed";
  const baseDetail =
    status === "active"
      ? formatSize(dl.offset) + " / " + formatSize(dl.total) + speedText
      : status === "paused" || status === "cancelling"
        ? formatSize(dl.offset) + " / " + formatSize(dl.total)
        : status === "complete"
          ? formatSize(dl.total)
          : typeof dl.error === "string"
            ? dl.error
            : "Download failed";
  const detail =
    typeof dl.commandError === "string" && dl.commandError
      ? baseDetail + " · ⚠ " + dl.commandError
      : dl.activityWarning ? baseDetail + " · " + dl.activityWarning : baseDetail;

  // Progress must not replace the button between pointer-down and pointer-up.
  const controlsKey = status + ":" + !!dl.retrying;
  const previous = existingItem && itemNodes.get(existingItem);
  if (previous && previous.controlsKey === controlsKey) {
    previous.filenameEl.title = filename;
    if (previous.filenameEl.textContent !== filename) previous.filenameEl.textContent = filename;
    if (previous.statusEl.textContent !== statusLabel) previous.statusEl.textContent = statusLabel;
    previous.progress.setAttribute("aria-valuenow", String(Math.round(pct)));
    previous.progressBar.style.width = pct + "%";
    if (previous.detailEl.textContent !== detail) previous.detailEl.textContent = detail;
    return existingItem;
  }

  const item = existingItem || document.createElement("div");
  if (existingItem) item.replaceChildren();
  item.className = "dl-item";
  item.dataset.id = id;

  const row = document.createElement("div");
  row.className = "dl-row";

  const filenameEl = document.createElement("span");
  filenameEl.className = "dl-filename";
  filenameEl.title = filename;
  filenameEl.textContent = filename;
  row.appendChild(filenameEl);

  const actions = document.createElement("div");
  actions.className = "dl-actions";

  const statusEl = document.createElement("span");
  statusEl.classList.add("dl-status", status);
  statusEl.textContent = statusLabel;
  actions.appendChild(statusEl);

  if (status === "active") {
    actions.appendChild(createActionButton("pause", id, "Pause", "\u23f8"));
  } else if (status === "paused") {
    actions.appendChild(createActionButton("resume", id, "Resume", "\u25b6"));
  }
  if (status === "error") {
    const retry = createActionButton("retry", id, "Retry download from the beginning", "Retry");
    retry.disabled = !!dl.retrying;
    actions.appendChild(retry);
  }
  if (status !== "cancelling" && !dl.retrying) {
    const removeAction =
      status === "active" || status === "paused" ? "cancel" : "delete";
    actions.appendChild(
      createActionButton(removeAction, id, "Remove", "\u00d7", true)
    );
  }
  row.appendChild(actions);
  item.appendChild(row);

  const progress = document.createElement("div");
  progress.className = "dl-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Download progress");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", String(Math.round(pct)));

  const progressBar = document.createElement("div");
  progressBar.classList.add("dl-progress-bar", status);
  progressBar.style.width = pct + "%";
  progress.appendChild(progressBar);
  item.appendChild(progress);

  const detailEl = document.createElement("div");
  detailEl.className = "dl-detail";
  detailEl.textContent = detail;
  item.appendChild(detailEl);
  itemNodes.set(item, { controlsKey, filenameEl, statusEl, progress, progressBar, detailEl });
  return item;
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const items = Object.values(downloads).sort(
    (a, b) =>
      sortOrder(a.status) - sortOrder(b.status) ||
      String(b.id).localeCompare(String(a.id))
  );
  const hasFinished = items.some(
    (dl) => dl.status === "complete" || dl.status === "error"
  );
  clearBtn.classList.toggle("hidden", !hasFinished);
  const visible = visibleItems(items);
  updateMoreButton(items.length - visible.length);
  const currentIds = new Set(visible.map((dl) => dl.id));
  for (const [id, entry] of downloadItems) {
    if (!currentIds.has(id)) {
      entry.element.remove();
      downloadItems.delete(id);
    }
  }

  if (items.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  // A frame queued before disconnection must not erase the connection notice.
  emptyEl.classList.toggle("hidden", !connectionLost);
  let next = listEl.firstChild;
  for (const dl of visible) {
    let entry = downloadItems.get(dl.id);
    if (!entry || entry.download !== dl) {
      entry = { element: updateDownloadItem(dl, entry && entry.element), download: dl };
      downloadItems.set(dl.id, entry);
    }
    // Only move rows when their order changes; reattaching every row also loses clicks.
    if (entry.element !== next) listEl.insertBefore(entry.element, next);
    next = entry.element.nextSibling;
  }
}

// With accessibility enabled (common on Windows), Chrome's work for each row
// removal grows with every rendered row: about 1s of browser UI stall per X at
// 2k rows. Unfinished downloads always render; finished history is paged.
function visibleItems(sortedItems) {
  const unfinished = sortedItems.filter((dl) => sortOrder(dl.status) < 2).length;
  return sortedItems.slice(0, unfinished + historyLimit);
}

function updateMoreButton(hiddenCount) {
  moreBtn.classList.toggle("hidden", hiddenCount === 0);
  if (hiddenCount > 0) {
    const nextPage = Math.min(HISTORY_PAGE_SIZE, hiddenCount);
    moreBtn.textContent = "Show " + nextPage + " more (" + hiddenCount + " hidden)";
  }
}

moreBtn.addEventListener("click", () => {
  historyLimit += HISTORY_PAGE_SIZE;
  scheduleRender();
});

// Event delegation for action buttons
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".dl-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  sendAction({ action, id });
});

// Wait for the authoritative snapshot instead of hiding an unconfirmed deletion.
clearBtn.addEventListener("click", () => {
  sendAction({ action: "clear-completed" });
});

function sendAction(message) {
  try {
    port.postMessage(message);
  } catch {
    connectionLost = true;
    emptyEl.textContent = "Extension connection lost. Close and reopen this panel.";
    emptyEl.classList.remove("hidden");
  }
}

// Connect to background
const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((msg) => {
  if (msg.type === "state-snapshot") {
    for (const key of Object.keys(downloads)) delete downloads[key];
    Object.assign(downloads, msg.downloads);
    scheduleRender();
  } else if (msg.type === "dl-update" && msg.download) {
    downloads[msg.download.id] = msg.download;
    scheduleRender();
  } else if (msg.type === "dl-delete" && msg.id) {
    delete downloads[msg.id];
    scheduleRender();
  }
});
