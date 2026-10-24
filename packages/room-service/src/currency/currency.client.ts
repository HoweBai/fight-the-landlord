// packages/room-service/src/currency/currency.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyCardCounterConsumeData,
  type CurrencyCardCounterConsumeRequest,
  type CurrencyEntryFeeSkipData,
  type CurrencyEntryFeeSkipRequest,
  type CurrencyGetData,
  type CurrencyGetRequest,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';
import { TRANSPORT_FAILURE_MESSAGE } from '../gateway/transport-failure';

/**
 * room-service → currency-service 的调用封装（② 金币场 T4；设计 §2 D8/§4.1/§4.2 的
 * 资金读边与写边）。
 *
 * 形态逐字照 `packages/user-service/src/currency/currency.client.ts:94-121`
 * （`ClientProxy` + `lastValueFrom` + `timeout` + `RpcResult` 解包 + 传输故障 ⇒ `10007`），
 * 复用 room 侧 `gateway/transport-failure.ts` 的固定文案与 `record.client.ts` 的成例。
 *
 * ─── 两条边（T4 只用 `get`；`apply` 由 T5/T6 的结算/机器人资金面消费）──────────
 *  - `get`（`currency.get`）：批量读余额 —— T4 的入场门槛（C4）、T5 的结算截断/全零广播、
 *    T6 的补给观测；
 *  - `apply`（`currency.apply`）：唯一写边 —— T5 的结算、T6 的池↔机器人调拨。
 *    T4 先把方法与错误语义**定死**（`Interfaces.Produces` 逐字），免得 T5/T6 各写一套。
 *
 * ⚠️ **超时 3s、不重试**（规格 §4.3 表：`currency.get` / `currency.apply` 均如此）：
 * 重试由调用方的业务动作决定（结算有它自己的分级/outbox，见 T5），本传输层不叠加。
 * 幂等锚在 `actionId`（写边）；读边天然幂等。
 *
 * ⚠️ **失败一律抛**（`CurrencyServiceError`）：调用方必须能区分「拿到了值」与
 * 「读不到」—— T4 的门槛拿不到余额就**拒入**（10007，不允许盲入），T5 拿不到余额
 * 就不该算出任何 delta（截断公式要真余额）。返回 0 会把「读不到」伪装成「没钱」。
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
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`CurrencyClient`）
 * **故意不同**（同 `config.client.ts` 与 `rpc-clients.module.ts` 的坑：同一个 `name`
 * 两处提供 ⇒ 解析到哪一个取决于注册顺序，脆且难查）。
 */
export const ROOM_CURRENCY_RPC_PROXY = 'ROOM_SERVICE_CURRENCY_RPC_PROXY';

/**
 * 规格 §2.13 env 表的 room-service 行：`CURRENCY_SERVICE_RPC_HOST` / `CURRENCY_SERVICE_RPC_PORT`
 * （默认 `currency-service` / `3104`）—— 命名照 `user-service/src/currency/currency.client.ts:60-66`
 * 先例，本组 env 的**唯一代码读取点**（`docker-compose.yml` 的 room 段补两行由 T13 收口）。
 */
export const currencyClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CURRENCY_SERVICE_RPC_HOST ?? 'currency-service',
    port: Number(process.env.CURRENCY_SERVICE_RPC_PORT ?? 3104),
  },
});

/** 两条边共用的超时（规格 §4.3：**3s**、不重试 —— 与 user 侧同名常量同值）。 */
export const CURRENCY_CLIENT_TIMEOUT_MS = 3000;

/**
 * room-service → currency-service 的 RPC 客户端。
 *
 * ⚠️ `ClientProxy` 由 `CurrencyModule` 经 `ClientsModule.register()` 提供
 * （token `ROOM_CURRENCY_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
 */
