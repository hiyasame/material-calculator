#!/usr/bin/env node
// 校验 index.html「编程农场分享」页签里内嵌的两段控制台 JS：
//   node scripts/check-logicfarm-snippets.mjs              # 离线：语法 + 接口白名单 + 载荷结构
//   node scripts/check-logicfarm-snippets.mjs --cdp        # 追加：真跑导出段，拦下保存请求核对载荷
//   node scripts/check-logicfarm-snippets.mjs --cdp --write # 再原样回存一次，核对服务器接受且状态不变
//   node scripts/check-logicfarm-snippets.mjs --emit ./out # 把两段 JS 导出成文件，便于人工粘贴检查
//
// 为什么需要这个脚本：
//   两段 JS 是**给玩家贴进游戏页面 F12 控制台**用的，页面上看到的文本必须逐字可执行；
//   内嵌文本被模板字符串、转义或复制按钮改坏时页面上完全看不出来（只是贴进控制台报错）。
//   本脚本直接把 index.html 里的文本取出来编译，并可选地用 CDP 在真实游戏页面上验证：
//   导出段真跑（只读 state），应用段真跑但**拦下 logicFarmSave 请求**核对载荷与导出的电路
//   逐字一致；加 --write 才会真的把同一份电路原样回存一次（内容不变，用于确认服务器接受）。
//
// 退出码：0 = 通过；1 = 失败。

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
  useCdp: args.includes('--cdp'),
  write: args.includes('--write'),
  cdp: valueOf('--cdp-url', process.env.CDP_URL || 'http://127.0.0.1:9222'),
  urlMatch: valueOf('--url-match', 'kt.ikui.vip'),
  emit: valueOf('--emit', null),
};
if (opt.write && !opt.useCdp) { console.error('✗ --write 需要配合 --cdp'); process.exit(1); }

let pass = 0;
const ok = (name, extra) => { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`); };
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// 1. 从 index.html 取出内嵌的两段 JS
// ---------------------------------------------------------------------------
const html = fs.readFileSync(INDEX, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) die('index.html 里找不到内联 <script>');
const pageScript = scriptMatch[1];

try {
  new vm.Script(pageScript, { filename: 'index.html#inline' });
  ok('index.html 内联脚本语法正确');
} catch (e) {
  die(`index.html 内联脚本语法错误：${e.message}`);
}

function grab(name) {
  const re = new RegExp('const ' + name + ' = String\\.raw`([\\s\\S]*?)`;\\n');
  const m = pageScript.match(re);
  if (!m) die(`index.html 里找不到 ${name}`);
  return m[1];
}

const exportSnip = grab('LF_EXPORT_SNIPPET');
const applyTpl = grab('LF_APPLY_TEMPLATE');
ok('取出 LF_EXPORT_SNIPPET', `${exportSnip.length} 字符 / ${exportSnip.split('\n').length} 行`);
ok('取出 LF_APPLY_TEMPLATE', `${applyTpl.length} 字符 / ${applyTpl.split('\n').length} 行`);

// ---------------------------------------------------------------------------
// 2. 语法与关键结构
// ---------------------------------------------------------------------------
for (const [name, code] of [['导出段', exportSnip], ['应用段', applyTpl.replace('__PLAN__', '"PASTE_HERE"')]]) {
  try {
    new vm.Script(code, { filename: name });
    ok(`${name} 语法正确`);
  } catch (e) {
    die(`${name} 语法错误：${e.message}`);
  }
}

if (!applyTpl.includes('__PLAN__')) die('LF_APPLY_TEMPLATE 缺少 __PLAN__ 占位符');
ok('应用段含 __PLAN__ 占位符（由 refreshLogicFarmApply 注入电路）');

for (const [name, code] of [['导出段', exportSnip], ['应用段', applyTpl]]) {
  if (code.includes('`')) die(`${name} 里出现反引号，会撞坏页面里的 String.raw 模板`);
  if (code.includes('${')) die(`${name} 里出现 \${，会撞坏页面里的 String.raw 模板`);
}
ok('两段 JS 均不含反引号 / ${，可安全内嵌 String.raw');

