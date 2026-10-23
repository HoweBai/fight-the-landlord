import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('net/rest 的鉴权与轮换（§5.1）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function jsonOnce(body: unknown, status = 200) {
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
  }

  it('authedGet 带 Authorization 头', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonOnce({ code: 0, data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const rest = await import('../src/net/rest');

    await rest.authedGet('/rooms');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/rooms');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('收到 10004 时用 refresh token 换一次新令牌并重放原请求', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization });
      if (url.endsWith('/rooms')) {
        return calls.filter((c) => c.url.endsWith('/rooms')).length === 1
          ? jsonOnce({ code: 10004, message: 'expired', data: null }, 401)
          : jsonOnce({ code: 0, data: [] });
      }
      return jsonOnce({ code: 0, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'u1', phone: '', nickname: '' });

    const rest = await import('../src/net/rest');
    const res = await rest.authedGet('/rooms');

    expect(res.code).toBe(0);
    expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/rooms'))[1]?.auth).toBe('Bearer access-2');
    expect(clientConfig.token).toBe('access-2');
  });

  it('refresh 也失败时不无限重试，把 10004 原样返回', async () => {
    let roomsCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rooms')) { roomsCalls += 1; return jsonOnce({ code: 10004, data: null }, 401); }
      return jsonOnce({ code: 10004, data: null }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    (await import('../src/net/storage')).saveSession({ accessToken: 'access-1', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' });

    const rest = await import('../src/net/rest');
    expect((await rest.authedGet('/rooms')).code).toBe(10004);
    expect(roomsCalls).toBe(1); // 只重放一次
  });

  /**
   * R33：`/api/auth/logout` **不在**公开路径白名单里（只有 login/register/refresh/health），
   * 网关要先验签才把 access 的 jti 通过 `X-Token-Jti` 转给 user-service。
   * 不带令牌的登出会被网关拒成 401，两个 `jti` 一个也删不掉 —— 因此登出必须带令牌。
   */
  it('logout 带 Authorization，且一次成功时不轮换（R33/R35）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonOnce({ code: 0, data: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const rest = await import('../src/net/rest');

    const res = await rest.logout('access-1', 'refresh-1');
    expect(res.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/auth/logout');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'refresh-1' });
  });

  it('没有 refresh token 时登出仍带 access（只能删掉那一个 jti）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonOnce({ code: 0, data: null }));
    vi.stubGlobal('fetch', fetchMock);
    const rest = await import('../src/net/rest');

    await rest.logout('access-1');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  /**
   * R35 闭环：access 已失效（第一次登出 `10004`）→ 用 refresh **换一对新的**
   * （轮换本身就吊销了旧 refresh 的 jti）→ 用新的一对再登出一次 → 新旧 jti 全部失效。
   */
  it('access 失效时「先轮换、再登出」：两次 logout，第二次带新令牌（R35）', async () => {
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    let logoutCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: (init.headers as Record<string, string>)?.Authorization,
        body: init.body as string | undefined,
      });
      if (url.endsWith('/auth/logout')) {
        logoutCalls += 1;
        return logoutCalls === 1
          ? jsonOnce({ code: 10004, message: 'expired', data: null }, 401)
          : jsonOnce({ code: 0, data: null });
      }
      refreshCalls += 1;
      return jsonOnce({ code: 0, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const rest = await import('../src/net/rest');

    const res = await rest.logout('access-1', 'refresh-1');

    expect(res.code).toBe(0);
    expect(refreshCalls).toBe(1);
    const logouts = calls.filter((c) => c.url.endsWith('/auth/logout'));
    expect(logouts).toHaveLength(2);
    expect(logouts[0]!.auth).toBe('Bearer access-1');
    expect(JSON.parse(String(logouts[0]!.body))).toEqual({ refreshToken: 'refresh-1' });
    expect(logouts[1]!.auth).toBe('Bearer access-2');
    expect(JSON.parse(String(logouts[1]!.body))).toEqual({ refreshToken: 'refresh-2' });
  });

  it('refresh 也不可用时降级：logout 与 refresh 各只一次，不循环（R35）', async () => {
    let logoutCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/logout')) { logoutCalls += 1; return jsonOnce({ code: 10004, data: null }, 401); }
      refreshCalls += 1;
      return jsonOnce({ code: 10004, message: 'refresh token is not usable', data: null }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const rest = await import('../src/net/rest');

    const res = await rest.logout('access-1', 'refresh-1');

    expect(res.code).toBe(10004);
    expect(logoutCalls).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  it('并发两次 401 只轮换一次（单飞）', async () => {
    let refreshCalls = 0;
    let roomsCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return jsonOnce({ code: 0, data: { accessToken: `access-${refreshCalls + 1}`, refreshToken: 'r2' } });
      }
      roomsCalls += 1;
      // 前两次拿旧令牌的请求都过期；重放时令牌已换新
      return roomsCalls <= 2 ? jsonOnce({ code: 10004, data: null }, 401) : jsonOnce({ code: 0, data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    (await import('../src/net/storage')).saveSession({ accessToken: 'access-1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const rest = await import('../src/net/rest');
    const [a, b] = await Promise.all([rest.authedGet('/rooms'), rest.authedGet('/rooms')]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(refreshCalls).toBe(1);
  });

  /**
   * Minor #4（task review）：**不得把 HTTP 状态码当业务错误码**（§11.2 的码是 5 位数字）。
   * 拿到的不是平台信封（HTML 错误页 / 空体 / 裸数组）→ `10007`（下游不可用），
   * HTTP 状态只出现在 `message` 里，供排查用。
   */
  it('非平台信封（HTML / 空体 / 裸数组）→ 10007，而不是 code=HTTP 状态码', async () => {
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const rest = await import('../src/net/rest');

    const bodies = ['<html>502 Bad Gateway</html>', '', JSON.stringify([{ code: 'ROOM01' }])];
    for (const body of bodies) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, _init?: RequestInit) => ({
          ok: true,
          status: 200,
          text: async () => body,
        })),
      );

      const res = await rest.authedGet('/rooms');

      expect(res.code, `响应体：${JSON.stringify(body)}`).toBe(10007);
      expect(res.code).not.toBe(200);
      expect(res.message).toContain('200');
    }
  });

  /**
   * 网络不可用（refresh 请求本身传输失败）→ `10007` 而非 `10004`。
   *
   * `rotateRefreshToken()` 的 `unavailable` 五态：refresh 端点不可达（TypeError / 超时 /
   * 非信封）时不判会话死，原请求拿到 `10007`（「续期请求未送达」），而非被错误地
   * 当成「令牌已失效」返回 `10004`。
   */
  it('refresh 传输失败（网络不可用）→ 10007 而非 10004', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rooms')) {
        return jsonOnce({ code: 10004, message: 'expired', data: null }, 401);
      }
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    (await import('../src/net/storage')).saveSession({ accessToken: 'access-1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const rest = await import('../src/net/rest');
    const res = await rest.authedGet('/rooms');

    expect(res.code).toBe(10007);
    expect(res.message).toContain('续期请求未送达');
    expect(res.code).not.toBe(10004);
  });

  /**
   * Important #1（task review）：**交错时序** —— 在途轮换不得复活刚被登出销毁的会话。
   *
   * 时序（刻意**不**顺序 await）：
   *  ① `/rooms` 401 → `rotateOnce()` 发出 `/auth/refresh` 并**挂起**；
   *  ② 用户登出（`auth.signOut()` → `/auth/logout` 成功 → `clearLocalSession()` → `clearSession()`，代数 +1）；
   *  ③ 放行在途轮换 → 它带着**刚被登出删掉**的 `(a2, r2)` 落地 → 必须**丢弃**这次写入。
   *
   * 断言：原请求拿到原来的 `10004`（没重放）、存储里没有令牌、`clientConfig.token` 为空、
   * `hydrate()` 返回 false —— 也就是**幽灵会话不存在**。
   */
  it('在途轮换若在登出之后落地，则丢弃写入（不复活幽灵会话）', async () => {
    const calls: string[] = [];
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/rooms')) {
        return jsonOnce({ code: 10004, message: 'expired', data: null }, 401);
      }
      if (url.endsWith('/auth/refresh')) {
        markRefreshStarted();
        await refreshGate; // 挂起：模拟「轮换在途」
        return jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } });
      }
      return jsonOnce({ code: 0, data: null }); // /auth/logout
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'u1', phone: '', nickname: '' });

    const rest = await import('../src/net/rest');
    const { useAuthStore } = await import('../src/stores/auth');

    const pending = rest.authedGet('/rooms'); // ① 401 → 轮换在途
    await refreshStarted;

    await useAuthStore().signOut(); // ② 登出完成：清空 + 代数 +1
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');

    releaseRefresh(); // ③ 放行在途轮换
    const res = await pending;

    expect(res.code).toBe(10004); // 轮换被丢弃 → 不重放，原样返回
    expect(calls.filter((u) => u.endsWith('/rooms'))).toHaveLength(1);
    expect(clientConfig.token).toBe('');
    expect(loadSession()).toBeNull();
    expect(useAuthStore().hydrate()).toBe(false); // 幽灵会话不存在
  });

  /**
   * 设备绑定片：login / register / refresh（轮换路径）三个公开载荷**恒带同一枚持久
   * deviceId** —— REST 闸与 WS 闸（buildSocketAuth）才能共享同一身份。这里用内存
   * localStorage 钉死「同源 + 持久」：首次读取落键，后续三端点读到同一枚 id。
   */
  it('设备绑定片：login/register/refresh 载荷恒带同一枚持久 deviceId（域内 8..64）', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage);
    // localStorage 是 getDeviceId 的持久面：装进 Map 后，三端点拿到的指纹必须同源持久。
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    let roomsCalls = 0; // GET 无 body，计数器不能挂在 bodies 上（否则首个 /rooms 永远「成功」）
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.body) bodies.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/rooms')) {
        roomsCalls += 1;
        return roomsCalls === 1
          ? jsonOnce({ code: 10004, message: 'expired', data: null }, 401)
          : jsonOnce({ code: 0, data: [] });
      }
      return jsonOnce({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } });
    }));

    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const storage = await import('../src/net/storage');
    storage.saveSession({ accessToken: 'access-1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const rest = await import('../src/net/rest');

    await rest.login('13800000001', 'pw');
    await rest.register('13800000002', 'pw', '阿豆');
    await rest.authedGet('/rooms'); // 10004 → rotateOnce() 发 refresh

    const authCalls = bodies.filter((b) =>
      ['/auth/login', '/auth/register', '/auth/refresh'].some((suffix) => b.url.endsWith(suffix)),
    );
    expect(authCalls.map((b) => b.url.replace(/.*\/auth/, '/auth'))).toEqual([
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
    ]);

    const expectedId = storage.getDeviceId();
    for (const { url, body } of authCalls) {
      expect(body.deviceId, url).toBe(expectedId); // 三端点同一枚持久指纹
      expect(body.deviceId as string, url).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    }
    // login/register 的业务字段仍在（deviceId 是追加，不改既有载荷）
    expect(authCalls[0]!.body).toMatchObject({ phone: '13800000001', password: 'pw' });
    expect(authCalls[1]!.body).toMatchObject({ phone: '13800000002', password: 'pw' });
    expect(authCalls[2]!.body.refreshToken).toBe('r1');

    vi.unstubAllGlobals();
  });
});

