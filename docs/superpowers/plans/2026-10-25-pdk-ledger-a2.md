# A2/A3 实现计划：金币账本玩法维度 + 管理端玩家统计纳入跑得快 + PDK 金币场 conformance

> 日期：2026-10-25 · 对应 spec：`docs/superpowers/specs/2026-10-25-pdk-ledger-a2-design.md`
> 分支：`feature/pdk-ledger-a2-a3`（worktree `D:\Code\ftl-pdk-ledger-a2`，基于 `feature/pdk-observability-a1`）
> 流程：`docs/dev-process.md`；每个任务 TDD（失败测试 → 红 → 最小实现 → 绿 → 提交）。

## Global Constraints

1. **分支栈**：本分支从 `feature/pdk-observability-a1` 开出。A1 未合 dev；交付登记合并顺序
   （A1 → 本片 → 2/4 会话）。
2. **禁止触碰**：`apps/client/src/components/PdkSettlement.vue`（用户未提交改动）、
   `tools/conformance/src/slices/slice-29-paodekuai.ts`、B 组（playerCount/机器人样本/2/4 风控）、
   C 组（record outbox/对账/反洗钱）。
3. **协议出站形状不变**：`CurrencyApplyData` / `SettlementResult` / `PdkRecord` 字段不改；
   仅 `CurrencyApplyRequest` / `CurrencyEntryFeeSkipRequest` 增加可选入站字段。
4. **`gameType` 不参与 `request_hash`**（spec D3）。`currencyApplyHash` 入参类型可含
   `gameType?`，canonical 忽略；单测钉旧金标不变。
5. **迁移纪律**：DDL 与数据回填拆成两个迁移类；类名不得匹配 `/^Currency\d+$/` 或
   `startsWith('PdkRecords')` 的既有测试选择器；`down` 可逆；回填 keyset 分批、可重入。
6. **管理端纪律**：一切数据 `textContent` 渲染（`app.js` 零 `innerHTML`）；时间北京时间展示。
7. **提交**：每个任务一个 commit；末尾
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
8. **构建顺序**：本 worktree 首次测试前先
   `pnpm -C packages/protocol build && pnpm -C packages/shared build`
   （A1 计划已登记：协议 tsc 依赖其 dist 类型）。
9. **测试命令**（定向）：
   - `pnpm -C packages/protocol exec vitest run src/currency.test.ts`
   - `pnpm -C packages/currency-service exec vitest run test/migration.test.ts test/apply.test.ts test/entry-fee-skip.test.ts test/admin-finance.test.ts`
   - `pnpm -C packages/room-service exec vitest run test/currency/settle-outbox.test.ts test/currency/settle-pdk.test.ts test/currency/settle-failure.test.ts test/currency/robot-funding.test.ts test/rooms.entry-fee.test.ts test/rooms.start.test.ts`
   - `pnpm -C packages/user-service exec vitest run test/migration.test.ts test/record-pdk-write.test.ts test/record-pdk-query.test.ts test/admin-players.test.ts`
   - `pnpm -C tools/conformance exec tsc --noEmit`
   - `node scripts/verify-admin-static.mjs`、`node scripts/admin-players-probe.mjs`
10. **Docker 不可用**：本机无法起真栈；slice-31 只做 tsc + 静态计数，交付如实登记“待权威轮”。

## 任务总览

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | 协议：`gameType?` + 校验 + hash 忽略 | — |
| T2 | currency 迁移：ops DDL/回填/免单列 | T1 |
| T3 | ApplyService / EntryFeeSkipService 写入 | T1,T2 |
| T4 | room-service 写点接线 | T1 |
| T5 | 财务读口：列表筛选 + 汇总玩法维度 | T2,T3 |
| T6 | 管理页财务 UI + 静态闸 | T5 |
| T7 | user-service PDK 迁移：DDL + 回填 | — |
| T8 | PDK 记录写入 + 记录 DTO 读新列 | T7 |
| T9 | 玩家列表/汇总纳入 PDK | T7 |
| T10 | 最近对局合并 + 玩家页/探针/文档 | T8,T9 |
| T11 | conformance slice-31 + slice-17/25 + baseline | T1–T10 |
| T12 | 全量验证 + 实施记录 | T1–T11 |

---

## T1 协议：`gameType?`、校验、hash 忽略

**Files**
- `packages/protocol/src/currency.ts`
- `packages/protocol/src/currency.test.ts`

**Interfaces**
```ts
export const GAME_SCOPED_CURRENCY_SOURCES = [
  'game_settle', 'robot_pool', 'entry_fee', 'card_counter',
] as const;
export type GameScopedCurrencySource = (typeof GAME_SCOPED_CURRENCY_SOURCES)[number];
export function isGameScopedCurrencySource(source: string): source is GameScopedCurrencySource;

export interface CurrencyApplyRequest {
  // ...existing
  /** 游戏相关来源可携带；缺席由 currency-service 按来源归一（历史 RPC 缺省 doudizhu）。 */
  gameType?: GameType;
}
export interface CurrencyEntryFeeSkipRequest {
  // ...existing
  /** 缺席 = doudizhu。 */
  gameType?: GameType;
}
```
- `currencyApplyHash` 入参增加 `gameType?: GameType`，canonical **不写入**（注释引用 spec D3）。

