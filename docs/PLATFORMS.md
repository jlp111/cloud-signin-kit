# 各平台接口与凭据

> 以下路径与字段均为调用各平台**自身客户端所用接口**的观察结果（核对时间：2026-10-29）。平台可能随时改动，失效时先看 `/log` 与 `/probe`。
> 本项目不含任何平台的私有密钥；所有 token / cookie 都由使用者自己的账号产生。

---

## 1. WorkBuddy（workbuddy.cn / codebuddy.cn）

| 用途 | 方法 & 路径 | 主机 |
|---|---|---|
| 签到状态 | `POST /v2/billing/meter/checkin-activity-status` | `www.codebuddy.cn` |
| 执行签到 | `POST /v2/billing/meter/daily-checkin` | `www.codebuddy.cn` |
| Buddy 列表 / 信息 | `GET /activity/growth/buddy/list`、`GET /activity/growth/buddy/info` | `www.workbuddy.cn` |
| 领取首只 | `POST /activity/growth/buddy/first` | `www.workbuddy.cn` |
| 切换 / 派出 / 领取礼物 | `POST /activity/growth/buddy/switch`、`GET /activity/growth/buddy/travel/status`、`POST /activity/growth/buddy/travel/claim`、`GET /v2/activity/growth/buddy/travel/config`、`POST /v2/activity/growth/buddy/travel/depart` | `www.workbuddy.cn` |
| 余额 | `POST /billing/meter/get-user-resource-summary`（读 `data.Packages[].CycleTotalCapacity / CycleRemainCapacity`） | `copilot.tencent.com` |
| 令牌续期 | `POST /v2/plugin/auth/token/refresh`，头：`X-Refresh-Token`、`X-Auth-Refresh-Source: plugin` | `www.workbuddy.cn` |

凭据：`Authorization: Bearer <accessToken>`。续期需要 `refreshToken`，且**只允许一个主人**（见 `docs/CONFIG.md` 的 `refreshOwner`）。

注意：
- 余额接口在 `www.workbuddy.cn` 上返回 404，真实主机是 `copilot.tencent.com`；且需要 `X-User-Id` / `X-Product: SaaS` / `X-IDE-Type: WorkBuddy` 三个头。
- 猫猫旅行一套动作约 30 个请求/账号，是全部逻辑里最费接口的部分，已单独节流（`BUDDY_MINUTES`）。

---

## 2. Trae CN（api.trae.cn）

| 用途 | 方法 & 路径 |
|---|---|
| 签到状态 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` |
| 执行签到 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim` |
| 额度 / 余额 | `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`，body `{require_usage:true,req_source:0}` |

请求头：`Authorization: Cloud-IDE-JWT <access>`、`x-device-id`、`x-device-brand`、`x-device-type`、`x-os-version`、`x-app-version`。
body 统一 `{req_source: 1}`（签到）或上面余额那条。

结果码：

| code | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | — |
| `9074` | 该账号当前**没有可信设备**（未在客户端登录过） | 标为"无可信设备"，不重试 |
| `9095` | 该设备**今日名额已被别的账号占用** | 标为"设备名额已占"，次日自动重试 |

返回里 `credits` 与 `extra_credits` 是两个字段（如 100 + 100），本项目展示为**合计**（+200），避免看起来像重复计分。

---

## 3. 码道 CodeArts（华为云 devcloud）

| 用途 | 方法 & 路径 |
|---|---|
| 到访会话（触发签到 / 探活） | `GET https://devcloud.cn-north-4.huaweicloud.com/chat/PromptCenterService/v1/ops/delivery?channel=WEB` |

凭据：**浏览器会话 Cookie**，硬要求两项 —— `devclouddevuibjJ_SESSION_ID`（HttpOnly 会话票据）与 `devclouddevuibjtcftk`（CSRF 令牌，会带进 `cftk` 请求头）。缺 `tcftk` 时接口多半回 SPA 的 HTML，表现为"Cookie 明明复制对了却一直失败"，所以粘贴时会直接拦下并说明缺哪个。另有 4 个 WAF/agency 类 Cookie（`HWWAFSESTIME`、`HWWAFSESID`、`devclouddevuibjagencyID`、`BENSESSCC_TAG`）只做提示，缺失通常仍可用。