/**
 * P1-8：REST 轮换成功后 **auth store 必须同步**。
 *
 * 断点：`authedRequest` 的 10004 恢复走 `rotateRefreshToken()`（只写 storage +
 * clientConfig），而 `signOut()` 读的是 store 字段里的 refresh token ⇒ 轮换后登出仍拿
 * **已作废的旧 token**，服务端吊销（删两个 jti）不可达。
 */
describe('P1-8：轮换后 store 同步与登出吊销', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function jsonOnce(body: unknown, status = 200) {
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
  }

  it('REST 轮换后 signOut 携带新 refresh token（服务端吊销路径可达）', async () => {
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const { installUniStub } = await import('./helpers/uni-stub');
    installUniStub();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/rooms')) {
        const roomsCalls = calls.filter((c) => c.url.endsWith('/rooms')).length;
        return roomsCalls === 1
          ? jsonOnce({ code: 10004, message: 'expired', data: null }, 401)
          : jsonOnce({ code: 0, data: [] });
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonOnce({ code: 0, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
      }
      return jsonOnce({ code: 0, data: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    (await import('../src/net/storage')).saveSession({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      userId: 'u1',
      phone: '',
      nickname: '',
    });

    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    auth.hydrate();
    expect(auth.refreshToken).toBe('refresh-1');

    const rest = await import('../src/net/rest');
    expect((await rest.authedGet('/rooms')).code).toBe(0);
    // 轮换写的是 storage；store 必须同步拿到新值（否则下面登出用旧的）。
    expect(auth.accessToken).toBe('access-2');
    expect(auth.refreshToken).toBe('refresh-2');

    await auth.signOut();

    const logout = calls.find((c) => c.url.endsWith('/auth/logout'));
    expect(logout, 'signOut 必须真的打服务端登出').toBeDefined();
    expect(JSON.parse(String(logout!.init.body))).toEqual({ refreshToken: 'refresh-2' });
    expect((logout!.init.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
  });
});
