import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { GameModule } from './game/game.module';
// 监控片（规格 §2.2）：`games_active` 采样器 —— providers 一律实例化 ⇒ `onModuleInit`
// 起 15s 自重排链；`GameService` 由 GameModule export（本模块已 import 它）。
import { GameMetricsService } from './metrics/game-metrics.service';

@Module({
  imports: [GameModule],
  controllers: [HealthController],
  // §2.4 / R267 / R284：健康检查复用 `GameModule` → `RedisProviderModule` 的 `Redis`
  // —— 与 `GameService` 用的是**同一个**实例（**不新建连接**）。
  providers: [HealthService, GameMetricsService],
})
export class AppModule {}
