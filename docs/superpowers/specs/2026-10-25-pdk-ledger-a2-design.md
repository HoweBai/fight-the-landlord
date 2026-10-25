# 金币账本玩法维度 + 管理端玩家统计纳入跑得快 + PDK 金币场 conformance 设计（A2/A3 片）

> 日期：2026-10-25 · 状态：两轮设计对抗审查已闭合（可进入实现计划） · 流程：`docs/dev-process.md`
> 前置：A1 异常监控已完成并推送 `origin/feature/pdk-observability-a1`，**未合 dev**。
> 本片分支 `feature/pdk-ledger-a2-a3` **从 `feature/pdk-observability-a1` 开出**；独立 worktree
> `D:\Code\ftl-pdk-ledger-a2`。不修改 `apps/client/src/components/PdkSettlement.vue`（用户未提交改动），
> 不修改 `slice-29`（2/4 人会话正在使用）。

## 1. 背景与问题

PDK 主链路已落地，A1 补了异常监控；**资金账本与管理统计仍只有斗地主维度**。逐文件核实的缺口：

### 1.1 A2（账本玩法维度）

1. `currency_ops` / `currency_flows` 无 `game_type`：
   `packages/currency-service/src/migrations/1789600000000-Currency.ts:43-71`；
   `CurrencyApplyRequest` 无 `gameType`：`packages/protocol/src/currency.ts:61-75`。
2. 台费免单表无玩法列：`packages/currency-service/src/migrations/1792108800000-EntryFeeSkips.ts`。
3. 管理财务查询只按 `source` / `day`，流水列表无玩法列：
   `packages/currency-service/src/admin/finance-query.service.ts:53-70,106-114`；
   `admin/app.js:2674-2688`；`admin/index.html:438-456`。
4. PDK 记录表无 `game_type`，玩家行无 `score_change` / `won`，缺 `(user_id, ended_at)` 复合索引：
   `packages/user-service/src/migrations/1796300000000-PdkRecords.ts:22-64`
   （对比 DDZ：`packages/user-service/src/migrations/1789400000000-GameRecords.ts:47-67`）。
5. PDK 金币场 conformance 空白：`slice-18` / `slice-25` 全是 DDZ；`slice-29` 只跑 random 3 人。

### 1.2 A3（管理端玩家统计纳入 PDK）

1. 玩家列表 `games` / `wins` / `lastActive` 只查 `game_record_players`：
   `packages/user-service/src/players/admin-players.service.ts:100-115,275-312,340-391`。
2. 玩家详情“最近对局”只查 DDZ，返回无 `gameType`：
   `admin-players.service.ts:168-201`；`admin/app.js:5475-5480`。
3. 详情文案写“两玩法合计”（`admin/app.js:5464`）而列表行回落值只含 DDZ —— 同一页面两个口径。
4. 玩家列表/最近对局测试无 PDK：`packages/user-service/test/admin-players.test.ts`。
5. 管理端没有对局记录浏览/筛选页（本轮**不做**，见 §3）。

## 2. 范围

### 2.1 做

- **A2-1 货币协议**：`CurrencyApplyRequest.gameType?`、`CurrencyEntryFeeSkipRequest.gameType?`；
  校验；`request_hash` **保持不含 gameType**（旧指纹逐字节不变）。
- **A2-2 货币迁移**：`currency_ops.game_type` + 索引 + 历史回填；`currency_entry_fee_skips.game_type`。
- **A2-3 写点接线**：`game_settle` / `entry_fee` / `entry_fee_skip` / `robot_pool` 带玩法；
  `card_counter` 保持缺省（能力仅斗地主）。
- **A2-4 管理财务**：流水玩法列 + 玩法筛选；汇总按 `source/game_type`、`day/game_type`；
  burn / 漏收块保留既有总数（去重语义不变）并新增按玩法明细；CSV 增列；管理页筛选与列。
- **A2-5 PDK 记录**：`game_records_pdk.game_type`；玩家行 `score_change` / `won`；
  `(user_id, ended_at)` 复合索引；写入与历史回填；记录 DTO 改读新列（出站形状不变）。
- **A3**：玩家列表/汇总的 `lastActive`、`games`、`wins` 纳入 PDK；最近对局两玩法合并并返回 `gameType`；
  管理页最近对局加“玩法”列；DOM 探针同步。
- **A2-6 conformance**：新增 `slice-31-pdk-gold` 真栈片；同步 `slice-17`（新迁移行/列）、
  `slice-25`（汇总按玩法求和 + 免单 game_type）、`baselines.json`；**不修改 `slice-29`**。
- 单测、迁移形状测试、管理端静态闸、ops 文档同步。

### 2.2 不做（YAGNI / 边界）

- **不做**管理端“对局记录浏览/筛选页”（用户 2026-10-25 裁决，另立 P1）。
- **不做** B 组（按 `playerCount` 拆胜率、机器人样本剔除、2/4 风控 conformance、14003 对齐）。
- **不做** C 组（`record.write` outbox/对账、反洗钱）。
- 不新增 `currency_flows.game_type`（见 D2）。
- 不把 `currency_ops` 改成统一多玩法窄表；不改货币余额算法、结算公式、对局规则。
- 不改协议**出站**形状：`CurrencyApplyData` / `SettlementResult` / `PdkRecord` 不变。
- 不给 PDK 记录加数据库 VIEW；不把 PDK 表与 DDZ 表合并。
- 不改造 `match_queue_length`、监控指标、告警（A1 范围）。
- 不改 `slice-29`；不动 2/4 人玩法文件。
- 不改 `apps/client/src/components/PdkSettlement.vue`。

## 3. 产品裁决（2026-10-25 用户确认）

| 问题 | 裁决 | 影响 |
|---|---|---|
| 管理端对局记录浏览是否纳入本轮 | **不纳入**，本轮只做玩家统计；另立 P1 | 不新增记录浏览端点/页面，不新增记录表 UNION 读口 |
| PDK 记录表玩法维度 | **加 `game_type` 列**（不是 UNION 合成/VIEW） | 新增迁移与写入；`game_records_pdk.game_type` 默认 `paodekuai` |
| 财务汇总默认维度 | **`source/game_type/day`** | `groupBy=source` 行按 `(source, game_type)` 展开；`groupBy=day` 行按 `(day, game_type)` 展开；保留 `k` 字段并新增 `gameType` |

