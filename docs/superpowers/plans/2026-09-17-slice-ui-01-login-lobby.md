# 对局 UI 重设计 · ①「前两屏」实施计划（➊ 登录/注册 + ➋ 大厅含玩法选择）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `subagent-driven-development` 逐 Task 实施（每 Task 一个新实现者 agent + 任务评审 + 修复循环；**同一时刻只派一个实现者**）。步骤用 `- [ ]` 复选框跟踪。

**Goal：** 把「注册/登录 → 大厅」这两屏从「平铺表单 + 房间列表」重建为有信息层次与明确下一步的界面，并立起「先选玩法 → 再决定怎么开局」的结构。

**Architecture：** 只改 `apps/client/**`（`pages/login/login.vue` · `pages/lobby/lobby.vue` · 新增 `src/net/copy.ts` 文案查表）。**保锚优先**：既有 class 名与既有断言文案逐字保留，新结构只加不改；三端（H5 / mp-weixin / App）共用同一份源码。前端仍是**哑终端**——本片不引入任何规则判定、不新增服务端字段、不动 `packages/**`。

**Tech Stack：** uni-app（Vue 3 `<script setup>` + `view`/`text`/`button`/`input`）· Pinia · SCSS 令牌（`src/uni.scss`）· Vitest + `@vue/test-utils` · 真浏览器探针 `scripts/browser-e2e.mjs`。

**Spec（权威）：** `docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md` —— 本计划逐条实现它的 §1（硬边界）§5-➊➋ §6（总验收判据）§7（三条裁决）§9（风险）§10（锚点迁移清单）§11（拆两份）。执行者**必须**在读本计划前先整篇读 spec。

**配套计划（本片的第二份）：** `docs/superpowers/plans/2026-09-17-slice-ui-02-table.md`（➌➍➎➏➐➑ 牌桌）。两份计划**无代码耦合**，可先后独立验收；`table.vue` 的锚点由那份计划负责。

---

## Global Constraints（spec §1 + `docs/design.md` §12，逐字遵守；每个 Task 都隐含包含本节）

1. **§12 哑终端**：前端**不得**含任何规则判定（牌型识别、能否压过、倍数计算一律不在前端）。「这张牌能不能出」**只能**以服务端 ack 为准。
2. **样式只用令牌**：颜色/间距/圆角/字号一律取 `src/uni.scss` 的 `$ftl-*`；**禁止硬编码 hex / px**（`apps/client/test/ui-tokens.test.ts` 是闸，px 白名单只有发丝线 `border: 1px …` 与 `0px`；`vh/vw/em/rem/pt` 一律禁止）。
3. **三端一套**：`uni.xxx()` 必须写成**直接成员调用**（`apps/client/test/uni-api-access.test.ts` 是闸）；不得用 `document` / `window` / `fetch`；不得写 `typeof import.meta` / `import.meta.url`（`test/import-meta-guard.gate.test.ts` 是闸）；动效在小程序端**降级不崩**。
4. **锚点成对迁移**：真浏览器探针锚在 9 个 class 上（见 §「锚点与既有判据」）。**保留同名 class** 是默认；若某 Task 不得不改，必须在**同一次改动**里成对改 `scripts/browser-e2e.mjs` + 相应用例，**禁止**让闸静默失效（绿灯而没在验东西 = 白干一轮）。
5. **判据只增不减**：`table-bid-ui` / `table-play-ui` / `table-ended-ui` / `table-settlement-ui` / `ui-flow` / `lobby-ux` / `auth-flow` / `auth-ui-wiring` 与 four 机械闸（`ui-tokens` / `source-boundary` / `uni-api-access` / `import-meta-guard`）**一条断言都不许弱化或删除**。
6. **零新依赖**；**不引入新的 `wd-*` 组件**（`apps/client/test/setup/uni-easycom.ts` 的替身清单现为 6 个，新增用法必须同步清单，本片刻意不动它）。
7. **不得泄漏/不得伪造**：不新增任何展示字段；`packages/**` 只读（本片一个字都不改）。
8. **不实现第二个玩法**：玩法选择只做**结构**（roadmap §2.2 逐字：路径 A/B 待**第二个玩法开工前**决定）。
9. **提交纪律**：每个 commit 末尾带
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；
   **禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

---

## 开工前裁决（spec §7；用户 2026-09-17 已裁决 —— 不要重新探索/重新设计）

| # | 裁决 | 值 | 影响本计划的哪一步 |
|---|---|---|---|
| **R646** | §7 三条（用户原话「三条都按推荐」） | ①**简约纸牌风**：CSS + 令牌 + `view`/`text` 形状，照抄欢乐斗地主的**信息结构**、不照抄美术；②**只做斗地主入口**，但把「玩法选择区 + 玩法卡」做成**列表容器**；③「提示」（合法可出牌）**本批不做**，单独立片 | ➋ 的 `GAME_MODES` 单元素列表；➊➋ 全部样式走令牌 |
| **R647** | **保锚优先** | 既有 class 名与既有断言文案**逐字保留**；新增结构只**加** class。改锚必须同一次改动成对改探针/用例 | ➊`.login__actions` / `.login__field input`；➋`.lobby__match` / `.lobby__item` / `.lobby__notice` |
| **R648** | 不引入新 `wd-*` | 只用已替身的 6 个（`wd-card`/`wd-cell`/`wd-cell-group`/`wd-divider`/`wd-loadmore`/`wd-tag`）+ 原生 `view`/`text`/`button`/`input` | ➊➋ 的模板 |
| **R649** | 登录页的**唯一主按钮**与探针的兼容口径 | `.login__actions` 内**仍然是两个可提交的按钮**：主按钮 `.btn--primary`（默认「登录」）+ 次按钮 `.btn`（默认「注册」）。分段控件（`.login__seg`）**只切换表单形态**（注册态多一个「确认密码」字段、主按钮文案变「注册」），**不得**把次按钮降级成「只切模式」——真浏览器探针逐字依赖 `clickByText('.login__actions .btn', '注册')` **直接提交注册** | Task 1 |
| **R650** | 字段级校验的射程 | 只做**非空**与**注册态两次密码一致**（后者是纯 UI 字段，从不发给服务端）。手机号/密码的**格式权威判定在服务端**，前端不重复（§12 精神：不造第二个真源） | Task 1 |
| **R651** | 错误码 → 人话的落点与优先级 | 新增 `src/net/copy.ts`（**纯查表**，只 import `ErrCode`）。优先级：**服务端 `message`（有则用）> 本地文案表 > 兜底 `「<动作>失败（code=N）」`**。`auth-flow` 现有的 `auth.error === '密码错误'`（服务端 message）必须继续成立 | Task 1 |
| **R652** | 玩法选择区的「进入」不得改变开局区可用性 | 玩法卡默认已选中；「进入」只写 `activeMode` + 更新提示文案。**不得**把开局区做成「选完玩法才出现」——那会让 `lobby-ux` / `auth-ui-wiring`（直接点 `.lobby__match button`）的 6 条既有路径全部失效 | Task 2 |
| **R653** | **门禁口径**（两份计划共用） | **每个 Task 收尾**：**三端构建**（R669：`turbo run build --force` 对 client **只出 h5** ⇒ 必须再逐端 `build:mp-weixin` / `build:app`，且跑前 `rm -rf apps/client/dist/build/{mp-weixin,app}` 以证明产物新鲜）+ `pnpm exec turbo run test lint --force`（29/29、0 cached）+ 本 Task 定向用例 + **真浏览器探针** `pnpm run e2e:browser`（gate 16/16，改了三屏 DOM 就必须跑，独占纪律见下）。**每份计划收口**：再补 `pnpm run ci`（六阶段全绿）+ 探针 16/16 与 full 20/20。<br>理由：`ci` 前五阶段与 `build`/`test` 重叠、第 6 阶段的 6 条源码闸里 4 条属 `packages/**`（本片零改动），逐 Task 跑一遍的信息量不抵成本；但**源码闸本身仍逐 Task 被 `turbo run test` 覆盖**（`source-boundary`/`ui-tokens`/`uni-api-access`/`import-meta-guard` 都是 client 包的 vitest 用例） | 每个 Task 的 Step「门禁」 |

