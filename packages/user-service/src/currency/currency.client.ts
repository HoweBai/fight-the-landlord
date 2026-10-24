// packages/user-service/src/currency/currency.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyApplyResponse,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * user-service → currency-service 的调用封装（货币片 T6 / 设计 §4.4：
 * **注册赠送**写边 `currency.apply` —— 本服务的**第二条**出站 RPC 边，第一条 = 记录片
 * `config.snapshot`，装配在 `config/config-cache.module.ts`）。
 *
 * 形态逐字照 `config/config.client.ts` 与 room 侧 `gateway/record.client.ts`
 * （`ClientProxy` + `lastValueFrom` + `timeout` + `RpcResult` 解包 + 传输故障 ⇒ `10007`）——
 * 本边只有这一个发送点，错误类、固定文案、env 与 options 都收在本文件里（room 侧因还有
 * game/robot/record/config 四条边才拆出 `gateway/`）。
 *
 * ⚠️ **失败一律抛**：调用方（`AuthService.register`）拿不到「已入账」的回执就必须让
 * **整个注册失败**（规格 §2.7/⚙️8）—— 返回假成功会造出「用户落了库但没拿到赠送」的
 * 静默缺口（顺序语义见 `auth.service.ts` 的 register 注释）。
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
 * 这类内部拓扑）—— 详情只进日志（`apply()` 抛之前的 warn 行），不透传 ≠ 不留痕。
 * 文案与 `config/config.client.ts` 的同名常量**逐字相同**（同服务两条边 + room/robot
 * 两侧失败时运维看到同一句话；逐字判据见 `currency-client.test.ts`）。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`CurrencyClient`）
 * **故意不同**（同 `config.client.ts` 与 room 侧 `rpc-clients.module.ts` 的坑：
 * 同一个 `name` 两处提供 ⇒ 解析到哪一个取决于注册顺序，脆且难查）。
 */
export const USER_CURRENCY_RPC_PROXY = 'USER_SERVICE_CURRENCY_RPC_PROXY';

/**
 * 规格 §2.13 env 表的 user-service 行：`CURRENCY_SERVICE_RPC_HOST` / `CURRENCY_SERVICE_RPC_PORT`
 * （默认 `currency-service` / `3104`）—— 命名照 `config.client.ts:55-61` 先例（§4.1 #23），
 * 本组 env 的**唯一代码读取点**。
 */
export const currencyClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CURRENCY_SERVICE_RPC_HOST ?? 'currency-service',
    port: Number(process.env.CURRENCY_SERVICE_RPC_PORT ?? 3104),
  },
});

/** 写（`apply`）的超时（规格 §2.7：**3s**；与 config 边同值、与 §4.3 表逐字一致）。 */
export const CURRENCY_CLIENT_TIMEOUT_MS = 3000;

/**
 * user-service → currency-service 的 RPC 客户端（`RPC_PATTERNS.currencyApply`）。
 *
 * ⚠️ `ClientProxy` 由 `CurrencyModule` 经 `ClientsModule.register()` 提供
 * （token `USER_CURRENCY_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
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
   *
   * ⚠️ **不重试**（§4.3 表：`currency.apply` 超时 3s、不重试）：重试由调用方的
   * 业务动作决定（注册重试 = 一次全新的注册），本传输层不叠加。幂等锚在 `actionId`
   * (`uk_action_id`)，同一 `actionId` 的**任何**重发都不会重复入账。
   */
  async apply(request: CurrencyApplyRequest): Promise<CurrencyApplyData> {
    try {
      const res = await lastValueFrom(
        this.proxy
          // R1104/R1105：本类是本条边的**唯一**发送点 ⇒ `meta` 只在这里加一次
          //（`...metaFromTrace()` 在 `send` 实参里 —— `meta-on-every-rpc-send` 闸扫这一处）。
          // 无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变。
          .send<CurrencyApplyResponse>(RPC_PATTERNS.currencyApply, {
            ...request,
            ...metaFromTrace(),
          })
          .pipe(timeout(CURRENCY_CLIENT_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `CurrencyServiceError.code`（§11.2）
        throw new CurrencyServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.currencyApply,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof CurrencyServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与 config/record 两条边**同码**；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency-service RPC ${RPC_PATTERNS.currencyApply} failed: ${reason}`);
      throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}
