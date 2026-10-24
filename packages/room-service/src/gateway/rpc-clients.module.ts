// packages/room-service/src/gateway/rpc-clients.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
import { ConfigClient } from './config.client';
import { GameClient } from './game.client';
import { NicknameClient } from './nickname.client';
import { RecordClient } from './record.client';
import { RiskClient } from './risk.client';
import { RobotClient } from './robot.client';
import { GAME_CLIENT, RECORD_CLIENT, ROBOT_CLIENT } from './ws.gateway';
import {
  CONFIG_RPC_PROXY,
  GAME_RPC_PROXY,
  NICKNAME_RPC_PROXY,
  RECORD_RPC_PROXY,
  RISK_RPC_PROXY,
  ROBOT_RPC_PROXY,
  configClientOptions,
  gameClientOptions,
  nicknameClientOptions,
  recordClientOptions,
  riskClientOptions,
  robotClientOptions,
} from './rpc.options';

/**
 * `room-service` 的**服务间调用**装配（N20/P4 Task 3：HTTP → TCP RPC）。
 *
 * ─── 为什么单独一个模块 ─────────────────────────────────────────────────
 * `MatchService`（在 `MatchModule`）与 `WsGateway`（在 `WsModule`）**都要**这两个客户端，
 * 而 `WsModule` 已经 `imports: [MatchModule]` —— 把客户端放在 `WsModule` 里会形成
 * `MatchModule ⇄ WsModule` 的**循环依赖**（Nest 会要求 `forwardRef`，那是脆的补丁）。
 * 抽出本模块后依赖是单向的：`WsModule → RpcClientsModule`、`MatchModule → RpcClientsModule`。
 *
 * ⚠️ 片规格 §2.1 又加了第三对（`ConfigClient` / `CONFIG_RPC_PROXY`）：`RoomsService`
 * 建手动房时要校验底分 ⇒ `RoomsModule` 也 import 本模块（同一形态，单向）。
 *
 * ⚠️ 记录片 T5 加了第四对（`RecordClient` / `RECORD_RPC_PROXY`）：`WsGateway` 的
 * `game.ended` 分支要投 `record.write` ⇒ 挂在 `WsModule` 的消费面上。
 * **缺这一对 ⇒ 真容器装配 `WsGateway` 启动即崩**（`@Inject(RECORD_CLIENT)` 无 provider），
 * 而单测直接 `new WsGateway(...)`、看不见 —— 由 `test/ws.module.wiring.test.ts` 的
 * 「用 WsGateway 声明的 token 反向点名」判据钉住（R216/R217 同族）。
 *
 * ⚠️ 风控片 T3 加了第五对（`RiskClient` / `RISK_RPC_PROXY`）：`WsGateway` 把它经
 * `routerDeps()` 下传给 `handleMatch`（入队成功后的 `risk.deviceReport`）。
 * 同一条 user-service 边（3101）的**第二个**客户端；缺注册同样由装配门禁当场钉住
 * （本片起 `WsGateway` 的构造签名被 `toHaveLength(12)` + 下标身份断言覆盖）。
 *
 * ─── 为什么是「两个 token」而不是一个 ────────────────────────────────────
 * `ClientsModule.register()` 提供的是**裸 `ClientProxy`**。若直接把它挂在
 * `GAME_CLIENT` / `ROBOT_CLIENT` 上，就没有地方放我们的 `GameClient` / `RobotClient`
 * 包装类了；而若让包装 provider 与 `ClientsModule` 用**同一个 `name`**，
 * 后者会被前者覆盖，`inject` 解析到哪一个**取决于注册顺序**（脆且难查
 * —— 协调者点名的那个坑）。因此：
 *
 *   `ClientsModule.register([{name: GAME_RPC_PROXY}, {name: ROBOT_RPC_PROXY}])`
 *      ⇒ 提供**裸 proxy**（内部 token）
 *   `{provide: GAME_CLIENT, useFactory: (p) => new GameClient(p), inject: [GAME_RPC_PROXY]}`
 *      ⇒ 包装类挂在**公开 token** 上（单测照旧可以注入替身）
 *
 * ─── 为什么必须 `useFactory`（R216）─────────────────────────────────────
 * Nest 看不见「带默认值的普通对象参数」，`useClass` 会把它当成待注入的 provider
 * ⇒ 启动即崩：`Nest can't resolve dependencies of the GameClient (ClientProxy, ?)`。
 * **单测全绿也照样崩**（单测直接 `new GameClient(fake)`，不经容器）—— 只有容器门禁能抓到。
 */
