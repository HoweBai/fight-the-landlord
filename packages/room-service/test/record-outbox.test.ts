// packages/room-service/test/record-outbox.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ErrCode, type RecordWriteRequest } from '@fight-the-landlord/protocol';
import {
  RECORD_OUTBOX_KEY,
  RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP,
  RECORD_OUTBOX_MAX_PER_SWEEP,
  RECORD_OUTBOX_TTL_MS,
  RecordOutboxService,
  recordOutboxField,
} from '../src/gateway/record-outbox.service';
import { RecordClientError, type RecordClient } from '../src/gateway/record.client';
import {
  recordOutboxOldestSeconds,
  recordOutboxResendTotal,
  recordOutboxSize,
} from '../src/metrics/room.metrics';
import { exactSeriesValue } from './helpers/metric-readout';
import { asRedis, createFakeRedis } from './helpers/fake-redis';

const REQUEST = (over: Partial<RecordWriteRequest> = {}): RecordWriteRequest => ({
  roomCode: 'ROOM1',
  gameVersion: 1,
  mode: 'random',
  baseScore: 15,
  result: {
    roomCode: 'ROOM1',
    baseScore: 15,
    winner: 'landlord',
    landlordSeat: 0,
    farmerSeats: [1, 2],
    multiplier: 1,
    spring: 'none',
    landlordScoreChange: 30,
    farmerScoreChange: -15,
  },
  seats: [
    { seat: 0, userId: 'alice', isRobot: false, robotId: null, hand: '11'.repeat(17) },
    { seat: 1, userId: null, isRobot: true, robotId: 'bot-1', hand: '22'.repeat(17) },
    { seat: 2, userId: null, isRobot: true, robotId: 'bot-2', hand: '33'.repeat(17) },
  ],
  bottomCards: '44'.repeat(3),
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  ...over,
});

function makeSvc() {
  const redis = createFakeRedis();
  const record = { write: vi.fn().mockResolvedValue(true) };
  const svc = new RecordOutboxService(asRedis(redis), record as unknown as RecordClient);
  return { redis, record, svc };
}

