/**
 * `ConfigClient` 的**传输层契约**（片规格 §2.1/§2.3 —— room → config-service 的
 * `config.snapshot` 边，取代旧的 room → user `config.baseScoreLevels`）。
 *
 * 与 `game.client.test.ts` 同族、同纪律（R70/R221）：判据走**真实 pipeline**
 * （假 `ClientProxy.send()` 返回可控 Observable：`of(信封)` / `throwError` / `NEVER`），
 * 而不是只断言「调了 `send()`」—— 后者在「超时没接上」「信封没解」时照样绿。
 *
 * 本文件钉住四条性质：
 *  ① 打的是 `RPC_PATTERNS.configSnapshot`，载荷**只有 meta**（业务参数一个都没有）；
 *  ② 成功时返回的是 `res.data`（**整个快照响应**：`{config, version}`）；
 *  ③ 🔴 **失败一律抛** —— 下游码原样成为 `ConfigServiceError.code`；传输故障 / 超时 ⇒ `10007`。
 *     返回空数组会把「读不到」伪装成「没有档位」⇒ 非法底分绕过校验；
 *  ④ **不重试**（§4.3 的重试表不含这条边）—— 失败恰好 1 次 `send`。
 *
 * ⚠️ T6 曾有的 `levels()` **过渡委托**组已随 T7 重接线**删除**（`levels()` 本身也从
 * `ConfigClient` 删除）：档位表的读取统一走 `ConfigCacheService.baseScoreLevels()`，
 * 其失败形状（`10007` + 固定文案）由 `config-cache.test.ts` 的 C4/C4′/C4b 承接。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type ConfigSnapshotResponse } from '@fight-the-landlord/protocol';
import { ConfigClient, ConfigServiceError } from '../src/gateway/config.client';
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

/** 可控的假 `ClientProxy`（照 `game.client.test.ts` 的同名工厂）。 */
function fakeProxy(handler: (call: SendCall, index: number) => unknown) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    const call = { pattern, data };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { proxy: { send } as never, send, calls };
}

/** 一个形状真实的快照响应（成功路径的样本）。 */
const SNAPSHOT: ConfigSnapshotResponse = {
  config: {
    // 不逐键铺满九十二键：client 是**透传**（返回 `res.data`），本条判据只证明「没解错层」。
    'game.baseScoreLevels': { value: [{ name: '休闲场', baseScore: 15 }], version: 4 },
  } as ConfigSnapshotResponse['config'],
  version: 4,
};

describe('ConfigClient.snapshot() 的 RPC 契约（pattern 名 + 载荷 + 解包）', () => {
  it('打 RPC_PATTERNS.configSnapshot，载荷**只有 meta**（无 ALS ⇒ 空对象），返回 res.data', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: SNAPSHOT }));

    await expect(new ConfigClient(proxy).snapshot()).resolves.toEqual(SNAPSHOT);

    expect(calls).toEqual([{ pattern: RPC_PATTERNS.configSnapshot, data: {} }]);
  });
});

describe('ConfigClient.snapshot() 的错误语义（§11.2 / R220）', () => {
  it('信封 `{ok:false,code}` 的 5 位码**原样**成为 ConfigServiceError.code', async () => {
    const { proxy } = fakeProxy(() =>
      of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'db down' }),
    );

    await expect(new ConfigClient(proxy).snapshot()).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      // ⚠️ **业务文案逐字保留**（Task 3g 修复 I2 的另一半）：下游信封里的 `message`
      // 是给调用方**看**的话，**不得**被替换成通用文案。
      message: 'db down',
    });
  });

  it('🔴 传输层故障（连不上）⇒ 抛 10007 —— **绝不**返回空快照', async () => {
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));

    const err = await new ConfigClient(proxy).snapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigServiceError);
    expect((err as ConfigServiceError).code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
  });

  /**
   * 🔴 **Task 3g 修复 I2**：传输层故障的消息**不得带原因**。
   *
   * 修前本 client 抛的是 `` `user-service unavailable: ${reason}` ``，`reason` 传输故障时是
   * `connect ECONNREFUSED 172.28.0.9:3101` 这类**内部详情**；本错误的消息会**原样**到客户端
   * （WS 面经 ack、HTTP 面经 `toHttpException` 的信封）。
   * 处置：消息给固定文案（`TRANSPORT_FAILURE_MESSAGE`），详情**只进日志**。
   */
  it('🔴 传输层故障 ⇒ 消息是固定文案（不含原因），原因只进日志', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.28.0.9:3106')),
    );

    const err = (await new ConfigClient(proxy).snapshot().catch((e: unknown) => e)) as ConfigServiceError;

    expect(err).toBeInstanceOf(ConfigServiceError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.9');
    expect(err.message).not.toContain('config-service'); // 服务名同样是内部拓扑
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3106');
  });

  /**
   * 超时（3s）也是「拿不到快照」⇒ 抛 10007，且**不重试**（恰好 1 次 `send`）。
   *
   * ⚠️ 用假定时器：`NEVER`（永不回包）+ 推进 3s。忘了接 `timeout()` 时本用例会挂到
   * vitest 的用例上限而红（与 `game.client.test.ts` 的超时用例同款）。
   */
  it('超时 ⇒ 10007，且恰好 1 次 send（不重试）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, calls } = fakeProxy(() => NEVER);
      const p = new ConfigClient(proxy).snapshot();
      // ⚠️ 断言**先挂上**再推进定时器：否则「超时那一刻的 rejection」会在没人 await 的
      // 窗口里出现（vitest 会把它记成 unhandled rejection）。
      const expectation = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });

      // 还没到 3s：仍在挂起（证明不是「立刻失败」、也不是没有超时）
      await vi.advanceTimersByTimeAsync(2_900);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      await expectation;
      expect(calls).toHaveLength(1); // 不重试：§4.3 的重试表不含这条边
    } finally {
      vi.useRealTimers();
    }
  });
});
