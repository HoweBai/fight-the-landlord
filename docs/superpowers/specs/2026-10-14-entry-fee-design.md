# 台费（入场费）—— 设计 v1.2

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-14 起草 / 2026-10-15 定稿（用户裁决 C 案后） |
| 状态 | v1.0 草案评审 r1 已处置（13 条）→ v1.1 设计评审 r2 已处置（13 条：0🔴/6🟡/7🟢）→ **v1.2 增量复核已处置（4 条：0🔴/2🟡/2🟢，报告 `.superpowers/sdd/2026-10-14-entry-fee/review-design-r2-delta.md`）**；待用户过目 |
| 用户裁决 | ①形态 A·台费直收（销毁）②按底分百分比定价 ③每档一费率 ④暂定默认保留：只收金币场／机器人免收／门槛不变／种子全 0 暗上线 ⑤**收费次序 = 方案 C：开局成功后再收费**（10-15 裁；翻案草案默认「公告前收费」）⑥**收费失败 ⇒ 免单**（不踢人／不取消／不退款），**且免单必须详细记录与统计，便于复盘与追踪**（10-15 裁） |
| 调研对照 | 欢乐斗地主：每人每局、按档位、**不管输赢都收**（与形态 A 一致）；其「开局前先扣」成立前提 = 豆不可提现（排队期无第二消耗渠道）+ 门槛 ≥3× 房费。本轮存量：可提现金币 + 管理端扣减 ⇒ 罕见窗口不可归零，故选 C（对外特征全同，仅内部次序不同，且失败面从「玩家白付」变为「平台白送」）。来源：小米游戏中心两篇（2021）、360/锐派计分规则（2014/15） |
| 上游真源 | `startRoom`/`startAndAnnounce`（`packages/room-service/src/rooms/rooms.start.ts`）· `currency.apply` 唯一写边（`packages/currency-service/src/apply/apply.service.ts`）· `currencyApplyHash` 指纹（`packages/protocol/src/currency.ts`）· 对局记录 `game_records`/`game_record_players`（user-service） |

---

## 0. 背景与目标

### 0.1 现状（评审 r1 实证过的关键事实，含锚点）

1. **开局链**（`rooms.start.ts`）：`startRoom` = waiting 幂等判据(:145) → `fillBots`(:147) → 人类 `match:pending`+`reconnect.touch`(:168-179) → 金币场 `storeGoldBalances`(:191，吞错) → `onSeats` 钩子(:195，匹配侧=退匹配队列；抛⇒false，票留=「不丢人」) → `startAndAnnounce`(:318)：announce（announceFirst）→ `game.start`(:338，内部重试恰 1 次) → `!ok&&strict ⇒ false`(:345) → `updateStatus('playing')`(:349) → 指标(:360) → announce（后置）。`ok===true` ⟺ `game.start` 成功。
2. **一房可被多次开局**：匹配路径（strict:false）之外，满员微任务（`message.router.ts:604-622`，无模式门）与手动房扫描器（`rooms.autostart.ts:133-139`，只认补位死线）都会再调 `startRoom(strict:true)`。⇒ 同一房的收费必须靠**同锚重放**去重，不能假设「一房只开一次」。
3. **apply 语义**（`apply.service.ts`）：单事务；业务拒绝（10001/14001/14002）**整批回滚、`uk_action_id` 不留痕**；撞键 ⇒ 重放判定（同 hash ⇒ 按 flows 重建响应 `replayed:true`；异 hash ⇒ 14002 终态）；14001 报文含 `ownerId=`。调用侧 3s 响应超时（`currency.client.ts`）不撤销服务端事务 ⇒ **「已扣/未扣」存在未知态**。
4. **既有读面**：`SUMMARY_BY_SOURCE_SQL` 按源 GROUP BY（新源自动成行）；`SUMMARY_BURN_SQL` 限 `source='game_settle'`（burn 块不受新源影响）；来源下拉是 `admin/index.html` **硬编码** + 两处「恰 12 项」断言（`slice-19:1480-1491`、`scripts/verify-admin-static.mjs:101-105`）；可离场 6 源集合不含新源 ⇒ 台费自动不可提现。
5. **配置**：`CONFIG_KEYS` 现值恰 41（追加在尾纪律）、客户端子集恰 15；结构化键先例 = `game.baseScoreLevels`（校验族 `config.ts:473-505` + 管理端五件套）。
6. **门槛**（`message.router.ts:490-507`）：仅金币场、仅入队时查 `balance ≥ baseScore × entryMultiplier`，**不回查**（D8 已登记接受窗口）。由 `entryMultiplier ≥ 1` 且 `percent ≤ 50` ⇒ **门槛 ≥ 底分 ≥ 台费**（`baseScore=1` 处取等号——r2-F11 订正；现行档位底分 ≥15，实际余量 ≥2×）⇒ 入队者当时必然付得起台费；「开局时付不起」只能来自排队期余额被降（可提现、管理端扣减——调研对照见上表）。

