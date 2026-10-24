# 片①「底座」实施计划（App 界面重做）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把视觉基座做出来 —— 9 张已授权素材入库、`ui/` 预算抬到 1.5 MiB、底纹从实景照片换成蓝紫渐变、`uni.scss` 新增金色阶与深蓝底阶。**现有页面立刻能看出变化。**

**Architecture:** 纯客户端改动（`apps/client`）。三件事彼此独立、各有一个能独立验收的交付物：素材入库（含预算与溯源）→ 换底纹（含迁移旧图）→ 令牌扩充。**不碰任何业务逻辑**，前端仍是哑终端。

**Tech Stack:** uni-app CLI（Vite）+ Vue 3 + TypeScript + SCSS；测试 = vitest（jsdom）；产物闸 = `scripts/verify-asset-paths.mjs`。

**规格**：`docs/superpowers/specs/2026-09-26-app-ui-rework-design.md`（§3.1 交付物 · §5 视觉基座 · §7 判据记账 · §8 铁律）

---

## Global Constraints

- 🔴 **前端是哑终端**（`docs/design.md` §12）：只依赖 `@fight-the-landlord/protocol`，**绝不** import `@fight-the-landlord/shared`；
  不含任何牌型/倍数/底分/叫抢规则。`apps/client/test/source-boundary.test.ts` **必须一直绿**。
  本片**不碰任何 .ts / 业务 .vue 逻辑** —— 只动素材、SCSS 令牌、一个 CSS 声明。
- **尺寸单位一律 `px`**（设计像素，R711）。**禁 `rpx`**；**禁 `em/rem/vw/vh/pt`**；`line-height` 用无单位数值。
- **描边一律走 `$ftl-hairline`（2px）** —— **全仓不得出现裸 `1px`**（R714：画布缩到 k≈0.52 时 1px 会渲染不出来）。
- **除 `src/uni.scss` 外不得有裸十六进制色值** —— 所有颜色必须走 `$ftl-*` 令牌。
- **`src/uni.scss` 里不得出现 `baseScore` / `multiplier` / `底分` / `倍数`**（M09 机械闸）。
- **素材规矩**（art brief §1）：只做「底/框/图标」，**一个字都不画**；文字区透明；交付 = 画布尺寸的 **2 倍**；
  放 `src/static/ui/`（**平目录，不得有子目录** —— `asset-budget.test.ts` 显式拒绝子目录）。
- **每次改动一个 commit**（CLAUDE.md，便于回滚）；**每次改动写或更新对应测试**。
- ⚠️ **本机没有 `flock` 与 `script(1)`** ⇒ 相关判据在本机**显式跳过**，**别把「本机绿」当成「全绿」**。
- ⚠️ **改 JSON/Markdown 的字符串替换要验**：本仓有前例 —— 替换提前闭合了 JSON 字符串，留下悬空文本 ⇒ `SyntaxError`。

## 范围外（**本片不做**）

