// packages/user-service/src/risk/device-report.rpc.controller.ts
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  RPC_PATTERNS,
  type RiskDeviceReportRequest,
  type RiskDeviceReportResponse,
} from '@fight-the-landlord/protocol';
import { DevicesService } from './devices.service';

/**
 * 风控片 T4（规格 §2.1-4 / §2.8 行 / ⚙️21）：`risk.deviceReport` 的 **user-service
 * 接收侧** —— room 在**匹配入队成功后**一次 fire-and-forget 上报设备指纹（K3：原文入库、
 * 玩家面永不出站；只报匹配路径，好友房不报）。
 *
 * 🔴 **J21 的接收侧**：本类的 `@MessagePattern(RPC_PATTERNS.riskDeviceReport)` 是
 * `robot-availability-wiring.gate.test.ts` 全包扫描要找的那一条；承载类还必须被
 * `app.module.ts` 的 `controllers:` 注册——**加键与接收侧/注册必须同一提交**。
 * ⚠️ 常量形态（`RPC_PATTERNS.<键>`）是硬要求：字面量形态在 J21 的集合等值里会表现为
 * 「缺少接收侧」（闸的自证②钉着这条）。
 *
 * ─── 语义（逐条对应规格）────────────────────────────────────────────────
 *  - **校验**：两字段非空 string、`deviceId ≤ 64`（列宽）；失败 ⇒ `{ok:false, code:'BAD_PARAM'}`，
 *    零库操作（校验先于任何读——同 record.write 纪律）。
 *  - **幂等 upsert**：`DevicesService.report`（⚙️11 全文被单测钉）。
 *  - **不存在用户 ⇒ BAD_PARAM、不抛**（规格 §2.8 行逐字；服务层返回，见其类注）。
 *  - **库故障 ⇒ `{ok:false, code:'UPSTREAM_UNAVAILABLE'}` + error 日志**（R220：业务错误
 *    不抛、以信封返回——调用方按码分流/兜底，⚙️21 的 room 半边只留 warn 一行）。
 *  - ⚠️ **响应不是 `RpcResult` 信封**（规格 §2.1-4 逐字）：`{ok:true}|{ok:false, code}`
 *    没有 `data`/`message` 字段。
 *  - `dto.meta` 本任务不消费（同 record.rpc 先例：处理期日志的 trace 上下文接线不在
 *    本任务的改动面内）。
 */
@Controller()
export class DeviceReportRpcController {
  private readonly logger = new Logger(DeviceReportRpcController.name);

  /** ⚠️ **值导入** `DevicesService`（DI 陷阱纪律：`import type` 容器启动即崩）。 */
  constructor(private readonly devices: DevicesService) {}

  @MessagePattern(RPC_PATTERNS.riskDeviceReport)
  async report(@Payload() dto: RiskDeviceReportRequest): Promise<RiskDeviceReportResponse> {
    if (invalidPayloadReason(dto) !== null) {
      // 调用方（room）的组装 bug —— 不给单独文案字段（§2.1-4 的响应没有 message）。
      return { ok: false, code: 'BAD_PARAM' };
    }

    try {
      const res = await this.devices.report(dto.userId, dto.deviceId);
      if (res.ok) return { ok: true };
      return { ok: false, code: res.code ?? 'BAD_PARAM' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`risk.deviceReport 失败：userId=${dto.userId} reason=${message}`);
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE' };
    }
  }
}

/**
 * 载荷形状校验（规格 §2.8 行的两条件：两字段非空 string、`deviceId ≤ 64`）。
 * 返回 `null` = 通过；返回原因串（不落响应，只作可读性） = 拒收。
 *
 * ⚠️ 不做 charset / 最小长度（8）复检 —— 值域纪律由发送侧（room `room.match` 的
 * protocol 校验 C13）+ 客户端生成形态（⚙️16）承担；本采集是威慑级（设计登记）。
 */
function invalidPayloadReason(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return '载荷必须是对象';
  const r = req as Partial<RiskDeviceReportRequest>;
  if (typeof r.userId !== 'string' || r.userId.length === 0) return 'userId 必须是非空字符串';
  if (typeof r.deviceId !== 'string' || r.deviceId.length === 0) return 'deviceId 必须是非空字符串';
  if (r.deviceId.length > 64) return 'deviceId 必须 ≤ 64';
  return null;
}
