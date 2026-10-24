# 对局 UI 重设计 · ②「牌桌」实施计划（➌ 座位几何 + ➍ 卡牌/手牌 + ➎ 出牌区/反馈 + ➏ 叫抢/底牌 + ➐ HUD + ➑ 结算演出）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `subagent-driven-development` 逐 Task 实施（每 Task 一个新实现者 agent + 任务评审 + 修复循环；**同一时刻只派一个实现者**）。步骤用 `- [ ]` 复选框跟踪。

**Goal：** 把 `pages/table/table.vue` 从「平铺文本」重建为**一张真正的牌桌**：三家环绕、信息各就各位、每次动作都有可见回应、结算看得懂分是怎么来的。

**Architecture：** 只改 `apps/client/**`。`table.vue` 保留全部既有脚本接线与**全部既有 class 锚点**，模板拆成三段（对手两家 / 中央桌面区 / 我的区域 + 行动条），把结构件拆成 6 个单一职责组件（`Seat` / `PlayArea` / `BidPanel` / `BottomCards` / `TableHud` + 重写的 `Card` / `Hand` / `Settlement`）。前端仍是**哑终端**：本片不引入任何规则判定、不新增服务端字段、不动 `packages/**`、不改协议。

**Tech Stack：** uni-app（Vue 3 `<script setup>` + `view`/`text`/`button`）· Pinia · SCSS 令牌（`src/uni.scss`）· Vitest + `@vue/test-utils` · 真浏览器探针 `scripts/browser-e2e.mjs`。

**Spec（权威）：** `docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md`（§1 硬边界 · §5-➌➍➎➏➐➑ · §6 总验收判据 · §7 三条裁决 · §9 风险 · §10 锚点迁移清单）。执行者**必须**先整篇读 spec。

**配套计划：** `docs/superpowers/plans/2026-09-17-slice-ui-01-login-lobby.md`（➊➋ 前两屏，**先落地**）。

---

## Global Constraints（spec §1 + `docs/design.md` §12，逐字遵守；每个 Task 都隐含包含本节）

1. **§12 哑终端**：前端**不得**含任何规则判定（牌型识别、能否压过、倍数计算一律不在前端）——「这张牌能不能出」**只能**以服务端 ack 为准。➎（错误文案 vs 错误判定）与➐（倍数展示 vs 倍数计算）是本片最易越线的两块，**每块的判据都写死了这一点**。
2. **样式只用令牌**：颜色/间距/圆角/字号一律取 `src/uni.scss` 的 `$ftl-*`；**禁止硬编码 hex / px**（`test/ui-tokens.test.ts` 是闸）。**新增视觉语言先加令牌再用**（spec §9.5）。
3. **三端一套**：`uni.xxx()` 必须**直接成员调用**（`test/uni-api-access.test.ts`）· 不得用 `document`/`window`/`fetch` · 不得写 `typeof import.meta` / `import.meta.url`（`test/import-meta-guard.gate.test.ts`）· 动效在 `mp-weixin` **降级不崩**。
4. **锚点成对迁移**：本片必须保住 6 个牌桌锚点 —— `.table__bar .btn`（**且文案逐字「返回大厅」**，探针按文本点击）· `.table__bid-grab` · `.table__pass` · `.table__play` · `.table__me .card` · `.table__notice`。
5. **判据只增不减**：`table-bid-ui` / `table-play-ui` / `table-ended-ui` / `table-settlement-ui` / `ui-flow` + four 机械闸一条断言都不许弱化或删除（**只能加**）。
6. **零新依赖**；**不引入新的 `wd-*` 组件**（沿用已替身的 6 个 + 原生标签）。
7. **不得伪造**：不新增展示字段；`packages/**` 只读。
8. **倒计时不得新造时钟**（spec §9.6）：UI **只消费**页面里唯一那个 `useCountdown` 的剩余毫秒（基准是服务端 `turnDeadlineAt`）；组件里**不得**再 `new Date()` 起算。
9. **提交纪律**：每个 commit 末尾带
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；
   **禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

---

## 开工前裁决（spec §7 + 本片对「设计要求 vs 契约实测」的裁决）

> 本片的执行者**不得**重新探索需求。下面每条都是协调者**实测**后定的；「实测依据」列就是证据。

| # | 触发事实（实测） | 裁决 | 落到哪个 Task |
|---|---|---|---|
| **R646** | 用户 2026-09-17 裁决 spec §7 三条「都按推荐」 | ①**简约纸牌风**（CSS + 令牌 + `view`/`text`，照抄信息结构、不照抄美术）②**只做斗地主入口**（结构留列表位）③「提示」**本批不做** | 本片全部 |
| **R647** | 探针 `clickByText` 是 **textContent 精确匹配**（`b.textContent.trim() === text`） | 既有锚点按钮的**文案逐字保留**（「返回大厅」「抢」「不抢」「出牌」「过牌」的既有形态）；重排只许**加** class | ➌➏➐ |
| **R654** | `PlayerView`（`packages/protocol/src/views.ts:47-79`）**没有** `baseScore`；`baseScore` 只存在于 `RoomInfo:22` 与 `SettlementResult:84` | ➐ 牌桌 HUD **只展示 `PlayerView` 里真的有的数字**：`bidPhase.bidMultiplier`（倍数）与 `playPhase.bombCount`（炸弹数）**原样**渲染。**底分与「我的分」不在牌桌显示**（要显示必须先扩协议 ⇒ 按 §1.7/§7-③ 不在本批）。底分已有展示位：大厅房间列表 `RoomInfo.baseScore`、结算面板 `SettlementResult.baseScore` | ➐ |
| **R655** | DouZero 编码是 **rank-only**（`protocol.codec.ts` 只有 `toDisplay`，无花色访问器；`hand` 值域 3–14/17/20/30） | ➍ 牌面 = **角标点数 + 中央点数 + 红/黑**（红黑由 `toDisplay` 的结果推出，与现状同源）；**不渲染花色符号**（数据里没有花色）。理牌**只按点数**（升序/降序，按协议牌值数值排序）——「按花色」不可实现 | ➍ |
| **R656** | `PlayerView` 只有 `lastPlayedHand` + `lastPlayerIdx`（**没有**各家历史出牌） | ➎ 出牌区**只渲染最近一手**并把「归属指向」标到 `lastPlayerIdx` 那个座位；「三家同时展示已出牌」需要新契约字段 ⇒ 不在本批（§1.7）。过牌**不改变** `lastPlayedIdx`（`packages/shared/src/ddz/play.test.ts:222`），因此过牌气泡只能是**本地回声** | ➎ |
| **R657** | 判断「现在该叫还是该抢」只能从 `grabActions`/`landlordCandidate` 推断 = **前端规则判定** | ➏ 按钮文案**不**随叫/抢变化（保持既有「抢」/「不抢」两个锚点，R647）；面板只把 `bidPhase.bidMultiplier` **原样**显示为「当前倍数 N」 | ➏ |
| **R658** | `SettlementResult` 无炸弹字段（`playPhase.bombCount` 是过程值，不属于结算载荷） | ➑ 结算明细只用**载荷字段**（底分/倍数/春天）＋每家分数变化（`landlordScoreChange`/`farmerScoreChange`）；**不显示炸弹数**。「再来一局」= 回大厅 + `store.requestRematch()`，由**大厅**消费（`room.match` 仍只有大厅一处实现） | ➑ |
| **R659** | `table-bid-ui.test.ts` 的 `LOCAL_SCORING_TRACES` 只扫 `table.vue`（本片要新增 5 个牌桌组件 ⇒ 覆盖面会**变窄**） | 把扫描面**增量扩大**到牌桌区全部组件（每个 Task 把新文件加进清单；➐ 收尾断言清单长度 = 8）。**显式排除 `Settlement.vue`**（它是结算载荷的展示面板，`底分/倍数` 是载荷字段名，理由写进清单注释）。<br>⚠️ **新判据的违规类断言一律读剥注释视图**（`test/helpers/source-scan.ts` 的 `stripComments`）—— 这是本仓既有裁决 **R572/R622**（`source-boundary.test.ts:16-19`）：按原始文本匹配会把**解释本身**打红，逼着后来人删解释（P19 已付代价）。**存在性**断言（「文件被读到了」「清单长度」）才读原始文本。既有那条（`table-bid-ui` 第一条用例）是**遗留例外，一字不改** | ➌➍➎➏➐ |
| **R660** | `.table__me .card` 被两张测试当成**我的手牌**（`table-play-ui` 断言 `toHaveLength(PLAYING_HAND.length)` 且按下标点第 12 张）；探针也数它 | **自己座位的座位卡不得渲染牌背扇**（`Seat` 的 `show-backs=false`）：手牌已直接可见、牌背扇是冗余信息，且它会污染这个锚点的语义。两个对手座位照常画 N 张牌背 | ➌ |
| **R661** | 探针 `seedFinishedGame` 注入的 view **没有 `playPhase`**（`scripts/browser-e2e.mjs:483-495`），而探针断言「全程零异常」 | 所有新组件对**缺字段的视图**必须容错（`?.` + `??` 兜底，缺值渲染 `—`），并各带一条「喂缺字段视图不抛错」的用例 | ➐（HUD）必带，其余 Task 同样适用 |
| **R662** | `Hand.vue` 渲染顺序 = `cards` 的顺序，而选中态语义是 `store.hand` 的**下标**（R173/N18） | ➍ 的排序是**展示顺序**（`order` 计算属性），`toggle` 一律 emit **原始下标**；`sort` 默认 `'none'`（保证既有用例的「第 12 张」语义不变）。排序比较器**只按协议牌值数值**——**不得**调 `toInternalRank`/`toDouZero`（那是规则面映射，且 `source-boundary` 有闸） | ➍ |
| **R663** | `apps/client/test/setup/uni-easycom.ts` 只替身了 6 个 `wd-*`；新增用法会静默失配 | 本片不用任何新的 `wd-*`；`wd-tag`（地主标）与 `wd-card`/`wd-divider`（结算）沿用现状 | 全部 |
| **R653** | 门禁口径（与计划①共用） | **每 Task**：**三端构建**（R669：`turbo run build --force` 对 client **只出 h5** ⇒ 必须再逐端 `build:mp-weixin` / `build:app`，且跑前 `rm -rf apps/client/dist/build/{mp-weixin,app}`）+ `turbo run test lint --force`（29/29、0 cached）+ 定向用例 + **探针** `pnpm run e2e:browser`（gate 16/16）。**本计划收口**：`pnpm run ci` 六阶段 + 探针 gate 16/16 与 full 20/20 | 全部 |

