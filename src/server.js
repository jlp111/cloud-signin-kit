// wbmon-cloud —— 云端 WorkBuddy 自动化：每日积分领取 + 猫猫旅行循环 + 令牌自我续期
// 零依赖，Node >= 18。监听 PORT（环境变量），绑定 0.0.0.0。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// 纯函数（日期/Cookie/base 校验/状态判定）集中在 lib.js，可单测；这里只管编排与 IO。
const {
  cnDateStr, parseCookieStr, cookieToStr, daysLeft, validBase, statusWorkbuddy, statusTrae,
} = require('./lib');

const PORT = Number(process.env.PORT || 8080);
// 2026-10-29 定：签到是"一天一次"的事，20 分钟一轮纯空转（实测猫猫一轮 97 个请求）。
// 主循环放慢到 1 小时；"当天没签上"的重试粒度就按 1 小时算，够用。
const TICK_MINUTES = Number(process.env.TICK_MINUTES || 60);
const REFRESH_CHECK_MINUTES = 360;       // 每 6 小时检查一次续期
// 一轮的意义只在"当天还没签上时重试"；已经签完的活儿不该再打接口。
// 实测（2026-10-29）：一轮 97 个请求，全是「猫猫」travel 流程（3 号 × ~32 次），
// 签到本身早就跳过——20 分钟一轮 ≈ 7000 请求/天，纯属烧对方的接口。
const BUDDY_MINUTES = Number(process.env.BUDDY_MINUTES || 120);        // 猫猫：2 小时跑一次（约 1200 请求/天）
const BALANCE_MINUTES = Number(process.env.BALANCE_MINUTES || 360);    // 余额：6 小时查一次
const CODEARTS_PROBE_MINUTES = Number(process.env.CODEARTS_PROBE_MINUTES || 360); // 码道保活探针：6 小时
// 保底自刷：refreshOwner=magpie 时，若 magpie 连续这么多天没同步、且 access 快到期，
// 云端破例自己刷一次（否则必然断）。设 fallbackRefresh=false 可完全禁用。
const FALLBACK_AFTER_DAYS = Number(process.env.FALLBACK_AFTER_DAYS || 7);
const REFRESH_THRESHOLD_MS = 7 * 86400000; // access 剩 7 天内就刷新
const HERE = __dirname;
const ROOT = path.join(HERE, '..');                 // 项目根目录（config.json / state.json 放这里）
const CFG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const STATE_PATH = process.env.STATE_PATH || path.join(ROOT, 'state.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const LOG_FILE = process.env.LOG_FILE || path.join(ROOT, 'run.log');   // 落盘日志（同时打 stdout）

const HOST_WB = 'https://www.workbuddy.cn';
const HOST_CB = 'https://www.codebuddy.cn';

// ---------- 配置与状态 ----------
let CFG = null;
function loadCfg() {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  // 敏感项优先取环境变量：config.json 里可以留空占位，部署时用 env 注入即可
  if (process.env.ACCESS_KEY) CFG.access_key = process.env.ACCESS_KEY;
  if (process.env.CLOUD_DB_ENDPOINT || process.env.CLOUD_DB_KEY) {
    CFG.cloud = Object.assign({}, CFG.cloud || {}, {
      endpoint: process.env.CLOUD_DB_ENDPOINT || (CFG.cloud || {}).endpoint,
      publishableKey: process.env.CLOUD_DB_KEY || (CFG.cloud || {}).publishableKey,
      resourceId: process.env.CLOUD_DB_RESOURCE || (CFG.cloud || {}).resourceId,
    });
  }
}
// 落盘一律「写临时文件 + rename」：rename 在同一文件系统上是原子的，
// 于是进程被杀/磁盘满时只会留下半截临时文件，不会把好的 config/state 截断成非法 JSON。
// 临时名带 pid+时间戳而不是固定 '.tmp'：互斥（TICK_RUNNING / ROUND_RUNNING）之外
// 仍有 fire-and-forget 的写入者（如 dbEventOnce(...).then() 里的 saveState），
// 固定名会让两个写入者共用一个临时文件，rename 时互相踩空。
function writeFileAtomic(p, data) {
  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  } catch (e) {
    // rename 没成功就别把半截临时文件留在目录里（写失败/rename 失败都要清）
    try { fs.unlinkSync(tmp); } catch { /* 文件可能根本没建出来 */ }
    throw e;
  }
}
function saveCfg() {
  try { writeFileAtomic(CFG_PATH, JSON.stringify(CFG, null, 1)); }
  catch (e) { log('config保存失败(令牌可能无法持久化): ' + e.message); }
}
// 只有「文件不存在」才算空状态。解析失败说明文件坏了（多半是被 kill 在写盘中间），
// 必须留证据：备份成 .corrupt-<ts> 再返回空，否则会静默归零（当天已签标记全丢、重复打接口）。
function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return {};      // 首次启动，正常
    log('state 读取失败: ' + (e && e.message || e));
    return {};
  }
  try { return JSON.parse(raw); }
  catch (e) {
    const bak = STATE_PATH + '.corrupt-' + Date.now();
    try { fs.renameSync(STATE_PATH, bak); }
    catch (e2) { log('state.json 解析失败，且备份失败: ' + ((e2 && e2.message) || e2)); return {}; }
    log('state.json 解析失败（' + (e && e.message || e) + '），已备份为 ' + bak + ' 并重置为空；本轮会重新确认各平台是否已签');
    return {};
  }
}
function saveState(st) { try { writeFileAtomic(STATE_PATH, JSON.stringify(st, null, 1)); } catch (e) { log('state保存失败: ' + e.message); } }

// 进程内唯一状态对象：所有 tick / HTTP 端点读写同一份，避免「各自 loadState() 拿快照、
// 后写者整体覆盖前者」的丢更新（典型：看板粘 Cookie 补签成功后，被正在跑的 tick 回滚）。
let ST = null;
function state() {
  if (!ST) ST = loadState();
  return ST;
}

// ---------- 日志 ----------
const LOG_RING = [];
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  LOG_RING.push(line);
  if (LOG_RING.length > 600) LOG_RING.splice(0, 200);
  try {
    const p = LOG_FILE;
    // 轮转：超过 1MB 滚成 run.log.1，防止无限增长把磁盘/体积拖爆
    try { if (fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, p + '.1'); } catch { /* 文件还不存在 */ }
    fs.appendFileSync(p, line + '\n');
  } catch {}
  console.log(line);
}

