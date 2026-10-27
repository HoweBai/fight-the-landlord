# 配置中心分域页签：重内容域拆成页内页签 — 设计

- 日期：2026-10-27
- 状态：对抗审查已修订（2 阻断 + 6 高 + 7 低，见 §8），待实现计划
- 范围：`admin/` 静态三件套 + `scripts/verify-admin-static.mjs` + 新增 jsdom 探针；**不动** CONFIG_IA 键集合 / API / 协议 / 服务端
- 用户裁决：配置内容较多的域（斗地主、跑得快等）参考代理工作台，拆成独立页签。

## 1. 背景与问题

`CONFIG_IA` 早已按「域 → 页签」定义配置归属（斗地主 6、跑得快 6、风控安全 5、
支付与提现 3、货币经济 2、房间与机器人 2；广告/对局记录/代理各 1）。
但 v2.1 渲染时把所有页签的键**按顺序堆成一页**（`renderConfigRows` 里每个页签只生成一个
`h3.settings-section` 标题），重内容域需要长距离滚动。

代理工作台（2026-10-26）已采用「页内页签 + 各面板保留 DOM、只切 hidden」的形态，
本次把同一形态用于配置中心的重内容域。

## 2. 范围

### 做

- 任意 `CONFIG_IA` 域若 `tabs.length > 1`：渲染页内页签；**每个页签一个面板，全部渲染，
  仅 active 面板可见**（切换只改 `hidden`，不重建 DOM）。
- 单页签域（广告 / 对局记录 / 代理 / 未分组）保持现状（无页签条、保留分区标题）。
- 搜索态保持**全量扁平结果**（跨域、跨页签），不渲染页签条；清空搜索回到原域+原页签。
- 页签状态 `cfgUI.tabId` + `cfgUI.tabDomainId`（成对校验）；切域复位；默认取「第一个有键页签」；
  显式点击空页签停留在空态面板。

### 不做（YAGNI）

- 不改 `CONFIG_IA` 的域/页签/键归属，不改 85 键计数与静态闸的键集合断言。
- 不改配置保存链路（`saveRow` / `loadAll` / drafts / 结构化编辑器）。
- 不改代理工作台、凭据两页、其它运营视图。
- 不引入折叠、二级树或 URL 路由。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 页签条对所有 `tabs.length > 1` 的域生效（ddz/pdk/risk/pay/currency；roomOps 暂无左树叶，仅未来可达） | 统一规则；roomOps 无入口不产生行为 |
| D2 | 复用 `.tabs` / `.tab-btn`，容器只用 **class `cfg-tabs`**（不得用 id `cfg-tabs`：静态闸 REMOVED_IDS 已禁） | 零新增视觉语言；防假红 |
| D3 | **每个页签渲染为独立面板**（`div.cfg-tab-panel[data-tab]`），非 active 加 `hidden`；切换只 `applyCfgTabUI(tabId)`，**不重渲染** | 审查阻断 1：全量重建会丢 struct/JSON 未保存编辑（drafts 只覆盖简单行） |
| D4 | 多页签域不渲染 `h3.settings-section`；每个面板**按自身键数**判空，空则渲染「本页签暂无可展示的键」 | 审查阻断 2：header 开关键会污染全局 `rendered===0` 判空 |
| D5 | 状态 `cfgUI.tabId` + `cfgUI.tabDomainId`；渲染时仅当 `tabDomainId === domain.id` 才采用 `tabId`，否则取第一个有键页签并写回两者 | 审查高 5：ddz/pdk 有同名页签（rules/rooms/risk），必须按域配对 |
| D6 | `openCfgDomain` 仅在 `domainId !== cfgUI.domainId` 时复位页签；`normalizeCfgDomain` 改域时同样复位（写回 `tabDomainId`） | 审查高 6：重复点当前域叶不应重置页签 |
| D7 | 搜索态不渲染页签条、维持现有扁平结果；`cfgUI.query` 非空时不改 `tabId`/`tabDomainId` | 搜索语义不变；清空后回原域+原页签 |
| D8 | 玩法顶部开关键卡保持在页签条之前（域级开关）；页签切换不影响它（DOM 保留，PUT 在途也不重建） | 审查低 13 |
| D9 | 页签点击：`applyCfgTabUI` + `settings-host.scrollTop = 0`；按钮 `type="button"` + `data-tab` + `aria-selected`；容器限定 `#settings-rows .cfg-tabs` | 审查高 8/低 11/低 12 |
| D10 | 保存后 `loadAll()` 的 preserve 重渲染保留 `tabId`/`tabDomainId` 与滚动位置；焦点恢复逻辑不变 | 现有行为不退化 |
| D11 | 测试：静态闸新增结构/条件断言 + 新增 jsdom 探针（页签切换/DOM 保留/搜索/单页签域/零异常），接入 `scripts/ci.sh` | 静态闸无法验证状态机；同代理工作台先例 |

## 4. 实现设计

