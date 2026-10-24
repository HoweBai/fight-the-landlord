/**
 * 跑得快回合流转与胜负（Task 3.3 / spec §5.3 + §5.5）。
 *
 * 纯函数：输入会话 → 新会话（不修改入参）。规则统一走 `protocol/pdk/rule`：
 * 本文件**不重新实现**牌型/比较（客户端 hint、autoplay、bot 共用同一份）。
 *
 * 回合口径：
 *  - 首出不可过牌；跟牌可过；其余玩家都过后回到最后出牌者重新首出；
 *  - 出牌后 `currentPlayer = (seat + 1) % playerCount`；
 *  - 任一玩家手牌为 0 ⇒ 立即结束（`state=ended`、`winnerSeats`、`finishedAt`）。
 */
import {
  PdkHandType,
  canBeatPdk,
  parsePdkHand,
  type Card,
  type PdkParsedHand,
} from '@fight-the-landlord/protocol';
import { dealPdk, resolveFirstLeader } from './deal';
import { chooseLeadPdk, findSmallestBeatingPdk } from './autoplay';
import type { PdkPlayer, PdkSession, PdkSessionInput } from './types';

function findPlayerIndex(session: PdkSession, playerId: string): number {
  const idx = session.players.findIndex((p) => p.id === playerId);
  if (idx === -1) throw new Error(`Player ${playerId} not found`);
  return idx;
}

function assertPlaying(session: PdkSession): void {
  if (session.state !== 'playing') throw new Error('Game is not in playing state');
}

/**
 * 新建一局（发牌 + 首出者 + 初始快照）。
 *
 * `version` 从 1 起（与斗地主 `createSession → dealCards` 的产物同口径）；
 * `turnDeadlineAt` 占位 0，由 game-service 在开局/每次回合转移时写入。
 */
export function createPdkSession(input: PdkSessionInput): PdkSession {
  // dealPdk 同时校验 players 座位/人数与 testDeck 合法性。
  const dealt = dealPdk(input);
  const ordered = [...input.players].sort((a, b) => a.seat - b.seat);
  const players: PdkPlayer[] = ordered.map((p) => ({
    id: p.id,
    seat: p.seat,
    // 冻结副本：发牌结果与 `initialHands` 不共享数组
    hand: [...dealt.hands[p.seat]!],
    isBot: p.isBot,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    playedCount: 0,
  }));
  const leader = resolveFirstLeader(dealt.hands, input.playerCount, input.random);

  const session: PdkSession = {
    roomCode: input.roomCode,
    gameType: 'paodekuai',
    playerCount: input.playerCount,
    baseScore: input.baseScore,
    state: 'playing',
    players,
    currentPlayer: leader,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    createdAt: Date.now(),
    finishedAt: null,
    rules: input.rules,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    consecutivePasses: 0,
    bombCount: 0,
    initialHands: dealt.hands.map((h) => [...h]),
  };

  // 2 人局：第三份扣牌（永不出站）。3/4 人局不出现该键。
  return dealt.unusedCards
    ? { ...session, unusedCards: [...dealt.unusedCards] }
    : session;
}

/** 按 `(r,s)` **精确**摘牌（返回新数组；找不到 ⇒ 抛错）。 */
function removeExact(hand: readonly Card[], cards: readonly Card[]): Card[] {
  const next = [...hand];
  for (const card of cards) {
    const pos = next.findIndex((c) => c.r === card.r && c.s === card.s);
    if (pos === -1) throw new Error(`Card ${card.r}-${card.s} not in hand`);
    next.splice(pos, 1);
  }
  return next;
}

/**
 * 出牌（首出可任意合法牌型；跟牌必须同型、同 length 且主键更大）。
 *
 * 失败（不是自己回合/牌不在手/牌型非法/压不过）一律抛错，**不产生部分状态**。
 * 出完最后一张 ⇒ 立即 `finishPdk`。
 */