describe('C1 RecordOutboxService：enqueue/ack（CAS）', () => {
  it('enqueue 写前入箱：field/结构/createdAt/gameType 归一（缺省 ddz）', async () => {
    const { redis, svc } = makeSvc();
    const request = REQUEST();
    const result = await svc.enqueue(request);
    expect(result.status).toBe('queued');
    expect(result.raw).toBeTypeOf('string');
    const raw = await redis.hget(RECORD_OUTBOX_KEY, recordOutboxField(request));
    expect(raw).toBe(result.raw);
    const stored = JSON.parse(raw!) as { request: RecordWriteRequest; createdAt: number; gameType: string };
    expect(stored.request).toEqual(request);
    expect(stored.gameType).toBe('doudizhu');
    expect(Number.isFinite(stored.createdAt)).toBe(true);
  });

  it('同 endedAt 重复 enqueue ⇒ existing（field 不变）', async () => {
    const { redis, svc } = makeSvc();
    const request = REQUEST();
    const first = await svc.enqueue(request);
    const rawBefore = await redis.hget(RECORD_OUTBOX_KEY, recordOutboxField(request));
    const second = await svc.enqueue(request);
    expect(second.status).toBe('existing');
    expect(second.raw).toBe(rawBefore);
    expect(await redis.hget(RECORD_OUTBOX_KEY, recordOutboxField(request))).toBe(rawBefore);
    expect(first.status).toBe('queued');
  });

  it('同 field 不同 endedAt ⇒ conflict，不覆盖旧条目', async () => {
    const { redis, svc } = makeSvc();
    const request = REQUEST();
    await svc.enqueue(request);
    const field = recordOutboxField(request);
    const rawBefore = await redis.hget(RECORD_OUTBOX_KEY, field);
    const conflict = await svc.enqueue(REQUEST({ endedAt: request.endedAt + 1 }));
    expect(conflict.status).toBe('conflict');
    expect(conflict.raw).toBeUndefined();
    expect(await redis.hget(RECORD_OUTBOX_KEY, field)).toBe(rawBefore);
  });

  it('existing 非 JSON ⇒ conflict（不覆盖）', async () => {
    const { redis, svc } = makeSvc();
    const field = recordOutboxField(REQUEST());
    await redis.hset(RECORD_OUTBOX_KEY, field, 'not-json');
    const result = await svc.enqueue(REQUEST());
    expect(result.status).toBe('conflict');
    expect(await redis.hget(RECORD_OUTBOX_KEY, field)).toBe('not-json');
  });

  it('existing 合法 JSON 但结构不合法（缺 endedAt）⇒ conflict（不覆盖）', async () => {
    const { redis, svc } = makeSvc();
    const field = recordOutboxField(REQUEST());
    const broken = { request: { ...REQUEST(), endedAt: undefined }, createdAt: 1 };
    await redis.hset(RECORD_OUTBOX_KEY, field, JSON.stringify(broken));
    const before = await redis.hget(RECORD_OUTBOX_KEY, field);
    const result = await svc.enqueue(REQUEST());
    expect(result.status).toBe('conflict');
    expect(await redis.hget(RECORD_OUTBOX_KEY, field)).toBe(before);
  });

  it('Redis 故障 ⇒ unavailable，不抛', async () => {
    const { redis, svc } = makeSvc();
    const hsetnx = redis.hsetnx as unknown as ReturnType<typeof vi.fn>;
    hsetnx.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.enqueue(REQUEST())).resolves.toEqual({ status: 'unavailable' });
  });

  it('ack：raw 匹配才删除；不匹配/不存在不删', async () => {
    const { redis, svc } = makeSvc();
    const request = REQUEST();
    const queued = await svc.enqueue(request);
    const field = recordOutboxField(request);
    expect(await svc.ack(field, `${queued.raw!}-mismatch`)).toBe(false);
    expect(await redis.hget(RECORD_OUTBOX_KEY, field)).toBe(queued.raw);
    expect(await svc.ack(field, queued.raw!)).toBe(true);
    expect(await redis.hget(RECORD_OUTBOX_KEY, field)).toBeNull();
  });

  it('ack Redis 故障 ⇒ false，不抛', async () => {
    const { redis, svc } = makeSvc();
    const evalMock = redis.eval as unknown as ReturnType<typeof vi.fn>;
    evalMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.ack('ROOM1:1', 'raw')).resolves.toBe(false);
  });
});