### 4.1 状态

```js
const DEFAULT_CFG_UI = () => ({ domainId: 'ddz', query: '', tabId: null, tabDomainId: null });
```

- `openCfgDomain(domainId)`：仅当域变化时 `cfgUI.tabId = null; cfgUI.tabDomainId = null;`。
- `normalizeCfgDomain()` 若改域：同样复位。
- `renderConfigRows` 非搜索分支解析：
  - `tabs = domain.tabs`；
  - `stored = cfgUI.tabDomainId === domain.id ? tabs.find(t => t.id === cfgUI.tabId) : null`；
  - 有 `stored` ⇒ 用它（显式点空页签也停留）；
  - 否则取第一个 `t.keys.some(k => k in currentConfig)` 的页签，再退 `tabs[0]`；
  - 写回 `cfgUI.tabId` / `cfgUI.tabDomainId`。

### 4.2 渲染（`renderConfigRows`）

非搜索、`tabs.length > 1` 时：

1. 渲染 `headerDomain.headerKeys` 开关键卡（现状不变）。
2. 追加 `buildConfigTabStrip(domain, tabs)`（`div.tabs.cfg-tabs`，每个页签一个 `button.tab-btn`）。
3. 逐页签渲染 `div.cfg-tab-panel[data-tab]`（非 active 加 `hidden`）：
   - 页签键集合 `t.keys.filter(k => k in currentConfig)`；
   - 空 ⇒ 面板内 `<p class="settings-empty cfg-tab-empty">本页签暂无可展示的键</p>`；
   - 非空 ⇒ 逐键 `buildKeyCard(key)`。
4. 多页签域**只按面板判空**（`cfg-tab-empty`）；全局 `settings-empty` 仅用于单页签域与搜索态。

`tabs.length === 1`：维持现状（`h3.settings-section` + 键）。

搜索态：维持现状（扁平结果、无页签条、无开关键卡）。

实现拆成 `renderCfgDomain(host, domain)`（非搜索域渲染：header 卡 → 页签条 → 面板/分区），
由 `renderConfigRows` **只在非搜索分支**调用；搜索分支保持扁平结果。

`applyCfgTabUI(tabId)`：遍历 `.cfg-tabs .tab-btn` 与 `.cfg-tab-panel`，切换 `active` /
`hidden` / `aria-selected`；写 `cfgUI.tabId`（`tabDomainId` 已在渲染时写定）。
点击已 active 的页签 = no-op（不滚动）。

### 4.3 CSS

```css
.cfg-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
.cfg-tab-panel { display: flex; flex-direction: column; gap: 10px; }
```

（`.tabs` / `.tab-btn` 复用现有规则；`[hidden]` 全局兜底已存在。）

### 4.4 静态闸

- `DEFAULT_CFG_UI` 含 `tabId` 与 `tabDomainId`。
- `openCfgDomain` 含条件复位（`tabDomainId = null`）。
- 存在 `function buildConfigTabStrip` 且 `renderConfigRows` 块**调用** `buildConfigTabStrip(`。
- 存在 `function renderCfgDomain`，其块含 `buildConfigTabStrip(`、`tabs.length > 1`、`cfg-tab-panel`；
- `renderConfigRows` 块含 `renderCfgDomain(`（搜索分支行为由探针覆盖，不用脆弱的文本截取断言）。
- `normalizeCfgDomain` 块含 `tabDomainId = null`；`renderCfgDomain` 块含 `tabDomainId === domain.id` 守卫。
- `CONFIG_IA` 的 `headerKeys` 与各页签键**无交集**（vm 执行 IA，逐域校验）。
- `style.css` 含 `.cfg-tabs` 与 `.cfg-tab-panel` 规则。
- 既有断言（85 键、IA 覆盖、`scrollEl.scrollTop = scrollTop`、零 innerHTML）保持。

### 4.5 探针（`scripts/admin-config-tabs-probe.mjs`）

jsdom + 登录态注入（`ftl-admin-token/username/role`）+ 桩 `/api/admin/config`，快照含：

- `game.doudizhu.enabled`（header 开关）
- assist 三键（`game.doudizhu.cardCounterEnabled` / 两个价格）
- ddz rooms 一键（`game.doudizhu.freeRoomEnabled`）
- pdk switches 一键（`game.paodekuai.twoPlayerEnabled`）+ pdk rooms 一键（`game.paodekuai.freeRoomEnabled`，跨域同名页签判别）
- 广告一键（`ad.reliefAdpid`）

桩另含 `/api/admin/ad-channel` → `{code:0,data:{keys:[]}}`；其余路径 `{code:0,data:{}}`。

用例（顺序即执行序）：

1. 等首屏 `#settings-rows .cfg-tabs .tab-btn` 出现（轮询 ≤1s）。
2. 默认斗地主：6 个按钮；active=对局辅助；assist 面板可见、rooms 面板 hidden。
3. **DOM 保留（判别性）**：保存 assist 面板内 cardCounter 复选框的**节点引用**；勾选；切到「场次开关」；
   切回「对局辅助」；断言当前复选框 === 保存的节点引用且 checked（排除 drafts 还原造成的假绿）。
