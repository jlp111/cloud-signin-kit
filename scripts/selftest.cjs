#!/usr/bin/env node
// 自检：不依赖任何真实凭据、不访问任何外部平台。
//   阶段 1：零账号实例 —— 能启动、能响应、看板能渲染、鉴权矩阵生效。
//   阶段 2：单假账号实例（NO_START_TICK=1，只渲染不跑网络）—— 校验
//           ① 未鉴权的 /health 不得出现账号名；② 带 key 的 /health 必须给逐账号 rows；
//           ③ 看板 WB 表已删掉「成长任务」假信号列。
// 用法：node scripts/selftest.cjs        （CI 里三个 Node 版本都跑）
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-selftest-'));
const KEY = 'selftest-' + Math.random().toString(36).slice(2, 10);
const SENTINEL = 'SENTINEL-ACCT-' + Math.random().toString(36).slice(2, 8);
const START_TIMEOUT_MS = 15000;          // 等启动日志（真实端口）的上限
const STARTED_RE = /已启动，端口\s*(\d+)/;

const children = [];
function log(s) { process.stdout.write('[selftest] ' + s + '\n'); }
function cleanup(code) {
  for (const c of children) { try { if (c && !c.killed) c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录可能已删 */ }
  process.exit(code);
}
function fail(s) { log('✗ ' + s); cleanup(1); }

// 端口交给内核分配（子进程 PORT=0）：此前"先探测端口是否空闲，再让子进程去 bind"
// 有两个必踩的坑 —— ① 探测绑 127.0.0.1、实际绑 0.0.0.0，地址不同结论无效；
// ② 上阶段的连接在 18080 上留下 TIME_WAIT，Windows 下紧接着 bind 同端口直接 EADDRINUSE。
// 让内核分配，既没有竞态，也不再需要"端口被占就换一个"的自增逻辑。
const sleep = ms => new Promise(r => setTimeout(r, ms));

function baseCfg() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  cfg.access_key = KEY;
  cfg.accounts = [];
  cfg.trae = Object.assign({}, cfg.trae, { accounts: [] });
  cfg.codearts = Object.assign({}, cfg.codearts, { accounts: [] });
  cfg.qoder = Object.assign({}, cfg.qoder, { accounts: [] });
  cfg.cloud = {};
  return cfg;
}

function startServer(tag, cfg, state) {
  const cfgPath = path.join(TMP, tag + '-config.json');
  const statePath = path.join(TMP, tag + '-state.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  if (state) fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: '0',                   // 0 = 交给内核挑空闲端口，避免 TIME_WAIT 竞态
      ACCESS_KEY: KEY,
      CONFIG_PATH: cfgPath,
      STATE_PATH: statePath,
      LOG_FILE: path.join(TMP, tag + '-run.log'),
      TICK_MINUTES: '600',
      BUDDY_MINUTES: '600',
      NO_START_TICK: '1',          // 只渲染，不打任何平台接口
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ph = { child, buf: '', exitCode: null };
  child.stdout.on('data', d => { ph.buf += String(d); });
  child.stderr.on('data', d => { ph.buf += String(d); });
  child.on('exit', c => { ph.exitCode = c; if (c !== null && c !== 0) log('进程提前退出，code=' + c + '\n' + tail(ph.buf)); });
  children.push(child);
  return ph;
}

function tail(s) { return String(s || '').slice(-800); }

async function get(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p);
  const t = await r.text();
  return { status: r.status, text: t };
}
// 从子进程输出里等"已启动，端口 N"，拿到真实端口再发请求；超时/提前退出都快速失败。
async function waitPort(ph, tag) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const m = STARTED_RE.exec(ph.buf);
    if (m) return Number(m[1]);
    if (ph.exitCode !== null) fail(tag + ' 实例在开始监听前退出，code=' + ph.exitCode + '；输出：\n' + tail(ph.buf));
    if (Date.now() > deadline) fail(tag + ' 实例 ' + (START_TIMEOUT_MS / 1000) + ' 秒内没给出启动日志（端口未分配）；输出：\n' + tail(ph.buf));
    await sleep(50);
  }
}
async function waitHealth(port, ph) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await get(port, '/health');
      if (r.status === 200) return JSON.parse(r.text);
    } catch { /* 还没起来 */ }
  }
  fail('20 秒内 /health 无响应；日志：\n' + tail(ph.buf));
  return null;
}
function stopPhase(ph) { try { ph.child.kill('SIGKILL'); } catch { /* 已退出 */ } }

