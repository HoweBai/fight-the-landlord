#!/usr/bin/env node
/**
 * 代理工作台页签探针（2026-10-26）。
 * jsdom 加载 admin/index.html + app.js，桩 fetch/sessionStorage；覆盖：
 * 单入口 + 6 页签、按页签懒加载、finance 只读、operator 不可达、登出复位。
 * 运行：node scripts/admin-agents-probe.mjs（从仓库根执行）。
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
const $ = (w, id) => w.document.getElementById(id);
const clickIf = (w, id) => {
  const node = $(w, id);
  if (!node) return false;
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return true;
};
const json = (status, body) => ({ status, json: async () => body });

const hits = new Map();
const bump = (k) => hits.set(k, (hits.get(k) ?? 0) + 1);
const countOf = (k) => hits.get(k) ?? 0;

const SETTINGS = {
  enabled: false,
  defaultRateBp: 500,
  minSettlementYuan: 10,
  coinPerYuan: 100,
  quotaHoldDays: 7,
  quotaAdminAdjustDailyLimitCoins: 0,
  adjustMaxYuanPerOp: 100,
  adjustMaxYuanPerDay: 500,
};
const SETTLEMENT_ROW = {
  id: 's1', settlementNo: 'S1', agentId: 'ag_1', totalCoins: 100, totalMicro: 1000000,
  status: 'pending', requestedAt: 1761000000000,
};
const SETTLEMENT_DETAIL = {
  settlement: {
    settlementNo: 'S1', status: 'pending', agentId: 'ag_1', totalCoins: 100,
    totalMicro: 1000000, itemsCount: 1, carryBefore: 0, carryAfter: 0, coinPerYuan: 100,
    minYuan: 10, itemsHash: 'h', payout: null, requestedAt: 1761000000000,
    decidedAt: null, paidAt: null, paidBy: null, voucherNo: null, rejectReason: null,
  },
  lines: [],
};
const RECON = {
  from: 1761000000000, to: 1761600000000, entryFeeTotal: 0, boundFeeTotal: 0,
  unboundFeeTotal: 0, baseTotal: 0, commissionMicroTotal: 0, expectedMaxMicroTotal: 0,
  paidCoins: 0, gapCount: 0, missingEventCount: 0,
};

function makeDom(role) {
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
    // 精确/特例路由必须先于前缀匹配（tree/settings/settlements/:id）。
    if (u.startsWith('/api/admin/agents/tree')) { bump('tree'); return json(200, { code: 0, data: [] }); }
    if (u.startsWith('/api/admin/agents/settings')) { bump('settings'); return json(200, { code: 0, data: SETTINGS }); }
    if (u.startsWith('/api/admin/agent-settlements/s1')) { bump('settleDetail'); return json(200, { code: 0, data: SETTLEMENT_DETAIL }); }
    if (u.startsWith('/api/admin/agent-settlements')) { bump('settlements'); return json(200, { code: 0, data: [SETTLEMENT_ROW] }); }
    if (u.startsWith('/api/admin/agent-adjustments')) { bump('adjustments'); return json(200, { code: 0, data: [] }); }
    if (u.startsWith('/api/admin/agent-audit')) { bump('audit'); return json(200, { code: 0, data: [] }); }
    if (u.startsWith('/api/admin/agent-reconciliation')) { bump('recon'); return json(200, { code: 0, data: RECON }); }
    if (u.startsWith('/api/admin/agents')) { bump('list'); return json(200, { code: 0, data: { rows: [], total: 0 } }); }
    if (u.startsWith('/api/admin/login')) { bump('login'); return json(200, { code: 0, data: { token: 't', username: 'admin', role: 'super_admin' } }); }
    if (u.startsWith('/api/admin/config')) {
      bump('config');
      return json(200, { code: 0, data: { config: { 'agent.inviteEnabled': { value: false, version: 1 } }, version: 1 } });
    }
    return json(200, { code: 0, data: {} });
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', role);
  window.eval(appJs);
  return { window, errors };
}

// ── super_admin：单入口 + 懒加载 + 6 页签 ─────────────────────────────
const { window, errors } = makeDom('super_admin');
await sleep(60);
ok($(window, 'agents-view') !== null, '代理视图存在');
hits.clear();
ok(clickIf(window, 'nav-agents-btn'), '代理叶可点');
await sleep(60);
ok($(window, 'agents-view').hidden === false, '代理视图显示');
ok($(window, 'agent-panel-list')?.hidden === false, '默认落在列表页签');
ok(countOf('list') >= 1 && countOf('tree') >= 1, '进页只拉列表 + 代理树');
ok(countOf('settings') === 0 && countOf('settlements') === 0, '未激活页签不发请求');
ok(clickIf(window, 'agent-tab-settings'), '设置页签可点');
await sleep(60);
ok($(window, 'agent-panel-settings')?.hidden === false, '设置面板显示');
ok(countOf('settings') >= 1, '激活设置页签才拉 settings');
ok(countOf('config') === 0, 'config 快照已缓存不重复拉');
ok($(window, 'ag-invite-row')?.querySelector('input') != null, '邀请码行渲染');
ok(clickIf(window, 'agent-tab-settlements'), '结算页签可点');
await sleep(60);
ok($(window, 'agent-panel-settlements')?.hidden === false, '结算面板显示');
ok(countOf('settlements') >= 1, '激活结算页签才拉结算队列');
const settleDetailBtn = [...$(window, 'ag-settle-body').querySelectorAll('button')].find(
  (b) => b.textContent === '详情',
);
ok(settleDetailBtn !== undefined, '结算行有详情按钮');
if (settleDetailBtn) settleDetailBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
ok(
  $(window, 'ag-settle-detail-body')?.textContent.includes('确认打款'),
  '结算详情出现确认打款（super_admin）',
);
for (const [btn, panel] of [
  ['agent-tab-adjustments', 'agent-panel-adjustments'],
  ['agent-tab-recon', 'agent-panel-recon'],
  ['agent-tab-audit', 'agent-panel-audit'],
  ['agent-tab-list', 'agent-panel-list'],
]) {
  ok(clickIf(window, btn), `${btn} 可点`);
  await sleep(60);
  ok($(window, panel)?.hidden === false, `${panel} 显示`);
}
const visiblePanels = ['list', 'settlements', 'adjustments', 'recon', 'audit', 'settings'].filter(
  (id) => $(window, `agent-panel-${id}`)?.hidden === false,
);
ok(visiblePanels.length === 1 && visiblePanels[0] === 'list', '同一时刻仅一个面板可见');
ok(errors.length === 0, `super_admin 零运行时异常（实测 ${errors.length}）`);

// ── finance：只读设置 + 可结算 ───────────────────────────────────────
const fin = makeDom('finance');
await sleep(60);
hits.clear();
ok($(fin.window, 'nav-agents-btn').hidden === false, 'finance 可见代理叶');
clickIf(fin.window, 'nav-agents-btn');
await sleep(60);
clickIf(fin.window, 'agent-tab-settings');
await sleep(80);
const finRow = $(fin.window, 'ag-invite-row');
const finInput = finRow?.querySelector('input');
const finActions = finRow?.querySelector('.row-actions');
ok(finInput != null && finInput.disabled === true, 'finance 邀请码输入禁用');
ok(finActions != null && finActions.hidden === true, 'finance 隐藏行内保存动作');
ok($(fin.window, 'ag-settings-save-btn').hidden === true, 'finance 无保存设置按钮');
clickIf(fin.window, 'agent-tab-settlements');
await sleep(60);
const finDetailBtn = [...$(fin.window, 'ag-settle-body').querySelectorAll('button')].find(
  (b) => b.textContent === '详情',
);
if (finDetailBtn) finDetailBtn.dispatchEvent(new fin.window.MouseEvent('click', { bubbles: true }));
await sleep(60);
ok(
  $(fin.window, 'ag-settle-detail-body').textContent.includes('确认打款'),
  'finance 结算详情可打款/驳回',
);
ok(fin.errors.length === 0, `finance 零运行时异常（实测 ${fin.errors.length}）`);

// ── operator：不可达 ─────────────────────────────────────────────────
const op = makeDom('operator');
await sleep(60);
ok($(op.window, 'nav-agents-btn').hidden === true, 'operator 看不到代理叶');
try {
  op.window.eval("switchView('agents')");
} catch {
  // 调用失败也算不可达
}
await sleep(40);
ok($(op.window, 'agents-view').hidden === true, 'operator 直调 switchView 也不进代理视图');
ok(op.errors.length === 0, `operator 零运行时异常（实测 ${op.errors.length}）`);

// ── 登出复位 + 重登重新拉取 ──────────────────────────────────────────
ok(clickIf(window, 'logout-btn'), '登出按钮可点');
await sleep(40);
ok($(window, 'ag-invite-row')?.textContent === '', '登出清空邀请码行');
ok($(window, 'agent-tab-list')?.classList.contains('active'), '登出后页签回列表');
ok($(window, 'agent-panel-list')?.hidden === false, '登出后列表面板复位');
$(window, 'login-username').value = 'admin';
$(window, 'password').value = 'pw';
$(window, 'login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(80);
const beforeRelogin = countOf('list');
clickIf(window, 'nav-agents-btn');
await sleep(60);
ok(countOf('list') > beforeRelogin, '重登后再进代理页重新拉列表');
ok(errors.length === 0, `登出/重登零运行时异常（实测 ${errors.length}）`);

ok(unhandled.length === 0, `零未处理 rejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`admin agents probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('admin agents probe: all checks passed');
