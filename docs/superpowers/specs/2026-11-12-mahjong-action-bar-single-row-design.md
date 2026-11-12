# 川麻红金 v17：动作区单行化（设计）

状态：已确认（2026-11-12，用户选方案 A：紧凑单行）；已过一轮对抗审查（见 §9）。
范围：仅客户端展示层（`MahjongActionBar.vue`、`MahjongBoard.vue` 动作区接线与测试）。
不动：协议 / 服务端 / 数据库 / admin / 布局几何（`mahjong-layout-v3.ts` 与 v15/v16 牌桌）/ 牌面素材 / 音效。

## 0. 背景

动作区当前是 **176×176 的严格 2×2 网格**（84px 格 + 8px gap）：play 的 胡/杠/过/出牌、claim 的碰/杠/胡/过、lack 的三花色、exchange 的换三张都按两行排。用户希望改成**单行**，减少视觉块面积、更接近主流麻将的底部操作带。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 四种模式（play / claim / exchange / lack）**统一单行** | 用户确认 |
| D2 | 条形右缘 = 旧动作区 `actions.right`，底边 = `actions.bottom`（手牌顶上方 16px），高 **64** | 开发方 |
| D3 | 按钮宽按**模式+数量**：play 1→176 / 2→102 / 3→66；claim 1→102 / 2→102 / 3→66 / 4→50；lack 3→66；exchange 1→140。gap **6**；根宽 = n×w + (n−1)×6；**最大 218**（claim-4） | 开发方 + 审查修正 |
| D4 | play 顺序：胡 / 杠 / 过 / 出牌（出牌固定最右、主按钮）；claim：服务端选项顺序 + 过固定最右 | 开发方 |
| D5 | claim 的胡按钮（**所有 claim 胡 option 都带 tile**，不止 rob）：**20×30 牌面在上 + 「胡」在下**，不再显示「胡 5万」；play 的自摸胡**不渲染牌面**（`mode==='claim' && opt.tile`） | 用户确认 + 审查修正 |
| D6 | 多杠：「杠」+ **下方小数字**（`$ftl-font-xs`，同「推荐」模式，不用绝对角标）；点开选择面板在**条形上方**弹出（宽 218、显式 2 列），不占行；仅 play 可达 | 用户确认 + 审查修正 |
| D7 | exchange：**单个按钮**「换三张」+ 副字「已选 x/3」（`$ftl-font-xs`），按钮宽 140；不再有独立 hint 元素 | 审查修正（70px 放不下 26px 字体） |
| D8 | lack：万/筒/条 3×66；「推荐」副字用 `$ftl-font-xs`（**22px 令牌**，不用 10px） | 审查修正 |
| D9 | 视觉皮肤不变：漆底/描金/主按钮渐变/过幽灵/推荐圈/3D 底边/claim 呼吸/滑入动画；**主字 24px 保持**（皮肤测试钉死），副字 22px（`$ftl-font-xs`）；按钮 `line-height: 1` | 审查修正 |
| D10 | 尺寸一律 `calc(Npx * var(--mj-u, 1))`；根宽由组件按 D3 显式给出（不依赖 `fit-content`）；右/底锚点由 Board 用 `layout.actions` 计算 | 开发方 + 审查修正 |
| D11 | 布局 `actions` 矩形（176×176）保留，但**不构成 218 宽条的守护**；新增布局测试钉住最坏态几何（见 §5） | 审查修正 |
| D12 | 不动协议/服务端/布局代码/素材 | 范围 |

## 1. 几何

- Board 不再用 `rectStyle(layout.actions)`；改为 `actionBarStyle`：
  ```ts
  position: absolute;
  right: (canvasW - actions.right) px;
  bottom: (canvasH - actions.bottom) px;
  z-index: 3;
  ```
