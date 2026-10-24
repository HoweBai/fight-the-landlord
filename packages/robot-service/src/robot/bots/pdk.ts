/**
 * 跑得快规则 bot（Task 3.6 / spec §5.7）。
 *
 * 首版策略 = **autoplay**（与超时/托管同源）：
 *  - 首出：`chooseLeadPdk`（最小单张）；
 *  - 跟牌：`findSmallestBeatingPdk`（最小可压；无解过牌）。
 *
 * 约束：
 *  - 规则快照取 `features.pdkRules`（RH5，不读 view 的规则字段）；
 *  - 不调用 DouZero（pdk 是规则 bot）；
 *  - 策略产出必须**合法且真实来自 view.hand**；否则回退 autoplay。被 game-service
 *    拒绝的动作由 game-service 回退 autoplay（S4），这里先做客户端侧自检。
 */
import {
  PdkHandType,
  canBeatPdk,
  parsePdkHand,
  type Card,
  type PdkPlayerView,
  type PdkRobotFeatures,
  type RobotDecideRequest,
  type RobotDecideResponse,
} from '@fight-the-landlord/protocol';
import { chooseLeadPdk, findSmallestBeatingPdk } from '@fight-the-landlord/shared';

export type PdkRobotDecideRequest = RobotDecideRequest & {
  view: PdkPlayerView;
  features: PdkRobotFeatures;
};

/** 策略层接缝：首版只有 autoplay；难度/保留炸弹等策略以后可替换。 */
export interface PdkBotStrategy {
  choose(view: PdkPlayerView, features: PdkRobotFeatures): Card[] | null;
}

/** 首版策略 = autoplay（spec §5.7）。 */
export const PDK_AUTOPLAY_STRATEGY: PdkBotStrategy = {
  choose(view, features) {
    return features.lastMove
      ? findSmallestBeatingPdk(view.hand, features.lastMove, features.pdkRules)
      : chooseLeadPdk(view.hand, features.pdkRules);
  },
};

/** 出牌是否真实来自手牌（按 `(r,s)` 多重集）。 */
function isSubsetOfHand(cards: readonly Card[], hand: readonly Card[]): boolean {
  if (cards.length === 0) return false;
  const pool = hand.map((c) => `${c.r},${c.s}`);
  for (const card of cards) {
    const index = pool.indexOf(`${card.r},${card.s}`);
    if (index === -1) return false;
    pool.splice(index, 1);
  }
  return true;
}

/** 合法动作：牌在手里 + 牌型合法 + （跟牌时）能压过上一手。 */
function isLegalMove(
  cards: readonly Card[],
  view: PdkPlayerView,
  features: PdkRobotFeatures,
): boolean {
  if (!isSubsetOfHand(cards, view.hand)) return false;
  const parsed = parsePdkHand([...cards], features.pdkRules);
  if (parsed.type === PdkHandType.Invalid) return false;
  if (features.lastMove) {
    return canBeatPdk(parsed, features.lastMove, features.pdkRules);
  }
  return true;
}

/**
 * 决策（纯函数）：优先策略产出；非法/无产出 ⇒ 回退 autoplay；跟牌仍无解 ⇒ pass。
 *
 * 首出且手牌为空 ⇒ 抛错（对局应已结束，调用方不应驱动机器人）。
 */
export function decidePdkBot(
  req: PdkRobotDecideRequest,
  strategy: PdkBotStrategy = PDK_AUTOPLAY_STRATEGY,
): RobotDecideResponse {
  const { view, features } = req;
  if (features.gameType !== 'paodekuai') {
    throw new Error(`paodekuai decide requires PdkRobotFeatures (bot ${req.botId})`);
  }

  const preferred = strategy.choose(view, features);
  if (preferred !== null && preferred.length > 0 && isLegalMove(preferred, view, features)) {
    return { kind: 'play', cards: preferred.map((c) => c.r), source: 'rule' };
  }

  const fallback = PDK_AUTOPLAY_STRATEGY.choose(view, features);
  if (fallback !== null && fallback.length > 0 && isLegalMove(fallback, view, features)) {
    return { kind: 'play', cards: fallback.map((c) => c.r), source: 'rule' };
  }

  // 跟牌无解 ⇒ 过牌是合法动作（首出不可过）。`view.canPass` 是服务端算好的判据：
  // 「上一手存在但不可过」（畸形/自己就是最后出牌者）时不得直接过牌。
  if (!features.lastMove) {
    throw new Error(`pdk bot has no legal lead (bot ${req.botId})`);
  }
  if (view.canPass) return { kind: 'pass', source: 'rule' };
  throw new Error(`pdk bot has no legal action (bot ${req.botId})`);
}
