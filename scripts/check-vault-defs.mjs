#!/usr/bin/env node
// 校验 / 导出「收藏室（装备库）」内置兜底数值：
//   node scripts/check-vault-defs.mjs                  # 拉游戏数据接口 /api/data/defs，与内置 VAULT_DEFAULTS 比对
//   node scripts/check-vault-defs.mjs --state s.json   # 改用本地 state JSON（{"state":{...}} 或裸 state）比对
//   node scripts/check-vault-defs.mjs --cdp            # 改用 CDP 连已登录的游戏页面抓 /api/game/state
//   node scripts/check-vault-defs.mjs --emit           # 比对后打印线上解析结果（便于手工更新内置值）
//   node scripts/check-vault-defs.mjs --quiet          # 只输出结论行
//
// 为什么需要这个脚本：
//   页面的收藏室数值**默认跟随游戏数据接口**（WEAPON_VAULT_DEFS 等，见 applyVaultDefsFromGameData），
//   index.html 里的 VAULT_DEFAULTS 只是接口不可用时的离线兜底。兜底值不该悄悄过期，
//   本脚本用**与页面导入完全相同的代码路径**（把 index.html 的内联脚本放进 vm，调用它的
//   parseVaultDefsFromRoot）解析线上数据，再和内置值逐项比对——口径不可能跑偏。
//
// 退出码：0 = 内置值与线上一致；1 = 有差异（或抓取/解析失败）。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const opt = {
  stateFile: valueOf('--state', null),
  useCdp: args.includes('--cdp'),
  cdp: valueOf('--cdp-url', process.env.CDP_URL || 'http://127.0.0.1:9222'),
  urlMatch: valueOf('--url-match', 'kt.ikui.vip'),
  gameRoot: valueOf('--game-root', process.env.GAME_ROOT || 'http://kt.ikui.vip'),
  emit: args.includes('--emit'),
  quiet: args.includes('--quiet'),
};

const log = (...a) => { if (!opt.quiet) console.log(...a); };
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// 1. 把 index.html 的内联脚本放进 vm，复用页面自己的解析函数与内置值
// ---------------------------------------------------------------------------
function loadPageModel() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) die('index.html 里找不到内联 <script>');

  const makeEl = () => new Proxy(function () {}, {
    get(t, k) {
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return t['_' + String(k)] ?? '';
      if (k === 'checked') return false;
      if (k === 'dataset') return {};
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (k === 'style') return {};
      if (k === 'children') return [];
      if (k === 'appendChild' || k === 'removeChild' || k === 'append' || k === 'remove') return () => {};
      if (k === 'querySelectorAll') return () => [];
      if (k === 'querySelector') return () => makeEl();
      if (k === 'getAttribute') return () => null;
      if (k === 'closest') return () => null;
      if (k === 'insertBefore') return () => {};
      if (k === 'setAttribute') return () => {};
      return makeEl();
    },
    set(t, k, v) { t['_' + String(k)] = v; return true; },
    apply() { return makeEl(); },
  });
  const store = {};
  const documentStub = {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
    body: makeEl(),
    documentElement: makeEl(),
    visibilityState: 'hidden',
  };
  const ctx = vm.createContext({
    document: documentStub,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    window: { addEventListener() {}, confirm: () => true, matchMedia: () => ({ matches: false }) },
    confirm: () => true,
    alert: () => {},
    navigator: { userAgent: 'node' },
  });
  ctx.globalThis = ctx;
  ctx.window.document = documentStub;
  process.on('unhandledRejection', () => {});
  vm.runInContext(m[1], ctx, { timeout: 20000 });
  const run = (code) => vm.runInContext(code, ctx, { timeout: 20000 });
  return {
    parseRoot: (root) => run(`parseVaultDefsFromRoot(${JSON.stringify(root)})`),
    builtin: run('JSON.parse(JSON.stringify(VAULT_DEFAULTS))'),
  };
}

// ---------------------------------------------------------------------------
// 2. 取线上数据：/api/data/defs（默认）、state 文件、或 CDP 里的登录态 state
// ---------------------------------------------------------------------------
const DEFS_TO_STATE_KEYS = {
  weaponVaultDefs: 'WEAPON_VAULT_DEFS',
  armorVaultDefs: 'ARMOR_VAULT_DEFS',
  offhandVaultDefs: 'OFFHAND_VAULT_DEFS',
  ringVaultDefs: 'RING_VAULT_DEFS',
  ringVaultSetBonuses: 'RING_VAULT_SET_BONUSES',
};