### 裁决编号口径（两份计划共用一套编号，执行前先读这条）

- **R646 / R647 / R653 = 切片级共用裁决**（两份计划同义）：R646 = §7 三条按推荐 · R647 = 保锚优先
  （既有 class 名与断言文案逐字保留，改锚必须同一次改动成对改探针/用例）· R653 = 门禁口径。
- **R648–R652 属本计划（前两屏）**；**R654–R663 属牌桌计划**（各自表内已列）。
- **执行期裁决从 R664 起，两份计划共用递增序列。**

### 执行期裁决（实施中产生，回填见「门禁实测」节）

| # | 触发事实 | 裁决 | 若判错的代价 |
|---|---|---|---|
| **R664** | 本计划两处**用例数笔误**（Task 1 Step 4 写「PASS（14 条）」实际 **13**；Step 9 写「304 + 新增 11 = 315」实际新增 **23** ⇒ **327**）。执行者逐字保留了 brief 的测试代码、未增删断言 | 以**实测为准**，就地订正计划文本（13 / 327），**不改测试** | 无（纯文档读数，订正已写入本文件） |
| **R666** | 计划 Task 1 的令牌口径自相矛盾：定稿说「选中态用主色文字」，Step 8 却写用 `$ftl-color-on-primary`（= 白字落在 `$ftl-color-primary-soft` 浅底上，不可见） | 以**实现为准**：选中态 = `$ftl-color-primary` 文字 + `$ftl-color-primary-soft` 底；订正计划文本 | 无（订正后与定稿一致；若判错则是低对比度的视觉瑕疵） |
| **R668** | 计划① Task 2 片段里的 `GAME_MODES` 块正则在计划文本里写成 `\];`，**匹配不到真实代码的 `] as const;`**（`lobby.vue:68`）—— 实现者用了更宽松的 `\]` 收尾才跑通；定向复审标为文档漂移（Minor，测试侧 fail-closed） | 以**实现为准**并订正计划文本为 `\](?:\s*as const)?\s*;`（R668） | 无（该正则只服务新测试；若判错，将来按计划片段重写会立刻红而不是静默） |
| **R667** | 新的源码级**违规类**断言（➋ 的 `/在线人数|onlineCount|playerOnline/`）读的是**原始文本**，与本仓既有裁决 **R572/R622** 相反 —— 实测已让实现者为了过闸把模板注释里的「在线人数」四字删掉（`source-boundary.test.ts:16-19` 逐字规定「违规类断言读剥注释视图；存在性断言读原始文本」） | **改读 `stripComments` 视图**（`test/helpers/source-scan.ts`），把被删的解释注释加回来，并把正对照改成真对照（真违规 + 解释它的注释 ⇒ 仍报错；纯注释样本 ⇒ 不报错）。**代码层的禁令一字不放宽**；既有 `lobby-ux.test.ts` 的两条 raw 判据属**遗留例外**，不动（受「判据只增不减」约束）。同一条口径已写进牌桌计划（R659 行） | 低：剥离视图是原始文本的**子集**，故不是漏报风险；若判错，等于新判据继续管注释洁净度，后人会再为「解释」付一次删注释的代价（P19 已付过一次） |
| **R665** | `login-screen.test.ts` 需要一次真实 WS 会话：`restartGameSession()` 在「会话尚未初始化」时**同步抛**（**产品既有行为**，非本任务引入），使 mock 掉 `signIn/signUp` 的用例产生 floating rejection ⇒ vitest 退出码 1（10 条判据仍全绿） | **接受测试脚手架偏离**：该文件 `beforeEach` 加 `startGameSession(() => new FakeSocket())`、`afterEach` 加 `stopGameSession()`（照 `auth-ui-wiring.test.ts` 既有模式）。**判据一条未改、产品代码一行未动**（不去吞那个真实异常） | 低：新测试文件多两行宿主装配；若判错，等于容忍「测试放宽产品行为」——但产品代码未改，风险与既有 `auth-ui-wiring` 同形 |

---

### 锚点与既有判据（spec §10，本片必须逐条落进 Task）

