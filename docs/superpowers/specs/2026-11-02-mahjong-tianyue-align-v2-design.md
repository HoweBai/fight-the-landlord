# 麻将牌桌「天月对齐 v2」设计 spec

日期：2026-11-02
状态：已对抗审查并修订（v2.1）；待计划
前置：`2026-11-02-mahjong-tianyue-style-design.md`（v1 已实现、部署 `dev-d867cbd`）
本片**取代** v1 的：D5 手牌 104 / 0.88W、D8 中央无四家分数、D3 牌背深海军蓝、§8 的有意偏离。
范围：纯客户端展示层（麻将牌桌）
参考：用户提供的天月麻雀实机截图（1200×676，港麻/川麻界面）

## 1. 背景

v1 上线后用户指出与实机仍有明显差距。采样对比：

| 元素 | 天月实机 | v1 H5 | 结论 |
|---|---|---|---|
| 桌面 | 蓝青 `#79A5BE → #456E8F` | 青绿 `#7CB0BE → #4E7884` | 偏绿、边缘不够蓝 |
| 中央盘 | 炭黑灰 `#44474D` + 金边 | 海军蓝 `#1B2950` | 颜色不对 |
| 牌面 | 冷白 `#EEF0F2` | 米白/奶油 | 偏黄 |
| 牌背 | 亮宝蓝 `#5B7EC0` | 深蓝紫 | 偏暗 |
| 木框 | 深灰棕 `#5A4D42` | 暖棕 | 偏橙 |
| 手牌 | 约 17–18% 屏高 | 13.9% | 偏小 |
| 中央信息 | 四家点数 + 座位/局数 + 圆盘 | 只有牌墙/阶段 + 倒计时 | 缺四家信息 |
| 头像 | 二次元立绘 | 小鸡默认头像 | 用户已选不做角色立绘，保持 |

用户裁决：**都对齐，但按川麻做**——川麻没有东南西北/局数，中央盘放四家**局分 delta** + 庄/缺/听/胡/出局状态 + 倒计时。

## 2. 方案选择

| 方案 | 内容 | 结论 |
|---|---|---|
| A 只调色板 | 蓝青桌面/炭黑中央/冷白牌/亮蓝背/深木框 | 不够：中央信息和手牌比例仍不像 |
| B 调色 + 中央信息 | A + 四家局分/状态 + 中央盘重排 | 接近；手牌仍偏小 |
| C 全对齐（采用） | B + 手牌 116 高 + 自家人像移到手牌上方 | 最接近实机；布局改动可控 |

## 3. 范围

### 做

