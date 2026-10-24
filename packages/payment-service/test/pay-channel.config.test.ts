/**
 * 支付配置管理化片 T8：`ConfigClient.payChannel()` 传输契约 + `PayChannelConfigService`
 * 现拉 / 整图替换 / 回落语义（规格 §3.3 · ⚙️8/⚙️9 · §2.5 · §2.9 文案逐字）。
 *
 * 判据走**真实 pipeline**（假 `ClientProxy.send()` 返回可控订阅对象；照 robot/room 侧
 * `config.client.test.ts` 同族纪律）—— 而不是只断言「调了 send()」，后者在「超时没接上」
 * 「信封没解」时照样绿。
 *
 * ⚠️ 本包**不新增 rxjs 依赖**（支付片全局约束）⇒ 测试侧也用**手写**的三个最小等价物
 * （`ofValue` / `throwErr` / `neverObs`），不 import rxjs —— 与 `ConfigClient` 的手工桥
 * 同一个消费面（`subscribe({next,error})` + `unsubscribe`）。
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { runWithTrace } from '@fight-the-landlord/shared';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigPayChannelGetResponse,
} from '@fight-the-landlord/protocol';
import {
  ConfigClient,
  ConfigServiceError,
  PAY_CHANNEL_CLIENT_TIMEOUT_MS,
  TRANSPORT_FAILURE_MESSAGE,
} from '../src/config/config.client';
import { PayChannelConfigService } from '../src/config/pay-channel.config.service';

/* ─── 假 proxy / 订阅对象（rxjs 等价物的手写最小化）───────────────────────── */

/** 一次 `proxy.send()` 的调用记录。 */
interface SendCall {
  pattern: string;
  data: unknown;
}

/** `subscribe({next,error})` 形态的观察者（bridge 只消费这两个回调）。 */
interface ObserverLike {
  next(value: unknown): void;
  error(err: unknown): void;
}

/** 假 `send()` 的返回值形态（bridge 只消费 `subscribe` → `unsubscribe`）。 */
interface SubscriptionLike {
  subscribe(observer: ObserverLike): { unsubscribe(): void };
}

/** 可控的假 `ClientProxy`（照 robot/room 侧同名工厂）。 */
function fakeProxy(handler: (call: SendCall, index: number) => SubscriptionLike) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

/** 同步立即发射 `value`（= rxjs `of(value)` 的最小等价物）。 */
function ofValue(value: unknown): SubscriptionLike {
  return {
    subscribe: (observer) => {
      observer.next(value);
      return { unsubscribe: () => undefined };
    },
  };
}

/** 同步立即报错（= rxjs `throwError`）。 */
function throwErr(err: unknown): SubscriptionLike {
  return {
    subscribe: (observer) => {
      observer.error(err);
      return { unsubscribe: () => undefined };
    },
  };
}

/** 永不发射（= rxjs `NEVER`）；带计数时记录 `unsubscribe` 调用（超时路径断言退订）。 */
function neverObs(counter?: { count: number }): SubscriptionLike {
  return {
    subscribe: () => ({
      unsubscribe: () => {
        if (counter) counter.count += 1;
      },
    }),
  };
}

/** 图 A：两键（「整图替换」判据的基 —— 图 B 少 `sellerId` ⇒ 它必须消失）。 */
const VALUES_AB: ConfigPayChannelGetResponse['values'] = {
  'pay.channel.appId': 'app-a',
  'pay.channel.sellerId': 'seller-a',
};

/** 回落 WARN 文案（§2.9 逐字，**不含值**）。 */
const FALLBACK_WARN = '渠道配置拉取失败，使用上次成功值（trace 见 meta）';

/* ======================================================================== *
 * ① ConfigClient.payChannel()：pattern / 载荷（meta 在场）/ 解包 / 翻码 / 超时
 * ======================================================================== */
