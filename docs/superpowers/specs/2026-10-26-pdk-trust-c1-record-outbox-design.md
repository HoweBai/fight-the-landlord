# C1 记录链可靠性：`record.write` durable outbox 设计（v3）

> 日期：2026-10-26 · 状态：已按三轮对抗审查修订（v3，待最终 delta 复审） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（C 组总 spec）
> 用户裁决：U1 顺序 / U2 独立 Hash + 复用 sweeper / U3 24h TTL + 单轮 ≤100 条
> 用户追加（2026-10-26）：永久丢失采用推荐 A —— 新增 C1 `RecordLost` critical，告警 **35 条 / 32 类**。
> 审查记录见 §10（三轮：2 阻断 / 11 高 / 11 低 的首轮，v2 delta 的 N1–N13，逐条处置）。

## 1. 背景与问题

对局记录是玩家战绩、风控扫描、资金对账（C2）的共同事实源。当前 `record.write` 是
**单次尝试**：`RecordClient.write` 超时 3s、不重试（`record.client.ts:28-33`）；
`writeGameRecord` 组装后直接 `await record.write`（`ws.gateway.ts:1266`）；失败只由
`finalizeRoomEnd` 的 catch 记 `record_write_failures_total{kind='record'}` + error 日志
（`ws.gateway.ts:1132-1141`），**该局记录永久丢失**。只有结算后的 `record.moneyDelta` 有
outbox（`recordmoney:outbox`），记录本身没有。

后果：user-service 一次抖动/重启/网络闪断就留下永久战绩缺口；C2 上线后这类缺口会表现为
「钱已结算、记录不存在」的孤儿 op，且无法自动修复。接收侧已有
`(room_code, game_version)` 唯一键幂等（ddz `uk_room_version`、pdk `uk_pdk_room_version`），
重投安全；缺的是「把没投成功的请求可靠留住并重投」。

真栈现状：`slice-15-records` C9 已停 user-service 打一局并断言「广播照常 + 库无行」，但
**恢复后没有回查该局记录**——C1 补上这段端到端证据。

## 2. 范围

### 2.1 做

1. 新增 `record:outbox` Redis Hash：field=`<roomCode>:<gameVersion>`；value=JSON
   `{ request: RecordWriteRequest, createdAt: number, gameType?: 'doudizhu'|'paodekuai' }`；
   旧条目缺 `gameType` ⇒ 按 `doudizhu` 解释（指标/日志），请求原样重发。
2. **写前入箱（相对 `record.write`）**：保持现有「先派发 settle、再组装记录」的顺序；
   `prepareRecord` 组装后先 `enqueue`，再尝试 `record.write`；成功 ⇒ 仅当本请求拥有该 field 时
   `HDEL`；失败 ⇒ 留箱重投。入箱失败（Redis 故障/冲突）仍尝试直投；直投失败才算永久丢失。
   **settle→enqueue 之间的进程崩溃窗口保留**（不重排、不新增 durable settle intent），登记给 C2。
3. 扩展 `SettleSweeper` 10s 循环（**record 箱先处理、独立预算**）：
   - record 阶段：一次 HGETALL 快照；全箱分类；坏 JSON/坏结构/非法 `createdAt` ⇒ 批量
     `corrupt` 删除；超 24h ⇒ `abandoned` 删除；合法条目最老优先，最多 **100** 条，投递预算
     **2s（从 record 阶段起点计时）**；逐条隔离；确定性 10001 ⇒ `rejected`；传输/未知 ⇒
     `failed` 保留；指标从同一快照算；
   - 然后跑既有 settle / recordmoney 两箱与既有 gauge；record 阶段失败（读取/异常）被隔离，
     不阻塞既有两箱；既有两箱失败也不影响已完成的 record 阶段。
4. 新指标（全部带 `game_type`）：`record_outbox_size`、`record_outbox_oldest_seconds`（gauge）、
   `record_outbox_resend_total{result}`（counter；`ok|replayed|failed|abandoned|corrupt|rejected`）。
5. 新告警 **3 条（32 → 35 条，29 → 32 类）**：
   - `RecordOutboxStuck`（warning；oldest>600s，for 5m）
   - `RecordOutboxAbandoned`（critical；abandoned/corrupt/rejected 近 24h > 0，for 5m）
   - `RecordLost`（critical；`record_write_failures_total{kind="record_lost"}` 近 15m > 0，for 5m）
