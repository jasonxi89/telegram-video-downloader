// ── Core download engine (runs in MAIN world) ──
// Sequential chunked Range requests (Telegram SW requires sequential access)

if (!window.__TG_DL_LOADED) {
  window.__TG_DL_LOADED = true;

  const RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;

  window.__TG_DL = function (url, opts = {}) {
    const { onProgress, onComplete, onError } = opts;
    const blobs = [];
    let offset = 0;
    let total = null;

    function fetchNext() {
      fetch(url, {
        method: "GET",
        headers: { Range: "bytes=" + offset + "-" },
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
            // Full response, no chunking
            total = parseInt(res.headers.get("Content-Length")) || 0;
            offset = total;
          }

          if (onProgress && total) {
            onProgress(Math.min(100, Math.round((offset * 100) / total)));
          }

          return res.blob();
        })
        .then((blob) => {
          blobs.push(blob);

          if (total && offset < total) {
            // More chunks to fetch
            fetchNext();
          } else {
            // Done — merge and save
            const finalBlob = new Blob(blobs, { type: "video/mp4" });
            triggerSave(finalBlob);
            if (onComplete) onComplete();
          }
        })
        .catch((err) => {
          console.error("[TG DL] Error:", err);
          if (onError) onError(err.message);
        });
    }

    fetchNext();
  };

  function triggerSave(blob) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts =
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "_" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());

    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "telegram_video_" + ts + ".mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    console.log(
      "[TG DL] Saved:",
      a.download,
      (blob.size / 1024 / 1024).toFixed(1) + "MB"
    );
  }

  console.log("[TG DL] Core downloader loaded (sequential Range requests)");
}
