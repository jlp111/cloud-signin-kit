# 部署与运维

## 0. 前置

- Node.js **≥ 18**（用到内置 `fetch`、`AbortSignal.timeout`）
- 一个能长期运行的进程环境（容器 / VPS / NAS / 云托管）
- 出网能力：需能访问 `www.workbuddy.cn`、`www.codebuddy.cn`、`copilot.tencent.com`、`api.trae.cn`、`devcloud.cn-north-4.huaweicloud.com`、`openapi.qoder.com.cn`
  部署后先跑 `curl "…/probe?key=$ACCESS_KEY"` 确认。

## 1. 目录与文件

```
<安装目录>/
├── src/  public/  scripts/  docs/  db/
├── config.json      ← 必须持久化（含会轮换的 token）
├── state.json       ← 必须持久化（含"今天签过没"）
└── .env             ← 可选，用 process manager 注入更好
```

**两个文件都必须持久化**：
- 丢了 `config.json` → 令牌链断，需要重新导凭据；
- 丢了 `state.json` → 当天会重复走一遍签到流程（一般不会重复发奖，但会多打请求）。

## 2. 最小启动

```bash
cd cloud-signin-kit
cp config.example.json config.json      # 填 access_key 与凭据（或改用环境变量）
ACCESS_KEY=$(openssl rand -hex 16) node src/server.js
```

首次启动会立刻执行一轮，然后按 `TICK_MINUTES` 循环。日志直接打印到 stdout。

## 3. 用环境变量注入（推荐云上）

```bash
export PORT=8080
export ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TICK_MINUTES=60
export BUDDY_MINUTES=120
node src/server.js
```

`config.json` 里可把 `access_key` 留空占位（会被 `ACCESS_KEY` 覆盖）。凭据部分若也用 env，
建议只覆盖密钥类字段；账号数组仍放文件（或用上游脚本 `--push` 写入）。

## 4. Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
# config.json / state.json 挂载进来，保证跨容器存活
VOLUME ["/app/config.json", "/app/state.json"]
CMD ["node", "src/server.js"]
```

```bash
docker build -t cloud-signin .
docker run -d --name cloud-signin -p 8080:8080 \
  -e ACCESS_KEY=xxxxxxxx \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/state.json:/app/state.json \
  --restart unless-stopped cloud-signin
```

## 5. systemd（Linux）

```ini
[Unit]
Description=cloud-signin-kit
After=network-online.target

[Service]
WorkingDirectory=/opt/cloud-signin-kit
EnvironmentFile=/opt/cloud-signin-kit/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
# 只读根文件系统时，config/state 仍可写
ReadWritePaths=/opt/cloud-signin-kit

[Install]
WantedBy=multi-user.target
```

## 6. 反向代理

看板会显示账号名、余额，**不要裸奔公网**。两种做法任选：

1. 反代 + 仅内网/白名单访问；
2. 反代 + `Access-Control` 关掉 + 只用 `?key=` 访问，并给 `/panel`、`/status` 加一层 Basic Auth。

Nginx 片段：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

## 7. 凭据同步（本机 ↔ 云端）

三类动作，按需挂计划任务：

| 场景 | 命令 |
|---|---|
| 重新登录某平台（浏览器点一次） | `node scripts/magpie-auth.mjs --login qoder-cn`（或 `all`） |
| 只把现有凭据推给云端 | `node scripts/magpie-auth.mjs --push` |
| 从上游工具整批同步（多账号） | `node scripts/sync-from-magpie.cjs --push` |

Windows 计划任务示例（每周一 10:10）：

```bat
schtasks /Create /TN "cloud-signin凭据同步" /SC WEEKLY /D MON /ST 10:10 ^
  /TR "node C:\path\to\cloud-signin-kit\scripts\magpie-auth.mjs --push" /F
```

Linux cron：

```cron
10 10 * * 1 cd /opt/cloud-signin-kit && CLOUD_BASE=https://your-host node scripts/magpie-auth.mjs --push >> sync.log 2>&1
```

推送目标由 `CLOUD_BASE` 决定（默认 `http://127.0.0.1:$PORT`）。

## 8. 日常运维

```bash
# 健康
curl -s "https://your-host/health?key=$ACCESS_KEY" | jq '{checkin, alerts, refreshOwner, magpieSyncDays}'

# 手动跑一轮（不等到下个周期）
curl -s -X POST "https://your-host/tick?key=$ACCESS_KEY" | jq '.msg'

# 一行战报（可推到 IM）
curl -s "https://your-host/digest?key=$ACCESS_KEY"

# 最近日志 / 历史
curl -s "https://your-host/log?key=$ACCESS_KEY" | jq -r '.log[]' | tail -20
curl -s "https://your-host/history?key=$ACCESS_KEY&limit=20" | jq .
```

### 告警种类（`/health` 的 `alerts`）

| 值 | 含义 | 处理 |
|---|---|---|
| `token_expiring` / `trae_token_expiring` / `qoder_token_expiring` | 令牌剩 < 3 天 | 重导/同步凭据 |
| `codearts_auth` | 码道会话失效 | 看板重贴 Cookie |
| `qoder_cred` | Qoder 凭据失效 | `--login qoder-cn` |
| `checkin_pending` | 今日仍有账号未签 | 看 `/log` 找原因 |
| `stale` / `business_stale` | 服务久未运行 / 结果久未更新 | 检查进程与出网 |

### 重启注意

重启会立即补跑一轮；因为 `state.json` 记着"今天已签"，已完成的不会重复请求（幂等）。

## 9. 可选：云端事件表

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

然后把 `CLOUD_DB_ENDPOINT` / `CLOUD_DB_KEY`（/ `CLOUD_DB_RESOURCE`）配上。没配也不影响签到，仅失去"本月累计 / 最近事件"。

## 10. 备份与迁移

```bash
tar czf cloud-signin-backup-$(date +%F).tgz config.json state.json
```

迁移到新机器：还原这两个文件 → 起进程 → `curl /health` 确认令牌剩余天数与告警。
