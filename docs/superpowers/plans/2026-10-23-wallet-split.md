# 钱包拆分实施计划（2026-10-23）

Spec: `docs/superpowers/specs/2026-10-23-wallet-split-design.md`

## Global Constraints

- 纯客户端：不改协议 / 服务端 / 配置中心 / 数据库 / admin。
- 样式只用 `src/uni.scss` 的 `$ftl-*` 令牌；组件样式禁 `@use`，用 `@import`/直接 `@include`。
- `src/**` 裸依赖只允许 `pinia` / `socket.io-client` / `vue`（`source-boundary` 闸）。
- 每个任务：先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交（带 attribution）。
- 验证口径（用户裁决）：只跑受影响测试文件；最后跑 `npx vue-tsc --noEmit`。
- 不夹带无关重构；一个任务一个 commit。

## Task 1：game store 共享摘要 + 错误 + 序号 + 记录失效标记

**Files**: `apps/client/src/stores/game.ts`、`apps/client/test/game-store-session-reset.test.ts`

1. RED：在 `game-store-session-reset.test.ts` 加断言（序号用**相对关系**，不写死 1/2/3）：
   - `const a = beginWalletSummaryRequest()`；`applyWalletSummary({...}, a) === true`，
     `walletBalance === 100`；
   - `const b = beginWalletSummaryRequest()`；旧序号 `applyWalletSummary(..., a) === false`
     且摘要仍是 b 的结果；
   - `applyWalletSummary` 成功后 `walletSummaryError === ''`；
     `setWalletSummaryError('x', b) === true`，旧序号错误返回 false；
   - `reset()` 后 `walletSummary === null` / `walletSummaryError === ''` /
     `walletRecordsStale === false`，且**旧序号** apply 返回 false（seq 自增，不归 0）。
2. 实现：state `walletSummary` / `walletSummaryError` / `walletSummarySeq` /
   `walletRecordsStale`；actions `beginWalletSummaryRequest(): number`、
   `applyWalletSummary(s, seq): boolean`、`setWalletSummaryError(text, seq): boolean`；
   `reset()` 清四项并 `walletSummarySeq += 1`。
3. GREEN；提交。

## Task 2：`useWalletSummary` 组合式

**Files**: `apps/client/src/composables/useWalletSummary.ts`（新增）、
`apps/client/test/wallet-summary.test.ts`（新增）

接口：

```ts
export interface WalletSummaryView {
  balance: number;
  withdrawable: number;
  dailyWithdrawRemainingCoins: number;
}
export function useWalletSummary(opts: {
  setError: (text: string, retry?: () => void) => void;
  dismiss: () => void;
}): {
  summary: ComputedRef<WalletSummaryView | null>;
  /** 从 store 派生（单一真源）——任一页取数成功，两页的失败态同时退场。 */
  summaryError: ComputedRef<string>;
  loadSummary: (replayed?: boolean) => Promise<void>;
}
```

1. RED（新测试，stub `pay.fetchPayWalletSummary`）：
   - 成功 ⇒ store 摘要与 `walletBalance` 更新、`dismiss` 被调、`walletSummaryError` 清空；
   - 信封非 0 ⇒ `setError(文案, retry)`，旧摘要保留；
   - `code===0 && data===null` ⇒ 同样走失败处置（不得静默当成功）；
   - fetch 拒绝 ⇒ 同上，且不抛 unhandled；
   - **乱序**：先发的慢响应晚到 ⇒ `applyWalletSummary` 返回 false 的一发**不** dismiss、
     **不** setError（序号由 `beginWalletSummaryRequest` 在调用时取得）。
2. 实现：从 `wallet.vue:126-173` 搬移取数与错误处置；成功/失败都走 store 的序号化
   action，只有生效的一发才操作本页 notices。
3. GREEN；提交。

## Task 3：充值子页

**Files**: `apps/client/src/pages/wallet/recharge.vue`（新增）、`src/pages.json`、
`test/wallet-recharge.test.ts`（新增）、`test/helpers/wallet-fixtures.ts`（新增）、
`test/wallet-page.test.ts`（删充值 describe）、`test/page-stack.test.ts`、
`ui-tokens.test.ts`、`landscape-canvas.test.ts`、`table-hud.test.ts`、
`notice-presentation.test.ts`

0. **共享夹具**：抽 `test/helpers/wallet-fixtures.ts`（`stubFetch` / `ok` / `err` /
   `summaryData` / `makeRoute` / `countCalls` / `T0`）。`noUnusedLocals` 覆盖 `test/**`，
   所以每个测试文件**只导入用到的符号**；`order/refund/withdrawFixture` 留给各自文件。
