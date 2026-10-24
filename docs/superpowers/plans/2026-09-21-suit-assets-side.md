# 花色·素材/观感侧（第②份）实施计划

> ## ✅ 本计划已执行完毕（2026-09-21）
>
> **结果**：8 个 Task 全部收口。`pnpm run ci` **六阶段全绿** · client **462 passed + 2 skipped** ·
> `build:h5` / `build:app` 均 DONE · 产物路径闸 + 体积预算闸全绿。
>
> ✅ **真浏览器探针 16/16 通过**（用 `--cdp-port 18800` 绕开 Windows 保留端口区间 ——
> 这条本机**早有记录**，我一开始漏读了，见 F9 的订正）。
>
> ⚠️ **但观感仍然没有证据**：F9 的**判别力自证**证明，把一张素材图临时移走，探针**照样全绿**
> （它抓的是 `Runtime.consoleAPICalled`，盖不住资源 404）⇒「图真的被画出来了 / 九宫格圆角 /
> 动效观感 / 声音」**无机械判据**，需要人眼。**没有为它们造假判据**（spec §9.2-7）。
>
> ⚠️ **下面的 Step 复选框有意保持未勾选**：本计划是**按方法执行**的（多处有据的偏离），
> 真实记录在下面两处：
>
> | 想知道什么 | 去哪看 |
> |---|---|
> | 逐条执行期发现（**9 条**，含 3 条「计划本身的代码/规定不对」） | 本文件的「**执行期发现**」段 |
> | 每个决策的理由、改了什么、为什么 | `git log`（8 个实施提交，每个都有详细 message） |
> | 与 spec 的 12 条偏离 | 本文件的「**与 spec 的偏离记录**」段 |
>
> **上游**：第①份（协议侧）已合入 `master`（merge `d70977a`）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已经取得的 54 张真牌面 + 牌背 + 头像 + UI + 音效接进牌桌——牌面从 CSS 画的文字牌换成真卡图（含花色），并带来底纹/头像/控件贴图/音效/动效。

**Architecture:** 素材是**逐张白名单拷贝**（不递归拷目录）进 `apps/client/src/static/`，由 uni-app 的 `uniCopyPlugin`（`static/**/*`）在 build 时**原样复制**到产物根。牌面映射是一份**数据文件** `static/cards/manifest.json`（R702：改名换图只动数据、不碰代码）。`Card.vue` 用 `<image>` 渲染真牌面，文字渲染降级为**兜底分支**（R693）与 `aria-label`。

**Tech Stack:** TypeScript 5.7 · pnpm 9.15 workspaces + turbo · Vue 3 + uni-app（H5 + App）· vitest + jsdom · 系统 `ffmpeg`（转码脚本，**不进依赖**）

**Spec:** `docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md`（v4，627 行，已定稿）—— 本份对应 **R700 的第②份（素材/观感侧）**

**上游（已执行完毕，勿重读计划）：**
- 第①份计划：`docs/superpowers/plans/2026-09-20-suit-protocol-side.md`（8 Task，合入 `master` 的 merge commit `d70977a`）
- 第①份改动面清单：`docs/superpowers/plans/2026-09-20-suit-change-surface.md`（**全部方法论结论在这里**）

---

## 从第①份带过来的两条方法论（本片必须照用）

1. **「`tsc` 看不见」的逃逸口有三种**，不是一种：`as` 断言 / `any` 与宽类型 / **与运行期不符的类型标注**。
   三者 `tsc` **一律沉默**，且**会连带掩护下游一大片**（`slice-08:233` 的 `as number[]` 一个断言同时遮住了排序 `NaN` 与下游 `includes` 的引用相等）。
   ⇒ 本片对应的形态是 **`<image src>` 的路径**：写错了 `tsc` 不报、单测不报（jsdom 不加载图片），**只有真浏览器/真机看得见**。
2. **「对牌做引用相等」是第①份最高频的坑（5 次）**，`tsc` 完全沉默。
   ⇒ 本片对应：**不要在 `Card[]` 上用 `indexOf` / `includes` / `-`**。手牌指纹一律走 `` `${c.r}-${c.s}` ``（第①份已修好 `table.vue` 与 `Hand.vue`）。

---

## Global Constraints

以下约束适用于**每一个** task，不再逐条重复：

- **范围 = H5 + App**（R701）。小程序端排除在**一切设计/开发/测试**之外：不删代码、不做适配、不入任何门禁、不为它写用例。
- **锚点零改动**：9 个探针 class 一个不改、`scripts/browser-e2e.mjs` 不改；
  `.login__actions .btn` · `.login__field input` · `.lobby__match .btn` · `.table__bar .btn` · `.table__bid-grab` · `.table__pass` · `.table__play` · `.table__me .card` · `.table__notice`
- **判据只增不减**：8 个契约测试的字面 `it(`/`it.each(` 计数基线 **65**（只数 `it(` 是 63，65 含 2 条 `it.each(`）。
- **样式只用令牌**（`$ftl-*`）：改素材/尺寸**先加令牌再用**。`ui-tokens` 闸禁组件里的 hex/px；
  ⚠️ **图片路径不受令牌约束**（spec §9.2-2 明文），但**尺寸仍须令牌/rpx**。
- **`uni.xxx()` 必须是直接成员调用**（闸：`test/uni-api-access.test.ts`）；不得 `document`/`window`/`fetch`；不得 `typeof import.meta`（闸：`import-meta-guard.gate.test.ts`）。
- **scoped 样式只到子组件根节点**：把按钮/元素抽进子组件后**必须自持样式**（闸：`table-bid-bottom.test.ts:415-518`）。
- **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 返回 `[]`）。
- **牌桌区源码与注释里禁止 `×` 紧跟数字**；**不得逐字写注释定界符**（`comment-stripping` 的 C1 守卫会红）。
- **`mount()` 看不见样式**（jsdom 不注入 CSS、不加载图片）⇒ **观感类改动只能用产物 CSS / 真浏览器 / App 走查**，**不要造假判据**（spec §9.2-7）。
- **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须 `pnpm --filter @fight-the-landlord/client build:app` 单独跑；探针**独占**跑（8 容器 healthy + `DEL ratelimit:ws-conn:::ffff:172.19.0.1` + 清残留 vite；`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
- **证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
- **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 共享验证命令

```bash
# 客户端类型检查（含 .vue）
pnpm --filter @fight-the-landlord/client lint          # = vue-tsc --noEmit
# 客户端单测
pnpm --filter @fight-the-landlord/client test
# 客户端 H5 构建 / App 构建（两条都要跑，turbo build 只出 h5）
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
# 真浏览器探针（独占跑）
node scripts/browser-e2e.mjs --scenario gate
# 全仓收口
pnpm run ci
```

> ⚠️ **Windows 环境事实**：本机 `node_modules` 是 Windows 侧重装的；`pnpm lint` 找不到 `tsc` 说明装漏了，先 `pnpm install`。
> ⚠️ **本机 ffmpeg**：`/e/Tools/ffmpeg/bin/ffmpeg`（v8.1.2），已在 PATH 上。

---

## 用户裁决（2026-09-21，写计划前已确认）

| # | 问题 | 用户裁决 | 影响 |
|---|---|---|---|
| **U1** | 牌面几何 | **采纳真牌比例 0.769** | `$ftl-card-*` 全部改档；手牌算账重写（Task 3） |
| **U2** | 牌桌底纹 | **按 R704 用 `new_BJ.png`** | ⚠️ 执行者知悉：该图实为**日落山坡风景插画**（不是牌桌台面）。用户已看过该结论并选择照 R704 执行（Task 4） |
| **U3** | 本片范围 | **动效 + UI 贴图 + §6.5 两条全做** | Task 4/5/6/7 全部纳入。用户原话：「UI 贴图与现有品牌蓝冲突没关系，先做出来，后面再替换贴图就是」 |
| **U4** | 音效 | **能做的全做，可适当增加体积预算** | 5 条 BGM **全保留**（不走 spec §6.2.4 的退档）；预算 800KB → **1.5 MiB**（Task 6） |

### ⚠️ 本计划对 spec 数字的两处**实测订正**（执行者必须知悉）

| # | spec 写的 | 实测 | 处置 |
|---|---|---|---|
| **M1** | §6.2.4「`audio/` ≤ 800KB（转 mp3 后）」 | 源 ogg 本身只有 **65–72 kbps**（已高度压缩）⇒ 96k 转出来**反而涨到 1749KiB**；48k 也压不到 800KB（全 5 BGM = 1011KiB） | 用户裁决 U4 ⇒ 预算改 **1.5 MiB**，BGM 64k / SFX 96k mono = **1456 KiB**（≈ 源 1476 KiB，**与源同质**） |
| **M2** | §6.2.4「`ui/` ≤ 400KB」，R704 由来说「bg(328KB)+其余(219KB)=547KB 超预算」 | 该算法是「bg **与其余并存**」。若**替换** `new_BJ` 为 `bg`，ui/ = 369KiB ≤ 400KiB —— 替换并不超 | **不影响本片**（U2 选了 `new_BJ`）。仅记录，避免后人误以为 `bg.png` 因体积出局 |

> **M3（转码的真实理由，spec 未写）**：OGG/Vorbis **在 iOS WKWebView 上不能播**。所以 OGG→mp3 是**兼容性必需**，不是体积优化 —— 这解释了为什么预算紧张也要转。

---

## File Structure

**新增（`apps/client/src/static/`，逐张白名单拷贝，不递归拷目录）**

| 路径 | 内容 | 数量 | 实测量 |
|---|---|---|---|
| `static/cards/` | 54 张牌面 + `CardBack.png` + `manifest.json` | 55 + 1 | 437 KiB |
| `static/av/` | `Landlord.png` / `Farmer.png` | 2 | 98 KiB |
| `static/ui/` | `new_BJ.png` + `btn{1,2,3}.png` + `panel-{blue,orange}.png` + `logo.png` | 7 | 219 KiB |
| `static/audio/` | 转码产出的 `.mp3`（见 Task 6） | 20 | 1456 KiB |
| `static/ASSETS.md` | 溯源 / 许可 / 命名约定 / 覆盖范围（**契约**） | 1 | — |

**新增（源码 / 测试 / 脚本）**

| 文件 | 职责 |
|---|---|
| `apps/client/test/asset-budget.test.ts` | 体积预算闸 + `manifest.json` 覆盖性 + 无孤儿文件 + 文件名白名单（F10 边界的机械保障） |
| `apps/client/src/audio/index.ts` | 音效播放 + 开关/音量持久化 + **事件→cue 名的选择**（`cueForBid` / `cueForPass`）；`uni.createInnerAudioContext()` 直接成员调用 |
| `apps/client/src/audio/cues.ts` | cue 名 → 音频文件名的**纯数据**表（无规则判定） |
| `apps/client/src/composables/useTableSound.ts` | 把牌桌**视图变化**译成音效（**视图 diff，不是规则推断**）；只依赖 store，不重复放 cue 选择 |
| `apps/client/src/components/Panel.vue` | 9-slice 面板（自持样式） |
| `apps/client/src/styles/animations.scss` | §8 动效 keyframes + `prefers-reduced-motion` 降级（**被组件 `@use`**） |
| `scripts/gen-card-manifest.mjs` | 一次性生成 `manifest.json`（产物入库后即不再需要） |
| `scripts/transcode-audio.mjs` | ogg→mp3 转码（系统 `ffmpeg`，**不进依赖**，幂等可重跑） |

**修改（关键）**

| 文件 | 改什么 |
|---|---|
| `apps/client/src/components/Card.vue` | 新增 `suit` prop；`<image>` 真牌面 + 文本兜底分支；`aria-label` |
| `apps/client/src/components/Hand.vue` | 把 `.s` 传给 `Card` |
| `apps/client/src/components/Seat.vue` | 头像图；§6.5-1 字段权重 |
| `apps/client/src/pages/table/table.vue` | 手牌算账注释 + 重叠令牌；底纹；音效接线 |
| `apps/client/src/uni.scss` | 牌面令牌改档（U1）；新增重叠/牌面相关令牌 |
| `apps/client/test/helpers/uni-stub.ts` | 新增 `createInnerAudioContext` 替身（记录调用） |
| `.gitignore` | 过时注释订正（现写「83 文件 / 2.5MB」） |

---

## Task 1: 素材入库 + 静态路径解析 spike + 体积预算闸

**这是本片唯一「答案未知」的 task。** spec §6.2.3 明确要求把静态资源路径解析放在素材侧第一个 Task 的**前置步骤**（「uni-app 的静态资源路径解析是本片最容易白干一天的坑」）。

**Files:**
- Modify: `.gitignore`（订正过时注释）
- Create: `apps/client/src/static/{cards,av,ui,audio}/`（拷入 65 个文件）
- Create: `apps/client/src/static/cards/manifest.json`
- Create: `apps/client/src/static/ASSETS.md`
- Create: `scripts/gen-card-manifest.mjs`
- Create: `apps/client/test/asset-budget.test.ts`

**Interfaces:**
- Produces:
  - `static/cards/manifest.json`：`{ "0-3": "SpadeThree.png", …, "back": "CardBack.png" }`（55 项）
  - 静态 URL 形态：`/static/<类>/<文件>`（**由 Step 4 的 spike 实证后锁定**）
  - `apps/client/test/asset-budget.test.ts` 的预算常量（Task 4/5/6 复用）

---

- [ ] **Step 1: 订正 `.gitignore` 的过时注释**

`resources/` 已经在忽略表里（第 1 片落的），但注释是 v3 的旧数字。逐字替换：

```
# 素材源库（385 文件 / 17MB，多数是引擎专有文件）。
# 只把精选子集拷进 apps/client/src/static/ 入库（83 文件 / 2.5MB）。
# 纪律见 docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md §6.2.1（R703）
resources/
```

改为：

```
# 素材源库（385 文件 / 16.70 MB，其中 225 个是引擎专有/边车文件，可用媒体只有 160 个）。
# 只把精选子集拷进 apps/client/src/static/ 入库，逐张白名单挑、**不递归拷目录**。
# 规模与预算见 apps/client/src/static/ASSETS.md 与 test/asset-budget.test.ts。
# 纪律见 docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md §6.2.1（R703）
resources/
```

- [ ] **Step 2: 逐张白名单拷贝素材（**不递归拷目录**）**

⚠️ **照目录拷贝会搬进 225 个非媒体文件**（`.meta` 201 + `.prefab/.anim/.controller/.asset` 20 + `.xlsx/.txt/.jpg` 3 + `.ttf` 1），占全量 58%。**逐个白名单 `cp`**：

```bash
cd /d/Code/pokergame
mkdir -p apps/client/src/static/{cards,av,ui,audio}

# 牌面：55 个 PNG（54 面 + CardBack）
cp resources/Poker/*.png apps/client/src/static/cards/

# 头像：2 个
cp resources/Identity/Landlord.png resources/Identity/Farmer.png apps/client/src/static/av/

# UI：7 个（R704：底纹只用 new_BJ.png；R705：字体 ice.ttf 不采用）
cp resources/UI/new_BJ.png resources/UI/btn1.png resources/UI/btn2.png \
   resources/UI/btn3.png resources/UI/panel-blue.png resources/UI/panel-orange.png \
   resources/UI/logo.png apps/client/src/static/ui/

# audio/ 由 Task 6 的转码脚本产出，本 task 只建目录
```

**验证**（三条都要对；⚠️ 用**字节精确**的口径，不用 `du -sk` —— 后者按块向上取整，
64 个文件上会虚报几十 KiB，写进文档就成了一条假的「实测」）：

```bash
find apps/client/src/static -type f -name '*.png' | wc -l     # 期望 64
find apps/client/src/static/cards -name '*.png' | wc -l       # 期望 55
# 字节精确总量（期望 754 KiB 上下，与 ASSETS.md 的 437+98+219 对得上）
find apps/client/src/static -type f -name '*.png' -exec stat -c '%s' {} + \
  | awk '{s+=$1} END {printf "%.0f KiB\n", s/1024}'
```

- [ ] **Step 3: 生成 `manifest.json`（R702）**

创建 `scripts/gen-card-manifest.mjs`：

```js
/**
 * 一次性生成 `apps/client/src/static/cards/manifest.json`（R702）。
 *
 * ⚠️ **产物是数据、入库**；本脚本只是生成器，跑一次即可（生成器留下是为了
 * 「换了一批图」时能重跑，而不是每次构建都跑）。
 *
 * 键 = `{s}-{r}`（承 R696），值 = 文件名；外加一个保留键 `back`。
 * 键名 `back` 与 `{s}-{r}` 形状不冲突（`s` 是 0–4、`r` 是数字）⇒ 不会撞。
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';

/** 花色：与 protocol 的 `s` **逐位一致**（♠0 ♥1 ♣2 ♦3 王4）。 */
const SUIT = { Spade: 0, Heart: 1, Club: 2, Square: 3 };
/** 点数：DouZero 编码（R695，全系统唯一）。`One` = A = 14；`Two` = 2 = **17**（不是 15）。 */
const RANK = {
  Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9, Ten: 10,
  Jack: 11, Queen: 12, King: 13, One: 14, Two: 17,
};

const out = { back: 'CardBack.png' };
for (const file of readdirSync('resources/Poker').filter((f) => f.endsWith('.png'))) {
  if (file === 'CardBack.png') continue;
  if (file === 'BigJoker.png') { out['4-30'] = file; continue; }
  if (file === 'LittleJoker.png') { out['4-20'] = file; continue; }
  const m = /^([A-Z][a-z]+)([A-Z][a-z]+)\.png$/.exec(file);
  if (!m) throw new Error(`未知文件名：${file}`);
  const s = SUIT[m[1]];
  const r = RANK[m[2]];
  if (s === undefined || r === undefined) throw new Error(`未知花色/点数：${file}`);
  out[`${s}-${r}`] = file;
}

const sorted = Object.fromEntries(
  Object.keys(out)
    .sort((a, b) => (a === 'back' ? -1 : b === 'back' ? 1 : Number(a.split('-')[0]) - Number(b.split('-')[0]) || Number(a.split('-')[1]) - Number(b.split('-')[1])))
    .map((k) => [k, out[k]]),
);

