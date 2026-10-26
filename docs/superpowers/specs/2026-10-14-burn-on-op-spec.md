# 结算销毁上账（op 级残差/抽水）—— 规格 v1.0

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-14 |
| 设计层 | `docs/superpowers/specs/2026-10-14-burn-on-op-design.md` **v1.1**（r1 评审处置后，`4c65f3f`）；r1 报告 = `.superpowers/sdd/2026-10-14-burn-on-op/review-design-r1.md`（工作区工件，不入库） |
| 用户裁决 | 2026-10-14「按标准 B 方案实施」→ 设计评审通过（「继续」）⇒ 本规格 |
| 本文定位 | 把设计 v1.1 展开为**可验证契约**：每条规则/决定都有判据编号（§4 表）落点；任务切分归计划层 |
| 上游真源 | `computeSettlement`（room-service）已算出 residue/rakeTotal——本片算法零改动 |

---

## 0. 承接（设计决定 → 判据）

| 设计决定 | 落点 | 判据 |
|---|---|---|
| D1 NULL=未记录 ≠ 0 | §2.1 / §2.4 | C5、C8、C13-2 |
| D2 `(source, created_at)` 索引 | §2.1 / §2.6 | C8、C12 |
| D3 不强制 burn 在场（兼容旧 outbox 条目） | §2.3 / §2.5 | C9-4、C13-2 |
| D4 指纹「有才出现」 | §2.3 | C4 |
| D5 apply 响应零变更 | §2.4 | C7 |
| D6 outbox 重发指标语义保持 | §2.5 | C10 |
| V1/V2/V3 校验 | §2.2 | C1–C3、C13-3/4 |
| 管理面读口 | §2.6 | C11、C12、C16 |

---

## 1. 改动面一览

**新增文件**

| 文件 | 内容 |
|---|---|
| `packages/currency-service/src/migrations/1792022400000-BurnOnOp.ts` | 两列 + 一索引（§2.1） |

**修改文件**

| 包 | 文件 | 动作 |
|---|---|---|
| protocol | `src/currency.ts` | `CurrencyBurn` 类型 + 请求字段 + 三条校验 + 指纹兼容 |
| protocol | `src/currency.test.ts` | 校验正反例、哈希新向量（**旧向量断言一字不改**） |
| currency-service | `src/apply/apply.service.ts` | `OPS_INSERT_SQL` 尾追两列 + 两个参数 |
| currency-service | `src/admin/finance-query.service.ts` | SELECT 基句 +2 列；`AdminOpsRow` +2；`SUMMARY_BURN_SQL` 常量；`SummaryResult.burn`（**controller 零改动**——整对象透传，S3） |
| currency-service | `test/*` | apply/迁移/finance/假库（§4 判据） |
| room-service | `src/currency/settle.service.ts` | 三处载荷 + 条目 +2 字段 + 重发分支 |
| room-service | `test/currency/settle-*.test.ts` | 载荷/条目/重发判据 |
| conformance | `src/slices/slice-17-currency.ts` | 列断言更新 + 新增销毁组（§5） |
| conformance | `src/slices/slice-18-gold-room.ts` | 真实结算 op 两列非 NULL |
| conformance | `baselines.json` | 计数更新 |
| admin | `app.js` + `index.html` | 汇总「销毁」行（宿主元素 `fin-burn-line` 落 index.html）+ op 详情显示 |

---

## 2. 逐层契约

### 2.1 迁移

- 文件/类名**钉死**：`1792022400000-BurnOnOp.ts` / 类 `BurnOnOp1792022400000`（不得叫 `Currency…`：`test/migration.test.ts:48-61` 以 `/^Currency\d+$/` 取 readdir 首个匹配——F9）。
- `up()` **恰一条** `queryRunner.query`（拼接字面量风格，照 `1789600000000-Currency.ts`）：

```sql
ALTER TABLE `currency_ops`
  ADD COLUMN `burned_residue` int NULL DEFAULT NULL,
  ADD COLUMN `burned_rake` int NULL DEFAULT NULL,
  ADD KEY `idx_ops_source_created` (`source`, `created_at`)
```

- `down()` 恰一条：`DROP KEY idx_ops_source_created, DROP COLUMN burned_rake, DROP COLUMN burned_residue`（先索引后列）。
- **部署次序由自动迁移天然满足**：currency-service `database.config.ts:34` `migrationsRun: true`（独立 `migrations_currency` 表）——容器启动先跑迁移再 ready；**无新增 .env、无手工步骤**。

### 2.2 协议（类型 + 校验）