请求头（缺了会拿到 HTML 而不是 JSON）：`agent-type: PromptCenter`、`cftk: <tcftk 的值>`、`x-requested-with: XMLHttpRequest`、`language/x-language: zh-cn`、`referer: …/chat/home`。

特性（实测）：
- 有效窗口 **1~2 小时**；闲置约 30~60 分钟即可能被判失效，表现为 `DEV.00000001 Token missing`；
- 接口轮询**不会**换发新票据（不是滑动续期），所以云端无法自愈；
- 必须先人工登录一次并粘贴 Cookie；看板的码道区块提供粘贴框，服务端收到后当场实测并补签。

### 「每 5 分钟探活能不能续命」——一个有争议的点，已备好实验

- 我们的实测结论是**续不住**（探得再勤也换不出新票据），所以默认 `CODEARTS_PROBE_MINUTES=360`（6 小时）只是健康检查，不是保活。
- 但社区里有另一种做法：把探活压到 **3 分钟**，并声称能避免闲置失效（见 [ACKNOWLEDGEMENTS.md 第十一节](../ACKNOWLEDGEMENTS.md) 的参考实现）。两边矛盾。

⚠️ 因此这是一个**待实验证伪**的结论，不是既成事实。想自己得出答案：

```bash
# 用一个刚登录的 Cookie（只从文件读，不会进 shell 历史）
node scripts/codearts-keepalive-lab.cjs --cookie=./hw-cookie.txt
```

脚本跑两组对照：**A 组每 5 分钟探一次 / B 组全程不探**，2 小时后给出四种结论之一（探活有效 / 探活非必要 / 探活无效 / 数据无效）。结论落 `hw-lab-result.json`（不含 Cookie 原文）。

- 若实验证明**探活有效** → 把 `CODEARTS_PROBE_MINUTES` 调到 5，体验从"每天贴一次"变成"贴一次管很久"；
- 若证明**探活无效** → 唯一的自动化路径是让一台机器用持久化浏览器 profile 定期重新登录换票（参考实现的做法），代价是那一台机器要常开。

---

## 4. Qoder CN（openapi.qoder.com.cn）

| 用途 | 方法 & 路径 |
|---|---|
| 每日活动列表 | `GET /sash/api/v1/me/campaigns` |
| 领取 | `POST /sash/api/v1/me/campaigns/{campaignId}/claim`（body `{}`） |
| 额度 / 余额 | `GET /api/v2/quota/usage`（读 `addOnQuota.remaining / total / used`） |
| 设备码登录（上游实现） | 浏览器 `https://qoder.cn/device/selectAccounts?...` + 轮询 `GET /api/v1/deviceToken/poll` |
| 令牌刷新（上游实现，本项目不调用） | `POST /api/v1/deviceToken/refresh` |

请求头（按客户端行为）：

```
Authorization: Bearer dt-…
Cosy-ClientType: 10
Cosy-Version: 0.4.1
Cosy-MachineId: <该账号自己的 machineId>
Cosy-MachineOS: win32
Cosy-MachineType: windows_x64
```

要点：
- **每个账号有自己的 `machineId`**（相当于不同设备），这也是同机多号能同时签到的原因；
- CN 端点**不需要** `Cosy-MachineToken` / `machineCode`（国际版可能需要）；
- 活动列表里 `actionType === 'CLAIM_BENEFIT'` 的条目才是每日领取；`claimStatus` 为 `CLAIMABLE` 才能领，`CLAIMED` 表示已领（重复 POST 会返回 `replayed: true`，不会二次发放）。

---

## 凭据获取方式对照

| 平台 | 自动（推荐） | 手动 |
|---|---|---|
| WorkBuddy | `scripts/magpie-auth.mjs --login workbuddy` | 填 `accessToken`(+`refreshToken`) |
| Trae CN | `scripts/magpie-auth.mjs --login trae-cn` | 填 `access` + `deviceId` + `profile` |
| Qoder CN | `scripts/magpie-auth.mjs --login qoder-cn` | 填 `token` + `machineId` |
| 码道 | 无（平台机制限制） | 看板粘贴 Cookie |

自动方式复用的是 [magpie](https://usemagpie.ai) 安装的 OpenCode 认证插件里**它自己的登录实现**（浏览器授权 → 回调 → 落盘），本项目只负责"发起授权 + 取回结果 + 推送"。
