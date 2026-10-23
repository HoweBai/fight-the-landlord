/**
 * 记牌器收费片 T11：共享客户端配置（`useClientConfig`）与 store 两价格字段。
 *
 * 判据：`FAILSAFE_CLIENT_CONFIG`/`normalizeClientConfig` 是**唯一真源**（lobby/game 共用）；
 * 两价格 `number|null`（缺键/旧服务端/非数字 ⇒ null ⇒ 购买面板不渲染）；`reset()` 不清。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  FAILSAFE_CLIENT_CONFIG,
  normalizeClientConfig,
  refreshClientConfig,
} from '../src/composables/useClientConfig';
import { useGameStore } from '../src/stores/game';

describe('useClientConfig（共享加载/归一化）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('FAILSAFE：两价格 null（未知 ⇒ 购买面板不渲染）；开关按既有 fail-safe', () => {
    expect(FAILSAFE_CLIENT_CONFIG.cardCounterPricePerGameCoins).toBeNull();
    expect(FAILSAFE_CLIENT_CONFIG.cardCounterPricePerHourCoins).toBeNull();
    expect(FAILSAFE_CLIENT_CONFIG.cardCounterEnabled).toBe(false);
    expect(FAILSAFE_CLIENT_CONFIG.goldRoomEnabled).toBe(true);
  });

  it('normalize：数值透传；缺键/非数字 ⇒ null；缺键语义不变', () => {
    const cfg = normalizeClientConfig({
      cardCounterPricePerGameCoins: 10,
      cardCounterPricePerHourCoins: 100,
    } as never);
    expect(cfg.cardCounterPricePerGameCoins).toBe(10);
    expect(cfg.cardCounterPricePerHourCoins).toBe(100);
    expect(cfg.freeRoomEnabled).toBe(true);
    expect(cfg.goldRoomEnabled).toBe(true);
    expect(cfg.cardCounterEnabled).toBe(false);

    expect(normalizeClientConfig({} as never).cardCounterPricePerGameCoins).toBeNull();
    expect(normalizeClientConfig({} as never).cardCounterPricePerHourCoins).toBeNull();

    for (const bad of ['10', null, undefined, true, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      const c = normalizeClientConfig({
        cardCounterPricePerGameCoins: bad,
        cardCounterPricePerHourCoins: bad,
      } as never);
      expect(c.cardCounterPricePerGameCoins, `值 ${String(bad)}`).toBeNull();
      expect(c.cardCounterPricePerHourCoins, `值 ${String(bad)}`).toBeNull();
    }
  });

  it('store.setClientConfig：数值落库；省略两价 ⇒ null；reset 不清', () => {
    const store = useGameStore();
    store.setClientConfig({
      ...FAILSAFE_CLIENT_CONFIG,
      cardCounterPricePerGameCoins: 10,
      cardCounterPricePerHourCoins: 100,
    });
    expect(store.cardCounterPricePerGameCoins).toBe(10);
    expect(store.cardCounterPricePerHourCoins).toBe(100);

    store.reset();
    expect(store.cardCounterPricePerGameCoins).toBe(10);
    expect(store.cardCounterPricePerHourCoins).toBe(100);

    const minimal = { ...FAILSAFE_CLIENT_CONFIG } as Record<string, unknown>;
    delete minimal.cardCounterPricePerGameCoins;
    delete minimal.cardCounterPricePerHourCoins;
    store.setClientConfig(minimal as never);
    expect(store.cardCounterPricePerGameCoins).toBeNull();
    expect(store.cardCounterPricePerHourCoins).toBeNull();
  });

  /**
   * P1-12：管理端关闭场次后，`refreshClientConfig`（开始游戏页的价格刷新）也必须像大厅一样
   * 修正 `roomMode` —— 否则客户端会继续发已被关闭的 `mode:'gold'`，必然撞服务端 12010。
   */
  function stubConfig(data: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data }),
      })),
    );
  }

  it('P1-12：roomMode=gold + 刷新到 goldRoomEnabled=false ⇒ 修正为 random', async () => {
    const store = useGameStore();
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, freeRoomEnabled: true, goldRoomEnabled: true });
    store.setRoomMode('gold');
    stubConfig({ baseScoreLevels: [], freeRoomEnabled: true, goldRoomEnabled: false });

    expect(await refreshClientConfig()).toBe(true);

    expect(store.roomMode).toBe('random');
    vi.unstubAllGlobals();
  });

  it('P1-12 负对照：两个场次都关 ⇒ 保持原值（不猜一个入口）', async () => {
    const store = useGameStore();
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, freeRoomEnabled: true, goldRoomEnabled: true });
    store.setRoomMode('gold');
    stubConfig({ baseScoreLevels: [], freeRoomEnabled: false, goldRoomEnabled: false });

    expect(await refreshClientConfig()).toBe(true);

    expect(store.roomMode).toBe('gold');
    vi.unstubAllGlobals();
  });
});
