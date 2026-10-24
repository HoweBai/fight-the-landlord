# 管理后台信息架构重组 v2.1（VSCode 设置页形态）

> **v2.1 修订（2026-10-13 方案审查）**：① 单位表逐键以 `CONFIG_NOTES`「取值」原文定稿——`winRateThreshold` 是 0.50–1.00 比率**不是百分比**、`deviceLimit/minGames` 不臆造单位；② 11 个现有 section（3 凭据 + 8 整页）全部移入右侧宿主（v2.0「8 整页留原位」错误）；③ 树 5 域叶子为新元素、`nav-config-btn` 以 hidden 锚点保留满足运行时；④ `save()` 明确重构为 `putConfigKey + saveRow`（非「仅调用点改」），反馈行内化；⑤ 未分组 = 左树动态叶子 + JSON 兜底行；⑥ 重渲染保焦点/滚动、技能分布百分比双向换算、数字 NaN 本地拦截；⑦ 列出 `showLoginView/wire` 旧 id 清理点。
>
> v1.0 的「左域菜单 + 中列键列表 + 右侧单键编辑器」三栏方案实施完毕后，用户在预览中确认目标形态应为 **Visual Studio Code 设置页**：左侧全站分类树，右侧整页内联设置行（标题/说明/控件/保存同处一行卡片），**取消中列与独立详情编辑器**。支付渠道/通知通道/广告回调三个凭据页天然是行式形态，本次并入同一套设置体系。本文件取代 v1.0；1a 已落地的 `CONFIG_IA` 归属表、`CONFIG_NOTES`、静态自检闸全部复用演进，不回滚。

**Goal:**

1. 左侧 200~220px **全站导航树**（4 组 16 叶），顶栏 12 视图按钮条移除（id/文案随叶子保留）。
2. 8 个设置类叶子（5 配置域 + 3 凭据页）打开**统一设置页**：顶部搜索框 + 分区（原页签）+ 设置行长列表，滚动一屏到底。
3. 37 个简单键类型化行内控件（开关 / 数字+单位 / 文本）；4 个复杂键用**结构化编辑器**（零 JSON）。
4. 每行独立保存（脏了才出现「保存/还原」）；单键 PUT 链路与服务端契约零变化。
5. 8 个运营/安全表格页（钱包/财务/订单/退款/提现/风控/审计/账号）整页机制零改动，仅入口移入左树。

## IA 树（左导航）

| 组         | 叶子（类型）                                             | RBAC 角色（沿用 VIEWS）        |
| ---------- | -------------------------------------------------------- | ------------------------------ |
| 玩法       | 斗地主（设置：4 分区 11 键）                             | super_admin, operator          |
| 通用设置   | 货币经济（设置：2 分区 6 键）                            | super_admin, operator          |
|            | 支付与提现（设置：3 分区 11 键）                         | super_admin, operator          |
|            | 风控安全（设置：3 分区 10 键）                           | super_admin, operator          |
|            | 数据与广告（设置：无分区 3 键）                          | super_admin, operator          |
| 渠道与凭据 | 支付渠道（凭据行，独立 API）                             | super_admin, operator, finance |
|            | 通知通道（凭据行，独立 API）                             | super_admin, operator, finance |
|            | 广告回调（凭据行，独立 API）                             | super_admin, operator, finance |
| 运营       | 钱包调整 / 财务 / 支付订单 / 退款审核 / 提现审核（整页） | 现行各 roles 不动              |
| 安全与审计 | 风控 / 审计 / 账号（整页）                               | 现行各 roles 不动              |

