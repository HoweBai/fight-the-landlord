# 麻将牌桌「天月麻雀」风格重制 — 设计 spec

日期：2026-11-02
状态：已实现并验证（v2）；已合并 origin/dev 并推送 dev
范围：纯客户端展示层（麻将牌桌）
参考：天月麻雀（Amatsuki Mahjong）牌桌截图；当前实现 `apps/client/src/components/table/mahjong/*`

## 1. 背景与目标

当前四川麻将牌桌是深绿绒布 + 暖金描边插画牌，视觉气质与用户想要的「天月麻雀」相反。
目标：把牌桌、手牌、碰杠牌、牌河（出牌）、倒计时、座位卡、动作按钮整体换成天月麻雀的
「亮青桌面 + 白牌蓝背 + 蓝金玻璃 UI」风格，同时保持现有玩法逻辑、协议、服务端完全不动。

「像天月」的具体判据（按优先级）：

1. 桌面是亮青色（青绿/蓝绿），不是深绿绒布；有同心圆压纹和木色外框。
2. 麻将牌是白牌面、米色立体边、红/绿/黑平涂字；牌背是深蓝色。
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
- `MahjongHuBanner.vue` 的配色对齐。
- `mahjong-layout.ts` 的牌面比例、牌位尺寸、中央盘尺寸、动作区宽度。
- `uni.scss` 新增麻将专用色板 token（`$ftl-color-mj-*`）。
- 麻将牌素材全套替换 + 素材生成脚本 + 第三方声明 + 素材预算闸。
- 基线修复：`MahjongTile`/`MahjongMeld` 的死 prop 类型错误；`mahjong-board.test.ts` 两条陈旧断言。
- 对应测试更新。

### 不做

- 不改协议、服务端、配置中心、数据库、admin。
- 不做二次元角色立绘；头像仍用现有 `/static/ui/default.png`。
- 不重做大厅、结算页、历史页。结算浮层只做最小配色对齐，不重排结构。
- 不使用天月麻雀自己的美术资源；只用 CC0 素材或 CSS 绘制。
- 不做运行时旋转牌面（避免 App 端 `<image>` transform 兼容风险），改为预生成四方向 PNG。
- 不新增游戏规则/数据字段；中央圆盘只用现有 props + 一个 `ended` 布尔。

## 4. 决策表

| 编号 | 决策 | 理由/约束 |
|---|---|---|
| D1 | 采用方案 A（全套换皮 + 尺寸/中央盘重排） | 用户明确要布局/位置变化 |
| D2 | 保持四家围桌拓扑；自家副露仍在手牌上方 | 1334 宽下手牌 1130px，左右只剩 ~102px，放不下天月那种贴左/右的副露列；强行挪会压侧家区 |
| D3 | 牌面改用 **FluffyStuff/riichi-mahjong-tiles**（CC0 公有领域） | 600×800、米色立体边、平涂字，接近天月；许可明确、可商用、可修改；放弃 lietxia（其 PNG 位图许可未核实，仅字形有 M+） |
| D4 | 预生成 my/top/left/right 四方向 PNG，保留现有目录与文件名 | 现有 `MahjongTile` 按方向取目录；避免运行时旋转在 App 端的兼容风险 |
| D5 | 牌面宽高比 3:4（0.75），输出 180×240 / 240×180 | 匹配 FluffyStuff 源图 600×800；天月牌面也接近 0.75 |
| D6 | 手牌高度 108→104；牌面宽度 71.7→78（变宽） | 保证 `s=1` 时手牌行 1130 ≤ 0.88W（1174），且 `hand.left=102 > selfChip.right=68`，不破坏左侧自家人像卡 |
| D7 | 牌河高 50→56；顶牌背高 54→47；侧牌背槽高 45→34、侧牌河高 40→37 | 四方向比例统一；14 张顶牌背 519.5 ≤ 牌河宽 526，不溢出 |
| D8 | 中央卡 340×170，圆盘 110，顶部信息条 22，右列 210 | 最差（上下家都有副露）中心区高 165.4，卡高 153.4；110+22+12=144 ≤153.4，放得下；详见 5.2 |
| D9 | 倒计时：`active && seconds>0` 显示秒数，否则显示牌墙数；`active && seconds>0 && seconds<=5` 红色脉冲；结束态显示「终」 | `seconds` 是当前窗口剩余秒（含对手窗口），不能无条件显示；`seconds=0` 是超时哨兵，不能显示 0s |
| D10 | 新增 `ended?: boolean` prop，由 Board 按 `phase==='ended'` 传入 | `endedText` 在血战中途是「已胡 N 家」，不是结束态；不能拿它判断终局 |
| D11 | 桌面木框用伪元素/inset 渐变绘制，不改 `.mj` 的 border 宽度 | `.mj` 是 `box-sizing:border-box`，绝对定位子元素以 padding box 为基准；border 从 3px 加到 10px 会让全桌内容偏移 7px |
| D12 | 动作区 `maxWidth` 收紧到自家牌河右侧（约 172px @1334），按钮换行 | 旧布局 claim 面板会盖住自家牌河右端 2–4 列；新牌河更宽，必须限制 |
| D13 | 素材生成用 Python + Pillow，输出调色板 PNG（64 色） | 112 张约 450KB（旧 980KB）；生成结果入库；Pillow 仅开发期依赖 |
| D14 | 新增 `table/mahjong` 素材预算 768KiB，并纳入 `asset-budget.test.ts` | 现目录未被预算覆盖；新目标 450KB 有机械闸 |
| D15 | 红/金底一律用深海军蓝文字；桌面上的裸文字必须加海军蓝底 | 白 on 金 1.66:1、金 on 青 1.59:1，均不达标；详见 5.6 |
| D16 | 红色脉冲复用 `anim-urgent-pulse` | 已有 reduced-motion 降级；不新造 keyframe |
| D17 | 保留现有 7 档视口矩阵，补 1343×1000；紧凑阈值按内容预算定 | 防止新 token 在 21:9/方屏下溢出 |
| D18 | 基线修复作为任务 0：删死 prop、修 2 条陈旧测试 | 当前 `vue-tsc` 6 错、2 测试红；不先修会让 TDD 红绿混淆 |
| D19 | 不删除旧 `$ftl-color-mahjong-table*` token，只停止引用 | 避免无关重构；后续清理另立片 |