- 组件根 `.mj-action-bar`：`display:flex; align-items:stretch; gap: calc(6px * var(--mj-u, 1));`，宽度由组件 inline `width: calc(rowW px * var(--mj-u, 1))` 给出（rowW = n×w + (n−1)×6）。
- 最大根宽 218（claim-4）。最坏态（左/右任一副露 + 上或下河 ≥17）：`zoneW=74.7413` → `actions.right=1243.2587`；12 列上/下河右缘 901.0089 → 侧河块 x=905.0089、宽 114 → 右缘 **1019.0089**；条左缘 1243.2587−218=**1025.2587** ⇒ **余量 6.2498px**。正常态：1283.6587−218−1019.0089 = **46.6498px**。
- 纵向：条 y=550–614（高 64，底边同旧动作区）；侧河底 565.84 ⇒ 有 **15.84px 纵向重叠带**，所以 6.25px 水平余量是**唯一护栏**，宽度不得增长。
- 右侧副露 lane 左缘 1247.26，条右缘 1243.26 ⇒ 仅 4px；claim 呼吸 scale(1.05) 在 50px 键上再外扩 1.25px，仍有 ~2.75px。
- 信息井 v16 视觉右缘 = hub.cx + 80 = **747**（不是布局矩形右缘 767）；条/面板均远离。
- 布局 `actions` 矩形保留在 `mahjong-layout-v3`（旧碰撞检查不变），但 218 宽条向左超出矩形 42px，布局 checks 不覆盖（D11）。

## 2. 各模式

### 2.1 play（按钮数 1–3；pass 只在 claim 产生，多杠合并为一个按钮）

- 顺序：胡 / 杠 / 过 / 出牌（出牌最右）。
- 宽度：1→176（出牌）、2→102、3→66。
- 出牌 `--primary`；胡 `--primary`；杠描金；过幽灵。
- 多杠：「杠」+ 下方小数字（`gangOptions.length`）。

### 2.2 claim（按钮数 1–4）

- 顺序：`claimOptions`（服务端顺序：碰/杠/胡）+ 过（固定最右，若 `showPass`）。
- 宽度：1→102（强制胡或仅过）、2→102、3→66、4→50。
- 胡按钮：`--primary`；`mode==='claim' && opt.tile` ⇒ 按钮内 **20×30 牌面在上、「胡」在下**；无牌面时只有「胡」。
- 所有按钮挂 `anim-claim-pulse`（保留）。
- 高度预算：按钮内容盒 64−2×2=60；牌面 30 + gap 2 + 主字 24（`line-height:1`）= **56 ≤ 60**。

### 2.3 exchange（1 个按钮）

- 单个按钮：「换三张」+ 副字「已选 x/3」（`$ftl-font-xs`，22px），宽 140×64。
- 高度预算：24 + 2 + 22 = 48 ≤ 60。

### 2.4 lack（3 个按钮）

- 万/筒/条 3×66×64；「推荐」副字 `$ftl-font-xs`（22px）；高度 24+2+22=48 ≤60。

## 3. 多杠选择面板

- 点击「杠 + 数字」切换 `gangOpen`；仅 play 可达。
- 面板：`position: absolute; right: 0; bottom: calc(100% + 8px * var(--mj-u, 1)); width: calc(218px * var(--mj-u, 1)); display: flex; flex-wrap: wrap; gap: calc(6px * var(--mj-u, 1));`
- 面板项：`flex: 0 0 calc(50% - 3px * var(--mj-u, 1))`（**显式 2 列**），高 48，漆底金边，文案为牌型（如 `5万`）。
- 面板最高 2 行（2×48+6=102），y≈440–542；右缘 1243.26、左缘 1025.26 > 侧河右缘 1019.01 ⇒ 不遮挡；远离信息井右缘 747。
- 面板不占条形布局高度（绝对定位）。

## 4. 组件/接口

