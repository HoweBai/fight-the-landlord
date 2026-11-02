# 麻将牌桌「天月麻雀」风格重制 — 设计 spec

日期：2026-11-02
状态：待对抗审查
范围：纯客户端展示层（麻将牌桌）
参考：天月麻雀（Amatsuki Mahjong）牌桌截图；当前实现 `apps/client/src/components/table/mahjong/*`

## 1. 背景与目标

当前四川麻将牌桌是深绿绒布 + 暖金描边插画牌，视觉气质与用户想要的「天月麻雀」相反。
目标：把牌桌、手牌、碰杠牌、牌河（出牌）、倒计时、座位卡、动作按钮整体换成天月麻雀的
「亮青桌面 + 白牌蓝背 + 蓝金玻璃 UI」风格，同时保持现有玩法逻辑、协议、服务端完全不动。

「像天月」的具体判据（按优先级）：

1. 桌面是亮青色（青绿/蓝绿），不是深绿绒布；有同心圆压纹和木色外框。
2. 麻将牌是白牌面、细灰边、红/绿/黑平涂字；牌背是深蓝色。
3. UI 是深蓝半透明玻璃 + 细金边；头像圆形金框 + 蓝色缎带名牌。
4. 中央是蓝金圆盘，倒计时在圆盘中心，字要大。
5. 整体明亮、干净、留白多，不像现在的深色赌场风。

## 2. 方案对比与选择

| 方案 | 内容 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 天月式重排 + 全套换皮 | 改桌面/牌面/牌背/UI，重做中央圆盘，调整牌位尺寸，副露/牌河/头像/按钮重绘 | 最接近参考 | 改动面最大，布局测试要全量更新 | **采用** |
| B 只换视觉皮肤 | 位置、尺寸、结构全不动，只换颜色和素材 | 风险最小 | 拿不到天月的空间气质；中央条仍是绿的形状 | 否 |
| C 视觉换皮 + 只重做中央盘 | 手牌/牌河不动，只改中央盘和配色 | 折中 | 手牌/牌河比例仍偏小，离天月仍有距离 | 否 |

选择 A。用户明确说「主要是牌桌布局，牌桌、手牌、碰杠牌、出牌、倒计时等等这些元素的样式、
布局、位置」，B/C 都不满足「布局、位置」。

## 3. 范围

### 做

- `MahjongBoard.vue` 的桌面背景、顶栏、动作按钮、托管遮罩、长按提示弹层。
- `MahjongTile.vue` 的牌面/牌背素材映射（沿用现有目录 API）。
- `MahjongHandBacks.vue` / `MahjongRiver.vue` / `MahjongMeld.vue` 的视觉。
- `MahjongCenter.vue` 重做为蓝金圆盘（倒计时、牌墙、阶段、可响应/听牌）。
- `MahjongSeatChip.vue` 的圆形金框头像 + 蓝色缎带名牌。
- `ClaimTile.vue` 的按钮/弹层配色。
- `MahjongHuBanner.vue` 的配色对齐（金/海军蓝）。
- `mahjong-layout.ts` 的牌面比例、牌位尺寸、中央盘尺寸。
- `uni.scss` 新增麻将专用色板 token（`$ftl-color-mj-*`）。
- 麻将牌素材全套替换 + 素材生成脚本 + 第三方声明。
- 对应测试更新。

### 不做

- 不改协议、服务端、配置中心、数据库、admin。
- 不做二次元角色立绘；头像仍用现有 `/static/ui/default.png`。
- 不重做大厅、结算页、历史页。结算浮层如与新牌桌明显冲突，只做最小配色对齐，不重排结构。
- 不使用天月麻雀自己的美术资源；只用开源素材或 CSS 绘制。
- 不做运行时旋转牌面（避免 App 端 `<image>` transform 兼容风险），改为预生成四方向 PNG。
- 不新增游戏规则/数据字段；中央圆盘只用现有 props。

## 4. 决策表

