import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // 只收集 `*.test.ts`（`test/helpers.ts` 是共享工具、自身无用例 —— 照 room-service 先例）。
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 分母 = 「src 生产代码」：vitest 默认 include 会把测试文件/入口夹带进来。
      include: ['src/**'],
      reporter: ['text'],
    },
  },
});
