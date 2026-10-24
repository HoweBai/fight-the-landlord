/**
 * 滑动选牌核心状态机 + 命中检测（纯函数，端无关）。
 *
 * 全部测试都是纯函数：不需要挂载组件、不需要 DOM。
 */
import { describe, expect, it } from 'vitest';
import {
  IDLE_STATE,
  TAP_TIMEOUT_MS,
  SWIPE_THRESHOLD_PX,
  endSwipe,
  hitTest,
  isSwipeGesture,
  isTapGesture,
  startSwipe,
  stepSwipe,
  type CardRect,
  type SwipeState,
} from '../src/composables/useSwipeSelect';

/** 5 张牌的 mock 矩形，每张宽 100、高 150，间距 10，无重叠。 */
const FIVE_RECTS: CardRect[] = Array.from({ length: 5 }, (_, i) => ({
  left: i * 110,
  right: i * 110 + 100,
  top: 0,
  bottom: 150,
}));

describe('useSwipeSelect — 命中检测 hitTest', () => {
  it('命中第一张牌中心', () => {
    expect(hitTest(50, 75, FIVE_RECTS)).toBe(0);
  });
  it('命中最后一张牌中心', () => {
    expect(hitTest(440, 75, FIVE_RECTS)).toBe(4);
  });
  it('没命中任何牌（x 在缝隙里）', () => {
    expect(hitTest(105, 75, FIVE_RECTS)).toBe(-1);
  });
  it('没命中任何牌（y 超出）', () => {
    expect(hitTest(100, 200, FIVE_RECTS)).toBe(-1);
  });
  it('边界严格（left/right inclusive）', () => {
    expect(hitTest(0, 75, FIVE_RECTS)).toBe(0);
    expect(hitTest(99, 75, FIVE_RECTS)).toBe(0);
  });
});

/** 模拟真实手牌 62% 重叠（牌宽 155、重叠 96、pitch = 59）。 */
const OVERLAP_RECTS: CardRect[] = Array.from({ length: 5 }, (_, i) => ({
  left: i * 59,
  right: i * 59 + 155,
  top: 0,
  bottom: 200,
}));

describe('useSwipeSelect — 重叠区命中（倒序优先）', () => {
  it('重叠区里命中后面那张（视觉上层）', () => {
    // left=59~155 的区域被 card[0] (0~155) 和 card[1] (59~214) 同时覆盖
    // 倒序遍历应命中 index=1
    expect(hitTest(100, 100, OVERLAP_RECTS)).toBe(1);
  });
  it('第一张牌的独占区（0~59）只命中 0', () => {
    expect(hitTest(30, 100, OVERLAP_RECTS)).toBe(0);
  });
  it('最后一张独占区命中最后一张', () => {
    // 第 5 张 left = 4*59 = 236；right = 236+155 = 391
    // 第 4 张 right = 3*59+155 = 177+155 = 332
    // 所以 332~391 是第 5 张独占
    expect(hitTest(360, 100, OVERLAP_RECTS)).toBe(4);
  });
});

describe('useSwipeSelect — startSwipe：起始点决定模式', () => {
  it('起始点未选中 → mode=selecting，processed 包含自己', () => {
    const state = startSwipe(2, new Set([0, 1]));
    expect(state.mode).toBe('selecting');
    expect(state.startInSelected).toBe(false);
    expect(state.lastHit).toBe(2);
    expect(state.processed.has(2)).toBe(true);
  });

  it('起始点已选中 → mode=deselecting', () => {
    const state = startSwipe(2, new Set([0, 1, 2]));
    expect(state.mode).toBe('deselecting');
    expect(state.startInSelected).toBe(true);
  });

  it('起始点没命中 → idle 模式（不算滑动）', () => {
    const state = startSwipe(-1, new Set());
    expect(state.mode).toBe('idle');
  });

  it('空集合等价于全未选中 → selecting 模式', () => {
    const state = startSwipe(0, new Set());
    expect(state.mode).toBe('selecting');
  });
});