**TDD**
1. 先写失败测试：
   - 四游戏来源接受 `doudizhu|paodekuai`；缺席合法。
   - `signup_grant` / `admin_adjust` / `admin_reverse` / 支付五源 / `relief_grant` 携带 gameType
     ⇒ `ProtocolError`，消息含 `不接受 gameType`。
   - 非法值 `''` / `'ddz'` / `null` / `1` ⇒ `ProtocolError`，消息含 `gameType 必须是`。
   - `validateCurrencyEntryFeeSkip` 接受 pdk/ddz/缺席，拒绝非法。
   - `currencyApplyHash`：同载荷带 pdk、带 ddz、缺席、`gameType: undefined` 四态同 hash；
     旧金标向量逐字不变。
2. 跑红：`pnpm -C packages/protocol exec vitest run src/currency.test.ts`。
3. 最小实现：
   ```ts
   import { GAME_TYPES, isGameType, type GameType } from './game';
   // validateCurrencyApply：把 gameType 加进解构（当前是 { actionId, source, entries, actor, reason, refId, burn }）
   const { actionId, source, entries, actor, reason, refId, burn, gameType } = req;
   // source 合法后
   if (gameType !== undefined) {
     if (!isGameType(gameType)) {
       throw new ProtocolError(`gameType 必须是 ${GAME_TYPES.join(' / ')} 之一（收到 ${JSON.stringify(gameType)}）`);
     }
     if (!isGameScopedCurrencySource(source)) {
       throw new ProtocolError(`source=${source} 不接受 gameType（仅 ${GAME_SCOPED_CURRENCY_SOURCES.join(' / ')}）`);
     }
   }
   ```
   `validateCurrencyEntryFeeSkip` 同样把 `gameType` 加入解构并做 `isGameType` 检查。
4. 跑绿 + `pnpm -C packages/protocol test`。
5. 提交：`feat(protocol): currency.apply/entryFeeSkip 可选 gameType（不参与指纹）`。

---

## T2 currency 迁移：DDL / 回填 / 免单表

**Files**
- `packages/currency-service/src/migrations/1797000000000-GameTypeOnOpsDdl.ts`（新增）
- `packages/currency-service/src/migrations/1797000000001-GameTypeOnOpsBackfill.ts`（新增）
- `packages/currency-service/src/migrations/1797000000002-EntryFeeSkipsGameType.ts`（新增）
- `packages/currency-service/test/migration.test.ts`

**实现要点**
- DDL：
  ```sql
  ALTER TABLE `currency_ops`
    ADD COLUMN `game_type` varchar(16) NULL DEFAULT NULL,
    ADD KEY `idx_ops_game_created` (`game_type`, `created_at`);
  -- down
  ALTER TABLE `currency_ops` DROP KEY `idx_ops_game_created`, DROP COLUMN `game_type`;
  ```
- 回填（可重入 keyset）：
  ```ts
  export const OPS_GAME_TYPE_SELECT_BATCH =
    'SELECT `id` FROM `currency_ops` ' +
    "WHERE `game_type` IS NULL AND `source` IN ('game_settle','robot_pool','entry_fee','card_counter') " +
    'AND `id` > ? ORDER BY `id` LIMIT 500';
  // 每批：UPDATE `currency_ops` SET `game_type`='doudizhu'
  //       WHERE `id` IN (?,…) AND `game_type` IS NULL
  // 动态占位符（不依赖驱动数组展开）；down 为 no-op。
  ```
- 免单表：
  ```sql
  ALTER TABLE `currency_entry_fee_skips`
    ADD COLUMN `game_type` varchar(16) NOT NULL DEFAULT 'doudizhu',
    ADD KEY `idx_skips_game_created` (`game_type`, `created_at`);
  -- down
  ALTER TABLE `currency_entry_fee_skips` DROP KEY `idx_skips_game_created`, DROP COLUMN `game_type`;
  ```
- 类名：`GameTypeOnOpsDdl1797000000000` / `GameTypeOnOpsBackfill1797000000001` /
  `EntryFeeSkipsGameType1797000000002`（均不匹配 `/^Currency\d+$/`）。

**TDD**
1. 失败测试（`migration.test.ts` 末尾新增 describe）：
   - 三个类存在且时间戳有序；
   - DDL `up()` 恰 1 条 ALTER（含列+索引），`down()` 恰 1 条（DROP KEY + DROP COLUMN）；
   - 回填 `up()`：假 runner 第一批 SELECT 返回 `[{id: 1}, {id: 2}]`、第二批返回 `[]`；
     断言 UPDATE SQL 含 `IN (?, ?)`、参数 `[1, 2]`；第二次 SELECT 参数 `[2]`；
     `down()` 零语句；
   - 免单表 up/down 各 1 条。
2. 跑红。
3. 实现。
4. 跑绿：`pnpm -C packages/currency-service exec vitest run test/migration.test.ts`。
5. 提交：`feat(currency): game_type 迁移（ops 列+分批回填、免单表列）`。

---

## T3 ApplyService / EntryFeeSkipService 写入

**Files**
- `packages/currency-service/src/apply/apply.service.ts`
- `packages/currency-service/src/skip/entry-fee-skip.service.ts`
- `packages/currency-service/test/apply.test.ts`
- `packages/currency-service/test/entry-fee-skip.test.ts`
- `packages/currency-service/test/helpers/fake-currency-db.ts`

