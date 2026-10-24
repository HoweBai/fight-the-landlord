/**
 * C15 / R101 的**保留半边** + C7/C8 的新半边（R213：夹具从 `GameSession` 改为
 * `RobotDecideRequest{view, features}`，并**删除**对已删伪造函数的断言）。
 *
 * 为什么「不补底牌」值得一条独立用例：这个 `+3` 是**服务端行为**（送进 DouZero 的特征），
 * 出站裁剪（§6.4/§9.8）拦不住它，UI 上也看不出来 —— 只有断言「送给 DouZero 的 hand」
 * 才抓得到。旧实现下地主会拿到 20 + 3 = **23** 张。
 *
 * C8 的旧判据（`computePlayedCards()` 不得双重扣减底牌）**随伪造函数一起删除**：
 * 那些函数已不存在（`test/no-session-boundary.test.ts` 的机械闸钉住这一点），
 * 取而代之的是「DouZero 的 `playedCards` 必须**逐字等于**请求里的 `features.playedCards`」。
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import type { Card, PlayerView, RobotDecideRequest, DdzRobotFeatures } from '@fight-the-landlord/protocol';
import { BotPlayer } from '../src/robot/bot.player';
import type { DouZeroClient } from '../src/robot/douzero.client';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * R696：**两类夹具要分清**——
 *  - `PlayerView.hand` / `bottomCards` 是 `Card[]`（`asCards(...)`）；
 *  - `DouZeroContext.hand` 与 `RobotDecideResponse.cards` **仍是 `number[]`**
 *    （rank-only 的 AI 契约，spec §4）⇒ 下面的 `LANDLORD_HAND` 等原样保留。
 */
const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/** 20 张的「地主手牌」（DouZero 编码；底牌已并入）。 */
const LANDLORD_HAND = [3, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 17, 20, 30];
const FARMER_HAND = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 17, 20, 30, 6];

function view(over: Partial<PlayerView> = {}): PlayerView {
  return {
    roomCode: 'ROOM-BOT',
    version: 5,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: asCards(LANDLORD_HAND),
    cardCounts: [20, 17, 17],
    // 挂机治理片（C25）：`PlayerView.trustees` 三元组（本夹具全 false——治理态与决策输入无关）
    trustees: [false, false, false],
    bottomCards: asCards([12, 13, 14]),
    landlordSeat: 0,
    currentPlayer: 0,
    // 协议 ④：窗口为空（本文件只测出牌轨的「送给 DouZero 的输入」，不测跟牌目标）
    recentActions: [],
    turnDeadlineAt: 0,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 2,
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
    lastMove: [],
    lastMovePosition: '',
    // 协议 ④：本文件的夹具是**首出**（旧 `view.lastPlayedHand: null` 的等价形态）
    lastMoveMeta: null,
    numCardsLeft: { landlord: 20, landlord_down: 17, landlord_up: 17 },
    playedCards: { landlord: [], landlord_down: [], landlord_up: [] },
    actionSeq: [],
    ...over,
  };
}

function request(over: Partial<RobotDecideRequest> = {}): RobotDecideRequest {
  return {
    roomCode: 'ROOM-BOT',
    botId: 'bot-1234abcd',
    skillLevel: 'advanced',
    view: view(),
    features: features(),
    ...over,
  };
}

interface Captured {
  position: string;
  hand: number[];
  bottomCards: number[];
  playedCards: Record<string, number[]>;
  actionSeq: number[][];
}

function makePlayer(getMove: (ctx: unknown) => Promise<number[]>) {
  const captured: Captured[] = [];
  const client = {
    getMove: vi.fn(async (ctx: Captured) => {
      captured.push({
        position: ctx.position,
        hand: [...ctx.hand],
        bottomCards: [...ctx.bottomCards],
        playedCards: {
          landlord: [...(ctx.playedCards.landlord ?? [])],
          landlord_down: [...(ctx.playedCards.landlord_down ?? [])],
          landlord_up: [...(ctx.playedCards.landlord_up ?? [])],
        },
        actionSeq: ctx.actionSeq.map((a) => [...a]),
      });
      return getMove(ctx);
    }),
  } as unknown as DouZeroClient;
  // 片⑦ E4：`BotPlayer` 多了 ConfigCache 依赖（决策路径的 model 装配读它；桩缺省 = 真映射）
  const bot = new BotPlayer(client, asConfigCache(makeConfigCache()));
  bot.random = () => 1; // 永不「失误」：本文件只测出牌轨
  return { bot, captured };
}

