# C1 记录链可靠性：`record.write` durable outbox 设计（v2）

> 日期：2026-10-26 · 状态：已按两轮独立对抗审查修订（待复审） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（C 组总 spec）
> 用户裁决：U1 顺序 / U2 独立 Hash + 复用 sweeper / U3 24h TTL + 单轮 ≤100 条
> 审查记录见 §10（两路 reviewer 共 2 阻断 / 11 高 / 11 低；重叠项已合并，逐条处置）。

## 1. 背景与问题

对局记录是玩家战绩、风控扫描、资金对账（C2）的共同事实源。当前 `record.write` 是
**单次尝试**：

- `RecordClient.write` 超时 3s、不重试（`record.client.ts:28-33` 明文口径）；
- `WsGateway.writeGameRecord` 组装后直接 `await this.record.write(request)`（`ws.gateway.ts:1266`）；
- 失败只由 `finalizeRoomEnd` 的 catch 记 `record_write_failures_total{kind='record'}` + error
  日志（`ws.gateway.ts:1132-1141`），**该局记录永久丢失**；
- 只有结算后的 `record.moneyDelta` 有 outbox（`recordmoney:outbox`），记录本身没有。

后果：user-service 一次抖动/重启/网络闪断就留下永久战绩缺口；C2 上线后这类缺口会表现为
「钱已结算、记录不存在」的孤儿 op，且**无法自动修复**。接收侧已有
`(room_code, game_version)` 唯一键幂等（ddz `uk_room_version`、pdk `uk_pdk_room_version`），
所以「重投」在语义上是安全的；缺的只是「把没投成功的请求可靠地留住并重投」。

真栈现状补充：`slice-15-records` 的 C9 已经停 user-service 打一局并断言「广播照常 + 库无行」，
但**恢复后没有回查该局记录**——正好是 C1 要补的端到端证据。

## 2. 范围

### 2.1 做

1. 新增 `record:outbox` Redis Hash：
   - field = `<roomCode>:<gameVersion>`；
   - value = JSON `{ request: RecordWriteRequest, createdAt: number, gameType: 'doudizhu'|'paodekuai' }`；
   - 旧条目缺 `gameType` ⇒ 按 `doudizhu` 解释（指标/日志），请求本身原样重发。
2. **写前入箱，且入箱先于结算派发**：
   - `finalizeRoomEnd` 重排：读房间/机器人/昵称 → **组装 + 入箱** → `void settle(...)` → 尝试投递；
   - 投递成功 ⇒ `HDEL`；失败 ⇒ 留在箱里由 sweeper 重投；
   - 入箱失败（Redis 故障）仍尝试直投；直投失败才算永久丢失。
3. 扩展现有 `SettleSweeper` 10s 循环多扫一箱（**单次 HGETALL 快照**）：
   - 每轮开始对全箱分类：坏 JSON/坏结构 ⇒ 批量删除 + `corrupt`；超 24h ⇒ 批量删除 + `abandoned`；
   - 非法/未来 `createdAt` ⇒ 就地自愈为 `now`（HSET + WARN），不永久占队头；
   - 合法条目按最老优先，最多 **100** 条，且总投递预算 **2s**（wall clock）；超出预算的留到下轮；
   - 逐条 try/catch；单条失败（传输类）保留 + `failed`，不影响同轮其他条目；
   - 确定性业务错误（`RecordClientError.code !== UPSTREAM_UNAVAILABLE`）⇒ 立即删除 + `rejected`（不重试 24h）；
   - 指标从**同一份快照**计算（减去本轮成功删除的 field），不再做第二次全箱解析。
4. 新指标（全部带 `game_type`）：
   - `record_outbox_size`（gauge）
   - `record_outbox_oldest_seconds`（gauge）
   - `record_outbox_resend_total{game_type,result}`（counter；result = `ok|replayed|failed|abandoned|corrupt|rejected`）
5. 新告警 2 条（32 → 34 条，29 → 31 类）：
   - `RecordOutboxStuck`（warning；`oldest > 600s`，`for 5m`）
   - `RecordOutboxAbandoned`（critical；`abandoned|corrupt|rejected` 近 **24h** 增量 > 0，`for 5m`）
6. 同步全部机械闸与文档：
   - `scripts/verify-monitoring.mjs`（规则名单/谓词/头注释 34/31）；
   - `tools/conformance/src/slices/slice-16-monitoring.ts` 的 `EXPECTED_RULES` + 注释；
   - `tools/conformance/src/slices/slice-18-gold-room.ts:1594`、`slice-24-ads-relief.ts:706` 的 32→34；
   - `Dockerfile.prometheus`、`docs/ops/first-deploy.md`、`docs/design.md`、
     `docs/superpowers/plans/deviation-ledger.md`（N49 标注被 C1 取代）。
7. 测试：
   - 单测全矩阵（含写前入箱时序、HSETNX 冲突、非法 createdAt 自愈、>100 积压、毒条目、预算、ack 失败）；
   - **扩展 `slice-15-records` C9**：恢复 user-service 后回查局 1 记录落库 + 出箱；
   - 新增 `slice-34-record-outbox`：sweeper 的 ok/replayed/corrupt/abandoned/rejected 五态真栈验证。

### 2.2 不做

- 不改 `RecordClient` 的传输语义（仍是 3s 单次尝试；重试只在 sweeper）。
- 不改 `record.write` 协议/请求形状/接收侧幂等键。
- **不改 `settle:outbox` / `recordmoney:outbox` 的 TTL（1h）与结构**；但必须登记
  「记录可晚到 24h ⇔ recordmoney 1h」的交互（见 §6、C2 输入）。
- 不新增配置键（TTL/上限/预算/阈值都是常量）；不改数据库；不改协议；不改 admin；不改看板。
- 不补历史已丢失的记录；不重写记录内容；不做人工补录/重放入口。
- 不把 `record_lost`（房间 TTL/形状不符）纳入 outbox —— 那些路径**没有可重投的请求**，
  保持既有「跳过 + 指标」语义。
