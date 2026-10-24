// packages/robot-service/src/robot/douzero.health.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { RobotAvailabilityResponse } from '@fight-the-landlord/protocol';
import { DOUZERO_URL } from './douzero.client';
// ⚠️ **值导入**（DI 陷阱纪律）：容器要按类型解析构造参数。
import { ConfigCacheService } from '../config/config-cache.service';

const PROBE_TIMEOUT_MS = 1000;
const CACHE_TTL_MS = 5000;
const POSITIONS = ['landlord', 'landlord_down', 'landlord_up'] as const;
const MODELS = ['sl', 'douzero_WP', 'douzero_ADP'] as const;

/** 片② D5：DouZero 可用性门禁（只在开关关掉时才真的去探）。 */
@Injectable()
export class DouZeroHealth {
  private readonly logger = new Logger(DouZeroHealth.name);
  private cached?: { at: number; value: RobotAvailabilityResponse };

  /** fetch 与时钟都可注入（**仅测试**；生产走全局 `fetch` 与 `Date.now`）。 */
  constructor(
    /**
     * 片⑦ E4（r1-S-I3 订正）：`robot.ruleFallback` 的**真消费者**是这里 ——
     * **探测门禁**（开关 ON ⇒ 不探测、恒答「能给」），**不是决策路径**。
     * env `ROBOT_RULE_FALLBACK` 已退役；开关经 `ConfigCacheService` 现读（每拍现读，
     * `/admin` 改键后下一次 `canProvide()` 即随动）。
     */
    private readonly configCache: ConfigCacheService,
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
    @Optional() private readonly clock: () => number = () => Date.now(),
  ) {}

  async canProvide(): Promise<RobotAvailabilityResponse> {
    if (this.configCache.ruleFallback()) return { canProvide: true };    // 开关 ON：不探测
    const now = this.clock();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) return this.cached.value;
    const value = await this.probe();
    this.cached = { at: now, value };
    return value;
  }

  private async probe(): Promise<RobotAvailabilityResponse> {
    try {
      const res = await this.fetchImpl(`${DOUZERO_URL}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return this.unreachable(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const models = (body as { models?: unknown })?.models;
      if (typeof models !== 'object' || models === null || Array.isArray(models)) {
        this.logger.warn('douzero /health has no parsable `models`; treating it as available');
        return { canProvide: true };                                      // fail-open
      }
      const table = models as Record<string, unknown>;
      const incomplete = MODELS.filter((m) => {
        const positions = table[m];
        return !Array.isArray(positions) || !POSITIONS.every((p) => (positions as unknown[]).includes(p));
      });
      if (incomplete.length > 0) {
        this.logger.warn(`douzero models incomplete: ${incomplete.join(',')}`);
        return { canProvide: false, reason: 'models-incomplete' };
      }
      return { canProvide: true };
    } catch (error) {
      return this.unreachable((error as Error).message);                  // 含超时与连接被拒
    }
  }

  private unreachable(detail: string): RobotAvailabilityResponse {
    this.logger.warn(`DouZero unreachable: ${detail}`);
    return { canProvide: false, reason: 'douzero-unreachable' };
  }
}