mkdirSync('apps/client/src/static/cards', { recursive: true });
writeFileSync('apps/client/src/static/cards/manifest.json', `${JSON.stringify(sorted, null, 2)}\n`);
console.log('entries =', Object.keys(sorted).length);
```

跑：

```bash
node scripts/gen-card-manifest.mjs
```

Expected: `entries = 55`

- [ ] **Step 4: 🔴 前置 spike —— 静态路径解析（spec §6.2.3，先做再往下走）**

**机制已实测确认**（`@dcloudio/vite-plugin-uni/dist/plugins/copy.js:13`）：`uniCopyPlugin` 把
`UNI_INPUT_DIR`（= `apps/client/src`）下的 **`static/**/*`** 与 `uni_modules/*/static/**/*`
原样复制到产物根；Vite 的 `publicDir` 被 uni 显式设成不存在的 `__static__`（`config/index.js:31`）
⇒ **`static/` 完全不走 Vite 的 asset 管线**（不哈希、不内联、不做路径改写）。

⇒ 源码里必须写 **绝对路径 `/static/...`**（不是相对路径、不是 `import`）。**这条要实证**：

```bash
cd /d/Code/pokergame
# ① 发行 H5：文件真的被复制过去了
pnpm --filter @fight-the-landlord/client build:h5
ls -la apps/client/dist/build/h5/static/cards/SpadeOne.png
ls -la apps/client/dist/build/h5/static/ui/new_BJ.png
# ② 发行产物里的引用形态（应能看到 /static/cards/... 字面量，且**没有**被哈希改名）
grep -o "/static/cards/[A-Za-z]*\.png" apps/client/dist/build/h5/assets/*.js | head -3
# ③ App 构建：只要求 build 绿 + 产物里有该目录
pnpm --filter @fight-the-landlord/client build:app
find apps/client/dist/build/app -name 'SpadeOne.png' | head -3
```

Expected: ① 两个文件都存在且字节数与源一致；② grep 命中 `/static/cards/...`；③ `build:app` DONE 且找得到文件。

**若 ① 或 ② 不成立**：停下，把观察到的实际形态记进 `ASSETS.md`，并按观察结果调整 Task 2 的 `faceSrc` 写法 —— **不要**绕过这一步直接往下做。

- [ ] **Step 5: 写失败的测试 —— 体积预算闸**

创建 `apps/client/test/asset-budget.test.ts`：

```ts
/**
 * 素材侧的**机械闸**（spec §6.2.4 / R702 / R703）。
 *
 * 四条：
 *  ① 每类素材的体积 ≤ 预算；
 *  ② `manifest.json` 覆盖全部 54 个合法牌码 + 1 个牌背；
 *  ③ `static/cards/` 里**没有孤儿文件**（每个 PNG 都被 manifest 引用）；
 *  ④ manifest 的值只能是 `[A-Za-z]+.png` —— **这是 F10 的边界守卫**：
 *     它挡住「有人把中文牌面文字（'大王'/'小王'）塞进这份数据文件」，
 *     因为 `source-boundary` 的 `['"](?:大王|小王)['"]` 扫描面**包含 `src/**` 的 .json**
 *     （`source-scan.ts:27` 的 `SOURCE_EXTENSIONS` 含 `.json`）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const STATIC = join(APP_ROOT, 'src', 'static');

/** 每类预算（KiB）。来源见 `src/static/ASSETS.md` 的「体积预算」段。 */
const BUDGET_KIB = {
  cards: 500,   // 实测 437
  av: 100,      // 实测 98
  ui: 400,      // 实测 219
  audio: 1536,  // 实测 1456（用户裁决 U4：全保留 5 条 BGM ⇒ 800 → 1536）
} as const;

/** DouZero 编码的合法牌值（R695）：3–14 / 17(=2) / 20(小王) / 30(大王)。 */
const DOUZERO_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];

/**
 * 目录体积（KiB）。⚠️ 这四个目录都是**平的**（无子目录）—— 若哪天有人塞了子目录，
 * `statSync` 会拿到目录项自身的 size（一个远小于内容的假值）⇒ 判据静默变松。
 * 因此这里**显式拒绝**子目录，宁可红也不要一条「看起来在量、其实没量」的判据。
 */
function dirSizeKiB(dir: string): number {
  let bytes = 0;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) throw new Error(`${dir}/${e} 是子目录：本闸假定素材目录是平的，请改断言`);
    bytes += st.size;
  }
  return bytes / 1024;
}

const manifest = JSON.parse(readFileSync(join(STATIC, 'cards', 'manifest.json'), 'utf8')) as Record<string, string>;

describe('① 各类素材体积 ≤ 预算', () => {
  for (const [name, budget] of Object.entries(BUDGET_KIB)) {
    it(`${name}/ ≤ ${budget} KiB`, () => {
      // 排除 manifest.json 自身（它算在 cards/ 目录里但只有几百字节）
      const actual = dirSizeKiB(join(STATIC, name));
      expect(actual, `${name}/ 实测 ${actual.toFixed(0)} KiB`).toBeLessThanOrEqual(budget);
    });
  }

  it('判别力自证：预算表非空且量级正确（不是「空集合恒绿」）', () => {
    expect(Object.keys(BUDGET_KIB)).toHaveLength(4);
    // cards/ 至少有 400 KiB —— 若目录没拷进来这条当场红
    expect(dirSizeKiB(join(STATIC, 'cards'))).toBeGreaterThan(400);
  });
});

describe('② manifest 覆盖全部 54 个合法牌码 + 牌背', () => {
  it('每个 (s, r) 都有映射，且对应文件存在', () => {
    const expected: string[] = [];
    for (let s = 0; s <= 3; s++) for (const r of DOUZERO_RANKS) expected.push(`${s}-${r}`);
    expect(expected).toHaveLength(60);
    // 王的两个码只有 `s = 4`；其余花色不含 20/30 ⇒ 合法面数 = 4×13 + 2 = 54
    const faces = expected.filter((k) => {
      const r = Number(k.split('-')[1]);
      return r < 20 || k.startsWith('4-');
    });
    expect(faces).toHaveLength(54);
    const missing = faces.filter((k) => manifest[k] === undefined);
    expect(missing, `manifest 缺少：${missing.join(', ')}`).toEqual([]);
    for (const k of faces) {
      expect(() => statSync(join(STATIC, 'cards', manifest[k]!)), `文件不存在：${manifest[k]}`).not.toThrow();
    }
    expect(manifest['4-20'], '小王').toBeDefined();
    expect(manifest['4-30'], '大王').toBeDefined();
    expect(manifest.back, '牌背必须在 manifest 里').toBe('CardBack.png');
  });

  it('manifest 条目数恰好 55（54 面 + 1 背）—— 多一条少一条都说明映射漂了', () => {
    expect(Object.keys(manifest)).toHaveLength(55);
  });
});

describe('③ 没有孤儿文件', () => {
  it('static/cards/ 里每个 .png 都被 manifest 引用', () => {
    const referenced = new Set(Object.values(manifest));
    const orphans = readdirSync(join(STATIC, 'cards'))
      .filter((f) => f.endsWith('.png') && !referenced.has(f));
    expect(orphans, `未被引用的牌面文件：${orphans.join(', ')}`).toEqual([]);
  });
});

describe('④ F10 边界：manifest 的值只能是英文 PNG 文件名', () => {
  it('任何值都不得含中文 / 路径分隔符 / 非 .png 后缀', () => {
    const bad = Object.entries(manifest).filter(([, v]) => !/^[A-Za-z]+\.png$/.test(v));
    expect(bad, `非法值（会把这个文件变成「自制牌面映射」的入口）：${JSON.stringify(bad)}`).toEqual([]);
  });

  it('判别力正对照：中文值与子路径必须被判违规', () => {
    const offenders = (m: Record<string, string>) =>
      Object.entries(m).filter(([, v]) => !/^[A-Za-z]+\.png$/.test(v));
    expect(offenders({ '4-30': '大王.png' })).toHaveLength(1);
    expect(offenders({ '0-3': 'sub/SpadeThree.png' })).toHaveLength(1);
    expect(offenders({ '0-3': 'SpadeThree.jpg' })).toHaveLength(1);
    expect(offenders({ '0-3': 'SpadeThree.png' })).toHaveLength(0);
  });
});
```

- [ ] **Step 6: 跑测试确认失败，再确认通过**

```bash
cd /d/Code/pokergame
# 先造一个必然失败的中间态：临时改名 manifest，确认闸真的在读文件
mv apps/client/src/static/cards/manifest.json /tmp/keep-manifest.json
pnpm --filter @fight-the-landlord/client test -- asset-budget
# Expected: FAIL（ENOENT，读不到 manifest）
mv /tmp/keep-manifest.json apps/client/src/static/cards/manifest.json

pnpm --filter @fight-the-landlord/client test -- asset-budget
```

Expected: 全绿（8 条 it）。

- [ ] **Step 7: 写 `ASSETS.md`（契约文件）**

创建 `apps/client/src/static/ASSETS.md`，**逐项填实**（不是模板）：

```markdown
# 素材溯源与契约（`apps/client/src/static/`）

> 本文件是**素材侧的契约**。改动素材前先读这里。
> 规格：`docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md` §6（R688 / R702 / R703 / R704 / R705）

## 1. 来源与授权

| 项 | 值 |
|---|---|
| 来源项目 | `CardGame`（Unity 2022.3 + NGO） |
| 原始路径 | 仓库根 `resources/`（385 文件 / 16.70 MB） |
| 许可状态 | 该仓库**无 LICENSE/COPYING/NOTICE**，README 的「许可证」段正文只有 `*待定*` ⇒ 原始状态 = 保留所有权利 |
| 授权 | **用户 2026-09-18 声明已另行取得全套素材授权**（裁决 **R688**）⇒ 本仓可用 |
| 授权范围 | 牌面 / 牌背 / 头像 / UI / 音效。⚠️ **字体不在内**：`Fonts/ice.ttf` 上游是字魂（ZiHun）商业字体，name 表逐字含 `Commercial use requires purchase authorization` ⇒ **本轮不采用**（R705），用系统字体 |
| 未采用的 UI 素材 | `UI/` 里别的玩法/商城/设置界面共 16 个（含 `bg.png` 328KB、`kuaisu_choose.png` 625KB、`public_bg.jpg`）—— MVP 界面用不到 |

## 2. 版本库边界（R703）

| 路径 | 入库 | 理由 |
|---|---|---|
| `resources/`（385 文件 / 16.70 MB） | ❌ **不进** | 源素材库。已在 `.gitignore`。⚠️ 照目录拷贝会搬进 **225 个非媒体文件**（`.meta` 201 + 引擎专有 20 + 杂项 3 + `.ttf` 1）⇒ **逐张白名单挑，不递归拷目录** |
| `apps/client/src/static/` | ✅ **进** | 实际使用的子集（下表） |

## 3. 覆盖范围与体积预算

| 目录 | 内容 | 文件数 | 实测 | 预算 |
|---|---|---|---|---|
| `cards/` | 54 张牌面 + `CardBack.png` + `manifest.json` | 55 + 1 | 437 KiB | ≤ 500 KiB |
| `av/` | `Identity/{Landlord,Farmer}.png` | 2 | 98 KiB | ≤ 100 KiB |
| `ui/` | `new_BJ.png`（牌桌底纹，R704）+ `btn{1,2,3}.png` + `panel-{blue,orange}.png` + `logo.png` | 7 | 219 KiB | ≤ 400 KiB |
| `audio/` | 见 §5 | 20 | 1456 KiB | ≤ 1536 KiB（1.5 MiB） |

预算由 `apps/client/test/asset-budget.test.ts` 机械把关。

## 4. 命名约定（**契约**）

牌面文件名 = **`{Suit}{Rank}.png`**：

- `Suit` ∈ `Spade`(♠) `Heart`(♥) `Club`(♣) `Square`(♦)
- `Rank` ∈ `One`…`Ten` `Jack` `Queen` `King`
- ⚠️ **两个命名坑**（已渲染出图核实）：**`Square` = ♦**（不是方块字面）、**`One` = A**（角标字母就是 `A`）
- 王与牌背：`BigJoker.png` / `LittleJoker.png` / `CardBack.png`
- 尺寸：**54 张面全部 80×104 px**、`CardBack` **66×88 px**（逐张解析 IHDR，非抽样）
  ⇒ 面/背比例 0.769 vs 0.750 **不一致**，差 2.6%。本片**统一用一个牌框**（按面的比例），牌背 `mode="scaleToFill"` 承受这 2.6% 的纵向拉伸（肉眼不可辨）。

**换图的最省事路径**：沿用同名交付的新图 ⇒ **直接覆盖文件即可，`manifest.json` 都不用改**。
换名交付 ⇒ **只改 `manifest.json`**（R702：表放 `.json` 就是为了这个）。

### 静态资源的引用形态

`/static/<类>/<文件>`（绝对路径）。机制：uni 的 `uniCopyPlugin` 把 `src/static/**/*` **原样复制**到产物根
（`@dcloudio/vite-plugin-uni/dist/plugins/copy.js:13`），且 Vite 的 `publicDir` 被 uni 显式设成不存在的
`__static__`（`config/index.js:31`）⇒ `static/` **不走 Vite 的 asset 管线**（不哈希、不内联、不改写路径）。

**Task 1 Step 4 的 spike 实测结果**（执行时逐条填）：

| 检查 | 命令 | 结果 |
|---|---|---|
| H5 发行产物里文件存在 | `ls apps/client/dist/build/h5/static/cards/SpadeOne.png` | ☐ |
| H5 发行产物里引用是字面量 | `grep -o "/static/cards/[A-Za-z]*\.png" apps/client/dist/build/h5/assets/*.js` | ☐ |
| App 构建 DONE 且产物有该目录 | `find apps/client/dist/build/app -name 'SpadeOne.png'` | ☐ |

## 5. 音效（R698 + U4）

源：`resources/Sound/Fight/` 与 `resources/MusicEx/`，**ogg**。产物：`static/audio/*.mp3`。

**为什么必须转码**：OGG/Vorbis **在 iOS WKWebView 上不能播** ⇒ 转 mp3 是**兼容性必需**，不是体积优化。
工具：系统 `ffmpeg`（**不进依赖**），脚本 `scripts/transcode-audio.mjs`。

实测：源 ogg 本身只有 **65–72 kbps**（已高度压缩）⇒ mp3 在 96k 反而**涨到 1749 KiB**。
用户裁决 **U4**（全保留 5 条 BGM，预算放宽到 1.5 MiB）⇒ 采用 **BGM 64k mono / SFX 96k mono = 1456 KiB**。

| 事件 | 文件 | 备注 |
|---|---|---|
| 抢 | `Woman_Rob{seat+1}` | 按座位取变体（确定性） |
| 不抢 | `Woman_NoOrder` | 与参考实现 `notCallLandlord` 同源 |
| 叫 | `Woman_Order` | 存在；本片规则只有抢/不抢，保留作契约对称 |
| 过牌 | `Woman_buyao{seat+1}` | `Woman_buyao4` 随清单入库作储备（3 座位用 1–3） |
| 报单（剩 1 张） | `Woman_baojing1` | §6.5-2 |
| 报双（剩 2 张） | `Woman_baojing2` | §6.5-2 |
| 小王单张出牌 | `Woman_100` | §10 的**例外**：单张牌型判定现成，不必等裁决 |
| 大王单张出牌 | `Woman_200` | 同上 |
| 胜利 / 失败 | `MusicEx_Win` / `MusicEx_Lose` | `Sound/Fight/` 里 |
| BGM | `MusicEx_Welcome`（大厅）· `MusicEx_Normal`（牌桌） | 用户裁决 U4 保留全部 5 条，另 3 条（`Normal2` / `Exciting` / `openinganimation`）随清单入库 |

**明确不做**（素材里确实没有）：发牌、结算、春天、倒计时紧迫。
**存在但不用**：`Woman_jiabei`（加倍）· `Woman_bujiabei`（不加倍）· `Woman_Share` · `Sound/Chat/Chat_1–7`（本片无聊天）。
**不做牌型播报**：`Sound/Fight/` 的 64 个 `Woman_*` 里有 50 条是**出牌播报**，需要新的裁决（spec §7 / §10）。
⚠️ **例外已做**：`Woman_100` / `Woman_200`（大小王**单张**）—— 单张判定现成，**不在此列**（§10 明文「将来可先行」）。
```

- [ ] **Step 8: 提交**

```bash
cd /d/Code/pokergame
git add .gitignore apps/client/src/static scripts/gen-card-manifest.mjs apps/client/test/asset-budget.test.ts
git commit -m "$(cat <<'EOF'
feat(assets): 素材入库 + 静态路径 spike + 体积预算闸（R702/R703/R704）

Task 1/8（花色·素材/观感侧）：
- 逐张白名单拷入 64 张 PNG（cards 55 / av 2 / ui 7），**不递归拷目录**
  （照拷会搬进 225 个非媒体文件，占全量 58%）
- manifest.json：55 项 `{s}-{r}` → 文件名，**数据文件而非 .ts**（R702）
- asset-budget.test.ts：体积预算 + 覆盖性 + 无孤儿 + F10 边界（值只能是英文 PNG 名）
- ASSETS.md：溯源/许可/命名约定/体积预算/音效清单（契约）
- .gitignore 过时注释订正（83 文件 2.5MB → 实测口径）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 牌面渲染（`Card.vue` → `<image>`）+ 判据迁移

**Files:**
- Modify: `apps/client/src/components/Card.vue`
- Modify: `apps/client/src/components/Hand.vue`
- Modify: `apps/client/test/card-hand-interaction.test.ts`

**Interfaces:**
- Consumes: `static/cards/manifest.json`（Task 1）、`/static/...` 路径形态（Task 1 Step 4）
- Produces:
  - `Card` 的新 prop：`suit?: number`（默认 `4`）—— 与既有 `value: number`（点数，驱动 `data-value` / `aria-label`）**并存**
  - `Card` 根节点新增 `.card__face`（`<image>`）；文本层降级为**兜底分支**
  - `Hand.vue` 把 `cards[index].s` 传给 `Card`

### ⚠️ 本 task 的两个硬约束（先说清，否则会做错）

1. **`data-value` 必须原样保留** —— 全仓 **38 行 / 8 个文件**引用它，是探针与既有断言的重要锚点（spec §2.4 的订正）。它继续绑点数（`value`）。
2. **花色不能只靠 `value`** —— 真牌面图必须由 `(r, s)` 合成键去查 manifest。既有 `Card` 只有 `value`（点数）⇒ **必须新增 `suit` prop**。调用点只有 3 处，其中只有 `Hand.vue` 需要传（另两处是 `faceDown` 的牌背位，不渲染牌面）。

### 判据迁移的范围（spec §6.3）

⚠️ **spec 写的行号 `:124` / `:157` 是旧版（`ea561b3`）的行号，HEAD 已漂移**：

| spec 写的 | HEAD 实际 | 内容 |
|---|---|---|
| `card-hand-interaction.test.ts:124` | **`:126`** | 文本断言 group（`toDisplay` 结果） |
| `card-hand-interaction.test.ts:157` | **`:159`** | `.card--wide` 分类 |

**`.card--wide` 保留、测试不动**：它的理由（双字符面值排版）在**兜底分支**下依然成立，且 CSS 仍消费它。

---

- [ ] **Step 1: 先确认基线是绿的**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。**若这里就是红的，先停下来修基线。**

- [ ] **Step 2: 写失败的测试 —— 新判据（正反双路径）**

在 `apps/client/test/card-hand-interaction.test.ts` **新增**一个 describe（**先加、先红**）：

