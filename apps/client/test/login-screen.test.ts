/**
 * ➊ 登录/注册屏（spec §5-➊）。
 *
 * 判据三条：
 *  ① **保锚（2026-10-10 去重后）**：`.login__field input`（≥2、顺序 = 手机号/密码）与
 *     `.login__actions .btn--primary`（当前形态的唯一提交按钮）继续成立；
 *     注册路径 = 先点 `.login__seg-item` 的「注册」、再点主按钮（旧的次按钮已删，R647/R649 迁移）；
 *  ② 新能力：分段控件切形态 · 注册态多一个确认字段 · 密码可见性 · 加载态 · 字段级校验；
 *  ③ **前沿红线**：前端**不判格式**（手机号/密码格式的权威判定在服务端，R650）—— 源码级钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginPage from '../src/pages/login/login.vue';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { collectSourceFiles } from './helpers/source-scan';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

function mountLogin() {
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, auth: useAuthStore() };
}

/**
 * ⚠️ 与 brief 的测试代码相比**唯一**的一处调整（原因写在报告里）：先建**本地 WS 会话**。
 *
 * `submit()` 在登录成功后按设计调 `restartGameSession()`（真浏览器里
 * `main.ts` 启动时无条件建过会话），而 `restartGameSession()` 未初始化时会**同步抛**
 * ——本文件的两个用例把 `signIn`/`signUp` mock 成 `true`，于是那一下抛出发生在测试 window
 * **之外**（floating rejection），vitest 记 2 条 unhandled error ⇒ 整包 `vitest run`
 * **退出码 1**。判据没有任何一条变弱：本用例仍然只驱动 auth store，不发任何 REST。
 */
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  startGameSession(() => new FakeSocket());
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
  vi.unstubAllGlobals();
});

