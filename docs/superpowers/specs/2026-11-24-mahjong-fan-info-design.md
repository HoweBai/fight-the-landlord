# 麻将番型说明（admin 行内说明 + 客户端动态番表）设计

- 日期：2026-11-24
- 状态：设计已按独立对抗审查修订，待实现计划
- **Supersedes**：`docs/superpowers/specs/2026-10-29-mahjong-rules-form-design.md` D7（“不写 60 条三行文案，避免维护负担”）。本次为用户明确要求“判定 + 牌例 + 边界口径”，维护方式见 §2 D2/D9。
- 相关文档：`docs/games/mahjong.md`、`docs/client-protocol.md`

## 0. 背景与问题

1. **admin 配置页缺参考**：三张番表只有“名称 + 数值”，运营不知道每个番的判定条件、牌例、边界口径，容易配错（例如把主番候选当加番、把根和杠混为一谈）。
2. **客户端玩法介绍是静态的**：`apps/client/src/gameModes.ts` 的麻将介绍直接引用编译期常量 `MAHJONG_RULE_SUMMARY`，不会随后台 `game.mahjong.rules` 变化；玩家看到的番表和实际结算可能不一致。
3. **现有静态文案本身含有配置断言**：如“最后 4 张能胡必胡”“直杠：点杠者付 2×底”，这些都可被后台改开关；只追加动态段会造成同一弹层里两套互相矛盾的说法。

目标：
- admin 三张番表全部 34 项，每行常驻说明（判定条件 + 牌例 + 边界口径）。
- 客户端大厅麻将规则弹层：点开时拉取最新配置，动态展示当前启用的番型、番值、有效倍率、封顶、自摸与关键流程开关；失败保留旧内容。
- 说明内容只维护一份，admin 与客户端共用。

用户裁决（2026-11-24）：
- 展示形式：行内常驻说明。
- 说明详略：判定 + 牌例 + 边界口径。
- 覆盖范围：三张表全部 34 项。
- 客户端同步时效：打开介绍时拉最新。
- 实施路径：admin + 客户端合并做完。

## 1. 范围

### 做

- protocol 新增番型元数据单一真源 `MAHJONG_FAN_INFO`（34 键）。
- protocol 新增客户端规则视图 `MahjongRulesClientView` 与派生函数 `mahjongRulesClientView()`。
- protocol 新增文案生成器 `buildMahjongRuleSummary(rules?)`；无配置时与现有静态文案一致。
- `ClientGameConfig` 增加可选 `mahjongRules` 字段；config-service 在 `GET /api/config` 下发。
- 客户端 store 保存 `mahjongRules`；大厅规则弹层对麻将使用动态文案；点开时走**轻量刷新**（不修复玩法/场次选择）。
- admin 行内说明 + 样式 + 内容级门禁 + 表单探针。
- shared 番名标签收敛：加法番表 9 个键补中文标签，修复 SBR 结算显示英文键。
- 引擎行为审计测试：每个番键至少一个正例 + 一个反例。
- 文档更新：`docs/games/mahjong.md`、`docs/client-protocol.md`。

### 不做

- 实时推送（已裁决：打开介绍时拉最新）。
- 血流成河（XLCH）变体实现；但命名与计数必须为它前向兼容（见 D12）。
- 天胡/地胡接入引擎（当前实现未触发，文案标“预留未启用”）。
- i18n。
- 规则引擎/结算逻辑改动（shared 仅改标签字典）。
- 未列出的流程配置动态化（`refundOnDraw` / `huazhuPayees` / `chajiaoAllSameState` 等不进入客户端文案断言；静态文案保持配置中立）。
- 不做“60 条三行文案”的旧方案回退（已被本次用户裁决 supersede）。

