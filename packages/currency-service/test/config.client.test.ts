/**
 * `ConfigClient`（currency-service）的**传输层契约**（② 金币场 T8：currency-service 的
 * 第一条出站 RPC 边 / 片规格 §9）。
 *
 * 与 robot-service 的 `config.client.test.ts` 同族、同纪律（R70/R221）：判据走**真实
 * pipeline**（假 `ClientProxy.send()` 返回可控 Observable），而不是只断言「调了 `send()`」
 * —— 后者在「超时没接上」「信封没解」时照样绿。
 *
 * 🔴 **本包无直测的补票**：实现侧因「不新增 npm 依赖」用 `subscribe` 手工桥 Promise
 * （全仓唯一；user/room/robot 三侧走 rxjs 算子）—— 手工桥的每一格取舍都要在这里钉住，
 * 否则它是全仓唯一没被「真实 pipeline」判据覆盖的三类失败语义。三条替身与 rxjs 成例
 * **逐条同构**（本包不引 rxjs，替身是手写的最小形状 —— 实现只用到 `subscribe` 与
 * `unsubscribe` 两个方法）：
 *  - `syncEmit`  ↔ `of(信封)`（同步发射一次 —— 恰好路过 ④ 修复的那条「同步发射」边）；
 *  - `syncFail`  ↔ `throwError(...)`（同步走 error 通道）；
 *  - `hanging`   ↔ `NEVER`（永不回执，记录退订次数 —— 超时用例的正面对照）。
 *
 * 五条性质：
 *  ① 打的是 `RPC_PATTERNS.configSnapshot`，载荷**逐字** = `meta` 片段
 *     （无 ALS ⇒ `{}`；有 ALS ⇒ `{meta:{traceId[,reqId][,userId]}}`，R1104/R1105）；
 *  ② 成功时返回 `res.data`（**整个快照响应**）；
 *  ③ 信封 `{ok:false,code}` ⇒ 5 位码与文案**原样**成为 `ConfigServiceError`（R220）；
 *  ④ 传输故障 / 超时 ⇒ **一律** 10007 + 固定文案（原因只进日志，不内插），恰 1 次 `send`；
 *  ⑤ 超时那一刻**退订**；同步发射（已回执）⇒ **不残留**超时定时器（timer 先武装、后订阅）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, runWithTrace } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type ConfigSnapshotResponse } from '@fight-the-landlord/protocol';
import {
  ConfigClient,
  ConfigServiceError,
  TRANSPORT_FAILURE_MESSAGE,
} from '../src/config/config.client';

/** M4 成例：`Logger.overrideLogger` 是**进程级**的，用后必须还原。 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

/** 一次 `proxy.send()` 的调用记录。 */
interface SendCall {
  pattern: string;
  data: unknown;
}

/** 最小观察者形状（实现只传 `next` / `error` 两格）。 */
interface FakeObserver {
  next?: (value: unknown) => void;
  error?: (err: unknown) => void;
}

/** 最小 Observable 形状：实现只用到 `subscribe()` 与返回订阅的 `unsubscribe()`。 */
interface FakeObservable {
  subscribe(observer: FakeObserver): { unsubscribe: () => void };
}

/** ↔ `of(信封)`：同步发射一次（`lastValueFrom` 的首个 next 即结果，同义）。 */
function syncEmit(value: unknown): FakeObservable {
  return {
    subscribe: (observer) => {
      observer.next?.(value);
      return { unsubscribe: () => {} };
    },
  };
}

/** ↔ `throwError(...)`：同步走 error 通道。 */
function syncFail(err: unknown): FakeObservable {
  return {
    subscribe: (observer) => {
      observer.error?.(err);
      return { unsubscribe: () => {} };
    },
  };
}

/** ↔ `NEVER`：永不回执；`unsubscribed()` 供超时用例断言「退订过恰好一次」。 */
function hanging(): { observable: FakeObservable; unsubscribed: () => number } {
  let count = 0;
  return {
    observable: {
      subscribe: () => ({
        unsubscribe: () => {
          count += 1;
        },
      }),
    },
    unsubscribed: () => count,
  };
}

/** 可控的假 `ClientProxy`（照 robot-client.test.ts / room 侧同名工厂）。 */
function fakeProxy(handler: (call: SendCall, index: number) => FakeObservable) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

/** 一个形状真实的快照响应（成功路径的样本；client 是**透传**，不逐键铺满）。 */
const SNAPSHOT: ConfigSnapshotResponse = {
  config: {
    'currency.reliefEnabled': { value: true, version: 3 },
  } as ConfigSnapshotResponse['config'],
  version: 3,
};

