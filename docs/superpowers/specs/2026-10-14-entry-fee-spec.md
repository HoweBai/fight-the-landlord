# 台费（入场费）—— 规格 v1.1

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-15 |
| 设计层 | `docs/superpowers/specs/2026-10-14-entry-fee-design.md` **v1.2**（三轮评审处置后，`c963c37`）；报告/处置 = `.superpowers/sdd/2026-10-14-entry-fee/`（工作区，不入库） |
| 用户裁决 | 形态 A·台费直收销毁 / 按底分百分比 / 每档一费率 / 只收金币场·机器人免收·门槛不变·种子全 0 暗上线 / **⑤收费次序 = 方案 C（开局成功后收费）** / **⑥收费失败 ⇒ 免单**（不踢人/不取消/不退款）+ **免单逐笔记录与统计** |
| 本文定位 | 把设计 v1.2 展开为**可验证契约**：每条规则/决定都有判据编号（§4 表）落点；任务切分归计划层 |
| 上游真源 | `startRoom`/`startAndAnnounce`（`rooms.start.ts`）· `currency.apply` 唯一写边 · `currencyApplyHash` 指纹 · `game_records(mode='gold')`（对账锚） |

---

## 0. 承接（设计决定 → 判据）

| 设计决定 | 落点 | 判据 |
|---|---|---|
| 用户⑤ 收费位（C 案：`startRoom` 尾部、`ok===true`、gold 门） | §2.3 | C7 |
| D2 单人 op + 余额回写 | §2.3 | C8、C28 |
| D3 幂等（同锚重放去重；一房可多次开局） | §2.3 | C12 |
| D4 重试（首发+≤2、**首尝试载荷快照**重发、并发发起、≈10.3s 界） | §2.3 | C10、C11 |
| D5 该房 fee==0 短路 | §2.1/§2.3 | C5、C9 |
| D6 claim 声明（组队写 / `alive` 段批读筛 / TTL 30s） | §2.5 | C29–C31 |
| §2.4 免单三值 + 14002「视为已收」 + 判别三步 + 幂等写 | §2.4 | C13–C18、C21 |
| 配置第 42 键（校验族 / 种子 / 读取 fail 方向 / 键表） | §2.1 | C1、C2、C4、C5 |
| skip RPC 契约 / 迁移 / 财务汇总（设计 §4-A1/A2） | §2.4b/c/d | C19、C20、C21、C22、C23 |
| 公式 `entryFeeOf`（客户端=服务端同一函数） | §2.1/§2.2 | C3、C6 |
| 客户端 16 键 / 卡面门票 / fail-safe | §2.2 | C6 |
| 报表：source `entry_fee` + 可提现排除 + burn 零回归 | §2.7 | C25、C26 |
| 管理端：五件套 + 漏收块 + 下拉 13 + 针脚 | §2.6 | C24 |
| 零回归面（免费场/好友房/机器人/settle） | §2.3/§2.7 | C26、C27 |
| 对账 runbook | §2.8 | C35 |
| 验收载体（r2-F13 定）：**新开一局**（fee 临时开启后还原，走 slice-25 自有局；**不动** slice-18 既有复算断言） | §5 | C32–C34 |

---

## 1. 改动面一览

**新增文件**

| 文件 | 内容 |
|---|---|
| `packages/currency-service/src/migrations/<ts>-EntryFeeSkips.ts` | `currency_entry_fee_skips` 表（§2.4b） |
| `packages/config-service/src/migrations/<ts>-EntryFeePercentsSeed.ts` | 第 42 键种子（4 行 ×0，§2.1） |
| `tools/conformance/src/slices/slice-25-entry-fee.ts` | 真栈组（§5） |

**修改文件**