### 0.2 目标与成功判据

- 金币场每局开局后：每位真人扣一笔台费 ⇒ 销毁（平台收入）；免费场/好友房/机器人零触碰；
- 台费**钱只跟着已开的局走**：局没开成 ⇒ 从无扣款、无退款面（方案 C 的结构性后果）；
- 一切收费失败 ⇒ **免单**，且免单**逐笔可查、可按人按房追踪、可统计**（用户⑥硬要求）；
- 玩家可见面：档位卡显示「门票 N」；余额在开局后扣减（顺序可预期）；
- 存量面零回归：结算算法、burn 块、可提现口径、门槛语义、`currency_flows` 表结构不动。

### 0.3 明确不做（本片边界）

- ❌ 不做奖池形态（B，比赛模式，留将来独立立项）；❌ 免费场/好友房收费；❌ 机器人收费；
- ❌ 不做任何退款/对账 outbox/开局互斥锁（C 案下整层不存在——r1 的 F1/F2/F9 因此消解）；
- ❌ 不做换人/踢人/取消房（r1 的 F3 由「免单」取代）；
- ❌ 不动结算算法与 burn 块；❌ 玩家流水页；
- ❌ **不做「排队中禁止提现」闸**（登记为可选项，见 §6）。

---

## 1. 总览（方案 C 时序）

```
匹配成功 ──[公告/进桌/发牌：既有链原样]──→ game.start 成功
                                              │
                                              ▼
                        startRoom 尾部（gold 且 ok===true）：逐真人的单人 op
                        actionId=entryfee:<房号>:<ownerId>，source=entry_fee，
                        refId=<房号>，entries=[{ownerId, delta=-fee}]
                                              │
                     成功 ⇒ 完；失败 ⇒ 免单（不建 op、不改钱）+ 记账三面
```

canonical 例（休闲场 费率 10%、底分 15 ⇒ 台费 = max(1,⌊15×10/100⌋) = 1；1 真人 + 2 机器人）：

```
currency_ops:   source=entry_fee, ref_id=<房号>, action_id=entryfee:<房号>:<uid>
currency_flows: −1（该真人）
机器人：       零 entries（免收）
销毁：         op 级差额 = 1（burned 两列 NULL——burn 仅 game_settle 可携带，burn 块只算 game_settle，见 §2.8）
```

---

## 2. 逐层设计

### 2.1 配置（第 42 键）

- **键名** `currency.entryFeePercents`，`CONFIG_KEYS` **追加在尾**（41→42）；客户端子集 15→16 **裸名 `entryFeePercents`**（负断言族扫描 `currency.` 前缀须零命中，`client-config.test.ts:100-115`/`slice-18:124-125`）。
- **形状**：`Array<{ baseScore: number; percent: number }>`；校验族照 `parseBaseScoreLevels` 风格但**允许空数组**：
  - 非数组 ⇒ 拒；每项须对象；`baseScore` 正整数且**表内唯一**；`percent` **整数** `0 ≤ n ≤ 50`（与抽水同族——`parseRakePercent` 是整数域，`config.ts:287-295`）；
  - **空数组合法**（语义 = 全 0 = 不收）；
  - **不要求覆盖档位表**（跨键关系写入口无法校验 ⇒ 未命中 ⇒ 0，fail-safe；运营备注与 §2.6 提示承担一致性纪律）。
- **种子** = 4 行 × 0（与档位表同形：休闲 15/标准 80/竞技 480/豪侠 1200 各 `percent:0`），随 config-service 迁移 INSERT（照 `1795100000000-AdReliefAdpidSeed.ts` 先例）。暗上线 = 全 0。
- **读取侧**（room-service `config-cache.service.ts`）：新增 `entryFeePercents(): Array<{baseScore,percent}>`，模板照 `entryMultiplier()/rakePercent()` 哨兵模式（`:177-216`）——快照缺失/形状坏/越界 ⇒ **返回空表（= 全 0）**，绝不抛；与 `baseScoreLevels()` 的 fail-closed 方向相反，依据：收费是收入面，失败方向必须是不收（玩家无害），且不回退开局。

### 2.2 金额公式（服务端权威 = 客户端显示，同一实现）

- 共享纯函数放 `packages/protocol`（浏览器安全，纯计算；照 `currency.ts:7-11` 的零 node 内建纪律）：
  `entryFeeOf(baseScore, percents): number` —— 按 `baseScore` 精确匹配 ⇒ 未命中 ⇒ 0；命中 ⇒ `percent > 0 ? Math.max(1, Math.floor(baseScore * percent / 100)) : 0`。
