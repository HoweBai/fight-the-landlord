import { describe, expect, it } from 'vitest';
import { canvasScale, resolveHandRoot } from '../src/components/hand-flip';

describe('hand-flip', () => {
  it('resolveHandRoot：元素直接返回，组件实例取 $el，非法返回 null', () => {
    const el = document.createElement('view');
    expect(resolveHandRoot(el)).toBe(el);
    expect(resolveHandRoot({ $el: el })).toBe(el);
    expect(resolveHandRoot(null)).toBeNull();
    expect(resolveHandRoot({ $el: null })).toBeNull();
  });

  it('canvasScale：rect 宽 / 布局宽；布局宽为 0 ⇒ 0', () => {
    const el = document.createElement('view');
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 1000 });
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 2000 }) as DOMRect,
    });
    expect(canvasScale(el)).toBe(2);

    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 0 });
    expect(canvasScale(el)).toBe(0);
  });
});