6. 同步全部机械闸与文档：`verify-monitoring.mjs`、`Dockerfile.prometheus`、
   `slice-16/18/24`（32→35）、`docs/ops/first-deploy.md`、`docs/design.md`、
   `deviation-ledger.md`（N49 标注被 C1 取代）。
7. 测试：单测全矩阵 + **扩展 `slice-15-records` C9**（恢复后回查局 1）+ 新增
   `slice-34-record-outbox`（sweeper 五态）。

### 2.2 不做

- 不改 `RecordClient` 传输语义（3s 单次尝试；重试只在 sweeper）。
- 不改 `record.write` 协议/请求形状/接收侧幂等键。
- **不改 `settle:outbox` / `recordmoney:outbox` 的 TTL（1h）与结构**；登记「记录 24h ⇔
  recordmoney 1h」的交互（§6、C2 输入）。
- 不新增配置键；不改数据库/协议/admin/看板。
- 不补历史已丢失记录；不重写记录内容；不做人工补录/重放入口。
- 不把 room TTL/形状不符纳入 outbox（没有可重投请求），保持既有 skip/`record_lost` 指标。
- 不新增 IP/设备字段。
- 不做分布式 sweeper 锁（当前单实例；多实例只保证幂等，见 D15）。
- **不重排 finalizeRoomEnd 的 settle/记录顺序**：record 可靠性不以牺牲结算可用性换取。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 独立 `record:outbox` Hash + 现有 `SettleSweeper`（record 阶段前移、独立 2s 预算） | 零新定时器；与现有 outbox 运维口径一致；record 每轮都有进展；失败域隔离 | 与结算补偿共用一条 10s 链；record 阶段最多把既有两箱延后约 5s（可接受） |
| B | 独立 `record:outbox` + 新 `RecordOutboxSweeper` | 隔离彻底、独立节奏 | 多一个定时器/关停闸/测试面；首版收益不足以抵消复杂度；实测 A 不达标再升级 |
| C | 复用 `settle:outbox` | 少一个箱 | 两套失败语义/TTL/告警互相牵制；记录失败可能先于结算 |
| D（否决） | `RecordClient` 内部加重试 | 改动小 | 进程崩溃/重启仍丢；不是 durable outbox |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 独立 `record:outbox`，field=`<room>:<version>`，value=`{request,createdAt,gameType}` | 用户裁决 U2；幂等键与接收侧唯一键同形 |
| D2 | **保持 settle 先派发**；记录链写前入箱（enqueue 先于 `record.write`），不重排 settle | 不把「钱有记录无」换成「记录有钱无」；不把结算可用性耦合到 outbox Redis；settle→enqueue 崩溃窗口登记给 C2 |
| D3 | `enqueue` 用 `HSETNX`，返回 `queued|existing|conflict|unavailable`；已存在且 `roomCode/gameVersion/endedAt` 相同 ⇒ existing；不同 ⇒ conflict（不覆盖） | N51 room code 复用；不静默覆盖旧待投记录；让调用方知道是否拥有该 field |
| D4 | `enqueue`/`ack` 都不抛；`prepareRecord` 只对**组装**异常返回 null；enqueue 失败返回 `{request, queued:'unavailable'}`，**仍直投** | 入箱失败不等于放弃直投；只有直投也失败才计永久丢失 |
| D5 | `record.write` 返回 true/false 都算成功；**仅当 queued 为 queued/existing 且 ack 拥有 field 时**才 `HDEL`；conflict/unavailable 不 ack | 防 ack 误删别人的待投条目（N1/N7） |
| D6 | sweeper **record 阶段最先**，独立 2s 预算（从 record 起点计），单轮最多 100 条；全箱清理 corrupt/abandoned 不受 100 上限；指标从同一快照算；record 阶段失败隔离，不阻塞既有两箱 | 防 legacy 积压饿死 record（N1/N3）；避免 100×3s 拖慢；只 parse 一次 |
| D7 | TTL=24h；超龄 ⇒ `abandoned` + 删除 + ERROR | 用户裁决 U3；记录是 C2 审计源 |
| D8 | 坏 JSON/坏结构/非法或未来 `createdAt` ⇒ `corrupt` + 删除 + ERROR（**不再 HSET 自愈**） | 避免自愈覆盖新条目/复活已 ack 条目（N6/N10）；元数据坏即坏条目 |
| D9 | **白名单确定性码**（当前仅 `BadParam` 10001）⇒ 立即 `rejected` + 删除；其他 `RecordClientError`（含未知码）与非 RecordClientError ⇒ `failed` + 保留 | 前向兼容：未来接收侧新增可重试码不被误丢（N12）；与既有 settle 10001 终态纪律一致 |
| D10 | 多实例：只把 `HDEL` 返回 >0 的条目计入 `ok/replayed/abandoned/corrupt/rejected`；`failed` 仍按实例计；日志可能重复；size 用 `max by` | 防实例数放大计数（N8）；当前单实例部署 |
| D11 | 指标：3 个新指标 + 6 值 result；源码闸 TARGETS +3；`record_write_failures_total` HELP 更新（record=已入箱待重投；record_lost=永久丢失） | 与 A1 指标纪律一致 |
| D12 | 告警 3 条：Stuck(warning)、Abandoned(critical, 24h)、Lost(critical, 15m record_lost>0) | 用户裁决 A；永久丢失 critical；A1 既有 `RecordWriteFailuresHigh` 不改，record_lost 会有 warning+critical 双通知（可接受，critical 是升级） |
| D13 | `record_write_failures_total`：`record`=首次失败但已入箱；`record_lost`=永久丢失（形状不符 / 入箱冲突或不可用且直投失败）；HELP/告警/ops 同步 | 避免把「已入箱待重投」误读成丢记录 |
| D14 | 逐条隔离：sweeper 每条 try/catch；`prepare`/`deliver` 各自 try/catch；record 阶段整体失败隔离 | 单条/单阶段异常不中断其他 |
| D15 | 无配置键；TTL/100/2s/600s 均为常量 | 首版最小面；调参走发版 |
| D16 | 旧条目缺 `gameType` ⇒ 指标归 ddz，请求原样 | 旧条目缺省 ddz |
| D17 | 无 DB 迁移/协议/配置/admin；回滚 = 先 drain 到 HLEN=0，或导出后重新部署新代码重放，再 revert | 旧代码不读该键；直接 DEL 会丢待投记录 |
| D18 | Redis RDB 是已知限制；条目含 roomCode/座位 userId/robotId/nickname/result/hand/bottomCards；逻辑 TTL 24h（非法 createdAt 直接 corrupt，不无限保留） | room-service 无 DB 连接；隐私口径完整 |
| D19 | 真栈：扩展 slice-15 C9 + 新增 slice-34（五态）+ slice-16/18/24 计数 35 | C9 已有停服/恢复基础设施；slice-34 覆盖 sweeper 终态 |
| D20 | `recordmoney:outbox` TTL 保持 1h；金币局记录晚到 >1h 时 `money_delta` 永久 NULL；C2 把它归「疑似已知终态/原因未知」单独报告，**不直接排除金额不一致**；C2 同时定义「记录有、settle op 无」反向孤儿 | 不用年龄掩盖真实 NULL 缺陷；反向窗口显式交给 C2 |
| D21 | 10k 条分类/排序在 plan 中做基准；若单轮 >500ms 或实测拖慢事件循环，升级方案 B（独立 sweeper） | 2s 预算只覆盖投递；分类成本要可测 |
| D22 | 单轮最坏 ≈ record 2s + 一次在途 3s + 既有两箱既有成本；record 阶段不超过 ~5s；既有两箱的补偿节拍仍为 10s 量级（legacy 自身成本不变） | 防节拍塌陷；实测不达标升级 B |

