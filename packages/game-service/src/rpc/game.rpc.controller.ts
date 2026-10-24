// packages/game-service/src/rpc/game.rpc.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type GameActionRequest,
  type GameSnapshotRequest,
  type GameStartedResponse,
  type GameTrusteeRequest,
  type GameViewRequest,
  type GameView,
  type RpcResult,
  type StartGameRequest,
} from '@fight-the-landlord/protocol';
import { GameService } from '../game/game.service';
import { toResult } from './to-result';

/**
 * §4.2 的 TCP RPC **监听方**（N20 / P4 Task 1）。
 *
 * ⚠️ **对外 REST 与内部 RPC 严禁共用方法**（Global Constraint 4）：本控制器的各个方法
 * **只**被 `@MessagePattern` 调用；HTTP 面（`GameController`）继续走它自己的
 * `get()` / `getState()` / `bid()` / `playCards()` / `pass()`。两侧**唯一**共享的是
 * `GameService` 的业务方法本身（那本来就是同一份状态机）——
 * 「两个类、两套方法、一份业务」才是 §4.2 的形状。
 *
 * ⚠️ 每个 handler 返回 **R220 的信封** `RpcResult<T>`，**不抛**业务错误：
 * Nest 的 `RpcException` 到了客户端只剩字符串 `message`，5 位数字错误码会丢，
 * 而调用方（`message.router`）必须按码分流（`12004` vs `10007`）。
 *
 * ⚠️ **R224**：`view` 只吃 `userId` —— §4.2 逐字「seat 由服务端从 userId 解析，
 * 不由调用方提供」；否则调用方可指定他人座位，等于绕过裁剪。
 *
 * ⚠️ **判据 7（接收侧）/ R1107**：每个 handler 都把 `dto?.meta` 交给 `toResult()` ——
 * 处理期间的日志（`GameService` 自己打的行、含 `catch` 里的）因此落在**调用方那条链**
 * 上。无 `meta` 时**不编造** id（`traceId: null`），但 `source` 仍是 `rpc`
 *（"我在处理一次 RPC"就是来源）。
 */
@Controller()
export class GameRpcController {
  constructor(private readonly gameService: GameService) {}

  /** §4.2：`game.start`（room → game）。**幂等**（同 `roomCode` 复用会话）。 */
  @MessagePattern(RPC_PATTERNS.gameStart)
  start(@Payload() dto: StartGameRequest): Promise<RpcResult<GameStartedResponse>> {
    return toResult(async () => {
      const started = await this.gameService.startGame(dto);
      return { roomCode: started.roomCode, state: started.state, version: started.version };
    }, dto?.meta);
  }

  /**
   * §4.2：`game.snapshot`（room → game）—— **完整 `GameSession`**。
   *
   * §4.2 逐字：「**仅限服务间调用，绝不可用于对外路由**」。把响应缩到调用方真正需要的
   * 形状（这里照 §4.2 返回会话）而不复用任何对外方法，是这条边界的实现形态。
   *
   * ⚠️ 入参类型从 `{ roomCode: string }` 换成协议的 `GameSnapshotRequest`：
   * 后者**就是**「`roomCode` + 可选 `meta`」的逐字形状，拿它当载荷类型才不会在
   * `dto?.meta` 上产生一个假字段（那样要么编译不过，要么得用 `as` 把它藏起来）。
   */
  @MessagePattern(RPC_PATTERNS.gameSnapshot)
  snapshot(@Payload() dto: GameSnapshotRequest): Promise<RpcResult<unknown>> {
    return toResult(async () => {
      const session = await this.gameService.getSnapshot(dto?.roomCode);
      // 旧 HTTP 面在找不到时是 404 + `12001`；信封里保持**同一个码**（不新增错误码）
      if (!session) {
        throw Object.assign(new Error('Game not found'), { code: ErrCode.ROOM_NOT_FOUND });
      }
      return session;
    }, dto?.meta);
  }

  /** §4.2 / R224：`game.view` —— 座位**只**从 `userId` 解析。 */
  @MessagePattern(RPC_PATTERNS.gameView)
  view(@Payload() dto: GameViewRequest): Promise<RpcResult<GameView>> {
    return toResult(() => this.gameService.getViewForUser(dto?.roomCode, dto?.userId), dto?.meta);
  }

  /**
   * R219：动作转发（room → game）。
   *
   * ⚠️ **动作不重试**（§4.3 的重试表只覆盖 `game.start` / `game.snapshot` /
   * `robot.acquire`）：动作带 `baseVersion` CAS，重试会重复出牌 ——
   * 重试策略在**调用方**（`room-service/src/gateway/game.client.ts`），不在 handler。
   */
  @MessagePattern(RPC_PATTERNS.gameAction)
  action(@Payload() dto: GameActionRequest): Promise<RpcResult<GameView>> {
    return toResult(
      () =>
        this.gameService.actAndView(
          dto?.roomCode,
          dto?.userId,
          dto?.action,
          // R697：`GameActionRequest.payload` 已是精确类型 ⇒ **原来的 `as` 断言已删除**
          // （那是 spec §3.5-A 记的类型断言绕过：编译器不报形状错）。
          dto?.payload,
          dto?.baseVersion,
        ),
      dto?.meta,
    );
  }

  /**
   * 挂机治理 T4：`game.trustee`（room → game）—— 托管开关。
   *
   * ⚠️ **J21 三同提交**：`RPC_PATTERNS.gameTrustee` / 本 `@MessagePattern` / 模块注册
   * （`GameRpcController` 已在 `GameModule` 的 `controllers` 里）随 handler 同笔落地。
   * 业务错误不抛：`toResult` 按 `GameError.code` 保真（10001 / 12001 / 12004 / 13005 / 13009）。
   */
  @MessagePattern(RPC_PATTERNS.gameTrustee)
  trustee(@Payload() dto: GameTrusteeRequest): Promise<RpcResult<{ version: number }>> {
    return toResult(() => this.gameService.applyTrustee(dto), dto?.meta);
  }
}