describe('ConfigClient.payChannel() 的 RPC 契约（§2.5/⚙️8）', () => {
  it('打 RPC_PATTERNS.configPayChannelGet：载荷 = {pullToken, meta}（meta 在场），返回 res.data', async () => {
    const { proxy, calls } = fakeProxy(() => ofValue({ ok: true, data: { values: VALUES_AB } }));

    // ⚠️ meta 只在 **trace 上下文内**出现（`metaFromTrace()` 的契约）—— 用 runWithTrace 构造。
    const res = await runWithTrace({ traceId: 'trace-t8-1', source: 'rpc' }, () =>
      new ConfigClient(proxy).payChannel('tok-1'),
    );

    expect(res).toEqual({ values: VALUES_AB });
    expect(calls).toEqual([
      {
        pattern: RPC_PATTERNS.configPayChannelGet,
        data: { pullToken: 'tok-1', meta: { traceId: 'trace-t8-1' } },
      },
    ]);
  });

  it('无 trace 上下文 ⇒ 载荷只含 pullToken（meta 不编造）—— 反向证明 meta 确来自 metaFromTrace', async () => {
    const { proxy, calls } = fakeProxy(() => ofValue({ ok: true, data: { values: {} } }));

    await new ConfigClient(proxy).payChannel('tok-2');

    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.configPayChannelGet, data: { pullToken: 'tok-2' } },
    ]);
  });

  it('信封 `{ok:false, code:10002}` ⇒ ConfigServiceError(10002, 下游 message)：**原样不翻码**', async () => {
    const { proxy } = fakeProxy(() =>
      ofValue({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌无效' }),
    );

    await expect(new ConfigClient(proxy).payChannel('bad')).rejects.toMatchObject({
      code: ErrCode.UNAUTHENTICATED, // = 10002
      message: '拉取令牌无效',
    });
  });

  it('信封 `{ok:false, code:10007}` ⇒ ConfigServiceError(10007, 下游 message)（与 10002 同类——调用方不按码分支）', async () => {
    const { proxy } = fakeProxy(() =>
      ofValue({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: '渠道密钥存储未启用' }),
    );

    await expect(new ConfigClient(proxy).payChannel('tok')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE, // = 10007
      message: '渠道密钥存储未启用',
    });
  });

  it('信封缺码/缺 message ⇒ 10007 + pattern 名兜底（照 snapshot 先例）', async () => {
    const { proxy } = fakeProxy(() => ofValue({ ok: false }));

    await expect(new ConfigClient(proxy).payChannel('tok')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: RPC_PATTERNS.configPayChannelGet,
    });
  });

  it('传输层故障 ⇒ ConfigServiceError(10007, 固定文案)；原因只进日志（不内插内部拓扑）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let err: unknown;
    let logged = '';
    try {
      const { proxy } = fakeProxy(() => throwErr(new Error('connect ECONNREFUSED 172.28.0.10:3106')));
      err = await new ConfigClient(proxy).payChannel('tok').catch((e: unknown) => e);
      // ⚠️ mock.calls 必须在 mockRestore() **之前**读（restore 会连记录一起清）。
      logged = warn.mock.calls.map((args) => String(args[0])).join('\n');
    } finally {
      warn.mockRestore();
    }
    expect(err).toBeInstanceOf(ConfigServiceError);
    expect((err as ConfigServiceError).code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect((err as ConfigServiceError).message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect((err as ConfigServiceError).message).not.toContain('ECONNREFUSED');
    expect((err as ConfigServiceError).message).not.toContain('172.28.0.10');
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(logged).toContain('172.28.0.10:3106');
  });

  it('超时（1000ms）⇒ 拒绝（10007 路径），恰 1 次 send（不重试），且退订', async () => {
    vi.useFakeTimers();
    try {
      const unsubscribed = { count: 0 };
      const { proxy, calls } = fakeProxy(() => neverObs(unsubscribed));
      const p = new ConfigClient(proxy).payChannel('tok');
      // ⚠️ 断言**先挂上**再推进定时器：否则超时那一刻的 rejection 会在没人 await 的窗口里
      // 出现（vitest 会记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      // 未到 1000ms：仍在挂起（证明不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(PAY_CHANNEL_CLIENT_TIMEOUT_MS - 100);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(150);
      await expectation;
      expect(calls).toHaveLength(1); // 不重试
      expect(unsubscribed.count).toBe(1); // 超时 ⇒ 退订（不泄漏订阅）
    } finally {
      vi.useRealTimers();
    }
  });

  it('导出常量 PAY_CHANNEL_CLIENT_TIMEOUT_MS = 1000（⚙️8 逐字）', () => {
    expect(PAY_CHANNEL_CLIENT_TIMEOUT_MS).toBe(1000);
  });
});

/* ======================================================================== *
 * ② PayChannelConfigService.get()：每调用现拉 / 整图替换 / 回落 / 从未成功 null
 * ======================================================================== */
