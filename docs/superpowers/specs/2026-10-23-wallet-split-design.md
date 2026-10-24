# 钱包页拆分：充值 / 提现双子页 + A1 布局（2026-10-23）

## 1. 背景与问题

钱包页当前把四块内容（余额 / 充值 / 提现 / 记录）塞进左右两栏：左列 620px 里
「余额 → 5 个金色档位按钮 → 提现输入 + 4 行限额」自上而下堆叠，750 高的画布必须滚动；
6 个金色主按钮连成一片，充值（高频主操作）与提现（低频敏感操作）没有视觉分界，
右侧记录区反而留白过多。用户裁决：拆成「两个入口卡 + 两个子页」，钱包页改 A1 布局
（顶部横条 + 全宽记录），子页元素用底分卡片式排列。

## 2. 范围

**做**（纯客户端）：

- 钱包页瘦身：余额条 + 充值/提现两张入口卡 + 支付回跳面板 + 全宽记录区。
- 新增两个分包子页：`pages/wallet/recharge`、`pages/wallet/withdraw`。
- 充值/提现的逻辑原样搬移到子页（校验、再认证、下单、跳收银台、文案）。
- 子页 UI 用「底分卡」语言：描边卡片 + 金色数字强调 + 网格对齐，不拥挤。
- 钱包摘要上移 game store，两页共享一份，返回后不显旧值。

**不做**（YAGNI）：

- 不改协议 / 服务端 / 配置中心 / 数据库 / admin。
- 不加新的支付方式、提现快捷额度、充值优惠等业务能力。
- 不改大厅钱包入口（`wallet-entry` 钩子与行为不变）。
- 不改回跳 `?pay=` 的轮询语义（仍归钱包页）。

## 3. 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 双入口 + 两个分包子页，`navigateTo` 压栈、`navigateBack` 返回 | 用户裁决；与历史战绩子页同款导航；子页空间独立，彻底解决拥挤 |
| D2 | 钱包页 A1：顶部横条（余额面板 + 右侧入口卡）+ 回跳面板 + 全宽记录 | 用户裁决；窄左列删除，右侧空间全部给记录 |
| D3 | 子页元素一律卡片化（底分卡语言），网格排布 | 用户要求；底分卡是本仓已验证的等高等齐卡片语言 |
| D4 | 钱包摘要上移 `game` store（摘要 + 错误 + 请求序号）；`useWalletSummary` 组合式取数 | `navigateBack` 在 App 不重挂、H5 可能重挂；共享一份状态才不会显旧值，序号拦乱序覆盖 |
| D5 | 提现成功置 `walletRecordsStale`；钱包页消费时**失效并重取「提现」tab**（不是当前 tab） | `selectTab` 只在 `loaded=false` 时取数（`wallet.vue:344-348`），只看当前 tab 会让已看过的提现列表永久陈旧 |
| D6 | 支付回跳 `?pay=` 留在钱包页 | 收银台跳转是整页重载，回来自动落在钱包页；子页不承担回跳 |
| D7 | 开关关闭时隐藏入口卡；直链进关闭的子页显示静态提示 + 返回 | 两开关是暗上线闸；直链兜底不渲染死表单 |
| D8 | 两个子页各挂 `LandscapeStage` + `NoticeStack`（`surface="wallet"`），根节点单根 | 八页统一纪律（单根闸 / 画布闸 / 浮层闸）；`NoticeSurface` 是闭集，不新增成员 |
| D9 | 卡片样式只用 `$ftl-*` 令牌，逐项重置 `uni-button` 宿主默认样式 | 仓内既有纪律（底分卡注释逐字记载） |

## 4. 实现设计

### 4.1 页面与路由

`pages.json` 的 `pages/wallet` 分包新增两项：

```
pages/wallet/recharge  → src/pages/wallet/recharge.vue  （标题：充值）
pages/wallet/withdraw  → src/pages/wallet/withdraw.vue  （标题：提现）
```

入口卡点击：`uni.navigateTo({ url: '/pages/wallet/recharge' | '/pages/wallet/withdraw' })`。
子页返回：`uni.navigateBack({ delta: 1 })`。

