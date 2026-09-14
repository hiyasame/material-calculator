// 从游戏客户端 bundle 提取「开拓农村 / 开拓工厂」定义，写入 index.html 内嵌数据块。
//
// 为什么需要这个脚本：
//   上游 /api/data/defs（页面主数据源）只有物品/配方/怪物等定义，
//   不含农村与工厂的数据——这部分打包在游戏客户端 bundle 里
//   （bundle 随版本发布更换文件名 hash，所以不能硬编码 URL）。
//   本脚本抓 bundle → 定位数据区块 → 在 Node vm 里求值 → 生成 JSON，
//   游戏更新数值后重跑一次即可同步，无需手工抄数。
//
// 用法：
//   node scripts/sync-farm-defs.mjs             # 抓取并写回 index.html
//   node scripts/sync-farm-defs.mjs --check     # 只比对不写入（有差异退出码 1）
//   node scripts/sync-farm-defs.mjs --print     # 只打印数据块
//   node scripts/sync-farm-defs.mjs --file x.js # 用本地 bundle 调试（不联网）
//
// 提取原理（对压缩代码保持稳健）：
//   * 对象属性名（BASE_OUTPUT / processor / duration 等）不被压缩器改名，用来做锚点；
//     变量名（Fs / Sb / Qb）会被改名，所以绝不依赖变量名。
//   * 不开全局括号配平（压缩代码里的正则字面量会让朴素配平错位），改为：
//     锚点 → 向前取最近的 var 起点候选 → 向后用「字符串/模板感知」的局部扫描找终点，
//     逐个候选在 vm 里求值，取第一个求值成功且产出预期结构的区间。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const START_MARK = '/* ==FARM_FACTORY_DEFS_START== */';
const END_MARK = '/* ==FARM_FACTORY_DEFS_END== */';
const GAME_ROOT = process.env.GAME_ROOT || 'http://kt.ikui.vip';
const ASSET_BASE = 'https://source.ikui.vip';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const printOnly = args.includes('--print');
const fileIdx = args.indexOf('--file');
const localFile = fileIdx >= 0 ? args[fileIdx + 1] : null;

// ---------------------------------------------------------------------------
// 1. 取 bundle
// ---------------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function loadBundle() {
  if (localFile) return fs.readFileSync(localFile, 'utf8');
  const html = await fetchText(GAME_ROOT + '/');
  const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
  if (!m) throw new Error('未在游戏首页找到 /assets/*.js 入口脚本');
  const url = GAME_ROOT + m[1];
  console.log(`[sync] bundle: ${url}`);
  return fetchText(url);
}

async function loadVersions() {
  try {
    const d = JSON.parse(await fetchText(GAME_ROOT + '/api/data/defs'));
    return { clientVersion: d.clientVersion, dataVersion: d.dataVersion };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 2. 字符串/模板感知的局部扫描（不处理正则字面量：本脚本只扫描数据区块，
//    其中不含正则；一旦结构变化导致误判，后面求值断言会立刻报错）
// ---------------------------------------------------------------------------
function skipQuoted(src, i, quote) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote !== '`' && c === '\n') return i;
    i++;
  }
  return i;
}

function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') { i = skipBraced(src, i + 1); continue; }
    i++;
  }
  return i;
}

// 从 '{' 跳到匹配 '}' 之后
function skipBraced(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

// 从锚点出发，向前找到包围它的那个 '{' 的匹配 '}' 位置（+1）
function enclosingBraceEnd(src, idx) {
  let depth = 0;
  let i = idx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return i + 1; // 越过了包围对象
    }
    i++;
  }
  return src.length;
}

// 从锚点向前列出所有 var 声明起点（近→远）；压缩代码用 var
function varStartsBefore(src, idx, limit = 4000) {
  const out = [];
  const re = /(?:^|[;}{)\s])var\s/g;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const pos = m.index + m[0].length - 4;
    if (pos >= idx) break;
    out.push(pos);
    if (out.length > limit) break;
  }
  out.sort((a, b) => b - a);
  return out;
}

// 从 start 出发，在括号深度回到 0 时遇 ';' 结束，返回语句文本
function scanToStatementEnd(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return src.slice(start, i + 1);
    else if (c === '\n' && depth <= 0) {
      // 压缩产物一般一行，但保留兜底：深度 0 换行也视为语句结束
      const tail = src.slice(start, i);
      if (/[;}]$/.test(tail.trim())) return tail;
    }
    i++;
  }
  return src.slice(start);
}

function newCtx() {
  return vm.createContext({ window: { ASSET_BASE }, console });
}

function tryEval(ctx, code, label) {
  return vm.runInContext(code, ctx, { timeout: 10000 });
}