// ---------- HTTP 客户端 ----------
async function reqJson(host, urlPath, token, method, body, timeoutMs, extraHeaders) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-codebuddy-request': '1',
      'x-client-platform': 'web',
      'origin': host, 'referer': host + '/',
      'user-agent': 'Mozilla/5.0',
    };
    if (token) headers.authorization = 'Bearer ' + token;
    Object.assign(headers, extraHeaders || {});
    const opt = { method: method || 'GET', headers, signal: ctrl.signal };
    if (body !== undefined) opt.body = JSON.stringify(body || {});
    const r = await fetch(host + urlPath, opt);
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, json: j, raw: text };
  } catch (e) {
    return { status: -1, json: null, raw: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// ---------- 云数据库（BaaS）接入：运行历史落库（可选） ----------
// 从 config.json 的 cloud 字段（或环境变量）读取，缺失则自动跳过（不影响主流程）。
// publicConfig 两项（endpoint / publishableKey）均为可公开值；密钥与令牌永不落库。
// 故障隔离：落库失败只记日志，绝不阻断签到/旅行主流程。
let CLOUD_DB = null, CLOUD_ERR = '', CLOUD_OK = false;
function initCloudDb() {
  try {
    const c = (CFG && CFG.cloud) || {};
    const endpoint = c.endpoint || process.env.CLOUD_ENDPOINT || '';
    const publishableKey = c.publishableKey || process.env.CLOUD_PUBLISHABLE_KEY || '';
    if (!endpoint || !publishableKey) { CLOUD_ERR = 'config.cloud 缺 endpoint / publishableKey'; return; }
    const sdk = require('@tencent-ai/workbuddy-cloud-sdk');
    // Node 环境没有 localStorage：用 SDK 自带的内存存储兜底，避免初始化时崩
    const opts = { endpoint, publishableKey };
    if (typeof sdk.createMemoryStorage === 'function') opts.storage = sdk.createMemoryStorage();
    CLOUD_DB = sdk.createWorkBuddyCloud(opts);
  } catch (e) { CLOUD_DB = null; CLOUD_ERR = String((e && e.message) || e).slice(0, 140); }
}

// 把云库错误翻译成人话：42P01=没建表、42501=缺 GRANT 或 RLS 拒、23505=重复键、HTTP 401=平台凭据问题
function dbErrText(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e || '').slice(0, 120);
  const hint = code === '42P01' ? ' → 表不存在，需先建表'
    : code === '42501' ? ' → 缺 GRANT 或 RLS 拒绝'
      : code === '23505' ? ' → 唯一键冲突'
        : /401|MISSING_CREDENTIALS|ACCESS_TOKEN_KID_INVALID/i.test(msg) ? ' → 平台凭据问题，非应用代码可修' : '';
  return msg + (code ? '（' + code + '）' : '') + hint;
}

async function dbEvent(account, kind, detail, extra) {
  if (!CLOUD_DB) return;
  try {
    const r = await CLOUD_DB.database.from('wbmon_events')
      .insert({ account, kind, detail, extra: extra || null }).select();
    if (r.error) log('云数据库写入失败: ' + dbErrText(r.error));
    else CLOUD_OK = true;
  } catch (e) {
    log('云数据库异常: ' + String((e && e.message) || e).slice(0, 140));
  }
}

// 同账号 + 同类型 + 同一天只写一条。
// 不能只靠 state.json 里的 dbDay 标记：重新部署 / 多实例并存都会重置它，
// 于是同一轮被反复补记（曾把"本月累计"刷到 48 条）。这里以库本身为准做幂等。
async function dbEventOnce(account, kind, detail, extra) {
  if (!CLOUD_DB) return false;
  try {
    const bjMidnight = new Date(cnDateStr() + 'T00:00:00+08:00').toISOString();
    const q = await CLOUD_DB.database.from('wbmon_events')
      .select('id', { count: 'exact', head: true })
      .eq('account', account).eq('kind', kind).gte('created_at', bjMidnight);
    if (q.error) { log('云数据库查重失败（仍写入）: ' + dbErrText(q.error)); }
    else if ((q.count || 0) > 0) return false;   // 今天已记过，跳过
  } catch (e) {
    log('云数据库查重异常（仍写入）: ' + String((e && e.message) || e).slice(0, 120));
  }
  await dbEvent(account, kind, detail, extra);
  return true;
}

// 启动自检：写一条 selftest 再读回，确认这条链路真的通（不是"初始化没报错"就算通）
async function dbSelfTest() {
  if (!CLOUD_DB) return false;
  try {
    const tag = 'selftest-' + Date.now();
    const w = await CLOUD_DB.database.from('wbmon_events')
      .insert({ account: '__self__', kind: 'selftest', detail: tag }).select();
    if (w.error) { log('云数据库自检-写入失败: ' + dbErrText(w.error)); return false; }
    const r = await CLOUD_DB.database.from('wbmon_events')
      .select('id, detail').eq('kind', 'selftest').eq('detail', tag).limit(1);
    if (r.error) { log('云数据库自检-读回失败: ' + dbErrText(r.error)); return false; }
    const ok = (r.data || []).length > 0;
    log('云数据库自检：' + (ok ? '写入并读回成功 ✓' : '读回为空 ✗'));
    return ok;
  } catch (e) {
    log('云数据库自检异常: ' + String((e && e.message) || e).slice(0, 140));
    return false;
  }
}

// ---------- 令牌自我续期 ----------
async function refreshAccountToken(a) {
  if (!a.refreshToken) return false;
  const r = await reqJson(HOST_WB, '/v2/plugin/auth/token/refresh', a.accessToken, 'POST', {}, 20000, {
    'X-Refresh-Token': a.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',  // [deploy] 缺失时网关判定为异常来源，可能 12153（对齐 workbuddy-switch）
  });
  const j = r.json || {};
  const d = j.data || {};
  const at = d.accessToken || d.access_token;
  if (r.status !== 200 || (j.code !== 0 && j.code !== 200) || !at) {
    log(`⛔ ${a.name} 令牌刷新失败 HTTP=${r.status} code=${j.code} ${String(j.msg || j.message || '').slice(0, 80)}`);
    return false;
  }
  a.accessToken = at;
  const rt = d.refreshToken || d.refresh_token;
  if (rt) a.refreshToken = rt;
  a.expiresAt = d.expiresAt ?? d.expires_at ?? (Date.now() + (d.expiresIn ?? d.expires_in ?? 2592000) * 1000);
  a.refreshExpiresAt = d.refreshExpiresAt ?? d.refresh_expires_at ?? (Date.now() + (d.refreshExpiresIn ?? d.refresh_expires_in ?? 5184000) * 1000);
  saveCfg(); // 轮换出的新 refresh 令牌必须立刻持久化
  log(`🔁 ${a.name} 令牌已续期：access剩${daysLeft(a.expiresAt)}天 refresh剩${daysLeft(a.refreshExpiresAt)}天`);
  return true;
}

async function ensureTokens() {
  // 续期主管是谁，只能有一个。默认 'magpie'：本机 magpie 才是刷新链的主人，云端只借它的 access。
  // 两边都刷会互相作废对方的 refresh（WorkBuddy 实测过链主竞争：客户端一刷，云端旧链就作废，反之亦然）。
  const owner = CFG.refreshOwner || 'magpie';
  if (owner === 'magpie') {
    // 保底：magpie 连续 FALLBACK_AFTER_DAYS 天没同步过（多半是电脑一直没开），
    // 而 access 又快到期 —— 这时候"不刷"必然失效，刷一下还可能救回来。
    // 代价：本机 magpie 手里那条链会作废，下次用它可能要重新登录一次；只在快断时触发。
    const syncAt = CFG.magpieSyncAt ? new Date(CFG.magpieSyncAt).getTime() : 0;
    const daysSince = syncAt ? (Date.now() - syncAt) / 86400000 : 999;
    for (const a of CFG.accounts) {
      const left = (a.expiresAt || 0) - Date.now();
      if (left >= REFRESH_THRESHOLD_MS) continue;
      if (CFG.fallbackRefresh === false) { log('提醒：' + a.name + ' access 剩 ' + daysLeft(a.expiresAt) + ' 天，保底自刷已关闭（fallbackRefresh=false）'); continue; }
      if (daysSince < FALLBACK_AFTER_DAYS) continue;
      log('⚠️ 保底自刷 ' + a.name + '：access 剩 ' + daysLeft(a.expiresAt) + ' 天，且 magpie 已 ' + daysSince.toFixed(1) + ' 天未同步');
      try { await refreshAccountToken(a); } catch (e) { log(a.name + ' 保底自刷异常: ' + e.message); }
    }
    return;
  }
  for (const a of CFG.accounts) {
    const left = (a.expiresAt || 0) - Date.now();
    if (left < REFRESH_THRESHOLD_MS) {
      try { await refreshAccountToken(a); } catch (e) { log(a.name + ' 续期异常: ' + e.message); }
    }
  }
}

// ---------- 日期（东八区） ----------
// 实现见 src/lib.js 的 cnDateStr(ts)：可注入时间戳，便于单测跨零点边界。

// ---------- 平台注册表（签到汇总的唯一事实来源） ----------
// 看板的「今日签到」、/health 的 checkin 字段、/digest 的战报，全部由这里汇总，
// 不再各自去数 CFG.accounts —— 否则每加一个平台就要改三处、必然漏。
//
// 新增账号：往 config.json 里对应平台的 *_/accounts 数组加一条即可，本文件不用改。
// 新增平台：在下面数组里加一个对象，实现 accounts() 与 status() 两个方法即可，
//           4 个展示位（入口页 / 看板 / health / 战报）会自动把它算进去。
//           参考文件末尾注释里的 Qoder 示例骨架。
const PLATFORMS = [
  {
    key: 'workbuddy',
    label: 'WorkBuddy',
    accounts: () => (CFG && CFG.accounts) || [],
    // 判定逻辑在 src/lib.js（纯函数，已单测）：今天领成功＝ok；「活动未开启」保持 pending。
    status: statusWorkbuddy,
  },
  {
    key: 'trae',
    label: 'Trae',
    accounts: () => (CFG && CFG.trae && CFG.trae.accounts) || [],
    // 判定逻辑在 src/lib.js（纯函数，已单测）：今天还没跑过＝pending（不是 fail）。
    status: statusTrae,
  },
  {
    key: 'codearts',
    label: '码道',
    accounts: () => (CFG && CFG.codearts && CFG.codearts.accounts) || [],
    status(st, a, today) {
      const r = ((st.codearts || {})[a.name]) || {};
      const done = r.day === today && r.outcome === 'claimed';
      return {
        done,
        credit: done ? Number(r.credit) || 0 : 0,
        streak: Number(r.streak) || 0,
        // needauth＝华为侧会话 Cookie 失效（HttpOnly，只能由人工重新导出）。
        // 归入「受限」而非「失败」：服务端没有任何自愈手段，报 ✗ 只会天天误报。
        state: done ? 'ok'
          : r.outcome === 'needauth' ? 'needauth'
          : r.outcome === 'nocookie' ? 'needauth'
          : (r.day === today ? 'fail' : 'pending'),
        note: r.note || '',
      };
    },
  },
  {
    key: 'qoder',
    label: 'Qoder',
    accounts: () => (CFG && CFG.qoder && CFG.qoder.accounts) || [],
    status(st, a, today) {
      const r = ((st.qoder || {})[a.name]) || {};
      const done = r.day === today && r.outcome === 'claimed';
      return {
        done,
        credit: done ? Number(r.credit) || 0 : 0,
        streak: 0,
        // nocred＝没配 token/指纹；token_expired＝dt- token 过期（约 30 天）
        // 二者都是"必须人工重导"，归入受限不误报。
        state: done ? 'ok'
          : (r.outcome === 'nocred' || r.outcome === 'token_expired') ? 'needauth'
          : (r.day === today ? 'fail' : 'pending'),
        note: r.note || '',
      };
    },
  },
];

// 逐账号状态（含平台信息），跨平台平铺
function eachAccountStatus(st, today) {
  const day = today || cnDateStr();
  const out = [];
  for (const p of PLATFORMS) {
    let list = [];
    try { list = p.accounts() || []; } catch (e) { list = []; }
    for (const a of list) {
      let s = {};
      try { s = p.status(st, a, day) || {}; } catch (e) { s = { done: false, state: 'fail', note: '状态读取异常' }; }
      out.push(Object.assign({ platform: p.key, platformLabel: p.label, name: a.name, cfg: a }, s));
    }
  }
  return out;
}

// 全平台汇总：{ done, total, pending, by: {key:{label,done,total}} , rows }
function checkinSummary(st) {
  const today = cnDateStr();
  const rows = eachAccountStatus(st, today);
  const by = {};
  for (const p of PLATFORMS) by[p.key] = { label: p.label, done: 0, total: 0 };
  for (const r of rows) {
    const b = by[r.platform];
    if (!b) continue;
    b.total++;
    if (r.done) b.done++;
  }
  const total = rows.length;
  const done = rows.filter(r => r.done).length;
  return { today, done, total, pending: total - done, by, rows };
}

// 供展示用的一行分平台摘要，如 "WorkBuddy 3/3 · Trae 2/2"
function platformBrief(sum) {
  return PLATFORMS
    .map(p => sum.by[p.key])
    .filter(b => b && b.total > 0)
    .map(b => b.label + ' ' + b.done + '/' + b.total)
    .join(' · ');
}

// ---------- 每日积分领取（签到） ----------
async function doCheckin(acct, st) {
  const a = st.accounts[acct.name] || (st.accounts[acct.name] = { checkin: {} });
  const c = a.checkin || (a.checkin = {});
  const today = cnDateStr();
  if (c.day === today && c.done) {
    // 今天已领（多为重启后重跑）：同样保证云库当天有一条记录，只补一次
    if (c.dbDay !== today) { dbEventOnce(acct.name, 'checkin', '今日已领（' + (c.note || '已领') + '）', { credit: c.credit, streak: c.streak }).then(ok => { if (ok) c.dbDay = today; }); }
    return '已领(跳过)';
  }
  const s1 = await reqJson(HOST_CB, '/v2/billing/meter/checkin-activity-status', acct.accessToken, 'POST', {});
  const d1 = (s1.json && s1.json.data) || {};
  if (s1.status !== 200 || !s1.json || s1.json.code !== 0) {
    c.day = today; c.done = false; c.note = '查询失败';
    return '查询失败';
  }
  if (!d1.active) {
    // 活动未开启 ≠ 已领：done 置真会让当天彻底不再重试（活动一开就漏签这一天），
    // 也会误刷 st.lastOkAt、把 business_stale 告警掩盖掉。保持 pending，每一轮继续试。
    c.day = today; c.done = false; c.inactive = true; c.note = '活动未开启';
    return '活动未开启';
  }
  c.inactive = false;   // 活动在线，走真实领取路径
  // 每天只往云库补记一次（无论本轮是真领取还是幂等跳过），避免每轮刷出一堆重复事件
  if (d1.today_checked_in === true) {
    c.day = today; c.done = true; c.note = '先前已领';
    c.streak = d1.streak_days; c.credit = d1.today_credit;
    if (c.dbDay !== today) { dbEventOnce(acct.name, 'checkin', '今日已领（先前已领）', { credit: d1.today_credit, streak: d1.streak_days }).then(ok => { if (ok) c.dbDay = today; }); }
    return '先前已领';
  }
  const s2 = await reqJson(HOST_CB, '/v2/billing/meter/daily-checkin', acct.accessToken, 'POST', {});
  const code2 = s2.json && s2.json.code;
  if (code2 === 10001) {
    c.day = today; c.done = true; c.note = '已领(10001)';
    c.streak = d1.streak_days; c.credit = d1.today_credit;
    if (c.dbDay !== today) { dbEventOnce(acct.name, 'checkin', '今日已领（10001）', { credit: d1.today_credit, streak: d1.streak_days }).then(ok => { if (ok) c.dbDay = today; }); }
    return '已领(10001)';
  }
  if (s2.status === 200 && code2 === 0) {
    c.day = today; c.done = true; c.note = '云端领取成功';
    c.streak = d1.streak_days; c.credit = d1.today_credit;
    log(acct.name + ' ✅ 每日积分云端领取成功');
    if (c.dbDay !== today) { dbEventOnce(acct.name, 'checkin', '每日积分领取成功', { credit: d1.today_credit, streak: d1.streak_days }).then(ok => { if (ok) c.dbDay = today; }); }
    return '领取成功';
  }
  log(acct.name + ' 签到失败 HTTP=' + s2.status + ' code=' + code2);
  return '失败';
}

// ---------- 猫猫旅行 ----------
async function getBuddyList(acct) {
  const r = await reqJson(HOST_WB, '/activity/growth/buddy/list', acct.accessToken, 'GET');
  return (r.json && r.json.code === 0 && r.json.data && r.json.data.buddies) || [];
}

async function doBuddyTravel(acct, st) {
  const a = st.accounts[acct.name] || (st.accounts[acct.name] = {});
  const b = a.buddy || (a.buddy = {});
  const acts = [];

  // 0) 未领养 → 尝试领取第一只（每天最多试一次）
  let buddies = await getBuddyList(acct);
  if (!buddies.length) {
    const today = cnDateStr();
    if (b.adoptTriedDay !== today) {
      b.adoptTriedDay = today;
      const r = await reqJson(HOST_WB, '/activity/growth/buddy/first', acct.accessToken, 'POST', {});
      const j = r.json || {};
      if (r.status === 200 && j.code === 0) {
        log(acct.name + ' 🎉 已自动领取第一只 Buddy');
        acts.push('自动领养成功');
        dbEvent(acct.name, 'buddy_adopt', '自动领取第一只 Buddy', {});
        buddies = await getBuddyList(acct);
      } else {
        b.note = '领养需官网同意协议';
        acts.push('未领养(需官网协议)');
      }
    } else {
      acts.push('未领养，跳过');
    }
    b.owned = buddies.length;
    if (!buddies.length) return acts;
  }
  b.owned = buddies.length;

  // 1) 记住当前猫，结束时恢复
  const rInfo = await reqJson(HOST_WB, '/activity/growth/buddy/info', acct.accessToken, 'GET');
  const origBuddy = rInfo.json && rInfo.json.data && rInfo.json.data.buddy;
  const origId = origBuddy && (origBuddy.instance_id || origBuddy.id);

  let limitReached = false;
  try {
  for (const bd of buddies) {
    const nm = bd.name || bd.title || ('#' + bd.instance_id);
    const sw = await reqJson(HOST_WB, '/activity/growth/buddy/switch', acct.accessToken, 'POST', { instance_id: Number(bd.instance_id) });
    if (!(sw.json && sw.json.code === 0)) { acts.push(nm + ':切换失败'); continue; }
    let sSt = await reqJson(HOST_WB, '/activity/growth/buddy/travel/status', acct.accessToken, 'GET');
    let stj = (sSt.json && sSt.json.data) || {};
    if (stj.state === 'arrived') {
      const cl = await reqJson(HOST_WB, '/activity/growth/buddy/travel/claim', acct.accessToken, 'POST', {});
      if (cl.json && cl.json.code === 0) {
        const reward = cl.json.data || {};
        const cr = reward.credit_granted ?? reward.credits ?? '';
        log(acct.name + ' ✅ ' + nm + ' 旅行礼物已领取' + (cr ? ' +' + cr + '积分' : ''));
        acts.push(nm + ':领取成功' + (cr ? '(+' + cr + ')' : ''));
        dbEvent(acct.name, 'travel_claim', nm + ' 旅行礼物已领取' + (cr ? ' +' + cr + '积分' : ''), reward);
      } else {
        acts.push(nm + ':领取失败');
      }
      sSt = await reqJson(HOST_WB, '/activity/growth/buddy/travel/status', acct.accessToken, 'GET');
      stj = (sSt.json && sSt.json.data) || {};
    } else if (stj.state === 'traveling') {
      // 旅行中：等到达，不是错误
      acts.push(nm + ':旅行中');
    } else if (stj.state !== 'idle') {
      acts.push(nm + ':' + stj.state);
    }
    if (stj.daily_limit_reached) { limitReached = true; continue; }
    if (stj.state === 'idle') {
      const cfg = await reqJson(HOST_WB, '/v2/activity/growth/buddy/travel/config', acct.accessToken, 'GET');
      const locs = (cfg.json && cfg.json.data && cfg.json.data.locations) || [];
      if (!locs.length) { acts.push(nm + ':无可用地点'); continue; }
      const dp = await reqJson(HOST_WB, '/v2/activity/growth/buddy/travel/depart', acct.accessToken, 'POST', { location_id: locs[0].id });
      if (dp.json && dp.json.code === 0) {
        log(acct.name + ' ✈️ ' + nm + ' 已派出 → ' + (locs[0].name || locs[0].id));
        acts.push(nm + ':已派出');
        dbEvent(acct.name, 'travel_depart', nm + ' 已派出 → ' + (locs[0].name || locs[0].id), { buddy: nm, location: locs[0].name || locs[0].id });
      } else {
        acts.push(nm + ':派出失败');
      }
    }
  }
  } catch (e) {
    acts.push('异常:' + String((e && e.message) || e).slice(0, 30));
  } finally {
    // 2) 恢复原当前猫 —— 必须放 finally：中途抛异常也要把账号的当前猫还原，
    //    否则他的账号会被永久停在我们最后切到的那只猫上（体验问题，且下次会误判）。
    if (origId) {
      try {
        const rb = await reqJson(HOST_WB, '/activity/growth/buddy/switch', acct.accessToken, 'POST', { instance_id: Number(origId) });
        if (rb.json && rb.json.code === 0) acts.push('已恢复原猫');
        else acts.push('恢复原猫失败');
      } catch (e2) { acts.push('恢复原猫异常'); }
    }
  }
  b.limitReached = limitReached;
  b.day = cnDateStr();
  return acts;
}

// ---------- 一轮完整工作 ----------
let TICK_RUNNING = false;   // 防重入：上一轮没结束就跳过，避免并发把 state 写乱
// 由 HTTP 端点触发的「单平台补跑」（粘 Cookie / 换 token 后立刻签一次）。
// 它和 tick 一样会写 state 与 CFG，所以必须与 tick 互斥——否则两边各自跑一轮，
// 后结束的那轮会把先结束那轮刚写入的「今天已签」整体覆盖掉（丢更新）。
let ROUND_RUNNING = false;

// 拿不到锁就返回 false（调用方据此如实告知"稍后自动补签"，而不是假装跑过了）。
async function runRoundExclusive(fn, label) {
  if (TICK_RUNNING || ROUND_RUNNING) return false;
  ROUND_RUNNING = true;
  try { await fn(); }
  catch (e) { log(label + '异常: ' + ((e && e.message) || e)); }
  finally { ROUND_RUNNING = false; }
  return true;
}

async function tick() {
  if (TICK_RUNNING || ROUND_RUNNING) { log('上一轮尚未结束，跳过本轮'); return; }
  TICK_RUNNING = true;
  const st = state();
  try {
    st.lastTickAt = new Date().toISOString();
    st.tickCount = (st.tickCount || 0) + 1;
    if (!st.accounts) st.accounts = {};
    try { await ensureTokens(); } catch (e) { log('续期检查异常: ' + e.message); }
    // 猫猫（buddy travel）是这套里最费接口的一环：一只猫要查列表/信息/行程状态/可能领奖。
    // 行程本身有小时级冷却，20 分钟一轮纯属空转，按 BUDDY_MINUTES 节流。
    const buddyDue = !st.buddyAt || (Date.now() - new Date(st.buddyAt).getTime() >= BUDDY_MINUTES * 60000);
    for (const acct of CFG.accounts) {
      try {
        const r1 = await doCheckin(acct, st);
        // 业务成功的客观锚点（/health 的 lastOkAt 用它判断"真的干成活了没"）
        const cc = ((st.accounts[acct.name] || {}).checkin) || {};
        if (cc.day === cnDateStr() && cc.done) st.lastOkAt = new Date().toISOString();
        if (buddyDue) {
          const r2 = await doBuddyTravel(acct, st);
          log(acct.name + ' 一轮完成：签到=' + r1 + '；猫猫=' + (r2.join(' | ') || '无动作'));
        } else {
          log(acct.name + ' 一轮完成：签到=' + r1 + '；猫猫=跳过（' + BUDDY_MINUTES + ' 分钟节流）');
        }
      } catch (e) {
        log(acct.name + ' 本轮异常：' + (e && e.message || e));
      }
    }
    if (buddyDue) st.buddyAt = new Date().toISOString();
    try { await traeRound(st); } catch (e) { log('Trae 轮异常: ' + (e && e.message || e)); }
    try { await codeartsRound(st); } catch (e) { log('码道 轮异常: ' + (e && e.message || e)); }
    try { await qoderRound(st); } catch (e) { log('Qoder 轮异常: ' + (e && e.message || e)); }
    try { await refreshBalances(st); } catch (e) { log('余额刷新异常: ' + (e && e.message || e)); }
  } finally {
    // 无论中途抛什么，状态都要落盘：否则 tickCount 与"今天已签到"标记会丢，可能重复签到
    st.tokenInfo = CFG.accounts.map(a => ({ name: a.name, daysLeft: daysLeft(a.expiresAt), refreshDaysLeft: daysLeft(a.refreshExpiresAt) }));
    saveState(st);
    TICK_RUNNING = false;
  }
}

// ---------- Trae CN 每日签到（凭据由本机 magpie 同步，云端不自行刷新） ----------
// 说明：Trae 的 OAuth token 若由云端刷新会与设备解绑，claim 会稳定返回
// 9074「当前参与用户太多」（实为伪/未绑定设备被拒）。故云端只读已绑定设备的
// token 去签到，续期交给本机 magpie（plugin-auth.json），定期同步即可。
const TRAE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TRAE-SOLO-CN/0.1.69 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36';
const TRAE_BRAND = 'ASUS TUF Gaming A15 FA507RM_FA507RM';
const TRAE_BASE = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/';

async function traePost(a, act, deviceId) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    // 每个账号可以自带一份"设备指纹"（桌面 / 手机各不相同），缺省用桌面端那套
    const p = a.profile || {};
    const r = await fetch(TRAE_BASE + act, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Cloud-IDE-JWT ' + a.access,
        'User-Agent': p.ua || TRAE_UA,
        'x-device-id': String(deviceId || a.deviceId),
        'x-device-brand': p.brand || TRAE_BRAND,
        'x-device-type': p.type || 'Windows',
        'x-os-version': p.os || '10.0.22631',
        'x-app-version': p.appVersion || '0.1.69',
      },
      body: JSON.stringify({ req_source: 1 }),
      signal: ctl.signal,
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j || {}, raw: t.slice(0, 160) };
  } finally { clearTimeout(tm); }
}

