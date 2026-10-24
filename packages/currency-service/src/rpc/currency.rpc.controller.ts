import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyRequest,
  type CurrencyApplyResponse,
  type CurrencyCardCounterConsumeRequest,
  type CurrencyCardCounterConsumeResponse,
  type CurrencyEntryFeeSkipRequest,
  type CurrencyEntryFeeSkipResponse,
  type CurrencyGetRequest,
  type CurrencyGetResponse,
} from '@fight-the-landlord/protocol';
import { ApplyService } from '../apply/apply.service';
import { GetService } from '../apply/get.service';
import { EntryFeeSkipService } from '../skip/entry-fee-skip.service';
import { CardCounterConsumeService } from '../card-counter/consume.service';

/**
 * 货币核心（T4；规格 §2.2 禁双份实现 / §2.3 响应段 / §2.4）：`currency.apply` +
 * `currency.get` 的 **currency-service 接收侧**（TCP 3104）；台费片 T3 起 +`currency.entryFeeSkip`
 * （免单逐笔记账，第三 pattern）。
 *
 * 🔴 **J21 的接收侧**：本类的三条 `@MessagePattern(RPC_PATTERNS.<键>)` 是
 * `robot-availability-wiring.gate.test.ts` 全包扫描要找的那三条；承载类还必须被某个
 * `*.module.ts` 的 `controllers:` 注册（`rpc.module.ts`，经 `app.module.ts` 进入容器）——
 * **加键与接收侧/注册必须同一提交**（T6 教训：未注册 = 单测全绿而真容器 404）。
 *
 * ─── 职责边界（三条都不做业务）───────────────────────────────────────────
 *  - `currency.apply` ⇒ **直透** `ApplyService.apply` 的返回值（T3 内核：校验/幂等/14001/14002
 *    全在它里面；控制器**不改写任何字段** —— `replayed`、`opId`、entries 原样过线）。
 *  - `currency.get` ⇒ 调 `GetService.get(ownerIds)`（读路径信封）。
 *  - `currency.entryFeeSkip` ⇒ 直透 `EntryFeeSkipService.record(dto)`（台费片 T3 内核：
 *    校验/`INSERT IGNORE` 幂等/0/1 判读全在它里面；控制器只做系统级错映射）。
 *  - `meta` 无需在此搬运：apply 的 `dto.meta.traceId` 由 `ApplyService` 直接读进
 *    `currency_ops.trace_id`（§2.3 步骤 1）；get 是只读边、无落点；skip 的
 *    `dto.meta.traceId` 由 `EntryFeeSkipService` 直接读进 `currency_entry_fee_skips.trace_id`。
 *
 * ─── 错误姿态（R220 信封；`record.rpc.controller` / `config.rpc.controller` 同口径）──
 *  - **业务错误不抛**：10001/14001/14002 由服务层翻成 `{ok:false,code,message}` 返回。
 *  - **系统级故障**（DB 不可达、驱动回执畸形）：服务层**抛**，在这里映射成
 *    `{ok:false, code:UPSTREAM_UNAVAILABLE(10007), message}` —— Nest 的 `RpcException`
 *    到客户端只剩字符串 message，5 位数字码会丢（R220 存在的理由）。
 *  - **传输层故障才抛**（连不上/超时），由**调用方**映射 10007（§2.3 末段；发送侧纪律）。
 *
 * ⚠️ **DI 纪律**：三个服务类**值导入** + 显式 `@Inject(...)`（不依赖
 * `emitDecoratorMetadata` —— vitest/esbuild 不发它；`import type` 则让真容器启动即崩）。
 */
@Controller()
export class CurrencyRpcController {
  private readonly logger = new Logger(CurrencyRpcController.name);

  constructor(
    @Inject(ApplyService) private readonly applyService: ApplyService,
    @Inject(GetService) private readonly getService: GetService,
    /** 台费片：免单逐笔记账（第三 pattern；见 `entryFeeSkip`）。 */
    @Inject(EntryFeeSkipService) private readonly skipService: EntryFeeSkipService,
    /** 记牌器收费片：开局消费权益（第四 pattern；见 `cardCounterConsume`）。 */
    @Inject(CardCounterConsumeService) private readonly consumeService: CardCounterConsumeService,
  ) {}

  @MessagePattern(RPC_PATTERNS.currencyApply)
  async apply(@Payload() dto: CurrencyApplyRequest): Promise<CurrencyApplyResponse> {
    try {
      return await this.applyService.apply(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`currency.apply 系统级失败（映射 UPSTREAM_UNAVAILABLE）：${message}`);
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }

  @MessagePattern(RPC_PATTERNS.currencyGet)
  async get(@Payload() dto: CurrencyGetRequest): Promise<CurrencyGetResponse> {
    try {
      return await this.getService.get(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`currency.get 系统级失败（映射 UPSTREAM_UNAVAILABLE）：${message}`);
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }

  @MessagePattern(RPC_PATTERNS.currencyEntryFeeSkip)
  async entryFeeSkip(@Payload() dto: CurrencyEntryFeeSkipRequest): Promise<CurrencyEntryFeeSkipResponse> {
    try {
      return await this.skipService.record(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`currency.entryFeeSkip 系统级失败（映射 UPSTREAM_UNAVAILABLE）：${message}`);
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }

  @MessagePattern(RPC_PATTERNS.currencyCardCounterConsume)
  async cardCounterConsume(
    @Payload() dto: CurrencyCardCounterConsumeRequest,
  ): Promise<CurrencyCardCounterConsumeResponse> {
    try {
      return await this.consumeService.consume(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `currency.cardCounterConsume 系统级失败（映射 UPSTREAM_UNAVAILABLE）：${message}`,
      );
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }
}