| 编号 | 决策 | 理由/约束 |
|---|---|---|
| D1 | 采用方案 A（全套换皮 + 尺寸/中央盘重排） | 用户明确要布局/位置变化 |
| D2 | 保持四家围桌拓扑；自家副露仍在手牌上方 | 1334 宽下手牌约 1139px，左右只剩 ~97px，放不下天月那种贴左/右的副露列；强行挪会压侧家区 |
| D3 | 牌面用 lietxia/mahjong_graphic「扁平风格 flat style」 | 白牌面/细灰边/红绿黑平涂，最接近天月；M+ 字体许可允许商用；源图 272×360 |
| D4 | 预生成 my/top/left/right 四方向 PNG，保留现有目录与文件名 | 现有 `MahjongTile` 按方向取目录；避免运行时旋转在 App 端的兼容风险 |
| D5 | 牌面宽高比从 75:113（0.664）改为 180:238（0.756） | 匹配 flat style 源图；天月牌面也接近 0.75 |
| D6 | 手牌高度 108→104，牌面视觉反而变宽（71.7→78.6） | 保证 `s=1` 时手牌行 ≤ 0.88W（1139 < 1174），不破坏左侧自家人像卡的留白契约 |
| D7 | 牌河牌高 50→56；顶牌背高 54→48；侧牌背槽高 45→34、侧牌河高 40→37 | 让四方向牌比例统一到 0.756 / 1.322；顶牌背 13 张不溢出牌河宽度 |
| D8 | 中央矩形卡改为 260×220 的圆盘卡；中央盘直径 130，下缘留 64px 给可响应/听牌 | 中心区 1334×750 下高 264，260×220 可放下；不挤压牌河 |
| D9 | 倒计时：圆盘中心大数字；`seconds>0` 时显示秒数，否则显示牌墙数；`active && seconds<=5` 红色脉冲 | 客户端拿不到每窗口总时长，不做假进度环；只做「大数字+状态色」，不伪造百分比 |
| D10 | 桌面木框用伪元素/inset 阴影绘制，不改 `.mj` 的 border 宽度 | `.mj` 是 `box-sizing:border-box`，绝对定位子元素以 padding box 为基准；border 从 3px 加到 10px 会让全桌内容偏移 7px |
| D11 | 新色板只在麻将组件/uni.scss 内使用 | 不影响斗地主/跑得快等其他玩法 |
| D12 | 素材生成脚本放 `scripts/build-mahjong-tile-set.mjs`，源图 vendor 到 `scripts/assets/mahjong/lietxia-flat/` | 可离线复现；不依赖构建时联网 |
| D13 | 删除 6 张未被引用的 `left/*z.png`（当前工作区已删除） | 死资源；新素材整批替换 |
| D14 | 不新增第三方运行时依赖 | 素材生成用 workspace 已有 `@napi-rs/canvas` |

## 5. 实现设计

### 5.1 素材管线

源图（vendored，27 张牌面 + 1 张牌背）：

```
scripts/assets/mahjong/lietxia-flat/
  f1m.png … f9m.png   （万）
  f1p.png … f9p.png   （筒）
  f1s.png … f9s.png   （条）
  flat_back.png
```

生成脚本 `scripts/build-mahjong-tile-set.mjs`：

1. 读源图（272×360 RGBA）。
2. 输出到 `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/`：
   - `my/`：缩放到 180×238，文件名 `wan-1.png` / `tong-1.png` / `tiao-1.png` / `back.png`。
   - `top/`：旋转 180°，180×238。
   - `left/`：顺时针旋转 90°，238×180。
   - `right/`：逆时针旋转 90°，238×180。
3. 输出使用 `@napi-rs/canvas` 的 PNG 编码；质量优先保证边缘干净。
4. 脚本幂等：重复运行覆盖同名文件；不改其他目录。
5. 脚本不参与构建；生成结果入库（uni-app 静态资源要求）。

第三方声明：在 `THIRD-PARTY-NOTICES.md` 新增小节，注明
`lietxia/mahjong_graphic`、`PNG 位图/扁平风格 flat style`、M+ 字体许可、源仓库 URL。

### 5.2 布局与尺寸

`apps/client/src/game/mahjong-layout.ts`：

- `TILE_RATIO` 改为 `180 / 238`（≈0.7563）。
- token 调整：

| token | 原值 | 新值 | 影响 |
|---|---:|---:|---|
| handH | 108 | 104 | 手牌行宽 1139（≤0.88W） |
| riverH | 50 | 56 | 牌河牌 42.3×56 |
| topBackH | 54 | 48 | 顶牌背 13 张约 472 宽，不溢出 |
| sideBackH | 45 | 34 | 侧牌背槽 45×34（横图比例 1.322） |
| sidePitch | 24 | 26 | 侧牌背叠压 8px |
| sideRiverH | 40 | 37 | 侧牌河比例 49/37≈1.324 |
| centerClaimW/H | 34/51 | 34/45 | 比例 0.756 |
| centerTingW/H | 20/30 | 20/26 | 比例 0.756 |

