# 结算销毁上账（op 级残差/抽水）—— 设计 v1.0

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-14 |
| 状态 | r1 评审已处置（零阻断）· 待用户评审；评审报告 = `.superpowers/sdd/2026-10-14-burn-on-op/review-design-r1.md`（工作区工件，不入库） |
| 用户裁决 | 「按标准 B 方案实施」——把每局销毁（截断残差/抽水）**记在 `currency_ops` 行上** |
| 前序讨论 | 2026-10-14：A（不加账）/B（记在 op）/C（系统账户）三方案对比 ⇒ 选 B；B′（只记总额）因失去残差/抽水拆分被否 |
| 上游真源 | `computeSettlement`（room-service）**已算出** residue/rakeTotal——本片只做「持久化 + 写时校验 + 读面」，算法零改动 |

---

## 0. 背景与目标

### 0.1 现状（三类事实）

1. **销毁是 op 内的隐形差额**：一局结算 = 一条 `game_settle` op，`Σentries.delta = −(residue + rake)`（推导在 `packages/room-service/src/currency/settle.service.ts:192-210`；接口语义 `:133-144`）。销毁没有流水行、没有账户。
2. **唯一痕迹是易失的**：room-service **仅在销毁 > 0 时**留一行日志（`residue= rake= (destroyed — cross-check via currency_flows)`，同文件 :573-577）+ `currency_settle_residue_total` 指标（**只含残差、不含抽水**，`packages/room-service/src/metrics/room.metrics.ts:143`）。日志非永久账；抽水无指标。
3. **事后可推但不可拆**：对 `currency_flows` 逐 op 求和能得「残差+抽水」合计，**分不开**；且流水**永不清洗**（`1789600000000-Currency.ts` 表头纪律），随时间线性变慢。

### 0.2 目标与成功判据

- 每局结算的销毁**构成**（残差 / 抽水，分列）**永久、逐局可查**；
- 写入时**强制 op 自洽**：`Σentries + residue + rake = 0`；
- 管理面可按时间窗查销毁合计，查询成本与历史总量脱钩；
- 玩家侧、`currency_flows` 表、结算算法、幂等/重放语义**零变化**。

### 0.3 明确不做（本片边界）

- ❌ 不加销毁账户 / 不做全服守恒不变量（C 方案性质，将来若做「银行」时对手分录会自动成账）；
- ❌ 不动 `currency_flows`（表结构、索引、CSV 导出列均不变）；
- ❌ 不改 `computeSettlement` 及其指标语义（residue 指标行为照旧；**不加**抽水指标——op 数据已覆盖报表用途）；
- ❌ apply **响应**不加 burn 字段（响应契约零波纹，所有调用方无感知）；
- ❌ 不为 `game_settle` 强制 burn 在场（见 §2.3-D3 的兼容论证）。

---

## 1. 总览

```
computeSettlement（真源，零改动）
   │  residue / rakeTotal
   ▼
settle.service.apply 载荷尾部捎带：burn: { residue, rake }
   ▼
protocol：类型 + 校验（唯一校验点）+ 指纹（缺席即省略 ⇒ 向后兼容）
   ▼
currency-service apply：同事务 INSERT currency_ops（+2 列）
   ▼
读面：ops 列表/详情 DTO + summary 的 burn 块 + 管理页
```

canonical 例（地主 −25 / 两农民各 +12 / 残差 1 / 抽水 0）：

```
currency_ops:  source=game_settle, burned_residue=1, burned_rake=0
currency_flows: −25 / +12 / +12                ← 原样不动
不变量:        (−25+12+12) + 1 + 0 = 0 ✓
```

---

## 2. 逐层设计

### 2.1 迁移（schema）

新迁移（currency-service 第二个迁移，时间戳 > `1789600000000`）。**类名钉死 `BurnOnOp<ts>`**——不得命名 `Currency<ts>`：`test/migration.test.ts:48-61` 以 `/^Currency\d+$/` 取 readdir 首个匹配，新类若叫 `Currency…` 会在 Linux CI 上按目录序随机抢位（F9）。文件名 `<ts>-BurnOnOp.ts`；SQL 照 `1789600000000-Currency.ts` 的逐字惯例：

```sql
ALTER TABLE `currency_ops`
  ADD COLUMN `burned_residue` int NULL DEFAULT NULL,
  ADD COLUMN `burned_rake` int NULL DEFAULT NULL,
  ADD KEY `idx_ops_source_created` (`source`, `created_at`);
```

