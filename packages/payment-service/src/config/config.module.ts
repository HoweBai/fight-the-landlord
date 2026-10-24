// packages/payment-service/src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ConfigClient, PAYMENT_CONFIG_RPC_PROXY, configClientOptions } from './config.client';
import { ConfigCacheService } from './config-cache.service';
import { PayChannelConfigService } from './pay-channel.config.service';

/**
 * payment-service 的**配置缓存模块**（支付片 T2 骨架；克隆自 currency-service 的同名模块，
 * 行为模板 = user/room/robot 四份更早先例）。
 *
 * - **自带 `ClientsModule.register`**：本服务的配置边（`config.snapshot`）就地装配
 *   （依赖方向单向，无环；T9 的 currency 出站边另建自己的 client）；
 * - **exports `ConfigCacheService` / `PayChannelConfigService`**：消费方（T5 起的键级
 *   getter 消费面、T9 起的渠道三消费点，在各自的 controller/service）拿**同一个单例**
 *   —— Nest 按模块实例去重，全进程只有一份快照缓存 / 一份渠道 lastGood 回落图。
 */
@Module({
  imports: [ClientsModule.register([{ name: PAYMENT_CONFIG_RPC_PROXY, ...configClientOptions() }])],
  providers: [
    {
      provide: ConfigClient,
      // ⚠️ **必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；
      // 单测直接 `new ConfigClient(fake)` 全绿也照样崩 —— 只有容器门禁能抓到）。
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [PAYMENT_CONFIG_RPC_PROXY],
    },
    ConfigCacheService,
    PayChannelConfigService,
  ],
  exports: [ConfigCacheService, PayChannelConfigService],
})
export class ConfigModule {}
