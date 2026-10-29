# Changelog

本项目从自用脚本整理而来，此文件记录对外发布的变化。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-29

首个公开版本。

### 新增

- **四平台云端签到**：WorkBuddy（签到 + 猫猫旅行 + 成长任务）、Trae CN、码道 CodeArts、Qoder CN，支持多账号。
- **看板 `/panel`**：今日签到、余额、令牌剩余、本月累计、最近事件；≤640px 自动切换为「每个账号一张卡片」，不横向滚动。
- **健康检查 `/health`**：签到汇总、令牌剩余天数、余额合计、告警种类、`refreshOwner`、`magpieSyncDays`。
- **凭据同步**：`scripts/magpie-auth.mjs`（复用上游插件的登录实现：浏览器授权 → 落配置 → 推送）、`scripts/sync-from-magpie.cjs`（批量只读同步）。
- **可选云端事件库**：`db/schema.sql`，按账号 × 日期幂等去重。
- **自检与文档体检**：`scripts/selftest.cjs`（零凭据起实例打端点）、`scripts/check-links.cjs`（相对链接检查），并接入 GitHub Actions。
- **文档**：`README.md`、`docs/CONFIG.md`、`docs/PLATFORMS.md`、`docs/DEPLOY.md`、`ACKNOWLEDGEMENTS.md`、`SECURITY.md`、`CONTRIBUTING.md`。

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
