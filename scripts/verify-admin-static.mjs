#!/usr/bin/env node
/**
 * admin/ 静态三件套机械闸（零依赖；v2.1 VSCode 设置页形态）。
 *
 * 三组断言：
 *  1. G12 同口径静态串（真源 tools/conformance/src/slices/slice-19-admin-rbac-audit.ts
 *     :1409-1493）—— 真栈 conformance 跑 Docker 成本高，本地先用同一份针脚清单秒级拦回归。
 *     注意 G12 的「逐字一致」比对的是「服务出字节 === 仓库文件」，这里只做针脚包含检查；
 *     字节一致由重建镜像天然满足。
 *     ⚠️ 本清单**另含非 G12 的片内针脚**（不在 slice-19 真源里；如销毁上账片的
 *     `fin-burn-line` / `销毁：残差 `）——「真源 = slice-19」仅覆盖 G12 那批。
 *  2. v2.1 结构断言：两栏壳/树/设置页新 id 就位；1a 三栏旧 id 与 #view-nav 已消失；
 *     nav-config-btn 以 hidden 锚点保留；CONFIG_IA 与 CONFIG_CONTROLS 覆盖 78 个 active 键
 *     （72 简单 + 5 结构化）。
 *  3. 控件定稿表：72 简单键的 type/后缀/step 与方案 v2.1 逐键定论表一致（防单位臆造回潮）。
 *
 * 退出码：0 全过；1 有失败（逐条打印）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

const failures = [];
let checks = 0;
const ok = (cond, label) => {
  checks += 1;
  if (!cond) failures.push(label);
};

/* ── 0. 文件存在 ─────────────────────────────────────────────── */
const FILES = ['admin/index.html', 'admin/app.js', 'admin/style.css'];
for (const f of FILES) ok(existsSync(resolve(REPO_ROOT, f)), `文件存在：${f}`);
const html = read('admin/index.html');
const app = read('admin/app.js');
const css = read('admin/style.css');

/* ── 1. app.js 针脚（逐字照 slice-19:1409-1444 + 六页签 + 片内自有针脚） ───── */
const APP_NEEDLES = [
  '/api/admin/login',
  '/api/admin/wallet/ops',
  '/api/admin/wallet/summary',
  '/api/admin/wallet/reverse',
  '/api/admin/wallet/reconcile/run',
  '/api/admin/config/changes',
  '/api/admin/login-events',
  '/api/admin/accounts/changes',
  '/api/admin/accounts',
  '/api/admin/risk/reviews',
  '/api/admin/risk/users/',
  '/device-binding',
  '/api/admin/risk/actions',
  '/api/admin/pay/orders',
  '/api/admin/pay/refunds',
  '/api/admin/pay/withdrawals',
  '/api/admin/pay/actions',
  '/api/admin/pay-channel/',
  'pay-channel-view',
  'nav-pay-channel-btn',
  'pay-channel-row-',
  '/api/admin/ad-channel/',
  'ad-channel-view',
  'nav-ad-channel-btn',
  'ad-channel-row-',
  '管理面未启用（未创建任何管理员账号）',
  '账号已停用，请联系超级管理员',
  'ftl-admin-username',
  'ftl-admin-role',
  '六页签',
  'fin-burn-line',
  '销毁：残差 ',
  'fin-entryfee-skip-line',
  '台费漏收：笔数 ',
];
for (const needle of APP_NEEDLES) {
  ok(app.includes(needle), `app.js 含 G12 针脚 ${JSON.stringify(needle)}`);
}
ok(!app.includes('innerHTML'), 'app.js 零 innerHTML（textContent 输出编码纪律）');

/* ── 2. index.html 针脚 ──────────────────────────────────────── */
for (const needle of [
  'login-username',
  'FTL 管理面',
  'pay-orders-view',
  'pay-refunds-view',
  'pay-withdrawals-view',
  'audit-tab-pay',
  'nav-pay-orders-btn',
  'pay-channel-view',
  'nav-pay-channel-btn',
  '支付渠道',
  'notify-channel-view',
  'nav-notify-channel-btn',
  '通知通道',
  'ad-channel-view',
  'nav-ad-channel-btn',
  '广告回调',
  'fin-burn-line',
  'fin-entryfee-skip-line',
  'fin-cardcounter-purchases-line',
  'fin-cardcounter-consumptions-line',
]) {
  ok(html.includes(needle), `index.html 含 G12 针脚 ${JSON.stringify(needle)}`);
}
const finSelect = /<select id="fin-source">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
const optCount = (finSelect.match(/<option /g) ?? []).length;
ok(optCount === 14, `财务「来源」下拉恰 14 项（实测 ${optCount}）`);
for (const source of ['recharge', 'refund_hold', 'refund_rollback', 'withdraw_hold', 'withdraw_rollback']) {
  ok(finSelect.includes(`value="${source}"`), `来源下拉含 value="${source}"`);
}
ok(finSelect.includes('value="entry_fee"'), '来源下拉含 value="entry_fee"');
ok(finSelect.includes('value="card_counter"'), '来源下拉含 value="card_counter"');

