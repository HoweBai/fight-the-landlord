# 后台设置页 IA 合并（广告 + 广告回调 / 客户端接入 + 风控安全）— 实现计划

> **For agentic workers:** 按任务逐条执行；每个任务先改测试（静态闸）跑红，再实现跑绿，绿后提交。步骤用 `- [ ]` 勾选。
>
> **对应 spec：** `docs/superpowers/specs/2026-10-21-admin-settings-ia-merge-design.md`（已含对抗审查记录）

**Goal:** 后台设置页左树把「广告」与「广告回调」合成一页，把「客户端接入」并入「风控安全」页签；删除两个独立叶，保持 51 键、API、服务端 policy、conformance 不变。

**Architecture:** 纯 `admin/` 静态三件套改造：`CONFIG_IA` 归属表合并 + 广告回调面板挂到「广告」配置域页内（`syncAdSection` 统一显隐/懒加载），并同步 `verify:admin` 静态机械闸。conformance 通过 hidden 锚点与保留字面量零改动。

**Tech Stack:** 原生 JS（零构建 admin）、Node 静态校验脚本、jsdom（临时探针，不入库）。

## Global Constraints

1. 只改 `admin/index.html`、`admin/app.js`、`admin/style.css`、`scripts/verify-admin-static.mjs` 与 docs；
   **不动** protocol / config-service / 其它服务 / 数据库 / conformance 切片。
2. `CONFIG_IA` 必须仍覆盖 protocol 的 51 键、且无表外键（既有断言）。
3. G12 针脚必须保留：`nav-ad-channel-btn`（index.html hidden 锚点 + app.js 字面量）、
   `ad-channel-view`、`广告回调`、`/api/admin/ad-channel` 系列。
4. 广告页角色 = `super_admin/operator`（finance 不再可见广告回调，用户已拍板）。
5. 每个任务：先跑红 → 最小实现 → 跑绿 → commit；提交信息末尾
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
6. 回归命令：`npm run verify:admin`；语法闸：`node --check admin/app.js`。
7. 不夹带无关重构；`.tmp-gen/` 为 gitignored 临时目录，探针脚本不进提交。
8. 中文注释随代码同步，不留「十二视图 / 6+1 叶 / 凭据三页 / 读面含 finance」旧表述。

---

## 文件结构

| 文件 | 职责 | 本片改动 |
|---|---|---|
| `admin/index.html` | 静态骨架：左树 / 设置 host / 凭据面板 | 删客户端接入叶；广告回调叶改 hidden 锚点；`#ad-channel-view` 改内联面板类 |
| `admin/app.js` | IA 表 + 渲染 + 状态机 | 合并 `client` 域；删除 `adChannel` 视图；新增 `syncAdSection` + `attempted` 状态 |
| `admin/style.css` | 样式 | 新增 `.settings-inline-view` 与 `.ad-channel-*` 行样式 |
| `scripts/verify-admin-static.mjs` | 静态机械闸 | 更新必需 id、新增块级/标签级正负断言 |
| `.tmp-gen/admin-ia-merge-probe.mjs` | 临时真 DOM 探针（gitignored） | 新增；验证交互与显隐 |

---

### Task 1: 客户端接入并入「风控安全」

**Files:**
- Modify: `admin/app.js`（`CONFIG_IA`、`CFG_NAV`、相关注释）
- Modify: `admin/index.html`（删除 `nav-cfg-client-btn` 叶、头注）
- Test: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes: 既有 `CONFIG_IA` 结构 `{ group, domains: [{ id, name, tabs: [{ id, name, keys }] }] }`
- Produces: `risk` 域末尾页签 `{ id: 'clientGate', name: '客户端接入', keys: ['client.appEnabled', 'client.h5Enabled'] }`；
  `client` 域与 `nav-cfg-client-btn` / `nav-count-client` 消失。

- [x] **Step 1: 改静态闸（RED）**

`scripts/verify-admin-static.mjs` 第 3 节必需 id 清单（约 :117-132）删除一行 `'nav-cfg-client-btn',`。

在第 3b 节循环（约 :153-156）之后追加：

