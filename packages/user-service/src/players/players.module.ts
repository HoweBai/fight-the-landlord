import { Module } from '@nestjs/common';
import { ConfigCacheModule } from '../config/config-cache.module';
import { AdminPlayersController } from './admin-players.controller';
import { AdminPlayersService } from './admin-players.service';
import { PlayerStatsService } from './player-stats.service';

/**
 * 玩家管理页读面（2026-10-22）。
 * ⚠️ `ConfigCacheModule` 不是 @Global，必须显式 import（否则容器解析 ConfigCacheService 即崩）；
 * `DataSource` / `REDIS` 由 TypeOrmModule.forRoot 与 @Global RedisModule 提供。
 */
@Module({
  imports: [ConfigCacheModule],
  controllers: [AdminPlayersController],
  providers: [AdminPlayersService, PlayerStatsService],
  exports: [AdminPlayersService],
})
export class PlayersModule {}