- 算术界：`baseScore ≤ 8191`（`config.ts:466`）、`percent ≤ 50` ⇒ 单笔 ≤ 4095，双精度内精确；显式 `Math.floor`（照 `settle.service.ts:200` 同族）。远低于 `MAX_ABS_DELTA` 默认 1e6 ⇒ **无需** source 化上限。
- **`percent = 0 ⇒ 0`，且无保底**——`max(1,·)` 仅 `percent>0` 适用（暗上线不产生任何 1 枚误扣）。

### 2.3 收费链路

**D1 · 位置**：`startRoom` 尾部——`startAndAnnounce` 返回 `true`（= game.start 成功）**之后**，且 `room.mode === 'gold'` 时执行。不触碰 `startAndAnnounce` 内部（热路径零回归）；公告/发牌/`playing` 写入都已发生（C 案语义：钱在局后）。

**D2 · 单人 op（对草案「三人一条原子 op」的修订）**：每位真人**一条** op：`actionId = entryfee:<房号>:<ownerId>`、`entries=[{ownerId, delta:-fee}]`、`source='entry_fee'`、`refId=<房号>`。修订理由：
- C 案下「全扣或全不扣」**无语义增益**（没有退款需要与之配对；台费本就是按人的独立费，欢乐斗地主同款）；
- 原子多入口在 14001 时**整批回滚 ⇒ 全房免单**（一个穷玩家放跑一屋人的费）；单人 op 把免单面收窄到只他一人；
- **归因免费**：单人 op 失败即锁定当事人（r1 的 F6「谁不足」识别机制整个消解）；
- 财务面：`refId=<房号>` 使同桌三笔天然可聚合（客服/对账按房号查）；
- **余额展示回写（r2-F2）**：收费成功/重放后，用响应 `entries[].balanceAfter`（契约 `protocol/currency.ts:73-79`）**补写** `room:{code}:balances` 对应座位并补 `EXPIRE`（照 `storeGoldBalances` 纪律）——零新 RPC；补写失败 ⇒ warn（显示回落扣前值，登记 §6）。

**D3 · 幂等与多次开局**：同房第二次开局尝试（满员微任务/扫描器）走**同锚同载荷重放**（`replayed:true`），不二次扣款；载荷只取决于 `(ownerId, fee)` ⇒ 稳定性来自 fee 的确定性，**不需要互斥锁**（C 案下无退款竞态——r1 的 F1 消解）。

**D4 · 重试与结局未知**：**首发 + ≤2 次重试（共 ≤3 次尝试）**、退避 `300ms / 1s`、单次 3s 超时（逐字照结算先例 `settle.service.ts:30-31/:65-66`）。重试 = **首尝试载荷快照重发**（fee 与 entries 在每次 `startRoom` 调用开头算一次、**不随重试重读配置**——r2-F1：把 14002 收窄回「跨调用并发 × 中途改费率」）且**同锚**（传输不确定 ⇒ 重放判定是唯一结局判定手段）。**逐人独立、并发发起**（三笔 actionId 互不依赖；单人最坏 ≈10.3s，三人并发亦 ≈10.3s——r2-F5）。重试耗尽仍无结局 ⇒ **免单**（§2.4，reason=`unknown_outcome`）。**无 outbox**：局已开、局照走，钱的缺口记账可查即可（r1 的 F2/F9 消解于「不退款 + 不跨房重扣」——见 §3 的跨房防线）。

**D5 · 该房 fee==0 短路**（r2-F4 逐字）：**该房** `fee == 0`——来源不限（表缺失 / 形状坏 / 未命中该房 `baseScore` / 该档 `percent=0`）⇒ **整块跳过**：不调 apply、不建 op、不记免单、零指标、无新增时延（暗上线与「部分配置表未覆盖档位」两态都与今天逐字节一致；`delta≠0` 协议闸使「零 delta entry」根本不可行——F10）。

### 2.4 免单与记账（用户⑥硬要求——本节为验收重点）

**触发分类（免单三值；r2-delta-F2 清残留）**：
| reason | 触发 | 归因 |
|---|---|---|
| `insufficient_funds` | 14001（单人 op ⇒ 就是该 ownerId） | 精确到人 |
| `unknown_outcome` | 首发+≤2 重试耗尽仍无结局（10007/超时族） | 精确到人 |
| `internal_error` | 其它异常（校验 10001、驱动不变量等） | 精确到人 |

**14002 不是免单（r2-F1）**：14002 的充要条件 = 同锚已有**成功提交**（`apply.service.ts:432-471`）⇒ 那笔台费**已经收了**。处置 = **视为已收**：响亮日志 + 专用计数 `entry_fee_conflict_total`，**不记 skips 行、不计漏收**（否则用户⑥ 的统计面会系统性出现假漏收）。

**处理**：不建 op、不改任何余额、**不影响开局**（收费块整体 try/catch，任何异常不外抛、不改变 `startRoom` 返回值）。

