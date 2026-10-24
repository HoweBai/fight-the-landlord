/**
 * 「与超时哨兵竞速」的**纯函数**工具（本片 2026-10-12 新增）。
 *
 * ## 为什么它是独立文件，而不是写在 `table.vue` 里
 *
 * 牌桌区有一条纪律闸（§9.6「UI 层不新造时钟」）：`table-bid-ui.test.ts` 的 R675 与
 * `animations.test.ts` §8 对 `src/pages/table/**` 与 `src/components/**` 的**剥注释源码**
 * 全文扫描 `setTimeout` / `setInterval`，**没有豁免清单**。闸自己的注释写明唯一逃生口：
 * 「页面唯一被允许的时钟是 `composables/useCountdown` —— 它**不在扫描面上**，由 `table.vue`
 * **消费**」⇒ 牌桌需要「限时等待」时，**计时器本体放这里**、页面只消费（`useCountdown` 同形），
 * 而不是在页面里塞一个裸 `setTimeout`（那会当场打红两条闸）。
 *
 * ## 它是什么、不是什么
 *
 * 它是一个**等待上限**（网络 ack 的本地兜底），**不是游戏时钟**：
 *  - 不做任何规则判断（F06 原样成立——超时与否只影响「等不等下去」，不影响任何对局语义）；
 *  - 不读、不写任何 store；纯 `Promise` 语义。
 *
 * ## 语义（调用方对齐这三条）
 *
 *  ① `promise` 先结算 ⇒ 原样透传它的结果（含**拒绝**——调用方自己决定要不要 `.catch`）；
 *  ② `ms` 毫秒内未结算 ⇒ 以**字符串哨兵** `'timeout'` 结算（`T` 因此**不得**包含字面量
 *    `'timeout'`，否则与真实结果不可区分）；
 *  ③ `promise` 胜出时**清掉**未到期的计时器（不留悬空句柄——与 `net/socket.ts` 的
 *    safetyTimer 收尾同纪律）。
 *
 * ⚠️ 本仓对它的**唯一消费者**是 `pages/table/table.vue` 的 `doLeave()`（`room.leave`
 * 的 5s 本地超时，规格 §0.3-7/§2.5）——服务端 ack 丢失时发送层没有安全时钟
 * （`sendQueued` 只挂 CAS / 快照类），必须由调用方自备上限。
 */

/** 超时哨兵。调用方以 `outcome === 'timeout'` 判超时（见文件头的对齐三条 ②）。 */
export type RaceTimeoutSentinel = 'timeout';

/**
 * 让 `promise` 与一个 `ms` 毫秒的超时哨兵竞速。
 *
 * ```ts
 * const outcome = await raceTimeout(sendLeave(), 5000); // => 结果 | null | 'timeout'
 * if (outcome === 'timeout') { … }                      // 本地超时分支
 * ```
 *
 * @param promise 被等待的 promise（其拒绝会原样透传给调用方）。
 * @param ms      等待上限（毫秒）。
 */
export function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | RaceTimeoutSentinel> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RaceTimeoutSentinel>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    // promise 胜出（或拒绝）时清掉未到期的计时器；已经烧完的（超时胜出）清是 no-op。
    if (timer !== null) clearTimeout(timer);
  });
}
