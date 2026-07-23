# HANDOFF — telegram-video-downloader
> 跨 agent/IDE 接手文档 | 最后更新: 2026-07-23 | 改动项目后请同步更新此文档

## 项目定位
Chrome 扩展（Manifest V3），从 Telegram 网页版下载视频，同时支持 Web K（`blob:` URL）和 Web A（`progressive/` 流式 URL）。纯前端扩展，**不是 NAS 服务，无后端、无部署流程、无构建步骤**。
- GitHub: https://github.com/jasonxi89/telegram-video-downloader (public)
- Windows 路径: `C:\\Users\\goodb\\Projects\\telegram-video-downloader`
- macOS 路径: `/Users/vn59ngs/Documents/personal/telegram-video-downloader`

## 当前状态
- 版本 **v2.10.0**（基于已实机验证可正常下载的 v2.9.3 working baseline 做 P0 hardening）
- 功能可用：聊天内 + 全屏查看器下载按钮、下载进度显示、Popup 下载队列面板（进度/速度/文件名）、Badge 显示活跃下载数、暂停/恢复/取消/删除、Done 条目保留 + 重下载、album 多视频、同一视频多按钮进度同步、防重复下载
- v2.10.0 已修：暂停/恢复并发链、Viewer 悬浮按钮泄漏与媒体切换状态、Web K 稳定 media key、Popup XSS、持久化 Cancel ACK/误报、扩展 reload bridge 恢复、SW 冷启动状态屏障、popup port 竞态、注入按钮键盘语义
- `postMessage` 已加入 origin/type/schema/sender/tab ownership 校验，但 MAIN world 与 Telegram 页面同信任域，真正的通道认证及公开 `window.__TG_DL` API 收口仍待设计；P1/P2 其余清单见下方
- 当前开发分支：`fix/p0-reliability-security`

## 技术栈与结构
纯 JS，无第三方依赖。消息流：`MAIN world → content.js 桥 → background(SW) → popup`。
```
manifest.json   MV3 配置，permissions=[scripting, storage]，host=web.telegram.org
background.js    MAIN world 脚本注入 + 下载状态管理 + badge + popup port
downloader.js    顺序分块 Range 下载引擎，postMessage 上报进度
content.js       消息桥：MAIN world ⇄ Service Worker（ISOLATED world）
inject_k.js      Web K 轮询扫描 video、注入按钮（POLL_MS=600）
inject_a.js      Web A 轮询扫描 video、注入按钮（POLL_MS=600）
popup.html/css/js  340px 下载队列面板，port name="popup" 与 background 通信
_locales/        i18n，12 种语言（ar de en es fr hi ja ko pt_BR ru zh_CN zh_TW）
icons/           16/48/128 png
```

## 常用命令
无构建/无 npm。开发即改即测：
1. 打开 `chrome://extensions/`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」→ 选本项目文件夹（首次）
3. 改代码后，在扩展卡片点「刷新」图标重载；再刷新 Telegram 页面
4. 调试：`web.telegram.org` 页面 DevTools 看注入脚本日志（前缀 `[TG DL K]` / `[TG DL A]`）；Service Worker 日志在扩展卡片「检查视图 Service Worker」
- Git: `git -C C:\Users\goodb\Projects\telegram-video-downloader log --oneline`

## 约定与坑
- **commit 不加 Co-Authored-By 行**；message 用 `type: 描述`，功能更新 bump manifest.json version（semver）
- **MAIN world 注入是核心**：Telegram SW 拦截 `/progressive/` 走 MTProto，ISOLATED world 的 fetch 拿不到真实数据
- **必须顺序 Range 请求**：并行 Range 会导致视频损坏（v2.1.x 踩过坑已回滚）
- **轮询扫描（600ms）优于 MutationObserver**：Telegram 虚拟滚动频繁销毁/重建 DOM
- Web K 与 Web A 的 URL 方案和 DOM 结构完全不同，两套注入脚本各自维护
- `chrome.contextMenus` 在 Telegram 无效（被其自定义右键菜单替换）
- README.md 已于 2026-07-23 更新至与代码一致（Features/Architecture/Project Structure 含 popup、content.js 消息桥、i18n）

## 进行中 / TODO
**源自 2026-07-18/19 多 agent 代码审查；v2.10.0 已完成首批 P0 修复，剩余项继续按优先级处理：**

