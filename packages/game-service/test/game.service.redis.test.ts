import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeCards, encodeHand } from '@fight-the-landlord/protocol';
import type { GameSession } from '@fight-the-landlord/shared';
import { GameService, GAME_EVENTS_CHANNEL } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble, type RedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});


const startDto = (roomCode: string) => ({
  roomCode,
  baseScore: 100,
  players: [
    { id: 'user-1', seat: 0, isRobot: false },
    { id: 'user-2', seat: 1, isRobot: false },
    { id: 'user-3', seat: 2, isRobot: false },
  ],
});

describe('GameService Redis publish', () => {
  let service: GameService;
  let redis: RedisDouble;

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = redisDouble;
    resetRedisDouble();
    service = new GameService(redis as unknown as Redis);
  });

  it('publishes game.ended on the single game:events channel when the game settles', async () => {
    await service.startGame(startDto('TEST-REDIS'));

    await service.notifyRoomEnded('TEST-REDIS', {
      roomCode: 'TEST-REDIS',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 30,
      farmerScoreChange: -15,
    });

    expect(redis.publish).toHaveBeenCalledWith(GAME_EVENTS_CHANNEL, expect.stringContaining('game.ended'));

    const published = JSON.parse(redis.publish.mock.calls.at(-1)![1] as string);
    expect(published.event).toBe('game.ended');
    expect(published.roomCode).toBe('TEST-REDIS');
    expect(published.result.winner).toBe('landlord');
  });

  it('quits the redis connection on shutdown', async () => {
    await service.onApplicationShutdown();
    expect(redis.quit).toHaveBeenCalled();
  });

  /**
   * C3（记录片 T3）：`game.ended` 的 `record` 信封 + 旧会话窗口守卫。
   *
   * 驱动方式照 `game.service.test.ts` 的 N17 用例：公开 API 走到 `playing`
   * （seat 2 为地主），把地主的最后一手摆成单张，再走一次真实的 `playCards`
   * 让 `finishTransition()` 走 winner 分支、发出 `game.ended`。
   */
  describe('C3：game.ended 的 record 信封 + 旧会话窗口守卫', () => {
    beforeEach(() => {
      // 起始座位确定（座位 0 先叫）；具同 N17——不注入则叫抢夹具随起始座位 1/3 概率不成立。
      service.random = () => 0;
    });

    /** 走公开 API 到「seat 2 为地主、行将终局」的会话（叫抢夹具同 N17）。 */
    const driveToPlaying = async (roomCode: string): Promise<GameSession> => {
      await service.startGame(startDto(roomCode));
      await service.bid(roomCode, 'user-1', true);
      await service.bid(roomCode, 'user-2', false);
      await service.bid(roomCode, 'user-3', true);
      // 片① R2：第 3 拍「抢」⇒ 反抢帧派回首个声称者（座位 0）⇒ 还需一拍才收口（同 N17）。
      await service.bid(roomCode, 'user-1', false); // → playing，seat 2 为地主
      const session = (await service.getSnapshot(roomCode))!;
      expect(session.state).toBe('playing');
      expect(session.players[2]!.isLandlord).toBe(true);
      return session;
    };

    type EndedPayload = {
      event: string;
      record?: unknown;
      result?: { winner?: string };
    };

    /** 摆终局夹具并真实出最后一手；返回 `game.ended` 载荷（找不到即断言失败）。 */
    const finishGame = async (roomCode: string, session: GameSession): Promise<EndedPayload> => {
      redis._published.length = 0; // 只观察终局那一次状态转移
      session.players[2]!.hand = [{ r: 3, s: 0 }];
      session.players[0]!.hand = [{ r: 4, s: 0 }, { r: 5, s: 0 }];
      session.players[1]!.hand = [{ r: 6, s: 0 }, { r: 7, s: 0 }];
      session.currentPlayer = 2;
      session.lastPlayedHand = null;
      session.lastPlayerIdx = -1;
      // 夹具必须让**春天不成立**（R183 的教训：spring 与倍数断言会互相污染）
      session.playPhase = { ...session.playPhase, landlordPlays: 0, farmerPlays: 2, bombCount: 0 };

      await service.playCards(roomCode, 'user-3', [{ r: 3, s: 0 }]);

      const ended = redis._published
        .map(([, payload]) => JSON.parse(payload) as EndedPayload)
        .find((e) => e.event === 'game.ended');
      expect(ended, '终局必须发 game.ended').toBeDefined();
      return ended!;
    };

    it('有快照 ⇒ payload 含 record：startedAt=createdAt、座位序恰 3、hand 34/6、与 initialHands 编码一致', async () => {
      const roomCode = 'REC-ENV1';
      const session = await driveToPlaying(roomCode);
      const initialHands = session.initialHands!;

      const ended = await finishGame(roomCode, session);
      const record = ended.record as {
        startedAt: number;
        seats: Array<{ seat: number; playerId: string; hand: string }>;
        bottomCards: string;
      };
      expect(record, '有 initialHands 的会话必须附 record').toBeDefined();

      // 信封形状逐字（D1 + 多玩法片）：旧三键 + gameType/playerCount；
      // 座位项仍恰好三键（isBot/robotId 不进信封）
      expect(Object.keys(record).sort()).toEqual([
        'bottomCards',
        'gameType',
        'playerCount',
        'seats',
        'startedAt',
      ]);
      expect(record.startedAt).toBe(session.createdAt);
      expect(record.seats).toHaveLength(3);
      session.players.forEach((player, seat) => {
        expect(Object.keys(record.seats[seat]!).sort()).toEqual(['hand', 'playerId', 'seat']);
        expect(record.seats[seat]!.seat).toBe(seat);
        expect(record.seats[seat]!.playerId).toBe(player.id);
      });
      // hand/bottomCards = 座位序上的 initialHands/底牌规范编码（定长小写 hex）
      initialHands.forEach((hand, seat) => {
        expect(record.seats[seat]!.hand).toBe(encodeHand(hand));
        expect(record.seats[seat]!.hand).toMatch(/^[0-9a-f]{34}$/);
      });
      expect(record.bottomCards).toBe(encodeCards(session.bottomCards));
      expect(record.bottomCards).toMatch(/^[0-9a-f]{6}$/);
    });

    it('无 initialHands（旧会话窗口）⇒ payload 无 record 键、game.ended 照发且不抛', async () => {
      const roomCode = 'REC-NOSNAP';
      const session = await driveToPlaying(roomCode);
      // 模拟部署窗口内的旧会话：升级前写出的 Redis 数据反序列化后没有这个键
      delete session.initialHands;

      const ended = await finishGame(roomCode, session);
      expect('record' in ended).toBe(false);
      // game.ended 照常发布（不因记录面缺失而吞事件）——result 仍在
      expect(ended.result?.winner).toBe('landlord');
    });
  });
});
