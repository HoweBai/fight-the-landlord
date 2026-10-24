/**
 * `uni` 全局的**测试替身**（切片 P10 Task 3）。
 *
 * ## 为什么必须有它
 *
 * Task 3 起 `src/**` 不再直接碰浏览器的 `localStorage`，而是走 uni 的三端存储 API
 * （`uni.getStorageSync` / `uni.setStorageSync` / `uni.removeStorageSync`）与页面栈
 * （`uni.reLaunch`）。jsdom 里没有 `uni` 全局 ⇒ 不装替身的话，生产代码会走
 * 「宿主没有存储」的降级分支：**测试比真实实现更宽松**，于是「保存→读取」这类
 * 断言恒真、静默假绿。
 *
 * ## 忠实度：逐条对着 `@dcloudio/uni-h5` 的实现抄
 *
 * 判据不是「测起来方便」，而是「和真实 uni 同形」——真实语义见 `src/net/storage.ts`
 * 顶部注释。这里把两条最容易写错的语义钉死，并各自有用例（`test/storage.test.ts`）：
 *
 *  1. `getStorageSync` **未命中返回 `''`**（不是 `null`/`undefined`）——
 *     真实现里是 `localStorage.getItem` 拿到 `null` → `throw new Error('data not found')`
 *     → `catch` 里 `return ''`；
 *  2. 写入**非字符串**时真实现会存 `JSON.stringify({ type, data })`，读取时再解回来
 *     （`parseValue`）；字符串则原样存取。替身照抄这一对，因此「写对象取回对象」这种
 *     用例在替身上也成立，将来真有人往里写非字符串不会以为「测试通过 = 真机通过」。
 *
 * ⚠️ 替身**只补宿主能力**，不改 `src/**` 的任何行为（不用 `vi.mock`）。
 *
 * 与真实现的**已知差异**（逐条登记，避免把替身当成真机结论）：
 *  - 真 uni 的存储后端在 H5 是 `localStorage`、在小程序是 `wx` 的存储；替身**只有**
 *    localStorage 后端（测试环境没有 `wx`）；
 *  - 真 `reLaunch` 会真的换页；替身只**记账**（页面栈在单测里不存在，换页由真浏览器
 *    探针 `scripts/browser-e2e.mjs` 在 H5 上验证）；
 *  - 真 `uni.request` 是**异步的网络回调**，替身**同步**回调（只影响时序，不影响判定），
 *    且**没配应答就 `fail`**（见 `UniStub#requestResponder`）——真流程里不存在「宿主不回答」
 *    这种形态，默认成功会让「忘了配应答」变成静默假绿。
 */

/** 替身记录下来的调用（用例断言「页面栈被投影到哪一页」用）。 */
export interface UniStubCalls {
  /** `uni.reLaunch({ url })` 的 url 序列。 */
  reLaunch: string[];
  /**
   * `uni.navigateTo({ url })` 的 url 序列。
   *
   * ⚠️ **记录片 T8 起有了正当消费者**（历史战绩子页 —— 设计 D6 裁决的压栈形态）；
   * 「`auth.page` 的投影仍只走 `reLaunch`」这条不变量由 `page-stack.test.ts` 继续守。
   */
  navigateTo: string[];
  /** `uni.navigateBack({ delta })` 的 delta 序列（缺省 1）。 */
  navigateBack: number[];
  /** `uni.showToast({ title, icon })`。 */
  showToast: { title?: string; icon?: string }[];
  /**
   * `uni.showModal(options)` —— **完整**记录 options（含 `success` / `fail` 回调引用）。
   *
   * ⚠️ 替身**不自动回调**（与真 uni 的差异登记）：用例以
   * `uniStub.calls.showModal[0].success?.({ confirm: true/false })` **显式**触发
   * 确认 / 取消两条分支 —— 「用户点了哪颗钮」在用例里是一等公民，
   * 而不是替身替它猜一个默认答案（默认答「确认」会让「取消留守」这类判据恒绿）。
   */
  showModal: UniShowModalOptions[];
  /** `uni.request(options)` 的入参序列（断言 URL / 方法 / 头 / 体）。 */
  request: UniRequestOptions[];
  /**
   * 窗口变化监听的注册 / 注销次数（片① / R721）。
   * ⚠️ 判据是「**成对**」—— 只 on 不 off 就是泄漏（卸载后仍回调）。
   */
  windowResize: { on: number; off: number };
  /**
   * 前后台监听的注册 / 注销次数（项 1）。
   * ⚠️ 同样判「**成对**」：on/off 不相等就是卸载后仍回调的泄漏。
   */
  appVisibility: { onShow: number; onHide: number; offShow: number; offHide: number };
  /** `uni.vibrateShort()` 被调次数（触感层）。 */
  vibrateShort: number;
  /** `uni.vibrateLong()` 被调次数（触感层 heavy 档）。 */
  vibrateLong: number;
}

