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

ok(main.errors.length === 0, `主实例零运行时异常（实测 ${main.errors.length}）`);
ok(unhandled.length === 0, `零未处理 rejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`admin mahjong rules form probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('admin mahjong rules form probe: all checks passed');
