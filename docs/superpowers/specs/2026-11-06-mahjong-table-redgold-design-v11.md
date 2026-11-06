# 麻将牌桌「川麻红金」重做设计 spec v11

日期：2026-11-06
状态：已被 v12 取代（`2026-11-07-mahjong-table-redgold-design-v12.md`）；本文件保留 v11 复审前版本。
取代：`2026-11-06-mahjong-table-redgold-design-v10.md`
继承：v10 + v9 + v8 + v7 + v6 + v5 + v4；**未列部分按 v10/v9/v8/v7/v6/v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v11 原型；七档 × 15 态 **ALL GREEN**）。

## 0. v11 修订（v10 复审 10 条 Important + Minor）

| v10 问题 | v11 处理 |
|---|---|
| 原型 `sideZone` 仍留局部 badgeRect，与画布版并存 | 删除 `sideZone.badgeRect`；只保留 `sideRects.badge`/`riverTopSelf.badgeRect`（画布）；四个 badge 纳入 rects/inside 断言；Board 只减一次 river 原点 |
| `box-shadow: inset` 在 `<image>` 上不可见 | 金边唯一方案改 `outline: 1px solid $gold; outline-offset:-1px`（已在 `<image>` 根验证过），不占布局 |
| 无限闸漏 script 拼类名/长写 | 扫整个 SFC（template+script）的 `anim-*` 字面量；`<style>` 扫 `animation`/`animation-name`/`animation-iteration-count` 的 infinite；合成违例含 MahjongMeld script、SeatChip style、长写 |
| `topMeld` 余量断言用同一 k 反推，恒真 | layout 输出 `topMeld.scale k` 与缩放后的 `tile.w/groupGap/overlap`；测试断言**合成内容宽** ≤ topBacksW−4s；加“k=1 且 content 超限必须红”反向用例 |
| `revealed` 是对象，被当数字 | layout 入参改 `revealedCount = revealed?.tiles.length ?? 0`（含胡牌张）；测试 14/11/8/5/2 张 |
| `interactive` 布尔与 index 点击混层 | 拆两层：河级 `canClaimSource`（phase/windowId/amActive/seat）；tile 级只让 `i===claimSourceIndexLocal` 可点并 emit `{tile,index}`；Board handler 先判 index；rob 恒 false |
| 布局计数仍用 raw discards | `loads[seat].discards = visibleDiscards[seat].length`；revealed 覆盖 left/right；布局/窗口/badge 全用它 |
| “最早同 type”隐藏留 ghost | 改**隐藏最新一张同 type**（claim 的是最新弃牌）；latest 用 visibleDiscards 追加序；文档记录“claim 后又打同 type”的罕见边界 |
| inset 金边同问题 | 改 outline（见上） |
| 无限闸 script/长写同问题 | 见上 |
| §0 引用 §8、revealedGang avail 470、lane 40.4@0.65/39.84@0.64 | 同步 |
| 协议注释“补杠 fromSeat undefined”与实际保留矛盾 | 更新注释为“暗杠 undefined；补杠保留原碰 fromSeat”，加 makeAddedGang 测试 |

## 1. claimed 过滤数组（v11 最终规则）

`visibleDiscards[seat]`：

- 遍历 `view.melds`，对每个 `m.fromSeat != null` 的副露，在 `fromSeat` 的弃牌里**隐藏最新一张**与 `m.tiles[0]` 同 type 的牌。
- 每个 meld 隐藏 1 张；peng→addedGang 同一 meld（`fromSeat` 保留）不重复；暗杠无 `fromSeat`。
- 过滤后保持原顺序；`raw = visibleDiscards.length`。
- 已知边界：若 claim 之后该座又打了同 type，全量重算会隐藏“最新那张”（即后打的真牌），而不是当时被 claim 的旧牌；view 没有 claim 顺序字段，无法消歧。测试覆盖该边界并记录为已知限制。
- 下游：`loads[seat].discards = visibleDiscards.length`；窗口/slice/latestIndex/claim 全在 visibleDiscards 上；Board 传给 River 的是 visibleDiscards，不是 `view.discards`。
- 测试：`[5万(过),3万,5万(被碰)]` → `[5万,3万]`，latest=3万；`[A,B,C,D]+B被碰 + E` → `[A,C,D,E]`，latest=E；29 张窗口 claim 最新。