## 2. 决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | 番型内容唯一真源放 protocol `MAHJONG_FAN_INFO`；admin 静态 JS 保留字面量副本，用**内容级深比较门禁**锁住 | admin 无构建步骤，不能 import TS；沿用现有 `MAHJONG_RULES_FORM` + vm 提取模式 |
| D2 | 元数据按受众分字段：`desc` / `example` / `playerCaveat`（玩家可见）、`adminOnly`（仅 admin 内部事实）、`wired`（引擎是否真的会触发） | 阻断 B2：内部实现事实不得进入玩家文案 |
| D3 | `tianHu` / `diHu` 的 `wired=false`；玩家文案显示“当前版本未启用（预留）”，不宣传为可用 | 阻断 B3：`huContext()` 从不置位这两个标记 |
| D4 | 静态文案拆成“配置中立段落”+“默认计分段”；有 rules 时用动态【番型与倍率】+【当前流程设置】**替换**默认计分段，其余段落保留 | 阻断 B1 + 高危 H2：避免静态“6 番/32×”与后台配置并存 |
| D5 | 客户端字段名 `mahjongRules`（不叫 `rules`），类型为显式白名单 `MahjongRulesClientView` | 高危 H7：`rules` 是禁出站键；pdk 用 `pdkRules`，XLCH 规划用 `mahjongRules.variant` |
| D6 | config-service 读取语义：行缺失 / `null` / `{}` / 坏值 ⇒ 不下发 + WARN；合法值 ⇒ 下发客户端视图 | 高危 H6 + L4/L5；缺失时实际引擎也用 chengdu 默认，客户端静态 fallback 与之一致 |
| D7 | 客户端点开介绍走专用轻量刷新：只更新 `mahjongRules`、不调用 `repairActiveMode`/`repairRoomMode`、单飞、响应缺 `mahjongRules` 时保留旧值 | 高危 H3/H4/H13：信息动作不得改变玩家选择；慢请求不得覆盖新值 |
| D8 | 动态段只列“已启用且 wired”的番；禁用番合并一行；命名/加法口径分别渲染；加番不单独显示倍率；说明文字值中立，数字从配置注入 | 高危 H1/H10/H11：可选番语义、格式契约、倍率口径 |
| D9 | 标签单一真源 = `MAHJONG_FAN_INFO.label`；shared `NAMED_LABELS` 从它派生；补加法表 9 个中文标签 | 高危 H8：三份标签漂移、SBR 结算英文键 |
| D10 | 每个番键必须有标准牌例 + `scoreBestHand` 行为断言（正例/反例）；`tianHu/diHu` 加“未接线”守卫 | 阻断 B3：文案不能只靠文本自证 |
| D11 | admin 说明渲染 `desc/example/playerCaveat/adminOnly/wired`；`adminOnly` 用独立样式；`wired=false` 加“当前版本未接入”徽标 | 阻断 B2 + 低 L1 |
| D12 | 所有计数从键数组派生（不硬编码 34/8）；`mahjongRules` 命名与字段为 XLCH 的 `variant` 留扩展位 | 高危 H12：XLCH 片已规划 9 组/36 番/`mahjongRules.variant` |
| D13 | 权威层级：`docs/games/mahjong.md` + 引擎实际行为 = 语义真源；`MAHJONG_FAN_INFO` 是展示副本；补 label/默认值 doc-sync 门禁 | 高危 H9；同时显式 supersede 2026-10-29 D7 |
| D14 | 测试分层：元数据覆盖门禁、玩家文案内部标记禁用闸、lobby 解析器格式契约、非默认配置 fixture、引擎行为审计、admin 逐键探针、config-service 三态 | 高危 H6/H10/H14 + 低 L6/L8 |
| D15 | 发布：admin 静态面走 `preview.sh`；客户端改动需 H5 部署 + 新 APK；旧 APK/旧服务端回退静态文案 | 低 L7 |
| D16 | 文案生成与渲染全部 `textContent`，不拼 HTML；元数据 `Object.freeze`；生成顺序按协议数组顺序 | 低 L8；避免 XSS 与顺序不稳定 |

## 3. 数据模型

### 3.1 `MahjongFanInfo`（protocol）

