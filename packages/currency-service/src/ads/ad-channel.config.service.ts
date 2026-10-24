/**
 * 广告片 T14：**广告回调密钥图的消费侧**（第四键空间专用拉取通道 `config.adChannel.get`；
 * 规格 §2.3「消费侧：每次回调**现拉** + lastGood 缓存；拉取失败用 lastGood；**无 lastGood
 * ⇒ 回调按瞬态 5xx**（保持可重投；键未配置期=平台尚未开通，此形态正确）」）。
 *
 * ─── 形态出处与一处刻意的差异面 ────────────────────────────────────────────
 *  `get()` 的语义面**逐字照** `pay-channel.config.service.ts:43-54`（现拉 ⇒ 整图替换
 *  lastGood ⇒ 失败回落；失败**不按码分支**——10002 令牌错 / 10007 存储未启用 / 传输故障
 *  同等对待），仅一处**规格点名的差异**：pay 回落面「从未成功 ⇒ null（=未配置语义）」，
 *  本侧「从未成功 ⇒ **抛瞬态**」（`AdChannelUnavailableError`）——回调链据此 5xx 等重投，
 *  **不得**把「拿不到密钥」伪装成「没有配置」（那会把密钥缺失变成永久性静默失败）。
 *
 *  ⚠️ **传输形态（T14 实现期裁定，报告登记）**：currency-service 既有的 `ConfigClient`
 *  （`config/config.client.ts`）只有 `snapshot()` 一条方法、且 `ConfigModule` 只导出
 *  `ConfigCacheService`——本任务提交面不含这两个文件（简报显式限定）。因此本服务
 *  **自带传输桥**：经 AppModule 注册的 `ClientsModule` 代理（`AD_CHANNEL_RPC_PROXY`，
 * 与快照边**各自一条 TCP 边**——两条边 timeout 语义不同：快照 3s / 本边 1000ms，照 pay
 *  的 `PAY_CHANNEL_CLIENT_TIMEOUT_MS` 先例）直发 `config.adChannel.get`。桥形态逐字照
 *  `payment-service/config/config.client.ts:205-229` 的手工订阅桥（timer 先武装、后 subscribe；
 *  首个 next 即结果、error 即失败、超时 ⇒ 退订并拒绝；载荷 `{pullToken, ...metaFromTrace()}`）。
 *
 * ─── 失败纪律（照 pay 同款 + 本侧差异）───────────────────────────────────
 *  - 失败**不按码分支**：信封 `ok:false`（任意 5 位码）与传输故障统一走回落；
 *  - 原因进日志（不透传 ≠ 不留痕），**回落 WARN 文案不含任何值**；
 *  - 抛出的 `AdChannelUnavailableError` 消息为**固定文案**（不内插内部拓扑/令牌）；
 *  - 空串拉取令牌（env 未设，`||` 语义）= 正常一发（config-service 侧拒 10002）⇒ 失败路径。
 *
 * ─── T0-2 边界 ────────────────────────────────────────────────────────────
 *  本服务是 **T0-2「密钥来源接线」的承载件**（T13 报告 §5.2 #3）：届时
 *  `DefaultRewardedCallbackVerifier` 的验签核心经本服务取 `ad.callbackSecret`
 *  （ctor 扩展或传参——T0-2 回填面），拉取不可用 ⇒ 抛瞬态 ⇒ 回调 5xx 等重投。
 *  本任务只落服务与注册（真容器可解析），**不在回调链内消费**（验签核心未定稿）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import {
  RPC_PATTERNS,
  type AdChannelKey,
  type ConfigAdChannelGetResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';

/**
 * AppModule 的 `ClientsModule.register` 用的**内部 token** —— 与快照边的
 * `CURRENCY_CONFIG_RPC_PROXY` **故意不同**（同名两处提供 ⇒ 解析到哪一个取决于注册顺序，
 * 本仓既有坑）。
 */
export const AD_CHANNEL_RPC_PROXY = 'CURRENCY_ADS_AD_CHANNEL_RPC_PROXY';

/** 拉取超时（照 pay `PAY_CHANNEL_CLIENT_TIMEOUT_MS` 同值：1000ms / 不重试——回调热路径宁快勿拖）。 */
export const AD_CHANNEL_CLIENT_TIMEOUT_MS = 1000;

