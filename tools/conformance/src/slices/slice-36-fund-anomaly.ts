/**
 * slice-36：C3 资金异常检测（真栈）。
 *
 * ─── 判据载体 ───────────────────────────────────────────────────────────────
 *  - 用户：**registerUser 真注册**（8 条 C3 SQL 全部 `JOIN users … status='active'`；
 *    假 id 会被整体过滤 ⇒ 权威轮必红）。
 *  - 注入（`mysqlExec`，RUN_TAG 前缀；逐列写全 NOT NULL）：
 *    - uA/uB：10 条 PDK 2 人金币记录（uA 全胜、money_delta ±150）+ 共享 device（NOW）
 *      + 3 条同桌 DDZ 记录 ⇒ sameDevice(ddz/pdk) + pairWinRate + pairFrequency；
 *    - uD/uE：10 条 PDK 2 人记录全部 >26h（<7d）⇒ 只 pairWinRate、不 pairFrequency；
 *    - uC：20 条 DDZ 金币胜局 + 20 条 settle op（burned_rake=300）⇒ highRake=6000；
 *    - 负例（各自独立用户）：uF/uG 4 局对子、uH 19 局金币、uJ/uK 陈旧设备（8 个月前）、
 *      uL/uM 7d 外记录；uI 仅 4 台设备 ⇒ 既有 devices 命中（证明 hit_users 只算 C3）。
 *  - 触发：`PUT risk.scanIntervalMs=5000` → `docker restart ftl-user-service` → 健康 →
 *    轮询 `GET /api/admin/risk/reviews?limit=100`（≤180s）。
 *  - 断言：正例 score=25 / gameType / 精确 reason 集与字段；负例无条目；9001 gauges
 *    （hit_users≥5、四 check 的 hits_total、last_success>0、round_failures 全 0、runs≥1）；
 *    注入行数前后不变（零写）。
 *  - 清理：删注入行（ops/记录/players/devices）、dismiss 条目、还原 7 个配置键。
 *
 * ⚠️ 本机 Docker 不可用 ⇒ 本片只做 tsc；真栈执行登记「待权威轮」。
 * ⚠️ 当前种子下 PDK 2 人场/金币场关闭且 rake=0；本片**直插记录/ops**（不经开关），
 *    只证明检测链本身，不改变开关（父 spec 红线）。
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
  postJson,
  registerUser,
  type HarnessUser,
} from '../lib/http';
import { mysqlExec, mysqlNum } from '../lib/mysql';
import { execCurl, parseProm, seriesValueExact, sumMetric } from '../lib/prom-text';

const REPO_ROOT = resolve(__dirname, '../../../..');
const TAG = Date.now().toString(36).toUpperCase().slice(-5);
const ROOM = (suffix: string): string => `S36${TAG}${suffix}`;
const DEVICE = (suffix: string): string => `S36${TAG}dev${suffix}`;
const ACTION = (suffix: string): string => `s36${TAG}:${suffix}`;
const USER_SERVICE = { container: 'ftl-user-service', port: 9001 } as const;

const RISK_SCAN = 'risk.scanIntervalMs';
const RISK_DEVICE_LIMIT = 'risk.deviceLimit';
const RISK_DEVICE_WINDOW = 'risk.deviceWindowDays';
const DDZ_MIN = 'game.doudizhu.risk.minGames';
const DDZ_WIN = 'game.doudizhu.risk.winRateThreshold';
const PDK2_MIN = 'game.paodekuai.risk.player2.minGames';
const PDK2_WIN = 'game.paodekuai.risk.player2.winRateThreshold';
const CONFIG_KEYS = [
  RISK_SCAN,
  RISK_DEVICE_LIMIT,
  RISK_DEVICE_WINDOW,
  DDZ_MIN,
  DDZ_WIN,
  PDK2_MIN,
  PDK2_WIN,
] as const;

const HOUR = 3_600;
const DAY = 86_400;

interface ConfigEntry {
  value: unknown;
  version: number;
}

interface ReviewItem {
  id: number;
  userId: string;
  score: number;
  status: string;
  gameType: string;
  reasons: Array<{ check: string; detail: Record<string, unknown> }>;
}

interface InjectedCounts {
  ddzRecords: number;
  ddzPlayers: number;
  pdkRecords: number;
  pdkPlayers: number;
  ops: number;
  devices: number;
}

const secAgo = (seconds: number): string => `DATE_SUB(NOW(3), INTERVAL ${seconds} SECOND)`;
const msAgo = (seconds: number): string => `(UNIX_TIMESTAMP(NOW(3)) - ${seconds}) * 1000`;
const num = (value: number | null): string => (value === null ? 'NULL' : String(value));

/* ── 进程/HTTP 助手 ────────────────────────────────────────────────────── */

