# 麻将牌桌「川麻红金」重做设计 spec v6

日期：2026-11-05
状态：已被 v7 取代（`2026-11-05-mahjong-table-redgold-design-v7.md`）；本文件保留 v6 复审前版本。
取代：`2026-11-05-mahjong-table-redgold-design-v5.md`
继承：v5 + v4；**未在本文件列出的内容按 v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v6 原型；七档 × 12 个可达态 **ALL GREEN**）。

## 0. v6 修订（v5 审查 2 Critical + 关键 Important）

| v5 问题 | v6 处理 |
|---|---|
| C1 侧副露只加 vertical 不能正确竖排；叠压仍 marginLeft；无 rotate | `MahjongMeld` 加 `vertical` 且组内叠压走 `marginTop: -4s`；`MahjongTile` 恢复 `rotate`，侧副露用 49×40 牌面旋转 90°（40:49，盒 29.7×36.4s）；固定叠压 4s，4 杠动态 scale（实测 0.52/0.53，总高 441.9/496.6） |
| C2 胡 banner 无 key，第二个不可见、队列卡死 | `bannerSeq` 单调 key；正常 animationend 出队；reduced-motion 由下一版/`settlementRevealed` 出队，揭示时**清空整队**；测试双胡 |
| topMeld 宽度 468 > topBacks 453 | `topMeldW = min(max(河宽, 内容宽), topBacksW)`；top29 468→453.4；内容 451.75 放得下；补断言 |
| revealed 用 max(discards,revealed)，29 弃+14 亮会 +5 | `raw = revealed>0 ? revealed : discards`；只左右河区；top 走 HandBacks、self 走手牌；sideTop +16s；revealed29 显示 14、无 +N |
| 布局输入缺 3/4 张副露 | `bySlot[side].melds: number[]`（每组 3/4 张）；混合组逐组求和；gangHeavy/selfFourGang 触发缩 scale |
| 24+N 的 N 差 1；无 badgeRect/latestIndex | 上/下 `windowCount=23`、`badgeCount=raw−23`（29→6）；侧 24、badgeCount=raw−24（29→5）；输出 `badgeRect/latestIndex/windowStart` |
| 座位牌分数+delta 88>74 / 72>64 | 对手牌 160×56（文本 94）、对家 164×56（98）、自己 64×76；名字 18/分数 18/delta 14；自己头像 44/分数 16/delta 10 第三行；delta 固定、分数省略 |
| 角标“庄+缺万”54>48 | 固定对角两槽：右上 1 字（庄/胡/听/托），左下 2 字（缺X）；最多 2 个；每槽独立宽度，不再用总宽 48 |
| Hub fit 只算近中心；真实文案 12 字 | 状态行 y 固定在 compact +50 / normal +55；fit 纳入标签/听 N/徽标/方位点；文案全部 ≤8（compact）/≤10（normal）；省略号按 1em |
| 手牌 key occurrence 漂移 | 改 `dealNonce-index`；entry 带 `dealNonce`，摸牌位 `dealNonce=null`；发牌类只认 `entry.dealNonce===dealEpoch && !entry.drawn`；不依赖清 `dealing` |
| SeatChip 未进 §3；弃牌者金线/赢家金边无状态 | §3 补 SeatChip：`activeLevel: 'strong'\|'line'\|null` + `winner?`；claim 我 strong、弃牌者 line、其他 null；ended winner；静态；无张数 |
| §3 漏 layout v2 | §3 补 `mahjong-layout.ts`：新增 `mahjongTableLayoutV2`；旧函数/旧测试保留；接口按 v6 §3.3 更新 |
| meld key 跨家同型不可达；共用 helper 格式风险 | helper 统一 `seat:kind:首张 type`；动机改为“键一致/可维护”；测试用可达场景（同座碰→补杠、直杠） |
| claimSource 单张/副露高亮无 API | River 增 `claimSourceIndex?`/`claimSourceMeldKey?`；Meld 增 `highlight?`；Board 只接受同 type 点击；rob 无弃牌点击 |
| Hub 文案超长 | 文案表全部短句（见 §3.4） |
| overlay 最坏 70.7×125.6 | 用 overlayWorst 记录：1334×1000 覆盖 70.7×125.6；路线 A 接受“必然覆盖最新弃牌”，浮层漆面 0.86 + 金边；非行动隐藏 |
| 27/30 分档 | top 有副露 9 行、无副露 10 行；16:9 25 弃 3×9=27，1000/1334 3×10=30 |
| 16px/18px 角标/字号未声明取代 v4 | §3.4 明确替代 v4 §5/§7.2 的盘中字号 |
| s 0.86 vs 0.88 | 明确 0.86，重写 layout 测试锚点 |
| audio bootstrap 测试、房间号、dealing 死规则、infinite 扫描、ActionBar vs ClaimTile、Meld/HandBacks 测试 | 见 §4 |

