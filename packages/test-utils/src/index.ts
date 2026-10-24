/**
 * `@fight-the-landlord/test-utils` 入口 —— dev-only 测试工具的唯一真源（台账 N46）。
 *
 * ⚠️ 只许**测试代码**引用（各包 devDependencies，`workspace:*`）；任何服务 `src/`
 * 生产代码不得 import 本包 —— 那会把测试专用代码拖进生产产物。
 */
export { stripComments } from './strip-comments';
