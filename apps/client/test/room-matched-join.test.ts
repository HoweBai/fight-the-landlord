/**
 * R50 / §8.2：收到 `room.matched` 后必须自动 `room.join`，且**只有 ack code 0 才导航**。
 *
 * 这条接线此前完全不存在（前端只 setRoom + navigate），后果是服务端从不写
 * `reconnect:active`、`socket.join(roomCode)` 从不发生。因此断言必须钉住
 * 「join 真的发出去了」而不只是「页面变了」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ClientAction, ErrCode } from '@fight-the-landlord/protocol';
import { GameClient, RequestInFlightError } from '../src/net/socket';
import { FakeSocket, serverMessage, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.resetModules();
  localStorage.clear();
});

afterEach(async () => {
  const { stopGameSession } = await import('../src/composables/useGameSession');
  stopGameSession();
});

async function boot() {
  const { startGameSession } = await import('../src/composables/useGameSession');
  const { useAuthStore } = await import('../src/stores/auth');
  const { useGameStore } = await import('../src/stores/game');
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const auth = useAuthStore();
  auth.enterAsDevUser(); // 登录态：page = 'lobby'
  return { socket, auth, store: useGameStore() };
}

describe('room.matched → 自动进房（§8.2 / R50）', () => {
  it('收到 room.matched 就发 room.join，ack code 0 之后才导航到牌桌', async () => {
    const { socket, auth, store } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 1 }, 0));

    const joins = socket.emittedOf('room.join');
    expect(joins).toHaveLength(1);
    // S5.3：自动 join 必须带 gameType（旧 room.matched 缺字段 ⇒ 回落 activeMode=doudizhu）
    expect(joins[0]!.env.payload).toEqual({ roomCode: 'ROOM1', gameType: 'doudizhu' });
    expect(store.activeMode).toBe('doudizhu');
    expect(store.playerCount).toBe(3);
    // 还没拿到 ack → 不得导航（旧实现正是在这里直接 navigate）
    expect(auth.page).toBe('lobby');
    expect(store.roomCode).toBe('ROOM1'); // 但房间号必须先记住（重连/离开都要用）

    joins[0]!.ack(null, {
      code: 0,
      data: {
        roomCode: 'ROOM1',
        seat: 1,
        players: [
          { id: 'p0', seat: 0 },
          { id: 'p1', seat: 1 },
          { id: 'p2', seat: 2 },
        ],
      },
    });

    await vi.waitFor(() => expect(auth.page).toBe('table'));
    /**
     * R61：**不伪造服务端没给的状态**。`room.join` 的 ack 里没有 `status`，
     * 因此进房后 `roomStatus` 必须**仍是 null**，而不是被客户端写成 `'playing'`。
     */
    expect(store.roomStatus).toBeNull();
    // 反向断言：自动跟进**只发一次** —— 重试机器不得把 ack 成功的那次又补一遍
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(1);
  });

  it('S5.3：room.matched 带 gameType/playerCount ⇒ 写 activeMode/人数并原样用于 room.join', async () => {
    const { socket, auth, store } = await boot();

    socket.push(
      serverMessage(
        'room.matched',
        { roomCode: 'PDK1', seat: 0, gameType: 'paodekuai', playerCount: 3 },
        0,
      ),
    );

    const joins = socket.emittedOf('room.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.env.payload).toEqual({ roomCode: 'PDK1', gameType: 'paodekuai' });
    expect(store.activeMode).toBe('paodekuai');
    expect(store.playerCount).toBe(3);

    joins[0]!.ack(null, {
      code: 0,
      data: {
        roomCode: 'PDK1',
        seat: 0,
        players: [
          { id: 'p0', seat: 0 },
          { id: 'p1', seat: 1 },
          { id: 'p2', seat: 2 },
        ],
      },
    });
    await vi.waitFor(() => expect(auth.page).toBe('table'));
  });

  it('R61：join 的 ack 不带 status → 不得沿用上一局的 roomStatus（更不得编一个）', async () => {
    const { socket, auth, store } = await boot();

    // 模拟「上一局的残留状态」（真实可达：从牌桌回大厅再被匹配）
    store.roomStatus = 'finished';

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM2', seat: 0 }, 0));
    socket.emittedOf('room.join')[0]!.ack(null, {
      code: 0,
      data: { roomCode: 'ROOM2', seat: 0, players: [{ id: 'p0', seat: 0 }] },
    });

    await vi.waitFor(() => expect(auth.page).toBe('table'));
    // 没有新状态可写时保持原值不变：既不是 'finished'，也不是伪造的 'playing'
    expect(store.roomStatus).not.toBe('playing');
    expect(store.roomStatus).toBe('finished');
  });

  it('room.join 被拒（12004）→ 不导航、清空对局渲染状态', async () => {
    const { socket, auth, store } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 0 }, 0));
    socket.emittedOf('room.join')[0]!.ack(null, { code: ErrCode.NOT_IN_ROOM, message: 'not a member' });

    await vi.waitFor(() => expect(store.roomCode).toBeNull());
    expect(auth.page).not.toBe('table');
  });

  it('撞上在途请求时等待空闲后重试，**不得**静默丢弃（R50）', async () => {
    const { socket, auth } = await boot();
    const { getGameSession } = await import('../src/composables/useGameSession');
    const client = getGameSession().client;

    // 先占住串行队列：一次没有 ack 的 game.resync
    const inflight = client.resync();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 0 }, 0));
    // 队列忙 → 不能抢槽位，也**不能**就此放弃
    expect(socket.emittedOf('room.join')).toHaveLength(0);

    socket.emittedOf('game.resync')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 3, seat: 0 }),
    });
    await inflight;

    await vi.waitFor(() => expect(socket.emittedOf('room.join')).toHaveLength(1));
    socket.emittedOf('room.join')[0]!.ack(null, {
      code: 0,
      data: { roomCode: 'ROOM1', seat: 0, players: [{ id: 'p0', seat: 0 }] },
    });
    await vi.waitFor(() => expect(auth.page).toBe('table'));
    // 反向断言：等待期间没有偷偷「先占坑再补发」，全程只有一次 join
    expect(socket.emittedOf('room.join')).toHaveLength(1);
  });

  /**
   * R50 的关键分支：**撞上在途请求时不得静默丢弃**（旧实现直接吞掉）。
   *
   * 反向断言清单（都是「没发生的事」）：
   *  - ack 之前不发第二次；
   *  - 被拒（`12001`）时**不得**导航进牌桌；
   *  - 会话已拆除时**不 emit**（不能往一个死连接上发请求）。
   */
  it('join 被拒（12001 ROOM_NOT_FOUND）→ 停留在原页面且只有一个在途 join', async () => {
    const { socket, auth } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'GONE01', seat: 2 }, 0));
    expect(socket.emittedOf('room.join')).toHaveLength(1);

    socket.emittedOf('room.join')[0]!.ack(null, { code: ErrCode.ROOM_NOT_FOUND, message: 'no room' });
    await vi.waitFor(() => expect(auth.page).toBe('lobby'));

    expect(auth.page).not.toBe('table');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(1);
  });

  /**
   * Task 2：`room.join` **发送失败**（`sendQueued` 重试配额用尽仍 blocked）⇒ 会话 notice
   * 为「进房失败，请重试」且 `source: 'action'`（可被 `clearNotice()` 清掉）。
   * 这里直接让 `sendQueued` 返回 `blocked` —— 该分支与「串行队列被占死」同型，
   * 是发送层唯一能产出 `blocked` 的语义。
   */
  it('room.join 发送失败 ⇒ 会话提示「进房失败，请重试」（source: action），clearNotice 后消失', async () => {
    const { socket } = await boot();
    const { getGameSession } = await import('../src/composables/useGameSession');
    const session = getGameSession();
    vi.spyOn(session.client, 'sendQueued').mockResolvedValue({
      status: 'blocked',
      type: 'room.join',
      reqId: 'req-join-blocked',
      reason: new RequestInFlightError('awaiting_ack', 'room.join'),
    });

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 1 }, 0));

    await vi.waitFor(() => expect(session.notice.value?.text).toBe('进房失败，请重试'));
    expect(session.notice.value).toMatchObject({ level: 'warn', source: 'action' });
    session.clearNotice();
    expect(session.notice.value).toBeNull();
  });

  it('房间号必须在 join 之前就记住（重连/离开/resync 兜底都要用）', async () => {
    const { socket, store } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM9', seat: 2 }, 0));

    // join 已经发出，但 ack 还没回来 —— 此刻 roomCode 必须已经可读
    expect(socket.emittedOf('room.join')).toHaveLength(1);
    expect(store.roomCode).toBe('ROOM9');
    expect(store.mySeat).toBe(2);

    socket.emittedOf('room.join')[0]!.ack(null, { code: 0, data: { roomCode: 'ROOM9', seat: 2, players: [] } });
  });

  /**
   * R61：`applyRoomState` 的 `status` 是**可选**字段 —— 缺省时保持原值，不得覆盖。
   *
   * 这条直接钉住 store 里的判空分支（上一条只覆盖「原值为 null」的弱情形：
   * `roomStatus = payload.status` 恰好也写出 null，所以必须单独构造一个非 null 原值）。
   */
  it('R61：applyRoomState 未给 status 时保持原值（不覆盖成 undefined / null）', async () => {
    const { store } = await boot();

    store.applyRoomState({ status: 'waiting', players: [] });
    expect(store.roomStatus).toBe('waiting');

    // 只带 players、不带 status → roomStatus 必须原样保留
    store.applyRoomState({ players: [{ id: 'p0', seat: 0 }] });
    expect(store.roomStatus).toBe('waiting');

    // 显式给了 status 才写
    store.applyRoomState({ status: 'playing', players: [] });
    expect(store.roomStatus).toBe('playing');
  });

  it('applyRoomState 收集座位昵称：非空写入、缺省/空串不写', async () => {
    const { store } = await boot();

    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0 },
        { id: 'p1', seat: 1, nickname: '阿豆' },
        { id: 'p2', seat: 2, nickname: '' },
      ],
    });

    expect(store.seatNickname(1)).toBe('阿豆');
    expect(store.seatNickname(0)).toBeNull();
    expect(store.seatNickname(2)).toBeNull();
  });
});