- 41 键的域/分区归属沿用 v1.0 `CONFIG_IA` 全表（11/6/11/10/3；分区 = v1.0 的 tabs：玩法规则/场次开关/房间节奏/AI 机器人 等），本表不再重复。
- 组内叶子全部因角色不可见时，整组隐藏（applyRoleNav 扩展到树）。
- **叶子元素机制（v2.1 定稿）**：渠道 3 叶 + 运营/安全 8 叶 = 现有 11 个 `nav-*-btn` **原样迁移进树**（同 id 同文案，G12 静态针脚与 `VIEWS` 运行时表都靠它们）；5 个配置域叶子是**新元素**（id 取 `nav-cfg-{domainId}-btn`，文案与 CONFIG_IA 域名一致），点击 = `openCfgDomain(id)`（设 `cfgUI.domainId`、清搜索/草稿态后 `switchView('config')`）。`nav-config-btn` 无对应叶子，但 `VIEWS.config.nav`/`applyRoleNav`/`switchView` 会 `$()` 取它——在树内放一个 `hidden` 锚点按钮保留该 id（永不显示）。域叶子 active 态由 `cfgUI.domainId` 单独驱动（`switchView('config')` 本身不区分域）；11 个迁移叶子 active 态沿用现有 classList 逻辑。
- **未分组是第 17 个（动态）叶子**：当且仅当快照含 `CONFIG_IA` 表外键时，在左树「通用设置」组尾出现「未分组（N）」叶子（id 固定 `nav-cfg-ungrouped-btn`，渲染/清空走同一树渲染器）；表外键消失后叶子移除。
- 顶栏按钮容器 `#view-nav` 删除（G12 不钉该 id，已核 slice-19 无任何 view-nav/sidebar/editor/cfg 针脚）；`#status/#whoami/#logout-btn` 保留在瘦顶栏。
- 默认落地：斗地主（`switchView('config')` + `cfgUI.domainId='ddz'`，沿用 1a）。finance/viewer 无 config 权限时落点仍为 finance（`defaultViewFor` 不动）。

## 设置页布局与交互（VSCode idiom）

```
┌ 顶栏（瘦）：FTL 管理面 │ whoami │ 全局消息 │ 退出 ─────────────┐
├──────────────┬───────────────────────────────────────────────┤
│ 左 220 树     │ [ 搜索配置键或说明…              ]              │
│ ▾ 玩法        │                                               │
│   斗地主      │ ── 玩法规则 ───────────────────────────        │
│ ▾ 通用设置    │ ┌ 设置行卡片 ──────────────────────────────┐  │
│   货币经济    │ │ 底分档位表 [结构化编辑器]      [保存][还原]│  │
│   支付与提现  │ │ game.baseScoreLevels · v9                 │  │
│   风控安全    │ │ 作用：…（一行）              〔更多〕      │  │
│   数据与广告  │ └───────────────────────────────────────────┘  │
│ ▾ 渠道与凭据  │ ── 场次开关 ───────────────────────────        │
│   支付渠道    │ ┌ 免费场 [开关]  作用：…         [保存][还原]┐ │
│   通知通道    │ …                                            │
│   广告回调    │ 搜索态：去掉分区标题分组，每条命中带「域 · 分区」│
│ ▾ 运营        │ 小标题，标题栏改「搜索结果（N）」                │
│ ▾ 安全与审计  │                                              │
└──────────────┴───────────────────────────────────────────────┘
```