- 不新增 IP/设备等字段。
- 不做分布式 sweeper 锁（当前单实例部署；多实例只保证幂等，见 D15）。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 独立 `record:outbox` Hash + 扩展现有 `SettleSweeper`，加单轮预算 | 零新定时器/生命周期；与现有 outbox 运维口径一致；失败域与结算分离 | 与结算补偿共用一条 10s 链；靠 **2s 预算**把对前两箱的延迟上界压住（实测不达标再升级 B） |
| B | 独立 `record:outbox` + 新 `RecordOutboxSweeper` | 隔离彻底、独立节奏 | 多一个定时器/关停闸/测试面；首版收益不足以抵消复杂度 |
| C | 复用 `settle:outbox` | 少一个箱 | 结算条目是「已算好的货币载荷」，记录写入失败可能发生在结算前/独立失败；混箱会让两套失败语义、TTL 与告警互相牵制 |
| D（否决） | `RecordClient` 内部加重试 | 改动小 | 进程崩溃/重启仍丢；不是 durable outbox；与现有 outbox 设计不一致 |

**推荐 A**：记录与货币补偿是独立失败域，但可共用同一条清扫节拍；独立 Hash 保证互不污染，
2s 预算保证不把既有 10s 补偿节拍拖到分钟级。

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 独立 Redis Hash `record:outbox`，field=`<room>:<version>`，value=`{request,createdAt,gameType}` | 用户裁决 U2；幂等键与接收侧唯一键同形 |
| D2 | **写前入箱，且入箱先于 `settle` 派发**：`finalizeRoomEnd` 先 `prepareRecord`（组装+enqueue），再 `void settle`，最后 `deliverRecord` | 覆盖「结算已派发、记录还没入箱」的崩溃窗口（C2 孤儿）；enqueue 是单次 Redis HSET，延迟远小于结算链的既有 Redis 读 |
| D3 | `enqueue` 用 `HSETNX`：field 不存在 ⇒ 写入；已存在且请求同形（同 `roomCode/gameVersion/endedAt`）⇒ 视为已入箱；已存在但载荷不同（N51 room code 复用）⇒ **不覆盖** + ERROR + 返回 `false` | 不静默覆盖旧待投记录；N51 撞车接收侧同样无解，登记为已知限制 |
| D4 | `enqueue`/`ack` 都**不抛**（catch + 日志）；网关对 enqueue 再做一层 try/catch，保证无论入箱结果都尝试直投 | 局终链是 fire-and-forget，Redis 抖动不得带崩广播/连接；防「enqueue 意外抛 ⇒ 直投也被跳过」 |
| D5 | 重投成功判定：`record.write` 返回 `true`（新写）或 `false`（幂等命中）都算成功 ⇒ `HDEL` | 接收侧唯一键保证幂等；`false` 是正常重复投递路径 |
| D6 | sweeper 每轮对 record 箱做**一次 HGETALL 快照**；全箱清理 `corrupt`/超龄（批量 HDEL，不占 100 名额）；合法条目最老优先，最多 100 条 + 总投递预算 **2s**；指标从同一快照算 | 防毒条目/超龄条目占队头与整批超龄丢弃；防 100×3s 拖慢既有两箱；避免二次全箱解析 |
| D7 | TTL = **24h**；超龄 ⇒ 批量 `HDEL` + `result=abandoned` + ERROR | 用户裁决 U3；记录是 C2 审计源，1h 太短 |
| D8 | 坏 JSON/坏结构 ⇒ `HDEL` + `result=corrupt` + ERROR | 永久失败条目不能每 10s 刷屏 |
| D9 | **确定性业务错误**（`RecordClientError` 且 code ≠ `UPSTREAM_UNAVAILABLE`，如 10001）⇒ 立即 `HDEL` + `result=rejected` + ERROR；传输/超时/未知异常 ⇒ 保留 + `failed` | 与既有 settle outbox 的 10001 终态纪律一致；避免 8640 次/24h 的无效重试与队头阻塞 |
| D10 | `createdAt` 非有限/≤0/>now ⇒ 就地 HSET 自愈为 `now` + WARN；排序按自愈后的时间（最新）；gauge 按自愈后计龄 | 元数据坏不应永久绕开 TTL/告警；自愈后不占队头 |
| D11 | 指标：`record_outbox_size` / `_oldest_seconds`（gauge，按玩法）；`record_outbox_resend_total{result}`（counter，6 值） | 与 A1 指标纪律一致；源码闸目标清单 +3 |
| D12 | 告警 2 条：`RecordOutboxStuck`（oldest>600s, warning）、`RecordOutboxAbandoned`（24h 窗口内 abandoned/corrupt/rejected>0, critical） | 10m 是「明显不健康」线；永久丢弃必须 critical 且窗口足够长（不会 1h 后自愈消失） |
| D13 | `record_write_failures_total` 语义：`record` = 首次投递失败但**已 durable 入箱**；`record_lost` = **永久丢失**（形状不符 / 入箱不可用且直投失败）；HELP/告警注释/ops 文档同步 | 避免运维把「已入箱待重投」误读成丢记录；让真正的永久丢失走既有 critical 分支 |
| D14 | 逐条隔离：sweeper 对每条 `resendOne` 包 try/catch；网关 `prepare`/`deliver` 各自 try/catch | 单条异常不得中断同轮其他条目/结算派发 |
| D15 | 多实例 sweeper：重复投递安全（接收侧幂等），不加锁；`record_outbox_size` 是全局 Hash 统计 ⇒ 告警/看板用 `max by (game_type)`，禁止 `sum` | 当前单实例部署；加锁属于扩容时另立项 |
| D16 | 无配置键；TTL/100 条/2s 预算/600s 阈值均为代码常量 | 首版最小面；调参走发版（与现有 10s sweeper 常量同口径） |
| D17 | 旧条目缺 `gameType` ⇒ 指标按 `doudizhu` 归组；请求原样重发（不给旧请求补 `gameType`） | 「旧条目缺省 ddz」；补字段会改变旧请求形状 |
| D18 | 无 DB 迁移、无协议/配置/admin 变更；回滚 = 先 drain 到 HLEN=0，或导出后重新部署新代码重放，再 revert | 旧代码不读该键；直接 DEL 会永久丢待投记录 |
| D19 | Redis 仅 RDB 持久化是已知限制；条目含 userId/nickname/robotId/result/hand/bottomCards，逻辑 TTL 24h 但不保证（队头/自愈失败路径） | room-service 无 DB 连接；DB outbox 远超本片；隐私口径必须完整 |
| D20 | 真栈证据：扩展 slice-15 C9（网关路径）+ 新增 slice-34（sweeper 五态）+ slice-16/18/24 计数同步 | C9 已有停服/恢复基础设施，是「网关入箱 + 恢复后补投」的唯一真栈证据 |
| D21 | `recordmoney:outbox` TTL 保持 1h；记录晚到 >1h 的金币局 `money_delta` 会永久 NULL，C2 以「结算 op 存在 + >1h + NULL」判**已知终态**，不当作金额不一致 | 不改既有货币补偿 TTL；把交互显式交给 C2 |
| D22 | 单轮 record 投递预算 2s；最坏一轮 ≈ 预算 + 一次在途 3s 超时 ≈ 5s，前两箱补偿节拍保持在 10s 量级 | 防 100×3s=300s 的节拍塌陷；实测不达标再升级方案 B |