- 中央卡：
  - 非紧凑：宽 `min(260*s, centerZone.width - 16*s)`，高 `min(220*s, centerZone.height - 16*s)`。
  - 紧凑阈值：`centerZone.height < 240*s` 时切紧凑；紧凑卡高 `min(120*s, ...)`，只出圆盘+单行文字。
  - 1334×750 验算：centerZone 高 264 → 非紧凑，卡 260×220。
- 手牌/牌河/侧家区的位置公式不变，只随 token 变化。
- `centerTiles`、`actions` 等输出字段保持不变；不新增/删除输出字段。

### 5.3 组件与样式

#### MahjongBoard.vue

- `.mj` 背景替换为：
  - 底层：`linear-gradient(180deg, #7cb0be 0%, #62aab8 45%, #4e7884 100%)`
  - 中层：中心柔光 `radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.18), transparent 62%)`
  - 上层：同心圆压纹 `repeating-radial-gradient(circle at 50% 45%, transparent 0 58px, rgba(255,255,255,.035) 58px 59px)`
  - 木质外框：`::before` 绝对定位 `inset:0`，`border:10px solid` 木色渐变，`pointer-events:none`，`z-index` 0；不用 `.mj` 的 border。
- 顶栏：半透明海军蓝渐变 + 底部金色 hairline；文字白色，徽标金色。
- 动作按钮：海军蓝渐变 + 金边；主按钮（出牌/胡）保持金色，但改冷金（#e8c56a / #a8792e）。
- 托管遮罩：海军蓝玻璃 + 金边；长按提示弹层同样换色。
- 不改模板结构、不改 emit、不改交互逻辑。

#### MahjongTile.vue

- 素材路径映射不变（`/pages/table/static/mahjong/{dir}/{suit}-{r}.png`）。
- 尺寸覆盖按新比例调整：
  - `my`：34×45 / 46×61 / 60×79（sm/md/lg）
  - `top`：与 my 相同（新素材同比例，不再需要 55×84 的独立比例）
  - `left/right`：51×39 / 69×52 / 90×68（横图）
  - rotate 模式的宽高交换同步改为新比例。
- 视觉：白牌面自带；外层只加 1px 半透明描边阴影和 `box-shadow: 0 2px 6px rgba(10,25,50,.28)`。
- 选中态：金色双环 + 上浮；禁用/置灰保持。

#### MahjongHandBacks.vue

- 无需改逻辑；`tileW/tileH` 由布局给。
- 侧家背牌从「竖槽里塞横图」改为「横槽填满」，视觉上不再缩成小方块。
- 背牌加 1px 亮边高光（CSS），模拟天月蓝色牌背的立体边。

#### MahjongRiver.vue

- 牌河网格、副露条逻辑不变。
- 最新牌高亮从金色光晕改为「金色外环 + 轻微上浮 2px」。
- 可响应牌筛选描边改为青色。
- 副露标签「碰/杠/暗杠」改为海军蓝底 + 金边小胶囊。

#### MahjongMeld.vue

- 牌面不变；组间距沿用布局输出。
- 暗杠/碰的背面牌用新蓝背；明牌用新白面。
- 副露组整体加极淡的海军蓝底托（可选，避免白牌贴在亮青桌面上发飘）。

#### MahjongCenter.vue（重做）

结构：

```
.mj-center（260×220 卡片，海军蓝玻璃 + 双金边 + 四角装饰）
  .mj-center__dial（130×130 圆盘）
    .mj-center__ring（金色双环）
    .mj-center__value（大数字：秒数 / 牌墙数 / 终）
    .mj-center__unit（“s” 或 “张”）
  .mj-center__top（牌墙 N）
  .mj-center__phase（阶段文案）
  .mj-center__claims（可响应牌 / 听牌牌面，最多两行）
```

- `seconds > 0` → 圆盘中心显示 `seconds`，单位 `s`；`active && seconds <= 5` 加 `--urgent`（红色 + 脉冲）。
- `seconds === 0` 且未结束 → 圆盘中心显示 `wallCount`，单位 `张`。
- 结束态 → 显示 `终` 或 `endedText`。
- 顶部始终显示 `牌墙 {wallCount}`；阶段文案在圆盘下方。
- 可响应牌：用现有 `claimTile`，34×45；听牌：20×26，最多两行，超出用 `+N` 收敛（不横向滚动）。
- 紧凑模式：圆盘 90px + 单行「牌墙 · 阶段 · 秒」文字；隐藏听牌牌面（与现有紧凑行为一致）。
- 不改 props 名称与含义。

