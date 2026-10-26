# 代理工作台：单入口 + 页内页签 — 实现计划

- 日期：2026-10-26
- Spec：`docs/superpowers/specs/2026-10-26-agent-workbench-tabs-design.md`
- 范围：`admin/index.html` / `admin/app.js` / `admin/style.css` / `scripts/verify-admin-static.mjs` / 新增 `scripts/admin-agents-probe.mjs` / `package.json`
- Global Constraints：
  - 零 `innerHTML`（全部 createElement/textContent）。
  - 既有 `ag-*` id 一个不删、不改名；`VIEWS.agents` 角色串与 `canAgentWrite/canAgentSettle` 正则不动。
  - 不动 `apps/client/src/components/PdkSettlement.vue`（工作区已有无关改动，保持未提交）。
  - 每个任务一个 commit；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
  - 回归命令：`node --check admin/app.js`、`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`。

## 任务 T1：静态闸与探针先红

Files：`scripts/verify-admin-static.mjs`、`scripts/admin-agents-probe.mjs`（新增）、`package.json`

步骤：

1. `verify-admin-static.mjs` 代理页段（现约 728-860 行）追加：
   - 负断言：`!html.includes('nav-cfg-agent-btn')`、`!html.includes('nav-count-agent')`、`!app.includes('nav-cfg-agent-btn')`、`!app.includes('nav-count-agent')`。
   - CFG_NAV↔HTML 双向：`balancedBlock(app,'const CFG_NAV')` 中逐个 `leaf:`/`count:` 值 ⇒ `html.includes('id="..."')`。
   - 6 组 id：`agent-tab-{list,settlements,adjustments,recon,audit,settings}`、`agent-panel-{...}`、`ag-invite-row`。
   - 初始可见：抽取 6 个 `<div ... id="agent-panel-X" ...>` 开标签；list 无 `hidden`，其余含 `hidden`。
   - `AGENT_TABS` 字面量抽取（`balancedBlock` + `node:vm` 的 `runInNewContext('(' + block + ')')`）：长度 6、id 集合精确、每项 btn/panel id 在 HTML 存在。
   - 函数/接线针脚：`function switchAgentTab`、`function applyAgentTabUI`、`function renderAgentInviteRow`、`function ensureConfigSnapshot`、`const canWriteConfigKey`；`wireAgents` 块含 `AGENT_TABS`；`resetAgents` 块含 `tab = 'list'`、`epoch`、`roleApplied = false`；`loadAll` 块含 `renderAgentInviteRow()`；`switchView` agents 分支含 `loadAgents()`（既有）。
   - `buildSimpleRow` 块含 `canWriteConfigKey` 且对只读用 `.hidden`。
2. 新增 `scripts/admin-agents-probe.mjs`（照 `scripts/admin-players-probe.mjs` 的 jsdom 模式）：
   - fetch 桩：`/api/admin/config` 返回含 `agent.inviteEnabled:{value:false,version:1}` 的快照；`/agents/settings`、`/agents/tree`、`/agents?`、`/agent-settlements`、`/agent-adjustments`、`/agent-audit`、`/agent-reconciliation` 返回最小合法 shape；记录每次请求 URL 计数。
   - 用例：
     - super_admin：点 `nav-agents-btn` 后仅 agents/tree 被请求（settings/settlements 未请求）；点 `agent-tab-settings` 后才请求 settings + config；6 个页签均可切且对应面板非 hidden。
     - finance：设置页签 `ag-invite-row` 内无可见保存按钮（`hidden` 或不存在）、输入 disabled；结算页签渲染行时出现「打款/驳回」按钮（桩一行 pending）。
     - operator：`nav-agents-btn.hidden === true`；`window.eval("switchView('agents')")` 后 `agents-view.hidden === true`。
     - 登出：`click(logout-btn)` 后 `#ag-invite-row` 为空、`agent-tab-list` 有 `active`、`agent-panel-list` 非 hidden；重登（补 sessionStorage + `window.eval('showMainView()')`）后再次进代理页会重新请求 agents（计数 +≥1）。
   - 断言零运行时异常（VirtualConsole + window error）。
3. `package.json` scripts 增加 `"verify:admin-agents": "node scripts/admin-agents-probe.mjs"`。

跑红：`pnpm verify:admin` 与 `node scripts/admin-agents-probe.mjs` 均失败（预期）。

提交：`test(admin): 代理工作台页签结构闸与 jsdom 探针（先红）`

## 任务 T2：HTML 重组 + CSS

Files：`admin/index.html`、`admin/style.css`

步骤：

1. 删左树 `<button id="nav-cfg-agent-btn">`。
2. `#agents-view` 首子节点插入 `.tabs`（6 个 `agent-tab-*`，`list` 带 `active`）。
3. 按归属包面板（`<div id="agent-panel-*" class="agent-panel"[ hidden]>`）：
   - list：列表 section + `ag-create-panel` + `ag-detail`；
   - settlements：结算 section + `ag-settle-detail`；
   - adjustments / recon / audit：各自 section；
   - settings：设置 section（拆三组 `h3.panel-title.sub`：总开关 / 结算参数 / 调账限额）+ 表单**后**的 `<div id="ag-invite-row"></div>`。
   - 所有 `ag-*` id 原样保留；非 list 面板加 `hidden`。
