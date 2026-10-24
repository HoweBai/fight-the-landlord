/**
 * `game-service` 的 `robot.decide` 客户端（N20/P4 Task 4 / §4.2 / §4.3）。
 *
 * §4.3 逐字：`robot.decide`（game → robot）**5s / 不重试 / 失败 ⇒ 回退规则引擎**。
 *
 * ⚠️ **R221**：判据必须走**真实 pipeline**（`proxy.send()` 返回可控 Observable，
 * 经本文件的 `timeout()` / 形状校验），而不是只断言「调了 `send()`」——
 * 后者在「超时没接上」「重试多接了一层」时照样绿。
 *
 * ⚠️ 与旧实现（`fetch` + `AbortSignal.timeout`）的语义**逐字保留**：
 *  - 超时 **5s**（`ROBOT_DECIDE_TIMEOUT_MS` 不变）；
 *  - **任何**失败（传输错 / 超时 / HTTP 错 / 形状非法）都返回 `null`，**绝不抛** ——
 *    调用方（`GameService.driveOneRobotTurn`）据此回退本地规则引擎（C9/§9.4）。
 */
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_PATTERNS, type RobotDecideRequest } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { RobotClient, ROBOT_DECIDE_TIMEOUT_MS } from '../src/game/robot.client';

/** 一条形状合法的 `robot.decide` 请求（§4.2）。 */
const req: RobotDecideRequest = {
  roomCode: 'R1',
  botId: 'bot-1',
  skillLevel: 'beginner',
  view: { roomCode: 'R1', seat: 0 } as never,
  features: {} as never,
};

/** 可控的假 `ClientProxy`：按 pattern 返回预置 Observable，并记录调用。 */
function fakeProxy(handler: () => unknown) {
  const calls: Array<{ pattern: string; data: unknown }> = [];
  return {
    calls,
    send: (pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      return handler();
    },
  };
}

describe('§4.2/§4.3：robot.decide 走 TCP RPC（N20/P4 Task 4）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('打的是 RPC_PATTERNS.robotDecide，载荷逐字，信封解包后返回 data', async () => {
    const proxy = fakeProxy(() => of({ ok: true, data: { kind: 'play', cards: [3], source: 'rule' } }));
    const client = new RobotClient(proxy as never);

    await expect(client.decide(req)).resolves.toEqual({ kind: 'play', cards: [3], source: 'rule' });
    expect(proxy.calls).toEqual([{ pattern: RPC_PATTERNS.robotDecide, data: req }]);
  });

  it('R220：`{ok:false,code}` 的信封 ⇒ null（不抛，§9.4 由调用方回退规则引擎）', async () => {
    const proxy = fakeProxy(() => of({ ok: false, code: 13001, message: 'nope' }));
    await expect(new RobotClient(proxy as never).decide(req)).resolves.toBeNull();
  });

  /**
   * **判据 5（对称一半）**：`game → robot` 这一跳也要带上 `meta`（R1104 的「全链」含
   * 机器人决策，spec §1 表尾逐字）。
   *
   * ⚠️ 负对照（无 ALS ⇒ **没有** `meta` 键）就是本文件第一条用例的 `toEqual` 逐字断言
   * （`data: req`）—— 它跑在无 ALS 的单测里，正是「省略语义」的判据。
   */
  it('判据 5：ALS 有上下文 ⇒ decide 载荷带 meta{traceId,reqId,userId}', async () => {
    const proxy = fakeProxy(() => of({ ok: true, data: { kind: 'pass', source: 'rule' } }));

    await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'rpc' }, () =>
      new RobotClient(proxy as never).decide(req),
    );

    expect(proxy.calls).toEqual([
      {
        pattern: RPC_PATTERNS.robotDecide,
        data: { ...req, meta: { traceId: 'T9', reqId: 'R9', userId: 'U9' } },
      },
    ]);
  });

  it('传输抛错（ECONNREFUSED / ECONNRESET）⇒ null', async () => {
    const proxy = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));
    await expect(new RobotClient(proxy as never).decide(req)).resolves.toBeNull();
  });

  /**
   * §4.3 的核心判据：**5s 超时**且**只发 1 次**（不重试）。
   *
   * ⚠️ 三条断言缺一不可：
   *  ① 到 5s 才失败（不是立刻、也不是永远挂着）；
   *  ② 失败 ⇒ `null`（不是抛错）；
   *  ③ `send()` 只被调用 **1** 次 —— 这条是本用例的**判别力**所在：
   *     若误加了 `retry()`，计数会变成 2 且 10s 才结束，而 ① ② 仍可能通过。
   */
  it('§4.3 逐字：超时 5s ⇒ null，且**只发 1 次**（不重试）', async () => {
    vi.useFakeTimers();
    const proxy = fakeProxy(() => NEVER);
    const p = new RobotClient(proxy as never).decide(req);

    // ① 还没到 5s：必须仍在挂起（证明超时不是「立刻失败」）
    await vi.advanceTimersByTimeAsync(ROBOT_DECIDE_TIMEOUT_MS - 100);
    expect(proxy.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeNull(); // ② 超时 ⇒ null

    expect(ROBOT_DECIDE_TIMEOUT_MS).toBe(5000); // §4.3 逐字
    expect(proxy.calls).toHaveLength(1); // ③ 不重试
  });

  it('形状非法的应答（kind 不是 play/pass）⇒ null（与旧实现逐字同义）', async () => {
    const bad = fakeProxy(() => of({ ok: true, data: { kind: 'zzz' } }));
    await expect(new RobotClient(bad as never).decide(req)).resolves.toBeNull();

    const empty = fakeProxy(() => of({ ok: true, data: null }));
    await expect(new RobotClient(empty as never).decide(req)).resolves.toBeNull();
  });
});
