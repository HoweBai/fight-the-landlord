import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * 风控 T7：本模块的旗读日志出口（`console.*` 被 `no-raw-console` 闸禁用；
 * Nest 的 `Logger` 经 `Logger.overrideLogger` 挂脱敏器 —— 与网关其余日志同一条链）。
 */
const logger = new Logger('RateLimit');

/** §5.4：单用户 HTTP 请求 20 次 / 5 秒。 */
export const HTTP_RATE_LIMIT = { max: 20, windowMs: 5000 } as const;

/**
 * 风控 T7（规格 §2.6-1 逐字）：**限流档**阈值 —— 旗 `risk:limit:{userId}` 在时，
 * 以 `3 次 / 1000ms` 对**同一键** `ratelimit:http:{userId}` 滑窗判定（§2.6-2）。
 *
 * ⚠️ 值 = 规格写死（与 room 侧 WS 档**同值、各自定义**：两个服务不共享运行期常量 ——
 * 规格 §2.6-1 的字面形态）。
 */
export const THROTTLED_RATE_LIMIT = { max: 3, windowMs: 1000 } as const;

/**
 * 风控旗键（规格 §2.3 逐字）：`risk:limit:{userId}` —— 网关**只读不写**
 *（写点 = user-service 的扫描（auto）/ 管理动作（manual））。
 */
export const riskLimitFlagKey = (userId: string): string => `risk:limit:${userId}`;

/**
 * §5.4 的**第五个维度：单 IP HTTP 请求**（N13 / R453）。**这个数字是规格值**：
 * 出处有两处且必须一致 —— 裁决 R453 的原文与 `design.md` §5.4 的规格表
 * （协调者已补上「单 IP HTTP 请求 | 120 次 / 60 秒 | `10006`」那一行）。
 * 本文件**不得**另起第二套阈值；改阈值 = 改规格表。
 *
 * ⚠️ 阈值**刻意**比单用户维度（20/5s）宽得多：它的目标是「挡住暴力破解的规模」，
 * 不是「防误用」。原登记（N13）的阻塞逐字是「凭空加一维会打伤 conformance 的造数步骤
 * （`slice-07.1` 一次连发 20 个注册）」⇒ 120/min 下那 20 个注册只占 1/6，
 * 既有用例不受影响（正对照见 `test/http-rate-limit.test.ts`）。
 * ⚠️ 覆盖范围（R462）：**未认证的 `auth/*` 仍被它覆盖**（N13 的缺口正是那三条路径），
 * 而**健康端点豁免**（§2.4 存活面不查依赖）—— 见 `http-rate-limit.middleware.ts` 的顺序。
 */
export const HTTP_IP_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

/**
 * 片⑦ §2.6（T10 / 设计 D6 / spec F4）：**管理登录失败桶** —— 单 IP 5 次 / 5 分钟。
 *
 * 与其它维度的**语义差异**（这正是它要新写而不是复用 `hitHttpLimit` 的原因）：
 * **失败计次、成功清零** —— 桶里的数不是「请求数」而是「下游的响应结果」，记账发生在
 * **响应出口**（中间件的 finish 钩子），因此判定（请求入口）与记账（响应出口）
 * **不可能**收进同一个函数（既有族「判定与记账同一函数」的纪律在这里物理上不适用 ——
 * 配对由中间件分支逻辑保证，判据见 `test/http-rate-limit.test.ts` 的 T10 一组）。
 *
 * ⚠️ 达界语义（spec F5 逐字：「**桶达界 ⇒ 正确口令也 429**（检查在比较之前）」）：
 * 判定用 `>= max` 且发生在**任何转发之前** —— 第 6 次请求在入口即拒，口令永远不会
 * 被比较（防爆破本来就该如此：达界之后还验口令 = 界不生效）。
 */
export const ADMIN_LOGIN_FAIL = { max: 5, windowMs: 300_000 } as const;

/** 代理门户登录失败桶（2026-10-26）：与 admin 同阈值，键独立。 */
export const AGENT_LOGIN_FAIL = { max: 5, windowMs: 300_000 } as const;

