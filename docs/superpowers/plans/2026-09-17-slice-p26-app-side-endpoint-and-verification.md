# 切片 P26 Implementation Plan：N39 的 App 半边 —— App 端端点契约 + 构建入口 + 运行期验证清单

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 App 端从「被当成浏览器」里拆出来（`PlatformKind` 新增 `'app'`），让**端点必须显式绝对地址**这条规则
（R550，目前只覆盖 `mp-weixin`）**同样覆盖 App**；补上 App 的构建入口（一个参数导出两个端点 + 产物级 `require("url")` 断言）；
并把**只有用户机器能跑**的那部分（HBuilderX 运行调试 / 云打包）写成**可执行的清单**。
⚠️ **本片不写「已支持 App」**（R440 口径）—— 运行期结论只能由用户实测回填。

**Architecture:** 一条规则、两个平台：`resolveApiBase` / `resolveWsEndpoint` 的严格校验从
「`platform === 'mp-weixin'`」改成「`platform ∈ {mp-weixin, app}`」（**同一份校验、同一句报错工厂**，不复制），
H5/浏览器分支语义**逐字不变**。构建侧照抄 `scripts/build-mp-weixin.mjs` 的同形脚本（零依赖 + 一个参数 +
产物级 P19 回归闸）。运行期验证与代码改动**分开交付**：代码改动在本机可证，运行期结论留空待回填。

**Tech Stack:** Vue 3 + uni-app（Vite 5.2.8，钉死）· Vitest · 纯 Node `fs`/`path`/`child_process`（零新依赖）·
HBuilderX + DCloud 云打包（**仅用户机器**）· 8 个容器 + 真浏览器探针（标准门禁用）。

**Spec:**
- `docs/design.md` —— §1.4「各端验证状态」· §2.3 端口与端点 · §4.3 超时 · §7.1 路由 · §13.4 CI 六阶段
- `docs/superpowers/plans/2026-09-17-slice-p17-miniprogram-rest-and-endpoint.md` —— **R550/R551/R552**（本片直接复用的一组裁决）
- `docs/superpowers/plans/2026-09-17-slice-p10-uniapp-migration.md` —— `PlatformKind` 的出处 · 三端产物目录（`dist/build/{h5,mp-weixin,app}`）
- `docs/superpowers/plans/2026-09-17-slice-p19-miniprogram-url-crash.md` —— 产物级 `require("url")` 断言的出处
- `docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md` —— **B1–B4**（本片 Task 4 把它变成可执行清单）
- `apps/client/src/net/{http,transport,mp-transport}.ts` · `apps/client/src/config.ts` · `scripts/build-mp-weixin.mjs`

## Global Constraints

1. **H5/浏览器行为一字不改**（R550 逐字：H5 路径被 P9 探针与发行产物级探针压着）。
   校验只加在**新平台** `'app'` 上；`'browser'` 分支的返回值必须**逐字相同**，并有负对照单测钉住。
2. **一条规则、一个真源**：不得给 App 写第二份校验（不得复制 `if`），也不得让 REST 从 WS 变量派生 host（R550）。
3. **不猜 App 运行时的全局对象**（P17 教训 1）：`fetch` / `WebSocket` / `window.location.origin` 在 App 里**是否可用**
   ⇒ 列为**未验证项**（Task 4 的探针 + 新登记），**不得**在本片写成断言或注释里的结论。
4. **不写「已支持 App」**（R440）：`design.md` §1.4 / 台账 N39 的 App 半边在本片收口后仍是「未验证」。
5. **零新依赖**；`manifest.json` 里需要 DCloud 账号的字段（包名/证书）**只登记、不改**（本机无法验证其正确性）。
6. 派子 agent 时**禁止** `git stash` / `git reset` / `git checkout <旧 commit>` / `git switch`。

---

## 本计划要修的那个缺陷（执行者先读这一节）

`apps/client/src/net/mp-transport.ts:467` 的平台类型只有两档：

```ts
export type PlatformKind = 'browser' | 'mp-weixin';
```

而 `classifyPlatform`（`:505-514`）把 **App 折进了 `'browser'`**：

```ts
if (platform === 'web' || platform === 'h5' || platform.startsWith('app')) return 'browser';
```

于是 App 端继承了**浏览器专属的三条假设**：

| 位置 | 现象 | 为什么在 App 上必然不成立 |
|---|---|---|
| `http.ts:158-160` | `resolveApiBase` 对非 mp 平台**直接返回** `clientConfig.apiBase`（默认**相对路径** `/api`） | App 的 webview 加载的是**本地资源**，没有「同源」也没有服务器在 `/api` 上 ⇒ 请求发不出去 |
| `transport.ts:92-97` | `resolveWsEndpoint` 走 `resolveEndpoint` 的回退链：显式 → env → **`window.location.origin`** → 硬编码 `http://localhost:3000` | App 里 `location` 是 `file://…` 之类的本地地址（**不是**服务端 origin）；`localhost` 是**设备自己** ⇒ 真机必挂 |
| `package.json` 的 `build:app` = `uni build -p app` | **没有**端点注入、**没有**产物级 `require("url")` 断言 | 与小程序端 P17/P19 的缺陷**完全同形**，而 mp 已修、app 未修 |

而 `apps/client/test/mp-transport.test.ts:298`（用 `grep -n "App 端（uniPlatform=app）"` 定位）有一条**把这个假设编码进去**的用例：

```ts
it('App 端（uniPlatform=app）也走浏览器路径（App 跑在 WebView 里，浏览器 API 可用）', () => {
  for (const platform of ['app', 'app-plus', 'app-android']) {
    expect(detectPlatform(() => ({ uniPlatform: platform }))).toBe('browser');
```

