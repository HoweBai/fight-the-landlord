/**
 * §9.4 / R208：**服务端驱动机器人回合**。
 *
 * 判据（计划 Task 6，全部结构性：假计时器 + `robotClient` 替身 + 0 延迟注入）：
 *  ① 轮到机器人 ⇒ **不推进 30s** 就产生一次状态转移（旧实现：`version` 卡住直到 30s 超时）；
 *  ② DouZero 返回非法牌 ⇒ 同一次转移里改用规则引擎结果且**不是** pass；
 *     正对照：DouZero 返回合法牌 ⇒ 采用它（规则引擎本会给出别的牌，因此这条有判别力）；
 *  ③ 机器人动作走**与人类完全相同**的校验链（用「不在手中的牌」断言它被拒并回退）；
 *  ④ 三个机器人**串行**（按分派序号断言，不用墙钟）；
 *  ⑤ 思考延迟 = 基础手速 ±300ms（可注入）、先等后决策、计入 30s 且**不顺延** `turnDeadlineAt`。
 *  ⑥ 第三条决策路径（decide 失败 / 动作被规则拒 ⇒ game-service 规则引擎兜底，
 *     **不经 robot-service**）的两条 warn 带可归因标记（片② D10/J25）：
 *     `fallback=game-service-rule` + `reason=decide-failed|action-rejected`（捕获 sink 自证）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  GameState,
  createSession,
  dealCards,
  createCapturingSink,
  createRedactingLogger,
} from '@fight-the-landlord/shared';
import type { Card, RobotDecideRequest, RobotDecideResponse } from '@fight-the-landlord/protocol';
import { GameService } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

/**
 * R696：牌是 `{r, s}`。本文件的夹具只关心点数，故 `s` 取 0。
 * ⚠️ `RobotDecideResponse.cards` **仍是** `number[]`（AI 契约，spec §4）——
 * 它是**点数**不是牌，下面的 `cards: [17]` / `cards: [9]` 那几处**不是** `Card[]`。
 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 三人**全是机器人**的开局 DTO（`botId` + `skillLevel` + `thinkingSpeed` 由 room-service 透传，§9.6 第 4 条）。 */
const robotDto = (roomCode: string, thinkingSpeed = 2000) => ({
  roomCode,
  baseScore: 100,
  players: [0, 1, 2].map((seat) => ({
    id: `p_bot${seat}`,
    seat,
    isRobot: true,
    botId: `bot-${seat}`,
    skillLevel: 'beginner' as const,
    thinkingSpeed,
  })),
});

