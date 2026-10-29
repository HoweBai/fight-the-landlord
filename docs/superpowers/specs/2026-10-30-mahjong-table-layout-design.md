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
| D4 | 对手牌背数量 = `cardCounts[seat]`（**只含暗手、不含副露**）；已胡者：对家/自己用 `revealedHands` 换掉牌背/手牌行；左右家改用**牌河区**的 3 列亮牌网格（49×40 牌面） | 牌背数量就是服务端公开张数；左右家 30×45 竖槽放 49×40 横牌面实际只剩 30×24.5，不可读；牌河区 3 列 49×40 可读且不额外占高 |
| D5 | 牌河在各自「手牌与中心之间」：对家/自己 12 列 × 2 行；左右家 3 列 × 8 行（竖排）；填充顺序统一**行优先**（左→右、上→下） | 四块围出中央方井；左右家网格在横屏下比 2×12 更矮、更适合侧区 |
| D6 | 副露放在各自牌河**靠自己手牌的一侧**（**屏幕坐标写死**：对家=牌河上方、自己/左右家=牌河下方）；0.8× 牌河尺寸（左右 0.65×）；**杠的第 4 张与其余 3 张同行并排，不叠高**；暗杠 4 张全部按牌背渲染 | 不占手牌行；4 组在 12 列宽度内放得下（4 个杠 4×135.3+3×8=565 < 619）；条带高度对家/自己 60s、左右按组合计；`meld.rect` 明确可测；暗杠牌面不下发是既有协议问题，见 §8 |
| D7 | 玩家卡：对家在顶栏右侧（40 头像 / 56 高，显示名字+分+缺/庄/胡/听/托管徽标，不显示张数）；左右家在本侧区顶部（140×56s）；自己在**左下角、手牌左侧**（56×76s，只显示头像+分/徽标，不显示名字） | 四角就近、互不碰撞；自己卡放左下可避开左右家区；左右卡 140 宽够放 4 字名字；对家张数由牌背数量自证 |
| D8 | 中央井：牌墙余量 + 阶段文案 + 待响应牌 + 听牌 + 倒计时文本；高度 <176s 时切单行紧凑模式 | 共享信息集中在井里；重副露局中央只剩 48s 时仍可读 |
| D9 | 动作按钮是浮层：**右缘 x = W − (侧区宽+INNER)s（`rightX`）**、**底缘 y = 手牌顶 − INNER*s（`bottomY`）**，同时输出 `rightOffset=W−rightX` / `bottomOffset=H−bottomY` 供 CSS 直接用；只在需要时出现；z-index=3（结算/提示/连接层之下）；可能盖住**自己的**牌河/副露右半，不盖左右家区 | 响应过滤要点的是**别人**的弃牌；自己的牌河被盖不影响响应；字段名区分屏幕坐标与 CSS 偏移，测试可断言 `rightX ≤ 右家区.left`；不再有永久动作行、不挤压中央井 |
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
| `BACK_BUDGET` | 14 | 牌背容器按 14 张留位（`cardCounts` 轮到谁谁 14；13 张只是常见值） |
| `SIDE_RIVER_W/H` | 49×40 | 左右家牌河单张 |
| `SIDE_COLS/ROWS` | 3 / 8 | 左右家牌河 24 槽 |
| `MELD_SCALE` | 0.8 | 对家/自己副露 = 牌河 × 0.8 |
| `SIDE_MELD_SCALE` | 0.65 | 左右家副露 |
| `MELD_OVERLAP` | 8 | 副露组内叠压 |
| `CHIP` | 56 | 玩家卡头像 |
| `BAR_CHIP` | 40 | 顶栏对家卡头像（卡高 56） |
| `SELF_CHIP_W/H` | 56×76 | 自己卡：头像 56 + 下方分数/徽标 |
| `SIDE_CHIP_W` | 140 | 左右家卡宽（头像 56 + 名字/分/徽标列） |

派生（s=1）：

