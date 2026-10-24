// packages/payment-service/src/config/config.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigPayChannelGetResponse,
  type ConfigSnapshotResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';

/**
 * payment-service → config-service 的调用封装（支付片 T2 骨架；克隆自 currency-service
 * 的同名文件 —— 本服务的**第一条出站 RPC 边**，经 `config.snapshot` 一次拉**全量**，
 * 缓存由 `ConfigCacheService` 承担；键级 getter 随各消费面（T5 的 26–34 键 / T6 渠道
 * 开关）逐个落地）。
 *
 * 支付配置管理化片 T8 起，本类还有**第二条出站边**：`config.payChannel.get`
 * （渠道凭据专用拉取通道，1000ms / 不重试，见 `payChannel()`）—— 该边**不进快照缓存**，
 * 每渠道调用现拉、失败回落由 `PayChannelConfigService` 承担（规格 §3.3/D3）。
 *
 * 形态照 user-service 的 `config/config.client.ts`（`ClientProxy` + 超时 + `RpcResult`
 * 解包 + 传输故障 ⇒ `10007`）——错误类、固定文案、token 与 options 都收在本文件里。
 *
 * 🔴 **一处有意偏差（登记）**：user/room/robot/currency 四侧用 rxjs 的
 * `lastValueFrom`+`timeout` 算子，那四个包把 `rxjs` 列为直接依赖；**本包不新增 npm 依赖**
 * （支付片全局约束）且 `rxjs` 不在本包依赖面内 —— 因此这里用 `subscribe` 把同一条
 * Observable 手工桥成 Promise（`setTimeout` 超时 = 同值 3s；语义逐条对齐：首个 next 即
 * 结果、error 即失败、超时 ⇒ 拒绝）。**行为不分叉**：三类失败（超时/连不上/下游错误信封）
 * 与四侧同码同文案。
 *
 * ⚠️ **失败一律抛**：调用方（`ConfigCacheService`）拿不到快照就要区分「键缺失/坏值」
 * （取代码默认值）与「从未拉到」（消费面据此 fail-closed 拒 —— 不确定不放松）—— 返回空
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
 * 文案与 user/room/robot/currency 四服务的同名常量**逐字相同**（五端失败时运维看到同一句话）。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`ConfigClient`）
 * **故意不同**（同 user/room/robot/currency 侧的坑：同一个 `name` 两处提供 ⇒ 解析到
 * 哪一个取决于注册顺序）。
 */
export const PAYMENT_CONFIG_RPC_PROXY = 'PAYMENT_SERVICE_CONFIG_RPC_PROXY';

/**
 * 规格 §9 同族：`CONFIG_SERVICE_RPC_HOST` / `CONFIG_SERVICE_RPC_PORT`
 * （默认 `config-service` / `3106`）—— 新 env 的**唯一代码读取点**（r1-S-I7）。
 */
export const configClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CONFIG_SERVICE_RPC_HOST ?? 'config-service',
    port: Number(process.env.CONFIG_SERVICE_RPC_PORT ?? 3106),
  },
});

/** 拉快照的超时（3s —— 与 user/room/robot/currency 四侧**同值**）。 */
const CONFIG_CLIENT_TIMEOUT_MS = 3000;

/**
 * 拉渠道凭据图（`config.payChannel.get`）的超时：**1000ms**（支付配置管理化片
 * ⚙️8/§3.3 逐字；导出供测试与消费方引用）。
 *
 * ⚠️ 与快照的 3s **故意不同**：这条边在**渠道调用热路径**上（每单现拉）——1000ms 是
 * 「配置面短暂抖动宁可回落上次成功值、不拖慢下单」的取舍（回落语义在
 * `PayChannelConfigService`）。
 */
export const PAY_CHANNEL_CLIENT_TIMEOUT_MS = 1000;

