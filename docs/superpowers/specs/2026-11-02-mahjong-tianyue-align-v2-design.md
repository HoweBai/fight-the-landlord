# 麻将牌桌「天月对齐 v2」设计 spec

日期：2026-11-02
前置：`2026-11-02-mahjong-tianyue-style-design.md`（第一片已实现、部署 `dev-d867cbd`）
状态：待对抗审查
范围：纯客户端展示层（麻将牌桌）
参考：用户提供的天月麻雀实机截图（1200×676，港麻/川麻界面）

## 1. 背景

第一片把牌桌换成了天月风，但用户刷新 H5 后指出与实机截图仍有明显差距。采样对比：

| 元素 | 天月实机 | 第一片 H5 | 结论 |
|---|---|---|---|
| 桌面 | 蓝青 `#79A5BE → #456E8F` | 青绿 `#7CB0BE → #4E7884` | 偏绿、边缘不够蓝 |
| 中央盘 | 炭黑灰 `#44474D` + 金边 | 海军蓝 `#1B2950` | 颜色不对 |
| 牌面 | 冷白 | 米白/奶油 | 偏黄 |
| 牌背 | 亮宝蓝 `#5B7EC0` | 深蓝紫 | 偏暗 |
| 木框 | 深灰棕 `#5A4D42` | 暖棕 | 偏橙 |
| 手牌 | 约 17–18% 屏高 | 13.9% | 偏小 |
| 中央信息 | 四家点数 + 座位/局数 + 圆盘倒计时 | 只有牌墙/阶段 + 倒计时 | 缺四家信息 |
| 头像 | 二次元立绘 | 小鸡默认头像 | 用户已选不做角色立绘，保持 |

用户裁决：**都对齐，但按川麻做**——川麻没有东南西北/局数，中央盘放四家余额 + 庄/缺/听/胡/出局状态 + 倒计时。

## 2. 方案选择

| 方案 | 内容 | 结论 |
|---|---|---|
| A 只调色板 | 蓝青桌面/炭黑中央/冷白牌/亮蓝背/深木框 | 不够：中央信息和手牌比例仍不像 |
| B 调色 + 中央信息 | A + 四家余额/状态 + 中央盘重排 | 接近；手牌仍偏小 |
| C 全对齐（采用） | B + 手牌 112 高 + 自家人像移到手牌上方 | 最接近实机；布局改动可控 |

## 3. 范围

### 做

- 色板：蓝青桌面、炭黑中央盘、蓝灰玻璃 UI、深灰棕木框。
- 牌面重生成：冷白牌面 + 亮宝蓝牌背（64 色量化，仍约 588KiB）。
- 中央盘重排：炭黑金边；中央 90 圆盘倒计时；上缘牌墙/阶段；左右四角四家余额 + 状态徽标；下缘听牌行。
- 可响应牌从中央移到 ClaimTile 面板（面板顶部显示牌面）。
- 手牌 112 高（原 104）；手牌宽度上限 0.88W → 0.95W；自家人像卡从“手牌左侧”移到“手牌上方、左牌河下方”。
- 布局/组件/测试同步。

### 不做

- 不做二次元角色立绘；头像仍用 `default.png`。
- 不改协议/服务端/数据库/admin。
- 不引入东南西北/局数（川麻无此数据）。
- 不重做结算页（仍只保留主按钮文字色）。
- 不新增网络/计时器/游戏数据字段。