## 4. 方案对比

### 4.1 货币账本玩法维度

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | `currency_ops.game_type` 单列；`currency_flows` 经 `op_id` JOIN 继承 | 一次 apply 一个玩法，无冗余；所有读口本来就 JOIN ops；迁移只动一表 | 纯 flow 级查询（不 JOIN）拿不到玩法 |
| B | ops 与 flows 各加一列 | flow 级直查快 | 双写漂移风险；迁移/回填双份；现有查询全部 JOIN ops，收益为零 |
| C | 新建 `currency_game_ops` 子表 | 玩法维度强隔离 | 多一张表与 JOIN；YAGNI |

推荐 A。`currency_flows` 的玩法维度由 `finance-query` 的既有 `JOIN currency_ops` 提供，不重复存储。

### 4.2 PDK 记录玩法维度

用户选择“加 `game_type` 列”。补充两条被否方案：

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（用户选定）** | `game_records_pdk.game_type NOT NULL DEFAULT 'paodekuai'` | 直观、写入简单；冗余但可接受 |
| B | 不加列；统一读口 `SELECT 'paodekuai' AS game_type ... UNION` | 迁移最小；但用户要求落列 |
| C | 建只读 VIEW | 多 schema 对象；权限/回滚面更大 |

### 4.3 管理端玩家统计纳入 PDK

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 在 `admin-players.service` 的 SQL 中增加 PDK 子查询 | 分页/排序/筛选仍在 SQL 层，语义与 DDZ 一致 | SQL 变长；需要复合索引 |
| B | 分别查两表后在 JS 合并再分页 | 代码简单 | `lastActive` 排序/活跃筛选必须在 SQL 层，否则分页错 |
| C | 统计任务预聚合表 | 读快 | 新表/新任务/一致性窗口；YAGNI |

推荐 A；PDK 玩家行补 `(user_id, ended_at)` 索引。

### 4.4 财务汇总维度

用户选择 `source/game_type/day`。控制破坏面：

- `groupBy` 取值仍只有 `source` / `day`；
- 行保留 `k`，新增 `gameType: 'doudizhu' | 'paodekuai' | null`；
- `totals` 仍是全窗口合计（跨玩法）；
- `burn` / `entryFeeSkips` **保留既有总数 SQL 与语义**（`players` 是全局去重人数，不可由分组相加），
  另加 `burnByGame` / `entryFeeSkipsByGame` 数组；
- CSV 在“分组”后插“玩法”列（中文标签）。

## 5. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | `gameType` 只允许出现在**游戏相关来源**：`game_settle` / `robot_pool` / `entry_fee` / `card_counter`；其它来源携带 ⇒ 10001 | 有界语义；防止非游戏流水被误标玩法 |
| D2 | `game_type` 只存 `currency_ops`，`currency_flows` 不存 | 一次 apply 一个 op；读口已 JOIN ops；避免双写漂移 |
| D3 | **`gameType` 不参与 `request_hash`**；显式 ddz 与缺席同指纹。`currencyApplyHash` 入参类型可含 `gameType?` 但 canonical **忽略**它（注释写明 D3，避免 TS excess-property 陷阱）。副作用：同 actionId、同金额、不同 gameType 的请求按重放处理，落库玩法取首写值 —— 有意接受并由单测钉住 | outbox 条目在升级前已携带 gameType 而旧指纹未含；若纳入会让在途条目重发撞 14002。gameType 是归因元数据，不改变金额语义；actionId 已锚定业务（`robot_pool` 的 `rr:<botId>:<target>:<observed>` 是既有同形风险，不因本片加剧） |
| D4 | 游戏相关来源**缺席** `gameType` ⇒ 落库 `'doudizhu'`；非游戏来源 ⇒ 落库 `NULL`；历史游戏相关行迁移回填 `'doudizhu'` | 旧 RPC 缺省斗地主；非游戏流水不伪造玩法 |
| D5 | `currency_ops.game_type varchar(16) NULL` **追加到表尾** + `idx_ops_game_created (game_type, created_at)`；**DDL 与历史回填拆成两个迁移**，回填用 TS keyset 分批（500/批，可重入） | 避免列重排；兼容非游戏 NULL；A2 筛选走索引；避免 append-only 账本的无界 UPDATE 与「DDL 已提交但迁移未记录」卡死 |
| D6 | 台费免单 `game_type varchar(16) NOT NULL DEFAULT 'doudizhu'` **追加到表尾** + 索引；请求 `gameType?` 缺席 = ddz | 审计表每行必属一局；旧行默认正确 |
| D7 | 财务列表 `gameType` 精确过滤；汇总行 `(k, gameType)`；`totals` 跨玩法合计；burn/漏收保留总数（独立 SQL） + 按玩法数组（新增分组 SQL） | 兼容旧读口与 `players` 去重语义，同时默认可见玩法维度 |
| D8 | `game_records_pdk.game_type NOT NULL DEFAULT 'paodekuai'`；写入显式取 `req.gameType`（PDK 分支必须是 pdk） | 用户裁决；旧行默认正确 |
| D9 | `game_record_players_pdk` 增 `score_change int NOT NULL DEFAULT 0`、`won tinyint(1) NOT NULL DEFAULT 0`；**DDL 与数据回填拆成两个迁移**；回填用 TS keyset 分批（500/批）+ `jsonOf` 双形态（string/object），`won = seat = winner_seat`；记录 DTO 改读新列 | 避免 `JSON_TABLE` 平台差异与「DDL 已提交但迁移未记录」；迁移可单测、可重入；与 DDZ 玩家行同形 |
| D10 | PDK 玩家行增 `KEY idx_pdk_user_ended (user_id, ended_at)`；保留既有 `idx_pdk_user` | 支撑 `MAX(ended_at)` 与最近对局；删旧索引属额外风险，YAGNI |
| D11 | 玩家列表 `lastActiveAt` = `max(设备, DDZ 最近局, PDK 最近局)`，SQL 在 **epoch ms 空间**用 `TIMESTAMPDIFF(MICROSECOND,'1970-01-01',col) DIV 1000` 与 PDK BIGINT 直接比较；表达式抽单一常量三处复用 | 不依赖会话时区（`UNIX_TIMESTAMP` 会）；避免三份漂移 |
| D12 | 最近对局 = DDZ 查询 + PDK 查询（各取 limit，**均不按 mode 过滤**，保留 DDZ 现行为）后按 `endedAt DESC, recordId DESC, gameType` 合并截断；PDK `role = null`；返回 `gameType` | 两表分离；同一张表口径一致 |
| D13 | 管理页最近对局加“玩法”列；财务页加玩法筛选/列；汇总表加玩法列；`gameLabelText(undefined/null) = '—'`；CSV 用中文玩法标签 | 用户可见最终行为 |
| D14 | 新增 `slice-31-pdk-gold`；同步 `slice-17`（新迁移行/列/新索引）、`slice-25`（汇总按玩法求和 + 免单 game_type）；`slice-29` 零改动；`baselines.json` 按**可证明的最小静态条数**回填并登记“待权威轮实测校正” | 避免与 2/4 会话双改；保留真栈证据 |
| D15 | 独立 worktree/分支，从 A1 开出；交付登记与 A1、2/4 分支合并顺序 | 同文件冲突面 |
| D16 | 迁移 `down` 可逆：删索引/列；回填数据随列删除（可由父行 JSON 重算） | dev-process 迁移纪律 |
| D17 | **升级顺序**：currency-service（迁移+代码）→ room-service / user-service；**回滚反向**：先回应用再 `down` | 旧 currency 不认 gameType（哈希不含它，重试仍能重放）；避免新代码跑在缺列库 |
| D18 | 不改任何协议出站形状；`CurrencyApplyData` 不返回 gameType | 客户端零感知 |
| D19 | 管理端玩家列表不做“按玩法分开”的列（总数即可）；详情已有 `byGame` 分玩法 | 本轮 A3 目标是“纳入” |
| D20 | 同步管理财务旧消费者：`slice-17` 列串/迁移行、`slice-25` `summarySourceDelta` 求和、`scripts/admin-players-probe.mjs`、`docs/ops/entry-fee-reconcile.md` | 防止旧断言假红/假绿 |

