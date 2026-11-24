import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import {
  FAILSAFE_CLIENT_CONFIG,
  normalizeClientConfig,
} from '../src/composables/useClientConfig';
import { useGameStore } from '../src/stores/game';

const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);

describe('mahjongRules store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('normalize 从 games.mahjong.mahjongRules 取值', () => {
    const cfg = normalizeClientConfig({
      games: { mahjong: { mahjongRules: view } },
    } as never);
    expect(cfg.mahjongRules).toEqual(view);
  });

  it('normalize 坏形状 ⇒ null', () => {
    const cfg = normalizeClientConfig({
      games: { mahjong: { mahjongRules: { scoringPolicy: 'named' } } },
    } as never);
    expect(cfg.mahjongRules).toBeNull();
  });

  it('setClientConfig 写入；缺失时保留旧值', () => {
    const store = useGameStore();
    store.setClientConfig({
      ...FAILSAFE_CLIENT_CONFIG,
      mahjongRules: view,
    });
    expect(store.mahjongRules).toEqual(view);
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, mahjongRules: null });
    expect(store.mahjongRules).toEqual(view);
  });

  it('setMahjongRules 只改这一个字段', () => {
    const store = useGameStore();
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, version: 3 });
    store.setMahjongRules(view);
    expect(store.mahjongRules).toEqual(view);
    expect(store.clientConfigVersion).toBe(3);
  });
});
