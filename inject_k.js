// ── Web K UI injection (runs in MAIN world) ──
// Polls for video elements and media viewer, injects download buttons

if (!window.__TG_DL_K_LOADED) {
  window.__TG_DL_K_LOADED = true;

  const DL_CLASS = "tg-ext-dl";
  const POLL_MS = 600;

  function createButton(onClick) {
    const btn = document.createElement("div");
    btn.className = DL_CLASS;
    btn.textContent = "⬇ Download";
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
      onClick(btn);
    });
    return btn;
  }

  function startDownload(video, btn) {
    const src = video.src || video.currentSrc;
    if (!src) return;

    btn.textContent = "⏳ 0%";
    btn.style.pointerEvents = "none";

    window.__TG_DL(src, {
      onProgress: (pct) => {
        btn.textContent = "⏳ " + pct + "%";
      },
      onComplete: () => {
        btn.textContent = "✅ Done";
        btn.style.pointerEvents = "";
        setTimeout(() => {
          btn.textContent = "⬇ Download";
        }, 3000);
      },
      onError: (msg) => {
        btn.textContent = "❌ Failed";
        btn.style.pointerEvents = "";
        console.error("[TG DL K]", msg);
        setTimeout(() => {
          btn.textContent = "⬇ Download";
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

      const bubble = video.closest(".bubble");
      if (!bubble) continue;
      if (bubble.querySelector("." + DL_CLASS)) continue;

      const wrapper =
        video.closest(".attachment") ||
        video.closest(".media-container") ||
        video.closest(".ckin__player") ||
        video.parentElement;
      if (!wrapper) continue;

      const btn = createButton((b) => startDownload(video, b));
      wrapper.after(btn);
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