describe('C1 RecordOutboxService.sweep', () => {
  const NOW = 1_700_000_000_000;
  const entry = (over: Partial<RecordWriteRequest> = {}, createdAt = NOW, gameType = 'doudizhu'): string =>
    JSON.stringify({ request: REQUEST(over), createdAt, gameType });

  async function counter(result: string, gameType = 'doudizhu'): Promise<number> {
    return (await exactSeriesValue(recordOutboxResendTotal, { game_type: gameType, result })) ?? 0;
  }

  it('ok：投递成功 ⇒ CAS 删除 + ok 计数 + gauge 归零', async () => {
    const { redis, record, svc } = makeSvc();
    await redis.hset(RECORD_OUTBOX_KEY, 'ROOM1:1', entry());
    const before = await counter('ok');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(record.write).toHaveBeenCalledTimes(1);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'ROOM1:1')).toBeNull();
    expect(await counter('ok')).toBe(before + 1);
    expect(await exactSeriesValue(recordOutboxSize, { game_type: 'doudizhu' })).toBe(0);
  });

  it('replayed：write=false 也算成功；CAS 删除 + replayed', async () => {
    const { redis, record, svc } = makeSvc();
    record.write.mockResolvedValueOnce(false);
    await redis.hset(RECORD_OUTBOX_KEY, 'ROOM1:1', entry());
    const before = await counter('replayed');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'ROOM1:1')).toBeNull();
    expect(await counter('replayed')).toBe(before + 1);
  });

  it('传输/未知异常 ⇒ failed + 保留（下一轮再试）', async () => {
    const { redis, record, svc } = makeSvc();
    record.write.mockRejectedValueOnce(new Error('down'));
    await redis.hset(RECORD_OUTBOX_KEY, 'ROOM1:1', entry());
    const before = await counter('failed');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'ROOM1:1')).toBe(entry());
    expect(await counter('failed')).toBe(before + 1);
    expect(await exactSeriesValue(recordOutboxSize, { game_type: 'doudizhu' })).toBe(1);
  });

  it('确定性 10001 ⇒ rejected + 删除；未知 RecordClientError ⇒ failed + 保留', async () => {
    const { redis, record, svc } = makeSvc();
    record.write.mockRejectedValueOnce(new RecordClientError(ErrCode.BAD_PARAM, 'bad payload'));
    await redis.hset(RECORD_OUTBOX_KEY, 'ROOM1:1', entry());
    const rejectedBefore = await counter('rejected');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'ROOM1:1')).toBeNull();
    expect(await counter('rejected')).toBe(rejectedBefore + 1);

    record.write.mockRejectedValueOnce(new RecordClientError(ErrCode.E_INSUFFICIENT_FUNDS, 'unknown'));
    await redis.hset(RECORD_OUTBOX_KEY, 'ROOM1:2', entry({ gameVersion: 2 } as never));
    const failedBefore = await counter('failed');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'ROOM1:2')).not.toBeNull();
    expect(await counter('failed')).toBe(failedBefore + 1);
  });

  it('坏 JSON/坏结构 ⇒ corrupt + 删除', async () => {
    const { redis, svc } = makeSvc();
    await redis.hset(RECORD_OUTBOX_KEY, 'BAD:1', 'not-json');
    await redis.hset(RECORD_OUTBOX_KEY, 'BAD:2', JSON.stringify({ request: { roomCode: 'x' } }));
    const before = await counter('corrupt');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await redis.hgetall(RECORD_OUTBOX_KEY)).toEqual({});
    expect(await counter('corrupt')).toBe(before + 2);
  });

  it('TTL 超龄 ⇒ abandoned + 删除', async () => {
    const { redis, record, svc } = makeSvc();
    await redis.hset(RECORD_OUTBOX_KEY, 'OLD:1', entry({}, NOW - RECORD_OUTBOX_TTL_MS - 1));
    const before = await counter('abandoned');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(record.write).not.toHaveBeenCalled();
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'OLD:1')).toBeNull();
    expect(await counter('abandoned')).toBe(before + 1);
  });

  it('非法/未来超容差 createdAt ⇒ CAS 自愈为 now，仍投递一次；自愈成功用 new raw 删除', async () => {
    const { redis, record, svc } = makeSvc();
    await redis.hset(RECORD_OUTBOX_KEY, 'FIX:1', entry({}, Number.NaN));
    await redis.hset(RECORD_OUTBOX_KEY, 'FIX:2', entry({}, NOW + 600_000));
    const before = await counter('ok');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(record.write).toHaveBeenCalledTimes(2);
    expect(await redis.hgetall(RECORD_OUTBOX_KEY)).toEqual({});
    expect(await counter('ok')).toBe(before + 2);
  });

  it('未来 5min 内视为合法（不自愈）；超过 5min 才自愈', async () => {
    const { redis, record, svc } = makeSvc();
    await redis.hset(RECORD_OUTBOX_KEY, 'FUT:1', entry({}, NOW + 60_000));
    await redis.hset(RECORD_OUTBOX_KEY, 'FUT:2', entry({}, NOW + 300_001));
    const evalMock = redis.eval as unknown as ReturnType<typeof vi.fn>;
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(record.write).toHaveBeenCalledTimes(2);
    // 只有 FUT:2 需要 CAS_HSET 自愈（FUT:1 合法）
    expect(evalMock.mock.calls.some((call) => String(call[0]).includes("redis.call('HSET'"))).toBe(true);
    expect(await redis.hgetall(RECORD_OUTBOX_KEY)).toEqual({});
  });

  it('快照后同 field 被新条目替换 ⇒ 旧 CAS 删除不得删新', async () => {
    const { redis, svc } = makeSvc();
    const oldRaw = entry({}, Number.NaN);
    await redis.hset(RECORD_OUTBOX_KEY, 'RACE:1', oldRaw);
    const snapshot = { ...(await redis.hgetall(RECORD_OUTBOX_KEY)) };
    const newRaw = entry({ endedAt: REQUEST().endedAt + 1 }, NOW);
    await redis.hset(RECORD_OUTBOX_KEY, 'RACE:1', newRaw);
    await svc.sweep(snapshot, NOW);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'RACE:1')).toBe(newRaw);
  });

  it('最老优先 + 100 条上限 + 2s 预算', async () => {
    const { redis, record, svc } = makeSvc();
    const fields: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      const field = `CAP:${i}`;
      fields.push(field);
      await redis.hset(RECORD_OUTBOX_KEY, field, entry({ gameVersion: 1 }, NOW - 10_000 + i));
    }
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(record.write).toHaveBeenCalledTimes(RECORD_OUTBOX_MAX_PER_SWEEP);
    expect(await redis.hget(RECORD_OUTBOX_KEY, 'CAP:100')).not.toBeNull();

    const clock = { value: 0 };
    record.write.mockClear();
    record.write.mockImplementation(async () => {
      clock.value += 3_000;
      return true;
    });
    await svc.sweep({ 'BUD:1': entry(), 'BUD:2': entry(), 'BUD:3': entry() }, NOW, () => clock.value);
    expect(record.write).toHaveBeenCalledTimes(1);
  });

  it('清理最多 500 条/轮（超出下轮）', async () => {
    const { redis, svc } = makeSvc();
    for (let i = 0; i < RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP + 1; i += 1) {
      await redis.hset(RECORD_OUTBOX_KEY, `CLEAN:${i}`, 'bad');
    }
    const before = await counter('corrupt');
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await counter('corrupt')).toBe(before + RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP);
    expect(await redis.hget(RECORD_OUTBOX_KEY, `CLEAN:${RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP}`)).not.toBeNull();
  });

  it('gauge 按玩法分箱；失败条目保留并计 age', async () => {
    const { redis, record, svc } = makeSvc();
    record.write.mockRejectedValue(new Error('down'));
    await redis.hset(RECORD_OUTBOX_KEY, 'G:1', entry({}, NOW - 5_000, 'doudizhu'));
    await redis.hset(RECORD_OUTBOX_KEY, 'G:2', entry({ gameVersion: 2 } as never, NOW - 10_000, 'paodekuai'));
    await svc.sweep(await redis.hgetall(RECORD_OUTBOX_KEY), NOW);
    expect(await exactSeriesValue(recordOutboxSize, { game_type: 'doudizhu' })).toBe(1);
    expect(await exactSeriesValue(recordOutboxSize, { game_type: 'paodekuai' })).toBe(1);
    expect(await exactSeriesValue(recordOutboxOldestSeconds, { game_type: 'doudizhu' })).toBe(5);
    expect(await exactSeriesValue(recordOutboxOldestSeconds, { game_type: 'paodekuai' })).toBe(10);
  });

  it('10k 条分类/排序基准（记录耗时；不做硬时限断言）', async () => {
    const { svc } = makeSvc();
    const raw: Record<string, string> = {};
    for (let i = 0; i < 10_000; i += 1) raw[`BENCH:${i}`] = entry({ gameVersion: i + 1 }, NOW - i);
    let first = true;
    const nowFn = (): number => {
      if (first) {
        first = false;
        return 0;
      }
      return 3_000;
    };
    const started = performance.now();
    await svc.sweep(raw, NOW, nowFn);
    const elapsed = performance.now() - started;
    // eslint-disable-next-line no-console
    console.info(`[C1] 10k record outbox classify+sort: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(5_000);
  });
});