4. **空页签提示**：点「玩法规则」→ 面板可见且含 `p.cfg-tab-empty` 文案「本页签暂无可展示的键」。
5. **不重置**：点「场次开关」→ active=场次开关；再点斗地主叶 → 仍为场次开关（D6）。
6. **搜索**：搜索 `freeRoomEnabled` → 无 `.cfg-tabs`；ddz 与 pdk 的同名键均在扁平结果；清空 → 回斗地主且
   active=场次开关。
7. **跨域同名页签**：切跑得快 → active=开关（若 `tabDomainId` 守卫缺失，`rooms` 会串到 pdk 的 rooms 页签，
   断言失败）。
8. **重复点 active 页签 no-op**：`settings-host.scrollTop = 50`，点当前 active 页签，断言 scrollTop 仍 50。
9. 点广告叶 → 无 `.cfg-tabs`，`ad.reliefAdpid` 行存在。
10. 全程零运行时异常 / 零未处理 rejection。

选择器一律限定 `#settings-rows`；工具用 `clickIf`（不存在返回 false，不抛）。

## 5. 测试判据

- `pnpm verify:admin` 先红后绿（新增结构/条件断言）。
- `node scripts/admin-config-tabs-probe.mjs` 先红后绿。
- `pnpm verify:admin-players`、`node scripts/admin-agents-probe.mjs` 回归通过。
- `node --check admin/app.js`。

## 6. 边界与风险

- 快照缺键：默认页签跳过空页签；显式点空页签显示面板空态（不自动跳走）。
- `tabId` 跨域同名：以 `tabDomainId` 配对，杜绝 ddz 的 `rules` 映射到 pdk。
- 搜索清空：回原域+原页签；搜索期间的简单行草稿由 drafts 保留（现状）。
- 保存后 preserve 渲染：`tabId`/`tabDomainId`、滚动、焦点恢复保持；**保存仍会全量重建**（现状），
  本次只保证「切页签不丢未保存编辑」。
- 单页签域/广告回调面板（`syncAdSection`）不受影响。
- 已接受的取舍（审查低 14）：自动选中的页签会写回 `tabId`，之后快照缺键时停在空面板而非自动跳走；
  用户可手动切页签。记录在案，不额外加 explicit 标记。
- roomOps/records 无左树叶（仅搜索可达），本次不新增入口（审查低 9）。

## 7. 涉及文件

- `admin/app.js`：`DEFAULT_CFG_UI`、`cfgUI`、`openCfgDomain`、`normalizeCfgDomain`、`renderConfigRows`、新增 `renderCfgDomain` / `resolveCfgTab` / `buildConfigTabStrip` / `applyCfgTabUI`。
- `admin/style.css`：`.cfg-tabs` / `.cfg-tab-panel`。
- `scripts/verify-admin-static.mjs`：结构/条件/IA 交叉断言。
- `scripts/admin-config-tabs-probe.mjs`（新增）、`package.json`、`scripts/ci.sh`。

## 8. 审查记录

独立 reviewer 设计对抗审查：2 阻断 / 6 高 / 7 低，处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 阻断 | 切页签全量重建丢 struct/JSON 未保存编辑 | D3 改为「全面板渲染、只切 hidden」 |
| 2 | 阻断 | header 键使全局空态失效，空页签无提示 | D4 每面板独立空态 |
| 3 | 高 | 探针顺序跨域不可达 | §4.5 用例顺序重排（搜索在切 pdk 前） |
| 4 | 高 | 探针桩/断言口径未定死 | §4.5 列明快照键与 active 期望；header 键不参与面板断言 |
| 5 | 高 | tabId 跨域同名 | D5 `tabDomainId` 配对 |
| 6 | 高 | 重复点当前域叶重置页签 | D6 仅域变化时复位 |
| 7 | 高 | 闸断言可假绿/容器 id 撞 REMOVED_IDS | D2 仅 class；§4.4 钉调用/条件/搜索顺序 |
| 8 | 高 | 探针作用域与异步 | D9 选择器限定；§4.5 首屏等待 |
| 9 | 低 | roomOps/records 无入口 | 记录，不新增入口 |
| 10 | 低 | headerKeys 与 tabs 未来可能重叠 | §4.4 IA 交叉断言 |
| 11 | 低 | 页签点击焦点丢失 | D3 DOM 保留后不再发生 |
| 12 | 低 | 按钮可访问性 | D9 type/data-tab/aria-selected |
| 13 | 低 | 开关键 PUT 在途切换 | D8 DOM 保留，不重建 |
| 14 | 低 | 自动落选页签写回无法区分显式 | §6 记录为已接受取舍 |
| 15 | 低 | 其余无回归 | 已核对 |
