/**
 * `CurrencyClient` 的**传输层契约**（② 金币场 T4 —— room → currency 的
 * `currency.get` / `currency.apply` 两条边，TCP 3104）。
 *
 * 与 `record.client.test.ts` / `config.client.test.ts` 同族同纪律（R70/R221）：判据走
 * **真实 pipeline**（假 `ClientProxy.send()` 返回可控 Observable：`of(信封)` / `throwError` /
 * `NEVER`），而不是只断言「调了 `send()`」—— 后者在「超时没接上」「信封没解」时照样绿。
 *
 * 钉住的四条性质（逐条对应 consumer 的契约）：
 *  ① 打的是 `RPC_PATTERNS.currencyGet` / `currencyApply`，载荷 = 请求字段**逐字** + meta
 *    （无 ALS ⇒ 展开 `{}` ⇒ 载荷不变 —— R1104/R1105 的省略语义）；
 *  ② 成功解包 `data`（get 的 `balances` / apply 的 `entries`+`replayed`）；
 *  ③ 🔴 **失败一律抛** —— 下游 `{ok:false}` 的 5 位码**原样**成为 `CurrencyServiceError.code`；
 *     传输故障 / 超时 ⇒ `10007` + **固定文案**（原因只进日志）；
 *  ④ **不重试** + 超时 **3s**（规格 §4.3 表：两条边同口径）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, runWithTrace } from '@fight-the-landlord/shared';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyRequest,
  type CurrencyEntryFeeSkipRequest,
  type CurrencyGetRequest,
} from '@fight-the-landlord/protocol';
import {
  CURRENCY_CLIENT_TIMEOUT_MS,
  CurrencyClient,
  CurrencyServiceError,
  currencyClientOptions,
} from '../src/currency/currency.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/gateway/transport-failure';

/**
 * **M4（`record.client.test.ts` 的成例）**：`Logger.overrideLogger` 是**进程级**的 ——
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

/** 可控的假 `ClientProxy`（照 `record.client.test.ts` 的同名工厂）。 */
function fakeProxy(handler: (call: SendCall, index: number) => unknown) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

/** 形状真实的读/写请求（组装侧产物的样本；meta 由 client 自己附加）。 */
const GET_REQUEST: CurrencyGetRequest = { ownerIds: ['u-alice', 'bot-abc'] };
const APPLY_REQUEST: CurrencyApplyRequest = {
  actionId: 'settle:ABC123:7',
  source: 'game_settle',
  entries: [
    { ownerId: 'u-alice', delta: 30 },
    { ownerId: 'u-bob', delta: -15 },
  ],
  refId: 'ABC123:7',
};

describe('CurrencyClient 的 RPC 契约（pattern 名 + 载荷 + 解包）', () => {
  it('get：打 RPC_PATTERNS.currencyGet，载荷 = 请求逐字 + meta（无 ALS ⇒ 空展开，`toEqual` 恰好比对）', async () => {
    const balances = [{ ownerId: 'u-alice', balance: 150, exists: true }];
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { balances } }));

    await expect(new CurrencyClient(proxy).get(GET_REQUEST)).resolves.toEqual({ balances });

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.currencyGet, data: GET_REQUEST }]);
  });

  it('apply：打 RPC_PATTERNS.currencyApply，解包 `entries`/`replayed`（replayed=true 不是错误）', async () => {
    const data = {
      opId: 7,
      actionId: APPLY_REQUEST.actionId,
      entries: [{ ownerId: 'u-alice', balanceAfter: 180 }],
      replayed: true,
    };
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data }));

    await expect(new CurrencyClient(proxy).apply(APPLY_REQUEST)).resolves.toEqual(data);

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.currencyApply, data: APPLY_REQUEST }]);
  });

  it('判据 5 正：ALS 有上下文 ⇒ 载荷带 meta{traceId,reqId,userId}', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { balances: [] } }));

    await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'edge' }, async () => {
      await new CurrencyClient(proxy).get(GET_REQUEST);
    });

    expect(calls).toHaveLength(1);
    expect((calls[0]!.data as { meta?: unknown }).meta).toEqual({
      traceId: 'T9',
      reqId: 'R9',
      userId: 'U9',
    });
  });
});

