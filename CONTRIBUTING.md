# 贡献指南

感谢你想改进它。这个项目刻意保持**零依赖、单进程、易审计**，请一起守住这个边界。

## 环境

- Node.js ≥ 18（用到内置 `fetch`）
- 不需要 `npm install`

## 本地跑起来

```bash
cp config.example.json config.json     # 填 access_key；账号可以先留空
node src/server.js                     # 默认 http://127.0.0.1:8080
```

## 提交前必须跑的三件事

```bash
node --check src/server.js
node scripts/selftest.cjs      # 起实例 + 打端点，零凭据即可跑
node scripts/check-links.cjs   # 文档相对链接
```

`scripts/selftest.cjs` 会用**临时配置**启动一个实例，验证 `/health`、鉴权 401、`/panel` 渲染、`/index.html`、`/digest`。
新增端点时请顺手在里面加一条断言。

## 代码约定

| 约定 | 说明 |
|---|---|
| 依赖 | **不加 npm 运行时依赖**。若必须加，请在 PR 里说明为什么不能用内置能力 |
| 模块制式 | `src/server.js` 与 `scripts/*.cjs` 用 CJS；`scripts/magpie-auth.mjs` 用 ESM（因为要 `import` 插件包） |
| 语言 | 注释与日志用中文；标识符用英文 |
| 幂等第一 | 任何"领取/签到"动作必须能安全重跑：先查状态、已领则跳过，并往 `state.json` 记 `day` |
| 失败隔离 | 单账号失败只影响自己（标 `🔑`），绝不让一个号拖垮整轮 |
| 节流 | 新加的周期性工作必须自带节流常量（参考 `BUDDY_MINUTES`），不要每轮都打接口 |
| 日志 | 打结果与错误码，**不打** token / cookie / machineId |

## 新增一个平台

见 README 的「[如何新增一个平台](README.md#如何新增一个平台)」。要点：
实现 `xxxRound(st)` + 在 `PLATFORMS` 注册，看板/健康检查/战报会自动纳入，不需要改渲染代码。

## PR 要求

- 一个 PR 做一件事；标题写清"改了什么 + 为什么"
- 说明**验证方式**：跑了 selftest？手工打了哪个端点？涉及 UI 的话附截图（手机宽度请用 390px 视口）
- **禁止**提交任何真实凭据、`config.json`、`.env`、`state.json`、日志文件
- 若改了配置字段：同步更新 `config.example.json`、`docs/CONFIG.md`、`README.md`

## 关于与平台的关系

本项目不隶属于任何被对接的平台。请勿提交绕过付费、批量注册、代签牟利之类的内容——这类 PR 会直接关闭。
