/**
 * 广告片 T12：**claim 双键服务**（规格 §2.6「claim 机制（Redis；设计『规格定』全落）」逐字）。
 *
 * ─── 键形（§2.6 逐字）────────────────────────────────────────────────────
 *  - 记录 `relief:claim:{nonce}` = JSON `{userId, date, state:'issued'|'done', result?}`
 *    （`date` = Asia/Shanghai **签发日**——首发时刻固定，**复用续窗不重锚**）；
 *  - 索引 `relief:claim:u:{userId}` → nonce（**双键同生命周期**：TTL 同设同续）。
 *  - nonce = `randomBytes(16).toString('base64url')`（22 字符，128bit 熵；⚙️B）。
 *    【T0-5 边界】若额外载荷限字符集 ⇒ **只改 `mintNonce()` 一处**（熵 ≥131bit 仍足）。
 *
 * ─── TTL（⚙️C；不设配置键）───────────────────────────────────────────────
 *  - issued 态 = `RELIEF_CLAIM_TTL_SECONDS(900)`，**eligible GET 续期**（复用分支 =
 *    两键 EXPIRE 同置 900——签发/确认各一次，窗口有效起点 = 确认步骤）；
 *  - done 态 = `RELIEF_CLAIM_DONE_TTL_SECONDS(172800)`；**done 落定时删除索引键**
 *    （⚙️E：「无自致悬垂」——done 记录本身保留 48h 供重投短路/轮询读终态）。
 *
 * ─── 「找到或创建」原子算法（⚙️D = NX + 补偿；伪代码契约逐字落，勿"优化"）──
 *  1. `GET idx` 命中 ⇒ 读记录：`issued` ⇒ 两键 EXPIRE 续期、复用同 nonce；否则
 *     **条件删索引**（悬垂：索引在而记录不在/非 issued ⇒ 视为无凭证——⚙️E）；
 *  2. 新 nonce；`SET rec {userId, date, issued} EX 900 NX`（占用记录键）；
 *  3. `SET idx nonce EX 900 NX`：成 ⇒ 新签返回；败（并发竞窗）⇒ **DEL 自家记录**
 *     （补偿，不留无人引用的记录）→ 读胜者：其记录 issued ⇒ 按其复用返回；否则
 *     **条件删悬垂胜者索引** → 重试至多 1 次（共 2 轮）；仍败 ⇒ 按瞬态失败。
 *
 *  🔴 **两处悬垂 DEL 一律条件化**（规格 v1.2 要害裁决：`WATCH idx → GET → 当前值 ===
 *     本次观察值 ⇒ MULTI DEL EXEC；否则 UNWATCH`）：**非条件 DEL 会误删并发胜者刚写入的
 *     新索引 ⇒ 同用户瞬时双凭证**（违设计 §2/§3 的单凭证不变量）。本实现取 WATCH/MULTI
 *     形态（规格：WATCH/MULTI 或 Lua 等价物，实现自选——本片取前者，假库 T12 扩展同源建模）。
 *
 * ─── `markDone`（并发双投**条件写**；规格 §2.6 末条）───────────────────────
 *  `WATCH rec → GET → 仅 state==='issued' ⇒ MULTI [SET rec done EX 172800, DEL idx] EXEC；
 *   否则 UNWATCH`（事务弃 = 竞败方**不覆盖**胜者 `result`——上层按其读回的 result 返 200）。
 *  记录不存在/已 done ⇒ no-op（`claim_invalid` 不建键；顺序重投由调用方短路）。
 *
 * ─── 故障分类（⚙️ r3 🟡-6）───────────────────────────────────────────────
 *  `read` 的「**读取故障（瞬态）**」= `'read-failure'`（Redis 连接异常）——**不得**与
 *  `null`（不存在/过期/畸形：上层归 `claim_invalid`）混同；写路径故障与重试耗尽统一抛
 *  `ClaimTransientError` ⇒ 上层 GET 503（10007 系）/ 回调 5xx（可重投，记录保持 issued）。
 *
 * ─── 日期口径（两处互指）────────────────────────────────────────────────
 *  私有 `todayShanghai()` 委托 `../util/shanghai-date.ts` 的 `shanghaiDateOf` —— 与
 *  `wallet.controller.ts` 的 `reliefActionId` **同一实现点**：claim 锚定 actionId
 *  `relief:<claim.userId>:<claim.date>` 的日期必须与首次签发锚逐字一致（跨 UTC 日界）。
 *  畸形记录（JSON 坏/形状不符）⇒ 读作「无凭证」（`null`）：与 `resolveClaim` 的
 *  「畸形 ⇒ invalid」归类一致，且悬垂恢复据此自愈（记录键损坏是本类数据面损坏的唯一样来源）。
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { shanghaiDateOf } from '../util/shanghai-date';

/** issued 态 TTL（⚙️C 逐字；eligible GET 续期同置）。 */
export const RELIEF_CLAIM_TTL_SECONDS = 900;

