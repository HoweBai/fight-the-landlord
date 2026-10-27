import { defineConfig } from 'vitest/config';

/**
 * 本包只有**纯函数单测**（test 目录下的 `.test.ts`）—— 不含需要真栈的切片。
 * 真栈切片的运行入口是 `pnpm conformance`（`node dist/run.js`），不在这里。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