## 5. 实现设计

### 5.1 `RecordOutboxModule` / `RecordOutboxService`

文件：`packages/room-service/src/gateway/record-outbox.service.ts`（新）、
`packages/room-service/src/gateway/record-outbox.module.ts`（新）。

```ts
export const RECORD_OUTBOX_KEY = 'record:outbox';
export const RECORD_OUTBOX_TTL_MS = 86_400_000;
export const RECORD_OUTBOX_MAX_PER_SWEEP = 100;
export const RECORD_OUTBOX_SWEEP_BUDGET_MS = 2_000;

export interface RecordOutboxEntry {
  request: RecordWriteRequest;
  createdAt: number;
  gameType?: GameType;
}

export type RecordOutboxEnqueue = 'queued' | 'existing' | 'conflict' | 'unavailable';
export type RecordOutboxResult =
  | 'ok' | 'replayed' | 'failed' | 'abandoned' | 'corrupt' | 'rejected';

export function recordOutboxField(
  request: Pick<RecordWriteRequest, 'roomCode' | 'gameVersion'>,
): string;
```

**确认删除脚本**（ack 只删自己的 field，防误删旧/新条目）：

```lua
-- ACK_RECORD_OUTBOX_LUA
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local ok, e = pcall(cjson.decode, v)
if not ok or type(e) ~= 'table' or type(e.request) ~= 'table' then return 0 end
if tostring(e.request.roomCode) ~= ARGV[2] or tostring(e.request.gameVersion) ~= ARGV[3]
   or tostring(e.request.endedAt) ~= ARGV[4] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
```