## 2. 坐标空间

- layout 全部输出**画布坐标**：`badgeRect`（四河）、`meldRect`（top/left/right/self）、`selfMeld`、`topMeld`。
- Board 在 River 边界统一减去 `river.rect.left/top` 一次；River props 为局部。
- 原型删除 `sideZone.badgeRect`；`sideRects.badge`、`riverTopSelf.badgeRect` 为画布；四个 badge 纳入 `rects` 与 inside 断言。
- DOM 断言：`badgeRect`、`meldRect` 的局部 x/y 与 `(canvas − river)` 一致；不再有局部/画布混用。

## 3. 暗杠金边

- 侧副露暗杠背 `mode='aspectFill'` 填满 36.4×29.714 横盒；83×125 背图裁掉约 45.8% 高度（接受）。
- 金边唯一方案：`outline: 1px solid $ftl-color-mj-gold; outline-offset: -1px`（画在内容之上、不占布局；`mj-river__tile--filtered` 已用 outline，是已验证路径）。
- 不写 `border`、不写 `box-shadow: inset`。
- 暗杠 4 张组高仍 106.86；4 组 451.43；0.64/444.11。
- 测试：outline 不改变 w/h；暗杠 4 张组高与明杠一致；真浏览器截图看金边。

## 4. 无限闸

- 解析 `animations.scss`：`classInfinite`（规则 `animation`/`animation-name`/`animation-iteration-count` 含 infinite）与 `keyframeInfinite`。
- 扫**整个 SFC**（template+script，排除 `<style>`）的 `anim-[a-z0-9-]+` 字面量；与 classInfinite 求交；只允许 `anim-claim-pulse`。
- 扫麻将组件 `<style>`：`animation`、`animation-name`、`animation-iteration-count` 中含 infinite 即违例（claim pulse 定义在 animations.scss，不在组件 style）。
- 排除 animations.scss。
- 合成违例：SeatChip `animation: ftl-active-glow ... infinite`；MahjongMeld script 返回 `anim-lack-pulse`；`animation-iteration-count: infinite` 长写。

## 5. revealed

- layout 入参：`revealedCount = revealed?.tiles.length ?? 0`（服务端 `tiles` 已含胡牌张，最大 14）。
- left/right：`raw = revealedCount > 0 ? revealedCount : visibleDiscards.length`；revealed>0 时 overflow=0、无 +N；sideTop+16s。
- top/self：`raw = visibleDiscards.length`；top 亮牌走 HandBacks、self 走手牌；河仍显示 discards。
- 测试：0 副露 14 张、1–4 副露 11/8/5/2 张；top revealed 时河仍显示 discards。

## 6. claim 交互两层

- 河级 `canClaimSource = phase==='claim' && windowId?.startsWith('claim:') && amActive && seat===currentPlayer`。
- tile 级：只有 `i===claimSourceIndexLocal`（窗口内，= latestIndex）可点；`emit('discard-click', {tile,index})`。
- Board handler：先判 `index===latestIndex`，再 set `discardClickTarget`；`filterTileType` 只作用于来源河/latest。
- rob：`canClaimSource=false`；`claimSourceMeldKey` 高亮杠家 peng。
- 测试：点旧牌不改变选项；rob 点击恒 false；强制胡有胡按钮、不渲染无效“过”。

## 7. topMeld k

