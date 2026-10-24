/**
 * C9 / R206：`robot.decide` 的决策链 —— DouZero 失败/非法**必须回退规则引擎**，不是 pass。
 *
 * 全部判据都用 **`DouZeroClient` 替身**（不发网络）+ 可注入的 0 随机源 + 0 延迟：
 * 单测不得真连 DouZero（环境事实：本机不保证有 `douzero:2021`）。
 *
 * 判据（计划 Task 4 的五条）：
 *  ① DouZero 返回合法牌 ⇒ `source: 'douzero'`；
 *  ② DouZero 抛错 ⇒ 规则引擎（`source: 'rule'`，**不是** pass —— 旧实现直接 pass，
 *     RED 原文 `expected 'pass' to be 'play'`）；
 *  ③ DouZero 返回空数组 ⇒ `kind: 'pass'`（协议约定：空数组 = 明确 pass，**不**降级）；
 *  ④ ~~规则引擎无解 ⇒ pass~~ **已翻**（片② D1/J1）：beginner 不再直落规则引擎 —— 三档
 *     **一律**先走 DouZero，`model` 随 `skillLevel` 逐档下发（`sl`/`douzero_WP`/`douzero_ADP`）；
 *     修复轮（修点 3）：**pass/rule 终态恢复直接判据** ——「DouZero 失败 + 规则引擎无解
 *     ⇒ pass（source=rule）」，见 ②′ 后的用例（生产上它是「DouZero 挂 + 压不过」的保底路径）；
 *  ⑤ `/api/robots/decide` 无 `X-Internal-Token` ⇒ 401 + `10002`。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Card, PlayerView, RobotDecideRequest, DdzRobotFeatures } from '@fight-the-landlord/protocol';
import { BotPlayer } from '../src/robot/bot.player';
import { RobotService } from '../src/robot/robot.service';
import type { RobotPool } from '../src/robot/robot.pool';
import type { DouZeroClient } from '../src/robot/douzero.client';
import type { DouZeroHealth } from '../src/robot/douzero.health';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * R696：**两类夹具要分清**——
 *  - `PlayerView.hand` / `bottomCards` 是 `Card[]`（`asCards(...)`）；
 *  - `DouZeroContext.hand` 与 `RobotDecideResponse.cards` **仍是 `number[]`**
 *    （rank-only 的 AI 契约，spec §4）。
 */
const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/** 裁剪视图夹具（座位 0 = 地主，手牌 [5,6,9]；窗口里是座位 2 刚出的单张 7）。 */
function view(over: Partial<PlayerView> = {}): PlayerView {
  return {
    roomCode: 'ROOM1',
    version: 3,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: asCards([5, 6, 9]),
    cardCounts: [3, 2, 2],
    // 挂机治理片（C25）：`PlayerView.trustees` 三元组（本夹具全 false——治理态与决策输入无关）
    trustees: [false, false, false],
    bottomCards: asCards([12, 13, 14]),
    landlordSeat: 0,
    currentPlayer: 0,
    // 协议 ④：旧 `lastPlayedHand` + `lastPlayerIdx`（座位 2 出的单张 7）→ 窗口里的显式一项。
    // ⚠️ 窗口只带**牌面**；跟牌目标的 `type`/`keyRank`/`length` 不在这里（见 `features.lastMoveMeta`，Task A3）。
    recentActions: [{ seat: 2, cards: asCards([7]) }],
    turnDeadlineAt: 0,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 1,
      landlordCandidate: 0,
      grabActions: 3,
      redealCount: 0,
      kind: 'rob',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
    ...over,
  };
}

function features(over: Partial<DdzRobotFeatures> = {}): DdzRobotFeatures {
  return {
    position: 'landlord',
    lastMove: [7],
    lastMovePosition: 'landlord_up',
    // 协议 ④：跟牌目标（旧 `view.lastPlayedHand` 的规则字段）现在走这里 —— 座位 2 出的单张 7。
    lastMoveMeta: { type: 1, keyRank: 7, length: 0 },
    numCardsLeft: { landlord: 3, landlord_down: 2, landlord_up: 2 },
    playedCards: { landlord: [], landlord_down: [], landlord_up: [7] },
    actionSeq: [[7]],
    ...over,
  };
}

function request(over: Partial<RobotDecideRequest> = {}): RobotDecideRequest {
  return {
    roomCode: 'ROOM1',
    botId: 'bot-1234abcd',
    skillLevel: 'advanced',
    view: view(),
    features: features(),
    ...over,
  };
}

function makePlayer(getMove: (ctx: unknown) => Promise<number[]>) {
  const client = { getMove: vi.fn(getMove) } as unknown as DouZeroClient;
  // 片⑦ E4：模型装配读 ConfigCache（桩缺省 = `models.ts` 的真映射 ⇒ 三档断言语义不变）
  const bot = new BotPlayer(client, asConfigCache(makeConfigCache()));
  bot.random = () => 1; // 永不「失误」（叫抢判据用得到）
  return { bot, client };
}