| **R669** | **执行期实测**：`turbo run build --force` 对 `apps/client` **只出 h5**（client `build` = `vue-tsc --noEmit && uni build`；三端在 `build:h5`/`build:mp-weixin`/`build:app` 三个脚本里）⇒ 原 R653 的「三端 DONE」在本片**从未被真正验证**（目录存在 ≠ 产物新鲜） | **门禁口径订正（两份计划共用）**：三端 = `rm -rf apps/client/dist/build/{mp-weixin,app}` + `turbo run build --force` + `build:mp-weixin` + `build:app` + `ls`；并**回补计划①**（其收口时的三端声明证据不足，已逐端重跑并在计划① 的「门禁实测」节写明） | 低：门禁多两条命令（≈40s/端）。若判错（即 `turbo build` 其实覆盖三端），等于白跑两条构建；反之若沿用旧口径，**后续每个 Task 的「三端齐」都是未验证的声明** |
| **R670** | brief 三处瑕疵（Step 10 的 `git add` 漏 `Card.vue`；新用例未用 `bidPhase` ⇒ 照抄触发 `noUnusedLocals`；Step 2 预言 RED 3 条、实测 2 条） | 以**实测/实现**为准订正计划文本（实现者的 5 条断言一字未改） | 无（计划文本与现实的偏差） |
| **R671** | `table.vue` 手牌区的 `column-gap: -$ftl-space-6` 是**非法负 gap**（浏览器/WXSS 丢弃 ⇒ 手牌其实没重叠、靠换行铺开） | 划进 ➍ 的范围修成**合法重叠**（`.hand .card + .card { margin-left: -$ftl-space-6 }`）；硬约束：锚点断言一条不许变，变红就回退 | 低：手牌换行观感退化为现状 |
| **R672** | ➍ 评审 5 条 Minor，其中 R671 的**净重叠实为 12rpx**（`Hand.vue` 的 `gap: 4rpx` 已占 `column-gap`）⇒ 20 张 = 732rpx **仍换行**，与本块交付目标相悖 | **一次有界清理轮**：① 补 `column-gap: 0` + 订正账目 + 源码级漂移判据 ② 断言收紧 ③ 双字符面值 `.card--wide`（可测分支）④ 补 `value:20 ⇒ card--black`；第 5 条（不可达三元）不做 | 多一轮修复+复审；换来 4 条 Minor 当场关闭（比丢给最终全分支评审触发修复波便宜） |
| **R673** | ➎ 把**本地动作错误**的 `.table__notice` 排在会话 notice 之前（13001 会同时触发 TOAST 会话 notice，两者同 class） | **接受**：该断言**失败即红**（顺序反转 ⇒ `find` 拿到会话文案 ≠ `actionErrorMessage`），不是假绿；代价是用例与 DOM 顺序耦合 | 低：将来改顺序必须同步改用例 |
| **R674** | ➎ 的 `ownerLabel` 由页面传座位名、`PlayArea` 模板缀「 出」 | **接受**（DOM 逐字「玩家1 出」且有判据钉住） | 无 |
| **R675** | ➎ 评审指出「**无断言钉住零本地计时器**」（spec §9.6 的强制项只靠 grep 声称） | 在 R659 的同一扫描面加**负面断言**：牌桌区组件不得含 `setTimeout`/`setInterval` + 正对照 | 低：一条廉价断言 |
| **R676** | ➏ 评审的 Important：把两个叫抢按钮抽进 `BidPanel.vue` 后**三端全部丢掉 `.btn` 样式**（父组件 scoped 规则只作用于子组件**根节点**，进不到子组件模板内部），且**所有闸都看不见**（jsdom 不加载 CSS、探针只点击） | 判为**成立必须修**：组件**自持** `@include ftl-btn` + `.btn--primary` + `:disabled` + 等宽；**并加机械闸**（`src/components/**` 里渲染 `class="btn` 的组件必须自持 mixin；渲染 `btn--primary` 的必须自持主色 `background`）+ 三端产物自证 | 低：将来「父级 `:deep()` 供样式」的写法会被要求补 mixin（fail-closed） |
| **R677** | ➐ 的 brief 正对照样本实测**只有 4/5 命中**（第 5 条正则要求 `multiplier` 后紧跟运算符） | **接受**实现者的替换样本（5/5），避免一条永远红的假判据 | 无（计划文本的样本笔误） |
| **R678** | ➐ HUD 在「等待发牌」态也常驻（三值皆 null ⇒ 渲染 `—`） | **接受**：常驻 = 少一个未被任何判据覆盖的分支；`—` 已是文档化的缺值语义 | 低 |
| **R679** | ➐ 评审的 Important：`TableHud.vue` 的模板注释放在**根元素之前** ⇒ 组件**真的多根**（评审用 `@vue/compiler-sfc` 编译取证），将来 `mount(TableHud).classes()` 会静默 `[]` | **成立必须修**：注释移进根内；**并加单根闸**（`mount(组件).classes()` 断言根 class —— 多根时返回 `[]`，当场红），覆盖牌桌区 **8/8** | 低：一条极廉价断言 |
| **R680** | 同轮评审的 Minor 里有一条**真漏洞**：R675 注释里「排除 `table.vue`」的理由**不成立**（该闸读**剥注释视图**，`table.vue` 剥完两个计时器 API 命中 0）⇒ 「往 `table.vue` 写裸 `setInterval`」会逃过闸 | **把 `table.vue` 纳入 R675 扫描面（7 → 8）并改正理由**（spec §9.6 是强制项，靠错误理由排除 = 判据静默失效） | 低：`table.vue` 若真自建时钟会被拦（正是我们要的） |
| **R681** | 单根闸一上就抓出**既有缺陷**：`table.vue` 自己也是多根（➌ 起）；另实测 `lobby.vue` / `login.vue` / `Settlement.vue` 同样多根（编译取证） | `table.vue` 一并修 · `Settlement.vue` 归 ➑ 修并纳入单根闸 · `lobby.vue`/`login.vue`（**P10/➊➋ 起的既有形态、今天无观测后果**）**登记为最终全分支评审 triage 项**，不在本片扩范围 | 低：两个页面的 fragment root 再留一程（改法是把根前注释移进根内，两行） |
| **R682** | ➐ 的「全绿」日志 `/tmp/gate2.log` mtime **早于**最后一轮文件改动 ⇒ 未必覆盖最终树 | **不单独补跑**（会与 ➑ 实现者并发抢 5173/网关名额）：改由 **➑ 的当轮门禁** + **计划② 收口的全量门禁**共同覆盖，并在此留痕 | 低：一处证据时效瑕疵被显式记录而非掩盖 |
| **R683** | ➑ 实现者指出**派工单内部冲突**：派工单 #8 说「不需要 `@include ftl-btn`」，而 brief #3 要求 `.settlement__again` 是 `.btn--primary`、且 F3 机械闸要求渲染 `.btn` 的组件自持混入 | **以闸为准**：保留 `.btn`/`.btn--primary` 并让 `Settlement.vue` **自持**样式（派工单那句「不需要」是**协调者的错**） | 无 |
| **R684** | ➑ 评审的 Important（plan-mandated）：「再来一局」的**接收半边零判据覆盖** —— 删掉 `lobby.vue:263` 整套测试仍全绿、探针也看不到 | **成立必须修**：加**页面级**判据（置 `rematchPending=true` → mount `LobbyPage` → `room.match` 恰 1 条 + 载荷 + 意向已清）+ 幂等对照，且**先写先红**（临时删 `lobby.vue:263` 必须红） | 低：一条廉价用例；不修则「没有判据的链路等于没有实现」 |

### 锚点与既有判据（spec §10；本片必须逐条落进 Task）

- 探针锚点（`scripts/browser-e2e.mjs`）：`.table__bar .btn`（**点「返回大厅」**，`backToLobby()`）· `.table__bid-grab`（`full` 场景自动叫抢点它）· `.table__me .card`（点第一张出牌；计数 ≥17）· `.table__play` · `.table__pass` · `.table__notice`（`READ_STATE` 读它的 innerText）。
- 行为契约测试：`table-bid-ui`（`.table__bid-grab` / `.table__bid-pass` 存在与禁用 · **阶段互斥** · 载荷 `{grab}` · `baseVersion` · 本地倍数/底分痕迹的**源码级**闸）· `table-play-ui`（`.table__me .card` **长度=手牌数** · `data-value` · 选中态按实例 · **首出时过牌按钮不得禁用** · 倒计时 = `turnDeadlineAt`） · `table-ended-ui`（`.table__ended` · 终局四个动作 class 全不存在 · **`.seat__timer` 在终局必须为 0 个**） · `table-settlement-ui`（9 个稳定 class 与**逐字文案**） · `ui-flow`（`findAllComponents({name:'Card'})` ≥ 手牌数）。
- 基线读数（开工实测，2026-09-17）：`apps/client` = **304 passed + 2 skipped**；`turbo run test lint --force` = **29/29、0 cached**；8 容器 healthy；5173 空闲。

---

## 文件结构（先定边界，再定 Task）