## 5. 实现设计

### 5.1 新模块 `RecordOutboxModule` / `RecordOutboxService`

文件：

- `packages/room-service/src/gateway/record-outbox.service.ts`（新增）
- `packages/room-service/src/gateway/record-outbox.module.ts`（新增）

```ts
export const RECORD_OUTBOX_KEY = 'record:outbox';
export const RECORD_OUTBOX_TTL_MS = 86_400_000;      // 24h
export const RECORD_OUTBOX_MAX_PER_SWEEP = 100;
export const RECORD_OUTBOX_SWEEP_BUDGET_MS = 2_000;  // 每轮投递墙钟预算

export interface RecordOutboxEntry {
  request: RecordWriteRequest;
  createdAt: number;
  gameType?: GameType;
}

export type RecordOutboxResult =
  | 'ok' | 'replayed' | 'failed' | 'abandoned' | 'corrupt' | 'rejected';

export function recordOutboxField(
  request: Pick<RecordWriteRequest, 'roomCode' | 'gameVersion'>,
): string {
  return `${request.roomCode}:${request.gameVersion}`;
}
```

模块元数据（必须写死，防装配层假绿）：

```ts
@Module({
  imports: [RedisProviderModule, RpcClientsModule], // Redis + RecordClient
  providers: [RecordOutboxService],
  exports: [RecordOutboxService],                   // 两处消费方共享同一实例
})
export class RecordOutboxModule {}
```

`RecordOutboxService`（注入 `Redis`、`RecordClient`；**两者都值导入**）：

| 方法 | 行为 |
|---|---|
| `enqueue(request): Promise<boolean>` | `HSETNX` 条目（`createdAt=now`、`gameType=normalizeGameType(request.gameType)`）；返回 1 ⇒ true；返回 0 ⇒ `HGET` 比较：同 `roomCode/gameVersion/endedAt` ⇒ true（已入箱），否则 ERROR + false（不覆盖）；任何异常 ⇒ ERROR + false，**不抛** |
| `ack(request): Promise<void>` | `HDEL` 该 field；失败 ⇒ WARN，**不抛**（sweeper 会重投并再次 ack） |
| `sweep(raw, now): Promise<void>` | 对一份 HGETALL 快照做全箱分类/清理/投递/指标（见 5.3） |
| 内部 `resendOne(field, entry, now): Promise<'kept'|'removed'>` | TTL 判定 → `record.write` → 成功 `HDEL` + `ok/replayed`；确定性错误 ⇒ `HDEL` + `rejected`；传输/未知 ⇒ `failed` + 保留；**自身不抛**（外层仍有 try/catch） |
| 内部 `drop(field, entry, result)` | `HDEL` + `incGame(recordOutboxResendTotal, gameType, 1, {result})` + ERROR 日志；HDEL 失败 ⇒ WARN（条目留存，下轮重试） |

结构自保（只校验重投所需的最小形状，完整校验仍在下游）：

- `request` 必须是对象，且 `roomCode` 非空 string、`gameVersion` 为正整数、`mode`/`seats`/`result` 存在
  （只做**形状自保**，不做完整协议校验 —— 下游 `record.write` 仍有完整校验）；
- 不合法 ⇒ 视为 `corrupt`，删除并 ERROR；
- `createdAt` 非有限/≤0/>now ⇒ 就地 HSET 自愈为 `now` + WARN（D10）；
- `gameType` 非法/缺失 ⇒ `normalizeGameType` ⇒ ddz（仅指标/日志，请求不改）。

### 5.2 网关集成（`ws.gateway.ts`）

`WsGateway` 新增第 14 个构造参数 `recordOutbox: RecordOutboxService`（**值导入**；下标由
`ws.module.wiring.test.ts` 钉住）。`finalizeRoomEnd` 重排为：

```text
endedAt = Date.now()
kick nickname hgetall（第一个 await 之前）
botBySeat = await readBotSeatMap
void releaseRobots(...)
room = await roomsService.findOne(roomCode)      // 只读一次，settle/prepare 共用
prepared = await prepareRecord(event, result, room, botBySeat, nicknames, endedAt)
void settleService.settle({ ... room, botBySeat })
if (prepared) await deliverRecord(prepared)
```

- `prepareRecord`：跳过判据 `!record || !version` / room 缺失 / 形状不符 —— 与现状逐字一致
  （跳过路径**不入箱**、指标不变）；通过则组装 `RecordWriteRequest`、`await recordOutbox.enqueue(request)`、
  返回 `{ request, queued }`。组装/入箱的意外异常 ⇒ ERROR + `record_lost` 指标，返回 `null`，
  **不阻断 settle**。
- `deliverRecord`：`record.write` 成功（true/false）⇒ `ack` + `Record written` 日志；
  失败 ⇒ 抛 `RecordWriteAttemptError(original, queued)`（message = 原文，既有日志断言不破）。
  `ack` 在 `deliverRecord` 内单独 try/catch：失败只 WARN，**不**把已成功的写入计成失败。
