/**
 * 挂机治理 T5（R10）：**同房写串行 + 机器人互锁 + timer 回合身份复核**。
 *
 * 覆盖（任务书 Step 1 / 规格 §二 D 的 v1.0 清单）：
 *  - C15  awaited per-room 队列覆盖写路径：同 tick 两次 `applyTrustee` **均生效**
 *         （⛔ 不照 `robotDriving` 的 drop-on-reentry —— 那会静默丢第二笔写）
 *  - C16  同 tick 双发（出牌 + toggle）⇒ 串行生效：无覆盖、无同版本分叉
 *  - C17  机器人提交 × toggle：
 *         ① 纯 version 变化（治理转移）**不丢** —— rebase 到入锁后重读的会话应用决策
 *         ② 被打断（回合已转移）⇒ 丢弃决策、返回 true 走 `driveRobotTurn` 循环**下一轮**
 *            重驱（⛔ 锁内递归调 `driveRobotTurn` 会撞 `robotDriving` 的 drop-on-reentry
 *            静默 no-op ⇒ 本用例的下一个机器人永远不会被驱动）
 *  - C18  timer 回调按**回合身份**复核（⛔ 不按 version）：
 *         ① 非行动者 toggle（纯 version 变化）后定时到点 ⇒ **照常自动动作**
 *            （若按 version 复核 ⇒ 放弃 ⇒ R8③ 又不动 timer ⇒ AFK 回合永久停摆）
 *         ② 回合已转移（actor/deadline 变）⇒ **放弃**（迟到回调不替新回合动作）
 *         ③ state ∈ {Init, Ended} ⇒ 放弃
 *  - Ended ⇒ 清理该房的队列条目（`roomQueues.delete`）
 *
 * 说明：`game.timer.test.ts` 的四处「直接换缓存 = 模拟回合转移」夹具在同批补了
 * `startTurnTimer` 重挂 —— 真实写者完成转移时本来就会重挂，旧计时器必须按回合身份放弃。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GameState,
  HandType,
  type GamePlayer,
  type GameSession,
} from '@fight-the-landlord/shared';
import type { Card, RobotDecideRequest, RobotDecideResponse } from '@fight-the-landlord/protocol';
import type { Redis } from 'ioredis';
import { GameService } from '../src/game/game.service';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 牌是 `{r, s}`；本文件只关心点数（s 统一取 0）。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/** 注入态（与 governance.test.ts / trustee.test.ts 同值）：normal 1500 / accel 1000 / trustee 400。 */
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
    roomCode: 'CON-ROOM',
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

/** 只冲微任务（**不**推进时钟）：足以把 `driveRobotTurn` 推过 getSession / 到达注入的思考延迟。 */
const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface PublishedEvent {
  event: string;
  version: number;
}

/** 已发布到 `game:events` 的载荷（按发布顺序解析）。 */
function publishedEvents(): PublishedEvent[] {
  return redisDouble._published.map(([, raw]) => JSON.parse(raw) as PublishedEvent);
}

