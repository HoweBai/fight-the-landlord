# 川麻红金「皮肤 + 动效 + 功能」收口计划（2026-11-08，rev 2）

> 背景：v13 的几何/交互已实现并部署（`dev-6e4d634`），但 11 任务计划里**没有红金皮肤 pass**；当前牌桌仍是旧深绿皮肤，与已批准的 mockup（`.superpowers/mahjong-redgold/mockup/index.html`）差异大。
>
> 本片只改**客户端展示层**；不改协议/服务端/数据库/admin；不改牌面/牌背图片；布局几何冻结。
>
> rev 2 采纳对抗审查：发丝线一律 `$ftl-hairline`（禁止裸 `1px`/`line-height: 34px`）；补齐 token；座位牌改两行；主按钮渐变取 `status→gold`；任务重排为 4 个可独立交付的 Task。

## 0. 决策（mockup 优先）

用户明确「当前效果和 mockup 不大一样」⇒ **视觉值以 mockup 为准**；v4/v5/v6 只在 mockup 未覆盖处生效。冲突登记：

| 项 | mockup | 旧 spec | 本片取 |
|---|---|---|---|
| 牌墙字号 | 48 / 40 | v4 48/40；v5/v6 40/32 | **48 / 40** |
| 血战盘金环 | 6px + 外 2px 金棕 | v5 内缩 3px（2px） | **6px border-box + 外 2px** |
| 盘徽标 | 12px、漆底金边、四角、单字 | v6 16/14、盘缘 | **12px、漆底金边、单字（缺/听/胡/托）；四角映射 left TL / right TR / top BR / self BL** |
| 盘 compact 标签 | 显示 | v6 隐藏 | **显示** |
| 方位点 | 10/8，`$ftl-color-mj-dot` | v6 10/8 | 同 mockup |
| 状态行 | 14/12，`$ftl-color-mj-status` | v6 14/12 | 同 mockup（色取 mockup） |
| 座位牌角标 | 10px、6px 圆角；**缺优先左上，状态第二左下；仅状态时左上** | v6 14px、右上/左下 | **mockup 实际槽位** |
| 字体 | Microsoft YaHei / PingFang SC | 全局栈先命中 Segoe UI | **mockup 字体栈（数字形状一致）** |
| 分数格式 | 千分位 `15,500` | v4/v5 万压缩；v6 省略 | **千分位 + 省略** |
| 动作按钮 | 24px / 12px 圆角 / 3D 阴影 / 2×2 84 格 | v4 出牌宽 176 | **mockup（严格 2×2，出牌在右下）** |
| 听 N 位置 | 只在听牌行上方标签 | v4「盘内听 N」 | **mockup（行上标签，Hub 不再显示）** |
| 托管/更多 | 16px muted 纯文字 | 旧按钮 | **mockup（纯文字按钮）** |
| 顶栏层级 | 场次+底分 22 cream；房间 16 muted | 当前三行同字号 | **mockup** |
| 倒计时比例环 | 静态 6px 金环 | v4 claim/exchange/lack 比例 | **静态环**（登记为 mockup 选择） |

## 1. 新增 tokens（uni.scss）

在现有 `$ftl-color-mj-*` 之后追加：

```scss
$ftl-color-mj-border: #8c6224;        // 金棕边（牌/盘/按钮/角标）
$ftl-color-mj-edge: #a8792e;          // 主按钮描边
$ftl-color-mj-frame: #2b0c0c;         // 12px 外框
$ftl-color-mj-stage: #120404;         // 画布留边/底色（比 frame 更深）
$ftl-color-mj-highlight: #ffd873;     // 最新牌/亮点
$ftl-color-mj-sheen: #ffe7a8;         // 分数/牌墙数
$ftl-color-mj-muted: #c9a9a0;         // 弱文字
$ftl-color-mj-status: #e8c56a;        // 状态行/主按钮渐变上沿
$ftl-color-mj-positive: #6fe3a0;      // 正 delta
$ftl-color-mj-bar-top: #2a0e0e;       // 顶栏上沿
$ftl-color-mj-ink: #2b1608;           // 金底深字
$ftl-color-mj-dot: #6b4a2a;           // 方位点底色
$ftl-color-mj-hub-core: #3a1414;      // 血战盘径向中心
$ftl-color-mj-felt-1: #6a2420;
$ftl-color-mj-felt-2: #4a1515;
$ftl-color-mj-felt-3: #2b0c0c;
$ftl-color-mj-gold-line: rgba(212, 162, 76, 0.35);
```

