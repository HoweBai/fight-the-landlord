// packages/payment-service/src/scan/replay-anchor.ts
import { Logger } from '@nestjs/common';
import {
  ErrCode,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
} from '@fight-the-landlord/protocol';
import { paymentFundopRetryTotal } from '../metrics/payment.metrics';
import {
  CurrencyServiceError,
  isDefinitiveFundOpFailureCode,
  type CurrencyRpcClient,
} from '../rpc/currency.client';

/**
 * 支付片 T9：**资金动作统一恢复模型**的编码面（设计 §2.5 四原则逐条落进注释与实现；
 * T10/T11 复用）。本文件是**叶子模块**（只依赖 protocol/shared 抽象与 currency 客户端
 * 类型，不 import 任何领域服务）—— 目的：让 `withdraw.service.ts`/`refund.service.ts`
 * （T10/T11）与 `scan.service.ts`（未来注入它们的循环）之间**不出现模块环**
 * （CJS 环的 DI 静默破损是本仓既有陷阱族）。
 *
 * ─── 设计 §2.5 四原则（逐条）────────────────────────────────────────────────
 *  ① **停留原位**——apply 结果未知（网络/超时）⇒ 不改终态、不留"假终态"：
 *     `replayAnchor` 把未知归为 `unknown` / `rollback_stalled(unknown)`，调用方据此保持
 *     停留态（paid / holding / rolling_back / rejecting），**绝不**写终态列。
 *  ② **同锚重试扫描**——重放同一 actionId（幂等：成功返回原结果、失败原样再判）：
 *     本函数 = 一次重放；扫描每周期对每行调用一次（付款锚 `pay:<no>` 等五形见
 *     `fundOpAnchor`；锚先于入账/冻结落库——apply 请求即锚过线，currency 侧
 *     `uk_action_id` 是幂等点）。
 *  ③ **claim 先行**——一切状态迁移用条件 UPDATE 先抢行、再动外部（钱/渠道）、最后记完成列：
 *     本函数只做「动外部（apply）」这一步；抢行（如 `paid→credited` 条件更新）由调用方在
 *     结果明确后执行（T9 `ScanService.creditOrder` 是范例）。
 *     正向动作仅**明确失败**（14001 余额不足、14002 锚冲突、10001 载荷非法）迁失败终态
 *     —— 映射为 `definitive_failure`（`isDefinitiveFundOpFailureCode`）。
 *  ④ **回滚动作例外**——`withdraw_rb`/`refund_rb` 明确失败 ⇒ **留停留态**
 *     （`rolling_back`/`rejecting`）+ 告警转人工（绝不误置终态、不释槽：误置 = 币未回而
 *     槽已放，破钱）。本函数把回滚族的「明确失败」**从不产出 `definitive_failure` 种类**
 *     ——产出 `rollback_stalled(reason='definitive_failure')` 并**响亮 error 日志**；
 *     回滚族的未知同样落 `rollback_stalled(reason='unknown')`。**运行期保证成立；类型提示
 *     辅助（`ReplayOutcome` 联合未随 `op` 收窄——编译期误写 `definitive_failure` 分支仍放行，
 *     属永不产出的死代码）**：回滚调用方运行期拿不到「可迁失败终态」的返回值，T10/T11 以
 *     `rollback_stalled` 区分（波 3 评审 🟢-1 措辞订正，不引入 overload）。
 *
 * ─── 五动作表（设计 §2.5 表格的代码注记；扫描统一周期 `pay.scanIntervalMs` 配置键）────
 *  | 资金动作 | 锚 | 停留态 | 收敛 |
 *  |---|---|---|---|
 *  | 充值入账 | `pay:<no>` | `paid` | 成功 ⇒ `credited`；停留 > 15m ⇒ 告警 |
 *  | 提现冻结解析 | `withdraw:<no>` | `holding` | 成功 ⇒ `pending`；明确失败 ⇒ `failed`；未知 ⇒ 继续 + >15m 告警 |
 *  | 提现回滚 | `withdraw_rb:<no>` | `rolling_back` | 落账 ⇒ 终态（`rejected`/`timeout_rolled_back`）；未知/明确失败 ⇒ 停留 + >1h 告警 |
 *  | 退款冻结解析 | `refund:<no>` | `holding` | 成功 ⇒ `pending`；明确失败 ⇒ `failed`；未知 ⇒ 继续 + >15m 告警 |
 *  | 退款回滚 | `refund_rb:<no>` | `rejecting` | 落账 ⇒ `rejected`；未知/明确失败 ⇒ 停留 + >1h 告警 |
 *  （告警 = `PaymentFundOpStalled`，判据由 `payment_fundop_oldest_age_seconds` 驱动。）
 */
export type FundOp = 'pay' | 'withdraw_hold' | 'withdraw_rb' | 'refund_hold' | 'refund_rb';

/** 回滚族（原则④的例外面）。 */
export type RollbackFundOp = 'withdraw_rb' | 'refund_rb';

/** op 值域（指标 `payment_fundop_*{op}` 的同一集合；§2.6 逐字五值）。 */
export const FUND_OPS: readonly FundOp[] = ['pay', 'withdraw_hold', 'withdraw_rb', 'refund_hold', 'refund_rb'];

export const ROLLBACK_FUND_OPS: readonly RollbackFundOp[] = ['withdraw_rb', 'refund_rb'];

export function isRollbackFundOp(op: FundOp): op is RollbackFundOp {
  return (ROLLBACK_FUND_OPS as readonly string[]).includes(op);
}

