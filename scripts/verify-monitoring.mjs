#!/usr/bin/env node
/**
 * Grafana/Prometheus 静态校验（2026-10-22）。
 * - 所有看板 JSON 可解析、uid/title 唯一；
 * - 08-players 的指标名在允许清单内；counter 查询含 sum(increase())，gauge 查询含 max()/avg()；
 * - prometheus.yml 仍覆盖 8 个 Nest 服务。
 * 退出码：0 全过；1 有失败。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'deploy/monitoring/grafana/dashboards');
const failures = [];
let checks = 0;
const ok = (cond, label) => {
  checks += 1;
  if (!cond) failures.push(label);
};

const ALLOWED = new Set([
  'players_total', 'players_active_1d', 'players_active_7d', 'players_active_30d',
  'players_inactive_14d', 'players_inactive_30d', 'players_online_presence',
  'user_registrations_total', 'payment_recharge_credited_total', 'payment_recharge_fen_total',
  'ws_connections',
]);
const KEYWORDS = new Set([
  'sum', 'max', 'avg', 'min', 'increase', 'rate', 'irate', 'by', 'without', 'on',
  'ignoring', 'group_left', 'group_right', 'offset', 'inf', 'nan', 'vector', 'scalar',
  'le', 'instance', 'job', 'quantile',
]);
const UIDS = new Set();
const TITLES = new Set();
let playersDash = null;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  let dash;
  try {
    dash = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (err) {
    failures.push(`${file} JSON 解析失败：${String(err)}`);
    continue;
  }
  ok(typeof dash.uid === 'string' && dash.uid.length > 0, `${file} 有 uid`);
  ok(typeof dash.title === 'string' && dash.title.length > 0, `${file} 有 title`);
  ok(!UIDS.has(dash.uid), `${file} uid 唯一`);
  ok(!TITLES.has(dash.title), `${file} title 唯一`);
  UIDS.add(dash.uid);
  TITLES.add(dash.title);
  if (file === '08-players.json') playersDash = dash;
}

ok(playersDash !== null, '存在 08-players.json');
if (playersDash) {
  ok(playersDash.title.includes('玩家'), '08 看板标题含「玩家」');
  ok(Array.isArray(playersDash.panels) && playersDash.panels.length >= 8, '08 看板至少 8 个面板');
  for (const panel of playersDash.panels) {
    for (const target of panel.targets ?? []) {
      const expr = String(target.expr ?? '');
      const metrics = [...expr.matchAll(/\b([a-z][a-z0-9_]+)\b/g)].map((m) => m[1]);
      const unknown = metrics.filter((m) => !ALLOWED.has(m) && !KEYWORDS.has(m));
      ok(unknown.length === 0, `面板「${panel.title}」含未知标识符 ${JSON.stringify(unknown)}`);
      const known = metrics.filter((m) => ALLOWED.has(m));
      ok(known.length > 0, `面板「${panel.title}」引用已知指标`);
      if (known.some((m) => m === 'user_registrations_total' || m.includes('payment_recharge'))) {
        ok(expr.includes('sum(') && expr.includes('increase('), `面板「${panel.title}」counter 用 sum(increase())`);
      } else {
        ok(/max\(|avg\(|sum\(/.test(expr), `面板「${panel.title}」gauge 用聚合函数`);
      }
    }
  }
}

const prom = readFileSync(join(ROOT, 'deploy/monitoring/prometheus/prometheus.yml'), 'utf8');
const JOBS = [
  'api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service',
  'config-service', 'currency-service', 'payment-service', 'douzero', 'node-exporter',
  'cadvisor', 'prometheus', 'alertmanager', 'grafana', 'alert-relay',
];
const jobCount = (prom.match(/job_name:/g) ?? []).length;
ok(jobCount >= JOBS.length, `prometheus job 数 ≥ ${JOBS.length}（实测 ${jobCount}）`);
for (const svc of JOBS) ok(prom.includes(`job_name: ${svc}`), `prometheus 抓取 ${svc}`);


/* ── 多玩法 A1（2026-10-25）：告警规则解析 + 看板按玩法分组 ─────────────── */
const ALERT_FILE = join(ROOT, 'deploy/monitoring/prometheus/rules/ftl-alerts.yml');
const EXPECTED_ALERTS = [
  'Watchdog', 'ServiceDown', 'Http5xxRatioHigh', 'Http5xxRatioCritical',
  'HostDiskSpaceLow', 'HostDiskSpaceCritical', 'HostMemoryAvailableLow',
  'WsConnectionsHigh', 'WsConnectionsCritical', 'ContainerRestartFlapping',
  'RecordsCleanupStalled', 'RecordsCleanupFailing', 'AlertDeliveryFailing',
  'CurrencySettleOutboxStuck', 'CurrencyReconcileDrift', 'CurrencyRobotPoolLow',
  'RiskScanStalled', 'MatchPredicateRejectionHigh',
  'PaymentFundOpStalled', 'PaymentNotifyBadSignSpike', 'WithdrawBacklog',
  'PaymentLateNotifyReopen', 'PaymentReconcileDiff',
  'NotifyEmailIncomplete', 'NotifyDingtalkIncomplete',
  'ReliefCallbackBroken', 'ReliefGrantZero',
  'GameStartFailuresHigh', 'GameSettleFailures', 'SettleDroppedByGame', 'RecordWriteFailuresHigh',
  'RiskScanSqlFailures',
];
const alertText = readFileSync(ALERT_FILE, 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
const alertRaw = readFileSync(ALERT_FILE, 'utf8');
ok(alertRaw.includes('**32 条**') && alertRaw.includes('32 条 = 29 类'), '告警头注释为 32 条 / 29 类');
const alertNames = [...alertText.matchAll(/^\s*-\s+alert:\s*(\S+)/gm)].map((m) => m[1]);
ok(alertNames.length === EXPECTED_ALERTS.length, `告警规则恰 ${EXPECTED_ALERTS.length} 条（实测 ${alertNames.length}）`);
ok(
  EXPECTED_ALERTS.every((n) => alertNames.includes(n)),
  `告警名集齐（缺 ${EXPECTED_ALERTS.filter((n) => !alertNames.includes(n)).join(',') || '无'}）`,
);
const ALERT_PREDICATES = {
  GameStartFailuresHigh: ['reason="cancelled"', '>= 5'],
  GameSettleFailures: ['phase', '> 0'],
  SettleDroppedByGame: ['result="dropped"'],
  RecordWriteFailuresHigh: ['kind="record_lost"', '>= 3'],
};
for (const [name, needles] of Object.entries(ALERT_PREDICATES)) {
  const block = new RegExp(`- alert: ${name}[\\s\\S]*?(?=\\n\\s*- alert:|$)`).exec(alertText)?.[0] ?? '';
  ok(block !== '', `存在告警 ${name}`);
  ok(/^\s*expr:\s*.*game_type/m.test(block), `${name} 的 expr 含 game_type`);
  for (const needle of needles) ok(block.includes(needle), `${name} 含关键谓词 ${needle}`);
  ok((alertText.match(new RegExp(`- alert: ${name}\\b`, 'g')) ?? []).length === 1, `${name} 规则名唯一`);
}

// B 组：SQL 失败告警按 scope 分组，不含 game_type（scope 覆盖 device）。
const sqlFailBlock =
  /- alert: RiskScanSqlFailures[\s\S]*?(?=\n\s*- alert:|$)/.exec(alertText)?.[0] ?? '';
ok(sqlFailBlock !== '', '存在告警 RiskScanSqlFailures');
ok(/^\s*expr:\s*.*sum by \(scope\).*increase\(risk_scan_sql_failures_total/m.test(sqlFailBlock),
  'RiskScanSqlFailures expr = sum by (scope) increase(risk_scan_sql_failures_total…)');
ok(sqlFailBlock.includes('> 0'), 'RiskScanSqlFailures 含阈值 > 0');
ok((alertText.match(/- alert: RiskScanSqlFailures\b/g) ?? []).length === 1,
  'RiskScanSqlFailures 规则名唯一');

const dashboardTargets = [
  ['02-business.json', '匹配队列深度（按模式/档位）', 'A', 'match_queue_length', true],
  ['02-business.json', '活跃房间 / 对局', 'A', 'rooms_active', true],
  ['02-business.json', '活跃房间 / 对局', 'B', 'games_active', true],
  ['02-business.json', '活跃房间 / 对局', 'C', 'rooms_active', false],
  ['02-business.json', '活跃房间 / 对局', 'D', 'games_active', false],
  ['02-business.json', '开局 / 结算速率', 'A', 'games_started_total', true],
  ['02-business.json', '开局 / 结算速率', 'B', 'games_ended_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'A', 'robot_decisions_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'B', 'robot_decision_errors_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'C', 'robot_rule_errors_total', true],
  ['05-currency.json', '结算补偿队列最老滞留（告警线 300s）', 'A', 'currency_settle_outbox_oldest_seconds', true],
  ['05-currency.json', '结算结果速率（按 result / 5m：ok|replayed|retried|r2|outboxed|dropped）', 'A', 'currency_settle_result_total', true],
  ['05-currency.json', '残差（应恒 0，非 0 即回归）', 'A', 'currency_settle_residue_total', true],
  ['05-currency.json', '机器人补给/回收速率（按 action / 5m：refill|recall）', 'A', 'currency_robot_topup_total', true],
  ['05-currency.json', '机器人 ensure 失败累计', 'A', 'currency_robot_ensure_failed_total', true],
  ['05-currency.json', '台费收/漏（按 reason / 5m：insufficient_funds|unknown_outcome|internal_error）', 'A', 'entry_fee_skipped_total', true],
  ['05-currency.json', '台费收/漏（按 reason / 5m：insufficient_funds|unknown_outcome|internal_error）', 'B', 'entry_fee_conflict_total', true],
  ['05-currency.json', '虚拟池余额（告警线 100 万）', 'A', 'currency_robot_pool_balance', false],
  ['05-currency.json', '机器人账户余额总量（僵尸余额通缩观测）', 'A', 'currency_robot_accounts_balance_sum', false],
  ['05-currency.json', '救助速率（按 result / 5m：granted|replayed|rejected）', 'A', 'currency_relief_total', false],
  ['04-records-backup.json', '记录删除速率', 'A', 'records_rows_deleted_total', true],
  ['04-records-backup.json', 'records 表字节', 'A', 'records_table_bytes', false],
  ['06-risk.json', '谓词拒绝速率（按 predicate / 5m：sameDevice|sameIp；记忆拒绝不计）', 'A', 'match_predicate_rejections_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'A', 'match_selection_rounds_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'B', 'match_no_legal_group_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'C', 'match_predicate_rejections_total', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'A', 'risk_scan_runs_total', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'B', 'risk_scan_last_success_timestamp_seconds', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'C', 'risk_scan_hits_total', true],
  ['06-risk.json', '待审队列水位（risk_reviews_open；无自动告警——目视）', 'A', 'risk_reviews_open', false],
  ['06-risk.json', '处置动作速率（按 action / 5m：auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen）', 'A', 'risk_actions_total', false],
];
const dashboards = new Map(
  readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(DIR, f), 'utf8'))]),
);
const byPanel = new Map();
for (const [file, title, refId, metric, expectGameType] of dashboardTargets) {
  const dash = dashboards.get(file);
  const panel = dash?.panels?.find((p) => p.title === title);
  const target = panel?.targets?.find((t) => t.refId === refId);
  ok(target !== undefined, `${file}「${title}」存在 target ${refId}`);
  if (!target) continue;
  const expr = String(target.expr);
  ok(expr.includes(metric), `${file}「${title}」${refId} 引用 ${metric}`);
  if (expectGameType) {
    ok(/by\s*\([^)]*\bgame_type\b/.test(expr), `${file}「${title}」${refId} 用 by (game_type)（实际：${expr}）`);
  } else {
    ok(!/\bgame_type\b/.test(expr), `${file}「${title}」${refId} 不应出现 game_type（实际：${expr}）`);
  }
  const key = `${file}\u0000${title}`;
  const expected = byPanel.get(key) ?? new Set();
  expected.add(refId);
  byPanel.set(key, expected);
}
for (const [key, expected] of byPanel) {
  const [file, title] = key.split('\u0000');
  const dash = dashboards.get(file);
  const panel = dash?.panels?.find((p) => p.title === title);
  const actual = new Set((panel?.targets ?? []).map((t) => t.refId));
  ok(
    actual.size === expected.size && [...expected].every((r) => actual.has(r)),
    `${file}「${title}」target refId 集合严格等于白名单（实际 ${[...actual].join(',')}；期望 ${[...expected].join(',')}）`,
  );
}

if (failures.length) {
  console.error(`monitoring verify: ${failures.length} FAILED / ${checks} checks`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`monitoring verify: ${checks} checks passed`);
