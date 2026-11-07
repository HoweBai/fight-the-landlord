# 川麻红金牌桌重做 —— 实现交接（2026-11-07）

分支：`dev`　基线：`3f0dc4c7`　实现区间：`3f0dc4c7..e5a003df`（18 提交，含交接与终审修复）
计划：`docs/superpowers/plans/2026-11-07-mahjong-table-redgold.md`
设计：`docs/superpowers/specs/2026-11-07-mahjong-table-redgold-design-v13.md`（v12 及更早为继承）

## 1. 交付内容（Task 1–11）

| Task | 提交 | 交付 |
|---|---|---|
| 1 | `ead384d3` | `mahjong-layout-v2.ts`：固定 1334×750 构图、`u=min(W/1334,H/750)` + 居中 offset、四河窗口/侧河 1 列规则/侧副露 lane/听牌/banner 锚点 |
| 2 | `75ea8a19` `bef98bba` | `mahjong-claims.ts`（visibleDiscards/riverWindow/claimSource/visibleIndexMap）、`mahjong-keys.ts`（seat-scoped meldKey） |
| 3 | `dcd56254` | `MahjongTile.mode`（aspectFit/aspectFill）、`MahjongMeld.vertical`、暗杠 aspectFill |
| 4 | `cec9e559` | River 窗口 slice、+N 徽标、claimSourceIndex 单张描边/点击、revealed、局部坐标 meldRect/laneWidth |
| 5 | `20698a53` | `MahjongHub`：牌墙/倒计时/四向点/每座徽标（胡>听>缺>托管）/状态行/听 N；无分数、无中央 claim 牌 |
| 6 | `b125402a` `2005b323` | SeatChip 四变体/两角标槽/静态金边/无张数；发丝线走 `$ftl-hairline`、分数省略 |
| 7 | `586d847d` | `MahjongActionBar`：2×2 / 84px、claim 单过、多杠「杠 N」选择器、rob 胡按钮带待响应牌 |
| 8 | `d1ca845b` `1c7e76fb` | Board v2 装配：layout v2、visibleDiscards、claimSource、lastDiscardAbs、dealEpoch/dealNonce、bannerSeq/reduced-motion、Hub/ActionBar/River/SeatChip 接线；删除 Center/ClaimTile |
| 9 | `d0dd1f3f` `2fbd545a` | 音效：MjShuffle 局首、MjDeal 首次 play 闩锁、MjSort 摸牌/claim/选牌/出牌、副露按 meldKey 区分补杠/直杠、胡重震 |
| 10 | `59c1c620` | 红金 tokens、四个新 `anim-*`、唯一 infinite=`anim-claim-pulse`、暗杠金边、动效机械闸 |
| 11 | 本文档 | 全量验证与交接 |

## 2. 验证证据（本机，2026-11-07）

```text
pnpm -C apps/client test   → 130 passed | 2 skipped（文件）；1854 passed | 2 skipped（用例）
pnpm -C apps/client lint   → vue-tsc --noEmit exit 0
pnpm -C apps/client build  → DONE Build complete（exit 0，版本串 0.1.0-e5a003df）
node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs → ALL GREEN
```

- 冻结文件 `apps/client/src/game/mahjong-layout.ts` 与其测试**未改动**。
- 每个 Task 均经独立子 agent 审查（spec 合规 + 代码质量）；Critical/Important 已修复并复审通过。
- **全片终审（opus）**：无 Critical；2 条 Important（侧河 +N 徽标对齐、胡 banner 锚点居中）已在 `53213cea` 修复并补测试；终审结论「With fixes」→ 修复后关闸。其余 Minor 分诊见 §5。

## 3. 控制器决议（与计划文本的偏差，均已记录）

1. **布局输出四舍五入 2 位小数**：计划 Task 1 的 `toEqual` 精确值要求；纯展示层，无用户可见影响。
2. **Center/ClaimTile 的删除推迟到 Task 8**：Task 5/7 删除会让 Board 引用悬空；Task 8 重接 Board 时一并删除。
3. **`visibleDiscards` 逐座计数**：计划伪代码的 `source` 未定义；按 v12 §1 增加 `opts.seat`，`sourceSeat` 仅来源河传入。
4. **发丝线 1px → `$ftl-hairline`（2px）**：仓库 R714 闸禁止裸 1px（画布缩放会让 1px 不可见），覆盖设计措辞；line 与 winner 因此同为 2px 金边。
5. **出牌音效用 MjSort**：v4 §6.2 写 MjDeal，但 v5 §2.3 / v6 §4 / 计划 Task 9 写 MjSort（更新的权威）；同时补上「选牌 MjSort」（Board `select` → table.vue）。
6. **Hub 不渲染中央 claim 牌**：v13 §10.2 由 ActionBar 的胡按钮显示待响应牌。

## 4. 已知边界 / 残留

