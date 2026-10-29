# Changelog

本项目从自用脚本整理而来，此文件记录对外发布的变化。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- **Trae 跨零点假告警**：`status()` 缺"今天还没跑过"的分支，昨天 `claimed` 的记录在 00:00 后被判成失败，导致每天零点到当天首轮之间看板与战报必然报一次红叉（现在判为 `pending`，与码道 / Qoder 一致）。
- **WorkBuddy「活动未开启」不再算已领**：原来直接写 `done=true`，当天彻底不再重试（活动一开就漏签这天），还会刷新 `lastOkAt` 掩盖 `business_stale`。现在写 `done=false, inactive=true`，看板显示"活动未开启（每轮重试）"。
- **状态文件原子落盘**：`config.json` / `state.json` 一律「写临时文件再 rename」，进程被杀不会留下半截 JSON。临时文件名带 pid 与时间戳（`<文件>.tmp.<pid>.<ts>`）而非固定 `.tmp`——互斥之外仍有 fire-and-forget 的写入者会调 `saveState`，固定名会让两个写入者共用一个临时文件、rename 时互相踩空；rename 失败会删掉临时文件，不在目录里堆残留。
- **state 解析失败不再静默归零**：只在文件不存在时当空态；解析失败会记日志并把坏文件备份成 `state.json.corrupt-<ts>`，避免"当天已签标记全丢、所有平台重打一遍接口"却查不到原因。
- **进程内单一状态对象**：tick 与 HTTP 端点共用同一份 state，消除"各入口各自读快照、后写者整体覆盖前者"的丢更新（典型症状：看板粘 Cookie 补签成功后，被正在跑的 tick 回滚）。
- **补跑互斥**：`/codearts-cookie`、`/qoder-cred` 触发的补跑撞上正在跑的一轮时不再并发执行，改为如实返回"已保存，正在跑一轮，稍后自动补签"。
- **云库事件不再因一次失败永久丢失**：`dbEventOnce()` 的返回值此前无人接收、`dbDay` 在请求发出前就被置真；现在只有落库成功才置真。
- **Qoder `base` 校验统一**：`/qoder-cred` 与 `/sync-from-magpie` 走同一套校验（必须 https、无端口/路径/参数、非内网地址），杜绝把 `base` 当成"让服务端请求任意地址"的入口。
- **请求体超限返回 413**：原来直接 `req.destroy()`，客户端只看到连接被重置。
- **`/tick`、`/refresh` 的鉴权由自检钉死**：这两个 POST 端点本身没有 `authed()`，由 `/probe` 之前的统一鉴权闸门拦截（未带 key 返回 401 `未授权`），但自检的未授权矩阵此前只覆盖 GET 端点——闸门被挪位、或在它之前多插一个分支，两个写端点就会裸奔而 CI 不会报警。现在矩阵补上 `POST /tick`、`POST /refresh` 未授权必须 401，并在闸门处注释写明它覆盖到哪些端点。
- **监听失败快速失败**：`server.listen` 的错误（如 `EADDRINUSE`）原来被 `uncaughtException` 兜住，进程"活着但根本没在监听"，调用方只能等到超时；现在打印 `HTTP 服务启动失败：<code> <message>` 并 `exit 1`。启动日志的端口改用 `server.address().port`，`PORT=0` 时输出内核分配的真实端口。

### 文档

- **README 增加英文 TL;DR**：让不看中文的读者 3 秒内知道这是什么、为什么值得用。
- **README 新增「常见问题」表**：解释 9074 / 9095 / 待重导 / 活动未开启 / corrupt 备份文件 / stale 等界面符号，减少无效 issue。
- **README 新增「升级与停止」**：明确升级时不得覆盖 `config.json` / `state.json`。
- **修正「如何新增一个平台」的失真描述**：原文写"只改两处"，实际必改 4 处（漏改 `KIND_PLATFORM` 会静默漏掉整个平台的月度统计）+ 按需 3 处。
- **`CODE_OF_CONDUCT.md` 改为中英双语**；去掉 README 里"约 2100 行"这类会随代码漂移的数字；快速开始里 macOS 专用的 `open` 命令改为通用表述。

### 变更

- **`/health` 按鉴权分级**：未带 `access_key` 只返回数量、告警类别与按平台的余额合计；逐账号明细（`balances.rows`，含昵称）仅在带 key 时下发。入口页在无 `rows` 时退化为"平台 共 N（M 个账号）"合计行。
- **看板删掉「成长任务」列**：该能力未随此版本发布，该列恒显示"今日未跑"，属假信号。
- **运行间隔不再写死**：公开页的"每 20 分钟一轮"改为回显实际的 `TICK_MINUTES`。