- **设置行卡片**：左主体 = 中文名（`CONFIG_NOTES` 键名顶行、`dotted` 键名 + 版本次行）、说明（默认只显「作用」一行，「更多」展开 取值/生效/注意）；右尾 = 控件区 + 操作区 + **行内状态行**（成功/失败文案，见下）。
- **脏状态**：控件一旦偏离已保存值（`JSON.stringify(draft) !== JSON.stringify(saved)` 深比较），行尾出现「保存」（accent 实心）与「还原」（ghost）；未脏时两个按钮都不在 DOM（不占视觉）。布尔开关同样遵循（拨回原值即不脏）。
- **保存链路（v2.1 明确重构，契约零变化）**：从现 `save()` 抽出 `putConfigKey(key, value)` —— URL `/api/admin/config/${encodeURIComponent(key)}`、body `{value}`、按 HTTP status 分流（400 服务端 message / 401 `backToLogin` / 0 无法连接 / 非 200 / 200 announced 双文案）**逐字保留**；`saveRow(key)` 从 `drafts` 取值调用它。成功/失败文案显示在**该行的行内状态行**（成功绿、announced=false 警告黄、400 红），不再走全局 `#status`（`showMsg` 元素保留给钱包/财务等其他视图，本页不调用）。成功后删该键草稿、`await loadAll()`、该行状态在 ~3s 后淡出。
- **输入取值纪律**：数字行输入转 `Number()` 后再进草稿；空串 / NaN 时行内红字「请输入数字」且保存按钮禁用（这是形状层本地拦截，**不做范围/业务校验**，范围仍只信服务端）；文本行原样字符串（`ad.reliefAdpid` 空串 = 未配置，允许保存）。
- **草稿保护**：`drafts = Map<key, unknown>` 持有未保存值。`loadAll()` 重渲染时行控件优先取草稿值（保存 A 行不冲掉 B 行在途输入）；「还原」/保存成功删该草稿；登出清空。
- **滚动/焦点保护**：重渲染在同一容器内 `replaceChildren`，渲染前后恢复滚动容器 `scrollTop`；保存成功后把焦点还原到该行主控件（行根带 `data-key` 作锚点）。
- **分区**：域内原页签变为分区标题行（sticky 不做，克制）；单分区域（数据与广告）不渲染分区标题。左树不做二级，跨分区移动用搜索。
- **搜索**：搜索框位于设置页内容顶部，**仅 5 个配置域叶子与未分组叶子显示**；凭据叶子与 8 整页隐藏。范围 = 全部快照键的键名 + `CONFIG_NOTES` 全文（沿用 1a 匹配规则）；命中后扁平铺行、按「域 · 分区」加小标题；Esc 清空回当前类别。切叶子清空搜索（沿用 1a）。
- **未分组行**：键形状未知 ⇒ 该行用原始 JSON 行内 textarea（全站唯一保留 JSON 编辑的位置，附现「JSON 格式…」hint 原文），无备注块（`CONFIG_NOTES` 未收录即不渲染，沿用 appendNotes 纪律）。
- **凭据三页**：点叶子后设置宿主内显示现有 `pay-channel-view/notify-channel-view/ad-channel-view` 三容器（仅对应一个 unhidden），行集合由现有 `buildPayChannelRow / buildNotifyChannelRow / buildAdChannelRow` 渲染——每行独立保存/清空、密键只写不读、canWrite 门控零交互改动；三容器自带的 h2/hint 原文保留。
- **整页类叶子**：设置宿主 hidden，显示对应现有 `*-view` section（lazy load / keyset / RBAC 全部现状）。
- **无选中键概念**：1a 的 `selectedKey` 全局删除（每行自带控件，不存在「先选后编」）。

## 控件类型表（37 简单键，v2.1 逐键定稿）

新增内联 `CONFIG_CONTROLS`（key → `{label, type, suffix?, step?}`）。**`label` = 41 个中文短名**——v2.1 审查发现 `CONFIG_NOTES` 只有键名没有短名，行卡片标题需要它；初版 41 个命名以效果图 `.tmp-gen/mock-v2.html` 的 `CFG` 数据为评审基线（如「免费场/金币场/好友房」「提现门槛」「胜率阈值」），用户确认后逐字入表，实施时不再改名。后缀只取「取值」原文出现的量词，原文没有就不给后缀（范围约束由「取值」说明行展示，不臆造）：

- **开关（10 布尔）**：`robot.ruleFallback`、`room.freeRoomEnabled`、`room.goldRoomEnabled`、`room.friendRoomEnabled`、`currency.reliefEnabled`、`risk.predicate.sameDevice`、`risk.predicate.sameIp`、`risk.autoThrottle`、`pay.rechargeEnabled`、`pay.withdrawEnabled`。复用现有 switch 视觉（`switch/switch-track/switch-label` 类；文案「已启用（true）/已停用（false）」逐字），每行一个，不再用共享 id。
- **数字行（26）**，后缀定论：
  - 后缀「毫秒」（10）：`robot.reclaimIntervalMs`、`room.matchScanIntervalMs`、`room.autostartIntervalMs`、`room.reapIntervalMs`、`pay.scanIntervalMs`、`pay.reconcileIntervalMs`、`currency.reconcileIntervalMs`、`risk.scanIntervalMs`、`risk.devicesCleanupIntervalMs`、`record.cleanupIntervalMs`（整数，step=1）
  - 后缀「分钟」（2）：`pay.orderExpireMinutes`、`pay.withdrawTimeoutMinutes`
  - 后缀「天」（3）：`record.retentionDays`、`risk.deviceWindowDays`、`risk.deviceRetentionDays`
  - 后缀「%」（1）：`currency.rakePercent`（整数百分比 0–50）
  - **无后缀、step=0.01（1）**：`risk.winRateThreshold`（**0.50–1.00 比率，不是百分比**；控件右侧不给 %，范围由说明行展示）
  - 后缀「倍」（1）：`currency.entryMultiplier`
  - 后缀「金币」（5）：`currency.signupGrant`、`currency.reliefAmount`、`pay.withdrawMinCoins`、`pay.withdrawMaxCoinsPerOrder`、`pay.withdrawDailyMaxCoins`
  - 后缀「金币/元」（1）：`pay.coinPerYuan`
  - 无后缀整数（2）：`risk.minGames`（说明里量词为「对局局数」，后缀不给「场/局」以免与原文不一致）、`risk.deviceLimit`（原文量词「设备号数」，不给「台」）