## 4. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 桌面 `#7FA8C0 → #5C93AC → #436C87` | 对齐实机蓝青；仅改 3 个 token |
| D2 | 中央盘 `#3A3D42` / `#4A4D54` 炭黑；蓝灰玻璃 `#1E3352` / `#2C4270` 用于顶栏/座位卡 | 天月中央是炭黑，不是海军蓝；UI 保持蓝灰 |
| D3 | 木框 `#5A4D42 / #6B5A4A / #4A3F36` | 实机是深灰棕 |
| D4 | 牌面：`Front.png` 与冷白 `#F8FAFC` 混合 45% 后再叠字形；字形颜色不变 | 冷白牌面，字色仍饱和 |
| D5 | 牌背：HSV 色相 +170 后与宝蓝 `#4A6BB5` 混合 55%，再提亮 10% | 目标 `#5B7EC0` 亮宝蓝 |
| D6 | 中央卡 340×≤149.4；内容 8 padding + 28 顶条 + 90 圆盘 + 19 听牌 = 145 | 手牌 112 后最差中央井 157.4，卡高 `min(170, 井高-8)=149.4`；余 4.4 |
| D7 | 中央四角标签 = 四家余额 + 单状态徽标；位置 [对家, 左家, 右家, 自己] → [左上, 左下, 右上, 右下] | 川麻没有风位；用余额 + 状态 |
| D8 | 徽标优先级：胡 > 出局 > 听 > 缺X > 庄 > 空 | 只显示一个，避免挤爆 |
| D9 | 可响应牌移到 ClaimTile 面板顶部（34×45 预览） | 中央盘腾给四家信息；ClaimTile 已有牌数据 |
| D10 | 手牌 112 高；s 公式宽度兜底 0.88W → 0.95W | 手牌约 14.9% 屏高，接近实机；自家人像移走后不再需要 0.88W 左边距 |
| D11 | 自家人像卡移到 `x=左牌河左边`、`y=handTop-selfChipH-inner` | 手牌上方、左牌河下方；不压左家牌背（x 错开） |
| D12 | 中央卡高度 clamp 从 `井高-12` 改 `井高-8` | 给 149.4 卡高留空间；上下各 4px |
| D13 | `MahjongCenter` 新增 `seats` prop；移除 `claimTile/claimW/claimH` | 中央只做分数/状态/听牌；可响应归 ClaimTile |
| D14 | 听牌仍留在中央下缘一行（14×19，最多 12 张 + `+N`） | 不新增悬浮组件；一行能放进 340 宽 |
| D15 | 色值全部进 `uni.scss` token；组件不写裸 hex | 现有 ui-tokens 闸 |

## 5. 实现设计

### 5.1 色板（uni.scss）

```scss
$ftl-color-mj-table-light: #7fa8c0;
$ftl-color-mj-table-mid: #5c93ac;
$ftl-color-mj-table-deep: #436c87;
$ftl-color-mj-panel: #3a3d42;
$ftl-color-mj-panel-light: #4a4d54;
$ftl-color-mj-navy: #1e3352;
$ftl-color-mj-navy-light: #2c4270;
$ftl-color-mj-wood-light: #6b5a4a;
$ftl-color-mj-wood-mid: #5a4d42;
$ftl-color-mj-wood-deep: #4a3f36;
```

保留 `glass/gold/cyan/urgent/muted/on-gold/shadow/highlight` 不变；中央盘/ClaimTile 用 `panel`，顶栏/座位卡用 `navy`。

### 5.2 牌面重生成

`scripts/build-mahjong-tile-set.py`：
- `composed()`：先 `Image.blend(Front, #F8FAFC, 0.45)`（保留 Front alpha），再叠字形。
- `navy_back()` → `royal_back()`：HSV +170 → 与 `#4A6BB5` 混合 55% → 与白混合 10% → 保留源 alpha。
- 其余（旋转/缩放/64 色量化/manifest）不变。
- 目标：牌面接近 `#F6F8FA`，牌背接近 `#5B7EC0`。

### 5.3 布局

`mahjong-layout.ts`：
- `handH: 112`。
- `s = max(1, min(h/750, 0.95*w/handRowW))`；`handRowW` 按 112 重算 = 14×84 + 13×2 + 12 = 1214。
- `selfChip`：
  ```
  left = outer + sideBackW + inner   // = 左牌河左缘
  top  = handTop - T.selfChipH*s - inner
  ```
- 中央卡高：`min(170*s, centerZone.height - 8*s)`；宽仍 340。
- 其余 token/公式不变。

