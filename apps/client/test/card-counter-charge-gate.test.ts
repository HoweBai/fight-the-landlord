/**
 * 记牌器收费片 T13：牌桌统一判定表与状态消息（规格 §2.7；C35/C36）。
 *
 * 判定表：总开关关 ⇒ 不渲染；本房有状态 ⇒ active；无状态 + 价格键缺省（旧服务端）
 * ⇒ 回退总开关；无状态 + 两价格均为数值（新服务端）⇒ fail-closed。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import { useGameStore } from '../src/stores/game';
import { FAILSAFE_CLIENT_CONFIG } from '../src/composables/useClientConfig';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { FakeSocket, serverMessage } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
let socket: FakeSocket;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  socket = new FakeSocket();
  startGameSession(() => socket);
});

afterEach(() => {
  stopGameSession();
  clearSession();
});

function setupStore(over: {
  enabled?: boolean;
  perGame?: number | null;
  perHour?: number | null;
  roomCode?: string;
} = {}) {
  const store = useGameStore();
  store.cardCounterEnabled = over.enabled ?? true;
  store.cardCounterPricePerGameCoins = over.perGame === undefined ? 10 : over.perGame;
  store.cardCounterPricePerHourCoins = over.perHour === undefined ? 100 : over.perHour;
  store.setRoom(over.roomCode ?? 'ROOM1', 0);
  return store;
}

function mountTable(): VueWrapper {
  return mount(TablePage, { global: { plugins: [pinia] } });
}

async function pushStatus(
  wrapper: VueWrapper,
  payload: { roomCode: string; active: boolean; source?: string },
) {
  socket.push(serverMessage('game.card_counter', payload as never, 0));
  await flushPromises();
  await wrapper.vm.$nextTick();
}

describe('牌桌记牌器判定表（收费态）', () => {
  it('总开关关 ⇒ 不渲染（任何状态）', async () => {
    setupStore({ enabled: false });
    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM1', active: true });
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    wrapper.unmount();
  });

  /**
   * P1-10：`GET /api/config` 失败时 lobby 写 FAILSAFE（`cardCounterEnabled=false`）——
   * 那是「未知」而不是「服务端说关」。本房 `game.card_counter{active}` 是服务端权益事实，
   * 已付费玩家不得因一次配置失败被隐藏记牌器。
   */
  it('P1-10：配置拉取失败（FAILSAFE）+ 本房 status active ⇒ 记牌器仍渲染', async () => {
    const store = useGameStore();
    // 与 lobby 失败路径同形：先写 FAILSAFE，再打「未知」标记。
    store.setClientConfig(FAILSAFE_CLIENT_CONFIG);
    store.markClientConfigFailsafe();
    store.setRoom('ROOM1', 0);

    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM1', active: true, source: 'credit' });

    expect(wrapper.find('.counter').exists()).toBe(true);
    wrapper.unmount();
  });

  it('P1-10 负对照：服务端明确关（非 FAILSAFE）⇒ status active 也不渲染', async () => {
    setupStore({ enabled: false }); // setClientConfig 之外的直写 = 已拿到服务端配置的形态
    useGameStore().setClientConfig({
      ...FAILSAFE_CLIENT_CONFIG,
      baseScoreLevels: [],
      cardCounterEnabled: false,
    });
    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM1', active: true });
    expect(wrapper.find('.counter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('新服务端（两价格均数值）+ 无本房状态 ⇒ fail-closed（不渲染）', async () => {
    setupStore();
    const wrapper = mountTable();
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('旧服务端（价格键 null）+ 无状态 ⇒ 回退总开关（横条直接显示）', async () => {
    setupStore({ perGame: null, perHour: null });
    const wrapper = mountTable();
    expect(wrapper.find('.counter').exists()).toBe(true);
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('本房状态 active=true ⇒ 按钮隐藏、横条自动展示；active=false 到达 ⇒ 入口与横条同时消失', async () => {
    setupStore();
    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM1', active: true, source: 'credit' });

    // 有真实权益（active=true）⇒ 自动展示横条、隐藏按钮
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    expect(wrapper.find('.counter').exists()).toBe(true);

    await pushStatus(wrapper, { roomCode: 'ROOM1', active: false, source: 'none' });
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    expect(wrapper.find('.counter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('状态按 roomCode：别房状态不生效', async () => {
    setupStore({ roomCode: 'ROOM1' });
    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM2', active: true });
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('消息处理器落 store；reset 清空', async () => {
    const store = setupStore();
    const wrapper = mountTable();
    await pushStatus(wrapper, { roomCode: 'ROOM1', active: true, source: 'pass' });
    expect(store.cardCounterStatus).toEqual({
      roomCode: 'ROOM1',
      active: true,
      source: 'pass',
    });
    store.reset();
    expect(store.cardCounterStatus).toBeNull();
    wrapper.unmount();
  });
});
