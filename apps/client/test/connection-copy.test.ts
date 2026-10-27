/**
 * 连接文案单一真源（Task 4）：`connectionDeadCopy` / `connectionKickMessage`。
 *
 * 判据：
 *  - give-up 给重试、无重登；
 *  - 10006 并发上限：死态组件与 socket 踢线文案**同一句**（「同一网络…」口径），
 *    与登录路径 10006 的「操作太频繁」不同源（码相同、语境不同）；
 *  - 11003 不可重试，但给「重新登录」出口；
 *  - 无码踢线可重试（空闲踢线可恢复），并给「重新登录」出口；
 *  - session_expired 只能重登。
 */
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { connectionDeadCopy, connectionKickMessage } from '../src/net/connection-copy';

const base = { phase: 'dead' as const, attempt: 0 };

describe('连接文案单一真源', () => {
  it('give_up 可重试', () => {
    const copy = connectionDeadCopy({ ...base, deadReason: 'give_up', deadCode: null });
    expect(copy.message).toContain('多次自动重连仍未成功');
    expect(copy.canRetry).toBe(true);
    expect(copy.canRelogin).toBe(false);
  });

  it('10006 使用同一网络口径，且与登录 10006 文案不同', () => {
    const copy = connectionDeadCopy({ ...base, deadReason: 'server_rejected', deadCode: ErrCode.RATE_LIMITED });
    expect(copy.message).toBe('同一网络的连接数已达上限，请关闭其它窗口或设备。');
    expect(connectionKickMessage(ErrCode.RATE_LIMITED)).toBe(copy.message);
    expect(copy.canRetry).toBe(true);
    expect(copy.canRelogin, '服务端踢线一律给「重新登录」出口').toBe(true);
  });

  it('11003 不可重试，但给「重新登录」出口；session_expired 只能重登', () => {
    const banned = connectionDeadCopy({ ...base, deadReason: 'server_rejected', deadCode: ErrCode.USER_BANNED });
    expect(banned.canRetry).toBe(false);
    expect(banned.canRelogin, '再次被拒时回登录页重新登录').toBe(true);
    expect(banned.message).toContain('如有异议请联系客服');
    const expired = connectionDeadCopy({ ...base, deadReason: 'session_expired', deadCode: ErrCode.TOKEN_EXPIRED });
    expect(expired.canRetry).toBe(false);
    expect(expired.canRelogin).toBe(true);
  });

  it('无码踢线：可重试（空闲踢线可恢复）且给「重新登录」出口', () => {
    const copy = connectionDeadCopy({ ...base, deadReason: 'server_rejected', deadCode: null });
    expect(copy.canRetry).toBe(true);
    expect(copy.canRelogin).toBe(true);
    expect(copy.message).toBe('服务端主动断开了连接。');
  });

  it('握手拒绝码使用对应友好文案（以 11005 设备绑定为例）', () => {
    const copy = connectionDeadCopy({
      ...base,
      deadReason: 'server_rejected',
      deadCode: ErrCode.DEVICE_MISMATCH,
    });
    expect(copy.message).toContain('账号已绑定其他设备');
    expect(copy.canRetry).toBe(false);
    expect(copy.canRelogin).toBe(true);
  });

  it('10007 上游不可用：文案提示稍后重试 ⇒ 必须给重试（文案与按钮不得矛盾）', () => {
    const copy = connectionDeadCopy({
      ...base,
      deadReason: 'server_rejected',
      deadCode: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    expect(copy.message).toContain('服务暂时不可用');
    expect(copy.canRetry).toBe(true);
    expect(copy.canRelogin).toBe(true);
  });
});
