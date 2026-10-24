/**
 * `net/token-refresh.ts`：JWT exp 本地解码 + 五态续期（单飞 + 代数交错保护）。
 *
 * 契约：所有用例走 `vi.resetModules()` + 动态 import，确保模块级 `refreshInFlight`
 * 与 session 代数在每个用例开头干净（rest-auth.test.ts 的既有范式）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installUniStub } from './helpers/uni-stub';

/** 造 base64url 字符串（JWT 段用）。自带 padding 处理。 */
function b64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 造一个**合法 JWT**：header.payload.signature。
 * payload 里必须带 `exp`（epoch 秒），它由调用方控制。
 *
 * - `exp` 传入**未来秒数** → 生成的 token 新鲜（skew=60s 内未过期）
 * - `exp` 传入**过去秒数** → 生成的 token 过期
 */
function makeJwt(expEpoch: number, sub = 'u1'): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub, exp: expEpoch });
  return `${header}.${payload}.fake-sig`;
}

/** 造 fetch mock 的应答（同 rest-auth.test.ts 的 jsonOnce）。 */
function jsonOnce(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
}

describe('net/token-refresh：JWT exp 本地解码与新鲜度', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('decodeJwtExp：合法 JWT 读出 exp epoch', async () => {
    const { decodeJwtExp } = await import('../src/net/token-refresh');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(decodeJwtExp(makeJwt(exp))).toBe(exp);
  });

  it('decodeJwtExp：段数不对 → null（按新鲜处理，不拦握手）', async () => {
    const { decodeJwtExp } = await import('../src/net/token-refresh');
    expect(decodeJwtExp('only.one')).toBeNull();
    expect(decodeJwtExp('')).toBeNull();
    expect(decodeJwtExp('a.b.c.d')).toBeNull();
  });

  it('decodeJwtExp：payload 非 JSON / 无 exp → null', async () => {
    const { decodeJwtExp } = await import('../src/net/token-refresh');
    // 造一个段数=3、但 payload 不是合法 JSON 对象的假 JWT
    const badPayload = Buffer.from('not-json', 'utf8').toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeJwtExp(`xxx.${badPayload}.yyy`)).toBeNull();
    // 有 exp 但不是 number
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const nonNumPayload = b64url({ exp: 'tomorrow' });
    expect(decodeJwtExp(`${header}.${nonNumPayload}.sig`)).toBeNull();
  });

  it('isAccessTokenFresh：exp - now > skewMs/1000 → true', async () => {
    const { isAccessTokenFresh } = await import('../src/net/token-refresh');
    const nowMs = 1_000_000_000_000; // 固定 now
    const expEpoch = Math.floor(nowMs / 1000) + 120; // 距过期 120s > skew 60s
    expect(isAccessTokenFresh(makeJwt(expEpoch), 60_000, nowMs)).toBe(true);
  });

  it('isAccessTokenFresh：距过期 ≤ skewMs → false（提前续期）', async () => {
    const { isAccessTokenFresh } = await import('../src/net/token-refresh');
    const nowMs = 1_000_000_000_000;
    const expEpoch = Math.floor(nowMs / 1000) + 50; // 距过期 50s < skew 60s → 需续期
    expect(isAccessTokenFresh(makeJwt(expEpoch), 60_000, nowMs)).toBe(false);
  });

  it('isAccessTokenFresh：已过期（exp < now）→ false', async () => {
    const { isAccessTokenFresh } = await import('../src/net/token-refresh');
    const nowMs = 1_000_000_000_000;
    const expEpoch = Math.floor(nowMs / 1000) - 10;
    expect(isAccessTokenFresh(makeJwt(expEpoch), 60_000, nowMs)).toBe(false);
  });

  it('isAccessTokenFresh：非法 JWT（段数不对）→ true（按新鲜，dev mock 路径）', async () => {
    const { isAccessTokenFresh } = await import('../src/net/token-refresh');
    expect(isAccessTokenFresh('dev-mock-token-without-exp', 60_000, 1_000_000_000_000)).toBe(true);
  });
});

describe('net/token-refresh：refreshTokens 信封解析与五态分类', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('成功 refresh → 返回 {code:0, data:{accessToken, refreshToken}}', async () => {
    const fetchMock = vi.fn(async () =>
      jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { refreshTokens } = await import('../src/net/token-refresh');

    const res = await refreshTokens('r1');
    expect(res.code).toBe(0);
    expect((res as { data: { accessToken: string } }).data.accessToken).toBe('a2');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(String(url)).toContain('/auth/refresh');
    expect(String((init as RequestInit).body)).toContain('r1');
  });

  it('服务端 10002/10004/10005（三码）→ 原样返回（调用方判 invalid）', async () => {
    const { refreshTokens } = await import('../src/net/token-refresh');
    for (const code of [10002, 10004, 10005]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonOnce({ code, message: 'bad', data: null }, 401)),
      );
      const res = await refreshTokens('r1');
      expect(res.code).toBe(code);
    }
  });

  it('服务端 10007（TOAST）→ 原样返回（调用方判 unavailable）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonOnce({ code: 10007, message: 'upstream down', data: null }, 503)),
    );
    const { refreshTokens } = await import('../src/net/token-refresh');
    const res = await refreshTokens('r1');
    expect(res.code).toBe(10007);
  });

  it('fetch 抛 TypeError（网络不可达）→ 返回 10007 信封（不抛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { refreshTokens } = await import('../src/net/token-refresh');
    const res = await refreshTokens('r1');
    expect(res.code).toBe(10007);
  });

  it('fetch 返回非平台信封（HTML 错误页）→ 映射 10007', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 502,
        text: async () => '<html>502 Bad Gateway</html>',
      } as Response)),
    );
    const { refreshTokens } = await import('../src/net/token-refresh');
    const res = await refreshTokens('r1');
    expect(res.code).toBe(10007);
  });
});

