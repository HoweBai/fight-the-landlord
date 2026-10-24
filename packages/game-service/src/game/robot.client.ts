// packages/game-service/src/game/robot.client.ts
import { Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import {
  RPC_PATTERNS,
  type RobotDecideRequest,
  type RobotDecideResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';

/**
 * §4.3 的超时表：`robot.decide`（game → robot）**5s / 不重试 / 失败 ⇒ 回退规则引擎**。
 *
 * 注意与 `robot.acquire` 的 3s 不同：决定链路比补位链路更愿意等一等，
 * 因为等不到也能**确定性地**回退到本地规则引擎（§9.3），不会让对局卡住。
 */
export const ROBOT_DECIDE_TIMEOUT_MS = 5000;

/**
 * game-service → robot-service 的**决策**客户端（§9.4 的 `robot.decide`）。
 *
 * ⚠️ **N20/P4 Task 4**：传输从「内部 HTTP 过渡形态」(`POST /api/robots/decide` +
 * `X-Internal-Token`) 换成 §4.2 逐字要求的 **`Transport.TCP` + `ClientProxy.send()`**。
 * 因此本类**不再**需要 `baseUrl` / `internalToken` / `fetchImpl`，也不再读
 * `ROBOT_SERVICE_URL`（§2.3 的那一行随之作废）。
 *
 * ⚠️ **R220**：handler 返回**信封** `RpcResult<RobotDecideResponse>`，
 * 业务错误在信封里（5 位数字码），传输故障才抛。本客户端对**两者一视同仁**：
 * 任何失败都 ⇒ `null`（§9.4 由调用方回退规则引擎，C9）。
 *
 * ⚠️ **不重试**（§4.3 逐字）：这里**不套 `retry()`**。重试一个「决策」没有意义
 * （同局面重复问一次不会更准），而且会让最坏耗时从 5s 变 10s，
 * 逼近 §9.4 的 30s 回合时限算式。
 *
 * ⚠️ 载荷**只有**裁剪视图 + 公开特征（§9.5）—— `GameSession` 永不出 game-service。
 */
@Injectable()
export class RobotClient {
  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 调一次决策。**任何失败都返回 `null`**（超时 / 传输错 / 形状非法），
   * 由调用方按 §9.4 回退规则引擎 —— 这里**不得**自己决定 pass（C9）。
   */
  async decide(req: RobotDecideRequest): Promise<RobotDecideResponse | null> {
    try {
      const res = await lastValueFrom(
        this.proxy
          // R1104/R1105（判据 5）：`game → robot` 这一跳同样带 `meta`（R1104 的「全链」
          // 含机器人决策）—— 本类是该边的**唯一**发送点 ⇒ meta 只在这里加一次。
          // 无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变（既有断言照旧）。
          .send<RpcResult<RobotDecideResponse>>(RPC_PATTERNS.robotDecide, { ...req, ...metaFromTrace() })
          // §4.3：5s 上限；超时 ⇒ 抛 ⇒ 下面的 catch 返回 null
          .pipe(timeout(ROBOT_DECIDE_TIMEOUT_MS)),
      );
      if (!res?.ok) return null;
      const data = res.data;
      // 形状校验与旧实现**逐字同义**：`kind` 必须是 play/pass，否则当作失败
      if (!data || (data.kind !== 'play' && data.kind !== 'pass')) return null;
      return data;
    } catch {
      return null;
    }
  }
}
