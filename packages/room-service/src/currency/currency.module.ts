// packages/room-service/src/currency/currency.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `CurrencyClient`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { CurrencyClient, ROOM_CURRENCY_RPC_PROXY, currencyClientOptions } from './currency.client';
import { SETTLE_ROBOT_HOOK, SettleService } from './settle.service';
import { SettleSweeper } from './settle.sweeper';
// ② T6：机器人资金面（ensure + 结算后动作）—— 也是 `SETTLE_ROBOT_HOOK` 的**本体**。
import { RobotFunding } from './robot-funding';
// 结算链的两条共用边：`SettleService` 注入 `RecordClient`（moneyDelta）与
// `ConfigCacheService`（rakePercent）—— 各自从提供方模块取（Nest 可见性只看 exports）。
import { RpcClientsModule } from '../gateway/rpc-clients.module';
import { ConfigCacheModule } from '../config/config-cache.module';
// `SettleSweeper` 注入 Redis ⇒ 与各业务模块同一形态（@Global 模块仍逐模块 import —— 见
// RoomsModule / MatchModule 的成例：这行让「装配子集 compile」时依赖可见）。
import { RedisProviderModule } from '../redis.provider.module';

/**
 * room-service 的**货币边装配**（② 金币场 T4；设计 §5：汇率面全住 room-service）。
 *
 * - **自带 `ClientsModule.register`**：本模块装配 `currency.get` / `currency.apply`
 *   这一条边（TCP 3104）的 `ClientProxy`（token = `ROOM_CURRENCY_RPC_PROXY`）——
 *   形态照 `user-service/src/currency/currency.module.ts`（「客户端装配各归其边」）；
 * - **`useFactory` 不是可选项**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒
 *   容器启动即崩；单测直接 `new CurrencyClient(fake)` 全绿也照样崩）；
 * - **exports `CurrencyClient` + `SettleService`**：消费方各自 import 本模块拿**同一个
 *   单例**（T4：`WsModule` 的门槛读边；T5：`WsGateway` 的结算入口 + 广播绑定；
 *   T6 的 `RobotFunding` 也会从这里出口）。
 *
 * ⚠️ **注册纪律**：`AppModule` 也 import 本模块（`app.module.ts`；与 `ConfigCacheModule`
 * 同一形态）—— 模块若只被单测直接 `new` 而没进应用图，装配错误在真容器里才炸，
 * 那是本仓记过四次的形态（`ws.module.wiring.test.ts`）。
 */
@Module({
  imports: [
    ClientsModule.register([{ name: ROOM_CURRENCY_RPC_PROXY, ...currencyClientOptions() }]),
    // T5 结算链的两条共用边（`record.moneyDelta` 与配置读面的 rakePercent）。
    RpcClientsModule,
    ConfigCacheModule,
    RedisProviderModule,
  ],
  providers: [
    {
      provide: CurrencyClient,
      useFactory: (p: ClientProxy) => new CurrencyClient(p),
      inject: [ROOM_CURRENCY_RPC_PROXY],
    },
    // ② T5：结算服务（算法/分级/收尾）与补偿队列 sweeper（10s 自重排链）。
    SettleService,
    SettleSweeper,
    // ② T6：机器人资金面（`fillBots` 的 ensure 边 + 结算后动作的钩子本体）。
    RobotFunding,
    /**
     * 结算收尾第 ③ 步的**机器人动作钩子**（T6 起 = `RobotFunding.afterSettle`）。
     *
     * ⚠️ `useExisting`（不是 useClass/useValue）：`SettleService` 注入的钩子与
     * `RoomStartService` 注入的 ensure 边**必须是同一个单例** —— 否则
     * （本仓记过四次的形态：`ROBOT_CLIENT` 的原始缺陷）单测里两份替身各配各的、
     * 真容器里两条路径的状态互不可见。接口由 `settle.service.ts` 的 `SettleRobotHook`
     * 钉死（`RobotFunding` 以 `implements` 做编译期兜底；`ws.module.wiring.test.ts`
     * 有一条 `mod.get(SETTLE_ROBOT_HOOK) === mod.get(RobotFunding)` 的容器级判据）。
     */
    {
      provide: SETTLE_ROBOT_HOOK,
      useExisting: RobotFunding,
    },
  ],
  exports: [CurrencyClient, SettleService, RobotFunding],
})
export class CurrencyModule {}
