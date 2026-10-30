# 麻将中央牌板片 · 交接（2026-10-30）

> 状态：实现 + 全量验证 + 代码审查修复 + 真组件四张截图完成；**已推 dev 并部署测试服 `dev-2583a6c`**（2026-10-30）。
> 设计：`docs/superpowers/specs/2026-10-30-mahjong-central-board-design.md`
> 计划：`docs/superpowers/plans/2026-10-30-mahjong-central-board.md`
> 回滚基线：`ec238a12`（本片第一行代码之前）。

## 1. 做了什么

把四川麻将中央区从「四块牌河围井 + 浮动中央卡」改成**中央牌板**（方案 B）：

- 纯函数 `mahjongTableLayout` 中央区重写：牌板 = 左道 + 中间列 + 右道；左右道贯穿全高；
  中间列自上而下 = 对家牌河 / 信息格 / 自己牌河；**信息格宽 = 中间列宽**；
  七档视口候选（中间列 12/11 列、侧道 3/2 列）。
- 新组件 `MahjongMeldStrip`：副露从牌河拆出；对家走牌背两翼（贴住牌背，放不下才下移）、
  自己走手牌上方、左右走外侧栏竖排（49×40 资产）。
- `MahjongRiver`：只画弃牌；新增 `source` 来源道高亮；网格改左上起点（行数增长时旧牌不漂移）。
- `MahjongCenter`：三档信息格（full/dense/compact）；牌墙为主数字；待响应牌带来源座；
  听牌仅在 full 档、且无待响应牌时显示；**移除「已胡 N 家」**。
- 动作浮层右缘改为**右道左缘**（不再压住右家可点弃牌）；宽屏座位卡夹到牌背外侧（避免脱节）。

## 2. 验证证据（2026-10-30）

- `pnpm -C apps/client test`：**127 files passed + 2 skipped（129）**；
  **1712 tests passed + 2 skipped（1714）**。
- `pnpm -C apps/client run lint`（`vue-tsc --noEmit`）：通过。
- `pnpm -C apps/client run build:h5`：`DONE Build complete`。
- 仓库闸（ui-tokens / animations / source-boundary / art-slots）随全量跑，绿。
- 真组件截图（本机，gitignored，`.superpowers/mahjong-layout-research/v2-mockups/`）：
  `real-1334x750.png`（dense 档，有副露）、`real-1334x750-full.png`（full 档，无副露）、
  `real-1334x1000.png`、`real-1623x750.png`。
  渲染方式：临时 Vite 夹具挂真实 `MahjongBoard`（假 view + 注入 1334/1000/1623 画布），
  headless Chrome 截图；夹具已删除（需要时可按同一 recipe 重建）。

## 3. 已知边界（登记，不在本片修）

- **16:10 + 对家 4 杠 + 我 4 杠**：信息格只剩 78s → `compact` 单行（16:10 非主力视口）。
- **弃牌 > 道容量**：`fit` 压缩（任何张数不溢出）；>36 张时牌面明显变小。
- **4:3/正方形**：中间列退 11 列、侧道 2 列（容量 22/26/44/40，仍 ≥20）；信息格反而更宽（640）。
- **信息格无待响应/无听牌时**：full 档只有「牌墙 + 阶段 + 倒计时」，格内留白较多（真机走查再定是否加装饰）。
- **示意图 `b-*.png`** 是设计期产物，未按最终算法重生成；**以 `real-*.png` 为准**。
- 「已胡 N 家」移除后，血战到底「还剩几家」要靠数座位卡「胡」徽标 + 亮牌；真机走查确认是否够。

## 4. 代码审查记录

独立 reviewer（sonnet）审 `ec238a12..HEAD`：**1 Important + 10 Minor**，全部处置（详见计划「代码审查记录」）。
要点：play 窗口的「可自摸胡」改取 `claim === 'hu'` 的牌（原来取「第一个带 tile 的选项」，与杠顺序耦合）；
compact 恢复 `·` 分隔；`discards: Infinity` 夹到 0；补 4 条布局断言 + 2 条 Board 断言 + 2 条源码闸；
删死 token `riverCols`；spec B3「已重生成 mockup」的失实记载改为「不重生成，真组件截图为准」。

## 5. 下一步

1. ~~代码审查修复~~ / ~~推 dev~~ / ~~测试服部署~~ **已完成**：`dev@2583a6c`，tag `dev-2583a6c`，冒烟三条 + 钉 IP 复核通过。
2. 真机走查：四家方向、副露两翼/下移、claim 来源道高亮与过滤、宽屏座位卡、信息格三档。
3. 回滚（秒级）：`bash scripts/deploy/rollback.sh dev-04a4ac2`（上一片部署 tag，2026-10-28）。
4. 合 master 时走权威轮（CI + conformance + 镜像）。