async function traeRound(st) {
  const list = (CFG.trae && CFG.trae.accounts) || [];
  if (!list.length) return;
  const today = cnDateStr();
  st.trae = st.trae || {};
  for (const a of list) {
    const rec = st.trae[a.name] || (st.trae[a.name] = {});
    // 今日已领成功则跳过（幂等，避免无意义请求）；跳过前保证当天云库有记录
    if (rec.day === today && rec.outcome === 'claimed') {
      if (rec.dbDay !== today) {
        dbEventOnce('Trae:' + a.name, 'trae_checkin', '今日已领（幂等跳过）+' + ((Number(rec.credit) || 0) + (Number(rec.extra) || 0)), { credit: rec.credit, extra: rec.extra }).then(ok => { if (ok) { rec.dbDay = today; saveState(st); } });
      }
      continue;
    }
    try {
      const s1 = await traePost(a, 'status');
      const j1 = s1.json || {};
      rec.day = today; rec.at = new Date().toISOString();
      if (j1.code === 0 && j1.checked_in) {
        rec.outcome = 'claimed';
        rec.credit = Number(j1.credits) || 0;
        rec.extra = Number(j1.extra_credits) || 0;
        rec.note = '今日已领（幂等跳过）';
        log('Trae ' + a.name + ' 今日已领 +' + ((Number(rec.credit)||0)+(Number(rec.extra)||0)));
        // 与 WorkBuddy 一致：当天只补记一次，保证历史里每天都有 Trae 的记录
        if (rec.dbDay !== today) {
          dbEventOnce('Trae:' + a.name, 'trae_checkin', '今日已领（幂等跳过）+' + ((Number(rec.credit) || 0) + (Number(rec.extra) || 0)), { credit: rec.credit, extra: rec.extra }).then(ok => { if (ok) rec.dbDay = today; });
        }
        saveState(st);
        continue;
      }
      // 依次尝试该账号的可用设备：主设备 → 备用设备。
      // 9074＝伪/未绑定设备被拒；9095＝该设备今日名额已被别的账号占用。
      // 实测结论（2026-10-29）：9074＝账号当前无可信设备（未在客户端登录，换任何
      // 设备 id 都被拒）；9095＝设备今日名额已被别的账号先用掉。二者都不是故障，
      // 只做状态区分，避免每天误报。
      const devs = [a.deviceId].concat(a.altDeviceIds || []).filter(Boolean);
      let ok = false, busy = false, noDev = false, lastMsg = '', got = null;
      for (const d of devs) {
        const s2 = await traePost(a, 'claim', d);
        const j2 = s2.json || {};
        if (j2.code === 0) { ok = true; got = j2; rec.device = String(d); break; }
        lastMsg = String(j2.message || ('code ' + j2.code)).slice(0, 60);
        if (Number(j2.code) === 9095) busy = true;
        else if (Number(j2.code) === 9074) noDev = true;
      }
      if (ok) {
        rec.outcome = 'claimed';
        rec.credit = Number(got.credits) || Number(j1.credits) || 0;
        rec.extra = Number(got.extra_credits) || Number(j1.extra_credits) || 0;
        rec.note = '';
        log('Trae ' + a.name + ' 签到成功 +' + ((Number(rec.credit)||0)+(Number(rec.extra)||0)));
        dbEventOnce('Trae:' + a.name, 'trae_checkin', 'Trae 签到成功 +' + ((Number(rec.credit)||0)+(Number(rec.extra)||0)),
          { credit: rec.credit, extra: rec.extra, device: rec.device || null, platform: (a.profile && a.profile.type) || 'Windows' });
      } else {
        rec.outcome = busy ? 'device_busy' : (noDev ? 'no_device' : 'failed');
        rec.note = lastMsg;
        log('Trae ' + a.name + (busy ? ' 设备名额已占：' : noDev ? ' 无可信设备（未在客户端登录）：' : ' 签到失败：') + rec.note);
        dbEvent('Trae:' + a.name, 'trae_fail', (rec.outcome === 'device_busy' ? '设备名额已占：' : rec.outcome === 'no_device' ? '无可信设备：' : '签到失败：') + rec.note,
          { outcome: rec.outcome });
      }
    } catch (e) {
      rec.day = today; rec.outcome = 'error';
      rec.note = String((e && e.message) || e).slice(0, 60);
      log('Trae ' + a.name + ' 异常：' + rec.note);
    }
    saveState(st);
  }
}

// ---------- 华为码道（CodeArts / DevCloud）每日签到 ----------
// 接口（码道 chat PromptCenterService，实测 2026-10）：
//   查活动  GET  /v1/ops/delivery?channel=WEB      → data.items[] 里 campaignId + status
//   领取    POST /v1/ops/claim   {campaignId, idempotentKey:"claim_<cid>_<ts>", channel:"WEB"}
//   确认    POST /v1/ops/confirm {campaignId}
// 鉴权：Cookie（devclouddevuibjJ_SESSION_ID 等，**HttpOnly**）+ 由 cookie
//       devclouddevuibjtcftk 派生出的请求头 cftk（华为的 CSRF 令牌）。
// 两个硬约束（决定了这套代码的形状）：
//   1) campaignId 随活动轮次变（曾 1 → 34），必须用 delivery 实时返回的值，写死必报
//      「运营事件未生效或已结束」。
//   2) 会话 Cookie 是 HttpOnly → 云端无法自行登录，只能人工导出。
//      实测（2026-10-29）：
//        · 接口调用与 GET /chat/home 都**不会**换发新的 devclouddevuibjJ_SESSION_ID
//          （只回 BENSESSCC_TAG 之类），即「绝对有效期」而非滑动续期；
//        · 云端每 20 分钟轮询也没能把它续住：10:55 还可用，13:10 同一份 cookie
//          就已经凉了 —— 大约 1~2 小时死透；
//        · **失效的表象是 HTTP 200 + 空 body（不是 401）**，所以判定必须按
//          「200 但解析不出 JSON」也算 needauth，否则会误判成网络故障。
//      结论：别指望自愈。日常节奏＝看板看到 🔑 时粘一份新 cookie，服务端当场实测并
//      立刻补签（见 /codearts-cookie）。每轮仍合并 Set-Cookie：万一华为哪天改成换发，
//      这条链路白捡；同时用「最近一次 delivery code=0」＝ sessionOkAt 作存活硬证据。
const HW_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/chat/PromptCenterService';
const HW_HOME = 'https://devcloud.cn-north-4.huaweicloud.com/chat/home';
const HW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
const HW_COOKIE_KEY = 'devclouddevuibjJ_SESSION_ID';

// parseCookieStr / cookieToStr 见 src/lib.js（纯函数，已单测）

// 把响应里的 Set-Cookie 合并回账号凭据。华为网关每次访问都可能续期会话，
// 丢掉这条链路，Cookie 就会在 30~60 分钟后静置过期 —— 这是云端能自持的关键。
// 返回是否发生改动；只有「会话票据本身」更新才算一次续期（cookieAt），
// 网关顺带塞的埋点 cookie 更新时不改 cookieAt，否则健康度会显得虚高。
function hwMergeSetCookie(a, list) {
  if (!list || !list.length) return false;
  const m = parseCookieStr(a.cookie);
  let changed = false, renewed = false;
  for (const sc of list) {
    const first = String(sc).split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim(), v = first.slice(i + 1).trim();
    if (!k) continue;
    const dead = /;\s*max-age=0\b/i.test(sc) || /expires=thu,\s*01\s*jan\s*1970/i.test(sc);
    if (dead) { if (k in m) { delete m[k]; changed = true; } continue; }
    if (v && m[k] !== v) {
      m[k] = v; changed = true;
      if (k === HW_COOKIE_KEY) renewed = true;
    }
  }
  if (changed) {
    a.cookie = cookieToStr(m);
    a.cookieTouchedAt = new Date().toISOString();
    if (renewed) a.cookieAt = a.cookieTouchedAt;   // 会话真正续期的时间
  }
  return changed;
}

async function hwApi(a, urlPath, method, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    const m = parseCookieStr(a.cookie);
    const headers = {
      'user-agent': HW_UA,
      // 华为网关靠这几个头判断"这是接口调用"；缺了会返回 SPA 的 HTML 而非 JSON
      'agent-type': 'PromptCenter',
      'x-language': 'zh-cn',
      'language': 'zh-cn',
      'x-requested-with': 'XMLHttpRequest',
      'accept': 'application/json, text/plain, */*',
      'referer': HW_HOME,
      'cookie': a.cookie || '',
    };
    if (m.devclouddevuibjtcftk) headers['cftk'] = m.devclouddevuibjtcftk;
    let url = HW_BASE + urlPath;
    const opt = { method: method || 'GET', headers, signal: ctrl.signal };
    if (body !== undefined) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    // GET 带浏览器同款缓存戳，否则可能命中网关缓存拿到旧状态
    if ((method || 'GET') === 'GET') url += (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    const r = await fetch(url, opt);
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    let sc = [];
    try {
      sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie()
        : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
    } catch { sc = []; }
    return { status: r.status, json: j, raw: text.slice(0, 200), setCookies: sc };
  } catch (e) {
    return { status: -1, json: null, raw: String((e && e.message) || e), setCookies: [] };
  } finally { clearTimeout(t); }
}

function hwFindDaily(items) {
  if (!Array.isArray(items)) return null;
  for (const x of items) {
    if (!x || typeof x !== 'object') continue;
    if (x.campaignId === 1 || x.type === 'USER_LOGIN' || x.type === 'DAILY_CLAIM') return x;
  }
  return null;
}

const HW_DONE_STATUS = ['CLAIMED', 'CONFIRMED', 'CONSUMED'];

async function codeartsRound(st) {
  const list = (CFG.codearts && CFG.codearts.accounts) || [];
  if (!list.length) return;
  const today = cnDateStr();
  st.codearts = st.codearts || {};
  let cfgDirty = false;
  for (const a of list) {
    const rec = st.codearts[a.name] || (st.codearts[a.name] = {});
    if (!a.cookie || a.cookie.indexOf(HW_COOKIE_KEY) < 0) {
      rec.day = today; rec.outcome = 'nocookie';
      rec.note = '未配置会话 Cookie（' + HW_COOKIE_KEY + '）';
      continue;
    }
    // 今天已领成功 → 不再每轮打接口。华为会话探活也只在超过 CODEARTS_PROBE_MINUTES
    // 才做一次：实测会话 1~2 小时就死、接口轮询续不住，每轮都探只是徒增请求。
    if (rec.day === today && rec.outcome === 'claimed') {
      const lastProbe = rec.probeAt ? new Date(rec.probeAt).getTime() : 0;
      if (Date.now() - lastProbe >= CODEARTS_PROBE_MINUTES * 60000) {
        try {
          const ka = await hwApi(a, '/v1/ops/delivery?channel=WEB');
          if (hwMergeSetCookie(a, ka.setCookies)) cfgDirty = true;
          if (ka.status === 200 && ka.json && ka.json.code === 0) { a.sessionOkAt = new Date().toISOString(); cfgDirty = true; }
          rec.probeAt = new Date().toISOString();
        } catch { /* 探活失败不影响当日结论 */ }
      }
      if (rec.dbDay !== today) {
        dbEventOnce('码道:' + a.name, 'codearts_checkin', '今日已签（幂等跳过）+' + (rec.credit || 0), { credit: rec.credit }).then(ok => { if (ok) rec.dbDay = today; });
      }
      saveState(st);
      continue;
    }
    try {
      const d = await hwApi(a, '/v1/ops/delivery?channel=WEB');
      if (hwMergeSetCookie(a, d.setCookies)) cfgDirty = true;
      rec.day = today; rec.at = new Date().toISOString();
      if (d.status === 401 || d.status === 403 || d.status === 302 || d.status === 301) {
        rec.outcome = 'needauth'; rec.note = '会话失效 HTTP ' + d.status + '（需重新导出 Cookie）';
        log('码道 ' + a.name + ' 会话失效 HTTP ' + d.status + '，需人工重新导出 Cookie');
        dbEvent('码道:' + a.name, 'codearts_auth', '会话失效 HTTP ' + d.status, {});
        continue;
      }
      const dj = d.json;
      if (d.status !== 200 || !dj || dj.code !== 0) {
        // 拿不到 JSON（网关回 SPA/HTML）也按"会话不可用"处理，因为正常情况必有 JSON
        rec.outcome = d.status === 200 && !dj ? 'needauth' : 'failed';
        rec.note = (dj && (dj.message || dj.msg)) || ('HTTP ' + d.status + (dj ? ' code=' + dj.code : '（非 JSON 响应）'));
        log('码道 ' + a.name + ' 查询失败：' + rec.note);
        continue;
      }
      const items = (dj.data && dj.data.items) || [];
      // delivery 返回 code=0＝会话此刻确凿可用，记成硬证据（华为不换发票据，这是唯一可靠信号）
      a.sessionOkAt = new Date().toISOString(); cfgDirty = true;
      const camp = hwFindDaily(items);
      if (!camp) {
        rec.outcome = 'failed'; rec.note = '未找到每日签到活动（可能已下线）';
        log('码道 ' + a.name + ' 未找到每日签到活动，items=' + items.length);
        continue;
      }
      const cid = camp.campaignId;
      const amount = Number(camp.benefitAmount) || 0;
      const unit = camp.benefitUnit === 'CREDIT' || !camp.benefitUnit ? '积分' : camp.benefitUnit;
      rec.unit = unit;
      if (HW_DONE_STATUS.indexOf(camp.status) >= 0) {
        rec.outcome = 'claimed'; rec.credit = amount; rec.note = '今日已签（幂等跳过）';
        log('码道 ' + a.name + ' 今日已签 ' + amount + ' ' + unit);
        if (rec.dbDay !== today) {
          dbEventOnce('码道:' + a.name, 'codearts_checkin', '今日已签（幂等跳过）+' + amount, { credit: amount, campaignId: cid }).then(ok => { if (ok) rec.dbDay = today; });
        }
        continue;
      }
      if (cid == null) { rec.outcome = 'failed'; rec.note = '活动缺少 campaignId'; continue; }
      const claim = await hwApi(a, '/v1/ops/claim', 'POST',
        { campaignId: cid, idempotentKey: 'claim_' + cid + '_' + Date.now(), channel: 'WEB' });
      if (hwMergeSetCookie(a, claim.setCookies)) cfgDirty = true;
      const cj = claim.json || {};
      if (cj.code !== 0) {
        rec.outcome = 'failed';
        rec.note = String(cj.message || cj.msg || ('领取失败 HTTP ' + claim.status)).slice(0, 60);
        log('码道 ' + a.name + ' 领取失败：' + rec.note);
        dbEvent('码道:' + a.name, 'codearts_fail', '领取失败：' + rec.note, { campaignId: cid });
        continue;
      }
      const conf = await hwApi(a, '/v1/ops/confirm', 'POST', { campaignId: cid });
      if (hwMergeSetCookie(a, conf.setCookies)) cfgDirty = true;
      const fj = conf.json || {};
      if (fj.code !== 0) {
        // claim 成功但 confirm 失败：华为侧多数已生效，先记 claimed 但留痕，第二天 delivery 会自证
        rec.outcome = 'claimed';
        rec.note = '已领取但确认失败：' + String(fj.message || fj.msg || ('HTTP ' + conf.status)).slice(0, 40);
        log('码道 ' + a.name + ' ⚠ 领取成功但确认失败：' + rec.note);
      } else {
        rec.outcome = 'claimed'; rec.note = '';
        log('码道 ' + a.name + ' ✅ 签到成功 +' + amount + ' ' + unit);
      }
      rec.credit = amount;
      if (rec.dbDay !== today) {
        dbEventOnce('码道:' + a.name, 'codearts_checkin',
          '码道签到成功 +' + amount + ' ' + unit, { credit: amount, campaignId: cid }).then(ok => { if (ok) rec.dbDay = today; });
      }
    } catch (e) {
      rec.day = today; rec.outcome = 'failed';
      rec.note = String((e && e.message) || e).slice(0, 60);
      log('码道 ' + a.name + ' 异常：' + rec.note);
    } finally {
      saveState(st);
    }
  }
  // 会话续期只在真有变化时落盘，避免每轮重写 config
  if (cfgDirty) { try { saveCfg(); } catch {} }
}