⚠️ **那条用例的理由混了两件事**：`fetch`/`WebSocket` 在 App 的 webview 里**可能**确实可用（**未验证**，Global Constraint 3），
但**端点语义**（同源 / `location.origin`）在 App 上**结构上不成立** —— 后者才是本片要修的东西。
⇒ Task 1 **反转**这条用例（P21 先例：反转编码了错误行为的用例，要写清理由）。

---

## 绑定数值（开工前实测）

| 项 | 数值 | 命令 |
|---|---|---|
| 起点 commit | `4f0857a`（P24 收口） | `git log --oneline -1` |
| `PlatformKind` 的取值数 | **2**（`browser` / `mp-weixin`） | `grep -n "export type PlatformKind" apps/client/src/net/mp-transport.ts` |
| `mp-weixin` 的**出现点** | **5**（判据站点 4：`http.ts:95` `===` · `http.ts:160` `!==` · `http.ts:203` `===` · `mp-transport.ts:538` `===`；外加分类器自身 `mp-transport.ts:506`） | `grep -rn "mp-weixin'" apps/client/src` |
| App 被折进 browser 的断言位置 | `mp-transport.test.ts:298` 的「App 端（uniPlatform=app）也走浏览器路径」**1 条**用例（3 个平台字面量 `app`/`app-plus`/`app-android`） | `grep -n "App 端（uniPlatform=app）" apps/client/test/mp-transport.test.ts` |
| H5 负对照（不得改变） | `resolveApiBase('browser') === '/api'` · `resolveWsEndpoint(…, 'browser')` 原样返回 | `grep -n "'browser'" apps/client/test/http.test.ts` |
| `build:app` 现状 | `uni build -p app`（无端点注入、无产物级断言） | `node -e "console.log(require('./apps/client/package.json').scripts['build:app'])"` |
| 三端产物目录 | `apps/client/dist/build/{h5,mp-weixin,app}` | `ls apps/client/dist/build` |
| `manifest.json` 的 `app-plus.distribute` | 只有 `android.permissions=[INTERNET]`；**无 `packagename`**（云打包必需） | `node -e "console.log(JSON.stringify(require('./apps/client/src/manifest.json')['app-plus'].distribute))"` |
| 已用最大裁决号 | **R616**（P25 声明 R617–R630 ⇒ 本片从 **R631** 起） | `grep -rhoE "R[0-9]{3}" docs/ --include=*.md \| sort -u \| tail` |

---

## 协调者裁决（本片新增，区间 **R631–R645**）

- **R631 App 端不是浏览器（就端点语义而言）**：它是 native 容器 + 加载**本地资源**的 webview ⇒
  没有「同源」、没有服务端 origin、`location.origin` 不是网关地址。⇒ 端点必须**显式绝对地址**，
  与 `mp-weixin` **同一条规则**。
  ⚠️ 这**不**断言 `fetch`/`WebSocket` 在 App 里不可用（那是另一件事，见 R635）。
- **R632 落地形态**：把 `app*` 从 `'browser'` 拆成新档 `'app'`，严格校验的判据从
  `platform === 'mp-weixin'` 改成 `REQUIRE_ABSOLUTE_ENDPOINT.has(platform)`（集合常量
  `new Set(['mp-weixin','app'])`）。⇒ **校验代码只有一份**，报错工厂只有一份，只是**平台集合**变了一个字面量。
- **R633 H5 语义冻结**：`'browser'` 分支逐字保留（相对 `/api` + 同源回退 + `undefined` = 读 env 的 `??` 语义）。
  负对照单测必须**逐条**跑绿（它们是本片最容易踩坏的东西）。
- **R634 反转那条 App 用例**（`mp-transport.test.ts` 的「App 端也走浏览器路径」）：
  断言 `detectPlatform(() => ({ uniPlatform: platform }))` 从 `'browser'` 改成 **`'app'`**，
  用例名与理由一并改写（**保留** `selectTransportSelection` 仍选浏览器传输这条断言 —— 那是 R635 的现状，不是本片要改的）。
  P21 先例：**反转要写清「旧用例编码了哪个错误假设」**。
- **R635 `fetch` 在 App 是否可用 ⇒ 不猜、不写结论**（P17 教训 1 的「全局对象清单」）：
  `requestJson` 对 `'app'` **仍走 `fetch`**（行为不变）⇒ 本片**只登记**（**N47**）+ 给用户一条**可直接在
  HBuilderX 控制台跑的探针**（Task 4 Step 3）。⇒ 谁写「App 支持 fetch」都必须先有那条探针的原文。
- **R636 新增 `scripts/build-app.mjs`**（照 `build-mp-weixin.mjs` 同形）：**一个参数**导出
  `VITE_API_BASE` 与 `VITE_WS_ENDPOINT`，构建成功后跑**产物级 `require("url")` 断言**
  （App 的 plus 运行时同样**没有 Node 的 `url`** ⇒ P19 的缺陷面在 App 上同样存在，而此前**无人检查**）。
- **R637 `manifest.json` 的云打包字段只登记不改**：`app-plus.distribute.android.packagename` / 证书
  **必须由用户提供**（DCloud 账号 + Android 包名/证书；iOS 还需 macOS + `profile`/`p12`）。
  ⇒ 登记 **N48**，并在 Task 4 的清单里列出**要用户确认的字段名**（不猜值）。
- **R638 本片门禁是标准全套**（改了 `apps/client/src/**`）：`turbo run build --force`（**三端 DONE**）·
  `turbo run test lint --force`（29/29、0 cached）· `pnpm run ci` 六阶段 · **真浏览器探针 dev `gate` 16/16** ·
  **发行产物级 `gate` 16/16**（动了 `resolveApiBase`/`resolveWsEndpoint` ⇒ H5 那一端必须复查）·
  `node scripts/ledger-counts.mjs`。⚠️ 探针**独占**纪律：跑前 `ss -ltnp | grep 5173` + `pgrep -af vite` 清残留、
  `docker compose exec -T redis redis-cli DEL 'ratelimit:ws-conn:::ffff:172.19.0.1'`，每条套 `timeout 300`。
  **不跑**：13 条 conformance（本片不碰 `packages/**`/`tools/**`，它们也不读前端源码）。