- **D1 · NULL 语义**：`NULL = 未记录`（历史行 + 部署窗口内的旧格式载荷）；`0 = 结算过且无销毁`。两态必须可区分（「不伪造读数」纪律）⇒ **不用 `NOT NULL DEFAULT 0`**。
- **D2 · 索引**：`(source, created_at)` 服务 §2.7 的窗口合计查询；结算 op 行数 = 结算流水行数 ÷ 3（一局一行 op、约三行流水），写入每局仅一行，索引代价可忽略。
- `down()`：删两列 + 删索引。

### 2.2 载荷与类型（protocol）

```ts
export interface CurrencyBurn {
  residue: number;   // ≥ 0 整数；截断残差（floor 分摊零头）
  rake: number;      // ≥ 0 整数；抽水
}
export interface CurrencyApplyRequest {
  // …既有字段不动…
  /** 仅 game_settle 可携带；本片唯一生产者 = room-service 结算（residue/rakeTotal 原样）。 */
  burn?: CurrencyBurn;
}
```

生产者纪律：**每次结算都带**（含 `{residue:0, rake:0}`）——使「新 op 必有两列真值」成立；缺席只发生在部署窗口（§2.6）。

### 2.3 校验（唯一校验点 = `validateCurrencyApply`）

新增规则（违反 ⇒ `ProtocolError` 中文原因 ⇒ 既有路径翻 **10001** 确定性回滚）：

| # | 规则 |
|---|---|
| V1 | `burn` 在场 ⇒ `source === 'game_settle'`，否则拒 |
| V2 | `residue` / `rake` 均为整数且 **`0 ≤ n ≤ 2^31−1`**（int 列容量哨兵，F1：无上限时越界值落 MySQL 1264 ⇒ apply 抛 ⇒ 翻 10007 ⇒ 重试/outbox 链——正是 delta 容量哨兵纪律要禁止的形态） |
| V3 | **不变量**：`Σentries.delta + residue + rake === 0`，否则拒（金额不符 = 调用方 bug，写入时抓） |

- **D3 · 不强制在场**：`game_settle` 不要求 burn 必带。理由：部署切换期，`settle:outbox` 中**旧格式条目**（TTL ≤1h）会原样重发——强制在场会把它们打成 10001 终态（钱未动但结算丢失）。「新代码必须带」由 room-service 侧测试纪律保证（§5-3），不由协议强制。
- **拆分本身不可服务端验证**：残差/抽水各是多少需要每座原始分差（apply 无此输入）⇒ 拆分是**调用方自证**（登记于 §6）。apply 能验的恰是「两者之和 = 分录缺口」。

### 2.4 指纹（`currencyApplyHash`）兼容（D4）

现有规范化对象键序固定 `{source, entries, actor, reason, refId}`、缺席者 `?? null`（`packages/protocol/src/currency.ts:238-256`）。**新键的纪律 =「有才出现」**：

- `burn` 缺席（`undefined`）⇒ `JSON.stringify` 省略该键 ⇒ canonical 串与**今天逐字节相同** ⇒ 历史 op 的存储指纹在重放/重发时仍匹配（`apply.service.ts` 重放判定依赖 `request_hash` 全等）；
- `burn` 在场 ⇒ canonical **末位**追加 `burn: {residue, rake}`（子对象键序固定 residue → rake，二者必须同在）。

**验收锁**：现有金标向量测试（`packages/protocol/src/currency.test.ts` §「逐字节」组）**原样通过、一字不改**——这就是兼容性的判据；另加新向量。

### 2.5 apply 写入与重放

- `OPS_INSERT_SQL`（`apply.service.ts:60`）列清单 +2：`burned_residue, burned_rake`；值 = `burn?.residue ?? null` / `burn?.rake ?? null`——**同一事务、同一语句**（不新增步骤、不新增语句）；
- **重放路径零改动**：`OPS_SELECT_SQL` 只读 `id/request_hash`；重放响应由 flows 重建（不含 burn）；重放**不改动**已存两列；
- **响应契约不变（D5）**：`CurrencyApplyData` 不加字段——所有调用方零感知。

### 2.6 调用侧（room-service，全部在 `settle.service.ts`）

