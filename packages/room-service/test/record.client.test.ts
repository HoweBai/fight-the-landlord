/**
 * `RecordClient` 的**传输层契约**（记录片 T5 / 设计 D2 —— room → user 的 `record.write` 边，
 * user-service **重挂 TCP 3101** 后的唯一消费者）。
 *
 * 与 `config.client.test.ts` 同族同纪律（R70/R221）：判据走**真实 pipeline**
 * （假 `ClientProxy.send()` 返回可控 Observable：`of(信封)` / `throwError` / `NEVER`），
 * 而不是只断言「调了 `send()`」—— 后者在「超时没接上」「信封没解」时照样绿。
 *
 * 本文件钉住四条性质：
 *  ① 打的是 `RPC_PATTERNS.recordWrite`，载荷 = 请求字段**逐字** + meta（无 ALS ⇒ 展开
 *     `{}` ⇒ 载荷不变 —— R1104/R1105 的省略语义）；
 *  ② 成功返回 `data.written`（`false` = 幂等命中，**非错误**）；
 *  ③ 🔴 **失败一律抛** —— 下游 `{ok:false}` 的 5 位码原样成为 `RecordClientError.code`；
 *     传输故障 / 超时 ⇒ `10007` + **固定文案**（原因只进日志，Task 3g 修复 I2 同族）；
 *  ④ **不重试**（设计 D2 明文；§4.3 的重试表不含这条边）+ 超时 **3s**。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import {
  ErrCode,
  RPC_PATTERNS,
  type RecordWriteRequest,
  type SettlementResult,
} from '@fight-the-landlord/protocol';
import {
  RECORD_WRITE_TIMEOUT_MS,
  RecordClient,
  RecordClientError,
} from '../src/gateway/record.client';
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

/** 可控的假 `ClientProxy`（照 `config.client.test.ts` 的同名工厂）。 */
function fakeProxy(handler: (call: SendCall, index: number) => unknown) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

const RESULT: SettlementResult = {
  roomCode: 'ROOM1',
  baseScore: 15,
  winner: 'landlord',
  landlordSeat: 0,
  farmerSeats: [1, 2],
  multiplier: 2,
  spring: 'none',
  landlordScoreChange: 30,
  farmerScoreChange: -15,
};

/** 一个形状真实的 `record.write` 请求（组装侧产物的样本）。 */
const REQUEST: RecordWriteRequest = {
  roomCode: 'ROOM1',
  gameVersion: 20,
  mode: 'random',
  baseScore: 15,
  result: RESULT,
  seats: [
    { seat: 0, userId: 'alice', isRobot: false, robotId: null, hand: '11'.repeat(17) },
    { seat: 1, userId: null, isRobot: true, robotId: 'bot-int-1', hand: '33'.repeat(17) },
    { seat: 2, userId: null, isRobot: true, robotId: 'bot-int-2', hand: '22'.repeat(17) },
  ],
  bottomCards: '4f'.repeat(3),
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_600_000,
};

describe('RecordClient.write() 的 RPC 契约（pattern 名 + 载荷 + 解包）', () => {
  it('打 RPC_PATTERNS.recordWrite，载荷 = 请求逐字 + meta（无 ALS ⇒ 空展开，`toEqual` 恰好比对）', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { written: true } }));

    await expect(new RecordClient(proxy).write(REQUEST)).resolves.toBe(true);

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.recordWrite, data: REQUEST }]);
  });

  it('`data.written=false`（幂等命中）**不是错误** —— 解析为 false、不抛', async () => {
    const { proxy } = fakeProxy(() => of({ ok: true, data: { written: false } }));

    await expect(new RecordClient(proxy).write(REQUEST)).resolves.toBe(false);
  });
});

