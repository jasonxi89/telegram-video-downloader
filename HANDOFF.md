# HANDOFF — telegram-video-downloader
> 跨 agent/IDE 接手文档 | 最后更新: 2026-09-08 | 改动项目后请同步更新此文档

## 项目定位
Chrome 扩展（Manifest V3），从 Telegram 网页版下载视频，同时支持 Web K（`blob:` URL）和 Web A（`progressive/` 流式 URL）。纯前端扩展，**不是 NAS 服务，无后端、无部署流程、无构建步骤**。
- GitHub: https://github.com/jasonxi89/telegram-video-downloader (public)
- Windows 路径: `C:\\Users\\goodb\\Projects\\telegram-video-downloader`
- macOS 路径: `/Users/vn59ngs/Documents/personal/telegram-video-downloader`

## 当前状态
- 版本 **v2.10.2（开发中，未 release）**：基于 v2.10.1，增加顺序 Range 完整性校验；本轮 Chrome 登录态回归尚未执行。
- 功能可用：聊天内 + 全屏查看器下载按钮、下载进度显示、Popup 下载队列面板（进度/速度/文件名）、Badge 显示活跃下载数、暂停/恢复/取消/删除、Done 条目保留 + 重下载、album 多视频、同一视频多按钮进度同步、防重复下载
- v2.10.0 已修：暂停/恢复并发链、Viewer 悬浮按钮泄漏与媒体切换状态、inline/album 稳定 media key、Popup XSS、持久化 Cancel ACK/误报、扩展 reload bridge 恢复、SW 冷启动状态屏障、popup port 竞态、注入按钮键盘语义；**Web K viewer 按钮状态同步仍未解决**（实测 viewer blob 为 MSE，见 TODO）
- `postMessage` 已加入 origin/type/schema/sender/tab ownership 校验，但 MAIN world 与 Telegram 页面同信任域，真正的通道认证及公开 `window.__TG_DL` API 收口仍待设计；P1/P2 其余清单见下方
- 当前开发分支：`fix/download-integrity`（基线 `a2875d0` / main v2.10.1）

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
- [ ] 全屏按钮状态不同步（**Web K viewer 仍未解决**）：v2.10.0 的签名桥接（inline `stream/{JSON}` 注册 size+duration+dimensions 签名 → Viewer blob 1-byte Range probe 反查）经 2026-07-23 Playwright 实测**在真实环境不生效**：①Viewer blob 是 MediaSource object URL，fetch 带不带 Range 都直接 "Failed to fetch"，probe 100% 走 catch 降级；②Viewer 播放不同清晰度层（实测 inline 1920×1920 / viewer 1080×1080），签名维度也不匹配。降级安全（回到无同步的旧行为），inline/album 间的 key 同步有效。正确修法见 issue：Viewer 打开时刻从来源 bubble 捕获消息身份注册 `viewerBlobSrc → key`，不要从 blob 内容推导
- [x] XSS/HTML 注入：v2.10.0 Popup 全面改用 createElement/textContent、状态白名单与 pct 数值 clamp，不再拼 innerHTML
- [ ] postMessage 桥认证：v2.10.0 已完成显式 origin、消息 type/schema、Telegram sender URL、tab ownership 校验；但同源 Telegram 页面仍能观察/伪造 MAIN-world 消息，`window.__TG_DL` 仍公开，需另行设计真正认证边界
- [x] 扩展 reload 后消息桥静默死亡：v2.10.0 content bridge 增加失败上报和 generation guard，SW 在 install/startup 为现有 Telegram tabs 重新注入 bridge

### P1 — 低概率但已确认
- [x] v2.10.2：中途 200 明确失败且不保存；首次无 Content-Range 的 200 整文件仍支持。
- [x] v2.10.2：206 强制安全整数、起点等于请求 offset、合法终点、total 不变、实际 body 长度匹配；不满足则 abort/error，不保存、不上报无效进度。
- [x] SW 冷启动竞态：v2.10.0 为 dl-progress skeleton 保留已校验的 url，并用 `stateReady` 屏障保证 completedUrls/Popup snapshot 在恢复后同步
- [ ] 下载进度的 setTimeout 存储节流仍非 MV3-suspend-safe，SW idle-kill 可能丢挂起写入；Cancel ACK 已改为先持久化 `cancelling`，重启/Popup stale sweep 可恢复为 error，不再只依赖内存 timer
- [x] v2.10.2：严格连续范围和非空 body 保证 offset 前进，重复块/跳块/重叠块均失败。

### P2 — 质量/体验
- [x] 用户取消被误报为下载失败：v2.10.0 分离 onCancel/onError，并要求 background 收到 dl-cancel ACK 后才删除；`cancelling` 状态先持久化，失败、超时或 SW suspend 后恢复均保留可见 error
- [ ] 页内 COMPLETED_URLS Set 无上限增长（background 端有 500 上限，两端不一致）
- [ ] 整文件 blob 在内存累积，大视频占多 GB → 考虑流式落盘
- [ ] 所有运行时 UI 字符串硬编码英文（MAIN + Popup + background error；chrome.i18n 在 MAIN world 不可用，需经消息桥取翻译）
- [ ] 暂停时进度仍更新 offset/total/pct，与代码注释矛盾
- [x] popup port 竞态：v2.10.0 stale disconnect 仅在 `popupPort === port` 时清空活跃 port
- [ ] 冷启动与 popup onConnect 的 staleness 清理逻辑不一致，paused 条目可能永久卡住
- [x] pause/resume 命令失败静默回显旧状态：v2.10.1 增加 pendingCommandTimers（2s ack 超时）+ 投递失败即时反馈；两种失败都在条目 detail 行显示 "⚠ Pause/Resume was not confirmed by the page"（transient `commandError` 字段，不改真实 status，ack/终态到达即清除，SW 重启不残留）；回归测试 scratchpad test_pause_feedback.js 三场景全过
- [x] 注入下载/Re-download 控件不可键盘操作：v2.10.0 改为原生 button，并为 Popup progress 增加 ARIA 语义

