import { randomUUID } from 'node:crypto';
import { runWithTrace } from './trace-context';

export const TRACE_ID_HEADER = 'x-trace-id';
export const USER_ID_HEADER = 'x-user-id';

/**
 * REST 入口的 trace 中间件。**不 import `@nestjs/common`**（shared 保持零依赖）——
 * 参数形状就是 Express 的 `(req, res, next)`，五个服务在 `main.ts` 里 `app.use()` 即可。
 *
 * ## 为什么必须把 `next()` 包在 `runWithTrace(...)` 里
 *
 * Express 的中间件链是**同步**的：`next()` 顺着同一调用栈去跑剩下的中间件与路由。
 * 把 `runWithTrace(ctx, next)` 写成「先跑 `next()`、再设上下文」会让**整条链路**都在
 * 上下文之外执行（`currentTrace()` 恒为 `undefined`，日志全部丢掉 traceId）——
 * 而且不会有任何报错，只有真跑起来看日志才发现。ALS 的作用域语义正好使
 * `runWithTrace(ctx, next)` 覆盖后续同步栈（以及其中发起的 await 链）。
 *
 * ## 两处「写回」各回给谁（缺一不可）
 *
 *  - `res.setHeader('X-Trace-Id', …)`：**回给客户端**（R1106）——用户报障时能引用它，
 *    运维凭这一个 id 就能把这次请求在五个服务里的日志串起来；
 *  - `req.headers['x-trace-id'] = traceId`：**回写给转发层** —— 网关的 `headersOf()`
 *    从 `req.headers` 里取 `x-trace-id` 注入下一跳（§5.2 身份头契约）。不写回的话，
 *    客户端没带 id 的请求会「网关自己生成了 id、下游却收不到」⇒ 每一跳各自生成、
 *    链路断裂（同一请求在五个服务里有五个不同的 traceId）。
 *
 * ⚠️ `overwriteExisting: true` 只给**网关**用（R1106：总是生成、**不采信客户端传入值** ——
 * 否则客户端可以用同一个 id 刷满日志来「覆盖/污染」别人的链路）。
 * 网关形态还**不读** `x-user-id`（复核⑩，见函数体里的注释）—— 身份归属是另一份「不可伪造」。
 * 下游服务用缺省（继承上游的 id）。直连下游（不带 `X-Trace-Id`，如 conformance 探针）
 * 时**自建**一个：这不是 R1107 说的「编造」——R1107 禁止的是「**把假 id 当真实来源**」，
 * 而「这条路根本没有上游」时新起一条链才是如实记录。
 */
export function createTraceMiddleware(options: { overwriteExisting?: boolean } = {}) {
  return (
    // 形状就是 Express 的 `req`（`method` 只用来显式标注这是请求对象，中间件不读它）。
    req: { headers: Record<string, unknown>; method?: string },
    res: { setHeader(key: string, value: string): void },
    next: () => void,
  ): void => {
    const incoming = req.headers?.[TRACE_ID_HEADER];
    const inherited = typeof incoming === 'string' && incoming.length > 0 ? incoming : null;
    const traceId = options.overwriteExisting ? randomUUID() : (inherited ?? randomUUID());
    // ⚠️ 复核⑩：网关是**边缘**：客户端自带的身份永不可信 —— 网关形态**不读** `x-user-id`。
    //    本中间件是网关的**第一个** `app.use`，而剥/覆盖身份头的 `JwtMiddleware` 是模块中间件
    //    （Nest init 期才注册、**必然更晚**）⇒ 直读请求头会把**客户端自带**的值写进 ALS：
    //    带 `X-User-Id: 受害者` 的请求**每一行日志**都记成受害者（公开路径上更是任意字符串
    //    直接进日志）—— 那会毁掉本片的目的（定位问题）。
    //    `userId` 只由 `JwtMiddleware` **验签成功之后**用**嵌套** `runWithTrace` 写入；
    //    下游服务（**默认**形态）继续读该头 —— 那里的值来自**网关注入**（N7/R146 的既有契约）。
    const headerUserId = options.overwriteExisting ? null : req.headers?.[USER_ID_HEADER];
    // 回给客户端（R1106）：用户报障时能引用它
    res.setHeader('X-Trace-Id', traceId);
    // 下游服务把 id 写回请求头，`headersOf()` 才能把它转给下一跳
    req.headers[TRACE_ID_HEADER] = traceId;
    runWithTrace(
      { traceId, userId: typeof headerUserId === 'string' ? headerUserId : null, source: 'edge' },
      next,
    );
  };
}