## 1. 侧副露竖排（C1）

- `MahjongMeld` 新增 `vertical?: boolean` 与 `verticalOverlap: number`（设计 px）；`vertical` 时 `flex-direction: column`，非首张 `marginTop: -verticalOverlap`。
- `MahjongTile` 恢复 `rotate?: 0 | 90`（`transform: rotate(90deg)`，盒宽高交换）；侧副露 tile 盒 = 29.7s × 36.4s（40:49），素材 `left/right` 49×40 旋转 90°。
- 组高：碰 3 张 = 3×36.4s − 2×4s = 101.2s；杠 4 张 = 133.6s；固定叠压 4s。
- 4 组：4 碰 428.8s；4 杠 558.4s > 可用高度（750 mid 447.2s）⇒ 动态缩 `sideMeldScale`（0.65→0.4）；实测 gangHeavy 0.52/0.53、总高 441.9/496.6（833/1000）。
- 侧 lane 宽 = 45.714s×scale + 4s（约 33.7s@0.65）；位于侧河内侧；侧区宽 = 背 30.336s + gap + 河 + (副露 ? gap+lane : 0)。
- 组件测试：3 张/4 张组高、4 组总高、scale 下限、旋转后可见牌面高度 ≥36s（不是 letterbox 24.3）。

## 2. 胡 banner（C2）

- `bannerSeq` 单调递增；模板 `:key="bannerSeq"`；`showNextBanner()` 自增 seq，强制新节点。
- 正常：`animationend` 出队。
- reduced-motion：`prefersReducedMotion()`（复用 Hand.vue 的 matchMedia，抽公共 helper）；无动画时由**下一版 view**展示下一条；`settlementRevealed` 为 true 时**清空 `bannerQueue` 与 `currentBanner`**，不只弹一条。
- 测试：双胡正常（两次节点/ key 不同、第二条可见）；双胡 reduced-motion（settlementRevealed 后 DOM 无 `.mj-hu-banner`）；单胡不回归。

## 3. 几何/内容收口

### 3.1 topMeld

- `topMeldW = min(max(topRiver.width, contentW), topBacksW)`；top29 468→453.4；4 杠 content 451.75 放得下；content > topBacksW 时缩 scale。
- 断言 topMeldW ≤ topBacksW、topMeldContentW ≤ topBacksW、topMeld×plates 不相交。

### 3.2 revealed

- 只左右河区显示亮牌：`raw = revealed > 0 ? revealed : discards`；`visible = min(raw,24)`；revealed>0 时 `overflow=0`、无 +N；`sideTop += 16s`。
- top 的 revealed 走 HandBacks；self 走手牌行；own river 不替换。
- revealed29（29 弃 +14 亮）→ 14 张、2 列、无 +N；测试。

### 3.3 布局输入/输出

输入：`{ bySlot: { self, top, left, right: { discards, melds: number[], revealed } }, phase, tingCount }`。
`melds` 是每组张数数组（3/4）；混合组逐组求和。输出新增/修改：

```ts
interface MahjongTableLayoutV2 {
  // ...v5 字段
  rivers: {
    top: RiverLayout & { windowStart: number; windowCount: number; badgeCount: number; badgeRect: Rect | null; latestIndex: number };
    // self/left/right 同
  };
  backLeft: { rect: Rect; tile: { w: number; h: number }; pitch: number };
  // 侧背 tile 30.336s × 45.714s
}
```