| 项 | 为什么 |
|---|---|
| **七个装饰槽接素材** | 六个槽挂在牌桌组件上，片③ 会把它们整个重写 ⇒ 片① 接了也白接。货币图标槽进片② |
| **「每页可选底纹」机制** | 第二个需求（牌桌另一张底）到片③ 才出现（YAGNI） |
| **文字描边令牌** | 是排版手法不是颜色词汇；实现方式多端不同、**必须真浏览器实测**。第一次用它的地方是片② 登录页标题 |
| **改现有令牌的「值」** | 改值 = 全局换肤、同时改掉四个页面，而重做是**分页进行**的 |
| **`setting.png` 压缩 / 缩放** | 按显示尺寸缩放要**等片③ 知道它渲多大**，现在缩等于猜；149K 在 1.5 MiB 预算下只占 10% |
| 📌 **前置 spike（真机预览循环）** | **需用户在场的 HBuilderX 操作**，与片① 无依赖（片① 验收看 `dev:h5` + 真浏览器）。见规格 §3.0 |

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/client/src/static/ui/*.png` | **新增 9 张** | 已授权素材（源：`resources/UI/`，逐张白名单挑） |
| `apps/client/src/static/ui/new_BJ.png` | **删除** | 实景照片底纹退役（源图仍在 `resources/UI/`） |
| `apps/client/src/static/ASSETS.md` | 修改 | 素材溯源：9 张从「未采用」移到「已采用」+ §3 预算表 |
| `apps/client/test/asset-budget.test.ts` | 修改 | `ui` 预算 400 → 1536 KiB |
| `apps/client/src/components/LandscapeStage.vue` | 修改 | 全仓唯一一处底纹引用：`new_BJ.png` → `bg.png` |
| `apps/client/test/landscape-canvas.test.ts` | 修改 | R713 底纹唯一性判据跟着换文件名 |
| `apps/client/src/uni.scss` | 修改 | 新增金色阶 3 档 + 深蓝底阶 3 档 |
| `apps/client/test/ui-tokens.test.ts` | 修改 | 新增「两组色阶各 ≥3 档」判据 |

---

## Task 1: 素材入库 + 预算抬到 1.5 MiB + 溯源登记

**Files:**
- Create: `apps/client/src/static/ui/{bg.png, Common_BG4_2x.png, dou.png, jishianniudi.png, jujsidai.png, setting.png, close_btn.png, default.png, nongmin2.png}`（9 张，从 `resources/UI/` 拷）
- Modify: `apps/client/test/asset-budget.test.ts:28-33`
- Modify: `apps/client/src/static/ASSETS.md`（§1 来源与授权 · §3 覆盖范围与体积预算）

**Interfaces:**
- Consumes: 无（本片第一个任务）
- Produces: `apps/client/src/static/ui/bg.png` —— **Task 2 依赖它存在**

- [ ] **Step 1: 确认源文件齐全（9 张，逐个核体积）**

```bash
cd d:/Code/pokergame
for f in bg.png Common_BG4_2x.png dou.png jishianniudi.png jujsidai.png setting.png close_btn.png default.png nongmin2.png; do
  stat -c '%s  resources/UI/%n' "resources/UI/$f"
done
```

预期（逐字节，与规格 §5.1 表一致）：

```
336451  resources/UI/bg.png
242341  resources/UI/Common_BG4_2x.png
5325    resources/UI/dou.png
25270   resources/UI/jishianniudi.png
39485   resources/UI/jujsidai.png
149827  resources/UI/setting.png
3082    resources/UI/close_btn.png
14316   resources/UI/default.png
19717   resources/UI/nongmin2.png
```

⚠️ 任一数字对不上就**停下来核对**，不要照拷。

- [ ] **Step 2: 逐张拷进 `src/static/ui/`（**不递归拷目录**）**

```bash
cd d:/Code/pokergame/apps/client/src/static/ui
SRC=../../../../../resources/UI
for f in bg.png Common_BG4_2x.png dou.png jishianniudi.png jujsidai.png setting.png close_btn.png default.png nongmin2.png; do
  cp "$SRC/$f" "$f"
done
ls -la
```

**文件名保持与源**逐字一致**（不改名）** —— 理由：`ASSETS.md` 的溯源表要能逐行对上，且少一步改名。
⚠️ **绝对不要 `cp -r`**：`resources/UI/` 里每个 PNG 都带一个 `.meta` 边车文件（ASSETS.md §2 的教训，
`resources/` 里 225/385 个是引擎专有文件），递归拷会把它们一起搬进来。

- [ ] **Step 3: 跑预算闸 —— 确认它**真的红**（TDD 的红）**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- asset-budget
```

预期：**FAIL**，且失败信息形如
`ui/ 实测 1035 KiB: expected 1034.765625 to be less than or equal to 400`。

⚠️ **是 1035 不是 857**：这一刻 `new_BJ.png`（177.7 KiB）**还在**，它要 Task 2 才被删。
857 是**本片终态**的数字。
⚠️ **精确值是 `1034.765625`**（= 1059600 B / 1024）—— 原稿写的 `1034.81` 是错的
（Task 1 实施时实测到真值，已订正）。

⚠️ **必须看到这条真红**。看不到就说明素材没拷进去 —— 那一会儿的绿是假绿。

- [ ] **Step 4: 抬预算（改常量 + 改注释里的实测值）**

`apps/client/test/asset-budget.test.ts:28-33`，把 `ui` 那一行改成：

```ts
/** 每类预算（KiB）。来源见 `src/static/ASSETS.md` 的「覆盖范围与体积预算」段。 */
const BUDGET_KIB = {
  cards: 500, // 实测 437
  av: 100, // 实测 98
  // 片①（App 界面重做）：219 → 1536（用户裁决 D13 —— 用 `resources/UI/` 里那批
  // R688 已授权的图；原 400 KiB 预算是按「只有 CSS 兜底」定的，装不下真素材）。
  // 先例：`audio` 当年也是这么抬的（用户裁决 U4）。
  // 实测：Task 1 结束时 1035（`new_BJ.png` 还在）；Task 2 删掉它之后 **857**（本片终态）。
  ui: 1536, // 实测 857（终态）
  audio: 1536, // 实测 1456（用户裁决 U4：全保留 5 条 BGM ⇒ 800 → 1536）
} as const;
```

- [ ] **Step 5: 跑预算闸 —— 确认转绿**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- asset-budget
```

