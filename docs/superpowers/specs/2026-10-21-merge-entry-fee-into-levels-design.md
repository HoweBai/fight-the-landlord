# 台费并入底分档位表（方案 A 阶段 1）— 设计

- 日期：2026-10-21
- 前置：缺省底分去冻结片（`dev-b19347a`）已上线测试服
- 用户裁决（2026-10-21）：采用方案 A——台费费率并入档位表，消除「只改档位、忘改费率」的双份配置漂移
- 范围：protocol / config-service / room-service / admin / conformance / 文档；**客户端零改动**
- 阶段：本片只做**阶段 1**（单一真源 + 兼容输出 + 旧键只读）；阶段 2（删除旧键）另立片
- 审查轮次：r1（1 阻断 / 5 高 / 5 低）+ r2（3 高）——全部处置；见 §9

## 1. 背景 / 问题

当前台费与档位是两份配置，靠 `baseScore` 数值对齐：

- `game.baseScoreLevels`：大厅档位卡、缺省底分、救助门槛；
- `currency.entryFeePercents`：按房间底分精确匹配的台费费率。

两份配置必须人工同步。新增档位但忘记加费率行 ⇒ 该档 **0 台费**；删除档位但忘记删费率行 ⇒
孤儿行（未来复用同数值时继承旧费率）。用户明确感到「容易只改一边」。

目标：把台费变成档位的一个属性，**结构上不可能只改一边**；同时保持客户端契约不变，避免一次大爆炸。

## 2. 范围

**做（阶段 1）**

- `game.baseScoreLevels` 每项新增可选 `entryFeePercent`（整数 0–50；缺省 = 0）；
- 全部服务端读取改从档位表派生费率；旧键 `currency.entryFeePercents` **保留但不再被读取，且拒绝写入**；
- `/api/config` 继续下发 `entryFeePercents`（由档位表派生，形状不变）⇒ **客户端零改动**；
- admin：档位表编辑器增加「台费%」列；旧费率编辑器改为只读弃用提示（禁用保存）；
- **过渡写保护**：旧 admin 页面（无第三列）保存档位表时，服务端按 `baseScore` 保留已有费率，
  避免静默清零（阶段 2 移除该规则）；
- conformance slice-25 改为通过档位表开关台费，并**快照/恢复实际值**；
- 测试与文档。

**不做（阶段 2 另立片）**

- 不删除 `currency.entryFeePercents` 配置键、不删 `parseEntryFeePercents`、不改 CONFIG_KEYS 键数；
- 不写数据库迁移（当前所有环境费率均为 0%）；
- 不改 `entryFeeOf` 的算法与保底语义；
- 不改客户端代码（它仍消费 `/api/config` 的 `entryFeePercents` 输出）。

### 方案对比（为何选 A）

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采纳）** | 台费并入档位表；`/api/config` 派生输出保持客户端契约 | 结构上消除漂移；客户端零改动；当前费率全 0 ⇒ 迁移成本最低 |
| B | 保留两键，admin 合并编辑面 + 原子双键写 | 存储仍两份；新增一条写路径与锁序/审计复杂度；API 直改仍可能漂移 |
| C | 只加提示/一键补 0% | 最便宜，但不根治；用户明确要结构性方案 |

## 3. 决策表