### P0 — 可确定触发
- [x] 暂停/恢复竞态：v2.10.0 增加 per-download `inFlight` guard + per-request AbortController；pause 允许当前 chunk 安全收尾但不启下一块，resume 幂等且不会产生并发 fetch 链
- [x] 全屏查看器悬浮按钮失控：v2.10.0 改为单按钮轮询生命周期，不再为 fallback 创建独立 watcher interval；关闭 Viewer 自动清理
- [x] 全屏按钮状态不同步：v2.10.0 统一按 video key 同步 inline/viewer 的 active/progress/complete/error/cancel；Web K 优先从 inline `stream/{JSON}` 提取 document id/size；Viewer `blob:` 只请求 `bytes=0-0`，由 Content-Range 总大小 + duration + video dimensions 媒体签名映射回 document key（签名冲突则保守回退），并在切换媒体时实时解析当前 active video
- [x] XSS/HTML 注入：v2.10.0 Popup 全面改用 createElement/textContent、状态白名单与 pct 数值 clamp，不再拼 innerHTML
- [ ] postMessage 桥认证：v2.10.0 已完成显式 origin、消息 type/schema、Telegram sender URL、tab ownership 校验；但同源 Telegram 页面仍能观察/伪造 MAIN-world 消息，`window.__TG_DL` 仍公开，需另行设计真正认证边界
- [x] 扩展 reload 后消息桥静默死亡：v2.10.0 content bridge 增加失败上报和 generation guard，SW 在 install/startup 为现有 Telegram tabs 重新注入 bridge

### P1 — 低概率但已确认
- [ ] mid-download 服务器返回 200 替代 206 → 整文件追加到部分 chunk，静默损坏（正常 Telegram 顺序 Range 路径已实机验证 working；异常响应 hardening 不得改变正常路径）
- [ ] Content-Range 异常格式或范围不连续被静默接受 → 文件截断/缺块却报成功
- [x] SW 冷启动竞态：v2.10.0 为 dl-progress skeleton 保留已校验的 url，并用 `stateReady` 屏障保证 completedUrls/Popup snapshot 在恢复后同步
- [ ] 下载进度的 setTimeout 存储节流仍非 MV3-suspend-safe，SW idle-kill 可能丢挂起写入；Cancel ACK 已改为先持久化 `cancelling`，重启/Popup stale sweep 可恢复为 error，不再只依赖内存 timer
- [ ] 无 forward-progress guard：异常代理重复返回同一 Content-Range 会无限循环

### P2 — 质量/体验
- [x] 用户取消被误报为下载失败：v2.10.0 分离 onCancel/onError，并要求 background 收到 dl-cancel ACK 后才删除；`cancelling` 状态先持久化，失败、超时或 SW suspend 后恢复均保留可见 error
- [ ] 页内 COMPLETED_URLS Set 无上限增长（background 端有 500 上限，两端不一致）
- [ ] 整文件 blob 在内存累积，大视频占多 GB → 考虑流式落盘
- [ ] 所有运行时 UI 字符串硬编码英文（MAIN + Popup + background error；chrome.i18n 在 MAIN world 不可用，需经消息桥取翻译）
- [ ] 暂停时进度仍更新 offset/total/pct，与代码注释矛盾
- [x] popup port 竞态：v2.10.0 stale disconnect 仅在 `popupPort === port` 时清空活跃 port
- [ ] 冷启动与 popup onConnect 的 staleness 清理逻辑不一致，paused 条目可能永久卡住
- [ ] pause/resume 命令失败静默回显旧状态，用户无感知
- [x] 注入下载/Re-download 控件不可键盘操作：v2.10.0 改为原生 button，并为 Popup progress 增加 ARIA 语义

### PR #1 审查跟进（2026-07-23）
- [x] Web K blob key：核对 tweb 源码确认 inline 可能为 `stream/{JSON}`、Viewer 可能为 `blob:`；现从 stream metadata + video metadata 注册媒体签名到 `doc:id`，blob 仅 Range 读取 1 byte 并用 Content-Range 总大小 + duration + dimensions 映射，key 随下载状态持久化；签名冲突时不猜测
- [x] Viewer stale-click：Web K/A 点击时实时查询 active viewer video，不再信任最多 600ms 前的 `btn._video`
- [x] Cancel timer suspend：持久化 `cancelling`，SW 恢复和 Popup stale sweep 可确定转 error，并立即写回 storage
- [x] Minor：移除无人监听的 bridge-error 页面消息、下载 ID 固定补齐 6 位、content origin 改为动态同源、本文档补充 cancel timer 说明
- [x] `f373ea4` 复审 blocker：针对真实 `stream` inline / `blob` Viewer 增加 1-byte Range probe；用 total size + duration + dimensions 强签名同步 doc key/progress/Done，冲突、metadata 缺失、non-206 或 malformed Content-Range 均安全回退
- [ ] 登录态手测 gate：agent 环境不可访问 `web.telegram.org`，不得再尝试；由用户确认部署中的 blob Content-Range total 等于 stream metadata size、inline metadata 可用，并完成 PR 描述的 7 项 Chrome 手测

修复时按 P0 → P1 → P2 顺序；每批修完 bump manifest.json 版本 + 更新本文档和项目 memory。任何下载核心改动必须保留 v2.9.3 已实机验证 working 的 MAIN-world + 顺序 Range baseline，异常 hardening 需用定向回归证明不改变正常响应路径。

## 相关资源
- Memory: `C:\Users\goodb\.claude\projects\C--Users-goodb\memory\telegram_downloader.md`
- 参考实现: [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)、[SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader)
