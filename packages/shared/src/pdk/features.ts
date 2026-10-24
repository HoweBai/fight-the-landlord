/**
 * 跑得快机器人公开特征（Task 3.5 / spec §4.8 + §9.5）。
 *
 * 只投影**全体玩家可见**的信息：
 *  - 上一手牌（规则字段 + 点数 + `wingMode` 形状）；
 *  - 按座位的剩余张数、已打出的牌（按出牌顺序）、动作序列；
 *  - 连续过牌数、炸弹数、`canPass`、本局规则快照。
 *
 * ⚠️ **绝不包含**任何人的手牌或 2 人局扣牌（`unusedCards`）：机器人自己的手牌在
 * `RobotDecideRequest.view.hand`；扣牌仅存会话/记录审计（D43）。
 */
import type { PdkRobotFeatures } from '@fight-the-landlord/protocol';
import type { PdkSession } from './types';

function seatIndexOf(session: PdkSession, seat: number): number {
  if (!Number.isInteger(seat) || seat < 0 || seat >= session.playerCount) {
    throw new Error(`seat ${String(seat)} is out of range 0..${session.playerCount - 1}`);
  }
  const index = session.players.findIndex((p) => p.seat === seat);
  if (index === -1) throw new Error(`pdk session is missing a player at seat ${seat}`);
  return index;
}

/** 投影本局公开特征（纯读；不调用规则引擎、不看手牌）。 */
export function buildPdkFeatures(session: PdkSession, seat: number): PdkRobotFeatures {
  seatIndexOf(session, seat);

  const numCardsLeft = new Array<number>(session.playerCount).fill(0);
  for (const player of session.players) {
    if (!Number.isInteger(player.seat) || player.seat < 0 || player.seat >= session.playerCount) {
      throw new Error(`pdk session has a player at invalid seat ${String(player.seat)}`);
    }
    numCardsLeft[player.seat] = player.hand.length;
  }

  const playedCards: number[][] = Array.from({ length: session.playerCount }, () => []);
  const actionSeq: number[][] = [];
  for (const entry of session.actionLog) {
    if (!Number.isInteger(entry.seat) || entry.seat < 0 || entry.seat >= session.playerCount) {
      throw new Error(`pdk session actionLog has invalid seat ${String(entry.seat)}`);
    }
    if (entry.kind === 'play') {
      const ranks = entry.cards.map((c) => c.r);
      actionSeq.push(ranks);
      playedCards[entry.seat]!.push(...ranks);
    } else {
      actionSeq.push([]);
    }
  }

  let lastMove: PdkRobotFeatures['lastMove'] = null;
  if (session.lastPlayedHand !== null) {
    // 上一手必然对应最后一条 play 记录（过牌不改变它）。
    const lastPlay = [...session.actionLog].reverse().find((entry) => entry.kind === 'play');
    if (!lastPlay) {
      throw new Error('pdk session has lastPlayedHand but no play action in its log');
    }
    lastMove = {
      ...session.lastPlayedHand,
      cards: lastPlay.cards.map((c) => c.r).sort((a, b) => a - b),
    };
  }

  return {
    gameType: 'paodekuai',
    seat,
    lastMove,
    numCardsLeft,
    playedCards,
    actionSeq,
    passCount: session.consecutivePasses,
    bombCount: session.bombCount,
    // 跟牌时可过；首出（lastPlayedHand === null）或自己就是最后出牌者时不可过。
    canPass: session.lastPlayedHand !== null && session.lastPlayerIdx !== seat,
    pdkRules: session.rules,
  };
}
