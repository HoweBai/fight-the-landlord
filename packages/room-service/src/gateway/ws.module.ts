import { Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { StartModule } from '../rooms/start.module';
import { RpcClientsModule } from './rpc-clients.module';

import { RedisProviderModule } from '../redis.provider.module';
import { MatchModule } from '../match/match.module';
import { ReconnectModule } from '../reconnect/reconnect.module';
import { RoomsModule } from '../rooms/rooms.module';
// ② 金币场 T4：`WsGateway` 新增两个类依赖（第 9/10 个构造参数）——
// `ConfigCacheService`（`room.match` 双开关读面）与 `CurrencyClient`（门槛读边）。
// ⚠️ 必须 import **提供方模块本身**（Nest 的可见性只看「本模块 imports 的 exports」：
// MatchModule 只 export MatchService，不会把 ConfigCacheService 传递出来）——
// 与 RoomsModule / StartModule / MatchModule 各自 import ConfigCacheModule 同一纪律。
import { ConfigCacheModule } from '../config/config-cache.module';
import { CurrencyModule } from '../currency/currency.module';
// 监控片（规格 §2.2）：`rooms_active` 采样器 —— 挂在本模块**只是为了启动**它
//（providers 一律实例化 ⇒ `onModuleInit` 起 15s 自重排链）；Redis 由已 import 的
// RedisProviderModule 提供（与 WsGateway 用的是同一个连接）。
import { RoomMetricsService } from '../metrics/room-metrics.service';
// 昵称片：WsGateway 的第 13 个构造依赖（房间昵称缓存；依赖 RpcClientsModule 的 NicknameClient）。
import { RoomNicknamesService } from '../rooms/room-nicknames.service';

/**
 * `room-service` 的 socket.io 网关模块（§4.1：**唯一**允许 emit 到 `/ws/ddz` 的服务）。
 *
 * ⚠️ **N20/P4 Task 3**：`HttpModule` 已删除 —— 本服务的服务间调用全部迁到 TCP RPC，
 * 两个客户端由 `RpcClientsModule` 提供（见那个文件的「两个 token」说明）。
 *
 * ⚠️ **不再有 `ROBOT_CLIENT` 缺席的洞（R217 同族）**：`ws.gateway.ts` 早就
 * `@Optional() robot?: RobotClient` 注入它，但**从来没有** provider ⇒ 容器里它恒为
 * `undefined` ⇒ `game.ended` 分支的 `robot.release()` 在生产路径上**一次都没跑过**
 * （只有单测手工 `new WsGateway(...)` 时才工作 —— 这正是「单测覆盖不到装配层」）。
 * 现在两个客户端都在 `RpcClientsModule` 里注册，并由
 * `test/ws.module.wiring.test.ts` 的容器门禁钉住。
 */
@Module({
  imports: [
    RedisProviderModule,
    MatchModule,
    ReconnectModule,
    RoomsModule,
    RpcClientsModule,
    StartModule,
    // ② 金币场 T4：WsGateway 的第 9/10 个构造依赖（见上面的 import 注）。
    ConfigCacheModule,
    CurrencyModule,
  ],
  providers: [WsGateway, RoomMetricsService, RoomNicknamesService],
  exports: [WsGateway],
})
export class WsModule {}
