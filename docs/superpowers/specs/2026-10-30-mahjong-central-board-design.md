# 麻将中央牌板设计（2026-10-30，第二片）

> 状态：待对抗审查
> 上一片：`2026-10-30-mahjong-table-layout-design.md`（四家围桌比例布局，已推 dev `56a65b37`）
> 需求来源：用户「中央信息框换一种展示方式」+「玩家出牌堆在中间」；
> 已拍板：**方案 B —— 中央牌板（四向分区收紧成一块矩形，信息格嵌在正中）**。
> 示意图（按真实坐标绘制，gitignored）：
> `.superpowers/mahjong-layout-research/v2-mockups/{current,current-nomeld,a,b,c}-1334x750.png`、
> `b-1334x1000.png`、`c-1334x1000.png`；夹具 `mockup.html?v=current|a|b|c[&h=1000][&nomeld=1]`。

## 1. 背景与问题

### 1.1 现状（上一片交付后的实测）

`mahjongTableLayout` 的中央区是**残差**：`centerZone = H − 顶区 − 底区`，而顶/底区各自把副露条
（60s + 8s）算进竖向预算。实测（真实组件 + 同一夹具）：

| 状态 | topZoneH | bottomZoneH | 中央井 | 中央卡 |
|---|---|---|---|---|
| 16:9 无副露 | 222 | 280 | 916×184 | 220×160 方块 |
| 16:9 **任一「对家或我」碰一次** | 290 | 348 | 916×**48** | **908×40 全宽横幅** |

五个具体问题：

| # | 问题 | 数字/证据 |
|---|---|---|
| P1 | 中央卡在有人碰/杠时**整块换形态**（纵向→横向、听牌列表消失） | 井高 184→48；卡 220×160→908×40（21:9 为 1352×40） |
| P2 | 16:9 的井是 **5:1 横带**：填满就成横幅，不填满就 220 宽孤岛 + 两侧各 356 空绿；4:3 反过来是「363 高空井 + 160 卡」 | `centerZone 916×184`／`916×363` |
| P3 | 四向环内部 **24% 面积不属于任何构件**：环域 1234×488=602k，牌河 289k、井 169k（卡只占 35k）、空绿 144k | 四角各 156×93.5 + 井两侧各 156×184 |
| P4 | 信息层级扁平：head 行三件同级；紧凑模式全 11px；待响应牌退化纯文字；听牌列表整块消失；「已胡 N 家」占一行但座位卡已有徽标 | `MahjongCenter.vue` |
| P5 | 弃牌溢出策略只有「整块缩牌」（>24 张 0.664×/0.747×），且 `fit` 只按声明行数算，>36/32 槽会溢出 rect | `buildRiver` + `overflow: visible` |

另有一处语义错：`claimTile` 取 `claimsForMe` 里第一个带 `tile` 的选项，**出牌窗口（自摸胡/暗杠）
也会显示「可响应 某牌」**。

### 1.2 方案 B 的一句话

把「四块牌河 + 中央井」重排成**一块连续的中央牌板**：左右两条牌河拉满牌板全高（吃掉四个空角），
中间列自下而上 = 对家牌河 / 信息格 / 自己牌河，**信息格四边被牌河包住**；副露移出竖向预算。

## 2. 范围

### 做

- 纯客户端：`apps/client/src/game/mahjong-layout.ts` 中央区重写 + 组件重排 + 测试。
- 新增 `MahjongMeldStrip.vue`（副露条从 `MahjongRiver` 拆出）。
- `MahjongCenter.vue` 重写为三档信息格。
- 四家弃牌仍是四个 `MahjongRiver`（方向 my/top/left/right 不变），只是 rect/cols/rows 变。
- 副露位置：对家两翼（放不下则整体下移到牌背与牌板之间）、自己手牌上方、左右外侧栏竖排。
- 牌河容量：`fit` 由**实际所需行数**推导，任何张数都不溢出。

### 不做

- 不改协议/服务端/结算/规则/音效/历史；不改 `table.vue` 的 props/emit 接线。
- 不做竖屏；不做滚动/折叠/展开交互；不引入计时器；不做真实头像。
- 不重排斗地主/跑得快。
- **不重议**：高度基准 + 宽度兜底（`s = min(H/750, 0.88W/handRowW)` 不变）、四家围桌语法、
  牌张比例、字号不随 s 放大。
- 不做「共享单网格 + 座位色」（方案 C）、不做「最近 N 张 + 历史折叠」。

## 3. 决策表

