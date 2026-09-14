// 无头 UI 测试：状态化 DOM 桩，逐个调用「开拓农村 / 开拓工厂」的交互函数，
// 检查不抛异常、渲染结果不含 undefined / NaN / [object Object]。
// 用法：node scripts/test-farm-ui.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

const els = new Map();
function makeEl(id) {
  const el = {
    id,
    _value: '',
    _textContent: '',
    _innerHTML: '',
    checked: false,
    disabled: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    appendChild() {}, removeChild() {}, append() {}, remove() {},
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
  };
  Object.defineProperty(el, 'value', { get() { return this._value; }, set(v) { this._value = v; } });
  Object.defineProperty(el, 'textContent', { get() { return this._textContent; }, set(v) { this._textContent = v; } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._innerHTML; }, set(v) { this._innerHTML = v; } });
  return el;
}
const documentStub = {
  getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  querySelector() { return makeEl('q'); },
  querySelectorAll() { return []; },
  createElement() { return makeEl('new'); },
  addEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
  visibilityState: 'hidden',
};

const store = {};
const localStorageStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const ctx = vm.createContext({
  document: documentStub,
  localStorage: localStorageStub,
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

vm.runInContext(script, ctx, { timeout: 20000 });
const run = (code) => vm.runInContext(code, ctx, { timeout: 20000 });

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 400) : ''}`); }
}
function htmlOf(fn) {
  return run(`(() => { ${fn}; return document.getElementById('villagePlan').innerHTML + document.getElementById('factoryRoutes').innerHTML; })()`);
}
function scan(name, fn) {
  let out = '';
  try { out = htmlOf(fn); } catch (e) { fail++; console.log(`  FAIL ${name} threw: ${e.message}`); return; }
  const bad = [];
  if (/undefined/.test(out)) bad.push('undefined');
  if (/NaN/.test(out)) bad.push('NaN');
  if (/\[object Object\]/.test(out)) bad.push('[object Object]');
  if (/null/.test(out)) bad.push('null');
  ok(name, bad.length === 0, bad.length ? `bad tokens: ${bad.join(',')} in ${out.slice(Math.max(0, out.search(/undefined|NaN|\[object|null/) - 80), out.search(/undefined|NaN|\[object|null/) + 120)}` : '');
}

console.log('\n== 农村：初始渲染 ==');
run('villageLoad(); renderVillage();');
scan('initial render clean', 'null');

console.log('\n== 农村：增删改 ==');
run('villageAddBuilding();');
ok('add building -> 2', run('villagePlan.buildings.length') === 2);
scan('after add', 'null');
run('villageSelectBuilding(villagePlan.buildings[1].uid); villageSetBuildingDef(villagePlan.buildings[1].uid, "charcoal"); villageSetLevel(villagePlan.buildings[1].uid, 20);');
ok('charcoal level 20', run('villageFind(villagePlan.buildings[1].uid).level') === 20);
scan('charcoal building render', 'null');
run('villageSetCharcoalInput(villagePlan.buildings[1].uid, "birchWood"); villageSetInputStock(villagePlan.buildings[1].uid, 12);');
scan('charcoal with stock 12', 'null');
run('villageSetEmployee(villagePlan.buildings[1].uid, 0, "normal");');
const charOut = run('villageBuildingOutput(villageFind(villagePlan.buildings[1].uid))');
ok('charcoal output capped by stock 12 (1 emp)', charOut.mainAmt === 12, JSON.stringify(charOut.mainAmt));
run('villageSetEmployee(villagePlan.buildings[1].uid, 1, "normal");');
const charOut2 = run('villageBuildingOutput(villageFind(villagePlan.buildings[1].uid))');
ok('charcoal cap is per-employee then summed (2 emp, stock 12) => 24', charOut2.mainAmt === 24, JSON.stringify(charOut2.mainAmt));
run('villageRemoveBuilding(villagePlan.buildings[1].uid);');
ok('remove building -> 1', run('villagePlan.buildings.length') === 1);

console.log('\n== 农村：员工操作 ==');
run('villageSetEmployee(villagePlan.buildings[0].uid, 0, "king");');
ok('slot 0 is king', run('villageFind(villagePlan.buildings[0].uid).employees[0].typeId') === 'king');
run('villagePayStep(villagePlan.buildings[0].uid, 0, 1);');
ok('payMult 1.1', Math.abs(run('villageFind(villagePlan.buildings[0].uid).employees[0].payMult') - 1.1) < 1e-9);
for (let i = 0; i < 20; i++) run('villagePayStep(villagePlan.buildings[0].uid, 0, 1);');
ok('payMult capped at 2', run('villageFind(villagePlan.buildings[0].uid).employees[0].payMult') === 2);
for (let i = 0; i < 30; i++) run('villagePayStep(villagePlan.buildings[0].uid, 0, -1);');
ok('payMult floored at 1', run('villageFind(villagePlan.buildings[0].uid).employees[0].payMult') === 1);
run('villageToggleLeave(villagePlan.buildings[0].uid, 0);');
ok('onLeave true', run('villageFind(villagePlan.buildings[0].uid).employees[0].onLeave') === true);
scan('on-leave render', 'null');
run('villageToggleLeave(villagePlan.buildings[0].uid, 0);');
run('villageSetLevel(villagePlan.buildings[0].uid, 6); villageSetEmployee(villagePlan.buildings[0].uid, 1, "machine"); villageToggleBroken(villagePlan.buildings[0].uid, 1);');
ok('machine broken', run('villageFind(villagePlan.buildings[0].uid).employees[1].broken') === true);
scan('broken machine render', 'null');
run('villageSetLevel(villagePlan.buildings[0].uid, 1);');
scan('level drop below employee count (超编警告)', 'null');

console.log('\n== 农村：待业 / 空规划 / 设地块 ==');
run('villageAddIdle("normal"); villageAddIdle("exp"); villageAddIdle("robot");');
ok('idle pool 3', run('villagePlan.idlePool.length') === 3);
scan('idle render', 'null');
run('villageRemoveIdle(villagePlan.idlePool[0].uid);');
run('villageSetLand(villagePlan.buildings[0].uid, "superNail");');
ok('land price applied', run('villageAggregate().cost.land') >= 2000000);
scan('superNail land render', 'null');
run('villagePlan.buildings = []; renderVillage();');
scan('empty plan render', 'null');
run('villageResetPlan();');
ok('reset -> 1 building', run('villagePlan.buildings.length') === 1);
scan('after reset', 'null');

console.log('\n== 农村：加班加速换算 ==');
run('document.getElementById("villageOverwork").value = "10"; onVillageOptionChange();');
ok('overwork 10', run('villagePlan.overwork') === 10);
scan('overwork render', 'null');

console.log('\n== 工厂：全部目标逐个渲染 ==');
const targets = run('Object.keys(FD.materials)');
let factoryThrew = 0;
for (const t of targets) {
  try {
    run(`factoryOptions.target = ${JSON.stringify(t)}; renderFactory();`);
    const out = els.get('factoryRoutes').innerHTML;
    if (/undefined|NaN|\[object Object\]/.test(out)) { fail++; factoryThrew++; console.log(`  FAIL factory ${t}: bad token`); }
  } catch (e) { fail++; factoryThrew++; console.log(`  FAIL factory ${t} threw: ${e.message}`); }
}
if (!factoryThrew) { pass++; console.log(`  ok   all ${targets.length} factory targets render clean`); }

console.log('\n== 工厂：机器数量 / 燃料切换 ==');
run('document.getElementById("factoryCount").value = "64"; document.getElementById("factoryMachineCount").value = "4"; onFactoryOptionChange();');
ok('count 64 / machines 4', run('factoryOptions.count') === 64 && run('factoryOptions.machines') === 4);
run('document.getElementById("factoryFuel").value = "blazingCore"; onFactoryOptionChange();');
ok('fuel switch -> blazingCore', run('factoryOptions.fuel') === 'blazingCore');
// 本 harness 的 fetch 是失败的，SHOP_PRICES 为空 —— 先注入商店价再验证「燃料折价」路径
run('SHOP_PRICES = { blazingCore: { buy: 10000, sell: 5000 }, blackIronIngot: { buy: 2200, sell: 1100 } };');
run('renderFactory();');
const outFuel = els.get('factoryRoutes').innerHTML;
ok('fuel cost shown for blazingCore (has price)', /燃料折价<\/span><b>[0-9,]+ 金币/.test(outFuel), outFuel.match(/燃料折价<\/span><b>[^<]*</)?.[0]);
ok('raw cost shown with prices', /原料折价合计/.test(outFuel));
run('document.getElementById("factoryFuel").value = "charcoal"; onFactoryOptionChange();');
ok('fuel switch back -> charcoal', run('factoryOptions.fuel') === 'charcoal');
const outFuel2 = els.get('factoryRoutes').innerHTML;
ok('charcoal has no shop price -> 无商店价', /燃料折价<\/span><b>无商店价/.test(outFuel2));
scan('factory render after switches', 'null');

console.log('\n== 工厂：合成路线树与实际数字 ==');
run('factoryOptions.target = "mossBrick"; factoryOptions.count = 1; factoryOptions.machines = 1; renderFactory();');
const acc = run('(() => { const a={raw:{},machineSec:{},batches:{}}; factoryExplode("mossBrick",1,a); return a; })()');
ok('mossBrick raw has no intermediates', Object.keys(acc.raw).every((id) => run(`factoryRecipeOf(${JSON.stringify(id)})`) === null));
ok('mossBrick requires 5 raw kinds', Object.keys(acc.raw).length === 5, Object.keys(acc.raw).join(','));
const sumSec = Object.values(acc.machineSec).reduce((a, b) => a + b, 0);
ok('mossBrick machine seconds > 0', sumSec > 0, sumSec);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