**实现要点**
```ts
// apply.service.ts —— 显式补 import（当前文件没有这三者）：
import { DEFAULT_GAME_TYPE, isGameScopedCurrencySource, type GameType } from '@fight-the-landlord/protocol';

const OPS_INSERT_SQL =
  'INSERT INTO `currency_ops` (`action_id`, `request_hash`, `source`, `game_type`, `actor`, ... ) VALUES (?, ?, ?, ?, ...)';
function storedGameType(source: string, gameType?: GameType): GameType | null {
  return isGameScopedCurrencySource(source) ? (gameType ?? DEFAULT_GAME_TYPE) : null;
}
```
- `applyWithEffect` 的内联 request 类型（`apply.service.ts:252-261`）补 `gameType?: GameType`；
  插入参数在 `source` 后插 `storedGameType(request.source, request.gameType)`。
```ts
// entry-fee-skip.service.ts —— 当前文件没有 DEFAULT_GAME_TYPE/GameType：
import { DEFAULT_GAME_TYPE, type GameType } from '@fight-the-landlord/protocol';

const SKIP_INSERT_SQL =
  'INSERT IGNORE INTO `currency_entry_fee_skips` (`room_code`, `owner_id`, `seat`, `game_type`, `base_score`, ...) VALUES (?, ?, ?, ?, ...)';
// request 内联类型补 gameType?: GameType；值：request.gameType ?? DEFAULT_GAME_TYPE
```
- `fake-currency-db.ts`：
  - `opsInsert` 正则加 `game_type`；`FakeOpRow` 增加 `gameType: string | null`，默认 null；
  - `skipInsertIgnore` 正则加 `game_type`；`FakeSkipRow` 增加 `gameType`。

**TDD**
1. 失败测试：
   - apply：`game_settle` 缺席 ⇒ 库 `gameType='doudizhu'`；`game_settle` + `paodekuai` ⇒ pdk；
     `admin_adjust`/`signup_grant` ⇒ null；`card_counter` 缺席 ⇒ ddz。
   - 同 actionId、同载荷、先 pdk 后 ddz ⇒ 第二次 `replayed:true`，库内 gameType 仍 pdk。
   - skip：PDK 请求落 `gameType='paodekuai'`；缺席落 `doudizhu`；非法值 10001 且零写。
2. 跑红。
3. 实现。
4. 跑绿：apply/entry-fee-skip 两个测试文件。
5. 提交：`feat(currency): apply/skip 写入 game_type（来源归一缺省 doudizhu）`。

---

## T4 room-service 写点接线

**Files**
- `packages/room-service/src/currency/settle.service.ts`
- `packages/room-service/src/currency/robot-funding.ts`
- `packages/room-service/src/rooms/rooms.start.ts`
- 对应测试：`test/currency/settle-outbox.test.ts`、`test/currency/settle-pdk.test.ts`、
  `test/currency/settle-failure.test.ts`（首发 payload 逐字断言，必须更新）、
  `test/rooms.entry-fee.test.ts`、`test/rooms.start.test.ts`、
  `test/currency/robot-funding.test.ts`（精确 `currency.apply` payload 断言，必须更新）。

**实现要点**
- `settle.service.ts` 首发 apply：
  ```ts
  this.currency.apply({ actionId, source: SETTLE_SOURCE, entries, refId, burn, gameType });
  ```
- `resendSettleOutboxEntry`：
  ```ts
  this.currency.apply({
    ...,
    ...(entry.gameType === undefined ? {} : { gameType: entry.gameType }),
  });
  ```
  **旧条目（无 gameType）不得凭空补 ddz**（指纹虽不受影响，但语义保持原样）。
- `robot-funding.ts`：**`applyFunding` 已有 `gameType: GameType` 参数**（勿重复声明）；
  唯一改动是把 `gameType` 放进 `this.currency.apply({...})` 请求；两个调用点无需改签名。
- `rooms.start.ts`：
  - `chargeOne` 的 apply 加 `gameType`；
  - `recordEntryFeeSkip(...)` 的 `entryFeeSkip` 请求加 `gameType`。

**TDD**
1. 失败测试：
   - settle 首发 apply 请求分别断言 `gameType:'doudizhu'` / `'paodekuai'`
     （`settle-failure.test.ts:67-74` 的 `toEqual` 期望要同步）；
   - outbox 条目带 pdk ⇒ 重发请求带 pdk；旧条目无 gameType ⇒ 请求无该键；
   - entry fee apply / skip 请求带对应 gameType；
   - robot funding apply 请求带 gameType（`robot-funding.test.ts` 精确 payload 断言同步）。
2. 跑红。
3. 实现。
4. 跑绿：上述定向测试文件。
5. 提交：`feat(room): 结算/台费/机器人资金写点透传 gameType`。

---

## T5 管理财务读口

**Files**
- `packages/currency-service/src/admin/finance-query.service.ts`
- `packages/currency-service/src/admin/admin-finance.controller.ts`
- `packages/currency-service/test/admin-finance.test.ts`

