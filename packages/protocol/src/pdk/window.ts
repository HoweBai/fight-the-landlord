/**
 * 跑得快出站 `recentActions` 的窗口大小（2026-10-25 4 人场）。
 *
 * 语义：窗口必须容纳「一次真实出牌 + 其余所有玩家过牌」——
 *   - 2 人：2（沿用旧窗口）；
 *   - 3 人：2（沿用旧窗口）；
 *   - 4 人：3（A 出、B/C 过、轮到 D 时仍能看到 A 的目标）。
 *
 * 4 人「A 出、B/C/D 全过」后轮到 A：窗口只剩三次过牌，此时 A 本就该首出，
 * 不需要目标 —— 因此 playerCount − 1 足够。
 *
 * ⚠️ 本文件**不 import 任何模块**（叶子）：`validate.ts` 与 `views.ts` 都会引它，
 * 放在 views.ts 会形成 views↔validate 的运行时环。
 */
export function pdkRecentActionsWindow(playerCount: number): number {
  return Math.max(2, playerCount - 1);
}
