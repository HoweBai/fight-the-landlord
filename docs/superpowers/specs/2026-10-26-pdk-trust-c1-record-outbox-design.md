# C1 记录链可靠性：`record.write` durable outbox 设计（v4）

> 日期：2026-10-26 · 状态：已按四轮对抗审查修订（v4，进入 plan） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`
> 用户裁决：U1 顺序 / U2 独立 Hash + 复用 sweeper / U3 24h TTL + 单轮 ≤100 条；
> 追加（2026-10-26）：永久丢失采用推荐 A —— 新增 `RecordLost` critical，告警 **35 条 / 32 类**。
> 审查记录见 §10（三轮逐条处置；v4 收口 X1–X7）。

## 1. 背景与问题

对局记录是玩家战绩、风控扫描、资金对账（C2）的共同事实源。当前 `record.write` 是
**单次尝试**：`RecordClient.write` 超时 3s、不重试（`record.client.ts:28-33`）；
`writeGameRecord` 组装后直接 `await record.write`（`ws.gateway.ts:1266`）；失败只由
`finalizeRoomEnd` 的 catch 记 `record_write_failures_total{kind='record'}` + error 日志
（`ws.gateway.ts:1132-1141`），**该局记录永久丢失**。只有结算后的 `record.moneyDelta` 有
outbox，记录本身没有。

后果：user-service 一次抖动/重启/网络闪断就留下永久战绩缺口；C2 会看到「钱已结算、记录不存在」
的孤儿 op，且无法自动修复。接收侧已有 `(room_code, game_version)` 唯一键幂等，重投安全；
缺的是「把没投成功的请求可靠留住并重投」。

真栈现状：`slice-15-records` C9 已停 user-service 打一局并断言「广播照常 + 库无行」，但
**恢复后没有回查该局记录**——C1 补上这段端到端证据。

## 2. 范围

### 2.1 做

1. 新增 `record:outbox` Redis Hash：field=`<roomCode>:<gameVersion>`；value=JSON
   `{ request, createdAt, gameType? }`；旧条目缺 `gameType` ⇒ 按 ddz 解释，请求原样重发。
2. **写前入箱（相对 `record.write`）**：保持现有「先派发 settle、再组装记录」；`prepareRecord`
   组装后 `enqueue`，再尝试 `record.write`；成功 ⇒ 仅当本请求拥有该 field 时 CAS `HDEL`；
   失败 ⇒ 留箱重投。入箱不可用仍直投；conflict（同 field 不同载荷）**不直投**，记永久丢失。
   **settle→enqueue 崩溃窗口保留**，登记给 C2。
3. 扩展 `SettleSweeper`（record 阶段最先、独立预算、硬超时）：
   - record 阶段：一次 HGETALL 快照；全箱分类；坏 JSON/坏结构 ⇒ `corrupt` CAS 删除；
     合法 `createdAt` 超 24h ⇒ `abandoned` CAS 删除；非法/未来 `createdAt` ⇒ CAS 自愈为 now
     （失败仍投递一次，不丢可投请求）；合法条目最老优先，最多 **100** 条，投递预算 **2s**；
     清理最多 **500** 条/轮；record 阶段总硬超时 **5s** + 在途闸；
   - 确定性 10001 ⇒ `rejected` CAS 删除；传输/未知码 ⇒ `failed` 保留；
   - 指标从同一快照算；record 阶段失败/超时被隔离，不阻塞既有 settle/recordmoney 两箱。
4. 新指标（全部带 `game_type`）：`record_outbox_size`、`record_outbox_oldest_seconds`（gauge）、
   `record_outbox_resend_total{result}`（`ok|replayed|failed|abandoned|corrupt|rejected`）。
5. 新告警 **3 条（32 → 35 条，29 → 32 类）**：`RecordOutboxStuck`(warning)、
   `RecordOutboxAbandoned`(critical, 24h)、`RecordLost`(critical, 15m record_lost>0)。
6. 同步全部机械闸与文档：`verify-monitoring.mjs`、`Dockerfile.prometheus`、`slice-16/18/24`
   （32→35）、`docs/ops/first-deploy.md`、`docs/design.md`、`deviation-ledger.md`。
7. 测试：单测全矩阵 + 扩展 `slice-15-records` C9 + 新增 `slice-34-record-outbox`。

### 2.2 不做

- 不改 `RecordClient` 传输语义（3s 单次尝试；重试只在 sweeper）。
- 不改 `record.write` 协议/请求形状/接收侧幂等键。
- 不改 `settle:outbox` / `recordmoney:outbox` 的 TTL（1h）与结构；登记「记录 24h ⇔
  recordmoney 1h」交互（§6、C2 输入）。
- 不新增配置键；不改数据库/协议/admin/看板。
- 不补历史已丢失记录；不重写记录内容；不做人工补录/重放入口。
- 不把 room TTL/形状不符纳入 outbox；保持既有 skip/`record_lost` 指标。
- 不新增 IP/设备字段。
- 不做分布式 sweeper 锁（当前单实例；多实例只保证幂等）。
- **不重排 settle/记录顺序**（不拿结算可用性换记录可靠性）。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 独立 `record:outbox` + 现有 `SettleSweeper`（record 阶段最先、独立预算、硬超时） | 零新定时器；运维口径一致；record 每轮有进展；失败域隔离 | 共用 10s 链；record 阶段最多把 legacy 延后约 5s（可接受） |
| B | 独立 `RecordOutboxSweeper` | 隔离彻底、独立节奏 | 多定时器/关停闸/测试面；A 实测不达标再升级 |
| C | 复用 `settle:outbox` | 少一个箱 | 两套失败语义/TTL/告警互相牵制 |
| D（否决） | `RecordClient` 内部重试 | 改动小 | 崩溃仍丢；不是 durable outbox |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 独立 `record:outbox`，field=`<room>:<version>`，value=`{request,createdAt,gameType}` | 用户裁决 U2；幂等键同形 |
| D2 | **保持 settle 先派发**；记录链写前入箱（enqueue 先于 `record.write`），不重排 settle | 不把「钱有记录无」换成「记录有钱无」；settle→enqueue 窗口登记给 C2 |
| D3 | `enqueue` 用 `HSETNX`，返回 `{status: queued|existing|conflict|unavailable, raw?}`；existing 同 `roomCode/gameVersion/endedAt`，conflict 载荷不同（不覆盖） | N51；不静默覆盖；让调用方知道是否拥有 field |
| D4 | enqueue/ack 不抛；prepare 只对**组装**异常返回 null；enqueue unavailable ⇒ 返回 `{request, unavailable}` 仍直投；**conflict ⇒ 不直投，记 record_lost** | 入箱失败不等于放弃直投；conflict 直投会抢接收侧唯一键、静默丢旧局（X3） |
| D5 | 删除一律 **CAS**：`ACK/DROP` 用快照 raw 值比较后才 `HDEL`；仅 CAS 删除成功（返回 1）才计数 | 防误删快照后新入箱的条目（X2/X1） |
| D6 | sweeper **record 阶段最先**；分类一次 parse；投递最老优先 ≤100 条 + **2s**；清理 ≤500 条/轮；record 阶段总硬超时 **5s** + 在途闸；record 阶段失败/超时隔离 | 防 legacy 积压饿死 record；防挂起拖死循环（N1/X4） |
| D7 | TTL=24h；合法 createdAt 超龄 ⇒ `abandoned` CAS 删除 | 用户裁决 U3 |
| D8 | 坏 JSON/坏结构 ⇒ `corrupt` CAS 删除；非法/未来 createdAt ⇒ **CAS 自愈为 now**（失败仍投递一次，不删可投请求） | 不丢可投请求（X6）；CAS 防覆盖新条目（N6/X2） |
| D9 | 确定性码白名单（当前仅 10001 BadParam）⇒ `rejected` CAS 删除；其他 `RecordClientError`（含未知码）与非 RecordClientError ⇒ `failed` 保留 | 前向兼容（N12） |
| D10 | 多实例：仅 CAS 删除成功才计结果；`failed` 按实例计；日志可能重复；size 用 `max by` | 防计数放大（N8） |
| D11 | 指标 3 个 + 6 值 result；TARGETS +3；`record_write_failures_total` HELP 更新 | A1 纪律 |
| D12 | 告警 3 条：Stuck(warning)、Abandoned(critical,24h)、Lost(critical,15m) | 用户裁决 A；A1 既有告警不改；record_lost 双通知登记 |
| D13 | `record`=首次失败但已入箱；`record_lost`=永久丢失（形状不符/conflict/入箱不可用且直投失败） | 避免误读 |
| D14 | 逐条隔离 + record 阶段整体隔离 | 单条/单阶段异常不扩散 |
| D15 | 无配置键；TTL/100/2s/500/5s/600s 均为常量 | 首版最小面 |
| D16 | 旧条目缺 gameType ⇒ 指标归 ddz，请求原样 | 缺省 ddz |
| D17 | 无 DB 迁移/协议/配置/admin；回滚 = 先 drain 到 HLEN=0，或导出后重新部署新代码重放，再 revert | 旧代码不读该键；直接 DEL 丢记录 |
| D18 | Redis RDB 已知限制；条目含 roomCode/座位 userId/robotId/nickname/result/hand/bottomCards；逻辑 TTL 24h | 隐私口径完整 |
| D19 | 真栈：slice-15 C9 扩展 + slice-34 五态 + slice-16/18/24 计数 35 | 端到端证据 |
| D20 | recordmoney TTL 1h；金币局记录晚到 >1h 的 NULL 归 C2「疑似已知终态/原因未知」，不直接排除；C2 另定义「记录有、op 无」 | 不用年龄掩盖真缺陷 |
| D21 | 10k 条分类/排序 plan 基准；若 >500ms 或拖慢事件循环 ⇒ 升级 B | 2s 只覆盖投递 |
| D22 | 单轮最坏 ≈ record 5s 硬超时 + legacy 既有成本；record 每轮有进展；legacy 节拍仍 10s 量级 | 防节拍塌陷 |

## 5. 实现设计

### 5.1 `RecordOutboxModule` / `RecordOutboxService`

文件：`gateway/record-outbox.service.ts`（新）、`gateway/record-outbox.module.ts`（新）。

```ts
export const RECORD_OUTBOX_KEY = 'record:outbox';
export const RECORD_OUTBOX_TTL_MS = 86_400_000;
export const RECORD_OUTBOX_MAX_PER_SWEEP = 100;
export const RECORD_OUTBOX_DELIVERY_BUDGET_MS = 2_000;
export const RECORD_OUTBOX_PHASE_BUDGET_MS = 5_000;
export const RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP = 500;
export const RECORD_OUTBOX_FUTURE_TOLERANCE_MS = 300_000;

