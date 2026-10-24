// packages/payment-service/src/rpc/currency.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyGetData,
  type CurrencyGetRequest,
  type CurrencyWithdrawableGetRequest,
  type CurrencyWithdrawableGetResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';

/**
 * payment-service → currency-service 的调用封装（支付片 T9；设计 §2.4 唯一写边 / ⚙️2）。
 *
 * ─── 三条调用（本服务的第二条出站边；第一条 = T2 的 `config.snapshot`）───────────
 *  - `apply`（`currency.apply`）：**一切余额变更的唯一通道**（入账/冻结/回滚；T9 循环③
 *    入账，T10/T11 冻结与回滚）；
 *  - `get`（`currency.get`）：批量余额读（T10 提现链的展示/复核面消费）；
 *  - `withdrawable`（`currency.withdrawable.get`）：cap 取数（**资金动作时刻锁内**调用，
 *    禁缓存、禁只查一次；T10/T11 消费）——⚠️ 本边**不是** `RpcResult` 信封（规格 §2.2
 *    逐字 `{cap, balance}`），失败一律走 observable error 面。
 *
 * ─── 形态（两条先例的合并，逐行对齐）──────────────────────────────────────────
 *  - `config/config.client.ts`（**本服务的**拷件形态）：本包不依赖 rxjs ⇒ 手工 Promise 桥
 *    （`subscribe` 首个 next 即结果、error 即失败、`setTimeout` 超时同值；timer 先武装后
 *    subscribe 的成例照抄）；
 *  - `user-service/src/currency/currency.client.ts`：`CurrencyServiceError` 错误类、固定
 *    传输文案、`RpcResult` 信封解包（下游 5 位码**原样**，R220）、传输故障 ⇒ `10007`。
 *
 * ─── 失败分流（设计 §2.5③ 的素材；供上层按恢复模型处理）────────────────────────
 *  - **明确业务错**（`isDefinitiveFundOpFailureCode`：10001 载荷非法 / 14001 余额不足 /
 *    14002 锚冲突）⇒ 确定性失败：正向动作可迁失败终态；**回滚动作例外**（留停留态 + 告警，
 *    见 `scan/replay-anchor.ts` 四原则④）；
 *  - **传输未知 / 信封 10007 / 其它** ⇒ 结果未知（apply 可能已在远端落账）⇒ **停留原位**、
 *    同锚重放（幂等锚保证重放安全）。
 *  本类**不重试**：重试语义在调用方（恢复模型②「同锚重试扫描」）。
 *
 * ─── meta 纪律（R1104/R1105；`meta-on-every-rpc-send` 闸全包扫）─────────────────
 *  三条调用经**同一个** `sendOnce`（本类是本条边的唯一发送点 ⇒ `...metaFromTrace()` 恰加
 *  一次）；无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变。
 *
 * ⚠️ **失败一律抛**（`CurrencyServiceError`）：调用方必须能区分「拿到了值」与「没拿到」
 * —— cap 取数失败 ⇒ fail-closed 拒申请（§2.2.1）；apply 失败 ⇒ 按恢复模型分类处置。
 * 返回假成功/默认值会把「未知」伪装成「成功」，直接破钱。
 */
export class CurrencyServiceError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'CurrencyServiceError';
  }
}

/**
 * 传输层故障（连不上 / 超时）时给**调用方**的固定文案。
 *
 * 🔴 消息**不得**内插 `err.message`（传输故障下它是 `ECONNREFUSED 172.28.x.x:3104`
 * 这类内部拓扑）—— 详情只进日志（`sendOnce` 抛之前的 warn 行），不透传 ≠ 不留痕。
 * 文案与 user/room/config 三侧的同名常量**逐字相同**。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`CurrencyRpcClient`）
 * **故意不同**（同 `config.client.ts` 的坑：同一个 `name` 两处提供 ⇒ 解析到哪一个取决于
 * 注册顺序，脆且难查）。
 */
export const PAYMENT_CURRENCY_RPC_PROXY = 'PAYMENT_SERVICE_CURRENCY_RPC_PROXY';

/**
 * 规格 §2.13 env 表的 payment-service 行：`CURRENCY_SERVICE_RPC_HOST` /
 * `CURRENCY_SERVICE_RPC_PORT`（默认 `currency-service` / `3104`）—— 命名照
 * `user-service/src/currency/currency.client.ts:60-66` 先例，本组 env 的**唯一代码读取点**。
 */
export const currencyClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CURRENCY_SERVICE_RPC_HOST ?? 'currency-service',
    port: Number(process.env.CURRENCY_SERVICE_RPC_PORT ?? 3104),
  },
});

/**
 * 三条边共用的超时（**3000ms** —— 规格 ⚙️2「RPC 超时一律 3000ms」；
 * 与 `user-service/src/currency/currency.client.ts:69` 同值先例）。
 *
 * ⚠️ 这个值参与**锁内预算**（设计 §2.4）：提现/退款链锁内最多 `withdrawable.get + apply`
 * 两次 RPC ⇒ 最坏锁持有时长 ≈ 2×3s ≪ `innodb_lock_wait_timeout` 默认 50s。
 */
export const CURRENCY_CLIENT_TIMEOUT_MS = 3000;

/**
 * **明确失败**码集（设计 §2.5③ 逐字："正向动作仅明确失败（14001 余额不足、14002 锚冲突、
 * 10001 载荷非法）迁失败终态"）—— 这三码 = currency-service 侧确定性的业务拒绝
 * （校验面/余额面/锚面，事务已整体回滚，**同锚重试没有任何意义**）。
 */