1. **七档截图与真机走查未执行**（计划 Task 11 Step 4/5）：需要真实浏览器/App 与对局数据；本文档不伪造截图结论。建议按 `1334×750 / 1500×750 / 1623×750 / 1778×750 / 1334×833 / 1334×1000 / 1334×1334` × `normal / top29 / twoSurvivors / gangHeavy / revealedGang / overlayWorst` 走查，并与 `.superpowers/mahjong-redgold/mockup/` 并排。
2. **`claimSourceMeldKey` 已派生但无组件消费**：v12 §2 的「rob 高亮杠家那组碰」未落地（River/Meld 没有 highlight 入参）；rob 的「不描边任何河牌 + 胡按钮显示待响应牌」已满足。视觉增强，可在后续小片补。
3. **观感未验证**：发牌径向/落桌回弹/紧迫脉动/claim 呼吸的时长与观感只能真浏览器确认；机械闸只钉「类存在、fill 模式、唯一 infinite、reduced-motion 登记」。
4. **`anim-discard-land` 在窗口滑动时随节点 key 重播一次**（与 latest 类既有行为同域）。
5. **双击出牌可能连续触发 MjSort**（选牌 + 服务端确认出牌同 cue）；`playCue` 为 latest-wins，不叠加。
6. **服务端一炮多响删多张真弃牌**：客户端按新 view 全量重算，无法恢复；已登记为已知边界（另立片）。
7. 其余 Minor 清单见 §5，均不阻塞。
8. **分数省略口径（v6 §3.4 覆盖 v3/v4/v5 的「万」压缩）**：座位/结算分数一律省略号截断，不做 `N万` 格式化。
9. **座角徽标优先级（v6 重裁槽位；v4 排名不再沿引）**：胡 > 听 > 托 > 庄（右下角另挂「缺X」不受此序影响）。
10. **终审修复记录**：
    - **侧河 `+N` 徽标对齐**：布局 `badgeRect` 按容量行数**顶对齐**推算，而网格默认居中且只铺已用行；
      侧河 raw>24（容量 9–10 行、实际 8 行）时 +N 会压到最后一行牌上（v13 §10.4 禁止徽标与居中网格混用）。
      修法：有徽标时网格加 `mj-river__grid--badged`（`align-self: flex-start` + `align-content: start`），
      徽标仍在 `badgeRect` 绝对定位，不进入网格流。
    - **胡 banner 锚点居中**：`ftl-hu-banner` 的 30%/70% 帧原写 `transform: none`，动画期整体覆盖
      组件基类的 `translate(-50%, -100%)`，可见停留期 banner 左上角落在锚点。修法：四帧全部烘焙
      `translate(-50%, -100%)`；组件基类居中 transform 保留为 reduced-motion 兜底。
    - **reduced-motion 下的胡 banner**（`e5a003df`）：整组降级规则的 `transform: none !important`
      会压掉基类居中；`.anim-hu-banner` 单列，只关 `animation/transition`，不动 `transform`。

## 5. 终审待分诊 Minor 清单（来自各 Task 审查）

- Task 1：`const s=1` 保真痕迹；`normalizeSeat` 对非法组项回退 3 张；INF 计数未防；`rects` 无键类型安全。
- Task 2：协议注释「补杠 fromSeat undefined」与 v12 §4 不符（客户端未改协议，服务端实际保留 fromSeat）。rob 测试形态已在 `53213cea` 改为 `state:'claim'+windowId:'rob:N'`。
- Task 3：Meld 非暗杠显式传 `aspectFit`；纵向高度依赖调用方传全 tileW/H/overlap。
- Task 4：缺 `windowStart>0` 时 claimSourceIndex 仍为窗口相对下标的测试；`--clickable` 光标范围；空/负窗口分支未测。
- Task 5：wall 重复内联字号；金环 inset 未断言；urgent 边界 5s 未测；源扫描 cwd 相对路径。
- Task 6：line/winner 同为 2px；legacy bar 与旧实现不完全等价；空 balance 显示「—」。
- Task 7：play 多胡只取第一个；claim 多杠不合并（不可达）；`SUITS` 重复协议常量；牌面标签 `5万` vs `万5`。
- Task 8：reduced-motion 下一版出队未测；`seenHuSeats` mount seed 未测；无 HuBanner 单测；SeatChip side/bar/weak 兼容别名；River 旧 props 仍必填；`--mj-u` 未消费。
- Task 9：shuffle/draw 无轻震；同视图副露+回合双震动；同视图胡/出牌 cue 可能互相打断；无 v1 lack/SBR 与第二局重挂用例。
- Task 10：`parseAnimRules` 分组选择器只捕获最后一个；接线闸用 `includes`；死类闸只扫 animations.scss；内联 style 的 infinite 不在射程。

**终审分诊**：上列全部可发，不阻塞。终审推荐的 4 项回归已在 `53213cea` 补齐（reduced-motion 下一版出队、`seenHuSeats` mount seed、rob fixture 改为 `state:'claim'+windowId:'rob:N'`、v1 lack 音效）。剩余终审 Minor（可发）：`RiverMeldV2.scale` 未被 River 消费（最坏 k≈0.99487，无可见影响）；play 模式若 `claimsForMe` 同时给出 hu+2 杠，ActionBar 3 行会超出 176px（罕见，走查确认）；`mahjong-layout-v2.test.ts` 的「互不相交」只断言边界；Hub/SeatChip/River 字号为固定 px（B 方案 u=1，成立）。

## 6. 回滚

- 本片只改客户端展示层：新增 layout v2 / claims / keys / Hub / ActionBar 与测试；修改 Board、River、SeatChip、Meld、Tile、HandBacks、HuBanner、table.vue、useTableSound、animations.scss、uni.scss；删除 Center/ClaimTile 及其测试。
- 回滚整片：`git revert --no-commit 3f0dc4c7..e5a003df && git commit`（或按单个 Task 提交 revert）。
- 旧 `mahjong-layout.ts` 与其测试仍在，未被引用但可直接恢复。

## 7. 下一步（需要用户）

1. 真浏览器/真机走查（§4.1、§4.3）。
2. 决定是否补 rob 副露高亮（§4.2）。
3. 决定是否推送 `dev` / 部署测试服 / 打 tag。