function shell(cmd: string[]): { status: number; out: string } {
  const r = spawnSync('docker', cmd, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function restartUserService(): Promise<void> {
  const r = shell(['restart', USER_SERVICE.container]);
  if (r.status !== 0) {
    throw new ConformanceError(`重启 ${USER_SERVICE.container} 失败：${r.out.slice(-300)}`);
  }
  const deadline = Date.now() + 90_000;
  for (;;) {
    const h = shell(['inspect', USER_SERVICE.container, '--format', '{{.State.Health.Status}}']);
    const status = h.out.trim();
    if (status === 'healthy') return;
    if (Date.now() >= deadline) {
      throw new ConformanceError(`${USER_SERVICE.container} 90s 内未 healthy：${status}`);
    }
    await sleep(1000);
  }
}

async function pollUntil<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

async function latestReview(admin: string, userId: string): Promise<ReviewItem | null> {
  const res = await getJson<{ items: ReviewItem[] }>('/api/admin/risk/reviews?limit=100', admin);
  const items = Array.isArray(res.body?.data?.items) ? res.body.data.items : [];
  return items.find((item) => item.userId === userId) ?? null;
}

async function cleanupReview(admin: string, item: ReviewItem | null): Promise<void> {
  if (item === null) return;
  const current = (await latestReview(admin, item.userId)) ?? item;
  if (current.status === 'throttled') {
    await postJson(
      '/api/admin/risk/actions',
      {
        userId: current.userId,
        action: 'unthrottle',
        reviewId: current.id,
        reason: 'slice-36 cleanup',
      },
      admin,
    );
  }
  if (current.status !== 'dismissed') {
    await postJson(
      '/api/admin/risk/actions',
      { userId: current.userId, action: 'dismiss', reviewId: current.id, reason: 'slice-36 cleanup' },
      admin,
    );
  }
}

/* ── 注入/清理（直连 MySQL；逐列写全 NOT NULL）──────────────────────────── */

interface DdzSeat {
  userId: string | null;
  won: boolean;
  moneyDelta: number | null;
  robotId?: string;
}

/** DDZ 记录（3 座；landlord = seat 0）。 */
function insertDdzRecord(
  room: string,
  secondsAgo: number,
  mode: 'gold' | 'random',
  seats: [DdzSeat, DdzSeat, DdzSeat],
): void {
  const roles = ['landlord', 'farmer', 'farmer'] as const;
  const playerValues = seats.map((seat, index) => {
    const isRobot = seat.userId === null ? 1 : 0;
    return (
      `SELECT id, ${index}, ${seat.userId === null ? 'NULL' : `'${seat.userId}'`}, ${isRobot}, ` +
      `${seat.robotId === undefined ? 'NULL' : `'${seat.robotId}'`}, NULL, '${roles[index]!}', ` +
      `${seat.won ? 15 : -15}, ${seat.won ? 1 : 0}, REPEAT('0',34), ${num(seat.moneyDelta)}, ${secAgo(secondsAgo)} ` +
      `FROM game_records WHERE room_code = '${room}'`
    );
  });
  mysqlExec(
    `INSERT INTO game_records (room_code, game_version, mode, base_score, winner, landlord_seat, multiplier, spring, ` +
      `landlord_score_change, farmer_score_change, bottom_cards, started_at, ended_at, created_at) ` +
      `VALUES ('${room}', 1, '${mode}', 15, 'landlord', 0, 1, 'none', 0, 0, '000000', ` +
      `${secAgo(secondsAgo + 60)}, ${secAgo(secondsAgo)}, NOW(3));` +
      playerValues
        .map(
          (selectSql) =>
            `INSERT INTO game_record_players (record_id, seat, user_id, is_robot, robot_id, nickname, role, score_change, won, hand, money_delta, ended_at) ${selectSql};`,
        )
        .join(''),
  );
}

/** PDK 2 人记录（金币局；money_delta 逐座回填）。 */
function insertPdk2Record(
  room: string,
  secondsAgo: number,
  mode: 'gold' | 'random',
  userA: string,
  userB: string,
  winnerSeat: 0 | 1,
  moneyA: number,
  moneyB: number,
): void {
  const player = (seat: 0 | 1, userId: string, money: number): string =>
    `SELECT id, ${seat}, '${userId}', 0, NULL, NULL, REPEAT('0',32), 0, ` +
    `${seat === winnerSeat ? 15 : -15}, ${seat === winnerSeat ? 1 : 0}, ${money}, ${msAgo(secondsAgo)} ` +
    `FROM game_records_pdk WHERE room_code = '${room}'`;
  mysqlExec(
    `INSERT INTO game_records_pdk (room_code, game_version, mode, player_count, base_score, winner_seat, remaining, ` +
      `multiplier, bomb_count, guan, spring, baoben_seats, score_changes, unused_cards, started_at, ended_at) ` +
      `VALUES ('${room}', 1, '${mode}', 2, 15, ${winnerSeat}, '[0,8]', 1, 0, 0, 0, '[]', '[]', NULL, ` +
      `${msAgo(secondsAgo + 60)}, ${msAgo(secondsAgo)});` +
      `INSERT INTO game_record_players_pdk (record_id, seat, user_id, is_robot, robot_id, nickname, hand, played_count, score_change, won, money_delta, ended_at) ${player(0, userA, moneyA)};` +
      `INSERT INTO game_record_players_pdk (record_id, seat, user_id, is_robot, robot_id, nickname, hand, played_count, score_change, won, money_delta, ended_at) ${player(1, userB, moneyB)};`,
  );
}

/** settle op（仅抽水列；highRake 只读 ops，不读 flows）。 */
function insertSettleRake(
  room: string,
  gameType: 'doudizhu' | 'paodekuai',
  secondsAgo: number,
  rake: number,
): void {
  mysqlExec(
    `INSERT INTO currency_ops (action_id, request_hash, source, game_type, ref_id, burned_residue, burned_rake, created_at) ` +
      `VALUES ('${ACTION(`rake:${room}`)}', REPEAT('a',64), 'game_settle', '${gameType}', '${room}:1', 0, ${rake}, ${secAgo(secondsAgo)});`,
  );
}

function insertDevice(userId: string, deviceId: string, lastSeenSecondsAgo: number): void {
  mysqlExec(
    `INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) ` +
      `VALUES ('${userId}', '${deviceId}', ${secAgo(lastSeenSecondsAgo)}, ${secAgo(lastSeenSecondsAgo)}) ` +
      `ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at);`,
  );
}

function countInjected(): InjectedCounts {
  return {
    ddzRecords: mysqlNum(`SELECT COUNT(*) FROM game_records WHERE room_code LIKE 'S36${TAG}%'`),
    ddzPlayers: mysqlNum(
      `SELECT COUNT(*) FROM game_record_players p JOIN game_records r ON p.record_id = r.id WHERE r.room_code LIKE 'S36${TAG}%'`,
    ),
    pdkRecords: mysqlNum(`SELECT COUNT(*) FROM game_records_pdk WHERE room_code LIKE 'S36${TAG}%'`),
    pdkPlayers: mysqlNum(
      `SELECT COUNT(*) FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id WHERE r.room_code LIKE 'S36${TAG}%'`,
    ),
    ops: mysqlNum(`SELECT COUNT(*) FROM currency_ops WHERE action_id LIKE 's36${TAG}:%'`),
    devices: mysqlNum(`SELECT COUNT(*) FROM user_devices WHERE device_id LIKE 'S36${TAG}%'`),
  };
}

function cleanupInjected(): void {
  mysqlExec(
    `DELETE FROM currency_ops WHERE action_id LIKE 's36${TAG}:%';` +
      `DELETE p FROM game_record_players p JOIN game_records r ON p.record_id = r.id WHERE r.room_code LIKE 'S36${TAG}%';` +
      `DELETE FROM game_records WHERE room_code LIKE 'S36${TAG}%';` +
      `DELETE p FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id WHERE r.room_code LIKE 'S36${TAG}%';` +
      `DELETE FROM game_records_pdk WHERE room_code LIKE 'S36${TAG}%';` +
      `DELETE FROM user_devices WHERE device_id LIKE 'S36${TAG}%';`,
  );
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

export async function runSlice36(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const original = new Map<string, unknown>();
  let admin = '';
  let primaryError: unknown = null;
  const createdReviews: ReviewItem[] = [];

  const reviewOf = (item: ReviewItem, check: string) =>
    item.reasons.find((reason) => reason.check === check);

  try {
    // 前序切片（尤其 slice-33/35 的注册与轮询）可能刚打满网关 IP 桶（120/min 滑动窗）。
    info('slice-36 起手静置 61s（清网关 IP 桶窗口）');
    await sleep(61_000);
    admin = await adminLogin();

    step('⓪ 配置基线（7 键）：压高胜率门槛、设备阈值 3/窗口 30d、扫描 5s');
    cleanupInjected();
    const cfg = await adminGetConfig<{ config: Record<string, ConfigEntry>; version: number }>(
      admin,
    );
    if (cfg.body?.code !== ErrCode.OK || cfg.body.data === undefined) {
      throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${cfg.status}`);
    }
    for (const key of CONFIG_KEYS) original.set(key, cfg.body.data.config[key]?.value);
    const put = async (key: string, value: unknown): Promise<void> => {
      const res = await adminPutConfig(key, value, admin);
      if (res.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`PUT ${key} 失败 HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
    };
    await put(DDZ_MIN, 200);
    await put(DDZ_WIN, 0.9);
    await put(PDK2_MIN, 200);
    await put(PDK2_WIN, 0.9);
    await put(RISK_DEVICE_LIMIT, 3);
    await put(RISK_DEVICE_WINDOW, 30);
    await put(RISK_SCAN, 5000);

    step('① 注册真用户（13 个）：检测链的 users JOIN 承重');
    const pool = await Promise.all(
      Array.from({ length: 13 }, (_, index) => registerUser(360 + index)),
    );
    const [uA, uB, uC, uD, uE, uF, uG, uH, uI, uJ, uK, uL, uM] = pool as [
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
      HarnessUser,
    ];
    checks.eq(new Set(pool.map((user) => user.id)).size, 13, '① 13 个真用户 id 互异');

    step('② 注入：四信号正例 + 六类负例（记录/设备/ops 直连 MySQL）');
    insertDevice(uA.id, DEVICE('1'), 0);
    insertDevice(uB.id, DEVICE('1'), 0);
    // 同设备正例：3 条同桌 DDZ（第三座机器人）
    for (let i = 0; i < 3; i += 1) {
      insertDdzRecord(ROOM(`D${i}`), HOUR + i * 60, 'random', [
        { userId: uA.id, won: true, moneyDelta: 0 },
        { userId: uB.id, won: false, moneyDelta: 0 },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-${i}` },
      ]);
    }
    // 对子正例：10 条 PDK 2 人金币局（uA 全胜；最近 10h 内）
    for (let i = 0; i < 10; i += 1) {
      insertPdk2Record(ROOM(`P${i}`), HOUR + i * 60, 'gold', uA.id, uB.id, 0, 150, -150);
    }
    // 只命中 pairWinRate（全部 >26h、<7d）
    for (let i = 0; i < 10; i += 1) {
      insertPdk2Record(ROOM(`O${i}`), 30 * HOUR + i * 60, 'gold', uD.id, uE.id, 0, 150, -150);
    }
    // 负例：4 局对子（<5）
    for (let i = 0; i < 4; i += 1) {
      insertPdk2Record(ROOM(`N${i}`), HOUR + i * 60, 'gold', uF.id, uG.id, 0, 150, -150);
    }
    // 高抽水正例：20 局金币胜局 + 20 条 op（rake=300 ⇒ 6000）
    for (let i = 0; i < 20; i += 1) {
      insertDdzRecord(ROOM(`R${i}`), HOUR + i * 600, 'gold', [
        { userId: uC.id, won: true, moneyDelta: 0 },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-r${i}a` },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-r${i}b` },
      ]);
      insertSettleRake(ROOM(`R${i}`), 'doudizhu', HOUR + i * 600, 300);
    }
    // 负例：19 局金币 + 5700（<20 局）
    for (let i = 0; i < 19; i += 1) {
      insertDdzRecord(ROOM(`H${i}`), HOUR + i * 600, 'gold', [
        { userId: uH.id, won: true, moneyDelta: 0 },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-h${i}a` },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-h${i}b` },
      ]);
      insertSettleRake(ROOM(`H${i}`), 'doudizhu', HOUR + i * 600, 300);
    }
    // 负例：陈旧设备（8 个月前）→ last_seen 窗过滤
    insertDevice(uJ.id, DEVICE('2'), 240 * DAY);
    insertDevice(uK.id, DEVICE('2'), 240 * DAY);
    for (let i = 0; i < 3; i += 1) {
      insertDdzRecord(ROOM(`J${i}`), HOUR + i * 60, 'random', [
        { userId: uJ.id, won: true, moneyDelta: 0 },
        { userId: uK.id, won: false, moneyDelta: 0 },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-j${i}` },
      ]);
    }
    // 负例：7d 外记录（8 天前）+ 近期共享设备（记录窗过滤）
    insertDevice(uL.id, DEVICE('3'), 0);
    insertDevice(uM.id, DEVICE('3'), 0);
    for (let i = 0; i < 3; i += 1) {
      insertDdzRecord(ROOM(`L${i}`), 8 * DAY + i * 60, 'random', [
        { userId: uL.id, won: true, moneyDelta: 0 },
        { userId: uM.id, won: false, moneyDelta: 0 },
        { userId: null, won: false, moneyDelta: null, robotId: `bot-s36-${TAG}-l${i}` },
      ]);
    }
    // 仅既有 devices 信号（4 台 > 3）：证明 hit_users 只算 C3
    for (let i = 0; i < 4; i += 1) insertDevice(uI.id, DEVICE(`i${i}`), 0);

    const countsBefore = countInjected();
    checks.eq(countsBefore.ddzRecords, 48, '② DDZ 注入 48 条（3+20+19+3+3）');
    checks.eq(countsBefore.pdkRecords, 24, '② PDK 注入 24 条（10+10+4）');
    checks.eq(countsBefore.ops, 39, '② settle op 注入 39 条（20+19）');
    checks.eq(countsBefore.devices, 10, '② 设备注入 10 条（2+2+2+4）');

    step('③ 触发：重启 user-service ⇒ 启动 30s 首跑（扫描 5s 后续轮）');
    await restartUserService();

    const waitReview = async (user: HarnessUser, label: string): Promise<ReviewItem> => {
      const polled = await pollUntil(
        () => latestReview(admin, user.id),
        (item) => item !== null && Array.isArray(item.reasons) && item.reasons.length > 0,
        180_000,
        2000,
      );
      if (!polled.ok || polled.last === null) {
        throw new ConformanceError(`③ ${label} 180s 内未进入审核队列`);
      }
      createdReviews.push(polled.last);
      return polled.last;
    };

    step('④ 四信号正例：uA/uB（同设备+对子）、uC（高抽水）、uD/uE（仅胜率）、uI（仅设备）');
    const a = await waitReview(uA, 'uA');
    checks.eq(a.score, 25, '④ uA score=25（四信号合并为一项）');
    checks.eq(a.gameType, 'mixed', '④ uA gameType=mixed（ddz+pdk 同设备 + pdk 对子）');
    const aSameDdz = a.reasons.find(
      (reason) => reason.check === 'sameDevice' && reason.detail.gameType === 'doudizhu',
    );
    const aSamePdk = a.reasons.find(
      (reason) => reason.check === 'sameDevice' && reason.detail.gameType === 'paodekuai',
    );
    const aRate = reviewOf(a, 'pairWinRate');
    const aFreq = reviewOf(a, 'pairFrequency');
    checks.eq(aSameDdz?.detail.games, 3, '④ uA sameDevice(ddz) games=3');
    checks.eq(aSameDdz?.detail.pairUserId, uB.id, '④ uA sameDevice(ddz) pairUserId=uB');
    checks.eq(aSamePdk?.detail.games, 10, '④ uA sameDevice(pdk) games=10');
    checks.eq(aRate?.detail.games, 10, '④ uA pairWinRate games=10');
    checks.eq(aRate?.detail.wins, 10, '④ uA pairWinRate wins=10');
    checks.eq(aRate?.detail.winRate, 1, '④ uA pairWinRate winRate=1');
    checks.eq(aRate?.detail.netWin, 1500, '④ uA pairWinRate netWin=1500');
    checks.eq(aRate?.detail.dominantUserId, uA.id, '④ uA pairWinRate dominantUserId=uA');
    checks.eq(aRate?.detail.gameType, 'paodekuai', '④ uA pairWinRate gameType=paodekuai');
    checks.eq(aFreq?.detail.games, 10, '④ uA pairFrequency games=10');
    checks.eq(aFreq?.detail.windowHours, 26, '④ uA pairFrequency windowHours=26');

    const b = await waitReview(uB, 'uB');
    checks.eq(b.score, 25, '④ uB score=25（对子两侧都记）');
    checks.eq(
      reviewOf(b, 'pairWinRate')?.detail.dominantUserId,
      uA.id,
      '④ uB pairWinRate 仍指向胜方 uA（送钱方也入队）',
    );

    const c = await waitReview(uC, 'uC');
    checks.eq(c.score, 25, '④ uC score=25');
    checks.eq(c.gameType, 'doudizhu', '④ uC gameType=doudizhu');
    const cRake = reviewOf(c, 'highRake');
    checks.eq(cRake?.detail.games, 20, '④ uC highRake games=20');
    checks.eq(cRake?.detail.rakeUpperBound, 6000, '④ uC highRake rakeUpperBound=6000');
    checks.eq(cRake?.detail.windowHours, 26, '④ uC highRake windowHours=26');
    checks.that(reviewOf(c, 'pairWinRate') === undefined, '④ uC 无对子 reason');

    const d = await waitReview(uD, 'uD');
    checks.eq(d.score, 25, '④ uD score=25');
    checks.eq(d.gameType, 'paodekuai', '④ uD gameType=paodekuai');
    checks.that(reviewOf(d, 'pairWinRate') !== undefined, '④ uD 有 pairWinRate（7d 窗）');
    checks.that(reviewOf(d, 'pairFrequency') === undefined, '④ uD 无 pairFrequency（全在 26h 外）');

    const e = await waitReview(uE, 'uE');
    checks.that(reviewOf(e, 'pairWinRate') !== undefined, '④ uE 有 pairWinRate（对子另一侧）');

    const iReview = await waitReview(uI, 'uI');
    checks.eq(iReview.score, 25, '④ uI score=25（既有 devices 信号）');
    checks.eq(iReview.gameType, 'platform', '④ uI gameType=platform');
    checks.eq(iReview.reasons.length, 1, '④ uI 只有 devices reason（无 C3 reason）');
    checks.eq(iReview.reasons[0]?.check, 'devices', '④ uI reason check=devices');

    step('⑤ 负例：4 局对子 / 19 局金币 / 陈旧设备 / 7d 外 ⇒ 均无条目');
    for (const [label, user] of [
      ['uF', uF],
      ['uG', uG],
      ['uH', uH],
      ['uJ', uJ],
      ['uK', uK],
      ['uL', uL],
      ['uM', uM],
    ] as const) {
      checks.that(
        (await latestReview(admin, user.id)) === null,
        `⑤ ${label} 未进入审核队列（阈值/窗口/陈旧设备过滤）`,
      );
    }

    step('⑥ 9001 gauges：hit_users 只算 C3、四 check 命中、last_success、零失败');
    const metrics = execCurl(USER_SERVICE.container, USER_SERVICE.port, INTERNAL_TOKEN);
    checks.eq(metrics.status, 200, '⑥ user-service /metrics HTTP 200');
    const hitUsers = seriesValueExact(metrics.body, 'risk_fund_scan_hit_users', {}) ?? 0;
    checks.that(hitUsers >= 5, `⑥ hit_users ≥5（实际 ${hitUsers}；uI 仅 devices 不计入）`);
    const sumByCheck = (check: string): number =>
      parseProm(metrics.body)
        .filter((sample) => sample.name === 'risk_fund_scan_hits_total' && sample.labels.check === check)
        .reduce((acc, sample) => acc + (Number.isFinite(sample.value) ? sample.value : 0), 0);
    checks.that(sumByCheck('sameDevice') >= 2, '⑥ hits_total{sameDevice} ≥2（uA/uB）');
    checks.that(sumByCheck('pairWinRate') >= 4, '⑥ hits_total{pairWinRate} ≥4（uA/uB/uD/uE）');
    checks.that(sumByCheck('pairFrequency') >= 2, '⑥ hits_total{pairFrequency} ≥2（uA/uB）');
    checks.that(sumByCheck('highRake') >= 1, '⑥ hits_total{highRake} ≥1（uC）');
    const lastSuccess =
      seriesValueExact(metrics.body, 'risk_fund_scan_last_success_timestamp_seconds', {}) ?? 0;
    checks.that(lastSuccess > 0, `⑥ last_success >0（实际 ${lastSuccess}）`);
    checks.that(sumMetric(metrics.body, 'risk_fund_scan_runs_total') >= 1, '⑥ runs_total ≥1');
    for (const scope of ['doudizhu', 'paodekuai', 'ops']) {
      for (const reason of ['sql', 'truncated']) {
        checks.eq(
          seriesValueExact(metrics.body, 'risk_fund_scan_round_failures', { scope, reason }) ?? 0,
          0,
          `⑥ round_failures{${scope},${reason}}=0`,
        );
      }
    }

    step('⑦ 零写：扫描不改注入的记录/op/设备行');
    const countsAfter = countInjected();
    checks.eq(JSON.stringify(countsAfter), JSON.stringify(countsBefore), '⑦ 注入行数前后一致');

    step('⑧ 清理：删注入行 + dismiss 条目 + 还原 7 键');
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      cleanupInjected();
      if (admin !== '') {
        for (const item of createdReviews) {
          try {
            await cleanupReview(admin, item);
          } catch (err) {
            info(`slice-36 清理条目失败（userId=${item.userId}）：${String(err)}`);
          }
        }
        for (const key of CONFIG_KEYS) {
          const value = original.get(key);
          if (value !== undefined) {
            const res = await adminPutConfig(key, value, admin);
            if (res.body?.code !== ErrCode.OK) {
              info(`slice-36 还原 ${key} 失败：HTTP ${res.status}`);
            }
          }
        }
      }
    } catch (restoreErr) {
      if (primaryError === null) throw restoreErr;
      info(`slice-36 还原失败（保留原始错误）：${String(restoreErr)}`);
    }
  }
  return { passed: checks.passed };
}
