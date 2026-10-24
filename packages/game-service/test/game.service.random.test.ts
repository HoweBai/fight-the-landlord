/**
 * 片① R1（规格 §5.2 / §5.6 / §7.1）：`GameService.random` 的注入必须**覆盖全部 4 个**
 * `createSession` / `handleBid` 调用点 —— 尤其 `game.service.ts` 里那个**模块级自由函数**
 * `applyDecisionToSession`（机器人驱动链的叫抢决策 `handleBid` 就在它里面，没有 `this`）。
 *
 * ⚠️ **为什么必须有行为判据**：`createSession` / `handleBid` 的 `random` **有默认值**
 * （生产行为不变）⇒ 漏传**不会编译失败**、静默退化成真随机 ⇒ 含机器人的房会以
 * 「看起来好了」的形态留下 flaky。`applyDecisionToSession` 的 `random` **无默认值**
 * ⇒ 漏传是 TS2554 编译错（结构性防线）；本文件的判据补的是**行为**面：
 * ① 座位/地主取注入值；② 注入函数**真的被调用**（计数断言 ⇒ 漏传是**确定性**红，
 * 而不是 1/3 概率红的 flaky）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameState } from '@fight-the-landlord/shared';
import type { GameSession } from '@fight-the-landlord/shared';
import { GameService } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 三人类玩家的开局 DTO（座位 0/1/2 = user-1/2/3）。 */
const humans = [
  { id: 'user-1', seat: 0, isRobot: false },
  { id: 'user-2', seat: 1, isRobot: false },
  { id: 'user-3', seat: 2, isRobot: false },
];

/**
 * 轮询 `getSnapshot` 直到机器人驱动环把房间推进到 `Playing`
 * （机器人推进的既有写法见 `game.robot.test.ts:75-87` 的 `flush()`）。
 *
 * 🔴 **不能**用 `await new Promise(r => setTimeout(r, …))` 式轮询：驱动环
 * （`robotDelay` 已注入 0 延迟、`robotClient` 是内存替身）整条链都在**微任务**上跑 ——
 * 宏任务轮询会被它饿到「整局都打完」才醒，而打完之后状态已是 `Ended` 或更晚，
 * **永远看不到 `Playing` 这个中间态**。因此这里按**微任务刻度**前进：
 * 每轮让出一个 tick 再查一次（状态在 `Playing` 上会停留整段出牌期 ⇒ 必被采到）。
 * 上界用**迭代次数** —— 循环不经过宏任务，墙钟上界在这里没有意义。
 */
async function waitForPlaying(service: GameService, roomCode: string): Promise<GameSession> {
  const MAX_TICKS = 5000;
  for (let i = 0; i < MAX_TICKS; i += 1) {
    const session = await service.getSnapshot(roomCode);
    if (session?.state === GameState.Playing) return session;
    await Promise.resolve(); // 让驱动环前进一个微任务刻度
  }
  throw new Error(`Room ${roomCode} did not reach Playing within ${MAX_TICKS} microtask ticks`);
}

/**
 * 把一份**旧版本形态**的会话写进 redis 替身（键 `game:session:{roomCode}`）。
 *
 * 旧版本（片① 部署前）写出的会话**运行时没有** `firstCaller` / `antiRobGranted`
 * —— 类型层面它们是必填 ⇒ 只能从一份真实会话出发、按老形态改写后再 JSON 化
 * （JSON 往返同时替我们做了**深拷贝**，防止改到缓存里的活对象）。
 * 传进来的 `bidPhase` 就是老形态的那一份：**含不含 `decisions` 由用例决定**。
 */
async function seedLegacySession(
  service: GameService,
  roomCode: string,
  bidPhase: Record<string, unknown>,
): Promise<void> {
  await service.startGame({ roomCode, baseScore: 100, players: humans });
  const raw = await service.getSnapshot(roomCode);
  const legacy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  legacy.state = GameState.Bidding;
  legacy.bidPhase = bidPhase;
  await redisDouble.set(`game:session:${roomCode}`, JSON.stringify(legacy));
}

/** 新实例 = 空缓存 ⇒ `getSession`/`loadSession` 必走 redis（迁移的唯一入口）。 */
const freshService = (): GameService => new GameService(redisDouble as unknown as Redis);

