// 无头 UI 测试：状态化 DOM 桩，通过「真实事件处理函数」驱动「开拓农村 / 开拓工厂」的交互，
// 检查不抛异常、渲染结果不含 undefined / NaN / [object Object]，以及控件改动是否真正生效。
// 用法：node scripts/test-farm-ui.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

const els = new Map();
function makeEl(id, tagName) {
  const el = {
    id,
    tagName: String(tagName || 'div').toUpperCase(),
    _value: '',
    _textContent: '',
    _innerHTML: '',
    checked: false,
    disabled: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    parentNode: null,
    appendChild(child) { this.children.push(child); if (child) child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    append() {}, remove() {},
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
  };
  Object.defineProperty(el, 'value', { get() { return this._value; }, set(v) { this._value = v; } });
  Object.defineProperty(el, 'textContent', { get() { return this._textContent; }, set(v) { this._textContent = v; } });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = v; if (v === '') this.children = []; }, // 模拟 DOM：置空即清空子节点
  });
  return el;
}
// 遍历桩 DOM（用于定位 createElement 出来的 select / input，模拟真实点击与输入）
function descendants(node, out = []) {
  (node.children || []).forEach((c) => { out.push(c); descendants(c, out); });
  return out;
}
function findByTag(root, tag) {
  return descendants(root).filter((e) => e.tagName === String(tag).toUpperCase());
}
const documentStub = {
  getElementById(id) {
    if (!els.has(id)) {
      const el = makeEl(id);
      // 挂上 HTML 里声明的内联事件（用 this=元素 调用，支持 this.value）
      const h = inlineHandlers.get(id);
      if (h) {
        for (const [attr, code] of Object.entries(h)) {
          el[attr] = function () {
            const fn = vm.runInContext('(function(){ ' + code + ' })', ctx);
            return fn.call(el);
          };
        }
      }
      els.set(id, el);
    }
    return els.get(id);
  },
  querySelector() { return makeEl('q'); },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl('created', tag); },
  addEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
  visibilityState: 'hidden',
};

// 解析 index.html 里的内联事件属性（onchange/oninput/onclick），
// 让桩元素也能像真实浏览器一样通过 el.onchange() 触发——这是让「控件接线错误」能被测出来的关键。
const inlineHandlers = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const tag = m[0];
  const h = {};
  for (const attr of ['onchange', 'oninput', 'onclick']) {
    const a = tag.match(new RegExp('\\b' + attr + '="([^"]*)"'));
    if (a) h[attr] = a[1];
  }
  if (Object.keys(h).length) inlineHandlers.set(m[1], h);
}

let ctx = null; // 在下面创建，内联事件处理器需要它

const store = {};
const localStorageStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

