import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import Hand from '../src/components/Hand.vue';
import type { Card } from '@fight-the-landlord/protocol';

type Rect = { left: number; top: number; width: number };

const originalAnimate = Element.prototype.animate;
const originalMatchMedia = window.matchMedia;
const originalCSS = (globalThis as { CSS?: unknown }).CSS;

let animations: Array<{ el: Element; keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn> }>;
const mounted: VueWrapper[] = [];

function mountHand(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(Hand, { props: props as never });
  mounted.push(wrapper);
  return wrapper;
}

function installCapabilities() {
  animations = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { supports: vi.fn(() => true) },
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[]) {
      const record = { el: this, keyframes, cancel: vi.fn() };
      animations.push(record);
      return record;
    },
  });
}

function restoreCapabilities() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: originalAnimate,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: originalCSS });
}

const c = (r: number, s: number): Card => ({ r, s });

/** 给根元素与卡片按「调用次数」返回旧/新 rect；scale = rootRect.width / offsetWidth = 2。 */
function stubRects(wrapper: VueWrapper, before: Rect[], after: Rect[]) {
  const root = wrapper.find('.hand').element as HTMLElement;
  Object.defineProperty(root, 'offsetWidth', { configurable: true, value: 1000 });
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 2000, height: 100 }) as DOMRect,
  });
  wrapper.findAll('[data-hand-key]').forEach((node, index) => {
    const el = node.element as HTMLElement;
    let calls = 0;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const rect = calls === 0 ? before[index]! : after[index]!;
        calls += 1;
        return ({ ...rect, height: 202 }) as DOMRect;
      },
    });
  });
}

beforeEach(() => {
  installCapabilities();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  restoreCapabilities();
});

describe('Hand.vue 的稳定 key + FLIP', () => {
  it('手牌变短：每张幸存牌各调用一次 animate，位移按画布 scale 换算', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0), c(3, 0)],
      reflow: true,
      sort: 'desc',
    });
    // 展示顺序 [5,4,3]；删掉 5 后 [4,3]
    stubRects(
      wrapper,
      [
        { left: 200, top: 0, width: 155 },
        { left: 140, top: 0, width: 155 },
        { left: 80, top: 0, width: 155 },
      ],
      [
        { left: 170, top: 0, width: 155 },
        { left: 170, top: 0, width: 155 },
        { left: 110, top: 0, width: 155 },
      ],
    );

    await wrapper.setProps({ cards: [c(4, 0), c(3, 0)] });

    expect(wrapper.findAll('[data-hand-key]').map((n) => n.attributes('data-hand-key'))).toEqual([
      '4-0',
      '3-0',
    ]);
    expect(animations).toHaveLength(2);
    expect(animations.map((a) => a.el.getAttribute('data-hand-key'))).toEqual(['4-0', '3-0']);
    // 4: (140-170)/2 = -15；3: (80-110)/2 = -15
    for (const animation of animations) {
      expect(animation.keyframes[0]!.translate).toBe('-15px 0px');
      expect(animation.keyframes[1]!.translate).toBe('0px 0px');
    }
  });

  it('手牌变长（地主底牌 17→20）：新牌无旧位置不报错，幸存牌照常动画', async () => {
    const wrapper = mountHand({
      cards: [c(4, 0), c(3, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 120, top: 0, width: 155 },
        { left: 70, top: 0, width: 155 },
      ],
    );
    animations = [];
    await expect(
      wrapper.setProps({ cards: [c(5, 0), c(4, 0), c(3, 0)] }),
    ).resolves.toBeUndefined();
    expect(animations).toHaveLength(2);
    expect(animations.map((a) => a.el.getAttribute('data-hand-key'))).toEqual(['4-0', '3-0']);
  });

  it('selected 变化但 key 顺序不变 ⇒ 不触发 FLIP（新旧 rect 不同，只有早退能挡住）', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 100, top: -24, width: 155 },
        { left: 50, top: -24, width: 155 },
      ],
    );

    animations = [];
    await wrapper.setProps({ selected: [0] });

    expect(animations).toHaveLength(0);
  });

  it('连续两次手牌更新：先 cancel、再测新 rect', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0), c(3, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 200, top: 0, width: 155 },
        { left: 140, top: 0, width: 155 },
        { left: 80, top: 0, width: 155 },
      ],
      [
        { left: 170, top: 0, width: 155 },
        { left: 170, top: 0, width: 155 },
        { left: 110, top: 0, width: 155 },
      ],
    );
    await wrapper.setProps({ cards: [c(4, 0), c(3, 0)] });
    expect(animations).toHaveLength(2);
    // 第二次更新只留 3 ⇒ 被取消的是 3 的上一轮动画（animations[1]）
    const survivorAnimation = animations[1]!;
    let cancelled = false;
    survivorAnimation.cancel.mockImplementation(() => {
      cancelled = true;
    });

    // 第二次更新：4 被删、3 保留。3 的新 rect 只有在 cancel 之后才返回布局位置。
    wrapper.findAll('[data-hand-key]').forEach((node, index) => {
      const el = node.element as HTMLElement;
      let calls = 0;
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const before = [170, 110][index]!;
          const during = [150, 130][index]!;
          const after = [130, 90][index]!;
          const left = calls === 0 ? before : cancelled ? after : during;
          calls += 1;
          return ({ left, top: 0, width: 155, height: 202 }) as DOMRect;
        },
      });
    });

    await wrapper.setProps({ cards: [c(3, 0)] });

    expect(survivorAnimation.cancel).toHaveBeenCalled();
    // 3: before=110、cancel 后 after=90 ⇒ (110-90)/2 = 10px
    expect(animations.at(-1)!.keyframes[0]!.translate).toBe('10px 0px');
  });

  it('无 Element.animate ⇒ 不抛错、不调用 animate', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 80, top: 0, width: 155 },
        { left: 30, top: 0, width: 155 },
      ],
    );
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: undefined,
    });
    animations = [];
    await expect(wrapper.setProps({ cards: [c(4, 0)] })).resolves.toBeUndefined();
    expect(animations).toHaveLength(0);
  });

  it('reflow=false ⇒ 不挂 data-hand-key、不调用 animate', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      sort: 'desc',
    });
    expect(wrapper.findAll('[data-hand-key]')).toHaveLength(0);
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });

  it('零位移 ⇒ 不启动动画', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
    );
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });

  it('prefers-reduced-motion ⇒ 跳过 FLIP', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 80, top: 0, width: 155 },
        { left: 30, top: 0, width: 155 },
      ],
    );
    const media = vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    }));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: media,
    });
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
    expect(media).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('CSS.supports("translate") 为假 ⇒ 跳过 FLIP', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 80, top: 0, width: 155 },
        { left: 30, top: 0, width: 155 },
      ],
    );
    const supports = vi.fn(
      (property: string, value: string) => !(property === 'translate' && value === '0px'),
    );
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { supports },
    });
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
    expect(supports).toHaveBeenCalledWith('translate', '0px');
  });
});
