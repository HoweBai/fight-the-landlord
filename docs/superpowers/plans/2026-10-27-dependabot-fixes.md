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
| phin | 2.9.3 | 3.7.1 | override（仅 `@jimp/core` 链路，mp-weixin 构建实测通过） |
| @babel/core | ≤7.29.0 | 7.29.7 | override |
| cookie | <0.7.0 | 0.7.2 | override |
| postcss-selector-parser | 6.1.x | 6.1.5 | override |
| send | <0.19.0 | 0.19.0/0.19.2 | override |

> 决策：**不保留 vitest 2.1.9 自定义补丁**（`pnpm.patchedDependencies` 移除）。该补丁修的是
> vitest 2 的临时文件并发写假红；vitest 4 已重写该路径。`patches/vitest@2.1.9.patch`
> 与 Dockerfile 的 `COPY patches ./patches` 暂保留（删除它们需同步改 10 个 Dockerfile，
> 另立清理片），但已不再被引用。
>
> **2026-10-28 已清理**：`patches/` 与 10 个 Dockerfile 的 `COPY patches ./patches` 已删除；
> `dockerfile-patches-copy.gate.test.ts` 改为双向闸（有 patchedDependencies ⇒ 必须 COPY；
> 为空 ⇒ 禁止 COPY）。

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
- `pnpm -C apps/client run build`（vue-tsc + uni build）：**DONE Build complete**（Vite 6.4.4）；
  `build:mp-weixin` 与 `build:app` 同样 **DONE**（覆盖 uni 插件、jimp/phin 链路）。
- 安装版本核对（`pnpm list -r --depth Infinity`）：上表「修复后」全部命中；tinypool 不再安装。
- `node scripts/security/check-audit.mjs`（`pnpm audit --prod` + npmjs registry）：
  **exit 0，0 条去重通告，critical/high 未处理 0 条，豁免 0 条**。
  （默认 registry 为 npmmirror，没有 audit endpoint，这是门脚本显式切 npmjs 的原因。）
- `pnpm install --frozen-lockfile`：通过（lockfile 与 package.json 一致）。

## 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| uni-app 只声明 `vite: 5.2.8` peer | 我们用 Vite 6.4.4 构建成功、测试全绿，但上游未声明支持 | 监控；若后续 uni 升级仍锁 Vite 5，可回退 client 的 vite 并接受该组 dev-only 告警 |
| esbuild 0.25 override 覆盖 uni-cli-shared 的 0.20.2 | 构建成功 | 已由 client build 实测 |
| Vitest 4 行为变化 | 已修 7 类测试/配置适配 | 全仓 44/44 绿 |
| `patches/` 与 Dockerfile COPY 暂留 | 已无 patchedDependencies | **2026-10-28 已清理**（目录与 10 处 COPY 删除；双向闸落地） |
| Dependabot 重扫延迟 | push 后 GitHub 异步更新 alert | 推送后复查；未清零则按残留项继续 |

## 涉及文件

- 根：`package.json`（overrides、移除 patchedDependencies/vite 钉死）、`pnpm-lock.yaml`
- 14 个 `package.json`（vitest/coverage 升级）、`apps/client/package.json`（vite 6.4.4 + @types/node）
- `apps/client/tsconfig.json`、`packages/protocol|shared/tsconfig.json`、12 个 `tsconfig.test.json`
- `packages/protocol|shared/vitest.config.ts`
- 7 个 ioredis 替身/健康测试、5 个 spy 调用类型适配、`packages/shared/test/dockerfile-patches-copy.gate.test.ts`

## 审查记录

### 2026-10-27 独立代码审查

结论：1 Critical / 3 Important / 3 Minor，全部处置后复跑。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| C1 | Critical | `audit-exceptions.json` 的 3 条豁免已失效，`check-audit` 会红 | 已清空豁免；`slice-07.4` 的 `wantEx` 同步为空；门脚本实测 exit 0 |
| I1 | Important | `send` override 未分主版本，把 express 5 的 `send ^1` 降到 0.19 | 改为 `send@0`：express 4 用 0.19.2、express 5 用 1.2.1 |
| I2 | Important | `postcss-selector-parser` override 未分主版本，覆盖了 7.x 消费者 | 改为 `postcss-selector-parser@6`：6.1.5 与 7.1.7 并存 |
| I3 | Important | phin 3.7.1 可能破坏 `@jimp/core`；Vite 6 只验了 H5 | `build:mp-weixin` 与 `build:app` 实测通过 |
| M1 | Minor | 残留 Vite5/patchedDependencies 注释 | 已更新 `vite.config.ts`、`docs/design.md`、10 个 Dockerfile 注释 |
| M2 | Minor | 本文旧版本号/"pnpm audit 不可用" | 已订正为 phin 2.9.3、门脚本切 npmjs |
| M3 | Minor | 测试适配判别力 | 确认仅类型层；调用次数/行为断言未删 |

审查后复跑：`turbo run test lint build --force` 44/44；`check-audit` exit 0；
H5/mp-weixin/app 三端构建通过。
