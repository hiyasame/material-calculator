// 无头测试：把 index.html 内联脚本放进 vm，校验「开拓农村 / 开拓工厂」的计算口径。
// 用法：node scripts/test-farm-model.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ---- 极简 DOM/浏览器桩：让 init() 能跑完（不care渲染结果） ----
function makeEl() {
  const el = new Proxy(function () {}, {
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
  return el;
}

const listeners = {};
const documentStub = {
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener: (k, fn) => { listeners[k] = fn; },
  body: makeEl(),
  documentElement: makeEl(),
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
  window: { addEventListener: () => {}, confirm: () => true, matchMedia: () => ({ matches: false }) },
  confirm: () => true,
  alert: () => {},
  navigator: { userAgent: 'node' },
});
ctx.globalThis = ctx;
ctx.window.document = documentStub;

process.on('unhandledRejection', () => {});

vm.runInContext(script, ctx, { timeout: 20000 });

const run = (code) => vm.runInContext(code, ctx, { timeout: 20000 });

let pass = 0;
let fail = 0;
function check(name, actual, expected, tol = 1e-9) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name} = ${actual}`); }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`); }
}

console.log('\n== 常量 ==');
check('baseOutput', run('VD.baseOutput'), 10);
check('maxLevel', run('VD.maxLevel'), 20);
check('maxStaff', run('VD.maxStaff'), 6);
check('salaryUnit', run('VD.salaryUnit'), 10000);
check('employee count', run('Object.keys(VD.employees).length'), 10);
check('bond count', run('VD.bonds.length'), 15);
check('building count', run('Object.keys(VD.buildings).length'), 9);

console.log('\n== 等级 / 编制 ==');
check('levelMult(1)', run('villageLevelMult(1)'), 1);
check('levelMult(20)', run('villageLevelMult(20)'), 4.8);
check('levelMult(10)', run('villageLevelMult(10)'), 2.8);
check('staffSlots(1)', run('villageStaffSlots(1)'), 1);
check('staffSlots(3)', run('villageStaffSlots(3)'), 3);
check('staffSlots(20)', run('villageStaffSlots(20)'), 6);

console.log('\n== 员工效率 / 时薪 ==');
run(`
  globalThis.mk = (typeId, payMult, extra) => Object.assign({ typeId, payMult: payMult == null ? 1 : payMult, onLeave: false, broken: false }, extra || {});
`);
check('normal eff @1.0', run('villageEfficiency(mk("normal"), [mk("normal")])'), 0.8);
check('normal eff @2.0', run('villageEfficiency(mk("normal",2), [mk("normal",2)])'), 1.6);
check('king salary @1.0', run('villageSalaryRate(mk("king"), [mk("king")])'), 7000);
check('king salary @2.0', run('villageSalaryRate(mk("king",2), [mk("king",2)])'), 14000);
check('robot salary', run('villageSalaryRate(mk("robot"), [mk("robot")])'), 0);
check('intern salary', run('villageSalaryRate(mk("intern"), [mk("intern")])'), 0);
check('machine salary', run('villageSalaryRate(mk("machine"), [mk("machine")])'), 0);
check('exp salary (negative)', run('villageSalaryRate(mk("exp"), [mk("exp")])'), -2000);
check('intern no raise (payMult ignored)', run('villageEfficiency(mk("intern",2), [mk("intern",2)])'), 0.85);
check('exp idle salary = 0', run('villageIdleSalary(mk("exp"))'), 0);
check('normal idle salary = 10%', run('villageIdleSalary(mk("normal"))'), 1000);

console.log('\n== 机器猪：硬编码叠加（与羁绊无关） ==');
check('1 machine eff', run('villageEfficiency(mk("machine"), [mk("machine")])'), 1.5);
check('2 machines eff', run('villageEfficiency(mk("machine"), [mk("machine"), mk("machine")])'), 1.75);
check('3 machines eff', run('villageEfficiency(mk("machine"), [mk("machine"), mk("machine"), mk("machine")])'), 2.0);
check('2 machines break chance', run('villageBreakChance([mk("machine"), mk("machine")])'), 0.1);

