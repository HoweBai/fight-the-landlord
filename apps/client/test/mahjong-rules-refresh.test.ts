import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  DEFAULT_SBR_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import { clientConfig } from '../src/config';
import { refreshMahjongRules } from '../src/composables/useClientConfig';
import { useGameStore } from '../src/stores/game';

const chengdu = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
const sbr = mahjongRulesClientView(DEFAULT_SBR_RULES);

function stubConfig(body: unknown) {
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

const okBody = (rules: unknown) => ({
  code: 0,
  data: { version: 7, games: { mahjong: { mahjongRules: rules } } },
});

describe('refreshMahjongRules', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clientConfig.token = 't';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('成功 ⇒ 只更新 mahjongRules，不改 activeMode/roomMode/底分', async () => {
    const store = useGameStore();
    store.setActiveMode('doudizhu');
    store.setSelectedBaseScore(15);
    const beforeMode = store.activeMode;
    const beforeRoom = store.roomMode;
    const beforeScore = store.selectedBaseScore;
    stubConfig(okBody(sbr));
    expect(await refreshMahjongRules()).toBe(true);
    expect(store.mahjongRules).toEqual(sbr);
    expect(store.activeMode).toBe(beforeMode);
    expect(store.roomMode).toBe(beforeRoom);
    expect(store.selectedBaseScore).toBe(beforeScore);
  });

  it('并发调用单飞：只发一次请求', async () => {
    const { mock } = stubConfig(okBody(chengdu));
    const [a, b] = await Promise.all([refreshMahjongRules(), refreshMahjongRules()]);
    expect([a, b]).toEqual([true, true]);
    expect(mock.mock.calls.length).toBe(1);
  });

  it('响应缺 mahjongRules ⇒ 保留旧值', async () => {
    const store = useGameStore();
    store.setMahjongRules(chengdu);
    stubConfig({ code: 0, data: { version: 8, games: { mahjong: {} } } });
    expect(await refreshMahjongRules()).toBe(false);
    expect(store.mahjongRules).toEqual(chengdu);
  });

  it('坏值 ⇒ 保留旧值', async () => {
    const store = useGameStore();
    store.setMahjongRules(chengdu);
    stubConfig(okBody({ scoringPolicy: 'named' }));
    expect(await refreshMahjongRules()).toBe(false);
    expect(store.mahjongRules).toEqual(chengdu);
  });
});