- 探针锚点（`scripts/browser-e2e.mjs`）：`.login__field input`（**≥2 个**，顺序 = 手机号、密码）· `.login__actions .btn`（按**文案**「注册」点击 ⇒ 必须提交注册）· `.lobby__match .btn`（按文案「随机匹配」点击）· `.table__bar .btn` / `.table__bid-grab` / `.table__pass` / `.table__play` / `.table__me .card` / `.table__notice`（**后 6 个属牌桌计划**，本片不得破坏）。
- 行为契约测试（本片相关）：`lobby-ux`（`.lobby__item` 可点 · `.lobby__notice--error` · **源码级**：`lobby.vue` 里 `send('room.join'` **恰好 1 处**、且不得出现 `hasConnected` / `.connected`）· `auth-flow`（`auth.error` 文案）· `auth-ui-wiring`（`input[inputmode="tel"]` / `input[type="password"]` / `.login__actions .btn--primary` = 登录提交 / 房间列表文案 `playing · 2/3 · 底分 200` 逐字）。
- 基线读数（开工实测，2026-09-17）：`apps/client` = **304 passed + 2 skipped**（28 文件通过 + 2 跳过）；`turbo run test lint --force` = **29/29、0 cached**；8 个容器 healthy；5173 空闲。

---

## 文件结构（先定边界，再定 Task）

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/client/src/pages/login/login.vue` | 重写模板与样式（脚本保留既有调用链） | ➊ 登录/注册屏：品牌头 · 分段控件 · 字段（含注册态确认密码）· 唯一主按钮 · 直接提交的次按钮 · 密码可见性 · 加载态 · 字段级 + 表单级反馈 |
| `apps/client/src/net/copy.ts` | **新建** | R651：`authErrorMessage(code, label)` —— 错误码 → 面向玩家的**人话文案**（纯查表，零规则语义） |
| `apps/client/src/stores/auth.ts` | 改 2 处（`signIn`/`signUp` 的失败分支 + `handleAuthFailure`） | 把「服务端 message ?? `code=N`」换成「服务端 message ?? `copy.ts` 的人话 ?? 兜底含码」 |
| `apps/client/src/pages/lobby/lobby.vue` | 重排模板与样式（脚本加 `GAME_MODES` / `activeMode` / `enterMode`） | ➋ 大厅 = 玩法入口区（列表容器）+ 开局区（匹配 / 建房 / 房号入房 / 房间列表）+ 我的身份区 |
| `apps/client/test/auth-error-copy.test.ts` | **新建** | ➊ 的机械判据：码 → 文案逐条对账 + 兜底必须含码 + 模块是纯查表 |
| `apps/client/test/login-screen.test.ts` | **新建** | ➊ 的结构与交互判据（分段控件 / 唯一主按钮 / 确认密码 / 可见性 / 加载态 / 字段级校验）+ **源码级**「前端不判格式」 |
| `apps/client/test/lobby-modes.test.ts` | **新建** | ➋ 的判据：玩法选择容器存在且**只有一个**玩法 · 「进入」只改选中态 · 开局区四条路径不被遮挡 · **源码级**「没有第二个玩法的任何实现」 |

**不动的文件**：`src/uni.scss`（➊➋ 的新视觉全部能用既有 48 个令牌表达，**不需要新令牌**——这是本片与牌桌计划的区别，牌桌计划才扩令牌）· `src/pages.json` · `src/router.ts` · `test/setup/uni-easycom.ts` · 一切 `packages/**` · 一切 `scripts/**`。

---

## Task 1：➊ 注册/登录屏（错误码 → 人话 + 零困惑表单）

**Files:**
- Create: `apps/client/src/net/copy.ts`
- Create: `apps/client/test/auth-error-copy.test.ts`
- Create: `apps/client/test/login-screen.test.ts`
- Modify: `apps/client/src/stores/auth.ts`（`signIn` / `signUp` / `handleAuthFailure` 的失败文案）
- Modify: `apps/client/src/pages/login/login.vue`（模板 + 样式 + 分段/可见性/校验的脚本）

**Interfaces:**
- Produces:
  - `src/net/copy.ts` → `export function authErrorMessage(code: number, label: string): string`
  - `login.vue` 的 DOM 契约：`.login__seg`（分段控件，2 个 `.login__seg-item`）· `.login__field--phone` / `.login__field--password` / `.login__field--confirm`（**仅注册态**）· `.login__field-error`（字段级）· `.login__error`（表单级，保留）· `.login__actions` 内 `.btn--primary`（主提交）+ `.btn`（另一动作直接提交）· `.login__toggle-visibility`（密码可见性）· `.login__submit-again`（无）
- Consumes（既有，不得改签名）：`useAuthStore().signIn(phone, password)` / `.signUp(phone, password)` / `.error` · `restartGameSession()` · `usePageAlignment('login')` · `ErrCode`（`@fight-the-landlord/protocol`）

### 设计定稿（执行者按此写，不要自由发挥）

- 顶部：`.login__title`（「斗地主」）+ `.login__hint`（改为**说清流程**的一句话：「登录后进入大厅，在大厅选择玩法」）。
- `.login__seg` 分段控件：两个 `<button type="button" class="login__seg-item">`（「登录」/「注册」），点击写 `mode`。**选中态用 `.login__seg-item--active`**（背景 + 主色文字，令牌取色）。分段项**不是** `.btn`（避免与 `.login__actions .btn` 混淆）。
- 字段（顺序固定，探针按顺序取 `inputs[0]`=手机号、`inputs[1]`=密码）：
  1. `.login__field--phone`：`<text>手机号</text>` + `<input type="text" inputmode="tel" autocomplete="username" placeholder="13800000000">`
  2. `.login__field--password`：`<text>密码</text>` + `<input :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="••••••">` + `.login__toggle-visibility` 按钮（文案 `显示`/`隐藏`，`@click="showPassword = !showPassword"`）
  3. `.login__field--confirm`（`v-if="isRegister"`）：`<text>确认密码</text>` + `<input type="password" autocomplete="new-password" placeholder="再次输入密码">`
  - 字段级错误：`.login__field-error`（`v-if="fieldError"`），文案见 `validate()`。
- `.login__actions`：主按钮 `.btn.btn--primary`（文案 = `mode==='login' ? '登录' : '注册'`，`busy` 时 = `'登录中…' / '注册中…'`）→ 调 `submit()`；次按钮 `.btn`（文案 = 另一动作：登录态是「注册」）→ 调 `submitOther()`。**两个按钮都 `:disabled="busy"`**。
- 表单级反馈：`.login__error`（`v-if="auth.error"`，保留原 class 与原位置语义）渲染 `auth.error`。
- `.btn--ghost`「以开发身份进入（连 mock 用）」保留（`auth.enterAsDevUser()`）。
- `validate()`（R650，只这三条）：
  ```ts
  function validate(): string {
    if (!phone.value.trim()) return '请输入手机号';
    if (!password.value) return '请输入密码';
    if (isRegister.value && confirm.value !== password.value) return '两次输入的密码不一致';
    return '';
  }
  ```
- `submit()` = `fieldError = validate()`；有错则 `return`（**不**发请求）；否则 `busy` 包裹 `mode==='login' ? auth.signIn : auth.signUp`，成功后 `restartGameSession()`。
- `submitOther()` = 只校验**非空**（不涉及确认字段），`busy` 包裹另一动作，成功后 `restartGameSession()`。**它必须真的提交**（R649）。

- [ ] **Step 1：先写失败测试 —— 文案查表**

`apps/client/test/auth-error-copy.test.ts`：

```ts
/**
 * ➊ 的机械判据（spec §5-➊「错误码 → 人话映射有单测」+ R651）。
 *
 * 判别力：这里逐条对账「码 → 文案」，并钉住两件事：
 *  ① 兜底**必须带上码**（未知码不得静默吞掉，也不得编一句像是诊断的话）；
 *  ② 该模块是**纯查表**：只允许 import `ErrCode`（不得 import store / net / 任何规则面）。
 */
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { authErrorMessage } from '../src/net/copy';
import { collectSourceFiles } from './helpers/source-scan';

