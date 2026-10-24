/**
 * 契约行为断言 ⑥：断线重连的前端侧（切片 5 的判据）。
 *
 * 判据：**断线 → 携 `lastVersion` → 收快照 → 恢复渲染**。
 *
 * 权威依据：
 *  - §6.3 消息清单：`game.reconnect { lastVersion? }` 与 `game.resync {}` 是**两条**消息
 *  - §6.5：「`13004` 的统一处置（只有一种）→ 调用 `game.resync`」，且**不得**用
 *    `game.reconnect` 冒充这一路径
 *  - §6.6 / M03：`emit('game.reconnect', { lastVersion })`
 *  - §6.2 / M02 / M08：快照类消息的 version 判定（`===` 丢弃、`<` 回退、`>` 应用）
 *  - §11：`13010` / `13005` 的处置都来自 `CLIENT_ACTION` 表（两者都是 `BACK_TO_LOBBY`）
 *
 * ⚠️ **本文件的接线全部走生产代码**（`startGameSession` / `createSessionOptions`），
 * 不另抄一份选项对象——否则 `de13b2b` 那批行为（`back_to_lobby` → `store.reset()`、
 * `REFRESH_SNAPSHOT` → `resync()`、两条 notice、导航守卫）就没有任何覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ACTION, ClientAction, ErrCode } from '@fight-the-landlord/protocol';
import { GameClient } from '../src/net/socket';
import { RECONNECT_DEBOUNCE_MS } from '../src/net/transport';
import type { ReconnectReason } from '../src/net/socket';
import { stopGameSession } from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { FakeSocket, playerViewFixture, makeCards } from './helpers/fake-socket';
import { fresh, productionSession } from './helpers/production-session';

afterEach(() => {
  stopGameSession();
  /**
   * 用例里对 `globalThis.setTimeout` 装了 spy（R59 的结构性证据需要记录去抖延时），
   * 必须还原——否则会泄漏到同文件后续用例，改变它们的定时行为。
   */
  vi.restoreAllMocks();
});

/** 把客户端置于「已收到开局快照、version = 3、seat 1、手牌 5 张」的牌桌状态。 */
function seatedAtVersion3(socket: FakeSocket, store: ReturnType<typeof useGameStore>) {
  socket.emitConnect(); // 首次连接：不得触发 game.reconnect
  socket.push({
    type: 'game.deal',
    version: 3,
    payload: playerViewFixture({
      version: 3,
      seat: 1,
      hand: makeCards(3, 4, 5, 6, 7),
      cardCounts: [17, 5, 17],
      roomCode: 'ROOM5',
    }),
  });
  expect(store.currentVersion).toBe(3);
}

describe('⑥ 断线 → 重连：emit game.reconnect 且携带 lastVersion（M03 / §6.6）', () => {
  it('socket connect 的非首次触发 → emit game.reconnect，payload.lastVersion === 当前 version', () => {
    const { socket, store } = fresh();
    seatedAtVersion3(socket, store);
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    socket.emitDisconnect('transport close');
    socket.emitConnect();

    const reconnects = socket.emittedOf('game.reconnect');
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]!.env.payload).toEqual({ lastVersion: 3 });
    // §6.5 适用范围表：game.reconnect 带 lastVersion，**不参与 CAS** → baseVersion 0
    expect(reconnects[0]!.env.baseVersion).toBe(0);
  });

  it('首次 connect 不触发重连（否则刚进游戏就多发一次请求）', () => {
    const { socket } = fresh();

    socket.emitConnect();

    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
    expect(socket.emitted).toHaveLength(0);
  });

  it('ack 返回更大的 version → 应用快照并恢复渲染（mySeat / roomCode / hand / isMyTurn）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();

    // 断线期间服务端推进了一步：现在是 version 4，轮到我（seat 1）出牌
    const req = socket.lastRequest()!;
    expect(req.type).toBe('game.reconnect');
    req.ack(null, {
      code: 0,
      data: playerViewFixture({
        version: 4,
        seat: 1,
        state: 'playing',
        currentPlayer: 1,
        hand: makeCards(3, 4, 5, 6, 7, 8),
        cardCounts: [17, 6, 17],
        roomCode: 'ROOM5',
      }),
    });
    await vi.waitFor(() => expect(store.currentVersion).toBe(4));

    expect(store.view?.seat).toBe(1);
    expect(store.mySeat).toBe(1);
    expect(store.roomCode).toBe('ROOM5');
    expect(store.hand).toEqual(makeCards(3, 4, 5, 6, 7, 8));
    expect(store.isMyTurn).toBe(true);
    expect(store.waitingForDeal).toBe(false);
    expect(store.lastSnapshotOutcome).toBe('applied');

    /**
     * 🔴 2026-10-13 用户反馈：这条提示**是给玩家看的**，不得含内部术语——原先逐字
     * 「socket.io 已重连，已按 M03 用 lastVersion=3 取回快照（applied）」。
     * 判别力：把文案还原成任何版本号/状态码/协议号实现，本断言当场红。
     * ⚠️ 提示走**去抖窗口**，用 waitFor 等它落地（不是恒真等待——上面已经确认流程真跑完）。
     */
    await vi.waitFor(() => expect(session.notice.value?.text).toBe('连接已恢复'));
    expect(session.notice.value!.text).not.toMatch(
      /socket\.io|M03|lastVersion|discarded|applied|rollback|快照/,
    );
  });

  it('断线时释放在途请求（避免 UI 永久 loading），重连照常发出', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    // 一个在途动作请求
    const inflight = session.client.send('game.play', { cards: makeCards(3) });
    expect(socket.emittedOf('game.play')).toHaveLength(1);

    socket.emitDisconnect('transport close');
    // §6.5：断线后释放在途请求 → code -1（不是永久 pending）
    await expect(inflight).resolves.toMatchObject({ status: 'sent', type: 'game.play', code: -1 });
    expect(session.client.busy).toBe(false);

    socket.emitConnect();
    // 队列空闲，所以重连请求能真正出站
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });

  it('重连 ack 未到达前，第二次 connect 不重复 emit（防重连风暴）', () => {
    const { socket, store } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket.emitConnect(); // ack 尚未回来（FakeSocket 不会自动 ack）

    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });

  it('重连成功后 version 与断线前相同 → 丢弃（M02），本地状态不被覆盖', async () => {
    const { socket, store } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket.lastRequest()!.ack(null, {
      code: 0,
      // 服务端版本没动，但视图里手牌被改成了别的 → 丢弃必须保住本地已应用的那份
      data: playerViewFixture({ version: 3, seat: 1, hand: makeCards(9, 9, 9), roomCode: 'ROOM5' }),
    });

    await vi.waitFor(() => expect(store.lastSnapshotOutcome).toBe('discarded'));
    expect(store.currentVersion).toBe(3);
    expect(store.hand).toEqual(makeCards(3, 4, 5, 6, 7));
  });
});

