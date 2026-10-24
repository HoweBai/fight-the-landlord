/**
 * `net/storage`（令牌持久化）——Task 3 后的**可观察行为**判据。
 *
 * 旧版断言直接盯着 `localStorage`（`saveSession` 之后 `localStorage.getItem(...)`），
 * 那是**实现细节**：Task 3 把宿主换成 uni 的三端存储 API 之后，盯着 localStorage 的断言
 * 要么找不到落点、要么只验证了 H5 后端（而小程序端根本没有 localStorage）。
 * 这里改为断言**往返**（保存 → 读取 → 清除），再加上两条「uni 语义」的忠实度判据。
 *
 * ⚠️ 每条用例都在证明「改完还是同一件事」：保存能读回、清除后读不到、清空后代数递增、
 * 宿主不可用时不抛异常。判据没有放宽，只是不再绑定某一种后端。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createUniStub, installUniStub } from './helpers/uni-stub';

/** 内存版 localStorage：真宿主在单测里是 jsdom 的 localStorage，这里换掉以便逐条断言。 */
function memoryLocalStorage(): { backend: Storage; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as unknown as Storage;
  return { backend, store };
}

describe('net/storage（令牌持久化，经 uni 存储 API）', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    const mem = memoryLocalStorage();
    store = mem.store;
    vi.stubGlobal('localStorage', mem.backend);
    // 每个用例都重装：清空调用流水，且保证看到的是**这一次**的替身实例
    installUniStub();
  });

  it('save → load 往返一致（含 phone/nickname）；clear 之后读不到（同一件事）', async () => {
    const { saveSession, loadSession, clearSession, STORAGE_KEYS } = await import('../src/net/storage');
    saveSession({
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'u1',
      phone: '13800000000',
      nickname: '阿豆',
    });
    /**
     * ⚠️ **整对象 `toEqual`，不是 `toMatchObject`**：放宽成后者会让「漏存一项」恒绿 ——
     * 而「漏存一项」在真机上的形态是「刷新页面后名字丢了一半」。
     */
    expect(loadSession()).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'u1',
      phone: '13800000000',
      nickname: '阿豆',
    });
    clearSession();
    expect(loadSession()).toBeNull();
    /**
     * 两项新键也必须**真被清掉**：只断言 `loadSession() === null` 抓不到
     * 「`clearSession` 漏删 `ftl.phone`」—— 空值判定只看 accessToken/userId，
     * 漏删的那一项会留在存储里，下一次「登出 → 换个人登录」被 `hydrate()` 带回来。
     */
    expect(store.get(STORAGE_KEYS.phone)).toBeUndefined();
    expect(store.get(STORAGE_KEYS.nickname)).toBeUndefined();
  });

  it('写入落到 uni 存储 API（而不是绕过它直连 localStorage）', async () => {
    const { saveSession, STORAGE_KEYS } = await import('../src/net/storage');
    saveSession({
      accessToken: 'jwt-1',
      refreshToken: 'r-1',
      userId: 'u-1',
      phone: '13800000000',
      nickname: '阿豆',
    });
    // 五个键都在：键名是既有语义（既有测试/其它模块按 STORAGE_KEYS 引用）
    expect(store.get(STORAGE_KEYS.access)).toBe('jwt-1');
    expect(store.get(STORAGE_KEYS.refresh)).toBe('r-1');
    expect(store.get(STORAGE_KEYS.userId)).toBe('u-1');
    expect(store.get(STORAGE_KEYS.phone)).toBe('13800000000');
    expect(store.get(STORAGE_KEYS.nickname)).toBe('阿豆');
    // 令牌是**字符串** ⇒ uni 原样存取（不包 { type, data }）；
    // 反证：非字符串写入才会被包成 JSON —— 落库形状一眼能看出我们写的是字符串
    createUniStub().setStorageSync('非字符串', 1);
    expect(store.get('非字符串')).toBe('{"type":"number","data":1}');
  });

  it('缺 userId 或 accessToken 时 loadSession 返回 null（半截会话不算会话）', async () => {
    const { saveSession, loadSession, STORAGE_KEYS } = await import('../src/net/storage');
    saveSession({ accessToken: '', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' });
    expect(loadSession()).toBeNull();
    store.set(STORAGE_KEYS.access, 'a');
    store.delete(STORAGE_KEYS.userId);
    expect(loadSession()).toBeNull();
  });

  /**
   * Task 2R：`phone` / `nickname` 是**后加的**两项 —— 老会话（Task 2R 之前存下的）里没有它们。
   * 它们**不参与**空值判定：「老会话缺两项」不是「未登录」，否则所有老用户升级后被登出。
   * 读成 `''` ⇒ `displayName` 回落到 `userId`（真兜底），名字退一步、会话不丢。
   */
  it('老会话（只有三个旧键）仍算已登录：新两项不参与空值判定，读成 `\'\'`', async () => {
    const { loadSession, STORAGE_KEYS } = await import('../src/net/storage');
    // 直接写三个旧键，模拟 Task 2R 之前存下的会话（绝不经过 saveSession）
    store.set(STORAGE_KEYS.access, 'a');
    store.set(STORAGE_KEYS.refresh, 'r');
    store.set(STORAGE_KEYS.userId, 'u1');

    expect(loadSession()).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'u1',
      phone: '',
      nickname: '',
    });
  });

  it('clearSession 使会话代数递增（既有语义：交错时序保护）', async () => {
    const { clearSession, sessionGeneration } = await import('../src/net/storage');
    const before = sessionGeneration();
    clearSession();
    clearSession();
    expect(sessionGeneration()).toBe(before + 2);
  });

  it('宿主没有 uni（受限宿主/SSR）时不抛异常，且读到 null', async () => {
    // 拆掉替身：模拟「没有 uni」的宿主（旧版这里拆的是 localStorage）
    vi.stubGlobal('uni', undefined);
    const { saveSession, loadSession } = await import('../src/net/storage');
    expect(() =>
      saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' }),
    ).not.toThrow();
    expect(loadSession()).toBeNull();
  });

  it('uni 在但存储后端不可用（隐私模式/配额）时不抛异常，且读到 null', async () => {
    // 替身仍在，但后端被拿掉：真 uni 的 setStorageSync 会抛（它不 catch），必须由我们兜住
    vi.stubGlobal('localStorage', undefined);
    installUniStub();
    const { saveSession, loadSession } = await import('../src/net/storage');
    expect(() =>
      saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' }),
    ).not.toThrow();
    expect(loadSession()).toBeNull();
  });
});

