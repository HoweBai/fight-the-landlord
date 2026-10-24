/**
 * Task 3（提示收敛基座）：`NoticeStack` 的**渲染契约**与 `LandscapeStage` 的 overlay 槽。
 *
 * 判据射程（诚实版）：jsdom **不注入 CSS** ⇒ 这里不证明层级/观感，只证明
 *  ① 每条本地项的级别 class、动作按钮、关闭按钮与 `data-notice-id` 锚点都接上了；
 *  ② 关闭按钮发 `dismiss(id)`（页面据此 `notices.dismiss`）；
 *  ③ `LandscapeStage` 的 `overlay` 具名槽真的落在 `.stage__overlay` 内；
 *  ④ **空 `items` 仍渲染根容器**（G3 浮层挂载判据的挂载面）。
 *
 * ⚠️ 根容器「必须绝对定位」是源码性质（不参与文档流）—— jsdom 读不到样式，
 * 故用源码闸钉（见文件末尾），与 `ui-tokens` 的静态扫描同一口径。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';
import NoticeStack from '../src/components/NoticeStack.vue';
import { collectSourceFiles } from './helpers/source-scan';

describe('NoticeStack 浮层', () => {
  it('渲染级别、动作、关闭与 data 锚点', async () => {
    const wrapper = mount(NoticeStack, {
      props: {
        surface: 'game',
        items: [
          { id: 'a', level: 'error', text: '出错了', actions: [{ label: '重试', onClick: () => {} }] },
          { id: 'b', level: 'info', text: '好' },
        ],
      },
    });
    expect(wrapper.find('.notice-stack').exists()).toBe(true);
    expect(wrapper.find('.notice-stack').attributes('data-surface')).toBe('game');
    expect(wrapper.find('[data-notice-id="a"]').classes()).toContain('notice--error');
    expect(wrapper.text()).toContain('重试');
    // 有动作的项**不**渲染关闭按钮（`dismissible` 缺省 = 无动作才有 ×）——
    // 否则玩家可以关掉一条唯一带「重试」出口的死态提示。
    expect(wrapper.find('[data-notice-id="a"] .notice__close').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="b"] .notice__close').exists()).toBe(true);
    // 无障碍语义：error/warn 唤醒读屏（alert/assertive），info 不打断（status/polite）。
    expect(wrapper.find('[data-notice-id="a"]').attributes('role')).toBe('alert');
    expect(wrapper.find('[data-notice-id="a"]').attributes('aria-live')).toBe('assertive');
    expect(wrapper.find('[data-notice-id="b"]').attributes('role')).toBe('status');
    expect(wrapper.find('[data-notice-id="b"]').attributes('aria-live')).toBe('polite');
    await wrapper.find('[data-notice-id="b"] .notice__close').trigger('click');
    expect(wrapper.emitted('dismiss')?.[0]).toEqual(['b']);
  });

  it('空 items 仍渲染根容器（G3 挂载判据），且根为绝对定位（源码闸）', () => {
    const wrapper = mount(NoticeStack, { props: { items: [], surface: 'lobby' } });
    expect(wrapper.find('.notice-stack').exists(), '空 items 时根容器必须仍在（G3 挂载判据）').toBe(true);
    expect(wrapper.findAll('.notice')).toHaveLength(0);

    const file = collectSourceFiles().find((f) => f.path === 'src/components/NoticeStack.vue');
    expect(file, '源码扫描器必须真的读到 NoticeStack.vue').toBeDefined();
    const block = /\.notice-stack\s*\{([\s\S]*?)\}/.exec(file!.content);
    expect(block, '.notice-stack 规则必须存在').not.toBeNull();
    expect(block![1], '浮层根必须绝对定位（不参与文档流）').toMatch(/position:\s*absolute/);
  });

  it('LandscapeStage 的 overlay 槽在 .stage__overlay 内', () => {
    const wrapper = mount(LandscapeStage, {
      slots: { default: '<view class="page-body" />', overlay: '<view class="notice-stack" />' },
    });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    // 反向对照：默认槽内容**不得**混进 overlay（槽名接错时会在这里红）。
    expect(wrapper.find('.stage__overlay .page-body').exists()).toBe(false);
    wrapper.unmount();
  });
});
