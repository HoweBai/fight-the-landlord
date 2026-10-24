/**
 * 挂机治理纯函数（规格 C1/C3/C4/C4′/C7b/C10）：只做「座位治理态 → 新治理态 / 时长」的
 * 纯计算，**不**读写会话、**不**判定机器人（机器人豁免由 game-service 用 `session.botIds`
 * 在调用侧负责）。五个函数里的 `seat` 参数只需 `{ timeoutCount, trustee }`。
 *
 * S1 起从 `ddz/governance.ts` 迁入 core；旧路径保留 re-export（零行为变化）。
 */

export interface GovernanceDurations { normal: number; accel: number; trustee: number; after: number }
export interface SeatGovernance { timeoutCount: number; trustee: boolean }

/** C10：按**下一行动者**的治理态分档取回合时长（trustee 优先于 accel）。 */
export function turnDurationFor(seat: SeatGovernance, d: GovernanceDurations): number {
  if (seat.trustee) return d.trustee;
  if (seat.timeoutCount > 0) return d.accel;
  return d.normal;
}

/** C1：超时 +1；`count ≥ after` ⇒ trustee（用 `≥`，已托管则保持）。 */
export function onTimeoutOccurred(seat: SeatGovernance, d: GovernanceDurations): SeatGovernance {
  const next = seat.timeoutCount + 1;
  return { timeoutCount: next, trustee: seat.trustee || next >= d.after };
}

/** C3：手动回合消耗型动作成功 ⇒ 清零 + 解除托管（仅人类动作成功路径调用）。 */
export function onTurnConsumed(_seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: 0, trustee: false };
}

/** C4：解除托管（reconnect / 手动开启的托管）⇒ 只清 trustee，count 不动。 */
export function onTrusteeOff(seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: seat.timeoutCount, trustee: false };
}

/**
 * C4′（手动取消**自动托管**）：解除托管并清零超时计数——「我回来了」的明确信号。
 * ⚠️ 只用于 `timeoutCount >= after` 的自动托管；手动开启的托管取消仍走 `onTrusteeOff`。
 */
export function onManualTrusteeOff(_seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: 0, trustee: false };
}

/** C7b：仅 manual×{on,off} / reconnect×off / abandon×on 合法。 */
export function isLegalTrusteeCombo(via: 'manual' | 'reconnect' | 'abandon', on: boolean): boolean {
  if (via === 'manual') return true;
  if (via === 'reconnect') return on === false;
  return on === true;
}