/**
 * `uni.request` 的入参（只声明本仓用到的部分；形状对照 `@dcloudio/types` 的
 * `UniNamespace.RequestOptions`）。
 */
export interface UniRequestOptions {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: unknown;
  success?: (res: UniRequestResult) => void;
  fail?: (error: { errMsg?: string }) => void;
  complete?: (res: { errMsg?: string }) => void;
}

/**
 * `uni.request` 成功回调的参数（`UniNamespace.RequestSuccessCallbackResult` 的最窄子集）。
 *
 * `data` 的形态由 `dataType` 决定：默认 `json` ⇒ 服务端返回 JSON 时**已经是对象**
 * （uni 自己 parse 过），否则是字符串。替身照抄这一点（见 `request` 的实现）。
 */
export interface UniRequestResult {
  statusCode: number;
  data?: unknown;
  header?: Record<string, string>;
}

/**
 * `uni.showModal` 的入参（本仓用到的**完整**子集：本片起 `success` 是一等公民）。
 *
 * ⚠️ 类型**故意**包含回调引用：记录「弹了没有、弹的是什么」之外，用例还要**驱动**
 * 确认 / 取消分支（见 `UniStubCalls.showModal` 的注释）。形状对照 `@dcloudio/types`
 * 的 `UniNamespace.ShowModalOptions`（`fail` 收窄为无参回调 —— 本仓没人消费失败详情）。
 */
export interface UniShowModalOptions {
  title?: string;
  content?: string;
  confirmText?: string;
  cancelText?: string;
  success?: (res: { confirm: boolean }) => void;
  fail?: () => void;
}

export interface UniStub {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  reLaunch(options: { url: string }): void;
  navigateTo(options: { url: string }): void;
  navigateBack(options?: { delta?: number }): void;
  showToast(options: { title?: string; icon?: string }): void;
  showModal(options: UniShowModalOptions): void;
  getSystemInfoSync(): { uniPlatform: string };
  /**
   * `uni.onWindowResize` / `offWindowResize` 的替身（片① / R721）。
   *
   * ⚠️ **成对**：`LandscapeStage` 在挂载时注册、卸载时注销；替身只记账，
   * 用例可以断言「注册与注销次数相等」（防泄漏）。
   */
  onWindowResize(cb: (res: { size: { windowWidth: number; windowHeight: number } }) => void): void;
  offWindowResize(cb: (res: { size: { windowWidth: number; windowHeight: number } }) => void): void;
  /**
   * `uni.onAppShow` / `onAppHide` / `offAppShow` / `offAppHide` 的替身（项 1）。
   *
   * 回调注册到模块级 Set，用例通过 `triggerAppShow()` / `triggerAppHide()` 模拟
   * 应用回前台 / 切后台（与 `onWindowResize` + `setWindowSize()` 同一范式）。
   */
  onAppShow(cb: () => void): void;
  onAppHide(cb: () => void): void;
  offAppShow(cb: () => void): void;
  offAppHide(cb: () => void): void;
  /** `uni.vibrateShort(options)` 的替身（触感层）：只记账，不真震。 */
  vibrateShort(options?: Record<string, unknown>): void;
  /** `uni.vibrateLong(options)` 的替身（触感层 heavy 档）：只记账。 */
  vibrateLong(options?: Record<string, unknown>): void;
  /**
   * `uni.createInnerAudioContext()` 的替身（U4）。返回的对象**只**实现本仓用到的那几个
   * 成员 —— 少一个都会让生产代码在运行期 `TypeError`（那正是我们要的：替身不撒谎）。
   */
  createInnerAudioContext(): {
    src: string;
    loop: boolean;
    volume: number;
    play(): Promise<void>;
    pause(): void;
    stop(): void;
    destroy(): void;
    onEnded(cb: () => void): void;
    onError(cb: (err: unknown) => void): void;
    onPlay(cb: () => void): void;
    onPause(cb: () => void): void;
  };
  /**
   * `uni.request` 的替身：**只**记录入参、按 `requestResponder` 回调，
   * **不**替 `rest.ts` 做任何信封解析（那是被测代码的事）。
   */
  request(options: UniRequestOptions): void;
  /**
   * 应答配置：`null`（默认）⇒ 立即 `fail` 并说明「用例没有配置应答」。
   *
   * 用例这样用：
   * ```ts
   * const stub = installUniStub({ platform: 'mp-weixin' });
   * stub.requestResponder = () => ({ statusCode: 200, data: { code: 0, data: null } });
   * ```
   */
  requestResponder: ((options: UniRequestOptions) => UniRequestResult) | null;
  /** 调用流水（可读，用于断言）。 */
  readonly calls: UniStubCalls;
  /** 清空调用流水（不动存储后端）。 */
  resetCalls(): void;
}

