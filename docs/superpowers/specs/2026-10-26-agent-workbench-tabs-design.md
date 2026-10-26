# 代理工作台：单入口 + 页内页签 — 设计

- 日期：2026-10-26
- 状态：对抗审查已修订（2 阻断 + 6 高 + 5 低，见 §9），待实现计划
- 范围：`admin/` 静态三件套 + `scripts/verify-admin-static.mjs` + 新增 jsdom 探针；**不动**协议 / 服务端 / 数据库 / conformance 切片
- 用户裁决：
  1. 方案 A：只留「运营 → 代理」一个入口，页内 6 页签合并代理的全部配置与运营面；
  2. 邀请码开关（`agent.inviteEnabled`）并入设置页签，能进代理页的角色都可见（finance 只读）；
  3. 数据按页签懒加载；
  4. 两组设置各自独立保存。

## 1. 背景与问题

- 「通用设置 → 代理」叶（`nav-cfg-agent-btn`）只承接 1 个配置键 `agent.inviteEnabled`；
- 「运营 → 代理」（`#agents-view`）把 8 个面板纵向堆在一页，进页并行发 7 个 GET；
- 2026-10-26 代理分润设计 §9.1 原本就规划「代理导航区，页签」，实现时退化为长页；
- 两个「代理」入口语义重叠：`agent.inviteEnabled` 与 `agent_settings.enabled` 有「两个开关都开才绑定」的强关联（app.js:163 文案），却分处两页。

## 2. 范围

### 做

- 左树删「通用设置 → 代理」叶及计数；`CFG_NAV` 删对应映射。
- `#agents-view` 顶部加 `.tabs`（复用审计页样式）：列表 / 结算 / 调账 / 对账 / 审计 / 设置，默认「列表」。
- 设置页签 = 总开关 / 结算参数 / 调账限额 三组 + 邀请码开关行（`buildSimpleRow('agent.inviteEnabled')`）。
- 数据按页签懒加载；对账首次激活种默认区间并跑一次。
- 静态闸补充结构/交叉断言；新增 jsdom 探针覆盖页签状态机与角色门面。

### 不做（YAGNI）