describe('BotPlayer —— 地主不再补底牌（C15/R101）', () => {
  it('地主的手牌原样送给 DouZero：20 张，不是 23 张', async () => {
    const { bot, captured } = makePlayer(async () => []); // 空数组 = pass

    await bot.decide(request());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.position).toBe('landlord');
    expect(captured[0]!.hand).toHaveLength(20);
    // 逐位相等（比「长度是 20」强：任何「顺手补牌」都会被打红）
    expect(captured[0]!.hand).toEqual([...LANDLORD_HAND].sort((a, b) => a - b));
    // bottomCards 仍要照传（DouZero 的特征里有它），但它不得再混进 hand
    expect(captured[0]!.bottomCards).toHaveLength(3);
  });

  it('农民的手牌原样送给 DouZero（17 张，一个字节都不加）', async () => {
    const { bot, captured } = makePlayer(async () => []);

    await bot.decide(
      request({
        view: view({ seat: 1, hand: asCards(FARMER_HAND), landlordSeat: 0 }),
        features: features({ position: 'landlord_down' }),
      }),
    );

    expect(captured[0]!.hand).toHaveLength(17);
    expect(captured[0]!.hand).toEqual([...FARMER_HAND].sort((a, b) => a - b));
  });
});

describe('BotPlayer —— 特征来自请求（C7/C8/§9.5）', () => {
  it('DouZero 的 playedCards / actionSeq **逐字**来自 features（不再从牌堆反推）', async () => {
    const { bot, captured } = makePlayer(async () => []);

    await bot.decide(
      request({
        features: features({
          playedCards: { landlord: [3, 3], landlord_down: [], landlord_up: [7] },
          actionSeq: [[3, 3], []],
          lastMove: [7],
          lastMovePosition: 'landlord_up',
        }),
      }),
    );

    expect(captured[0]!.playedCards).toEqual({ landlord: [3, 3], landlord_down: [], landlord_up: [7] });
    expect(captured[0]!.actionSeq).toEqual([[3, 3], []]);
  });
});

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的日志行）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

/**
 * Minor 5（2026-09-28 评审）：`lastMoveMeta` **键缺失**（旧服务的混部 —— 本仓真被
 * 「常驻容器是旧镜像」咬过）与合法的 `null`（首出）在 `??` 兜底里**同形** ⇒ 机器人会
 * **安静地**按首出决策。前者必须能被运维看见：记一条**一次性** WARN。
 *
 * 观测口与 `robot.pool.test.ts` 判据 11 同款：`Logger.overrideLogger` 装捕获 sink。
 */
describe('BotPlayer —— lastMoveMeta 键缺失的一次性告警（Minor 5）', () => {
  /** 摘掉 `lastMoveMeta` 键的 features（= 旧镜像 RPC 载荷的运行时形态）。 */
  function missingLastMoveMeta(): DdzRobotFeatures {
    const f = features();
    delete (f as { lastMoveMeta?: unknown }).lastMoveMeta;
    return f;
  }

  it('键缺失 ⇒ 恰好一条 WARN（第二次不再记）；合法的 null 不告警', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));
    // 片② D1：三档**都**先走 DouZero ⇒ 替身必须**抛错**，决策才会回退到 ruleDecide（一次性 WARN 记在那里）。
    // 替身若返回 `[]`，空数组按协议是「明确 pass」⇒ 不进 ruleDecide ⇒ 本条用例空转。
    const { bot } = makePlayer(async () => {
      throw new Error('boom');
    });
    const broken = request({ skillLevel: 'beginner', features: missingLastMoveMeta() });

    await bot.decide(broken);
    await bot.decide(broken); // 一次性闸：第二次不得再记

    const warns = records.filter((r) => r.msg.includes('lastMoveMeta'));
    expect(warns).toHaveLength(1);
    expect(warns[0]!.level).toBe('warn');
    expect(warns[0]!.msg).toContain('bot-1234abcd');

    // 正对照：合法的 `null`（首出）不记 —— 用**新实例**（一次性闸是实例级的，别被上一条吃掉）；
    // 同样须**抛错**：不抛则 `[]` ⇒ pass/douzero，`null` 分支根本没被考到（假绿）。
    const { bot: freshBot } = makePlayer(async () => {
      throw new Error('boom');
    });
    await freshBot.decide(request({ skillLevel: 'beginner', features: features({ lastMoveMeta: null }) }));
    expect(records.filter((r) => r.msg.includes('lastMoveMeta'))).toHaveLength(1);
  });
});
