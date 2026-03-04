// ── Core download engine (runs in MAIN world) ──
// Sequential chunked Range requests (Telegram SW requires sequential access)

if (!window.__TG_DL_LOADED) {
  window.__TG_DL_LOADED = true;

  const RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;
  window.__TG_DL_ACTIVE = {};

  function generateFilename(url) {
    if (url) {
      // Web K: stream/{URL-encoded JSON} — has original fileName + document id
      if (url.includes("stream/")) {
        try {
          const json = JSON.parse(decodeURIComponent(url.split("stream/")[1]));
          if (json.fileName) return json.fileName;
          if (json.location && json.location.id) return json.location.id + ".mp4";
        } catch {}
      }

      // Web A: /progressive/document{ID}
      const match = url.match(/document(\d+)/);
      if (match) return match[1] + ".mp4";
    }

    // Fallback: timestamp-based name
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      "telegram_video_" +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "_" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds()) +
      ".mp4"
    );
  }

  function postStatus(type, detail) {
    window.postMessage({ source: "tg-dl", type, ...detail }, "*");
  }

  // Control commands from popup via content script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "tg-dl-cmd") return;
    const { action, id } = event.data;
    const dl = window.__TG_DL_ACTIVE[id];
    if (!dl) return;

    if (action === "pause") {
      dl.paused = true;
      postStatus("dl-pause", { id });
    } else if (action === "resume") {
      dl.paused = false;
      postStatus("dl-resume", { id });
      dl.fetchNext();
    } else if (action === "cancel") {
      dl.cancelled = true;
      if (dl.controller) dl.controller.abort();
      if (dl.onError) dl.onError("Cancelled");
      delete window.__TG_DL_ACTIVE[id];
      postStatus("dl-cancel", { id });
    }
  });

  window.__TG_DL = function (url, opts = {}) {
    const { onProgress, onComplete, onError } = opts;
    const id =
      "dl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const filename = generateFilename(url);
    const blobs = [];
    let offset = 0;
    let total = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = 0;

    const controller = new AbortController();
    const dlState = {
      paused: false,
      cancelled: false,
      controller,
      onError,
      fetchNext: null,
    };

    postStatus("dl-start", { id, filename, total: 0 });

    function fetchNext() {
      if (dlState.paused || dlState.cancelled) return;

      fetch(url, {
        method: "GET",
        headers: { Range: "bytes=" + offset + "-" },
        signal: controller.signal,
      })
        .then((res) => {
          if (res.status !== 200 && res.status !== 206) {
            throw new Error("HTTP " + res.status);
          }

          const range = res.headers.get("Content-Range");
          const match = range && range.match(RANGE_REGEX);

          if (match) {
            offset = parseInt(match[2]) + 1;
            total = parseInt(match[3]);
          } else if (res.status === 200 && offset === 0) {
            total = parseInt(res.headers.get("Content-Length")) || 0;
            offset = total;
          }

          const now = Date.now();
          const elapsed = now - lastTime;
          if (elapsed > 300) {
            speed = ((offset - lastBytes) / elapsed) * 1000;
            lastBytes = offset;
            lastTime = now;
          }

          const pct = total
            ? Math.min(100, Math.round((offset * 100) / total))
            : 0;

          if (onProgress && total) onProgress(pct);
          postStatus("dl-progress", { id, offset, total, pct, speed });

          return res.blob();
        })
        .then((blob) => {
          if (!blob) return;
          blobs.push(blob);

          if (total && offset < total) {
            fetchNext();
          } else {
            const finalBlob = new Blob(blobs, { type: "video/mp4" });
            triggerSave(finalBlob, filename);
            if (onComplete) onComplete();
            postStatus("dl-complete", { id, filename, total: finalBlob.size });
            delete window.__TG_DL_ACTIVE[id];
          }
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          console.error("[TG DL] Error:", err);
          if (onError) onError(err.message);
          postStatus("dl-error", { id, error: err.message });
          delete window.__TG_DL_ACTIVE[id];
        });
    }

    dlState.fetchNext = fetchNext;
    window.__TG_DL_ACTIVE[id] = dlState;
    fetchNext();
  };

  function triggerSave(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    console.log(
      "[TG DL] Saved:",
      filename,
      (blob.size / 1024 / 1024).toFixed(1) + "MB"
    );
  }

  console.log("[TG DL] Core downloader loaded (sequential Range requests)");
}