// ---------- Qoder 每日 100 Credits ----------
// 接口（openapi，实测 2026-10-29；CN 客户端走 .com.cn，国际版走 .sh）：
//   查活动  GET  /sash/api/v1/me/campaigns            → campaigns[]，筛 actionType==CLAIM_BENEFIT
//   领取    POST /sash/api/v1/me/campaigns/{id}/claim → {status:"CLAIMED", replayed:bool}（幂等）
//   余额    GET  /api/v2/quota/usage                  → 递归找 addOnQuota.remaining
// 鉴权：Bearer dt-xxx（约 30 天，**云端绝不刷新**——刷新会顶掉本机客户端登录态）
//       + Cosy-Machine* 设备指纹五件套（本机 Qoder 客户端 runtime-info.exe 生成）。
// 三个硬约束（决定代码形状）：
//   1) 设备指纹：参考项目（国际版 .sh）说"不带指纹 campaigns 返回空、伪造 503"。
//      但 **CN 端点实测（2026-10-29）不带 Cosy-Machine* 也能正常拿到 campaigns**
//      （连每日 CLAIM_BENEFIT 都在）。差异没能进一步定位——因为今天这 100 已被客户端
//      领掉，`claim` 写操作有没有校验指纹验不出来。所以策略是：**照旧带指纹**（成本为零、
//      与客户端行为一致），但不再把它当硬性前提；缺指纹的账号也会照常跑，状态里留 hasFp 痕。
//   2) 每日轮次 10:00（UTC+8）刷新 → 10:05 前不动作，否则把昨天的 CLAIMED 当成今天。
//   3) campaigns 空数组有三种可能，现场分不出：①还没到 10:00 刷新；②活动真下线；
//      ③这套指纹不再被认（同机指纹恒定，所以"重取"通常没用，得换一台机器）。
//      → 先排时间，再看 token 是否 401，最后才怀疑指纹；别一上来就重导凭据。
// 多账号（实测 2026-10-29）：
//   · 指纹在同一台机器上是**恒定**的——runtime-info.exe 跨调用、跨小时输出完全一致，
//     所以在本机给第二个号取凭据，两个号用的是同一套 Cosy-Machine*；
//   · token 每号独立、各自 30 天，互不影响（/health 的 qoderTokenDaysMin 取最小值）；
//   · **未验证的风险**：Qoder 是否存在"一套指纹每天只能领一个号"的设备级限额
//     （Trae 就有 9095 这种）。加第二个号后要盯两天：若两号都能 CLAIMED 就没限制；
//     若总有一个号停在 empty/failed，就是撞上设备限额——这时得让第二个号在**另一台机器**
//     登录并跑 sync（--export 生成 JSON，再粘到看板）。
const QD_DEFAULT_BASE = 'https://openapi.qoder.com.cn';
const QD_CAMPAIGNS = '/sash/api/v1/me/campaigns';
const QD_QUOTA = '/api/v2/quota/usage';