async function rootViaDefsApi() {
  const url = opt.gameRoot.replace(/\/+$/, '') + '/api/data/defs';
  log(`🌐 数据接口：${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`拉取 ${url} 失败：HTTP ${res.status}`);
  const defs = await res.json();
  if (!Array.isArray(defs.WEAPON_VAULT_DEFS)) die('接口里没有 WEAPON_VAULT_DEFS（上游结构变化？）');
  const root = {};
  for (const [outKey, inKey] of Object.entries(DEFS_TO_STATE_KEYS)) root[outKey] = defs[inKey];
  return { root, placeholdersFrom: defs.WEAPON_VAULT_DEFS };
}

async function rootViaStateFile() {
  log(`📄 state 文件：${opt.stateFile}`);
  const parsed = JSON.parse(fs.readFileSync(opt.stateFile, 'utf8'));
  const root = parsed.state && typeof parsed.state === 'object' ? parsed.state : parsed;
  return { root, placeholdersFrom: root.weaponVaultDefs };
}

async function stateViaCdp() {
  let targets;
  try {
    const res = await fetch(`${opt.cdp}/json/list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    targets = await res.json();
  } catch (e) {
    die(`连不上 CDP（${opt.cdp}）：${e.message}\n  用 --state <file> 提供本地 state，或用 --remote-debugging-port=9222 启动 Chrome。`);
  }
  const page = (targets || []).find((t) => t && t.type === 'page' && String(t.url || '').includes(opt.urlMatch));
  if (!page?.webSocketDebuggerUrl) {
    const seen = (targets || []).filter((t) => t && t.type === 'page').map((t) => `  · ${t.title} — ${t.url}`).join('\n');
    die(`没找到匹配 "${opt.urlMatch}" 的页面。当前页面：\n${seen || '  （无）'}`);
  }
  log(`🔌 CDP：${page.title}  ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable', {});
  const expr = `(async () => {
    const t = sessionStorage.getItem('game_token') || '';
    if (!t) return { err: '页面 sessionStorage 里没有 game_token（未登录？）' };
    const r = await fetch('/api/game/state', { headers: { Authorization: 'Bearer ' + t } });
    const text = await r.text();
    if (!r.ok) return { err: 'state HTTP ' + r.status + '：' + text.slice(0, 200) };
    return { json: text };
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  if (res.result?.exceptionDetails) die(`页面内执行出错：${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`);
  const val = res.result?.result?.value;
  if (!val || val.err) die(val ? val.err : 'CDP 未返回结果');
  return JSON.parse(val.json);
}

// ---------------------------------------------------------------------------
// 3. 比对 + 导出
// ---------------------------------------------------------------------------
const bonusKey = (b) => `${b.attr}=${b.flat}`;
const oneItem = (d) => `${d.id}[${d.quality || ''}]:${(d.bonuses || []).map(bonusKey).sort().join(',')}`;
const oneSet = (d) => `${d.id}:${d.pieceAttr}/${d.pieceFlat}/${d.setFlat}:`
  + Object.entries(d.pieces).sort().map(([k, v]) => `${k}=${v}`).join(',');
const oneRingSet = (d) => `${d.quality}:${(d.bonuses || []).map(bonusKey).sort().join(',')}`;

function diffSection(name, builtin, live, fmt) {
  const b = builtin.map(fmt);
  const l = live.map(fmt);
  const onlyB = b.filter((x) => !l.includes(x));
  const onlyL = l.filter((x) => !b.includes(x));
  if (builtin.length === live.length && !onlyB.length && !onlyL.length) {
    log(`  ✅ ${name}：${live.length} 项完全一致`);
    return 0;
  }
  console.log(`  ⚠ ${name}：内置 ${builtin.length} 项 / 线上 ${live.length} 项`);
  for (const x of onlyB) console.log(`      - 仅内置：${x}`);
  for (const x of onlyL) console.log(`      + 仅线上：${x}`);
  return 1;
}

async function main() {
  const model = loadPageModel();
  const builtin = model.builtin;
  log(`内置 VAULT_DEFAULTS：武器 ${builtin.weapon.length} · 盔甲 ${builtin.armor.length} 套 · 副手 ${builtin.offhand.length} · 指环 ${builtin.ring.length} · 集齐 ${builtin.ringSets.length}`);

  let source;
  if (opt.stateFile) source = await rootViaStateFile();
  else if (opt.useCdp) {
    const raw = await stateViaCdp();
    const root = raw && raw.state && typeof raw.state === 'object' ? raw.state : raw;
    source = { root, placeholdersFrom: root && root.weaponVaultDefs };
  } else source = await rootViaDefsApi();
  if (!source.placeholdersFrom && source.root) source.placeholdersFrom = source.root.weaponVaultDefs;

  // 用页面自己的解析函数（口径与「⬇ 从游戏导入」/ 接口自动更新逐字一致）
  const live = model.parseRoot(source.root);
  if (!live) die('解析失败：线上数据里没有有效的 weaponVaultDefs / armorVaultDefs / offhandVaultDefs');
  log(`线上解析：武器 ${live.weapon.length} · 盔甲 ${live.armor.length} 套 · 副手 ${live.offhand.length} · 指环 ${live.ring.length} · 集齐 ${live.ringSets.length}`);

  // 占位项（游戏尚未公布的「？？？」，bonuses 为空 → 页面导入与内置值都不收录）
  const placeholders = (source.placeholdersFrom || []).filter((d) => d && d.placeholder);
  if (placeholders.length) {
    log(`（游戏下发 ${placeholders.length} 个占位武器：${placeholders.map((d) => d.id).join('、')} —— bonuses 为空，按既有规则不收录）`);
  }

  let diff = 0;
  diff += diffSection('武器库', builtin.weapon, live.weapon, oneItem);
  diff += diffSection('副手库', builtin.offhand, live.offhand, oneItem);
  diff += diffSection('指环库', builtin.ring, live.ring, oneItem);
  diff += diffSection('盔甲库', builtin.armor, live.armor, oneSet);
  diff += diffSection('指环集齐加成', builtin.ringSets, live.ringSets, oneRingSet);

  if (opt.emit) {
    const j = (v, indent) => JSON.stringify(v, null, 2).replace(/\n/g, '\n' + indent);
    console.log('\n---- 线上解析结果（可直接替换 index.html 的 VAULT_DEFAULTS 对应分区）----');
    for (const [key, val] of [['weapon', live.weapon], ['offhand', live.offhand], ['armor', live.armor], ['ring', live.ring], ['ringSets', live.ringSets]]) {
      console.log(`${key}: ${j(val, '            ')}`);
    }
  }

  if (diff) {
    console.log(`\n✗ 内置值落后于线上：${diff} 个分区有差异。更新 index.html 的 VAULT_DEFAULTS 后重跑本脚本。`);
    process.exit(1);
  }
  console.log('\n✅ 内置收藏室数值与线上一致。');
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
