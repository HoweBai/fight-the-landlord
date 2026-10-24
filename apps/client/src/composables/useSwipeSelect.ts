/**
 * 滑动选牌（欢乐斗地主风格）。
 *
 * 核心交互：
 *  - 按下未选牌 → 模式 = "选"，滑过的牌依次选中；
 *  - 按下已选牌 → 模式 = "不选"，滑过的牌依次取消；
 *  - 抬起 → 退出滑动；
 *  - 短按 + 无移动 → 不是滑动，由调用方走普通 toggle。
 *
 * 设计原则：
 *  - 本模块只做**状态机 + 命中检测 + 去重**，不碰 DOM；
 *  - 矩形由宿主（Hand.vue）在 touchstart 时缓存好传进来（跨端 getBoundingClientRect
 *    差异由宿主隔离）；
 *  - 返回的"事件"是纯数据（displayIndex 数组），宿主映射回 store.hand 原始下标。
 */

/** 滑动模式：起始点决定，全程不变。 */
export type SwipeMode = 'idle' | 'selecting' | 'deselecting';

/** 命中矩形（与 DOMRect 同形，方便宿主转换）。 */
export interface CardRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 一次 touch 会话的完整状态。 */
export interface SwipeState {
  /** 当前模式。 */
  mode: SwipeMode;
  /** 起始点是否在 selected 集合里（决定 mode）。 */
  startInSelected: boolean;
  /** 上一帧命中的展示序下标（去重用）。 */
  lastHit: number | null;
  /** 本次会话已经处理过的展示序下标集合（processed，去重防抖）。 */
  processed: Set<number>;
}

/**
 * 点击/滑动判定阈值。
 *
 * 欢乐斗地主同款：位移 < 8px、耗时 < 300ms 视为点击。
 * 超过位移阈值即进入滑动模式。
 */
export const SWIPE_THRESHOLD_PX = 8;
export const TAP_TIMEOUT_MS = 300;

/** 空状态常量，避免每次重置都新建对象。 */
export const IDLE_STATE: SwipeState = {
  mode: 'idle',
  startInSelected: false,
  lastHit: null,
  processed: new Set(),
};

/**
 * 初始化一次 touch 会话。
 *
 * @param startDisplayIndex 起始点命中的**展示序**下标（-1 表示没命中任何牌）
 * @param selectedSet 当前已选中的**展示序**下标集合
 */
export function startSwipe(
  startDisplayIndex: number,
  selectedSet: ReadonlySet<number>,
): SwipeState {
  if (startDisplayIndex < 0) {
    return { ...IDLE_STATE, processed: new Set() };
  }
  const inSelected = selectedSet.has(startDisplayIndex);
  return {
    mode: inSelected ? 'deselecting' : 'selecting',
    startInSelected: inSelected,
    lastHit: startDisplayIndex,
    processed: new Set([startDisplayIndex]),
  };
}

/**
 * 命中检测：点 (x, y) 是否落进某张牌的矩形里。
 *
 * 倒序遍历 → 后渲染的牌在视觉上压在前面，优先命中。
 * 这是欢乐斗地主等大多数棋牌的直觉：你看到上面那张，点到的就是那张。
 *
 * @returns 展示序下标；-1 = 没命中任何牌
 */
export function hitTest(
  x: number,
  y: number,
  rects: readonly CardRect[],
): number {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const r = rects[i]!;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return i;
    }
  }
  return -1;
}

/**
 * touchmove 一帧：返回这一帧新增/移除的展示序下标。
 *
 * @returns `{ added, removed }` — 本次移动需要追加选中 / 移除的展示序下标
 */
export function stepSwipe(
  state: SwipeState,
  hitIndex: number,
): { added: number[]; removed: number[] } {
  if (state.mode === 'idle') return { added: [], removed: [] };
  if (hitIndex < 0) return { added: [], removed: [] };
  // 去重：同一位置微抖不重复触发
  if (hitIndex === state.lastHit) return { added: [], removed: [] };

  state.lastHit = hitIndex;
  if (state.processed.has(hitIndex)) return { added: [], removed: [] };
  state.processed.add(hitIndex);

  if (state.mode === 'selecting') return { added: [hitIndex], removed: [] };
  return { added: [], removed: [hitIndex] };
}

/** 重置为空闲状态（抬起 / 取消 / 手牌变化）。 */
export function endSwipe(): SwipeState {
  return { ...IDLE_STATE, processed: new Set() };
}

/**
 * 是否跨过了"滑动"阈值。
 *
 * @param dx touchstart → touchend 的水平位移
 * @param dy 垂直位移
 */
export function isSwipeGesture(dx: number, dy: number): boolean {
  const d2 = dx * dx + dy * dy;
  return d2 >= SWIPE_THRESHOLD_PX * SWIPE_THRESHOLD_PX;
}

/**
 * 是否是"点击"手势（短按 + 无显著移动）。
 */
export function isTapGesture(dx: number, dy: number, durationMs: number): boolean {
  if (durationMs > TAP_TIMEOUT_MS) return false;
  return !isSwipeGesture(dx, dy);
}