export const DEFINITIVE_FUND_OP_FAILURE_CODES: readonly ErrCode[] = [
  ErrCode.BAD_PARAM, // 10001：载荷非法（含 ownerType 异型）
  ErrCode.E_INSUFFICIENT_FUNDS, // 14001：余额不足（整批回滚）
  ErrCode.E_ACTION_CONFLICT, // 14002：锚冲突（同 id 不同内容 = 人祸）
];

/** 明确失败判别面（`scan/replay-anchor.ts` 的重放分类消费；T10/T11 的处置分支同源）。 */
export function isDefinitiveFundOpFailureCode(code: ErrCode): boolean {
  return (DEFINITIVE_FUND_OP_FAILURE_CODES as readonly number[]).includes(code);
}

/**
 * payment-service → currency-service 的 RPC 客户端。
 *
 * ⚠️ `ClientProxy` 由 `AppModule` 经 `ClientsModule.register()` 提供
 * （token `PAYMENT_CURRENCY_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
 */
@Injectable()
export class CurrencyRpcClient {
  private readonly logger = new Logger(CurrencyRpcClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 投一次货币写操作（`currency.apply`，**唯一写边**）。
   *
   * @returns 下游 `CurrencyApplyData`（`opId` / `actionId` / `entries` 升序 / `replayed`）
   * @throws CurrencyServiceError 业务错误（下游 5 位码**原样**，R220）或传输故障
   *         （`10007` + 固定文案，原因只进日志）—— 分类见文件头「失败分流」。
   */
  async apply(request: CurrencyApplyRequest): Promise<CurrencyApplyData> {
    return this.callEnvelope<CurrencyApplyData>(RPC_PATTERNS.currencyApply, request);
  }

  /**
   * 批量读余额（`currency.get`）。
   *
   * @returns 下游 `CurrencyGetData`（`balances` 逐条含 `ownerId/balance/exists`；
   *          `exists=false` 时 `balance` 仍为 **0**，读路径不建行）
   * @throws CurrencyServiceError 同 `apply`
   */
  async get(request: CurrencyGetRequest): Promise<CurrencyGetData> {
    return this.callEnvelope<CurrencyGetData>(RPC_PATTERNS.currencyGet, request);
  }

  /**
   * 读**可离场额度**（`currency.withdrawable.get`；锁内资金动作时刻调用）。
   *
   * ⚠️ 本边**不是信封**（规格 §2.2 逐字）：成功 = `{cap, balance}` 原样；失败 = observable
   * error（currency 侧 `RpcException` 过线 / 传输故障）——**任何**失败 ⇒ `CurrencyServiceError`
   * （fail-closed 面：调用方拒申请，15003/15006；§2.2.1 纪律）。
   * 形状校验（两个安全整数、非负）：坏形状 = 不可信读数 ⇒ 抛（不静默传 NaN 给 cap 判定）。
   */
  async withdrawable(request: CurrencyWithdrawableGetRequest): Promise<CurrencyWithdrawableGetResponse> {
    try {
      const res = (await this.sendOnce<unknown>(RPC_PATTERNS.currencyWithdrawableGet, request)) as
        | { cap?: unknown; balance?: unknown }
        | null
        | undefined;
      const cap = res?.cap;
      const balance = res?.balance;
      if (
        typeof cap !== 'number' ||
        !Number.isSafeInteger(cap) ||
        cap < 0 ||
        typeof balance !== 'number' ||
        !Number.isSafeInteger(balance) ||
        balance < 0
      ) {
        this.logger.error(
          `currency.withdrawable.get 回执形状非法（cap=${JSON.stringify(cap)} balance=${JSON.stringify(balance)}）—— 拒用`,
        );
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      }
      return { cap, balance };
    } catch (err) {
      if (err instanceof CurrencyServiceError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency-service RPC ${RPC_PATTERNS.currencyWithdrawableGet} failed: ${reason}`);
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 信封边的**共同形态**：3s 超时、不重试、`RpcResult` 解包、传输故障 ⇒ 10007 + 固定文案。
   *
   * - 信封 `{ok:false}` ⇒ 5 位码**原样**成为 `CurrencyServiceError.code`（R220）；
   * - 传输层故障（连不上 / 超时）⇒ `10007`，消息不透传内部拓扑（见常量注释）。
   */
  private async callEnvelope<T>(pattern: string, request: object): Promise<T> {
    try {
      const res = await this.sendOnce<RpcResult<T>>(pattern, request);
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `CurrencyServiceError.code`（§11.2）
        throw new CurrencyServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? pattern,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof CurrencyServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与 config 边**同码**；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency-service RPC ${pattern} failed: ${reason}`);
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 一次发送（不重试）：Observable → Promise 的**手工桥**（本包不依赖 rxjs；语义与
   * `config/config.client.ts` 的 `sendSnapshotOnce` 逐条对齐——首个 `next` 即结果、
   * `error` 即拒绝、超时 ⇒ 退订并拒绝；timer **先武装、后 `subscribe`** 的同一条理由）。
   *
   * ⚠️ 这是本类**唯一**的 `.send(` 发送点 ⇒ `...metaFromTrace()` 只在这里加一次
   * （`meta-on-every-rpc-send` 闸按调用文本检查）。
   */
  private sendOnce<TResponse>(pattern: string, payload: object): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      let subscription: { unsubscribe(): void } | undefined;
      const timer = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`${pattern} 超时（${CURRENCY_CLIENT_TIMEOUT_MS}ms 无回执）`));
      }, CURRENCY_CLIENT_TIMEOUT_MS);

      subscription = this.proxy
        .send<TResponse>(pattern, {
          ...payload,
          ...metaFromTrace(),
        })
        .subscribe({
          next: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          error: (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        });
    });
  }
}
