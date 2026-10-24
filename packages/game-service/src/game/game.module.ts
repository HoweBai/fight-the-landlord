// packages/game-service/src/game/game.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
import { GameService } from './game.service';
import { GameController } from './game.controller';
import { GameRpcController } from '../rpc/game.rpc.controller';
import { RobotClient } from './robot.client';
import { RedisProviderModule } from '../redis.provider.module';
import { ROBOT_RPC_PROXY, robotClientOptions } from '../rpc/rpc.options';
import { GameRegistry } from '../games/registry';
import { DdzRuntime } from '../games/ddz/runtime';
import { PdkRuntime } from '../games/pdk/runtime';

/**
 * ⚠️ 两个控制器是 §4.2 的**两条通道**，不是重复：
 *  - `GameController` = **对外 HTTP**（§4.1 的 `gateway → game-service` 边）；
 *  - `GameRpcController` = **对内 TCP RPC**（§4.1 的 `room-service → game-service` 边）。
 *
 * 它们**不共用方法**（Global Constraint 4），只共用 `GameService` 的业务方法。
 *
 * ─── `robot.decide` 的客户端装配（N20/P4 Task 4）─────────────────────────
 * `ClientsModule.register([{ name: ROBOT_RPC_PROXY, … }])` 提供的是**原始 `ClientProxy`**，
 * 挂在 `ROBOT_RPC_PROXY` 这个**内部 token** 上；再由 `useFactory` 把它包成我们的
 * `RobotClient`（`provide: RobotClient`）。**两个 token 必须不同**：若让包装 provider 与
 * `ClientsModule` 用**同一个** `name`，后者会被前者覆盖，而 `inject` 解析到的是哪一个
 * 取决于注册顺序 —— 脆且难查（协调者对 room-service 的同款提醒，执行期采纳）。
 *
 * ⚠️ 必须 `useFactory` **显式构造**（R216）：Nest 看不见「带默认值的普通对象参数」，
 * `useClass` 会把它当成待注入的 provider ⇒ 启动即崩（而单测全绿，因为单测直接
 * `new RobotClient(fake)`，不经容器）。
 *
 * ⚠️ `forwardRef`：`GameService.robotClient` 是**属性注入**（`@Inject(forwardRef(() =>
 * RobotClient))`），因此 `GameService ⇄ RobotClient` 在 Nest 的依赖图里互相引用 ——
 * 用 `forwardRef` 打断这个循环。副作用是 `GameService` 的 `robotClient` 在
 * `onModuleInit` 之前是 `null`（`game.service.ts` 的 fail-loud 分支覆盖它）。
 */
@Module({
  imports: [
    // R284（§2.4 / R267）：Redis 连接由 provider 提供，健康检查与 `GameService`
    // 复用**同一个**实例（此前连接藏在 `GameService` 的构造函数里）。
    RedisProviderModule,
    ClientsModule.register([{ name: ROBOT_RPC_PROXY, ...robotClientOptions() }]),
  ],
  controllers: [GameController, GameRpcController],
  providers: [
    GameService,
    {
      provide: RobotClient,
      useFactory: (proxy: ClientProxy) => new RobotClient(proxy),
      inject: [ROBOT_RPC_PROXY],
    },
    // 多玩法片 S1/S4：runtime 注册表（斗地主 + 跑得快；未知玩法 `get` 响亮失败）。
    { provide: DdzRuntime, useValue: new DdzRuntime() },
    { provide: PdkRuntime, useValue: new PdkRuntime() },
    {
      provide: GameRegistry,
      useFactory: (ddz: DdzRuntime, pdk: PdkRuntime) => {
        const registry = new GameRegistry();
        registry.register(ddz);
        registry.register(pdk);
        return registry;
      },
      inject: [DdzRuntime, PdkRuntime],
    },
  ],
  exports: [GameService],
})
export class GameModule {}
