#!/usr/bin/env node
// 码道会话「探活能不能续命」对照实验（零依赖）
//
// 要回答的问题：华为 devcloud 的会话在闲置 30~60 分钟就失效的说法下，
//   A 组：每 N 分钟打一次只读 delivery 接口
//   B 组：全程不打，只在结束前打一次
// 如果 A 撑过 2 小时而 B 挂掉 → 探活确实有效，可以把默认探活间隔从 6 小时改成 5 分钟。
// 如果 A 也挂 → 探活只是安慰剂，必须换 cookie（浏览器重新登录），这也是
//   wangmingdong/workbuddy-signin 用 Playwright 持久化 profile 每 5 分钟换票的原因。
//
// 用法（cookie 只从文件读，不接受命令行传值，避免进 shell 历史）：
//   node scripts/codearts-keepalive-lab.cjs --cookie=./hw-cookie.txt                 # 顺序跑 A→B，共 2×时长
//   node scripts/codearts-keepalive-lab.cjs --cookie-a=./a.txt --cookie-b=./b.txt    # 两组并行，需两个不同账号
//   node scripts/codearts-keepalive-lab.cjs --cookie=./hw-cookie.txt --minutes=60 --probe-min=5
'use strict';

const fs = require('fs');
const path = require('path');
const { hwCookieCheck, parseCookieStr } = require('../src/lib.js');

const HW_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/chat/PromptCenterService';
const HW_HOME = 'https://devcloud.cn-north-4.huaweicloud.com/chat/home';
const HW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

