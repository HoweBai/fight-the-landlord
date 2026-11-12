# 川麻红金 v17：动作区单行化（设计）

状态：已确认（2026-11-12，用户选方案 A：紧凑单行）。
范围：仅客户端展示层（`MahjongActionBar.vue`、`MahjongBoard.vue` 动作区接线与测试）。
不动：协议 / 服务端 / 数据库 / admin / 布局几何（`mahjong-layout-v3.ts` 与 v15/v16 牌桌）/ 牌面素材 / 音效。

## 0. 背景

动作区当前是 **176×176 的严格 2×2 网格**（84px 格 + 8px gap）：play 的 胡/杠/过/出牌、claim 的碰/杠/胡/过、lack 的三花色、exchange 的换三张都按两行排。用户希望改成**单行**，减少视觉块面积、更接近主流麻将的底部操作带。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 四种模式（play / claim / exchange / lack）**统一单行** | 用户确认 |
| D2 | 条形右缘 = 旧动作区 `actions.right`，底边 = `actions.bottom`（手牌顶上方 16px），高 **64** | 开发方 |
| D3 | 按钮宽度随数量：1→176、2→2×102、3→3×66、4→4×50；gap **6**；最大总宽 **218** | 开发方（几何约束） |
| D4 | play 顺序：胡 / 杠 / 过 / 出牌（出牌固定最右、主按钮）；claim：服务端选项顺序 + 过固定最右 | 开发方 |
| D5 | rob 胡按钮：**20×30 待响应牌在上 + 「胡」在下**；不再显示「胡 5万」文字 | 用户确认 |
| D6 | 多杠：「杠」+ 右上小数字；点开选择面板在**条形上方**弹出（宽 218、2 列 wrap），不占行 | 用户确认 |
| D7 | exchange：一行 =「已选 x/3」提示 + 换三张按钮（70 + 6 + 140 = 216） | 开发方 |
| D8 | lack：万/筒/条 3×66，「推荐」小字仍在按钮内 | 开发方 |
| D9 | 视觉皮肤不变：漆底/描金/主按钮渐变/过幽灵/推荐圈/3D 底边/claim 呼吸/滑入动画 | 范围 |
| D10 | 尺寸用 `calc(Npx * var(--mj-u))` 随画布缩放；右/底锚点由 Board 用 `layout.actions` 计算 | 开发方 |
| D11 | 布局 `actions` 矩形（176×176）**保留**作碰撞保证，视觉不再填满 | 范围 |
| D12 | 不动协议/服务端/布局/素材 | 范围 |

## 1. 几何

- Board 不再用 `rectStyle(layout.actions)`；改为 `actionBarStyle`：
  ```ts
  position: absolute;
  right: calc(canvasW - actions.right) px;
  bottom: calc(canvasH - actions.bottom) px;
  height: calc(64px * var(--mj-u))?  // 组件内 CSS 负责
  z-index: 3;
  ```
  实际由 Board 输出 `right`/`bottom`/`z-index`/`position`；组件内 CSS 用 `calc(64px * var(--mj-u))` 定高。
- 组件根 `.mj-action-bar`：`display:flex; align-items:stretch; gap: calc(6px * var(--mj-u)); width: fit-content;`（绝对定位 + right/bottom + fit-content 收缩）。
- 最大宽度 218（4×50+3×6）。最坏态（上/下河 ≥17 张 + 有副露）：`actions.right = 1243.26`，条左缘 1025.26；右侧河右缘 1019.01 ⇒ **留 6.25px，不遮挡**。正常态右缘 1283.66，余量 46.25px。
- 高 64 的条：y 550–614（底边与旧动作区一致）；侧河底 565.84，x 方向已避开。
- 布局 `actions` 矩形保留在 `mahjong-layout-v3`（碰撞检查不变）。

## 2. 各模式

### 2.1 play

- 顺序：胡 / 杠 / 过 / 出牌（出牌最右）。
- 按钮数 = 1（出牌）+ 有胡 + 有杠 + showPass；宽度按 D3。
- 出牌按钮 `--primary`；胡 `--primary`；杠描金；过幽灵。
- 多杠按钮：「杠」+ 右上小数字（`gangOptions.length`）。

### 2.2 claim

- 顺序：`claimOptions`（服务端顺序；碰/杠/胡）+ 过（固定最右，若 `showPass`）。
- 胡按钮：`--primary`；rob 时按钮内 **20×30 牌面在上、「胡」在下**；无牌面时只有「胡」。
- 所有按钮挂 `anim-claim-pulse`（保留）。
- 4 个动作时 4×50；3 个时 3×66；2 个时 2×102。

