# 代理工作台：单入口 + 页内页签 — 实现计划

- 日期：2026-10-26
- Spec：`docs/superpowers/specs/2026-10-26-agent-workbench-tabs-design.md`
- 范围：`admin/index.html` / `admin/app.js` / `admin/style.css` / `scripts/verify-admin-static.mjs` / 新增 `scripts/admin-agents-probe.mjs` / `package.json`
- Global Constraints：
  - 零 `innerHTML`（全部 createElement/textContent）。
  - 既有 `ag-*` id 一个不删、不改名；`VIEWS.agents` 角色串与 `canAgentWrite/canAgentSettle` 正则不动。
  - 不动 `apps/client/src/components/PdkSettlement.vue`（工作区已有无关改动，保持未提交）。
  - 每个任务一个 commit；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
  - 回归命令：`node --check admin/app.js`、`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`、`pnpm verify:admin-players`。

## 任务 T1：静态闸与探针先红

Files：`scripts/verify-admin-static.mjs`、`scripts/admin-agents-probe.mjs`（新增）、`package.json`

步骤：

1. `verify-admin-static.mjs` 代理页段（现约 728-860 行）追加：
   - 负断言（含注释）：`!html.includes('nav-cfg-agent-btn')`、`!html.includes('nav-count-agent')`、`!app.includes('nav-cfg-agent-btn')`、`!app.includes('nav-count-agent')`。
   - CFG_NAV↔HTML 双向：
     - `balancedBlock(app,'const CFG_NAV')` 中每个 `leaf:`/`count:` 值 ⇒ `html.includes('id="..."')`；
     - HTML 中每个 `id="nav-cfg-[a-z-]+-btn"` 必须在 CFG_NAV 的 leaf 集合内（防孤儿叶）。
   - 6 组 id：`agent-tab-{list,settlements,adjustments,recon,audit,settings}`、`agent-panel-{...}`、`ag-invite-row`。
   - 初始可见：抽取 6 个 `<div ... id="agent-panel-X" ...>` 开标签；list 无 `hidden`，其余含 `hidden`。
   - `AGENT_TABS` 字面量：**先** `ok(block !== '', ...)`，再 `import vm from 'node:vm'` + `vm.runInNewContext('(' + block + ')')`（block 为空时跳过执行，T1 干净红不崩）；断言长度 6、id 集合精确、每项 btn/panel 在 HTML 存在。
   - 函数/接线针脚：`function switchAgentTab`、`function applyAgentTabUI`、`function renderAgentInviteRow`、`function ensureConfigSnapshot`、`const canWriteConfigKey`；`wireAgents` 块含 `AGENT_TABS`；`resetAgents` 块匹配 `/tab\s*=\s*'list'/`、`/epoch\s*\+=?\s*1|epoch\+\+/`、`roleApplied = false`、`recon.armed = false`、`list.loaded = false`、`settingsReq.loaded = false`；`loadAll` 块含 `renderAgentInviteRow()`；`switchView` agents 分支含 `loadAgents()`（既有）。
   - `buildSimpleRow` 块：含 `canWriteConfigKey`，且含 `actions.hidden = true` 与 `input.disabled = !writable`（钉调用行，不只查 `.hidden` 字面）。

