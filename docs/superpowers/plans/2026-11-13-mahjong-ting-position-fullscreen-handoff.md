# 川麻红金 v19 交接（2026-11-13）：听牌贴手牌 + App 全屏

## 当前状态

- **v19 已实现并完成全量验证**（本机 `dev`，工作树 clean），提交：
  - 文档：`8c6e64a2`（spec 初稿）→ `47ac17bf`（spec 对抗审查修订）→ `a44d806b`（实现计划）→ `fd95bde6`（计划审查修订 10 条低风险）
  - 实现：`cee25da7` `feat(mahjong): 听牌贴手牌左缘 + App 运行时全屏（0.1.14/114）`（Task 1，10 文件 +90/−23）
  - 终审修复：`ce5527a1` `docs(mahjong): v19 终审注释与 v15 supersede 指针`（头注释 v19 偏离说明 + 测试 ≥180 注解 + v15 C1/handoff supersede + 原型注释）
  - 本 Task 只新增本交接文档。
- **全量验证已过**（2026-11-13 02:50–02:55，见下表）：4 条命令全 exit 0；`client test` **2002 passed / 2 skipped**（134 passed + 2 skipped 文件，共 136）。
- **APK 已打包但未发布**：`deploy/download/ubigame.apk`，**0.1.14/114**，20,399,710 B，sha256 `00e047e39f44627fe0bdc60bc050fd2ca4fbb99573d13b7d3980533dcd545b05`；产物闸全绿。
- **未推送、未部署、未发布 APK**：origin/dev 不含 v19 的 6 个提交（`200ef01e..ce5527a1` 中 `8c6e64a2` 起 6 个）；测试服仍 `dev-200ef01`（v15–v18，APK 0.1.13/113）。

## 改动

### 听牌贴手牌行左缘（D1/D3）

- `apps/client/src/game/mahjong-layout-v3.ts`：`const tingX = hand.left;`（layoutBase 内 `hand` 是 Rect，**不是** `hand.rect.left`）⇒ base 1334×750 下 `ting.rect.left === rects.hand.left === 146.23`；y/尺寸/2×5/标签样式不变。:10/:667 注释与头注释（:17 v19 偏离说明）同步。
- **I8 新基线（v19 supersede v15）**：12 列自家河间隙 **128.76**（≥120 且不相交）；与左侧河最坏 **10.76**（不相交，必测）；7 档 × 15 态 `checks` 仍为空（含 2668×1500，`ting.rect.left=292.46`）。
- 对齐语义：对齐手牌**行**左缘；13 张时首张牌距行左缘约 **42.84px**，14 张时约 **1px**。
- 测试：`mahjong-layout-v3.test.ts` 精确值迁移（50.34/90.74→146.23、181.48→292.46）+ 新增 128.76/10.76/`ting.left === hand.left` 语义用例；`mahjong-board.test.ts` 仅 `.mj__ting` 的 `left: 50.34px`→`146.23px`（v17 动作带 `right: 50.34/90.74` 未动）。

### App 运行时全屏 + manifest 声明 + 产物闸（D4/D5/D6）

- `apps/client/src/App.vue`：`enterFullscreen()`（`#ifdef APP-PLUS` + `typeof plus` 守卫 + `setFullscreen?.(true)`，try/catch 不阻断启动）；`onLaunch`/`onShow` 均接线（`onShow` 覆盖广告/后台返回）。H5 构建整块剥除，不影响 H5。
- `apps/client/src/manifest.json`：`app-plus.fullscreen: true`（非 uni-app 官方键，声明式尝试；以运行时为主判据）+ `versionName 0.1.14` / `versionCode "114"`。
- `scripts/deploy/pack-apk.sh`：端点校验后新增产物闸 —— `app-service.js` 含 `setFullscreen`（`grep -c` ≥1）否则拒绝继续；并打印产物 `www/manifest.json` 的根级 `"fullscreen"` 片段作诊断。
- 测试：`landscape-canvas.test.ts` 断言 `app-plus.fullscreen === true`；`app-fullscreen.test.ts`（新）静态闸（含 onLaunch/onShow 接线正则，防死代码）。

## 设计 / 审查

- 设计 spec：`docs/superpowers/specs/2026-11-13-mahjong-ting-position-fullscreen-design.md`
  - **§7 审查记录（2026-11-13，sonnet 对抗审查）：1 阻断 + 3 高 + 低**：
    - 阻断：新 x 使 12 列自家河间隙 184.25→128.76，违反 v15 I8「≥180」且旧 8 列 fixture 假绿 ⇒ 改基线 ≥120 + 12 列 fixture + 标注 v15 supersede（D3）。
    - 高：① `hand` 是 Rect（无 `hand.rect.left`）⇒ `hand.left`；② `app-plus.fullscreen` 非官方键、产物可能丢弃 ⇒ 运行时 `plus.navigator.setFullscreen(true)`（onLaunch/onShow）为主 + manifest 声明为辅 + pack-apk 产物闸；③ 2668×1500 的 181.48→292.46 迁移遗漏 + Board 的 `50.34/90.74` 在 `.mj__ting` 与 v17 动作带右锚点间数值巧合 ⇒ 精确点名。
    - 低：用例标题/注释、10.76 升必测、42.7→42.84、safeArea 空白条/导航条/广告后复现、versionCode 字符串、H5 部署验收、交接/记忆/v15 文档同步。
- 实现计划：`docs/superpowers/plans/2026-11-13-mahjong-ting-position-fullscreen.md`
  - 计划审查记录（2026-11-13，sonnet 只读）：**可开工，无阻断/高**；10 条低风险已修订（:415/6 处、heavy 语义、12 列 fixture `left: seat(8)`、`grep -c`/manifest 诊断、verify:apk/`"code":"114"`/sha256、onLaunch/onShow 接线正则、v15 §1.3 两 bullet + 10.76、交接补充、Board :808）。
