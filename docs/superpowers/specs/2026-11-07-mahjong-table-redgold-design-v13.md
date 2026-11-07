# 麻将牌桌「川麻红金」重做设计 spec v13（固定 base 构图 / 比例）

日期：2026-11-07
状态：v13，比例布局基线
取代：`2026-11-07-mahjong-table-redgold-design-v12.md`
继承：v12 + ... + v4；**交互契约未列部分按 v12 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v13 原型；七档画布 × 15 态 **ALL GREEN**）。

## 0. v13 核心变更：B 方案（固定 base 构图）

用户选择 **B 等比缩放（保持构图）**：

- 设计基准 `W0=1334, H0=750`。
- `u = min(W/W0, H/H0)`；`LandscapeStage` 给的画布恒 ≥1334×750 且至少一条边在最小值 ⇒ **u=1**。
- 构图固定为 1334×750，在画布中居中：`offsetX=(W−1334u)/2`、`offsetY=(H−750u)/2`；多余空间留边。
- 所有尺寸/位置用 **base 比例**表示（% of W0/H0），运行时乘 u 再加 offset；不再有 per-canvas `s`、`0.86W` 手牌上限、7 档 pixel 重算。
- 物理缩放仍由 `LandscapeStage` 统一处理；跨设备构图一致。

## 1. 比例 token（base 1334×750）

| token | base px | 比例 |
|---|---|---|
| barH | 64 | 8.533% H0 |
| handH | 108 | 14.4% H0 |
| hand tile w | 71.68 | handH×75/113 |
| drawn gap | 12 | 1.6% H0 |
| riverTileH | 56 | 7.467% H0 |
| sideTileW | 56 | 7.467% H0 |
| sideTileH | 45.714 | 6.095% H0 |
| topBackH | 46 | 6.133% H0 |
| seatPlateH | 56 | 7.467% H0 |
| selfPlateH | 76 | 10.133% H0 |
| action block | 176×176 | 23.467% H0 |
| action button | 84 | 11.2% H0 |
| hub min/max | 160/200 | 21.333%/26.667% H0 |
| outer | 12 | 1.6% H0 |
| gap | 4 | 0.533% H0 |
| side meld lane | 40.4 | 5.387% H0 |
| ting tile | 20×30 | 2.667%×4% H0 |
| 座位牌宽 | 160/164/64 | 11.994%/12.294%/4.798% W0 |

- 手牌宽 = 14×108×75/113 + 13×2 + 12 = 1041.54（78.08% W0），居中；不再用 0.86W 夹取。
- 所有牌/按钮/头像的比例固定；不同画布只改变 offset，不改变构图。

## 2. 布局函数

```ts
const W0 = 1334, H0 = 750;
const u = Math.min(W / W0, H / H0);
const ox = (W - W0 * u) / 2;
const oy = (H - H0 * u) / 2;
// 以 1334×750 为基准算出 base rects，再统一：
// x = ox + baseX * u; y = oy + baseY * u; w = baseW * u; h = baseH * u
```

- 布局函数仍输出画布坐标；Board/River 的坐标契约不变（v12 §2）。
- `u` 在标准台上恒 1；测试可构造 `u>1` 的画布（2668×1500）验证缩放。
- 不再有 `s` token、`0.86W`、`fit` 的 per-canvas 分支；`fit` 只用于牌河内容超出 base 盒时的压缩。

## 3. base 几何（1334×750，v12 数字）

| 态 | hub | 侧河 | top | actions | centerW |
|---|---|---|---|---|---|
| normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 |
| mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 |
| top29 | 200 | 9r/3c cap27 | 12c+5/6 win6+23 k=1.000 | 993.7,438 | 947.3 |
| twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 844.9 |
| fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 |
| gangHeavy | 162.4c | 9r/2c | 8c k=0.995 | 949.8,438 | 917.6 |
| revealedGang | 200 | 9/10r 2/2c | 8c | 993.7,438 | 960.9 |
| overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 |

- 侧副露：0.65 时 3 张 81.14、4 张 106.86、4 组 451.43；0.64 时 105.03/444.11。
- 听牌 3×4：86×94。
- topMeld：top29 content 81.20 k=1.000；gangHeavy 451.75/k=0.99487/449.43/余量 4.0。
- revealedGang：4 副露 → 2 张亮牌；侧 0.65/451.4 放得下。

## 4. v12 复审的文档/契约修正（一并纳入 v13）

| v12 问题 | v13 处理 |
|---|---|
| claim 测试期望写 `[5,3,5]` | 改为 **claim 期间 `[3,5]`**；窗口结束 `[3]`；胡/碰两种括注分开 |
| rob fallback 用了杠家最后弃牌 | fallback 只用于 `claim:`；`rob:` 非候选时 `claimSourceMeldKey/Index=null` |
| options 未过滤 pass，会两个“过” | 渲染 options 排除 pass；pass 只由 `showPass` 控制；普通窗口单过测试 |
| 音效/最后弃牌 diff 用 visible | 改用 **serverDiscards（未过滤）**；可见数组只用于渲染/窗口；碰后下一次出牌仍播音/高亮 |
| 侧河 +N 的行锚点 | `usedRows=ceil((windowCount+(overflow?1:0))/cols)`；`y=riverTop+(rows−usedRows)/2*pitch+badgeRow*pitch`；或网格顶对齐 |
| topMeld DOM 测量对象 | 测**合成内容宽**（Σ组宽+组距），不测条形容器；h 不随 k 缩放 |
| topMeld 输出 raw dims | 输出 raw tile/overlap/groupGap + k + scaled dims + contentW；h 不乘 k |
| 协议注释 | 改“暗杠 undefined；补杠保留原碰 fromSeat”；makeAddedGang 测试 |
| §1 raw 命名 | 未过滤数组改名 `serverDiscards`；`visibleDiscards.length` 为过滤后计数；protectedIndex 对 serverDiscards |

