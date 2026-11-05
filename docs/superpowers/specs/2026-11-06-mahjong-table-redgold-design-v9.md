# 麻将牌桌「川麻红金」重做设计 spec v9

日期：2026-11-06
状态：v9，待复审
取代：`2026-11-06-mahjong-table-redgold-design-v8.md`
继承：v8 + v7 + v6 + v5 + v4；**未列部分按 v8/v7/v6/v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v9 原型；七档 × 14 态 **ALL GREEN**）。

## 0. v9 修订（v8 复审 3 Critical + 关键 Important）

| v8 问题 | v9 处理 |
|---|---|
| 4 张侧副露组高写成 110.8；4 组 467.2 | 修正为 **106.86 / 451.43**：`groupH(n)=n×29.714−(n−1)×4`；4 张 3 个重叠；0.64/444.11；§0/§1/§5/§7 全部同步 |
| 听牌行高写 92 | 修正为 **94**（3×30+2×2） |
| twoSurvivors centerW 写 859.2 | 修正为 **844.9**（v8 原型 no-rotate 实测） |
| side 河窗口字段未实现/未定义 | 四河统一输出 `windowStart/windowCount/badgeCount/latestIndex/badgeCell/badgeRect`；side 用 24（cap≥25）或 23（cap=24） |
| claimSource `latestIndex` 窗口内 vs 绝对混用 | 明确：`latestIndex` 是**窗口内**下标；绝对来源 = `windowStart + latestIndex = raw − 1`；River 点击 payload 改 `{tile, index}`（窗口内） |
| 暗杠背 aspectFill 缺 prop | `MahjongTile` 增加 `mode?: 'aspectFit' \| 'aspectFill'`（默认 aspectFit）；暗杠背用 aspectFill/cover，裁切约 45.8% 高度，接受并加 CSS 金边 |
| 无限闸会误伤 finite `anim-*` | 先从 `animations.scss` 读出含 `infinite` 的类集合，再扫麻将组件使用点；白名单只放 `anim-claim-pulse`；排除 animations.scss |
| River 的 meldRect/badgeRect 坐标空间未定义 | 统一为 **River 局部坐标**；Board 从 layout 画布坐标减去 `river.rect.left/top` |
| seenMeldKeys 的 null→view seed 缺失 | 挂载/首个非 null view seed `seenHuSeats/seenMeldKeys/prevDiscardCounts`；null→view 不重播 |
| topMeld 4 杠仅 1.7px 余量 | 要求组内 0 水平 padding/border；若余量 <4s 则按 `(topBacksW−4s)/contentW` 缩 top meld scale |
| selfMeld 左移量未进契约 | 布局输出 `selfMeld.rect`（含左移后的画布坐标）；River 用局部坐标渲染 |
| threeRevealed 的 top.revealed 未建模 | top 亮牌走 HandBacks；几何与牌背同尺寸，不改变 top 河矩形；补 HandBacks 测试 |
| 其他数字/注释 | §5 表全部按 v9 原型重生成 |

## 1. 侧副露几何（no-rotate）

- 素材：`left/`、`right/` 49×40 预旋转牌面；`direction` 直接用；**不 rotate**。
- 牌盒：`w=56×0.65=36.4`，`h=45.714×0.65=29.714`（s=1）；aspectFit 比例 49:40=1.225，正好填满。
- `MahjongMeld.vertical`：column；非首张 `marginTop=-4s`；4 张全部 inline，无 cap。
- 组高（s=1）：碰 3 张 = `3×29.714−2×4 = 81.14`；杠 4 张 = `4×29.714−3×4 = 106.86`。
- 4 组 + 3×8：碰 `4×81.14+24 = 348.57`；杠 `4×106.86+24 = 451.43`。
- `sideMeldScaleV2` 默认 0.65；4 杠超过 750 mid 可用 447.2 ⇒ 降到 **0.64**：tileH=29.257，groupH(4)=105.03，4 组 +24 = **444.11**（≤447.2）。
- lane 宽 = 36.4+4 = **40.4s**；侧副露在河内侧。
- 暗杠：4 张全 `back`；`MahjongTile.mode='aspectFill'` 填满 36.4×29.7 横盒；83×125 背图裁掉约 45.8% 高度（金边被裁），接受并在横盒加 1px 金边保持观感；面牌仍 aspectFit。
- 组件测试（jsdom 机械）：direction left/right、无 rotate class、4 张在流内、非首张 marginTop=-4s、angang 4 张 src=back 且 mode=aspectFill；可见尺寸放真浏览器截图。