- `finalizeRoomEnd` 的交付 catch：
  - `queued=true` ⇒ `record_write_failures_total{kind='record'}`（首次失败但已入箱）；
    日志 `Record write failed for room ... — queued for retry (record:outbox): <原因>`；
  - `queued=false` ⇒ `kind='record_lost'`（永久丢失）；
    日志 `Record write failed for room ... — record lost (outbox unavailable): <原因>`；
  - `ack` 失败不进入 catch（`ack` 不抛）；若它意外抛，`deliverRecord` 的局部 catch 只 WARN。
- `enqueue=false` 但直投成功：WARN「本条未 durable」；无失败指标。
- `settle` 仍 `void`（fire-and-forget，内部自兜底）；广播在 `onGameEvent` 内同步发出。

单元判据（防假绿，D2）：

- `recordOutbox.enqueue` 返回 **deferred promise**；`record.write` 的实现断言「enqueue 已 resolve」
  才被调用 —— 仅用 `invocationCallOrder` 证明不了 `await`；
- 同一用例用有状态 fake Redis 断言 `<room>:<version>` field 确实存在（不是只看 `ack` 没被调用）；
- 断言 `enqueue` 在 `settle.settle` 之前被调用（D2 顺序）。

### 5.3 sweeper 集成（`settle.sweeper.ts`）

构造参数变为 `(redis, settle, recordOutbox)`；**第三个参数必须值导入**（DI 陷阱纪律）。
`sweepOnce` 顺序：

1. `settle:outbox`（既有，不变）
2. `recordmoney:outbox`（既有，不变）
3. **刷新既有两箱 gauge**（既有 `refreshOutboxGauges`；提前到 record 箱之前，保证 record 箱
   读取失败不冻结 `currency_settle_outbox_*`）
4. `record:outbox`：
   ```ts
   const recordRaw = (await this.redis.hgetall(RECORD_OUTBOX_KEY)) ?? {};
   await this.recordOutbox.sweep(recordRaw, now);   // 内部逐条隔离；整箱读取失败则抛给 runOnce
   ```
   读取失败 ⇒ `sweepOnce` reject（`runOnce` catch + 下轮自重排）；前 3 步已完成。

`RecordOutboxService.sweep(raw, now)`：

1. **全箱分类**（一次 parse）：
   - 坏 JSON/坏结构 ⇒ `corrupt` 列表；
   - 合法 `createdAt` 且 `now - createdAt > TTL` ⇒ `abandoned` 列表；
   - `createdAt` 非法/未来 ⇒ 就地 HSET 自愈为 `now` + WARN，按 `now` 参与排序与 gauge；
   - 其余 ⇒ 候选。
2. `corrupt`/`abandoned` 批量 `HDEL`（每批 ≤100 field），逐玩法计 `corrupt`/`abandoned`；
   大批量时合并为一条含数量的 ERROR（逐 field 只在少量时打印），避免刷屏。
3. 候选按 `createdAt` 升序，`slice(0, 100)`；逐条 `resendOne`：
   - 进入前检查 `Date.now() >= now + RECORD_OUTBOX_SWEEP_BUDGET_MS` ⇒ 停止（剩余下轮）；
   - 每条外层 try/catch（D14），异常计 `failed` 并继续下一条；
   - 同轮 `failed` 汇总为一条 WARN（数量 + 首个原因），避免下游宕机时每 10s 刷 100 行。
4. **gauge 从同一快照算**：对快照中未被成功删除的 field 按玩法计 size/oldest（自愈后的
   `createdAt`）；成功删除的 field（corrupt/abandoned/ok/replayed/rejected）从计数中扣除；
   两种玩法都写（缺失 0）。并发 enqueue/ack 造成的偏差最多滞后一轮（登记）。
   HGETALL 失败 ⇒ 抛给 `runOnce`，`record_outbox_*` 保留上一轮值（与既有 gauge 纪律同形）。

多实例（D15）：每个实例都会处理同一份队头；重复投递由接收侧幂等吸收；不加锁。
`record_outbox_size` 是全局值，告警/看板用 `max by (game_type)`。

### 5.4 指标定义（`room.metrics.ts`）

```ts
export const recordOutboxSize: GaugeOf = createGauge(
  'record_outbox_size',
  '记录写入补偿队列条目数（record:outbox，按玩法；sweeper 每轮从同一快照刷新；多实例时用 max by）。',
  ['game_type'],
);
export const recordOutboxOldestSeconds: GaugeOf = createGauge(
  'record_outbox_oldest_seconds',
  '记录写入补偿队列最老条目滞留秒数（按玩法；空队列 0；RecordOutboxStuck 告警线 600s）。',
  ['game_type'],
);
export const recordOutboxResendTotal: CounterOf = createCounter(
  'record_outbox_resend_total',
  '记录补偿队列结局计数（result=ok|replayed|failed|abandoned|corrupt|rejected，按玩法）。',
  ['game_type', 'result'],
);
```

写点全部经 `incGame`/`setGame`；`metrics-game-type-invariant.test.ts` 的 `TARGETS` 追加
**3 个**（不是 1 个）：`recordOutboxSize`、`recordOutboxOldestSeconds`、`recordOutboxResendTotal`。

同时更新 `recordWriteFailuresTotal` 的 HELP：

> 对局记录写失败/丢失计数（kind=record|money_delta|record_lost，按玩法）。
> `record` = 首次投递失败但已 durable 入箱待重投；`record_lost` = 永久丢失
> （形状不符，或 record:outbox 不可用且直投失败）；`money_delta` = 金币列回写失败。

### 5.5 告警与监控静态闸

`deploy/monitoring/prometheus/rules/ftl-alerts.yml`（头部注释 32→34 条、29→31 类）：

