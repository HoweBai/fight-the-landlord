/**
 * `GameClient` 的**传输层契约**（N20/P4 Task 3）。
 *
 * 本文件在 Task 3 之前测的是「出站 HTTP 的完整 URL / method / 头 / `timeout`」（R70 的教训：
 * 替身挡住 HTTP 层 ⇒ 路径写错不会有任何用例失败）。迁移到 TCP RPC 之后，
 * **等价的判据**变成：打的是哪个 **pattern**、载荷**逐字**是什么 ——
 * 「pattern 名写错」与当年的「少写 `/api`」是同一类缺陷（替身不会因此失败，只有真实拓扑才拒）。
 *
 * **语义逐字保留**（§4.3 / R209 / R210 / R220）：
 *  - 超时按 §4.3 分流（start 3000 / snapshot 2000 / view 2000）；
 *  - `game.start` / `game.snapshot` 失败**重试恰好 1 次**；`view` / `action` **不重试**；
 *  - 下游 5 位数字码原样抛成 `GameServiceError.code`；
 *  - `12004` 在 `view()` 里折成 `null`；
 *  - 传输层故障 ⇒ `10007`。
 *
 * ⚠️ **R221**：判据必须走**真实 pipeline**（假 `ClientProxy.send()` 返回可控 Observable：
 * `of(信封)` / `throwError` / `NEVER`），而不是只断言「调了 `send()`」——
 * 后者在「超时没接上」「重试多接了一层」时照样绿。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type Card } from '@fight-the-landlord/protocol';

/** R696：`game.play` 的 `cards` 是 `Card[]`（R697）。本文件只关心透传，故 `s` 取 0。 */
const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));
import {
  GameClient,
  GameServiceError,
  GAME_CLIENT_TIMEOUT_MS,
  RPC_MAX_ATTEMPTS,
  mapHttpStatus,
} from '../src/gateway/game.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/gateway/transport-failure';

/**
 * **M4（`message.router.test.ts` 的成例）**：`Logger.overrideLogger` 是**进程级**的 ——
 * 用后不还原的话，本文件里**后追加**的用例会静默写进一个已经死掉的 sink。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

/** 一次 `proxy.send()` 的调用记录。 */
interface SendCall {
  pattern: string;
  data: unknown;
}

/**
 * 可控的假 `ClientProxy`。
 *
 * `handler` 每次调用都重新求值（`send()` 是冷 Observable 的正常形态），
 * 因此「第一次失败、第二次成功」这类重试判据可以按调用序号返回不同结果。
 */
function fakeProxy(handler: (call: SendCall, index: number) => unknown) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

/** 默认：所有 pattern 都返回 `{ok:true,data:{}}`。 */
function okProxy(data: unknown = {}) {
  return fakeProxy(() => of({ ok: true, data }));
}

