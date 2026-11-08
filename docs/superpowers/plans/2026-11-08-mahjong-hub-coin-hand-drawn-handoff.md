# 川麻红金 v16 交接（2026-11-08）

## 当前状态

- **v16 已实现**（本机 `dev`，工作树 clean），实现提交：
  - `836bfdd8` feat(mahjong): 铜钱信息井（方孔 + 四扇形 + 倒计时/徽标轮换）——Task 1
  - `b91a1862` fix(mahjong): v16 任务 1 复审修复（徽标胶囊宽度 + 测试闸）
  - `5200b938` feat(mahjong): 摸牌位改包裹层 + 右上金点（抬升只归选中）——Task 2
  - `659b17a0` fix(mahjong): v16 终审测试加固（urgent 负例 + 源码闸剥注释/包裹层）
  - 文档提交：`c92166b1` / `b3c8e7d7` / `bb0a3fbd`（spec）、`65171831` / `418a5205` / `56ea4598`（计划）
  - 本 Task 提交：`docs(mahjong): v16 铜钱信息井实现交接`（本文件）
- **全量验证已过**（见下表）：`test` **1993 passed / 2 skipped**（133 passed + 2 skipped 文件，共 135）、`lint` exit 0、`build` `DONE Build complete.`。
- **未推送、未部署、未重打 APK**：origin/dev 不含以上提交；部署回滚点仍 `dev-362b9f9`（红金皮肤首版）+ APK 0.1.11/111。
- **版本保持 0.1.12/112**（v15+v16 同版本，未再 bump；`apps/client/src/manifest.json`）。

## 改动

- **`apps/client/src/components/table/mahjong/MahjongHub.vue`（铜钱信息井）**
  - 外环 6px 金边 + 内发丝边；四扇形 conic 层按 45°/135° 对角线切分（上/右/下/左），待机 `.4` / 亮块 `1`。
  - 对角线发丝层（不随扇形 dim）；中央 **66×66 border-box 方孔**（内容宽 62）= 牌墙数 + 最多 5 字提示（`max-width:100%` + ellipsis）。
  - 槽位 = lit 倒计时（`Ns`）/ 未 lit 单字徽标胶囊（胡/听/缺/托）；**上/下也是小胶囊**；紧迫动效 `anim-mj-urgent` 仅自家槽（末 5 秒）。
  - 删除旧 `hub` / `compact` props 与类、方位点 dots、四角徽标；胡牌金光 `flashKey` 覆盖层保留。
- **`apps/client/src/components/table/mahjong/MahjongBoard.vue`（接线）**
  - `hubStyle`：视觉恒 160×160、居中于 `hub.cx/cy`、`scale(u)`（防御）。
  - `statusText` 文案压缩：`选同花3张`（5 字）/`请出牌`/`等待出牌`/`请定缺`/`等待定缺`/`请响应`/`等待响应`/`已胡N家`/`本局结束`。
  - 摸牌位改**包裹层** `.mj__hand-drawn`（尺寸 = 牌面；`drawnGap` 的 `margin-left` 从 image 迁到包裹层）+ 右上金点 `.mj__hand-drawn-dot`。
  - 抬升**只归选中**；金点用兄弟选择器 `:deep(.mj-tile--selected) + .mj__hand-drawn-dot` 随选中抬升。
- **测试**：`apps/client/test/mahjong-hub.test.ts` 重写 v16 用例（lit 规则 / 0s / 多块同秒 / 5 字截断 / urgent 负例 / 胶囊）；`apps/client/test/mahjong-board.test.ts` 新增真实 DOM 断言（金点、包裹层 selected、对角发丝层）+ 源码闸（无 `.mj__hand-tile--drawn` 选择器、无 `hub`/`compact`、剥注释后扫描）。

## 设计 / 审查 / 预览

- 设计 spec：`docs/superpowers/specs/2026-11-08-mahjong-hub-coin-hand-drawn-design.md`（含 **§10 审查记录**：1 阻断 + 5 高 + 13 低，均已修订）。
- 实现计划：`docs/superpowers/plans/2026-11-08-mahjong-hub-coin-hand-drawn.md`（含 **§计划审查记录**：无阻断，3 高 + 5 低，均已修订）。
- 视觉基线（mockup）：`.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.png`（同名 `.html`）。