/**
 * `getStorageOrigin` 里的 `parseValue`（逐字对照 `@dcloudio/uni-h5`）。
 *
 * 它决定了「写进去的非字符串能不能原样取回」：只有形如 `{ type, data }` 且
 * `typeof data === type` 的对象才被解包，其余返回 `undefined`（调用方退回原始字符串）。
 */
function parseValue(value: unknown): unknown {
  const types = ['object', 'string', 'number', 'boolean', 'undefined'];
  try {
    const object = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
    const type = object?.type as string;
    if (types.indexOf(type) >= 0) {
      const keys = Object.keys(object);
      if (keys.length === 2 && 'data' in object) {
        if (typeof object.data === type) return object.data;
        if (
          type === 'object' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(object.data))
        ) {
          return new Date(String(object.data));
        }
      } else if (keys.length === 1) {
        return '';
      }
    }
  } catch {
    // 不是 JSON：交给调用方退回原始字符串（与真实现一致）
  }
  return undefined;
}

/** 真实现的 `getStorageOrigin`：拿到原始字符串 → 尝试解包 → 解不开就原样返回。 */
function getStorageOrigin(key: string): string {
  const backend = (globalThis as { localStorage?: Storage }).localStorage;
  const value = backend?.getItem(key);
  if (typeof value !== 'string') {
    // 真实现这里 `throw new Error('data not found')`，由 getStorageSync 接住转成 ''
    throw new Error('data not found');
  }
  let data = value;
  try {
    const result = parseValue(JSON.parse(value));
    if (result !== undefined) data = result as string;
  } catch {
    // 不是 JSON：就是原样存的字符串
  }
  return data;
}

export interface UniStubOptions {
  /**
   * `uni.getSystemInfoSync().uniPlatform` 的取值。
   *
   * 默认 `'web'` —— **这是 H5 的真实取值**（`@dcloudio/uni-h5` 里写死 `uniPlatform: "web"`），
   * 因此「H5 上不会选到小程序传输」这条负对照用的是默认值，而不是造出来的平台。
   */
  platform?: string;
}

/**
 * `uni.createInnerAudioContext()` 的替身实例（音效层，U4）。
 *
 * ⚠️ **判据射程**：jsdom 里没有声音。替身证明的是「该响的时候，用**正确的 src** 调了
 * `play()`」——**不是**「真的听见了」。声音本身由真机走查确认。
 */
