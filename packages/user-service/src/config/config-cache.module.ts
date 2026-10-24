// packages/user-service/src/config/config-cache.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ConfigClient, USER_CONFIG_RPC_PROXY, configClientOptions } from './config.client';
import { ConfigCacheService } from './config-cache.service';

/**
 * user-service 的**配置缓存模块**（记录片 T7 / 设计 D5 的读路径；形态照 robot 侧的同名模块）。
 *
 * - **自带 `ClientsModule.register`**：本模块装配 `config.snapshot` 这一条边的 `ClientProxy`
 *   （`ConfigClient` 的传输层就地装配；room 侧因还有 game/robot/record 三条边才单开
 *   `RpcClientsModule`；依赖方向照样单向，无环）；
 *   🔴 **货币片 T6 起本服务共有两条出站 RPC 边**：`config.snapshot`（本模块）与
 *   `currency.apply`（注册赠送，装配在 `src/currency/currency.module.ts`）—— 两条边的
 *   装配形态相同（独立模块 + 内部 token/类 token 两名分开），**旧注释「只有这一条」已失效**；
 * - **exports `ConfigCacheService`**：消费方（`RecordsCleanupService`，在 `AppModule`）
 *   拿**同一个单例** —— Nest 按模块实例去重，全进程只有一份快照缓存。
 */
@Module({
  imports: [ClientsModule.register([{ name: USER_CONFIG_RPC_PROXY, ...configClientOptions() }])],
  providers: [
    {
      provide: ConfigClient,
      // ⚠️ **必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；
      // 单测直接 `new ConfigClient(fake)` 全绿也照样崩 —— 只有容器门禁能抓到）。
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [USER_CONFIG_RPC_PROXY],
    },
    ConfigCacheService,
  ],
  exports: [ConfigCacheService],
})
export class ConfigCacheModule {}