describe('⑥ 每一处槽位释放都必须唤醒等待者（修复轮 3 / N3、R20）', () => {
  it('CAS 在途 + 重连被 blocked + ack 成功但等到 state_update 才释放 → 重连仍被发出', async () => {
    const { socket, store, session, signals } = productionSession();
    seatedAtVersion3(socket, store);

    /**
     * 这是 N3 的原始构造：
     *  - `game.play` 在途（CAS，`awaitingStateVersion = 3`）；
     *  - socket `connect` → `reconnect()` 被串行队列判为 `blocked` → 等待者挂在那个 pending 上；
     *  - play 的 ack `code 0` → `finishRequest` 走 `stillAwaitingState` **不释放**槽位；
     *  - 随后 `game.state_update` 推进 version 才在 `handleServerMessage` 里释放槽位。
     *    这是唯一「没有对应 ack」的释放点——它必须也唤醒等待者，否则重试 promise 永久挂起。
     */
    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emitConnect();
    await Promise.resolve();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
    expect(session.client.busy).toBe(true);

    // ack 成功：CAS 语义要求继续等 state_update，因此此刻**不**释放槽位
    socket.emittedOf('game.play')[0]!.ack(null, { code: 0 });
    await play;
    expect(session.client.busy).toBe(true);
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    // 同一版本的状态转移到达 → 释放槽位（N3 就是漏了这里的唤醒）
    socket.push({
      type: 'game.state_update',
      version: 4,
      payload: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });

    // ① 被 blocked 的重连必须补发（而不是永久挂起）
    await vi.waitFor(() => expect(socket.emittedOf('game.reconnect')).toHaveLength(1));
    expect(socket.emittedOf('game.reconnect')[0]!.env.payload).toEqual({ lastVersion: 3 });
    // 这一次重连的 ack 还没回来，所以「重连进行中」仍为真——这是正常的
    expect(session.client.reconnectPending).toBe(true);

    // ② ack 回来后恢复链路：队列与 `reconnectInFlight` 都必须归位
    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });
    await vi.waitFor(() => expect(session.client.busy).toBe(false));
    await vi.waitFor(() => expect(session.client.reconnectPending).toBe(false));

    // ③ 之后的下一次 socket 重连仍然有效（不是静默 no-op）
    socket.emitDisconnect('transport close');
    socket.emitConnect();
    await vi.waitFor(() => expect(socket.emittedOf('game.reconnect')).toHaveLength(2));
    expect(signals.some((s) => s.kind === 'snapshot_unavailable')).toBe(false);
  });

  it('destroy() 之后被挂起的重试 promise 必须结算（不变量，N3b）', async () => {
    const { socket, store, session } = productionSession();
    seatedAtVersion3(socket, store);

    // 在途请求占住队列 → 重连的重试等待者挂起
    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emitConnect();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    session.client.destroy();

    /**
     * 不变量：`whenIdle` 的回调恰好被调用一次。拆除时 `clearIdleWaiters` **结算**等待者，
     * 重试循环因此走完（`send()` 在拆除后 reject → 收敛为 `unavailable`），
     * `reconnectInFlight` 归位。若只是把等待者标记为 settled 而不 resolve，
     * 这个 promise 会永不结算。
     */
    await vi.waitFor(() => expect(session.client.reconnectPending).toBe(false));
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
    void play;
  });
});

