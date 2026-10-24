import { Module } from '@nestjs/common';
import { RoomsModule } from './rooms.module';
import { RoomsAutostartTask } from './rooms.autostart';
import { RoomStartService } from './rooms.start';
import { RedisProviderModule } from '../redis.provider.module';
import { RpcClientsModule } from '../gateway/rpc-clients.module';
import { ConfigCacheModule } from '../config/config-cache.module';
// ② 金币场 T5：`RoomStartService` 注入 `CurrencyClient`（金币房开局三座余额下发）
// ⇒ 必须 import **提供方模块本身**（Nest 可见性只看「本模块 imports 的 exports」）。
import { CurrencyModule } from '../currency/currency.module';
// 断点④修复（本片 Task 5 · 设计 v1.3.1 §4.4）：`RoomStartService` 还注入 `ReconnectService`
//（开局为人类座位写重连记录）⇒ 同一条可见性规则 —— 必须 import `ReconnectModule`。
// 它是叶子依赖（只依赖 `RedisProviderModule`），无环。
import { ReconnectModule } from '../reconnect/reconnect.module';

/**
 * **开局模块**（本片 · spec §2.2 / R915）。
 *
 * 为什么单独一个模块而不是塞进 `RoomsModule`：`RoomsModule` 已经导出 `RoomsService`，
 * 而 `MatchModule` 依赖它（`MatchService` 注入 `RoomsService`）。开局链需要
 * `RobotClient` / `GameClient` 与「自动开局扫描器」⇒ 若塞进 `RoomsModule`，
 * 匹配与房间两侧就成环。
 *
 * ⇒ 本模块**只进不出**：它 import `RoomsModule`（拿 `RoomsService`）与 `RpcClientsModule`
 *（拿两个 RPC 客户端），导出「开局」这一件事；`MatchModule` 也 import 它以复用同一条链。
 *
 * ⚠️ 片⑦ T7：`RoomsAutostartTask` 注入 `ConfigCacheService`（发条从 env 常量换成
 * `cycleMs('room.autostartIntervalMs')`）⇒ 本模块也要 import `ConfigCacheModule`。
 * 注意 `RoomsModule` 的 exports **不含** `ConfigCacheService`（它只 export `RoomsService`）
 * ⇒ 不能靠「StartModule 已经 import 了 RoomsModule」顺带拿到。
 */
@Module({
  imports: [
    RedisProviderModule,
    RoomsModule,
    RpcClientsModule,
    ConfigCacheModule,
    CurrencyModule,
    ReconnectModule,
  ],
  // R901：照 `RoomsReaperTask` 的成例（`OnModuleInit` 起循环、关停即清）
  providers: [RoomStartService, RoomsAutostartTask],
  exports: [RoomStartService],
})
export class StartModule {}
