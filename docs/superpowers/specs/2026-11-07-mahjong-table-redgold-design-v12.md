# 麻将牌桌「川麻红金」重做设计 spec v12

日期：2026-11-07
状态：v12，待复审
取代：`2026-11-06-mahjong-table-redgold-design-v11.md`
继承：v11 + v10 + ... + v4；**未列部分按 v11/v10/.../v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v12 原型；七档 × 15 态 **ALL GREEN**）。

## 0. v12 修订（v11 复审 1 Critical + 关键 Important）

| v11 问题 | v12 处理 |
|---|---|
| C1 `visibleDiscards` 隐藏“最新同 type”会藏掉当前 claim 来源 | claim 窗口保护来源座**最后一枚弃牌**：`protectedIndex = raw.length−1`（仅 `claim:` 且 seat===currentPlayer）；隐藏候选排除它；claim 来源 tile 以服务端 `claimsForMe[].tile` 为准；窗口结束后按“每 meld 藏一张、latest-first”重算 |
| 强制胡仍渲染无效“过” | `showPass = myClaims.some(o=>o.claim==='pass')`；强制胡无 pass ⇒ 无“过” |
| 重写 handler 丢了“再点同一张取消” | index 校验后保留 toggle：同 index/tileType 再点清空 |
| topMeld k 双重/恒真；原型未输出缩放 dims | layout 输出 raw dims + k + contentW + scaled dims；公式只乘一次 k；DOM 实测宽 ≤ topBacksW−4s；纯 helper 做 k=1 反向用例 |
| top29 k 写 0.995；0.64 组高写 106.86 | top29 k=**1.000**；0.995 属 gangHeavy 4 杠；0.65→106.86/451.43，0.64→105.03/444.11 |
| peng→addedGang 无测试 | 加 visibleDiscards 只减 1 的测试；makeAddedGang 断言 fromSeat 保留 |
| `filterTileType` 只能按 type 描边 | River 加 `claimSourceIndex`（窗口内）；`isFiltered(i)` 只在 `i===claimSourceIndex` 时描边；type 仅用于 claims 过滤 |
| revealedCount 未按座位定义 | `loads[seat].revealedCount = revealed?.tiles.length ?? 0`；left/right 覆盖，top/self 忽略；测试 14/11/8/5/2 |
| k=0 除零 | `contentW===0 ⇒ k=1` |
| 无限闸会扫到 `@import animations.scss` | 只扫 `.vue` 源文本，跳过 `@import`；`keyframeInfinite` 仅用于 style 长写；动态拼类名列为已知限制 |
| 索引空间未复述 | River emit `{tile,index}`，index 为窗口内；绝对 = windowStart+index；29 张 windowStart>0 测试 |
| rob meld key 无派生 | `claimSourceMeldKey = meldKey(currentPlayer, 同 type 的最新 peng)` |
| 服务端一炮多响删多张真弃牌 | 明确接受：客户端只按新 view 重算，无法恢复；服务端修复另立片；§11 记录 |
| 原型 revealedGang 14 张不可达 | 改真实 2 张（4 副露）；七档 × 15 态 ALL GREEN |

## 1. claimed 过滤数组（v12 最终规则）

```text
raw = view.discards[seat]
counts[type] = #(melds where fromSeat === seat && tiles[0] type === type)
protectedIndex = (phase === 'claim' && windowId?.startsWith('claim:') && seat === view.currentPlayer)
                 ? raw.length - 1 : -1
hidden = {}
for each type,count:
  candidates = indices of raw with tileType === type, sorted desc, excluding protectedIndex
  hide first count candidates
visibleDiscards[seat] = raw − hidden
```

