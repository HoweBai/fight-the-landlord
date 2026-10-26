# 代理工作台：单入口 + 页内页签 — 设计

- 日期：2026-10-26
- 状态：待对抗审查
- 范围：`admin/` 静态三件套 + `scripts/verify-admin-static.mjs`；**不动**协议 / 服务端 / 数据库 / conformance 切片
- 用户裁决：
  1. 方案 A：只留「运营 → 代理」一个入口，页内 6 页签合并代理的全部配置与运营面；
  2. 邀请码开关（`agent.inviteEnabled`）并入设置页签，能进代理页的角色都可见（finance 只读）；
  3. 数据按页签懒加载；
  4. 两组设置各自独立保存。

## 1. 背景与问题

- 「通用设置 → 代理」叶（`nav-cfg-agent-btn`）只承接 1 个配置键 `agent.inviteEnabled`；
- 「运营 → 代理」（`#agents-view`）把 8 个面板（总开关与参数 / 新建 / 详情 / 列表 / 结算 / 调账 / 对账 / 审计）纵向堆在一页，进页并行发 7 个 GET，视觉与认知负担都重；
- 2026-10-26 代理分润设计 §9.1 原本就规划「代理导航区，页签」，实现时退化为长页；
- 两个「代理」入口语义重叠：`agent.inviteEnabled` 与 `agent_settings.enabled` 有「两个开关都开才绑定」的强关联（app.js:163 文案），却分处两页。

## 2. 范围

### 做

- 左树删「通用设置 → 代理」叶及计数；`CFG_NAV` 删对应映射。
- `#agents-view` 顶部加 `.tabs`（复用审计页样式）：列表 / 结算 / 调账 / 对账 / 审计 / 设置，默认「列表」。
- 设置页签 = 总开关 / 结算参数 / 调账限额 三组 + 邀请码开关行（`buildSimpleRow('agent.inviteEnabled')`）。
- 数据按页签懒加载；对账首次激活种默认区间并跑一次。
- 静态闸补充结构断言。

### 不做（YAGNI）

- 不改任何 API / 数据库 / 协议 / conformance 切片 / agent 门户。
- 不新增折叠树或二级菜单（沿用 2026-10-21 IA 合并设计的裁决）。
- 不把 `agent_settings` 迁移为配置键（它是独立表与独立端点）。
- 不改配置中心的搜索面（快照键仍可搜到 `agent.inviteEnabled`，作为兜底只读/编辑路径）。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 唯一入口 = 「运营 → 代理」（`nav-agents-btn`）；删 `nav-cfg-agent-btn` 与 `nav-count-agent` | 用户裁决；运营面与配置面合并后归运营组 |
| D2 | `CONFIG_IA` **保留** `agent` 域（1 键），只删左树叶 | 静态闸断言 IA 覆盖 85 个 active 键；删域会同时触发「未漏 active 键」失败，且波及 protocol 计数与 conformance 针脚 |
| D3 | 6 个页签：`列表 / 结算 / 调账 / 对账 / 审计 / 设置`；面板 id `agent-panel-{list,settlements,adjustments,recon,audit,settings}`，按钮 id `agent-tab-*` | 与设计 §9.1 的六面一致；`.tabs/.tab-btn` 复用审计页 |
| D4 | 新建、列表详情留在「列表」页签；结算单详情留在「结算」页签 | 它们是所在区块的附属面板，不单独立页签 |
| D5 | 设置页签三组：总开关（`ag-settings-enabled` + 邀请码行）、结算参数（默认比例/最低结算/结算汇率/额度成熟天数）、调账限额（单玩家单日计额上限/单笔调账上限/单代理单日调账上限） | 8 个字段按语义分组，降低单屏密度；字段 id 全部不变 |
| D6 | 邀请码行用配置中心同款行（`buildSimpleRow`），自带保存/还原/版本号；agent_settings 保留「保存设置」按钮 | 用户裁决（各自独立保存）；两条链路各自幂等，失败语义不混淆 |
| D7 | 邀请码行角色：代理页可见者（super_admin / finance）都可见；非 super_admin 隐藏保存/还原、禁用输入 | 用户裁决；GET /api/admin/config 落网关 P8（任意角色可读），写面 P-ag0 限 super_admin；UI 只做门面 |
| D8 | 按页签懒加载：列表→`agents`+`agents/tree`；设置→`agents/settings`+`config` 快照；结算/调账/审计→各自端点；对账→首次激活种默认区间并跑一次 | 用户裁决；首屏只承担列表开销 |
| D9 | 页签状态 `agentsState.tab`（默认 `list`），会话内保留；`resetAgents()` 复位为 `list` 并清各区块 loaded | 与审计页 `audit.tab` 同族 |
| D10 | 保留函数名 `loadAgents()`，语义改为「确保当前页签数据已加载」；`switchView('agents')` 仍调用它 | 静态闸已钉 `switchView` 含 `loadAgents()`；改名会无谓改闸 |
| D11 | 邀请码保存成功后：`saveRow → loadAll()`；`loadAll` 补「`activeView==='agents'` 且 `settings` 页签 ⇒ 重渲染邀请码行」 | `loadAll` 只重渲染 config 视图；不补则版本号/取值陈旧 |
| D12 | 静态闸：新增旧叶/旧计数消失、6 组 `agent-tab-*`/`agent-panel-*`、`ag-invite-row` 容器、`AGENT_TABS` 映射自洽（vm 执行）断言；既有 `ag-*` 针脚与 IA 85 键断言保持 | 机械闸跟随结构真源，防回潮 |

