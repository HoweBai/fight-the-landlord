import { describe, expect, it } from 'vitest';
import { TRACE_SOURCES, currentTrace, runWithTrace } from './trace-context';

describe('trace-context：ALS 载体（§3）', () => {
  it('无来源 ⇒ currentTrace() 是 undefined（R1107：不得编造）', () => {
    expect(currentTrace()).toBeUndefined();
  });

  it('runWithTrace 里能读到；出了作用域读不到', () => {
    const seen = runWithTrace({ traceId: 'T1', source: 'edge' }, () => currentTrace());
    expect(seen).toEqual({ traceId: 'T1', source: 'edge' });
    expect(currentTrace()).toBeUndefined();
  });

  it('跨 await 仍然有效（这是它能贯穿全链的前提）', async () => {
    const seen = await runWithTrace({ traceId: 'T2', source: 'rpc' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTrace();
    });
    expect(seen?.traceId).toBe('T2');
  });

  it('嵌套以**内层**为准，且退出后回到外层', () => {
    const out = runWithTrace({ traceId: 'OUT', source: 'edge' }, () => {
      const inner = runWithTrace({ traceId: 'IN', source: 'timer' }, () => currentTrace());
      return [inner?.traceId, currentTrace()?.traceId];
    });
    expect(out).toEqual(['IN', 'OUT']);
  });

  /**
   * **判据 2 的取值域钉子**（最终评审 I2，**只增不减**）：`source` 恰好五个 ——
   * `internal` 是 I2 新增的第 5 个（socket 生命周期 / Redis 订阅这两族原先落成
   * `bootstrap` = 假话，而 `bootstrap` 的原义是「进程启动早期」）。
   *
   * ⚠️ 与 `LOG_FIELDS` 的「恰好九个」同一纪律：**加值必须先改判据**。
   * `TRACE_SOURCES` 是运行期唯一真源、类型由它派生 ⇒ 类型与判据不可能各自漂移。
   */
  it('判据 2（取值域）：`source` 恰好五值，且 `internal` 可用（traceId 为 null 是合法值）', () => {
    expect([...TRACE_SOURCES]).toEqual(['edge', 'rpc', 'timer', 'internal', 'bootstrap']);
    // 语义（写进注释的那句）：内部事件触发 ⇒ 无已知来源、**不编造** id（R1107 的原始场景）。
    const seen = runWithTrace({ traceId: null, source: 'internal' }, () => currentTrace());
    expect(seen).toEqual({ traceId: null, source: 'internal' });
  });
});