## Task 1: tokens + 牌桌/顶栏/座位牌

**Files（modify）：** `apps/client/src/uni.scss`、`MahjongBoard.vue`、`MahjongSeatChip.vue`；测试 `apps/client/test/ui-tokens.test.ts`、`mahjong-board.test.ts`、`mahjong-seat-chip.test.ts`。

### 1.1 牌桌
- `.mj` 背景改 `$ftl-color-mj-stage`（`#120404`，留边近黑）；**删除**旧多层绿背景与 `border: 3px solid rgba(20,50,30,.85)`（`MahjongBoard.vue:1138-1171`；border 会移动所有绝对子元素）。
- 模板第一个子元素加 `.mj__felt` 背景层（`pointer-events:none`，绝对定位）：
  - 位置 `left: offsetX; top: offsetY; width: 1334u; height: 750u`（`u = layout.u`，用内联 px，不用不存在的 CSS `u` 单位）。
  - 背景 `radial-gradient(ellipse at 50% 46%, $ftl-color-mj-felt-1 0%, $ftl-color-mj-felt-2 46%, $ftl-color-mj-felt-3 100%)`。
  - `box-shadow: inset 0 0 0 calc(12px * var(--mj-u)) $ftl-color-mj-frame, inset 0 0 0 calc(14px * var(--mj-u)) $ftl-color-mj-border`。
  - 内圈金线：第二个绝对定位 `.mj__felt-line`，`inset: calc(12px * var(--mj-u))`，`border: $ftl-hairline solid $ftl-color-mj-gold-line`（mockup 1px → 仓库 R714 强制 2px）。
- 不得再出现 `$ftl-color-mahjong-table*`。

### 1.2 顶栏
- `.mj__bar`：`background: linear-gradient($ftl-color-mj-bar-top, $ftl-color-mj-lacquer)`；`border-bottom: $ftl-hairline solid $ftl-color-mj-gold`；`padding: 0 14px`；`gap: 10px`。
- 左：返回按钮 40×40（覆盖 `.btn--small` 的 min-height），`border: $ftl-hairline solid $ftl-color-mj-gold; border-radius: 10px; color: $ftl-color-mj-gold; font-size: 28px`，用 flex 居中 `‹` 文本（删除 PNG 箭头依赖）；**场次+底分**合成 22px cream 标题（如 `休闲场 · 底分 1`）；房间号 16px `$ftl-color-mj-muted`。
- 右：`托管` / `更多` 改 16px `$ftl-color-mj-muted` 纯文字按钮（透明底、无边框、保留点击热区）；`托管中` 用 `$ftl-color-mj-status`。
- 删除 Board 里旧的灰蓝 `.btn`/`.btn--small` 渐变规则（或仅保留托管取消按钮的漆底金边样式）。

### 1.3 座位牌
- `.mj-chip`：`background: rgba($ftl-color-mj-lacquer, .88)`；`border: $ftl-hairline solid $ftl-color-mj-border`；`border-radius: 12px`；`color: $ftl-color-mj-cream`；`padding: 0 4px`；`overflow: hidden`。
- active strong：`border-color: $ftl-color-mj-gold; box-shadow: 0 0 12px rgba($ftl-color-mj-gold, .55)`；line 只变金边；winner 同 strong。
- 头像：56（self 44），`border-radius: 10px`；内金环 `box-shadow: inset 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, .5)`；背景 `rgba($ftl-color-mj-hub-core, .6)`。
- 两行布局：`.mj-chip__info { flex-direction: column; align-items: flex-start; gap: 2px; }`；
  - 第一行：名字 18px、cream、**normal weight**、ellipsis；
  - 第二行：分数 18px（self 16px）、`$ftl-color-mj-sheen`、`font-variant-numeric: tabular-nums`、ellipsis；delta 12px（self 12px），正 `$ftl-color-mj-positive`、负 `$ftl-color-mj-urgent`。
  - `scoreLabel = balance === null ? '—' : balance.toLocaleString('en-US')`（显式 locale；测试 4200→`4,200`、15500→`15,500`、1234567→`1,234,567`、null→`—`）。
- 角标：**相对牌面**（不再相对 avatar-box），`position:absolute`；1 字槽 `top:0; left:30px`（`--tl`），缺槽 `bottom:0; left:0`（`--bl`）；10px 字、`$ftl-hairline` 金棕边、6px 圆角、`padding: 0 2px`、漆底 cream 字。删除旧绿/蓝/橙语义色。
- self：头像 44、分数 16、delta 12；名字隐藏。

