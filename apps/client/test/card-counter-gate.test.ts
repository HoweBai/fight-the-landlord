/**
 * 记牌器开关的 fail-safe 门控（与 friend-room-gate 同族）：
 * 初值 false；配置成功且 true ⇒ true；拉取失败 / 缺键 ⇒ false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

function stubConfig(config: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(url.includes('/config') ? config : { code: 0, data: [] }),
    })),
  );
}

function mountLobby(): VueWrapper {
  startGameSession(() => new FakeSocket());
  useAuthStore().navigate('lobby');
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

const baseConfig = {
  baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
  friendRoomEnabled: false,
  freeRoomEnabled: true,
  goldRoomEnabled: true,
  reliefEnabled: false,
  entryMultiplier: 10,
  rechargeEnabled: false,
  withdrawEnabled: false,
  coinPerYuan: 100,
  rechargePackages: [],
  withdrawMinCoins: 1000,
  withdrawMaxCoinsPerOrder: 50000,
  withdrawDailyMaxCoins: 100000,
  withdrawReAuthEnabled: false,
  reliefAdpid: '',
  version: 5,
};

describe('记牌器开关 fail-safe 门控', () => {
  it('① 初值 = false（未知 = 不渲染）', () => {
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('② 配置成功且 true ⇒ store = true', async () => {
    stubConfig({ code: 0, data: { ...baseConfig, cardCounterEnabled: true } });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(true);
  });

  it('③ 配置成功且 false ⇒ store = false', async () => {
    stubConfig({ code: 0, data: { ...baseConfig, cardCounterEnabled: false } });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('④ 缺键（旧版服务端）⇒ false', async () => {
    stubConfig({ code: 0, data: baseConfig });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('⑤ 拉取失败 ⇒ 保持 false（先置 true 证明失败分支会写回）', async () => {
    stubConfig({ code: 10007, message: '下游不可用', data: null });
    const store = useGameStore();
    store.cardCounterEnabled = true;
    mountLobby();
    await flushPromises();
    expect(store.cardCounterEnabled).toBe(false);
  });
});