### 4.2 钱包页（`wallet.vue`）

```
返回  钱包
┌──────────────────────┬────────────────────────┐
│ 余额 🪙 N            │ [ 充值 → ] [ 提现 → ]  │
│ 可提额度 M            │                        │
└──────────────────────┴────────────────────────┘
┌─ 充值订单面板（仅 ?pay= 回跳时出现，全宽） ─────┐
└──────────────────────────────────────────────┘
┌─ 记录 [订单][退款][提现] + 列表（全宽，flex 1） ─┐
└──────────────────────────────────────────────┘
```

- 删除 `.wallet__body` 两栏 grid 与 `.wallet__left` 滚动容器；改 `<view class="wallet__body">`
  纵向 flex（`flex: 1; min-height: 0`），记录面板 `flex: 1 1 auto; min-height: 0`。
- `.wallet__top`：`display:flex; align-items:stretch; gap: $ftl-space-5`。
  余额面板 `flex: 1 1 auto`；入口区 `display:flex; gap:$ftl-space-4; margin-left:auto`。
- 入口卡（`<button>`，钩子 `wallet-recharge-entry` / `wallet-withdraw-entry`）：
  竖排两行（标题 + 一句说明），`min-width: 240px; min-height: $ftl-control-h`，
  逐项重置 `uni-button` 默认样式。充值卡 = 金描边 + 金字（`$ftl-color-gold-deep` /
  `$ftl-color-gold-light`），提现卡 = 中性描边 + 白字；两者都不铺实心金底，
  避免再次形成「金色按钮墙」。
- 余额/可提额度读共享摘要（D4）；余额变化仍同步 `store.walletBalance`（大厅 chip 同源）。
- `watch(() => store.walletRecordsStale)`：为真 ⇒ 先置 false 并置本地 `withdrawalsStale`
  ⇒ `refreshWithdrawals()`：
  - `lists.withdrawals.loading` 时**不调度、保留本地标记**，在 `loadTab('withdrawals')`
    的 `finally` 里再消费（在途请求可能早于提现提交）；
  - 否则 `reloadTab('withdrawals')`（**固定提现 tab**，与当前 activeTab 无关）。
  - 挂载时也查一次 store 标记（H5 重挂形态）。
- 回跳面板、记录三 tab、分页逻辑保持原样；记录行保持现单行 flex 形态（全宽后单号
  仍靠右，不做列重排）。

### 4.3 充值子页（`recharge.vue`）

```
返回  充值
┌ 当前余额 🪙 N（未知不显示） ────────────────────┐
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│ │ 6 元  │ │ 30 元 │ │ 68 元 │ │ 128 元│ │ 328 元│ │
│ │600 金币│ │3000金币│ │6800金币│ │1.28万│ │3.28万│ │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ │
└──────────────────────────────────────────────┘
```

- 档位卡片：`<button class="wallet-recharge__package pay-package-{yuan}">`，
  `flex-direction: column; align-items: flex-start`，两行：金额（`font-lg`、金色、700）+
  金币数（`font-sm`、`rgba(white,.75)`）；卡语言逐项照底分卡（padding 12/16、2px 描边、
  `$ftl-radius-md`、透明底、`font: inherit`、`margin: 0`）。
- 网格：`display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: $ftl-space-4`。
  账目：最小设计宽 **1334**（`uni.scss` 的 16:9 最紧档）− 页面 padding 2×16 − 面板 padding
  2×24 = **可用 1254**；5×220 + 4×8 = **1132 ≤ 1254**，单行放得下；档位少时自动拉宽对齐。
- **等高**（底分卡同款教训）：卡给 `min-height: $ftl-space-5*2 + $ftl-font-lg*1.2 +
  $ftl-space-3 + $ftl-font-sm*1.2` 的两行满配兜底 —— `coinPerYuan=null` 时只有一行文案，
  同排卡不得出现描边框一长一短。
- `coinPerYuan === null` ⇒ 只显示「{N} 元」（不编比率，规格 §4 原纪律）。
- 内容区用 `scroll-view scroll-y`（档位数是配置中心值，超出一屏不得被 `overflow:hidden`
  裁掉且不可达）；`rechargePackages=[]` ⇒ 「暂无充值档位」。
