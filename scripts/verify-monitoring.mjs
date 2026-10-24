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

if (failures.length) {
  console.error(`monitoring verify: ${failures.length} FAILED / ${checks} checks`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`monitoring verify: ${checks} checks passed`);
