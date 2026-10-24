/**
 * 本地会话持久化。
 *
 * 只在**本地**保存渲染/连接所需的东西：令牌三项 + 展示用的 `phone` / `nickname` 两项
 * （Task 2R：它们来自登录响应，与令牌一起落盘 ⇒ 刷新页面后顶栏的名字不丢）；不存任何对局状态（F03）。
 * 风控 T8 起还有一项**不属于会话**的持久数据：设备指纹 `deviceId`（`ftl.deviceId`）——
 * 它跨登出/换号持久，`clearSession` 不得删（F12），语义见 `getDeviceId()`。
 *
 * 切片 P10 Task 3：宿主存储从浏览器的 `localStorage` 换成 uni-app 的三端存储 API
 * （`uni.getStorageSync` / `uni.setStorageSync` / `uni.removeStorageSync`）。
 * 之所以必须换：小程序端没有 `localStorage`（只有 `wx.setStorageSync`），
 * 而 H5 端 uni 的实现本身就是 localStorage 的薄封装，因此换掉之后 H5 行为不变。
 *
 * ⚠️ 与 `localStorage` 的**语义差别**（按 `@dcloudio/uni-h5` 的实现逐条核实，
 * 测试替身 `test/helpers/uni-stub.ts` 与它同形）：
 *  - `getStorageSync` **未命中返回 `''`**，不是 `null` / `undefined`
 *    ⇒ 本文件的空值判定必须用 `!== ''`（旧代码里的 `?? ''` 在这里没有意义）；
 *  - `setStorageSync` 写**非字符串**时会 JSON 包一层 `{ type, data }`，`getStorageSync`
 *    会解回来（会话三项都是字符串，落到「原样存取」这一支）；
 *  - 配额/隐私模式下 `setStorageSync` 会**抛错**（uni 不 catch）⇒ 调用方必须自己兜住。
 *
 * 宿主没有 `uni`（纯 node / SSR / 单测忘了装替身）时，三个操作全部降级为
 * 「不持久化」，与迁移前 `localStorage` 缺失时的行为一致（不抛异常）。
 *
 * ⚠️ **调用点必须写成 `uni.xxx(...)` 的直接成员表达式**（不要 `const api = uni`）：
 * H5 发行构建靠 uni 编译器把这种直接调用改写成 `@dcloudio/uni-h5` 的 import，
 * 详见 `hasUni()` 的注释 —— 这是本片实测到的一个「dev 正常、发行版静默失效」的坑。
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  /**
   * 展示用的资料（Task 2R）：来源是登录/注册响应里的 `user.phone` / `user.nickname`。
   *
   * ⚠️ 两项都是**字符串**（缺省 `''`），**不是可选** —— 可选会让每个消费点多一个
   * `undefined` 分支（`displayName` 的回落链已经够长了）。
   * ⚠️ 它们**不参与** `loadSession()` 的空值判定：老会话里没有这两项（读成 `''`），
   * 不得因此被判成「未登录」——否则所有老用户升级后被登出。
   */
  phone: string;
  nickname: string;
}

const KEYS = {
  access: 'ftl.accessToken',
  refresh: 'ftl.refreshToken',
  userId: 'ftl.userId',
  phone: 'ftl.phone',
  nickname: 'ftl.nickname',
  /**
   * 风控 T8（规格 §2.11）：设备指纹。**不是会话** —— 见 `getDeviceId()` 的注释：
   * 它跨登出/换号持久，`clearSession` **不得**删它（F12）。
   */
  DEVICE_ID: 'ftl.deviceId',
  /**
   * 记牌器收费片：**待确认购买**（userId + requestId + 价格 + 时间戳）。
   * 购买响应丢失/未知态时保留，重挂载后复用同 requestId 重试（端点幂等优先）；
   * `clearSession`（登出/换号）必须清除（F12 的反面：这是**会话身份相关**的数据）。
   */
  PENDING_CARD_COUNTER: 'ftl.cardCounter.pendingPurchase',
} as const;

/**
 * 宿主是否提供 `uni` 全局。
 *
 * ⚠️ **这里只做「存在性」判定，绝不把 `uni` 读进变量再调用**（这一条是实测坑，别改回去）：
 * H5 的**发行构建**默认开启摇树，`@dcloudio/uni-h5-vite` 在这种模式下只往页面注入一个
 * **空的占位对象**（`window.uni = {}`，见 `uni-h5-vite/dist/plugins/pagesJson.js` 的
 * `registerGlobalCode`），真正可用的是它同时启用的 `uni:h5-inject` ——
 * 把源码里 `uni.xxx(...)` 的**直接调用**改写成 `@dcloudio/uni-h5` 的具名 import
 * （`uni-h5-vite/dist/plugins/inject.js`）。一旦写成 `const api = uni; api.xxx()`，
 * 改写就扫不到 ⇒ **发行版上 API 全是 undefined，而 dev 上一切正常**（dev 注入的是真对象）。
 * 所以每次调用都写成直接的成员表达式，存在性判定单独用一个 `typeof uni` 表达式。
 */
