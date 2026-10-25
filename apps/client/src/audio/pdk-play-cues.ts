/**
 * 跑得快牌型 → 播报 cue（2026-10-25，复用斗地主素材）。
 *
 * 为什么不直接用 `cueForPlay`（ddz 的 `parseHand`）：
 *  - 跑得快连对最少 **2 对**，斗地主要求 **≥3 对** ⇒ 2 对连对会被判 Invalid 静音；
 *  - 顺子/连对/飞机的 `keyRank` 取**最大**点数（斗地主取最小），规则判定不能混用；
 *  - 牌型开关由 `pdkRules` 决定（裸三张/三带二/裸飞机/四带二/对子带牌）。
 * 本模块只共享「点数 → 素材」映射（`play-cues.ts` 的 rank helper）。
 *
 * 绝不抛：音频层不得把牌桌打崩。
 */
import {
  PdkHandType,
  parsePdkHand,
  type Card,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';
import { cueForPairRank, cueForSingleRank, cueForTrioRank } from './play-cues';
import type { CueName } from './cues';

/** 跑得快能复用的斗地主语音（王/王炸/叫抢不在其中）。 */
export function cueForPdkPlay(
  cards: Card[],
  rules: PdkRulesConfig | null | undefined,
): CueName | null {
  if (!Array.isArray(cards) || cards.length === 0 || !rules) return null;

  let parsed: ReturnType<typeof parsePdkHand>;
  try {
    parsed = parsePdkHand(cards, rules);
  } catch {
    return null;
  }

  switch (parsed.type) {
    case PdkHandType.Single:
      return cueForSingleRank(parsed.keyRank);
    case PdkHandType.Pair:
      return cueForPairRank(parsed.keyRank);
    case PdkHandType.Trio:
      return cueForTrioRank(parsed.keyRank);
    case PdkHandType.TrioWithSingle:
      return 'TrioWithSingle';
    case PdkHandType.TrioWithPair:
      return 'TrioWithPair';
    case PdkHandType.FourWithTwo:
      return 'FourWithTwo';
    case PdkHandType.Straight:
      return 'Straight';
    case PdkHandType.ConsecutivePairs:
      return 'PairStraight';
    case PdkHandType.Airplane:
    case PdkHandType.AirplaneWithWings:
      return 'Plane';
    case PdkHandType.Bomb:
      return 'Bomb';
    default:
      return null;
  }
}