| # | 决策 | 理由 / 取舍 |
|---|---|---|
| D1 | 牌板 = 左右侧道 + 中间列；中间列承载上下牌河 + 信息格；牌板整体水平居中，中间列中心 = 画面中心 | 四向位置语义保留（谁打的一眼看出），空角被侧道吃掉 |
| D2 | 中间列 **12 列**（16:9/带鱼屏）或 **11 列**（16:10/4:3/正方形）；侧道 **3 列** 或 **2 列**；候选序 `(12,3)→(12,2)→(11,2)→(10,2)→(9,2)→(8,2)`，取第一个满足「牌板宽 ≤ 可用宽 且 **中间列宽 ≥ 160s**」的 | 可用宽 = `W − 2×(outer+sideChipW+inner)s`（座位卡留在桌边）；候选序保证宽屏优先 12/3、窄高屏自动退 11/2 |
| D3 | 侧道宽 = `cols×49s + (cols−1)×2s`（侧牌 49×40 资产）；上下道宽 = `cols×75×75/113 s + (cols−1)×2s`；牌板宽 = 中间列 + 2×侧道 | 牌张比例沿用（侧道用 49，不用 49.78） |
| D4 | 竖向：`boardTop = 64s+8s+54s+8s`（+ 对家副露下移条）；`boardBottom = handTop − 8s − (自我副露条 49s+8s)`；上下道行数 `rows ∈ [2,4]`：**先取最大且 `infoH(r) ≥ 240s` 的 r；无解则取最大且 `infoH(r) ≥ 120s` 的 r；再无解取 2**。`infoH = clamp(availH − 2×laneH, 0, 240s)`；牌板在可用带内垂直居中 | 16:9 → 2 行（184）；4:3 无副露 → 2 行（270.5 = 240s 封顶）；正方形 → 4 行（270.5）；16:9 各 1 碰 → 127。信息格高度只受**我自己副露**与自己副露条影响；对家 1–2 组副露走两翼、不再改形态（3–4 组才下移） |
| D5 | 侧道行数 = `floor((牌板高+2s)/(40s+2s))`，贯穿牌板全高 | 吃掉四角；16:9 3×11=33 槽、16:10 2×11=22、4:3 2×13=26、正方形 2×20=40 |
| D6 | 弃牌填充：四道统一**行优先、左上原点**；牌河网格 `align-content/align-items: start`（不随行数居中漂移）；最新牌金边高亮；claim 窗口只让来源道 `interactive` | 位置稳定（追加式，旧牌不移动）；方向语义保留（侧道仍是旋转 90° 牌面） |
| D7 | `neededRows = max(1, ceil(n/cols))`；`fit = min(1, 道宽/(cols×tileW+(cols−1)gap), 道高/(neededRows×tileH+(neededRows−1)gap))`，**不设行数上限**；`tile.w/h > 0` | 任何张数都不溢出（P5），n=0 也不会除零；代价是高张数时同局牌面会缩小（登记） |
| D8 | 副露从 `MahjongRiver` 拆到 `MahjongMeldStrip`。**对家**：牌背两翼（0.55×，组距 4s），按**实际组型**逐翼计算宽度（碰 3 张 / 杠 4 张），右翼先分 `ceil(n/2)` 组；两翼都放得下才走两翼，否则整条下移到牌背与牌板之间（0.65×，牌板下移）。**自己**：手牌上方居中（0.65×）。**左右**：外侧栏竖排（0.65×，座位卡下方），牌张用 **49×40 资产 ×0.65 = 31.85×26**，组宽 103.4s、4 组高 116s（与上一片同口径） | 副露不再吃信息格高度；用实际组型而非最坏假设，避免 1 组碰就把 16:10 打成 compact |
| D9 | 左右座位卡不动（桌边 `outer`，y = 牌板顶）；左右牌背移到**牌板外侧紧邻**：左 `boardLeft − 8s − 30s`、右 `boardRight + 8s`，y = 座位卡底 + 8s | 牌背与弃牌相邻；两侧镜像由同一公式推出，测试两侧都断 |
| D10 | 信息格三档：`full`（infoH ≥ 176s）/ `dense`（≥120s）/ `compact`；见 §5.4；**信息格宽 = 中间列宽**（不再留两侧空带） | 16:9 无副露 full、各 1 碰 dense；4:3/正方形 full；16:10 4 杠 compact（登记） |
| D11 | 中央**移除**「已胡 N 家」（座位卡「胡」徽标 + 亮牌承担）；阶段文案保留；待响应牌带来源座名（`东家甲打出`），play 窗口改「可自摸胡」；同时删 `endReason` 死变量 | 去冗余；修 P4 的语义错 |
| D12 | 左右家已胡：亮牌网格替换该道（同现状）；对家已胡：牌背位亮牌（同现状） | 交互与呈现不变 |
| D13 | 动作浮层：`rightX = 右道左缘 = board.left + board.width − sideLaneW`；`bottomY = handTop − 8s`；`rightOffset = W − rightX`、`bottomOffset = H − bottomY`；`maxWidth = min(400s, W − 2×outer×s)`、`minHeight = 80s` | 旧值会横跨右道、盖住右家可点弃牌；新值只压**自己**下道的右半，与旧行为同族 |
| D14 | 组件零 `setTimeout/setInterval`；动效复用 `animations.scss`；单根；`@import` 不能 `@use`；新组件必须有 `<style lang="scss">` | 仓库闸 |
| D15 | 不新增滚动；牌板与牌河都是固定网格 | 牌桌不滚动纪律 |
| D16 | 输入 `MahjongSeatLoad` 增加 `gangMelds?: number`（该座 4 张组数，`gang`/`angang` 都算）；Board 从 `view.melds[seat]` 数出来 | 两翼宽度按实际组型算，避免最坏假设误判 |
| D17 | 对家三处副露带**互斥**：`below.height > 0` ⇒ 两翼 `groups = 0` 且**不渲染**；`melds = 0` ⇒ 该条不渲染；同一 key 只出现在一条带里（右翼取前 `ceil(n/2)`，左翼取其余，`below` 仅在弃用两翼时取全部） | 防止同 key 双渲染播两次 pop / `pop-done` 提前清 key；空条不占点击 |

