import { describe, expect, it } from 'vitest';
import { createTraceMiddleware } from './trace-middleware';
import { currentTrace } from './trace-context';

const run = (mw: any, headers: Record<string, unknown>) => {
  const res = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; } };
  let seen: ReturnType<typeof currentTrace> | undefined;
  mw({ headers, method: 'POST' }, res, () => { seen = currentTrace(); });
  return { seen, res };
};

describe('createTraceMiddleware（R1106 / R1107）', () => {
  it('有 X-Trace-Id ⇒ 继承（source: edge），并回传到响应头', () => {
    const { seen, res } = run(createTraceMiddleware(), { 'x-trace-id': 'UP1', 'x-user-id': 'U1' });
    expect(seen).toMatchObject({ traceId: 'UP1', userId: 'U1', source: 'edge' });
    expect(res.headers['X-Trace-Id']).toBe('UP1');
  });

  it('没有 X-Trace-Id ⇒ **自建**一个（直连下游的路径也要有链，如 conformance 探针）', () => {
    const { seen } = run(createTraceMiddleware(), {});
    expect(typeof seen!.traceId).toBe('string');
    expect(seen!.traceId!.length).toBeGreaterThan(0);
  });

  it('负对照（判据 10 的单测半边）：overwriteExisting ⇒ **不采信**客户端给的值', () => {
    const { seen } = run(createTraceMiddleware({ overwriteExisting: true }), { 'x-trace-id': 'attacker' });
    expect(seen!.traceId).not.toBe('attacker');
  });

  it('负对照：overwriteExisting 下**公开路径**（无 x-user-id）也必须生成并回传', () => {
    const { seen, res } = run(createTraceMiddleware({ overwriteExisting: true }), {});
    expect(seen!.traceId).not.toBeNull();
    expect(res.headers['X-Trace-Id']).toBe(seen!.traceId);
  });

  it('复核⑩：网关形态**不读** x-user-id（客户端自带的身份永不可信）', () => {
    const { seen } = run(createTraceMiddleware({ overwriteExisting: true }), { 'x-user-id': 'victim' });
    expect(seen!.userId).toBeNull();
    expect(seen!.traceId).not.toBeNull();
  });
});