- **R639 N39 的判定本片不动**：仍是「部分关闭（小程序端 ✅ / App 端未验证）」。
  回填只能由用户的运行期原文触发（Task 4 的判定表）。
- **R640 本片可以在**用户不在场**时完成**：Task 1–3 + Task 5 都是本机可证的（单测 + 三端 build + 探针），
  Task 4 是**清单**。⚠️ 任何人不得因为 Task 1–3 绿了就把 N39 的 App 半边写成「已验证」。

---

## File Structure

```
apps/client/src/net/mp-transport.ts            Modify: PlatformKind 加 'app'；classifyPlatform 拆分
apps/client/src/net/http.ts                    Modify: 严格校验的判据换成集合（一份实现）；JSDoc 同步
apps/client/src/config.ts                      Modify: 新增 APP_ENDPOINT_BUILD_COMMAND
apps/client/test/mp-transport.test.ts          Modify: 反转 App 用例（R634）+ 新增 'app' 分类用例
apps/client/test/http.test.ts                  Modify: 新增 app 两条严格校验 + H5 负对照（R633）
scripts/build-app.mjs                          Create: App 构建入口（同 build-mp-weixin.mjs 同形）
apps/client/test/app-endpoint.test.ts          Create: build-app.mjs 的参数/端点派生/产物断言（可注入，不真跑构建）
docs/superpowers/plans/deviation-ledger.md     Modify: §3 的 N39 行不动；§1.5 追加 N47/N48；§0 重算
docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md  Modify: B1–B4 → 可执行清单（Task 4）
docs/superpowers/plans/agent-briefs.md         Modify: 交接现状 + 「下一步」+ 环境事实（App 端一条）
docs/superpowers/plans/2026-09-17-slice-p26-app-side-endpoint-and-verification.md  本文件：回填区
```

---

### Task 0: 取证与裁决确认（协调者，只读）

- [ ] **Step 1: 复核上表「绑定数值」的每一行**（不许照抄）

```bash
cd /home/howe/pokergame
git log --oneline -1
grep -rn "PlatformKind\|=== 'mp-weixin'" apps/client/src
node -e "console.log(require('./apps/client/package.json').scripts['build:app'])"
node -e "console.log(JSON.stringify(require('./apps/client/src/manifest.json')['app-plus'].distribute))"
```

- [ ] **Step 2: 记下 H5 侧「不得改变」的现行断言（R633 的负对照面）**

```bash
grep -n "'browser'" apps/client/test/http.test.ts
cd apps/client && pnpm exec vitest run test/http.test.ts test/mp-transport.test.ts
# 期望全绿；把两个文件的 `Tests N passed` 抄下来（改动后两者都必须 ≥ 这个数）
```

- [ ] **Step 3: 若用户在场 ⇒ 先跑 Task 4 Step 1/2（拿到 App 产物的现状）**，再决定是否开工 Task 1。
  用户不在场 ⇒ 直接 Task 1（R640）。

---

### Task 1: `PlatformKind` 新增 `'app'`（**TDD：先反转那条用例**）

**Files:**
- Modify: `apps/client/src/net/mp-transport.ts:467`, `:505-514`
- Test: `apps/client/test/mp-transport.test.ts:298-306`（那条 App 用例；用下面的 `grep` 定位，别照抄行号）

**Interfaces:**
- Produces: `export type PlatformKind = 'browser' | 'app' | 'mp-weixin'`（**新档 `'app'`**）；
  `classifyPlatform('app' | 'app-plus' | 'app-android' | …) === 'app'`。
- 其它一切不变：`detectPlatform` / `selectTransportSelection` 的签名与行为保持。

- [ ] **Step 1: 反转那条编码了错误假设的用例（先让它失败）**

把 `apps/client/test/mp-transport.test.ts` 的该 `it` 改成：

```ts
  it('App 端（uniPlatform=app*）是**独立的平台档**：它没有同源，端点必须显式（R631/R634）', () => {
    /**
     * ⚠️ **本用例在 P26 被反转**（P21 先例：反转编码了错误行为的用例要写清理由）。
     *
     * 旧形态断言 `detectPlatform(...) === 'browser'`，用例名写着「App 跑在 WebView 里，浏览器 API 可用」。
     * 那句话把**两件事**混成了一件：
     *  ① `fetch`/`WebSocket` 在 App 的 webview 里**是否可用** —— 这是**未验证项**（N47，Task 4 的探针）；
     *  ② 端点语义（同源 / `location.origin`）在 App 上**是否成立** —— 这一条**结构上不成立**：
     *     App 的 webview 加载本地资源，`location.origin` 不是网关地址，`/api` 这个相对前缀无处可解。
     * ⇒ 平台判定必须把 App 与浏览器**分开**，严格端点校验才能覆盖它（R632）。
     */
    for (const platform of ['app', 'app-plus', 'app-android']) {
      expect(detectPlatform(() => ({ uniPlatform: platform }))).toBe('app');
      // 传输选择**不变**：App 仍用浏览器传输（WebSocket 可用性属 N47，本片不改行为）
      expect(selectTransportSelection(() => ({ uniPlatform: platform }))(['websocket'])).toEqual([
        'websocket',
      ]);
    }
  });
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd apps/client && pnpm exec vitest run test/mp-transport.test.ts -t '独立的平台档'`
Expected: FAIL —— `expected 'browser' to be 'app'`（本条是**本片的 RED 证据**，抄进「门禁实测」块）

- [ ] **Step 3: 实现（`mp-transport.ts`）**

