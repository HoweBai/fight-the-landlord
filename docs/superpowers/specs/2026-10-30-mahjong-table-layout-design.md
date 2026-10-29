# 麻将牌桌比例布局设计（2026-10-30）

> 状态：设计待对抗审查
> 需求来源：用户「当前麻将玩法的牌桌布局有问题，考察其它麻将游戏的牌桌布局」+
> 「按牌桌的比例进行设计，因为要考虑跨设备的问题」
> 用户裁决：跨设备缩放策略选 **高度基准 + 宽度兜底**。

## 1. 背景与问题

### 1.1 现状

四川麻将牌桌（`MahjongBoard.vue` + `MahjongSeatPanel.vue`）当前是**纵向堆叠面板**：

```
顶栏 → 对家面板 → [左家面板 | 中央提示 | 右家面板] → 我的副露/弃牌行 → 动作行 → 手牌
```

每个座位是一个半透明大盒子，盒子里放「名字/张数/金币/副露/弃牌/亮牌」。
实测（真实组件 + 早/中/晚三套夹具，Chrome 1334×750）暴露出这些与主流麻将桌的偏差：

| # | 偏差 | 证据 |
|---|---|---|
| 1 | 对手没有牌背，只有「13 张」文字 | `MahjongSeatPanel` 不渲染 `back` |
| 2 | 牌河不在中心：对家在顶部盒内、左右家是横排、我的牌河贴最左 | `.mj__top` / `.mj__side` / `.mj__mine` 的 DOM 结构 |
| 3 | 四方不对称：左右家是横向面板，牌河横排；真实牌桌左右家要旋转 90° | `.mj__side` 宽 24%，内部 flex 横排 |
| 4 | 手牌 46×69、`margin-left:-18px` 重叠，单张只露 28px；14 张只占约 33% 屏宽 | `MahjongTile.vue` + `.mj__hand` |
| 5 | 牌河/副露越大，面板越高：对家 99→160→201px，左右 92→144→243px，中央 345→284→243px；晚局中央只剩 67px | 三套夹具的 DOM 盒测量 |
| 6 | 动作按钮永久占一整行（92px），浮在桌子中间；牌墙在顶栏 | `.mj__action` |
| 7 | 玩家信息是占屏的大盒子，不是角落小卡 | `.mj-seat` 样式 |

### 1.2 主流布局的六条共同规则

考察对象：本机幼麟四川麻将开源版（`D:\Code\babykylin_scmj`，素材与交互参考源，直接读
`mjgame.fire` / `MyMahJong.prefab` / `PengGang*.prefab` 的坐标）、雀魂（Steam 官方截图）、
四川麻将·红中血流（App Store 截图）、腾讯欢乐麻将（App Store 截图）。四者同一套空间语法：

1. **手牌贴自己那条边**：自己最大、牌面朝上；别人用牌背，数量 = 张数。近大远小
   （幼麟：自己 75×113、对家背 40×59、左右家 24×60）。
2. **牌河在「手牌和中心之间」**，四家各一块，按各自方位旋转，固定网格
   （幼麟对家/自己 12 张/行 × 2 行、左右家 12 行 × 2 列），四块围出中央井。
3. **副露贴各自牌河/手牌的一端**，朝向自己。
4. **中央只放共享信息**：牌墙余量、局数、倒计时、最后一张；不放大面板。
5. **玩家信息是边角小卡**（头像/名字/分/缺门），不是占屏盒子。
6. **操作按钮浮在手牌上方**，只在需要时出现，不永久占一整行。

### 1.3 跨设备事实（仓库既有画布模型）

`useLandscapeCanvas.layoutMetrics()`：

```
k     = min(可用宽/1334, 可用高/750)
canvas = 可用宽/k × 可用高/k      // 恒 ≥ 1334×750，且至少一条边正好在最小值
```

典型画布（设计 px）：

| 视口 | 画布 | 说明 |
|---|---|---|
| 16:9 1280×720 | 1334×750 | 最小尺寸，两边都是基准 |
| 19.5:9 844×390 | 1623×750 | 高固定，宽变长 |
| 21:9 2560×1080 | 1778×750 | 高固定，宽更长 |
| 16:10 1280×800 | 1334×833 | 宽固定，高变长 |
| 4:3 1024×768 | 1334×1000 | 宽固定，高更长 |
| 正方形 1080×1080 | 1334×1334 | 宽固定，高最长 |