## 5. 实现设计

### 5.1 素材管线

源图（vendored，CC0，27 张字形 + 牌面 + 牌背）：

```
scripts/assets/mahjong/fluffystuff/
  Front.png              （空白牌面，600×800）
  Back.png               （红色牌背，600×800，生成时改海军蓝）
  Man1.png … Man9.png     （万）
  Pin1.png … Pin9.png     （筒）
  Sou1.png … Sou9.png     （条）
  LICENSE.txt            （CC0 声明 + 源仓库 URL）
```

生成脚本 `scripts/build-mahjong-tile-set.py`（Python 3 + Pillow）：

1. 合成牌面：`Front.png` 上叠加字形 PNG（alpha composite）。
2. 牌背改色：`Back.png` 转 HSV，色相 +170，再与 `#1b2950` 以 38% 混合，保留立体高光。
3. 输出到 `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/`：
   - `my/`：缩放到 180×240；文件名 `wan-1.png` / `tong-1.png` / `tiao-1.png` / `back.png`。
   - `top/`：旋转 180°，180×240。
   - `left/`：顺时针旋转 90°，240×180。
   - `right/`：逆时针旋转 90°，240×180。
4. 调色板量化：64 色、`FASTOCTREE`、无抖动（渐变已实测无可见 banding），`optimize=True`。
5. 生成 `apps/client/src/pages/table/static/mahjong/manifest.json`：每文件 `sha256`、宽高、方向；供素材测试核对。
6. 幂等：重复运行覆盖同名文件，不改其他目录。

许可证：`THIRD-PARTY-NOTICES.md` 用新小节替换旧 babykylin 小节，注明
`FluffyStuff/riichi-mahjong-tiles`、CC0 1.0、源仓库 URL、修改内容（旋转/缩放/改色/量化）。

旧脚本 `scripts/extract-mahjong-tiles.mjs` 标记退役（文件头注释），不再产出新素材。

### 5.2 布局与尺寸

`apps/client/src/game/mahjong-layout.ts`：

- `TILE_RATIO` 改为 `3 / 4`（0.75）。
- 新增 `SIDE_TILE_RATIO = 4 / 3`（横向牌背/牌河）。
- token 调整：

