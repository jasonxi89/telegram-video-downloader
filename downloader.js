// ── Core download engine (runs in MAIN world) ──
// Sequential chunked Range requests (Telegram SW requires sequential access)

if (!window.__TG_DL_LOADED) {
  window.__TG_DL_LOADED = true;

  const RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;
  const PAGE_ORIGIN = window.location.origin;
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
    window.postMessage({ source: "tg-dl", type, ...detail }, PAGE_ORIGIN);
  }

  function invokeCallback(callback, ...args) {
    if (typeof callback !== "function") return;
    try {
      callback(...args);
    } catch (err) {
      console.error("[TG DL] UI callback error:", err);
    }
  }

  // Control commands from popup via content script
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== PAGE_ORIGIN) return;
    if (!event.data || event.data.source !== "tg-dl-cmd") return;
    const { action, id } = event.data;
    const dl = window.__TG_DL_ACTIVE[id];
    if (!dl || dl.finished || dl.cancelled) return;

    if (action === "pause") {
      if (dl.paused) return;
      dl.paused = true;
      postStatus("dl-pause", { id, url: dl.url, key: dl.key });
    } else if (action === "resume") {
      if (!dl.paused) return;
      dl.paused = false;
      postStatus("dl-resume", { id, url: dl.url, key: dl.key });
      dl.fetchNext();
    } else if (action === "cancel") {
      dl.cancelled = true;
      if (dl.controller) dl.controller.abort();
      delete window.__TG_DL_ACTIVE[id];
      postStatus("dl-cancel", { id, url: dl.url, key: dl.key });
      invokeCallback(dl.onCancel);
    }
  });

  window.__TG_DL = function (url, opts = {}) {
    const { onProgress, onComplete, onError, onCancel } = opts;
    const key = typeof opts.key === "string" ? opts.key : "";
    const id =
      "dl_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const filename = generateFilename(url);
    const blobs = [];
    let offset = 0;
    let total = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = 0;

    const dlState = {
      url,
      key,
      paused: false,
      cancelled: false,
      finished: false,
      inFlight: false,
      controller: null,
      onCancel,
      fetchNext: null,
    };

    postStatus("dl-start", { id, filename, url, key, total: 0 });

    function fetchNext() {
      if (
        dlState.paused ||
        dlState.cancelled ||
        dlState.finished ||
        dlState.inFlight
      ) {
        return;
      }

      dlState.inFlight = true;
      const controller = new AbortController();
      dlState.controller = controller;

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
          } else if (res.status === 200) {
            // No Content-Range: server ignored Range header, treat as full response
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

          postStatus("dl-progress", {
            id,
            url,
            key,
            offset,
            total,
            pct,
            speed,
          });
          if (total) invokeCallback(onProgress, pct);

          return res.blob();
        })
        .then((blob) => {
          if (!blob || dlState.cancelled) return;
          blobs.push(blob);

          if (!total || offset >= total) {
            const finalBlob = new Blob(blobs, { type: "video/mp4" });
            triggerSave(finalBlob, filename);
            dlState.finished = true;
            delete window.__TG_DL_ACTIVE[id];
            postStatus("dl-complete", {
              id,
              filename,
              url,
              key,
              total: finalBlob.size,
            });
            invokeCallback(onComplete);
          }
        })
        .catch((err) => {
          if (err.name === "AbortError" && dlState.cancelled) return;
          if (dlState.finished || dlState.cancelled) return;
          dlState.finished = true;
          delete window.__TG_DL_ACTIVE[id];
          console.error("[TG DL] Error:", err);
          postStatus("dl-error", { id, url, key, error: err.message });
          invokeCallback(onError, err.message);
        })
        .finally(() => {
          if (dlState.controller === controller) dlState.controller = null;
          dlState.inFlight = false;
          if (
            !dlState.paused &&
            !dlState.cancelled &&
            !dlState.finished &&
            total &&
            offset < total
          ) {
            fetchNext();
          }
        });
    }

    dlState.fetchNext = fetchNext;
    window.__TG_DL_ACTIVE[id] = dlState;
    fetchNext();
    return id;
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