```ts
export type MahjongFanKind =
  | 'namedMain'      // 命名口径主番候选（只取最高）
  | 'namedAddon'     // 命名口径另加番（叠加后封顶）
  | 'additive'       // 加法口径特征（SBR）
  | 'optionalMain'   // 可选番里的主番候选
  | 'optionalAddon'; // 可选番里的另加番

export interface MahjongFanInfo {
  /** 中文名；admin 与玩家文案共用（标签单一真源）。 */
  label: string;
  kind: MahjongFanKind;
  /** 玩家可见：判定条件。必须值中立，不写具体番数。 */
  desc: string;
  /** 玩家可见：牌例/场景。值中立。 */
  example?: string;
  /** 玩家可见：边界口径。不得含内部实现标记。 */
  playerCaveat?: string;
  /** 仅 admin：实现现状、死配置、另立片等内部事实。 */
  adminOnly?: string;
  /** 引擎是否会真的触发。false ⇒ 玩家文案不宣传为可用。 */
  wired: boolean;
}
```

- `MAHJONG_FAN_INFO: Readonly<Record<string, MahjongFanInfo>>`，键集必须恰等于
  `MAHJONG_NAMED_FAN_KEYS ∪ MAHJONG_ADDITIVE_FAN_KEYS ∪ MAHJONG_OPTIONAL_FAN_KEYS`。
- 分类：
  - `namedMain`：`pingHu, duiDuiHu, qingYiSe, daiYaoJiu, qiDui, qingDui, jiangDui, longQiDui, qingQiDui, qingYaoJiu, qingLongQiDui`
  - `namedAddon`：`gangShangHua, gangShangPao, qiangGangHu, jinGouDiao, gen, ziMo`
  - `additive`：`root, allPungs, goldenWait, fullFlush, sevenPairs, winAfterKong, shootAfterKong, robbingKong, underTheSea`
  - `optionalAddon`：`duanYaoJiu, haiDi, perGang`
  - `optionalMain`：`shuangLong, sanLong, shiBaLuoHan, tianHu, diHu`
- `tianHu` / `diHu`：`wired=false`，`adminOnly` 写明“`HuContext` 未置位，当前版本不会触发”。
- `ziMo`：`playerCaveat` 写明“仅自摸加成 = 番 +1 时生效；addBase/addPoint/none 下不读本值”。
- `gen` / `root`：写明“龙七对/清龙七对的定义四张不算根；根包含杠开启时杠也计根（仅加法表 root）”。
- `perGang`：写明“按副露杠数线性相加；杠分另算”。
- `shuangLong/sanLong/shiBaLuoHan`：写明“主番候选，与其他主番取最高；不是另加番”。
- `duanYaoJiu/haiDi/perGang`：写明“命名口径下的另加番；加法口径整表不生效”。
- `jinGouDiao`：写明“加在对对胡型主番上，不是独立主番”。
- 所有 `desc/example/playerCaveat` 不得包含 `\n\n`，不得以 `【` 开头；门禁机械检查。

### 3.2 `MahjongRulesClientView`（protocol）

显式白名单，**逐字段赋值**，不使用 `Omit`/展开自动跟随新字段：

```ts
export interface MahjongRulesClientView {
  scoringPolicy: MahjongScoringPolicy;
  fanBase: 0 | 1;
  fanCap: number;
  fanTable: Record<string, number>;
  additiveFanTable: Record<string, number>;
  optionalFans: MahjongOptionalFans;
  rootIncludesKong: boolean;
  selfDrawMode: MahjongSelfDrawMode;
  minFanToHu: number;
  exchangeThreeEnabled: boolean;
  exchangeDirection: MahjongExchangeDirection;
  lastFourForcedHu: boolean;
  passHuMode: MahjongPassHuMode;
  directGangMode: MahjongDirectGangMode;
  gangTransfer: MahjongGangTransfer;
  huazhuMode: MahjongHuazhuMode;
  chajiaoEnabled: boolean;
}
```

- `mahjongRulesClientView(rules: MahjongRulesConfig): MahjongRulesClientView`：逐字段拷贝；番表/可选番用浅拷贝，避免共享引用。
- **不下发**：`preset`、`rulesVersion`、`claimWindowMs`、`exchangeWindowMs`、`lackWindowMs`、`refundOnDraw`、`huazhuPayees`、`chajiaoAllSameState`。
- 协议测试锁死客户端视图键集（新增规则字段必须显式决定是否进视图）。