describe('片① R1：随机源注入覆盖全部 4 个调用点', () => {
  let service: GameService;
  /** 注入源的调用计数 —— 「漏传」在它面前是确定性红（不是 1/3 概率的 flaky）。 */
  let randomCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    randomCalls = 0;
    // 恒 0.9 ⇒ 起始座位 = floor(0.9 * 3) = 2（规格 §5.2 的注入范式）
    service.random = () => {
      randomCalls += 1;
      return 0.9;
    };
    /*
     * §9.4 的两个注入缝（`game.robot.test.ts:60-68` 的既有写法）：
     *  - 0 思考延迟：否则每次机器人决策真等 1–3s（基础手速 ±300ms），而 `waitForPlaying` 是
     *    **微任务刻度**的轮询（见上）—— 驱动环一旦 await 真定时器，轮询就先耗尽上界。
     *  - `robot.decide` 替身：叫抢期恒 pass（片① R3），**绝不真发网络**；
     *    同时避免 `robotClient === null` 的 fail-loud 分支给每次机器人回合刷 ERROR 日志
     *    （那条日志是装配缺陷的信号，不该被本用例当正常噪声刷掉）。
     */
    service.robotDelay = async () => {};
    service.robotJitterRandom = () => 0.5; // 与 random 分离；此处固定以消除无关随机
    service.robotClient = {
      decide: async () => ({ kind: 'pass', source: 'douzero' }),
    } as never;
  });

  it('startGame 用注入的 random（createSession 调用点 :215）', async () => {
    await service.startGame({ roomCode: 'RND1', baseScore: 100, players: humans });
    const s = await service.getSnapshot('RND1');
    expect(s!.bidPhase.currentBidder).toBe(2);
    // 注入函数**确实**被调用过（若 :215 没传 `this.random` ⇒ 计数 0 ⇒ 确定性红）
    expect(randomCalls).toBe(1);
  });

  it('🔴 机器人驱动链的流局重摇也吃注入的 random（自由函数里的 handleBid 调用点 :781）', async () => {
    // 三机器人房 ⇒ 叫抢恒 pass（片① R3）⇒ 三轮全不叫 ⇒ `resetBidding` 与
    // 「第 3 次流局随机指定地主」都会走 `applyDecisionToSession` → `handleBid`（:781）。
    // 若那一处漏传 `this.random` ⇒ 座位断言会**flaky 地红**（座位变成真随机），
    // 而下面的计数断言会**确定**地红（那 3 次消费根本不会经过注入源）。
    await service.startGame({
      roomCode: 'RND2',
      baseScore: 100,
      players: [
        { id: 'p_a', seat: 0, isRobot: true, botId: 'bot-a', skillLevel: 'beginner' },
        { id: 'p_b', seat: 1, isRobot: true, botId: 'bot-b', skillLevel: 'beginner' },
        { id: 'p_c', seat: 2, isRobot: true, botId: 'bot-c', skillLevel: 'beginner' },
      ],
    });
    const s = await waitForPlaying(service, 'RND2');
    expect(s.players.findIndex((p) => p.isLandlord)).toBe(2); // floor(0.9 * 3)
    // 消费账（规格 §5.2）：createSession 1 次（`:215`）+ 两次流局重摇 + 一次随机指定地主
    //（后三次全经自由函数 `:781`）。漏传任何一处 ⇒ 计数对不上 ⇒ 本断言确定性红。
    expect(randomCalls).toBe(4);
  });

  it('人类三拍全不叫：流局重摇与「第 3 次流局指定地主」都吃注入的 random（bid() 闭包调用点 :322）', async () => {
    await service.startGame({ roomCode: 'RND3', baseScore: 100, players: humans });
    // 起始座位 2（createSession 吃 0.9）⇒ 每轮的行动顺序恒为 2 → 0 → 1
    for (let round = 0; round < 3; round += 1) {
      await service.bid('RND3', 'user-3', false);
      await service.bid('RND3', 'user-1', false);
      await service.bid('RND3', 'user-2', false);
    }
    const s = await service.getSnapshot('RND3');
    expect(s!.state).toBe(GameState.Playing);
    expect(s!.players.findIndex((p) => p.isLandlord)).toBe(2); // floor(0.9 * 3)
    // 1（startGame）+ 两次重摇 + 一次指定地主（后三次经 `bid()` 闭包）
    expect(randomCalls).toBe(4);
  });
});

