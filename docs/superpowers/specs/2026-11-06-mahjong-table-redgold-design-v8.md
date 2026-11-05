# 麻将牌桌「川麻红金」重做设计 spec v8

日期：2026-11-06
状态：已被 v9 取代（`2026-11-06-mahjong-table-redgold-design-v9.md`）；本文件保留 v8 复审前版本。
取代：`2026-11-05-mahjong-table-redgold-design-v7.md`
继承：v7 + v6 + v5 + v4；**未列部分按 v7/v6/v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v8 原型；七档 × 14 态 **ALL GREEN**）。

## 0. v8 修订（v7 复审 3 Critical + 关键 Important）

| v7 问题 | v8 处理 |
|---|---|
| C1/C2 侧副露 rotate 路线不成立：符号反、aspectFit letterbox、direction 覆盖 rotate、旧 cap 只 3 张进流 | **放弃 rotate**。侧副露直接用现有 `left/right` 49×40 预旋转素材 + `direction`；牌盒 36.4×29.7@0.65（aspectFit 正好填满）；`vertical` 只做 column + `marginTop:-4s`；4 张全部 inline（无 cap）；暗杠背用 `aspectFill`/cover 填满横盒 |
| 视觉 34×51 / 组高 101.4 / 4 组 429.6 是透明盒模型 | 真实可见盒 36.4×29.7；组高 81.1/110.8；4 组 348.6/467.2；4 杠动态 scale 0.64（750） |
| bannerSeq “保留”但代码没有；seenHuSeats 未 seed | **新增** `bannerSeq` + `:key`；挂载/首个非 null view seed `seenHuSeats`；animationend 用 startsWith |
| 侧河 24+N 徽标未计入容量；side window 字段缺失 | 容量检查 `visible+(overflow?1:0) ≤ rows×cols`；四河输出 windowStart/windowCount/badgeCount/badgeRect/latestIndex |
| oneSideRevealed/threeRevealed 声称有但原型没有 | 原型新增两态；七档 × 14 态 ALL GREEN；右侧 pitch 按边 |
| 听牌行 2×5 与左侧副露 lane 相交 | 改 **3 行 × 4 列**（最多 12，实际 9），宽 86、高 92；原型无相交 |
| Board 测试 import v1 layout，v2 改手牌宽会红 | 明确 `mahjong-board.test.ts` 改用 v2；v1 layout 测试冻结 |
| 自己 64 宽“44 头像 + 文本列 20”矛盾 | 自己牌**竖向**：头像 44 居中上、分数 16 + delta 10 下方通栏 64；不做并排文本列 |
| Hub 方位点穿金环/未建模 | 方位点声明为盘缘装饰，允许覆盖金环；不参与内容 fit；fit 只查状态行/听 N/徽标矩形 |
| 24 格侧河退化未实现 | 容量=24 时 windowCount=23、badgeCount=raw−23；补齐 |
| 侧副露 lane 只有 meld.width，无法表达内侧 lane | River 增加 `meldRect`/`laneWidth`（或 `placement:'inner'`），子项 `overflow: visible`；DOM 断言 x/width |
| MjDeal latch 字面冲突 | 首个观察为 play ⇒ latch seed=true 不播；先 exchange/lack 后 play 才播 |
| 数字陈旧 | §5 表按 no-rotate 原型更新；`twoSurvivors` 等以原型为准 |

## 1. 侧副露：不旋转

- 素材：直接使用现有 `left/`、`right/` 49×40 预旋转牌面（与侧河一致），**不使用 `rotate`**。
- 牌盒：`w = 56s × 0.65`、`h = 45.714s × 0.65`（0.65 后 36.4×29.7），aspectFit 比例 49:40=1.225 正好填满，无 letterbox。
- `MahjongMeld.vertical`：`flex-direction: column`；非首张 `marginTop: -4s`（组内叠压 4）；4 张全部 inline，**不使用旧 cap 绝对定位**（当前组件已是 4 张 inline，保留）。
- 组高：碰 3 张 = 3×29.7−2×4 = 81.1s；杠 4 张 = 110.8s；4 组 + 3×8 = 348.6s（碰）/467.2s（杠）。
- 4 杠超过 750 mid 可用 447.2s ⇒ `sideMeldScaleV2` 从 0.65 降到 0.64（实测 444.1s，放得下）；1000 档 0.65/497.2s。
- 侧 lane 宽 = 36.4s + 4s = 40.4s；位于侧河内侧。
- 暗杠：4 张全部 `back`，牌背图 83×125 用 `aspectFill`/cover 填满 36.4×29.7 横盒（背图无线条信息，裁切安全）；面牌仍 aspectFit。
- 组件测试（jsdom 只做机械断言）：vertical 时 direction=left/right、无 rotate class、4 张都在流内、非首张 marginTop=-4s、anggang 4 张 src=back/cover；可见尺寸放真浏览器截图。
- 删除 v7 的 `MahjongTile.rotate` 计划；旧 rotate 代码不恢复。

