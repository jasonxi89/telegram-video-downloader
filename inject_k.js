// ── Web K UI injection (runs in MAIN world) ──
// Polls for video elements and media viewer, injects download buttons

if (!window.__TG_DL_K_LOADED) {
  window.__TG_DL_K_LOADED = true;

  const DL_CLASS = "tg-ext-dl";
  const POLL_MS = 600;

  function createButton(onClick) {
    const btn = document.createElement("div");
    btn.className = DL_CLASS;
    btn.textContent = "\u2b07 Download";
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;" +
      "padding:5px 14px;margin-top:6px;border-radius:12px;cursor:pointer;" +
      "font-size:13px;line-height:18px;color:#fff;font-weight:500;" +
      "background:rgba(51,144,236,0.85);" +
      "transition:background 0.15s;user-select:none;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(51,144,236,1)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(51,144,236,0.85)";
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn._completed) return;
      onClick(btn);
    });
    return btn;
  }

  function startDownload(video, btn) {
    const src = video.src || video.currentSrc;
    if (!src) return;

    btn.textContent = "\u23f3 0%";
    btn.style.pointerEvents = "none";
    btn._completed = false;

    window.__TG_DL(src, {
      onProgress: (pct) => {
        btn.textContent = "\u23f3 " + pct + "%";
      },
      onComplete: () => {
        btn._completed = true;
        btn.style.pointerEvents = "";
        btn.innerHTML = "";

        const done = document.createElement("span");
        done.textContent = "\u2705 Done";
        btn.appendChild(done);

        const retry = document.createElement("span");
        retry.textContent = "\ud83d\udd04";
        retry.title = "Re-download";
        retry.style.cssText =
          "cursor:pointer;padding:2px 6px;margin-left:6px;border-radius:6px;" +
          "transition:background 0.15s;";
        retry.addEventListener("mouseenter", () => {
          retry.style.background = "rgba(255,255,255,0.25)";
        });
        retry.addEventListener("mouseleave", () => {
          retry.style.background = "transparent";
        });
        retry.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          startDownload(video, btn);
        });
        btn.appendChild(retry);
      },
      onError: (msg) => {
        btn.textContent = "\u274c Failed";
        btn.style.pointerEvents = "";
        btn._completed = false;
        console.error("[TG DL K]", msg);
        setTimeout(() => {
          btn.textContent = "\u2b07 Download";
        }, 3000);
      },
    });
  }

  function scan() {
    // ── Inline videos in chat bubbles ──
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (!src) continue;
      if (video.__tgDl) continue;

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

      // Dedup: also check if button already exists (DOM re-renders lose __tgDl)
      const hasBtn = albumItem
        ? albumItem.querySelector("." + DL_CLASS)
        : wrapper.nextElementSibling &&
          wrapper.nextElementSibling.classList.contains(DL_CLASS);
      if (hasBtn) {
        video.__tgDl = true;
        continue;
      }

      video.__tgDl = true;
      const btn = createButton((b) => startDownload(video, b));

      if (albumItem) {
        btn.style.cssText +=
          ";position:absolute;bottom:4px;left:4px;z-index:5;" +
          "margin-top:0;padding:3px 10px;font-size:12px;";
        albumItem.style.position = "relative";
        albumItem.appendChild(btn);
      } else {
        wrapper.after(btn);
      }
    }

    // ── Media viewer overlay ──
    const viewer = document.querySelector(".media-viewer-whole");
    if (viewer) {
      if (!viewer.querySelector("." + DL_CLASS)) {
        // Try to unhide native download button first
        const buttons = viewer.querySelector(".media-viewer-buttons");
        if (buttons) {
          const hidden = buttons.querySelectorAll("button.btn-icon.hide");
          for (const h of hidden) {
            if (h.textContent.charCodeAt(0) === 0xe95e) {
              h.classList.remove("hide");
              return;
            }
          }
        }

        // Add custom button
        const video = viewer.querySelector(
          ".media-viewer-mover.active video, .media-viewer-aspecter video"
        );
        if (video && (video.src || video.currentSrc)) {
          const btn = createButton((b) => startDownload(video, b));

          if (buttons) {
            btn.style.cssText +=
              ";margin:0;padding:8px 14px;border-radius:16px;";
            buttons.prepend(btn);
          } else {
            btn.style.cssText +=
              ";position:fixed;top:16px;right:70px;z-index:2147483647;" +
              "padding:8px 18px;font-size:14px;border-radius:20px;" +
              "box-shadow:0 2px 8px rgba(0,0,0,0.3);";
            document.body.appendChild(btn);

            const watcher = setInterval(() => {
              if (!document.querySelector(".media-viewer-whole")) {
                btn.remove();
                clearInterval(watcher);
              }
            }, 500);
          }
        }
      }
    }
  }

  setInterval(scan, POLL_MS);
  console.log("[TG DL] Web K injector loaded");
}
