// packages/shared/src/logging/rpc-meta.ts
import { currentTrace } from './trace-context';
// ✅ 依赖方向已核：`packages/shared` 本来就依赖 `@fight-the-landlord/protocol`
// （`shared/package.json`，且 `shared/src/ddz/features.ts` 已在用它的类型）⇒ 直接引**真类型**，
// 不用结构化替代品（替代品会与 `RpcMeta` 分叉，而分叉正是本仓反复记过的那类缺陷）。
import type { RpcMeta } from '@fight-the-landlord/protocol';

/**
 * **RPC 发送侧**的元数据片段（R1104 的载体 / R1105 的省略语义）—— 三个 client 共用一份。
 *
 * 用法：`this.proxy.send(pattern, { ...payload, ...metaFromTrace() })`
 *  - ALS 里有 traceId ⇒ 展开后**多出** `meta: {traceId[, reqId][, userId]}`；
 *  - 没有（或 `traceId: null`，R1107 的合法降级值）⇒ 展开 `{}` ⇒ **整个键不出现**。
 *
 * ⚠️ **为什么返回值是「片段」而不是 `RpcMeta | undefined`**：省略语义要的是载荷里
 * **键的在与不在**（`meta: undefined` 会让既有「逐字载荷」断言全红 —— 它们跑在无 ALS
 * 的单测里），而 `{...{}, ...undefined}` 恰好不会加键、`{...{}, ...{meta: undefined}}` 会。
 * 片段形态让「不加」这件事由**展开**承担，调用点因此不需要 `if`。
 *
 * ⚠️ `source` **不进** `RpcMeta`（它不是协议字段）：来源类别是**本地**日志行的归属，
 * 收方按 R1107 自己写 `source: 'rpc'`（"我在处理一次 RPC，这就是来源"）。
 */
export function metaFromTrace(): { meta?: RpcMeta } {
  const ctx = currentTrace();
  // `!ctx?.traceId` 同时盖住两种形态：不在任何 `runWithTrace` 里（undefined）、
  // 以及上下文里 traceId 为 **null**（R1107：无来源不编造，绝不拿一个假 id 冒充）。
  if (!ctx?.traceId) return {};
  return {
    meta: {
      traceId: ctx.traceId,
      // ⚠️ reqId/userId **有值才出现**（与 `RpcMeta` 的可选字段逐字对齐）：
      // 塞 `undefined` 会让「收方看到的就是发方有的」这条判断多出一个空键。
      ...(ctx.reqId ? { reqId: ctx.reqId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    },
  };
}