```js
/* 2026-10-21 IA 合并：客户端接入叶并入「风控安全」域（页内页签），旧叶/计数锚点必须消失。 */
ok(!html.includes('nav-cfg-client-btn'), 'index.html 已移除 nav-cfg-client-btn');
ok(!html.includes('nav-count-client'), 'index.html 已移除 nav-count-client');
ok(!app.includes('nav-cfg-client-btn'), 'app.js 已无 nav-cfg-client-btn 引用');
```

在第 4 节键集覆盖断言之后（约 :198，`CONFIG_IA 无表外键` 之后）追加：

```js
/* 2026-10-21 IA 合并：客户端接入两键归入 risk 域末尾页签（不新增独立域）。 */
ok(!/id:\s*'client'/.test(iaBlock), 'CONFIG_IA 无独立 client 域');
const riskDomainBlock =
  /id: 'risk',\s*\n\s*name: '风控安全',\s*\n\s*tabs: \[([\s\S]*?)\n\s*\],\s*\n\s*\},/.exec(iaBlock)?.[1] ?? '';
ok(riskDomainBlock !== '', '找到 risk 域块');
ok(riskDomainBlock.includes("id: 'clientGate'"), 'risk 域含 clientGate 页签');
ok(
  riskDomainBlock.includes("'client.appEnabled'") && riskDomainBlock.includes("'client.h5Enabled'"),
  '客户端接入两键位于 risk 域内',
);
```

- [x] **Step 2: 跑红**

Run: `npm run verify:admin`
Expected: FAIL，至少包含：
`✗ index.html 已移除 nav-cfg-client-btn`、`✗ CONFIG_IA 无独立 client 域`、
`✗ risk 域含 clientGate 页签`。

- [x] **Step 3: 实现 `CONFIG_IA` 合并**

`admin/app.js` 的 `CONFIG_IA` 通用设置组中，**删除**整个 `client` 域对象：

```js
      {
        id: 'client',
        name: '客户端接入',
        tabs: [
          { id: 'gate', name: '端开关', keys: ['client.appEnabled', 'client.h5Enabled'] },
        ],
      },
```

在 `risk` 域的 `tabs` 末尾（`data` 页签之后）追加：

```js
          {
            id: 'clientGate',
            name: '客户端接入',
            keys: ['client.appEnabled', 'client.h5Enabled'],
          },
```

同步 `CFG_NAV` 删除映射行：

```js
  { leaf: 'nav-cfg-client-btn', count: 'nav-count-client', domain: 'client' },
```

同步注释：
- `CONFIG_IA` 上方注释无需改键面描述，但不再出现「客户端接入」独立域的描述（如有）；
- `CFG_NAV` 注释「6+1」→「5+1」；
- `updateCfgNav` 注释「左树 6+1 配置叶」→「左树 5+1 配置叶」。

- [x] **Step 4: 实现 `index.html` 删叶**

删除「通用设置」组中的整行：

```html
<button id="nav-cfg-client-btn" type="button" class="nav-leaf">客户端接入<span class="nav-count" id="nav-count-client"></span></button>
```

同步头注：
- 「配置域 6 叶」→「配置域 5 叶」；
- 如有「客户端接入」独立叶描述，改为「风控安全域内页签」。

- [x] **Step 5: 跑绿**

Run: `npm run verify:admin`
Expected: `admin static verify: 257 checks passed`（基线 251 − 移除 1 条必需 id + 新增 7 条，无 FAILED）。

- [x] **Step 6: 提交**

```bash
git add admin/app.js admin/index.html scripts/verify-admin-static.mjs
git commit -m "feat(admin): 客户端接入并入风控安全域页签

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 广告 + 广告回调合并为一页

**Files:**
- Modify: `admin/index.html`（hidden 锚点、删可见叶、`#ad-channel-view` 类）
- Modify: `admin/app.js`（删 `adChannel` 视图、`syncAdSection`、`attempted`、注释）
- Modify: `admin/style.css`（`.settings-inline-view`、`.ad-channel-*`）
- Test: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes: `adChannelState`、`loadAdChannel()`、`renderAdChannel()`、`buildAdChannelRow()`、`#ad-channel-rows`
- Produces: `syncAdSection(q: string): void`；`adChannelState.attempted: boolean`；
  `VIEWS`/`VIEW_ORDER`/`SETTINGS_VIEWS` 不再含 `adChannel`。