describe('RecordClient.write() 的错误语义（§11.2 / R220 / 设计 D2）', () => {
  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 RecordClientError.code（业务文案逐字保留）', async () => {
    const { proxy } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.BAD_PARAM, message: 'record.write 载荷不合法：seats 必须恰 3 条' }),
    );

    await expect(new RecordClient(proxy).write(REQUEST)).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
      message: 'record.write 载荷不合法：seats 必须恰 3 条',
    });
  });

  it('🔴 传输层故障 ⇒ 抛 10007 + 固定文案（原因只进日志、不进消息）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.28.0.9:3101')),
    );

    const err = (await new RecordClient(proxy).write(REQUEST).catch((e: unknown) => e)) as RecordClientError;

    expect(err).toBeInstanceOf(RecordClientError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.9'); // 内部拓扑不得进消息
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3101');
  });

  /**
   * 超时（3s）也是「拿不到应答」⇒ 抛 10007，且**不重试**（恰好 1 次 `send`）。
   *
   * ⚠️ 用假定时器：`NEVER`（永不回包）+ 推进 3s。忘了接 `timeout()` 时本用例会挂到
   * vitest 的用例上限而红（与 `config.client.test.ts` 的超时用例同款）。
   */
  it('超时 ⇒ 10007，且恰好 1 次 send（不重试；设计 D2）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new RecordClient(proxy).write(REQUEST);
      // ⚠️ 断言**先挂上**再推进定时器：否则「超时那一刻的 rejection」会在没人 await 的
      // 窗口里出现（vitest 会把它记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      // 还没到 3s：仍在挂起（证明不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(RECORD_WRITE_TIMEOUT_MS - 100);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      await expectation;
      expect(calls).toHaveLength(1); // 不重试：§4.3 的重试表不含这条边
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * ② 金币场 T5（规格 §3）：`RecordClient.moneyDelta()` —— 与 `write()` **逐字同款**的
 * 传输契约（3s 超时、不重试、`RpcResult` 解包、传输故障 ⇒ 10007 + 固定文案）。
 *
 * 本组只钉三处与 `write()` 不同的面：打的是 `record.moneyDelta`、解包的是
 * `data.matched`（命中座位集合 —— 不是 affectedRows）、超时接在同一预算上。
 */
describe('RecordClient.moneyDelta() 的 RPC 契约（② T5）', () => {
  const REQUEST = {
    roomCode: 'ROOM1',
    gameVersion: 20,
    deltas: [
      { seat: 0, delta: 30 },
      { seat: 1, delta: -15 },
      { seat: 2, delta: 0 },
    ],
  } as const;

  it('打 RPC_PATTERNS.recordMoneyDelta，载荷 = 请求逐字 + meta（无 ALS ⇒ 空展开，`toEqual` 恰好比对）', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { matched: [0, 1, 2] } }));

    const data = await new RecordClient(proxy).moneyDelta({ ...REQUEST, deltas: [...REQUEST.deltas] });

    expect(data).toEqual({ matched: [0, 1, 2] });
    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.recordMoneyDelta, data: { ...REQUEST, deltas: [...REQUEST.deltas] } },
    ]);
  });

  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 RecordClientError.code（业务文案逐字保留）', async () => {
    const { proxy } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.BAD_PARAM, message: 'record.moneyDelta 载荷不合法：deltas 必须恰 3 条' }),
    );

    await expect(
      new RecordClient(proxy).moneyDelta({ ...REQUEST, deltas: [...REQUEST.deltas] }),
    ).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
      message: 'record.moneyDelta 载荷不合法：deltas 必须恰 3 条',
    });
  });

  it('🔴 传输层故障 ⇒ 抛 10007 + 固定文案（原因只进日志、不进消息）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.28.0.9:3101')),
    );

    const err = (await new RecordClient(proxy)
      .moneyDelta({ ...REQUEST, deltas: [...REQUEST.deltas] })
      .catch((e: unknown) => e)) as RecordClientError;

    expect(err).toBeInstanceOf(RecordClientError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE);
    expect(err.message).not.toContain('172.28.0.9');
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3101');
  });

  it('超时 ⇒ 10007，且恰好 1 次 send（不重试；与 write() 同一预算 3s）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new RecordClient(proxy).moneyDelta({ ...REQUEST, deltas: [...REQUEST.deltas] });
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      await vi.advanceTimersByTimeAsync(RECORD_WRITE_TIMEOUT_MS - 100);
      expect(calls).toHaveLength(1); // 未到 3s：仍在挂起（证明 timeout 真的接上了）

      await vi.advanceTimersByTimeAsync(200);
      await expectation;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
