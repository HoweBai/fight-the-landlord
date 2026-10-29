# 麻将牌桌比例布局片 · 交接（2026-10-30）

> 状态：实现 + 全量验证 + 独立代码审查修复完成；**待推 dev / 未部署**。
> 设计：`docs/superpowers/specs/2026-10-30-mahjong-table-layout-design.md`
> 计划：`docs/superpowers/plans/2026-10-30-mahjong-table-layout.md`
> 回滚基线：`1abd2bec`（本片第一行代码之前）。

## 1. 做了什么

把四川麻将牌桌从「纵向堆叠面板」改成主流麻将的四家围桌比例布局：

- 新增纯函数 `apps/client/src/game/mahjong-layout.ts`：
  `s = min(H/750, 0.88W/1041.54)`；四家分区/牌河/副露/牌背/中央井/动作浮层全部按比例输出。
- 新增哑组件：`MahjongSeatChip` / `MahjongHandBacks` / `MahjongRiver` / `MahjongCenter`；
  `MahjongSeatPanel` 退役。
- `MahjongBoard` 改为四家绝对定位分区；`LandscapeStage` provide 画布尺寸；
  对手牌背、左右家竖排牌河、中央井、摸牌行尾分离、左右家已胡牌河区亮牌。
- `MahjongTile` 支持显式 `w/h`；`MahjongMeld` 杠第 4 张同行、暗杠 4 张全牌背。

## 2. 验证证据（2026-10-30）

- `pnpm -C apps/client test`：**126 files passed + 2 skipped（128 总计）**；
  **1703 tests passed + 2 skipped（1705 总计）**。
- `pnpm -C apps/client run lint`：通过。
- `pnpm -C apps/client run build:h5`：`Build complete`。
- 仓库闸：`ui-tokens` / `animations` / `source-boundary` / `art-slots` 共 60 tests 通过。
- 三档真浏览器截图（本机，gitignored）：
  `.superpowers/mahjong-layout-research/final-1334x750.png`、
  `final-1623x750.png`、`final-1334x1000.png`。

## 3. 已知边界（登记，不在本片修）

- **暗杠牌面仍随 `melds` 下发**（`buildMahjongView` 直接拷贝 `m.tiles`）：既有协议泄漏；
  客户端已把 `angang` 4 张全部按牌背渲染，协议侧遮罩另立片。
- **左右家已胡时该座 discards 不显示**（牌河区改亮牌网格，3 列 49×40）。
- **动作浮层可能盖住自己的牌河/副露右半**（不盖左右家区）；响应过滤点的是别人的弃牌。
- **重连/断网 resync 可能误标一次摸牌**；下一次手牌变化即清。
- **牌河 >24 张**：对家/自己压缩到 12×3（36 槽）、左右 4×8（32 槽）；当前玩法到不了。
- `revealedHands.huTile` 不做特殊标记；字号沿用全局 token（不随 s 放大）。
- `.tmp-mjpreview` 是本机临时夹具，已删除；截图在 `.superpowers/`（gitignored）。

## 4. 下一步

1. ~~代码审查（独立 reviewer）→ 修 Critical/Important → 重跑全量。~~ **已完成**：C1 摸牌/选择错位、I1 侧区副露组距、I2 紧凑卡字号、I3 claim 点击来源座，及 minors；记录见计划「代码审查记录」。
2. 推 `dev`（零 CI）；需要发版时合 `master` 走权威轮。
3. 测试服部署：`bash scripts/deploy/deploy-dev.sh`（用户发话后）。
4. 真机走查：四家方向/亮牌/动作浮层/托管遮罩/跨设备比例。