```ts
/**
 * R696：牌面走真卡图。**两条路径都要判**：
 *  - **有素材**：渲染 `<image>`，`src = /static/cards/<manifest[{s}-{r}]>`；
 *  - **素材缺失**（R693 兜底）：回落文本牌面 —— 用**未登记的 `suit`** 模拟。
 *
 * ⚠️ 这里**不判布局**：jsdom 不加载图片、不注入 CSS。图像「真的显示出来了」
 * 只能由真浏览器/App 走查证明（spec §9.2-7）——本判据只钉「src 算对了」。
 */
describe('➍ R696：真牌面图 + 兜底分支', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../src/static/cards/manifest.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;

  it('有素材：渲染 .card__face，src 由 (r, s) 合成键查出', () => {
    const wrapper = mount(Card, { props: { value: 3, suit: 0 } });   // ♠3
    expect(wrapper.find('.card__face').attributes('src')).toBe(`/static/cards/${manifest['0-3']}`);
    expect(wrapper.find('.card__corner').exists(), '有素材时不渲染文本层').toBe(false);
    wrapper.unmount();
  });

  it('花色不同 ⇒ 图不同（正对照：证明键真的用了 s，不是只用 r）', () => {
    const spade = mount(Card, { props: { value: 3, suit: 0 } });
    const heart = mount(Card, { props: { value: 3, suit: 1 } });
    expect(spade.find('.card__face').attributes('src')).not.toBe(heart.find('.card__face').attributes('src'));
    spade.unmount();
    heart.unmount();
  });

  it('两张王各自查到自己的图（4-20 / 4-30）', () => {
    const small = mount(Card, { props: { value: 20, suit: 4 } });
    const big = mount(Card, { props: { value: 30, suit: 4 } });
    expect(small.find('.card__face').attributes('src')).toBe(`/static/cards/${manifest['4-20']}`);
    expect(big.find('.card__face').attributes('src')).toBe(`/static/cards/${manifest['4-30']}`);
    small.unmount();
    big.unmount();
  });

  it('素材缺失 ⇒ 回落文本牌面（R693：兜底，不是第二套视觉）', () => {
    // `suit: 9` 是未登记的花色 ⇒ 查不到映射 ⇒ 走兜底分支
    const wrapper = mount(Card, { props: { value: 30, suit: 9 } });
    expect(wrapper.find('.card__face').exists()).toBe(false);
    expect(wrapper.find('.card__corner').text()).toBe('大王');
    expect(wrapper.find('.card__center').text()).toBe('大王');
    wrapper.unmount();
  });

  it('`aria-label` = toDisplay(r)：F10 的机械保障新落点', () => {
    for (const [value, expected] of [[3, '3'], [14, 'A'], [17, '2'], [20, '小王'], [30, '大王']] as const) {
      const wrapper = mount(Card, { props: { value, suit: 0 } });
      expect(wrapper.attributes('aria-label')).toBe(expected);
      wrapper.unmount();
    }
  });

  it('牌背：既无图也无文字（面朝下不渲染牌面）', () => {
    const wrapper = mount(Card, { props: { value: 0, faceDown: true } });
    expect(wrapper.find('.card__face').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });
});
```

顶部补两行 import：

```ts
import { readFileSync } from 'node:fs';
import Card from '../src/components/Card.vue';
```

（`Card` 若已 import 过，**不要重复引入**——先读文件确认。）

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction
```

Expected: 新增的 6 条 FAIL（`.card__face` 不存在 / `aria-label` 为 undefined）。

- [ ] **Step 4: 实现 —— `Card.vue`**

**`<script setup>` 段**：新增 import 与两个 computed。

```ts
import { computed } from 'vue';
import { toDisplay } from '@fight-the-landlord/protocol';
import manifest from '../static/cards/manifest.json';

/**
 * 牌面映射表（R702）：**数据文件**，键 `{s}-{r}`、值 = `static/cards/` 下的文件名。
 *
 * ⚠️ 这是**资源名 ↔ 展示图片**的映射，**不是**「点数 → 牌面文字」的自制映射 ——
 * 后者由 `protocol.toDisplay()` 唯一提供，`source-boundary` 有闸（spec §6.2 R702 明文）。
 * 本组件从这份表里只取**文件名**，一个字符都不渲染成文字。
 *
 * ⚠️ 这里用 **`import`** 而不是 `/static/cards/manifest.json` 的 URL —— 两者不是一回事：
 *  · `import` ⇒ Vite 把 JSON 当**模块**打进 JS 包（编译期就查得出键错、无运行期请求）；
 *  · `/static/...` ⇒ uni 的 `uniCopyPlugin` 把它**原样复制**到产物根，运行期由宿主去取。
 * 牌面**图片**必须走后者（图不能进 JS 包）；这张**表**走前者。
 * 副作用：产物里 `static/cards/manifest.json` 会同时存在一份（复制来的），约 1.5 KB，无害。
 *
 * `resolveJsonModule` 已在 `tsconfig.base.json` 打开（已核实），所以 JSON import 能通过 `vue-tsc`。
 */
const FACE_MANIFEST = manifest as Record<string, string>;
```

props 增加 `suit`：

```ts
const props = withDefaults(
  defineProps<{
    /** DouZero 点数编码（协议层编码；本组件只把它交给 toDisplay）。 */
    value: number;
    /**
     * R696 的花色：0♠ 1♥ 2♣ 3♦ 4王。**默认 4 = 王** —— 缺省时查不到映射 ⇒ 走文本兜底，
     * 不会静默画错一张牌面（对应既有调用点里 `faceDown` 的占位 `:value="0"`）。
     */
    suit?: number;
    selected?: boolean;
    disabled?: boolean;
    size?: 'normal' | 'small';
    faceDown?: boolean;
  }>(),
  { suit: 4, selected: false, disabled: false, size: 'normal', faceDown: false },
);
```

新增 computed（放在既有 `wide` 旁边）：

```ts
/**
 * 牌面图 URL。查不到映射（花色未登记 / 素材未入库）时返回空串 ⇒ 走文本兜底（R693）。
 *
 * ⚠️ 路径是**绝对路径** `/static/...`：`static/` 被 uni 的 `uniCopyPlugin` 原样复制到
 * 产物根、完全不走 Vite 的 asset 管线（不哈希、不内联）——见 `static/ASSETS.md`。
 */
const faceSrc = computed(() => {
  if (props.faceDown) return '';
  const file = FACE_MANIFEST[`${props.suit}-${props.value}`];
  return file ? `/static/cards/${file}` : '';
});
```

**`<template>` 段**：把原来那两行 `<text>` 换成三分支。

```html
    <!-- 牌面（R696）：优先真卡图；素材缺失时回落 `toDisplay` 的文本牌面（R693 兜底）。
         ⚠️ 两条路径互斥 —— 有素材就**不**渲染文本层（否则同一张牌有两份牌面来源）。 -->
    <image v-if="faceSrc" class="card__face" :src="faceSrc" mode="scaleToFill" />
    <template v-else-if="!faceDown">
      <text class="card__corner">{{ face }}</text>
      <text class="card__center">{{ face }}</text>
    </template>
```

根节点补 `aria-label`（放在 `:aria-pressed` 之后）：

```html
    :aria-label="faceDown ? undefined : face"
```

**`<style>` 段**：新增 `.card__face` 规则（**只用 rpx**）。

```scss
/**
 * 牌面图。铺满牌框（`mode="scaleToFill"`）——牌框的比例已经按源图 80×104 定档
 * （见 `$ftl-card-w` / `$ftl-card-h`），拉伸量可忽略。
 */
.card__face {
  width: 100%;
  height: 100%;
  border-radius: $ftl-radius-sm;
}
```

- [ ] **Step 5: 实现 —— `Hand.vue` 把花色传下去**

`<Card>` 调用点（`:69-77`）加一行 `:suit`：

```html
      <Card
        v-for="index in order"
        :key="`${cards[index]!.r}-${cards[index]!.s}-${index}`"
        :value="cards[index]!.r"
        :suit="cards[index]!.s"
        :size="size"
        :selected="selected.includes(index)"
        :disabled="!interactive"
        @toggle="emit('toggle', index)"
      />
```

同时把组件头注释里「本组件只读 `r`」那句改掉（**注释与代码必须一致**，否则又是一处静默过期）：

```ts
/** R696：牌是 `{r, s}`。本组件把 `r` 交给 `Card.value`、`s` 交给 `Card.suit`。 */
```

- [ ] **Step 6: 迁移既有的文本断言（spec §6.3 的「判据迁移」）**

`card-hand-interaction.test.ts` 里**仍按文本断言**的两处必须迁移。**先跑一遍看红在哪**：

```bash
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction
```

**① `:126` 那个 describe（「牌面 = toDisplay 的结果」）**：它断言的 `.card__corner` / `.card__center` 文本在**有素材时**不存在了。
**改法**：把该 it 里对文本的断言**替换为对 `aria-label` 的断言**（`aria-label` 是 `toDisplay` 的同一份结果），
并在**兜底路径**下另加一组文本断言（已经在 Step 2 的新 describe 里了）。
`.card--normal` / `.card--black` / `.card--red` / `data-value` 那几条**原样保留**。
⚠️ `mountCard` 夹具要补 `suit`（否则查到 `4-3` 缺键 ⇒ 走兜底 ⇒ 文本反而还在，测试会「碰巧绿」）：给夹具传一个**已登记**的花色，让被测路径是 `image` 那条。

**② `:271`**（`.card__center` 文本 = `['3','5','4','大王','2']`）：
**改法**：把这一行换成同序的 `aria-label` 断言：

```ts
    expect(plain.findAll('.card').map((c) => c.attributes('aria-label'))).toEqual(['3', '5', '4', '大王', '2']);
```

（它上一行的 `data-value` 断言 `[3,5,4,30,17]` **不动**。）

**③ 顺带确认 `.card--wide` 那条（`:159`）**：**应当仍然绿**（`.card--wide` 留在根节点上，由 `face` 计算）。
若它红了，说明 `wide` 的计算被改掉了 —— **不要删这条测试**，把 `wide` 改回去。

- [ ] **Step 7: 跑测试确认全绿**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿（既有 8 条契约测试的 `it(` 计数**只增不减**：新增 6 条）。

- [ ] **Step 8: 真浏览器走查（**这一步不能省** —— jsdom 看不见图）**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client preview &
node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server --scenario minimal
```

Expected: 探针全绿。**外加人工看**：起 dev server 走到牌桌，确认**手牌显示的是真牌面图**（不是文字、不是裂图）、
且**同点数的不同花色牌面不同**。把观察到的事实（不是「应该没问题」）记下。

- [ ] **Step 9: 提交**

```bash
cd /d/Code/pokergame
git add apps/client/src/components/Card.vue apps/client/src/components/Hand.vue apps/client/test/card-hand-interaction.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 牌面走真卡图 —— Card.vue 渲染 manifest 里的 PNG（R696/R693/R702）

Task 2/8：
- Card 新增 `suit` prop（默认 4=王 ⇒ 查不到映射，不会静默画错牌）
- 牌面三分支：有素材 → <image>；素材缺失 → toDisplay 文本兜底（R693）；牌背 → 都不渲染
- `data-value` 原样保留（38 行 / 8 文件引用，探针锚点）；新增 `aria-label` = toDisplay(r)
- 判据迁移：文本断言 → aria-label + 兜底分支断言（新增 6 条，只增不减）
- `.card--wide` 保留（兜底分支的排版仍消费它），其测试不动

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 牌面比例几何（U1：采纳真牌 0.769）

**为什么单独一个 task**：改牌框比例会**改动手牌重叠的算账**，而那段算账有一条源码级判据
（`card-hand-interaction.test.ts:335` 的 F1）。本 task 把它一起迁到位 —— 两者必须同一个改动里落地，
否则「账目判据」与「真实令牌」会各说各话。

**Files:**
- Modify: `apps/client/src/uni.scss`
- Modify: `apps/client/src/pages/table/table.vue`
- Modify: `apps/client/test/card-hand-interaction.test.ts`（F1 判据）

**Interfaces:**
- Consumes: `$ftl-card-w` / `$ftl-card-h` / `$ftl-card-w-small` / `$ftl-card-h-small`（既有）
- Produces: `$ftl-card-overlap`（**新增**令牌，手牌重叠量）

### 算账（**先算清再动手**）

| 量 | 值 | 依据 |
|---|---|---|
| 真牌比例 | 80/104 = **0.769** | 逐张解析 IHDR 实测 |
| 手牌档宽 | `$ftl-card-w: 72rpx` | 比现状 48rpx 大 50% |
| 手牌档高 | `$ftl-card-h: 94rpx` | 72 / 0.769 = 93.6 → 94（比例 0.766，差 0.4%） |
| 重叠 | `$ftl-card-overlap: 40rpx` | 依次 dsh 的「净露 45–57%」；本档净露 = (72−40)/72 = **44%** |
| 20 张总宽 | 72 + 19×(72−40) = 72 + 608 = **680rpx** | 可用宽 **710rpx** ⇒ 余量 30rpx ✅ |
| 17 张总宽 | 72 + 16×32 = **584rpx** | ✅ |
| 小号档 | 48 × 62rpx | 48 / 0.769 = 62.4 → 62 |

可用宽 710rpx 的来路（`table.vue` 既有注释）：750 − `.table` 左右各 12 − `.table__me` 左右各 8 = 710。

---

- [ ] **Step 1: 写失败的测试 —— 把 F1 的算账判据改到新数字**

`card-hand-interaction.test.ts:335` 的 `it('源码级：手牌重叠账目…')`，把两个正则与期望改成：

```ts
  it('源码级：手牌重叠账目 = column-gap 归零 + 相邻牌负 margin-left（F1；U1 改档后）', () => {
    const zeroesColumnGap = (src: string) => /:deep\(\.hand\)\s*\{[^}]*column-gap:\s*0;/.test(src);
    // U1：牌宽 48→72rpx 后重叠改为令牌 `$ftl-card-overlap`（40rpx），不再是 `$ftl-space-6`
    const overlapsByMargin = (src: string) =>
      /\.card \+ \.card\)\s*\{[^}]*margin-left:\s*-\$ftl-card-overlap;/.test(src);
    expect(zeroesColumnGap(tableCode), '手牌容器必须 column-gap: 0（净重叠才是重叠令牌的全额）').toBe(true);
    expect(overlapsByMargin(tableCode), '重叠必须是 .card + .card 的负 margin-left').toBe(true);
    // …既有正反对照样本原样保留，把样本里的 `$ftl-space-6` 换成 `$ftl-card-overlap`…
  });
```

**再新增一条**（这次要钉住**数字本身**，而不只是写法）：

```ts
  it('源码级：手牌档比例 = 真牌 0.769，且 20 张单行放得下（F1 算账）', () => {
    const token = (name: string): number => {
      const m = new RegExp(`^\\$${name}:\\s*(\\d+)rpx;`, 'm').exec(uniScssCode);
      expect(m, `未找到令牌 $${name}`).not.toBeNull();
      return Number(m![1]);
    };
    const w = token('ftl-card-w');
    const h = token('ftl-card-h');
    const overlap = token('ftl-card-overlap');
    // 比例：与源图 80×104（0.769）相差 < 1.5%
    expect(Math.abs(w / h - 80 / 104) / (80 / 104), '牌框比例必须贴住真牌').toBeLessThan(0.015);
    // 20 张单行放得下：可用宽 710rpx（750 − 24 − 16）
    expect(w + 19 * (w - overlap), '地主拿满 20 张必须单行放得下').toBeLessThanOrEqual(710);
    // 净露率落在 dsh 的档位区间（45%–57%）
    const exposure = (w - overlap) / w;
    expect(exposure).toBeGreaterThanOrEqual(0.4);
    expect(exposure).toBeLessThanOrEqual(0.6);
  });
```

⚠️ 这段需要 `uniScssCode`（`src/uni.scss` 的**剥注释**文本）。文件顶部已有
`const sources = collectSourceFiles()`；加一个：

```ts
const uniScssCode = stripComments(sources.find((f) => f.path === 'src/uni.scss')!.content);
```

（`stripComments` 已从 `./helpers/source-scan` import；先读文件确认。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction
```

Expected: 两条 FAIL（`$ftl-card-overlap` 不存在；`w/h` 现在是 72/96 不合比例 —— 令牌还没改）。

- [ ] **Step 3: 改 `uni.scss` 的牌面令牌**

```scss
/// 牌面尺寸（normal / small 两档）。
/// U1（2026-09-21 用户裁决）：采纳**真牌比例** —— 源图 54 张面全部 80×104 px（0.769）。
/// 旧值 56×96（比例 0.583）是「零素材 / 纯 CSS 画牌」时代的权宜，参考拆解报告 §3 点过名。
$ftl-card-h: 94rpx;
$ftl-card-h-small: 62rpx;
$ftl-card-w: 72rpx;
$ftl-card-w-small: 48rpx;
/// 手牌**相邻两张**的重叠量（`.card + .card` 的负 `margin-left`）。
/// 净露 = (72 − 40) / 72 = 44%，落在参考实现（dsh 手牌 57% / 出牌区 45%）的档位区间。
/// ⚠️ 20 张的账目：72 + 19×(72−40) = 680rpx ≤ 可用宽 710rpx —— 改这个值必须重算，
/// 判据在 `test/card-hand-interaction.test.ts` 的 F1 算账用例。
$ftl-card-overlap: 40rpx;
```

- [ ] **Step 4: 改 `table.vue` 的手牌区**

① `.table__me :deep(.card)` 那条**整条删除** —— 手牌现在直接用 `normal` 档（72×94），不再压成小号：

```scss
/* U1：手牌改用 `normal` 档（72×94rpx）—— 牌面是真卡图，压到 48rpx 宽会看不清角标。
   旧写法（`flex: 0 0 $ftl-card-w-small; width: $ftl-card-w-small`）已删除：
   它只覆盖宽度、不覆盖高度 ⇒ 会造出 48×94 的**变形**牌框。 */
```

② 重叠值换成令牌：

```scss
.table__me :deep(.hand .card + .card) {
  margin-left: -$ftl-card-overlap;
}
```

③ **重写那段算账注释**（它是「账目」的真源，必须与新数字一致）：