**记账三面（全部必做）**：
1. **逐笔结构化日志**（NDJSON 九字段 + traceId 全链）：`event='entry_fee.skipped'` + `roomCode/ownerId/seat/baseScore/levelName(反查失败省略)/feeAmount/reason/opActionId`。每笔一行、绝不合并（「详细记录」）。
2. **Prometheus**：`entry_fee_skipped_total{reason}`（有界标签**×3** = 上表三值；**绝不含 conflict**——冲突不是漏收，装进标签域会让面板假漏收回潮，r2-delta-F2）；收款面已有 `currency_apply_total{source='entry_fee'}`。Grafana 新增「台费收/漏」面板（照监控片先例）。
3. **库面（复盘/追踪/管理端可查）**：currency-service 新表 `currency_entry_fee_skips` + 新 RPC `currency.entryFeeSkip`（键↔接收侧同提交，J21 先例）：
   ```sql
   CREATE TABLE IF NOT EXISTS `currency_entry_fee_skips` (
     `id` bigint NOT NULL AUTO_INCREMENT,
     `room_code` varchar(64) NOT NULL,
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
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
   ```
   写入纪律（r2-F6 钉四点）：
- **契约** = `RpcResult` 信封（写边先例 `currency.rpc.controller.ts:49-69`）+ protocol `validateCurrencyEntryFeeSkip` 唯一校验点（服务层入参取 `unknown` 过门，照 `apply.service.ts:207-229`）+ `RPC_PATTERNS.currencyEntryFeeSkip`（键↔接收侧↔模块注册同提交，J21）；**应答数据 = `{ inserted: boolean }`**（本次是否新落行，供记账判别用——r2-delta-F1）；
- **发送** = room-service `CurrencyClient` 新方法（经 `call()` 自动带 meta——`meta-on-every-rpc-send` 闸扫点）；
- **幂等写（并采、双源防重——r2-delta 定稿，非二选一）**：**单次尝试、不重试**（防调用内重发重复）**且** `(room_code, owner_id)` 唯一键 + `INSERT IGNORE`（防同房二开跨调用重复）——二者各防一源、非冗余；
- **记账判别（三步，r2-delta-F1）**：发出侧 = room-service；RPC 应答后按 `inserted` 判别——`true` ⇒ inc `entry_fee_skipped_total` + 逐笔日志；`false`（同房二开重复）⇒ 仅 debug 行、零指标；**RPC 本身失败（无法判别）⇒ 照计指标 + warn 日志并注明「落行失败」**（降级面见 §6-3——宁可多记一笔可解释读数，不漏记）；
- **审计面**：不进管理审计族、不可管理面冲正（reverse 端点限 `admin_adjust`，`admin-finance.controller.ts:428`）；登记即可。
- **best-effort**：任何情况下**不阻断开局、不动钱**；写入失败按上条「照计指标 + warn」处置。**不建账**——审计表，非资金表。
4. **财务汇总页新增「台费漏收」块**（照 burn 块先例，`FinanceQueryService.summary` **第三段** SQL——次序钉死「**先 group、后 burn、后 skips**」、同窗口参数，测试按 `db.queries` 锚定，先例注释 `finance-query.service.ts:330`）：
   `SELECT COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players, COALESCE(SUM(fee_amount),0) AS amount FROM currency_entry_fee_skips WHERE created_at >= ? AND created_at < ?`（半开窗，列序同既有两段；管理端渲染计数+人数+金额）。明细分人分房 = SQL runbook（`idx_skips_room`）＋管理端无 actionId/refId 过滤的既有口径（F2 登记）。

### 2.5 客户端

- `/api/config` 键集 15→16（裸名 `entryFeePercents`；排序插入位 `coinPerYuan` 后 `entryMultiplier` 前——UTF-16 `'F'<'M'`）。
- 金币场档位卡显示「门票 N」= `entryFeeOf(baseScore, percents)`（percent > 0 才渲染）；**fail-safe（r2-F9 钉兜底方向）**：缺键/缺行/非数组 ⇒ 归一为 **`[]`**（= 全不显示；与 `baseScoreLevels`/`rechargePackages` 空表同族）；该字段**不进 null 档**；`reset()` 不清清单尾部注释登记（`game.ts:679-684` 同形）；config-service 手写组装点（`client-config.controller.ts:44-68`）同兜底方向。
- 客户端**不参与收费逻辑**，只显示；**门槛显示不变**（仍 `底分 × 倍率`，台费不并入）。

### 2.6 报表与管理端