| # | 决策 | 依据 |
|---|------|------|
| D1 | `BaseScoreLevel` 增加可选 `entryFeePercent?: number`（整数 0–50；缺省 = 0） | 单一真源；旧值缺失字段仍合法，无需迁移 |
| D2 | 新费率**唯一来源** = `game.baseScoreLevels[].entryFeePercent`；旧键保留但成为**惰性只读键** | 用户裁决方案 A；阶段 1 保留旧键避免键数/迁移大爆炸 |
| D3 | `/api/config` 的 `baseScoreLevels` 原样下发（可能多出 `entryFeePercent`），`entryFeePercents` 改为**派生输出** | 客户端契约零变化；旧 App/H5 忽略多出字段、继续读派生表 |
| D4 | 派生逻辑只写**一份**：protocol 新增 `entryFeePercentsFromLevels(levels)`；config-service 输出与 room-service 缓存共用 | 本仓对「同一事实两处实现」付过多次代价 |
| D5 | room-service `entryFeePercents()` 改为读档位表快照并派生；**失败方向仍是 `[]`（fail-open = 不收）** | 收费块失败方向必须是不收；与 `baseScoreLevels()` 的 fail-closed 分层保持 |
| D6 | admin 档位表编辑器改为三列：档名 / 底分 / 台费%；保存时每条都写 `entryFeePercent`（含 0）；**初始渲染与 reset 两条路径都传第三列** | 一次编辑完成两件事；显式 0 胜过缺字段 |
| D7 | admin 旧费率编辑器改为**只读弃用卡片**，展示旧值参考；`buildStructCard` 对该键 `saveBtn.disabled = true` | 防止运营继续改一个不生效的键 |
| D8 | `currency.entryFeePercents` 仍保留在 CONFIG_KEYS / CONFIG_IA / STRUCT_KEYS 中（键数 52 不变） | 阶段 1 不触碰键面/静态闸；阶段 2 再删 |
| D9 | 删除档位 ⇒ 台费自动消失；新增档位 ⇒ 默认 0%；改档名/顺序不影响费率 | 合并后的结构性收益 |
| D10 | 当前种子费率全 0 ⇒ **无需迁移**；部署前必须查旧键是否全 0（硬步骤）；非零则先回填 | 新代码不读旧键；这是唯一的数据风险 |
| D11 | conformance slice-25：**快照实际档位表** → 仅把 15 档改 10%（其余显式 0）→ PUT → 断 GET levels 与 `/api/config` 两处（玩家 token 用 B 组已注册用户）→ 正常/`finally` 用**语义快照**（每条都带 `entryFeePercent ?? 0`）恢复，恢复后再断 `/api/config` = **快照的派生值**（不假定全 0，避免测试服人工费率造成假红） | 不硬编码种子、不污染测试服人工配置；两处断言缺一不可 |
| D12 | 客户端零改动：`entryFeePercents` 输出形状不变，`lobby.vue` / `store` / `entryFeeOf` 全部不动 | 降低回归面 |
| D13 | **旧形态写入一律 400**：提交的档位表若**所有条目都缺 `entryFeePercent`**（= 旧 admin 页面），服务端在 `parseConfigValue` 之前拒绝并提示硬刷新；只要任一条目带该字段，整表按提交值生效（缺字段的条目 = 0） | r2：比「服务端按旧值合并」简单、可预测；旧页面保存失败会由 admin 行内错误显示；阶段 2 移除 |
| D14 | 旧键 `currency.entryFeePercents` 的**写入一律 400**（读/快照保留） | 避免 API 层「看起来能改、实际不生效」；旧 admin 的费率编辑器会收到明确错误 |
| D15 | config-service 输出前用 `parseConfigValue('game.baseScoreLevels')` 复核；缺键/非数组/坏元素 ⇒ `baseScoreLevels: []` + `entryFeePercents: []`（不抛 500） | 与 §5 承诺一致；玩家面不因坏配置 500 |
| D16 | parser **必须把 `entryFeePercent` 写回**返回对象（缺省时不写 `undefined` 自有属性）；测试用 `toStrictEqual` 做 round-trip | r1 阻断项：否则整片静默全 0 |
| D17 | admin 静态闸断言必须**收窄到函数块**（`balancedBlock`），不能只查全文 `entryFeePercent`（复数键名已使其恒真） | 防止假绿 |
| D18 | 部署前硬步骤：查旧键全 0；非零时**先部署新镜像 → 放量前用新 admin 写档位表（带 `entryFeePercent`）→ GET 自证 → 再放量**；回滚前把当前档位表费率同步回旧键（旧代码会重新读旧键） | 过渡窗口的真实风险；旧 provider 的 parser 会丢字段，不能靠旧栈回填 |
| D19 | 阶段 2 checklist 写进本 spec（删键/迁移/键数/admin/静态闸/保留 `/api/config` 派生输出） | 防止遗漏 |

## 4. 实现设计

### 4.1 `packages/protocol/src/config.ts`

```ts
export interface BaseScoreLevel {
  name: string;
  baseScore: number;
  /** 台费百分比（整数 0–50；缺省 = 0 = 不收）。2026-10-21 起为台费唯一来源。 */
  entryFeePercent?: number;
}

/** 台费率派生（唯一实现）：缺省字段 ⇒ 0。 */
export function entryFeePercentsFromLevels(
  levels: ReadonlyArray<BaseScoreLevel>,
): EntryFeePercent[] {
  return levels.map((l) => ({ baseScore: l.baseScore, percent: l.entryFeePercent ?? 0 }));
}
```