async function qdApi(a, urlPath, method, body) {
  const fp = a.fingerprint || {};
  const headers = {
    'Authorization': 'Bearer ' + (a.token || ''),
    'User-Agent': 'Qoder',
    'Cosy-ClientType': '10',
    'Cosy-Version': fp.cosyVersion || '0.4.1',
    'Accept': 'application/json',
    'Cosy-MachineToken': fp.machineToken || '',
    'Cosy-MachineType': fp.machineType || 'windows_x64',
    'Cosy-MachineCode': fp.machineCode || '',
    'Cosy-MachineOS': fp.machineOS || 'win32',
    // machineId 优先级：指纹里的 → 账号级 machineId（magpie 给的，每号不同）→ machineCode 兜底
    'Cosy-MachineId': fp.machineId || a.machineId || fp.machineCode || '',
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const opt = { method: method || 'GET', headers, signal: ctl.signal };
    if (body !== undefined) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch((a.base || QD_DEFAULT_BASE) + urlPath, opt);
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, json: j, raw: text.slice(0, 160) };
  } catch (e) {
    return { status: -1, json: null, raw: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

function qdFindAddOn(obj) {
  if (obj && typeof obj === 'object') {
    if (obj.addOnQuota) return obj.addOnQuota;
    for (const k of Object.keys(obj)) {
      const r = qdFindAddOn(obj[k]);
      if (r) return r;
    }
  }
  return null;
}

async function qoderRound(st) {
  const list = (CFG.qoder && CFG.qoder.accounts) || [];
  if (!list.length) return;
  const today = cnDateStr();
  st.qoder = st.qoder || {};
  // 账号改名/删除后，旧名字的 state 记录会自动清掉（否则看板/云库会挂着幽灵号）
  for (const k of Object.keys(st.qoder)) {
    if (!list.some(x => x.name === k)) delete st.qoder[k];
  }
  // 北京时间 10:05 前不动作（10:00 才刷新今日轮次，更早查到的 CLAIMED 是昨天的）
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const bjMin = Number(bj.slice(11, 13)) * 60 + Number(bj.slice(14, 16));
  for (const a of list) {
    const rec = st.qoder[a.name] || (st.qoder[a.name] = {});
    if (!a.token) {
      rec.day = today; rec.outcome = 'nocred';
      rec.note = '未配置 dt- token（跑 sync-qoder-from-local.py 或看板粘贴）';
      saveState(st);
      continue;
    }
    // 指纹是"建议有"而不是"必须有"：实测（2026-10-29，CN 端点）不带 Cosy-Machine*
    // 也能拿到 campaigns（含每日 CLAIM_BENEFIT）。但 claim 写操作历史上据称要校验指纹，
    // 今天活动已被客户端领掉、验不出差别 → 缺指纹时照常干活，只在状态里留痕，便于排查。
    rec.hasFp = !!(a.fingerprint && (a.fingerprint.machineToken || a.fingerprint.machineCode));
    if (bjMin < 10 * 60 + 5) continue;   // 未到开放时间：不动 rec，今天保持 pending
    // 今日已领 → 不再重复请求活动列表（幂等省一次调用），只在云库补当天记录
    if (rec.day === today && rec.outcome === 'claimed') {
      if (rec.dbDay !== today) {
        dbEventOnce('Qoder:' + a.name, 'qoder_checkin', '今日已领（幂等跳过）+' + (rec.credit || 0) + ' Credits', { credit: rec.credit }).then(ok => { if (ok) rec.dbDay = today; });
      }
      continue;
    }
    try {
      let c = await qdApi(a, QD_CAMPAIGNS);
      // 防御性重试：拿到 200 但 body 解析不出 JSON（截断/空体）时 3 秒后再试一次
      if (c.status === 200 && !c.json) {
        await new Promise(r2 => setTimeout(r2, 3000));
        c = await qdApi(a, QD_CAMPAIGNS);
      }
      rec.day = today; rec.at = new Date().toISOString();
      if (c.status === 401) {
        rec.outcome = 'token_expired';
        rec.note = 'dt- token 已失效（HTTP 401，约 30 天寿命到）';
        log('Qoder ' + a.name + ' token 失效，需重跑 sync-qoder-from-local.py');
        dbEvent('Qoder:' + a.name, 'qoder_auth', 'token 失效 HTTP 401', {});
        continue;
      }
      if (c.status !== 200 || !c.json) {
        rec.outcome = 'failed';
        rec.note = 'campaigns HTTP ' + c.status + (c.json && c.json.message ? ' ' + c.json.message : '');
        log('Qoder ' + a.name + ' 查询失败：' + rec.note);
        continue;
      }
      const camps = (c.json.campaigns || []).filter(x => x && x.actionType === 'CLAIM_BENEFIT');
      const claimable = camps.filter(x => (x.claimStatus || '').toUpperCase() === 'CLAIMABLE');
      if (claimable.length) {
        const camp = claimable[0];
        const cid = camp.campaignId || '';
        const cr = await qdApi(a, QD_CAMPAIGNS + '/' + cid + '/claim', 'POST', {});
        if (cr.json && (cr.json.status || '').toUpperCase() === 'CLAIMED') {
          rec.outcome = 'claimed';
          rec.by = cr.json.replayed ? 'replay' : 'server';
          rec.credit = Number(camp.benefit && camp.benefit.amount) || 100;
          rec.note = cr.json.replayed ? '已领（幂等重放）' : '';
          log('Qoder ' + a.name + ' ✅ 领取成功 +' + rec.credit + ' Credits' + (cr.json.replayed ? '（幂等）' : ''));
        } else {
          rec.outcome = 'failed';
          rec.note = 'claim 返回异常: ' + JSON.stringify(cr.json || { status: cr.status }).slice(0, 60);
          log('Qoder ' + a.name + ' 领取失败：' + rec.note);
          dbEvent('Qoder:' + a.name, 'qoder_fail', '领取失败：' + rec.note, { campaignId: cid });
        }
      } else if (camps.length) {
        rec.outcome = 'claimed';
        rec.by = 'observed';
        rec.credit = Number((camps[0].benefit || {}).amount) || 0;
        rec.note = '今日已领（活动状态 CLAIMED）';
        log('Qoder ' + a.name + ' 今日已领（幂等）');
      } else {
        rec.outcome = 'empty';
        rec.note = '无 CLAIM_BENEFIT 活动（未过 10:00 / 活动下线 / 指纹不被认，三者界面分不出）';
        log('Qoder ' + a.name + ' ' + rec.note);
      }
      if (rec.outcome === 'claimed' && rec.dbDay !== today) {
        // 区分"本轮真领到了"与"只是观测到已领"：云库存的是事实，不能写成我们干的
        dbEventOnce('Qoder:' + a.name, 'qoder_checkin',
          (rec.by === 'server' ? 'Qoder 领取成功 +' : 'Qoder 今日已领（观测到活动已 CLAIMED）+')
            + rec.credit + ' Credits',
          { credit: rec.credit, balance: rec.balance, by: rec.by || 'server' }).then(ok => { if (ok) rec.dbDay = today; });
      }
      // 余额顺带查一下（失败不影响主结论）
      try {
        const q = await qdApi(a, QD_QUOTA);
        const aq = qdFindAddOn(q.json);
        if (aq && aq.remaining != null) rec.balance = Number(aq.remaining);
      } catch { rec.balance = rec.balance || null; }
    } catch (e) {
      rec.day = today; rec.outcome = 'failed';
      rec.note = String((e && e.message) || e).slice(0, 60);
      log('Qoder ' + a.name + ' 异常：' + rec.note);
    } finally {
      saveState(st);
    }
  }
}

// ---------- 余额（各平台自己的额度接口；失败只留空，绝不影响签到） ----------
// 接口来源＝magpie 插件里的同一份实现（WorkBuddy 插件 meterAsked、Trae 插件 usage），
// 这里只是照着调一次，好让看板能显示"每个号还剩多少"。
async function wbBalance(a) {
  if (!a.accessToken) return null;
  try {
    const r = await fetch('https://copilot.tencent.com/billing/meter/get-user-resource-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'User-Agent': 'WorkBuddy/5.9.3', 'Authorization': 'Bearer ' + a.accessToken,
        'X-User-Id': a.uid || '', 'X-Product': 'SaaS', 'X-IDE-Type': 'WorkBuddy',
      },
      body: '{}', signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (!j) return null;
    const d = j.data || j;
    const packs = d.Packages || [];
    if (!packs.length) return null;
    let total = 0, remain = 0;
    for (const p of packs) {
      const t = Number(p.CycleTotalCapacity), rem = Number(p.CycleRemainCapacity);
      if (Number.isFinite(t)) total += t;
      if (Number.isFinite(rem)) remain += rem;
    }
    return { remain: Math.round(remain * 10) / 10, total: Math.round(total * 10) / 10, unit: 'credits' };
  } catch { return null; }
}

async function traeBalance(a) {
  if (!a.access) return null;
  try {
    const p = a.profile || {};
    const r = await fetch('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Authorization': 'Cloud-IDE-JWT ' + a.access,
        'User-Agent': p.ua || TRAE_UA, 'x-device-id': String(a.deviceId || ''),
        'x-device-brand': p.brand || TRAE_BRAND, 'x-device-type': p.type || 'Windows',
        'x-os-version': p.os || '10.0.22631', 'x-app-version': p.appVersion || '0.1.69',
      },
      body: JSON.stringify({ require_usage: true, req_source: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    const packs = (j && j.user_entitlement_pack_list) || [];
    if (!packs.length) return null;
    let limit = 0, used = 0, unlimited = false;
    for (const pk of packs) {
      const bi = (pk && pk.entitlement_base_info) || {};
      const l = Number(bi.quota && bi.quota.credits_limit);
      if (!Number.isFinite(l)) continue;
      const u = Number(pk.usage && pk.usage.credits_amount) || 0;
      if (l === -1) unlimited = true; else if (l >= 0) limit += l;
      if (u > 0) used += u;
    }
    if (unlimited) return { remain: '∞', total: '∞', unit: 'credits' };
    return { remain: Math.round((limit - used) * 10) / 10, total: Math.round(limit * 10) / 10, unit: 'credits' };
  } catch { return null; }
}

async function refreshBalances(st) {
  st.bal = st.bal || { workbuddy: {}, trae: {} };
  const lastAt = st.bal.at ? new Date(st.bal.at).getTime() : 0;
  if (Date.now() - lastAt < BALANCE_MINUTES * 60000) return;   // 余额变化慢，按 BALANCE_MINUTES 节流
  const at = new Date().toISOString();
  for (const a of (CFG.accounts || [])) {
    const b = await wbBalance(a);
    if (b) st.bal.workbuddy[a.name] = Object.assign(b, { at });
  }
  for (const a of ((CFG.trae && CFG.trae.accounts) || [])) {
    const b = await traeBalance(a);
    if (b) st.bal.trae[a.name] = Object.assign(b, { at });
  }
  st.bal.at = at;
  saveState(st);
}

// ---------- 定时器 ----------
const START_AT = Date.now();
function schedule() {
  setInterval(() => { tick().catch(e => log('tick异常: ' + e.message)); }, TICK_MINUTES * 60 * 1000);
  setInterval(() => { ensureTokens().catch(e => log('续期异常: ' + e.message)); }, REFRESH_CHECK_MINUTES * 60 * 1000);
  log('定时器已启动：工作每 ' + TICK_MINUTES + ' 分钟一轮，续期每 ' + REFRESH_CHECK_MINUTES + ' 分钟检查');
}

// ---------- HTTP 服务 ----------
function authed(req, urlObj) {
  const key = urlObj.searchParams.get('key') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return key && CFG.access_key && key === CFG.access_key;
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  // [cors] 应用卡片的静态预览不在本服务域名下，浏览器跨域读 /health 需要放行。
  // 只放 CORS 头不放鉴权：/status、/panel 等数据端点仍然必须带 access_key。
  const _wh = res.writeHead.bind(res);
  res.writeHead = function (code, a, b) {
    const h = (a && typeof a === 'object') ? a : (b && typeof b === 'object') ? b : null;
    if (h) {
      h['access-control-allow-origin'] = '*';
      h['access-control-allow-headers'] = 'content-type,authorization';
      h['cache-control'] = h['cache-control'] || 'no-store';
    }
    return h ? _wh(code, h) : _wh(code, a, b);
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '600' });
    return res.end();
  }
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 1)); };
  // 读请求体 + 解析 JSON。超限时回 413，而不是 req.destroy()（后者客户端只看到连接被重置，
  // 面板上会显示成网络错误，用户根本不知道是体太大）。
  const readJson = (req, limit, cb) => {
    let raw = '', tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      raw += c;
      if (raw.length > limit) {
        tooBig = true;
        send(413, { ok: false, error: '请求体过大（上限 ' + limit + ' 字节）' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { b = {}; }
      cb(b);
    });
  };
  if (urlObj.pathname === '/health') {
    // 这个端点**公网无鉴权**（应用卡片预览要跨域读它），所以内容按鉴权分两级：
    //   · 未带 access_key：只给数量（done/total）、告警种类、业务锚点时间、按平台的余额合计；
    //   · 带 access_key：额外给 balances.rows 逐账号明细（入口页用它分行展示）。
    // 账号昵称属个人信息，绝不能出现在未鉴权响应里。
    const isAuthed = authed(req, urlObj);
    const st = state();
    const today = cnDateStr();
    const kinds = new Set();
    for (const a of CFG.accounts) {
      const dl = daysLeft(a.expiresAt);
      if (dl == null || dl < 7) kinds.add('token_expiring');
    }
    // 签到完成度统一走注册表：WorkBuddy + Trae + 以后新增的平台
    const sum = checkinSummary(st);
    if (sum.pending > 0) kinds.add('checkin_pending');
    const staleH = st.lastTickAt ? (Date.now() - new Date(st.lastTickAt).getTime()) / 3600000 : null;
    if (staleH == null || staleH > 26) kinds.add('stale');
    const okAt = st.lastOkAt ? (Date.now() - new Date(st.lastOkAt).getTime()) / 3600000 : null;
    if (okAt != null && okAt > 26) kinds.add('business_stale');
    const tokenDays = CFG.accounts.map(a => daysLeft(a.expiresAt)).filter(x => x != null);
    // Trae 令牌不能云端刷新（刷新会解绑设备→9074），到期必须人工重跑同步脚本，
    // 所以剩余不足 1.5 天就提前告警，别等到两个号突然全停。
    const traeList = (CFG.trae && CFG.trae.accounts) || [];
    const traeDays = traeList.map(a => {
      const t = typeof a.expires === 'number' ? (a.expires > 1e12 ? a.expires : a.expires * 1000) : new Date(a.expires).getTime();
      return isNaN(t) ? null : (t - Date.now()) / 86400000;
    }).filter(x => x != null);
    if (traeDays.some(d => d < 1.5)) kinds.add('trae_token_expiring');
    // 码道：会话 Cookie 是 HttpOnly 短效凭据，云端只能续期不能自愈；
    // 一旦落到 needauth 就是人工动作（重新导出 Cookie），单独给一种告警类别。
    const hwRows = sum.rows.filter(r => r.platform === 'codearts');
    if (hwRows.some(r => r.state === 'needauth')) kinds.add('codearts_auth');
    // 实测（2026-10-29）：华为 devcloud 会话约 1~2 小时死透，且**纯接口轮询续不住**
    // （响应只回 BENSESSCC_TAG，不换发新的 J_SESSION_ID；换发要有已登录浏览器里的 SSO cookie）。
    // 所以：今天已签上就不算异常（不因"会话凉了"报警——那是常态）；
    // 真正的信号是"今天没签上且会话已死"＝needauth，需要人工重导。
    // codeartsSessionAlive 只作展示：最近一次被证明可用是几点。
    const hwAt = (CFG.codearts && CFG.codearts.accounts || [])
      .map(a => a.sessionOkAt).filter(Boolean).sort().pop() || null;
    // Qoder：dt- token 约 30 天且云端绝不自刷（会顶掉客户端登录态）→ 剩 3 天内预警
    const qdList = (CFG.qoder && CFG.qoder.accounts) || [];
    const qdDays = qdList.map(a => a.tokenExpiresAt ? (new Date(a.tokenExpiresAt).getTime() - Date.now()) / 86400000 : null)
      .filter(x => x != null && !isNaN(x));
    if (qdDays.some(d => d < 3)) kinds.add('qoder_token_expiring');
    const qdRows = sum.rows.filter(r => r.platform === 'qoder');
    if (qdRows.some(r => r.state === 'needauth')) kinds.add('qoder_cred');
    return send(200, {
      ok: true, service: 'wbmon-cloud',
      uptimeMinutes: Math.round((Date.now() - START_AT) / 60000),
      tickCount: st.tickCount || 0, lastTickAt: st.lastTickAt || null,
      staleHours: staleH == null ? null : Math.round(staleH * 10) / 10,
      lastOkAt: st.lastOkAt || null,
      tickMinutes: TICK_MINUTES,
      acctCount: CFG.accounts.length,
      checkin: {
        done: sum.done, total: sum.total, pending: sum.pending,
        by: sum.by, brief: platformBrief(sum),
      },
      tokenDaysMin: tokenDays.length ? Math.min(...tokenDays) : null,
      traeTokenDaysMin: traeDays.length ? Math.round(Math.min(...traeDays) * 10) / 10 : null,
      codeartsSessionOkAt: hwAt,   // 码道会话最近一次被证明可用的时间（delivery 返回 code=0）
      qoderTokenDaysMin: qdDays.length ? Math.round(Math.min(...qdDays) * 10) / 10 : null,
      // 刷新主管：magpie＝本机负责续期、云端只借 access（默认，避免两边抢链）；cloud＝云端自己刷
      refreshOwner: CFG.refreshOwner || 'magpie',
      // magpie 上次同步距今几天（超过 FALLBACK_AFTER_DAYS 且 access 快到期时，云端会保底自刷）
      magpieSyncDays: CFG.magpieSyncAt ? Math.round(((Date.now() - new Date(CFG.magpieSyncAt).getTime()) / 86400000) * 10) / 10 : null,
      // 各平台余额：合计恒有；rows（逐账号，含昵称）只在 isAuthed 时给出
      balances: (function () {
        const stt = st;   // 复用本请求已加载的快照，别为聚合再读一次盘
        const agg = (pf, arr) => {
          let remain = 0, total = 0, n = 0;
          for (const a of arr || []) {
            const b = ((stt.bal || {})[pf] || {})[a.name];
            if (!b || typeof b.remain !== 'number') continue;
            remain += b.remain; total += b.total; n++;
          }
          return n ? { remain: Math.round(remain * 10) / 10, total: Math.round(total * 10) / 10, accounts: n } : null;
        };
        const qrec = stt.qoder || {};
        let qRemain = 0, qn = 0;
        for (const a of ((CFG.qoder && CFG.qoder.accounts) || [])) {
          const v = qrec[a.name];
          if (v && typeof v.balance === 'number') { qRemain += v.balance; qn++; }
        }
        // 逐账号明细含昵称，只给已鉴权调用方；未鉴权时 rows 为空数组（前端退化成合计行）
        const rows = [];
        if (isAuthed) for (const a of (CFG.accounts || [])) {
          const b = ((stt.bal || {}).workbuddy || {})[a.name];
          if (b && typeof b.remain === 'number') rows.push({ p: 'WorkBuddy', a: a.name, r: b.remain });
        }
        if (isAuthed) for (const a of ((CFG.trae && CFG.trae.accounts) || [])) {
          const b = ((stt.bal || {}).trae || {})[a.name];
          if (b && typeof b.remain === 'number') rows.push({ p: 'Trae CN', a: a.name, r: b.remain });
          else if (b && b.remain === '∞') rows.push({ p: 'Trae CN', a: a.name, r: -1 });
        }
        if (isAuthed) for (const a of ((CFG.qoder && CFG.qoder.accounts) || [])) {
          const v = qrec[a.name];
          if (v && typeof v.balance === 'number') rows.push({ p: 'Qoder', a: a.name, r: v.balance });
        }
        return {
          workbuddy: agg('workbuddy', CFG.accounts),
          trae: agg('trae', (CFG.trae && CFG.trae.accounts) || []),
          qoder: qn ? { remain: qRemain, accounts: qn } : null,
          rows,
          rowsAuthed: isAuthed,
          at: (stt.bal || {}).at || null,
        };
      })(),
      alerts: Array.from(kinds),
      alertCount: kinds.size,
      cloudDb: CLOUD_DB ? (CLOUD_OK ? 'ok' : 'init-only') : 'off',
    });
  }

  // 更新码道会话 Cookie（受 access_key 保护）。
  // 华为会话是 HttpOnly 短效凭据（静置 30~60 分钟失效），且云端无权自行登录。
  // 给个网页入口：粘完当场实测，能用才落盘，不让人靠猜。
  if (urlObj.pathname === '/codearts-cookie' && req.method === 'POST') {
    if (!authed(req, urlObj)) return send(401, { ok: false, error: '需要 access_key' });
    readJson(req, 20000, async b => {
      const cookie = String(b.cookie || '').trim();
      const wantName = String(b.account || '').trim();
      if (!cookie) return send(400, { ok: false, error: 'cookie 不能为空' });
      if (cookie.indexOf(HW_COOKIE_KEY) < 0) {
        return send(400, { ok: false, error: 'Cookie 里没找到 ' + HW_COOKIE_KEY + '，请复制登录华为云后的完整 Cookie' });
      }
      if (!CFG.codearts) CFG.codearts = { accounts: [], note: '' };
      if (!Array.isArray(CFG.codearts.accounts)) CFG.codearts.accounts = [];
      const list = CFG.codearts.accounts;
      let a = wantName ? list.find(x => x.name === wantName) : list[0];
      if (!a) { a = { name: wantName || '码道-默认' }; list.push(a); }
      // 只在实测通过后才落盘：失败则保留旧 Cookie，避免把还能用的凭据换掉
      const bak = a.cookie || '';
      a.cookie = cookie;
      const rr = await hwApi(a, '/v1/ops/delivery?channel=WEB');
      hwMergeSetCookie(a, rr.setCookies);
      const jj = rr.json || {};
      if (!(rr.status === 200 && jj.code === 0)) {
        a.cookie = bak;
        const why = (jj && (jj.message || jj.msg)) || ('HTTP ' + rr.status + (rr.json ? ' code=' + jj.code : '（非 JSON 响应，多半是登录态无效）'));
        log('码道 ' + a.name + ' 看板提交的 Cookie 实测未通过：' + String(why).slice(0, 60));
        return send(200, { ok: false, verified: false, error: String(why).slice(0, 160) });
      }
      const camp = hwFindDaily((jj.data && jj.data.items) || []);
      a.cookieAt = new Date().toISOString();
      a.sessionOkAt = a.cookieAt;
      a.cookieSource = 'panel';
      saveCfg();
      const note = camp ? ('活动在线，当前状态 ' + (camp.status || '?') + '，本次可领 ' + (camp.benefitAmount != null ? camp.benefitAmount : '?') + ' ' + (camp.benefitUnit === 'CREDIT' || !camp.benefitUnit ? '积分' : camp.benefitUnit)) : '登录态有效，但暂未发现每日签到活动';
      log('码道 ' + a.name + ' 会话 Cookie 已由看板更新并实测通过');
      // 立刻补签一次（当天还没签的话），让用户提交完就能看到结果。
      // 与 tick 互斥：撞上正在跑的一轮就不并发跑（否则 state 丢更新），如实告知稍后自动补。
      const ran = await runRoundExclusive(() => codeartsRound(state()), '码道 提交后补签');
      return send(200, {
        ok: true, verified: true, account: a.name, note, ran,
        msg: ran ? '已保存，已立刻补签一次' : '已保存，正在跑一轮，稍后自动补签',
      });
    });
    return;
  }

  // 更新 Qoder 凭据（受 access_key 保护）：{token:"dt-...", fingerprint:{...}, expiresAt}
  // 指纹（Cosy-Machine*）失效表现为 campaigns 空，token 失效表现为 401 —— 都在这重导。
  if (urlObj.pathname === '/qoder-cred' && req.method === 'POST') {
    if (!authed(req, urlObj)) return send(401, { ok: false, error: '需要 access_key' });
    readJson(req, 40000, async b => {
      const token = String(b.token || '').trim();
      if (token.slice(0, 3) !== 'dt-') {
        return send(400, { ok: false, error: 'token 必须是 dt- 开头（从本机 Qoder 客户端 auth.v1.dat 解出，或跑 sync-qoder-from-local.py）' });
      }
      // base 会直接拿去做请求，必须先校验（否则等于给了一个「让服务端去请求任意地址」的入口）
      const wantBase = b.base ? validBase(b.base) : null;
      if (b.base && !wantBase) {
        return send(400, { ok: false, error: 'base 不合法：只接受 https 域名（不带端口/路径/参数），例如 https://openapi.qoder.com.cn' });
      }
      if (!CFG.qoder) CFG.qoder = { accounts: [], note: '' };
      if (!Array.isArray(CFG.qoder.accounts)) CFG.qoder.accounts = [];
      const list = CFG.qoder.accounts;
      const wantName = String(b.account || '').trim();
      let a = wantName ? list.find(x => x.name === wantName) : list[0];
      const isNew = !a;
      if (isNew) { a = { name: wantName || 'Qoder主号' }; list.push(a); }
      const bak = { token: a.token, fingerprint: a.fingerprint, tokenExpiresAt: a.tokenExpiresAt };
      a.token = token;
      if (b.fingerprint && typeof b.fingerprint === 'object' && (b.fingerprint.machineToken || b.fingerprint.machineCode)) {
        a.fingerprint = b.fingerprint;
        a.fpAt = new Date().toISOString();
        a.fpSource = a.fpSource || 'panel';
      }
      if (b.expiresAt) a.tokenExpiresAt = b.expiresAt;
      // magpie 场景：设备身份是账号级的（每号一个 UUID），直接收下，qdApi 会优先用它
      if (b.machineId) {
        a.machineId = String(b.machineId);
        if (!a.fingerprint || typeof a.fingerprint !== 'object') a.fingerprint = {};
        a.fingerprint.machineId = a.machineId;
        a.fpSource = a.fpSource || 'magpie';
      }
      // base 可指定（CN＝openapi.qoder.com.cn，国际版＝openapi.qoder.sh）。
      // 校验统一走 lib.validBase：https、无 path/query/userinfo/端口、非内网地址。
      if (wantBase) a.base = wantBase;
      // 当场实测：campaigns 200 且有返回才算数；失败保留旧凭据
      const c = await qdApi(a, QD_CAMPAIGNS);
      if (!(c.status === 200 && c.json && Array.isArray(c.json.campaigns))) {
        if (isNew) { list.splice(list.indexOf(a), 1); } else { a.token = bak.token; a.fingerprint = bak.fingerprint; a.tokenExpiresAt = bak.tokenExpiresAt; }
        const why = c.status === 401 ? 'token 无效（HTTP 401）' : ('HTTP ' + c.status + (c.json && c.json.message ? ' ' + c.json.message : ''));
        log('Qoder ' + a.name + ' 看板提交的凭据实测未通过：' + why);
        return send(200, { ok: false, verified: false, error: why });
      }
      const hasBenefit = (c.json.campaigns || []).some(x => x && x.actionType === 'CLAIM_BENEFIT');
      // 新账号只给 token 是不够的：不带 Cosy-Machine 指纹，campaigns 必然返回空数组，
      // 看着像"验证通过但没活动"，实际根本领不到 → 明确拒绝，别存半套凭据。
      const fpOk = a.fingerprint && (a.fingerprint.machineToken || a.fingerprint.machineCode);
      if (!fpOk && !hasBenefit) {
        if (isNew) { list.splice(list.indexOf(a), 1); } else { a.token = bak.token; a.fingerprint = bak.fingerprint; a.tokenExpiresAt = bak.tokenExpiresAt; }
        return send(200, { ok: false, verified: false, error: '这个账号还没有设备指纹：不带 Cosy-Machine 指纹时 campaigns 必定为空、领不到每日 100。请连同指纹一起提交（跑 sync-qoder-from-local.py --export 生成的 JSON）' });
      }
      saveCfg();
      log('Qoder ' + a.name + ' 凭据已由看板更新并实测通过（campaigns=' + c.json.campaigns.length + '）');
      // 同 /codearts-cookie：与 tick 互斥，撞上就不并发跑，避免 state 丢更新
      const ran = await runRoundExclusive(() => qoderRound(state()), 'Qoder 提交后补领');
      return send(200, {
        ok: true, verified: true, account: a.name, ran,
        msg: ran ? '已保存，已立刻补领一次' : '已保存，正在跑一轮，稍后自动补领',
        note: '凭据有效，campaigns=' + c.json.campaigns.length + (hasBenefit ? '，含每日领取活动' : '（暂无 CLAIM_BENEFIT 活动）'),
      });
    });
    return;
  }

  // 从本机 magpie 一次性同步三个平台的凭据（受 access_key 保护）。
  // 原则：magpie 是刷新链的主人，云端只借 access token、绝不替它刷新；
  // 每个账号都当场实测（WB: buddy/info、Trae: checkin status、Qoder: campaigns），
  // 只有通过的才落盘，没通过的原样保留旧凭据——避免"推了个坏 token 把好号搞挂"。
  if (urlObj.pathname === '/sync-from-magpie' && req.method === 'POST') {
    if (!authed(req, urlObj)) return send(401, { ok: false, error: '需要 access_key' });
    readJson(req, 300000, async b => {
      const out = { workbuddy: [], trae: [], qoder: [] };
      let changed = false;

      // ---------- WorkBuddy ----------
      for (const w of (Array.isArray(b.workbuddy) ? b.workbuddy : [])) {
        const name = String(w.name || '').trim();
        const at = String(w.accessToken || '').trim();
        if (!name || !at) { out.workbuddy.push({ name, ok: false, why: '缺 name / accessToken' }); continue; }
        let v = { status: -1, json: {} };
        try { v = await reqJson(HOST_WB, '/activity/growth/buddy/info', at, 'GET'); } catch (e) { v = { status: -1, json: {}, err: String(e.message || e) }; }
        const good = v.status === 200 && v.json && v.json.code === 0;
        if (!good) {
          out.workbuddy.push({ name, ok: false, why: '校验失败 HTTP ' + v.status + (v.json && v.json.code != null ? ' code=' + v.json.code : '') });
          continue;
        }
        let a = (w.uid && CFG.accounts.find(x => x.uid === w.uid)) || CFG.accounts.find(x => x.name === name);
        if (!a) { a = { name, uid: w.uid || '' }; CFG.accounts.push(a); }
        a.accessToken = at;
        if (w.refreshToken) a.refreshToken = String(w.refreshToken);
        if (w.expiresAt) a.expiresAt = Number(w.expiresAt) || a.expiresAt;
        if (w.refreshExpiresAt) a.refreshExpiresAt = Number(w.refreshExpiresAt) || a.refreshExpiresAt;
        a.syncedFrom = 'magpie';
        changed = true;
        out.workbuddy.push({ name: a.name, ok: true, daysLeft: daysLeft(a.expiresAt) });
      }

      // ---------- Trae ----------
      for (const t of (Array.isArray(b.trae) ? b.trae : [])) {
        const name = String(t.name || '').trim();
        const access = String(t.access || '').trim();
        if (!name || !access) { out.trae.push({ name, ok: false, why: '缺 name / access' }); continue; }
        let a = (t.uid && (CFG.trae.accounts || []).find(x => x.uid === t.uid)) ||
                (CFG.trae.accounts || []).find(x => x.name === name);
        const cand = { access, deviceId: t.deviceId, profile: t.profile || a && a.profile };
        let v = { status: -1, json: {} };
        try { v = await traePost(cand, 'status'); } catch (e) { v = { status: -1, json: {}, err: String(e.message || e) }; }
        const good = v.status === 200 && (v.json.code == null || v.json.code === 0);
        if (!good) {
          out.trae.push({ name, ok: false, why: '校验失败 HTTP ' + v.status + ' code=' + (v.json && v.json.code) });
          continue;
        }
        CFG.trae = CFG.trae || { accounts: [] };
        CFG.trae.accounts = CFG.trae.accounts || [];
        if (!a) { a = { name, uid: t.uid || '' }; CFG.trae.accounts.push(a); }
        a.access = access;
        if (t.deviceId) a.deviceId = String(t.deviceId);
        if (t.expires) a.expires = Number(t.expires);
        if (t.profile) a.profile = t.profile;
        a.syncedFrom = 'magpie';
        changed = true;
        out.trae.push({ name: a.name, ok: true, daysLeft: a.expires ? daysLeft(a.expires) : null });
      }

      // ---------- Qoder ----------
      for (const q of (Array.isArray(b.qoder) ? b.qoder : [])) {
        const name = String(q.name || '').trim();
        const token = String(q.token || '').trim();
        if (!name || token.slice(0, 3) !== 'dt-') { out.qoder.push({ name, ok: false, why: '缺 name / 非 dt- token' }); continue; }
        // 同步来的 base 同样要校验：不合法就整条拒掉，绝不拿它去发请求（盲 SSRF 放大器）
        const qBase = q.base ? validBase(q.base) : QD_DEFAULT_BASE;
        if (!qBase) { out.qoder.push({ name, ok: false, why: 'base 不合法' }); continue; }
        CFG.qoder = CFG.qoder || { accounts: [] };
        CFG.qoder.accounts = CFG.qoder.accounts || [];
        let a = (q.uid && CFG.qoder.accounts.find(x => x.uid === q.uid)) || CFG.qoder.accounts.find(x => x.name === name);
        if (!a) { a = { name, uid: q.uid || '' }; CFG.qoder.accounts.push(a); }
        // 用待验证的凭据临时构造一份再测，坏的不落盘
        const probeAcc = { token, base: qBase, machineId: q.machineId || a.machineId,
          fingerprint: Object.assign({}, a.fingerprint, q.machineId ? { machineId: q.machineId } : {}) };
        let v = { status: -1, json: null };
        try { v = await qdApi(probeAcc, QD_CAMPAIGNS); } catch (e) { v = { status: -1, json: null, err: String(e.message || e) }; }
        const good = v.status === 200 && v.json && Array.isArray(v.json.campaigns);
        if (!good) {
          out.qoder.push({ name, ok: false, why: '校验失败 HTTP ' + v.status + (v.json && v.json.message ? ' ' + v.json.message : '') });
          continue;
        }
        a.token = token;
        if (q.machineId) { a.machineId = String(q.machineId); a.fingerprint = Object.assign({}, a.fingerprint, { machineId: a.machineId }); }
        if (q.expiresAt) a.tokenExpiresAt = q.expiresAt;
        a.base = qBase;
        a.syncedFrom = 'magpie';
        changed = true;
        const daily = (v.json.campaigns || []).filter(x => x && x.actionType === 'CLAIM_BENEFIT');
        out.qoder.push({ name: a.name, ok: true, daily: daily.map(x => (x.claimStatus || '?')).join(',') || '无每日活动' });
      }

      if (changed) { CFG.refreshOwner = 'magpie'; CFG.magpieSyncAt = new Date().toISOString(); saveCfg(); }
      const okCount = ['workbuddy', 'trae', 'qoder'].reduce((n, k) => n + out[k].filter(x => x.ok).length, 0);
      const badCount = ['workbuddy', 'trae', 'qoder'].reduce((n, k) => n + out[k].filter(x => !x.ok).length, 0);
      log('magpie 同步：成功 ' + okCount + ' 个，失败 ' + badCount + ' 个（刷新主管=' + (CFG.refreshOwner || 'magpie') + '）');
      // 拿完新凭据立刻跑一轮，今天还没签的直接补上（幂等，重复签不会重复发）
      if (okCount) setTimeout(() => { tick().catch(e => log('同步后补跑异常: ' + ((e && e.message) || e))); }, 300);
      return send(200, { ok: badCount === 0, refreshOwner: CFG.refreshOwner || 'magpie', adopted: okCount, failed: badCount, detail: out });
    });
    return;
  }

  // 应用卡片的入口页（.genie 的 entryHtml 指向它）：静态文件，内容与线上同源，
  // 卡片预览打不开时也能直接访问 /index.html。
  if (urlObj.pathname === '/index.html' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return send(404, { ok: false }); }
  }
  if (urlObj.pathname === '/' && req.method === 'GET') {
    // [deploy] 公开落地页：仅 /health 级别信息（无账号名/令牌/余额），让分享链接和应用卡片可打开
    const st = state();
    const bj = ms => ms ? new Date(ms + 8*3600*1000).toISOString().slice(0,16).replace('T',' ') + ' 北京时间' : '—';
    const lastTick = st.lastTickAt ? bj(new Date(st.lastTickAt).getTime()) : '—';
    const lastOk = st.lastOkAt ? bj(new Date(st.lastOkAt).getTime()) : '—';
    const kinds = { token_expiring:'令牌将过期', checkin_pending:'今日签到未完成', stale:'服务长时间未跑', business_stale:'业务结果长时间未更新', codearts_auth:'码道会话需重新导入', trae_token_expiring:'Trae 令牌将过期', qoder_cred:'Qoder 凭据需重导', qoder_token_expiring:'Qoder 令牌将过期' };
    const today2 = cnDateStr();
    // 全平台完成度统一走注册表（原来只数 WorkBuddy，加平台后公网页会假报"无告警"）
    const sum2 = checkinSummary(st);
    const kinds2 = new Set();
    if (sum2.pending > 0) kinds2.add('checkin_pending');
    if (sum2.rows.some(r => r.state === 'needauth')) kinds2.add('codearts_auth');
    const tokenDays2 = CFG.accounts.map(x => daysLeft(x.expiresAt)).filter(v => v != null);
    if (tokenDays2.length && Math.min(...tokenDays2) <= 3) kinds2.add('token_expiring');
    const staleH2 = st.lastTickAt ? (Date.now() - new Date(st.lastTickAt).getTime())/3600000 : null;
    if (staleH2 == null || staleH2 > 26) kinds2.add('stale');
    const okAt2 = st.lastOkAt ? (Date.now() - new Date(st.lastOkAt).getTime())/3600000 : null;
    if (okAt2 != null && okAt2 > 26) kinds2.add('business_stale');
    const alerts = Array.from(kinds2);
    const alertHtml = alerts.length
      ? alerts.map(k => '<li>' + (kinds[k] || k) + '</li>').join('')
      : '<li class=none>无告警</li>';
    const okFlag = alerts.length === 0;
    const html = '<!doctype html><html lang=zh-CN><head><meta charset=utf-8>' +
      '<meta name=viewport content="width=device-width,initial-scale=1"><title>云端签到助手</title>' +
      '<style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:8vh auto;padding:0 20px;line-height:1.6}' +
      '.card{border:1px solid #8884;border-radius:14px;padding:22px 24px}h1{font-size:1.25rem;margin:0 0 6px}' +
      '.st{display:inline-block;padding:2px 12px;border-radius:99px;font-size:.85rem;margin-bottom:14px}' +
      '.ok{background:#3a9c4a22;color:#2e7d3a}.warn{background:#d9822b22;color:#b05e12}' +
      'dl{margin:0;font-size:.92rem}dt{color:#888;margin-top:10px}dd{margin:0}' +
      'li.none{color:#2e7d3a;list-style:none;margin-left:-1.2em}</style></head><body><div class=card>' +
      '<h1>☁️ 云端签到助手</h1>' +
      '<span class="st ' + (okFlag?'ok':'warn') + '">' + (okFlag?'运行正常 · 无告警':'有告警，需查看') + '</span>' +
      '<dl><dt>已完成轮次</dt><dd>' + (st.tickCount||0) + '</dd>' +
      '<dt>最近一轮</dt><dd>' + lastTick + '</dd>' +
      '<dt>最近成功</dt><dd>' + lastOk + '</dd>' +
      '<dt>运行间隔</dt><dd>每 ' + TICK_MINUTES + ' 分钟一轮</dd></dl>' +
      '<p style=font-size:.85rem;color:#888>告警：' + (alerts.length?'<ul style=margin:6px 0>' + alertHtml + '</ul>':'<ul style=margin:6px 0>' + alertHtml + '</ul>') + '</p>' +
      '</div></body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (!authed(req, urlObj)) return send(401, { ok: false, msg: '未授权' });
  if (urlObj.pathname === '/probe' && req.method === 'GET') {
    // [deploy] 出网探测：验证云沙箱能否访问第三方平台域名（决定能否云端代签）
    const targets = [
      ['trae', 'https://api.trae.cn/cloudide/api/v3/common/GetUserToken', 'POST'],
      ['huawei', 'https://devcloud.cn-north-4.huaweicloud.com/chat/PromptCenterService/v1/ops/delivery?channel=WEB', 'GET'],
      ['qoder_cn', 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns', 'GET'],
      ['qoder_sh', 'https://openapi.qoder.sh/sash/api/v1/me/campaigns', 'GET'],
      ['github', 'https://codeload.github.com', 'GET'],
    ];
    void (async () => {
      const out = [];
      for (const [name, u, m] of targets) {
        const t0 = Date.now();
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 12000);
          const r = await fetch(u, { method: m, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: ctl.signal });
          clearTimeout(tm);
          const txt = await r.text().catch(() => '');
          out.push({ name, ok: true, status: r.status, ms: Date.now() - t0, sample: txt.slice(0, 80) });
        } catch (e) {
          const c = e && e.cause;
          out.push({ name, ok: false, ms: Date.now() - t0, err: String((c && (c.code || c.message)) || e.message || e).slice(0, 120) });
        }
      }
      send(200, { ok: true, probe: out });
    })();
    return;
  }
  if (urlObj.pathname === '/panel' && req.method === 'GET') {
    // [deploy] 积分领取看板：authed() 已校验 access_key；只读 state/config，无敏感令牌出街
    (async () => {
    const st = state();
    const today = cnDateStr();
    const sum = checkinSummary(st);   // 全平台汇总（WorkBuddy + Trae + …）
    const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    let doneN = 0, credit = 0, streak = 0, cats = 0;
    // 余额展示：只给"还剩多少"，总额不铺开（用户要的是清爽）
    const numFmt = (v) => (typeof v === 'number'
      ? (Number.isInteger(v) ? v.toLocaleString('en-US') : (Math.round(v * 10) / 10).toLocaleString('en-US'))
      : String(v));
    const fmtBal = (b) => (!b || b.remain == null ? '—' : numFmt(b.remain));
    const balOf = (pf, name) => ((st.bal || {})[pf] || {})[name] || null;
    const rows = CFG.accounts.map(a => {
      const v = (st.accounts || {})[a.name] || {};
      const c = v.checkin || {}, b = v.buddy || {};
      const isToday = c.day === today && c.done;
      if (isToday) { doneN++; credit += Number(c.credit) || 0; streak = Math.max(streak, Number(c.streak) || 0); }
      cats += Number(b.owned) || 0;
      const tokenD = daysLeft(a.expiresAt);
      const ck = isToday
        ? '<span class=ok>✓ 已领</span>'
        : (c.day === today && c.inactive ? '<span class=warn>⏳ 活动未开启（每轮重试）</span>'
          : c.day === today ? '<span class=warn>✗ ' + esc(c.note || '未领') + '</span>' : '<span class=warn>✗ 今日未领</span>');
      const cat = b.owned
        ? esc(b.owned) + ' 只' + (b.limitReached ? ' · 跑满' : ' · 在跑')
        : (b.note ? '<span class=warn>' + esc(b.note) + '</span>' : '未领养');
      return '<tr><td data-l="账号">' + esc(a.name) + '</td>' +
        '<td data-l="今日签到">' + ck + '</td>' +
        '<td data-l="积分">' + (isToday ? '+' + (c.credit || 0) : '—') + '</td>' +
        '<td data-l="余额">' + fmtBal(balOf('workbuddy', a.name)) + '</td>' +
        '<td data-l="连续">' + (isToday && c.streak ? c.streak + ' 天' : '—') + '</td>' +
        '<td data-l="猫猫">' + cat + '</td>' +
        '<td data-l="令牌">' + (tokenD != null ? tokenD + ' 天' : '—') + '</td></tr>';
    }).join('');
    const dl = CFG.accounts.map(x => daysLeft(x.expiresAt)).filter(x => x != null);
    const tokenMin = dl.length ? Math.min(...dl) : null;
    const logs = (LOG_RING || []).slice(-12).map(l => '<div class=lg>' + esc(l) + '</div>').join('');
    const bj = st.lastTickAt ? new Date(new Date(st.lastTickAt).getTime() + 8*3600*1000).toISOString().slice(5,16).replace('T',' ') : '—';
    const allOk = doneN === CFG.accounts.length && CFG.accounts.length > 0;
    // 云数据库：本月累计 + 最近事件。任何一步失败都只降级提示，绝不影响看板其余部分。
    let monthHtml = '', eventsHtml = '';
    try {
      if (CLOUD_DB) {
        const mStart = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7) + '-01T00:00:00+08:00';
        const m = await CLOUD_DB.database.from('wbmon_events').select('kind, account, created_at').gte('created_at', mStart).limit(1000);
        if (!m.error) {
          // 按「账号 × 北京时间日期」去重，而不是数行数：
          // 早期版本重复部署会重复写同一天同一账号，行数会虚高；这里保证口径恒定正确。
          // 平台归属由事件 kind 决定，卡片按 PLATFORMS 注册表动态生成——
          // 以前这里硬编码了 WorkBuddy/Trae 三张卡，加码道/Qoder 后就漏统计了。
          const KIND_PLATFORM = {
            checkin: 'workbuddy', wb_checkin: 'workbuddy',
            trae_checkin: 'trae', trae_fail: 'trae',
            codearts_checkin: 'codearts', codearts_auth: 'codearts', codearts_fail: 'codearts',
            qoder_checkin: 'qoder', qoder_fail: 'qoder', qoder_auth: 'qoder',
          };
          const cnt = Object.create(null);
          const seen = Object.create(null);
          // 只统计"当前配置里还在的账号"：账号改过名（如 Qoder主号 → Qoder·aliyun…）后，
          // 库里旧名字的行会被算成另一个号，把今日数字刷高。历史行保留，但不进当月口径。
          const LABELS = new Set(PLATFORMS.map(p => p.label));
          const valid = new Set();
          for (const p of PLATFORMS) {
            let arr = []; try { arr = p.accounts() || []; } catch { arr = []; }
            for (const a of arr) valid.add(p.key + '||' + a.name);
          }
          const acctName = (raw) => {
            const s = String(raw || '');
            const i = s.indexOf(':');
            if (i > 0 && LABELS.has(s.slice(0, i))) return s.slice(i + 1);
            return s;
          };
          (m.data || []).forEach(e => {
            const pf = KIND_PLATFORM[e.kind];
            if (!pf) return;
            const acct = acctName(e.account);
            if (!valid.has(pf + '||' + acct)) return;
            const d = e.created_at ? new Date(new Date(e.created_at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : '?';
            const k = e.kind + '|' + acct + '|' + d;
            if (seen[k]) return;
            seen[k] = 1;
            const b = cnt[pf] || (cnt[pf] = { ok: 0, bad: 0 });
            if (/checkin$/.test(e.kind)) b.ok++; else b.bad++;
          });
          let cards = '';
          for (const p of PLATFORMS) {
            let n = 0; try { n = (p.accounts() || []).length; } catch { n = 0; }
            if (!n) continue;                       // 没配这个平台就不挂空卡
            const b = cnt[p.key] || { ok: 0, bad: 0 };
            cards += '<div class=card><b>' + b.ok + '</b><span>' + esc(p.label) + ' 签到</span></div>';
            if (b.bad) cards += '<div class=card><b style="color:#b3474f">' + b.bad + '</b><span>' + esc(p.label) + ' 失败/待重导</span></div>';
          }
          monthHtml = '<h2>本月累计（云数据库）</h2><div class=cards>' +
            (cards || '<div class=lg>本月暂无签到记录</div>') + '</div>';
        } else log('看板-本月统计失败: ' + dbErrText(m.error));
        const ev = await CLOUD_DB.database.from('wbmon_events').select('account, kind, detail, created_at')
          .neq('kind', 'selftest').order('id', { ascending: false }).limit(12);
        if (!ev.error) {
          // 事件里存的账号形如 "Qoder:别名"/"码道:别名"，前缀与名字重复时只留名字
          const cleanAcct = (raw) => {
            const s = String(raw || '');
            const i = s.indexOf(':');
            if (i > 0) {
              const pre = s.slice(0, i), rest = s.slice(i + 1);
              if (rest.startsWith(pre)) return rest;
            }
            return s;
          };
          const er = (ev.data || []).map(e => {
            const ts = e.created_at ? new Date(new Date(e.created_at).getTime() + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ') : '—';
            return '<tr><td data-l="时间">' + ts + '</td><td data-l="账号">' + esc(cleanAcct(e.account)) + '</td><td data-l="类型">' + esc(e.kind) + '</td><td data-l="详情">' + esc(String(e.detail || '').slice(0, 42)) + '</td></tr>';
          }).join('');
          eventsHtml = '<h2>最近事件（云数据库）</h2><table><tr><th>时间</th><th>账号</th><th>类型</th><th>详情</th></tr>' + (er || '<tr><td colspan=4>暂无</td></tr>') + '</table>';
        } else log('看板-最近事件失败: ' + dbErrText(ev.error));
      } else {
        eventsHtml = '<h2>最近事件</h2><div class=lg>云数据库未接入；当前只保留当天状态，历史不留存</div>';
      }
    } catch (e) { try { log('看板云库区块异常：' + (e && e.message || e)); } catch (_) {} }
    const html = '<!doctype html><html lang=zh-CN><head><meta charset=utf-8>' +
      '<meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv=refresh content="60">' +
      '<title>云端签到 · 积分看板</title><style>' +
      ':root{color-scheme:light}body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:6vh auto;padding:0 18px;line-height:1.6;color:#4a3f3c;background:#faf6f2}' +
      'h1{font-size:1.2rem;margin:0 0 4px;color:#8a5a68}.sub{font-size:.8rem;color:#a08a80;margin-bottom:16px}' +
      '.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}.card{flex:1;min-width:140px;background:#fff;border:1px solid #e8ddd6;border-radius:12px;padding:12px 16px}' +
      '.card b{display:block;font-size:1.3rem;color:#8a5a68}.card span{font-size:.78rem;color:#a08a80}' +
      'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8ddd6;border-radius:12px;overflow:hidden;font-size:.86rem}' +
      'th{background:#f5ebe4;color:#8a5a68;font-weight:600;padding:8px 10px;text-align:left}td{padding:8px 10px;border-top:1px solid #f2e9e2}' +
      '.ok{color:#3a8a52}.warn{color:#b05e12}.lg{font-size:.72rem;color:#9c8a82;font-family:ui-monospace,monospace;padding:2px 0;border-bottom:1px dashed #efe5dd}' +
      '.brief{font-size:.78rem;color:#8a7d76;margin:-6px 0 14px}' +
      'h2{font-size:.95rem;color:#8a5a68;margin:20px 0 8px}' +
      // 移动端：表格改成"每个账号一块卡片"（标签在左、值在右），彻底不横向滚动
      '@media (max-width:640px){' +
      'html,body{max-width:100%;overflow-x:hidden}' +
      'body{margin:14px auto;padding:0 12px}' +
      'textarea,input,pre,code{max-width:100%;box-sizing:border-box}' +
      'h1{font-size:1.05rem}.sub{font-size:.74rem;margin-bottom:12px}' +
      '.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px}' +
      '.card{min-width:0;padding:10px 12px;border-radius:10px}' +
      '.card b{font-size:1.05rem}.card span{font-size:.7rem}' +
      'table{border:0;background:none;border-radius:0;font-size:.82rem}' +
      'th{display:none}' +
      'tr{display:block;background:#fff;border:1px solid #e8ddd6;border-radius:12px;margin:0 0 10px;padding:8px 12px 10px}' +
      'td{display:flex;align-items:baseline;gap:10px;border:0;padding:3px 0;text-align:right;min-width:0;word-break:break-word}' +
      'td::before{content:attr(data-l);color:#a08a80;font-size:.73rem;font-weight:400;text-align:left;margin-right:auto;flex:0 0 auto}' +
      'td:first-child{display:block;font-weight:600;color:#5d4f49;font-size:.9rem;text-align:left;padding:2px 0 7px;border-bottom:1px dashed #f2e9e2;margin-bottom:3px;word-break:break-word}' +
      'td:first-child::before{content:""}' +
      '.brief{font-size:.73rem;margin:-2px 0 12px}' +
      '.lg{font-size:.68rem;word-break:break-word;overflow-wrap:anywhere}' +
      'h2{font-size:.88rem;margin:16px 0 6px}' +
      '}' +
      '</style></head><body>' +
      '<h1>☁️ 云端签到 · 积分看板</h1><div class=sub>每 60 秒自动刷新 · 最近一轮 ' + bj + '（北京时间） · 云数据库 ' +
      (CLOUD_DB ? (CLOUD_OK ? '已接入 ✓' : '已初始化（自检未完成）') : '未接入') + '</div>' +
      '<div class=cards>' +
      '<div class=card><b class="' + (sum.pending === 0 ? 'ok' : 'warn') + '">' + sum.done + '/' + sum.total + '</b><span>今日签到（全平台）</span></div>' +
      '<div class=card><b>+' + credit + '</b><span>今日签到积分</span></div>' +
      '<div class=card><b>' + cats + '</b><span>猫猫总数</span></div>' +
      '<div class=card><b>' + (tokenMin != null ? tokenMin + ' 天' : '—') + '</b><span>令牌最短剩余</span></div>' +
      '</div>' +
      '<div class=brief>分平台：' + esc(platformBrief(sum) || '暂无账号') + '</div>' +
      // 首次使用：一个账号都没配时给明确指引，而不是留一片空白
      (sum.total === 0
        ? '<div class=card style="margin:0 0 16px"><b style="font-size:.95rem;color:#8a5a68">还没有配置任何账号</b>' +
          '<span>编辑 config.json 的 accounts（WorkBuddy）/ trae.accounts / codearts.accounts / qoder.accounts，' +
          '或跑 <code>node scripts/magpie-auth.mjs --login all</code> 自动导入；保存后重启生效。</span></div>'
        : '') +
      '<div class=brief>余额（Credits，只给剩余）：' + (function () {
        const agg = (pf, arr) => {
          let r = 0, n = 0;
          for (const a of arr) {
            const b = balOf(pf, a.name);
            if (!b || typeof b.remain !== 'number') continue;
            r += b.remain; n++;
          }
          return n ? numFmt(Math.round(r * 10) / 10) : '';
        };
        const parts = [];
        const w = agg('workbuddy', CFG.accounts || []); if (w) parts.push('WorkBuddy ' + w);
        const tr = agg('trae', (CFG.trae && CFG.trae.accounts) || []); if (tr) parts.push('Trae ' + tr);
        let q = 0, qn = 0;
        for (const a of ((CFG.qoder && CFG.qoder.accounts) || [])) {
          const rec = (st.qoder || {})[a.name] || {};
          if (typeof rec.balance === 'number') { q += rec.balance; qn++; }
        }
        if (qn) parts.push('Qoder ' + numFmt(q));
        return esc(parts.join(' · ') || '暂未取到');
      })() + '</div>' +
      '<table><tr><th>账号</th><th>今日签到</th><th>积分</th><th>余额</th><th>连续</th><th>猫猫</th><th>令牌</th></tr>' + rows + '</table>' +
      (function () {
        try {
        const tl2 = (CFG.trae && CFG.trae.accounts) || [];
        if (!tl2.length) return '';
        const rows2 = tl2.map(a => {
          const r = (st.trae || {})[a.name] || {};
          const done = r.day === today && r.outcome === 'claimed';
          const busy = r.day === today && r.outcome === 'device_busy';
          const noDev = r.day === today && r.outcome === 'no_device';
          const cell = done
            ? '<span class=ok>✓ 已领 +' + ((Number(r.credit) || 0) + (Number(r.extra) || 0)) + '</span>'
            : busy
              ? '<span class=w' + 'arn>⇄ 设备名额已占（明日自动重试）</span>'
              : noDev
                ? '<span class=w' + 'arn>⚠ 无可信设备（需在客户端登录该号）</span>'
                : '<span class=w' + 'arn>✗ ' + esc(r.note || '今日未领') + '</span>';
          const exp = a.expires ? daysLeft(a.expires) : null;
          return '<tr><td data-l="账号">' + esc(a.name) + '</td><td data-l="今日签到">' + cell + '</td><td data-l="余额">' + fmtBal(balOf('trae', a.name)) + '</td><td data-l="令牌">' + (exp != null ? exp + ' 天' : '—') + '</td></tr>';
        }).join('');
        return '<h2>Trae CN</h2><table><tr><th>账号</th><th>今日签到</th><th>余额</th><th>令牌</th></tr>' + rows2 + '</table>';
        } catch (e) { try { log('看板 Trae 段渲染失败：' + (e && e.message || e)); } catch (_) {} return '<h2>Trae CN</h2><div class=lg>该段渲染失败：' + String((e && e.message) || e) + '</div>'; }
      })() +
      // 码道：专属表格 + 会话 Cookie 更新入口（凭据是人给的，界面就得给回填的地方）
      (function () {
        try {
          const hl = (CFG.codearts && CFG.codearts.accounts) || [];
          if (!hl.length) return '';
          const rows3 = hl.map(a => {
            const r = (st.codearts || {})[a.name] || {};
            const done = r.day === today && r.outcome === 'claimed';
            const cell = done
              ? '<span class=ok>✓ 已签' + ((Number(r.credit) || 0) ? ' +' + r.credit : '') + '</span>'
              : r.outcome === 'nocookie' ? '<span class=w' + 'arn>🔑 未配置 Cookie</span>'
              : r.outcome === 'needauth' ? '<span class=w' + 'arn>🔑 会话失效，需重导</span>'
              : r.day === today ? '<span class=w' + 'arn>✗ ' + esc(r.note || '今日未签') + '</span>'
              : '<span class=w' + 'arn>⏳ 今日尚未运行</span>';
            const at = a.sessionOkAt ? String(a.sessionOkAt).replace('T', ' ').slice(5, 16) : '—';
            const stale = a.sessionOkAt && (Date.now() - new Date(a.sessionOkAt).getTime()) > 2 * 3600000;
            const touched = a.cookieTouchedAt ? String(a.cookieTouchedAt).replace('T', ' ').slice(5, 16) : '—';
            return '<tr><td data-l="账号">' + esc(a.name) + '</td><td data-l="今日签到">' + cell + '</td><td data-l="会话最近可用">' + (stale ? '<span class=warn>' + at + '</span>' : at) + '</td><td data-l="Cookie 变动">' + touched + '</td></tr>';
          }).join('');
          const first = (hl[0] && hl[0].name) || '';
          return '<h2>码道（华为 CodeArts）</h2>' +
            '<table><tr><th>账号</th><th>今日签到</th><th>会话最近可用</th><th>Cookie 变动</th></tr>' + rows3 + '</table>' +
            '<div class=lg style="margin-top:8px">实测（2026-10-29）：这个会话约 1~2 小时就失效，而且<b>云端纯接口轮询续不住</b>' +
            '（响应不换发新的 J_SESSION_ID，续期要靠已登录浏览器里的 SSO cookie）。<br>' +
            '所以日常节奏是：看到本行变成 🔑 或战报提示「待重导凭据」时，浏览器登录 ' +
            '<b>devcloud.cn-north-4.huaweicloud.com/chat/home</b> → F12 → Network → 任一 PromptCenterService 请求 → ' +
            '复制 Request Headers 里的 <b>cookie:</b> 整行（含 ' + HW_COOKIE_KEY + ' 与 devclouddevuibjtcftk）粘到下面。' +
            '<b>保存即实测、当天立刻补签</b>，不用等下一轮。</div>' +
            '<div class=lg>余额：码道的积分要华为云 IAM 签名（AK/SK+DPoP）才读得到，云端只有 web 会话 Cookie，' +
            '所以这张表不显示余额；要看积分请到码道自己的用量页。</div>' +
            '<div style="margin:8px 0"><textarea id=hwck placeholder="devclouddevuibjJ_SESSION_ID=...; devclouddevuibjtcftk=..." ' +
            'style="width:100%;height:64px;font-family:ui-monospace,monospace;font-size:.75rem;padding:8px;border:1px solid #e8ddd6;border-radius:8px;background:#fff;color:#4a3f3c"></textarea>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">' +
            '<button id=hwbtn type=button style="padding:8px 16px;border:0;border-radius:8px;background:#8a5a68;color:#fff;font-size:.85rem;cursor:pointer">保存并验证</button>' +
            '<span id=hwmsg style="font-size:.78rem;color:#a08a80"></span></div></div>' +
            '<script>(function(){' +
            // 面板原本 60 秒整页刷新：粘贴长 Cookie 时会把输入冲掉，改成"输入框有内容就不刷"
            'var mr=document.querySelector("meta[http-equiv=refresh]");if(mr)mr.remove();' +
            'setInterval(function(){var t2=document.getElementById("hwck");if(!t2||!t2.value)location.reload();},60000);' +
            'var b=document.getElementById("hwbtn"),t=document.getElementById("hwck"),m=document.getElementById("hwmsg");' +
            'if(!b)return;b.onclick=function(){var v=(t.value||"").trim();if(!v){m.textContent="先粘贴 Cookie";return;}' +
            'm.textContent="验证中…";b.disabled=true;' +
            // 必须带上页面现有的 key + sharecode：平台网关对不带 sharecode 的 POST 直接拦掉
            'var u="codearts-cookie?"+new URLSearchParams(location.search).toString();' +
            'fetch(u,' +
            '{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cookie:v,account:' + JSON.stringify(first) + '})})' +
            '.then(function(r){return r.text()}).then(function(x){var j={};try{j=JSON.parse(x)}catch(e){}' +
            'if(j.verified){m.textContent="✓ 已保存："+(j.note||"登录态有效")+"，3 秒后刷新";setTimeout(function(){location.reload()},3000);}' +
            'else{m.textContent="✗ "+(j.error||x||"验证失败");b.disabled=false;}})' +
            '.catch(function(e){m.textContent="✗ "+e.message;b.disabled=false;});};})();</script>';
        } catch (e) { return '<h2>码道</h2><div class=lg>该段渲染失败：' + String((e && e.message) || e) + '</div>'; }
      })() +
      // Qoder：专属表格 + 凭据更新入口（token/指纹都是本机出的，界面就得给回填的地方）
      (function () {
        try {
          const ql = (CFG.qoder && CFG.qoder.accounts) || [];
          if (!ql.length) return '';
          const rows4 = ql.map(a => {
            const r = (st.qoder || {})[a.name] || {};
            const done = r.day === today && r.outcome === 'claimed';
            const cell = done
              ? '<span class=ok>✓ 已领' + ((Number(r.credit) || 0) ? ' +' + r.credit : '') + '</span>'
              : r.outcome === 'nocred' || r.outcome === 'token_expired'
                ? '<span class=w' + 'arn>🔑 ' + esc(r.note || '凭据失效，需重导') + '</span>'
                : r.day === today ? '<span class=w' + 'arn>✗ ' + esc(r.note || '今日未领') + '</span>'
                : '<span class=w' + 'arn>⏳ 今日尚未运行（10:05 后自动领取）</span>';
            const exp = a.tokenExpiresAt ? daysLeft(new Date(a.tokenExpiresAt).getTime()) : null;
            const bal = r.balance != null ? String(r.balance) : '—';   // 与 WB/Trae 一致：只给剩余数字
            return '<tr><td data-l="账号">' + esc(a.name) + '</td><td data-l="今日领取">' + cell + '</td><td data-l="余额">' + bal + '</td><td data-l="令牌">' + (exp != null && exp >= 0 ? exp.toFixed(1) + ' 天' : '—') + '</td></tr>';
          }).join('');
          const first = (ql[0] && ql[0].name) || '';
          return '<h2>Qoder</h2>' +
            '<table><tr><th>账号</th><th>今日领取</th><th>余额</th><th>令牌</th></tr>' + rows4 + '</table>' +
            '<div class=lg style="margin-top:8px">凭据来源＝本机 <b>magpie</b> 插件（<code>~/.config/magpie/plugin-auth.json</code> 里的 <code>qoder-cn*</code>）：' +
            '云端只借 <b>access</b>（dt- token）和<b>该账号自己的 machineId</b>，按 magpie 的登录逻辑发请求，绝不刷新 refresh（会跟 magpie 抢设备链）。<br>' +
            '换号 / 失效：电脑上跑一次 <b>node scripts/magpie-auth.mjs --login qoder-cn</b>，浏览器点一下授权就自动取到并推送。' +
            '本页不提供手工粘贴入口。</div>';
        } catch (e) { return '<h2>Qoder</h2><div class=lg>该段渲染失败：' + String((e && e.message) || e) + '</div>'; }
      })() +
      // 新平台若还没有专属表格，这里按注册表自动生成一张通用表 —— 加平台不必改看板
      (function () {
        try {
          const bespoke = { workbuddy: 1, trae: 1, codearts: 1, qoder: 1 };
          return PLATFORMS.filter(p => !bespoke[p.key]).map(p => {
            const rs = sum.rows.filter(r => r.platform === p.key);
            if (!rs.length) return '';
            const body = rs.map(r => {
              const cell = r.done
                ? '<span class=ok>✓ 已领' + (r.credit ? ' +' + r.credit : '') + '</span>'
                : r.state === 'needauth'
                  ? '<span class=w' + 'arn>🔑 ' + esc(r.note || '会话失效，需重新导入 Cookie') + '</span>'
                  : r.state === 'busy' || r.state === 'nodev'
                    ? '<span class=w' + 'arn>⇄ ' + esc(r.note || '受限，次日自动重试') + '</span>'
                    : '<span class=w' + 'arn>✗ ' + esc(r.note || '今日未领') + '</span>';
              return '<tr><td>' + esc(r.name) + '</td><td>' + cell + '</td></tr>';
            }).join('');
            return '<h2>' + esc(p.label) + '</h2><table><tr><th>账号</th><th>今日签到</th></tr>' + body + '</table>';
          }).join('');
        } catch (e) { return ''; }
      })() +
      monthHtml + eventsHtml +
      '<h2>最近日志</h2>' + (logs || '<div class=lg>暂无</div>') +
      '</body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    })().catch(e => { try { log('看板渲染异常：' + (e && e.message || e)); } catch (_) {} try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('看板渲染异常'); } catch (_) {} });
    return;
  }

  // 一行战报：给云端心跳当"推送内容"用。纯文本，手机上一眼看完。
  if (urlObj.pathname === '/digest') {
    const st = state();
    const today = cnDateStr();
    const sum = checkinSummary(st);            // 全平台：WorkBuddy + Trae + …
    const miss = sum.rows.filter(r => !r.done);
    const SOFT = { busy: 1, nodev: 1, needauth: 1 };   // 受限而非失败（设备名额/设备绑定/会话需人工重导）
    const softMiss = miss.filter(r => SOFT[r.state]);
    const hardMiss = miss.filter(r => !SOFT[r.state]);
    // WorkBuddy 侧的附加信息（积分/连续/猫猫/令牌）——与签到完成度解耦
    let credit = 0, streak = 0, cats = 0, limited = 0, noAdopt = 0, withCats = 0;
    for (const a of CFG.accounts) {
      const v = (st.accounts || {})[a.name] || {};
      const c = v.checkin || {}, b = v.buddy || {};
      if (c.day === today && c.done) {
        credit += Number(c.credit) || 0;
        streak = Math.max(streak, Number(c.streak) || 0);
      }
      cats += Number(b.owned) || 0;
      if (b.owned) { withCats++; if (b.limitReached) limited++; } else noAdopt++;
    }
    const dl = CFG.accounts.map(x => daysLeft(x.expiresAt)).filter(x => x != null);
    const tokenDays = dl.length ? Math.min(...dl) : null;
    const bits = [];
    bits.push(`签到 ${sum.done}/${sum.total}`
      + (hardMiss.length ? '，缺 ' + hardMiss.map(r => r.name).join('、')
        : softMiss.length ? `（另 ${softMiss.length} 个受限）`
          : ' 全成' + (credit ? ` +${credit}` : ''))
      + (streak ? `（连续 ${streak} 天）` : ''));
    bits.push(platformBrief(sum));
    if (cats) bits.push(`猫猫 ${cats} 只${withCats > 0 && limited >= withCats ? '已跑满' : '在跑'}`);
    if (noAdopt) bits.push(`${noAdopt} 个号未领养`);
    if (tokenDays != null) bits.push(`令牌剩 ${tokenDays} 天`);
    if (softMiss.length) bits.push(softMiss.map(r => r.name + '·' + (r.state === 'busy' ? '名额占' : r.state === 'nodev' ? '无设备' : '待重导凭据')).join('、'));
    const tl = (CFG.trae && CFG.trae.accounts) || [];
    const tExp = tl.map(x => daysLeft(x.expires)).filter(v => v != null);
    if (tExp.length) bits.push('Trae令牌剩 ' + Math.min.apply(null, tExp) + ' 天');
    const hhmm = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
    const head = hardMiss.length ? '⚠️ ' : (softMiss.length ? '🕐 ' : '✅ ');
    const needAuthMiss = softMiss.filter(r => r.state === 'needauth');
    const devMiss = softMiss.length - needAuthMiss.length;
    const tail = hardMiss.length ? '有号没签上'
      : (needAuthMiss.length && devMiss) ? '有号待重导凭据 + 部分受设备限制'
      : needAuthMiss.length ? '有号待重新导入凭据（HttpOnly 会话，云端无法自愈）'
      : (softMiss.length ? '部分号受设备限制，明日重试' : '正常');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`${head}${today} ${hhmm}｜${bits.join(' · ')} · ${tail}`);
  }
  if (urlObj.pathname === '/status') {
    return send(200, { ok: true, now: new Date().toISOString(), state: state() });
  }
  if (urlObj.pathname === '/log') {
    return send(200, { ok: true, log: LOG_RING.slice(-100) });
  }
  if (urlObj.pathname === '/history') {
    // 云数据库中的运行历史（签到/领奖/派出事件），insert-only 审计表
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || 50), 1), 200);
    (async () => {
      if (!CLOUD_DB) return { ok: true, source: 'cloud-db-unavailable', events: [] };
      const r = await CLOUD_DB.database.from('wbmon_events')
        .select('id, account, kind, detail, created_at')
        .neq('kind', 'selftest')
        .order('id', { ascending: false })
        .limit(limit);
      if (r.error) return { ok: false, err: String((r.error && r.error.message) || r.error).slice(0, 200) };
      return { ok: true, source: 'cloud-db', count: (r.data || []).length, events: r.data };
    })().then(r => send(r.ok ? 200 : 500, r)).catch(e => send(500, { ok: false, err: String(e) }));
    return;
  }
  if (false && urlObj.pathname === '/tokens') {  // [deploy] 公网环境下关闭：无人需要从公网拉 access token
    // 供本机 bridge 同步：只下发 access 令牌（不含 refresh）
    return send(200, {
      ok: true, now: Date.now(),
      tokens: CFG.accounts.map(a => ({ name: a.name, uid: a.uid, accessToken: a.accessToken, expiresAt: a.expiresAt })),
    });
  }
  if (false && urlObj.pathname === '/config') {  // [deploy] 公网环境下关闭：该端点会返回含 refresh 的完整配置
    // 完整配置导出（含 refresh 令牌）——仅用于"重新部署前回拉最新令牌链"，请勿外传
    return send(200, { ok: true, config: CFG });
  }
  if (urlObj.pathname === '/tick' && req.method === 'POST') {
    tick().then(() => send(200, { ok: true, msg: '已执行一轮', state: state() })).catch(e => send(500, { ok: false, err: String(e) }));
    return;
  }
  if (urlObj.pathname === '/refresh' && req.method === 'POST') {
    const force = urlObj.searchParams.get('force') === '1';
    if (force) {
      (async () => {
        const results = [];
        for (const a of CFG.accounts) {
          try { results.push({ name: a.name, ok: await refreshAccountToken(a) }); }
          catch (e) { results.push({ name: a.name, ok: false, err: String(e.message) }); }
        }
        return { ok: true, forced: true, results, tokens: CFG.accounts.map(a => ({ name: a.name, daysLeft: daysLeft(a.expiresAt), refreshDaysLeft: daysLeft(a.refreshExpiresAt) })) };
      })().then(r => send(200, r)).catch(e => send(500, { ok: false, err: String(e) }));
      return;
    }
    ensureTokens().then(() => send(200, { ok: true, msg: '续期检查完成' })).catch(e => send(500, { ok: false, err: String(e) }));
    return;
  }
  send(404, { ok: false });
});

