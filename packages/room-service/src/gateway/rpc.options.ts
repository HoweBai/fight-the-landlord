// packages/room-service/src/gateway/rpc.options.ts
import { Transport, type TcpClientOptions } from '@nestjs/microservices';

/**
 * §2.3：`GAME_SERVICE_RPC_HOST` / `GAME_SERVICE_RPC_PORT`（默认 `game-service` / `3103`）。
 *
 * §4.1 的「room-service → game-service」边**只**走 TCP RPC（HTTP 那条边是
 * gateway → game-service，与本服务无关）—— 因此本服务**不再**需要 `GAME_SERVICE_URL`。
 */
export const gameClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.GAME_SERVICE_RPC_HOST ?? 'game-service',
    port: Number(process.env.GAME_SERVICE_RPC_PORT ?? 3103),
  },
});

/**
 * §2.3：`ROBOT_SERVICE_RPC_HOST` / `ROBOT_SERVICE_RPC_PORT`（默认 `robot-service` / `3105`）。
 *
 * §2.3 明写它的使用者是 **room-service / game-service** 两个服务。
 */
export const robotClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.ROBOT_SERVICE_RPC_HOST ?? 'robot-service',
    port: Number(process.env.ROBOT_SERVICE_RPC_PORT ?? 3105),
  },
});

/**
 * §2.3：`CONFIG_SERVICE_RPC_HOST` / `CONFIG_SERVICE_RPC_PORT`（默认 `config-service` / `3106`）。
 *
 * 片⑦ 规格 §2.7：本边由旧的 room → user `config.baseScoreLevels` 改为
 * room → config-service 的 `config.snapshot`（配置中心统一提供五十一键；user-service 退场）。
 */
export const configClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CONFIG_SERVICE_RPC_HOST ?? 'config-service',
    port: Number(process.env.CONFIG_SERVICE_RPC_PORT ?? 3106),
  },
});

/**
 * 记录片 T5（设计 D2）：`USER_SERVICE_RPC_HOST` / `USER_SERVICE_RPC_PORT`
 * （默认 `user-service` / `3101`）。
 *
 * 这是 user-service **重挂 TCP 3101** 后的唯一一条边（`record.write`，room → user 写对局
 * 记录）。⚠️ 片⑦ 退役的是「room → user 读**底分档位表**」那一条边、**不是端口**
 * （`protocol/src/rpc.ts:14-19` 逐字）。超时 3s / **不重试** 的口径由 `RecordClient` 承担。
 */
export const recordClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.USER_SERVICE_RPC_HOST ?? 'user-service',
    port: Number(process.env.USER_SERVICE_RPC_PORT ?? 3101),
  },
});

/**
 * 风控 T3（规格 §2.3 / §2.8）：`risk.deviceReport`（room → user，fire-and-forget）——
 * 与 `recordClientOptions` **同一条 user-service 边**（3101、同一对 env），
 * 但**独立命名/实例**：两条边的失败语义不同（record 抛错给调用方；risk 恒吞成 warn），
 * 并且 `ClientProxy` 的名字是 DI token 的一部分（同名会被后注册者覆盖 —— 见 `RISK_RPC_PROXY`）。
 */
export const riskClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.USER_SERVICE_RPC_HOST ?? 'user-service',
    port: Number(process.env.USER_SERVICE_RPC_PORT ?? 3101),
  },
});

/**
 * 昵称片：`user.nicknames.get`（room → user，同 3101 边）。与 `recordClientOptions`
 * 同一对 env，但**独立命名/实例**（失败语义不同：昵称失败只降级显示，不抛）。
 */
export const nicknameClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.USER_SERVICE_RPC_HOST ?? 'user-service',
    port: Number(process.env.USER_SERVICE_RPC_PORT ?? 3101),
  },
});

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与下面两个「包装类 token」
 * **故意不同**。
 *
 * ⚠️ 若让包装 provider 与 `ClientsModule` 用**同一个** `name`，后者会被前者覆盖，
 * 而 `inject` 解析到的是哪一个取决于注册顺序 ⇒ 脆且难查（协调者点名的坑）。
 * 因此：`ClientsModule` 提供**裸 proxy**（挂在本 token 上），`useFactory` 再把它
 * 包成 `GameClient` / `RobotClient` / `ConfigClient`（挂在 `GAME_CLIENT` / `ROBOT_CLIENT` / 类 token 上）。
 */
export const GAME_RPC_PROXY = 'ROOM_SERVICE_GAME_RPC_PROXY';
export const ROBOT_RPC_PROXY = 'ROOM_SERVICE_ROBOT_RPC_PROXY';
export const CONFIG_RPC_PROXY = 'ROOM_SERVICE_CONFIG_RPC_PROXY';
/** 记录片 T5：room → user（`record.write`）的裸 proxy token（命名跟随类 `RecordClient`）。 */
export const RECORD_RPC_PROXY = 'ROOM_SERVICE_RECORD_RPC_PROXY';
/** 风控 T3：room → user（`risk.deviceReport`）的裸 proxy token（命名跟随类 `RiskClient`）。 */
export const RISK_RPC_PROXY = 'ROOM_SERVICE_RISK_RPC_PROXY';
/** 昵称片：room → user（`user.nicknames.get`）的裸 proxy token（命名跟随类 `NicknameClient`）。 */
export const NICKNAME_RPC_PROXY = 'ROOM_SERVICE_NICKNAME_RPC_PROXY';
