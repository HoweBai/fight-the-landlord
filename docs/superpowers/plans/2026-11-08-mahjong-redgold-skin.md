# 川麻红金「皮肤 + 动效 + 功能」收口计划（2026-11-08）

> 背景：v13 的几何/交互已实现并部署（`dev-6e4d634`），但 11 任务计划里**没有红金皮肤 pass**；当前牌桌仍是旧深绿皮肤，与已批准的 mockup（`.superpowers/mahjong-redgold/mockup/index.html`）差异大。
>
> 本片只改**客户端展示层**；不改协议/服务端/数据库/admin；不改牌面/牌背图片。

## 0. 决策（mockup 优先）

用户明确「当前效果和 mockup 不大一样」⇒ **视觉值以 mockup 为准**；v5/v6 只在 mockup 未覆盖处生效。冲突登记：

| 项 | mockup | v5/v6 | 本片取 |
|---|---|---|---|
| 牌墙字号 | 48 / 40 | 40 / 32 | **48 / 40** |
| 血战盘金环 | 6px + 外 2px 金棕 | 内缩 3px（2px） | **6px + 外 2px** |
| 盘徽标 | 12px、漆底金边、四角 | 16/14、盘缘 | **12px、漆底金边、四角** |
| 方位点 | 10 / 8，`#6b4a2a` | 10/8 | 同 mockup |
| 状态行 | 14 / 12，`#e8c56a` | 14/12 | 同 mockup（色取 mockup） |
| 座位牌角标 | 左上 1 字 + 左下 2 字 | 右上 1 字 + 左下 2 字 | **mockup（左上）** |
| 分数格式 | 千分位 `15,500` | v4/v5 万压缩；v6 省略 | **千分位 + 省略** |
| 动作按钮 | 24px / 12px 圆角 / 3D 阴影 | 未定 | **mockup** |
| 听 N 位置 | 只在听牌行上方标签 | v4「盘内听 N」 | **mockup（行上标签）** |

## 1. 新增 tokens（uni.scss）

```scss
// 川麻红金（mockup 2026-11-07）
$ftl-color-mj-gold: #d4a24c;          // 已有
$ftl-color-mj-gold-light: #f5d98a;    // 已有
$ftl-color-mj-gold-soft: rgba(212,162,76,.55); // 已有
$ftl-color-mj-lacquer: #1c0808;       // 已有
$ftl-color-mj-cream: #f5e6c8;         // 已有
$ftl-color-mj-urgent: #ff6b5a;        // 已有
$ftl-color-mj-border: #8c6224;        // 金棕边（牌/盘/按钮）
$ftl-color-mj-edge: #a8792e;          // 主按钮描边
$ftl-color-mj-frame: #2b0c0c;         // 外框/牌桌暗部
$ftl-color-mj-highlight: #ffd873;     // 最新牌/亮点
$ftl-color-mj-sheen: #ffe7a8;         // 分数/牌墙数
$ftl-color-mj-muted: #c9a9a0;         // 弱文字
$ftl-color-mj-status: #e8c56a;        // 状态行
$ftl-color-mj-positive: #6fe3a0;      // 正 delta
$ftl-color-mj-bar-top: #2a0e0e;       // 顶栏上沿
$ftl-color-mj-ink: #2b1608;           // 金底深字
$ftl-color-mj-felt-1: #6a2420;
$ftl-color-mj-felt-2: #4a1515;
$ftl-color-mj-felt-3: #2b0c0c;
```

## 2. Task 1：牌桌/顶栏/座位牌/动作区/牌/牌河/胡 banner 皮肤

**Files（modify）：** `MahjongBoard.vue`、`MahjongSeatChip.vue`、`MahjongActionBar.vue`、`MahjongTile.vue`、`MahjongRiver.vue`、`MahjongHuBanner.vue`、`uni.scss`；测试 `mahjong-board.test.ts`、`mahjong-seat-chip.test.ts`、`mahjong-action-bar.test.ts`、`mahjong-tile-meld.test.ts`、`mahjong-river.test.ts`。

**要求：**
1. **牌桌**：`.mj` 底色 `$ftl-color-mj-frame`（#120404 可用 frame 略深）；新增绝对定位的 `.mj__felt` 背景层，位置 `offsetX/offsetY`、尺寸 `1334u×750u`，径向渐变 `felt-1→felt-2→felt-3`，`box-shadow: inset 0 0 0 12u $ftl-color-mj-frame, inset 0 0 0 14u $ftl-color-mj-border`，内圈 1px 金线（`::after`）。不得用旧 `$ftl-color-mahjong-table*`。
2. **顶栏**：`linear-gradient($ftl-color-mj-bar-top, $ftl-color-mj-lacquer)`，底边 `$ftl-hairline` 金（mockup 2px）；返回按钮改为 40×40 金框 + 金色 `‹` 文本（不再用 PNG 箭头）；房间号 22px，场次/底分 16px，颜色 cream/muted；托管/更多改为漆底金边小按钮（不再灰蓝渐变）。
3. **座位牌**：常驻 `rgba(lacquer,.88)` + `$ftl-hairline`（或 2px）`$ftl-color-mj-border` 边 + 12px 圆角；active = 金边 + 12px 辉光；头像 10px 圆角 + 内金环；名字 cream 18；分数 `$ftl-color-mj-sheen` 18 + `tabular-nums` + 千分位；delta 12（正 `positive`，负 `urgent`）；角标漆底金边、左上 1 字 / 左下 2 字。
4. **动作区**：漆底 `rgba(lacquer,.92)` + `$ftl-hairline`（或 2px）`$ftl-color-mj-border` + 12px 圆角 + `box-shadow: 0 4px 0 $ftl-color-mj-border`；主按钮 `linear-gradient($ftl-color-mj-sheen, $ftl-color-mj-gold)` + `$ftl-color-mj-ink` 字 + `$ftl-color-mj-edge` 边；字号 24（窄屏可 20）；幽灵/过 `$ftl-color-mj-muted`。加 `anim-action-slide-in`（0.16s，translateY(12px)→none，backwards）。
5. **牌**：`.mj-tile` 加 `filter: drop-shadow(0 1px 1px rgba(0,0,0,.45))`；最新牌 `outline: 2px solid $ftl-color-mj-highlight; outline-offset: 1px; filter: drop-shadow(0 0 6px rgba(255,216,115,.8))`；claim 来源描边改 `$ftl-color-mj-gold`；+N 改金底 `$ftl-color-mj-gold` + 深字 `$ftl-color-mj-ink` + 16px + 6px 圆角；已胡标签同色系。
6. **胡 banner**：金渐变（sheen→gold）+ 深字 + 金棕边；保留 anchor 居中修复。
7. **测试**：源码/内联断言覆盖上述 token/类/字号；禁止旧绿色 token（`$ftl-color-mahjong-table`）与旧灰蓝按钮渐变出现在麻将组件。

