# 川麻红金 v16：铜钱信息井 + 摸牌位/选中态区分（设计）

状态：已确认（2026-11-08，用户确认预览 `.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.png`）
范围：仅客户端展示层（`MahjongHub.vue`、`MahjongBoard.vue` 手牌/信息井接线与对应测试）。
不动：协议 / 服务端 / 数据库 / admin / 布局几何（`mahjong-layout-v3.ts` 与 v15 牌桌）/ 牌面素材 / 音效 / 胡牌金光。

## 0. 背景

两个可用性问题：

1. 轮次提示太弱：信息井边缘只有 4 个 10px 方位点，且牌墙/倒计时/状态行/徽标分散在盘面各处。
2. 摸牌位与「选中」太像：两者都是「抬升 + 金色」——摸牌位 `translateY(-8u) + 1px 金边`，选中 `translateY(-10u) + 2px 金框`。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 信息井**整体统一 compact**：按 160×160 CSS px 设计，Board 用 `transform: scale(u)` 缩放；布局 `hub.rect` 不变（仅碰撞保证） | 用户 |
| D2 | 中央方孔（66px）= 牌墙数量 + 操作提示；**不显示「牌墙」二字**，原盘面下方状态行并入方孔 | 用户 |
| D3 | 四扇形按 45°/135° 对角线切分（穿过方孔四角），映射上/右/下/左；**轮到者亮 + 显示倒计时；未轮到显示该家「胡/听/缺/托」**；删除边缘点与四角徽标 | 用户 |
| D4 | 徽标胶囊统一 compact 尺寸（11px / `padding 0 5px`） | 用户 |
| D5 | 摸牌位**不抬升**（保留 10u 横向分离）+ 右上 6u 金点；抬升/金框只归「选中」 | 用户确认预览 |
| D6 | 方孔提示最多 5 字 + 省略号（`max-width: 92%`） | 开发方（技术） |
| D7 | `exchange`/`lack` 多块同时亮，各显示同一倒计时；`draw`/`ended` 不亮、无倒计时 | 开发方（沿用现方位点语义） |
| D8 | 金点用**包裹层 + 独立元素**实现，不用伪元素（`MahjongTile` 根是 `<image>`，`::after` 在 H5/App 不可靠） | 开发方（技术风险） |
| D9 | 金色点无动画；不改 `animations.scss` / reduced-motion 清单 | 开发方（YAGNI） |
| D10 | 不动协议/服务端/布局几何/牌面素材/音效；胡牌金光保留 | 范围 |

## 1. 铜钱信息井

视觉基线：`.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.html`（截图同名 `.png`）。

### 1.1 外形与尺寸

- 信息井**整体统一 compact**：组件按 **160×160 CSS px** 设计（方孔 66、牌墙 30、倒计时 18、提示 10、徽标胶囊 11）。
- Board 渲染时：元素固定 `160×160`，按 `left = hub.cx - 80`、`top = hub.cy - 80` 居中；`transform: scale(u)`（`transform-origin: center`）随画布缩放。
  - 布局的 `hub.rect`（160–200）**保持不变**，继续作为碰撞/间距保证；视觉不再撑满它。
- 外环：6px 金边 + 2px 外发丝 + 内阴影 + 径向底（沿用现有红金样式）。

### 1.2 中央方孔

- 66×66，居中；深漆底 `rgba(8,3,3,.84)`、1px 金发丝框、4px 圆角。
- 内容两行：
  - **牌墙数量**：30px / 700 / 金色（`$ftl-color-mj-sheen`），tabular-nums。
  - **操作提示**：10px，`$ftl-color-mj-status`；取 `endedText || statusText`，最多 **5 字** + 省略号（方孔内 `max-width: 92%`）。
- 不再显示「牌墙」二字；原盘面下方的独立状态行删除（并入方孔）。

### 1.3 四个扇形

- 由两条对角线（45°/135°）切分；**对角线正好穿过方孔四角**。
- 映射：**上 = 对家（top）、右 = 右家（right）、下 = 自家（self）、左 = 左家（left）**。
- 每块用一段 90° `conic-gradient` 绘制；起点 1° 亮金线（形成对角线发丝），主体 `rgba(gold, .28)`。
- 待机：整块 `opacity: .4`（≈11% 金），结构常驻可见；激活：`opacity: 1` + 柔和金色。
- 过渡 `opacity .3s`。