/** done 态 TTL（⚙️C 逐字；48h 供重投短路/轮询读终态）。 */
export const RELIEF_CLAIM_DONE_TTL_SECONDS = 172800;

/** 终态结果域（规格 §2.6 记录值逐字）。 */
export type ReliefResult = 'granted' | 'replayed' | 'disabled' | 'balance_ok';

/**
 * 读取/写入故障与重试耗尽的**统一出口**（⇒ 上层 GET 503 / 回调 5xx 可重投）。
 * `read()` 的读取故障不走本类——那是**返回值域**的 `'read-failure'`（只读分类，供
 * resolveClaim 三分类之外的瞬态判读）。
 */
export class ClaimTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimTransientError';
  }
}

/** 记录形状（值与 §2.6 逐字；`result` 仅 done 态写落）。 */
interface ClaimRecord {
  userId: string;
  date: string;
  state: 'issued' | 'done';
  result?: ReliefResult;
}

/** 记录键 `relief:claim:{nonce}`（§2.6 逐字——键形只此一处字面量）。 */
const recKey = (nonce: string): string => `relief:claim:${nonce}`;

/** 索引键 `relief:claim:u:{userId}`（§2.6 逐字）。 */
const idxKey = (userId: string): string => `relief:claim:u:${userId}`;

/**
 * nonce 生成（⚙️B；【T0-5 边界】若载荷限字符集 ⇒ **只改这一处**）。
 * `randomBytes(16).toString('base64url')` = 22 字符、128bit 熵。
 */
function mintNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** 形状判读（读侧 fail-closed：形状不符 ⇒ 视同「无凭证」，见文件头「畸形记录」注）。 */
function isClaimRecord(value: unknown): value is ClaimRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.userId !== 'string' || typeof rec.date !== 'string') return false;
  if (rec.state !== 'issued' && rec.state !== 'done') return false;
  if (rec.result !== undefined) {
    if (
      rec.result !== 'granted' &&
      rec.result !== 'replayed' &&
      rec.result !== 'disabled' &&
      rec.result !== 'balance_ok'
    ) {
      return false;
    }
  }
  return true;
}