/* ── 3. v2.1 结构 id：新壳就位 ───────────────────────────────── */
for (const id of [
  'side-nav',
  'content-host',
  'settings-host',
  'settings-search',
  'settings-rows',
  'nav-cfg-ddz-btn',
  'nav-cfg-pdk-btn',
  'nav-cfg-economy-btn',
  'nav-cfg-paycfg-btn',
  'nav-cfg-riskcfg-btn',
  'nav-cfg-dataad-btn',
  'nav-cfg-ungrouped-btn',
]) {
  ok(html.includes(`id="${id}"`), `index.html 含 v2.1 新 id #${id}`);
}
// nav-config-btn 无叶子但 VIEWS 运行时引用：以 hidden 锚点保留（同标签内含 id 与 hidden）。
const anchorTag = /<button\b[^>]*\bid="nav-config-btn"[^>]*>/.exec(html)?.[0]
  ?? /<button\b[^>]*id="nav-config-btn"[^>]*>/.exec(html)?.[0] ?? '';
ok(anchorTag !== '' && /\bhidden\b/.test(anchorTag), '#nav-config-btn 以 hidden 锚点按钮保留');

/* ── 3b. v2.1 旧 id / 旧顶栏必须已从三件套消失 ──────────────── */
const REMOVED_IDS = [
  'view-nav',
  'cfg-nav',
  'cfg-search',
  'cfg-tabs',
  'key-pane-title',
  'key-list',
  'editor-key',
  'editor-version',
  'editor-body',
  'save-btn',
  'bool-input',
  'json-input',
];
for (const id of REMOVED_IDS) {
  ok(!html.includes(`id="${id}"`), `index.html 已移除旧 id #${id}`);
  ok(!new RegExp(`\\$\\(['"]${id}['"]\\)`).test(app), `app.js 已无 ${JSON.stringify(`$('${id}')`)} 引用`);
}

// 2026-10-21 IA 合并：客户端接入叶并入「风控安全」域（页内页签），旧叶/计数锚点必须消失。
ok(!html.includes('nav-cfg-client-btn'), 'index.html 已移除 nav-cfg-client-btn');
ok(!html.includes('nav-count-client'), 'index.html 已移除 nav-count-client');
ok(!app.includes('nav-cfg-client-btn'), 'app.js 已无 nav-cfg-client-btn 引用');

/* ── 3c. app.js v2.1 关键机制在 ──────────────────────────────── */
for (const needle of ['const CONFIG_CONTROLS', 'function renderSettings', 'function putConfigKey', 'function openCfgDomain']) {
  ok(app.includes(needle), `app.js 含 ${needle}`);
}

