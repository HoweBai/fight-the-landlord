/**
 * 挂机治理（T4）：`game.trustee` 边 + R8 三分支 + R6 例外。
 *
 * 覆盖（任务书 Step 1 清单）：
 *  - 守卫链：无会话 12001 / Init 13009 / Ended 13005 / 不在房 12004 / 机器人座位 10001
 *  - C7   守卫**先于** no-op：Ended + 目标值 = 现值 ⇒ 13005（不是 0）
 *  - C7b  非法 via × on ⇒ 10001 且不落盘 / 不 bump
 *  - C8   目标值 = 现值 ⇒ 三面零调用（不落盘 / 不 bump / 不 publish），timer 也不重挂
 *  - C9   实际变更 ⇒ 轻量转移（save + version+1 + publish），**不经 finishTransition**
 *  - C13  非行动者变更 ⇒ timer 与 deadline 均不动（并入 C9 用例）
 *  - C11  R8①：行动者被置 trustee ⇒ deadline = now + max(0, min(剩余, trustee 档))，
 *         先改 deadline 后 publish；计时器真的按收缩后的时长触发
 *  - C12  R8②：**手动开启的托管** manual off ⇒ 不重排不重算（本轮仍按原短延时自动走一次）；
 *         自动托管的 manual off ⇒ count 清零 + 重排 accel（D7），旧短计时器被清除
 *  - C14  R6 例外：reconnect off 且原 true 且本人行动者 ⇒ 按 count 基线重排
 *         （count>0 ⇒ accel / count=0 ⇒ normal）；非 trustee 反复 join 不动 timer
 *  - C4 / C4′  两路 off 分来源：自动托管（count ≥ after）清零；手动开启的托管 / 重连保留
 *  - RPC 边：`@MessagePattern(RPC_PATTERNS.gameTrustee)` 逐字 + handler 经
 *    `this.gameService.applyTrustee`、R220 信封按 `GameError.code` 保真
 *
 * ⚠️ 本文件按 TDD 先写、此时 `applyTrustee` 尚不存在 ⇒ 第一轮必须整体红
 * （`service.applyTrustee is not a function`；pattern 那条取不到方法元数据）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameState, type GamePlayer, type GameSession } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type Card } from '@fight-the-landlord/protocol';
import type { Redis } from 'ioredis';
import { GameService } from '../src/game/game.service';
import { GameError } from '../src/game/game.errors';
import { GameRpcController } from '../src/rpc/game.rpc.controller';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 牌是 `{r, s}`；本文件只关心点数（s 统一取 0）。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

const ROOM = 'TRU01';

/** 注入态：normal 1500 / accel 1000 / trustee 400 / 阈值 3（与 governance.test.ts 同值）。 */
const ENV: Record<string, string> = {
  GAME_TURN_TIMEOUT_MS: '1500',
  GAME_TURN_TIMEOUT_ACCEL_MS: '1000',
  GAME_TRUSTEE_DELAY_MS: '400',
  GAME_TRUSTEE_AFTER: '3',
};
const ENV_KEYS = Object.keys(ENV);
let savedEnv: Record<string, string | undefined> = {};

function player(seat: number, over: Partial<GamePlayer> = {}): GamePlayer {
  return {
    id: `player-${seat}`,
    seat,
    hand: h(3, 4, 5, 6, 7),
    isLandlord: false,
    isBot: false,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    ...over,
  };
}

const BID_PHASE: GameSession['bidPhase'] = {
  currentBidder: 0,
  landlordCaller: -1,
  landlordCandidate: -1,
  bidPasses: 0,
  grabActions: 0,
  bidMultiplier: 1,
  redealCount: 0,
  decisions: [],
  firstCaller: -1,
  antiRobGranted: false,
};

function makeSession(over: Partial<GameSession> = {}): GameSession {
  const base: GameSession = {
    roomCode: ROOM,
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore: 100,
    state: GameState.Playing,
    players: [player(0), player(1), player(2)],
    bottomCards: h(8, 9, 10),
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    bidPhase: { ...BID_PHASE },
    playPhase: { bombCount: 0, landlordPlays: 0, farmerPlays: 0, consecutivePasses: 0 },
    createdAt: 0,
    finishedAt: null,
  };
  return { ...base, ...over };
}