describe('GameClient 的 RPC 契约（pattern 名 + 载荷逐字，R70 同类）', () => {
  it('start() → RPC_PATTERNS.gameStart，载荷逐字，信封解包后返回 data', async () => {
    const { proxy, calls } = okProxy({ roomCode: 'ROOM1', state: 'bidding', version: 1 });
    const client = new GameClient(proxy);

    await expect(client.start({ roomCode: 'ROOM1', baseScore: 100 })).resolves.toEqual({
      data: { roomCode: 'ROOM1', state: 'bidding', version: 1 },
    });

    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.gameStart, data: { roomCode: 'ROOM1', baseScore: 100 } },
    ]);
  });

  it('snapshot() → RPC_PATTERNS.gameSnapshot，载荷 `{roomCode}`（旧的内部 HTTP 面已删）', async () => {
    const { proxy, calls } = okProxy({ roomCode: 'ROOM1' });
    await new GameClient(proxy).snapshot('ROOM1');

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.gameSnapshot, data: { roomCode: 'ROOM1' } }]);
  });

  it('view() → RPC_PATTERNS.gameView，载荷**只有** `{roomCode,userId}`（R224：没有 seat）', async () => {
    const { proxy, calls } = okProxy({ roomCode: 'ROOM1', seat: 0 });
    await new GameClient(proxy).view('ROOM1', 'user-1');

    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.gameView, data: { roomCode: 'ROOM1', userId: 'user-1' } },
    ]);
    // R224 的反向判据：载荷里**不得**出现 seat（§4.2：「不由调用方提供」）
    expect(JSON.stringify(calls[0]!.data)).not.toContain('seat');
  });

  it.each(['bid', 'play', 'pass'] as const)(
    "action('%s') → RPC_PATTERNS.gameAction，R219 契约形状（baseVersion 在**顶层**）",
    async (action) => {
      const { proxy, calls } = okProxy({ ok: true });
      await new GameClient(proxy).action('ROOM1', action, 'user-1', { baseVersion: 3 });

      expect(calls).toEqual([
        {
          pattern: RPC_PATTERNS.gameAction,
          data: { roomCode: 'ROOM1', userId: 'user-1', action, payload: {}, baseVersion: 3 },
        },
      ]);
    },
  );

  it('action() 把 payload 的业务字段与 baseVersion **分开**（R219 的顶层字段）', async () => {
    const { proxy, calls } = okProxy({ ok: true });
    await new GameClient(proxy).action('ROOM1', 'play', 'user-1', { cards: asCards([3, 4]), baseVersion: 7 });

    expect(calls[0]!.data).toEqual({
      roomCode: 'ROOM1',
      userId: 'user-1',
      action: 'play',
      payload: { cards: asCards([3, 4]) },
      baseVersion: 7,
    });
  });

  it('§4.3：超时按通道分流（start 3000，snapshot / view / trustee 2000）', () => {
    expect(GAME_CLIENT_TIMEOUT_MS).toEqual({ start: 3000, view: 2000, snapshot: 2000, trustee: 2000 });
  });

  /**
   * 挂机治理 T6（C19）：`game.trustee` 边的传输契约 —— pattern 名、载荷**逐字**
   *（`via` 是判别位，四处转发的取值由 `idle-trustee.router.test.ts` 钉死）、
   * 2s 超时、**不重试**（写边；托管开关虽是幂等的，但重试会多推一次 view —— §4.3 的重试表只覆盖
   * `game.start` / `game.snapshot`）。
   */
  it('trustee() → RPC_PATTERNS.gameTrustee，载荷逐字（含 via），信封解包后返回 data', async () => {
    const { proxy, calls } = okProxy({ version: 7 });
    const client = new GameClient(proxy);

    await expect(client.trustee('ROOM1', 'user-1', true, 'abandon')).resolves.toEqual({ version: 7 });

    expect(calls).toEqual([
      {
        pattern: RPC_PATTERNS.gameTrustee,
        data: { roomCode: 'ROOM1', userId: 'user-1', on: true, via: 'abandon' },
      },
    ]);
  });

  it('trustee() **不重试**（失败一次即抛，调用方 fail-open）', async () => {
    const { proxy, calls } = fakeProxy(() => throwError(() => new Error('down')));
    await expect(new GameClient(proxy).trustee('ROOM1', 'user-1', false, 'reconnect')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    expect(calls).toHaveLength(1);
  });

  it('trustee() 的 2s 超时（NEVER ⇒ 恰 2s 后 10007，且只发一次）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new GameClient(proxy).trustee('ROOM1', 'user-1', true, 'manual');
      const settled = p.catch((e: unknown) => e) as Promise<GameServiceError>;

      await vi.advanceTimersByTimeAsync(GAME_CLIENT_TIMEOUT_MS.trustee - 100);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await expect(settled).resolves.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
      expect(calls).toHaveLength(1); // 不重试
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * §11.2 的错误码映射：R220 的信封把下游 5 位码**原样**带过 RPC 边界。
 */
describe('GameClient 错误码（§11.2 / R220）', () => {
  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 GameServiceError.code', async () => {
    const { proxy } = fakeProxy(() => of({ ok: false, code: ErrCode.VERSION_CONFLICT, message: '版本冲突' }));
    await expect(new GameClient(proxy).snapshot('ROOM1')).rejects.toMatchObject({
      code: ErrCode.VERSION_CONFLICT,
      // ⚠️ **业务文案逐字保留**（Task 3g 修复 I2 的另一半）：这串是下游给客户端**看**的话
      //（`message.router` 的 GameServiceError 分支照实 ack）⇒ **不得**被替换成通用文案。
      // 与下面那条「传输层故障 ⇒ 固定文案」成对：只修传输层，业务错误一字不动。
      message: '版本冲突',
    });
  });

  it('传输层故障（连不上 / 超时）⇒ UPSTREAM_UNAVAILABLE(10007)', async () => {
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));
    await expect(new GameClient(proxy).view('ROOM1', 'user-1')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });

  /**
   * 🔴 **Task 3g 修复 I2**：传输层故障的消息**不得带原因**。
   *
   * 修前 `call()` 抛的是 `` `game-service unavailable: ${reason}` ``，而传输故障下 `reason`
   * 是 `ECONNREFUSED 172.28.0.7:3002` 这类**内部拓扑**；本消息经 `message.router` 的
   * `GameServiceError` 分支**原样 ack** ⇒ 它会被客户端当 toast 弹给玩家。
   * 处置：消息给固定文案（`TRANSPORT_FAILURE_MESSAGE`），详情**只进日志**。
   */
  it('🔴 传输层故障 ⇒ 消息是固定文案（不含原因），原因只进日志', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED 172.28.0.7:3002')));

    const err = (await new GameClient(proxy)
      .view('ROOM1', 'user-1')
      .catch((e: unknown) => e)) as GameServiceError;

    expect(err).toBeInstanceOf(GameServiceError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.7');
    expect(err.message).not.toContain('game-service'); // 服务名同样是内部拓扑
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.7:3002');
  });

  it('`view()` 把 12004（不在房间）折成 null；**其余**错误照抛（含 10007）', async () => {
    const notInRoom = fakeProxy(() => of({ ok: false, code: ErrCode.NOT_IN_ROOM, message: 'nope' }));
    await expect(new GameClient(notInRoom.proxy).view('ROOM1', 'mallory')).resolves.toBeNull();

    const upstream = fakeProxy(() => throwError(() => new Error('down')));
    await expect(new GameClient(upstream.proxy).view('ROOM1', 'user-1')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });

  it('mapHttpStatus 的下游码优先与状态码兜底（§11.2 映射表本身保留）', () => {
    expect(mapHttpStatus(400)).toBe(ErrCode.BAD_PARAM);
    expect(mapHttpStatus(401)).toBe(ErrCode.UNAUTHENTICATED);
    expect(mapHttpStatus(403)).toBe(ErrCode.NOT_IN_ROOM);
    expect(mapHttpStatus(404)).toBe(ErrCode.ROOM_NOT_FOUND);
    expect(mapHttpStatus(409)).toBe(ErrCode.VERSION_CONFLICT);
    expect(mapHttpStatus(503)).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(mapHttpStatus(418)).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(mapHttpStatus(500, 13001)).toBe(13001);
  });
});

