/**
 * 项 1：前后台切换恢复。
 *
 * 两层判据：
 *  A. composable 本身：uni 信号边沿、双轨去重（uni + document）、注销成对；
 *  B. table 接线：回前台在「对局中 + 链路通」时补一次 game.resync，
 *     断链 / 非对局态 / 节流窗内 / 卸载后均不发。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { startAppVisibility } from '../src/composables/useAppVisibility';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { triggerAppHide, triggerAppShow, type UniStub } from './helpers/uni-stub';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

function mountTable() {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

/** 推进到「对局中且已有快照」态（回前台补快照的唯一合法场景）。 */
async function enterPlaying(wrapper: VueWrapper, socket: FakeSocket): Promise<void> {
  socket.push(
    serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
  );
  await wrapper.vm.$nextTick();
}

describe('A. useAppVisibility 信号本身', () => {
  it('初值前台；hide→show 的 false→true 边沿才触发回调', () => {
    const vis = startAppVisibility();
    const shows: number[] = [];
    vis.onShow(() => shows.push(Date.now()));

    expect(vis.visible.value).toBe(true);

    // 停在前台时重复 show（双轨常见形态）：不是边沿，不触发
    triggerAppShow();
    triggerAppShow();
    expect(shows).toHaveLength(0);

    triggerAppHide();
    expect(vis.visible.value).toBe(false);
    triggerAppShow();
    expect(vis.visible.value).toBe(true);
    expect(shows).toHaveLength(1);

    vis.stop();
  });

  it('uni 信号与 document visibilitychange 双发同一次回前台，只触发一次', () => {
    const vis = startAppVisibility();
    let count = 0;
    vis.onShow(() => (count += 1));

    triggerAppHide();
    // 回前台瞬间两条通道都派发
    triggerAppShow();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(count).toBe(1);

    vis.stop();
    delete (document as { hidden?: boolean }).hidden;
  });

  it('只走 H5 document 通道也能识别前后台', () => {
    const vis = startAppVisibility();
    let count = 0;
    vis.onShow(() => (count += 1));

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vis.visible.value).toBe(false);

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vis.visible.value).toBe(true);
    expect(count).toBe(1);

    vis.stop();
    delete (document as { hidden?: boolean }).hidden;
  });

  it('stop 后回调不再触发，且 on/off 成对注销（防卸载泄漏）', () => {
    // 全局 `uni` 的编译期类型是宿主 `Uni`（无测试记账字段），这里取替身类型
    const stub = uni as unknown as UniStub;
    // setup 文件级只 install 一次，calls 跨用例累计，断言前先清零
    stub.resetCalls();
    const vis = startAppVisibility();
    let count = 0;
    vis.onShow(() => (count += 1));
    vis.stop();

    triggerAppHide();
    triggerAppShow();
    expect(count).toBe(0);

    // 替身记账：show/hide 各注册一次、各注销一次
    expect(stub.calls.appVisibility).toEqual({ onShow: 1, onHide: 1, offShow: 1, offHide: 1 });
  });
});

describe('B. 牌桌回前台补快照', () => {
  it('对局中 + 链路通：回前台补一次 game.resync', async () => {
    const { wrapper, socket } = mountTable();
    await enterPlaying(wrapper, socket);
    expect(socket.emittedOf('game.resync')).toHaveLength(0);

    triggerAppHide();
    triggerAppShow();
    await wrapper.vm.$nextTick();

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('断链期间不补（交给 socket.io 自动重连），恢复连通后回前台才补', async () => {
    const { wrapper, socket } = mountTable();
    await enterPlaying(wrapper, socket);

    // 直接置位（不走 emitDisconnect，避免触发 client 的重连去抖定时器干扰本用例）
    socket.disconnected = true;
    triggerAppHide();
    triggerAppShow();
    expect(socket.emittedOf('game.resync')).toHaveLength(0);

    socket.disconnected = false;
    triggerAppHide();
    triggerAppShow();
    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('非对局态（无快照）回前台不补', () => {
    const { socket } = mountTable();
    // 不推送 deal：currentVersion=-1、view=null
    triggerAppHide();
    triggerAppShow();
    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });

  it('节流窗内连续回前台只补一次', async () => {
    const { wrapper, socket } = mountTable();
    await enterPlaying(wrapper, socket);

    triggerAppHide();
    triggerAppShow();
    triggerAppHide();
    triggerAppShow();
    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('页面卸载后回前台不再补（监听已注销）', async () => {
    const { wrapper, socket } = mountTable();
    await enterPlaying(wrapper, socket);
    wrapper.unmount();
    mounted.length = 0; // afterEach 不再重复卸载

    triggerAppHide();
    triggerAppShow();
    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });
});