## 6. 实现设计

### 6.1 协议（`packages/protocol/src/currency.ts`）

```ts
import { isGameType, type GameType } from './game';

/** 允许携带 gameType 的来源（顺序稳定；与 D1 一致）。 */
export const GAME_SCOPED_CURRENCY_SOURCES = [
  'game_settle',
  'robot_pool',
  'entry_fee',
  'card_counter',
] as const;
export type GameScopedCurrencySource = (typeof GAME_SCOPED_CURRENCY_SOURCES)[number];

export function isGameScopedCurrencySource(source: string): source is GameScopedCurrencySource;
```

- `CurrencyApplyRequest` 增加 `gameType?: GameType`；`CurrencyEntryFeeSkipRequest` 增加 `gameType?: GameType`。
- `validateCurrencyApply`：
  - `gameType !== undefined` ⇒ 必须 `isGameType`，否则 10001；
  - 同时 `source` 必须 ∈ `GAME_SCOPED_CURRENCY_SOURCES`，否则 10001；
  - 缺席不校验（旧载荷兼容）。
- `validateCurrencyEntryFeeSkip`：`gameType` 若在场必须 `isGameType`；缺席合法。
- **`currencyApplyHash` 入参类型含 `gameType?: GameType`，但 canonical 不写入该字段**（D3；注释写明，
  避免测试字面量的 TS excess-property 陷阱）。单测钉：
  带/不带 `gameType`、显式 ddz、显式 undefined 全部同 hash；旧金标向量不变；
  非游戏来源携带 gameType ⇒ 10001；空串/`ddz`/未知值 ⇒ 10001；
  同 actionId 异 gameType 的第二次 apply ⇒ `replayed:true` 且库内 `game_type` 不变。

### 6.2 货币迁移（currency-service）

**`1797000000000-GameTypeOnOpsDdl.ts`**（类名不得匹配 `/^Currency\d+$/`）：

```sql
-- up（1 条）
ALTER TABLE `currency_ops`
  ADD COLUMN `game_type` varchar(16) NULL DEFAULT NULL,
  ADD KEY `idx_ops_game_created` (`game_type`, `created_at`);

-- down（1 条）
ALTER TABLE `currency_ops` DROP KEY `idx_ops_game_created`, DROP COLUMN `game_type`;
```

**`1797000000001-GameTypeOnOpsBackfill.ts`**（数据迁移，可重入）：

```ts
// keyset 分批；每批只更新 game_type 仍为 NULL 的游戏相关来源行。
const SELECT_BATCH =
  'SELECT `id` FROM `currency_ops` ' +
  "WHERE `game_type` IS NULL AND `source` IN ('game_settle','robot_pool','entry_fee','card_counter') " +
  'AND `id` > ? ORDER BY `id` LIMIT 500';
const UPDATE_BATCH =
  "UPDATE `currency_ops` SET `game_type` = 'doudizhu' " +
  'WHERE `id` IN (?) AND `game_type` IS NULL';
// up：循环 SELECT → UPDATE；down：no-op（列由 DDL 迁移的 down 删除）。
```

拆分理由：MySQL DDL 隐式提交；若 DDL 与回填同一迁移，任何一批失败都会留下「列已加、数据半填、
迁移未记录」状态，容器下次启动在 `ADD COLUMN` 上撞 duplicate。拆分后 DDL 先被记录，回填可重入重跑。

**`1797000000002-EntryFeeSkipsGameType.ts`**：

```sql
-- up（1 条）
ALTER TABLE `currency_entry_fee_skips`
  ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT 'doudizhu',
  ADD KEY `idx_skips_game_created` (`game_type`, `created_at`);

-- down（1 条）
ALTER TABLE `currency_entry_fee_skips` DROP KEY `idx_skips_game_created`, DROP COLUMN `game_type`;
```

回填只覆盖四个游戏相关来源；`signup_grant` / 支付五源 / `admin_adjust` / `admin_reverse` /
`relief_grant` 保持 `NULL`（= 未标注玩法）。

### 6.3 写点接线