- [x] **Step 1: 改静态闸（RED）**

`scripts/verify-admin-static.mjs` 在文件末尾「汇总」之前（现有第 9 节 `.row-effect` 断言之后）追加：

```js
/* ── 10. 2026-10-21 IA 合并：广告 + 广告回调同页 ───────────────────
 * 左树只留「广告」叶；广告回调面板挂在 #settings-host 内、与设置行同一滚动流；
 * 独立 adChannel 视图必须成套删除（VIEWS/VIEW_ORDER/SETTINGS_VIEWS/switchView/renderSettings）。 */
const adNavHits = html.match(/id="nav-ad-channel-btn"/g) ?? [];
ok(adNavHits.length === 1, `index.html 中 nav-ad-channel-btn 恰一处（实测 ${adNavHits.length}）`);
const adNavTag = /<button\b[^>]*\bid="nav-ad-channel-btn"[^>]*>/.exec(html)?.[0] ?? '';
ok(adNavTag !== '' && /\bhidden\b/.test(adNavTag), 'nav-ad-channel-btn 为 hidden 锚点');
ok(app.includes('nav-ad-channel-btn'), 'app.js 保留 nav-ad-channel-btn 字面量（G12 针脚）');

const adSectionTag = /<section\b[^>]*\bid="ad-channel-view"[^>]*>/.exec(html)?.[0] ?? '';
ok(adSectionTag !== '', 'index.html 含 #ad-channel-view');
ok(/\bsettings-inline-view\b/.test(adSectionTag), '#ad-channel-view 使用 settings-inline-view');
ok(!/\bpage-view\b/.test(adSectionTag), '#ad-channel-view 不再是 page-view');
ok(/\bhidden\b/.test(adSectionTag), '#ad-channel-view 初始 hidden');
ok(
  html.indexOf('id="settings-rows"') < html.indexOf('id="ad-channel-view"') &&
    html.indexOf('id="ad-channel-view"') < html.indexOf('<!-- /settings-host -->'),
  '#ad-channel-view 位于 settings-rows 之后、settings-host 之内',
);
ok(/\.settings-inline-view\s*\{/.test(css), 'style.css 含 .settings-inline-view 规则');
ok(/\.ad-channel-rows\s*\{/.test(css), 'style.css 含 .ad-channel-rows 规则');

const viewsBlock = balancedBlock(app, 'const VIEWS =', '{', '}');
ok(viewsBlock !== '' && !/\badChannel\s*:/.test(viewsBlock), 'VIEWS 无 adChannel 条目');
const viewOrderBlock = balancedBlock(app, 'const VIEW_ORDER = [');
ok(viewOrderBlock !== '' && !viewOrderBlock.includes("'adChannel'"), 'VIEW_ORDER 不含 adChannel');
ok(!/SETTINGS_VIEWS\s*=\s*new Set\(\[[^\]]*adChannel/.test(app), 'SETTINGS_VIEWS 不含 adChannel');
const switchViewBlock = balancedBlock(app, 'function switchView', '{', '}');
ok(switchViewBlock !== '' && !switchViewBlock.includes('adChannel'), 'switchView 无 adChannel 分支');
const renderSettingsBlock = balancedBlock(app, 'function renderSettings', '{', '}');
ok(renderSettingsBlock !== '' && !renderSettingsBlock.includes('adChannel'), 'renderSettings 无 adChannel 分支');
ok(!app.includes("switchView('adChannel')"), "app.js 无 switchView('adChannel') 调用");

/** 跳过参数表再配平函数体：renderConfigRows 的参数是解构 `{ preserve = false }`，
 *  直接 balancedBlock 会命中参数而非函数体。 */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) { i += 1; break; }
  }
  return balancedBlock(src.slice(i), '', '{', '}');
}
const renderConfigRowsBlock = functionBody(app, 'function renderConfigRows');
ok(renderConfigRowsBlock !== '', '找到 renderConfigRows 函数体');
ok(/(^|\n)\s*syncAdSection\(q\);/.test(renderConfigRowsBlock), 'renderConfigRows 调用 syncAdSection(q)');
ok(/\bfunction\s+syncAdSection\s*\(/.test(app), 'app.js 定义 syncAdSection');
ok(/adChannelState\s*=\s*\{[^}]*attempted:\s*false/.test(app), 'adChannelState 含 attempted 标志');
```

