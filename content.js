(() => {
  "use strict";

  const DL_BTN_CLASS = "tg-dl-btn";

  // ── Filename ──
  function generateFilename() {
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

  // ── Download ──
  async function downloadVideo(blobUrl) {
    if (!blobUrl) return;
    console.log("[TG Video DL] Downloading:", blobUrl.substring(0, 50));
    try {
      const resp = await fetch(blobUrl);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const filename = generateFilename();
      try {
        chrome.runtime.sendMessage(
          { action: "download", url, filename, saveAs: true },
          (r) => {
            if (chrome.runtime.lastError || !r || !r.success) {
              aDownload(url, filename);
            } else {
              setTimeout(() => URL.revokeObjectURL(url), 10000);
            }
          }
        );
      } catch {
        aDownload(url, filename);
      }
    } catch (err) {
      console.error("[TG Video DL] Download failed:", err);
    }
  }

  function aDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 5000);
  }

  // ── Bubble download button (below video in chat) ──
  function createBubbleButton(video) {
    const btn = document.createElement("div");
    btn.className = DL_BTN_CLASS;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right:4px;">' +
      '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>' +
      '<span>Download</span>';
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;" +
      "padding:4px 10px;margin-top:4px;border-radius:12px;cursor:pointer;" +
      "font-size:12px;line-height:16px;color:var(--primary-color,#3390ec);" +
      "background:var(--surface-color,rgba(0,0,0,0.04));" +
      "transition:background 0.15s;user-select:none;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "var(--light-secondary-text-color,rgba(0,0,0,0.08))";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "var(--surface-color,rgba(0,0,0,0.04))";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const src = video.src || video.currentSrc;
      if (src) {
        btn.querySelector("span").textContent = "Downloading...";
        downloadVideo(src).then(() => {
          btn.querySelector("span").textContent = "Download";
        });
      }
    });
    return btn;
  }

  // ── Media Viewer download button (topbar) ──
  function createViewerButton(video) {
    const btn = document.createElement("button");
    btn.className = DL_BTN_CLASS + " btn-icon default__button";
    btn.title = "Download Video";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">' +
      '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
    btn.style.cssText =
      "cursor:pointer;background:none;border:none;color:white;padding:8px;" +
      "display:flex;align-items:center;justify-content:center;border-radius:50%;" +
      "transition:background 0.2s;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(255,255,255,0.1)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "none";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadVideo(video.src || video.currentSrc);
    });
    return btn;
  }

  // ── Inject button below video in chat bubble ──
  function injectBubbleButton(video) {
    if (video.dataset.tgDl) return;
    const src = video.src || video.currentSrc;
    if (!src || !src.startsWith("blob:")) return;

    // Find the parent bubble
    const bubble = video.closest(".bubble");
    if (!bubble) return;
    // Already has a button?
    if (bubble.querySelector("." + DL_BTN_CLASS)) return;

    video.dataset.tgDl = "1";

    // Find the best place to insert: after the media container
    const attachment =
      video.closest(".attachment") ||
      video.closest(".media-container") ||
      video.closest(".media-container-aspecter") ||
      video.parentElement;
    if (!attachment) return;

    const btn = createBubbleButton(video);
    // Insert after the attachment container
    if (attachment.nextSibling) {
      attachment.parentElement.insertBefore(btn, attachment.nextSibling);
    } else {
      attachment.parentElement.appendChild(btn);
    }

    console.log("[TG Video DL] Button added below video in bubble");
  }

  // ── Inject button in media viewer topbar ──
  function injectViewerButton() {
    const viewer = document.querySelector(".media-viewer-whole");
    if (!viewer) return;
    if (viewer.querySelector("." + DL_BTN_CLASS)) return;

    const video = viewer.querySelector(
      ".media-viewer-mover.active video, .media-viewer-aspecter video"
    );
    if (!video) return;
    const src = video.src || video.currentSrc;
    if (!src) return;

    const buttonsBar = viewer.querySelector(".media-viewer-buttons");
    if (!buttonsBar) return;

    const btn = createViewerButton(video);
    buttonsBar.insertBefore(btn, buttonsBar.firstChild);
    console.log("[TG Video DL] Button added in media viewer topbar");
  }

  // ── Process a video element: inject now or watch for src ──
  const watchedVideos = new WeakSet();

  function processVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);

    const src = video.src || video.currentSrc;
    if (src && src.startsWith("blob:")) {
      injectBubbleButton(video);
    }

    // Watch for src changes (video loads later)
    const srcObserver = new MutationObserver(() => {
      const newSrc = video.src || video.currentSrc;
      if (newSrc && newSrc.startsWith("blob:")) {
        injectBubbleButton(video);
      }
    });
    srcObserver.observe(video, {
      attributes: true,
      attributeFilter: ["src"],
    });

    // Also listen for loadeddata event (some videos set src programmatically)
    video.addEventListener("loadeddata", () => {
      injectBubbleButton(video);
    }, { once: true });
  }

  // ── Scan all existing videos ──
  function scanVideos() {
    document.querySelectorAll("video").forEach(processVideo);
  }

  // ── Main observer: watch for new video elements + media viewer ──
  const mainObserver = new MutationObserver((mutations) => {
    let hasNewNodes = false;

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        hasNewNodes = true;

        // Direct video element added
        if (node.tagName === "VIDEO") {
          processVideo(node);
        }
        // Container with videos inside
        const videos = node.querySelectorAll?.("video");
        if (videos) {
          videos.forEach(processVideo);
        }
      }
    }

    // Check media viewer
    if (hasNewNodes) {
      injectViewerButton();
    }
  });

  mainObserver.observe(document.body, { childList: true, subtree: true });

  // ── Also poll for media viewer (backup, catches edge cases) ──
  setInterval(injectViewerButton, 1000);

  // ── Initial scan ──
  scanVideos();

  console.log("[TG Video DL] Extension loaded. Videos with blob src will get a download button.");
})();