4. `style.css` 增加 `.agent-panel { display: flex; flex-direction: column; gap: 14px; }`（放在 `.panel` 规则附近）。

跑：`pnpm verify:admin` 仍红（JS 断言未满足）。

提交：`feat(admin): 代理页页签骨架与设置分组`

## 任务 T3：app.js 状态机与懒加载

Files：`admin/app.js`

步骤（按 spec §4.2-4.4）：

1. `CFG_NAV` 删 agent 映射项。
2. 新增 `AGENT_TABS`、`applyAgentTabUI(tab)`、`switchAgentTab(tab)`（切 UI；settings 页签调 `renderAgentSettings()` + `renderAgentInviteRow()`）。
3. `agentsState`：删顶层 `loading/loaded`；增 `tab:'list'`、`epoch:0`、`roleApplied:false`、`list:{loaded,loading}`、`settingsReq:{loaded,loading}`、`recon.armed:false`（保留 `settings` 数据字段）。
4. loader 改造：
   - `agentsResponseFresh(epoch)` = `agentsState.epoch === epoch && !!sessionStorage.getItem(TOKEN_KEY)`；每个 loader 在 await 后校验，不符丢弃。
   - `loadAgentList()` / `loadAgentTree()` / `loadAgentSettings()` 成功返回 `true`，失败 `false`；新增 `ensureAgentList/ensureAgentTree/ensureAgentSettings` 包装（`loading||loaded` 早退，成功置 loaded）。
   - `armAgentRecon()`：`armed` 早退；置默认区间（now-7d ~ now）并 `loadAgentReconciliation()`。
   - `loadAgentSettlements/Adjustments/Audit` 增加 epoch 校验。
   - `loadAgentTree` 失败补 `showMsg('加载代理树失败…','err')`。
   - `loadAgents()`：按 `agentsState.tab` 分派到上述 ensure/load；删全局早退。
5. `ensureConfigSnapshot()`：快照已载 ⇒ true；否则 `await loadAll()` 后按 `Object.keys(currentConfig).length > 0` 判定；失败返回 false。
6. `renderAgentInviteRow()`：清空 `#ag-invite-row`；无快照 ⇒ `.hint` 占位并返回；有快照 ⇒ `buildSimpleRow('agent.inviteEnabled')`。
7. `canWriteConfigKey(key)`：`super_admin`，或 `operator` 且 `!key.startsWith('agent.')`。`buildSimpleRow` 用它：不可写 ⇒ 控件 `disabled`、`actions.hidden = true`（保存/还原在 `.row-actions` 内）。
8. `loadAll()` 末尾补：`if (activeView === 'agents' && agentsState.tab === 'settings') renderAgentInviteRow();`。
9. `applyAgentRole()` 开头 `if (agentsState.roleApplied) return;`，末尾置真。
10. `switchView` agents 分支：`applyAgentRole(); switchAgentTab(agentsState.tab); loadAgents();`（保留 `loadAgents()` 字面）。
11. `resetAgents()`：`tab='list'`、`epoch += 1`、`roleApplied=false`、`list/settingsReq` 复位、`recon.armed=false`、`$('ag-invite-row').textContent=''`、`applyAgentTabUI('list')`（只切 UI，不渲染）；删 `agentsState.loading/loaded` 相关行。
12. `wireAgents()`：`for (const t of AGENT_TABS) $(t.btn).addEventListener('click', () => { switchAgentTab(t.id); loadAgents(); });`。

跑绿：`node --check admin/app.js`、`pnpm verify:admin`。

提交：`feat(admin): 代理页签状态机与按页签懒加载`

## 任务 T4：探针转绿 + 冒烟

Files：`scripts/admin-agents-probe.mjs`、按失败修 `admin/*`

1. 运行 `node scripts/admin-agents-probe.mjs`，逐项修复到全绿（零运行时异常）。
2. 人工/脚本复核：super_admin 保存邀请码后 `row-ver` 递增；finance 设置页签无保存；operator 配置搜索 `agent.inviteEnabled` 卡片不可写（D14）。
3. 全量回归：`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`、`node --check admin/app.js`、`pnpm verify:admin-players`（确认玩家页探针未受 `buildSimpleRow` 收权影响）。

提交：`test(admin): 代理工作台探针转绿 + 收权修复`

## 任务 T5：代码审查与收尾

1. 独立 reviewer 审 `bce1c8a5..HEAD`（spec/plan 对照；Critical/Important 必修）。
2. 修复后重跑全部回归；更新 spec 审查记录/偏差台账（如有）。
3. 推 `dev`；交付报告（变更、验证证据、SHA、未部署说明）。

## 验收清单

- [ ] `pnpm verify:admin` 全绿（新增断言含旧叶消失、CFG_NAV 双向、6 tab/panel、初始仅 list、AGENT_TABS 自洽）
- [ ] `node scripts/admin-agents-probe.mjs` 全绿（super_admin/finance/operator/登出复位）
- [ ] `pnpm verify:admin-players` 全绿（回归）
- [ ] `node --check admin/app.js`
- [ ] 工作区仅剩无关的 `PdkSettlement.vue` 未提交改动
- [ ] 推 dev（零 CI）