- **文本（1）**：`ad.reliefAdpid` 普通文本输入（字母数字 ≤32；空串允许，语义 = 未配置）。
- 校验口径：除「必须是数字」形状拦截外，范围/唯一性/必含 15 等业务约束**一律不在前端硬编码**（服务端 400 回显，行内红字展示）。

## 结构化编辑器（4 复杂键，零 JSON）

1. **`game.baseScoreLevels` 底分档位表**：两列可编辑表格（场名文本 + 底分整数），行尾删除；底部「＋ 添加档位」。行级提示（notes 原文）：底分唯一、1..8191、非空名、**必须含缺省 15**；提交仍发原数组形状 `[{name,baseScore}]`。
2. **`pay.rechargePackages` 充值档位**：可增删的数字行（元），占位「如 30」；约束提示：正整数、唯一、非空；形状仍是整数数组。
3. **`robot.skillDistribution` 技能分布**：三行（初级/中级/高级）百分比数字输入（0–100，允许一位小数），实时「合计 X%」；≠100% 时黄字提示「保存时按比例归一化」（服务端 parse 按 sum 归一，已核 protocol `parseSkillDistribution`，且接受权重写法）。**双向换算**：快照存小数（0.15/0.35/0.5）⇒ 控件展示 `value×100`（一位小数四舍五入）；保存时把三个百分比除以 100 组装 `{beginner,intermediate,advanced}`（归一化由服务端做，前端只做换算）；全 0 时本地拦截（服务端要求合计 > 0）。
4. **`robot.modelBySkill` 各档模型**：三个下拉（初级/中级/高级），选项固定三（已核 `MODEL_NAMES`）：`sl`（规则引擎）、`douzero_WP`（DouZero·WP）、`douzero_ADP`（DouZero·ADP）；中文名旁小字保留模型 id。

结构化编辑器同样走草稿 + 行尾保存/还原；展开/收起形态常驻（不折叠成 JSON 链接——它们就是该键的常规编辑形态）。

## 路由与视图机制（v2.1 定稿）

**DOM 壳结构（index.html）**：

```
<header> 瘦顶栏：brand / whoami / status / 退出（#view-nav 整块删除）
<main id="main-view" hidden>            ← 登录后外壳（替代现 config 容器职责）
  <aside id="side-nav"> 树（4 组 + 动态未分组叶 + hidden 的 nav-config-btn 锚点）
  <div id="content-host">               ← 右列，所有登录后内容都在里面
    <section id="settings-host">        ← 8 个设置类叶子共用
      #settings-search（搜索框）
      #settings-rows（分区标题 + 设置行）
      #pay-channel-view / #notify-channel-view / #ad-channel-view（凭据三容器，搬入此处）
    </section>
    #wallet-view/#finance-view/#pay-orders-view/#pay-refunds-view/#pay-withdrawals-view/
    #risk-view/#audit-view/#accounts-view（8 整页 section 全部从 body 层搬入此处，id/class/内部结构不动）
  </div>
</main>
#modal（不动）
```

