/**
 * 监控片 T5（规格 §2.2 的 robot 两行 / 设计 Y4）：决策计数面。
 *
 * ─── 判据（brief 的四条 + 两条自证）───────────────────────────────────────
 *  ① douzero 路径 ⇒ `robot_decisions_total{result="douzero",skill}` **恰 +1**（收口恰一次）；
 *  ② 规则回落（DouZero 抛错）⇒ `{result="rule"}` +1，且失败读 `robot_decision_errors_total`
 *     （超时 ⇒ `douzero_timeout`、拒连 ⇒ `douzero_unreachable`、返回非法牌 ⇒
 *     `douzero_invalid_cards`——同一次决策 errors 恰 +1）；
 *  ③ 叫抢期恒 `{result="rule"}` **不是失败**（Y4：不调 DouZero、errors 不增）；
 *  ④ `skill` 标签随请求档位，值域 ⊆ `SKILL_LEVELS`；errors 的 `reason` 值域有界（⊆ 导出常量）。
 *
 * ⚠️ 指标是**模块级单例**（与 shared registry 同一份）：本文件内跨用例累计 ⇒ 断言一律
 * 用「前值 + Δ」口径；读值走 registry 的文本输出（不猜 prom-client 内部结构）。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Card, PlayerView, RobotDecideRequest, DdzRobotFeatures } from '@fight-the-landlord/protocol';
import { metricsRegistry } from '@fight-the-landlord/shared';
import { BotPlayer } from '../src/robot/bot.player';
import { RobotService } from '../src/robot/robot.service';
import type { RobotPool } from '../src/robot/robot.pool';
import type { DouZeroClient } from '../src/robot/douzero.client';
import type { DouZeroHealth } from '../src/robot/douzero.health';
import { SKILL_LEVELS } from '../src/robot/config';
import {
  ROBOT_DECISION_ERROR_REASONS,
  ROBOT_DECISION_RESULTS,
} from '../src/robot/robot.metrics';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

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

/** 真实 `RobotService`（**收口** = 被测点）+ 替身 `DouZeroClient`（不发网络）。 */
function makeService(getMove: (ctx: unknown) => Promise<number[]>) {
  const client = { getMove: vi.fn(getMove) } as unknown as DouZeroClient;
  const bot = new BotPlayer(client, asConfigCache(makeConfigCache()));
  const service = new RobotService(
    bot,
    {} as unknown as RobotPool,
    {} as unknown as DouZeroHealth,
    asConfigCache(makeConfigCache()),
  );
  return { service, client };
}

interface Series {
  labels: Record<string, string>;
  value: number;
}

/** registry 文本输出里的同名序列（`metric{...} value` / 无标签 `metric value`）。 */
async function series(name: string): Promise<Series[]> {
  const text = await metricsRegistry().metrics();
  const out: Series[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(-?[\d.eE+]+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const kv of m[2].split(',')) {
        const eq = kv.indexOf('=');
        labels[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/^"|"$/g, '');
      }
    }
    out.push({ labels, value: Number(m[3]) });
  }
  return out;
}

/** 一条 labeled 序列的当前值（未出现过 ⇒ 0 —— prom-client 不输出零值新序列）。 */
async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const keys = Object.keys(labels);
  const hit = (await series(name)).find(
    (s) => Object.keys(s.labels).length === keys.length && keys.every((k) => s.labels[k] === labels[k]),
  );
  return hit?.value ?? 0;
}

/** 一个 counter 全部序列之和（「恰一次」判据用它，不依赖具体标签）。 */
async function counterSum(name: string): Promise<number> {
  return (await series(name)).reduce((acc, s) => acc + s.value, 0);
}

