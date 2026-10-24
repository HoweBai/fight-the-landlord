import { describe, expect, it } from 'vitest';
import { runWithTrace } from './trace-context';
import { metaFromTrace } from './rpc-meta';

/**
 * `metaFromTrace()` —— RPC 载荷的元数据（R1104 的载体 / R1105 的省略语义）。
 *
 * ⚠️ **判据边界**（spec §5 的「判据边界」一节）：**无 ALS ⇒ 无 meta** 这一分支在
 * **真栈上不可达**（网关/HTTP 入口恒自建 traceId）⇒ 它只有单测覆盖，所以这几条必须存在
 * ——否则「省略语义」在整仓没有任何一条判据。
 */
describe('metaFromTrace：发送侧统一附加 meta（R1104/R1105）', () => {
  it('无 ALS ⇒ `{}`（**没有** meta 键，不是一个 `meta: undefined`；R1105）', () => {
    const out = metaFromTrace();
    expect(out).toEqual({});
    // 省略语义要的是**键的在与不在**：展开后若多出一个 `meta` 键，既有「逐字载荷」断言就全红
    expect('meta' in out).toBe(false);
  });

  it('traceId 为 null（**合法值**，R1107）⇒ 同样**不加** meta —— 绝不拿假 id 冒充', () => {
    // 定时器轮级 catch 与启动早期就是这种形态（`{traceId: null, source: 'bootstrap'|'timer'}`）
    const out = runWithTrace({ traceId: null, source: 'bootstrap' }, () => metaFromTrace());
    expect('meta' in out).toBe(false);
  });

  it('有 traceId ⇒ `{meta:{traceId}}`；reqId/userId 缺省时**键不出现**', () => {
    const out = runWithTrace({ traceId: 'T1', source: 'timer' }, () => metaFromTrace());
    expect(out).toEqual({ meta: { traceId: 'T1' } });
  });

  it('三个 id 齐全 ⇒ 逐字 `{traceId, reqId, userId}`（**不含** source —— 它不是 RpcMeta 的字段）', () => {
    const out = runWithTrace(
      { traceId: 'T1', reqId: 'R1', userId: 'U1', source: 'edge' },
      () => metaFromTrace(),
    );
    expect(out).toEqual({ meta: { traceId: 'T1', reqId: 'R1', userId: 'U1' } });
  });
});
