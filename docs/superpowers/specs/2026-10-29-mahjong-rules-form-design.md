# 四川麻将规则配置表单化（2026-10-29）

> 状态：设计稿 r2（已过对抗审查，修订待用户确认）
> 需求口径：用户 2026-10-29 裁决「后台表单化、不动服务端契约；预设 + 一键重置；去掉 raw JSON；
> 自动取值 + 重点说明」。

## 1. 背景与问题

四川麻将的规则快照 `game.mahjong.rules` 是一个约 60 个叶子字段的 JSON 对象
（[protocol/src/mahjong/rules.ts](../../../packages/protocol/src/mahjong/rules.ts)：
25 个顶层字段 + `fanTable` 17 项 + `additiveFanTable` 9 项 + `optionalFans` 8 项）。
斗地主 / 跑得快的规则是**每规则一个独立配置键**，管理后台自动渲染成
「中文标签 + 开关/数字 + 作用说明」的行卡片（[admin/app.js:1131](../../../admin/app.js#L1131)
`CONFIG_CONTROLS`）；而麻将只能给一个 12 行裸 JSON 文本框
（[admin/app.js:2131](../../../admin/app.js#L2131) `buildRulesJsonEditor`）。
新人要同时懂 JSON 语法、英文字段名、枚举值拼写和数字范围才能改，错误只能等保存后被服务端 400 打回。

现有实现里还有几个**新人必踩的坑**（本次只做提示，不改语义）：

| 坑 | 事实来源 | 表现 |
|---|---|---|
| `preset` 只是写入期标注 | `parseMahjongRules` 仅在**写入时**按 preset 合并缺省（rules.ts:283-287） | JSON 编辑器里把 `preset` 改成 `sbr` 不会改已写明的其它字段，但人以为整个规则都换了 |
| `refundOnDraw` 两档同义 | [shared/src/mahjong/settle.ts:95-96](../../../packages/shared/src/mahjong/settle.ts#L95) | `nonReadyAll` / `kongDeclarerOnly` 当前实现一致（该字段无读取方），配置项只为预设自描述 |
| `selfDrawMode` 的 `addBase` / `addPoint` 同义 | [shared/src/mahjong/scoring.ts:203-205](../../../packages/shared/src/mahjong/scoring.ts#L203) | 两者都 = 每家多付 1×底；只有 `addFan` / `none` 有区别 |
| `addFan` 在加法口径读命名番表的 `ziMo` | [shared/src/mahjong/scoring.ts:235-236](../../../packages/shared/src/mahjong/scoring.ts#L235) | SBR 的 `fanTable` 为空 ⇒ 实际 +0 番 |
| `chajiaoAllSameState` 是死配置 | [shared/src/mahjong/settle.ts:117-127](../../../packages/shared/src/mahjong/settle.ts#L117) | `'none'` 与 `'pay'` 在任何输入下无可观测差异；文档 §6.2 的描述未在代码中实现（另立片） |
| 加法番表全 0 时所有牌 0 番 | `tableValue` 缺省 0（scoring.ts:85-87） | 计分方式切到 `additive` 但番表还是空 ⇒ 只按底分结算 |
| 起胡番高于封顶番 | 协议不校验两者关系 | 永远无法胡牌 |
| 清除番表项不等于恢复默认 | 服务端对缺键按 preset 默认合并（rules.ts:311-319/360-363） | 裸 JSON 里删掉 `pingHu` 保存后，服务端又补回 1 |
| **左树没有麻将配置入口** | dev `CFG_NAV` 无 mahjong 叶；修复 `053a63a1` 仅在 `majiang` 分支 | 刷新后台后麻将配置域不可达（仅全局搜索能看到键） |

## 2. 范围

**做**

- 管理后台把 `game.mahjong.rules` 的裸 JSON 文本框换成**分组表单**（描述表驱动）。
- 「预设 + 一键重置」：下拉选择目标预设，点按钮确认后全量覆盖为预设默认。
- 实时护栏提示（加法番表全 0、命名番表全 0、起胡番 > 封顶番）。
- 重点字段说明（约 18 条），其余字段自动生成「取值范围 / 选项中文」。
- 版本错位自救：快照缺字段（快照较旧）可「按服务端默认补齐」；快照含未知键可「移除并保存」。
- 合入 / 移植 `053a63a1` 左树叶修复（否则本片的表单不可达）。
- 测试与机械闸：protocol 行为级等价门禁 + shared 标签一致性门禁 + jsdom 探针 + `verify:admin` 更新 + CI 接线。

**不做**

- 不拆配置键（键面维持现有一百一十二键 / 96 active，见 `verify-admin-static.mjs:217-220`）。
- 不改 protocol / config-service / room-service / 客户端 / 数据库 / 迁移（协议源码零改动，门禁从默认值推导常量）。
- 不改任何规则语义，不修 `refundOnDraw` / `selfDrawMode` / `chajiaoAllSameState` 的实现同义
  （仅文案如实登记；`chajiaoAllSameState` 的代码/文档对账另立片）。
- 不保留 raw JSON 编辑入口（用户裁决）。
- 不动「未分组」键的 `buildJsonRow` 兜底编辑器（其它键仍可用）。
- 不做移动端 / 多语言适配（admin 是桌面三栏壳）。

## 3. 决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | `game.mahjong.rules` 保持单键，整对象原子保存 | 用户裁决（方案 1）；拆键会扩散到 protocol/config-service/迁移/conformance，且破坏原子性 |
| D2 | 描述表 `MAHJONG_RULES_FORM` + 通用渲染器（方案 A） | 逐字段手写 DOM 600+ 行且漂移无人拦；codegen 为一个键引入构建耦合 |
| D3 | **`preset` 不进入保存路径**：表单保存永远带回快照原 `preset`；切换口径只能通过「按预设重置」按钮 | 消除「改了下拉以为换了口径」的坑；保存语义保持「只改你看到的字段」 |
| D4 | 重置 = `PUT {preset: <目标>, rulesVersion: <现值>}`，由服务端 `parseMahjongRules` 补默认 | admin 零预设常量副本；服务端是预设唯一真源。已实测：`{preset:'sbr'}` ⇒ 25 个顶层字段 + 9 项加法表全部生成 |
| D5 | 移除 raw JSON 入口 | 用户裁决 |
| D6 | 前向兼容（快照含描述表不认识的顶层键/番种键）⇒ **原样保留**（pass-through）+ 顶部信息条 + 「移除这些未知字段并保存」自救按钮 | `parseMahjongRules` 对未知键抛错（rules.ts:289-292 / 266-274）；服务端回滚/滚动发布时若无出口，每次保存都 400 且无 raw JSON 可救 |
| D7 | 说明深度：自动「取值/范围/选项」+ 约 18 条手写重点说明 | 用户裁决；不写 60 条三行文案，避免维护负担 |
| D8 | 三张番表组默认折叠（`<details>`），其余分组展开 | 开发方裁决：控制首屏高度；标题带项数，可发现 |
| D9 | 番表行的**读写语义**（不是简单删除）：<br>· 键在快照表中存在 + 输入非空 ⇒ 写数值；<br>· 键在快照表中存在 + 输入为空 ⇒ 写 **0**（显式关闭）；<br>· 键不在快照表中 + 输入为空 ⇒ 省略；非空 ⇒ 写数值。<br>未知番种键原样保留。 | 服务端对缺键按 preset 默认合并（rules.ts:311-319）——若「空 = 省略」，运营清空平胡后会被服务端补回 1，表单与护栏都在说谎。实测：`{preset:'chengdu', fanTable:{duiDuiHu:2}}` ⇒ `pingHu` 仍为 1；`{fanTable:{pingHu:0}}` ⇒ 0 |
| D10 | 本地校验镜像协议范围/枚举；protocol 侧加**行为级**门禁测试（用真 `parseMahjongRules` 验证描述表） | 防描述表与协议漂移；行为级比文本比对更能扛重构 |
| D11 | `rulesVersion` 只读展示，保存/重置时原样带回 | 协议无消费方，普通运营不需要改 |
| D12 | 保存/重置成功后走既有 `loadAll()` 重渲染；失败保留脏态与表单值 | 沿用 `saveRow` / `putConfigKey` 既有协议 |
| D13 | 并发：整键 last-write-wins，不新增乐观锁 | 与所有现有配置键一致 |
| D14 | 文案以 `docs/games/mahjong.md` + **代码实际行为**为准；已知同义/失效项如实写明，不写假差异 | 已实锤：`refundOnDraw`/`addBase`+`addPoint` 同义、`chajiaoAllSameState` 死配置 |
| D15 | 快照缺字段（描述表有、快照无）⇒ 隐藏字段 + 信息条「快照较旧：缺少 N 个字段（保存时按服务端默认合并补齐）」+ 「按服务端默认补齐」按钮（原样保存快照，服务端写入完整对象后重载） | 缺字段只能说明**写入时协议版本旧**，不能说明当前服务端旧；`parseConfigValue` 只在写入时补齐（platform-config.service.ts:136-137），GET 原样返回库值 |
| D16 | 门禁从 `DEFAULT_CHENGDU_RULES` 推导顶层键/布尔键集合，**不改 protocol 导出**；描述表必须是**纯字面量**（番键清单内嵌）以便 vm 提取 | `TOP_KEYS`/`BOOLEAN_KEYS` 是模块私有（rules.ts:209-242）；提取失败必须抛错，不能静默跳过 |
| D17 | `fanBase` 是数值枚举：描述表用数值选项 + `valueType:'number'`，read() 转换 Number | `<select>.value` 恒为字符串；实测传 `'1'` 抛 `fanBase must be 0 or 1` |

## 4. 实现设计

### 4.1 描述表（admin/app.js，纯数据字面量）

```js
/** 四川麻将规则表单描述表——纯字面量（无外部标识符、无函数），供渲染器与门禁测试共用。 */
const MAHJONG_RULES_FORM = {
  fanLabels: { pingHu: '平胡', duiDuiHu: '对对胡', /* …34 项 */ },
  tables: {
    fanTable: { keys: ['pingHu', /* …17 */], min: 0, max: 20 },
    additiveFanTable: { keys: ['root', /* …9 */], min: 0, max: 20 },
    optionalFans: { keys: ['duanYaoJiu', /* …8 */], min: 0, max: 20 },
  },
  groups: [
    { id: 'scoring', title: '计分', fields: [
      { path: 'scoringPolicy', label: '计分方式', type: 'enum',
        options: [['named', '命名番表（成都口径）'], ['additive', '加法番表（SBR 口径）']],
        note: '命名 = 取单一最高主番再加番；加法 = 逐项特征相加。' },
      { path: 'fanBase', label: '底番', type: 'enum', valueType: 'number',
        options: [[1, '1（平胡 1 番 = 1× 底）'], [0, '0（0 番 = 1× 底）']] },
      { path: 'fanCap', label: '封顶番数', type: 'int', min: 1, max: 8 },
      { path: 'minFanToHu', label: '起胡番', type: 'int', min: 0, max: 6, note: '0 = 不设门槛。' },
      { path: 'selfDrawMode', label: '自摸加成', type: 'enum',
        options: [['addBase', '每家多付 1× 底'], ['addPoint', '每家多付 1× 底（SBR 写法，当前同 addBase）'], ['addFan', '番 +1'], ['none', '无加成']],
        note: 'addBase 与 addPoint 当前实现同义；addFan 读命名番表的「自摸」项，SBR 空表时实际 +0。' },
      { path: 'rootIncludesKong', label: '根包含杠', type: 'bool', note: '开 = 已杠的四张也算根；龙七对的定义四张始终不算根。' },
    ]},
    { id: 'namedFan', title: '命名番表', collapsible: true, table: 'fanTable',
      note: '仅「命名番表」口径生效；0 或留空 = 该番不成立；平胡建议 ≥1。' },
    { id: 'additiveFan', title: '加法番表', collapsible: true, table: 'additiveFanTable',
      note: '仅「加法番表」口径生效；全为 0 时任何牌都是 0 番（只按底分结算）。' },
    { id: 'optionalFan', title: '可选番', collapsible: true, table: 'optionalFans',
      note: '0 = 关闭；非 0 = 满足条件时加该番（每杠 × 杠数）。' },
    { id: 'flow', title: '换牌与流程', fields: [
      { path: 'exchangeThreeEnabled', label: '换三张', type: 'bool' },
      { path: 'exchangeDirection', label: '交换方向', type: 'enum',
        options: [['random', '随机（掷骰）'], ['clockwise', '下家（顺时针）'], ['counterclockwise', '上家（逆时针）'], ['opposite', '对家']] },
      { path: 'lastFourForcedHu', label: '最后四张必胡', type: 'bool' },
      { path: 'passHuMode', label: '过水', type: 'enum',
        options: [['off', '不过水（可立即再胡）'], ['sameTile', '同张不可再胡'], ['sameTileOrHigherFan', '同张需番更高']] },
    ]},
    { id: 'gang', title: '杠与转账', fields: [
      { path: 'directGangMode', label: '直杠付款', type: 'enum',
        options: [['contract', '仅点杠者付 2× 底'], ['everyone', '点杠者 2× 底 + 其余在场每家 1× 底']] },
      { path: 'gangTransfer', label: '呼叫转移', type: 'enum',
        options: [['none', '不转移（杠分退回）'], ['toEachWinner', '转给每个赢家'], ['split', '拆分']] },
      { path: 'refundOnDraw', label: '荒庄退税', type: 'enum',
        options: [['nonReadyAll', '所有未听者退'], ['kongDeclarerOnly', '仅杠者退']],
        note: '两档当前实现同义：退税对象都是杠事件收款人且荒庄未听/花猪。' },
    ]},
    { id: 'settle', title: '花猪与查叫', fields: [
      { path: 'huazhuMode', label: '花猪处置', type: 'enum',
        options: [['payEach', '赔每家封顶分'], ['burn48', '销毁 48× 底（SBR）'], ['off', '不罚']] },
      { path: 'huazhuPayees', label: '花猪赔付对象', type: 'enum',
        options: [['active', '仍在场的非花猪玩家'], ['nonFlowerPig', '除花猪外所有玩家（含已胡者）']] },
      { path: 'chajiaoEnabled', label: '查大叫', type: 'bool' },
      { path: 'chajiaoAllSameState', label: '全员同状态', type: 'enum',
        options: [['none', '不结算（当前实现与「照常赔付」同义）'], ['pay', '照常赔付']],
        note: '当前代码两档无可观测差异（settle.ts:117 的守卫分支不产生查叫事件）；文档描述的差异尚未实现，另立片对账。' },
    ]},
    { id: 'timing', title: '决策时长', fields: [
      { path: 'claimWindowMs', label: '出牌响应窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
      { path: 'exchangeWindowMs', label: '换三张窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
      { path: 'lackWindowMs', label: '定缺窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
    ]},
  ],
};
```

> 8 个分组、23 个非 `preset/rulesVersion` 顶层字段（20 个控件 + 3 张番表共 34 行）。

### 4.2 渲染器 `buildMahjongRulesEditor(body, ctx)`

- 替换 `buildRulesJsonEditor`，在 `buildStructCard` 的 `else if` 分支换名。
- 顶部**预设栏**：
  - 只读徽标「当前预设：成都血战到底 / SBR 竞技近似」+ `rulesVersion` 小字。
  - 下拉「重置为：……」+ 按钮「按预设重置全部规则」。
  - 旁注：*保存只写入你在表单里看到的字段，不会改变预设；要整口径切换请用重置按钮。*
- 分组渲染：`el('section', 'mj-group')`，标题 + 组说明；`collapsible` 组用 `<details><summary>`
  包裹，`summary` 带「N 项」。
- 控件（全部带 `data-field="<path>"`）：
  - `bool` → 复用开关样式（checkbox + switch-track）。
  - `enum` → `<select>`；`valueType:'number'` 的项按数值转换。
  - `int` → `<input type=number>`，`min/max/step=1`，右侧单位。
  - `fanTable` → 行 = 番中文名 + `<input type=number min=0 max=20>`；空 = 0（见 D9）。
- **信息条**（顶部，按需出现）：
  1. 快照缺字段：「快照较旧：缺少 N 个规则字段（保存时按服务端默认合并补齐）」+ 按钮
     「按服务端默认补齐」（确认后 `putConfigKey(key, ctx.snap)` → reload，不改其它字段）。
  2. 快照含未知顶层键/番种键：「快照含本页未认识的新字段：X、Y（保存时原样保留）」+ 按钮
     「移除这些未知字段并保存」（confirm 列出键名 → 组装时不带未知键 → PUT → reload）。
- 快照缺失（`currentConfig[key]` 无该键）时卡片不渲染——`renderCfgDomain` 只渲染
  `k in currentConfig` 的键（admin/app.js:1808），不需要「配置未加载」整卡态。
- 行内错误使用独立类 `.mj-field-err`，**不得**用 `.row-state`
  （`setRowState` 取卡内第一个 `.row-state`，admin/app.js:2600-2605，会写到卡片脚注）。

### 4.3 读取与本地校验

`read()` 组装对象：

1. 从 `ctx.snap` 复制**未知顶层键**（D6；若已点「移除未知字段」则跳过）。
2. 对每个**已渲染的**顶层字段：从控件取值并校验；`preset` 与 `rulesVersion` 直接取快照值。
3. 番表按 D9 规则组装：`{ ...未知番种键, ...已填写行, ...存在且被清空的行→0 }`。

校验规则（与协议一致）：

- `int`：必须有值、整数、在 `[min,max]`；错误文案带字段中文名与范围。
- `enum`：值必须在选项集合内；`valueType:'number'` 转 Number 后校验。
- `bool`：取开关状态。
- 番表：整数 0–20；空按 D9 处理。
- 任何错误 ⇒ 行内红字（`.mj-field-err`），不发请求。

### 4.4 保存与重置

- 保存：既有 `saveRow(key, card, read)` / `putConfigKey`。
- 重置：
  1. `confirm('按「sbr」预设重置全部规则？\n将立即保存并覆盖当前所有规则字段；未保存的修改会丢失。\n（SBR 的花猪 48× 底在金币场还需 game.mahjong.sbrGoldEnabled=开）')`。
  2. `PUT { value: { preset, rulesVersion } }`（`rulesVersion` 取快照值）。
  3. 成功 ⇒ `loadAll()`；失败 ⇒ 顶栏错误，表单不动。

### 4.5 实时护栏（黄条，表单顶部，随输入刷新；按 D9 的「空 = 0」计算生效值）

1. `scoringPolicy === 'additive'` 且加法番表生效值全为 0 ⇒
   「当前所有牌型都是 0 番，只按底分结算。可点「按预设重置」恢复 SBR 默认番表。」
2. `scoringPolicy === 'named'` 且命名番表生效值全为 0 ⇒
   「命名番表为空：绝大多数牌只按平胡兜底 1 番，请先补齐番值。」
3. `minFanToHu > fanCap` ⇒ 「起胡番高于封顶番数：永远无法胡牌。」

### 4.6 文案与静态面

- `STRUCT_META['game.mahjong.rules'].label`：`四川麻将规则 JSON` → `四川麻将规则`。
- `CONFIG_NOTES['game.mahjong.rules']` 改写（作用/取值/生效/注意），保留搜索关键词：
  番表、封顶、换三张、呼叫转移、退税、花猪、查叫、时长、预设。
- `docs/games/mahjong.md` 增加「后台配置」小节：入口路径、表单字段分组、预设重置语义、
  raw JSON 已移除、与本文规则口径的对应关系；`chajiaoAllSameState` 标注「代码与 §6.2
  描述存在差异，另立片对账」。
- 新增样式：`.mj-group` / `.mj-fan-row` / `.mj-banner` / `.mj-field-err`（style.css 无现成类）。

### 4.7 左树叶修复

- `git cherry-pick 053a63a1`（已 `git apply --check` 通过）：
  `CFG_NAV` + `index.html` 左树 + 探针 + 静态闸。
- 与本片冲突时以本片为准；其探针断言不触规则编辑器，只要不把 rules 放进
  `admin-config-tabs-probe.mjs` 的 SNAPSHOT，`tabs().length===3` 与默认「场次开关」断言不受影响。

## 5. 测试判据

### 5.1 protocol 行为级门禁（新文件 `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`）

从 `admin/app.js` 用 `balancedBlock` + `vm` 提取 `MAHJONG_RULES_FORM`（必须纯字面量；
提取失败/结果为空 ⇒ 直接失败，**不得** catch 后继续），断言：

1. 顶层字段集合 = `Object.keys(DEFAULT_CHENGDU_RULES) − {preset, rulesVersion}`，无重复 `path`、无未知 `path`。
2. `bool` 字段集合 = 默认值为 `typeof 'boolean'` 的顶层键（4 个）。
3. 每个 `enum`：每个选项值都被 `parseMahjongRules({...默认, [path]: value})` 接受；
   一个合成非法值被拒；`valueType:'number'` 的选项喂数值。
4. 每个 `int`：`min`/`max` 被接受，`min-1`（≥0 时）/`max+1` 被拒。
5. 三张番表的键集合分别等于 `MAHJONG_NAMED_FAN_KEYS` / `MAHJONG_ADDITIVE_FAN_KEYS` /
   `MAHJONG_OPTIONAL_FAN_KEYS`；`fanLabels` 全覆盖、无多余。
6. 用描述表字段组装完整对象（含 D9 的 0 语义）经 `parseMahjongRules` 往返不变。

### 5.2 shared 标签一致性门禁（新文件 `packages/shared/src/mahjong/admin-labels.gate.test.ts`）

提取 `MAHJONG_RULES_FORM.fanLabels`，与 `scoring.ts` 的 `NAMED_LABELS` 交叉比对：
键有交集处标签文本必须一致（防止 admin 中文名与对局内展示名漂移）。

### 5.3 jsdom 探针（新文件 `scripts/admin-mahjong-rules-form-probe.mjs`）

照 `admin-config-tabs-probe.mjs`：真实 `index.html` + `app.js`，桩 `fetch`/`sessionStorage`/`confirm`；
**fetch 必须有状态**（PUT 更新内存快照，GET 返回最新值），否则验证不了保存后的重渲染。

1. 麻将域可见（左树叶在）、点进「玩法规则」页签出现表单；控件精确计数：
   20 个字段控件 + 34 个番表输入 + 预设控件；`data-field` 齐全。
2. 改 `fanCap=7`、`huazhuMode=burn48`、`fanTable.pingHu=2` → 保存 → `body.value` 完整且仅这三处变化。
3. D3：把重置下拉切到 sbr、再改一个字段保存 ⇒ `body.value.preset` 仍为快照原值。
4. D9：chengdu 快照清空 `fanTable.pingHu` → 保存 ⇒ `body.value.fanTable.pingHu === 0`，
   重载后仍为 0；sbr 快照清空 `additiveFanTable.fullFlush` ⇒ 0。
5. 越界（`fanCap=9`）→ 行内红字、无请求。
6. 护栏：sbr 快照（加法表非空）清空加法表并切 additive → 黄条 1 出现。
7. 重置：`confirm` 桩为真 → `body.value` 恰为 `{preset:'sbr', rulesVersion:<原值>}`。
8. 未知顶层键透传：快照塞 `xyz` → 保存 body 保留；点「移除并保存」→ body 不含 `xyz`。
9. 快照缺字段：删除 `claimWindowMs` → 该字段不渲染、信息条出现；点「按服务端默认补齐」→
   PUT body = 原快照。

### 5.4 静态闸 `verify-admin-static.mjs`

- `STRUCT_META` label 更新；`STRUCT_KEYS` 仍 7 项、`CONFIG_CONTROLS` 仍 89 项、
  `CONFIG_NOTES` 仍 96 条（本片只改一条的内容）。
- 新针脚：`MAHJONG_RULES_FORM`、`buildMahjongRulesEditor`、8 个分组标题、
  「按预设重置」按钮文案、「移除这些未知字段并保存」。
- 移除 `buildRulesJsonEditor` 的旧针脚（若有）。

### 5.5 回归与 CI

- `pnpm -C packages/protocol test`、`pnpm -C packages/shared test`（含新门禁）
- `node scripts/verify-admin-static.mjs`
- `node scripts/admin-mahjong-rules-form-probe.mjs`
- `node scripts/admin-config-tabs-probe.mjs`
- 新探针接线：root `package.json` 加 `verify:admin-mahjong-rules`；
  `scripts/ci.sh` stage 7 增加该探针。
- 全仓 `pnpm test` / `pnpm lint`（按 dev-process 第 8 节）
- 真浏览器冒烟：`bash scripts/deploy/preview.sh` 后人工走查 admin 配置页（或 `browser-e2e`）

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 本地非法值 | 行内红字（`.mj-field-err`），不发请求 |
| 服务端 400（未知番种/版本错位） | 顶栏错误原文透传；表单保持现值 |
| 重置失败 / 断网 | 顶栏错误；表单不动；可重试 |
| 重置时表单有未保存修改 | confirm 文案明示「未保存的修改会丢失」 |
| 快照缺字段（快照旧） | 字段隐藏 + 信息条 + 「按服务端默认补齐」按钮 |
| 快照含未知顶层键/番种 | 原样保留 + 信息条 + 「移除这些未知字段并保存」按钮 |
| 两个运营同时改 | 整键 last-write-wins（既有语义） |
| 结构卡无草稿 | `loadAll()` 会丢弃未保存的表单编辑（既有行为，所有结构卡一致；接受并登记） |
| 搜索 | `cfgQuery` 只匹配键名与 CONFIG_NOTES，不搜字段标签；关键词统一写进 CONFIG_NOTES |
| 快照缺失 | 卡片不出现（既有渲染逻辑），不做整卡空态 |

## 7. 风险与另立片

| 风险 | 缓解 |
|---|---|
| 描述表与协议漂移 | 5.1 行为级门禁；协议改范围/枚举/番键时门禁必红 |
| 中文番名与对局展示漂移 | 5.2 shared 标签门禁 |
| admin 体积（+约 500 行） | 单文件既有风格；描述表与渲染器分区注释 |
| 部署顺序错位 | D6/D15 双向自救；400 文案透传 |
| 真浏览器布局未验 | preview.sh 后的真浏览器冒烟列入 DoD |
| 熟悉 raw JSON 的运营失去灵活性 | 已确认移除（用户裁决）；交接文档写明 |

**另立片登记（本片不做）**：

- `chajiaoAllSameState` 代码与 `docs/games/mahjong.md` §6.2 语义对账（当前死配置）。
- `refundOnDraw` 两档同义、`selfDrawMode` addBase/addPoint 同义的规则清理。
- `selfDrawMode=addFan` 在 SBR（加法口径）下读空 `fanTable.ziMo` ⇒ +0 的口径问题。

## 8. 涉及文件

- `admin/app.js`：`MAHJONG_RULES_FORM`、`buildMahjongRulesEditor`、`CONFIG_NOTES`、
  `STRUCT_META`（`CFG_NAV` 随 cherry-pick）
- `admin/index.html`（左树叶，随 `053a63a1`）
- `admin/style.css`（`.mj-group` / `.mj-fan-row` / `.mj-banner` / `.mj-field-err`）
- `scripts/verify-admin-static.mjs`
- `scripts/admin-mahjong-rules-form-probe.mjs`（新）
- `scripts/admin-config-tabs-probe.mjs`（随 `053a63a1`）
- `scripts/ci.sh`、`package.json`（探针接线）
- `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`（新）
- `packages/shared/src/mahjong/admin-labels.gate.test.ts`（新）
- `docs/games/mahjong.md`（配置入口小节 + 差异标注）
- 本文件

## 9. 审查记录

**第一轮（2026-10-29，独立 reviewer）**：1 阻断 / 6 高 / 8 低；核心结论「修订后可以进入计划」。
逐条处置（全部已落到上面的 r2 正文）：

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | D9「空 = 删除键」不成立：服务端对缺键按 preset 默认合并，清空会被补回；护栏与探针会假绿 | D9 重写为「存在且清空 ⇒ 写 0；不存在且空 ⇒ 省略」；护栏按生效值计算；探针改为 chengdu/sbr 双快照验证（§5.3 #4） |
| 高 | D6「快照缺字段 ⇒ 服务端旧」推断错误，GET 不补齐 | 改为 D15：措辞改「快照较旧」，提供「按服务端默认补齐」按钮 |
| 高 | 未知键 pass-through + 无 raw JSON ⇒ 服务端回滚后保存永久 400 且无自救 | D6 增补「移除这些未知字段并保存」自救按钮 |
| 高 | 门禁测试写不出来：`TOP_KEYS`/`BOOLEAN_KEYS` 非导出；番键清单若外引则 vm 提取失败 | D16：从 `DEFAULT_CHENGDU_RULES` 推导；番键清单内嵌描述表；提取失败必须抛错；分组标题 8 个 |
| 高 | `fanBase` 选项写成字符串，提交必 400 | D17：数值选项 + `valueType:'number'` + read 转 Number |
| 高 | `chajiaoAllSameState` 选项文案与实现不符（且当前是死配置） | 文案改为「与照常赔付同义」+ note 说明 + 另立片登记 |
| 高 | 探针缺 D3/D9 断言、计数定义错误、#4 在默认快照下恒真、无状态 mock | §5.3 重写（精确计数、状态化 fetch、D3/D9/透传/补齐全覆盖） |
| 低 | `directGangMode='everyone'` 文案「三家都付」不符 | 改为「点杠者 2× 底 + 其余在场每家 1× 底」（actions.ts:153-166 实证） |
| 低 | `addFan` 在加法口径读 `fanTable.ziMo`，SBR 下 +0 | 写入 `selfDrawMode` note + 另立片登记 |
| 低 | 计数/行号错误（108→112 键、37→34 番项、tableValue 行号） | 已改 |
| 低 | 重置到 sbr 未提示金币场闸（`sbrGoldEnabled`） | 重置 confirm 文案补充 |
| 低 | 「配置未加载」整卡态不可达；`.row-state` 选择器冲突；结构卡无草稿；搜索不搜字段 | §4.2/§6 逐条写明 |
| 低 | 新探针未接 CI | §5.5 + §8 接线 |
| 低 | `preset` 改动语义的两句表述需澄清 | §1 与 D4 已澄清（JSON 编辑器携带完整对象；重置只带 preset） |
| 低 | fanLabels 与 `NAMED_LABELS` 双份拷贝无门禁 | 新增 5.2 shared 标签门禁 |

**已核对无问题**（reviewer 实证）：最小重置 PUT 链路成立（rules.ts:283-287 →
config.ts:505 → platform-config.service.ts:113-136 → 网关 P4）；消费侧缺键与 0 等价
（唯一读取点 scoring.ts:85-87）；本地范围/枚举与协议一致；静态闸计数不受影响；
`053a63a1` 可干净应用；jsdom 桩可行；本片无服务端行为、未触红线。

**第二轮（2026-10-29，自查 + 复核）**：blocking 与 highs 的证据均已在本机用
`packages/protocol/dist` 实测复现（preset 合并、显式 0、fanBase 字符串抛错、112 键、
`gangPayers` 源码）。r2 可进入计划阶段。
