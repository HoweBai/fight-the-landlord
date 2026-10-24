import { fileURLToPath, URL } from 'node:url';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 规则函数已迁至 protocol；shared 测试需运行时解析 protocol 源码
      // （protocol 的 `main` 指向 dist，开发期未构建 ⇒ 直指 src）。
      '@fight-the-landlord/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      /**
       * §13.3 / R270：**必须**是 `src/**`。
       *
       * vitest 的默认 `include` 会把「只被 `export *` 带出的入口」与测试文件一起夹带
       * 进来，于是分母变成别的东西 —— 覆盖率读数就不再是「`src` 的行覆盖率」。
       */
      include: ['src/**'],
      /**
       * ⚠️ **要排除就写在这里并给出理由，不要靠调阈值掩盖未测文件**（R270 逐字）。
       * 下面这个文件**没有任何可执行逻辑**，所以它不是「尚未测试」：
       *
       * ⚠️ 必须 `...coverageConfigDefaults.exclude` 打头：`coverage.exclude` 是**整体覆盖**
       * 而不是增量 —— 自己写一个数组会把 vitest 默认的 `**\/*.test.ts` / `dist` /
       * `node_modules` 一并**取消**，于是测试文件自己进了分母（本片实测：`*_test.ts`
       * 赫然出现在报告里）。那会让这个数字不再是「`src` 生产代码的行覆盖率」。
       */
      exclude: [
        ...coverageConfigDefaults.exclude,
        // 唯一的一项：纯 re-export 的入口 —— 整个文件只有 `export * from '…'` 行
        // （R270 点名的例子）。
        //
        // ⚠️ R361（独立小片 P7）：这里**原先还有第二项** `src/protocol/message.ts`
        // （理由写的是「纯类型声明，编译后是空文件」）。那个文件是一份与
        // `docs/design.md` §6.1/§6.2/§6.3 逐字冲突的**遗留第二契约**，已随 R361
        // **整条删除** ⇒ 指向它的排除项与那段注释一并删除：排除项指空 = 一条
        // 供着不存在文件的死配置（而它会让下一个 session 以为源码里还有那个文件）。
        'src/index.ts',
      ],
      reporter: ['text'],
      /**
       * §13.3：**`packages/shared` 行覆盖率 ≥ 80%**，低于门槛**必须失败**（R270）。
       *
       * 门槛本身是判据的一部分：走产品脚本
       * `pnpm --filter @fight-the-landlord/shared test:coverage` 时低于 80% **非零退出**
       * （本片已实测：临时改成 99 ⇒ 红；见计划文件「执行期裁决（回填区）」）。
       */
      thresholds: { lines: 80 },
    },
  },
});
