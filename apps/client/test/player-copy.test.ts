import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { actionErrorMessage, authErrorMessage, isPlayerDiag, playerMessage } from '../src/net/copy';

const BANNED = [/code=/, /\[\d+\]/, /refresh_snapshot/, /back_to_lobby/, /§/, /version/, /socket\.io/, /lastVersion/];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('玩家文案：上下文优先级', () => {
  it('auth 保留 message-first（11002）', () => {
    expect(playerMessage(ErrCode.BAD_CREDENTIALS, { context: 'auth', serverMessage: '密码错误' })).toBe('密码错误');
    expect(authErrorMessage(ErrCode.BAD_CREDENTIALS, '登录')).toBe('手机号或密码不正确');
  });

  it('rest 保留 10001 的 message-first', () => {
    expect(playerMessage(ErrCode.BAD_PARAM, { context: 'rest', serverMessage: '参数错误' })).toBe('参数错误');
  });

  it('action 固定文案优先（12008/13004/10006/10007，即使 serverMessage 非空）', () => {
    expect(playerMessage(ErrCode.ROOM_ALREADY_STARTED, { context: 'action', serverMessage: 'room started' })).toBe('房间已经开始，无法加入');
    expect(playerMessage(ErrCode.VERSION_CONFLICT, { context: 'action', serverMessage: 'version conflict' })).toBe('牌局状态有更新，正在同步…');
    expect(playerMessage(ErrCode.RATE_LIMITED, { context: 'rest', serverMessage: 'Too many requests' })).toBe('操作太频繁，请稍后再试');
    expect(playerMessage(ErrCode.UPSTREAM_UNAVAILABLE, { context: 'rest', serverMessage: 'downstream down' })).toBe('服务暂时不可用，请稍后重试');
  });

  it('warning 原样展示服务端 message', () => {
    expect(playerMessage(ErrCode.UPSTREAM_UNAVAILABLE, { context: 'warning', serverMessage: '本局将在 30 秒后由系统代打' })).toBe(
      '本局将在 30 秒后由系统代打',
    );
  });

  it('成功的 0 不产生文案', () => {
    expect(actionErrorMessage(ErrCode.OK)).toBe('');
    expect(playerMessage(ErrCode.OK, { context: 'action' })).toBe('');
  });

  it('未知码中性化；diag 开启才带码', () => {
    expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试');
    vi.stubEnv('VITE_PLAYER_DIAG', '1');
    expect(isPlayerDiag()).toBe(true);
    expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试（code=424242）');
  });

  it('全部码 × 上下文不出现内部串（serverMessage 为空）', () => {
    for (const code of Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number')) {
      for (const context of ['auth', 'action', 'rest', 'warning'] as const) {
        const text = playerMessage(code, { context });
        for (const re of BANNED) expect(text, `${code}/${context}: ${text}`).not.toMatch(re);
      }
    }
  });
});
