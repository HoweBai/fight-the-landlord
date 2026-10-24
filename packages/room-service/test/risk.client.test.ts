/**
 * `RiskClient` 的**传输层契约**（风控片 T3 / 规格 §2.1-4 / §2.8 发送侧 / ⚙️21）。
 *
 * 与 `record.client.test.ts` 同族同纪律（R70/R221）：判据走**真实 pipeline**
 * （假 `ClientProxy.send()` 返回可控 Observable），而不是只断言「调了 `send()`」——
 * 后者在「超时没接上」「meta 没随行」时照样绿。
 *
 * 本文件钉住四条性质（⚙️21 逐字）：
 *  ① 打的是 `RPC_PATTERNS.riskDeviceReport`，载荷 = `{userId, deviceId}` + meta
 *     （无 ALS ⇒ 展开 `{}` ⇒ 载荷恰好两字段 —— R1104/R1105 的省略语义）；
 *  ② **不抛**：返回值是 `void`，失败（传输故障 / 超时 / 信封 `{ok:false}`）只留
 *     **warn 日志一行** —— 调用方（`handleMatch`）在 ack 之后 fire-and-forget，绝不接错；
 *  ③ **不重试**：恰好 1 次 `send`（设计 D3 / ⚙️21 明文，§4.3 的重试表不含这条边）；
 *  ④ 超时 **3s**（与 `record.write` 同一预算）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RISK_DEVICE_REPORT_TIMEOUT_MS, RiskClient } from '../src/gateway/risk.client';

/**
 * **M4（`message.router.test.ts` 的成例）**：`Logger.overrideLogger` 是**进程级**的 ——
 * 用后不还原的话，本文件里**后追加**的用例会静默写进一个已经死掉的 sink。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

/** 一次 `proxy.send()` 的调用记录（照 `record.client.test.ts` 的同名工厂）。 */
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

/** 装捕获 sink（照 record.client.test.ts 的同款）。 */
function installSink() {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
  return records;
}

/** fire-and-forget 的内部 promise 需要一次 tick 才落定（日志断言前用）。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('RiskClient.report() 的 RPC 契约（pattern 名 + 载荷 + meta）', () => {
  it('打 RPC_PATTERNS.riskDeviceReport，载荷 = {userId, deviceId} + meta（无 ALS ⇒ 空展开，`toEqual` 恰好比对）', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true }));

    new RiskClient(proxy).report('alice', 'dev-abc123');
    await settle();

    expect(calls).toEqual([
      {
        pattern: RPC_PATTERNS.riskDeviceReport,
        data: { userId: 'alice', deviceId: 'dev-abc123' },
      },
    ]);
  });

  it('信封 `{ok:false}`（如接收侧 BAD_PARAM）⇒ 不抛、warn 一行（⚙️21：失败只留日志）', async () => {
    const records = installSink();
    const { proxy } = fakeProxy(() => of({ ok: false, code: 'BAD_PARAM' }));

    expect(() => new RiskClient(proxy).report('ghost', 'dev-abc123')).not.toThrow();
    await settle();

    expect(records.map((r) => `${r.level}:${r.msg}`).join('\n')).toContain('risk.deviceReport');
    expect(records.map((r) => r.msg).join('\n')).toContain('BAD_PARAM');
  });

  it('🔴 传输层故障 ⇒ **不抛**、warn 一行（原因可进日志；调用方零感知）', async () => {
    const records = installSink();
    const { proxy } = fakeProxy(() => throwError(() => new Error('connect ECONNREFUSED 172.28.0.9:3101')));

    expect(() => new RiskClient(proxy).report('alice', 'dev-abc123')).not.toThrow();
    await settle();

    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3101');
  });

  /**
   * 超时（3s）也是「拿不到应答」⇒ warn 一行、**不重试**（恰好 1 次 `send`；⚙️21）。
   *
   * ⚠️ 假定时器：`NEVER`（永不回包）+ 推进 3s。忘了接 `timeout()` 时本用例会因为
   * 「日志永远不出现」而红（与 record.client.test.ts 的超时用例同款）。
   */
  it('超时 ⇒ warn（不抛）、恰好 1 次 send（不重试；⚙️21）', async () => {
    vi.useFakeTimers();
    try {
      const records = installSink();
      const { proxy, calls } = fakeProxy(() => NEVER);

      new RiskClient(proxy).report('alice', 'dev-abc123');
      // 还没到 3s：仍在挂起（证明 timeout 真的接上了，不是「立刻失败」）
      await vi.advanceTimersByTimeAsync(RISK_DEVICE_REPORT_TIMEOUT_MS - 100);
      expect(calls).toHaveLength(1);
      expect(records.map((r) => r.msg).join('\n')).not.toContain('risk.deviceReport');

      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toHaveLength(1); // 不重试：§4.3 的重试表不含这条边
      expect(records.map((r) => r.msg).join('\n')).toContain('risk.deviceReport');
    } finally {
      vi.useRealTimers();
    }
  });
});