### 3.3 `ClientGameConfig`

```ts
export interface ClientGameConfig {
  // ...现有字段
  /** 麻将规则客户端视图；旧服务端/坏值 ⇒ 缺省，客户端回退静态介绍。 */
  mahjongRules?: MahjongRulesClientView;
}
```

### 3.4 文案生成器（protocol）

```ts
export const MAHJONG_BASE_SUMMARY: string;        // 配置中立段落（基本规则 / 血战到底 / 刮风下雨）
export const MAHJONG_TIMEOUT_SECTION: string;     // 超时与托管（配置中立）
export const MAHJONG_RULE_SUMMARY: string;        // MAHJONG_BASE_SUMMARY + 默认计分段 + MAHJONG_TIMEOUT_SECTION（fallback）
export function buildMahjongRuleSummary(rules?: MahjongRulesClientView): string;
```

契约：
- `buildMahjongRuleSummary(undefined)` 与 `MAHJONG_RULE_SUMMARY` **逐字相等**（测试钉死）。
- 有 rules 时输出顺序：
  1. 配置中立段落（基本规则 / 血战到底 / 刮风下雨）
  2. `【番型与倍率】`（替换默认计分段）
  3. `【当前流程设置】`
  4. `【超时与托管】`（配置中立）
- **配置中立段落不得包含可被后台关闭/改写的完整性断言**（如“最后 4 张能胡必胡”“过水同张锁定”“直杠只由点杠者付”）；这些事实只出现在【当前流程设置】。原静态文案中的相关句子迁出或改成不带完整性强度的表述。
- 段落格式必须满足 lobby 解析器：
  - 段之间 `\n\n`；
  - 每段首行整行 `【标题】`；
  - 列表项以 `· ` 开头；
  - 正文不得出现 `\n\n` 或整行 `【…】`。
- fallback 静态计分段首行加“默认口径，实际以房间设置为准”。

动态段内容规则：
1. 首行：`计分方式：命名番表 / 加法番表；底番 B；封顶 F 番（×M）；自摸：…`。
2. 命名口径：
   - 主番候选（`namedMain`，且值 > 0、wired）：`· 名称 N 番（封顶后 ×M）：desc。例：example。⚠ playerCaveat`；
   - 另加番（`namedAddon`，`ziMo` 单独在自摸行说明）：`· 名称 +N 番：desc…`，不显示独立倍率；
   - 可选主番（`optionalMain`，值 > 0）：同主番候选；
   - 可选另加番（`optionalAddon`，值 > 0）：同另加番；
   - 值为 0：不列出；末尾一行 `· 未启用：…`；
   - 全部为 0：输出“当前未配置任何番型，只按底分结算”。
3. 加法口径：
   - 逐项列出 `additive` 值 > 0 的键：`· 名称 +N 番/组：desc…`；
   - 说明“各项相加后按封顶 F 番（×M）结算”；
   - `optionalFans` 整表不展示，并注明“加法口径不使用可选番”。
4. 数值口径：
   - `M = 2 ** Math.max(0, Math.min(值, F) − B)`；
   - 主番表值 > 封顶时显示“表值 N 番 / 封顶后 ×M”；
   - `pingHu=0` 且命名口径：按引擎兜底显示“平胡（兜底 1 番）”；
   - `minFanToHu > fanCap`：输出失败态提示“当前配置无法胡牌”（与实际引擎一致）；
   - `selfDrawMode=addFan` 时按 `fanTable.ziMo` 的值说明；加法口径读同一键。
5. `wired=false` 且值 > 0：不进入已启用列表，改为“预留未启用：天胡、地胡”。
6. 生成顺序按协议数组顺序（`MAHJONG_NAMED_FAN_KEYS` 等），不得依赖对象插入顺序。