| 来源 | 文件 | 传值 |
|---|---|---|
| `game_settle` 首发 | `packages/room-service/src/currency/settle.service.ts:536` | 已在作用域的 `gameType` |
| `game_settle` outbox 重发 | 同文件 `resendSettleOutboxEntry` | `entry.gameType`（D3 下不影响指纹） |
| `entry_fee` | `packages/room-service/src/rooms/rooms.start.ts:776` | `chargeOne(..., gameType)` 的 `gameType` |
| `entry_fee_skip` | 同文件 `recordEntryFeeSkip(...)` | 同上，新增请求字段 |
| `robot_pool` | `packages/room-service/src/currency/robot-funding.ts:259` | `applyFunding` 增加 `gameType` 参数（调用方已有） |
| `card_counter` | `packages/currency-service/src/card-counter/card-counter.service.ts:98` | 不传（能力仅 DDZ；服务端按来源归一 ddz） |
| `signup_grant` / 支付 / admin | 各自调用点 | 不传（非游戏来源，落 NULL） |

`ApplyService`：
- `request` 类型加 `gameType?: GameType`；
- 插入 `currency_ops` 时写 `resolveOpsGameType(source, request.gameType)`；
- 校验已保证非游戏来源不会带值。

`EntryFeeSkipService`：`SKIP_INSERT_SQL` 显式增加 `game_type` 列，值 `request.gameType ?? 'doudizhu'`；
不得依赖列默认值（否则 PDK 免单被静默标 ddz）。

### 6.4 管理财务读口（currency-service + admin）

**SQL 常量**（`finance-query.service.ts`）：

```sql
-- 列表基句新增
o.game_type AS gameType

-- source 汇总（行按玩法展开）
SELECT o.source AS k, o.game_type AS game_type, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount
FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id
WHERE f.created_at >= ? AND f.created_at < ?
GROUP BY o.source, o.game_type ORDER BY k, o.game_type

-- day 汇总（行按玩法展开）
SELECT DATE(CONVERT_TZ(f.created_at,'+00:00','+08:00')) AS k, o.game_type AS game_type,
       COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount
FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id
WHERE f.created_at >= ? AND f.created_at < ?
GROUP BY k, o.game_type ORDER BY k, o.game_type

-- burn 总数：保持现有 SUMMARY_BURN_SQL 原样（恰一行）
-- burn 按玩法（新增；0..n 行）
SELECT o.game_type AS k, COALESCE(SUM(o.burned_residue),0) AS residue,
       COALESCE(SUM(o.burned_rake),0) AS rake, COUNT(*) - COUNT(o.burned_residue) AS unrecordedOps
FROM currency_ops o
WHERE o.source='game_settle' AND o.created_at >= ? AND o.created_at < ?
GROUP BY o.game_type ORDER BY k

-- 漏收总数：保持现有 SUMMARY_SKIPS_SQL 原样（恰一行；players 全局去重）
-- 漏收按玩法（新增；0..n 行；players 为该玩法内去重）
SELECT game_type AS k, COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players,
       COALESCE(SUM(fee_amount),0) AS amount
FROM currency_entry_fee_skips
WHERE created_at >= ? AND created_at < ?
GROUP BY game_type ORDER BY k
```

- `OpsListFilter` 增加 `gameType?: GameType`；`listOps` 追加 `o.game_type = ?`。
- `AdminOpsRow` 增加 `gameType: GameType | null`（null 透传；非空未知值响亮抛）。
- `SummaryRow` 增加 `gameType: GameType | null`；day 分支仍格式化 `k`。
- `SummaryResult` 增加：
  ```ts
  burnByGame: Array<{ gameType: GameType | null; residue: number; rake: number; unrecordedOps: number }>;
  entryFeeSkipsByGame: Array<{ gameType: GameType; cnt: number; players: number; amount: number }>;
  ```
- **总数 SQL 保持“恰回一行”守卫**；新增 by-game SQL 允许 0 行（空窗 ⇒ `[]`）。
  查询次序钉死：group → burn → skips → purchases → consumptions → burnByGame → skipsByGame。
- 一致性守卫（可选但推荐）：by-game 的 `residue/rake/unrecordedOps/cnt/amount` 之和必须等于总数，
  不等 ⇒ 响亮抛（`players` 不比较，全局去重 ≠ 分组相加）。
- controller：
  - `OPS_QUERY_KEYS` 增加 `gameType`；
  - `parseOpsQuery` 用 `isGameType` 校验，文案 `gameType 非法：须为 doudizhu 或 paodekuai`；
  - CSV `OPS_CSV_HEADER` 在“来源”后加“玩法”；`SUMMARY_CSV_HEADER` 在“分组”后加“玩法”；
    CSV 单元格用中文标签（`gameLabelText`）。
- 管理页（`admin/index.html` + `admin/app.js`）：
  - 财务筛选条加 `fin-game-type`（全部/斗地主/跑得快）并进入 `fin.filter`；
  - 流水表头加“玩法”（12 列），`buildFinFlowRow` 输出 `gameLabelText(row.gameType)`；
  - 详情 `colSpan` 11 → 12；详情头部显示玩法；
  - 汇总表按 `source` / `day` 均显示“玩法”列；空态 `colSpan` 3 → 4；
  - `burn` / 漏收行追加按玩法明细（保留既有总数前缀文案，静态闸针脚不破）；
  - 玩家详情最近对局表加“玩法”列。

`gameLabelText`：`doudizhu → 斗地主`、`paodekuai → 跑得快`、`null`/`undefined → —`。

### 6.5 PDK 记录迁移与写入（user-service）

**`1797000000000-PdkRecordGameTypeDdl.ts`**：

```sql
-- up 静态 2 条
ALTER TABLE `game_records_pdk`
  ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT 'paodekuai';

ALTER TABLE `game_record_players_pdk`
  ADD COLUMN `score_change` int NOT NULL DEFAULT 0,
  ADD COLUMN `won` tinyint(1) NOT NULL DEFAULT 0,
  ADD KEY `idx_pdk_user_ended` (`user_id`, `ended_at`);

-- down 静态 2 条（逆序）
ALTER TABLE `game_record_players_pdk`
  DROP KEY `idx_pdk_user_ended`, DROP COLUMN `won`, DROP COLUMN `score_change`;
ALTER TABLE `game_records_pdk` DROP COLUMN `game_type`;
```

**`1797000000001-PdkRecordPlayerBackfill.ts`**（数据迁移，可重入）：

