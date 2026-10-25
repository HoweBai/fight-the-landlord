/**
 * `CurrencyClient` 的**传输层契约**（货币片 T6 / 规格 §2.7 + §6.1 user-service 行 ——
 * user → currency 的 `currency.apply` 边，注册赠送的发送侧）。
 *
 * 与 `config.client` / room 侧 `record.client.test.ts` 同族同纪律（R70/R221）：判据走
 * **真实 pipeline**（假 `ClientProxy.send()` 返回可控 Observable：`of(信封)` /
 * `throwError` / `NEVER`），而不是只断言「调了 `send()`」—— 后者在「超时没接上」
 * 「信封没解」时照样绿。
 *
 * 本文件钉住五条性质：
 *  ① 打的是 `RPC_PATTERNS.currencyApply`，载荷 = 请求字段**逐字** + meta（无 ALS ⇒ 展开
 *     `{}` ⇒ 载荷不变 —— R1104/R1105 的省略语义）；成功返回下游 `data`；
 *  ② 信封 `{ok:false}` 的 5 位码**原样**成为 `CurrencyServiceError.code`（业务文案逐字保留）；
 *  ③ 🔴 传输故障 / 超时 ⇒ `10007` + **固定文案**（原因只进日志——内部拓扑不得进消息）；
 *  ④ **不重试**（§4.3 表：`currency.apply` 超时 3s、不重试）+ 超时恰 **3000ms**（推进到
 *     2999ms 仍挂起、后 1ms 才判失败）；
 *  ⑤ env 读取：`CURRENCY_SERVICE_RPC_HOST/PORT` 的默认值（`currency-service`/`3104`）
 *     与显式覆盖（§2.13 env 表 / §4.1 #23 的命名口径）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import {
  ErrCode,
  RPC_PATTERNS,
  type AgentBindData,
  type AgentBindRequest,
  type CurrencyApplyRequest,
  type CurrencyApplyData,
} from '@fight-the-landlord/protocol';
import {
  CURRENCY_CLIENT_TIMEOUT_MS,
  CurrencyClient,
  CurrencyServiceError,
  TRANSPORT_FAILURE_MESSAGE,
  currencyClientOptions,
} from '../src/currency/currency.client';

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

/** 一个形状真实的 `currency.apply` 请求（注册赠送的组装产物样本）。 */
const REQUEST: CurrencyApplyRequest = {
  actionId: 'signup:0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
  source: 'signup_grant',
  entries: [{ ownerId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', delta: 100 }],
  refId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
};

/** 下游成功信封的 `data`（`CurrencyApplyData`，⚙️3/⚙️6）。 */
const APPLY_DATA: CurrencyApplyData = {
  opId: 42,
  actionId: REQUEST.actionId,
  entries: [{ ownerId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', balanceAfter: 100 }],
  replayed: false,
};

describe('CurrencyClient.apply() 的 RPC 契约（pattern 名 + 载荷 + 解包）', () => {
  it('打 RPC_PATTERNS.currencyApply，载荷 = 请求逐字 + meta（无 ALS ⇒ 空展开，`toEqual` 恰好比对）', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: APPLY_DATA }));

    await expect(new CurrencyClient(proxy).apply(REQUEST)).resolves.toEqual(APPLY_DATA);

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.currencyApply, data: REQUEST }]);
  });

  it('重放响应（`replayed:true`）原样透传 —— 幂等命中**不是错误**', async () => {
    const replayed: CurrencyApplyData = { ...APPLY_DATA, replayed: true };
    const { proxy } = fakeProxy(() => of({ ok: true, data: replayed }));

    await expect(new CurrencyClient(proxy).apply(REQUEST)).resolves.toEqual(replayed);
  });
});