describe('➊ 登录/注册错误码 → 人话文案', () => {
  it.each([
    [ErrCode.PHONE_TAKEN, '这个手机号已经注册过了，直接登录吧'],
    [ErrCode.BAD_CREDENTIALS, '手机号或密码不正确'],
    [ErrCode.USER_BANNED, '该账号已被封禁'],
    [ErrCode.USER_NOT_FOUND, '该账号不存在，请先注册'],
    [ErrCode.BAD_PARAM, '请检查填写的内容'],
    [ErrCode.RATE_LIMITED, '操作太频繁，请稍后再试'],
    [ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试'],
    [ErrCode.UNAUTHENTICATED, '登录状态已失效，请重新登录'],
    [ErrCode.TOKEN_EXPIRED, '登录状态已失效，请重新登录'],
    [ErrCode.TOKEN_INVALID, '登录状态已失效，请重新登录'],
  ])('码 %i → %s', (code, copy) => {
    expect(authErrorMessage(code, '登录')).toBe(copy);
  });

  it('未知码兜底**必须带码**（不得静默吞掉）', () => {
    expect(authErrorMessage(99999, '登录')).toBe('登录失败（code=99999）');
    expect(authErrorMessage(99999, '注册')).toBe('注册失败（code=99999）');
  });

  it('文案里不得出现规则词汇（§12.1：前端零规则语义）', () => {
    const banned = ['牌型', '倍数', '底分', '炸弹', '顺子', '地主'];
    const offenders = banned.filter((w) => authErrorMessage(ErrCode.BAD_CREDENTIALS, '登录').includes(w));
    expect(offenders).toEqual([]);
  });

  it('纯查表：模块只 import protocol 的 ErrCode', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/net/copy.ts');
    expect(file, 'copy.ts 必须在源码扫描集合里').toBeDefined();
    const targets = [...file!.content.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(
      (m) => m[1]!,
    );
    expect(targets.sort()).toEqual(['@fight-the-landlord/protocol']);
    // 正对照：扫描器对合成样本确实能读出 import 目标
    const synthetic = `import { ErrCode } from '@fight-the-landlord/protocol';import { x } from '../stores/game';`;
    expect(
      [...synthetic.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!).sort(),
    ).toEqual(['../stores/game', '@fight-the-landlord/protocol']);
  });
});
```

- [ ] **Step 2：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test auth-error-copy`
Expected: FAIL —— `Failed to resolve import "../src/net/copy"`（文件还不存在）。

- [ ] **Step 3：实现 `src/net/copy.ts`**

```ts
/**
 * 面向玩家的**人话文案**（R651，spec §5-➊）。
 *
 * ⚠️ 这里只有「错误码 → 一句中文」的**查表**：
 *  - 不做规则判定（§12.1）、不猜原因、不区分严重程度（处置一律由 `net/errors.ts` 的
 *    `CLIENT_ACTION` 表决定，本模块只负责「怎么说给玩家听」）；
 *  - **服务端 `message` 优先**（§6.2：message 是人类可读说明，仅供展示）——调用方先看
 *    `res.message`，只有它为空时才落到本表（见 `stores/auth.ts`）。
 *
 * ⚠️ 未知码的兜底**必须把码带出来**（`「登录失败（code=N）」`）：
 * 编一句像是诊断的话会把「没登记的码」变成静默，排查时无从下手。
 */
import { ErrCode } from '@fight-the-landlord/protocol';

/** 登录/注册/会话失效场景的文案表。key 全部取自契约的 `ErrCode`（不得写裸数字）。 */
const AUTH_ERROR_COPY: Record<number, string> = {
  [ErrCode.PHONE_TAKEN]: '这个手机号已经注册过了，直接登录吧',
  [ErrCode.BAD_CREDENTIALS]: '手机号或密码不正确',
  [ErrCode.USER_BANNED]: '该账号已被封禁',
  [ErrCode.USER_NOT_FOUND]: '该账号不存在，请先注册',
  [ErrCode.BAD_PARAM]: '请检查填写的内容',
  [ErrCode.RATE_LIMITED]: '操作太频繁，请稍后再试',
  [ErrCode.UPSTREAM_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
  [ErrCode.UNAUTHENTICATED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_EXPIRED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_INVALID]: '登录状态已失效，请重新登录',
};

/**
 * 取一条给玩家看的失败文案。
 * @param code 服务端返回的错误码（未经本地判断）
 * @param label 动作名（「登录」/「注册」），只用于兜底文案
 */
export function authErrorMessage(code: number, label: string): string {
  return AUTH_ERROR_COPY[code] ?? `${label}失败（code=${code}）`;
}
```

- [ ] **Step 4：跑测试确认 GREEN**

Run: `pnpm --filter @fight-the-landlord/client test auth-error-copy`
Expected: PASS（**13 条** —— `it.each` 10 + 3；原文写的 14 是计划笔误，执行期订正）。

- [ ] **Step 5：接线 `stores/auth.ts`（3 处，逐字）**

1. 顶部加 `import { authErrorMessage } from '../net/copy';`（放在 `import { dispatchRestFailure } from '../net/errors';` 之后）。
2. `handleAuthFailure` 的 `toast` 分支改为：
   ```ts
   toast: (report) => {
     this.error = report.message ?? authErrorMessage(report.code, label);
   },
   ```
3. `signIn` / `signUp` 的 `catch` 分支**保持不变**（网络异常仍是 `Error.message`）——那是「宿主/传输」层的错，不是错误码。

- [ ] **Step 6：写登录屏的结构与交互测试**

`apps/client/test/login-screen.test.ts`（挂载方式照抄 `auth-ui-wiring.test.ts` 的 `mountLogin`，但**不要**复制它的 mock：本文件只驱动 `auth` store 的状态，不发 REST）：

```ts
/**
 * ➊ 登录/注册屏（spec §5-➊）。
 *
 * 判据三条：
 *  ① **保锚**：`.login__field input`（≥2、顺序 = 手机号/密码）与 `.login__actions .btn`
 *     （文案「注册」**直接提交注册**）继续成立 —— 真浏览器探针逐字依赖它们（R647/R649）；
 *  ② 新能力：分段控件切形态 · 注册态多一个确认字段 · 密码可见性 · 加载态 · 字段级校验；
 *  ③ **前沿红线**：前端**不判格式**（手机号/密码格式的权威判定在服务端，R650）—— 源码级钉住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginPage from '../src/pages/login/login.vue';
import { useAuthStore } from '../src/stores/auth';
import { collectSourceFiles } from './helpers/source-scan';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

function mountLogin() {
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, auth: useAuthStore() };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

describe('➊ 登录/注册屏', () => {
  it('默认登录态：两个输入框（手机号、密码），顺序与探针一致', () => {
    const { wrapper } = mountLogin();
    const inputs = wrapper.findAll('.login__field input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.attributes('inputmode')).toBe('tel');
    expect(inputs[1]!.attributes('type')).toBe('password');
    expect(wrapper.find('.login__field--confirm').exists()).toBe(false);
  });

  it('每屏只有一个主按钮；次按钮文案是另一个动作', () => {
    const { wrapper } = mountLogin();
    expect(wrapper.findAll('.login__actions .btn--primary')).toHaveLength(1);
    expect(wrapper.find('.login__actions .btn--primary').text()).toBe('登录');
    expect(wrapper.find('.login__actions .btn:not(.btn--primary)').text()).toBe('注册');
  });

  it('分段控件切到注册 ⇒ 主按钮变「注册」、出现确认密码字段', async () => {
    const { wrapper } = mountLogin();
    const segItems = wrapper.findAll('.login__seg-item');
    expect(segItems.map((b) => b.text())).toEqual(['登录', '注册']);
    await segItems[1]!.trigger('click');
    expect(wrapper.find('.login__actions .btn--primary').text()).toBe('注册');
    expect(wrapper.find('.login__field--confirm input[type="password"]').exists()).toBe(true);
    // 保锚：切到注册态后**仍然**是 3 个 `.login__field input`（前两个顺序不变）
    expect(wrapper.findAll('.login__field input')[0]!.attributes('inputmode')).toBe('tel');
  });

  it('R649：`.login__actions` 的「注册」按钮**直接提交注册**（不是只切模式）', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__actions .btn:not(.btn--primary)').trigger('click');
    expect(signUp).toHaveBeenCalledWith('13800000000', 'secret123');
  });

  it('密码可见性切换只改 input 的 type（默认必须是 password）', async () => {
    const { wrapper } = mountLogin();
    const toggle = wrapper.find('.login__toggle-visibility');
    expect(toggle.exists()).toBe(true);
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('password');
    await toggle.trigger('click');
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('text');
    await toggle.trigger('click');
    expect(wrapper.find('.login__field--password input').attributes('type')).toBe('password');
  });

  it('字段级校验：空手机号/空密码就地报错且**不发请求**', async () => {
    const { wrapper, auth } = mountLogin();
    const signIn = vi.spyOn(auth, 'signIn').mockResolvedValue(true);
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('.login__field-error').text()).toBe('请输入手机号');
    expect(signIn).not.toHaveBeenCalled();

    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('.login__field-error').text()).toBe('请输入密码');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('注册态两次密码不一致 ⇒ 就地报错且不发请求', async () => {
    const { wrapper, auth } = mountLogin();
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__field--confirm input').setValue('secret124');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('.login__field-error').text()).toBe('两次输入的密码不一致');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('提交中主按钮进入加载态且两个按钮都禁用（M06 的 UI 面）', async () => {
    const { wrapper, auth } = mountLogin();
    let release: (v: boolean) => void = () => {};
    vi.spyOn(auth, 'signIn').mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.login__actions .btn--primary').text()).toContain('登录中');
    expect(wrapper.find('.login__actions .btn--primary').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.login__actions .btn:not(.btn--primary)').attributes('disabled')).toBeDefined();
    release(true);
  });

  it('服务端文案优先展示在 `.login__error`（保锚）', async () => {
    const { wrapper, auth } = mountLogin();
    auth.error = '密码错误';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.login__error').text()).toContain('密码错误');
  });

  it('源码级红线：登录页**不自造格式判定**（R650）', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/pages/login/login.vue');
    expect(file, 'login.vue 必须在源码扫描集合里').toBeDefined();
    const code = file!.content;
    // 手机号格式（正则/长度）、密码强度这类判定一律不得出现在前端
    expect(code).not.toMatch(/\\d\{11\}/);
    expect(code).not.toMatch(/length\s*===?\s*11\b/);
    expect(code).not.toMatch(/正则|regex|test\(\s*\/\^?1/);
  });
});
```

- [ ] **Step 7：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test login-screen`
Expected: FAIL —— 找不到 `.login__seg-item` / `.login__toggle-visibility` / `.login__field-error`（模板还没改）。

- [ ] **Step 8：重写 `login.vue` 的模板 + 样式 + 分段/可见性/校验脚本**

脚本按「设计定稿」补 `mode` / `confirm` / `showPassword` / `fieldError` / `isRegister` / `primaryLabel` / `validate()` / `submit()` / `submitOther()`；**既有调用链逐字保留**（`restartGameSession()` 的位置、`usePageAlignment('login')`、`enterAsDevUser()`）。

样式继续走 `@include ftl-btn` 与既有令牌；`$ftl-color-surface-muted` 做分段控件底、**选中态用 `$ftl-color-primary` 文字 + `$ftl-color-primary-soft` 底**（⚠️ 原文写 `$ftl-color-on-primary` 是计划笔误：白字落在浅底上不可见，见执行期裁决 R666）、`$ftl-color-border-control` 做分段项边框；**零新增令牌**。

- [ ] **Step 9：跑 client 全量测试确认 GREEN 且判据不减**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— **`304 + 新增 23 = 327 passed` + 2 skipped**（原文写的「新增 11 ⇒ 315」是计划笔误，执行期实测订正：本任务新增 `auth-error-copy` 13 条 + `login-screen` 10 条）（`auth-ui-wiring` / `auth-flow` / `source-boundary` / `ui-tokens` / `uni-api-access` / `import-meta-guard` 全绿，一条不改）。

- [ ] **Step 10：门禁（R653）—— 三端 + 全套 turbo + 探针**

```bash
cd /home/howe/pokergame
# 三端产物（R669：turbo build 对 client **只出 h5** ⇒ 必须逐端构建；跑前删两个产物目录以证明「新鲜」）
rm -rf apps/client/dist/build/mp-weixin apps/client/dist/build/app
pnpm exec turbo run build --force                          # h5 + 全部后端包（期望 10/10）
pnpm --filter @fight-the-landlord/client build:mp-weixin   # 期望 DONE Build complete
pnpm --filter @fight-the-landlord/client build:app         # 期望 DONE Build complete
ls -1 apps/client/dist/build                               # 期望 app · h5 · mp-weixin
pnpm exec turbo run test lint --force        # 29/29、0 cached
# 探针独占纪律（跑前必做）：
docker compose ps                            # 8 个 healthy
docker compose exec -T redis redis-cli DEL 'ratelimit:ws-conn:::ffff:172.19.0.1'
ss -ltnp | grep 5173 ; pgrep -af vite        # 有残留就先 `kill -TERM -<pgid>`（**禁止** pkill -f vite）
pnpm run e2e:browser                         # gate 16/16
```

- [ ] **Step 11：commit**

```bash
git add apps/client/src/net/copy.ts apps/client/src/pages/login/login.vue apps/client/src/stores/auth.ts \
        apps/client/test/auth-error-copy.test.ts apps/client/test/login-screen.test.ts
git commit -m "feat(client): ➊ 登录/注册屏重排 + 错误码→人话文案查表

- src/net/copy.ts：纯查表 authErrorMessage(code,label)，未知码兜底带码（R651）
- stores/auth.ts：服务端 message 优先，其次本地文案表
- login.vue：分段控件/唯一主按钮/确认密码/密码可见性/加载态/字段级校验（R649/R650）
- 保锚：.login__field input（≥2，顺序不变）· .login__actions .btn「注册」直接提交
- 判据只增不减：auth-flow/auth-ui-wiring 逐字保留，新增 11 条

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：➋ 大厅（玩法入口区 + 开局区）

**Files:**
- Create: `apps/client/test/lobby-modes.test.ts`
- Modify: `apps/client/src/pages/lobby/lobby.vue`（模板重排 + `GAME_MODES` / `activeMode` / `enterMode`）

**Interfaces:**
- Produces（DOM 契约）：
  - `.lobby__modes`（玩法选择区容器）· `.lobby__mode-list`（**列表容器**，`v-for` 渲染）· `.lobby__mode`（玩法卡）· `.lobby__mode--active`（选中态）· `.lobby__mode-name` · `.lobby__mode-tagline` · `.lobby__mode-enter`（进入按钮）· `.lobby__hint`（选中态提示）
  - `.lobby__start`（开局区容器，**包住**既有的 `.lobby__match` / `.lobby__create` / `.lobby__error` / `.lobby__join` / `.lobby__rooms`）
- Consumes（既有，**签名与 class 一个都不改**）：`loadRooms()` / `match()` / `unmatch()` / `join(entered?)` / `createAndJoin()` / `onSignOut()` · `store.matching` · `notice` · `STATUS_TAG_TYPE` · `.lobby__item`（可点 → `join(room.code)`）

### 设计定稿（执行者按此写，不要自由发挥）

- **玩法入口区**（新，放在 `.lobby__header` 之后、`.lobby__notice` 之后）：
  ```ts
  /**
   * 玩法入口的**数据层**（spec §5-➋ + roadmap §2.2）。
   *
   * ⚠️ 现在**只有**斗地主一个条目，且**不得**为第二个玩法写任何实现/规则：
   * 「第二个玩法开工前才决定路径 A/B」是 roadmap §2.2 的逐字要求。
   * 结构上它是**列表容器**（`v-for`），加第二个玩法时只加数据、不改结构。
   */
  const GAME_MODES = [
    { id: 'doudizhu', name: '斗地主', tagline: '三人一局，比谁先出完手牌' },
  ] as const;
  const activeMode = ref<(typeof GAME_MODES)[number]['id']>(GAME_MODES[0].id);
  const modeHint = ref('');
  function enterMode(id: (typeof GAME_MODES)[number]['id']) {
    activeMode.value = id;
    const picked = GAME_MODES.find((m) => m.id === id);
    modeHint.value = picked ? `已选择「${picked.name}」，请选择开局方式` : '';
  }
  ```
- 模板骨架（**只加不改**；`…` 处逐字保留既有实现）：
  ```html
  <view class="lobby__modes">
    <text class="lobby__modes-title">选择玩法</text>
    <view class="lobby__mode-list">
      <view v-for="m in GAME_MODES" :key="m.id" class="lobby__mode"
            :class="{ 'lobby__mode--active': activeMode === m.id }">
        <view class="lobby__mode-text">
          <text class="lobby__mode-name">{{ m.name }}</text>
          <text class="lobby__mode-tagline">{{ m.tagline }}</text>
        </view>
        <button type="button" class="btn btn--small lobby__mode-enter" :disabled="busy"
                @click="enterMode(m.id)">进入</button>
      </view>
    </view>
    <text v-if="modeHint" class="lobby__hint">{{ modeHint }}</text>
  </view>
  <view class="lobby__start">
    <!-- 逐字保留： .lobby__match / .lobby__create / .lobby__error / .lobby__join / .lobby__rooms -->
  </view>
  ```
- 玩法卡**不显示在线人数**（`RoomInfo` 没有该字段，spec §5-➋ 逐字禁止造数据）。
- 开局区**默认可见可用**（R652）；「进入」只写 `activeMode` + `modeHint`。
- 新增样式用既有令牌：玩法卡底 `$ftl-color-surface-muted`、选中态边框 `$ftl-color-primary` + `$ftl-shadow-primary-ring`、说明文字 `$ftl-color-text-secondary` + `$ftl-font-sm`。

- [ ] **Step 1：先写失败测试**

`apps/client/test/lobby-modes.test.ts`（挂载脚手架照抄 `lobby-ux.test.ts` 的 `mountLobby` 形态：`rest.rooms()` 用 `vi.spyOn` 造房间，`startGameSession(() => new FakeSocket())`）：

```ts
/**
 * ➋ 大厅的玩法入口区（spec §5-➋ + R646/R652 + roadmap §2.2）。
 *
 * 判据四条：
 *  ① 结构上存在**玩法选择容器 + 玩法卡**，现在**只有一个**玩法；
 *  ② 「进入」只改变选中态与提示，**不**遮住开局区（保 6 条既有路径）；
 *  ③ 既有开局四路径仍在 `.lobby__start` 里可用（保锚：`.lobby__match .btn` / `.lobby__join` /
 *     `.lobby__item` / 创建房间按钮文案）；
 *  ④ **源码级**：没有第二个玩法的任何实现/规则常量，也没有「在线人数」这类凭空的字段。
 */
```
（用例体照 `lobby-ux` 的 `mountLobby` 写法逐条写：`it('只有一个玩法卡且名称是斗地主')` / `it('默认已选中斗地主，点「进入」后仍只有一个卡并出现提示')` / `it('开局区四条路径在玩法卡存在时依然可点')` / `it('源码级：GAME_MODES 只有一个条目且无第二玩法痕迹')` / `it('正对照：扫描器对合成的第二玩法样本确实报错')`。）

源码级判据的具体形态（钉住「不许现在做第二个玩法」）：
```ts
const file = collectSourceFiles().find((f) => f.path === 'src/pages/lobby/lobby.vue')!;
/** R572/R622：**违规类**断言读剥注释视图；**存在性/计数**断言读原始文本。 */
const code = stripComments(file.content);
/** 存在性/计数：把正则**限定在 `GAME_MODES` 字面量块**内，免得别处的 `id: 'x'` 让本条以错信息变红。 */
const modesBlock = /const GAME_MODES\s*=\s*\[([\s\S]*?)\](?:\s*as const)?\s*;/.exec(file.content)?.[1] ?? '';
const entries = [...modesBlock.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!);
expect(entries).toEqual(['doudizhu']);                        // 只有一个玩法
expect(code, '不得造后端没有的字段').not.toMatch(/在线人数|onlineCount|playerOnline/);
expect(code, '不得引入第二个玩法的标识').not.toMatch(/mahjong|majiang|麻将/);

// 正对照（R667：必须是**真对照**，不能是「样本里写了那个词」的同义反复）
const violating = `// 反例：不得造 RoomInfo 里没有的字段（如在线人数）\nconst onlineCount = rooms.length;`;
const explainOnly = `// 这里只解释：'在线人数' / onlineCount 必须来自后端，前端不得造`;
expect(stripComments(violating), '真违规 + 解释它的注释 ⇒ 剥注释后仍报错').toMatch(/在线人数|onlineCount|playerOnline/);
expect(stripComments(explainOnly), '纯注释样本 ⇒ 不报错').not.toMatch(/在线人数|onlineCount|playerOnline/);
```

- [ ] **Step 2：跑测试确认 RED**

Run: `pnpm --filter @fight-the-landlord/client test lobby-modes`
Expected: FAIL —— `.lobby__modes` 不存在、`id: '…'` 条目数 0。

- [ ] **Step 3：改 `lobby.vue`**（按「设计定稿」加数据 + 重排模板 + 补样式）

**两条源码红线必须在同一次改动里成立**（`lobby-ux` 会当场验）：
1. `lobby.vue` 里 `send('room.join'` **恰好 1 处**（新代码不得复制进房实现）；
2. `lobby.vue` 里不得出现 `hasConnected` / `.connected`（页面只读 `notice`）。

- [ ] **Step 4：跑 client 全量测试确认 GREEN**

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS —— `lobby-ux`（含 2 条源码级）· `auth-ui-wiring`（房间列表文案 `playing · 2/3 · 底分 200` 逐字）· `ui-flow`（`随机匹配` 文案）全绿，**一条断言未改**。

- [ ] **Step 5：门禁（R653）—— 三端 + turbo + 探针**

同 Task 1 Step 10 的四条命令（`build --force` / `test lint --force` / 探针前置清理 / `pnpm run e2e:browser`）。
Expected: 三端 DONE · 29/29、0 cached · 探针 **gate 16/16**（注册 → 大厅 → `.lobby__match .btn`「随机匹配」→ 牌桌 17 张）。

- [ ] **Step 6：commit**

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/lobby-modes.test.ts
git commit -m "feat(client): ➋ 大厅拆出玩法入口区 + 开局区（只做斗地主入口，结构留位）

- GAME_MODES 单元素列表容器（roadmap §2.2：第二个玩法开工前才决定路径 A/B）
- 「进入」只写选中态 + 提示，开局区默认可见可用（R652）
- 保锚：.lobby__match / .lobby__join / .lobby__item / 房间列表文案逐字保留
- 源码红线：room.join 仍只有 1 处、页面不读 .connected

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收口（本计划执行完必须做完，缺一不可）

- [ ] **C1：`pnpm run ci` 六阶段全绿**（第 6 阶段 = §12.4 源码闸，6/6/5/6/3/21 逐条 `Tests N passed ≥ 1`）。
- [ ] **C2：探针 gate 16/16**（独占纪律：8 healthy + DEL 限流键 + 清残留 vite），并**另跑一次 `--scenario full`（20/20）**——它真打完一局再开第二局，是本片唯一能观测「换局边界」的窗口。
- [ ] **C3：台账读数**：`node scripts/ledger-counts.mjs` ✅（本计划预期**零台账条目变动**；若执行期发现真缺陷，按既有规矩**新增 N 条目**并在本计划回填）。
- [ ] **C4：判据不减自证**：`git diff --stat` 只出现 `apps/client/**`；`grep -c "it(\|it.each(" <8 个既有契约测试>` 前后**只增不减**（贴实测数字）。
- [ ] **C5：回填本计划文件**：
  1. 「开工前裁决」表补**执行期裁决**（R654 起，逐条写「触发事实 → 裁决 → 证据」）；
  2. 新增「门禁实测」节：逐条贴**真实命令 + 真实输出**（三端 DONE、29/29、0 cached、探针 16/16 与 20/20、client 用例数、ci 六阶段）；
  3. 若某步的预期与实测不符，**保留原预期并写明偏差**（不要事后改口）。
- [ ] **C6：回填 `docs/superpowers/plans/agent-briefs.md`**：
  1. 「交接现状」表加一行（本片计划名 + commits + 门禁读数 + 关闭/新登记条目）；
  2. 「下一步」行同步（把本片标 ✅ 并指向牌桌计划）；
  3. 有新通用教训就写一条（没有就写「无」——**不要凑**）。
- [ ] **C7：commit 收口**（`docs/**` 单独一个 commit，末尾带 Co-Authored-By）。

---

## 门禁实测（计划① 收口，2026-09-17，HEAD `5354902`）

> 全部为**协调者本机实跑**的原文（日志 `/tmp/ui01-closeout.log`；跑前 8 容器 healthy、`DEL ratelimit:ws-conn:::ffff:172.19.0.1` = `0`、5173 空闲、无 vite 残留）。

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| ① 六阶段 CI | `pnpm run ci` | ✅ **六阶段全部通过**（`A_EXIT=0`）。阶段 6 的六条源码闸 = **23 / 8 / 5 / 6 / 3 / 21**（`Tests N passed`） |
| ② 三端构建 | `pnpm exec turbo run build --force` | ✅ `B_EXIT=0`；产物 `apps/client/dist/build/` = **app · h5 · mp-weixin** 三端齐。<br>⚠️ **证据强度订正（R669，执行期发现）**：client 的 `build` 脚本是 `vue-tsc --noEmit && uni build`，**只出 h5**；单跑 `turbo run build` 时 `mp-weixin`/`app` 目录可能是**旧产物**（当时未删目录 ⇒ 不能证明新鲜）。已在 ➌ 落地后按新口径**逐端重跑**：`rm -rf apps/client/dist/build/{mp-weixin,app}` + `build:mp-weixin`（`MP_EXIT=0`）+ `build:app`（`APP_EXIT=0`）⇒ 两个目录被**重新生成**，且 `mp-weixin/components/{Seat.wxml,Seat.wxss,Card.wxss}` 都在、`#1e4e8c`（牌背令牌）在 `Card.wxss` 命中 **3** 次 |
| ③ 单测 + lint | `pnpm exec turbo run test lint --force`（含在 CI 阶段 2/4） | ✅ 29/29、0 cached；client **337 passed + 2 skipped**（31 文件通过 + 2 跳过） |
| ④ 真浏览器探针 | `pnpm run e2e:browser` | ✅ **判据 16/16 通过**（`D_EXIT=0`） |
| ④′ 探针 full | `node scripts/browser-e2e.mjs --scenario full` | ✅ **判据 20/20 通过**（`E_EXIT=0`；真打完一局再开第二局） |
| ⑤ 台账读数 | `node scripts/ledger-counts.mjs` | ✅ `99：97 已关闭 / 1 部分关闭 / 1 仍开放`，§0 与 §1.x 逐区一致（**本计划零台账条目变动**） |

**判据不减自证（C4）**

- `git diff --stat 6b4dde3 HEAD` 只出现 `apps/client/**` 与 `docs/**`（**`packages/**` 与 `scripts/**` 零改动**）。
- 8 个既有契约测试的字面 `it(`/`it.each(` 计数：**55 → 59**（唯一增量是 `auth-flow` 6 → **10**，即 F1 的 4 条只增不改；其余 7 个文件一字未动）。
- 新增测试文件：`auth-error-copy.test.ts`（`it.each` 10 行 + 3 = 13 断言）· `login-screen.test.ts`（10）· `lobby-modes.test.ts`（6）。

**偏差（按 C5 规矩：保留原预期 + 写明实测）**

1. **CI 阶段 6 计数**：计划 C1 原写 `6/6/5/6/3/21`，实测 **`23/8/5/6/3/21`** —— 前两条是**更早切片**把 `source-boundary` / `ui-tokens` 的判据加多了（本片那两个文件不在 diff 内）。
2. **Task 1/Task 2 的用例数**：计划原文的 14 / 315 与实际 13 / 327 不符（R664），已就地订正。
3. **Task 2 的源码判据视图**：计划原文（抄自 `lobby-ux` 的 legacy 形态）让违规类断言读**原始文本**，执行期按 **R667** 改读 `stripComments` 视图 —— 这是**更严的同口径**落实（对代码的禁令不变），并撤销了「注释里不得出现禁词」这条副产品要求。

**commits（本计划）**

`7eba36b` ➊ 登录/注册屏 + 文案查表 · `b506147` F1（空 message 回落）· `6fe52de` ➋ 大厅玩法入口区 + 开局区 · `5354902` ➋ 源码判据改读剥注释视图（评审 F1）· docs：`fd77dc5`（R667 回填）等。

## 完成定义（DoD）

1. ➊➋ 两屏的模板/样式/交互按 spec §5 交付，且**三端**构建产物齐全（`dist/build/{h5,mp-weixin,app}`）。
2. 9 个探针锚点里**属于本片的 3 个**（`.login__field input` · `.login__actions .btn` · `.lobby__match .btn`）语义不变，另 6 个（牌桌）未被破坏。
3. `auth-flow` / `auth-ui-wiring` / `lobby-ux` / `ui-flow` / four 机械闸**判据只增不减**。
4. 新增判据：`auth-error-copy.test.ts`（**13**）+ `login-screen.test.ts`（10）+ `lobby-modes.test.ts`（5+）**全部通过**，且各带**正对照**。（13 为执行期实测；原文写 14 是笔误。）
5. `pnpm run ci` 六阶段全绿；探针 `gate` 16/16 与 `full` 20/20。
6. 计划文件与 `agent-briefs.md` 已回填（C5/C6）。