describe('PayChannelConfigService.get()：现拉 · 整图替换 · 回落（§3.3/⚙️9）', () => {
  /** `ConfigClient` 最小 mock：只提供 `payChannel`（并记录调用参数）。 */
  function mockClient(impl: (pullToken: string) => Promise<ConfigPayChannelGetResponse>) {
    const payChannel = vi.fn(impl);
    return { client: { payChannel } as unknown as ConfigClient, payChannel };
  }

  it('成功 ⇒ **整图替换（不是 merge）**：图 A={appId,sellerId} ⇒ 图 B={appId}，sellerId 必须消失', async () => {
    const responses: Array<Promise<ConfigPayChannelGetResponse>> = [
      Promise.resolve({ values: VALUES_AB }),
      Promise.resolve({ values: { 'pay.channel.appId': 'app-b' } }),
    ];
    const { client } = mockClient(() => responses.shift()!);
    const svc = new PayChannelConfigService(client);

    await expect(svc.get()).resolves.toEqual(VALUES_AB);
    const second = await svc.get();
    expect(second).toEqual({ 'pay.channel.appId': 'app-b' }); // toEqual 本身已排除 merge 残留
    expect(Object.keys(second ?? {})).toEqual(['pay.channel.appId']); // 显式钉「键消失」
  });

  it('图 = {} ⇒ 返回 {}（**有效图** = 全未配置，不是 null）；其后失败回落到的也是新图 {}', async () => {
    const responses: Array<Promise<ConfigPayChannelGetResponse>> = [
      Promise.resolve({ values: VALUES_AB }),
      Promise.resolve({ values: {} }),
      Promise.reject(new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down')),
    ];
    const { client } = mockClient(() => responses.shift()!);
    const svc = new PayChannelConfigService(client);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.get()).resolves.toEqual(VALUES_AB);
      await expect(svc.get()).resolves.toEqual({}); // 成功返回 {}（非 null）
      expect(warn).not.toHaveBeenCalled(); // 两次成功 ⇒ 零 WARN
      // 回落押注：{} 已**整图替换** lastGood ⇒ 回落是 {}（不是 null、也不是旧图 A）
      await expect(svc.get()).resolves.toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('失败回落 ⇒ 返回 lastGood + WARN 恰一条（文案 §2.9 逐字，**不含任何值**）', async () => {
    const responses: Array<Promise<ConfigPayChannelGetResponse>> = [
      Promise.resolve({ values: VALUES_AB }),
      Promise.reject(new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'boom app-a seller-a')),
    ];
    const { client } = mockClient(() => responses.shift()!);
    const svc = new PayChannelConfigService(client);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.get()).resolves.toEqual(VALUES_AB);
      await expect(svc.get()).resolves.toEqual(VALUES_AB); // 回落 lastGood
      expect(warn).toHaveBeenCalledTimes(1); // failure 每条 WARN 一次
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toBe(FALLBACK_WARN);
      expect(msg).not.toContain('app-a');
      expect(msg).not.toContain('seller-a');
    } finally {
      warn.mockRestore();
    }
  });

  it('从未成功 ⇒ null（回落面无值可用）+ WARN 照记（每条失败各一条）', async () => {
    const { client } = mockClient(() =>
      Promise.reject(new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down')),
    );
    const svc = new PayChannelConfigService(client);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.get()).resolves.toBeNull();
      await expect(svc.get()).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(
        warn.mock.calls.every((args) => String(args[0]) === FALLBACK_WARN),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('每调用现拉：pullToken **逐调用**读 env（`||` 语义 —— 空串=未设，⚙️5）；无缓存复用', async () => {
    const saved = process.env.PAY_CHANNEL_PULL_TOKEN;
    const { client, payChannel } = mockClient(() => Promise.resolve({ values: {} }));
    const svc = new PayChannelConfigService(client);
    try {
      process.env.PAY_CHANNEL_PULL_TOKEN = 'tok-x';
      await svc.get();
      delete process.env.PAY_CHANNEL_PULL_TOKEN;
      await svc.get();
    } finally {
      if (saved === undefined) delete process.env.PAY_CHANNEL_PULL_TOKEN;
      else process.env.PAY_CHANNEL_PULL_TOKEN = saved;
    }
    expect(payChannel).toHaveBeenCalledTimes(2); // 「现拉」：两次 get 两次 send
    expect(payChannel).toHaveBeenNthCalledWith(1, 'tok-x');
    expect(payChannel).toHaveBeenNthCalledWith(2, ''); // 空串=未设
  });

  it('`ok:false` **不按码分支**：10002 与 10007 同等走回落（两码各一例；真实 client + 假 proxy）', async () => {
    for (const code of [ErrCode.UNAUTHENTICATED, ErrCode.UPSTREAM_UNAVAILABLE]) {
      let call = 0;
      const { proxy } = fakeProxy(() =>
        (call += 1) === 1
          ? ofValue({ ok: true, data: { values: VALUES_AB } })
          : ofValue({ ok: false, code, message: `失败码 ${code}` }),
      );
      const svc = new PayChannelConfigService(new ConfigClient(proxy));
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await expect(svc.get(), `code=${code}`).resolves.toEqual(VALUES_AB);
        await expect(svc.get(), `code=${code}`).resolves.toEqual(VALUES_AB); // 回落（两码同路径）
        expect(warn, `code=${code}`).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0]), `code=${code}`).toBe(FALLBACK_WARN);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('超时 1000ms ⇒ 服务层回落 lastGood（端到端：真实 client + 假 proxy + 假时钟）', async () => {
    vi.useFakeTimers();
    let mode = 'ok';
    const { proxy } = fakeProxy(() =>
      mode === 'hang' ? neverObs() : ofValue({ ok: true, data: { values: VALUES_AB } }),
    );
    const svc = new PayChannelConfigService(new ConfigClient(proxy));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.get()).resolves.toEqual(VALUES_AB); // 先成功（暖 lastGood）
      mode = 'hang';
      const p = svc.get();
      const expectation = expect(p).resolves.toEqual(VALUES_AB); // 超时 ⇒ 回落
      await vi.advanceTimersByTimeAsync(PAY_CHANNEL_CLIENT_TIMEOUT_MS + 1);
      await expectation;
      // 客户端传输故障 WARN（含原因）+ 服务回落 WARN —— 回落文案恰一条
      const msgs = warn.mock.calls.map((args) => String(args[0]));
      expect(msgs.filter((m) => m === FALLBACK_WARN)).toHaveLength(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