/**
 * 片⑦ §2.6（T10）：**管理写桶** —— 按管理令牌（sha256 前 16 位指纹）30 次 / 5 分钟。
 *
 * 维度是**令牌指纹**而不是 IP：管理面会把令牌带在身上，写操作的可归因主体是令牌
 * （同一管理员换 IP 不豁免；他人拿不到令牌 ⇒ 桶不可被第三方投毒）。
 */
export const ADMIN_WRITE = { max: 30, windowMs: 300_000 } as const;

/* ─────────────────────── 支付片 T13：玩家面写端点三档桶（§2.4.1 脚注）─────────────────────── */

/**
 * 规格 §2.4.1 限流脚注**逐字**：`1=10/分 · 3=30/分 · 6/8=5/分`（**用户维**）。
 *
 * 作用在网关**既有限流中间件**（`HttpRateLimitMiddleware`）——新增桶照五维先例（ZSET
 * 滑动窗、判定与记账同一函数、键形状 `ratelimit:{dimension}:{key}`）。阈值是规格值，
 * 本文件不持魔法数（改阈值 = 改规格）。
 */
export const PAY_ORDER_CREATE_LIMIT = { max: 10, windowMs: 60_000 } as const;
export const PAY_ORDER_SYNC_LIMIT = { max: 30, windowMs: 60_000 } as const;
export const PAY_REFUND_APPLY_LIMIT = { max: 5, windowMs: 60_000 } as const;
export const PAY_WITHDRAW_APPLY_LIMIT = { max: 5, windowMs: 60_000 } as const;

/** 桶名（键形状的第二段；申请两桶**各自独立**——「申请各 5/分」不是合计 5/分）。 */
export type PayLimitBucket = 'pay-order' | 'pay-sync' | 'pay-refund' | 'pay-withdraw';

const PAY_LIMITS: Record<PayLimitBucket, { readonly max: number; readonly windowMs: number }> = {
  'pay-order': PAY_ORDER_CREATE_LIMIT,
  'pay-sync': PAY_ORDER_SYNC_LIMIT,
  'pay-refund': PAY_REFUND_APPLY_LIMIT,
  'pay-withdraw': PAY_WITHDRAW_APPLY_LIMIT,
};

/** 键：`ratelimit:pay-order:{userId}` 等（§5.4 键形状逐字延伸——维度名即桶名）。 */
export const payRateLimitKey = (bucket: PayLimitBucket, userId: string): string =>
  `ratelimit:${bucket}:${userId}`;

/**
 * 支付片 T13：**路径 → 桶**判定（唯一实现；`HttpRateLimitMiddleware` 消费）。
 *
 * - 只认 **POST**（三档全是写端点；GET/其它动词 ⇒ `null`，落既有维度）；
 * - 归一 = 小写 + 剥尾斜杠：Express 路由匹配**大小写不敏感**、非严格路由（尾斜杠同命中）
 *   ⇒ 不归一则大小写/尾斜杠变体绕过专属桶（⚙️20 教训的同族形态；多计只让桶更严，
 *   方向 fail-closed）；
 * - `/sync` 是参数尾段：`/api/pay/orders/<单号段非空>/sync`（段内无 `/`）；
 * - 近邻路径（`/api/pay/ordersx`、`/api/payx/orders`、`/api/admin/pay/*`）**不得**命中
 *   （负对照在 `http-rate-limit.test.ts`）。
 */
export function payLimitBucketOf(method: unknown, path: string): PayLimitBucket | null {
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return null;
  const norm = path.toLowerCase().replace(/\/+$/, '');
  if (norm === '/api/pay/orders') return 'pay-order';
  if (/^\/api\/pay\/orders\/[^/]+\/sync$/.test(norm)) return 'pay-sync';
  if (norm === '/api/pay/refunds') return 'pay-refund';
  if (norm === '/api/pay/withdrawals') return 'pay-withdraw';
  return null;
}

/**
 * 支付片 T13：三档桶的滑动窗口（**判定与记账在同一个函数里**——理由与 `hitHttpLimit`
 * 逐字相同：分成两个函数就会有调用方「只判不记」；member 用 `now-随机` 同理）。
 *
 * @returns `true` = **超限，必须拒绝**。
 */