【当前流程设置】内容（只列会与静态文案冲突的开关）：
- 换三张：开/关；开启时方向（随机/顺时针/逆时针/对家）。
- 最后 4 张：能胡必胡 / 可过。
- 过水：不限制 / 同张不可胡 / 同张或加番可胡。
- 直杠：仅点杠者付 2×底 / 家家有（点杠者 2×底 + 其余每家 1×底）。
- 杠分转移：退回 / 转给每个赢家 / 均分。
- 花猪：按当前配置赔给未胡玩家（封顶分）/ 销毁 48×底 / 不罚。
- 查叫：开 / 关。
- 自摸：每家多付 1×底 / 番 +1 / 无加成。
- 定缺：必选（无开关，仅作说明）。

## 4. config-service 下发设计

`packages/config-service/src/config/client-config.controller.ts`：

```ts
function readMahjongRules(byKey: ConfigByKey): MahjongRulesClientView | undefined {
  const raw = byKey.get('game.mahjong.rules');
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return undefined;
  try {
    return mahjongRulesClientView(parseMahjongRules(raw));
  } catch {
    this.logger.warn('mahjong rules invalid; client intro falls back to static');
    return undefined;
  }
}
```

- `games.mahjong` 仅在视图存在时带 `mahjongRules` 字段（条件展开，不写 `undefined`）。
- 顶层 23 键、`/api/config/boot` 三键不变。
- 缺失/坏值：不下发；客户端静态 fallback 与实际引擎默认（chengdu）一致。
- 坏值 WARN 不含完整规则值（只报键名）。

## 5. 客户端设计

### 5.1 store

- `ClientConfigState` 增加 `mahjongRules: MahjongRulesClientView | null`，初值 `null`。
- `setClientConfig(cfg)`：
  - `this.mahjongRules = cfg.games?.mahjong?.mahjongRules ?? this.mahjongRules;`
  - **响应缺 `mahjongRules` 时保留旧值**，不得清空。
- 新增 `setMahjongRules(rules: MahjongRulesClientView | null)`，仅改这一个字段。

### 5.2 轻量刷新

`apps/client/src/composables/useClientConfig.ts` 新增：

```ts
let mahjongRulesInFlight: Promise<boolean> | null = null;

export function refreshMahjongRules(): Promise<boolean> {
  if (mahjongRulesInFlight) return mahjongRulesInFlight;
  mahjongRulesInFlight = (async () => {
    try {
      const res = await fetchClientConfig();
      if (res.code !== 0 || !res.data) return false;
      const rules = res.data.games?.mahjong?.mahjongRules;
      if (!rules) return false; // 保留旧值
      useGameStore().setMahjongRules(rules);
      return true;
    } catch {
      return false;
    } finally {
      mahjongRulesInFlight = null;
    }
  })();
  return mahjongRulesInFlight;
}
```

- **不调用** `repairActiveMode()` / `repairRoomMode()`；不改动档位/场次/玩法选择。
- 单飞：重复点开共享同一个 promise。
- 失败/缺字段：保留旧值。

### 5.3 大厅规则弹层

- `openRule(modeId)`：原有同步行为不变；若 `modeId === GAME_META.mahjong.id`，`void refreshMahjongRules()`。
- `ruleSections`：
  ```ts
  const desc = currentRuleMode.value?.id === GAME_META.mahjong.id
    ? buildMahjongRuleSummary(useGameStore().mahjongRules ?? undefined)
    : currentRuleMode.value?.description;
  ```
- 渲染器不变（仍按 `【标题】` / `· ` 解析）。
- 现有“点 info 不切换选中玩法”测试保持绿。

## 6. admin 设计

### 6.1 数据

`MAHJONG_RULES_FORM` 新增：

```js
fanNotes: {
  pingHu: {
    desc: '……',
    example: '……',       // 可省略
    playerCaveat: '……',  // 可省略
    adminOnly: '……',     // 可省略
    wired: true,
  },
  // ... 34 键
}
```

- `fanLabels` 保留现有结构；门禁同时核对 `fanLabels` 与 `fanNotes`。
- 所有文本为纯字面量；不得含 `\n\n`；不得以 `【` 开头。

### 6.2 渲染

`buildFanGroup` 在每个 `.mj-fan-row` 末尾追加：