- [x] **Step 2: 跑红**

Run: `npm run verify:admin`
Expected: FAIL，至少包含：
`✗ nav-ad-channel-btn 为 hidden 锚点`（当前是可见叶）、
`✗ #ad-channel-view 使用 settings-inline-view`、
`✗ VIEWS 无 adChannel 条目`、`✗ renderConfigRows 调用 syncAdSection`。

- [x] **Step 3: 改 `index.html`**

在现有 `#nav-config-btn` 行之后**只新增以下两行**（不要把 `nav-config-btn` 再贴一遍，否则会出现重复 id）：

```html
        <!-- G12 针脚锚点：广告回调已并入「广告」配置页（nav-cfg-dataad-btn），此按钮恒隐。 -->
        <button id="nav-ad-channel-btn" type="button" class="nav-leaf" hidden>广告回调</button>
```

删除「渠道与凭据」组中的可见叶：

```html
<button id="nav-ad-channel-btn" type="button" class="nav-leaf">广告回调</button>
```

把广告回调 section 的类改掉（位置不变，仍在 `#settings-rows` 之后）：

```html
    <section id="ad-channel-view" class="settings-inline-view" hidden>
```

同步头注：凭据「三页」→「两页（支付渠道 / 通知通道）+ 广告回调并入广告配置页」；
删除「读面照通知通道（有意含 finance）」表述。

- [x] **Step 4: 改 `admin/app.js` 视图与状态**

4a. 删除 `VIEWS.adChannel` 整块（现约 :757-762）；`VIEWS` 注释「十二视图元表」→「十一视图元表」，
删除「广告片 T9 加 `adChannel`」措辞。

4b. `VIEW_ORDER` 删除 `'adChannel',`：

```js
const VIEW_ORDER = ['config', 'payChannel', 'notifyChannel', 'wallet', 'finance', 'payOrders', 'payRefunds', 'payWithdrawals', 'risk', 'audit', 'accounts'];
```

4c. `SETTINGS_VIEWS`：

```js
/** 共用 #settings-host 的三视图（config / 支付渠道 / 通知通道）。 */
const SETTINGS_VIEWS = new Set(['config', 'payChannel', 'notifyChannel']);
```

4d. `adChannelState` 增加 `attempted`：

```js
/**
 * 广告回调面板状态（广告片 T9；2026-10-21 并入「广告」配置页）：
 * 单行 = `GET /api/admin/ad-channel` 的 `data.keys`（顺序即响应序 = `AD_CHANNEL_KEYS`；本空间恰 1 键）；
 * 首次进入广告域懒加载后缓存。`attempted` = 本次进入广告域已发过请求（失败后防重渲染重试风暴；
 * 显式再点「广告」叶会清零重试）。
 */
const adChannelState = { rows: [], loaded: false, loading: false, attempted: false };
```

4e. `renderSettings` 改为三分流：

```js
/**
 * #settings-host 内部分流：config ⇒ 工具栏 + 设置行（广告域再追加广告回调面板）；
 * 凭据两视图 ⇒ 各自 section。host 整体显隐归 switchView 的 el 循环；内部显隐归本函数。
 */
function renderSettings(view = activeView) {
  const toolbar = $('settings-host').querySelector('.settings-toolbar');
  toolbar.hidden = view !== 'config';
  $('settings-rows').hidden = view !== 'config';
  $('pay-channel-view').hidden = view !== 'payChannel';
  $('notify-channel-view').hidden = view !== 'notifyChannel';
  if (view === 'config') renderConfigRows();
  else $('ad-channel-view').hidden = true;
}
```

4f. `renderConfigRows` 在恢复滚动位置之前调用 `syncAdSection(q)`：

```js
  syncAdSection(q);

  scrollEl.scrollTop = scrollTop;
```

4g. 在 `renderConfigRows` 之后、`cssEscape` 之前新增：

