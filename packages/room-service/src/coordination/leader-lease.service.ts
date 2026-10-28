import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
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
 * 每轮定时回调先 `isLeader()`：`SET NX PX 120s` 抢锁；已持有则续约（`PEXPIRE`）。
 * - 抢到 ⇒ 本轮执行；
 * - 未抢到且不是自己 ⇒ 本轮跳过（下一轮再抢）。
 *
 * ⚠️ 不放在 `scanOnce/sweepOnce/sampleOnce` 里：那些方法是测试与运维入口，
 * 必须保持可直接调用；门只装在定时回调边界（`runOnce/runRound`）。
 */
@Injectable()
export class LeaderLease implements OnApplicationShutdown {
  private readonly logger = new Logger(LeaderLease.name);
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

  /**
   * 关停即释放（2026-10-28 补；spec 2026-10-27 D13 的缺口）。
   *
   * 🔴 事由：`release()` 此前**没有任何调用点** ⇒ 容器重建 / 滚动更新 / 重启后，旧实例的
   * 锁要等 TTL（120s）自然过期，新实例这段时间 `isLeader()` 恒 false ⇒ **撮合扫描、自动开局、
   * 回收、结算等后台循环集体空窗最多 2 分钟**（k3s 滚动更新时用户可感知）。
   *
   * `COMPARE_DEL` 只删「值仍是自己」的锁 ⇒ 与其他实例的抢占无竞态（锁已被别人拿走时是 no-op）。
   * 失败方向：**只 WARN 不抛** —— 关停路径不得被 Redis 故障拖住（Docker 10s 后 SIGKILL，
   * TTL 仍是兜底）。崩溃/被 SIGKILL 时本钩子不会跑，同样由 TTL 兜底。
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.release();
    } catch (err) {
      this.logger.warn(
        `Leader lease release failed on shutdown (TTL ${TTL_MS}ms fallback still applies): ${String(err)}`,
      );
    }
  }
}