describe('useSwipeSelect — stepSwipe：滑动过程中批量增减', () => {
  it('selecting 模式：滑到未处理过的牌 → added', () => {
    const state = startSwipe(0, new Set());
    // 滑到 index=1
    const r1 = stepSwipe(state, 1);
    expect(r1.added).toEqual([1]);
    expect(r1.removed).toEqual([]);
    // 再滑到 index=2
    const r2 = stepSwipe(state, 2);
    expect(r2.added).toEqual([2]);
  });

  it('deselecting 模式：滑到未处理过的牌 → removed', () => {
    const state = startSwipe(0, new Set([0, 1, 2]));
    const r = stepSwipe(state, 2);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([2]);
  });

  it('同一位置微抖 → 不重复触发（lastHit 去重）', () => {
    const state = startSwipe(0, new Set());
    stepSwipe(state, 1);
    const r = stepSwipe(state, 1);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('来回拉锯：先滑到 1（added），再滑回 0（已 processed，不重复）', () => {
    const state = startSwipe(0, new Set());
    const r1 = stepSwipe(state, 1);
    expect(r1.added).toEqual([1]);
    const r2 = stepSwipe(state, 0);
    expect(r2.added).toEqual([]); // 0 是起始点，已在 processed 里
  });

  it('idle 状态下 step → 什么都不做', () => {
    const state: SwipeState = { ...IDLE_STATE, processed: new Set() };
    const r = stepSwipe(state, 3);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('没命中任何牌 → 跳过', () => {
    const state = startSwipe(0, new Set());
    const r = stepSwipe(state, -1);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    // lastHit 不变
    expect(state.lastHit).toBe(0);
  });
});

describe('useSwipeSelect — 手势判定 isSwipeGesture / isTapGesture', () => {
  it('位移 0 → 不是滑动', () => {
    expect(isSwipeGesture(0, 0)).toBe(false);
  });
  it('位移超过阈值 → 是滑动', () => {
    const t = SWIPE_THRESHOLD_PX;
    expect(isSwipeGesture(t + 1, 0)).toBe(true);
    expect(isSwipeGesture(0, t + 1)).toBe(true);
    // 对角线位移：4-3-5 三角形，dx=6, dy=8 → 10 > 8
    expect(isSwipeGesture(6, 8)).toBe(true);
  });
  it('位移刚好阈值 → 是滑动（>= 语义）', () => {
    expect(isSwipeGesture(SWIPE_THRESHOLD_PX, 0)).toBe(true);
  });

  it('短按 + 无移动 → 点击', () => {
    expect(isTapGesture(0, 0, 100)).toBe(true);
  });
  it('短按 + 有显著移动 → 不是点击', () => {
    expect(isTapGesture(10, 0, 100)).toBe(false);
  });
  it('长按 + 无移动 → 不是点击（超时）', () => {
    expect(isTapGesture(0, 0, TAP_TIMEOUT_MS + 10)).toBe(false);
  });
});

describe('useSwipeSelect — endSwipe 重置', () => {
  it('endSwipe 返回 idle 状态', () => {
    startSwipe(0, new Set());
    const reset = endSwipe();
    expect(reset.mode).toBe('idle');
    expect(reset.lastHit).toBeNull();
    expect(reset.processed.size).toBe(0);
  });
});

describe('useSwipeSelect — 完整场景', () => {
  it('场景 A：5 张牌全部未选，从第 0 张滑到第 4 张 → 依次选中 1,2,3,4', () => {
    const state = startSwipe(0, new Set());
    expect(state.mode).toBe('selecting');
    const batch: number[] = [];
    for (let i = 1; i < 5; i += 1) {
      const { added } = stepSwipe(state, i);
      batch.push(...added);
    }
    expect(batch).toEqual([1, 2, 3, 4]);
  });

  it('场景 B：5 张牌全部已选，从第 2 张滑到第 0 张 → 依次取消 1,0', () => {
    const all = new Set([0, 1, 2, 3, 4]);
    const state = startSwipe(2, all);
    expect(state.mode).toBe('deselecting');
    const batch: number[] = [];
    // 向左滑：2 → 1 → 0
    const r1 = stepSwipe(state, 1);
    batch.push(...r1.removed);
    const r2 = stepSwipe(state, 0);
    batch.push(...r2.removed);
    expect(batch).toEqual([1, 0]);
  });

  it('场景 C：来回拉锯 — 滑到 3 选中，再滑回 2（已 processed，不重复）', () => {
    const state = startSwipe(0, new Set());
    stepSwipe(state, 3);
    const r = stepSwipe(state, 2);
    expect(r.added).toEqual([2]);
    const r2 = stepSwipe(state, 2); // 再抖一下
    expect(r2.added).toEqual([]);
  });
});