export interface RecordOutboxEntry { request: RecordWriteRequest; createdAt: number; gameType?: GameType; }
export type RecordOutboxEnqueueStatus = 'queued' | 'existing' | 'conflict' | 'unavailable';
export interface RecordOutboxEnqueueResult { status: RecordOutboxEnqueueStatus; raw?: string; }
export type RecordOutboxResult = 'ok' | 'replayed' | 'failed' | 'abandoned' | 'corrupt' | 'rejected';
```

Lua 脚本（**所有删除/自愈都 CAS**）：

```lua
-- CAS_HDEL_RECORD_OUTBOX
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) else return 0 end

-- CAS_HSET_RECORD_OUTBOX
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) else return -1 end
```

模块：`imports:[RedisProviderModule, RpcClientsModule]`、`providers:[RecordOutboxService]`、
`exports:[RecordOutboxService]`。注入 Redis + RecordClient（**值导入**）。

| 方法 | 行为 |
|---|---|
| `enqueue(request): Promise<RecordOutboxEnqueueResult>` | HSETNX 写 `{request,createdAt:now,gameType:normalized}`；1 ⇒ `{queued, raw}`；0 ⇒ HGET：解析失败/结构不合法 ⇒ conflict + ERROR；同 `roomCode/gameVersion/endedAt` ⇒ `{existing, raw}`；不同 ⇒ conflict + ERROR；异常 ⇒ unavailable + ERROR。不抛 |
| `ack(field, raw): Promise<boolean>` | `EVAL(CAS_HDEL, ..., field, raw)`；返回是否删除；异常 ⇒ WARN + false。不抛 |
| `sweep(raw, now): Promise<void>` | 分类/自愈/投递/清理/指标（§5.3） |
| 内部 `resendOne(field, entry, raw): Promise<void>` | `record.write` → 成功 `ack`；CAS 删除成功才计 ok/replayed；10001 ⇒ rejected CAS 删除；其他 ⇒ failed 保留；不抛 |
| 内部 `drop(field, raw, entry, result)` | `ack` CAS 删除；仅删除成功才计数 + ERROR；失败/0 ⇒ WARN |

结构自保：`request` 对象、`roomCode` 非空、`gameVersion` 正整数、`endedAt` 有限正数、
`mode`/`seats`/`result` 存在；否则 corrupt。`createdAt` 合法域 = 有限、>0、≤ now+5min；
否则 CAS 自愈为 now。`gameType` 非法/缺失 ⇒ ddz（仅指标/日志）。

### 5.2 网关集成（`ws.gateway.ts`）——保持 settle 先派发

`WsGateway` 新增第 14 个构造参数 `recordOutbox`（值导入）。`finalizeRoomEnd`：

```text
endedAt = Date.now()
kick nickname hgetall（第一个 await 之前）
botBySeat = await readBotSeatMap
void releaseRobots(...)
room = await roomsService.findOne(roomCode)          // settle 用
void settleService.settle({ roomCode: event.roomCode, version: event.version, result, room, botBySeat })
prepared = await prepareRecord(event, result, botBySeat, nicknames, endedAt)
if (prepared) await deliverRecord(prepared)
```

- `prepareRecord`：自己的 `findOne`（保留记录链二次读）；`!record||!version` 无指标 + WARN；
  room 缺失 ⇒ `recordWriteSkipsTotal{room_ttl}` + WARN；形状不符 ⇒ `record_lost` + WARN；
  通过则组装 + `enqueue`，返回 `{ request, enqueue }`。**组装异常** ⇒ `record_lost` + ERROR + null。
- `deliverRecord`：
  - `enqueue.status === 'conflict'` ⇒ **不直投**；抛 `RecordConflictError`（finalize 计 `record_lost`，
    日志含新旧 endedAt；旧 pending 保留）。
  - `record.write` 成功 ⇒ 仅 status queued/existing 且 `ack(field, raw)` 成功才删除；ack=false 只 WARN；
    日志 written。
  - 失败 ⇒ 抛 `RecordWriteAttemptError(original, owned)`；owned = queued/existing。
- finalize 交付 catch：owned ⇒ `record`；非 owned ⇒ `record_lost`。日志分别含
  `queued for retry (record:outbox)` / `record lost (...)`。
- `enqueue unavailable` 但直投成功：WARN 未 durable；无失败指标。
- settle 与记录互不影响；广播已在 `onGameEvent` 同步发出。
- **settle→enqueue 崩溃窗口**：保留；登记 C2「op 有、记录无」24h 宽限。

### 5.3 sweeper 集成（`settle.sweeper.ts`）

构造 `(redis, settle, recordOutbox)`（第三个值导入）。`sweepOnce(now=Date.now())`：

1. **record 阶段（最先、隔离、硬超时 + 在途闸）**：
   ```ts
   if (!this.recordPhaseInFlight) {
     this.recordPhaseInFlight = true;
     const phase = (async () => {
       const raw = (await this.redis.hgetall(RECORD_OUTBOX_KEY)) ?? {};
       await this.recordOutbox.sweep(raw, now);
     })().catch((err) => this.logger.error(`record outbox sweep failed: ${String(err)}`))
        .finally(() => { this.recordPhaseInFlight = false; });
     await withTimeout(phase, RECORD_OUTBOX_PHASE_BUDGET_MS).catch(() =>
       this.logger.error('record outbox sweep exceeded 5s; legacy continues'),
     );
   } else {
     this.logger.warn('record outbox sweep still in flight; skip this round');
   }
   ```
2. `settle:outbox`（既有）
3. `recordmoney:outbox`（既有）
4. 既有 `refreshOutboxGauges(now)`

record 阶段失败/超时 ⇒ record gauge 保留旧值、legacy 照常；legacy 失败 ⇒ 既有轮级 catch。

`RecordOutboxService.sweep(raw, now)`：

1. **分类（一次 parse）**：
   - 坏 JSON/坏结构 ⇒ corrupt 列表（raw 快照）；
   - `createdAt` 合法且 `now-createdAt > TTL` ⇒ abandoned；
   - `createdAt` 非法/未来超容差 ⇒ **自愈候选**（CAS HSET 为 now；失败仍投递一次；不删除）；
   - 其余 ⇒ 候选。
2. 候选按有效 createdAt 升序，`slice(0,100)`；`deliveryStart=Date.now()`；逐条：
   - `Date.now()-deliveryStart >= 2000` ⇒ 停止；
   - try/catch `resendOne`；失败聚合一条 WARN。
3. **清理**（投递之后）：corrupt/abandoned 逐条 CAS 删除，最多 500 条/轮；超出下轮；
   CAS 删除成功才计数；大批量合并一条 ERROR。
4. **gauge 从同一快照算**：未 CAS 删除的 field 按玩法计 size/oldest（自愈/非法用 now）；
   删除的扣除；两种玩法都写；异常抛给 sweeper（保留旧值）。

### 5.4 指标（`room.metrics.ts`）

`record_outbox_size{game_type}`、`record_outbox_oldest_seconds{game_type}`、
`record_outbox_resend_total{game_type,result}`（6 值）。TARGETS +3；`recordWriteFailuresTotal`
HELP：record=已入箱待重投；record_lost=永久丢失；money_delta=金币列回写失败。

### 5.5 告警与监控静态闸（35 条 / 32 类）

```yaml
- alert: RecordOutboxStuck
  expr: max by (game_type) (record_outbox_oldest_seconds) > 600
  for: 5m
  labels: { severity: warning }