```yaml
- alert: RecordOutboxStuck
  expr: max by (game_type) (record_outbox_oldest_seconds) > 600
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: '记录补偿队列最老条目 > 10m（{{ $labels.game_type }}）'
    runbook: 查 room-service 日志与 `record:outbox`；确认 user-service 可达；等待 sweeper 自动重投，不要手删条目

- alert: RecordOutboxAbandoned
  expr: sum by (game_type) (increase(record_outbox_resend_total{result=~"abandoned|corrupt|rejected"}[24h])) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: '记录永久丢弃（TTL 超龄/坏条目/确定性拒收，{{ $labels.game_type }}）'
    runbook: 该局记录已不可自动恢复；按 room:version 人工核对并登记；检查是否协议/组装 bug 导致 rejected 潮
```

同时更新 `RecordWriteFailuresHigh` 的 summary/runbook：`kind=record` 表示「已入箱待重投」，
`kind=record_lost` 才是永久丢失。

`scripts/verify-monitoring.mjs`：

- `EXPECTED_ALERTS` 追加两条（34 条）；
- 头注释断言 `**34 条**` / `34 条 = 31 类`；
- `ALERT_PREDICATES` 追加：
  - `RecordOutboxStuck: ['record_outbox_oldest_seconds', '> 600']`
  - `RecordOutboxAbandoned: ['result=~"abandoned|corrupt|rejected"', '24h']`
- 判别力自证：删一条告警 / 改头注释计数 ⇒ 必红（手工验证并记录）。

**conformance 的三处硬编码 32（阻断 B2）**：

- `tools/conformance/src/slices/slice-16-monitoring.ts:94-113`：`EXPECTED_RULES` 追加
  `RecordOutboxStuck` / `RecordOutboxAbandoned`；`:109` 注释与 `:709/:715/:771-773` 文案同步 34；
- `tools/conformance/src/slices/slice-18-gold-room.ts:1594`：32→34，文案补「+2 C1」；
- `tools/conformance/src/slices/slice-24-ads-relief.ts:706`：32→34；文件头 `:26` 与 `:670` 的
  「31」同步为 34；
- 全仓 `grep -rn "ruleNames.*32\|=== 32\|rules found"` 复扫，确保无第四处漏网。

`Dockerfile.prometheus` 注释「32 条规则」→「34 条规则」。

### 5.6 运维文档

`docs/ops/first-deploy.md`：

- 「两个补偿队列」→「三个补偿队列」，表加 `record:outbox` 一行
  （「待投递的对局记录（C1）；钱与余额不受影响，只是该局记录尚未落库」）；
- 新增一小段 record outbox runbook：24h TTL、10s 重投、2s 预算、`RecordOutboxStuck` /
  `RecordOutboxAbandoned` 处置、查看命令 `HGETALL record:outbox`、**不要手删**；
- `:1284` 的多玩法告警清单追加 C1 两条，并说明 `record` vs `record_lost` 的新语义；
- `:1476` step 5 的查看命令加 `record:outbox`。

`docs/design.md`：`:702`、`:718`、`:1380` 的「record.write 失败即丢该局」改为
「失败先入 `record:outbox`（24h 重投）；永久丢失仅剩形状不符/outbox 不可用」。

`docs/superpowers/plans/deviation-ledger.md`：N49 行追加「2026-10-26 C1 起该接受窗口由
`record:outbox` 收敛（24h），N49 关闭」；N50（房键 TTL/形状不符跳过）保持。

总 spec `§4.2` 的 TARGETS 由 +1 改 +3；补 C2/C3 输入（见 C1 §6 D21 与总 spec §5.2）。

### 5.7 conformance 真栈

#### 5.7.1 扩展 `slice-15-records` C9（网关路径）

C9 已有「停 user-service ⇒ 打局 1 ⇒ 广播照常 + 库无行 ⇒ 起回 ⇒ 打局 2」。追加：

1. C9② 的日志断言从「前缀 `Record write failed for room <room1>`」加强为
   **同时含 `queued for retry (record:outbox)`**（证明网关入箱，而非只是失败）；
2. C9③ user-service 就绪后，**回查局 1**（不必再打一局）：
   - `recordsCount(room1)` 轮询 ≤60s 变 1；
   - `playersCountByRecordId(recordIdOf(room1))` = 3；
   - Redis `HKEYS record:outbox` 中不存在以 `<room1>:` 开头的 field（出箱；version 不写死）；
   - 再等一轮后 `recordsCount(room1)` 仍 = 1（幂等，无重复行；唯一键保证）。
3. 更新 C9 注释与 `baselines.json` 的 `slice-15-records`（按新增断言数）。

#### 5.7.2 新增 `slice-34-record-outbox`（sweeper 五态）

`tools/conformance/src/slices/slice-34-record-outbox.ts` + `run.ts` 注册 + `baselines.json`
（**只进 `full` 列；不加 render-gate 步骤**）。用 `RUN_TAG` 生成 per-run room code
（如 `C1${RUN_TAG}`，≤16 字符），开始前断言 `COUNT(*) = 0`，避免脏卷假红/假绿。

1. **有效条目 ⇒ ok**：用 slice-33 的 `craftDdzWinningRecord` 同形夹具（复制并注明来源；
   3 座、人类座 `userId` 为本片登录账号、`hand` 34 hex、`bottomCards` 6 hex、result 完整），
   经 `redis-cli HSET` 写入 `record:outbox`，`createdAt=now`；
   轮询 ≤60s：field 消失、`record_outbox_resend_total{result="ok",game_type="doudizhu"}` 增量、
   MySQL `recordsCount=1` / `playersCount=3`。
2. **同 field 重投 ⇒ replayed**：同 payload 重新 HSET；轮询 `result="replayed"` 增量、
   记录仍 1 条、玩家仍 3 行。
3. **坏 JSON ⇒ corrupt**：HSET 非 JSON；轮询 `result="corrupt"`、field 消失。
4. **TTL 超龄 ⇒ abandoned**：另一 room/version + `createdAt = now - 24h - 1`；轮询
   `result="abandoned"`、field 消失、该 room 记录 0 条。
5. **确定性拒收 ⇒ rejected**：另一 room + `mode:'bogus'`（类型断言）触发接收侧 10001；
   轮询 `result="rejected"`、field 消失、记录 0 条。
6. 收尾：删除本片 field；记录行保留（per-run room code，不影响任何判据）。