- claim 窗口：来源座最后一枚（当前 claim 牌）永远保留；同 type 旧副露改藏更早的。
- 窗口结束：新 meld 进 counts，最后一枚不再受保护；latest-first 藏掉被 claim 的牌。
- 每个 meld 藏 1 张；peng→addedGang 同一 meld 不重复；暗杠无 fromSeat。
- claim 来源 tile：`claimsForMe.find(o=>o.tile)?.tile`；若为空则 `visibleDiscards[source][last]`。
- 下游：`loads[seat].discards = visibleDiscards.length`；窗口/slice/latest/claim 全用它。
- 已知边界：claim 之后同座又打同 type 时，latest-first 可能藏掉后打的真牌；view 无 claim 顺序字段，记录为已知限制。
- 测试：`[5(旧碰),3,5(当前胡)]` claim 期间 visible `[5,3,5]`、latest=5；点来源后胡选项仍在；窗口结束后 visible `[3]`（两张 5 均被 meld 计数藏掉）；`[A,B,C,D]+B碰+E` → `[A,C,D,E]`；peng→addedGang 只减 1；29 张 claim 最新可点。

## 2. claim 交互两层

- 河级 `canClaimSource = phase==='claim' && windowId?.startsWith('claim:') && amActive && seat===currentPlayer`。
- tile 级：只有 `i===claimSourceIndex`（窗口内，= latestIndex）可点；`emit('discard-click', {tile,index})`。
- Board handler：先判 `index===claimSourceIndex`，再 set；同 index/tileType 再点清空（保留 toggle）。
- `filterTileType` 仅用于 claims 列表过滤；River 高亮用 `claimSourceIndex`，同 type 旧牌不描边。
- `showPass = myClaims.some(o=>o.claim==='pass')`；强制胡无“过”。
- rob：`canClaimSource=false`；`claimSourceMeldKey = meldKey(currentPlayer, 同 type 的最新 peng)`；胡按钮显示待响应牌。
- 索引空间：River 的 `index` 是窗口内下标；绝对 = `windowStart+index`；29 张 windowStart>0 测试。

## 3. topMeld

- layout 输出：
  ```ts
  topMeld: {
    rect: Rect;
    contentW: number;      // 未缩放
    scale: number;         // k
    tile: { w: number; h: number };      // 已缩放（组件直接用，不再乘 k）
    overlap: number;       // 已缩放
    groupGap: number;      // 已缩放
  }
  ```
- `k = contentW===0 ? 1 : min(1, (topBacksW − 4s)/contentW)`。
- 合成内容宽（用**未缩放** dims 计算）= `Σ(n×rawTileW − (n−1)×rawOverlap) + (m−1)×rawGroupGap`，断言 `contentW×k ≤ topBacksW−4s`。
- top29：content 81.20、k=**1.000**；gangHeavy 4 杠：content 451.75、k=0.99487、449.43、余量 4.0。
- 纯 helper `topMeldScale(contentW, cap, s)`；反向用例 `contentW>cap` 且强制 k=1 必须红；DOM 实测 meld 宽 ≤ cap−4s。
- 组内 0 水平 padding/border。

## 4. 几何数字（0.65/0.64）

- 0.65：牌盒 36.4×29.714；碰组 81.14；4 张组 106.86；4 组 348.57/451.43。
- 0.64：4 张组 105.03；4 组 444.11；lane 39.84；0.65 lane 40.4。
- 听牌 3×4：86×94。
- revealedGang：4 副露 → 2 张亮牌；avail 470；侧 0.65/451.4 放得下。
- 七档画布同 v11：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。

## 5. revealed

- `loads[seat].revealedCount = revealed?.tiles.length ?? 0`。
- left/right：`raw = revealedCount>0 ? revealedCount : visibleDiscards.length`；overflow=0；sideTop+16s。
- top/self：`raw = visibleDiscards.length`；top 亮牌走 HandBacks、self 走手牌；河仍显示 discards。
- 测试：14/11/8/5/2；top revealed 河仍显示 discards；revealedGang 2 张。

## 6. 无限闸

- 只扫 `.vue` 源文本；跳过 `@import` 行，不展开 animations.scss。
- 扫 template+script 的 `anim-*` 字面量；`<style>` 扫 `animation`/`animation-name`/`animation-iteration-count` 的 infinite；`keyframeInfinite` 仅用于 style 长写匹配。
- 白名单只放 `anim-claim-pulse`；排除 animations.scss。
- 合成违例：SeatChip style、MahjongMeld script、长写。
- 已知限制：`'anim-' + kind` 动态拼接不扫；当前代码均为字面量；新增动态拼接需人工评审。