```
handRowW = 14×71.6814 + 13×2 + 12 = 1041.5398
riverW   = 12×49.78 + 11×2 = 619.35
riverH   = 2×75 + 2 = 152
topBacksW= 14×35.84 + 13×2 = 527.8（容器宽 = 牌河宽 619.35，14 张放得下）
sideHandH= 14×24 + 45 = 381
sideRiverW=3×49 + 2×2 = 151
sideRiverH=8×40 + 7×2 = 334
meldH    = 60；meldGroupW = 4×39.82 − 3×8 = 135.3（杠；碰为 103.5）
sideMeldH= 26；sideMeldGroupW = 4×31.85 − 3×8 = 103.4
sideZoneW= OUTER + max(140, 29.87+8+151) = 12+188.87 = 200.87
topZoneH(无副露)= 8+54+8+152 = 222
topZoneH(有副露)= 222+60+8 = 290
bottomZoneH(无副露)= 152+8+108+12 = 280
bottomZoneH(有副露)= 280+60+8 = 348
sideZoneH(无副露)= 56+8+max(381,334) = 445
sideZoneH(有副露)= 56+8+max(381,334+8+(4×26+3×4=116)=458) = 522
s = min(H/750, 0.88W/1041.5398)，且 s ≥ 1
```

### 4.2 分区（s=1 的 1334×750 示意）

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏 64：返回 / 场次·底分 / [对家卡 40] / 托管·更多        │
│              [对家牌背 14 张 36×54]  528 宽               │
│              [对家副露条 0.8×]（若有，在牌河上方）          │
│              [对家牌河 12×2 50×75]  619 宽                │
│                                                          │
│ [左家卡]                                     [右家卡]     │
│ [左背列] [左河 3×8]                 [右河 3×8] [右背列]   │
│             [中央井 220×160：牌墙/阶段/待响应/听/倒计时]   │
│                                                          │
│           [我的牌河 12×2 50×75]                            │
│           [我的副露条 0.8×]（若有，在牌河下方）             │
│ [自己卡]  [我的手牌 13+摸牌 72×108，摸牌隔 12]             │
│                                        [动作浮层 右下]     │
└──────────────────────────────────────────────────────────┘
```

坐标规则（全部由纯函数给出 px 矩形，不用 vw/vh）：

- `bar`：`(0,0,W,64s)`。
- `topZone`：宽 `619.35s`，水平居中，`top=64s`，高 = `topZoneH × s`。
- `leftZone/rightZone`：宽 `200.87s`，`top = 64s + 8s + max(0, (hand.top − 64s − 8s − sideZoneH×s)/2)`，
  高 = `sideZoneH × s`；左右锚边。侧区在可用竖向带里**居中**（16:9 无副露 top≈128.5s，
  4:3 无副露≈222s，正方形≈389s），避免平板上侧区只挤在上半段。
- `centerZone`：`left = 200.87s + 8s`，`right = W − 200.87s − 8s`，
  `top = 64s + topZoneH×s`，`bottom = H − bottomZoneH×s`。
- `hand`：宽 `1041.54s`，水平居中；`top = H − (12+108)s`，高 `108s`。
- `ownRiver`：宽 `619.35s`，水平居中；`top = hand.top − 8s − (有副露?68s:0) − 152s`。
- `selfChip`：`left = OUTER`，`top = hand.top + (108−76)/2 × s`，`56s × 76s`；在手牌左侧，
  不压手牌（4:3 手牌左 80s，卡右 76.6s）。
- `leftChip/rightChip`：本侧区顶部，`140s × 56s`；左侧 `left=OUTER`，右侧 `left=W−OUTER−140s`。
- `centerCard`：中央井内居中，最大 `220s × 160s`；井高 <176s 时 `compact=true`，
  紧凑卡宽可用满 `centerZone.width − 8s`、高 `min(160s, 井高−8s)`（16:9 全副露井 48s
  ⇒ 卡高 40s）、单行 11px 字号 + 省略号。
- `actions`：`rightX = W − (sideZoneW + INNER)s`（右缘 x 坐标），
  `bottomY = hand.top − INNER*s`（底缘 y 坐标）；
  同时给 CSS 用的 `rightOffset = W − rightX`、`bottomOffset = H − bottomY`，
  `maxWidth = min(400s, W−2×OUTER×s)`，`minHeight = 80s`。
  内容右对齐，允许盖住自己的牌河/副露右半，不盖左右家区。

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
- 全副露最紧的 16:9：中央井 48px，中央卡切单行紧凑模式（卡高 40s、11px、省略号）。
- 4:3 / 正方形全副露时中央井 209 / 543，**不切紧凑**（阈值 176s = 198.4 / 198.4）。

## 5. 实现设计

### 5.1 纯函数 `mahjongTableLayout`

文件：`apps/client/src/game/mahjong-layout.ts`。

```ts
export interface MahjongSeatLoad {
  discards: number;
  melds: number;
}

