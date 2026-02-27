(() => {
  "use strict";

  const DL_BTN_CLASS = "tg-dl-btn";
  const POLL_MS = 800;

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
  async function downloadVideo(videoEl, btnEl) {
    const src = videoEl.src || videoEl.currentSrc;
    if (!src) return;

    if (btnEl) {
      btnEl.dataset.origText = btnEl.textContent;
      btnEl.textContent = "⏳";
      btnEl.style.pointerEvents = "none";
    }

    console.log("[TG Video DL] Downloading:", src.substring(0, 60));

    try {
      const resp = await fetch(src);
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
    } finally {
      if (btnEl) {
        btnEl.textContent = btnEl.dataset.origText || "⬇";
        btnEl.style.pointerEvents = "";
      }
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

  // ── Generic: find all downloadable videos on page ──
  function findDownloadableVideos() {
    return Array.from(document.querySelectorAll("video")).filter((v) => {
      const src = v.src || v.currentSrc;
      return src && src.startsWith("blob:");
    });
  }

  // ── Determine if a video is in a full-screen/media viewer overlay ──
  function isInMediaViewer(video) {
    let el = video;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      // Full-screen overlay: fixed/absolute position covering the viewport
      if (
        (style.position === "fixed" || style.position === "absolute") &&
        parseInt(style.width) > window.innerWidth * 0.5 &&
        parseInt(style.height) > window.innerHeight * 0.5
      ) {
        return el;
      }
      // Known class names (Web K + Web A)
      if (
        el.classList.contains("media-viewer-whole") ||     // Web K
        el.classList.contains("MediaViewer") ||             // Web A
        el.classList.contains("media-viewer") ||            // Generic
        el.id === "MediaViewer"                             // Web A alt
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ── Create download button for media viewer (floating top-right) ──
  function createViewerButton(video) {
    const btn = document.createElement("button");
    btn.className = DL_BTN_CLASS;
    btn.textContent = "⬇";
    btn.title = "Download Video";
    btn.style.cssText =
      "position:fixed;top:16px;right:60px;z-index:2147483647;" +
      "width:44px;height:44px;border-radius:50%;border:none;" +
      "background:rgba(0,0,0,0.6);color:#fff;font-size:22px;" +
      "cursor:pointer;display:flex;align-items:center;justify-content:center;" +
      "backdrop-filter:blur(4px);transition:background 0.2s;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(0,0,0,0.85)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(0,0,0,0.6)";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadVideo(video, btn);
    });
    return btn;
  }

  // ── Create download button for inline video (below video) ──
  function createInlineButton(video) {
    const btn = document.createElement("div");
    btn.className = DL_BTN_CLASS;
    btn.textContent = "⬇ Download";
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;" +
      "padding:4px 12px;margin-top:4px;border-radius:12px;cursor:pointer;" +
      "font-size:12px;line-height:16px;color:#3390ec;" +
      "background:rgba(51,144,236,0.08);" +
      "transition:background 0.15s;user-select:none;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(51,144,236,0.16)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(51,144,236,0.08)";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadVideo(video, btn);
    });
    return btn;
  }

  // ── Main scan: find videos, add buttons ──
  function scan() {
    const videos = findDownloadableVideos();

    for (const video of videos) {
      if (video.dataset.tgDl === "1") continue;

      const viewerContainer = isInMediaViewer(video);

      if (viewerContainer) {
        // Media viewer: add fixed-position button on screen
        if (document.querySelector("." + DL_BTN_CLASS + "[style*='fixed']")) {
          continue; // Already have a viewer button
        }
        video.dataset.tgDl = "1";
        const btn = createViewerButton(video);
        document.body.appendChild(btn);
        console.log("[TG Video DL] Viewer download button added");

        // Remove button when viewer closes
        const closeWatcher = setInterval(() => {
          if (!document.body.contains(viewerContainer) || !viewerContainer.offsetParent) {
            btn.remove();
            video.dataset.tgDl = "";
            clearInterval(closeWatcher);
            console.log("[TG Video DL] Viewer closed, button removed");
          }
        }, 500);
      } else {
        // Inline video in chat bubble
        video.dataset.tgDl = "1";

        // Find the message container to append button after video area
        const container =
          video.closest(".attachment") ||
          video.closest(".media-container") ||
          video.closest(".media-inner") ||
          video.closest(".Message") ||
          video.closest(".bubble") ||
          video.parentElement;

        if (!container) continue;

        // Don't add duplicate
        if (container.parentElement.querySelector("." + DL_BTN_CLASS)) continue;

        const btn = createInlineButton(video);
        container.after(btn);
        console.log("[TG Video DL] Inline download button added");
      }
    }
  }

  // ── Watch for src changes on all video elements ──
  const watchedVideos = new WeakSet();

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);

    // Observe src attribute changes
    const obs = new MutationObserver(() => scan());
    obs.observe(video, { attributes: true, attributeFilter: ["src"] });

    // Also listen for loadeddata
    video.addEventListener("loadeddata", () => scan(), { once: true });
  }

  // ── MutationObserver: detect new video elements ──
  const mainObserver = new MutationObserver((mutations) => {
    let found = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName === "VIDEO") {
          watchVideo(node);
          found = true;
        }
        const vids = node.querySelectorAll?.("video");
        if (vids && vids.length) {
          vids.forEach(watchVideo);
          found = true;
        }
      }
    }
    if (found) scan();
  });

  mainObserver.observe(document.body, { childList: true, subtree: true });

  // ── Periodic poll (catches edge cases) ──
  setInterval(() => {
    document.querySelectorAll("video").forEach(watchVideo);
    scan();
  }, POLL_MS);

  // ── Clean up stale fixed buttons (viewer closed but button remains) ──
  setInterval(() => {
    document.querySelectorAll("." + DL_BTN_CLASS + "[style*='fixed']").forEach((btn) => {
      // Check if any media viewer is still open
      const hasViewer =
        document.querySelector(".media-viewer-whole") ||
        document.querySelector(".MediaViewer") ||
        document.querySelector("[class*='MediaViewer']") ||
        document.querySelector("[class*='media-viewer']");
      if (!hasViewer) {
        btn.remove();
        // Reset tgDl flags so buttons can be re-added
        document.querySelectorAll("video[data-tg-dl='1']").forEach((v) => {
          v.dataset.tgDl = "";
        });
      }
    });
  }, 1000);

  // ── Initial ──
  document.querySelectorAll("video").forEach(watchVideo);
  scan();
  // ── Debug: visible indicator that extension is running ──
  const badge = document.createElement("div");
  badge.textContent = "TG DL v1.2.0 ✓";
  badge.style.cssText =
    "position:fixed;bottom:8px;left:8px;z-index:2147483647;" +
    "padding:4px 10px;border-radius:8px;font-size:11px;" +
    "background:rgba(0,0,0,0.6);color:#4f4;font-family:monospace;" +
    "pointer-events:none;opacity:0.8;transition:opacity 2s;";
  document.body.appendChild(badge);
  // Fade out after 5 seconds
  setTimeout(() => { badge.style.opacity = "0"; }, 5000);
  setTimeout(() => { badge.remove(); }, 7000);

  console.log("[TG Video DL] Extension loaded v1.2.0");
  console.log("[TG Video DL] Videos found on page:", document.querySelectorAll("video").length);
  document.querySelectorAll("video").forEach((v, i) => {
    console.log(`[TG Video DL] Video #${i}: src=${(v.src || v.currentSrc || "NONE").substring(0, 80)}, paused=${v.paused}`);
  });
})();
