# 安全策略

## 支持范围

本项目是**自托管工具**，没有服务端组件。安全修复只对最新提交（`main` 分支）负责。

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的私密通道：

> 仓库页 → **Security** → **Report a vulnerability**（GitHub Security Advisory）

这是私有渠道，只有维护者可见。请附：受影响文件与行号、复现步骤、影响范围、你建议的修复方向（如有）。
我会在确认后于同一 advisory 里跟进，并在修复发布后致谢（除非你希望匿名）。

## 绝对不要贴的东西

无论 issue、PR 还是讨论区，**都不要**贴：

- `accessToken` / `refreshToken` / `dt-` 开头的设备 token
- 任何 Cookie（尤其 `devclouddevuibjJ_SESSION_ID`）
- `machineId`、`deviceId`、uid
- 完整 `config.json`、`state.json`、`.env`
- 带 `key=` 的真实看板链接

日志请先脱敏：把上述值替换成 `<redacted>`，只保留 HTTP 状态码、错误码（如 `9074`）、时间戳。

## 本项目的安全边界

| 事项 | 说明 |
|---|---|
| 凭据存放 | 只在你的 `config.json` / 环境变量里；本项目**不上传、不收集、无遥测** |
| 出网 | 只访问 `docs/PLATFORMS.md` 列出的各平台域名；可用 `GET /probe` 自查 |
| 鉴权 | 除 `/`、`/index.html`、`/health` 外，所有端点需 `access_key` |
| 已知风险 | `/panel`、`/status` 会返回账号名与余额 → **务必走 HTTPS 并限制访问来源** |
| 默认关闭 | `/config`、`/tokens` 在源码中以 `if (false && …)` 禁用：它们会导出含 refresh 的完整凭据 |

## 部署者自查清单

- [ ] `access_key` 是随机 32 位以上，且与其它服务不复用
- [ ] `config.json`、`.env`、`state.json` 未被提交（`.gitignore` 已覆盖）
- [ ] 前面有 HTTPS 反代；`/panel` 只对自己可达
- [ ] 服务器与应用是最新版本
- [ ] 定期轮换凭据（重新 `--login` 一次即可）