- `parseBaseScoreLevels`：
  - 若 `entryFeePercent` 存在，必须是整数 `0 ≤ n ≤ 50`；不存在合法；
  - **校验通过后写回**：`const out = { name, baseScore }; if (entryFeePercent !== undefined) out.entryFeePercent = entryFeePercent; levels.push(out);`
  - 不写入 `undefined` 自有属性（`JSON.stringify` 会丢，`toStrictEqual` 会露）。
- `parseEntryFeePercents` / `entryFeeOf` **不动**（旧键仍可读/校验；阶段 2 删）。
- `ClientConfig.entryFeePercents` 注释更新为「由档位表派生」。

### 4.2 `packages/config-service/src/config/client-config.controller.ts`

```ts
let levels: BaseScoreLevel[] = [];
try {
  levels = parseConfigValue(
    'game.baseScoreLevels',
    byKey.get('game.baseScoreLevels') ?? [],
  ) as BaseScoreLevel[];
} catch {
  levels = []; // 坏配置 ⇒ 玩家面空表（不 500）
}
...
baseScoreLevels: levels,
entryFeePercents: entryFeePercentsFromLevels(levels),
```

- 不再读 `currency.entryFeePercents` 键。
- 缺键 ⇒ `[]`；非数组/坏元素 ⇒ `[]`（D15）。

### 4.3 `packages/config-service/src/config/platform-config.service.ts`

**写入口两道守卫**（都在 `parseConfigValue` **之前**，确保收到「已弃用/请刷新」而不是泛化校验错）：

```ts
// D14：旧键只读
if (key === 'currency.entryFeePercents') {
  throw new ProtocolError(
    'currency.entryFeePercents 已并入 game.baseScoreLevels（阶段 1 只读），请改档位表的 entryFeePercent',
  );
}

// D13：旧 admin 页面（所有条目都缺 entryFeePercent）一律拒绝，避免静默清零
const isLegacyShape =
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item) => item !== null && typeof item === 'object' && !('entryFeePercent' in item),
  );
if (key === 'game.baseScoreLevels' && isLegacyShape) {
  throw new ProtocolError(
    '档位表写入缺少 entryFeePercent（管理页面已更新，请硬刷新后重试；API 写入请显式给 0–50）',
  );
}

const normalized = parseConfigValue(key, value);
```

- 只要任一条目带 `entryFeePercent`，整表按提交值生效；缺字段的条目 = 0
  （parser 保留已有字段、缺省不写自有属性）。
- **不做**服务端按旧值合并（r2：隐藏语义 + 多处写路径/审计特例 + 与 conformance 恢复冲突；
  400 更简单、可预测）。
- 阶段 2 删除旧键与两道守卫。

### 4.4 `packages/room-service/src/config/config-cache.service.ts`

```ts
entryFeePercents(): EntryFeePercent[] {
  const value = this.snapshot?.['game.baseScoreLevels']?.value;
  if (value === undefined) return [];
  try {
    const levels = parseConfigValue('game.baseScoreLevels', value) as BaseScoreLevel[];
    return entryFeePercentsFromLevels(levels);
  } catch {
    return [];
  }
}
```

- 失败方向保持 `[]`（不收）；不回退旧键。
- `rooms.start.ts` 收费块、`entryFeeOf`、免单/指标面**不动**。

### 4.5 `admin/app.js`

**档位表编辑器**（`buildLevelsEditor`）：

- `addRow(name, baseScore, entryFeePercent)`：第三列 `input[type=number][min=0][max=50]`；
  既有行缺字段时显示 `0`。
- 保存 getter：校验 `entryFeePercent` 为 0–50 整数；输出 `{ name, baseScore, entryFeePercent }`（含 0）。
- **初始渲染与 reset 都传 `item?.entryFeePercent`**（r1 F9：只改初始渲染会让「还原」把第三列清零）。
- 提示文案：「底分须为正整数、唯一、≤ 8191；台费为 0–50 的整数百分比（0 = 不收）；
  省略底分时取表内最低档。」

**旧费率键**（`currency.entryFeePercents`）：

- `buildEntryFeeEditor` 改为只读弃用卡片：标题「台费费率表（已弃用）」；正文
  「台费已并入『底分档位表』的第三列；本键仅保留兼容，服务端不再读取，保存会被拒绝。」
