// packages/room-service/src/config/config-cache.module.ts
import { Module } from '@nestjs/common';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ConfigCacheService } from './config-cache.service';
import { RpcClientsModule } from '../gateway/rpc-clients.module';

/**
 * room-service 的**配置缓存模块**（片⑦ T6；design D2 的读路径）。
 *
 * - **imports `RpcClientsModule`**：`ConfigCacheService` 构造注入 `ConfigClient`
 *   （`config.snapshot` 的传输层）—— 复用 `CONFIG_RPC_PROXY` 的既有装配，不新开连接族；
 * - **exports `ConfigCacheService`**：T7 的消费方（`RoomsModule` / `MatchModule` /
 *   `start.module` 与 controller）都从本模块拿**同一个单例** —— Nest 按模块实例去重，
 *   无论谁先 import，全进程只有一份快照缓存（多实例安全性的推演见 design D11）。
 */
@Module({
  imports: [RpcClientsModule],
  providers: [ConfigCacheService],
  exports: [ConfigCacheService],
})
export class ConfigCacheModule {}
