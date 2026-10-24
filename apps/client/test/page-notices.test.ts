/**
 * Task 3（提示收敛基座）：`usePageNotices` 的**生命周期**判据。
 *
 * 本文件只钉「提示项什么时候进、什么时候出」，不碰渲染：
 *  - 级别 TTL（info/success 3s · warn 6s · error 8s）与 sticky（`durationMs: 0`）；
 *  - 同 `id` 替换（新值覆盖旧值并重置计时器）、同 `level+text` 且双方都无动作 ⇒ 去重；
 *  - `priority: 'critical'` 不参与「普通项上限 5」的淘汰；
 *  - 组件卸载后 `show` 变 no-op、计时器全清（防卸载后回写）。
 *
 * ⚠️ **fake timers 是必须的**：TTL 就是本模块的主要行为，真等 8 秒既慢又不稳。
 * ⚠️ `usePageNotices` 依赖 `onUnmounted` ⇒ 必须挂在一个真组件里调用（harness 同生产形态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { usePageNotices } from '../src/composables/usePageNotices';

function harness() {
  let api!: ReturnType<typeof usePageNotices>;
  const Comp = defineComponent({
    setup() {
      api = usePageNotices();
      return () => h('div');
    },
  });
  const wrapper = mount(Comp);
  return { api, wrapper };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePageNotices', () => {
  it('按级别 3/6/8s 自动消失', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'info', text: 'a' });
    api.show({ id: 'b', level: 'warn', text: 'b' });
    api.show({ id: 'c', level: 'error', text: 'c' });
    vi.advanceTimersByTime(3000);
    expect(api.items.value.map((i) => i.id)).toEqual(['c', 'b']);
    vi.advanceTimersByTime(3000);
    expect(api.items.value.map((i) => i.id)).toEqual(['c']);
    vi.advanceTimersByTime(2000);
    expect(api.items.value).toEqual([]);
  });

  it('同 id 替换、同文案去重、sticky 不消失', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'warn', text: 'x' });
    api.show({ id: 'a', level: 'error', text: 'y' });
    expect(api.items.value).toHaveLength(1);
    expect(api.items.value[0]!.text).toBe('y');
    api.show({ id: 'b', level: 'error', text: 'y' });
    expect(api.items.value).toHaveLength(1);
    api.show({ id: 's', level: 'error', text: 'sticky', durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(api.items.value.some((i) => i.id === 's')).toBe(true);
  });

  it('critical 不淘汰，普通项上限 5', () => {
    const { api } = harness();
    api.show({ id: 'crit', level: 'error', text: 'crit', durationMs: 0, priority: 'critical' });
    for (let i = 0; i < 7; i += 1) api.show({ id: `n${i}`, level: 'warn', text: `n${i}` });
    expect(api.items.value.filter((i) => i.priority !== 'critical')).toHaveLength(5);
    expect(api.items.value.some((i) => i.id === 'crit')).toBe(true);
  });

  it('卸载后 show no-op 并清计时器', () => {
    const { api, wrapper } = harness();
    api.show({ id: 'a', level: 'warn', text: 'a' });
    // 卸载前必须确有一个在跑的计时器——否则下面的 0 是空断言（旧测试的漏洞）。
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    api.show({ id: 'b', level: 'warn', text: 'b' });
    expect(api.items.value).toEqual([]);
  });

  /**
   * 同 id 替换必须**取消旧计时器并重新计时**：只靠「替换后 4s 项还在」无法区分
   * 「旧计时器被取消」与「旧计时器仍在跑但恰好没到点」——所以先推进到旧到期点验证没被移除，
   * 再推进到新 TTL 验证被移除。
   */
  it('同 id 替换取消旧计时器并按新 TTL 重新计时', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'error', text: '旧' }); // error TTL 8s ⇒ 旧计时器 t=8s
    vi.advanceTimersByTime(4000);
    api.show({ id: 'a', level: 'error', text: '新' }); // 替换：取消旧的，重新计 8s ⇒ t=12s
    expect(vi.getTimerCount()).toBe(1); // 旧计时器已取消，未遗留第二个 timer

    vi.advanceTimersByTime(4000); // t=8s：旧计时器若未取消，项会在此刻消失
    expect(api.items.value.map((i) => i.id)).toEqual(['a']);
    expect(api.items.value[0]!.text).toBe('新');

    vi.advanceTimersByTime(3999); // t=11.999s：新 TTL 还差 1ms
    expect(api.items.value.map((i) => i.id)).toEqual(['a']);
    vi.advanceTimersByTime(1); // t=12s：新计时器到期
    expect(api.items.value).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * 页面接线会直接用 `setNotice`（同 id 的「状态位」式提示，如页面加载失败）——
   * 空文案必须等价于 `dismiss`，否则「失败态消失」会退化成「留一条空提示」。
   */
  it('dismiss / clear / setNotice 接线', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'warn', text: 'a' });
    api.show({ id: 'b', level: 'warn', text: 'b' });

    api.dismiss('a');
    expect(api.items.value.map((i) => i.id)).toEqual(['b']);

    // 空文案 ⇒ 移除（而不是渲染一条空提示）
    api.setNotice('b', '');
    expect(api.items.value).toEqual([]);

    api.setNotice('c', '失败', { level: 'error' });
    expect(api.items.value[0]).toMatchObject({ id: 'c', level: 'error', text: '失败' });

    // 省略 level ⇒ 按 info 呈现（「状态位」式接线只关心文案）
    api.setNotice('d', '默认级别');
    expect(api.items.value[0]).toMatchObject({ id: 'd', level: 'info', text: '默认级别' });

    api.clear();
    expect(api.items.value).toEqual([]);
  });
});
