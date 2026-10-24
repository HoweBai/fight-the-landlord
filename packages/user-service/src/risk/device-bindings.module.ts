// packages/user-service/src/risk/device-bindings.module.ts
import { Module } from '@nestjs/common';
import { DeviceBindingsService } from './device-bindings.service';

/**
 * 设备绑定片的装配模块（安全功能）。
 *
 * - 无 `imports`：`DataSource` 来自 `TypeOrmModule.forRoot`（全局 provider）、`REDIS`
 *   来自 `@Global` 的 `RedisModule`（与 `DevicesService`/`ReviewsService` 同族直取）；
 * - **exports `DeviceBindingsService`**：`AuthModule`（登录/注册/refresh 闸）与 `AppModule`
 *   （管理面 `AdminRiskService` 解绑）都 import 本模块 —— Nest 按模块实例去重，两侧拿到
 *   同一个单例（先例 = `ConfigCacheModule`）。
 */
@Module({
  providers: [DeviceBindingsService],
  exports: [DeviceBindingsService],
})
export class DeviceBindingsModule {}
