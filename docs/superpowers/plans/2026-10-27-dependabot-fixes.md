# Dependabot 漏洞修复（2026-10-27）

## 背景

GitHub Dependabot 在 `dev`/默认分支报告 67 条 open alert（17 critical / 7 high / 34 medium / 9 low）。
按包归并后只有 **15 个包**；其中 vitest（30 条）、vite（16 条）占 46 条，其余为可 override 的传递依赖。

## 范围与决策

| 包 | 修复前 | 修复后 | 方式 |
|---|---|---|---|
| vitest | 2.1.9（含自定义补丁） | 4.1.12 | 全仓 14 个 package.json 升级；@vitest/coverage-v8 同步 4.1.12 |
| vite | 5.4.21 | 6.4.4 | apps/client 直接依赖升级；移除根 `pnpm.overrides.vite` 全局钉死 |
| @vitest/mocker | 2.x（随 vitest） | 4.1.12 | 随 vitest 4 |
| tinypool | 1.1.1（随 vitest 2） | 不再安装 | 随 vitest 4 |
| @vue/server-renderer | 3.4.21 | 3.5.43 | override `^3.5.42` |
| path-to-regexp | 0.1.10 | 0.1.13 | override `path-to-regexp@0.1` |
| fast-uri | 3.0.x | 3.1.9 | override |
| qs | 6.13/6.14 | 6.16.0/6.16.1 | override |
| @intlify/core-base | 9.1.11 | 9.14.5 | override（message-resolver 保持 9.1.11） |
| esbuild | 0.20.2 / 0.24.2 | 0.25.12 | override `^0.25.0` |
| phin | 3.7.0 | 3.7.1 | override |
| @babel/core | ≤7.29.0 | 7.29.7 | override |
| cookie | <0.7.0 | 0.7.2 | override |
| postcss-selector-parser | 6.1.x | 6.1.5 | override |
| send | <0.19.0 | 0.19.0/0.19.2 | override |

> 决策：**不保留 vitest 2.1.9 自定义补丁**（`pnpm.patchedDependencies` 移除）。该补丁修的是
> vitest 2 的临时文件并发写假红；vitest 4 已重写该路径。`patches/vitest@2.1.9.patch`
> 与 Dockerfile 的 `COPY patches ./patches` 暂保留（删除它们需同步改 10 个 Dockerfile，
> 另立清理片），但已不再被引用。

## 兼容性改动（升级带来的必要适配）

1. **Vitest 4 会把 `dist/*.test.js` 收进测试集合**：protocol / shared 的 vitest 配置显式
   `exclude: ['dist/**','node_modules/**']`。
2. **Vitest 4 的 `vi.fn(箭头函数)` 不可 `new`**：ioredis 构造器替身改为普通 `function`
   （game/robot/room/payment/currency/api-gateway 的 config-cache/health 替身）。
3. **Vitest 4 的 `Mock<Procedure | Constructable>` 不再可直接调用**：对
   `getMockImplementation()` / 桩 getter 调用点补具体函数类型（room/api-gateway/payment）。
4. **测试 tsconfig 关闭 declaration emit**（12 个 `tsconfig.test.json`）：Vitest 4 的
   `@vitest/spy` 类型无法在没有内部路径引用时生成 `.d.ts`（TS2742）；测试本就 `noEmit`。
5. **protocol / shared 补 `@types/node`，移除 `types: []`**：升级后 TypeScript 5.9 不再
   从根提升中解析 Node 类型，而两包的源码/测试确实使用 `node:*`。
6. **apps/client 补 `@types/node` 与 `types: ["node"]`**：Vite 6 依赖图不再提升 Node 类型，
   测试使用 `node:fs`/`process`。
7. **payment/currency 测试回调补显式参数类型**：Vitest 4 的 `mock.calls` 在未标注 spy
   上退化为 `any`，触发 `noImplicitAny`。

## 验证

- `pnpm exec turbo run test lint build --force`：**44/44 successful，0 cached**（1m44s）。
- 各包测试：protocol 304 / shared 404 / game 278 / room 1003 / user 409 / payment 464 /
  currency 590 / client 1541（2 skipped）等。
- `pnpm -C apps/client run build`（vue-tsc + uni build）：**DONE Build complete**（Vite 6.4.4）。
- 安装版本核对（`pnpm list -r --depth Infinity`）：上表「修复后」全部命中；tinypool 不再安装。
- `pnpm audit` 不可用（registry 为 npmmirror，无 audit endpoint）；以 Dependabot 清单 +
  `first_patched_version` 逐包核对。

## 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| uni-app 只声明 `vite: 5.2.8` peer | 我们用 Vite 6.4.4 构建成功、测试全绿，但上游未声明支持 | 监控；若后续 uni 升级仍锁 Vite 5，可回退 client 的 vite 并接受该组 dev-only 告警 |
| esbuild 0.25 override 覆盖 uni-cli-shared 的 0.20.2 | 构建成功 | 已由 client build 实测 |
| Vitest 4 行为变化 | 已修 7 类测试/配置适配 | 全仓 44/44 绿 |
| `patches/` 与 Dockerfile COPY 暂留 | 已无 patchedDependencies | 另立清理片删除；当前不参与安装 |
| Dependabot 重扫延迟 | push 后 GitHub 异步更新 alert | 推送后复查；未清零则按残留项继续 |

## 涉及文件

- 根：`package.json`（overrides、移除 patchedDependencies/vite 钉死）、`pnpm-lock.yaml`
- 14 个 `package.json`（vitest/coverage 升级）、`apps/client/package.json`（vite 6.4.4 + @types/node）
- `apps/client/tsconfig.json`、`packages/protocol|shared/tsconfig.json`、12 个 `tsconfig.test.json`
- `packages/protocol|shared/vitest.config.ts`
- 7 个 ioredis 替身/健康测试、5 个 spy 调用类型适配、`packages/shared/test/dockerfile-patches-copy.gate.test.ts`

## 审查记录

- 待独立代码审查。