## 3. Task 2：血战盘重构图 + 听牌行标签 + 结算 + 动效缺口

**Files（modify）：** `MahjongHub.vue`、`MahjongBoard.vue`（felt/ting label）、`MahjongHandBacks.vue`、`MahjongRiver.vue`、`MahjongSettlement.vue`、`animations.scss`、`animations.test.ts`、`mahjong-hub.test.ts`、`mahjong-board.test.ts`、`mahjong-hand-backs.test.ts`。

**要求：**
1. **Hub**：正圆 + `6px solid $ftl-color-mj-gold` + `box-shadow: 0 0 0 2px $ftl-color-mj-border, 0 0 28px rgba(gold,.25), inset 0 0 24px rgba(0,0,0,.6)`；径向底 `#3a1414→$ftl-color-mj-lacquer`；牌墙 48/40 `$ftl-color-mj-sheen`；标签 14 `$ftl-color-mj-muted`（数字下方）；秒 22/18 cream；状态 14/12 `$ftl-color-mj-status`；点位 10/8 `#6b4a2a`，亮 `$ftl-color-mj-highlight`；徽标 12 漆底金边、四角（top→右上、left→左上、right→右下、self→左下），**取消绿/蓝语义色**；听 N 文本移除（改到行标签）。
2. **听牌行**：在 `layout.ting` 上方渲染 `听 N 张` 标签（12px、`$ftl-color-mj-sheen`、漆底金边）。
3. **结算**：主按钮改红金（sheen→gold + ink 字）；四行 35ms 错峰（新增 `anim-mj-settlement-row`，`--ftl-delay`），登记 reduced-motion。
4. **动效缺口**：
   - 摸牌位：`translateY(-8u)` + 金边（Board 的 `.mj__hand-tile--drawn`）。
   - 对手背错峰：每张 `--ftl-delay: i*20ms`。
   - 亮牌翻转：River revealed 每张 `anim-reveal-in` + 40ms 错峰。
   - 盘金光：Hub 新增 `flashKey` prop；`>0` 时渲染 `anim-mj-hub-flash` 覆盖层（0.8s，一次性）。
   - 动作「过」收起 0.16s、方位点 0.3s、手牌合拢 0.2s（CSS transition）。
5. **测试**：源码/类/内联断言；animations 闸登记新类；Hub 字号改为 48/40、徽标 12、四角、无绿/蓝。

## 4. Task 3：功能小缺口

**Files（modify）：** `MahjongHub.vue`、`MahjongActionBar.vue`、`MahjongBoard.vue`、`MahjongSeatChip.vue`、`MahjongSettlement.vue`；测试对应。

**要求：**
1. **urgent 只在我方 play 窗口**：`urgent = phase === 'play' && seconds > 0 && seconds <= 5`（v4 §4.5）。补 claim/exchange/lack 不红/不脉动的测试。
2. **动作区待响应牌**：hu 按钮内渲染 20×30 小牌（`option.tile`），保留 `胡` 文本；v5 §2.11。
3. **topMeld k 消费**：Board 给对家副露传 `tileW/overlap/groupGap × river.meld.scale`；补测试（gangHeavy k≈0.99487）。
4. **分数格式**：千分位 + 省略（`toLocaleString`），测试 `4200→4,200`、`15500→15,500`、`null→—`。
5. **发牌轻震**：`useTableSound` 的 `isMahjongGameStart` 分支补 `haptic('light')`。
6. **（可选）`riverWindow`**：补注释说明生产用布局公式；不改 API。

## 5. Global Constraints

- 只改客户端展示层；不动协议/服务端/数据库/admin；牌面/牌背图片不改。
- 旧 `mahjong-layout.ts` 与其测试冻结；布局几何不变（本片只改皮肤/动效/小功能）。
- 每个 Task 先写失败测试（源码/内联/DOM 断言），再实现，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 每个 Task 跑：目标测试 + `ui-tokens` + `animations` + `mahjong-board` 回归；最终全量 `pnpm -C apps/client test`、`lint`、`build`。
- 真实观感（颜色/阴影/动效时长）由真浏览器七档截图验收；机械闸只钉 token/类/字号/无旧色/无多余 infinite。

## 6. 验收

1. 全量测试 + lint + build 绿。
2. 七档 × 6 态截图与 mockup 并排（用户执行）。
3. 无旧绿/旧蓝/旧橙残留（源码扫描）。
4. 部署后 APK / H5 再出包（待用户裁决）。
