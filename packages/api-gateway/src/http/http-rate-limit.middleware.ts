import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { REDIS } from '../auth/session.guard';
import { ADMIN_HEADER, USER_ID_HEADER } from '../auth/identity-headers';
// ⚠️ R462：路径清单与路径派生都来自**单一真源**（与 `JwtMiddleware` 同一份），
// 本文件**不得**再抄一份字面量清单。片⑦ D6①：`isAdminPath` 同源同文件；③ T5：登录路径
// 判定（登录桶）也走共用 `isAdminLoginPath`（与豁免/clientIp 产出同一份判定）。
import { isAdminLoginPath, isAdminPath, isHealthPath, requestPath } from '../auth/public-paths';
import {
  HTTP_RATE_LIMIT,
  THROTTLED_RATE_LIMIT,
  clearAdminLoginFailures,
  hitAdminWrite,
  hitHttpLimit,
  hitPayLimit,
  isAdminLoginBlocked,
  isIpRateLimited,
  isThrottled,
  payLimitBucketOf,
  recordAdminLoginFailure,
} from './rate-limit';
// ③ T5：`clientIp` 的私有实现**平移**到 `trusted-client-ip.ts`（导出 `requestClientIp`）——
// 限流与登录事件（`headersOf()` 的 clientIp）两处共用，防两口径漂移。
import { requestClientIp } from './trusted-client-ip';

/**
 * §5.4 的 HTTP 维度：**单用户** 20 次 / 5 秒（R141）+ **单 IP** 120 次 / 60 秒（N13/R453）。
 *
 * 四条边界写死在实现里，**顺序本身就是契约**（R462）：
 *
 *  0. **健康端点豁免**（最先）：`/api/health` 与 `/api/health/live` 直接放行、**不碰 Redis**。
 *     §2.4/R267/R285 逐字：存活面**不查任何依赖**、恒 200；就绪面自己按 `status` 返 200/503
 *     且响应体是 `{status, service, checks}`。两者都不能被这里改写成 `{code:10007,…}` ——
 *     否则 Redis 一抖，编排层就会去杀一个**完全健康的进程**（R462 的门禁实测：
 *     `slice-07.2-deploy` 的一次性容器 + 无监听 `REDIS_URL` 拿不到存活面）。
 *  1. **IP 维度覆盖未认证路径**：N13 登记的缺口逐字是「登录/注册/刷新无 IP 维度限流
 *     （暴力破解面）」，而这三条路径**永远没有**已认证的 `x-user-id`。因此 IP 判定必须在
 *     下面那条「没有 userId 就放行」的早退**之前** —— 放在之后的话，该维度对它们完全
 *     不可达，N13 名义上关闭、实质上没关。**豁免的只有健康端点**，不是整条中间件。
 *  2. **用户维度只对已认证请求计数**：`x-user-id` 只有 `JwtMiddleware` 验签后才会被写入
 *     （R146 之后客户端自带的值在边缘就被剥掉），因此「有值」⇔「已认证」。未认证路径
 *     **不按用户**计数，否则客户端可以自带 `X-User-Id` 去投毒别人的桶。
 *  3. **Redis 故障 fail closed**（`10007` + 503）：与 R26 的会话白名单同一条理由 ——
 *     「计数不可用就放行」等于把限流变成静默可选开关。**健康端点除外**（见 0）。
 *
 * 顺序约束（见 `app.module.ts`）：本中间件**必须**排在 `JwtMiddleware` 之后，
 * 否则读到的是可被客户端伪造的 `X-User-Id`（R146 之前那是投毒路径）。片⑦ T9 起
 * `AdminAuthMiddleware` 也排在它之前 —— `X-Admin` / `adminTokenFp` 因而都是**验真产物**。
 *
 * ── 片⑦ T10（设计 D6 / spec F5）：admin 分支（在健康豁免之后、既有维度之前）──
 *  - **登录**（`POST /api/admin/login`）：走登录失败桶（5 次 / 5 分钟，**失败计次、
 *    成功清零**，由**响应 finish 钩子**驱动），**跳过**既有 IP 维（本桶更严）；
 *    **桶达界 ⇒ 正确口令也 429**（检查在比较之前 —— 请求根本不转发、口令不会被比较）；
 *  - **持令牌写**（带 `X-Admin: 1` 且 method ∉ {GET, HEAD, OPTIONS} —— ③ T5 从「仅 PUT」
 *    扩边，POST/PATCH/DELETE 等新写面全数并入）：走管理写桶（按令牌指纹 30 次 / 5 分钟），
 *    **跳过**既有 IP 维（写面的可归因主体是令牌，不是 IP）；
 *  - **持令牌但非写**（GET/HEAD/OPTIONS `/api/admin/config`）：**保留**既有 IP 维
 *    （没有更严的桶需要它跳过）；
 *  - **无令牌 / 坏令牌**：在 `AdminAuthMiddleware` 处**立即 401**、**压根到不了本中间件**
 *    —— 显式登记的接受口径（spec F5 的 r1-S-I5：成本低、无放大面。可达性由
 *    `app.module.ts` 的中间件顺序 + T9 的 401-immediate 保证）；
 *  - **其余**（理论上不可达的无令牌类，如无 `X-Admin` 的 PUT）⇒ 落回既有流程。
 *  桶的 Redis 故障同样 **fail closed**（与既有三维同一条理由，见上面 3）。
 *
 * ③ T5 的第二处扩边（spec §2.3）：登录失败判据从「仅 401」扩为「**401 或 403**」——
 * 403（账号停用 / 角色不足）与 401（用户名或口令错）同样是「口令被比较过」的失败信号，
 * 不计数就是给爆破留一条「试到账号停用为止不涨桶」的旁路；200 仍清零、其余仍不计。
 *
 * ── 支付片 T13（规格 §2.4.1 限流脚注）：玩家面写端点三档桶 ──
 *  `POST /api/pay/orders` 10/分 · `POST …/orders/:no/sync` 30/分 · `POST /api/pay/refunds`
 *  与 `POST /api/pay/withdrawals` **各** 5/分（用户维）。照既有维度**并存**（不跳过任何
 *  既有维）：键独立 `ratelimit:pay-*`，**路径判定归一大小写与尾斜杠**（⚙️20 同族——
 *  Express 路由两变体都命中，不归一即绕过专属桶；见 `rate-limit.ts payLimitBucketOf`）。
 *
 * 阈值是**规格值**：`HTTP_RATE_LIMIT` 来自 §5.4 表格，`HTTP_IP_RATE_LIMIT` 来自裁决 R453
 * （§5.4 的第五维已由协调者补进规格表），`ADMIN_LOGIN_FAIL` / `ADMIN_WRITE` 来自片⑦ §2.6，
 * `THROTTLED_RATE_LIMIT`（风控档位）来自风控片 §2.6-1，`PAY_*` 三档来自支付片 §2.4.1。
 * 本文件不持有任何魔法数。
 */