### 1.4 测试
- `ui-tokens` 必须绿（新 token 无裸 hex；无 `1px`）。
- Board：` .mj` 使用 stage token；存在 `.mj__felt` 且 style 含 radial/双层 inset/`var(--mj-u)`；无 `mahjong-table`、无绿色 rgba、无 3px border；bar 渐变/金线；返回按钮 40×40/金框/`‹`；场次+底分 22、房间 16。
- SeatChip：牌面背景/边框/12px 圆角；info `flex-direction: column`；名字/分数 18、self 16；分数千分位 4 例；角标 10px/6px/hairline、位置 `left:30px`/`bottom:0`；无 `$ftl-color-accent`/绿/蓝角标；normal weight（源码断言 `font-weight` 不是 600/700）。

## Task 2: 血战盘重构图 + 听牌标签 + 盘金光 + urgent

**Files（modify）：** `MahjongHub.vue`、`MahjongBoard.vue`、`animations.scss`；测试 `mahjong-hub.test.ts`、`mahjong-board.test.ts`、`animations.test.ts`。

### 2.1 Hub
- 根：`border: 6px solid $ftl-color-mj-gold`（`box-sizing: border-box`，6px 在 200px 内）；`box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-border, 0 0 28px rgba($ftl-color-mj-gold,.25), inset 0 0 24px rgba(0,0,0,.6)`；`background: radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%)`；删除 `.mj-hub__ring` 与内联 `#D4A24C`。
- 牌墙：48/40、`$ftl-color-mj-sheen`、700、tabular；位置 `top:14%`（compact 12%）。
- 标签 `牌墙`：14px、`$ftl-color-mj-muted`、`top:38%`；**compact 也显示**。
- 秒：22/18、cream、`top:48%`。
- 状态：14/12、`$ftl-color-mj-status`、`top:64%`（compact 66%）、ellipsis。
- 听 N：**从 Hub 移除**（改到 Task 2.2 行标签）。
- 方位点：10/8、底色 `$ftl-color-mj-dot`、亮 `$ftl-color-mj-highlight` + `0 0 8px`；位置 2%/50%/98% 四向；`transition: background .3s, box-shadow .3s`。
- 徽标：12px、`padding: 1px 5px`、8px 圆角、漆底金边、cream；**四角**：left→左上、top→右上、right→右下、self→左下；取消 hu/ting/lack/trustee 的绿/蓝语义色。

### 2.2 听牌行标签
- Board 在 `layout.ting` 上方（`top - 18u`）渲染 `听 N 张`：12px、`$ftl-color-mj-sheen`、漆底金边、6px 圆角、`padding: 1px 4px`；Hub 不再显示听 N。

### 2.3 盘金光
- Hub 新增 `flashKey?: number`（默认 0）与 `@flash-done`；`flashKey > 0` 时渲染 `:key="flashKey"` 的 `.mj-hub__flash anim-mj-hub-flash` 覆盖层（absolute inset 0、金环/径向高光、pointer-events none）；`animationend` emit `flash-done`。
- Board：`huFlashKey` 单调键，仅在**新 hu**（`huInfos` 增长且非首版 seed）时自增；`@flash-done` 清零；`prefersReducedMotion()` 时不设置（避免 reduced-motion 下永久残留）。
- `anim-mj-hub-flash`：0.8s 一次性（0% 可见、100% opacity 0），独立规则，登记 reduced-motion；无 infinite。

### 2.4 urgent
- `urgent = phase === 'play' && currentPlayer === selfSeat && seconds > 0 && seconds <= 5`；selfSeat 从 `seats` 的 self 项取。
- 测试：我方 play 4s urgent；claim/exchange/lack 4s 非 urgent；非我方 play 4s 非 urgent。

### 2.5 测试
- Hub：6px border-box/hairline 外环/径向 token；48/40、14、22/18、14/12、12；compact 标签可见；四角徽标映射；无绿/蓝徽标；无 `.mj-hub__ring`；无听 N。
- Board：ting 标签；flashKey 在新 hu 时递增/首版 seed 不闪/reduced-motion 不设；urgent 用例。
- animations：`anim-mj-hub-flash` 在 reduced-motion 清单；独立规则（不分组）。

## Task 3: 牌/牌河/胡 banner/动作区皮肤 + 动效