- 不改任何 API / 数据库 / 协议 / conformance 切片 / agent 门户。
- 不新增折叠树或二级菜单（沿用 2026-10-21 IA 合并设计的裁决）。
- 不把 `agent_settings` 迁移为配置键（独立表与独立端点）。
- 不改配置中心搜索面本身（快照键仍可搜到；仅补按角色收权，见 D14）。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 唯一入口 = 「运营 → 代理」（`nav-agents-btn`）；删 `nav-cfg-agent-btn` 与 `nav-count-agent` | 用户裁决 |
| D2 | `CONFIG_IA` **保留** `agent` 域（1 键），只删左树叶 | 静态闸断言 IA 覆盖 85 个 active 键；删域会触发「未漏 active 键」失败并波及 protocol 计数 |
| D3 | 6 页签：`列表 / 结算 / 调账 / 对账 / 审计 / 设置`；面板 `agent-panel-*`，按钮 `agent-tab-*` | 与设计 §9.1 六面一致；`.tabs/.tab-btn` 复用审计页 |
| D4 | 新建、列表详情留在「列表」页签；结算单详情留在「结算」页签 | 附属面板不单独立页签 |
| D5 | 设置页签三组：总开关（`ag-settings-enabled` + 邀请码行）、结算参数、调账限额；**邀请码行容器 `#ag-invite-row` 放在 `#ag-settings-form` 之外** | 分组降密度；容器在表单外避免 Enter 误提交（审查 #7） |
| D6 | 邀请码行用 `buildSimpleRow`（自带保存/还原/版本号）；agent_settings 保留「保存设置」 | 用户裁决；两条链路各自幂等 |
| D7 | 邀请码行角色：代理页可见者都可见；非 super_admin 只读 | 用户裁决；P8 放行 finance 读快照，P-ag0 限写 |
| D8 | 按页签懒加载；对账首次激活种默认区间并跑一次 | 用户裁决 |
| D9 | 状态：`agentsState.tab`（默认 `list`）+ `epoch` + `roleApplied` + `list/settings.{loaded,loading}` + `recon.armed`；`resetAgents()` 复位 tab/roleApplied、各 loaded、`recon.armed`，`epoch++`，清空 `#ag-invite-row` 与页签高亮（仅 UI 复位，不触发渲染） | 审查 #2/#5：登出必须清零；epoch 防迟到响应 |
| D10 | **单调用方、分区自锁**：`switchView('agents')` = `applyAgentRole()` + `switchAgentTab(tab)` + `loadAgents()`；页签点击 = `switchAgentTab(id)` + `loadAgents()`。`switchAgentTab` 只做 UI；`loadAgents` **删全局早退**，按区块 `loading/loaded` 自锁，成功才置 `loaded` | 审查 #1：原全局 `loading` 早退会漏请求；双调用方需幂等 |
| D11 | 设置页签**每次激活无条件重建**邀请码行（`textContent=''` 后 `buildSimpleRow`）与表单回填（`renderAgentSettings`，有 state 时）；`loadAll` 补「agents+settings ⇒ 重建邀请码行」 | 审查 #7：草稿/版本号跨页签与配置中心搜索保存后不陈旧 |
| D12 | 静态闸：删叶负断言 + CFG_NAV↔HTML 双向交叉断言 + 6 组 tab/panel + `ag-invite-row` + `AGENT_TABS` 字面量抽取执行 + 初始仅 list 可见 + 页签按钮在 `wireAgents` 绑定 | 审查 #6/#11：防半删白屏与死按钮 |
| D13 | 所有代理 loader 在 `await` 后、提交状态前校验 `agentsState.epoch` 与 token；不符直接丢弃响应 | 审查 #5：登出后迟到 200 不得置 loaded/渲染 |
| D14 | 配置行按角色收权：`canWriteConfigKey(key)` = super_admin，或 operator 且非 `agent.` 前缀；`buildSimpleRow` 据此隐藏保存/还原（`hidden` 属性）并禁用输入 | 审查 #12：operator 搜到 `agent.inviteEnabled` 可编辑卡片但保存必 403（P-ag0）；与代理页邀请码行复用同一判定 |
| D15 | 新增 `scripts/admin-agents-probe.mjs`（照 `admin-players-probe.mjs` 的 jsdom 模式）：桩 fetch 覆盖 6 页签分派、finance 只读、operator 不可达、登出复位 | 审查 #8：静态闸覆盖不了状态机 |

## 4. 实现设计

### 4.1 标记（admin/index.html）

- 删除「通用设置」组内 `nav-cfg-agent-btn`。
- `#agents-view` 首子节点加 `.tabs`（6 个 `agent-tab-*`，list 带 `active`）。
- 原 8 个 `<section class="panel">` 包进 6 个 `<div id="agent-panel-*" class="agent-panel" hidden>`（list 不带 hidden）：
  - `agent-panel-list`：列表 + `ag-create-panel` + `ag-detail`；
  - `agent-panel-settlements`：结算队列 + `ag-settle-detail`；
  - `agent-panel-adjustments` / `agent-panel-recon` / `agent-panel-audit`：各自 section；
  - `agent-panel-settings`：设置表单（三组 `h3.panel-title.sub`）+ 表单**外**的 `<div id="ag-invite-row"></div>`。
- 全部 `ag-*` id 原样保留。

### 4.2 状态机（admin/app.js）

```js
const AGENT_TABS = [
  { id: 'list', btn: 'agent-tab-list', panel: 'agent-panel-list' },
  { id: 'settlements', btn: 'agent-tab-settlements', panel: 'agent-panel-settlements' },
  { id: 'adjustments', btn: 'agent-tab-adjustments', panel: 'agent-panel-adjustments' },
  { id: 'recon', btn: 'agent-tab-recon', panel: 'agent-panel-recon' },
  { id: 'audit', btn: 'agent-tab-audit', panel: 'agent-panel-audit' },
  { id: 'settings', btn: 'agent-tab-settings', panel: 'agent-panel-settings' },
];
function applyAgentTabUI(tab) { /* active + hidden 切换，仅 UI */ }
function switchAgentTab(tab) { agentsState.tab = tab; applyAgentTabUI(tab);
  if (tab === 'settings') { renderAgentSettings(); renderAgentInviteRow(); } }
```