| 文件 | 动作 | 职责 | 首次出现的 Task |
|---|---|---|---|
| `apps/client/src/pages/table/table.vue` | 模板重排（脚本接线**逐字保留**） | 三段布局骨架 + 行动条 + 全部既有 store 接线与 4 个动作按钮 | ➌ |
| `apps/client/src/components/Seat.vue` | **新建** | 座位：头像位 / 昵称 / 牌背扇 / 地主标 / 轮次指示 / 倒计时条（消费传入的剩余毫秒） | ➌ |
| `apps/client/src/components/Card.vue` | ➌ 加 `face-down`（牌背）→ ➍ 重写牌面（保 API） | 一张牌：角标点数 + 中央点数 + 红/黑；`face-down` 时渲染牌背 | ➌（牌背）· ➍（牌面） |
| `apps/client/src/components/Hand.vue` | 扩（保 API） | 一手牌：排布 + **展示排序**（原始下标不变）+ 选中态按实例 | ➍ |
| `apps/client/src/components/PlayArea.vue` | **新建** | 中央出牌区：最近一手 + 归属座位指向 + 过牌/动作气泡 | ➎ |
| `apps/client/src/net/action-copy.ts` | **新建** | R651 同族：`actionErrorMessage(code)` —— 对局动作错误码 → 人话（**纯查表**） | ➎ |
| `apps/client/src/components/BidPanel.vue` | **新建** | 叫抢按钮组（抢 / 不抢）+ 当前倍数（原样展示） | ➏ |
| `apps/client/src/components/BottomCards.vue` | **新建** | 底牌位：叫抢期 3 张牌背 + 「叫抢阶段不可见」；翻开后显示牌面 | ➏ |
| `apps/client/src/components/TableHud.vue` | **新建** | HUD 状态条：倍数 / 炸弹数 / 房间码（全部原样，零运算） | ➐ |
| `apps/client/src/components/Settlement.vue` | 重写（保 9 个 class 与逐字文案） | 结算演出：胜负标题 + 三家分数行 + 载荷构成明细 + 再来一局/返回大厅 | ➑ |
| `apps/client/src/uni.scss` | 加令牌 | ➌ 6 个（座位底色/桌面区底色/头像直径/倒计时条高/牌背色/牌背纹样色）· ➍ 2 个（角标字号/选中抬升） | ➌➍ |
| `apps/client/src/stores/game.ts` | 加 2 个 action + 1 个 state | R658：「再来一局」的一次性意向（`rematchPending`） | ➑ |
| `apps/client/src/pages/lobby/lobby.vue` | 加 3 行 | 大厅挂载时消费一次性重赛意向（唯一交叠文件，见「计划间交叠」） | ➑ |
| `apps/client/test/*` | 加/扩 | 每 Task 的定向判据；`LOCAL_SCORING_TRACES` 逐 Task 扩清单（R659） | 全部 |

**不动**：`src/pages.json` · `src/router.ts` · `src/composables/useCountdown.ts`（**只消费**）· `test/setup/uni-easycom.ts` · 一切 `packages/**` · 一切 `scripts/**`（探针一个字不改 —— 保锚优先，R647）。

### 计划间交叠（唯二两处，执行者必须知道）

1. `src/pages/lobby/lobby.vue`：计划① 重排玩法入口区，本计划➑ 加 3 行消费重赛意向。**默认 ① 先落地**；若并行，合并时以 ① 的版本为基、只在 `onMounted` 里插 3 行。
2. `src/net/`：① 新建 `copy.ts`（登录/注册文案），本计划➑➎ 新建 `action-copy.ts`（对局动作文案）。**刻意不合并**成一个文件 —— 合并会让两份计划互相耦合，而 spec §11.2 要求前两屏与牌桌无代码耦合。

---

## Task 1：➌ 牌桌骨架与座位几何

**Files:**
- Create: `apps/client/src/components/Seat.vue`
- Create: `apps/client/test/table-seat-geometry.test.ts`
- Modify: `apps/client/src/pages/table/table.vue`（模板三段布局 + 对手区改用 `Seat`）
- Modify: `apps/client/src/components/Card.vue`（**只加 `faceDown` 这一个能力**：`.card--back` + 牌背样式；牌面的重写在 ➍）
- Modify: `apps/client/src/uni.scss`（加 6 个令牌）
- Modify: `apps/client/test/table-bid-ui.test.ts`（R659：把 `table.vue` + `Seat.vue` + `Card.vue` 加进 `LOCAL_SCORING_TRACES` 清单）

**Interfaces:**
- Produces: `Seat.vue`
  ```ts
  props: {
    seat: number;
    name: string;
    cardCount: number;
    isLandlord: boolean;
    isActive: boolean;
    seconds: number;            // 由页面的 useCountdown 传入（§9.6：组件内不得新造时钟）
    remainingMs?: number;       // 同上；仅用于画出进度比例
    totalMs?: number;           // 服务端给的回合时长（store.activeTurn.timeoutMs）；0/缺省 ⇒ 不画进度
    showBacks?: boolean;        // R660：自己座位传 false
    size?: 'opponent' | 'me';
  }
  emits: 无
  ```
- Consumes: `Card.vue` 的 `face-down`（**本 Task 自己加**：牌背是「牌背扇」的依赖，先有它才有扇）· `store.cardCounts` / `store.landlordSeat` / `store.actorSeat` / `store.mySeat` / `useCountdown` 的 `seconds` 与 `remainingMs`
- DOM 契约（**既有 class 一个不改**）：`.seat` · `.seat--active` · `.seat__name` · `.seat__badge`（`wd-tag` 地主）· `.seat__count`（`剩 N 张`）· `.seat__timer`（`{{seconds}}s`，**只在 `isActive` 时渲染**）；新增：`.seat__avatar` · `.seat__backs` · `.seat__countdown` · `.seat__countdown-fill` · `.seat--me` · `.table__center`（中央桌面区容器）· `Card` 的 `.card--back`（牌背）

### 设计定稿（执行者按此写）

- **三段布局**（`table.vue` 的 `.table` 内）：
  1. `.table__bar`（**保留**：房间 / 版本 / 三态文字 / `返回大厅` 按钮 —— 探针锚点，文案逐字「返回大厅」）；
  2. `.table__opponents`（两个对手，`v-for="seat in seats"` → `<Seat :show-backs="true" size="opponent" …>`）；
  3. `.table__center`（中央桌面区：**保留**内部既有 `.table__row` / `.table__label` 结构 —— 上一手牌 + 底牌；➎➏ 会分别接管这两行）；
  4. `.table__me`（我的区域：`.table__me-head` **包住** `<Seat size="me" :show-backs="false">` —— 这样 `.table__me-head .seat__timer` 这条既有锚点继续成立）+ 手牌区；
  5. `.table__actions`（行动条，➏ 接管叫抢分支）。
- **牌背扇**：`.seat__backs` 内 `v-for="n in cardCount"`，每张是 **`<Card face-down size="small" />`**（`.card--back`，`margin-left: -$ftl-space-6` 形成叠放）。牌背由**本 Task** 加进 `Card.vue`（`faceDown` prop ⇒ `.card--back`：底色 `$ftl-color-card-back` + 一道 `$ftl-color-card-back-line` 边框纹样，纯 CSS、零素材；**不渲染任何文字、不渲染 `data-value`、`disabled`、点击不 emit**）；牌**面**的重写在 ➍。⚠️ `BottomCards`（➏）与本扇共用同一份牌背实现，**不得**出现第二份牌背样式。
- **轮次强指示**：`.seat--active`（描边 `$ftl-color-primary` + `$ftl-shadow-primary-ring` + 底色 `$ftl-color-seat-active-bg`）+ `.seat__timer`（数字）+ `.seat__countdown` 进度条（`.seat__countdown-fill` 的 `width` 是**两个服务端数字之比**：`remainingMs / totalMs`，`totalMs <= 0` 时**不渲染** `.seat__countdown-fill`）。
  ⚠️ 这条比例**不是**规则计算（§12 管的是牌型/倍数/胜负），它是「服务端给的两个时长」的**显示比例**；**不得**由它推出任何超时行为（超时归服务端，F06）。
- **令牌先加后用**（spec §9.5）—— 本 Task 在 `src/uni.scss` 追加：
  ```scss
  /// 行动中座位的底色（浅主色）
  $ftl-color-seat-active-bg: #eef4fd;
  /// 桌面区（中央）底色
  $ftl-color-table-center: #f7f9fc;
  /// 座位头像位直径（圆形占位：本仓零美术资源，用字块代替头像）
  $ftl-size-avatar: 72rpx;
  /// 倒计时条高度
  $ftl-size-countdown: 8rpx;
  /// 牌背底色（深品牌蓝）
  $ftl-color-card-back: #1e4e8c;
  /// 牌背纹样色
  $ftl-color-card-back-line: #7fa5d6;
  ```
- 顺手收口（spec §1.2）：本 Task 触及的样式里，凡「间距/圆角/字号/颜色」的字面量换成令牌（`table.vue` 里手牌区的 `column-gap: -16rpx` → `-$ftl-space-6`）。

- [ ] **Step 1：先写失败测试**

`apps/client/test/table-seat-geometry.test.ts`（挂载脚手架照抄 `table-bid-ui.test.ts` 的 `mountTable` 与 `bidPhase`/`playerViewFixture` 用法；`afterEach` 必须 `unmount()` 以回收 `useCountdown` 的 250ms 定时器）：