- 只读展示当前旧值（供手工回填参考）。
- 在 `buildStructCard` 里对该键 `saveBtn.disabled = true`，并注明「只读」。

**静态闸**（`scripts/verify-admin-static.mjs`）：用 `balancedBlock` 收窄断言；
⚠️ `balancedBlock` 默认括号是 `[`/`]`，函数块必须显式传 `'{', '}'`，否则会切到函数内第一个数组字面量：

- `balancedBlock(app, 'function buildLevelsEditor', '{', '}')` 块含 `entryFeePercent`，
  且 reset 行含 `addRow(item?.name, item?.baseScore, item?.entryFeePercent)`；
- `balancedBlock(app, 'function buildEntryFeeEditor', '{', '}')` 块含 `已弃用` / `只读`，
  且不含 `+ 添加费率`；
- `balancedBlock(app, 'function buildStructCard', '{', '}')` 块含 `currency.entryFeePercents`
  与 `saveBtn.disabled`。
- 键集合/计数断言不动。

### 4.6 conformance `slice-25-entry-fee.ts`

- 进入 A 组前**快照实际值**：`const levelsBefore = await adminGetConfigValue(admin, 'game.baseScoreLevels')`
  （现有 helper：完整 GET 后取 `config[key].value`；**没有**按 key 的 GET 路由）；
  校验它是非空数组且含 `baseScore === 15`，否则中止并报错（不改表）。
- **语义快照**（用于写回）：`levelsBefore.map(l => ({ ...l, entryFeePercent: l.entryFeePercent ?? 0 }))`
  —— 每条都显式带字段，避免触发 D13 的旧形态 400。
- `LEVELS_FEE_ON` = 语义快照，仅把 15 档改为 `entryFeePercent: 10`；其余保持快照值。
- `putConfigAndWaitEffect(admin, 'game.baseScoreLevels', LEVELS_FEE_ON, 'room-service')`。
- **两处断言**（不能二选一）：
  1. `adminGetConfigValue(admin, 'game.baseScoreLevels')` 读回归一化后含 15 档
     `entryFeePercent:10`（新的 levels canonicalizer，按 `{name,baseScore,entryFeePercent: ??0}` 重建；
     数组顺序保留，不受 MySQL JSON 对象键序影响）；
  2. `GET /api/config` 的 `entryFeePercents` 含 `{baseScore:15,percent:10}`，其余档为 0。
     ⚠️ `/api/config` 需要**玩家 token**；A 组此时还没有注册用户 ⇒ 把这条断言放到 B 组
     `registerUser` 之后、费率仍开启时（`humans[0]` 的 token）。
- 正常路径与 `finally` 都用**语义快照**写回（不要原样写 `levelsBefore`，否则触发 D13 400；
  不要硬编码种子）。`levelsForWrite` 在 try 外声明为 `null`；仅当非 null 时写回；
  正常路径恢复成功后置空，避免 `finally` 重复写/无谓 bump version。
- 恢复后再断一次玩家面：`GET /api/config` 的 `entryFeePercents` = **`levelsForWrite` 的派生值**
  （不假定全 0；测试服可能存在人工配置的非零费率）。
- 删除 `ENTRY_FEE_KEY` 常量；旧键写保护意味着任何残留写入都会 400，必须清干净。

### 4.7 客户端 / mock-server

- **客户端不动**：`ClientConfig.entryFeePercents` 形状不变，`lobby.vue` / `store` / `entryFeeOf` 原样。
- `tools/mock-server` 不改（它返回独立的 `entryFeePercents`，客户端契约不变）。

## 5. 错误处理与边界

| 情况 | 行为 |
|---|---|
| 档位项缺 `entryFeePercent` | 读侧派生 0；新 admin 保存时显式写 0 |
| `entryFeePercent` 非整数 / <0 / >50 | 写入口 400 |
| 提交的档位表**全部**缺 `entryFeePercent`（旧 admin 页面） | 写入口 **400**（提示硬刷新/显式给 0），不清零、不落库 |
| 仅部分条目缺 `entryFeePercent` | 缺的条目按 0；整表按提交值生效 |
| 旧键被写 | **400**（D14）；读/快照仍保留 |
| 档位表缺键/非数组/坏元素 | config 输出 `baseScoreLevels: []` + `entryFeePercents: []`；room 收费 `[]`；建房仍 10007 |
| 删除档位 | 费率随行消失；旧键孤儿行不再生效 |
| 新增档位 | 新 admin 显式 0%；API 写入也必须显式给 `entryFeePercent` |
| 非零旧费率环境 | 部署前硬检查；非零则先回填档位表（本片不写迁移） |

