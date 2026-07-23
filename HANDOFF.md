# HANDOFF — telegram-video-downloader
> 跨 agent/IDE 接手文档 | 最后更新: 2026-07-23 | 改动项目后请同步更新此文档

## 项目定位
Chrome 扩展（Manifest V3），从 Telegram 网页版下载视频，同时支持 Web K（`blob:` URL）和 Web A（`progressive/` 流式 URL）。纯前端扩展，**不是 NAS 服务，无后端、无部署流程、无构建步骤**。
- GitHub: https://github.com/jasonxi89/telegram-video-downloader (public)
- 本地路径: `C:\Users\goodb\Projects\telegram-video-downloader`

## 当前状态
- 版本 **v2.9.3**（manifest.json version 与 git 最新 commit 一致）
- 功能可用：聊天内 + 全屏查看器下载按钮、下载进度显示、Popup 下载队列面板（进度/速度/文件名）、Badge 显示活跃下载数、暂停/恢复/取消/删除、Done 条目保留 + 重下载、album 多视频、同一视频多按钮进度同步、防重复下载
- ⚠️ 2026-07-18/19 代码审查确认一批待修 bug（P0 含暂停/恢复竞态、全屏按钮泄漏、XSS 等），**尚未修复**，清单见下方「进行中 / TODO」
- 工作树干净，main 与 origin/main 同步

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
**2026-07-18/19 多 agent 代码审查 + 对抗性验证确认的待修 bug（只审未修，代码仍为 v2.9.3；行号基于当前代码）：**

### P0 — 可确定触发
- [ ] 暂停/恢复竞态：`downloader.js` fetchNext() 无 in-flight guard，pause 不 abort 进行中的 fetch，resume 可产生并发 fetch 链 → blob 重复/视频损坏（违反本项目"必须顺序下载"核心约束）
- [ ] 全屏查看器悬浮按钮失控：`inject_k.js:214` / `inject_a.js:199` fallback 把按钮挂到 `document.body`，去重检查却只查 viewer 内部 → 每 600ms 新建一个按钮 + 泄漏一个 setInterval，直到关闭查看器
- [ ] 全屏按钮状态不同步：viewer 按钮不检查 COMPLETED_URLS/ACTIVE_DOWNLOADS、收不到进度推送，已完成视频仍显示 "⬇ Download"
- [ ] XSS/HTML 注入：`popup.js` 文件名/错误信息未转义直接拼 innerHTML（94-97、115-117 及 title 属性）→ 恶意文件名可在扩展特权上下文执行
- [ ] postMessage 桥零验证：content.js / downloader.js 只检查 `event.source === window`，页面任意脚本可伪造下载命令/假状态；`window.__TG_DL` 全局 API 无认证 → 需加 token/origin 校验
- [ ] 扩展 reload 后消息桥静默死亡：content.js sendMessage 失败无检查，下载状态永久冻结无恢复

### P1 — 低概率但已确认
- [ ] mid-download 服务器返回 200 替代 206 → 整文件追加到部分 chunk，静默损坏（downloader.js 106-116 / 135-138）
- [ ] Content-Range 异常格式被 RANGE_REGEX 静默忽略 → 文件截断却报成功
- [ ] SW 冷启动竞态：downloads merge 丢 dl-progress skeleton 的 url 字段（background.js:84）
- [ ] setTimeout 存储节流非 MV3-suspend-safe，SW idle-kill 丢挂起写入（background.js 51-62）
- [ ] 无 forward-progress guard：异常代理重复返回同一 Content-Range 会无限循环

### P2 — 质量/体验
- [ ] 用户取消被误报为下载失败
- [ ] 页内 COMPLETED_URLS Set 无上限增长（background 端有 500 上限，两端不一致）
- [ ] 整文件 blob 在内存累积，大视频占多 GB → 考虑流式落盘
- [ ] MAIN world UI 字符串硬编码英文（chrome.i18n 在 MAIN world 不可用，需经消息桥取翻译）
- [ ] 暂停时进度仍被无条件更新，与代码注释矛盾（background.js 150-160）
- [ ] popup port 竞态：stale disconnect handler 会置空活跃 port（background.js 272-274）
- [ ] 冷启动与 popup onConnect 的 staleness 清理逻辑不一致，paused 条目可能永久卡住（74-81 vs 220-228）
- [ ] pause/resume 命令失败静默回显旧状态，用户无感知（background.js 237-247）

修复时按 P0 → P1 → P2 顺序；每批修完 bump manifest.json 版本 + 更新本文档和 memory `telegram_downloader.md` 更新记录表。

## 相关资源
- Memory: `C:\Users\goodb\.claude\projects\C--Users-goodb\memory\telegram_downloader.md`
- 参考实现: [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)、[SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader)
