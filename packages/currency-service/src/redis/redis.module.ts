import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * `REDIS` 注入令牌 —— 本服务**自建的最小面**（照 `config-service/src/redis/redis.module.ts`
 * 先例；user-service 的同名令牌住在 `auth/token.service.ts`，那是因为它要签发/吊销会话）。
 */
export const REDIS = 'REDIS';

/**
 * 本服务 Redis 连接的**唯一**工厂（承担余额缓存 `currency:balance:*`，规格 §2.11）。
 *
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`：让「Redis 不可用」**快速失败**。
 * ioredis 默认会把命令排队重试 20 次（实测一次真实故障要 ~10s 才 reject），而
 * currency.get 的读穿与 apply 的写穿都在请求路径上 —— 堆在重试队列里只会把请求拖死。
 *
 * ⚠️ 健康检查复用本服务**已有**的连接（`HealthService` 注入同一个 `REDIS`），不新建。
 */
export function createRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis }],
  exports: [REDIS],
})
export class RedisModule {}

/* ================================================================== *
 * 余额缓存帮助层（规格 §2.11 契约，逐字）
 *
 *  - 键：`currency:balance:<ownerId>`（⚙️4）
 *  - 值：余额的**十进制整数字符串**（如 `"250"`）
 *  - TTL：**无**（失效只由写穿覆盖与对账自愈负责 —— 因此 `SET` **绝不**带
 *    EX/PX/NX/XX 等任何选项；`redis.test.ts` 用「调用恰两个实参」钉住这一点）
 *
 * ⚠️ **只做读加速，永不参与写决策**（§2.11 表末行）：扣款够不够只由 §2.3 的
 * SQL 条件更新裁决，本层没有任何「读-比-写」形态的逻辑。
 * ⚠️ 帮助函数**不吞错**：Redis 故障原样 reject 给调用方 —— 写穿失败由 apply 降级
 * （warn + counter，不回滚）；读穿失败由 get/REST 降级（回源 MySQL）。吞掉错误会让
 * 调用方无法区分「miss」与「Redis 挂了」。
 * ================================================================== */

/** 键前缀（SCAN 自愈与键名帮助共用，别再出现第二份字面量）。 */
export const BALANCE_KEY_PREFIX = 'currency:balance:';

/** `currency:balance:<ownerId>`（⚙️4 逐字）。 */
export function balanceKey(ownerId: string): string {
  return `${BALANCE_KEY_PREFIX}${ownerId}`;
}

/**
 * 读缓存余额：命中 ⇒ 数值；**缺键** ⇒ `null`。
 * 值形态**收紧为十进制整数串**（`/^-?\d+$/` —— 🟢-3 / ⚙️14 附带项）：`Number` 宽松解析
 * 会把 `'1e3'`(→1000)/`'0x10'`(→16)/`''`(→0) 当命中；不匹配一律返回 `null` —— 视同 miss：
 * 读穿会回源 MySQL 并**覆盖**写回，对账（§2.12 检查 2）也会把这类漂移键 DEL 掉（两条自愈
 * 路径都不依赖本函数）。超出安全整数范围的形态同样当 miss（值契约是 `int` 量级十进制串）。
 */
export async function getBalance(redis: Redis, ownerId: string): Promise<number | null> {
  const raw = await redis.get(balanceKey(ownerId));
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 写穿缓存：SET 十进制整数字符串，**无 TTL**。
 * 非整数传入 ⇒ 当场抛（值契约是「十进制整数字符串」；静默 `String(1.5)` 会把
 * 契约之外的形态写进缓存，而读侧只能当 miss —— 属于该响亮的两处之一）。
 */
export async function setBalance(redis: Redis, ownerId: string, balance: number): Promise<void> {
  if (!Number.isInteger(balance)) {
    throw new Error(`余额缓存只接受整数（收到 ${JSON.stringify(balance)}）`);
  }
  await redis.set(balanceKey(ownerId), String(balance));
}

/** 删缓存键（对账自愈；下读回源）。 */
export async function delBalance(redis: Redis, ownerId: string): Promise<void> {
  await redis.del(balanceKey(ownerId));
}
