# 配置中心分域页签 — 实现计划

- 日期：2026-10-27
- Spec：`docs/superpowers/specs/2026-10-27-admin-config-domain-tabs-design.md`
- 范围：`admin/app.js` / `admin/style.css` / `scripts/verify-admin-static.mjs` / 新增 `scripts/admin-config-tabs-probe.mjs` / `package.json` / `scripts/ci.sh`
- Global Constraints：
  - 零 `innerHTML`；全部 `createElement`/`textContent`。
  - 不改 `CONFIG_IA` 键集合、85 键断言、保存链路、代理工作台。
  - `cfg-tabs` 只能作为 **class**（静态闸 REMOVED_IDS 已禁同名 id）。
  - 保存仍全量重建（现状）；本次只保证「切页签不丢未保存编辑」。
  - 每个任务一个 commit；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
  - 回归：`node --check admin/app.js`、`pnpm verify:admin`、`node scripts/admin-config-tabs-probe.mjs`、`node scripts/admin-agents-probe.mjs`、`pnpm verify:admin-players`。

## 任务 T1：静态闸与探针先红

Files：`scripts/verify-admin-static.mjs`、`scripts/admin-config-tabs-probe.mjs`（新增）、`package.json`、`scripts/ci.sh`

### 1.1 静态闸新增断言

- `DEFAULT_CFG_UI` 块：`balancedBlock(app,'const DEFAULT_CFG_UI','{','}')`，先判非空，再断言含 `tabId` 与 `tabDomainId`。
- 存在 `function buildConfigTabStrip` / `function applyCfgTabUI` / `function renderCfgDomain`。
- `renderCfgDomain` 块含：`buildConfigTabStrip(`、`tabs.length > 1`、`cfg-tab-panel`、`tabDomainId === domain.id`、`cfg-tab-empty`。
- `renderConfigRows` 块含 `renderCfgDomain(`。
- `openCfgDomain` 块含 `tabDomainId = null`；`normalizeCfgDomain` 块含 `tabDomainId = null`。
- `CONFIG_IA` 交叉：vm 执行前先判块非空；逐域断言 `headerKeys` 与各页签键无交集。
- `style.css` 含 `.cfg-tabs` 与 `.cfg-tab-panel`。

### 1.2 探针 `scripts/admin-config-tabs-probe.mjs`

jsdom（`createRequire` 指向 `apps/client/package.json`）；登录态注入
`ftl-admin-token/username/role`（super_admin）；`VirtualConsole` + `window error` +
`unhandledRejection` 收集；`clickIf`（元素不存在返回 false，不抛）。

桩：

- `/api/admin/config` → 快照（每键 `{value,version}`）：
  - `game.doudizhu.enabled: true`（header）
  - `game.doudizhu.cardCounterEnabled: false`、`...PricePerGameCoins: 10`、`...PricePerHourCoins: 100`
  - `game.doudizhu.freeRoomEnabled: true`
  - `game.paodekuai.twoPlayerEnabled: false`、`game.paodekuai.freeRoomEnabled: true`
  - `ad.reliefAdpid: 'adunit-1'`
- `/api/admin/ad-channel` → `{code:0,data:{keys:[]}}`；其余 → `{code:0,data:{}}`。

用例（顺序即执行序）：

1. 轮询 `#settings-rows .cfg-tabs .tab-btn` 出现（≤1s，20ms 间隔）。
2. 默认斗地主：6 个按钮；active=对局辅助；`[data-tab="assist"]` 面板非 hidden、`[data-tab="rooms"]` hidden。
3. **DOM 保留（判别性）**：`storeInput = assist 面板内 cardCounter 复选框`；勾选；点「场次开关」；点回
   「对局辅助」；断言当前复选框 `=== storeInput` 且 checked（排除 drafts 假绿）。
4. **空页签提示**：点「玩法规则」→ `[data-tab="rules"]` 面板可见，含 `p.cfg-tab-empty` 文案
   「本页签暂无可展示的键」。
5. **不重置**：点「场次开关」→ active=场次开关；点 `nav-cfg-ddz-btn` → 仍为场次开关。
6. **搜索**：搜索 `freeRoomEnabled` → 无 `.cfg-tabs`；`[data-key="game.doudizhu.freeRoomEnabled"]` 与
   `[data-key="game.paodekuai.freeRoomEnabled"]` 均存在；清空 → 回斗地主且 active=场次开关。
7. **跨域同名页签**：点 `nav-cfg-pdk-btn` → 6 个按钮；active=开关（若 `tabDomainId` 守卫缺失，ddz 的
   `rooms` 会串到 pdk 的 rooms）。
8. **重复点 active 页签 no-op**：`settings-host.scrollTop = 50`，点当前 active 页签，断言仍为 50。
9. 点广告叶 → 无 `.cfg-tabs`，`[data-key="ad.reliefAdpid"]` 存在。
10. 零运行时异常 / 零未处理 rejection。

选择器一律限定 `#settings-rows`。

### 1.3 接线

- `package.json`：`"verify:admin-config-tabs": "node scripts/admin-config-tabs-probe.mjs"`。
- `scripts/ci.sh` admin 阶段追加该脚本。

跑红：`pnpm verify:admin`、`node scripts/admin-config-tabs-probe.mjs` 失败但不崩。
提交：`test(admin): 配置中心分域页签结构闸与探针（先红）`

## 任务 T2：状态与渲染实现

Files：`admin/app.js`、`admin/style.css`