## 4. 几何

### 4.1 基准与派生（s=1）

沿用 `MAHJONG_TABLE_TOKENS` 的牌张/间距/座位卡 token；本片新增：

| token | 值 | 说明 |
|---|---|---|
| `meldTopScale` | 0.55 | 对家副露（两翼） |
| `meldScale` | 0.65 | 自己副露 |
| `sideMeldScale` | 0.65 | 左右副露（作用在 49×40 侧牌上） |
| `meldGroupGap` | 4 / 8 | 对家翼内 4s；自己条 8s；左右竖排 4s |
| `infoMaxH` | 240 | 信息格高上限 |
| `infoMinW` | 160 | 中间列宽下限（候选筛选） |
| `sideChipW` | 180 | 左右座位卡宽（不变） |

派生（16:9，s=1，无副露）：

```
tileW = 49.778, gap = 2, pitch = 51.778
中间列 12 列 → middleW = 619.345
侧道 3 列（侧牌宽 49）→ sideLaneW = 3×49 + 2×2 = 151
牌板宽 bandW = 921.345；boardLeft = (1334−921.345)/2 = 206.33
boardTop = 64+8+54+8 = 134
boardBottom = 630 − 8 = 622
availH = 488
laneH = 2×77−2 = 152；infoH = 488−304 = 184
侧道行数 = floor(490/42) = 11 → 33 槽
信息格 infoW = 中间列宽 = 619.345（不再留两侧空带）
```

### 4.2 七档视口实测（算法跑出来的值，测试按这些钉）

无副露：

| 视口 | s | 中间/侧列 | 牌板 | 板顶 | 板高 | 信息格 | 上/下道 | 侧道槽 | 档 |
|---|---|---|---|---|---|---|---|---|---|
| 1334×750 | 1.000 | 12/3 | 921.3×488 @206.3 | 134 | 488 | 619.3×184 | 24 | 33 | full |
| 1623×750 | 1.000 | 12/3 | 921.3×488 @350.8 | 134 | 488 | 619.3×184 | 24 | 33 | full |
| 1778×750 | 1.000 | 12/3 | 921.3×488 @428.3 | 134 | 488 | 619.3×184 | 24 | 33 | full |
| 1334×800 | 1.067 | 12/2 | 874.0×520.5 @230.0 | 142.9 | 520.5 | 660.6×196.3 | 24 | 22 | full |
| 1334×833 | 1.111 | 11/2 | 852.5×542 @240.7 | 148.8 | 542 | 630.4×204.4 | 22 | 22 | full |
| 1334×1000 | 1.127 | 11/2 | 865.1×613.1 @234.4 | 196.8 | 613.1 | 639.7×270.5 | 22 | 26 | full |
| 1334×1334 | 1.127 | 11/2 | 865.1×960.3 @234.4 | 190.2 | 960.3 | 639.7×270.5 | 44 | 40 | full |

对家 + 我各 1 碰（两翼都放得下）：

| 视口 | 板高 | 信息格 | 档 |
|---|---|---|---|
| 1334×750 | 431.3 | 619.3×127.3 | dense |
| 1334×800 | 460.0 | 660.6×135.7 | dense |
| 1334×833 | 479.0 | 630.4×141.3 | dense |
| 1334×1000 | 613.1 | 639.7×270.5 | full |
| 1334×1334 | 960.3 | 639.7×270.5 | full |

最坏（对家 4 杠 + 我 4 杠）：

| 视口 | 板高 | 信息格 | 对家副露 | 档 |
|---|---|---|---|---|
| 1334×750 | 431.3 | 619.3×127.3 | 两翼（右 175 ≤ 195.1） | dense |
| 1334×800 | 399.5 | 660.6×75.2 | **下移** | compact |
| 1334×833 | 415.9 | 630.4×78.3 | 下移 | compact |
| 1334×1000 | 576.8 | 639.7×234.1 | 下移 | full |
| 1334×1334 | 786.7 | 639.7×270.5 | 下移 | full |

### 4.3 牌板布局（16:9 示意）

```
┌────────────────────────────────────────────────────────────┐
│ 顶栏 64                                                     │
│        [对家副露左翼][对家牌背 527.8][对家副露右翼]          │
│ ┌──────┬──────────────────────────────┬──────┐            │
│ │ 左家 │      对家牌河 12 列 × 2 行     │ 右家 │ ← 牌板      │
│ │ 3×11 ├──────────────────────────────┤ 3×11 │   921.3×488 │
│ │ 151  │      信息格 619.3×184         │ 151  │   @206.3,134│
│ │      ├──────────────────────────────┤      │            │
│ │      │      自己牌河 12 列 × 2 行     │      │            │
│ └──────┴──────────────────────────────┴──────┘            │
│ [自己卡]  [自己的副露条 0.65×]                               │
│                  [手牌 1041.54×108]                         │
└────────────────────────────────────────────────────────────┘
左家外侧栏（x 12..192）：座位卡 180×56（板顶）→ 副露竖排 103.4×n → 牌背 30×381
（右侧镜像：牌背在 boardRight + 8s，副露在 W − 12 − 103.4）
```