2. 新增 `scripts/admin-agents-probe.mjs`（照 `scripts/admin-players-probe.mjs`）：
   - jsdom 走 `createRequire(new URL('../apps/client/package.json', import.meta.url))`。
   - 工具：`clickIf(w,id)`（元素不存在返回 false，不抛）；每个 case 独立 `ok()` 收集失败。
   - fetch 桩（**路由顺序**：`/agents/tree`、`/agents/settings`、`/agent-settlements/:id` 先于各自前缀）：
     - `/api/admin/config` → `{code:0,data:{config:{'agent.inviteEnabled':{value:false,version:1}},version:1}}`
     - `/api/admin/agents/settings` → `{code:0,data:{enabled:false,defaultRateBp:500,minSettlementYuan:10,coinPerYuan:100,quotaHoldDays:7,quotaAdminAdjustDailyLimitCoins:0,adjustMaxYuanPerOp:100,adjustMaxYuanPerDay:500}}`
     - `/api/admin/agents/tree` → `{code:0,data:[]}`
     - `/api/admin/agents?` → `{code:0,data:{rows:[],total:0}}`
     - `/api/admin/agent-settlements?` → `{code:0,data:[{id:'s1',settlementNo:'S1',agentId:'ag_1',totalCoins:100,totalMicro:1000000,status:'pending',requestedAt:1761000000000}]}`
     - `/api/admin/agent-settlements/s1` → `{code:0,data:{settlement:{settlementNo:'S1',status:'pending',agentId:'ag_1',totalCoins:100,totalMicro:1000000,itemsCount:1,carryBefore:0,carryAfter:0,coinPerYuan:100,minYuan:10,itemsHash:'h',payout:null,requestedAt:1761000000000,decidedAt:null,paidAt:null,paidBy:null,voucherNo:null,rejectReason:null},lines:[]}}`
     - `/api/admin/agent-adjustments?` → `{code:0,data:[]}`；`/api/admin/agent-audit?` → `{code:0,data:[]}`
     - `/api/admin/agent-reconciliation?...` → `{code:0,data:{/* 最小 summary，见实现 */}}`
     - 其余 → `{code:0,data:{}}`
   - 记录每个 URL 命中计数（`hits` Map）。
   - super_admin：
     - 登录态注入（`ftl-admin-token/username/role`）+ `window.eval(appJs)`；**登录落 config 视图已 loadAll**，`config` 计数 ≥1 属预期。
     - 点 `nav-agents-btn`：断言 `agents-view` 显示、`agent-panel-list` 非 hidden、`/agents?` 与 `/agents/tree` 命中、`/agents/settings` 与 `/agent-settlements` 未命中。
     - 点 `agent-tab-settings`：断言仅新增 `/agents/settings` 命中（config 已缓存，不新增）；`ag-invite-row` 含输入控件。
     - 点 `agent-tab-settlements`：断言 `/agent-settlements` 命中、点行内「详情」后出现「确认打款/驳回」。
     - 依次切 6 页签：每个目标面板非 hidden、其余 hidden；零运行时异常。
   - finance：
     - `nav-agents-btn` 可见；进设置页签：`ag-invite-row` 内 `input.disabled === true` 且 `.row-actions` 的 `hidden === true`（**不看可见性**，`.row-actions` 默认 display:none 会假绿）；`ag-settings-save-btn.hidden === true`。
     - 结算页签详情里出现「确认打款/驳回」。
   - operator：`nav-agents-btn.hidden === true`；`window.eval("switchView('agents')")` 后 `agents-view.hidden === true`。
   - 登出复位：click `logout-btn` → `ag-invite-row.textContent === ''`、`agent-tab-list.classList.contains('active')`、`agent-panel-list.hidden === false`；重登（补 sessionStorage + `window.eval('showMainView()')`）后点代理叶，`/agents?` 命中计数增加。
   - 异步等待：每个点击后 `await sleep(40-60)`。

3. `package.json` 增加 `"verify:admin-agents": "node scripts/admin-agents-probe.mjs"`。

跑红：`pnpm verify:admin` 与 `node scripts/admin-agents-probe.mjs` 均失败（不崩溃）。

提交：`test(admin): 代理工作台结构闸与 jsdom 探针（先红）`

## 任务 T2：HTML 重组 + CSS + CFG_NAV 删项（同一提交，防半删白屏）

Files：`admin/index.html`、`admin/style.css`、`admin/app.js`

步骤：

1. 删左树 `<button id="nav-cfg-agent-btn">`（连同注释提及）；**同提交**删 `app.js` 的 `CFG_NAV` agent 映射项。
2. `#agents-view` 首子节点插入 `.tabs`（6 个 `agent-tab-*`，`list` 带 `active`）。
3. 按归属包面板（`<div id="agent-panel-*" class="agent-panel"[ hidden]>`）：
   - list：列表 section + `ag-create-panel` + `ag-detail`；
   - settlements：结算 section + `ag-settle-detail`；
   - adjustments / recon / audit：各自 section；
   - settings：设置 section（三组 `h3.panel-title.sub`：总开关 / 结算参数 / 调账限额）+ 表单**后**的 `<div id="ag-invite-row"></div>`。
   - 所有 `ag-*` id 原样保留；非 list 面板加 `hidden`。
