# 交接：素材接入 + 花色协议（计划骨架，待新会话用 `writing-plans` 细化）

> **状态**：**交接文档**（不是最终实施计划）。新会话接手后：① 读本文 + `docs/superpowers/specs/2026-09-18-reference-ui-teardown.md` + spec 原文；② 用 **`writing-plans`** 把下面 6 个 Task 写成 `YYYY-MM-DD-slice-ui-assets-*.md`（建议拆两份：**协议侧**、**素材/观感侧**）；③ 用 **`subagent-driven-development`** 逐 Task 派工（每 Task：实现 → 任务评审 → 修复轮 → 定向复审 → 门禁）。
> **前置状态**：上一片「对局 UI 重设计（➊➋ 前两屏 + ➌➍➎➏➐➑ 牌桌）」**已完成**，HEAD 见 `git log`（收口 commit 为 `5343ea2` 的最终修复波 + 后续 docs 收口），两片台账在 `.superpowers/sdd/2026-09-17-slice-ui-0{1,2}-*/progress.md`。

## 0. 本片的新裁决（2026-09-18，用户口头裁决 → 落盘）

| # | 裁决 | 影响 |
|---|---|---|
| **R688** | `reference/` 两个项目的**全套素材已另行取得授权**，可用于本项目（含疑似欢乐斗地主元素与 `ice.ttf`） | 素材可入库；仍须 `static/ASSETS.md` 留溯源与授权范围（字体那行注明上游为字魂商业字体） |
| **R689** | **只做 H5 与 App**：H5 = 迭代与门禁面；**App = 主要目标** | 每 Task 门禁 = H5 build + 探针 gate + **`build:app` 绿** |
| **R690** | **小程序保留代码、撤出门禁**；后续开发/测试**不涉及**小程序 | 不删 `mp-transport.ts`/`net/http.ts` 平台分支/`scripts/build-mp-weixin.mjs`/mp 契约测试；但**不再**把 `build:mp-weixin` 放进每 Task 门禁，也不为 mp 做素材/音频/字体适配（OGG→mp3、`@font-face` **不处理**）。API 仍须**直接成员调用**（`uni-api-access` 闸保留） |
| **R691** | **`PlayerView.hand` 整体改成带花色的结构** | 契约变更：协议 + shared + game-service + conformance + client 全线（见 §2） |
| **R692** | 音效**只用「我方数据就能触发」的那批** | 发牌/出牌/过牌/叫抢/结算/春天/报单报双/倒计时紧迫 + BGM/胜负；**牌型播报（66 条）不做**（需服务端下发牌型展示文案，另立裁决） |
| **R693** | 用 **2x 图**；**允许退役纯 CSS 画牌** | 保留一层**最简兜底**（素材缺失回落文本牌面，避免白屏）；兜底不是第二套视觉 |
| **R694** | `reference/` **加入 `.gitignore`**；只按清单拷需要的素材进 `src/static/` | 实测它现在是 `?? reference/`（未跟踪**也未忽略**）⇒ 22MB+ 一次性入库风险 |

## 1. 素材契约（新会话第一步就要定稿并落进 `static/ASSETS.md`）

- **目录**：`apps/client/src/static/{cards,ui,av,audio}/`（uni 会把整个 `static/` 原样拷进 H5/App 产物；**首次引入需要一次实测**：`<image src="/static/...">` 与**运行时拼接路径**在三端的解析）。
- **牌面**：**54 张面 + 1 张牌背**（有花色后 54 张全部可用）；**2x 尺寸**（建议 ≥120×168，与 `0.71` 高宽比对齐：主张量 1.43）；面/背比例**必须统一**（CardGame 原始为 1.30 vs 1.33）。
- **命名映射**：`SpadeThree.png → { rank: 3, suit: 0 }`（suit：♠0 ♥1 ♣2 ♦3；王用 `-1`）。映射表放**客户端常量模块**并在注释里写清：这是**资源名 → 展示图片**的映射，**不是**点数→牌面文字的自制映射（后者由 `protocol.toDisplay()` 唯一提供，`source-boundary` 有闸）。
- **体积预算**：App 无 2MB 限制（主目标）；H5 建议首屏 ≤3MB；**加一条产物级断言**（构建后统计 `dist/build/{h5,app}` 的 `static/` 体积并断言阈值）。
- **溯源**：`static/ASSETS.md` = 每类素材的来源项目、原始路径、许可/授权方与日期、覆盖范围。

