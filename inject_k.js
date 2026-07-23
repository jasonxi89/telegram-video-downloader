// ── Web K UI injection (runs in MAIN world) ──
// Polls for video elements and media viewer, injects download buttons

if (!window.__TG_DL_K_LOADED) {
  window.__TG_DL_K_LOADED = true;

  const DL_CLASS = "tg-ext-dl";
  const POLL_MS = 600;
  const COMPLETED_URLS = new Set();
  const ACTIVE_DOWNLOADS = new Set();
  const DOWNLOAD_PROGRESS = new Map();

  function getVideoKey(src) {
    // Web A: /progressive/document{ID}
    const docMatch = src.match(/document(\d+)/);
    if (docMatch) return "doc:" + docMatch[1];
    // Web K: stream/{URL-encoded JSON} with location.id
    if (src.includes("stream/")) {
      try {
        const json = JSON.parse(decodeURIComponent(src.split("stream/")[1]));
        if (json.location && json.location.id) return "doc:" + json.location.id;
      } catch {}
    }
    return src;
  }

  function buttonPadding(btn) {
    if (btn.dataset.variant === "album") return "3px 10px";
    if (btn.dataset.variant === "viewer") return "8px 14px";
    return "5px 14px";
  }

  function createButton(video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = DL_CLASS;
    btn._video = video;
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;border:0;" +
      "padding:5px 14px;margin-top:6px;border-radius:12px;cursor:pointer;" +
      "font:500 13px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "color:#fff;background:rgba(51,144,236,0.85);" +
      "transition:background 0.15s;user-select:none;";
    btn.addEventListener("mouseenter", () => {
      if (!btn._completed && !btn.disabled) {
        btn.style.background = "rgba(51,144,236,1)";
      }
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn._completed) btn.style.background = "rgba(51,144,236,0.85)";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDownload(btn._video, btn);
    });
    return btn;
  }

  function showReady(btn, video) {
    btn._video = video;
    btn._completed = false;
    btn.disabled = false;
    btn.replaceChildren();
    btn.textContent = "\u2b07 Download";
    btn.setAttribute("aria-label", "Download video");
    btn.style.padding = buttonPadding(btn);
    btn.style.background = "rgba(51,144,236,0.85)";
    btn.style.gap = "4px";
    btn.style.overflow = "";
  }

  function showDownloading(btn, video, pct) {
    btn._video = video;
    btn._completed = false;
    btn.disabled = true;
    btn.replaceChildren();
    btn.textContent = pct == null ? "\u23f3 Downloading..." : "\u23f3 " + pct + "%";
    btn.setAttribute("aria-label", "Downloading video");
    btn.style.padding = buttonPadding(btn);
    btn.style.background = "rgba(51,144,236,0.85)";
    btn.style.gap = "4px";
    btn.style.overflow = "";
  }

  function markDone(btn, video) {
    btn._video = video;
    btn._completed = true;
    btn.disabled = false;
    btn.replaceChildren();
    btn.setAttribute("aria-label", "Re-download video");
    btn.style.padding = "0";
    btn.style.background = "transparent";
    btn.style.gap = "0";
    btn.style.overflow = "hidden";

    const done = document.createElement("span");
    done.textContent = "\u2714 Done";
    done.style.cssText =
      "padding:5px 12px;background:rgba(55,178,77,0.85);color:#fff;" +
      "font-size:13px;font-weight:500;line-height:18px;";
    btn.appendChild(done);

    const retry = document.createElement("span");
    retry.textContent = "Re-download";
    retry.style.cssText =
      "padding:5px 12px;background:rgba(51,144,236,0.7);color:#fff;" +
      "font-size:13px;font-weight:500;line-height:18px;";
    btn.appendChild(retry);
  }

  function syncButton(btn, video) {
    const src = video && (video.src || video.currentSrc);
    if (!src) return;
    const key = getVideoKey(src);
    btn.dataset.videoKey = key;

    if (ACTIVE_DOWNLOADS.has(key)) {
      showDownloading(btn, video, DOWNLOAD_PROGRESS.get(key));
    } else if (COMPLETED_URLS.has(key)) {
      markDone(btn, video);
    } else {
      showReady(btn, video);
    }
  }

  function syncButtonsForKey(key) {
    for (const btn of document.querySelectorAll("." + DL_CLASS)) {
      if (btn.dataset.videoKey === key && btn._video) {
        syncButton(btn, btn._video);
      }
    }
  }

  function startDownload(video, btn) {
    const src = video && (video.src || video.currentSrc);
    if (!src) return;

    const key = getVideoKey(src);
    if (ACTIVE_DOWNLOADS.has(key)) {
      syncButton(btn, video);
      return;
    }

    ACTIVE_DOWNLOADS.add(key);
    DOWNLOAD_PROGRESS.set(key, 0);
    syncButtonsForKey(key);

    try {
      if (typeof window.__TG_DL !== "function") {
        throw new Error("Core downloader is unavailable");
      }
      window.__TG_DL(src, {
        onProgress: (pct) => {
          DOWNLOAD_PROGRESS.set(key, pct);
          syncButtonsForKey(key);
        },
        onComplete: () => {
          ACTIVE_DOWNLOADS.delete(key);
          DOWNLOAD_PROGRESS.delete(key);
          COMPLETED_URLS.add(key);
          syncButtonsForKey(key);
        },
        onError: (msg) => {
          ACTIVE_DOWNLOADS.delete(key);
          DOWNLOAD_PROGRESS.delete(key);
          syncButtonsForKey(key);
          console.error("[TG DL K]", msg);
        },
        onCancel: () => {
          ACTIVE_DOWNLOADS.delete(key);
          DOWNLOAD_PROGRESS.delete(key);
          syncButtonsForKey(key);
        },
      });
    } catch (err) {
      ACTIVE_DOWNLOADS.delete(key);
      DOWNLOAD_PROGRESS.delete(key);
      syncButtonsForKey(key);
      console.error("[TG DL K]", err);
    }
  }

  function scan() {
    // ── Inline videos in chat bubbles ──
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (!src) continue;

      const bubble = video.closest(".bubble");
      if (!bubble) continue;

      const albumItem = video.closest(".album-item");
      const wrapper =
        albumItem ||
        video.closest(".attachment") ||
        video.closest(".media-container") ||
        video.closest(".ckin__player") ||
        video.parentElement;
      if (!wrapper) continue;

      let btn = albumItem
        ? albumItem.querySelector(":scope > ." + DL_CLASS)
        : wrapper.nextElementSibling &&
            wrapper.nextElementSibling.classList.contains(DL_CLASS)
          ? wrapper.nextElementSibling
          : null;

      if (!btn) {
        btn = createButton(video);
        if (albumItem) {
          btn.dataset.variant = "album";
          btn.style.cssText +=
            ";position:absolute;bottom:4px;left:4px;z-index:5;" +
            "margin-top:0;padding:3px 10px;font-size:12px;";
          albumItem.style.position = "relative";
          albumItem.appendChild(btn);
        } else {
          wrapper.after(btn);
        }
      }

      const scanKey = getVideoKey(src);
      if (btn.dataset.videoKey !== scanKey || btn._video !== video) {
        btn._video = video;
        syncButton(btn, video);
      }
    }

    // ── Media viewer overlay ──
    const viewer = document.querySelector(".media-viewer-whole");
    const floatingBtn = document.querySelector(
      "." + DL_CLASS + '[data-viewer="k"]'
    );
    if (!viewer) {
      if (floatingBtn) floatingBtn.remove();
      return;
    }

    // Try to unhide Telegram's native download button first.
    const buttons = viewer.querySelector(".media-viewer-buttons");
    if (buttons) {
      const nativeButtons = buttons.querySelectorAll("button.btn-icon");
      for (const nativeButton of nativeButtons) {
        if (nativeButton.textContent.charCodeAt(0) === 0xe95e) {
          nativeButton.classList.remove("hide");
          const customButton = viewer.querySelector("." + DL_CLASS);
          if (customButton) customButton.remove();
          if (floatingBtn && floatingBtn !== customButton) floatingBtn.remove();
          return;
        }
      }
    }

    const video = viewer.querySelector(
      ".media-viewer-mover.active video, .media-viewer-aspecter video"
    );
    if (!video || !(video.src || video.currentSrc)) return;

    let btn = viewer.querySelector("." + DL_CLASS);
    if (!btn) btn = floatingBtn;
    if (!btn) {
      btn = createButton(video);
      btn.dataset.viewer = "k";
      btn.dataset.variant = "viewer";
      btn.style.cssText +=
        ";margin:0;padding:8px 14px;border-radius:16px;";
    }

    if (buttons) {
      if (btn.parentElement !== buttons) buttons.prepend(btn);
      btn.style.position = "";
      btn.style.top = "";
      btn.style.right = "";
      btn.style.zIndex = "";
      btn.style.boxShadow = "";
    } else if (btn.parentElement !== document.body) {
      btn.style.position = "fixed";
      btn.style.top = "16px";
      btn.style.right = "70px";
      btn.style.zIndex = "2147483647";
      btn.style.padding = "8px 18px";
      btn.style.fontSize = "14px";
      btn.style.borderRadius = "20px";
      btn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
      document.body.appendChild(btn);
    }

    const viewerKey = getVideoKey(video.src || video.currentSrc);
    if (btn.dataset.videoKey !== viewerKey || btn._video !== video) {
      btn._video = video;
      syncButton(btn, video);
    }
  }

  // Listen for messages from background / download engine
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !event.data
    ) {
      return;
    }

    // Restore completed URLs on page load (persisted across restarts)
    if (event.data.source === "tg-dl-init" && event.data.completedUrls) {
      for (const url of event.data.completedUrls) {
        const key = getVideoKey(url);
        COMPLETED_URLS.add(key);
        syncButtonsForKey(key);
      }
    }

    if (event.data.source !== "tg-dl" || !event.data.url) return;

    const key = getVideoKey(event.data.url);
    if (event.data.type === "dl-progress") {
      ACTIVE_DOWNLOADS.add(key);
      DOWNLOAD_PROGRESS.set(key, event.data.pct || 0);
    } else if (event.data.type === "dl-complete") {
      ACTIVE_DOWNLOADS.delete(key);
      DOWNLOAD_PROGRESS.delete(key);
      COMPLETED_URLS.add(key);
    } else if (
      event.data.type === "dl-error" ||
      event.data.type === "dl-cancel"
    ) {
      ACTIVE_DOWNLOADS.delete(key);
      DOWNLOAD_PROGRESS.delete(key);
    }
    syncButtonsForKey(key);
  });

  setInterval(scan, POLL_MS);
  console.log("[TG DL] Web K injector loaded");
}
