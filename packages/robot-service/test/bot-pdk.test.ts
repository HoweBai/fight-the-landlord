/**
 * Task 3.6 / spec §5.7：跑得快规则 bot。
 *
 * 首版策略 = autoplay（首出最小单张 / 跟牌最小可压 / 无解过牌）；规则快照取
 * `features.pdkRules`（RH5），不调用 DouZero。策略产出非法时**回退 autoplay**。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  PdkHandType,
  type Card,
  type PdkParsedHand,
  type PdkPlayerView,
  type PdkRobotFeatures,
  type PdkRulesConfig,
  type RobotDecideRequest,
} from '@fight-the-landlord/protocol';
import { BotPlayer } from '../src/robot/bot.player';
import type { DouZeroClient } from '../src/robot/douzero.client';
import { decidePdkBot, type PdkBotStrategy, type PdkRobotDecideRequest } from '../src/robot/bots/pdk';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

const DEFAULT_RULES: PdkRulesConfig = {
  bareTrioEnabled: true,
  trioWithPairEnabled: false,
  bareAirplaneEnabled: false,
  fourWithTwoEnabled: true,
  fourWithTwoPairKickerAllowed: false,
  airplaneWings: 'pairs',
  bombMultiplierEnabled: true,
  guanMultiplierEnabled: true,
  springMultiplierEnabled: true,
  multiplierCap: 64,
  baobenEnabled: true,
};

const rules = (over: Partial<PdkRulesConfig> = {}): PdkRulesConfig => ({
  ...DEFAULT_RULES,
  ...over,
});

const asCards = (ranks: number[]): Card[] => ranks.map((r, i) => ({ r, s: i % 4 }));

function request(opts: {
  hand: number[];
  lastMove?: PdkParsedHand | null;
  rules?: PdkRulesConfig;
  viewRules?: PdkRulesConfig;
}): PdkRobotDecideRequest {
  const pdkRules = opts.rules ?? rules();
  const viewRules = opts.viewRules ?? pdkRules;
  const target = opts.lastMove ?? null;
  const view: PdkPlayerView = {
    roomCode: 'ROOM-PDK',
    gameType: 'paodekuai',
    playerCount: 3,
    version: 2,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: asCards(opts.hand),
    cardCounts: [opts.hand.length, 16, 16],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    canPass: target !== null,
    bombCount: 0,
    pdkRules: viewRules,
  };
  const features: PdkRobotFeatures = {
    gameType: 'paodekuai',
    seat: 0,
    lastMove: target ? { ...target, cards: [] } : null,
    numCardsLeft: [opts.hand.length, 16, 16],
    playedCards: [[], [], []],
    actionSeq: [],
    passCount: target ? 1 : 0,
    bombCount: 0,
    canPass: target !== null,
    pdkRules,
  };
  return {
    roomCode: 'ROOM-PDK',
    botId: 'bot-1234abcd',
    skillLevel: 'beginner',
    gameType: 'paodekuai',
    view,
    features,
  };
}

const single = (rank: number): PdkParsedHand => ({
  type: PdkHandType.Single,
  keyRank: rank,
  length: 0,
});

describe('decidePdkBot：首版策略 = autoplay', () => {
  it('首出：最小单张；source=rule', () => {
    const decision = decidePdkBot(request({ hand: [5, 3, 4] }));
    expect(decision).toEqual({ kind: 'play', cards: [3], source: 'rule' });
  });

  it('跟牌有解：最小可压', () => {
    const decision = decidePdkBot(request({ hand: [4, 6, 7], lastMove: single(5) }));
    expect(decision).toEqual({ kind: 'play', cards: [6], source: 'rule' });
  });

  it('跟牌无解：pass（不产出非法动作）', () => {
    const decision = decidePdkBot(request({ hand: [4, 5], lastMove: single(9) }));
    expect(decision).toEqual({ kind: 'pass', source: 'rule' });
  });

  it('同型无解但手上有炸弹 ⇒ 出最小炸弹', () => {
    const decision = decidePdkBot(
      request({ hand: [3, 3, 3, 3, 4], lastMove: single(14) }),
    );
    expect(decision).toEqual({ kind: 'play', cards: [3, 3, 3, 3], source: 'rule' });
  });

  it('规则取 features.pdkRules（RH5）：允许对子带牌时选更小的 33 带牌', () => {
    const target: PdkParsedHand = {
      type: PdkHandType.FourWithTwo,
      keyRank: 5,
      length: 0,
    };
    const withPair = decidePdkBot(
      request({
        hand: [6, 6, 6, 6, 3, 3, 4],
        lastMove: target,
        rules: rules({ fourWithTwoPairKickerAllowed: true }),
      }),
    );
    expect(withPair).toEqual({ kind: 'play', cards: [3, 3, 6, 6, 6, 6], source: 'rule' });

    // view 的规则故意不同：bot 必须跟 features 走（若误读 view，会选 3,4）
    const featureRules = rules({ fourWithTwoPairKickerAllowed: true });
    const viewOnly = decidePdkBot(
      request({
        hand: [6, 6, 6, 6, 3, 3, 4],
        lastMove: target,
        rules: featureRules,
        viewRules: rules({ fourWithTwoPairKickerAllowed: false }),
      }),
    );
    expect(viewOnly).toEqual({ kind: 'play', cards: [3, 3, 6, 6, 6, 6], source: 'rule' });
  });

  it('策略产出非法 ⇒ 回退 autoplay（越权牌/非法牌型都被拒）', () => {
    const badCardStrategy: PdkBotStrategy = { choose: () => [{ r: 99, s: 0 }] };
    expect(decidePdkBot(request({ hand: [5, 3, 4] }), badCardStrategy)).toEqual({
      kind: 'play',
      cards: [3],
      source: 'rule',
    });

    const badShapeStrategy: PdkBotStrategy = { choose: () => asCards([3, 5]) };
    expect(decidePdkBot(request({ hand: [5, 3, 4] }), badShapeStrategy)).toEqual({
      kind: 'play',
      cards: [3],
      source: 'rule',
    });

    const nullStrategy: PdkBotStrategy = { choose: () => null };
    expect(decidePdkBot(request({ hand: [4, 6], lastMove: single(5) }), nullStrategy)).toEqual({
      kind: 'play',
      cards: [6],
      source: 'rule',
    });
  });

  it('首出无牌可打 ⇒ 响亮失败（不应被 end-state 调用）', () => {
    expect(() => decidePdkBot(request({ hand: [] }))).toThrow(/no legal lead/i);
  });

  it('畸形：上一手存在但 canPass=false 且无合法动作 ⇒ 响亮失败，不直接过牌', () => {
    const req = request({ hand: [4, 5], lastMove: single(9) });
    (req.view as PdkPlayerView).canPass = false;
    expect(() => decidePdkBot(req)).toThrow(/no legal action/i);
  });
});

describe('BotPlayer 分发到 pdk bot（不再拒绝）', () => {
  it('pdk 请求走规则 bot，且绝不调用 DouZero', async () => {
    const getMove = vi.fn();
    const player = new BotPlayer(
      { getMove } as unknown as DouZeroClient,
      asConfigCache(makeConfigCache()),
    );

    const decision = await player.decide(request({ hand: [5, 3, 4] }));

    expect(decision).toEqual({ kind: 'play', cards: [3], source: 'rule' });
    expect(getMove).not.toHaveBeenCalled();
  });

  it('pdk 视图 + ddz 特征（畸形）⇒ 响亮失败，不静默套用', async () => {
    const player = new BotPlayer(
      { getMove: vi.fn() } as unknown as DouZeroClient,
      asConfigCache(makeConfigCache()),
    );
    const malformed = {
      ...request({ hand: [3] }),
      features: {
        gameType: 'doudizhu',
        position: 'landlord',
        lastMove: [],
        lastMovePosition: '',
        lastMoveMeta: null,
        numCardsLeft: { landlord: 1, landlord_down: 1, landlord_up: 1 },
        playedCards: { landlord: [], landlord_down: [], landlord_up: [] },
        actionSeq: [],
      },
    } as unknown as RobotDecideRequest;

    await expect(player.decide(malformed)).rejects.toThrow(/features/i);
  });
});
