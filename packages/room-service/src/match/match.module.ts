import { Module } from '@nestjs/common';
import { MatchService } from './match.service';
import { RoomsService } from '../rooms/rooms.service';
import { RedisProviderModule } from '../redis.provider.module';
import { RpcClientsModule } from '../gateway/rpc-clients.module';
import { ConfigCacheModule } from '../config/config-cache.module';
import { StartModule } from '../rooms/start.module';

/**
 * 匹配模块（§8）。
 *
 * ⚠️ **N20/P4 Task 3**：`HttpModule` 已删除 —— `MatchService` 的
 * `game.start` / `robot.acquire` 现在走 `RpcClientsModule` 提供的
 * `GameClient` / `RobotClient`（TCP RPC），不再是 `HttpService`。
 *
 * ⚠️ 片⑦ T7：`MatchService`（入队前的底分校验）与**本模块自己声明的** `RoomsService`
 * 都注入 `ConfigCacheService` ⇒ import `ConfigCacheModule`。⚠️ 不能靠 `StartModule`
 * 传递（它只 export `RoomStartService`；Nest 的可见性只看**本模块的 imports 的 exports**）。
 */
@Module({
  imports: [RedisProviderModule, RpcClientsModule, StartModule, ConfigCacheModule],
  providers: [MatchService, RoomsService],
  exports: [MatchService],
})
export class MatchModule {}