## 6. 测试判据

1. **protocol**：
   - `parseBaseScoreLevels` round-trip：带 `entryFeePercent:10` ⇒ `toStrictEqual` 保留字段；
     缺失 ⇒ 对象**不含**该自有属性；0/50 通过；-1/51/1.5/字符串/**null** ⇒ 抛；
   - `entryFeePercentsFromLevels`：缺省 0、显式 10、顺序保持、空表 ⇒ `[]`。
2. **config-service**：
   - `GET /api/config` 的 `entryFeePercents` 由档位表派生（15⇒10% ⇒ `{15,10}`）；
   - 旧键设为非零、档位表全 0 ⇒ 输出全 0（证明旧键不再被读）；
   - 档位表缺键/非数组/坏元素 ⇒ 两者都 `[]`（不 500）；
   - `PUT /api/admin/config/currency.entryFeePercents` ⇒ 400（D14）；
   - `PUT game.baseScoreLevels` **全部条目都缺** `entryFeePercent`（旧形态）⇒ **400**，且库未变；
     只要任一条目带字段（缺的条目 = 0）⇒ 200；
   - 经 `set()/HTTP PUT` 写入 `entryFeePercent:10` 后 GET 读回（不只测假库直塞）；
   - 既有 `config.validation.test.ts` 的档位夹具补 `entryFeePercent: 0`（保持其原验证目的）。
3. **room-service**：
   - `entryFeePercents()` 从档位表派生；**结果是与档位等长的全 0 行**（不是 `[]`）；
   - 档位表缺键/坏值 ⇒ `[]`（fail-open）；
   - 既有台费行为用例（`rooms.entry-fee.test.ts`）保持绿（收费块未改）。
4. **admin**：`pnpm verify:admin` 通过；D17 的块级断言成立；键数/计数不变。
5. **conformance**：slice-25 快照/改 15/恢复快照；GET levels 与 `/api/config` 两处断言；
   A/B/C 组收费/免单/指标原值不变。
6. **客户端**：全量测试零改动；`base-score-selection` 的「门票 N」用例仍绿。
7. **全量**：`turbo run test lint --force`；客户端 `pnpm -C apps/client build`；`pnpm verify:admin`。

## 7. 风险

| # | 风险 | 处置 |
|---|------|------|
| R1 | 非零旧费率环境在切换后丢失费率 | 部署前硬检查；非零先回填；admin 只读展示旧值 |
| R2 | 旧 admin 页面保存清零费率 | D13 直接 400 + 测试；旧页面会显示「请硬刷新」 |
| R3 | 旧键 API 写入无效但看似成功 | D14 直接 400 |
| R4 | conformance 污染测试服人工配置 | D11 快照/恢复实际值；缺 15 档则中止 |
| R5 | conformance 只断收费金额，漏 `/api/config` | D11 两处断言缺一不可 |
| R6 | 旧客户端不认新字段 | 只读不写；`/api/config` 形状不变 |
| R7 | 滚动窗口：旧 room-service 读旧键、新 config-service 派生输出 | 整栈同时部署；当前全 0；回滚会恢复读旧键（部署前保持旧键同步） |
| R8 | 旧键孤儿行未来复用数值时生效 | 旧键已只读且不再被读；阶段 2 删除 |

## 8. 涉及文件

**生产代码（6）**

- `packages/protocol/src/config.ts`
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/config/platform-config.service.ts`（D13/D14）
- `packages/room-service/src/config/config-cache.service.ts`
- `admin/app.js`
- `scripts/verify-admin-static.mjs`

**测试 / conformance（约 8）**

- `packages/protocol/src/config.test.ts`
- `packages/config-service/test/client-config.test.ts`
- `packages/config-service/test/admin.controller.test.ts`（旧键 400 / 过渡写保护）
- `packages/room-service/test/config-cache.test.ts`
- `packages/room-service/test/rooms.entry-fee.test.ts`（确认不回归）
- `apps/client/test/base-score-selection.test.ts`（确认零改动）
- `tools/conformance/src/slices/slice-25-entry-fee.ts`
- `scripts/verify-admin-static.mjs`

**文档（具体行号）**

- `docs/design.md:1233`（档位表键）、`:1266`（费率键标弃用）、`:1278`（room-service 消费面改写）
- `docs/ops/first-deploy.md:1037`（费率键改为档位表第三列）
- `docs/client-protocol.md:52`（`baseScoreLevels` 可选字段说明）
- `admin/app.js` 的 CONFIG_NOTES / STRUCT_META（用户可见文案）

**阶段 2 checklist（另立片）**

1. 删除 `CONFIG_KEYS` 的 `currency.entryFeePercents`（52→51）与 `CLIENT_CONFIG_KEYS` 仍保留派生输出；
2. 删除 `parseEntryFeePercents` 与写保护/过渡合并逻辑；
3. 删除 admin 弃用卡片、STRUCT_KEYS/IA/静态闸计数收口；
4. 数据清理：删除 `platform_config` 旧行（迁移）；
5. 更新所有键数快照测试与文档；
6. **保留** `/api/config` 的 `entryFeePercents` 派生输出（它不是内部键，客户端契约）。

## 9. 审查记录（r1，独立 reviewer）

| # | 级别 | 发现（已核对） | 处置 |
|---|------|----------------|------|
| F1 | 阻断 | `parseBaseScoreLevels` 只校验不回写 `entryFeePercent`，整片会静默退化为全 0 | D16 + §4.1 明确写回；round-trip `toStrictEqual` + config-service PUT 用例 |
| F2 | 高 | 已打开的旧 admin 页面保存会静默清空费率 | D13 过渡写保护（按 baseScore 保留）+ 测试 |
| F3 | 高 | config-service 对非数组/坏元素 `.map` 会 500，与 §5 矛盾 | D15 用 `parseConfigValue` 复核，坏值 ⇒ `[]` + 测试 |
| F4 | 高 | admin 静态断言 `app.includes('entryFeePercent')` 恒真 | D17 块级断言（编辑器/getter/reset/禁用保存） |
| F5 | 高 | conformance 硬编码种子恢复会覆盖测试服人工配置 | D11 快照实际值、仅改 15、恢复快照；缺 15 则中止 |
| F6 | 高 | conformance 的 `/api/config` 派生断言被写成「或」 | D11 两处断言缺一不可 |
| F7 | 低 | 旧键 API 仍可写且无提示 | D14 写入 400 |
| F8 | 低 | room 测试「旧键非零 ⇒ []/全 0」表述歧义 | §6.3 明确「与档位等长的全 0 行」；缺键/坏值才是 `[]` |
| F9 | 低 | admin reset 漏传第三列；函数名是 `buildStructCard` | D6/D7/§4.5 明确 reset 与 `buildStructCard` 禁用点 |
| F10 | 低 | 部署前检查/回滚未成硬闸 | D18 + §7 R1/R7 |
| F11 | 低 | 文档行号/阶段 2 checklist/方案对比缺失 | §2 方案对比、§8 行号与 checklist |
| F12 | 高（r2） | D11「原样恢复」与 D13「全缺字段按旧值合并」冲突：种子无字段，恢复会被当成旧形态，保留收费态 | **改 D13 为 400 拒绝旧形态**；D11 用语义快照（每条显式 `entryFeePercent ?? 0`）恢复，恢复后再断 `/api/config` 全 0 |
| F13 | 高（r2） | D13 合并实现牵动 UPDATE/INSERT/重试/审计四处，且会让 `config.validation.test.ts` 变红；`isObj` 在 config-service 不可用 | 同上改 400；`config.validation.test.ts` 夹具补 `entryFeePercent: 0`，另加旧形态 400 用例 |
| F14 | 高（r2） | conformance 断言接线不符：无按 key 的 GET 路由；A 组无玩家 token；canonicalizer 套 levels 会假红 | D11 改用 `adminGetConfigValue`；`/api/config` 断言放 B 组注册用户后；levels canonicalizer 显式 `entryFeePercent ?? 0` |
| F15 | 低（r2） | D16 需显式类型避免 TS2339；`null` 应按「存在但非法」拒绝；`balancedBlock` 函数块需显式 `{}`；D14 guard 应在 parse 之前 | §4.1/§4.3/§4.5/§6 已逐条写入 |