## 5. 实现设计

### 5.1 纯函数 `mahjongTableLayout`

文件不变：`apps/client/src/game/mahjong-layout.ts`。**删**：`topZone / leftZone / rightZone /
centerZone / centerCard / centerCompact / ownRiver / topRiver / leftRiver / rightRiver`。
**增**：

```ts
export interface MahjongSeatLoad {
  discards: number;
  melds: number;
  /** 该座 4 张副露（gang/angang）的组数；用于按实际组型算两翼宽度。 */
  gangMelds?: number;
}

export interface MahjongTableInput {
  top?: Partial<MahjongSeatLoad>;
  left?: Partial<MahjongSeatLoad>;
  right?: Partial<MahjongSeatLoad>;
  self?: Partial<MahjongSeatLoad>;
}

export type LaneOrigin = 'top-left';   // 本片四道统一左上原点

export interface LaneLayout {
  rect: Rect;
  tile: TileSize;
  gap: number;
  cols: number;
  /** 容量行数（= floor(道高/行距)）；渲染不依赖它，仅供契约/测试。 */
  rows: number;
  /** 1 = 不压缩；<1 = 按实际所需行数压缩。 */
  fit: number;
  origin: LaneOrigin;
}

export interface MeldStripLayout {
  /** 条带矩形；height=0 时为零矩形。 */
  rect: Rect;
  tile: TileSize;
  overlap: number;
  groupGap: number;
  /** 本条带承载的组数；0 = 空条（不渲染）。 */
  groups: number;
  /** 'row' = 横排（对家翼/自己条），'column' = 竖排（左右外侧栏）。 */
  direction: 'row' | 'column';
}

export type InfoLevel = 'full' | 'dense' | 'compact';

export interface MahjongTableLayout {
  s: number;
  bar: Rect;
  /** 中央牌板外接矩形（四道 + 信息格）。 */
  board: Rect;
  topLane: LaneLayout;
  bottomLane: LaneLayout;
  leftLane: LaneLayout;
  rightLane: LaneLayout;
  /** 信息格：宽 = 中间列宽，上下被牌河包住、左右被侧道包住。 */
  info: Rect;
  infoLevel: InfoLevel;
  infoTiles: { claim: TileSize; ting: TileSize };
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  topBacks: { rect: Rect; tile: TileSize; gap: number };
  leftBacks: { rect: Rect; tile: TileSize; pitch: number };
  rightBacks: { rect: Rect; tile: TileSize; pitch: number };
  topMelds: { left: MeldStripLayout; right: MeldStripLayout; below: MeldStripLayout };
  leftMelds: MeldStripLayout;
  rightMelds: MeldStripLayout;
  selfMelds: MeldStripLayout;
  selfChip: Rect;
  leftChip: Rect;
  rightChip: Rect;
  barChip: TileSize;
  actions: {
    rightX: number; bottomY: number;
    rightOffset: number; bottomOffset: number;
    maxWidth: number; minHeight: number;
  };
}
```

- 纯函数、无副作用、输入输出全数字；`mahjongTableLayout(W,H)` 不传 input 不抛错。
- `w = max(1334, finitePositive(width, 1334))`、`h = max(750, finitePositive(height, 750))`：
  画布模型保证 ≥1334×750；小于该值一律回落到最小值，避免负矩形。
- `normalizeLoad` 夹 `melds ∈ [0,4]`、`gangMelds ∈ [0, melds]`。
- 候选筛选（D2）用 `中间列宽 ≥ 160s`；都不满足时退 `(8,2)`。
- 各道 `fit` 按 D7 计算；`rows` = 容量行数（`floor((道高+gap)/(tileH+gap))`）。
- 信息格：`info.left = board.left + sideLaneW`、`info.width = middleW`、`info.top = board.top + laneH`、`info.height = infoH`。
- `topMelds.below` 的 `height`：`top.melds>0 且两翼放不下` 时为 `48.75s`，否则 0；此时 `board.top` 下移 `48.75s+8s`，两翼 `groups=0`。
- `leftMelds/rightMelds`：牌张 `31.85s × 26s`（49×40 × 0.65），组宽 `103.4s`，`height = n×26s + (n−1)×4s`（n=0 时 0），
  左 x=`outer`、右 x=`W−outer−103.4s`，y = `leftChip.top + 56s + 8s`。
- `selfMelds`：宽 = 中间列宽，高 `48.75s`，水平居中，`top = hand.rect.top − 8s − 48.75s`；`self.melds=0` 时零矩形。
- `topMelds.left/right`：y = 牌背行（`64s+8s`）垂直居中，高 `41.25s`；左翼右缘 = `topBacks.left − 8s`，
  右翼左缘 = `topBacks.right + 8s`；宽度 = 各自可用空间（到座位卡内缘 − 8s）；
  `groups` 用该座实际组型（碰 `3tw−2ov` / 杠 `4tw−3ov`）逐翼算；右翼先分 `ceil(n/2)` 组。
