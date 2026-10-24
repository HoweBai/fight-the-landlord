/**
 * 广告片 T11：回调限流桶（规格 §2.4 ④ 闸）——**克隆** `payment-service/src/notify/notify.controller.ts:92-143`
 * 的 `NotifyRateLimiter`（键面差异：`ad:notify:rate`；行为逐字同款）。
 *
 * 语义：**边缘单桶 600/分**——反代后回调 peer **恒为 edge 容器**，桶就该是「整条边缘」一个
 * （**按 socket peer 如实记，不读 XFF**；查询扫描可补丢通知 ⇒ 丢一条通知不丢钱）；
 * 超桶 ⇒ 上层 429；**Redis 故障 ⇒ fail-open + 响亮 WARN**（广告回调宁可放行再走验签，
 * 不因缓存故障拒真回调——发放/金钱的幂等独占另有兜底）。
 *
 * 连接面：ioredis **专用实例**（不蹭 `ConfigCacheService` 的订阅连接——那边进 subscribe
 * 模式后不可复用，注释逐字在先）+ `maxRetriesPerRequest: 1` / `enableOfflineQueue: false`
 * 的**快速失败**选项（照 api-gateway `createRedis()` 先例）：故障时立刻走 fail-open，
 * 不让回调请求堆在重试队列里。懒创建（首次收包才建连——boot 面零副作用）。
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/** §2.4：边缘单桶键（**单键**——peer 恒为 edge 容器，桶就该是「整条边缘」一个）。 */
export const AD_NOTIFY_RATE_KEY = 'ad:notify:rate';

/** §2.4：边缘单桶 600/分（INCR + 首次 EXPIRE 60s——固定窗口，照 admin-login 先例）。 */
export const AD_NOTIFY_RATE_LIMIT = { max: 600, windowSeconds: 60 } as const;

@Injectable()
export class AdRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(AdRateLimiter.name);
  private connection: Redis | null = null;

  /** `redisFactory` 是 `@Optional()` + 默认值的**测试替身注入口**（照 `AlipayClient.fetchImpl` 先例）。 */
  constructor(@Optional() private readonly redisFactory: () => Redis = defaultAdNotifyRedis) {}

  /**
   * @returns `true` = **超桶，必须 429**。任何 Redis 故障 ⇒ `false`（放行）+ 响亮 WARN。
   */
  async exceeded(): Promise<boolean> {
    try {
      const redis = this.redis();
      const count = await redis.incr(AD_NOTIFY_RATE_KEY);
      // 固定窗口：窗口从**本窗第一发**起算（`incr` 返回 1 时才设 EXPIRE）——不被后续请求顺延。
      // 已知边角（登记不补保；**承 pay `NotifyRateLimiter` 同款，接受**）：INCR 成功而 EXPIRE
      // 失败（两命令间连接瞬断）⇒ 键留存且无 TTL、count 续累到 >600 后恒 429——后果可控
      //（清键/Redis 重启即愈；回调可重投）。
      if (count === 1) await redis.expire(AD_NOTIFY_RATE_KEY, AD_NOTIFY_RATE_LIMIT.windowSeconds);
      return count > AD_NOTIFY_RATE_LIMIT.max;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `回调限流桶 Redis 故障 —— fail-open（放行本发；宁可通过再验签，不因缓存故障拒真回调）：${reason}`,
      );
      return false;
    }
  }

  onModuleDestroy(): void {
    this.connection?.disconnect();
    this.connection = null;
  }

  private redis(): Redis {
    if (!this.connection) {
      const connection = this.redisFactory();
      connection.on('error', (err: Error) =>
        this.logger.warn(`回调限流桶 Redis 连接错误（fail-open 姿态）：${err.message}`),
      );
      this.connection = connection;
    }
    return this.connection;
  }
}

/** 默认连接（env 空串 = 未设，`||` 不用 `??`——照 currency/payment 全服务口径）。 */
function defaultAdNotifyRedis(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}
