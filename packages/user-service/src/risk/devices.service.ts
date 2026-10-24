// packages/user-service/src/risk/devices.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * 设备上报的**幂等 upsert**（风控片 T4 / 规格 ⚙️11 **逐字**；`uk(user_id, device_id)`
 * 是幂等硬闸）。
 *
 * ⚠️ **全文被单测钉**（`test/risk-devices.test.ts` 的 `toBe` 全等断言，且那份文本是
 * 测试侧按 ⚙️11 独立誊写的）——改一个字符都会红。语义两半：
 *  - **幂等**：`ON DUPLICATE KEY UPDATE` ⇒ 重复报告不产生第二行；
 *  - **1h 节流**（写放大压制的核心）：`last_seen_at` 只在**距上次更新严格超过 1 小时**
 *    时才刷（`IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, …)`）——恰满 1h **不刷**。
 *  - `first_seen_at` 只在 INSERT 时写（NOW(3)），此后不动 = 首见时间。
 */
export const DEVICE_UPSERT_SQL =
  'INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) VALUES (?,?,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE last_seen_at = IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, NOW(3), last_seen_at)';

/**
 * 上报者的存在性读（**先于** upsert）。
 *
 * 为什么必须有这一步：`user_devices` 无外键约束 ⇒ 直接 upsert 会让「已注销 / 不存在
 * 用户」的设备行静默落库，而 T5 的扫描 SQL2 走 `JOIN users`——这些幽灵行永远进不了
 * 检测面、只白占保留期。规格 §2.8 的行语义 =「`user_id` 不存在 ⇒ `{ok:false,
 * code:'BAD_PARAM'}`（不抛）」：**先查后写**是它的实现形。
 */
const USER_EXISTS_SQL = 'SELECT `id` FROM `users` WHERE `id` = ?';

/** `report()` 的机械回执（形状 = 规格 §2.8 行的 `{ok:false, code:…}` 半边）。 */
export interface DeviceReportResult {
  ok: boolean;
  /** 失败码（`BAD_PARAM` = 用户不存在；库故障的 `UPSTREAM_UNAVAILABLE` 由控制器兜）。 */
  code?: string;
}

/**
 * 设备链的**唯一写入口**（`risk.deviceReport` 接收侧的服务层）。
 *
 * 失败语义（规格 §2.8）：`user_id` 不存在 ⇒ `{ok:false, code:'BAD_PARAM'}`，**不抛**
 * （业务性失败不是异常——调用方 room 侧是 fire-and-forget，⚙️21）。库/未知故障**照抛**，
 * 由控制器统一翻成 `{ok:false, code:'UPSTREAM_UNAVAILABLE'}` + error 日志（R220 信封纪律）。
 */
@Injectable()
export class DevicesService {
  /**
   * ⚠️ **值导入** + 显式 `@Inject`（DI 陷阱纪律；`import type` 容器启动即崩，单测看不见）。
   */
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 幂等落库一条设备报告。`dataSource.query` 自动取连接池（无事务——单语句 upsert 本身
   * 原子；存在性读与 upsert 之间的竞态窗口只可能落在「查得到、写时恰好注销」——
   * 与 record.write 的「唯一键是硬闸、语义层兜小窗」同族，无行的白写一行也可由保留期清理收敛）。
   */
  async report(userId: string, deviceId: string): Promise<DeviceReportResult> {
    const rows = (await this.dataSource.query(USER_EXISTS_SQL, [userId])) as Array<{ id: string }>;
    if (rows.length === 0) {
      // 规格 §2.8：不存在 ⇒ BAD_PARAM（不抛）。
      return { ok: false, code: 'BAD_PARAM' };
    }
    await this.dataSource.query(DEVICE_UPSERT_SQL, [userId, deviceId]);
    return { ok: true };
  }
}