```ts
/**
 * ➌ 座位几何（spec §5-➌ + R660 + §9.6）。
 *
 * 判据四条：
 *  ① 两家对手各有 `.seat`，各自渲染 `cardCount` 张牌背；
 *  ② 轮次指示随 `actorSeat` 转移（**正反两面都断言**：转移前在 A 不在 B，转移后在 B 不在 A）；
 *  ③ 自己座位**不画牌背扇**（R660：`.table__me .card` 必须仍然只数得到手牌）；
 *  ④ 终局没有任何 `.seat__timer`（**既有判据的延续**：actorSeat 为 null ⇒ 不渲染倒计时）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';

// …mountTable / bidPhase 脚手架逐字照抄 table-bid-ui.test.ts…

describe('➌ 座位几何', () => {
  it('两个对手座位各画 N 张牌背；自己座位不画（R660）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, cardCounts: [17, 5, 3] }), 1),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.seat')).toHaveLength(3);                              // 2 对手 + 1 我
    const counts = [...wrapper.findAll('.seat')].map((s) => s.findAll('.card--back').length);
    expect(counts.filter((n) => n > 0).sort()).toEqual([3, 5]);                   // 只有两个对手画了牌背
    expect(wrapper.find('.table__me').findAll('.card--back'), 'R660：自己座位不画牌背扇').toHaveLength(0);
    // 正对照：`.table__me .card` 仍然只数得到手牌（牌背混进去会让两张既有测试静默失配）
    expect(wrapper.find('.table__me').findAll('.card')).toHaveLength(17);
  });

  it('轮次指示随服务端行动者转移（正反两面）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, currentPlayer: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat--active')).toHaveLength(1);
    expect(wrapper.find('.seat--active').text()).toContain('玩家1');

    socket.push(
      serverMessage('game.state_update', playerViewFixture({ state: 'playing', seat: 0, version: 2, currentPlayer: 2 }), 2),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat--active')).toHaveLength(1);
    expect(wrapper.find('.seat--active').text()).toContain('玩家2');
  });

  it('地主标记只出现在 `landlordSeat` 那个座位（服务端字段，不做推断）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, landlordSeat: 2 }), 1),
    );
    await wrapper.vm.$nextTick();
    const badged = wrapper.findAll('.seat').filter((s) => s.find('.seat__badge').exists());
    expect(badged).toHaveLength(1);
    expect(badged[0]!.text()).toContain('玩家2');
  });

  it('倒计时条只在服务端给了回合时长时画填充（缺 totalMs 时只显示数字，不崩）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, currentPlayer: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    // 没有 current_turn 事件 ⇒ 没有 totalMs ⇒ 不画填充（但数字在）
    expect(wrapper.find('.seat__timer').exists()).toBe(true);
    expect(wrapper.find('.seat__countdown-fill').exists()).toBe(false);

    socket.push(serverMessage('game.current_turn', { seat: 1, timeoutMs: 30_000 }, 1));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.seat__countdown-fill').exists()).toBe(true);
    expect(store.activeTurn?.timeoutMs).toBe(30_000);
  });

  it('终局不渲染任何倒计时（既有判据延续）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playerViewFixture({ state: 'ended', seat: 0, version: 3 }), 3));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat__timer')).toHaveLength(0);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
  });
});
```

- [ ] **Step 2：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test table-seat-geometry`
Expected: FAIL —— `.card--back` / `.seat--active`（3 个 `.seat`）尚不存在（现在只有 2 个对手 `view.seat`）。

- [ ] **Step 3：加令牌（先加后用）**

在 `src/uni.scss` 的「控件尺寸」段之后追加上面**六个**令牌（注释逐字保留理由）。

- [ ] **Step 4：给 `Card.vue` 加 `faceDown`（牌背）**

props 增 `faceDown?: boolean`（默认 `false`）；`faceDown` 时渲染 `.card--back`：**无文字、无 `data-value`、`disabled`、点击不 emit**。牌背只用 `$ftl-color-card-back` / `$ftl-color-card-back-line` 两个令牌 + 纯 CSS 纹样（零素材、三端一致）。

- [ ] **Step 5：写 `Seat.vue`**

按「设计定稿」写；要点：
- 牌背扇 = `<Card v-for="n in cardCount" :key="n" :value="0" size="small" face-down />`；
- `isActive` 为假时**不渲染** `.seat__timer`（用 `v-if`，不是 `v-show`）—— 终局必须 0 个；
- `showBacks` 为假时**不渲染** `.seat__backs`（R660）；
- `.seat__count` 文案保持 `剩 N 张`；地主标沿用 `wd-tag` + `.seat__badge`；
- 零 `document`/`window`/`uni.*`；零计时器（只消费 props）。

- [ ] **Step 6：改 `table.vue`**（三段布局 + 用 `Seat`；`.table__bar` / 四个动作 class / `.table__notice` / 手牌区接线**逐字保留**）

- [ ] **Step 7：跑 client 全量测试确认 GREEN 且判据不减**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— `table-bid-ui` / `table-play-ui` / `table-ended-ui` / `table-settlement-ui` / `ui-flow` 全绿（**一条断言未改**），新增 4 条通过。

- [ ] **Step 8：扩 `LOCAL_SCORING_TRACES` 扫描面（R659）**

在 `table-bid-ui.test.ts` 里新增一条用例（**不改**既有那条）：

```ts
it('R659：牌桌区全部组件都不含本地倍数/底分痕迹（扫描面随组件增加而扩大）', () => {
  /** 牌桌区组件清单：每新增一个牌桌组件，必须在这里 +1（本条断言「清单确实被读到」）。 */
  const TABLE_AREA = [
    'src/pages/table/table.vue',
    'src/components/Seat.vue',
    'src/components/Card.vue',   // 本 Task 起它承载牌背（➍ 起承载牌面）
  ];
  const sources = collectSourceFiles();
  for (const path of TABLE_AREA) {
    const file = sources.find((f) => f.path === path);
    expect(file, `${path} 必须在源码扫描集合里（否则本闸恒绿）`).toBeDefined();
    // ⚠️ 违规类断言读**剥注释**视图（R572/R622）：让解释一个禁词的注释不会把闸打红。
    expect(localScoringTraces(stripComments(file!.content)), `${path} 出现本地倍数/底分痕迹`).toEqual([]);
  }
  // ⚠️ 显式排除 `src/components/Settlement.vue`：它是**结算载荷**的展示面板，
  //    `底分/倍数` 在那里是**载荷字段名**（`SettlementResult.baseScore/multiplier`），
  //    与「牌桌模板本地推导」是两件事（➑ 另有「明细数字全部来自载荷」的独立判据）。
});
```

- [ ] **Step 9：门禁（R653）**

```bash
cd /home/howe/pokergame
# 三端产物（R669：turbo build 对 client **只出 h5** ⇒ 必须逐端构建；跑前删两个产物目录以证明「新鲜」）
rm -rf apps/client/dist/build/mp-weixin apps/client/dist/build/app
pnpm exec turbo run build --force                          # h5 + 全部后端包（期望 10/10）
pnpm --filter @fight-the-landlord/client build:mp-weixin   # 期望 DONE Build complete
pnpm --filter @fight-the-landlord/client build:app         # 期望 DONE Build complete
ls -1 apps/client/dist/build                               # 期望 app · h5 · mp-weixin
pnpm exec turbo run test lint --force        # 29/29、0 cached
docker compose ps                            # 8 healthy
docker compose exec -T redis redis-cli DEL 'ratelimit:ws-conn:::ffff:172.19.0.1'
ss -ltnp | grep 5173 ; pgrep -af vite        # 有残留先 `kill -TERM -<pgid>`（**禁止** pkill -f vite）
pnpm run e2e:browser                         # gate 16/16
```

- [ ] **Step 10：commit**

```bash
git add apps/client/src/components/Seat.vue apps/client/src/pages/table/table.vue apps/client/src/uni.scss \
        apps/client/test/table-seat-geometry.test.ts apps/client/test/table-bid-ui.test.ts
git commit -m "feat(client): ➌ 牌桌三段布局 + 座位几何（牌背扇/地主标/轮次指示）

- Seat.vue：头像位/昵称/牌背扇/地主标/倒计时条（只消费 props，零自造时钟，§9.6）
- R660：自己座位不画牌背扇（.table__me .card 必须仍只数得到手牌）
- 令牌先加后用：seat-active-bg/table-center/avatar/countdown/card-back/card-back-line（uni.scss +6）
- R659：LOCAL_SCORING_TRACES 扫描面扩到牌桌区组件清单
- 保锚：.table__bar .btn「返回大厅」· .seat__timer 终局 0 个

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：➍ 卡牌渲染与手牌交互

**Files:**
- Modify: `apps/client/src/components/Card.vue`（重写观感，**保 API**）
- Modify: `apps/client/src/components/Hand.vue`（加 `sort`，保 API 与选中语义）
- Modify: `apps/client/src/pages/table/table.vue`（加「点数升序/降序」两个理牌按钮 + `handSort`）
- Modify: `apps/client/src/uni.scss`（加 **2** 个令牌）
- Create: `apps/client/test/card-hand-interaction.test.ts`
- Modify: `apps/client/test/table-bid-ui.test.ts`（清单 +1：`Hand.vue`）

**Interfaces:**
- Produces:
  - `Card.vue`：props `{ value: number; selected?: boolean; disabled?: boolean; size?: 'normal' | 'small'; faceDown?: boolean }`；emits `toggle(value)`；DOM：`.card` · `.card--normal|--small` · `.card--red|--black` · `.card--selected` · `.card--disabled` · `.card--back` · `.card__corner` · `.card__center` · `data-value`（**faceDown 时不渲染**）；`defineOptions({ name: 'Card' })`（`ui-flow` 按组件名数它）
  - `Hand.vue`：新增 prop `sort?: 'none' | 'asc' | 'desc'`（默认 `'none'`）；emits `toggle(index)` —— **index 恒为 `cards` 的原始下标**
  - `table.vue`：`.table__sort-asc` / `.table__sort-desc`（`.btn--small`）
- Consumes: `protocol.toDisplay`（**唯一**牌面来源，F10）· `store.hand`

### 设计定稿

