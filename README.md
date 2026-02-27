# Telegram Video Downloader

Chrome extension to download videos from Telegram Web — supports both [Web K](https://web.telegram.org/k/) and [Web A](https://web.telegram.org/a/).

Chrome 扩展，用于从 Telegram 网页版下载视频 — 同时支持 [Web K](https://web.telegram.org/k/) 和 [Web A](https://web.telegram.org/a/)。

## Features / 功能

- **Inline download button** — automatically appears below videos in chat once they're loaded
- **Media viewer download** — download button when viewing videos fullscreen
- **Progress display** — shows download percentage (⏳ 0% → 100% → ✅ Done)
- Works with both Web K (blob: URLs) and Web A (progressive streaming URLs)
- Manifest V3, no external dependencies

---

- **聊天内下载按钮** — 视频加载完成后，自动在视频下方显示下载按钮
- **全屏查看器下载** — 点开视频全屏查看时出现下载按钮
- **下载进度显示** — 实时百分比（⏳ 0% → 100% → ✅ Done）
- 同时支持 Web K（blob: URL）和 Web A（progressive 流式 URL）
- Manifest V3，无外部依赖

## Install / 安装

1. Clone or download this repo / 克隆或下载本仓库
2. Open `chrome://extensions/` / 打开 `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle) / 开启右上角 **开发者模式**
4. Click **Load unpacked** → select the project folder / 点击 **加载已解压的扩展程序** → 选择项目文件夹
5. Open [web.telegram.org](https://web.telegram.org/) and play a video / 打开 Telegram 网页版播放视频

## Architecture / 架构

```
background.js
  └─ chrome.scripting.executeScript({ world: "MAIN" })
      ├─ downloader.js   — Download engine with chunked Range requests
      ├─ inject_a.js     — Web A UI injection (buttons)
      └─ inject_k.js     — Web K UI injection (buttons)
```

**Why MAIN world?** Telegram's Service Worker intercepts `/progressive/` URLs and streams video data via MTProto protocol. Scripts in Chrome's default ISOLATED world cannot properly receive this data — they get garbage responses. Injecting into the page's MAIN world ensures `fetch()` goes through the Service Worker correctly.

**为什么用 MAIN world？** Telegram 的 Service Worker 拦截 `/progressive/` URL，通过 MTProto 协议流式传输视频数据。Chrome 默认的 ISOLATED world 中的脚本无法正确接收这些数据（只能拿到垃圾响应）。注入到页面的 MAIN world 后，`fetch()` 能正确经过 Service Worker 拿到真实视频数据。

## Development Journey / 开发历程

Building this extension was a series of lessons in how Telegram Web actually works under the hood. Here's what we tried, what failed, and why.

开发这个扩展的过程充满了对 Telegram Web 底层机制的探索。以下是我们尝试过的方法、失败的原因，以及最终方案的由来。

### Attempt 1: Overlay buttons + blob fetch in content script / 尝试 1：覆盖按钮 + content script 中 fetch blob

**Approach**: Inject CSS overlay download buttons on `<video>` elements, fetch `blob:` URLs from the content script.

**Result**: ❌ Buttons were invisible — Telegram's complex UI layers (custom players, overlays, z-index stacking) completely hid the hover-reveal buttons.

**方案**：在 `<video>` 元素上注入 CSS 覆盖层下载按钮，在 content script 中 fetch blob URL。

**结果**：❌ 按钮被遮挡 — Telegram 复杂的 UI 层级（自定义播放器、覆盖层、z-index）完全遮住了悬浮按钮。

### Attempt 2: Chrome contextMenus API / 尝试 2：Chrome 右键菜单 API

**Approach**: Use `chrome.contextMenus` to add "Download Video" to the browser's native right-click menu.

**Result**: ❌ Telegram intercepts the `contextmenu` event and replaces the browser's native menu with its own custom UI (Reply, Copy Link, etc.). Chrome's `contextMenus` API items never appear.

**方案**：用 `chrome.contextMenus` 在浏览器原生右键菜单添加"下载视频"选项。

**结果**：❌ Telegram 拦截了 `contextmenu` 事件，用自己的自定义菜单（回复、复制链接等）替换了浏览器原生菜单。Chrome 的 `contextMenus` API 完全不显示。

### Attempt 3: Inject into Telegram's custom context menu / 尝试 3：注入 Telegram 自定义右键菜单

**Approach**: Use MutationObserver to detect Telegram's custom context menu DOM appearing, then inject download items into it.

**Result**: ❌ Partially worked on Web K (`.btn-menu.contextmenu`), but unreliable. The menu is dynamically created/destroyed, mounted on `chat.container` (not `document.body`), and Web A uses completely different DOM structure. Too fragile.

**方案**：用 MutationObserver 检测 Telegram 自定义右键菜单 DOM 出现，然后注入下载选项。

**结果**：❌ 在 Web K 上部分生效（`.btn-menu.contextmenu`），但不稳定。菜单是动态创建/销毁的，挂载在 `chat.container` 上（不在 `document.body`），且 Web A 的 DOM 结构完全不同。太脆弱了。

### Attempt 4: MutationObserver + attribute watcher for video src / 尝试 4：MutationObserver + 属性监听

**Approach**: Watch for `<video>` elements appearing in DOM, monitor their `src` attribute for `blob:` URLs, inject download buttons below videos.

**Key discovery**: Web K uses `blob:` URLs, but **Web A uses `https://web.telegram.org/a/s/progressive/...` URLs** served by a Service Worker. Our `blob:`-only filter missed all Web A videos.

**After fixing the filter**: Buttons appeared, but downloads produced 1,587-byte files — not actual video data.

**方案**：监听 DOM 中 `<video>` 元素出现，监控其 `src` 属性变为 `blob:` URL 时注入下载按钮。

**关键发现**：Web K 用 `blob:` URL，但 **Web A 用 `https://web.telegram.org/a/s/progressive/...` URL**（由 Service Worker 提供）。只过滤 `blob:` 导致漏掉了所有 Web A 的视频。

**修复过滤器后**：按钮出现了，但下载出来的文件只有 1,587 字节 — 不是真正的视频数据。

### Attempt 5: fetch() in content script + chrome.downloads / 尝试 5：content script 中 fetch + chrome.downloads

**Approach**: Content script fetches the video URL, creates a blob URL, sends it to background script for `chrome.downloads.download()`.

**Result**: ❌ Downloaded files were HTML pages, not video data. **Root cause**: `chrome.downloads` makes a NEW network request from the extension context, which bypasses Telegram's Service Worker entirely. The Service Worker only works within the page's context.

**Then tried** fetching entirely in the content script with `<a download>`: Still got garbage. **Root cause discovered**: Content scripts run in Chrome's **ISOLATED world**. While the Service Worker does intercept the fetch, the response pipeline between the Service Worker ↔ main page (`requestPart`/`partResponse` messages) doesn't work correctly for isolated-world callers.

**方案**：content script fetch 视频 URL → 创建 blob URL → 发送给 background script 用 `chrome.downloads.download()` 下载。

**结果**：❌ 下载出来的是 HTML 页面。**根因**：`chrome.downloads` 从扩展上下文发起新请求，完全绕过了 Telegram 的 Service Worker。

**又尝试**在 content script 中用 `<a download>` 直接下载：依然是垃圾数据。**最终发现根因**：content script 运行在 Chrome 的 **ISOLATED world** 中。虽然 Service Worker 拦截了请求，但 Service Worker ↔ 主页面之间的数据管道（`requestPart`/`partResponse` 消息通信）对 ISOLATED world 的调用者无法正常工作。

### Attempt 6: Parallel chunked downloads / 尝试 6：并行分块下载

**Approach**: After discovering the MAIN world solution worked, tried to speed up downloads with 16 parallel Range requests for different byte ranges.

**Result**: ❌ Downloaded videos were corrupted and unplayable. **Root cause**: Telegram's Service Worker is designed for **sequential streaming** — it downloads data from MTProto servers in order. Random-access parallel Range requests caused mixed/incomplete responses.

**方案**：发现 MAIN world 方案可行后，尝试用 16 个并行 Range 请求加速下载。

**结果**：❌ 下载的视频损坏无法播放。**根因**：Telegram 的 Service Worker 是为**顺序流式传输**设计的 — 它按顺序从 MTProto 服务器下载数据。随机并行的 Range 请求导致响应混乱/不完整。

### Final solution: MAIN world injection + sequential Range requests / 最终方案

**What works**:

1. **`chrome.scripting.executeScript({ world: "MAIN" })`** — inject download code into the page's main execution context, where `fetch()` goes through Telegram's Service Worker correctly
2. **Sequential chunked Range requests** (`bytes=0-`, `bytes=524288-`, ...) — the Service Worker handles these properly, downloading each chunk via MTProto and returning real video data
3. **Polling-based UI injection** — periodically scan for video elements and add download buttons (more reliable than MutationObserver for Telegram's dynamic DOM)

This is the same proven approach used by [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader) and [SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader).

**最终可行方案**：

1. **`chrome.scripting.executeScript({ world: "MAIN" })`** — 将下载代码注入页面的主执行上下文，`fetch()` 能正确经过 Telegram 的 Service Worker
2. **顺序分块 Range 请求**（`bytes=0-`, `bytes=524288-`, ...）— Service Worker 能正确处理，通过 MTProto 逐块下载并返回真实视频数据
3. **轮询式 UI 注入** — 定期扫描 video 元素并添加下载按钮（比 MutationObserver 更可靠，因为 Telegram 的 DOM 高度动态化）

这与 [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader) 和 [SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader) 使用的方案一致。

### Key takeaways / 关键教训

| Lesson | Detail |
|--------|--------|
| Content scripts live in ISOLATED world | Cannot reliably interact with page's Service Worker responses |
| Telegram replaces browser context menus | `chrome.contextMenus` API is useless on Telegram Web |
| Web K ≠ Web A | Different video URL schemes (`blob:` vs `progressive/`), different DOM structures |
| Telegram SW requires sequential access | Parallel Range requests corrupt the download |
| Polling > MutationObserver for Telegram | Telegram's virtualized scroll destroys/recreates DOM nodes frequently |

## Project Structure / 项目结构

```
├── manifest.json      # Manifest V3 config (scripting + host_permissions)
├── background.js      # Injects MAIN world scripts on page load
├── downloader.js      # Core download engine (sequential Range requests)
├── inject_a.js        # Web A: poll for videos, inject download buttons
├── inject_k.js        # Web K: poll for videos, inject download buttons
└── icons/             # Extension icons
```

## License / 许可

MIT
