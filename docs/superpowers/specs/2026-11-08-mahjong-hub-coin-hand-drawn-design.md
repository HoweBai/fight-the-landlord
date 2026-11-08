# 川麻红金 v16：铜钱信息井 + 摸牌位/选中态区分（设计）

状态：已确认（2026-11-08，用户确认预览 `.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.png`）；已过一轮对抗审查（见 §10）。
范围：仅客户端展示层（`MahjongHub.vue`、`MahjongBoard.vue` 手牌/信息井接线与对应测试）。
不动：协议 / 服务端 / 数据库 / admin / 布局几何（`mahjong-layout-v3.ts` 与 v15 牌桌）/ 牌面素材 / 音效 / 胡牌金光。

## 0. 背景

两个可用性问题：

1. 轮次提示太弱：信息井边缘只有 4 个 10px 方位点，且牌墙/倒计时/状态行/徽标分散在盘面各处。
2. 摸牌位与「选中」太像：两者都是「抬升 + 金色」——摸牌位 `translateY(-8u) + 1px 金边`，选中 `translateY(-10u) + 2px 金框`。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 信息井**整体统一 compact**：按 **160×160 设计 px** 渲染；布局 `hub.rect`（160–200）不变（仅碰撞保证）。full-bleed 画布模型下 `layout.u ≡ 1`，Board 仍带 `scale(u)` 作防御，但验收/测试以 160 与居中断言 | 用户 + 审查修正 |
| D2 | 中央方孔（66px）= 牌墙数量 + 操作提示；**不显示「牌墙」二字**；原盘面状态行并入方孔 | 用户 |
| D3 | 四扇形按 45°/135° 对角线切分（穿过方孔四角），映射上/右/下/左；**轮到者亮 + 显示倒计时；未轮到显示该家「胡/听/缺/托」**；删除边缘点与四角徽标 | 用户 |
| D4 | 徽标胶囊统一 compact 尺寸（11px / `padding 0 5px`） | 用户 |
| D5 | 摸牌位**不抬升**（保留 10u 横向分离）+ 右上 **8u** 金点；抬升/金框只归「选中」 | 用户确认预览 |
| D6 | 方孔提示最多 **5 字 + 省略号**，`max-width: 100%`（方孔内容宽 62px；5×10 + 省略号 ≈60px，留 2px）；Board 两处文案压到上限内：`已胡${n}家`（4 字）、`选同花3张`（5 字） | 开发方 + 审查修正 |
| D7 | `exchange`/`lack` 多块同时亮，各显示同一倒计时；`draw`/`ended` 不亮、无倒计时 | 开发方（沿用现方位点语义） |
| D8 | 金点用**包裹层 + 独立元素**实现，不用伪元素（`MahjongTile` 根是 `<image>`，`::after` 在 H5/App 不可靠）；**金点通过兄弟选择器跟随选中抬升**，包裹层承接 z-index | 开发方 + 审查修正 |
| D9 | 金色点无动画；不改 `animations.scss` / reduced-motion 清单；**保留** `anim-mj-urgent`（见 D13） | 开发方 |
| D10 | 不动协议/服务端/布局几何/牌面素材/音效；胡牌金光保留 | 范围 |
| D11 | **删除** `compact` prop 与 `.mj-hub--compact` 类（视觉恒 compact）；Board 的 `:compact` 绑定一并删除 | 开发方 + 审查修正 |
| D12 | 所有发丝线一律 `$ftl-hairline`（2px，R714）；mockup 里的 1px 只是预览近似 | 仓库纪律 R714 |
| D13 | 自家倒计时保留 `anim-mj-urgent`（3×0.8s 有限脉动）；上/下槽用「左右拉伸 + `text-align:center`」不挂 transform，左/右槽才用 translate——urgent 只出现在自家（下）槽，不与静态 transform 冲突 | 仓库硬闸 `animations.test.ts:452` + 审查修正 |

## 1. 铜钱信息井

