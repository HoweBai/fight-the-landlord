/**
 * §3.1 的 `Room.timeoutAt` —— **`waiting` 状态的超时时刻**。
 *
 * ⚠️ 它**不是**对局计时器（对局计时器是 `GameSession.turnDeadlineAt`）。
 * 本文件是这个等待窗口的**唯一**实现：常量、写入侧、读取侧判据都在这里，
 * 免得「30 秒」在三个地方各写一遍（本仓已有前科：同一语义两处实现必然漂移）。
 *
 * 与 §8.4 的 30s 补位窗口**同值但不是同一个东西**：那条是匹配成功后等补位机器人的
 * 窗口，与「房间在 `waiting` 状态最多等多久」无关，因此**不得**互相 import。
 */
export const WAITING_TIMEOUT_MS = 30_000;

/** 写入侧：`waiting` 房间的超时时刻（`create()` 用它）。 */
export const waitingTimeoutAt = (now: number): number => now + WAITING_TIMEOUT_MS;

/**
 * 读取侧：**只有** `waiting` 且已越过 `timeoutAt` 才算过期。
 *
 * 终态（`playing`/`finished`/`cancelled`）的房间永不过期 —— `updateStatus()` 会把
 * `timeoutAt` 置 0 表示「窗口已关闭」，但这里**不能**依赖那个 0：状态本身才是判据。
 */
export const isWaitingExpired = (
  room: { status: string; timeoutAt: number },
  now: number,
): boolean => room.status === 'waiting' && now >= room.timeoutAt;

// ─── 手动房间的补位死线（本片 · spec §3.1 / R903–R914）────────────────────

/**
 * 手动房间**先等**多久（用户裁决：等 20 秒）。
 *
 * ⚠️ **与 `WAITING_TIMEOUT_MS` / `BOT_FILL_WAIT_MS` 同族但不同物，三者不得互相 import**：
 *  - `WAITING_TIMEOUT_MS`：**匹配路径**的房间在 `waiting` 最多待多久（消费者：回收任务 ⇒ **删房**）；
 *  - `BOT_FILL_WAIT_MS`：匹配**队列**等人等多久后补机器人（消费者：匹配扫描器）；
 *  - 本组：**手动房间**等人等多久后补机器人（消费者：**自动开局扫描器**）。
 * 它们的值恰好相近是**巧合**，语义各不相同。
 */
export const MANUAL_FILL_MIN_WAIT_MS = 20_000;

/** 之后在这段窗口内**均匀随机**取一点补位（用户裁决：「再 10 秒内的随机时间」）。 */
export const MANUAL_FILL_SPREAD_MS = 10_000;

/**
 * 补位死线的**上界**（= 20 + 10）。
 *
 * ⚠️ 它不是「等待时长」—— 死线是随机的，这只是它的**上界**，给下面那条不变量用。
 */
export const MANUAL_FILL_MAX_WAIT_MS = MANUAL_FILL_MIN_WAIT_MS + MANUAL_FILL_SPREAD_MS;

/**
 * 🔴 **手动房间的回收窗口**（spec §4 的硬不变量：本值 **必须 > `MANUAL_FILL_MAX_WAIT_MS`**）。
 *
 * 补位死线落在 [20s, 30s]，而「补位 + `game.start`」还要花时间 ⇒ 若回收窗口也是 30s，
 * 死线取到 30s 附近的那批房间会在**正要补位时被回收任务删掉**
 *（`isWaitingExpired` 是无条件删，它不看「是不是正要补位」）。
 * ⇒ 多留 10 秒：**补位永远早于回收**。
 *
 * ⚠️ 两个值刻意放在**同一个文件**里，就是为了让这条不变量**读得出来**：
 * 改任何一个都必须回头看另一个。
 */
export const MANUAL_ROOM_TIMEOUT_MS = MANUAL_FILL_MAX_WAIT_MS + 10_000;

/**
 * 抽一次手动房间的补位死线。
 *
 * ⚠️ **随机源必须注入**（R914）：否则「死线落在 [20,30] 秒」这条**判不了**
 *（直接断言随机值必然 flaky）。⚠️ 抽出来的值**要落盘**（`room:{code}:fillat`）——
 * 每轮扫描现抽会让同一个房间的死线**漂移**，玩家等多久将取决于它被扫到几次。
 */
export const manualFillDeadlineAt = (now: number, random: () => number): number =>
  now + MANUAL_FILL_MIN_WAIT_MS + Math.floor(random() * MANUAL_FILL_SPREAD_MS);
