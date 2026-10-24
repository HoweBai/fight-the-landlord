<script>
/**
 * uni-app 的**应用外壳**（不是页面）。
 *
 * ⚠️ 切片 P10 的 Task 0 实测：uni-app 里 **`App.vue` 的模板不渲染** ——
 * 真实 DOM 只有 `pages.json` 声明的页面（`<uni-app><uni-page>…</uni-page></uni-app>`）。
 * 因此「按 `auth.page` 切页」不可能挂在这里：Task 3 起它由 **uni 的页面栈**承担
 * （`pages.json` 声明 login/lobby/game/table，`auth.navigate()` → `uni.reLaunch` 投影；
 * 冷启动对齐见 `src/composables/usePageAlignment.ts`）。过渡期的页壳
 * `src/pages/index/index.vue` 已随页面栈落地删除。
 *
 * 本文件的职责：全局样式 + 应用级生命周期（全局错误在这接 reporter，项 8）。
 *
 * ⚠️ 为什么用 Options API 而不是 `<script setup>`：后者取 `onError`/`onLaunch` 必须
 * `import { onError } from '@dcloudio/uni-app'`，而 `test/source-boundary.test.ts` 的
 * ④ 依赖边界闸只放行 pinia / socket.io-client / vue（R435：不得放宽任何一条闸）。
 * Options API 形式无需该 import，在不放宽闸的前提下拿到 app 级异常。
 */
import { reportError } from './observability/reporter';

function toError(value) {
  if (value instanceof Error) return value;
  // onUnhandledRejection 的 reason、onError 的入参都不保证是 Error。
  return new Error(value === undefined ? 'unknown error' : String(value));
}

export default {
  onError(err) {
    // uni 应用级未捕获异常（同步为主）。
    reportError('app.onError', toError(err));
  },
  onUnhandledRejection(res) {
    // 未处理的 Promise 拒绝（res 形态：{ promise, reason }，部分端直接给 reason）。
    const reason = res && res.reason !== undefined ? res.reason : res;
    reportError('app.unhandledrejection', toError(reason));
  },
};
</script>

<style lang="scss">
/**
 * 全局样式。uni-app 里 `App.vue` 的 `<style>` 是**全局**的；
 * 页面里的 `<style scoped>` 各自作用域。
 *
 * ⚠️ `App.vue` **没有模板**（uni-app 实测：它的模板不渲染），因此 Task 2 的
 * 「模板标签改写」不涉及它 —— 它只做 token 化：色值一律引用 `src/uni.scss`。
 */
page {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: $ftl-color-text;
  background: $ftl-color-surface;
}
</style>