- `loadAgents()`：按 tab 分派；各区块先判 `loading || loaded`；`const epoch = agentsState.epoch`，每个 await 后 `if (agentsState.epoch !== epoch || !sessionStorage.getItem(TOKEN_KEY)) return;` 再提交。
- `ensureConfigSnapshot()`：await `loadAll()` 后以 `Object.keys(currentConfig).length === 0` 判定失败；失败则不置 `settings.loaded`，邀请码行渲染占位并禁用。
- `applyAgentRole()` 增加 `if (agentsState.roleApplied) return;` 守卫，末尾置真（resetAgents 复位），避免重复切视图把新建面板收起。
- `switchView('agents')`：`applyAgentRole(); switchAgentTab(agentsState.tab); loadAgents();`（保留闸钉的 `loadAgents()` 字面量）。
- 页签点击在 `wireAgents`：`for (const t of AGENT_TABS) $(t.btn).addEventListener('click', () => { switchAgentTab(t.id); loadAgents(); });`
- `loadAgentTree` 失败补 `showMsg('加载代理树失败…')`（审查 #13）。

### 4.3 设置页签渲染

- `renderAgentInviteRow()`：先 `textContent=''`；无快照 ⇒ 占位 `<p class="hint">`；有快照 ⇒ `buildSimpleRow('agent.inviteEnabled')`。只读收权由 D14 的 `canWriteConfigKey` 在行内完成。
- `renderAgentSettings()` 每次激活调用（`agentsState.settings` 为 null 时只清状态文案，等 loader 回来再渲染）。
- 保存：表单 submit → `saveAgentSettings`；邀请码行 → `saveRow`（`loadAll` 后按 D11 重建）。

### 4.4 角色与门面

- `VIEWS.agents` 角色不变；`canAgentWrite/canAgentSettle` 不动。
- `canWriteConfigKey(key)`：super_admin ⇒ true；operator ⇒ 非 `agent.` 前缀；其余 false。`buildSimpleRow` 用它收权（隐藏 `.row-actions` 的按钮用 `hidden` 属性 + `input.disabled`）。
- 邀请码行在代理页：finance 由 D14 自动只读；agent_settings 表单由 `applyAgentRole` 的 super_admin 门面控制。

## 5. 测试判据

1. `pnpm verify:admin` 先红后绿。新增断言：
   - 三件套无 `nav-cfg-agent-btn` / `nav-count-agent`；CFG_NAV 每项 leaf/count 在 HTML 存在（双向）；
   - HTML 含 6 `agent-tab-*` + 6 `agent-panel-*`（仅 list 非 hidden）+ `ag-invite-row`；
   - 抽取 `AGENT_TABS` 字面量执行，六项与 HTML 一一对应；
   - `switchAgentTab` / `renderAgentInviteRow` / `ensureConfigSnapshot` / `canWriteConfigKey` 存在；`resetAgents` 含 tab/roleApplied/epoch 复位；`wireAgents` 绑定页签；`switchView` agents 分支含 `loadAgents()`。
2. 既有 60+ `ag-*` id 针脚、IA 85 键、`VIEWS.agents` 角色串、`canAgentWrite/canAgentSettle` 正则保持通过。
3. 新增 `node scripts/admin-agents-probe.mjs`：jsdom + 桩 fetch，断言
   - super_admin：6 页签可切；首次切设置页签才发 `/agents/settings` 与 `/admin/config`；列表页签只发 agents/tree；
   - finance：设置页签无保存按钮、输入 disabled；结算页签可打款/驳回；
   - operator：`nav-agents-btn` hidden、直接 `switchView('agents')` 落默认视图；
   - 登出：`resetAgents` 后页签回列表、`#ag-invite-row` 为空、重登重新拉取。