**上一版设计（固定 1334×750 坐标）只对 16:9 成立**，必须作废：
- 19.5:9 / 21:9 上手牌只占 64% / 59% 宽，中央 220px 成小岛；
- 4:3 / 正方形上所有元素挤在顶部 750px 内，下半张桌空着；手牌只占 10.8% 高；
- 固定 y 在平板上要么顶部锚定留 596px 空白，要么底部锚定留 596px 空白。

## 2. 范围

### 做

- 纯客户端重构 `apps/client/src/components/table/mahjong/**` 与
  `apps/client/src/pages/table/table.vue` 的麻将分支（仅接线，不改逻辑）。
- 新增纯函数 `mahjongTableLayout(W,H,input)`，按比例输出四家分区、牌河网格、中央井、动作浮层。
- 新增/拆分组件：座位小卡、对手牌背、牌河、中央井。
- 对家/左右家显示牌背（数量 = `cardCounts`）。
- 已胡者亮牌改为**替换该座的手牌区**（牌背/手牌位置），不额外占分区。
- 自己摸到的牌在行尾单独隔开（客户端 diff，不改协议）。
- 布局跨设备矩阵测试 + 现有交互测试。

### 不做

- 不改协议、服务端、配置中心、admin、数据库、结算、规则、音效、历史。
- 不做竖屏布局（`LandscapeStage` 已有旋转提示）。
- 不做真实头像（服务端不下发头像 URL；继续用 `default.png`）。
- 不重排斗地主/跑得快牌桌。
- 不新增计时器（牌桌区「不新造时钟」纪律）。

## 3. 决策表

| # | 决策 | 理由 / 取舍 |
|---|---|---|
| D1 | 统一比例单位 `s = min(H/750, 0.88W/1041.54)`，`s ≥ 1`；所有尺寸 = token × s | 高度基准保证竖向节奏；宽度兜底保证手牌永远 ≤88% 宽、左侧留出自家人像卡 |
| D2 | 位置用四边锚定 + 自由轴百分比/剩余空间，不写死 y | 画布至少一条边在最小值；写死另一条边会在平板/带鱼屏上漂 |
| D3 | 牌张比例沿用幼麟参考：自己 72×108s、牌河 50×75s、对家背 36×54s、左右背 30×45s、左右牌河 49×40s | 近大远小；与现有 4 方向 Atlas 一致（my/top 75:113、left/right 49:40） |
| D4 | 对手牌背数量 = `cardCounts[seat]`；已胡者用 `revealedHands` 的牌面**替换**牌背/手牌行 | 牌背数量就是服务端公开张数；亮牌放在手牌位最自然，不额外增高 |
| D5 | 牌河在各自「手牌与中心之间」：对家/自己 12 列 × 2 行；左右家 3 列 × 8 行（竖排） | 四块围出中央方井；左右家网格在横屏下比 2×12 更矮、更适合侧区 |
| D6 | 副露放在各自牌河靠中央一侧的独立条带，0.8× 牌河尺寸（左右家 0.7×），最多 4 组 | 不占手牌行；4 组在 12 列宽度内放得下；极端时中央井切紧凑模式 |
| D7 | 玩家卡：对家在顶栏右侧（40s 头像 + 名字/分/徽标）；左右家在本侧区顶部（56s）；自己在本方手牌左上方（56s） | 四角就近、互不碰撞；对家卡放进顶栏可避免顶区再长 56s 挤压中央 |
| D8 | 中央井：牌墙余量 + 阶段文案 + 待响应牌 + 听牌 + 倒计时文本；高度 <176s 时切单行紧凑模式 | 共享信息集中在井里；重副露局中央只剩 48s 时仍可读 |
| D9 | 动作按钮是右下浮层（自己牌河右侧、手牌上方），只在需要时出现；不再有永久动作行 | 不盖住别人的牌河（响应过滤要点的是别人的弃牌）；不挤压竖向空间 |
| D10 | 自己摸牌：客户端比对手牌 multiset 差集，把新增那张移到行尾并留 12s 缝；重连不显示 | 不改协议；重连摸牌标记缺失是已登记边界 |
| D11 | 组件拆分：`MahjongSeatChip` / `MahjongHandBacks` / `MahjongRiver` / `MahjongCenter`；`MahjongSeatPanel` 退役 | 每个组件一个职责；牌河/牌背可独立测试 |
| D12 | 画布尺寸由 `LandscapeStage` `provide` 一个 `ComputedRef<LayoutMetrics>`；棋盘 `inject`，缺省回退 1334×750 | 舞台已经同步算好尺寸；注入避免第二套 resize 监听/计时器 |
| D13 | 牌河固定槽位；弃牌超过 24 张时在原高度内压缩（对家/自己 12×3，左右 4×8），不增高分区 | 血战到底弃牌上限约 21；血流成河也不会挤掉中央 |
| D14 | 不做滚动、不做缩放动画；牌河/手牌都是固定 flex/grid | 牌桌不滚动（既有纪律）；布局纯静态 |
| D15 | 所有动效复用现有 `animations.scss`；组件内零 `setTimeout/setInterval` | 仓库 `animations.test.ts` 闸 |
| D16 | 不改 `table.vue` 的 props/emit 接线，只传新布局需要的 view 字段 | 边界不变：Board 只收 props、只 emit |

