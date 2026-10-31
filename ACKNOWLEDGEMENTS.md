# 致谢 / 参考

本项目的**签到业务逻辑**（四平台接口调用、调度与节流、看板、HTTP 接口）为原创；
但**凭据获取与令牌续期**这部分能成立，依赖开源社区已有的实现与协议读法。以下逐项署名。

> 链接核验：2026-10-29 逐个打开确认存在（非 404），核验方式见文末「核验记录」。

---

## 一、直接复用（运行时 import 其代码）

`scripts/magpie-auth.mjs` **不复制**这些包的代码，而是在运行时 `import` 本机已安装的模块，
调用其导出的 `auth.methods[].authorize()`（登录）与 `auth.refresh`（续期）。它们升级，本项目自动受益。

| 名称 | 版本 | 用途 | 来源 | 许可 |
|---|---|---|---|---|
| `@magpie-community/opencode-workbuddy-auth` | 0.1.46 | WorkBuddy 浏览器登录与令牌续期；本项目据此对接 `workbuddy.cn` / `codebuddy.cn` 的签到与余额接口 | <https://github.com/magpie-community/plugins/tree/main/packages/workbuddy> | MIT（package.json 声明） |
| `@magpie-community/opencode-trae-auth` | 0.2.25 | Trae CN 登录（本机 127.0.0.1 回调）、设备指纹与续期；`Cloud-IDE-JWT`、`x-device-*`、9074/9095 语义 | <https://github.com/magpie-community/plugins/tree/main/packages/trae> | MIT（package.json 声明） |
| `@magpie-community/opencode-qoder-auth` | 0.2.48 | Qoder CN 的 PKCE 设备码登录、`Cosy-*` 请求头、活动/额度接口读法 | <https://github.com/magpie-community/plugins/tree/main/packages/qoder> | MIT（package.json 声明）；包内另附 `LICENSE-CLIProxyAPI`，见第三节 |
| `opencode-codearts-auth`（`github:yuweihao17/codearts`） | — | 华为云码道的 OAuth（PKCE + DPoP）与 SDK-HMAC-SHA256 签名实现；本项目参考其会话/积分路径判断 | <https://github.com/yuweihao17/codearts> | MIT（package.json 声明） |

## 二、凭据来源工具

| 名称 | 用途 | 来源 | 许可 |
|---|---|---|---|
| **magpie** | 上游「多 Agent / 多订阅统一管理」的本地网关应用。本项目把它的 `plugin-auth.json` 当作凭据来源，并经它安装的插件发起登录 | 源码：<https://github.com/yetone/magpie>　官网/下载：<https://usemagpie.ai> | MIT |

`usemagpie.ai` 即 `yetone/magpie` 的官方站点与下载入口（README 中互相指向）。

## 三、上游协议参考（由上述插件在其 README 中署名）

诚实地说：我读的是**插件的实现**，而插件本身也是照着更上游的项目做的。
以下项目并非本项目直接调用，但它们是这套协议知识的源头，一并致谢。

| 名称 | 用途 | 来源 | 许可 | 关系 |
|---|---|---|---|---|
| **CLIProxyAPI** | Qoder 插件的部分实现衍生自它，随 `@magpie-community/opencode-qoder-auth` 附带 `LICENSE-CLIProxyAPI` | <https://github.com/router-for-me/CLIProxyAPI> | 见该仓库 | 二级（插件依赖） |
| **wallechfox/qoder-checkin** | Qoder「每天领 100 Credits」的实现；Qoder 插件的签到（`me/campaigns` 列表 + `claim`）**明确注明取自该项目** | <https://github.com/wallechfox/qoder-checkin> | MIT | 三级（插件署名的来源） |
| **sunp-1/qoder-checkin** | 上一个项目的上游：DPAPI + AES-GCM 解密与 `runtime-info.exe` 设备标识提取逻辑的来源 | <https://github.com/sunp-1/qoder-checkin> | MIT | 四级（上游的上游，一并署名） |
| **wangqi233/trae2api** | Trae 双区域（cn/sg）协议逆向；trae 插件 README 将其列为协议来源 | <https://github.com/wangqi233/trae2api> | 见该仓库 | 三级 |
| **autumnsentiment/Trae2api-cn** | 同上，Trae CN 协议来源之一 | <https://github.com/autumnsentiment/Trae2api-cn> | 见该仓库 | 三级 |
| **models.dev** | 模型能力（是否支持图片等）的兜底数据源；由 qoder 插件使用 | <https://models.dev> | 见该站 | 三级（插件依赖） |

## 四、宿主与协议

| 名称 | 用途 | 来源 | 许可 |
|---|---|---|---|
| **OpenCode** | 认证插件的宿主与插件协议（`auth.methods[].authorize()`、`auth.refresh` 等接口约定） | <https://opencode.ai>　<https://github.com/sst/opencode> | MIT |

## 五、运行时