/**
 * A7⑤ / R210 / R221：`game.start` 与 `game.snapshot` 失败**重试恰好 1 次**。
 *
 * 前提是接收端**幂等**（§4.3 的「幂等前提」）：`game.start` 同 `roomCode` 复用会话、
 * `game.snapshot` 是纯读。
 *
 * ⚠️ 判据两半都要有（R212②）：
 *  ① 首次失败 ⇒ **同 pattern、同载荷**再发一次；
 *  ② 两次都失败 ⇒ 抛错（由调用方决定降级），**不得**无限重试。
 * 反向对照：`view()` / `action()` **不重试**（不在 §4.3 的重试表里；action 是 CAS）。
 */
describe('A7⑤：game.start / game.snapshot 失败重试 1 次（R210/R221）', () => {
  it('start：首次失败 ⇒ 第二次仍发**同一 pattern 与载荷**（恰好 2 次）', async () => {
    const { proxy, calls } = fakeProxy((_call, index) =>
      index === 0
        ? throwError(() => new Error('ECONNRESET'))
        : of({ ok: true, data: { roomCode: 'ROOM1' } }),
    );

    await expect(new GameClient(proxy).start({ roomCode: 'ROOM1', baseScore: 100 })).resolves.toEqual({
      data: { roomCode: 'ROOM1' },
    });

    expect(calls).toHaveLength(RPC_MAX_ATTEMPTS);
    expect(calls[0]!.pattern).toBe(RPC_PATTERNS.gameStart);
    expect(calls[1]!.pattern).toBe(calls[0]!.pattern);
    expect(calls[1]!.data).toEqual(calls[0]!.data);
  });

  it('snapshot：两次都失败 ⇒ 抛错，且只尝试 2 次', async () => {
    const { proxy, calls } = fakeProxy(() => throwError(() => new Error('down')));

    await expect(new GameClient(proxy).snapshot('ROOM1')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    expect(calls).toHaveLength(2);
  });

  /**
   * ⚠️ **超时也算失败并触发重试**（这是 R221 的「`timeout()` 在 `retry()` 之内 ⇒
   * 每次重试重新计时」的可观测形态）。
   *
   * 用假定时器：第一次 `NEVER`（永不回包）⇒ 3s 超时 ⇒ 第二次成功。
   * 若 `timeout()` 被误放到 `retry()` **之外**，只会有 1 次 `send()` 且总耗时 3s；
   * 若忘了 `timeout()`，本用例会挂到 vitest 的 5s 上限而红。
   */
  it('start：超时（3s）算失败并重试（总耗时 ≈ 3s，共 2 次 send）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy((_call, index) =>
        index === 0 ? NEVER : of({ ok: true, data: { roomCode: 'ROOM1' } }),
      );
      const p = new GameClient(proxy).start({ roomCode: 'ROOM1', baseScore: 100 });

      // 还没到 3s：仍在挂起（证明超时不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(GAME_CLIENT_TIMEOUT_MS.start - 100);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      await expect(p).resolves.toEqual({ data: { roomCode: 'ROOM1' } });
      expect(calls).toHaveLength(RPC_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('view / action **不重试**（不在 §4.3 的重试表里；action 是 CAS）', async () => {
    const { proxy, calls } = fakeProxy(() => throwError(() => new Error('down')));
    const client = new GameClient(proxy);

    await expect(client.view('ROOM1', 'user-1')).rejects.toBeInstanceOf(Error);
    await expect(client.action('ROOM1', 'play', 'user-1', { cards: asCards([3]) })).rejects.toBeInstanceOf(Error);

    expect(calls).toHaveLength(2); // 两次调用各一次，没有额外重试
    expect(calls.map((c) => c.pattern)).toEqual([RPC_PATTERNS.gameView, RPC_PATTERNS.gameAction]);
  });
});