- `actions`：`rightX = board.left + board.width − sideLaneW`；`bottomY = handTop − 8s`；
  `rightOffset = W − rightX`；`bottomOffset = H − bottomY`；`maxWidth = min(400s, W−2×outer×s)`；`minHeight = 80s`。

### 5.2 组件

| 组件 | 改动 |
|---|---|
| `MahjongRiver.vue` | **删**副露 props 与渲染、`meld-pop-done` emit；新增 `source?: boolean`（claim 窗口来源道，加类 `mj-river--source`）。保留：弃牌网格、`revealed` 亮牌网格、`filterTileType` 高亮、`discard-click`、`direction`、`cols`、`rows`、`tileW/H`、`gap`。**根元素对齐改为 `align-items: flex-start; justify-content: flex-start`**（原来居中，行数从 1→2 时整块上移 38.5s；D6）。网格自身同时 `align-content: start` |
| `MahjongMeldStrip.vue` | **新增**。props：`melds({key,meld,pop})`、`direction`、`tileW/H`、`overlap`、`groupGap`、`layout:'row'|'column'`；emit `pop-done(key)`。渲染每组 `MahjongMeld` + 「碰/杠/暗杠」小标签 + `anim-meld-pop`；`melds` 空时不渲染根 |
| `MahjongCenter.vue` | 重写为三档（§5.4）。props：`wallCount, phaseText, level:'full'|'dense'|'compact', claimTile?, claimW?, claimH?, claimLabel?, claimFrom?, tingTiles?, tingW?, tingH?, maxFan?, seconds, active?`（删 `compact`/`endedText`）。保留根类 `mj-center`、`mj-center--compact`、`mj-center__clock--urgent` |
| `MahjongBoard.vue` | 分区按新 layout 输出；四道 `MahjongRiver` + **六处** `MahjongMeldStrip`（`--top-left/--top-right/--top-below/--left/--right/--self`）；信息格加 `mj-info-slot` 类与 `claimFrom`/`claimLabel`/`level`；删 `endReason` |
| `MahjongTile.vue` / `MahjongMeld.vue` | 不改 |

### 5.3 接线（Board 侧）

```ts
const layout = computed(() => mahjongTableLayout(canvas.value.width, canvas.value.height, loads.value));
const isSource = (seat: number) =>
  phase.value === 'claim' && amActive.value && seat === (props.view?.currentPlayer ?? -1);
// 四道
<MahjongRiver class="mj-river-slot mj-river-slot--top" v-bind="riverProps(topSeat)" />
// 副露（互斥：below 生效时两翼 groups=0 且不渲染）
<MahjongMeldStrip class="mj-melds-slot mj-melds-slot--top-right" v-bind="topMeldProps('right')" />
```

- `riverProps` 读 `layout.topLane/bottomLane/leftLane/rightLane`；`interactive` 与 `source` **共用 `isSource(seat)`**（一处计算，两处消费）。
- `loads` 增加 `gangMelds`：`melds[seat].filter(m => m.tiles.length === 4).length`。
- 副露 strips 复用现有 `meldKey` / `newMeldKeySet` 增量 pop 逻辑（逻辑不变，只是渲染位置换了组件）。
- `chipProps` / `backsProps` 不变（rect 由 layout 给）；`centerProps` 按 §5.4 的 props 组装。

### 5.4 信息格内容（D10；宽度 = 中间列）

| 档 | 条件 | 内容 | 字号 |
|---|---|---|---|
| `full` | infoH ≥ 176s | ① 牌墙 N（大数字）+ 阶段 + 倒计时（一行）；② 待响应牌 34×51 + 「来源座 打出」（有 claim）；③ 听牌小牌面 20×30 + 「N 番」（有听牌） | 牌墙 `$ftl-font-xl`(40)、阶段 `$ftl-font-md`(28)、倒计时/标签 `$ftl-font-sm`(26) |
| `dense` | 120s ≤ infoH < 176s | ① 行同上（字号降一档）；② 待响应牌 34×51；**不显示听牌列表** | 牌墙 `$ftl-font-lg`(32)、阶段/标签 `$ftl-font-sm`(26) |
| `compact` | infoH < 120s | 单行 `牌墙 N · 阶段 · 12s`；有 claim 时第二行文字 `可响应 万5` | 11px（沿用现值） |

- 倒计时 `active` 时显示，≤5 秒加 `mj-center__clock--urgent`（不变）。
- **阶段文案必须保留 `min-width:0 + text-overflow: ellipsis`；倒计时 `flex-shrink: 0`**，否则长文案（「换三张：选 3 张同花色」）会挤掉倒计时。
- 「已胡 N 家」移除；`ended` 时阶段文案仍是「本局结束」（`phaseText` 已有）。
- 信息格 `overflow: hidden`，`full` 档内容可换行但不滚动。

### 5.5 交互不变清单