- **牌面**（R655）：`.card__corner`（左上角小点数，`$ftl-font-card-corner`）+ `.card__center`（中央大点数，`$ftl-font-card` / `$ftl-font-card-small`），两者都是 `toDisplay(value)` 的结果；红黑沿用既有 `tone` 计算（`toDisplay` 含「大」或等于 `'2'` ⇒ 红）。**不渲染花色符号**（数据里没有花色）。
- **牌背**（➌ 已落地，本 Task **只复用**，不得另写第二份）：`faceDown` ⇒ `.card--back`（无文字 / 无 `data-value` / `disabled` / 点击不 emit）。
- **选中态**：抬升 + 描边（**不是变色**）：`transform: translateY(-$ftl-card-lift)` + `border-color: $ftl-color-primary` + `box-shadow: $ftl-shadow-primary`；`position: relative; z-index: 1`（重叠时浮在上面）。
- **排序**（R662）：`Hand.vue` 的 `order` 计算属性返回**原始下标**数组；`sort==='none'` 时恒等；否则按 `cards[a] - cards[b]` 数值排序（升/降）。**不得**调 `toInternalRank`/`toDouZero`。`v-for` 用 `order`，`:key` 用 `${value}-${index}`，点击 emit **index**。
- **理牌按钮**（spec §5-➍，R655 只做点数）：放在 `.table__me-head` 右侧，两个 `.btn--small`：`点数升序` / `点数降序`；点了写 `handSort`。**不改变**默认顺序、**不改变**选中语义、**不改变** `.table__me .card` 的数量。
- **令牌先加后用**（牌背两色已在 ➌ 加过）：`$ftl-font-card-corner: 24rpx;` · `$ftl-card-lift: 24rpx;`
- 顺手收口：`translateY(-20rpx)` → `translateY(-$ftl-card-lift)`。

- [ ] **Step 1：先写失败测试**

`apps/client/test/card-hand-interaction.test.ts`：

```ts
/**
 * ➍ 卡牌与手牌交互（spec §5-➍ + R655/R662 + F10）。
 *
 * 判据四组：
 *  ① 牌面只来自 `toDisplay`（源码级：不得自制点数映射 —— 与既有 source-boundary 同向，这里补**组件级**断言）；
 *  ② 牌背：无文字、无 `data-value`、不可交互；
 *  ③ 排序是**展示顺序**：排序后点击「第 k 张」仍然作用于**同一个牌实例**（N18 回归），
 *     同点数的 4 张牌在每种排序下都能全部选中；
 *  ④ 默认 `sort='none'` ⇒ 顺序与 `store.hand` 一致（保住 `table-play-ui` 的「下标 12」语义）。
 */
```
（用例至少覆盖：`it('牌面 = toDisplay 的结果（角标 + 中央各一处）')` · `it('faceDown ⇒ .card--back、无文字、无 data-value、点击不 emit')` · `it('点数升序后点击第 k 张仍选中同一实例（payload 按点击顺序）')` · `it('同点数 4 张在升序下可全部选中 ⇒ 载荷 4 张')` · `it('默认顺序 = store.hand 顺序（正对照）')` · `it('源码级：Card.vue 只经 toDisplay 取牌面，无自制映射')`）

源码级判据的形态：
```ts
const card = collectSourceFiles().find((f) => f.path === 'src/components/Card.vue')!;
const cardCode = stripComments(card.content);           // R572/R622：违规类断言读剥注释视图
expect(card.content, '存在性断言读原始文本').toContain('toDisplay');
expect(cardCode, '不得自制点数映射').not.toMatch(/['"](?:大王|小王)['"]/);
expect(cardCode, '排序不得走规则面映射').not.toMatch(/toInternalRank|toDouZero/);
```

- [ ] **Step 2：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test card-hand-interaction`
Expected: FAIL —— `Hand` 不认 `sort`（排序后的点击落错实例）；`.card__corner` 不存在；`.table__sort-asc` 不存在。

- [ ] **Step 3：加 2 个令牌 → 重写 `Card.vue` 的牌面 → 扩 `Hand.vue` 的 `order` → `table.vue` 加理牌按钮**

- [ ] **Step 4：跑 client 全量测试确认 GREEN 且判据不减**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— **`table-play-ui` 的「`.table__me .card` 长度 = 手牌数」「下标 12 = DouZero 17」「两张 3 各选各的」全部仍然绿**（这三条是 R660/R662 的判别力来源）。

- [ ] **Step 5：扩清单（+`Hand.vue`）→ 门禁（R653）→ commit**

（门禁四条命令同 Task 1 Step 9。探针 gate 16/16 必须绿 —— 它在 `full` 场景里点 `.table__me .card` 第一张出牌。）

```bash
git commit -m "feat(client): ➍ 卡牌观感（角标点数 + 红黑）与手牌排序

- Card.vue：角标 + 中央点数，唯一来源 protocol.toDisplay（F10）
- Hand.vue：sort 只改展示顺序，toggle 恒 emit 原始下标（R662/N18 不回退）
- 理牌按钮按点数升/降序（R655：无花色数据，按花色不可实现）
- 令牌 +2（font-card-corner / card-lift）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：➎ 出牌区与动作反馈

**Files:**
- Create: `apps/client/src/components/PlayArea.vue`
- Create: `apps/client/src/net/action-copy.ts`
- Create: `apps/client/test/action-feedback.test.ts`
- Modify: `apps/client/src/pages/table/table.vue`（中央区用 `PlayArea`；错误文案改走 `actionErrorMessage`；气泡状态）
- Modify: `apps/client/test/table-bid-ui.test.ts`（清单 +1：`PlayArea.vue`）

**Interfaces:**
- Produces:
  - `PlayArea.vue` props：`{ cards: readonly number[] | null; ownerSeat: number; ownerLabel: string; bubble?: { seat: number; text: string } | null }`
  - `action-copy.ts` → `export function actionErrorMessage(code: number): string`（**只有 code 一个入参**）
    - 必须覆盖：`13001`（服务端判定这手牌不合法）· `13006`（选中的牌无法组成合法牌型，服务端判定）· `12003`（还没轮到你）· `13004`（牌局已更新，正在为你同步）· `13005`（本局已经结束）· `10006`（操作太频繁，请稍后再试）· `10007`（服务暂时不可用，请稍后重试）· `13007`（这一步超时了，已由服务端处理）· `13009`（本局还没开始）· `10001`（请检查操作内容）· `12001`（房间不存在）· `12002`（房间已满）· `12004`（你不在这个房间里）· **`0` ⇒ `''`** · 未知码 ⇒ `操作未通过（code=N）`
- Consumes: `store.lastPlayedHand` / `store.lastPlayedIdx`（**注意：`store` 现有 getter 里没有 `lastPlayerIdx`** ⇒ 在 `table.vue` 里用 `store.view?.lastPlayerIdx ?? -1` 取）· `Hand.vue` · `store.mySeat`

### 设计定稿

- **出牌区**（R656）：`.table__play-area` 内渲染**最近一手**：`.table__played`（`<Hand :cards="cards">`）+ `.table__played-owner`（归属指向：`{{ ownerLabel }}`，如「玩家1 出」）；`cards === null` 时保持既有「（无）」`.table__muted` 文案。**不伪造**三家历史。
- **过牌/动作气泡**：`.table__bubble`（`v-if="bubble"`，文案来自 `bubble.text`，位置按 `bubble.seat`）。来源**只能是本地回声**：`send()` 返回 `code === 0` 之后才置位（`game.pass` ⇒ 「不出」；`game.bid` 且 `grab=false` ⇒ 「不抢」）；**非 0 ⇒ 不出气泡**（只出人话提示）。清除时机：`watch(() => store.currentVersion)` 变化时清空 —— **不引入任何本地计时器**。
- **被拒的就地提示**：沿用 `.table__notice.table__notice--error`（既有锚点），文案 = `actionErrorMessage(outcome.code)`；`status === 'blocked'` 仍是「上一个操作尚未确认，请稍候」（M06）。
  ⚠️ **红线**：前端**只把服务端给的 code 翻译成一句人话**，**不得**因为「这手牌我看不合法」而禁用/拦截任何按钮（`table-play-ui` 的「首出时过牌按钮不得禁用」就是这条的判别力来源）。

- [ ] **Step 1：先写失败测试**

`apps/client/test/action-feedback.test.ts`：

```ts
/**
 * ➎ 出牌区与动作反馈（spec §5-➎ + §9.1 红线 + R656）。
 *
 * 判据三组（**每组都写死「文案 ≠ 判定」这条红线**）：
 *  ① 错误码 → 人话：逐条对账 + `0` 不产生文案 + 未知码兜底带码；
 *  ② **纯查表**：模块只 import `ErrCode`、函数**只有 code 一个入参**、模块内不得出现
 *     `cards`/`hand`/`view`/`lastPlayedHand`/`isValid` 这类「拿着牌面做判断」的痕迹；
 *  ③ 交互面：被拒时出人话提示且**不出气泡**；ack 成功后出气泡、快照更新后气泡消失；
 *     **按钮的禁用只由 busy/轮次决定**（不得因牌面而禁用）。
 */
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { actionErrorMessage } from '../src/net/action-copy';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

describe('➎ 错误码 → 人话（只做文案，不做规则判定）', () => {
  it.each([
    [ErrCode.ILLEGAL_ACTION, '服务端判定这手牌不合法，换一手再试'],
    [ErrCode.INVALID_CARDS, '选中的牌无法组成合法牌型（服务端判定）'],
    [ErrCode.NOT_YOUR_TURN, '现在还没轮到你'],
    [ErrCode.VERSION_CONFLICT, '牌局已更新，正在为你同步'],
    [ErrCode.GAME_OVER, '本局已经结束'],
    [ErrCode.RATE_LIMITED, '操作太频繁，请稍后再试'],
    [ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试'],
    [ErrCode.ACTION_TIMEOUT, '这一步超时了，已由服务端处理'],
    [ErrCode.GAME_NOT_STARTED, '本局还没开始'],
  ])('码 %i → %s', (code, copy) => {
    expect(actionErrorMessage(code)).toBe(copy);
  });

  it('成功码 0 **不得**产生任何文案（成功不报错）', () => {
    expect(actionErrorMessage(ErrCode.OK)).toBe('');
  });

  it('未知码兜底必须带码', () => {
    expect(actionErrorMessage(424242)).toBe('操作未通过（code=424242）');
  });

  it('纯查表：只 import ErrCode、只有 code 一个入参、无牌面判定痕迹', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/net/action-copy.ts');
    expect(file, 'action-copy.ts 必须在源码扫描集合里').toBeDefined();
    const raw = file!.content;
    /** R572/R622：违规类断言读剥注释视图；存在性断言读原始文本。 */
    const code = stripComments(raw);
    const targets = [...raw.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(targets.sort()).toEqual(['@fight-the-landlord/protocol']);
    expect(code, '函数签名只允许有 code').toMatch(/export function actionErrorMessage\(\s*code:\s*number\s*\)\s*:\s*string/);
    expect(code, '不得出现拿着牌面做判断的痕迹').not.toMatch(/cards|hand|lastPlayed|isValid|canBeat|牌型\s*=/);
    // 正对照：合成样本必须被同一条判据报出
    expect('function actionErrorMessage(code: number, cards: number[]) { return isValidPlay(cards); }')
      .toMatch(/cards|isValid/);
  });
});
```

