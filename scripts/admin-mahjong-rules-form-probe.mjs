#!/usr/bin/env node
/**
 * 四川麻将规则表单探针（2026-10-29）。
 * jsdom 加载真实 admin/index.html + app.js，桩 fetch/sessionStorage/confirm；
 * fetch 是**有状态**的：PUT 把**原始值**写回内存快照（版本另存），GET 返回最新值——
 * 否则验证不了保存后的重渲染，且双重包裹会让表单塌缩。
 * 运行：node scripts/admin-mahjong-rules-form-probe.mjs（仓库根）。
 */
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/client/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = process.cwd();
const html = readFileSync(`${ROOT}/admin/index.html`, 'utf8');
const appJs = readFileSync(`${ROOT}/admin/app.js`, 'utf8');

const failures = [];
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));
const ok = (cond, label) => {
  if (cond) console.log(`✓ ${label}`);
  else {
    failures.push(label);
    console.log(`✗ ${label}`);
  }
};
const same = (a, b) => {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}
const $ = (w, id) => w.document.getElementById(id);
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => [...w.document.querySelectorAll(sel)];
const clickEl = (w, node) => {
  if (!node) return false;
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return true;
};
const json = (status, body) => ({ status, json: async () => body });

/** 夹具与 protocol DEFAULT_CHENGDU_RULES 同形（探针专用；计数真源 = protocol 门禁）。 */
const RULES = {
  preset: 'chengdu',
  rulesVersion: 1,
  scoringPolicy: 'named',
  fanBase: 1,
  fanCap: 6,
  fanTable: {
    pingHu: 1, duiDuiHu: 2, qingYiSe: 3, daiYaoJiu: 3, qiDui: 3, qingDui: 4,
    jiangDui: 4, longQiDui: 5, qingQiDui: 5, qingYaoJiu: 5, qingLongQiDui: 6,
    gangShangHua: 1, gangShangPao: 1, qiangGangHu: 1, jinGouDiao: 1, gen: 1, ziMo: 1,
  },
  additiveFanTable: {},
  rootIncludesKong: false,
  selfDrawMode: 'addBase',
  minFanToHu: 0,
  exchangeThreeEnabled: true,
  exchangeDirection: 'random',
  lastFourForcedHu: true,
  passHuMode: 'sameTileOrHigherFan',
  directGangMode: 'contract',
  gangTransfer: 'toEachWinner',
  refundOnDraw: 'nonReadyAll',
  huazhuMode: 'payEach',
  huazhuPayees: 'active',
  chajiaoEnabled: true,
  chajiaoAllSameState: 'pay',
  optionalFans: {
    duanYaoJiu: 0, haiDi: 0, perGang: 0, shuangLong: 0,
    sanLong: 0, shiBaLuoHan: 0, tianHu: 0, diHu: 0,
  },
  claimWindowMs: 5000,
  exchangeWindowMs: 15000,
  lackWindowMs: 15000,
};

const SBR_RULES = {
  preset: 'sbr',
  rulesVersion: 1,
  scoringPolicy: 'additive',
  fanBase: 0,
  fanCap: 3,
  fanTable: {},
  additiveFanTable: {
    root: 1, allPungs: 1, goldenWait: 1, fullFlush: 2, sevenPairs: 2,
    winAfterKong: 1, shootAfterKong: 1, robbingKong: 1, underTheSea: 1,
  },
  rootIncludesKong: true,
  selfDrawMode: 'addPoint',
  minFanToHu: 0,
  exchangeThreeEnabled: false,
  exchangeDirection: 'random',
  lastFourForcedHu: true,
  passHuMode: 'sameTile',
  directGangMode: 'contract',
  gangTransfer: 'none',
  refundOnDraw: 'kongDeclarerOnly',
  huazhuMode: 'burn48',
  huazhuPayees: 'active',
  chajiaoEnabled: true,
  chajiaoAllSameState: 'none',
  optionalFans: {
    duanYaoJiu: 0, haiDi: 0, perGang: 0, shuangLong: 0,
    sanLong: 0, shiBaLuoHan: 0, tianHu: 0, diHu: 0,
  },
  claimWindowMs: 5000,
  exchangeWindowMs: 15000,
  lackWindowMs: 15000,
};

