/**
 * 片② D5 / A6：`DouZeroHealth` 可用性探测的**六态** + 5s 缓存。
 *
 * 六态：开关 ON（不探测 ⇒ `true`）· 200 + 三档齐备（`true`）· 200 + 缺档（`models-incomplete`）·
 * 非 200 / 连接被拒（`douzero-unreachable`）· 超时（`douzero-unreachable`）·
 * `models` 缺失 / 非普通对象（fail-open ⇒ `true`）。
 *
 * ─── 片⑦ T8 的改造（E4：真消费者 = 探测门禁）────────────────────────────
 * 开关不再来自 env（`ROBOT_RULE_FALLBACK` 已退役）—— 改注入 `ConfigCacheService` 桩；
 * fetch 与时钟照旧**注入**（单测不真连 DouZero）。三段前提在 fixture 里：
 *  - 缺省 `ruleFallback()` = `true`（种子；「开关 ON」组直接用）；
 *  - 「开关 OFF」组各用例**显式** `mockReturnValue(false)`；
 *  - 补一条**新鲜度**判据：同一实例中途翻转开关 ⇒ 下一次读随动（不是构造时快照）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DouZeroHealth } from '../src/robot/douzero.health';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

const FULL = { sl: ['landlord', 'landlord_down', 'landlord_up'],
               douzero_WP: ['landlord', 'landlord_down', 'landlord_up'],
               douzero_ADP: ['landlord', 'landlord_down', 'landlord_up'] };

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: () => Promise.resolve(body) }) as unknown as Response;

let now: number;
let cache: ConfigCacheStub;
/** 开关 OFF 的探针工厂：`ruleFallback()` 显式返回 false（要走到真探测）。 */
const mkOff = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
  new DouZeroHealth(asConfigCache(cache), impl as unknown as typeof fetch, () => now);

beforeEach(() => {
  now = 1_700_000_000_000;
  cache = makeConfigCache();
  cache.ruleFallback.mockReturnValue(false);
});

describe('DouZeroHealth：可用性探测（片② D5 / A6；片⑦ E4 改读 ConfigCache）', () => {
  it('开关 ON（默认桩）⇒ 恒 true 且不探测', async () => {
    cache.ruleFallback.mockReturnValue(true); // 显式写出来：本用例的前提就是它
    const impl = vi.fn();
    const health = new DouZeroHealth(
      asConfigCache(cache), impl as unknown as typeof fetch, () => now,
    );

    expect(await health.canProvide()).toEqual({ canProvide: true });
    expect(impl).not.toHaveBeenCalled();
    expect(cache.ruleFallback).toHaveBeenCalled(); // 缺口存在时也问过开关
  });

  it('开关是**每次现读**（不是构造时快照）：中途翻转 ⇒ 下一次 canProvide 随动', async () => {
    const impl = vi.fn(async () => jsonResponse({ status: 'ok', models: FULL }));
    const health = new DouZeroHealth(
      asConfigCache(cache), impl as unknown as typeof fetch, () => now,
    );

    // ON：不探测
    cache.ruleFallback.mockReturnValue(true);
    await health.canProvide();
    expect(impl).not.toHaveBeenCalled();

    // 翻到 OFF：下一拍就走探测（若实现把开关缓存在构造期，这里不会探测）
    cache.ruleFallback.mockReturnValue(false);
    await health.canProvide();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('200 + 三档齐备 ⇒ true', async () => {
    const h = mkOff(async () => jsonResponse({ status: 'ok', models: FULL, missing: [] }));
    expect(await h.canProvide()).toEqual({ canProvide: true });
  });

  it('200 + 缺一档 / 某档位置不全 ⇒ false/models-incomplete', async () => {
    for (const models of [
      { sl: FULL.sl, douzero_WP: FULL.douzero_WP },                                    // 缺 ADP
      { ...FULL, douzero_ADP: ['landlord', 'landlord_down'] },                          // 少一个位置
    ]) {
      const h = mkOff(async () => jsonResponse({ status: 'ok', models }));
      expect(await h.canProvide()).toEqual({ canProvide: false, reason: 'models-incomplete' });
    }
  });

  it('非 200 / 连接被拒 ⇒ false/douzero-unreachable', async () => {
    expect(await mkOff(async () => jsonResponse({}, 503)).canProvide())
      .toEqual({ canProvide: false, reason: 'douzero-unreachable' });
    expect(await mkOff(async () => { throw new TypeError('fetch failed'); }).canProvide())
      .toEqual({ canProvide: false, reason: 'douzero-unreachable' });
  });

  it('超时 ⇒ false/douzero-unreachable', async () => {
    // 注入的 fetch 永不 resolve，但把「超时」做成 reject（真实实现用 AbortSignal.timeout）
    const h = mkOff(async () => { throw new DOMException('The operation was aborted.', 'TimeoutError'); });
    expect(await h.canProvide()).toEqual({ canProvide: false, reason: 'douzero-unreachable' });
  });

  it('models 缺失 / 非普通对象（含数组、null）⇒ true（fail-open）', async () => {
    for (const body of [{ status: 'ok', agents: [] }, { status: 'ok', models: [] }, { status: 'ok', models: null }]) {
      const h = mkOff(async () => jsonResponse(body));
      expect(await h.canProvide()).toEqual({ canProvide: true });
    }
  });

  it('5s 内只探一次（缓存）', async () => {
    const impl = vi.fn(async () => jsonResponse({ status: 'ok', models: FULL }));
    const h = mkOff(impl);
    await h.canProvide();
    now += 4_000;
    await h.canProvide();
    expect(impl).toHaveBeenCalledTimes(1);       // 命中缓存
    now += 2_000;                                 // 累计 6s > 5s
    await h.canProvide();
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
