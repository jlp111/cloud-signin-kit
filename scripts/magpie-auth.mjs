#!/usr/bin/env node
// 直接复用 magpie 插件自己的登录实现，给云端拿凭据 —— 不再手工抠 cookie。
//
// 原理（不重写 OAuth，只调它的代码）：
//   ~/.config/magpie/plugins/node_modules/@magpie-community/opencode-*-auth/index.mjs
//   每个插件都导出 `auth.methods[]`，第一个 oauth 方法带 authorize()：
//     authorize() → { url, instructions, callback() }
//   · Qoder CN：PKCE device flow，浏览器授权后每 2 秒轮询 deviceToken/poll
//   · WorkBuddy：browserSignIn（浏览器授权 → 本机回调）
//   · Trae CN：本机 127.0.0.1 随机端口回调，换 Cloud-IDE-JWT
//   我们做三件事：拿 url 打开浏览器 → 等 callback() 返回凭据 → 实测后推给云端。
//   登录与续期的算法全在插件里，magpie 升级插件我们也跟着升级。
//
// 用法：
//   node magpie-auth.mjs --list                 # 列出可用 provider 与登录方式（无副作用）
//   node magpie-auth.mjs --login qoder-cn       # 打开浏览器登一个号，成功后自动推送
//   node magpie-auth.mjs --login all            # 依次登三个平台（每个都要点一次授权）
//   node magpie-auth.mjs --push                 # 不登录，只把 magpie 现有凭据推给云端
//   node magpie-auth.mjs --login qoder-cn --dry-run   # 只走到打印 URL，不推送
//
// 说明：WorkBuddy / Trae 的 token 由 magpie 后台静默续期；本脚本只在"彻底失效需要重新登录"
// 时用。日常保持新鲜只需 `--push`（或挂周计划任务）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MODDIR = path.join(os.homedir(), '.config', 'magpie', 'plugins', 'node_modules');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CFG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
// 目标服务地址与（可选的）分享码：用环境变量注入，不要写死在自己的域名里
const PUSH_ORIGIN = process.env.CLOUD_BASE || ('http://127.0.0.1:' + (process.env.PORT || 8080));
const PUSH_SHARE = process.env.SHARE_CODE || '';
const pushQuery = (key) => '?key=' + encodeURIComponent(key) + (PUSH_SHARE ? '&sharecode=' + encodeURIComponent(PUSH_SHARE) : '');

// provider → 插件包与导出名
const PROVIDERS = {
  'qoder-cn': { pkg: '@magpie-community/opencode-qoder-auth', exp: 'QoderCNAuthPlugin' },
  'workbuddy': { pkg: '@magpie-community/opencode-workbuddy-auth', exp: 'WorkBuddyAuthPlugin' },
  'trae-cn': { pkg: '@magpie-community/opencode-trae-auth', exp: 'TraeCNAuthPlugin' },
};

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] || d) : d; };
const DRY = flag('--dry-run');

// 插件可能调用 client.app.log / client.UI 之类，给个哑巴桩
const stubClient = new Proxy({}, {
  get: () => new Proxy(() => {}, { get: () => () => {}, apply: () => undefined }),
});

