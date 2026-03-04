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
  if (status === "paused") return 1;
  if (status === "error") return 2;
  return 3;
}

function render() {
  const items = Object.values(downloads).sort(
    (a, b) =>
      sortOrder(a.status) - sortOrder(b.status) || b.id.localeCompare(a.id)
  );

  // Show clear button when there are finished items
  const hasFinished = items.some(
    (d) => d.status === "complete" || d.status === "error"
  );
  clearBtn.classList.toggle("hidden", !hasFinished);

  if (items.length === 0) {
    listEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  listEl.innerHTML = items
    .map((dl) => {
      const statusLabel =
        dl.status === "active"
          ? dl.pct + "%"
          : dl.status === "paused"
            ? "Paused"
            : dl.status === "complete"
              ? "Done"
              : "Failed";

      const speedText = dl.speed ? " \u00b7 " + formatSpeed(dl.speed) : "";
      const detail =
        dl.status === "active"
          ? formatSize(dl.offset) + " / " + formatSize(dl.total) + speedText
          : dl.status === "paused"
            ? formatSize(dl.offset) + " / " + formatSize(dl.total)
            : dl.status === "complete"
              ? formatSize(dl.total)
              : dl.error || "Download failed";

      // Action buttons per status
      let buttons = "";
      if (dl.status === "active") {
        buttons =
          '<button class="dl-btn" data-action="pause" data-id="' +
          dl.id +
          '" title="Pause">\u23f8</button>';
      } else if (dl.status === "paused") {
        buttons =
          '<button class="dl-btn" data-action="resume" data-id="' +
          dl.id +
          '" title="Resume">\u25b6</button>';
      }
      buttons +=
        '<button class="dl-btn dl-btn-delete" data-action="' +
        (dl.status === "active" || dl.status === "paused"
          ? "cancel"
          : "delete") +
        '" data-id="' +
        dl.id +
        '" title="Remove">\u00d7</button>';

      return (
        '<div class="dl-item">' +
        '<div class="dl-row">' +
        '<span class="dl-filename" title="' +
        dl.filename +
        '">' +
        dl.filename +
        "</span>" +
        '<div class="dl-actions">' +
        '<span class="dl-status ' +
        dl.status +
        '">' +
        statusLabel +
        "</span>" +
        buttons +
        "</div>" +
        "</div>" +
        '<div class="dl-progress">' +
        '<div class="dl-progress-bar ' +
        dl.status +
        '" style="width:' +
        (dl.pct || 0) +
        '%"></div>' +
        "</div>" +
        '<div class="dl-detail">' +
        detail +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

// Event delegation for action buttons
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".dl-btn");
  if (!btn) return;
  const { action, id } = btn.dataset;
  port.postMessage({ action, id });
});

// Clear completed / errored downloads
clearBtn.addEventListener("click", () => {
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