console.log('\n== 羁绊 ==');
check('nurse_care (2 nurses) reduces runaway', run('villageRunawayChance(mk("summer"), [mk("summer"), mk("normal"), mk("normal")])'), 0.02);
check('migrant_union salary x0.8', run('villageSalaryRate(mk("migrant"), [mk("migrant"), mk("migrant")])'), 8000);
check('mentor_lead +15% others', run('villageEfficiency(mk("normal"), [mk("elder"), mk("normal")])'), 0.8 * 1.15);
check('mentor_lead elder itself unchanged', run('villageEfficiency(mk("elder"), [mk("elder"), mk("normal")])'), 0.55);
check('wallstreet_greed ox +10%', run('villageEfficiency(mk("ox"), [mk("ox"), mk("ox"), mk("king")])'), 1.2 * 1.1);
check('cluster_overload is display-only (no eff change)', run('villageEfficiency(mk("machine"), [mk("machine"), mk("machine")])'), 1.75);
check('overclock x2 machine eff', run('villageEfficiency(mk("machine"), [mk("exp"), mk("machine")])'), 1.5 * 2);
check('overclock x2 break chance', run('villageBreakChance([mk("exp"), mk("machine")])'), 0.05 * 2);
check('lineage intern hours 24', run('villageBondActive([mk("elder"), mk("intern")], VD.bonds.find(b=>b.id==="lineage"))'), true);

console.log('\n== 建筑产出（含副产物 / 烧炭厂原料截断） ==');
check('oak Lv1 + 1 normal: main', run('villageBuildingOutput({ uid:1, defId:"oak", level:1, employees:[mk("normal")] }).mainAmt'), 8);
check('oak Lv1 + 1 normal: apple', run('villageBuildingOutput({ uid:1, defId:"oak", level:1, employees:[mk("normal")] }).rows[1].amount'), 4);
check('oak Lv20 + 6 king', run('villageBuildingOutput({ uid:1, defId:"oak", level:20, employees:[mk("king"),mk("king"),mk("king"),mk("king"),mk("king"),mk("king")] }).mainAmt'), 10 * 6 * 1.6 * 4.8);
check('on-leave produces nothing', run('villageBuildingOutput({ uid:1, defId:"oak", level:1, employees:[mk("normal",1,{onLeave:true})] }).mainAmt'), 0);
check('broken machine = 0', run('villageBuildingOutput({ uid:1, defId:"stone", level:1, employees:[mk("machine",1,{broken:true})] }).mainAmt'), 0);
// 烧炭厂：原料上限按员工逐个截断后求和（客户端行为）→ 2 人 + 库存 16 => 32
check('charcoal per-employee cap (2 emp, stock 16)', run('villageBuildingOutput({ uid:1, defId:"charcoal", level:20, employees:[mk("normal"),mk("normal")], inputStock:16 }).mainAmt'), 32);
check('charcoal uncapped when empty stock', run('villageBuildingOutput({ uid:1, defId:"charcoal", level:1, employees:[mk("normal")], inputStock:"" }).mainAmt'), 8);
check('staffSlots caps employees used', run('villageBuildingOutput({ uid:1, defId:"oak", level:1, employees:[mk("normal"),mk("normal"),mk("normal")] }).mainAmt'), 8);

console.log('\n== 升级成本 ==');
check('Lv1→2 金币', run('villageUpgradeTotals(2).gold'), 100000);
check('Lv1→11 金币', run('villageUpgradeTotals(11).gold'), [...Array(10)].reduce((s, _, i) => s + 50000 * (i + 2), 0));
check('Lv1→11 灰烬', run('villageUpgradeTotals(11).ash'), [...Array(10)].reduce((s, _, i) => s + 100 * (i + 2), 0));
check('Lv1→11 材料', run('villageUpgradeTotals(11).mat'), [...Array(10)].reduce((s, _, i) => s + 20 * (i + 2), 0));
check('Lv1 totals are zero', run('villageUpgradeTotals(1)'), { gold: 0, ash: 0, mat: 0 });

