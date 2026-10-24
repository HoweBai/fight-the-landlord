// packages/currency-service/src/config/config.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigSnapshotResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';

/**
 * currency-service → config-service 的调用封装（② 金币场 T8 / 规格 §9：本服务的
 * **首条出站 RPC 边**（广告片起另有**第二条**出站边 `config.adChannel.get` —— 见
 * `src/ads/ad-channel.config.service.ts`，与快照边各自一条 TCP：3s / 1000ms）——
 * 此前 currency-service 只做他人 RPC 的接收侧；经
 * `config.snapshot` 一次拉**全量**，消费面：`currency.reliefEnabled` /
 * `currency.reliefAmount` / `currency.reliefThresholdCoins`（前三键有代码默认值/可空语义）
 * 与 `game.doudizhu.cardCounter*`（记牌器价格；旧键回退）。
 *
 * 形态照 user-service 的 `config/config.client.ts`（`ClientProxy` + 超时 + `RpcResult`
 * 解包 + 传输故障 ⇒ `10007`）——错误类、固定文案、token 与 options 都收在本文件里。
 *
 * 🔴 **一处有意偏差（登记）**：user/room/robot 三侧用 rxjs 的 `lastValueFrom`+`timeout`
 * 算子，那三个包把 `rxjs` 列为直接依赖；**本包不新增 npm 依赖**（② 全局约束）且
 * `rxjs` 不在本包依赖面内 —— 因此这里用 `subscribe` 把同一条 Observable 手工桥成
 * Promise（`setTimeout` 超时 = 同值 3s；语义逐条对齐：首个 next 即结果、error 即失败、
 * 超时 ⇒ 拒绝）。**行为不分叉**：三类失败（超时/连不上/下游错误信封）与三侧同码同文案。
 *
 * ⚠️ **失败一律抛**：调用方（`ConfigCacheService`）拿不到快照就要区分「键缺失/坏值」
 * （取代码默认值）与「从未拉到」（relief 端点 ⇒ 503/10007 不默认放行，§9）—— 返回空
 * 快照会把「读不到」伪装成「没有配置」。
 */
export class ConfigServiceError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigServiceError';
  }
}

/**
 * 传输层故障（连不上 / 超时）时给**调用方**的固定文案。
 *
 * 🔴 消息**不得**内插 `err.message`（传输故障下它是 `ECONNREFUSED 172.28.x.x:3106`
 * 这类内部拓扑）—— 详情只进日志（`snapshot()` 抛之前的 warn 行），不透传 ≠ 不留痕。
 * 文案与 user/room/robot 三服务的同名常量**逐字相同**（四端失败时运维看到同一句话）。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`ConfigClient`）
 * **故意不同**（同 user/room/robot 侧的坑：同一个 `name` 两处提供 ⇒ 解析到哪一个
 * 取决于注册顺序）。
 */
export const CURRENCY_CONFIG_RPC_PROXY = 'CURRENCY_SERVICE_CONFIG_RPC_PROXY';

/**
 * 规格 §9：`CONFIG_SERVICE_RPC_HOST` / `CONFIG_SERVICE_RPC_PORT`
 * （默认 `config-service` / `3106`）—— 新 env 的**唯一代码读取点**（r1-S-I7）。
 */
export const configClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CONFIG_SERVICE_RPC_HOST ?? 'config-service',
    port: Number(process.env.CONFIG_SERVICE_RPC_PORT ?? 3106),
  },
});

/** 拉快照的超时（规格 §2.3 的低频读；与 user/room/robot 侧**同值**）。 */
const CONFIG_CLIENT_TIMEOUT_MS = 3000;

/**
 * currency-service → config-service 的 RPC 客户端（`RPC_PATTERNS.configSnapshot`）。
 *
 * ⚠️ `ClientProxy` 由 `ConfigModule` 经 `ClientsModule.register()` 提供
 * （token `CURRENCY_CONFIG_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
 */
@Injectable()
export class ConfigClient {
  private readonly logger = new Logger(ConfigClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 拉**全量配置快照**（`config.snapshot`，带 meta —— R1104/R1105）。
   *
   * ⚠️ **失败时抛**（不返回空快照/默认值）—— 失败分层由消费方决定（`ConfigCacheService`
   * 的三键缺省回落与 `hasSnapshot()`），传输层只负责如实报告。
   * ⚠️ **不重试**：启动期的「1s 退避直到首次成功」在消费方（`ConfigCacheService.pullWithRetry`）。
   */
  async snapshot(): Promise<ConfigSnapshotResponse> {
    try {
      const res = await this.sendSnapshotOnce();
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `ConfigServiceError.code`（§11.2）
        throw new ConfigServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.configSnapshot,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof ConfigServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与 user/room/robot 那三条边**同码**；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`config-service RPC ${RPC_PATTERNS.configSnapshot} failed: ${reason}`);
      throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 一次 `config.snapshot`（不重试）：Observable → Promise 的**手工桥**（见文件头「有意偏差」——
   * 本包不新增 rxjs 依赖；语义与三侧的 `lastValueFrom(...pipe(timeout(3000)))` 逐条对齐）：
   *  - 首个 `next` ⇒ 结果（ClientProxy 单发；与 `lastValueFrom` 等价）；
   *  - `error` ⇒ 原样拒绝（由 `snapshot()` 统一翻码）；
   *  - 超过 `CONFIG_CLIENT_TIMEOUT_MS` 无回执 ⇒ 退订并拒绝（`snapshot()` 翻 10007）。
   *
   * ⚠️ timer **先武装、后 `subscribe`**：反过来（subscribe 返回后再 `setTimeout`）在
   * **同步发射**时 `next` 已错过 `clearTimeout` 的窗口 ⇒ 已 resolve 的调用会残留一个
   * 3s 定时器（空跑一次 `unsubscribe`+`reject`）。语义不变，只是把这条理论瑕疵去掉。
   */
  private sendSnapshotOnce(): Promise<RpcResult<ConfigSnapshotResponse>> {
    return new Promise((resolve, reject) => {
      let subscription: { unsubscribe(): void } | undefined;
      const timer = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`config.snapshot 超时（${CONFIG_CLIENT_TIMEOUT_MS}ms 无回执）`));
      }, CONFIG_CLIENT_TIMEOUT_MS);

      subscription = this.proxy
        .send<RpcResult<ConfigSnapshotResponse>>(RPC_PATTERNS.configSnapshot, {
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