## 2. 胡 banner / 副露 pop

- **新增** `bannerSeq`（初始 0），模板 `:key="bannerSeq"`；`showNextBanner()` 自增。
- `animationend` 守卫改 `String(e.animationName).startsWith('ftl-hu-banner')`；Meld 的 peng/gang/angang 同理 `startsWith('ftl-peng-pop')` 等。
- `seenHuSeats` 在挂载/首个非 null view 时把现有 `huInfos` 全部 seed；重连不重播。
- reduced-motion：`prefersReducedMotion()` 公共 helper；下一版 view 展示下一条；`settlementRevealed` 清空整队；测试两条独立断言。
- 测试：真实 `animationend`（哈希名）驱动，禁止 `$emit('done')`；双胡正常/reduced；单胡不回归。

## 3. 几何/内容收口

- 听牌行：**3 行 × 4 列**，宽 86、高 92，最多 12（实际 9）；位于自家河左侧；原型无相交。
- side 24+N：`visible = min(raw,24)`；容量检查 `visible+(overflow?1:0) ≤ rows×cols`；容量=24 时 `windowCount=23`、`badgeCount=raw−23`；输出 `badgeRect/windowStart/latestIndex`。
- top/own 24+N：`windowCount=23`（溢出时）、`badgeCount=raw−23`（29→6）、`badgeRect` 第 24 格、`latestIndex=windowCount−1`。
- revealed：只左右河区；`raw=revealed`；sideTop+16；oneSideRevealed/threeRevealed 进矩阵；右侧用 `rightBacks.pitch`。
- 座位牌：对手 160×56（头像 56 + 文本 94）、对家 164×56（56+98）、自己 64×76（**竖向**：头像 44 居中上、分数 16 + delta 10 下方通栏）；名字 18/分数 18/delta 14；角标右上 1 字/左下 2 字。
- Hub：compact 32/18/12（≤8 字）、normal 40/22/14（≤10 字）；状态行 y +50/+55；fit 查状态行/听 N/徽标矩形；方位点盘缘装饰（可覆盖金环），不参与 fit。
- 动作浮层：overlayWorst 1334×1000 覆盖 **78.0×125.6**；路线 A 接受；浮层 0.86 + 金边；非行动隐藏。
- 侧副露组距 8s；lane 40.4；侧区宽更新；原型七档×14态 ALL GREEN。

## 4. 交互/组件收口

- 手牌 `dealEpoch` 初始 null；v>1 seed 哨兵；发牌类只认匹配且 `!drawn`；摸牌/牌背尾部 null；测试 v1 exchange/lack、v5 mount、remount。
- 头像尺寸：对手/对家 56、自己 44；Board 从 layout 输出的 `avatar` 取，不复用 selfChip.width/barChip.w。
- claimSource：claim 用 `latestIndex`；rob 用 `claimSourceMeldKey`；River props 补全 `windowStart/windowCount/latestIndex/badgeCount/badgeRect/meldRect/laneWidth`；Meld `highlight`；Board 只接受 `windowId.startsWith('claim:')` 且 index===latestIndex 的点击；rob 一律 false。
- meld key：`src/game/mahjong-keys.ts`；`meldKey(seat,m)=${seat}:${kind}:${首张type}`；结构化解析；Board/useTableSound 共用；测试同座碰→补杠 MjGang、直杠 MjGuafeng。
- SeatChip：`activeLevel: 'strong'|'line'|null` + `winner?`；4 相位；静态；无 fan/张数行。
- MjDeal：本局首次观察到 play 的 latch；首个观察即 play ⇒ seed=true 不播；先 exchange/lack 后 play 才播；三测。
- 无限闸：扫麻将组件模板 `anim-*` + `<style>` 的 `animation:` 行；白名单 `anim-claim-pulse`；排除 `animations.scss`；合成违例。
- River：侧副露 `meldRect`/`laneWidth`（或 `placement:'inner'`），子项 `overflow: visible`；DOM 断言。
- v2 独立 `tokensV2`；旧 `mahjongTableLayout`/旧测试冻结；`mahjong-board.test.ts` 改用 v2。
- 房间：顶栏左返回 + `roomCode` + 场次/底分。
- ActionBar：claim 由 MahjongActionBar 渲染；ClaimTile 删除或只留 tile 预览。
- backwards 闸只扫发牌/手牌类；豁免 meld-pop/banner/settlement。
- 组件清单补：MahjongMeld（vertical/no cap）、MahjongTile（direction only，不 rotate）、MahjongHandBacks（dealNonce/pitch）、MahjongRiver（完整窗口/meldRect）、MahjongHub、MahjongActionBar、MahjongSeatChip、mahjong-layout.ts（v2）、mahjong-keys.ts、useTableSound、table.vue。