console.log('\n== 全规划汇总 ==');
run(`
  villagePlan = {
    name: 'test', overwork: 2,
    buildings: [
      { uid: 1, defId: 'oak', level: 1, landType: 'normal', inputStock: '', employees: [mk('normal')] },
      { uid: 2, defId: 'stone', level: 2, landType: 'nail', inputStock: '', employees: [mk('king')] },
    ],
    idlePool: [mk('normal'), mk('robot')],
  };
  globalThis.agg = villageAggregate();
`);
check('salary positive (10000 + 7000)', run('agg.salary.positive'), 17000);
check('salary idle (1000 + 0)', run('agg.salary.idle'), 1000);
check('salary net', run('agg.salary.net'), 18000);
check('land cost (1e5 + 1e6)', run('agg.cost.land'), 1100000);
check('build+upgrade gold (5e5 + 5e5 + 1e5)', run('agg.cost.gold'), 1100000);
check('ash (100 + 100 + Lv2 upgrade 200)', run('agg.cost.ash'), 400);
check('oakWood produced 8/hr', run('agg.materials.find(m=>m.id==="oakWood").amount'), 8);
check('stone produced by king Lv2', run('agg.materials.find(m=>m.id==="stone").amount'), 10 * 1.6 * 1.2);
check('apple byproduct 4/hr', run('agg.materials.find(m=>m.id==="apple").amount'), 4);
check('build materials cobblestone 20 + oakWood 20', run('agg.cost.mats.cobblestone'), 20);

console.log('\n== 加班加速：加班猪 / 猪特勤处不参与 ==');
// 游戏内「⏩ 加班加速」提示「加班猪与猪特勤处不参与」：
// 加班猪本人不产出、猪特勤处整座不参与；羁绊判定与同建筑其他员工照常。
run(`
  villagePlan = {
    name: 'accel', overwork: 3,
    buildings: [
      { uid: 1, defId: 'oak', level: 2, landType: 'normal', inputStock: '', employees: [mk('normal'), mk('king')] },
      { uid: 2, defId: 'pigOps', level: 3, landType: 'normal', inputStock: '', employees: [mk('normal')] },
    ],
    idlePool: [],
  };
  globalThis.aggA = villageAggregate();
  globalThis.dailyA = villageDailyTotals(aggA);
`);
// oak Lv2：护士 10×0.8×1.2 = 9.6/时；加班猪 10×1.6×1.2 = 19.2/时；苹果按 50% 副产物
check('oak /时 全员 9.6+19.2', run('aggA.materials.find(m=>m.id==="oakWood").amount'), 9.6 + 19.2);
check('oak /时 加速参与者仅护士 9.6', run('aggA.accelMaterials.oakWood'), 9.6);
check('apple /时 加速参与者 4.8', run('aggA.accelMaterials.apple'), 4.8);
check('oak /日 = 全员24h + 参与者3h', run('dailyA.materials.find(m=>m.id==="oakWood").perDay'), (9.6 + 19.2) * 24 + 9.6 * 3);
check('apple /日 = 全员24h + 参与者3h', run('dailyA.materials.find(m=>m.id==="apple").perDay'), (9.6 + 19.2) * 0.5 * 24 + 9.6 * 0.5 * 3);
check('仅加班猪的建筑：/时 > 0', run('villageBuildingOutput({uid:9,defId:"stone",level:1,employees:[mk("king")]}).mainAmt'), 16);
check('仅加班猪的建筑：加速产出 = 0', run('villageBuildingOutput({uid:9,defId:"stone",level:1,employees:[mk("king")]},{skipKing:true}).mainAmt'), 0);
check('猪特勤处无产出（不参与）', run('villageBuildingOutput({uid:9,defId:"pigOps",level:3,employees:[mk("normal")]})'), null);
// skipKing 只排除加班猪本人：老猪厉的「传帮带」仍给同建筑其他员工加成
check('skipKing 保留羁绊判定', run('villageBuildingOutput({uid:1,defId:"oak",level:3,employees:[mk("elder"),mk("king"),mk("normal")]},{skipKing:true}).mainAmt'), 10 * 1.4 * (0.55 + 0.8 * 1.15));
// 薪资同口径：加班猪与猪特勤处不拿那一小时工资
check('薪资 /时 全员 27000', run('aggA.salary.positive'), 27000);
check('薪资 /时 加速参与者 10000', run('aggA.salary.accelPositive'), 10000);
check('每日净支出 = 全员24h + 参与者3h', run('dailyA.salary.perDay'), 27000 * 24 + 10000 * 3);
check('每日小时数 27', run('dailyA.hours'), 27);
check('未使用加速时 /日 = /时×24', run(`
  villagePlan.overwork = 0;
  globalThis.dailyB = villageDailyTotals();
  dailyB.materials.find(m=>m.id==="oakWood").perDay === (9.6 + 19.2) * 24 && dailyB.salary.perDay === 27000 * 24;
`), true);