/* ── 4. 键集合完整性：CONFIG_IA 与 protocol CONFIG_KEYS 相等 ─── */
/** 取「起点字面量之后到括号配平结束」之间的源码块。 */
function balancedBlock(src, startLiteral, openCh = '[', closeCh = ']') {
  const start = src.indexOf(startLiteral);
  if (start === -1) return '';
  const open = src.indexOf(openCh, start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}
const protocolBlock = balancedBlock(read('packages/protocol/src/config.ts'), 'CONFIG_KEYS = [');
const iaBlock = balancedBlock(app, 'const CONFIG_IA');
/** 键形态：'ns.key...' 引号串。客户端接入片：段内允许数字（首字符仍须字母）——既有键无数字段，
 *  该形态此前不可达；收集面只增不减（放宽收集而非弱化断言，旧模式 [a-z]+(?:\.[a-zA-Z]+)+ 对
 *  'client.h5Enabled' 零命中）。 */
const QUOTED_DOTTED = /['"]([a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)['"]/g;
const collect = (block) => {
  const out = [];
  let m;
  QUOTED_DOTTED.lastIndex = 0;
  while ((m = QUOTED_DOTTED.exec(block))) out.push(m[1]);
  return out;
};
const protoSet = new Set(collect(protocolBlock));
const legacyProtoBlock = balancedBlock(read('packages/protocol/src/config.ts'), 'LEGACY_CONFIG_KEYS = [');
const legacyAdminBlock = balancedBlock(app, 'const LEGACY_CONFIG_KEYS = [');
const legacyProtoSet = new Set(collect(legacyProtoBlock));
const legacyAdminSet = new Set(collect(legacyAdminBlock));
const activeProtoSet = new Set([...protoSet].filter((k) => !legacyProtoSet.has(k)));
const iaKeySet = new Set(collect(iaBlock));
ok(legacyProtoSet.size === 16, `protocol LEGACY_CONFIG_KEYS 恰 16 键（实测 ${legacyProtoSet.size}）`);
ok(
  [...legacyProtoSet].every((k) => legacyAdminSet.has(k)) &&
    [...legacyAdminSet].every((k) => legacyProtoSet.has(k)),
  'admin LEGACY_CONFIG_KEYS 与 protocol 逐键相等',
);
ok(protoSet.size === 94, `protocol CONFIG_KEYS 恰 94 键（实测 ${protoSet.size}）`);
ok(activeProtoSet.size === 78, `active = CONFIG_KEYS − LEGACY 恰 78 键（实测 ${activeProtoSet.size}）`);
ok(iaKeySet.size === 78, `CONFIG_IA 覆盖 78 键（实测 ${iaKeySet.size}）`);
ok([...activeProtoSet].every((k) => iaKeySet.has(k)), 'CONFIG_IA 未漏 active 键');
ok([...iaKeySet].every((k) => activeProtoSet.has(k)), 'CONFIG_IA 无表外/旧键');

/* 2026-10-21 IA 合并：客户端接入两键归入 risk 域末尾页签（不新增独立域）。 */
ok(!/id:\s*'client'/.test(iaBlock), 'CONFIG_IA 无独立 client 域');
const riskDomainBlock =
  /id: 'risk',\s*\n\s*name: '风控安全',\s*\n\s*tabs: \[([\s\S]*?)\n\s*\],\s*\n\s*\},/.exec(iaBlock)?.[1] ?? '';
ok(riskDomainBlock !== '', '找到 risk 域块');
ok(riskDomainBlock.includes("id: 'clientGate'"), 'risk 域含 clientGate 页签');
ok(
  riskDomainBlock.includes("'client.appEnabled'") && riskDomainBlock.includes("'client.h5Enabled'"),
  '客户端接入两键位于 risk 域内',
);
const pdkStart = iaBlock.indexOf("id: 'pdk'");
const pdkEnd = pdkStart >= 0 ? iaBlock.indexOf("group: '通用设置'", pdkStart) : -1;
const pdkDomainBlock =
  pdkStart >= 0 ? iaBlock.slice(pdkStart, pdkEnd >= 0 ? pdkEnd : undefined) : '';
ok(pdkDomainBlock !== '', '找到 pdk 域块');
ok(
  ['rules', 'scoring', 'switches', 'rooms', 'goldEconomy', 'risk'].every((id) =>
    pdkDomainBlock.includes(`id: '${id}'`),
  ),
  'pdk 域含 规则/计分/开关/场次开关/金币场经济/风控检测 六页签',
);
ok(
  pdkDomainBlock.includes("'game.paodekuai.risk.winRateThreshold'") &&
    pdkDomainBlock.includes("'game.paodekuai.risk.minGames'"),
  'pdk 风控两键位于 pdk 域内',
);
ok(pdkDomainBlock.includes("'game.levels.paodekuai'"), 'pdk 档位表在 pdk 域');
ok(
  pdkDomainBlock.includes("'game.paodekuai.twoPlayerEnabled'") &&
    pdkDomainBlock.includes("'game.paodekuai.nonThreePlayerEnabled'"),
  'pdk 2/4 人两闸位于 pdk 域内',
);
const pdkSwitchesBlock =
  /id: 'switches',\s*\n\s*name: '开关',\s*\n\s*keys: \[([\s\S]*?)\]/.exec(pdkDomainBlock)?.[1] ?? '';
ok(
  pdkSwitchesBlock.includes("'game.paodekuai.twoPlayerEnabled'") &&
    pdkSwitchesBlock.includes("'game.paodekuai.nonThreePlayerEnabled'"),
  'pdk 2/4 人两闸位于「开关」页签',
);
ok(iaBlock.includes("'game.levels.doudizhu'"), 'ddz 档位表用新键 game.levels.doudizhu');

/* 玩法顶部开关（2026-10-24）：headerKeys 运行时键集/无重复/备注/默认值/渲染接线/纯函数行为。 */
const iaKeys = collect(iaBlock);
ok(iaKeys.length === iaKeySet.size, `CONFIG_IA 键无重复（${iaKeys.length} 条 / ${iaKeySet.size} 唯一）`);
ok(/const IA_KEY_SET = new Set\([\s\S]*?headerKeys/.test(app), 'IA_KEY_SET 纳入 headerKeys');
ok((pdkDomainBlock.match(/'game\.paodekuai\.enabled'/g) ?? []).length === 1, 'pdk enabled 只出现一次（headerKeys）');
const notesBlock = balancedBlock(app, 'const CONFIG_NOTES = {', '{', '}');
ok(notesBlock.includes("'game.doudizhu.enabled'"), 'CONFIG_NOTES 含斗地主总开关');
ok(notesBlock.includes("'game.paodekuai.enabled'"), 'CONFIG_NOTES 含跑得快总开关');
ok(
  /'game\.paodekuai\.risk\.winRateThreshold':\s*\[/.test(notesBlock) &&
    /'game\.paodekuai\.risk\.minGames':\s*\[/.test(notesBlock),
  'CONFIG_NOTES 以条目形态含跑得快风控两键（防注释假绿）',
);
ok(
  /'game\.paodekuai\.twoPlayerEnabled':\s*\[/.test(notesBlock) &&
    /'game\.paodekuai\.nonThreePlayerEnabled':\s*\[/.test(notesBlock),
  'CONFIG_NOTES 以条目形态含跑得快 2/4 两闸（防注释假绿）',
);
const noteKeys = [...notesBlock.matchAll(/^  '([^']+)': \[/gm)].map((m) => m[1]);
ok(noteKeys.length === 66, `CONFIG_NOTES 恰 66 条（实测 ${noteKeys.length}）`);
const defaultsBlock = balancedBlock(app, 'const GAME_SWITCH_DEFAULTS = {', '{', '}');
ok(/['"]game\.doudizhu\.enabled['"]\s*:\s*true/.test(defaultsBlock), '默认值：斗地主 true');
ok(/['"]game\.paodekuai\.enabled['"]\s*:\s*false/.test(defaultsBlock), '默认值：跑得快 false');
const renderRowsBlock = /function renderConfigRows\([\s\S]*?\n\}/.exec(app)?.[0] ?? '';
ok(renderRowsBlock.includes('buildGameHeader('), 'renderConfigRows 调用 buildGameHeader');
const fnBody = balancedBlock(app, 'function lastEnabledGameWarning', '{', '}');
ok(fnBody !== '', '找到 lastEnabledGameWarning');
const lastWarn = new Function(
  `return function lastEnabledGameWarning(currentConfig, targetKey, defaults, headerKeys) ${fnBody}`,
)();
const swDefaults = { 'game.doudizhu.enabled': true, 'game.paodekuai.enabled': false };
const swKeys = ['game.doudizhu.enabled', 'game.paodekuai.enabled'];
ok(
  lastWarn(
    { 'game.doudizhu.enabled': { value: true }, 'game.paodekuai.enabled': { value: false } },
    'game.doudizhu.enabled',
    swDefaults,
    swKeys,
  ) === true,
  'lastEnabledGameWarning：另一个玩法关 ⇒ 提示',
);
ok(
  lastWarn(
    { 'game.doudizhu.enabled': { value: true }, 'game.paodekuai.enabled': { value: true } },
    'game.doudizhu.enabled',
    swDefaults,
    swKeys,
  ) === false,
  'lastEnabledGameWarning：另一个玩法开 ⇒ 不提示',
);
ok(lastWarn({}, 'game.doudizhu.enabled', swDefaults, swKeys) === true, 'lastEnabledGameWarning：缺键按默认值判定');

/* ── 5. CONFIG_CONTROLS：73 简单键 + 5 结构化键 = 78；定稿表 ─── */
const STRUCT_KEYS = [
  'game.levels.doudizhu',
  'game.levels.paodekuai',
  'pay.rechargePackages',
  'game.doudizhu.robot.skillDistribution',
  'game.doudizhu.robot.modelBySkill',
];
const BOOL_KEYS = [
  'game.doudizhu.robot.ruleFallback',
  'game.doudizhu.freeRoomEnabled',
  'game.doudizhu.goldRoomEnabled',
  'game.doudizhu.friendRoomEnabled',
  'game.doudizhu.freeBotFillEnabled',
  'game.doudizhu.goldBotFillEnabled',
  'currency.reliefEnabled',
  'risk.predicate.sameDevice',
  'risk.predicate.sameIp',
  'risk.autoThrottle',
  'risk.deviceBindingEnabled',
  'pay.rechargeEnabled',
  'pay.withdrawEnabled',
  'client.appEnabled',
  'client.h5Enabled',
  'agent.inviteEnabled',
  'risk.withdrawReAuthEnabled',
  'game.doudizhu.cardCounterEnabled',
  // 跑得快 5 个场次/好友房/补位开关
  'game.paodekuai.freeRoomEnabled',
  'game.paodekuai.goldRoomEnabled',
  'game.paodekuai.friendRoomEnabled',
  'game.paodekuai.freeBotFillEnabled',
  'game.paodekuai.goldBotFillEnabled',
  // 多玩法（S7.1）：跑得快 12 个布尔键（2026-10-25 起 2/4 分键）
  'game.paodekuai.enabled',
  'game.paodekuai.twoPlayerEnabled',
  'game.paodekuai.nonThreePlayerEnabled',
  'game.paodekuai.bareTrioEnabled',
  'game.paodekuai.trioWithPairEnabled',
  'game.paodekuai.bareAirplaneEnabled',
  'game.paodekuai.fourWithTwoEnabled',
  'game.paodekuai.fourWithTwoPairKickerAllowed',
  'game.paodekuai.bombMultiplierEnabled',
  'game.paodekuai.guanMultiplierEnabled',
  'game.paodekuai.springMultiplierEnabled',
  'game.paodekuai.baobenEnabled',
  'game.doudizhu.enabled',
];
const TEXT_KEYS = ['ad.reliefAdpid', 'game.paodekuai.airplaneWings'];
/** 27 数字键逐键后缀定论（'' = 无后缀；值 = 控件右侧后缀原文）。 */
const NUMBER_SUFFIX = {
  'robot.reclaimIntervalMs': '毫秒',
  'room.matchScanIntervalMs': '毫秒',
  'room.autostartIntervalMs': '毫秒',
  'room.reapIntervalMs': '毫秒',
  'room.matchNoBotMaxWaitMs': '毫秒',
  'pay.scanIntervalMs': '毫秒',
  'pay.reconcileIntervalMs': '毫秒',
  'currency.reconcileIntervalMs': '毫秒',
  'risk.scanIntervalMs': '毫秒',
  'risk.devicesCleanupIntervalMs': '毫秒',
  'record.cleanupIntervalMs': '毫秒',
  'pay.orderExpireMinutes': '分钟',
  'pay.withdrawTimeoutMinutes': '分钟',
  'record.retentionDays': '天',
  'risk.deviceWindowDays': '天',
  'risk.deviceRetentionDays': '天',
  'game.doudizhu.rakePercent': '%',
  'game.doudizhu.entryMultiplier': '倍',
  'game.paodekuai.rakePercent': '%',
  'game.paodekuai.entryMultiplier': '倍',
  'currency.reliefThresholdCoins': '金币',
  'currency.signupGrant': '金币',
  'currency.reliefAmount': '金币',
  'pay.withdrawMinCoins': '金币',
  'pay.withdrawMaxCoinsPerOrder': '金币',
  'pay.withdrawDailyMaxCoins': '金币',
  'pay.coinPerYuan': '金币/元',
  'game.doudizhu.risk.winRateThreshold': '',
  'game.doudizhu.risk.minGames': '',
  'game.paodekuai.risk.winRateThreshold': '',
  'game.paodekuai.risk.minGames': '',
  'risk.deviceLimit': '',
  'game.doudizhu.cardCounterPricePerGameCoins': '金币/局',
  'game.doudizhu.cardCounterPricePerHourCoins': '金币/小时',
  'game.paodekuai.multiplierCap': '倍',
};

const controlsBlock = balancedBlock(app, 'const CONFIG_CONTROLS', '{', '}');
ok(controlsBlock !== '', '找到 const CONFIG_CONTROLS 对象块');
/** 每个条目形如  'ns.key': { label: '中文', type: 'number', suffix: '毫秒' }（条目内无嵌套括号；
 *  键段模式同 QUOTED_DOTTED —— 客户端接入片：段内允许数字）。 */
const ENTRY_RE = /['"]([a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)['"]:\s*\{([^{}]*)\}/g;
const entries = new Map();
let em;
while ((em = ENTRY_RE.exec(controlsBlock))) entries.set(em[1], em[2]);

const structSet = new Set(STRUCT_KEYS);
ok(entries.size === 73, `CONFIG_CONTROLS 恰 73 个简单键条目（实测 ${entries.size}）`);
ok([...entries.keys()].every((k) => protoSet.has(k)), 'CONFIG_CONTROLS 条目均为 protocol 键');
ok(STRUCT_KEYS.every((k) => !entries.has(k)), '5 个结构化键不在简单控件表');
ok([...activeProtoSet].every((k) => entries.has(k) || structSet.has(k)), '78 键 = 73 简单 ∪ 5 结构化（无遗漏）');
ok(BOOL_KEYS.every((k) => entries.has(k)), '36 布尔键清单全部入表');
ok(BOOL_KEYS.length === 36 && BOOL_KEYS.every((k) => /type:\s*'bool'/.test(entries.get(k) ?? '')), '36 布尔键 type=bool');
ok(TEXT_KEYS.every((k) => /type:\s*'text'/.test(entries.get(k) ?? '')), '两个文本键 type=text');
const numberKeys = Object.keys(NUMBER_SUFFIX);
ok(numberKeys.length === 35, `数字键定论表 35 个（实测 ${numberKeys.length}）`);
for (const k of numberKeys) {
  const body = entries.get(k);
  ok(body != null && /type:\s*'number'/.test(body), `${k} type=number`);
  if (body == null) continue;
  const suffixM = /suffix:\s*'([^']*)'/.exec(body);
  const suffix = suffixM ? suffixM[1] : '';
  ok(suffix === NUMBER_SUFFIX[k], `${k} 后缀=${JSON.stringify(NUMBER_SUFFIX[k])}（实测 ${JSON.stringify(suffix)}）`);
}
ok(!/suffix/.test(entries.get('game.doudizhu.risk.winRateThreshold') ?? ''), '胜率阈值不带后缀（0.50–1.00 比率）');
ok(/step:\s*0\.01/.test(entries.get('game.doudizhu.risk.winRateThreshold') ?? ''), '胜率阈值 step=0.01');
ok(!/suffix/.test(entries.get('game.paodekuai.risk.winRateThreshold') ?? ''), '跑得快胜率阈值不带后缀');
ok(/step:\s*0\.01/.test(entries.get('game.paodekuai.risk.winRateThreshold') ?? ''), '跑得快胜率阈值 step=0.01');
ok(!/suffix/.test(entries.get('game.paodekuai.risk.minGames') ?? ''), '跑得快最少局数不带后缀');
// 每条目必须有非空中文 label。
for (const [k, body] of entries) {
  const labelM = /label:\s*'([^']+)'/.exec(body);
  ok(!!labelM && labelM[1].trim() !== '', `${k} 有非空 label`);
}
// 简单/布尔/文本/数字分类合计 = 71（防清单漂移）。
ok(
  BOOL_KEYS.length + TEXT_KEYS.length + numberKeys.length === entries.size,
  `控件分类合计 = entries.size（实测 ${BOOL_KEYS.length + TEXT_KEYS.length + numberKeys.length} / ${entries.size}）`,
);

/* ── 5b. 风控详情：总战绩 + 分玩法（块内断言，防备注假绿）────────── */
const renderRiskDetailBlock = functionBody(app, 'function renderRiskDetail');
ok(renderRiskDetailBlock !== '', '找到 renderRiskDetail 函数体');
ok(
  renderRiskDetailBlock.includes('byGame.textContent =') &&
    renderRiskDetailBlock.includes('分玩法：斗地主'),
  '风控详情渲染分玩法战绩（赋值与文案，防注释假绿）',
);
ok(
  /d\.stats\?\.byGame\?\.doudizhu\?\.games\s*\?\?/.test(renderRiskDetailBlock) &&
    /d\.stats\?\.byGame\?\.paodekuai\?\.games\s*\?\?/.test(renderRiskDetailBlock),
  '风控详情 byGame 用可选链（新 admin + 旧 user-service 窗口不崩）',
);

/* ── 5c. 旧键只读：未分组/搜索都必须排除 LEGACY_KEY_SET ─────────── */
const ungroupedFn = balancedBlock(app, 'function ungroupedKeys', '{', '}');
ok(ungroupedFn !== '' && ungroupedFn.includes('LEGACY_KEY_SET'), '未分组差集排除 LEGACY_KEY_SET');
ok(app.includes('!LEGACY_KEY_SET.has(k) &&'), '搜索遍历排除 LEGACY_KEY_SET');

/* ── 6. 零外链 ───────────────────────────────────────────────── */
ok(!/(?:src|href)\s*=\s*["']https?:\/\//.test(html), 'index.html 无外部 src/href');
ok(!/@import/.test(css), 'style.css 无 @import');
ok(!/url\(\s*["']?https?:/.test(css), 'style.css 无外部 url()');

/* ── 7. 缺省底分去冻结（2026-10-21）──────────────────────────────
 * 缺省改为「档位表最低档」后，后台不得再在行为或文案上强制 15：
 *  - 旧删除拦截 / 保存校验 / 帮助文本三条串都必须消失（改一半也会被这条闸抓住）。 */
for (const stale of ['必须包含缺省底分 15', '缺省底分 15 档不可删除', '缺省建房固定用 15']) {
  ok(!app.includes(stale), `app.js 不含旧串「${stale}」`);
}

/* ── 8. 台费并入档位表（2026-10-21）──────────────────────────────
 * 块级断言：`balancedBlock` 默认括号是 []，函数块必须显式传 {}（否则会截到函数内第一个数组）。 */
const levelsFn = balancedBlock(app, 'function buildLevelsEditor', '{', '}');
ok(levelsFn !== '', '找到 buildLevelsEditor 函数块');
const THREE_ARG_ADDROW = 'addRow(item?.name, item?.baseScore, item?.entryFeePercent)';
const threeArgCount = levelsFn.split(THREE_ARG_ADDROW).length - 1;
ok(
  threeArgCount === 2,
  `buildLevelsEditor 的第三列 addRow 恰出现 2 次（初始渲染 + reset；实测 ${threeArgCount}）`,
);
ok(
  levelsFn.includes('struct-row--head') &&
    levelsFn.includes("'场次名'") &&
    levelsFn.includes("'台费 %'"),
  '档位表编辑器有表头（场次名 / 底分 / 台费 % / 操作）',
);
ok(levelsFn.includes("pctEl.max = '100'"), '档位表第三列上限 = 100（0–100%）');
ok(levelsFn.includes('percent > 100)'), '档位表 getter 上限 = 100');
ok(levelsFn.includes('percent < 0'), '档位表 getter 下界 = 0');
ok(!levelsFn.includes('percent > 50'), '档位表 getter 不再使用 50 上限');
ok(levelsFn.includes('0–100'), '档位表台费文案为 0–100');
ok(!levelsFn.includes('0–50'), '档位表不再出现 0–50');
ok(!app.includes('0–50'), 'app.js 不再出现 0–50（旧键/抽水用语是 0 ≤ n ≤ 50）');
ok(
  app.includes("key === 'game.levels.doudizhu' || key === 'game.levels.paodekuai'"),
  'buildStructCard 的 levels 编辑器分派覆盖斗地主与跑得快两键',
);
ok(
  app.includes("key === 'game.doudizhu.robot.skillDistribution'") &&
    app.includes("key === 'game.doudizhu.robot.modelBySkill'"),
  'buildStructCard 的机器人编辑器分派用新键',
);
const notesStart = app.indexOf("'game.levels.doudizhu': [");
const notesEnd = app.indexOf("'game.doudizhu.cardCounterEnabled': [");
ok(
  notesStart !== -1 && notesEnd > notesStart,
  'CONFIG_NOTES 档位表切片锚点存在（起/止）',
);
const notesSrc = app.slice(notesStart, notesEnd);
ok(notesSrc.includes('0–100'), 'CONFIG_NOTES 档位表条目为 0–100');

/* ── 9. 设置项说明完整换行展示（不作单行省略号截断）──────────────
 * 2026-10-21：入场门槛倍率等长说明曾被 nowrap + ellipsis 截断；规则改回正常换行后，
 * 断言 .row-effect 规则体内不得再出现截断三件套。 */
const rowEffectBlock = /^\.row-effect\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
ok(rowEffectBlock !== '', 'style.css 含 .row-effect 规则');
ok(!/text-overflow\s*:\s*ellipsis/.test(rowEffectBlock), '.row-effect 不用省略号截断');
ok(!/white-space\s*:\s*nowrap/.test(rowEffectBlock), '.row-effect 不强制单行');
ok(!/overflow\s*:\s*hidden/.test(rowEffectBlock), '.row-effect 不隐藏溢出内容');
ok(/overflow-wrap\s*:\s*anywhere/.test(rowEffectBlock), '.row-effect 允许长串换行（overflow-wrap: anywhere）');

/* ── 10. 2026-10-21 IA 合并：广告 + 广告回调同页 ───────────────────
 * 左树只留「广告」叶；广告回调面板挂在 #settings-host 内、与设置行同一滚动流；
 * 独立 adChannel 视图必须成套删除（VIEWS/VIEW_ORDER/SETTINGS_VIEWS/switchView/renderSettings）。 */
const adNavHits = html.match(/id="nav-ad-channel-btn"/g) ?? [];
ok(adNavHits.length === 1, `index.html 中 nav-ad-channel-btn 恰一处（实测 ${adNavHits.length}）`);
const adNavTag = /<button\b[^>]*\bid="nav-ad-channel-btn"[^>]*>/.exec(html)?.[0] ?? '';
ok(adNavTag !== '' && /\bhidden\b/.test(adNavTag), 'nav-ad-channel-btn 为 hidden 锚点');
ok(app.includes('nav-ad-channel-btn'), 'app.js 保留 nav-ad-channel-btn 字面量（G12 针脚）');

const adSectionTag = /<section\b[^>]*\bid="ad-channel-view"[^>]*>/.exec(html)?.[0] ?? '';
ok(adSectionTag !== '', 'index.html 含 #ad-channel-view');
ok(/\bsettings-inline-view\b/.test(adSectionTag), '#ad-channel-view 使用 settings-inline-view');
ok(!/\bpage-view\b/.test(adSectionTag), '#ad-channel-view 不再是 page-view');
ok(/\bhidden\b/.test(adSectionTag), '#ad-channel-view 初始 hidden');
ok(
  html.indexOf('id="settings-rows"') < html.indexOf('id="ad-channel-view"') &&
    html.indexOf('id="ad-channel-view"') < html.indexOf('<!-- /settings-host -->'),
  '#ad-channel-view 位于 settings-rows 之后、settings-host 之内',
);
ok(/\.settings-inline-view\s*\{/.test(css), 'style.css 含 .settings-inline-view 规则');
ok(/\.ad-channel-rows\s*\{/.test(css), 'style.css 含 .ad-channel-rows 规则');

const viewsBlock = balancedBlock(app, 'const VIEWS =', '{', '}');
ok(viewsBlock !== '' && !/\badChannel\s*:/.test(viewsBlock), 'VIEWS 无 adChannel 条目');
const viewOrderBlock = balancedBlock(app, 'const VIEW_ORDER = [');
ok(viewOrderBlock !== '' && !viewOrderBlock.includes("'adChannel'"), 'VIEW_ORDER 不含 adChannel');
ok(!/SETTINGS_VIEWS\s*=\s*new Set\(\[[^\]]*adChannel/.test(app), 'SETTINGS_VIEWS 不含 adChannel');
const switchViewBlock = balancedBlock(app, 'function switchView', '{', '}');
ok(switchViewBlock !== '' && !switchViewBlock.includes('adChannel'), 'switchView 无 adChannel 分支');
const renderSettingsBlock = balancedBlock(app, 'function renderSettings', '{', '}');
ok(renderSettingsBlock !== '' && !renderSettingsBlock.includes('adChannel'), 'renderSettings 无 adChannel 分支');
ok(!app.includes("switchView('adChannel')"), "app.js 无 switchView('adChannel') 调用");

/** 跳过参数表再配平函数体：renderConfigRows 的参数是解构 `{ preserve = false }`，
 *  直接 balancedBlock 会命中参数而非函数体。 */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) {
      i += 1;
      break;
    }
  }
  return balancedBlock(src.slice(i), '', '{', '}');
}
const renderConfigRowsBlock = functionBody(app, 'function renderConfigRows');
ok(renderConfigRowsBlock !== '', '找到 renderConfigRows 函数体');
ok(/(^|\n)\s*syncAdSection\(q\);/.test(renderConfigRowsBlock), 'renderConfigRows 调用 syncAdSection(q)');
ok(/\bfunction\s+syncAdSection\s*\(/.test(app), 'app.js 定义 syncAdSection');
ok(/adChannelState\s*=\s*\{[^}]*attempted:\s*false/.test(app), 'adChannelState 含 attempted 标志');

// 面板显隐 / attempted 生命周期 / hidden 锚点必须是真实赋值（防注释或字面量假绿）。
const loadAdChannelBlock = functionBody(app, 'async function loadAdChannel');
ok(loadAdChannelBlock !== '' && loadAdChannelBlock.includes('attempted = true'), 'loadAdChannel 置 attempted=true');
const openCfgDomainBlock = functionBody(app, 'function openCfgDomain');
ok(openCfgDomainBlock !== '' && openCfgDomainBlock.includes('attempted = false'), 'openCfgDomain 重置 attempted');
const resetAdChannelBlock = functionBody(app, 'function resetAdChannel');
ok(resetAdChannelBlock !== '' && resetAdChannelBlock.includes('attempted = false'), 'resetAdChannel 重置 attempted');
ok(renderSettingsBlock.includes("ad-channel-view').hidden = true"), 'renderSettings 隐藏广告回调面板');
ok(
  /\$\(\s*'nav-ad-channel-btn'\s*\)\.hidden\s*=\s*true/.test(app),
  'applyRoleNav 实际隐藏 nav-ad-channel-btn',
);

// 块截断自检：balancedBlock 不跳过字符串/注释，取块尾部关键语句兜底。
ok(switchViewBlock.includes('loadAccounts()'), 'switchView 块完整（含尾部 loadAccounts）');
ok(renderSettingsBlock.includes('renderConfigRows()'), 'renderSettings 块完整');
ok(viewsBlock.includes('accounts:'), 'VIEWS 块完整（含 accounts）');
ok(renderConfigRowsBlock.includes('scrollEl.scrollTop = scrollTop'), 'renderConfigRows 块完整（含滚动恢复）');


/* ── 11. 2026-10-22 玩家管理页 ────────────────────────────────────── */
for (const id of ['nav-players-btn', 'players-view', 'pl-summary', 'pl-body', 'pl-detail', 'pl-back-btn', 'pl-page-size']) {
  ok(html.includes(`id="${id}"`), `index.html 含玩家页 id #${id}`);
}
ok(app.includes("players: { el: 'players-view', nav: 'nav-players-btn', roles: ['super_admin', 'operator'] }"), 'VIEWS.players 角色精确');
const viewOrderPlayers = /const VIEW_ORDER = \[([^\]]*)\]/.exec(app)?.[1] ?? '';
ok(viewOrderPlayers.includes("'players'"), 'VIEW_ORDER 含 players');
ok(viewOrderPlayers.indexOf("'players'") < viewOrderPlayers.indexOf("'wallet'"), 'players 在 wallet 之前');
for (const needle of [
  '/api/admin/players',
  '/api/admin/wallet/accounts/batch',
  '/api/admin/pay/players/summary',
  'function loadPlayers',
  'function showPlayerDetail',
  'function wirePlayers',
]) {
  ok(app.includes(needle), `app.js 含玩家页针脚 ${JSON.stringify(needle)}`);
}
ok(/\.players-summary\s*\{/.test(css) && /\.players-card\s*\{/.test(css), 'style.css 含玩家页样式');
ok(!app.includes('innerHTML'), 'app.js 零 innerHTML（玩家页同纪律）');

/* ── 12. 2026-10-26 代理分润：管理后台「代理」页 ─────────────────────
 * 读面 super_admin|finance（网关 P-ag1）；写面 super_admin（P-ag2..P-ag4）；
 * 结算打款/驳回 finance 也可。UI 只做门面，真闸在网关 policy。 */
for (const id of [
  'nav-agents-btn',
  'agents-view',
  'ag-settings-form',
  'ag-settings-enabled',
  'ag-settings-default-rate',
  'ag-settings-min-yuan',
  'ag-settings-coin-per-yuan',
  'ag-settings-hold-days',
  'ag-settings-admin-limit',
  'ag-settings-adjust-op',
  'ag-settings-adjust-day',
  'ag-settings-save-btn',
  'ag-q',
  'ag-status',
  'ag-search-btn',
  'ag-reset-btn',
  'ag-create-btn',
  'ag-create-form',
  'ag-create-result',
  'ag-body',
  'ag-empty',
  'ag-page-info',
  'ag-prev-btn',
  'ag-next-btn',
  'ag-page-size',
  'ag-detail',
  'ag-detail-body',
  'ag-detail-close-btn',
  'ag-settle-status',
  'ag-settle-refresh-btn',
  'ag-settle-body',
  'ag-settle-empty',
  'ag-settle-prev-btn',
  'ag-settle-next-btn',
  'ag-settle-page-info',
  'ag-settle-detail',
  'ag-settle-detail-body',
  'ag-adjust-form',
  'ag-adjust-agent',
  'ag-adjust-delta',
  'ag-adjust-reason',
  'ag-adjust-create-btn',
  'ag-adjust-status',
  'ag-adjust-refresh-btn',
  'ag-adjust-prev-btn',
  'ag-adjust-next-btn',
  'ag-adjust-page-info',
  'ag-adjust-body',
  'ag-adjust-empty',
  'ag-recon-from',
  'ag-recon-to',
  'ag-recon-run-btn',
  'ag-recon-body',
  'ag-audit-refresh-btn',
  'ag-audit-body',
  'ag-audit-empty',
  'ag-audit-prev-btn',
  'ag-audit-next-btn',
  'ag-audit-page-info',
]) {
  ok(html.includes(`id="${id}"`), `index.html 含代理页 id #${id}`);
}
ok(
  app.includes("agents: { el: 'agents-view', nav: 'nav-agents-btn', roles: ['super_admin', 'finance'] }"),
  'VIEWS.agents 角色精确（super_admin|finance）',
);
const viewOrderAgents = /const VIEW_ORDER = \[([^\]]*)\]/.exec(app)?.[1] ?? '';
ok(viewOrderAgents.includes("'agents'"), 'VIEW_ORDER 含 agents');
ok(viewOrderAgents.trim().endsWith("'agents'"), 'VIEW_ORDER 末尾为 agents（后加视图）');
for (const needle of [
  '/api/admin/agents',
  '/api/admin/agents/tree',
  '/api/admin/agents/settings',
  '/api/admin/agent-settlements',
  '/api/admin/agent-adjustments',
  '/api/admin/agent-audit',
  '/api/admin/agent-reconciliation',
  'function loadAgents',
  'function renderAgents',
  'function wireAgents',
  'function resetAgents',
  'function loadAgentSettlements',
  'function loadAgentAdjustments',
  'function loadAgentReconciliation',
  'function loadAgentAudit',
  'const canAgentWrite',
  'const canAgentSettle',
  'function applyAgentRole',
]) {
  ok(app.includes(needle), `app.js 含代理页针脚 ${JSON.stringify(needle)}`);
}
ok(
  /const canAgentWrite = \(\) => roleOf\(\) === 'super_admin';/.test(app),
  'canAgentWrite 仅 super_admin（写面门面）',
);
ok(
  /const canAgentSettle = \(\) => roleOf\(\) === 'super_admin' \|\| roleOf\(\) === 'finance';/.test(app),
  'canAgentSettle = super_admin|finance（打款/驳回）',
);
const switchViewAgents = balancedBlock(app, 'function switchView', '{', '}');
ok(
  switchViewAgents.includes("view === 'agents'") && switchViewAgents.includes('loadAgents()'),
  'switchView 首次激活懒加载代理页',
);
const loginViewAgents = balancedBlock(app, 'function showLoginView', '{', '}');
ok(loginViewAgents.includes('resetAgents()'), 'showLoginView 清零代理页状态');
const wireAgentsBlock = balancedBlock(app, 'function wire()', '{', '}');
ok(wireAgentsBlock.includes('wireAgents()'), 'wire() 调用 wireAgents()');
ok(
  /\$\('nav-agents-btn'\)\.addEventListener\('click'/.test(wireAgentsBlock),
  'wire() 绑定 nav-agents-btn',
);
const saveAgentBlock = functionBody(app, 'async function saveAgentDetail');
ok(saveAgentBlock !== '', '找到 saveAgentDetail 函数体');
ok(
  ['payoutName', 'payoutAccount', 'payoutBank'].every((k) => saveAgentBlock.includes(k)),
  'saveAgentDetail 三收款字段同笔提交（updatePayout 省略即置 NULL）',
);
ok(saveAgentBlock.includes('/payout'), 'saveAgentDetail 调用 payout PATCH');
const setStatusBlock = functionBody(app, 'async function setAgentStatus');
ok(setStatusBlock !== '' && setStatusBlock.includes('/status'), 'setAgentStatus 调 status 端点');
ok(!app.includes('innerHTML'), 'app.js 零 innerHTML（代理页同纪律）');
ok(/\.agents-secret\s*\{/.test(css), 'style.css 含 .agents-secret 规则');
ok(/\.agents-actions\s*\{/.test(css), 'style.css 含 .agents-actions 规则');

/* ── 汇总 ────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`admin static verify: ${failures.length} FAILED / ${checks} checks`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`admin static verify: ${checks} checks passed`);
