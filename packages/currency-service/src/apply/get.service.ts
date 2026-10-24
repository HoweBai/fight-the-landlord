import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import {
  ErrCode,
  validateCurrencyGet,
  type CurrencyGetRequest,
  type CurrencyGetResponse,
} from '@fight-the-landlord/protocol';
import { REDIS, getBalance, setBalance } from '../redis/redis.module';

/**
 * 货币核心（T4；规格 §2.4 / §2.11 / §6.1）：`currency.get` 的读路径 —— **只读，永不裁决钱**。
 *
 * ─── 契约（§2.4 逐字）────────────────────────────────────────────────────
 *  - 请求 `{ ownerIds: string[1..50] }`（逐条同 §2.3 的 ownerId 约束；**允许重复**）；
 *    响应与请求**同序一一对应**：`{ ownerId, balance, exists }`。
 *  - **缓存优先**（`currency:balance:<ownerId>` 命中即回）→ miss **回源 MySQL 并写缓存**（读穿）；
 *  - `exists=false ⇒ balance:0`；**读路径不建行**（不产垃圾行）。
 *
 * ─── 两处就地判读（依据写在这里，别处不再解释）───────────────────────────
 *  ① **缓存命中 ⇒ `exists:true`**：本服务里缓存键只会由两条路径写下 —— apply 提交后的写穿
 *     （提交成功 ⇒ 行必在）与下面的读穿（`exists:true` 才 SET）——且对账检查 2 会把
 *     「账户不存在而键在」判为漂移并 DEL（§2.12）。⇒ 键在 ⇒ 行在。
 *  ② **`exists=false` 不写缓存**：同上反向 —— 给不存在的账户写 `0` 会让每一轮对账都把
 *     读穿自己刚写下的键判成漂移（自造 counter 噪声），§2.4 的「不产垃圾行」同旨。
 *
 * ─── 错误姿态（R220 信封，与 `ApplyService.apply` 同口径）────────────────
 *  - 校验失败 ⇒ `{ok:false, code:10001, message:中文原因}`（**不抛**）；
 *  - Redis 读写失败 ⇒ **降级**（`redis.module.ts` 文件头：读穿失败由 get/REST 降级回源）——
 *    warn 日志 + 继续，权威值在 MySQL；Redis **不裁决任何事**（§2.11 表末行）。
 *  - 系统级故障（MySQL 不可达、驱动回执畸形）⇒ **抛**，由 T4 的 RPC 控制器映射
 *    `UPSTREAM_UNAVAILABLE`（调用方 10007）。
 *
 * ⚠️ **DI 纪律**：`DataSource` 值导入（`@Inject(DataSource)` 的运行期 token）；`Redis` 只作
 * 参数类型 ⇒ `import type` 安全（与 `ApplyService` 同形）。
 */

/** miss 回源读：与 §2.3 快照同形的单行余额读。读路径**绝不** INSERT（§2.4「不建行」）。 */
const BALANCE_SELECT_SQL = 'SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?';

@Injectable()
export class GetService {
  private readonly logger = new Logger(GetService.name);

  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例）：不依赖 `emitDecoratorMetadata` 发出的
   * `design:paramtypes`（vitest/esbuild 不发它 ⇒ 只靠类型的注入在单测里会静默注入 `undefined`）。
   */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 读边入口（T4 的 RPC 控制器 / T5 的玩家 REST 唯一调用方）。
   *
   * 入参取 `unknown`：**唯一校验点** `validateCurrencyGet`（T2 契约）就在下一行 ——
   * 线到的一切都从这扇门过。返回**信封**（`RpcResult<CurrencyGetData>`）：业务错误不抛。
   */
  async get(req: unknown): Promise<CurrencyGetResponse> {
    try {
      validateCurrencyGet(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`currency.get reject code=${ErrCode.BAD_PARAM} reason=${message}`);
      return { ok: false, code: ErrCode.BAD_PARAM, message };
    }
    const { ownerIds } = req as CurrencyGetRequest;

    // 同序一一对应：逐位读取（重复位由**首次读穿写下的缓存**接住，见 get.test 的同序用例）。
    const balances: Array<{ ownerId: string; balance: number; exists: boolean }> = [];
    for (const ownerId of ownerIds) {
      balances.push(await this.readOne(ownerId));
    }
    return { ok: true, data: { balances } };
  }

  /** 单个 ownerId：缓存优先 → miss 回源 + 读穿写缓存。 */
  private async readOne(
    ownerId: string,
  ): Promise<{ ownerId: string; balance: number; exists: boolean }> {
    // ① 缓存优先。Redis 故障 ⇒ 降级（视同 miss，回源 MySQL）——不是错误路径的一部分。
    let cached: number | null = null;
    try {
      cached = await getBalance(this.redis, ownerId);
    } catch (err) {
      this.logger.warn(
        `cache_read_failed ownerId=${ownerId} reason=${err instanceof Error ? err.message : String(err)}（降级回源 MySQL）`,
      );
    }
    if (cached !== null) return { ownerId, balance: cached, exists: true }; // 键在 ⇒ 行在（见类头 ①）

    // ② miss 回源 MySQL（只读；行不存在 ⇒ exists:false，**不建行、不写缓存** —— 见类头 ②）。
    const rows = (await this.dataSource.query(BALANCE_SELECT_SQL, [ownerId])) as Array<{
      balance: unknown;
    }>;
    if (rows.length === 0) return { ownerId, balance: 0, exists: false };

    const raw = rows[0]!.balance;
    const balance = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isSafeInteger(balance)) {
      // 驱动回执畸形 ⇒ 抛（不静默编造余额；由控制器映射 10007）。
      throw new Error(`currency_accounts.balance ownerId=${ownerId}：读出的值不是安全整数（收到 ${JSON.stringify(raw)}）`);
    }

    // ③ 读穿写缓存（§2.11）：失败降级 + warn —— 权威值在 MySQL，响应不受影响。
    try {
      await setBalance(this.redis, ownerId, balance);
    } catch (err) {
      this.logger.warn(
        `cache_write_failed（读穿）ownerId=${ownerId} balance=${balance} reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ownerId, balance, exists: true };
  }
}