- 上/下：`windowCount = overflow>0 ? 23 : visible`；`badgeCount = raw − windowCount`；`windowStart = raw − windowCount`；`latestIndex = windowCount − 1`；`badgeRect = 第 24 格`。
- 侧：`windowCount = visible`；`badgeCount = raw − visible`；`badgeRect = 第 visible+1 格`；`latestIndex = visible − 1`。
- 删除 `actionCount`、`ting.overflow`、`centerTiles`；`ting.max=9`。
- s = `max(1, min(H/750, 0.86W/手牌行宽))`；重写 layout 测试锚点。
- 旧 `mahjongTableLayout` 保留；新函数 `mahjongTableLayoutV2`。

### 3.4 字号/文案（取代 v4 §5/§7.2）

- Hub：normal 牌墙 40/秒 22/状态行 14/听 N 14/徽标 16/方位点 10；compact 32/18/12/12/14/8；金环内缩 3px。
- 状态行最多 10（normal）/8（compact）字；文案：
  - exchange：我「选同花色3张」；等待「等待换三张」。
  - lack：我「请定缺」；等待「等待定缺」。
  - play：我「请出牌」；等待「等待出牌」。
  - claim：我「请响应」；等待「等待响应」。
  - ended：「本局结束」/「已胡 N 家」。
- 座位牌：对手 160×56（文本 94）/对家 164×56（98）/自己 64×76；名字 18、分数 18、delta 14；自己头像 44、分数 16、delta 10 第三行；分数省略、delta 固定。
- 角标：右上 1 字（庄/胡/听/托）、左下 2 字（缺X）；最多 2；每槽独立宽度；无张数。

### 3.5 动作浮层

- actions 176×176，x = W−outer−rightZoneW−gap−176s，y = handTop−16s−176s；2×2 84s。
- `actions×ownRiver` 允许；overlayWorst 实测 1334×1000 覆盖 70.7×125.6（必然含最新弃牌）；路线 A 接受；浮层漆面 `rgba(28,8,8,.86)` + 金边，非行动隐藏。
- 自己副露左移避开动作区（v5 规则）；选中抬 10 净空 ≥6。

### 3.6 其他

- 侧背 30.336×45.714（83×125）；侧 lane 33.7@0.65。
- top 有副露 9 行、无副露 10 行；25 弃 16:9 3×9=27，1000/1334 3×10=30。
- 上/下副露河外侧；左右副露河内侧。
- 已胡标签移河内/底部；revealed sideTop +16s。

## 4. 交互/测试收口

- **手牌 key**：`dealNonce-index`；entry 带 `dealNonce`；摸牌位 `dealNonce=null`；发牌类只认 `entry.dealNonce===dealEpoch && !entry.drawn`；不在局中清 `dealing`。对手背同理；尾部新背 `dealNonce=null`。
- **SeatChip**：`activeLevel: 'strong'|'line'|null` + `winner?: boolean`；claim 我 strong、弃牌者 line、其他 null；ended winner；静态无 infinite；无张数；测试。
- **layout v2**：§3.3；旧函数/旧测试保留；新测试重写七档锚点。
- **meld key**：`seat:kind:首张 type`；Board pop 键与 useTableSound 共用；测试同座碰→补杠 MjGang、直杠 MjGuafeng；不再声称跨家漏音。
- **claimSource API**：River `claimSourceIndex?`（绝对 discards index）/`claimSourceMeldKey?`；Meld `highlight?`；Board 只接受同 type 点击；rob 无弃牌点击；测试。
- **audio**：setup 时已有 v1 exchange/lack 也播 MjShuffle；v>1 不播；MjDeal 首次 play；出牌 MjSort；meld key 带 seat；测试。
- **房间**：顶栏左返回按钮 + 房间号（roomCode）+ 场次/底分；测试。
- **infinite 闸**：只扫麻将组件 DOM/class 使用点，允 `anim-claim-pulse`；删 `anim-lack-pulse` 使用；删除死类 `anim-active-glow`。
- **ActionBar vs ClaimTile**：claim 由 `MahjongActionBar` 渲染；`ClaimTile` 删除（或仅保留 tile 预览子组件，不渲染按钮）；测试改 `mahjong-action-bar.test.ts`。
- **Meld/HandBacks 测试**：`mahjong-tile-meld.test.ts` 加 vertical/rotate；`mahjong-hand-backs.test.ts` 加 dealNonce/tail。
- **backwards 闸**：只扫发牌/手牌类；豁免 meld-pop/banner/settlement。
- **新增/修改文件**：MahjongMeld（vertical/rotate）、MahjongTile（rotate）、MahjongHandBacks（dealNonce）、MahjongRiver（claimSourceIndex/MeldKey/windowCount/badgeRect/latestIndex/claimed/revealed）、MahjongHub（fit/文案）、MahjongActionBar（四 mode/多杠/pass）、MahjongBoard（dealNonce/claimSource/seatActiveLevel/bannerSeq/返回）、MahjongSeatChip（states）、mahjong-layout.ts（v2）、useTableSound（seat key/bootstrap）、animations.scss、uni.scss、table.vue。