- **11 个现有 section 全部搬位置**（3 凭据进 settings-host；8 整页进 content-host），现文件里它们是 `<body>` 直接子元素，留在原位会绕开两栏布局全宽错位。搬动只改父节点，不改 id/hint/表格结构。
- `VIEWS` 12 项与 `nav`/`roles`/lazy load 全保留；`el` 改指：`config/payChannel/notifyChannel/adChannel` 四项 ⇒ `settings-host`；其余 8 项 ⇒ 各自 id（已在 content-host 内）。
- `switchView(name)` 机制：hidden 循环照旧（同 el 多入参时循环末态为显示，顺序天然正确）；命中 4 设置项时循环结束后调 `renderSettings(name)`——config ⇒ 按 `cfgUI.domainId`（或未分组）铺配置行并 unhide `#settings-rows`、hide 三凭据容器；payChannel/notifyChannel/adChannel ⇒ hide `#settings-rows` 与搜索框、unhide 对应凭据容器并确保其现有 lazy loader 执行。切 8 整页时 settings-host 被 hidden。
- `loadAll()` 重写：取快照后不再设 `selectedKey`；`currentConfig` 落地后调 `renderSettings('config')`（当前在配置叶子时）并重渲树（域计数/未分组叶显隐）。
- 1a 的 `#cfg-search/#cfg-nav/#cfg-tabs/#key-pane-title/#key-list/#editor-key/#editor-version/#editor-body/#save-btn` 与编辑器脚 hint **整块删除**；`renderEditor/renderKeyList/renderCfgNav/renderCfgTabs/renderConfigView` 等 1a 编排函数删除（`CONFIG_IA/CONFIG_NOTES/IA_DOMAINS/IA_KEY_SET` 保留复用）。`appendNotes` 的四行拼装改写为行卡片内的说明块（class 可新起，文案与「作用/取值/生效/注意」标签一字不改）。
- **必须同步清理的失效引用（缺一会运行时抛错）**：`showLoginView()` 内现对 8 个旧 id 的清零（cfg-nav/cfg-tabs/key-pane-title/cfg-search/key-list/editor-body/editor-key/editor-version，app.js 现 1134–1142）改为清零 `#settings-rows`、搜索框、`drafts`、树重渲；`wire()` 内 `#save-btn` 提交与 `#cfg-search` input/Esc 监听删除，改为 `#settings-host` 上的事件委托（保存/还原/更多/搜索）；所有 `$('bool-input')/$('json-input')` 引用随 `save()` 重构消失。

## G12 / 硬约束（沿用 v1.0 校正结论）

- app.js 全字串不得出现 `innerHTML`；只 `createElement + textContent`。零外部资源/图标。
- 必含字符串针脚（nav id、view id、中文文案、API 路径、fin-source 12 option、`六页签` 等）一并不丢；静态自检脚本同步更新断言后继续当秒级闸。
- 键集合真源仍是 `GET /api/admin/config` 快照：`CONFIG_IA` 未收录键 → 设置页新增「未分组」类别（挂通用设置组尾，仅当存在时出现）；快照缺失键域计数为 0 时整叶隐藏。
- 文件边界：只改 `admin/index.html`、`admin/app.js`、`admin/style.css`、`scripts/verify-admin-static.mjs`（断言随实现更新）；`package.json` script 不变。
- 验证：静态自检 + CDP 真浏览器探针（更新 `.tmp-gen` 临时探针，覆盖新验收）+ 合并前真栈 conformance slice-19（Docker 重建镜像）。不跑全量测试；不主动 commit。

## Tasks

