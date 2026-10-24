import { describe, expect, it } from 'vitest';
import {
  isLegalTrusteeCombo,
  onManualTrusteeOff,
  onTimeoutOccurred,
  onTrusteeOff,
  onTurnConsumed,
  turnDurationFor,
} from './governance';

const D = { normal: 30_000, accel: 10_000, trustee: 2_000, after: 3 };
const seat = (timeoutCount: number, trustee = false) => ({ timeoutCount, trustee });

describe('挂机治理纯函数', () => {
  it('C10：时长按治理态分档', () => {
    expect(turnDurationFor(seat(0), D)).toBe(30_000);
    expect(turnDurationFor(seat(1), D)).toBe(10_000);
    expect(turnDurationFor(seat(3, true), D)).toBe(2_000);
  });
  it('C1：超时 +1；count ≥ after ⇒ trustee（用 ≥）', () => {
    expect(onTimeoutOccurred(seat(0), D)).toMatchObject({ timeoutCount: 1, trustee: false });
    expect(onTimeoutOccurred(seat(2), D)).toMatchObject({ timeoutCount: 3, trustee: true });
    expect(onTimeoutOccurred(seat(5, true), D).trustee).toBe(true);
  });
  it('C3：回合消耗型动作 ⇒ 清零复位', () => {
    expect(onTurnConsumed(seat(3, true))).toMatchObject({ timeoutCount: 0, trustee: false });
  });
  it('C4：reconnect / 手动开启的托管 off ⇒ 只清 trustee、count 不动', () => {
    expect(onTrusteeOff(seat(3, true))).toMatchObject({ timeoutCount: 3, trustee: false });
  });
  it('C4′：手动取消自动托管 ⇒ count 清零 + 解除 trustee', () => {
    expect(onManualTrusteeOff(seat(3, true))).toMatchObject({ timeoutCount: 0, trustee: false });
    // 纯函数：未托管输入也返回 0/false（调用侧用阈值门控，函数本身不做判定）
    expect(onManualTrusteeOff(seat(0))).toMatchObject({ timeoutCount: 0, trustee: false });
  });
  it('C7b：via×on 合法组合集', () => {
    expect(isLegalTrusteeCombo('manual', true)).toBe(true);
    expect(isLegalTrusteeCombo('manual', false)).toBe(true);
    expect(isLegalTrusteeCombo('reconnect', false)).toBe(true);
    expect(isLegalTrusteeCombo('reconnect', true)).toBe(false);
    expect(isLegalTrusteeCombo('abandon', true)).toBe(true);
    expect(isLegalTrusteeCombo('abandon', false)).toBe(false);
  });
});