- `CURRENCY_SOURCES` **追加在尾** +`'entry_fee'`（11→12）；summary 新源行 = 净收款（本片无退款面 ⇒ 纯收入）；ops 列表/详情/CSV 自动含；可离场 6 源不含 ⇒ 自动不可提现（`withdrawable.service.ts:43-50/:113`）。
- **来源下拉「12→13」三点清单**（r1-F8）：「12」= 「全部」+11 源；`admin/index.html` 手写 `<option>` 加一项 → 13；`slice-19:1480-1491` 断言改 13；`verify-admin-static.mjs:101-105` 改 13（并补 `entry_fee` 的 `value=` 存在断言）。
- 管理端配置中心：结构化编辑器**五件套**（`CONFIG_IA` 经济参数 tab 键数组 +1、`STRUCT_KEYS` 4→5、`STRUCT_META`、`buildStructCard`、`CONFIG_NOTES` 新条目）＋ `CONFIG_NOTES` 运营备注：「**改档位表要同步费率表**」（先例 `admin/app.js:199-204`）。
- 财务视图「台费漏收」块的静态针脚**加进 `verify-admin-static.mjs`**（app.js + html 两清单，照 burn 先例 `fin-burn-line`/「销毁：残差 」——r2-F8：slice-19 G12 **不含** burn 族针脚，是否同步 G12 由规格定，不加也符合先例）。

### 2.7 防「重叠轮跨房重扣」（r1-F5 的收费侧防线）

**风险**：撮合扫描无防重入（`match.service.ts:497-500` 自注「一轮 >5s 时两轮重叠」），桶内快照不复查在队状态 ⇒ 重叠轮可对同一批人再建一间新房；收费侧即**两个房号各扣一次**（不同锚，防重放管不着）。收费块**不延长**该暴露窗（退队在 `onSeats`，早于收费），但费用化把它从「多余房间」升级为「多扣一笔」。

**D6 · 方案**：**组队时玩家维度 in-flight 声明**——`startGroup` 选人成组时对每位成员 `SET match:claim:<playerId> NX EX 30`；撮合候选筛选**跳过持有 claim 的玩家**（本组已带走的人，下轮乃至重叠轮都不可再选）；claim 只靠 TTL 过期（30s）不显式释放（幂等简单）。若 `startRoom` 失败（票留重排），该玩家最多多等 ≤30s 即被 claim 过期放行。
- **落点与形态（r2-F10）**：候选筛选落点在 `alive` 过滤段，**pipeline 批读**（照封禁旗 `readBannedFlags` 先例：只跳过、不 `cancelQueue`）；不在桶内快照 `zrange` 处逐票往返。
- **测试底座（r2-F10）**：先扩 `helpers/fake-redis.ts`（`set` 支持 NX、`get/exists` 判 TTL/可注入时钟）与 `match.service.test.ts` 自有 `makeMockRedis`，**再**写 claim 判据——替身太宽容 = 对缺陷的容忍度（既有纪律）。
- 该声明**独立可测**（不依赖收费）；顺带消解「同一批人两间房」这一**先于本片存在**的既有怪异（登记于 §6，本片只做收费侧必要的这一层）。**保护面精确化（终审 Important-1）**：claim 只保护「**写点之后才做筛选**」的轮次——筛选→写点之间（夹 `randomGreedyPick` 的逐对 `redis.get`）若两轮均已过筛选，仍可双房 ⇒ **跨房重扣残留窗**（毫秒级、需 >5s 慢轮重叠；写侧不复查）。可选加固（选定后建房前复查 EXISTS / 视 NX-null 为止损信号）留交接。
- 边界：claim 键只在金币场撮合路径写（免费场不收费，不引入行为变化）；TTL 与「成型→退队」窗口（通常 <5s）留 6× 余量。

### 2.8 与既有面的相容性（r1 已核，逐条留档）

- **burn 块不动**：`burn` 协议上仅 `game_settle` 可携带（`protocol/currency.ts:235`）⇒ 台费 op 两列恒 NULL；`SUMMARY_BURN_SQL` 限源 ⇒ 不受影响；`unrecordedOps` 徽标同限 ⇒ 不被污染。
- **对账三检查**（`reconcile.service.ts:41-52`）不枚举 source，`balance vs SUM(flows)` 对台费流水天然自洽 ⇒ 零改动。
- **指标标签有界**：`currency_apply_total{source}` 值域 = allowlist + invalid 哨兵 ⇒ 自动。
- **门槛语义不变**：仍是 `底分 × entryMultiplier`、仍只在入队查（D8 窗口登记沿用）；台费是「开局时补一道收款」，不是第二道门槛。
- **机器人**：`humanSeats()` 谓词（`rooms.start.ts:40-42`）复用；机器人零 entries、零调用。
- **好友房/免费场**：`room.mode === 'gold'` 单一门（金币场仅匹配路径产生 ⇒ 不存在「手动开的金币房」）。

---

## 3. 失败矩阵（全路径）

