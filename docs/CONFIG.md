# 配置说明

配置文件默认在项目根目录 `config.json`（可用 `CONFIG_PATH` 改），结构见 [`../config.example.json`](../config.example.json)。
**环境变量优先于文件**，云上部署时建议把凭据放进环境变量/密钥管理，文件里只留空占位。

---

## 1. 顶层

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_key` | string | ✅ | 后台密钥。访问 `/panel`、`/status`、`/tick`、`/log` 等需带 `?key=` 或 `Authorization: Bearer`。建议 32 位随机串（`openssl rand -hex 16`）。环境变量：`ACCESS_KEY` |
| `refreshOwner` | `"magpie"` \| `"cloud"` | — | 令牌续期由谁负责。`magpie`（默认）＝云端只借 access、不刷新，避免与上游工具互相作废；`cloud`＝云端自己刷。 |
| `fallbackRefresh` | boolean | — | 默认 `true`。当 `refreshOwner=magpie` 但上游已 `FALLBACK_AFTER_DAYS` 天没同步、且 access 快到期时，云端破例自刷一次（否则必然断）。设 `false` 完全禁用。 |
| `magpieSyncAt` | ISO 时间 | — | 上次从上游同步凭据的时间，用于上面那条兜底判断。由 `/sync-from-magpie` 自动写入，一般不用手填。 |
| `cloud` | object | — | 可选事件库，见下。 |

## 2. `cloud`（可选）

| 字段 | 环境变量 | 说明 |
|---|---|---|
| `endpoint` | `CLOUD_DB_ENDPOINT` | Postgres 兼容 BaaS 的地址 |
| `publishableKey` | `CLOUD_DB_KEY` | 公开（受限）密钥 |
| `resourceId` | `CLOUD_DB_RESOURCE` | 资源 id（若平台需要） |

留空 → 服务照常运行，只是看板没有"本月累计 / 最近事件"。建表 SQL：[`../db/schema.sql`](../db/schema.sql)。
需要的 SDK：`@tencent-ai/workbuddy-cloud-sdk`（由托管平台提供，未安装时自动降级）。

## 3. `accounts[]` —— WorkBuddy

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 账号标签，同时是状态键。改名字等于换了一个号（历史统计不再计它）。 |
| `uid` | 建议 | 平台 uid，用于重名分辨与去重 |
| `accessToken` | ✅ | 调用 `workbuddy.cn` / `codebuddy.cn` 接口的凭据 |
| `refreshToken` | — | 有它云端才能续期/兜底自刷 |
| `expiresAt` | — | access 过期时间（毫秒时间戳），用于剩余天数与告警 |
| `refreshExpiresAt` | — | refresh 过期时间（毫秒时间戳） |

## 4. `trae.accounts[]` —— Trae CN

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 账号标签 |
| `uid` | 建议 | 平台 uid |
| `access` | ✅ | `Cloud-IDE-JWT`，放在 `Authorization` 头里 |
| `deviceId` | ✅ | 设备 id，签到接口强校验；不匹配会返回 9074/9095 |
| `altDeviceIds` | — | 备用设备 id 列表，主设备报"名额被占"时依次尝试 |
| `expires` | — | 过期时间（毫秒时间戳） |
| `profile` | — | 设备指纹：`ua` / `brand` / `type` / `os` / `appVersion`，与服务端校验的设备画像保持一致更稳 |

**错误码**：`9074` = 该号当前无可信设备（未在客户端登录）；`9095` = 该设备今天的名额已被别的账号占用。两者都不算故障，看板会分别标注。

## 5. `codearts.accounts[]` —— 华为云码道

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 账号标签 |
| `cookie` | ✅ | 浏览器会话 Cookie 串，必须含 `devclouddevuibjJ_SESSION_ID` |
| `sessionOkAt` | — | 上次实测可用的时间（服务端回写） |
| `cookieAt` / `cookieTouchedAt` | — | 会话续期/改动时间（服务端回写，用于判断新鲜度） |

会话 Cookie **约 1~2 小时失效**，且接口轮询不会换发新票，因此**只能人工粘贴**：打开看板码道区块贴进去，服务端会当场实测并补签。

## 6. `qoder.accounts[]` —— Qoder CN

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 账号标签 |
| `uid` / `accountId` | 建议 | 平台标识 |
| `token` | ✅ | `dt-` 开头的设备 token |
| `tokenExpiresAt` | 建议 | ISO 时间；剩余 3 天会告警 |
| `base` | ✅ | `https://openapi.qoder.com.cn`（国际版为 `https://openapi.qoder.sh`） |
| `machineId` | ✅ | **该账号自己的**设备身份（UUID）。不同账号用不同 machineId，等价于不同设备。 |
| `fingerprint` | — | 可选设备画像：`machineId` / `machineOS` / `machineType` / `machineCode` / `machineToken` / `cosyVersion`。CN 端点实测**不需要** `machineToken`。 |
| `fpSource` | — | 仅作标记（如 `magpie`），方便排查 |

> 不要把 `refresh` 放进 Qoder 配置：本项目刻意不存、不刷，避免与上游抢同一条设备链。

---

## 环境变量总览

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `ACCESS_KEY` | — | 覆盖 `config.access_key` |
| `TICK_MINUTES` | `60` | 主循环间隔；只影响"没签上时多久重试" |
| `BUDDY_MINUTES` | `120` | WorkBuddy 猫猫检查间隔（最费接口） |
| `BALANCE_MINUTES` | `360` | 余额查询间隔 |
| `CODEARTS_PROBE_MINUTES` | `360` | 码道会话探针间隔 |
| `FALLBACK_AFTER_DAYS` | `7` | 兜底自刷的"上游多久没同步"阈值 |
| `CONFIG_PATH` / `STATE_PATH` | 项目根 | 配置文件 / 状态文件路径 |
| `CLOUD_BASE` | `http://127.0.0.1:$PORT` | 同步脚本的推送目标 |
| `SHARE_CODE` | 空 | 托管平台要求时的分享码 |

## 校验与排错

```bash
node --check src/server.js                 # 语法
curl -s "http://127.0.0.1:8080/health?key=$ACCESS_KEY" | jq .
curl -s "http://127.0.0.1:8080/probe?key=$ACCESS_KEY" | jq .   # 出网探测
```

常见症状：

| 症状 | 原因 / 处理 |
|---|---|
| 启动即报 `找不到 config.json` | 复制 `config.example.json` 或设 `CONFIG_PATH` |
| `/panel` 401 | `?key=` 与 `access_key` 不一致 |
| 某号显示 `🔑 待重导` | 凭据失效：重跑 `scripts/magpie-auth.mjs --login <平台>` 或重贴 Cookie |
| 看板无"本月累计" | 未接 `cloud`，或表未建（见 `db/schema.sql`） |
| 日志反复 `9074/9095`（Trae） | 该号未在客户端登录 / 设备名额被占，属平台限制 |