describe('⑥ 13004 的恢复通道是 game.resync，**不是** game.reconnect（§6.5 逐字）', () => {
  it('动作被拒 13004 → 同步触发 game.resync，且全程没有新的 game.reconnect', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT, message: 'mismatch' });
    await expect(play).resolves.toMatchObject({ status: 'sent', code: ErrCode.VERSION_CONFLICT });

    // 处置来自 CLIENT_ACTION 表的 REFRESH_SNAPSHOT 分支 → game.resync（不是 game.reconnect）
    await vi.waitFor(() => expect(socket.emittedOf('game.resync')).toHaveLength(1));
    expect(socket.emittedOf('game.resync')[0]!.env.payload).toEqual({});
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
  });

  it('§6.5 规定的「已同步到最新状态」提示真的出现在会话 notice 里', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;

    // 刷新成功才提示——所以 ack 必须带回更新的快照
    socket.emittedOf('game.resync')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4) }),
    });

    await vi.waitFor(() =>
      expect(session.notice.value?.text).toBe('已同步到最新状态，请重新操作。'),
    );
    expect(session.notice.value?.level).toBe('info');
    expect(store.currentVersion).toBe(4);
  });

  it('CAS 动作成功但 state_update 迟迟不来（超时兜底）→ 不得被误报成「ack 丢失」', async () => {
    const { socket, store, session, signals } = productionSession();
    vi.useFakeTimers();
    try {
      seatedAtVersion3(socket, store);

      const play = session.client.send('game.play', { cards: makeCards(3) });
      // 服务端明确回了成功，此后一直不发 state_update
      socket.emittedOf('game.play')[0]!.ack(null, { code: 0 });
      await vi.advanceTimersByTimeAsync(6000);
      await play;

      // 队列被兜底释放，但**不能**被当成「ack 丢失」而报重连失败
      expect(session.client.busy).toBe(false);
      expect(signals.some((s) => s.kind === 'snapshot_unavailable')).toBe(false);
      expect(store.currentVersion).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('game.resync 的 ack 立即释放串行队列（不需要等 state_update）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;

    // 刷新快照的请求此时正在途，所以它自己也占着队列（M06：一次只有一个在途请求）
    expect(session.client.busy).toBe(true);
    const resync = socket.emittedOf('game.resync')[0]!;
    resync.ack(null, { code: 0, data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4) }) });

    await vi.waitFor(() => expect(store.currentVersion).toBe(4));
    // 快照 ack 一到就释放队列 → 用户可以立刻重新发起操作（§6.5：由用户重新发起操作）
    expect(session.client.busy).toBe(false);

    const again = session.client.send('game.play', { cards: makeCards(3) });
    await vi.waitFor(() => expect(socket.emittedOf('game.play')).toHaveLength(2));
    socket.emittedOf('game.play')[1]!.ack(null, { code: 0 });
    await expect(again).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('CLIENT_ACTION 表把 13004/13007/13009 都登记为 REFRESH_SNAPSHOT（处置只能来自表）', () => {
    for (const code of [
      ErrCode.VERSION_CONFLICT,
      ErrCode.ACTION_TIMEOUT,
      ErrCode.GAME_NOT_STARTED,
    ]) {
      expect(CLIENT_ACTION[code]).toBe(ClientAction.REFRESH_SNAPSHOT);
      expect(CLIENT_ACTION[code]).not.toBe(ClientAction.RECONNECT);
    }
  });
});

describe('⑥ 自激守卫：快照类请求自身的 REFRESH_SNAPSHOT 失败不再触发 resync（规格 v1.1 §2.6）', () => {
  it('game.resync 自身收到 13009 ⇒ 不再发出第二条 game.resync，且无「状态冲突」提示', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const r = session.client.send('game.resync', {});
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED });
    await r;

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
    expect(session.notice.value?.text ?? '').not.toContain('状态冲突');
  });

  it('game.reconnect 自身收到 13009（waiting 房同页抖动）⇒ 不发 resync（风暴起点被拆除）', async () => {
    const { socket, store } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitConnect(); // 非首次连接 → 自动 emit game.reconnect
    socket.emittedOf('game.reconnect')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED });
    await vi.waitFor(() => expect(store.currentVersion).toBe(3));

    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });

  it('负对照：动作请求的 13004 仍触发 game.resync（§6.5 通道不受守卫影响）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('负对照：resync 自身收到 13010 → BACK_TO_LOBBY 照常派发（白名单外不拦）', async () => {
    const { socket, store, session, visited } = fresh(); // fresh() 已含 trackNavigation
    seatedAtVersion3(socket, store);

    const r = session.client.send('game.resync', {});
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING });
    await r;

    expect(visited).toContain('lobby');
  });

  it('迟到 ack（无在途请求、type 未知）⇒ 照常派发一次且自终止（残余 ≤1）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    session.client.handleAck({ code: ErrCode.GAME_NOT_STARTED }); // type 未知 → 照常派发
    await vi.waitFor(() => expect(socket.emittedOf('game.resync')).toHaveLength(1));
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED }); // 自身 13009 → 被拦
    await new Promise((res) => setTimeout(res, 0));

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('迟到 ack（无在途请求）但 type 已知为快照类 ⇒ 守卫生效，不再发 resync', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    // 与上一条互补：type 已知（game.resync 是快照类请求）⇒ isSelfExcitedRefresh 成立 ⇒ 拦下
    session.client.handleAck({ type: 'game.resync', code: ErrCode.GAME_NOT_STARTED });
    await new Promise((res) => setTimeout(res, 0));

    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });
});