| # | 路径 | 钱 | 处置 |
|---|---|---|---|
| 1 | 局没开成（任何原因：补位失败/凭据写失败/`game.start` 失败/strict 各形态/`updateStatus` 写失败〔异常穿出、留 waiting 供扫描重试、重试时同锚重放兜底〕——r2-F12） | 从未收费 | 无（既有降级链原样；C 案的核心好处） |
| 2 | 局开成，台费 op 成功 | 已收 | 完（重放路径返回 `replayed:true`，同处置） |
| 3 | 局开成，14001 | 未收 | 免单 + 记 `insufficient_funds` |
| 4 | 局开成，14002 | **已收**（该锚必有成功提交——r2-F1） | 视为已收：响亮日志 + `entry_fee_conflict_total`；不记 skips、不计漏收 |
| 5 | 局开成，≤2 重试耗尽无结局 | 未知 | 免单 + 记 `unknown_outcome`（重放判定为唯一结局手段；账实可能在稍后由 ops 面显形） |
| 6 | 局开成，其它异常 | 未收 | 免单 + 记 `internal_error` |
| 7 | `startRoom` 尾部之前进程崩 | 从未收费 | 无（局若已开=白送一局，靠 runbook 对账发现） |
| 8 | `game.start` 成功与逐人收费之间进程崩 | 未收；若崩在两人之间 ⇒ **部分收取**、缺者无 op 无 skip（r2-F12） | 无人受损；按 §5-12 按人差集可查（§6 登记） |
| 9 | 收费成功但玩家客户端没进场（announce 丢包等） | 已收 | **不退**（服务已发生，与「开局后不退」同族；登记 §6） |
| 10 | 同一房第二次开局（微任务/扫描器） | 不重复扣 | 同锚重放⇒`replayed`；异载荷⇒14002 **视为已收**（#4；r2-delta-F2 清残留） |
| 11 | 重叠轮两间房 | 每房各扣一次 | 由 §2.7 的 claim 声明从源头阻断双房（本片建）；残留登记 §6 |

**本片无任何「退款」路径**——这是方案 C 的结构性结论，也是与 r1 三条 🔴 关系的收口：F1（锚+退款竞态）、F2（未知态零扣承诺）、F9（退款持久化）全部消解；F3（换人链）由免单取代；F4（插入位）由 D1 钉死；F5 由 §2.7 处置；F6/F7 随单人 op 与「收费在凭据写块之后」天然消解（被收费者=已在局者）。F8/F10/F11/F12/F13 全部吸收进 §2/§4。

---

## 4. 影响面清单（穷尽；实施后逐条实跑复核）

**A · 新增面**
1. protocol：`CURRENCY_SOURCES` +`entry_fee`（尾）；`entryFeePercents` 校验；`entryFeeOf` 纯函数；`currency.entryFeeSkip` RPC 类型 + 校验 + 键（J21 同提交）；`CONFIG_KEYS` +1、`CLIENT_CONFIG_KEYS` +1；`src/messages.test.ts` pattern 逐字名单 18→19（J21 键的必然同笔件——T3 执行期实证）。
2. currency-service：迁移 `EntryFeeSkips<ts>`（**类名不得匹配 `/^Currency\d+$/`**〔readdir 首匹配抢位，burn 片 F9 同族〕、时间戳 > 1792022400000——r2-F7）；skip RPC 控制器/服务（`RpcResult` 信封 + 假库）；finance summary 第三段 SQL + DTO + controller 透传（次序钉「group→burn→skips」）。
3. room-service：startRoom 收费块（单人 op/并发发起/首尝试快照重试/免单闭环/余额回写）；`config-cache` 新 reader；`match.service` claim 声明 + `alive` 段 pipeline 筛选；`CurrencyClient` 新方法（`call()` 带 meta）；指标常量（skipped×3 + conflict）。
4. admin：`index.html` 下拉 +1、漏收块渲染与针脚；`app.js` 五件套 + CONFIG_NOTES；`verify-admin-static` 下拉 12→13 与 STRUCT/41→42/分类三段。
5. 客户端：config store 字段/类型/`reset` 清单、lobby 档位卡门票行、≥6 个夹具（`lobby-ux / auth-ui-wiring / wallet-entry / table-center / wallet-page / base-score-selection`）。
6. 监控：Grafana 面板「台费收/漏」（`entry_fee_skipped_total`；文件位 `deploy/monitoring/grafana/dashboards/05-currency.json`——r2-G 登记，面板内容无断言）。

