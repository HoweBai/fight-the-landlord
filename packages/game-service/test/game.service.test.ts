import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState } from '@fight-the-landlord/shared';
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import { GameService } from '../src/game/game.service';
import { classifyRuleError } from '../src/game/rule-error.mapping';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble, type RedisDouble } from './helpers-ioredis';

/** R696：牌是 `{r, s}`。夹具只关心点数，故 `s` 取 0。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 取回被 vi.mock 注入的同一个替身，让断言能看到它的调用与存储。 */

describe('GameService', () => {
  let service: GameService;
  let redis: RedisDouble;

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = redisDouble;
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致。
    // 文件级统一注入：TEST2 / CAS1 / CAS2 / PUB2 / END1 的叫抢夹具都按
    // 「user-1 = 座位 0 先动」写就 —— 不注入则随起始座位 1/3 概率过。
    service.random = () => 0;
  });

  const start = (roomCode = 'TEST1') =>
    service.startGame({
      roomCode,
      baseScore: 100,
      players: [
        { id: 'user-1', seat: 0, isRobot: false },
        { id: 'user-2', seat: 1, isRobot: false },
        { id: 'user-3', seat: 2, isRobot: false },
      ],
    });

  it('creates game and deals cards', async () => {
    const started = await start();
    const session = await service.getSnapshot('TEST1');

    expect(started.state).toBe(GameState.Bidding);
    expect(session!.players).toHaveLength(3);
    expect(session!.players[0]!.hand.length).toBe(17);
    expect(session!.bottomCards.length).toBe(3);
    expect(session!.baseScore).toBe(100);
  });

  it('is idempotent for the same roomCode (repeated game.start does not redeal)', async () => {
    const first = await start('IDEM1');
    const second = await service.startGame({
      roomCode: 'IDEM1',
      baseScore: 100,
      players: [
        { id: 'other-a', seat: 0, isRobot: false },
        { id: 'other-b', seat: 1, isRobot: false },
        { id: 'other-c', seat: 2, isRobot: false },
      ],
    });
    expect(second.version).toBe(first.version);
    const session = await service.getSnapshot('IDEM1');
    expect(session!.players[0]!.id).toBe('user-1');
  });

  it('🔴 底分必须是正整数：0 / 负数 / 小数 ⇒ BAD_PARAM，且不建会话', async () => {
    const players = [
      { id: 'user-1', seat: 0, isRobot: false },
      { id: 'user-2', seat: 1, isRobot: false },
      { id: 'user-3', seat: 2, isRobot: false },
    ];
    for (const [i, baseScore] of [0, -1, 1.5].entries()) {
      const roomCode = `BADBS${i}`;
      await expect(service.startGame({ roomCode, baseScore, players })).rejects.toMatchObject({
        code: ErrCode.BAD_PARAM,
      });
      expect(await service.getSnapshot(roomCode), '非法底分不得建会话').toBeNull();
    }
  });

  it('🔴 已有会话的重复 start：即便本次底分非法也走幂等返回', async () => {
    const first = await start('IDEM-BAD');
    const replay = await service.startGame({
      roomCode: 'IDEM-BAD',
      baseScore: 0,
      players: [{ id: 'other', seat: 0, isRobot: false }],
    });
    expect(replay.version).toBe(first.version);
  });

  it('🔴 缺失 baseScore（类型逃逸）⇒ BAD_PARAM，且不建会话', async () => {
    const dto = {
      roomCode: 'BADBS-MISSING',
      players: [{ id: 'u1', seat: 0, isRobot: false }],
    } as unknown as Parameters<GameService['startGame']>[0];

    await expect(service.startGame(dto)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    expect(await service.getSnapshot('BADBS-MISSING')).toBeNull();
  });

  it('persists the session to Redis as the source of truth', async () => {
    await start('REDIS1');
    expect(redis.set).toHaveBeenCalledWith(
      'game:session:REDIS1',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
    expect(redis._store.has('game:session:REDIS1')).toBe(true);
  });

  it('reads the session back from Redis when the in-process cache is cold', async () => {
    await start('COLD1');
    // 模拟重启：新的服务实例、同样的 Redis
    const fresh = new GameService(redisDouble as unknown as Redis);
    const session = await fresh.getSnapshot('COLD1');
    expect(session).not.toBeNull();
    expect(session!.roomCode).toBe('COLD1');
  });

  it('sets turnDeadlineAt on start', async () => {
    const before = Date.now();
    await start('DEADLINE1');
    const session = await service.getSnapshot('DEADLINE1');
    expect(session!.turnDeadlineAt).toBeGreaterThanOrEqual(before);
  });

  it('handles bid and increments version', async () => {
    const session = await start('TEST2');
    const before = session.version;
    const bidResult = await service.bid('TEST2', 'user-1', true);
    expect(bidResult.state).toBe(GameState.Bidding);
    expect(bidResult.version).toBe(before + 1);
  });

  it('returns null for an unknown game', async () => {
    expect(await service.getSnapshot('NONEXIST')).toBeNull();
  });

  it('rejects an action with a stale baseVersion (CAS → 13004)', async () => {
    const session = await start('CAS1');
    await service.bid('CAS1', 'user-1', true);
    await expect(service.bid('CAS1', 'user-2', true, session.version)).rejects.toMatchObject({
      code: 13004,
    });
  });

  it('accepts an action whose baseVersion matches the current version', async () => {
    const session = await start('CAS2');
    const updated = await service.bid('CAS2', 'user-1', true, session.version);
    expect(updated.version).toBe(session.version + 1);
  });

  it('rejects an action for a game that does not exist (12001)', async () => {
    await expect(service.bid('NOPE', 'user-1', true)).rejects.toMatchObject({ code: 12001 });
  });

  it('maps rule-engine messages to 5-digit contract codes (偏差 E5)', async () => {
    expect(classifyRuleError(new Error('Not your turn'))).toBe(12003);
    expect(classifyRuleError(new Error('Not your turn to bid'))).toBe(12003);
    expect(classifyRuleError(new Error('Player alice not found'))).toBe(12004);
    // N16：这两条原先与玩法 §6.1-2/3、§11.1 **方向相反**，切片 9 按文档收敛（期望值互换）。
    expect(classifyRuleError(new Error('Invalid move - cannot beat last hand'))).toBe(13006);
    expect(classifyRuleError(new Error('Card 99 not in hand'))).toBe(13001);
    expect(classifyRuleError(new Error('不能出空牌'))).toBe(13006);
    expect(classifyRuleError(new Error('Game is not in playing state'))).toBe(13001);
    expect(classifyRuleError(new Error('weird unknown failure'))).toBe(13001);
  });

  it('publishes per-seat trimmed views on game:events', async () => {
    await start('PUB1');
    const raw = redis._published.find(([, payload]) => payload.includes('game.started'))?.[1];
    expect(raw).toBeDefined();
    const event = JSON.parse(raw!);

    expect(event.event).toBe('game.started');
    expect(event.roomCode).toBe('PUB1');
    expect(event.seatViews).toHaveLength(3);
    for (const view of event.seatViews) {
      expect(view.hand.length).toBe(17);
      expect(view.cardCounts).toEqual([17, 17, 17]);
    }
    expect(raw).not.toContain('actionLog');
    expect(raw).not.toContain('isRobot');
  });

  it('publishes game.state_updated after an action', async () => {
    await start('PUB2');
    await service.bid('PUB2', 'user-1', true);
    const events = redis._published
      .map(([, payload]) => JSON.parse(payload).event as string)
      .filter((e) => e === 'game.state_updated');
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * N17 / R187：局终也必须下发一版 `state === 'ended'` 的**裁剪视图**。
   *
   * 驱动方式：公开 API 走到 `playing`（seat 2 是地主），然后把地主的最后一手
   * 摆成单张 `3`（夹具直接改写真源对象 —— `getSnapshot()` 返回的就是缓存里那一个），
   * 再走一次真实的 `playCards`，使 `finishTransition()` 走 winner 分支。
   */
  it('N17：局终先发 state==="ended" 的裁剪视图，再发 game.ended（§6.7 顺序）', async () => {
    await start('END1');
    await service.bid('END1', 'user-1', true);
    await service.bid('END1', 'user-2', false);
    await service.bid('END1', 'user-3', true);
    // 片① R2：第 3 拍「抢」⇒ 反抢帧派回**首个声称者**（座位 0）⇒ 还需第 4 拍才收口
    //（判据同 bid.test.ts 的 C23 用例）。反抢者「不抢」⇒ 末位声称者（座位 2）为地主。
    await service.bid('END1', 'user-1', false); // → playing，seat 2 为地主

    const session = (await service.getSnapshot('END1'))!;
    expect(session.state).toBe(GameState.Playing);
    expect(session.players[2]!.isLandlord).toBe(true);

    // 只观察**终局那一次**状态转移
    redis._published.length = 0;
    session.players[2]!.hand = h(3);
    session.players[0]!.hand = h(4, 5);
    session.players[1]!.hand = h(6, 7);
    session.currentPlayer = 2;
    session.lastPlayedHand = null;
    session.lastPlayerIdx = -1;
    // 夹具必须让**春天不成立**：否则 `spring` 与倍数的断言会互相污染（R183 的教训）
    session.playPhase = { ...session.playPhase, landlordPlays: 0, farmerPlays: 2, bombCount: 0 };

    await service.playCards('END1', 'user-3', h(3));

    const events = redis._published.map(([, payload]) => JSON.parse(payload)) as Array<{
      event: string;
      version: number;
      seatViews?: Array<{ state: string; winner?: string; cardCounts: number[] }>;
      result?: Record<string, unknown>;
    }>;
    // 探针判别力（R115/R152）：先证明这两条事件**确实**被收集到
    const endedViewIdx = events.findIndex(
      (e) => e.event === 'game.state_updated' && e.seatViews?.every((v) => v.state === 'ended'),
    );
    const endedIdx = events.findIndex((e) => e.event === 'game.ended');
    expect(endedViewIdx, '终局必须发一版 state==="ended" 的 game.state_updated').toBeGreaterThanOrEqual(0);
    expect(endedIdx, '终局必须发 game.ended').toBeGreaterThanOrEqual(0);
    // ① 顺序：先视图、后结算（§6.7）
    expect(endedViewIdx).toBeLessThan(endedIdx);

    // ② 视图内容：三家都是 ended、版本等于最终版、胜者手牌为 0
    const finalVersion = events[endedIdx]!.version;
    const views = events[endedViewIdx]!.seatViews!;
    expect(views.map((v) => v.state)).toEqual(['ended', 'ended', 'ended']);
    expect(events[endedViewIdx]!.version).toBe(finalVersion);
    expect(views[2]!.cardCounts[2]).toBe(0);
    expect(views[2]!.winner).toBe('landlord');

    // ③ 载荷形状：逐字段等于契约（Task B2 之后不再拼 roomCode）
    const result = events[endedIdx]!.result!;
    expect(Object.keys(result).sort()).toEqual(
      [
        'baseScore', 'farmerScoreChange', 'farmerSeats', 'landlordScoreChange',
        'landlordSeat', 'multiplier', 'roomCode', 'spring', 'winner',
      ].sort(),
    );
    expect(result.roomCode).toBe('END1');
    expect(result.baseScore).toBe(100);
    expect(result.landlordSeat).toBe(2);
    expect(result.spring).toBe('none');
  });
});
