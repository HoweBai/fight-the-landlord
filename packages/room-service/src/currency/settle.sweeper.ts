// packages/room-service/src/currency/settle.sweeper.ts
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { runWithTrace, setGame } from '@fight-the-landlord/shared';
import { isGameType, type GameType } from '@fight-the-landlord/protocol';
import {
  RECORD_MONEY_OUTBOX_KEY,
  SETTLE_OUTBOX_KEY,
  SettleService,
  type RecordMoneyOutboxEntry,
  type SettleOutboxEntry,
} from './settle.service';
import {
  currencySettleOutboxOldestSeconds,
  currencySettleOutboxSize,
} from '../metrics/room.metrics';

/**
 * 补偿队列的清扫周期（规格 §5 逐字：常量 **10s**、**不设配置键**）。
 */
export const SETTLE_SWEEP_INTERVAL_MS = 10_000;

/**
 * ② 金币场 T5：**结算补偿队列的 sweeper**（规格 §5；设计 D4）。
 *
 * 形态逐字照 `rooms.reaper.ts:51-83` 的**自重排链**（`setTimeout` 自排、ALS 包裹
 * `{traceId: randomUUID(), source: 'timer'}`、轮级 catch、关停闸拦住迟到自重排）。
 *
 * 每轮（10s）：
 *  1. 遍历 `settle:outbox`：逐条目调 `SettleService.resendSettleOutboxEntry`
 *     （超龄放弃 / 原样重发 / 成功 ⇒ 完整收尾）；坏 JSON 条目 ⇒ ERROR + 删（否则每轮刷屏）；
 *  2. 遍历 `recordmoney:outbox`：逐条目调 `resendRecordMoneyOutboxEntry`（`matched` 齐三座 ⇒ 清除）；
 *  3. 刷新两个 gauge：`currency_settle_outbox_size`（**两箱之和**）与
 *     `currency_settle_outbox_oldest_seconds`（空队列 ⇒ 0；告警阈值 >300s —— 告警先于 TTL 到达）。
 *
 * ⚠️ 单条目失败只记日志、**继续下一条**（一条坏条目/一次下游抖动不该让整轮停摆）；
 * 轮级失败（如 Redis 读失败）⇒ ERROR + 下一轮照常（自重排链在 `.finally` 里）。
 */
