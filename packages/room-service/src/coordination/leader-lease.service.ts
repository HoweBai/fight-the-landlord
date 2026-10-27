import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

const KEY = 'ftl:room:leader';
// 120s = 3× 最慢循环周期（reaper 60s）；每轮 tick 续约，单轮 >120s 才会双执行。
const TTL_MS = 120_000;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;
const COMPARE_DEL = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * room-service 后台循环的单实例门（spec 2026-10-27 D13）。
 *
 * 每轮定时回调先 `isLeader()`：`SET NX PX 10s` 抢锁；已持有则续约。
 * - 抢到 ⇒ 本轮执行；
 * - 未抢到且不是自己 ⇒ 本轮跳过（下一轮再抢）。
 *
 * ⚠️ 不放在 `scanOnce/sweepOnce/sampleOnce` 里：那些方法是测试与运维入口，
 * 必须保持可直接调用；门只装在定时回调边界（`runOnce/runRound`）。
 */
@Injectable()
export class LeaderLease {
  private readonly id = `${process.env.HOSTNAME ?? 'pod'}:${process.pid}:${randomUUID()}`;

  constructor(@Inject(Redis) private readonly redis: Redis) {}

  async isLeader(): Promise<boolean> {
    const acquired = await this.redis.set(KEY, this.id, 'PX', TTL_MS, 'NX');
    if (acquired === 'OK') return true;
    const renewed = await this.redis.eval(RENEW, 1, KEY, this.id, String(TTL_MS));
    return Number(renewed) === 1;
  }

  async release(): Promise<void> {
    await this.redis.eval(COMPARE_DEL, 1, KEY, this.id);
  }
}
