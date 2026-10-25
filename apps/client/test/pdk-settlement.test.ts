import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import PdkSettlement from '../src/components/PdkSettlement.vue';
import { useGameStore } from '../src/stores/game';

/**
 * S6.2：跑得快结算面板（只渲染服务端字段：名次/剩余/倍数/炸弹/关牌/春天/分差）。
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

  it('绶带标题带 + headline + 公式行 齐备', () => {
    const store = useGameStore();
    store.mySeat = 1;
    const wrapper = mount(PdkSettlement, { props: { settlement: result() } });

    // 绶带
    expect(wrapper.find('.pdk-settlement__ribbon').exists()).toBe(true);
    expect(wrapper.text()).toContain('结算');

    // headline：我是 seat=1，不在 winnerSeats=[0]，所以"你输了 -60"
    expect(wrapper.find('.pdk-settlement__headline').exists()).toBe(true);
    expect(wrapper.text()).toContain('你输了');
    expect(wrapper.text()).toContain('-60');

    // 公式行
    expect(wrapper.find('.pdk-settlement__formula').exists()).toBe(true);
    expect(wrapper.text()).toContain('底分 15');
    expect(wrapper.text()).toContain('倍数 2');
    expect(wrapper.text()).toContain('炸弹 1');
    expect(wrapper.text()).toContain('关牌');
    expect(wrapper.text()).not.toContain('春天');
    expect(wrapper.text()).not.toContain('保本');

    wrapper.unmount();
  });

  it('三行表格 + 我的行高亮 + 胜者名金色', () => {
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
    expect(wrapper.find('.pdk-settlement__row--me').exists()).toBe(true);
    expect(wrapper.text()).toContain('第 1 名');
    expect(wrapper.text()).toContain('4 张');
    expect(wrapper.text()).toContain('-60');

    wrapper.unmount();
  });

  it('headline：我在胜方 → "你赢了 +90"', () => {
    const store = useGameStore();
    store.mySeat = 0; // 胜者
    const wrapper = mount(PdkSettlement, { props: { settlement: result() } });

    expect(wrapper.text()).toContain('你赢了');
    expect(wrapper.text()).toContain('+90');

    wrapper.unmount();
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
    plain.unmount();
    gold.unmount();
  });

  it('再来一局 / 返回大厅上抛', async () => {
    const wrapper = mount(PdkSettlement, { props: { settlement: result() } });
    await wrapper.find('.pdk-settlement__again').trigger('click');
    await wrapper.find('.pdk-settlement__lobby').trigger('click');
    expect(wrapper.emitted('again')).toHaveLength(1);
    expect(wrapper.emitted('back')).toHaveLength(1);
    wrapper.unmount();
  });
});