function openBrowser(url) {
  try {
    // Windows：交给系统默认浏览器；失败也不致命，URL 已打印
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

async function loadPlugin(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error('未知 provider: ' + provider + '（可用：' + Object.keys(PROVIDERS).join(', ') + '）');
  const file = path.join(MODDIR, meta.pkg, 'index.mjs');
  if (!fs.existsSync(file)) throw new Error('插件没装：' + file + '\n先在 magpie 里 `magpie plugin add ' + meta.pkg + '`');
  const mod = await import(pathToFileURL(file).href);
  let P = mod[meta.exp];
  if (!P) throw new Error('插件里找不到导出 ' + meta.exp + '（插件版本变了？）');
  if (typeof P === 'function' && !P.auth) P = await P({ client: stubClient });
  return { P, mod, file };
}

function methodsOf(P) {
  const a = P.auth || {};
  return Array.isArray(a.methods) ? a.methods : [];
}

async function listProviders() {
  for (const p of Object.keys(PROVIDERS)) {
    try {
      const { P, file } = await loadPlugin(p);
      const ms = methodsOf(P);
      console.log('· ' + p + '  (' + PROVIDERS[p].pkg + ')');
      ms.forEach((m, i) => console.log('    [' + i + '] ' + m.type + '  ' + (m.label || '') +
        (m.prompts ? '  (需要输入 ' + m.prompts.map(x => x.key).join('/') + ')' : '')));
      if (!ms.length) console.log('    ! 没找到 auth.methods，插件结构可能变了');
    } catch (e) {
      console.log('· ' + p + '  ✗ ' + e.message);
    }
  }
}

// 把插件返回的凭据映射成我们 /sync-from-magpie 的载荷
function payloadOf(provider, cred) {
  const access = cred.access || cred.accessToken || cred.token || '';
  const refresh = cred.refresh || cred.refreshToken || cred.refresh_token || '';
  const expires = cred.expires || cred.expiresAt || Date.now() + 30 * 86400000;
  const name = cred.name || cred.accountId || cred.uid || provider;
  if (provider === 'qoder-cn') {
    return { qoder: [{
      name: 'Qoder·' + String(name).slice(0, 18), uid: cred.uid || '', token: access,
      machineId: cred.machineId || '', expiresAt: new Date(Number(expires)).toISOString(),
      base: 'https://openapi.qoder.com.cn', from: 'plugin-login' }] };
  }
  if (provider === 'workbuddy') {
    return { workbuddy: [{
      name: cred.accountId || name, uid: cred.uid || '', accessToken: access, refreshToken: refresh,
      expiresAt: expires, refreshExpiresAt: cred.refreshExpiresAt || null, from: 'plugin-login' }] };
  }
  if (provider === 'trae-cn') {
    return { trae: [{
      name: 'Trae…' + String(cred.accountId || cred.uid || '').slice(-3), uid: cred.uid || '',
      access, deviceId: cred.deviceId || '', expires, from: 'plugin-login' }] };
  }
  throw new Error('不支持 ' + provider);
}

function loadCfg() { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
function saveCfg(cfg) { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 1)); }

// 把凭据写进本地 config（保持 uid 不变，避免改名丢 state）
function mergeLocal(provider, cred) {
  const cfg = loadCfg();
  const p = payloadOf(provider, cred);
  if (p.qoder) {
    cfg.qoder = cfg.qoder || { accounts: [] }; cfg.qoder.accounts = cfg.qoder.accounts || [];
    const q = p.qoder[0];
    let a = (q.uid && cfg.qoder.accounts.find(x => x.uid === q.uid)) || cfg.qoder.accounts.find(x => x.name === q.name);
    if (!a) { a = { name: q.name, uid: q.uid }; cfg.qoder.accounts.push(a); }
    a.token = q.token; a.base = q.base; a.tokenExpiresAt = q.expiresAt;
    if (q.machineId) { a.machineId = q.machineId; a.fingerprint = Object.assign({}, a.fingerprint, { machineId: q.machineId }); }
    a.syncedFrom = 'plugin-login';
  }
  if (p.workbuddy) {
    const w = p.workbuddy[0];
    cfg.accounts = cfg.accounts || [];
    let a = (w.uid && cfg.accounts.find(x => x.uid === w.uid)) || cfg.accounts.find(x => x.name === w.name);
    if (!a) { a = { name: w.name, uid: w.uid }; cfg.accounts.push(a); }
    a.accessToken = w.accessToken; if (w.refreshToken) a.refreshToken = w.refreshToken;
    a.expiresAt = w.expiresAt; if (w.refreshExpiresAt) a.refreshExpiresAt = w.refreshExpiresAt;
    a.syncedFrom = 'plugin-login';
  }
  if (p.trae) {
    const t = p.trae[0];
    cfg.trae = cfg.trae || { accounts: [] }; cfg.trae.accounts = cfg.trae.accounts || [];
    let a = (t.uid && cfg.trae.accounts.find(x => x.uid === t.uid)) || cfg.trae.accounts.find(x => x.name === t.name);
    if (!a) { a = { name: t.name, uid: t.uid }; cfg.trae.accounts.push(a); }
    a.access = t.access; if (t.deviceId) a.deviceId = t.deviceId; a.expires = t.expires;
    a.syncedFrom = 'plugin-login';
  }
  cfg.refreshOwner = 'magpie';
  saveCfg(cfg);
  return cfg;
}

async function pushCloud() {
  const cfg = loadCfg();
  const key = cfg.access_key;
  if (!key) throw new Error('config.json 缺 access_key');
  // 先把 magpie 文件里其它账号的最新状态也带上（没登录的号不至于掉队）
  const payload = { workbuddy: [], trae: [], qoder: [] };
  const mag = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json'), 'utf8')); } catch { return {}; } })();
  for (const a of cfg.accounts || []) if (a.accessToken) payload.workbuddy.push({ name: a.name, uid: a.uid, accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt, refreshExpiresAt: a.refreshExpiresAt });
  for (const a of (cfg.trae && cfg.trae.accounts) || []) if (a.access) payload.trae.push({ name: a.name, uid: a.uid, access: a.access, deviceId: a.deviceId, expires: a.expires, profile: a.profile });
  for (const a of (cfg.qoder && cfg.qoder.accounts) || []) if (a.token) payload.qoder.push({ name: a.name, uid: a.uid, token: a.token, machineId: a.machineId, expiresAt: a.tokenExpiresAt, base: a.base });

  const r = await fetch(PUSH_ORIGIN + '/sync-from-magpie' + pushQuery(key), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.detail) {
    throw new Error('推送被拒：HTTP ' + r.status + ' ' + JSON.stringify(j || {}).slice(0, 160) +
      '（线上可能还没部署 /sync-from-magpie，先发一版）');
  }
  for (const k of ['workbuddy', 'trae', 'qoder']) {
    for (const x of (j.detail && j.detail[k]) || []) {
      console.log('  ' + (x.ok ? '✓' : '✗') + ' [' + k + '] ' + x.name + '  ' +
        (x.ok ? ('剩 ' + (x.daysLeft != null ? x.daysLeft + ' 天' : (x.daily || 'ok'))) : (x.why || '')));
    }
  }
  console.log('云端：采用 ' + (j.adopted || 0) + ' 个，失败 ' + (j.failed || 0) + ' 个；刷新主管=' + j.refreshOwner);
  if (j.adopted) console.log('已用新凭据跑了一轮（今天已签的走幂等，不会重复发）');
}

async function login(provider) {
  const { P } = await loadPlugin(provider);
  const ms = methodsOf(P);
  if (!ms.length) throw new Error(provider + '：插件没有 auth.methods');
  // 优先用不需要输入的那种（浏览器授权）；PAT 那类需要 prompts，跳过
  const m = ms.find(x => x.type === 'oauth' && !x.prompts) || ms[0];
  if (!m.authorize) throw new Error(provider + '：该方法没有 authorize()');
  console.log('登录方式：' + (m.label || m.type));
  const flow = await m.authorize({});
  if (!flow || !flow.url) throw new Error(provider + '：authorize() 没返回 url');
  console.log('\n请在浏览器里完成授权（已尝试自动打开）：');
  console.log('  ' + flow.url);
  if (flow.instructions) console.log('  ' + flow.instructions);
  openBrowser(flow.url);
  console.log('\n等待授权…（点了授权后这里会自动继续）');
  const cred = await flow.callback();
  if (!cred || cred.type === 'failed') throw new Error(provider + ' 登录失败：' + ((cred && cred.error) || '未知原因'));
  const days = ((Number(cred.expires || 0) - Date.now()) / 86400000).toFixed(1);
  console.log('✓ 登录成功：' + (cred.accountId || cred.uid || '?') + '  token 剩 ' + days + ' 天');
  if (DRY) { console.log('--dry-run：不写配置、不推送'); return; }
  mergeLocal(provider, cred);
  console.log('已写入本地 config.json；开始推送云端…');
  await pushCloud();
}

(async () => {
  if (flag('--list')) { await listProviders(); return; }
  if (flag('--push')) { console.log('推送现有凭据到云端…'); await pushCloud(); return; }
  const who = val('--login', '');
  if (!who) {
    console.log('用法：node magpie-auth.mjs --list | --login <qoder-cn|workbuddy|trae-cn|all> [--dry-run] | --push');
    return;
  }
  const targets = who === 'all' ? Object.keys(PROVIDERS) : [who];
  for (const p of targets) {
    console.log('\n===== ' + p + ' =====');
    try { await login(p); } catch (e) { console.log('✗ ' + ((e && e.message) || e)); }
  }
})().catch(e => { console.error('失败：' + ((e && e.message) || e)); process.exit(1); });
