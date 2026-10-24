/**
 * Task 2.1 / spec RH3-a：`match:claim` **全模式**占用。
 *
 * 旧实现只给金币场写/读 claim（gold-only）；spec 要求所有模式在 `startGroup` 前占位，
 * 扫描器/随机抽取跳过仍持有 claim 的玩家 —— 否则「`game.start` 成功但 `onSeats` 延迟/失败」
 * 会让同一批人在下一轮扫描里被重复选进第二间房（人票两空的前置条件）。
 *
 * 判据 = 写入形态（SET … EX 30 NX）+ 筛选语义（跳过、不 cancelQueue）+ 多轮不重复 + TTL 放行。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MATCH_CLAIM_TTL_SECONDS } from '../src/match/match.service';
import { makeMatchServiceHarness } from './helpers/match-service-harness';

describe('match:claim 全模式防线', () => {
  const harnesses: Array<ReturnType<typeof makeMatchServiceHarness>> = [];
  const make = (options?: { callOnSeats?: boolean }): ReturnType<typeof makeMatchServiceHarness> => {
    const h = makeMatchServiceHarness(options);
    harnesses.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.service.onApplicationShutdown();
  });

  function claimWrites(redis: ReturnType<typeof makeMatchServiceHarness>['redis']): unknown[][] {
    const set = redis.set as unknown as { mock: { calls: unknown[][] } };
    return set.mock.calls.filter(([key]) => String(key).startsWith('match:claim:'));
  }

  it('C29（random）：组队成形 ⇒ 逐成员 SET match:claim:<id> = 1 EX 30 NX（组序）', async () => {
    const { service, redis } = make();
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'random', 15);
    await service.addToQueue('u2', 'random', 15);
    await service.addToQueue('u3', 'random', 15);

    await service.scanOnce();

    expect(claimWrites(redis)).toEqual([
      ['match:claim:u1', 'ABC123', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX'],
      ['match:claim:u2', 'ABC123', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX'],
      ['match:claim:u3', 'ABC123', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX'],
    ]);
    expect(redis._zsets.get('match:queue:random:15:global')?.size ?? 0).toBe(0); // 反空测：真的成了组
  });

  it('C29（practice）：好友房路径同样占用 claim（不再是 gold-only）', async () => {
    const { service, redis } = make();
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'practice', 15);
    await service.addToQueue('u2', 'practice', 15);
    await service.addToQueue('u3', 'practice', 15);

    await service.scanOnce();

    expect(claimWrites(redis).map((c) => c[0])).toEqual([
      'match:claim:u1',
      'match:claim:u2',
      'match:claim:u3',
    ]);
  });

  it('C29（gold 回归）：金币场仍逐成员占用（既有行为不因去 gold-only 而丢）', async () => {
    const { service, redis } = make();
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'gold', 15);
    await service.addToQueue('u2', 'gold', 15);
    await service.addToQueue('u3', 'gold', 15);

    await service.scanOnce();

    expect(claimWrites(redis).map((c) => c[0])).toEqual([
      'match:claim:u1',
      'match:claim:u2',
      'match:claim:u3',
    ]);
  });

  it('C30（random）：持有 claim 者被跳过、**不 cancelQueue**；其余三人照常成组', async () => {
    const { service, redis, rooms } = make();
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'random', 15);
    await service.addToQueue('u2', 'random', 15);
    await service.addToQueue('u3', 'random', 15);
    await service.addToQueue('u4', 'random', 15);
    // 模拟「重叠轮已把 u1 带走」：claim 在、票还在（onSeats 尚未/未能清票）
    await redis.set('match:claim:u1', 'ABC123', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX');

    await service.scanOnce();

    expect(rooms.createGameRoom).toHaveBeenCalledTimes(1);
    expect(rooms.createGameRoom).toHaveBeenCalledWith(['u2', 'u3', 'u4'], 'random', 15, 'doudizhu', 3);
    // 只跳过、不 cancelQueue：u1 的票与 meta 原样留队（claim 过期后可再被选中）
    expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
    expect(redis._hashes.get('match:meta:u1')).toBeDefined();
  });

  it('C30 多轮：start 成功但 onSeats 未清票 ⇒ 下一轮凭 claim(roomCode) 清陈旧票、不重复匹配', async () => {
    const { service, rooms, redis } = make({ callOnSeats: false });
    service.setClock(() => 1_700_000_000_000);
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) {
      await service.addToQueue(id, 'random', 15);
    }

    await service.scanOnce();
    await service.scanOnce();

    expect(rooms.createGameRoom.mock.calls.map((c) => c[0])).toEqual([
      ['u1', 'u2', 'u3'],
      ['u4', 'u5', 'u6'], // claim 筛选 ⇒ 第二批不可能再选到 u1..u3
    ]);
    // Task 2.4：第一间的 claim 值 = roomCode、房已 playing ⇒ 下一轮扫描把 u1..u3 的
    // 陈旧票（onSeats 未删）幂等清掉（按 queueKeyOfTicket）。
    for (const id of ['u1', 'u2', 'u3']) {
      expect(redis._zsets.get('match:queue:random:15:global')?.has(id) ?? false).toBe(false);
      expect(redis._hashes.has(`match:meta:${id}`)).toBe(false);
    }
  });

  it('C30 TTL：claim 过期（30s）后放行 —— 过期前不成组、推进 31s 后被重新选进', async () => {
    const { service, redis, rooms, clock } = make();
    service.setClock(() => clock.now);
    clock.set(1_700_000_000_000);
    await service.addToQueue('u1', 'random', 15);
    await service.addToQueue('u2', 'random', 15);
    await service.addToQueue('u3', 'random', 15);
    await redis.set('match:claim:u1', 'ABC123', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX');

    await service.scanOnce();
    expect(rooms.createGameRoom).not.toHaveBeenCalled(); // u1 被筛掉 ⇒ 2 人、窗口未到 ⇒ 本轮不动
    expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);

    clock.set(1_700_000_031_000); // claim 过期（30s + 1s）—— 推进的是**替身**时钟（TTL 判据）
    await service.scanOnce();

    expect(rooms.createGameRoom).toHaveBeenCalledTimes(1);
    expect(rooms.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
  });
});