```scss
/**
 * 手牌区：牌**互相压住**（每张比前一张左移 `$ftl-card-overlap` = 40rpx）以便 17~20 张牌读得清、又不必横向滚动。
 *
 * 算账（750rpx 逻辑宽）：`.table` 左右各 12rpx、`.table__me` 左右各 8rpx
 * ⇒ 可用宽 = 750 − 24 − 16 = **710rpx**。牌宽 = `$ftl-card-w`（72rpx）：
 *   - 17 张 = 72 + 16 × (72 − 40) = **584rpx**
 *   - 20 张（地主拿到底牌）= 72 + 19 × 32 = **680rpx** ⇒ 余量 30rpx，**单行放得下** ✅
 * 高度是 `$ftl-card-h`（94rpx）—— 比例 0.766，贴住源图 80×104 的 0.769（差 0.4%）。
 * 牌更多或机型更窄时 `flex-wrap` 兜底换行，不会溢出。
 *
 * ⚠️ **R671**：重叠必须用 `margin-left` 负值（`.card + .card`），**不能**用 `column-gap: -40rpx` ——
 * 负 `gap` 不是合法 CSS/WXSS，浏览器与小程序**都会直接丢弃该声明**（实测表现为手牌其实毫无重叠、
 * 靠换行铺开）。`margin-left` 负值三端都支持，且不影响任何锚点（`.table__me .card` 的数量/
 * `data-value`/选中态语义一个都不变）。
 *
 * ⚠️ **改了 `$ftl-card-w` 或 `$ftl-card-overlap` 就必须重算上面这两行** ——
 * 判据 `test/card-hand-interaction.test.ts` 的 F1 算账用例会把「20 张 ≤ 710rpx」当场钉住。
 */
```

- [ ] **Step 5: 跑测试 + 类型检查**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。

- [ ] **Step 6: 真浏览器走查（**观感类改动唯一有效的证明**）**

```bash
cd /d/Code/pokergame
# dev server + 探针
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 探针 gate 全绿（`.table__me .card` ≥ 17 那条不变）。

**人工看**（spec §9.2-7：jsdom 看不见「样式丢失/观感」）：
① 17 张手牌**单行**排开、彼此重叠；
② 点「点数升序/降序」手牌**真的重排**；
③ 角标点数在重叠状态下**可辨认**；
④ 牌不再是又窄又长的形状。
把观察结果记下（**不要写「应该没问题」**）。

- [ ] **Step 7: 提交**

```bash
cd /d/Code/pokergame
git add apps/client/src/uni.scss apps/client/src/pages/table/table.vue apps/client/test/card-hand-interaction.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 牌框改真牌比例 0.769（U1）+ 手牌重叠改令牌

Task 3/8：
- $ftl-card-w/h: 56×96 → 72×94（小号 48×76 → 48×62），贴住源图 80×104
- 新增 $ftl-card-overlap: 40rpx（净露 44%）；20 张 = 680rpx ≤ 可用宽 710rpx
- 删除 .table__me :deep(.card) 的宽度覆盖 —— 它只盖宽度不盖高度，
  在旧档下无碍，改档后会造出 48×94 的变形牌框
- F1 算账判据迁到新数字 + 新增「比例贴住真牌」「20 张单行放得下」两条

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 牌桌底纹 + 座位头像 + 座位字段权重（§6.5-1）

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`（底纹）
- Modify: `apps/client/src/components/Seat.vue`（头像图 + 字段权重）
- Modify: `apps/client/test/table-seat-geometry.test.ts`（新增断言）

**Interfaces:**
- Consumes: `/static/ui/new_BJ.png`、`/static/av/{Landlord,Farmer}.png`
- Produces: `.table` 的底纹；`.seat__avatar` 内的 `.seat__avatar-img`

### ⚠️ 执行者知悉（用户裁决 U2）

`new_BJ.png` 实为**日落山坡风景插画**（1224×720），不是牌桌台面 —— 它是参考项目的菜单背景。
用户 2026-09-21 看过该结论后**明确选择照 R704 执行**。按裁决做，不要「顺手改回素面」。

**可读性护栏**（这是新加的，不是改裁决）：底纹只铺在**页面容器 `.table`** 上；
`.table__center` / `.table__me` / `.seat` 各自的实色底**全部保留** ⇒ 牌面永远在实色块上，不受底纹干扰。

---

- [ ] **Step 1: 写失败的测试**

在 `table-seat-geometry.test.ts` 的座位几何 describe 里**新增**：

```ts
  it('§6.5-1：张数字号 > 名字字号（张数是牌桌第一信息）', () => {
    // 观感类改动在 jsdom 里看不见 ⇒ 这里钉**源码里的令牌档位关系**，不是「看起来对不对」。
    // 参考拆解报告 §2 可借清单第 1 条：CardGame 的剩余张数字号 62.95 > 名字 50.65。
    //
    // ⚠️ 档位值**从 `src/uni.scss` 现读**，不在测试里抄一份字号表 ——
    //    抄一份就是第二个真源，字号阶一改这条判据就开始说谎。
    const fontRpx = (tier: string): number => {
      const m = new RegExp(`^\\$ftl-font-${tier}:\\s*(\\d+)rpx;`, 'm').exec(uniScssCode);
      expect(m, `未找到令牌 $ftl-font-${tier}`).not.toBeNull();
      return Number(m![1]);
    };
    const seat = sources.find((f) => f.path === 'src/components/Seat.vue');
    expect(seat, 'Seat.vue 必须在扫描集合里').toBeDefined();
    const code = stripComments(seat!.content);
    /** 取某个选择器块里用到的第一个 `$ftl-font-*` 档位值。 */
    const fontOf = (selector: string): number => {
      const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(code);
      expect(block, `未找到 ${selector} 规则`).not.toBeNull();
      const tier = /\$ftl-font-(\w+)/.exec(block![1]!);
      expect(tier, `${selector} 必须用 $ftl-font-* 令牌`).not.toBeNull();
      return fontRpx(tier![1]!);
    };
    expect(fontOf('\\.seat__count'), '剩几张必须比昵称显眼').toBeGreaterThan(fontOf('\\.seat__name'));
  });
```

顶部补：

```ts
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
/** `src/uni.scss` 的**剥注释**文本（读字号阶用）。 */
const uniScssCode = stripComments(sources.find((f) => f.path === 'src/uni.scss')!.content);
```

⚠️ `sources` / `stripComments` 若本文件已 import 过，**不要重复引入**（`noUnusedLocals` 会红）—— 先读文件顶部确认。

第二个 `it` 的头部（挂载与断言）**先读该文件里既有的挂载助手**（`mountTable` 只是本计划的**代称**），
用它的真实名字与签名写：

```ts
  it('R696/§6.4：座位头像走素材图，且地主/农民取不同文件', () => {
    const wrapper = /* ← 用本文件既有的挂载助手，夹具设 landlordSeat 让他人当地主 */;
    // 地主座位：带 `.seat__badge` 的那个
    const landlordSeat = wrapper.findAll('.seat').find((s) => s.find('.seat__badge').exists())!;
    expect(landlordSeat.find('.seat__avatar-img').attributes('src')).toBe('/static/av/Landlord.png');
    // 其余座位（农民）取另一张 —— 正对照：证明真的按 `isLandlord` 分支，不是写死一张
    const farmerSeat = wrapper.findAll('.seat').find((s) => !s.find('.seat__badge').exists())!;
    expect(farmerSeat.find('.seat__avatar-img').attributes('src')).toBe('/static/av/Farmer.png');
  });
```

⚠️ 上面第一条断言是**源码级**的，它不证明「看起来显眼」—— 观感由 Step 5 的真浏览器走查兜。
这条只防「档位关系再次反过来」。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- table-seat-geometry
```

Expected: 两条 FAIL（字号关系现在是反的：name md > count sm；`.seat__avatar-img` 不存在）。

- [ ] **Step 3: 实现 —— `Seat.vue` 头像**

`<template>` 里替换头像块：

```html
    <!-- §6.4：头像走素材图（Landlord / Farmer）。`aspectFit` —— 两张源图尺寸不同
         （198×272 / 206×256），固定方框内等比缩放，不裁切、不变形。
         兜底：素材缺失时 `<image>` 自身空白，`initial` 字块仍在下层（R693）。 -->
    <view class="seat__avatar">
      <text class="seat__avatar-initial">{{ initial }}</text>
      <image class="seat__avatar-img" :src="avatarSrc" mode="aspectFit" />
    </view>
```

`<script setup>` 加一个 computed：

```ts
/** 地主 / 农民两张头像（`static/av/`）。纯展示，不含任何判断 —— `isLandlord` 来自服务端视图。 */
const avatarSrc = computed(() => (props.isLandlord ? '/static/av/Landlord.png' : '/static/av/Farmer.png'));
```

`<style>` 改 `.seat__avatar` 为相对定位容器 + 两层叠放：

```scss
/** 头像位：素材图铺满；字块降为**兜底**（图片缺失时仍有东西可看，R693）。 */
.seat__avatar {
  box-sizing: border-box;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $ftl-size-avatar;
  height: $ftl-size-avatar;
  border-radius: $ftl-radius-pill;
  background: $ftl-color-primary-soft;
  color: $ftl-color-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  overflow: hidden;
}
/** 兜底字块（在图片**下层**）。 */
.seat__avatar-initial {
  line-height: 1;
}
/** 头像图：绝对铺满，盖住兜底字块。 */
.seat__avatar-img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
```

（`.seat--me .seat__avatar` 的两条既有覆盖**保留不动**；`.seat--me .seat__avatar text` 那条改成
`.seat--me .seat__avatar-initial`。）

- [ ] **Step 4: 实现 —— 字段权重（§6.5-1）+ 底纹（U2）**

`Seat.vue` 的 `<style>`：

```scss
.seat__name {
  display: flex;
  flex-wrap: wrap;
  gap: $ftl-space-2;
  align-items: center;
  /* §6.5-1：昵称降到次级档 —— 张数才是牌桌第一信息（参考拆解报告 §2 可借清单第 1 条）。 */
  font-size: $ftl-font-sm;
}
.seat__count {
  display: block;
  color: $ftl-color-text;
  /* §6.5-1：升为主档 + 加粗。⚠️ 必须比 `.seat__name` 的档位大 —— 判据在 table-seat-geometry。 */
  font-size: $ftl-font-md;
  font-weight: 600;
}
```

`table.vue` 的 `.table` 加底纹（**图片路径不受令牌约束**，spec §9.2-2 明文）：

```scss
.table {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 100%;
  max-width: 1120rpx;
  margin: 0 auto;
  padding: $ftl-space-5 $ftl-space-5 $ftl-space-9;
  /* R704：牌桌底纹。⚠️ 只铺在**页面容器**上；`.table__center` / `.table__me` / `.seat`
     各自的实色底全部保留 ⇒ 牌面永远在实色块上，底纹不干扰读牌。 */
  background-image: url('/static/ui/new_BJ.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
```

- [ ] **Step 5: 跑测试 + 真浏览器走查**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 全绿。

**人工看**：① 座位头像显示的是地主/农民图；② 底纹在页面上，**牌面与文字仍然清晰可读**；
③ 「剩 N 张」比昵称显眼。
⚠️ 若底纹让某处文字看不清 —— 那是**要修的可读性问题**（给该处加实色底），**不是**回头去改 U2 的裁决。

- [ ] **Step 6: 提交**

