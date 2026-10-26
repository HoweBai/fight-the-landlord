/**
 * slice-33：B 组 PDK 金币场 + 风控 2/3/4 人真栈。
 *
 * 覆盖：
 *  ⓪ 配置开启/还原（PDK enabled/2/4/gold、台费 10%、rake 10%、entryMultiplier 10、
 *     baoben 关、2/3/4 风控阈值 0.5/1、DDZ 阈值 0.5/1、PDK 自动限流 25、扫描 5s）
 *  ① 14003：PDK 2/4 人金币场 0 余额 ⇒ 14003；补足 150 ⇒ 入队
 *  ② PDK gold 2 人真局：deal 后全员降到 1 ⇒ 输家 -1、赢家 +1、无负余额
 *  ③ PDK gold 4 人真局：三个输家 -1、赢家 +3、无负余额
 *  ④ 风控：每个 2/3/4 桶 2 条纯人类胜局 + 1 条机器人局（断言 games=2）；
 *     mixed 用户 2 条 DDZ + 2 条 PDK；reasons/playerCount/byPlayerCount/gameType 筛选/
 *     autoThrottleScore=25 的自动限流 + risk:limit 旗
 *  ⑤ 收尾：unthrottle/dismiss、还原配置、清队列
 *
 * ⚠️ 本机无 Docker 时只做 tsc；真栈执行登记“待权威轮”。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  encodeCards,
  encodeHand,
  type Card,
  type DdzSettlementResult,
  type PdkSettlementResult,
  type RecordWriteRequest,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type HarnessUser,
} from '../lib/http';
import { HarnessClient } from '../lib/client';
import { playPdkToEnd, startPdkRoom, type PdkRoom } from '../lib/pdk-driver';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisRaw, redisReplyText } from '../lib/redis';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-5);
const USER_SERVICE_CONTAINER = 'ftl-user-service';
const USER_RPC: RpcEndpoint = {
  host: process.env.USER_RPC_HOST ?? 'localhost',
  port: Number(process.env.USER_RPC_PORT ?? 3101),
};

const PDK_ENABLED = 'game.paodekuai.enabled';
const PDK_TWO = 'game.paodekuai.twoPlayerEnabled';
const PDK_NONTHREE = 'game.paodekuai.nonThreePlayerEnabled';
const PDK_GOLD = 'game.paodekuai.goldRoomEnabled';
const PDK_FRIEND = 'game.paodekuai.friendRoomEnabled';
const PDK_LEVELS = 'game.levels.paodekuai';
const PDK_RAKE = 'game.paodekuai.rakePercent';
const PDK_ENTRY = 'game.paodekuai.entryMultiplier';
const PDK_BAOBEN = 'game.paodekuai.baobenEnabled';
const PDK_P2_WIN = 'game.paodekuai.risk.player2.winRateThreshold';
const PDK_P2_MIN = 'game.paodekuai.risk.player2.minGames';
const PDK_P3_WIN = 'game.paodekuai.risk.player3.winRateThreshold';
const PDK_P3_MIN = 'game.paodekuai.risk.player3.minGames';
const PDK_P4_WIN = 'game.paodekuai.risk.player4.winRateThreshold';
const PDK_P4_MIN = 'game.paodekuai.risk.player4.minGames';
const PDK_AUTO = 'game.paodekuai.risk.autoThrottleScore';
const RISK_AUTO = 'risk.autoThrottle';
const RISK_SCAN = 'risk.scanIntervalMs';
const DDZ_WIN = 'game.doudizhu.risk.winRateThreshold';
const DDZ_MIN = 'game.doudizhu.risk.minGames';

const BASE_SCORE = 15;
const ENTRY_FEE_PERCENT = 10;
const PRE_CHARGE = 1_000_000;
const LEVELS = [
  { name: '休闲场', baseScore: 15, entryFeePercent: ENTRY_FEE_PERCENT },
  { name: '标准场', baseScore: 80, entryFeePercent: ENTRY_FEE_PERCENT },
  { name: '竞技场', baseScore: 480, entryFeePercent: ENTRY_FEE_PERCENT },
  { name: '豪侠场', baseScore: 1200, entryFeePercent: ENTRY_FEE_PERCENT },
];

interface ConfigEntry {
  value: unknown;
  version: number;
}

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
  const r = shell(['restart', USER_SERVICE_CONTAINER]);
  if (r.status !== 0) {
    throw new ConformanceError(`重启 ${USER_SERVICE_CONTAINER} 失败：${r.out.slice(-300)}`);
  }
  const deadline = Date.now() + 90_000;
  for (;;) {
    const h = shell(['inspect', USER_SERVICE_CONTAINER, '--format', '{{.State.Health.Status}}']);
    const status = h.out.trim();
    if (status === 'healthy') return;
    if (Date.now() >= deadline) {
      throw new ConformanceError(`${USER_SERVICE_CONTAINER} 90s 内未 healthy：${status}`);
    }
    await sleep(1000);
  }
}

async function pollUntil<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

function scanRedisKeys(pattern: string): string[] {
  const reply = redisRaw(['--scan', '--pattern', pattern]);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli --scan 失败：${redisReplyText(reply)}`);
  }
  return reply.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function purgeGoldQueues(): void {
  for (const key of scanRedisKeys('match:queue:gold:*')) redisRaw(['DEL', key]);
  for (const key of scanRedisKeys('match:meta:*')) {
    if ((redisRaw(['HGET', key, 'mode']).stdout || '').trim() === 'gold') redisRaw(['DEL', key]);
  }
}

async function adminConfig(
  admin: string,
): Promise<{ config: Record<string, ConfigEntry>; version: number }> {
  const res = await adminGetConfig<{ config: Record<string, ConfigEntry>; version: number }>(admin);
  if (res.body?.code !== ErrCode.OK || res.body.data === undefined) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status}`);
  }
  return res.body.data;
}

async function put(admin: string, key: string, value: unknown, why: string): Promise<void> {
  const res = await adminPutConfig(key, value, admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${why}：PUT ${key} 失败 HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function precharge(admin: string, user: HarnessUser): Promise<void> {
  await adjustTo(admin, user.id, PRE_CHARGE, 'precharge');
}

async function walletBalance(admin: string, userId: string): Promise<number> {
  const res = await getJson<{ balance: number }>(
    `/api/admin/wallet/accounts/${encodeURIComponent(userId)}`,
    admin,
  );
  return Number(res.body?.data?.balance ?? 0);
}

async function adjustTo(
  admin: string,
  userId: string,
  target: number,
  why: string,
): Promise<number> {
  const balance = await walletBalance(admin, userId);
  const delta = target - balance;
  if (delta === 0) return balance;
  const res = await postJson(
    '/api/admin/wallet/adjust',
    {
      userId,
      delta,
      reason: `slice32 ${RUN_TAG} ${why}`,
      actionId: `s32:${RUN_TAG}:${why}:${userId}:${target}:${balance}`,
    },
    admin,
  );
  if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${why} 调整失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return Number((res.body.data as { balanceAfter?: number } | undefined)?.balanceAfter ?? target);
}

async function matchOnce(
  label: string,
  user: HarnessUser,
  payload: Record<string, unknown>,
  unmatch: boolean,
): Promise<{ code: number; message?: string }> {
  const client = await HarnessClient.connect(`${label}-${RUN_TAG}`, user);
  try {
    const ack = await client.send('room.match', payload);
    if (unmatch && ack.code === ErrCode.OK) await client.send('room.unmatch', {});
    return ack;
  } finally {
    client.close();
  }
}

function sampleCards(offset: number, count: number): Card[] {
  const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
  const pool: Card[] = [];
  for (const r of ranks) for (let s = 0; s < 5; s += 1) pool.push({ r, s });
  const out: Card[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[(offset + i) % pool.length]!);
  return out;
}

interface CraftSeat {
  userId: string | null;
  isRobot: boolean;
  robotId: string | null;
}

/**
 * 参数化 PDK 记录：2/3 人 16 张（32 hex）、4 人 12 张（24 hex）；
 * `remaining` 由人手牌数派生 `playedCount`；roomCode 唯一。
 */