## 2. 花色协议：契约待定问题（**新会话规划前必须与用户确认**）

**现状**：`packages/protocol/src/codec.ts` 的 DouZero 编码是 **rank-only**（合法值 `3–14 / 17(2) / 20(小王) / 30(大王)`，`isValidDouZeroCard`）；`PlayerView.hand: number[]`、`bottomCards: number[] | null`、`lastPlayedHand.cards: number[]`；内部 `packages/shared/src/ddz/*` 的手牌也是 DouZero int 数组（Redis 持久化同形）。

**已裁决**：下发结构改成带花色（R691）。**待定的实现分叉**：

- **(甲) 只在下发路径补花色**（**推荐**，最小侵入）：内部规则面（牌堆/`play.ts`/`beat.ts`/features/bot）**保持 rank-only 不动**；`GameSession` 增一份按座位的 `handSuits`（deal 时从真实牌堆分配；出牌时按「同 rank 的第几张」摘除），`view.builder` 组装成 `{r,s}` 下发给客户端。**副作用**：同 rank 的牌在内部不可区分，出牌时「摘哪张花色」是任意的 ⇒ 观感上可能出现「手牌花色与刚打出的花色对不上」（小瑕疵，规则零影响）。规则引擎**零改动**是最大优点。
- **(乙) 内部也改成 `{r,s}`**：契约最干净、将来可做「真牌堆」观感；但要动 `shared/ddz` 的牌堆/手牌/出牌/比较/特征/机器人 + Redis 存的形状 + 全部规则测试 ⇒ 面大、风险高，建议作为**后续独立片**。

**无论甲乙，都要落进计划的改动面**：
`packages/protocol/src/{codec,views,validate}.ts`（新结构 + 值域/同长校验）· `packages/protocol/src/*.test.ts` · `packages/game-service/src/game/view.builder.ts`（组装）· `packages/shared/src/ddz/*`（按甲乙选）· `tools/conformance`（裁剪/泄漏断言里凡涉及手牌形状的都要同步，**判据只增不减**）· client 的 `Card.vue` + `store` getters + `test/helpers/fake-socket.ts` 的 `playerViewFixture` + **所有手牌断言**（`table-play-ui` 的 `data-value="3"`、`{cards:[3,3]}` 等）。

⚠️ **红线仍适用**：牌型/能否压过/倍数一律**不在前端算**；花色只是**展示数据**，不得引入任何规则判定。`validateOutbound` 不得因此放宽（他人手牌/`isRobot` 泄漏面照旧）。

## 3. 计划骨架（6 个 Task；细化时每块都要带判据与门禁）

| Task | 内容 | 关键验收 / 不许破 |
|---|---|---|
| **P0 契约裁决落盘** | 与用户确认 §2 的**(甲)/(乙)**、花色值域与王的哨兵值、《`hand` 新形状》；写成 spec 订正 + 计划裁决表 | 裁决编号连续（上一片用到 R687，本片从 **R688** 起） |
| **P1 协议侧** | 按裁决改 `protocol`/`shared`/`game-service`/`view.builder` + 校验 + 契约单测；`conformance` 同步（不动既有断言的强度） | `packages/**` 全绿；`pnpm run ci` 六阶段；conformance 全绿 |
| **P2 素材基建** | `src/static/` 目录 + 拷素材（54 面 + 背 + UI/头像 + 音效）· `ASSETS.md` 溯源 · `.gitignore` 排除 `reference/` · **产物体积断言** · 首次实测 `<image>` 三端路径解析（mp 只看不承诺） | H5/App 产物含素材；体积断言绿；`reference/` 不再出现在 `git status` |
| **P3 牌面接素材** | `Card.vue` 换 `<image>`（根仍 `<button class="card">`，`data-value` 保留；`toDisplay()` 退居 `aria-label`）+ 兜底 + 牌背统一比例 + 大小两档 | **`.table__me .card` 数量、`data-value`、点击/选中/载荷断言一条不许变**；探针 gate 16/16；`scripts/**` 零改动 |
| **P4 桌面/座位/面板** | 桌面底纹、按钮/面板 9-slice、头像；顺带修**张数 > 名字**权重与**报单/报双**（`cardCounts ≤ 2`）预警 | 座位锚点（`.seat`/`.seat__timer`）与探针锚点不变；令牌先加后用 |
| **P5 音效与动效** | `uni.createInnerAudioContext()` + **R692 的事件表** + 开关/音量持久化 + OGG→mp3（**用系统 `ffmpeg` 的脚本，不进依赖**）；发牌错峰/翻底牌/出牌/结算动效 + `prefers-reduced-motion` | 音效**不得进入判据路径**（探针零异常）；App 为主验证面 |
| **P6 文档订正** | spec §7-①（简约纸牌风/零素材）改为**素材版**；§1 硬边界加「素材只能来自 `static/` + 必须 `ASSETS.md` 溯源 + 体积预算闸」；`agent-briefs.md` 的三端纪律改为 **H5 + App**、小程序状态改写 | 文档与代码一致（不允许「文档说零素材、代码里有图」） |