限制（登记）：slice-34 验证 sweeper 五态；网关入箱路径由 slice-15 C9 + 单测覆盖。
本机 Docker 不可用 ⇒ 先 `tsc`/lint，真栈读数待权威轮；`baselines.json` 用源码静态计数初值。

### 5.8 单测清单

新增 `packages/room-service/test/record-outbox.test.ts`：

- `enqueue`：HSETNX 写入字段/结构/`createdAt`/`gameType` 归一；Redis 异常 ⇒ false 不抛；
  field 已存在且同形 ⇒ true；field 已存在但载荷不同 ⇒ false + 不覆盖 + ERROR；
  `createdAt` 由注入时钟钉值；
- `ack`：删除；Redis 失败 ⇒ 不抛；
- `sweep`：
  - `ok`/`replayed` 删除并计数；传输失败保留 + `failed`；快照里仍在；
  - `RecordClientError(BAD_PARAM)` ⇒ `rejected` + 删除；`RecordClientError(UPSTREAM_UNAVAILABLE)` ⇒
    `failed` + 保留；
  - 坏 JSON/坏结构 ⇒ `corrupt` + 删除；
  - TTL 超龄 ⇒ `abandoned` + 删除；**全箱清理不受 100 上限影响**（>100 条超龄全部删除）；
  - 非法/未来 `createdAt` ⇒ HSET 自愈为 now、WARN、不永久占队头；自愈后再过 TTL 会 abandoned；
  - 最老优先；`MAX_PER_SWEEP` 截断；**2s 预算**用可控时钟证明超预算停止且剩余留箱；
  - 单条 `resendOne` 意外抛 ⇒ 后续条目仍处理（D14）；
  - gauge 从同一快照算：按玩法分箱、两种玩法都写、删除项扣除、**未成功删除的坏条目归 ddz + WARN**；
- 分类/排序行为（经 `sweep` 或导出的纯函数验证）：合法升序、非法自愈后不占队头、坏值不排到最前；
- 多实例语义：两次独立 `sweep` 同一快照 ⇒ 第二次遇已删除 field 不重复计数（幂等可重入）。

`packages/room-service/test/currency/settle-outbox.test.ts`（更新）：

- 第三构造参数；record 箱被扫；既有两箱语义/指标/自重排保持绿；
- **record:outbox HGETALL 失败**（key-aware fake，按 key 注入）⇒ 前两箱已处理、
  `currency_settle_outbox_*` 仍刷新、record gauge 保留旧值；
- record 箱单条失败不阻断后续；整体预算/上限透传（service 单测已覆盖，这里只钉接线）。

`packages/room-service/test/ws.gateway.test.ts`（更新）：

- harness 增加 `recordOutbox` 替身（默认 `enqueue=true`、`ack` 成功）；
- 组装成功：**deferred enqueue** 证明 `record.write` 在 enqueue resolve 之后才被调用；
  payload 与 `write` 相同；`ack` 在成功后调用；fake Redis 中 field 存在（写前入箱）；
- **`enqueue` 在 `settle.settle` 之前**被调用（D2 顺序）；
- `write` 抛 + `queued=true`：`ack` 未被调用、field 保留、`kind='record'` +1、日志含
  `queued for retry`、广播不受影响；
- `enqueue=false` + `write` 抛：`kind='record_lost'` +1、日志含 `record lost`；
- `enqueue=false` + `write` 成功：无失败指标 + WARN；
- `write` 成功但 `ack` 抛：不进入失败路径、无 `kind='record'` 增量、日志含 written；
- `enqueue` 意外抛：仍尝试 `write`（D4 纵深防御）；
- room TTL/形状不符：`enqueue` 零调用、既有指标不变。

`packages/room-service/test/record-pdk.test.ts`：构造补第 14 个参数；断言
`enqueue` 收到的 `request.gameType='paodekuai'`（**不**宣称验证 outbox 条目字段——
条目归一由 `record-outbox.test.ts` 覆盖）。

`packages/room-service/test/ws.module.wiring.test.ts`：

- `design:paramtypes` 长度 14；第 14 个参数身份 `RecordOutboxService`；
- `RecordOutboxModule` 元数据：`providers`/`exports` 含 `RecordOutboxService`，
  `imports` 含 `RedisProviderModule`/`RpcClientsModule`；
- `WsModule.imports` 含 `RecordOutboxModule`；`CurrencyModule.imports` 含 `RecordOutboxModule`；
- 容器级：`RecordOutboxModule` 能解析 `RecordOutboxService`；`CurrencyModule` 的
  `SettleSweeper` 与 `WsGateway` 拿到的是**同一个** `RecordOutboxService` 实例
  （子容器断言或 `mod.get` 身份比较）。

`room-metrics-definitions.test.ts`：3 个新指标标签声明；`metrics-game-type-invariant.test.ts`：
`TARGETS` +3；`client-message-wiring.gate.test.ts` 的 metrics no-op 桩补 3 个新导出。

`scripts/verify-monitoring.mjs`：34 条规则 / 谓词 / 头注释。

### 5.9 机械闸/同步面清单

- 告警：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
  `slice-16/18/24`、`docs/ops/first-deploy.md`。
- 指标源码闸：`metrics-game-type-invariant.test.ts` +3；`room-metrics-definitions.test.ts`；
  `client-message-wiring.gate.test.ts` 的 mock。