```ts
const SELECT_BATCH =
  'SELECT p.id, p.seat, r.winner_seat, r.score_changes ' +
  'FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id ' +
  'WHERE p.id > ? ORDER BY p.id LIMIT 500';
const UPDATE_ROW =
  'UPDATE game_record_players_pdk SET score_change = ?, won = ? WHERE id = ?';
// jsonOf：string ⇒ JSON.parse；object ⇒ 原样（照 records.service.ts:120-130 既有惯例）。
// 数组按 seat 取 delta；畸形/缺座 ⇒ 0。won = seat === winner_seat ? 1 : 0。
// up：循环分批重算（幂等：重跑覆盖同值）；down：no-op（列由 DDL 迁移的 down 删除）。
```

拆分理由同 §6.2：MySQL DDL 隐式提交，DDL 与回填分离后回填失败可安全重跑，不会卡启动。
迁移单测必须分别喂 `score_changes` 为 **string** 与 **object** 两种驱动形态。

- 写入（`record.rpc.controller.ts`）：
  - `game_records_pdk` INSERT 增加 `game_type`，值 = `req.gameType ?? 'paodekuai'`；
  - 玩家行 INSERT 增加 `score_change`（从 `result.scoreChanges` 按 seat 取，缺失 0）与
    `won`（`seat === winnerSeat`）。
- `records.service.ts`：PDK 玩家附页 SELECT 增加 `score_change, won`，`toPdkDto` 直接用列值；
  `PdkRecord` 出站形状不变。

### 6.6 管理端玩家统计（user-service + admin）

`admin-players.service.ts`：

```ts
/** 单一时区无关表达式：所有时间先换 epoch ms 再比较。 */
const LAST_ACTIVE_MS_EXPR = `
  CASE WHEN d.last_seen IS NULL AND g.last_game IS NULL AND pg.last_game_ms IS NULL THEN NULL
  ELSE GREATEST(
    COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', d.last_seen) DIV 1000, 0),
    COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', g.last_game) DIV 1000, 0),
    COALESCE(pg.last_game_ms, 0)
  ) END`;
```

- `PLAYERS_FROM_SQL` 增加 PDK 子查询（`MAX(p.ended_at)`，过滤 `random|gold`、`is_robot=0`）。
- 列表 SELECT/ORDER、`buildWhere` 的 activity 筛选、`summaryBase` 的内层查询三处共用
  `LAST_ACTIVE_MS_EXPR`；activity 参数改为 epoch ms 数字；`u.createdAt` 仍用 `Date`。
- `lastActiveAt = row.last_active_ms == null ? null : Number(...)`（不再经 `toEpochMs`）。
- `enrich`：DDZ 聚合 SQL 保留；新增 PDK 聚合（`SUM(p.won)`、`MAX(p.ended_at)`）；
  JS 合并 `games/wins` 与 `lastGame`。
- `summaryBase`：内层 `last_active_ms` 并入 PDK；活跃/流失/从未活跃口径一致（快照无需改结构）。
- **`summaryBase` 参数单位表（必须逐项落地）**：

  | 参数位 | SQL 比较 | 绑定类型 |
  |---|---|---|
  | `new_today` / `new_7d` | `t.createdAt >= ?` | `Date`（不变） |
  | `active_1d` / `active_7d` / `active_30d` | `t.last_active_ms >= ?` | `now - N*DAY_MS`（number） |
  | `inactive_14d` / `inactive_30d` | `(t.last_active_ms IS NULL OR t.last_active_ms < ?)` | number |
  | `inactive_14d` / `inactive_30d` | `t.createdAt < ?` | `Date`（不变） |

  `buildWhere` 的 `active7/active30/inactive14/inactive30` 同样：`last_active_ms` 阈值绑 number，
  `u.createdAt < ?` 绑 Date。单测必须**断言参数数组**（fake DB 捕获 `params`），不能只断言 SQL 子串。

`recentGames`：
- DDZ 查询增加 `'doudizhu' AS game_type`（**不加 mode 过滤**，保留现行为）；
- 新增 PDK 查询（同样**不按 mode 过滤**）：
  ```sql
  SELECT p.record_id, r.mode, r.base_score, NULL AS role, p.won, p.score_change,
         p.money_delta, p.ended_at
  FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
  WHERE p.user_id = ? AND p.is_robot = 0
  ORDER BY p.ended_at DESC, p.record_id DESC LIMIT ?
  ```
- 合并、按 `endedAt DESC, recordId DESC, gameType` 排序、截断 `limit`；
- 返回类型增加 `gameType: 'doudizhu' | 'paodekuai'`，`role: string | null`；PDK `role=null`。

管理页：
- 最近对局表头加“玩法”，行 `[gameLabelText(g.gameType), g.mode, ...]`；`role` 空显示 `—`；
- 列表 `games/wins` 自动为两玩法合计；
- `scripts/admin-players-probe.mjs` 的 games fixture 增加一条 PDK 行（`gameType:'paodekuai', role:null`），
  断言详情出现“跑得快”与 `—`。

### 6.7 conformance `slice-31-pdk-gold`

新增 `tools/conformance/src/slices/slice-31-pdk-gold.ts`，追加在 `CASES` 末尾。

**前置**
- 五容器 healthy；`purgeGoldQueues`（`match:queue:gold:*` + gold 票 meta）并断言零残留。
- 快照并 PUT + 等 room-service 快照生效：
  - `game.paodekuai.enabled=true`
  - `game.paodekuai.goldRoomEnabled=true`
  - `game.levels.paodekuai`：15 档 `entryFeePercent=10`（其余档位原样）
  - `game.paodekuai.rakePercent=0`（结算向量与流水可逐座比对）
- 注册 3 个 harness 用户，各预充 1,000,000（拆 1e6/笔）。

**断言组**
1. 金币匹配：3 人 `room.match(mode=gold, gameType=paodekuai, playerCount=3, baseScore=15)` ⇒ 开局；
   视图 `gameType=paodekuai`。
2. 台费：轮询管理面 `GET /api/admin/wallet/ops?source=entry_fee&gameType=paodekuai&ownerId=<id>&limit=100`
   各用户出现 `refId=<roomCode>` 的行；`delta=-1`（15×10%=1）、`gameType=paodekuai`；
   DB 断言 `SELECT CONCAT(source,':',game_type) FROM currency_ops WHERE action_id='entryfee:<room>:<uid>'`
   = `entry_fee:paodekuai`。
