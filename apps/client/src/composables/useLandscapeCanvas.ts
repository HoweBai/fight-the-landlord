/**
 * 横屏画布的尺寸模型（2026-10-11 起：**全出血自适应**；前身是 spec §2 / R709–R712
 * 的「1334×750 固定画布 + contain 居中」，超宽屏两侧留边）。
 *
 * ## 模型：设计坐标系 = 安全区 ÷ k
 *
 * · `k = min(可用宽 / 1334, 可用高 / 750)`（与旧 contain 公式**逐值相同** ⇒
 *   令牌 × k 得到的元素视觉尺寸在任何设备上一个 px 都不变）；
 * · 画布设计尺寸 = `可用宽 / k × 可用高 / k` ⇒ 缩放后**恰好铺满安全区**，
 *   任意宽高比（19.5:9 手机、4:3 平板、桌面宽窗、带鱼屏）零留边；
 * · 1334×750 从「画布固定尺寸」降级为「设计坐标的**最小**尺寸」——
 *   设计宽恒 ≥ 1334、设计高恒 ≥ 750，按 1334 坐标系标定的令牌与账目（如手牌 20 张
 *   单行预算 1428 ≤ 最紧可用宽 1294）永远成立，非 16:9 时可用空间只增不减。
 *
 * ## 为什么要 JS 算而不是 CSS `min()` + `vw/vh`
 *
 * · **`ui-tokens` 闸禁用 `vw`/`vh`** ⇒ 用 CSS 方案要再开一次白名单；JS 方案**一个字都不用改闸**；
 * · App / 小程序端不依赖 `clamp()` / 媒体查询等新 CSS 特性的支持程度；
 * · **纯函数可单测** —— 设备矩阵（九档典型视口）由判据机械钉死，不靠设备实验室走查。
 *
 * ## 为什么是**同步**算（而不是异步回调里赋值）
 *
 * `uni.getSystemInfoSync()` 是**同步**的 ⇒ `k` 在 `setup()` 里就算得出来 ⇒ **首帧就是对的**。
 * 这消除了三个问题：FOUC、初始隐藏、以及「隐藏期间 JS 一失败就永久白屏」。
 *
 * ⚠️ 旋转瞬态垃圾读数（iOS Safari 派发 innerHeight≈1 且不再纠正）的防线在
 * `sanitizeViewport` / `keepLastGoodViewport` 与 `useLandscapeViewport` composable：
 * 读数不可用时保留上一个好读数，并由 composable 在旋转后定时复读自愈。
 * 定时器放 composable 是刻意的：`animations.test.ts` 扫 `src/components/**` 的
 * setTimeout/setInterval（牌桌区「不新造时钟」纪律），组件里不得出现时钟。
 */

/**
 * 设计坐标的**最小**尺寸（16:9）。视口恰为 16:9 时画布正好等于这个尺寸；
 * 更宽/更高的视口只会让对应方向的设计尺寸变大（全出血），永不缩小。
 */
export const CANVAS_W = 1334;
export const CANVAS_H = 750;

/** 安全区（刘海 / 挖孔），单位为逻辑 px。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 视口信息（视口尺寸 + 安全区）。 */
export interface Viewport {
  w: number;
  h: number;
  insets: Insets;
}

/**
 * 统一缩放比 k = `min(可用宽 / 最小设计宽, 可用高 / 最小设计高)`。
 *
 * 与旧 contain 模型同一个公式：它保证**缩放后画布永远放得进安全区**；
 * 多出来的空间不靠「缩小 k」吃掉（那会让元素变小），而靠 `layoutMetrics`
 * 把对应方向的**设计尺寸**放大（元素大小不变，布局铺满）。
 */
export function landscapeScale(w: number, h: number, insets: Partial<Insets> = {}): number {
  const merged = { ...ZERO_INSETS, ...insets };
  const usableW = Math.max(1, w - merged.left - merged.right);
  const usableH = Math.max(1, h - merged.top - merged.bottom);
  return Math.min(usableW / CANVAS_W, usableH / CANVAS_H);
}

/** 舞台的完整布局尺寸（设计坐标 + 统一缩放比）。 */
export interface LayoutMetrics {
  /** 统一缩放比（= `landscapeScale`）；元素视觉尺寸 = 设计令牌 × scale。 */
  scale: number;
  /** 画布的**设计宽**（px）；缩放后恰好等于安全区宽，且恒 ≥ `CANVAS_W`。 */
  width: number;
  /** 画布的**设计高**（px）；缩放后恰好等于安全区高，且恒 ≥ `CANVAS_H`。 */
  height: number;
}

