import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Vitest 4 默认会把构建产物 `dist/*.test.js` 也收进来；这些是 CJS，
    // 且 `vitest` 不能以 require() 导入 ⇒ 显式排除（Vitest 2 起未出现）。
    exclude: ['dist/**', 'node_modules/**'],
  },
});