## 5. 原型结果（七档 × 12 态 ALL GREEN）

关键行：

| 画布/态 | hub | 侧河 | top | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 955.9,438 | 929.9 | 侧副露 101.2 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 | 993.7,438 | 947.3 | 徽标 6 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 851.6 | 29/25→24+5/1 |
| 1334×750 selfFourGang | 200 | 10r/3c | 8c | 897.9,438 | 909.6 | 4 杠副露左移 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 961.9,438 | 941.8 | 侧 scale 0.52，441.9 |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 902.1,438 | 818.0 | 覆盖 1.0×114 |
| 1334×750 revealed29 | 200 | 9r/2c | 8c | 993.7,438 | 1005.3 | 14 亮牌无 +N |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 854.1,656.3 | 761.9 | 覆盖 70.7×125.6 |

七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。十二态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29。

## 6. 测试矩阵

- 画布七档；状态十二态；组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6、侧 24+5、revealed 无 +N、双胡（正常/reduced）。
- 不相交：hub×河/背/侧副露/座位牌/手牌/动作；actions×手牌/自己副露/侧区；座位牌×手牌/顶背/顶副露；选中抬 10；听牌；河×侧河。
- 动作×ownRiver 只记录；overlayWorst 覆盖量断言。
- 容量：visible≤rows×cols/cols×2；badgeCount/latestIndex/windowStart；claimed 过滤后计数。
- Hub：compact 阈值；真实文案 fit；金环内缩。
- 动效：发牌仅挂载 v1；lack→play/摸牌/牌背尾部不重播；banner key/双胡；infinite 计数=1；发牌 backwards。
- 回归：client 全量、vue-tsc、uni build。

## 7. 决策表追加

| 编号 | 决策 |
|---|---|
| D40 | 侧副露 vertical + marginTop + rotate 90；固定叠压 4s；动态 scale |
| D41 | bannerSeq key；reduced-motion 揭示清空整队 |
| D42 | topMeldW 上限 topBacksW |
| D43 | revealed 只左右河区；raw=revealed；sideTop+16 |
| D44 | 布局输入 melds: number[]（3/4 张） |
| D45 | 24+N：上/下 23+badgeCount，侧 24+badgeCount；badgeRect/latestIndex |
| D46 | 座位牌 160/164/64；名字 18/分数 18/delta 14；自己 44/16/10 |
| D47 | 角标两对角槽（右上 1 字、左下 2 字） |
| D48 | Hub 文案 ≤8/10 字；字号替代 v4 |
| D49 | 手牌 dealNonce-index；不依赖清 dealing |
| D50 | SeatChip strong/line/winner；静态 |
| D51 | layout v2 新增；旧函数保留 |
| D52 | meld key seat:kind:首张 type |
| D53 | claimSourceIndex/claimSourceMeldKey/highlight |
| D54 | ActionBar 统一 claim；ClaimTile 删除 |
| D55 | s 0.86；七档重写锚点 |
| D56 | overlayWorst 70.7×125.6 接受；浮层 0.86 |
| D57 | 27/30 分档；top 有副露 9 行 |
| D58 | audio bootstrap/房间号/infinite 扫描/backwards 闸收口 |

## 8. 开放问题

无。v5 的 2 Critical 与关键 Important 已在本文件/原型收口；剩余为已知边界：

1. 服务端一炮多响删多张同型弃牌；客户端全量重算，不改服务端。
2. 4 杠一侧时侧副露 scale 0.52/0.53；牌面变小，mockup 展示。
3. 动作浮层最坏覆盖 70.7×125.6（1334×1000），必然含最新弃牌；路线 A 接受，非行动隐藏。
4. Hub compact 162.4 状态行 ≤8 字；超长昵称省略。
5. 108 张单家弃牌 ~29；显示 24（上/下 23+徽标）。
6. 136 张玩法不在本片。
