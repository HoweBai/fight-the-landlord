/**
 * 跑得快视图投影（Task 4.1 / spec §4.5.1）。
 *
 * 这是 pdk 唯一的出站对局类型来源：裁剪规则与斗地主同源 —— 只有接收者自己的 `hand`
 * 是明文，他人手牌只以 `cardCounts[seat]` 出现；`unusedCards`（2 人局扣牌）、
 * `lastPlayedHand`（规则态）、`initialHands`、机器人内部字段**一律不出站**。
 * `canPass`/`bombCount` 由服务端算好（客户端是哑终端，D42）。
 */
import { validateOutbound, type PdkPlayerView } from '@fight-the-landlord/protocol';
import { projectRecentActions } from '@fight-the-landlord/shared';
import type { PdkSession } from '@fight-the-landlord/shared';

function assertSeat(session: PdkSession, seat: number): void {
  if (!Number.isInteger(seat) || seat < 0 || seat >= session.playerCount) {
    throw new Error(`seat must be 0..${session.playerCount - 1}, got ${String(seat)}`);
  }
}

/** 把内部 `PdkSession` 裁剪成接收者视角的 `PdkPlayerView`。 */
export function buildPdkPlayerView(session: PdkSession, seat: number): PdkPlayerView {
  assertSeat(session, seat);
  const player = session.players.find((p) => p.seat === seat);
  if (!player) throw new Error(`pdk session is missing a player at seat ${seat}`);

  const cardCounts = Array.from({ length: session.playerCount }, (_, s) => {
    const atSeat = session.players.find((p) => p.seat === s);
    if (!atSeat) throw new Error(`pdk session is missing a player at seat ${s}`);
    // 机器人座位恒 false（机器人没有治理量；与 ddz 视图同口径）。
    return atSeat.hand.length;
  });
  const trustees = Array.from({ length: session.playerCount }, (_, s) => {
    const atSeat = session.players.find((p) => p.seat === s);
    if (!atSeat) throw new Error(`pdk session is missing a player at seat ${s}`);
    return session.botIds?.[s] !== undefined ? false : atSeat.trustee === true;
  });

  const view: PdkPlayerView = {
    roomCode: session.roomCode,
    gameType: 'paodekuai',
    playerCount: session.playerCount,
    version: session.version,
    state: session.state,
    baseScore: session.baseScore,
    seat,
    hand: player.hand,
    cardCounts,
    trustees,
    currentPlayer: session.currentPlayer,
    recentActions: projectRecentActions(session),
    turnDeadlineAt: session.turnDeadlineAt,
    // 首出（lastPlayedHand === null）或自己就是最后出牌者 ⇒ 不可过牌。
    canPass: session.lastPlayedHand !== null && session.lastPlayerIdx !== seat,
    bombCount: session.bombCount,
    pdkRules: session.rules,
  };
  if (session.state === 'ended' && session.winnerSeats !== undefined) {
    view.winnerSeats = session.winnerSeats;
  }

  // 机械拦住越界出站（与 ddz 同一道闸；消息类型只是复用契约校验器）。
  validateOutbound({ type: 'game.state_update', version: view.version, payload: view });
  return view;
}

/** 按 `session.players` 遍历（不是 `[0,1,2]`）；2/3/4 人不得漏座。 */
export function buildAllPdkViews(session: PdkSession): PdkPlayerView[] {
  return [...session.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => buildPdkPlayerView(session, player.seat));
}