预期：**PASS**，**11 个用例全过**（体积 4 + 判别力自证 1 + 牌码集合 3 + 孤儿文件 1 + F10 边界 2）。

⚠️ **是 11，不是原稿写的「6」** —— 本仓的教训是「**预期输出是判据的一部分**」：
预期条数写少了，「少跑了几条」就看不出来（那正是本仓两次「判据恒绿」的形态）。
Task 1 执行时实测到真值，此处已订正。

- [ ] **Step 6: 更新 `ASSETS.md`**

**6a. §1「来源与授权」表** —— 在表格下方（`**字体不在授权范围内**` 那段**之前**）插入已采用说明：

```markdown
**片①（App 界面重做，2026-09-26）新增采用 9 张** —— 它们**本来就在 R688 的授权范围内**
（授权范围逐字含「UI」），此前因「MVP 界面用不到」未入库 ⇒ **不是新的授权**，只是启用：

| 文件 | 源 | 用途 |
|---|---|---|
| `bg.png` | `resources/UI/bg.png` | 底纹（片① 起取代 `new_BJ.png`） |
| `Common_BG4_2x.png` | 同名 | 牌桌底纹（片③ 用） |
| `dou.png` | 同名 | 货币图标（片② 起） |
| `jishianniudi.png` | 同名 | 倒计时钟（片③） |
| `jujsidai.png` | 同名 | 结算面板标题带（片③） |
| `setting.png` | 同名 | 设置按钮（片② 起） |
| `close_btn.png` | 同名 | 关闭按钮（片② 起） |
| `default.png` | 同名 | 头像兜底（片② 起） |
| `nongmin2.png` | 同名 | 农民角色（片③ 备选） |
```

**6b.** 同段末尾那行「**未采用的 UI 素材**（`UI/` 里别的玩法 / 商城 / 设置界面，共 16 个）」——
把已采用的 9 个从清单里**划掉**，并把计数 `16` 改成 `7`，剩余的 7 个保持逐字不变
（`kuaisu_choose.png` · `hlddz.00045.png` · `public_bg.jpg` · `huanledou.png` ·
`goods_BG2.png` · `buy_btn_06.png` · `quxiao_loding (2).png`）。
⚠️ 这 7 个**各有不用的理由**（规格 §5.1 有原始实测）：`public_bg.jpg` 太暖太暗、
`huanledou.png` 是**财神插画不是货币图标**、`kuaisu_choose.png` **画了字**（违反「素材不画字」）、
`hlddz.00045.png` 是草地插画。把理由补在清单后面。

**6c. §3「覆盖范围与体积预算」表** 的 `ui/` 行改成（**本任务结束时**的真实状态）：

```markdown
| `ui/` | 底纹 `new_BJ.png`（**Task 2 起停用**）+ `btn{1,2,3}.png` + `panel-{blue,orange}.png` + `logo.png` + 片① 新增 9 张 | 16 | **1035 KiB** | ≤ 1536 KiB（片① 由 400 抬升 · 用户裁决 D13） |
```

⚠️ **这里是 16 个文件 / 1035 KiB，不是 15 / 857** —— `new_BJ.png` 此刻还在，**Task 2 删掉它之后**
才轮到 15 / 857（那一次更新在 Task 2 里做）。**别提前写终态数字** —— 实测值必须在每个时点都属实。

⚠️ **改完必须解析一次** `assets.md` 无关，但**若改了任何 `.json` 必须 `node -e` 解析验证**（本仓前例：
字符串替换提前闭合了 JSON 字符串）。本步只改 Markdown，跑 Step 7 的闸即可。

