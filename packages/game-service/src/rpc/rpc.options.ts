// packages/game-service/src/rpc/rpc.options.ts
import { Transport, type TcpClientOptions } from '@nestjs/microservices';

/**
 * §4.2 末段 + §2.3：`game-service` 的 TCP RPC **监听**端口。
 *
 * 默认 **3103**（§2.3 的 `RPC_PORT`）；必须是**数字**
 * （`Transport.TCP` 的 `options.port` 收 `number`，传字符串会在 listen 时才炸）。
 */
export const GAME_RPC_PORT = Number(process.env.RPC_PORT ?? 3103);

/**
 * §4.2 末段逐字：`game-service` 的 TCP 微服务**监听参数** —— 即
 * `connectMicroservice({transport: Transport.TCP, options: <本函数的返回值>})` 里的
 * **那一层 `options`**，类型是 Nest 的 `TcpServerOptions`。
 *
 * ⚠️⚠️ **它只返回一层 `{host, port}`，绝不能再包一层**（R239，门禁期实测的缺陷）：
 * 早先本函数返回的是**整个** `{transport, options:{host,port}}`，而调用方又把它放进
 * `connectMicroservice({transport, options: <它>})` ⇒ port 落在 `options.options.port`，
 * 而 `ServerTCP` 读 `options.port` ⇒ 取到 `undefined` ⇒ **静默回落到
 * `TCP_DEFAULT_PORT`(3000)** ⇒ 与 HTTP 面撞端口 ⇒ `EADDRINUSE` 走进
 * `server-tcp.js` 那个「只对 `EADDRINUSE`/`ECONNREFUSED` 调 callback」的分支
 * ⇒ **照样打 `Nest microservice successfully started`，而 3103 上没有任何监听**。
 * 该缺陷**所有单测全绿**（单测直接 new 控制器、不经端口），只有「在真端口上连一次」能抓。
 *
 * ⚠️ `host: '0.0.0.0'` 不能省：Nest 的 `Transport.TCP` 默认只绑 `localhost`，
 * 那样**同 compose 网络里的其它容器连不上**（症状：room-service 侧 `ECONNREFUSED`，
 * 而本机 `docker compose exec` 里手动连却成功 —— 极难归因）。
 */
export const gameRpcServerOptions = (): { host: string; port: number } => ({
  host: '0.0.0.0',
  port: GAME_RPC_PORT,
});

/**
 * §2.3：`ROBOT_SERVICE_RPC_HOST` / `_PORT`（默认 `robot-service` / `3105`）。
 *
 * `game-service → robot-service` 的 `robot.decide` 客户端配置（§4.1 / §4.2 / §4.3）。
 * 与 `room-service` 的同名工厂**各自一份**：它读的是本进程的 env，且两个服务的
 * 依赖图不同（`game-service` 不依赖 `room-service`，反向亦然）——
 * 放进 `shared` 会把 Nest 微服务层的细节传染给 `shared`（计划 Task 1b 同款理由）。
 */
export const robotClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.ROBOT_SERVICE_RPC_HOST ?? 'robot-service',
    port: Number(process.env.ROBOT_SERVICE_RPC_PORT ?? 3105),
  },
});

/**
 * `game-service` 的 `robot.decide` **原始 `ClientProxy`** 的内部 token（Nest 装配用）。
 *
 * ⚠️ 它与「包装类 `RobotClient` 本身」是两个不同的 token，**故意分开**：
 * `ClientsModule.register({name})` 提供的是**裸 proxy**，再由 `useFactory` 包成
 * `RobotClient`。同名会让包装 provider 覆盖掉原始 proxy（协调者对 room-service
 * 的同款提醒；执行期采纳）。
 */
export const ROBOT_RPC_PROXY = 'GAME_SERVICE_ROBOT_RPC_PROXY';