// 农场：q 对象是 var 链中的一环，链尾引用了外部 store（K / r），
// 所以终点必须精确取到 q 对象的 '}'，不能扫到整条语句的 ';'。
function extractFarm(src) {
  const anchor = src.indexOf('BASE_OUTPUT:');
  if (anchor < 0) throw new Error('未找到农场数据锚点 BASE_OUTPUT');
  const objEnd = enclosingBraceEnd(src, anchor);
  const objText = src.slice(src.lastIndexOf('{', anchor), objEnd);

  for (const start of varStartsBefore(src, anchor)) {
    const region = src.slice(start, objEnd) + ';';
    if (!/\bvar\b/.test(region.slice(0, 200))) continue;
    const ctx = newCtx();
    try {
      tryEval(ctx, region, 'farm');
      const q = tryEval(ctx, 'q', 'farm-q');
      if (q && q.MAX_LEVEL && q.EMPLOYEES && q.BUILDINGS && q.BONDS && q.MATERIALS) return q;
    } catch {
      /* 该起点缺少依赖，继续向前扩大 */
    }
  }
  throw new Error('未能定位农场数据区块（游戏 bundle 结构可能已变化）');
}

// 工厂：三块数据（机器/材料、配方、阶级）分散在不同位置，分别按锚点取所在语句，
// 在同一个 vm 上下文里依次求值，再按「数据形状」认领结果——不依赖压缩后的变量名。
const CAPTURE_CODE = `(() => {
  const g = globalThis;
  const out = { machines: null, materials: null, buildOrder: null, recipes: null, tierMap: null, tierLabels: null };
  const isRecipeList = (v) => Array.isArray(v) && v.length > 3 &&
    v.every((x) => x && typeof x === 'object' && 'machine' in x && 'duration' in x && 'inputs' in x);
  const isStringList = (v) => Array.isArray(v) && v.length > 3 && v.every((x) => typeof x === 'string');
  for (const k of Object.keys(g)) {
    let v;
    try { v = g[k]; } catch { continue; }
    if (isRecipeList(v)) { out.recipes = v; continue; }
    if (isStringList(v)) {
      if (v.includes('cutter')) out.buildOrder = v;
      else if (v[0] === '\\u539f\\u6599') out.tierLabels = v;
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const vals = Object.values(v);
    if (!vals.length) continue;
    if (vals.every((x) => x && typeof x === 'object' && 'processor' in x)) out.machines = v;
    else if (
      Object.keys(v).length >= 20 &&
      vals.every((x) => x && typeof x === 'object' && 'id' in x && 'name' in x && 'color' in x && 'emoji' in x)
    ) out.materials = v;
    else if (vals.every((x) => typeof x === 'number') && v.stone === 0 && v.oakWood === 0 && Object.keys(v).length >= 10) out.tierMap = v;
  }
  return out;
})()`;