describe('net/token-refresh：doRefresh 五态 & 单飞 & 代数交错', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rotateRefreshToken：无本地会话 → no_session', async () => {
    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    expect(await rotateRefreshToken()).toBe('no_session');
  });

  it('rotateRefreshToken：有会话但 refreshToken 为空 → no_session', async () => {
    installUniStub();
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: '', userId: 'u1', phone: '', nickname: '' });
    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    expect(await rotateRefreshToken()).toBe('no_session');
  });

  it('ensureFreshAccessToken：无本地 accessToken → no_session', async () => {
    const { clientConfig } = await import('../src/config');
    clientConfig.token = ''; // 预检会先读 clientConfig，空就继续查存储
    // 没存会话
    const { ensureFreshAccessToken } = await import('../src/net/token-refresh');
    expect(await ensureFreshAccessToken()).toBe('no_session');
  });

  it('ensureFreshAccessToken：clientConfig.token 新鲜 → fresh（零请求）', async () => {
    installUniStub();
    const nowMs = 1_000_000_000_000;
    const expEpoch = Math.floor(nowMs / 1000) + 3600;
    const token = makeJwt(expEpoch);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = token;
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: token, refreshToken: 'r1', userId: 'u1', phone: '138', nickname: 'test' });

    const fetchMock = vi.fn(async () => jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { ensureFreshAccessToken } = await import('../src/net/token-refresh');
    const result = await ensureFreshAccessToken(nowMs);
    expect(result).toBe('fresh');
    expect(fetchMock).not.toHaveBeenCalled(); // 零请求
  });

  it('ensureFreshAccessToken：token 过期 → rotated（refresh 成功 + 写回五字段）', async () => {
    installUniStub();
    const nowMs = 1_000_000_000_000;
    const expEpoch = Math.floor(nowMs / 1000) - 600; // 已过期 10 分钟
    const oldToken = makeJwt(expEpoch);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = oldToken;
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: oldToken, refreshToken: 'r1', userId: 'u1', phone: '13800000000', nickname: 'Alice' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonOnce({ code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } })),
    );

    const { ensureFreshAccessToken } = await import('../src/net/token-refresh');
    const result = await ensureFreshAccessToken(nowMs);
    expect(result).toBe('rotated');
    expect(clientConfig.token).toBe('new-access');
    const stored = loadSession();
    expect(stored?.accessToken).toBe('new-access');
    expect(stored?.refreshToken).toBe('new-refresh');
    // 展示资料原样带过去（续期不会擦掉 nickname）
    expect(stored?.phone).toBe('13800000000');
    expect(stored?.nickname).toBe('Alice');
  });

  it('refresh 返回 10004 → invalid（确定性拒绝）', async () => {
    installUniStub();
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonOnce({ code: 10004, message: 'expired', data: null }, 401)),
    );
    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    expect(await rotateRefreshToken()).toBe('invalid');
  });

  it('refresh 返回 10007 → unavailable（不判死，保留重连机会）', async () => {
    installUniStub();
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonOnce({ code: 10007, message: 'upstream', data: null }, 503)),
    );
    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    expect(await rotateRefreshToken()).toBe('unavailable');
  });

  it('单飞：并发两次 ensureFreshAccessToken 只发一次网络请求', async () => {
    installUniStub();
    const nowMs = 1_000_000_000_000;
    const expEpoch = Math.floor(nowMs / 1000) - 600;
    const oldToken = makeJwt(expEpoch);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = oldToken;
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: oldToken, refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const fetchMock = vi.fn(async () => jsonOnce({ code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { ensureFreshAccessToken } = await import('../src/net/token-refresh');
    const [a, b] = await Promise.all([
      ensureFreshAccessToken(nowMs),
      ensureFreshAccessToken(nowMs),
    ]);

    expect(a).toBe('rotated');
    expect(b).toBe('rotated');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 单飞
  });

  it('单飞：invalid / unavailable 结束后下一次调用仍能再次请求（单飞 Promise 自动释放）', async () => {
    installUniStub();
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    let callNum = 0;
    const fetchMock = vi.fn(async () => {
      callNum += 1;
      if (callNum === 1) return jsonOnce({ code: 10004, message: 'expired', data: null }, 401);
      return jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    const first = await rotateRefreshToken();
    expect(first).toBe('invalid');

    // 等 Promise.finally 的 next tick 让 inFlight 清理完成
    await Promise.resolve();
    const second = await rotateRefreshToken();
    expect(second).toBe('rotated');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('代数交错：在途 refresh 期间 clearSession → 写入被丢弃（防幽灵会话）', async () => {
    installUniStub();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const fetchMock = vi.fn(async (_url: string) => {
      markStarted();
      await gate;
      return jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { saveSession, loadSession, clearSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { rotateRefreshToken } = await import('../src/net/token-refresh');
    const { clientConfig } = await import('../src/config');

    const pending = rotateRefreshToken();
    await started;

    // 用户登出：代数 +1
    clearSession();
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');

    release();
    const result = await pending;

    expect(result).toBe('invalid'); // 代数变了 → 丢弃写入
    expect(clientConfig.token).toBe('');
    expect(loadSession()).toBeNull();
  });
});
