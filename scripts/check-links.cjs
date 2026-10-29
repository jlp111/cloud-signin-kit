#!/usr/bin/env node
// 文档体检：检查 md 文件里的相对链接是否指向真实存在的文件/锚点。
// 用法：node scripts/check-links.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), out);
    } else if (e.name.endsWith('.md')) out.push(path.join(d, e.name));
  }
  return out;
}

// GitHub 风格锚点：小写、去标点、每个空格各转一个 '-'（连续空格会产生 '--'，不要合并）
function slug(s) {
  return s.trim().toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\u4e00-\u9fa5\- ]/g, '')
    .replace(/ /g, '-');
}

const files = walk(ROOT);
const headings = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const hs = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) hs.add(slug(m[1]));
  headings.set(f, hs);
}

let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = m[2].trim();
    if (/^(https?:|mailto:|#)/.test(target)) {
      if (target.startsWith('#') && !headings.get(f).has(target.slice(1))) {
        console.log(`✗ ${rel}: 锚点不存在 ${target}`);
        bad++;
      }
      continue;
    }
    const [p, hash] = target.split('#');
    const abs = path.resolve(path.dirname(f), p);
    if (!fs.existsSync(abs)) {
      console.log(`✗ ${rel}: 文件不存在 ${target}`);
      bad++;
      continue;
    }
    if (hash && abs.endsWith('.md')) {
      const hs = headings.get(abs);
      if (hs && !hs.has(hash) && hash !== '') {
        console.log(`✗ ${rel}: 目标文件里没有锚点 ${target}`);
        bad++;
      }
    }
  }
}
console.log('---');
console.log('检查 md 文件 ' + files.length + ' 个，问题 ' + bad + ' 处');
process.exit(bad ? 1 : 0);