@Injectable()
export class SettleSweeper implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SettleSweeper.name);
  /** 清扫链的定时器（自重排；同 reaper：不是 `setInterval`）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;

  constructor(
    private readonly redis: Redis,
    private readonly settle: SettleService,
  ) {}

  onModuleInit(): void {
    this.startLoop();
  }

  /** 起清扫链（幂等：已在跑不重起）。 */
  startLoop(): void {
    if (this.timer) return;
    this.scheduleNext();
    this.logger.log(`Settle sweep loop started (interval: ${SETTLE_SWEEP_INTERVAL_MS}ms)`);
  }

  /** 排下一轮（常量周期 —— 规格 §5：本环节**没有**配置键）。 */
  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runOnce(), SETTLE_SWEEP_INTERVAL_MS);
  }

  /** 一轮（ALS 包裹 + 轮级 catch；末尾接自重排）。 */
  private runOnce(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.sweepOnce()
        .catch((err) => this.logger.error(`Settle sweep failed: ${String(err)}`))
        .finally(() => {
          // 关停闸（照 `rooms.reaper.ts` 的成例）：在途一轮的迟到回执不得在关停后再排定时器。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /** 立即清扫一轮（测试与运维用，不等下一个周期）。 */
  async sweepOnce(now: number = Date.now()): Promise<void> {
    const settleRaw = (await this.redis.hgetall(SETTLE_OUTBOX_KEY)) ?? {};
    for (const [field, raw] of Object.entries(settleRaw)) {
      const entry = this.parseEntry<SettleOutboxEntry>(SETTLE_OUTBOX_KEY, field, raw);
      if (!entry) continue; // 坏条目已 ERROR + 删（见 parseEntry）
      try {
        await this.settle.resendSettleOutboxEntry(field, entry, now);
      } catch (err) {
        this.logger.error(`Settle outbox entry handling failed for ${field}: ${String(err)}`);
      }
    }

    const moneyRaw = (await this.redis.hgetall(RECORD_MONEY_OUTBOX_KEY)) ?? {};
    for (const [field, raw] of Object.entries(moneyRaw)) {
      const entry = this.parseEntry<RecordMoneyOutboxEntry>(RECORD_MONEY_OUTBOX_KEY, field, raw);
      if (!entry) continue;
      try {
        await this.settle.resendRecordMoneyOutboxEntry(field, entry, now);
      } catch (err) {
        this.logger.error(`recordmoney outbox entry handling failed for ${field}: ${String(err)}`);
      }
    }

    // 指标：**处置之后**重读一次（上面这轮可能已投递/清除/放弃若干条目 —— 用开头的
    // 快照会让 gauge 落后一轮，告警阈值（>300s）会晚一个周期才看到已被清掉的滞留）。
    await this.refreshOutboxGauges(now);
  }

  /** 刷新两个 gauge：按玩法分组；先读后写（整条 hgetall 失败 ⇒ 抛给 runOnce，旧值保留）。 */
  private async refreshOutboxGauges(now: number): Promise<void> {
    const settleRaw = (await this.redis.hgetall(SETTLE_OUTBOX_KEY)) ?? {};
    const moneyRaw = (await this.redis.hgetall(RECORD_MONEY_OUTBOX_KEY)) ?? {};
    const sizes = new Map<GameType, number>([
      ['doudizhu', 0],
      ['paodekuai', 0],
    ]);
    const oldest = new Map<GameType, number>([
      ['doudizhu', 0],
      ['paodekuai', 0],
    ]);
    let badEntries = 0;

    for (const raw of [...Object.values(settleRaw), ...Object.values(moneyRaw)]) {
      let parsed: { createdAt?: unknown; gameType?: unknown };
      let rawParsed: unknown;
      try {
        rawParsed = JSON.parse(raw);
      } catch {
        // 设计 §5：单条目 JSON 坏 ⇒ 归 ddz + 汇总 WARN（整条 hgetall 失败才保留旧值）
        badEntries += 1;
        sizes.set('doudizhu', (sizes.get('doudizhu') ?? 0) + 1);
        continue;
      }
      if (rawParsed === null || typeof rawParsed !== 'object') {
        badEntries += 1;
        sizes.set('doudizhu', (sizes.get('doudizhu') ?? 0) + 1);
        continue;
      }
      parsed = rawParsed as { createdAt?: unknown; gameType?: unknown };
      if (parsed.gameType !== undefined && !isGameType(parsed.gameType)) badEntries += 1;
      const gameType = isGameType(parsed.gameType) ? parsed.gameType : 'doudizhu';
      sizes.set(gameType, (sizes.get(gameType) ?? 0) + 1);
      if (typeof parsed.createdAt === 'number') {
        const age = Math.max(0, Math.round((now - parsed.createdAt) / 1000));
        oldest.set(gameType, Math.max(oldest.get(gameType) ?? 0, age));
      }
    }

    if (badEntries > 0) {
      this.logger.warn(`Settle outbox gauge: ${badEntries} unparseable/invalid entr(ies) counted as doudizhu`);
    }
    for (const gameType of ['doudizhu', 'paodekuai'] as const) {
      setGame(currencySettleOutboxSize, gameType, sizes.get(gameType) ?? 0);
      setGame(currencySettleOutboxOldestSeconds, gameType, oldest.get(gameType) ?? 0);
    }
  }

  /**
   * JSON 解析单条目；坏 JSON **永远不会自己好** ⇒ ERROR + 删（否则每 10s 刷一条 —— 噪声）。
   * 返回 `null` 表示条目已被丢弃处置。
   */
  private parseEntry<T>(key: string, field: string, raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.error(`Corrupt ${key} entry ${field} dropped: ${String(err)}`);
      void this.redis.hdel(key, field).catch((delErr: unknown) => {
        this.logger.error(`Failed to drop corrupt ${key} entry ${field}: ${String(delErr)}`);
      });
      return null;
    }
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（否则循环会在关停后复活）。
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