## 7. 服务端多响与已知边界

- 一炮多响：服务端每个赢家 `markHu` 删一张同 type 弃牌，可能删掉真实历史弃牌；客户端无法恢复。v12 **接受**该行为：布局/窗口/claim 只按新 view 重算；UI 可能少一张真弃牌。服务端修复另立片。
- claim 后同 type 再打：latest-first 可能藏后打真牌；记录。
- 动作浮层 78.4×125.6；路线 A 接受。
- 暗杠 cover 45.8%，outline 金边。
- 108 张；136 张另立。

## 8. 原型结果（七档 × 15 态 ALL GREEN）

| 画布/态 | hub | 侧河 | top 窗口 | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 | 侧副露 81.1 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 win6+23 k=1.000 | 993.7,438 | 947.3 | — |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 844.9 | 侧 5+24/5、1+24/1 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 | 4 碰 348.6 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c k=0.995 | 949.8,438 | 917.6 | 4 杠 0.64/444.1 |
| 1334×750 revealedGang | 200 | 9/10r 2/2c | 8c | 993.7,438 | 960.9 | 2 亮牌+4 杠 451.4 |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 | 覆盖 9.8×114 |
| 1334×1000 gangHeavy | 220.3 | 10r/2c | 8c k=0.995 | 910.2,656.3 | 874.1 | 0.65/497.2 |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 846.3,656.3 | 746.4 | 覆盖 78.4×125.6 |

七档/十五态同 v11；revealedGang 已改为 2 张。

## 9. 测试矩阵

- claimed：claim 保护当前最后一张；`[5旧,3,5当前]`；窗口结束 `[3]`；peng→addedGang 只减 1；29 张 claim 最新；后打同 type 已知边界。
- claim 交互：旧牌点击不改变选项；同 index 再点取消；rob false；强制胡无过；filter 按 index 高亮。
- topMeld：content 81.20/451.75；k 1.000/0.99487；449.43；余量 4.0；反向 k=1 超限红；DOM 宽。
- revealed：14/11/8/5/2；top revealed 河仍 discards；revealedGang 2。
- 无限闸：SFC script/SeatChip/长写；@import 不误扫；动态拼接已知限制。
- 几何：0.65 106.86/451.43；0.64 105.03/444.11；lane 40.4/39.84；听牌 94。
- animationend、发牌、MjDeal latch、v2 tokens、Board 测试 v2 同 v11。
- 回归：client 全量、vue-tsc、uni build。

## 10. 决策表追加

| 编号 | 决策 |
|---|---|
| D114 | claim 窗口保护来源座最后一枚弃牌；claim 来源用服务端 tile |
| D115 | showPass 只认 claimsForMe 的 pass；强制胡无过 |
| D116 | 保留“再点同一张取消” |
| D117 | topMeld 输出 raw+k+scaled dims；公式只乘一次 |
| D118 | 0.65→106.86/451.43；0.64→105.03/444.11 |
| D119 | peng→addedGang 只减 1；makeAddedGang fromSeat 测试 |
| D120 | River 高亮按 claimSourceIndex，不按 type |
| D121 | revealedCount 按座位；revealedGang 2 张 |
| D122 | k=0 ⇒ 1 |
| D123 | 无限闸跳过 @import；动态拼接已知限制 |
| D124 | 索引窗口内；绝对 = windowStart+index |
| D125 | rob meld key 派生 |
| D126 | 服务端多响删多张：接受，另立片 |

## 11. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张真弃牌；客户端无法恢复；接受。
2. claim 后同座又打同 type 时 latest-first 可能藏后打真牌；记录。
3. 动作浮层 78.4×125.6；路线 A 接受。
4. Hub compact ≤8 字；超长昵称省略。
5. 108 张；136 张另立。
6. 暗杠 cover 45.8%，outline 金边。
7. 4 杠 0.64/444.1；revealed+4 杠 2 亮牌 0.65/451.4。
8. capacity=24 侧河分支不可达，仅防御。