- 下单逻辑原样搬移：`creating` 期间全部禁用；失败/降级提示走本页 `NoticeStack`；
  钩子 `pay-package-{yuan}` 不变。
- `rechargeEnabled === false` ⇒ 只显示「充值暂未开放」静态行。

### 4.4 提现子页（`withdraw.vue`）

```
返回  提现
┌ 可提额度 ┌ 当日剩余 ┐        ← 数据卡（网格）
│  8000    │   5000   │
└──────────┴──────────┘
┌ 提现金额 [ 输入框 ] [ 申请提现 ] ┐   ← 等高 88
└──────────────────────────────────┘
┌ 门槛 ┌ 单笔上限 ┌ 单日上限 ┐     ← 说明卡（网格，值为 null 的卡不渲染）
└──────┴──────────┴──────────┘
```

- 数据卡/说明卡用 `<view>`（不可点，不用 button）：小标题（`font-xs`、白 75%）+ 数值
  （数据卡 `font-lg` 金色 700，说明卡 `font-md` 白 90%）。
- `summary === null`（未取到）⇒ 数据卡数值显「—」（**禁止回落 0**）；配置值为 null ⇒
  对应说明卡整卡不渲染；本地预检跳过 null 项，提交不禁用（服务端锁内校验是唯一权威）。
- 内容区用 `scroll-view scroll-y`（小高度画布不裁内容）。
- 输入框 `min-height: $ftl-control-h`（88），与提交按钮等高（修掉现状 56 vs 88 不齐）。
- 本地预检五项、再认证（`askPassword` + `reauth`）、服务端 message 逐字、成功静态行
  原样搬移；钩子 `withdraw-input` / `withdraw-submit` 不变。
- 成功 ⇒ 刷新摘要（余额/可提/日剩余）→ `store.walletRecordsStale = true`。
- `withdrawEnabled === false` ⇒ 只显示「提现暂未开放」静态行。
- 摘要失败 ⇒ 静态行「钱包信息暂不可用」+ 浮层 `summary` 错误项（可重试）。

### 4.5 共享状态与取数

`stores/game.ts`：

- `walletSummary: { balance; withdrawable; dailyWithdrawRemainingCoins } | null`（默认 null）。
- `walletSummaryError: string`（默认 ''；静态失败行由它派生，**成功时由 store 清除**，
  避免两页各自持 error 导致「新余额 + 旧失败行」同屏）。
- `walletSummarySeq: number`（默认 0；请求世代号）。`beginWalletSummaryRequest()` 自增并返回，
  `applyWalletSummary(s, seq)` / `setWalletSummaryError(text, seq)` 只在 `seq >= 当前值` 时生效
  （返回 boolean）——乱序慢响应与旧会话在途响应都被拦掉。
- `walletRecordsStale: boolean`（默认 false）。
- `applyWalletSummary` 生效时写摘要、清 `walletSummaryError`，`s !== null` 时同步
  `walletBalance = s.balance`。
- `reset()`：与 `walletBalance` 同处清空 `walletSummary` / `walletSummaryError` /
  `walletRecordsStale`，并**自增** `walletSummarySeq`（不是归 0——归 0 会让旧会话在途
  请求变成「更新序号」而写回）。

`composables/useWalletSummary.ts`：

```
useWalletSummary(opts: { setError(text, retry?); dismiss() })
  → { summary, summaryError, loadSummary }
```

- `summaryError` 是 store 的 **ComputedRef**（单一真源；成功在任一页发生，两页同时退场）。
- 取数逻辑从 `wallet.vue:132-173` 原样搬移（`dispatchRestFailure` / `playerMessage` /
  `reportError` / 会话结束处置）；每发取数先 `store.beginWalletSummaryRequest()` 拿序号。
- 成功：`store.applyWalletSummary(data, seq)` 返回 true 才 `dismiss()`；返回 false
  （被更新的响应超越）⇒ 不操作本页 notices。
- 失败（含 `code===0 && data===null` 的空响应分支）：`store.setWalletSummaryError(text, seq)`
  生效才 `setError(text, 重试)`；旧摘要保留（不擦成空）。