// 进程级兜底：任何一个请求路径抛异常（如看板渲染写错变量名）都不许把整个服务带崩，
// 否则定时任务、签到、续期会一起停摆。只记录，不退出。
process.on('uncaughtException', e => { try { log('未捕获异常（已兜住，服务继续）：' + (e && e.stack || e)); } catch (_) {} });
process.on('unhandledRejection', e => { try { log('未处理拒绝（已兜住，服务继续）：' + (e && e.stack || e)); } catch (_) {} });

loadCfg();
initCloudDb();
// 监听失败必须快速失败：EADDRINUSE / EACCES 这类错误如果冒到下面的
// uncaughtException，进程会「活着但根本没在监听」——调用方（selftest、部署健康检查）
// 只能等到超时，比直接崩掉更难查。所以这里显式接住并 exit 1。
server.on('error', e => {
  try { log('HTTP 服务启动失败：' + ((e && e.code) || '') + ' ' + ((e && e.message) || e)); } catch (_) { /* 日志落盘失败也不能掩盖退出 */ }
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const sm0 = checkinSummary(state());
  // PORT=0 时由内核分配空闲端口，此时真实端口只能从 address() 取；
  // 打日志用真实端口，PORT 有值时行为不变（两者相等）。
  const addr = server.address();
  const realPort = (addr && addr.port) || PORT;
  log('wbmon-cloud 已启动，端口 ' + realPort + '，账号 ' + sm0.total + ' 个（' + platformBrief(sm0) + '）');
  log('云数据库（BaaS）：' + (CLOUD_DB ? '已接入，运行历史将落库' : '未接入（' + (CLOUD_ERR || '未知原因') + '），仅本地日志'));
  dbSelfTest().then(ok => { CLOUD_OK = ok; }).catch(() => {});
  // 演示/截图模式：NO_START_TICK=1 时不在启动时立刻跑一轮，
  // 便于用预置的 state.json 渲染看板（不会去打任何平台接口）
  if (!process.env.NO_START_TICK) tick().catch(e => log('首次tick异常: ' + e.message));
  else log('NO_START_TICK=1：跳过首轮（仅渲染看板/接口）');
  schedule();
});