| token | 原值 | 新值 | 影响 |
|---|---:|---:|---|
| handH | 108 | 104 | 手牌 78×104，行宽 1130 |
| riverH | 50 | 56 | 牌河牌 42×56，河宽 526 |
| topBackH | 54 | 47 | 顶牌背 35.25×47；14 张 519.5 ≤ 526 |
| sideBackH | 45 | 34 | 侧牌背槽 45.33×34 |
| sidePitch | 24 | 26 | 侧牌背叠压 8px |
| sideRiverH | 40 | 37 | 侧牌河 49×37（比例 1.324） |
| centerClaimW/H | 34/51 | 34/45 | 比例 0.756 |
| centerTingW/H | 20/30 | 20/27 | 比例 0.741 |

- `sideBackW` 公式改为 `T.sideBackH * SIDE_TILE_RATIO`（不再用 `TILE_RATIO`）。
- 中央卡：
  - 宽 `min(340*s, centerZone.width - 16*s)`。
  - 高 `min(170*s, centerZone.height - 12*s)`。
  - `centerCompact = centerCard.height < 144*s`。
  - 紧凑卡：`min(260*s, ...) × min(120*s, ...)`，圆盘 90，单行文字。
- 动作区：`maxWidth = min(T.actionsMaxW*s, actions.rightX - (ownRiver.rect.left+ownRiver.rect.width) - inner*s)`，最小值 120*s。
- 1334×750 验算（s=1）：

| 场景 | centerZone 高 | centerCard 高 | 紧凑？ |
|---|---:|---:|---|
| 无副露 | 271 | 170 | 否 |
| 单家副露 | 218.2 | 170 | 否 |
| 上下家都有副露 | 165.4 | 153.4 | 否 |

- 中央卡内容预算：顶部条 22 + 上下 padding 12 + 底行 110（圆盘）= 144；最差卡高 153.4，余 9.4。
  - 底行右列宽 210：claim 34×45 + ting 20×27（最多两行 57）+ gap 6 = 108 ≤ 底行 110。
  - 9 张听牌单行 204 ≤ 210；13 张两行 57 高。

### 5.3 组件与样式

#### MahjongBoard.vue

- `.mj` 背景（CSS 层序：**最上层写最前**）：
  ```scss
  background:
    repeating-radial-gradient(circle at 50% 45%, transparent 0 58px, rgba(255,255,255,.035) 58px 59px),
    radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.18), transparent 62%),
    linear-gradient(180deg, $ftl-color-mj-table-light 0%, $ftl-color-mj-table-mid 45%, $ftl-color-mj-table-deep 100%);
  ```
- **删除**旧的 `border: 3px solid rgba(20,50,30,.85)` 与全部旧绿色 `box-shadow`（含 160px 暗角）。
- 木框：`.mj::before { position:absolute; inset:0; border:10px solid transparent; border-image: linear-gradient(135deg, $ftl-color-mj-wood-mid, $ftl-color-mj-wood-light, $ftl-color-mj-wood-deep) 1; pointer-events:none; z-index:0; }`。顶部 10px 被顶栏覆盖是有意为之。
- 顶栏：海军蓝玻璃渐变 + 底部金色 hairline；白字，徽标金色。
- 动作按钮：海军蓝渐变 + 金边；主按钮（出牌/胡）金色底 + **海军蓝文字**。
- 托管遮罩、长按提示弹层：海军蓝玻璃 + 金边，文字浅蓝。
- 不改模板结构、不改 emit、不改交互逻辑。

#### MahjongTile.vue

- 素材路径映射不变。
- 尺寸档位按 3:4 调整：
  - `my`：34×45 / 46×61 / 60×80（sm/md/lg）
  - `top`：同 my（同比例）
  - `left/right`：45×34 / 61×46 / 80×60（横图）
- `border-radius: 12%`（跟随源图圆角，避免透明角露出方形阴影）。
- 阴影用 `filter: drop-shadow(0 2px 3px rgba(10,25,50,.35))`（跟随 alpha）。
- 选中态：`box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-gold` + 上浮；hover 不用。
- 删除未声明的 `rotate` prop 与 `Rotate` 类型（基线修复）。

#### MahjongHandBacks.vue

- 逻辑不变；`tileW/tileH` 由布局给。
- 侧家背牌横槽填满（`sideBackW = sideBackH * 4/3`）。
- 背牌加 `box-shadow: inset 0 $ftl-hairline 0 rgba(255,255,255,.18)` 亮边。

#### MahjongRiver.vue