/**
 * 风控 T8（规格 §2.11 / ⚙️16 / F12）：设备指纹 `deviceId`。
 *
 * 语义与「会话」**相反**：它跨登出/换号持久（登出要清的是**会话**，不是**设备**）。
 * 一旦被误加进 `clearSession` 的删除清单，同一台设备的指纹会在每次登出后重置 ——
 * 那正是 F12 点名的退化，下面的关键负对照就钉它。
 */
describe('net/storage · deviceId（风控 T8：设备指纹，跨登出持久）', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    const mem = memoryLocalStorage();
    store = mem.store;
    vi.stubGlobal('localStorage', mem.backend);
    installUniStub();
  });

  /** 协议侧对 `deviceId` 的硬约束（`packages/protocol` 的 room.match 校验）：8..64、`[A-Za-z0-9._-]`。生成值必须落在域内 —— 出域会让 room.match 直接 400。 */
  const DEVICE_ID_SHAPE = /^[A-Za-z0-9._-]{8,64}$/;

  it('首读生成并写入存储：形状合法（协议域内）', async () => {
    const { getDeviceId, STORAGE_KEYS } = await import('../src/net/storage');
    const id = getDeviceId();
    expect(id).toMatch(DEVICE_ID_SHAPE);
    expect(store.get(STORAGE_KEYS.DEVICE_ID), '生成值必须写回持久化').toBe(id);
  });

  it('二读同值：已有值原样返回（不重生成）', async () => {
    const { getDeviceId, STORAGE_KEYS } = await import('../src/net/storage');
    const first = getDeviceId();
    expect(getDeviceId()).toBe(first);
    // 判别力加强：预置一个**人造值** ⇒ 必须原样读回它（证明命中存储，
    // 而不是「两次随机恰好相等」这种不可能但也不该靠巧合成立的形态）
    store.set(STORAGE_KEYS.DEVICE_ID, 'dev-known-0001');
    expect(getDeviceId()).toBe('dev-known-0001');
  });

  it('🔴 关键负对照（F12）：clearSession 之后 deviceId 仍在', async () => {
    const { getDeviceId, saveSession, loadSession, clearSession, STORAGE_KEYS } =
      await import('../src/net/storage');
    const id = getDeviceId();
    saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' });
    clearSession();
    // 正对照：会话确实被清了（证明 clearSession 真跑过，而不是空转 ⇒ 本用例不是恒绿）
    expect(loadSession()).toBeNull();
    // 负对照的本体：deviceId 不得随会话一起被清（登出清会话、不清设备）
    expect(store.get(STORAGE_KEYS.DEVICE_ID), 'deviceId 不得进 clearSession 的删除清单').toBe(id);
    expect(getDeviceId(), '登出后再读必须还是同一台设备').toBe(id);
  });

  it('宿主有 crypto.randomUUID ⇒ 优先用它（⚙️16 的首选路径）', async () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
    try {
      const { getDeviceId } = await import('../src/net/storage');
      expect(getDeviceId()).toBe('123e4567-e89b-12d3-a456-426614174000');
    } finally {
      vi.stubGlobal('crypto', original);
    }
  });

  it('crypto.randomUUID 缺失 ⇒ 回落 dev-<base36>（仍在协议域内）', async () => {
    const original = globalThis.crypto;
    // 无 randomUUID 的宿主（非安全上下文等）—— `{}` 保证走的是回落分支
    vi.stubGlobal('crypto', {});
    try {
      const { getDeviceId, STORAGE_KEYS } = await import('../src/net/storage');
      const id = getDeviceId();
      expect(id).toMatch(/^dev-[0-9a-z-]+$/);
      expect(id).toMatch(DEVICE_ID_SHAPE);
      expect(store.get(STORAGE_KEYS.DEVICE_ID)).toBe(id);
    } finally {
      vi.stubGlobal('crypto', original);
    }
  });

  it('宿主没有 uni 时不抛异常，且仍返回域内 id（空串会被 room.match 校验拒收）', async () => {
    vi.stubGlobal('uni', undefined);
    const { getDeviceId } = await import('../src/net/storage');
    expect(() => getDeviceId()).not.toThrow();
    expect(getDeviceId()).toMatch(DEVICE_ID_SHAPE);
  });

  /**
   * 波 3 评审 F4：读取路径无域校验 —— 存量值（篡改/版本漂移）原样上行 ⇒ room.match
   * **每次 400 且无自愈**。修：读回值必须与 protocol 同域；不合法 ⇒ 当空处理（重生成 + 重写）。
   */
  it.each([
    ['含空格', 'has space 1234567'],
    ['含中文', '设备中文-12345678'],
    ['超长（65 位）', 'x'.repeat(65)],
  ])('F4 域外存量（%s）⇒ 当空处理：重生成、新值域内、且已重写回存储（自愈）', async (_name, garbage) => {
    const { getDeviceId, STORAGE_KEYS } = await import('../src/net/storage');
    store.set(STORAGE_KEYS.DEVICE_ID, garbage);
    const id = getDeviceId();
    expect(id).toMatch(DEVICE_ID_SHAPE);
    expect(id).not.toBe(garbage);
    expect(store.get(STORAGE_KEYS.DEVICE_ID), '重生成后必须重写（下一次读取即命中）').toBe(id);
  });

  /**
   * 波 3 评审 F3：生成路径不回读 —— 同浏览器两冷标签并发首撮合可各返回一枚新 id
   * 并各自随行（同设备一瞬两枚指纹）。修：`setStorageSync` 之后**回读存储现值再返回**
   * （同 tick 收敛到后写值）。
   *
   * 替身形态：对 DEVICE_ID 的 `set` 实际落下的是「另一标签」的值 —— 等价于「我们写入后
   * 外部立刻又写了一次」在回读时刻的**可观察状态**：当前存储值 = external。
   * 不回读的实现返回的会是它自己新生成的那枚 ⇒ 当场红。
   */
  it('F3 写后回读：写入后外部（另一标签）改写了现值 ⇒ 返回回读到的现值', async () => {
    const { getDeviceId, STORAGE_KEYS } = await import('../src/net/storage');
    const external = 'dev-other-tab-0001';
    const mem = memoryLocalStorage();
    const rawSet = mem.backend.setItem.bind(mem.backend);
    mem.backend.setItem = (k: string, v: string) =>
      rawSet(k, k === STORAGE_KEYS.DEVICE_ID ? external : v);
    vi.stubGlobal('localStorage', mem.backend);

    expect(getDeviceId()).toBe(external);
  });
});