#### MahjongSeatChip.vue

- 头像：圆形裁切 + 2px 金环 + 外发光；保留庄/缺/胡/听角标（角标位置微调，避免压金环）。
- 信息区：海军蓝半透明胶囊 + 细金边；名字白色、余额金色；徽标（托管/已出局/番数/输赢）用同色系小胶囊。
- self 变体：头像 + 余额上下排，不加胶囊底（避免挡手牌）。
- bar 变体：保持 40×56 紧凑头像，只换金环和底色。
- 活跃态：强/弱动作窗口用青色/金色外发光，不改变布局尺寸。

#### ClaimTile.vue

- 弹层：海军蓝玻璃 + 金边（替换深绿）。
- 次按钮（碰/杠）：海军蓝渐变 + 金边。
- 主按钮（胡）：金色立体保持，改冷金色值。
- 过：降低透明度，保持弱化。

#### MahjongHuBanner.vue

- 金色渐变改为「冷金 + 海军蓝」；文字白色；阴影减弱，避免在亮桌面上过曝。

### 5.4 主题 token（uni.scss）

新增（只给麻将用，前缀 `mj`）：

```scss
$ftl-color-mj-table-light: #7cb0be;
$ftl-color-mj-table-mid: #62aab8;
$ftl-color-mj-table-deep: #4e7884;
$ftl-color-mj-navy: #1b2950;
$ftl-color-mj-navy-light: #2c4270;
$ftl-color-mj-glass: rgba(27, 41, 80, 0.72);
$ftl-color-mj-gold: #e8c56a;
$ftl-color-mj-gold-deep: #a8792e;
$ftl-color-mj-cyan: #6fe3e8;
```

现有 `$ftl-color-mahjong-table*` 保留但不再被麻将牌桌引用；清理留给后续无关重构，不在本片做。

## 6. 测试判据

### 6.1 布局纯函数（`apps/client/test/mahjong-layout.test.ts`）

- 1334×750：`centerCard` 在 `centerZone` 内；`centerCard.width≈260`、`height≈220`。
- 1334×1000 / 1623×750 / 1343×1000 矩阵：四区不重叠；手牌/牌河/副露/中央卡互不覆盖。
- `s=1` 时手牌行宽 `≤ 0.88*W`（新比例下的关键回归断言）。
- 顶牌背 13 张总宽 `≤ topBacks.rect.width`（防溢出）。
- 侧牌背槽宽高比 ≈ 238/180；侧牌河宽高比 ≈ 49/37。
- 牌面比例：`hand.tile.w / hand.tile.h ≈ 180/238`。
- 紧凑阈值：构造矮画布，`centerCompact=true`，卡片高度 ≤ 120s。
- 全部输出仍为有限正数；不出现 NaN/负尺寸。

### 6.2 组件（`apps/client/test/mahjong-*.test.ts`）

- `MahjongTile`：四方向素材路径映射正确；back 路径正确；尺寸类按新比例；选中/禁用/置灰类保留。
- `MahjongCenter`：秒数/牌墙/终态切换；urgent 类只在 `active && seconds<=5`；claim/ting 渲染；紧凑模式隐藏听牌。
- `MahjongRiver`：最新牌高亮类；可响应描边类；点击 emit 不变。
- `MahjongHandBacks`：13 张背牌渲染；侧家横槽填满；已胡亮牌替换。
- `MahjongSeatChip`：圆形头像类；角标渲染；活跃态类。
- `MahjongBoard`：背景/顶栏/动作按钮类存在；出牌/胡/过/碰/杠 emit 不变；托管遮罩仍可取消。
- `ClaimTile`：按钮文案/emit 不变；主/次/过按钮类。

### 6.3 素材完整性（新增）

新增 `apps/client/test/mahjong-assets.test.ts`：

- `my/top/left/right` 各 27 张牌面 + `back.png`；
- `my/top` 尺寸 180×238；`left/right` 238×180（读 PNG 头，不引图像库）；
- 文件名与 `suit-{1..9}` 一一对应；
- 不存在未被引用的 `*z.png`。

### 6.4 真浏览器/真机

- `pnpm -C apps/client test`、`pnpm -C apps/client run lint`。
- 真浏览器截图：1334×750、1334×1000、1623×750；对照天月参考截图检查：
  - 桌面是否亮青、木框是否在边缘；
  - 白牌/蓝背是否清晰；
  - 中央圆盘倒计时是否可读；
  - 四家牌河/副露/头像是否不重叠；
  - 按钮是否可点、无死按钮。