- 色板：蓝青桌面、炭黑中央盘、蓝灰玻璃 UI、深灰棕木框。
- 牌面重生成：冷白牌面 + 亮宝蓝牌背（灰度着色；64 色量化；约 529KiB）。
- 中央盘重排：炭黑金边；中央 80 圆盘倒计时；上缘牌墙/阶段；左右两列四家局分 + 状态徽标；下缘听牌行（20×27，最多 8 张 + 总数）。
- 可响应牌从中央移到 ClaimTile 面板（面板顶部显示牌面，尺寸真源 `centerTiles.claim`）。
- 手牌 116 高（原 104）；手牌宽度上限 0.88W → 0.95W；自家人像卡移到“中央井左缘、手牌上方”（原“手牌左侧”）。
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
| D2 | 中央盘/ClaimTile 用炭黑 `#3A3D42` / `#4A4D54`；顶栏/座位卡用蓝灰 `#1E3352` / `#2C4270` | 天月中央是炭黑，UI 是蓝灰 |
| D3 | 木框 `#6B5A4A / #5A4D42 / #4A3F36` | 实机是深灰棕 |
| D4 | 牌面：`ImageOps.grayscale(Front)` → `colorize(black #BEC3CD, mid #E8ECF1, white #F0F4FA)` → 恢复 alpha → 叠字形；64 色量化 | 实测低饱和均值约 `[239,243,249]`（B>G>R，11 级明暗），字形颜色不变 |
| D5 | 牌背：`ImageOps.grayscale(Back)` → `colorize(black #233764, mid #5B7EC0, white #A0B2D6)` → 恢复 alpha；64 色量化 | 实测均值约 `[84,118,181]`，旧背 `[44,49,187]` 会被新测试判红 |
| D6 | 中央卡 340×≤145.4；内容 8 padding + 28 顶条 + 80 四家/圆盘 + 27 听牌 = 143；**无布局边框、无 flex gap**；金边用 inset box-shadow | 手牌 116 后最差中央井 153.4，卡高 `min(170, 井高-8)=145.4`；余 2.4 |
| D7 | 四家标签：左右各 100px 列；每列上下两个；[对, 左, 右, 我] → [左上, 左下, 右上, 右下]；前缀 `$ftl-font-mj-mini` 14px，分数 22px，状态 `$ftl-font-mj-badge` 18px；每格 line-height 1 + 22+18=40 高 | 340 内 100+80+100=280；显式 line-height/gap/padding 防止 body 被撑破 |
| D8 | 中央分数 = **杠分/临时分投影**（`pendingScoreChanges` 按 seat 求和），**不是完整局分、也不是钱包余额** | 纯客户端只有这个字段；胡/查叫/花猪在结算才出；自由场有杠时也会非 0。spec/handoff 明确标注 |
| D9 | 状态拆成 `dealer: boolean`（金色“庄”）+ `badge: string`（胡 > 出局 > 听 > 缺X）；渲染为 `庄·缺万` | 庄不再被缺门遮住；两段可分别着色 |
| D10 | 可响应牌移到 ClaimTile 顶部（34×45，尺寸取 `centerTiles.claim`）；预览取**未过滤** options 的第一张 tile | 中央腾给四家；过滤为空时仍能看到牌 |
| D11 | 手牌 116 高；宽度兜底 0.88W → 0.95W | 手牌 15.5% 屏高（可达上限；17–18% 需叠牌，另立片） |
| D12 | 自家人像：`left = centerZone.left`（左家区右缘 + inner），`top = handTop - selfChipH - 20` | 避开左家副露/牌河；手牌选中上浮 10 后仍有 10px 间隙；约 17% 屏宽，接近实机 |
| D13 | 中央卡高度 clamp `井高-8`；`centerCompact` 阈值 143；`compactZone` 阈值 151 | 卡 145.4 >143 → 非紧凑；紧凑分支保留为小画布防御 |
| D14 | 听牌行 20×27，最多 8 张；标签 `听 N 张` 22px；`maxFan` 用 14px 小徽标 | 一行 324 宽放得下；14px 只用于次要 fan |
| D15 | `MahjongCenter` 新增 `seats` prop（必填，默认 []）；移除 `claimTile/claimW/claimH` | 中央只做分数/状态/听牌；可响应归 ClaimTile |
| D16 | 色值全部进 `uni.scss` token；组件不写裸 hex | 现有 ui-tokens 闸 |
| D17 | 本片取代 v1 的 D5/D8/D3 及 §8 相关偏离；在 v1 状态行登记 | 避免两份 spec 取错基线 |
| D18 | ClaimTile 选项改 2 列网格：按钮文案只留 `胡/碰/杠/过`，番数做 14px 小徽标；按钮 min-width 68、gap 6、面板 padding 10 | 4 个 88px 按钮单列会高约 500；2 列约 275，更接近实机横向动作条 |
| D19 | `endedText` 由 Board 在 ended 时传真实文案（`已胡 N 家` / `牌墙摸空` / `本局结束`），不能传空串 | 否则新 Center 的 ended 行永远空白 |
| D20 | 紧凑模式单行 = `牌墙 N · 阶段 · 秒`（有秒时）；不显示 claim 文案 | 移除 claim 后 compact 需新文案 |

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

保留 `glass/gold/cyan/urgent/muted/on-gold/shadow/highlight`；主题闸的 uni.scss 必含列表加 `panel` / `panel-light`。

### 5.2 牌面重生成