describe('CurrencyClient.apply() 的错误语义（§11.2 / R220 / ⚙️8）', () => {
  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 CurrencyServiceError.code（业务文案逐字保留）', async () => {
    const { proxy } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.E_ACTION_CONFLICT, message: 'actionId 冲突（同 id 不同载荷）' }),
    );

    await expect(new CurrencyClient(proxy).apply(REQUEST)).rejects.toMatchObject({
      code: ErrCode.E_ACTION_CONFLICT,
      message: 'actionId 冲突（同 id 不同载荷）',
    });
  });

  it('🔴 传输层故障 ⇒ 抛 10007 + 固定文案（原因只进日志、不进消息）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'user-service' }));
    const { proxy } = fakeProxy(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.28.0.9:3104')),
    );

    const err = (await new CurrencyClient(proxy).apply(REQUEST).catch((e: unknown) => e)) as CurrencyServiceError;

    expect(err).toBeInstanceOf(CurrencyServiceError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    // 与 config 边的同名常量**逐字相同**（同服务两条边失败时运维看到同一句话）。
    expect(TRANSPORT_FAILURE_MESSAGE).toBe('服务暂时不可用，请稍后重试');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.9'); // 内部拓扑不得进消息
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3104');
  });

  /**
   * 超时（**3000ms**）也是「拿不到应答」⇒ 抛 10007，且**不重试**（恰好 1 次 `send`）。
   *
   * ⚠️ 用假定时器：`NEVER`（永不回包）+ 推进 3s。忘了接 `timeout()` 时本用例会挂到
   * vitest 的用例上限而红（与 `record.client.test.ts` 的超时用例同款）。
   * ⚠️ 2999ms 仍挂起 + 3000ms 才判失败 —— 钉住的是**恰好 3s**（规格 §2.7 / §4.3 表），
   * 不是「某个正整数」。
   */
  it('超时 ⇒ 10007，恰 3000ms 触发、恰好 1 次 send（不重试；§4.3 表）', async () => {
    expect(CURRENCY_CLIENT_TIMEOUT_MS).toBe(3000); // 规格 §2.7：3s
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new CurrencyClient(proxy).apply(REQUEST);
      // ⚠️ 断言**先挂上**再推进定时器：否则「超时那一刻的 rejection」会在没人 await 的
      // 窗口里出现（vitest 会把它记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      // 还差 1ms 到 3s：仍在挂起（证明不是「立刻失败」、也不是别的超时值）
      await vi.advanceTimersByTimeAsync(CURRENCY_CLIENT_TIMEOUT_MS - 1);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expectation;
      expect(calls).toHaveLength(1); // 不重试：§4.3 的重试表不含这条边
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CurrencyClient 的 env 读取（§2.13 env 表 / §4.1 #23）', () => {
  const ENV_KEYS = ['CURRENCY_SERVICE_RPC_HOST', 'CURRENCY_SERVICE_RPC_PORT'] as const;

  it('默认 currency-service / 3104；显式覆盖生效（逐键断言，防错位）', () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const defaults = currencyClientOptions();
      expect(defaults.transport).toBe(Transport.TCP);
      expect(defaults.options).toEqual({ host: 'currency-service', port: 3104 });

      process.env.CURRENCY_SERVICE_RPC_HOST = 'currency-alt';
      process.env.CURRENCY_SERVICE_RPC_PORT = '4104';
      expect(currencyClientOptions().options).toEqual({ host: 'currency-alt', port: 4104 });
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});


describe('CurrencyClient.agentBind()（代理分润 2026-10-26）', () => {
  const BIND: AgentBindRequest = {
    ownerId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
    code: 'ABCD2345',
    phone: '13800000000',
    source: 'signup',
  };
  const BIND_DATA: AgentBindData = { status: 'bound' };

  it('打 RPC_PATTERNS.agentBind，载荷逐字 + meta；成功返回 data', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: BIND_DATA }));
    await expect(new CurrencyClient(proxy).agentBind(BIND)).resolves.toEqual(BIND_DATA);
    expect(calls).toEqual([{ pattern: RPC_PATTERNS.agentBind, data: BIND }]);
  });

  it('业务错误原码（11006）；传输故障 10007 + 固定文案', async () => {
    const invalid = fakeProxy(() =>
      of({ ok: false, code: ErrCode.AGENT_INVITE_INVALID, message: '邀请码无效' }),
    );
    await expect(new CurrencyClient(invalid.proxy).agentBind(BIND)).rejects.toMatchObject({
      code: ErrCode.AGENT_INVITE_INVALID,
      message: '邀请码无效',
    });

    const down = fakeProxy(() => throwError(() => new Error('ECONNREFUSED internal')));
    await expect(new CurrencyClient(down.proxy).agentBind(BIND)).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: TRANSPORT_FAILURE_MESSAGE,
    });
    expect(TRANSPORT_FAILURE_MESSAGE).not.toContain('ECONNREFUSED');
  });
});
