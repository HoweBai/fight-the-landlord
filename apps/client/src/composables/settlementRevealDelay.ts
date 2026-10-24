/** 终局结算延迟展示时长（生产默认值；用户裁决 2000ms）。 */
export const SETTLEMENT_REVEAL_DELAY_MS = 2000;

let delayMs = SETTLEMENT_REVEAL_DELAY_MS;

export function getSettlementRevealDelayMs(): number {
  return delayMs;
}

/** 仅供测试：覆写延迟（0 = 立即揭示）。有限、非负。 */
export function __setSettlementRevealDelayForTest(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`settlement reveal delay must be finite and >= 0 (got ${ms})`);
  }
  delayMs = ms;
}

/** 仅供测试：恢复生产默认值。 */
export function __resetSettlementRevealDelayForTest(): void {
  delayMs = SETTLEMENT_REVEAL_DELAY_MS;
}
