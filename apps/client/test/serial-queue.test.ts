/**
 * 契约行为断言 ①②：请求串行（M06）与 `baseVersion` 的 CAS 释放语义（§6.5）。
 *
 * 这两条直接对着 docs/design.md 写：
 *  - §6.5「请求串行：一次只有一个在途请求；收到 ack 或 state_update 后才允许下一次」
 *  - §6.5「首个动作的 baseVersion 初值：客户端从 game.deal 推送的 version 取得」
 *  - §6.5 `13004` 的统一处置：丢弃本地未确认的乐观状态 → 重拉快照（**不是**重连）
 */
import { describe, expect, it, vi } from 'vitest';
import { GameClient, RequestInFlightError, buildRequestPayload, readAckArgs } from '../src/net/socket';
import type { RequestOutcome } from '../src/net/socket';
import type { ClientMessageType } from '@fight-the-landlord/protocol';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';

function makeClient(overrides: { currentVersion?: number | (() => number) } = {}) {
  const socket = new FakeSocket();
  // 在回调体里按 `typeof` 收窄：三元分支把闭包捕获的联合类型传出去会丢收窄。
  const versionOverride = overrides.currentVersion;
  const currentVersion = (): number =>
    typeof versionOverride === 'function' ? versionOverride() : (versionOverride ?? 0);
  const client = new GameClient({
    endpoint: 'http://mock.test',
    namespace: '/ws/ddz',
    auth: { userId: 'u_dev' },
    socketFactory: () => socket,
    currentVersion,
  });
  return { socket, client };
}

/** 结算 socket.io ack（带可选超时错误），用于模拟服务端行为。 */
function ackLast(
  socket: FakeSocket,
  res: { code: number; message?: string; data?: unknown } = { code: 0 },
  err?: Error | null,
) {
  const req = socket.lastRequest();
  if (!req) throw new Error('no request was emitted');
  req.ack(err ?? null, res);
  return req;
}