describe('⑥ 重连撞上在途请求：有界重试，不得静默丢弃（修复轮 1 / I1）', () => {
  it('connect 时已有在途请求 → 等它结算后**重试一次**并真的 emit game.reconnect', async () => {
    const { socket, store, session } = productionSession();
    seatedAtVersion3(socket, store);

    // 硬中断场景：连接断了但**没有**观测到 `disconnect`，在途请求仍在（socket.io 缓冲的 emit）
    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emitConnect(); // 非首次 → 触发重连，但队列被占

    // 队列被占：此刻**不能** emit，但也不能就此丢掉重连
    await Promise.resolve();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    // 在途请求结算 → `13004` 的 `game.resync` 先拿槽位（契约强制），重连让位等待
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;
    expect(socket.emittedOf('game.resync')).toHaveLength(1);
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    // resync 的 ack 让队列再次空下来 → 被唤醒的重试终于发出 `game.reconnect`
    socket.emittedOf('game.resync')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });
    await vi.waitFor(() => expect(socket.emittedOf('game.reconnect')).toHaveLength(1));
    expect(socket.emittedOf('game.reconnect')[0]!.env.payload).toEqual({ lastVersion: 3 });

    // ack 回来后照样能恢复
    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });
    await vi.waitFor(() => expect(store.currentVersion).toBe(4));
    session.client.destroy();
  });

  it('13004 的 game.resync **必须**发出；重连让出优先级但**不**被永久丢弃（R15）', async () => {
    const { socket, store, session, signals } = productionSession();
    seatedAtVersion3(socket, store);

    // 硬中断 + 一个在途的 CAS 动作
    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emitConnect();
    await Promise.resolve();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    /**
     * 这个 ack 同时做两件事：释放队列（唤醒重试）**并**同步派发 13004 → game.resync。
     * 契约强制要求 resync 拿到槽位（§6.5），所以重试走电平触发的 `whenIdle` 让位，
     * 等 resync 的 ack 再次释放队列时才发出。
     */
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;

    /**
     * ① 契约强制的恢复通道**必须**发出（§6.5：`13004` 的唯一处置是 `game.resync`）。
     *    上一版设计让重试同步抢槽位，resync 会被串行队列挡下并**静默丢弃**——这是本次要修的。
     *    它也**优先于**重连拿到槽位（`dispatchAck` 把 `CLIENT_ACTION` 派发插在
     *    「队列已空」与「唤醒重试」之间）。
     */
    expect(socket.emitted.map((e) => e.type)).toContain('game.resync');
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    /**
     * ② 重连**没有**被永久丢弃：resync 的 ack 再次让队列空下来时，等待者被唤醒并重试成功。
     *    （两个请求的先后不是契约；契约要求的是 resync 必须发生、且重连不得消失。）
     */
    socket.emittedOf('game.resync')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });
    await vi.waitFor(() => expect(socket.emittedOf('game.reconnect')).toHaveLength(1));

    // ③ 两条请求的 ack 都能正常结算、状态推进、队列释放
    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 4, seat: 1, hand: makeCards(3, 4), roomCode: 'ROOM5' }),
    });
    await vi.waitFor(() => expect(session.client.busy).toBe(false));
    expect(store.currentVersion).toBe(4);
    expect(signals.some((s) => s.kind === 'snapshot_unavailable')).toBe(false);
  });

  it('快照请求始终没有应答 → emit snapshot_unavailable 并给用户提示，不静默', async () => {
    const { socket, store, notice, visited, signals } = productionSession();
    // 必须在创建 safetyTimer **之前**装上假时钟，否则计时器挂在真实时钟上，推进无效果
    vi.useFakeTimers();
    try {
      seatedAtVersion3(socket, store);

      socket.emitDisconnect('transport close');
      socket.emitConnect();

      // 重连请求真的发出去了，但服务端永远不回 ack（比「被队列挡住」更常见的丢包场景）
      expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(6000);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() =>
      expect(signals.some((s) => s.kind === 'snapshot_unavailable')).toBe(true),
    );
    expect(notice.value?.text).toContain('未能同步最新状态');
    // 面向玩家的文案不得含内部术语（同「连接已恢复」用例的判别力）。
    expect(notice.value!.text).not.toMatch(/socket\.io|M03|lastVersion|快照/);
    // 只提示，不做导航（宁可留在原地，也不要跳到空牌桌）
    expect(visited).not.toContain('table');
  });

  it('destroy() 取消挂起的重试：拆除后不得再冒出 game.reconnect（R19）', async () => {
    const { socket, store, session } = productionSession();
    seatedAtVersion3(socket, store);

    // 在途请求占住队列 → 重连的重试注册了一个等待者
    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emitConnect();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);

    session.client.destroy();

    // 拆除后即使队列被腾空（ack 回来），等待者也不得再发请求
    socket.emittedOf('game.play')[0]!.ack(null, { code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
    // 拆除后 `send()` 明确拒绝（不是伪装成「稍后重试」），也不 emit
    await expect(session.client.send('game.reconnect', { lastVersion: 3 })).rejects.toThrow(
      /已拆除/,
    );
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
    void play;
  });

  it('快照类请求也有 ack 超时兜底：ack 丢了不会永久占死队列（I1c）', async () => {
    const { socket, store, session } = fresh();
    vi.useFakeTimers();
    try {
      seatedAtVersion3(socket, store);

      socket.emitDisconnect('transport close');
      socket.emitConnect();
      expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
      expect(session.client.busy).toBe(true);

      // ack 永不返回 → safetyTimer 兜底释放队列
      await vi.advanceTimersByTimeAsync(6000);
      expect(session.client.busy).toBe(false);
      expect(session.client.reconnectPending).toBe(false);

      // `reconnectInFlight` 不再永久为真 → 下一次 connect 仍然能重连
      socket.emitConnect();
      expect(socket.emittedOf('game.reconnect')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('⑥ 快照 ack 的三种 version 判定（§6.2 / M02 / M08，两条路径共用）', () => {
  function makeClient(currentVersion: () => number, socket = new FakeSocket()) {
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => socket,
      currentVersion,
    });
    return { socket, client };
  }

  it('version > 当前 → 应用', async () => {
    const { socket, client } = makeClient(() => 5);
    const snapshots = vi.fn();
    client.onSnapshot(snapshots);

    const done = client.reconnect(5);
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 6 }) });

    await expect(done).resolves.toEqual({ status: 'applied', version: 6 });
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(snapshots.mock.calls[0]![1]).toBe('reconnect_ack');
  });

  it('version === 当前 → 丢弃（不重复应用、不重连）', async () => {
    const { socket, client } = makeClient(() => 5);
    const snapshots = vi.fn();
    const reconnects = vi.fn();
    client.onSnapshot(snapshots);
    client.onReconnect(reconnects);

    const done = client.reconnect(5);
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 5 }) });

    await expect(done).resolves.toEqual({ status: 'discarded', version: 5 });
    expect(snapshots).not.toHaveBeenCalled();
    expect(reconnects).not.toHaveBeenCalled();
  });

  it('version < 当前 → 回退信号（M08：主动重连，不做本地修复）', async () => {
    const { socket, client } = makeClient(() => 9);
    const snapshots = vi.fn();
    const reasons: ReconnectReason[] = [];
    client.onSnapshot(snapshots);
    client.onReconnect((r) => reasons.push(r));

    const done = client.resync();
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 4 }) });

    await expect(done).resolves.toEqual({ status: 'rollback', version: 4 });
    expect(snapshots).not.toHaveBeenCalled();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: 'version_rollback', version: 4 });
  });

  it('game.resync 与 game.reconnect 共用同一套判定', async () => {
    let current = 5;
    const { socket, client } = makeClient(() => current);

    const same = client.resync();
    expect(socket.lastRequest()!.type).toBe('game.resync');
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 5 }) });
    await expect(same).resolves.toEqual({ status: 'discarded', version: 5 });

    const older = client.resync();
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 4 }) });
    await expect(older).resolves.toEqual({ status: 'rollback', version: 4 });

    current = 5;
    const newer = client.resync();
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 7 }) });
    await expect(newer).resolves.toEqual({ status: 'applied', version: 7 });
  });

  it('推送快照出现 version 回退 → store 判定回退并主动重连（M08）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    // 服务端推来一个更旧的快照 → store 判定回退 → runtime.reconnect → game.reconnect
    socket.push({
      type: 'game.state_update',
      version: 2,
      payload: playerViewFixture({ version: 2, seat: 1, hand: makeCards(3), roomCode: 'ROOM5' }),
    });

    await vi.waitFor(() => expect(socket.emittedOf('game.reconnect')).toHaveLength(1));
    expect(socket.emittedOf('game.reconnect')[0]!.env.payload).toEqual({ lastVersion: 3 });
    expect(store.rollback).toMatchObject({ fromVersion: 3, incomingVersion: 2 });
    // 「快照回退」的提示来自 useGameSession.applySnapshot 的回滚分支（Task 2：中性文案）
    await vi.waitFor(() =>
      expect(session.notice.value?.text).toBe('牌局状态有更新，正在同步…'),
    );

    // 重连请求本身占着串行队列，直到 ack 到达
    expect(session.client.busy).toBe(true);
    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 5, seat: 1, hand: makeCards(3, 4) }),
    });
    await vi.waitFor(() => expect(session.client.busy).toBe(false));
    await vi.waitFor(() => expect(store.currentVersion).toBe(5));
  });

  it('重连 ack 带回更旧的快照 → 判定为回退（不本地修复），视图保持已应用的那份', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const signals: ReconnectReason[] = [];
    session.client.onReconnect((r) => signals.push(r));

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);

    // 服务端回来的快照比本地已应用的更旧 → M08 回退（不做本地修复）
    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 2, seat: 1, hand: makeCards(3), roomCode: 'ROOM5' }),
    });

    // 回退信号必须到达 UI（不能被去抖窗口吞掉）。它由 ack 的 version 判定发出，
    // 抢在 `handleSocketReconnect` 的成功信号之前占住窗口，于是成功信号被**抑制但记住**，
    // 在窗口结束时补发——两者最终都必须到达。
    await vi.waitFor(
      () =>
        expect(signals.map((s) => s.kind)).toEqual(
          expect.arrayContaining(['version_rollback', 'socket_reconnect']),
        ),
      { timeout: RECONNECT_DEBOUNCE_MS + 2000 },
    );
    expect(signals.find((r) => r.kind === 'version_rollback')!.version).toBe(2);
    // 「不做本地修复」：视图仍是已应用的那份（version 3），没有被旧快照覆盖
    expect(store.view?.version).toBe(3);
    expect(store.currentVersion).toBe(3);
  });
});