- [ ] **Step 7: 跑全量客户端测试 + 全门禁**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm run ci
```

预期：都绿。⚠️ `pnpm run ci` 第 1 阶段是 `pnpm install --frozen-lockfile` —— 本片**不改依赖**，
lockfile 不该变。

- [ ] **Step 8: Commit**

```bash
cd d:/Code/pokergame
git add apps/client/src/static/ui apps/client/src/static/ASSETS.md apps/client/test/asset-budget.test.ts
git commit -m "feat(client): 片① 素材入库 9 张 + ui/ 预算 400→1536 KiB + 溯源登记"
```

---

## Task 2: 底纹 `new_BJ.png` → `bg.png`（含迁移旧图）

**Files:**
- Modify: `apps/client/test/landscape-canvas.test.ts:153-163`
- Modify: `apps/client/src/components/LandscapeStage.vue:119-125`
- Delete: `apps/client/src/static/ui/new_BJ.png`

**Interfaces:**
- Consumes: `apps/client/src/static/ui/bg.png`（**Task 1 Step 2 产出**）
- Produces: 无下游依赖（片③ 才引入「每页可选底纹」）

- [ ] **Step 1: 先改判据（TDD —— 让它红）**

`apps/client/test/landscape-canvas.test.ts:153-163`，把整个 `it` 块替换为：

```ts
  it('底纹只有一处（R713）：bg.png 在 src/** 只出现一次，且在 LandscapeStage.vue', () => {
    // ⚠️ **读剥注释视图**（R572/R622 的既有口径：违规类断言一律读这一视图）——
    //    否则「注释里**解释**这条判据」会把判据自己打红。
    // ⚠️ 扫描面 = source-scan 认得的那几种（.ts/.vue/.js/.json/.scss）—— **不含 .md / .png**，
    //    所以 ASSETS.md 里提到它**不算**命中。
    // ⚠️ 片①（App 界面重做）：文件名由 `new_BJ.png` 换成 `bg.png` —— 只改**文件名**，
    //    判据的**性质**（底纹全仓只有一处引用、两层底纹会因缩放比不同而错位）一个字没变。
    const hits = sources
      .filter((f) => /bg\.png/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hits, `底纹出现在：${hits.join(', ')}`).toEqual(['src/components/LandscapeStage.vue']);
  });
```

- [ ] **Step 2: 跑它 —— 确认真的红**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- landscape-canvas
```

预期：**FAIL**，失败信息 `底纹出现在：` 后面是**空的**（`[]` 不等于 `['src/components/LandscapeStage.vue']`）。
⇒ 这正是「代码还没换」的证据。

- [ ] **Step 3: 换底纹引用（一行）**

`apps/client/src/components/LandscapeStage.vue:119-125`，把 `.stage` 的底纹注释与声明改成：

```scss
  /* ⚠️ 全仓**唯一**一处底纹（判据：bg.png 在 src/** 只出现一次，R713）。
     片①（App 界面重做）前这里是 `new_BJ.png` —— 那是一张**实景照片**（夕阳/树/人物），
     与本项目的棋牌观感不搭（art brief §4 原话：「换它收益最大」）。
     换的只是**文件名**：底纹**只有一处**这条性质不变。 */
  background-color: $ftl-color-table-center;
  background-image: url('/static/ui/bg.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
```

⚠️ **`background-image` 必须在 `background-color` 之后、且这里没有 `background` 简写** ——
简写会把 `background-image` 重置成 `none`（本仓 `uni.scss` 的 `ftl-btn` 混入里记着这个坑）。
本处用的是长写 `background-color`，安全。