export interface UniAudioDouble {
  /** 本实例被设过的 `src` 序列（取最后一个 = 当前值）。 */
  src: string[];
  /** `play()` 被调的次数。 */
  play: number;
  /** `stop()` / `destroy()` 被调的次数。 */
  stop: number;
  /** `loop` 是否被设成 true。 */
  loop: boolean;
  /** 最近一次设置的 `volume`。 */
  volume: number;
  /**
   * `onCanplay` 注册的回调（项 4：预热用例手动派发它，断言就绪即销毁）。
   * ⚠️ 替身**默认不触发**（见 createInnerAudioContext 里的注释，BGM 判据依赖这一点）。
   */
  canplayHandler: (() => void) | null;
  /** `onError` 注册的回调（同上，测试手动派发）。 */
  errorHandler: ((err?: unknown) => void) | null;
  /** `onEnded` 注册的回调（测试手动派发，用于迟到回调竞态）。 */
  endedHandler: (() => void) | null;
  /** `onPlay` 注册的回调（测试手动派发，用于「已 started」判定）。 */
  playHandler: (() => void) | null;
}

/** 替身记录的全部音效上下文（每个 `createInnerAudioContext()` 追加一条）。 */
export const audioContexts: UniAudioDouble[] = [];

/**
 * 替身的**视口尺寸**（片①）。默认 **866×390**（手机横屏，本片主目标设备）。
 * 用例可用 `setWindowSize()` 改成别的（如竖屏 375×812）来考「旋转提示」那条路。
 */
export const windowSize = { w: 866, h: 390 };

/** 已注册的窗口变化回调。 */
export const windowResizeHandlers = new Set<
  (res: { size: { windowWidth: number; windowHeight: number } }) => void
>();

/** 改视口尺寸**并触发**已注册的 resize 回调（模拟旋转 / 拖窗口）。 */
export function setWindowSize(w: number, h: number): void {
  windowSize.w = w;
  windowSize.h = h;
  const res = { size: { windowWidth: w, windowHeight: h } };
  for (const cb of [...windowResizeHandlers]) cb(res);
}

/** 已注册的前后台切换回调（项 1）。 */
export const appShowHandlers = new Set<() => void>();
export const appHideHandlers = new Set<() => void>();

/** 模拟应用回前台：触发全部 `uni.onAppShow` 回调。 */
export function triggerAppShow(): void {
  for (const cb of [...appShowHandlers]) cb();
}

/** 模拟应用切后台：触发全部 `uni.onAppHide` 回调。 */
export function triggerAppHide(): void {
  for (const cb of [...appHideHandlers]) cb();
}

