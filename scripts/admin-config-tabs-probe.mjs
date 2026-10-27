#!/usr/bin/env node
/**
 * 配置中心分域页签探针（2026-10-27）。
 * jsdom 加载 admin/index.html + app.js，桩 fetch/sessionStorage；覆盖：
 * 多页签域（斗地主/跑得快）、DOM 保留、空页签提示、切域复位、搜索扁平、单页签域。
 * 运行：node scripts/admin-config-tabs-probe.mjs（从仓库根执行）。
 */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1500, step = 20) {
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
const clickIf = (w, id) => clickEl(w, $(w, id));
const json = (status, body) => ({ status, json: async () => body });

const SNAPSHOT = {
  'game.doudizhu.enabled': true,
  'game.doudizhu.cardCounterEnabled': false,
  'game.doudizhu.cardCounterPricePerGameCoins': 10,
  'game.doudizhu.cardCounterPricePerHourCoins': 100,
  'game.doudizhu.freeRoomEnabled': true,
  'game.paodekuai.enabled': false,
  'game.paodekuai.twoPlayerEnabled': false,
  'game.paodekuai.freeRoomEnabled': true,
  'ad.reliefAdpid': 'adunit-1',
};

function makeDom() {
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
  window.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/admin/ad-channel')) {
      return json(200, { code: 0, data: { keys: [] } });
    }
    if (u.startsWith('/api/admin/config')) {
      const config = {};
      for (const [k, v] of Object.entries(SNAPSHOT)) config[k] = { value: v, version: 1 };
      return json(200, { code: 0, data: { config, version: 1 } });
    }
    return json(200, { code: 0, data: {} });
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', 'super_admin');
  window.eval(appJs);
  return { window, errors };
}

const { window, errors } = makeDom();
const tabs = () => qa(window, '#settings-rows .cfg-tabs .tab-btn');
const tabByText = (text) => tabs().find((b) => b.textContent === text);
const activeTabText = () => tabs().find((b) => b.classList.contains('active'))?.textContent;
const panel = (id) => q(window, `#settings-rows .cfg-tab-panel[data-tab="${id}"]`);
const keyCard = (key) => q(window, `#settings-rows [data-key="${key}"]`);
const visiblePanels = () => qa(window, '#settings-rows .cfg-tab-panel').filter((p) => !p.hidden);
const onlyVisible = (id) => {
  const v = visiblePanels();
  return v.length === 1 && v[0].dataset.tab === id;
};
const activeBtn = () => tabs().find((b) => b.classList.contains('active'));

ok(await waitFor(() => tabs().length > 0), '首屏渲染出页签条');
ok(tabs().length === 6, `斗地主 6 个页签（实测 ${tabs().length}）`);
ok(activeTabText() === '对局辅助', `默认页签=第一个有键页签（实测 ${activeTabText()}）`);
ok(panel('assist')?.hidden === false, 'assist 面板可见');
ok(panel('rooms')?.hidden === true, 'rooms 面板初始 hidden');
ok(onlyVisible('assist'), '同一时刻仅 assist 面板可见');
ok(keyCard('game.doudizhu.enabled') !== null, '斗地主开关键卡存在');

// DOM 保留：节点引用必须不变（排除 drafts 还原的假绿）
const storedInput = panel('assist')?.querySelector('[data-key="game.doudizhu.cardCounterEnabled"] input');
ok(storedInput != null, 'assist 面板含 cardCounter 复选框');
if (storedInput) {
  storedInput.checked = true;
  storedInput.dispatchEvent(new window.Event('change', { bubbles: true }));
}
ok(clickEl(window, tabByText('场次开关')), '点击场次开关页签');
await sleep(30);
ok(onlyVisible('rooms') && panel('assist')?.hidden === true, '切换后仅 rooms 面板可见');
ok(clickEl(window, tabByText('对局辅助')), '点击对局辅助页签');
await sleep(30);
ok(onlyVisible('assist'), '切回后仅 assist 面板可见');
ok(keyCard('game.doudizhu.enabled') !== null, '切页签后开关键卡仍在');
const currentInput = panel('assist')?.querySelector('[data-key="game.doudizhu.cardCounterEnabled"] input');
ok(currentInput != null && currentInput === storedInput && currentInput.checked === true, '切页签保留同一 DOM 节点与未保存值');

