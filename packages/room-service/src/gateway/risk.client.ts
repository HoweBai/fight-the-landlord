// packages/room-service/src/gateway/risk.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { RPC_PATTERNS, type RiskDeviceReportResponse } from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * 风控片 T3（规格 §2.1-4 / §2.8 发送侧 / ⚙️21）：`risk.deviceReport` 的跨服务超时
 * = **3s**（与 `record.write` 同一预算 —— 同一条 user-service 边、同一个超时口径）。
 */
export const RISK_DEVICE_REPORT_TIMEOUT_MS = 3000;

/**
 * room-service → user-service 的 deviceReport 上报（`RPC_PATTERNS.riskDeviceReport`）。
 *
 * 形态照 `record.client.ts`（`ClientProxy` + `lastValueFrom` + `timeout`），但语义面不同：
 *  - **fire-and-forget**（⚙️21）：`report()` 返回 `void` —— **不重试、不抛**，
 *    任何失败（传输故障 / 超时 / 信封 `{ok:false, code}`）只留 **warn 日志一行**；
 *  - 调用点是**唯一**的：`handleMatch` 在 `addToQueue` **成功后**一次
 *    （`deviceId` 缺省不调 —— 旧客户端没有这个值）；
 *  - `meta` 只在 `send` 实参里加一次（`...metaFromTrace()` —— `meta-on-every-rpc-send`
 *    闸扫这一处；无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变）。
 *
 * ⚠️ **为什么吞掉而不是抛**：上报发生在 `room.match` 的 ack 路径上 —— 抛出去会把
 * 一个已成功的入队变成 13001（玩家以为没排上队），而 deviceReport 是**威慑级采集**
 * （设计 §7），失败即丢是产品口径（台账登记）。
 */
@Injectable()
export class RiskClient {
  private readonly logger = new Logger(RiskClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 上报一次「某用户在某设备上」的匹配路径采集（幂等 upsert 在接收侧）。
   *
   * 绝不抛（含**同步**抛：`send()` 的构造面也兜在 try 里）—— 见类头注。
   */
  report(userId: string, deviceId: string): void {
    try {
      void lastValueFrom(
        this.proxy
          .send<RiskDeviceReportResponse>(RPC_PATTERNS.riskDeviceReport, {
            userId,
            deviceId,
            ...metaFromTrace(),
          })
          .pipe(timeout(RISK_DEVICE_REPORT_TIMEOUT_MS)),
      )
        .then((res) => {
          // 信封级失败（如接收侧 `{ok:false, code:'BAD_PARAM'}`）不是异常路径，
          // 但**不许静默**（本仓纪律：吞掉 = 灾难，不透传 ≠ 不留痕）——
          // ⚙️21 的「warn 日志一行」覆盖这一支。
          if (!res?.ok) {
            this.logger.warn(
              `risk.deviceReport rejected for ${userId}: ${res?.code ?? 'unknown'}`,
            );
          }
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(`risk.deviceReport failed for ${userId}: ${reason}`);
        });
    } catch (err) {
      // `send()` 同步抛（替身/编程错误）⇒ 同样吞成一行 warn（「不抛」是硬契约）。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`risk.deviceReport failed for ${userId}: ${reason}`);
    }
  }
}