## 4. 比例模型

### 4.1 基准 token（s=1，设计 px）

| token | 值 | 说明 |
|---|---|---|
| `BAR_H` | 64 | `$ftl-bar-h`，容纳 56px 按钮 |
| `OUTER` | 12 | 桌边留白 |
| `INNER` | 8 | 区内间距 |
| `GAP` | 2 | 牌缝 |
| `HAND_TILE_H` | 108 | 手牌高；宽 = 108×75/113 = 71.68 |
| `HAND_COUNT` | 14 | 13 + 摸牌 |
| `DRAWN_GAP` | 12 | 摸牌与手牌的额外间隔 |
| `RIVER_TILE_H` | 75 | 牌河高；宽 = 75×75/113 = 49.78 |
| `RIVER_COLS` | 12 | 对家/自己牌河列数 |
| `RIVER_ROWS` | 2 | 常规行数 |
| `TOP_BACK_H` | 54 | 对家牌背高；宽 = 54×75/113 = 35.84 |
| `SIDE_BACK_H` | 45 | 左右家牌背高；宽 = 45×75/113 = 29.87 |
| `SIDE_PITCH` | 24 | 左右家牌背竖排间距（叠压） |
| `SIDE_RIVER_W/H` | 49×40 | 左右家牌河单张 |
| `SIDE_COLS/ROWS` | 3 / 8 | 左右家牌河 24 槽 |
| `MELD_SCALE` | 0.8 | 对家/自己副露 = 牌河 × 0.8 |
| `SIDE_MELD_SCALE` | 0.7 | 左右家副露 |
| `MELD_OVERLAP` | 8 | 副露组内叠压 |
| `CHIP` | 56 | 玩家卡头像 |
| `BAR_CHIP` | 40 | 顶栏对家卡头像 |

派生（s=1）：

```
handRowW = 14×71.68 + 13×2 + 12 = 1041.54
riverW   = 12×49.78 + 11×2 = 619.35
riverH   = 2×75 + 2 = 152
topBacksW= 13×35.84 + 12×2 = 489.93
sideHandH= 13×24 + 45 = 357
sideRiverW=3×49 + 2×2 = 151
sideRiverH=8×40 + 7×2 = 334
meldH    = 60；meldGroupW = 3×39.82 − 2×8 = 103.47
sideMeldH= 28；sideMeldGroupW = 3×34.3 − 2×8 = 86.9
sideZoneW= OUTER + max(104, 29.87+8+151) = 12+189 = 201
topZoneH(无副露)= 8+54+8+152 = 222
topZoneH(有副露)= 222+60+8 = 290
bottomZoneH(无副露)= 152+8+108+12 = 280
bottomZoneH(有副露)= 280+60+8 = 348
sideZoneH(无副露)= 56+8+max(357,334) = 421
sideZoneH(有副露)= 56+8+max(357,334+8+4×28+3×4=482) = 546
s = min(H/750, 0.88W/1041.54)
```

