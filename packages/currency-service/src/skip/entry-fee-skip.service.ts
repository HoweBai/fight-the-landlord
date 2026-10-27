import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DEFAULT_GAME_TYPE,
  ErrCode,
  validateCurrencyEntryFeeSkip,
  type CurrencyEntryFeeSkipResponse,
  type GameType,
} from '@fight-the-landlord/protocol';

/**
 * 台费片 T3：`currency.entryFeeSkip` —— 免单**逐笔记账**的写边内核（唯一调用方 =
 * `CurrencyRpcController.entryFeeSkip`）。
 *
 * ─── 纪律（规格 §2.4c 逐字）──────────────────────────────────────────────
 *  - 入参取 `unknown`：**唯一校验点** `validateCurrencyEntryFeeSkip` 就在下一行（照
 *    `ApplyService.apply` 的 207-229 形态）——线到的一切都从这扇门过；
 *  - 幂等写：`INSERT IGNORE` + `(room_code, owner_id)` 唯一键（**并采、双源防重**：调用侧
 *    「单次不重试」防调用内重发；唯一键防同房二开跨调用）；
 *  - `affectedRows` **恰 0/1** 判读（0/1 之外 = 不变量破坏 ⇒ **响亮抛**，照 apply 的守卫）；
 *  - 应答 **`RpcResult` 信封** + data = `{inserted: boolean}`（r2-delta-F1 记账判别用）；
 *  - 审计面：**不进**管理审计族、**不可**管理面冲正（reverse 端点限 `admin_adjust` —— 反证）；
 *  - **不建账**：审计表，非资金表；任何情况下不动钱、不抛业务错以外的异常。
 */
const SKIP_INSERT_SQL =
  'INSERT IGNORE INTO `currency_entry_fee_skips` (`room_code`, `owner_id`, `seat`, `game_type`, `base_score`, `fee_amount`, `reason`, `trace_id`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

@Injectable()
export class EntryFeeSkipService {
  private readonly logger = new Logger(EntryFeeSkipService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async record(req: unknown): Promise<CurrencyEntryFeeSkipResponse> {
    // ── 校验入口（失败 ⇒ 10001 + 中文原因；先于**任何**库操作）──────────────────
    let request: {
      roomCode: string;
      ownerId: string;
      seat?: number;
      baseScore: number;
      feeAmount: number;
      reason: 'insufficient_funds' | 'unknown_outcome' | 'internal_error';
      gameType?: GameType;
      meta?: { traceId: string };
    };
    try {
      validateCurrencyEntryFeeSkip(req);
      request = req as typeof request;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency.entryFeeSkip reject code=${ErrCode.BAD_PARAM} reason=${message}`);
      return { ok: false, code: ErrCode.BAD_PARAM, message };
    }

    const result = await this.dataSource.query(SKIP_INSERT_SQL, [
      request.roomCode,
      request.ownerId,
      request.seat ?? null,
      request.gameType ?? DEFAULT_GAME_TYPE,
      request.baseScore,
      request.feeAmount,
      request.reason,
      request.meta?.traceId ?? null,
    ]);
    const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
    if (typeof affected !== 'number' || !Number.isInteger(affected) || (affected !== 0 && affected !== 1)) {
      throw new Error(
        `currency_entry_fee_skips INSERT IGNORE 回执异常：affectedRows=${JSON.stringify(affected)}（唯一键 ⇒ 0/1 之外是不变量破坏）`,
      );
    }
    if (affected === 0) {
      this.logger.log(
        `currency.entryFeeSkip duplicate（未落行）roomCode=${request.roomCode} ownerId=${request.ownerId}`,
      );
    }
    return { ok: true, data: { inserted: affected === 1 } };
  }
}
