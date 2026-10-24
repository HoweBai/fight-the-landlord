import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ONLINE_PRUNE_MS, ONLINE_TTL_MS, ONLINE_USERS_KEY, PLAYERS_SUMMARY_KEY } from '@fight-the-landlord/shared';
import { REDIS } from '../auth/token.service';
import { AdminPlayersService, type PlayersSummary } from './admin-players.service';
import {
  playersActive1d,
  playersActive7d,
  playersActive30d,
  playersInactive14d,
  playersInactive30d,
  playersOnlinePresence,
  playersTotal,
} from '../metrics/player.metrics';

export const PLAYER_STATS_INTERVAL_MS = 5 * 60_000;
export const PLAYER_STATS_FIRST_RUN_DELAY_MS = 30_000;
export const PLAYERS_SUMMARY_TTL_MS = 10 * 60_000;

/**
 * 玩家统计任务（2026-10-22）：每 5 分钟写 Grafana gauge + Redis 汇总快照 +
 * 清理 presence 过期成员。失败只 warn，不影响进程。
 */
@Injectable()
export class PlayerStatsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PlayerStatsService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    @Inject(AdminPlayersService) private readonly players: AdminPlayersService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.schedule(PLAYER_STATS_FIRST_RUN_DELAY_MS);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runLoop();
    }, delay);
    this.timer.unref?.();
  }

  private async runLoop(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`player stats round failed: ${String(err)}`);
    } finally {
      this.schedule(PLAYER_STATS_INTERVAL_MS);
    }
  }

  /** 单轮（测试直接调用）。 */
  async runOnce(now = Date.now()): Promise<PlayersSummary> {
    const base = await this.players.summaryBase(now);
    let onlineNow = 0;
    try {
      onlineNow = Number(await this.redis.zcount(ONLINE_USERS_KEY, `(${now - ONLINE_TTL_MS}`, '+inf'));
    } catch (err) {
      this.logger.warn(`presence zcount failed: ${String(err)}`);
    }
    playersTotal.set(base.totalPlayers);
    playersActive1d.set(base.active1d);
    playersActive7d.set(base.active7d);
    playersActive30d.set(base.active30d);
    playersInactive14d.set(base.inactive14d);
    playersInactive30d.set(base.inactive30d);
    playersOnlinePresence.set(onlineNow);

    const summary: PlayersSummary = { ...base, onlineNow };
    try {
      await this.redis.set(PLAYERS_SUMMARY_KEY, JSON.stringify(summary), 'PX', PLAYERS_SUMMARY_TTL_MS);
    } catch (err) {
      this.logger.warn(`players summary snapshot failed: ${String(err)}`);
    }
    try {
      await this.redis.zremrangebyscore(ONLINE_USERS_KEY, '-inf', String(now - ONLINE_PRUNE_MS));
    } catch (err) {
      this.logger.warn(`presence prune failed: ${String(err)}`);
    }
    return summary;
  }
}
