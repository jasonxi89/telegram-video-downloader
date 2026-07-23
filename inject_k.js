// ── Web K UI injection (runs in MAIN world) ──
// Polls for video elements and media viewer, injects download buttons

if (!window.__TG_DL_K_LOADED) {
  window.__TG_DL_K_LOADED = true;

  const DL_CLASS = "tg-ext-dl";
  const POLL_MS = 600;
  const COMPLETED_URLS = new Set();
  const ACTIVE_DOWNLOADS = new Set();
  const DOWNLOAD_PROGRESS = new Map();
  const SOURCE_KEYS = new Map();
  const SIGNATURE_KEYS = new Map();
  const BLOB_KEY_PROMISES = new Map();
  const UNRESOLVED_BLOBS = new Set();

  function getMessageKey(video) {
    if (!video || typeof video.closest !== "function") return "";
    const bubble = video.closest(".bubble");
    if (!bubble) return "";
    const albumItem = video.closest(".album-item[data-mid]");
    const owner = albumItem || bubble;
    const peerId = owner.dataset.peerId || bubble.dataset.peerId;
    const mid = owner.dataset.mid;
    return peerId && mid ? "msg:" + peerId + ":" + mid : "";
  }

  function getStreamIdentity(src) {
    if (!src.includes("stream/")) return null;
    try {
      const encoded = src.split("stream/")[1].split(/[?#]/)[0];
      const metadata = JSON.parse(decodeURIComponent(encoded));
      const id = metadata.location && metadata.location.id;
      const size = Number(metadata.size);
      return {
        key: id ? "doc:" + id : "",
        size: Number.isFinite(size) && size > 0 ? size : 0,
      };
    } catch {
      return null;
    }
  }

  function getMediaSignature(size, video) {
    const duration = Number(video && video.duration);
    const width = Number(video && video.videoWidth);
    const height = Number(video && video.videoHeight);
    if (!size || !Number.isFinite(duration) || duration <= 0 || !width || !height) {
      return "";
    }
    return [size, Math.round(duration * 1000), width, height].join(":");
  }

  function registerUniqueKey(map, identity, key) {
    if (!identity || !key) return false;
    const existing = map.get(identity);
    if (existing === undefined) {
      map.set(identity, key);
    } else if (existing && existing !== key) {
      // Different documents with the same identity are ambiguous; never guess.
      map.set(identity, "");
    } else {
      return false;
    }
    if (map.size > 500) map.delete(map.keys().next().value);
    return true;
  }

  function registerMediaKey(size, video, key) {
    const signature = getMediaSignature(size, video);
    if (!registerUniqueKey(SIGNATURE_KEYS, signature, key)) return;

    // A viewer may have appeared before its inline stream was scanned.
    for (const src of UNRESOLVED_BLOBS) BLOB_KEY_PROMISES.delete(src);
    UNRESOLVED_BLOBS.clear();
  }

  function rememberSourceKey(src, key) {
    if (!src || !key) return;
    SOURCE_KEYS.set(src, key);
    if (SOURCE_KEYS.size > 500) {
      SOURCE_KEYS.delete(SOURCE_KEYS.keys().next().value);
    }
  }

  function findMessageKeyBySource(src, video) {
    const ownKey = getMessageKey(video);
    if (ownKey) return ownKey;
    if (SOURCE_KEYS.has(src)) return SOURCE_KEYS.get(src);

    for (const candidate of document.querySelectorAll("video")) {
      if (candidate === video) continue;
      const candidateSrc = candidate.src || candidate.currentSrc;
      if (candidateSrc !== src) continue;
      const key = getMessageKey(candidate);
      if (key) return key;
    }
    return "";
  }

  function getVideoKey(src, video) {
    const streamIdentity = getStreamIdentity(src);
    if (streamIdentity && streamIdentity.key) {
      rememberSourceKey(src, streamIdentity.key);
      registerMediaKey(streamIdentity.size, video, streamIdentity.key);
      return streamIdentity.key;
    }

    const docMatch = src.match(/document(\d+)/);
    if (docMatch) return "doc:" + docMatch[1];

    const messageKey = findMessageKeyBySource(src, video);
    if (messageKey) {
      rememberSourceKey(src, messageKey);
      return messageKey;
    }
    return src;
  }

  function resolveBlobKey(src, video) {
    if (!src.startsWith("blob:")) return Promise.resolve("");
    if (!getMediaSignature(1, video)) return Promise.resolve(null);
    if (BLOB_KEY_PROMISES.has(src)) return BLOB_KEY_PROMISES.get(src);

    const promise = fetch(src, {
      headers: { Range: "bytes=0-0" },
    })
      .then(async (response) => {
        const range = response.headers.get("Content-Range") || "";
        const match =
          response.status === 206 && range.match(/^bytes 0-0\/(\d+)$/);
        const size = match && Number(match[1]);
        if (!size || !Number.isSafeInteger(size)) {
          try {
            await response.body?.cancel();
          } catch {}
          return "";
        }
        await response.arrayBuffer();

        const signature = getMediaSignature(size, video);
        let hasIdentity = false;
        let key = "";
        if (signature && SIGNATURE_KEYS.has(signature)) {
          hasIdentity = true;
          key = SIGNATURE_KEYS.get(signature);
        }

        if (!hasIdentity) {
          UNRESOLVED_BLOBS.add(src);
          if (UNRESOLVED_BLOBS.size > 500) {
            UNRESOLVED_BLOBS.delete(UNRESOLVED_BLOBS.values().next().value);
          }
          return "";
        }
        if (key) {
          UNRESOLVED_BLOBS.delete(src);
          rememberSourceKey(src, key);
        }
        return key;
      })
      .catch(() => "");
    BLOB_KEY_PROMISES.set(src, promise);
    if (BLOB_KEY_PROMISES.size > 500) {
      BLOB_KEY_PROMISES.delete(BLOB_KEY_PROMISES.keys().next().value);
    }
    return promise;
  }

  async function resolveVideoKey(src, video) {
    const key = getVideoKey(src, video);
    if (key !== src || !src.startsWith("blob:")) return key;
    return (await resolveBlobKey(src, video)) || key;
  }

  function needsBlobResolution(src, key) {
    return src.startsWith("blob:") && key === src && !SOURCE_KEYS.has(src);
  }

  function getViewerVideo(viewer) {
    if (!viewer) return null;
    return (
      viewer.querySelector(".media-viewer-mover.active video") ||
      viewer.querySelector(".media-viewer-aspecter video")
    );
  }

  function getLiveButtonVideo(btn) {
    if (btn.dataset.viewer === "k") {
      return getViewerVideo(document.querySelector(".media-viewer-whole"));
    }
    return btn._video;
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
      startDownload(getLiveButtonVideo(btn), btn);
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
    const key = getVideoKey(src, video);
    btn.dataset.videoKey = key;

    if (ACTIVE_DOWNLOADS.has(key)) {
      showDownloading(btn, video, DOWNLOAD_PROGRESS.get(key));
    } else if (COMPLETED_URLS.has(key)) {
      markDone(btn, video);
    } else {
      showReady(btn, video);
    }

    if (key === src && src.startsWith("blob:")) {
      void resolveBlobKey(src, video).then((resolvedKey) => {
        const currentSrc = video.src || video.currentSrc;
        if (resolvedKey && currentSrc === src) syncButton(btn, video);
      });
    }
  }

  function syncButtonsForKey(key) {
    for (const btn of document.querySelectorAll("." + DL_CLASS)) {
      if (btn.dataset.videoKey === key && btn._video) {
        syncButton(btn, btn._video);
      }
    }
  }

  async function startDownload(video, btn) {
    const src = video && (video.src || video.currentSrc);
    if (!src) return;

    btn.disabled = true;
    let key;
    try {
      key = await resolveVideoKey(src, video);
    } catch (err) {
      console.error("[TG DL K] Failed to identify video:", err);
      syncButton(btn, getLiveButtonVideo(btn) || video);
      return;
    }

    const liveVideo = getLiveButtonVideo(btn) || video;
    const currentSrc = liveVideo.src || liveVideo.currentSrc;
    if (liveVideo !== video || currentSrc !== src) {
      syncButton(btn, liveVideo);
      return;
    }
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
        key,
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

      const scanKey = getVideoKey(src, video);
      if (
        btn.dataset.videoKey !== scanKey ||
        btn._video !== video ||
        needsBlobResolution(src, scanKey)
      ) {
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

    const video = getViewerVideo(viewer);
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

    const viewerKey = getVideoKey(video.src || video.currentSrc, video);
    const viewerSrc = video.src || video.currentSrc;
    if (
      btn.dataset.videoKey !== viewerKey ||
      btn._video !== video ||
      needsBlobResolution(viewerSrc, viewerKey)
    ) {
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

    const key =
      typeof event.data.key === "string" && event.data.key
        ? event.data.key
        : getVideoKey(event.data.url);
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