```ts
/**
 * 运行平台档（R551/R631）。
 *
 * ⚠️ **App 是独立一档，不是浏览器**（P26/R631）：App 是 native 容器 + 加载**本地资源**的 webview
 * ⇒ **没有「同源」**、`location.origin` 不是网关地址。端点语义上它与 `mp-weixin` 同类
 * （⇒ 必须显式绝对地址，见 `http.ts` 的 `REQUIRE_ABSOLUTE_ENDPOINT`）；
 * 而 `fetch`/`WebSocket` 在它里面是否可用，是**另一件事**（未验证，台账 N47）。
 */
export type PlatformKind = 'browser' | 'app' | 'mp-weixin';
```

`classifyPlatform` 改成：

```ts
export function classifyPlatform(platform: string | undefined): PlatformKind {
  if (platform === 'mp-weixin') return 'mp-weixin';
  if (platform === undefined || platform === '') return 'browser';
  if (platform === 'web' || platform === 'h5') return 'browser';
  if (platform.startsWith('app')) return 'app';
  throw new Error(
    `不支持的运行平台 uniPlatform=${platform}：本片只覆盖 H5 / App / mp-weixin；` +
      '其它小程序平台需要各自的传输适配层（不得退化成浏览器传输）',
  );
}
```

⚠️ 顺序**必须**是「`web`/`h5` → browser」在「`app*` → app」之前或并列（两者不重叠，但 `startsWith('app')` 不能吃掉 `web`）。

- [ ] **Step 4: 跑该文件，确认全绿**

Run: `cd apps/client && pnpm exec vitest run test/mp-transport.test.ts`
Expected: PASS，`Tests` 数 = Task 0 Step 2 记下的**同一个数**（只是其中一条断言变了，用例数不变）

- [ ] **Step 5: 逐条自证其它平台档没被动**

```bash
cd apps/client && pnpm exec vitest run test/mp-transport.test.ts -t '平台'
# 期望：web/h5 ⇒ browser；undefined/'' ⇒ browser；mp-weixin ⇒ mp-weixin；
#       app* ⇒ app；mp-alipay 之类 ⇒ 抛错（R551 的负对照）
```

- [ ] **Step 6: 提交**

```bash
cd /home/howe/pokergame
git add apps/client/src/net/mp-transport.ts apps/client/test/mp-transport.test.ts
git commit -m "feat(client): App 端独立成平台档 'app'（端点语义非浏览器）（P26/R631/R634）"
```

---

### Task 2: 端点严格校验覆盖 App（**同一条规则，不复制**）

**Files:**
- Modify: `apps/client/src/net/http.ts`（`resolveApiBase:158-160` · `resolveWsEndpoint:201-203` · JSDoc `:28-31`）· `apps/client/src/config.ts:55`
- Test: `apps/client/test/http.test.ts`

**Interfaces:**
- Consumes: `PlatformKind`（Task 1 加 `'app'`）
- Produces:
  - `export const REQUIRE_ABSOLUTE_ENDPOINT: ReadonlySet<PlatformKind>` —— 需要**显式绝对端点**的平台集合（**唯一真源**）。
  - `export const APP_ENDPOINT_BUILD_COMMAND = 'node scripts/build-app.mjs <host:port>';`（`config.ts`）
  - `resolveApiBase(platform)` / `resolveWsEndpoint(explicit, platform)` 对 `'app'` 抛错（与 `'mp-weixin'` **同文案结构**、**点各自的构建命令**）。

- [ ] **Step 1: 写失败测试（app 两条 + H5 负对照 + 文案点名两条命令）**

在 `apps/client/test/http.test.ts` 的既有 mp 用例之后追加：

```ts
describe('P26：无同源平台（mp-weixin + app）都必须显式绝对端点', () => {
  it('相对 VITE_API_BASE + app ⇒ 抛错，并点名 build-app.mjs', () => {
    clientConfig.apiBase = '/api';
    expect(() => resolveApiBase('app')).toThrow(/VITE_API_BASE/);
    expect(() => resolveApiBase('app')).toThrow(/build-app\.mjs/);
  });

  it('空 / 相对 VITE_WS_ENDPOINT + app ⇒ 抛错，并点名 build-app.mjs', () => {
    expect(() => resolveWsEndpoint('', 'app')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('/ws', 'app')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('/ws', 'app')).toThrow(/build-app\.mjs/);
  });

  it('给了绝对地址 ⇒ 两个平台都放行（校验只 refuse 相对/空）', () => {
    clientConfig.apiBase = 'http://192.168.1.5:3000/api';
    expect(resolveApiBase('app')).toBe('http://192.168.1.5:3000/api');
    expect(resolveWsEndpoint('http://192.168.1.5:3000', 'app')).toBe('http://192.168.1.5:3000');
  });

  it('**负对照（R633）：H5 语义逐字不变** —— 相对 base 与同源 endpoint 都照旧放行', () => {
    clientConfig.apiBase = '/api';
    expect(resolveApiBase('browser')).toBe('/api');
    // `undefined` = 没给（允许读 VITE_WS_ENDPOINT）；`''` = 明确要求同源 ⇒ 都**不抛**
    expect(() => resolveWsEndpoint(undefined, 'browser')).not.toThrow();
    expect(() => resolveWsEndpoint('', 'browser')).not.toThrow();
    expect(resolveWsEndpoint('/ws', 'browser')).toBe('/ws');
  });

  it('集合是唯一真源：两个无同源平台都在集合里，browser 不在', () => {
    expect([...REQUIRE_ABSOLUTE_ENDPOINT].sort()).toEqual(['app', 'mp-weixin']);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd apps/client && pnpm exec vitest run test/http.test.ts -t '无同源平台'`
Expected: FAIL —— `resolveApiBase('app')` 目前**返回 `/api`**（不抛），`REQUIRE_ABSOLUTE_ENDPOINT` 未定义

- [ ] **Step 3: 实现（一份校验，两个平台）**

`apps/client/src/config.ts`，在 `MP_ENDPOINT_BUILD_COMMAND` 之后：

```ts
export const APP_ENDPOINT_BUILD_COMMAND = 'node scripts/build-app.mjs <host:port>';
```