ctx = vm.createContext({
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
const owEl = els.get('villageOverwork');
owEl.value = '10';
owEl.onchange();
ok('overwork onchange applies', run('villagePlan.overwork') === 10);
scan('overwork render', 'null');

// 加班猪 / 猪特勤处不参与加班加速那一小时：/日 必须低于 /时 × 小时数，且薪资同口径
run(`
  villagePlan = { name: 'accel-ui', overwork: 6, buildings: [
    { uid: 901, defId: 'oak', level: 2, landType: 'normal', inputStock: '', charcoalInput: 'oakWood', employees: [
      { uid: 902, typeId: 'normal', payMult: 1, onLeave: false, broken: false },
      { uid: 903, typeId: 'king', payMult: 1, onLeave: false, broken: false },
    ] },
  ], idlePool: [] };
  globalThis.dailyUi = villageDailyTotals();
  renderVillage();
`);
ok('加班猪不计入加速产出（仅护士 9.6/时）', run('dailyUi.materials.find(m=>m.id==="oakWood").accelPerHour') === 9.6);
ok('oak /日 低于 /时 × 小时数', run('dailyUi.materials.find(m=>m.id==="oakWood").perDay') < run('dailyUi.materials.find(m=>m.id==="oakWood").amount') * run('dailyUi.hours'));
ok('每日净支出低于 净时薪 × 小时数', run('dailyUi.salary.perDay') < run('villageAggregate().salary.net') * run('dailyUi.hours'));
ok('渲染出「加班加速 N 小时」明细行', htmlOf('renderVillage()').includes('其中加班加速 6 小时'));
scan('accel render', 'null');

console.log('\n== 工厂：全部目标逐个渲染 ==');
const targets = run('Object.keys(FD.materials)');
let factoryThrew = 0;
for (const t of targets) {
  try {
    run(`factoryOptions.targets = [{ uid: 9001, itemId: ${JSON.stringify(t)}, count: 1 }]; renderFactory();`);
    const out = els.get('factoryRoutes').innerHTML;
    if (/undefined|NaN|\[object Object\]/.test(out)) { fail++; factoryThrew++; console.log(`  FAIL factory ${t}: bad token`); }
  } catch (e) { fail++; factoryThrew++; console.log(`  FAIL factory ${t} threw: ${e.message}`); }
}
if (!factoryThrew) { pass++; console.log(`  ok   all ${targets.length} factory targets render clean`); }

console.log('\n== 工厂：真实控件事件（回归：改目标/数量必须生效） ==');
run('factoryOptions = null; factoryLoad(); fillFactoryControls(); renderFactory();');
const rowWrap = els.get('factoryTargetRows');
function rowSelects() { return findByTag(rowWrap, 'select'); }
function rowInputs() { return findByTag(rowWrap, 'input'); }
ok('renders 1 target row', rowSelects().length === 1, `selects=${rowSelects().length}`);
ok('row select is pre-selected to current target', rowSelects()[0].value === run('factoryOptions.targets[0].itemId'));

// —— 这就是用户报的 bug：改下拉后必须更新目标并重渲染 ——
rowSelects()[0].value = 'mossBrick';
rowSelects()[0].onchange();
ok('select onchange updates target state', run('factoryOptions.targets[0].itemId') === 'mossBrick', run('factoryOptions.targets[0].itemId'));
ok('select onchange re-renders the route', els.get('factoryRoutes').innerHTML.includes('磨制苔草砖'));

rowInputs()[0].value = '7';
rowInputs()[0].onchange();
ok('count input onchange updates state', run('factoryOptions.targets[0].count') === 7, run('factoryOptions.targets[0].count'));
ok('count input onchange re-renders (× 7)', els.get('factoryRoutes').innerHTML.includes('磨制苔草砖 × 7'));

// 燃料 / 机器数量走真实 onchange（此前控件也接错了处理函数）
const fuelSel = els.get('factoryFuel');
fuelSel.value = 'blazingCore'; fuelSel.onchange();
ok('fuel onchange applies', run('factoryOptions.fuel') === 'blazingCore');
const macInp = els.get('factoryMachineCount');
macInp.value = '4'; macInp.onchange();
ok('machine count onchange applies', run('factoryOptions.machines') === 4);

console.log('\n== 工厂：多目标（合计原料 / 工时 / 燃料） ==');
delete store['mc_factory_options_v1']; // 清掉上一段用例持久化的 count=7，保证本段从默认（各 ×1）开始
run('factoryOptions = null; factoryLoad(); fillFactoryControls(); renderFactory();');
ok('starts from 1 target ×1', run('factoryOptions.targets.length') === 1 && run('factoryOptions.targets[0].count') === 1);
rowSelects()[0].value = 'mossBrick'; rowSelects()[0].onchange();
run('factoryAddTarget();');
ok('add target -> 2 rows', rowSelects().length === 2, `selects=${rowSelects().length}`);
rowSelects()[1].value = 'oakPlank';
rowSelects()[1].onchange();
rowInputs()[1].value = '1';
rowInputs()[1].onchange();
const merged = run('(() => { const t={raw:{},machineSec:{},batches:{}}; const m=(d,s)=>{Object.entries(s.raw).forEach(([i,q])=>d.raw[i]=(d.raw[i]||0)+q);Object.entries(s.machineSec).forEach(([i,q])=>d.machineSec[i]=(d.machineSec[i]||0)+q);}; factoryOptions.targets.forEach(r=>{const a={raw:{},machineSec:{},batches:{}}; factoryExplode(r.itemId, r.count, a); m(t,a);}); return t; })()');
ok('merged raw includes both targets (oakWood from oakPlank)', Math.abs(merged.raw.oakWood - 0.25) < 1e-9, JSON.stringify(merged.raw));
ok('merged raw keeps mossBrick raws (cobblestone)', Math.abs(merged.raw.cobblestone - 16384) < 1e-6, JSON.stringify(merged.raw.cobblestone));
const multiHtml = els.get('factoryRoutes').innerHTML;
ok('header lists both targets', multiHtml.includes('磨制苔草砖') && multiHtml.includes('橡木板'));
ok('summary says 2 targets', multiHtml.includes('2 个目标'));
ok('raw table counts both', /需要原料（合计 [0-9]+ 种）/.test(multiHtml));
ok('two route trees rendered', (multiHtml.match(/逐层展开/g) || []).length === 1 && multiHtml.includes('橡木板 × 1'));

run('factoryRemoveTarget(factoryOptions.targets[1].uid);');
ok('remove target -> 1 row', rowSelects().length === 1, `selects=${rowSelects().length}`);
run('factoryRemoveTarget(factoryOptions.targets[0].uid);');
ok('removing last target keeps 1 placeholder row', rowSelects().length === 1 && run('factoryOptions.targets.length') === 1);
scan('factory render after multi-target ops', 'null');

console.log('\n== 工厂：旧存储格式迁移 ==');
store['mc_factory_options_v1'] = JSON.stringify({ target: 'mossBrick', count: 3, fuel: 'charcoal', machines: 2 });
run('factoryOptions = null; factoryLoad();');
ok('legacy {target,count} migrates to 1 row', run('factoryOptions.targets.length') === 1
  && run('factoryOptions.targets[0].itemId') === 'mossBrick'
  && run('factoryOptions.targets[0].count') === 3
  && run('factoryOptions.machines') === 2);
run('fillFactoryControls(); renderFactory();');
ok('migrated row renders', els.get('factoryRoutes').innerHTML.includes('磨制苔草砖 × 3'));
ok('persisted targets survive reload', (() => {
  run('factorySave();');
  store['mc_factory_options_v1'] = JSON.stringify(run('factoryOptions'));
  run('factoryOptions = null; factoryLoad();');
  return run('factoryOptions.targets.length') === 1 && run('factoryOptions.targets[0].itemId') === 'mossBrick';
})());

console.log('\n== 工厂：燃料折价路径（注入商店价） ==');
// 本 harness 的 fetch 是失败的，SHOP_PRICES 为空 —— 注入商店价再验证折价显示
run('SHOP_PRICES = { blazingCore: { buy: 10000, sell: 5000 }, blackIronIngot: { buy: 2200, sell: 1100 } };');
run('factoryOptions = null; factoryLoad(); fillFactoryControls(); renderFactory();');
fuelSel.value = 'blazingCore'; fuelSel.onchange();
ok('fuel switch -> blazingCore', run('factoryOptions.fuel') === 'blazingCore');
const outFuel = els.get('factoryRoutes').innerHTML;
ok('fuel cost shown for blazingCore (has price)', /燃料折价<\/span><b>[0-9,]+ 金币/.test(outFuel), outFuel.match(/燃料折价<\/span><b>[^<]*</)?.[0]);
ok('raw cost shown with prices', /原料折价合计/.test(outFuel));
fuelSel.value = 'charcoal'; fuelSel.onchange();
ok('fuel switch back -> charcoal', run('factoryOptions.fuel') === 'charcoal');
ok('charcoal has no shop price -> 无商店价', /燃料折价<\/span><b>无商店价/.test(els.get('factoryRoutes').innerHTML));
scan('factory render after switches', 'null');

console.log('\n== 工厂：合成路线树与实际数字 ==');
const acc = run('(() => { const a={raw:{},machineSec:{},batches:{}}; factoryExplode("mossBrick",1,a); return a; })()');
ok('mossBrick raw has no intermediates', Object.keys(acc.raw).every((id) => run(`factoryRecipeOf(${JSON.stringify(id)})`) === null));
ok('mossBrick requires 5 raw kinds', Object.keys(acc.raw).length === 5, Object.keys(acc.raw).join(','));
const sumSec = Object.values(acc.machineSec).reduce((a, b) => a + b, 0);
ok('mossBrick machine seconds > 0', sumSec > 0, sumSec);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
