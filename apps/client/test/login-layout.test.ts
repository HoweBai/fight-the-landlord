/**
 * 登录页样板的**结构要求**（规格 `2026-09-27-login-page-pilot-design.md`）。
 *
 * ⚠️ **射程诚实版**：jsdom **没有布局引擎** —— 这里**不**能证明「它是单列的」、「高度压进了 750」。
 * 那两件事只能靠真浏览器截图 + 测量（规格 §6）。本文件只钉三件**可以机械判定**的事：
 *   ① 说明文字 `.login__hint` 已删（规格 §3 的压缩项，已核无锚点）；
 *   ② 幽灵按钮**已移出** `.login__panel`（挪出主流程，规格 §3）；
 *   ③ 被锚定的东西**一个没少**（锚点表 §5.1 的**存在性**部分 —— 数值/顺序由 `login-screen.test.ts` 管）。
 *
 * ③ 是**判别力自证**：它防的是「为了单列把某个锚点元素顺手删了」。
 *
 * ⚠️ **mount 姿势逐字照抄 `login-screen.test.ts:19-46`** —— 尤其
 *    `startGameSession(() => new FakeSocket())` 那一句：少了它，`restartGameSession()`
 *    未初始化时**同步抛**，而抛出发生在测试 window **之外**（floating rejection）
 *    ⇒ vitest 记 unhandled error ⇒ **整包退出码 1**（该文件头逐字记着这个坑）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginPage from '../src/pages/login/login.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket } from './helpers/fake-socket';
import { collectSourceFiles } from './helpers/source-scan';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

function mountLogin() {
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  startGameSession(() => new FakeSocket());
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

describe('登录页样板 · 结构要求', () => {
  it('① 说明文字 `.login__hint` 已删（规格 §3 的压缩项）', () => {
    expect(mountLogin().find('.login__hint').exists()).toBe(false);
  });

  it('② 幽灵按钮已移出 `.login__panel`（挪出主流程）', () => {
    const w = mountLogin();
    expect(w.findAll('.btn--ghost'), '幽灵按钮必须还在（只是挪位置）').toHaveLength(1);
    expect(w.find('.login__panel .btn--ghost').exists(), '幽灵按钮不得留在面板内').toBe(false);
    expect(w.find('.login > .btn--ghost').exists(), '幽灵按钮必须挂到面板外').toBe(true);
  });

  it('③ 判别力自证：被锚定的元素一个都没少', () => {
    const w = mountLogin();
    for (const sel of [
      '.login__seg-item',
      '.login__field--phone',
      '.login__field--password',
      '.login__actions .btn--primary',
      '.login__toggle-visibility',
    ]) {
      expect(w.find(sel).exists(), `${sel} 不见了 —— 它是被断言锚定的`).toBe(true);
    }
    expect(w.findAll('.login__field input'), '登录态恰好 2 个输入框').toHaveLength(2);
    expect(w.find('.login__brand .login__logo').exists(), '品牌位 logo 必须还在').toBe(true);
  });

  it('⑥ 2026-10-19：品牌位只保留图标，不再重复应用名「优比棋牌」文字', () => {
    const w = mountLogin();
    // 图标里已含「欢乐斗地主」字样 ⇒ 下面再挂一行「优比棋牌」是重复信息（用户裁决去掉）。
    expect(w.find('.login__title').exists(), '「优比棋牌」文字已删除，不得复活').toBe(false);
    expect(w.find('.login__brand').text().trim(), '品牌位必须只剩图标（无任何文字）').toBe('');
    expect(w.find('.login__brand .login__logo').exists(), '图标本身保留').toBe(true);
  });

  it('④ 2026-10-10 去重：动作区只有一颗按钮，次按钮不得复活', () => {
    const w = mountLogin();
    expect(w.findAll('.login__actions .btn'), '动作区只允许唯一的主按钮').toHaveLength(1);
    expect(
      w.find('.login__actions .btn:not(.btn--primary)').exists(),
      '「另一个动作直接提交」的次按钮已删（与分段控件重复、跳过两次密码校验）',
    ).toBe(false);
  });

  it('⑤ 提交按钮与密码框拉开一档（源码级：.login__actions 必须 margin-top 令牌）', () => {
    // jsdom 不布局 ⇒ 钉源码：表单容器 gap 只有 8px，按钮区必须自带 ≥space-5 的上间距，
    // 防止回退成「密码框贴脸按钮」。
    const file = collectSourceFiles().find((f) => f.path === 'src/pages/login/login.vue');
    expect(file, '源码扫描器必须读得到 login.vue').toBeDefined();
    const rule = /\.login__actions\s*\{([^}]*)\}/.exec(file!.content);
    expect(rule, '.login__actions 规则必须存在').not.toBeNull();
    expect(rule![1], '动作区必须有 margin-top 令牌（与最后一个输入框拉开间隔）').toMatch(
      /margin-top:\s*\$ftl-space-(?:[5-9]|\d{2});/,
    );
  });
});
