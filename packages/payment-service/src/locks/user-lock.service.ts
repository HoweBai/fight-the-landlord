// packages/payment-service/src/locks/user-lock.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
// ⚠️ **值导入** `DataSource`（DI token）；`EntityManager` 只作类型（fn 的参数）⇒ 类型导入安全。
import { DataSource, type EntityManager } from 'typeorm';

/**
 * 支付片 T9：**资金动作行锁**（规格 §3.6 锁纪律 · 设计 §2.4「资金动作串行化」）。
 *
 * ─── 机制（§3.6 逐字）────────────────────────────────────────────────────────
 *  独立事务内：`INSERT IGNORE payment_user_locks(user_id)`（物化锁行：一人一行）⇒
 *  `SELECT … FOR UPDATE`（行锁）⇒ 执行 `fn`（**拿到事务内 manager**——资金写必须与锁同事务）
 *  ⇒ 提交。跨消费面（提现/退款）的「校验 cap → 冻结落账」都在同一条行锁内完成
 *  （关掉「两消费面同刻争用毫秒窗」；设计 §5.2 锁内三段）。
 *
 * ─── 释放与留存 ──────────────────────────────────────────────────────────────
 *  锁的释放 = **事务边界**（提交或回滚都释放）——`fn` 抛错 ⇒ `dataSource.transaction`
 *  整体回滚（异常必释放），调用方接原错误；`payment_user_locks` 的**行**则永久留存
 *  （这是「物化锁」的用意：锁载体不随事务消失，第二次申请经 INSERT IGNORE 直接复用）。
 *
 * ─── 🔴 获取阶段死锁与有界重试（T9 真库双会话实证；`t9-lock-demo.log`）──────────
 *  锁行已存在（steady state）时，两个事务各自 `INSERT IGNORE`（命中重复行 ⇒ InnoDB 加
 *  **S 锁**、相容）后各自求 `FOR UPDATE`（S→X 升级）⇒ **互相等待 = 死锁（1213）**，
 *  InnoDB 回滚其中一方。真库确定性复现（两次 INSERT IGNORE 都过，随后 FOR UPDATE
 *  一方 `ER_LOCK_DEADLOCK`）——这不是理论窗口。
 *  处置：死锁发生在**获取阶段**（`fn` 尚未执行 ⇒ 该事务无任何副作用）⇒ 对 1213 做
 *  **有界重试**（`LOCK_MAX_ATTEMPTS` 次，每次一个全新事务）。重试的幂等依据 = 事务已整体
 *  回滚（数据库侧无痕）。🔴 **边界（刻意保守）**：`fn` **开始执行后**出现的 1213 **不重试**
 *  ——fn 可能已做外部副作用（如 currency.apply 的远端落账），重放语义只有它自己
 *  （锚幂等）才知道；原样抛给上层按恢复模型处理。
 */
export const LOCK_MAX_ATTEMPTS = 3;

/**
 * 物化锁行建行（§3.6 逐字形状）：命中已有行 ⇒ `affectedRows=0`（复用），不影响后续
 * `FOR UPDATE` 的加锁语义。
 */
export const LOCK_INSERT_IGNORE_SQL = 'INSERT IGNORE INTO `payment_user_locks` (`user_id`) VALUES (?)';

/** 行锁读（§3.6 逐字形状）：`FOR UPDATE` 读最新已提交版本并锁住直到事务结束。 */
export const LOCK_SELECT_FOR_UPDATE_SQL =
  'SELECT `user_id` FROM `payment_user_locks` WHERE `user_id` = ? FOR UPDATE';

/**
 * 死锁判别（mysql2 驱动错误两种形态 + 文案兜底；照 currency `isDuplicateEntryError` 的
 * 「多重形态都认」成例——误判代价不对称：漏认 ⇒ 重试面失效、真库间歇红）。
 */
export function isDeadlockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1213) return true;
  return typeof e.message === 'string' && /deadlock found/i.test(e.message);
}

@Injectable()
export class UserLockService {
  private readonly logger = new Logger(UserLockService.name);

  /** ⚠️ **值导入** `DataSource`（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器启动即崩）。 */
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 在**本用户的资金行锁内**执行 `fn`（一个独立事务；`fn` 拿到事务内 manager）。
   *
   * @param userId 锁主体（一人一行；不同 userId 互不阻塞）
   * @param fn     锁内的资金动作体（T10/T11：校验 → 插入 → 冻结；锁内最多两次 RPC——
   *               `withdrawable.get + apply`，各 3s 超时，见设计 §2.4 的锁内预算）
   * @returns fn 的返回值（事务提交后返回）
   * @throws fn 的错误原样穿出（事务已回滚）；获取阶段连续 1213 超过上限 ⇒ 抛最后一个死锁错
   */
  async withUserLock<T>(userId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      let fnStarted = false;
      try {
        return await this.dataSource.transaction(async (manager) => {
          await manager.query(LOCK_INSERT_IGNORE_SQL, [userId]);
          const rows = (await manager.query(LOCK_SELECT_FOR_UPDATE_SQL, [userId])) as Array<{
            user_id?: unknown;
          }>;
          if (rows.length !== 1) {
            // INSERT IGNORE 刚保证行在（PK=user_id，至多一行）——读不到 = 不变量破坏，响亮。
            throw new Error(
              `payment_user_locks 锁定读不到 user_id=${userId} 的行（INSERT IGNORE 刚执行过）—— 拒绝继续`,
            );
          }
          fnStarted = true;
          return await fn(manager);
        });
      } catch (err) {
        if (!fnStarted && attempt < LOCK_MAX_ATTEMPTS && isDeadlockError(err)) {
          // 获取阶段死锁：事务已整体回滚（fn 未执行 ⇒ 无副作用）⇒ 换新事务重试。
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `withUserLock 获取阶段死锁（ER_LOCK_DEADLOCK；INSERT IGNORE S 锁 × FOR UPDATE X 升级，见服务头注）` +
              `user_id=${userId} attempt=${attempt}/${LOCK_MAX_ATTEMPTS} ⇒ 重试新事务：${reason}`,
          );
          continue;
        }
        throw err;
      }
    }
  }
}