- 网格/副露条逻辑不变。
- 最新牌：金色外环 + 上浮 2px。
- 可响应牌：青色描边（`$ftl-color-mj-cyan`）。
- 副露标签：海军蓝底 + 金边小胶囊。

#### MahjongMeld.vue

- 逻辑不变；删除未声明的 `vertical` 绑定与 `Rotate` 类型（基线修复）。
- 副露组加极淡海军蓝底托（`rgba(27,41,80,.35)`），避免白牌贴亮青桌面发飘。

#### MahjongCenter.vue（重做）

结构：

```
.mj-center（340×170 卡片，海军蓝玻璃 + 双金边）
  .mj-center__strip（高 22：牌墙 N + 阶段）
  .mj-center__body（高 ≥110）
    .mj-center__dial（110×110 圆盘）
      .mj-center__ring（金色双环）
      .mj-center__value（大数字）
      .mj-center__unit（s / 张）
    .mj-center__side（宽 210：claim / ting / endedText）
```

- props 增加 `ended?: boolean`；其余 props 名称/含义不变。
- `dialValue`：`ended ? '终' : (active && seconds>0 ? seconds : wallCount)`。
- `dialUnit`：秒数→`s`；牌墙→`张`；结束→空。
- `urgent = active && seconds > 0 && seconds <= 5`；复用 `anim-urgent-pulse`；颜色 `$ftl-color-mj-urgent`。
- `endedText` 只做右列次要行，不控制终局。
- `claimTile` 34×45；`tingTiles` 20×27，最多两行；超出用 `+N` 收敛；保留 `maxFan` → `听（N 番）`。
- 紧凑模式：圆盘 90 + 单行「牌墙 · 阶段 · 秒」；隐藏听牌牌面；claim 只出文字。
- 圆盘底部加 12 个刻度（CSS 伪元素/渐变小点），模拟天月表盘。

#### MahjongSeatChip.vue

- 头像结构改为三层：`.avatar-frame`（金环 + 角标，不裁切）→ `.avatar-clip`（`border-radius:50%; overflow:hidden`）→ `<image>`。
- 角标（庄/缺/胡/听）挂在 frame 上，不被圆形裁切。
- 信息区：海军蓝半透明胶囊 + 细金边；名字白、余额金（金在海军蓝底上 8.5:1）。
- self 变体：头像 + 余额小胶囊（必须带海军蓝底，不允许裸金贴桌面）。
- bar 变体：头像 40×40，bar 卡 40×56。
- 活跃态：强/弱用青色/金色外发光。
- side 变体保持横排（受 56px 高度限制）；名牌做缎带圆角，不改成天月的竖排（有意偏离，登记在 §8）。

#### ClaimTile.vue

- 弹层：海军蓝玻璃 + 金边。
- 次按钮：海军蓝渐变 + 金边；主按钮（胡）：金底 + 海军蓝文字。
- 过：降低透明度，保持弱化。

#### MahjongHuBanner.vue

- 海军蓝底 + 金边 + 金色文字（8.5:1）；不使用白 on 金。
- 动画不变。

### 5.4 主题 token（uni.scss）

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
$ftl-color-mj-urgent: #ff8a8a;
$ftl-color-mj-muted: #b9c6e0;
$ftl-color-mj-wood-light: #8a6440;
$ftl-color-mj-wood-mid: #6b4a2f;
$ftl-color-mj-wood-deep: #5a3c24;
$ftl-color-mj-on-gold: #1b2950;
```

组件内只用这些 token；不写裸 hex；描边一律 `$ftl-hairline`（2px），不写 `1px`。

### 5.5 组件契约

- `MahjongCenter` 新增 `ended?: boolean`（默认 false）；其余 props/emits 不变。
- 其余组件 props/emits 完全不变。
- 不新增运行时依赖；素材脚本的 Pillow 仅开发期。

### 5.6 对比度判据

| 组合 | 比值 | 结论 |
|---|---:|---|
| `#1b2950` on `#e8c56a` | 8.54:1 | 金底文字用海军蓝 |
| `#e8c56a` on `#1b2950` | 8.54:1 | 海军蓝底金色文字 |
| `#b9c6e0` on `#1b2950` | 8.26:1 | 次要文字 |
| `#ff8a8a` on `#1b2950` | 6.26:1 | 紧迫倒计时 |
| `#1b2950` on `#62aab8` | 5.38:1 | 桌面上裸字用海军蓝 |
| `#ffffff` on `#62aab8` | 2.64:1 | **禁止**裸白字贴桌面 |
| `#e8c56a` on `#62aab8` | 1.59:1 | **禁止**裸金贴桌面 |

