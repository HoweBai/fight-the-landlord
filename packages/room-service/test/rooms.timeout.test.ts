import { describe, expect, it } from 'vitest';
import {
  MANUAL_FILL_MAX_WAIT_MS,
  MANUAL_FILL_MIN_WAIT_MS,
  MANUAL_FILL_SPREAD_MS,
  MANUAL_ROOM_TIMEOUT_MS,
  WAITING_TIMEOUT_MS,
  isWaitingExpired,
  manualFillDeadlineAt,
  waitingTimeoutAt,
} from '../src/rooms/rooms.timeout';
import { RoomsService } from '../src/rooms/rooms.service';
import { asRedis, createFakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * E6（§3.1）：`Room.timeoutAt` —— **`waiting` 状态的超时时刻**（不是对局计时器）。
 *
 * 判据分两层：
 *  ① 纯函数层：`WAITING_TIMEOUT_MS` / `waitingTimeoutAt` / `isWaitingExpired`
 *     （**唯一**的等待窗口实现；只有 `waiting` 且越过 `timeoutAt` 才算过期）；
 *  ② 接线层：`create()` 真的把它写进元数据、`updateStatus()` 离开 `waiting` 时清零
 *     —— 只测纯函数抓不到「字段没被写」这类缺陷（那是本仓最常见的假绿形态）。
 */
describe('E6：§3.1 的 Room.timeoutAt（waiting 状态的超时时刻）', () => {
  it('waitingTimeoutAt = now + WAITING_TIMEOUT_MS（唯一实现，常量导出）', () => {
    expect(waitingTimeoutAt(1_000)).toBe(1_000 + WAITING_TIMEOUT_MS);
    expect(WAITING_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('只有 waiting 且已过期才算过期（playing/finished/cancelled 一律不算）', () => {
    const t = 5_000;
    const base = { timeoutAt: t } as const;
    expect(isWaitingExpired({ ...base, status: 'waiting' }, t)).toBe(true);
    expect(isWaitingExpired({ ...base, status: 'waiting' }, t - 1)).toBe(false);
    for (const status of ['playing', 'finished', 'cancelled'] as const) {
      expect(isWaitingExpired({ ...base, status }, t + 1), `${status} 不得被判过期`).toBe(false);
    }
    // 正对照：终态房间即使 `timeoutAt` 是 0（窗口已关闭）也不得被判过期
    expect(isWaitingExpired({ status: 'playing', timeoutAt: 0 }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('create 写 waitingTimeoutAt(同一 now)，updateStatus 离开 waiting 时清零', async () => {
    const redis = createFakeRedis();
    const service = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));

    const created = await service.create({ mode: 'random', roomCode: 'TIME01' });
    // createdAt 与 timeoutAt 必须来自**同一个** now（否则差值是 30000 或 30001，不可判）
    expect(created.timeoutAt - created.createdAt).toBe(WAITING_TIMEOUT_MS);
    expect((await service.findOne('TIME01'))!.timeoutAt).toBe(created.timeoutAt);

    const playing = await service.updateStatus('TIME01', 'playing');
    expect(playing.timeoutAt).toBe(0); // 窗口已关闭，不留一个过期时刻误导读侧
    expect((await service.findOne('TIME01'))!.timeoutAt).toBe(0);
    expect(isWaitingExpired(playing, created.timeoutAt + 1)).toBe(false);
  });
});

/**
 * 手动房间的**补位死线**（本片 · spec §3.1 / R903–R914）。
 *
 * 用户的裁决原话是「等 20 秒后，再 10 秒内的随机时间补机器人」⇒ 死线落在 **[20, 30] 秒**。
 *
 * ⚠️ **这是本片最容易被写成不可判的一段**：随机值不能直接断言（必然 flaky）
 * ⇒ 随机源**注入**（R914），判据落在**两端**与**硬不变量**上。
 */
describe('手动房间的补位死线（20s + rand[0,10s)）', () => {
  it('先等满 20 秒：死线的下界是 MANUAL_FILL_MIN_WAIT_MS（随机值为 0 时）', () => {
    expect(manualFillDeadlineAt(1_000, () => 0)).toBe(1_000 + MANUAL_FILL_MIN_WAIT_MS);
    expect(MANUAL_FILL_MIN_WAIT_MS).toBe(20_000); // 用户裁决的「先等 20 秒」
  });

  it('随后 10 秒内随机：随机源的取值直接决定死线，且**恒在上界之内**', () => {
    const now = 1_000;
    const atZero = manualFillDeadlineAt(now, () => 0);
    const atHalf = manualFillDeadlineAt(now, () => 0.5);
    const atMax = manualFillDeadlineAt(now, () => 0.99);

    expect(atHalf).toBeGreaterThan(atZero); // 随机源真的被用上了（不是装饰）
    expect(atHalf).toBeLessThanOrEqual(now + MANUAL_FILL_MAX_WAIT_MS);
    expect(atMax).toBeLessThan(now + MANUAL_FILL_MAX_WAIT_MS); // 上界**开区间**（rand∈[0,1)）
    expect(MANUAL_FILL_MAX_WAIT_MS).toBe(MANUAL_FILL_MIN_WAIT_MS + MANUAL_FILL_SPREAD_MS);
    expect(MANUAL_FILL_SPREAD_MS).toBe(10_000); // 用户裁决的「随后的 10 秒内」
  });

  /**
   * 🔴 **硬不变量**（spec §4 第 2 条）：回收窗口必须**晚于**补位死线上界。
   *
   * 不成立的话，死线取到 30s 附近的那批房间会在**正要补位时被回收任务删掉**
   *（`isWaitingExpired` 无条件删，它不看「是不是正要补位」）——
   * 那会是一个只在随机值偏大时出现的偶发缺陷，事后极难查。
   */
  it('MANUAL_ROOM_TIMEOUT_MS 严格大于补位死线上界（否则回收会贴脸删房）', () => {
    expect(MANUAL_ROOM_TIMEOUT_MS).toBeGreaterThan(MANUAL_FILL_MAX_WAIT_MS);
    // 至少要留够「补 3 个机器人 + game.start 重试一次」的余量 —— 10 秒是刻意留的
    expect(MANUAL_ROOM_TIMEOUT_MS - MANUAL_FILL_MAX_WAIT_MS).toBeGreaterThanOrEqual(10_000);
  });

  /**
   * ⚠️ `create()` 被**两条路径共用**（`POST /api/rooms` 与匹配的 `createGameRoom`）
   * ⇒ 回收窗口必须是**入参**：缺省保持匹配路径的现状（`WAITING_TIMEOUT_MS`），
   * 手动房间显式传 `MANUAL_ROOM_TIMEOUT_MS`。**不得**在 `create()` 里写死 40s。
   */
  it('create 的回收窗口是入参：缺省 = WAITING_TIMEOUT_MS（匹配路径现状不变）', async () => {
    const redis = createFakeRedis();
    const service = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));

    const byDefault = await service.create({ mode: 'random', roomCode: 'TIME02' });
    expect(byDefault.timeoutAt - byDefault.createdAt).toBe(WAITING_TIMEOUT_MS);

    const manual = await service.create({ mode: 'practice', roomCode: 'TIME03' }, { timeoutMs: MANUAL_ROOM_TIMEOUT_MS });
    expect(manual.timeoutAt - manual.createdAt).toBe(MANUAL_ROOM_TIMEOUT_MS);
    // 手动房间的窗口**更宽** —— 否则补位会被回收贴脸删掉（§4 的硬不变量）
    expect(manual.timeoutAt).toBeGreaterThan(byDefault.timeoutAt);
  });
});