**实现要点**
- 列表基句加 `o.game_type AS gameType`；`OpsListFilter.gameType?: GameType`；
  `listOps` 条件 `o.game_type = ?`；`AdminOpsRow.gameType`；`toAdminOpsRow` 校验/透传。
- **import 变更**：`finance-query.service.ts` 增加
  `import { isGameType, type GameType } from '@fight-the-landlord/protocol';`（未知非空值响亮抛）；
  `admin-finance.controller.ts` 的 protocol import 增加 `isGameType` 与 `type GameType`。
- 汇总 SQL（`SUMMARY_BY_SOURCE_SQL` / `SUMMARY_BY_DAY_SQL`）改为
  `SELECT ..., o.game_type AS game_type ... GROUP BY ..., o.game_type ORDER BY k, o.game_type`。
- 新增：
  - `SUMMARY_BURN_BY_GAME_SQL`（`FROM currency_ops o ... GROUP BY o.game_type ORDER BY k`）；
  - `SUMMARY_SKIPS_BY_GAME_SQL`（`GROUP BY game_type ORDER BY k`）。
- `SummaryRow.gameType`；`SummaryResult` 增加 `burnByGame` / `entryFeeSkipsByGame`。
- `summary()` 查询次序：
  `group → burn(总数) → skips(总数) → purchases → consumptions → burnByGame → skipsByGame`。
  总数 SQL 的“恰回一行”守卫保持；by-game 允许 0 行。
  一致性校验（不等 ⇒ 抛）：`residue/rake/unrecordedOps` 之和 = burn 总数；
  `cnt/amount` 之和 = skips 总数；`players` **不比较**。
- controller：`OPS_QUERY_KEYS` 加 `gameType`；`parseOpsQuery` 校验 +
  文案 `gameType 非法：须为 doudizhu 或 paodekuai`；CSV：
  - `OPS_CSV_HEADER` 在“来源”后加“玩法”，行用中文标签；
  - `SUMMARY_CSV_HEADER` 在“分组”后加“玩法”，行用中文标签。
  `gameLabelText` 可放在 controller 内的纯函数（CSV 用）；页面侧另有一份同名展示函数。

**TDD（`admin-finance.test.ts`）**
1. 更新独立 SQL 副本（文件顶部 `OPS_BASE` / `SUMMARY_*`），新增两个 by-game 常量；
2. Fake DB：
   - `FakeOp.gameType`（默认 null）；`addOp` 可传；
   - `OPS_PREDICATES` 加 `'o.game_type = ?'`；
   - `materialize` 返回 `gameType`；
   - `summaryBySource/Day` 按 `(k, gameType)` 分组；
   - `exec` 识别两个新 SQL；新增 `summaryBurnByGame` / `summarySkipsByGame`；
   - `addSkip` 增加 `gameType`。
3. 新断言：
   - 列表过滤 7 条件（加 gameType）全 AND；
   - 同一 source 两个 gameType ⇒ 两行，`k` 相同、`gameType` 不同；
   - totals 等于各行之和；
   - burn/skips by-game 与总数关系；`players` 不相等也允许（总数去重）；
   - 空窗 by-game ⇒ `[]`；
   - CSV 表头/行含玩法中文标签；
   - 非法 gameType ⇒ 400 且未碰库。
4. 跑红 → 实现 → 绿：
   `pnpm -C packages/currency-service exec vitest run test/admin-finance.test.ts`。
5. 提交：`feat(currency): 财务读口按玩法筛选/汇总 + burn/漏收按玩法明细`。

---

## T6 管理页财务 UI + 静态闸

**Files**
- `admin/index.html`
- `admin/app.js`
- `scripts/verify-admin-static.mjs`

**实现要点**
- `index.html`：来源筛选后加
  ```html
  <label class="field" for="fin-game-type">
    <span class="field-label">玩法</span>
    <select id="fin-game-type">
      <option value="">全部</option>
      <option value="doudizhu">斗地主</option>
      <option value="paodekuai">跑得快</option>
    </select>
  </label>
  ```
  流水表头“来源”后加 `<th>玩法</th>`。
- `app.js`：
  - `fin.filter` 增加 `gameType: ''`；`financeSearch`/`resetFinControls` 读写；
  - `opsQuery`：`if (filter.gameType) p.set('gameType', filter.gameType);`
  - `buildFinFlowRow`：来源后插 `textCell(gameLabelText(row.gameType))`；
  - 详情 `td.colSpan = 12`；`renderFinDetail` 头部加玩法；
  - 汇总表头 labels 加“玩法”，行插 `gameLabelText(row.gameType)`；空态 `colSpan = 4`；
  - burn/漏收行追加按玩法明细（保留 `销毁：残差 ` / `台费漏收：笔数 ` 前缀）；
  - 新增：
    ```js
    function gameLabelText(g) {
      return g === 'doudizhu' ? '斗地主' : g === 'paodekuai' ? '跑得快' : '—';
    }
    ```
- `verify-admin-static.mjs`：`APP_NEEDLES` 加 `fin-game-type`、`gameLabelText`；
  **index.html 针脚是内联的 `for (const needle of [...])` 数组**（没有 `HTML_NEEDLES` 常量），
  在该数组里加 `fin-game-type`、`玩法`。