`apps/client/src/net/http.ts`：

```ts
/**
 * **需要显式绝对端点**的平台（R632 的唯一真源）。
 *
 * 判据不是「哪个平台特殊」，而是「**这个平台有没有同源**」：
 *  · `mp-weixin`：只有 `wx.connectSocket`，没有 `window.location`（R550）；
 *  · `app`：native 容器 + 本地资源 webview，`location.origin` 不是网关（P26/R631）。
 * `browser`（H5 / 纯 web / 单测）**有**同源与 vite 代理 ⇒ 不在集合里，语义逐字冻结（R633）。
 */
export const REQUIRE_ABSOLUTE_ENDPOINT: ReadonlySet<PlatformKind> = new Set(['mp-weixin', 'app']);

/** 按平台给出构建入口命令（报错文案的唯一来源，避免两处各写一遍）。 */
function endpointBuildCommand(platform: PlatformKind): string {
  return platform === 'app' ? APP_ENDPOINT_BUILD_COMMAND : MP_ENDPOINT_BUILD_COMMAND;
}
```

`resolveApiBase` 的判据改成：

```ts
export function resolveApiBase(platform: PlatformKind = detectPlatform()): string {
  const base = clientConfig.apiBase;
  if (!REQUIRE_ABSOLUTE_ENDPOINT.has(platform) || ABSOLUTE_URL.test(base)) return base;
  throw new Error(
    `${PLATFORM_LABEL[platform]}的 VITE_API_BASE 必须是绝对地址（http:// 或 https:// 开头），当前值是 ${JSON.stringify(base)}：` +
      `${PLATFORM_LABEL[platform]}没有「同源」概念，相对路径发不出请求。请用构建入口重新构建：` +
      `\n  ${endpointBuildCommand(platform)}` +
      '\n  （把 <host:port> 换成你的网关地址：小程序真机用局域网 IP；App 用容器所在机器的地址）',
  );
}
```

`resolveWsEndpoint` 的判据改成：

```ts
  if (REQUIRE_ABSOLUTE_ENDPOINT.has(platform)) {
    const configured = explicit ?? readWsEndpointEnv() ?? '';
    if (!configured) throw endpointRequiredError(platform, '为空');
    if (!ABSOLUTE_URL.test(configured)) {
      throw endpointRequiredError(platform, `必须是绝对地址（http:// 或 https:// 开头），当前值是 ${JSON.stringify(configured)}`);
    }
  }
  return resolveEndpoint(explicit);
```

其中 `PLATFORM_LABEL` 与 `endpointRequiredError` 是原来 `mpWsEndpointError` 的**改名 + 参数化**
（`mp-weixin` ⇒ `小程序端`，`app` ⇒ `App 端`）。⚠️ **`mp-weixin` 的两条既有用例的文案断言必须仍然通过**
（它们断言 `/VITE_WS_ENDPOINT/`、`/build-mp-weixin\.mjs/`、`MP_ENDPOINT_BUILD_COMMAND`、`/"\/ws"/`）——
即改造是**参数化**，不是重写文案。

同时改 `http.ts` 头部 JSDoc 的平台表（`:28-31`）：

```
 *  - `mp-weixin` ⇒ `uni.request`；
 *  - `app` ⇒ 仍 `fetch`（**App 运行时的 `fetch` 可用性未验证**，台账 N47；本片不改这条路径的行为）；
 *  - `web` / `h5` / 读不到平台（纯 web / SSR / 单测）⇒ `fetch`，逐字搬改动前 `rest.ts` 的写法；
 *  - **其它平台**由 `classifyPlatform` 明确报错，不静默退化。
```

- [ ] **Step 4: 跑三个文件确认全绿**

```bash
cd apps/client
pnpm exec vitest run test/http.test.ts test/mp-transport.test.ts test/transport-config.test.ts
```
Expected: 全绿；`http.test.ts` 的 `Tests N passed` ≥ Task 0 Step 2 记下的数

- [ ] **Step 5: 全量客户端测试 + 类型闸（跨包类型改了要先 build 语义上这里只改 client）**

```bash
cd /home/howe/pokergame
pnpm --filter @fight-the-landlord/client lint     # vue-tsc --noEmit（含 test/**）
pnpm --filter @fight-the-landlord/client test     # 期望 ≥ 281 passed + 2 skipped（P21 基线）
```

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/net/http.ts apps/client/src/config.ts apps/client/test/http.test.ts
git commit -m "feat(client): 端点严格校验覆盖 App（同一条规则/集合唯一真源）（P26/R632/R633）"
```

---

### Task 3: `scripts/build-app.mjs` —— App 构建入口（一个参数 + 产物级 P19 回归闸）

**Files:**
- Create: `scripts/build-app.mjs`
- Create: `apps/client/test/app-endpoint.test.ts`
- Modify: 根 `package.json` —— **裁决：不加**便捷别名（R636）。
  入口**只有一处** `node scripts/build-app.mjs <host:port>`（与 mp 的 `build-mp-weixin.mjs` 对称：
  「同一个参数」这条纪律的价值就在于**只有一条命令**；再加一条别名会让构建入口出现两个真源）。

**Interfaces:**
- Produces: `node scripts/build-app.mjs <host:port> [--dev]` ⇒ 导出
  `VITE_API_BASE=http://<host:port>/api` 与 `VITE_WS_ENDPOINT=http://<host:port>`，
  然后 `pnpm --filter @fight-the-landlord/client ${dev ? 'dev:app' : 'build:app'}`；
  构建成功后扫 `apps/client/dist/{build,dev}/app` 找 `require("url")` / `pathToFileURL`，命中即 **exit 1**。
  退出码：参数不合法 ⇒ 打印用法 + `1`（**不启动构建**）；否则透传子进程退出码。