```html
<div class="mj-fan-note">
  <p class="mj-fan-desc">判定条件</p>
  <p class="mj-fan-example">例：…</p>          <!-- 有 example 时 -->
  <p class="mj-fan-caveat">⚠ …</p>             <!-- 有 playerCaveat 时 -->
  <p class="mj-fan-admin">内部：…</p>          <!-- 有 adminOnly 时 -->
  <span class="mj-fan-wired">当前版本未接入</span> <!-- wired=false 时 -->
</div>
```

- 全部用 `textContent`。
- CSS：
  ```css
  .mj-fan-note { flex-basis: 100%; margin: 0 0 0 130px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; line-height: 1.5; }
  .mj-fan-desc { color: var(--dim); }
  .mj-fan-example { color: var(--dim); opacity: .85; }
  .mj-fan-caveat { color: #b8860b; }
  .mj-fan-admin { color: var(--dim); font-style: italic; }
  .mj-fan-wired { align-self: flex-start; color: #b8860b; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  ```

### 6.3 门禁与探针

- `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`：
  - `fanNotes` 键集 = 三张番表键并集；
  - `fanLabels` 与 `MAHJONG_FAN_INFO.label` 逐键相等；
  - `fanNotes` 与 `MAHJONG_FAN_INFO` 的投影（`desc/example/playerCaveat/adminOnly/wired`）逐键深比较；
  - 每个 `desc` 非空；无 `\n\n`；无 `【` 开头；`wired` 为布尔。
- `scripts/admin-mahjong-rules-form-probe.mjs`：
  - 每行都有 `.mj-fan-note`；按 `data-field` 与 `fanNotes` 对应；
  - 抽查平胡/清一色/龙七对/根/每杠/天胡文案；
  - 原有 34 计数改为从 `tables.keys` 派生（D12）；
  - 保存/重置流程断言不变。
- `scripts/verify-admin-static.mjs`：把 `mjFormBlock.length > 500` 加强为分组标题/键名/渲染器/重置按钮仍在块内（低 L9）。

## 7. 标签收敛（shared）

- `packages/shared/src/mahjong/scoring.ts` 的 `NAMED_LABELS` 改为从 `MAHJONG_FAN_INFO` 派生：
  ```ts
  const NAMED_LABELS: Record<string, string> = Object.fromEntries(
    Object.entries(MAHJONG_FAN_INFO).map(([k, v]) => [k, v.label]),
  );
  ```
- 新增加法表 9 个中文标签（`root/allPungs/goldenWait/fullFlush/sevenPairs/winAfterKong/shootAfterKong/robbingKong/underTheSea`）。
- 结算 `items` 不再出现英文键；补测试。
- `packages/shared/test/admin-mahjong-labels.gate.test.ts` 保留（现在比的是 admin 标签 vs 派生标签），并扩展为全 34 键覆盖。

## 8. 引擎行为审计（B3）

新增 `packages/shared/src/mahjong/fan-behavior.test.ts`：

- 对每个 34 键建立至少一个正例、一个反例：
  - 命名主番：用完整 14 张手牌 + 副露构造，`scoreBestHand` 断言 `baseName`/`items` 含该键；
  - 命名加番：设置 `HuContext` 或手牌特征，断言 `items` 含该键；
  - 加法特征：用 SBR 规则（`scoringPolicy='additive'`），断言 `items` 含对应键；
  - 可选番：开启对应值，断言主番/加番位置正确；
  - `tianHu/diHu`：`wired=false`；新增 `huContext() 不置位天胡/地胡` 的守卫测试，防止未来接线后忘记更新元数据；
  - 反例：不满足条件时该键不出现。
- 测试必须使用真实 `scoreBestHand`/`deriveFeatures`，不得只断言元数据文本。
- 每个正例的手牌同时作为 `example` 的校验参考（人工核对，测试内注明）。

## 9. 文档

- `docs/games/mahjong.md`：
  - §4.1/§4.2 明确“展示文案来自 `MAHJONG_FAN_INFO`，语义以本文 + 引擎为准”；
  - §9 修正天胡/地胡：当前实现未触发，配置开启也不会生效（预留）。
  - 新增“客户端玩法介绍”小节：`games.mahjong.mahjongRules` 来源、缺失 fallback、打开时刷新。