export async function hitPayLimit(
  redis: Redis,
  bucket: PayLimitBucket,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const limit = PAY_LIMITS[bucket];
  const key = payRateLimitKey(bucket, userId);
  await redis.zremrangebyscore(key, 0, now - limit.windowMs);
  const count = await redis.zcard(key);
  if (count >= limit.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(limit.windowMs / 1000));
  return false;
}

/**
 * §5.4：单 IP 并发 WebSocket 连接 5 条。
 *
 * `ttlSeconds` 是**兜底**（§5.4 逐字：「对每个 IP 的连接 key 设 TTL 兜底，防止进程崩溃
 * 导致计数泄漏」）：正常路径靠 `disconnect` 的 `ZREM`，TTL 只负责清理崩溃残留。
 * 之所以 60s 够：连接存活时 engine.io 每 30s 一个 `heartbeat`，我们借它续期
 * （见 `proxy.gateway.ts` 的 `client.conn.on('heartbeat', …)`）—— **不续期**的话
 * TTL 会把长连接当成崩溃残留删掉，于是第 6 条能挤进来（限流被绕过）。
 */
export const WS_CONN_LIMIT = { max: 5, ttlSeconds: 60 } as const;

/** §5.4 的键形状：`ratelimit:{dimension}:{key}`。 */
export const httpRateLimitKey = (userId: string): string => `ratelimit:http:${userId}`;
export const wsConnRateLimitKey = (ip: string): string => `ratelimit:ws-conn:${ip}`;
/** 第五维度的键：`ratelimit:http-ip:{ip}`（N13/R453）。 */
export const httpIpRateLimitKey = (ip: string): string => `ratelimit:http-ip:${ip}`;
/** 片⑦ T10 的键形状（规格 §2.6）：登录失败按 **IP**、写按 **令牌指纹**。 */
export const adminLoginFailKey = (ip: string): string => `ratelimit:admin-login-fail:${ip}`;
export const adminWriteKey = (tokenFp: string): string => `ratelimit:admin-write:${tokenFp}`;

/**
 * §5.4 的滑动窗口：`ZREMRANGEBYSCORE` 清窗外 → `ZCARD` 判定 → `ZADD` 记账。
 *
 * 判定与记账**必须**在同一个函数里：分成两个函数就会有调用方「只判不记」，
 * 于是限流静默失效（本仓已有前科：`acquireBot` 漏头只被 conformance 抓到，R70/R90）。
 * member 用 `now-随机`（与 room-service 的 `ratelimit:ws` 同形）—— 同一毫秒的多个
 * 请求不能互相覆盖（ZSET 的成员唯一，同 member 的 `ZADD` 是更新而不是新增）。
 *
 * 风控 T7（规格 §2.6-4）：阈值经 `limit` **参数化**（默认正常档 `HTTP_RATE_LIMIT`；
 * 限流档传 `THROTTLED_RATE_LIMIT`）—— 与 room 侧 `isRateLimited` 同款扩参形态，
 * **判定逻辑唯一**，不复制第二套（键也仍是同一键 `ratelimit:http:{userId}`）。
 *
 * @returns `true` = **超限，必须拒绝**。
 */
export async function hitHttpLimit(
  redis: Redis,
  userId: string,
  now: number = Date.now(),
  limit: { readonly max: number; readonly windowMs: number } = HTTP_RATE_LIMIT,
): Promise<boolean> {
  const key = httpRateLimitKey(userId);
  await redis.zremrangebyscore(key, 0, now - limit.windowMs);
  const count = await redis.zcard(key);
  if (count >= limit.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(limit.windowMs / 1000));
  return false;
}

/**
 * 风控 T7（规格 §2.6-2 第一句；R11/F8 纪律）：**限流档旗的读点** ——
 * `EXISTS risk:limit:{userId}`（只读，不写）。
 *
 * 🔴 **单独 try/catch ⇒ 按无旗（`false`）+ error 日志**：旗只是**附加准入信息**，
 * 它的读取故障**不得**吞进调用方（限流中间件）的 fail-closed 管道 —— 那里的
 * 503/10007 是「**正常限流链自身**可用性故障」的语义，两者必须可区分；可用性优先
 * （与 room 侧 `readRiskFlag` 逐字同口径）。
 */