/**
 * `sendQueued` 的重试机器本身（R50 的「等待空闲 + 有界重试」，R60 的「按尝试次数全局有界」）。
 *
 * ⚠️ 计划给的 3 条用例**走不到**「被别人抢先 → 重新等下一次空闲」这一步：
 * 每轮只有一个等待者，`flushIdleWaiters` 唤醒后槽位必然空着，重试一次就成功。
 * 下面几条直接构造「等待者被唤醒时槽位已被别人占走」，把该分支与配额语义钉住。
 */
describe('sendQueued：等待空闲 + 有界重试（R50）', () => {
  function makeClient() {
    const socket = new FakeSocket();
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => socket,
      // 非 CAS 请求（room.match / room.join）不参与 version 推进，队列由 ack 释放
      currentVersion: () => 0,
    });
    return { socket, client };
  }

  /**
   * R60：**每一次 `send()` 调用都消耗一次尝试配额**（含「被抢先、没抢到槽位」那种），
   * 因此本方法**全局有界**。这条是最直接的形态：`maxAttempts = 1` ⇒ 首次 `send()` 就
   * `blocked`，`attempts(1) < 1` 为假 → **立即返回**，既不发第二次、也不空等。
   */
  it('配额用尽（maxAttempts = 1）→ 立即返回 blocked，不补发、不空等（R60）', async () => {
    const { socket, client } = makeClient();

    const first = client.send('room.match', { mode: 'random' });
    const queued = client.sendQueued('room.join', { roomCode: 'ROOM1' }, 1);

    const outcome = await queued;
    expect(outcome.status).toBe('blocked');
    // 首次尝试被拦下：**没有** emit，也没有第二次
    expect(socket.emittedOf('room.join')).toHaveLength(0);

    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await first;
    // 反向断言：配额用尽后**不得**再补发（否则「有界」是假的）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(0);
  });

  /**
   * 等待者被 `CLIENT_ACTION` 的恢复请求抢先：**不得静默丢弃**，且**恰好一次**。
   *
   * 真实时序（本片用插桩逐行确认，直觉很容易搞反，故完整写下）：
   *   1. `bid` 的 ack 进入 `dispatchAck`：`finishRequest` **先**把槽位清空（此时 `idleWaiters` 还是空的）；
   *   2. `notifyAction` **同步**跑执行器 → `13004` 分支发 `game.resync`。resync **立刻拿到并 emit**；
   *   3. 之后才 `flushIdleWaiters` —— 此时 `pending` 是 resync，flush **整体早退**，等待者继续停放；
   *   4. resync 的 ack 释放槽位 → flush 唤醒 join 的等待者 → 第 2 次尝试在**已空的槽位**上成功。
   *
   * 关键结论（R60 的语义解释）：**等待者被抢先时会多消耗 1 次配额**，
   * 但重试是在「释放后、且没有新的 `CLIENT_ACTION` 抢占」的窗口里跑的，因此通常直接成功；
   * **`blocked` 只在最后一次尝试本身就撞上在途请求时才返回**（见上一条 `maxAttempts = 1` 的用例）。
   *
   * 边界（`maxAttempts = 2`，刚好够 1 次重试）与宽裕（默认 5）两种配额都必须拿到同一个结果 ——
   * 「被抢先 ≠ 被丢弃」。
   */
  it('等待者被恢复请求抢先：恰好 1 次重试就补发，配额刚好够（maxAttempts = 2）', async () => {
    const { socket, client } = makeClient();

    const bid = client.send('game.bid', { grab: true });
    client.onAction((code, message) => {
      // 复刻 `createActionExecutor` 的 `REFRESH_SNAPSHOT` 分支：ack 回调里**同步**发 resync
      if (code === ErrCode.VERSION_CONFLICT) void client.sendQueued('game.resync', {});
      return { code, action: ClientAction.REFRESH_SNAPSHOT, known: true, message };
    });

    const queued = client.sendQueued('room.join', { roomCode: 'ROOM1' }, 2);
    expect(socket.emittedOf('room.join')).toHaveLength(0); // 队列忙 → 不许抢槽位

    socket.emittedOf('game.bid')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await bid;

    // 关键证据 ①：恢复请求真的拿到了槽位，join 停放在它后面、一发都没出去
    const resyncs = socket.emittedOf('game.resync');
    expect(resyncs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(0);

    // 关键证据 ②：resync 释放槽位后，停放的重试**恰好补发一次**（没有被静默丢弃）
    resyncs[0]!.ack(null, { code: 0, data: playerViewFixture({ version: 1, seat: 0 }) });
    await vi.waitFor(() => expect(socket.emittedOf('room.join')).toHaveLength(1));

    socket.emittedOf('room.join')[0]!.ack(null, { code: 0 });
    const outcome = await queued;
    expect(outcome.status).toBe('sent');
    // 反向断言：**恰好一次**，不是重试风暴
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(1);
  });

  /** 同上，但配额宽裕（默认 5）：结果必须完全一致 —— 补发恰好一次。 */
  it('等待者被恢复请求抢先（配额宽裕）→ 同样恰好一次，不因配额多就多发', async () => {
    const { socket, client } = makeClient();

    const bid = client.send('game.bid', { grab: true });
    client.onAction((code, message) => {
      if (code === ErrCode.VERSION_CONFLICT) void client.sendQueued('game.resync', {});
      return { code, action: ClientAction.REFRESH_SNAPSHOT, known: true, message };
    });

    const queued = client.sendQueued('room.join', { roomCode: 'ROOM1' }, 5);
    socket.emittedOf('game.bid')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await bid;

    const resyncs = socket.emittedOf('game.resync');
    expect(resyncs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(0);

    resyncs[0]!.ack(null, { code: 0, data: playerViewFixture({ version: 1, seat: 0 }) });
    await vi.waitFor(() => expect(socket.emittedOf('room.join')).toHaveLength(1));

    socket.emittedOf('room.join')[0]!.ack(null, { code: 0 });
    expect((await queued).status).toBe('sent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.emittedOf('room.join')).toHaveLength(1);
  });
});