4. 冒烟（真浏览器或探针覆盖不到的部分人工复核并记录）：保存邀请码后版本号刷新；配置中心搜索保存后回代理页不陈旧。

## 6. 错误处理与边界

- 单区块失败只降级该页签；`loadAgentTree` 失败补提示（新建上级下拉空）。
- 配置快照失败：邀请码行占位 + 禁用保存；`settings.loaded` 保持 false，重进页签重试。
- 迟到响应：D13 epoch/token 双重校验。
- 登录过期：`handleAuth` 回登录 + 全量清零（含邀请码行）。
- 详情面板跨页签保留；对账不自动重跑。
- `agent.inviteEnabled` 缺键：`buildSimpleRow` 原兜底（`v?`），保存交服务端校验。

## 7. 风险

- CFG_NAV 半删会导致三处循环抛错白屏 —— D12 双向断言兜底（审查 #6）。
- `loadAgents` 语义变化影响 `switchView` 懒加载 —— 进页恒调用，区块自锁幂等（D10）。
- 全局 `drafts` 同一键可有两张卡片（配置中心 + 代理页）—— 每次激活重建 + 保存后重建（D11）。
- `.agent-panel` 必须补 flex-column + 14px gap，否则包裹后丢失 `.page-view` 的间距（审查 #9）。
- 只读收权必须用 `hidden` 属性（`.row-card.dirty .row-actions{display:flex}` 会压过类名隐藏，审查 #10）。

## 8. 涉及文件

- `admin/index.html`、`admin/app.js`、`admin/style.css`（`.agent-panel`）。
- `scripts/verify-admin-static.mjs`（结构/交叉断言）。
- `scripts/admin-agents-probe.mjs`（新增）、`package.json`（新增 `verify:admin-agents` 脚本）。

## 9. 审查记录

独立 reviewer（子代理）对抗审查，2 阻断 / 6 高 / 5 低，处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 阻断 | `loadAgents` 全局早退 + 双调用方 ⇒ 漏请求/重复请求 | D10 单调用方 + 分区自锁；删全局早退 |
| 2 | 阻断 | `resetAgents` 未清邀请码行/`recon.armed`/角色守卫 ⇒ 跨会话陈旧 | D9 明列复位项；D11 每次激活重建 |
| 3 | 高 | `applyAgentRole` 每次进视图都收起新建面板 | `roleApplied` 守卫（D9/D10） |
| 4 | 高 | `loadAll` 失败无法感知 ⇒ 占位/禁用无依据 | `ensureConfigSnapshot` 以快照键数判定（§4.2） |
| 5 | 高 | 迟到响应可污染新会话状态 | D13 epoch + token 校验 |
| 6 | 高 | CFG_NAV 半删白屏；闸无负断言/交叉断言 | D12 双向交叉断言 |
| 7 | 高 | 设置页签重建时机与容器位置（Enter 误提交） | D5 容器移出表单 + D11 每次重建 |
| 8 | 高 | 静态闸覆盖不了懒加载/角色/复位 | D15 jsdom 探针 |
| 9 | 低 | `.agent-panel` 需补间距规则 | §7 + 实现补 `.agent-panel` |
| 10 | 低 | 只读收权用类名会被 `.dirty` 规则压过 | `hidden` 属性（D14） |
| 11 | 低 | `AGENT_TABS` 不能整文件 vm，需抽字面量 | D12 抽取字面量 + 初始可见/绑定断言 |
| 12 | 低 | operator 配置搜索卡片仍可编辑但 403 | D14 `canWriteConfigKey` 统一收权 |
| 13 | 低 | `agentsState.loaded/loading` 成死字段；树加载静默 | 删除死字段；树失败补提示 |
| 14 | — | P8 放行 finance 读快照、P-ag0 阻断写、现有针脚不假红 | 已核对，无需动作 |