/** 造一个替身（**不**安装到全局；安装用 `installUniStub`）。 */
export function createUniStub(options: UniStubOptions = {}): UniStub {
  const calls: UniStubCalls = {
    reLaunch: [],
    navigateTo: [],
    navigateBack: [],
    showToast: [],
    showModal: [],
    request: [],
    windowResize: { on: 0, off: 0 },
    appVisibility: { onShow: 0, onHide: 0, offShow: 0, offHide: 0 },
    vibrateShort: 0,
    vibrateLong: 0,
  };
  const platform = options.platform ?? 'web';
  let requestResponder: UniStub['requestResponder'] = null;
  // 重装替身（每个用例都会 install）时先清空上一用例遗留的前后台监听。
  appShowHandlers.clear();
  appHideHandlers.clear();

  return {
    calls,
    resetCalls() {
      calls.reLaunch.length = 0;
      calls.navigateTo.length = 0;
      calls.navigateBack.length = 0;
      calls.showToast.length = 0;
      calls.showModal.length = 0;
      calls.request.length = 0;
      calls.appVisibility.onShow = 0;
      calls.appVisibility.onHide = 0;
      calls.appVisibility.offShow = 0;
      calls.appVisibility.offHide = 0;
      calls.vibrateShort = 0;
      calls.vibrateLong = 0;
    },

    get requestResponder() {
      return requestResponder;
    },
    set requestResponder(responder) {
      requestResponder = responder;
    },

    /**
     * 对照真 `uni.request` 的**回调形态**：入参里带 `success` / `fail` / `complete`，
     * 结果经 `success({ statusCode, data })` 回来。
     *
     * ⚠️ 这里**不** JSON.parse / JSON.stringify 任何东西：`dataType: 'json'` 的
     * 「对象 vs 字符串」形态由用例的 `requestResponder` 决定，归一化与信封解析都是被测代码的事
     * （替身替它做，就等于把被测逻辑搬进测试）。
     */
    request(options) {
      calls.request.push(options);
      const responder = requestResponder;
      if (!responder) {
        const errMsg = 'uni.request: 用例没有配置应答（请设置 stub.requestResponder）';
        options.fail?.({ errMsg });
        options.complete?.({ errMsg });
        return;
      }
      let result: UniRequestResult;
      try {
        result = responder(options);
      } catch (error) {
        const errMsg = `uni.request: requestResponder 抛错：${String(error)}`;
        options.fail?.({ errMsg });
        options.complete?.({ errMsg });
        return;
      }
      options.success?.(result);
      options.complete?.({ errMsg: 'request:ok' });
    },

    /**
     * 对照 uni-h5 的 `setStorageSync`：字符串原样存；其余 `JSON.stringify({ type, data })`。
     * 真实现**不做 try/catch**（配额、无 localStorage 时会抛），替身同样让它抛 ——
     * 这样 `src/net/storage.ts` 自己的兜底才有被考到的机会。
     */
    setStorageSync(key, value) {
      const type = typeof value;
      const encoded = type === 'string' ? (value as string) : JSON.stringify({ type, data: value });
      const backend = (globalThis as { localStorage?: Storage }).localStorage;
      if (!backend) throw new Error('setStorageSync: no storage backend (localStorage is missing)');
      backend.setItem(key, encoded);
    },

    /** 对照 uni-h5 的 `getStorageSync`：未命中 / 宿主抛错 ⇒ **返回 `''`**。 */
    getStorageSync(key) {
      try {
        return getStorageOrigin(key);
      } catch {
        return '';
      }
    },

    /** 对照 uni-h5 的 `removeStorageSync`：有后端才删，缺后端不抛。 */
    removeStorageSync(key) {
      const backend = (globalThis as { localStorage?: Storage }).localStorage;
      if (backend) backend.removeItem(key);
    },

    reLaunch(options) {
      calls.reLaunch.push(options.url);
    },
    navigateTo(options) {
      calls.navigateTo.push(options.url);
    },
    navigateBack(options) {
      // uni 的 `delta` 缺省为 1（`UniNamespace.navigateBack` 语义）；替身照抄缺省。
      calls.navigateBack.push(options?.delta ?? 1);
    },
    showToast(options) {
      calls.showToast.push(options);
    },
    /**
     * ⚠️ **只入数组、不自动回调**（与真 uni 的差异登记，见 `UniStubCalls.showModal`）：
     * 确认 / 取消由用例经记录下来的 `success` 显式触发 —— 替身替用例猜答案
     * 会让「取消 ⇒ 留守」这条判据变成恒真的空测。
     */
    showModal(options) {
      calls.showModal.push(options);
    },
    /**
     * ⚠️ **片① 起返回视口尺寸与安全区**（`LandscapeStage` 靠它算画布缩放比）。
     *
     * 不给这两个字段的话 `readViewport()` 只能拿到 `w=h=0` ⇒ 组件永远走**兜底路径**
     * （`k = 0.5`）⇒ 所有涉及画布的用例都测不到真实路径（**测试比实现宽松**，本仓明令禁止）。
     *
     * 默认值取 **866×390**（手机横屏，19.5:9）—— 本片的主目标设备；
     * `safeArea` 取**全屏**（即无刘海），需要刘海的用例自己覆盖。
     */
    getSystemInfoSync() {
      return {
        uniPlatform: platform,
        windowWidth: windowSize.w,
        windowHeight: windowSize.h,
        safeArea: { left: 0, top: 0, right: windowSize.w, bottom: windowSize.h },
      };
    },

    /** 窗口变化监听（片① / R721）。替身只记账 —— 用例可断言「注册/注销成对」。 */
    onWindowResize(cb) {
      windowResizeHandlers.add(cb);
      calls.windowResize.on += 1;
    },
    offWindowResize(cb) {
      windowResizeHandlers.delete(cb);
      calls.windowResize.off += 1;
    },

    /** 前后台切换替身（项 1）：注册到模块级 Set，trigger 函数负责派发。 */
    onAppShow(cb) {
      appShowHandlers.add(cb);
      calls.appVisibility.onShow += 1;
    },
    onAppHide(cb) {
      appHideHandlers.add(cb);
      calls.appVisibility.onHide += 1;
    },
    offAppShow(cb) {
      appShowHandlers.delete(cb);
      calls.appVisibility.offShow += 1;
    },
    offAppHide(cb) {
      appHideHandlers.delete(cb);
      calls.appVisibility.offHide += 1;
    },

    /** 震动替身（触感层）：只记账 —— 判据是「该震的时候调了，关了就不调」。 */
    vibrateShort() {
      calls.vibrateShort += 1;
    },
    vibrateLong() {
      calls.vibrateLong += 1;
    },

    /**
     * 音效上下文替身（U4）。
     *
     * ⚠️ **`play()` 故意返回一个「会拒绝」的 Promise**：真实浏览器里无用户手势时
     * 播放会被拒（autoplay 策略），而**未处理的拒绝在真机上就是探针的
     * `Runtime.exceptionThrown`**（零容忍）。替身照抄这个形态，
     * 「忘了 catch」在本仓的用例里当场暴露，而不是留到真机。
     */
    createInnerAudioContext() {
      const rec: UniAudioDouble = {
        src: [],
        play: 0,
        stop: 0,
        loop: false,
        volume: 1,
        canplayHandler: null,
        errorHandler: null,
        endedHandler: null,
        playHandler: null,
      };
      audioContexts.push(rec);
      return {
        set src(value: string) {
          rec.src.push(value);
        },
        get src() {
          return rec.src[rec.src.length - 1] ?? '';
        },
        set loop(value: boolean) {
          rec.loop = value;
        },
        get loop() {
          return rec.loop;
        },
        set volume(value: number) {
          rec.volume = value;
        },
        get volume() {
          return rec.volume;
        },
        play: () => {
          rec.play += 1;
          return Promise.reject(new Error('autoplay blocked (stub)'));
        },
        pause: () => undefined,
        stop: () => {
          rec.stop += 1;
        },
        destroy: () => {
          rec.stop += 1;
        },
        // ⚠️ 生产代码里 `onEnded` / `onError` 是**不加可选链**的直接调用
        // （加了 `?.` 会让「这个端没这个方法」从编译期错误退化成运行期静默）
        // ⇒ 替身必须实现它们，否则调用时当场 `TypeError`。
        onEnded: (cb: () => void) => {
          rec.endedHandler = cb;
        },
        onError: (cb: (err: unknown) => void) => {
          rec.errorHandler = cb;
        },
        onPlay: (cb: () => void) => {
          rec.playHandler = cb;
        },
        onPause: () => undefined,
        /**
         * ⚠️ 片② 起生产代码**等 `onCanplay` 才调 `play()`**（见 `audio/index.ts` 的
         * `playWhenReady` —— 不等就绪就起播会在 `stop()` 时打出未处理的 `AbortError`）。
         * 替身**默认不触发**它：这样单测里 `play()` 一次都不会被调，
         * 而 BGM 的判据只断言 `src` / `loop` / `stop`（不断言 `play` 次数）⇒ 不受影响。
         * 项 4 的预热用例需要时手动调 `rec.canplayHandler?.()` 派发。
         */
        onCanplay: (cb: () => void) => {
          rec.canplayHandler = cb;
        },
      };
    },
  };
}

/**
 * 安装替身到全局并返回它。
 *
 * 用例可以在 `beforeEach` 里再调一次（顺手清空调用流水），也可以在需要
 * 另一个平台的用例里 `installUniStub({ platform: 'mp-weixin' })`。
 * **不动 `localStorage`**：存储后端由各个用例自己准备（有的用例会 `localStorage.clear()`）。
 */
export function installUniStub(options: UniStubOptions = {}): UniStub {
  const stub = createUniStub(options);
  (globalThis as { uni?: unknown }).uni = stub;
  return stub;
}
