/**
 * 视口信号源 `useLandscapeViewport` 的接线行为（2026-10-15 iOS 横屏画布消失修复）。
 *
 * 纯读数消毒判据在 `landscape-canvas.test.ts` ④-b；这里只钉**组件接线**：
 *  - 旋转瞬态垃圾 resize ⇒ 画布不塌缩（last-good）；
 *  - 垃圾帧后宿主再无事件 ⇒ 稳定复读定时器自愈（iOS Safari 实测会漏发纠正 resize）；
 *  - `orientationchange`（uni-h5 不派发 ON_RESIZE）也能触发复读；
 *  - 合法 resize 正常更新、竖屏提示层照常切换；卸载成对注销。
 *
 * ⚠️ jsdom 不模拟 env() / 真实旋转时序 —— 真机路径由 CDP Apple 旋转序列探针回归
 * （`.tmp-gen/h5-apple-rotation-probe.mjs`，取证物不入库）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import LandscapeStage from '../src/components/LandscapeStage.vue';
import {
  setWindowSize,
  windowResizeHandlers,
  windowSize,
  type UniStub,
} from './helpers/uni-stub';

let wrapper: VueWrapper | null = null;

function canvasStyle(): string {
  return wrapper!.find('.canvas').attributes('style') ?? '';
}

describe('useLandscapeViewport：旋转瞬态防线', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWindowSize(866, 390);
    wrapper = mount(LandscapeStage);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it('正常横屏首帧：画布按 866×390 排版（k=0.52）', () => {
    expect(canvasStyle()).toContain('scale(0.52)');
  });

  it('垃圾 resize（866×1）⇒ 保留上一个好读数，画布绝不塌缩', async () => {
    const before = canvasStyle();
    setWindowSize(866, 1); // 真机：Safari 工具栏动画帧，且之后可能再无纠正事件
    await nextTick();
    expect(canvasStyle()).toBe(before);
    expect(canvasStyle()).toContain('scale(0.52)');
  });

  it('垃圾帧后宿主漏发纠正事件 ⇒ 900ms 内的稳定复读自行拿到稳定视口并恢复排版', async () => {
    setWindowSize(866, 1);
    await nextTick();
    // 视口实际已稳定，但**没有新 resize 事件**（只改替身状态，模拟 iOS 漏发）
    windowSize.w = 736;
    windowSize.h = 414;
    expect(canvasStyle()).toContain('scale(0.52)'); // 复读前仍是旧读数

    vi.advanceTimersByTime(1000);
    await nextTick();

    // 736×414：宽度受约束，k=736/1334=0.5517
    expect(canvasStyle()).toContain('0.5517');
  });

  it('orientationchange 本身不携带尺寸，但会触发稳定复读（补 uni-h5 不派发 ON_RESIZE 的缺口）', async () => {
    setWindowSize(866, 1);
    await nextTick();
    windowSize.w = 736;
    windowSize.h = 414;
    window.dispatchEvent(new Event('orientationchange'));
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(canvasStyle()).toContain('0.5517');
  });

  it('合法 resize 正常生效（消毒不误伤真实变化）', async () => {
    setWindowSize(736, 414);
    await nextTick();
    expect(canvasStyle()).toContain('0.5517');
  });

  it('竖屏 ⇒ 旋转提示层；转回横屏 ⇒ 画布恢复', async () => {
    setWindowSize(390, 844);
    await nextTick();
    expect(wrapper!.find('.stage__rotate').exists()).toBe(true);
    setWindowSize(844, 390);
    await nextTick();
    expect(wrapper!.find('.canvas').exists()).toBe(true);
  });

  it('卸载：uni on/offWindowResize 成对注销，且卸载后回调不再触发排版', () => {
    const stub = uni as unknown as UniStub;
    const onCount = stub.calls.windowResize.on;
    const offBefore = stub.calls.windowResize.off;
    const handlersBefore = windowResizeHandlers.size;
    expect(handlersBefore).toBeGreaterThanOrEqual(1);

    wrapper!.unmount();
    wrapper = null; // afterEach 不重复卸载

    expect(stub.calls.windowResize.on).toBe(onCount);
    expect(stub.calls.windowResize.off).toBe(offBefore + 1);
    expect(windowResizeHandlers.size).toBe(handlersBefore - 1);
  });
});
