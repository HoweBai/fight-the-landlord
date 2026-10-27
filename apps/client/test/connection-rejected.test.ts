/**
 * N15 / R166：**被服务端踢线**（§5.4 的单 IP 并发连接上限 5）之后不得自动重连，
 * 并且要给出明确文案。
 *
 * 事实（R152 实测）：socket.io 服务端在握手**之后**拒绝时，客户端观察到的序列是
 *   `connect` → `system.error {10006}` → `disconnect(reason = 'io server disconnect')`，
 * **不是** `connect_error`。因此：
 *  - **终止依据是 disconnect 的 reason**，不是错误码；
 *  - `system.error{10006}` 只决定**文案**（HTTP 维度的限流也返回 10006，那时链路是好的、
 *    必须继续自动重连）。
 *
 * ⚠️ R171②：断言「没有发 game.reconnect」之前，必须先证明探针**能观测到发生** ——
 * 本文件第 1 条就是那个正对照（`transport close` ⇒ 重连照常发出）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGameSession, type GameSession, type SessionNotice } from '../src/net/session';
import type { ReconnectReason } from '../src/net/socket';
import { FakeSocket, serverMessage } from './helpers/fake-socket';

let socket: FakeSocket;
let session: GameSession;
let notices: SessionNotice[];
let reasons: ReconnectReason[];

function boot(): void {
  socket = new FakeSocket();
  notices = [];
  reasons = [];
  session = createGameSession({
    socketFactory: () => socket,
    currentVersion: () => 5,
    applySnapshot: () => {},
    applyEvent: () => {},
    onRoomMatched: () => {},
    onRoomState: () => {},
    onRefreshSnapshot: () => {},
    onReconnect: (reason) => reasons.push(reason),
    onNotice: (notice) => notices.push(notice),
  });
  socket.emitConnect(); // 首次连接（hasConnected 之前）
}

beforeEach(() => boot());
afterEach(() => session.disconnect());

describe('N15：服务端踢线后的重连处置（R166）', () => {
  /** 正对照：链路自己断了（transport close）⇒ 重连必须照常发生（探针判别力）。 */
  it('正对照：transport close 后 socket 重连 ⇒ 仍发 game.reconnect', async () => {
    socket.emitDisconnect('transport close');
    socket.emitConnect();

    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });

  it('io server disconnect（收到过 10006）⇒ 不再自动重连，且给出明确文案', async () => {
    socket.push(serverMessage('system.error', { code: 10006, message: 'too many connections from this IP' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).toContain('同一网络的连接数已达上限');
    expect(notices.some((n) => n.level === 'error' && n.text.includes('同一网络的连接数已达上限'))).toBe(true);

    // 即使之后又收到 connect（手动重连/底层重建），也不得再发 game.reconnect
    socket.emitConnect();
    await Promise.resolve();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
  });

  it('io server disconnect 但**没有** 10006 ⇒ 同样终止恢复（依据是 reason，不是码）', () => {
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).not.toContain('10006');
  });

  /**
   * 终审 F3（K1 文案覆盖 11003 全部可见面）：封禁踢线（网关握手读旗拒绝 + `11003`）
   * 的文案 = 与登录路径**同源**的 K1 全串（`copy.ts`）——改前呈
   * 「服务端拒绝该连接（code=11003）：已停止自动重连」（诊断串，玩家看不懂）。
   */
  it('终审 F3：11003（封禁踢线）⇒ 文案 = K1 全串，不带诊断前缀', () => {
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).toBe('该账号已被封禁，如有异议请联系客服');
    expect(reasons[0]!.message, '不得再呈诊断串').not.toContain('服务端拒绝该连接');
    expect(reasons[0]!.message).not.toContain('11003');
    expect(notices.some((n) => n.level === 'error' && n.text.includes('如有异议请联系客服'))).toBe(true);
  });

  /**
   * 客户端接入片（C32）：端闸踢线（`10008`）的文案 = `copy.ts` 的 §0 全串
   *（与登录 toast / 两死态组件**四面同串**），不再直出
   * 「服务端拒绝该连接（code=10008）」诊断串。相位同样进终态（deadCode=10008 供两
   * 死态组件消费 —— C33）。
   */
  it('客户端接入片 C32：10008（端闸踢线）⇒ 文案 = copy.ts 全串，不带裸码', () => {
    socket.push(serverMessage('system.error', { code: 10008, message: '当前客户端已暂停服务' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).toBe('当前客户端已暂停服务，请稍后再试或更换客户端');
    expect(reasons[0]!.message, '不得再呈诊断串').not.toContain('服务端拒绝该连接');
    expect(reasons[0]!.message).not.toContain('10008');
    expect(notices.some((n) => n.level === 'error' && n.text.includes('当前客户端已暂停服务'))).toBe(true);
    // 终态桥：components 的 canRetry / message 都读这里的 deadCode
    expect(session.client.connectionState).toMatchObject({
      phase: 'dead',
      deadReason: 'server_rejected',
      deadCode: 10008,
    });
  });

  /** 负对照（终审 F3 → Task 2 文案中性化）：10006 的踢线文案 = 完整玩家话术，不带裸码/内部术语。 */
  it('负对照（终审 F3）：10006 的踢线文案为并发上限的完整话术', () => {
    socket.push(serverMessage('system.error', { code: 10006, message: 'too many' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(reasons[0]!.message).toBe(
      '同一网络的连接数已达上限，请关闭其它窗口或设备。',
    );
  });

  it('10006 之后是 transport close ⇒ **仍然**自动重连（HTTP 维度的限流不影响链路恢复）', async () => {
    socket.push(serverMessage('system.error', { code: 10006, message: 'rate limited' }, 0));
    socket.emitDisconnect('transport close');
    socket.emitConnect();

    expect(reasons).toHaveLength(0); // 没有终止信号
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });
});
