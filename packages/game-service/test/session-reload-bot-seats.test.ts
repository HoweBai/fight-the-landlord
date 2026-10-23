/**
 * P0-1 回归：会话 JSON 往返后，**人类座位不得被判成机器人**。
 *
 * 机制：`botIds` 是稀疏数组（人类座位是空洞）；`saveSession` 的
 * `JSON.stringify` 把空洞写成 `null`；`loadSession` 不归一化；
 * 旧谓词 `botIds?.[seat] !== undefined` 把 `null` 也当作「有 botId」
 * ⇒ 重载后人类座位被机器人豁免：trustees 恒 false、toggle 抛 BAD_PARAM、
 * 超时不计数。
 *
 * 判据：含部分机器人的会话 save→load 后，人类座位仍保留托管治理能力。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { GameService } from '../src/game/game.service';
import { buildPlayerView } from '../src/game/view.builder';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 座位 1 是机器人、座位 0/2 是人类（部分机器人的典型会话）。 */
const mixedDto = (roomCode: string) => ({
  roomCode,
  baseScore: 100,
  players: [
    { id: 'user-1', seat: 0, isRobot: false },
    {
      id: 'p_bot1',
      seat: 1,
      isRobot: true,
      botId: 'bot-1',
      skillLevel: 'beginner' as const,
      thinkingSpeed: 2000,
    },
    { id: 'user-3', seat: 2, isRobot: false },
  ],
});

/** 每个「进程」一个实例 = 空内存缓存 ⇒ `getSession` 必走 Redis 反序列化。 */
const makeService = (): GameService => {
  const service = new GameService(redisDouble as unknown as Redis);
  // 座位 0 先叫 ⇒ 开局时机器人（座位 1）不会被驱动。
  service.random = () => 0;
  service.robotDelay = async () => {};
  service.robotClient = {
    decide: async () => ({ kind: 'pass', source: 'douzero' }),
  } as never;
  return service;
};

describe('P0-1 会话重载后的人类座位不被误判为机器人', () => {
  beforeEach(() => {
    resetRedisDouble();
  });

  it('save→load 后人类座位的 trustees 不被清零', async () => {
    const first = makeService();
    await first.startGame(mixedDto('P0-1-A'));
    await first.applyTrustee({
      roomCode: 'P0-1-A',
      userId: 'user-1',
      on: true,
      via: 'manual',
    });

    const reloaded = makeService();
    const session = (await reloaded.getSession('P0-1-A'))!;

    expect(buildPlayerView(session, 0).trustees).toEqual([true, false, false]);
  });

  it('save→load 后人类座位仍可 toggle 托管（不被当作机器人拒绝）', async () => {
    const first = makeService();
    await first.startGame(mixedDto('P0-1-B'));

    const reloaded = makeService();
    const before = (await reloaded.getSession('P0-1-B'))!;
    const res = await reloaded.applyTrustee({
      roomCode: 'P0-1-B',
      userId: 'user-1',
      on: true,
      via: 'manual',
    });

    expect(res.version).toBe(before.version + 1);
  });

  it('save→load 后人类座位超时计数仍生效', async () => {
    const first = makeService();
    await first.startGame(mixedDto('P0-1-C'));

    const reloaded = makeService();
    await reloaded['onTurnTimeout']('P0-1-C');

    const after = (await reloaded.getSession('P0-1-C'))!;
    expect(after.players[0].timeoutCount).toBe(1);
  });
});
