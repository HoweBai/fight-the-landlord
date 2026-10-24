// packages/game-service/test/full-game.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameState } from '@fight-the-landlord/shared';
import { GameService } from '../src/game/game.service';
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

describe('Full Game Flow Integration', () => {
  let service: GameService;
  let redis: RedisDouble;

  beforeEach(async () => {
    redis = redisDouble;
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致。
    // 文件级统一注入：INTEG2 与 INTEG3 都以「user-1 = 座位 0 先动」写就 ——
    // 只改其中一处会漏（本注释即计划里点名的那处坑）。
    service.random = () => 0;
    service.robotDelay = async () => {}; // 防御性：若未来推进到机器人回合，避免真实 1–3s 等待
  });

  it('1 human + 2 robots can start a game', async () => {
    const started = await service.startGame({
      roomCode: 'INTEG1',
      baseScore: 100,
      players: [
        { id: 'human-1', seat: 0, isRobot: false },
        { id: 'p_12345678', seat: 1, isRobot: true, botId: 'bot-uuid-1', skillLevel: 'advanced' },
        { id: 'p_87654321', seat: 2, isRobot: true, botId: 'bot-uuid-2', skillLevel: 'beginner' },
      ],
    });
    const session = await service.getSnapshot('INTEG1');

    expect(started.state).toBe(GameState.Bidding);
    expect(session!.players).toHaveLength(3);
    expect(session!.players[0]!.hand.length).toBe(17);
    expect(session!.bottomCards.length).toBe(3);
    // 机器人内部 ID 只存在于服务端，绝不进任何推送（§9.1 不可区分性）
    expect(session!.botIds).toEqual([undefined, 'bot-uuid-1', 'bot-uuid-2']);
    const published = redis._published.map(([, p]) => p).join('');
    expect(published).not.toContain('bot-uuid-1');
    expect(published).not.toContain('isRobot');
    expect(published).not.toContain('skillLevel');
  });

  it('handles the bid flow', async () => {
    await service.startGame(startDto('INTEG2'));

    const bid1 = await service.bid('INTEG2', 'user-1', true);
    expect(bid1.state).toBe(GameState.Bidding);
    expect(bid1.bidPhase.landlordCandidate).toBe(0);
    expect(bid1.bidPhase.bidMultiplier).toBe(2);

    const bid2 = await service.bid('INTEG2', 'user-2', false);
    expect(bid2.bidPhase.bidPasses).toBe(1);

    const bid3 = await service.bid('INTEG2', 'user-3', true);
    // 片① R2：第 3 拍「抢」⇒ 反抢帧派回**首个声称者**（座位 0）⇒ 本轮尚未收口。
    // ⚠️ 旧断言「3 拍即 Playing」随本片作废（规格 §6.1）；改法与 bid.test.ts 的
    // C23 用例同款（Task 2 报告 :162-167）：补第 4 拍，原断言逐字保留、只换来源。
    expect(bid3.state).toBe(GameState.Bidding);
    expect(bid3.bidPhase.antiRobGranted).toBe(true);

    // 反抢者（座位 0）「不抢」⇒ 收口：末位声称者（座位 2）为地主（§4.2 出口 ②）
    const bid4 = await service.bid('INTEG2', 'user-1', false);
    expect(bid4.state).toBe(GameState.Playing);
    expect(bid4.players[2]!.isLandlord).toBe(true);

    // C15/R101：地主拿到 20 张，且底牌确实在其手牌里（端到端钉住「真源 + 两处补偿已删」）
    expect(bid4.players[2]!.hand).toHaveLength(20);
    expect(bid4.bottomCards).toHaveLength(3);
    for (const c of bid4.bottomCards) expect(bid4.players[2]!.hand).toContain(c);
    // 农民仍是 17
    expect(bid4.players[0]!.hand).toHaveLength(17);
    expect(bid4.players[1]!.hand).toHaveLength(17);
    // §3.4-3：landlordCandidate 是「谁是地主」的唯一来源
    expect(bid4.bidPhase.landlordCandidate).toBe(2);
  });

  it('tracks version correctly through the game flow', async () => {
    const session = await service.startGame(startDto('INTEG3'));
    const afterBid = await service.bid('INTEG3', 'user-1', true);
    expect(afterBid.version).toBe(session.version + 1);
  });
});