describe('CurrencyClient 的错误语义（§11.2 / R220）', () => {
  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 CurrencyServiceError.code（业务文案逐字保留）', async () => {
    const { proxy } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.E_INSUFFICIENT_FUNDS, message: '余额不足' }),
    );

    await expect(new CurrencyClient(proxy).apply(APPLY_REQUEST)).rejects.toMatchObject({
      code: ErrCode.E_INSUFFICIENT_FUNDS,
      message: '余额不足',
    });
  });

  it('🔴 传输层故障 ⇒ 抛 10007 + 固定文案（原因只进日志、不进消息）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.28.0.10:3104')),
    );

    const err = (await new CurrencyClient(proxy)
      .get(GET_REQUEST)
      .catch((e: unknown) => e)) as CurrencyServiceError;

    expect(err).toBeInstanceOf(CurrencyServiceError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.10'); // 内部拓扑不得进消息
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.10:3104');
  });

  /**
   * 超时（3s）也是「拿不到应答」⇒ 抛 10007，且**不重试**（恰好 1 次 `send`）。
   *
   * ⚠️ 用假定时器：`NEVER`（永不回包）+ 推进 3s。忘了接 `timeout()` 时本用例会挂到
   * vitest 的用例上限而红（与 `record.client.test.ts` 的超时用例同款）。
   */
  it('超时 ⇒ 10007，且恰好 1 次 send（不重试；规格 §4.3 表）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new CurrencyClient(proxy).apply(APPLY_REQUEST);
      // ⚠️ 断言**先挂上**再推进定时器：否则「超时那一刻的 rejection」会在没人 await 的
      // 窗口里出现（vitest 会把它记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      // 还没到 3s：仍在挂起（证明不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(CURRENCY_CLIENT_TIMEOUT_MS - 100);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      await expectation;
      expect(calls).toHaveLength(1); // 不重试
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CurrencyClient.entryFeeSkip（本片发送侧新边）', () => {
  const SKIP_REQUEST: CurrencyEntryFeeSkipRequest = {
    roomCode: 'ABC123',
    ownerId: 'u-alice',
    seat: 0,
    baseScore: 15,
    feeAmount: 1,
    reason: 'insufficient_funds',
  };

  it('打 RPC_PATTERNS.currencyEntryFeeSkip，载荷 = 请求逐字 + meta（无 ALS ⇒ 空展开）；解包 {inserted}', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { inserted: true } }));

    await expect(new CurrencyClient(proxy).entryFeeSkip(SKIP_REQUEST)).resolves.toEqual({ inserted: true });

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.currencyEntryFeeSkip, data: SKIP_REQUEST }]);
  });

  it('ALS 有上下文 ⇒ 载荷带 meta{traceId}（call() 唯一注入点）；信封 {ok:false} ⇒ 5 位码原样', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { inserted: false } }));
    await runWithTrace({ traceId: 'T9', source: 'edge' }, async () => {
      await new CurrencyClient(proxy).entryFeeSkip(SKIP_REQUEST);
    });
    expect((calls[0]!.data as { meta?: unknown }).meta).toEqual({ traceId: 'T9' });

    const { proxy: bad } = fakeProxy(() => of({ ok: false, code: ErrCode.BAD_PARAM, message: 'reason 非法' }));
    await expect(new CurrencyClient(bad).entryFeeSkip(SKIP_REQUEST)).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
      message: 'reason 非法',
    });
  });
});

describe('currencyClientOptions（§2.13 env 表：唯一读取点 + 默认值）', () => {
  it('默认连 currency-service:3104（env 未设时）', () => {
    const saved = {
      host: process.env.CURRENCY_SERVICE_RPC_HOST,
      port: process.env.CURRENCY_SERVICE_RPC_PORT,
    };
    delete process.env.CURRENCY_SERVICE_RPC_HOST;
    delete process.env.CURRENCY_SERVICE_RPC_PORT;
    try {
      // `transport` 是 Nest 的枚举值（`Transport.TCP` = 0）—— 这里只钉 env 两项
      //（host/port 才是本函数从环境读的东西；transport 是常量）。
      expect(currencyClientOptions().options).toEqual({ host: 'currency-service', port: 3104 });
    } finally {
      if (saved.host === undefined) delete process.env.CURRENCY_SERVICE_RPC_HOST;
      else process.env.CURRENCY_SERVICE_RPC_HOST = saved.host;
      if (saved.port === undefined) delete process.env.CURRENCY_SERVICE_RPC_PORT;
      else process.env.CURRENCY_SERVICE_RPC_PORT = saved.port;
    }
  });
});

describe('CurrencyClient.cardCounterConsume（记牌器收费片：仅 10007/传输失败重试 ≤1）', () => {
  const CONSUME_REQUEST = { roomCode: 'CC01', ownerId: 'u-cc', seat: 0 };
  const CONSUME_DATA = { active: true, source: 'credit' as const, expiresAt: null };

  it('成功：一次调用，pattern/载荷逐字；解包 data', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: CONSUME_DATA }));
    await expect(new CurrencyClient(proxy).cardCounterConsume(CONSUME_REQUEST)).resolves.toEqual(
      CONSUME_DATA,
    );
    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.currencyCardCounterConsume, data: CONSUME_REQUEST },
    ]);
  });

  it('下游 10007：重试一次；第二发成功 ⇒ 返回，且只重试 10007', async () => {
    const { proxy, calls } = fakeProxy((_call, index) =>
      index === 0
        ? of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'down' })
        : of({ ok: true, data: CONSUME_DATA }),
    );
    await expect(new CurrencyClient(proxy).cardCounterConsume(CONSUME_REQUEST)).resolves.toEqual(
      CONSUME_DATA,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.pattern === RPC_PATTERNS.currencyCardCounterConsume)).toBe(true);
  });

  it('下游 10007 两次 ⇒ 抛出 10007（重试耗尽）', async () => {
    const { proxy, calls } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'down' }),
    );
    await expect(
      new CurrencyClient(proxy).cardCounterConsume(CONSUME_REQUEST),
    ).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
    expect(calls).toHaveLength(2);
  });

  it('业务码（14008/14001 等）不重试：一次调用、原码抛出', async () => {
    for (const code of [ErrCode.E_CARD_COUNTER_UNAVAILABLE, ErrCode.E_INSUFFICIENT_FUNDS]) {
      const { proxy, calls } = fakeProxy(() => of({ ok: false, code, message: 'nope' }));
      await expect(
        new CurrencyClient(proxy).cardCounterConsume(CONSUME_REQUEST),
      ).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    }
  });

  it('传输故障：重试一次；仍失败 ⇒ 10007 + 固定文案', async () => {
    const { proxy, calls } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));
    await expect(
      new CurrencyClient(proxy).cardCounterConsume(CONSUME_REQUEST),
    ).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: TRANSPORT_FAILURE_MESSAGE,
    });
    expect(calls).toHaveLength(2);
  });
});
