const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const clearBtn = document.getElementById("clearBtn");
const downloads = {};

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

function createDownloadItem(download) {
  const dl = download && typeof download === "object" ? download : {};
  const id = typeof dl.id === "string" ? dl.id : "";
  const filename =
    typeof dl.filename === "string" ? dl.filename : "unknown_video.mp4";
  const status = safeStatus(dl.status);
  const pct = safePercent(dl.pct);
  const speedText = dl.speed ? " \u00b7 " + formatSpeed(dl.speed) : "";

  const statusLabel =
    status === "active"
      ? Math.round(pct) + "%"
      : status === "paused"
        ? "Paused"
        : status === "cancelling"
          ? "Cancelling"
          : status === "complete"
          ? "Done"
          : "Failed";
  const detail =
    status === "active"
      ? formatSize(dl.offset) + " / " + formatSize(dl.total) + speedText
      : status === "paused" || status === "cancelling"
        ? formatSize(dl.offset) + " / " + formatSize(dl.total)
        : status === "complete"
          ? formatSize(dl.total)
          : typeof dl.error === "string"
            ? dl.error
            : "Download failed";

  const item = document.createElement("div");
  item.className = "dl-item";

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
  if (status !== "cancelling") {
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
  return item;
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
  listEl.replaceChildren();

  if (items.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.appendChild(createDownloadItem(item));
  listEl.appendChild(fragment);
}

// Event delegation for action buttons
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".dl-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  // delete = finished item (error/complete): safe to remove immediately
  // cancel = active download: must wait for background to abort first
  if (action === "delete") {
    delete downloads[id];
    render();
  }
  port.postMessage({ action, id });
});

// Clear completed / errored downloads — optimistic, only touches finished items
clearBtn.addEventListener("click", () => {
  for (const id of Object.keys(downloads)) {
    const status = downloads[id].status;
    if (
      status !== "active" &&
      status !== "paused" &&
      status !== "cancelling"
    ) {
      delete downloads[id];
    }
  }
  render();
  port.postMessage({ action: "clear-completed" });
});

// Connect to background
const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((msg) => {
  if (msg.type === "state-snapshot") {
    for (const key of Object.keys(downloads)) delete downloads[key];
    Object.assign(downloads, msg.downloads);
    render();
  } else if (msg.type === "dl-update" && msg.download) {
    downloads[msg.download.id] = msg.download;
    render();
  } else if (msg.type === "dl-delete" && msg.id) {
    delete downloads[msg.id];
    render();
  }
});