function craftPdkRecord(
  playerCount: 2 | 3 | 4,
  roomCode: string,
  seats: CraftSeat[],
  winnerSeat: number,
  endedAt: number,
): RecordWriteRequest {
  if (seats.length !== playerCount) {
    throw new Error(`craftPdkRecord: seats=${seats.length} ≠ playerCount=${playerCount}`);
  }
  const initialHand = playerCount === 4 ? 12 : 16;
  const remaining = Array.from({ length: playerCount }, (_, seat) =>
    seat === winnerSeat ? 0 : 4 + (seat % 3),
  );
  const loserDelta = -Math.trunc(30 / (playerCount - 1));
  const result: PdkSettlementResult = {
    roomCode,
    gameType: 'paodekuai',
    playerCount,
    baseScore: BASE_SCORE,
    winnerSeats: [winnerSeat],
    scoreChanges: Array.from({ length: playerCount }, (_, seat) => ({
      seat,
      delta: seat === winnerSeat ? -loserDelta * (playerCount - 1) : loserDelta,
    })),
    remaining,
    multiplier: 1,
    bombCount: 0,
    guan: false,
    spring: false,
    baobenSeats: [],
  };
  return {
    roomCode,
    gameVersion: 1,
    mode: 'random',
    baseScore: BASE_SCORE,
    gameType: 'paodekuai',
    playerCount,
    result,
    seats: seats.map((seat, index) => ({
      seat: index,
      userId: seat.userId,
      isRobot: seat.isRobot,
      robotId: seat.robotId,
      hand: encodeHand(sampleCards(index * initialHand, initialHand), initialHand),
      playedCount: initialHand - remaining[index]!,
    })),
    startedAt: endedAt - 60_000,
    endedAt,
  };
}