## 4. 实现设计

### 4.1 标记（admin/index.html）

- `<aside id="side-nav">`：删除「通用设置」组内 `<button id="nav-cfg-agent-btn">`。
- `#agents-view` 首个子节点加：

```html
<div class="tabs">
  <button id="agent-tab-list" type="button" class="tab-btn active">列表</button>
  <button id="agent-tab-settlements" type="button" class="tab-btn">结算</button>
  <button id="agent-tab-adjustments" type="button" class="tab-btn">调账</button>
  <button id="agent-tab-recon" type="button" class="tab-btn">对账</button>
  <button id="agent-tab-audit" type="button" class="tab-btn">审计</button>
  <button id="agent-tab-settings" type="button" class="tab-btn">设置</button>
</div>
```

- 原 8 个 `<section class="panel">` 按归属包进 6 个面板容器：
  - `agent-panel-list`：列表筛选/表格/分页 + `ag-create-panel` + `ag-detail`；
  - `agent-panel-settlements`：结算队列 + `ag-settle-detail`；
  - `agent-panel-adjustments`、`agent-panel-recon`、`agent-panel-audit`：各自唯一 section；
  - `agent-panel-settings`：设置表单拆三组 + `<div id="ag-invite-row"></div>`。
- 面板容器首屏 `hidden`（除 list），容器内 section 不变；全部 `ag-*` id 原样保留。

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
function switchAgentTab(tab) { /* 高亮 + 面板显隐 + loadAgents() + 设置页签渲染邀请码行 */ }
```

- `agentsState` 增加 `tab: 'list'`、`list: { loaded, loading }`、`settings: { loaded, loading }`；
- 结算/调账/审计沿用各自 `loaded/loading`；对账新增 `armed`（默认区间已种）。
- `loadAgents()` = 按 `agentsState.tab` 分派到 `loadAgentList`+`loadAgentTree` / `loadAgentSettings`+`ensureConfigSnapshot` / `loadAgentSettlements` / `loadAgentAdjustments` / `loadAgentAudit` / `armAgentRecon`。已 `loaded` 的区块不重复请求。
- `ensureConfigSnapshot()`：`Object.keys(currentConfig).length === 0` 时调 `loadAll()`；失败降级为邀请码行「（配置快照加载失败，重进页签重试）」并禁用保存。
- `resetAgents()` 增加页签与各 loaded 清零；`switchView('agents')` 入口调用 `applyAgentRole()`（一次，避免重跑时误隐藏新建面板）+ `switchAgentTab(agentsState.tab)`。

### 4.3 设置页签渲染

- `renderAgentInviteRow()`：容器 `#ag-invite-row`；无快照 ⇒ 占位提示；有快照 ⇒ `buildSimpleRow('agent.inviteEnabled')`，随后按 `canAgentWrite()` 收权（隐藏 `.row-actions` 的保存/还原、`input.disabled = true`）。
- 表单三组用 `<h3 class="panel-title sub">` 分隔，字段与 id 原样。
- 保存入口：表单 `submit` 仍走 `saveAgentSettings`；邀请码行走 `saveRow`。

