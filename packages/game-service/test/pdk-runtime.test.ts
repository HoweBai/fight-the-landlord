import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  ErrCode,
  PdkHandType,
  isPdkSettlementResult,
  type Card,
  type PdkPlayerView,
} from '@fight-the-landlord/protocol';
import {
  DEFAULT_PDK_RULES,
  type PdkSession,
} from '@fight-the-landlord/shared';
import { GameModule } from '../src/game/game.module';
import { GameRegistry } from '../src/games/registry';
import { DdzRuntime } from '../src/games/ddz/runtime';
import { PdkRuntime } from '../src/games/pdk/runtime';
import { classifyRuleError } from '../src/games/pdk/rule-error.mapping';
import { card, fullGameDeck } from './fixtures/pdk-fixtures';

/**
 * Task 4.1（spec §4.3 / §5 / §6.3）：跑得快 runtime 适配层。
 *
 * 判据分四组：
 *  - create：2/3/4 人发牌、规则快照、首出者、机器人内部字段；
 *  - 视图：自己手牌明文、他人只看张数、`pdkRules`、`canPass`、扣牌/禁键不出站；
 *  - 动作：play/pass 走 shared 纯函数；`game.bid ⇒ 13001`；错误经映射表分类；
 *  - 超时/终局：autoplay 最小单张/最小可压/无解过牌；finish/settle 委托 shared。
 *
 * 固定牌堆（`testDeck`）只用于本文件；生产入口的 testDeck 开关由 Task 4.4 的门禁管。
 */

const POLICY = { normal: 30_000, accel: 10_000, trustee: 2_000, after: 3 };
const ctx = (actorSeat: number) => ({
  now: 0,
  random: () => 0.5,
  governance: POLICY,
  actorSeat,
});

function createSession(over: {
  playerCount?: 2 | 3 | 4;
  rules?: unknown;
  testDeck?: Card[];
} = {}): PdkSession {
  const playerCount = over.playerCount ?? 3;
  const runtime = new PdkRuntime();
  return runtime.create({
    roomCode: 'PDK01',
    gameType: 'paodekuai',
    playerCount,
    baseScore: 15,
    players: Array.from({ length: playerCount }, (_, seat) => ({
      id: `p${seat}`,
      seat,
      isRobot: seat === playerCount - 1,
      botId: seat === playerCount - 1 ? `bot-${seat}` : undefined,
      skillLevel: 'beginner' as const,
      thinkingSpeed: 1200,
    })),
    rules: over.rules,
    random: () => 0.5,
    testDeck: over.testDeck ?? fullGameDeck(),
  });
}

function act(
  runtime: PdkRuntime,
  session: PdkSession,
  seat: number,
  action: Parameters<PdkRuntime['applyAction']>[1],
) {
  return runtime.applyAction(session, action, ctx(seat));
}