1334×750 验算（s=1）：

| 字段 | 值 |
|---|---|
| hand | left 60, top 626, width 1214, height 112；tile 84×112 |
| selfChip | left 65.333, top 542, 56×76 |
| centerZone（WORST） | top 293.8, bottom 451.2, height 157.4 |
| centerCard | left 497, top 297.8, width 340, height 149.4 |
| 中央内容 | 8 + 28 + 90 + 19 = 145（余 4.4） |
| 左牌河底 | 496；自家人像 top 542（gap 46） |
| 左牌背底 | 584；自家人像 x 65.3（左牌背右缘 57.3）→ 不重叠 |
| 自己牌河底 | 451.2；中央卡底 447.2（gap 4） |

### 5.4 MahjongCenter 重排

新 props：
```ts
seats: Array<{ balance: number | null; badge: string; isMe?: boolean }>; // [对家, 左家, 右家, 自己]
tingTiles?: readonly Tile[];
tingW?: number; // 14
tingH?: number; // 19
maxFan?: number | null;
```
移除 `claimTile/claimW/claimH`。

模板：
```
.mj-center（炭黑 + 双金边）
  .mj-center__strip（28）：牌墙 N · 阶段
  .mj-center__body（90）
    .mj-center__seats--left（70）：上=对家，下=左家
    .mj-center__dial（90）：倒计时/牌墙 + 12 刻度
    .mj-center__seats--right（70）：上=右家，下=自己
  .mj-center__ting（19）：听（N 番）+ 最多 12 张 14×19 + “+N”
```
- 四家标签：余额 22px 金色；徽标 22px（`$ftl-font-xs`）；余额 null → `—`。
- 徽标色：胡=金底海军蓝字；出局/缺=海军蓝底浅字；听=青底；庄=金底。
- 听牌行标签用 14px 字面量（行高 19；仓库字号阶最小 22px，此行是刻意紧凑）。
- `hasSide` 删除；四家标签始终渲染。
- `ended` 仍显示「终」；`endedText` 放听牌行位置。
- 紧凑：保留，但设计最小画布下不触发；compact 时隐藏四家标签、只出圆盘+文字。

### 5.5 ClaimTile 牌面预览

- 面板顶部：`可响应` + `MahjongTile`（取 `sortedOptions[0]?.tile`，34×45）。
- 无 tile 的选项（pass）不预览。
- 面板宽度仍受 actions maxWidth 172；tile 34 + 文案 66 + gap 6 = 106，放得下。

### 5.6 MahjongBoard 接线

- `centerProps`：
  ```
  seats: [top, left, right, self].map(seat => ({
    balance: balances[seat] ?? null,
    badge: badgeFor(seat),
    isMe: seat === me,
  }))
  ```
- `badgeFor(seat)`：胡 > 出局 > 听 > 缺X > 庄 > ''。
- 移除 `claimTile/claimW/claimH`；`ClaimTile` 已有 options，不需要新 prop。
- 手牌/自家人像新位置由布局函数输出，Board 不写死。

### 5.7 手牌/自家人像

- `MahjongBoard` 的 `handStyle`/`selfChip` 使用新布局输出。
- 手牌 hint/托管遮罩的 bottom 计算随 handTop 变化。
- 自家人像 variant='self' 仍 56×76；显示头像 + 余额胶囊；不再需要左边距，手牌可 0.95W。

## 6. 测试

### 6.1 布局（mahjong-layout.test.ts）

- 1334×750：hand 60/626/1214/112；selfChip 65.333/542/56/76；centerCard 340×149.4；centerZone 157.4。
- 8 档视口矩阵：s 公式 0.95W；手牌/中央卡/自家人像/牌河/侧区不重叠；自家人像在左牌河下方、左牌背右侧。
- `selfChip.bottom <= hand.top`；`selfChip.left > leftBacks.right`；`selfChip` 与 `leftRiver.rect` 无重叠。
- 顶牌背 14 张仍 ≤ 牌河宽；中央卡内容 143 ≤ 卡高。
- 0.95W 兜底：4:3/方屏手牌宽度 ≤0.95W；s≥1。