function arg(name, dflt) {
  const hit = process.argv.find((x) => x.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

const MINUTES = Number(arg('minutes', '120'));
const PROBE_MIN = Number(arg('probe-min', '5'));
const OUT = arg('out', 'hw-lab-result.json');
const NO_WAIT = process.argv.includes('--no-wait');

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function say(m) { console.log('[' + ts() + '] ' + m); }

function readCookie(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    console.error('找不到 cookie 文件：' + p);
    process.exit(2);
  }
  const raw = fs.readFileSync(p, 'utf8').trim();
  const chk = hwCookieCheck(raw);
  if (!chk.ok) {
    console.error('这个 Cookie 不完整，缺少：' + chk.missing.join('、'));
    console.error('请从 F12 → Network → 任一 PromptCenterService 请求的 cookie 请求头复制完整值。');
    process.exit(2);
  }
  if (chk.missingSoft.length) say('提示：缺少 ' + chk.missingSoft.join('、') + '（通常不影响，仅记录）');
  return raw;
}

// 单次探活。判据与主服务一致：必须拿到 JSON 且 code===0（或含活动字段），
// 只看 200 会被网关的 SPA HTML 骗过去。
async function probe(cookie) {
  const m = parseCookieStr(cookie);
  const headers = {
    'user-agent': HW_UA,
    'agent-type': 'PromptCenter',
    'x-language': 'zh-cn',
    language: 'zh-cn',
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/plain, */*',
    referer: HW_HOME,
    cookie,
  };
  if (m.devclouddevuibjtcftk) headers.cftk = m.devclouddevuibjtcftk;

  const url = HW_BASE + '/v1/ops/delivery?channel=WEB&_=' + Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch { /* HTML */ }
    const alive = r.status === 200 && !!j && (j.code === 0 ||
      /campaigns|benefitAmount|campaignId/.test(body));
    return { status: r.status, alive, note: alive ? 'alive' : (j ? 'json code=' + j.code : 'HTML（未登录或已失效）') };
  } catch (e) {
    return { status: -1, alive: false, note: 'ERR ' + (e && (e.cause && e.cause.code || e.message) || e) };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 跑一组：probeEveryMin = 0 表示"全程不打，只在末尾打一次"
async function runArm(label, cookie, probeEveryMin) {
  const started = Date.now();
  const tl = [];
  const first = await probe(cookie);
  tl.push({ at: 0, ...first });
  say('[' + label + '] t=0s ' + (first.alive ? '存活' : '已失效') + '（' + first.note + '）');
  if (!first.alive) {
    say('[' + label + '] 开局就不可用，这组没有意义：请换一个刚登录的 Cookie 重跑');
    return { label, probeEveryMin, valid: false, timeline: tl, verdict: 'invalid-start' };
  }

  const endAt = started + MINUTES * 60000;
  let nextProbe = started + probeEveryMin * 60000;
  let diedAtMin = null;

  while (Date.now() < endAt) {
    const soon = probeEveryMin > 0 && Date.now() >= nextProbe;
    const remain = endAt - Date.now();
    const step = probeEveryMin > 0 ? Math.min(nextProbe - Date.now(), remain, 30000) : Math.min(remain, 30000);
    await sleep(Math.max(step, 200));
    if (soon) {
      const p = await probe(cookie);
      const atMin = Math.round((Date.now() - started) / 60000);
      tl.push({ at: atMin, ...p });
      say('[' + label + '] t=' + atMin + 'min ' + (p.alive ? '存活' : '失效') + '（' + p.note + '）');
      if (!p.alive && diedAtMin === null) diedAtMin = atMin;
      nextProbe = Date.now() + probeEveryMin * 60000;
    }
  }

  const last = await probe(cookie);
  const totalMin = Math.round((Date.now() - started) / 60000);
  tl.push({ at: totalMin, ...last, final: true });
  say('[' + label + '] 结束 t=' + totalMin + 'min ' + (last.alive ? '仍存活' : '已失效') + '（' + last.note + '）');

  return {
    label, probeEveryMin, valid: true, minutes: totalMin,
    aliveAtEnd: last.alive, diedAtMin, timeline: tl,
    verdict: last.alive ? 'survived' : 'expired',
  };
}

(async () => {
  const cookieOne = arg('cookie', '');
  const cookieA = arg('cookie-a', '');
  const cookieB = arg('cookie-b', '');

  if (!cookieOne && !(cookieA && cookieB)) {
    console.error('用法：');
    console.error('  单 Cookie（顺序跑两组，总共 ' + MINUTES + '×2 分钟）：');
    console.error('    node scripts/codearts-keepalive-lab.cjs --cookie=./hw-cookie.txt');
    console.error('  双 Cookie（并行跑，需两个不同账号，总共 ' + MINUTES + ' 分钟）：');
    console.error('    node scripts/codearts-keepalive-lab.cjs --cookie-a=./a.txt --cookie-b=./b.txt');
    console.error('  可选：--minutes=120 --probe-min=5 --out=hw-lab-result.json');
    process.exit(2);
  }

  say('实验开始：时长 ' + MINUTES + ' 分钟，A 组每 ' + PROBE_MIN + ' 分钟探活一次，B 组全程不探');
  const results = [];

  if (cookieA && cookieB) {
    const [ra, rb] = await Promise.all([
      runArm('A-探活' + PROBE_MIN + 'min', readCookie(cookieA), PROBE_MIN),
      runArm('B-不探活', readCookie(cookieB), 0),
    ]);
    results.push(ra, rb);
  } else {
    const c = readCookie(cookieOne);
    results.push(await runArm('A-探活' + PROBE_MIN + 'min', c, PROBE_MIN));

    // 顺序模式的关键：B 组必须换一个**刚登录**的新 Cookie。
    // 否则 A 组跑完 N 分钟后，同一个 Cookie 早已过期，B 组开局即失效，实验白跑。
    if (!NO_WAIT && process.stdin.isTTY) {
      const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      await new Promise((res) => {
        readline.question(
          '\n>>> A 组结束。请把 ' + path.resolve(cookieOne) + ' 换成**刚登录的新 Cookie**（同一个账号也行，重新登录一次即可），然后按回车继续 B 组：',
          () => { readline.close(); res(); }
        );
      });
    } else {
      say('--no-wait：直接重读同一文件跑 B 组（若 Cookie 已过期，B 组会判无效）');
    }
    const c2 = readCookie(cookieOne);
    results.push(await runArm('B-不探活', c2, 0));
  }

  const a = results[0], b = results[1];
  let conclusion;
  if (!a.valid || !b.valid) conclusion = 'inconclusive：至少一组开局即失效，需换新 Cookie 重跑';
  else if (a.aliveAtEnd && !b.aliveAtEnd) conclusion = '探活有效：A 撑住了、B 挂了 → 应把默认探活间隔改小';
  else if (a.aliveAtEnd && b.aliveAtEnd) conclusion = '探活非必要：两组都活 → 会话本来就没那么快失效，探活间隔可放宽';
  else if (!a.aliveAtEnd && !b.aliveAtEnd) conclusion = '探活无效：两组都挂 → 只读接口续不了命，必须换 Cookie（浏览器重新登录）';
  else conclusion = '异常：B 存活但 A 挂了，可能是 B 的 Cookie 更新或偶发网络问题，建议重跑';

  const out = { at: ts(), minutes: MINUTES, probeMin: PROBE_MIN, results, conclusion };
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 2));

  console.log('\n================ 结论 ================');
  for (const r of results) {
    if (!r.valid) { console.log(r.label + '：开局即失效（无效）'); continue; }
    console.log(r.label + '：' + (r.aliveAtEnd ? '存活到结束' : '在 t≈' + r.diedAtMin + 'min 失效'));
  }
  console.log('\n' + conclusion);
  console.log('\n明细已写入 ' + path.resolve(OUT) + '（不含 Cookie 原文）');
  process.exit(0);
})().catch((e) => { console.error('实验脚本异常：' + (e && e.stack || e)); process.exit(1); });