视觉基线：`.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.html`（截图同名 `.png`）。

### 1.1 外形与尺寸

- 组件按 **160×160 CSS px** 设计（方孔 66、牌墙 30、倒计时 18、提示 10、徽标胶囊 11）。
- Board 渲染：`hubStyle = { position: 'absolute', left: hub.cx - 80, top: hub.cy - 80, width: 160, height: 160, transform: 'scale(u)', transformOrigin: 'center' }`。
  - **必须自带 `position: absolute`**（`rectStyle()` 原本顺带提供；Hub 根 CSS 是 `position: relative`）。
  - full-bleed 模型（`useLandscapeCanvas.ts`）保证 `u ≡ 1`；`scale(u)` 仅防御。
  - 布局 `hub.rect`（160–200）保持不变，继续作为碰撞/间距保证。
- 外环：6px 金边 + `$ftl-hairline` 外发丝 + 内阴影 + 径向底（沿用现有红金样式）。

### 1.2 中央方孔

- 66×66（border-box），居中；深漆底 `rgba($ftl-color-mj-lacquer, .84)`、`$ftl-hairline` 金框、4px 圆角。
  - 内容宽 = 66 − 2×2 = **62px**。
- 内容两行：
  - **牌墙数量**：30px / 700 / `$ftl-color-mj-sheen`，tabular-nums（`Math.max(0, wallCount)`）。
  - **操作提示**：10px，`$ftl-color-mj-status`；取 `endedText || statusText`；`max-width: 100%`；按码点最多 **5 字** + 省略号（5×10+≈10 = 60 ≤ 62）。
- 不再显示「牌墙」二字；原状态行删除（并入方孔）。
- Board 文案调整（D6）：`已胡 ${endReason} 家` → `已胡${endReason}家`；`选同花色3张` → `选同花3张`。

### 1.3 四个扇形

- 由两条对角线（45°/135°）切分；**对角线正好穿过方孔四角**（居中方孔 66 ⇒ 四角 ±33，落在对角线上）。
- 映射：**上 = 对家（top）、右 = 右家（right）、下 = 自家（self）、左 = 左家（left）**。
- 每块用一段 90° `conic-gradient` 绘制，主体 `rgba($ftl-color-mj-gold, .28)`；**不在扇形内画边界线**。
- 两条对角线用**独立发丝层**（与预览一致）：2 条 `$ftl-hairline` 线、`rgba($ftl-color-mj-gold, .16)`、旋转 ±45°，不随扇形 dim。
- 待机：扇形 `opacity: .4`（≈11% 金）；激活：`opacity: 1` + 柔和金色；过渡 `opacity .3s`。

### 1.4 扇形文本槽（倒计时 / 徽标轮换）

每个扇形一个固定文本槽。**百分比相对内容盒 148×148**（160 − 2×6 border）：

- 位置：上 `top 12%`、下 `bottom 6%`、左 `left 11%`、右 `right 11%`（左右垂直居中）。
- **定位写法（D13）**：上/下槽 `left: 0; right: 0; text-align: center`（**无 transform**）；左/右槽 `transform: translate(∓50%, -50%)`。
- **该座位正在行动（lit）→ 显示倒计时 `Ns`**：18px / 700 / tabular-nums / `$ftl-color-mj-cream`；`Math.max(0, seconds)`。
- **未轮到 → 显示该家的单字徽标**：`胡 / 听 / 缺 / 托`，11px 胶囊（`padding 0 5px`、`rgba($ftl-color-mj-lacquer, .85)` 底、`$ftl-hairline` 金框、8px 圆角）。
- 无徽标 → 空；**轮次优先**：lit 时倒计时覆盖徽标。
- 自家末 5 秒：槽加 `mj-hub__slot--urgent`（红色）+ `anim-mj-urgent`；只出现在下槽（无静态 transform）。

### 1.5 亮灭规则（沿用现有方位点语义）