- 模块装配：`ws.module.wiring.test.ts`（长度/身份/imports/exports/单例）。
- 文档：`docs/design.md`、`deviation-ledger.md`（N49）、本 spec/plan/overview。
- 真栈：`slice-15-records`（C9 扩展）、`slice-34-record-outbox`、`baselines.json`（full 列）。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 入箱成功、首次投递成功 | `HDEL`；日志 `written=true/false`；箱无残留 |
| 入箱成功、首次投递失败（传输） | 条目保留；`kind='record'` +1；日志 `queued for retry`；sweeper 10s 后重投 |
| 入箱失败、首次投递成功 | 记录已落库；WARN「未 durable」；无失败指标 |
| 入箱失败、首次投递失败 | 永久丢失；`kind='record_lost'` +1；日志 `record lost (outbox unavailable)`；触发既有 `record_lost` 分支（**warning**，立即；未新增 critical，见 §10 G8 登记） |
| 投递成功、`HDEL` 失败 | 条目残留；sweeper 重投 ⇒ `written=false` ⇒ `replayed` + `HDEL` 收敛 |
| 下游宕机（拒绝连接） | 快速失败；每轮预算内处理；积压由 `oldest` 告警 |
| 下游挂起（3s 超时） | 每轮最多约 2s 预算 + 一次在途超时 ≈ 5s；前两箱节拍保持 10s 量级 |
| 条目超过 24h | 全箱清理（不受 100 上限）⇒ `abandoned` + ERROR；critical 告警 |
| 坏 JSON / 坏结构 | `corrupt` + 删除 + ERROR；critical 告警 |
| 确定性业务错误（10001 等） | `rejected` + 删除 + ERROR；critical 告警；不再每 10s 重试 |
| `createdAt` 缺失/非法/未来 | 就地 HSET 自愈为 now + WARN；不永久占队头；gauge 按 now 计龄 |
| 同一 `<room>:<version>` 不同载荷（N51） | 不覆盖；ERROR + enqueue=false；直投仍尝试；登记为已知限制 |
| 多实例并发 sweeper | 重复投递；接收侧幂等；`HDEL` 幂等；不加锁；size 用 max by |
| Redis 崩溃/丢数据 | RDB 已知限制；per-entry 可能静默丢失（只有首次失败日志/A1 warning）；不宣称 100% durable |
| 房间 TTL/形状不符 | 不入箱（无可重投请求）；保持既有 `record_lost`/`room_ttl` 指标 |
| 记录晚到 >1h（金币局） | `recordmoney:outbox` 已按 1h 放弃 ⇒ `money_delta` 永久 NULL；C2 按「op 存在 + >1h + NULL」判已知终态，不判金额不一致（D21） |

**隐私/容量**：条目含 `roomCode/gameVersion`、座位 `userId`/`robotId`/`nickname`、`result`、
`hand`/`bottomCards` hex；单条 < 2KB；逻辑 TTL 24h，但无 Hash TTL，非法元数据自愈失败等
病态路径可能更久（登记）。10k 条约 20MB；每轮一次全箱 parse（不是两次）。

## 7. 迁移与回滚

- **无数据库迁移、无配置键、无协议变更、无 admin 变更**。
- Redis 新增 `record:outbox`（逻辑 TTL 24h，不设 Hash TTL）。
- 回滚（安全顺序）：
  1. **优先**：保持新版本运行，等 `HLEN record:outbox = 0`（sweeper 自然 drain）后再 revert；
  2. 若必须立即回滚：先 `HGETALL record:outbox` 导出并保存；revert；
  3. 恢复时**重新部署新版本**，把导出的 field/value 逐条 `HSET` 回 `record:outbox`，等 sweeper
     投递到 `ok/replayed` 且 `HLEN=0`，再决定是否回滚；
  4. 旧代码不读该键；**不要在未导出/未 drain 时 `DEL record:outbox`**（会永久丢待投记录）。
- 前进兼容：旧条目缺 `gameType` 按 ddz；未来条目多字段由 JSON 解析忽略（形状自保只校验必需键）。

## 8. 测试判据（完成定义）

1. 新增/更新单测全绿；`packages/room-service` 全量测试与 lint 通过。
2. `pnpm exec turbo run test lint --force` 全绿（0 cached 才算真跑）。
3. `node scripts/verify-monitoring.mjs` 通过（34 条 / 31 类）；判别力自证：删
   `RecordOutboxStuck` 或改头注释计数 ⇒ 红（手工验证并记录）。
4. **conformance 静态面**：`slice-16 EXPECTED_RULES` = 34 且含两条新规则；
   `slice-18`/`slice-24` 的硬编码 32 全部改 34；`tools/conformance` `tsc`/lint 通过。
5. `pnpm verify:admin` 不受影响（无 admin 变更）—— 仍跑一遍。
6. 真栈：
   - `slice-15-records` C9 扩展（网关入箱 + 恢复后补投）已实现；
   - `slice-34-record-outbox` 已注册、基线静态初值（**只进 full 列**）；
   - **本机 Docker 不可用 ⇒ 两片真栈均登记「待权威轮」**，不得声称已跑。
7. 工作区干净（除用户未提交的 `apps/client/src/components/PdkSettlement.vue`，本片不碰）。
8. `git diff` 不含 `docs/superpowers/plans/2026-10-23-*`/slice-29/协议/DB/admin 文件。

## 9. 涉及文件

**生产代码**

- `packages/room-service/src/gateway/record-outbox.service.ts`（新增）
- `packages/room-service/src/gateway/record-outbox.module.ts`（新增）
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/room-service/src/gateway/ws.module.ts`
- `packages/room-service/src/currency/settle.sweeper.ts`
- `packages/room-service/src/currency/currency.module.ts`
- `packages/room-service/src/metrics/room.metrics.ts`

**监控/运维/设计文档**

- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `docs/ops/first-deploy.md`
- `docs/design.md`
- `docs/superpowers/plans/deviation-ledger.md`
- `docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`

**测试 / conformance**

- `packages/room-service/test/record-outbox.test.ts`（新增）
- `packages/room-service/test/currency/settle-outbox.test.ts`
- `packages/room-service/test/ws.gateway.test.ts`
- `packages/room-service/test/record-pdk.test.ts`
- `packages/room-service/test/ws.module.wiring.test.ts`
- `packages/room-service/test/room-metrics-definitions.test.ts`
- `packages/room-service/test/metrics-game-type-invariant.test.ts`
- `packages/room-service/test/client-message-wiring.gate.test.ts`（metrics mock）
- `tools/conformance/src/slices/slice-15-records.ts`（C9 扩展）
- `tools/conformance/src/slices/slice-16-monitoring.ts`（EXPECTED_RULES 34）
- `tools/conformance/src/slices/slice-18-gold-room.ts`（32→34）
- `tools/conformance/src/slices/slice-24-ads-relief.ts`（32→34）
- `tools/conformance/src/slices/slice-34-record-outbox.ts`（新增）
- `tools/conformance/src/run.ts`
- `tools/conformance/baselines.json`

**文档**

- 本 spec；`docs/superpowers/plans/2026-10-26-pdk-trust-c1-record-outbox.md`（下一步）
- `docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（已落）