3. 确定性 game_settle 维度：直投 `currency.apply`（`source='game_settle'`, `gameType='paodekuai'`,
   `actionId='s31:<RUN_TAG>:inject'`, `refId='s31:<RUN_TAG>:injected'`，entries +10/−10）⇒ ok 且
   `replayed=false`；DB `game_type='paodekuai'`；管理面按 `source+gameType+ownerId` 能查到；
   汇总 `{k:'game_settle', gameType:'paodekuai'}` 增量 +2。**actionId/owner/refId 必须带 `RUN_TAG`**
   （共享脏栈重跑时固定 id 会 replay ⇒ 增量断言假红）。
4. 真实对局结算：`playPdkToEnd`；`game.settlement.gameType=paodekuai`。
   `PdkOutcome` 增加 `settlementVersion`（从 `game.settlement` 信封的 `version` 取；
   `playPdkToEnd` 已持有该消息，切片不得用 `finalView` 或 `Date.now()` 代替）。
   - 取 `settlement.scoreChanges` 的非零子集；若为空（极端全保本）：断言 DB 无
     `action_id='settle:<room>:<settlementVersion>'` 的 op（全零不调 apply），并继续后续组。
   - 若非空：轮询 DB/管理面按用户查到的 `settle:<room>:<settlementVersion>` 行，逐座比对 delta；
     零 delta 座不得有该 op 的分录；DB `game_type='paodekuai'`。
5. 汇总：以进入本片前的 source 汇总为基线，轮询 `{k:'entry_fee', gameType:'paodekuai'}` 的
   `flowCount` ≥ 基线+3、`delta` ≤ 基线−3；`{k:'game_settle', gameType:'paodekuai'}` 的
   `flowCount` ≥ 基线 + (2 注入 + 真实非零座数)；`totals` = 各行之和。
6. 漏收玩法维度：直投 `currency.entryFeeSkip`（`gameType='paodekuai'`，唯一 roomCode/owner）⇒
   DB `game_type='paodekuai'`；汇总 `entryFeeSkipsByGame` 含 `paodekuai` 且 `cnt` +1。
7. 记录：轮询 `GET /api/records/mine?gameType=paodekuai` 命中本局 `mode='gold'`；
   `players[].scoreChange/won` 与结算向量一致；DB 断言 `game_records_pdk.game_type='paodekuai'`
   且玩家行 `score_change/won` 逐座精确（不是“非默认值”）。
8. 管理玩家统计：`GET /api/admin/players/:id/games?limit=50` 含本局且 `gameType='paodekuai'`；
   `GET /api/admin/players?q=<phone>` 为新注册用户 ⇒ **精确** `games=1`、
   `wins = mySeat === winnerSeat ? 1 : 0`（不得用“至少包含本局”）；
   `lastActiveAt = 本局记录里的 endedAt`（从 `/api/records/mine` 或 DB 读，不用 `Date.now()`），
   且 `activity=active7` 能命中该用户。
9. `lastActive` 三分支真栈对账（在 #8 之前造两个专门用户）：
   - **device-only**：注册后确保 `user_devices.last_seen_at` 有值（注册/登录链路产生）；断言
     `GET /api/admin/players?q=<phone>` 的 `lastActiveAt` 等于 DB
     `TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',last_seen_at) DIV 1000`。
   - **DDZ-only**：用 `mysqlExec` 直插一条最小合法 `game_records` + `game_record_players` 行
     （已知 `ended_at`，`mode='random'`，`is_robot=0`），断言 `lastActiveAt` 等于该 `ended_at`。
   - **PDK**：#8 的用户断言 `lastActiveAt` = PDK 记录 `ended_at`。
   三支分别覆盖 `d.last_seen` / `g.last_game` / `pg.last_game_ms`，防止 `TIMESTAMPDIFF` 分支假绿。
   直插行留在测试库（与既有 conformance 造数同款，不删）。

**收尾（finally）**：还原 `game.levels.paodekuai`、`game.paodekuai.rakePercent`、
`game.paodekuai.goldRoomEnabled`、`game.paodekuai.enabled`；关闭全部 socket；队列零残留。
**不做**：slice-29 修改；PDK 2/4 人；机器人补位。

`pdk-driver` 改动：`startPdkRoom(label, { mode?: 'random'|'gold', baseScore?, users? })`，
`mode` 缺省 `'random'`（slice-29 行为不变）。

### 6.8 迁移、升级与回滚

- **旧 RPC / 旧 outbox**：`gameType` 不参与指纹（D3）⇒ 升级前在途条目重发仍命中旧 op，
  不会 14002；落库玩法在首写时确定，重放不更新（旧 PDK 在途条目的 `game_type` 可能为 ddz，
  属已知数据质量窗口；生产未部署 PDK）。
- **升级顺序（D17）**：currency-service（迁移+代码）→ room-service / user-service。
  旧 room-service 调新 currency-service 时缺 gameType 仍按来源归一 ddz；新 room-service 调旧
  currency-service 时多余字段被忽略（校验不拒绝未知键），窗口内 PDK 流水缺玩法标注。
- **回滚顺序**：先回滚 room-service / user-service / currency-service 代码，再执行迁移 `down`。
- **旧管理页缓存**：新增字段被忽略；CSV 多一列（下载文件，不影响页面）。
- **PDK 记录回滚**：删列后旧代码/旧客户端照常；`game_type` 冗余不影响旧查询。
- **无客户端协议变更**。

## 7. 错误处理与边界

- `gameType` 非法/非游戏来源携带 ⇒ `ProtocolError`（10001），在 apply 内核校验点拒绝，零库操作。
- 迁移回填 `source IN (...)` 只含四个游戏来源；未知新来源不自动标 ddz。
- 汇总遇到数据库回值 `game_type` 非 `GameType` 且非 NULL ⇒ 响亮抛（不静默归 ddz）。
- PDK `score_changes` 历史 JSON 畸形 ⇒ 回填 `score_change=0`；`won` 仍由 `winner_seat` 回填。
- 部署顺序必须先迁移后起服务（既有 `migrationsRun` 同进程启动，满足）。
- `TIMESTAMPDIFF` 只把 DATETIME 当字面量，不做会话时区换算；返回值统一转 `Number`。
- 财务汇总 `gameType=null` 行在 UI 显示 `—`，不丢弃。
- `entryFeeSkipsByGame.players` 是**各玩法内**去重，不能相加成全局人数；UI 明示。