**TDD**
1. 先跑现有闸确认基线绿：`node scripts/verify-admin-static.mjs`。
2. 加针脚断言 → 跑红。
3. 实现 UI。
4. 跑绿：`node scripts/verify-admin-static.mjs`。
5. 提交：`feat(admin): 财务页玩法筛选/列/汇总玩法维度`。

---

## T7 user-service PDK 迁移

**Files**
- `packages/user-service/src/migrations/1797000000000-PdkRecordGameTypeDdl.ts`（新增）
- `packages/user-service/src/migrations/1797000000001-PdkRecordPlayerBackfill.ts`（新增）
- `packages/user-service/test/migration.test.ts`

**实现要点**
- DDL：spec §6.5 的两条 ALTER；down 逆序两条。
- 回填：
  ```ts
  export const PDK_BACKFILL_SELECT =
    'SELECT p.id, p.seat, r.winner_seat, r.score_changes ' +
    'FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id ' +
    'WHERE p.id > ? ORDER BY p.id LIMIT 500';
  export const PDK_BACKFILL_UPDATE =
    'UPDATE game_record_players_pdk SET score_change = ?, won = ? WHERE id = ?';
  // ⚠️ jsonOf 是 records.service.ts 的**模块私有**函数，迁移不能 import：
  //     在迁移文件内定义局部 jsonOf（string ⇒ JSON.parse；object ⇒ 原样；畸形 ⇒ []）。
  //     按 seat 找 delta；缺座 ⇒ 0；won = seat === winner_seat ? 1 : 0。
  ```
  循环至空批；down no-op。
- 类名：`PdkRecordGameTypeDdl1797000000000` / `PdkRecordPlayerBackfill1797000000001`
  （不匹配既有 `PdkRecords` 查找）。

**TDD**
1. 失败测试：
   - 两类存在、时间戳有序；
   - DDL up 恰 2 条、down 恰 2 条（逐字）；
   - 回填：第一批 `score_changes` 为 **string**，返回 2 行；第二批为 **object**，返回 1 行；
     第三批空；断言 3 条 UPDATE 的参数（`score_change/won/id`），包括赢家/输家/畸形 JSON 行；
   - 重复执行回填（模拟迁移重跑）仍产生相同 UPDATE（幂等）。
2. 跑红 → 实现 → 绿：
   `pnpm -C packages/user-service exec vitest run test/migration.test.ts`。
3. 提交：`feat(user): PDK 记录 game_type/score_change/won 迁移（DDL+分批回填）`。

---

## T8 PDK 记录写入 + 记录 DTO 读新列

**Files**
- `packages/user-service/src/rpc/record.rpc.controller.ts`
- `packages/user-service/src/records/records.service.ts`
- `packages/user-service/test/record-pdk-write.test.ts`
- `packages/user-service/test/record-pdk-query.test.ts`

**实现要点**
- `persistPdk` 父表 INSERT：
  - 列加 `game_type`（`req.gameType ?? 'paodekuai'`）；
  - 参数顺序调整（`ended_at` 由 params[15] → params[16]）。
- 玩家 INSERT：
  - 列加 `score_change`, `won`；
  - **内联**（仓库无 `scoreDeltaForSeat`）：
    ```ts
    const delta = result.scoreChanges.find((c) => c.seat === seat)?.delta ?? 0;
    const won = seat === result.winnerSeats[0] ? 1 : 0;
    ```
    写入 params。
- `records.service.ts`：
  - `queryPdkPlayers` SELECT 加 `score_change`, `won`；
  - `PdkPlayerRow` 接口加两字段；
  - `toPdkDto` 直接用 `Number(p.score_change)` / `Number(p.won) === 1`（**不得** `Boolean('0')`；
    驱动可能回字符串 `'0'`/`'1'`），不再从 `scoreChanges` 派生。
  测试必须分别喂 `won: 1/0`（number）与 `'1'/'0'`（string）两形态。
  出站 `PdkRecord` 形状不变。

**TDD**
1. 失败测试：
   - write fake：父表 `params[3] === 'paodekuai'`、`ended_at` 新索引；
   - 玩家行 params 中 score_change/won 逐座正确（含 baoben 0 值）；
   - query fake：players 返回新列；DTO 值来自列（可把父 JSON 改成不同值以证明不读 JSON）。
2. 跑红 → 实现 → 绿：两个记录测试文件。
3. 提交：`feat(user): PDK 记录写入/读取玩法与逐座分差胜负列`。

---

## T9 玩家列表/汇总纳入 PDK

**Files**
- `packages/user-service/src/players/admin-players.service.ts`
- `packages/user-service/test/admin-players.test.ts`

**实现要点**
- 抽常量：
  ```ts
  const LAST_ACTIVE_MS_EXPR = `
    CASE WHEN d.last_seen IS NULL AND g.last_game IS NULL AND pg.last_game_ms IS NULL THEN NULL
    ELSE GREATEST(
      COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', d.last_seen) DIV 1000, 0),
      COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', g.last_game) DIV 1000, 0),
      COALESCE(pg.last_game_ms, 0)
    ) END`;
  const PLAYERS_FROM_SQL = `
    FROM users u
    LEFT JOIN (... user_devices ...) d ON ...
    LEFT JOIN (... game_record_players/game_records ddz ...) g ON ...
    LEFT JOIN (
      SELECT p.user_id, MAX(p.ended_at) AS last_game_ms
      FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
      WHERE p.user_id IS NOT NULL AND p.is_robot = 0 AND r.mode IN ('random','gold')
      GROUP BY p.user_id
    ) pg ON pg.user_id = u.id`;
  ```