`scripts/build-mahjong-tile-set.py`：
- `composed()`：
  ```python
  from PIL import Image, ImageOps
  gray = ImageOps.grayscale(front)
  face = ImageOps.colorize(
      gray, black=(190,195,205), mid=(232,236,241), white=(240,244,250)
  ).convert('RGBA')
  face.putalpha(front.split()[3])
  return Image.alpha_composite(face, glyph)
  ```
- `royal_back()`：
  ```python
  gray = ImageOps.grayscale(back)
  out = ImageOps.colorize(gray, black=(35,55,100), mid=(91,126,192), white=(160,178,214)).convert('RGBA')
  out.putalpha(back.split()[3])
  ```
- 其余（旋转/缩放/64 色量化/manifest）不变；实测牌面低饱和均值约 `[239,243,249]`（11 级明暗）、牌背约 `[84,118,181]`。
- NOTICE 的修改描述加“灰度着色、冷白/宝蓝”。

### 5.3 布局

`mahjong-layout.ts`：
- `handH: 116`；`handRowW = 14×87 + 13×2 + 12 = 1256`。
- `s = max(1, min(h/750, 0.95*w/handRowW))`。
- `selfChip`：
  ```ts
  const selfChip = rect(
    centerZone.left,
    handTop - T.selfChipH * s - 20 * s,
    T.selfChipW * s,
    T.selfChipH * s,
  );
  ```
- 中央卡：`min(170*s, centerZone.height - 8*s)`；宽 340*s。
- `centerCompact = centerCardH < 143*s`；`compactZone = centerZone.height < 151*s`。
- 其余 token/公式不变；`centerTiles.claim` 34×45、`ting` 20×27 保留（ClaimTile/听牌行消费）。

1334×750 验算（s=1）：

| 字段 | EMPTY | WORST |
|---|---|---|
| hand | 39,622,1256,116；tile 87×116 | 同左 |
| selfChip | 224.333,526,56,76 | 同左 |
| centerZone | top 241, height 259 | top 293.8, height 153.4 |
| centerCard | 340×170 | 340×145.4；top 297.8，bottom 443.2 |
| 中央内容 | 8+28+80+27=143 | 143（余 2.4） |
| 左牌河底 / 左副露底 | 490 / — | 475.9 / 592.1 |
| 自己牌河 top | 500 | 447.2 |
| 自家人像 | x 224.3（左副露右缘 216.3，gap 8）；top 526；bottom 602 | 同左 |
| 手牌 top | 622；选中上浮 10 → 612；与人像 gap 10 | 同左 |
| 听牌行 | 27 高；20×27；最多 8 + `听 N 张` | 同左 |

8 档矩阵（EMPTY/WORST）由 plan 给出独立期望表；关键值：
- 1334×750：s=1；hand 39/1256/116；self 224.33/526；centerWorst 153.4/340/145.4；actions 171.67。
- 1334×833/1000/1334：s=1.008997；hand 33.35/1267.3/117.04；self x 226.35；centerEmpty 337.58/343.06/171.53；centerWorst 231.03/343.06/171.53；actions 167.21。
- 1623×750：s=1；hand 183.5/1256/116；center 同 1334×750；actions 316.17。
- 1343×1000：s=1.015804；hand 33.58/1275.85/117.83；self x 227.88；centerEmpty 501.24/345.37/172.69；centerWorst 393.97/345.37/172.69；actions 168.34。

### 5.4 MahjongCenter 重排

Props：
```ts
seats?: Array<{ label: string; score: number; badge: string }>; // [对,左,右,我]
tingTiles?: readonly Tile[];
tingW?: number; // 20
tingH?: number; // 27
maxFan?: number | null;
```
移除 `claimTile/claimW/claimH`。`seats` 默认 `[]`。