describe('⑥ 13010 / 13005 → 回大厅（CLIENT_ACTION 的 BACK_TO_LOBBY）', () => {
  it('表里 13010 与 13005 都映射到 BACK_TO_LOBBY', () => {
    expect(CLIENT_ACTION[ErrCode.RECONNECT_RECORD_MISSING]).toBe(ClientAction.BACK_TO_LOBBY);
    expect(CLIENT_ACTION[ErrCode.GAME_OVER]).toBe(ClientAction.BACK_TO_LOBBY);
  });

  it('重连 ack 13010 → 回大厅 + store.reset() + 提示，且不应用任何快照', async () => {
    const { socket, store, session, auth, visited } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket
      .lastRequest()!
      .ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING, message: 'reconnect record missing' });

    await vi.waitFor(() => expect(auth.page).toBe('lobby'));
    // 文案来自 code → 文案表（2026-10-13 起 13010 已登记中文条目，不再落调试兜底串）
    expect(session.notice.value?.text).toContain('没有可恢复的对局');
    // 失败不得被当成成功：没有快照可应用
    expect(store.lastSnapshotOutcome).toBeNull();
    // 回大厅的处置清空了对局渲染状态
    expect(store.view).toBeNull();
    expect(store.roomCode).toBeNull();
    expect(visited).toContain('lobby');
  });

  it('重连 ack 13005（对局已结束）→ 同样回大厅', async () => {
    const { socket, store, auth, session } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket.lastRequest()!.ack(null, { code: ErrCode.GAME_OVER, message: 'game ended' });

    await vi.waitFor(() => expect(auth.page).toBe('lobby'));
    expect(store.view).toBeNull();
    expect(session.client.busy).toBe(false);
  });

  /**
   * 终审 F3（K1 文案覆盖 11003 全部可见面）：入队/join ack 落到 `back_to_lobby` 时，
   * 11003 此前播报的是诊断串（`[11003] back_to_lobby — 用户已被封禁`）——玩家看不懂。
   * 现在改用与登录路径**同源**的 K1 全串（`copy.ts` 的 `authErrorMessage`）。
   */
  it('终审 F3：ack 11003（封禁）⇒ back_to_lobby 文案 = K1 全串（不带 [11003] 诊断串）', async () => {
    const { socket, session, signals } = productionSession();

    void session.client.send('room.match', { mode: 'random', baseScore: 15 });
    socket.lastRequest()!.ack(null, { code: ErrCode.USER_BANNED, message: '用户已被封禁' });

    await vi.waitFor(() => expect(signals.some((s) => s.kind === 'back_to_lobby')).toBe(true));
    const sig = signals.find((s) => s.kind === 'back_to_lobby')!;
    expect(sig.message).toBe('该账号已被封禁，如有异议请联系客服');
    expect(session.notice.value?.text).toBe('该账号已被封禁，如有异议请联系客服');
    expect(session.notice.value?.text, '不得再呈诊断串').not.toContain('[11003]');
    expect(session.notice.value?.text).not.toContain('back_to_lobby');
    expect(session.notice.value?.text, '以客户端 K1 文案为准：不用服务端 message').not.toContain(
      '用户已被封禁',
    );
  });

  /**
   * 负对照（Task 1 反转 → Task 2 落实）：10002 已进入统一固定文案表
   *（「登录状态已失效，请重新登录」）⇒ `back_to_lobby` 分支不再输出诊断串
   *（`[10002] back_to_lobby — …`）。诊断串只允许进 reporter/日志。
   */
  it('未登记文案的码（10002）显示中性文案，不再输出诊断串', async () => {
    const { socket, session } = productionSession();

    void session.client.send('room.match', { mode: 'random', baseScore: 15 });
    socket.lastRequest()!.ack(null, { code: ErrCode.UNAUTHENTICATED, message: 'missing auth.token' });

    await vi.waitFor(() => expect(session.notice.value?.text ?? '').not.toBe(''));
    expect(session.notice.value?.text).toBe('登录状态已失效，请重新登录');
    expect(session.notice.value?.text).not.toContain('[10002]');
  });

  /**
   * 11004（USER_NOT_FOUND）在 `copy.ts` 属 **message-first**：服务端 message 非空则原样透传、
   * 空则用 `FALLBACK_COPY`（「该账号不存在，请先注册」）。Task 2 起 `back_to_lobby`
   * 统一走 `playerMessage` ⇒ 本用例从「诊断串」负对照改为「message-first 透传」正对照
   *（诊断串面已由 10002 用例钉住；Task 1 把负对照样本从 10002 改成 11004 的形态到此收口）。
   */
  it('11004（message-first）：back_to_lobby 文案透传服务端 message，不带诊断串', async () => {
    const { socket, session } = productionSession();

    void session.client.send('room.match', { mode: 'random', baseScore: 15 });
    socket.lastRequest()!.ack(null, { code: ErrCode.USER_NOT_FOUND, message: 'missing auth.token' });

    await vi.waitFor(() => expect(session.notice.value?.text ?? '').not.toBe(''));
    expect(session.notice.value?.text).toBe('missing auth.token');
    expect(session.notice.value?.text).not.toContain('[11004]');
    expect(session.notice.value?.text).not.toContain('back_to_lobby');
  });

  it('13010 的处置 notice 不得被 snapshot_unavailable 覆盖，也不得发该信号（R16/N1）', async () => {
    const { socket, store, session, signals } = productionSession();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket.lastRequest()!.ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING, message: 'gone' });

    await vi.waitFor(() => expect(signals.some((s) => s.kind === 'back_to_lobby')).toBe(true));
    // 非 0 的 ack 是**确定答复**：不得被当成「没取回快照」
    expect(signals.some((s) => s.kind === 'snapshot_unavailable')).toBe(false);
    expect(session.notice.value?.text).toContain('没有可恢复的对局');
    expect(session.notice.value?.text).not.toContain('未能同步最新状态');

    // 等到所有异步续体都跑完，notice 依然是处置写的那条
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DEBOUNCE_MS + 300));
    expect(session.notice.value?.text).toContain('没有可恢复的对局');
    expect(session.notice.value?.text).not.toContain('未能同步最新状态');
  });

  it('13010 全程没有 emit 过 game.resync（两条路径不得互相冒充）', async () => {
    const { socket, store, auth } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    socket.lastRequest()!.ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING });

    await vi.waitFor(() => expect(auth.page).toBe('lobby'));
    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });
});

