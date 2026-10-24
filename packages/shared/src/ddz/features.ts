import type { DdzRobotFeatures } from '@fight-the-landlord/protocol';
import type { GameSession } from './types';

/**
 * 机器人的位置（DouZero 的三家标识）。地主 = `landlord`，其下家 = `landlord_down`，
 * 上家 = `landlord_up`（与 `GameSession.players` 的座位轮转一致）。
 */
export type BotPosition = 'landlord' | 'landlord_down' | 'landlord_up';

/**
 * 座位 → 位置。
 *
 * 地主座位的**唯一来源**是 `players[].isLandlord`，叫抢阶段退回
 * `bidPhase.landlordCandidate`（§3.4-3：两条路径都必须把它落定）；
 * 两者都没有（`state === 'init'` 或正在叫抢）时返回 `null`
 * —— 此时三家尚无位置属性，由调用方决定如何取值。
 */
export function botPositionOf(session: GameSession, seat: number): BotPosition | null {
  const landlord = session.players.find((p) => p.isLandlord && p.seat >= 0 && p.seat <= 2)?.seat;
  const candidate = session.bidPhase?.landlordCandidate ?? -1;
  const landlordSeat = landlord !== undefined ? landlord : candidate >= 0 && candidate <= 2 ? candidate : null;
  if (landlordSeat === null) return null;

  if (seat === landlordSeat) return 'landlord';
  if (seat === (landlordSeat + 1) % 3) return 'landlord_down';
  return 'landlord_up';
}

/**
 * §9.5 / §4.2 的**公开特征**投影 —— 这是 `actionLog` 的**唯一**投影实现（R205/C8）。
 *
 * 产物只含**全体玩家都看得见**的信息：
 *  - 上一手牌与出它的人（`lastPlayedHand` / `lastPlayerIdx` 本就是公开状态）；
 *  - 三家剩余张数（`cardCounts` 级信息）；
 *  - **已经打出过的牌**（由 `actionLog` 按座位归组）与出牌顺序 `actionSeq`。
 *
 * ⚠️ **不得**从这里推导任何**未出**的手牌：`playedCards` 只来自 `actionLog` 的
 * `kind === 'play'` 记录（旧实现 `bot.player.ts` 的 `computePlayedCards()` 用
 * 「总牌堆 − 当前手牌」反推再按 `lastPlayerIdx` 倒序硬分配给三家 —— 那是伪造特征，C8）。
 * ⚠️ 机器人自己的手牌**不在** features 里：它在 `RobotDecideRequest.view.hand`（§9.5 的裁剪视图）。
 */
export function buildPublicFeatures(session: GameSession, seat: number): DdzRobotFeatures {
  const position = botPositionOf(session, seat) ?? 'landlord_down';

  const numCardsLeft: Record<string, number> = {};
  for (const player of session.players) {
    // 叫抢阶段尚无地主 ⇒ 位置未定，但张数是公开的：按座位退化成 `seat{n}`，
    // DouZero 只在出牌阶段被调用（那时位置必然已定），故这个兜底不影响它。
    const pos = botPositionOf(session, player.seat) ?? `seat${player.seat}`;
    numCardsLeft[pos] = player.hand.length;
  }

  const playedCards: DdzRobotFeatures['playedCards'] = {
    landlord: [],
    landlord_down: [],
    landlord_up: [],
  };
  const actionSeq: number[][] = [];

  for (const entry of session.actionLog ?? []) {
    if (entry.kind === 'play') {
      // ⚠️ **这里是 AI 契约的投影边界**（spec §11-6）：`RobotFeatures` 的
      // `playedCards` / `actionSeq` / `lastMove` 是 **DouZero 点数**（`number[]`），
      // 而 `actionLog` / `lastPlayedHand.cards` 现在是 `Card[]`。
      // **必须显式 `.map(c => c.r)` 投影回点数** —— DouZero 上游结构上没有花色
      // （观测是 4×13 的「每个点数有几张」矩阵）。
      // 漏投影时 tsc 会报（`Card` 不能塞进 `number[]`），但**漏了某个字段**不会报
      // ⇒ 改完必须人看一遍这三个字段是否都投影了。
      actionSeq.push(entry.cards.map(c => c.r));
      const pos = botPositionOf(session, entry.seat);
      // 位置未定时**不猜**（旧实现正是靠 `lastPlayerIdx` 硬分配 ⇒ C8）；
      // 叫抢阶段不可能有出牌记录，因此这里实际上不可达。
      if (pos !== null) playedCards[pos].push(...entry.cards.map(c => c.r));
    } else {
      // pass 是空数组（DouZero 的 `card_play_action_seq` 约定）
      actionSeq.push([]);
    }
  }

  return {
    // 多玩法（Task 2.6）：联合类型判别位；斗地主恒 doudizhu。
    gameType: 'doudizhu',
    position,
    // 同上：投影回 DouZero 点数（AI 契约不带花色）
    lastMove: (session.lastPlayedHand?.cards ?? []).map(c => c.r),
    // 协议④的连带面：跟牌目标只带**规则字段**（牌面已在 `lastMove` 里，不重复）
    lastMoveMeta: session.lastPlayedHand
      ? {
          type: session.lastPlayedHand.type,
          keyRank: session.lastPlayedHand.keyRank,
          length: session.lastPlayedHand.length,
        }
      : null,
    lastMovePosition:
      session.lastPlayerIdx >= 0 ? (botPositionOf(session, session.lastPlayerIdx) ?? '') : '',
    numCardsLeft,
    playedCards,
    actionSeq,
  };
}