- 列表：`SELECT ..., ${LAST_ACTIVE_MS_EXPR} AS last_active_ms ...`；
  `lastActiveAt = row.last_active_ms == null ? null : Number(row.last_active_ms)`。
- `buildWhere` activity：`${LAST_ACTIVE_MS_EXPR} >= ?` 绑 `now - N*DAY_MS`；
  inactive 同理；`u.createdAt < ?` 仍绑 Date。
- `enrich`：保留 DDZ；新增 PDK 聚合；合并 games/wins/lastGame。
- `summaryBase`：内层使用 `${LAST_ACTIVE_MS_EXPR} AS last_active_ms`，外层的
  active/inactive 阈值绑 number；`createdAt` 阈值仍 Date。
- **`summaryBase` 参数数组顺序必须按 spec §6.6 表**（Date, Date, number, number, number,
  number, Date, number, Date）。

**TDD（`admin-players.test.ts`）**
1. Fake DB 路由（**顺序即判据**）：
   - `sql.includes('AS new_today')` ⇒ summary fixture（**必须第一**，否则 summaryBase 的
     PDK 子查询会被下面的列表规则抢走）；
   - `sql.includes('SELECT u.id, u.phone')` / `sql.includes('AS last_active_ms')` ⇒ 列表 fixture
     （含 PDK join 的 `last_game_ms`）；
   - `sql.includes('game_record_players_pdk') && sql.includes('COUNT(*) AS games')` ⇒ PDK 聚合 fixture；
   - 最后才走 DDZ 分支（`SUM(p.won)`）；
   - 列表行返回 `last_active_ms` 数字。
2. 新断言：
   - games/wins = DDZ + PDK；
   - `lastActiveAt` = max(device, ddz, pdk)（构造 PDK 更晚）；
   - `summaryBase` 捕获的参数数组中 active/inactive 阈值为 number、createdAt 为 Date；
   - `activity=active7` 的查询参数是 number；
   - PDK-only 用户汇总 active1d/active7d 正确（fake 返回）。
3. 跑红 → 实现 → 绿：`pnpm -C packages/user-service exec vitest run test/admin-players.test.ts`。
4. 提交：`feat(user): 玩家列表/汇总纳入跑得快（lastActive/games/wins）`。

---

## T10 最近对局合并 + 玩家页/探针/文档

**Files**
- `packages/user-service/src/players/admin-players.service.ts`
- `packages/user-service/test/admin-players.test.ts`
- `admin/app.js`
- `scripts/admin-players-probe.mjs`
- `docs/ops/entry-fee-reconcile.md`

**实现要点**
- `recentGames` 返回类型增加 `gameType: 'doudizhu' | 'paodekuai'`，`role: string | null`。
- DDZ 查询加 `'doudizhu' AS game_type`；不加 mode 过滤。
- PDK 查询（不按 mode 过滤）：
  ```sql
  SELECT p.record_id, r.mode, r.base_score, NULL AS role, p.won, p.score_change,
         p.money_delta, p.ended_at
  FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
  WHERE p.user_id = ? AND p.is_robot = 0
  ORDER BY p.ended_at DESC, p.record_id DESC LIMIT ?
  ```
- 合并排序：`endedAt DESC, recordId DESC, gameType`；截断 `limit`。
- `admin/app.js` 最近对局表头加“玩法”，行首 `gameLabelText(g.gameType)`；
  `role` 空显示 `—`（`textCell` 已处理 null）。
- `scripts/admin-players-probe.mjs`：games fixture 增加
  `{ recordId: 8, gameType: 'paodekuai', mode: 'gold', baseScore: 15, role: null, won: true,
     scoreChange: 30, moneyDelta: 30, endedAt: 1761000000001 }`；
  **行级断言**：在详情“最近对局”表格里定位字体文本为 `跑得快` 的 `<tr>`，断言该行第 1 列
  `跑得快`、身份列 `—`（不要只查整个 `pl-detail-body` 文本含 `—`）。
- `docs/ops/entry-fee-reconcile.md`：skips 列清单补 `game_type`，并注明按玩法汇总口径。

**TDD**
1. 失败测试：DDZ+PDK 混合排序（PDK 更晚先出）、`gameType`/`role=null`、
   两表各 limit 后合并截断；probe 断言红。
   **Fake 路由**：`sql.includes('game_record_players_pdk')` 必须**先于**
   `sql.includes('SELECT p.record_id')` 判定，返回 PDK fixture（`role:null`、
   `game_type:'paodekuai'`）；否则两条查询共用 DDZ fixture，PDK 分支假绿。
2. 跑红 → 实现 → 绿：
   - `pnpm -C packages/user-service exec vitest run test/admin-players.test.ts`
   - `node scripts/admin-players-probe.mjs`
3. 提交：`feat(admin): 玩家最近对局合并两玩法 + 探针/运维文档`。

---

## T11 conformance