### 内部

- 新增 `src/lib.js`（纯函数：日期 / Cookie 解析 / base 校验 / 状态判定），`server.js` 改为引用；新增 `scripts/unit-tests.cjs`（`node:assert`，零依赖，49 条），与 `src/lib.js` 语法检查一起接入 CI 三个 Node 版本矩阵。
- 删死代码：`maybeGrowthTasks`（无调用点，且其内部调用的 `runGrowthTasks` 全文不存在）。
- `scripts/selftest.cjs` 加固：子进程 `PORT=0` 由内核分配端口、从启动日志解析真实端口（消除 Windows 上 `127.0.0.1` 探测能过但 `0.0.0.0` bind 被拒的竞态），并在监听失败时快速失败（exit 1）；新增鉴权矩阵（GET `/panel` `/log` `/digest` `/history` `/probe` 与 POST `/tick` `/refresh` 未授权必须 401）、未鉴权 `/health` 不含账号名、带 key 必须有 `rows`、超大 body 回 413、目录内无 `.tmp.*` 残留等断言。
- `scripts/selftest.cjs` 的 `/health` 轮询抗抖动（并发负载下实测偶发假失败）：超时 20 秒 → 30 秒；每次请求单独加 5 秒超时——原来 `fetch` 无超时，一次连上却不回包就能把轮询整个卡死，次数上限根本轮不到；连接类错误（`ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / 超时 / `fetch failed`）继续重试并 400ms → 1s 退避，非连接类错误（状态码异常、响应体非 JSON）立即失败；失败输出带端口与最后一次错误的 `message` / `cause.code`。

## [1.0.0] - 2026-10-29

首个公开版本。

### 新增

- **四平台云端签到**：WorkBuddy（签到 + 猫猫旅行）、Trae CN、码道 CodeArts、Qoder CN，支持多账号。
- **看板 `/panel`**：今日签到、余额、令牌剩余、本月累计、最近事件；≤640px 自动切换为「每个账号一张卡片」，不横向滚动。
- **健康检查 `/health`**：签到汇总、令牌剩余天数、余额合计、告警种类、`refreshOwner`、`magpieSyncDays`。
- **凭据同步**：`scripts/magpie-auth.mjs`（复用上游插件的登录实现：浏览器授权 → 落配置 → 推送）、`scripts/sync-from-magpie.cjs`（批量只读同步）。
- **可选云端事件库**：`db/schema.sql`，按账号 × 日期幂等去重。
- **自检与文档体检**：`scripts/selftest.cjs`（零凭据起实例打端点）、`scripts/check-links.cjs`（相对链接检查），并接入 GitHub Actions。
- **文档**：`README.md`、`docs/CONFIG.md`、`docs/PLATFORMS.md`、`docs/DEPLOY.md`、`ACKNOWLEDGEMENTS.md`、`SECURITY.md`、`CONTRIBUTING.md`。
- **README 突出核心区别**：单独一节对比 cron / 油猴 / 快捷指令等"必须本机开机"的方案，说明本项目是云端常驻进程，关机、断网、出差都能照签（并标注码道需每日人工贴 Cookie 的边界）。
- **界面截图**：`docs/images/` 下的桌面 / 手机看板图（演示数据渲染，用 `NO_START_TICK=1` 生成，不含真实账号）。

### 设计决策（值得记录）

- **签到与凭据分离**：签到只读 `config.json`，凭据怎么来都可以替换。
- **单刷新链**：`refreshOwner` 默认 `magpie`，云端只借 access、不刷 refresh，避免两边互相作废；
  只有「上游已 7 天没同步且 access 快过期」时才保底自刷一次（`FALLBACK_AFTER_DAYS`）。
- **按需节流**：主循环 60 分钟，但已完成的轮次 **0 请求**；猫猫 120 分钟、余额与码道探针 6 小时。
  实测 20 分钟一轮 ≈ 7000 请求/天，纯空转。
- **码道例外**：会话 Cookie 1~2 小时必死且接口不换发票据，只能人工粘贴——这是平台机制，不是缺陷。

### 已知限制

- Trae CN 依赖上游刷新（云端未存 refresh）；`9074` / `9095` 属平台设备限制，不视为故障。
- Qoder 收到 `-1` 表示的无限额度未做特殊展示（按剩余数值求和）。
- 未实现「跨机器设备池」，同平台多号仍受各平台设备名额约束。
