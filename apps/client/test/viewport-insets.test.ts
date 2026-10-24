/**
 * 窗口读数与**安全区补充**（2026-10-13 真机走查「跨设备裁剪」修复）。
 *
 * ## 背景（先读这条，否则看不懂为什么要合并两个来源）
 *
 * uni 的 `getSystemInfoSync().safeArea` 在 **Android 上被运行时硬零化** ——
 * `@dcloudio/uni-app-plus/dist/uni.runtime.esm.js` 的 `getWindowInfo()` 逐字写着：
 *
 * ```js
 * safeAreaInsets = ios ? safeAreaInsets : { left: 0, right: 0,
 *   top: titleNView.height && !titleNView.cover ? 0 : statusBarHeight, bottom: 0 };
 * ```
 *
 * ⇒ 横屏时**刘海/挖孔在侧边**（left/right）与**手势条在底部**（bottom）在 Android 上
 * **零保护**：画布铺到物理边，边缘内容（「返回大厅」/玩家条）压在挖孔/圆角/手势条下
 * ⇒ 真机走查「内容被裁剪（底部/边缘被切）」。
 *
 * 修复 = 在 App 平台再读一次**运行时自己先读的那个原始 API**
 * （`plus.navigator.getSafeAreaInsets()`，见同一函数的 `webview.getSafeAreaInsets()` /
 * `plus.navigator.getSafeAreaInsets()` 两处调用），**逐边取 max 合并**。
 *
 * ⚠️ **未验事项（如实）**：plus 读数在**真机刘海屏**上的具体数值在本机模拟器上
 * 无法产生（无刘海 ⇒ 全 0）；本文件的判据证明的是**合并/钳制逻辑**，
 * 不是「真机上 plus 一定给出正确 inset」。真机验证列在交接清单。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installUniStub, setWindowSize, triggerAppShow, windowSize, type UniStub } from './helpers/uni-stub';
import { readViewport } from '../src/composables/useLandscapeCanvas';
import LandscapeStage from '../src/components/LandscapeStage.vue';

/** 造一个 `plus` 全局替身（模拟 App 平台的 HTML5+ 环境）。 */
function installPlus(getSafeAreaInsets: () => unknown): void {
  (globalThis as { plus?: unknown }).plus = {
    navigator: { getSafeAreaInsets },
  };
}

let stub: UniStub;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  stub = installUniStub();
  windowSize.w = 858;
  windowSize.h = 390;
  // 默认无 plus（H5/小程序形态）—— 需要 plus 的用例自己装。
  delete (globalThis as { plus?: unknown }).plus;
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  delete (globalThis as { plus?: unknown }).plus;
});

