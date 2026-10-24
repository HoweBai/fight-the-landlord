import type { RecentAction } from '@fight-the-landlord/protocol';
import type { GameSession } from './types';

/**
 * 桌面历史牌的**窗口大小**（协议 ④ / 上位 §4.4：「窗口 = 2 手」）。
 *
 * ⚠️ 窗口长度只在这里写一次 —— 别处（组件、判据、mock）一律引用它。
 */
export const RECENT_ACTIONS_WINDOW = 2;

/**
 * 把内部 `actionLog` 投影成出站的 `recentActions`（协议 ④）。
 *
 * **这是本投影的唯一实现。** 真源是 `actionLog`（`handlePlayCards` / `handlePass`
 * 在**每次**状态转移里各追加一条），`design.md` §4.2 的**例外说明**逐字准许
 * 「由 `actionLog` 派生的**公开信息**出站」—— `features.ts` 是同一个手法的第一个实例。
 *
 * 为什么**不**新增 `GameSession.recentActions` 状态：那会与 `actionLog` 记同一段历史
 * ⇒ 第二真源；而且要多三个清理点（`createSession` / `finalizeBidding` / `resetBidding`）。
 * 派生法让 `play.ts` 与 `GameSession` **一个字节不动**，且老会话（Redis 里没有新字段）照样成立。
 *
 * ⚠️ **`cards: null` 是「不出」的显式事实**，不是缺省值。
 * ⚠️ 出站安全性：它只含**已经打出过的牌**（公开信息），**不含任何未出的手牌**。
 */
export function projectRecentActions(session: Pick<GameSession, 'actionLog'>): RecentAction[] {
  return (session.actionLog ?? []).slice(-RECENT_ACTIONS_WINDOW).map((entry) => ({
    seat: entry.seat,
    // `kind === 'pass'` 的 `cards` 恒为 `[]`（§3.2）⇒ 出站时归一成 `null`
    cards: entry.kind === 'pass' ? null : entry.cards,
  }));
}
