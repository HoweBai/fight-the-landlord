// packages/currency-service/src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ConfigClient, CURRENCY_CONFIG_RPC_PROXY, configClientOptions } from './config.client';
import { ConfigCacheService } from './config-cache.service';

/**
 * currency-service 的**配置缓存模块**（② 金币场 T8 / 规格 §9；行为模板 = user-service 的
 * 同名模块，room/robot 两份为更早先例 —— 兄弟服务把文件/类命名成 `config-cache.module.ts` /
 * `ConfigCacheModule`，本片按计划文件清单命名 `config.module.ts` / `ConfigModule`，职责不变）。
 *
 * - **自带 `ClientsModule.register`**：本模块装配 `config.snapshot` 这一条出站 RPC 边
 *   （广告片起本服务另有**第二条**出站边 `config.adChannel.get`，注册在 `AppModule` 的
 *   `AD_CHANNEL_RPC_PROXY` —— 见 `src/ads/ad-channel.config.service.ts`），
 *   `ConfigClient` 的传输层就地装配（依赖方向单向，无环）；
 * - **exports `ConfigCacheService`**：消费方（`WalletController` 的 relief 端点，在 `AppModule`）
 *   拿**同一个单例** —— Nest 按模块实例去重，全进程只有一份快照缓存。
 */
@Module({
  imports: [ClientsModule.register([{ name: CURRENCY_CONFIG_RPC_PROXY, ...configClientOptions() }])],
  providers: [
    {
      provide: ConfigClient,
      // ⚠️ **必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；
      // 单测直接 `new ConfigClient(fake)` 全绿也照样崩 —— 只有容器门禁能抓到）。
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [CURRENCY_CONFIG_RPC_PROXY],
    },
    ConfigCacheService,
  ],
  exports: [ConfigCacheService],
})
export class ConfigModule {}