function hasUni(): boolean {
  return typeof uni !== 'undefined';
}

/**
 * 把 `getStorageSync` 的返回值归一成字符串。
 *
 * **`''` 才是「没有值」**：uni 未命中时返回 `''`；万一宿主返回了别的类型
 * （非字符串我们没写过），也一并按「没有值」处理 —— 令牌只可能是字符串。
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function saveSession(session: StoredSession): void {
  if (!hasUni()) return;
  try {
    uni.setStorageSync(KEYS.access, session.accessToken);
    uni.setStorageSync(KEYS.refresh, session.refreshToken);
    uni.setStorageSync(KEYS.userId, session.userId);
    uni.setStorageSync(KEYS.phone, session.phone);
    uni.setStorageSync(KEYS.nickname, session.nickname);
  } catch {
    // 配额/隐私模式：持久化失败不应让登录失败
  }
}

export function loadSession(): StoredSession | null {
  if (!hasUni()) return null;
  try {
    const accessToken = readString(uni.getStorageSync(KEYS.access));
    const refreshToken = readString(uni.getStorageSync(KEYS.refresh));
    const userId = readString(uni.getStorageSync(KEYS.userId));
    // ⚠️ 空值判定**不变**：仍是「accessToken 与 userId 缺一不可」——
    // 后加的两项（Task 2R）**不参与**：老会话里没有它们（读成 `''`），不该因此被判成未登录。
    if (!accessToken || !userId) return null;
    return {
      accessToken,
      refreshToken,
      userId,
      phone: readString(uni.getStorageSync(KEYS.phone)),
      nickname: readString(uni.getStorageSync(KEYS.nickname)),
    };
  } catch {
    return null;
  }
}

/**
 * 会话代数（epoch）：`clearSession()` 每调用一次就 +1。
 *
 * 用途是**交错时序保护**：一个已经发出的 `/auth/refresh` 轮换请求在等待响应期间，
 * 用户可能已经登出（`clearLocalSession()` → `clearSession()`）。若轮换落地时不检查代数，
 * 它会把**刚刚被登出删掉的那一对令牌**重新写回存储与 `clientConfig`，
 * 制造出一个用已死令牌恢复出来的「幽灵会话」——正是 R35 要关闭的路径。
 *
 * 调用方（`rest.ts` 的 `rotateOnce`）在发起请求前取一次代数、写入前再比对一次：
 * 变了就**丢弃这次写入**。代数只增不减，跨「登录 → 登出 → 再登录」也不会误判。
 *
 * ⚠️ 代数**只在进程内**（不在持久化存储里）：它与「谁先谁后」有关，与宿主存储无关。
 */
let generation = 0;

export function sessionGeneration(): number {
  return generation;
}

export function clearSession(): void {
  generation += 1;
  if (!hasUni()) return;
  try {
    uni.removeStorageSync(KEYS.access);
    uni.removeStorageSync(KEYS.refresh);
    uni.removeStorageSync(KEYS.userId);
    // Task 2R：展示资料也要清 —— 漏掉这两项就是「登出 → 换个人登录」后
    // 顶栏仍显示**上一个人**的名字。
    uni.removeStorageSync(KEYS.phone);
    uni.removeStorageSync(KEYS.nickname);
    // 记牌器收费片：待确认购买是**会话身份相关**的数据 ⇒ 登出/换号清除。
    uni.removeStorageSync(KEYS.PENDING_CARD_COUNTER);
    // 🔴 风控 T8（F12）：`KEYS.DEVICE_ID` **绝不**加进这份删除清单 ——
    // 设备指纹跨登出/换号持久（同上行注释的反面：名字要清，设备不能清）。
  } catch {
    // 忽略
  }
}

/**
 * 生成一枚新的设备指纹。
 *
 * 形态照 `net/socket.ts` 的 `createReqId()`（⚙️16「同款回落」）：优先 `crypto.randomUUID()`；
 * 宿主没有它（非安全上下文等）⇒ 回落 `dev-<base36>`。两条路径的产物都落在协议校验域内
 * （`room.match` 的 deviceId：8..64 位、`[A-Za-z0-9._-]`）——出域会让整条匹配 400，有单测钉。
 */