| 点 | 改动 |
|---|---|
| `applyGraded`（:444） | 签名 +`burn`；重试循环**同载荷同指纹**（含 burn）原样重发 |
| in-process 主路（:355） | 传 `{residue: computed.residue, rake: computed.rakeTotal}` |
| `:r2` 重算轮（:384） | 传**重算后**的 residue/rakeTotal（新 actionId，无兼容问题） |
| `SettleOutboxEntry`（:112） | +2 字段 `residue: number; rakeTotal: number`（新条目写实值） |
| outbox 重发（:686） | 条目**含**字段 ⇒ 带 burn 重发（指纹与原发一致，可正常重放）；**旧条目**（无字段）⇒ **不带** burn 重发（旧指纹，正常重放；该 op 两列 NULL） |

- **D6 · 指标语义保持**：outbox 重发路径的 `finalize` 仍不计 residue 指标（现状保持；条目新字段只服务 apply 载荷）。翻案需单独理由。
- **回滚窗口登记（两分支，F4）**：新代码写的条目被**回滚后的旧代码**重发——① 原 op 已落库 ⇒ 指纹不一致 ⇒ 14002 终态（钱已在、仅报冲突）；② 原 op 未落库 ⇒ 旧代码不带 burn 重发**成功**，产出一条两列 NULL 的新 op（如实呈现，`unrecordedOps` 可见）。窗口 = 回滚部署 + outbox TTL(1h)，两分支皆接受。

### 2.7 读面（管理面）

- **ops 列表/详情**（`WALLET_OPS_SELECT_BASE`，`finance-query.service.ts:36`）：+`o.burned_residue AS burnedResidue, o.burned_rake AS burnedRake`；`AdminOpsRow` +2 可空字段（`number | null`）。**`flows.csv` / `ops.csv` 列清单不变**（CSV 是流水导出；销毁属 op 级，避免逐行重复）。
- **summary**（`GET /api/admin/wallet/summary`，`admin-finance.controller.ts:378`）：响应**追加** `burn` 块（窗口内 `source='game_settle'`）：

```sql
SELECT COALESCE(SUM(burned_residue),0)    AS residue,
       COALESCE(SUM(burned_rake),0)       AS rake,
       COUNT(*) - COUNT(burned_residue)   AS unrecordedOps
FROM currency_ops
WHERE source='game_settle' AND created_at >= ? AND created_at < ?;
```

  - `unrecordedOps` = 窗口内两列 NULL 的条数（历史行如实呈现；UI 在 >0 时标「含 N 条历史未记录」）；
  - 窗口口径 = `ops.created_at`；与同事务 flows 的 `f.created_at` 是**相邻语句级时间戳**（可毫秒级错开——两套汇总独立计数，窗口边界不承诺跨表逐毫秒一致，F5）；走 `idx_ops_source_created`；
  - **`summary.csv` 不变**（CSV 列清单是既有契约）。
- **管理页**（`admin/app.js` 财务视图）：汇总面板加一行「销毁：残差 X · 抽水 Y」；op 详情展开显示两字段（非空时）。**列表表格不加列**（避免普通行的噪声）。

### 2.8 部署与回滚

- **迁移先行**：新列不存在时新代码 INSERT 会报错；旧代码 + 新列 ⇒ 忽略并写 NULL——**安全顺序 = 先迁移、后升服务**（照既有流程）。
- **回滚**：旧代码不认新列/新载荷键 ⇒ 正常；outbox 回滚窗口见 §2.6。

---

## 3. 不变量与语义表

| source | burn 在场 | 校验 | ops 两列 | 说明 |
|---|---|---|---|---|
| `game_settle` | 是（新代码，恒带） | V1+V2+V3 | 实值（可为 0） | 唯一生产者 = room-service |
| `game_settle` | 否（旧 outbox 条目） | 跳过 | **NULL** | 部署窗口；如实呈现 |
| 其余全部 | 否 | — | NULL | 无销毁语义 |
| 其余全部 | 是 | **拒 10001** | — | V1 |

---

## 4. 影响面清单（文件级）