@Injectable()
export class CurrencyClient {
  private readonly logger = new Logger(CurrencyClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 投一次货币写操作（`currency.apply`，**唯一写边**）。
   *
   * @returns 下游 `CurrencyApplyData`（`opId` / `actionId` / `entries` 升序 / `replayed`）
   * @throws CurrencyServiceError 业务错误（下游 5 位码**原样**，R220）或传输故障
   *         （`10007` + 固定文案，原因只进日志）
   */
  async apply(request: CurrencyApplyRequest): Promise<CurrencyApplyData> {
    return this.call<CurrencyApplyData>(RPC_PATTERNS.currencyApply, request);
  }

  /**
   * 批量读余额（`currency.get`）。
   *
   * @returns 下游 `CurrencyGetData`（`balances` 逐条含 `ownerId/balance/exists`；
   *          `exists=false` 时 `balance` 仍为 **0**，读路径不建行）
   * @throws CurrencyServiceError 同 `apply`
   */
  async get(request: CurrencyGetRequest): Promise<CurrencyGetData> {
    return this.call<CurrencyGetData>(RPC_PATTERNS.currencyGet, request);
  }

  /**
   * 台费免单记账（本片 `currency.entryFeeSkip`；写边）。
   *
   * @returns `{inserted}`（本次是否新落行 —— 记账判别三步的判别面）
   * @throws CurrencyServiceError 同 apply（业务 5 位码原样 / 传输 ⇒ 10007）
   * ⚠️ **单次尝试、不重试**（规格 §2.4c；重发会以超时形态造行级重复——幂等写 + 唯一键是另一方面）。
   */
  async entryFeeSkip(request: CurrencyEntryFeeSkipRequest): Promise<CurrencyEntryFeeSkipData> {
    return this.call<CurrencyEntryFeeSkipData>(RPC_PATTERNS.currencyEntryFeeSkip, request);
  }

  /**
   * 记牌器开局消费（本片 `currency.cardCounterConsume`；写边、按 room+owner 幂等）。
   *
   * **重试恰好 1 次、仅 10007/传输失败**（同 room+owner 幂等 ⇒ 重试安全）；业务码
   * （10001 等）原样抛给调用方。重试耗尽仍 10007 ⇒ 抛出，由状态块按 D16 fail-open。
   */
  async cardCounterConsume(
    request: CurrencyCardCounterConsumeRequest,
  ): Promise<CurrencyCardCounterConsumeData> {
    try {
      return await this.call<CurrencyCardCounterConsumeData>(
        RPC_PATTERNS.currencyCardCounterConsume,
        request,
      );
    } catch (err) {
      if (err instanceof CurrencyServiceError && err.code === ErrCode.UPSTREAM_UNAVAILABLE) {
        return this.call<CurrencyCardCounterConsumeData>(
          RPC_PATTERNS.currencyCardCounterConsume,
          request,
        );
      }
      throw err;
    }
  }

  /**
   * 两条边的**共同形态**：3s 超时、不重试、`RpcResult` 解包、传输故障 ⇒ 10007 + 固定文案。
   *
   * - 信封 `{ok:false}` ⇒ 5 位码**原样**成为 `CurrencyServiceError.code`（R220）；
   * - 传输层故障（连不上 / 超时）⇒ `10007`，**消息不得内插 `err.message`**（它是
   *   `connect ECONNREFUSED 172.28.0.10:3104` 这类内部拓扑）—— 详情只进日志
   *   （不透传 ≠ 不留痕，Task 3g 修复 I2 同族纪律）。
   */
  private async call<T>(pattern: string, request: object): Promise<T> {
    try {
      const res = await lastValueFrom(
        this.proxy
          // R1104/R1105（判据 5）：本类是本条边的**唯一**发送点 ⇒ `meta` 只在这里加一次
          //（`...metaFromTrace()` 在 `send` 实参里 —— `meta-on-every-rpc-send` 闸扫这一处）。
          // 无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变。
          .send<RpcResult<T>>(pattern, {
            ...request,
            ...metaFromTrace(),
          })
          .pipe(timeout(CURRENCY_CLIENT_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        throw new CurrencyServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? pattern,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof CurrencyServiceError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency-service RPC ${pattern} failed: ${reason}`);
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}
