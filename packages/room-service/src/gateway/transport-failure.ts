// packages/room-service/src/gateway/transport-failure.ts

/**
 * 传输层故障（连不上 / 超时）时给**调用方**的固定文案（Task 3g 修复 I2）。
 *
 * 🔴 **为什么必须是固定的一句、且必须面向调用方**：`GameServiceError` /
 * `ConfigServiceError` 的消息会经两条路**原样**到客户端 ——
 *  - WS 面：`message.router.ts` 的对应分支照实 ack ⇒ 玩家看到的 toast 是
 *    `[10007] TOAST — <消息>`；
 *  - HTTP 面：`toHttpException` 把 `err.message` 原样放进 `{code,message}` 信封。
 *
 * 修前这里内插的是 `err.message`，而传输故障下它长这样：`ECONNREFUSED 172.28.0.7:3002`、
 * `connect ECONNREFUSED 172.28.0.9:3100`、`Timeout has occurred` —— 全是**内部拓扑/内部细节**。
 *
 * ⚠️ **只替换「传输层故障」的那一条内插**：业务错误（下游 `RpcResult{ok:false}` 信封里的
 * `message`）**逐字保留** —— 那是客户端要显示的业务文案，不是内部详情。
 * ⚠️ 详情**只进日志**：三个 client 在抛之前各打一行 warn（`<服务名> RPC <pattern> failed: …`）
 * —— 不透传 ≠ 不留痕（本仓纪律）。
 *
 * 文案与客户端对 `10007` 的兜底表**逐字相同**（`apps/client/src/net/copy.ts` 与
 * `action-copy.ts` 的 `UPSTREAM_UNAVAILABLE` 行）：服务端给的话与「客户端自己会编的话」
 * 是同一句 ⇒ 玩家看到的东西不因消息从哪来而变。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';