export async function isThrottled(redis: Redis, userId: string): Promise<boolean> {
  try {
    return (await redis.exists(riskLimitFlagKey(userId))) === 1;
  } catch (err) {
    logger.error(
      `Risk limit flag read failed for ${userId} (${riskLimitFlagKey(userId)}): ${String(err)} — fail-open (按无旗)`,
    );
    return false;
  }
}

/**
 * 单 IP 的滑动窗口（§5.4 第五维 / N13 / R453）。**判定与记账在同一个函数里**，
 * 理由与 `hitHttpLimit` 逐字相同（分成两个函数就会有调用方「只判不记」）。
 *
 * ⚠️ 名字里的 `is` 有点名不副实：它**有副作用**（命中前会 `ZADD` 记账）。
 * 与 `hitHttpLimit` 的分工是：那个记**已认证用户**，这个记**IP**。
 *
 * @returns `true` = **超限，必须拒绝**。
 */
export async function isIpRateLimited(
  redis: Redis,
  ip: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = httpIpRateLimitKey(ip);
  await redis.zremrangebyscore(key, 0, now - HTTP_IP_RATE_LIMIT.windowMs);
  const count = await redis.zcard(key);
  if (count >= HTTP_IP_RATE_LIMIT.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(HTTP_IP_RATE_LIMIT.windowMs / 1000));
  return false;
}

/**
 * 该 IP 的**登录失败桶**是否已达界（片⑦ T10 / spec F5）。
 *
 * ⚠️ **只读** —— 与 `hitHttpLimit` 家族的「判定与记账必须同一个函数」纪律的关系：
 * 那条纪律防的是「调用方只判不记」；这里记账由中间件的**响应 finish 钩子**驱动
 * （401 ⇒ 计、200 ⇒ 清），判定发生在**请求入口**而记账发生在**响应出口**，
 * 物理上不可能同函数 —— 判定与记账的**配对**改由中间件的分支逻辑保证（判据在
 * `test/http-rate-limit.test.ts` 的 T10 一组里：同时钉住「第 6 次入口即拒」与
 * 「401 真的计、200 真的清」）。
 *
 * 达界判定用 `>= max`：第 5 次失败入账后，**第 6 次请求入口即拒**。
 *
 * @returns `true` = **已达界，必须拒绝**（此时正确口令也拒绝 —— 检查在比较之前）。
 */
export async function isAdminLoginBlocked(redis: Redis, ip: string): Promise<boolean> {
  const raw = await redis.get(adminLoginFailKey(ip));
  const count = raw === null ? 0 : Number(raw);
  return Number.isFinite(count) && count >= ADMIN_LOGIN_FAIL.max;
}

/**
 * 记一次登录失败（`INCR` + **首次** `PEXPIRE`）。
 *
 * 固定窗口：窗口从**第一次失败**起算、**不被后续失败顺延** —— 每次都续期的话，
 * 持续爆破能把窗口无限延长，「锁定」反而成了攻击者的工具面。TTL 兜底防泄漏
 * （进程崩溃后桶不清理 ⇒ 该 IP 在窗口内被永久拒绝）。
 */
export async function recordAdminLoginFailure(redis: Redis, ip: string): Promise<void> {
  const key = adminLoginFailKey(ip);
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, ADMIN_LOGIN_FAIL.windowMs);
}

/** 登录成功后清零（spec F4 逐字：「失败计次、**成功清零**」）。 */
export async function clearAdminLoginFailures(redis: Redis, ip: string): Promise<void> {
  await redis.del(adminLoginFailKey(ip));
}

/** 代理登录失败桶的键（与 admin 桶键独立）。 */
function agentLoginFailKey(ip: string): string {
  return `ratelimit:agent-login-fail:${ip}`;
}

export async function isAgentLoginBlocked(redis: Redis, ip: string): Promise<boolean> {
  const raw = await redis.get(agentLoginFailKey(ip));
  const count = raw === null ? 0 : Number(raw);
  return Number.isFinite(count) && count >= AGENT_LOGIN_FAIL.max;
}