/**
 * 计算舞台的**全出血**布局：
 *
 * ```
 * scale        = landscapeScale(w, h, insets)
 * width×scale  = 可用宽  ⇒ 左右零留边
 * height×scale = 可用高  ⇒ 上下零留边
 * width ≥ 1334 ∧ height ≥ 750      ⇒ 最小设计尺寸兜底
 * ```
 *
 * 典型视口算例（无安全区）：
 *  · 844×390（19.5:9 手机）⇒ k=0.52，画布 1623×750（旧模型只占中间 1334，两侧留边）；
 *  · 1024×768（4:3 平板）⇒ k=0.768，画布 1334×1000（旧模型上下留边）；
 *  · 1280×720（16:9）⇒ k=0.96，画布 1334×750（与旧模型**完全一致**）。
 */
export function layoutMetrics(w: number, h: number, insets: Partial<Insets> = {}): LayoutMetrics {
  const merged = { ...ZERO_INSETS, ...insets };
  const usableW = Math.max(1, w - merged.left - merged.right);
  const usableH = Math.max(1, h - merged.top - merged.bottom);
  const scale = landscapeScale(w, h, insets);
  return {
    scale,
    // 除回去恒等于 usableW/usableH；Math.max 同时把「scale 异常」的病态输入兜在最小尺寸上。
    width: Math.max(CANVAS_W, usableW / scale),
    height: Math.max(CANVAS_H, usableH / scale),
  };
}

/**
 * 是否竖屏。
 *
 * ⚠️ 正方形（`h === w`）**不算**竖屏 —— 它不需要旋转提示，画布照样放得下。
 */
export function isPortrait(w: number, h: number): boolean {
  return h > w;
}

/**
 * 单边 inset 的合理性上限（CSS px）：超过它的一律当异常读数丢弃（回落 0）。
 * 取 200 是「任何状态栏/挖孔/手势条都不可能更厚」的粗界 —— 它只在**异常读数**上生效，
 * 正常设备（个位到几十 px）完全不受影响。
 */
const INSET_LIMIT = 200;

/**
 * App 平台（HTML5+）的**真实安全区补充读数**（2026-10-13 真机走查「跨设备裁剪」修复）。
 *
 * 🔴 **为什么需要第二个来源**：uni 运行时在 **Android 上把 safeArea 硬零化**——
 * `@dcloudio/uni-app-plus/dist/uni.runtime.esm.js` 的 `getWindowInfo()` 逐字写着
 * `ios ? safeAreaInsets : { left: 0, right: 0, top: …statusBarHeight, bottom: 0 }`
 * ⇒ 横屏时刘海/挖孔（在**侧边**）与手势条（在**底部**）**零保护**，画布铺到物理边，
 * 边缘内容压在挖孔/圆角/手势条下 —— 真机「内容被裁剪（底部/边缘被切）」的根因之一。
 *
 * 本函数读的是运行时**自己先读、随后又被 Android 分支覆盖掉**的那个原始 API
 * （同一函数里 `webview.getSafeAreaInsets()` / `plus.navigator.getSafeAreaInsets()`），
 * 交给调用方**逐边取 max** 合并。H5 / 小程序无 `plus` ⇒ 返回全 0（行为不变）。
 *
 * ⚠️ **未验事项（如实）**：plus 读数在**真机刘海屏**上的具体数值无法在本机模拟器产生
 * （MuMu 无刘海，实测全 0）；本实现与判据保证的是**合并/钳制逻辑**（异常读数不污染、
 * 无 plus 不加改变），「真机上 plus 给出正确 inset」留真机验证（见交接清单）。
 */
function plusSafeAreaInsets(): Insets {
  try {
    const plus = (globalThis as {
      plus?: { navigator?: { getSafeAreaInsets?: () => unknown } };
    }).plus;
    const raw = plus?.navigator?.getSafeAreaInsets?.() as
      | { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown }
      | null
      | undefined;
    if (!raw || typeof raw !== 'object') return { ...ZERO_INSETS };
    const sane = (value: unknown): number => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n <= INSET_LIMIT ? n : 0;
    };
    return {
      top: sane(raw.top),
      right: sane(raw.right),
      bottom: sane(raw.bottom),
      left: sane(raw.left),
    };
  } catch {
    // 宿主没就绪（plus 未注入）/ API 抛错 —— 回落全 0，绝不因补充读数而崩。
    return { ...ZERO_INSETS };
  }
}

/**
 * 横屏可用区域的**绝对下限**（逻辑 px）。
 *
 * 真机横屏最短边 ≥ 320（iPhone SE 一代 568×320），竖屏宽度 ≥ 320；
 * 低于这个量级的读数只可能是**旋转瞬态**（iOS Safari 在旋转动画 / 工具栏收放过程中
 * 会派发 innerHeight=1 量级的 resize，且**之后不再派发纠正事件**）或宿主抽风。
 *
 * 2026-10-15 真机缺陷取证：iPhone Safari 横屏时最后一个 resize 携带 ~80px 高 +
 * 竖屏残留 env 安全区（T47/B34）⇒ `usableH=1` ⇒ `scale=1/750=0.0013` ⇒ 画布塌成
 * 一条 1px 的线，视觉上只剩 `.stage` 底纹（登录 UI「消失」）。
 */