模块元数据：`imports: [RedisProviderModule, RpcClientsModule]`、
`providers: [RecordOutboxService]`、`exports: [RecordOutboxService]`。`RecordOutboxService`
注入 `Redis`、`RecordClient`（**值导入**）。

| 方法 | 行为 |
|---|---|
| `enqueue(request): Promise<RecordOutboxEnqueue>` | `HSETNX` 写 `{request,createdAt:now,gameType:normalizeGameType(request.gameType)}`；1 ⇒ queued；0 ⇒ HGET 比较 `roomCode/gameVersion/endedAt`：同 ⇒ existing，异 ⇒ conflict + ERROR；异常 ⇒ unavailable + ERROR。**不抛** |
| `ack(request): Promise<boolean>` | `EVAL(ACK_RECORD_OUTBOX_LUA, 1, KEY, field, roomCode, gameVersion, endedAt)`；返回是否成功删除；异常 ⇒ WARN + false，**不抛** |
| `sweep(raw, now): Promise<void>` | 全箱分类/清理/投递/指标（§5.3） |
| 内部 `resendOne(field, entry, now): Promise<void>` | `record.write` → 成功 `ack` 并仅在 HDEL>0 时计 `ok/replayed`；确定性 10001 ⇒ `rejected`；其他 ⇒ `failed` 保留；不抛 |
| 内部 `drop(field, entry, result)` | `HDEL`；仅 HDEL>0 时计数 + ERROR；HDEL 失败/0 ⇒ WARN |

结构自保：`request` 对象、`roomCode` 非空 string、`gameVersion` 正整数、`mode`/`seats`/`result`
存在；不合法 ⇒ corrupt；`createdAt` 非有限/≤0/>now ⇒ corrupt（D8）；`gameType` 非法/缺失 ⇒
ddz（仅指标/日志，请求不改）。

### 5.2 网关集成（`ws.gateway.ts`）——保持 settle 先派发

`WsGateway` 新增第 14 个构造参数 `recordOutbox: RecordOutboxService`（**值导入**）。
`finalizeRoomEnd` **保持现有顺序**，只把记录内部拆成 prepare/deliver：

```text
endedAt = Date.now()
kick nickname hgetall（第一个 await 之前）
botBySeat = await readBotSeatMap
void releaseRobots(...)
room = await roomsService.findOne(roomCode)          // settle 用（既有）
void settleService.settle({
  roomCode: event.roomCode, version: event.version, result,
  room, botBySeat,
})                                                    // 既有完整实参，不得 ...room
prepared = await prepareRecord(event, result, botBySeat, nicknames, endedAt)
if (prepared) await deliverRecord(prepared)
```

- `prepareRecord`：**自己的 `roomsService.findOne`**（保持记录链的二次读；读失败按 room TTL
  `recordWriteSkipsTotal{reason:'room_ttl'}` + WARN，与现状一致）；跳过判据 `!record || !version`
  （无指标 + WARN）与形状不符（`record_lost` + WARN）保持现状；通过则组装、`enqueue`、返回
  `{ request, enqueue }`。**组装异常** ⇒ `record_lost` + ERROR + 返回 null；**enqueue 异常/冲突/
  不可用** ⇒ 返回 `{ request, enqueue:'unavailable'|'conflict' }`，继续直投。
- `deliverRecord`：
  - `record.write` 成功 ⇒ 仅 `enqueue==='queued'|'existing'` 时 `ack`；conflict/unavailable 不 ack
    （避免删旧/别人的条目）；ack=false 只 WARN。日志 `Record written ... written=`。
  - `record.write` 失败 ⇒ 抛 `RecordWriteAttemptError(original, owned)`；`owned = queued|existing`。
- `finalizeRoomEnd` 交付 catch：
  - owned ⇒ `record_write_failures_total{kind='record'}`；日志 `... — queued for retry (record:outbox): <原因>`；
  - 非 owned ⇒ `kind='record_lost'`；日志 `... — record lost (outbox unavailable/conflict): <原因>`。
- `enqueue='unavailable'` 但直投成功：WARN「未 durable」；无失败指标。
- settle 失败/记录失败互不影响；广播已在 `onGameEvent` 同步发出。

