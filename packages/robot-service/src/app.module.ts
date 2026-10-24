// packages/robot-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { RobotModule } from './robot/robot.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
// 片⑦ T8：配置快照缓存（design D2）也挂在根模块上 —— 与 room-service 的装配同形
// （进程内**恰好一份**：启动即拉 + 订阅 + 安全网；`RobotModule` 自身也 import 它，
// Nest 按模块实例去重 ⇒ 两处引用是同一单例，不会出现「两份缓存各自漂移」）。
import { ConfigCacheModule } from './config/config-cache.module';

@Module({
  imports: [RobotModule, ConfigCacheModule],
  controllers: [HealthController],
  // §2.4 / R267：健康检查复用 `RobotModule` → `RedisProviderModule` 的 `Redis`
  // （后者是 `@Global`，**不新建连接**）。
  providers: [HealthService],
})
export class AppModule {}