function craftDdzWinningRecord(
  roomCode: string,
  userId: string,
  endedAt: number,
): RecordWriteRequest {
  const multiplier = 2;
  const result: DdzSettlementResult = {
    roomCode,
    baseScore: BASE_SCORE,
    winner: 'landlord',
    landlordSeat: 0,
    farmerSeats: [1, 2],
    multiplier,
    spring: 'none',
    landlordScoreChange: BASE_SCORE * multiplier * 2,
    farmerScoreChange: -BASE_SCORE * multiplier,
  };
  return {
    roomCode,
    gameVersion: 1,
    mode: 'random',
    baseScore: BASE_SCORE,
    result,
    seats: [
      { seat: 0, userId, isRobot: false, robotId: null, hand: encodeHand(sampleCards(0, 17), 17) },
      { seat: 1, userId: null, isRobot: true, robotId: `bot-s32-ddz-1`, hand: encodeHand(sampleCards(17, 17), 17) },
      { seat: 2, userId: null, isRobot: true, robotId: `bot-s32-ddz-2`, hand: encodeHand(sampleCards(34, 17), 17) },
    ],
    bottomCards: encodeCards(sampleCards(51, 3)),
    startedAt: endedAt - 60_000,
    endedAt,
  };
}

async function writeRecord(req: RecordWriteRequest, what: string): Promise<void> {
  const res = await rpcCall<{ written: boolean }>(
    USER_RPC,
    RPC_PATTERNS.recordWrite,
    req,
    8_000,
  );
  if (!res.ok || !res.data.written) {
    throw new ConformanceError(`${what}：record.write 失败 ${JSON.stringify(res)}`);
  }
}

function humanSeats(userIds: string[]): CraftSeat[] {
  return userIds.map((userId) => ({ userId, isRobot: false, robotId: null }));
}

function robotSeats(humanUserIds: string[], robotCount: number): CraftSeat[] {
  const seats: CraftSeat[] = humanSeats(humanUserIds);
  for (let i = 0; i < robotCount; i += 1) {
    seats.push({ userId: null, isRobot: true, robotId: `bot-s32-${RUN_TAG}-${i}` });
  }
  return seats;
}

interface ReviewItem {
  id: number;
  userId: string;
  score: number;
  status: string;
  gameType: string;
  reasons: Array<{ check: string; detail: Record<string, unknown> }>;
}