4. `style.css` 增加 `.agent-panel { display: flex; flex-direction: column; gap: 14px; }`。

跑：`node --check admin/app.js`；`pnpm verify:admin` 仍红（JS 断言未满足），但登录不崩（可用探针确认零异常）。

提交：`feat(admin): 代理页页签骨架、设置分组与 CFG_NAV 同步`

## 任务 T3：app.js 状态机与懒加载

Files：`admin/app.js`

1. 新增 `AGENT_TABS`、`applyAgentTabUI(tab)`、`switchAgentTab(tab)`（settings 分支只调 `renderAgentInviteRow()`）。
2. `agentsState`：删顶层 `loading/loaded`；增 `tab:'list'`、`epoch:0`、`roleApplied:false`、`list/tree/settingsReq:{loaded,loading}`、`recon.armed:false`（`settings` 数据字段保留）。
3. loader 改造：
   - `agentsResponseFresh(epoch)` = `agentsState.epoch === epoch && !!sessionStorage.getItem(TOKEN_KEY)`。
   - `loadAgentList/Tree/Settings` 成功返回 `true`、失败 `false`；loading 清理放 `finally`；**先清 loading 再验 epoch**。
   - `ensureAgentList/Tree/Settings` 各自 `loading||loaded` 早退、成功置 loaded（list 与 tree **两套独立旗**）。
   - `armAgentRecon()`：`armed` 早退，先置 `armed=true` 再种默认区间并 `loadAgentReconciliation()`。
   - `loadAgentSettlements/Adjustments/Audit` 增 epoch 校验（清 loading 后校验，不符丢弃）。
   - `loadAgentTree` 失败补 `showMsg('加载代理树失败…','err')`。
   - `loadAgents()`：按 tab 分派；settlements/adjustments/audit 分派层判 `loaded` 早退；删全局早退。
4. `ensureConfigSnapshot()`：捕获 epoch；已载 ⇒ true；`await loadAll()` 后验 epoch/token；按 `Object.keys(currentConfig).length > 0` 判定。
5. `loadAll()`：赋值 `currentConfig` 前补 `if (!sessionStorage.getItem(TOKEN_KEY)) return;`；末尾补 `if (activeView === 'agents' && agentsState.tab === 'settings') renderAgentInviteRow();`。
6. `renderAgentInviteRow()`：清空容器；无快照 ⇒ `.hint` 占位；有快照 ⇒ `buildSimpleRow('agent.inviteEnabled')`。
7. `canWriteConfigKey(key)` + `buildSimpleRow` 收权：不可写 ⇒ 控件 `disabled`、`actions.hidden = true`。
8. `applyAgentRole()`：`roleApplied` 守卫 + 末尾置真。
9. `switchView` agents 分支：`applyAgentRole(); switchAgentTab(agentsState.tab); loadAgents();`。
10. `resetAgents()`：`tab='list'`、`epoch += 1`、`roleApplied=false`、`list/tree/settingsReq` 与 `settlements/adjustments/audit` loaded 复位、`recon.armed=false`、`ag-invite-row.textContent=''`、`applyAgentTabUI('list')`；删顶层 loading/loaded 行。
11. `wireAgents()`：`for (const t of AGENT_TABS) $(t.btn).addEventListener('click', () => { switchAgentTab(t.id); loadAgents(); });`。

跑绿：`node --check admin/app.js`、`pnpm verify:admin`。

提交：`feat(admin): 代理页签状态机、按页签懒加载与配置行收权`

## 任务 T4：探针转绿 + 回归

Files：`scripts/admin-agents-probe.mjs`、按失败修 `admin/*`