// 空页签提示
clickEl(window, tabByText('玩法规则'));
await sleep(30);
ok(panel('rules')?.hidden === false, 'rules 面板可见');
ok(onlyVisible('rules'), '同一时刻仅 rules 面板可见');
ok(tabByText('玩法规则')?.getAttribute('aria-selected') === 'true', 'active 页签 aria-selected=true');
ok(
  panel('rules')?.querySelector('.cfg-tab-empty')?.textContent.includes('本页签暂无可展示的键'),
  '空页签显示提示文案',
);

// 重复点当前域叶不重置页签
clickEl(window, tabByText('场次开关'));
await sleep(30);
ok(activeTabText() === '场次开关', '切到场次开关');
clickIf(window, 'nav-cfg-ddz-btn');
await sleep(30);
ok(activeTabText() === '场次开关', '重复点当前域叶不重置页签');

// 搜索：扁平结果、无页签条、跨域命中
const search = $(window, 'settings-search');
search.value = 'freeRoomEnabled';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(40);
ok(tabs().length === 0, '搜索态无页签条');
ok(keyCard('game.doudizhu.freeRoomEnabled') !== null, '搜索结果含斗地主的 freeRoomEnabled');
ok(keyCard('game.paodekuai.freeRoomEnabled') !== null, '搜索结果含跑得快的 freeRoomEnabled（跨域）');
search.value = 'zzz-no-such-key';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(40);
ok(tabs().length === 0, '零命中搜索无页签条');
ok(
  q(window, '#settings-rows .settings-empty')?.textContent.includes('没有匹配的配置键'),
  '零命中显示搜索空态',
);
search.value = '';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(40);
ok(tabs().length === 6, '清空搜索恢复页签条');
ok(activeTabText() === '场次开关', '清空搜索回到原域+原页签');

// 跨域同名页签：ddz 的 rooms 不得串到 pdk 的 rooms
clickIf(window, 'nav-cfg-pdk-btn');
await sleep(40);
ok(tabs().length === 6, '跑得快 6 个页签');
ok(activeTabText() === '开关', `跑得快默认=开关（实测 ${activeTabText()}）`);
ok(panel('switches')?.hidden === false, 'switches 面板可见');
ok(onlyVisible('switches'), '同一时刻仅 switches 面板可见');
ok(panel('rooms')?.hidden === true, 'pdk rooms 面板 hidden（未被 ddz 的 rooms 串选）');
ok(keyCard('game.paodekuai.enabled') !== null, '跑得快开关键卡存在');
ok(activeBtn()?.getAttribute('aria-selected') === 'true', '跑得快 active 页签 aria-selected=true');

// 重复点 active 页签：不重建 DOM（面板/条带/按钮节点均不变）
const activePanelBefore = panel('switches');
const stripBefore = q(window, '#settings-rows .cfg-tabs');
const btnBefore = activeBtn();
clickEl(window, tabByText('开关'));
await sleep(20);
ok(
  activePanelBefore != null &&
    panel('switches') === activePanelBefore &&
    q(window, '#settings-rows .cfg-tabs') === stripBefore &&
    activeBtn() === btnBefore,
  '重复点 active 页签不重建 DOM',
);

// 单页签域：无页签条
clickIf(window, 'nav-cfg-dataad-btn');
await sleep(60);
ok(tabs().length === 0, '广告域（单页签）无页签条');
ok(keyCard('ad.reliefAdpid') !== null, '广告键行渲染');
ok(
  q(window, '#settings-rows h3.settings-section')?.textContent === '广告位',
  '单页签域保留分区标题（广告位）',
);

ok(errors.length === 0, `零运行时异常（实测 ${errors.length}）`);
ok(unhandled.length === 0, `零未处理 rejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`admin config tabs probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('admin config tabs probe: all checks passed');