- `k = min(1, (topBacksW − 4s) / topMeldContentW)`。
- layout 输出 `topMeld.scale k` 与缩放后的 `tile.w`、`overlap`、`groupGap`；垂直高度仍 44.8（k 只作用横向）。
- 合成内容宽 = `Σ(n×tileW×k − (n−1)×overlap×k) + (m−1)×groupGap×k`；断言 ≤ topBacksW−4s。
- top 4 杠 content 451.75 → k≈0.99487、449.43，余量 4.0。
- 测试：合成宽 ≤ cap；反向用例 k=1 且 content 超限必须红；DOM 实测 `meld.width`。

## 8. 原型结果（七档 × 15 态 ALL GREEN）

| 画布/态 | hub | 侧河 | top 窗口 | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 | 侧副露 81.1 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 win6+23 | 993.7,438 | 947.3 | k≈0.995 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 844.9 | 侧 5+24/5、1+24/1 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 | 4 碰 348.6 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 949.8,438 | 917.6 | 4 杠 0.64/444.1 |
| 1334×750 revealedGang | 200 | 9/10r 2/2c | 8c | 993.7,438 | 960.9 | 亮牌+4 杠 451.4，avail 470 |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 | 覆盖 9.8×114 |
| 1334×1000 gangHeavy | 220.3 | 10r/2c | 8c | 910.2,656.3 | 874.1 | 0.65/497.2 |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 846.3,656.3 | 746.4 | 覆盖 78.4×125.6 |

- 侧 lane：40.4@0.65、39.84@0.64。
- 七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
- 十五态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29、oneSideRevealed、threeRevealed、revealedGang。

## 9. 测试矩阵

- 画布七档；状态十五态；组件态同 v10。
- claimed：最新同 type 隐藏；`[5(过),3,5(碰)]`；`[A,B,C,D]+B被碰+E`；29 张 claim 最新；后打同 type 边界。
- 坐标：四个 badgeRect + meldRect 画布 → River 局部减一次；DOM 断言。
- 金边：outline 不改 w/h；暗杠 4 张组高 106.86；真浏览器截图。
- 无限闸：SFC script 样本、SeatChip style、长写；只放 anim-claim-pulse。
- claim 两层：旧牌点击不改选项；rob false；强制胡有胡。
- topMeld：合成宽 ≤ cap；k=1 超限红；DOM 实测。
- revealed：14/11/8/5/2；top revealed 河仍显示 discards。
- animationend、发牌、MjDeal latch、v2 tokens、Board 测试 v2 同 v10。
- 回归：client 全量、vue-tsc、uni build。

## 10. 决策表追加

| 编号 | 决策 |
|---|---|
| D105 | visibleDiscards 隐藏**最新**同 type；后打同 type 为已知边界 |
| D106 | 布局计数/窗口/claim 全用 visibleDiscards |
| D107 | 四河 badgeRect/meldRect 全画布；Board 减一次 |
| D108 | 金边只 outline + 负 offset |
| D109 | 无限闸扫整 SFC + 长写 |
| D110 | revealedCount = tiles.length |
| D111 | claim 两层：河级 canClaimSource + tile 级 latestIndex |
| D112 | topMeld 输出 scale/tile/overlap/groupGap；合成宽断言 |
| D113 | 协议注释补杠保留 fromSeat；加 shared 测试 |

## 11. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张同型弃牌；visibleDiscards 全量重算。
2. claim 后同座又打同 type 时，过滤会隐藏后打的真牌（view 无 claim 顺序）；记录并要求 mockup/真机观察。
3. 动作浮层最坏覆盖 78.4×125.6；路线 A 接受。
4. Hub compact ≤8 字；超长昵称省略。
5. 108 张单家弃牌 ~29；上/下 23+6，侧 24+5。
6. 136 张玩法不在本片。
7. 暗杠背 cover 裁 45.8%，outline 金边补偿。
8. 4 杠侧副露 0.64/444.1；revealed+4 杠 0.65/451.4；极端态 mockup 展示。