interface RiskDetail {
  stats?: {
    games?: number;
    wins?: number;
    byGame?: {
      doudizhu?: { games?: number; wins?: number };
      paodekuai?: {
        games?: number;
        wins?: number;
        byPlayerCount?: Record<string, { games?: number; wins?: number }>;
      };
    };
  };
}

async function latestReview(admin: string, userId: string): Promise<ReviewItem | null> {
  const res = await getJson<{ items: ReviewItem[] }>(
    '/api/admin/risk/reviews?limit=100',
    admin,
  );
  const items = Array.isArray(res.body?.data?.items) ? res.body.data.items : [];
  return items.find((item) => item.userId === userId) ?? null;
}

async function riskDetail(admin: string, userId: string): Promise<RiskDetail | null> {
  const res = await getJson<RiskDetail>(
    `/api/admin/risk/users/${encodeURIComponent(userId)}`,
    admin,
  );
  return res.body?.data ?? null;
}

function pdkReason(item: ReviewItem, playerCount: number) {
  return item.reasons.find(
    (reason) =>
      reason.check === 'winRate' &&
      reason.detail.gameType === 'paodekuai' &&
      reason.detail.playerCount === playerCount,
  );
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
        reason: 'slice-33 cleanup',
      },
      admin,
    );
  }
  if (current.status !== 'dismissed') {
    await postJson(
      '/api/admin/risk/actions',
      {
        userId: current.userId,
        action: 'dismiss',
        reviewId: current.id,
        reason: 'slice-33 cleanup',
      },
      admin,
    );
  }
}