- 任务/终审：Task 1 任务级审查 **Approved**（Minor：头注释「逐行移植」与 v19 偏离、产物闸仅验字符串存在、静态闸可匹配注释语义）；**整片终审（opus，`200ef01e..cee25da7`）：Ready to hand off: Yes**（无 Critical/Important；12,800 例几何扫描 0 checks），Fix 已落 `ce5527a1`。
- 已知 Minor（不阻断）：v15 几何原型 `docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs` 的 tingX 仍是旧公式（brief 未列入 v19 范围；后续用原型对账需先按 `hand.left` 更新）。

## 验证证据（2026-11-13，`ce5527a1` 的树）

| 命令 | 结果 |
|---|---|
| `pnpm -C apps/client test` | Test Files **134 passed \| 2 skipped (136)**；Tests **2002 passed \| 2 skipped (2004)**；21.89s；exit 0 |
| `pnpm -C apps/client lint` | `vue-tsc --noEmit`，无输出，exit 0 |
| `pnpm -C apps/client build` | `vue-tsc --noEmit && uni build` → `DONE Build complete.`，exit 0（`/static/ui/*` 的「didn't resolve at build time」为 uni 既有运行时解析提示，非本次引入） |
| `pnpm verify:apk` | ✅ 文件名真源 ubigame.apk 四处一致；exit 0（打包后复跑同样绿） |

## APK 产物（0.1.14/114，已打包，**未发布**）

- 打包命令：`bash scripts/deploy/pack-apk.sh ssh.yobeeo.com`（**不带 `--publish`**），exit 0；端点 `ssh.yobeeo.com` 已注入（既有闸通过）。
- 产物：`deploy/download/ubigame.apk`，**20,399,710 bytes**（约 19.4 MiB）。
- sha256：`00e047e39f44627fe0bdc60bc050fd2ca4fbb99573d13b7d3980533dcd545b05`
- 版本（产物 `assets/apps/__UNI__CE6765E/www/manifest.json`）：`"version":{"code":"114","name":"0.1.14"}`。
- 产物闸输出：`✅ [pack-apk] 运行时全屏已在包内`；manifest `"fullscreen"` 诊断行打印 2 次（`"fullscreen":true`）。
- 打包后 `git status` clean（HBuilderX 未回写 manifest）。

## 真机验收硬项（用户执行；发布 APK 后）

1. 启动后**系统状态栏消失**（电量/时间那条）。
2. 看一次**激励视频**后回到牌桌，状态栏**仍隐藏**（`onShow` 兜底）。
3. **顶部无空白条**。若 `safeArea.top/statusBarHeight` 残留旧值导致空白条 ⇒ **登记「全屏态 top inset 置 0」为后续小修，不阻断本片**（spec §5 已预登记）。
4. **导航条不隐藏**：本片只承诺系统状态栏，Android 手势/三键导航条**不承诺**。
5. 听牌块**贴手牌行左缘**（按 D1 对齐手牌**行**）：13 张时距首张牌约 **42.84px**（行左缘留白），14 张时约 **1px**；不压座位牌/侧背/侧副露。

## 交付 / 兼容

- **H5**：听牌位置变更需**部署测试服**后可见；fullscreen 逻辑不影响 H5。
- **APK**：必须重打才带听牌 + 全屏两改动；本交接的 `deploy/download/ubigame.apk`（0.1.14/114）即待发布产物。
- **APK 回滚**：回到 0.1.13/113 **需先卸载新版再装旧版**（Android 不允许 versionCode 降级覆盖安装）。

## 回滚

- 代码：`git revert ce5527a1 cee25da7 fd95bde6 a44d806b 47ac17bf 8c6e64a2`（或按需 revert 实现提交）；v1/v2 布局文件与其测试未动。
- 部署回滚点：仍 **`dev-200ef01`**（v15–v18；`bash scripts/deploy/rollback.sh dev-200ef01`）。

## 收尾登记

- `git status`：clean（`ce5527a1` + 本交接提交；HBuilderX 打包未回写 manifest）。
- `pnpm verify:apk`：绿（见上表/APK 节）。
- APK sha256：`00e047e39f44627fe0bdc60bc050fd2ca4fbb99573d13b7d3980533dcd545b05`。
- **v15 记忆/文档同步（待做，未在本片执行）**：
  - `C:\Users\Yobee\.claude\projects\d--Code-pokergame\memory\mahjong-redgold-redesign-2026-11-07.md` 尚无 v18/v19 章节；MEMORY.md 索引条目仍写「v15 …未实现；新会话从 Task 1 开始」（陈旧）。
  - v15 spec/plan 的 supersede 注已落（`cee25da7`/`ce5527a1`），无需再改。
- 计划文件 `docs/superpowers/plans/2026-11-13-mahjong-ting-position-fullscreen.md` 的 Task 勾选框**未勾选**（Task 1 Step 1–3 实际已完成）—— 已知文档小差异，不影响实现/验证结论。

## 下一步（用户裁决）

1. 推送 `dev`（v19 6 个提交）。
2. 部署测试服（H5 听牌变更可见；`bash scripts/deploy/deploy-dev.sh`）。
3. 发布 APK 0.1.14/114（`bash scripts/deploy/publish-apk.sh deploy/download/ubigame.apk` + `bash scripts/deploy/preview.sh download` ⇒ Release `apk-latest` + edge `/download/ubigame.apk`）。
4. 真机验收（上面 5 条硬项）。
