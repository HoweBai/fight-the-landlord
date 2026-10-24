/**
 * 触感层（震动反馈）契约。
 *
 * ⚠️ **判据射程**：jsdom 里没有震动。这里证明的是「该震的时候调了对应 API、
 * 关了 / 宿主没有时一次都不调、且绝不抛」——不是「真的震到了」（真机走查确认）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installUniStub } from './helpers/uni-stub';
import {
  haptic,
  isHapticsEnabled,
  loadHapticsPrefs,
  setHapticsEnabled,
} from '../src/feedback/haptics';

describe('震动反馈（haptics）', () => {
  beforeEach(() => {
    installUniStub();
    setHapticsEnabled(true);
  });

  it('默认开启：light / medium 走短震，heavy 走长震', () => {
    const stub = installUniStub();
    setHapticsEnabled(true);
    expect(isHapticsEnabled()).toBe(true);

    haptic('light');
    haptic('medium');
    haptic('heavy');

    expect(stub.calls.vibrateShort).toBe(2);
    expect(stub.calls.vibrateLong).toBe(1);
  });

  it('无参调用按 light 处理（短震）', () => {
    const stub = installUniStub();
    haptic();
    expect(stub.calls.vibrateShort).toBe(1);
    expect(stub.calls.vibrateLong).toBe(0);
  });

  it('关闭后一次都不调（但也不抛）', () => {
    const stub = installUniStub();
    setHapticsEnabled(false);
    expect(isHapticsEnabled()).toBe(false);

    haptic('light');
    haptic('heavy');

    expect(stub.calls.vibrateShort).toBe(0);
    expect(stub.calls.vibrateLong).toBe(0);
  });

  it('开关持久化：关掉再重新读回仍是关，未命中按开', () => {
    const stub = installUniStub();
    setHapticsEnabled(false);
    expect(stub.getStorageSync('ftl.haptics.enabled')).toBe('0');

    // 模拟新页面挂载：重新从存储装载
    setHapticsEnabled(true);
    stub.setStorageSync('ftl.haptics.enabled', '0');
    loadHapticsPrefs();
    expect(isHapticsEnabled()).toBe(false);
  });

  it('宿主没有 uni 全局时静默降级，不抛', () => {
    const saved = (globalThis as { uni?: unknown }).uni;
    // @ts-expect-error 故意摘掉宿主，考降级分支
    delete globalThis.uni;
    try {
      expect(() => {
        haptic('heavy');
        loadHapticsPrefs();
        setHapticsEnabled(true);
      }).not.toThrow();
    } finally {
      (globalThis as { uni?: unknown }).uni = saved;
    }
  });
});
