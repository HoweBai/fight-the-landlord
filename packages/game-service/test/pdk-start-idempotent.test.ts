import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PDK_RULES, type PdkSession } from '@fight-the-landlord/shared';
import { ErrCode } from '@fight-the-landlord/protocol';
import { resetRedisDouble } from './helpers-ioredis';
import { pdkService } from './helpers-pdk';

/**
 * 审查 P1-3：开局重试不得因规则快照漂移报 12012。
 *
 * room-service 每次 `startRoomOutcome()` 都从配置缓存重新组装 `pdkRules`；
 * 60s 热更新窗口内改任一键，重试载荷就与首次快照不同。已有会话的规则快照
 * 才是真源（设计 D19：局中改配置不影响在途局），差异只 WARN，不拒绝。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

const PLAYERS = [
  { id: 'u1', seat: 0, isRobot: false },
  { id: 'u2', seat: 1, isRobot: false },
  { id: 'u3', seat: 2, isRobot: false },
];

const REQ = {
  roomCode: 'PDK-IDEM',
  gameType: 'paodekuai' as const,
  playerCount: 3 as const,
  baseScore: 15,
  players: PLAYERS,
  rules: DEFAULT_PDK_RULES,
};

describe('pdk 开局幂等与规则快照漂移（审查 P1-3）', () => {
  beforeEach(() => {
    resetRedisDouble();
  });

  it('同玩法/同人数、rules 变化 ⇒ 复用会话，保留首次快照，只 WARN', async () => {
    const service = pdkService();
    const first = await service.startGame(REQ);
    const warn = vi
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const second = await service.startGame({
      ...REQ,
      rules: { ...DEFAULT_PDK_RULES, multiplierCap: 128 },
    });

    expect(second.version).toBe(first.version);
    const session = (await service.getSession<PdkSession>('PDK-IDEM'))!;
    expect(session.rules.multiplierCap, '首次快照是真源').toBe(64);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('PDK-IDEM');
  });

  it('跨玩法复用仍拒绝：pdk 会话 + doudizhu start ⇒ 12012', async () => {
    const service = pdkService();
    await service.startGame(REQ);

    await expect(
      service.startGame({ ...REQ, gameType: 'doudizhu' }),
    ).rejects.toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
  });

  it('跨人数复用仍拒绝：3 人 pdk 会话 + 4 人 start ⇒ 12012', async () => {
    const service = pdkService();
    await service.startGame(REQ);

    await expect(
      service.startGame({ ...REQ, playerCount: 4 }),
    ).rejects.toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
  });
});
