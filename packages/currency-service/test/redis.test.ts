/**
 * 余额缓存帮助层 —— 货币片 T3 / 规格 §2.11 契约逐字：
 *  - 键 `currency:balance:<ownerId>`（⚙️4）；
 *  - 值 = 余额的**十进制整数字符串**；
 *  - **无 TTL**（`SET` 恰两个实参 —— 带 EX/PX 会当场红）；
 *  - 失败**不吞**（Redis 故障原样 reject 给调用方 —— 写穿/读穿的降级策略在调用方，不在本层）。
 *
 * ⚠️ 不建真连接：Redis 替身是 { get/set/del } 的最小形状（`as unknown as Redis`）。
 * `RedisModule` 本身用 Nest TestingModule + `overrideProvider(REDIS)` 钉「提供并导出
 * REDIS」（override 保证 `createRedis` 工厂**不会**被执行 —— 无真实 ioredis 连接）。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  BALANCE_KEY_PREFIX,
  REDIS,
  RedisModule,
  balanceKey,
  delBalance,
  getBalance,
  setBalance,
} from '../src/redis/redis.module';

describe('§2.11 余额缓存帮助层', () => {
  it('键形：currency:balance:<ownerId>（⚙️4 逐字）', () => {
    expect(BALANCE_KEY_PREFIX).toBe('currency:balance:');
    expect(balanceKey('u-1')).toBe('currency:balance:u-1');
  });

  it('setBalance：SET(键, 十进制整数字符串)、**恰两个实参**（无 TTL/无选项）、返回值不加工', async () => {
    const set = vi.fn(async () => 'OK');
    await setBalance({ set } as unknown as Redis, 'u-1', 250);

    expect(set).toHaveBeenCalledTimes(1);
    // `toEqual` 逐元素比较 ⇒ 出现第三个实参（EX/PX/NX…）当场红：本契约**无 TTL**。
    expect(set.mock.calls[0]).toEqual(['currency:balance:u-1', '250']);

    const setZero = vi.fn(async () => 'OK');
    await setBalance({ set: setZero } as unknown as Redis, 'u-2', 0);
    expect(setZero.mock.calls[0]).toEqual(['currency:balance:u-2', '0']);
  });

  it('setBalance：非整数 ⇒ 当场抛（契约之外的值形态不得静默写进缓存）且不触 Redis', async () => {
    const set = vi.fn(async () => 'OK');
    await expect(setBalance({ set } as unknown as Redis, 'u-1', 1.5)).rejects.toThrow(/整数/);
    expect(set).not.toHaveBeenCalled();
  });

  it('getBalance：命中 ⇒ 数值；缺键 ⇒ null；值损坏（非十进制整数串）⇒ null（视同 miss）', async () => {
    const get = vi.fn(async () => '250');
    expect(await getBalance({ get } as unknown as Redis, 'u-1')).toBe(250);
    expect(get).toHaveBeenCalledWith('currency:balance:u-1');

    expect(await getBalance({ get: vi.fn(async () => null) } as unknown as Redis, 'u-1')).toBeNull();
    expect(await getBalance({ get: vi.fn(async () => 'abc') } as unknown as Redis, 'u-1')).toBeNull();
    expect(await getBalance({ get: vi.fn(async () => '12.5') } as unknown as Redis, 'u-1')).toBeNull();
  });

  it('delBalance：DEL 该键', async () => {
    const del = vi.fn(async () => 1);
    await delBalance({ del } as unknown as Redis, 'u-9');
    expect(del).toHaveBeenCalledWith('currency:balance:u-9');
  });

  it('失败可注入：redis 故障原样 reject（帮助层不吞错）', async () => {
    const boom = () => Promise.reject(new Error('redis down（仿真）'));
    const failing = { get: boom, set: boom, del: boom } as unknown as Redis;

    await expect(getBalance(failing, 'u-1')).rejects.toThrow('redis down（仿真）');
    await expect(setBalance(failing, 'u-1', 1)).rejects.toThrow('redis down（仿真）');
    await expect(delBalance(failing, 'u-1')).rejects.toThrow('redis down（仿真）');
  });

  it('RedisModule 提供并导出 REDIS（override 替身可解析；工厂不被执行 ⇒ 无真实连接）', async () => {
    const fake = { ping: vi.fn() } as unknown as Redis;
    const mod = await Test.createTestingModule({ imports: [RedisModule] })
      .overrideProvider(REDIS)
      .useValue(fake)
      .compile();

    expect(mod.get(REDIS)).toBe(fake); // 缺 provider/令牌名漂移 ⇒ 解析失败，本条必红
    await mod.close();
  });
});
