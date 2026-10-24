import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Card } from '@fight-the-landlord/protocol';
import type { PdkRecord } from '../src/net/rest';
import HistoryPage from '../src/pages/history/history.vue';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';
import { installUniStub } from './helpers/uni-stub';

/**
 * S6.3：历史页按玩法切换 + 跑得快战绩展示。
 *
 * 判据：切「跑得快」⇒ 请求带 `gameType=paodekuai`；列表显示 胜/负、剩余张数、倍数、
 * 关牌/春天/保本；展开显示每座 playedCount 与初始手牌；默认仍是斗地主表。
 */
const flat = (t: string) => t.replace(/\s+/g, ' ');

function hand(n: number): Card[] {
  return Array.from({ length: n }, (_, i) => ({ r: 3 + (i % 12), s: i % 5 }));
}

const T0 = new Date(2026, 9, 24, 12, 0).getTime();

function pdkRecord(over: Partial<PdkRecord> = {}): PdkRecord {
  return {
    gameType: 'paodekuai',
    roomCode: 'PDK01',
    playerCount: 3,
    mode: 'random',
    endedAt: T0,
    baseScore: 15,
    winnerSeats: [0],
    remaining: [0, 4, 2],
    multiplier: 2,
    bombCount: 1,
    guan: true,
    spring: false,
    baobenSeats: [2],
    scoreChanges: [
      { seat: 0, delta: 90 },
      { seat: 1, delta: -60 },
      { seat: 2, delta: -30 },
    ],
    mySeat: 1,
    moneyDelta: null,
    players: [
      { seat: 0, nickname: '甲', scoreChange: 90, won: true, playedCount: 16, hand: hand(16) },
      { seat: 1, nickname: null, scoreChange: -60, won: false, playedCount: 12, hand: hand(16) },
      { seat: 2, nickname: null, scoreChange: -30, won: false, playedCount: 14, hand: hand(16) },
    ],
    ...over,
  };
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  installUniStub();
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

function mountHistory() {
  const calls: Array<{ url: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url });
      const body = url.includes('gameType=paodekuai')
        ? { code: 0, data: { items: [pdkRecord()], nextCursor: null } }
        : { code: 0, data: { items: [], nextCursor: null } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }),
  );
  const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

describe('S6.3：历史页跑得快战绩', () => {
  it('默认查斗地主；切「跑得快」⇒ 请求带 gameType=paodekuai 并渲染 pdk 摘要', async () => {
    const { wrapper, calls } = mountHistory();
    await flushPromises();
    expect(calls[0]!.url).toContain('/records/mine');
    expect(calls[0]!.url).not.toContain('gameType=');

    const games = wrapper.findAll('.history__game');
    expect(games.map((g) => flat(g.text()))).toEqual(['斗地主', '跑得快']);
    await games[1]!.trigger('click');
    await flushPromises();

    const pdkCall = calls.at(-1)!;
    expect(pdkCall.url).toContain('gameType=paodekuai');

    const card = wrapper.find('.history__card--pdk');
    expect(card.exists()).toBe(true);
    // winnerSeats=[0]、mySeat=1 ⇒ 我这一局是「负」
    expect(flat(card.text())).toContain('负');
    expect(flat(card.text())).toContain('剩余 4 张');
    expect(flat(card.text())).toContain('倍数 2');
  });

  it('展开：每座 playedCount / 剩余张数与初始手牌（复用 Hand）', async () => {
    const { wrapper } = mountHistory();
    await flushPromises();
    await wrapper.findAll('.history__game')[1]!.trigger('click');
    await flushPromises();

    await wrapper.find('.history__card--pdk .history__summary').trigger('click');
    await flushPromises();
    const detail = wrapper.find('.history__card--pdk .history__detail');
    expect(detail.exists()).toBe(true);
    expect(flat(detail.text())).toContain('出牌 12 张');
    expect(flat(detail.text())).toContain('剩余 2 张');
    expect(flat(detail.text())).toContain('炸弹 1');
    expect(flat(detail.text())).toContain('关牌');
    expect(flat(detail.text())).toContain('保本');
    // 三名玩家的初始手牌（16 张 × 3）全部通过 Hand 渲染
    expect(detail.findAll('.hand')).toHaveLength(3);
  });

  it('切回斗地主 ⇒ 列表回到斗地主数据源、请求不带 gameType', async () => {
    const { wrapper, calls } = mountHistory();
    await flushPromises();
    await wrapper.findAll('.history__game')[1]!.trigger('click');
    await flushPromises();
    await wrapper.findAll('.history__game')[0]!.trigger('click');
    await flushPromises();

    expect(calls.at(-1)!.url).not.toContain('gameType=');
    expect(wrapper.find('.history__card--pdk').exists()).toBe(false);
  });
});
