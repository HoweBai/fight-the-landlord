/**
 * 连接所有权矩阵（Task 4 + Task 11 收敛）：`NoticeStack` 对「谁该显示连接提示」的判定。
 *
 * 所有权判据：
 *  - 牌桌（`surface: 'table'`）的连接提示归 `ConnectionOverlay`（非 connected 时 Stack
 *    抑制 transport 提示、不出内置死态项）；
 *  - 大厅（`lobby`）+ 玩法页（`game`）的连接死态统一由 Stack 内置 `connection-dead` 项承担
 *    （文案与动作来自 `connection-copy.ts`；ConnectionDeadBar 已在玩法页退役）；
 *  - transport 提示在大厅/玩法页 dead 相位被各自的 connection-dead 项取代（不双显）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import NoticeStack from '../src/components/NoticeStack.vue';
import TablePage from '../src/pages/table/table.vue';
import {
  currentSession,
  getGameSession,
  startGameSession,
  stopGameSession,
} from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import { RECONNECT_GIVE_UP_ATTEMPTS } from '../src/net/transport';
import type { SessionNotice } from '../src/net/session';
import type { ConnectionState } from '../src/net/socket';
import { FakeSocket } from './helpers/fake-socket';

function fakeSession(phase: 'connected' | 'reconnecting' | 'dead', deadReason: string | null, deadCode: number | null) {
  const notice = ref<SessionNotice | null>(null);
  const connectionState = ref<ConnectionState>({
    phase,
    attempt: 0,
    deadReason: deadReason as ConnectionState['deadReason'],
    deadCode,
  });
  currentSession.value = {
    notice,
    connectionState,
    client: { retryConnect: () => {} },
    clearNotice: () => {},
    disconnect: () => {},
    onDisposition: () => () => {},
  } as never;
  return { notice, connectionState };
}

beforeEach(() => {
  setActivePinia(createPinia());
  currentSession.value = null;
});

describe('连接所有权矩阵', () => {
  it('大厅 dead：只出现 connection-dead 项，且带重试按钮', () => {
    fakeSession('dead', 'give_up', null);
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.findAll('.notice')).toHaveLength(1);
    expect(wrapper.text()).toContain('多次自动重连仍未成功');
    expect(wrapper.text()).toContain('重新连接');
    expect(wrapper.find('.notice__close').exists()).toBe(false);
  });

  it('玩法页 dead：Stack 出 connection-dead 项（与大厅收敛，ConnectionDeadBar 已退役）', () => {
    fakeSession('dead', 'give_up', null);
    const wrapper = mount(NoticeStack, { props: { surface: 'game', items: [] } });
    expect(wrapper.findAll('.notice')).toHaveLength(1);
    expect(wrapper.find('[data-notice-id="connection-dead"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('重新连接');
  });

  it('玩法页 dead：transport 提示被 connection-dead 项取代，不双显', () => {
    const { notice } = fakeSession('dead', 'give_up', null);
    notice.value = { level: 'error', text: '连接不可用', source: 'transport' };
    const wrapper = mount(NoticeStack, { props: { surface: 'game', items: [] } });
    expect(wrapper.find('[data-notice-id="session-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="connection-dead"]').exists()).toBe(true);
  });

  it('大厅 reconnecting：transport 提示是 sticky 且无死态项', () => {
    const { notice } = fakeSession('reconnecting', null, null);
    notice.value = { level: 'error', text: '连接不可用，请检查网络后重试', source: 'transport', sticky: true };
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.text()).toContain('连接不可用');
    expect(wrapper.text()).not.toContain('重新连接');
  });

  it('牌桌非 connected：transport 被抑制，交给 ConnectionOverlay', () => {
    const { notice } = fakeSession('reconnecting', null, null);
    notice.value = { level: 'error', text: '连接不可用', source: 'transport' };
    const wrapper = mount(NoticeStack, { props: { surface: 'table', items: [] } });
    expect(wrapper.text()).toBe('');
  });

  it('牌桌 connected：transport 恢复提示仍显示', () => {
    const { notice } = fakeSession('connected', null, null);
    notice.value = { level: 'info', text: '连接已恢复', source: 'transport' };
    const wrapper = mount(NoticeStack, { props: { surface: 'table', items: [] } });
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('连接已恢复');
  });

  it('大厅 11003 死态给「重新登录」出口（有动作 ⇒ 不可关闭）', () => {
    fakeSession('dead', 'server_rejected', ErrCode.USER_BANNED);
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.text()).toContain('该账号已被封禁');
    expect(
      wrapper.find('.notice__close').exists(),
      '给出登录出口后不得让用户把唯一动作关掉',
    ).toBe(false);
    expect(wrapper.findAll('.notice__action').map((a) => a.text())).toContain('重新登录');
  });
});

/**
 * 牌桌**页面级**连接所有权（Task 10）：`NoticeStack` 在牌桌只是本地项 + 会话提示的
 * 渲染器 —— 连接提示（reconnecting 提示条 / dead 遮罩）归 `ConnectionOverlay`。
 * 这里用真会话 + 真 `TablePage` 挂载，钉住「非 connected 时 Stack 抑制 transport、
 * 页面里没有第二份连接文案/死态项」，同时 ConnectionOverlay 必须仍在。
 */
describe('牌桌页（surface=table）的连接所有权', () => {
  const mounted: VueWrapper[] = [];
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    stopGameSession();
  });

  function mountTable() {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    useGameStore().setRoom('ROOM1', 0);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);
    return { wrapper, socket };
  }

  it('reconnecting：Stack 无连接文案，ConnectionOverlay 提示条仍在', async () => {
    const { wrapper, socket } = mountTable();
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    socket.io.emit('reconnect_attempt', 2);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.stage__overlay .notice-stack').attributes('data-surface')).toBe('table');
    expect(
      wrapper.find('.stage__overlay [data-notice-id="session-notice"]').exists(),
      '非 connected ⇒ transport 提示由 ConnectionOverlay 承担，Stack 抑制',
    ).toBe(false);
    expect(wrapper.find('.connection-overlay__toast').exists(), 'ConnectionOverlay 仍在').toBe(true);
    expect(wrapper.text()).toContain('第 2 次');
  });

  it('dead：Stack 无死态项/连接文案，ConnectionOverlay 遮罩仍在', async () => {
    const { wrapper, socket } = mountTable();
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) {
      socket.io.emit('reconnect_attempt', i);
    }
    await wrapper.vm.$nextTick();

    expect(
      wrapper.find('.stage__overlay [data-notice-id="connection-dead"]').exists(),
      '牌桌死态归 ConnectionOverlay，Stack 不出内置死态项',
    ).toBe(false);
    expect(wrapper.find('.stage__overlay [data-notice-id="session-notice"]').exists()).toBe(false);
    expect(wrapper.find('.connection-overlay__scrim').exists(), 'dead ⇒ ConnectionOverlay 遮罩').toBe(true);
  });

  it('connected：transport 恢复提示由 Stack 呈现（ConnectionOverlay 不在 DOM）', async () => {
    const { wrapper, socket } = mountTable();
    socket.emitConnect();
    await wrapper.vm.$nextTick();

    getGameSession().notice.value = { level: 'info', text: '连接已恢复', source: 'transport' };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.stage__overlay .notice-stack').attributes('data-surface')).toBe('table');
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('连接已恢复');
    expect(wrapper.find('.connection-overlay').exists(), 'connected ⇒ Overlay 不进 DOM').toBe(false);
  });
});
