# HANDOFF — telegram-video-downloader
> 跨 agent/IDE 接手文档 | 最后更新: 2026-09-15 | 改动项目后请同步更新此文档

## 项目定位
Chrome 扩展（Manifest V3），从 Telegram 网页版下载视频，同时支持 Web K（`blob:` URL）和 Web A（`progressive/` 流式 URL）。纯前端扩展，**不是 NAS 服务，无后端、无部署流程、无构建步骤**。
- GitHub: https://github.com/jasonxi89/telegram-video-downloader (public)
- Windows 路径: `C:\\Users\\goodb\\Projects\\telegram-video-downloader`
- macOS 路径: `/Users/vn59ngs/Documents/personal/telegram-video-downloader`

## 当前状态
- 版本 **v2.11.2（开发中，未 release）**：v2.11.1（Retry + Popup 合帧/DOM 复用）经 Windows 侧审查后修掉 4 条 minor + 1 nit（见下方 v2.11.2 段），84 项自动测试通过。v2.11.x 尚未做 Chrome 实机验收；Windows 工具栏图标偶尔完全不弹窗的根因尚未确认。
- 功能可用：聊天内 + 全屏查看器下载按钮、下载进度显示、Popup 下载队列面板（进度/速度/文件名）、Badge 显示活跃下载数、暂停/恢复/取消/删除、Done 条目保留 + 重下载、album 多视频、同一视频多按钮进度同步、防重复下载
- v2.10.0 已修：暂停/恢复并发链、Viewer 悬浮按钮泄漏与媒体切换状态、inline/album 稳定 media key、Popup XSS、持久化 Cancel ACK/误报、扩展 reload bridge 恢复、SW 冷启动状态屏障、popup port 竞态、注入按钮键盘语义；**Web K viewer 按钮状态同步仍未解决**（实测 viewer blob 为 MSE，见 TODO）
- `postMessage` 已加入 origin/type/schema/sender/tab ownership 校验，但 MAIN world 与 Telegram 页面同信任域，真正的通道认证及公开 `window.__TG_DL` API 收口仍待设计；P1/P2 其余清单见下方
- 当前开发分支：`fix/failed-download-retry`（基线 `b732a27` / main v2.10.2）