function baseSnapshot(rules) {
  return {
    'game.doudizhu.enabled': true,
    'game.paodekuai.enabled': false,
    'game.mahjong.enabled': true,
    'game.levels.mahjong': [
      { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
      { name: '标准场', baseScore: 80, entryFeePercent: 0 },
    ],
    'game.mahjong.rules': rules,
  };
}

function makeDom(snapshot) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message ?? e)));
  const dom = new JSDOM(html, {
    url: 'https://localhost/admin/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.confirm = () => true;
  const state = { snapshot: JSON.parse(JSON.stringify(snapshot)), versions: {}, lastPut: null };
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/admin/config/') && method === 'PUT') {
      const key = decodeURIComponent(u.slice('/api/admin/config/'.length));
      const body = JSON.parse(opts.body);
      state.lastPut = { key, body };
      state.snapshot[key] = body.value;
      state.versions[key] = (state.versions[key] ?? 1) + 1;
      return json(200, { code: 0, data: { version: state.versions[key], announced: true } });
    }
    if (u.startsWith('/api/admin/config')) {
      const config = {};
      for (const [k, v] of Object.entries(state.snapshot)) {
        config[k] = { value: v, version: state.versions[k] ?? 1 };
      }
      return json(200, { code: 0, data: { config, version: 1 } });
    }
    return json(200, { code: 0, data: {} });
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', 'super_admin');
  window.eval(appJs);
  return { window, state, errors };
}

async function openMahjong(dom) {
  await waitFor(() => $(dom.window, 'nav-cfg-mahjong-btn'));
  // 等 boot 的异步 loadAll 落定再点叶：快照为空时点叶会被 normalizeCfgDomain
  // 回退到第一个有键域（ddz），规则卡就渲染不出来（与表单实现无关的启动竞态）。
  await waitFor(() => q(dom.window, '#settings-rows [data-key]'));
  clickEl(dom.window, $(dom.window, 'nav-cfg-mahjong-btn'));
  await waitFor(() => q(dom.window, '[data-key="game.mahjong.rules"]'));
}
const cardOf = (w) => q(w, '[data-key="game.mahjong.rules"]');
const fieldOf = (w, p) => cardOf(w)?.querySelector(`[data-field="${p}"]`);
const saveBtnOf = (w) => cardOf(w)?.querySelector('.struct-foot .btn.primary');
const footStateOf = (w) => cardOf(w)?.querySelector('.row-state');
/** 保存成功的判据：版本徽标变成 v<N>（loadAll 重渲染落定）。 */
const waitVersion = (w, v) =>
  waitFor(() => cardOf(w)?.querySelector('.struct-ver')?.textContent === `v${v}`);
/** 文本/数字控件听 input，select 听 change——两个事件都发。 */
const setInput = (node, value) => {
  node.value = String(value);
  node.dispatchEvent(new node.ownerDocument.defaultView.Event('input', { bubbles: true }));
  node.dispatchEvent(new node.ownerDocument.defaultView.Event('change', { bubbles: true }));
};

/* ── 主实例：渲染 + 保存 + D9 + 越界 ─────────────────────── */
const main = makeDom(baseSnapshot(RULES));
await openMahjong(main);
const w = main.window;

ok(qa(w, '#settings-rows .mj-group').length === 8, `8 个分组（实测 ${qa(w, '#settings-rows .mj-group').length}）`);
ok(qa(w, '#settings-rows .mj-field').length === 20, `20 个字段控件（实测 ${qa(w, '#settings-rows .mj-field').length}）`);
ok(qa(w, '#settings-rows .mj-fan-row').length === 34, `34 个番表输入（实测 ${qa(w, '#settings-rows .mj-fan-row').length}）`);
ok(fieldOf(w, 'fanCap')?.querySelector('input')?.value === '6', 'fanCap 初值 6');
ok(fieldOf(w, 'huazhuMode')?.querySelector('select')?.value === 'payEach', 'huazhuMode 初值 payEach');
ok(fieldOf(w, 'fanTable.pingHu')?.querySelector('input')?.value === '1', '番表 pingHu 初值 1');
ok(q(w, '#settings-rows .mj-fan-group')?.tagName === 'DETAILS', '番表组是折叠 details');