### 4.6 错误处理与边界

- 子页直链 + 开关关闭：静态提示行，不渲染表单/档位，不发起下单/提现请求。
  （直链时客户端配置可能尚未装载 ⇒ 未知按 false 处理，显示「暂未开放」——沿用 C19
  「未知 = 隐藏」语义，属刻意行为。）
- 提交在途：入口/按钮禁用位生命周期只罩请求本身（先放行再处置，沿用原注释的
  重放陷阱结论）。**已知缺口（登记）**：再认证密码框期间 `withdrawBusy` 尚未置位，
  重复提交窗口与现状相同 —— 本片不扩大范围修复。
- **两种页面模型都正确**：App 上 `navigateBack` 不重挂钱包页；H5 存在重挂形态
  （`net/pay.ts:113-122` 记录的大厅重挂即同族）。因此：
  - 摘要与错误在 store，重挂与否都读同一份；
  - `walletRecordsStale` 在挂载时也查一次；
  - 回跳单号改为**终态/用户关闭后才清** `store.walletReturnOrderNo`（不再在钱包页
    挂载即清）：重挂后能凭它重启轮询；`?pay=` URL 仍只在首次消费。
- 提现返回：标记只被钱包页消费一次；若提现列表正在加载，保留本地标记，待 `finally`
  再重取（在途响应可能早于提交）。
- 两开关全关：钱包页只剩余额条 + 记录（页面不空），大厅入口恒在的既有规则不变。
- 记录行保持单行 flex（状态/金额/时间靠左、单号靠右）；全宽后不重排列。
- 子页「返回」在直链（栈深 1）时无效果 —— 与 history/wallet 现有形态一致，
  登记为既有局限，不在本片加栈深兜底。

### 4.7 命名表（闸与测试共用）

| 面 | 值 |
|---|---|
| 钱包页根 | `.wallet`（不变） |
| 充值页根 / 标题 | `.wallet-recharge` / `充值` |
| 提现页根 / 标题 | `.wallet-withdraw` / `提现` |
| 入口卡钩子 | `wallet-recharge-entry` / `wallet-withdraw-entry` |
| 档位卡钩子 | `pay-package-{yuan}`（不变） |
| 提现输入/提交钩子 | `withdraw-input` / `withdraw-submit`（不变） |
| 充值页余额行 | `.wallet-recharge__balance` |
| 提现页数据卡 | `.wallet-withdraw__stat`（可提额度 / 当日剩余） |
| 提现页说明卡 | `.wallet-withdraw__limit`（门槛 / 单笔 / 单日） |
| 单根闸 ownRoot | `wallet-recharge` / `wallet-withdraw` |

## 5. 测试判据

- 钱包页：余额条 + 两张入口卡渲染；开关分别隐藏对应卡；点卡 URL 与 `pages.json` 逐字一致；
  两开关全关时入口区消失；回跳面板与记录行为不变。
- 「提现成功 → 提现列表重取」：`withdrawals.loaded=true` 且当前不在提现 tab ⇒ 置标记 ⇒
  断言**提现端点被重新请求**（不是只看当前 tab）；再覆盖「提现列表加载中置标记」⇒
  `finally` 之后补一次重取（不得丢刷新）。
- 摘要并发：先后两发乱序返回 ⇒ store 只接受序号大的那一发；成功后 `walletSummaryError`
  被清、钱包页 sticky `summary` 项退场；**跨页**：钱包页失败后提现页取数成功 ⇒
  钱包页失败行/浮层项退场；`code===0 && data===null` ⇒ 走失败处置、旧摘要保留。
- 充值页：档位卡数量/两行文案/`pay-package-{yuan}` 钩子；`coinPerYuan=null` 只显金额；
  **等高判据走源码级规则体**（jsdom 无布局）：`.wallet-recharge__package` 规则体含
  `min-height`；`creating` 全禁用；失败/降级提示；开关关闭守卫；空档位「暂无充值档位」。