describe('⑥ 陈旧导航守卫：补发的信号不得把用户拽回空牌桌（修复轮 1 / I2）', () => {
  it('socket_reconnect 只在快照到手后才发 → 13010 时根本不会发', async () => {
    const { socket, store, signals } = productionSession();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();
    // 失败的重连：`socket_reconnect` 不应出现（它会让 UI 回牌桌）
    socket.lastRequest()!.ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING });

    await vi.waitFor(() => expect(signals.some((s) => s.kind === 'back_to_lobby')).toBe(true));
    expect(signals.some((s) => s.kind === 'socket_reconnect')).toBe(false);
    expect(useAuthStore().page).toBe('lobby');

    // 去抖窗口（1s）过后也不得冒出 socket_reconnect——那会把用户拽回空牌桌
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DEBOUNCE_MS + 300));
    expect(signals.some((s) => s.kind === 'socket_reconnect')).toBe(false);
    expect(useAuthStore().page).toBe('lobby');
  });

  it('socket_reconnect 被停放后补发时，若 store 已被 reset 则不得 navigate(table)（R17）', async () => {
    const { socket, store, session, auth, visited } = productionSession();
    seatedAtVersion3(socket, store);

    /**
     * 这条用例必须走**真实的 socket 重连路径**（`handleSocketReconnect`），
     * 否则 `socket_reconnect` 根本不会被发出、也就无所谓「被停放」。
     *
     * 场景：重连的 ack 带回**更旧**的快照 → `applySnapshotAck` 先发 `version_rollback`，
     * 它占住 1 秒去抖窗口；紧随其后的 `socket_reconnect` 因此被停进
     * `pendingReconnectReason`，要等窗口结束才补发。
     */
    socket.emitDisconnect('transport close');
    socket.emitConnect();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);

    /**
     * **结构性**证据（R59 修复轮 2）：不再拿「两次 `Date.now()` 之差」与常量比较。
     *
     * 为什么原来的写法必须废掉，而不是加大容差：
     *  - `Date.now()` 之差 = 观测点抖动 + 「定时器被排到哪个时机才真正跑」的调度延迟。
     *    单文件空载时它落在 1000ms 附近；`turbo run --force` 并发 29 个任务时实测到 **997ms**
     *    （Node 的 `setTimeout` 不保证不早触发，负载下还会更晚），而晚多少是**无上界**的。
     *  - 所以「差 >= 常量 - N」这种形状无论 N 取多大都只是猜边界：N 太小会假红，N 太大会失去判别力。
     *
     * 改成直接观测**去抖机制本身**，两件事都不依赖墙钟之差：
     *  ① 排给去抖窗口的定时器延时**恰好**是 `RECONNECT_DEBOUNCE_MS`
     *     （`emitReconnect` 里 `setTimeout(…, RECONNECT_DEBOUNCE_MS)` 的实参，直接记录）；
     *  ② `socket_reconnect` **没有**在窗口结束前被分派（下面用序号比较，不用时间）。
     * 若去抖失效（窗口内的后到信号立即分派），② 立即失败；若延时被改小，① 失败。
     */
    const realSetTimeout = globalThis.setTimeout;
    const debounceDelays: number[] = [];
    /** 分派序号：在每个信号被分派时自增，用来判断先后（不依赖任何时间值）。 */
    let seq = 0;
    const delivered: { kind: string; seq: number }[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === RECONNECT_DEBOUNCE_MS) debounceDelays.push(delay);
      return realSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout);

    session.client.onReconnect((r) => delivered.push({ kind: r.kind, seq: seq++ }));

    socket.emittedOf('game.reconnect')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 2, seat: 1, hand: makeCards(3), roomCode: 'ROOM5' }),
    });

    // 回退信号立刻发出并把窗口占住 → 随后它被 `reset()` + 回大厅
    await vi.waitFor(() => expect(delivered.some((d) => d.kind === 'version_rollback')).toBe(true));
    store.reset();
    auth.navigate('lobby');
    const tableVisitsAfterReset = visited.filter((p) => p === 'table').length;

    /** 判据 ①：去抖窗口确实**按契约的常量**被排上了。 */
    expect(debounceDelays).toContain(RECONNECT_DEBOUNCE_MS);

    /**
     * 判据 ②：`socket_reconnect` 此刻**尚未**被分派 —— 它确实被停放了。
     * 若它改成立即发出（去抖失效），这里立刻失败；而原用例即使守卫失效也可能侥幸通过。
     */
    expect(delivered.some((d) => d.kind === 'socket_reconnect')).toBe(false);

    // 窗口结束 → 被停放的 `socket_reconnect` 补发。守卫必须拦住这次导航。
    await vi.waitFor(() => expect(delivered.some((d) => d.kind === 'socket_reconnect')).toBe(true), {
      timeout: RECONNECT_DEBOUNCE_MS + 2000,
    });

    /** 判据 ③：**顺序**上确实在 `version_rollback` 之后（序号比较，不碰墙钟）。 */
    const rollbackSeq = delivered.find((d) => d.kind === 'version_rollback')!.seq;
    const reconnectSeq = delivered.find((d) => d.kind === 'socket_reconnect')!.seq;
    expect(reconnectSeq).toBeGreaterThan(rollbackSeq);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(visited.filter((p) => p === 'table').length).toBe(tableVisitsAfterReset);
    expect(auth.page).toBe('lobby');
    expect(store.roomCode).toBeNull();
    expect(store.view).toBeNull();
  });

});