```bash
cd /d/Code/pokergame
git add apps/client/src/components/Seat.vue apps/client/src/pages/table/table.vue apps/client/test/table-seat-geometry.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 牌桌底纹 + 座位头像 + 字段权重（R704/U2/§6.5-1）

Task 4/8：
- `.table` 铺 new_BJ.png 底纹；面板/座位/中央区的实色底全部保留（可读性护栏）
- 座位头像走 static/av/，地主/农民分文件；aspectFit + 字块兜底（R693）
- §6.5-1：张数升为主档加粗、昵称降次级档（参考实现里张数 62.95 > 名字 50.65）
- 判据：源码级档位关系 + 头像 src；观感由真浏览器走查兜

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UI 贴图 —— 面板 9-slice + 按钮贴图 + logo（U3）

**Files:**
- Create: `apps/client/src/components/Panel.vue`
- Modify: `apps/client/src/uni.scss`（`ftl-btn` mixin 加贴图层）
- Modify: `apps/client/src/pages/login/login.vue`（logo）
- Modify: `apps/client/src/pages/lobby/lobby.vue`、`apps/client/src/pages/table/table.vue`、`apps/client/src/components/BidPanel.vue`（主按钮贴图）
- Modify: `apps/client/test/table-bid-bottom.test.ts`（TABLE_AREA 计数）

**Interfaces:**
- Consumes: `/static/ui/{btn1,btn2,btn3,panel-blue,panel-orange,logo}.png`
- Produces: `Panel.vue`（props：`variant?: 'blue' | 'orange'`）

### ⚠️ 三条硬约束

1. **`.btn--primary { background: … }` 必须**在**每个渲染 `.btn` 的组件里逐字保留** ——
   `table-bid-bottom.test.ts:437-441` 的正则是 `/\.btn--primary\b[^{]*\{[^}]*\bbackground\s*:/`，
   **只认字面 `background:`**（`background-image:` **不匹配**）。
2. **贴图色与品牌蓝冲突是已知的、用户已放行**（U3 原话：「先做出来，后面再替换贴图就是」）⇒ 不要因为配色去改令牌。
3. **`TABLE_AREA` 的处置已在 Step 6 定死**：`Panel.vue` **不进**清单，`toHaveLength(8)` 不变
   （依据：清单按设计块列文件，共用控件与 `wd-tag` 同类 —— `wd-tag` 被 `Seat.vue` 用了也不在清单里）。
   Step 6 里仍要求**读一遍那段注释核对口径**，但结论不要改来改去。

---

- [ ] **Step 1: 写失败的测试 —— `Panel.vue` 的 9-slice**

创建 `apps/client/test/panel.test.ts`：

```ts
/**
 * `Panel.vue` 的 9-slice 面板（§6.4）。
 *
 * ⚠️ 判据射程（诚实版）：jsdom 不注入 CSS ⇒ 本文件**不证明**九宫格渲染得像样。
 * 它只钉两件事：① 两个变体取的是**不同**的源图；② `border-image` 的四个参数
 * （slice / width / repeat / 源图）在**源码里**齐备且用的是 rpx/无单位 —— 缺一个
 * 都会静默退化成「一张被拉伸的图」。观感由真浏览器走查兜（spec §9.2-7）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import Panel from '../src/components/Panel.vue';

const panelSrc = stripComments(
  collectSourceFiles().find((f) => f.path === 'src/components/Panel.vue')!.content,
);

describe('§6.4 面板 9-slice', () => {
  it('默认（blue）与 orange 取不同的源图', () => {
    const blue = mount(Panel, { slots: { default: 'x' } });
    const orange = mount(Panel, { props: { variant: 'orange' }, slots: { default: 'x' } });
    expect(blue.classes()).toContain('panel');
    expect(blue.classes()).toContain('panel--blue');
    expect(orange.classes()).toContain('panel--orange');
    blue.unmount();
    orange.unmount();
  });

  it('源码里四个 9-slice 参数齐备（缺一就静默退化成拉伸图）', () => {
    expect(panelSrc, '源图').toMatch(/panel-blue\.png/);
    expect(panelSrc, '源图').toMatch(/panel-orange\.png/);
    expect(panelSrc, 'slice').toMatch(/border-image-slice:\s*\d+(%\s*)?fill/);
    expect(panelSrc, 'width/rpx').toMatch(/border-width:\s*\d+rpx/);
    expect(panelSrc, 'repeat').toMatch(/border-image-repeat:\s*(stretch|round|repeat)/);
  });

  it('默认插槽被渲染（容器而非空壳）', () => {
    const wrapper = mount(Panel, { slots: { default: '<text class="probe">hi</text>' } });
    expect(wrapper.find('.probe').exists()).toBe(true);
    wrapper.unmount();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- panel
```

Expected: FAIL（`Panel.vue` 不存在）。

- [ ] **Step 3: 实现 `Panel.vue`**

```vue
<script setup lang="ts">
/**
 * 9-slice 面板（spec §6.4）。素材：`static/ui/panel-{blue,orange}.png`（126×126）。
 *
 * **实现形态选定：`border-image`**（规格要求「选定一种并写进计划」，不留悬空）。
 * 选它而不选「`<image>` + 绝对定位」的理由：单元素、零额外 DOM、不引入定位上下文
 * （后者会与 `.table__me .card` 那类父级穿透规则抢 `position`）。
 *
 * ⚠️ 四种 9-slice 参数缺一不可，缺了就**静默**退化成「一张被拉伸的图」：
 *   · `border-image-slice`（无单位 = 源图像素；126px 的圆角约 24px）
 *   · `border-width`（渲染尺寸，必须 rpx）
 *   · `border-image-repeat`
 *   · `border-image-source`（由 `border-image` 简写提供）
 *
 * ⚠️ **兜底**（R693 同精神）：底图 404 时 `border-image` 不渲染，只剩一圈 24rpx 的透明边框 ——
 * 因此 `.panel` 自带 `background: $ftl-color-surface`，退化成一个**素面板**而不是一个空洞。
 *
 * ⚠️ 观感（圆角有没有被切坏）**只能**由真浏览器/App 走查证明 —— jsdom 不注入 CSS。
 */
defineOptions({ name: 'Panel' });

withDefaults(defineProps<{ variant?: 'blue' | 'orange' }>(), { variant: 'blue' });
</script>

<template>
  <view class="panel" :class="`panel--${variant}`">
    <slot />
  </view>
</template>

<style scoped lang="scss">
.panel {
  box-sizing: border-box;
  /* 切片宽度 = 源图圆角所占的像素（126px 的图，圆角约 24px）；渲染尺寸用令牌。 */
  border: $ftl-panel-slice solid transparent;
  padding: $ftl-space-4;
  background: $ftl-color-surface;
  font-size: $ftl-font-md;
  color: $ftl-color-text;
}
.panel--blue {
  border-image: url('/static/ui/panel-blue.png') 24 fill stretch;
}
.panel--orange {
  border-image: url('/static/ui/panel-orange.png') 24 fill stretch;
}
</style>
```

同时在 `uni.scss` 末尾（`ftl-btn` mixin 附近）**先加令牌**：

```scss
/// 9-slice 面板的切片宽度（源图 126×126，圆角约 24px）—— `Panel.vue` 用。
/// ⚠️ `border-image-slice` 里那个 `24` 是**无单位**的源图像素，与本令牌是**两个量**：
/// 前者切图、后者定渲染尺寸；改一个不改另一个会切坏圆角。
$ftl-panel-slice: 24rpx;
```

- [ ] **Step 4: 按钮贴图 —— 改 `uni.scss` 的 `ftl-btn` mixin**

在 mixin 里加一层贴图（**这是唯一的改动点** ⇒ 所有 `@include ftl-btn` 的组件自动拿到，
不用逐个改，也不破坏「自持样式」的闸）：

```scss
/** 按钮底图（`static/ui/btn2.png`，245×79）。⚠️ 与品牌蓝的配色冲突是**已知且用户放行**的。 */
$ftl-btn-plate: '/static/ui/btn2.png';

/**
 * 统一按钮观感。三个页面（login/lobby/table）共用同一份 —— 之前是各自抄一份字面量。
 * `border: 1px` 是发丝线（多端在 1px 以下会渲染不出来），因此刻意保留 `px`。
 *
 * ⚠️ `background-image` 放在 `background` **之后**：简写会把 `background-image` 重置成
 * `none`，顺序反了就静默没有贴图。
 */
@mixin ftl-btn {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: $ftl-control-h;
  padding: 0 $ftl-space-8;
  border: 1px solid $ftl-color-border-control;
  border-radius: $ftl-radius-md;
  background: $ftl-color-surface;
  background-image: url($ftl-btn-plate);
  background-size: 100% 100%;
  background-repeat: no-repeat;
  color: $ftl-color-text;
  font-size: $ftl-font-lg;
  cursor: pointer;
}
```

⚠️ `background-size: 100% 100%` —— `%` **不在** `ui-tokens` 的禁用单位表里（它只禁 `px/em/rem/vw/pt/vh`）✅。

- [ ] **Step 5: 主按钮 + logo**

**主按钮**：每个渲染 `.btn--primary` 的组件（`login.vue` / `lobby.vue` / `table.vue` / `BidPanel.vue`），
在**既有**的 `.btn--primary` 规则里 `background` **之后**补一行贴图：

```scss
.btn--primary {
  border-color: $ftl-btn-primary-bg;
  background: $ftl-btn-primary-bg;
  background-image: url('/static/ui/btn1.png');
  background-size: 100% 100%;
  color: $ftl-color-on-primary;
}
```

⚠️ **`background:` 那一行一个字都不能动** —— `table-bid-bottom.test.ts` 的闸按字面匹配它。
⚠️ 先跑一遍确认每条都改到了：

```bash
grep -rn "\.btn--primary" apps/client/src --include=*.vue -A3 | grep -c "background:"   # 应与下面这条相等
grep -rln "\.btn--primary" apps/client/src --include=*.vue | wc -l
```

**logo**：`login.vue` 的**品牌头**里，在既有标题**上方**加一张图，**不改任何既有文字**
（`login-screen.test.ts:5` 明写「保锚」两条，文字类断言另有其处 —— 一个字都不动最安全）：

```html
      <image class="login__logo" src="/static/ui/logo.png" mode="aspectFit" />
```

```scss
.login__logo {
  width: 320rpx;
  height: 200rpx;
}
```

（`.login__logo` 的宽高按 `logo.png` 的 237×147 比例给，`aspectFit` 保证不裁切。）

- [ ] **Step 6: 把 `Panel` 用起来 —— 换掉结算卡片的 `wd-card` 根**

⚠️ **组件必须真的被用上**，否则就是死代码（YAGNI）。落点选**结算卡片**：
`Settlement.vue` 的根元素是 `wd-card`（一个 `wot-design-uni` 组件），它**语义上就是一个面板**，
换成 `Panel` 之后 `.table__settlement` 这个稳定锚点**仍然落在根上**、`.settlement__*` 子元素一个不动。

```vue
<!-- Settlement.vue：根元素 wd-card → Panel。class 仍然落根（Panel 是单根 `view`）。 -->
<template>
  <Panel class="table__settlement" variant="blue">
    <!-- ⚠️ 模板注释仍然必须在根元素**内部**（R681 的单根纪律）—— 别挪到 <Panel> 之前。 -->
    …
  </Panel>
</template>
```

`<script setup>` 加 `import Panel from './Panel.vue';`，`<style>` 里删掉针对 `wd-card` 的残留规则
（**先 grep 确认有没有**：`grep -n "wd-card" apps/client/src/components/Settlement.vue`）。

**`TABLE_AREA` 要不要加 `Panel.vue`？—— 不加，`toHaveLength(8)` 不动。**

依据（**先读那段注释确认口径**）：`TABLE_AREA` 是「**牌桌区各设计块**（➌–➐）的文件清单」，
每一项都对应一个设计块；`Panel` 是**共用控件**，与 `wot-design-uni` 的 `wd-tag` 同类 ——
而 `wd-tag` 被 `Seat.vue` 用了、**并不在清单里**（既有先例）。所以照既有口径，`Panel` 同样不进。

⚠️ 若执行时读出的口径**不是**「按设计块列文件」而是「牌桌渲染到的全部文件」，那就必须加进去，
并把 `:294` / `:316` 的 `8` 改成 `9`、**在测试里写清为什么是 9**。
**判断依据以那段注释的实际措辞为准**，不要凭本计划的转述。

跑一遍确认换根没打破任何东西：

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- table-settlement-ui table-ended-ui table-hud
```

Expected: 全绿（`.table__settlement` 仍是根、`.settlement__*` 文本断言不变、单根闸不红）。

- [ ] **Step 7: 跑测试 + 真浏览器走查**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 全绿（**特别注意**：探针的 `.login__actions .btn` / `.lobby__match .btn` /
`.table__bar .btn` 三处靠 `el.click()` 点 —— 贴图不改变元素类型，应当无影响）。

**人工看**：① 按钮显示贴图且**文字仍居中可读**；② 面板圆角**没有被切坏/拉花**（这是 `border-image`
最典型的翻车形态）；③ logo 显示正常、不裁切；④ 结算卡片换根后**观感没有塌**（尤其内边距与背景）；
⑤ 按钮贴图的白底**没有**把文字盖住。

⚠️ 若 ② 翻车：那是 `border-image-slice` 的数值问题（切少了圆角被拉、切多了中间被压），
**改数值**而不是换实现。

- [ ] **Step 8: 提交**

```bash
cd /d/Code/pokergame
git add apps/client/src/components/Panel.vue apps/client/src/components/Settlement.vue apps/client/src/uni.scss \
        apps/client/src/pages/login/login.vue apps/client/src/pages/lobby/lobby.vue \
        apps/client/src/pages/table/table.vue apps/client/src/components/BidPanel.vue \
        apps/client/test/panel.test.ts
git commit -m "$(cat <<'EOF'
feat(client): UI 贴图 —— 面板 9-slice + 按钮底图 + logo（U3/§6.4）

Task 5/8：
- Panel.vue：border-image 9-slice（形态选定并写进计划）；两个变体两套源图
  兜底：底图 404 时退化成素面板（background 令牌），不是一圈透明边框
- Settlement.vue 的根 wd-card → Panel（它语义上就是面板）；
  .table__settlement 仍落根、.settlement__* 一个不动、TABLE_AREA 仍是 8
  （依据：清单按设计块列文件，共用控件与 wd-tag 同类、不入清单）
- ftl-btn mixin 加一层底图 —— 单点改动，所有 @include 的组件自动生效，
  不破坏「渲染 class="btn" 的组件必须自持样式」的闸
- .btn--primary 的 `background:` 字面量逐字保留（table-bid-bottom 的闸按字面匹配）
- logo 加在登录页品牌头**上方**，不改任何既有文字（保锚）
- 判据：四个 9-slice 参数齐备 + 变体源图不同；观感由真浏览器走查兜

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 音效（U4：全做，预算 1.5 MiB）+ §6.5-2 报单/报双预警

**Files:**
- Create: `scripts/transcode-audio.mjs`
- Create: `apps/client/src/audio/index.ts`
- Create: `apps/client/src/audio/cues.ts`
- Create: `apps/client/src/composables/useTableSound.ts`
- Create: `apps/client/test/audio.test.ts`
- Modify: `apps/client/test/helpers/uni-stub.ts`（`createInnerAudioContext` 替身）
- Modify: `apps/client/src/pages/table/table.vue`（音效接线）
- Modify: `apps/client/src/pages/lobby/lobby.vue`（大厅 BGM）
- Modify: `apps/client/src/components/Seat.vue` + `apps/client/test/table-seat-geometry.test.ts`（§6.5-2 视觉预警）

**Interfaces:**
- Produces:
  - `audio/index.ts`：`playCue(name: CueName): void` · `setMuted(b: boolean): void` · `isMuted(): boolean` · `setVolume(n: number): void` · `getVolume(): number`
  - `audio/cues.ts`：`CUES: Record<CueName, string>`（**纯数据**，无规则判定）
  - `composables/useTableSound.ts`：`useTableSound()`（订阅视图/ack，播对应音效）

### 🔴 三条硬约束

1. **播放失败必须静默**：探针有两条零容忍断言 —— `全程 Runtime.exceptionThrown 为 0`
   （`browser-e2e.mjs:674`）与 `全程 error 级 console 为 0`（`:675`）。
   `InnerAudioContext.play()` 返回 Promise，**无用户手势时会被拒** ⇒ **必须 `.catch(() => {})`**，
   且**绝不 `console.error`**。
2. **`uni.createInnerAudioContext()` 必须写成直接成员调用**（闸：`uni-api-access`）。
   ✅ 已实测 `createInnerAudioContext` **确实在 `@dcloudio/uni-h5` 的导出名录里**
   （`uni-h5.es.js:24677`）⇒ H5 发行构建的注入改写对它有效，不是「dev 正常、发行版静默失效」。
3. **音效不得进入判据路径**（spec §9.2-5 的交接要求）：探针**不**验证声音；单测验证的是
   「该响的时候调了播放、不该响的时候没调」，不是「真的听见了」。

### 音效事件表（R698 + §10 的例外）

| 触发 | 音效 | 判据来源 |
|---|---|---|
| `game.bid` ack OK 且 `grab` | `Woman_Rob{seat+1}` | **本地回声**（ack 之后） |
| `game.bid` ack OK 且 `!grab` | `Woman_NoOrder` | 同上 |
| `game.pass` ack OK | `Woman_buyao{seat+1}` | 同上（过牌不改 `lastPlayerIdx`，服务端无字段） |
| 某人剩 1 张 | `Woman_baojing1` | `cardCounts` 的 **1→0 之外的跃迁**（见 Step 6） |
| 某人剩 2 张 | `Woman_baojing2` | 同上 |
| `lastPlayedHand` 是**单张**小王 / 大王 | `Woman_100` / `Woman_200` | 视图 diff |
| 结算出现 | `MusicEx_Win` / `MusicEx_Lose` | `store.settlement` |
| 进牌桌 | `MusicEx_Normal`（BGM，循环） | 页面挂载 |

---

- [ ] **Step 1: 转码脚本 + 产出音频**

创建 `scripts/transcode-audio.mjs`：

```js
/**
 * ogg → mp3 转码（spec §7 的「用系统 `ffmpeg` 的脚本，不进依赖」）。
 *
 * ⚠️ **为什么必须转**：OGG/Vorbis **在 iOS WKWebView 上不能播** ⇒ 这是**兼容性必需**，
 * 不是体积优化。源 ogg 本身只有 65–72 kbps（已高度压缩），所以 mp3 在 96k 反而更大。
 *
 * 码率由用户裁决 **U4** 定：全保留 5 条 BGM、预算放宽到 1.5 MiB
 * ⇒ BGM 64k mono（≈ 源码率，近乎透明）/ SFX 96k mono（语音，短文件，便宜）。
 *
 * 幂等：目标文件已存在且非空则跳过 ⇒ 可反复重跑。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'resources';
const OUT = join('apps', 'client', 'src', 'static', 'audio');

/** [源相对路径, 输出名, 码率]。R698 的 18 条 + §10 例外的 2 条 = 20。 */
const TRACKS = [
  // ── 牌桌事件（SFX，96k）──
  ['Sound/Fight/Woman_Order.ogg', 'Woman_Order.mp3', '96k'],
  ['Sound/Fight/Woman_NoOrder.ogg', 'Woman_NoOrder.mp3', '96k'],
  ['Sound/Fight/Woman_Rob1.ogg', 'Woman_Rob1.mp3', '96k'],
  ['Sound/Fight/Woman_Rob2.ogg', 'Woman_Rob2.mp3', '96k'],
  ['Sound/Fight/Woman_Rob3.ogg', 'Woman_Rob3.mp3', '96k'],
  ['Sound/Fight/Woman_buyao1.ogg', 'Woman_buyao1.mp3', '96k'],
  ['Sound/Fight/Woman_buyao2.ogg', 'Woman_buyao2.mp3', '96k'],
  ['Sound/Fight/Woman_buyao3.ogg', 'Woman_buyao3.mp3', '96k'],
  ['Sound/Fight/Woman_buyao4.ogg', 'Woman_buyao4.mp3', '96k'],
  ['Sound/Fight/Woman_baojing1.ogg', 'Woman_baojing1.mp3', '96k'],
  ['Sound/Fight/Woman_baojing2.ogg', 'Woman_baojing2.mp3', '96k'],
  // §10 的**例外**：大小王**单张**出牌播报（单张判定现成，不必等新裁决）
  ['Sound/Fight/Woman_100.ogg', 'Woman_100.mp3', '96k'],
  ['Sound/Fight/Woman_200.ogg', 'Woman_200.mp3', '96k'],
  ['Sound/Fight/MusicEx_Win.ogg', 'MusicEx_Win.mp3', '96k'],
  ['Sound/Fight/MusicEx_Lose.ogg', 'MusicEx_Lose.mp3', '96k'],
  // ── BGM（64k）──
  ['MusicEx/MusicEx_Normal.ogg', 'MusicEx_Normal.mp3', '64k'],
  ['MusicEx/MusicEx_Normal2.ogg', 'MusicEx_Normal2.mp3', '64k'],
  ['MusicEx/MusicEx_Welcome.ogg', 'MusicEx_Welcome.mp3', '64k'],
  ['MusicEx/MusicEx_Exciting.ogg', 'MusicEx_Exciting.mp3', '64k'],
  ['MusicEx/openinganimation.ogg', 'openinganimation.mp3', '64k'],
];

mkdirSync(OUT, { recursive: true });
let made = 0;
let skipped = 0;
let bytes = 0;

for (const [from, to, bitrate] of TRACKS) {
  const dst = join(OUT, to);
  if (existsSync(dst) && statSync(dst).size > 0) {
    skipped += 1;
    bytes += statSync(dst).size;
    continue;
  }
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(SRC, from),
    '-ac', '1', '-b:a', bitrate, '-ar', '44100', dst]);
  made += 1;
  bytes += statSync(dst).size;
}

console.log(`转码 ${made} 条 / 跳过 ${skipped} 条 ⇒ ${(bytes / 1024).toFixed(0)} KiB（预算 1536 KiB）`);
if (bytes / 1024 > 1536) { console.error('超出预算'); process.exit(1); }
```

跑：

```bash
cd /d/Code/pokergame
node scripts/transcode-audio.mjs
ls apps/client/src/static/audio/*.mp3 | wc -l    # 期望 20
du -sk apps/client/src/static/audio               # 期望 ≈ 1456 KiB
```

- [ ] **Step 2: 写失败的测试 —— `uni` 替身先补 `createInnerAudioContext`**

`test/helpers/uni-stub.ts` 里新增（照既有 `request` 的写法：**只补宿主能力、记账、不改 src 行为**）：

```ts
/** `uni.createInnerAudioContext()` 的替身实例。 */
export interface UniAudioDouble {
  /** 本实例被设过的 `src` 序列。 */
  src: string[];
  /** `play()` 被调的次数。 */
  play: number;
  /** `stop()` / `destroy()` 被调的次数。 */
  stop: number;
  loop: boolean;
  volume: number;
}

/** 替身记录的音效上下文（每个 `createInnerAudioContext()` 一条）。 */
export const audioContexts: UniAudioDouble[] = [];
```

并在 `installUniStub` 的 uni 对象上挂：

```ts
    createInnerAudioContext: () => {
      const rec: UniAudioDouble = { src: [], play: 0, stop: 0, loop: false, volume: 1 };
      audioContexts.push(rec);
      return {
        set src(value: string) { rec.src.push(value); },
        get src() { return rec.src[rec.src.length - 1] ?? ''; },
        set loop(value: boolean) { rec.loop = value; },
        set volume(value: number) { rec.volume = value; },
        // ⚠️ 真实现的 `play()` 返回 Promise 且**无手势时会被拒**。
        // 替身**诚实地**返回一个「会拒绝」的 Promise —— 否则「忘了 catch」在测试里看不出来，
        // 而真机上会变成 `Runtime.exceptionThrown`（探针的零容忍断言）。
        play: () => { rec.play += 1; return Promise.reject(new Error('autoplay blocked (stub)')); },
        stop: () => { rec.stop += 1; },
        destroy: () => { rec.stop += 1; },
        // ⚠️ 生产代码里 `onEnded` / `onError` 是**不加可选链**的直接调用
        // （加了 `?.` 会让「这个端没这个方法」从编译期错误退化成运行期静默）
        // ⇒ 替身必须实现它们，否则调用时当场 `TypeError`。
        onEnded: () => undefined,
        onError: () => undefined,
      };
    },
```

（⚠️ **先读 `uni-stub.ts` 的 `installUniStub` 结构再插**，照它既有的形状写；上面是片段不是整段替换。）

创建 `apps/client/test/audio.test.ts`：

```ts
/**
 * 音效层（R698 + U4）。
 *
 * ⚠️ **判据射程**：jsdom 里没有声音。这里证明的是「该响的时候，用**正确的 src** 调了 `play()`；
 * 不该响的时候一次都没调」——**不是**「真的听见了」。声音本身由真机走查确认。
 *
 * ⚠️ 替身的 `play()` **故意返回一个被拒的 Promise**：于是「忘了 catch」在这条判据下当场暴露
 * （未处理的拒绝会让 vitest 报错），而真机上它就是探针的 `Runtime.exceptionThrown`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { audioContexts } from './helpers/uni-stub';
import { playCue, setMuted, isMuted, setVolume, getVolume, cueForBid, cueForPass } from '../src/audio';
import { CUES } from '../src/audio/cues';

beforeEach(() => {
  audioContexts.length = 0;
  setMuted(false);
});

describe('音效播放', () => {
  it('cue 名到文件名的映射是纯数据，且每个值都指向 /static/audio/ 下的 .mp3', () => {
    const names = Object.keys(CUES);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const [name, src] of Object.entries(CUES)) {
      expect(src, `${name} 的 src`).toMatch(/^\/static\/audio\/[A-Za-z0-9_]+\.mp3$/);
    }
  });

  it('playCue 用正确的 src 建上下文并 play', () => {
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(1);
    expect(audioContexts[0]!.src.at(-1)).toBe('/static/audio/Woman_NoOrder.mp3');
    expect(audioContexts[0]!.play).toBe(1);
  });

  it('按座位取变体：seat 0/1/2 分别取 Rob1/Rob2/Rob3（确定性，可复现）', () => {
    cueForBid(true, 0);
    cueForBid(true, 2);
    expect(audioContexts.map((c) => c.src.at(-1))).toEqual([
      '/static/audio/Woman_Rob1.mp3',
      '/static/audio/Woman_Rob3.mp3',
    ]);
  });

  it('不抢走 NoOrder，过牌按座位取 Buyao 变体', () => {
    cueForBid(false, 1);
    cueForPass(1);
    expect(audioContexts.map((c) => c.src.at(-1))).toEqual([
      '/static/audio/Woman_NoOrder.mp3',
      '/static/audio/Woman_buyao2.mp3',
    ]);
  });

  it('静音时一次都不 play（但也不抛）', () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(0);
  });

  it('播放失败被静默吞掉（替身的 play 总是拒绝 ⇒ 忘了 catch 会让本文件报未处理拒绝）', async () => {
    playCue('NoOrder');
    await expect(Promise.resolve()).resolves.toBeUndefined();   // 让微任务队列排空
    expect(audioContexts[0]!.play).toBe(1);
  });

  it('音量钳在 0–1 并存回来', () => {
    setVolume(0.5);
    expect(getVolume()).toBe(0.5);
    setVolume(9);
    expect(getVolume()).toBe(1);
    setVolume(-3);
    expect(getVolume()).toBe(0);
  });

  it('未知 cue 名：静默忽略，不抛（防止一个拼错的名字把牌桌打崩）', () => {
    expect(() => playCue('NoSuchCue' as never)).not.toThrow();
    expect(audioContexts).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- audio
```

Expected: FAIL（`../src/audio` 不存在）。

- [ ] **Step 4: 实现 `audio/cues.ts` 与 `audio/index.ts`**

`apps/client/src/audio/cues.ts`：

```ts
/**
 * 事件 → 音频文件名的**纯数据**表（R698 + §10 的例外）。
 *
 * ⚠️ **这里没有、也不该有任何牌型判定**：表只把「已经发生的事」翻译成一个文件名。
 * 「什么时候算发生了」由调用方（`useTableSound` / 页面 ack）决定。
 * 牌型播报（50 条）**不做** —— 需要新的裁决（spec §7 / §10）。
 */