**settle→enqueue 崩溃窗口**：settle 已派发、prepare 尚未 enqueue 时进程崩溃 ⇒ 钱可能已动、记录未入箱。
本片**不消除**该窗口（durable settle intent 超出 C1），登记给 C2 的「op 有、记录无」检测（24h 宽限）。
反向窗口（记录有、op 无）不再由 C1 引入（因为不重排）。

### 5.3 sweeper 集成（`settle.sweeper.ts`）

构造参数 `(redis, settle, recordOutbox)`（第三个**值导入**）。`sweepOnce(now = Date.now())`：

1. **record 阶段（隔离）**：
   ```ts
   try {
     const raw = (await this.redis.hgetall(RECORD_OUTBOX_KEY)) ?? {};
     await this.recordOutbox.sweep(raw, now);
   } catch (err) {
     this.logger.error(`record outbox sweep failed: ${String(err)}`); // 不阻塞 legacy
   }
   ```
2. `settle:outbox`（既有）
3. `recordmoney:outbox`（既有）
4. 既有 `refreshOutboxGauges(now)`（既有两箱 gauge）

record 阶段失败 ⇒ record gauge 保留旧值、legacy 照常；legacy 失败 ⇒ 既有的轮级 catch +
下轮自重排（record 已处理）。

`RecordOutboxService.sweep(raw, now)`：

1. **全箱分类（一次 parse）**：
   - 坏 JSON/坏结构/非法 createdAt ⇒ `corrupt`；
   - 合法 createdAt 且 `now-createdAt > TTL` ⇒ `abandoned`；
   - 其余 ⇒ 候选。
2. `corrupt`/`abandoned` 逐 field `HDEL`（HDEL>0 才计数），大批量合并一条 ERROR 摘要。
3. 候选按 createdAt 升序，`slice(0,100)`；`deliveryStart=Date.now()`；逐条：
   - `Date.now()-deliveryStart >= 2000` ⇒ 停止（剩余下轮）；
   - try/catch `resendOne`；失败聚合一条 WARN。
4. gauge 从同一快照算：未成功删除的 field 按玩法计 size/oldest；成功删除的扣除；两种玩法都写；
   parse/分类异常 ⇒ 抛给 sweeper（record gauge 保留旧值）。

### 5.4 指标（`room.metrics.ts`）

```ts
record_outbox_size{game_type}          // gauge
record_outbox_oldest_seconds{game_type} // gauge
record_outbox_resend_total{game_type,result} // ok|replayed|failed|abandoned|corrupt|rejected
```

`TARGETS` +3；`recordWriteFailuresTotal` HELP：
`record` = 已 durable 入箱待重投；`record_lost` = 永久丢失（形状不符/入箱冲突或不可用且直投失败）；
`money_delta` = 金币列回写失败。

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

- 头部注释 35 条 / 32 类；`Dockerfile.prometheus` 35。
- `verify-monitoring.mjs`：EXPECTED +3；头注释断言 35/32；新增谓词
  `RecordOutboxStuck:['record_outbox_oldest_seconds','> 600']`、
  `RecordOutboxAbandoned:['result=~"abandoned|corrupt|rejected"','24h']`、
  `RecordLost:['kind="record_lost"','> 0']`；判别力自证（删一条/改计数 ⇒ 红）。
- `RecordWriteFailuresHigh` **不改**（A1 原样；record_lost 会有 warning+critical 双通知，登记）。
- conformance：`slice-16-monitoring.ts` EXPECTED_RULES 32→35 + 注释；`slice-18-gold-room.ts:1594`
  32→35；`slice-24-ads-relief.ts:706` 32→35（文件头/步骤的 31 同步 35）；全仓 grep 复扫。
- `docs/ops/first-deploy.md`：「两个补偿队列」→「三个」；outbox 表加 `record:outbox`；runbook
  加 24h/10s/2s/三条告警；`:1284` 告警清单加 3 条；`:1476` 查看命令加 `record:outbox`。
- `docs/design.md`：`:702/:718/:1380` 改为「失败先入 record:outbox（24h 重投）；永久丢失仅剩
  形状不符/outbox 冲突或不可用」。
- `deviation-ledger.md`：N49 追加「C1 起由 record:outbox 收敛（24h），N49 关闭」；N50 保持。
- 总 spec §4.2 TARGETS +3（已改）；C2/C3 输入见 §6/D20。

### 5.6 单测清单

新增 `packages/room-service/test/record-outbox.test.ts`：