## 技术栈与结构
纯 JS，无第三方依赖。消息流：`MAIN world → content.js 桥 → background(SW) → popup`。
```
manifest.json   MV3 配置，permissions=[scripting, storage]，host=web.telegram.org
background.js    MAIN world 脚本注入 + 下载状态管理 + badge
 download-actions.js  Popup 命令、重试和取消生命周期（importScripts 加载）
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
- [ ] 冷启动与 popup onConnect 的 staleness 清理逻辑不一致，paused 条目可能永久卡住；v2.11.1 起 onConnect 对 30s 无进度的 active 行只加 `activityWarning` 不改状态（冷启动仍按 60s 转 error），差距进一步拉大：死掉的 active 行在用户 Cancel（2s 后转 error）或下次 SW 冷启动前，badge 会一直计 1
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
- 本轮不改 Viewer、并行策略、流式落盘或 stale 策略。新增 `dl-activity` 经 content → background，仅刷新已知 active/paused 条目的活跃时间；恢复期间经校验的消息按顺序暂存（含 tab 和实际观察时间），先加载 storage，再通过同一个 live handler 回放并复查 owner，最后 stale 分类；回放期间不写中间 storage/Popup 快照，完成后统一保存并清空队列，不推进字节、不确认命令、不复活终态、不延长 cancelling deadline。这是仅响应头时的 liveness：body 单次读取超过 30 秒仍可能被旧 stale 策略误报，后续另修。
- 新增三层集成测试，执行真实 downloader/content/background：0s 开始、20s 收到头、31s 打开 Popup 时仍 active 且可取消；验证 activity 不跨 tab、不创建条目、不吞 pause 超时和 cancel 超时。
- 自动测试当前 60/60 通过；覆盖错误 HTTP 携带合法 Range、指数格式 Content-Length、校验前不得 activity、Blob URL 定时释放、编码大小写、延迟 storage 恢复和 bridge 来源校验。此前 5 个定向变异（状态校验、长度语法、activity 顺序、URL 释放、恢复屏障）均能触发测试失败；本轮补充 65s 旧 active/paused、异 tab、终态、新内存状态优先、过期观察不变新等恢复回归。
- Astra 提出的恢复前 stale 分类及 activity→body error 丢失均已修，新增无 dl-start 的真实三层失败复现和 cancel/complete/pause/resume 顺序回放测试；旧 e96cff4 对 body error 回归确实失败。另补缺失/损坏 storage 校验、逐事件回放异常隔离、badge 异常不压掉最终持久化、真实记录 storage/Popup 输出的门控断言。stateRestored 表示回放完成而非持久化成功，需先打开该门控再最终保存。独立最终复审：`94bb01b` 获 `claude-opus-5-sandbox` 和 `gpt-6-astra` 各自 SAFE TO MERGE（两者独立读源码并跑 60/60 测试）。标准 Opus 通道先前认证失败，实际完成审查的是 Opus sandbox，不混淆模型。本轮 Chrome 功能验证尚未执行，不得沿用 v2.10.1 的实机结果宣称新版已 release。
- 恢复时跳过 null/非对象、非法下载 ID 或内部 id 与 key 不匹配的损坏条目，最终保存会移除这些条目；未实现此类损坏历史的迁移恢复，completedUrls 单独保留。
- 非阻塞后续：>30s body stale 误报、实时路径 badge 异常隔离、损坏时间戳清理、存储错误可见反馈。Opus 的 throwing-getter 实验不代表 Chrome storage 可返回该对象，未据此扩展实现。
- 发布前：重新加载扩展并刷新 Telegram，在 Web K inline 与 Web A 各下载多 chunk 大视频并检查播放、暂停/恢复/取消、Popup 状态及完成文件；Web K Viewer 仍按原生按钮路径验证，不声称 MSE blob 已可 fetch。

## v2.11.0 失败记录 Retry / X（2026-09-10）
- Popup 失败条目新增原生 Retry 按钮（位于 X 左边），从 bytes=0 重新下载，不是断点续传。等待 dl-start 的 retryOf 确认后替换旧记录；期间禁用 Retry/隐藏 X，连续点击只发送一次。
- 下载引擎 Retry 先 abort 同 ID 的存活旧任务再开始新任务，迟到旧 body 不会保存；同页同 URL/key 已有另一任务则拒绝重复下载。页面生命周期内同旧 ID 的 Retry 命令只执行一次。
- 5 秒未确认或无法联系页面则保留错误行并显示原因；旧页面关闭、blob 失效、扩展更新但未刷新页面时需回 Telegram 重开视频。必须重载扩展并刷新 Telegram 使新 MAIN 脚本生效。
- X/Clear 删除 error 记录会尽力向原页面发送 cancel，但删除历史不保证不可达页面的任务已终止。删除后未知 ID 的 progress 不再创建 skeleton，因此重启 SW 后也不会复活已删除条目；代价是从未收到 start 且 storage 无记录的旧下载不会靠进度重新建档。
- Popup 不再乐观删除：等待后台确认，断线显示重开面板提示。后台恢复期间的命令等待 stateReady 后执行。
- 30 秒无进度仅显示活动警告，不改 active 为 Failed，保留暂停/取消；冷启动 60 秒 interrupted 和取消失败仍可能表示状态未知，Retry 会先停止旧 ID。
- 自动回归 75/75 通过：涵盖真实引擎→bridge→background 重试、迟到 body、双击、timeout、跨 tab、删除后迟到进度及 SW 重启、重试再次失败再重试；另有 Popup DOM mock 验证按钮顺序、可访问名称、禁用/等待确认和断线反馈。浏览器 UI/Telegram 实测尚未执行。
- v2.10.2 的 Opus/Astra sign-off 不适用于本轮新代码。

## v2.11.1 下载期间 Popup 更新（2026-09-15）
- 用户报告：Windows / 另一台电脑，下载进行中点 Chrome 工具栏扩展图标，完全没有小窗口，已有下载继续。当前 Mac 未接入故障现场，也未确认 Windows 安装版本；不得把下述可复现问题当作该故障的确定根因。
- 确认原 Popup 每个 dl-update 都 replaceChildren 全列表。真实浏览器中，在鼠标按下与抬起之间送入进度，原按钮被移除，点击命令丢失；500 条历史也随每次进度重复创建。
- Popup 将一帧内的消息合并，按下载 ID 保留行，只更新变化条目的文字、进度和详情；状态或 Retry 状态改变才重建该行控件，行顺序不变时不重新挂载。快照、删除、排序及后台确认语义保持一致。
- 81/81 Node 回归通过；覆盖大量历史下按钮/节点保留、进度突发合并与删除、快照移除与状态排序、重新序列化的完整快照、命令/活动反馈，以及断线提示不被排队刷新隐藏。独立 Chromium 验证进度夹在 pointer-down/up 中时点击正常，500 条历史的 20 次进度不创建新列表元素。
- 留档的首轮 native 探测为 500 条历史 + 1 个活动条目、打开时没有并发进度，openPopup API 约 0.3 秒返回；不能把它作为 2,000 条历史/持续进度压测的证据。后续 headed Chromium 直接检查真实 popup target：两行快照、visible 状态、进度更新及鼠标点击均正常。测试不等于 Windows 工具栏点击或真实 Telegram 下载验收。
- 保留点击的验证针对状态与排序不变的进度更新；完成/暂停等状态变化和行重排仍可能打断正在进行的点击。
- 对抗复查复现：dl-update 排队后端口断开，操作显示断线提示，随后 rAF 会将提示隐藏。现用 connectionLost 状态保持提示；classList mock 改为真实反映类名，测试同时检查提示可见性。
- 下载实际在 Telegram MAIN world 中进行，与 Popup 生命周期独立。Popup 断线无自动重连仍是独立已知问题；本轮未扩展连接协议或修改下载引擎。
- Windows 故障时可在新标签打开 chrome-extension://<扩展 ID>/popup.html，并切到前台查看，区分工具栏弹窗问题与扩展页面问题。后台标签页的 rAF 可能暂停，DOM 可保留旧进度，前台后会追上最新状态。当前后台只保留一个面板连接；诊断时只保留一个下载面板，若之后打开过工具栏弹窗，应刷新诊断标签页重新同步。更新扩展应等当前下载完成；本机改动不会自动同步到 Windows。
- 用户后续补充可能的时序：插件显示一项 Done 后、Chrome 尚未提示文件下载完成的间隔卡住。downloader.js 在 a.click() 请求保存后就发送 dl-complete/执行 onComplete，没有等待 Chrome 的保存结果；manifest 无 downloads 权限。这证明 Done 不等于 Chrome 已完成保存，尚不能证明文件落盘/Blob 处理就是整窗卡住的原因。后续应围绕该交接阶段取证，不把本轮 Popup 渲染修复说成根因修复。

### Opus 对抗审阅及保存交接复核（2026-09-15）
- 已完成两轮实际返回的 `claude-opus-5` 审阅，均以 `end_turn` 结束；最终为 `ACCEPT_WITH_VALIDATION_GAPS`，限于相对 b84f70d 的 Popup 增量，不是 Windows 故障已解决或全量发布验收。
- Opus 同样指出断线提示被排队刷新隐藏的问题；已修复并有失败→通过回归及真实端口前后对照。作者反驳“每条进度消息复制全部历史对象”的判断，Opus 第二轮明确撤回；实际浏览器亦确认 delta 只替换活动条目，而完整快照会替换对象但保留 DOM。
- 后续原生弹窗检查确认断线提示与两行列表无重叠，提示完整位于 300px 高视口内；有截图留档。该检查及后述保存实验在第二轮请求发出后完成，属于作者补充验证，未冒充 Opus 已执行或审阅原始结果。
- 用户确认约 1GB、本地硬盘，“下载前询问每个文件的保存位置”关闭，Chrome 其他操作正常、只有扩展图标没反应。常规另存为对话框和全浏览器停顿不作为当前主线，应观察 Popup 是否创建后立即关闭、资源/渲染是否卡住。真实引擎/bridge/background + 本地拦截数据的实验中，64 MiB 的扩展完成事件领先 Chrome completed 约 64ms；1 GiB 约领先 834ms，期间 openPopup 请求约 344ms 成功。此处仅证明该机器上的事件间隔与 API 响应，不代表 Windows 或真实媒体的表现。
- Chrome 明确拒绝保存的 4 KiB 对照中，浏览器为 canceled、receivedBytes=0，而扩展仍为 complete。完成状态未等待浏览器保存确认是既有问题；本轮不混入下载权限、保存跟踪或引擎协议改造。
- 当前不能因“看不到窗口”推断从未创建 popup，也不能因 Chrome 菜单卡顿就排除扩展触发资源压力；窗口焦点/保存对话框、浏览器停顿均待 Windows 现场验证。
- 审阅、复现脚本、截图和独立结果归档于同级 telegram-video-downloader-artifacts/2026-09-15/opus-review。审阅结论不等于 Windows 发布验收，用户 Windows 扩展尚未更新。

## v2.11.2 审查修复（2026-09-15）
- Windows 侧审查 PR #5（主会话通读 + 两个只读 agent，popup reconcile 随机 2000 序列 fuzz 0 失败）结论无 blocker；合并前顺手修掉 4 条 minor + 1 nit，Node 84/84。审查 agent 提出的"点击按钮文字时 `e.target` 为 Text 节点"是误报（鼠标事件 target 永远是 Element），未采纳。
- `clear-completed` 改为 `forgetDownload` 逐行移除、循环结束统一保存 + 一次 snapshot（此前每行一次全量 storage 写 + dl-delete，实测 500 行 → 501 写/502 消息）；对 error 行的 best-effort cancel 命令保留。
- `dl-complete` 对没有历史行的 id 仍把 key 记入 `completedUrls`（`rememberCompletedKey`），不重建行：文件已保存时 inline 按钮刷新后仍显示 Done；这是去掉 progress 建档后的补偿。
- 页面侧 `retriedDownloads` 守卫的拒绝文案改为 "Retry already requested. Refresh Telegram before trying again."，与后台 5s 超时文案一致；守卫本身仍是页面生命周期内一次性，重载 Telegram 标签页才复位。
- 删除 background.js 中重复的 tab ownership 检查（函数开头已覆盖）；`importScripts` 处加注释说明必须保持同步顶层导入。
- 30s 无进度只加 warning 的副作用（badge 可长期计 1）未改代码，已记入上方 P2 staleness 条目。实机验收（Windows + 真实 Telegram）仍未执行，不能宣称 release。

## 相关资源
- Memory: `C:\Users\goodb\.claude\projects\C--Users-goodb\memory\telegram_downloader.md`
- 参考实现: [Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)、[SuperZombi/Telegram-Downloader](https://github.com/SuperZombi/Telegram-Downloader)