**Files（modify）：** `MahjongTile.vue`、`MahjongRiver.vue`、`MahjongHuBanner.vue`、`MahjongActionBar.vue`、`animations.scss`；测试 `mahjong-tile-meld.test.ts`、`mahjong-river.test.ts`、`mahjong-action-bar.test.ts`、`animations.test.ts`。

### 3.1 牌
- `.mj-tile:not(.mj-tile--back)` 加 `filter: drop-shadow(0 2px 2px rgba(0,0,0,.45))`；`.mj-tile--dim` 合并 `grayscale(.6) drop-shadow(...)`（避免覆盖丢阴影）；牌背不加 filter（性能）。
- selected 金边改 `$ftl-color-mj-gold`。

### 3.2 牌河
- `.mj-river__tile--latest`：`outline: $ftl-hairline solid $ftl-color-mj-highlight; outline-offset: 0; filter: drop-shadow(0 0 6px rgba(255,216,115,.8))`。
- `.mj-river__tile--filtered`：`outline: $ftl-hairline solid $ftl-color-mj-gold; outline-offset: 0`（不再用 `$ftl-color-primary` 蓝）。
- `+N`：改为内容尺寸药丸（`padding: 2px 4px`、6px 圆角、金底 `$ftl-color-mj-gold`、深字 `$ftl-color-mj-ink`、16px、700），仍绝对定位在 `badgeRect` 中心（`left/top + 50% + translate(-50%,-50%)`），不铺满整格。
- 已胡标签移到河内底部（`bottom: 0`），金底深字。
- **移除**副露的 `碰/杠/暗杠` 标签（mockup 无；布局仍保留副露）。
- 亮牌翻转：River 新增 `revealNonce?: number`；Board 在**新 reveal**（`revealedHands` 增长/新座位）时自增，首版 seed 不设；revealed 每张加 `anim-reveal-in` + `--ftl-delay: i*40ms`；`anim-reveal-in` 已存在（0.46s），登记为 0.46 vs v4 0.8 的偏差。

### 3.3 动作区
- 严格 2×2 84px：取消 play 的 176px 宽按钮；出牌在右下格（`grid-column:2; grid-row:2`），胡/杠在其它格；保持 claim 4 格、exchange 宽按钮例外（换三张仍可宽，mockup 未覆盖 exchange）。
- 按钮：漆底 `rgba($ftl-color-mj-lacquer,.92)`、`$ftl-hairline` 金棕边、12px 圆角、24px/700 cream、`box-shadow: 0 4px 0 $ftl-color-mj-border`。
- 主按钮：`linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold)` + `$ftl-color-mj-ink` 字 + `$ftl-color-mj-edge` 边。
- 过/幽灵：`$ftl-color-mj-muted`、漆底半透明。
- 入场：根加 `anim-action-slide-in`（0.16s，translateY(12px)→none，backwards）；登记 reduced-motion；独立规则。
- 待响应牌：hu 按钮内渲染 20×30 小牌（`option.tile`）+ `胡` 文本；无 tile 时只文本。
- 过收起：**登记为不做**（v4 FLIP 已否决，Vue Transition 在 App 端未验证）；只保留按钮即时移除。

### 3.4 胡 banner
- 金渐变 `linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold)`、`$ftl-color-mj-ink` 字、`$ftl-color-mj-edge` 边、金棕阴影；保留 anchor 居中修复。

### 3.5 测试
- Tile：face-up drop-shadow、dim 合并、selected 金 token。
- River：latest outline/offset 0/高亮 token；filtered 金；+N 药丸/金底/深字/16；已胡底部；无 meld label；reveal 类/延迟/seed 不播。
- ActionBar：2×2 84（play 出牌右下）、主按钮渐变 token、3D 阴影、24px/12px、slide-in 类、待响应小牌图片、过非 primary。
- animations：slide-in/reveal 登记 reduced-motion；无 grouped selector 依赖。

## Task 4: 功能小缺口 + 结算 + claimSourceMeldKey + 最终扫描

**Files（modify）：** `MahjongBoard.vue`、`MahjongRiver.vue`、`MahjongMeld.vue`、`MahjongActionBar.vue`、`MahjongHub.vue`、`useTableSound.ts`、`MahjongSettlement.vue`；测试 `mahjong-board.test.ts`、`mahjong-river.test.ts`、`mahjong-tile-meld.test.ts`、`mahjong-action-bar.test.ts`、`mahjong-hub.test.ts`、`audio.test.ts`、`mahjong-claims.test.ts`、新增 `mahjong-settlement.test.ts`。