- 提现页：数据卡/说明卡数值全部来自服务端；`summary=null` 数据卡显「—」、`null` 说明卡
  不渲染；五项预检；再认证；服务端文案逐字；成功刷新摘要 + 置失效标记；开关关闭守卫；
  **输入与按钮等高走源码级规则体**（两者都取 `$ftl-control-h`）。
- 结构闸：
  - **会自红**：`page-stack`（两处字面量）、`landscape-canvas`（页面数组 + 标题数组）；
  - **静默、必须主动补**：`ui-tokens`（required 清单）、`table-hud`（单根清单）、
    `notice-presentation`（页面清单循环要改成显式 `{name, file}` 路径对，
    否则子页按 `${page}/${page}.vue` 找错文件）。
- 类型检查 `vue-tsc --noEmit` 通过；受影响测试全绿（按用户口径不跑全量）。

## 6. 风险

- 页面清单闸分散在 5 个测试文件：`page-stack` / `landscape-canvas` 漏改会自红；
  `ui-tokens` / `table-hud` / `notice-presentation` 漏改是**静默**的 —— 必须主动补
  （见 §5），计划逐文件列出。
- 共享摘要的并发写：两页各发一取数，乱序返回由**请求序号**拦掉（spec §4.5）；
  不再假设「服务端权威值 ⇒ 无冲突」。
- 卡片网格在窄画布换行：`auto-fit` 保证不横向溢出（底分卡 2026-10-13 事故的同款教训）；
  等高由 min-height 兜底。
- 记录失效标记的消费时机：loading 中不得丢刷新（§4.2 / §4.6）。
- H5 重挂形态下回跳面板的存活：靠 store 载体到终态/关闭才清。

## 7. 涉及文件

- `apps/client/src/pages/wallet/wallet.vue`（瘦身 + A1）
- `apps/client/src/pages/wallet/recharge.vue`（新增）
- `apps/client/src/pages/wallet/withdraw.vue`（新增）
- `apps/client/src/pages.json`
- `apps/client/src/stores/game.ts`
- `apps/client/src/composables/useWalletSummary.ts`（新增）
- 测试：`wallet-page.test.ts`、新增 `wallet-recharge.test.ts` / `wallet-withdraw.test.ts` /
  `wallet-summary.test.ts`、`page-stack.test.ts`、`ui-tokens.test.ts`、
  `landscape-canvas.test.ts`、`table-hud.test.ts`、`notice-presentation.test.ts`、
  `game-store-session-reset.test.ts`

## 8. 审查记录

### 2026-10-23 设计对抗审查（独立 reviewer · sonnet · 单轮）

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | 只刷新 activeTab ⇒ 已看过的提现列表永久陈旧 | 已修：D5/§4.2 固定失效并重取提现 tab；判据改成先置 `loaded=true` 再断言重取 |
| 高 H1 | 失效标记可被 `loading` 静默丢弃；挂载顺序含糊 | 已修：§4.2 本地标记 + `finally` 补消费；挂载首查 |
| 高 H2 | 摘要进 store 而 error 留页面 ⇒ 新值 + 旧失败行同屏 | 已修：`walletSummaryError` 进 store，成功清除；钱包页 watch 退场 sticky 项 |
| 高 H3 | 两页并发取数乱序覆盖 | 已修：`walletSummarySeq` 单调序号 |
| 高 H4 | D4 前提与 H5 重挂行为可能矛盾；回跳面板会丢 | 已修：§4.6 声明两种页面模型；回跳载体到终态/关闭才清 |
| 高 H5 | `NoticeSurface` 是闭集 | 已修：D8 明确子页用 `surface="wallet"` |
| 高 H6 | 充值卡缺等高兜底，`coinPerYuan=null` 时露馅 | 已修：§4.3 min-height 公式 |
| 高 H7 | `summary=null` 显示未定义 | 已修：§4.4 数据卡显「—」、不回落 0 |
| 低 | 算账口径 / 空档位 / 滚动容器 / 再认证窗口 / 直链语义 / 全宽行 / 闸形态 / 返回栈深 | 已修：§4.3 1334 口径、空态、scroll-view；其余在 §4.6 登记 |

结论：修订后进入实现计划（阻断项已修，高项已处置或登记）。