模板：
```
.mj-center（炭黑渐变；无布局 border；金边 inset box-shadow；无 gap；padding 4 8）
  .mj-center__strip（28）：牌墙 N · 阶段
  .mj-center__body（80）
    .mj-center__col（100）：上=对家，下=左家
    .mj-center__dial（80）：倒计时/牌墙 + 12 刻度
    .mj-center__col（100）：上=右家，下=自己
  .mj-center__ting（27）：听 N 张 + 最多 8 张 20×27 + 14px 番徽标
```
- 四家格：`prefix` `$ftl-font-mj-mini` 14px（对/左/右/我）+ `score` 22px（`0`/`+1200`/`-800`）；`dealer` 金色“庄” + `badge` `$ftl-font-mj-badge` 18px（胡/出局/听/缺X/空），渲染成 `庄·缺万`；cell `height:40px; line-height:1; gap:0; padding:0`，两格 80。
- 分数格式：`score` 直接显示；`abs >= 100_000` 用 `万` 紧凑（如 `123.5万`）；无 seats 不渲染列。
- 徽标色：胡=金底海军蓝字；听=青底海军蓝字；缺/出局=海军蓝底浅字；庄前缀=金色。
- 听牌：最多 8 张 + `听 {{tingTiles.length}} 张`；`maxFan` 用 `$ftl-font-mj-mini` 14px 金色徽标 `{{maxFan}}番`。
- `ended`：隐藏听牌行，显示 `endedText`（22px）。
- 紧凑：隐藏四家/听牌，只出 90 圆盘 + 单行 `牌墙 N · 阶段 · 秒`（小画布防御）。

### 5.5 ClaimTile 牌面预览

- 新增 `previewW?: number`（默认 34）、`previewH?: number`（默认 45）。
- `source = filteredOptions?.length ? filteredOptions : options`；`previewTile = source.find(o => o.tile)?.tile ?? null`。
- 模板顶部：`可响应` + `MahjongTile`（preview 尺寸）；无 tile 只出文字。
- 选项改 **2 列网格**：按钮文案只留 `胡/碰/杠/过`；番数做 `$ftl-font-mj-mini` 14px 小徽标；按钮 min-width 68、gap 6、面板 padding 10；面板高约 275。
- 面板根类 `mj-claim-tile--panel`；背景 `$ftl-color-mj-panel`；按钮仍金/蓝。
- Board 传 `:preview-w="layout.centerTiles.claim.w"`、`:preview-h="...h"`。

### 5.6 MahjongBoard 接线

`centerProps`（`view` 是 `ComputedRef`，统一用 `props.view?.` 与 `seatView(seat)`）：
```ts
const v = props.view;
const pending = new Map<number, number>();
for (const c of v?.pendingScoreChanges ?? []) {
  pending.set(c.seat, (pending.get(c.seat) ?? 0) + c.delta);
}
const seatScore = (seat: number) => pending.get(seat) ?? 0;
const badgeFor = (seat: number) => {
  const hu = v?.huInfos.some((h) => h.seat === seat) ?? false;
  const out = v?.isOut[seat] ?? false;
  const ting = v?.tingSeats.includes(seat) ?? false;
  const lack = v?.lackSuits[seat] ?? null;
  return hu ? '胡' : out ? '出局' : ting ? '听' : lack !== null ? `缺${MAHJONG_SUIT_NAMES[lack]}` : '';
};
const centerSeats = [
  { label:'对', score: seatScore(topSeat.value), dealer: v?.dealerSeat === topSeat.value, badge: badgeFor(topSeat.value) },
  { label:'左', score: seatScore(leftSeat.value), dealer: v?.dealerSeat === leftSeat.value, badge: badgeFor(leftSeat.value) },
  { label:'右', score: seatScore(rightSeat.value), dealer: v?.dealerSeat === rightSeat.value, badge: badgeFor(rightSeat.value) },
  { label:'我', score: seatScore(me.value), dealer: v?.dealerSeat === me.value, badge: badgeFor(me.value) },
];
// endedText：ended 时传 `已胡 N 家` / `牌墙摸空` / `本局结束`，不得空串
```
- 移除 `claimTile/claimW/claimH` 从 centerProps。
- ClaimTile 传 preview 尺寸。
- 手牌/自家人像用 layout 输出。

### 5.7 手牌/自家人像

