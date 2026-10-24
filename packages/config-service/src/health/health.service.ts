import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '../redis/redis.module';

/**
 * §2.4 的 `checks` 取值**只有**这两个字面量（逐字）。
 *
 * ⚠️ 本类型在**各服务里各有一份**（R267：检查实现逐服务各一份 —— 不把 Nest 代码塞进
 * `shared`/`protocol`，也不新建 workspace 包），但**形状与文案逐字一致**。
 */
export type CheckState = 'up' | 'down';

/** §2.4 的响应体。 */
export interface HealthBody {
  status: 'ok' | 'degraded';
  service: string;
  checks: Record<string, CheckState>;
}

/** 存活面的响应体：**不含** `checks`（不看任何依赖，因此没有任何可报的东西）。 */
export interface LivenessBody {
  status: 'ok';
  service: string;
}

/**
 * §2.4 / R267 / spec A11 的健康检查：**就绪**（`check()`，真查依赖）+ **存活**（`live()`，不查依赖）。
 *
 * ⚠️ **不新建连接**：Redis 来自 `RedisModule`（`src/redis/redis.module.ts`，`@Global`）那个
 * **已有**的 `REDIS` provider；MySQL 来自 `@nestjs/typeorm` 的 `DataSource`（`database.config.ts`
 * 的连接选项）—— 两者都与业务代码共用同一个实例。
 *
 * ⚠️ **`checks` 只报自己真的依赖的**（R267）：本服务依赖 Redis（广播）与 MySQL（持久真源）
 * ⇒ 报 `{redis, mysql}`；依赖注入发生漂移（比如 REDIS 换成别的连接）会在这里现形。
 */
@Injectable()
export class HealthService {
  static readonly SERVICE = 'config-service';

  private readonly logger = new Logger(HealthService.name);

  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例）：不依赖 `emitDecoratorMetadata` 发出的
   * `design:paramtypes`。tsc 构建会发它，但 **vitest/esbuild 不发** ⇒ 只靠类型的注入在
   * 单测里会静默注入 `undefined`。
   */
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  /**
   * **存活**：不查任何依赖。
   *
   * 理由（R267）：下游一抖就把容器判 `unhealthy`，会让编排层去杀一个**完全健康的进程**。
   * 存活面只回答「进程还在响应吗」。
   */
  live(): LivenessBody {
    return { status: 'ok', service: HealthService.SERVICE };
  }

  /**
   * **就绪**：真查依赖；任一 `down` ⇒ `degraded`（控制器据此返 **503**）。
   *
   * ⚠️ 本方法**绝不抛**：探测异常被 `probe()` 吞掉并记日志 —— 抛出去会变成 **500**
   * 而不是 §2.4 要求的 **503**。
   */
  async check(): Promise<HealthBody> {
    const checks: Record<string, CheckState> = {};
    checks.redis = (await this.probe('redis', () => this.redis.ping())) ? 'up' : 'down';
    checks.mysql = (await this.probe('mysql', () => this.dataSource.query('SELECT 1')))
      ? 'up'
      : 'down';

    const status = Object.values(checks).every((c) => c === 'up') ? 'ok' : 'degraded';
    return { status, service: HealthService.SERVICE, checks };
  }

  /** 探测的唯一入口：吞异常 + 记日志（健康检查自己绝不能抛）。 */
  private async probe(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.logger.warn(
        `health check ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