/**
 * 替身自身的忠实度：这两条**不是**在生产代码上做断言，而是钉死「替身没有比真实 uni 宽松」。
 * 没有它们，`net/storage` 的往返用例可能只是因为替身写错了才通过（静默假绿）。
 */
describe('uni 存储替身的忠实度（对照 @dcloudio/uni-h5 的实现）', () => {
  beforeEach(() => {
    const mem = memoryLocalStorage();
    vi.stubGlobal('localStorage', mem.backend);
    installUniStub();
  });

  it('getStorageSync 未命中返回 `\'\'`（不是 undefined / null）', () => {
    const uni = createUniStub();
    expect(uni.getStorageSync('nope')).toBe('');
  });

  it('写入非字符串能原样取回（真 uni 内部 JSON 序列化 { type, data }）', () => {
    const uni = createUniStub();
    uni.setStorageSync('obj', { a: 1 });
    uni.setStorageSync('num', 7);
    uni.setStorageSync('flag', false);
    expect(uni.getStorageSync('obj')).toEqual({ a: 1 });
    expect(uni.getStorageSync('num')).toBe(7);
    expect(uni.getStorageSync('flag')).toBe(false);
  });

  it('removeStorageSync 之后未命中（回到 `\'\'`）', () => {
    const uni = createUniStub();
    uni.setStorageSync('k', 'v');
    uni.removeStorageSync('k');
    expect(uni.getStorageSync('k')).toBe('');
  });

  it('没有存储后端时：setStorageSync 抛（与真 uni 同形），getStorageSync 仍返回 `\'\'`', () => {
    vi.stubGlobal('localStorage', undefined);
    const uni = createUniStub();
    expect(() => uni.setStorageSync('k', 'v')).toThrow();
    expect(uni.getStorageSync('k')).toBe('');
    expect(() => uni.removeStorageSync('k')).not.toThrow();
  });
});
