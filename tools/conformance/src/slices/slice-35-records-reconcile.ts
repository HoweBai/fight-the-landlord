/**
 * slice-35：C2 资金↔记录对账（`RecordsReconcileService` 真栈）。
 *
 * ─── 判据载体 ───────────────────────────────────────────────────────────────
 *  - 注入：`currency_ops` / `currency_flows` / `currency_entry_fee_skips` /
 *    `game_records(_pdk)` / `game_record_players(_pdk)` 的 RUN_TAG 唯一行（直连 MySQL）；
 *  - 触发：`docker restart ftl-currency-service` ⇒ 启动 10s 首跑 ⇒ 轮询
 *    `GET /api/admin/wallet/reconcile` 的 `data.records`（running=false + lastResult 新鲜）；
 *  - 断言：GET 结果 / 9004 gauges 一致；两玩法分桶；跨界（60h 前 filler 不计）；
 *    分页 sentinel（5,000 filler ops + 5,001 filler players 之后的判据行必须被第 2 页消费）；
 *    台费 suspect（先 PUT `entryFeePercent>0` 档位，finally 还原）与 unknown；
 *    零写（注入行数前后不变）；pdk 注入行清零后的下一轮把 pdk gauges 归零（0 行玩法）。
 *
 * ─── 三轮（A 基线 / B 注入 / C pdk 清零）─────────────────────────────────────
 *  为什么用**增量**而不是绝对值：全序真栈里 48h 窗口内本就有前序切片的真实对局
 *  （且台费配置会影响它们的 suspect/unknown 归类）。A/B/C 都在**同一份强制档位**下，
 *  A 是注入前基线，B−A = 本片注入的增量，C 删除 pdk 行后 pdk 回到 A ⇒ 判别力不受脏库影响。
 *  ⚠️ 时间敏感行全部用 `NOW(3)` 相对时间：filler 在 60h（窗外、查询余量内）；判据行 1–3h。
 *
 * 本机 Docker 不可用 ⇒ 本片只做 tsc；真栈执行登记「待权威轮」。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  INTERNAL_TOKEN,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
} from '../lib/http';
import { mysqlExec, mysqlNum } from '../lib/mysql';
import { execCurl, seriesValueExact, sumMetric } from '../lib/prom-text';

const REPO_ROOT = resolve(__dirname, '../../../..');
const TAG = Date.now().toString(36).toUpperCase().slice(-5);
const ROOM = (suffix: string): string => `S35${TAG}${suffix}`;
const FILLER_PREFIX = `S35Z${TAG}`;
const ACTION = (suffix: string): string => `s35${TAG}:${suffix}`;
const USERS = ['u-s35-a', 'u-s35-b', 'u-s35-c'] as const;
const LEVELS_KEY = 'game.levels.doudizhu';
const CURRENCY = { container: 'ftl-currency-service', port: 9004 } as const;

const HOUR = 3_600;
const FILLER_SECONDS = 60 * HOUR; // 窗外（48h）、查询余量内（72h）
const ORPHAN_SECONDS = 26 * HOUR; // > 25h ⇒ orphan / entryFeeOrphanOps
const OLD_RECORD_SECONDS = 3 * HOUR; // > 2h ⇒ missing / nullNoOp
const FRESH_SECONDS = 1 * HOUR;

const DELTAS = [150, -100, -50] as const;
const SCORES = [200, -120, -80] as const;

interface Counts {
  orphanOps: number;
  missingOps: number;
  nullNoOp: number;
  amountMismatch: number;
  pending: number;
  nullMoneyDelta: number;
  entryFeeSuspect: number;
  entryFeeUnknown: number;
  entryFeeOrphanOps: number;
  configUnavailable: number;
}

interface RoundResult extends Counts {
  truncated: boolean;
  byGame: { doudizhu: Counts; paodekuai: Counts };
}

interface RecordsStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastResult: RoundResult | null;
  lastError: string | null;
  running: boolean;
}

interface ConfigEntry {
  value: unknown;
  version: number;
}

interface AdminConfig {
  config: Record<string, ConfigEntry>;
  version: number;
}

/** 逐字段 ↔ 指标名（GET 与 gauges 的一致性断言按这张表）。 */
const COUNT_METRICS: ReadonlyArray<readonly [keyof Counts, string]> = [
  ['orphanOps', 'currency_records_reconcile_orphan_ops'],
  ['missingOps', 'currency_records_reconcile_missing_ops'],
  ['nullNoOp', 'currency_records_reconcile_null_no_op'],
  ['amountMismatch', 'currency_records_reconcile_amount_mismatch'],
  ['pending', 'currency_records_reconcile_pending'],
  ['nullMoneyDelta', 'currency_records_reconcile_null_money_delta'],
  ['entryFeeSuspect', 'currency_records_reconcile_entry_fee_suspect'],
  ['entryFeeUnknown', 'currency_records_reconcile_entry_fee_unknown'],
  ['entryFeeOrphanOps', 'currency_records_reconcile_entry_fee_orphan_ops'],
  ['configUnavailable', 'currency_records_reconcile_config_unavailable'],
] as const;