## 6. 测试判据

### 6.1 基线（任务 0）

- `pnpm -C apps/client run lint` 0 错误（当前 6 个：TILE 的 `rotate`/`Rotate`，MELD 的 `vertical`/`Rotate`）。
- `pnpm -C apps/client test -- mahjong` 全绿（当前 2 条陈旧断言：`.mj__my-revealed` / `.mj__phase`）。

### 6.2 布局纯函数（`mahjong-layout.test.ts`）

- 保留 7 档视口矩阵 + 1343×1000。
- 1334×750：`centerCard` 在 `centerZone` 内；宽 340、高 170。
- 无副露 / 单家副露 / 上下家都有副露：centerZone 分别为 271 / 218.2 / 165.4；centerCard 170 / 170 / 153.4；`centerCompact=false`。
- 手牌不压自家人像：`hand.rect.left > selfChip.right`；`hand.rect.right ≤ W - outer`。
- 顶牌背 14 张：`tile.w*14 + gap*13 ≤ topBacks.rect.width`。
- 侧牌背槽 `tile.w/tile.h ≈ 4/3`；侧牌河 `tile.w/tile.h ≈ 49/37`。
- `hand.tile.w/h ≈ 3/4`；`centerTiles.claim.w/h ≈ 34/45`。
- 动作区：`actions.maxWidth ≤ actions.rightX - (ownRiver.left+ownRiver.width) - inner`；构造动作矩形与 `ownRiver.rect` 无重叠。
- 所有输出有限正数；不出现 NaN/负尺寸。
- 紧凑只在 `centerCard.height < 144*s` 时触发。

### 6.3 组件（`mahjong-*.test.ts`）

- `MahjongTile`：四方向路径；back；新尺寸类；选中/禁用/置灰；无 `rotate` 残留。
- `MahjongCenter`：
  - `active=true, seconds=12` → 圆盘 12；
  - `active=false, seconds=12` → 圆盘牌墙数；
  - `active=true, seconds=0` → 圆盘牌墙数且无 urgent；
  - `active=true, seconds=5` → urgent 类 + `anim-urgent-pulse`；
  - `ended=true` → 圆盘「终」，`endedText` 仍在次要行；
  - `ended=false, endedText='已胡 1 家'` → 仍显示倒计时/牌墙；
  - claim/ting 渲染；`maxFan` 文案；紧凑模式隐藏听牌。
- `MahjongRiver`：最新牌高亮；可响应描边；点击 emit。
- `MahjongHandBacks`：13/14 张；侧家横槽；已胡亮牌替换。
- `MahjongSeatChip`：圆形头像 frame/clip 结构；角标不被裁切；self 余额有海军蓝底类；活跃态。
- `MahjongBoard`：新主题 token 被引用；旧绿色 token/inset 阴影消失；出牌/胡/过/碰/杠 emit 不变；托管遮罩可取消。
- `ClaimTile`：按钮文案/emit；主/次/过类。

### 6.4 素材（新增 `mahjong-assets.test.ts`）

- 路径用 `helpers/source-scan` 的 `SRC_ROOT`，不用 `import.meta.url`（jsdom 下 file URL 坑）。
- 四方向各 27 张 + `back.png`；文件名 `wan|tong|tiao-{1..9}` 一一对应。
- `manifest.json` 存在；每个文件 sha256 与 manifest 一致；同方向 27 张互不相同。
- 尺寸：my/top 180×240；left/right 240×180。
- 方向抽检（用 `@napi-rs/canvas` 取像素）：
  - `my/wan-1` 红色像素重心在下半部（y>0.5）；
  - `left/wan-1` 红色重心在左半部（x<0.5，顺时针 90° 后「萬」从下转到左）；
  - `right/wan-1` 红色重心在右半部（x>0.5）。
- 不存在未引用 `*z.png`。
- `asset-budget.test.ts` 新增 `table/mahjong ≤ 768 KiB`；判别力自证长度 7。

### 6.5 主题源码闸（新增 `mahjong-theme.test.ts`）