export interface MahjongTableInput {
  top?: Partial<MahjongSeatLoad>;
  left?: Partial<MahjongSeatLoad>;
  right?: Partial<MahjongSeatLoad>;
  self?: Partial<MahjongSeatLoad>;
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
  /** 副露条带：高度 0 = 无副露；placement=above 用于对家，below 用于自己/左右家。 */
  meld: {
    height: number;
    rect: Rect;
    placement: 'above' | 'below';
    tile: TileSize;
    overlap: number;
    gap: number;
  };
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
  centerTiles: { claim: TileSize; ting: TileSize };
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
  actions: {
    /** 浮层右缘 x 坐标（屏幕/画布坐标）。 */
    rightX: number;
    /** 浮层底缘 y 坐标（屏幕/画布坐标）。 */
    bottomY: number;
    /** CSS `right` 偏移 = W − rightX。 */
    rightOffset: number;
    /** CSS `bottom` 偏移 = H − bottomY。 */
    bottomOffset: number;
    maxWidth: number;
    /** 按钮区最小高度（px）；内容可向上长。 */
    minHeight: number;
  };
}

export function mahjongTableLayout(
  width: number,
  height: number,
  input?: Partial<MahjongTableInput>,
): MahjongTableLayout;
```

- 纯函数、零依赖、无副作用；输入输出都是数字/矩形。
- **逐座缺省**：`input` 是浅 Partial，每座单独 `normalizeLoad`；
  `mahjongTableLayout(W,H)` 不传 input 也必须不抛错（全 0）。
- 弃牌数 >24 时：
  - 对家/自己：`rows=3`，`fit = min(1, 152/(3×75+2×2)) = 0.664`；
  - 左右家：`cols=4`，`fit = min(1, 151/(4×49+3×2)) = 0.747`；
  - `tile`、`gap` 同步乘 `fit`。
- 副露条：
  - **屏幕坐标写死**：对家=牌河上方（`placement:'above'`）、自己/左右家=牌河下方（`'below'`）；
  - 对家/自己：`melds>0` 时高度 60s，条带与牌河/手牌之间 INNER；
  - 左右家：`melds>0` 时高度 `n×26+(n−1)×4`，同样 INNER；
  - 杠的第 4 张与其余 3 张**同行并排**（不叠高），组宽按 4 张算；暗杠 4 张全部牌背；
  - 输出 `meld.rect`（屏幕矩形），测试可断言「上/下」关系。
- `centerCompact = (centerZone.height < 176 × s)`；紧凑卡宽 `centerZone.width − 8s`、高 40s。

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
| `MahjongSeatChip.vue` | 头像/名字/分/缺门/庄/胡/听/托管/出局/发光 | `name, isMe, isDealer, cardCount, lackSuit, hu, isOut, trustee, ting, activeLevel, balance, pendingDelta, avatar, variant('self'|'side'|'bar')` | 无 |
| `MahjongHandBacks.vue` | 对手牌背横排/竖排；已胡者牌面替换 | `count, direction, tileW, tileH, gap, pitch, revealed` | 无 |
| `MahjongRiver.vue` | 牌河网格 + 副露条带 + 最新牌高亮 + 弃牌点击；左右家已胡时亮牌网格替换 discards | `discards, melds({key,meld,pop}), direction, tileW/H, gap, cols, rows, meldTileW/H, meldOverlap, meldPlacement, meldGap, meldHeight, filterTileType, interactive, revealed` | `discard-click(tile)`、`meld-pop-done(key)` |
| `MahjongCenter.vue` | 牌墙/阶段/待响应牌/听牌/倒计时；紧凑模式 | `wallCount, phaseText, claimTile, claimW/H, tingTiles, tingW/H, maxFan, seconds, active, compact, endedText` | 无 |
| `MahjongTile.vue` | 单张牌；新增 `w/h` 显式尺寸（优先于 size 档位） | 现有 + `w?, h?` | `click` |
| `MahjongMeld.vue` | 副露组；新增 `tileW/tileH/overlap` 透传 | 现有 + `tileW?, tileH?, overlap?` | `pop-done` |

`MahjongSeatPanel.vue` 删除；其徽标/番型 emoji 逻辑迁入 `MahjongSeatChip`。

### 5.4 手牌：摸牌分离与选择映射

- `sortedHand = sortTiles(view.hand)`（现有）。
- `drawnType`：watch 手牌 multiset，**必须 `immediate: true` 先记录初始手牌**；
  仅当 `next.length === prev.length + 1` 且确实找到新增牌型时赋值，否则一律清空
  （长度不变、-1、-2、-4、换局、换阶段都清）。
- `displayTiles`：
  - `drawnType === null` → 直接用 `sortedHand`（不重排）；
  - `drawnType !== null` **且** `sortedHand` 里确实存在该牌型 → 移除**一张**并追加到末尾标 `drawn`；
  - 找不到（幽灵残留）→ 当 null 处理，绝不渲染手牌里没有的牌。
- 所有下标消费者统一改为 **display 下标**：`selected`、`selectedTiles`、`onTileClick`
  （含双击分支里的取牌）、`lastClickIndex`、`flyingOutIndex`、`handHintIndex`、
  `handHintAffected`、`onDiscard`、`onExchange`、`exchangeReady`。
  动作里用 `displayTiles[i].tile`，不再用 `hand[i]`；漏一处就是「出牌出成另一张」。
- 摸牌额外 `margin-left: drawnGap − gap = 10s`，总间隔 12s。
- 边界（登记）：
  - 重连/中途进入：初始 watch 无 prev，不标；
  - 断网前 13 张、resync 后 14 张：可能误标一次（下一次手牌变化即清），登记；
  - 补杠/暗杠若同版本内长度变化不是 +1（-1/-4/+1），不标摸牌（假阴性），登记；
  - 血流成河多次摸打仍按 +1 规则工作。

### 5.5 已胡者亮牌

- `revealedHands` 含某座时：
  - **对家**：`MahjongHandBacks` 的 `revealed` 渲染 `revealed.tiles` 牌面（dim），牌背位替换；
  - **自己**：手牌行渲染 `revealed.tiles`（dim），不可选，摸牌标记清空；
  - **左右家**：不用 30×45 竖槽（横牌面会缩成 30×24.5，不可读）；改为在**牌河区**用
    3 列 × 49×40 牌面网格渲染亮牌，牌背列清空；该座 discards 不再显示（已胡者弃牌不可响应）。
- 亮牌牌面尺寸：对家 35.84×54s、自己 71.68×108s、左右家 49×40s（即牌河尺寸）。
- 不额外占分区，不挤压中央井；左右家的亮牌占用原牌河 rect。

### 5.6 牌河与副露

- 网格：`display:grid; grid-template-columns: repeat(cols, tile.w); grid-auto-rows: tile.h; gap`；
  填充顺序统一**行优先**（左→右、上→下）。
- 弃牌按服务端顺序渲染；最后一张加金边高亮。
- 副露条带（**屏幕坐标**）：
  - 对家：牌河**上方**（手牌背与牌河之间），单行；每组 `MahjongMeld`，组间 gap；
  - 自己：牌河**下方**（牌河与手牌之间），单行；
  - 左右家：牌河**下方**，竖排；
  - 每组保留「碰/杠/暗杠」小标签（绝对定位，不占宽度）；
  - 杠 4 张同行；暗杠 4 张全部牌背（不依赖服务端遮罩，见 §8）。
- 弃牌点击：只在 `claim` 窗口 + 我 active 时 emit；`filterTile` 命中时给该牌加 outline。
- 副露不参与点击/过滤。
- 已胡左右家：亮牌网格替换 discards（3 列 49×40），副露条仍可显示。

### 5.7 中央井与动作浮层

- 中央卡内容（从上到下）：
  1. `牌墙 N` + 阶段文案 + 行动者倒计时文本（`seconds`，≤5 秒红色）；
  2. 待响应牌（`claimTile`，34×51s）+「可响应」；
  3. 听牌列表（`tingTiles`，20×30s，可换行）+ 最大番；
  4. 已胡家数（`endedText`）。
- 紧凑模式（井高 <176s）：**单行** `牌墙 N · 阶段 · 12s`（11px、省略号；
  卡宽用满 `centerZone.width − 8s`、高 `min(160s, 井高−8s)`，16:9 全副露为 40s）；
  待响应牌只出文字（不出牌面）。
- 动作浮层：
  - `play` + 我 active：现有 claims（胡/杠）+「出牌」；
  - `claim` + 我 active：现有 `ClaimTile`（其按钮沿用自身 `ftl-btn` 尺寸，不套 96×80）；
  - `exchange` / `lack` + 我 active：现有「换三张」/「缺万/缺筒/缺条」按钮；
  - 其他：不渲染；`settlementArrived` / `settlementRevealed` / `ended` 一律不渲染。
- 定位：`rightX`/`bottomY` 见 §5.1；CSS 用 `rightOffset`/`bottomOffset`；
  `maxWidth = min(400s, W−2×OUTER×s)`；内容右对齐、可向上换行。
  允许盖住自己的牌河/副露右半（响应时点的是别人的弃牌），不盖左右家区。
- **层叠表**（在 `.mj` 内）：
  - 牌桌分区/手牌：0–1；
  - 动作浮层 `.mj__actions`：**3**；
  - 托管遮罩：4（动作浮层之上）；
  - 结算 scrim / 结算面板：1 / 2（结算到达时动作浮层 v-if 已卸载）；
  - MoreMenu / 胡牌 banner / 长按弹层：10；
  - `stage__overlay`（NoticeStack）：15；ConnectionOverlay：20。
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
| `hand` 13/14 张 | 13/14 张正常；14 张按摸牌标记；其他张数原样渲染；牌背容器按 14 张预算 |
| 对手 `cardCounts` 为 0 | 不渲染牌背；已胡者用亮牌替换（左右家在牌河区） |
| 弃牌 >24 | 对家/自己 12×3 压缩到 0.664×；左右 4×8 压缩到 0.747×；不增高分区 |
| 副露 4 组 | 对家/自己单行放得下（4×103.5+3×8=438 < 619）；左右竖排 4×26+3×4=116 < 侧区余量 |
| 长名字 | 单行省略；徽标换行；金币在空间不足时隐藏 |
| `isOut` / `hu` | 小卡变暗/胡徽标；对家/自己手牌位亮牌，左右家牌河区 3 列亮牌 |
| `trustees` | 小卡「托管」徽标；托管遮罩底缘 = 手牌顶 − 8s（不遮手牌） |
| 结算已到达/已展示 | 现有遮罩/弹窗逻辑不变；动作浮层不渲染；牌桌保持可读 |
| 动作浮层 | z-index 3；右缘 `rightX ≤ 右家区.left`；可盖自己的牌河/副露右半；ClaimTile 换行可向上长 |
| 画布尺寸异常 | `inject` 缺省 1334×750；`layout` 保证 s≥1、矩形非负 |
| 触摸目标 | 手牌 72×108s（844×390 下约 37×56 物理 px）；动作按钮 96×80s（约 50×42） |

## 7. 测试判据

### 7.1 纯函数矩阵

文件：`apps/client/test/mahjong-layout.test.ts`。视口矩阵：
`1334×750`、`1623×750`、`1778×750`、`1334×833`、`1334×1000`、`1334×1334`、`1500×750`。

每个视口断言：

1. **`s` 公式钉死**：`s` 与 `min(H/750, 0.88W/1041.5398)` 的差 ≤ `1e-6`，且 `s ≥ 1`；
2. **手牌比例/贴底钉死**：`hand.width / W` 等于预期值（H=750 视口 78.08% / 64.17% /
   58.58% / 69.44%；16:10 86.72%；4:3 与正方形 88%），`hand.bottom = H − 12s`；
3. **中央井高钉死**：`centerZone.height = H − (64 + topZoneH + bottomZoneH)s`
   （副露有无分别取 222/290、280/348）；
4. 所有矩形有限、`width/height ≥ 0`、在 `[0,W]×[0,H]` 内（0.01 容差）；
5. `leftZone.right < ownRiver.left`，`rightZone.left > ownRiver.right`；
6. `leftZone.bottom ≤ hand.top`，`rightZone.bottom ≤ hand.top`（含 4 副露 + 30 弃牌）；
7. `selfChip.right ≤ hand.left`；
8. `actions.rightX ≤ rightZone.left`，`actions.rightOffset = W − rightX`；
   `actions.bottomY ≤ hand.top`，`actions.bottomOffset = H − bottomY`；
9. 牌张比例：手牌/牌河/对家背 `w/h = 75/113`，左右牌河 `49/40`；
10. **紧凑条件化**：`centerCompact === (centerZone.height < 176s)`；全副露时
    750 高视口为 `true`（井 48），16:10 为 `true`（井 53.3），
    4:3 / 正方形为 `false`（井 209 / 543）；全副露井高 ≥40；
11. 副露位置：对家 `meld.rect.bottom + meld.gap ≤ river.rect.top`；
    自己/左右家 `meld.rect.top ≥ river.rect.bottom + meld.gap`；
12. 弃牌 30 张时 `fit < 1` 且压缩后网格尺寸 ≤ 原分区；杠组宽（4 张）4 组 ≤ 牌河宽；
13. 侧区居中：`|(leftZone.top + leftZone.height/2) − (centerZone.top + centerZone.height/2)| < 100s`；
14. `mahjongTableLayout(W,H)`（不传 input）不抛错，结果与全 0 相同；
15. 输入对象被 `Object.freeze` 后仍可计算（不 mutate）；
16. 相同输入两次结果逐值相等（纯函数）。

### 7.2 组件测试

- `MahjongSeatChip`：四个徽标（庄/缺/胡/听/托管/出局）按 prop 渲染；active 发光类。
- `MahjongHandBacks`：`count` 张牌背；`direction=left/right` 竖排类；`revealed` 时渲染牌面而非牌背。
- `MahjongRiver`：弃牌数量/顺序；最新牌高亮；点击 emit；副露条带（碰 3 张、杠 4 张
  同行、暗杠 4 张全牌背）；`filterTile` outline。
- `MahjongMeld`：杠 4 张同行（无绝对定位 cap）；暗杠 4 张 `back`；`tileW/H/overlap`
  透传到 4 张牌。
- `MahjongCenter`：牌墙/阶段/待响应/听牌/倒计时；紧凑模式类。
- `MahjongTile`：传 `w/h` 时 style 覆盖 size 档位。
- `MahjongBoard`：
  - 现有 6 条 T11 用例全部不改选择器/断言并通过；
  - 新增：四个座位小卡；牌背用 `cardCounts=[14,10,7,0]` 这类**不同值**，
    逐座断言数量与 `src` 以 `back.png` 结尾（防「只数个数」假绿）；
  - 新增：牌河四个；左右家牌河 direction 正确；
  - 新增：牌墙文案在中央井；
  - 新增：摸牌（13→14）最后一张带 `drawn` 类且间隔；13→13 / 14→13 不标；
  - 新增：claim 窗口点击弃牌过滤后只剩匹配按钮；
  - 新增：提供 `CANVAS_METRICS_KEY` 时手牌首张 `style` 与
    `mahjongTableLayout(1334,1000).hand.tile` 逐值一致（**不要用 1623×750**：
    它与兜底 1334×750 的 s 都是 1，验不出注入）。
  - 新增：已胡左右家的牌河区渲染亮牌网格（不是牌背）。

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
| 重连/断网 resync 可能误标一次摸牌 | 已登记；下一次手牌变化即清；不影响出牌/规则 |
| 已胡者亮牌替换手牌区 | 对家/自己与真实牌桌一致；**左右家改用牌河区 3 列亮牌，该座 discards 不显示**（已胡者弃牌不可响应），已登记 |
| **暗杠牌面仍随 `melds` 下发**（`buildMahjongView` 直接拷贝 `m.tiles`） | **既有协议泄漏，非本片引入**；本片客户端对 `angang` 的 4 张全部按牌背渲染，不扩大可见面；协议侧遮罩另立片登记 |
| 牌河超过 24 张后压缩 | 对家/自己最多 36 槽、左右最多 32 槽；超过则登记截断/压缩；当前玩法到不了 |
| 左右家副露 4 组可能贴手牌 | 16:9 全副露侧区底 612s，手牌顶 630s，保留 18s；高 s 时由侧区居中和 `fit` 收口 |
| 动作浮层盖住自己的牌河/副露右半 | 已登记；响应过滤点的是别人的弃牌；右缘 `rightX ≤ 右家区.left`，不盖左右家 |
| 自己卡与左下角装饰图重叠 | 装饰在 z0、pointer-events none；自己卡在上层；纯装饰，接受 |
| `revealedHands.huTile` 不做特殊标记 | 协议字段保留；本片只按 `tiles` 渲染；另立片 |
| `hasActions` 增加 `interactive` 门槛 | 与 `settlementArrived` 在 `table.vue` 当前取值下等价（`interactive = store.settlement === null`）；行为不变 |
| 顶栏 64px 在小屏占高 | 画布最小 750 高，中央井无副露仍有 184px |

## 9. 涉及文件

新增：
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`
- `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`
- `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `apps/client/test/mahjong-layout.test.ts`
- `apps/client/test/mahjong-tile-meld.test.ts`
- `apps/client/test/mahjong-seat-chip.test.ts`
- `apps/client/test/mahjong-hand-backs.test.ts`
- `apps/client/test/mahjong-river.test.ts`
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/test/landscape-metrics-provide.test.ts`

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