### 4.2 分区（s=1 的 1334×750 示意）

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏 64：返回 / 场次·底分 / [对家卡 40] / 托管·更多        │
│              [对家牌背 13 张 36×54]  490 宽               │
│              [对家牌河 12×2 50×75]  619 宽                │
│                                                          │
│ [左家卡]                                     [右家卡]     │
│ [左背列] [左河 3×8]                 [右河 3×8] [右背列]   │
│             [中央井 220×160：牌墙/阶段/待响应/听/倒计时]   │
│                                                          │
│           [我的副露条 0.8×]（若有）                        │
│           [我的牌河 12×2 50×75]                            │
│ [自己卡]  [我的手牌 13+摸牌 72×108，摸牌隔 12]             │
│                                        [动作浮层 右下]     │
└──────────────────────────────────────────────────────────┘
```

坐标规则（全部由纯函数给出 px 矩形，不用 vw/vh）：

- `bar`：`(0,0,W,64s)`。
- `topZone`：宽 `619.35s`，水平居中，`top=64s`，高 = `topZoneH × s`。
- `leftZone/rightZone`：宽 `201s`，`top=64s+8s`，高 = `sideZoneH × s`；左右锚边。
- `centerZone`：`left = 201s + 8s`，`right = W − 201s − 8s`，
  `top = 64s + topZoneH×s`，`bottom = H − bottomZoneH×s`。
- `hand`：宽 `1041.54s`，水平居中；`top = H − (12+108)s`，高 `108s`。
- `ownRiver`：宽 `619.35s`，水平居中；`top = hand.top − 8s − (有副露?68s:0) − 152s`。
- `selfChip`：`left = max(12s, hand.left − (56+8)s)`，`top = hand.top − (8+56)s`。
- `leftChip/rightChip`：本侧区顶部，宽 104s、高 56s。
- `centerCard`：中央井内居中，最大 `220s × 160s`；井高 <176s 时 `compact=true`。
- `actions`：`right=12s`，`bottom=H−hand.top+8s`，最大宽度 = 自己牌河右侧到桌边的空间；
  内容自适应换行。

### 4.3 跨设备推演

| 视口 | 画布 | s | 手牌 | 手牌占宽 | 中央井高（无/全副露） |
|---|---|---|---|---|---|
| 16:9 1280×720 | 1334×750 | 1.000 | 72×108 | 78% | 184 / 48 |
| 19.5:9 844×390 | 1623×750 | 1.000 | 72×108 | 64% | 184 / 48 |
| 21:9 2560×1080 | 1778×750 | 1.000 | 72×108 | 59% | 184 / 48 |
| 16:10 1280×800 | 1334×833 | 1.111 | 80×120 | 87% | 204 / 54 |
| 4:3 1024×768 | 1334×1000 | 1.127 | 81×122 | 88% | 363 / 209 |
| 正方形 1080×1080 | 1334×1334 | 1.127 | 81×122 | 88% | 697 / 543 |

- 带鱼屏多出的宽 → 中央井变宽、左右家与中央间距变大；牌不放大（否则竖向必溢出）。
- 平板多出的高 → 中央井变高；顶/底区贴边，构图不漂。
- 手牌永远 ≤88% 宽，左侧留出自家人像卡；4:3 时手牌左 80px，恰好放得下 56s 卡。
- 全副露最紧的 16:9：中央井 48px，中央卡切单行紧凑模式（28px 内容 + 8px 内边距）。

## 5. 实现设计

### 5.1 纯函数 `mahjongTableLayout`

文件：`apps/client/src/game/mahjong-layout.ts`。

```ts
export interface MahjongSeatLoad {
  discards: number;
  melds: number;
}

export interface MahjongTableInput {
  top: MahjongSeatLoad;
  left: MahjongSeatLoad;
  right: MahjongSeatLoad;
  self: MahjongSeatLoad;
}

export interface Rect { left: number; top: number; width: number; height: number }
export interface TileSize { w: number; h: number }

export interface RiverLayout {
  rect: Rect;
  tile: TileSize;
  cols: number;
  rows: number;
  gap: number;
  /** 1 = 原始尺寸；<1 = 超过 24 张后的压缩比。 */
  fit: number;
}

export interface MahjongTableLayout {
  s: number;
  bar: Rect;
  topZone: Rect;
  leftZone: Rect;
  rightZone: Rect;
  centerZone: Rect;
  centerCard: Rect;
  centerCompact: boolean;
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  ownRiver: RiverLayout;
  topRiver: RiverLayout;
  leftRiver: RiverLayout;
  rightRiver: RiverLayout;
  topBacks: { rect: Rect; tile: TileSize; gap: number };
  leftBacks: { rect: Rect; tile: TileSize; pitch: number };
  rightBacks: { rect: Rect; tile: TileSize; pitch: number };
  selfChip: Rect;
  leftChip: Rect;
  rightChip: Rect;
  barChip: TileSize;
  meld: { tile: TileSize; sideTile: TileSize; overlap: number; gap: number };
  actions: { right: number; bottom: number; maxWidth: number };
}