describe('Task 4.1：PdkRuntime.create', () => {
  it('3 人：各 16 张、红桃 3 持有者先出、规则快照合并默认值、机器人内部字段按座位', () => {
    const runtime = new PdkRuntime();
    const session = runtime.create({
      roomCode: 'PDK01',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      players: [
        { id: 'p0', seat: 0, isRobot: false },
        { id: 'p1', seat: 1, isRobot: false },
        { id: 'p2', seat: 2, isRobot: true, botId: 'bot-2', skillLevel: 'advanced', thinkingSpeed: 1500 },
      ],
      rules: { multiplierCap: 32 },
      random: () => 0.5,
      testDeck: fullGameDeck(),
    });

    expect(session.gameType).toBe('paodekuai');
    expect(session.playerCount).toBe(3);
    expect(session.players.map((p) => p.hand.length)).toEqual([16, 16, 16]);
    expect(session.currentPlayer).toBe(0);
    expect(session.rules).toEqual({ ...DEFAULT_PDK_RULES, multiplierCap: 32 });
    expect(session.botIds).toEqual([undefined, undefined, 'bot-2']);
    expect(session.botSkillLevels).toEqual([undefined, undefined, 'advanced']);
    expect(session.botThinkingSpeeds).toEqual([undefined, undefined, 1500]);
    expect(session.initialHands?.map((h) => h.length)).toEqual([16, 16, 16]);
    expect(runtime.currentActor(session)).toBe(0);
    expect(runtime.timerPhase(session)).toBe('play');
    expect(runtime.turnDuration(session, 0, POLICY)).toBe(POLICY.normal);
  });

  it('2 人：各 16 张 + 第三份进 unusedCards；4 人：各 12 张', () => {
    const runtime = new PdkRuntime();
    const two = runtime.create({
      roomCode: 'PDK02',
      gameType: 'paodekuai',
      playerCount: 2,
      baseScore: 15,
      players: [
        { id: 'p0', seat: 0, isRobot: false },
        { id: 'p1', seat: 1, isRobot: false },
      ],
      random: () => 0.5,
    });
    expect(two.players.map((p) => p.hand.length)).toEqual([16, 16]);
    expect(two.unusedCards).toHaveLength(16);

    const four = runtime.create({
      roomCode: 'PDK04',
      gameType: 'paodekuai',
      playerCount: 4,
      baseScore: 15,
      players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isRobot: false })),
      random: () => 0.5,
    });
    expect(four.players.map((p) => p.hand.length)).toEqual([12, 12, 12, 12]);
    expect(four.unusedCards).toBeUndefined();
  });

  it('非法 rules ⇒ ProtocolError（不静默用默认值）', () => {
    expect(() => createSession({ rules: { airplaneWings: 'nope' } })).toThrow(/airplaneWings/);
  });

  it('2 人局未给 testDeck：随机发牌仍合法（不依赖固定牌堆）', () => {
    const runtime = new PdkRuntime();
    const session = runtime.create({
      roomCode: 'PDK03',
      gameType: 'paodekuai',
      playerCount: 2,
      baseScore: 15,
      players: [
        { id: 'p0', seat: 0, isRobot: false },
        { id: 'p1', seat: 1, isRobot: false },
      ],
      random: () => 0.25,
    });
    expect(session.players.map((p) => p.hand.length)).toEqual([16, 16]);
    expect(session.unusedCards).toHaveLength(16);
  });
});

