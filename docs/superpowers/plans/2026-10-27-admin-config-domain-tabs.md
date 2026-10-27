# 配置中心分域页签 — 实现计划

- 日期：2026-10-27
- Spec：`docs/superpowers/specs/2026-10-27-admin-config-domain-tabs-design.md`
- 范围：`admin/app.js` / `admin/style.css` / `scripts/verify-admin-static.mjs` / 新增 `scripts/admin-config-tabs-probe.mjs` / `package.json` / `scripts/ci.sh`
- Global Constraints：
  - 零 `innerHTML`；全部 `createElement`/`textContent`。
  - 不改 `CONFIG_IA` 键集合、85 键断言、保存链路、代理工作台。
  - `cfg-tabs` 只能作为 **class**（静态闸 REMOVED_IDS 已禁同名 id）。
  - 每个任务一个 commit；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
  - 回归：`node --check admin/app.js`、`pnpm verify:admin`、`node scripts/admin-config-tabs-probe.mjs`、`node scripts/admin-agents-probe.mjs`、`pnpm verify:admin-players`。

## 任务 T1：静态闸与探针先红

Files：`scripts/verify-admin-static.mjs`、`scripts/admin-config-tabs-probe.mjs`（新增）、`package.json`、`scripts/ci.sh`

### 1.1 静态闸新增断言

在 v2.1 配置中心断言段追加：

- `DEFAULT_CFG_UI` 块含 `tabId` 与 `tabDomainId`。
- 存在 `function buildConfigTabStrip` 与 `function applyCfgTabUI`。
- `renderConfigRows` 块含 `buildConfigTabStrip(`、`tabs.length > 1`、`cfg-tab-panel`。
- 搜索分支不渲染页签条：截取 `if (q) {` 到 `} else {` 之间，断言不含 `buildConfigTabStrip`。
- `openCfgDomain` 块含 `tabDomainId = null`；`normalizeCfgDomain` 块含 `tabDomainId = null`。
- `CONFIG_IA` 逐域交叉：`headerKeys` 与各页签键无交集（vm 执行 IA 字面量，逐域断言）。
- `style.css` 含 `.cfg-tabs` 与 `.cfg-tab-panel` 规则。

### 1.2 探针 `scripts/admin-config-tabs-probe.mjs`

jsdom（照 `admin-agents-probe.mjs` 的 `createRequire` 入口），桩：

- `/api/admin/config` → 快照（每键 `{value,version}`）：
  - `game.doudizhu.enabled: true`（header）
  - `game.doudizhu.cardCounterEnabled: false`、`...PricePerGameCoins: 10`、`...PricePerHourCoins: 100`
  - `game.doudizhu.freeRoomEnabled: true`
  - `game.paodekuai.twoPlayerEnabled: false`、`game.paodekuai.freeRoomEnabled: true`
  - `ad.reliefAdpid: 'adunit-1'`
- `/api/admin/ad-channel` → `{code:0,data:{keys:[]}}`（点广告叶不产生错误提示）
- 其余路径 → `{code:0,data:{}}`

用例（顺序即执行序，避免跨域不可达）：

1. 等首屏：轮询 `#settings-rows .cfg-tabs .tab-btn` 出现（最多 ~1s，每 20ms）。
2. 默认斗地主：页签按钮 **6 个**；active 文本 = 「对局辅助」；`#settings-rows .cfg-tab-panel[data-tab="assist"]` 非 hidden，`[data-tab="rooms"]` hidden；assist 键卡存在。
3. DOM 保留：勾选 assist 面板内 `game.doudizhu.cardCounterEnabled` 的 checkbox；点「场次开关」页签；再点回「对局辅助」；断言 checkbox 仍 checked。
4. 搜索 `freeRoomEnabled`：`.cfg-tabs` 不存在；`[data-key="game.doudizhu.freeRoomEnabled"]` 与 `[data-key="game.paodekuai.freeRoomEnabled"]` 均出现（跨域扁平）。
5. 清空搜索：回到斗地主，active 仍为「对局辅助」。
6. 点跑得快叶：6 个按钮；active 文本 = 「开关」；`[data-key="game.paodekuai.twoPlayerEnabled"]` 所在面板可见。
7. 点广告叶：无 `.cfg-tabs`（单页签域）；`[data-key="ad.reliefAdpid"]` 存在。
8. 全程零运行时异常 / 零未处理 rejection。

