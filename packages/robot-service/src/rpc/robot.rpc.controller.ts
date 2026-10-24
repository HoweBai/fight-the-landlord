// packages/robot-service/src/rpc/robot.rpc.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  RPC_PATTERNS,
  type RobotAcquireRequest,
  type RobotAcquireResponse,
  type RobotAvailabilityRequest,
  type RobotAvailabilityResponse,
  type RobotDecideRequest,
  type RobotDecideResponse,
  type RobotReleaseRequest,
  type RobotReleaseResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { RobotService } from '../robot/robot.service';
import { toResult } from './to-result';

/**
 * §4.2 的 TCP RPC **监听方**（N20 / P4 Task 1b）—— `robot-service` 侧。
 *
 * ⚠️ **对外 REST 与内部 RPC 严禁共用方法**（Global Constraint 4）：本控制器的三个方法
 * **只**被 `@MessagePattern` 调用；`RobotController` 的 HTTP 面继续走它自己的
 * `acquire()` / `release()` / `decide()`。两侧唯一共享的是 `RobotService` 的业务方法。
 *
 * ⚠️ 每个 handler 返回 **R220 的信封** `RpcResult<T>`，**不抛**业务错误。
 *
 * ⚠️ **内部身份边界不变（R223）**：TCP 监听方不走 HTTP 中间件 ——
 * `createInternalTokenMiddleware()` 仍按原样保护剩余的 HTTP 面（`/api/robots/list`、
 * `/api/health`、两条兼容壳）。RPC 端口只在 compose 内网可达（§2.1「不对外暴露」）。
 *
 * ⚠️ **判据 7（接收侧）/ R1107**：三个 handler 都把 `dto?.meta` 交给 `toResult()` ——
 * 处理期间的日志（`RobotPool` 自己打的行、含 `catch` 里的）因此落在**调用方那条链**
 * 上。无 `meta` 时**不编造** id（`traceId: null`），但 `source` 仍是 `rpc`
 *（"我在处理一次 RPC"就是来源）。
 */
@Controller()
export class RobotRpcController {
  constructor(private readonly robotService: RobotService) {}

  /**
   * §4.2：`robot.acquire`（room → robot）—— **幂等**（R201：同 `{roomCode, seat}`
   * 返回同一个 `BotInstance`）。这正是调用方「失败重试 1 次」得以安全落地的前提（§4.3）。
   */
  @MessagePattern(RPC_PATTERNS.robotAcquire)
  acquire(@Payload() dto: RobotAcquireRequest): Promise<RpcResult<RobotAcquireResponse>> {
    return toResult(() => this.robotService.acquire(dto), dto?.meta);
  }

  /** §9.6：`robot.release`（room → robot）—— 局终归池。 */
  @MessagePattern(RPC_PATTERNS.robotRelease)
  release(@Payload() dto: RobotReleaseRequest): Promise<RpcResult<RobotReleaseResponse>> {
    return toResult(() => this.robotService.release(dto), dto?.meta);
  }

  /**
   * 片② D5：`robot.availability`（room → robot）—— 房间侧门禁问「DouZero 能用吗」。
   * 载荷**不带业务字段**（答案只取决于开关 + DouZero 现状）；判定与 5s 缓存都在
   * `RobotService.availability()` → `DouZeroHealth`（`canProvide()` **永不抛**）。
   */
  @MessagePattern(RPC_PATTERNS.robotAvailability)
  availability(@Payload() dto: RobotAvailabilityRequest): Promise<RpcResult<RobotAvailabilityResponse>> {
    // 多玩法（Task 2.6）：pdk 由 RobotService 直接给「可给」、不探测 DouZero。
    return toResult(() => this.robotService.availability(dto?.gameType), dto?.meta);
  }

  /**
   * §4.2：`robot.decide`（game → robot，§9.4 的回合驱动）。
   *
   * ⚠️ 载荷是 `RobotDecideRequest{roomCode,botId,skillLevel,view,features}` ——
   * **只有裁剪视图 + 公开特征**，绝不接收整份对局会话（§9.5）。
   * ⚠️ **5s / 不重试**（§4.3）由**调用方**（`game-service/src/game/robot.client.ts`）承担，
   * 不在 handler 里做任何超时/重试 —— 与 `game.action` 同一条分工理由。
   */
  @MessagePattern(RPC_PATTERNS.robotDecide)
  decide(@Payload() dto: RobotDecideRequest): Promise<RpcResult<RobotDecideResponse>> {
    return toResult(() => this.robotService.decide(dto), dto?.meta);
  }
}