- `play` / `claim` / `rob`：亮 `currentPlayer` 所在块。
- `exchange` / `lack`：亮 `activeSeats` 的所有块（可多块同时亮，各显示同一倒计时）。
- 其他（`draw` / `ended` 等）：不亮。

### 1.6 删除与保留

- **删除**：四个边缘 10px 方位点、四角徽标（胡/听/缺/托）及其 CSS、`compact` prop、`.mj-hub--compact` 类、`.mj-hub__status`、`.mj-hub__wall-label`。
- **保留**：胡牌金光覆盖层（`flashKey` / `anim-mj-hub-flash`）、`statusText`/`endedText`（并入方孔提示）、`seconds`、`activeSeats`、`seats` props 形状。
- 新类：`.mj-hub__sector*`、`.mj-hub__slot*`、`.mj-hub__hole`、`.mj-hub__hint`、`.mj-hub__diag*`。

## 2. 摸牌位与选中态

### 2.1 摸牌位（`entry.drawn`）

- **不再抬升、不再金边**。
- 保留右侧额外 10u 间距（`marginLeft: drawnGap - gap`，从牌移到包裹层）。
- 牌右上角显示 **8u 金色圆点**（`pointer-events: none`，带柔光）作为「新摸」标记。
- 实现（D8）：
  - Board 只对 `entry.drawn` 渲染包裹层 `<view class="mj__hand-drawn">`（`position: relative`、宽高 = 手牌格、`flex: 0 0 auto`），内部放 `MahjongTile` + `<view class="mj__hand-drawn-dot">`（8u 圆点、`top/right: -2u`、`pointer-events: none`）。
  - **金点跟随选中抬升**：兄弟规则
    `.mj__hand :deep(.mj-tile--selected) + .mj__hand-drawn-dot { transform: translateY(calc(-1 * var(--mj-tile-lift, 10px))); }`
  - **z-index 迁移**：包裹层按 `selected.includes(i)` 加 `mj__hand-drawn--selected` 类，规则 `.mj__hand-drawn--selected { z-index: 10; }`（image 不再是 flex 子项，原 `.mj-tile--selected { z-index: 10 }` 失效）。
  - 非摸牌位仍直接渲染 `MahjongTile`；两分支共享同一组绑定（`:selected/:disabled/:class/:style/@click/@longpress`），`:key` 上移。
- 无新增动画（静态金点），不改 `animations.scss`。

### 2.2 选中态

- 保持现状：`MahjongTile` 的 `translateY(-10u)` + 2px 金框 + 大阴影；不新增缩放。
- 删除「选中 + 摸牌位」的专门 transform 覆盖规则（摸牌位已无 transform）。

### 2.3 效果

- **抬升/金框只表示「选中」**；「新摸」由右侧分离 + 右上金点表达，两种状态不再共用视觉通道。

## 3. 组件与数据流

- `MahjongHub.vue`
  - `sectors = DIRS.map(...)`：`{ dir, lit, urgent, text, kind: 'clock' | 'badge' }`。
  - 模板：4 个扇形层 + 2 条对角线发丝 + 1 个方孔（牌墙 + 提示）+ 4 个文本槽（外层 `v-for` + 内层 `v-if`）+ 金光层。
  - 删除 `compact` prop / `.mj-hub--compact` / dots / badges / status / wall-label。
- `MahjongBoard.vue`
  - 信息井 style 改 `hubStyle`（§1.1，含 `position:absolute` 与 `transform-origin:center`）；删除 `:compact` 绑定。
  - 手牌：`entry.drawn` 走包裹层 + 金点（§2.1）；事件仍挂在 `MahjongTile` 上。
  - Board 测试里的 `.mj-hub__status` 选择器改 `.mj-hub__hint`（3 处）。
  - `statusText` 两处文案压缩（D6）。
- props 其余不变；Board 的 `hubSeats` 胡>听>缺>托优先级不变；哑终端纪律不变（只做展示映射）。

## 4. 测试

### 4.1 `mahjong-hub.test.ts`（重写相关用例）