**Files**
- `tools/conformance/src/lib/pdk-driver.ts`
- `tools/conformance/src/slices/slice-31-pdk-gold.ts`（新增）
- `tools/conformance/src/slices/slice-17-currency.ts`
- `tools/conformance/src/slices/slice-25-entry-fee.ts`
- `tools/conformance/src/run.ts`
- `tools/conformance/baselines.json`

**pdk-driver**
- `startPdkRoom(label, { mode?: 'random'|'gold'; baseScore?; users? })`：
  `room.match` 使用 `mode ?? 'random'`；slice-29 零改动。
- `PdkOutcome` 增加 `settlementVersion: number | null`：
  `playPdkToEnd` 的**两条 return 路径**都写 `settlementVersion: settlementMsg?.version ?? null`
  （`waitFor('game.settlement').catch(() => undefined)` 可能没有消息；不得裸取 `.version`）。
  无 settlement 消息时值为 null，调用方自行处理。

**slice-31**
- 复制/实现：容器 healthy、`purgeGoldQueues`（scan `match:queue:gold:*` + gold meta）、
  `mysqlText/mysqlExec`、`ndjson`、`putConfigAndWaitEffect`（等待 room-service
  `config snapshot applied version=` 日志）、`pollUntil`。
- 前置：快照 + PUT + 等待 + finally 还原四个键：
  `game.paodekuai.enabled=true`、`game.paodekuai.goldRoomEnabled=true`、
  `game.levels.paodekuai`（15 档 10%）、`game.paodekuai.rakePercent=0`。
- **第 0 组**：在任何 apply / 对局之前快照汇总基线
  `summaryBaseline = rows for (game_settle, entry_fee, game_settle/pdk, entry_fee/pdk)`；
  后续增量一律相对该快照。
- 3 个预充用户 + 断言组 1–9（spec §6.7 逐条）；**第 2/4/5/6/7/8 组所有落库/统计断言都必须
  `pollUntil(..., 20_000–30_000)`**，超时消息带最后一次读数：
  1. gold 匹配/开局；
  2. 台费轮询 3 行、-1、pdk、DB action_id；
  3. 唯一注入 op（`actionId/refId/owner` 带 `RUN_TAG`，断言 `replayed=false`）维度；
  4. 真实结算按非零 scoreChanges / 全零无 op（`settlementVersion` 拼 actionId）；
  5. 汇总相对第 0 组基线增量；
  6. skip RPC 的 gameType + byGame（轮询）；
  7. 记录 + DB 逐座精确（轮询 `/api/records/mine`）；
  8. 玩家 `games=1`、`wins` 精确 + `lastActiveAt >= 记录 endedAt` + `active7` 命中（轮询）；
  9. lastActive 三分支（**可执行造数**）：
     - device-only：`mysqlExec("INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) VALUES ('<uid>', 's31-<RUN_TAG>-dev', '2026-10-25 00:00:00.000', '2026-10-25 00:00:00.000')")`；
       断言 `lastActiveAt` 等于该 `last_seen_at` 的 epoch ms；
     - DDZ-only：`mysqlExec` 直插一条最小合法行（列必须全给）：
       ```sql
       INSERT INTO game_records
         (room_code, game_version, mode, base_score, winner, landlord_seat, multiplier, spring,
          landlord_score_change, farmer_score_change, bottom_cards, started_at, ended_at, created_at)
       VALUES ('S31D<tag>', 1, 'random', 15, 'landlord', 0, 1, 'none', 30, -15, '010203',
               '2026-10-25 00:00:00.000', '2026-10-25 00:00:01.000', '2026-10-25 00:00:01.000');
       INSERT INTO game_record_players
         (record_id, seat, user_id, is_robot, robot_id, nickname, role, score_change, won, hand, money_delta, ended_at)
       VALUES (LAST_INSERT_ID(), 0, '<uid>', 0, NULL, 's31', 'landlord', 30, 1,
               '0102030405060708090a0b0c0d0e0f1011', NULL, '2026-10-25 00:00:01.000');
       ```
       断言 `lastActiveAt` 等于 `ended_at`（2026-10-25T00:00:01Z）；
     - PDK：#8 用户断言 `lastActiveAt >= 本局 endedAt`（不要求等号；设备/DDZ 可能更晚）。
- 收尾：还原配置、关闭 socket、队列零残留；主错误优先。

**slice-17 更新**
- `currency_ops` 列串追加 `,game_type:varchar(16)`；
- `migrations_currency` 由 4 → **7** 行，名单追加
  `GameTypeOnOpsDdl1797000000000,GameTypeOnOpsBackfill1797000000001,EntryFeeSkipsGameType1797000000002`；
- 新增 `idx_ops_game_created = (game_type,created_at)` 断言；
- burn 测试可加一条 `SELECT game_type FROM currency_ops WHERE action_id=b1Aid` = doudizhu
  （缺省归一）。

**slice-25 更新**
- `summarySourceDelta` 改 `filter(k===source).reduce(...)`（不要 `find`）；
- C33 skips 行查询加 `game_type`，期望 `insufficient_funds:...:doudizhu`；
- C 组 entry_fee DB 断言可加 `game_type='doudizhu'`。

**run.ts / baselines**
- `CASES` 末尾追加 `slice-31-pdk-gold`；
- `baselines.json.full['slice-31-pdk-gold']` = **所有分支中最小**的 `checks` 条数：
  实施时逐分支数 `checks.*`（全零分支 / 非零分支 / 三分支各算），取最小值；在实施记录列出
  各分支计数。本机无 Docker ⇒ 注明“待权威轮实测校正”。