```js
/**
 * 「广告」配置页的广告回调面板显隐/懒加载（2026-10-21 合并）。
 * 仅在 config 视图 + dataAds 域 + 非搜索态显示；面板是 #settings-rows 的兄弟节点，
 * 重渲染不清空它，故只在 rows 为空时从状态重放，避免清掉未保存的密钥输入。
 */
function syncAdSection(q) {
  const show = activeView === 'config' && cfgUI.domainId === 'dataAds' && !q;
  $('ad-channel-view').hidden = !show;
  if (!show) return;
  if (adChannelState.loaded) {
    if (!$('ad-channel-rows').firstChild) renderAdChannel();
    return;
  }
  if (!adChannelState.loading && !adChannelState.attempted) loadAdChannel();
}
```

4h. `openCfgDomain` 增加重试清零：

```js
function openCfgDomain(domainId) {
  cfgUI.domainId = domainId;
  cfgUI.query = '';
  $('settings-search').value = '';
  if (domainId === 'dataAds') adChannelState.attempted = false; // 显式点叶 = 允许失败重试
  if (activeView !== 'config') switchView('config');
  else {
    renderConfigRows();
    syncCfgLeafActive();
  }
  $('settings-host').scrollTop = 0;
}
```

4i. `loadAdChannel` 起始置 `attempted`：

```js
async function loadAdChannel() {
  if (adChannelState.loading) return;
  adChannelState.loading = true;
  adChannelState.attempted = true;
  const { status, body } = await api('/api/admin/ad-channel');
  adChannelState.loading = false;
  // …以下不变（401/503/0/非 200 分支与成功渲染）…
}
```

4j. `resetAdChannel` 增加 `attempted` 清零：

```js
function resetAdChannel() {
  adChannelState.rows = [];
  adChannelState.loaded = false;
  adChannelState.loading = false;
  adChannelState.attempted = false;
  $('ad-channel-rows').textContent = '';
}
```

4k. `switchView` 删除 adChannel 分支：

```js
  // 注释「十二视图」→「十一视图」
  if (view === 'config' || view === 'payChannel' || view === 'notifyChannel') {
    renderSettings(view);
  }
```

并删除：

```js
  if (view === 'adChannel' && !adChannelState.loaded) loadAdChannel();
```

4l. `applyRoleNav` 增加 hidden 锚点（保留 G12 app.js 字面量）：

```js
function applyRoleNav() {
  for (const name of VIEW_ORDER) {
    if (name === 'config') continue;
    $(VIEWS[name].nav).hidden = !canView(name);
  }
  // G12 app.js 针脚：广告回调已并入「广告」配置页，独立入口恒隐（同时兜底防误显）。
  $('nav-ad-channel-btn').hidden = true;
  updateCfgNav();
  $('whoami').textContent = usernameOf() ? `${usernameOf()}（${roleOf()}）` : '';
  $('whoami').hidden = !usernameOf();
}
```

4m. 删除 `wire()` 中的监听行：

```js
  $('nav-ad-channel-btn').addEventListener('click', () => switchView('adChannel'));
```

4n. 同步注释（静态闸不拦，但必须与本设计一致；行号以当前文件为准）：
- `admin/app.js` 的 `activeView` 类型注释删 `adChannel`；
- `admin/app.js` `switchView` 注释（约 :1830-1838）：「十二视图」→「十一视图」、「四视图」→「三视图」、
  「6+1」→「5+1」、「凭据三 section」→「凭据两 section」；
- `admin/app.js` `wire()` 注释（约 :4604 / :4612）：「6+1」→「5+1」、「十二视图」→「十一视图」；
- `admin/app.js`（约 :3425 / :3579）：「广告回调视图」→「广告回调面板（广告页内）」；
- `admin/app.js` `showLoginView`：「十二视图全隐」→「十一视图全隐」，删除独立视图措辞
  （保留 `resetAdChannel` 说明其为页内面板）；
- `admin/style.css`（约 :212）：「凭据三页也挂在同一 host 内切换」→「凭据两页…」；
- `admin/index.html`（约 :117）：「凭据三页（支付渠道/通知通道/广告回调）」→
  「凭据两页（支付渠道/通知通道）+ 广告回调面板」；（约 :170）「广告回调视图」→「广告页内面板」。

- [x] **Step 5: 改 `admin/style.css`**

在 `.settings-rows` 规则之后（约 :243）追加：

