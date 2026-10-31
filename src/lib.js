// src/lib.js —— 纯函数库：不碰 fs / 网络 / 全局可变状态，可直接单测。
// 这些函数原先散落在 server.js 里、与 IO 混在一起，无法单测；抽出来后
// 服务器只负责编排，判定逻辑在这里可以穷举边界（见 scripts/unit-tests.cjs）。
'use strict';

// 东八区日期串 'YYYY-MM-DD'。先平移到 UTC+8 再取 UTC 日期，
// 因此与服务器本地时区无关（容器常是 UTC，不能依赖 toLocaleDateString）。
// ts 可注入，便于测跨零点边界。
function cnDateStr(ts) {
  const t = (typeof ts === 'number' && Number.isFinite(ts)) ? ts : Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 剩余天数（保留 1 位小数）。ms 为空返回 null，供看板显示 '—'。
function daysLeft(ms, now) {
  const t = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  return ms ? Math.round((ms - t) / 8640000) / 10 : null;
}

// ---------- 第三方 base URL 校验（凭据里的 base 会直接拿去做请求，必须挡内网） ----------
const PRIVATE_PREFIXES = ['localhost', '127.', '10.', '192.168.', '169.254.', '0.0.0.0'];

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  for (const p of PRIVATE_PREFIXES) { if (h === p || h.startsWith(p)) return true; }
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m) { const n = Number(m[1]); if (n >= 16 && n <= 31) return true; }
  // 纯 IPv4 / IPv6 字面量一律按内网处理（这些不该出现在「平台域名」的位置）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.indexOf(':') >= 0 || h.indexOf('[') >= 0) return true;
  return false;
}

// 合法返回规范化后的 origin（字符串），非法返回 null。
// 规则：必须 https、必须像域名（至少一个点）、不带端口/userinfo/path/query/hash、不是内网地址。
function validBase(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  let x;
  try { x = new URL(u.trim()); } catch (e) { return null; }
  if (x.protocol !== 'https:') return null;
  if (x.username || x.password) return null;
  if (x.port) return null;
  if (x.pathname !== '/' || x.search || x.hash) return null;
  const host = x.hostname;
  // 至少两段、只允许字母数字与 '-'（拒绝单标签内网名、拒绝下划线等怪字符）
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return null;
  if (isPrivateHost(host)) return null;
  return x.origin;
}

// ---------- 展示层状态判定（纯函数，PLATFORMS 与单测共用） ----------
// WorkBuddy：今天领成功＝ok；「活动未开启」保持 pending（当天还要重试，不能算失败也不能算已领）。
function statusWorkbuddy(st, a, today) {
  const c = ((((st || {}).accounts || {})[a.name] || {}).checkin) || {};
  const done = c.day === today && !!c.done;
  const inactive = !done && c.day === today && !!c.inactive;
  return {
    done,
    credit: done ? Number(c.credit) || 0 : 0,
    streak: done ? Number(c.streak) || 0 : 0,
    state: done ? 'ok' : inactive ? 'pending' : (c.day === today ? 'fail' : 'pending'),
    note: c.note || '',
  };
}

// Trae：claimed＝ok；设备受限（9095/9074）单独标注、不算失败；
// 「今天还没跑过」必须是 pending —— 否则每天 00:00 到当天首轮之间必然红叉。
function statusTrae(st, a, today) {
  const r = (((st || {}).trae || {})[a.name]) || {};
  const done = r.day === today && r.outcome === 'claimed';
  return {
    done,
    credit: done ? (Number(r.credit) || 0) + (Number(r.extra) || 0) : 0,
    streak: 0,
    state: done ? 'ok'
      : r.outcome === 'device_busy' ? 'busy'
        : r.outcome === 'no_device' ? 'nodev'
          : (r.day === today ? 'fail' : 'pending'),
    note: r.note || '',
  };
}

module.exports = {
  cnDateStr, daysLeft, validBase,
  isPrivateHost, statusWorkbuddy, statusTrae,
};
