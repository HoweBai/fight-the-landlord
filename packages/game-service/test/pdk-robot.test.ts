import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PdkHandType,
  type RobotDecideRequest,
  type RobotDecideResponse,
} from '@fight-the-landlord/protocol';
import type { PdkSession } from '@fight-the-landlord/shared';
import type { GameService } from '../src/game/game.service';
import { resetRedisDouble } from './helpers-ioredis';
import { pdkService, seedPdkSession } from './helpers-pdk';

/**
 * Task 4.2（spec §5.7 / §9.4）：**pdk 机器人接线**。
 *
 * 判据：
 *  - `driveRobotTurn` 用 runtime 的 `buildRobotInput` 产出 pdk 视图/特征（无他人手牌/扣牌）；
 *  - 机器人决策走**与人类完全相同**的 runtime 校验链；
 *  - 动作被拒（非法牌/首出 pass）⇒ 回退 autoplay，**不得直接 pass**。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

interface DecideCall {
  req: RobotDecideRequest;
}

function withRobotClient(
  service: GameService,
  decide: (req: RobotDecideRequest) => Promise<RobotDecideResponse | null>,
): DecideCall[] {
  const calls: DecideCall[] = [];
  service.robotClient = {
    decide: async (req: RobotDecideRequest) => {
      calls.push({ req });
      return decide(req);
    },
  } as unknown as NonNullable<GameService['robotClient']>;
  service.robotDelay = async () => {};
  return calls;
}

describe('Task 4.2：pdk 机器人（GameService 通用路径）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bot 决策经 pdk 视图/特征出站，合法出牌被采纳', async () => {
    const service = pdkService();
    const seeded = await seedPdkSession(service, 'PDK-RB1', { robotSeats: [0] });
    const calls = withRobotClient(service, async () => ({
      kind: 'play',
      cards: [3],
      source: 'rule',
    }));

    await service['driveRobotTurn']('PDK-RB1');

    expect(calls).toHaveLength(1);
    const { req } = calls[0]!;
    expect(req.view.gameType).toBe('paodekuai');
    expect(req.features.gameType).toBe('paodekuai');
    if (req.features.gameType !== 'paodekuai') throw new Error('unreachable');
    expect(req.features.pdkRules).toEqual(seeded.rules);
    expect(req.features.canPass).toBe(false);
    expect(req.features.numCardsLeft).toEqual([16, 16, 16]);
    expect(req.features).not.toHaveProperty('unusedCards');
    expect(req.view.hand).toEqual(seeded.players[0]!.hand);

    const after = (await service.getSession<PdkSession>('PDK-RB1'))!;
    expect(after.version).toBe(seeded.version + 1);
    expect(after.lastPlayedHand).toMatchObject({ type: PdkHandType.Single, keyRank: 3 });
    expect(after.players[0]!.hand).toHaveLength(15);
    expect(after.players[0]!.hand.some((c) => c.r === 3 && c.s === 1)).toBe(false);
  });

  it('首出 bot 返回 pass（非法）⇒ 回退 autoplay 出最小单张，不得直接过', async () => {
    const service = pdkService();
    const seeded = await seedPdkSession(service, 'PDK-RB2', { robotSeats: [0] });
    withRobotClient(service, async () => ({ kind: 'pass', source: 'rule' }));

    await service['driveRobotTurn']('PDK-RB2');

    const after = (await service.getSession<PdkSession>('PDK-RB2'))!;
    // 若「直接 pass」会抛错并让版本不动 / 首出被跳过；这里必须是一次合法出牌
    expect(after.version).toBe(seeded.version + 1);
    expect(after.lastPlayedHand).toMatchObject({ type: PdkHandType.Single, keyRank: 3 });
    expect(after.players[0]!.hand).toHaveLength(15);
  });

  it('bot 返回不在手中的牌 ⇒ 被校验链拒绝，回退 autoplay（不重问、不 pass）', async () => {
    const service = pdkService();
    const seeded = await seedPdkSession(service, 'PDK-RB3', { robotSeats: [0] });
    const calls = withRobotClient(service, async () => ({
      kind: 'play',
      cards: [99],
      source: 'rule',
    }));

    await service['driveRobotTurn']('PDK-RB3');

    expect(calls).toHaveLength(1); // 回退是本地规则引擎，不再问 robot-service
    const after = (await service.getSession<PdkSession>('PDK-RB3'))!;
    expect(after.version).toBe(seeded.version + 1);
    expect(after.lastPlayedHand).toMatchObject({ type: PdkHandType.Single, keyRank: 3 });
    expect(after.players[0]!.hand).toHaveLength(15);
  });

  it('robot.decide 失败（null）⇒ 规则引擎兜底出最小单张', async () => {
    const service = pdkService();
    const seeded = await seedPdkSession(service, 'PDK-RB4', { robotSeats: [0] });
    withRobotClient(service, async () => null);

    await service['driveRobotTurn']('PDK-RB4');

    const after = (await service.getSession<PdkSession>('PDK-RB4'))!;
    expect(after.version).toBe(seeded.version + 1);
    expect(after.lastPlayedHand).toMatchObject({ type: PdkHandType.Single, keyRank: 3 });
  });
});
