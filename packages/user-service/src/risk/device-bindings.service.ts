// packages/user-service/src/risk/device-bindings.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { REDIS } from '../auth/token.service';
import { DomainError } from '../http/errors';

/**
 * `risk:binding:{userId}` 键（唯一拼法；登录闸写透 / 解绑 DEL / 网关 WS 握手跨服务读 ——
 * 网关侧各自持有文本，服务间不互相 import 是本仓结构性事实，先例 = `riskBannedKey`）。
 * **无 TTL**：绑定生命周期 = 表行生命周期（解绑/换绑只走管理面 DELETE）。
 */
export function riskBindingKey(userId: string): string {
  return `risk:binding:${userId}`;
}

/** 绑定行读（登录热路径每请求一次；`user_id` 是 PK，点查）。 */
export const DEVICE_BINDING_SELECT_SQL =
  'SELECT device_id, bound_at FROM user_device_bindings WHERE user_id = ?';

/** 首绑写（**INSERT IGNORE + PK(user_id)**：两台设备并发首绑时只有第一台落行——竞态由 PK 裁决）。 */
export const DEVICE_BINDING_INSERT_IGNORE_SQL =
  'INSERT IGNORE INTO user_device_bindings (user_id, device_id) VALUES (?, ?)';

/** 管理面解绑（管理详情先验存在；删行 = 绑定真相消失，下一台登录设备静默重绑）。 */
export const DEVICE_BINDING_DELETE_SQL = 'DELETE FROM user_device_bindings WHERE user_id = ?';

/** 解绑事务内的锁定读（串行化并发解绑；FOR UPDATE 与审核队列状态迁移同族）。 */
export const DEVICE_BINDING_LOCK_SELECT_SQL =
  'SELECT device_id FROM user_device_bindings WHERE user_id = ? FOR UPDATE';

/** 解绑审计（`risk_actions` 动作全集第八值 `device_unbind`；review_id 恒 NULL——非队列动作）。 */
export const DEVICE_UNBIND_AUDIT_INSERT_SQL =
  "INSERT INTO risk_actions (user_id, action, actor, reason, review_id, detail) VALUES (?, 'device_unbind', ?, NULL, NULL, ?)";

/** 11005 文案（与 protocol §11.2 码义逐字；客户端 net/errors 同族文案）。 */
const DEVICE_MISMATCH_MESSAGE = '账号已绑定其他设备';

/** 绑定行的读出形状（`bound_at` 为驱动原始时间形态，管理面自行映射 epoch ms）。 */
export interface DeviceBindingRow {
  deviceId: string;
  boundAt: unknown;
}

/**
 * 单账号设备绑定的**唯一写入口 + 登录闸读面**（设备绑定安全功能）。
 *
 * 语义（总开关在调用侧 `ConfigCacheService.deviceBindingEnabled()`，本服务不读配置——
 * 关时 `auth.service` 根本不调进来，开关关闭零开销/零行为变化）：
 *  - `deviceId` 缺省（旧端 / 隐私模式拿不到指纹）⇒ **放行且不绑**（fail-open：绝不锁死玩家）；
 *  - 绑定行不存在 ⇒ **静默首绑**（INSERT IGNORE 只认第一台），并写透 Redis；
 *  - 绑定行一致 ⇒ 放行；
 *  - 绑定行存在且不一致 ⇒ **`DomainError(11005)`**。
 *
 * MySQL 是真相；Redis `risk:binding:{userId}` 是网关 WS 握手的读缓存。SET 失败只 warn：
 * REST 登录闸本身以本表为准（攻击者在登录处就被挡），Redis 暂时缺键只影响 WS 第二闸，
 * 下次同台设备登录不再补 SET（热路径零额外写）——残余窗口与封禁旗同族可接受。
 */
@Injectable()
export class DeviceBindingsService {
  private readonly logger = new Logger(DeviceBindingsService.name);