/** 只冲微任务/0ms 定时器 —— **绝不**推进 30s（那正是判据 ① 要区分的）。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

describe('§9.4 机器人回合驱动（R208）', () => {
  let service: GameService;
  /** `robot.decide` 替身的调用记录。 */
  let decideCalls: RobotDecideRequest[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致。
    // 文件级统一注入（`playingFixture` 与用例 ④ 的叫抢推进都吃它）。
    service.random = () => 0;
    // §9.4 的两个注入缝：0 思考延迟 + 决策替身（**绝不真发网络**）
    service.robotDelay = async () => {};
    decideCalls = [];
    service.robotClient = {
      decide: async (req: RobotDecideRequest): Promise<RobotDecideResponse | null> => {
        decideCalls.push(req);
        return { kind: 'pass', source: 'douzero' };
      },
    } as never;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('① 轮到机器人 ⇒ 不推进 30s 就产生状态转移（旧实现要等 30s 超时）', async () => {
    const started = await service.startGame(robotDto('ROOM-R1'));
    const before = (await service.getSession('ROOM-R1'))!;
    expect(before.version).toBe(started.version);

    await flush(); // ⚠️ 这里**没有** advanceTimersByTime(30_000)

    const after = (await service.getSession('ROOM-R1'))!;
    // 旧实现下 version 会一直等于 before.version，直到 30s 超时才 +1
    expect(after.version).toBeGreaterThan(before.version);
    // 机器人动作同样计入 version 与状态转移，与人类无差别（§9.4）
    expect(after.actionLog?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * 造一个「**只有座位 0 是机器人**、正在跟单张 5」的出牌阶段会话（不依赖随机发牌）。
   *
   * ⚠️ 座位 1/2 必须是人类：否则 `driveRobotTurn` 会**继续**驱动后面的机器人，
   * 最后落盘的 `lastPlayedHand` 就不是座位 0 的那一手了（判据会指向别人，实测踩过）。
   */
  async function playingFixture(roomCode: string, hand: Card[]) {
    const dto = {
      roomCode,
      baseScore: 100,
      players: [
        { id: 'p_bot0', seat: 0, isRobot: true, botId: 'bot-0', skillLevel: 'beginner' as const },
        { id: 'human-1', seat: 1, isRobot: false },
        { id: 'human-2', seat: 2, isRobot: false },
      ],
    };
    await service.startGame(dto);
    await flush();
    const base = (await service.getSession(roomCode))!;
    service['cache'].set(roomCode, {
      ...base,
      state: GameState.Playing,
      currentPlayer: 0,
      lastPlayerIdx: 2,
      lastPlayedHand: { cards: h(5), type: 1, keyRank: 5, length: 0 },
      playPhase: { ...base.playPhase, consecutivePasses: 0 },
      actionLog: [],
      players: base.players.map((p) => (p.seat === 0 ? { ...p, hand: [...hand] } : p)),
    });
    decideCalls = [];
    return (await service.getSession(roomCode))!;
  }

  it('② DouZero 返回**不在手里**的牌 ⇒ 回退规则引擎（不是 pass），且走人类的校验链', async () => {
    await playingFixture('ROOM-R2', h(5, 6, 9));
    // DouZero 给出一张手里没有的牌（17 = 2）：必须被 `handlePlayCards` 拒绝
    service.robotClient = {
      decide: async (req: RobotDecideRequest) => {
        decideCalls.push(req);
        return { kind: 'play', cards: [17], source: 'douzero' } as RobotDecideResponse;
      },
    } as never;

    await service['driveRobotTurn']('ROOM-R2');
    const after = (await service.getSession('ROOM-R2'))!;

    // 规则引擎对「跟单张 5」的最小可压是 6（手牌 5,6,9）
    expect(after.lastPlayedHand!.cards).toEqual(h(6));
    expect(after.playPhase.consecutivePasses).toBe(0); // **不是** pass（C9/§9.4）
    expect(after.players[0]!.hand).toEqual(h(5, 9)); // 非法的那张没有从手里消失
  });

  it('②′ 正对照：DouZero 返回**合法**牌 ⇒ 采用它（规则引擎本会给 6，因此这条有判别力）', async () => {
    await playingFixture('ROOM-R3', h(5, 6, 9));
    service.robotClient = {
      decide: async (req: RobotDecideRequest) => {
        decideCalls.push(req);
        return { kind: 'play', cards: [9], source: 'douzero' } as RobotDecideResponse;
      },
    } as never;

    await service['driveRobotTurn']('ROOM-R3');
    const after = (await service.getSession('ROOM-R3'))!;

    // 9 是 DouZero 的选择；规则引擎在同一局面会给 6 ⇒ 打出 9 证明走的是决策结果
    expect(after.lastPlayedHand!.cards).toEqual(h(9));
    expect(after.players[0]!.hand).toEqual(h(5, 6));
  });

  it('②″ robot.decide 失败（超时/HTTP 错 ⇒ null）⇒ 规则引擎结果，不是 pass', async () => {
    await playingFixture('ROOM-R5', h(5, 6, 9));
    service.robotClient = { decide: async () => null } as never;

    await service['driveRobotTurn']('ROOM-R5');
    const after = (await service.getSession('ROOM-R5'))!;

    expect(after.lastPlayedHand!.cards).toEqual(h(6));
    expect(after.playPhase.consecutivePasses).toBe(0);
  });

  it('④ 三个机器人**串行**（在飞的 decide 至多 1 个；三席都被驱动过）', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    service.robotClient = {
      decide: async (req: RobotDecideRequest) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(req.botId);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return null; // 失败 ⇒ 规则引擎（叫抢阶段 = 不抢）
      },
    } as never;

    await service.startGame(robotDto('ROOM-R4'));
    await flush();

    expect(maxInFlight).toBe(1); // 串行：任何时刻至多一个在飞的决策
    // 顺序断言**确定成立**（片① 修复轮恢复 —— 它被 Task 6 误删过一次）：`beforeEach` 注入
    // `random = () => 0` ⇒ 叫抢起始座位 = `Math.floor(0 * 3)` = **0**（`createSession` /
    // `resetBidding` 同此）⇒ 叫抢阶段每家恒 pass（R3）且无人声称（⇒ 无从派发反抢）
    // ⇒ 前三次决策必然是座位 0 → 1 → 2 的三个机器人。
    // ⚠️ 「起始座位不确定」只存在于**生产**（`Math.random`）；本夹具已注入消除 ——
    // 别再以 R1 为由删这条。
    expect(order.slice(0, 3)).toEqual(['bot-0', 'bot-1', 'bot-2']);
    // 三席都决策过 —— 覆盖**整局**（不止前三拍）
    expect(new Set(order).size).toBe(3);
    // 服务端把**整局**驱动到了终局（片① 修复轮：替掉旧的「总数 ≤ 174」上界 —— 实测
    // order.length 60–78，那上界松到只挡得住死循环）。`flush()` 会把整局跑完 ⇒ 假计时器下
    // 没有任何时钟推进、也没有客户端输入，能把状态推到 `Ended` 的**只有**驱动链本身
    // ⇒ 驱动链中途停摆/卡死这条必红（上界断言的形态做不到这一点）。
    const after = (await service.getSession('ROOM-R4'))!;
    expect(after.state).toBe(GameState.Ended);
    // 全机器人桌不会卡在 30s 上：机器人自己把叫抢推完了
    expect(after.version).toBeGreaterThan(1);
  });

  it('⑤ 思考延迟 = 基础手速 ± 300ms、先等后决策、计入 30s 且**不顺延** turnDeadlineAt（§9.4）', async () => {
    const delays: number[] = [];
    const events: string[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
      events.push('delay');
    };
    const originalDecide = service.robotClient!.decide.bind(service.robotClient);
    service.robotClient!.decide = async (req: RobotDecideRequest) => {
      events.push('decide');
      return originalDecide(req);
    };
    service.robotJitterRandom = () => 0.5; // jitter = 0 ⇒ 恰为基础手速

    await service.startGame(robotDto('ROOM-R6', 2000));
    await flush();

    const after = (await service.getSession('ROOM-R6'))!;
    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBe(2000);
    // J6：先延迟、后决策（顺序不可颠倒）
    expect(events.slice(0, 2)).toEqual(['delay', 'decide']);
    // ⚠️ 判据：延迟**不得**加到 deadline 上（假计时器下 Date.now() 冻结 ⇒ 恰好 30000）
    expect((after.turnDeadlineAt ?? 0) - Date.now()).toBe(30_000);
  });

  it('⑤b 抖动下界：jitterRandom 0 ⇒ base−300', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0;

    await service.startGame(robotDto('ROOM-R6L', 2000));
    await flush();
    expect(delays[0]).toBe(1700);
  });

  it('⑤b2 抖动上界：jitterRandom 1 ⇒ base+300', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 1;

    await service.startGame(robotDto('ROOM-R6H', 2000));
    await flush();
    expect(delays[0]).toBe(2300);
  });

  it('⑤c 越界基础手速被夹到 1000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    await service.startGame(robotDto('ROOM-R6C', 400));
    await flush();
    expect(delays[0]).toBe(1000);
  });

  it('⑤d game.start 载荷缺 thinkingSpeed ⇒ 默认 2000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    const dto = robotDto('ROOM-R6D');
    for (const p of dto.players) delete (p as { thinkingSpeed?: number }).thinkingSpeed;
    await service.startGame(dto);
    await flush();
    expect(delays[0]).toBe(2000);
  });

  it('⑤e 上界夹取：2990 + 300 ⇒ 3000', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 1;

    await service.startGame(robotDto('ROOM-R6E', 2990));
    await flush();
    expect(delays[0]).toBe(3000);
  });

  it('⑤f 旧会话（Redis JSON 无 botThinkingSpeeds 键）⇒ 默认 2000ms，不崩', async () => {
    const delays: number[] = [];

    // 构造一份升级前写出的会话：**没有** botThinkingSpeeds 键
    const baseSession = createSession('ROOM-OLD', ['p_bot0', 'p_bot1', 'p_bot2'], () => 0, 100);
    baseSession.botIds = ['bot-0', 'bot-1', 'bot-2'];
    baseSession.botSkillLevels = ['beginner', 'beginner', 'beginner'];
    const oldSession = { ...dealCards(baseSession), turnDeadlineAt: Date.now() + 30_000 };
    expect('botThinkingSpeeds' in oldSession).toBe(false);
    await redisDouble.set('game:session:ROOM-OLD', JSON.stringify(oldSession));

    // 新实例强制走 Redis（不命中 service 的内存 cache）
    const fresh = new GameService(redisDouble as unknown as Redis);
    fresh.random = () => 0;
    fresh.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    fresh.robotJitterRandom = () => 0.5;
    fresh.robotClient = {
      decide: async (): Promise<RobotDecideResponse> => ({ kind: 'pass', source: 'douzero' }),
    } as never;

    await fresh['driveRobotTurn']('ROOM-OLD');

    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBe(2000);
    expect((await fresh.getSession('ROOM-OLD'))!.version).toBeGreaterThan(oldSession.version);
  });

  it('⑤g 基础手速按座位索引（座位 0/1/2 = 1000/2000/2990）', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    const dto = robotDto('ROOM-R6G');
    dto.players[0]!.thinkingSpeed = 1000;
    dto.players[1]!.thinkingSpeed = 2000;
    dto.players[2]!.thinkingSpeed = 2990;
    await service.startGame(dto);
    await flush();

    // 叫抢起始座位 = floor(random(=0) * 3) = 0 ⇒ 前三拍依次是座位 0 → 1 → 2（用例 ④ 同款判据）
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 2990]);
  });

  it('⑤h 每回合重新抖动，且每一手决策前恰好一次延迟', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    const seq = [0, 1, 0, 1];
    service.robotJitterRandom = () => seq.shift() ?? 0.5;

    await service.startGame(robotDto('ROOM-R6H2', 2000));
    await flush();

    expect(delays.length).toBeGreaterThan(3);
    expect(delays.slice(0, 4)).toEqual([1700, 2300, 1700, 2300]);
    // 整局驱动期间：延迟次数 === 决策次数 ⇒ 挡住「整局只抽一次抖动 / 只延迟第一手」
    expect(delays.length).toBe(decideCalls.length);
  });

  it('⑤i 非有限基础手速（NaN）⇒ 默认 2000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    await service.startGame(robotDto('ROOM-R6I', Number.NaN));
    await flush();
    expect(delays[0]).toBe(2000);
  });

  // ── ⑥ 片② D10/J25：第三条决策路径的日志（兜底**不经 robot-service**，标记是唯一可归因凭据）──

  it('片② D10/J25：robot.decide 失败时日志带 fallback=game-service-rule', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'game-service' }));

    await playingFixture('ROOM-R7', h(5, 6, 9));
    service.robotClient = { decide: async () => null } as never; // 既有范式：RPC 超时/HTTP 错 ⇒ null

    await service['driveRobotTurn']('ROOM-R7');
    const after = (await service.getSession('ROOM-R7'))!;

    // 反空测：兜底**真的**执行了（规则引擎的 6 落了地）—— 否则「没有日志」可能只是驱动没跑
    expect(after.lastPlayedHand!.cards).toEqual(h(6));
    expect(after.playPhase.consecutivePasses).toBe(0);
    expect(
      records.some(
        (r) =>
          r.msg.includes('fallback=game-service-rule') && r.msg.includes('reason=decide-failed'),
      ),
    ).toBe(true);
  });

  it('片② D10/J25：动作被规则拒时那条既有 warn 带上 reason=action-rejected', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'game-service' }));

    await playingFixture('ROOM-R8', h(5, 6, 9));
    // 既有范式（本文件用例 ②）：DouZero 回**不在手里的牌** ⇒ 必被人类的校验链拒绝
    service.robotClient = {
      decide: async () =>
        ({ kind: 'play', cards: [17], source: 'douzero' }) as RobotDecideResponse,
    } as never;

    await service['driveRobotTurn']('ROOM-R8');
    const after = (await service.getSession('ROOM-R8'))!;

    // 反空测：拒绝与回退**真的**发生了 —— 非法牌没落地（手牌只剩 5,9 且打出的是 6）
    expect(after.lastPlayedHand!.cards).toEqual(h(6));
    expect(after.playPhase.consecutivePasses).toBe(0); // 回退**不是** pass（C9/§9.4）
    expect(after.players[0]!.hand).toEqual(h(5, 9));
    expect(
      records.some(
        (r) =>
          r.msg.includes('Robot action rejected') && r.msg.includes('reason=action-rejected'),
      ),
    ).toBe(true);
    // 修复轮：catch 吞掉 err（`return false`）⇒ 这一行是拒绝原因的**唯一**落点 ——
    // `: ${String(err)}` 尾缀被删是观测退化，故钉住「`: <原因> (fallback=`」的形状
    expect(
      records.some(
        (r) => r.msg.includes('Robot action rejected') && /: .+ \(fallback=/.test(r.msg),
      ),
    ).toBe(true);
  });
});