- `ActionBarMode` / `ActionBarAction` / props（mode/options/showPass/busy/selectedCount/recommendedSuit）不变。
- 模板：移除 `.mj-action-bar__grid` 中间层，按钮直接作为根 flex 子项；根宽由 `rowW` computed 给出。
- `btnW` computed：按 mode + 当前渲染按钮数返回 D3 宽度；n>4 防御性钳到 50（不预期可达）。
- 每个按钮 inline `width/height = calc(... * var(--mj-u, 1))`；按钮 CSS `line-height: 1`。
- 主字 24px（沿用 `.mj-action-bar__btn`），副字 22px（`$ftl-font-xs`）。
- Board：`actionsStyle` → `actionBarStyle`（right/bottom/z-index 3），仍只在 `hasActions` 时渲染。
- 皮肤类名/动画类名保持不变。

## 5. 测试

### 5.1 `mahjong-action-bar.test.ts`（重写布局断言）

- claim 4：一行 4 键；每个 `width: calc(50px * var(--mj-u, 1))`、`height: calc(64px * var(--mj-u, 1))`；gap 6；无 `grid-column/grid-row`。
- play 1/2/3 → 176/102/66；claim 1/2/3/4 → 102/102/66/50；lack 3×66；exchange 1×140。
- **算术断言**：claim-4 解析 4 个宽度求和 + 3×6 = 218；根宽 `calc(218px * var(--mj-u, 1))`。
- 顺序：play 出牌最右；claim 选项顺序 + 过最右。
- 胡按钮：claim 带 tile ⇒ 20×30 牌面 + 文本「胡」（不是「胡 5万」）；play 胡无牌面。
- 多杠：按钮文本「杠」+ 数字（下方副字）；面板 style 含 `position:absolute`、`bottom: calc(100% + 8px * var(--mj-u, 1))`、`width: calc(218px * var(--mj-u, 1))`、`flex-wrap: wrap`；面板项 `flex: 0 0 calc(50% - 3px * var(--mj-u, 1))`；面板是根的**直接子元素**且不占行。
- exchange：单按钮文本「换三张」+ 副字「已选 x/3」。
- lack：3 键 + 推荐副字。
- 源码闸：`line-height: 1`；无裸 `1px`（含注释；源码闸扫整份 SFC）；无 `em/rem/vw/vh/pt`；动画类保留。
- 动画/禁用/emit 行为不变。

### 5.2 `mahjong-board.test.ts`

- `.mj-action-bar` style 含 `position:absolute`、`right: 50.34px`、`bottom: 136px`、`z-index: 3`（1334×750 normal）；**不含** `left:` / `top:` / `width:176px` / `height:176px`。
- 有副露态：`right: 90.74px`、`bottom: 136px`。
- 迁移既有断言：`:421/:437` 的 `胡 5万` → `胡`；`:241` `buttonByText('杠')` 需容忍「杠」+ 数字（单杠仍纯「杠」）；`:842-855` 旧 `left/top/width` 断言删除/改写。

### 5.3 布局守护（新增，`mahjong-layout-v3.test.ts`）

- 最坏态 fixture：右家副露 + top/self ≥17 + right ≥20（必要时构造）：
  `actions.left + 176 - 218 > rightRiver.rect.left + rightRiver.rect.width`（即 218 条左缘 > 1019.01），并断言余量 ≥ 6px。
- 在 `mahjong-layout-v3.ts` token 区注释「218 为外部动作条约束，改动 layout 需重算」。

### 5.4 其他

- `mahjong-skin.test.ts` / `animations.test.ts` / `ui-tokens.test.ts` 原样通过（主字 24 不动；无新动画/时钟）。
- 真浏览器/真机走查兜底：jsdom 无布局，宽度/面板为字符串+算术断言，观感由 Task 3 真浏览器截图验证。

## 6. 错误处理与边界

