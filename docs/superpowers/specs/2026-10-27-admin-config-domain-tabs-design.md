# 配置中心分域页签：重内容域拆成页内页签 — 设计

- 日期：2026-10-27
- 状态：待对抗审查
- 范围：`admin/` 静态三件套 + `scripts/verify-admin-static.mjs` + 新增 jsdom 探针；**不动** CONFIG_IA 键集合 / API / 协议 / 服务端
- 用户裁决：配置内容较多的域（斗地主、跑得快等）参考代理工作台，拆成独立页签。

## 1. 背景与问题

`CONFIG_IA` 早已按「域 → 页签」定义配置归属（斗地主 6 个、跑得快 6 个、风控安全 5 个、
支付与提现 3 个、货币经济 2 个、房间与机器人 2 个；广告/对局记录/代理各 1 个）。
但 v2.1 渲染时把所有页签的键**按顺序堆成一页**（`renderConfigRows` 里每个页签只生成一个
`h3.settings-section` 标题），重内容域需要长距离滚动，且不同页签的键混在一起。

2026-10-26 代理工作台已采用「页内 6 页签」形态（`.tabs` / `.tab-btn`），本次把同一形态
用于配置中心的重内容域。

## 2. 范围

### 做

- 任意 `CONFIG_IA` 域若 `tabs.length > 1`：页面顶部（玩法开关键卡之后）渲染页内页签；
  只渲染**当前页签**的键。
- 单页签域（广告 / 对局记录 / 代理 / 未分组）保持现状（无页签条、保留分区标题）。
- 搜索态保持**全量扁平结果**（跨域、跨页签），不渲染页签条；清空搜索回到原域+原页签。
- 页签状态 `cfgUI.tabId`：切域复位；默认取「第一个有键的页签」；显式点击空页签则停留在空态。

### 不做（YAGNI）

- 不改 `CONFIG_IA` 的域/页签/键归属，不改 85 键计数与静态闸的键集合断言。
- 不改配置保存链路（`saveRow` / `loadAll` / drafts）。
- 不改代理工作台、凭据两页、其它运营视图。
- 不引入折叠、二级树或 URL 路由。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 页签条对所有 `tabs.length > 1` 的域生效（ddz/pdk/risk/pay/currency/roomOps） | 统一规则，避免「重内容」主观阈值；roomOps 暂无左树叶，仅影响未来可达路径 |
| D2 | 复用 `.tabs` / `.tab-btn`（审计/代理页同款），容器类名 `cfg-tabs` | 零新增视觉语言；静态闸可钉 `cfg-tabs` |
| D3 | 状态 `cfgUI.tabId`（默认 null）；`openCfgDomain` 复位；渲染时解析：有效则用，失效则取第一个**有键**的页签 | 切域不串页签；快照缺键时不落空页 |
| D4 | 多页签域只渲染当前页签的键，且**不再渲染 `h3.settings-section`**；单页签域保留原分区标题 | 页签名已承担标题职责，避免重复 |
| D5 | 搜索态：不渲染页签条、按现有扁平结果渲染；`cfgUI.query` 非空时不改 `tabId` | 搜索语义不变；清空后回到原页签 |
| D6 | 玩法顶部开关键卡保持在页签条**之前** | 它是域级开关（斗地主/跑得快开关），不属某个页签 |
| D7 | 页签点击：更新 `tabId` → `renderConfigRows()`（非 preserve）→ `settings-host.scrollTop = 0` | 与左树叶切换一致的滚动语义 |
| D8 | 保存后 `loadAll()` 的 preserve 重渲染保留当前 `tabId` 与滚动位置 | 现有行为不退化；草稿由 drafts 承载 |
| D9 | 测试：静态闸新增结构断言 + 新增 jsdom 探针（页签切换/搜索/单页签域/零异常），接入 `scripts/ci.sh` | 静态闸无法验证状态机；同代理工作台先例 |

## 4. 实现设计

### 4.1 状态

```js
const DEFAULT_CFG_UI = () => ({ domainId: 'ddz', query: '', tabId: null });
```