export function handlePdkPlay(
  session: PdkSession,
  playerId: string,
  cards: Card[],
): PdkSession {
  const idx = findPlayerIndex(session, playerId);
  assertPlaying(session);
  if (idx !== session.currentPlayer) throw new Error('Not your turn');

  // 先摘牌（在副本上）再判定：失败路径不触碰 session。
  const hand = removeExact(session.players[idx]!.hand, cards);
  const parsed: PdkParsedHand = parsePdkHand(cards, session.rules);
  if (parsed.type === PdkHandType.Invalid) throw new Error('Invalid pdk hand');

  if (session.lastPlayedHand !== null && session.lastPlayerIdx !== idx) {
    if (!canBeatPdk(parsed, session.lastPlayedHand, session.rules)) {
      throw new Error('Invalid move - cannot beat last hand');
    }
  }

  const version = session.version + 1;
  const players = session.players.map((p, i) =>
    i === idx ? { ...p, hand, playedCount: p.playedCount + cards.length } : p,
  );
  const next: PdkSession = {
    ...session,
    players,
    lastPlayedHand: parsed,
    lastPlayerIdx: idx,
    consecutivePasses: 0,
    currentPlayer: (idx + 1) % session.playerCount,
    // 只有**裸四张炸弹**计数；四带二/AAA 不计。
    bombCount: session.bombCount + (parsed.type === PdkHandType.Bomb ? 1 : 0),
    version,
    actionLog: [
      ...session.actionLog,
      { version, seat: idx, cards: cards.map((c) => ({ ...c })), kind: 'play' as const },
    ],
  };

  return hand.length === 0 ? finishPdk(next, Date.now()) : next;
}

/**
 * 过牌：首出不可过；跟牌可过。其余玩家**都过**后回到最后出牌者重新首出
 *（`lastPlayedHand=null`、`lastPlayerIdx=-1`、`consecutivePasses=0`）。
 */
export function handlePdkPass(session: PdkSession, playerId: string): PdkSession {
  const idx = findPlayerIndex(session, playerId);
  assertPlaying(session);
  if (idx !== session.currentPlayer) throw new Error('Not your turn');
  if (session.lastPlayedHand === null) throw new Error('Cannot pass on the opening lead');
  if (session.lastPlayerIdx === idx) throw new Error('Cannot pass when you last played');

  const version = session.version + 1;
  const passes = session.consecutivePasses + 1;
  const roundOver = passes >= session.playerCount - 1;
  const lastPlayer = session.lastPlayerIdx;

  return {
    ...session,
    lastPlayedHand: roundOver ? null : session.lastPlayedHand,
    lastPlayerIdx: roundOver ? -1 : session.lastPlayerIdx,
    consecutivePasses: roundOver ? 0 : passes,
    currentPlayer: roundOver ? lastPlayer : (idx + 1) % session.playerCount,
    version,
    actionLog: [
      ...session.actionLog,
      { version, seat: idx, cards: [], kind: 'pass' as const },
    ],
  };
}

/**
 * 超时/托管的自动动作（spec §5.7）—— 与规则 bot **共用** `shared/pdk/autoplay`：
 *  - 首出：`chooseLeadPdk` 打最小单张；
 *  - 跟牌：`findSmallestBeatingPdk` 打最小可压；无解则过牌。
 *
 * `rules` 恒取本局快照（`session.rules`）；关牌型后 autoplay 不会产出该牌型。
 */
export function handlePdkTimeout(session: PdkSession): PdkSession {
  assertPlaying(session);
  const idx = session.currentPlayer;
  const player = session.players[idx];
  if (!player) throw new Error(`Player at seat ${idx} not found`);
  if (player.hand.length === 0) throw new Error(`Player ${player.id} has no card to play`);

  if (session.lastPlayedHand !== null && session.lastPlayerIdx !== idx) {
    const beating = findSmallestBeatingPdk(player.hand, session.lastPlayedHand, session.rules);
    return beating !== null && beating.length > 0
      ? handlePdkPlay(session, player.id, beating)
      : handlePdkPass(session, player.id);
  }

  const lead = chooseLeadPdk(player.hand, session.rules);
  if (lead.length === 0) throw new Error(`Player ${player.id} has no card to play`);
  return handlePdkPlay(session, player.id, lead);
}

/** 是否已结束：状态为 ended，或任一玩家手牌为空（任一玩家出完即结束）。 */
export function isPdkFinished(session: PdkSession): boolean {
  return session.state === 'ended' || session.players.some((p) => p.hand.length === 0);
}

/**
 * 补齐终局字段（`state=ended` / `finishedAt` / `winnerSeats`）。
 * 已结束的会话**原样返回**（幂等；runtime 的 isFinished → finish 调用可重复）。
 */
export function finishPdk(session: PdkSession, now: number): PdkSession {
  if (session.state === 'ended') return session;
  const winnerSeats = session.players
    .filter((p) => p.hand.length === 0)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  return { ...session, state: 'ended', finishedAt: now, winnerSeats };
}
