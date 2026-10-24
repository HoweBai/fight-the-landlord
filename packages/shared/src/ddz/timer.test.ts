import { describe, it, expect } from 'vitest';
import { createBidTimer, createPlayTimer, randomDelay } from './timer';

describe('createBidTimer', () => {
  it('returns a timer handle with clear method', () => {
    const handle = createBidTimer(() => {}, 5000);
    expect(handle.clear).toBeDefined();
    expect(typeof handle.clear).toBe('function');
  });
});

describe('createPlayTimer', () => {
  it('returns a timer handle with clear method', () => {
    const handle = createPlayTimer(() => {}, 10000);
    expect(handle.clear).toBeDefined();
    expect(typeof handle.clear).toBe('function');
  });
});

describe('randomDelay', () => {
  it('returns a promise', async () => {
    const result = randomDelay(100, 200);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('delays for a random time within range', async () => {
    const start = Date.now();
    await randomDelay(100, 150);
    const elapsed = Date.now() - start;
    /**
     * ⚠️ Node 的 `setTimeout` **不保证不早触发**（并发跑门禁时实测早 1–3ms），`Date.now()` 也非单调。
     * 这里要钉的是「确实等了一段量级正确的时间」，不是毫秒精度 —— 因此下界留 20ms 容差。
     * 上界保持 250ms：它要抓的是「`randomDelay` 的上界参数真的生效」（min=100/max=150 ⇒ 实际 ≤149ms）。
     * 与切片 7 前端 `reconnect-flow.test.ts` 的 R59 修正同型。
     */
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThanOrEqual(250); // Allow some buffer
  });
});