双击出牌、换三张、定缺、碰/杠/胡/过（含自摸胡/暗杠/补杠映射）、弃牌点击过滤（来源道）、
长按手牌提示、托管/取消、胡牌 banner FIFO、副露 pop、结算/连接浮层、已胡亮牌 —— 全部保持。

## 6. 边界与错误处理

| 场景 | 行为 |
|---|---|
| 弃牌 > 道容量 | `fit` 压缩（D7），任何张数不溢出；>36 张时牌面明显变小（登记） |
| 副露 4 组（对家/自己/左右） | 对家两翼按**实际组型**逐翼算：16:9 4 杠仍走两翼（右翼 175 ≤ 195.1）；16:10/4:3/正方形下移（牌板少 57s，信息格分别 78/234/270，登记）。自己 4 组 0.65× 宽 446s ≤ 中间列；左右竖排 4 组高 **116s**，座位卡下起 |
| 信息格 < 120s | `compact` 单行；有 claim 时第二行文字 |
| 牌板宽 > 可用宽（极端窄画布） | 候选退 `(8,2)`；`W<1334` / `H<750` 一律回落最小值；`fit` 保网格不溢出 |
| `view === null` / 等待发牌 | 顶栏 + 「等待发牌…」；分区空 |
| 左右家已胡 | 该道渲染 `revealed` 亮牌网格；牌背清空 |
| 对家已胡 | 牌背位渲染亮牌 |
| 我 active 的 play 窗口有自摸胡 | 信息格显示「可自摸胡 + 牌面」，不显示来源座 |
| claim 窗口 | 信息格显示「来源座 打出 + 牌面」；来源道 `mj-river--source` 高亮，点击过滤 |
| 对家三处副露带 | 互斥：`below.height>0` ⇒ 两翼 `groups=0` 且不渲染；`melds=0` ⇒ 不渲染；同一 key 只出现在一条带里（D17） |
| 结算已到达/已展示 | 动作浮层不渲染；牌板保持可读 |

## 7. 测试判据

### 7.1 纯函数矩阵

重写 `apps/client/test/mahjong-layout.test.ts`（旧 `centerZone/topZone/ownRiver` 断言随契约作废）。

视口 **7 档**：`1334×750`、`1623×750`、`1778×750`、**`1334×800`**、`1334×833`、`1334×1000`、`1334×1334`。
夹具三种：`EMPTY`（全 0）、`ONE`（对家 + 我各 1 碰）、`WORST`（对家 + 我各 4 杠）。
**每条断言注明夹具**；矩阵用例逐视口跑。

1. **`s` 公式**（EMPTY）：与 `max(1, min(H/750, 0.88W/1041.5398))` 差 ≤1e-6；
2. **矩形合法**（EMPTY + WORST）：有限、非负、在画布内（0.01 容差）；
3. **候选与列宽独立重算**（EMPTY）：不用 layout 自身输出，按 token 常量重算
   `middleW = mid×49.7788s + (mid−1)×2s`、`sideLaneW = side×49s + (side−1)×2s`；
   断言 `topLane.rect.width = middleW`、`leftLane.rect.width = sideLaneW`、`board.width = middleW + 2×sideLaneW`；
   逐视口钉 `(mid, side)` = `(12,3)/(12,3)/(12,3)/(12,2)/(11,2)/(11,2)/(11,2)`；
4. **中间列中心 = 画面中心**（EMPTY）：`|topLane.left + topLane.width/2 − W/2| < 0.01`；
5. **信息格贴四边**（EMPTY）：`info.width = middleW`、`info.height = board.height − 2×laneH`、
   `info.top = topLane.bottom`、`info.bottom = bottomLane.top`、`info.left = leftLane.right`、`info.right = rightLane.left`；
6. **侧道贯穿全高**（EMPTY + WORST）：`leftLane.top = board.top`、`leftLane.height = board.height`（右侧同）；
7. **容量逐视口字面量**（EMPTY）：上/下道 `24/24/24/24/22/22/44`；侧道 `33/33/33/22/22/26/40`；
8. **`fit` 任何张数不溢出**（每个视口；只给 `top.discards`）：n ∈ `0/12/24/30/48`，
   断言 `0 < fit ≤ 1`、`tile.w > 0`、`tile.h > 0`、n=0 时 `fit=1`，
   且 `ceil(n/cols)×tileH + (ceil(n/cols)−1)×gap ≤ 道高 + 0.01`；
9. **牌张比例**（EMPTY）：上/下道/手牌/对家背 `75/113`；侧道 `49/40`；
10. **`infoLevel` 逐视口字面量**：EMPTY 全 `full`；ONE → `dense/dense/dense/dense/dense/full/full`；
    WORST → `dense/dense/dense/compact/compact/full/full`；
11. **高度钉死**（16:9）：EMPTY `board.height=488`、`info.height=184`、`laneH=152`；
    ONE `board.height≈431.3`、`info.height≈127.3`；
12. **对家副露下移**：16:9 的 ONE 与 WORST `below.height=0`；1334×833 的 ONE `=0`（2 组放得下），
    WORST `=48.75s` 且 `board.top ≈ 211.9`；
