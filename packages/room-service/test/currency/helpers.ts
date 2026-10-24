/**
 * ② 金币场 T5：三个服务级测试文件（guard / failure / outbox）的**共用夹具**。
 *
 * 抽出来的理由与 `helpers/fake-redis.ts` 同款：同一件替身写三份就是「一套接口、三套语义」
 * （本仓为第二真源付过多次代价）。这里只放**与用例无关的骨架**：
 *  - 三座房间/结果/入参的**形状真源**（`goldRoom` / `resultFixture` / `validInput`）；
 *  - `SettleService` 的组装（假 currency / 假 record / 假 robot hook + 内存 Redis +
 *    **捕获广播**的 `bindBroadcast`）；
 *  - 指标读数的差值助手（指标是进程级单例 ⇒ 一律用 before/after 差）。
 */
import { vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { CurrencyApplyData, DdzSettlementResult } from '@fight-the-landlord/protocol';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import { SettleService, type SettleInput, type SettleRobotHook } from '../../src/currency/settle.service';
import type { Room } from '../../src/rooms/rooms.service';
import type { CurrencyClient } from '../../src/currency/currency.client';
import type { RecordClient } from '../../src/gateway/record.client';
import type { ConfigCacheService } from '../../src/config/config-cache.service';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from '../helpers/config-cache.stub';
import { asRedis, createFakeRedis, type FakeRedis } from '../helpers/fake-redis';
import { currencySettleResultTotal } from '../../src/metrics/room.metrics';
import { labeledValue } from '../helpers/metric-readout';

export const ROOM_CODE = 'ROOM01';
export const VERSION = 7;

/** 地主坐 0 赢（±2u）。 */
export const resultFixture = (over: Partial<DdzSettlementResult> = {}): DdzSettlementResult => ({
  roomCode: ROOM_CODE,
  baseScore: 15,
  winner: 'landlord',
  landlordSeat: 0,
  farmerSeats: [1, 2],
  multiplier: 2,
  spring: 'none',
  landlordScoreChange: 30,
  farmerScoreChange: -15,
  ...over,
});

/**
 * 三座房间（默认：alice@0 人类、bot-int-1@1 机器人、carol@2 人类）。
 * 机器人座的 `Seat.userId` 是**出站 displayId**（`p_…`）—— 资金面绝不能用它（C25 的正对照）。
 */
export const goldRoom = (over: Partial<Room> = {}, botSeat = true): Room => ({
  code: ROOM_CODE,
  mode: 'gold',
  baseScore: 15,
  maxPlayers: 3,
  status: 'playing',
  createdAt: 0,
  timeoutAt: 0,
  players: [
    { seat: 0, userId: 'alice', isRobot: false },
    botSeat
      ? { seat: 1, userId: 'p_bot0001', isRobot: true }
      : { seat: 1, userId: 'bob', isRobot: false },
    { seat: 2, userId: 'carol', isRobot: false },
  ],
  ...over,
});

/** 默认入参（守卫全过、robots 映射齐）。 */
export const validInput = (over: Partial<SettleInput> = {}): SettleInput => ({
  roomCode: ROOM_CODE,
  version: VERSION,
  result: resultFixture(),
  room: goldRoom(),
  botBySeat: new Map([[1, 'bot-int-1']]),
  ...over,
});

/** `currency.get` 的形状化替身：按 ownerId 给余额（缺省全 1000）。 */
export const balancesFor = (
  over: Record<string, number> = {},
  all = 1000,
): { balances: Array<{ ownerId: string; balance: number; exists: boolean }> } => ({
  balances: ['alice', 'bot-int-1', 'carol'].map((ownerId) => {
    const balance = over[ownerId] ?? all;
    return { ownerId, balance, exists: true };
  }),
});

/** `currency.apply` 的成功响应（entries 与请求同源，balanceAfter 由用例给）。 */
export const applyOk = (
  actionId: string,
  entries: Array<{ ownerId: string; delta: number }>,
  after: Record<string, number>,
  replayed = false,
): CurrencyApplyData => ({
  opId: 1,
  actionId,
  entries: entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: after[e.ownerId] ?? e.delta })),
  replayed,
});

export interface SettleHarness {
  svc: SettleService;
  redis: FakeRedis;
  currency: { get: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
  record: { moneyDelta: ReturnType<typeof vi.fn> };
  robotHook: { afterSettle: ReturnType<typeof vi.fn> } & SettleRobotHook;
  configCache: ConfigCacheStub;
  /** `bindBroadcast` 收到的每一次调用（顺序即播放顺序；多玩法时带 gameType/playerCount）。 */
  broadcasts: Array<{
    roomCode: string;
    version: number;
    balances: Array<{ seat: number; balance: number }>;
    gameType?: string;
    playerCount?: number;
  }>;
}

export function makeHarness(): SettleHarness {
  const redis = createFakeRedis();
  const currency = { get: vi.fn(), apply: vi.fn() };
  const record = { moneyDelta: vi.fn().mockResolvedValue({ matched: [0, 1, 2] }) };
  const robotHook = { afterSettle: vi.fn().mockResolvedValue(undefined) };
  const configCache = makeConfigCache();
  const svc = new SettleService(
    asRedis(redis),
    currency as unknown as CurrencyClient,
    asConfigCache(configCache) as unknown as ConfigCacheService,
    record as unknown as RecordClient,
    robotHook as unknown as SettleRobotHook,
  );
  const broadcasts: SettleHarness['broadcasts'] = [];
  svc.bindBroadcast((roomCode, version, balances, meta) =>
    broadcasts.push({
      roomCode,
      version,
      balances,
      ...(meta === undefined ? {} : { gameType: meta.gameType, playerCount: meta.playerCount }),
    }),
  );
  return { svc, redis, currency, record, robotHook, configCache, broadcasts };
}

/** 读 `currency_settle_result_total{result}` 的当前值（无序列 ⇒ 0）。 */
export async function resultCount(result: string): Promise<number> {
  return (await labeledValue(currencySettleResultTotal, { result })) ?? 0;
}

/** 装捕获 sink（照各既有测试的 M4 纪律：用后必须还原 Logger —— 见 afterEach）。 */
export function installSink(): LogRecord[] {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
  return records;
}

/** M4：`Logger.overrideLogger` 是进程级的 —— 每个用到 sink 的文件都要还原。 */
export function restoreLogger(): void {
  Logger.overrideLogger(new Logger());
}
