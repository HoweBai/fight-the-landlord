#!/usr/bin/env node
/**
 * 玩家管理页真 DOM 探针（2026-10-22）。
 * jsdom 加载 admin/index.html + app.js，桩 fetch/sessionStorage；覆盖：
 * 汇总/列表/批量列/筛选/详情/封禁/角色收面/零异常。
 * 运行：node scripts/admin-players-probe.mjs（从仓库根执行）。
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
const click = (w, id) => $(w, id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const json = (status, body) => ({ status, json: async () => body });

const players = [{
  userId: 'u1', phone: '13800000001', nickname: '阿明', status: 'active',
  createdAt: 1760000000000, lastActiveAt: 1761000000000, online: true,
  deviceCount: 2, games: 10, wins: 6, lastGameAt: 1761000000000, riskStatus: 'open',
}];

function makeDom(role) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message ?? e)));
  const dom = new JSDOM(html, {
    url: 'https://localhost/admin/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.confirm = () => true;
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'DELETE' && u.includes('/device-binding')) return json(200, { code: 0, data: { ok: true } });
    if (u.startsWith('/api/admin/config')) return json(200, { code: 0, data: { config: {}, version: 0 } });
    if (u.startsWith('/api/admin/players/') && u.includes('/games')) {
      return json(200, { code: 0, data: { items: [
        { recordId: 7, mode: 'gold', baseScore: 80, role: 'landlord', won: true, scoreChange: 160, moneyDelta: 160, endedAt: 1761000000000 },
      ] } });
    }
    if (u.startsWith('/api/admin/players')) return json(200, {
      code: 0,
      data: {
        items: $players(), page: 1, pageSize: 20, total: 1,
        summary: { totalPlayers: 1, onlineNow: 1, newToday: 1, new7d: 1, active7d: 1, active30d: 1, inactive14d: 0, inactive30d: 0, neverActive: 0 },
      },
    });
    if (u.startsWith('/api/admin/wallet/accounts/batch')) return json(200, { code: 0, data: { accounts: [{ userId: 'u1', balance: 120, exists: true }] } });
    if (u.startsWith('/api/admin/pay/players/summary')) return json(200, { code: 0, data: { players: [{ userId: 'u1', rechargeCount: 2, rechargeFen: 1200, lastRechargeAt: 1761000000000 }] } });
    if (u.startsWith('/api/admin/users/')) return json(200, { code: 0, data: { userId: 'u1', phone: '13800000001', nickname: '阿明', status: 'active', createdAt: 1760000000000, online: true } });
    if (u.startsWith('/api/admin/risk/users/')) return json(200, { code: 0, data: { accountStatus: 'active', limitSource: null, bannedFlagPresent: false, stats: { games: 10, wins: 6, winRate: 0.6, deviceCount: 2 }, devices: [{ deviceId: 'd1', firstSeenAt: 1760000000000, lastSeenAt: 1761000000000, others: [] }], entries: [], hits: { sameIp: 0, sameDevice: 1 }, binding: { deviceId: 'd1', boundAt: 1760000000000 } } });
    if (u.startsWith('/api/admin/wallet/accounts/')) return json(200, { code: 0, data: { balance: 120, recentFlows: [] } });
    if (u.startsWith('/api/admin/pay/orders')) return json(200, { code: 0, data: { items: [{ orderNo: 'o1', amountFen: 600, status: 'credited', creditedAt: 1761000000000 }], nextCursor: null } });
    if (u.startsWith('/api/admin/risk/actions')) return json(200, { code: 0, data: { ok: true } });
    return json(200, { code: 0, data: {} });
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', role);
  window.eval(appJs);
  return { window, errors };
}

// 列表桩可被筛选测试改写
let playerRows = players;
function $players() {
  return playerRows;
}

const { window, errors } = makeDom('super_admin');
await sleep(50);
ok($(window, 'nav-players-btn') !== null, '玩家叶存在');
click(window, 'nav-players-btn');
await sleep(60);
ok($(window, 'players-view').hidden === false, '玩家视图显示');
ok($(window, 'pl-summary').textContent.includes('总玩家'), '汇总卡片渲染');
ok($(window, 'pl-body').children.length === 1, '列表行渲染');
const rowText = $(window, 'pl-body').textContent;
ok(rowText.includes('13800000001') && rowText.includes('120') && rowText.includes('12.00'), '列表含手机号/余额/充值');

// 筛选 → 空结果
playerRows = [];
$(window, 'pl-status').value = 'banned';
click(window, 'pl-search-btn');
await sleep(40);
ok($(window, 'pl-empty').textContent.includes('没有匹配'), '筛选空结果显示空态');
ok(errors.length === 0, `super_admin 零运行时异常（实测 ${errors.length}）`);

// 恢复 → 详情 → 封禁
playerRows = players;
$(window, 'pl-status').value = '';
click(window, 'pl-search-btn');
await sleep(40);
$(window, 'pl-body').querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
ok($(window, 'pl-detail').hidden === false, '详情面板打开');
ok($(window, 'pl-detail-body').textContent.includes('余额'), '详情含余额');
ok($(window, 'pl-detail-body').textContent.includes('最近对局'), '详情含最近对局');
const unbindBtn = [...$(window, 'pl-detail-body').querySelectorAll('button')].find((b) => b.textContent === '解绑设备');
ok(unbindBtn !== undefined, '已绑定设备时显示解绑按钮');
unbindBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
ok($(window, 'status').textContent.includes('已解绑设备'), '解绑成功提示');
const actionBtn = [...$(window, 'pl-detail-body').querySelectorAll('button')].find((b) => b.textContent === '封禁');
actionBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(20);
ok($(window, 'modal').hidden === false, '封禁确认弹窗打开');
$(window, 'modal-input').value = '测试封禁';
click(window, 'modal-ok');
await sleep(60);
ok($(window, 'status').textContent.includes('已封禁'), '封禁成功提示');

// finance 收面
const fin = makeDom('finance');
await sleep(50);
ok($(fin.window, 'nav-players-btn').hidden === true, 'finance 无玩家叶');
ok(fin.errors.length === 0, `finance 零运行时异常（实测 ${fin.errors.length}）`);
ok(unhandled.length === 0, `零 unhandledRejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`\nadmin players probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nadmin players probe: all checks passed');
