import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { FakeSocket } from './helpers/fake-socket';

/**
 * Task 5（提示收敛）：`auth.signIn/signUp/signOut` 的异常必须进 reporter，
 * 玩家面只留中性文案。mock 放在模块级（本文件大量 `vi.resetModules()` + 动态 import，
 * mock 注册表跨 reset 保持）。
 */
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../src/observability/reporter', () => ({ reportError }));

describe('auth store 的持久化与登出（§5.1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    reportError.mockClear();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    vi.resetModules();
  });

  it('hydrate 把存储中的令牌写回 store 与 clientConfig', async () => {
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');

    const auth = useAuthStore();
    auth.hydrate();

    expect(auth.loggedIn).toBe(true);
    expect(auth.userId).toBe('u1');
    expect(auth.page).toBe('lobby');
    expect(clientConfig.token).toBe('a1');
  });

  it('signOut 调服务端登出并清空本地存储与状态', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    const { loadSession } = await import('../src/net/storage');
    const auth = useAuthStore();
    auth.hydrate();

    await auth.signOut();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'), expect.anything());
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');
    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
    expect(auth.error, '登出成功不得残留提示').toBe('');
  });

  /**
   * R35 的降级路径：access 失效后 refresh 也不可用 → **不循环**，只提示 + 清本地。
   * 请求恰好两条：`/auth/logout`（第一次失败）+ `/auth/refresh`（也失败）。
   */
  it('signOut 在 refresh 也不可用时降级：本地清干净 + 提示，不循环', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ code: 10004, message: 'expired', data: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    const auth = useAuthStore();
    auth.hydrate();

    await auth.signOut();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/auth/logout'),
      expect.stringContaining('/auth/refresh'),
    ]);
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');
    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
    // Task 5：技术细节（code=…）不再带给玩家 —— 中性文案；异常进 reporter。
    expect(auth.error).toBe('服务端登出未成功，本地会话已清除');
  });

  /**
   * Task 5：服务端**不可达**（fetch 拒绝）时，原始 `TypeError: Failed to fetch` 不得
   * 出现在玩家面（G2 禁词/技术串口径），本地照样清干净，异常进 reporter。
   */
  it('signOut 服务端不可达 ⇒ 中性文案 + reporter，本地仍清干净', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    auth.hydrate();

    await auth.signOut();

    expect(auth.error).toBe('服务端登出失败，本地会话已清除');
    expect(auth.error).not.toContain('Failed to fetch');
    expect(reportError).toHaveBeenCalledWith('auth.signOut', expect.any(TypeError));
    expect(loadSession()).toBeNull();
    expect(auth.page).toBe('login');
  });

  /**
   * R34：登录失败的处置也必须来自 `CLIENT_ACTION` 表。
   * `10005`（签名无效）→ `BACK_TO_LOBBY` → 清本地会话回登录页，**且不调服务端登出**。
   */
  it('signIn 收到 10005（BACK_TO_LOBBY）→ 清本地会话回登录页，不调服务端登出', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ code: 10005, message: '签名无效', data: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    const auth = useAuthStore();
    auth.hydrate();

    expect(await auth.signIn('13800000000', 'pw')).toBe(false);

    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只有 /auth/login，没有 /auth/logout
    expect(fetchMock.mock.calls[0]![0]).toContain('/auth/login');
  });

  /** R34：`TOAST` 的码只提示，**不**动会话。 */
  it('signIn 收到 11002（TOAST）→ 只提示，会话不受影响', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code: 11002, message: '密码错误', data: null }),
      })),
    );
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    auth.hydrate();

    expect(await auth.signIn('13800000000', 'wrong')).toBe(false);

    expect(auth.error).toBe('密码错误');
    expect(loadSession()).not.toBeNull();
  });

  /**
   * Task 5：登录/注册的 catch 不再把原始 `error.message`（`Failed to fetch` 等技术串）
   * 直接给玩家 —— 中性文案兜底 + 异常进 reporter（设计 §4.5 / G2）。
   */
  it('signIn 网络异常 ⇒ 中性文案 + reporter（不暴露原始 error.message）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const { useAuthStore } = await import('../src/stores/auth');

    const auth = useAuthStore();
    expect(await auth.signIn('13800000000', 'pw')).toBe(false);

    expect(auth.error).toBe('登录失败，请稍后重试');
    expect(auth.error).not.toContain('Failed to fetch');
    expect(reportError).toHaveBeenCalledWith('auth.signIn', expect.any(TypeError));
  });

  it('signUp 网络异常 ⇒ 中性文案 + reporter（不暴露原始 error.message）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const { useAuthStore } = await import('../src/stores/auth');

    const auth = useAuthStore();
    expect(await auth.signUp('13800000000', 'pw', '阿豆')).toBe(false);

    expect(auth.error).toBe('注册失败，请稍后重试');
    expect(auth.error).not.toContain('Failed to fetch');
    expect(reportError).toHaveBeenCalledWith('auth.signUp', expect.any(TypeError));
  });

  /**
   * Task 5 Interfaces：`clearLocalSession(message?)` / `sessionEnded(message)`。
   *
   * `message === undefined` **保留**既有 `auth.error`（11003 的 K1 文案先写再清本地，
   * 不能被清掉）；传入原因时才覆盖。`sessionEnded` = 带原因的本地清场。
   */
  it('clearLocalSession(message?) 仅在传入原因时写 error；sessionEnded 带原因清场', async () => {
    const { saveSession, loadSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    auth.hydrate();

    auth.error = '该账号已被封禁，如有异议请联系客服';
    auth.clearLocalSession();
    expect(auth.error, '无参调用不得清掉既有的 11003 K1 文案').toBe(
      '该账号已被封禁，如有异议请联系客服',
    );

    auth.error = '旧原因';
    auth.sessionEnded('登录状态已失效，请重新登录');
    expect(auth.error).toBe('登录状态已失效，请重新登录');
    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
    expect(loadSession()).toBeNull();
  });

  /**
   * R36：`BACK_TO_LOBBY` 必须连本地 WS 会话一起销毁（登录路径这条也走同一个钩子）。
   *
   * `net/rest.ts` 的 `logout` 与 `stores/auth.ts` 不直接 import `useGameSession`（会循环依赖），
   * 而是由 `startGameSession()` 通过 `bindAuthRuntime()` 把 `stopGameSession` 绑进来 ——
   * 本用例同时钉住这条绑定真的接上了。
   */
  it('signIn 收到 10005 → 本地 WS 会话也被销毁（R36 的绑定钩子）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code: 10005, message: '签名无效', data: null }),
      })),
    );
    const socket = new FakeSocket();
    const session = await import('../src/composables/useGameSession');
    session.startGameSession(() => socket);
    expect(session.isGameSessionReady()).toBe(true);
    expect(socket.connected).toBe(true);

    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    auth.hydrate();

    expect(await auth.signIn('13800000000', 'pw')).toBe(false);

    expect(socket.disconnected).toBe(true);
    expect(session.isGameSessionReady()).toBe(false);
    expect(auth.page).toBe('login');
  });
});

