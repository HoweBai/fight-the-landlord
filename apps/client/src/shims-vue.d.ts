/**
 * `.vue` 单文件组件的模块声明。
 *
 * ## 为什么需要它
 *
 * `vue-tsc` 本应**原生解析** `.vue` 导入，但在本仓库当前的工具链组合下它**没有**：
 * `apps/client/src/main.ts:46` 的 `import App from './App.vue'` 报
 * `TS7016: Could not find a declaration file for module './App.vue'`。
 *
 * 该报错会**让 `pnpm run ci` 的第 2 阶段（lint）整条失败** —— 不是「client 的告警」，
 * 是**全仓门禁红**。加本文件之前，`apps/client` 的 lint 永远非零退出。
 *
 * ## 它不是「放宽检查」，而是把「隐式」写成「显式」
 *
 * ⚠️ 关键判断：**在加本文件之前，`.vue` 导入根本没有被检查过**：
 * 否则就不会报 TS7016。那些位点当时是**隐式 `any`**（即一个错误）。
 * 本文件把那处隐式 `any` 写成了显式的宽松类型，**相对实际状态没有削弱任何检查**
 * （实测：加它之后 lint 错误从 1 降到 0，**没有新增任何错误**）。
 *
 * `.vue` 文件**自身**仍在 `tsconfig.json` 的 `include` 里（匹配 `src` 下的全部 `.vue`），
 * `vue-tsc` 照常检查它们的内部实现。
 *
 * ## ⚠️ 但它有代价，必须在下面这条成立时重新审视
 *
 * 一个通配的 `declare module '*.vue'` **会覆盖** `vue-tsc` 的原生 `.vue` 解析，
 * 使导入位点的 prop 检查退化成宽松类型（例如 `mount(Hand, { props })` 的 props 不再被精确校验）。
 *
 * ⇒ **如果将来 `vue-tsc` 恢复了原生解析**（例如工具链版本对齐、或 DCloud 插件修复），
 * 本文件应当**删除**，让原生解析接管更精确的检查。
 *
 * **判断方法**：临时删掉本文件跑 `pnpm --filter @fight-the-landlord/client lint`。
 * 若不再报 TS7016 ⇒ 原生解析已恢复 ⇒ 删掉本文件。
 *
 * ## 登记
 *
 * 这是**既有环境问题**（在本片之前就存在：`main.ts` 与 `env.d.ts` 在本片未被触碰，
 * 而 `master` 上同样没有 `.vue` shim）。它**不在花色片的设计范围内**，
 * 但因为**挡住了整片的完成判据**（`pnpm run ci` 六阶段全绿）而在此一并处置。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