- [ ] **Step 4: 跑它 —— 确认转绿**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- landscape-canvas
```

预期：**PASS**。

- [ ] **Step 5: 删掉旧图（源图仍在，不丢）**

```bash
cd d:/Code/pokergame
# 先证明两者逐字节相同 —— 相同才敢删
cmp apps/client/src/static/ui/new_BJ.png resources/UI/new_BJ.png && echo "逐字节相同 ✅"
git rm apps/client/src/static/ui/new_BJ.png
```

⚠️ **为什么删而不是留**：它留在 `src/static/ui/` 里会被 `uniCopyPlugin` **打进 App 包**、
且计入 `ui/` 预算 —— 那是 178 KiB 的死重量。
**「一个字节不丢」成立**：源图 `resources/UI/new_BJ.png` 一直在（`.gitignore` 忽略 `resources/`，
它是只读素材源库），删的只是 `src/` 下那份拷贝。

**5b. 同步 `ASSETS.md` §3 那一行到**本任务之后**的真实状态**（Task 1 写的是删图**前**的 16 / 1035）：

```markdown
| `ui/` | 底纹 `bg.png` + `btn{1,2,3}.png` + `panel-{blue,orange}.png` + `logo.png` + 片① 新增 9 张 | 15 | **857 KiB** | ≤ 1536 KiB（片① 由 400 抬升 · 用户裁决 D13） |
```

⚠️ 顺带把 §1 那张新采用表里 `bg.png` 的用途列从「底纹（片① 起取代 `new_BJ.png`）」定稿为
「**底纹（片① 起）**」—— 此刻它已经真的取代了，不再是计划语态。

- [ ] **Step 6: 产物级验证（**这一步抓的是「文件名打错」**）**
```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client build:h5
node scripts/verify-asset-paths.mjs
```

预期：**全部通过**。⚠️ **判据是「URL 集合换了项」，不是「从无到有」** ——
原稿写「字面量腿从『暂无 /static/ URL』变成有」是**错的**：产物里本来就有 23 个完整 URL
（牌面基址等），`verify-asset-paths.mjs:107-111` 那条「暂无」文案只在**零命中**时才打印。
⇒ 真正要看的是：`/static/ui/new_BJ.png` **从集合里消失**、`/static/ui/bg.png` **出现**。

⚠️ **这条闸不可省**：jsdom **不加载图片**、也不跑构建 ⇒ 一个拼错的路径在单测里**永远是绿的**
（`verify-asset-paths.mjs` 的文件头逐字写着这条）。本步就是它的用武之地。

- [ ] **Step 7: 跑全量客户端测试 + 全门禁**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm run ci
```

预期：都绿。

- [ ] **Step 8: Commit**

```bash
cd d:/Code/pokergame
# ⚠️ 用 `-A` 而不是逐个列路径：`new_BJ.png` 已被 `git rm` 删掉，
#    直接 `git add <那个不存在的路径>` 在老版本 git 上会报 pathspec did not match。
# ⚠️ **必须含 `ASSETS.md`** —— Step 5b 改了它。原稿漏了这一项，Task 2 执行时实测发现
#    （漏了的话 §1/§3 的更新会留在工作区没提交，违反「每次改动一个 commit」）。
git add -A apps/client/src/components/LandscapeStage.vue apps/client/test/landscape-canvas.test.ts apps/client/src/static/ui apps/client/src/static/ASSETS.md
git commit -m "feat(client): 片① 底纹 new_BJ.png → bg.png；旧图移出 src/static"
```

---

## Task 3: `uni.scss` 新增金色阶 + 深蓝底阶

**Files:**
- Modify: `apps/client/test/ui-tokens.test.ts:146-175`（`① design token 单一真源` 那个 `describe` 内，**追加**一个 `it`）
- Modify: `apps/client/src/uni.scss`（在「颜色」段的 `$ftl-color-accent` 之后追加）

**Interfaces:**
- Consumes: 无
- Produces: 6 个新令牌 —— `$ftl-color-gold` / `-light` / `-deep`、`$ftl-color-night` / `-soft` / `-deep`。
  **片②③ 用它们重写页面**（本片只建词汇表，不改任何现有令牌的值）

- [ ] **Step 1: 先加判据（TDD —— 让它红）**

`apps/client/test/ui-tokens.test.ts`，在 `describe('① design token 单一真源（R442）', …)` 的
**最后一个 `it` 之后**追加：

```ts
  /**
   * 片①（App 界面重做）的视觉基座：**新增两组色阶**，供片②③ 重写页面时取用。
   *
   * ⚠️ 本片**只加不改**：现有令牌的**值**一个都没动 —— 改值等于全局换肤、会同时改掉四个页面，
   * 而重做是**分页进行**的（规格 §5.2）。
   * ⚠️ 断言的是「阶」而不是「某个具体色号」：色号会在真浏览器截图并排时迭代，
   * 但「有 3 档可挑」这条结构性质不该跟着漂。
   */
  it('片① 视觉基座：金色阶与深蓝底阶各 ≥3 档', () => {
    const code = stripScssComments(tokenFile!.content);
    // ⚠️ `[\w-]*` 而**不是** `\w*`：`-` **不是** `\w` —— 用 `\w*` 会**漏掉** `$ftl-color-gold-light:`
    //    （`gold` 后面紧跟 `-`，`\w*` 只能吃空串，紧接着要求 `:` 就失败）
    //    ⇒ 计数停在 1、这条断言**永远红**。这是 pre-flight 扫描抓出来的，不是执行期踩的。
    expect([...code.matchAll(/^\$ftl-color-gold[\w-]*:/gm)].length, '金色阶至少 3 档').toBeGreaterThanOrEqual(3);
    expect([...code.matchAll(/^\$ftl-color-night[\w-]*:/gm)].length, '深蓝底阶至少 3 档').toBeGreaterThanOrEqual(3);
  });
```