/**
 * F1（评审 Important）：服务端 `message` **为空**时必须落到本地人话文案。
 *
 * `net/errors.ts` 对这个字段的契约原话是「`report.message` 是服务端的人类可读说明，
 * **可能为空**」——它被原样透传（`classifyAck` → `dispatchRestFailure` → `toast` 回调）。
 * 若实现写 `message ?? authErrorMessage(...)`，一个**空字符串**会短路掉整条降级链
 * （本地文案表 + 带码兜底双双被绕过），`this.error = ''` 让登录页 `auth` 提示项不渲染
 * ⇒ 登录失败**完全无提示**，正是 R651 要防的「静默吞掉」。⇒ 必须用 `||`。
 *
 * 两条断言成对：正对照（非空 message 原样优先）+ 空值与缺省（都落到本地文案）。
 * **既有断言一条未改**（上面 `auth.error === '密码错误'` 仍逐字保留）。
 */
describe('➊ F1：服务端 message 为空 ⇒ 回落本地人话文案（R651 的降级链）', () => {
  /**
   * 本 describe 是**顶层**的，必须自带脚手架：不能依赖文件里前一个 describe 的
   * `beforeEach` 在同一进程顺序执行时留下的 active pinia —— `-t` 过滤单跑时
   * 整组会以「no active Pinia」失败。`afterEach` 收掉 `stubGlobal('fetch', …)`
   * 的全局泄漏（`vitest.config.ts` 只开了 `restoreMocks`，它不管 `stubGlobal`）。
   */
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 造一个「服务端返回该码/该 message」的 REST 失败响应。 */
  function stubAuthFailure(code: number, message: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code, message, data: null }),
      })),
    );
  }

  it('正对照：message 非空（「密码错误」）⇒ 仍原样用服务端文案', async () => {
    stubAuthFailure(11002, '密码错误');
    const { useAuthStore } = await import('../src/stores/auth');
    const { authErrorMessage } = await import('../src/net/copy');

    const auth = useAuthStore();
    expect(await auth.signIn('13800000000', 'wrong')).toBe(false);

    expect(auth.error).toBe('密码错误');
    expect(auth.error, '非空 message 不得被本地文案表顶掉').not.toBe(
      authErrorMessage(11002, '登录'),
    );
  });

  it('message 为空字符串 ⇒ 落到本地人话文案（不得静默成空提示）', async () => {
    stubAuthFailure(11002, '');
    const { useAuthStore } = await import('../src/stores/auth');
    const { authErrorMessage } = await import('../src/net/copy');

    const auth = useAuthStore();
    expect(await auth.signIn('13800000000', 'wrong')).toBe(false);

    expect(auth.error).toBe(authErrorMessage(11002, '登录'));
    expect(auth.error, '空 message 必须回落，否则登录页无提示').not.toBe('');
  });

  it('message 缺省 ⇒ 同一条降级链（本地文案表优先于带码兜底）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code: 11002, data: null }),
      })),
    );
    const { useAuthStore } = await import('../src/stores/auth');
    const { authErrorMessage } = await import('../src/net/copy');

    const auth = useAuthStore();
    expect(await auth.signIn('13800000000', 'wrong')).toBe(false);

    expect(auth.error).toBe(authErrorMessage(11002, '登录'));
  });

  it('未登记的码 + message 为空 ⇒ 中性兜底（未知码不再带码给玩家）', async () => {
    stubAuthFailure(99999, '');
    const { useAuthStore } = await import('../src/stores/auth');
    const { authErrorMessage } = await import('../src/net/copy');

    const auth = useAuthStore();
    expect(await auth.signIn('13800000000', 'wrong')).toBe(false);

    expect(auth.error).toBe('操作未成功，请稍后重试');
    expect(auth.error).toBe(authErrorMessage(99999, '登录'));
  });
});