// 只允许碰这两个接口：读状态 + 游戏自带的电路保存
const exportUrls = [...exportSnip.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
if (exportUrls.some((u) => u !== '/api/game/state')) die(`导出段访问了预期外的接口：${exportUrls.join(', ')}`);
ok('导出段只读 /api/game/state', exportUrls.join(', '));

const applyUrls = [...applyTpl.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
if (applyUrls.some((u) => u !== '/api/game/state' && u !== '/api/game/action')) die(`应用段访问了预期外的接口：${applyUrls.join(', ')}`);
if (!applyTpl.includes("'logicFarmSave'")) die('应用段没有走 logicFarmSave（游戏编辑器自动保存电路用的同一条接口）');
for (const field of ['nodes', 'wires', 'panX', 'panY', 'zoom']) {
  if (!new RegExp('\\b' + field + ':').test(applyTpl)) die(`应用段保存载荷缺少 ${field}`);
}
ok('应用段只访问 state / action，且 logicFarmSave 载荷含 nodes/wires/panX/panY/zoom');

if (/nodes\s*:\s*[^,]*\.(map|filter|slice)\(/.test(applyTpl) || applyTpl.includes('encodeCircuit')) {
  die('应用段对电路做了裁剪/重建：编程农场电路必须逐字原样往返');
}
ok('应用段不做字段裁剪（逐字原样往返）');

// 导入后必须自己把画布刷新出来：切走再切回编程农场（编辑器只在挂载时 loadCircuit 装载电路）
if (!applyTpl.includes('logicFarmHost')) die('应用段没有检查编辑器画布（logicFarmHost）');
if (!applyTpl.includes('.layer-btn')) die('应用段没有切换场景来重新装载电路（.layer-btn）');
if (!applyTpl.includes('location.reload')) die('应用段缺少「自动刷新失败时刷新整页」的兜底');
ok('应用段会自己刷新画布（切场景重挂 + 整页刷新兜底）');

const exportCircuit = exportSnip.match(/const circuit = JSON\.parse\(JSON\.stringify\(\{([\s\S]*?)\}\)\);/);
if (!exportCircuit) die('导出段找不到电路提取语句');
for (const field of ['nodes', 'wires', 'panX', 'panY', 'zoom']) {
  if (!exportCircuit[1].includes(field + ':')) die(`导出段没有原样取出 ${field}`);
}
ok('导出段原样取出 nodes/wires/panX/panY/zoom');

// ---------------------------------------------------------------------------
// 3. --emit：把两段 JS 落盘，便于人工核对/直接粘贴
// ---------------------------------------------------------------------------
if (opt.emit) {
  fs.mkdirSync(opt.emit, { recursive: true });
  fs.writeFileSync(path.join(opt.emit, 'logicfarm-export.js'), exportSnip);
  fs.writeFileSync(path.join(opt.emit, 'logicfarm-apply.js'), applyTpl.replace('__PLAN__', 'PASTE_HERE'));
  ok('已导出两段 JS', path.relative(ROOT, opt.emit));
}

// ---------------------------------------------------------------------------
// 4. --cdp：在真实游戏页面上验证（导出真跑、保存请求默认拦下）
// ---------------------------------------------------------------------------
if (opt.useCdp) {
  const list = await (await fetch(opt.cdp + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes(opt.urlMatch));
  if (!page) die(`CDP 里找不到含「${opt.urlMatch}」的页面（先带 --remote-debugging-port=9222 开浏览器并登录游戏）`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  const readLogicFarm = async () => JSON.parse(await evalJs(`(async () => {
    const TOKEN = sessionStorage.getItem('game_token') || '';
    return await (await fetch('/api/game/state', { headers: { Authorization: 'Bearer ' + TOKEN } })).text();
  })()`)).state.logicFarm;

  // 4a. 导出段真跑（只读）
  const plan = await evalJs(`(async () => { return await (${exportSnip}); })()`);
  if (!plan || !plan.circuit) die('导出段没有返回带 circuit 的方案');
  if (!Array.isArray(plan.circuit.nodes) || !Array.isArray(plan.circuit.wires)) die('导出段的 circuit 结构不正确');
  if (plan.counts.nodes !== plan.circuit.nodes.length || plan.counts.wires !== plan.circuit.wires.length) die('导出段统计与实际不一致');
  ok('导出段真跑通过', `节点 ${plan.counts.nodes} / 连线 ${plan.counts.wires} / 第 ${plan.stage} 关 / ${plan.cropName}`);

  const live = await readLogicFarm();
  if (JSON.stringify(live.nodes) !== JSON.stringify(plan.circuit.nodes)) die('导出的节点与服务器当前电路不一致');
  if (JSON.stringify(live.wires) !== JSON.stringify(plan.circuit.wires)) die('导出的连线与服务器当前电路不一致');
  ok('导出内容与服务器电路逐字一致');

  // 4b. 用导出的 JSON 生成应用段（与页面 refreshLogicFarmApply 完全一致），默认拦下 logicFarmSave
  const planJson = JSON.stringify(plan);
  const applyCode = applyTpl.replace('__PLAN__', () => JSON.stringify(planJson));
  await evalJs(`(() => {
    window.__lfdry = { captured: null, actions: [] };
    window.__lforigFetch = window.fetch;
    window.__lforigConfirm = window.confirm;
    // 只放行第 1 次 confirm（导入确认）；应用段末尾「刷新整页？」的 confirm 必须被拒，
    // 否则干跑会把玩家的游戏页面刷新掉
    let __lfConfirms = 0;
    window.confirm = () => (++__lfConfirms === 1);
    window.fetch = (url, opts) => {
      if (String(url).indexOf('/api/game/action') >= 0 && opts && typeof opts.body === 'string') {
        const body = JSON.parse(opts.body);
        window.__lfdry.actions.push(body.action);
        if (opts.body.indexOf('logicFarmSave') >= 0) {
          window.__lfdry.captured = opts.body;
          if (!${opt.write}) {
            return Promise.resolve(new Response(JSON.stringify({ ok: true, message: 'DRY-RUN', requestId: body.requestId }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
        }
      }
      return window.__lforigFetch(url, opts);
    };
    return true;
  })()`);
  let dry;
  try {
    await evalJs(`(async () => { return await (${applyCode}); })()`);
    dry = await evalJs('window.__lfdry');
  } finally {
    await evalJs('(() => { window.fetch = window.__lforigFetch; window.confirm = window.__lforigConfirm; return true; })()');
  }
  if (!dry.captured) die('应用段没有发出 logicFarmSave 请求');
  const body = JSON.parse(dry.captured);
  if (body.action !== 'logicFarmSave') die(`应用段的 action 不是 logicFarmSave：${body.action}`);
  const want = JSON.stringify({ nodes: plan.circuit.nodes, wires: plan.circuit.wires, panX: plan.circuit.panX, panY: plan.circuit.panY, zoom: plan.circuit.zoom });
  const got = JSON.stringify({ nodes: body.params.nodes, wires: body.params.wires, panX: body.params.panX, panY: body.params.panY, zoom: body.params.zoom });
  if (got !== want) die('应用段提交的电路与导出的电路不一致（逐字往返被破坏）');
  if (!Array.isArray(body.capabilities) || !body.capabilities.includes('compactFactoryActionV1')) die('保存请求缺少 capabilities');
  ok('应用段提交载荷与导出电路逐字一致', opt.write ? '（已真实回存）' : '（保存请求已拦下，未改动电路）');

  if (opt.write) {
    await new Promise((r) => setTimeout(r, 700));
    const after = await readLogicFarm();
    const same = JSON.stringify({ n: after.nodes, w: after.wires, x: after.panX, y: after.panY, z: after.zoom })
      === JSON.stringify({ n: live.nodes, w: live.wires, x: live.panX, y: live.panY, z: live.zoom });
    if (!same) die('原样回存后电路发生了变化（应当完全一致）');
    ok('原样回存后服务器电路不变（服务器接受该载荷）');
  }

  ws.close();
}

console.log(`\n结果：${pass} 项通过 / 0 失败`);