## 真浏览器对照（已执行，非单测）

- 方式：临时 Vite 入口挂载**真实 `MahjongBoard`**（fixture 抄 `test/mahjong-board.test.ts` 的 `view()`/`props()`，不依赖后端房间）：
  `pnpm -C apps/client exec vite --port 5179 --host 127.0.0.1`（后台）→ Playwright Chromium 1243 headless，`--window-size=1334,750`，`--virtual-time-budget=4000`。
- 截图（`.superpowers/` 已 gitignore，未入库）：
  - `.superpowers/mahjong-redgold/v16-shots/v16-top.png` —— 对家回合：上方亮块 `12s`；self=听、left=缺 小胶囊。
  - `.superpowers/mahjong-redgold/v16-shots/v16-self.png` —— 自家末 5 秒：下方红色 `4s`；top=听、right=胡；第 6 张选中抬升 + 金框；摸牌位行尾 + 右上金点。
  - `.superpowers/mahjong-redgold/v16-shots/v16-idle.png` —— ended 无行动者：四家徽标 胡(上)/听(左)/托(右)/缺(下)，四块均不亮。
  - 补充证据：`v16-self-drawn-selected.png`（摸牌位本身选中 → 金点随抬升）、`v16-exchange-hint.png`（方孔 `选同花3张` 5 字不溢出）、`v16-self-2x.png` + `crop-hub-*.png`（2x 细节）。
- 对照结论（vs `hub-coin-hand-preview.png`）：
  - 扇形亮块/角度：亮块明显更亮，45°/135° 对角线正对方孔四角；
  - 方孔牌墙 + 提示：`40` 与 `请出牌` / `等待出牌` / `本局结束` / `选同花3张` 均完整显示，无溢出；
  - 倒计时/徽标胶囊：上/下/左/右槽均为小胶囊（未 lit 时），lit 槽显示倒计时；
  - 摸牌位右上金点：可见；选中抬升且金点跟随（`v16-self-drawn-selected.png`）；
  - 摸牌位与选中一眼可分：选中=抬升+金框，摸牌位=不抬升+右上金点。
- 清理：Vite 进程已停（5179 无 LISTEN，仅 TIME_WAIT）；临时文件 `apps/client/v16-preview.html`、`apps/client/src/v16-preview.ts` 已删除；`git status` clean。

## 回滚

- 代码：本片只动两个组件与测试；回滚 = `git revert 659b17a0 5200b938 b91a1862 836bfdd8`（按倒序逐个 revert）。
- 部署：**v16 未部署**；部署回滚点仍 `dev-362b9f9`（红金皮肤首版）+ APK 0.1.11/111。

## 验证证据（2026-11-08，`659b17a0` 的树）

| 命令 | 结果 |
|---|---|
| `pnpm -C apps/client test` | Test Files **133 passed \| 2 skipped (135)**；Tests **1993 passed \| 2 skipped (1995)**；22.51s；exit 0 |
| `pnpm -C apps/client lint` | `vue-tsc --noEmit`，无输出，exit 0 |
| `pnpm -C apps/client build` | `vue-tsc --noEmit && uni build` → `DONE Build complete.`，exit 0（`/static/ui/*` 的「didn't resolve at build time」为 uni 既有运行时解析提示，非本次引入） |

## 下一步（需用户裁决）

1. **推送 `dev`**（origin/dev 不含 v16；dev 推送零 CI）。
2. **部署测试服**（`deploy-dev.sh`）。
3. **重打 APK 0.1.12/112**。
4. **真机走查**：扇形可读性、5 字提示不溢出、金点随选中抬升、摸牌位与选中一眼可分。

## 已知取舍

- claim/rob 沿用 `currentPlayer` 语义（lit 只做展示映射，不推导牌局规则）。
- 信息井**视觉固定 160**（小于布局矩形），不再随布局 160–200 变化；布局碰撞面不变。
- 方孔提示最多 **5 字**，超长省略；完整语义仍由动作区/牌河表达。
- 徽标与倒计时共用槽位：lit 时该家徽标暂时不可见（设计如此）。
- `conic-gradient` 单色标写法最低内核 **Chrome 87+**（`inset` / flex `gap` 已是仓库既有基线）。