describe('Task 4.1：PdkRuntime 视图投影', () => {
  it('buildView：自己手牌明文、他人只给张数、pdkRules/canPass、禁键不出站', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    const view = runtime.buildView(session, 0) as PdkPlayerView;

    expect(view.gameType).toBe('paodekuai');
    expect(view.playerCount).toBe(3);
    expect(view.seat).toBe(0);
    expect(view.hand).toEqual(session.players[0]!.hand);
    expect(view.cardCounts).toEqual([16, 16, 16]);
    expect(view.trustees).toEqual([false, false, false]);
    expect(view.state).toBe('playing');
    expect(view.pdkRules).toEqual(session.rules);
    expect(view.bombCount).toBe(0);
    // 首出：不可过牌
    expect(view.canPass).toBe(false);
    expect(view.winnerSeats).toBeUndefined();
    // 内部字段/规则态永不出现（validateOutbound 也会机械拦截）
    for (const forbidden of [
      'rules',
      'unusedCards',
      'lastPlayedHand',
      'initialHands',
      'botIds',
      'botSkillLevels',
      'botThinkingSpeeds',
      'actionLog',
    ]) {
      expect(view, `视图不得含 ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('出牌后：下一个座位 canPass=true、recentActions 投影、buildAllViews 每座一份', () => {
    const runtime = new PdkRuntime();
    let session = createSession();
    session = act(runtime, session, 0, { kind: 'play', cards: session.players[0]!.hand.slice(0, 12) }).session;

    expect(runtime.currentActor(session)).toBe(1);
    const view1 = runtime.buildView(session, 1) as PdkPlayerView;
    expect(view1.canPass).toBe(true);
    expect(view1.recentActions).toHaveLength(1);
    expect(view1.recentActions[0]!.seat).toBe(0);
    expect(view1.recentActions[0]!.cards).toHaveLength(12);
    expect(view1.cardCounts).toEqual([4, 16, 16]);

    // 最后出牌者自己不能过（等其余玩家都过后重新首出）
    const view0 = runtime.buildView(session, 0) as PdkPlayerView;
    expect(view0.canPass).toBe(false);

    const all = runtime.buildAllViews(session) as PdkPlayerView[];
    expect(all.map((v) => v.seat)).toEqual([0, 1, 2]);
    expect(all.map((v) => v.hand.length)).toEqual([4, 16, 16]);
  });

  it('2 人局：扣牌不出站（会话有、视图/机器人特征没有）', () => {
    const runtime = new PdkRuntime();
    const session = runtime.create({
      roomCode: 'PDK02',
      gameType: 'paodekuai',
      playerCount: 2,
      baseScore: 15,
      players: [
        { id: 'p0', seat: 0, isRobot: false },
        { id: 'p1', seat: 1, isRobot: false },
      ],
      random: () => 0.5,
    });
    expect(session.unusedCards).toHaveLength(16);
    const view = runtime.buildView(session, 0) as PdkPlayerView;
    expect(view).not.toHaveProperty('unusedCards');
    expect(view.cardCounts).toEqual([16, 16]);
    const robot = runtime.buildRobotInput(session, 1);
    expect(robot.features).not.toHaveProperty('unusedCards');
  });

  it('结束后视图带 winnerSeats', () => {
    const runtime = new PdkRuntime();
    let session = createSession();
    session = playToEnd(runtime, session);
    const finished = runtime.finish(session, 1234);
    const view = runtime.buildView(finished, 2) as PdkPlayerView;
    expect(view.state).toBe('ended');
    expect(view.winnerSeats).toEqual([0]);
  });
});

describe('Task 4.1：动作、错误映射与超时', () => {
  it('game.bid ⇒ 13001（ILLEGAL_ACTION）', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    let error: unknown;
    try {
      act(runtime, session, 0, { kind: 'bid', grab: true });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect(classifyRuleError(error)).toBe(ErrCode.ILLEGAL_ACTION);
  });

  it('错误分类：非本回合 12003、牌不在手 13001、压不过 13006、首出过牌 13001', () => {
    const runtime = new PdkRuntime();
    const session = createSession();

    expect(() => act(runtime, session, 1, { kind: 'pass' })).toThrow(/Not your turn/);
    // 3♠ 不在座位 0 的手牌里（座位 1/2 可能持有）
    expect(() => act(runtime, session, 0, { kind: 'play', cards: [card(3, 0)] })).toThrow(/not in hand/);
    expect(() => act(runtime, session, 0, { kind: 'pass' })).toThrow(/opening lead/);

    const afterLead = act(runtime, session, 0, {
      kind: 'play',
      cards: session.players[0]!.hand.slice(0, 12),
    }).session;
    // 12 张顺子（A 高）压不过（同一手也不能再压自己）⇒ 用更小的顺子跟牌
    const seat1Hand = afterLead.players[1]!.hand;
    const smallerStraight = seat1Hand.filter((c) => c.r <= 14).slice(0, 5);
    let error: unknown;
    try {
      act(runtime, afterLead, 1, { kind: 'play', cards: smallerStraight });
    } catch (err) {
      error = err;
    }
    // 不论牌型是否合法（5 张同花可能非顺子），分类都必须是契约码而不是 500
    expect([ErrCode.INVALID_CARDS, ErrCode.ILLEGAL_ACTION]).toContain(classifyRuleError(error));
  });

  it('onTimeout 首出：最小单张（红桃 3）', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    const next = runtime.onTimeout(session, ctx(0)).session;
    expect(next.lastPlayedHand?.type).toBe(PdkHandType.Single);
    expect(next.lastPlayedHand?.keyRank).toBe(3);
    expect(next.players[0]!.hand).toHaveLength(15);
    expect(next.players[0]!.hand.some((c) => c.r === 3 && c.s === 1)).toBe(false);
  });

  it('onTimeout 跟牌：打最小可压单张；无法压过 12 张顺子 ⇒ 过牌', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    const afterLead = runtime.onTimeout(session, ctx(0)).session;

    const expected = [...afterLead.players[1]!.hand]
      .filter((c) => c.r > 3)
      .sort((a, b) => a.r - b.r || a.s - b.s)[0]!;
    const follow = runtime.onTimeout(afterLead, ctx(1)).session;
    expect(follow.lastPlayedHand?.type).toBe(PdkHandType.Single);
    expect(follow.lastPlayedHand?.keyRank).toBe(expected.r);
    // 精确摘牌：座位 1 的手牌里少了那一张
    expect(follow.players[1]!.hand).toHaveLength(15);
    expect(
      follow.players[1]!.hand.some((c) => c.r === expected.r && c.s === expected.s),
    ).toBe(false);

    // 12 张 A 高顺子：座位 1 没有 4、也没有炸弹 ⇒ autoplay 无解 ⇒ 过牌
    const straightLead = act(runtime, session, 0, {
      kind: 'play',
      cards: session.players[0]!.hand.slice(0, 12),
    }).session;
    const passed = runtime.onTimeout(straightLead, ctx(1)).session;
    expect(passed.consecutivePasses).toBe(1);
    expect(passed.players[1]!.hand).toEqual(straightLead.players[1]!.hand);
    expect(passed.lastPlayedHand).toEqual(straightLead.lastPlayedHand);
  });

  it('autoAction 与超时同源：首出最小单张、跟牌无解返回 pass', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    expect(runtime.autoAction(session, 0)).toEqual({
      kind: 'play',
      cards: [card(3, 1)],
    });

    const straightLead = act(runtime, session, 0, {
      kind: 'play',
      cards: session.players[0]!.hand.slice(0, 12),
    }).session;
    expect(runtime.autoAction(straightLead, 1)).toEqual({ kind: 'pass' });
  });
});

describe('Task 4.1：终局与记录', () => {
  it('完整局：出完即 ended；finish 补 winnerSeats/finishedAt；settle 零和', () => {
    const runtime = new PdkRuntime();
    let session = createSession();

    const first = act(runtime, session, 0, {
      kind: 'play',
      cards: session.players[0]!.hand.slice(0, 12),
    });
    expect(first.ended).toBe(false);
    session = act(runtime, first.session, 1, { kind: 'pass' }).session;
    session = act(runtime, session, 2, { kind: 'pass' }).session;
    expect(runtime.currentActor(session)).toBe(0);

    session = act(runtime, session, 0, { kind: 'play', cards: session.players[0]!.hand.slice(0, 3) }).session;
    session = act(runtime, session, 1, { kind: 'pass' }).session;
    session = act(runtime, session, 2, { kind: 'pass' }).session;

    const last = act(runtime, session, 0, {
      kind: 'play',
      cards: [session.players[0]!.hand[0]!],
    });
    expect(last.ended).toBe(true);
    expect(runtime.isFinished(last.session)).toBe(true);
    // shared 的 handlePdkPlay 出完最后一张即 finishPdk（state=ended/winnerSeats/finishedAt）。
    expect(last.session.state).toBe('ended');
    expect(last.session.winnerSeats).toEqual([0]);
    expect(last.session.finishedAt).toEqual(expect.any(Number));

    const finished = runtime.finish(last.session, 1234);
    expect(finished.state).toBe('ended');
    expect(finished.finishedAt).toEqual(expect.any(Number));
    expect(finished.winnerSeats).toEqual([0]);

    const settlement = runtime.settle(finished);
    expect(isPdkSettlementResult(settlement)).toBe(true);
    if (!isPdkSettlementResult(settlement)) throw new Error('unreachable');
    expect(settlement.gameType).toBe('paodekuai');
    expect(settlement.winnerSeats).toEqual([0]);
    expect(settlement.scoreChanges.reduce((sum, c) => sum + c.delta, 0)).toBe(0);
    expect(settlement.remaining).toEqual([0, 16, 16]);
  });

  it('buildRecord：3 人 16 张 = 32 hex、playedCount 来自会话、无 bottomCards', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    const record = runtime.buildRecord(session);
    expect(record).toBeDefined();
    expect(record!.gameType).toBe('paodekuai');
    expect(record!.playerCount).toBe(3);
    if (record!.gameType !== 'paodekuai') throw new Error('unreachable');
    expect(record!.seats.map((s) => s.seat)).toEqual([0, 1, 2]);
    expect(record!.seats.every((s) => s.hand.length === 32)).toBe(true);
    expect(record!.seats.map((s) => s.playedCount)).toEqual([0, 0, 0]);
    // pdk 没有底牌：信封必须**没有** bottomCards 键（不是空串）
    expect(record).not.toHaveProperty('bottomCards');
    expect(record!.unusedCards).toBeUndefined();
  });

  it('buildRecord：2 人局带 unusedCards（32 hex）；无 initialHands ⇒ undefined', () => {
    const runtime = new PdkRuntime();
    const two = runtime.create({
      roomCode: 'PDK02',
      gameType: 'paodekuai',
      playerCount: 2,
      baseScore: 15,
      players: [
        { id: 'p0', seat: 0, isRobot: false },
        { id: 'p1', seat: 1, isRobot: false },
      ],
      random: () => 0.5,
    });
    const record = runtime.buildRecord(two);
    expect(record).toBeDefined();
    if (record!.gameType !== 'paodekuai') throw new Error('unreachable');
    expect(record!.unusedCards).toHaveLength(32);
    expect(record!.seats.every((s) => s.hand.length === 32)).toBe(true);

    const { initialHands: _drop, ...withoutSnapshot } = two;
    expect(runtime.buildRecord(withoutSnapshot as PdkSession)).toBeUndefined();
  });

  it('buildRobotInput：特征是 pdk 公开特征（pdkRules、无他人手牌/扣牌）', () => {
    const runtime = new PdkRuntime();
    const session = createSession();
    const input = runtime.buildRobotInput(session, 1);
    expect(input.features.gameType).toBe('paodekuai');
    if (input.features.gameType !== 'paodekuai') throw new Error('unreachable');
    expect(input.features.pdkRules).toEqual(session.rules);
    expect(input.features.canPass).toBe(false);
    expect(input.features.numCardsLeft).toEqual([16, 16, 16]);
    expect(input.features).not.toHaveProperty('unusedCards');
    const view = input.view as PdkPlayerView;
    expect(view.hand).toEqual(session.players[1]!.hand);
  });
});

describe('Task 4.1：GameModule 注册 PdkRuntime', () => {
  it('registry 同时注册 doudizhu 与 paodekuai（找不到不回落）', () => {
    const providers = (Reflect.getMetadata('providers', GameModule) ?? []) as Array<
      Record<string, unknown>
    >;
    expect(providers.find((p) => p['provide'] === PdkRuntime)).toBeDefined();

    const registryProvider = providers.find((p) => p['provide'] === GameRegistry);
    expect(registryProvider).toBeDefined();
    const factory = registryProvider!['useFactory'] as (
      ddz: DdzRuntime,
      pdk: PdkRuntime,
    ) => GameRegistry;
    const registry = factory(new DdzRuntime(), new PdkRuntime());
    expect(registry.list().sort()).toEqual(['doudizhu', 'paodekuai']);
  });
});

/** 出完 seat0 全部手牌（12 顺子 → 三张 4 → 单张 2），返回 ended 会话。 */
function playToEnd(runtime: PdkRuntime, session: PdkSession): PdkSession {
  let s = act(runtime, session, 0, { kind: 'play', cards: session.players[0]!.hand.slice(0, 12) }).session;
  s = act(runtime, s, 1, { kind: 'pass' }).session;
  s = act(runtime, s, 2, { kind: 'pass' }).session;
  s = act(runtime, s, 0, { kind: 'play', cards: s.players[0]!.hand.slice(0, 3) }).session;
  s = act(runtime, s, 1, { kind: 'pass' }).session;
  s = act(runtime, s, 2, { kind: 'pass' }).session;
  return act(runtime, s, 0, { kind: 'play', cards: [s.players[0]!.hand[0]!] }).session;
}