13. **副露条不压牌河/信息格**（WORST）：左翼右缘 ≤ `topBacks.left`、右翼左缘 ≥ `topBacks.right`、
    `below.bottom ≤ board.top`、`selfMelds.bottom ≤ hand.top`、`leftMelds.right ≤ leftLane.left`、
    `rightMelds.left ≥ rightLane.right`；
14. **两侧牌背镜像**（EMPTY）：`leftBacks.right = leftLane.left − 8s`、`rightBacks.left = rightLane.right + 8s`；
15. **座位卡在桌边**（EMPTY）：`leftChip.left = 12s`、`rightChip.left = W − 12s − 180s`；
16. **动作浮层**（EMPTY）：`rightX = rightLane.left`、`bottomY = hand.top − 8s`、
    `rightOffset = W − rightX`、`bottomOffset = H − bottomY`；
17. **纯函数性**：不传 input 不抛错、与全 0 等价；`Object.freeze` 后可算；同输入两次逐值相等；
18. **非法输入**（0/负数/NaN/Infinity）回落 1334×750 且无 NaN、无负矩形。

### 7.2 组件测试

- `mahjong-meld-strip.test.ts`（新）：碰 3 张、杠 4 张同行、暗杠 4 张牌背、标签、`pop` 类、
  `pop-done` 上抛 key、`layout='column'` 类、空副露不渲染根。
- `mahjong-river.test.ts`（改）：删副露相关 4 条（迁到上面的新文件）；保留弃牌顺序/最新高亮/
  点击 emit/过滤 outline/direction 类/revealed 替换 discards；**新增** `source` 类、
  **源码闸**断言网格 `align-content: start`（jsdom 验不了漂移，只能钉源码）。
- `mahjong-center.test.ts`（改）：三档断言（full 有听牌、dense 无听牌、compact 单行）、
  `claimFrom` 文案、`可自摸胡` 文案、紧急类、active=false 无倒计时、**删「已胡家数文案」**；
  **保留**源码闸「compact 11px」断言（`mahjong-center.test.ts:60-63`，改选择器即红，必须同步保留同规则）。
- `mahjong-board.test.ts`（改）：
  - 现有 T11 六条用例不改（手牌/换三张/定缺/出牌/claim/自摸）；
  - T12 的 `.mj-river--{top,left,right,my}` 类保持；「结束态只出现一次本局结束」保持；
  - 副露 pop 用例的选择器 `.mj-river--left .anim-meld-pop` → `.mj-melds-slot--left .anim-meld-pop`；
    `.mj-river--top .anim-meld-pop` → `.mj-melds-slot--top-right .anim-meld-pop`；
  - **新增**：四道 rect 与纯函数逐值一致（提供 `CANVAS_METRICS_KEY`，用 **1334×1000**，s≈1.127）；
  - **新增**：`.mj-info-slot` 的 rect 与 `layout.info` 逐值一致；文本含牌墙/阶段；
  - **新增**：claim 窗口来源道有 `mj-river--source`，非来源道没有；
  - **新增**：对家 4 杠时 `.mj-melds-slot--top-below` 存在且两翼不存在（互斥）。

### 7.3 闸

`pnpm -C apps/client test`、`pnpm -C apps/client run lint`、`pnpm -C apps/client run build:h5`；
仓库闸 `ui-tokens` / `animations` / `source-boundary` / `art-slots` 随全量跑。

## 8. 风险与已知边界

| 风险 | 处置 |
|---|---|
| 16:10 对家 4 杠 + 我 4 杠时信息格只剩 78s（compact） | 登记；单行仍可读；16:10 非主力视口；1–2 组副露仍走两翼、信息格 204→141 |
| 高张数（>36）压缩到 0.5× 以下 | 登记；不溢出优先；血战到底末期单人可到 40+ 张 |
| 4:3/正方形中间列 11 列、侧道 2 列 | 容量 22/26 ≥20；信息格反而更宽（640/660） |
| 对家副露在窄高屏下移，牌板少 57s | 4:3 信息格 234（full）；16:10 141→78（登记） |
| 四道统一左上原点 ⇒ 自己那条道的最新牌离中心最远 | 最新牌金边高亮承担；不引入动态锚点（避免布局漂移）；River 网格 `align-content:start` 保证旧牌不动 |
| 「已胡 N 家」移除后，血战到底「还剩几家」要靠数座位卡「胡」徽标 | 登记；交付报告里列为待走查项；若真机走查认为不够，下一片在 dense/full 档加一行，不加高度 |
| `MahjongRiver` 的副露测试迁移 | 迁移而非删除；新组件断言等强 |
| 旧 layout 契约（`topZone/centerZone/...`）作废 | 只影响 `mahjong-layout.test.ts` 与 Board；无外部消费者 |
| `centerTiles` 改名 `infoTiles` | 旧 Center 在 Task 3 前仍由 Board 用新字段喂；Task 4 后无残留 |

## 9. 涉及文件

新增：
- `apps/client/src/components/table/mahjong/MahjongMeldStrip.vue`
- `apps/client/test/mahjong-meld-strip.test.ts`