export const MIN_USABLE_WIDTH = 240;
export const MIN_USABLE_HEIGHT = 200;

/**
 * 单侧安全区占对应轴的**最大可信比例**。真实设备最大刘海 ~47/390 ≈ 12%，
 * 取 1/3 留足余量；超过即判定为「视口已转向、env() 还投影着旧方向 inset」的过期读数，
 * 该侧 inset **丢弃按 0 处理**（不是夹到上限 —— 夹了仍会把画布推出安全区）。
 */
const MAX_INSET_RATIO = 1 / 3;

function sanitizeInset(inset: number, axis: number): number {
  const value = Number(inset);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > axis * MAX_INSET_RATIO ? 0 : value;
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    a.w === b.w &&
    a.h === b.h &&
    a.insets.top === b.insets.top &&
    a.insets.right === b.insets.right &&
    a.insets.bottom === b.insets.bottom &&
    a.insets.left === b.insets.left
  );
}

/**
 * 把宿主读数**消毒**成「可用于排版」的视口：
 *
 *  1. `w/h` 非正 / 非有限数 ⇒ 不可用（`LandscapeStage` 走 FALLBACK）；
 *  2. 单侧 inset 超过轴向 1/3 ⇒ 视为旋转瞬态的过期 env 投影，丢弃该侧；
 *  3. 消毒后可用区低于 {@link MIN_USABLE_WIDTH} / {@link MIN_USABLE_HEIGHT} ⇒ 不可用
 *     （调用方应**保留上一个好读数**，而不是把画布缩没）。
 *
 * @returns 消毒后的视口；读数不可用时返回 `null`。
 */
export function sanitizeViewport(raw: Viewport | null | undefined): Viewport | null {
  if (!raw) return null;
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const insets: Insets = {
    top: sanitizeInset(raw.insets?.top, h),
    right: sanitizeInset(raw.insets?.right, w),
    bottom: sanitizeInset(raw.insets?.bottom, h),
    left: sanitizeInset(raw.insets?.left, w),
  };
  if (w - insets.left - insets.right < MIN_USABLE_WIDTH) return null;
  if (h - insets.top - insets.bottom < MIN_USABLE_HEIGHT) return null;
  return { w, h, insets };
}

/**
 * 「上一个好读数」语义：新读数可用则**替换**；不可用（旋转瞬态）则**保留**旧读数。
 * 没有旧读数时返回零视口，由组件走 FALLBACK。
 */
export function keepLastGoodViewport(
  previous: Viewport,
  next: Viewport | null | undefined,
): Viewport {
  const clean = sanitizeViewport(next);
  if (!clean) return previous;
  return sameViewport(previous, clean) ? previous : clean;
}

/**
 * 从宿主读取视口与安全区。
 *
 * ⚠️ **失败模式必须有，且不依赖成功路径**：`getSystemInfoSync()` 一旦抛错或返回异常值，
 * 就返回 `w/h = 0`，由调用方（`LandscapeStage`）用保守值兜住 ——
 * **内容可能被裁，但不会白屏**（R693 同族纪律）。
 *
 * ⚠️ **`safeArea` 的语义**：uni 返回的是**安全框矩形**（`left/top/right/bottom` 是**坐标**，
 * 不是 inset 宽度）⇒ 右 / 下要转成「视口 − 坐标」。
 * <br>⚠️ **Android 上 uni 的 safeArea 左/右/下恒 0**（运行时硬零化，见 `plusSafeAreaInsets`
 * 的注释）⇒ 逐边与 `plus.navigator.getSafeAreaInsets()` 的读数**取 max** 合并；
 * 无 plus（H5/小程序）或读数异常时合并为 no-op（行为与修复前逐字一致）。
 */
export function readViewport(): Viewport {
  const plusInsets = plusSafeAreaInsets();
  try {
    const info = uni.getSystemInfoSync() as {
      windowWidth?: number;
      windowHeight?: number;
      safeArea?: { left?: number; top?: number; right?: number; bottom?: number } | null;
    };
    const w = Number(info.windowWidth) || 0;
    const h = Number(info.windowHeight) || 0;
    const sa = info.safeArea ?? null;
    const base: Insets = sa
      ? {
          top: Math.max(0, Number(sa.top) || 0),
          left: Math.max(0, Number(sa.left) || 0),
          // ⚠️ 坐标 → inset：右侧 inset = 视口宽 − safeArea.right
          right: Math.max(0, w - (Number(sa.right) || w)),
          bottom: Math.max(0, h - (Number(sa.bottom) || h)),
        }
      : { ...ZERO_INSETS };
    return {
      w,
      h,
      insets: {
        top: Math.max(base.top, plusInsets.top),
        right: Math.max(base.right, plusInsets.right),
        bottom: Math.max(base.bottom, plusInsets.bottom),
        left: Math.max(base.left, plusInsets.left),
      },
    };
  } catch {
    return { w: 0, h: 0, insets: { ...ZERO_INSETS } };
  }
}
