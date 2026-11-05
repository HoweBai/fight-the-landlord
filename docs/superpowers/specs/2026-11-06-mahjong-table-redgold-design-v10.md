# 麻将牌桌「川麻红金」重做设计 spec v10

日期：2026-11-06
状态：v10，待复审
取代：`2026-11-06-mahjong-table-redgold-design-v9.md`
继承：v9 + v8 + v7 + v6 + v5 + v4；**未列部分按 v9/v8/v7/v6/v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v10 原型；七档 × 15 态 **ALL GREEN**）。

## 0. v10 修订（v9 复审 1 Critical + 5 Important + 几何 3 Important）

| v9 问题 | v10 处理 |
|---|---|
| C1 claim 来源未绑定 claimed 过滤后的 discards | 新增 `visibleDiscards[seat]`：每个 `meld.fromSeat` 隐藏来源座**最早**一张同 type 弃牌；窗口/slice/latestIndex/claim 全在 visibleDiscards 上；Board 把它传给 River，不再用 `view.discards` |
| badgeRect 局部 / meldRect 画布，坐标空间混用 | 统一：**layout 全部输出画布坐标**；Board 在 River 边界减去 `river.rect.left/top` 一次；River props 为局部；DOM 分别断言 |
| 暗杠 1px 金边 content-box 会改组高 | 金边改 `box-shadow: inset 0 0 0 1px` 或 outline（不占布局）；暗杠 4 张组高仍 106.86；测试断言 |
| 无限闸漏 SeatChip 的 keyframe infinite | 闸建两张表：class→animation 是否 infinite、keyframe→是否被 infinite 使用；扫麻将模板 `anim-*` + 组件 `<style>` 的 `animation:` 行；白名单只放 `anim-claim-pulse`（定义在 animations.scss）；合成 SeatChip 违例 |
| raw 的 revealed 替换写成四河 | 只 left/right：`raw=revealed>0?revealed:visibleDiscards.length`；top/self 用 visibleDiscards.length；top 亮牌走 HandBacks、self 走手牌 |
| rob 窗口硬闸未复述；v8 §4 引用悬空 | 明确 `interactive = phase==='claim' && windowId.startsWith('claim:') && amActive && seat===currentPlayer && index===latestIndex`；`rob:` 一律 false；删除悬空引用 |
| topMeld 4 杠余量规则未落原型 | 原型实现 `k=min(1,(topBacksW−4s)/contentW)`；top meld tile/组距乘 k；断言余量 ≥4s |
| revealed+4 杠态未测 | 原型新增 `revealedGang`；侧副露 0.65/451.4 放得下（avail 474）；七档 × 15 态 ALL GREEN |
| 上/下河缺 raw；lane +4 未随 s | 原型补 raw；lane 改 `tileW+4s`；1000 档锚点同步 |
| 文档引用 §5 表 | 改为 §4 表；visible 仅作 overflow/列数输入，渲染/容量一律 windowCount |

## 1. claimed 过滤数组（C1）

`visibleDiscards[seat]` 派生规则：

- 遍历 `view.melds`，对每个 `m.fromSeat != null` 的副露，在 `fromSeat` 的弃牌里隐藏**最早**一张与 `m.tiles[0]` 同 type 的牌。
- 每个副露只隐藏 1 张；peng→addedGang 是同一个 meld（`fromSeat` 保留），不重复隐藏。
- 无匹配（异常/重连中间态）则跳过。
- 过滤后保持原顺序；`raw = visibleDiscards.length`。

所有下游：

- 窗口 `visible/overflow/windowStart/windowCount/latestIndex/badgeCell/badgeRect` 都基于 visibleDiscards。
- `slice(windowStart, windowStart+windowCount)`。
- claim 来源 = `visibleDiscards[windowStart+latestIndex] = visibleDiscards[raw−1]`。
- Board 把 `visibleDiscards[seat]` 传给 River；River 不再读 `view.discards`。
- 测试：来源 `[A,B,C,D]`，B 被碰 → `[A,C,D]`，再打 E → `[A,C,D,E]`；窗口 4、latest 3、来源 E；碰/杠/胡候选按 E 过滤；29 张窗口同理。

## 2. 坐标空间

- layout v2 的**所有 Rect 输出画布坐标**：`badgeRect`、`meldRect`（top/left/right/self）、`selfMeld`、`topMeld`。
- Board 在传给 River 前统一减去 `river.rect.left/top` 一次；River props 为 River 局部坐标。
- River DOM 断言：`badgeRect`、`meldRect` 的局部 x/y 与 `(canvasRect − riverRect)` 一致。
- 不再出现“badgeRect 局部、meldRect 画布”的混用。

## 3. 暗杠金边

- 侧副露暗杠背 `mode='aspectFill'` 填满 36.4×29.714 横盒；83×125 背图裁掉约 45.8% 高度（接受）。
- 金边用 `box-shadow: inset 0 0 0 1px $ftl-color-mj-gold`（或 `outline` + 负 offset），**不占布局**；不写 `border`。
- 暗杠 4 张组高仍 106.86；4 组 451.43；0.64/444.11。
- 测试：暗杠 4 张盒高与明杠一致；金边不改变 w/h；真浏览器看裁切/金边。

## 4. 无限闸