**B · 必然改动的既有断言/名单（r1-F12/F13 穷尽吸收）**
- 客户端键 15→16（排序字面量）：`slice-14:498-524`（含 :508-523 值类型断言「两数组」→ 三数组）、`slice-17:1398-1407`、`slice-18:119-122/:975-980`、`slice-21:668-688`、`slice-23:731-741`、`slice-24:153-156/:781-786`、`protocol/config.test.ts:10-47`、`config-service/client-config.test.ts:18-36/:95-119/:143-180`、客户端 store/页面/夹具（见 A5）。
- 管理面 41→42：`slice-18:1011`、`slice-20:142/:721`、`slice-22:854/:1097`、`slice-23:735/:1283`、`slice-24:795`、`config-service/admin.controller.test.ts:169-232`、`verify-admin-static.mjs:183-186/:189-194/:247-250/:254-275`；**计划编写期补漏三件**：`config-service/test/config.rpc.test.ts:141-189`（快照键排序名单）、`test/helpers/config-probe.ts`（SEED 副本）、`test/platform-config.service.test.ts`（自持 SEED + `toHaveLength(41)`）。
- 来源名单：`admin/index.html:243-255`、`slice-19:1480-1491`、`verify-admin-static:101-105`。
- 迁移断言：slice-17 C2 的 `migrations_currency` 行/名断言（burn 片已有两迁移，本片第三迁移 ⇒ 计数断言 +1）；user-service 迁移无关。
- 必改测试：`room-service` 的 `rooms.start.test.ts / rooms.autostart.test.ts / match.service.test.ts / ws.gateway.test.ts`（startRoom 调用序列 mock 面；claim 判据须**先**扩 `test/helpers/fake-redis.ts`（NX/TTL/可注入时钟）与 `match.service.test.ts` 自有替身——r2-F10）。
- **currency-service 必红族（r2-F3）**：`test/admin-finance.test.ts`（假库 SQL 全文分发 `:57-66/:208-210`；`db.queries` 精确列表 `:847-850/:872-875/:915-916`〔后者 `at(-2)/at(-1)` 形态必红〕；响应全等 4 处 `:831-841/:862-869/:885-892/:942-949`）；`test/rpc.test.ts:64-80`（恰两条 pattern——新 RPC 同控制器必改／新控制器则改 `rpc.module.ts` 注册面）；`test/migration.test.ts`（第三迁移形状段 + 抢位断言）。
- 客户端夹具：6 件为类型红面（E 组实读）；另有 5 件（`ads-flow/connection-dead/friend-room-gate/history-records/lobby-modes`）用非类型化 stub、**不会红**（登记，免误改）。
- 发送侧新方法：`room-service` 的 `test/currency.client.test.ts` 扩展（`currency.entryFeeSkip` 经 `call()` 带 meta 的断言——r2-delta-F4；实读既有断言不会红，属新增面）。
- baselines：原位改=不动；新增断言按「只增不减」抬限并以实跑证据回填；slice-18/24 相位红按预登记处置（不得据红下调）。

**C · 参考锚点**（施工只准引代码行，不引注释）：`rooms.start.ts:140/147/168/191/195/318/329/338/344-349/360-363`；`match.service.ts:497-500/1088-1104`；`message.router.ts:471/563-622`；`apply.service.ts:243-295/375-380`；`finance-query.service.ts:53-70`；`verify-admin-static.mjs:101-105`。

---

## 5. 验收判据（粗清单；细则进规格 C 表）

1. 公式：金标向量（含 `percent=0` 无保底、未命中 ⇒ 0、`max(1)` 边界、上限 4095）；客户端=服务端同一函数。
2. 该房 fee==0 短路：**种子态**与**部分配置表未覆盖档位态**两种，整局 runtime **零** apply 调用、零记录、零指标（暗上线等价性；r2-F4）。
3. 收费成功：op 形状逐字段（source/refId/actionId/entries/指纹）；余额与缓存写穿；同桌三人可聚合。
4. 多次开局：同房二开 ⇒ `replayed:true`、钱只动一次。
5. 免单三条 reason（`insufficient_funds`/`unknown_outcome`/`internal_error`）各一条可判别用例：日志（逐笔字段）+ 指标 + skips 行（含 trace）+ summary 块读数；**14002 反例**：同锚异载荷 ⇒ 计 `entry_fee_conflict_total`、**不**入 skips、不计漏收（r2-F1）。
6. 归因：单人 op ⇒ 14001 免单只涉及当事人（同房其余人照收）。
7. 报表：summary 新源行、来源下拉 13、CSV、可提现排除（提现 cap 不含台费）。
8. 客户端：16 键、卡面门票（含 fail-safe 不显示不阻塞）、门槛显示不变。
9. 管理端：编辑器五件套可用、运营备注在场、漏收块渲染。
10. 零回归：burn 块逐字节不动、结算算法零改动、免费场/好友房/机器人零资金调用。
11. 防线：重叠轮二房 ⇒ claim 拦截（同批人不进第二房）；claim 过期后正常再匹配。
12. 对账 runbook：`game_records(mode='gold')` 真人座 × `entry_fee` ops 的双向差集可跑（含 crash 窗口与旧版本窗口的「有局无费/有费无局」分类）。
13. 并发度/预算（r2-F5）：一房三人同时超时 ⇒ 总时延 **≈10.3s 上界**（并发发起）；收费块不改变 `startRoom` 返回值与后续轮排期。
14. 余额回写（r2-F2）：收费后 `room:{code}:balances` = 扣后台费值（含重放路径）；回写失败回落扣前值（登记 §6）。
15. 收费验收载体（r2-F13）：**规格冻结前二选一**——新开一局（临时开费率后还原）或显式并入 slice-18 复算口径（`preBalances` 与 fee 双读数）；「改费率 ⇒ 还原」写入用例纪律。
16. 免单幂等（r2-delta-F1）：同房二开同人两笔免单 ⇒ skips 表 **1 行**、指标 **+1**（非 +2）；skip RPC 失败 ⇒ 指标照 +1 且日志注明「落行失败」。