- 可测试性：把「参数解析 + origin 归一 + 端点派生 + 产物扫描」抽成**纯函数**并 export，
  由 `apps/client/test/app-endpoint.test.ts` 覆盖（**不真跑构建**）。

- [ ] **Step 1: 写失败测试（纯函数层）**

`apps/client/test/app-endpoint.test.ts`：

```ts
/**
 * P26：`scripts/build-app.mjs` 的**可注入部分**。
 * 脚本本身要 spawn 真实构建（慢、且需要 uni CLI），所以把三件事抽成纯函数：
 *  ① 参数解析（缺参 / 多参 / 未知 flag ⇒ 报错信息，不猜）；② origin 归一；③ 端点派生。
 * ④ 产物扫描用**临时目录**验（真构建不在单测里跑）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error —— 该脚本是 .mjs（零构建），类型由本测试的用法隐式约束
import { normalizeOrigin, parseArgs, deriveEndpoints, scanForNodeUrl } from '../../../scripts/build-app.mjs';

describe('build-app.mjs：参数与端点（R552 同形）', () => {
  it('缺 <host:port> ⇒ 报错且不猜默认值', () => {
    expect(() => parseArgs([])).toThrow(/缺少 <host:port>/);
  });
  it('多给位置参数 / 未知 flag ⇒ 报错', () => {
    expect(() => parseArgs(['a:1', 'b:2'])).toThrow(/只接受一个/);
    expect(() => parseArgs(['a:1', '--watch'])).toThrow(/未知参数/);
  });
  it('--dev 被识别，且不参与位置参数计数', () => {
    expect(parseArgs(['192.168.1.5:3000', '--dev'])).toEqual({ host: '192.168.1.5:3000', dev: true });
  });
  it('origin 归一：补 http:// / 去尾斜杠 / 保留 https', () => {
    expect(normalizeOrigin('192.168.1.5:3000/')).toBe('http://192.168.1.5:3000');
    expect(normalizeOrigin('https://gw.example.com')).toBe('https://gw.example.com');
  });
  it('一个参数派生两个端点（与 build-mp-weixin.mjs 逐字同形）', () => {
    expect(deriveEndpoints('http://192.168.1.5:3000')).toEqual({
      VITE_API_BASE: 'http://192.168.1.5:3000/api',
      VITE_WS_ENDPOINT: 'http://192.168.1.5:3000',
    });
  });
  it('IPv6 字面量被拒（请用域名或 IPv4）', () => {
    expect(() => normalizeOrigin('[::1]:3000')).toThrow();
  });
});

describe('产物级 P19 回归闸（App 的 plus 运行时同样没有 Node 的 url）', () => {
  it('扫到 require("url") 或 pathToFileURL ⇒ 报出该文件', () => {
    const files = {
      'app.js': 'var x = 1;',
      'common/vendor.js': 'const u = require("url").pathToFileURL(__filename).href;',
    };
    expect(scanForNodeUrl(files)).toEqual(['common/vendor.js']);
  });
  it('干净产物 ⇒ 空数组（负对照）', () => {
    expect(scanForNodeUrl({ 'app.js': 'var x = 1; console.log(1);' })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd apps/client && pnpm exec vitest run test/app-endpoint.test.ts`
Expected: FAIL —— `Cannot find module '../../../scripts/build-app.mjs'`

- [ ] **Step 3: 写 `scripts/build-app.mjs`**

照 `scripts/build-mp-weixin.mjs` **同形**（同一套 `normalizeOrigin` / `HOST_PORT` / `fail` / 用法文案骨架），
只改四处：`PACKAGE` 后的 `script` 名（`dev:app` / `build:app`）、输出目录（`dist/{build,dev}/app`）、
帮助文案里的平台名、以及**导出四个纯函数**（`parseArgs` / `normalizeOrigin` / `deriveEndpoints` / `scanForNodeUrl`）
供单测消费。关键片段：

```js
export function parseArgs(argv) {
  const dev = argv.includes('--dev');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--dev');
  if (unknown.length > 0) fail(`未知参数：${unknown.join(' ')}`);
  if (positional.length !== 1) {
    fail(positional.length === 0 ? '缺少 <host:port> 参数。' : `只接受一个 <host:port>，收到 ${positional.length} 个。`);
  }
  return { host: positional[0], dev };
}

export function normalizeOrigin(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed.startsWith('[')) fail(`IPv6 字面量请改用域名或 IPv4：${raw}`);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!HOST_PORT.test(withScheme.replace(/^https?:\/\//i, ''))) fail(`<host:port> 形态不合法：${raw}`);
  return withScheme;
}

export function deriveEndpoints(origin) {
  return { VITE_API_BASE: `${origin}/api`, VITE_WS_ENDPOINT: origin };
}

/** 扫 {相对路径: 内容} ⇒ 命中 Node url 引用的文件列表（纯函数，便于用合成样本自证）。 */
export function scanForNodeUrl(files) {
  return Object.entries(files)
    .filter(([, text]) => /require\(\s*["']url["']\s*\)/.test(text) || /pathToFileURL/.test(text))
    .map(([path]) => path);
}
```

⚠️ `fail()` 在纯函数里 `process.exit(1)` 会让单测**杀掉 vitest 进程**（P25 的同类坑）。
⇒ 把 `fail` 改成 **`throw new Error(...)`**，在最外层（`import.meta.url === process.argv[1]` 的主流程）里
`try { … } catch (e) { process.stderr.write(...); process.exit(1); }`。**这一步是硬要求**，否则 Step 4 会假绿/假死。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/client && pnpm exec vitest run test/app-endpoint.test.ts`
Expected: PASS，`8 passed`（第一组 6 条 + 第二组 2 条）

- [ ] **Step 5: 真跑一次构建入口（本机可做，R640）**

```bash
cd /home/howe/pokergame
node scripts/build-app.mjs localhost:3000
# 期望：先打印两个注入变量；三端之一 DONE；最后打印
#   [build-app] ✅ 产物级判据：无 require("url") / pathToFileURL（P19 回归闸）
ls apps/client/dist/build/app
```

- [ ] **Step 6: 提交**

```bash
git add scripts/build-app.mjs apps/client/test/app-endpoint.test.ts
git commit -m "feat(scripts): 新增 App 构建入口（一个参数导出两端点 + P19 产物级回归闸）（P26/R636）"
```

---

### Task 4: 运行期验证清单（**用户在场时执行；不在场则原样交付**）

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md`（把 B1–B4 换成下面的可执行表）