## 8. 测试判据（完成定义）

1. **协议**：校验、hash 同值（带/不带 gameType）、entryFeeSkip；`pnpm -C packages/protocol test` 全绿。
2. **currency-service**：apply 写入 game_type（四来源 + 非游戏 NULL）；财务列表筛选/汇总/burn/漏收
   按玩法；CSV 表头；迁移形状（DDL up/down 逐字 + 回填 keyset SQL；回填迁移 down = no-op）；
   旧 `players` 去重语义；全包测试与 lint 绿。
3. **room-service**：settle 首发/outbox 重发、entry fee/skip、robot funding 的 `gameType` 透传；
   旧 outbox 条目仍重放成功；相关测试绿。
4. **user-service**：PDK 记录写入 `game_type/score_change/won`；两个迁移（DDL 形状 + 回填
   重入/string-object 双形态 fixture）；玩家列表 `lastActiveAt/games/wins` 含 PDK；
   `activity` 与 `summaryBase` 的**参数数组**（Date vs number）单测；最近对局合并 +
   `gameType`/`role=null`；fake DB 按 `game_record_players_pdk` 独立路由；全包测试与 lint 绿。
5. **管理端**：`node scripts/verify-admin-static.mjs`、`node scripts/admin-players-probe.mjs` 通过
   （新增玩法筛选/列/PDK 行针脚）。
6. **conformance 编译**：`pnpm -C tools/conformance exec tsc --noEmit` 通过；
   `slice-17`/`slice-25` 断言更新；`slice-31` 加入 `run.ts`；`baselines.json` 追加静态计数并登记
   “待权威轮实测校正”。
7. **全量验证**：`pnpm exec turbo run test lint --force`（Cached 不算真跑）；`pnpm verify:admin`。
8. **真栈**：本机 Docker 不可用 ⇒ 如实登记“待权威轮”。权威轮必须跑 `slice-17` / `slice-25` /
   `slice-31`，并在真库执行迁移 `up → 抽查回填 → down → 再 up`；`slice-31` 的
   `lastActive` 三分支（device/DDZ/PDK）与 `summaryBase.active1d` 必须实测。不得声称已跑。
9. 工作区干净（除用户既有未提交文件）。
10. `docs/ops/entry-fee-reconcile.md` 的 skips 列清单补 `game_type`。

## 9. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 与 2/4 会话同改 user-service 查询 | 合并冲突 | 独立分支自 A1 开出；不碰 slice-29；交付登记顺序 |
| 汇总行按玩法展开改变旧消费者 | 管理页/CSV | 保留 `k`/`totals`/burn 总数；新增字段；同步 admin、slice-17/25、静态闸 |
| 旧 outbox 指纹 | 14002/重复结算 | D3：gameType 不入指纹；单测钉旧向量 |
| PDK 记录加列/回填 | 记录写失败/历史 0 | TS 分批回填 + 单测；写入与迁移同提交；record.write 幂等 |
| 玩家列表 SQL 变复杂 | 慢查询 | `(user_id, ended_at)` 索引；分页数小 |
| 时区 | lastActive 偏移 | epoch ms 表达式（`TIMESTAMPDIFF`）；真栈断言 `lastActiveAt >= endedAt` |
| slice-31 拉长 CI | 时间 | 只打一局 PDK + 3 人；复用 pdk-driver |
| 回填默认 0 伪造历史分差 | 数据可信度 | 旧行由父表 JSON 回填；生产未部署 PDK；测试库可重算 |
| baseline 未实测 | CI 假红/纪律 | 静态计数先回填并登记；权威轮校正 |

## 10. 涉及文件

**协议**
- `packages/protocol/src/currency.ts`
- `packages/protocol/src/currency.test.ts`

**currency-service**
- `packages/currency-service/src/migrations/1797000000000-GameTypeOnOpsDdl.ts`（新增）
- `packages/currency-service/src/migrations/1797000000001-GameTypeOnOpsBackfill.ts`（新增）
- `packages/currency-service/src/migrations/1797000000002-EntryFeeSkipsGameType.ts`（新增）
- `packages/currency-service/src/apply/apply.service.ts`
- `packages/currency-service/src/skip/entry-fee-skip.service.ts`
- `packages/currency-service/src/admin/finance-query.service.ts`
- `packages/currency-service/src/admin/admin-finance.controller.ts`
- `packages/currency-service/test/{migration,apply,admin-finance,entry-fee-skip}.test.ts`
- `packages/currency-service/test/helpers/*`（假 DB 的 SQL/插入支持）

**room-service**
- `packages/room-service/src/currency/settle.service.ts`
- `packages/room-service/src/currency/robot-funding.ts`
- `packages/room-service/src/rooms/rooms.start.ts`
- `packages/room-service/test/currency/*`、`rooms.entry-fee.test.ts`、`rooms.start.test.ts`

**user-service**
- `packages/user-service/src/migrations/1797000000000-PdkRecordGameTypeDdl.ts`（新增）
- `packages/user-service/src/migrations/1797000000001-PdkRecordPlayerBackfill.ts`（新增）
- `packages/user-service/src/rpc/record.rpc.controller.ts`
- `packages/user-service/src/records/records.service.ts`
- `packages/user-service/src/players/admin-players.service.ts`
- `packages/user-service/test/{migration,record-pdk-write,record-pdk-query,admin-players}.test.ts`

**管理端**
- `admin/index.html`
- `admin/app.js`
- `scripts/verify-admin-static.mjs`
- `scripts/admin-players-probe.mjs`

**conformance**
- `tools/conformance/src/slices/slice-31-pdk-gold.ts`（新增）
- `tools/conformance/src/slices/slice-17-currency.ts`（列串/迁移行/新索引/回填断言）
- `tools/conformance/src/slices/slice-25-entry-fee.ts`（汇总按玩法求和 + 免单 game_type）
- `tools/conformance/src/run.ts`
- `tools/conformance/baselines.json`
- `tools/conformance/src/lib/pdk-driver.ts`（可选 `mode`）

**文档**
- 本 spec、对应 plan、实施记录
- `docs/ops/entry-fee-reconcile.md`（skips 列清单）

## 11. 审查记录

### 第一轮设计对抗审查（2026-10-25）