### 4.4 角色与门面

- `VIEWS.agents` 角色不变（`super_admin|finance`）；`canAgentWrite` / `canAgentSettle` 不动。
- `applyAgentRole()` 增加：`#ag-invite-row` 内控件的读写收权在 `renderAgentInviteRow` 内完成（渲染后调用），避免与表单控件列表耦合。

## 5. 测试判据

1. `pnpm verify:admin` 先红后绿。新增断言：
   - 三件套已无 `nav-cfg-agent-btn` / `nav-count-agent`；
   - `index.html` 含 6 个 `agent-tab-*` 与 6 个 `agent-panel-*`，且 `ag-invite-row` 存在；
   - `AGENT_TABS` 六项与 HTML 的 tab/panel id 一一对应（vm 执行映射自洽）；
   - `switchAgentTab` / `renderAgentInviteRow` / `ensureConfigSnapshot` 存在；
   - `resetAgents` 复位 `tab: 'list'`；`switchView` 的 agents 分支仍含 `loadAgents()`。
2. 既有 60+ `ag-*` id 针脚、IA 85 键、`VIEWS.agents` 角色串、`canAgentWrite/canAgentSettle` 正则全部保持通过。
3. 冒烟矩阵（本地静态服务 + 真浏览器，或按环境能力以静态闸 + 代码走查替代并记录）：
   - super_admin：6 页签可达；设置页签可保存 agent_settings 与邀请码；列表/结算/调账/对账/审计各自加载；
   - finance：6 页签可达；设置页签全部只读（无保存按钮、输入禁用）；结算可打款/驳回；
   - operator：左树无「代理」叶、配置树无「代理」叶，直接访问 `agents` 视图被 `canView` 兜底；
   - 登出再登录：页签复位「列表」。

## 6. 错误处理与边界

- 单区块失败只降级该页签（沿用现有 `showMsg` + 空态文案），不阻塞其他页签。
- 配置快照失败：邀请码行显示占位、禁用保存；重进设置页签重试。
- 登录过期：`handleAuth` 统一回登录视图，行为不变。
- 详情面板打开时切换页签：DOM 保留、状态不清；返回列表页签仍可见。
- 对账不因页签切换自动重跑（仅首次激活跑一次，后续手动点「对账」）。
- 邀请码行在 `agent.inviteEnabled` 快照缺失（极端：键被移除）时按 `buildSimpleRow` 原有兜底（`v?`）显示，保存由服务端校验。

## 7. 风险

- 静态闸全文匹配 `nav-cfg-agent-btn` 的新增「消失」断言与 IA 保留域并存：需在 spec/plan 中写清「叶删、域留」，避免后续误删域。
- 页签懒加载改变 `loadAgents()` 语义：`switchView` 的 `loaded` 判断若沿用旧的单一 `agentsState.loaded` 会漏加载 —— 改为每次进页调用 `loadAgents()`（幂等）。
- `loadAll()` 的 agents 重渲染分支若位于 `activeView==='config'` 判断之外，需避免在 settings 页签未渲染时插入空容器操作。

## 8. 涉及文件

- `admin/index.html`：左树删叶；`#agents-view` 页签与面板容器；设置分组；`ag-invite-row`。
- `admin/app.js`：`CFG_NAV` 删项；`AGENT_TABS`、`switchAgentTab`、`loadAgents` 重构、`ensureConfigSnapshot`、`renderAgentInviteRow`；`resetAgents`、`loadAll`、`switchView`、`wireAgents` 接线。
- `admin/style.css`：必要时补 `.agent-panel`（`display:flex;flex-direction:column;gap:14px`，沿用 `[hidden]` 兜底），优先零新增。
- `scripts/verify-admin-static.mjs`：结构断言与 vm 映射自洽。

## 9. 审查记录

（对抗审查后回填）