(async () => {
  // ======================= 阶段 1：零账号 =======================
  const p1 = startServer('phase1', baseCfg(), null);
  const port1 = await waitPort(p1, '阶段 1');
  log('阶段 1：零账号实例，端口 ' + port1);
  const health = await waitHealth(port1, p1);
  if (health.ok !== true) fail('/health.ok 不是 true：' + JSON.stringify(health).slice(0, 200));
  log('✓ /health 200, ok=true, 账号数 ' + health.checkin.total);
  if (health.checkin.total !== 0) fail('零账号实例的 checkin.total 应为 0');
  if (health.tickMinutes !== 600) fail('/health.tickMinutes 应回显 TICK_MINUTES=600，实际 ' + health.tickMinutes);

  const noKey = await get(port1, '/status');
  if (noKey.status !== 401) fail('/status 不带 key 应返回 401，实际 ' + noKey.status);
  log('✓ /status 未授权时 401');

  // 鉴权矩阵：所有数据端点未授权都必须 401（别再只测 /status 一个）
  for (const ep of ['/panel', '/log', '/digest', '/history', '/probe']) {
    const r = await get(port1, ep);
    if (r.status !== 401) fail(ep + ' 未授权应 401，实际 ' + r.status);
  }
  log('✓ 数据端点未授权一律 401（/panel /log /digest /history /probe）');

  const panel = await get(port1, '/panel?key=' + encodeURIComponent(KEY));
  if (panel.status !== 200) fail('/panel 状态 ' + panel.status);
  if (!panel.text.includes('积分看板')) fail('/panel 内容缺标题');
  if (!panel.text.includes('max-width:640px')) fail('/panel 缺移动端媒体查询');
  if (!panel.text.includes('还没有配置任何账号')) fail('/panel 缺空状态提示');
  if (panel.text.includes('data-l="成长任务"')) fail('/panel 仍有「成长任务」列（假信号应已删除）');
  log('✓ /panel 200（标题 / 移动端样式 / 空状态提示都在，成长任务列已删除）');

  const idx = await get(port1, '/index.html');
  if (idx.status !== 200 || !idx.text.includes('云端签到助手')) fail('/index.html 异常：' + idx.status);
  log('✓ /index.html 200');

  const digest = await get(port1, '/digest?key=' + encodeURIComponent(KEY));
  if (digest.status !== 200) fail('/digest 状态 ' + digest.status);
  log('✓ /digest 200');

  // 超大 body 不应把连接直接打断（应给出 4xx 状态码，而不是 ECONNRESET）
  const big = await fetch('http://127.0.0.1:' + port1 + '/codearts-cookie?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: 'x'.repeat(30000) }),
  }).then(r => r.status).catch(() => -1);
  if (big < 400 || big >= 500) fail('超大 body 应返回 4xx（如 413），实际 ' + big);
  log('✓ 超大 body 返回 ' + big);

  stopPhase(p1);
  // 端口不再复用：阶段 2 用内核重新分配的端口，不必等上一个实例的端口"变成可绑定"。

  // ======================= 阶段 2：单假账号 =======================
  const now = new Date().toISOString();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const cfg2 = baseCfg();
  cfg2.accounts = [{ name: SENTINEL, uid: 'uid-' + SENTINEL, accessToken: 'fake-token-never-used', expiresAt: Date.now() + 30 * 86400000 }];
  const state2 = {
    tickCount: 42, lastTickAt: now, lastOkAt: now,
    accounts: { [SENTINEL]: { checkin: { day: today, done: true, credit: 100, streak: 3 } } },
    bal: { workbuddy: { [SENTINEL]: { remain: 1234.5, total: 2000, unit: 'credits', at: now } }, trae: {}, at: now },
  };
  const p2 = startServer('phase2', cfg2, state2);
  const port2 = await waitPort(p2, '阶段 2');
  log('阶段 2：单假账号实例（' + SENTINEL + '），端口 ' + port2);
  await waitHealth(port2, p2);

  // ① 未鉴权 /health 不得泄漏账号名
  const anon = await get(port2, '/health');
  if (anon.text.includes(SENTINEL)) fail('未鉴权 /health 泄漏了账号名 ' + SENTINEL + '（应只给合计）');
  log('✓ 未鉴权 /health 不含账号名');

  // ② 带 key 的 /health 必须给逐账号 rows
  const auth = JSON.parse((await get(port2, '/health?key=' + encodeURIComponent(KEY))).text);
  const rows = (auth.balances && auth.balances.rows) || [];
  if (!rows.length) fail('带 key 的 /health 应有 balances.rows 逐账号明细，实际为空');
  if (rows[0].a !== SENTINEL) fail('balances.rows[0].a 应为 ' + SENTINEL + '，实际 ' + rows[0].a);
  if (auth.balances.rowsAuthed !== true) fail('/health 应标记 rowsAuthed=true');
  if (!auth.balances.workbuddy || auth.balances.workbuddy.remain !== 1234.5) fail('合计余额错误：' + JSON.stringify(auth.balances.workbuddy));
  log('✓ 带 key 的 /health 给出 rows（' + rows[0].p + ' · ' + rows[0].a + ' = ' + rows[0].r + '）');

  // ③ 看板：成长任务列已删、账号名渲染出来
  const pd = await get(port2, '/panel?key=' + encodeURIComponent(KEY));
  if (pd.status !== 200) fail('/panel 状态 ' + pd.status);
  if (!pd.text.includes(SENTINEL)) fail('/panel 未渲染账号 ' + SENTINEL);
  if (pd.text.includes('data-l="成长任务"')) fail('/panel 仍有「成长任务」列');
  if (!pd.text.includes('data-l="猫猫"') || !pd.text.includes('data-l="令牌"')) fail('/panel WB 表列头异常');
  log('✓ /panel 渲染单账号（含猫猫/令牌，无成长任务列）');

  // ④ 正常 state 文件必须原样读回（对应"解析失败才备份重置"，别把好文件也丢了）
  const st = JSON.parse((await get(port2, '/status?key=' + encodeURIComponent(KEY))).text).state;
  if (st.tickCount !== 42) fail('/status 回读 tickCount 应为 42，实际 ' + st.tickCount);
  log('✓ /status 回读预置 state 一致（tickCount=42）');

  stopPhase(p2);

  log('全部通过');
  cleanup(0);
})().catch(e => fail('异常：' + (e && e.stack || e)));
