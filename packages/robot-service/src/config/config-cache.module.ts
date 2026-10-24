// packages/robot-service/src/config/config-cache.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ConfigClient, ROBOT_CONFIG_RPC_PROXY, configClientOptions } from './config.client';
import { ConfigCacheService } from './config-cache.service';

/**
 * robot-service 的**配置缓存模块**（片⑦ T8；design D2 的读路径）。
 *
 * - **自带 `ClientsModule.register`**：本服务只有这一条出站 RPC 边（config.snapshot），
 *   `ConfigClient` 的传输层就地装配（room 侧因还有 game/robot 两条边才单开
 *   `RpcClientsModule`；这里的依赖方向照样单向，无环）；
 * - **exports `ConfigCacheService`**：消费方（`RobotPool` / `DouZeroHealth` /
 *   `BotPlayer` / `RobotService` / `RobotReclaimTask`，都在 `RobotModule` 里）拿**同一个
 *   单例** —— Nest 按模块实例去重，无论谁先 import，全进程只有一份快照缓存
 *   （多实例安全性的推演见 design D11）。
 */
@Module({
  imports: [
    ClientsModule.register([{ name: ROBOT_CONFIG_RPC_PROXY, ...configClientOptions() }]),
  ],
  providers: [
    {
      provide: ConfigClient,
      // ⚠️ **必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；
      // 单测直接 `new ConfigClient(fake)` 全绿也照样崩 —— 只有容器门禁能抓到）。
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [ROBOT_CONFIG_RPC_PROXY],
    },
    ConfigCacheService,
  ],
  exports: [ConfigCacheService],
})
export class ConfigCacheModule {}
