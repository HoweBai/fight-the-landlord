import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import PdkSettlement from '../src/components/PdkSettlement.vue';
import { useGameStore } from '../src/stores/game';

/**
 * S6.2：跑得快结算面板（只渲染服务端字段：名次/剩余/倍数/炸弹/关牌/春天/保本/分差）。
 */
const result = (over: Partial<PdkSettlementResult> = {}): PdkSettlementResult => ({
  roomCode: 'PDK1',
  gameType: 'paodekuai',
  playerCount: 3,
  baseScore: 15,
  winnerSeats: [0],
  scoreChanges: [
    { seat: 0, delta: 90 },
    { seat: 1, delta: -60 },
    { seat: 2, delta: -30 },
  ],
  remaining: [0, 4, 2],
  multiplier: 2,
  bombCount: 1,
  guan: true,
  spring: false,
  baobenSeats: [2],
  ...over,
});

describe('S6.2：PdkSettlement', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('渲染三行：名次/剩余张数/分差；关牌与保本标记；倍数与炸弹原样', () => {
    const store = useGameStore();
    store.mySeat = 1;
    const wrapper = mount(PdkSettlement, { props: { settlement: result() } });

    expect(wrapper.findAll('.pdk-settlement__row')).toHaveLength(3);
    expect(wrapper.findAll('.pdk-settlement__row-name').map((n) => n.text())).toEqual([
      '玩家0',
      '我',
      '玩家2',
    ]);
    expect(wrapper.find('.pdk-settlement__row--winner').exists()).toBe(true);
    expect(wrapper.text()).toContain('第 1 名');
    expect(wrapper.text()).toContain('剩余 4 张');
    expect(wrapper.text()).toContain('-60');
    expect(wrapper.text()).toContain('关牌');
    expect(wrapper.text()).toContain('保本');
    expect(wrapper.text()).not.toContain('春天');
    expect(wrapper.text()).toContain('倍数 2');
    expect(wrapper.text()).toContain('炸弹 1');
  });

  it('金币列：结算余额到达 ⇒ 按座位展示；否则整列不渲染', () => {
    const store = useGameStore();
    store.mySeat = 0;
    const plain = mount(PdkSettlement, { props: { settlement: result() } });
    expect(plain.find('.pdk-settlement__gold').exists()).toBe(false);

    store.settlementBalances = { 0: 1000, 1: 940, 2: 910 };
    const gold = mount(PdkSettlement, { props: { settlement: result() } });
    expect(gold.findAll('.pdk-settlement__gold').map((g) => g.text())).toEqual([
      '1000',
      '940',
      '910',
    ]);
  });

  it('再来一局 / 返回大厅上抛', async () => {
    const wrapper = mount(PdkSettlement, { props: { settlement: result() } });
    await wrapper.find('.pdk-settlement__again').trigger('click');
    await wrapper.find('.pdk-settlement__lobby').trigger('click');
    expect(wrapper.emitted('again')).toHaveLength(1);
    expect(wrapper.emitted('back')).toHaveLength(1);
  });
});