console.log('\n== 收藏室内置数据（2026-09-20 对齐游戏 state，scripts/check-vault-defs.mjs 可比对） ==');
check('武器库 13 件', run('VAULT_DEFAULTS.weapon.length'), 13);
check('副手库 7 件', run('VAULT_DEFAULTS.offhand.length'), 7);
check('指环库 22 枚 / 集齐加成 4 组', run('({ ring: VAULT_DEFAULTS.ring.length, sets: VAULT_DEFAULTS.ringSets.length })'), { ring: 22, sets: 4 });
check('菱念-皇切：格挡几率 +5% / 格挡伤害 +10', run('VAULT_DEFAULTS.weapon.find(w=>w.id==="lingnianHuangqie").bonuses'), [{ attr: 'blockChance', flat: 5 }, { attr: 'blockDmg', flat: 10 }]);
check('庇护剑：抗性提升 +2', run('VAULT_DEFAULTS.weapon.find(w=>w.id==="shelterSword").bonuses'), [{ attr: 'resistance', flat: 2 }]);
check('冥河：连射 +1', run('VAULT_DEFAULTS.offhand.find(o=>o.id==="mingheBow").bonuses'), [{ attr: 'multishot', flat: 1 }]);
run(`globalThis.pv = (stored) => computePanel({ slots: {}, vault: { stored }, custom: [] });`);
check('庇护剑入库 → 装备 Buff 抗性提升 Lv.2', run('pv({ shelterSword: 1 }).buffs.resistance'), 2);
check('未入库 → 无抗性提升', run('!!pv({}).buffs.resistance'), false);
check('冥河入库 → 面板连射 1', run('pv({ mingheBow: 1 }).stats.multishot'), 1);
check('极品指环集齐 → 伤害减免 5%', run('pv({ ancientCorpseKing: 1, glazedEmperor: 1, painSpider: 1 }).stats.dmgReducePct'), 5);