### 6.2 Center（mahjong-center.test.ts）

- 四家标签：balance 渲染、null→—、badge 渲染；余额/徽标 22px。
- dial/urgent/ended/seconds 语义不变。
- 听牌行 14×19、最多 12 + `+N`；`maxFan` 文案。
- 无 claim 相关断言（移除）。
- 源码闸：`$ftl-color-mj-panel`；无 `claimTile`；字号走 token。

### 6.3 Board（mahjong-board.test.ts）

- `centerSeats` 映射：庄/缺/听/胡/出局优先级；余额对位。
- ClaimTile 顶部牌面预览：claim 选项有 tile 时出现 34×45 牌；无 tile 不出现。
- 自家人像新位置由 layout 输出（style 断言）。
- 现有 ended/claim 过滤/托管用例更新。

### 6.4 素材（mahjong-assets.test.ts）

- 保持精确集合/manifest/方向/back alpha。
- 新增色温抽检：`my/wan-1` 牌面背景（四角内一点）R≈G≈B 且亮度 > 230；`my/back` 主色蓝分量 > 红/绿分量，接近 `#5B7EC0`（容差 ±25）。

### 6.5 视觉

- 1334×750、1334×1000、1623×750、1778×750、844×390（k=0.52）、claim。
- 对照用户截图：桌面蓝青、中央炭黑、冷白牌、亮蓝背、四家余额在中央。
- 重点看 1334×750 最差副露下中央卡 149.4 是否裁切。

## 7. 错误处理与边界

- 四家余额 null → `—`；badge 空 → 不渲染。
- 听牌 >12 → 12 + `+N`；听牌行高 19，超出隐藏；标签 14px 是刻意紧凑。
- 中央卡在极矮画布仍走 compact（防御分支）。
- 自家人像在 4:3/方屏随 s 缩放；不压左牌河/左牌背。
- 手牌 0.95W 在 1334×750 左 60、右 1274，离木框 60px。
- 颜色/素材失败：素材色温测试拦住；组件 token 闸拦住。

## 8. 风险

| 风险 | 等级 | 处置 |
|---|---|---|
| 手牌 112 + 中央卡 149.4 在 1334×750 最差副露下只余 4px | 高 | 布局测试锁；真浏览器 1334×750 截图；不行则圆盘 84 / 顶条 24 |
| 四家标签 + 余额在 340 宽内挤 | 中 | 左右列 70；余额 22px；徽标 18px；截图验收 |
| 牌面冷白后字色/红绿对比变化 | 中 | 只混合 Front，不动字形；素材截图验收 |
| 牌背变亮与桌面区分度下降 | 中 | 背 `#5B7EC0` vs 桌面 `#5C93AC`；背更深/更蓝；截图验收 |
| 自家人像移到手牌上方后压左牌河 | 中 | x=左牌河左边、y=左牌河底+46；布局测试锁不重叠 |
| ClaimTile 顶部加牌面后面板更高 | 中 | 面板可向上长；actions bottomY 626；顶部预计 119，仍 >64 |
| 0.95W 手牌在超宽屏留白变化 | 低 | 矩阵测试；超宽屏 s=1，手牌仍居中 |

## 9. 涉及文件

- `apps/client/src/uni.scss`
- `scripts/build-mahjong-tile-set.py` + 重新生成 `apps/client/src/pages/table/static/mahjong/**`
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `MahjongBoard.vue` / `ClaimTile.vue` / `MahjongTile.vue`（尺寸不变）
- 测试：`mahjong-layout.test.ts` / `mahjong-center.test.ts` / `mahjong-board.test.ts` / `mahjong-assets.test.ts` / `mahjong-theme.test.ts`
- 文档：本 spec + plan + handoff

## 10. 审查记录

（待独立 reviewer 审查后填写）
