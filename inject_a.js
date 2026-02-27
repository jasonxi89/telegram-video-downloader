// ── Web A UI injection (runs in MAIN world) ──
// Polls for video elements and media viewer, injects download buttons

if (!window.__TG_DL_A_LOADED) {
  window.__TG_DL_A_LOADED = true;

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
        console.error("[TG DL A]", msg);
        setTimeout(() => {
          btn.textContent = "⬇ Download";
        }, 3000);
      },
    });
  }

  function scan() {
    // ── Inline videos in chat ──
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (!src) continue;

      // Find message container
      const msg =
        video.closest(".Message") ||
        video.closest(".message") ||
        video.closest("[class*='message']");
      if (!msg) continue;
      if (msg.querySelector("." + DL_CLASS)) continue;

      // Find the video wrapper to place button after
      const wrapper =
        video.closest(".media-inner") ||
        video.closest("[class*='VideoPlayer']") ||
        video.closest("[class*='media']") ||
        video.parentElement;
      if (!wrapper) continue;

      const btn = createButton((b) => startDownload(video, b));
      wrapper.after(btn);
    }

    // ── Media viewer overlay ──
    const viewer =
      document.querySelector("#MediaViewer") ||
      document.querySelector("[class*='MediaViewer']");
    if (viewer) {
      if (!viewer.querySelector("." + DL_CLASS)) {
        const video = viewer.querySelector("video");
        if (video && (video.src || video.currentSrc)) {
          // Find button area or create floating button
          const actions = viewer.querySelector(
            "[class*='MediaViewerActions'], [class*='actions'], .buttons"
          );

          const btn = createButton((b) => startDownload(video, b));

          if (actions) {
            actions.prepend(btn);
          } else {
            // Floating button
            btn.style.cssText +=
              ";position:fixed;top:16px;right:70px;z-index:2147483647;" +
              "padding:8px 18px;font-size:14px;border-radius:20px;" +
              "box-shadow:0 2px 8px rgba(0,0,0,0.3);";
            document.body.appendChild(btn);

            // Clean up when viewer closes
            const watcher = setInterval(() => {
              const still =
                document.querySelector("#MediaViewer") ||
                document.querySelector("[class*='MediaViewer']");
              if (!still) {
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
  console.log("[TG DL] Web A injector loaded");
}