### 1.4 扇形文本槽（倒计时 / 徽标轮换）

每个扇形一个固定文本槽：

- 位置（相对 160 井）：上 `top 12%`、下 `bottom 6%`、左 `left 11%`、右 `right 11%`（左右垂直居中）。
- **该座位正在行动（lit）→ 显示倒计时 `Ns`**：18px / 700 / tabular-nums / 米白；自家末 5 秒沿用 `urgent` 红色。
- **未轮到 → 显示该家的单字徽标**：`胡 / 听 / 缺 / 托`，11px 胶囊（`padding 0 5px`、`rgba(28,8,8,.85)` 底、1px 金发丝、8px 圆角）。
- 无徽标 → 空。
- **轮次优先**：lit 时倒计时覆盖徽标。

### 1.5 亮灭规则（沿用现有方位点语义）

- `play` / `claim` / `rob`：亮 `currentPlayer` 所在块。
- `exchange` / `lack`：亮 `activeSeats` 的所有块（可多块同时亮，各显示同一倒计时）。
- 其他（`draw` / `ended` 等）：不亮。

### 1.6 删除与保留

- **删除**：四个边缘 10px 方位点、四角徽标（胡/听/缺/托）及其 CSS。
- **保留**：胡牌金光覆盖层（`flashKey` / `anim-mj-hub-flash`）、`statusText`/`endedText` 的省略逻辑、`seconds`、`activeSeats`、`seats` props 形状。
- `compact` prop 保留兼容，但视觉恒为 compact。

## 2. 摸牌位与选中态

### 2.1 摸牌位（`entry.drawn`）

- **不再抬升、不再金边**。
- 保留右侧额外 10u 间距（`marginLeft: drawnGap - gap`，现状）。
- 牌的右上角显示 **6u 金色圆点**（带柔光）作为「新摸」标记。
  - 实现（D8）：Board 只对 `entry.drawn` 渲染一个包裹层 `<view class="mj__hand-drawn">`（`position: relative`、宽高 = 手牌格、`flex: 0 0 auto`，原 `marginLeft` 移到包裹层），内部放 `MahjongTile` + 金点元素 `<view class="mj__hand-drawn-dot">`（6u 圆点，`top/right: -2u`）。
  - 非摸牌位仍直接渲染 `MahjongTile`，不增加包裹层。
  - 选中时金点随牌一起抬升（选中规则照常作用于内部牌）。
- 无新增动画（静态金点），不需要改 `animations.scss` / reduced-motion 清单。

### 2.2 选中态

- 保持现状：`MahjongTile` 的 `translateY(-10u)` + 2px 金框 + 大阴影；不新增缩放。
- 删除「选中 + 摸牌位」的专门 transform 覆盖规则（摸牌位已无 transform）。

### 2.3 效果

- **抬升/金框只表示「选中」**；「新摸」由右侧分离 + 右上金点表达，两种状态不再共用视觉通道。

## 3. 组件与数据流

- `MahjongHub.vue`
  - `sectors = DIRS.map(...)`：`{ dir, lit, urgent, text, kind: 'clock' | 'badge' }`。
  - 模板：4 个扇形层 + 1 个方孔（牌墙 + 提示）+ 4 个文本槽（外层 `v-for` + 内层 `v-if`）+ 金光层。
  - 删除 `.mj-hub__dot*`、`.mj-hub__badge*`、`.mj-hub__status`、`.mj-hub__wall-label`；新增 `.mj-hub__sector*`、`.mj-hub__slot*`、`.mj-hub__hole`、`.mj-hub__hint`。
- `MahjongBoard.vue`
  - 信息井 style 改 `hubStyle`（160×160 居中于 `hub.cx/cy` + `scale(u)`）。
  - 手牌：`entry.drawn` 走包裹层（D8）；选中/点击/长按事件仍挂在 `MahjongTile` 上。
  - Board 测试里的 `.mj-hub__status` 选择器改为 `.mj-hub__hint`（3 处）。