console.log('\n== 收藏室数据源优先级：导入 > 接口 > 内置 ==');
run(`
  globalThis.fakeDefs = {
    WEAPON_VAULT_DEFS: [{ id: 'x1', bonuses: [{ attr: 'physDmg', flat: 1, label: '+1' }] }],
    ARMOR_VAULT_DEFS: [{ id: 'a1', name: 'A', pieceAttr: 'maxHp', pieceFlat: 1, setFlat: 1, pieces: [
      { id: 'a1h', slot: 'helmet' }, { id: 'a1c', slot: 'chest' }, { id: 'a1l', slot: 'legs' }, { id: 'a1b', slot: 'boots' }] }],
    OFFHAND_VAULT_DEFS: [{ id: 'o1', bonuses: [{ attr: 'rangedDmg', flat: 1 }] }],
    RING_VAULT_DEFS: [{ id: 'r1', quality: 'odd', bonuses: [{ attr: 'dodge', flat: 1 }] }],
    RING_VAULT_SET_BONUSES: [{ quality: 'odd', label: 'x', bonuses: [{ attr: 'physRes', flat: 1 }] }],
  };
  globalThis.fakeDefsNoVault = { CONFIG: {} };
`);
check('接口下发可规范化', run('vaultDefsFromGameData(fakeDefs).weapon[0].id'), 'x1');
check('接口没有收藏室表时返回 null', run('vaultDefsFromGameData(fakeDefsNoVault)'), null);
check('无导入时接口优先于内置', run('applyVaultDefsFromGameData(fakeDefs) && vaultDefs.weapon.length === 1 && vaultDefs.weapon[0].id === "x1"'), true);
check('有导入数据时不被接口覆盖', run(`
  localStorage.setItem(VAULT_IMPORT_KEY, JSON.stringify(vaultDefs));
  const applied = applyVaultDefsFromGameData(fakeDefs);
  localStorage.removeItem(VAULT_IMPORT_KEY);
  !applied && vaultDefs.weapon[0].id === 'x1';
`), true);
check('无接口数据时回落内置兜底', run('loadVaultDefs(); vaultDefs.weapon.length'), 13);

console.log('\n== 工厂：配方 / 阶级 / 产率 / 燃料 ==');
check('recipe count', run('FD.recipes.length'), 18);
check('material count', run('Object.keys(FD.materials).length'), 30);
check('machine count', run('Object.keys(FD.machines).length'), 8);
check('tier oakWood = 0', run('factoryTierOf("oakWood")'), 0);
check('tier oakPlank = 1', run('factoryTierOf("oakPlank")'), 1);
check('tier mossBrick = 5', run('factoryTierOf("mossBrick")'), 5);
check('depth-1 rate: oakPlank per hour', run('(FD.recipes.find(r=>r.output.item==="oakPlank").output.count / FD.recipes.find(r=>r.output.item==="oakPlank").duration) * 3600'), 4800);
check('fuel values', run('({c:FD.materials.charcoal.fuelValue,b:FD.materials.burnCrystal.fuelValue,x:FD.materials.blazingCore.fuelValue})'), { c: 60, b: 30, x: 600 });
check('thermal machines need fuel', run('Object.values(FD.machines).filter(m=>m.needsFuel).map(m=>m.id).sort()'), ['thermal_mixer', 'thermal_press', 'thermal_roller']);
// mossBrick 展开：全部递归到原料
run(`
  globalThis.facc = { raw: {}, machineSec: {}, batches: {} };
  factoryExplode('mossBrick', 1, facc);
`);
check('mossBrick raw kinds >= 4', run('Object.keys(facc.raw).length >= 4'), true);
check('mossBrick has no product left in raw', run('Object.keys(facc.raw).every(id => !factoryRecipeOf(id))'), true);
check('mossBrick total raw mass > 1', run('Object.values(facc.raw).reduce((a,b)=>a+b,0) > 1'), true);
check('mossBrick machine seconds > 0', run('Object.values(facc.machineSec).reduce((a,b)=>a+b,0) > 0'), true);
// 单产物咖啡因：橡木板 1 件 = 1 批次 3s
run(`globalThis.a2 = { raw:{}, machineSec:{}, batches:{} }; factoryExplode('oakPlank', 4, a2);`);
check('4 planks need 1 oakWood', run('a2.raw.oakWood'), 1);
check('4 planks take 3s', run('a2.machineSec.cutter'), 3);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
