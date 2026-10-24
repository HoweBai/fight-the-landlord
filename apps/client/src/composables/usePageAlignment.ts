/**
 * 冷启动对齐：让页面栈追上 `auth.page`（唯一状态源）。
 *
 * ## 为什么需要
 *
 * `auth.hydrate()` 在**入口创建时**（`main.ts`，socket 握手之前）就把 `page` 置成
 * `'lobby'`（本地有令牌）或 `'login'`。而页面栈的第一页是**声明死的**：`pages.json` 里
 * 首个页面 = 登录页（它是冷启动入口，也是探针清空 localStorage 后必须停在的那一页）。
 * 于是「本地有令牌」的冷启动会落到**登录页**上，而 `auth.page` 说应该在大厅。
 *
 * 对齐动作因此必须由**页面自己**在「已经可见」时做：入口页面启动时自检一遍
 * `auth.page` 与自己的身份是否一致，不一致就 `uni.reLaunch` 到 `auth.page` 对应的页面。
 *
 * ## 为什么是 `onMounted` 而不是页面生命周期 `onShow`
 *
 * 派工单要求「在 `onShow` 里自检」。本仓**拿不到** `onShow`：它是 `@dcloudio/uni-app`
 * 导出的组合式钩子，而 `test/source-boundary.test.ts` 把 `src/**` 的裸依赖钉死为
 * `['pinia','socket.io-client','vue']`（`uni.*`/`wx.*` 是全局对象，不得 import 任何库）。
 * Vue 也没有把 `injectHook` 导出到公共 API，`@dcloudio/uni-h5` 只在
 * `$applyOptions()`（Options API 通道）里注入页面钩子，而 `<script setup>` 页面
 * 没有任何地方调用它（见报告 §② 的实测证据）。
 *
 * 替代方案在**语义上等价**，而且比 `onShow` 更严格：
 *  - 本项目只允许 `reLaunch` 导航（一步一页，见 `router.ts`），页面实例**不会被重新显示**：
 *    每次切换都是「销毁旧页 + 新建目标页」⇒ 对页面实例而言 `onShow` 恰好发生一次，
 *    就是它被挂载的那一次；
 *  - 因此「可见时自检」= 「挂载时自检」；`onMounted` 在三端都必定触发。
 *
 * ## 为什么只查一次（不做 watch）
 *
 * `page` 的**每一次**变更都经过 `auth.navigate()`（写 page 之后自己 reLaunch），
 * 或者只发生在冷启动的 `hydrate()` 里（就是这里要追的那种）。若再加一个
 * `watch(() => auth.page)`，`navigate()` 引发的变更会**再触发一次**同 url 的 reLaunch
 * （重复导航），收益为零、风险为「重复导航被 uni 的导航锁拒绝」。这条不变量由
 * `test/page-stack.test.ts` 的机械判据守着。
 */
import { onMounted } from 'vue';
import { syncPageStack, type RouteName } from '../router';
import { useAuthStore } from '../stores/auth';

/**
 * 在页面挂载时对齐一次：`auth.page` 与「我是谁」不一致 ⇒ 立刻跳到 `auth.page` 那一页。
 *
 * `current` 必须是**写死的字面量**（页面自己的身份），不得从 `auth.page` 取——
 * 那会让判据恒真。
 */
export function usePageAlignment(current: RouteName): void {
  const auth = useAuthStore();
  onMounted(() => {
    if (auth.page !== current) syncPageStack(auth.page);
  });
}