### PR #1 审查跟进（2026-07-23）
- [x] Web K blob key：核对 tweb 源码确认 inline 可能为 `stream/{JSON}`、Viewer 可能为 `blob:`；现从 stream metadata + video metadata 注册媒体签名到 `doc:id`，blob 仅 Range 读取 1 byte 并用 Content-Range 总大小 + duration + dimensions 映射，key 随下载状态持久化；签名冲突时不猜测
- [x] Viewer stale-click：Web K/A 点击时实时查询 active viewer video，不再信任最多 600ms 前的 `btn._video`
- [x] Cancel timer suspend：持久化 `cancelling`，SW 恢复和 Popup stale sweep 可确定转 error，并立即写回 storage
- [x] Minor：移除无人监听的 bridge-error 页面消息、下载 ID 固定补齐 6 位、content origin 改为动态同源、本文档补充 cancel timer 说明
- [x] `f373ea4` 复审 blocker → `5d483d6` 签名桥接实现正确但**实测假设不成立**（2026-07-23 Playwright 登录态实测 @TelegramTips：viewer blob 为 MSE 不可 fetch + viewer/inline 清晰度层不同）；决定按选项 A：重标 P0 同步项为 open，机制保留（对 inline/album key 稳定有价值），viewer 同步转 follow-up issue
- [x] 登录态实测（2026-07-23，Playwright + 用户扫码）：确认 Web K inline=`stream/{JSON}`、viewer=MSE blob（不可 fetch）；**自定义 viewer 按钮 fetch blob 永远无法下载流式视频（v2.9.3 baseline 亦然），unhide 原生下载按钮是 viewer 唯一可靠下载路径**
- [x] 装扩展后的 7 项 Chrome 功能手测（PR 描述清单）：用户于 2026-07-23 在 v2.10.1 上完成（测试中发现的 pause 反馈问题已随 v2.10.1 修复；pause 粒度限制转 issue #3）

修复时按 P0 → P1 → P2 顺序；每批修完 bump manifest.json 版本 + 更新本文档和项目 memory。任何下载核心改动必须保留 v2.9.3 已实机验证 working 的 MAIN-world + 顺序 Range baseline，异常 hardening 需用定向回归证明不改变正常响应路径。

## v2.10.2 下载完整性加固（2026-09-08）
- 自动测试：Node.js 22+，运行 `node --test tests/*.test.cjs`；无依赖、无网络、无真实下载，执行实际 downloader.js 的 VM harness。
- 保留 MAIN world、顺序 `Range: bytes=<offset>-`、暂停允许当前 chunk 收尾、取消 ACK 和 UI callback 隔离。
- body 完整读取且校验通过后才追加 Blob、推进 offset/total、计算速度和发送进度；取消后的迟到 body 不再产生进度或保存。
- 首次 200 支持无 Content-Length；identity 编码有长度时必须与 body 匹配。编码后的 200 以 Fetch 解码后的 body 大小为准；编码的 206 保守拒绝，避免把编码字节范围用于解码后的字节。
- 长度/范围校验不等于内容校验：相同长度的错误内容、无长度 200 的服务端静默截断不在本轮可验证范围内。
- 本轮不改 Viewer、并行策略、流式落盘或 stale 策略。新增 `dl-activity` 经 content → background 等待 stateReady 后复查 ownership/state，仅刷新已知 active/paused 条目的活跃时间，不推进字节、不确认命令、不复活终态、不延长 cancelling deadline。这是仅响应头时的 liveness：body 单次读取超过 30 秒仍可能被旧 stale 策略误报，后续另修。
- 新增三层集成测试，执行真实 downloader/content/background：0s 开始、20s 收到头、31s 打开 Popup 时仍 active 且可取消；验证 activity 不跨 tab、不创建条目、不吞 pause 超时和 cancel 超时。
- 自动测试当前 46/46 通过；覆盖错误 HTTP 携带合法 Range、指数格式 Content-Length、校验前不得 activity、Blob URL 定时释放、编码大小写、延迟 storage 恢复和 bridge 来源校验。5 个定向变异（状态校验、长度语法、activity 顺序、URL 释放、恢复屏障）均能触发测试失败。
- 独立 Opus/Astra 复审进行中；本轮 Chrome 功能验证尚未执行，不得沿用 v2.10.1 的实机结果宣称新版已 release。

## 相关资源
- Memory: `C:\Users\goodb\.claude\projects\C--Users-goodb\memory\telegram_downloader.md`
- 参考实现: [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)、[SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader)
