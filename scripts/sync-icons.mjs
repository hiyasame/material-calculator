#!/usr/bin/env node
// 同步本地图标回退库 icons/：
//   node scripts/sync-icons.mjs [--check]
//
// 背景：页面图标优先走 /source/ 边缘代理，代理回源失败（如 lanxi 的
// trycloudflare 临时隧道域名失效）时回退本地 icons/。游戏新增物品若没有
// 本地镜像，代理一挂这些新物品贴图就全空白（2026-09-01 发生过一次）。
// 本脚本拉取上游 defs，比对 icons/ 缺哪些图标并补齐（只保存 image/* 响应，
// 避免把 404/错误页 HTML 存成假 png —— 旧镜像里就混进过 8 个这种文件）。
//
// --check 只报告缺失，不下载（可用于 CI/巡检）。

import { readdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const DEFS_URL = 'http://kt.ikui.vip/api/data/defs';
const ICONS_DIR = path.resolve(process.cwd(), 'icons');
const CHECK_ONLY = process.argv.includes('--check');

const r = await fetch(DEFS_URL, { signal: AbortSignal.timeout(20000) });
if (!r.ok) {
  console.error(`拉取 defs 失败：HTTP ${r.status}`);
  process.exit(1);
}
const defs = await r.json();

// 深度扫描 defs 中所有指向图片服务器的 URL（物品/装备/怪物/buff/图腾全量覆盖，
// 前端目前虽只渲染物品图标，但镜像齐全后未来渲染任何图标都有兜底）。
// 排除 bg/ 区域背景大图（单张 4MB+，页面不渲染，不适合进镜像库）。
const wanted = new Map(); // basename -> upstreamUrl
const walk = (v) => {
  if (Array.isArray(v)) { v.forEach(walk); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach(walk); return; }
  if (typeof v === 'string' && /\/source\/(?!bg\/)/.test(v)) {
    const name = v.split('?')[0].split('/').pop();
    if (name) wanted.set(name, v);
  }
};
walk(defs);

const local = new Set(await readdir(ICONS_DIR));
const missing = [...wanted.entries()].filter(([name]) => !local.has(name));

console.log(`上游图标 ${wanted.size} 个，本地 ${local.size} 个，缺 ${missing.length} 个`);
if (missing.length === 0) {
  console.log('✓ 本地镜像已与上游对齐');
  process.exit(0);
}

if (CHECK_ONLY) {
  for (const [name, url] of missing) console.log(`  缺 ${name}  <-  ${url}`);
  console.log('（--check 模式，未下载。执行 node scripts/sync-icons.mjs 补齐）');
  process.exit(2);
}

let ok = 0;
const failed = [];
for (const [name, url] of missing) {
  const enc = url.split('/').slice(0, -1).join('/') + '/' + encodeURIComponent(name);
  try {
    const res = await fetch(enc, { signal: AbortSignal.timeout(15000) });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !ct.startsWith('image/')) {
      failed.push([name, `HTTP ${res.status} ${ct}`]);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path.join(ICONS_DIR, name), buf);
    ok++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed.push([name, String(err && err.cause ? err.cause : err).slice(0, 80)]);
  }
}

console.log(`已下载 ${ok}/${missing.length}`);
if (failed.length) {
  console.log('以下图标上游取不到（游戏方未上传或已改名），需要人工确认：');
  for (const [name, why] of failed) console.log(`  ✗ ${name}  (${why})`);
  process.exit(3);
}