## 5. 原型结果（七档 × 14 态 ALL GREEN）

关键行（no-rotate）：

| 画布/态 | hub | 侧河 | top | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 949.3,438 | 916.5 | 侧副露 81.1 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 | 993.7,438 | 947.3 | 徽标 6 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 859.2 | 24+5/1 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 960.9 | 4 碰 348.6 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 949.8,438 | 917.6 | 4 杠 scale 0.64/444.1 |
| 1334×750 revealed29 | 200 | 9r/2c | 8c | 993.7,438 | 1005.3 | 14 亮无 +N |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 891.3,438 | 800.5 | 覆盖 9.8×114 |
| 1334×1000 gangHeavy | 220.3 | 10r/2c | 8c | 910.6,656.3 | 875.0 | 0.65/497.2 |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 846.7,656.3 | 747.2 | 覆盖 78.0×125.6 |

七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
十四态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29、oneSideRevealed、threeRevealed。

## 6. 测试矩阵

- 画布七档；状态十四态；组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6、侧 24+5、revealed 无 +N、双胡（正常/reduced）。
- animationend：真实哈希名驱动 hu/meld；禁止 `$emit('done')`。
- 发牌：v1 exchange/lack 播、v5 mount 不播、remount 摸牌只新牌动；MjDeal latch 三测。
- 无限闸：模板 + style 双扫；排除 animations.scss；合成违例。
- 旧 v1 layout 测试锚点不改；`mahjong-board.test.ts` 改 v2；v2 七档锚点另写。
- 回归：client 全量、vue-tsc、uni build。

## 7. 决策表追加

| 编号 | 决策 |
|---|---|
| D74 | 侧副露不旋转：left/right 素材 + direction + vertical；盒 36.4×29.7@0.65 |
| D75 | 4 张 inline 无 cap；暗杠背 aspectFill；组高 81.1/110.8 |
| D76 | 4 杠动态 scale 0.64；lane 40.4；组距 8 |
| D77 | 听牌行 3×4（≤12，实际 9） |
| D78 | 新增 bannerSeq；seenHuSeats seed；startsWith |
| D79 | side 容量含徽标；四河窗口字段完整 |
| D80 | 座位牌自己竖向布局（44 头像 + 16/10 通栏） |
| D81 | Hub 方位点为盘缘装饰；fit 只查内容 |
| D82 | River meldRect/laneWidth；overflow visible |
| D83 | Board 测试改 v2；v1 layout 测试冻结 |
| D84 | MjDeal latch seed-on-play |
| D85 | 旧 rotate 代码不恢复 |

## 8. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张同型弃牌；客户端全量重算。
2. 动作浮层最坏覆盖 78.0×125.6（1334×833/1000），必然含最新弃牌；路线 A 接受。
3. Hub compact 162.4 状态行 ≤8 字；超长昵称省略。
4. 108 张单家弃牌 ~29；显示 24（上/下 23+徽标）。
5. 136 张玩法不在本片。
6. 侧副露 0.65 后 36.4×29.7 设计 px；k=0.52 时约 18.9×15.4 物理 px；4 杠缩 0.64 后略小。
7. 侧副露 4 组/4 杠为极端态，mockup 展示。
