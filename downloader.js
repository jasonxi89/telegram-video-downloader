// ── Core download engine (runs in MAIN world) ──
// Parallel chunked Range requests for fast downloads

if (!window.__TG_DL_LOADED) {
  window.__TG_DL_LOADED = true;

  const PARALLEL = 16; // concurrent connections
  const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB per chunk

  window.__TG_DL = async function (url, opts = {}) {
    const { onProgress, onComplete, onError } = opts;

    try {
      // Step 1: probe total size with a small Range request
      const probe = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
      });

      let totalSize = 0;
      const rangeHeader = probe.headers.get("Content-Range");
      if (rangeHeader) {
        // "bytes 0-0/12345678"
        const match = rangeHeader.match(/\/(\d+)$/);
        if (match) totalSize = parseInt(match[1]);
      }

      if (!totalSize) {
        // Fallback: full download (no Range support)
        console.log("[TG DL] No Range support, falling back to single fetch");
        const resp = await fetch(url);
        const blob = await resp.blob();
        triggerSave(blob);
        if (onComplete) onComplete();
        return;
      }

      console.log("[TG DL] Total size:", (totalSize / 1024 / 1024).toFixed(1), "MB");

      // Step 2: create chunk ranges
      const chunks = [];
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        chunks.push({ index: chunks.length, start, end, blob: null });
      }

      // Step 3: parallel download with concurrency limit
      let downloaded = 0;
      let nextChunk = 0;

      function reportProgress() {
        if (onProgress && totalSize) {
          onProgress(Math.min(100, Math.round((downloaded * 100) / totalSize)));
        }
      }

      async function worker() {
        while (nextChunk < chunks.length) {
          const chunk = chunks[nextChunk++];

          const resp = await fetch(url, {
            method: "GET",
            headers: {
              Range: "bytes=" + chunk.start + "-" + chunk.end,
            },
          });

          if (resp.status !== 200 && resp.status !== 206) {
            throw new Error("HTTP " + resp.status + " on chunk " + chunk.index);
          }

          chunk.blob = await resp.blob();
          downloaded += chunk.blob.size;
          reportProgress();
        }
      }

      // Launch parallel workers
      const workers = [];
      for (let i = 0; i < Math.min(PARALLEL, chunks.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      // Step 4: merge chunks in order
      const orderedBlobs = chunks.map((c) => c.blob);
      const finalBlob = new Blob(orderedBlobs, { type: "video/mp4" });
      triggerSave(finalBlob);

      if (onComplete) onComplete();
    } catch (err) {
      console.error("[TG DL] Error:", err);
      if (onError) onError(err.message);
    }
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
    console.log("[TG DL] Download triggered:", a.download,
      (blob.size / 1024 / 1024).toFixed(1) + "MB");
  }

  console.log("[TG DL] Core downloader loaded (parallel x" + PARALLEL + ")");
}
