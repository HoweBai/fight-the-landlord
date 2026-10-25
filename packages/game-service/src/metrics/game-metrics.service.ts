// packages/game-service/src/metrics/game-metrics.service.ts
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { runWithTrace, setGame } from '@fight-the-landlord/shared';
import { GameService } from '../game/game.service';
import { gamesActive } from './game.metrics';

/** 采样周期（规格 §2.2：15s）。 */
export const GAME_METRICS_SAMPLE_INTERVAL_MS = 15_000;

/**
 * game-service 的业务采样器（监控片 · 规格 §2.2：只采 `games_active`）。
 *
 * 读数 = `GameService.activeSessionCount()`（= 进程内 `cache.size`）—— **per-instance
 * 语义**（HELP 已注明；与 `rooms_active` 的全栈口径刻意不同，见 `game.metrics.ts`）。
 *
 * 装配：注册进 `app.module.ts` 的 providers（`GameService` 由 GameModule export，
 * AppModule 已 import 它 ⇒ 注入可解析）。
 *
 * ─── 节奏（照 `records-cleanup.service.ts` 的 setTimeout 链成例）────────────
 * 15s 自重排；**关停闸**拦住「在途一轮的迟到自重排」（否则 `clearTimeout` 只清得住
 * 已存在的那一个，循环会在关停后「复活」）。
 */
@Injectable()
export class GameMetricsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GameMetricsService.name);
  /** 自重排定时器（`setTimeout` 链；片⑦ 三处循环的同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` / `records-cleanup.service.ts` 的成例）。 */
  private shuttingDown = false;

  constructor(private readonly game: GameService) {}

  onModuleInit(): void {
    this.scheduleNext();
    this.logger.log(
      `Game metrics sampler started (interval: ${GAME_METRICS_SAMPLE_INTERVAL_MS}ms)`,
    );
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.runRound(), GAME_METRICS_SAMPLE_INTERVAL_MS);
  }

  /**
   * 定时器起的一轮：ALS 包裹（自建 id + `source: 'timer'`）→ 采样 → 关停闸后自重排。
   * 成功路径**不打日志**（15s 一条会淹掉日志面）；失败行落在这一轮的上下文里。
   */
  private runRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      try {
        this.sampleOnce();
      } catch (err) {
        this.logger.error(`Game metrics sample failed: ${String(err)}`);
      } finally {
        // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器。
        if (!this.shuttingDown) this.scheduleNext();
      }
    });
  }

  /** 采样一次（测试与运维手动触发用，不等下一个周期）。 */
  sampleOnce(): void {
    for (const [gameType, n] of Object.entries(this.game.activeSessionCountByGameType())) {
      setGame(gamesActive, gameType, n);
    }
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸（同款闸的先例见片⑦ 三处循环与 records-cleanup）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