```css
/* 广告回调并入「广告」配置页：同一滚动流内的第二个面板，不再整页滚动。 */
.settings-inline-view {
  max-width: 1100px;
  padding: 10px 20px 0;
}
```

在通知通道样式块之后（约 :767）追加（值照 `.notify-channel-*` 同构）：

```css
/* 广告回调行（2026-10-21 并入广告页；类名与 buildAdChannelRow 对齐）。 */
.ad-channel-rows { display: flex; flex-direction: column; gap: 10px; }
.ad-channel-row { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.ad-channel-label { min-width: 96px; padding-top: 6px; }
.ad-channel-state { min-width: 168px; padding-top: 6px; font-size: 12px; opacity: 0.85; }
.ad-channel-value code { font-size: 12px; word-break: break-all; }
.ad-channel-input {
  flex: 1;
  min-width: 220px;
  font-family: inherit;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
```

- [x] **Step 6: 跑绿 + 语法闸**

Run: `npm run verify:admin`
Expected: `admin static verify: 277 checks passed`（Task 1 后 257 + 本任务 20 条，无 FAILED）。

Run: `node --check admin/app.js`
Expected: 无输出、退出码 0。

- [x] **Step 7: 提交**

```bash
git add admin/app.js admin/index.html admin/style.css scripts/verify-admin-static.mjs
git commit -m "feat(admin): 广告回调并入广告配置页，删除独立视图

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 真 DOM 探针 + 收尾验证

**Files:**
- Create: `.tmp-gen/admin-ia-merge-probe.mjs`（gitignored，不提交）
- Modify: `docs/superpowers/plans/2026-10-21-admin-settings-ia-merge.md`（勾选与结果）

**Interfaces:**
- Consumes: 完成后的 `admin/index.html` + `admin/app.js`
- Produces: 真 DOM 行为证据（左树、页签、面板显隐、输入保留、finance 收面、零异常）

- [x] **Step 1: 写 jsdom 探针**

创建 `.tmp-gen/admin-ia-merge-probe.mjs`：

```js
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// jsdom 是 apps/client 的依赖；从仓库根运行时用锚定的 require 解析（不新增根依赖）。
const require = createRequire(new URL('../apps/client/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = process.cwd();
const html = readFileSync(`${ROOT}/admin/index.html`, 'utf8');
const appJs = readFileSync(`${ROOT}/admin/app.js`, 'utf8');

const BOOL = new Set([
  'currency.reliefEnabled', 'risk.predicate.sameDevice', 'risk.predicate.sameIp',
  'risk.autoThrottle', 'risk.deviceBindingEnabled', 'pay.rechargeEnabled', 'pay.withdrawEnabled',
  'client.appEnabled', 'client.h5Enabled', 'risk.withdrawReAuthEnabled', 'game.cardCounterEnabled',
  'room.freeRoomEnabled', 'room.goldRoomEnabled', 'room.friendRoomEnabled',
  'room.freeBotFillEnabled', 'room.goldBotFillEnabled', 'robot.ruleFallback',
]);
const RISK_KEYS = [
  'risk.winRateThreshold', 'risk.minGames', 'risk.deviceLimit', 'risk.deviceWindowDays',
  'risk.predicate.sameDevice', 'risk.predicate.sameIp', 'risk.autoThrottle',
  'risk.deviceBindingEnabled', 'risk.deviceRetentionDays', 'risk.scanIntervalMs',
  'risk.devicesCleanupIntervalMs', 'risk.withdrawReAuthEnabled',
  'client.appEnabled', 'client.h5Enabled',
];
const keys = [...RISK_KEYS, 'ad.reliefAdpid', 'currency.entryMultiplier'];
const config = Object.fromEntries(
  keys.map((k) => [k, { value: BOOL.has(k) ? true : k === 'ad.reliefAdpid' ? '' : 1, version: 1 }]),
);

const failures = [];
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));
const ok = (cond, label) => {
  if (cond) console.log(`✓ ${label}`);
  else { failures.push(label); console.log(`✗ ${label}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDom(role) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e.message ?? e)));
  const dom = new JSDOM(html, {
    url: 'https://localhost/admin/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.confirm = () => true;
  window.fetch = async (url) => {
    const body = String(url).startsWith('/api/admin/config')
      ? { code: 0, data: { config, version: 1 } }
      : String(url).startsWith('/api/admin/ad-channel')
        ? {
            code: 0,
            data: {
              keys: [
                { key: 'ad.callbackSecret', label: '回调密钥', secret: true, configured: false, fingerprint: '' },
              ],
            },
          }
        : { code: 0, data: {} };
    return { status: 200, json: async () => body };
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', role);
  window.eval(appJs);
  return { window, errors };
}

const $ = (window, id) => window.document.getElementById(id);
const click = (window, id) => $(window, id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/* ── super_admin ── */
const { window, errors } = makeDom('super_admin');
await sleep(50);
ok(!$(window, 'nav-cfg-client-btn'), '左树无客户端接入叶');
ok($(window, 'nav-cfg-riskcfg-btn').hidden === false, '风控安全叶可见');
ok($(window, 'nav-ad-channel-btn').hidden === true, '广告回调锚点恒隐');
ok($(window, 'nav-cfg-dataad-btn').hidden === false, '广告叶可见');

click(window, 'nav-cfg-riskcfg-btn');
await sleep(30);
ok($(window, 'settings-rows').textContent.includes('客户端接入'), '风控安全页含客户端接入分区');
ok(window.document.querySelector('[data-key="client.appEnabled"]') !== null, '端开关 appEnabled 行在场');
ok(window.document.querySelector('[data-key="client.h5Enabled"]') !== null, '端开关 h5Enabled 行在场');

click(window, 'nav-cfg-dataad-btn');
await sleep(50);
ok($(window, 'ad-channel-view').hidden === false, '广告页显示广告回调面板');
ok($(window, 'ad-channel-rows').children.length === 1, '广告回调行已渲染');
ok($(window, 'ad-channel-rows').textContent.includes('回调密钥'), '广告回调行文案在场');

const adInput = $(window, 'ad-channel-rows').querySelector('input');
adInput.value = 'secret-keep-me';
click(window, 'nav-cfg-dataad-btn');
await sleep(30);
ok(adInput.value === 'secret-keep-me', '重进广告叶不清未保存密钥输入');

const search = $(window, 'settings-search');
search.value = 'entry';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(30);
ok($(window, 'ad-channel-view').hidden === true, '搜索态隐藏广告回调面板');
search.value = '';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(30);
ok($(window, 'ad-channel-view').hidden === false, '清空搜索恢复广告回调面板');
ok($(window, 'ad-channel-view').parentElement.id === 'settings-host', '广告回调面板挂在 settings-host 内');
click(window, 'nav-cfg-riskcfg-btn');
await sleep(30);
ok($(window, 'ad-channel-view').hidden === true, '切到其它域隐藏广告回调面板');
ok(errors.length === 0, `super_admin 零运行时异常（实测 ${errors.length}）`);

/* ── finance ── */
const fin = makeDom('finance');
await sleep(50);
ok($(fin.window, 'nav-cfg-dataad-btn').hidden === true, 'finance 无广告叶');
ok($(fin.window, 'nav-cfg-riskcfg-btn').hidden === true, 'finance 无风控安全叶');
ok($(fin.window, 'nav-ad-channel-btn').hidden === true, 'finance 广告回调锚点恒隐');
ok(fin.errors.length === 0, `finance 零运行时异常（实测 ${fin.errors.length}）`);
ok(unhandled.length === 0, `零 unhandledRejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`\nadmin IA merge probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nadmin IA merge probe: all checks passed');
```

> 说明：探针只喂 risk / client / ad / currency.entryMultiplier 这几类简单键，避免结构化编辑器
> 对 mock 形状的额外要求；`normalizeCfgDomain` 会因 ddz 无键自动落到第一个有键域，不影响断言。

- [x] **Step 2: 跑探针**

Run: `node .tmp-gen/admin-ia-merge-probe.mjs`
Expected: 全部 `✓`，最后 `admin IA merge probe: all checks passed`。

若失败：按失败项修 `admin/` 实现（不改探针断言去迁就实现），重跑。

- [x] **Step 3: 全量收尾验证**

Run:
```bash
npm run verify:admin
node --check admin/app.js
node .tmp-gen/admin-ia-merge-probe.mjs
git status --porcelain
```
Expected: verify 全绿；语法闸 0；探针全通过；`git status` 仅剩 docs（若已勾选计划）。

- [x] **Step 4: 更新计划勾选并提交**

把本计划所有步骤勾选为 `[x]`，在文末追加「执行结果」一节（验证数量、探针输出、提交 SHA）。

```bash
git add docs/superpowers/plans/2026-10-21-admin-settings-ia-merge.md
git commit -m "docs(plan): 记录 IA 合并执行与验证结果

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 回归命令与预期

| 命令 | 预期 |
|---|---|
| `npm run verify:admin` | 全绿：Task 1 后 257、Task 2 后 277、审查加固后 286 checks |
| `node --check admin/app.js` | 退出码 0 |
| `node .tmp-gen/admin-ia-merge-probe.mjs` | `all checks passed`（21 条断言） |

## 风险与回滚

- 回滚 = revert 本片两个 feat 提交；不涉及数据/协议，回滚无副作用。
- conformance 真栈验证不在本片执行（本地无重建镜像）；G12 针脚由静态闸 + 字面量保留保证，
  合 master 权威轮前如需可先 `tools/conformance` build 验证。

## 计划审查记录

2026-10-21 独立 reviewer 对抗审查（基线 `npm run verify:admin` 251 checks 全绿）。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | `balancedBlock(app, 'function renderConfigRows')` 会命中参数解构 `{ preserve = false }`，取不到函数体 ⇒ Task 2 永远跑不绿 | 已修订：新增 `functionBody()` 先跳过参数表再配平，并加块非空自检 |
| 阻断 B2 | 从仓库根 `import 'jsdom'` 失败（jsdom 仅为 `apps/client` 依赖）⇒ 探针无法执行 | 已修订：`createRequire(new URL('../apps/client/package.json', import.meta.url))` 锚定解析 |
| 低 L1 | index.html 锚点代码块含已存在的 `nav-config-btn` 行，照抄会重复 id | 已修订：只给新增两行 + 明确警告 |
| 低 L2 | 检查数量约数与实测不符 | 已修订：精确为 257 / 276 / 21 |
| 低 L3 | 注释同步清单不完整且指向不存在位置 | 已修订：按文件+符号列出全部同步点 |
| 低 L4 | `includes('function syncAdSection')` 可被注释满足 | 已修订：改用函数声明正则 + 行首调用正则 |
| 低 L5 | 探针未覆盖 unhandledRejection / jsdomError | 已修订：`VirtualConsole` + `process.on('unhandledRejection')` |
| 低 L6 | 「逐字照 `.notify-channel-input`」不实 | 已修订 spec + 计划：行布局同构、单行 input 适配 |
| 低 L7 | 探针未覆盖切域隐藏与父节点关系 | 已修订：补两条断言 |

结论：阻断已处置，可开工。

## 执行结果（2026-10-21）

- Task 1 提交：`4b27c8a7 feat(admin): 客户端接入并入风控安全域页签`（静态闸 251→257）。
- Task 2 提交：`883a52d0 feat(admin): 广告回调并入广告配置页，删除独立视图`（静态闸 257→277）。
- 代码审查：0 Critical / 0 Important / 6 Minor；处置：
  - M1 注释「其余 11 叶」→「10 叶」、样式 Files 括注更新；
  - M2 静态闸补真实赋值断言（renderSettings 隐藏面板、applyRoleNav hidden、attempted 生命周期）；
  - M3 补块截断自检（switchView / renderSettings / VIEWS / renderConfigRows 尾部语句）；
  - M4 运维手册「广告回调」视图改「配置 → 广告」页内面板；
  - M5 本计划勾选与计数修正（Task 2 后 277、加固后 286）；
  - M6 `.ad-channel-input` 选择器提升为 `.ad-channel-row .ad-channel-input`，去掉死声明。
- 最终验证：
  - `npm run verify:admin` → `admin static verify: 286 checks passed`；
  - `node --check admin/app.js` → 通过；
  - `node .tmp-gen/admin-ia-merge-probe.mjs` → 21/21 全过（左树/页签/面板显隐/搜索/输入保留/切域/finance/零异常）；
  - conformance 未真栈执行；G12 针脚（`nav-ad-channel-btn` / `ad-channel-view` / `广告回调`）已静态核对保留。