describe('➊ 登录/注册屏', () => {
  it('默认登录态：两个输入框（手机号、密码），顺序与探针一致', () => {
    const { wrapper } = mountLogin();
    const inputs = wrapper.findAll('.login__field input');
    expect(inputs).toHaveLength(2);
    // 2026-10-18 真机：手机号框**不设** inputmode="tel" ⇒ 弹全键盘。
    // 原因：横屏 + 讯飞输入法会把数字键盘渲染成悬浮小键盘，正好盖住居中的登录卡片。
    expect(inputs[0]!.attributes('inputmode')).toBeUndefined();
    expect(inputs[1]!.attributes('type')).toBe('password');
    expect(wrapper.find('.login__field--confirm').exists()).toBe(false);
    // 无错误时不得凭空出现提示项（空 items ⇒ 只有常驻外壳，没有 `.notice` 条目）。
    expect(wrapper.find('.notice').exists()).toBe(false);
  });

  it('动作区只有**一颗**主按钮（2026-10-10 去重：次按钮已删，形态切换只在分段控件）', () => {
    const { wrapper } = mountLogin();
    expect(wrapper.findAll('.login__actions .btn')).toHaveLength(1);
    expect(wrapper.findAll('.login__actions .btn--primary')).toHaveLength(1);
    expect(wrapper.find('.login__actions .btn--primary').text()).toBe('登录');
    // 防复活：那颗「另一个动作直接提交」的次按钮不得回来
    expect(wrapper.find('.login__actions .btn:not(.btn--primary)').exists()).toBe(false);
  });

  it('分段控件切到注册 ⇒ 主按钮变「注册」、出现确认密码与昵称字段', async () => {
    const { wrapper } = mountLogin();
    const segItems = wrapper.findAll('.login__seg-item');
    expect(segItems.map((b) => b.text())).toEqual(['登录', '注册']);
    await segItems[1]!.trigger('click');
    expect(wrapper.find('.login__actions .btn--primary').text()).toBe('注册');
    expect(wrapper.find('.login__field--confirm input[type="password"]').exists()).toBe(true);
    expect(wrapper.find('.login__field--nickname input').exists()).toBe(true);
    // 保锚：切到注册态后是 4 个 `.login__field input`（前两个顺序不变）
    expect(wrapper.findAll('.login__field input')).toHaveLength(4);
    // 全键盘口径见本文件第一处断言（2026-10-18 真机反馈）
    expect(wrapper.findAll('.login__field input')[0]!.attributes('inputmode')).toBeUndefined();
  });

  it('R649（迁移）：分段切到「注册」后，主按钮**真的提交注册**（形态切换 + 提交两步）', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    // 注册路径不再有「直接提交」的次按钮：先切形态（确认密码字段出现）…
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('阿豆');
    // …再用当前形态唯一的主按钮提交
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(signUp).toHaveBeenCalledWith('13800000000', 'secret123', '阿豆');
  });

  it('邀请码开关开：注册态多一个邀请码字段；提交带 trim+大写码（2026-10-26）', async () => {
    const { wrapper, auth } = mountLogin();
    useGameStore().$patch({ agentInviteEnabled: true, clientConfigVersion: 1 });
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);

    await wrapper.find('.login__field--phone input').setValue('13800000010');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('阿豆');
    expect(wrapper.find('.login__field--invite').exists()).toBe(true);
    expect(wrapper.findAll('.login__field input')).toHaveLength(5);
    await wrapper.find('.login__field--invite input').setValue(' abcd2345 ');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(signUp).toHaveBeenCalledWith('13800000010', 'secret123', '阿豆', 'ABCD2345');
  });

  it('邀请码开关关：注册态仍 4 个输入框；提交不带第 4 参', async () => {
    const { wrapper, auth } = mountLogin();
    useGameStore().$patch({ agentInviteEnabled: false, clientConfigVersion: 1 });
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.find('.login__field--phone input').setValue('13800000011');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('阿豆');
    expect(wrapper.find('.login__field--invite').exists()).toBe(false);
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(signUp).toHaveBeenCalledWith('13800000011', 'secret123', '阿豆');
  });

  it('注册态昵称为空 ⇒ 就地报错且不发请求', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('请输入昵称');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('注册态昵称超过 20 字符 ⇒ 就地报错且不发请求', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('a'.repeat(21));
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('昵称最多 20 个字符');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('密码可见性切换只改 input 的 type（默认必须是 password）', async () => {
    const { wrapper } = mountLogin();
    const toggle = wrapper.find('.login__toggle-visibility');
    expect(toggle.exists()).toBe(true);
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('password');
    await toggle.trigger('click');
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('text');
    await toggle.trigger('click');
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('password');
  });

  it('字段级校验：空手机号/空密码就地报错且**不发请求**', async () => {
    const { wrapper, auth } = mountLogin();
    const signIn = vi.spyOn(auth, 'signIn').mockResolvedValue(true);
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('请输入手机号');
    expect(signIn).not.toHaveBeenCalled();

    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('请输入密码');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('注册态两次密码不一致 ⇒ 就地报错且不发请求', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__field--confirm input').setValue('secret124');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('两次输入的密码不一致');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('提交中主按钮进入加载态并禁用（M06 的 UI 面）', async () => {
    const { wrapper, auth } = mountLogin();
    let release: (v: boolean) => void = () => {};
    vi.spyOn(auth, 'signIn').mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.login__actions .btn--primary').text()).toContain('登录中');
    expect(wrapper.find('.login__actions .btn--primary').attributes('disabled')).toBeDefined();
    release(true);
  });

  it('服务端文案优先展示在登录提示项（保锚）', async () => {
    const { wrapper, auth } = mountLogin();
    auth.error = '密码错误';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-notice-id="auth"] .notice__text').text()).toContain('密码错误');
  });

  /**
   * Task 5（G3 浮层挂载闸 + G4 页面层单次呈现）：
   * 登录页的错误不再占文档流，字段校验与登录失败都渲染为 `NoticeStack` 项。
   * 判别力：旧内联错误行（`.login__field-error`/`.login__error`）必须不存在 ——
   * 保锚选择器同时否证「两处都渲染」。
   */
  it('字段校验与登录失败都渲染为 NoticeStack 项，不再有内联错误行', async () => {
    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('.login__field-error').exists()).toBe(false);
    expect(wrapper.find('.login__error').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toContain('请输入手机号');
  });

  it('10005 登录尝试仍静默（负对照）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ code: 10005, message: '签名无效', data: null }),
    })));
    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('secret');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();
    expect(useAuthStore().error).toBe('');
    expect(wrapper.find('.notice').exists()).toBe(false);
  });

  it('源码级红线：登录页**不自造格式判定**（R650）', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/pages/login/login.vue');
    expect(file, 'login.vue 必须在源码扫描集合里').toBeDefined();
    const code = file!.content;
    // 手机号格式（正则/长度）、密码强度这类判定一律不得出现在前端
    expect(code).not.toMatch(/\\d\{11\}/);
    expect(code).not.toMatch(/length\s*===?\s*11\b/);
    expect(code).not.toMatch(/正则|regex|test\(\s*\/\^?1/);
  });
});