- App 端模拟器走查一次，确认 PNG 牌面与圆盘在 webview 中没有变形/白边。

## 7. 错误处理与边界

- **素材缺失**：`MahjongTile` 的 `<image>` 若 404，uni-app 显示空白；新增素材完整性测试在 CI 阶段拦住。运行时不做兜底图，避免掩盖问题。
- **听牌牌过多**：中央卡只展示最多两行，超出显示 `+N`；不横向滚动，不撑破卡片。
- **小画布/紧凑模式**：`centerCompact` 走单行；圆盘缩到 90px；隐藏听牌牌面。若连单行都放不下，阶段文案 `text-overflow: ellipsis`。
- **倒计时为 0**：圆盘切牌墙数；不显示 `0s`。
- **结算后**：`endedText` 存在时圆盘显示终态，不显示倒计时。
- **侧家已胡亮牌**：沿用现有 `revealed` 分支；亮牌用新白面 + dim。
- **长按提示/托管遮罩**：不改变 z-index 层级；遮罩仍在手牌上方、banner 之下。
- **木框层**：`pointer-events:none`，不拦截按钮；z-index 低于所有交互元素。
- **背景对比度**：白字/金字在亮青桌面上必须带深色底（顶栏、座位卡、按钮都有海军蓝底），不允许裸文字直接贴桌面。

## 8. 风险

| 风险 | 等级 | 处置 |
|---|---|---|
| 牌面比例变化导致所有牌位尺寸连锁变化，布局测试大面积红 | 高 | 先改布局纯函数 + 测试，再改组件；按 1334×750 基准逐项验算 |
| 中央圆盘 220 高压缩牌河/手牌 | 高 | 1334×750 下 centerZone 264 高，卡 220 居中；用测试锁不重叠 |
| 侧家牌背从「竖槽横图」改为「横槽填满」后侧区变宽 | 中 | sideZoneW 从 199→216，仍 < 画布 1/4；测试锁 centerZone 宽度 |
| 白牌在亮青桌面上对比度不足 | 中 | 牌面自带灰边 + 外阴影；牌背深蓝；必要时加深桌面中部渐变 |
| `backdrop-filter` 在低端 Android 掉帧 | 中 | 只在小面积按钮/卡片用 blur；桌面不使用 blur |
| App 端 `<image>` 对 PNG 透明边缘/旋转的渲染差异 | 中 | 预生成四方向 PNG，不做运行时旋转；模拟器走查 |
| 素材体积增加导致进桌加载变慢 | 中 | 目标 mahjong 目录 ≤1.2MB；180×238 输出，必要时降到 150×198 |
| 素材许可证/署名遗漏 | 低 | 新增 THIRD-PARTY-NOTICES 小节；源仓库/许可/修改说明齐全 |
| 删除 z-suffix 文件被其他分支引用 | 低 | 全仓 grep 无引用；删除随本片提交 |
| 结算浮层与新桌面色系冲突 | 低 | 本片只做最小配色对齐；不做结构重排；另立片可完整重做 |

## 9. 涉及文件

**客户端源码**

- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/src/components/table/mahjong/MahjongTile.vue`
- `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`
- `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`
- `apps/client/src/components/table/mahjong/ClaimTile.vue`
- `apps/client/src/components/table/mahjong/MahjongHuBanner.vue`
- `apps/client/src/uni.scss`

**素材**

- `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/*.png`（整批替换）
- `scripts/build-mahjong-tile-set.mjs`（新增）
- `scripts/assets/mahjong/lietxia-flat/*.png`（新增，vendored 源图）

**文档**

- `THIRD-PARTY-NOTICES.md`
- `apps/client/src/static/ASSETS.md`（如素材体积/说明有变）
- 本 spec

**测试**

- `apps/client/test/mahjong-layout.test.ts`
- `apps/client/test/mahjong-board.test.ts`
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/test/mahjong-river.test.ts`
- `apps/client/test/mahjong-hand-backs.test.ts`
- `apps/client/test/mahjong-seat-chip.test.ts`
- `apps/client/test/mahjong-tile-meld.test.ts`
- `apps/client/test/mahjong-assets.test.ts`（新增）

## 10. 审查记录

（待独立 reviewer 审查后填写；格式：编号 / 等级 阻断|高|低 / 结论 / 处置）