## 5. 跨设备与留边

- 16:9：1334×750，无留边。
- 19.5:9 / 21:9：宽多出部分左右留边（例如 1623×750 左右各 144.5）。
- 4:3 / 1:1：高多出部分上下留边（例如 1334×1000 上下各 125）。
- 留边区域使用牌桌背景/暗角，不改变构图。
- 物理尺寸由 `LandscapeStage` 的 scale 统一缩放；牌/按钮/文字比例不变。

## 6. 测试矩阵

- 画布：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334；另加 2668×1500 验证 u=2。
- 断言：base 构图 rect 与 1334×750 完全一致；所有 rect = base×u + offset；u=1 时只有 offset 不同。
- 不再有 per-canvas 手牌宽/牌河/侧区 pixel 锚点；v12 的 15 态在 base 上跑，七档只验居中。
- 交互/claim/窗口/animationend/发牌等测试沿用 v12（含 v13 §4 修正）。
- 回归：client 全量、vue-tsc、uni build。

## 7. 原型结果

`node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`：

- 七档 × 15 态 ALL GREEN。
- 1334×750 base 行与 §3 一致；其他画布 key 相同、offset 不同（u=1）。
- 2668×1500 构造态 u=2，rect 等比放大、无 new 相交（测试补）。

## 8. 决策表追加

| 编号 | 决策 |
|---|---|
| D127 | B 方案：固定 1334×750 构图；u=min(W/1334,H/750)，标准台 u=1；居中留边 |
| D128 | 所有尺寸/位置用 base 比例；取消 per-canvas s/0.86W/7 档 pixel 锚点 |
| D129 | 手牌宽 1041.54（78.08% W0），不再夹取 |
| D130 | 留边用牌桌背景，不改变构图 |
| D131 | v12 复审的 9 条文档/契约修正一并纳入 |
| D132 | fit 仅用于牌河内容超出 base 盒 |

## 9. 开放问题与已知边界

无开放设计问题。已知边界：

1. 宽屏/4:3 会留边（B 的取舍）；用户已选 B。
2. 服务端一炮多响删多张真弃牌；接受并另立片。
3. claim 后同 type 再打的 latest-first 边界；记录。
4. 动作浮层 base 覆盖 9.8×114.0（v12 的 78.4×125.6 是旧 s 值，B 下不适用）。
5. Hub compact ≤8 字；108 张；136 张另立。
6. 暗杠 cover 45.8%，outline 金边。

## 10. v13 复审补遗（Important）

### 10.1 last-discard 的 latest/pulse 映射

- Board 存 `lastDiscardAbs`：serverDiscards 的绝对索引，只在该座 serverDiscards 增长时更新。
- 渲染映射：`visibleIdx = lastDiscardAbs − hiddenBefore(abs) − windowStart`；若该绝对牌被 claimed 隐藏或不在窗口，清空 pulse/latest，不亮旧牌。
- 音效 diff 仍用 serverDiscards 增长；与 visible 解耦。
- 测试：A 打 5 → B 碰 → 断言不亮旧牌；A 再打 → 声/高亮在新牌。

### 10.2 rob 的 claimSource

- `claimSourceIndex` 只由 `claim:` 来源座产生；`rob:` 恒 **null**。
- `claimSourceMeldKey` 只由 `currentPlayer` 的同 type **最新 peng** 派生；找不到则 null。
- rob 窗口不描边任何河牌；胡按钮显示待响应牌。
- 测试：rob 窗口 `claimSourceIndex===null`、无河牌描边、胡按钮在。

### 10.3 HuBanner 锚点

- HuBanner 不再用画布百分比；layout 输出 `bannerAnchors: { top, left, right, self }`（base 座位/手牌中心 + offset，乘 u）。
- Board 把 anchor 传给 HuBanner。
- 测试：1334×1000 时 self banner 在 base 带内、不与手牌相交；1334×1334 时不落留边区。

### 10.4 其余

- 坐标契约引用 v11 §2（layout 全画布坐标，Board 在 River 边界减一次）；v12 §2 是 claim 交互，不是坐标。
- `bar` 的 base rect = (0,0,1334,64)，随构图变换；`topPlate` 跟随 bar；不混用全画布 bar。
- 原型 `layoutBase` 固定 1334×750（删除 s/0.86W）；`layout()` 应用 `base×u+offset`；`bar` 纳入 rects；2668×1500 u=2 用例。
- 侧河 +N 行锚点：badge 参与 grid 流并整体居中；若 overlay，则网格顶对齐；二者不混用。
