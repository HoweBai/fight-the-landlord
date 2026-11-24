import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { FakeSocket } from './helpers/fake-socket';

const flat = (text: string) => text.replace(/\s+/g, ' ');

const rules = {
  ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES),
  fanCap: 5,
  fanTable: {
    ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES).fanTable,
    longQiDui: 0,
  },
  optionalFans: {
    ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES).optionalFans,
    perGang: 1,
  },
};

const CONFIG = {
  code: 0,
  data: {
    baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 3,
    games: {
      doudizhu: {
        enabled: true, supportedPlayerCounts: [3], defaultPlayerCount: 3,
        baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
        freeRoomEnabled: true, goldRoomEnabled: false, friendRoomEnabled: false,
        entryMultiplier: 10,
      },
      mahjong: {
        enabled: true, supportedPlayerCounts: [4], defaultPlayerCount: 4,
        baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
        freeRoomEnabled: true, goldRoomEnabled: false, friendRoomEnabled: false,
        entryMultiplier: 10,
        mahjongRules: rules,
      },
    },
  },
};

function stubFetch(body: unknown) {
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

describe('麻将规则介绍动态文案', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    clientConfig.token = 't';
  });
  afterEach(() => {
    stopGameSession();
    clearSession();
    vi.unstubAllGlobals();
  });

  it('点麻将 info ⇒ 显示当前配置的番型/倍率/流程', async () => {
    const sockets: FakeSocket[] = [];
    startGameSession(() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    const calls = stubFetch(CONFIG);
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    const cards = wrapper.findAll('.lobby__mode');
    const mahjongCard = cards.find((c) => flat(c.text()).includes('四川麻将'));
    expect(mahjongCard, '麻将玩法卡可见').toBeTruthy();
    const wrap = mahjongCard!.element.parentElement!;
    const info = wrap.querySelector('.lobby__mode-info') as HTMLElement;
    const beforeMode = useGameStore().activeMode;
    const beforeCalls = calls.filter((u) => u.includes('/config')).length;

    info.click();
    await flushPromises();

    const body = flat(wrapper.find('.lobby__rule-body').text());
    expect(body).toContain('番型与倍率');
    expect(body).toContain('封顶 5 番（×16）');
    expect(body).toContain('每杠 +1 番');
    expect(body).toMatch(/未启用：.*龙七对/);
    expect(body).toContain('当前流程设置');
    expect(body).not.toContain('默认封顶 6 番');
    expect(useGameStore().activeMode, '点 info 不得切换玩法').toBe(beforeMode);
    expect(calls.filter((u) => u.includes('/config')).length, '点开触发一次配置刷新')
      .toBe(beforeCalls + 1);
  });

  it('无 mahjongRules ⇒ 回退静态默认文案', async () => {
    const noRules = JSON.parse(JSON.stringify(CONFIG));
    delete noRules.data.games.mahjong.mahjongRules;
    const sockets: FakeSocket[] = [];
    startGameSession(() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    stubFetch(noRules);
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    const cards = wrapper.findAll('.lobby__mode');
    const mahjongCard = cards.find((c) => flat(c.text()).includes('四川麻将'))!;
    const info = mahjongCard.element.parentElement!.querySelector(
      '.lobby__mode-info',
    ) as HTMLElement;
    info.click();
    await flushPromises();

    const body = flat(wrapper.find('.lobby__rule-body').text());
    expect(body).toContain('默认封顶 6 番');
    expect(body).toContain('默认口径');
    expect(body).not.toContain('番型与倍率');
  });
});