⚠️ **本 Task 不产出「已验证」结论**（R440/R639）。协调者只在用户回填原文后改台账。

- [ ] **Step 1: B1 产物（本机可做，已由 Task 3 Step 5 覆盖）**

```bash
cd /home/howe/pokergame
node scripts/build-app.mjs localhost:3000      # 或 <容器主机 IP>:3000
ls -d apps/client/dist/build/app && echo "产物存在"
```
回填：产物存在与否 + 脚本最后一行（`✅ 产物级判据`）。

- [ ] **Step 2: B2 HBuilderX 运行调试（需 Windows/macOS + HBuilderX）**

1. HBuilderX → **文件 → 打开目录** → 选**仓库里的 `apps/client`**（它是 CLI 工程；**不要**打开 `dist`）。
2. **运行 → 运行到手机或模拟器 → 运行到 Android App 基座**（需已装 HBuilderX 的基座）。
3. 回填：**控制台全文**（有红字整段复制，含堆栈）+ 能否起来。

- [ ] **Step 3: App 运行时的**全局对象探针**（**R635 的唯一答案**）**

在 HBuilderX 打开的真机/模拟器调试控制台里执行，把**原样输出**贴回：

```js
console.log(JSON.stringify({
  fetch: typeof fetch,
  WebSocket: typeof WebSocket,
  origin: (typeof location !== 'undefined' ? location.origin : null),
  href: (typeof location !== 'undefined' ? location.href : null),
  wx: typeof wx,
  uniRequest: typeof (typeof uni !== 'undefined' && uni.request),
}, null, 2));
```
判读：`origin` 若是 `file://` / `null` / 空 ⇒ **证实 R631**（App 没有可用同源）；
`fetch` 若是 `'undefined'` ⇒ **新缺陷**（`requestJson` 在 App 上必挂）⇒ 另立切片（附本条原文作负对照）。

- [ ] **Step 4: B3 云打包 APK（需 DCloud 账号 + 要用户确认的字段）**

先让用户确认 `apps/client/src/manifest.json` 的 `app-plus.distribute` 里**要填什么**（本片**不猜值**，R637）：
`android.packagename`（**当前缺失**）· 证书别名/密码/keystore · `appid`（DCloud 侧）。
回填：打包成功/失败的**原文**；失败时贴 `packagename` 相关的报错。

- [ ] **Step 5: B4 iOS（需 macOS + Xcode + `profile`/`p12`）**

回填同上；本机与 Windows 都做不了 ⇒ 若用户没有 macOS，这一格如实写「无法执行」并**保留为未验证**。

- [ ] **Step 6: 端到端最小路径（与小程序 A3 同一套，便于对照）**

**注册（随机手机号 + 任意密码）→ 大厅 → 随机匹配 → 牌桌（17 张手牌）→ 打到结算**。
两个证据一起给：① App 控制台有无报错；② 网关机器上
`docker compose logs --since 5m api-gateway | tail -20`（连上会有 `[ProxyGateway] Client connected: … (user: …)`；
一局收束会有 `Released 2/2 bot(s) for <房号>`）。

- [ ] **Step 7: 判定表（协调者按此收口，**不得**提前填）**

| 回填结果 | 台账 N39 的处置 |
|---|---|
| ①编译/运行无错 ②走到牌桌 17 张 ③`Client connected` | App 半边 ⇒ 「已验证（用户实测，附原文）」，N39 **可关闭** |
| 能起来但 socket 连不上 | 「REST 已通、传输层未通」+ 把原文当**新缺口**登记 |
| 起不来 / 打包失败 | 贴原文即可 —— 也是有价值的结论（比「未验证」强）；协调者据此另立切片 |
| 用户不在场 | **不动** N39（仍「部分关闭」），本 Task 原样交付作清单 |

- [ ] **Step 8: 提交（仅当 Step 1–6 有回填；否则本 Task 不产生 commit）**

```bash
git add docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md
git commit -m "docs(n39): App 半边清单可执行化 + 全局对象探针（P26/R635）"
```

---

### Task 5: 收口（协调者）

- [ ] **Step 1: 登记两条新项（本片只登记、不修的那部分）**

`docs/superpowers/plans/deviation-ledger.md` §1.5 追加：
- **N47**：**App 运行时的全局对象未验证** —— `fetch` / `WebSocket` / `location.origin` 在 App 的 webview 里
  是否可用**没有任何实测**；`requestJson` 对 `app` 仍走 `fetch`（`http.ts:95` 的三元不变），
  若 `fetch` 不存在 ⇒ App 端 REST 全挂。**证据**：`grep -rn "fetch" apps/client/test/*.ts` 里没有 App 平台的
  运行时探针；`apps/client/test/http.test.ts` 只覆盖 `mp-weixin` 与 `browser`。
  **修法方向**：`requestJson` 对 `app` 改走 `uni.request`（与 mp 同一分支）—— **需先有 Step 的探针原文**，不许猜。
- **N48**：**`manifest.json` 的云打包字段不完整** —— `app-plus.distribute` 只有
  `android.permissions=[INTERNET]`，**缺 `packagename`**（云打包必需）；iOS 侧 `{}`。
  **归属**：部署/用户提供（DCloud 账号 + 证书）。⇒ 保留「未验证」。

- [ ] **Step 2: 形态口径自证（**不写行号**）**

