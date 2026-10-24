// packages/robot-service/src/robot/robot.controller.ts
import { Body, Controller, Get, Post } from '@nestjs/common';
import { RobotService } from './robot.service';

/**
 * `robot-service` 的**对外 HTTP 面**（R218 / R222）。
 *
 * ⚠️⚠️ **`acquire` / `release` / `decide` 三条 HTTP 路由已整条删除**（N20/P4，R218）。
 * 它们现在是 §4.2 的 **TCP RPC** pattern（`RPC_PATTERNS.robotAcquire|robotRelease|robotDecide`），
 * 由 `src/rpc/robot.rpc.controller.ts` 的 `@MessagePattern` 承载：
 *
 *   - 调用方是 `room-service`（3105）与 `game-service`（3105），**不是客户端**；
 *   - §4.2 要求「对内 RPC」与「对外 REST」**不共用方法** ⇒ 两条通道各有一个入口类，
 *     但它们共享 `RobotService` 的**同一个**业务实现（单一真源）。
 *
 * ⚠️ 只删路由、**不删** `RobotService.acquire/release/decide` —— 那是唯一实现，
 * 删了 RPC 侧就没东西可调。**也不要**把这三条 HTTP 路由「保留成兼容壳」：
 * 同一语义两条通道 = 第二个真源，正是 R218 要消灭的东西。
 * ⚠️ 门禁期实测：后端 agent 漏删了这三条，`slice-07.2-rpc` 第 5 组在
 * `direct3005 POST /api/robots/acquire → 200` 上确定性红 —— **判据先抓住了漏删**。
 */
@Controller('robots')
export class RobotController {
  constructor(private readonly robotService: RobotService) {}

  /** 兼容壳（R207：**单一实现**在 `acquire`）：旧的补位入口。 */
  @Post('create')
  async createBot(@Body() dto: { roomCode: string; seat?: number }) {
    return this.robotService.createBot(dto.roomCode, dto.seat ?? 0);
  }

  /** 兼容壳（单一实现在 `release`）。 */
  @Post('remove')
  async removeBot(@Body() dto: { botId: string }) {
    const released = await this.robotService.removeBot(dto.botId);
    return { ok: true, released };
  }

  /** 池中**空闲**机器人（对局中的机器人在池外）。返回**裸数组**（既有契约）。 */
  @Get('list')
  async listBots() {
    return this.robotService.getAllBots();
  }
}