@Injectable()
export class ClaimService {
  /**
   * ⚠️ **显式 `@Inject(REDIS)`**（本仓既有惯例，同 `GetService`）：不依赖
   * `emitDecoratorMetadata` 的隐式注入（vitest/esbuild 不发 `design:paramtypes`）。
   */
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * 找到（复用+续期）或创建（NX+补偿）当日凭证（文件头伪代码契约逐字）。
   * 读取/写入故障与重试耗尽 ⇒ `ClaimTransientError`（统一出口 ⇒ 上层 GET 503 / 回调 5xx）。
   */
  async findOrCreate(userId: string): Promise<{ nonce: string; date: string; reused: boolean }> {
    try {
      // 至多 1 次重试（共 2 轮；伪代码 `for (attempt < 2)` 逐字——勿"优化"轮数）。
      for (let attempt = 0; attempt < 2; attempt++) {
        const observed = await this.redis.get(idxKey(userId));
        if (observed !== null) {
          const rec = await this.readRecord(observed);
          if (rec !== null && rec.state === 'issued') {
            // 复用 + 续期（两键 EXPIRE 同置 = 窗起点刷新至确认步骤；同 nonce、date 不重锚）。
            await this.redis
              .multi()
              .expire(recKey(observed), RELIEF_CLAIM_TTL_SECONDS)
              .expire(idxKey(userId), RELIEF_CLAIM_TTL_SECONDS)
              .exec();
            return { nonce: observed, date: rec.date, reused: true };
          }
          await this.conditionalDelIdx(userId, observed); // 悬垂：仅当值 == 观察值才删（条件删）
        }

        const nonce = mintNonce();
        const date = this.todayShanghai();
        // 记录先行（补偿面覆盖之：记录键无人引用时可安全 DEL）。
        await this.redis.set(
          recKey(nonce),
          JSON.stringify({ userId, date, state: 'issued' }),
          'EX',
          RELIEF_CLAIM_TTL_SECONDS,
          'NX',
        );
        const ok = await this.redis.set(idxKey(userId), nonce, 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
        if (ok === 'OK') return { nonce, date, reused: false };

        // 并发竞窗：索引 NX 败 ⇒ 补偿自家记录（不留无人引用的记录）。
        await this.redis.del(recKey(nonce));
        const winner = await this.redis.get(idxKey(userId));
        if (winner !== null) {
          const wrec = await this.readRecord(winner);
          if (wrec !== null && wrec.state === 'issued') {
            return { nonce: winner, date: wrec.date, reused: true };
          }
          await this.conditionalDelIdx(userId, winner); // 悬垂（记录不在/非 issued）：比对观察值 winner 才删
        }
        // winner 为 null（索引已被对手删除/过期）⇒ 直接重试创建；两态皆由下一轮 NX 兜底。
      }
    } catch (err) {
      if (err instanceof ClaimTransientError) throw err;
      throw new ClaimTransientError(
        `claim find-or-create 故障（瞬态）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new ClaimTransientError('claim find-or-create 重试耗尽'); // ⇒ 上层 503（GET）/5xx（回调）
  }

  /**
   * 读记录：`记录 | null（不存在/过期/畸形）| 'read-failure'（连接故障——瞬态，**不与 null 混同**）`。
   * 只读分类入口（T14 的 `resolveClaim` 消费）；写路径不吞错（由 `ClaimTransientError` 出口）。
   */
  async read(
    nonce: string,
  ): Promise<{ userId: string; date: string; state: 'issued' | 'done'; result?: ReliefResult } | null | 'read-failure'> {
    try {
      return await this.readRecord(nonce);
    } catch {
      // Redis 连接异常 = 「读取故障（瞬态）」：上层 5xx 可重投（⚙️ r3 🟡-6），不得归 claim_invalid。
      return 'read-failure';
    }
  }

  /**
   * 条件写 done（`WATCH rec → GET → 仅 issued ⇒ MULTI [SET done EX 172800, DEL 索引] EXEC；
   * 否则 UNWATCH`）。事务弃（EXEC 返 null）= 竞败方**不覆盖**胜者 result——上层按其读回的
   * result 返 200（§2.6 末条）。记录不存在/已 done ⇒ no-op。故障 ⇒ `ClaimTransientError`。
   *
   * ⚠️ 索引 DEL 与 SET 同事务、WATCH 只护**记录键**（简报契约原样）：「记录仍 issued 而索引
   * 异指」在双键同生命周期下不可达（索引被换的唯一路径 = 悬垂条件删，其前置是记录不在/非
   * issued）；此处不引入简报未写死的第二条件（勿"优化"）。
   */
  async markDone(nonce: string, result: ReliefResult): Promise<void> {
    try {
      await this.redis.watch(recKey(nonce));
      const rec = await this.readRecord(nonce);
      if (rec === null || rec.state !== 'issued') {
        await this.redis.unwatch(); // 不存在/已终态 ⇒ 幂等 no-op（claim_invalid 不建键）
        return;
      }
      await this.redis
        .multi()
        .set(
          recKey(nonce),
          JSON.stringify({ userId: rec.userId, date: rec.date, state: 'done', result }),
          'EX',
          RELIEF_CLAIM_DONE_TTL_SECONDS,
        )
        .del(idxKey(rec.userId))
        .exec();
      // exec 返 null（本键被抢改）⇒ 竞争者已落终态：不覆盖、不报错（上层按其读回的 result 收口）。
    } catch (err) {
      if (err instanceof ClaimTransientError) throw err;
      throw new ClaimTransientError(
        `claim mark-done 故障（瞬态）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 条件删索引（规格 v1.2 要害裁决逐字）：`WATCH idx → GET → 当前值 === observed ⇒
   * MULTI DEL EXEC；否则 UNWATCH`。**非条件 DEL 会误删并发胜者刚写入的新索引 ⇒ 同用户
   * 瞬时双凭证**——两处悬垂 DEL（调用点见 findOrCreate）一律走本方法。
   * EXEC 被 WATCH 失效拦下（返 null）时同效于「不删」：索引已被对手改写 ⇒ 下一轮 NX 兜底。
   */
  private async conditionalDelIdx(userId: string, observed: string): Promise<void> {
    await this.redis.watch(idxKey(userId));
    const current = await this.redis.get(idxKey(userId));
    if (current === observed) {
      await this.redis.multi().del(idxKey(userId)).exec();
    } else {
      await this.redis.unwatch();
    }
  }

  /**
   * 原始记录读（**连接故障原样抛出**——由 `read()` 归类 `'read-failure'`、由写路径的
   * 外层 catch 归 `ClaimTransientError`）。`null` = 不存在（键缺）**或**畸形（JSON 坏/
   * 形状不符——按「无凭证」自愈，见文件头「畸形记录」注）。
   */
  private async readRecord(nonce: string): Promise<ClaimRecord | null> {
    const raw = await this.redis.get(recKey(nonce));
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isClaimRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 签发日（Asia/Shanghai 的 YYYY-MM-DD）——委托 `util/shanghai-date.ts`（**唯一实现点**），
   * 与 `wallet.controller.ts` 的 `reliefActionId` **同源**（两处互指注释）：claim 锚定的
   * actionId 日期必须与首次签发锚逐字一致（跨 UTC 日界）。首发时刻固定、复用不重锚。
   */
  private todayShanghai(): string {
    return shanghaiDateOf(new Date());
  }
}