// 保存 1：只改三处
setInput(fieldOf(w, 'fanCap').querySelector('input'), '7');
setInput(fieldOf(w, 'huazhuMode').querySelector('select'), 'burn48');
setInput(fieldOf(w, 'fanTable.pingHu').querySelector('input'), '2');
main.state.lastPut = null;
clickEl(w, saveBtnOf(w));
await waitVersion(w, 2);
const expected1 = JSON.parse(JSON.stringify(RULES));
expected1.fanCap = 7;
expected1.huazhuMode = 'burn48';
expected1.fanTable.pingHu = 2;
ok(main.state.lastPut?.key === 'game.mahjong.rules', 'PUT 命中规则键');
ok(same(main.state.lastPut?.body.value, expected1), '保存 body = 快照 + 三处改动');
ok(main.state.lastPut?.body.value.preset === 'chengdu', '保存不改变 preset（D3）');

// D9：存在的番键清空 ⇒ 写 0
setInput(fieldOf(w, 'fanTable.pingHu').querySelector('input'), '');
main.state.lastPut = null;
clickEl(w, saveBtnOf(w));
await waitVersion(w, 3);
ok(main.state.lastPut?.body.value.fanTable.pingHu === 0, '清空已存在的番键 ⇒ 写 0');

// 越界 ⇒ 行内红字、不发请求（v3 已落定，无在途重渲染）
setInput(fieldOf(w, 'fanCap').querySelector('input'), '9');
main.state.lastPut = null;
clickEl(w, saveBtnOf(w));
await sleep(50);
ok(main.state.lastPut === null, '越界不发请求');
ok(footStateOf(w)?.textContent.includes('封顶番数'), '越界错误写到卡片状态行');
ok(fieldOf(w, 'fanCap').querySelector('.mj-field-err')?.textContent.includes('须为'), '字段行内红字');
setInput(fieldOf(w, 'fanCap').querySelector('input'), '6');

/* ── 护栏（主实例：chengdu）────────────────────────────── */
setInput(fieldOf(w, 'scoringPolicy').querySelector('select'), 'additive');
ok(
  qa(w, '#settings-rows .mj-warn').some((n) => n.textContent.includes('0 番')),
  '加法番表全 0 时出黄条',
);
setInput(fieldOf(w, 'scoringPolicy').querySelector('select'), 'named');
setInput(fieldOf(w, 'minFanToHu').querySelector('input'), '6');
setInput(fieldOf(w, 'fanCap').querySelector('input'), '3');
ok(
  qa(w, '#settings-rows .mj-warn').some((n) => n.textContent.includes('永远无法胡牌')),
  '起胡番高于封顶番时出黄条',
);
setInput(fieldOf(w, 'minFanToHu').querySelector('input'), '0');
setInput(fieldOf(w, 'fanCap').querySelector('input'), '6');

/* ── 预设重置 + D3 加强（独立实例）───────────────────────── */
ok(q(w, '#mj-reset-preset') !== null, '预设重置下拉存在');
ok(cardOf(w)?.textContent.includes('按预设重置全部规则'), '重置按钮文案');
setInput(q(w, '#mj-reset-preset'), 'sbr');
main.state.lastPut = null;
clickEl(w, saveBtnOf(w));
await waitVersion(w, 4);
ok(main.state.lastPut?.body.value.preset === 'chengdu', '切下拉不改变保存的 preset（D3）');

const resetDom = makeDom(baseSnapshot(RULES));
await openMahjong(resetDom);
setInput(q(resetDom.window, '#mj-reset-preset'), 'sbr');
resetDom.state.lastPut = null;
clickEl(resetDom.window, q(resetDom.window, '#mj-reset-preset').closest('.mj-preset-bar').querySelector('.btn'));
await waitFor(() => resetDom.state.lastPut !== null);
ok(
  same(resetDom.state.lastPut?.body.value, { preset: 'sbr', rulesVersion: 1 }),
  "重置 body 恰为 {preset:'sbr', rulesVersion:1}",
);
await waitFor(() => cardOf(resetDom.window)?.textContent.includes('当前预设：SBR 竞技近似'));
ok(cardOf(resetDom.window)?.textContent.includes('当前预设：SBR 竞技近似'), '重置后按新预设重渲染');
ok(resetDom.errors.length === 0, `重置实例零异常（实测 ${resetDom.errors.length}）`);