- 手牌 116；选中上浮 10；自家人像 bottom 602，选中牌 top 612，gap 10。
- 自家人像 x=centerZone.left；左副露右缘 216.3，gap 8；左牌河底 475.9，人像 top 526，gap 50。
- 手牌 hint top = handTop-20=602；人像 x 224..280，hint 居中，不重叠。
- 托管遮罩/更多按钮随 handTop 调整。

## 6. 测试

### 6.1 布局

- 1334×750 EMPTY/WORST 全量锚点（hand/self/center/actions/leftRiver/leftMeld）。
- 8 档矩阵：s 公式 0.95W；hand/self/center/actions；`selfChip.bottom = hand.top-20`；`selfChip.left ≥ leftMeld.right+7.9`；self 与 leftRiver/leftMeld/ownRiver/hand 无重叠。
- 0.95W 兜底：4:3/方屏手牌 ≤0.95W；s≥1。
- 中央卡内容 143 ≤ 卡高；`centerCompact = cardH <143`；8 档 false。
- 顶牌背 14 张 ≤ 牌河宽；牌河网格放得下；动作区不压自家牌河。

### 6.2 Center

- 四家标签：`label/score/badge` 渲染；0/+/-；`万` 紧凑；空 badge 不渲染。
- badge 组合：`庄·缺万`/`听`/`胡`/`出局`。
- dial/urgent/ended/seconds 语义不变；ended 隐藏听牌、显示 endedText。
- 听牌：最多 8 张 + `听 N 张`；fan 14px；20×27。
- 源码闸：`$ftl-color-mj-panel`；无 `claimTile`；无布局 border；无 gap；字号 token（14px fan/prefix 登记例外）。

### 6.3 Board

- `centerSeats` 映射：局分求和、庄前缀、胡/出局/听/缺优先级；自由场全 0；金币场 +/-。
- ClaimTile 预览：有 tile 出现 34×45 牌；只 pass 无 tile 不出现；过滤为空仍显示第一张。
- 自家人像 style 来自 layout；现有 ended/claim 过滤/托管用例更新。
- 移除 `.mj-center__claim` 假绿断言。

### 6.4 素材

- 精确集合/manifest/方向/back alpha 保持。
- 牌面色温：低饱和亮像素 B≥G≥R，平均 225–250；`my/top` 四角 alpha=0。
- 牌面：低饱和亮像素均值 228–250、B≥G≥R、B-R≥3、亮度标准差 ≥1（防单色平涂）。
- 牌背：中心区域 R≥70、G≥100、|B-181|≤15；四角 alpha=0。

### 6.5 视觉

- 1334×750、1334×1000、1623×750、1778×750、844×390（k=0.52）、claim。
- 对照用户截图：蓝青桌、炭黑中央、冷白牌、亮蓝背、四家局分/状态、手牌 116。
- 重点看最差副露下中央卡 145.4、自家人像/左副露、ClaimTile 预览。

## 7. 错误处理与边界

- `seats` 默认 []；无标签时不渲染列，圆盘居中。
- 局分 0 → `0`；>6 位 → `万` 紧凑；badge 空 → 不渲染。
- 听牌 >8 → 8 张 + `听 N 张`；fan 14px；行高 27。
- ended 优先于听牌。
- 自家人像在 8 档都不压左牌河/左副露/自己牌河/手牌。
- 中央卡在极矮画布走 compact（防御）。

## 8. 风险

| 风险 | 等级 | 处置 |
|---|---|---|
| 手牌 116 + 中央卡 145.4 只余 2.4 | 高 | 组件去 border/gap；源闸 + 真浏览器 1334×750 最差副露截图；不行退 114/圆盘 76 |
| 四家 100px 列 + 22/18 字号 | 中 | 前缀 14、badge 18、余额 6 位内；7+ 位走 `万`；测试组合 |
| 冷白牌面/亮蓝背与桌面区分 | 中 | 色温测试 + 截图；背 B 高 R 低 |
| 自家人像 17% 屏宽 | 中 | 与左副露 gap 8、手牌 gap 10；矩阵测试 |
| ClaimTile 预览加高面板 | 中 | 顶部预计 ~155 >64；不压自家牌河 |
| 局分 delta 不是钱包余额 | 低 | spec/handoff 写明；座位卡仍显示钱包 |
| 14px fan/prefix 打破字号阶 | 低 | 登记为例外；主文本仍 22/18 |