- `MahjongBoard.vue` 样式包含 `$ftl-color-mj-table-light` / `-mid` / `-deep` / `$ftl-color-mj-navy`；
- 不包含 `$ftl-color-mahjong-table`、`rgba(20, 50, 30`、`rgba(0, 25, 12`；
- 不包含 `rotate` / `vertical` 死 prop 残留；
- `uni.scss` 定义全部 `$ftl-color-mj-*` token。

### 6.6 真浏览器/真机

- `pnpm -C apps/client test`、`pnpm -C apps/client run lint`。
- 真浏览器截图：1334×750、1334×1000、1623×750、1778×750；对照天月参考截图检查：
  - 桌面亮青、木框在左/右/下；无旧绿暗角；
  - 白牌/蓝背清晰；牌背与桌面可区分；
  - 中央圆盘倒计时可读，claim/ting 不溢出；
  - 四家牌河/副露/头像/动作区不重叠；
  - 按钮可点，无死按钮；胡按钮海军蓝字。
- App 端模拟器走查一次：PNG 牌面无白边/变形，圆盘/圆头像裁切正常。

## 7. 错误处理与边界

- **素材缺失**：`<image>` 404 显示空白；素材完整性/哈希测试在 CI 拦住；不做运行时兜底图。
- **听牌过多**：右列最多两行，超出 `+N`；不横向滚动。
- **紧凑模式**：卡片高 <144s 时圆盘 90 + 单行文字；隐藏听牌牌面；claim 出文字。
- **倒计时**：`seconds=0` 或非 active 显示牌墙数；不显示 `0s`；urgent 仅在 `active && seconds>0 && <=5`。
- **结束态**：只看 `ended`；`endedText` 不控制终局。
- **侧家已胡亮牌**：沿用 `revealed` 分支；白面 + dim。
- **木框层**：`pointer-events:none`，不拦按钮；顶部被顶栏覆盖是有意。
- **动作区**：不压自家牌河；按钮换行，面板向上长。
- **对比度**：裸文字贴桌面一律禁止；金底文字用海军蓝。

## 8. 风险与有意偏离

| 项 | 等级 | 处置/说明 |
|---|---|---|
| 牌面比例变化导致全量牌位连锁 | 高 | 先改布局纯函数 + 测试，再改组件；1334×750 逐项验算 |
| 中央卡在最差副露下只有 153.4 高 | 高 | 110 圆盘 + 22 顶条 + 12 padding = 144，余 9.4；测试锁 |
| 侧区从 199 宽变 216.3 | 中 | 仍 < 画布 1/4；测试锁 centerZone 宽 |
| 白牌/蓝背与亮青桌面区分 | 中 | 米色边 + drop-shadow；蓝背深于桌面；对比度表 |
| `backdrop-filter` 低端机掉帧 | 中 | 只在小面积按钮/卡片用 blur；桌面不用 blur |
| App 端 PNG 透明边缘 | 中 | 预生成四方向；border-radius 12% + drop-shadow；模拟器走查 |
| 素材体积 | 低 | 量化 64 色，实测 ~4KB/张；总 ~450KB；预算 768KiB |
| 许可 | 低 | FluffyStuff CC0；NOTICE 替换旧声明 |
| 删除 z-suffix | 低 | 全仓 grep 无引用；随素材提交删除 |
| **有意偏离天月** | — | ① 牌背用海军蓝（天月偏中蓝）；② 中央无东南西北/四家分数（四川麻将无此数据，改牌墙/阶段/倒计时）；③ side chip 横排（56px 高度限制）；④ 手牌 104 高（0.88W 约束下最大值）；⑤ 不做二次元立绘 |

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
- `scripts/build-mahjong-tile-set.py`（新增）
- `scripts/assets/mahjong/fluffystuff/*.png` + `LICENSE.txt`（新增 vendored 源图）
- `scripts/extract-mahjong-tiles.mjs`（标记退役）

**文档**

- `THIRD-PARTY-NOTICES.md`
- `apps/client/src/static/ASSETS.md`
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
- `apps/client/test/mahjong-theme.test.ts`（新增）
- `apps/client/test/asset-budget.test.ts`

## 10. 审查记录

独立 reviewer（sonnet，2026-11-02）结论：阻断 3 / 高 9 / 低 14。逐条处置：