- `enqueue`：queued；existing（同 endedAt）；conflict（不同 endedAt，不覆盖 + ERROR）；
  unavailable（Redis 抛，不抛）；gameType 归一；**enqueue 异常后网关仍直投**（gateway 用例）；
- `ack`：EVAL 成功删除；载荷不匹配/字段不存在 ⇒ false 且不删；Redis 抛 ⇒ false 不抛；
- `sweep`：ok/replayed（HDEL>0 计）；HDEL=0 不计（多实例）；传输失败保留+failed；
  BadParam ⇒ rejected+删除；未知 `RecordClientError` ⇒ failed+保留；非 RecordClientError ⇒ failed+保留；
  坏 JSON/坏结构/非法 createdAt ⇒ corrupt；TTL ⇒ abandoned；>100 超龄全清（不受上限）；
  最老优先；100 截断；2s 预算（可控时钟，**从 record 阶段起点**）；单条异常不影响后续；
  gauge 同快照分玩法、两种玩法都写、删除项扣除、未删坏条目归 ddz+WARN；同一快照二次 sweep 的
  语义（允许重复投递/HDEL=0 不计，测试只断言不抛、不重复计数）。
- 10k 条分类/排序基准（plan 中执行，记录耗时；不做硬时限断言）。

`currency/settle-outbox.test.ts`：第三构造参数；record 阶段先于 legacy；record 阶段慢/失败时
legacy 仍处理（fake `recordOutbox.sweep` 抛错/延迟）；legacy 慢（fake apply 3s）时 record 仍每轮
有进展；record HGETALL 失败 ⇒ legacy gauge 仍刷新、record gauge 保留；既有两箱语义/指标/自重排绿。

`ws.gateway.test.ts`：harness 加 `recordOutbox` 替身；**settle 在 record 之前/不受记录失败影响**；
enqueue 在 write 之前（deferred 证明 await）；payload 一致；成功且 owned ⇒ ack；conflict/unavailable
⇒ ack 零调用；write 抛 owned ⇒ `kind='record'`；write 抛非 owned ⇒ `kind='record_lost'`；
enqueue 抛 ⇒ 仍 write；写成功 ack 抛 ⇒ 无失败指标；skip 路径指标逐条（`!record||!version` 无指标、
room TTL `recordWriteSkipsTotal`、形状不符 `record_lost`）。

`record-pdk.test.ts`：构造第 14 参数；断言 enqueue 收到的 `request.gameType='paodekuai'`。

`ws.module.wiring.test.ts`：14 参数；`RecordOutboxModule` providers/exports/imports；
`WsModule.imports` 与 `CurrencyModule.imports` 含 `RecordOutboxModule`；**不编译 WsModule**
（真 Redis），改为模块元数据 + `CurrencyModule`/`RecordOutboxModule` 的 `mod.get(RecordOutboxService)`
身份断言。

`room-metrics-definitions.test.ts`：3 指标；`metrics-game-type-invariant.test.ts` TARGETS+3；
`client-message-wiring.gate.test.ts` metrics 桩补 3 导出。

### 5.7 conformance 真栈

#### 5.7.1 扩展 `slice-15-records` C9

- C9② 日志加强：同时含 `queued for retry (record:outbox)`；
- C9③ 保留既有局 2 与全部字段断言；**新增**局 1 回查：`recordsCount(room1)` 轮询 ≤60s 变 1、
  `playersCountByRecordId(recordIdOf(room1))` 轮询 = 3、`HKEYS record:outbox` 轮询到无 `<room1>:`
  前缀（field 消失与 HDEL 有竞态，必须轮询）；
- `baselines.json` slice-15-records 按新增断言数上调（不写死；plan 中静态分解）。

#### 5.7.2 新增 `slice-34-record-outbox`

`run.ts` 注册 + `baselines.json` **只进 full 列**（不加 render 步骤）。`RUN_TAG` per-run room code；
前置 `COUNT(*)=0`；夹具复制 slice-33 `craftDdzWinningRecord`（3 座、人类 userId、hand 34 hex、
bottomCards 6 hex、result 完整）。

1. 有效条目 ⇒ ok：HSET `record:outbox`，`createdAt=now`；轮询 field 消失、DB records=1/players=3；
   `result="ok"` 增量仅作辅助（`>= before`，不要求恰 +1）。