describe('⑥ 出站信封不含 type / meta（§6.2 扁平线格式）', () => {
  const AUTHORITATIVE_FIELDS = ['baseVersion', 'payload', 'reqId', 'timestamp'];

  it('game.reconnect 的 emit 载荷只有四个权威字段', () => {
    const { socket, store } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitDisconnect('transport close');
    socket.emitConnect();

    const reconnect = socket.emittedOf('game.reconnect')[0]!;
    expect(Object.keys(reconnect.env).sort()).toEqual(AUTHORITATIVE_FIELDS);
    expect(reconnect.env).not.toHaveProperty('type');
    expect(reconnect.env).not.toHaveProperty('meta');
  });

  it('game.resync 的 emit 载荷只有四个权威字段', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const done = session.client.resync();
    const resync = socket.emittedOf('game.resync')[0]!;
    expect(Object.keys(resync.env).sort()).toEqual(AUTHORITATIVE_FIELDS);
    expect(resync.env).not.toHaveProperty('type');
    expect(resync.env).not.toHaveProperty('meta');
    resync.ack(null, { code: 0, data: playerViewFixture({ version: 4 }) });
    await done;
  });

  it('日常请求（game.play）同样不带 type / meta', () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    void session.client.send('game.play', { cards: makeCards(3) });

    const play = socket.emittedOf('game.play')[0]!;
    expect(Object.keys(play.env).sort()).toEqual(AUTHORITATIVE_FIELDS);
  });
});

describe('⑥ 对局夹具不自带别名（修复轮 1 / Minor）', () => {
  it('playerViewFixture 不就地改写调用方传入的 cardCounts', () => {
    const shared: [number, number, number] = [17, 17, 17];
    playerViewFixture({ seat: 1, hand: makeCards(1, 2, 3), cardCounts: shared });
    expect(shared).toEqual([17, 17, 17]);

    // 两个 fixture 共用同一个数组时不得互相影响
    //（修复前 `a` 写入的 3 会被 `b` 读成自己的初始值，正是别名 bug 的表现）
    const a = playerViewFixture({ seat: 1, hand: makeCards(1, 2, 3), cardCounts: shared });
    const b = playerViewFixture({ seat: 0, hand: makeCards(9), cardCounts: shared });
    expect(a.cardCounts).toEqual([17, 3, 17]);
    expect(b.cardCounts).toEqual([1, 17, 17]);
    expect(shared).toEqual([17, 17, 17]);
  });
});
