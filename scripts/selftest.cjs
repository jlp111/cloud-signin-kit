#!/usr/bin/env node
// 自检：不依赖任何凭据，起一个实例、打几个端点，验证"能启动、能响应、看板能渲染"。
// 用法：node scripts/selftest.cjs        （CI 里也跑这个）
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-selftest-'));
const PORT = 18000 + Math.floor(Math.random() * 900);
const KEY = 'selftest-' + Math.random().toString(36).slice(2, 10);

function log(s) { process.stdout.write('[selftest] ' + s + '\n'); }
function fail(s) { log('✗ ' + s); cleanup(1); }

function cleanup(code) {
  try { if (child && !child.killed) child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// 1) 用示例配置派生一份"零账号"配置
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
cfg.access_key = KEY;
cfg.accounts = [];
cfg.trae = Object.assign({}, cfg.trae, { accounts: [] });
cfg.codearts = Object.assign({}, cfg.codearts, { accounts: [] });
cfg.qoder = Object.assign({}, cfg.qoder, { accounts: [] });
cfg.cloud = {};
const CFG_PATH = path.join(TMP, 'config.json');
const STATE_PATH = path.join(TMP, 'state.json');
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 1));
log('临时配置：' + CFG_PATH + '（0 个账号）');

// 2) 起服务
let child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    ACCESS_KEY: KEY,
    CONFIG_PATH: CFG_PATH,
    STATE_PATH: STATE_PATH,
    LOG_FILE: path.join(TMP, 'run.log'),
    TICK_MINUTES: '600',
    BUDDY_MINUTES: '600',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
child.stdout.on('data', d => out.push(String(d)));
child.stderr.on('data', d => out.push(String(d)));
child.on('exit', c => { if (c !== null && c !== 0) log('进程提前退出，code=' + c + '\n' + out.join('').slice(-800)); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(p) {
  const r = await fetch('http://127.0.0.1:' + PORT + p);
  const t = await r.text();
  return { status: r.status, text: t };
}

(async () => {
  // 3) 轮询 /health
  let health = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await get('/health');
      if (r.status === 200) { health = JSON.parse(r.text); break; }
    } catch { /* 还没起来 */ }
  }
  if (!health) fail('20 秒内 /health 无响应；日志：\n' + out.join('').slice(-800));
  if (health.ok !== true) fail('/health.ok 不是 true：' + JSON.stringify(health).slice(0, 200));
  log('✓ /health 200, ok=true, 账号数 ' + health.checkin.total);

  // 4) 鉴权：无 key 应 401
  const noKey = await get('/status');
  if (noKey.status !== 401) fail('/status 不带 key 应返回 401，实际 ' + noKey.status);
  log('✓ /status 未授权时 401');

  // 5) 看板能渲染（含移动端样式与空状态提示）
  const panel = await get('/panel?key=' + encodeURIComponent(KEY));
  if (panel.status !== 200) fail('/panel 状态 ' + panel.status);
  if (!panel.text.includes('积分看板')) fail('/panel 内容缺标题');
  if (!panel.text.includes('max-width:640px')) fail('/panel 缺移动端媒体查询');
  if (!panel.text.includes('还没有配置任何账号')) fail('/panel 缺空状态提示');
  log('✓ /panel 200（标题 / 移动端样式 / 空状态提示都在）');

  // 6) 落地页
  const idx = await get('/index.html');
  if (idx.status !== 200 || !idx.text.includes('云端签到助手')) fail('/index.html 异常：' + idx.status);
  log('✓ /index.html 200');

  // 7) 战报接口
  const digest = await get('/digest?key=' + encodeURIComponent(KEY));
  if (digest.status !== 200) fail('/digest 状态 ' + digest.status);
  log('✓ /digest 200');

  log('全部通过');
  cleanup(0);
})().catch(e => fail('异常：' + (e && e.stack || e)));
