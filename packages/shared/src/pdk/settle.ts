/**
 * 跑得快结算（Task 3.4 / spec §5.6）。
 *
 * ```text
 * 倍数 = min(cap, 2^炸弹数 × (关牌 ? 2 : 1) × (春天 ? 2 : 1))
 * 输家支付 = 剩余张数 × 底分 × 倍数
 * 赢家所得 = 所有输家支付之和（零和）
 * ```
 *
 * - `bombCount` 只含**裸四张炸弹**（会话字段由 play.ts 维护）。
 * - 关牌：至少一名输家 `playedCount === 0`；春天：所有输家都未出牌（**2 人局不适用**）；
 *   两项默认叠乘（春天时 ×4）。
 * - 保本：`baobenEnabled && remaining === 1` 的输家支付 0；所有输家都保本时赢家所得为 0。
 * - `multiplierCap` 防御性夹到 `1..1024`。
 */
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import type { PdkSession } from './types';

/** 倍率上限（与配置校验范围一致；快照已校验，这里再兜一层）。 */
const MULTIPLIER_CAP_MIN = 1;
const MULTIPLIER_CAP_MAX = 1024;

/**
 * 结算一局（**只对已结束的一局**）：按座位升序返回 `scoreChanges`/`remaining`。
 *
 * 赢家由**实际手牌**确定（恰一名玩家手牌为 0）；未结束或多个赢家 ⇒ 抛错。
 */
export function settlePdk(session: PdkSession): PdkSettlementResult {
  const playerCount = session.playerCount;
  if (session.players.length !== playerCount) {
    throw new Error(
      `pdk settlement requires exactly ${playerCount} players, got ${session.players.length}`,
    );
  }

  const bySeat = new Map(session.players.map((p) => [p.seat, p]));
  const remaining: number[] = [];
  const played: number[] = [];
  for (let seat = 0; seat < playerCount; seat += 1) {
    const player = bySeat.get(seat);
    if (!player) throw new Error(`pdk settlement missing player at seat ${seat}`);
    remaining[seat] = player.hand.length;
    played[seat] = player.playedCount;
  }

  const winnerSeats = remaining
    .map((cards, seat) => (cards === 0 ? seat : -1))
    .filter((seat) => seat >= 0);
  if (winnerSeats.length !== 1) {
    throw new Error(
      `pdk settlement requires exactly one winner (players with 0 cards: [${winnerSeats.join(',')}])`,
    );
  }
  const winnerSeat = winnerSeats[0]!;
  const losers = Array.from({ length: playerCount }, (_, seat) => seat).filter(
    (seat) => seat !== winnerSeat,
  );

  const rules = session.rules;
  const cap = Number.isFinite(rules.multiplierCap)
    ? Math.min(MULTIPLIER_CAP_MAX, Math.max(MULTIPLIER_CAP_MIN, Math.trunc(rules.multiplierCap)))
    : 64;

  // 事实字段与倍率开关分开：关闭翻倍只影响 multiplier，不改变 guan/spring 的真实性。
  const guan = losers.some((seat) => played[seat] === 0);
  const spring = playerCount >= 3 && losers.every((seat) => played[seat] === 0);

  const bombFactor = rules.bombMultiplierEnabled ? 2 ** Math.max(0, session.bombCount) : 1;
  const guanFactor = rules.guanMultiplierEnabled && guan ? 2 : 1;
  const springFactor = rules.springMultiplierEnabled && spring ? 2 : 1;
  const multiplier = Math.min(cap, bombFactor * guanFactor * springFactor);

  const deltas = new Array<number>(playerCount).fill(0);
  const baobenSeats: number[] = [];
  let losersTotal = 0;
  for (const seat of losers) {
    const baoben = rules.baobenEnabled && remaining[seat] === 1;
    if (baoben) baobenSeats.push(seat);
    const delta = baoben ? 0 : -(remaining[seat]! * session.baseScore * multiplier);
    deltas[seat] = delta;
    losersTotal += delta;
  }
  // `-0` 归一：全保本时 losersTotal = 0，`-0` 在序列化/断言层会出怪相。
  deltas[winnerSeat] = losersTotal === 0 ? 0 : -losersTotal; // 零和

  return {
    roomCode: session.roomCode,
    gameType: 'paodekuai',
    playerCount,
    baseScore: session.baseScore,
    winnerSeats,
    scoreChanges: deltas.map((delta, seat) => ({ seat, delta })),
    remaining,
    multiplier,
    bombCount: session.bombCount,
    guan,
    spring,
    baobenSeats,
  };
}