/**
 * payment-service → config-service 的 RPC 客户端（`RPC_PATTERNS.configSnapshot`）。
 *
 * ⚠️ `ClientProxy` 由 `ConfigModule` 经 `ClientsModule.register()` 提供
 * （token `PAYMENT_CONFIG_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
 */
@Injectable()
export class ConfigClient {
  private readonly logger = new Logger(ConfigClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 拉**全量配置快照**（`config.snapshot`，带 meta —— R1104/R1105）。
   *
   * ⚠️ **失败时抛**（不返回空快照/默认值）—— 失败分层由消费方决定（`ConfigCacheService`
   * 的键级缺省回落与 `hasSnapshot()`），传输层只负责如实报告。
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
      // 传输层故障（连不上 / 超时）⇒ 10007，与四侧那几条边**同码**；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`config-service RPC ${RPC_PATTERNS.configSnapshot} failed: ${reason}`);
      throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 拉**渠道凭据图**（`config.payChannel.get`，带 meta —— §2.5/⚙️8 逐字）。
   *
   * - **每渠道调用现拉**（等价旧「每次读 env」的时效——管理页保存后**下一次调用即生效**，
   *   无广播、无缓存，规格 D3）；
   * - 超时 **1000ms**（`PAY_CHANNEL_CLIENT_TIMEOUT_MS`）、**不重试**；
   * - ⚠️ **失败一律抛**（`snapshot()` 同款）：信封 `ok:false` 的 5 位码**原样**成为
   *   `ConfigServiceError.code`（10002 令牌错 / 10007 存储未启用一律照传——**调用方
   *   不按码分支**：`PayChannelConfigService` 对所有失败统一走回落）；传输故障 ⇒
   *   10007 + 固定文案（原因只进日志，不透传内部拓扑）。
   *
   * 回落（上次成功值）是**调用方**的职责——传输层只如实报告（D3：回落语义登记在
   * `PayChannelConfigService`）。
   */
  async payChannel(pullToken: string): Promise<ConfigPayChannelGetResponse> {
    try {
      const res = await this.sendPayChannelOnce(pullToken);
      if (!res?.ok) {
        // R220 同款：下游的 5 位数字码**原样**成为 `ConfigServiceError.code`
        throw new ConfigServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.configPayChannelGet,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof ConfigServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，同 `snapshot()`；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`config-service RPC ${RPC_PATTERNS.configPayChannelGet} failed: ${reason}`);
      throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 一次 `config.snapshot`（不重试）：Observable → Promise 的**手工桥**（见文件头「有意偏差」——
   * 本包不新增 rxjs 依赖；语义与四侧的 `lastValueFrom(...pipe(timeout(3000)))` 逐条对齐）：
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

  /**
   * 一次 `config.payChannel.get`（不重试）：与 `sendSnapshotOnce()` **同款手工桥**
   * （见文件头「有意偏差」；语义逐条对齐），差异仅两处：
   *  - 超时值 = `PAY_CHANNEL_CLIENT_TIMEOUT_MS`（1000ms，⛔ 不是快照的 3s）；
   *  - 载荷 = `{pullToken, ...metaFromTrace()}`（D3/评审 Y3b：每调用 `.send` 必带 meta——
   *    payment 在 meta 机械闸扫描面内）。
   * timer 同样**先武装、后 `subscribe`**（同步发射也不残留定时器）。
   */
  private sendPayChannelOnce(pullToken: string): Promise<RpcResult<ConfigPayChannelGetResponse>> {
    return new Promise((resolve, reject) => {
      let subscription: { unsubscribe(): void } | undefined;
      const timer = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`config.payChannel.get 超时（${PAY_CHANNEL_CLIENT_TIMEOUT_MS}ms 无回执）`));
      }, PAY_CHANNEL_CLIENT_TIMEOUT_MS);

      subscription = this.proxy
        .send<RpcResult<ConfigPayChannelGetResponse>>(RPC_PATTERNS.configPayChannelGet, {
          pullToken,
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