describe('robot 决策指标（监控片 T5 / 规格 §2.2）', () => {
  it('① douzero 合法决策 ⇒ decisions{result="douzero",skill="advanced"} 恰 +1（收口恰一次）', async () => {
    const { service } = makeService(async () => [9]);
    const beforeSum = await counterSum('robot_decisions_total');
    const before = await counterValue('robot_decisions_total', { result: 'douzero', skill: 'advanced' });

    const res = await service.decide(request());

    expect(res).toEqual({ kind: 'play', cards: [9], source: 'douzero' });
    expect(await counterValue('robot_decisions_total', { result: 'douzero', skill: 'advanced' })).toBe(before + 1);
    // 「恰一次」：全部序列之和也只 +1（inc 两次/漏 inc 都会在这里露）。
    expect(await counterSum('robot_decisions_total')).toBe(beforeSum + 1);
  });

  it('② DouZero 超时 ⇒ rule 回转 + errors{reason="douzero_timeout"} 恰 +1', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const { service } = makeService(async () => {
      throw timeout;
    });
    const beforeRule = await counterValue('robot_decisions_total', { result: 'rule', skill: 'advanced' });
    const beforeErr = await counterValue('robot_decision_errors_total', { reason: 'douzero_timeout' });
    const beforeErrSum = await counterSum('robot_decision_errors_total');

    const res = await service.decide(request());

    expect(res.source).toBe('rule');
    expect(res.kind).toBe('play'); // C9：回落**规则引擎**（不是 pass）
    expect(await counterValue('robot_decisions_total', { result: 'rule', skill: 'advanced' })).toBe(beforeRule + 1);
    expect(await counterValue('robot_decision_errors_total', { reason: 'douzero_timeout' })).toBe(beforeErr + 1);
    expect(await counterSum('robot_decision_errors_total')).toBe(beforeErrSum + 1);
  });

  it('②′ DouZero 拒连（fetch failed）⇒ errors{reason="douzero_unreachable"} +1', async () => {
    const { service } = makeService(async () => {
      throw new TypeError('fetch failed');
    });
    const before = await counterValue('robot_decision_errors_total', { reason: 'douzero_unreachable' });

    const res = await service.decide(request());

    expect(res.source).toBe('rule');
    expect(await counterValue('robot_decision_errors_total', { reason: 'douzero_unreachable' })).toBe(before + 1);
  });

  it('②″ DouZero 返回不在手里的牌 ⇒ errors{reason="douzero_invalid_cards"} +1', async () => {
    const { service } = makeService(async () => [17]); // 手牌 [5,6,9]，没有 17
    const before = await counterValue('robot_decision_errors_total', { reason: 'douzero_invalid_cards' });

    const res = await service.decide(request());

    expect(res).toEqual({ kind: 'play', cards: [9], source: 'rule' });
    expect(await counterValue('robot_decision_errors_total', { reason: 'douzero_invalid_cards' })).toBe(before + 1);
  });

  it('③ 叫抢期恒 {result="rule"} 但**不是失败**（Y4：不调 DouZero、errors 不增）', async () => {
    const { service, client } = makeService(async () => []);
    const beforeRule = await counterValue('robot_decisions_total', { result: 'rule', skill: 'advanced' });
    const beforeErrSum = await counterSum('robot_decision_errors_total');

    const res = await service.decide(request({ view: view({ state: 'bidding', recentActions: [] }) }));

    expect(res).toEqual({ kind: 'pass', source: 'rule' });
    expect(client.getMove).not.toHaveBeenCalled();
    expect(await counterValue('robot_decisions_total', { result: 'rule', skill: 'advanced' })).toBe(beforeRule + 1);
    expect(
      await counterSum('robot_decision_errors_total'),
      '叫抢期恒 rule 是协议约定（不调 AI）—— 不许当失败计入 errors',
    ).toBe(beforeErrSum);
  });

  it('④ skill 三档逐一随请求下档；输出里的 skill/result 全部 ⊆ 导出值域', async () => {
    for (const level of SKILL_LEVELS) {
      const { service } = makeService(async () => [9]);
      const before = await counterValue('robot_decisions_total', { result: 'douzero', skill: level });
      await service.decide(request({ skillLevel: level }));
      expect(await counterValue('robot_decisions_total', { result: 'douzero', skill: level }), `${level} 档`).toBe(
        before + 1,
      );
    }

    for (const s of await series('robot_decisions_total')) {
      expect(SKILL_LEVELS).toContain(s.labels.skill);
      expect(ROBOT_DECISION_RESULTS).toContain(s.labels.result);
    }
  });

  it('④′ errors 的 reason 值域有界（输出里出现过的 reason ⊆ 导出常量）', async () => {
    for (const s of await series('robot_decision_errors_total')) {
      expect(ROBOT_DECISION_ERROR_REASONS).toContain(s.labels.reason);
    }
  });
});
