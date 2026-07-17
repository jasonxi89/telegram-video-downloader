# HANDOFF — telegram-video-downloader
> 跨 agent/IDE 接手文档 | 最后更新: 2026-07-17 | 改动项目后请同步更新此文档

## 项目定位
Chrome 扩展（Manifest V3），从 Telegram 网页版下载视频，同时支持 Web K（`blob:` URL）和 Web A（`progressive/` 流式 URL）。纯前端扩展，**不是 NAS 服务，无后端、无部署流程、无构建步骤**。
- GitHub: https://github.com/jasonxi89/telegram-video-downloader (public)
- 本地路径: `C:\Users\goodb\Projects\telegram-video-downloader`

## 当前状态
- 版本 **v2.9.3**（manifest.json version 与 git 最新 commit 一致）
- 功能可用：聊天内 + 全屏查看器下载按钮、下载进度显示、Popup 下载队列面板（进度/速度/文件名）、Badge 显示活跃下载数、暂停/恢复/取消/删除、Done 条目保留 + 重下载、album 多视频、同一视频多按钮进度同步、防重复下载
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
- ⚠️ README.md 的「Architecture / Project Structure」章节偏旧，未包含 popup、content.js 消息桥、storage 权限、i18n —— 以本文档和实际代码为准

## 进行中 / TODO
- 无明确 open TODO；状态为「开发中」但主线功能完整可用
- 后续若加功能：记得 bump 版本 + 更新 memory `telegram_downloader.md` 更新记录表

## 相关资源
- Memory: `C:\Users\goodb\.claude\projects\C--Users-goodb\memory\telegram_downloader.md`
- 参考实现: [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)、[SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader)