| 包 | 文件 | 动作 |
|---|---|---|
| protocol | `src/config.ts` | `CONFIG_KEYS` +1；`CLIENT_CONFIG_KEYS` +1（裸名）；`EntryFeePercent` 类型 + `parseConfigValue` 分支 + `entryFeeOf` |
| protocol | `src/config.test.ts` | 键表 toEqual 更新 + 校验正反例 + 公式金标向量 |
| protocol | `src/currency.ts` | `CURRENCY_SOURCES` 尾追 `entry_fee`（11→12）；`EntryFeeSkip` 类型 + `validateCurrencyEntryFeeSkip` |
| protocol | `src/currency.test.ts` | 源名单/isValid 断言更新 + 校验正反例 |
| protocol | `src/rpc.ts` + `src/messages.test.ts` | `RPC_PATTERNS.currencyEntryFeeSkip` + pattern 逐字名单 18→19（**同一提交**，J21；T3 执行期实证） |
| config-service | 组装点 + `test/client-config.test.ts` / `test/admin.controller.test.ts` / **`test/config.rpc.test.ts`（快照键排序名单）/ `test/helpers/config-probe.ts`（SEED 副本）/ `test/platform-config.service.test.ts`（SEED + `toHaveLength(41)`）** | 16 键链三处 + 41→42 字面（**后三件为计划编写期补漏**——`938cff3`） |
| currency-service | `src/rpc/currency.rpc.controller.ts`（**第三 pattern**）+ skip 服务 + 模块注册 | `RpcResult` 信封 + `{inserted}`（§2.4c） |
| currency-service | `src/admin/finance-query.service.ts` | 第三段 SQL + DTO + `SummaryResult.entryFeeSkips`（**controller 零改动**——直通） |
| currency-service | `test/*` | 假库 SQL 分发（**必改**）+ `db.queries` 精确列表 3 处（`:847-850/:872-875/:915-916`——**必红**）+ 响应全等 4 处（**必红**）＋ `rpc.test.ts` **新增断言面**（既有 :64-80 只读 apply/get 元数据、不会红）＋ `migration.test.ts` **新增第三段 describe**（既有断言不红）＋ `helpers/fake-currency-db.ts` 点位（新 INSERT 正则照 `SQL.opsInsert` 九列钉死先例 + 行表 + 「重复 ⇒ `affectedRows 0`」语义照 `accountInsertIgnore`；未识别 SQL 一律 reject） |
| room-service | `src/rooms/rooms.start.ts` | 收费块（§2.3） |
| room-service | `src/config/config-cache.service.ts` | `entryFeePercents()` reader（§2.1） |
| room-service | `src/match/match.service.ts` | claim 写入（组队）+ `alive` 段批读筛选（§2.5） |
| room-service | `src/currency/currency.client.ts` + `src/metrics/room.metrics.ts` | 新方法（`call()` 带 meta）+ 指标（§2.4a） |
| room-service | `test/*` | `new RoomStartService(...)` **8 处/3 文件**（`rooms.start`/`match.service`/**`rooms.autostart:260`**——构造器 +1 必填注入；`tsc -p tsconfig.test.json` 类型闸含 test/**）＋ `helpers/config-cache.stub.ts` 加 `entryFeePercents` 桩（否则现有金币用例把缺失方法的 TypeError 吞进收费块兜底 catch——「替身太宽容」族）＋ `currency.client` 新方法用例 ＋ `helpers/fake-redis.ts` 扩展（NX/TTL——先扩后写，§2.5）；⚠️ `ws.gateway.test.ts` **不动**（纯 `{startRoom: vi.fn()}` 替身——防照设计 §4-B 对照时被「补回」） |
| client | `src/stores/game.ts` / `src/pages/lobby/lobby.vue` / `test/*` | 16 键链 + 卡面门票 + fail-safe（§2.2）；**6 夹具类型红面** = `lobby-ux / auth-ui-wiring / wallet-entry / table-center / wallet-page / base-score-selection`（另 5 件不红——登记见设计 §4-B，免误改） |
| admin | `app.js` / `index.html` / `scripts/verify-admin-static.mjs` | 五件套 + 下拉 13 + 漏收块 + 针脚（§2.6） |
| conformance | 键数/名单类存量片 + `baselines.json` | 按**设计 §4-B 清单**逐条（14/17/18/20/21/22/23/24 名单、19 下拉三点清单） |
| 监控 | `deploy/monitoring/grafana/dashboards/05-currency.json` | 「台费收/漏」面板（无断言，登记） |

---

## 2. 逐层契约

### 2.1 配置与公式

**a) 键与校验（`packages/protocol/src/config.ts`）**

- `CONFIG_KEYS` **尾追** `'currency.entryFeePercents'`（41→42）；`ConfigKey` 类型自动随动；门禁/断言侧的手工清单见 §2.6；
- `CLIENT_CONFIG_KEYS`（15→16）：**源数组插位 = `'reliefEnabled'` 与 `'entryMultiplier'` 之间**（金币场族邻接；`config.ts:91-108` 数组**非排序序，不得按排序重排**；`protocol/config.test.ts:38-46` 同改）；**排序字面插位 = 6 处**（升序 16 键中恰在 `coinPerYuan`↔`entryMultiplier` 之间——UTF-16 `'c'<'e'`、`'F'<'M'`：`config-service/test/client-config.test.ts:26-42`、`slice-14:503-507`、`slice-18:122-125`、`slice-21:685-688`、`slice-23:737`、`slice-24:155-156`）；
- 类型：`export interface EntryFeePercent { baseScore: number; percent: number }`；
- `parseConfigValue('currency.entryFeePercents', v)` 分支（拒 ⇒ `ProtocolError` 中文原因；**空数组合法**）——拒因分类与文案：

| # | 规则 | 文案 |
|---|---|---|
| E1 | 必须是数组 | `currency.entryFeePercents 必须是数组（收到 <JSON>）` |
| E2 | 每项必须是含 `baseScore`/`percent` 的对象 | `currency.entryFeePercents[<i>] 必须是含 baseScore 与 percent 的对象` |
| E3 | `baseScore` 正整数且**表内唯一** | `baseScore 必须是正整数（收到 <v>）` / `baseScore 不得重复（重复：<v>）` |
| E4 | `percent` **整数** `0..50` | `percent 必须是 0 ≤ n ≤ 50 的整数（收到 <v>）` |

**b) 公式（同文件导出，浏览器安全纯计算）**

```ts
/** 按 baseScore 精确匹配；未命中 ⇒ 0；percent>0 ⇒ max(1, floor(baseScore*percent/100))（=0 无保底）。 */
export function entryFeeOf(baseScore: number, percents: ReadonlyArray<EntryFeePercent>): number
```

算术界：`baseScore ≤ 8191`、`percent ≤ 50` ⇒ 单笔 `≤ 4095`；显式 `Math.floor`。

**c) 种子（config-service 迁移，照 `1795100000000-AdReliefAdpidSeed.ts` 先例）**

值 = `[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]`（4 行 ×0，与档位表同形；**暗上线 = 全 0**）。

**d) room-service 读侧（`config-cache.service.ts`）**

- 新 reader `entryFeePercents(): Array<EntryFeePercent>`——模板照 `entryMultiplier()/rakePercent()` 哨兵模式；
- **fail 方向 = 空表**（快照缺失 / 键缺失 / 形状坏 ⇒ `[]`），**绝不抛**（与 `baseScoreLevels()` 的 fail-closed 相反——依据：收费是收入面，失败必须不收且不回退开局）。

### 2.2 客户端

- `/api/config` 键集 15→16；**缺键/缺行/非数组 ⇒ 归一 `[]`**（= 全不显示；与 `baseScoreLevels`/`rechargePackages` 空表同族）；该字段**不进 null 档**；`reset()` 不清清单尾部注释登记；config-service 手写组装点同兜底方向；
- 金币场档位卡显示「门票 N」= `entryFeeOf(baseScore, entryFeePercents)`——**仅 `percent > 0` 时渲染**；渲染失败/配置异常 ⇒ 不显示、不阻塞入场；门槛显示不变（仍 `底分 × 倍率`）；
- 客户端**不参与收费逻辑**，只显示。

### 2.3 room-service 收费块（核心）

| 项 | 契约 |
|---|---|
| 位置 | `startRoom` 尾部：`startAndAnnounce` 返回 **`true`**（⟺ `game.start` 成功）**之后**；`room.mode === 'gold'`；`startAndAnnounce` 内部**零改动** |
| 短路（D5） | **该房** `fee == 0`（表缺失/形状坏/未命中该房 baseScore/该档 percent=0，任一来源）⇒ 整块跳过：零 apply、零记录、零指标、零新增时延 |
| 逐人 op（D2） | 对 `humanSeats(filled.seats)` 每人一条：`actionId = 'entryfee:<房号>:<ownerId>'`、`source='entry_fee'`、`refId=<房号>`、`entries=[{ownerId, delta:-fee}]`；机器人零 entries、零调用 |
| 重试（D4） | 每笔：**首发 + ≤2 次重试（共 ≤3 次尝试）**、退避 `300ms / 1000ms`、单次 3s 超时；重试 = **首尝试载荷快照**重发（fee/entries 在本次 `startRoom` 调用开头算一次，**不因重试重读配置**）且**同锚** |
| 并发（D4） | 逐人独立、**并发发起**（`Promise.all`；各笔 actionId 互不依赖）；整块最坏 ≈ **10.3s**（单人上界即总上界） |
| 结局分支 | `ok:true`（含 `replayed:true`）⇒ 该人成功；`code=14001` ⇒ 免单（reason=`insufficient_funds`）；`code=14002` ⇒ **视为已收**（响亮日志 + `entry_fee_conflict_total`；不记 skips、不计漏收）；重试耗尽仍无结局（10007/超时族）⇒ 免单（reason=`unknown_outcome`）；其它业务码/异常 ⇒ 免单（reason=`internal_error`） |
| 余额回写（D2） | 成功/重放后：以响应 `entries[].balanceAfter` **HSET `room:{code}:balances`**（seat→值）并补 `EXPIRE ROOM_TTL_SECONDS`（照 `storeGoldBalances` 纪律）；失败 ⇒ warn（显示回落扣前值——设计 §6-9）；**冲突路径不回写**（无回执） |
| 不阻断 | 整块 try/catch：任何异常 ⇒ 只走免单记账，**不改变 `startRoom` 返回值、不影响开局** |

### 2.4 免单记账面

**a) 观测（room-service）**

- 逐笔日志（NDJSON）：`event='entry_fee.skipped'` + `roomCode/ownerId/seat/baseScore/levelName(反查失败省略)/feeAmount/reason/opActionId` + 全链 traceId；
- 指标（`room.metrics.ts`）：`entry_fee_skipped_total{reason}`（**有界标签×3**，值域见下；**绝不含 conflict**）；`entry_fee_conflict_total`（无标签）；
- reason 三值：`insufficient_funds` / `unknown_outcome` / `internal_error`。

**b) 表（currency-service 第三迁移）**

类名 `EntryFeeSkips<ts>`（**不得匹配 `/^Currency\d+$/`**；时间戳 > `1792022400000`）；`up()` 恰一条逐字：

```sql
CREATE TABLE IF NOT EXISTS `currency_entry_fee_skips` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `room_code` varchar(16) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `seat` int NULL,
  `base_score` int NOT NULL,
  `fee_amount` int NOT NULL,
  `reason` varchar(32) NOT NULL,
  `trace_id` varchar(64) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_skips_room_owner` (`room_code`, `owner_id`),
  KEY `idx_skips_created` (`created_at`),
  KEY `idx_skips_room` (`room_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
