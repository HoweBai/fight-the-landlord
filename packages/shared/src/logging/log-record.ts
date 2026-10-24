// packages/shared/src/logging/log-record.ts
import { redactText } from './redact';
import type { TraceContext, TraceSource } from './trace-context';

/**
 * ⚠️ 字段集**恰好**这九个（R1102）。沿用 `META_FIELDS` 的成例：
 * 加字段**必须先改判据**（`log-record.test.ts` 的第一条）—— 有人想往日志里塞
 * `hand` 之类的字段时会**撞判据**，而不是悄悄绕过脱敏。
 */
export const LOG_FIELDS = [
  'ts', 'level', 'service', 'context', 'traceId', 'reqId', 'userId', 'source', 'msg',
] as const;

export interface LogRecord {
  /** 应用侧生成（docker 的时间是「收取时刻」，脱离 docker 就没了）。 */
  ts: string;
  level: string;
  service: string;
  context: string;
  traceId: string | null;
  reqId: string | null;
  userId: string | null;
  /**
   * ⚠️ 取值域是 `TraceSource`（**不内联**四值联合）—— 台账 **T1-R1**：内联写法在
   * 加值时**容易漏掉这一处**（`TraceSource` 是唯一真源）；本轮（最终评审 I2）正好
   * 要加第 5 个值 `internal` ⇒ 一并收敛（内联的代价当场兑现，这就是收它的理由）。
   */
  source: TraceSource;
  /** **已脱敏**的正文（R1103：脱敏在序列化**之前**做）。 */
  msg: string;
}

export function buildLogRecord(input: {
  level: string;
  service: string;
  context: string;
  msg: string;
  ctx?: TraceContext;
}): LogRecord {
  const ctx = input.ctx;
  // ⚠️ 逐字段写死（不用 spread）：`LOG_FIELDS` 的「恰好」判据就是靠这里保证的。
  return {
    ts: new Date().toISOString(),
    level: input.level,
    service: input.service,
    context: input.context,
    traceId: ctx?.traceId ?? null,
    /**
     * **最终评审 I1 / 判据 13②**：`reqId` 是**客户端可控**的（WS 消息自带，见
     * `message.router.ts`）⇒ 这一格必须过脱敏器，否则客户端发
     * `reqId:"13912345678"`（或 JWT 形状串）就能把**判据 8 的泄敏采样打成红**
     * （那是本片最关键的回归判据）。
     *
     * 于是「**日志的每一格要么进过脱敏器、要么是服务端可信值**」成为一条可对外的
     * 不变量：`userId` 来自**已验证**的身份（`jwt.middleware` / 握手），`traceId` 是
     * **我们生成**的 uuid（R1106：客户端传入的一律覆盖）—— 只有 `reqId` 这一格
     * 直接来自客户端。
     */
    reqId: ctx?.reqId != null ? redactText(ctx.reqId) : null,
    userId: ctx?.userId ?? null,
    source: ctx?.source ?? 'bootstrap',
    msg: input.msg,
  };
}