## 2. 四河窗口与 claimSource 索引

统一字段（四河都输出）：

| 字段 | 定义 |
|---|---|
| `raw` | 过滤 claimed/revealed 后的实际张数 |
| `visible` | `min(raw,24)` |
| `overflow` | `raw−visible` |
| `windowCount` | 上/下：`overflow>0?23:visible`；侧：`overflow>0?(capacity≥25?24:23):visible` |
| `badgeCount` | `raw−windowCount`（上/下 29→6；侧 29→5） |
| `windowStart` | `raw−windowCount`（显示最新窗口） |
| `latestIndex` | `windowCount−1`（**窗口内**下标） |
| `badgeCell` | `windowCount`（0-based 第 windowCount 格） |
| `badgeRect` | 由 `badgeCell` 在 River 网格内算出的 **River 局部坐标** |

- 上/下：29 张 → `windowStart=6, windowCount=23, latestIndex=22, badgeCell=23, badgeCount=6`；绝对最新 = 6+22=28。
- 侧：29 张、capacity 27/30 → `windowStart=5, windowCount=24, latestIndex=23, badgeCell=24, badgeCount=5`；绝对最新 = 5+23=28。
- capacity=24 的侧河（当前七档不可达，防御分支）→ `windowCount=23`、badgeCell=23。
- River 点击 payload：`{ tile, index }`，`index` 为窗口内下标；Board 比较 `index===latestIndex`，来源牌取 `discards[windowStart+latestIndex]`。
- 一律 `slice(windowStart, windowStart+windowCount)`；不再用 `slice(0,24)`。
- `badgeRect/meldRect` 均为 River 局部坐标；Board 从 layout 画布坐标减去 `river.rect.left/top`。
- claim：普通 claim 高亮来源座 `latestIndex` 那张；rob 无弃牌点击，`claimSourceMeldKey` 高亮杠家 peng 副露。

## 3. 组件/交互收口

- **banner**：新增 `bannerSeq` + `:key`；`seenHuSeats`/`seenMeldKeys`/`prevDiscardCounts` 在挂载/首个非 null view seed；null→view 不重播；animationend 用 `startsWith('ftl-hu-banner')` / `startsWith('ftl-peng-pop')` 等。
- **MahjongTile**：新增 `mode?: 'aspectFit'|'aspectFill'`（默认 aspectFit）；暗杠背 aspectFill；面牌 aspectFit。
- **MahjongMeld**：`vertical` + 4 inline 无 cap；组内 0 水平 padding/border（top 4 杠余量 1.68px）。
- **topMeld**：`width=min(max(河宽,contentW),topBacksW)`；4 杠 content 451.75；若 `topBacksW−contentW <4s`，按 `(topBacksW−4s)/contentW` 缩 top meld scale；测试余量 ≥4s。
- **selfMeld**：布局输出 `selfMeld.rect`（含左移）；与动作区净空 ≥4s；River 用局部坐标。
- **SeatChip**：`activeLevel: 'strong'|'line'|null` + `winner?`；4 相位；静态；无 fan/张数行。
- **MjDeal**：本局首次观察到 play 的 latch；首个观察即 play ⇒ seed=true 不播；先 exchange/lack 后 play 才播。
- **无限闸**：从 `animations.scss` 解析含 `infinite` 的类集合；扫麻将组件模板 `anim-*` 使用 + `<style>` 的 `animation:` 行；交集只允许 `anim-claim-pulse`；排除 animations.scss；合成违例。
- **v2 tokens**：独立 `tokensV2`；旧 `mahjongTableLayout`/旧测试冻结；`mahjong-board.test.ts` 改 v2。
- **River props**：`windowStart/windowCount/latestIndex/badgeCount/badgeCell/badgeRect/meldRect/laneWidth`；DOM 断言局部坐标。
- **座位牌**：对手 160×56（头像 56+文本 94）、对家 164×56（56+98）、自己 64×76（头像 44 居中上、分数 16 + delta 10 下方通栏）；名字 18/分数 18/delta 14；角标右上 1 字/左下 2 字。
- **Hub**：compact 32/18/12（≤8 字）、normal 40/22/14（≤10 字）；状态行 y +50/+55；方位点盘缘装饰。
- **其他**：房间号；ActionBar 统一 claim；backwards 闸；`mahjong-keys.ts`；`handle` 见 v8 §4。

