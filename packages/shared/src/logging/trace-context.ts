// packages/shared/src/logging/trace-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 本行的**来源类别**（R1107 的取值域，五选一，**不得**再少）：
 *  - `edge`：HTTP 边缘请求、**WS 连接生命周期**（连接 / 断开 / 续期 / 拒握手），
 *    或下游从 `X-Trace-Id` / 握手 `auth.traceId` 继承
 *  - `rpc`：由一次 RPC 调用带入（**meta 有没有值都算** —— 我在处理一次 RPC，这就是来源）
 *  - `timer`：定时器自己起的一轮（扫描器 / 回合计时器）
 *  - `internal`：**内部事件触发**（Redis 订阅 / 进程内回调），没有对应的客户端请求 ⇒
 *    无已知来源、**不编造** id（**最终评审 I2 新增的第 5 个值**：此前这一格缺失，
 *    `bootstrap` 事实上被当成了「未知来源」的兜底 —— 与它自己的定义「进程启动早期」
 *    冲突，是一句假话）
 *  - `bootstrap`：**进程启动早期**，任何来源都还没有（其原义，**不得**当兜底用）
 *
 * ⚠️ 取值域是**运行期**常量（唯一真源，类型由它派生）：加值必须同时改 `TRACE_SOURCES`
 * 与判据（`trace-context.test.ts` 钉住「恰好五个」）—— 与 `LOG_FIELDS` 的
 * 「加字段必须先改判据」同一纪律（规格 §2 / 最终评审 I2）。
 */
export const TRACE_SOURCES = ['edge', 'rpc', 'timer', 'internal', 'bootstrap'] as const;

export type TraceSource = (typeof TRACE_SOURCES)[number];

export interface TraceContext {
  /** ⚠️ `null` 是**合法值**（R1107：无来源不编造，绝不拿一个假 id 冒充） */
  traceId: string | null;
  /** 操作级 id（WS 消息自带的 `reqId`；HTTP 无则 null） */
  reqId?: string | null;
  userId?: string | null;
  source: TraceSource;
}

/** 全局唯一实例。⚠️ 只在 `runWithTrace()` 里写，别处一律只读。 */
const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 当前上下文；**不在任何 `runWithTrace` 里 ⇒ `undefined`**（调用方据此渲染 `null` + source）。 */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}