```

**c) skip RPC（`currency.entryFeeSkip`）**

| 项 | 契约 |
|---|---|
| 形状 | **`RpcResult` 信封**（写边先例 `currency.rpc.controller.ts:49-69`）；请求字段表见下；应答数据 = `{ inserted: boolean }` |
| 请求字段 | `roomCode: string`（**1..16**，形态 = 恰 6 位 `[0-9A-Z]`——照 `record.moneyDelta` 校验前例与列宽先例 `game_records.room_code varchar(16)`）· `ownerId: string`（`OWNER_ID_RE` 1..36）· `seat?: number`（可选整数 **0..2**）· `baseScore: number`（正整数 ≤ 8191）· `feeAmount: number`（正整数 ≤ 1,000,000）· `reason: 'insufficient_funds'\|'unknown_outcome'\|'internal_error'` · `meta?` |
| 校验 | protocol `validateCurrencyEntryFeeSkip` **唯一校验点**（服务层入参取 `unknown` 过门，照 `apply.service.ts:207-229`）；违反 ⇒ `{ok:false, code:10001}` 中文原因 |
| 写入 | `INSERT IGNORE`；`affectedRows` **恰 0/1**（0/1 之外响亮抛——不变量守卫，照 `apply.service.ts:389-397`）⇒ `inserted = (affectedRows === 1)` |
| 发送侧 | room-service `CurrencyClient.entryFeeSkip()`（经 `call()` 自动带 meta——`meta-on-every-rpc-send` 闸）；**单次尝试、不重试** |
| 判别（三步） | `inserted=true` ⇒ inc `entry_fee_skipped_total{reason}` + 逐笔日志；`false`（同房二开重复）⇒ 仅 debug 行、零指标；**RPC 失败（无法判别）⇒ 指标照计 + warn 日志注明「落行失败」** |
| 审计 | 不进管理审计族；不可管理面冲正（reverse 端点限 `admin_adjust`，反证） |

**d) 财务汇总第三段（`finance-query.service.ts`）**

```sql
SELECT COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players, COALESCE(SUM(fee_amount),0) AS amount FROM currency_entry_fee_skips WHERE created_at >= ? AND created_at < ?
```

- 参数 `[new Date(from), new Date(to)]`（与既有两段同窗口）；回值经 `toNumberValue`；零行窗口 ⇒ `0/0/0`；
- `SummaryResult` += `entryFeeSkips: { cnt: number; players: number; amount: number }`；HTTP `data` 形状 = `{ rows, totals, burn, entryFeeSkips }`（**追加**）；
- **次序钉死：先 group、后 burn、后 skips**（测试按 `db.queries` 锚定）；controller **零改动**（直通）；`summary.csv` 列清单不变（多跑一条查询，登记）。

### 2.5 claim 防线（`match.service.ts`）

- **写入**：`startGroup` 组队成形时，对每位成员 `SET match:claim:<playerId> NX EX 30`；**仅金币场**（`mode==='gold'`）；只靠 TTL 过期，不显式释放；
- **筛选**：候选 `alive` 过滤段 **pipeline 批读**（照封禁旗 `readBannedFlags` 先例），持有 claim 者**跳过、不 `cancelQueue`**；
- **测试底座**：先扩 `test/helpers/fake-redis.ts`（`set` 支持 NX、`get/exists` 判 TTL/可注入时钟）与 `match.service.test.ts` 自有 `makeMockRedis`，**再**写判据（替身太宽容 = 对缺陷的容忍度）。

### 2.6 管理端

- 配置中心**五件套**：`admin/app.js` `CONFIG_IA`「经济参数」tab 键数组 +1、`STRUCT_KEYS` 4→5、`STRUCT_META` +1、`buildStructCard` 支持、`CONFIG_NOTES` 新条目（文案含「**改档位表要同步费率表**」）；
- 来源下拉 **12→13** 三点清单：`admin/index.html` 加 `<option value="entry_fee">`；`slice-19:1480-1491` 断言改 13；`verify-admin-static.mjs:101-105` 改 13（并补 `entry_fee` 的 `value=` 存在断言）；
- 财务汇总新增「台费漏收」块（渲染笔数/人数/金额；`cnt>0` 才显式或恒显——计划层钉，静态口径以针脚为准）；
- 静态针脚**加进 `verify-admin-static.mjs`**（app.js + html 两清单，照 burn 先例；slice-19 G12 不强制同步）；
- `verify-admin-static.mjs` **逐点**：`:183 protoSet.size` 41→42；**`:184 iaKeySet.size` 41→42（本轮补点名）**；`:189-194` STRUCT_KEYS 4→5；`:250`「42 = 37 简单 ∪ 5 结构化」；**不变**：`:247 entries.size===37`、`:272-274` 分类合计 10+1+26=37（新键是结构化键）；下拉 `:101-105` 12→13（见上）。

### 2.7 报表与兼容

- `CURRENCY_SOURCES` **尾追** `'entry_fee'`（11→12）；summary 源行 = 收款（无退款面 ⇒ 纯收入）；ops 列表/详情/CSV 自动含；
- 可提现：`WITHDRAWABLE_SOURCES` 恰 6 源**不含** `entry_fee`（自动不可提现；`cap = max(0, min(cap_raw, balance))` 间接收窄）；
- **burn 块零回归**：`SUMMARY_BURN_SQL` 逐字不动；台费 op `burned_*` 两列恒 NULL（协议仅 `game_settle` 可携带 burn）⇒ `unrecordedOps` 徽标不波及；
- **零回归面**：免费场/好友房（`mode!=='gold'`）与机器人零资金调用、零 claim 写；`settle` 面与 `reconcile` 三检查零改动。

### 2.8 对账 runbook（运维）

- 不变式：`game_records(mode='gold')` 的每个真人座位 ⇔ 该 `(room_code, owner_id)` 的 `entry_fee` op（或一条 skips 行）；
- 双向差集 SQL（「有局无费」/「有费无局」——含崩溃窗口与旧版本窗口）落 `docs/ops/`；管理端无 actionId/refId 过滤 ⇒ **按 SQL 手册口径**（照结算先例），skips 明细走 `idx_skips_room`。

---

## 3. 部署与回滚

- **无新增 .env、无手工步骤**：config-service 种子迁移 + currency-service 表迁移随容器启动自动执行（`migrationsRun: true`）；
- **暗上线**：种子全 0 ⇒ 收费块整体短路，行为与今天逐字节一致（C9 判据）；
- **回滚安全**：旧代码忽略第 42 键（快照组装按自身 `CONFIG_KEYS` 名单——实施时核）、不识别新源（已有 `entry_fee` op 行仍可读列表）、新表闲置无害；已收台费不回滚（已收即收，与「开局后不退」同族）；
- 灰度顺序（运营侧）：改费率 = 管理端结构化编辑器写第 42 键（下一轮排期生效面同既有配置纪律）。

---

## 4. 判据表

| # | 判据 | 载体 |
|---|---|---|
| C1 | 第 42 键校验族：E1–E4 正反例各自命中（非数组/项非对象/baseScore 非正整数/重复/percent 非整数/percent −1/51/空数组✓/正常表✓） | protocol 单测 |
| C2 | 键表：`CONFIG_KEYS` 恰 42（尾追）；`CLIENT_CONFIG_KEYS` 恰 16（**源数组插位 = `reliefEnabled`↔`entryMultiplier` 之间、非排序重排**，`config.test.ts:38-46` 同步） | protocol 单测 |
| C3 | `entryFeeOf` 金标向量：未命中⇒0；`(15,10)⇒1`；`(80,5)⇒4`；`(480,12)⇒57`；`percent=0⇒0`（无保底）；`(8191,50)⇒4095`；floor 截断 | protocol 单测 |
| C4 | 种子：迁移 INSERT 逐字（4 行 ×0）；管理面 42 键种子断言（conformance） | config-service 单测 + conformance |
| C5 | 读侧 fail 方向：快照缺失/键缺失/形状坏 ⇒ `[]` **不抛**（反向对照：`baseScoreLevels()` 仍 fail-closed） | room-service 单测 |
| C6 | 客户端：`/api/config` 恰 16 键（排序字面）；缺键归一 `[]`；卡面 `percent>0` 渲染「门票 N」、`=0`/缺失不渲染不阻塞；6 夹具类型面更新 | client 单测 + conformance |
| C7 | 收费位：`ok===true` 且 gold 才收费；`game.start` 失败（strict 两形态）/非金币场 ⇒ **零 apply 调用**（mock 计数） | room-service 单测 |
| C8 | 单人 op 形状：actionId/source/refId/entries 逐字段；三人 ⇒ 三条、机器人零条 | room-service 单测 |
| C9 | 该房 fee==0（未命中/percent=0/形状坏）⇒ 零 apply、零日志、零指标、零 skip RPC | room-service 单测 |
| C10 | 重试：首发+≤2（共≤3 尝试）、退避 300/1000、**同锚同载荷快照**（两尝试之间改配置 ⇒ 载荷不变） | room-service 单测 |
| C11 | 并发：三人**并发发起**（调用序/时刻断言）、整块上界 ≈10.3s（mock 计时） | room-service 单测 |
| C12 | 多次开局：同房二开 ⇒ 同锚 ⇒ 钱只动一次（第二笔 `replayed:true`）；重放路径照常回写余额 | room-service 单测 |
| C13 | 14002：响亮日志 + `entry_fee_conflict_total` +1；**零 skips 行、零 skipped 指标** | room-service 单测 |
| C14 | 14001 ⇒ 免单：无 op（账户分毫不动）；skip RPC 载荷逐字段；reason=`insufficient_funds` | room-service 单测 |
| C15 | `unknown_outcome`（≤2 重试耗尽）与 `internal_error`（其它异常）各一条可判别用例 | room-service 单测 |
| C16 | 判别三步：`inserted=true` ⇒ 指标+日志；`false` ⇒ 仅 debug 零指标；RPC 失败 ⇒ 指标照计 + warn「落行失败」 | room-service 单测 |
| C17 | 幂等：`(room_code, owner_id)` 唯一键 + `INSERT IGNORE`；同房二开同人免单两次 ⇒ 表 **1 行**、指标 **+1** | currency-service 单测 + room-service 单测 |
| C18 | 不阻断：收费块任意异常（apply 抛/skip RPC 抛/回写抛）⇒ `startRoom` 仍返回 true、开局不受影响 | room-service 单测 |
| C19 | skip 协议：字段表正反例（roomCode/ownerId/seat/baseScore/feeAmount/reason 枚举/证据文案）；`RPC_PATTERNS.currencyEntryFeeSkip` 三同提交（J21 闸） | protocol 单测 + 闸试 |
| C20 | 迁移：类名不匹配 `/^Currency\d+$/`、时间戳递增、DDL 逐字（含 ENGINE/CHARSET/COLLATE + 唯一键）；`migration.test.ts` **新增**第三段 describe（既有两段断言不变、不会红） | currency-service 单测 |
| C21 | skip 服务：INSERT IGNORE 落行、`affectedRows` 0/1 判读（0 之外抛）、应答 `{inserted}` | currency-service 单测（假库） |
| C22 | summary：第三段 SQL 逐字；**次序 group→burn→skips**；`db.queries` 精确列表 3 处与响应全等 4 处同步；`entryFeeSkips` 零窗外 `0/0/0`、有行时 cnt/players/amount 正确 | currency-service 单测 |
| C23 | skip RPC **并入既有 `currency.rpc.controller.ts`**（pattern 恰两条 → **恰三条**；`rpc.test.ts` **新增** entryFeeSkip 元数据断言——既有 :64-80 不会红）＋ 服务/模块注册 ＋ J21 三同提交闸（`classed.length ≥ 18` 加第 19 条不红——登记） | currency-service 单测 + 闸试 |
| C24 | 管理端：五件套可用 + 备注在场；下拉恰 13 + `value="entry_fee"`；漏收块渲染；`verify-admin-static.mjs` 针脚与三处计数（42/STRUCT5/分类） | 静态闸 + conformance |
| C25 | 报表：`entry_fee` 源进 summary/ops/CSV；可提现 cap 不含台费（提现口径判据沿用 payment 面） | 真栈（C33 同局）+ payment 面既有判据 |
| C26 | 零回归：burn 块读数逐字节不变；台费 op `burned_*` 恒 NULL；`unrecordedOps` 不因台费变化 | 真栈 + currency-service 单测 |
| C27 | 零回归：`mode!=='gold'`（含好友房/handleJoin 满员微任务路径）零收费、零 claim；机器人零 entries | room-service 单测 |
| C28 | 余额回写：成功后 `room:{code}:balances` 座位值 = `balanceAfter`（含重放路径）；冲突路径不回写；回写失败只 warn | room-service 单测 |
| C29 | claim 写：金币场组队 NX EX 30、免费场零写；**先扩 fake-redis（NX/TTL）再断言** | room-service 单测 |
| C30 | claim 筛：`alive` 段持有者被跳过、**不 cancelQueue**；TTL 过期后放行（可注入时钟） | room-service 单测 |
| C31 | 重叠轮防线登记：真栈/计划层的验证方式（单测为主；真栈不可稳定构造则登记为单测判据） | 计划层钉 |
| C32 | **真栈**（slice-25）：完整金币局（fee 临时开启后还原）⇒ 开局后每人一条 entry_fee op（形状/refId/金额=公式）；余额 = 扣后；summary 源行 = 收款合计 | conformance |
| C33 | **真栈**：构造 14001——**管理端扣减**（入队后、开局前的补位窗口 ≈30–40s 内实施；**调高费率不够**：门槛 ≥ 底分 ≥ 台费恒成立〔设计 §0.1-6〕；提现路径可作备选）⇒ 局照开、skips 行 + 指标/日志、summary 漏收块 +1；该人余额不变 | conformance |
| C34 | **真栈**：同房二开重放与冲突路径（可构造则断言，不可稳定构造 ⇒ 降级为单测判据并在 slice-25 登记理由） | conformance/计划层钉 |
| C35 | 对账 runbook SQL 可跑并给出正确差集（含「有局无费/有费无局」分类） | 人工/脚本（staging） |
| C36 | baselines：相关片计数只增不减、以实跑证据回填；相位红按预登记处置 | `check-baselines` + conformance |

---

## 5. conformance 登记

- **存量片（按设计 §4-B 逐条）**：客户端 16 键链（slice-14/17/18/21/23/24）、管理面 42 键（slice-18/20/22/23/24）、下拉 13（slice-19）、`verify-admin-static` 三处计数；**slice-18 E/F 既有复算断言不动**（本片验收载体 = 新开一局）；
- **新片 `slice-25-entry-fee.ts`（真栈组）**：C32–C34 三态 + 必要的清理/owner 登记（照 `harnessOwners`/RUN_TAG 纪律——**actionId/ownerId 运行期唯一，不得固定字面量**）；
- **费率纪律**：用例「临时开费率 ⇒ 还原」（先例：slice-15:45、slice-13 J22、slice-18 F 的 rakePercent）；还原失败 = 片内硬失败（不得静默留下收费态）；
- **room-service 施工面**：构造器第 8 注入 ⇒ `new RoomStartService(...)` 8 处/3 文件（含 `rooms.autostart.test.ts:260`）与 `helpers/config-cache.stub.ts` 必同改（类型闸含 test/**）；`ws.gateway.test.ts` 不动；
- **假库点位**：`helpers/fake-currency-db.ts` 新 INSERT 正则/行表/「重复 ⇒ 0」语义（§1 已点名）——C17/C21 的落点；
- **客户端夹具**：6 件点名（§1 client 行）、5 件不红（登记）——C6 的落点；
- **baselines.json**：新片入库 + 存量片计数同轮更新（`scripts/check-baselines.mjs` 核对）。

---

## 6. 明确不做 与 窗口登记对照

**明确不做**（= 设计 §0.3）：奖池形态 ❌、免费场/好友房收费 ❌、机器人收费 ❌、退款/对账 outbox/开局互斥锁 ❌（C 案下不存在）、换人/踢人/取消房 ❌（免单取代）、玩家流水页 ❌、**「排队中禁止提现」闸 ❌（登记为将来可选项——若免单率异常再评估）**、管理端免单明细页 ❌（汇总块 + runbook 足够）、动结算算法与 burn 块 ❌。

**窗口登记对照（设计 §6 十一项 → 规格落点）**：

| 设计 §6 | 规格落点 |
|---|---|
| 6-1 崩溃窗口（game.start 成功与收费之间） | §2.8 对账（C35） |
| 6-2 announce 丢包（已收不退） | **仅登记**（服务已发生口径） |
| 6-3 免单记录写入降级 | §2.4c 判别三步（C16） |
| 6-4 game.start 双超时后「会话其实已建」的窄窗 | **仅登记** |
| 6-5 claim 过期边界 | C31 |
| 6-6 提现闸不做 | §6「明确不做」 |
| 6-7 r1-F7 残留凭据面（留档） | **仅登记** |
| 6-8 扫描轮时长 | §2.3 预算（C11） |
| 6-9 余额回写失败 / 进桌首拉竞速 | §2.3 回写行（C28） |
| 6-10 免单不进审计 / 不可冲正 | §2.4c 审计行 |
| 6-11 逐人收费之间崩（部分收取） | §2.8 按人差集（C35） |

---

## 7. 修订记录

- **v1.0**（2026-10-15）：初稿（设计 v1.2 展开；判据 C1–C36）。
- **v1.1**（2026-10-15）：规格评审 r1 十条处置（零阻断）——F1 键插位拆两句钉死（源数组 `reliefEnabled`↔`entryMultiplier` / 6 处排序字面）；F2 删 `CONFIG_KEY_SET`（查无此物）；F3 C33 构造改「管理端扣减」（调高费率构造不出 14001）；F4 必改面补 `rooms.autostart.test.ts` 与 `config-cache.stub.ts`（+ `ws.gateway` 不动备注）；F5 §6 改「明确不做 + 十一项窗口登记对照表」/悬空引用改指设计 §6-9；F6 `room_code varchar(16)` + `seat 0..2`（照先例）；F7 三处「必红」改准（rpc.test 新增面 / migration 新段 / iaKeySet 补点名、分类合计不变）；F8 承接表补 RPC/迁移/汇总行 + C2 并入配置行；F9 夹具 6 件点名 + 5 件不红登记；F10 假库点位点名。