再补三条交互面用例（照 `table-play-ui` 的 `mountTable` 写法，用 `FakeSocket` 的 `emitted` + `ack` 回调造 ack）：

```ts
it('被拒（13001）⇒ 出人话提示、**不出气泡**', async () => {
  const { wrapper, socket } = mountTable({ mySeat: 0 });
  socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
  await wrapper.vm.$nextTick();

  await wrapper.find('.table__pass').trigger('click');
  // FakeSocket.emit 记下了 ack 回调 ⇒ 手工回一个「服务端拒绝」
  socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.ILLEGAL_ACTION });
  await flushPromises();
  await wrapper.vm.$nextTick();

  expect(wrapper.find('.table__notice').text()).toBe(actionErrorMessage(ErrCode.ILLEGAL_ACTION));
  expect(wrapper.find('.table__bubble').exists(), '被拒不是「已发生的事实」⇒ 不得出气泡').toBe(false);
});

it('过牌被服务端确认（ack code=0）⇒ 出「不出」气泡；下一版快照到达后消失', async () => {
  const { wrapper, socket } = mountTable({ mySeat: 0 });
  socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
  await wrapper.vm.$nextTick();

  await wrapper.find('.table__pass').trigger('click');
  socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.OK });
  await flushPromises();
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.table__bubble').text()).toBe('不出');

  socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 1, version: 3 }), 3));
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.table__bubble').exists(), '气泡不靠计时器，靠下一版快照清除').toBe(false);
});

it('按钮禁用只由 busy/轮次决定：首出（lastPlayedHand=null）时 `.table__pass` 仍可点（F01 不回退）', async () => {
  const { wrapper, socket } = mountTable({ mySeat: 0 });
  socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, lastPlayedHand: null, lastPlayerIdx: -1 }), 2));
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.table__pass').attributes('disabled')).toBeUndefined();
  await wrapper.find('.table__pass').trigger('click');
  expect(socket.emittedOf('game.pass')).toHaveLength(1);
});
```

- [ ] **Step 2：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test action-feedback`
Expected: FAIL —— `action-copy.ts` 不存在（import 解析失败）。

- [ ] **Step 3：实现 `action-copy.ts` + `PlayArea.vue`，接线 `table.vue`**

`table.vue` 的错误分支改成：
```ts
if (outcome.code !== ErrCode.OK) {
  localError.value = actionErrorMessage(outcome.code);   // 只翻译服务端给的码
  return;
}
```
（`ErrCode` 已可从 `@fight-the-landlord/protocol` import。）

- [ ] **Step 4：跑 client 全量测试确认 GREEN 且判据不减**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— 尤其 `table-play-ui` 的三条（首出过牌不禁用 / 载荷 / 倒计时基准）与 `error-disposition` 全绿。

- [ ] **Step 5：扩清单（+`PlayArea.vue`）→ 门禁（R653）→ commit**

```bash
git commit -m "feat(client): ➎ 出牌区（最近一手 + 归属指向）与动作反馈人话文案

- action-copy.ts：对局动作错误码 → 人话（只有 code 一个入参，纯查表）
- PlayArea.vue：最近一手 + 归属座位（R656：契约只有 lastPlayedHand/lastPlayerIdx）
- 气泡只在 ack code=0 后出现（本地回声），快照更新即消失，零计时器
- 红线：前端不因牌面禁用任何按钮，只翻译服务端给的码

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：➏ 叫抢阶段与底牌

**Files:**
- Create: `apps/client/src/components/BidPanel.vue`
- Create: `apps/client/src/components/BottomCards.vue`
- Create: `apps/client/test/table-bid-bottom.test.ts`
- Modify: `apps/client/src/pages/table/table.vue`（行动条叫抢分支用 `BidPanel`；中央区底牌行用 `BottomCards`）
- Modify: `apps/client/test/table-bid-ui.test.ts`（清单 +2：`BidPanel.vue` / `BottomCards.vue`）

**Interfaces:**
- `BidPanel.vue` props `{ disabled: boolean; multiplier: number | null }`；emits `grab` / `pass`；DOM：**`.table__bid-grab`（`<button>`，文案「抢」）** · **`.table__bid-pass`（`<button>`，文案「不抢」）** · `.table__bid-multiplier`（`当前倍数 {{ multiplier ?? '—' }}`）
- `BottomCards.vue` props `{ cards: readonly number[] | null }`；DOM：`.table__bottom` · `.table__bottom--hidden`（3 张牌背，`Card face-down`）· `.table__muted`（文案「叫抢阶段不可见」逐字保留）· 翻开时含 `.card[data-value]`
- Consumes: `store.isBidding` / `store.isMyTurn` / `store.busy` 语义保持在 `table.vue`（`BidPanel` 只收 `disabled`）· `store.view?.bidPhase?.bidMultiplier ?? null` · `store.bottomCards`

### 设计定稿

- 叫抢按钮的**禁用依据仍是 `busy || !store.isMyTurn`**（R107：`store.actorSeat` 在 bidding 期取 `bidPhase.currentBidder`）——**一个字都不改**，只是从 `table.vue` 内联挪进 `BidPanel` 的 props。
- **文案不随叫/抢变化**（R657）：保持「抢」/「不抢」（R647：探针按 class 点击、测试按 class 断言）。
- 「当前倍数」**原样**渲染 `bidPhase.bidMultiplier`（服务端数字）；缺字段渲染 `—`（R661）。
- 底牌位（spec §5-➏ 的「底牌翻开时机」）：`bottomCards === null` ⇒ `.table__bottom--hidden`（3 张牌背 + 「叫抢阶段不可见」），**一个 `data-value` 都没有**；非 null ⇒ `Hand` 渲染 3 张牌面（地主确定后翻开是服务端行为，前端只跟随）。

- [ ] **Step 1：先写失败测试**

`apps/client/test/table-bid-bottom.test.ts`：

```ts
/**
 * ➏ 叫抢面板与底牌位（spec §5-➏ + R657/R661 + R647）。
 *
 * 判据：
 *  ① 保锚：`.table__bid-grab` / `.table__bid-pass` 仍是 `<button>`，禁用只随 `isMyTurn` 变化；
 *  ② 阶段互斥不变（叫抢期无 `.table__play`/`.table__pass`，出牌期无抢/不抢）；
 *  ③ 底牌翻开时机：`bottomCards === null` ⇒ `.table__bottom--hidden` 内**零** `data-value`
 *     （牌背不得泄漏牌面）；非 null ⇒ 3 张牌面；
 *  ④ 当前倍数是服务端数字的**原样**展示（改名/改值都能被观测），且缺 `bidPhase` 时不崩。
 */
```
（用例至少：`it('`.table__bid-grab` 是 button 且文案逐字「抢」')` · `it('底牌 null ⇒ 3 张牌背且零 data-value（正反对照）')` · `it('底牌非 null ⇒ 3 张牌面')` · `it('当前倍数随视图更新（1 → 4）')` · `it('缺 bidPhase 的视图不抛错（R661：探针注入形态）')`）

- [ ] **Step 2：跑测试确认 RED → Step 3：实现两个组件 + 接线 `table.vue`**

- [ ] **Step 4：跑 client 全量测试确认 GREEN**（`table-bid-ui` 的 6 条 —— 禁用/可点/载荷/`baseVersion`/阶段互斥 —— 必须全绿，一条不改）

- [ ] **Step 5：扩清单（+`BidPanel.vue` / `BottomCards.vue`）→ 门禁（R653）→ commit**