| 编号 | 等级 | 结论 | 处置 |
|---|---|---|---|
| B1 中央卡 260×220 装不下内容 | 阻断 | 成立 | 改 340×170；顶条 22 + 圆盘 110 + padding 12 = 144；最差卡高 153.4；右列 210；B1 的像素预算写进 5.2/6.2 |
| B2 紧凑阈值 240 使副露时退化 | 阻断 | 成立 | 阈值改为 `centerCard.height < 144*s`；750 高 + 1/4 副露均非紧凑；矩阵测试锁定 |
| B3 `endedText` 语义读反 | 阻断 | 成立 | 新增 `ended` prop；终态只看 `ended`；`endedText` 降为次要行；补 3 条组件测试 |
| H1 sideBackW 公式矛盾 | 高 | 成立 | 新增 `SIDE_TILE_RATIO=4/3`；`sideBackW=sideBackH*4/3`；测试锁 4/3 与 sideZoneW≈216 |
| H2 seconds/urgent 语义冲突 | 高 | 成立 | 圆盘值改为 `active && seconds>0 ? seconds : wallCount`；urgent 加 `seconds>0`；补 12s/0s 测试 |
| H3 对比度不足 | 高 | 成立 | 5.6 对比度表；金底海军蓝字；桌面裸字加海军蓝底；urgent 改 `#ff8a8a` |
| H4 素材体积不可达 | 高 | 成立 | 改 64 色量化，实测 ~450KB；新增 `table/mahjong` 768KiB 预算；源图体积登记 |
| H5 lietxia 许可失实 | 高 | 成立 | 改用 FluffyStuff CC0；NOTICE 只声明 CC0；不再写 M+ |
| H6 ui-tokens 闸 | 高 | 成立 | 组件只用 `$ftl-color-mj-*`；描边一律 `$ftl-hairline`；写入 5.4 |
| H7 基线红 | 高 | 成立 | 任务 0 修 6 个 TS 错 + 2 条陈旧测试；基线绿后再开工 |
| H8 旧绿色阴影/边框残留 | 高 | 成立 | 5.3 明确删除旧 border + 全部旧绿色 inset 阴影；主题源码闸锁 |
| H9 测试判别力不足 | 高 | 成立 | 新增主题源码闸、素材哈希/方向抽检、hand/self 不重叠、14 张顶背、保留 7 档矩阵 |
| L1 centerZone 270≠264 | 低 | 成立 | 最终 token 下 271；用公式锚点 |
| L2 顶牌背 13 张 495.9 / 14 张溢出 | 低 | 成立 | topBackH 47；14 张 519.5 ≤ 526；测试 14 |
| L3 ting 比例 0.769 | 低 | 成立 | 改 20×27，注明 0.741 |
| L4 素材测试路径/假绿 | 低 | 成立 | 用 `SRC_ROOT`；manifest sha256 + 方向像素抽检 |
| L5 背景层序写反 | 低 | 成立 | 5.3 改为最上层写最前 |
| L6 木框渐变/z-index | 低 | 成立 | border-image + `::before`；顶部被顶栏覆盖有意 |
| L7 动作区压牌河 | 低 | 成立 | D12 收紧 maxWidth；测试无重叠 |
| L8 透明角方形阴影 | 低 | 成立 | border-radius 12% + drop-shadow |
| L9 bar 头像 40×40 | 低 | 成立 | 5.3 明确头像 40×40、bar 卡 40×56 |
| L10 参考特征未覆盖 | 低 | 部分采纳 | 牌背调海军蓝；无东南西北/分数为四川麻将数据限制；side chip 横排为高度限制；手牌 104 为 0.88W 上限；登记为有意偏离 |
| L11 文档/旧脚本/maxFan | 低 | 成立 | NOTICE 替换；旧脚本退役；保留 maxFan 文案 |
| L12 脉冲动画 | 低 | 成立 | 复用 `anim-urgent-pulse`；reduced-motion 已有 |
| L13 测试矩阵缩小 | 低 | 成立 | 保留 7 档 + 1343×1000 |
| L14 vendor 体积未登记 | 低 | 成立 | ASSETS.md 登记源图/输出体积；预算 768KiB |

修订后仍存在的取舍（不修）：

- 中央盘没有天月的东南西北/四家分数环（数据不存在）。
- side chip 保持横排（56px 高度约束）。
- 手牌高度 104（0.88W 约束下的最大值）。
- 牌背用海军蓝而非天月的中蓝（与桌面区分度更好）。
