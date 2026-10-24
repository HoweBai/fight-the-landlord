/**
 * 跑得快会话类型（Task 3.1 / spec §4.4）。
 *
 * `PdkSession` 实例化玩法无关基类 `GameSessionBase<Card>`，只把 pdk 专有字段留在本文件：
 * `unusedCards`（2 人局扣牌，**永不出站**）、`lastPlayedHand`（解析结果）、回合计数等。
 */
import type { Card, PdkParsedHand, PdkRulesConfig } from '@fight-the-landlord/protocol';
import type { GamePlayerBase, GameSessionBase } from '../core/session';

/** 跑得快状态机：没有叫抢，只有进行中/结束。 */
export type PdkGameState = 'playing' | 'ended';

export interface PdkPlayer extends GamePlayerBase<Card> {
  /** 本局**实际打出**的牌张数（不含过牌）—— 关牌判定与结算用（spec §5.5）。 */
  playedCount: number;
}

export interface PdkSession extends GameSessionBase<Card> {
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
  state: PdkGameState;
  players: PdkPlayer[];
  /** 开局规则快照（D19：局中改配置不影响进行中的牌局）。 */
  rules: PdkRulesConfig;
  /**
   * 2 人局扣下的第三份 16 张；3/4 人局缺省。
   * ⚠️ **永不出站**（`FORBIDDEN_OUTBOUND_KEYS` 含 `unusedCards`）；仅会话/记录审计。
   */
  unusedCards?: Card[];
  /** 上一手牌的解析结果（跟牌比较用）；首出为 `null`。 */
  lastPlayedHand: PdkParsedHand | null;
  /** 上一手出牌者座位；首出为 `-1`。 */
  lastPlayerIdx: number;
  /** 连续过牌数；等于 `playerCount - 1` 时回到 `lastPlayerIdx` 重新首出。 */
  consecutivePasses: number;
  /** 全场裸四张炸弹数（倍数与视图展示用）。 */
  bombCount: number;
  /** 终局有值：获胜座位（出完手牌者；通常恰一个）。 */
  winnerSeats?: number[];
}

/**
 * `dealPdk` 的输入（Task 3.1 / plan）。
 *
 * `players` 只需座位身份（发牌按 `seat` 索引）；完整 `PdkPlayer` 由 Task 3.3 的
 * `createPdkSession` 组装。
 */
export interface PdkSessionInput {
  roomCode: string;
  playerCount: 2 | 3 | 4;
  baseScore: number;
  rules: PdkRulesConfig;
  players: Array<Pick<PdkPlayer, 'id' | 'seat' | 'isBot'>>;
  /** 可注入随机源（测试确定性；生产为 `Math.random`）。 */
  random: () => number;
  /**
   * 内部测试钩子：固定 48 张牌堆（已按发牌顺序给出，不再洗牌）。
   * 合法性由 `assertPdkDeck` 校验（恰 48 / 合法集 / 无重复）。
   */
  testDeck?: Card[];
}