@Injectable()
export class HttpRateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);

    // ① 健康端点豁免（R462）：**不碰 Redis**，直接放行。
    //    在所有 Redis 访问**之前**，也在下面的 `try` 之外。
    //    （与 admin 分支无交集：`/api/health*` 与 `/api/admin/*` 结构上不相交 ⇒ 顺序无关。）
    if (isHealthPath(path)) {
      next();
      return;
    }

    /** admin 分支已给出结论（登录 / 持令牌写）⇒ **不再**走下面的既有维度。 */
    let handledAdmin = false;
    let limited = false;
    try {
      // ② admin 分支（片⑦ T10 / D6 / spec F5）。放在既有维度**之前**：对这两类请求，
      //    「跳过既有 IP 维」就是本例的语义本身（登录有更严的失败桶；写的归因主体是令牌）。
      //    ⚠️ 本段里的 `next()` **不能**就地调用 —— 见方法尾部的纪律说明。
      if (isAdminPath(path)) {
        // 登录桶判定用**原值**精确路径（与豁免、clientIp 产出同一份判定 —— N1/⚙️20 射程：
        // 尾斜杠与大小写变体都在 AdminAuth 处 401/403、压根到不了本中间件；正常登录路径
        // 的计数语义因此不受 ⚙️20 识别归一影响）。
        const isLogin = isAdminLoginPath(path);
        if (isLogin) {
          // 桶达界 ⇒ **检查在比较之前**：直接 429，请求不会被转发、口令永远不会被比较
          // （spec F5 逐字：正确口令也 429 —— 这就是防爆破该有的达界语义）。
          if (await isAdminLoginBlocked(this.redis, requestClientIp(req))) {
            rejectRateLimited(res);
            return;
          }
          // 失败计次 = **响应感知**（finish 钩子）：**401 或 403**（③ T5 扩边）⇒ 计、
          // 200 ⇒ 清、其余不计。钩子里是异步续体（响应可能已经发出）⇒ 失败只能吞掉：
          // 绝不能把异常抛进事件循环。
          res.on('finish', () => {
            const ip = requestClientIp(req);
            void (res.statusCode === 401 || res.statusCode === 403
              ? recordAdminLoginFailure(this.redis, ip)
              : res.statusCode === 200
                ? clearAdminLoginFailures(this.redis, ip)
                : Promise.resolve()).catch(() => {});
          });
          handledAdmin = true;
        } else if (req.headers[ADMIN_HEADER] === '1' && !READ_METHODS.has(req.method)) {
          // ③ T5：写桶条件从「仅 PUT」扩为「持令牌且 method ∉ {GET, HEAD, OPTIONS}」
          // （账号 CRUD 的 POST/PATCH、反冲、对账运行都是写面；阈值/桶/键不变）。
          // `adminTokenFp` 由 `AdminAuthMiddleware` 在验签通过后才挂（验真产物；
          // 单测直接驱动本中间件时可能没有 ⇒ 降级成单一 `unknown` 桶，**仍然计数**，
          // 与「取不到 IP 不等于豁免」同一条纪律）。
          const fp = (req as { adminTokenFp?: string }).adminTokenFp ?? 'unknown';
          if (await hitAdminWrite(this.redis, fp)) {
            rejectRateLimited(res);
            return;
          }
          handledAdmin = true;
        }
        // 其余（持令牌 GET/HEAD/OPTIONS / 理论上不可达的无令牌类）⇒ 落回下面既有维度（IP 维覆盖）。
      }

      if (!handledAdmin) {
        // ③ 维度 5（N13/R453）：单 IP 120/min。**先于**用户维度的早退，理由见类注释 1。
        if (await isIpRateLimited(this.redis, requestClientIp(req))) {
          rejectRateLimited(res);
          return;
        }

        const header = req.headers?.[USER_ID_HEADER];
        const userId = Array.isArray(header) ? header[0] : header;
        if (typeof userId === 'string' && userId.length > 0) {
          // 风控 T7（规格 §2.6-2）：在既有用户维判定处**先读**限流档旗
          // `EXISTS risk:limit:{userId}` —— `isThrottled` **单独 catch ⇒ 按无旗 +
          // error 日志**（F8：旗读故障**不得**落进本 try 的 fail-closed —— 那是
          // **正常限流链自身**的故障语义，两者必须可区分）；命中 ⇒ 以
          // `THROTTLED_RATE_LIMIT` 对**同一键** `ratelimit:http:{userId}` 判定
          //（阈值经 `hitHttpLimit` 参数化，§2.6-4：判定逻辑唯一，键不变）。
          const throttled = await isThrottled(this.redis, userId);
          limited = await hitHttpLimit(
            this.redis,
            userId,
            Date.now(),
            throttled ? THROTTLED_RATE_LIMIT : HTTP_RATE_LIMIT,
          );

          // 支付片 T13（§2.4.1 限流脚注）：玩家面写端点三档桶（下单 10/分 · sync 30/分 ·
          // 申请各 5/分；**用户维**）——与既有维度**并存**（更严的每端点档，键独立
          // `ratelimit:pay-*`；判定与记账仍同函数）。放在既有用户维之后：通用桶已拒的
          // 请求无需再记账；Redis 故障与既有维度同一条 fail-closed（本 try 的 catch）。
          if (!limited) {
            const bucket = payLimitBucketOf(req.method, path);
            if (bucket !== null) {
              limited = await hitPayLimit(this.redis, bucket, userId);
            }
          }
        }
      }
    } catch {
      // ④ Redis 故障 fail closed（10007 + 503）—— admin 两桶也在其中（同一条理由：
      //    「计数不可用就放行」等于把限流变成静默可选开关）。
      res
        .status(503)
        .json({ code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'rate limit store unavailable', data: null });
      return;
    }
    if (limited) {
      rejectRateLimited(res);
      return;
    }
    // ⚠️ `next()` **必须留在 `try` 之外**（**所有**路径共用这一个出口 —— 含 T10 的
    //    admin 分支：`handledAdmin` 只是一个标志，放行动作仍然落到这里）：
    //    它在 Express 里会**同步**进入后续中间件，放进 `try` 会把下游的同步异常吞成
    //    503 `rate limit store unavailable`（假信息）。
    next();
  }
}

/**
 * 超限响应（**唯一**一份实现）：**任何**维度命中时必须是**逐字同形**的 429 信封
 * `{ code, message, data: null }`（§11.2 的 `10006`；片⑦ T10 起四个桶共用它）。
 */
function rejectRateLimited(res: Response): void {
  res.status(429).json({ code: ErrCode.RATE_LIMITED, message: 'Too many requests', data: null });
}

/**
 * ③ T5（spec §2.3）：管理写桶的**非写**方法集合 —— 写桶条件 = `X-Admin==='1'` 且
 * method 不在此列（从「仅 PUT」扩边：POST/PATCH/DELETE 等新写面全数并入）。
 * `HEAD`/`OPTIONS` 与 `GET` 同类（读面不占写桶，落回既有 IP 维）。
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ③ T5：`clientIp(req)` 的私有实现已**平移**到 `trusted-client-ip.ts` 的导出
// `requestClientIp`（限流与登录事件两处共用；派生序 socket.remoteAddress → req.ip →
// 'unknown' 与注释逐字保留在那里）。本文件不得再抄一份 —— 两口径漂移的症状是
// 「限流 IP」与「登录事件 IP」对不上账。