- `openCfgDomain(domainId)`：`cfgUI.tabId = null`（切域复位）。
- `normalizeCfgDomain()` 若把域改掉：`cfgUI.tabId = null`。
- `renderConfigRows` 非搜索分支解析当前页签：
  - `tabs = domain.tabs`；
  - `stored = tabs.find(t => t.id === cfgUI.tabId)`；
  - 若 `stored` 存在 ⇒ 用它（即使该页签无键，尊重显式点击）；
  - 否则取第一个 `t.keys.some(k => k in currentConfig)` 的页签；再退 `tabs[0]`；
  - 写回 `cfgUI.tabId = active?.id ?? null`。

### 4.2 渲染（`renderConfigRows`）

非搜索、`tabs.length > 1` 时：

1. 先渲染 `headerDomain.headerKeys` 的开关键卡（现状不变）。
2. 追加 `buildConfigTabStrip(domain, tabs)`：`div.tabs.cfg-tabs` + 每个页签一个
   `button.tab-btn`（`active` 按 `cfgUI.tabId`），点击写入 `tabId` 并重渲染 + 滚到顶。
3. 只渲染 active 页签的键（过滤 `k in currentConfig`），不渲染 `h3.settings-section`。

`tabs.length === 1`：维持现状（逐页签分区标题 + 键）。

搜索态（`q` 非空）：维持现状（扁平结果、无页签条、无开关键卡）。

空态：`rendered === 0` 时仍显示「（暂无可展示的配置键）」。

### 4.3 CSS

```css
.cfg-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 4px;
}
```

（`.tabs` / `.tab-btn` 复用现有规则。）

### 4.4 静态闸

- `DEFAULT_CFG_UI` 含 `tabId`；`openCfgDomain` 含 `cfgUI.tabId = null`。
- 存在 `function buildConfigTabStrip`；`renderConfigRows` 块含 `cfg-tabs`。
- `style.css` 含 `.cfg-tabs` 规则。
- 既有断言（85 键、IA 覆盖、`scrollEl.scrollTop = scrollTop`、零 innerHTML）保持。

### 4.5 探针（`scripts/admin-config-tabs-probe.mjs`）

jsdom + 桩 `/api/admin/config`（快照含斗地主 assist/rooms 键、跑得快 switches 键、广告键）：

1. 默认进入斗地主：`.cfg-tabs` 6 个按钮；默认页签=第一个有键页签；只渲染该页签键。
2. 点「场次开关」：该页签键出现，前一页签键消失。
3. 点跑得快叶：页签复位到第一个有键页签，6 个按钮。
4. 搜索 `cardCounter`：`.cfg-tabs` 不存在，跨域扁平结果出现。
5. 清空搜索：回到斗地主原页签。
6. 点广告叶：无 `.cfg-tabs`（单页签域）。
7. 全程零运行时异常。

## 5. 测试判据

- `pnpm verify:admin` 先红后绿（新增结构断言）。
- `node scripts/admin-config-tabs-probe.mjs` 先红后绿。
- `pnpm verify:admin-players`、`node scripts/admin-agents-probe.mjs` 回归通过。
- `node --check admin/app.js`。

## 6. 边界与风险

- 快照缺键：默认页签跳过空页签；显式点空页签显示空态（不自动跳走）。
- `tabId` 失效（域切换/快照变化）：回退第一个有键页签。
- 搜索中切域：`openCfgDomain` 清空 query（现状），页签复位。
- 保存后 preserve 渲染：保持 `tabId` 与滚动位置；焦点恢复逻辑不变。
- 单页签域/数据广告面板（`syncAdSection`）不受影响。
- 与 v2.1「无页签」旧决策的关系：仅在「多页签域」恢复页签，搜索与单页签域保持 v2.1 形态。

## 7. 涉及文件

- `admin/app.js`：`DEFAULT_CFG_UI`、`cfgUI`、`openCfgDomain`、`normalizeCfgDomain`、`renderConfigRows`、新增 `buildConfigTabStrip`。
- `admin/style.css`：`.cfg-tabs`。
- `scripts/verify-admin-static.mjs`：结构断言。
- `scripts/admin-config-tabs-probe.mjs`（新增）、`package.json`、`scripts/ci.sh`。

## 8. 审查记录

（对抗审查后回填）
