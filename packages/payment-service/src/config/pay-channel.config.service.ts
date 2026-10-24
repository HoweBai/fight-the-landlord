// packages/payment-service/src/config/pay-channel.config.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { PayChannelKey } from '@fight-the-landlord/protocol';
import { ConfigClient } from './config.client';

/**
 * 渠道凭据读取面（支付配置管理化片 T8；规格 §3.3 / ⚙️8/⚙️9、设计 D3）。
 *
 * ─── 两条刻意钉死的语义 ───────────────────────────────────────────────────
 *  ① **每调用现拉**（`config.payChannel.get`，1000ms/不重试）：等价旧「每次读 env」的
 *     **时效** —— 管理页保存 ⇒ 下一次渠道调用即生效（无广播、无快照缓存；渠道六键
 *     不进 `config.snapshot`，规格 §2.1）。
 *  ② **回落 = 上次成功值**（整图）：🔴 **刻意新增的可用性行为**（设计 D3 登记）——
 *     config-service 短暂不可达时，渠道调用用**上一次成功拉到的整图**照常工作，
 *     而不是当场变成「未配置」；从未成功过 ⇒ `null`（= 未配置语义，照 §3.3 映射表，
 *     消费侧 `creds?.['pay.channel.x'] || ''` 与「env 空串」逐字等价）。
 *
 * ─── 失败纪律 ────────────────────────────────────────────────────────────
 *  - **不按码分支**（§3.3）：`ok:false` 的 10002/10007 与传输故障同等对待，统一
 *    `catch` 一切走回落 —— 对消费面而言它们都只是「这次拉不到」；
 *  - 每次失败恰一条 WARN（⚙️9），**文案逐字且不含值**（§2.9）。
 */
@Injectable()
export class PayChannelConfigService {
  private readonly logger = new Logger(PayChannelConfigService.name);

  /**
   * 上次**成功**拉取的整图（`null` = 从未成功——回落面的「拿不到」定义）。
   * ⚠️ 空对象 `{}` 是**有效图**（= 全未配置）：它照常替换旧图，**不得**当 null/未设置处理。
   */
  private lastGood: Partial<Record<PayChannelKey, string>> | null = null;

  /** ⚠️ **值导入** `ConfigClient`（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器启动即崩。 */
  constructor(private readonly client: ConfigClient) {}

  /**
   * 现拉渠道凭据图；失败回落上次成功值（从未成功 ⇒ `null`）。
   *
   * ⚠️ 成功 = **整图替换**（`lastGood = res.values`）：`values` 就是全图（仅含已配置键，
   * §2.5），**不是**与旧图的 merge —— 管理页清空某键后，下一次成功拉取里它就不在了，
   * 必须跟着消失（`{}` 同样照常替换，见 `lastGood` 注）。
   */
  async get(): Promise<Partial<Record<PayChannelKey, string>> | null> {
    try {
      const res = await this.client.payChannel(process.env.PAY_CHANNEL_PULL_TOKEN || '');
      this.lastGood = res.values; // 整图替换（含 {}——全未配置也是有效图）
      return res.values;
    } catch {
      // 🔴 失败**不按码分支**（10002 令牌错 / 10007 存储未启用 / 传输故障同等对待）。
      // WARN 文案逐字（§2.9）：不含任何值；详情已在 ConfigClient 失败路径留痕。
      this.logger.warn('渠道配置拉取失败，使用上次成功值（trace 见 meta）');
      return this.lastGood;
    }
  }
}