export async function recordAgentLoginFailure(redis: Redis, ip: string): Promise<void> {
  const key = agentLoginFailKey(ip);
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, AGENT_LOGIN_FAIL.windowMs);
}

export async function clearAgentLoginFailures(redis: Redis, ip: string): Promise<void> {
  await redis.del(agentLoginFailKey(ip));
}

/**
 * 管理写桶的滑动窗口（片⑦ T10，按令牌指纹）—— 照 `hitHttpLimit` 的 ZSET 形态
 * （清窗外 → `ZCARD` 判定 → `ZADD` 记账，**判定与记账在同一个函数里**，理由逐字相同：
 * 分成两个函数就会有调用方「只判不记」）。member 用 `now-随机` 的理由也逐字相同。
 *
 * @returns `true` = **超限，必须拒绝**。
 */
export async function hitAdminWrite(
  redis: Redis,
  tokenFp: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = adminWriteKey(tokenFp);
  await redis.zremrangebyscore(key, 0, now - ADMIN_WRITE.windowMs);
  const count = await redis.zcard(key);
  if (count >= ADMIN_WRITE.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(ADMIN_WRITE.windowMs / 1000));
  return false;
}

/**
 * 占用一条「单 IP 并发连接」名额。
 *
 * @returns `false` = 超限 ⇒ 调用方**拒绝握手**（不是排队、不是静默放行）。
 */
export async function acquireWsConnSlot(
  redis: Redis,
  ip: string,
  socketId: string,
): Promise<boolean> {
  const key = wsConnRateLimitKey(ip);
  const count = await redis.zcard(key);
  if (count >= WS_CONN_LIMIT.max) return false;
  await redis.zadd(key, Date.now(), socketId);
  await redis.expire(key, WS_CONN_LIMIT.ttlSeconds);
  return true;
}

/** 释放名额（`disconnect` 时调用）。没占到名额的 `ZREM` 是 no-op，因此天然幂等。 */
export async function releaseWsConnSlot(redis: Redis, ip: string, member: string): Promise<void> {
  await redis.zrem(wsConnRateLimitKey(ip), member);
}

/** 心跳续期：不续期的话 TTL 兜底会把**长连接**当成崩溃残留删掉（限流被绕过）。 */
export async function touchWsConnSlot(redis: Redis, ip: string): Promise<void> {
  await redis.expire(wsConnRateLimitKey(ip), WS_CONN_LIMIT.ttlSeconds);
}

/**
 * 一条**已占用**的连接名额（R246）。
 *
 * `member` 必须是**承载它的连接**独有的一次性 nonce：engine.io 的 `allowRequest`
 * 发生在握手**之前**，那时还没有 `socket.id`，而 `disconnect` 要用**同一个** member
 * 去 `ZREM`（否则名额只增不减，正常用户用满 5 条后永远连不上）。
 */
export interface WsConnSlot {
  ip: string;
  member: string;
}

/** `allowRequest` 的 `req` 与 socket 的 `request` 是**同一个对象**（engine.io `Socket.request = req`）。 */
const WS_CONN_SLOT = Symbol('ftl.wsConnSlot');

/** 记下这次传输层占用的名额（挂在请求对象上，随连接生命周期走）。 */
export function attachWsConnSlot(req: object, slot: WsConnSlot): void {
  (req as { [WS_CONN_SLOT]?: WsConnSlot })[WS_CONN_SLOT] = slot;
}

/**
 * 取回该连接的名额：`source.request` 就是 `allowRequest` 收到的那份请求。
 *
 * ⚠️ **ip 与 member 都从这一处取**（不在释放侧重新推导 IP）：两处各推导一次就有漂移面
 * （`handshake.address` 与 `req.socket.remoteAddress` 在两种传输下的来源并不逐字相同），
 * 而漂移的症状是**名额泄漏** —— 看不见，只表现为「用久了就连不上」。
 */
export function wsConnSlotOf(source: { request?: unknown } | null | undefined): WsConnSlot | null {
  const req = source?.request;
  if (!req || typeof req !== 'object') return null;
  return (req as { [WS_CONN_SLOT]?: WsConnSlot })[WS_CONN_SLOT] ?? null;
}