| 名称 | 用途 | 来源 | 说明 |
|---|---|---|---|
| **Node.js**（≥ 18） | 唯一运行时；只用内置 `http` / `fs` / `path` / `fetch` / `AbortSignal` | <https://nodejs.org> | 本项目 `dependencies` 为空 |

## 六、可选依赖

| 名称 | 用途 | 来源 | 说明 |
|---|---|---|---|
| **@tencent-ai/workbuddy-cloud-sdk** | 可选：把运行事件写进云端 Postgres 兼容库 | 由托管平台提供 | 未安装时自动降级为仅写本地 `state.json` |
| **Supabase**（或任何 Postgres 兼容 BaaS） | 可选：承载事件表 `wbmon_events` | <https://supabase.com> | 建表 SQL 见 `db/schema.sql` |

## 七、开发期工具（非运行依赖）

| 名称 | 用途 |
|---|---|
| **Chrome / Chromium（headless）** | 移动端适配验证：把页面放进 390px iframe 渲染，读 `clientWidth / scrollWidth` 判断横向溢出。注意 Windows 上 Chrome 有最小窗口宽度（实测被钳到 497px），直接 `--window-size=390` 会得到裁切图而误判 |
| **浏览器自动化工具（MCP）** | 人工核对看板与落地页渲染 |

## 八、平台与服务

以下为各公司**未开源的服务**，此处仅作来源说明，不构成任何授权或关联：

| 服务 | 归属 | 本项目使用的接口 |
|---|---|---|
| WorkBuddy / CodeBuddy | 腾讯 | 签到、Buddy 旅行、余额（详见 `docs/PLATFORMS.md`） |
| Trae CN | 字节跳动 | `checkin_credits/*`、`pay/ide_user_ent_usage` |
| 码道 CodeArts | 华为云 | `PromptCenterService/v1/ops/delivery` |
| Qoder CN | Qoder | `me/campaigns`、`quota/usage` |

上述名称与商标归各自权利人所有；本项目与这些公司**没有隶属或背书关系**。

## 九、合规提醒

- 自动调用平台接口可能违反其服务条款；账号风控与封禁风险由使用者自行承担。
- 请只对**自己拥有或被明确授权**的账号使用；不要用于批量注册、代他人签到或任何盈利性转售。
- 若平台要求停止，请立即停止使用并删除相关凭据。

---

## 十、第三方组件声明（NOTICE）

本仓库根目录的 `LICENSE` **只覆盖本项目自身代码**（MIT）。
上文列出的第三方组件（插件、宿主、上游参考项目）均为独立作品，版权归各自作者，
其许可条款以各自的 `package.json` / `LICENSE` 文件为准，本仓库不重复收录其全文。

若你需要在本项目基础上二次分发，请一并保留上述组件的版权与许可声明。

---

## 核验记录（2026-10-29）

| 链接 | 结果 |
|---|---|
| `usemagpie.ai`、`opencode.ai`、`supabase.com`、`models.dev` | HTTP 200 |
| `github.com/magpie-community/plugins/tree/main/packages/{workbuddy,trae,qoder}` | 逐个打开确认：目录存在，包名与版本与本地安装一致（0.1.46 / 0.2.25 / 0.2.48） |
| `github.com/yetone/magpie` | 存在；README 明确 `usemagpie.ai` 为其官网；MIT |
| `github.com/wallechfox/qoder-checkin` | 存在；MIT；其 README「致谢」指向 `sunp-1/qoder-checkin` |
| 其余 GitHub 链接 | 由 URL 抓取工具核验（本机 `curl` 直连 GitHub 被拦截，返回 000，并非链接失效） |

许可证声明以**各包自己的 `package.json` / LICENSE 文件**为准；本页只做转述，不替代原文。
若你是这些项目的作者而希望调整署名方式，请提 issue，我会按你的要求修改。

---

## 十一、参考实现（设计思路借鉴，未复制代码）

| 项目 | 我们借鉴了什么 | 来源 |
|---|---|---|
| **wangmingdong/workbuddy-signin** | 码道（华为云 devcloud）会话的**保活与换票思路**：① 会话闲置 30~60 分钟会失效；② 用持久化浏览器 profile 定期访问 `/chat/home`，让 SSO 自动签发新会话；③ 推送前必须用只读接口实测有效性，且**判据是响应体里的活动字段，不是 HTTP 200**；④ 必需 Cookie 不止 `SESSION_ID`，还要 `tcftk`（以及几个 WAF 类）| <https://github.com/wangmingdong/workbuddy-signin>（`huawei/hw_keeper.js`、`hw_autopush.py`、`hw_keepalive.py`）|

本项目**没有复制**上述仓库的代码（它们是 Python + Playwright + SSH/SFTP 推送；我们是零依赖 Node + HTTP 端点热更新）。实际采纳的只有「Cookie 完整性校验（`SESSION_ID` + `tcftk`）」与「HTTP 200 ≠ 会话有效的判据」两条，其余作为**可选路径**记录在 `docs/PLATFORMS.md`，并用 `scripts/codearts-keepalive-lab.cjs` 做对照实验后再决定是否采纳。