1. 运行 `node scripts/admin-agents-probe.mjs` 修到全绿（零运行时异常）。
2. 复核：super_admin 保存邀请码后 `row-ver` 递增；finance 只读；operator 配置搜索 `agent.inviteEnabled` 卡片不可写（D14）。
3. 回归：`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`、`node --check admin/app.js`、`pnpm verify:admin-players`。

提交：`test(admin): 代理工作台探针转绿与回归修复`

## 任务 T5：代码审查与收尾

1. 独立 reviewer 审 `bce1c8a5..HEAD`（spec/plan 对照；Critical/Important 必修）。
2. 修复后重跑回归；计划/偏差台账更新。
3. 推 `dev`；交付报告（变更、验证证据、SHA、未部署说明）。

## 计划审查记录

独立 reviewer 计划审查，5 Critical / 9 Important / 8 Minor，处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | Critical | T2 只删叶不删 CFG_NAV ⇒ 登录崩溃 | T2 同提交删 CFG_NAV 项 |
| 2 | Critical | list/tree 共用旗 ⇒ 树永不请求 | 拆 `list` 与 `tree` 两套旗 |
| 3 | Critical | 探针「结算行打款/驳回」不可达 | 改为点详情 + 桩 `/agent-settlements/:id` |
| 4 | Critical | super_admin 登录已 loadAll ⇒ config 计数断言不成立 | 断言改为「仅新增 settings 请求」 |
| 5 | Critical | epoch 校验位置易死锁 | 先清 loading（finally）再验 epoch |
| 6 | Important | 每次激活回填表单会丢未保存编辑 | 只重建邀请码行（spec D11 同步修订） |
| 7 | Important | 结算/调账/审计无 loaded 早退 | 分派层判 loaded |
| 8 | Important | `loadAll` 无 token 守卫 ⇒ 迟到 200 回填 | 赋值前 token 校验 |
| 9 | Important | 闸对空 AGENT_TABS 执行会抛错 | 先断言非空再 vm |
| 10-11 | Important | 探针无 null 保护；桩 shape 未列清 | clickIf + 精确桩与路由顺序 |
| 12-14 | Important | reset 断言脆弱、finance 可见性假绿、settingsReq 命名漂移 | 正则/`actions.hidden`/统一 `settingsReq` |
| 15-22 | Minor | jsdom 入口、sleep、孤儿叶、注释残留、armed 时序等 | 已并入 T1/T3 步骤 |

## 代码审查记录

独立 reviewer 审 `bce1c8a5..HEAD`：Critical 0；Important 4（探针吞异常假绿、三页签未断言请求、收权/版本刷新无用例、探针未接 CI）；Minor 7。
处置：
- Important 1-4 全部修复（operator 改走隐藏叶真实点击；adjustments/recon/audit 计数断言 + recon armed 只跑一次；邀请码保存后版本号刷新用例 + operator 配置搜索只读用例；`scripts/ci.sh` 增 `verify:admin-agents`）。
- Minor 5/8：`ensureConfigSnapshot` 同 epoch 去重；ensure* 捕获本地 flags，旧会话 finally 不清新会话 loading。
- Minor 6/7：收敛邀请码行重建点（loader 不再重建）；占位文案区分「加载中/未加载」。
- Minor 9：`applyAgentTabUI` 与 `resetAgents` 对新增 DOM 加 null 守卫（部署混载）。
- Minor 10：闸补 `treeReq` 复位、`agent-tab-list` 初始 active、`#ag-invite-row` 在表单外、`applyAgentRole` 守卫。
- Minor 11：探针 login 桩恒 super_admin，登记（仅用于 super_admin 窗口）。

## 验收清单

- [x] `pnpm verify:admin` 全绿（601 项）
- [x] `node scripts/admin-agents-probe.mjs` 全绿（42 项）
- [x] `pnpm verify:admin-players` 全绿（回归）
- [x] `node --check admin/app.js`
- [x] 工作区仅剩无关的 `PdkSettlement.vue` 未提交改动
- [ ] 推 dev（零 CI）
