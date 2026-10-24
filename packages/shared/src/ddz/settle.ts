import type { DdzSettlementResult } from '@fight-the-landlord/protocol';
import { GameSession } from './types';
// R161：胜负判定只有一份实现（`play.ts`）。此前本文件有一份**重复**的
// `checkWinCondition`（同样是 `farmers.every(...)`），所以 C16 必须被修两次。
import { checkWinCondition } from './play';

/**
 * 结算（玩法 §8.1–§8.5）。
 *
 * 返回**契约类型**（N1/R182）：`roomCode` / `baseScore` / `landlordSeat` / `spring`
 * 都在里面，因此调用方**不得**再拼字段（`game-service` 旧实现的 `{...result, roomCode}`
 * 就是第二个真源的入口）。
 *
 * 判定顺序是规格（R185）：`winner` → `spring` → `springMultiplier` → `multiplier` → `unitScore`。
 */
export function settleGame(session: GameSession): DdzSettlementResult {
  const winner = checkWinCondition(session);
  if (!winner) {
    throw new Error('Game not finished');
  }

  const landlord = session.players.find(p => p.isLandlord);
  if (!landlord) {
    throw new Error('No landlord in session');
  }

  // 2026-10-21：底分由 game.start 显式写入（createSession 省略时是 0 哨兵）。
  // 守卫放在 winner / landlord 检查**之后**：未结束局仍先报 `Game not finished`
  // （既有判据），而 0/负数/小数绝不流入 `unitScore`。
  if (!Number.isInteger(session.baseScore) || session.baseScore <= 0) {
    throw new Error(`Invalid baseScore: ${session.baseScore}`);
  }

  const spring = resolveSpring(session, winner);
  const springMultiplier = spring === 'none' ? 1 : 2;

  // §8.2：**乘法**合成（C1）。旧实现是 `bombCount + bidMultiplier`。
  const multiplier = session.bidPhase.bidMultiplier * 2 ** session.playPhase.bombCount * springMultiplier;

  // §8.4：区分「底分」（baseScore）与「单家得失」（unitScore）—— 旧实现的局部变量名
  // `baseScore = 100 * multiplier` 与「底分」冲突，是本条偏差的语言层根源。
  const unitScore = session.baseScore * multiplier;
  const landlordScoreChange = winner === 'landlord' ? unitScore * 2 : -unitScore * 2;
  const farmerScoreChange = winner === 'landlord' ? -unitScore : unitScore;

  return {
    roomCode: session.roomCode,
    baseScore: session.baseScore,
    winner,
    // §8.5 末注：**座位号**，不是 `players` 数组下标（C2）。3 人局下两者常相等，
    // 因此唯一能抓住它的判据是「座位与下标不一致」的夹具（settle.test.ts）。
    landlordSeat: landlord.seat,
    farmerSeats: session.players.filter(p => !p.isLandlord).map(p => p.seat),
    multiplier,
    spring,
    landlordScoreChange,
    farmerScoreChange,
  };
}

/**
 * 春天 / 反春（玩法 §8.3，逐字两条）：
 *  - 春天：**地主胜** 且两农民一手未出（`farmerPlays === 0`）
 *  - 反春：**农民胜** 且地主**恰好**出过一手（`landlordPlays === 1`）
 */
function resolveSpring(
  session: GameSession,
  winner: 'landlord' | 'farmer',
): 'none' | 'spring' | 'anti-spring' {
  if (winner === 'landlord' && session.playPhase.farmerPlays === 0) return 'spring';
  if (winner === 'farmer' && session.playPhase.landlordPlays === 1) return 'anti-spring';
  return 'none';
}