```ts
/** 结算销毁（仅 game_settle）：截断残差 / 抽水，二者恒同在。 */
export interface CurrencyBurn {
  /** 截断残差（floor 分摊零头）；0 ≤ n ≤ 2^31−1。 */
  residue: number;
  /** 抽水；0 ≤ n ≤ 2^31−1。 */
  rake: number;
}
// CurrencyApplyRequest += burn?: CurrencyBurn;
```

> **2026-10-26 起**：`residue` 正常路径恒 0（零头改分给赢家），字段与 V3 不变量不变；
> 见 `docs/superpowers/specs/2026-10-26-settle-remainder-to-winners-design.md`。

`validateCurrencyApply` 新增三规则，**校验次序 = 形状 → 范围 → 来源 → 不变量**（前者先报）：

| # | 规则 | 文案（逐字，中文） |
|---|---|---|
| S | `burn` 在场 ⇒ 必须是对象且**同时含** `residue`/`rake`（`null` 视为非对象，拒） | `burn 必须是含 residue 与 rake 两个字段的对象` |
| V2 | 两者均为整数且 `0 ≤ n ≤ 2147483647` | 逐字段：`burn.residue 必须是 0 ≤ n ≤ 2147483647 的整数（收到 <原值 JSON>）`（`rake` 同式） |
| V1 | `burn` 在场 ⇒ `source === 'game_settle'` | `burn 仅 game_settle 来源可携带（收到 <source>）` |
| V3 | `Σentries.delta + residue + rake === 0` | `burn 与分录金额不符：Σentries(<Σ>) + residue(<r>) + rake(<k>) 必须为 0` |

- `burn` 外的多余键**不拒**（与既有校验姿态一致）、**不进指纹**；
- **「在场」谓词统一 = `burn !== undefined`**（S7；`null` 算在场 ⇒ 被 S 规则拒——与 §2.3 指纹谓词同式）；
- 违反 ⇒ `ProtocolError` ⇒ 既有路径 `{ok:false, code:10001}`（`apply.service.ts:219-227`，r1 已核验）。

### 2.3 指纹（`currencyApplyHash`）

- canonical 对象键序：`{ source, entries, actor, reason, refId }` **不变**；**当且仅当** `burn !== undefined` 时在**末位**追加 `burn: { residue, rake }`（子对象键序钉死 residue → rake）；
- **判据 C4 = 现有金标向量测试（`currency.test.ts` §逐字节组）原样通过、一字不改**；新增：「带 burn 向量」「`burn: undefined` ≡ 缺席」（同哈希）。

### 2.4 apply 写入

- `OPS_INSERT_SQL` 列清单一律**尾追**（只增列序）：

