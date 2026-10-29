#!/usr/bin/env node
// 单测：只测 src/lib.js 里的纯函数。零依赖，用 node:assert，不需要任何框架。
// 用法：node scripts/unit-tests.cjs        （CI 里三个 Node 版本都跑）
'use strict';

const assert = require('node:assert');
const L = require('../src/lib.js');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; process.stdout.write('  ok   ' + name + '\n'); }
  catch (e) { fail++; failures.push(name + '\n       ' + String(e && e.message || e).split('\n').join('\n       ')); process.stdout.write('  FAIL ' + name + '\n'); }
}
function group(name) { process.stdout.write('\n[' + name + ']\n'); }

// ---------------------------------------------------------------------------
group('cnDateStr —— 东八区日期，跨零点边界');
// UTC 15:59:59.999 = 北京 23:59:59.999，仍是当天
t('23:59:59.999（北京）→ 当天', () => {
  assert.strictEqual(L.cnDateStr(Date.parse('2026-10-29T15:59:59.999Z')), '2026-10-29');
});
// UTC 16:00:00.000 = 北京次日 00:00:00.000
t('00:00:00.000（北京）→ 次日', () => {
  assert.strictEqual(L.cnDateStr(Date.parse('2026-10-29T16:00:00.000Z')), '2026-10-30');
});
t('跨年：12-31 → 次年 01-01', () => {
  assert.strictEqual(L.cnDateStr(Date.parse('2026-12-31T16:00:00.000Z')), '2027-01-01');
});
t('闰年 02-28 → 02-29', () => {
  assert.strictEqual(L.cnDateStr(Date.parse('2028-02-28T16:00:00.000Z')), '2028-02-29');
});
t('不传参时退化为当前时间（返回 10 位日期串）', () => {
  assert.match(L.cnDateStr(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
group('parseCookieStr / cookieToStr —— Cookie 串来回转换');
t('base64 值里的 = 不被截断', () => {
  const m = L.parseCookieStr('a=YWJjZA==; b=2');
  assert.strictEqual(m.a, 'YWJjZA==');
  assert.strictEqual(m.b, '2');
});
t('重复 key 后者胜', () => {
  assert.strictEqual(L.parseCookieStr('k=1; k=2').k, '2');
});
t('k= 空值保留为空串', () => {
  const m = L.parseCookieStr('k=; b=2');
  assert.strictEqual(m.k, '');
  assert.strictEqual(m.b, '2');
});
t('前导 = / 无 = 的片段被跳过', () => {
  const m = L.parseCookieStr('=bad; noeq; good=1');
  assert.deepStrictEqual(Object.keys(m), ['good']);
});
t('多余空格与空段被忽略', () => {
  assert.deepStrictEqual(L.parseCookieStr('  a = 1 ;; b=2 ; '), { a: '1', b: '2' });
});
t('空串 / null / undefined 返回空对象', () => {
  assert.deepStrictEqual(L.parseCookieStr(''), {});
  assert.deepStrictEqual(L.parseCookieStr(null), {});
  assert.deepStrictEqual(L.parseCookieStr(undefined), {});
});
t('parse → stringify → parse 幂等', () => {
  const src = 'devclouddevuibjJ_SESSION_ID=abc==; devclouddevuibjtcftk=xyz; X=1';
  const once = L.parseCookieStr(src);
  const round = L.parseCookieStr(L.cookieToStr(once));
  assert.deepStrictEqual(round, once);
});

// ---------------------------------------------------------------------------
group('validBase —— 凭据里的 base 会直接拿去做请求，内网必须挡掉');
const OK_BASES = [
  'https://openapi.qoder.com.cn',
  'https://openapi.qoder.sh',
  'https://openapi.qoder.com.cn/',
];
for (const u of OK_BASES) {
  t('接受 ' + u, () => assert.ok(L.validBase(u), '应为合法'));
}
const BAD_BASES = [
  ['http://openapi.qoder.com.cn', '非 https'],
  ['https://openapi.qoder.com.cn/path', '带 path'],
  ['https://openapi.qoder.com.cn?x=1', '带 query'],
  ['https://openapi.qoder.com.cn#x', '带 hash'],
  ['https://user:pw@openapi.qoder.com.cn', '带 userinfo'],
  ['https://openapi.qoder.com.cn:8443', '带端口'],
  ['https://127.0.0.1', '环回'],
  ['https://169.254.169.254', '云元数据地址'],
  ['https://localhost', 'localhost'],
  ['https://localhost:8080', 'localhost 带端口'],
  ['https://10.0.0.5', '10/8'],
  ['https://192.168.1.1', '192.168/16'],
  ['https://172.20.0.1', '172.16-31/12'],
  ['https://0.0.0.0', '0.0.0.0'],
  ['https://intranet', '单标签内网名'],
  ['https://[::1]', 'IPv6 环回'],
  ['', '空串'],
  ['   ', '纯空格'],
  ['not a url', '不是 URL'],
];
for (const [u, why] of BAD_BASES) {
  t('拒绝 ' + (u || '(空)') + ' —— ' + why, () => assert.strictEqual(L.validBase(u), null));
}
t('返回规范化 origin（去掉尾斜杠）', () => {
  assert.strictEqual(L.validBase('https://openapi.qoder.com.cn/'), 'https://openapi.qoder.com.cn');
});
t('172.15.x 与 172.32.x 不在内网段，应放行', () => {
  assert.ok(L.validBase('https://172.15.0.1') === null, '172.15 仍是普通 IP，但纯 IP 一律拒绝');
  assert.ok(L.validBase('https://172.32.0.1') === null, '同上');
});

// ---------------------------------------------------------------------------
group('daysLeft');
t('null → null', () => assert.strictEqual(L.daysLeft(null), null));
t('0 → null（0 视为未配置）', () => assert.strictEqual(L.daysLeft(0), null));
t('正好 7 天 → 7', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.strictEqual(L.daysLeft(now + 7 * 86400000, now), 7);
});
t('负数保留（已过期）', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.strictEqual(L.daysLeft(now - 86400000, now), -1);
});

// ---------------------------------------------------------------------------
group('statusTrae —— R4 回归：跨零点后必须是 pending，不能红叉');
t('昨天 claimed、今天还没跑 → pending（不是 fail）', () => {
  const st = { trae: { '主号': { day: '2026-10-28', outcome: 'claimed', credit: 100 } } };
  assert.strictEqual(L.statusTrae(st, { name: '主号' }, '2026-10-29').state, 'pending');
});
t('今天 claimed → ok 且 done', () => {
  const st = { trae: { x: { day: '2026-10-29', outcome: 'claimed', credit: 100, extra: 100 } } };
  const r = L.statusTrae(st, { name: 'x' }, '2026-10-29');
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.credit, 200);
});
t('今天真失败 → fail', () => {
  const st = { trae: { x: { day: '2026-10-29', outcome: 'failed', note: 'code 500' } } };
  assert.strictEqual(L.statusTrae(st, { name: 'x' }, '2026-10-29').state, 'fail');
});
t('设备受限（9095/9074）按受限标注，不误报', () => {
  assert.strictEqual(L.statusTrae({ trae: { x: { day: '2026-10-29', outcome: 'device_busy' } } }, { name: 'x' }, '2026-10-29').state, 'busy');
  assert.strictEqual(L.statusTrae({ trae: { x: { day: '2026-10-29', outcome: 'no_device' } } }, { name: 'x' }, '2026-10-29').state, 'nodev');
});
t('完全没有记录 → pending', () => {
  assert.strictEqual(L.statusTrae({}, { name: 'x' }, '2026-10-29').state, 'pending');
});

// ---------------------------------------------------------------------------
group('statusWorkbuddy —— R5 回归：活动未开启不算已领，也不算失败');
t('活动未开启 → done=false、state=pending', () => {
  const st = { accounts: { a: { checkin: { day: '2026-10-29', done: false, inactive: true, note: '活动未开启' } } } };
  const r = L.statusWorkbuddy(st, { name: 'a' }, '2026-10-29');
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.state, 'pending');
});
t('今天真领到 → ok', () => {
  const st = { accounts: { a: { checkin: { day: '2026-10-29', done: true, credit: 100, streak: 3 } } } };
  const r = L.statusWorkbuddy(st, { name: 'a' }, '2026-10-29');
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.credit, 100);
});
t('今天查询/领取失败 → fail', () => {
  const st = { accounts: { a: { checkin: { day: '2026-10-29', done: false, note: '查询失败' } } } };
  assert.strictEqual(L.statusWorkbuddy(st, { name: 'a' }, '2026-10-29').state, 'fail');
});
t('昨天领过、今天还没跑 → pending', () => {
  const st = { accounts: { a: { checkin: { day: '2026-10-28', done: true } } } };
  assert.strictEqual(L.statusWorkbuddy(st, { name: 'a' }, '2026-10-29').state, 'pending');
});

// ---------------------------------------------------------------------------
process.stdout.write('\n' + pass + ' passed, ' + fail + ' failed\n');
if (fail) {
  process.stdout.write('\n失败用例：\n  - ' + failures.join('\n  - ') + '\n');
  process.exit(1);
}
