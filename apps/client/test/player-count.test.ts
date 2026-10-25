import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ClientGameConfig } from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';
import { CLIENT_TABLE_PLAYER_COUNTS } from '../src/gameModes';

/**
 * 跑得快 2 人场：客户端能力表与服务端 `supportedPlayerCounts` 取交集。
 * 判据：4 人即使服务端开放也不展示（客户端尚未实现 4 人牌桌）。
 */
function pdkConfig(counts: number[]): ClientGameConfig {
  return {
    enabled: true,
    supportedPlayerCounts: counts,
    defaultPlayerCount: 3,
    baseScoreLevels: [{ name: '休闲场', baseScore: 15, entryFeePercent: 0 }],
    freeRoomEnabled: true,
    goldRoomEnabled: true,
    friendRoomEnabled: false,
    entryMultiplier: 10,
  };
}

function baseConfig(games?: Record<string, ClientGameConfig>) {
  return {
    baseScoreLevels: [],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    reliefAdpid: '',
    entryMultiplier: 10,
    rechargeEnabled: false,
    withdrawEnabled: false,
    coinPerYuan: null,
    rechargePackages: [],
    withdrawMinCoins: null,
    withdrawMaxCoinsPerOrder: null,
    withdrawDailyMaxCoins: null,
    withdrawReAuthEnabled: false,
    version: 1,
    ...(games ? { games } : {}),
  };
}

describe('跑得快 2/3/4 人场：客户端人数能力', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('能力表：斗地主恒 3；跑得快实现 2/3/4', () => {
    expect(CLIENT_TABLE_PLAYER_COUNTS.doudizhu).toEqual([3]);
    expect(CLIENT_TABLE_PLAYER_COUNTS.paodekuai).toEqual([2, 3, 4]);
  });

  it('activePlayerCounts 与服务端取交集', () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');

    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([3]) }));
    expect(store.activePlayerCounts).toEqual([3]);

    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([2, 3, 4]) }));
    expect(store.activePlayerCounts).toEqual([2, 3, 4]);

    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([3, 4]) }));
    expect(store.activePlayerCounts).toEqual([3, 4]);

    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([2, 3]) }));
    expect(store.activePlayerCounts).toEqual([2, 3]);
  });

  it('旧服务端无 games ⇒ 只有 3 人', () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(baseConfig());
    expect(store.activePlayerCounts).toEqual([3]);
  });

  it('effectivePlayerCount：默认 3；选 4 生效；配置收回 4 ⇒ 回落 3；交集外拒绝写入', () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([2, 3, 4]) }));
    expect(store.effectivePlayerCount).toBe(3);

    store.setSelectedPlayerCount(4);
    expect(store.effectivePlayerCount).toBe(4);

    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([2, 3]) }));
    expect(store.effectivePlayerCount, '闸收回后自动回落').toBe(3);

    store.setSelectedPlayerCount(2);
    expect(store.selectedPlayerCount).toBe(2);
    store.setSelectedPlayerCount(4);
    expect(store.selectedPlayerCount, '4 不在交集内 ⇒ 拒绝写入').toBe(2);
  });

  it('斗地主恒 3：切回斗地主后选择值不生效', () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(baseConfig({ paodekuai: pdkConfig([2, 3, 4]) }));
    store.setSelectedPlayerCount(4);
    expect(store.effectivePlayerCount).toBe(4);

    store.setActiveMode('doudizhu');
    expect(store.activePlayerCounts).toEqual([3]);
    expect(store.effectivePlayerCount).toBe(3);
  });
});