## 4. 必须带过去的既有纪律与陷阱（上一片换来的）

1. **锚点零改动**：9 个探针 class + `scripts/browser-e2e.mjs` 不改；`判据只增不减`（8 个契约测试字面 `it(` 计数基线 **65**，只许增）。
2. **样式只用令牌**（`$ftl-*`）：改素材/尺寸**先加令牌再用**；`ui-tokens` 闸禁组件里的 hex/px（**图片路径不受影响**，但尺寸仍须令牌/rpx）。
3. **三端能力**：`uni.xxx()` 直接成员调用（闸：`uni-api-access`）；不得 `document`/`window`/`fetch`；不得 `typeof import.meta`（闸：`import-meta-guard`）。
4. **scoped 样式只到子组件根节点**：把按钮/元素抽进子组件后**必须自持样式**（上一片 ➏ 的 Important 回归）；已上机械闸（渲染 `class="btn` 的组件必须自持 mixin + 主色）。
5. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 返回 `[]`）；已上单根闸（含 `lobby`/`login`/`table`/`Settlement`）。
6. **牌桌区源码与注释里禁止 `×` 紧跟数字**（`table-bid-ui` 有一条**遗留 raw 判据**）；**不得逐字写注释定界符**（`comment-stripping` 的 C1 守卫会红）。
7. **`mount()` 把 SFC 样式完整注入 jsdom 且不做 scope 过滤** ⇒ 行为判据**看不见**「样式丢失/观感」类问题 ⇒ 观感类改动只能用**产物 CSS / 真浏览器 / App 走查**，**不要造假判据**。
8. **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须 `pnpm --filter @fight-the-landlord/client build:app` 单独跑；探针**独占**跑（8 容器 healthy + `DEL ratelimit:ws-conn:::ffff:172.19.0.1` + 清残留 vite；`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
9. **证据卫生**：门禁日志的 mtime 必须**晚于**最后一次改动/commit（R682）。
10. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

## 5. 新会话怎么开始（给接手的 agent 的固定动作）

```bash
cd /home/howe/pokergame && git log --oneline -5 && git status --porcelain
# 必读（按序）：
#   1) 本文
#   2) docs/superpowers/specs/2026-09-18-reference-ui-teardown.md（两份参考的拆解与许可结论）
#   3) docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md（含 §12 执行期订正）
#   4) docs/superpowers/plans/2026-09-17-slice-ui-02-table.md（含裁决表 R646–R684 与门禁实测，纪律来源）
#   5) docs/design.md §12（哑终端）/ §13（测试与 CI）
#   6) 上一片台账：.superpowers/sdd/2026-09-17-slice-ui-0{1,2}-*/progress.md
# 然后：先与用户确认 §2 的 (甲)/(乙)，再用 writing-plans 写计划
```

**待用户确认的唯一契约问题**：§2 的 **(甲) 只在下发路径补花色**（推荐，规则面零改动）还是 **(乙) 内部也改成 `{r,s}`**。