1. RED：
   - 把 `wallet-page.test.ts` 的 `describe('② 充值…')`（约 380-529 行）搬成
     `wallet-recharge.test.ts`，mount `RechargePage`；本文件按需 mock
     `../src/net/pay` 的 `jumpToCashier`（工厂内不得引用顶层 const，vi.mock 会 hoist）；
     补：
     - `rechargeEnabled=false` ⇒ 只显「充值暂未开放」，无档位按钮；
     - 档位卡两行文案 + `pay-package-{yuan}`；
     - `coinPerYuan=null` 只显「{N} 元」；**等高走源码级规则体断言**
       （jsdom 无布局）：`.wallet-recharge__package` 规则体含 `min-height`；
     - `rechargePackages=[]` ⇒「暂无充值档位」；
     - `creating` 期间全部禁用；
     - 失败/降级提示落 `NoticeStack`。
   - 从 `wallet-page.test.ts` 删除已搬走的 describe（含不再使用的 import/fixture）。
   - `pages.json` 加 `recharge`；各页面清单闸加 `.wallet-recharge` / 标题「充值」。
     ⚠️ `page-stack` 有**两处**字面量（声明路径 + `declared.slice`）；`ui-tokens`
     是 required 清单（`>=7` 下限不变，清单 +1 并改注释）；`notice-presentation` 的循环
     必须改成显式 `{name, file}` 路径对（子页不是 `${page}/${page}.vue`）。
2. 实现 `recharge.vue`：`LandscapeStage` + `NoticeStack`（`surface="wallet"`），
   单根 `.wallet-recharge`；bar（返回 + 标题）；当前余额行；档位卡网格（底分卡语言，
   等高 min-height + 内容区 `scroll-view`）；`onBuyPackage`、`creating`、`jumpToCashier`、
   `pay-hint` 原样搬移；钩子 `pay-package-{yuan}`。
3. GREEN（`wallet-recharge` + `wallet-page` + 五个清单闸）；提交。

## Task 4：提现子页

**Files**: `apps/client/src/pages/wallet/withdraw.vue`（新增）、`src/pages.json`、
`test/wallet-withdraw.test.ts`（新增）、`test/wallet-page.test.ts`（删提现 describe）、
五个清单闸

1. RED：搬 `describe('③ 提现…')` 与 `describe('③-B 提现再认证')`（约 531-682 行）到
   `wallet-withdraw.test.ts`，mount `WithdrawPage`；**本文件不 mock `net/pay`**
   （走真 `applyPayWithdrawal` + fetch 桩）；再认证用例需要 `installUniStub()`
   （`uni.showModal` 替身）；补：
   - 数据卡/说明卡数值来自摘要与配置；
   - `withdrawEnabled=false` ⇒ 只显「提现暂未开放」；
   - `summary=null` ⇒ 数据卡显「—」、`null` 说明卡不渲染；
   - 成功 ⇒ 摘要刷新（store 序号化写入）+ `walletRecordsStale === true`；
   - **输入与按钮等高走源码级规则体断言**（都取 `$ftl-control-h`）；
   - 五项预检/再认证/服务端文案保持。
2. 实现 `withdraw.vue`：根 `.wallet-withdraw`；bar + 数据卡网格（`.wallet-withdraw__stat`）
   + 输入行（等高 88）+ 说明卡网格（`.wallet-withdraw__limit`）；
   `useWalletSummary`；`validateWithdrawCoins`、`askPassword`、`onSubmitWithdraw` 搬移；
   内容区 `scroll-view`；`NoticeStack surface="wallet"`。
3. GREEN；提交。

## Task 5：钱包页 A1 + 入口卡 + 失效标记消费

**Files**: `apps/client/src/pages/wallet/wallet.vue`、`test/wallet-page.test.ts`

1. RED：改 `wallet-page.test.ts`（`beforeEach` 装 `installUniStub()`，断言 `uni.calls.navigateTo`）：
   - ① 改为「余额条 + 两张入口卡 + 记录区」；
   - 开关分别隐藏入口卡；两开关全关 ⇒ 入口区无按钮、余额/记录仍在；
   - 点入口卡 ⇒ `navigateTo` 目标与 `pages.json` 逐字一致；
   - `walletRecordsStale=true` ⇒ 钱包页重取**提现 tab**（当前 tab 是订单也要重取）；
   - 提现列表加载中置标记 ⇒ `loadTab('withdrawals').finally` 后补一次重取（不丢刷新）；
   - **改既有回跳断言**（原 `wallet-page.test.ts:856` 钉「挂载即清载体」）：挂载后载体仍在、
     终态/`dismissReturn` 后才为 null（重挂可重启轮询）；
   - 跨页失败态：钱包页失败后另一处成功取数 ⇒ 钱包页失败行与 sticky 项退场。