---

## 6. 已知窗口与登记

1. **崩溃窗口**：`game.start` 成功与收费之间进程崩 ⇒ 白送一局（无 op、无 skip 记录）——靠 §5-12 对账发现，方向对玩家无害。
2. **announce 丢包**：已开局、已收费、玩家未进场 ⇒ 不退（服务已发生口径）。
3. **免单记录写入降级**：currency-service 不可达时 skips 行可能缺（日志+指标仍在）——runbook 对账仍可发现（缺 op 且无需区分）；指标按「无法判别 ⇒ 照计」口径（r2-delta-F1）。
4. **`game.start` 双超时后「会话其实已建」的窄窗**：判失败 ⇒ 不收费 ⇒ 免单性质的白送（重试恰 1 次已把该形态压得很窄）。
5. **重叠轮残留**：claim 30s 过期与非金币路径不设防的边界（免费场无钱可扣，无风险）；**跨房重扣残留窗**＝「两轮均在写点前完成筛选」（毫秒级、需 >5s 慢轮重叠）——见 §2.7 保护面精确化（终审 Important-1）。
6. **「排队中禁止提现」闸**：不建。若将来免单率异常（summary 块与指标可观测），再评估（届时需 payment 读匹配状态的跨服务耦合）。
7. **r1-F7 残留凭据面**：C 案下收费发生在玩家已在局、凭据已消费之后；被踢/替换形态不存在。三清纪律不作本片约束（记录留档备查）。
8. **扫描轮时长**（r2-F5）：收费块在 `startRoom` 内 ⇒ 本桶本轮最坏 ≈10.3s（并发发起下的单人上界）；不改变 `startRoom` 返回值与后续轮排期。
9. **余额回写失败**（r2-F2）：`room:{code}:balances` 回落扣前值（钱面无影响；结算广播后归位）；回写 × 进桌首拉竞速同理——首帧可能显示扣前值、至结算自愈（r2-delta-F3，可接受）。
10. **免单记录不进管理审计、不可管理面冲正**（r2-F6 登记；reverse 端点限 `admin_adjust` 为反证）。
11. **逐人收费之间崩 ⇒ 部分收取**、缺者无 op 无 skip（§3 #8；按人差集可查）。

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-14/15 | 草案（handoff §1）+ r1 评审 13 条处置 + 用户三裁（C／免单／免单记账）合成首版 |
| v1.1 | 2026-10-15 | r2 评审 13 条处置：F1（14002 改「视为已收」+ 首尝试载荷快照重试）、F2（收费后回写余额派生键）、F3（currency-service 必红族入清单）、F4（短路条件改钉「该房 fee==0」）、F5（重试计数/并发/预算钉死）、F6（skip RPC 契约四点 + 幂等写）、F7–F13（迁移类名/DDL 收尾/针脚归属/客户端兜底方向/claim 落点与替身/不等式订正/矩阵微补/验收载体） |
| v1.2 | 2026-10-15 | v1.1 增量复核 4 条处置：F1（记账判别三步 + 契约补应答数据 `{inserted}`）、F2（三处旧表述清理：三值表头/标签×3/§3#10）、F3（回写竞速登记 §6-9）、F4（`currency.client.test.ts` 入 §4-B） |
| v1.3 | 2026-10-15 | 计划编写期补漏（计划 `938cff3`）：§4-B 管理面 41→42 行补 config-service 三件必红（`config.rpc.test.ts` / `helpers/config-probe.ts` / `platform-config.service.test.ts`）；J21「三同提交」下 `RPC_PATTERNS` 键编辑位移到接收侧同笔（计划层已收口，设计文本本无冲突） |
| v1.4 | 2026-10-15 | 计划执行期补漏（T3 实证 `02b152b`）：§4-A1 补 `src/messages.test.ts` pattern 逐字名单 18→19（J21 键的必然同笔件——全仓唯一对 `RPC_PATTERNS` 的全对象 toEqual） |
| v1.5 | 2026-10-15 | 终审处置（opus 全支，Important-1）：§2.7/§6-5 claim 防线**保护面精确化**（只保护「写点之后才做筛选」的轮次；筛选→写点毫秒窗下的跨房重扣残留窗如实登记；可选加固留交接） |
