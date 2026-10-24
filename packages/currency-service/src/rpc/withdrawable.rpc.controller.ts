import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import {
  RPC_PATTERNS,
  type CurrencyWithdrawableGetRequest,
  type CurrencyWithdrawableGetResponse,
} from '@fight-the-landlord/protocol';
import { WithdrawableService } from '../currency/withdrawable.service';

/**
 * 支付片 T4：`currency.withdrawable.get` 的 **currency-service 接收侧**（TCP 3104）——
 * 可离场额度（cap）只读口径（规格 §2.2 契约 / §2.2.1 公式；唯一实现点 = `WithdrawableService`）。
 *
 * 🔴 **J21 的接收侧**：本类的 `@MessagePattern(RPC_PATTERNS.currencyWithdrawableGet)` 是
 * `robot-availability-wiring.gate.test.ts` 全包扫描要找的那一条；承载类还必须被
 * `app.module.ts` 的 `controllers:` 注册（**注册链完整**：app → 本控制器）——**加键与接收侧/
 * 注册必须同一提交**（风控 T4 先例；T6 教训：未注册 = 单测全绿而真容器 `NO_MESSAGE_HANDLER`）。
 * ⚠️ 常量形态（`RPC_PATTERNS.<键>`）是硬要求：字面量形态在 J21 的集合等值里会表现为「缺少接收侧」。
 *
 * ─── 职责边界（不做业务）─────────────────────────────────────────────────
 *  直透 `WithdrawableService.get` 的返回值（校验/两条读/clamp 全在服务层；控制器**不改写任何字段**）。
 *
 * ─── 错误姿态（与既有 RPC 控制器**不同**的一处，依据写在这里）──────────────────
 *  本 RPC 的响应**不是 RpcResult 信封**（§2.2 逐字 `{cap, balance}`）——业务错误**无信封通道**：
 *  服务层抛什么，这里就往上抛（try/catch 只为「响亮不静默」留一行 error 日志 + **把原文装进
 *  `RpcException` 过线**——裸抛会被 Nest 折成恒定的 `"Internal server error"`，真原因丢）。
 *  调用方（payment 提现/退款链）以「RPC 失败 ⇒ fail-closed 拒申请」接住（15003/15006，§2.2.1 纪律）。
 *  `meta` 无需在此搬运：本边是只读、无落点（同 `currency.get` 的说明）。
 *
 * ⚠️ **DI 纪律**：`WithdrawableService` **值导入** + 显式 `@Inject(...)`（不依赖
 * `emitDecoratorMetadata` —— vitest/esbuild 不发它；`import type` 则让真容器启动即崩）。
 */
@Controller()
export class WithdrawableRpcController {
  private readonly logger = new Logger(WithdrawableRpcController.name);

  constructor(@Inject(WithdrawableService) private readonly withdrawableService: WithdrawableService) {}

  @MessagePattern(RPC_PATTERNS.currencyWithdrawableGet)
  async withdrawable(
    @Payload() dto: CurrencyWithdrawableGetRequest,
  ): Promise<CurrencyWithdrawableGetResponse> {
    try {
      return await this.withdrawableService.get(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `currency.withdrawable.get 失败（不吞——调用方 fail-closed 拒；原文经 RpcException 过线）: ${message}`,
      );
      // ⚠️ **不裸抛**：Nest 对非 `RpcException` 的抛出会折成恒定的 `"Internal server error"`
      // 过线（`base-rpc-exception-filter` 的 `UNKNOWN_EXCEPTION_MESSAGE`）—— 真原因会丢。
      // 翻成 `RpcException(message)` 让**原文过线**（R220 精神：错误信息必须可读地跨过 RPC
      // 边界；调用方侧日志因此可归因）。真栈实测：非法 ownerId ⇒ 回包 `message` = 中文原因。
      throw new RpcException(message);
    }
  }
}