## 9. 涉及文件

- `apps/client/src/uni.scss`
- `scripts/build-mahjong-tile-set.py` + 重新生成 `apps/client/src/pages/table/static/mahjong/**`
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `MahjongBoard.vue` / `ClaimTile.vue`
- 测试：`mahjong-layout.test.ts` / `mahjong-center.test.ts` / `mahjong-board.test.ts` / `mahjong-assets.test.ts` / `mahjong-theme.test.ts` / `mahjong-claim-tile.test.ts`（ClaimTile 源闸/预览在后者）
- 文档：本 spec + plan + handoff；v1 spec 状态行；NOTICE

## 10. 审查记录

独立 reviewer（sonnet，2026-11-02）结论：阻断 3 / 高 9 / 低 10。逐条处置：

| 编号 | 等级 | 结论 | 处置 |
|---|---|---|---|
| B1 自家人像压左家副露 | 阻断 | 成立 | 改 `left=centerZone.left`（左副露右缘 +8）、`top=handTop-76-20`；矩阵测试锁 x/y |
| B2 中央卡漏算 border/gap | 阻断 | 成立 | 去布局 border（金边改 inset box-shadow）、gap=0；内容 143 ≤ 145.4；源闸锁 |
| B3 四角标签 70px 放不下 | 阻断 | 成立 | 列宽 100；余额 22/行高 1、badge 18/行高 1；`庄·缺万`；≥7 位走 `万` |
| H1 牌背 55% 混合达不到目标 | 高 | 成立 | 改灰度+colorize（mid `#5B7EC0`）；实测均值 `[85,119,182]` |
| H2 45% 白混合不冷白 | 高 | 成立 | 改灰度+colorize（mid `#EEF1F4`）；B≥G≥R |
| H3 blend 连 alpha 一起混 | 高 | 成立 | 显式 `putalpha`；加牌面四角 alpha 测试 |
| H4 听牌 14×19/14px 不可读 | 高 | 成立 | 回 20×27、标签 22px、最多 8 张+总数；14px 只留 fan |
| H5 自由场余额 null/非局分 | 高 | 成立 | 中央改用 `pendingScoreChanges` 局分 delta；座位卡保留钱包 |
| H6 0.95W 新锚点未列 | 高 | 成立 | plan 给出 8 档独立期望表；删 `hand.left>selfChip.right`，改 self/hand 间距 |
| H7 庄被缺门遮住 | 高 | 成立 | 庄做前缀（`庄·缺万`），第二状态胡>出局>听>缺 |
| H8 手牌 112 非 17–18% | 高 | 成立 | 改 116（15.5%，0.95W 可达上限附近）；不再声称 17–18% |
| H9 Center 移除 props 回归面 | 高 | 成立 | plan 逐文件列出红/删/新增；删假绿断言；补 ClaimTile 预览单测 |
| L1 验算表混用/旧数字 | 低 | 成立 | 拆 EMPTY/WORST；重算 |
| L2 内部数字矛盾 | 低 | 成立 | 统一 143/18/22/28/80/27；14px 登记 |
| L3 panel token 未进主题闸 | 低 | 成立 | 加 panel/panel-light |
| L4 seats 无默认/isMe 无用 | 低 | 成立 | 默认 []；删 isMe，用 label |
| L5 centerTiles.claim 无消费者 | 低 | 成立 | 传给 ClaimTile preview |
| L6 过滤为空丢预览 | 低 | 成立 | 预览取未过滤 options |
| L7 v2 与 v1 冲突未登记 | 低 | 成立 | v2 写明取代项；v1 状态行加注；NOTICE 更新 |
| L8 ended+ting 同时出现 | 低 | 成立 | ended 隐藏 ting，显示 endedText |
| L9 四角映射歧义 | 低 | 成立 | 四格加 对/左/右/我 前缀 |
| L10 ClaimTile navy 源闸 | 低 | 成立 | 改 panel 闸；列入 §9/plan |