### 1.3 接线

- `package.json`：`"verify:admin-config-tabs": "node scripts/admin-config-tabs-probe.mjs"`。
- `scripts/ci.sh` 的 admin 阶段追加该脚本。

跑红：`pnpm verify:admin`、`node scripts/admin-config-tabs-probe.mjs` 均失败但不崩。
提交：`test(admin): 配置中心分域页签结构闸与探针（先红）`

## 任务 T2：状态与渲染实现

Files：`admin/app.js`、`admin/style.css`

1. `DEFAULT_CFG_UI` 增加 `tabId: null, tabDomainId: null`。
2. `openCfgDomain`：仅 `domainId !== cfgUI.domainId` 时复位两字段。
3. `normalizeCfgDomain`：改域时复位两字段。
4. `renderConfigRows` 非搜索分支：
   - 解析 `tabs`；`tabs.length > 1` ⇒ `active = resolveCfgTab(domain)`（`tabDomainId` 配对 → 第一个有键 → 首项），写回 `tabId/tabDomainId`；`tabStrip = buildConfigTabStrip(domain, tabs)`；`panels = tabs.map(...)`。
   - 单页签：维持 `sections`。
   - 渲染顺序：header 开关键卡 → `tabStrip` →（多页签）各 `div.cfg-tab-panel` /（单页签或搜索）`h3.settings-section` + 键。
   - 面板内键 = `t.keys.filter(k => k in currentConfig)`；空 ⇒ `p.cfg-tab-empty` 文案「本页签暂无可展示的键」。
   - 全局空态：header 键数 + 域内全部页签键数（多页签）或 sections 键数（单页签/搜索）= 0 ⇒ 现有 `settings-empty`。
5. 新增：
   - `resolveCfgTab(domain)`（纯解析，写回状态）。
   - `buildConfigTabStrip(domain, tabs)`：`div.tabs.cfg-tabs`；按钮 `type="button"`、`data-tab`、`aria-selected`；点击 ⇒ active 相同 no-op；否则 `applyCfgTabUI(tabId)` + `settings-host.scrollTop = 0`。
   - `applyCfgTabUI(tabId)`：切 `.cfg-tabs .tab-btn` 的 `active/aria-selected` 与 `.cfg-tab-panel` 的 `hidden`；写 `cfgUI.tabId`。
6. `syncAdSection(q)`、focus 恢复、scroll 恢复保持。
7. CSS：`.cfg-tabs`、`.cfg-tab-panel`、`.cfg-tab-empty`（复用 `.settings-empty` 样式亦可）。

跑绿：`node --check admin/app.js`、`pnpm verify:admin`。
提交：`feat(admin): 配置中心重内容域页内页签（DOM 保留）`

## 任务 T3：探针转绿 + 回归

1. 跑 `node scripts/admin-config-tabs-probe.mjs` 修到全绿。
2. 回归：`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`、`pnpm verify:admin-players`。
3. 手工/无头浏览器抽查：斗地主切页签、搜索、保存后页签保持（可选）。
提交：`test(admin): 配置中心页签探针转绿`

## 任务 T4：代码审查与收尾

1. 独立 reviewer 审 `4a0c0247..HEAD`（spec/plan 对照；Critical/Important 必修）。
2. 修复后重跑回归；计划/偏差记录更新。
3. 推 `dev`；交付报告。

## 计划审查记录

（待回填）