```bash
cd /home/howe/pokergame
grep -c "'app'" apps/client/src/net/mp-transport.ts                       # classifyPlatform 的 app 分支
grep -c "REQUIRE_ABSOLUTE_ENDPOINT" apps/client/src/net/http.ts           # 定义 1 + 使用 2（两处判据）
grep -n "platform === 'mp-weixin'" apps/client/src/net/http.ts            # 期望只剩 requestJson 那一处（传输分支）
ls scripts/build-app.mjs scripts/build-mp-weixin.mjs
node scripts/ledger-counts.mjs                                            # N47/N48 计入后 98 → 100
```

- [ ] **Step 3: `design.md` §1.4 的「各端验证状态」同步**

⚠️ **只改本片确实改变的事实**：App 端**端点必须显式**（构建入口从 `build:app` 变为
`node scripts/build-app.mjs <host:port>`）。**不得**写成「App 已支持/已验证」（R440/R639）。

- [ ] **Step 4: `agent-briefs.md` 三处同步**

① 「交接现状」加 P26 行；② 「下一步（按序）」行：N39 的 App 半边**仍是待办**（本片只交付了端点契约 + 入口 + 清单），
并把「用户不在场时只准备清单/脚本」这句话改成事实（脚本已就位）；③ 「已知环境事实」加一条：
**App 端与 mp 端同属「无同源」平台（`REQUIRE_ABSOLUTE_ENDPOINT`）；`fetch` 可用性属 N47，别猜**。

- [ ] **Step 5: 本文件追加「执行期裁决」与「门禁实测」块 + 提交**

```bash
git add docs/
git commit -m "docs: App 端端点契约 + 构建入口 + 运行期清单收口（P26/R631-R645）"
```

---

## 门禁（R638：改了 `apps/client/src/**` ⇒ **标准全套**）

```bash
cd /home/howe/pokergame
# ① 前端类型闸 + 全量单测（改了平台类型 ⇒ 两个包都要过）
pnpm --filter @fight-the-landlord/client lint
pnpm exec turbo run build --force                  # ✅ 10/10（**三端 DONE**：h5 / mp-weixin / app）
pnpm exec turbo run test lint --force              # ✅ 29/29、0 cached（client ≥ 281 passed + 2 skipped）
pnpm run ci                                        # ✅ 六阶段全绿
# ② 真浏览器探针（H5 语义不得被 R632 改坏）—— 独占纪律
ss -ltnp | grep 5173 || true; pgrep -af vite || true      # 有残留先 kill -TERM -<pgid>（禁 pkill -f vite）
docker compose ps                                  # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL 'ratelimit:ws-conn:::ffff:172.19.0.1'
timeout 300 node scripts/browser-e2e.mjs --scenario gate   # ✅ 16/16
timeout 300 pnpm --filter @fight-the-landlord/client build:h5
timeout 300 pnpm --filter @fight-the-landlord/client preview &
sleep 5
node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server --scenario gate  # ✅ 16/16（发行产物级）
# ③ 台账
node scripts/ledger-counts.mjs                     # ✅ 逐区一致（含 N47/N48）
```

**明确不跑**（R638）：13 条 conformance —— 本片不碰 `packages/**`/`tools/**`，conformance **不读前端源码**，
信息量为零（代价是 ~10 分钟 + 一次镜像重建；且它与探针共享「网关按 IP 计并发 WS」的独占纪律，跑它会与 ② 互斥）。

## Self-Review

**Spec coverage**

| Spec 要求 | 落在哪个 Task |
|---|---|
| R550「无同源平台必须显式端点」覆盖 App | Task 1 + Task 2 |
| R552「一个参数导出两个端点」覆盖 App | Task 3 |
| P19「产物里不得有 Node 的 `url`」覆盖 App | Task 3 Step 3（`scanForNodeUrl`） |
| H5 行为冻结 | Task 2 Step 1（负对照 4 条）+ Task 5 门禁 ② |
| N39 的 App 半边「不写已支持」 | Task 4（清单）+ Task 5 Step 1 判定表 |
| 用户机器才能做的那部分 | Task 4 Step 2–5（B2/B3/B4） |
| 全局对象清单（P17 教训 1） | Task 4 Step 3（探针 + N47） |

**Placeholder scan**：无 TBD。Task 1/2/3 都给了可粘贴的测试与实现代码；
`manifest.json` 需要用户提供的字段值**故意留空并写明「不猜」**（那是 R637 的裁决，不是占位符）。

**Type consistency**：`PlatformKind` 在 Task 1 加 `'app'`，Task 2 的 `REQUIRE_ABSOLUTE_ENDPOINT: ReadonlySet<PlatformKind>`
消费它；`APP_ENDPOINT_BUILD_COMMAND` 在 Task 2 定义、在 `endpointBuildCommand()` 里使用；
Task 3 的 `parseArgs/normalizeOrigin/deriveEndpoints/scanForNodeUrl` 在 Task 3 Step 1 的测试里逐个出现。

**⚠️ 本片的四个高风险点**
1. **把 `fetch` 可用性也一起断言掉**（Global Constraint 3）—— 那是**未验证项**（N47），只能由 Task 4 Step 3 的探针回答。
2. **改坏 H5**：`resolveApiBase('browser')` / `resolveWsEndpoint('', 'browser')` 的语义必须逐字保留（R633 的 4 条负对照）。
3. **`mp-weixin` 的既有文案断言**：`http.test.ts` 断言了 `/build-mp-weixin\.mjs/` 与 `MP_ENDPOINT_BUILD_COMMAND`
   ⇒ 参数化改造时**不能**把 mp 的文案改成 App 的。
4. **纯函数里 `process.exit`**（Task 3 Step 3 的 ⚠️）：会让 vitest 进程当场死掉 ⇒ 看起来「跑过了」而其实没有。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与计划不符时在此追加并编号：本片**协调者区间 R631–R645**。）

---

## 门禁实测（回填区，**不要删**）
