/**
 * Session notice 生命周期（Task 2：source / sticky / TTL / system.warning）。
 *
 * 两层判据：
 *  - controller 纯单元（假时钟）：info 3s / warn 6s / error 8s、sticky 不消失、旧 timer 不杀新值；
 *  - 生产接线（`productionSession`）：链路 sticky 到恢复、clearNotice 取消 action timer、
 *    `stopGameSession` 清理 timer、推送路径 `source: 'system'`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { createSessionNoticeController } from '../src/composables/sessionNotice';
import { currentSession, stopGameSession } from '../src/composables/useGameSession';
import { productionSession } from './helpers/production-session';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (currentSession.value) stopGameSession();
  vi.useRealTimers();
});

describe('session notice 生命周期', () => {
  it('info 3s / warn 6s / error 8s 自动消失', () => {
    const ctl = createSessionNoticeController();

    ctl.set({ level: 'info', text: 'info', source: 'transport' });
    vi.advanceTimersByTime(2999);
    expect(ctl.notice.value?.text).toBe('info');
    vi.advanceTimersByTime(1);
    expect(ctl.notice.value).toBeNull();

    ctl.set({ level: 'warn', text: 'warn', source: 'action' });
    vi.advanceTimersByTime(5999);
    expect(ctl.notice.value?.text).toBe('warn');
    vi.advanceTimersByTime(1);
    expect(ctl.notice.value).toBeNull();

    ctl.set({ level: 'error', text: 'x', source: 'action' });
    vi.advanceTimersByTime(7999);
    expect(ctl.notice.value?.text).toBe('x');
    vi.advanceTimersByTime(1);
    expect(ctl.notice.value).toBeNull();
  });

  it('sticky 不自动消失', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'error', text: '断链', source: 'transport', sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(ctl.notice.value?.text).toBe('断链');
  });

  it('新值使旧 timer 失效（旧 timer 到期不杀 sticky 新值）', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'error', text: 'old', source: 'action' }); // 8s timer
    vi.advanceTimersByTime(4000);
    ctl.set({ level: 'info', text: 'new', source: 'transport', sticky: true });
    vi.advanceTimersByTime(4000); // 旧 timer 原本在 t=8s 到期
    expect(ctl.notice.value?.text).toBe('new');
  });

  it('clearAction 只清 action；dispose 清一切', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'warn', text: 'action', source: 'action' });
    ctl.clearAction();
    expect(ctl.notice.value).toBeNull();
    ctl.set({ level: 'warn', text: 'transport', source: 'transport' });
    ctl.clearAction();
    expect(ctl.notice.value?.text).toBe('transport');
    ctl.dispose();
    expect(ctl.notice.value).toBeNull();
  });
});

describe('session 集成生命周期（生产接线）', () => {
  it('transport 不可用 sticky 到恢复；恢复后 3s 消失', async () => {
    const { socket, session } = productionSession();
    socket.emitConnectError(new Error('offline'));
    vi.advanceTimersByTime(60_000);
    expect(session.notice.value?.text).toBe('连接不可用，请检查网络后重试');
    socket.emitConnect();
    expect(session.notice.value?.text).toBe('连接已恢复');
    vi.advanceTimersByTime(3000);
    expect(session.notice.value).toBeNull();
  });

  it('clearNotice 取消 action timer，旧 timer 不杀新 notice', async () => {
    const { session } = productionSession();
    // KICK_FORBIDDEN（12005）= TOAST 处置 ⇒ 走 session 的 toast 分支（8s timer）。
    session.client.reportErrorCode(ErrCode.KICK_FORBIDDEN, '');
    expect(session.notice.value?.source).toBe('action');
    session.clearNotice();
    session.notice.value = { level: 'info', text: 'new', source: 'transport' };
    vi.advanceTimersByTime(8000);
    expect(session.notice.value?.text).toBe('new');
  });

  it('stopGameSession 清理 timer', async () => {
    const { session } = productionSession();
    session.client.reportErrorCode(ErrCode.KICK_FORBIDDEN, '');
    expect(session.notice.value?.text).toBeTruthy();
    stopGameSession();
    expect(session.notice.value).toBeNull();
    vi.advanceTimersByTime(8000);
    expect(currentSession.value).toBeNull();
    expect(session.notice.value).toBeNull();
  });

  it('push 路径 notice.source = system', () => {
    const { session } = productionSession();
    session.client.reportErrorCode(ErrCode.KICK_FORBIDDEN, '', 'system');
    expect(session.notice.value?.source).toBe('system');
  });

  it('system.error 12007 push：一条「当前无匹配的玩家」且 source=system', () => {
    const { socket, session } = productionSession();
    socket.push({
      type: 'system.error',
      version: 0,
      payload: { code: ErrCode.MATCH_TIMEOUT, message: 'Match timed out' },
    });
    expect(session.notice.value?.text).toBe('当前无匹配的玩家');
    expect(session.notice.value?.source).toBe('system');
  });

  it('system.warning push：message 原样、warn、source=system、6s 自消、不导航不出处置', () => {
    const { socket, session, visited, signals } = productionSession();
    const message = '本局将在 30 秒后由系统代打';
    socket.push({
      type: 'system.warning',
      version: 0,
      payload: { code: 12007, message },
    });
    expect(session.notice.value?.text).toBe(message);
    expect(session.notice.value?.level).toBe('warn');
    expect(session.notice.value?.source).toBe('system');
    expect(session.notice.value?.code).toBe(12007);
    // 永不导航、永不出处置/重连信号（协议文档 §208：「原样展示」）
    expect(visited).toEqual([]);
    expect(signals).toEqual([]);
    // warn 级 6s 自动消失
    vi.advanceTimersByTime(5999);
    expect(session.notice.value?.text).toBe(message);
    vi.advanceTimersByTime(1);
    expect(session.notice.value).toBeNull();
  });

  it('system.warning 空 message：中性兜底文案', () => {
    const { socket, session, visited, signals } = productionSession();
    socket.push({
      type: 'system.warning',
      version: 0,
      payload: { code: 0, message: '' },
    });
    expect(session.notice.value?.text).toBe('请注意，牌局状态有变化');
    expect(session.notice.value?.level).toBe('warn');
    expect(session.notice.value?.source).toBe('system');
    expect(visited).toEqual([]);
    expect(signals).toEqual([]);
  });
});