export function mahjongTableLayout(
  width: number,
  height: number,
  input?: Partial<MahjongTableInput>,
): MahjongTableLayout;
```

- 纯函数、零依赖、无副作用；输入输出都是数字/矩形。
- 缺省 input 视为全 0（无副露、无弃牌）。
- 弃牌数 >24 时：
  - 对家/自己：`rows=3`，`fit = min(1, 152/(3×75+2×2)) = 0.664`；
  - 左右家：`cols=4`，`fit = min(1, 151/(4×49+3×2)) = 0.747`；
  - `tile`、`gap` 同步乘 `fit`。
- 副露条：
  - 对家/自己：`melds>0` 时在牌河靠中央一侧加 `meldH+INNER` 高条带；
  - 左右家：`melds>0` 时在牌河下方加 `n×28+(n−1)×4` 高条带。
- `centerCompact = (centerZone.height < 176 × s)`。

### 5.2 画布尺寸注入

- `useLandscapeCanvas.ts` 新增：
  ```ts
  export const CANVAS_METRICS_KEY: InjectionKey<ComputedRef<LayoutMetrics>> =
    Symbol('ftl-canvas-metrics');
  ```
- `LandscapeStage.vue` `provide(CANVAS_METRICS_KEY, metrics)`。
- `MahjongBoard.vue`：
  ```ts
  const stageMetrics = inject(CANVAS_METRICS_KEY, null);
  const canvas = computed(() => stageMetrics?.value ?? { width: 1334, height: 750, scale: 1 });
  const layout = computed(() => mahjongTableLayout(canvas.value.width, canvas.value.height, loads.value));
  ```
- 独立挂载（测试/未来复用）走 1334×750 回退。

### 5.3 组件

| 组件 | 职责 | 关键 props | 事件 |
|---|---|---|---|
| `MahjongBoard.vue` | 分区、交互、现有全部逻辑 | 现有 props | 现有 emits |
| `MahjongSeatChip.vue` | 头像/名字/分/缺门/庄/胡/听/托管/出局/发光 | `name, seat, isMe, isDealer, cardCount, lackSuit, hu, isOut, trustee, ting, activeLevel, balance, pendingDelta, size, compact` | 无 |
| `MahjongHandBacks.vue` | 对手牌背横排/竖排；已胡者牌面替换 | `count, direction, tile, gap, pitch, revealed` | 无 |
| `MahjongRiver.vue` | 牌河网格 + 副露条带 + 最新牌高亮 + 弃牌点击 | `discards, melds, direction, tile, meldTile, meldOverlap, cols, rows, gap, filterTile` | `discard-click(tile)` |
| `MahjongCenter.vue` | 牌墙/阶段/待响应牌/听牌/倒计时；紧凑模式 | `wallCount, phaseText, claimTile, tingTiles, maxFan, seconds, active, compact, endedText` | 无 |
| `MahjongTile.vue` | 单张牌；新增 `w/h` 显式尺寸（优先于 size 档位） | 现有 + `w?, h?` | `click` |
| `MahjongMeld.vue` | 副露组；新增 `tileW/tileH/overlap` 透传 | 现有 + `tileW?, tileH?, overlap?` | `pop-done` |

`MahjongSeatPanel.vue` 删除；其徽标/番型 emoji 逻辑迁入 `MahjongSeatChip`。

### 5.4 手牌：摸牌分离与选择映射

- `sortedHand = sortTiles(view.hand)`（现有）。
- `drawnType`：watch 手牌 multiset；`next.length === prev.length + 1` 时找出新增牌型，
  否则清空。
- `displayTiles`：从 `sortedHand` 中移除一张 `drawnType`，追加到末尾并标 `drawn`。
- `selected` / `lastClickIndex` / `flyingOutIndex` / `handHintIndex` 一律改为 **display 下标**；
  动作里用 `displayTiles[i].tile`，不再用 `hand[i]`。
- 摸牌额外 `margin-left: drawnGap − gap = 10s`，总间隔 12s。
- 重连/中途进入：没有 diff，不显示摸牌间隔（登记边界）。

### 5.5 已胡者亮牌

- `revealedHands` 含某座时：
  - 该座是对家/左右家 → `MahjongHandBacks` 渲染 `revealed.tiles` 牌面（dim），不渲染牌背；
  - 该座是自己 → 手牌行渲染 `revealed.tiles`（dim），不可选，摸牌标记清空。
- 亮牌牌面尺寸沿用该座手牌位尺寸（对家 36×54s，左右 30×45s，自己 72×108s）。
- 不额外占分区，不挤压中央井。

### 5.6 牌河与副露

- 网格：`display:grid; grid-template-columns: repeat(cols, tile.w); grid-auto-rows: tile.h; gap`。
- 弃牌按服务端顺序渲染；最后一张加金边高亮。
- 副露条带：
  - 对家/自己：牌河靠近中央的一侧，单行；每组 `MahjongMeld`，组间 gap；
  - 左右家：牌河下方，竖排；
  - 每组前保留「碰/杠/暗杠」小标签。
- 弃牌点击：只在 `claim` 窗口 + 我 active 时 emit；`filterTile` 命中时给该牌加 outline。
- 副露不参与点击/过滤。

### 5.7 中央井与动作浮层

- 中央卡内容（从上到下）：
  1. `牌墙 N`；
  2. 阶段文案（现有 `phaseText`）；
  3. 待响应牌（`claimTile`）+「可响应」；
  4. 听牌列表（`tingTiles` + 最大番）；
  5. 行动者倒计时文本（`seconds`，≤5 秒红色）。
- 紧凑模式（井高 <176s）：单行 `牌墙 N · 阶段 · 12s`；有待响应牌时用小号 `sm` 牌。
- 动作浮层：
  - `play` + 我 active：现有 claims（胡/杠）+「出牌」；
  - `claim` + 我 active：现有 `ClaimTile`；
  - `exchange` / `lack` + 我 active：现有「换三张」/「缺万/缺筒/缺条」按钮；
  - 其他：不渲染。
- 浮层右对齐、`flex-wrap`；最大宽度 = 自己牌河右缘到桌边；超出向上换行。
- 不再使用 `TurnTimer` 组件（麻将牌桌改文本倒计时）；DDZ/PDK 不动。

### 5.8 交互保持不变

- 双击手牌出牌、单击选中、换三张多选 3 张同花色、定缺、碰/杠/胡/过、
  自摸胡/暗杠/补杠映射、弃牌点击过滤、长按手牌提示、胡牌 banner FIFO、
  副露 pop、托管/取消托管、更多菜单、结算/连接遮罩浮层。
- `table.vue` 的 props/emit 接线不改。

## 6. 边界与错误处理

| 场景 | 行为 |
|---|---|
| `view === null` / 等待发牌 | 顶栏 + 中央「等待发牌…」；分区空；不渲染牌 |
| `mySeat === null` | 沿用现有 `me = 0` 兜底 |
| `hand` 13/14 张 | 13 张正常；14 张按摸牌标记；其他张数原样渲染 |
| 对手 `cardCounts` 为 0 | 不渲染牌背；已胡者用亮牌替换 |
| 弃牌 >24 | 对家/自己 12×3 压缩到 0.664×；左右 4×8 压缩到 0.747×；不增高分区 |
| 副露 4 组 | 对家/自己单行放得下（4×103.47+3×8=437.9 < 619）；左右竖排 4×28+3×4=124 < 侧区余量 |
| 长名字 | 单行省略；徽标换行；金币在空间不足时隐藏 |
| `isOut` / `hu` | 小卡变暗/胡徽标；手牌区显示亮牌 |
| `trustees` | 小卡「托管」徽标；托管遮罩仍在手牌上方（不遮手牌） |
| 结算已到达/已展示 | 现有遮罩/弹窗逻辑不变；牌桌保持可读 |
| 画布尺寸异常 | `inject` 缺省 1334×750；`layout` 保证 s≥1、矩形非负 |
| 触摸目标 | 手牌 72×108s（844×390 下约 37×56 物理 px）；动作按钮 96×80s（约 50×42） |

## 7. 测试判据

### 7.1 纯函数矩阵

文件：`apps/client/test/mahjong-layout.test.ts`。视口矩阵：
`1334×750`、`1623×750`、`1778×750`、`1334×833`、`1334×1000`、`1334×1334`、`1500×750`。

每个视口断言：

1. `s ≥ 1`，所有矩形有限且 `width/height ≥ 0`；
2. 所有矩形在 `[0,W]×[0,H]` 内（允许 0.01 容差）；
3. `hand.width ≤ 0.88W + 0.01`；`hand.left ≥ 0`；`hand.bottom ≤ H`；
4. `centerZone.height > 0`；`centerCard` 在 `centerZone` 内；
5. `leftZone.right < ownRiver.left`，`rightZone.left > ownRiver.right`（左右家与自家牌河不重叠）；
6. `leftZone.bottom ≤ hand.top`，`rightZone.bottom ≤ hand.top`；
7. 牌张比例：手牌 `w/h = 75/113`，牌河 `w/h = 75/113`，左右牌河 `w/h = 49/40`；
8. 全副露输入下 `centerZone.height ≥ 40`；
9. 弃牌 30 张时 `fit < 1` 且压缩后网格尺寸 ≤ 原分区；
10. 相同输入两次结果逐值相等（纯函数）。

### 7.2 组件测试

- `MahjongSeatChip`：四个徽标（庄/缺/胡/听/托管/出局）按 prop 渲染；active 发光类。
- `MahjongHandBacks`：`count` 张牌背；`direction=left/right` 竖排类；`revealed` 时渲染牌面而非牌背。
- `MahjongRiver`：弃牌数量/顺序；最新牌高亮；点击 emit；副露条带；`filterTile` outline。
- `MahjongCenter`：牌墙/阶段/待响应/听牌/倒计时；紧凑模式类。
- `MahjongTile`：传 `w/h` 时 style 覆盖 size 档位。
- `MahjongBoard`：
  - 现有 6 条 T11 用例全部不改选择器/断言并通过；
  - 新增：四个座位小卡；三个对手牌背总数 = `cardCounts`；
  - 新增：牌河四个；左右家牌河 direction 正确；
  - 新增：牌墙文案在中央井；
  - 新增：摸牌（13→14）最后一张带 `drawn` 类且间隔；
  - 新增：claim 窗口点击弃牌过滤后只剩匹配按钮；
  - 新增：提供 `CANVAS_METRICS_KEY` 时手牌 style 随画布宽高变化。

### 7.3 闸

- `apps/client` 全量 `vitest run`；
- `vue-tsc --noEmit`；
- `ui-tokens`（无 rpx/em/rem/vw/vh/pt、无手写 1px、line-height 无单位）；
- `animations`（组件无 setTimeout/setInterval）；
- `source-boundary`（前端只依赖 protocol）。

### 7.4 真视觉

- 用 `.superpowers/mahjong-layout-research/` 的本地夹具（gitignored）在
  1334×750 / 1623×750 / 1334×1000 三档渲染截图，确认四家分区、牌背、牌河、中央井、
  手牌无裁切。截图作为交付证据，不入库。

## 8. 风险与已知边界

| 风险 | 处置 |
|---|---|
| 21:9 手牌只占 59% 宽 | 已由用户裁决的高度基准策略接受；多出的宽给中央井/间距 |
| 全副露局中央井只剩 48px | 中央卡切单行紧凑模式；牌墙/阶段/倒计时仍可读 |
| 对家卡放顶栏，不是四角 | 避免顶区再长 56px；对家信息仍在其手牌正上方 |
| 重连不显示摸牌标记 | 已登记；不影响出牌/规则 |
| 已胡者亮牌替换手牌区 | 与真实牌桌一致；不再额外占分区 |
| 牌河超过 24 张后压缩 | 32-36 张仍可读；当前玩法到不了 |
| 左右家副露 4 组可能贴手牌 | 侧区底部与手牌保留 ≥12px；极端高 s 下由 `fit` 收口 |
| 顶栏 64px 在小屏占高 | 画布最小 750 高，中央井无副露仍有 184px |

## 9. 涉及文件

新增：
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`
- `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`
- `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `apps/client/test/mahjong-layout.test.ts`
- `apps/client/test/mahjong-table-components.test.ts`

修改：
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/src/components/table/mahjong/MahjongTile.vue`
- `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- `apps/client/src/components/LandscapeStage.vue`
- `apps/client/src/composables/useLandscapeCanvas.ts`
- `apps/client/test/mahjong-board.test.ts`（仅新增用例）

删除：
- `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`

## 10. 审查记录

（待独立 reviewer 审查后填写）