### 2026-10-30 第一轮（独立 reviewer，sonnet，对抗审查）

**结论：需修订后复审。**

审查期间 spec 已并行修订（杠 4 张同行、自己卡左下、动作浮层钉右家区左侧、侧区居中、
紧凑卡条件化）。reviewer 的 4 个阻断项与 18 个高项处置如下：

| 编号 | 发现 | 处置 |
|---|---|---|
| B1 | 副露条带在牌河哪一侧四处矛盾（§1.2/D6/§5.6 说「中央侧」，接口注释与两个 zone 公式相反） | **已修**：屏幕坐标写死「对家=牌河上方、自己/左右家=牌河下方」，D6/§5.6/§4.1/§5.1 同步；`RiverLayout.meld.rect` 新增，测试断言上下关系 |
| B2 | `actions.right` 是 x 坐标还是 CSS 偏移未定义，测试无法区分 | **已修**：拆成 `rightX/bottomY`（屏幕）与 `rightOffset/bottomOffset`（CSS），测试断言两套关系 |
| B3 | 全副露断言 `centerCompact=true` 在 4:3/正方形误杀正确实现 | **已修**：改成 `centerCompact === (height < 176s)`，并写明 750/16:10 为 true、4:3/正方形为 false |
| B4 | 12 条断言没有钉 `s` 公式，固定 1334×750 布局可全绿 | **已修**：新增 `s` 公式、手牌占宽、贴底、中央井高三条硬断言 |
| H1 | `Partial<MahjongTableInput>` 是浅 Partial，`layout(W,H,{})` 会 TypeError | **已修**：逐座 Partial + `normalizeLoad`；测试 `layout(W,H)` 不抛 |
| H2 | `cardCounts`/`revealedHands` 可能 14 张，侧区按 13 张预算 | **已修**：`BACK_BUDGET=14`，`sideHandH=14×24+45=381`；D4 写明 cardCounts 不含副露 |
| H3 | `MahjongRiver` 没有 pop 通道 | **已修**：`melds` 元素带 `{key, meld, pop}`，River 透传 `:pop` 并上抛 `meld-pop-done(key)` |
| H4 | 摸牌 diff 边界没写完，下标消费者漏项 | **已修**：§5.4 写清「存在才移除再追加」、换局清空、重连/杠的登记边界；列全 10 个 display 下标消费者 |
| H5 | 层叠表缺失 | **已修**：§5.7 写死 z-index 分层（动作 3、托管 4、结算 1/2、菜单/banner/弹层 10、overlay 15、connection 20） |
| H6 | 托管遮罩 `bottom:96px` 会压手牌 | **已修**：遮罩底缘 = 手牌顶 − 8s；§6 表登记 |
| H7 | 旧 CSS 残留（手牌 -18px、meld -14/cap、overflow-x、hint bottom:-16）未列删除 | **已修**：计划 Task 2/Task 10 明列删除与替换；手牌提示改到上方 |
| H8 | 侧区顶部锚定，正方形上构图偏上 | **已修**：侧区在可用竖向带居中；§7.1 加中心差 <100s 断言 |
| H9 | 左右家亮牌 30×45 竖槽放 49×40 横牌面不可读 | **已修**：左右家亮牌改到牌河区 3 列 49×40；D4/§5.5/§5.6/§6 同步 |
| H10 | 比例断言与取整 token 冲突（72/108 ≠ 75/113） | **已修**：D3 改为「宽 = 高 × 75/113」；代码按比例算，不取整 |
| H11 | `actions` 没有高度，ClaimTile 可能很高 | **已处置/登记**：新增 `minHeight`；允许盖自己的牌河/副露右半；右缘不越右家区 |
| H12 | 牌背测试夹具全 13、只数个数 | **已修**：`cardCounts=[14,10,7,0]`，逐座断言数量 + `src` 以 back.png 结尾 |
| H13 | 画布注入测试只证明「变了」 | **已修**：断言与 `mahjongTableLayout(1623,750)` 的 tile 尺寸逐值一致 |
| H14 | SeatChip 缺 reduced-motion | **已修**：组件内自带 `@media (prefers-reduced-motion)` |
| H15 | 新组件必须有 `<style>` 块 | **已写入计划 Global Constraints** |
| H16/H18 | 紧凑卡尺寸/宽度三处不一致 | **已修**：紧凑卡宽用满中央井 −8s、高 40s、11px 单行省略号；删除旧数字 |
| H17 | 数字陈旧（466/124/32-36） | **已修**：458/116/「对家自己 36、左右 32」 |
| L1-L12 | 取整差、纯函数恒真、侧河填充顺序、触达、对家卡口径、装饰重叠、删除安全性、单根闸、ClaimTile 尺寸 | **已处置**：填充顺序写死行优先；对家卡口径写入 D7；装饰重叠登记；纯函数测试加 freeze；ClaimTile 尺寸登记不改 |

**修订后状态：待第二轮复审 / 进入计划。**