/** 五锚形（设计 §2.4「锚恰 5 形」逐字；`pay:<orderNo>` 等——冒号后接业务单号）。 */
export const FUND_OP_ANCHOR_PREFIXES: Record<FundOp, string> = {
  pay: 'pay:',
  withdraw_hold: 'withdraw:',
  withdraw_rb: 'withdraw_rb:',
  refund_hold: 'refund:',
  refund_rb: 'refund_rb:',
};

/** `op` + 业务单号 ⇒ 同锚重放的 `actionId`（形状唯一生成点，防手拼漂移）。 */
export function fundOpAnchor(op: FundOp, no: string): string {
  return `${FUND_OP_ANCHOR_PREFIXES[op]}${no}`;
}

/**
 * 一次重放的分类结果（三分类 + 回滚合并态）。
 *
 * - `applied`：远端明确成功（含 `replayed:true` 的原结果返回）—— 调用方执行「claim 完成列」
 *   （条件 UPDATE 置终态/推进）。
 * - `definitive_failure`：**正向动作**的明确业务失败（10001/14001/14002）⇒ 可迁失败终态。
 * - `unknown`：**正向动作**结果未知（传输/超时/10007/非预期异常）⇒ 停留原位 + 下轮重放。
 * - `rollback_stalled`：**回滚动作**（原则④）的任何非成功结果（明确失败或未知）⇒ 一律
 *   留停留态 + 告警转人工；`reason` 仅供日志/告警分级（明确失败可转人工、未知继续重放），
 *   **两条处置都不迁终态**。
 */
export type ReplayOutcome =
  | { kind: 'applied'; data: CurrencyApplyData }
  | { kind: 'definitive_failure'; code: ErrCode; message: string }
  | { kind: 'unknown'; code: ErrCode; message: string }
  | { kind: 'rollback_stalled'; reason: 'definitive_failure' | 'unknown'; code: ErrCode; message: string };

export interface ReplayAnchorOptions {
  /**
   * 是否计 `payment_fundop_retry_total{op}`（默认 **true** —— 本函数的家谱是重试扫描：
   * 每次「同锚重放」恰计一次）。**首尝试**路径（notify/sync 的即时入账等）显式传
   * `false`——它们不是重放。
   */
  countRetry?: boolean;
}

const logger = new Logger('ReplayAnchor');

/** 错误 ⇒ 分类素材（非 CurrencyServiceError 的异常 = 非预期 ⇒ 未知 + 响亮日志）。 */
function classifyFundOpError(err: unknown): { definitive: boolean; code: ErrCode; message: string } {
  if (err instanceof CurrencyServiceError) {
    return { definitive: isDefinitiveFundOpFailureCode(err.code), code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { definitive: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
}

/**
 * **同锚重放一次**（设计 §2.5② 的执行面；分类语义见 `ReplayOutcome` 各注释）。
 *
 * @param client  currency 出站边（`CurrencyRpcClient`；T9 起本服务唯一写边封装）
 * @param op      资金动作（五值；决定回滚例外是否生效）
 * @param anchor  幂等锚（`fundOpAnchor` 生成；形状不符 = 编程错误 ⇒ **响亮抛**，不发出去）
 * @param request apply 请求减 `actionId`（source/entries/refId 由调用方给——金额只经
 *                `currency.apply`，本函数不碰任何本地金额账）
 * @returns 分类结果；**不抛**业务失败/未知（抛 = 编程错误类不变量破坏）
 */
export async function replayAnchor(
  client: CurrencyRpcClient,
  op: FundOp,
  anchor: string,
  request: Omit<CurrencyApplyRequest, 'actionId'>,
  opts: ReplayAnchorOptions = {},
): Promise<ReplayOutcome> {
  const prefix = FUND_OP_ANCHOR_PREFIXES[op];
  if (!anchor.startsWith(prefix) || anchor.length === prefix.length) {
    throw new Error(
      `replayAnchor: 锚 ${JSON.stringify(anchor)} 与 op=${op} 的形状不符（须以 ${JSON.stringify(prefix)} 开头且带业务单号）`,
    );
  }

  if (opts.countRetry ?? true) paymentFundopRetryTotal.labels(op).inc();

  try {
    const data = await client.apply({ ...request, actionId: anchor });
    return { kind: 'applied', data };
  } catch (err) {
    const classified = classifyFundOpError(err);

    if (isRollbackFundOp(op)) {
      // 🔴 原则④：回滚动作例外 —— 明确失败也**停留原位**（绝不误置终态、不释槽：
      // 误置 = 币未回而槽已放，破钱）。error 级响亮：这条线要转人工（告警的最后一公里）。
      logger.error(
        `回滚锚 ${anchor}（op=${op}）非成功（${classified.definitive ? '明确失败' : '结果未知'}，code=${classified.code}）` +
          `⇒ 留停留态 + 告警转人工（绝不误置终态）：${classified.message}`,
      );
      return {
        kind: 'rollback_stalled',
        reason: classified.definitive ? 'definitive_failure' : 'unknown',
        code: classified.code,
        message: classified.message,
      };
    }

    if (classified.definitive) {
      // 原则③：正向动作的明确失败 —— 调用方可迁失败终态（如提现/退款解析的 failed）。
      logger.warn(
        `同锚重放明确失败：${anchor}（op=${op}）code=${classified.code} —— ${classified.message}`,
      );
      return { kind: 'definitive_failure', code: classified.code, message: classified.message };
    }

    // 原则①：结果未知 ⇒ 停留原位、不改终态；下轮（60s 重放）同锚再来（原则②）。
    logger.warn(
      `同锚重放结果未知：${anchor}（op=${op}）code=${classified.code} ⇒ 停留原位、下轮同锚重放：${classified.message}`,
    );
    return { kind: 'unknown', code: classified.code, message: classified.message };
  }
}
