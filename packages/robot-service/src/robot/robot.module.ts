// packages/robot-service/src/robot/robot.module.ts
import { Module } from '@nestjs/common';
import { RobotService } from './robot.service';
import { BotPlayer } from './bot.player';
import { DouZeroClient } from './douzero.client';
// 片② D5：`RobotService` 的第 3 个构造依赖（**值导入** —— 它在这里就是 provider 记号本身；
// ⚠️ `robot.service.ts` 侧同样必须值导入，`import type` 会让容器启动即崩，见那里注释）。
import { DouZeroHealth } from './douzero.health';
import { RobotPool } from './robot.pool';
import { RobotReclaimTask } from './robot.reclaim.task';
import { RobotController } from './robot.controller';
import { RobotRpcController } from '../rpc/robot.rpc.controller';
import { RedisProviderModule } from '../redis.provider.module';
import { ConfigCacheModule } from '../config/config-cache.module';

/**
 * ⚠️ 两个控制器是 §4.2 的**两条通道**（R222 的双栈），不是重复：
 *  - `RobotController` = **对外 HTTP**（`GET /api/robots/list` 与两条兼容壳）；
 *  - `RobotRpcController` = **对内 TCP RPC**（`robot.acquire|release|decide`）。
 *
 * 它们**不共用方法**（Global Constraint 4），只共用 `RobotService` 的业务方法。
 * healthcheck 与网关仍依赖 HTTP 面 ⇒ **不得**因迁移而删它（R222）。
 *
 * ⚠️ **`HealthController` 不在本模块里**（R293）：它由 `AppModule` 声明 —— 与另外四个服务
 * 一致。此前本模块**也**声明了它（同一个控制器在两个模块各注册一次），在没有构造参数时
 * 无害；本片给 `HealthController` 加了 `HealthService` 依赖之后，`RobotModule` 上下文里
 * 解析不到那个 provider ⇒ **容器启动即崩**（实测 `Nest can't resolve dependencies of the
 * HealthController (?) … available in the RobotModule context`）。单测不会红 —— 它们
 * 直接 `new HealthController(service)`，不经容器（R216/R217/R239 同族）。
 */
@Module({
  // 片⑦ T8：配置快照缓存（design D2）——本模块的全部消费方（Pool/Health/BotPlayer/
  // Service/ReclaimTask）从它拿**同一个** `ConfigCacheService` 单例（Nest 按模块实例
  // 去重；`ConfigCacheModule` 自己不 import 任何业务模块，依赖方向单向 ⇒ 不成环）。
  imports: [RedisProviderModule, ConfigCacheModule],
  controllers: [RobotController, RobotRpcController],
  // `RobotPool` 的 Redis 由 `RedisProviderModule` 注入（§10.1 的池是 Redis 结构，
  // 不再是旧实现的进程内 `Map` —— 那个 Map「永不回收」，正是 §9.6 的偏差形态）。
  providers: [DouZeroClient, BotPlayer, RobotPool, RobotReclaimTask, DouZeroHealth, RobotService],
  exports: [RobotService],
})
export class RobotModule {}