@Module({
  imports: [
    ClientsModule.register([
      { name: GAME_RPC_PROXY, ...gameClientOptions() },
      { name: ROBOT_RPC_PROXY, ...robotClientOptions() },
      { name: CONFIG_RPC_PROXY, ...configClientOptions() },
      // 记录片 T5：room → user（`record.write`）；user-service 已重挂 TCP 3101（T4）。
      { name: RECORD_RPC_PROXY, ...recordClientOptions() },
      // 风控片 T3：room → user 的第二条边（`risk.deviceReport`）—— 同一条 3101（同一对 env），
      // 独立 proxy 名/实例（两条边的失败语义不同，见 `riskClientOptions` 的注释）。
      { name: RISK_RPC_PROXY, ...riskClientOptions() },
      // 昵称片：room → user（`user.nicknames.get`；失败只降级显示，不抛）。
      { name: NICKNAME_RPC_PROXY, ...nicknameClientOptions() },
    ]),
  ],
  providers: [
    { provide: GameClient, useFactory: (p: ClientProxy) => new GameClient(p), inject: [GAME_RPC_PROXY] },
    {
      provide: RobotClient,
      useFactory: (p: ClientProxy) => new RobotClient(p),
      inject: [ROBOT_RPC_PROXY],
    },
    /**
     * 片规格 §2.1：`room → user` 的**唯一**一条边（读底分档位表）。
     *
     * ⚠️ 与上面两条同形（R216：必须 `useFactory` —— `useClass` 会在启动时崩），
     * 且它**只挂在类 token** 上：消费方是 `RoomsService`（注入 `ConfigClient`），
     * 没有历史字符串 token 要照顾（`GameClient` 那条是历史包袱）。
     */
    {
      provide: ConfigClient,
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [CONFIG_RPC_PROXY],
    },
    /**
     * 记录片 T5：`WsGateway` 的 `record.write` 客户端。与上面三条同形
     * （R216：必须 `useFactory` —— `useClass` 会在启动时崩）。
     */
    {
      provide: RecordClient,
      useFactory: (p: ClientProxy) => new RecordClient(p),
      inject: [RECORD_RPC_PROXY],
    },
    /**
     * 风控片 T3：`WsGateway` 的 `risk.deviceReport` 客户端（经 `routerDeps()` 下传给
     * `handleMatch`）。同形（`useFactory`，R216）；消费方是**类 token**（`WsGateway`
     * 注入 `RiskClient` —— 与 `ConfigClient` 同款，不走历史字符串 token 形态）。
     */
    {
      provide: RiskClient,
      useFactory: (p: ClientProxy) => new RiskClient(p),
      inject: [RISK_RPC_PROXY],
    },
    /**
     * 昵称片：`RoomNicknamesService` 的 `user.nicknames.get` 客户端。
     * 同形（`useFactory`，R216）；消费方是 `RoomNicknamesService`（`WsModule` 提供）。
     */
    {
      provide: NicknameClient,
      useFactory: (p: ClientProxy) => new NicknameClient(p),
      inject: [NICKNAME_RPC_PROXY],
    },
    /**
     * ⚠️ **同一个实例必须以 `WsGateway` 注入的那个 token 再提供一次**（门禁期实测的容器缺陷）。
     *
     * `WsGateway` 注入的是**字符串 token**（`GAME_CLIENT = 'ROOM_SERVICE_GAME_CLIENT'`，
     * 历史形态，被既有用例引用），而本模块上面两条 provider 挂在**类 token**
     * （`GameClient` / `RobotClient`，`MatchService` 用的形态）上 —— 两者是**不同的 token**。
     * 只提供类 token ⇒ 容器装配 `WsGateway` 时直接崩（实测原文）：
     *
     *   `Nest can't resolve dependencies of the WsGateway (Redis, MatchService, ReconnectService,
     *    RoomsService, ?, ROOM_SERVICE_ROBOT_CLIENT). Please make sure that the argument
     *    "ROOM_SERVICE_GAME_CLIENT" at index [4] is available in the WsModule context.`
     *
     * 而 `test/ws.module.wiring.test.ts` **全绿** —— 它 compile 的是 `RpcClientsModule` 自己并
     * `get(GameClient)`/`get(RobotClient)`，从来没有断言「`WsGateway` 要的那两个 token 在容器里
     * 拿得到」。这是 R216/R217 的**第三次**同族发作，且它证明了一件事：
     * **「装配子集 compile 通过」与「真容器起得来」是两条不同的命题** —— 前者不蕴含后者。
     *
     * 修法：**同一个实例**同时挂在两个 token 下（`useExisting`），不复制实例。
     */
    { provide: GAME_CLIENT, useExisting: GameClient },
    { provide: ROBOT_CLIENT, useExisting: RobotClient },
    /** 记录片 T5：`WsGateway` 注入的字符串 token（同 GAME_CLIENT / ROBOT_CLIENT 的形态）。 */
    { provide: RECORD_CLIENT, useExisting: RecordClient },
  ],
  // `MatchService` 与 `WsGateway` 都在别的模块里 —— 必须 export（**含** `WsGateway` 注入的三个字符串 token）。
  exports: [
    GameClient,
    RobotClient,
    ConfigClient,
    RecordClient,
    // 风控 T3：`WsGateway` 的类 token 依赖（`WsModule` import 本模块 ⇒ 必须 export）。
    RiskClient,
    // 昵称片：`RoomNicknamesService`（WsModule 的 provider）依赖本客户端。
    NicknameClient,
    GAME_CLIENT,
    ROBOT_CLIENT,
    RECORD_CLIENT,
  ],
})
export class RpcClientsModule {}