## 4. 原型结果（七档 × 14 态 ALL GREEN）

| 画布/态 | hub | 侧河 | top 窗口 | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 | 侧副露 81.14 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 win6+23 | 993.7,438 | 947.3 | 绝对最新 28 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | **844.9** | 侧 24+5，win5+24 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 | 4 碰 348.57 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 949.8,438 | 917.6 | 4 杠 106.86/451.43/0.64/444.11 |
| 1334×750 revealed29 | 200 | 9r/2c | 8c | 993.7,438 | 1005.3 | 14 亮无 +N |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 | 覆盖 9.8×114 |
| 1334×1000 gangHeavy | 220.3 | 10r/2c | 8c | 910.6,656.3 | 875.0 | 0.65/497.2 |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 846.7,656.3 | 747.2 | 覆盖 78.0×125.6 |

七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
十四态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29、oneSideRevealed、threeRevealed。

## 5. 测试矩阵

- 画布七档；状态十四态；组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6（上/下）/24+5（侧）、revealed 无 +N、双胡（正常/reduced）。
- 窗口：`windowStart+latestIndex=raw−1`；`windowCount+(badge?1:0) ≤ capacity`；`slice(windowStart, windowStart+windowCount)`；29 张 claim 可点最新。
- animationend：真实哈希名驱动 hu/meld；禁止 `$emit('done')`。
- 发牌：v1 exchange/lack 播、v5 mount 不播、remount 摸牌只新牌动；MjDeal latch 三测；seenMeldKeys null→view。
- 无限闸：模板+style 双扫；排除 animations.scss；合成违例。
- 旧 v1 layout 测试锚点不改；`mahjong-board.test.ts` 改 v2；v2 七档锚点另写。
- 回归：client 全量、vue-tsc、uni build。

## 6. 决策表追加

| 编号 | 决策 |
|---|---|
| D86 | 4 张组高 106.86；4 组 451.43；4 杠 0.64/444.11 |
| D87 | 听牌行高 94；twoSurvivors 844.9 |
| D88 | 四河统一 windowStart/windowCount/badgeCount/latestIndex/badgeCell/badgeRect |
| D89 | claim 点击 `{tile,index}` 窗口内；来源 = discards[windowStart+latestIndex] |
| D90 | MahjongTile mode aspectFit/aspectFill；暗杠背 cover |
| D91 | 无限闸先解析 infinite 集合再扫使用点 |
| D92 | River 局部坐标；Board 减 river 原点 |
| D93 | seenHuSeats/seenMeldKeys/prevDiscardCounts null→view seed |
| D94 | topMeld 4 杠余量 ≥4s 或缩 scale |
| D95 | selfMeld.rect 输出左移 |
| D96 | top revealed 走 HandBacks；几何不变 |

## 7. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张同型弃牌；客户端全量重算。
2. 动作浮层最坏覆盖 78.0×125.6（1334×833/1000），必然含最新弃牌；路线 A 接受。
3. Hub compact 162.4 状态行 ≤8 字；超长昵称省略。
4. 108 张单家弃牌 ~29；上/下显示 23+6，侧 24+5。
5. 136 张玩法不在本片。
6. 暗杠背 cover 裁掉约 45.8% 高度（金边），以 1px 金边补偿；mockup 展示。
7. 4 杠侧副露 0.64/444.11；极端态 mockup 展示。
8. capacity=24 的侧河分支当前七档不可达，仅防御。