- `docs/client-protocol.md`：补充 `ClientGameConfig.mahjongRules` 形状、缺失语义、不下发字段清单。
- `docs/superpowers/specs/2026-10-29-mahjong-rules-form-design.md`：仅在文首加 supersede 指针（不重写历史 spec）。

## 10. 测试判据

| 面 | 判据 |
|---|---|
| protocol | `MAHJONG_FAN_INFO` 键集/ kind / 字段非空 / 无 `\n\n`；`buildMahjongRuleSummary(undefined)` 与 `MAHJONG_RULE_SUMMARY` 逐字相等；默认成都/自定义封顶/关番/加法口径/全 0/天胡预留 的生成文本符合 §3.4；客户端视图键集精确 |
| protocol/admin 门禁 | `fanNotes` 与元数据投影逐字相等；`fanLabels` 与 label 相等；键集 34 派生 |
| shared | 每个番正例/反例；`NAMED_LABELS` 34 键；加法口径结算中文标签；doc-sync 每个 label 在 docs 出现；默认番值与 docs §4.1/§4.2 一致 |
| config-service | 合法值下发完整视图；缺失/`null`/`{}`/坏值不下发；顶层 23 键不变；boot 三键不变；`games` 精确断言更新 |
| client | 有 rules 时弹层出现动态段并显示当前值；无 rules 回退静态；`openRule` 触发单飞刷新；刷新不改变 activeMode/roomMode；响应缺 `mahjongRules` 保留旧值；失败保留；解析器不丢段 |
| admin | 34 行说明渲染、逐键对应、抽查内容、原有保存/重置仍绿 |
| 全量 | `pnpm -C packages/protocol test`、`pnpm -C packages/shared test`、`pnpm -C packages/config-service test`、`pnpm -C apps/client test`、`pnpm verify:admin`、`pnpm verify:admin-mahjong-rules`、`pnpm lint` |

## 11. 错误处理与边界

- 旧服务端 / `mahjongRules` 缺失：客户端静态文案（含“默认口径”提示）。
- 坏 rules：config-service 不下发 + WARN；客户端保留旧值。
- 全部番值为 0：动态段“当前未配置任何番型”，不空白。
- `pingHu=0`：引擎仍兜底 1 番；文案如实说明。
- `minFanToHu > fanCap`：动态段明确“当前配置无法胡牌”。
- 刷新竞态：单飞；响应缺字段不清空。
- 打开介绍期间刷新完成：允许文本更新一次；不改变玩法/场次选择；如内容变化明显，后续可加“规则已更新”提示（本片不做）。
- App：旧 APK 永远显示静态文案；新 APK 才显示动态番表；验收分开记录。

## 12. 涉及文件

- `packages/protocol/src/mahjong/fan-info.ts`（新）
- `packages/protocol/src/mahjong/client-view.ts`（新）
- `packages/protocol/src/mahjong/rule-summary.ts`
- `packages/protocol/src/mahjong/index.ts`
- `packages/protocol/src/config.ts`
- `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`
- `packages/protocol/src/mahjong/fan-info.test.ts`（新）
- `packages/shared/src/mahjong/scoring.ts`
- `packages/shared/src/mahjong/doc-sync.test.ts`
- `packages/shared/src/mahjong/fan-behavior.test.ts`（新）
- `packages/shared/test/admin-mahjong-labels.gate.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/test/client-config.test.ts`
- `apps/client/src/composables/useClientConfig.ts`
- `apps/client/src/stores/game.ts`
- `apps/client/src/pages/lobby/lobby.vue`
- `apps/client/test/lobby-modes.test.ts`（或新增 `mahjong-rules-intro.test.ts`）
- `admin/app.js`
- `admin/style.css`
- `scripts/admin-mahjong-rules-form-probe.mjs`
- `scripts/verify-admin-static.mjs`
- `docs/games/mahjong.md`
- `docs/client-protocol.md`
- 本 spec

## 13. 审查记录（2026-11-24 独立对抗审查）

审查者：独立子代理（sonnet），只读真实代码。结论：需修订后再审；修订 B1–B3 并处置 H1–H14 后可进入计划。