/**
 * 拉取不可用（**瞬态类**）：无 lastGood 可回落时的唯一出口 —— 回调链映射 5xx（平台重投
 * 可恢复），**不得**映射 4xx 确定性拒绝、**不得**回落 null/空图。
 */
export class AdChannelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdChannelUnavailableError';
  }
}

@Injectable()
export class AdChannelConfigService {
  private readonly logger = new Logger(AdChannelConfigService.name);

  /**
   * 上次**成功**拉取的整图（`null` = 从未成功——回落面的「拿不到」定义）。
   * ⚠️ 空对象 `{}` 是**有效图**（= 全未配置）：照常替换旧图，**不得**当 null/未设置处理
   * （照 pay `lastGood` 注）。
   */
  private lastGood: Partial<Record<AdChannelKey, string>> | null = null;

  /**
   * `@Inject(AD_CHANNEL_RPC_PROXY)`（字符串 token——**不是**类 token，无值导入面；
   * `ClientProxy` 只作参数类型 ⇒ `import type` 安全）。
   */
  constructor(@Inject(AD_CHANNEL_RPC_PROXY) private readonly proxy: ClientProxy) {}

  /**
   * 现拉广告回调密钥图；失败回落上次成功值（**从未成功 ⇒ 抛瞬态**，见文件头差异面）。
   *
   * ⚠️ 成功 = **整图替换**（`lastGood = values`）：`values` 就是全图（仅含已配置键，
   * §2.3），**不是**与旧图的 merge —— 管理页清空某键后，下一次成功拉取里它就不在了，
   * 必须跟着消失（`{}` 同样照常替换）。
   */
  async get(): Promise<Partial<Record<AdChannelKey, string>>> {
    try {
      const values = await this.pullOnce(process.env.AD_CHANNEL_PULL_TOKEN || '');
      this.lastGood = values; // 整图替换（含 {}——全未配置也是有效图）
      return values;
    } catch (err) {
      // 🔴 失败**不按码分支**（10002 令牌错 / 10007 存储未启用 / 传输故障同等对待）。
      const reason = err instanceof Error ? err.message : String(err);
      if (this.lastGood === null) {
        // 从无成功值 ⇒ 瞬态出口（固定文案——不内插 reason：可能含内部拓扑）。
        this.logger.warn(`config.adChannel.get 拉取失败且无历史成功值（按瞬态处置）：${reason}`);
        throw new AdChannelUnavailableError(
          '广告回调密钥拉取失败且从未成功拉到（无回落值）——按瞬态处置（回调 5xx 等重投）',
        );
      }
      // WARN 文案逐字（照 pay §2.9 同款）：不含任何值；详情已在上行日志留痕。
      this.logger.warn('广告回调密钥拉取失败，使用上次成功值（trace 见 meta）');
      return this.lastGood;
    }
  }

  /**
   * 一次 `config.adChannel.get`（不重试）：照 `payment-service/config/config.client.ts:205-229`
   * 的**手工订阅桥**（本包不新增 rxjs 依赖）：首个 `next` ⇒ 解 `RpcResult` 信封
   * （`ok:false` 任意码 ⇒ 拒绝）；`error` ⇒ 原样拒绝；超过 `AD_CHANNEL_CLIENT_TIMEOUT_MS`
   * 无回执 ⇒ **退订**并拒绝。timer **先武装、后 subscribe**（同步发射也不残留定时器）。
   */
  private pullOnce(pullToken: string): Promise<Partial<Record<AdChannelKey, string>>> {
    return new Promise((resolve, reject) => {
      let subscription: { unsubscribe(): void } | undefined;
      const timer = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`config.adChannel.get 超时（${AD_CHANNEL_CLIENT_TIMEOUT_MS}ms 无回执）`));
      }, AD_CHANNEL_CLIENT_TIMEOUT_MS);

      subscription = this.proxy
        .send<RpcResult<ConfigAdChannelGetResponse>>(RPC_PATTERNS.configAdChannelGet, {
          pullToken,
          ...metaFromTrace(),
        })
        .subscribe({
          next: (res) => {
            clearTimeout(timer);
            if (!res?.ok) {
              // R220 同款：下游的 5 位数字码**原样**进拒绝原因（只进日志，不内插错误消息）。
              reject(
                new Error(
                  `config.adChannel.get 业务拒绝（code=${String(res?.code ?? '?')}）：${String(res?.message ?? '')}`,
                ),
              );
              return;
            }
            resolve(res.data.values);
          },
          error: (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        });
    });
  }
}
