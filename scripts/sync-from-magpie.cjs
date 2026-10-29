#!/usr/bin/env node
// 从本机 magpie 的 plugin-auth.json 一次性同步 WorkBuddy / Trae CN / Qoder CN 三个平台。
//
// 设计原则（为什么这么绕）：
//   1. magpie 是**刷新链的主人**（它带设备密钥做 DeviceProof / 链式续签），云端只"借"它的
//      access token。两边都刷会互相作废对方的 refresh —— WorkBuddy 实测过：客户端一刷，
//      云端旧链就作废，反之亦然（Trae 侧表现为 9074 拒签）。所以云端设 refreshOwner='magpie'，
//      由本脚本定期把新鲜 token 推上去，而不是云端自己续。
//   2. 云端对每个账号**当场实测**（WB buddy/info、Trae checkin status、Qoder campaigns），
//      通过才落盘；没通过的保留旧凭据，不会因为一次坏推送把好号搞挂。
//
// 用法：
//   node sync-from-magpie.cjs            # 只读 + 打印对照（写本地 config.json）
//   node sync-from-magpie.cjs --dry-run  # 只看 magpie 里有什么，不动 config
//   node sync-from-magpie.cjs --push     # 写本地 config + 推给线上（免发版）
//   node sync-from-magpie.cjs --push --only qoder   # 只推某一个平台
//
// 建议挂周计划任务（电脑没开那次跳过即可，access token 有 30 天缓冲）：
//   schtasks /Create /TN "magpie凭据同步" /SC WEEKLY /D MON /ST 10:10 ^
//     /TR "node <本文件路径> --push" /F
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAGPIE_AUTH = path.join(process.env.USERPROFILE || os.homedir(), '.config', 'magpie', 'plugin-auth.json');
const CFG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json');
// 目标服务地址与（可选的）分享码：用环境变量注入
const PUSH_ORIGIN = process.env.CLOUD_BASE || ('http://127.0.0.1:' + (process.env.PORT || 8080));
const PUSH_SHARE = process.env.SHARE_CODE || '';
const pushQuery = (key) => '?key=' + encodeURIComponent(key) + (PUSH_SHARE ? '&sharecode=' + encodeURIComponent(PUSH_SHARE) : '');
const QD_BASE = 'https://openapi.qoder.com.cn';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PUSH = args.includes('--push');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').toLowerCase() : '';

const days = (ms) => (ms ? ((ms - Date.now()) / 86400000).toFixed(1) : '?');
const mask = (s, n = 8) => { s = String(s || ''); return s.length <= n ? '***' : s.slice(0, n) + '…'; };

function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }

function main() {
  const auth = loadJson(MAGPIE_AUTH, null);
  if (!auth) throw new Error('找不到 magpie 凭据: ' + MAGPIE_AUTH);
  const cfgFile = loadJson(CFG_PATH, null);
  // --dry-run 只读上游、不写配置，所以没有 config.json 也允许跑（首次部署时先看能同步到什么）
  if (!cfgFile && !DRY) throw new Error('找不到 ' + CFG_PATH + '（先 cp config.example.json config.json，或加 --dry-run 只看不写）');
  const cfg = cfgFile || { accounts: [], trae: { accounts: [] }, qoder: { accounts: [] } };

  // 用 uid 索引现有账号，保证改名不会把 state 里的历史记录搞丢
  const byUid = (arr, uid) => (arr || []).find(x => uid && x.uid === uid);

  const payload = { workbuddy: [], trae: [], qoder: [] };

  // ---------- WorkBuddy ----------
  if (!ONLY || ONLY === 'workbuddy' || ONLY === 'wb') {
    for (const k of Object.keys(auth).filter(x => x.startsWith('workbuddy'))) {
      const v = auth[k] || {};
      if (!v.access) continue;
      const old = byUid(cfg.accounts, v.uid) || (cfg.accounts || []).find(x => x.name === v.accountId);
      payload.workbuddy.push({
        name: (old && old.name) || v.accountId || k,
        uid: v.uid || '',
        accessToken: v.access,
        refreshToken: v.refresh || '',
        expiresAt: v.expires || null,
        refreshExpiresAt: v.refreshExpiresAt || null,
        from: k,
      });
    }
  }

  // ---------- Trae CN ----------
  const traeKeys = Object.keys(auth).filter(x => x === 'trae-cn' || x.startsWith('trae-cn#'));
  if (!ONLY || ONLY === 'trae') {
    traeKeys.forEach((k, i) => {
      const v = auth[k] || {};
      if (!v.access) return;
      // 账号名沿用 config 里的（state 以 name 为键）；新号用"主号/小号…尾号"
      const old = byUid((cfg.trae && cfg.trae.accounts) || [], v.uid);
      const name = (old && old.name) || ('Trae' + (i === 0 ? '主号' : '小号') + '…' + String(v.accountId || '').slice(-3));
      payload.trae.push({
        name,
        uid: v.uid || '',
        access: v.access,
        deviceId: String(v.deviceId || ''),
        expires: v.expires || null,
        profile: (old && old.profile) || undefined,   // 设备指纹（桌面/手机）沿用现有配置
        from: k,
      });
    });
  }

  // ---------- Qoder CN ----------
  const qKeys = Object.keys(auth).filter(x => x === 'qoder-cn' || x.startsWith('qoder-cn#'));
  if (!ONLY || ONLY === 'qoder' || ONLY === 'qd') {
    for (const k of qKeys) {
      const v = auth[k] || {};
      if (!v.access) continue;
      const old = byUid((cfg.qoder && cfg.qoder.accounts) || [], v.uid);
      payload.qoder.push({
        name: (old && old.name) || ('Qoder·' + String(v.name || k).slice(0, 18)),
        uid: v.uid || '',
        token: v.access,
        machineId: v.machineId || '',
        expiresAt: v.expires ? new Date(Number(v.expires)).toISOString() : null,
        base: QD_BASE,
        from: k,
      });
    }
  }

  // ---- 打印对照 ----
  console.log('magpie 里找到：');
  for (const w of payload.workbuddy) console.log('  [WorkBuddy] ' + w.name + '  access 剩 ' + days(w.expiresAt) + ' 天  refresh 剩 ' + days(w.refreshExpiresAt) + ' 天');
  for (const t of payload.trae) console.log('  [Trae]      ' + t.name + '  access 剩 ' + days(t.expires) + ' 天  deviceId=' + mask(t.deviceId, 6));
  for (const q of payload.qoder) console.log('  [Qoder]     ' + q.name + '  token 剩 ' + days(new Date(q.expiresAt).getTime()) + ' 天  machineId=' + mask(q.machineId, 8));
  const total = payload.workbuddy.length + payload.trae.length + payload.qoder.length;
  if (!total) throw new Error('这三类账号一个都没找到（magpie 里没有 workbuddy / trae-cn / qoder-cn）');

  if (DRY) { console.log('\n--dry-run：未写 config，也未推送'); return; }

  // ---- 写本地 config（云端不再自己刷 WB，交给 magpie） ----
  const before = JSON.parse(JSON.stringify(cfg));
  if (payload.workbuddy.length) {
    cfg.accounts = cfg.accounts || [];
    for (const w of payload.workbuddy) {
      let a = byUid(cfg.accounts, w.uid) || cfg.accounts.find(x => x.name === w.name);
      if (!a) { a = { name: w.name, uid: w.uid }; cfg.accounts.push(a); }
      a.accessToken = w.accessToken;
      if (w.refreshToken) a.refreshToken = w.refreshToken;
      if (w.expiresAt) a.expiresAt = w.expiresAt;
      if (w.refreshExpiresAt) a.refreshExpiresAt = w.refreshExpiresAt;
      a.syncedFrom = 'magpie';
    }
  }
  if (payload.trae.length) {
    cfg.trae = cfg.trae || { accounts: [] };
    cfg.trae.accounts = cfg.trae.accounts || [];
    for (const t of payload.trae) {
      let a = byUid(cfg.trae.accounts, t.uid) || cfg.trae.accounts.find(x => x.name === t.name);
      if (!a) { a = { name: t.name, uid: t.uid }; cfg.trae.accounts.push(a); }
      a.access = t.access;
      if (t.deviceId) a.deviceId = t.deviceId;
      if (t.expires) a.expires = t.expires;
      if (t.profile) a.profile = t.profile;
      a.syncedFrom = 'magpie';
    }
  }
  if (payload.qoder.length) {
    cfg.qoder = cfg.qoder || { accounts: [] };
    cfg.qoder.accounts = cfg.qoder.accounts || [];
    for (const q of payload.qoder) {
      let a = byUid(cfg.qoder.accounts, q.uid) || cfg.qoder.accounts.find(x => x.name === q.name);
      if (!a) { a = { name: q.name, uid: q.uid }; cfg.qoder.accounts.push(a); }
      a.token = q.token;
      if (q.machineId) { a.machineId = q.machineId; a.fingerprint = Object.assign({}, a.fingerprint, { machineId: q.machineId }); }
      if (q.expiresAt) a.tokenExpiresAt = q.expiresAt;
      a.base = q.base;
      a.syncedFrom = 'magpie';
    }
  }
  cfg.refreshOwner = 'magpie';   // 刷新主管＝magpie，云端不再自己刷
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 1));
  const chg = JSON.stringify(before) !== JSON.stringify(cfg);
  console.log('\n已写入 config.json' + (chg ? '（有变更）' : '（内容无变化）') + '；refreshOwner=magpie');

  if (!PUSH) {
    console.log('提示：加 --push 可直接推给线上（免重新发版）');
    return;
  }

  // ---- 推送 ----
  const key = cfg.access_key;
  if (!key) throw new Error('config.json 缺 access_key，无法推送');
  console.log('\n推送到线上 ' + PUSH_ORIGIN + ' …');
  fetch(PUSH_ORIGIN + '/sync-from-magpie' + pushQuery(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).then(j => {
    const detail = j.detail || {};
    for (const k2 of ['workbuddy', 'trae', 'qoder']) {
      for (const x of (detail[k2] || [])) {
        console.log('  ' + (x.ok ? '✓' : '✗') + ' [' + k2 + '] ' + x.name + '  ' +
          (x.ok ? ('已更新 剩 ' + (x.daysLeft != null ? x.daysLeft + ' 天' : (x.daily || 'ok'))) : (x.why || '')));
      }
    }
    console.log('\n结果：采用 ' + (j.adopted || 0) + ' 个，失败 ' + (j.failed || 0) + ' 个；刷新主管=' + j.refreshOwner);
    if (j.adopted) console.log('云端已用新凭据跑了一轮（今天已签的走幂等，不会重复发）');
  }).catch(e => {
    console.log('推送失败：' + ((e && e.message) || e));
    process.exitCode = 1;
  });
}

try { main(); } catch (e) { console.error('失败：' + ((e && e.message) || e)); process.exit(1); }