describe('ConfigClient.snapshot() 的 RPC 契约（pattern 名 + 载荷 + 解包）', () => {
  it('打 RPC_PATTERNS.configSnapshot，载荷**只有 meta**（无 ALS ⇒ 空对象），返回 res.data', async () => {
    const { proxy, calls } = fakeProxy(() => syncEmit({ ok: true, data: SNAPSHOT }));

    await expect(new ConfigClient(proxy).snapshot()).resolves.toEqual(SNAPSHOT);

    // 负对照（R1105 的省略语义）：无 ALS ⇒ `meta` 键**不出现**（不是 `meta: undefined`）。
    expect(calls).toEqual([{ pattern: RPC_PATTERNS.configSnapshot, data: {} }]);
  });

  it('③ 成功且 ALS 有上下文 ⇒ meta（traceId）**随包发送**（R1104/R1105）', async () => {
    const { proxy, calls } = fakeProxy(() => syncEmit({ ok: true, data: SNAPSHOT }));

    await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'edge' }, () =>
      new ConfigClient(proxy).snapshot(),
    );

    expect(calls).toEqual([
      {
        pattern: RPC_PATTERNS.configSnapshot,
        data: { meta: { traceId: 'T9', reqId: 'R9', userId: 'U9' } },
      },
    ]);
  });
});

describe('ConfigClient.snapshot() 的错误语义（§11.2 / R220）', () => {
  it('② 信封 `{ok:false,code}` 的 5 位码与文案**原样透传**（不是一律 10007 兜底）', async () => {
    const { proxy } = fakeProxy(() =>
      syncEmit({ ok: false, code: ErrCode.FORBIDDEN, message: 'db down' }),
    );

    const err = (await new ConfigClient(proxy)
      .snapshot()
      .catch((e: unknown) => e)) as ConfigServiceError;

    expect(err).toBeInstanceOf(ConfigServiceError);
    // 码取**信封里的那个**（10003）：若实现把它折成 10007，本条当场红。
    expect(err.code).toBe(ErrCode.FORBIDDEN);
    // ⚠️ **业务文案逐字保留**：下游信封里的 `message` 是给调用方**看**的话。
    expect(err.message).toBe('db down');
  });

  it('🔴 传输层故障（连不上，error 通道）⇒ 10007 + 固定文案；原因只进日志', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'currency-service' }));
    const { proxy } = fakeProxy(() =>
      syncFail(new Error('connect ECONNREFUSED 172.28.0.9:3106')),
    );

    const err = (await new ConfigClient(proxy)
      .snapshot()
      .catch((e: unknown) => e)) as ConfigServiceError;

    expect(err).toBeInstanceOf(ConfigServiceError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.9');
    expect(err.message).not.toContain('config-service'); // 服务名同样是内部拓扑
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3106');
  });

  it('① 超时（3s 无回执）⇒ 10007 + 固定文案（不内插超时原因）；退订一次；恰 1 次 send', async () => {
    vi.useFakeTimers();
    try {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'currency-service' }));
      const { observable, unsubscribed } = hanging();
      const { proxy, calls } = fakeProxy(() => observable);
      const p = new ConfigClient(proxy).snapshot();
      // ⚠️ 断言**先挂上**再推进定时器（照 robot 模板）：否则「超时那一刻的 rejection」
      // 会在没人 await 的窗口里出现（vitest 会把它记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: TRANSPORT_FAILURE_MESSAGE,
      });

      // 还没到 3s：仍在挂起（证明不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(2_900);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      await expectation;
      expect(unsubscribed(), '超时那一刻必须退订（不把订阅挂着）').toBe(1);
      expect(calls).toHaveLength(1); // 不重试：失败恰好 1 次 send

      const err = (await p.catch((e: unknown) => e)) as ConfigServiceError;
      // 🔴 固定文案：超时内情（「config.snapshot 超时（3000ms 无回执）」）**不得**上浮。
      expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE);
      expect(err.message).not.toContain('超时');
      expect(err.message).not.toContain('config.snapshot');
      // 正对照：详情必须进日志（不透传 ≠ 不留痕）
      expect(records.map((r) => r.msg).join('\n')).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('④ 同步发射（已回执）⇒ resolve 后**不残留**超时定时器（timer 先武装、后订阅）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy } = fakeProxy(() => syncEmit({ ok: true, data: SNAPSHOT }));

      await expect(new ConfigClient(proxy).snapshot()).resolves.toEqual(SNAPSHOT);

      // 修前的形态：subscribe 返回后才 setTimeout ⇒ 同步发射时 next 已错过 clearTimeout
      // 的窗口 ⇒ 残留 1 个 3s 定时器（日后会空跑一次 unsubscribe+reject）。修后为 0。
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