```bash
git commit -m "feat(client): ➏ 叫抢面板与底牌位（翻开时机由服务端决定）

- BidPanel.vue：抢/不抢两个锚点按钮 + 当前倍数（原样展示，R657 不做叫/抢阶段推断）
- BottomCards.vue：叫抢期 3 张牌背 + 零 data-value（不泄漏牌面），翻开后显示牌面
- 禁用依据仍是 busy || !store.isMyTurn（R107 接线逐字保留）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：➐ HUD（倍数 / 炸弹数 / 房间码）

**Files:**
- Create: `apps/client/src/components/TableHud.vue`
- Create: `apps/client/test/table-hud.test.ts`
- Modify: `apps/client/src/pages/table/table.vue`（`.table__bar` 之下插 `.table__hud`）
- Modify: `apps/client/test/table-bid-ui.test.ts`（清单 +`TableHud.vue`，并断言**清单长度 = 8**）

**Interfaces:**
- `TableHud.vue` props：`{ multiplier: number | null; bombCount: number | null; roomCode: string | null }`；DOM：`.table__hud` · `.hud__item` · **`.hud__item--multiplier` / `.hud__item--bomb` / `.hud__item--room`**（每个数字一个稳定锚点，免得断言落在房间码上）· `.hud__label` · `.hud__value`（缺值渲染 `—`）
- Consumes（**全部来自 `PlayerView`，R654**）：`store.view?.bidPhase?.bidMultiplier ?? null` · `store.view?.playPhase?.bombCount ?? null` · `store.roomCode`

### 设计定稿（这一块的判据必须**写死**「展示 ≠ 计算」）

- 只渲染三个**原样数字**：`倍数`（`bidPhase.bidMultiplier`）· `炸弹`（`playPhase.bombCount`，**个数**，不是倍数）· `房间`（弱化的房间码）。
- **禁止**：`×N` 字样、`底分`、`baseScore`、`Math.pow(2, …)`、`multiplier * …`、把炸弹数换算成倍数、把 `bidMultiplier` 与炸弹数相乘 —— 任何一处都会立刻被 R659 的源码闸打红（**且该闸不剥注释**）。
- 顶栏 `.table__bar` **保留原样**（三态文字 + `返回大厅` `.btn`）：HUD 是它下面**新增**的一行；「顶栏收成状态条」通过**弱化字号/次级色**实现，不靠删元素。

- [ ] **Step 1：先写失败测试**

`apps/client/test/table-hud.test.ts`：

```ts
/**
 * ➐ HUD（spec §5-➐ + R654 + §9.1 红线）。
 *
 * ⚠️ 这一块最容易越线（「倍数展示 vs 倍数计算」）。判据写死三件事：
 *  ① **只展示服务端字段**：倍数随 `bidPhase.bidMultiplier` 变化、炸弹数随 `playPhase.bombCount` 变化；
 *  ② **前端零换算**：HUD 源码不得出现任何把炸弹数变成倍数、或对倍数做运算的写法（R659 的闸 + 本条正对照）；
 *  ③ **缺字段不崩**（R661：探针 `seedFinishedGame` 注入的 view 没有 `playPhase`）。
 */
```
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { collectSourceFiles } from './helpers/source-scan';

// …mountTable 脚手架同 ➌……

describe('➐ HUD：只展示服务端数字，前端零换算', () => {
  it('倍数随视图更新（服务端说几就是几）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', playerViewFixture({ state: 'bidding', seat: 0, version: 1, bidPhase: bidPhase({ bidMultiplier: 1 }) }), 1));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--multiplier').text()).toBe('倍数 1');

    socket.push(serverMessage('game.state_update', playerViewFixture({ state: 'bidding', seat: 0, version: 2, bidPhase: bidPhase({ bidMultiplier: 4 }) }), 2));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--multiplier').text()).toBe('倍数 4');
  });

  it('炸弹数是**个数**、原样展示（不做 2^n 换算）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, playPhase: { bombCount: 2 } }), 1));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--bomb').text()).toBe('炸弹 2');
    // 2^2 = 4 是**前端换算**的形态：倍数项仍是服务端给的 1，全 HUD 不得出现 4
    expect(wrapper.find('.table__hud').text()).not.toContain('4');
  });

  it('缺 playPhase/bidPhase 的视图渲染「—」且不抛错（R661：探针受控注入形态）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playerViewFixture({ state: 'ended', seat: 0, version: 3 }), 3));
    await wrapper.vm.$nextTick();

    // 抹掉两个阶段字段 —— 与探针 `seedFinishedGame` 注入的形状等价（它只给 bidPhase 的四个键、没有 playPhase）
    const view = store.view!;
    store.$patch({ view: { ...view, playPhase: undefined, bidPhase: undefined } as typeof view });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__hud').exists(), '缺字段也必须渲染出 HUD（不得整块消失）').toBe(true);
    expect(wrapper.find('.table__hud').text()).toContain('—');
  });

  it('源码级：HUD 无 ×N / 底分 / baseScore / 幂运算 / 倍数相乘（+ 正对照）', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/TableHud.vue');
    expect(file, 'TableHud.vue 必须在源码扫描集合里').toBeDefined();
    const traces = [/×\s*\d/, /底分/, /\bbaseScore\b/, /Math\.pow\s*\(\s*2/, /\b(?:bidMultiplier|multiplier)\s*[*/+%-]/];
    // R572/R622：违规类断言读剥注释视图（解释一个禁词的注释不该把闸打红）
    expect(traces.filter((re) => re.test(stripComments(file!.content)))).toEqual([]);
    // 正对照：合成样本必须被同一组正则报出
    expect(traces.filter((re) => re.test('{{ Math.pow(2, bombCount) * multiplier }} ×2 底分 baseScore'))).toHaveLength(5);
  });
});
```
⚠️ 第 3 条用例的落地形态：`mountTable` 返回的 `store` 上直接 `store.$patch({ view: { ...store.view!, playPhase: undefined, bidPhase: undefined } })`，断言 `.table__hud` 仍存在、文本含 `—`、且 `wrapper.vm` 无异常（`vue-test-utils` 会把渲染期异常抛出来）。

- [ ] **Step 2：跑测试确认 RED → Step 3：实现 `TableHud.vue` + 接线**

- [ ] **Step 4：跑 client 全量测试确认 GREEN**（特别确认 `table-ended-ui` 对 `.table__bar` 文字的三条断言仍绿）

- [ ] **Step 5：扩清单并**断言清单长度**（R659 收尾）**

```ts
it('R659：牌桌区组件清单正好 8 个（新增组件必须显式登记，否则闸会静默漏扫）', () => {
  expect(TABLE_AREA).toHaveLength(8);
  expect(TABLE_AREA).toContain('src/components/TableHud.vue');   // 本 Task 刚加的那个在清单里
  expect(TABLE_AREA).not.toContain('src/components/Settlement.vue'); // 显式排除（理由见 R659）
  // 清单（8）：table.vue · Seat.vue · Card.vue · Hand.vue · PlayArea.vue · BidPanel.vue · BottomCards.vue · TableHud.vue
});
```

- [ ] **Step 6：门禁（R653）→ commit**

```bash
git commit -m "feat(client): ➐ HUD 状态条（倍数/炸弹数/房间，全部原样展示）

- TableHud.vue：只渲染 PlayerView 里真的有的数字（R654：无 baseScore 字段）
- 红线：不做 2^炸弹 之类的换算，不出现 ×N/底分/baseScore（R659 闸 + 正对照）
- R661：缺 playPhase 的视图渲染「—」不崩（探针受控注入形态）
- R659：牌桌区扫描清单收尾 = 8 个组件

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：➑ 结算演出

**Files:**
- Modify: `apps/client/src/components/Settlement.vue`（重写观感，**保 9 个 class 与逐字文案**）
- Modify: `apps/client/src/stores/game.ts`（`rematchPending` + `requestRematch()` / `consumeRematch()`；`reset()` 清它）
- Modify: `apps/client/src/pages/table/table.vue`（`Settlement` 的 `@again` / `@back`）
- Modify: `apps/client/src/pages/lobby/lobby.vue`（`onMounted` 消费一次性重赛意向）
- Modify: `apps/client/test/table-settlement-ui.test.ts`（**只加**断言）
- Create: `apps/client/test/settlement-rematch.test.ts`

**Interfaces:**
- `Settlement.vue` props `{ settlement: SettlementResult }`（不变）；emits `again` / `back`
- DOM（**既有 9 个 class 与文案逐字保留**）：`.table__settlement` · `.settlement__winner`（`胜方：{{winner}}`）· `.settlement__spring` · `.settlement__multiplier` · `.settlement__base-score` · `.settlement__landlord-seat` · `.settlement__farmer-seats` · `.settlement__landlord-delta` · `.settlement__farmer-delta`；**新增**：`.settlement__headline`（「地主胜」/「农民胜」）· `.settlement__rows` / `.settlement__row`（每家一行：座位 + 角色 + 分数变化）· `.settlement__formula`（载荷构成明细）· `.settlement__actions` · `.settlement__again`（主）· `.settlement__lobby`（次）
- `stores/game.ts` 新增：state `rematchPending: boolean` · action `requestRematch()` · action `consumeRematch(): boolean`（读后即清，**幂等**）
- `lobby.vue`：`onMounted` 里 `if (store.consumeRematch()) void match();`

### 设计定稿

- **结算面板一个数都不算**（R188 的延续）：所有数字绑载荷字段；`spring` 只做枚举→中文（既有 `SPRING_LABEL`）。
- 新增内容：
  - `.settlement__headline`：`settlement.winner === 'landlord' ? '地主胜' : '农民胜'`（枚举→文案，不是胜负推导）；
  - `.settlement__rows`：三家各一行 —— 地主行用 `landlordScoreChange`、农民行用 `farmerScoreChange`（**两个值都直接来自载荷**）；
  - `.settlement__formula`：`底分 {{baseScore}} · 倍数 {{multiplier}} · 春天 {{SPRING_LABEL[spring]}}` —— **只列字段，不给乘积**（R658：不显示炸弹数，载荷里没有）；
  - `.settlement__actions`：`再来一局`（`.btn--primary`）emit `again`；`返回大厅`（`.btn`）emit `back`。
- **「再来一局」的语义**（R658）：`table.vue` 的 `onAgain()` = `store.requestRematch(); auth.navigate('lobby');`；大厅 `onMounted` 消费一次（`room.match` 仍**只有大厅一处实现**，不复制第二份）。
- 样式：复用 `$ftl-color-success-bg` / `$ftl-color-danger-bg` / `$ftl-color-accent` 等既有令牌，**零新增令牌**。

- [ ] **Step 1：先扩既有测试（只加断言）**

在 `apps/client/test/table-settlement-ui.test.ts` 里**新增**一条用例（既有 9 条断言**一字不动**）：

```ts
it('➑ 明细与三家分数行：数字**全部来自载荷**（用非乘积夹具证明不是前端自算）', async () => {
  // 夹具刻意给「乘不出来」的组合：底分 100 × 倍数 4 = 400，而地主变动是 777
  const w = mountSettlement({ ...defaultSettlement(), baseScore: 100, multiplier: 4, landlordScoreChange: 777, farmerScoreChange: -388.5 });
  expect(w.get('.settlement__headline').text()).toBe('地主胜');
  expect(w.get('.settlement__formula').text()).toContain('底分 100');
  expect(w.get('.settlement__formula').text()).toContain('倍数 4');
  const rows = w.findAll('.settlement__row');
  expect(rows).toHaveLength(3);                                     // 地主 1 + 农民 2
  expect(rows.map((r) => r.text()).join(' | ')).toContain('777');
  expect(rows.map((r) => r.text()).join(' | ')).toContain('-388.5');
  expect(w.text(), '不得出现「底分 × 倍数」的乘积（那是前端自算）').not.toContain('400');
  expect(w.find('.settlement__again').exists()).toBe(true);
  expect(w.find('.settlement__lobby').exists()).toBe(true);
});
```

- [ ] **Step 2：跑测试确认 RED**（`.settlement__headline` / `.settlement__row` / `.settlement__again` 不存在）

- [ ] **Step 3：先写跨页重赛测试**

`apps/client/test/settlement-rematch.test.ts`：

```ts
/**
 * ➑「再来一局」（R658）：牌桌只是**写下意向**并回大厅；`room.match` 仍只有大厅一处实现。
 */
