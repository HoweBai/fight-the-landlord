// packages/robot-service/src/rpc/to-result.ts
import { ErrCode, type RpcMeta, type RpcResult } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';

/**
 * R220：把任意抛错收敛成跨 RPC 边界的**显式信封**（**与 game-service 的同名文件各自一份**）。
 *
 * 为什么不放进 `shared`：它是 **Nest 微服务层**的细节（「RPC 边界怎么传错误码」），
 * 而 `shared` 是玩法/规则层。把它塞进去会让 `packages/shared` 依赖
 * `@fight-the-landlord/protocol` 的错误码**之外**还要背 RPC 语义，
 * 而恰恰 `shared` 被前端间接依赖（Global Constraint：前端只依赖 `protocol`）。
 * 两个服务各自 15 行，比一个错位的共享层便宜。
 *
 * 为什么不用 Nest 的 `RpcException`：它在客户端侧只剩 `message`/`status`（**字符串**），
 * 而本仓的硬性约束是「错误码必须是 5 位数字、调用方按码分流」。
 * 因此 handler **不抛**业务错误，只返回 `{ok:false, code, message}`。
 *
 * ⚠️ **判据 7 的接收侧半边（R1107）**：`meta` 是 Task 11 在**发送侧**附上的
 * `RpcMeta`（`metaFromTrace()` 的产物，省略语义：无 ALS 时**整个键不出现**）；
 * 这里把它恢复成 ALS 上下文，好让**处理期间**的日志（含 `catch` 里的）落在
 * 调用方那条链上。`shared` 的 `runWithTrace` 是同一个 ALS 实例，
 * 所以接收侧打的日志与发送侧的 id 逐字同源。
 *
 * ⚠️ **台账 T12-M2 / 最终评审 M2**：参数类型是 protocol 的 **`RpcMeta`**（不是内联形状）——
 * 内联复刻是**第二份真源**：将来 `RpcMeta` 加字段时，接收侧会因为「宽类型赋窄类型」而
 * **静默丢弃**那个字段（TS 不报错、单测看不见）。收紧之后，加字段会当场**编译**提醒。
 */
export async function toResult<T>(
  fn: () => Promise<T>,
  meta?: RpcMeta,
): Promise<RpcResult<T>> {
  // ⚠️ 处理期间的一切日志都挂在这条链上；**没有 meta 也不编造**（R1107）——
  //    这时 traceId 是 null，但 source 仍是 `rpc`（"我在处理一次 RPC"，这就是来源）。
  // ⚠️ 包裹点必须在 `try/catch` **外面**：失败那次调用也要带上下文（`fn()` 自己打的
  //    行、以及下面 `catch` 分支后续的日志），否则「出错的那条链」恰好没有 id。
  return runWithTrace(
    {
      traceId: meta?.traceId ?? null,
      reqId: meta?.reqId ?? null,
      userId: meta?.userId ?? null,
      source: 'rpc',
    },
    async () => {
      try {
        return { ok: true as const, data: await fn() };
      } catch (err: unknown) {
        const code = (err as { code?: number } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, code: (code ?? ErrCode.ILLEGAL_ACTION) as ErrCode, message };
      }
    },
  );
}