describe('T5：R10 同房写串行 / 机器人互锁 / timer 回合身份复核', () => {
  let service: GameService;

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

  // ─── C15：awaited 队列语义（并发两写均生效） ─────────────────────

  it('C15：同 tick 两次 applyTrustee ⇒ 排队执行，两笔写均生效（版本逐笔 +1、无丢弃）', async () => {
    const room = 'CON-C15';
    const session = makeSession({ currentPlayer: 0 });
    seed(room, session);

    // 同一 tick 双发（连 await 都没有）：drop-on-reentry 形态下第二笔会被静默吞掉。
    const p1 = service.applyTrustee({
      roomCode: room,
      userId: 'player-1',
      on: true,
      via: 'manual',
    });
    const p2 = service.applyTrustee({
      roomCode: room,
      userId: 'player-2',
      on: true,
      via: 'manual',
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    const after = (await service.getSession(room))!;
    // 两笔都落盘：version 恰好 +2（不是 +1 —— 覆盖写会让两笔共享同一个 +1）。
    expect(after.version).toBe(session.version + 2);
    expect(after.players[1]).toMatchObject({ trustee: true });
    expect(after.players[2]).toMatchObject({ trustee: true });
    // 各自的返回版本是**不同**的（v+1、v+2）—— 串行的直接证据。
    expect([r1.version, r2.version].sort((a, b) => a - b)).toEqual([
      session.version + 1,
      session.version + 2,
    ]);
    // 推送版本严格递增、无同版本分叉。
    expect(publishedEvents().map((e) => e.version)).toEqual([
      session.version + 1,
      session.version + 2,
    ]);
  });

  // ─── C16：同 tick 双发（出牌 + toggle） ─────────────────────────

  it('C16：同 tick 出牌 + toggle ⇒ 串行生效（无覆盖、无同版本分叉）', async () => {
    const room = 'CON-C16';
    const dto = {
      roomCode: room,
      baseScore: 100,
      players: [
        { id: 'user-1', seat: 0, isRobot: false },
        { id: 'user-2', seat: 1, isRobot: false },
        { id: 'user-3', seat: 2, isRobot: false },
      ],
    };
    await service.startGame(dto);
    await service.bid(room, 'user-1', true);
    await service.bid(room, 'user-2', false);
    await service.bid(room, 'user-3', false);

    const before = (await service.getSession(room))!;
    expect(before.state).toBe(GameState.Playing);
    const landlord = before.players[before.currentPlayer]!;
    const farmer = before.players.find((p) => p.seat !== before.currentPlayer)!;
    const playedCard = landlord.hand[0]!;
    const mark = redisDouble._published.length;

    // 同一 tick 双发：出牌（写者 1）+ 非行动者 toggle（写者 2）。
    const playP = service.playCards(room, landlord.id, [playedCard]);
    const toggleP = service.applyTrustee({
      roomCode: room,
      userId: farmer.id,
      on: true,
      via: 'manual',
    });
    await Promise.all([playP, toggleP]);

    const after = (await service.getSession(room))!;
    // 两笔写都存活：不是「后一笔拿旧快照把前一笔覆盖掉」。
    expect(after.version).toBe(before.version + 2);
    expect(after.lastPlayedHand!.cards).toEqual([playedCard]); // 出牌没有被 toggle 覆盖
    expect(after.players[landlord.seat]!.hand).toHaveLength(landlord.hand.length - 1);
    expect(after.players[farmer.seat]!.trustee).toBe(true); // toggle 没有被出牌覆盖

    // 同版本分叉的判别：两次推送的版本必须是 v+1、v+2（未串行时两者都是 v+1）。
    const versions = redisDouble._published
      .slice(mark)
      .map(([, raw]) => (JSON.parse(raw) as PublishedEvent).version);
    expect(versions).toEqual([before.version + 1, before.version + 2]);
  });

  // ─── C17：机器人提交 × toggle ──────────────────────────────────

  /** 出牌阶段、座位 0 是机器人（跟单张 5）、座位 1/2 是人类。 */
  function robotFixture(over: Partial<GameSession> = {}): GameSession {
    return makeSession({
      players: [
        player(0, { id: 'p_bot0', hand: h(5, 6, 9) }),
        player(1, { id: 'human-1', hand: h(3, 4, 5, 6, 7) }),
        player(2, { id: 'human-2', hand: h(3, 4, 5, 6, 7) }),
      ],
      botIds: ['bot-0', undefined, undefined],
      currentPlayer: 0,
      lastPlayerIdx: 2,
      lastPlayedHand: { cards: h(5), type: HandType.Single, keyRank: 5, length: 0 },
      playPhase: { bombCount: 0, landlordPlays: 0, farmerPlays: 0, consecutivePasses: 0 },
      ...over,
    });
  }

  it('C17①：机器人思考期间 toggle（纯 version 变化）⇒ 复验通过 + rebase（决策与 toggle 都存活）', async () => {
    const room = 'CON-C17-REBASE';
    const base = robotFixture();
    seed(room, base);

    const gate = deferred<void>();
    service.robotDelay = () => gate.promise;
    const decideCalls: string[] = [];
    service.robotClient = {
      decide: async (req: RobotDecideRequest): Promise<RobotDecideResponse | null> => {
        decideCalls.push(req.botId);
        return { kind: 'play', cards: [9], source: 'douzero' };
      },
    } as never;

    const driving = service['driveRobotTurn'](room);
    await flushMicro();
    // 反空测：此刻它被思考延迟挡住、决策尚未发生（toggle 才能落在「决策之后、提交之前」）。
    expect(decideCalls).toEqual([]);

    // 思考期间：非行动者 toggle —— 只 bump version，回合身份（state/actor/deadline）不变。
    await expect(
      service.applyTrustee({ roomCode: room, userId: 'human-1', on: true, via: 'manual' }),
    ).resolves.toEqual({ version: base.version + 1 });

    gate.resolve();
    await driving;

    const after = (await service.getSession(room))!;
    // 决策**没有被丢弃**：version 变化不算失效 ⇒ 只决策一次（严格按 version 复验会丢弃重驱 ⇒ 2 次）。
    expect(decideCalls).toEqual(['bot-0']);
    // rebase：决策应用在入锁后重读的会话上 —— 出牌生效，且思考期间的 toggle 没被旧快照覆盖。
    expect(after.lastPlayedHand!.cards).toEqual(h(9));
    expect(after.players[0]!.hand).toEqual(h(5, 6));
    expect(after.players[1]!.trustee).toBe(true);
    expect(after.version).toBe(base.version + 2);
  });

  it('C17②：机器人提交被打断（回合已转移）⇒ 丢弃决策并走循环下一轮重驱（⛔ 锁内递归会静默 no-op）', async () => {
    const room = 'CON-C17-REDRIVE';
    // 两个机器人：座位 0（被计时打断）→ 座位 1（重驱的下一轮必须驱动到它）。
    const base = robotFixture({
      players: [
        player(0, { id: 'p_bot0', hand: h(5, 6, 9) }),
        player(1, { id: 'p_bot1', hand: h(7, 8) }),
        player(2, { id: 'human-2', hand: h(3, 4, 5, 6, 7) }),
      ],
      botIds: ['bot-0', 'bot-1', undefined],
    });
    seed(room, base);

    const gate = deferred<void>();
    service.robotDelay = () => gate.promise;
    const decideCalls: string[] = [];
    service.robotClient = {
      decide: async (req: RobotDecideRequest): Promise<RobotDecideResponse | null> => {
        decideCalls.push(req.botId);
        // bot-0 的决策基于**过期快照**（它以为还是自己的回合）；bot-1 交给规则引擎。
        return req.botId === 'bot-0'
          ? ({ kind: 'play', cards: [9], source: 'douzero' } as RobotDecideResponse)
          : null;
      },
    } as never;

    const driving = service['driveRobotTurn'](room);
    await flushMicro();
    expect(decideCalls).toEqual([]);

    // 思考期间座位 0 超时（写出一次真实转移：6 压 5，回合换到座位 1）。
    await service['onTurnTimeout'](room);
    const afterTimeout = (await service.getSession(room))!;
    expect(afterTimeout.currentPlayer).toBe(1);
    expect(afterTimeout.lastPlayedHand!.cards).toEqual(h(6));
    expect(afterTimeout.version).toBe(base.version + 1);

    gate.resolve();
    await driving;

    const after = (await service.getSession(room))!;
    // 重驱的证据：座位 1 的机器人被驱动（bot-0 的过期决策已被丢弃，不落盘）。
    expect(decideCalls).toEqual(['bot-0', 'bot-1']);
    // 最终局面来自重驱链：7 压 6（而不是过期决策的 9、也不是停在超时的 6）。
    expect(after.lastPlayedHand!.cards).toEqual(h(7));
    expect(after.players[1]!.hand).toEqual(h(8));
    expect(after.currentPlayer).toBe(2);
    expect(after.version).toBe(base.version + 2);
  });

  // ─── C18：timer 回调按回合身份复核 ─────────────────────────────

  it('C18①：非行动者 toggle（纯 version 变化）后定时到点 ⇒ 照常自动动作（⛔ 按 version 复核会永久停摆）', async () => {
    const room = 'CON-C18-PROCEED';
    const base = makeSession({ currentPlayer: 0, turnDeadlineAt: Date.now() + 1500 });
    seed(room, base);
    service['startTurnTimer'](room, base);
    const handleBefore = service['timers'].get(room);

    // 非行动者 toggle：version +1，但 timer/deadline 均不动（C13/R8③）—— 这正是判别力所在。
    await expect(
      service.applyTrustee({ roomCode: room, userId: 'player-1', on: true, via: 'manual' }),
    ).resolves.toEqual({ version: base.version + 1 });
    expect(service['timers'].get(room)).toBe(handleBefore);
    expect((await service.getSession(room))!.turnDeadlineAt).toBe(base.turnDeadlineAt);

    await vi.advanceTimersByTimeAsync(1500);

    const after = (await service.getSession(room))!;
    // 超时自动动作照常发生：首出打最小单张 3，并把回合交给座位 1。
    expect(after.version).toBe(base.version + 2);
    expect(after.lastPlayedHand!.cards).toEqual(h(3));
    expect(after.currentPlayer).toBe(1);
  });

  it('C18②：回合已转移 ⇒ 迟到的 timer 回调放弃（不替新回合动作）', async () => {
    const room = 'CON-C18-STALE';
    const base = makeSession({ currentPlayer: 0, turnDeadlineAt: Date.now() + 1500 });
    seed(room, base);

    // 捕获**真实安装的 timer 回调**（比直接调 onTurnTimeout 更强：连传参接线一起判）。
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    service['startTurnTimer'](room, base);
    const lastCall = setSpy.mock.calls[setSpy.mock.calls.length - 1]!;
    const staleCallback = lastCall[0] as () => void;
    setSpy.mockRestore();

    // 模拟一次回合转移：行动者换了、deadline 重写、version 也变了（真实转移三者同变）。
    const transferred: GameSession = {
      ...base,
      currentPlayer: 1,
      turnDeadlineAt: base.turnDeadlineAt + 5000,
      version: base.version + 1,
    };
    seed(room, transferred);

    staleCallback();
    await flushMicro();

    const after = (await service.getSession(room))!;
    expect(after.version).toBe(transferred.version); // 放弃：没有产生任何新转移
    expect(after.currentPlayer).toBe(1);
    expect(after.lastPlayedHand).toBeNull();
    expect(after.players[0]!.hand).toEqual(transferred.players[0]!.hand); // 没替谁出牌
  });

  it('C18③：state ∈ {Init, Ended} ⇒ 旧回调放弃（即使回合身份碰巧相同）', async () => {
    const room = 'CON-C18-ENDED';
    const base = makeSession({ currentPlayer: 0, turnDeadlineAt: Date.now() + 1500 });
    seed(room, base);

    const ended: GameSession = { ...base, state: GameState.Ended, version: base.version + 1 };
    seed(room, ended);

    await service['onTurnTimeout'](room, {
      actorSeat: 0,
      deadlineAt: base.turnDeadlineAt,
    });

    const after = (await service.getSession(room))!;
    expect(after.version).toBe(ended.version);
    expect(after.lastPlayedHand).toBeNull();
  });

  // ─── Ended ⇒ 队列条目清理 ─────────────────────────────────────

  it('Ended ⇒ 清理该房的队列条目（roomQueues 不残留）', async () => {
    const room = 'CON-QUEUE-END';
    // 座位 0 是只剩一张牌的农民：出掉即农民胜 ⇒ 本笔写把房推到 Ended。
    const base = makeSession({
      currentPlayer: 0,
      players: [
        player(0, { hand: h(3) }),
        player(1, { hand: h(4, 5) }),
        player(2, { hand: h(6, 7), isLandlord: true }),
      ],
    });
    seed(room, base);

    await service.playCards(room, 'player-0', h(3));

    const after = (await service.getSession(room))!;
    expect(after.state).toBe(GameState.Ended); // 反空测：确实走到了终局分支
    expect(service['roomQueues'].has(room)).toBe(false);
  });
});
