import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // 与 vite.config.ts 一致：测试直接跑契约包源码，避免依赖 dist 构建产物。
      '@fight-the-landlord/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    /**
     * 两个 setup，各补一层**宿主能力**（都只补编译期/运行时缺的东西，不改 `src/**` 行为）：
     *  1. `test/setup.ts`：`uni` 全局替身（存储 / 页面栈 / 系统信息）。Task 3 起 `src/**`
     *     走 `uni.*` 而不是 `localStorage`，没有它用例会静默走「宿主没存储」的降级分支。
     *  2. `test/setup/uni-easycom.ts`：`wd-*` 的 easycom 替身。easycom 是**编译期**行为
     *     （`src/pages.json` 的规则由 uni 编译器生效），vitest 只有 `@vitejs/plugin-vue`
     *     ⇒ 不补的话 `wd-*` 会渲染成「吞掉子节点的裸自定义元素」，把锚在 class/文案上的
     *     断言变成静默失配。
     */
    setupFiles: ['test/setup.ts', 'test/setup/uni-easycom.ts'],
    restoreMocks: true,
  },
});