  constructor(
    /** ⚠️ **值导入** + 显式 `@Inject`（DI 陷阱纪律；同 `DevicesService`）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 登录/注册/refresh 的设备闸（见类注释三态）。
   * `deviceId` 已在 DTO 层过 `@Length(8,64)` + 字符域，这里不重复校验。
   */
  async checkOrBind(userId: string, deviceId: string | undefined): Promise<void> {
    if (!deviceId) return; // 无指纹 ⇒ 放行不绑。

    const rows = (await this.dataSource.query(DEVICE_BINDING_SELECT_SQL, [userId])) as Array<{
      device_id: unknown;
    }>;
    const bound = rows[0] ? String(rows[0].device_id) : null;
    if (bound !== null) {
      if (bound !== deviceId) throw new DomainError(ErrCode.DEVICE_MISMATCH, DEVICE_MISMATCH_MESSAGE);
      return; // 已绑本设备 ⇒ 放行（热路径：一次点查，无写、无 Redis 访问）。
    }

    // 无绑定行 ⇒ 静默首绑。INSERT IGNORE 后**重读裁决**：并发首绑落败者必须按不一致拒绝，
    // 不能因为自己这条 INSERT 被忽略就当成功（SELECT-then-INSERT 的 check-then-act 窗口）。
    await this.dataSource.query(DEVICE_BINDING_INSERT_IGNORE_SQL, [userId, deviceId]);
    const after = (await this.dataSource.query(DEVICE_BINDING_SELECT_SQL, [userId])) as Array<{
      device_id: unknown;
    }>;
    const winner = after[0] ? String(after[0].device_id) : null;
    if (winner !== deviceId) {
      throw new DomainError(ErrCode.DEVICE_MISMATCH, DEVICE_MISMATCH_MESSAGE);
    }
    await this.writeThrough(userId, deviceId);
  }

  /** 管理面读：当前绑定行（无 ⇒ null）。 */
  async getBinding(userId: string): Promise<DeviceBindingRow | null> {
    const rows = (await this.dataSource.query(DEVICE_BINDING_SELECT_SQL, [userId])) as Array<{
      device_id: unknown;
      bound_at: unknown;
    }>;
    if (rows.length === 0) return null;
    return { deviceId: String(rows[0]!.device_id), boundAt: rows[0]!.bound_at };
  }

  /**
   * 管理面人工解绑：事务内「锁定读验存在 → 删行 → 审计一行」，COMMIT 后 DEL Redis 键
   * （形态照 `ReviewsService.applyAdminAction` 的 F2：旗/缓存在事务提交后再动）。
   *
   * 404：无绑定行（用户不存在同形）⇒ `DomainError(11004)`（控制器翻 404；管理面借既有码）。
   * 成功后**不踢旧 socket**（残余窗口已登记：旧连接活到下次 WS 重连握手）。
   */
  async unbind(userId: string, actor: string): Promise<{ previousDeviceId: string }> {
    const previousDeviceId = await this.dataSource.transaction(async (manager) => {
      const lockRows = (await manager.query(DEVICE_BINDING_LOCK_SELECT_SQL, [userId])) as Array<{
        device_id: unknown;
      }>;
      if (lockRows.length === 0) {
        throw new DomainError(ErrCode.USER_NOT_FOUND, '该用户未绑定设备');
      }
      const previous = String(lockRows[0]!.device_id);
      await manager.query(DEVICE_BINDING_DELETE_SQL, [userId]);
      await manager.query(DEVICE_UNBIND_AUDIT_INSERT_SQL, [
        userId,
        actor,
        JSON.stringify({ previousDeviceId: previous }),
      ]);
      return previous;
    });

    // COMMIT 之后再删缓存（DEL 失败只 warn：登录闸以 MySQL 为准，缓存至多残留至下次解绑/写透）。
    try {
      await this.redis.del(riskBindingKey(userId));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`binding cache DEL failed for userId=${userId} after unbind: ${reason}`);
    }
    return { previousDeviceId };
  }

  /** 首绑写透 Redis（无 TTL；失败只 warn，见类注释）。 */
  private async writeThrough(userId: string, deviceId: string): Promise<void> {
    try {
      await this.redis.set(riskBindingKey(userId), deviceId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`binding cache SET failed for userId=${userId} (login gate still enforces): ${reason}`);
    }
  }
}
