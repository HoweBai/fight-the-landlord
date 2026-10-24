/**
 * Task 2.6 / spec §4.8：`robot.acquire/release/availability` 全链路带 gameType。
 *
 * - acquire ⇒ 池按玩法取/建；
 * - release ⇒ 只传 botIds（池从 bot 记录推导玩法，不信任调用方）；
 * - availability：ddz 仍问 DouZero；pdk 是规则 bot，不依赖模型。
 */
import { describe, expect, it, vi } from 'vitest';
import type { BotInstance, RobotDecideRequest } from '@fight-the-landlord/protocol';
import { RobotService } from '../src/robot/robot.service';
import type { BotPlayer } from '../src/robot/bot.player';
import type { RobotPool } from '../src/robot/robot.pool';
import type { DouZeroHealth } from '../src/robot/douzero.health';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

const bot = (gameType: 'doudizhu' | 'paodekuai'): BotInstance => ({
  botId: 'bot-1',
  displayId: 'p_00000001',
  skillLevel: 'beginner',
  personality: { thinkingSpeed: 1200 },
  roomCode: 'R1',
  seat: 0,
  gamesPlayed: 0,
  gameType,
});

function makeService(
  over: {
    pool?: {
      acquire?: ReturnType<typeof vi.fn>;
      release?: ReturnType<typeof vi.fn>;
      listIdle?: ReturnType<typeof vi.fn>;
      reclaimIdle?: ReturnType<typeof vi.fn>;
      poolSize?: ReturnType<typeof vi.fn>;
    };
    health?: { canProvide?: ReturnType<typeof vi.fn> };
    botPlayer?: { decide?: ReturnType<typeof vi.fn> };
  } = {},
) {
  const pool = {
    acquire: vi.fn(),
    release: vi.fn().mockResolvedValue(1),
    listIdle: vi.fn(),
    reclaimIdle: vi.fn(),
    poolSize: vi.fn(),
    ...over.pool,
  };
  const health = { canProvide: vi.fn().mockResolvedValue({ canProvide: true }), ...over.health };
  const botPlayer = { decide: vi.fn(), ...over.botPlayer };
  const service = new RobotService(
    botPlayer as unknown as BotPlayer,
    pool as unknown as RobotPool,
    health as unknown as DouZeroHealth,
    asConfigCache(makeConfigCache()),
  );
  return { service, pool, health, botPlayer };
}

describe('RobotService 的玩法贯通（Task 2.6）', () => {
  it('acquire：gameType 透传给池；缺省 = doudizhu（旧调用零变化）', async () => {
    const { service, pool } = makeService();
    pool.acquire.mockResolvedValue([bot('paodekuai')]);

    await service.acquire({ roomCode: 'R1', seats: [0], gameType: 'paodekuai' });
    expect(pool.acquire).toHaveBeenCalledWith('R1', [0], 'paodekuai');

    await service.acquire({ roomCode: 'R1', seats: [0] });
    expect(pool.acquire).toHaveBeenLastCalledWith('R1', [0], 'doudizhu');
  });

  it('release：不把调用方的 gameType 塞给池（release 从 bot 记录推导）', async () => {
    const { service, pool } = makeService();

    await service.release({ botIds: ['bot-1'], gameType: 'paodekuai' });

    expect(pool.release).toHaveBeenCalledWith(['bot-1']);
  });

  it('availability：ddz 问 DouZero；pdk 不依赖模型（规则 bot）', async () => {
    const { service, health } = makeService({
      health: { canProvide: vi.fn().mockResolvedValue({ canProvide: false, reason: 'douzero-unreachable' }) },
    });

    await expect(service.availability()).resolves.toEqual({ canProvide: false, reason: 'douzero-unreachable' });
    expect(health.canProvide).toHaveBeenCalledTimes(1);

    await expect(service.availability('paodekuai')).resolves.toEqual({ canProvide: true });
    expect(health.canProvide, 'pdk 不得检查 DouZero').toHaveBeenCalledTimes(1);
  });

  it('decide：pdk 请求也交给 BotPlayer（由它显式拒绝；S3.6 再实现）', async () => {
    const { service, botPlayer } = makeService();
    botPlayer.decide.mockRejectedValue(new Error('paodekuai bot is not implemented yet'));
    const req = { roomCode: 'R1', botId: 'bot-1', skillLevel: 'beginner', gameType: 'paodekuai' } as RobotDecideRequest;

    await expect(service.decide(req)).rejects.toThrow(/not implemented/);
    expect(botPlayer.decide).toHaveBeenCalledWith(req);
  });
});