- [ ] **Step 2: 跑它 —— 确认真的红**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- ui-tokens
```

预期：**FAIL**，`金色阶至少 3 档: expected 0 to be greater than or equal to 3`。

- [ ] **Step 3: 加令牌**

`apps/client/src/uni.scss`，在**颜色段**的 `$ftl-color-accent: #ef6c00;` 那一行**之后**插入：

```scss
/// 金色阶（片① 视觉基座 / 参考图的主按钮与徽章色）。
///
/// ⚠️ **只加不改**：本片不动任何现有令牌的**值**。这些是给片②③ 重写页面时取的词汇表，
/// 当前没有任何组件引用它们（`ui-tokens.test.ts` 只断言「阶 ≥3 档」这个结构性质）。
/// ⚠️ **色号会在片① 验收（真浏览器截图并排）时迭代** —— 观感没有机械判据（规格 §7.3）。
$ftl-color-gold-light: #ffd766;
$ftl-color-gold: #ffb302;
$ftl-color-gold-deep: #e07b00;

/// 深蓝底阶（片① 视觉基座 / 参考图的背景与牌桌底色）。
$ftl-color-night-deep: #0b2545;
$ftl-color-night: #143a68;
$ftl-color-night-soft: #1d4f8c;
```

⚠️ **变量名里不得出现 `baseScore` / `multiplier` / `底分` / `倍数`** —— `ui-tokens.test.ts:174`
在**剥注释视图**上拦这四个词（注释里可以照常写中文，见该行注释）。

- [ ] **Step 4: 跑它 —— 确认转绿**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- ui-tokens
```

预期：**PASS**。

- [ ] **Step 5: 跑全量客户端测试 + 全门禁**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm run ci
```

预期：都绿。⚠️ 特别确认 `② 单位体系换 px（R711）` 那组里
「px 才是主体且 rpx 零命中」**仍然绿** —— 它有一条自证断言 `uni.scss 里的 px 字面量 ≥ 30`
（`ui-tokens.test.ts:224`）。本步**只加颜色令牌、不加 px 字面量**，那个计数只会涨不会跌。

- [ ] **Step 6: Commit**

```bash
cd d:/Code/pokergame
git add apps/client/src/uni.scss apps/client/test/ui-tokens.test.ts
git commit -m "feat(client): 片① 视觉基座 —— uni.scss 新增金色阶/深蓝底阶（只加不改）"
```

---

## Task 4: 片① 验收（**人眼 + 真机**，无代码产出）

**Files:** 无
**Interfaces:** Consumes 前三任务的全部产出 · Produces 片① 的验收结论（写进规格 §5.4 那个待验问题）