/* ── sbr 实例：清空加法番表 ⇒ 实时黄条 + D9 写 0 + 不存在的表省略 ── */
const sbrDom = makeDom(baseSnapshot(SBR_RULES));
await openMahjong(sbrDom);
ok(
  qa(sbrDom.window, '#settings-rows .mj-warn').length === 0,
  'sbr 初始无黄条',
);
for (const fanKey of ['root', 'allPungs', 'goldenWait', 'fullFlush', 'sevenPairs', 'winAfterKong', 'shootAfterKong', 'robbingKong', 'underTheSea']) {
  const input = q(sbrDom.window, `[data-field="additiveFanTable.${fanKey}"] input`);
  setInput(input, '');
}
ok(
  qa(sbrDom.window, '#settings-rows .mj-warn').some((n) => n.textContent.includes('0 番')),
  '清空加法番表后实时出黄条',
);
sbrDom.state.lastPut = null;
clickEl(sbrDom.window, saveBtnOf(sbrDom.window));
await waitVersion(sbrDom.window, 2);
ok(
  same(sbrDom.state.lastPut?.body.value.additiveFanTable, {
    root: 0, allPungs: 0, goldenWait: 0, fullFlush: 0, sevenPairs: 0,
    winAfterKong: 0, shootAfterKong: 0, robbingKong: 0, underTheSea: 0,
  }),
  'sbr 清空加法番键 ⇒ 全部写 0',
);
ok(
  same(sbrDom.state.lastPut?.body.value.fanTable, {}),
  '不存在的番表键 + 空输入 ⇒ 省略（不写入任何键）',
);
ok(sbrDom.errors.length === 0, `sbr 实例零异常（实测 ${sbrDom.errors.length}）`);

/* ── 全 0 命名表 ⇒ 护栏 2 ─────────────────────────────── */
const zeroNamed = JSON.parse(JSON.stringify(RULES));
for (const k of Object.keys(zeroNamed.fanTable)) zeroNamed.fanTable[k] = 0;
const zeroDom = makeDom(baseSnapshot(zeroNamed));
await openMahjong(zeroDom);
ok(
  qa(zeroDom.window, '#settings-rows .mj-warn').some((n) => n.textContent.includes('命名番表为空')),
  '命名番表全 0 时出黄条',
);
ok(zeroDom.errors.length === 0, `全 0 实例零异常（实测 ${zeroDom.errors.length}）`);

/* ── 版本错位自救 ─────────────────────────────────────── */
// A. 未知顶层键：透传 + 移除
{
  const rules = JSON.parse(JSON.stringify(RULES));
  rules.xyzFutureSwitch = true;
  const dom = makeDom(baseSnapshot(rules));
  await openMahjong(dom);
  const cw = dom.window;
  ok(cardOf(cw).textContent.includes('未认识的新字段'), '未知键信息条出现');
  ok(cardOf(cw).textContent.includes('xyzFutureSwitch'), '信息条列出未知键名');
  dom.state.lastPut = null;
  clickEl(cw, saveBtnOf(cw));
  await waitVersion(cw, 2);
  ok(dom.state.lastPut?.body.value.xyzFutureSwitch === true, '未知键原样透传');
  const dropBtn = [...cardOf(cw).querySelectorAll('.mj-banner .btn')].find(
    (b) => b.textContent === '移除这些未知字段并保存',
  );
  dom.state.lastPut = null;
  clickEl(cw, dropBtn);
  await waitVersion(cw, 3);
  ok(!('xyzFutureSwitch' in (dom.state.lastPut?.body.value ?? {})), '移除后保存 body 不含未知键');
  ok(dom.errors.length === 0, `未知键实例零异常（实测 ${dom.errors.length}）`);
}

// B. 快照缺字段：隐藏 + 补齐
{
  const rules = JSON.parse(JSON.stringify(RULES));
  delete rules.claimWindowMs;
  const dom = makeDom(baseSnapshot(rules));
  await openMahjong(dom);
  const cw = dom.window;
  ok(cardOf(cw).querySelector('[data-field="claimWindowMs"]') === null, '缺失字段不渲染');
  ok(cardOf(cw).textContent.includes('缺少 1 个规则字段'), '缺失字段信息条出现');
  const fillBtn = [...cardOf(cw).querySelectorAll('.mj-banner .btn')].find(
    (b) => b.textContent === '按服务端默认补齐',
  );
  dom.state.lastPut = null;
  clickEl(cw, fillBtn);
  await waitVersion(cw, 2);
  ok(dom.state.lastPut?.body.value.claimWindowMs === undefined, '补齐 PUT = 原快照（不含缺失字段）');
  ok(dom.errors.length === 0, `缺字段实例零异常（实测 ${dom.errors.length}）`);
}

ok(main.errors.length === 0, `主实例零运行时异常（实测 ${main.errors.length}）`);
ok(unhandled.length === 0, `零未处理 rejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`admin mahjong rules form probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('admin mahjong rules form probe: all checks passed');
