import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProtocolError, type CurrencyWithdrawableGetResponse } from '@fight-the-landlord/protocol';
import { GetService } from '../apply/get.service';

/**
 * `currency.withdrawable.get` 的读路径 —— 支付片 T4（规格 §2.2 契约 / §2.2.1 公式逐字）：
 * **只读，零写边**（不碰 `currency.apply` / 账户表 / 类型闸 —— 支付片的资金写边仍只有老的 apply）。
 *
 * ─── 语义（§2.2.1 逐字）──────────────────────────────────────────────────
 *  ```
 *  cap_raw(user) = Σ flows.delta  where source ∈ { recharge, game_settle,
 *                                                 refund_hold, refund_rollback,
 *                                                 withdraw_hold, withdraw_rollback }
 *  cap(user)     = max(0, min(cap_raw, balance))
 *  ```
 *  即：充值 + 对局净赢取 + 退款/提现往返可离场；`signup_grant` / `relief_grant` /
 *  `admin_adjust` 等**不入 6 源集合**（只影响余额）⇒ 「管理加币不可提、救助沉淀不可离场」。
 *  `cap ≤ balance` **由 `min` 结构恒成立**（`admin_adjust` 负扣减这类 cap_raw 大于余额的
 *  场景由 min 兜底；cap_raw 为负由 max 归 0）。
 *
 * ─── 读数两处（都是读）────────────────────────────────────────────────────
 *  - **balance：与 `currency.get` 同源读** —— 直接复用 `GetService.get`（缓存优先 → miss
 *    回源 MySQL 读穿；**读路径不建行**；无账户 ⇒ 0）。禁第二份余额读法（禁双份实现）。
 *  - **cap_raw：一条 JOIN 聚合**（⚙️17 先例写法：`source` 在 ops 不在 flows）；无流水 ⇒
 *    COALESCE 归 0。
 *
 * ─── 消费纪律（硬；规格 §2.2.1）──────────────────────────────────────────
 *  两个消费面（提现/退款）在**资金动作时刻（`payment_user_locks` 锁内）**执行本 RPC ——
 *  **禁缓存、禁只查一次**；本服务侧不设任何缓存：每次调用都是两条实时读。
 *
 * ─── 错误姿态（响应**不是** RpcResult 信封 —— §2.2 逐字 `{cap, balance}`）────────
 *  - 校验失败（ownerId 形状）⇒ 抛 `ProtocolError`（中文原因；**先于任何 IO**）；
 *  - 系统级故障（MySQL 不可达）/ 驱动回执畸形 ⇒ **抛**（不静默编造钱数）。
 *  - 抛即「RPC 失败」：调用方（payment 提现/退款链）按纪律 **fail-closed 拒申请**
 *    （15003/15006 —— 不确定不放松）。
 *
 * ⚠️ **DI 纪律**：`GetService` / `DataSource` 值导入 + 显式 `@Inject(...)`（不依赖
 * `emitDecoratorMetadata` —— vitest/esbuild 不发它；`import type` 则让真容器启动即崩）。
 */

/** 规格 §2.2.1 的 6 源集合（**按规格次序**；cap_raw 只认这 6 源）。 */
export const WITHDRAWABLE_SOURCES = [
  'recharge',
  'game_settle',
  'refund_hold',
  'refund_rollback',
  'withdraw_hold',
  'withdraw_rollback',
] as const;

/**
 * cap_raw 单条读（⚙️17 JOIN 先例写法：`JOIN currency_ops o ON o.id=f.op_id`；`source` 在 ops）。
 * 占位次序 = `[ownerId, ...6 源（规格次序）]`；单测假库按**全文相等**识别（漂移一个字符当场红）。
 */
export const CAP_RAW_SELECT_SQL =
  'SELECT COALESCE(SUM(f.delta), 0) AS total FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id WHERE f.owner_id = ? AND o.source IN (?, ?, ?, ?, ?, ?)';

/** ownerId 形状（§2.3：`[A-Za-z0-9_-]{1,36}`；协议未导出该正则——接收侧按同式复检）。 */
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

@Injectable()
export class WithdrawableService {
  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例）：不依赖 `emitDecoratorMetadata` 发出的
   * `design:paramtypes`（vitest/esbuild 不发它 ⇒ 只靠类型的注入在单测里会静默注入 `undefined`）。
   */
  constructor(
    @Inject(GetService) private readonly getService: GetService,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  /**
   * 读边入口（RPC `currency.withdrawable.get` 接收侧的唯一调用方）。
   *
   * 入参取 `unknown`：线到的一切都过 `assertOwnerId` 这一扇门（无协议校验函数 —— T1 契约为
   * **仅类型**，接收侧做形状级校验，`risk.deviceReport` 先例）。返回**平形状** `{cap, balance}`
   * （无信封）；非法/故障一律抛（见类头错误姿态）。
   */
  async get(req: unknown): Promise<CurrencyWithdrawableGetResponse> {
    const ownerId = assertOwnerId(req);

    // ① balance：同源读（`currency.get` 的唯一实现 —— 缓存优先/读穿/不建行都归它）。
    const balanceRes = await this.getService.get({ ownerIds: [ownerId] });
    if (!balanceRes.ok) {
      // 预校验与 validateCurrencyGet 同式 ⇒ 走到这里 = 两处 ownerId 规则漂移（理论分支）。
      // 不吞：RPC 失败由调用方 fail-closed 处理（§2.2.1 纪律）。
      throw new Error(
        `currency.withdrawable.get 读余额被 currency.get 拒绝（${balanceRes.code}: ${balanceRes.message}）`,
      );
    }
    const balance = balanceRes.data.balances[0]!.balance;

    // ② cap_raw：Σ 6 源 delta（无命中流水 ⇒ COALESCE ⇒ 0；聚合恒 1 行）。
    const rows = (await this.dataSource.query(CAP_RAW_SELECT_SQL, [
      ownerId,
      ...WITHDRAWABLE_SOURCES,
    ])) as Array<{ total: unknown }>;
    if (rows.length === 0) {
      // 无 GROUP BY 的聚合恒 1 行；空 = 驱动回执畸形 ⇒ 抛（不静默按 0 处理）。
      throw new Error('currency.withdrawable.get：cap_raw 聚合读回空行（驱动回执畸形）');
    }
    const rawValue = rows[0]!.total;
    // SUM ⇒ DECIMAL：mysql2 回字符串（S13 型别钉）；两形态都转，其余响亮抛（同 get.service 姿态）。
    const capRaw = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isSafeInteger(capRaw)) {
      throw new Error(
        `currency.withdrawable.get：cap_raw 不是安全整数（收到 ${JSON.stringify(rawValue)}）`,
      );
    }

    // ③ clamp（§2.2.1 逐字）：负归 0；高于余额由 min 收到余额（`cap ≤ balance` 结构恒成立）。
    return { cap: Math.max(0, Math.min(capRaw, balance)), balance };
  }
}

/** ownerId 形状校验（§2.3 同式、中文原因 —— 与 `validateCurrencyGet` 的措辞同族）。 */
function assertOwnerId(req: unknown): string {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new ProtocolError('currency.withdrawable.get 请求必须是对象');
  }
  const { ownerId } = req as Record<string, unknown>;
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new ProtocolError(
      `ownerId 必须是 1..36 字符的 [A-Za-z0-9_-] 字符串（收到 ${JSON.stringify(ownerId)}）`,
    );
  }
  return ownerId;
}