export const CUES = {
  /** 抢（按座位取变体：seat 0/1/2 → 1/2/3） */
  Rob1: '/static/audio/Woman_Rob1.mp3',
  Rob2: '/static/audio/Woman_Rob2.mp3',
  Rob3: '/static/audio/Woman_Rob3.mp3',
  /** 不抢 */
  NoOrder: '/static/audio/Woman_NoOrder.mp3',
  /** 过牌（按座位取变体） */
  Buyao1: '/static/audio/Woman_buyao1.mp3',
  Buyao2: '/static/audio/Woman_buyao2.mp3',
  Buyao3: '/static/audio/Woman_buyao3.mp3',
  /** 报单（剩 1 张）/ 报双（剩 2 张）—— §6.5-2 */
  Baojing1: '/static/audio/Woman_baojing1.mp3',
  Baojing2: '/static/audio/Woman_baojing2.mp3',
  /** 大小王**单张**出牌（§10 的例外，不必等新裁决） */
  SingleLittleJoker: '/static/audio/Woman_100.mp3',
  SingleBigJoker: '/static/audio/Woman_200.mp3',
  /** 胜负 */
  Win: '/static/audio/MusicEx_Win.mp3',
  Lose: '/static/audio/MusicEx_Lose.mp3',
  /** BGM（循环） */
  BgmTable: '/static/audio/MusicEx_Normal.mp3',
  BgmLobby: '/static/audio/MusicEx_Welcome.mp3',
} as const;

export type CueName = keyof typeof CUES;
```

⚠️ **`Woman_Order.mp3` 在 `static/audio/` 里、但不在 `CUES` 里** —— 这是**有意的**：
R698 的清单把它列作「叫」的候选（与参考实现的 `callLandlord` 同源），但我方规则**只有抢/不抢**
（`game.bid` 的载荷是 `{ grab: boolean }`）⇒ 没有调用点。
**不放进 `CUES`** 是因为它会长成一条**死条目**（R377：零命中的条目让闸变成假绿）；
文件仍然入库，因为 R698 的 18 条清单与 `ASSETS.md` 的计数以它为准。
将来若真出「叫」这个动作，加一行 `Order: '/static/audio/Woman_Order.mp3'` 即可。

`apps/client/src/audio/index.ts`：

```ts
/**
 * 音效播放（spec §7）。
 *
 * ## 三条纪律
 *
 * 1. **`uni.xxx()` 必须是直接成员调用** —— H5 发行构建靠 uni 编译器把这种直接调用改写成
 *    `@dcloudio/uni-h5` 的 import（详见 `net/storage.ts` 顶部的长注释）。
 *    已实测 `createInnerAudioContext` **确实在导出名录里**（`uni-h5.es.js:24677`），
 *    所以这里不是「dev 正常、发行版静默失效」那一类。
 * 2. **绝不抛、绝不 `console.error`**：探针有两条零容忍断言（`Runtime.exceptionThrown 为 0` /
 *    `error 级 console 为 0`）。`InnerAudioContext.play()` 返回 Promise，**无用户手势时会被拒**
 *    ⇒ 必须 `.catch(() => {})`。
 * 3. **开关/音量持久化**（spec §7）：走与 `net/storage.ts` 同一套 uni 存储，未命中是 `''`。
 */
import { CUES, type CueName } from './cues';

const KEY_MUTED = 'ftl.audio.muted';
const KEY_VOLUME = 'ftl.audio.volume';

function hasUni(): boolean {
  return typeof uni !== 'undefined';
}

let muted = false;
let volume = 1;

/** 从宿主存储读回开关与音量（牌桌挂载时调一次）。 */
export function loadAudioPrefs(): void {
  if (!hasUni()) return;
  try {
    const raw = uni.getStorageSync(KEY_MUTED);
    muted = raw === '1';
    const vol = Number(uni.getStorageSync(KEY_VOLUME));
    volume = Number.isFinite(vol) && vol > 0 ? clamp01(vol) : 1;
  } catch {
    // 配额/隐私模式：读不到就用默认（开、满音量）
  }
}