- alert: RecordOutboxAbandoned
  expr: sum by (game_type) (increase(record_outbox_resend_total{result=~"abandoned|corrupt|rejected"}[24h])) > 0
  for: 5m
  labels: { severity: critical }
- alert: RecordLost
  expr: sum by (game_type) (increase(record_write_failures_total{kind="record_lost"}[15m])) > 0
  for: 5m
  labels: { severity: critical }
```

- 头部注释 35/32；`Dockerfile.prometheus` 35；`verify-monitoring.mjs` EXPECTED +3、谓词
  `RecordOutboxStuck:['record_outbox_oldest_seconds','> 600']`、
  `RecordOutboxAbandoned:['result=~"abandoned|corrupt|rejected"','24h']`、
  `RecordLost:['kind="record_lost"','> 0']`；判别力自证。
- `RecordWriteFailuresHigh` 不改（record_lost warning+critical 双通知，登记）。
- conformance slice-16 EXPECTED_RULES 32→35；slice-18:1594、slice-24:706 32→35；
  slice-24 文件头/步骤 31→35；全仓 grep 复扫。
- docs/ops：三个补偿队列 + `record:outbox` 行 + runbook + 3 条告警 + `:1476` 查看命令。
- docs/design.md `:702/:718/:1380` 更新；deviation-ledger N49 关闭（N50 保持）。
- 总 spec §4.2 TARGETS +3；C2 四态见总 spec §5.2。

### 5.6 单测清单

`test/record-outbox.test.ts`（新）：
- enqueue：queued/existing/conflict/unavailable；existing 解析失败 ⇒ conflict；结构缺 endedAt ⇒ corrupt；
  gameType 归一；不抛。
- ack/drop：CAS 成功删除；raw 不匹配/字段不存在 ⇒ 不删；Redis 抛 ⇒ 不抛。
- sweep：ok/replayed（CAS 删除成功才计）；CAS 0 不计（多实例）；传输失败保留+failed；
  BadParam ⇒ rejected+删除；未知 RecordClientError ⇒ failed+保留；非 RecordClientError ⇒ failed+保留；
  坏 JSON/坏结构 ⇒ corrupt；TTL ⇒ abandoned；**sweep 期间并发新 enqueue（createdAt=now+1ms）不被
  误删/corrupt**；**非法 createdAt ⇒ CAS 自愈后仍投递，repair 失败仍投递一次且不删**；
  **快照后同 field 新 enqueue ⇒ 旧 drop/ack CAS 不删新条目**；最老优先；100 截断；2s 预算（可控时钟）；
  单条异常不影响后续；清理 500/轮；gauge 同快照分玩法。
- 10k 分类/排序基准（plan 执行，记录耗时）。

`currency/settle-outbox.test.ts`：第三构造参数；record 阶段先于 legacy；record 阶段慢/失败/超时
（fake sweep 挂起）时 legacy 仍处理；legacy 慢时 record 仍有进展；record HGETALL 失败 ⇒ legacy gauge
仍刷新、record gauge 保留；既有两箱语义/指标/自重排绿。

`ws.gateway.test.ts`：harness 加 recordOutbox；settle 在 record 之前且不受记录失败影响；
deferred enqueue 证明 enqueue 先于 write；payload 一致；queued/existing 成功 ⇒ ack；conflict ⇒ 不直投
+ `record_lost`；unavailable ⇒ 仍直投；write 抛 owned ⇒ `record`；write 抛非 owned ⇒ `record_lost`；
enqueue 抛 ⇒ 仍 write；ack 抛 ⇒ 无失败指标；skip 路径指标逐条。

`record-pdk.test.ts`：第 14 参数；enqueue 收到 `request.gameType='paodekuai'`。
`ws.module.wiring.test.ts`：14 参数；RecordOutboxModule providers/exports/imports；WsModule/
CurrencyModule imports；不编译 WsModule；CurrencyModule/RecordOutboxModule `mod.get` 身份。
`room-metrics-definitions.test.ts` / `metrics-game-type-invariant.test.ts` / `client-message-wiring.gate.test.ts`。

### 5.7 conformance 真栈

**slice-15 C9**：C9② 日志含 `queued for retry (record:outbox)`；保留局 2 与全部既有断言；
新增局 1 回查：`recordsCount(room1)` 轮询 ≤60s=1、`playersCount` 轮询=3、`HKEYS` 轮询到无
`<room1>:` 前缀；baseline 按新增断言静态上调。

**slice-34**：`RUN_TAG` per-run room code；前置 COUNT=0；夹具复制 slice-33 `craftDdzWinningRecord`；
`createdAt=now-1s`（防未来容差边界）。五态：ok / replayed / corrupt / abandoned（now-24h-1）/
rejected（mode:'bogus'）。强判据 = field CAS 消失 + DB records/players；指标增量仅辅助
（`>= before`）。checks 只在轮询后调用一次；baseline 只进 full 列；本机 Docker 不可用 ⇒ 待权威轮。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| enqueue queued/existing + write 成功 | CAS ack；日志 written；箱无残留 |
| enqueue queued/existing + write 失败 | 条目保留；`record`；日志 queued；sweeper 重投 |
| enqueue conflict | **不直投**；旧条目保留；`record_lost` + RecordLost critical + ERROR（新旧 endedAt） |
| enqueue unavailable + write 成功 | WARN 未 durable；无失败指标 |
| enqueue unavailable + write 失败 | 永久丢失；`record_lost` + critical |
| 写成功 ack/CAS 失败 | WARN；条目可能残留（他实例已删/被替换）；不计失败 |
| settle→enqueue 进程崩溃 | 钱可能已动、记录未 durable；C1 不消除；C2 op→record 24h 宽限 |
| 下游宕机/挂起 | record 阶段 2s 投递 + 5s 硬超时 + 在途闸；legacy 照常；record 每轮有进展 |
| 条目 >24h | abandoned CAS 删除（≤500/轮） |
| 坏 JSON/坏结构 | corrupt CAS 删除 |
| 非法/未来 createdAt | CAS 自愈为 now；失败仍投递一次；不删可投请求 |
| 确定性 10001 | rejected；其他码 failed 保留 |
| 多实例 | CAS 删除成功才计数；日志可能重复；size max by |
| Redis 崩溃/丢数据 | RDB 已知限制；per-entry 可能静默丢失 |
| 房间 TTL/形状不符 | 不入箱；既有 skip/record_lost |
| 记录晚到 >1h（金币局） | money_delta NULL；C2「疑似/原因未知」，不直接排除 |
| 约 10k 条积压 | 一次 parse + 最老 100 + 2s；清理 500/轮；plan 基准；>500ms 升级 B |

隐私/容量：条目含 roomCode/gameVersion、userId/robotId/nickname、result、hand/bottomCards；
单条 <2KB；逻辑 TTL 24h；10k 条约 20MB。

## 7. 迁移与回滚

- 无 DB 迁移/配置/协议/admin；Redis 新增 `record:outbox`（不设 Hash TTL）。
- 回滚：优先 drain 到 HLEN=0 再 revert；必须立即回滚时先 HGETALL 导出，恢复时重新部署新版本并
  HSET 回去，等 ok/replayed 且 HLEN=0；未 drain/未导出不得 DEL。
- 前进兼容：旧条目缺 gameType 按 ddz；未来多字段 JSON 解析忽略（形状自保只校验必需键）。

## 8. 测试判据（完成定义）

1. 单测全绿；room-service 全量 + lint 通过。
2. `pnpm exec turbo run test lint --force` 全绿（0 cached）。
3. `verify-monitoring.mjs` 35/32；判别力自证。
4. conformance 静态：slice-16=35 含三条新规则；slice-18/24 32→35；tsc/lint 通过。
5. `pnpm verify:admin` 通过。
6. 真栈：slice-15 C9 扩展 + slice-34 已实现；本机 Docker 不可用 ⇒ 待权威轮。
7. 工作区干净；不碰 PdkSettlement.vue；diff 不含 slice-29/协议/DB/admin。

## 9. 涉及文件

生产：`gateway/record-outbox.service.ts`（新）、`gateway/record-outbox.module.ts`（新）、
`gateway/ws.gateway.ts`、`gateway/ws.module.ts`、`currency/settle.sweeper.ts`、
`currency/currency.module.ts`、`metrics/room.metrics.ts`。

监控/文档：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、`docs/design.md`、`deviation-ledger.md`、总 spec。

测试/conformance：`test/record-outbox.test.ts`（新）、`test/currency/settle-outbox.test.ts`、
`test/ws.gateway.test.ts`、`test/record-pdk.test.ts`、`test/ws.module.wiring.test.ts`、
`test/room-metrics-definitions.test.ts`、`test/metrics-game-type-invariant.test.ts`、
`test/client-message-wiring.gate.test.ts`、`slice-15/16/18/24`、`slice-34`（新）、`run.ts`、
`baselines.json`。

## 10. 审查记录

### 10.1 第一至三轮

- 首轮两路：2 阻断 / 11 高 / 11 低（F1–F14、G1–G16），处置见 v2。
- v2 delta：N1–N13，处置见 v3。

### 10.2 v3 delta（X1–X7）→ v4 处置

| # | 级别 | 发现 | v4 处置 |
|---|---|---|---|
| X1 | 高 | 未来 createdAt 因 sweep 起点 now 被误删 | D8/§5.1：5min 容差；超容差 CAS 自愈；不删可投请求；slice-34 用 now-1s |
| X2 | 高 | corrupt/abandoned/rejected 的裸 HDEL 会删快照后新条目 | D5/§5.1/§5.3：所有删除改 CAS_HDEL(raw)；CAS 成功才计数 |
| X3 | 高 | conflict 直投抢接收侧唯一键、静默丢旧局 | D4/§5.2：conflict 不直投；`record_lost` + RecordLost critical；旧 pending 保留 |
| X4 | 中 | record 阶段清理/分类无预算、挂起无超时 | D6/§5.3：投递 2s、清理 500/轮、阶段 5s 硬超时 + 在途闸；分类 10k 基准 |
| X5 | 中 | 总 spec 残留 2 条告警/三态 | 总 spec §2/§6 改 3 条（35/32）与四态 |
| X6 | 中 | 非法 createdAt 直接 corrupt 会丢可投请求 | D8：CAS 自愈；失败仍投递一次；只有 request 坏才 corrupt |
| X7 | 低 | enqueue existing 解析异常/endedAt 校验未写 | §5.1：解析失败 ⇒ conflict；结构自保含 endedAt；测试 |

### 10.3 进入 plan

v4 已闭合 X1–X7；plan 对抗审查再核对实现可执行性与测试判别力。