结论：需修订（7 阻断 / 14 高 / 4 低）。逐条处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| B1 | outbox 已带 gameType，重发若传入会改指纹 ⇒ 在途条目 14002 | **改 D3：gameType 不参与 request_hash**；无 marker/双 hash 复杂度；单测钉同指纹 |
| B2 | burn 分组 SQL 引用未定义别名 `o` | 已改 `FROM currency_ops o` / `o.game_type` |
| B3 | 新迁移打红 slice-17（列串/migrations_currency 行数） | 已纳入 D14/§6.7/§8；列追加表尾并更新 slice-17 列串、7 行名单（既有 4 + 新增 3）、新索引断言 |
| B4 | slice-31 漏 `game.paodekuai.goldRoomEnabled` | 已改 §6.7 前置（快照/PUT/等待/还原） |
| B5 | slice-31 用不存在的 `refId` 查询键 | 已改：管理面按 `source+gameType+ownerId` 轮询；DB 按 `action_id` 精确断言 |
| B6 | 保本座 delta=0 ⇒ settle 行数不定/可能不调 apply | 已改：真实对局按 `scoreChanges` 非零子集逐座；全零显式断言无 op；另加确定性 RPC 注入覆盖维度 |
| B7 | 漏收 `players` 全局去重 ≠ 分组相加 | 已改 D7/§6.4：保留总数 SQL，新增 by-game 数组；不比较 players |
| H8 | 升级顺序未定义 | 已改 D17/§6.8 |
| H9 | 现有“恰回一行”守卫与假库全文匹配 | 已改 §6.4：总数 SQL 不动，新增 by-game SQL；测试工作量登记于 §10/§8 |
| H10 | slice-31 单次 GET 与异步写竞态 | 已改 §6.7：全部落库/统计断言轮询 |
| H11 | slice-31 未清 PDK 金币队列 | 已改 §6.7 前置/收尾 `purgeGoldQueues` |
| H12 | `FROM_UNIXTIME` 依赖会话时区 | 已改 D11：`TIMESTAMPDIFF(... ) DIV 1000` epoch ms，返回直接转 Number |
| H13 | lastActive 表达式三份拷贝/无真断言 | 已改 §6.6：抽 `LAST_ACTIVE_MS_EXPR`；slice-31 断言 `lastActiveAt >= endedAt` 与 `activity=active7` |
| H14 | fake DB 按 `SUM(p.won)` 子串路由会误接 PDK | 已改 §8：按 `game_record_players_pdk` 独立路由 + PDK fixture |
| H15 | JSON_TABLE 只在记录 SQL 测试覆盖；语句条数写错 | 已改 D9/§6.5：TS 分批 SELECT+UPDATE，可单测；修正 up/down 条数 |
| H16 | slice-25 `summarySourceDelta.find` 漏读分组 | 已改 D14/§6.7：改 `filter+reduce`；纳入权威轮 |
| H17 | baseline 静态回填不符纪律 | 已改 D14/§8：加入 CASES + 静态计数，登记“待权威轮实测校正”；不声称已跑 |
| H18 | entry_fee_skip 必须显式写 game_type | 已改 §6.3：`SKIP_INSERT_SQL` 显式列入交付 |
| H19 | admin-players DOM 探针未更新 | 已改 D13/§6.6：fixture 加 PDK 行、断言“跑得快”/`—`；`undefined` 也映射 `—` |
| H20 | recentGames mode 口径未定 | 已改 D12：两表均不按 mode 过滤（保留 DDZ 现行为） |
| H21 | 新列仅冗余存储，API 断言不经过新列 | 已改 D9/§6.5：`records.service` DTO 改读 `score_change/won`；slice-31 逐座精确断言 |
| L22 | 回填全表扫描 | 已改 D5/D9：**currency_ops 与 PDK 玩家行都**改为 keyset 分批（DDL/回填拆迁移） |
| L23 | 汇总空态 colSpan / CSV 标签 | 已改 §6.4：colSpan 4；CSV 中文标签 |
| L24 | `AFTER source` 大表重建风险 / 索引收益 | 已改 D5/D6：列追加表尾；索引保留但不再作为 burn 性能依据 |
| L25 | 文档遗漏 | 已改 §10：`docs/ops/entry-fee-reconcile.md` |

### 第二轮复审（2026-10-25）

结论：7 个阻断方向均已闭合；仍有 2 高残余 + 6 新问题（含 2 低）。逐条处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| R1 | `summaryBase` 的 `last_active` 阈值参数单位未写死 | 已改 §6.6：逐项参数单位表（Date vs number）+ 单测断言参数数组 |
| R2 | 真栈只覆盖 PDK BIGINT 分支，device/DDZ 分支假绿 | 已改 §6.7 #9：device-only / DDZ-only / PDK 三支分别对账 |
| R3 | slice-31 注入 op 固定 actionId，重跑 replay | 已改 §6.7 #3：actionId/owner/refId 带 `RUN_TAG`，断言 `replayed=false` |
| R4 | `settle:<room>:<version>` 的 version 无来源；endedAt 用 `Date.now()` | 已改 §6.7 #4/#8：`PdkOutcome` 增加 `settlementVersion`；endedAt 从记录/DB 读 |
| R5 | DDL 与 TS 回填同迁移，中途失败卡启动 | 已改 D5/D9/§6.2/§6.5：DDL 与回填拆两个迁移；回填可重入 |
| R6 | `score_changes` 驱动回值可能是 object | 已改 §6.5：`jsonOf` 双形态；迁移测试 string/object 两 fixture |
| R7 | L22 实际未覆盖 currency_ops 回填 | 已改 D5/§6.2：currency_ops 也 keyset 分批；审查记录改为真实处置 |
| R8 | games/wins “至少包含本局”过弱 | 已改 §6.7 #8：新用户精确 `games=1`、`wins` 按座位 |
| R9 | hash 入参不含 gameType 的 TS excess-property 陷阱 | 已改 §6.1/D3：入参类型含 `gameType?`，canonical 忽略 |
| R10 | gameType 不入 hash 的重放副作用未登记 | 已改 D3/§6.1：单测钉“异 gameType 同 actionId ⇒ replayed 且库值不变” |

第二轮后无新增阻断；可进入实现计划。实现阶段仍需以计划对抗审查兜住剩余可执行性风险。