describe('片① R1：onTurnTimeout 也叫注入的 random（超时链调用点 :709）', () => {
  let service: GameService;
  let randomCalls: number;

  beforeEach(() => {
    // 假计时器 + 推进 30s —— `game.timer.test.ts` 的既有写法（超时链是唯一触发方式）
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    randomCalls = 0;
    service.random = () => {
      randomCalls += 1;
      return 0.9;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('叫抢三拍依次超时（全不叫）⇒ 流局重摇起始座位走注入源，不走真随机', async () => {
    await service.startGame({ roomCode: 'RND4', baseScore: 100, players: humans });
    expect((await service.getSession('RND4'))!.bidPhase.currentBidder).toBe(2);

    // 座位 2 → 0 → 1 依次超时（每拍重挂 30s）⇒ 第 3 拍触发流局重发
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession('RND4'))!;
    expect(after.state).toBe(GameState.Bidding);
    expect(after.bidPhase.redealCount).toBe(1);
    expect(after.bidPhase.currentBidder).toBe(2); // 重摇后 = floor(0.9 * 3)
    // 1 = startGame · 1 = 流局重摇（经超时链）—— 漏传 ⇒ 计数 1 ⇒ 确定性红
    expect(randomCalls).toBe(2);
  });
});

describe('片① §7.1：老会话迁移', () => {
  let service: GameService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
  });

  it('有 decisions 的老会话：firstCaller = 第一条 grab=true 的座位', async () => {
    await seedLegacySession(service, 'MIG1', {
      currentBidder: 2,
      landlordCaller: 1,
      landlordCandidate: 1,
      bidPasses: 0,
      grabActions: 2,
      bidMultiplier: 4,
      redealCount: 0,
      decisions: [
        { seat: 0, kind: 'call', grab: true },
        { seat: 1, kind: 'rob', grab: true },
      ],
    });
    const fresh = freshService();
    const migrated = (await fresh.loadSession('MIG1'))!;
    expect(migrated.bidPhase.firstCaller).toBe(0); // 第一条 grab 的座位（**不是** landlordCandidate）
    expect(migrated.bidPhase.antiRobGranted).toBe(false); // grabActions = 2 < 3

    // 行为面：第 3 拍（座位 2 不抢）⇒ 两个声称者 ⇒ 反抢派回 firstCaller = 0。
    // （若迁移没写 firstCaller，这里会派给 undefined ⇒ 停摆。）
    const after = await fresh.bid('MIG1', 'user-3', false);
    expect(after.state).toBe(GameState.Bidding);
    expect(after.bidPhase.antiRobGranted).toBe(true);
    expect(after.bidPhase.currentBidder).toBe(0);
  });

  it('已走满 3 拍的老会话：antiRobGranted = true（⇒ 不派发反抢）', async () => {
    await seedLegacySession(service, 'MIG2', {
      currentBidder: 0,
      landlordCaller: 1,
      landlordCandidate: 1,
      bidPasses: 1,
      grabActions: 3,
      bidMultiplier: 4,
      redealCount: 0,
      decisions: [
        { seat: 0, kind: 'call', grab: true },
        { seat: 1, kind: 'rob', grab: true },
        { seat: 2, kind: 'rob', grab: false },
      ],
    });
    const migrated = (await freshService().loadSession('MIG2'))!;
    expect(migrated.bidPhase.firstCaller).toBe(0); // 第一条 grab 的座位
    // grabActions >= 3 ⇒ 反抢帧「已用过/已作废」⇒ 阈值抬到 4，**不再派发**反抢
    expect(migrated.bidPhase.antiRobGranted).toBe(true);
  });

  it('🔴 负例：decisions **整个缺失** + 中途房 ⇒ firstCaller = landlordCandidate（**不得**是 -1）', async () => {
    // 协议⑦ 之前的会话连 `decisions` 都没有（本仓有「常驻容器是旧镜像」的前科）。
    await seedLegacySession(service, 'MIG3', {
      currentBidder: 2,
      landlordCaller: 0,
      landlordCandidate: 0,
      bidPasses: 1,
      grabActions: 2,
      bidMultiplier: 2,
      redealCount: 0,
      // ⚠️ 没有 decisions 字段 —— 这正是本负例的要害
    });
    const fresh = freshService();
    const migrated = (await fresh.loadSession('MIG3'))!;
    // 落到 -1 ⇒ 第 3 拍会「必然误触发反抢」⇒ currentBidder = -1 ⇒ 房间永久停摆（规格 §7.1）
    expect(migrated.bidPhase.firstCaller).toBe(0); // = landlordCandidate，**不是** -1

    // 行为面：单声称者 ⇒ 不派发反抢 ⇒ 第 3 拍直接定地主（座位 0）——
    // 「载入后 currentBidder 绝不可能是 -1」。
    const after = await fresh.bid('MIG3', 'user-3', false);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[0]!.isLandlord).toBe(true);
    expect(after.bidPhase.currentBidder).not.toBe(-1);
  });
});