- 4 个扇形存在；`play` 亮 `currentPlayer`；`exchange/lack` 亮 `activeSeats`（多块）且**每块渲染同一 `seconds`**；`ended/draw` 全灭。
- lit 槽显示 `Ns`，未 lit 槽显示对应徽标；lit 时徽标不渲染；`seconds=0` 显示 `0s`。
- 方孔内为牌墙数量 + 操作提示；无「牌墙」标签、无边缘点、无四角徽标；`endedText` 优先于 `statusText`（保留现有覆盖）。
- 无 `seats` / 缺某 `dir`：该块不亮、槽空。
- 自家末 5 秒：`mj-hub__slot--urgent` + `anim-mj-urgent` 只在自家槽。
- 源码闸（剥注释后扫描）：方孔 66 / 牌墙 30 / 倒计时 18 / 胶囊 11 / `$ftl-hairline`（禁止裸 `1px`）/ 扇形 conic-gradient / 旧选择器已删除。
- `animations.test.ts` 原样通过（Hub 仍引用 `anim-mj-urgent`）。

### 4.2 `mahjong-board.test.ts`

- 信息井：`hubStyle` 含 `position:absolute`、160×160、居中于 `hub.cx/cy`、`transform: scale(1)`；**160 的源码闸放这里**。
- 摸牌位：包裹层 `.mj__hand-drawn` 存在、金点元素存在、`margin-left:10px` 在包裹层上；牌上仍挂 `.mj__hand-tile--drawn` 标记（计数断言保留）。
- 行为：摸牌位可单击选中、双击出牌（补现有只覆盖非摸牌位的缺口）。
- 源码闸（剥注释）：`.mj__hand-drawn` 自身无 transform/outline；金点 `pointer-events:none`；兄弟选择器抬升规则存在；`.mj__hand-drawn--selected { z-index: 10 }`。
- 旧断言迁移：删除 `.mj__hand-tile--drawn` 规则里要求 transform/outline 的两条负向/正向闸（原 `:1514-1533`）；`.mj-hub__status` → `.mj-hub__hint`；`已胡 2 家` → `已胡2家`（2 处）。
- `mahjong-skin.test.ts` 只扫颜色：新色值统一走 `$ftl-color-mj-*`，若现有扫描覆盖新增颜色则同步；类名不需要它更新。

## 5. 错误处理与边界

- 无 `view` / 无 `seats`：扇形全灭、槽全空；方孔显示 `0` 与空提示。
- `seconds <= 0`：lit 时显示 `0s`（`Math.max(0, seconds)`）；`urgent` 仅在 `1..5s`。
- 状态文本超长：5 字 + 省略号；`endedText` 优先于 `statusText`（沿用）。
- 未知方向 / 无座位映射：该块永不亮（沿用现状）。
- 未轮到且无徽标：槽为空，不占视觉。
- 多块同时亮（exchange/lack）：每块显示同一 `seconds`，不存在主次。
- 胡牌金光播放期间：文本/方孔仍在金光层之上（金光 `pointer-events: none`）。
- `u` 非法：布局函数已回落 `u=1`；Board 直接使用布局值。

## 6. 风险

- 信息井视觉 160 < 布局矩形（最多 200）：中央留白增多；碰撞检查仍按大矩形，**安全侧**。
- `mahjong-hub.test.ts` 大量源码闸断言旧位置/小点/徽标，需同步重写；漏改会出现假绿（源码闸统一剥注释视图）。
- 手牌包裹层改变 flex 子项结构：必须保持宽高/`flex: 0 0 auto` 与原一致，否则手牌间距漂移（测试钉住）；两分支绑定重复易漏 `selected`（补摸牌位选择/出牌行为测试）。
- 扇形金色在深色绒面上的可读性依赖真机亮度；先用预览基线，真机走查兜底。
- `conic-gradient` 依赖 WebView 内核：**接受最低 Chrome 69+ / Android 9+**；`clip-path` 的兼容面反而更窄，不作兜底；真失效时轮次仍有座位牌 active 态兜底。
- `claim`/`rob` 阶段沿用现有 `currentPlayer`（弃牌者）亮块语义，与「响应者」可能不同；本版不改该语义（若产品要改为响应者，需协议侧提供明确字段）。
- lit 时徽标暂时隐藏；`MahjongSeatChip` 角标仍有胡/听/缺/托副本，不构成信息丢失。