// ---------------------------------------------------------------------------
// renewHydratedSession 五态（冷启动 / 回前台调用）
// ---------------------------------------------------------------------------

describe('auth store renewHydratedSession 五态', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无 accessToken（dev mock / 冷启动失败路径）→ false', async () => {
    const { useAuthStore } = await import('../src/stores/auth');
    const auth = useAuthStore();
    expect(auth.accessToken).toBe('');
    expect(await auth.renewHydratedSession()).toBe(false);
  });

  it('fresh（本地 JWT exp 未过期）→ true，零网络请求', async () => {
    const { saveSession } = await import('../src/net/storage');
    // 造一个 1 小时后过期的合法 JWT（exp 大）
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'u1' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    saveSession({ accessToken: jwt, refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    clientConfig.token = jwt;

    const auth = useAuthStore();
    auth.hydrate();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.renewHydratedSession()).toBe(true);
    expect(fetchMock, 'fresh 态不发请求').not.toHaveBeenCalled();
  });

  it('rotated（refresh 成功）→ 回填 store → true', async () => {
    const { saveSession } = await import('../src/net/storage');
    const exp = Math.floor(Date.now() / 1000) - 10; // 已过期
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'u1' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    saveSession({ accessToken: jwt, refreshToken: 'r1', userId: 'u1', phone: '138', nickname: 'n' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    clientConfig.token = jwt;

    const auth = useAuthStore();
    auth.hydrate();

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.renewHydratedSession()).toBe(true);
    expect(auth.accessToken, 'rotated 后 store 已回填').toBe('a2');
    expect(auth.refreshToken).toBe('r2');
    expect(clientConfig.token).toBe('a2');
  });

  it('invalid（refresh 被确定性拒绝 10004）→ 清本地会话 → false', async () => {
    const { saveSession, loadSession } = await import('../src/net/storage');
    const exp = Math.floor(Date.now() / 1000) - 10;
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'u1' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    saveSession({ accessToken: jwt, refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    clientConfig.token = jwt;

    const auth = useAuthStore();
    auth.hydrate();

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ code: 10004, message: 'refresh expired', data: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.renewHydratedSession()).toBe(false);
    expect(loadSession(), 'invalid 态本地会话已清').toBeNull();
    expect(clientConfig.token).toBe('');
    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
    // Task 5：冷启动/回前台的确定性失效必须留下原因（登录页 watch 显示为 auth 提示项）。
    expect(auth.error).toBe('登录状态已失效，请重新登录');
  });

  it('unavailable（网络错误）→ false，不清本地会话', async () => {
    const { saveSession, loadSession } = await import('../src/net/storage');
    const exp = Math.floor(Date.now() / 1000) - 10;
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'u1' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    saveSession({ accessToken: jwt, refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    clientConfig.token = jwt;

    const auth = useAuthStore();
    auth.hydrate();

    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.renewHydratedSession()).toBe(false);
    expect(loadSession(), 'unavailable 态本地会话保留').not.toBeNull();
    expect(clientConfig.token, 'unavailable 态 token 保留').not.toBe('');
    expect(auth.loggedIn, 'unavailable 态 loggedIn 保留').toBe(true);
  });
});