### 2.3 exchange

- 一行：`已选 x/3`（宽 70，`$ftl-font-sm`，右对齐）+ 换三张按钮（140×64，`--primary`）。
- 总宽 216。

### 2.4 lack

- 万/筒/条 3×66×64；「推荐」小字在按钮内（主字 22 + 副字 10，gap 2）。

## 3. 多杠选择面板

- 点击「杠 + 数字」切换 `gangOpen`。
- 面板：`position: absolute; right: 0; bottom: calc(100% + 8px); width: 218px; display: flex; flex-wrap: wrap; gap: 6px;`
- 面板项：高 48、宽度自适应（2 列），漆底金边，文案为牌型（如 `5万`）。
- 面板顶部最高到 y≈440（2 行），右缘 1243.26，左缘 1025.26 > 侧河右缘 1019.01 ⇒ 不遮挡；信息井右缘 767 也远离。
- 面板不占条形布局高度（绝对定位）。

## 4. 组件/接口

- `ActionBarMode` / `ActionBarAction` 不变；props 不变（mode/options/showPass/busy/selectedCount/recommendedSuit）。
- 模板：移除 `.mj-action-bar__grid` 中间层，按钮直接作为根 flex 子项；新增 `.mj-action-bar__row` 语义不需要（根即行）。
- 按钮尺寸由组件内 computed `btnW` 按“当前渲染按钮数”给出；每个按钮 inline `width/height` 为 `calc(... * var(--mj-u))`。
- Board：`actionsStyle` → `actionBarStyle`（右/底锚点 + z-index 3），仍只在 `hasActions` 时渲染 ActionBar。
- 皮肤类名/动画类名保持不变。

## 5. 测试

- `mahjong-action-bar.test.ts`（重写布局断言）：
  - claim 4：一行 4 键，宽 50、高 64（calc 形式）、gap 6；无 `grid-column/grid-row`；不是 2×2。
  - play 1/2/3/4 → 176/102/66/50；出牌始终最右。
  - claim 顺序：选项顺序 + 过最右；rob 胡：20×30 牌面 + 文本「胡」（不是「胡 5万」）。
  - 多杠：按钮文本「杠」+ 数字；面板在条形上方（style 含 `bottom: calc(100% + 8px)`、`width: 218px`、`flex-wrap: wrap`），不占行。
  - exchange：提示 + 按钮同一行；lack：3×66 + 推荐。
  - 动画：claim pulse、slide-in 保留；禁用态/emit 不变。
- `mahjong-board.test.ts`：
  - `.mj-action-bar` 的 style 含 `position:absolute`、`right: 50.34px`、`bottom: 136px`、`z-index: 3`（1334×750 normal）；不再含 `width:176px`/`left:`。
  - 有副露态：`right: 90.74px`、`bottom: 136px`。
- `mahjong-skin.test.ts` / `animations.test.ts` 预期原样通过。

## 6. 错误处理与边界

- 0 个动作：`hasActions=false`，ActionBar 不渲染（沿用）。
- 1 个动作：176 宽（出牌/换三张/单杠）。
- 2/3/4 个动作：宽度按 D3；`busy` 禁用态不变。
- 多杠 2–4 项：面板 2 列 wrap，最高 2 行（2×48+6=102），不越界。
- 长文案：claim 胡不再带牌名；多杠数字 ≤4；「出牌」「换三张」按 22px 主字排版（3 字按钮 140 宽）。
- `u` 非法：布局回落 u=1；尺寸 calc 使用同一变量。

## 7. 风险

- 条形宽度/右锚点依赖 `actions.right` 的 2 位取整；最坏余量 6.25px，若布局改动需重算。
- 50px 宽按钮 + 22px 主字：「出牌」2 字 44px + 边框 4px = 48 ≤50，余量小；真机走查确认。
- rob 胡按钮：20×30 牌面 + 22px 文本 + gap 2 = 54 ≤64（高度）。
- `width: fit-content` 依赖 Chrome 87+（仓库既有基线）。
- 多杠面板绝对定位在条形上方，需 `z-index` 高于牌河；沿用根 z-index 3。
- 布局 `actions` 矩形保留但视觉空出上半部分，属预期。

## 8. 涉及文件

- `apps/client/src/components/table/mahjong/MahjongActionBar.vue`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（动作区 style）
- `apps/client/test/mahjong-action-bar.test.ts`
- `apps/client/test/mahjong-board.test.ts`

## 9. 审查记录

（待设计对抗审查后填写）