2. 实现：
   - 删除 `__left`/两栏 grid，改 A1 纵向 flex；
   - 入口卡 + 钩子 `wallet-recharge-entry` / `wallet-withdraw-entry`；
   - 摘要改 `useWalletSummary`（`summaryError` 读 store 派生值）；
     `walletSummaryError` 清空时 `dismiss('summary')`；
   - 删已搬走的充值/提现逻辑与样式；
   - 本地 `withdrawalsStale` + `refreshWithdrawals()`（loading 时留到 `finally`）；
     挂载首查 store 标记；
   - `startReturnFlow` 不再在挂载时清 `walletReturnOrderNo`，终态/`dismissReturn` 才清。
3. GREEN；提交。

## Task 6：代码审查与收口

1. 独立 reviewer 审 `BASE..HEAD` diff（spec/plan 对照）。
2. Critical/Important 修复 + 补测试。
3. 受影响测试全绿 + `vue-tsc --noEmit`。
4. 回填 spec「审查记录」；确认工作区干净；交付报告。

## 回归命令

```bash
cd apps/client
npx vitest run test/wallet-summary.test.ts test/wallet-recharge.test.ts \
  test/wallet-withdraw.test.ts test/wallet-page.test.ts test/page-stack.test.ts \
  test/ui-tokens.test.ts test/landscape-canvas.test.ts test/table-hud.test.ts \
  test/notice-presentation.test.ts test/game-store-session-reset.test.ts \
  test/source-boundary.test.ts test/http.test.ts test/import-meta-guard.gate.test.ts
npx vue-tsc --noEmit
```

## 计划审查记录

### 2026-10-23 计划对抗审查（独立 reviewer · sonnet · 单轮）

| 级别 | 发现 | 处置 |
|---|---|---|
| 高 H1 | 测试拆分未定共享夹具；`noUnusedLocals` 覆盖 `test/**` | 已修：抽 `test/helpers/wallet-fixtures.ts`，各文件只导入用到的符号 |
| 高 H2 | jsdom 无布局 ⇒ 等高断言恒真假绿 | 已修：Task 3/4 改为源码级规则体断言 |
| 高 H3 | `summaryError` 两处真源 | 已修：接口返回 store 派生的 ComputedRef |
| 高 H4 | 序号化 action 缺 boolean 契约 | 已修：Task 1 明确返回 boolean + 旧序号用例 |
| 高 H5 | `reset()` 归 0 会让旧会话在途响应写回 | 已修：改为自增 seq，断言「重置后旧序号被忽略」 |
| 高 H6 | `notice-presentation` 循环无法表达子页路径 | 已修：改成显式 `{name, file}` 路径对 |
| 低 L1–L8 | uni 替身 / 命名表 / 回跳断言冲突 / vi.mock 边界 / 回归面 / 相对序号 / 空响应分支 / 闸判别力 | 已修：Task 5 装 uni 替身并列明回跳断言改动；spec §4.7 命名表；Task 3/4 写明 mock 边界；回归命令补 source-boundary 等；spec §5/§6 修正闸判别力描述 |

结论：修订后开工（无阻断项）。

## 代码审查记录

### 2026-10-23 代码对抗审查（独立 reviewer · sonnet · 单轮；`27809b7b..943e7418`）

- Critical：无。
- Important I-1：提现子页缺 `watch(summaryError)` ⇒ 跨页成功后 sticky 项滞留、后台失败无重试出口。
  已修：两页都注册同一 watcher（`'' ⇒ dismiss`；非空 ⇒ `setError(..., loadSummary)`），并补跨页用例。
- Important I-2：B1 判据未按 spec 的 `loaded=true` 形态落测（假绿面）。
  已修：先加载提现 tab、切回订单、再置标记；断言强制重取 + 不切 tab + 数据被替换；并做变异自证。
- Minor：挂载首查无用例（已补）、空响应保留旧摘要恒真（已补旧值）、充值守卫无判别力断言（已删）、
  空摘要/空配置提交判据缺失（已补）、回跳载体边界（onBack + reset 清）、注释/死选择器/口径数字（已修）。

结论：Critical/Important 清零，受影响测试 197/197 + `vue-tsc` 通过，可交付。