describe('robot.decide —— §9.3 双轨 + C9 降级链（R206）', () => {
  it('① DouZero 返回合法牌 ⇒ source: douzero', async () => {
    const { bot } = makePlayer(async () => [9]);

    const result = await bot.decide(request());

    expect(result).toEqual({ kind: 'play', cards: [9], source: 'douzero' });
  });

  it('② DouZero 抛错 ⇒ 回退**规则引擎**（不是 pass —— C9 的核心判据）', async () => {
    const { bot } = makePlayer(async () => {
      throw new Error('DouZero HTTP 500');
    });

    const result = await bot.decide(request());

    // 旧实现（`bot.player.ts:54-58`）在这里返回 `{ pass: true }` ⇒ 白送回合。
    // RED 原文：`expected 'pass' to be 'play'`。
    expect(result.kind).toBe('play');
    expect(result.source).toBe('rule');
    // §9.1 ①：跟单张 7 ⇒ 最小可压单张 9（手牌 5,6,9）
    expect(result.cards).toEqual([9]);
  });

  it('②′ DouZero 返回**不在手里**的牌 ⇒ 同样回退规则引擎（明显非法动作）', async () => {
    const { bot } = makePlayer(async () => [17]); // 手牌是 [5,6,9]，没有 17

    const result = await bot.decide(request());

    expect(result).toEqual({ kind: 'play', cards: [9], source: 'rule' });
  });

  it('片② D1/J1：DouZero 失败且规则引擎无解 ⇒ pass（source=rule）', async () => {
    // ⚠️ 与本 brief 括注的**一处必要偏差**（红态实测为证）：默认夹具 [5,6,9] 对单张 7
    // **压得过**（最小可压 9 —— 正是 ②/②′ 断言的 `[9]`，lit-brief 实测收到的就是
    // `{ kind: 'play', cards: [9], source: 'rule' }`）⇒ 根本打不到 pass 终态。
    // 要让规则引擎**必然无解**：把跟牌目标抬到手牌之上（单张 11；手中无炸弹/王炸），
    // 窗口（recentActions）与 meta 同步抬高、其余夹具不动。生产等价场景 =「DouZero 失败 + 压不过」。
    const client = { getMove: vi.fn(async (_ctx: unknown) => { throw new Error('boom'); }) };
    const player = new BotPlayer(client as unknown as DouZeroClient, asConfigCache(makeConfigCache()));

    await expect(
      player.decide(
        request({
          skillLevel: 'intermediate',
          view: view({ recentActions: [{ seat: 2, cards: asCards([11]) }] }),
          features: features({ lastMove: [11], lastMoveMeta: { type: 1, keyRank: 11, length: 0 } }),
        }),
      ),
    ).resolves.toEqual({ kind: 'pass', source: 'rule' });
  });

  it('③ DouZero 返回空数组 ⇒ pass（协议约定：空数组是明确的 pass，不降级）', async () => {
    const { bot } = makePlayer(async () => []);

    const result = await bot.decide(request());

    expect(result).toEqual({ kind: 'pass', source: 'douzero' });
  });

  it('片② D1/J1：beginner 也走 DouZero，且带 model=sl', async () => {
    const client = { getMove: vi.fn(async (_ctx: unknown) => [5]) }; // ⚠️ 形参不能省：`mock.calls[0][0]` 才不报 TS2493
    const player = new BotPlayer(client as unknown as DouZeroClient, asConfigCache(makeConfigCache()));

    const res = await player.decide(request({ skillLevel: 'beginner' }));

    expect(client.getMove).toHaveBeenCalledTimes(1);
    expect((client.getMove.mock.calls[0][0] as { model: string }).model).toBe('sl');
    expect(res).toEqual({ kind: 'play', cards: [5], source: 'douzero' });
  });

  it('片② D1/J1：advanced 带 model=douzero_ADP；intermediate 带 douzero_WP', async () => {
    for (const [level, model] of [['intermediate', 'douzero_WP'], ['advanced', 'douzero_ADP']] as const) {
      const client = { getMove: vi.fn(async (_ctx: unknown) => [5]) };
      const player = new BotPlayer(client as unknown as DouZeroClient, asConfigCache(makeConfigCache()));
      await player.decide(request({ skillLevel: level }));
      expect((client.getMove.mock.calls[0][0] as { model: string }).model).toBe(model);
    }
  });

  /**
   * **片⑦ E4（r1 计划审查 X-3 的落点判据）**：`modelBySkill` 必须接在**决策路径**
   * （`buildDouZeroContext` 组装发给 DouZero 的请求）而不是日志行 —— 否则 /admin 改键后
   * 「模型不随动而日志字面变化」（静默无效）。
   *
   * 判别力：桩返回**自定义映射**（三档都指 douzero_ADP）⇒ getMove 收到的 ctx.model
   * 必须随动；读常量/读日志侧的实现在这里红。
   */
  it('片⑦ E4：决策路径读 ConfigCache —— /admin 改 robot.modelBySkill 后发给 DouZero 的 model 随动', async () => {
    const cache = makeConfigCache();
    cache.modelBySkill.mockReturnValue({
      beginner: 'douzero_ADP', intermediate: 'douzero_ADP', advanced: 'douzero_ADP',
    });
    const client = { getMove: vi.fn(async (_ctx: unknown) => [5]) };
    const player = new BotPlayer(client as unknown as DouZeroClient, asConfigCache(cache));

    await player.decide(request({ skillLevel: 'beginner' })); // 种子下 = sl；改键后必须随动

    expect((client.getMove.mock.calls[0][0] as { model: string }).model).toBe('douzero_ADP');
    expect(cache.modelBySkill).toHaveBeenCalled();
  });

  it('DouZero 收到的特征**只来自请求**（C7/C8/§9.5：不再从牌堆反推）', async () => {
    const captured: unknown[] = [];
    const { bot } = makePlayer(async (ctx) => {
      captured.push(ctx);
      return [9];
    });

    await bot.decide(
      request({ features: features({ playedCards: { landlord: [3], landlord_down: [], landlord_up: [7] } }) }),
    );

    const ctx = captured[0] as { playedCards: Record<string, number[]>; hand: number[] };
    expect(ctx.playedCards).toEqual({ landlord: [3], landlord_down: [], landlord_up: [7] });
    // 手牌来自 `view.hand`，且**不得**再补底牌（C15/R101）
    expect(ctx.hand).toEqual([5, 6, 9]);
  });

  it('片① R3：叫抢阶段机器人**既不叫也不抢** ⇒ 恒 pass（不调 DouZero）', async () => {
    const { bot, client } = makePlayer(async () => []);
    const bidding = request({
      skillLevel: 'advanced',
      view: view({ state: 'bidding', hand: asCards([17, 20, 30]), recentActions: [] }),
    });

    // 两张王 + 一张 2：旧实现（手牌强度打分 6 ≥ 门槛 3）**必抢** ⇒ 现在**再大的牌也不抢**。
    // 夹具保留、期望反号：判别力从「恰好抢」升级为「恒不抢」（规格 §5.5 / 用户裁决）。
    const result = await bot.decide(bidding);
    expect(result.kind).toBe('pass');
    expect(result.source).toBe('rule');
    expect(client.getMove).not.toHaveBeenCalled();

    const weak = request({
      skillLevel: 'advanced',
      view: view({ state: 'bidding', hand: asCards([3, 4, 5]), recentActions: [] }),
    });
    expect((await bot.decide(weak)).kind).toBe('pass');
  });

  it('RobotService.decide 只转发给 BotPlayer（§4.2 的入口）', async () => {
    const { bot } = makePlayer(async () => [9]);
    // 替身故意只实现本用例用到的子集：`decide` 只碰 `botPlayer`，
    // 池的六个方法（acquire/release/listIdle/reclaimIdle/…）与可用性探测（片② D5）
    // 一个都不会被调到 ⇒ 无法结构性满足 `RobotPool` / `DouZeroHealth` 的类形状。
    const fakePool = {} as unknown as RobotPool;
    // 片⑦ E4：日志行的 model 也随 cache 同步（它不是决策点 —— 决策路径的读点在 BotPlayer）
    const service = new RobotService(
      bot,
      fakePool,
      {} as unknown as DouZeroHealth,
      asConfigCache(makeConfigCache()),
    );

    expect(await service.decide(request())).toEqual({ kind: 'play', cards: [9], source: 'douzero' });
  });
});