export async function runSlice33(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const original = {
    values: new Map<string, unknown>(),
  };
  let admin = '';
  let primaryError: unknown = null;
  const createdUsers: HarnessUser[] = [];
  const rooms: PdkRoom[] = [];
  const targetReviews: Array<ReviewItem | null> = [];

  const remember = async (key: string): Promise<void> => {
    const cfg = await adminConfig(admin);
    original.values.set(key, cfg.config[key]?.value);
  };

  /**
   * 管理写桶按**令牌指纹** 30 次/5 分钟（`ADMIN_WRITE`）。本片 ⓪ 有 21 次配置写、
   * ①–③ 有 14 次钱包调整写，合计 35 次 —— 同一令牌必然在第 31 次撞 429。
   * ⇒ 在写段之间重新登录换新令牌（新指纹 = 新桶）。只影响测试夹具，不改变被测行为。
   */
  const rotateAdmin = async (why: string): Promise<void> => {
    try {
      // JWT 的 iat 是秒级：同一秒内重登可能拿到**同一令牌**（同指纹 = 同桶）。
      // 等过一秒再登录，确保换到新指纹。
      await sleep(1100);
      admin = await adminLogin();
      info(`slice-33 admin 令牌轮换（${why}；管理写桶 30/5min 按令牌指纹）`);
    } catch (err) {
      info(`slice-33 admin 令牌轮换失败（${why}）：${String(err)}（继续用旧令牌）`);
    }
  };

  try {
    // 前序切片（尤其 slice-32-agent 的鉴权矩阵）可能刚打满网关 IP 桶（120/min 滑动窗）；
    // 61s 静置让窗口自然过期，避免本片首批 GET 429。只影响测试节奏，不改变断言。
    info('slice-33 起手静置 61s（清网关 IP 桶窗口）');
    await sleep(61_000);
    admin = await adminLogin();
    const roomKeys = [
      PDK_ENABLED,
      PDK_TWO,
      PDK_NONTHREE,
      PDK_GOLD,
      PDK_FRIEND,
      PDK_LEVELS,
      PDK_RAKE,
      PDK_ENTRY,
      PDK_BAOBEN,
    ];
    const riskKeys = [
      PDK_P2_WIN,
      PDK_P2_MIN,
      PDK_P3_WIN,
      PDK_P3_MIN,
      PDK_P4_WIN,
      PDK_P4_MIN,
      PDK_AUTO,
      RISK_AUTO,
      RISK_SCAN,
      DDZ_WIN,
      DDZ_MIN,
    ];
    for (const key of [...roomKeys, ...riskKeys]) await remember(key);

    step('⓪ 配置：PDK 1/2/4/gold、台费/rake/门槛、baoben 关、2/3/4 风控 0.5/1、自动限流 25、扫描 5s');
    purgeGoldQueues();
    await put(admin, PDK_ENABLED, true, '⓪ pdk enabled');
    await put(admin, PDK_TWO, true, '⓪ pdk two');
    await put(admin, PDK_NONTHREE, true, '⓪ pdk nonThree');
    await put(admin, PDK_GOLD, true, '⓪ pdk gold');
    // REST `POST /api/rooms` 探测有好友房闸；本片临时开 PDK 好友房，收尾按原值还原。
    await put(admin, PDK_FRIEND, true, '⓪ pdk friend probe');
    await put(admin, PDK_LEVELS, LEVELS, '⓪ pdk levels');
    await put(admin, PDK_RAKE, 10, '⓪ pdk rake');
    await put(admin, PDK_ENTRY, 10, '⓪ pdk entry');
    await put(admin, PDK_BAOBEN, false, '⓪ pdk baoben off');
    await put(admin, PDK_P2_WIN, 0.5, '⓪ p2 win');
    await put(admin, PDK_P2_MIN, 1, '⓪ p2 min');
    await put(admin, PDK_P3_WIN, 0.5, '⓪ p3 win');
    await put(admin, PDK_P3_MIN, 1, '⓪ p3 min');
    await put(admin, PDK_P4_WIN, 0.5, '⓪ p4 win');
    await put(admin, PDK_P4_MIN, 1, '⓪ p4 min');
    await put(admin, PDK_AUTO, 25, '⓪ pdk auto throttle');
    await put(admin, RISK_AUTO, true, '⓪ risk auto');
    await put(admin, RISK_SCAN, 5000, '⓪ risk scan');
    await put(admin, DDZ_WIN, 0.5, '⓪ ddz win');
    await put(admin, DDZ_MIN, 1, '⓪ ddz min');
    await rotateAdmin('⓪ 21 次配置写后');

    const probe = await registerUser(1);
    createdUsers.push(probe);
    const enabled = await pollUntil(
      async () =>
        (
          await postJson(
            '/api/rooms',
            { mode: 'random', baseScore: BASE_SCORE, gameType: 'paodekuai', playerCount: 2 },
            probe.accessToken,
          )
        ).body?.code,
      (code) => code === ErrCode.OK,
      30_000,
      500,
    );
    checks.that(enabled.ok, `⓪ room-service 30s 内应用 PDK 开关（code=${JSON.stringify(enabled.last)}）`);

    step('① 14003：PDK gold 2/4 人 0 余额 ⇒ 14003；补 150 ⇒ 入队');
    for (const playerCount of [2, 4] as const) {
      const user = await registerUser(10 + playerCount);
      createdUsers.push(user);
      const payload = {
        mode: 'gold',
        baseScore: BASE_SCORE,
        gameType: 'paodekuai',
        playerCount,
      };
      const denied = await matchOnce(`s32-src-${playerCount}`, user, payload, false);
      checks.eq(denied.code, ErrCode.E_ENTRY_THRESHOLD, `① ${playerCount} 人 0 余额 ⇒ 14003`);
      checks.that(
        String(denied.message ?? '').includes('150'),
        `① ${playerCount} 人 14003 消息含 needed=150（实际 ${JSON.stringify(denied.message)}）`,
      );
      await adjustTo(admin, user.id, 150, 'entry');
      const allowed = await matchOnce(`s32-src-${playerCount}-ok`, user, payload, true);
      checks.eq(allowed.code, ErrCode.OK, `① ${playerCount} 人补足 150 ⇒ 入队`);
    }

    step('② PDK gold 2 人真局：deal 后全员降到 1 ⇒ 截断');
    {
      const users = [await registerUser(21), await registerUser(22)];
      createdUsers.push(...users);
      for (const user of users) await precharge(admin, user);
      const room = await startPdkRoom('s32-2', {
        mode: 'gold',
        baseScore: BASE_SCORE,
        playerCount: 2,
        users,
      });
      rooms.push(room);
      for (const client of room.clients) await adjustTo(admin, client.user.id, 1, 'drain2');
      const outcome = await playPdkToEnd(room, 'slice-33-2p');
      const balanceMsgs = await Promise.all(
        room.clients.map((client) => client.waitFor('game.balances', 15_000)),
      );
      const balances = (balanceMsgs[0]!.payload as { balances: Array<{ seat: number; balance: number }> })
        .balances;
      const winnerSeat = outcome.finishedPayload?.winnerSeats?.[0] as number | undefined;
      checks.eq(balances.length, 2, '② 2 人 game.balances 恰 2 座');
      const winner = balances.find((entry) => entry.seat === winnerSeat);
      const losers = balances.filter((entry) => entry.seat !== winnerSeat);
      checks.eq(winner?.balance, 2, '② 2 人赢家余额 2（1 + 实际池 1）');
      checks.that(losers.every((entry) => entry.balance === 0), '② 2 人输家余额 0（截断到 1 后支付）');
      const winnerClient = typeof winnerSeat === 'number' ? room.bySeat.get(winnerSeat) : undefined;
      checks.that(winnerClient !== undefined, '② 2 人 winnerSeat 可映射到玩家');
      if (winnerClient !== undefined) {
        const record = await pollUntil(
          async () => {
            const page = await getJson<{ items: any[] }>(
              '/api/records/mine?gameType=paodekuai',
              winnerClient.user.accessToken,
            );
            return page.body?.data?.items ?? [];
          },
          (items) => items.some((item) => item.roomCode === room.roomCode),
          30_000,
          500,
        );
        const hit = (record.last as any[]).find((item) => item.roomCode === room.roomCode);
        checks.eq(hit?.playerCount, 2, '② 2 人记录 playerCount=2');
        checks.eq(hit?.mode, 'gold', '② 2 人记录 mode=gold');
      }
      for (const client of room.clients) client.close();
    }

    step('③ PDK gold 4 人真局：deal 后全员降到 1 ⇒ 截断');
    {
      const users = await Promise.all([31, 32, 33, 34].map((n) => registerUser(n)));
      createdUsers.push(...users);
      for (const user of users) await precharge(admin, user);
      const room = await startPdkRoom('s32-4', {
        mode: 'gold',
        baseScore: BASE_SCORE,
        playerCount: 4,
        users,
      });
      rooms.push(room);
      for (const client of room.clients) await adjustTo(admin, client.user.id, 1, 'drain4');
      const outcome = await playPdkToEnd(room, 'slice-33-4p');
      const balanceMsgs = await Promise.all(
        room.clients.map((client) => client.waitFor('game.balances', 15_000)),
      );
      const balances = (balanceMsgs[0]!.payload as { balances: Array<{ seat: number; balance: number }> })
        .balances;
      const winnerSeat = outcome.finishedPayload?.winnerSeats?.[0] as number | undefined;
      checks.eq(balances.length, 4, '③ 4 人 game.balances 恰 4 座');
      const winner = balances.find((entry) => entry.seat === winnerSeat);
      const losers = balances.filter((entry) => entry.seat !== winnerSeat);
      checks.eq(winner?.balance, 4, '③ 4 人赢家余额 4（1 + 实际池 3）');
      checks.that(losers.every((entry) => entry.balance === 0), '③ 4 人三个输家余额 0');
      const winnerClient = typeof winnerSeat === 'number' ? room.bySeat.get(winnerSeat) : undefined;
      if (winnerClient !== undefined) {
        const record = await pollUntil(
          async () => {
            const page = await getJson<{ items: any[] }>(
              '/api/records/mine?gameType=paodekuai',
              winnerClient.user.accessToken,
            );
            return page.body?.data?.items ?? [];
          },
          (items) => items.some((item) => item.roomCode === room.roomCode),
          30_000,
          500,
        );
        const hit = (record.last as any[]).find((item) => item.roomCode === room.roomCode);
        checks.eq(hit?.playerCount, 4, '③ 4 人记录 playerCount=4');
        checks.eq(hit?.mode, 'gold', '③ 4 人记录 mode=gold');
      }
      for (const client of room.clients) client.close();
    }

    step('④ 风控：每桶 2 纯人类胜局 + 1 机器人局；mixed；自动限流 25');
    const pool = await Promise.all(
      Array.from({ length: 14 }, (_, i) => registerUser(40 + i)),
    );
    createdUsers.push(...pool);
    const target = (offset: number) => pool[offset]!;
    const bucketTargets: Array<{ playerCount: 2 | 3 | 4; user: HarnessUser; others: HarnessUser[] }> = [
      { playerCount: 2, user: target(0), others: [target(1)] },
      { playerCount: 3, user: target(2), others: [target(3), target(4)] },
      { playerCount: 4, user: target(5), others: [target(6), target(7), target(8)] },
    ];
    let stamp = Date.now();
    for (const bucket of bucketTargets) {
      for (let i = 0; i < 2; i += 1) {
        stamp += 1;
        await writeRecord(
          craftPdkRecord(
            bucket.playerCount,
            `S32${RUN_TAG}${bucket.playerCount}${i}`,
            humanSeats([bucket.user.id, ...bucket.others.map((u) => u.id)]),
            0,
            stamp,
          ),
          `④ ${bucket.playerCount}p human win ${i + 1}`,
        );
      }
      stamp += 1;
      await writeRecord(
        craftPdkRecord(
          bucket.playerCount,
          `S32${RUN_TAG}${bucket.playerCount}R`,
          robotSeats(
            [bucket.user.id, ...bucket.others.map((u) => u.id)].slice(
              0,
              bucket.playerCount - 1,
            ),
            1,
          ),
          0,
          stamp,
        ),
        `④ ${bucket.playerCount}p robot game`,
      );
    }
    const mixedUser = target(9);
    for (let i = 0; i < 2; i += 1) {
      stamp += 1;
      await writeRecord(
        craftDdzWinningRecord(`S32${RUN_TAG}D${i}`, mixedUser.id, stamp),
        `④ mixed ddz win ${i + 1}`,
      );
      stamp += 1;
      await writeRecord(
        craftPdkRecord(
          3,
          `S32${RUN_TAG}M${i}`,
          humanSeats([mixedUser.id, target(10)!.id, target(11)!.id]),
          0,
          stamp,
        ),
        `④ mixed pdk win ${i + 1}`,
      );
    }
    await restartUserService();

    const waitReview = async (userId: string): Promise<ReviewItem> => {
      const polled = await pollUntil(
        () => latestReview(admin, userId),
        (item) => item !== null && Array.isArray(item.reasons) && item.reasons.length > 0,
        150_000,
        1000,
      );
      if (!polled.ok || polled.last === null) {
        throw new ConformanceError(`④ ${userId} 150s 内未进入审核队列`);
      }
      return polled.last;
    };

    for (const bucket of bucketTargets) {
      const item = await waitReview(bucket.user.id);
      targetReviews.push(item);
      checks.eq(item.gameType, 'paodekuai', `④ ${bucket.playerCount}p gameType=paodekuai`);
      const reason = pdkReason(item, bucket.playerCount);
      checks.that(reason !== undefined, `④ ${bucket.playerCount}p reason 含 playerCount`);
      checks.eq(reason?.detail.games, 2, `④ ${bucket.playerCount}p games=2（机器人局已剔除）`);
      checks.eq(reason?.detail.wins, 2, `④ ${bucket.playerCount}p wins=2`);
      const detail = await riskDetail(admin, bucket.user.id);
      checks.eq(
        detail?.stats?.byGame?.paodekuai?.byPlayerCount?.[String(bucket.playerCount)]?.games,
        2,
        `④ ${bucket.playerCount}p byPlayerCount.games=2`,
      );
      checks.eq(
        detail?.stats?.byGame?.paodekuai?.byPlayerCount?.[String(bucket.playerCount)]?.wins,
        2,
        `④ ${bucket.playerCount}p byPlayerCount.wins=2`,
      );
      for (const other of [2, 3, 4].filter((n) => n !== bucket.playerCount)) {
        checks.eq(
          detail?.stats?.byGame?.paodekuai?.byPlayerCount?.[String(other)]?.games,
          0,
          `④ ${bucket.playerCount}p 其他桶 ${other} 为 0`,
        );
      }
    }

    const mixedItem = await waitReview(mixedUser.id);
    targetReviews.push(mixedItem);
    checks.eq(mixedItem.gameType, 'mixed', '④ mixed gameType=mixed');
    checks.that(
      mixedItem.reasons.some(
        (reason) => reason.check === 'winRate' && reason.detail.gameType === 'doudizhu',
      ),
      '④ mixed reasons 含 DDZ',
    );
    const mixedPdk = pdkReason(mixedItem, 3);
    checks.that(mixedPdk !== undefined, '④ mixed reasons 含 PDK 3 人');
    checks.eq(mixedPdk?.detail.games, 2, '④ mixed PDK games=2');
    const mixedDetail = await riskDetail(admin, mixedUser.id);
    checks.eq(mixedDetail?.stats?.byGame?.doudizhu?.games, 2, '④ mixed DDZ games=2');
    checks.eq(
      mixedDetail?.stats?.byGame?.paodekuai?.byPlayerCount?.['3']?.games,
      2,
      '④ mixed PDK 3 人 games=2',
    );

    const filterIds = async (gameType: string): Promise<string[]> => {
      const res = await getJson<{ items: ReviewItem[] }>(
        `/api/admin/risk/reviews?gameType=${encodeURIComponent(gameType)}&limit=100`,
        admin,
      );
      return (res.body?.data?.items ?? []).map((item) => item.userId);
    };
    const pdkIds = await filterIds('paodekuai');
    for (const bucket of bucketTargets) {
      checks.that(pdkIds.includes(bucket.user.id), `④ gameType=paodekuai 含 ${bucket.playerCount}p`);
    }
    checks.that(pdkIds.includes(mixedUser.id), '④ gameType=paodekuai 含 mixed');
    const ddzIds = await filterIds('doudizhu');
    checks.that(ddzIds.includes(mixedUser.id), '④ gameType=doudizhu 含 mixed');
    for (const bucket of bucketTargets) {
      checks.that(!ddzIds.includes(bucket.user.id), `④ gameType=doudizhu 不含纯 PDK ${bucket.playerCount}p`);
    }
    const mixedIds = await filterIds('mixed');
    checks.that(mixedIds.includes(mixedUser.id), '④ gameType=mixed 精确含 mixed');

    // autoThrottleScore=25：首轮新建 open，第二轮（5s 后）自动限流。
    const throttled = await pollUntil(
      async () => {
        const item = await latestReview(admin, bucketTargets[0]!.user.id);
        return item;
      },
      (item) => item?.status === 'throttled',
      90_000,
      1000,
    );
    checks.that(throttled.ok, '④ autoThrottleScore=25 第二轮把 PDK 25 分条目自动限流');
    if (throttled.ok && throttled.last !== null) {
      checks.eq(throttled.last.score, 25, '④ 自动限流条目 score=25');
      const flag = redisRaw(['GET', `risk:limit:${bucketTargets[0]!.user.id}`]);
      checks.that(
        (flag.stdout || '').includes('"source":"auto"'),
        `④ risk:limit 旗 source=auto（实际 ${redisReplyText(flag)}）`,
      );
    }
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      if (admin !== '') {
        await rotateAdmin('⑤ 清理/还原前');
        for (const item of targetReviews) await cleanupReview(admin, item);
        const restore = async (key: string): Promise<void> => {
          const value = original.values.get(key);
          if (value !== undefined) await put(admin, key, value, '⑤ restore');
        };
        for (const key of original.values.keys()) await restore(key);
      }
      purgeGoldQueues();
      for (const room of rooms) {
        for (const client of room.clients) client.close();
      }
      info('slice-33 配置已还原、队列/审核清理完成');
    } catch (restoreErr) {
      if (primaryError === null) throw restoreErr;
      info(`slice-33 还原失败（保留原始错误）：${String(restoreErr)}`);
    }
  }
  return { passed: checks.passed };
}