| 包 | 文件 | 动作 |
|---|---|---|
| protocol | `src/currency.ts` | 类型 `CurrencyBurn` + `validateCurrencyApply` 三规则 + `currencyApplyHash` 兼容 |
| protocol | `src/currency.test.ts` | V1/V2/V3 正反例；哈希新向量（**旧向量断言一字不改**） |
| currency-service | `src/migrations/<ts>-BurnOnOp.ts`（新） | 两列 + 索引；`test/migration.test.ts` 逐字断言 |
| currency-service | `src/apply/apply.service.ts` | `OPS_INSERT_SQL` 列 +2 |
| currency-service | `src/admin/finance-query.service.ts` | SELECT 基句 +2 列；`AdminOpsRow` +2；新增 `SUMMARY_BURN_SQL` |
| currency-service | `src/admin/admin-finance.controller.ts` | summary 响应装配 `burn` 块 |
| currency-service | `test/*` | apply 三态（NULL/0/实值）、重放不动列、finance 响应形状、假库 helper 列集 |
| room-service | `src/currency/settle.service.ts` | 两调用点 + 条目 +2 字段 + 重发分支 |
| room-service | `test/currency/settle-*.test.ts` | 三处载荷断言（含 burn 值 = computeSettlement 输出）；旧条目重发不带 burn |
| conformance | `src/slices/slice-17-currency.ts` | 三表逐列断言更新；summary/ops 形状断言同步；新增 burn 真栈判据 |
| conformance | `src/slices/slice-18-gold-room.ts` | 核对结算相关逐字断言 |
| admin | `app.js` | 汇总「销毁」行 + op 详情显示 |

**必红断言族（预先登记）**：① 三表逐列完整串（slice-17 C2）+ **`migrations_currency` 恰一行断言**（slice-17:674-679——第二条迁移落地即红，须同步，F2）；② summary / ops 的**精确**断言 = `admin-finance.test.ts:766-817`（含 :780/:800 的 `db.queries` 查询列表全等——summary 新增 burn 查询即红，F3；slice-19 的财务断言为逐字段形态，不受影响）；③ apply 载荷逐字断言（settle 测试族）；④ 假库 helper 的列集/查询识别。

---

## 5. 验收判据（分层）

1. **protocol 单测**：V1/V2/V3 正反例（中文原因）；哈希 = 旧金标向量逐字节不变 + burn 新向量 + 「缺席 == 显式 undefined」；
2. **currency-service 单测**：INSERT 两列三态（NULL / 0 / 实值）；重放不改列；迁移逐字；summary `burn` 块（含 `unrecordedOps`）；**D5 负判据**（`CurrencyApplyData` 无 `burn` 键，响应形状与既有全等）；假库；
3. **room-service 单测**：主路 / `:r2` / outbox 新条目三处载荷含 burn 且值 = `computeSettlement` 输出；旧条目重发不带 burn 且可重放；**新条目重发带 burn 且与首发同指纹（重放成功）**；**D6 判据**（outbox 重发路径不增 residue 指标）；
4. **真栈 conformance**：RPC 直投带 burn 的 `game_settle` op（先例 = slice-17 ⑦ 组以 RPC 直投造流水）⇒ 两列可见；V3 改数即拒（10001）；summary `burn` 块命中；窗口外不串窗；
5. **管理面**：静态闸 + admin 页文案核对。

---

## 6. 明确不做与遗留登记

- 拆分的正确性**不可**服务端验证（调用方自证）——登记；
- outbox 重发路径的分项指标不计（D6）；
- 回滚窗口 14002 / 两列 NULL 两分支（§2.6）——接受；
- **冲正面结构性不存在**：`admin_reverse` 仅允许 `admin_adjust` 来源（`admin-finance.controller.ts:428`）⇒ game_settle op 不可冲正，burn 无需与冲正交互（r1 核验）；
- **运行时静默面**：room-service 若未来停发 burn（回归），仅 summary 的 `unrecordedOps` 徽标可见；「新代码必带」当前由测试层钉住（§5-3），专用告警留待需要时另立（F11）；
- 全服守恒 / 销毁账户（C 方案）留待将来（若做银行，burn 会作为银行对手分录自动成账，room-service 零改动）。

---

## 7. 修订记录

- **v1.0**（2026-10-14）：初稿（用户裁决「按标准 B 方案实施」）。
- **v1.1**（2026-10-14）：r1 评审处置（F1–F11，零阻断）：V2 补 int 容量哨兵（F1）、迁移类名钉死 `BurnOnOp<ts>`（F9）、回滚窗口补第二分支（F4）、窗口口径表述订正（F5）、条件日志/锚点订正（F6/F7）、必红族修正与补登记（F2/F3）、§5 补 D5/D6 判据（F8）、预登记冲正面与静默面（F11）、决策编号补 D4（F10）。