function newDeviceId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * deviceId 的域校验（与 protocol 对 `room.match` 的校验**同域**：8..64 位、`[A-Za-z0-9._-]`）。
 * protocol 侧这条规则内嵌在 `validateClientMessage` 里、没有独立导出，故此处复制一份 ——
 * 域外的值上行会让 room.match **每次 400 且自身永不自愈**，读取路径必须先过滤（波 3 F4）。
 */
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * 设备指纹（风控 T8；规格 §2.11 / ⚙️16 / F12；波 3 F3/F4）。
 *
 * - 首次读空 ⇒ 生成（`crypto.randomUUID()`，回落 `dev-<base36>`）并**写回持久化**；
 * - 读到的存量值必须**同域**（F4）：域外（篡改/版本漂移）当空处理 ⇒ 重生成 + 重写（自愈）；
 * - 生成路径**写后回读**（F3）：同浏览器两冷标签并发首撮合时，另一标签可能已在本次写入
 *   之后写下它的值 ⇒ 以存储现值为准（同 tick 收敛到后写值；跨标签真正并发窗口为残余，
 *   本机制「尽力而为」）；
 * - 🔴 **不入 `clearSession`**：它是**设备**的属性，不是**会话**的属性 —— 登出/换号后
 *   必须仍是同一枚，否则「同设备多账号」这条风控线索每次登出就归零（F12）。
 *   唯一消费点 = 玩法页 `room.match` 随行（`pages/game/game.vue`）。
 * - 宿主存储不可用（配额/隐私模式 / 无 `uni`）⇒ 不抛，仍返回一枚**域内**的 id：
 *   「读空 ⇒ 生成」的单次语义照旧，只是这次没能持久化（退化为「本机不持久」）。
 */
export function getDeviceId(): string {
  if (!hasUni()) return newDeviceId();
  try {
    const existing = readString(uni.getStorageSync(KEYS.DEVICE_ID));
    if (DEVICE_ID_RE.test(existing)) return existing;
    // 域外存量当空处理（F4）：绝不原样上行 —— 那会让 room.match 每次 400 且无自愈
    const id = newDeviceId();
    uni.setStorageSync(KEYS.DEVICE_ID, id);
    // 写后回读（F3）：另一标签的并发首写若已落地，回读见到的就是它 ⇒ 返回后写值
    const settled = readString(uni.getStorageSync(KEYS.DEVICE_ID));
    return DEVICE_ID_RE.test(settled) ? settled : id;
  } catch {
    // 配额/隐私模式下 setStorageSync 会抛 —— 持久化失败不应阻断匹配（deviceId 是尽力而为的线索）
    return newDeviceId();
  }
}

export const STORAGE_KEYS = KEYS;

/** 记牌器收费片：待确认购买（响应丢失/未知态时保留，重挂载后同 requestId 重试）。 */
export interface PendingCardCounterPurchase {
  userId: string;
  kind: 'game' | 'hour';
  hours?: number;
  /** 单局卡数量（kind==='game' 时有效，缺省 1）。包时卡用 hours 字段。 */
  credits?: number;
  expectedPrice: number;
  requestId: string;
  createdAt: number;
}

/** 24h 过期（超过则视为陈旧意向，不再自动重试）。 */
export const PENDING_CARD_COUNTER_TTL_MS = 24 * 60 * 60 * 1000;

export function savePendingCardCounterPurchase(value: PendingCardCounterPurchase): void {
  if (!hasUni()) return;
  try {
    uni.setStorageSync(KEYS.PENDING_CARD_COUNTER, JSON.stringify(value));
  } catch {
    // 配额/隐私模式：持久化失败只是失去「重挂载自动对账」，不阻断购买。
  }
}

export function loadPendingCardCounterPurchase(): PendingCardCounterPurchase | null {
  if (!hasUni()) return null;
  try {
    const raw = uni.getStorageSync(KEYS.PENDING_CARD_COUNTER);
    if (typeof raw !== 'string' || raw === '') return null;
    const parsed = JSON.parse(raw) as Partial<PendingCardCounterPurchase>;
    if (
      typeof parsed.userId !== 'string' ||
      parsed.userId.length === 0 ||
      (parsed.kind !== 'game' && parsed.kind !== 'hour') ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.expectedPrice !== 'number' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      kind: parsed.kind,
      ...(typeof parsed.hours === 'number' ? { hours: parsed.hours } : {}),
      ...(typeof parsed.credits === 'number' ? { credits: parsed.credits } : {}),
      expectedPrice: parsed.expectedPrice,
      requestId: parsed.requestId,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingCardCounterPurchase(): void {
  if (!hasUni()) return;
  try {
    uni.removeStorageSync(KEYS.PENDING_CARD_COUNTER);
  } catch {
    // 同上：清理失败不阻断。
  }
}