describe('① 请求串行（M06）', () => {
  it('未收到 ack 前，第二个操作被阻塞且不发送', async () => {
    const { socket, client } = makeClient();

    const first = client.send('game.play', { cards: [3] });
    const second = client.send('game.pass', {});

    // 第一个请求已发出；第二个被阻塞，且**没有**真的 emit 出去
    expect(socket.emitted.length).toBe(1);
    expect(socket.emitted[0]!.type).toBe('game.play');

    const outcome = await second;
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') throw new Error('unreachable');
    // 类型放宽（`blocked.reason` = RequestInFlightError | ConnectionDeadError）后的窄化：
    // 本条钉的是**串行队列**拦下（本场景链路正常），先认类再读 `.kind`。
    expect(outcome.reason).toBeInstanceOf(RequestInFlightError);
    if (!(outcome.reason instanceof RequestInFlightError)) throw new Error('unreachable');
    expect(outcome.reason.kind).toBe('awaiting_ack');
    expect(socket.emitted.length).toBe(1);

    ackLast(socket);
    await expect(first).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('收到 ack 后，下一次操作才被允许（同一请求类型）', async () => {
    const { socket, client } = makeClient();

    const first = client.send('game.pass', {});
    ackLast(socket);
    await first;

    const second = client.send('game.pass', {});
    expect(socket.emitted.length).toBe(2);

    ackLast(socket);
    await expect(second).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('非 CAS 请求（room.match）在 ack 后立即释放队列', async () => {
    const { socket, client } = makeClient();

    const first = client.send('room.match', { mode: 'random' });
    ackLast(socket);
    await first;

    const second = client.send('room.unmatch', {});
    expect(socket.emitted.length).toBe(2);
    expect(socket.emitted[1]!.type).toBe('room.unmatch');
    ackLast(socket);
    await expect(second).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('CAS 请求 ack 成功后仍占位，直到同版本状态被应用（state_update 推进 version）', async () => {
    const { socket, client } = makeClient({ currentVersion: 5 });

    const first = client.send('game.bid', { grab: true });
    ackLast(socket);
    await expect(first).resolves.toMatchObject({ status: 'sent', code: 0 });

    // 服务端尚未推送 game.state_update：仍不允许下一次操作（M06）
    const blocked = await client.send('game.pass', {});
    expect(blocked.status).toBe('blocked');
    const blockedReason = (blocked as Extract<RequestOutcome, { status: 'blocked' }>).reason;
    // 同款窄化（类型放宽见第一条用例的注释）：本场景是串行队列拦下。
    expect(blockedReason).toBeInstanceOf(RequestInFlightError);
    if (!(blockedReason instanceof RequestInFlightError)) throw new Error('unreachable');
    expect(blockedReason.kind).toBe('awaiting_state_update');

    // state_update 把 version 从 5 推进到 6 → 队列释放
    // ⚠️ B2：`type` 由**事件名**承载（真实网关 `client.emit(type, {version,payload})`），
    // 因此第一条实参是事件名。`serverMessage()` 造的 body **额外**带 `type`，
    // 恰好覆盖「body 是超集」的形态（也应当容忍 —— 以事件名为准）。
    client.handleServerMessage(
      'game.state_update',
      serverMessage('game.state_update', playerViewFixture({ version: 6 }), 6),
    );

    const second = client.send('game.pass', {});
    expect(socket.emitted.length).toBe(2);
    ackLast(socket);
    await expect(second).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  /**
   * 到达顺序竞态（2026-10-22 用户实测：流局重发后紧接着点「不叫」偶现
   * 「上一个操作尚未确认，请稍候」）：服务端先经 Redis pub/sub 推 `game.state_update`，
   * 再经 RPC 返回、由网关回 ack —— 两条独立链路，推送完全可能先到。
   *
   * 先到时 `handleServerMessage` 的释放条件因 `pending.settled === false` 被跳过；
   * ack 后到之后，若 `finishRequest` 不回头检查「版本其实已推进」，槽位会一直占到
   * `ACK_TIMEOUT_MS`（5s）。本条钉住「ack 到达且版本已推进 ⇒ 立即释放」。
   */
  it('state_update 先于 ack 到达：ack 后立即释放队列，不占满 5s 安全超时', async () => {
    let appliedVersion = 5;
    const { socket, client } = makeClient({ currentVersion: () => appliedVersion });
    // 模拟真实接线（net/session.ts）：`game.state_update` 被应用后，已应用版本推进。
    client.on('game.state_update', (msg) => {
      appliedVersion = msg.version;
    });

    const first = client.send('game.bid', { grab: false });

    // ① 服务端推送链路先到（ack 尚未到达）——此刻 pending 未 settled，不释放。
    client.handleServerMessage(
      'game.state_update',
      serverMessage('game.state_update', playerViewFixture({ version: 6 }), 6),
    );
    expect(appliedVersion).toBe(6);

    // ② ack 后到：版本已推进 ⇒ 队列必须立即释放。
    ackLast(socket);
    await expect(first).resolves.toMatchObject({ status: 'sent', code: 0 });

    // ③ 下一次操作直接放行（旧实现会 blocked，直到 5s 安全超时）。
    const second = client.send('game.pass', {});
    expect(socket.emitted.map((e) => e.type)).toEqual(['game.bid', 'game.pass']);
    ackLast(socket);
    await expect(second).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('CAS 请求被拒（13004）时立即释放队列，不永久卡死', async () => {
    const { socket, client } = makeClient({ currentVersion: 5 });

    const first = client.send('game.play', { cards: [3] });
    ackLast(socket, { code: 13004 });
    await expect(first).resolves.toMatchObject({ status: 'sent', code: 13004 });

    const second = client.send('game.pass', {});
    expect(socket.emitted.length).toBe(2);
    ackLast(socket, { code: 13004 });
    await second;
  });

  it('断线时释放在途请求，避免 UI 永久 loading（M06）', async () => {
    const { socket, client } = makeClient();

    const first = client.send('game.pass', {});
    socket.emitDisconnect('transport close');

    await expect(first).resolves.toMatchObject({ status: 'sent', code: -1 });
  });
});

describe('① socket.io ack 解包（真实客户端的既有行为，写死防回归）', () => {
  it('socket.io 4 的 ack 只有 1 个参数，且第一个参数就是回执', () => {
    // 实测（socket.io-client 4.8）：emit(type, env, cb) → cb 收到 ({ code: 0, data })
    expect(readAckArgs([{ code: 0, data: { queued: true } }])).toMatchObject({ code: 0 });
  });

  it('兼容 node 风格 (err, res) 的注入实现', () => {
    expect(readAckArgs([null, { code: 0 }])).toMatchObject({ code: 0 });
  });

  it('.timeout() 的超时错误 → 没有回执（code -1）', () => {
    expect(readAckArgs([new Error('operation has timed out')]).code).toBe(-1);
  });

  it('没有回执参数 → code -1', () => {
    expect(readAckArgs([]).code).toBe(-1);
  });
});

describe('① 信封（§6.2：没有 seq，也没有 type/meta）', () => {
  it('请求载荷含 §6.2 的四个权威字段，且没有 seq', () => {
    const env = buildRequestPayload('game.play', { cards: [3, 4] }, 7);
    for (const key of ['reqId', 'baseVersion', 'timestamp', 'payload']) {
      expect(env, `缺少 §6.2 的权威字段 ${key}`).toHaveProperty(key);
    }
    expect(env).not.toHaveProperty('seq');
    expect(env.baseVersion).toBe(7);
    expect(typeof env.reqId).toBe('string');
    expect(env.reqId.length).toBeGreaterThan(0);
    expect(typeof env.timestamp).toBe('number');
  });

  it('线格式里**没有** type / meta（§6.2：扁平，不嵌套 meta）', () => {
    const env = buildRequestPayload('game.play', { cards: [3, 4] }, 7) as unknown as Record<
      string,
      unknown
    >;
    // `type` 由 socket.io 的事件名承载，请求体不重复它；§6.2 要求扁平、不嵌套 meta。
    // 早期实现为迁就 mock 的入站解包额外发了这两个字段，已核实那是过时的说法并删除。
    expect(env).not.toHaveProperty('type');
    expect(env).not.toHaveProperty('meta');
    expect(Object.keys(env).sort()).toEqual(['baseVersion', 'payload', 'reqId', 'timestamp']);
  });

  it('非 CAS 请求的 baseVersion 必须是 0（§6.5 适用范围表）', () => {
    for (const type of ['room.match', 'room.join', 'room.leave', 'game.reconnect', 'game.resync'] as ClientMessageType[]) {
      const payload = type === 'room.match' ? { mode: 'random' } : type === 'room.join' || type === 'room.leave' ? { roomCode: 'R1' } : type === 'game.reconnect' ? { lastVersion: 3 } : {};
      expect(buildRequestPayload(type, payload, 42).baseVersion, `${type} 不得参与 CAS`).toBe(0);
    }
  });

  it('CAS 请求（game.bid/play/pass）使用真实 baseVersion', () => {
    for (const type of ['game.bid', 'game.play', 'game.pass'] as ClientMessageType[]) {
      const payload =
        type === 'game.bid' ? { grab: true } : type === 'game.play' ? { cards: [3] } : {};
      expect(buildRequestPayload(type, payload, 9).baseVersion).toBe(9);
    }
  });

  it('reqId 用于日志追踪：每次请求都不同（M05）', () => {
    const a = buildRequestPayload('game.pass', {}, 0).reqId;
    const b = buildRequestPayload('game.pass', {}, 0).reqId;
    expect(a).not.toBe(b);
  });

  it('入站消息先过 validateInbound：契约不符时抛错而不进业务逻辑', () => {
    const protocolErrors: Error[] = [];
    const socket = new FakeSocket();
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => socket,
      currentVersion: () => 0,
      onProtocolError: (err) => protocolErrors.push(err),
    });
    const onDeal = vi.fn();
    client.on('game.deal', onDeal);

    // 契约不符：抛错，且**不**分发给任何订阅者
    expect(() =>
      client.handleServerMessage('game.deal', { version: 1, payload: { nope: true } }),
    ).toThrow();
    expect(protocolErrors).toHaveLength(1);
    expect(onDeal).not.toHaveBeenCalled();
  });

  it('合法入站消息分发给对应类型的订阅者', () => {
    const { client } = makeClient();
    const onDeal = vi.fn();
    client.on('game.deal', onDeal);

    // ⚠️ B2 回归：这里刻意用**真实线格式** —— body 只有 `{ version, payload }`，
    // **没有** `type`（`type` 只由 socket.io 的事件名承载，这正是网关 `client.emit(type, message)` 的形态）。
    // 旧实现直接 `validateOutbound(msg)` ⇒ 要求 body 带 `type` ⇒ 此处必抛
    // `ProtocolError: $.type must be a string, got undefined`；
    // 而它对着 mock（`socket.emit(checked.type, checked)`，body 带 `type`）却能过
    // —— 这正是这条漂移在 CI 里长期不可见的原因。
    const wire = { version: 1, payload: playerViewFixture({ version: 1 }) };
    expect('type' in wire).toBe(false);

    client.handleServerMessage('game.deal', wire);

    expect(onDeal).toHaveBeenCalledTimes(1);
  });

  it('（B2 兼容）body 里**多带** `type` 的 mock 形态也容忍，且以事件名为准', () => {
    const { client } = makeClient();
    const onDeal = vi.fn();
    client.on('game.deal', onDeal);

    client.handleServerMessage(
      'game.deal',
      serverMessage('game.deal', playerViewFixture({ version: 1 }), 1),
    );

    expect(onDeal).toHaveBeenCalledTimes(1);
  });
});