- 解析 `animations.scss`：
  - `classInfinite`：规则里 `animation:` 含 `infinite` 的 class。
  - `keyframeInfinite`：这些 class 引用的 `@keyframes` 名。
- 扫麻将组件模板：`anim-*` 使用 ∩ classInfinite；只允许 `anim-claim-pulse`。
- 扫麻将组件 `<style>`：任何 `animation:` 行含 `infinite` 即违例（claim pulse 定义在 animations.scss，不在组件 style）；SeatChip 的 `animation: ftl-active-glow ... infinite` 会被抓到。
- 排除 `animations.scss`；合成违例样本必须包含 SeatChip 的 keyframe infinite 与 `anim-lack-pulse` 使用。
- 清理：删除 `anim-lack-pulse` 使用、`anim-active-glow` 死类、SeatChip 两条 infinite。

## 5. raw 与 revealed

- left/right：`raw = revealed > 0 ? revealed : visibleDiscards.length`；revealed>0 时 `overflow=0`、无 +N；`sideTop += 16s`。
- top/self：`raw = visibleDiscards.length`；revealed 不替换河；top 亮牌走 HandBacks、self 走手牌。
- 测试：top revealed 时河仍显示 discards；left/right revealed 显示亮牌无 +N。

## 6. rob 闸

`interactive` 必须同时满足：

```text
phase === 'claim'
&& windowId.startsWith('claim:')
&& amActive
&& seat === currentPlayer
&& index === latestIndex
```

`rob:` 一律 false；claim 来源高亮只对 `visibleDiscards[windowStart+latestIndex]`；rob 用 `claimSourceMeldKey` 高亮杠家 peng 副露。

## 7. topMeld 4 杠

- `k = min(1, (topBacksW − 4s) / topMeldContentW)`；top meld tile/组距乘 k。
- `topMeldW = min(max(topRiver.width, topMeldContentW×k), topBacksW)`。
- 断言 `topBacksW − topMeldContentW×k ≥ 4s`；top 4 杠 content 451.75 → k≈0.9949、449.4，余量 4s。
- 测试：top 4 杠余量 ≥4s；组内 0 水平 padding/border。

## 8. 原型结果（七档 × 15 态 ALL GREEN）

| 画布/态 | hub | 侧河 | top 窗口 | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 | 侧副露 81.1 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 win6+23 | 993.7,438 | 947.3 | 绝对最新 28 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 844.9 | 侧 5+24/5、1+24/1 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 | 4 碰 348.6 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 949.8,438 | 917.6 | 4 杠 0.64/444.1 |
| 1334×750 revealedGang | 200 | 9/10r 2/2c | 8c | 993.7,438 | 960.9 | 亮牌+4 杠 451.4 |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 | 覆盖 9.8×114 |
| 1334×1000 gangHeavy | 220.3 | 10r/2c | 8c | 910.2,656.3 | 874.1 | 0.65/497.2 |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 846.3,656.3 | 746.4 | 覆盖 78.4×125.6 |

七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
十五态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29、oneSideRevealed、threeRevealed、revealedGang。

## 9. 测试矩阵

- 画布七档；状态十五态；组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6（上/下）/24+5（侧）、revealed 无 +N、双胡（正常/reduced）。
- claimed 过滤：A/B/C/D+B 被碰 → A/C/D/E；29 张窗口 claim 最新；四河都覆盖。
- 坐标：badgeRect/meldRect 画布 → River 局部减一次；DOM 断言。
- 金边：inset 不改 w/h；暗杠 4 张组高 106.86。
- 无限闸：SeatChip 合成违例；anim-lack-pulse；只放 anim-claim-pulse。
- rob：windowId rob: 点击恒 false；胡按钮保留。
- topMeld：4 杠余量 ≥4s；revealedGang 态。
- animationend/fire、发牌、MjDeal latch、v2 tokens、Board 测试 v2、River props 同 v9。
- 回归：client 全量、vue-tsc、uni build。

## 10. 决策表追加

| 编号 | 决策 |
|---|---|
| D97 | visibleDiscards = claimed 过滤后数组；所有窗口/claim 用它 |
| D98 | layout 全部画布坐标；Board 在 River 边界减一次 |
| D99 | 暗杠金边 inset shadow/outline，不占布局 |
| D100 | 无限闸 class→animation + keyframe 两表；组件 style infinite 直接违例 |
| D101 | raw revealed 只 left/right；top/self 用 discards |
| D102 | rob 硬闸 windowId.startsWith('claim:') + index===latestIndex |
| D103 | topMeld k 缩 scale，余量 ≥4s |
| D104 | revealedGang 进矩阵；lane +4s |

## 11. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张同型弃牌；客户端 visibleDiscards 全量重算。
2. 动作浮层最坏覆盖 78.4×125.6（1334×833/1000），必然含最新弃牌；路线 A 接受。
3. Hub compact 162.4 状态行 ≤8 字；超长昵称省略。
4. 108 张单家弃牌 ~29；上/下 23+6，侧 24+5。
5. 136 张玩法不在本片。
6. 暗杠背 cover 裁掉约 45.8% 高度，以 inset 金边补偿。
7. 4 杠侧副露 0.64/444.1；revealed+4 杠 0.65/451.4；极端态 mockup 展示。
8. capacity=24 的侧河分支当前七档不可达，仅防御。