/**
 * ⑤ ~~内部凭证：`/api/robots/decide` 不能是「谁都能调」的决策入口（§5.2 规则 3）。~~
 *
 * ⚠️ **本组已随 N20/P4（R218）作废并删除**：`/api/robots/decide` 这条 HTTP 路由
 * **整条不存在了**（改由 §4.2 的 `@MessagePattern(RPC_PATTERNS.robotDecide)` 承载）。
 *
 * **为什么原来这条判据是空测**：它用的是 `helpers/internal-token-harness` 自己挂的一个
 * **假路由**（返回 `{route: PATH}`），与真实的 `RobotController` 毫无关系 ⇒
 * 它证明的是「中间件能拦住一个我自己编的路由」，**不是**「决策入口受保护」。
 * 真实路由被删掉之后它**照样全绿** —— 这正是「测的是自己的脚手架」那一课
 * （切片 7.2 教训第 5 条），也正是它没能抓住「漏删三条 HTTP 路由」的原因。
 *
 * ⇒ 保护决策入口的判据已移到 `robot.rpc.test.ts`：
 *   ① 「三条内部 HTTP 路由不得存在」（锚在真实 `RobotController` 的元数据上，带探针正对照）；
 *   ② 「三条语义仍由 `@MessagePattern` 承载」（证明不是连 RPC 一起删了）。
 *   决策链本身的判据（①②③④）保持不变，见本文件上半部分。
 */
