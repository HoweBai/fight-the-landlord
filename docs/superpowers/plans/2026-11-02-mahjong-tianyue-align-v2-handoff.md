# 交接：麻将牌桌「天月对齐 v2」

日期：2026-11-02
分支：`dev`（HEAD `2c028040`）
Spec：`docs/superpowers/specs/2026-11-02-mahjong-tianyue-align-v2-design.md`
Plan：`docs/superpowers/plans/2026-11-02-mahjong-tianyue-align-v2.md`

## 状态

- 设计对抗审查：阻断 3 / 高 9 / 低 10，全部处置（见 spec §10）。
- 计划对抗审查：阻断 3 / 高 13 / 低 15，全部处置（见 plan「计划审查记录」）。
- 代码终审（opus）：Critical 0 / Important 2 / Minor 9，Important 全修、Minor 修 10 / 登记 1（见 plan「代码审查记录」）。
- 已推 `dev`（`af89f878..2c028040`）。
- APK：`0.1.8 / versionCode 108`，已发布 Release `apk-latest`，测试服 `/download/ubigame.apk` sha256 逐字节一致。
- 测试服已部署 `dev-2c02804`（H5/health 200；APK 0.1.8/108 已烘进镜像）。
- 未合并 master；未打 `v*` tag。

## 提交

| SHA | 内容 |
|---|---|
| `e3e0e563` | 天月对齐 v2 设计 spec |
| `5c624742` | spec/plan 修订（设计+计划审查处置） |
| `bff9057a` | Task 1 蓝青/炭黑/冷白/宝蓝素材 |
| `3ae1ddae` | Task 2 手牌 116/0.95W、自家人像上移、中央卡 145.4 |
| `0891f5b0` | Task 3 中央四家临时分/状态 + 听牌行 |
| `f51c1f86` | Task 4 ClaimTile 2 列 + 牌面预览 |
| `12120047` | 终审 Important/Minor 修复 |
| `0a27eca6` | 中央 strip 行高 1 |
| `2c028040` | 版本 0.1.8 / versionCode 108 |

## 变更摘要

- 桌面 `#7FA8C0 → #5C93AC → #436C87`；中央/ClaimTile 炭黑 `#3A3D42`；木框深灰棕。
- 牌面灰度 colorize 冷白（低饱和均值约 `[239,243,249]`）；牌背亮宝蓝（约 `[84,118,181]`）；64 色量化，目录约 529KiB。
- 中央盘：340×145.4（最差副露）；strip 28 / 四家列 100 + 圆盘 80 + 四家列 100 / 听牌 27；四家 = 杠分/临时分投影 + 庄/缺/听/胡/出局；可响应牌移到 ClaimTile。
- 手牌 116 高；宽度兜底 0.95W；自家人像在中央井左缘、手牌上方（避开左副露/左牌河）。
- ClaimTile：2 列、按钮 88 高、顶部 34×45 牌面预览（优先 filteredOptions）。
- 顺带：`.gitignore` 加 `__pycache__/`；素材脚本删未用 numpy；终审发现的中央 phase 折行、内容预算假绿、6 位分数溢出已修。

## 验证

- `pnpm -C apps/client test`：**1777 passed / 2 skipped**。
- `pnpm -C apps/client run lint`：**0 错**。
- `pnpm -C packages/protocol test`：**325 passed**；`packages/shared`：**446 passed**。
- `pnpm -C apps/client run build:h5`：**DONE**。
- 视觉 harness（真实组件 + Chrome headless）：`.superpowers/mahjong-visual/v2-*.png`：
  - `v2-normal-1334x750.png` / `v2-worst-1334x750.png` / `v2-claim-1334x750.png`
  - `v2-1334x1000.png` / `v2-1778x750.png` / `v2-844x390.png`
- CDP 实测：正常卡 340×170、最差 340×145.4（scroll=client，无溢出）；四家列 100×40；dial 80；ting 27；claim 面板 166×261、2 列。

## 已知边界/后续

1. 中央四家数字是**杠分/临时分投影**（`pendingScoreChanges` 只含杠），不是完整局分/钱包余额；胡/查叫/花猪等结算才出。
2. 不做角色立绘；头像仍是 `default.png`。
3. 真机 App 未走查：装 0.1.8/108 APK 看中央四家、claim 2 列、自家人像、圆盘/圆头像在 webview 的表现。
4. 中央听牌最多 8 张 + `听 N 张`；fan 14px；紧凑分支是小画布防御。
5. 侧家牌背仍是叠压长条（pitch 26）；如需更像实机可另立片。
6. 结算页未重做（只保留主按钮文字色）。
7. 真实 Docker 栈 e2e 未跑（本机无 Docker）；测试服 H5 已 200、APK sha 与本地逐字节一致、版本 0.1.8/108。

## 回滚

- 代码：`git revert 2c028040..bff9057a`（按需）。
- 测试服：`bash scripts/deploy/rollback.sh <上一个 dev-tag>`（`dev-d867cbd` 或 `dev-03e9bdb`）。
- APK：重新发布 0.1.7/107 资产或旧包。
