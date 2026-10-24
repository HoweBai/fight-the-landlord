/**
 * `Panel.vue` —— 9-slice 面板（§6.4 / U3）。
 *
 * 判据三条：
 *  ① 两个变体取**不同**的源图，且默认是 blue；
 *  ② `border-image` 的四个参数在**源码里**齐备（缺一个都会**静默**退化成「一张被拉伸的图」）；
 *  ③ 兜底：底图 404 时仍有实色底（R693 同精神），不是一圈透明边框。
 *
 * ⚠️ **判据射程（诚实版）**：jsdom **不注入 CSS** ⇒ 本文件**不证明**九宫格渲染得像样
 * （圆角有没有被切坏、中间有没有被压扁，全是观感）。那只能由真浏览器 / App 走查证明
 * （spec §9.2-7：**不要造假判据**）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import Panel from '../src/components/Panel.vue';

const panelSrc = stripComments(
  collectSourceFiles().find((f) => f.path === 'src/components/Panel.vue')!.content,
);

describe('§6.4 面板 9-slice（U3）', () => {
  it('默认 blue；orange 变体取**不同**的源图（正对照：证明变体真的分了支）', () => {
    const blue = mount(Panel, { slots: { default: 'x' } });
    const orange = mount(Panel, { props: { variant: 'orange' }, slots: { default: 'x' } });
    expect(blue.classes()).toContain('panel');
    expect(blue.classes()).toContain('panel--blue');
    expect(orange.classes()).toContain('panel--orange');
    expect(orange.classes()).not.toContain('panel--blue');
    // 两个变体的源图必须不同（否则「两个变体」是假的）
    expect(panelSrc).toMatch(/panel-blue\.png/);
    expect(panelSrc).toMatch(/panel-orange\.png/);
    blue.unmount();
    orange.unmount();
  });

  it('源码里四个 9-slice 参数齐备（缺一就静默退化成拉伸图）', () => {
    expect(panelSrc, '源图（由 border-image 简写提供）').toMatch(/border-image:\s*url\(/);
    expect(panelSrc, 'slice：无单位 = 源图像素；fill 保留中心').toMatch(
      /border-image[\s\S]{0,200}?\b\d+\s+fill\b|\bborder-image-slice:\s*\d+(%\s*)?\s*fill/,
    );
    expect(panelSrc, 'width：渲染尺寸走令牌（片① 后单位为 px）').toMatch(/border:\s*\$ftl-panel-slice\s+solid/);
    expect(panelSrc, 'repeat：不写就退化成 stretch（这里显式写死）').toMatch(/\bstretch\b/);
  });

  it('兜底：有实色底，底图缺失时不是一圈透明边框（R693 同精神）', () => {
    expect(panelSrc, '必须有 background 令牌兜底').toMatch(/background:\s*\$ftl-color-/);
  });

  it('默认插槽被渲染（是容器而非空壳）', () => {
    const wrapper = mount(Panel, { slots: { default: '<text class="probe">hi</text>' } });
    expect(wrapper.find('.probe').exists()).toBe(true);
    wrapper.unmount();
  });
});