function biddingSession(over: Partial<GameSession> = {}): GameSession {
  return makeSession({ state: GameState.Bidding, bidPhase: { ...BID_PHASE }, ...over });
}

/** 跑一次调用，返回错误码（成功则返回 `'RESOLVED'`）；顺带钉住异常类必须是 `GameError`。 */
async function codeOf(p: Promise<unknown>): Promise<ErrCode | 'RESOLVED'> {
  try {
    await p;
    return 'RESOLVED';
  } catch (err) {
    expect(err).toBeInstanceOf(GameError);
    return (err as GameError).code;
  }
}

interface PublishedEvent {
  event: string;
  version: number;
  seatViews: Array<{ trustees: [boolean, boolean, boolean]; turnDeadlineAt: number }>;
}

/** 已发布到 `game:events` 的载荷（按发布顺序解析）。 */
function publishedEvents(): PublishedEvent[] {
  return redisDouble._published.map(([, raw]) => JSON.parse(raw) as PublishedEvent);
}

describe('game.trustee 边（T4）', () => {
  let service: GameService;

  /** 种会话到缓存（`getSession` 的首个命中面；不触 Redis 读写）。 */
  const seed = (room: string, session: GameSession): void => {
    service['cache'].set(room, session);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = ENV[key];
    }
    service = new GameService(redisDouble as unknown as Redis);
    service.random = () => 0;
    service.robotDelay = async () => {};
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  // ─── 守卫链 ─────────────────────────────────────────────────────

  describe('守卫链（C7 / 错误码保真）', () => {
    it('无会话 ⇒ 12001', async () => {
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: 'TRU-NONE', userId: 'player-0', on: true, via: 'manual' }),
        ),
      ).toBe(ErrCode.ROOM_NOT_FOUND);
    });

    it('Init ⇒ 13009', async () => {
      const session = makeSession({ state: GameState.Init });
      seed(ROOM, session);
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: ROOM, userId: 'player-1', on: true, via: 'manual' }),
        ),
      ).toBe(ErrCode.GAME_NOT_STARTED);
    });

    it('Ended ⇒ 13005', async () => {
      const session = makeSession({ state: GameState.Ended });
      seed(ROOM, session);
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: ROOM, userId: 'player-1', on: true, via: 'manual' }),
        ),
      ).toBe(ErrCode.GAME_OVER);
    });

    it('不在房 ⇒ 12004', async () => {
      const session = makeSession();
      seed(ROOM, session);
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: ROOM, userId: 'player-9', on: true, via: 'manual' }),
        ),
      ).toBe(ErrCode.NOT_IN_ROOM);
    });

    it('机器人座位 ⇒ 10001（⛔ 不看 isBot——它生产恒 false）', async () => {
      const session = makeSession({ botIds: ['bot-0', undefined, undefined] });
      seed(ROOM, session);
      // 座位 0 的 `isBot` 保持 false（生产形态）；判定只看 botIds 下标。
      expect(session.players[0]!.isBot).toBe(false);
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: ROOM, userId: 'player-0', on: true, via: 'manual' }),
        ),
      ).toBe(ErrCode.BAD_PARAM);
    });

    it('C7：守卫先于 no-op —— Ended + 目标值 = 现值 ⇒ 13005（不是 0）', async () => {
      const session = makeSession({ state: GameState.Ended });
      seed(ROOM, session);
      // 目标 false == 现值 false：若 no-op 先于 State 守卫，会返回 {version} 而非抛错。
      expect(
        await codeOf(
          service.applyTrustee({ roomCode: ROOM, userId: 'player-1', on: false, via: 'manual' }),
        ),
      ).toBe(ErrCode.GAME_OVER);
    });
  });

  // ─── C7b：非法 via × on ─────────────────────────────────────────

  describe('C7b：非法 via × on ⇒ 10001 且不落盘 / 不 bump', () => {
    const rows = [
      { via: 'reconnect', on: true },
      { via: 'abandon', on: false },
    ] as const;

    for (const row of rows) {
      it(`${row.via} × ${row.on}`, async () => {
        const session = makeSession({ currentPlayer: 1 });
        seed(ROOM, session);
        redisDouble.set.mockClear();
        redisDouble.publish.mockClear();

        expect(
          await codeOf(
            service.applyTrustee({
              roomCode: ROOM,
              userId: 'player-1',
              on: row.on,
              via: row.via,
            }),
          ),
        ).toBe(ErrCode.BAD_PARAM);

        expect((await service.getSession(ROOM))!.version).toBe(session.version); // 不 bump
        expect(redisDouble.set).not.toHaveBeenCalled(); // 不落盘
        expect(redisDouble.publish).not.toHaveBeenCalled(); // 不 publish
      });
    }

    it('组合守卫先于会话读取：非法组合 + 无会话 ⇒ 10001（不是 12001）', async () => {
      expect(
        await codeOf(
          service.applyTrustee({
            roomCode: 'TRU-NONE',
            userId: 'player-0',
            on: true,
            via: 'reconnect',
          }),
        ),
      ).toBe(ErrCode.BAD_PARAM);
    });
  });

  // ─── C8：no-op 三面零调用 ───────────────────────────────────────

  describe('C8：目标值 = 现值 ⇒ 完全 no-op（三面零调用）', () => {
    const rows = [
      { name: 'manual 重复开', via: 'manual', on: true, trustee: true },
      { name: 'manual 重复关', via: 'manual', on: false, trustee: false },
      { name: 'reconnect 反复 join（非 trustee）', via: 'reconnect', on: false, trustee: false },
      { name: 'abandon 重复开', via: 'abandon', on: true, trustee: true },
    ] as const;

    for (const row of rows) {
      it(row.name, async () => {
        const room = `TRU-C8-${row.via}-${String(row.on)}`;
        const session = makeSession({
          players: [player(0), player(1, { timeoutCount: 2, trustee: row.trustee }), player(2)],
          currentPlayer: 1,
        });
        seed(room, session);
        service['startTurnTimer'](room, session);
        const handleBefore = service['timers'].get(room);
        redisDouble.set.mockClear();
        redisDouble.publish.mockClear();

        await expect(
          service.applyTrustee({ roomCode: room, userId: 'player-1', on: row.on, via: row.via }),
        ).resolves.toEqual({ version: session.version });

        const after = (await service.getSession(room))!;
        expect(after.version).toBe(session.version); // 不 bump
        expect(after.players[1]).toMatchObject({ timeoutCount: 2, trustee: row.trustee }); // 值不动
        expect(redisDouble.set).not.toHaveBeenCalled(); // 不落盘
        expect(redisDouble.publish).not.toHaveBeenCalled(); // 不 publish
        expect(service['timers'].get(room)).toBe(handleBefore); // timer 不重挂
        expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt);
      });
    }
  });

  // ─── C9 + C13：轻量转移（非行动者 ⇒ timer/deadline 不动） ────────

  describe('C9 + C13：实际变更 = 轻量转移（bump + publish，timer/deadline 不动）', () => {
    const rows = [
      { name: 'manual × on（非行动者）', via: 'manual', on: true },
      { name: 'abandon × on（非行动者，合法组合同分支）', via: 'abandon', on: true },
    ] as const;

    for (const row of rows) {
      it(row.name, async () => {
        const room = `TRU-C9-${row.via}`;
        const session = makeSession({ currentPlayer: 0 }); // 行动者 = 座位 0，变更者 = 座位 1
        seed(room, session);
        service['startTurnTimer'](room, session);
        const handleBefore = service['timers'].get(room);
        const finishSpy = vi.fn(async () => {});
        service['finishTransition'] = finishSpy;
        redisDouble.set.mockClear();
        redisDouble.publish.mockClear();

        await expect(
          service.applyTrustee({ roomCode: room, userId: 'player-1', on: row.on, via: row.via }),
        ).resolves.toEqual({ version: session.version + 1 });

        const after = (await service.getSession(room))!;
        expect(after.version).toBe(session.version + 1); // bump
        expect(after.players[1]).toMatchObject({ timeoutCount: 0, trustee: true });
        expect(redisDouble.set).toHaveBeenCalledTimes(1); // 落盘一次
        expect(redisDouble.publish).toHaveBeenCalledTimes(1); // publish 一次
        const evt = publishedEvents()[0]!;
        expect(evt.event).toBe('game.state_updated');
        expect(evt.version).toBe(session.version + 1);
        expect(evt.seatViews[1]!.trustees[1]).toBe(true); // 推送里已是新值
        expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt); // C13：deadline 不动
        expect(service['timers'].get(room)).toBe(handleBefore); // C13：timer 不动
        expect(finishSpy).not.toHaveBeenCalled(); // 不经 finishTransition
      });
    }

    it('on=true 保留既有 count（只有 off 走 onTrusteeOff）', async () => {
      const room = 'TRU-C9-COUNT';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2 }), player(2)],
        currentPlayer: 0,
      });
      seed(room, session);

      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' });

      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 2,
        trustee: true,
      });
    });
  });

  // ─── C11：R8①（min + clamp；先 deadline 后 publish） ─────────────

  describe('C11（R8①）：行动者被置 trustee ⇒ deadline = now + max(0, min(剩余, 400))', () => {
    const rows = [
      { name: '剩余 5000 > 400 ⇒ 收缩到 400', remaining: 5000, expectedMs: 400 },
      { name: '剩余 200 < 400 ⇒ 只缩到剩余（min 不延长）', remaining: 200, expectedMs: 200 },
      { name: '剩余已为负 ⇒ clamp 到 0', remaining: -500, expectedMs: 0 },
    ] as const;

    for (const row of rows) {
      it(row.name, async () => {
        const room = `TRU-C11-${String(row.expectedMs)}`;
        const session = makeSession({
          currentPlayer: 1,
          turnDeadlineAt: Date.now() + row.remaining,
        });
        seed(room, session);

        const before = Date.now();
        await expect(
          service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' }),
        ).resolves.toEqual({ version: session.version + 1 });

        const after = (await service.getSession(room))!;
        expect(after.turnDeadlineAt).toBe(before + row.expectedMs); // 先改 deadline
        expect(after.players[1]).toMatchObject({ timeoutCount: 0, trustee: true });

        // 「先 deadline 后 publish」的证据：出站视图携带的就是**新** deadline。
        const evt = publishedEvents()[0]!;
        expect(evt.version).toBe(session.version + 1);
        expect(evt.seatViews.every((v) => v.turnDeadlineAt === after.turnDeadlineAt)).toBe(true);

        // 计时器真的重排到 overrideMs（原 deadline 在 5000ms 后 ⇒ 不重排本行必红）。
        if (row.expectedMs > 0) {
          await vi.advanceTimersByTimeAsync(row.expectedMs - 1);
          expect((await service.getSession(room))!.version).toBe(session.version + 1);
          await vi.advanceTimersByTimeAsync(1);
        } else {
          await vi.advanceTimersByTimeAsync(0);
        }
        expect((await service.getSession(room))!.version).toBe(session.version + 2);
      });
    }

    it('叫抢阶段按 bidPhase.currentBidder 判定行动者（⛔ 不是 currentPlayer）', async () => {
      const room = 'TRU-C11-BID';
      // `currentPlayer` 默认是 0（叫抢期恒为 0）；真正的行动者是 currentBidder=1。
      // 误用 currentPlayer 的实现会认为变更者不是行动者 ⇒ 不重排 ⇒ deadline 停在 5000 后。
      const session = biddingSession({
        players: [player(0), player(1), player(2)],
        bidPhase: { ...BID_PHASE, currentBidder: 1 },
        turnDeadlineAt: Date.now() + 5000,
      });
      seed(room, session);

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' }),
      ).resolves.toEqual({ version: session.version + 1 });

      expect((await service.getSession(room))!.turnDeadlineAt - Date.now()).toBe(400);
    });
  });

  // ─── C12：R8②（manual off 不重排不重算） ────────────────────────

  it('C12（R8②，手动开启的托管）：manual off ⇒ 不重排不重算（本轮仍按原短延时自动走一次）', async () => {
    const room = 'TRU-C12-MANUAL';
    const session = makeSession({
      players: [player(0), player(1, { timeoutCount: 2, trustee: true }), player(2)],
      currentPlayer: 1,
      turnDeadlineAt: Date.now() + 400,
    });
    seed(room, session);
    service['startTurnTimer'](room, session); // 旧 timer：trustee 档 400ms
    const handleBefore = service['timers'].get(room);

    await expect(
      service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' }),
    ).resolves.toEqual({ version: session.version + 1 });

    const after = (await service.getSession(room))!;
    expect(after.players[1]).toMatchObject({ timeoutCount: 2, trustee: false });
    expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt); // 不重算
    expect(service['timers'].get(room)).toBe(handleBefore); // 不重排

    await vi.advanceTimersByTimeAsync(400); // 旧短延时照常走一次（防续命的语义面）
    const timedOut = (await service.getSession(room))!;
    expect(timedOut.version).toBe(session.version + 2);
    expect(timedOut.players[1]).toMatchObject({ timeoutCount: 3, trustee: true }); // 2+1 ⇒ 达阈值再托管
  });

  it('C12（D7，自动托管）：manual off ⇒ count 清零 + 重排 accel；旧短计时器被清除', async () => {
    const room = 'TRU-C12-AUTO';
    const session = makeSession({
      players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
      currentPlayer: 1,
      turnDeadlineAt: Date.now() + 400,
    });
    seed(room, session);
    service['startTurnTimer'](room, session); // 旧 timer：trustee 档 400ms
    const handleBefore = service['timers'].get(room);

    await expect(
      service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' }),
    ).resolves.toEqual({ version: session.version + 1 });

    const after = (await service.getSession(room))!;
    expect(after.players[1]).toMatchObject({ timeoutCount: 0, trustee: false });
    expect(after.turnDeadlineAt - Date.now()).toBe(1000); // 注入态 accel 档
    const handleAfter = service['timers'].get(room);
    expect(handleAfter).not.toBe(handleBefore); // 旧句柄被 clearTimer（不只是旧回调自行放弃）

    // 从**新计时器安装时刻**起算：999ms 不触发、再 1ms 触发
    await vi.advanceTimersByTimeAsync(999);
    expect((await service.getSession(room))!.version).toBe(session.version + 1);
    await vi.advanceTimersByTimeAsync(1);
    const timedOut = (await service.getSession(room))!;
    expect(timedOut.version).toBe(session.version + 2);
    expect(timedOut.players[1]).toMatchObject({ timeoutCount: 1, trustee: false });
  });

  // ─── C14：R6 例外 ───────────────────────────────────────────────

  describe('C14（R6 例外）：reconnect off 且原 true 且本人行动者 ⇒ 按 count 基线重排', () => {
    const rows = [
      { name: 'count=0 ⇒ normal(1500)', count: 0, ms: 1500 },
      { name: 'count>0 ⇒ accel(1000)', count: 2, ms: 1000 },
    ] as const;

    for (const row of rows) {
      it(row.name, async () => {
        const room = `TRU-C14-${String(row.count)}`;
        const session = makeSession({
          players: [player(0), player(1, { timeoutCount: row.count, trustee: true }), player(2)],
          currentPlayer: 1,
          turnDeadlineAt: Date.now() + 400, // 旧档：trustee 400ms
        });
        seed(room, session);

        await expect(
          service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'reconnect' }),
        ).resolves.toEqual({ version: session.version + 1 });

        const after = (await service.getSession(room))!;
        expect(after.players[1]).toMatchObject({ timeoutCount: row.count, trustee: false });
        expect(after.turnDeadlineAt - Date.now()).toBe(row.ms); // 重算到 count 基线

        await vi.advanceTimersByTimeAsync(row.ms - 1);
        expect((await service.getSession(room))!.version).toBe(session.version + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await service.getSession(room))!.version).toBe(session.version + 2);
      });
    }

    it('负对照：非行动者的 reconnect off ⇒ timer/deadline 不动（R8③）', async () => {
      const room = 'TRU-C14-NEG';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2, trustee: true }), player(2)],
        currentPlayer: 0,
      });
      seed(room, session);
      service['startTurnTimer'](room, session);
      const handleBefore = service['timers'].get(room);

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'reconnect' }),
      ).resolves.toEqual({ version: session.version + 1 });

      const after = (await service.getSession(room))!;
      expect(after.players[1]).toMatchObject({ timeoutCount: 2, trustee: false });
      expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt);
      expect(service['timers'].get(room)).toBe(handleBefore);
    });

    it('非 trustee 者反复 join（reconnect × off 两次）不动 timer', async () => {
      const room = 'TRU-C14-JOIN';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 1, trustee: false }), player(2)],
        currentPlayer: 1,
      });
      seed(room, session);
      service['startTurnTimer'](room, session); // accel 档 1000ms（count=1）
      const handleBefore = service['timers'].get(room);
      redisDouble.publish.mockClear();

      for (let i = 0; i < 2; i += 1) {
        await expect(
          service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'reconnect' }),
        ).resolves.toEqual({ version: session.version });
      }

      const after = (await service.getSession(room))!;
      expect(after.version).toBe(session.version); // 两次都 no-op
      expect(after.players[1]).toMatchObject({ timeoutCount: 1, trustee: false });
      expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt);
      expect(service['timers'].get(room)).toBe(handleBefore);
      expect(redisDouble.publish).not.toHaveBeenCalled();
    });
  });

  // ─── C4 / C4′：两条 off 语义（自动托管清零 / 手动托管与重连保留） ─────

  describe('C4 / C4′：off 分来源', () => {
    it('C4′ manual off（自动托管、非行动者）⇒ count 清零；deadline 不动；publish 一次', async () => {
      const room = 'TRU-C4-AUTO';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
        currentPlayer: 0, // 非行动者：C13 同族
        turnDeadlineAt: Date.now() + 400,
      });
      seed(room, session);
      service['startTurnTimer'](room, session); // 非行动者（player 0）的 timer
      const handleBefore = service['timers'].get(room);
      redisDouble.set.mockClear();
      redisDouble.publish.mockClear();

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' }),
      ).resolves.toEqual({ version: session.version + 1 });

      const after = (await service.getSession(room))!;
      expect(after.players[1]).toMatchObject({ timeoutCount: 0, trustee: false });
      expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt);
      expect(service['timers'].get(room)).toBe(handleBefore); // 非行动者：timer 不动
      expect(redisDouble.set).toHaveBeenCalledTimes(1);
      expect(redisDouble.publish).toHaveBeenCalledTimes(1);
    });

    it('C4 manual off（手动开启的托管、行动者）⇒ count 保留；R8② 不重排', async () => {
      const room = 'TRU-C4-MANUAL';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2, trustee: true }), player(2)],
        currentPlayer: 1,
        turnDeadlineAt: Date.now() + 400,
      });
      seed(room, session);

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' }),
      ).resolves.toEqual({ version: session.version + 1 });

      const after = (await service.getSession(room))!;
      expect(after.players[1]).toMatchObject({ timeoutCount: 2, trustee: false });
      expect(after.turnDeadlineAt).toBe(session.turnDeadlineAt); // R8②：不重排
    });

    it('C4 reconnect off（行动者）⇒ count 保留；按 count 基线重排（1000ms）', async () => {
      const room = 'TRU-C4-RECONNECT';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
        currentPlayer: 1,
        turnDeadlineAt: Date.now() + 400,
      });
      seed(room, session);

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'reconnect' }),
      ).resolves.toEqual({ version: session.version + 1 });

      const after = (await service.getSession(room))!;
      expect(after.players[1]).toMatchObject({ timeoutCount: 3, trustee: false });
      expect(after.turnDeadlineAt - Date.now()).toBe(1000); // count>0 ⇒ accel 基线
    });

    it('反旁路：count=2 时 manual on → manual off ⇒ count 仍为 2（阈值未到，不清零）', async () => {
      const room = 'TRU-C4-BYPASS';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2 }), player(2)],
        currentPlayer: 0,
      });
      seed(room, session);

      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' });
      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' });

      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 2,
        trustee: false,
      });
    });

    it('阈值已到的序列：count=2 → manual on → 超时一次 → count=3/trustee → manual off ⇒ 0/false', async () => {
      const room = 'TRU-C4-SEQUENCE';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2 }), player(2)],
        currentPlayer: 1,
        turnDeadlineAt: Date.now() + 400,
      });
      seed(room, session);
      service['startTurnTimer'](room, session);

      // manual on ⇒ R8① 收缩到 min(剩余, 400)
      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' });
      // 超时自动动作 ⇒ count 2→3、trustee=true
      await vi.advanceTimersByTimeAsync(400);
      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 3,
        trustee: true,
      });

      // 此时 manual off 属于「阈值已到」⇒ 清零
      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' });
      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 0,
        trustee: false,
      });
    });

    it('D13 重连竞态：重连已清 trustee（count=3）后 manual off ⇒ no-op（count 不清）', async () => {
      const room = 'TRU-C4-RACE';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: false }), player(2)],
        currentPlayer: 0,
      });
      seed(room, session);
      redisDouble.set.mockClear();
      redisDouble.publish.mockClear();

      await expect(
        service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' }),
      ).resolves.toEqual({ version: session.version });

      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 3,
        trustee: false,
      });
      expect(redisDouble.set).not.toHaveBeenCalled();
      expect(redisDouble.publish).not.toHaveBeenCalled();
    });

    it('已知边界（D6）：reconnect 保留 count=3 后 manual on→off ⇒ 0（阈值语义）', async () => {
      const room = 'TRU-C4-RECONNECT-WASH';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: false }), player(2)],
        currentPlayer: 0,
      });
      seed(room, session);

      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' });
      await service.applyTrustee({ roomCode: room, userId: 'player-1', on: false, via: 'manual' });

      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 0,
        trustee: false,
      });
    });
  });

  // ─── 托管默认档（D10）──────────────────────────────────────────

  it('默认托管档 = 2000ms（GAME_TRUSTEE_DELAY_MS 未注入）', () => {
    delete process.env.GAME_TRUSTEE_DELAY_MS;
    expect(service['durations']().trustee).toBe(2_000);
  });

  // ─── RPC 边：pattern + handler 同提交（J21） ────────────────────

  describe('RPC 边：@MessagePattern + handler（J21 同提交）', () => {
    it('pattern 名逐字 game.trustee，且来自 RPC_PATTERNS（不是字面量）', () => {
      expect(RPC_PATTERNS.gameTrustee).toBe('game.trustee');
      expect(
        Reflect.getMetadata('microservices:pattern', GameRpcController.prototype.trustee),
      ).toEqual(['game.trustee']);
    });

    it('handler 走 this.gameService.applyTrustee；R220 信封按 GameError.code 保真', async () => {
      const applyTrustee = vi.fn(async () => ({ version: 7 }));
      const controller = new GameRpcController({ applyTrustee } as unknown as GameService);
      const dto = {
        roomCode: 'R1',
        userId: 'u1',
        on: true,
        via: 'manual' as const,
        meta: { traceId: 'T-4' },
      };

      await expect(controller.trustee(dto)).resolves.toEqual({ ok: true, data: { version: 7 } });
      expect(applyTrustee).toHaveBeenCalledWith(dto);

      applyTrustee.mockRejectedValueOnce(new GameError(ErrCode.GAME_OVER, '对局已结束'));
      await expect(controller.trustee(dto)).resolves.toEqual({
        ok: false,
        code: ErrCode.GAME_OVER,
        message: '对局已结束',
      });
    });
  });
});