### 4.1 rob 副露高亮
- Board 把 `claimSrc.claimSourceMeldKey` 传给来源 River；River 对匹配 key 的 meld 传 `highlight`；Meld 新增 `highlight?: boolean`，高亮写 `outline: $ftl-hairline solid $ftl-color-mj-gold; outline-offset: 1px`（不占布局）。
- 测试：rob 窗口 key 传给对应 River；Meld `highlight` 类/描边；非 rob 不传。

### 4.2 topMeld k
- Board 对**对家**副露：`meldTileW = river.meld.tileW * river.meld.scale`、`meldOverlap = river.meld.overlap * scale`、`meldGroupGap = river.meld.groupGap * scale`；**tileH 不乘 k**（v12 §3）。
- 测试：gangHeavy `scale≈0.99487` 时传入的宽度=raw×k；tileH 不变。

### 4.3 结算
- 主按钮：红金 `linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold)` + ink 字 + edge 边；`再来一局` 使用。
- 四行 35ms 错峰：每行加 `anim-mj-settlement-row` + `--ftl-delay: i*35ms`；新增 keyframe（0.24s，translateY(8px)→none，backwards）；登记 reduced-motion。
- 新增 `mahjong-settlement.test.ts`：主按钮 class/渐变 token 源码断言；行 `--ftl-delay` 断言；reduced-motion 登记。
- 结算橙色 detail 按钮 **不在本片范围**（v4 §3 只要求主按钮 + 行错峰）；最终扫描排除它们并注明。

### 4.4 发牌轻震 + 分数 6 位
- `useTableSound` 的 `isMahjongGameStart` 分支补 `haptic('light')`；`audio.test.ts` 断言 `vibrateShort` 计数。
- SeatChip 6 位分数用例（`1,234,567`）加入 Task 1 的测试（若 Task 1 已覆盖则不重复）。

### 4.5 旧色最终扫描
- 新增/扩展源码闸：扫描 `apps/client/src/components/table/mahjong/**` + `MahjongSettlement.vue`（仅主按钮范围），禁止：
  - `$ftl-color-mahjong-table`、`rgba(20, 50, 30`、`rgba(40, 76, 51`、`rgba(23, 50, 33`、`rgba(60, 110, 75`、`rgba(35, 75, 50`、`rgba(120, 130, 150`、`rgba(74, 222, 128`、`rgba(120, 170, 255`、`rgba(255, 180, 60`、`rgba(220, 100, 30`；
  - `$ftl-color-primary` 仅允许出现在非麻将组件；麻将组件内禁止；
  - `$ftl-color-accent` 在 SeatChip/Hub 禁止。
- 明确豁免：Settlement 的 detail/events 橙色按钮（v4 §3 范围外）；`MahjongBoard` 的托管遮罩若保留通用黑金？Task 1 已改红金，扫描覆盖。

## Global Constraints

- 只改客户端展示层；不动协议/服务端/数据库/admin；牌面/牌背图片不改。
- 旧 `mahjong-layout.ts` 与其测试冻结；布局几何不变（本片只改皮肤/动效/小功能）。
- 发丝线一律 `$ftl-hairline`；禁止裸 `1px`、禁止 `line-height: 34px`（unitless 闸）；组件 `<style>` 禁止裸 hex（用 token 或 `rgb()/rgba()`）。
- 每个 Task 先写失败测试（源码/内联/DOM 断言），再实现，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 每个 Task 跑：目标测试 + `ui-tokens` + `animations` + `mahjong-board` 回归；最终全量 `pnpm -C apps/client test`、`lint`、`build`。
- 新 `anim-*` 全部登记 reduced-motion；动画闸的 `parseAnimRules` 只捕获分组最后一个选择器 ⇒ 新类写成独立规则。

## 验收

1. 全量测试 + lint + build 绿。
2. 七档 × 6 态截图与 mockup 并排；重点：`1334×833/1000/1334`（留边）、`1623/1778×750`（宽留边）、非 16:9 座位牌（6 位分数不截断）、`top29`（盘徽标四角）。
3. 旧色扫描绿（范围见 4.5，Settlement 橙色 detail 豁免）。
4. 真机走查：摸牌位、动作滑入、对手背错峰、亮牌翻转、盘金光、胡 banner、结算。
5. 部署 / APK 重打（待用户裁决）。