- props 不变，Board 的其他数据流（`hubSeats` 的胡>听>缺>托优先级）不变。

## 4. 测试

- `mahjong-hub.test.ts`（重写相关用例）：
  - 4 个扇形存在；`play` 亮 `currentPlayer`；`exchange/lack` 亮 `activeSeats`；`ended/draw` 全灭。
  - lit 槽显示 `Ns`，未 lit 槽显示对应徽标；lit 时徽标被覆盖（不渲染）。
  - 方孔内为牌墙数量 + 操作提示；无「牌墙」标签、无边缘点、无四角徽标。
  - 自家末 5 秒 `urgent` 类只出现在自家槽。
  - 源码闸：160/66/30/18/11 尺寸、扇形 conic-gradient、删除旧选择器。
- `mahjong-board.test.ts`：信息井 160×160 + `scale(u)`；摸牌位包裹层/金点存在；Board 的 `.mj-hub__status` 断言改 `.mj-hub__hint`；新增源码闸（摸牌位规则无 transform/outline，金点元素样式存在）。
- `mahjong-skin.test.ts` / `mahjong-hub` 相关 token 断言按新类名更新。

## 5. 错误处理与边界

- 无 `view` / 无 `seats`：扇形全灭、槽全空；方孔显示 `0` 与空提示。
- `seconds <= 0`：lit 时显示 `0s`（不隐藏）；`urgent` 仅在 `1..5s`。
- 状态文本超长：5 字 + 省略号；`endedText` 优先于 `statusText`（沿用）。
- 未知方向 / 无座位映射：该块永不亮（沿用现状）。
- 未轮到且无徽标：槽为空，不占视觉。
- 多块同时亮（exchange/lack）：每块显示同一 `seconds`，不存在主次。
- 胡牌金光播放期间：文本/方孔仍在金光层之上（金光 `pointer-events: none`）。
- `u` 非法：布局函数已回落 `u=1`；Board 直接使用布局值。

## 6. 风险

- `transform: scale(u)` 在非整数 `u`（如 1.2/1.5）下文字可能轻微模糊（webview 标准行为，接受）。
- 信息井视觉 160 < 布局矩形（最多 200）：中央留白增多；碰撞检查仍按大矩形，**安全侧**。
- `mahjong-hub.test.ts` 大量源码闸断言旧位置/小点/徽标，需同步重写；漏改会出现假绿。
- 手牌包裹层改变 flex 子项结构：必须保持宽高/`flex: 0 0 auto` 与原一致，否则手牌间距漂移（测试钉住）。
- 扇形金色在深色绒面上的可读性依赖真机亮度；先用预览基线，真机走查兜底。
- `conic-gradient` 依赖 WebView 内核（Chrome 69+ / X5 现代版）；本项目目标 H5+App 均满足，若极老内核出现退化则退化为四块 `clip-path` 绝对定位层（不改数据流）。
- `claim`/`rob` 阶段沿用现有 `currentPlayer`（弃牌者）亮块语义，与「响应者」可能不同；本版不改该语义（若产品要改为响应者，需协议侧提供明确字段）。

## 7. 涉及文件

- `apps/client/src/components/table/mahjong/MahjongHub.vue`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/test/mahjong-hub.test.ts`
- `apps/client/test/mahjong-board.test.ts`
- `apps/client/test/mahjong-skin.test.ts`（仅当断言受类名/尺寸影响）

## 8. 验收

- 真浏览器（H5）对照预览：四状态（上家 / 自家末 5 秒 / 无人 / compact）一致。
- 真机走查：扇形可读性、方孔提示不溢出、金点可见、选中与摸牌位一眼可分。

## 9. 已知取舍

- 信息井视觉固定 160（不再随布局 160–200 变化）：小屏下更紧凑，大屏下显得更轻；布局碰撞面不变。
- 方孔提示最多 5 字：超长状态（如「等待其他玩家出牌」）会省略；完整语义仍由动作区/牌河表达。
- 徽标从盘缘移入扇形后，四个徽标与倒计时共用槽位：lit 时徽标暂时不可见（设计如此）。

## 10. 审查记录

（待设计对抗审查后填写）
