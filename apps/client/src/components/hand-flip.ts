/**
 * 手牌 FLIP 的 DOM 纯工具（可单测，不依赖 Vue）。
 */

/** 当前手牌的根 DOM（H5 的 <view> ref 是组件实例，必须取 $el）。 */
export function resolveHandRoot(raw: unknown): Element | null {
  if (typeof Element === 'undefined') return null;
  const candidate = (raw as { $el?: unknown } | null)?.$el ?? raw;
  return candidate instanceof Element && typeof candidate.querySelectorAll === 'function'
    ? candidate
    : null;
}

/**
 * 画布祖先的 scale(k)：rect 是视口坐标，而卡片 translate 是局部坐标，
 * 位移必须除以它，否则在非 1 的缩放下会二次缩放。
 */
export function canvasScale(root: Element): number {
  const layoutWidth = (root as HTMLElement).offsetWidth;
  if (!(layoutWidth > 0)) return 0;
  const scale = root.getBoundingClientRect().width / layoutWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}