function extractFactory(src) {
  const ctx = newCtx();
  const evalStatement = (anchor, label) => {
    if (anchor < 0) throw new Error(`未找到工厂锚点 ${label}`);
    const starts = varStartsBefore(src, anchor);
    if (!starts.length) throw new Error(`工厂锚点 ${label} 之前找不到 var 起点`);
    tryEval(ctx, scanToStatementEnd(src, starts[0]), label);
  };

  evalStatement(src.indexOf('processor:!0'), 'factory-machines');
  evalStatement(src.indexOf('oak_to_plank'), 'factory-recipes');
  evalStatement(src.indexOf('\u4e00\u7ea7\u4ea7\u7269'), 'factory-tiers');

  const out = tryEval(ctx, CAPTURE_CODE, 'factory-out');
  if (!out.machines || !out.materials || !out.recipes || !out.tierMap || !out.tierLabels) {
    throw new Error('工厂数据提取不完整（游戏 bundle 结构可能已变化）');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 裁剪成页面需要的字段（去掉页面用不到的东西，保持数据块精简）
// ---------------------------------------------------------------------------
function pickFarm(q) {
  const emp = {};
  for (const [id, e] of Object.entries(q.EMPLOYEES)) {
    emp[id] = {
      id: e.id, name: e.name, img: e.img, rarity: e.rarity, eff: e.eff, salary: e.salary,
      runAway: e.runAway || 0, noRaise: !!e.noRaise, noLeave: !!e.noLeave, desc: e.desc,
    };
  }
  const buildings = {};
  for (const [id, b] of Object.entries(q.BUILDINGS)) {
    buildings[id] = {
      id: b.id, name: b.name, cat: b.cat, emoji: b.emoji, img: b.img || '',
      main: b.main, by: b.by || null, byChance: b.byChance || 0, needsInput: !!b.needsInput,
      buildGold: b.buildGold || 0, buildMat: b.buildMat || {}, upMat: b.upMat || '', ops: !!b.ops,
    };
  }
  return {
    baseOutput: q.BASE_OUTPUT,
    maxLevel: q.MAX_LEVEL,
    maxStaff: q.MAX_STAFF,
    salaryUnit: 10000,
    landPrice: q.LAND_PRICE,
    ashBuildCost: q.ASH_BUILD_COST,
    talentResumeCost: q.TALENT_RESUME_COST,
    talentResumeCount: q.TALENT_RESUME_COUNT,
    talentIdleRate: q.TALENT_IDLE_RATE,
    talentPoolCap: q.TALENT_POOL_CAP,
    machineRepairCost: q.MACHINE_REPAIR_COST,
    machineBuyCost: q.MACHINE_BUY_COST,
    machineStackBreak: q.MACHINE_STACK_BREAK,
    internHours: q.INTERN_HOURS,
    retireHours: q.RETIRE_HOURS,
    rarityColors: q.RARITY_COLORS,
    rarityNames: q.RARITY_NAMES,
    employees: emp,
    bonds: q.BONDS.map((b) => ({
      id: b.id, name: b.name, emoji: b.emoji, need: b.need,
      effect: b.effect || null, effects: b.effects || null, desc: b.desc,
    })),
    materials: q.MATERIALS.map((m) => ({ id: m.id, name: m.name, emoji: m.emoji })),
    buildings,
  };
}

function pickFactory(f) {
  const materials = {};
  for (const [id, m] of Object.entries(f.materials)) {
    materials[id] = {
      id: m.id, name: m.name, emoji: m.emoji, color: m.color,
      raw: !!m.raw, fuelValue: m.fuelValue || 0,
    };
  }
  const machines = {};
  for (const [id, m] of Object.entries(f.machines)) {
    machines[id] = {
      id: m.id, name: m.name, short: m.short, color: m.color, accent: m.accent,
      processor: !!m.processor, needsFuel: !!m.needsFuel,
    };
  }
  return {
    machines,
    materials,
    buildOrder: f.buildOrder,
    tierMap: f.tierMap,
    tierLabels: f.tierLabels,
    recipes: f.recipes.map((r) => ({
      id: r.id, machine: r.machine, name: r.name,
      inputs: r.inputs, output: r.output, duration: r.duration,
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. 写入 / 比对 index.html
// ---------------------------------------------------------------------------
function buildBlock(dataset) {
  return (
    `${START_MARK}\n` +
    `        // 由 scripts/sync-farm-defs.mjs 自动生成，请勿手改。\n` +
    `        // 数据来源：游戏客户端 bundle（开拓农村 / 开拓工厂 定义；游戏 /api/data/defs 不含这部分）。\n` +
    `        // 游戏更新数值后重跑：node scripts/sync-farm-defs.mjs\n` +
    `        const FARM_FACTORY_DEFS = ${JSON.stringify(dataset)};\n` +
    `        ${END_MARK}`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export {
  extractFarm, extractFactory, pickFarm, pickFactory, buildBlock, loadBundle,
  scanToStatementEnd, varStartsBefore, newCtx, tryEval, CAPTURE_CODE,
};

if (isMain) (async () => {
  const src = await loadBundle();
  console.log(`[sync] bundle ${src.length} 字符`);
  const farm = pickFarm(extractFarm(src));
  const factory = pickFactory(extractFactory(src));
  const versions = localFile ? {} : await loadVersions();

  const dataset = {
    _meta: {
      source: 'game-client-bundle',
      clientVersion: versions.clientVersion ?? null,
      dataVersion: versions.dataVersion ?? null,
      extractedAt: new Date().toISOString().slice(0, 10),
      note: '开拓农村/开拓工厂数值取自游戏客户端 bundle；游戏更新后重跑 scripts/sync-farm-defs.mjs',
    },
    farm,
    factory,
  };

  console.log(`[sync] 农场：${Object.keys(farm.buildings).length} 建筑 / ${Object.keys(farm.employees).length} 员工 / ${farm.bonds.length} 羁绊`);
  console.log(`[sync] 工厂：${Object.keys(factory.materials).length} 材料 / ${factory.recipes.length} 配方`);

  const block = buildBlock(dataset);
  if (printOnly) {
    console.log(block);
    return;
  }

  const html = fs.readFileSync(INDEX, 'utf8');
  const a = html.indexOf(START_MARK);
  const b = html.indexOf(END_MARK);
  if (a < 0 || b < 0) throw new Error('index.html 中缺少数据块标记（FARM_FACTORY_DEFS_START/END）');
  if (html.slice(a, b + END_MARK.length) === block) {
    console.log('[sync] 数据已是最新，无需改动');
    return;
  }
  if (checkOnly) {
    console.log('[sync] --check：内嵌数据与游戏 bundle 不一致（未写入）');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(INDEX, html.slice(0, a) + block + html.slice(b + END_MARK.length));
  console.log('[sync] 已写回 index.html');
})().catch((err) => {
  console.error('[sync] 失败：' + err.message);
  process.exitCode = 1;
});