- [ ] **T1 自检闸先红**：更新 `verify-admin-static.mjs`：移除三栏旧 id（cfg-nav/cfg-tabs/key-pane-title/key-list/editor-_/save-btn/bool-input/json-input 等）断言；加新 id（`side-nav/content-host/settings-host/settings-search/settings-rows` + 5 个 `nav-cfg-_-btn`+ ungrouped + hidden`nav-config-btn` 锚点）；`CONFIG_CONTROLS`简单键集合恰为 37、4 结构化键不进表、与 CONFIG_KEYS 41 集合并集相等；后缀枚举值只能取自定稿表（winRateThreshold 不得带`%`）；`view-nav` 必须**已不存在**；零 innerHTML/零外链/fin-source 12 项保留；跑出预期红。
- [ ] **T2 index.html**：删 `#view-nav`；`#main-view` 改两栏壳（`#side-nav` 树含 11 迁移按钮 + 5 域叶子 + hidden 锚点 + 4 组标题；`#content-host`）；`#settings-host`（搜索框 + `#settings-rows` + 迁入的凭据三 section）；8 整页 section 从 body 层迁入 `#content-host`；删中列/编辑器块及注释。
- [ ] **T3 style.css**：左树分组/叶子/active/计数徽标；设置页搜索框、分区标题、行卡片（名称/键名/说明/更多/控件/保存还原/行内状态）；开关与数字+单位行；4 结构化编辑器（表格/数字行/百分比合计/下拉）；窄宽兜底。删三栏中列与旧 editor 规则。
- [ ] **T4 app.js**：`CONFIG_CONTROLS`（按定稿表，禁推断）；`drafts`、`openCfgDomain`、树渲染器（组隐藏/域 active/未分组动态叶）；`renderSettings(name)`（分区/搜索/未分组 JSON 兜底/凭据三容器切换）；37 简单行 + 4 结构化 builder（含分布百分比双向换算）；`putConfigKey/saveRow` 与行内状态、NaN 拦截；重渲染保滚动/焦点；`VIEWS.el` 改指、`loadAll` 去 selectedKey、`switchView` 接 renderSettings；`showLoginView` 与 `wire` 旧 id 引用全清理；登出清零（树/搜索/草稿/行）。
- [ ] **T5 验证**：静态闸全绿；重写 CDP 探针覆盖：16 叶 RBAC 显隐（super_admin/operator/finance/viewer 四角色）、默认斗地主、各域分区行数、37 控件类型/后缀全量核对（含 winRateThreshold 无 %）、4 结构化编辑器交互（增删档/合计归一提示与全 0 拦截/三下拉值）、行内 PUT URL+body 与 announced 双文案、NaN 拦截、草稿跨 loadAll 保留 + 焦点/滚动保持、搜索/Esc/空态、未分组桶（JSON 行）、凭据三页渲染与保存按钮、整页 8 视图可达且懒加载正常、登出清零、1366/1024 无横向溢出、零未捕获异常；截图留档。修复并更新 `.tmp-gen/preview.html`（iframe load 竞态：脚本注册监听前若 `contentDocument.readyState==='complete'` 直接注入），恢复可点击预览。

## 验收要点（探针机械化）

1. 左树 4 组 16 叶（super_admin）+ 未分组动态叶；operator/finance/viewer 叶子显隐与现行 nav 一致；空组隐藏。
2. 顶栏不再有视图按钮条（`#view-nav` 不存在）；11 个 nav id 与中文文案（含支付渠道/通知通道/广告回调）仍在 DOM；hidden 的 nav-config-btn 锚点存在。
3. 斗地主页 4 分区、键行 11；五设置域行数 11/6/11/10/3；未分组叶增删，表外键行有 JSON 编辑器。
4. 布尔行开关 10 个；26 数字行后缀全量等于定稿表（winRateThreshold 无后缀 step .01、rakePercent 带 %、10 毫秒/2 分钟/3 天/5 金币/金币元/倍）；ad.reliefAdpid 文本框。
5. 四结构化编辑器：档位表增删行 + 发 `[{name,baseScore}]`；充值包发整数数组；分布展示百分比（0.15→15）、发三槽小数、全 0 拦截；模型三下拉发 `{beginner,intermediate,advanced}` 固定取值。
6. 脏显保存/还原、还原回快照值、保存后按钮消失且焦点/滚动保持；PUT 单键 URL/body 与成功文案不变（含 announced=false 警告分支）；A 行保存后 B 行草稿不丢；非数字输入保存禁用。
7. 搜索仅在 6 类配置叶子可见，命中带「域·分区」小标题、Esc 回类别；vip 空态；切叶子清空。
8. 凭据三页行渲染（含密键只写不读/清空按钮，仅 super_admin）与整页 8 视图懒加载零回归；8 整页在右列内显示、无全宽错位。
9. 登出后树/搜索/草稿/行清零，再登录回默认叶子；全程零未捕获异常。
