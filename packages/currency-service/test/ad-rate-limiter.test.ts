/**
 * 广告片 T11：`AdRateLimiter` —— **克隆** `payment-service/src/notify/notify.controller.ts:92-143`
 * 的 `NotifyRateLimiter`（规格 §2.4 ④：键 `ad:notify:rate`、60s、>600 拒、**fail-open + WARN**）。
 *
 * 覆盖面：
 *  ① 常量逐字（键 / 600·60s）；
 *  ② INCR + **首次 EXPIRE**（固定窗不由后续请求顺延）与超桶边界（600 放行 / 601 拒）；
 *  ③ Redis 故障（INCR 抛）⇒ **fail-open 放行 + 响亮 WARN**（不崩、不拒真回调）；
 *  ④ 连接面源码级判据（专用实例 + `maxRetriesPerRequest:1` / `enableOfflineQueue:false`
 *     的快速失败选项——故障即 fail-open，不堆重试队列）+ 模块注册面。
 *
 * ⚠️ `mock.calls` 必须在 `mockRestore()` **之前**读（vitest 的 restore 会连记录一起清）。
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AD_NOTIFY_RATE_KEY, AD_NOTIFY_RATE_LIMIT, AdRateLimiter } from '../src/ads/ad-rate-limiter';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const LIMITER_SRC = readFileSync(join(PACKAGE_DIR, 'src/ads/ad-rate-limiter.ts'), 'utf-8');

describe('AdRateLimiter：INCR+EXPIRE 单桶与 fail-open（克隆 pay NotifyRateLimiter）', () => {
  function makeLimiter(incrSequence: number[], failWith?: Error) {
    const calls = { incr: 0, expire: 0 };
    const fakeRedis = {
      incr: async (): Promise<number> => {
        calls.incr += 1;
        if (failWith) throw failWith;
        return incrSequence[Math.min(calls.incr - 1, incrSequence.length - 1)]!;
      },
      expire: async (): Promise<number> => {
        calls.expire += 1;
        if (failWith) throw failWith;
        return 1;
      },
      on: () => undefined,
    };
    const limiter = new AdRateLimiter((() => fakeRedis) as never);
    return { limiter, calls, fakeRedis };
  }

  it('常量逐字：键 `ad:notify:rate` · 600/分', () => {
    expect(AD_NOTIFY_RATE_KEY).toBe('ad:notify:rate');
    expect(AD_NOTIFY_RATE_LIMIT).toEqual({ max: 600, windowSeconds: 60 });
  });

  it('600 ⇒ 放行；601 ⇒ 超桶；EXPIRE 只在首次 INCR 后设置（固定窗口，不被顺延）', async () => {
    const { limiter, calls } = makeLimiter([1, 2, 600, 601]);
    expect(await limiter.exceeded()).toBe(false); // 1 ⇒ 同时 EXPIRE
    expect(calls.expire).toBe(1);
    expect(await limiter.exceeded()).toBe(false); // 2 ⇒ 不 EXPIRE
    expect(await limiter.exceeded()).toBe(false); // 600 = 达界内（>600 才拒）
    expect(calls.expire).toBe(1);
    expect(await limiter.exceeded()).toBe(true); // 601 ⇒ 429 面
    expect(calls.expire).toBe(1);
  });

  it('Redis 故障（INCR 抛）⇒ **fail-open 放行** + 响亮 WARN（不崩、不拒真回调）', async () => {
    const { limiter } = makeLimiter([1], new Error('ECONNREFUSED 10.0.0.9:6379'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let observed = false;
    try {
      expect(await limiter.exceeded()).toBe(false);
      observed = warn.mock.calls.some((args) => String(args[0]).includes('fail-open'));
    } finally {
      warn.mockRestore();
    }
    expect(observed).toBe(true);
  });

  it('连接面源码级判据：专用实例 + 快速失败选项（maxRetriesPerRequest:1 · enableOfflineQueue:false）', () => {
    // 故障时立刻走 fail-open —— 不蹭配置订阅连接、不堆重试队列（克隆注释同源）。
    expect(LIMITER_SRC).toMatch(/maxRetriesPerRequest:\s*1/);
    expect(LIMITER_SRC).toMatch(/enableOfflineQueue:\s*false/);
  });

  it('模块注册面：AdRateLimiter ∈ AppModule.providers（未注册 = 真容器解析注入即崩）', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(AdRateLimiter);
  });
});