## 7. 涉及文件

- `apps/client/src/components/table/mahjong/MahjongHub.vue`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/test/mahjong-hub.test.ts`
- `apps/client/test/mahjong-board.test.ts`
- `apps/client/test/mahjong-skin.test.ts`（仅当颜色扫描受影响）
- `apps/client/test/animations.test.ts`（预期原样通过，回归确认）

## 8. 验收

- 真浏览器（H5）对照预览：三状态（上家 / 自家末 5 秒 / 无人行动）一致；**5 字提示（`选同花3张`）不溢出**。
- 真机走查：扇形可读性、方孔提示不溢出、金点可见、金点随选中抬升、选中与摸牌位一眼可分。

## 9. 已知取舍

- 信息井视觉固定 160（不再随布局 160–200 变化）：小屏下更紧凑，大屏下显得更轻；布局碰撞面不变。
- 方孔提示最多 5 字：超长状态会省略；完整语义仍由动作区/牌河表达。
- 徽标从盘缘移入扇形后，四个徽标与倒计时共用槽位：lit 时徽标暂时不可见（设计如此）。

## 10. 审查记录

2026-11-08 按 `docs/dev-process.md` §3 做独立对抗审查（sonnet，只读）。核对面：160/66/30/18/11 与 12%/6%/11%/100% 在 border-box（内容盒 148 / 方孔内容 62）下的落点；`scale(u)` 与 `useLandscapeCanvas` full-bleed 模型（`u ≡ 1`）；四扇形 conic 层、方孔、文本槽、金光的层叠；lit 语义与多座/空座/`seconds` 边界；`MahjongTile` 根为 `<image>` 时金点的 DOM/CSS 可行性；mahjong-hub / mahjong-board / mahjong-skin / animations 四套既有测试契约。

结论：**1 阻断 + 5 高 + 13 低**，均已修订：
- 阻断：金点与选中抬升是兄弟节点 ⇒ 补兄弟选择器让金点随抬升，并把 z-index 迁到包裹层（D8/§2.1）。
- 高：① 5 字 + 省略号在 92% 宽内放不下 ⇒ `max-width:100%`（62px）；② 5 字上限会截断 `已胡 N 家` / `选同花色3张` ⇒ Board 文案压缩为 4/5 字；③ 1px 发丝违反 R714 且撞裸 1px 硬闸 ⇒ 全部改 `$ftl-hairline`；④ `anim-mj-urgent` 是 animations 硬闸要求 ⇒ 保留并钉死槽位写法（D13）；⑤ 摸牌位旧断言迁移清单缺失且与「无 transform」闸冲突 ⇒ §4.2 给出迁移表并限定闸的扫描对象。
- 低（登记并处理）：`scale(u)≡scale(1)` 改述为防御；百分比按内容盒 148 解析；urgent 的 transform 覆盖陷阱用上/下槽无 transform 规避；conic-gradient 退路改为接受最低内核（clip-path 更窄）；新色值改走 `$ftl-*` 令牌；删除 `compact` prop/类；160 源码闸放 Board；补无 seats/缺 dir、`0s`、多块同一秒数、摸牌位双击出牌等测试；`hubStyle` 自带 `position:absolute`；两分支共享绑定。
- 哑终端/反作弊：无新增风险（lit 只由 `phase/currentPlayer/activeSeats` 做展示映射，不推导牌局规则；胡/听/缺/托仍由 Board 计算）。协议/服务端/布局几何均无需改动。

审查后 spec 已按上述修订；下一阶段进入实现计划（writing-plans）。