- slice-17/25 的修改不在本机真栈验证，登记“待权威轮”。

**验证**
```bash
pnpm -C tools/conformance exec tsc --noEmit
node scripts/check-baselines.mjs --self-test
```
提交：`test(conformance): PDK 金币场账本/统计真栈切片 + 旧片同步`。

---

## T12 全量验证 + 实施记录

**步骤**
1. 构建：`pnpm -C packages/protocol build && pnpm -C packages/shared build`。
2. 全量：`pnpm exec turbo run test lint --force`（记录 0 cached；Cached 不算真跑）。
3. 管理端：`node scripts/verify-admin-static.mjs`、`node scripts/admin-players-probe.mjs`、
   `pnpm verify:admin`。
4. conformance：`pnpm -C tools/conformance exec tsc --noEmit`。
5. 工作区：`git status --short` 只应有本次提交；无用户文件改动。
6. 迁移可逆性：本机无 Docker ⇒ **`slice-17` / `slice-25` / `slice-31` 三片与真库迁移
   up/down 全部登记“待权威轮”**；不得声称已跑。slice-17/25 因本片改动过列串/迁移行/
   汇总求和，必须与 slice-31 一起在权威轮重跑。
7. 在计划末尾追加「实施记录」：测试数量/结果、失败与修复、未跑项、分支栈。
8. 提交：`docs(plan): A2/A3 实施记录与验证证据`。

---

## 回归命令清单（每个任务绿后至少跑本包）

```bash
pnpm -C packages/protocol test
pnpm -C packages/currency-service test
pnpm -C packages/room-service test
pnpm -C packages/user-service test
pnpm -C packages/protocol lint
pnpm -C packages/currency-service lint
pnpm -C packages/room-service lint
pnpm -C packages/user-service lint
node scripts/verify-admin-static.mjs
node scripts/admin-players-probe.mjs
pnpm -C tools/conformance exec tsc --noEmit
```

## 风险与止损

- 任一包测试出现 A1 既有失败：先确认是否本片引入（`git stash`/对比 A1 HEAD），不得用“既有失败”掩盖。
- 迁移测试只记录 SQL：真库执行登记待权威轮；实现时避免依赖平台特异函数（已弃 JSON_TABLE）。
- 若 `pnpm exec turbo run test lint --force` 超出本机时间预算，至少跑完全部受影响包 + 管理端 +
  conformance tsc，并在交付报告如实写明未跑范围。

## 计划审查记录

### 第一轮计划对抗审查（2026-10-25）

结论：需修订（9 阻断 / 10 高 / 1 低）。逐条处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| P1 | 迁移拆分与 spec/slice-17 行数疑似不一致 | 复核 spec 已是 3 currency + 2 user、`migrations_currency` 7 行；计划一致。实现前再对照 spec §6.2/§6.5/§10/§11 |
| P2 | T3 缺 import、内联 request 类型未扩展 | 已补显式 import 与类型扩展说明 |
| P3 | T1 未把 gameType 加入校验函数解构 | 已补两处解构 |
| P4 | T7 迁移不能 import 私有 `jsonOf` | 已改为迁移文件内局部 `jsonOf` |
| P5 | T8 引用不存在的 `scoreDeltaForSeat` | 已改为内联 `find` |
| P6 | T4 误称 `applyFunding` 需加参数（实际已有） | 已改为仅透传到 apply 请求 |
| P7 | T4 漏 `settle-failure.test.ts`；robot 测试路径错 | 已补测试清单与正确路径 |
| P8 | slice-31 第 9 组造数 SQL 不完整 | 已给出 `user_devices` / `game_records` / `game_record_players` 全列 INSERT |
| P9 | `settlementMsg.version` 缺 optional chaining、两条返回路径 | 已改 `settlementMsg?.version ?? null`，两条路径都设置 |
| P10 | T9 fake 路由会把 summaryBase 误接列表 fixture | 已写明 `AS new_today` 第一优先 |
| P11 | T10 fake 路由 PDK 查询被 DDZ 抢走 | 已写明按 `game_record_players_pdk` 优先路由 |
| P12 | slice-31 异步断言缺轮询 | 已写明第 2/4/5/6/7/8 组 `pollUntil` 20–30s |
| P13 | `lastActive` 用等号过严 | 已改 `>=` |
| P14 | T5 缺 `isGameType`/`GameType` import | 已补两文件 import 变更 |
| P15 | `Boolean(p.won)` 对字符串 `'0'` 为真 | 已改 `Number(p.won) === 1`，测试两形态 |
| P16 | 汇总基线快照时点未定 | 已加第 0 组“任何 apply/对局之前” |
| P17 | baseline “最小条数”未定义算法 | 已定义“所有分支中最小 checks 数”并记录各分支 |
| P18 | probe 的 `—` 断言过弱 | 已改行级定位“跑得快”行与身份列 |
| P19 | slice-17/25 未登记待权威轮 | 已改 T12 第 6 步 |
| P20 | `HTML_NEEDLES` 不存在 | 已改编辑现有内联数组 |

修订后无待闭合阻断；进入 TDD 实现。