function persist(key: string, value: string): void {
  if (!hasUni()) return;
  try {
    uni.setStorageSync(key, value);
  } catch {
    // 持久化失败不应让播放失败
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  persist(KEY_MUTED, next ? '1' : '0');
  if (next) stopAll();
}

export function getVolume(): number {
  return volume;
}

export function setVolume(next: number): void {
  volume = clamp01(next);
  persist(KEY_VOLUME, String(volume));
  for (const ctx of live) {
    try {
      ctx.volume = volume;
    } catch {
      // 某些端不支持运行期改音量 ⇒ 忽略
    }
  }
}

/**
 * 音频上下文的类型。
 *
 * ⚠️ **不要用 `any`**（本片第①份的教训：`any` / `as` / 宽类型是三种「`tsc` 看不见」的逃逸口）。
 * `uni` 全局由 `@dcloudio/types` 声明（`apps/client/tsconfig.json` 的 `types` 里有它），
 * 所以 `typeof uni.createInnerAudioContext` 直接可用；若某个端的类型里没有这个方法，
 * `lint` **会报**（这正是我们要的：编译期就能发现「这个 API 在这个端不存在」）。
 */
type AudioCtx = ReturnType<typeof uni.createInnerAudioContext>;

/** 活着的播放上下文（切歌/静音时要能停掉）。 */
const live = new Set<AudioCtx>();

function stopAll(): void {
  for (const ctx of live) {
    try {
      ctx.stop();
      ctx.destroy();
    } catch {
      // 忽略
    }
  }
  live.clear();
}

/**
 * 播一条音效（一次性）。
 *
 * ⚠️ **未知 cue 名静默忽略** —— 拼错一个名字不该把牌桌打崩。
 * ⚠️ **每条音效新建一个上下文并自行销毁**：`InnerAudioContext` 不支持复用播多条；
 * 用完 `destroy()` 免得攒住音频资源（移动端有硬上限）。
 */
export function playCue(name: CueName): void {
  if (muted) return;
  const src = (CUES as Record<string, string | undefined>)[name];
  if (!src || !hasUni()) return;
  try {
    const ctx = uni.createInnerAudioContext();
    ctx.src = src;
    ctx.volume = volume;
    const done = () => {
      live.delete(ctx);
      try {
        ctx.destroy();
      } catch {
        // 忽略
      }
    };
    ctx.onEnded(done);
    ctx.onError(done);
    live.add(ctx);
    // ⚠️ 必须 catch：无用户手势时播放在浏览器里会被拒，未处理的拒绝会变成
    // 探针的 `Runtime.exceptionThrown`（零容忍）。
    void Promise.resolve(ctx.play()).catch(() => undefined);
  } catch {
    // 宿主不支持音频 ⇒ 静默降级（本仓「不得崩」的纪律）
  }
}

/** 当前 BGM（循环）。同一首重复调不会叠加。 */
let currentBgm: { src: string; ctx: AudioCtx } | null = null;

export function playBgm(src: string): void {
  if (currentBgm?.src === src) return;
  stopBgm();
  if (muted || !hasUni()) return;
  try {
    const ctx = uni.createInnerAudioContext();
    ctx.src = src;
    ctx.loop = true;
    ctx.volume = volume;
    ctx.onError(() => stopBgm());
    live.add(ctx);
    currentBgm = { src, ctx };
    void Promise.resolve(ctx.play()).catch(() => undefined);
  } catch {
    // 静默降级
  }
}

export function stopBgm(): void {
  if (!currentBgm) return;
  const { ctx } = currentBgm;
  currentBgm = null;
  live.delete(ctx);
  try {
    ctx.stop();
    ctx.destroy();
  } catch {
    // 忽略
  }
}

/**
 * 「抢 / 不抢」→ cue 名。
 *
 * ⚠️ 放在这里而不是 `useTableSound.ts`：它是**纯选择**（不碰 store），
 * 放这里可以让 `audio/` 的单测不必拉起 pinia。
 * ⚠️ `seat` 越界时回落到 Rob1 —— 宁可能听见一声不对的音，也不要静默全哑。
 */
export function cueForBid(grab: boolean, seat: number): void {
  if (!grab) {
    playCue('NoOrder');
    return;
  }
  playCue((['Rob1', 'Rob2', 'Rob3'] as const)[seat] ?? 'Rob1');
}

/** 「过牌」→ cue 名（按座位取变体）。 */
export function cueForPass(seat: number): void {
  playCue((['Buyao1', 'Buyao2', 'Buyao3'] as const)[seat] ?? 'Buyao1');
}
```

⚠️ `ctx.onEnded` / `ctx.onError` **不加可选链**：它们是 `InnerAudioContext` 的必需方法，
加了 `?.` 反而会让「这个端没有这个方法」从**编译期错误**退化成**运行期静默**。
（替身必须实现它们 —— 见 Step 2。）

- [ ] **Step 5: 跑测试 + 类型检查**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- audio
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。

- [ ] **Step 6: 实现 —— `useTableSound.ts`（视图 diff，**不是规则推断**）**

```ts
/**
 * 把牌桌的**视图变化**译成音效（spec §7）。
 *
 * ⚠️ **这里没有任何规则判定**（§12 哑终端）：所有输入都是服务端已经下发的数字/字段，
 * 本 composable 只做「与上一版比，哪个数字变了」这一件事。它推不出、也不尝试推出
 * 「这手牌合不合法」「该不该赢」。
 *
 * ⚠️ 两个来源要分清：
 *  · **视图 diff**（`cardCounts` / `lastPlayedHand` / `settlement`）—— 服务端事实；
 *  · **本地回声**（ack `code === 0`）—— 与 `table.vue` 的过牌气泡同一套机制，
 *    因为服务端**没有字段**能表达「谁刚过了牌 / 谁刚抢了」。
 */
import { watch } from 'vue';
import { useGameStore } from '../stores/game';
import { playCue } from '../audio';

/** DouZero 编码（R695）：20 = 小王、30 = 大王。本片只用来**选音效**，不做任何牌型判定。 */
const DOUZERO_LITTLE_JOKER = 20;
const DOUZERO_BIG_JOKER = 30;

export function useTableSound(): void {
  const store = useGameStore();

  /**
   * 上一版的 `cardCounts`（报单/报双看的是**跃迁**，不是当前值）。
   * ⚠️ **放在 composable 内**，不是模块级 —— 模块级会在牌桌重挂载时带着上一局的状态，
   * 于是新局第一版视图就可能误报一次「报单」。
   */
  let lastCounts: number[] | null = null;

  // ── 报单 / 报双（§6.5-2）：看 `cardCounts` 的**下降跃迁** ──
  watch(
    () => store.cardCounts.join(','),
    () => {
      const now = store.cardCounts;
      if (lastCounts) {
        now.forEach((count, seat) => {
          const before = lastCounts![seat] ?? 0;
          if (count === before) return;
          if (count === 1) playCue('Baojing1');
          else if (count === 2) playCue('Baojing2');
        });
      }
      lastCounts = [...now];
    },
    { immediate: true },
  );

  // ── 大小王单张出牌（§10 的例外）：最近一手**恰好一张**且是王 ──
  watch(
    () => store.currentVersion,
    () => {
      const cards = store.lastPlayedHand?.cards;
      if (!cards || cards.length !== 1) return;
      const r = cards[0]!.r;
      if (r === DOUZERO_LITTLE_JOKER) playCue('SingleLittleJoker');
      else if (r === DOUZERO_BIG_JOKER) playCue('SingleBigJoker');
    },
  );

  // ── 胜负：结算载荷出现 ──
  watch(
    () => store.settlement,
    (s) => {
      if (!s) return;
      /**
       * ⚠️ `SettlementResult.winner` 说的是**哪一方赢**（`'landlord' | 'farmer'`），
       * **不是**「我赢了没有」。要判断「我」赢没赢，只需把**两个服务端字段**对一下：
       * 我是不是地主（`landlordSeat === mySeat`）× 赢的是不是地主那一方。
       * 这不是规则计算（胜负是服务端算好的），只是**选一条音效**。
       */
      const iAmLandlord = s.landlordSeat === store.mySeat;
      const iWon = (s.winner === 'landlord') === iAmLandlord;
      playCue(iWon ? 'Win' : 'Lose');
    },
  );
}
```

⚠️ `cueForBid` / `cueForPass` **不在这里** —— 它们是纯的「事件 → cue 名」选择（不碰 store），
放在 `audio/index.ts` 里。这样 `useTableSound.ts` 只依赖 store，
而 `audio/` 层的单测**不必拉起 pinia**。

- [ ] **Step 7: 接线到 `table.vue`**

**① 挂载时载入偏好 + 起 BGM**（放在既有 `startCountdown();` 附近）：

```ts
// 既有的 vue import 行加 `onUnmounted`（现在没有）：
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
// 音效：播放/选择在 `audio/`，store→cue 的接线在 `useTableSound`
import { loadAudioPrefs, playBgm, stopBgm, cueForBid, cueForPass } from '../../audio';
import { CUES } from '../../audio/cues';
import { useTableSound } from '../../composables/useTableSound';

loadAudioPrefs();
playBgm(CUES.BgmTable);
useTableSound();
```

**② 音效走 `send()` 的本地回声时机** —— 给 `send` 加第四个参数（**先读它现在的签名再改**；
现在是 `send(type, payload, localEcho = null)`）：

```ts
async function send(
  type: 'game.bid' | 'game.play' | 'game.pass',
  payload: unknown,
  localEcho: string | null = null,
  /**
   * 音效的**本地回声**：与 `localEcho` **同一时机**（ack `code === 0`）、**同一理由**
   * —— 服务端没有字段能表达「谁刚抢了 / 谁刚过了牌」，所以只能在服务端确认之后由本地播。
   * ⚠️ 只在 `code === 0` 之后调；被拒（非 0）**不出声**（与气泡同一纪律）。
   */
  cue: (() => void) | null = null,
) {
```

在 `send` 里，**`localEcho` 那一行之后**加：

```ts
    if (localEcho !== null) bubble.value = { seat: store.mySeat ?? 0, text: localEcho };
    if (cue !== null) cue();
```

两个调用点补上（**其余一个字不动**）：

```ts
function bid(grab: boolean) {
  /** 本地回声：只有「不抢」需要说（抢成功与否由服务端视图表达）。音效同理。 */
  void send('game.bid', { grab }, grab ? null : '不抢', () => cueForBid(grab, store.mySeat ?? 0));
}
```

```ts
function pass() {
  /** 本地回声：过牌的服务端事实是「什么都没发生」⇒ 只能由本地在 ack 0 之后说「不出」。 */
  void send('game.pass', {}, '不出', () => cueForPass(store.mySeat ?? 0));
}
```

**③ 离开牌桌时停 BGM**（`onUnmounted`，否则返回大厅后牌桌 BGM 还在响）：

```ts
onUnmounted(() => stopBgm());
```

**④ 大厅也一样起 BGM**（否则 `CUES.BgmLobby` 会是一条**没有调用点的死条目**，R377 的老毛病）：

`lobby.vue` 的 `<script setup>` 里：

```ts
import { loadAudioPrefs, playBgm, stopBgm } from '../../audio';
import { CUES } from '../../audio/cues';

loadAudioPrefs();
playBgm(CUES.BgmLobby);
onUnmounted(() => stopBgm());
```

（`onUnmounted` 若未 import，一并加上。）
`playBgm` 自身会先 `stopBgm()` 再换曲 ⇒ 大厅→牌桌的切换不会叠放两首。

⚠️ **切曲不要跨页面做**：每个页面只管**自己**的 BGM 与**自己**的卸载 ——
不要在 `auth.navigate` 里塞音频逻辑（页面栈是 `auth.page` 的唯一真源，音频跟着挂载/卸载走）。

跑一遍大厅的用例确认没被带红：

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-ux lobby-modes ui-flow
```

- [ ] **Step 8: §6.5-2 的视觉预警（座位剩 1–2 张）**

`Seat.vue` 的 `.seat__count` 加一个警示档：

```html
    <text class="seat__count" :class="{ 'seat__count--warn': cardCount > 0 && cardCount <= 2 }">
      剩 {{ cardCount }} 张
    </text>
```

```scss
/** §6.5-2：报单/报双预警。数据现成（服务端 `cardCounts`），零协议改动。 */
.seat__count--warn {
  color: $ftl-color-danger;
}
```

判据加进 `table-seat-geometry.test.ts`：

```ts
  it('§6.5-2：剩 1–2 张时座位张数带预警档（报单/报双）', () => {
    const wrapper = mountTable({ cardCounts: [17, 2, 1], landlordSeat: 0, mySeat: 0 });
    const warned = wrapper.findAll('.seat__count--warn');
    expect(warned, '两家剩 ≤2 张 ⇒ 两个预警').toHaveLength(2);
    wrapper.unmount();
  });
```

（`mountTable` 的夹具参数以实际文件为准。）

- [ ] **Step 9: 跑测试 + 全门禁 + 探针**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 全绿，**且探针的 `Runtime.exceptionThrown 为 0` / `error 级 console 为 0` 两条必须绿**
（这是音效层最可能弄红的两条）。若红了 —— 那是 `play()` 的拒绝没被吞掉，回去补 `.catch`。

**人工走查**：进牌桌**真的听到** BGM；叫抢/过牌/报单有对应声音；浏览器控制台**没有**音频相关报错。

- [ ] **Step 10: 提交**

```bash
cd /d/Code/pokergame
git add scripts/transcode-audio.mjs apps/client/src/audio apps/client/src/composables/useTableSound.ts \
        apps/client/src/pages/table/table.vue apps/client/src/pages/lobby/lobby.vue \
        apps/client/src/components/Seat.vue \
        apps/client/test/audio.test.ts apps/client/test/helpers/uni-stub.ts \
        apps/client/test/table-seat-geometry.test.ts apps/client/src/static/audio
git commit -m "$(cat <<'EOF'
feat(client): 音效接入 + 报单/报双预警（R698/U4/§6.5-2）

Task 6/8：
- transcode-audio.mjs：ogg→mp3（系统 ffmpeg，不进依赖，幂等）
  实测源 ogg 只有 65–72kbps ⇒ 按 U4 全保留 5 条 BGM，BGM 64k/SFX 96k = 1456KiB
  转码的真实理由是**兼容性**：OGG/Vorbis 在 iOS WKWebView 上不能播
- audio/index.ts：playCue/playBgm + 开关音量持久化；play() 的拒绝必须吞掉
  （探针有 Runtime.exceptionThrown 为 0 与 error console 为 0 两条零容忍断言）
- useTableSound.ts：只做视图 diff + ack 本地回声，**零规则判定**
- BGM：大厅 MusicEx_Welcome / 牌桌 MusicEx_Normal，各自挂载起、卸载停
  （切曲不跨页面做 —— 音频跟页面挂载/卸载走）
- Woman_100/200（大小王单张）依 spec §10 的例外一并做
- §6.5-2：剩 1–2 张的视觉预警 + 报单报双音效
- Woman_Order 入库但**不进 CUES**（我方只有抢/不抢，无调用点；进去就是死条目）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 动效（§8）

**Files:**
- Create: `apps/client/src/styles/animations.scss`
- Modify: `apps/client/src/components/Hand.vue`、`PlayArea.vue`、`BottomCards.vue`、`Settlement.vue`
- Create: `apps/client/test/animations.test.ts`

**Interfaces:**
- Consumes: 参考拆解报告 §1 的「动效清单」逐条数值
- Produces: `.anim-*` 工具类 + `prefers-reduced-motion` 降级

### ⚠️ 三条硬约束

1. **`prefers-reduced-motion` 降级是 spec §8 的「必须」**（不是可选项），参考实现有现成形态。
2. **动效不得改变判据**：动画是纯 CSS，**不得**引入 JS 定时器改状态（`table.vue` 的注释有明文纪律：
   「不引入任何本地计时器」）。发牌错峰用**内联 `--delay` 变量**，不用 `setTimeout`。
3. **mp 端不做适配**（R701）⇒ 动效只需 H5 + App 可用。⚠️ 但 `animation` 在失败时**不得让元素永久不可见**
   （`animation-fill-mode: both` + 起始 `opacity: 0` 的组合在某些端不回落 ⇒ **兜底要写 `opacity: 1` 的默认态**）。

---

- [ ] **Step 1: 写失败的测试**

创建 `apps/client/test/animations.test.ts`：

```ts
/**
 * §8 动效的**机械闸**。
 *
 * ⚠️ 判据射程（诚实版）：jsdom 不注入 CSS、不跑动画 ⇒ 这里**不证明**动效好看或流畅。
 * 它只钉三件会**静默失效**的事：
 *  ① `prefers-reduced-motion` 降级**存在**（spec §8 的「必须」）；
 *  ② 动效不用 `setTimeout`/`setInterval`（§9.6 同族的「不新造时钟」纪律）；
 *  ③ 起始态是「可见」的 —— 否则动画一旦不跑，元素就永久隐形（比不动效更糟）。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
const anim = sources.find((f) => f.path === 'src/styles/animations.scss');

describe('§8 动效', () => {
  it('animations.scss 存在且定义了 reduced-motion 降级（spec §8 的「必须」）', () => {
    expect(anim, 'src/styles/animations.scss 必须存在').toBeDefined();
    expect(anim!.content).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(anim!.content, '降级里必须关掉 animation').toMatch(/animation:\s*none/);
  });

  it('animations.scss 里没有裸十六进制色值（token 纪律）', () => {
    const code = stripComments(anim!.content);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('动效不新造时钟：牌桌区源码里没有 setTimeout/setInterval', () => {
    // ⚠️ 本仓**已有一条**同类判据（`table-bid-ui.test.ts` 的 `TIMER_TRACES`），
    //    但它只扫 `TABLE_AREA` 那 8 个文件。本条的扫描面**更大**
    //    （`src/components/**` + `src/pages/table/**`），额外覆盖 `Settlement.vue` 与
    //    本片新增的 `Panel.vue` —— 是**扩大覆盖**，不是重复。
    const offenders = sources
      .filter((f) => f.path.startsWith('src/components/') || f.path.startsWith('src/pages/table/'))
      .filter((f) => /\bset(Timeout|Interval)\s*\(/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(offenders, `牌桌区不得新造时钟（§9.6）：${offenders.join(', ')}`).toEqual([]);
  });

  it('降级块本身不是空壳（正反对照：合成样本必须被判到）', () => {
    const has = (src: string) => /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/.test(src);
    expect(has('@media (prefers-reduced-motion: reduce) { .x { animation: none !important; } }')).toBe(true);
    expect(has('.x { animation: foo 1s; }')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- animations
```

Expected: FAIL（文件不存在）。

- [ ] **Step 3: 实现 `styles/animations.scss`**

照拆解报告 §1 的清单，统一 `cubic-bezier(.22,1,.36,1)`、`animation-fill-mode: both`、内联 `--ftl-delay` 错峰：

```scss
/**
 * §8 动效。数值逐条照 `docs/superpowers/specs/2026-09-18-reference-ui-teardown.md` §1 的清单。
 *
 * ⚠️ **本文件只能被组件 `@use`**，绝不能进 `src/uni.scss` —— 后者是 token 文件，
 * uni-app CLI 会把它的内容**前置到每一个 scss 块**（见 `uni.scss` 顶部注释），
 * 往里放选择器会让每个组件的样式里都重复一遍这段 CSS。
 *
 * ⚠️ **起始态必须可见**：全部动画从 `opacity: 0` 之外的角度/位移起手，
 * 或显式给出非动画的默认 `opacity: 1` —— 动画一旦不被执行（老端/降级），
 * 元素**不能**永久隐形。那比不动效糟得多。
 *
 * ⚠️ **零 JS 定时器**：错峰靠内联 `--ftl-delay`（`style="--ftl-delay: 35ms"`），
 * 不用 `setTimeout`（牌桌区的「不新造时钟」纪律，§9.6 同族）。
 */
$ftl-ease: cubic-bezier(.22, 1, .36, 1);

/// 发牌落入。参考：`ddz-deal-in .36s`，错峰 `min(i,12)*35ms`。
@keyframes ftl-deal-in {
  from { transform: translateY(-18rpx) rotate(-3deg) scale(.92); }
  to   { transform: none; }
}
/// 出牌入场。参考：`ddz-played-in .24s`，错峰 `i*35ms`。
@keyframes ftl-played-in {
  from { transform: translateY(8rpx) scale(.94); }
  to   { transform: none; }
}
/// 底牌揭示（翻牌）。参考：每张 `.46s rotateY(90deg)`。
@keyframes ftl-reveal-in {
  from { transform: rotateY(90deg); }
  to   { transform: none; }
}
/// 结算弹窗。参考：卡片 `.24s`（`translateY(10px) scale(.985)`）。
@keyframes ftl-settlement-in {
  from { transform: translateY(10rpx) scale(.985); }
  to   { transform: none; }
}
/// 气泡。参考：`.22s`。
@keyframes ftl-toast-in {
  from { transform: translateY(-6rpx); }
  to   { transform: none; }
}

.anim-deal-in {
  animation: ftl-deal-in .36s $ftl-ease both;
  animation-delay: var(--ftl-delay, 0ms);
}
.anim-played-in {
  animation: ftl-played-in .24s $ftl-ease both;
  animation-delay: var(--ftl-delay, 0ms);
}
.anim-reveal-in {
  animation: ftl-reveal-in .46s $ftl-ease both;
  animation-delay: var(--ftl-delay, 0ms);
  perspective: 600rpx;
}
.anim-settlement-in { animation: ftl-settlement-in .24s $ftl-ease both; }
.anim-toast-in { animation: ftl-toast-in .22s $ftl-ease both; }

/**
 * spec §8 的「**必须**」：`prefers-reduced-motion` 降级。
 * 参考实现 `:361` 的形态（`transition: none` + 一长串 `animation: none !important`）。
 * ⚠️ 只关动画，**不**改任何布局/可见性 —— 降级后元素仍在原位、仍然可见。
 */
@media (prefers-reduced-motion: reduce) {
  .anim-deal-in,
  .anim-played-in,
  .anim-reveal-in,
  .anim-settlement-in,
  .anim-toast-in {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
```

- [ ] **Step 4: 接到四个组件**

`Hand.vue` / `PlayArea.vue` / `BottomCards.vue` / `Settlement.vue` 各在 `<style>` **最顶部** `@use`：

```scss
@use '../styles/animations.scss';
```

⚠️ **不加 `as` 别名**：`@use` 的命名空间只管 SCSS 的**成员**（变量/mixin/函数），
本文件里只有**纯 CSS 规则** —— `@use` 会把它们照常输出到本组件的样式里。
加一个用不上的别名只会让读的人以为有别的东西在里面。

⚠️ **`@use` 必须在样式块的最前**（Sass 硬要求），且 `Hand.vue` 等文件里已有 `$ftl-*` 的用法 ——
那些来自 uni-app 注入的 `uni.scss`（`additionalData`），与 `@use` 不冲突。

⚠️ **scoped 样式的射程**：`.anim-deal-in` 定义在 `Hand.vue` 的 scoped 块里 ⇒ 编译后带上
`Hand.vue` 的 scope 属性。挂在**子组件根节点**（`<Card>`）上时仍然生效
（Vue 的 scoped 规则会作用到子组件根节点）—— 这正是这里需要的行为，**不要**把类挂到
`Card` 内部更深层的元素上。

并在模板里挂类 + 内联错峰（**下限封顶**，否则 20 张牌会等 700ms）：

```html
<!-- Hand.vue：错峰上限 12（参考实现同款 `min(i,12)*35ms`） -->
<Card
  v-for="(index, i) in order"
  :key="`${cards[index]!.r}-${cards[index]!.s}-${index}`"
  class="anim-deal-in"
  :style="{ '--ftl-delay': `${Math.min(i, 12) * 35}ms` }"
  ...
/>
```

⚠️ `PlayArea` 用 `anim-played-in`、`BottomCards` 的已翻开分支用 `anim-reveal-in`、
`Settlement` 根节点用 `anim-settlement-in`。
⚠️ **`Hand.vue` 加 `v-for` 的第二个参数 `i`** —— 既有 `v-for="index in order"` 只有一个变量，
改成 `v-for="(index, i) in order"`。**不要**因此改动 `order` 的语义（它仍返回原始下标）。

- [ ] **Step 5: 跑测试 + 真浏览器走查**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 全绿。

**人工走查**：① 进牌桌手牌**错峰落**；② 出牌后出牌区有入场；③ 底牌翻开有翻转；
④ 结算弹窗有入场；⑤ 系统开「减少动态效果」后**全部瞬时出现、元素仍然可见**
（这一条是 spec §8 的必须项，必须真的开一次系统设置验）。

- [ ] **Step 6: 提交**

```bash
cd /d/Code/pokergame
git add apps/client/src/styles apps/client/src/components/Hand.vue apps/client/src/components/PlayArea.vue \
        apps/client/src/components/BottomCards.vue apps/client/src/components/Settlement.vue \
        apps/client/test/animations.test.ts
git commit -m "$(cat <<'EOF'
feat(client): §8 动效 + prefers-reduced-motion 降级

Task 7/8：
- styles/animations.scss：发牌落入/出牌入场/底牌揭示/结算弹窗/气泡
  数值逐条照拆解报告 §1；统一 cubic-bezier(.22,1,.36,1)
- 错峰用内联 --ftl-delay，**零 JS 定时器**（牌桌区「不新造时钟」纪律）
- prefers-reduced-motion 降级（spec §8 的「必须」）；只关动画、不改布局/可见性
- 不进 uni.scss：它是 token 文件，内容会被前置到每个 scss 块

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 文档收口 + 全门禁 + 清单复核

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md`（§7-① 与 §1 硬边界）
- Modify: `docs/superpowers/plans/agent-briefs.md`（三端纪律 → H5 + App；过期的「待确认 (甲)/(乙)」）
- Modify: `apps/client/test/table-play-ui.test.ts`（过时注释 `.table__middle`）
- Modify: `apps/client/src/static/ASSETS.md`（回填 spike 实测结果）

**Interfaces:**
- Consumes: 前 7 个 task 的全部产出
- Produces: 本片的收口记录

---

- [ ] **Step 1: `2026-09-17-game-ui-redesign-design.md` §7-① 改为素材版**

§7 的表格第 1 行现在写的是「**CSS + 令牌 + view/text 形状**的**简约纸牌风**」，那是**没有素材**时的权宜。
逐字替换该单元格的「推荐」列：

```
**已有素材（R688 授权）**：牌面走 `static/cards/` 的真卡图（80×104）+ `manifest.json` 映射（R702）；
底纹/头像/面板/按钮走 `static/{ui,av}/`；音效走 `static/audio/`（mp3，R698）。
⚠️ **有素材 ≠ 放弃机械验收**：体积预算闸（`test/asset-budget.test.ts`）、
`ui-tokens`（令牌/rpx）、`source-boundary`（F10：牌面文字只能来自 `toDisplay`）一律照旧。
```

- [ ] **Step 2: 该 spec 的 §1 硬边界加素材条款**

在 §1 的 8 条后面**追加第 9 条**：

```markdown
9. **素材边界**：界面素材**只能**来自 `apps/client/src/static/`（`cards/` `av/` `ui/` `audio/`）。
   ① 来源与授权必须逐类登记在 `static/ASSETS.md`；
   ② 体积受 `apps/client/test/asset-budget.test.ts` 的预算闸约束；
   ③ 牌面映射是**数据**（`static/cards/manifest.json`，R702），**不是**代码 ——
      且它只是「资源名 ↔ 展示图片」，**不得**被当成「点数 → 牌面文字」的映射使用
      （后者由 `protocol.toDisplay()` 唯一提供，`source-boundary` 有闸）；
   ④ `resources/` 是**源素材库、不进版本库**（R703）。
```

- [ ] **Step 3: `agent-briefs.md` 的三端纪律与过期状态**

① **过期的「待确认 (甲)/(乙)」**（约 `:224-225`）——第①份早已裁决为 **(乙)** 并执行完毕，且 R701 已把小程序排除。
把那两行里「**待用户确认的唯一契约问题** = 花色协议的 (甲)…还是 (乙)…」整句**删掉**，替换为：

```
★ **花色片已全部执行完毕**：①协议侧（R695–R697，8 Task，merge `d70977a`）·
②素材/观感侧（R700 的第②份，本片）。两者的真实记录见各自的改动面清单与 `git log`。
**口径**：范围 = **H5 + App**（R701）；小程序端代码保留冻结、**不入任何门禁**。
```

② **三端纪律 → H5 + App**：全文件把「三端」在**纪律/门禁/测试**语境下的用法改为「H5 + App」，
并在文件头部加一条口径说明：

```
> ⚠️ **口径（R701，2026-09-20）**：范围 = **H5 + App**。小程序端（`mp-weixin`）排除在
> **一切设计/开发/测试**之外：代码保留冻结、不删、不入任何门禁、不为其写用例。
> 文中历史记录里的「三端」指的是当时的口径（H5 + 小程序 + App），**不改写历史**；
> 但**新写**的纪律一律只讲 H5 + App。
```

⚠️ **不要把历史记录里的「三端」逐条改写** —— 那些是当时的实测事实，改写等于篡改台账。**只改**「下一步 / 纪律」这类**面向未来**的条目。

- [ ] **Step 4: 顺手订正一处过时注释**

`table-play-ui.test.ts:97` 的注释引用了 `.table__middle` —— **该 class 在 `src/` 里根本不存在**
（今天是 `.table__play-area`）。逐字改成 `.table__play-area`。这是注释与代码不一致，属于静默过期。

- [ ] **Step 5: 回填 `ASSETS.md` 的 spike 实测结果**

把 `ASSETS.md` §4 那张表的 ☐ 逐条改成实测值（**必须是真跑过的输出，不是「应该如此」**）。

- [ ] **Step 6: 全门禁（**独占跑，逐条记录实测值**）**

```bash
cd /d/Code/pokergame

# ① 全仓 ci 六阶段
pnpm run ci

# ② 逐端 build（⚠️ turbo build 对 client 只出 h5 ⇒ App 必须单独跑）
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app

# ③ 客户端单测（记录 passed / skipped）
pnpm --filter @fight-the-landlord/client test

# ④ 探针（独占：8 容器 healthy + DEL ratelimit:ws-conn:::ffff:172.19.0.1 + 清残留 vite）
node scripts/browser-e2e.mjs --scenario gate
```

Expected: 全绿。**逐条记录实测数字**（不要只写「通过」）。

⚠️ **证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
⚠️ **探针独占**：`kill -TERM -<pgid>`，**禁止** `pkill -f vite`。

- [ ] **Step 7: 复核（本片的方法论闭环）**

逐条回答并落盘到本计划末尾的「执行期发现」段：

- [ ] ① 每个 task 的判据都跑过且**记录的是实测输出**（不是「应该如此」）？
- [ ] ② **代码与文档同一个 PR**（没有留下「代码改了、文档还写着旧口径」）？
- [ ] ③ `grep -rn "新造时钟\|setTimeout" apps/client/src/components apps/client/src/pages/table` —— 牌桌区零命中？
- [ ] ④ **观感类改动都有真浏览器/App 走查记录**（spec §9.2-7：**没有造假判据**）？
- [ ] ⑤ 9 个探针 class **一个没改**？`scripts/browser-e2e.mjs` **零改动**？
- [ ] ⑥ 8 个契约测试的字面 `it(`/`it.each(` 计数 **≥ 65**（只增不减）？

- [ ] **Step 8: 提交**

```bash
cd /d/Code/pokergame
git add docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md \
        docs/superpowers/plans/agent-briefs.md \
        apps/client/test/table-play-ui.test.ts \
        apps/client/src/static/ASSETS.md \
        docs/superpowers/plans/2026-09-21-suit-assets-side.md
git commit -m "$(cat <<'EOF'
docs(assets): 文档收口 + 全门禁（Task 8/8）

- ui-redesign spec §7-① 改为素材版；§1 加第 9 条素材边界
- agent-briefs 的「待确认 (甲)/(乙)」过期条目删除；口径改 H5 + App（R701）
  ⚠️ 历史记录里的「三端」**不改写**（那是当时的实测事实）
- table-play-ui 的过时注释（.table__middle → .table__play-area）
- ASSETS.md 回填 spike 实测结果

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 执行期发现

> 格式：**现象 → 根因 → 被什么抓住 → 修法**。
> 本片共 **9 条**，其中 3 条是**计划里的代码/规定本身不对**（照抄会红或会假绿）。

### F1（计划自身的缺陷）· `verify-asset-paths.mjs` 第一版是**假绿**

**现象**：脚本按「扫产物里的完整 `/static/...` URL」写，跑出来 **0 命中**，
而判据 0 是「零命中 ⇒ 报错退出」——如果当初写的是「零命中 ⇒ 通过」，它就是一条恒绿的闸。

**根因**：**牌面 URL 是运行期拼的**（`Card.vue` 发 `` `/static/cards/${file}` ``，`file` 来自
被 `import` 进包的 `manifest.json`）⇒ 产物里**根本没有** `/static/cards/SpadeThree.png`
这个完整字面量。CSS 的 `url()` 与静态字符串才有字面量。

**修法**：拆两条腿 —— **字面量腿**（CSS url / 静态字符串）+ **清单腿**
（manifest 的每个值逐个绑回产物文件）。判别力自证：改名一张牌面 ⇒ 清单腿报出。

### F2（计划自身的缺陷）· `asset-budget.test.ts` 的牌码计数会算成 52

**现象**：计划里的 `faces` 过滤器写的是「`r < 20 || k.startsWith('4-')`」，
而 `expected` 由 4 花色 × 15 个 DouZero 值生成 —— 那会算出 **52** 而不是 54
（`4-20`/`4-30` 根本不在 `expected` 里，两个王的键永远选不出来）。

**修法**：直接按 **4 花色 × 13 点数（3–14 + 17）+ 两张王** 构造 `FACE_KEYS`，
并**先断言「基数恰好 54」**——把「54 这个数本身」也钉住。

### F3（计划自身的缺陷）· `new URL('.', import.meta.url)` 在 jsdom 里抛

**现象**：`fileURLToPath(new URL('.', import.meta.url))` → `TypeError: The URL must be of
scheme file`。**第一次「红」证明因此是无效的**（红的原因是 URL 而不是缺文件）。

**根因**：本仓 vitest 跑在 jsdom 里，那里 `import.meta.url` 不是 `file://` URL。
`test/helpers/source-scan.ts` 能这么做，是因为它是被 **import 的 helper** 而不是 test 文件。

**修法**：复用 `source-scan` 导出的 `SRC_ROOT`。**并在修好后重做了一次红证明**。

### F4 · 夹具给王的 `s = 0`，而真实发牌是 `s = 4`

**现象**：`makeCards` 逐张递增花色，**王也走这条** ⇒ `{r: 30, s: 0}`。

**根因**：真实 `createDeck()` 给两张王都是 `s = Suit.Joker = 4`（`shared/src/card/card.ts:69-70`），
而 `protocol/validate.ts` **只校验 `s ∈ 0..4`、不交叉校验 `(r, s)`** ⇒ 这个不真实的形态
**静默通过了所有闸**（第①份也没抓到）。

**后果（接入牌面后才显现）**：`{r: 30, s: 0}` 在 `manifest.json` 里**查不到**
（王的键只有 `4-20`/`4-30`）⇒ 王走文本兜底 ⇒ 页面级「王渲染真牌面图」**根本测不到**。

**修法**：`makeCards` 对 `r ∈ {20, 30}` 直接给 `s = 4`，并写清理由。

### F5 · 静态资源路径 spike 的结果（spec §6.2.3 要求的那个「最容易白干一天的坑」）

**结论：`/static/<类>/<文件>` 三处都成立。** 详见 `src/static/ASSETS.md` 的 spike 结果表。

**一条实测发现（spec 未提）**：**CSS 里的 `url('/static/...')` 每次构建会告警**
（`didn't resolve at build time, it will remain unchanged to be resolved at runtime`），
而**模板里的 `:src="/static/..."`（JS 字符串）无告警**。两者**产物都正确**
（Vite 的文档行为就是「保持原样、运行时解析」），告警**不是错误**、
**不影响**探针的 `error 级 console 为 0`（那条查的是浏览器控制台，不是构建输出）。
本片最终有 **13 条**这类构建告警（每个 `@include ftl-btn` 的组件各一条）。

### F6 · **组件里不能用 `@use`**（构建期直接失败）

**现象**：`[sass] @use rules must be written before any other rules.` + `Build failed`。

**根因**：uni-app 把 `src/uni.scss` 的**全部内容**（含一个 `@mixin ftl-btn`）
**前置**到每一个 scss 块（`additionalData`），而 Sass 要求 `@use` 出现在**任何规则之前**
⇒ **本仓的组件样式里 `@use` 结构上不可能可用**。

**修法**：改用 `@import`（无位置约束）。已写进 `animations.scss` 与四个组件的注释。

### F7 · 现有的「单根闸」抓到了我自己

**现象**：把 `Settlement.vue` 的根从 `wd-card` 换成 `Panel` 时，我把一段解释写在
`<Panel>` **之前** ⇒ SFC 变多根 ⇒ `table-hud.test.ts` 的单根闸当场红：
`expected [] to include 'table__settlement'`。

**意义**：这正是 R681 描述的形态（模板注释放根前 ⇒ `classes()` 静默返回 `[]`）。
**闸有判别力**，不是摆设。修法：注释挪回根元素内部，并把这次自证写进注释。

### F8 · 音效的码率账（U4 的落地）

源 ogg 本身只有 **65–72 kbps**（已高度压缩）⇒ 96k 转出来 **1749 KiB**（比源 1476 KiB 还大）。
按 U4 定为 **BGM 64k mono / SFX 96k mono = 1457 KiB**（≈ 源，与源同质），预算 **1536 KiB**。
**转码的真实理由是兼容性**：OGG/Vorbis 在 iOS WKWebView 上不能播 —— 这条 spec 没写。

### F9 · 真浏览器探针：**能跑**（我一开始误判成跑不了），但它**看不见素材加载失败**

> ⚠️ **本条订正过一次**：初版 F9 写的是「探针在本机无法执行（环境限制）」，**那是错的**。
> 根因是我**没读这台机器的既有记忆**（`windows-dev-env-quirks` 第 6 条，
> **2026-09-21 当天**刚记下）—— 它已经写明 ③ 的根因与绕法。
> 记在这里当教训：**`WSAEACCES` 不等于「环境不允许」，先去查本机保留端口区间。**

**三条坎（前两条是探针自身的可移植性问题，第三条是 Windows 的保留端口区间）**：

| # | 现象 | 根因 | 绕法 |
|---|---|---|---|
| 1 | `Error: spawn pnpm ENOENT` | Windows 下 `pnpm` 是 `.cmd`，探针 spawn 不带 `shell: true` | 自己起 dev server + `--no-server` |
| 2 | `找不到 chromium（设 CHROME_BIN…）` | 探针只找 Unix 路径 `~/.cache/ms-playwright` 与 PATH 上的 `chromium`/`google-chrome` | 设 `CHROME_BIN` 到 `~/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe` |
| 3 | `bind() returned an error … (0x271D)` + `Cannot start http server for devtools.` | **`CDP_PORT = 9333` 落在 Windows 保留区间 `9272–9371`**（Hyper-V/Docker 占用）。⚠️ 探针用法示例里建议的 `--cdp-port 9444` **也落在 `9372–9471`**，同样失败 | **`--cdp-port 18800`** |

**实测可用的命令**（探针 **16/16**）：

```bash
cd apps/client && pnpm dev &                                   # 1) 自己起 dev server
CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe' \
  node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

查本机保留区间：`netsh int ipv4 show excludedportrange protocol=tcp`。

#### 🔴 但探针**不能**证明素材真的加载了（本条是**实测**，不是推断）

我做了**判别力自证**：把牌桌底纹 `static/ui/new_BJ.png` **临时移走**（它由 CSS 引用、必然请求），
再跑一次探针 —— **结果仍是 16/16 全绿**。

⇒ `全程 error 级 console 为 0`（`:675`）**盖不住网络 404**：探针抓的是
`Runtime.consoleAPICalled` 的 `error`，而资源加载失败走的是 `Log.entryAdded`。
**这正是本仓说的「判据存在 ≠ 判据有效」。**

**推论（本片验证状态的诚实结论）**：

| 问题 | 被什么覆盖 | 状态 |
|---|---|---|
| 代码指向的路径 ⇔ 文件真的存在 | `asset-budget.test.ts` + `verify-asset-paths.mjs` | ✅ **有判据且判别力已自证**（改名一张牌面 ⇒ 清单腿报出） |
| 真浏览器里页面能跑通（注册→匹配→牌桌 17 张牌） | 探针判据 1–14 | ✅ **16/16 实测通过** |
| 音频层不抛异常、不污染 console | 探针判据 15–16 | ✅ 实测（且替身的 `play()` 故意返回被拒 Promise，单测里也钉了） |
| **牌面图真的被浏览器画出来了** | —— | ❌ **无判据**（探针数的是 `.card` 元素，不是 `naturalWidth > 0`） |
| **九宫格圆角有没有切坏 / 动效观感 / 声音好不好听** | —— | ❌ **无判据**（纯观感，jsdom 与探针都看不见） |

⇒ 上述 ❌ 三行**需要人眼**（真浏览器或真机）。**没有为它们编造替代判据**（spec §9.2-7）。

---

### F10 · 🔴 **合片之后才发现的真缺口：`CardBack.png` 入库了但没有任何地方渲染它**

**这是用户 2026-09-21 问「还有哪些 UI 是 CSS 代替的」时查出来的，不在原计划内。**

**现象**：牌背**一直是 CSS 斜纹画的**（`Card.vue` 的 `repeating-linear-gradient`），
而 `CardBack.png`（14,202 B）**已入库、已在 `manifest.json` 里、还被 `asset-budget` 闸断言「存在」**。

**根因**：`faceSrc` 写的是 `if (props.faceDown) return '';` —— 牌背**从来没查过表**。
（原计划 Task 2 的写法就是把 `faceDown` 排除在图片路径之外，我当时没意识到
「牌背也是一种牌面」。）

**为什么所有闸都没抓住它**（这一条比缺口本身更重要）：

| 闸 | 为什么沉默 |
|---|---|
| `asset-budget` 的覆盖性 | 它断言「manifest 的每个值**文件在**」—— `CardBack.png` **确实在**。**「文件在」不等于「文件被用」** |
| `asset-budget` 的无孤儿 | 它断言「每个 PNG **都被 manifest 引用**」—— `CardBack` **确实被引用了**（被那份没人读的表） |
| `verify-asset-paths` | 它断言「产物里 URL ⇔ 文件」—— 但**这个 URL 根本没人发** |
| 判据迁移那批 | 它们断言「牌背**无文字、无 data-value、不 emit**」—— 全都成立，因为 CSS 斜纹也满足 |
| 真浏览器探针 | 数的是 `.card` **元素**，不看它里面是什么 |

⇒ **五道闸全绿，而牌背从来没显示过那张图。** 与 F1（字面量腿假绿）、F9（探针盖不住 404）
是同一族：**判据测的是「东西在不在」，不是「东西有没有被用」。**

**修法**（2026-09-21，合片后单独提交）：
1. `faceSrc` 在 `faceDown` 时返回 `manifest.back`；
2. **迁移**旧判据（它断言的是「面朝下**不渲染图**」= 描述实现，不是意图）→
   改成断言「渲染的是**牌背图**」+ 一个「朝向真的换了图」的正对照；
3. 新增一条**防过度清理**的判据：`repeating-linear-gradient` 必须留着
   —— 它是图加载失败时的兜底（删了图一缺，牌背就是一片空白）。

**未修的相关项（用户暂缓）**：`btn3.png`（零引用）、`Panel` 的 `orange` 变体（无调用点）。
⇒ 若要根治这一类，需要一个「**每份素材都必须有消费者，或在显式储备清单里**」的闸；
但 `static/{ui,av}/` 的 URL 是静态字面量、可机械判，而牌面走 manifest 数据 ⇒ 规则得分开写。
**这是本片留下的、值得单独立条的方法论缺口。**

## 计划外新增（执行期产物）

| 文件 | 为什么需要 |
|---|---|
| `scripts/verify-asset-paths.mjs` | 观感走查被环境挡住（F9）后，把「产物里的路径 ⇔ 文件」这部分**机械化**了。它**不能**替代走查（F1 的注释里写明了差别） |

---

## 合片之后的追加修复（2026-09-21）

> 用户问「还有哪些 UI 是用 CSS 代替的」时查出来的，**不在原计划内**。
> 见 **F10**：`CardBack.png` 入库了但没有任何地方渲染它 —— 而**五道闸全绿**。

| 提交 | 内容 |
|---|---|
| `Card.vue` | `faceSrc` 在 `faceDown` 时返回 `manifest.back`（牌背走真卡图）；CSS 斜纹降为**加载失败的兜底** |
| `card-hand-interaction.test.ts` | **判据迁移**：旧断言「面朝下不渲染图」描述的是实现、不是意图（旧实现是 CSS 斜纹）⇒ 改成「渲染的是**牌背图**」+ 正对照；另加一条**防过度清理**的判据（CSS 纹样必须留着） |
| `ASSETS.md` | 登记牌背的渲染方式与兜底 |

**未修（用户暂缓）**：`btn3.png`（零引用）、`Panel` 的 `orange` 变体（无调用点）。
根治需要一条「**每份素材都必须有消费者，或在显式储备清单里**」的闸（F10 末尾分析了它的形态）。

---

## 复核（Task 8 Step 7 的逐条结果，**实测值**）

| # | 项 | 结果 |
|---|---|---|
| ① | 每个 task 的判据都跑过且记录的是**实测输出** | ✅ 每个 task 的 commit message 里都是实测数字（用例数 / 产物 CSS 实测值） |
| ② | **代码与文档同一个 PR** | ✅ Task 8 的 commit 含 3 份文档 + 1 处测试注释 |
| ③ | 牌桌区零 `setTimeout`/`setInterval` | ✅ 新闸 `animations.test.ts` 扫描面 ≥ 既有的 `TIMER_TRACES` |
| ④ | 观感类改动都有真浏览器/App 走查 | ⚠️ **部分**：探针 **16/16 实测通过**（页面跑通、17 张牌、零异常、零 console error）；但**「图真的画出来了」与纯观感无判据** —— F9 的判别力自证证明探针**盖不住资源 404**。**没有造假判据** |
| ⑤ | 9 个探针 class 一个没改；`scripts/browser-e2e.mjs` 零改动 | ✅ `git diff` 对探针文件为空 |
| ⑥ | 8 个契约测试的字面 `it(`/`it.each(` ≥ 65 | ✅ **恰好 65**（63 + 2），与基线逐文件一致 |

### 全门禁实测（2026-09-21）

| 门禁 | 实测 |
|---|---|
| `pnpm run ci` 六阶段 | ✅ **全部通过** |
| ①install ②lint ③build | ✅ |
| ④test：api-gateway 151 · game-service 110 · user-service 44 · room-service 219 · client **462 passed + 2 skipped** | ✅ |
| ⑤coverage（shared ≥80%） | ✅ 173 passed |
| ⑥§12.4 六道源码闸 | ✅ 23 / 8 / 5 / 6 / 3 / 21 passed |
| `build:h5` | ✅ DONE（13 条 CSS url 构建告警，见 F5） |
| `build:app` | ✅ DONE |
| `node scripts/verify-asset-paths.mjs` | ✅ 23 个 URL + manifest 55 项全部有对应文件 |
| `asset-budget`（体积预算 + 覆盖性 + 无孤儿 + F10 边界） | ✅ 11 passed |
| 真浏览器探针 `--scenario gate` | ✅ **16/16 通过**（`--no-server --cdp-port 18800` + `CHROME_BIN`）。⚠️ 但它**盖不住素材加载失败**（实证见 F9 的判别力自证） |
| App 运行期走查 | ❌ 不在本片（spec §10：N39 的 App 半边另立） |



---

## 与 spec 的偏离记录

> 凡与 spec 正文不一致的，逐条记在这里并说明依据。**用户裁决不算偏离**（记在上面「用户裁决」表里）。

| # | spec 写的 | 本计划 | 依据 |
|---|---|---|---|
| D1 | §6.2.4：`audio/` ≤ 800KB，超了按 §7 从低优先级砍 | 预算 **1536 KiB**，5 条 BGM 全保留 | **用户裁决 U4**（2026-09-21） |
| D2 | §5 客户端清单：`.card--wide` 去留「在素材侧计划里表态」 | **保留** | 兜底分支（R693）的文本排版仍消费它；删了会连带删一条有意义的分类判据 |
| D3 | §6.3：「`toDisplay()` 退居 `aria-label`」+「判据迁移」 | 照做；另**保留**文本兜底分支 | R693 要求「素材缺失时回落文本牌面，避免白屏」⇒ 文本路径不能删，只能降为兜底 |
| D4 | §5：`Card.vue` 的 `value: number` 「改为传 `.r`，或让组件直接接受 `Card`」 | **都不选**：`value` 保留（点数）+ **新增 `suit`** | 真牌面图必须由 `(r, s)` 合成键查表；而 `data-value` 是 38 行/8 文件的锚点，动它风险大 |
| D5 | §6.4：9-slice 形态「在素材侧计划里定」 | 选定 **`border-image`** | 单元素、零额外 DOM、不引入定位上下文 |
| D6 | §11-2 / §3.4：`card-hand-interaction.test.ts:124` / `:157` | HEAD 实际是 **`:126`** / **`:159`** | 那两行号对应 `ea561b3`；HEAD 加了两个 commit 后漂移（子代理实测） |
| D7 | §7：大小王单张（`Woman_100/200`）「将来可先行」 | **本片就做** | 用户裁决 U4「能做的全做」；§10 明文它不在此列、不必等裁决 |
| D8 | 计划未提「产物级路径闸」 | **新增** `scripts/verify-asset-paths.mjs` | F9：观感走查被环境挡住 ⇒ 把**可机械判定**的那部分补上（**不**替代走查） |
| D9 | §9.1：每 Task 门禁含「真浏览器探针 gate」 | **跑通了**（16/16），但**只在收口时跑了一次**，没有逐 Task 跑 | 探针**独占**跑（~90s + 需 8 容器）⇒ 逐 Task 跑不现实；且它是**端到端**判据，对单个 Task 的增量没有分辨率。**观感那部分仍无判据**（F9） |
| D10 | 计划 Task 7 写「组件 `@use` animations.scss」 | 改用 **`@import`** | F6：uni.scss 被前置（含 @mixin）⇒ `@use` 结构上不可能，会**构建失败** |
| D11 | 计划里 `Hand.vue` 硬编码 `anim-deal-in` | 改成 **`enter` prop 三档** | `Hand` 被手牌区/出牌区/底牌位**三处复用**，一个硬编码的类会三处同时生效（底牌位要的是容器级翻牌） |
| D12 | 计划 Task 5 Step 6 写「默认不把 Panel 进 TABLE_AREA」 | **进了**（8 → 9） | 读了该清单的实际注释：「每新增一个牌桌组件必须 +1，不上清单 = **静默漏扫**」⇒ 登记是**扩大**扫描面的安全方向 |