1. `DEFAULT_CFG_UI` 增加 `tabId: null, tabDomainId: null`。
2. `openCfgDomain`：仅 `domainId !== cfgUI.domainId` 时复位两字段。
3. `normalizeCfgDomain`：改域时复位两字段。
4. 新增 `renderCfgDomain(host, domain)`：
   - 解析 `tabs`；`tabs.length > 1`：
     - `active = resolveCfgTab(domain)`（仅 `cfgUI.tabDomainId === domain.id` 才采用 `cfgUI.tabId`；
       否则第一个有键页签 → 首项；写回两者）。
     - `host.append(buildConfigTabStrip(domain, tabs))`。
     - 逐页签 `div.cfg-tab-panel[data-tab]`（非 active 加 `hidden`）：键过滤快照；空 ⇒
       `p.settings-empty.cfg-tab-empty`「本页签暂无可展示的键」；非空 ⇒ `buildKeyCard`。
   - `tabs.length === 1`：维持 `sections`（`h3.settings-section` + 键）。
   - header 开关键卡先渲染（两种分支都先渲染）。
5. `renderConfigRows`：
   - 搜索分支保持现状（扁平 + `syncAdSection`）。
   - 非搜索分支：`normalizeCfgDomain()` 后调用 `renderCfgDomain(host, domainById(cfgUI.domainId))`；
     全局空态仅搜索/单页签域用 `settings-empty`。
6. 新增：
   - `resolveCfgTab(domain)`。
   - `buildConfigTabStrip(domain, tabs)`：`div.tabs.cfg-tabs`；按钮 `type="button"`、`data-tab`、
     `aria-selected`；点击 ⇒ active 相同 no-op；否则 `applyCfgTabUI(tabId)` + `settings-host.scrollTop = 0`。
   - `applyCfgTabUI(tabId)`：在 `#settings-rows` 内切 `.cfg-tabs .tab-btn` 的 `active/aria-selected` 与
     `.cfg-tab-panel` 的 `hidden`；写 `cfgUI.tabId`。
7. `syncAdSection`、focus 恢复、scroll 恢复保持。
8. CSS：`.cfg-tabs`、`.cfg-tab-panel`（复用 `.settings-empty` 样式给 `cfg-tab-empty`）。

跑绿：`node --check admin/app.js`、`pnpm verify:admin`。
提交：`feat(admin): 配置中心重内容域页内页签（DOM 保留）`

## 任务 T3：探针转绿 + 回归

1. 跑 `node scripts/admin-config-tabs-probe.mjs` 修到全绿。
2. 回归：`pnpm verify:admin`、`node scripts/admin-agents-probe.mjs`、`pnpm verify:admin-players`。
3. 手工/无头浏览器抽查：斗地主切页签、搜索、保存后页签保持。
提交：`test(admin): 配置中心页签探针转绿`

## 任务 T4：代码审查与收尾

1. 独立 reviewer 审 `3d4f5d7f..HEAD`（spec/plan 对照；Critical/Important 必修）。
2. 修复后重跑回归；计划/偏差记录更新。
3. 推 `dev`；交付报告。

## 计划审查记录

独立 reviewer 计划审查：2 Critical / 6 Important / 6 Minor，处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | Critical | DOM 保留用例被 drafts 假绿 | 改为**节点引用同一性**断言 |
| 2 | Critical | `tabDomainId` 无判别性用例 | 斗地主停在 `rooms`（撞名）再切 pdk，断言 active=开关；闸钉配对表达式 |
| 3 | Important | 空页签提示无测试 | 用例 4 + 闸钉 `cfg-tab-empty` 与文案 |
| 4 | Important | D6 不重置无用例 | 用例 5（点叶后仍停 rooms） |
| 5 | Important | T1 红会崩 | 登录态注入 + clickIf + 错误收集写入计划 |
| 6 | Important | 保存后行为未写明 | 计划/约束注明「保存仍全量重建」 |
| 7 | Important | 搜索分支静态截取脆弱 | 抽 `renderCfgDomain`，闸只钉该 helper；搜索行为由探针覆盖 |
| 8 | Important | `DEFAULT_CFG_UI`/IA 块提取方式 | 明确 `{`/`}` 与先判空 |
| 9-14 | Minor | spec/plan 漂移、空态优先级、作用域、no-op 用例等 | 已并入 §4.5 与 T1/T2 |

## 代码审查记录

独立 reviewer 审 `885f7b32..HEAD`：**Critical 0**；Important 2（既有开关键卡断言被弱化、
「仅一个面板可见」无判别性断言）；Minor 7。处置：

- Important 1：静态闸恢复 `renderCfgDomain` 内的 `buildGameHeader(` 精确断言；探针补斗地主/跑得快
  开关键卡存在与切页签后仍可见。
- Important 2：每次切页签断言 `.cfg-tab-panel` 非 hidden 恰好 1 个且 data-tab 正确；重复点
  active 页签同时断言条带/按钮/面板节点不变。
- Minor 3/5/6/7/8：补中间态与 aria/零命中/单页签标题断言；面板内卡片 margin 归零；删除未用参数
  与死计数；闸新增「同域页签键无重复」。
- Minor 9：偏差记录见下。

## 实现偏差

- 渲染拆出 `renderCfgDomain` / `resolveCfgTab`；`renderConfigRows` 只在非搜索分支调用。
- 多页签域**只按面板判空**（`cfg-tab-empty`）；`settings-empty` 仅用于单页签域与搜索态。
- 探针搜索词用 `freeRoomEnabled`（ddz + pdk 同名键，能真正验证跨域扁平结果）。
- 空面板提示 class = `settings-empty cfg-tab-empty`（两者并用，样式复用）。

## 验收清单

- [x] `pnpm verify:admin` 全绿（620 项）
- [x] `node scripts/admin-config-tabs-probe.mjs` 全绿
- [x] `node scripts/admin-agents-probe.mjs` 全绿（回归）
- [x] `pnpm verify:admin-players` 全绿（回归）
- [x] `node --check admin/app.js`
- [x] 推 dev