/* ============================================================================
 * 扩展指南（展示与执行是分开的两层，互不影响）
 * ----------------------------------------------------------------------------
 * 1) 只是加一个账号（同平台）
 *    → 往 config.json 对应数组里加一条即可，本文件不用改：
 *        WorkBuddy：config.accounts[]
 *        Trae     ：config.trae.accounts[]
 *      今日签到、看板、/health、/digest 会自动从 N/N 变成 N+1/N+1。
 *
 *      现成平台：WorkBuddy（config.accounts[]）/ Trae（config.trae.accounts[]）
 *                / 码道（config.codearts.accounts[]，需 cookie 字段）
 *
 *      码道账号的最小形状：
 *        { "name": "码道-主号", "cookie": "devclouddevuibjJ_SESSION_ID=...; devclouddevuibjtcftk=..." }
 *      cookie 是 HttpOnly 的会话票据，只能从浏览器（已登录华为云）DevTools 导出；
 *      服务端每轮会把响应里的 Set-Cookie 合并回去续期，断供才会落到 needauth。
 *
 * 2) 接入一个新平台（既要在汇总里出现，也要真去签到）
 *    a. 展示层：在 PLATFORMS 数组里加一个对象（accounts + status 两个方法），
 *       入口页的「今日签到 X/Y」、看板的「分平台」摘要、通用表格、
 *       /health 的 checkin 字段、/digest 战报会同时生效，无需改其它代码。
 *    b. 执行层：写一个 xxxRound(st) 异步函数（参考 traeRound），
 *       在 tick() 里 await 调用，把结果写进 st.<平台>[账号名] = { day, outcome, credit, ... }。
 *    c. 若有专属列（比如 Trae 的令牌天数列），再在看板里加一张专属表，
 *       并把该平台 key 加进 bespoke 白名单；不加就走通用表，也不会漏。
 *
 * 3) status() 必须返回的字段
 *      { done:boolean, credit:number, streak:number,
 *        state:'ok'|'fail'|'pending'|'busy'|'nodev'|'needauth', note:string }
 *    busy / nodev / needauth 会被视作「受限而非失败」，战报不会误报为 ⚠️。
 *    needauth＝凭据必须人工重导（如码道 HttpOnly 会话），服务端无权自愈。
 *
 * 4) 示例（Qoder，未启用，复制到 PLATFORMS 里改配置即可）：
 *
 *    {
 *      key: 'qoder',
 *      label: 'Qoder',
 *      accounts: () => (CFG && CFG.qoder && CFG.qoder.accounts) || [],
 *      status(st, a, today) {
 *        const r = ((st.qoder || {})[a.name]) || {};
 *        const done = r.day === today && r.outcome === 'claimed';
 *        return {
 *          done,
 *          credit: done ? Number(r.credit) || 0 : 0,
 *          streak: done ? Number(r.streak) || 0 : 0,
 *          state: done ? 'ok' : (r.day === today ? 'fail' : 'pending'),
 *          note: r.note || '',
 *        };
 *      },
 *    }
 * ========================================================================== */