```
INSERT INTO `currency_ops` (`action_id`, `request_hash`, `source`, `actor`, `reason`, `ref_id`, `trace_id`, `burned_residue`, `burned_rake`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

- 参数尾追：`req.burn?.residue ?? null`、`req.burn?.rake ?? null`（**同事务、同语句**，不新增步骤）；
- 重放路径零改动（`OPS_SELECT_SQL` 只读 `id/request_hash`；重放**不改动**已存两列）；
- **响应零变更（D5）**：`CurrencyApplyData` 不加任何键。

### 2.5 room-service（`settle.service.ts`）

| 点 | 契约 |
|---|---|
| `applyGraded`（:444） | 签名 +`burn: {residue, rake}`；重试循环内**同载荷同指纹**原样重发 |
| 主路（:355） | `burn = {residue: computed.residue, rake: computed.rakeTotal}`——**恒带**（含 0/0） |
| `:r2`（:384） | 用**重算后**的 residue/rakeTotal（新 actionId） |
| `SettleOutboxEntry`（:112） | +`residue: number; rakeTotal: number`（新条目恒写实值） |
| 重发（:686） | **两字段都在**（`typeof === 'number'`）⇒ 带 burn 重发（与首发同指纹）；**任一缺失**（旧条目）⇒ **不带** burn 重发（旧指纹、可重放；该 op 两列 NULL） |
| 指标 | **不改**（D6）：outbox 重发路径不增 residue 指标；finalize 语义照旧 |

### 2.6 管理面

**a) ops 列表/详情**（`finance-query.service.ts`）

- `WALLET_OPS_SELECT_BASE`：在 `o.trace_id AS traceId,` 之后插入 `o.burned_residue AS burnedResidue, o.burned_rake AS burnedRake,`（op 字段聚簇，行序：…traceId → burnedResidue → burnedRake → ownerId…）；
- `AdminOpsRow` += `burnedResidue: number | null; burnedRake: number | null;`；
- 映射：`null ⇒ null`；非空值**必须是安全整数，否则抛**（响亮，不静默）。新增 helper `toNullableSafeInt`；
- `flows.csv` / `ops.csv` 列清单**不变**。

**b) summary burn 块**（同文件 + `admin-finance.controller.ts`）

新常量（逐字；`source` 为字面量，与既有 summary 常量风格一致）：

```sql
SELECT COALESCE(SUM(burned_residue),0) AS residue, COALESCE(SUM(burned_rake),0) AS rake, COUNT(*) - COUNT(burned_residue) AS unrecordedOps FROM currency_ops WHERE source = 'game_settle' AND created_at >= ? AND created_at < ?
```

- 参数 = `[new Date(from), new Date(to)]`（**与既有 summary 同窗口**；窗口口径 = `ops.created_at`，毫秒级边界差异不承诺跨表一致——F5）；
- 回值：`residue`/`rake` 经 `toNumberValue`（SUM ⇒ DECIMAL 字符串）；`unrecordedOps` 经 `toNumberValue`；零行窗口 ⇒ `0/0/0`（COALESCE + COUNT 语义）；
- `SummaryResult` += `burn: { residue: number; rake: number; unrecordedOps: number }`；HTTP `data` 形状 = `{ rows, totals, burn }`（**追加**，既有键不动）；
- **实现落点（S2/S3）**：`finance.summary()` 内**先**执行既有 group 查询、**后**执行 burn 查询（**次序钉死**——`admin-finance.test.ts:819-845` 的 `db.queries.at(-1)` 锚随更新）；controller **零改动**（`admin-finance.controller.ts:383-386` 整对象透传 ⇒ HTTP 形状自动到位）；`summary.csv` 将多跑一条 burn 查询（输出不变、无害，登记）；
- `summary.csv` **列清单不变**。

**c) 管理页（`admin/app.js`）**

- 汇总面板新增一行（元素 id `fin-burn-line`）：`销毁：残差 {residue} · 抽水 {rake}`；`unrecordedOps > 0` 时追加 `（含 {unrecordedOps} 条历史未记录）`；
- op 详情：`source==='game_settle'` 且两字段非 null 时显示 `销毁：残差 {x} · 抽水 {y}`；
- 流水表格**不加列**。

---

## 3. 部署与回滚

- **无新增 .env / 无手工步骤**；迁移随容器启动自动执行（§2.1）；
- **双向兼容**：旧代码 + 新列 ⇒ INSERT 不含新列（写 NULL）、忽略未知迁移行（TypeORM 只跑配置列表中的 pending）⇒ 直接回滚安全；
- outbox 回滚窗口两分支登记见设计 §2.6（① 14002 终态；② 两列 NULL 新 op）。

---

## 4. 判据表

| # | 判据 | 载体 |
|---|---|---|
| C1 | V1：`signup_grant` + burn ⇒ 拒（文案逐字） | protocol 单测 |
| C2 | S/V2 边界：非对象 / 缺字段 / `0`✓ / `2147483647`✓ / `-1`✗ / `2147483648`✗ / `1.5`✗ / `'1'`✗ / `NaN`✗（文案逐字） | protocol 单测 |
| C3 | V3：正例（示例 `(−25+12+12)+1+0=0`）✓；改 residue 即拒（文案含 Σ/r/k 三值） | protocol 单测 |
| C4 | 哈希：**旧金标向量原样通过**；带 burn 新向量；`undefined ≡ 缺席`；burn 缺席 canonical 串逐字节 = v1.0 前形态 | protocol 单测 |
| C5 | INSERT：两列三态（NULL / 0 / 实值）落库值正确、参数序正确 | currency-service 单测（假库） |
| C6 | 重放：同 actionId 二次 apply ⇒ `replayed:true` 且两列**不变** | currency-service 单测 |
| C7 | D5 负判据：`CurrencyApplyData` 无 `burn` 键（响应形状全等既有） | currency-service 单测 |
| C8 | 迁移：up 恰一条逐字 SQL / down 逐字 / 类名 `BurnOnOp1792022400000`；`migrations_currency` 断言更新为两行 | 迁移单测 + slice-17 |
| C9 | room-service 三处载荷（主路/`:r2`/outbox 新条目）burn 值 = `computeSettlement` 输出；**旧条目重发不带 burn**；**新条目重发带 burn 且重放成功** | room-service 单测 |
| C10 | D6：outbox 重发路径不增 residue 指标；主路计一次 | room-service 单测 |
| C11 | ops 列表/详情 DTO 两字段（NULL 透传；非空非整数 ⇒ 抛） | currency-service 单测 |
| C12 | summary `burn` 块：合计与 `unrecordedOps` 正确、零行窗口 `0/0/0`、窗口过滤生效；**既有精确断言集同步**：`admin-finance.test.ts` 的 ops/summary `toEqual`（:457-518、:700-717、:766-817、:819-845 含 `db.queries` 锚）与 `FakeFinanceDb`（:46-64、:194-201、:286-310）扩 burn | currency-service 单测 |
| C13 | **真栈**（slice-17 新组）：① 直投带 burn ⇒ 两列 + summary 增量 = 投递值（窗口 `[0, now)` 前后两读）；② 直投不带 burn ⇒ NULL 且 `unrecordedOps` +1；③ V3 反例 ⇒ 10001、该 actionId 库零行；④ V1 反例 ⇒ 10001；⑤ 1970 `[1, 2)` 空窗 ⇒ `0/0/0`（slice-19:1294-1298 先例） | conformance |
| C14 | **真栈**（slice-18）：真实金币局（**E/F 组**，`slice-18-gold-room.ts:1175/:1270`——非 C 组）后其 settle op 两列**非 NULL**（新代码恒带） | conformance |
| C15 | slice-17 C2 三表逐列断言更新（currency_ops 尾追两列）+ **新索引 `idx_ops_source_created` 纳入 information_schema 断言（:653-672 同族）** | conformance |
| C16 | 管理页：汇总「销毁」行渲染（含 `unrecordedOps>0` 徽标）/ 详情显示；`verify-admin-static.mjs` **增包含式针脚（`fin-burn-line`）**（该闸为零渲染判据的针脚包含式——加针脚换下限） | 静态闸 + 人工核对 |

---

## 5. conformance 登记（slice-17）

- **更新点**：C2 三表逐列（`currency_ops` 尾追 `burned_residue`/`burned_rake`）+ 新索引 `idx_ops_source_created` 纳入 information_schema 断言（:653-672 同族，S8）；`migrations_currency` 恰一行断言（:674-679）⇒ 两行；
- **单测侧同轮必改（S2/S6 补全）**：`admin-finance.test.ts` 的 ops/summary 精确断言与 `FakeFinanceDb` 独立 SQL 副本（:46-64/:194-201/:286-310）；`fake-currency-db.ts` 的 `SQL.opsInsert` 正则（:71-72，钉死 7 列 ⇒ **9 列**，不改则全部 apply 测试当场红）、`FakeOpRow`（:32-41）与 `run()` 分支（:331-348）须存 `params[7]/[8]`（`SUMMARY_BURN_SQL` **不进**此假库——归 admin-finance 的 fake）；
- **新增组「销毁上账」**（C13 五判定）：注入 actionId 走既有 `AID()` helper（**运行期唯一**——`:112-118` 的 RUN_TAG 纪律，**不得**用固定字面量，避免二跑「replayed 假红」）；owner = `s17burn-a`/`s17burn-b`（登记 `harnessOwners`，由既有 owner 清理覆盖）；ops 行清理/断言谓词随 AID 产物形态对齐既有 `s17-%` 先例，字面量计划层钉（S5）；
- **窗口（S4）**：①② 用显式 `[0, now)` 窗口前后两读取增量；⑤ 用 1970 `[1, 2)` 空窗断言 `0/0/0`（slice-19:1294-1298 先例）；
- **slice-18**：真实金币局（**E/F 组**，:1175/:1270）后判其 settle op 两列非 NULL；
- **baselines.json**：slice-17 / slice-18 计数同轮更新（`scripts/check-baselines.mjs` 核对）。

---

## 6. 明确不做

= 设计 §0.3 与 §6 逐条（销毁账户/全服守恒 ❌、流水表 ❌、抽水指标 ❌、apply 响应 ❌、强制在场 ❌；遗留：拆分调用方自证、回滚窗口两分支、运行时静默面 F11、**冲正面结构性不可达**（`admin_reverse` 仅 `admin_adjust` 来源，`admin-finance.controller.ts:428`）、**outbox 重发分项指标不计**（= C10））。

---

## 7. 修订记录

- **v1.0**（2026-10-14）：初稿（设计 v1.1 展开；判据 C1–C16）。
- **v1.1**（2026-10-14）：评审 S1–S10 处置（零阻断）——slice-18 锚点改 E/F 组（S1）、admin-finance 必改断言集与查询次序钉死（S2）、controller 改零改动 + csv 多跑查询登记（S3）、真栈窗口钉死（S4）、注入 id 走 AID/RUN_TAG 纪律（S5）、假库点位点名（S6）、「在场」谓词统一（S7）、索引纳入信息模式断言（S8）、index.html 入改动面 + 静态闸针脚（S9）、§6 补两则（S10）。
- **v1.2**（2026-10-14）：终审处置（Minor #7）——§2.2 散文次序补「范围」一词（表格行序 S/V2/V1/V3 本就吻合；与计划 v1.2 及实现/测试对齐）。