2. 同 field 重投 ⇒ replayed：同 payload 再 HSET；轮询 field 消失、记录仍 1/玩家 3；replayed 辅助。
3. 坏 JSON ⇒ corrupt：field 消失 + corrupt 增量。
4. TTL 超龄 ⇒ abandoned：另一 room + `createdAt=now-24h-1`；field 消失、该 room 0 条、abandoned 增量。
5. 确定性拒收 ⇒ rejected：另一 room + `mode:'bogus'`；field 消失、0 条、rejected 增量。
6. 收尾：删本片 field；记录行保留（per-run）。

断言只在轮询结束后调用一次 `checks`，静态计数分解写进 plan；本机 Docker 不可用 ⇒ 待权威轮。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| enqueue queued/existing + write 成功 | 按请求 ack（EVAL compare-and-delete）；日志 written；箱无残留 |
| enqueue queued/existing + write 失败 | 条目保留；`kind='record'`；日志 queued for retry；sweeper 重投 |
| enqueue conflict + write 成功 | 不 ack（旧条目保留）；日志 written + conflict；无失败指标 |
| enqueue conflict/unavailable + write 失败 | 永久丢失；`kind='record_lost'`；`RecordLost` critical |
| enqueue unavailable + write 成功 | WARN 未 durable；无失败指标 |
| 写成功 ack 失败/所有权丢失 | ack=false + WARN；条目不删（或他实例已删）；不计失败 |
| settle→enqueue 进程崩溃 | 钱可能已动、记录未 durable；C1 不消除；C2 的 op→record 24h 宽限检测 |
| 下游宕机/挂起 | record 阶段 ≤2s 预算 + 一次在途 3s；record 每轮有进展；legacy 照常 |
| 条目 >24h | 全箱清 ⇒ abandoned + critical；不受 100 上限 |
| 坏 JSON/坏结构/非法 createdAt | corrupt + 删除 + critical |
| 确定性 10001 | rejected + 删除 + critical；其他码保留 failed |
| 多实例 | 重复投递幂等；仅 HDEL>0 计数；日志可能重复；size 用 max by |
| Redis 崩溃/丢数据 | RDB 已知限制；per-entry 可能静默丢失；不宣称 100% durable |
| 房间 TTL/形状不符 | 不入箱；既有 `roomWriteSkips`/`record_lost` |
| 记录晚到 >1h（金币局） | `money_delta` 永久 NULL；C2 归「疑似已知终态/原因未知」，不直接排除 |
| 约 10k 条积压 | 一次全箱 parse + 最老 100 + 2s 投递；plan 基准；>500ms 拖慢则升级 B |

**隐私/容量**：条目含 roomCode/gameVersion、userId/robotId/nickname、result、hand/bottomCards；
单条 <2KB；逻辑 TTL 24h（非法 createdAt 直接 corrupt，不无限保留）；10k 条约 20MB；每轮一次全箱 parse。

## 7. 迁移与回滚

- 无数据库迁移、无配置键、无协议/admin 变更；Redis 新增 `record:outbox`（不设 Hash TTL）。
- 回滚：优先保持新版本运行到 `HLEN=0` 再 revert；必须立即回滚时先 `HGETALL` 导出，恢复时重新
  部署新版本并把 field/value HSET 回去，等 sweeper 投递到 ok/replayed 且 `HLEN=0`；**未 drain/未导出
  不得 DEL**。
- 前进兼容：旧条目缺 gameType 按 ddz；未来多字段由 JSON 解析忽略（形状自保只校验必需键）。

## 8. 测试判据（完成定义）

1. 单测全绿；`packages/room-service` 全量测试 + lint 通过。
2. `pnpm exec turbo run test lint --force` 全绿（0 cached）。
3. `node scripts/verify-monitoring.mjs` 通过（35/32）；判别力自证（删 RecordLost 或改计数 ⇒ 红）。
4. conformance 静态：slice-16 EXPECTED_RULES=35 且含三条新规则；slice-18/24 32→35；
   `tools/conformance` tsc/lint 通过。
5. `pnpm verify:admin` 通过（无 admin 变更）。
6. 真栈：slice-15 C9 扩展 + slice-34 已实现；**本机 Docker 不可用 ⇒ 登记「待权威轮」**。
7. 工作区干净（不碰 `PdkSettlement.vue`）；`git diff` 不含 slice-29/协议/DB/admin。

## 9. 涉及文件

**生产代码**：`gateway/record-outbox.service.ts`（新）、`gateway/record-outbox.module.ts`（新）、
`gateway/ws.gateway.ts`、`gateway/ws.module.ts`、`currency/settle.sweeper.ts`、
`currency/currency.module.ts`、`metrics/room.metrics.ts`。