## 10. 审查记录

### 10.1 第一路：可执行性 / 测试 / 机械闸（2026-10-26）

结论：需修订后再审（1 阻断 / 8 高 / 5 低）。逐条处置：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| F1 | 阻断 | 32→34 未同步 slice-16/18/24 硬编码 | 已并入 §2.1.6/§5.5/§8.4/§9，列为完成判据 |
| F2 | 高 | 写前入箱只有调用顺序判据，`await` 缺失会假绿 | §5.2/§5.8：deferred enqueue + 有状态 fake Redis + `enqueue` 先于 `settle` |
| F3 | 高 | hgetall 失败用例打不到目标读；step-3 失败冻结既有 gauge | §5.3：既有 gauge 提前；§5.8：key-aware fake 分别测记录读取失败/既有 gauge；逐条 try/catch |
| F4 | 高 | `createdAt` 三处语义冲突、可永久留箱 | D10/§5.1/§5.3：就地自愈 + 自愈后排序/gauge + 全箱清理 |
| F5 | 高 | 10001 与传输错误同待遇，重试 24h | D9/§5.1/§5.8：`rejected` 终态 + 判别测试 |
| F6 | 高 | 100×3s 拖慢既有两箱 | D6/D22/§5.3：2s 墙钟预算 + 预算测试；保留升级方案 B |
| F7 | 高 | slice-34 固定 room code 脏卷假红/假绿 | §5.7.2：per-run room code + 前置 COUNT=0 |
| F8 | 高 | 缺 enqueue=false+write 失败、写成功+ack 失败测试；永久丢失缺显式指标 | D13/§5.2/§5.8：`record_lost` 语义 + 三条边界测试 |
| F9 | 高 | 模块 provider/exports/单例未钉 | §5.1/§5.8：模块元数据 + exports + 容器单例断言 |
| F10 | 低 | baselines 只进 full 列 | §5.7.2/§8.6 写明 |
| F11 | 低 | ops 告警清单未同步 | §5.6 |
| F12 | 低 | record-pdk `gameType` 替身观测假绿 | §5.8 改为断言 enqueue 收到的 request.gameType |
| F13 | 低 | 回滚缺导出后重放步骤 | §7 改写为 drain-first + 导出/重放 |
| F14 | 低 | slice-34 夹具过粗、未复用 slice-33 | §5.7.2 明确复制 slice-33 同形夹具与字段清单 |

### 10.2 第二路：设计 / 竞态 / 契约（2026-10-26）

结论：需修订后再审（2 阻断 / 6 高 / 10 低；与第一路重叠项合并）。逐条处置：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| G1 (=F5+F6) | 阻断 | 10001 + 最老 100 条 + TTL 组合造成队头阻塞/整批丢弃 | D6/D9：确定性错误终态 + 全箱清理（不受 100 上限）+ 预算；>100/毒条目/跨玩法测试 |
| G2 (=F1) | 阻断 | slice-16/18/24 的 32 硬编码 | 同上 |
| G3 | 高 | 入箱点晚于 settle 派发，仍有孤儿崩溃窗口 | D2/§5.2：`prepareRecord`（入箱）前移到 `void settle` 之前；补顺序测试 |
| G4 (=F6) | 高 | record 箱拖慢 10s 补偿节拍 | D22/§5.3：2s 预算 + 前两箱 gauge 提前 |
| G5 (=F4) | 高 | 非法 createdAt 永久占队头/绕过 TTL/告警 | D10/§5.3：自愈 + 全箱分类 + gauge 计入 |
| G6 | 高 | C2/C3 宽限与 record 24h、recordmoney 1h 不兼容 | D21 + 总 spec §5.2：C2 缺失记录宽限 ≥24h/待定桶；money_delta >1h NULL = 已知终态；C3 按 ended_at 接受晚到 |
| G7 | 高 | 真栈只测 sweeper 手工条目，C9 可扩展却未回查 | D20/§5.7.1：扩展 slice-15 C9 回查局 1 落库/出箱/无重复 |
| G8 (=F8) | 高 | `kind='record'` 语义变化未告知；queued=false 永久丢失无 critical | 已改 D13/§5.2：`record` vs `record_lost` + 告警/文档/测试。queued=false 现计入 `record_lost`，触发既有 `RecordWriteFailuresHigh` 的 **warning** 分支（立即）。**登记**：未新增 `RecordLost` critical —— A1 现有 severity 保持不动（用户 no-do 清单「不重做 A1 告警」）；如用户要求可将 `record_lost` 单独升级 critical（发版项） |
| G9 (=F11+F13) | 低 | design.md/N49/first-deploy 旧口径；回滚不可恢复 | §5.6/§7 |
| G10 (=F3) | 低 | record 读取失败冻结既有 gauge | §5.3：既有 gauge 提前 |
| G11 (=F9) | 低 | 模块 imports/exports/值导入未钉 | §5.1/§5.8 |
| G12 | 低 | 两次全箱 parse/排序，10k 条时事件循环压力 | D6/§5.3：同一快照算指标，只 parse 一次；容量说明补 CPU |
| G13 | 低 | 多实例重复投递/全局 size 被 sum 放大 | D15：不加锁 + size 用 max by；真栈单实例 |
| G14 | 低 | 隐私/容量口径不完整（userId/nickname、逻辑 TTL 不保证、RDB 丢失不可观测） | D19/§6 隐私段 |
| G15 | 低 | 指标数量/告警口径不一致（+1 vs +3、size 告警、24h 窗口） | 总 spec §4.2 改 +3；§5.4/§5.5 钉 3 指标、无 size 告警、24h 窗口 |
| G16 | 低 | 同 field 不同载荷（N51）静默覆盖 | D3/§6：HSETNX 不覆盖 + ERROR + 登记 |

### 10.3 复审

（待两路 reviewer 对 v2 做 delta 复审后回填）