import { describe, expect, it } from 'vitest';
// ① 单测：store.requestRematch() → rematchPending=true；consumeRematch() 读后即清（第二次返回 false）
// ② 单测：store.reset() 会清掉 rematchPending（换局边界不得把意向带过去）
// ③ 组件级：Settlement 的 `.settlement__again` 点击 ⇒ emit('again')；`.settlement__lobby` ⇒ emit('back')
// ④ 页面级：table.vue 收到 again ⇒ auth.page === 'lobby' 且 store.rematchPending === true
// ⑤ 源码级：lobby.vue 里 `send('room.match'` **仍恰好 1 处**（不得复制第二份实现）
```

- [ ] **Step 4：实现（Settlement 重写 → store 两个 action → table.vue 接线 → lobby.vue 3 行）**

- [ ] **Step 5：跑 client 全量测试确认 GREEN 且判据不减**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— `table-settlement-ui` 既有 9 条 + `table-ended-ui` 3 条全绿，新增全绿。

- [ ] **Step 6：门禁（R653）→ commit**

```bash
git commit -m "feat(client): ➑ 结算演出（胜负标题 + 三家分数行 + 载荷构成明细 + 再来一局）

- Settlement.vue：9 个稳定 class 与逐字文案**一字未动**，新增 headline/rows/formula/actions
- 明细只用载荷字段（R658：无炸弹字段 ⇒ 不显示炸弹数）；非乘积夹具证明不是前端自算
- 再来一局 = 回大厅 + 一次性意向，room.match 仍只有大厅一处实现
- stores/game.ts：rematchPending/requestRematch/consumeRematch（reset 会清）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收口（本计划执行完必须做完，缺一不可）

- [ ] **C1：`pnpm run ci` 六阶段全绿**（第 6 阶段 = §12.4 源码闸）。
- [ ] **C2：探针 `gate` 16/16 + `full` 20/20**（`full` 会真打完一局：叫抢 → 逐手出牌 → 结算 → 返回大厅 → 第二局；这是本片唯一能观测「终局 → 结算 → 再来一局边界」的窗口）。独占纪律：8 healthy + `DEL ratelimit:ws-conn:::ffff:172.19.0.1` + 清残留 vite（`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
- [ ] **C3：锚点与判据自证**：
  1. `grep -n "login__actions\|login__field\|lobby__match\|table__bar\|table__bid-grab\|table__pass\|table__play\|table__me\|table__notice" scripts/browser-e2e.mjs` ⇒ **9 个锚点一个不少、探针文件零改动**（`git diff --stat scripts/` 空）；
  2. 8 个既有契约测试的 `it(`/`it.each(` 计数**只增不减**（贴前后数字）；
  3. `TABLE_AREA` 清单 = 8 且每个文件都被读到（存在性断言）。
- [ ] **C4：台账读数**：`node scripts/ledger-counts.mjs` ✅；若执行期发现真缺陷 ⇒ **新增 N 条目**并在本计划回填。
- [ ] **C5：回填本计划文件**：「开工前裁决」表补执行期裁决（R664 起）· 新增「门禁实测」节（真实命令 + 真实输出）· 预期与实测不符处**保留原预期并写明偏差**。
- [ ] **C6：回填 `agent-briefs.md`**：交接现状加行 + 「下一步」行同步 + 新通用教训（没有就写「无」）。
- [ ] **C7：`docs/**` 单独 commit 收口**（带 Co-Authored-By）。

---

## 门禁实测（计划② 收口，2026-09-17，HEAD `5fed3ee`）

> 全部为**协调者本机实跑**的原文（日志 `/tmp/ui02-closeout.log`；跑前 8 容器 healthy、`DEL ratelimit:ws-conn:::ffff:172.19.0.1` = `0`、5173 空闲、无 vite 残留）。

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| ① 六阶段 CI | `pnpm run ci` | ✅ **六阶段全部通过**（`A_EXIT=0`）；阶段 6 的六条源码闸 = **23 / 8 / 5 / 6 / 3 / 21** |
| ② 单测 + lint | `pnpm exec turbo run test lint --force`（含在 CI 阶段 2/4） | ✅ 29/29、0 cached；client **401 passed + 2 skipped**（37 文件通过 + 2 跳过） |
| ③ 三端构建（R669 逐端） | `rm -rf dist/build/{mp-weixin,app}` → `turbo run build --force` → `build:mp-weixin` → `build:app` | ✅ `B1_EXIT=0`（10/10）· `B2_EXIT=0` · `B3_EXIT=0`；产物 `dist/build/` = **app · h5 · mp-weixin**（删目录后重新生成 ⇒ 新鲜） |
| ④ 真浏览器探针 | `pnpm run e2e:browser` | ✅ **判据 16/16**（`D_EXIT=0`） |
| ④′ 探针 full | `node scripts/browser-e2e.mjs --scenario full` | ✅ **判据 20/20**（`E_EXIT=0`；真打完一局 → 结算 → 返回大厅 → 第二局） |
| ⑤ 台账读数 | `node scripts/ledger-counts.mjs` | ✅ `99：97 已关闭 / 1 部分关闭 / 1 仍开放`，§0 与 §1.x 逐区一致（**本计划零台账条目变动**） |

**判据不减自证（C4）**

- `git diff --stat 6b4dde3 HEAD` = **33 文件、+5563/−194**，只出现 `apps/client/**` 与 `docs/**`（**`packages/**` 与 `scripts/**` 零改动**）。
- 8 个既有契约测试的字面 `it(`/`it.each(` 计数：**55 → 65**（全片两计划合计；本计划贡献 `table-bid-ui` 4→7 · `table-settlement-ui` 4→5 · `lobby-ux` 16→18，其余 5 个文件一字未动）。**只增不减**。
- 本计划新增测试文件（`it(` 数）：`table-seat-geometry` 5 · `card-hand-interaction` 8 · `action-feedback` 10 · `table-bid-bottom` 9 · `table-hud` 7 · `settlement-rematch` 5。
- 机械闸新增/加强：`TABLE_AREA` 扫描面 **1 → 8**（+ 长度断言）· **R675** 零本地计时器负面断言 · **单根闸**（`mount(组件).classes()`，覆盖牌桌区 8/8）· **F3** 组件自持按钮样式闸。

**偏差（按 C5 规矩：保留原预期 + 写明实测）**

1. **用例数**：brief 的「+5」等预估数与实测（+6/+8/+18 等）不符（R664/R670 同族，逐条已在裁决表登记）。
2. **正对照样本**：➐ 的 brief 样本实测 4/5 命中（R677）。
3. **➐ 的证据时效**：`/tmp/gate2.log` mtime 早于最后一轮改动 ⇒ 该轮「全绿」未必覆盖最终树；由 ➑ 当轮门禁 + 本收口全量门禁覆盖（R682）。

**commits（本计划）**

`76eed0d` ➌ · `813c958` ➍ · `ea561b3` ➍ 清理轮(R672) · `7d43db4` ➎ · `7d93bd8` ➏ · `ed5e31e` ➏ 修 R676 · `abb5c7b` ➐ · `aafbce0` ➐ 修 R679/R680 · `7c7fa4c` ➑ · `5fed3ee` ➑ 修 R684。

## 完成定义（DoD）

1. ➌➍➎➏➐➑ 六块按 spec §5 交付；三端产物齐全（`dist/build/{h5,mp-weixin,app}`）。
2. 6 个牌桌锚点语义不变（`.table__bar .btn` 文案仍逐字「返回大厅」）；`scripts/**` **零改动**。
3. 4 张牌桌测试 + `ui-flow` + four 机械闸**判据只增不减**；`LOCAL_SCORING_TRACES` 扫描面从 1 个文件扩到 8 个。
4. 新增判据：`table-seat-geometry`（4）· `card-hand-interaction`（6）· `action-feedback`（13+3）· `table-bid-bottom`（5）· `table-hud`（4）· `settlement-rematch`（5）+ `table-settlement-ui` 扩 1 条 —— **全部通过且各带正对照**。
5. `pnpm run ci` 六阶段全绿；探针 `gate` 16/16 与 `full` 20/20。
6. 计划文件与 `agent-briefs.md` 已回填（C5/C6）。