const GAMES = ['doudizhu', 'paodekuai'] as const;

/** 注入的期望增量（B − A）。 */
const EXPECTED_DELTA: Record<(typeof GAMES)[number], Partial<Counts>> = {
  doudizhu: {
    orphanOps: 1,
    missingOps: 1,
    nullNoOp: 1,
    amountMismatch: 1,
    entryFeeSuspect: 3,
    entryFeeUnknown: 3,
    entryFeeOrphanOps: 1,
  },
  paodekuai: { orphanOps: 1 },
};

/* ── 通用轮询/容器助手 ─────────────────────────────────────────────────── */

async function pollUntil<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

function tail(text: string, lines = 3): string {
  return text.trim().split('\n').slice(-lines).join(' / ');
}

function dockerRestart(): void {
  const r = spawnSync('docker', ['restart', CURRENCY.container], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if ((r.status ?? -1) !== 0) {
    throw new ConformanceError(
      `docker restart ${CURRENCY.container} 失败（exit ${r.status ?? -1}）：${tail(`${r.stdout ?? ''}${r.stderr ?? ''}`)}`,
    );
  }
}

async function waitHealthy(container: string, timeoutMs = 90_000): Promise<void> {
  const hit = await pollUntil(
    () => {
      const r = spawnSync('docker', ['inspect', container, '--format', '{{.State.Health.Status}}'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 20_000,
      });
      return `${(r.stdout ?? '').trim() || (r.stderr ?? '').trim()}`;
    },
    (status) => status === 'healthy',
    timeoutMs,
  );
  if (!hit.ok) throw new ConformanceError(`${container} 90s 内未 healthy（最后状态：${hit.last}）`);
}

function currencyLogs(sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, 'currency-service'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/* ── 管理面 / 配置 ─────────────────────────────────────────────────────── */

async function readRecordsStatus(admin: string): Promise<RecordsStatus> {
  const res = await getJson<{ records?: RecordsStatus }>('/api/admin/wallet/reconcile', admin);
  if (res.status !== 200 || res.body?.code !== ErrCode.OK || res.body.data?.records === undefined) {
    throw new ConformanceError(`GET reconcile.records 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.records;
}

async function readAdminConfig(admin: string): Promise<AdminConfig> {
  const res = await adminGetConfig<AdminConfig>(admin);
  if (res.body?.code !== ErrCode.OK || res.body.data === undefined) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

/** PUT 档位表并返回**应出现的快照版本**（`max(全局限, 本键版本+1)`，照 slice-31 口径）。 */
async function putLevels(admin: string, levels: unknown): Promise<number> {
  const before = await readAdminConfig(admin);
  const expected = Math.max(before.version, (before.config[LEVELS_KEY]?.version ?? 0) + 1);
  const put = await adminPutConfig(LEVELS_KEY, levels, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`PUT ${LEVELS_KEY} 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  return expected;
}

async function waitSnapshotApplied(version: number): Promise<void> {
  const hit = await pollUntil(
    () => currencyLogs(300).includes(`config snapshot applied (version=${version})`),
    (found) => found,
    30_000,
  );
  if (!hit.ok) {
    throw new ConformanceError(`currency-service 30s 内未应用配置快照 version=${version}`);
  }
}

/** 原始档位 → 强制 15 档 10%、80 档 0%（suspect/unknown 可判别；其余保留）。 */
function forcedLevels(original: unknown): Array<Record<string, unknown>> {
  const source = Array.isArray(original) ? original : [];
  const levels: Array<Record<string, unknown>> = source.map((item) => {
    const level = item as Record<string, unknown>;
    return { ...level, entryFeePercent: Number(level['entryFeePercent'] ?? 0) };
  });
  const force = (baseScore: number, name: string, percent: number): void => {
    const index = levels.findIndex((level) => Number(level['baseScore']) === baseScore);
    if (index >= 0) levels[index] = { ...levels[index]!, entryFeePercent: percent };
    else levels.push({ name, baseScore, entryFeePercent: percent });
  };
  force(15, '休闲场', 10);
  force(80, '标准场', 0);
  return levels;
}

/* ── SQL 注入 ──────────────────────────────────────────────────────────── */

const secAgo = (seconds: number): string => `DATE_SUB(NOW(3), INTERVAL ${seconds} SECOND)`;
const msAgo = (seconds: number): string => `(UNIX_TIMESTAMP(NOW(3)) - ${seconds}) * 1000`;
const num = (value: number | null): string => (value === null ? 'NULL' : String(value));

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 本片全部注入行的删除（起手 + finally；按前缀，幂等）。 */
function cleanupInjected(): void {
  mysqlExec(
    `DELETE f FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id ` +
      `WHERE o.action_id LIKE 's35${TAG}:%' OR o.action_id LIKE 'entryfee:S35${TAG}%';` +
      `DELETE FROM currency_ops WHERE action_id LIKE 's35${TAG}:%' OR action_id LIKE 'entryfee:S35${TAG}%';` +
      `DELETE FROM currency_entry_fee_skips WHERE room_code LIKE 'S35${TAG}%' OR room_code LIKE 'S35Z${TAG}%';` +
      `DELETE p FROM game_record_players p JOIN game_records r ON p.record_id = r.id ` +
      `WHERE r.room_code LIKE 'S35${TAG}%' OR r.room_code LIKE 'S35Z${TAG}%';` +
      `DELETE FROM game_records WHERE room_code LIKE 'S35${TAG}%' OR room_code LIKE 'S35Z${TAG}%';` +
      `DELETE p FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id ` +
      `WHERE r.room_code LIKE 'S35${TAG}%';` +
      `DELETE FROM game_records_pdk WHERE room_code LIKE 'S35${TAG}%';`,
  );
}

/** 只删 pdk（轮 C 的「0 行玩法」：pdk 注入行清零、ddz 判据行保留）。 */
function cleanupPdkInjected(): void {
  const pdkRooms = `('${ROOM('B')}:1', '${ROOM('P')}:1')`;
  mysqlExec(
    `DELETE f FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id WHERE o.ref_id IN ${pdkRooms};` +
      `DELETE FROM currency_ops WHERE ref_id IN ${pdkRooms};` +
      `DELETE FROM currency_entry_fee_skips WHERE room_code = '${ROOM('B')}';` +
      `DELETE p FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id ` +
      `WHERE r.room_code IN ('${ROOM('B')}', '${ROOM('P')}');` +
      `DELETE FROM game_records_pdk WHERE room_code IN ('${ROOM('B')}', '${ROOM('P')}');`,
  );
}

/** 本片注入面的行数快照（零写判据；只数前缀行，不受前序切片影响）。 */
function injectedRowCounts(): Record<string, number> {
  const opWhere = `(o.action_id LIKE 's35${TAG}:%' OR o.action_id LIKE 'entryfee:S35${TAG}%')`;
  return {
    ops: mysqlNum(
      `SELECT COUNT(*) FROM currency_ops o WHERE ${opWhere}`,
    ),
    flows: mysqlNum(
      `SELECT COUNT(*) FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id WHERE ${opWhere}`,
    ),
    skips: mysqlNum(
      `SELECT COUNT(*) FROM currency_entry_fee_skips WHERE room_code LIKE 'S35${TAG}%' OR room_code LIKE 'S35Z${TAG}%'`,
    ),
    ddzRecords: mysqlNum(
      `SELECT COUNT(*) FROM game_records WHERE room_code LIKE 'S35${TAG}%' OR room_code LIKE 'S35Z${TAG}%'`,
    ),
    ddzPlayers: mysqlNum(
      `SELECT COUNT(*) FROM game_record_players p JOIN game_records r ON p.record_id = r.id ` +
        `WHERE r.room_code LIKE 'S35${TAG}%' OR r.room_code LIKE 'S35Z${TAG}%'`,
    ),
    pdkRecords: mysqlNum(
      `SELECT COUNT(*) FROM game_records_pdk WHERE room_code LIKE 'S35${TAG}%'`,
    ),
    pdkPlayers: mysqlNum(
      `SELECT COUNT(*) FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id ` +
        `WHERE r.room_code LIKE 'S35${TAG}%'`,
    ),
  };
}

function insertSettleOp(
  room: string,
  gameType: 'doudizhu' | 'paodekuai',
  secondsAgo: number,
  deltas: readonly number[],
  residue = 0,
  rake = 0,
): void {
  const actionId = ACTION(`settle:${room}`);
  const flows = deltas
    .map((delta, seat) => `(@op, '${USERS[seat]!}', 'user', ${delta}, 1000)`)
    .join(', ');
  mysqlExec(
    `INSERT INTO currency_ops (action_id, request_hash, source, game_type, ref_id, burned_residue, burned_rake, created_at) ` +
      `VALUES ('${actionId}', REPEAT('a',64), 'game_settle', '${gameType}', '${room}:1', ${residue}, ${rake}, ${secAgo(secondsAgo)});` +
      `SET @op := (SELECT id FROM currency_ops WHERE action_id = '${actionId}');` +
      `INSERT INTO currency_flows (op_id, owner_id, owner_type, delta, balance_after) VALUES ${flows};`,
  );
}

/** 孤儿 settle op（无 flows、无记录）。 */
function insertOrphanSettleOp(room: string, gameType: 'doudizhu' | 'paodekuai', secondsAgo: number): void {
  const actionId = ACTION(`settle:${room}`);
  mysqlExec(
    `INSERT INTO currency_ops (action_id, request_hash, source, game_type, ref_id, burned_residue, burned_rake, created_at) ` +
      `VALUES ('${actionId}', REPEAT('a',64), 'game_settle', '${gameType}', '${room}:1', NULL, NULL, ${secAgo(secondsAgo)});`,
  );
}

/** 台费孤儿 op（`action_id=entryfee:<room>:<owner>`，无 flows、无记录）。 */
function insertFeeOrphanOp(room: string, gameType: 'doudizhu' | 'paodekuai', secondsAgo: number): void {
  mysqlExec(
    `INSERT INTO currency_ops (action_id, request_hash, source, game_type, ref_id, burned_residue, burned_rake, created_at) ` +
      `VALUES ('entryfee:${room}:${USERS[0]}', REPEAT('a',64), 'entry_fee', '${gameType}', '${room}', NULL, NULL, ${secAgo(secondsAgo)});`,
  );
}

function insertSkips(room: string, gameType: 'doudizhu' | 'paodekuai', secondsAgo: number): void {
  const values = USERS.map(
    (owner, seat) =>
      `('${room}', '${owner}', ${seat}, '${gameType}', 15, 1, 'insufficient_funds', NULL, ${secAgo(secondsAgo)})`,
  ).join(', ');
  mysqlExec(
    `INSERT INTO currency_entry_fee_skips (room_code, owner_id, seat, game_type, base_score, fee_amount, reason, trace_id, created_at) ` +
      `VALUES ${values};`,
  );
}

function insertDdzRecord(
  room: string,
  secondsAgo: number,
  money: ReadonlyArray<number | null>,
  scores: readonly number[],
  baseScore = 15,
): void {
  const roles = ['landlord', 'farmer', 'farmer'] as const;
  const playerValues = USERS.map(
    (owner, seat) =>
      `SELECT id, ${seat}, '${owner}', 0, NULL, NULL, '${roles[seat]!}', ${scores[seat]!}, ${seat === 0 ? 1 : 0}, ` +
      `REPEAT('0',34), ${num(money[seat]!)}, ${secAgo(secondsAgo)} FROM game_records WHERE room_code = '${room}'`,
  );
  mysqlExec(
    `INSERT INTO game_records (room_code, game_version, mode, base_score, winner, landlord_seat, multiplier, spring, ` +
      `landlord_score_change, farmer_score_change, bottom_cards, started_at, ended_at, created_at) ` +
      `VALUES ('${room}', 1, 'gold', ${baseScore}, 'landlord', 0, 1, 'none', 0, 0, '000000', ` +
      `${secAgo(secondsAgo + 60)}, ${secAgo(secondsAgo)}, NOW(3));` +
      playerValues.map((selectSql) => `INSERT INTO game_record_players (record_id, seat, user_id, is_robot, robot_id, nickname, role, score_change, won, hand, money_delta, ended_at) ${selectSql};`).join(''),
  );
}

function insertPdkRecord(
  room: string,
  secondsAgo: number,
  money: ReadonlyArray<number | null>,
  scores: readonly number[],
): void {
  const playerValues = USERS.map(
    (owner, seat) =>
      `SELECT id, ${seat}, '${owner}', 0, NULL, NULL, REPEAT('0',32), 0, ${scores[seat]!}, ` +
      `${seat === 0 ? 1 : 0}, ${num(money[seat]!)}, ${msAgo(secondsAgo)} FROM game_records_pdk WHERE room_code = '${room}'`,
  );
  mysqlExec(
    `INSERT INTO game_records_pdk (room_code, game_version, mode, player_count, base_score, winner_seat, remaining, ` +
      `multiplier, bomb_count, guan, spring, baoben_seats, score_changes, unused_cards, started_at, ended_at) ` +
      `VALUES ('${room}', 1, 'gold', 3, 15, 0, '[]', 1, 0, 0, 0, '[]', '[]', NULL, ` +
      `${msAgo(secondsAgo + 60)}, ${msAgo(secondsAgo)});` +
      playerValues.map((selectSql) => `INSERT INTO game_record_players_pdk (record_id, seat, user_id, is_robot, robot_id, nickname, hand, played_count, score_change, won, money_delta, ended_at) ${selectSql};`).join(''),
  );
}

/**
 * 分页 filler：**先于一切判据行**插入。
 *  - 5,000 个 `game_settle` op（60h 前、无记录）：窗外 ⇒ 不得计 orphan；
 *  - 1,667 条记录 × 3 玩家 = 5,001 个玩家行（60h 前、money_delta=1）：窗外 ⇒ 不得计 missing。
 * 两批都落在查询余量窗内 ⇒ 强制 keyset 第 2 页；sentinel 判据行在其后插入。
 */
function insertPaginationFillers(): void {
  const opValues: string[] = [];
  for (let i = 0; i < 5_000; i += 1) {
    opValues.push(
      `('s35${TAG}:f${i}', REPEAT('a',64), 'game_settle', 'doudizhu', '${FILLER_PREFIX}F${i}:1', NULL, NULL, ${secAgo(FILLER_SECONDS)})`,
    );
  }
  for (const chunk of chunks(opValues, 500)) {
    mysqlExec(
      `INSERT INTO currency_ops (action_id, request_hash, source, game_type, ref_id, burned_residue, burned_rake, created_at) ` +
        `VALUES ${chunk.join(', ')};`,
    );
  }

  const recordValues: string[] = [];
  for (let i = 0; i < 1_667; i += 1) {
    recordValues.push(
      `('${FILLER_PREFIX}R${i}', 1, 'gold', 15, 'landlord', 0, 1, 'none', 0, 0, '000000', ` +
        `${secAgo(FILLER_SECONDS + 60)}, ${secAgo(FILLER_SECONDS)}, NOW(3))`,
    );
  }
  for (const chunk of chunks(recordValues, 250)) {
    mysqlExec(
      `INSERT INTO game_records (room_code, game_version, mode, base_score, winner, landlord_seat, multiplier, spring, ` +
        `landlord_score_change, farmer_score_change, bottom_cards, started_at, ended_at, created_at) ` +
        `VALUES ${chunk.join(', ')};`,
    );
  }
  const roles = ['landlord', 'farmer', 'farmer'] as const;
  for (let seat = 0; seat < 3; seat += 1) {
    mysqlExec(
      `INSERT INTO game_record_players (record_id, seat, user_id, is_robot, robot_id, nickname, role, score_change, won, hand, money_delta, ended_at) ` +
        `SELECT id, ${seat}, 'u-s35f-${seat}', 0, NULL, NULL, '${roles[seat]!}', 0, ${seat === 0 ? 1 : 0}, REPEAT('0',34), 1, ${secAgo(FILLER_SECONDS)} ` +
        `FROM game_records WHERE room_code LIKE '${FILLER_PREFIX}R%';`,
    );
  }
}

/* ── 断言助手 ──────────────────────────────────────────────────────────── */

function gauge(text: string, metric: string, gameType: string): number {
  return seriesValueExact(text, metric, { game_type: gameType }) ?? 0;
}

function assertGetMatchesGauges(
  checks: Checks,
  text: string,
  result: RoundResult,
  label: string,
  games: readonly (typeof GAMES)[number][] = GAMES,
): void {
  for (const game of games) {
    for (const [field, metric] of COUNT_METRICS) {
      checks.eq(
        gauge(text, metric, game),
        result.byGame[game][field],
        `${label} GET records.byGame.${game}.${field} == gauge ${metric}{game_type="${game}"}`,
      );
    }
  }
}

function assertDelta(
  checks: Checks,
  label: string,
  before: RoundResult,
  after: RoundResult,
): void {
  for (const game of GAMES) {
    for (const [field] of COUNT_METRICS) {
      const expected = EXPECTED_DELTA[game][field] ?? 0;
      checks.eq(
        after.byGame[game][field] - before.byGame[game][field],
        expected,
        `${label} ΔbyGame.${game}.${field} = ${expected}`,
      );
    }
  }
  // totals = 两玩法之和（增量同理）
  for (const [field] of COUNT_METRICS) {
    const expected = (EXPECTED_DELTA.doudizhu[field] ?? 0) + (EXPECTED_DELTA.paodekuai[field] ?? 0);
    checks.eq(after[field] - before[field], expected, `${label} Δtotals.${field} = ${expected}`);
  }
}

/** 重启 → healthy → 等一轮新鲜成功（含配置快照未就绪的一次重试）。 */
async function restartAndRound(admin: string): Promise<RecordsStatus> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const restartAt = Date.now();
    dockerRestart();
    await waitHealthy(CURRENCY.container);
    const hit = await pollUntil(
      () => readRecordsStatus(admin),
      (status) =>
        !status.running &&
        status.lastResult !== null &&
        (status.lastSuccessAt ?? 0) >= restartAt - 5_000,
      120_000,
      2_000,
    );
    if (!hit.ok) {
      throw new ConformanceError(
        `重启后 120s 内未见新鲜对账轮（lastSuccessAt=${hit.last.lastSuccessAt}，` +
          `lastError=${JSON.stringify(hit.last.lastError)}）`,
      );
    }
    if (hit.last.lastResult!.configUnavailable === 0) return hit.last;
    info(`配置快照未就绪（configUnavailable=1），重启重试第 ${attempt + 2} 次`);
  }
  throw new ConformanceError('配置快照连续两轮不可用（configUnavailable=1）');
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

export async function runSlice35(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const admin = await adminLogin();
  const originalConfig = await readAdminConfig(admin);
  const originalLevels = originalConfig.config[LEVELS_KEY]?.value;
  let primaryError: unknown = null;

  try {
    step('⓪ 起手：清本片前缀残留 + 强制档位（15 档 10% / 80 档 0%）+ 基线轮 A');
    cleanupInjected();
    // PUT 落库即可：随后 restart 的新进程启动时拉的就是这份快照（10s 首跑前完成）。
    await putLevels(admin, forcedLevels(originalLevels));
    const baseline = await restartAndRound(admin);
    checks.that(!baseline.running && baseline.lastResult !== null, '⓪ 基线轮 A 完成（running=false、lastResult 非空）');
    checks.eq(baseline.lastResult!.configUnavailable, 0, '⓪ 基线轮 A config_unavailable = 0（档位快照就绪）');
    checks.eq(baseline.lastResult!.truncated, false, '⓪ 基线轮 A truncated = false');
    checks.that(
      Date.now() - (baseline.lastSuccessAt ?? 0) <= 90_000,
      '⓪ 基线轮 lastSuccessAt 新鲜（≤90s）',
    );

    step('① 注入判据行：一致 ddz/pdk、孤儿、missing sentinel、NULL、金额不一致、台费 suspect/unknown/孤儿、跨界 filler、分页 filler');
    cleanupInjected(); // 幂等（A 之后无注入；重跑安全）
    insertPaginationFillers();
    // 一致 ddz / pdk
    insertSettleOp(ROOM('A'), 'doudizhu', FRESH_SECONDS, DELTAS);
    insertDdzRecord(ROOM('A'), FRESH_SECONDS, DELTAS, SCORES);
    insertSkips(ROOM('A'), 'doudizhu', FRESH_SECONDS);
    insertSettleOp(ROOM('B'), 'paodekuai', FRESH_SECONDS, DELTAS);
    insertPdkRecord(ROOM('B'), FRESH_SECONDS, DELTAS, SCORES);
    insertSkips(ROOM('B'), 'paodekuai', FRESH_SECONDS);
    // 孤儿 op（ddz sentinel + pdk）
    insertOrphanSettleOp(ROOM('O'), 'doudizhu', ORPHAN_SECONDS);
    insertOrphanSettleOp(ROOM('P'), 'paodekuai', ORPHAN_SECONDS);
    // 记录无 op：missing sentinel（分页第 2 页）+ 任一 NULL 无非零
    insertDdzRecord(ROOM('M'), OLD_RECORD_SECONDS, DELTAS, SCORES);
    insertSkips(ROOM('M'), 'doudizhu', OLD_RECORD_SECONDS);
    insertDdzRecord(ROOM('N'), OLD_RECORD_SECONDS, [null, 0, 0], [0, 0, 0]);
    insertSkips(ROOM('N'), 'doudizhu', OLD_RECORD_SECONDS);
    // 金额不一致（flow 151 vs money_delta 150）
    insertSettleOp(ROOM('X'), 'doudizhu', FRESH_SECONDS, [151, -100, -50]);
    insertDdzRecord(ROOM('X'), FRESH_SECONDS, DELTAS, SCORES);
    insertSkips(ROOM('X'), 'doudizhu', FRESH_SECONDS);
    // 台费 suspect（15 档 10% ⇒ 1）与 unknown（80 档 0% ⇒ 0）：都无 op/skip
    insertSettleOp(ROOM('S'), 'doudizhu', FRESH_SECONDS, DELTAS);
    insertDdzRecord(ROOM('S'), FRESH_SECONDS, DELTAS, SCORES);
    insertSettleOp(ROOM('U'), 'doudizhu', FRESH_SECONDS, DELTAS);
    insertDdzRecord(ROOM('U'), FRESH_SECONDS, DELTAS, SCORES, 80);
    // 台费孤儿 op（>25h）
    insertFeeOrphanOp(ROOM('F'), 'doudizhu', ORPHAN_SECONDS);

    // 行数自证：分页 sentinel 必须排在第 1 页之后（5,000 ops / 5,000 players 之前缀行）。
    const injected = injectedRowCounts();
    checks.that(injected['ops']! >= 5_001, `① 注入 ops ≥ 5,001（分页 filler 5,000 + 判据行；实测 ${injected['ops']}）`);
    checks.that(
      injected['ddzPlayers']! >= 5_001,
      `① 注入 ddz players ≥ 5,001（分页 filler 5,001 + 判据行；实测 ${injected['ddzPlayers']}）`,
    );

    step('② 重启 currency-service ⇒ 轮 B：GET/gauge 一致 + 逐字段增量（含跨界 filler 不计）');
    const roundB = await restartAndRound(admin);
    const resultB = roundB.lastResult!;
    checks.eq(resultB.truncated, false, '② 轮 B truncated = false（单查询未超 20 万行）');
    checks.eq(resultB.configUnavailable, 0, '② 轮 B config_unavailable = 0');
    assertDelta(checks, '②', baseline.lastResult!, resultB);

    const metricsB = execCurl(CURRENCY.container, CURRENCY.port, INTERNAL_TOKEN);
    checks.eq(metricsB.status, 200, '② currency-service /metrics HTTP 200');
    assertGetMatchesGauges(checks, metricsB.body, resultB, '②');
    checks.eq(
      seriesValueExact(metricsB.body, 'currency_records_reconcile_truncated', {}) ?? 0,
      0,
      '② gauge truncated = 0',
    );
    checks.eq(
      seriesValueExact(metricsB.body, 'currency_records_reconcile_config_unavailable', { game_type: 'doudizhu' }) ?? 0,
      0,
      '② gauge config_unavailable{ddz} = 0',
    );
    checks.eq(
      seriesValueExact(metricsB.body, 'currency_records_reconcile_config_unavailable', { game_type: 'paodekuai' }) ?? 0,
      0,
      '② gauge config_unavailable{pdk} = 0',
    );
    checks.atLeast(
      sumMetric(metricsB.body, 'currency_records_reconcile_runs_total'),
      1,
      '② runs_total ≥ 1（本轮已计入）',
    );

    // 零写：注入行数在整轮前后不变（只读服务）。
    const afterRound = injectedRowCounts();
    checks.eq(
      JSON.stringify(afterRound),
      JSON.stringify(injected),
      '② 零写：注入的 ops/flows/skips/records/players 行数前后不变',
    );

    step('③ 删除 pdk 注入行 ⇒ 轮 C：pdk gauges 回到基线（0 行玩法），ddz 判据仍在');
    cleanupPdkInjected();
    const roundC = await restartAndRound(admin);
    const resultC = roundC.lastResult!;
    checks.eq(resultC.truncated, false, '③ 轮 C truncated = false');
    checks.eq(resultC.configUnavailable, 0, '③ 轮 C config_unavailable = 0');
    const metricsC = execCurl(CURRENCY.container, CURRENCY.port, INTERNAL_TOKEN);
    checks.eq(metricsC.status, 200, '③ currency-service /metrics HTTP 200');
    for (const [field, metric] of COUNT_METRICS) {
      const expected = baseline.lastResult!.byGame.paodekuai[field];
      checks.eq(
        gauge(metricsC.body, metric, 'paodekuai'),
        expected,
        `③ pdk 注入行清零后 gauge ${metric}{game_type="paodekuai"} 回到基线 ${expected}（0 行玩法）`,
      );
      checks.eq(
        resultC.byGame.paodekuai[field],
        expected,
        `③ pdk 注入行清零后 GET records.byGame.paodekuai.${field} 回到基线 ${expected}`,
      );
    }
    checks.eq(
      resultC.byGame.doudizhu.orphanOps - baseline.lastResult!.byGame.doudizhu.orphanOps,
      EXPECTED_DELTA.doudizhu.orphanOps ?? 0,
      '③ 轮 C ddz orphan 增量不变（pdk 清零不影响 ddz）',
    );
    checks.eq(
      resultC.byGame.doudizhu.missingOps - baseline.lastResult!.byGame.doudizhu.missingOps,
      EXPECTED_DELTA.doudizhu.missingOps ?? 0,
      '③ 轮 C ddz missing 增量不变（sentinel 第 2 页仍被消费）',
    );

    info(`slice-35 TAG=${TAG}；注入行将在收尾删除（前序切片的真实数据保留）`);
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      cleanupInjected();
      // 还原原档位（缺失 ⇒ 空表；种子恒有 `game.levels.doudizhu`，此处只兜底）。
      const restoreVersion = await putLevels(admin, Array.isArray(originalLevels) ? originalLevels : []);
      await waitSnapshotApplied(restoreVersion);
      info('slice-35 注入行已删除、档位表已还原');
    } catch (restoreErr) {
      if (primaryError === null) throw restoreErr;
      info(`slice-35 收尾失败（保留原始错误）：${String(restoreErr)}`);
    }
  }
  return { passed: checks.passed };
}