| 编号 | 级别 | 问题 | 处置 |
|---|---|---|---|
| B1 | 阻断 | 静态【计分】与动态段合成规则未定义 | D4：拆分中立段 + 替换计分段 + 流程段；fallback 加“默认口径” |
| B2 | 阻断 | admin/玩家受众未分层 | D2/D11：拆玩家字段与 `adminOnly`；加内部标记禁用闸 |
| B3 | 阻断 | 文案与引擎无行为级关联；天胡/地胡未接线 | D3/D10：`wired` 标记 + 每番正反例 + 未接线守卫 |
| H1 | 高 | 可选番语义注记错误 | D8/D9：双龙/三龙/十八罗汉/天胡/地胡=主番候选；加法口径整表不生效；修正文案 |
| H2 | 高 | 静态流程断言与可配开关矛盾 | D4：新增【当前流程设置】；静态段改为配置中立 |
| H3 | 高 | 刷新触发 `repairActiveMode/RoomMode` 副作用 | D7：专用轻量刷新，不修复选择 |
| H4 | 高 | 刷新无单飞/序号，旧响应覆盖新响应 | D7：单飞；测试钉住 |
| H5 | 高 | 刷新不维护大厅档位状态 | D7：轻量刷新不碰档位；不引入档位副作用 |
| H6 | 高 | 配置契约测试会红；缺三态断言 | D6/D14：精确断言 + 缺失/null/{}/坏值测试 |
| H7 | 高 | `rules` 是禁出站键；完整规则暴露内部调参 | D5：改名 `mahjongRules` + 显式客户端白名单 |
| H8 | 高 | 标签三份拷贝；加法口径结算英文键 | D9：protocol label 单一真源；shared 派生；补 9 键 |
| H9 | 高 | 文档是唯一规则来源但新内容无门禁 | D13：权威层级 + label/默认值 doc-sync；supersede D7 |
| H10 | 高 | 生成文案格式无契约测试，易假绿 | D14：解析器契约测试（标题/空段/bullet/active policy） |
| H11 | 高 | 值中立与倍率口径未定义 | D8：值中立 + 数字注入 + 封顶/兜底/起胡边界 |
| H12 | 高 | 与 XLCH 变体前向不兼容（硬编码 34/8） | D12：计数派生；`mahjongRules` 命名；variant 留扩展位 |
| H13 | 高 | 刷新响应缺 `games` 会清空 rules | D7：store 保留旧值；缺字段不覆盖 |
| H14 | 高 | 元数据键覆盖/kind 一致性无门禁 | D14：键集/kind/字段/换行门禁 |
| L1 | 低 | admin 说明布局（flex vs grid） | D11：`.mj-fan-note` flex 全宽 |
| L2 | 低 | 与旧 spec D7 冲突 | 本 spec supersede；维护方式写入 D1/D9/D10 |
| L3 | 低 | 文档同步遗漏 | D13/§9 |
| L4 | 低 | `parseMahjongRules(null/{})` 语义 | D6：null/{}/缺失不下发 |
| L5 | 低 | 坏 rules 静默无日志 | D6：WARN（不含敏感值） |
| L6 | 低 | admin 探针只数数量 | D14：逐键内容断言 |
| L7 | 低 | 发布/回退面未登记 | D15/§11 |
| L8 | 低 | 生成顺序/冻结/确定性 | D16：协议数组顺序 + freeze |
| L9 | 低 | `verify-admin-static` 判据过弱 | §6.3：加强块内容断言 |

**未在本次处置的登记项**：
- 实时推送：明确不做。
- XLCH 变体实现：另立片；本片只保证命名/计数前向兼容。
- 天胡/地胡接线：另立片；本片只保证文案不撒谎。
- `chajiaoAllSameState` / `refundOnDraw` 同义/死配置：不进客户端视图，不在文案断言。

## 14. 未来片

- XLCH 血流成河：`mahjongRules.variant`、36 番、9 组表单、客户端按 variant 选文案。
- 客户端配置实时推送（若确有需求）。
- 天胡/地胡接线（若确有需求），接线后把 `wired` 改 true 并补行为测试。