- [ ] **Step 1: 起 H5 开发服务**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client dev:h5
```

（端口见终端输出；本仓 H5 dev 走 Vite。）

- [ ] **Step 2: 截图看整体观感（**观感的唯一判据**）**

在真浏览器里逐页截图（登录 / 大厅 / 开始游戏 / 牌桌），看 `bg.png` 换上去之后**整体**对不对：
蓝紫渐变底 + 现在的白色卡片/按钮，观感上是否协调；底纹在**两侧翅膀**（画布 16:9 vs 视口更宽）
上是否自然。**结论写进规格 §5.4。**

- [ ] **Step 2b: 回答规格 §3.4 那个待验问题（**有界临时实验**）**

⚠️ **为什么必须做一次临时替换**：原稿写「片① 的验收回答 §3.4」是**错的** ——
片① 里牌桌用的还是**全局那一张** `bg.png`（「每页可选底纹」机制明文留给片③），
**你根本看不到 `Common_BG4_2x.png` 当牌桌底的样子**，就没法判断。⇒ 做一次一次性实验：

```bash
cd d:/Code/pokergame
# ① 临时把底纹换成那张木桌底板（只改文件名，别动别的）
sed -i "s#/static/ui/bg.png#/static/ui/Common_BG4_2x.png#" apps/client/src/components/LandscapeStage.vue
# ② 起服务、在浏览器里看【牌桌页】和【开始游戏页】，截图
pnpm --filter @fight-the-landlord/client dev:h5
# ③ 看完**必须还原**（这一步不能省）
git checkout -- apps/client/src/components/LandscapeStage.vue
git status --porcelain   # 预期：空（证明还原干净）
```

要回答的就一句：**牌桌底纹用不用它？** 三选一 ——
① 用它（观感可接受）② 改用纯色/渐变（`$ftl-color-night` 系）③ 另想办法。
**结论写进规格 §5.4**（把「待验」换成结论），**片③ 的「每页可选底纹」机制会照它做**。

⚠️ **这个实验不留任何代码** —— 步骤 ③ 的 `git status` 为空是它的验收条件。若你真想留着，
那属于片③ 的机制，不在本片。

- [ ] **Step 3: 令牌色号迭代（若需要）**

若截图出来金色/深蓝与参考图差得明显，**直接调 `uni.scss` 里那 6 个色号**再截图 ——
这是本任务唯一允许的代码改动，且**只改值不改名**（判据断言的是「阶 ≥3 档」，不是色号）。

- [ ] **Step 4: 真机跑一遍（**需 HBuilderX，见规格 §3.0 的 spike**）**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client build:app
```

产出的 `dist/build/app` 交给 HBuilderX 发行验证。⚠️ **HBuilderX 版本必须 ≥ 5.26**
（项目 `@dcloudio/*` = `3.0.0-alpha-5020620260914001`）—— 版本偏低时真机**白屏且无任何报错**。

验三件：**布局不炸**（安全区/横竖屏）· **素材加载**（App 产物里 `/static` 路径）· **底纹看得见**。

- [ ] **Step 5: 收口 Commit（若 Step 3 改过色号）**

```bash
cd d:/Code/pokergame
git add apps/client/src/uni.scss
git commit -m "fix(client): 片① 验收 —— 色号按真浏览器截图并排调优"
```

---

## Self-Review（写完计划后的自查）

**1. 规格覆盖**：规格 §3.1 片① 的五行交付物 → 预算（Task 1 Step 4）· 入库（Task 1 Step 2）·
溯源（Task 1 Step 6）· 底纹（Task 2）· 令牌（Task 3）；两个「不做」也在本计划的「范围外」表里逐条挡着。
§7.1 受影响面清单里片① 会碰的 4 条闸（`asset-budget` / `art-slots` / `ui-tokens` / `landscape-canvas`）
全部有落点 —— `art-slots` **本片不碰**（七个槽不动 ⇒ 它应保持绿，Task 1 Step 7 与 Task 2 Step 7 的全量测试会看出来）。

**2. 占位符扫描**：无 TBD / TODO / 「稍后补」。两处「待定」是**规格明文交给验收的**且给了三选一的判据（Task 4 Step 2、Step 3）。

**3. 类型一致性**：本片不引入任何 TS 类型。令牌名在三处出现且逐字一致 ——
`$ftl-color-gold{,-light,-deep}` 与 `$ftl-color-night{,-soft,-deep}`（Task 3 Step 1 的正则
`^\$ftl-color-gold[\w-]*:` / `^\$ftl-color-night[\w-]*:` 与 Step 3 的定义对得上）。

⚠️ **这里我第一版写错了，pre-flight 扫描时发现并改了**：原先用的是 `\w*`，而 `-` **不是** `\w`
⇒ 它**匹配不到** `$ftl-color-gold-light:` ⇒ 计数停在 1、**这条断言永远红**，执行者会卡住。
改成 `[\w-]*`。同族教训：**正则的字符类要照真实分隔符写**，别想当然。

**4. 与规格的一处已知偏差（已回写规格）**：规格原稿的「文字描边」「压缩 setting.png」
「new_BJ 留在库里」三处，在写完本计划时被订正（分别改为：推迟片② / 不压缩 / 移出 `src/static`）。
规格已同步，**不是计划偷偷偏离规格**。