describe('readViewport：安全区来源合并（Android 硬零化的左/右/下补上）', () => {
  it('uni 安全区坐标 → inset 换算（既有语义，不回退）：right/bottom 是「视口 − 坐标」', () => {
    // 刘海在左（left=44）、状态栏 28、手势条 24 —— 全部由 uni 提供（iOS 形态）。
    stub.getSystemInfoSync = () => ({
      uniPlatform: 'ios',
      windowWidth: 858,
      windowHeight: 390,
      safeArea: { left: 44, top: 28, right: 858, bottom: 366 },
    });
    expect(readViewport()).toEqual({
      w: 858,
      h: 390,
      insets: { top: 28, right: 0, bottom: 24, left: 44 },
    });
  });

  it('无 plus（H5/小程序）⇒ 与既有行为逐字一致：无 safeArea 即全 0', () => {
    stub.getSystemInfoSync = () => ({ uniPlatform: 'web', windowWidth: 858, windowHeight: 390 });
    expect(readViewport()).toEqual({
      w: 858,
      h: 390,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  });

  it('Android 形态：uni 全屏 safeArea（硬零化）+ plus 真读数 ⇒ 补上左/右/下', () => {
    // 模拟器探针实测的 Android 形态：uni 只给 top=状态栏高，left/right/bottom 全 0；
    // 刘海侧（left）与手势条（bottom）只能靠 plus 读数补。
    stub.getSystemInfoSync = () => ({
      uniPlatform: 'app',
      windowWidth: 858,
      windowHeight: 390,
      safeArea: { left: 0, top: 28, right: 858, bottom: 390 },
    });
    installPlus(() => ({ top: 28, right: 0, bottom: 24, left: 44 }));
    expect(readViewport()).toEqual({
      w: 858,
      h: 390,
      insets: { top: 28, right: 0, bottom: 24, left: 44 },
    });
  });

  it('逐边取 max：uni 已有的读数不被 plus 改小（谁大听谁）', () => {
    stub.getSystemInfoSync = () => ({
      uniPlatform: 'app',
      windowWidth: 858,
      windowHeight: 390,
      safeArea: { left: 44, top: 28, right: 858, bottom: 390 },
    });
    installPlus(() => ({ top: 12, right: 0, bottom: 24, left: 20 }));
    expect(readViewport()).toEqual({
      w: 858,
      h: 390,
      insets: { top: 28, right: 0, bottom: 24, left: 44 },
    });
  });

  it('plus 异常读数一律丢弃（抛错 / 非数 / 负数 / 超界 / 缺对象）⇒ 回落 0，不抛', () => {
    stub.getSystemInfoSync = () => ({
      uniPlatform: 'app',
      windowWidth: 858,
      windowHeight: 390,
      safeArea: { left: 0, top: 0, right: 858, bottom: 390 },
    });

    // ① 回调抛错
    installPlus(() => {
      throw new Error('plus not ready');
    });
    expect(readViewport().insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });

    // ② 混杂异常值：非数 / 负数 / 超界（200 上限外）全被钳成 0；合法值保留
    installPlus(() => ({ top: 'x', right: -5, bottom: 24, left: 9999 }));
    expect(readViewport().insets).toEqual({ top: 0, right: 0, bottom: 24, left: 0 });

    // ③ plus 存在但 navigator.getSafeAreaInsets 缺失
    (globalThis as { plus?: unknown }).plus = { navigator: {} };
    expect(readViewport().insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('getSystemInfoSync 抛错 ⇒ 零视口兜底不变（plus 读数不改变失败形态）', () => {
    stub.getSystemInfoSync = () => {
      throw new Error('host info unavailable');
    };
    installPlus(() => ({ top: 28, left: 44, right: 0, bottom: 24 }));
    expect(readViewport()).toEqual({
      w: 0,
      h: 0,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  });
});

describe('LandscapeStage：画布重算的两条触发（resize + 回前台）', () => {
  it('窗口变化（既有）与回前台（2026-10-13 修复）都会重算画布；监听成对注销', async () => {
    const wrapper = mount(LandscapeStage);
    mounted.push(wrapper);
    const style = () => wrapper.find('.canvas').attributes('style');

    setWindowSize(1000, 500);
    await wrapper.vm.$nextTick();
    const afterResize = style();
    expect(afterResize, '既有通道：resize 后画布尺寸变化').toContain('width:');

    /**
     * 🔴 修复的判别点：**只改宿主读数、不发 resize 事件**，仅派发回前台 ——
     * 修复前（只注册 onWindowResize）画布纹丝不动（本断言红）；修复后回前台重读。
     */
    windowSize.w = 800;
    windowSize.h = 400;
    triggerAppShow();
    await wrapper.vm.$nextTick();
    expect(style(), '回前台：画布必须按新读数重算（漏发 resize 的兜底）').not.toBe(afterResize);

    wrapper.unmount();
    expect(stub.calls.windowResize.on, '窗口监听注册一次').toBe(1);
    expect(stub.calls.windowResize.off, '窗口监听注销一次（成对，防泄漏）').toBe(1);
    expect(stub.calls.appVisibility.onShow, '前台监听注册一次').toBe(1);
    expect(stub.calls.appVisibility.offShow, '前台监听注销一次（成对，防泄漏）').toBe(1);
  });
});