**监控/运维/设计**：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、`docs/design.md`、`deviation-ledger.md`、总 spec。

**测试/conformance**：`test/record-outbox.test.ts`（新）、`test/currency/settle-outbox.test.ts`、
`test/ws.gateway.test.ts`、`test/record-pdk.test.ts`、`test/ws.module.wiring.test.ts`、
`test/room-metrics-definitions.test.ts`、`test/metrics-game-type-invariant.test.ts`、
`test/client-message-wiring.gate.test.ts`、`slice-15-records.ts`、`slice-16-monitoring.ts`、
`slice-18-gold-room.ts`、`slice-24-ads-relief.ts`、`slice-34-record-outbox.ts`（新）、
`run.ts`、`baselines.json`。

**文档**：本 spec；`docs/superpowers/plans/2026-10-26-pdk-trust-c1-record-outbox.md`（下一步）。

## 10. 审查记录

### 10.1 第一轮（设计 + 可执行性，2026-10-26）

两路 reviewer：设计/竞态/契约（2 阻断 / 6 高 / 10 低）、可执行性/测试/机械闸（1 阻断 / 8 高 / 5 低）。
合并处置见 v2 的 F1–F14 / G1–G16（已闭合项不再重复）。

### 10.2 第二轮 delta（v2 → v3，2026-10-26）

| # | 级别 | 发现 | v3 处置 |
|---|---|---|---|
| N1 | 阻断 | 预算从 sweep 起点计 + record 箱在 legacy 后 ⇒ legacy 积压饿死 record | D6/§5.3：record 阶段最先、独立 2s 预算（record 起点）、失败隔离；补 legacy 慢测试 |
| N2 | 高 | enqueue 异常返回 null ⇒ 跳过直投 + 误记 record_lost | D4/§5.2：只有组装异常返回 null；enqueue 失败返回 `{request, unavailable}` 继续直投 |
| N3 | 高 | settle 伪码 `...room` 缺 roomCode/version/result | §5.2 写回完整实参，禁止 `...room` |
| N4 | 高 | 入箱前移制造「记录有、钱未结算」反向窗口 | D2/§5.2：**不重排**，保持 settle 先派发；settle→enqueue 窗口登记给 C2 |
| N5 | 高 | 共用房间读丢失记录链二次读，瞬时失败变 room_ttl | §5.2：记录链保留自己的 `findOne`；读失败按 room_ttl（与现状一致） |
| N6 | 中 | createdAt 自愈 HSET 覆盖/复活/整轮失败 | D8：不再 HSET 自愈；非法 createdAt 直接 corrupt 删除 |
| N7 | 中 | queued=false 时 ack 误删旧条目 | D3/D5/§5.1：enqueue 四态 + EVAL compare-and-delete；conflict/unavailable 不 ack |
| N8 | 中 | 「两次 sweep 同快照不重复计数」与 API 矛盾 | §5.6：测试改为允许重复投递、HDEL=0 不计；多实例语义单独钉 |
| N9 | 中 | C9 HKEYS 与 HDEL 竞态；「不必再打一局」易误读 | §5.7.1：HKEYS/players 轮询；保留局 2 并明确只新增局 1 |
| N10 | 中 | slice-34 静态计数与轮询断言纪律 | §5.7.2：checks 只在轮询后调用一次，plan 中静态分解 |
| N11 | 低 | record 阶段失败阻塞 legacy（反向耦合） | §5.3：record 阶段独立 try/catch，legacy 照常 |
| N12 | 低 | rejected 黑名单过宽 | D9：白名单仅 BadParam 10001；未知码保留 failed |
| N13 | 低 | settle 前 await enqueue 的 Redis hang 延迟结算；D22 口径 | 未重排（N4）⇒ 不再引入；D22 分开表述 |
| F9 | 高 | 容器级 WsModule 单例断言不可执行（真 Redis） | §5.6：不编译 WsModule；模块元数据 + CurrencyModule/RecordOutboxModule 身份断言 |
| 多实例 | 低 | resend_total/log 按实例放大 | D10：仅 HDEL>0 计数；size 用 max by；日志重复登记 |
| 10k CPU | 中 | 分类/排序无预算 | D21：plan 基准；>500ms 升级 B |
| 告警 | — | 永久丢失 critical | 用户裁决 A：新增 `RecordLost` critical；35/32；A1 告警不改 |

### 10.3 最终 delta 复审

（待 v3 送 reviewer 后回填）