修改：
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongRiver.vue`（删副露 + `source` + 网格起点对齐）
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`（三档重写；保留 compact 11px 源码闸规则）
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（四道 + 六条副露带 + `mj-info-slot`；删 `endReason`）
- `apps/client/test/mahjong-layout.test.ts`（重写）
- `apps/client/test/mahjong-river.test.ts`（删副露 4 条 + 新增 `source` + 源码闸）
- `apps/client/test/mahjong-center.test.ts`（三档；删「已胡家数文案」；保留 11px 源码闸）
- `apps/client/test/mahjong-board.test.ts`（副露选择器 + 新用例）

不动：`table.vue`、`MahjongTile.vue`、`MahjongMeld.vue`、`MahjongSeatChip.vue`、`MahjongHandBacks.vue`、
`useLandscapeCanvas.ts`、`LandscapeStage.vue`、协议/服务端。

## 10. 审查记录

### 2026-10-30 第一轮（独立 reviewer，sonnet，对抗审查）

**结论：需修订后复审。** 4 阻断 / 12 高 / 9 低，处置如下：

| 编号 | 发现 | 处置 |
|---|---|---|
| B1 | 侧道牌宽 49 与 49.7788 两套数 | **已修**：全表按侧牌 49×40 重算（sideLaneW = 3×49+2×2 = 151）；§4.1/§4.2/§7.1#9 同口径 |
| B2 | D4 的行数规则与例子自相矛盾（4:3 实为 2 行，不是 3 行），且缺「240/120 都无解」兜底 | **已修**：D4 写成三条优先级（最大且 ≥240s → 最大且 ≥120s → 2）；例子改为 16:9 2 行 / 4:3 2 行（270.5）/ 正方形 4 行 |
| B3 | 示意图的 B 未实现候选退化，16:10/4:3 会溢出可用宽 | **已修**：实现后按最终算法重生成 `b-1334x1000.png`（11 列/2 列、信息格 639.7×270.5），并在交付说明里标注更新 |
| B4 | 信息格 = middleW − 2×sideLaneW 把 P3 的空带搬进板内 | **已修**：`info.width = middleW`（信息格占满中间列），P3 的对应表述成立；§4/§5.1/§5.4/§7.1#5 同步 |
| H1 | 「对手碰杠不改形态」在 16:10 上不成立（最坏假设导致 1 组碰也下移） | **已修**：输入加 `gangMelds`，两翼按实际组型算；16:10 1–2 组走两翼（信息格 204→141），3–4 组才下移（78，登记） |
| H2 | 两翼判定三处未定义（overlap、牌背宽、最坏 vs 实际） | **已修**：D8/D16/D17 写死 overlap=8s、牌背宽=内容宽 527.8、按实际组型、右翼先分 ceil(n/2) |
| H3 | 左右副露用 75×113 竖牌算，与 49×40 资产冲突 | **已修**：左右副露 = 49×40×0.65 = 31.85×26，组宽 103.4s，4 组高 116s |
| H4 | 候选 (12,2) 无覆盖视口 | **已修**：矩阵加 `1334×800`（s=1.067 → (12,2)） |
| H5 | actions/info.left/below 无公式 | **已修**：§5.1 补齐 `rightX/bottomY/offset` 与 `info.left/top`、`below` 的 x/宽；§7.1#16 加断言 |
| H6 | #3/#4/#5/#6 是恒等式，board 宽算错也全绿 | **已修**：§7.1#3 改为用 token 独立重算列宽并逐视口钉 `(mid, side)` |
| H7 | #10 是公式重算、#7 只验下界、#8 未写视口 | **已修**：`infoLevel` 逐视口字面量、容量逐视口字面量、fit 在每视口跑 |
| H8 | n=0 时 `neededRows=0` → 负尺寸让断言假绿 | **已修**：D7 `max(1, ceil())` + `tile.w/h>0`、`fit∈(0,1]` 断言 |
| H9 | D6 的「旧牌不移动」需要改 River 对齐，spec 未列 | **已修**：§5.2 明确 `align-content: start; align-items: flex-start`，§7.2 加源码闸 |
| H10 | 三处副露带互斥/空条/同 key 双渲染未写 | **已修**：新增 D17；§6、§7.2（board 用例） |
| H11 | 漏登 `mahjong-center.test.ts:60-63` 源码闸、`endedText` 用例、`endReason` 死变量、Center props 契约 | **已修**：§7.2/§9 明列；D11 删 `endReason`；§5.2 给 Center props |
| H12 | 听牌 18×27 与 token 20×30 冲突；compact「≥56s」无定义 | **已修**：沿用 20×30；删掉 56s 句 |
| L1–L9 | `.mj-board` 不存在、source 双写、新组件 style 块、full 行长文案挤掉倒计时、右牌背无断言、「五处」计数错、「已胡 N 家」待产品确认、小 W 负矩形、测试夹具未注明 | **已处置**：`mj-info-slot` 契约、`isSource` 单一计算、D14 写明 style 块、§5.4 保留 phase 省略 + clock shrink、§7.1#14 双侧、D17 六处类名、§8 登记、§5.1 `W/H` 回落、§7.1 每条注明夹具 |

**修订后状态：待第二轮复审 / 可进入计划。**