- 0 个动作：`hasActions=false`，不渲染（沿用）。
- play 1–3、claim 1–4；n>4 防御性钳 50（客户端无此态）。
- claim 只剩「过」：102 宽幽灵按钮。
- 多杠 2–4 项：面板 2 列 wrap，最高 2 行。
- busy/disabled、`showPass`、`selectedCount`、`recommendedSuit` 语义不变。
- `u` 非法：布局回落 u=1；`var(--mj-u, 1)` 兜底独立挂载。

## 7. 风险

- 6.25px 是唯一水平护栏（纵向有 15.84px 重叠带）；任何宽度增长/布局改动需重算并跑 §5.3。
- 50px 宽 + 24px 主字：claim 单字 24 ≤ 46（内容宽）；claim-4 无 2 字标签；出牌在 play-2/3 的 102/66 宽下 48 ≤ 62/98；「换三张」3 字 24px=72 ≤136。
- claim 胡 20×30 + 24px 主字：内容盒 60，`line-height:1` 下 56 ≤60；若浏览器行框异常，真机兜底。
- 面板绝对定位在根上方，z-index 随根（3）；面板 `width/right` 与条一致。
- 主字保持 24px 会与 `mahjong-skin.test.ts` 的既有断言一致；副字统一 22px 令牌。
- 源码闸扫整份 SFC：新注释避免出现 `1px` 字面量。

## 8. 涉及文件

- `apps/client/src/components/table/mahjong/MahjongActionBar.vue`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（动作区 style）
- `apps/client/test/mahjong-action-bar.test.ts`
- `apps/client/test/mahjong-board.test.ts`
- `apps/client/test/mahjong-layout-v3.test.ts`（仅新增守护用例；布局代码不动）
- `apps/client/src/game/mahjong-layout-v3.ts`（仅注释 218 外部约束）

## 9. 审查记录

2026-11-12 按 `docs/dev-process.md` §3 做独立对抗审查（sonnet，只读）：核对了几何（最坏态 actions.right/侧河右缘/条左缘/纵向重叠带/副露 lane/hub 视觉右缘）、CSS/DOM 可行性（right+bottom 锚定、`--mj-u` 继承、各模式按钮内容高度/宽度、`fit-content`、面板 2 列）、数据/交互（按钮数上限、claim 胡恒带 tile、play 无 pass、多杠合并）、既有测试与纪律（mahjong-action-bar/board/skin/animations/ui-tokens、牌桌不新造时钟、哑终端）。

结论：**1 阻断 + 4 高 + 10 低**，均已修订：
- 阻断：D7 的 70px 提示 + `$ftl-font-sm`(26px) 实际约 96px，折行并溢出 64 高且加宽会吃掉 6.25px 余量 ⇒ 改为**单个「换三张」按钮 + 副字「已选 x/3」**（140 宽，22px 令牌）。
- 高：① D11「actions 矩形保留作碰撞保证」对 218 条不成立（向左超 42px）⇒ 加布局守护测试 + token 注释；② claim 胡恒带 tile，50px 按钮内容盒 60，默认行高会溢出 ⇒ 按钮 `line-height:1`（30+2+24=56 ≤60）并把测试矩阵改为 claim-4 带牌面；③ 「推荐」10px 无令牌且缩放后约 5.2 物理 px ⇒ 统一 `$ftl-font-xs`(22)；④ play 实际最多 3 键（pass 只在 claim、多杠合并）⇒ 按模式写死 count 区间与宽度。
- 低：正常态余量 46.65；hub 视觉右缘 747；面板/宽度改 calc 显式 + 面板项显式 2 列；exchange hint 合并进按钮（无独立 hint）；board 测试 `胡 5万`×2、`buttonByText('杠')`、旧 left/top/width 断言列入迁移；宽度/面板补纯映射与算术断言 + 最坏态布局守护 + 真浏览器兜底；主字保持 24px（与皮肤闸一致）；源码闸避 `1px` 字面量与 ui-tokens 单位/行高闸；claim 胡渲染条件限定 claim 模式；多杠副字与 claim 仅过的宽度已定。
