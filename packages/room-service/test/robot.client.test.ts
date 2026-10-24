/**
 * `robot-service` 客户端的传输层契约（N20/P4 Task 3 / §9.6）。
 *
 * `RobotClient.release(botIds)` 的**签名与语义逐字不变**：
 *  - 打 `RPC_PATTERNS.robotRelease`，载荷 `{ botIds }`；
 *  - 成功 ⇒ 返回 `{released}` 的数值；
 *  - 空数组 ⇒ **不发 RPC**，直接返回 0（省一次无意义的网络往返）；
 *  - **任何失败 ⇒ 返回 0 且不抛**（§9.6：局终归池是**兜底**，不能反过来打断对局收尾；
 *    真正的保险是 `RobotReclaimTask` 的 10 分钟回收）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import {
  createCapturingSink,
  createRedactingLogger,
  runWithTrace,
} from '@fight-the-landlord/shared';
import { RobotClient, ROBOT_RELEASE_TIMEOUT_MS } from '../src/gateway/robot.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/gateway/transport-failure';

/**
 * **M4（`message.router.test.ts` 的成例）**：`Logger.overrideLogger` 是**进程级**的 ——
 * 用后不还原的话，本文件里**后追加**的用例会静默写进一个已经死掉的 sink。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

interface SendCall {
  pattern: string;
  data: unknown;
}

function fakeProxy(handler: () => unknown) {
  const calls: SendCall[] = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    calls.push({ pattern, data });
    return handler();
  });
  return { proxy: { send } as never, calls };
}

describe('RobotClient.release 走 TCP RPC（N20/P4 Task 3）', () => {
  it('打的是 RPC_PATTERNS.robotRelease，载荷 `{botIds}` 逐字，返回 released', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { released: 2 } }));

    await expect(new RobotClient(proxy).release(['bot-1', 'bot-2'])).resolves.toBe(2);
    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.robotRelease, data: { botIds: ['bot-1', 'bot-2'] } },
    ]);
  });

  it('空数组 ⇒ **不发 RPC**，直接 0（旧实现同样早退）', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { released: 9 } }));

    await expect(new RobotClient(proxy).release([])).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('§9.6 兜底：传输抛错 ⇒ 返回 0 且**不抛**（归池失败不得打断局终收尾）', async () => {
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));
    await expect(new RobotClient(proxy).release(['bot-1'])).resolves.toBe(0);
  });

  it('§9.6 兜底：信封 `{ok:false}` ⇒ 返回 0 且不抛', async () => {
    const { proxy } = fakeProxy(() => of({ ok: false, code: 13001, message: 'nope' }));
    await expect(new RobotClient(proxy).release(['bot-1'])).resolves.toBe(0);
  });

  /**
   * **判据 5**（R1104/R1105）：ALS 有上下文 ⇒ 载荷带上 `meta`。
   *
   * ⚠️ 负对照（无 ALS ⇒ 载荷里**没有** `meta` 键）就是本文件第一条用例的 `toEqual` 逐字
   * 断言（它跑在无 ALS 的单测里）—— 两条成对，才钉住「省略语义 / 统一附加」两面。
   *
   * `acquire` 的同款覆盖在 `match.service.test.ts` 的「判据 5」describe 里（那条链会
   * 真的走到 `RobotClient.acquire`）。
   */
  it('判据 5：ALS 有上下文 ⇒ release 载荷带 meta{traceId,reqId,userId}', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { released: 1 } }));

    await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'edge' }, () =>
      new RobotClient(proxy).release(['bot-1']),
    );

    expect(calls).toEqual([
      {
        pattern: RPC_PATTERNS.robotRelease,
        data: { botIds: ['bot-1'], meta: { traceId: 'T9', reqId: 'R9', userId: 'U9' } },
      },
    ]);
  });

  it('超时 3s ⇒ 返回 0（§4.3：robot.* 通道 3s，与 robot.acquire 同值）', async () => {
    vi.useFakeTimers();
    try {
      const { proxy } = fakeProxy(() => NEVER);
      const p = new RobotClient(proxy).release(['bot-1']);

      await vi.advanceTimersByTimeAsync(ROBOT_RELEASE_TIMEOUT_MS + 50);
      await expect(p).resolves.toBe(0);
      expect(ROBOT_RELEASE_TIMEOUT_MS).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `RobotClient.acquire` 的错误语义（§9.6 第 1 条 + Task 3g 修复 I2）。
 *
 * 与另外两个 client（`game` / `config`）**同一套规则**：
 *  - **传输层故障**（连不上 / 超时）⇒ 原因**只进日志**，消息给固定文案
 *    （修前这里是**裸放**：`err.message` 就是 `ECONNREFUSED <ip:port>`；
 *    今天它只到 `rooms.start.ts` 的 `logger.error`，但同一规则一起收口）；
 *  - **业务错误**（信封 `{ok:false}` 带来的码与消息）⇒ **逐字保留**下游文案
 *    （调用方靠它走 §8.4② 的降级判断）。
 */
describe('RobotClient.acquire 的错误语义（Task 3g 修复 I2）', () => {
  it('成功 ⇒ 打 robotAcquire、解信封返回 data', async () => {
    const bot = {
      botId: 'bot-00000001',
      displayId: 'p_00000001',
      skillLevel: 'beginner',
      personality: { thinkingSpeed: 900 },
      roomCode: 'ROOM1',
      seat: 1,
      gamesPlayed: 0,
    };
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { bots: [bot] } }));

    const res = await new RobotClient(proxy).acquire('ROOM1', [1]);

    expect(res.bots).toEqual([bot]);
    expect(calls).toEqual([
      { pattern: RPC_PATTERNS.robotAcquire, data: { roomCode: 'ROOM1', seats: [1] } },
    ]);
  });

  it('信封 `{ok:false}` ⇒ 业务码与**下游消息逐字保留**（调用方要据此降级）', async () => {
    const { proxy } = fakeProxy(() => of({ ok: false, code: 13001, message: '池为空' }));

    const err = (await new RobotClient(proxy)
      .acquire('ROOM1', [1])
      .catch((e: unknown) => e)) as Error;

    expect(err.message).toContain('13001');
    expect(err.message).toContain('池为空'); // 业务文案不得被替换成通用文案
  });

  /**
   * 🔴 传输层故障 ⇒ 消息是**固定文案**（不含原因），原因只进日志。
   *
   * 修前这里把 `lastValueFrom` 的传输错误**裸放** ⇒ 错误对象的 message 就是
   * `ECONNREFUSED 172.28.0.5:3005` 这类内部拓扑。收口后与 game/config 同形。
   */
  it('🔴 传输层故障 ⇒ 固定文案（不含原因），原因只进日志', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED 172.28.0.5:3005')));

    const err = (await new RobotClient(proxy)
      .acquire('ROOM1', [1])
      .catch((e: unknown) => e)) as Error;

    expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.5');
    expect(err.message).not.toContain('robot-service'); // 服务名同样是内部拓扑
    // 正对照：详情必须进日志（不透传 ≠ 不留痕）
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.5:3005');
  });
});
