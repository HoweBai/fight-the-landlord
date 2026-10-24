/**
 * 单次呈现（Task 4，NoticeStack 层）：同一条提示只渲染一次。
 *
 * 两条判据：
 *  - session notice 与**无动作**本地项同 `level + text` ⇒ 只渲染一条（并让页面收掉本地那条）；
 *  - **带动作**的本地项不被同文 session 去重吞掉（动作是玩家的处置出口）；
 *  - 10008 死态 + 同文 transport：只渲染带重试的死态项（transport 在 dead 相位被取代）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import NoticeStack from '../src/components/NoticeStack.vue';
import { currentSession } from '../src/composables/useGameSession';
import type { SessionNotice } from '../src/net/session';
import type { ConnectionState } from '../src/net/socket';

function setSession(notice: SessionNotice | null, state: ConnectionState) {
  currentSession.value = {
    notice: ref<SessionNotice | null>(notice),
    connectionState: ref<ConnectionState>(state),
    client: { retryConnect: () => {} },
    clearNotice: () => {},
    disconnect: () => {},
    onDisposition: () => () => {},
  } as never;
}

beforeEach(() => {
  setActivePinia(createPinia());
  currentSession.value = null;
});

describe('单次呈现', () => {
  it('session 与本地普通项同文：只渲染一条', () => {
    setSession({ level: 'error', text: 'x', source: 'action' }, { phase: 'connected', attempt: 0, deadReason: null, deadCode: null });
    const wrapper = mount(NoticeStack, {
      props: { surface: 'lobby', items: [{ id: 'local', level: 'error', text: 'x' }] },
    });
    expect(wrapper.findAll('.notice__text').filter((n) => n.text() === 'x')).toHaveLength(1);
  });

  it('带动作的本地项不被 session 同文去重吞掉', () => {
    setSession({ level: 'error', text: 'x', source: 'action' }, { phase: 'connected', attempt: 0, deadReason: null, deadCode: null });
    const wrapper = mount(NoticeStack, {
      props: {
        surface: 'lobby',
        items: [{ id: 'local-action', level: 'error', text: 'x', actions: [{ label: '重试', onClick: () => {} }] }],
      },
    });
    expect(wrapper.findAll('.notice__text').filter((n) => n.text() === 'x')).toHaveLength(2);
  });

  it('10008 死态 + 同文 transport：只渲染带重试的死态项', () => {
    setSession(
      { level: 'error', text: '当前客户端已暂停服务，请稍后再试或更换客户端', source: 'transport' },
      { phase: 'dead', attempt: 0, deadReason: 'server_rejected', deadCode: ErrCode.CLIENT_DISABLED },
    );
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.findAll('.notice__text')).toHaveLength(1);
    expect(wrapper.text()).toContain('重新连接');
  });
});
