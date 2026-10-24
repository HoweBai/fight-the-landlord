/**
 * 错误上报（项 8）：
 * - 未配置端点 ⇒ console.warn 降级、不出端；
 * - 配置后 ⇒ JSON POST（字段/脱敏/采样）；
 * - 同 scope|message 10 秒去重；
 * - 上报自身永远不抛（uni.request 失败也静默）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUniStub, type UniStub } from './helpers/uni-stub';
import { __resetReporterForTest, redact, reportError } from '../src/observability/reporter';

describe('redact 本地脱敏', () => {
  it('敏感键整值抹掉（token/hand 及嵌套 password），普通键保留', () => {
    const out = redact({
      token: 'abc',
      hand: [{ r: 3, s: 0 }],
      roomCode: 'R1',
      nested: { password: 'x', keep: 2 },
    });
    expect(out).toEqual({
      token: '[redacted]',
      hand: '[redacted]',
      roomCode: 'R1',
      nested: { password: '[redacted]', keep: 2 },
    });
  });

  it('bottomCards / recentActions / authorization 都在敏感名单', () => {
    const out = redact({
      bottomCards: [],
      recentActions: [],
      authorization: 'Bearer x',
      safe: 1,
    }) as Record<string, unknown>;
    expect(out.bottomCards).toBe('[redacted]');
    expect(out.recentActions).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.safe).toBe(1);
  });

  it('数组逐层脱敏、超长字符串截断', () => {
    const out = redact([{ token: 't', ok: 1 }]) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ token: '[redacted]', ok: 1 });
    const clipped = redact('x'.repeat(5000)) as string;
    expect(clipped.length).toBeLessThan(3000);
    expect(clipped).toContain('[truncated]');
  });
});

describe('reportError 上报流程', () => {
  let stub: UniStub;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = installUniStub();
    __resetReporterForTest();
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 默认：未配置端点。
    vi.stubEnv('VITE_ERROR_REPORT_URL', '');
    vi.stubEnv('VITE_ERROR_REPORT_SAMPLE_RATE', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('未配置端点 ⇒ console.warn 降级，不发任何请求', () => {
    reportError('app.onError', new Error('boom'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('app.onError');
    expect(stub.calls.request).toHaveLength(0);
  });

  it('配置后 ⇒ POST JSON：URL/方法/头与负载字段正确', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    reportError('app.onError', new Error('boom'), { roomCode: 'R1' });

    expect(stub.calls.request).toHaveLength(1);
    const req = stub.calls.request[0]!;
    expect(req.url).toBe('/api/client-errors');
    expect(req.method).toBe('POST');
    expect(req.header).toMatchObject({ 'content-type': 'application/json' });
    // 客户端接入片 C30 负对照：外部收集端是裸 uni.request（不经 rest.ts 收口）
    // ⇒ 不得注入端标识头（判据射程：上报面永远不带 X-Client-Platform）。
    expect(req.header).not.toHaveProperty('X-Client-Platform');

    const payload = req.data as Record<string, unknown>;
    expect(payload.scope).toBe('app.onError');
    expect(payload.message).toBe('boom');
    expect(typeof payload.stack).toBe('string');
    expect(payload).toHaveProperty('appVersion');
    expect(payload).toHaveProperty('at');
    expect(payload).toHaveProperty('page');
    expect(payload.context).toEqual({ roomCode: 'R1' });
  });

  it('发送负载里敏感字段已脱敏', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    reportError('vue.errorHandler', new Error('x'), {
      info: 'render',
      token: 'secret-token',
      hand: [{ r: 3 }],
    });
    const context = (stub.calls.request[0]!.data as { context: Record<string, unknown> }).context;
    expect(context.info).toBe('render');
    expect(context.token).toBe('[redacted]');
    expect(context.hand).toBe('[redacted]');
  });

  it('同一 scope|message 10 秒内只发一次；窗口过后可再发', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    reportError('app.onError', new Error('repeat'));
    reportError('app.onError', new Error('repeat'));
    expect(stub.calls.request).toHaveLength(1);

    vi.advanceTimersByTime(9_999);
    reportError('app.onError', new Error('repeat'));
    expect(stub.calls.request).toHaveLength(1);

    vi.advanceTimersByTime(2);
    reportError('app.onError', new Error('repeat'));
    expect(stub.calls.request).toHaveLength(2);
  });

  it('不同 message 互不影响去重', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    reportError('app.onError', new Error('a'));
    reportError('app.onError', new Error('b'));
    expect(stub.calls.request).toHaveLength(2);
  });

  it('采样率 0 ⇒ 不发送也不 console 降级（静默丢弃）', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    vi.stubEnv('VITE_ERROR_REPORT_SAMPLE_RATE', '0');
    reportError('app.onError', new Error('sampled-out'));
    expect(stub.calls.request).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('非 Error 值（字符串 / undefined）也能规范化上报', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    reportError('app.unhandledrejection', 'string reason');
    reportError('app.unhandledrejection', undefined);
    const messages = stub.calls.request.map(
      (r) => (r.data as { message: string }).message,
    );
    expect(messages[0]).toBe('string reason');
    expect(messages[1]).toBe('unknown error');
  });

  it('uni.request 走 fail 分支（网络失败）时上报自身不抛', () => {
    vi.stubEnv('VITE_ERROR_REPORT_URL', '/api/client-errors');
    // stub 默认无 requestResponder ⇒ 立即 fail；reporter 传了空 fail，不应有未处理异常。
    expect(() => reportError('app.onError', new Error('network-fail'))).not.toThrow();
    expect(stub.calls.request).toHaveLength(1);
  });
});
