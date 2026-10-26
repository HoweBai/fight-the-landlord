# C1 记录链可靠性：`record.write` durable outbox 设计

> 日期：2026-10-26 · 状态：待设计对抗审查 · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（C 组总 spec）
> 用户裁决：U1 顺序 / U2 独立 Hash + 复用 sweeper / U3 24h TTL + 单轮 ≤100 条

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

## 2. 范围

### 2.1 做

1. 新增 `record:outbox` Redis Hash：
   - field = `<roomCode>:<gameVersion>`；
   - value = JSON `{ request: RecordWriteRequest, createdAt: number, gameType: 'doudizhu'|'paodekuai' }`；
   - 旧条目缺 `gameType` ⇒ 按 `doudizhu` 解释（指标/日志），请求本身原样重发。
2. 写前入箱（write-ahead）：`writeGameRecord` 在首次投递**之前**入箱；投递成功 ⇒ `HDEL`；
   失败 ⇒ 留在箱里由 sweeper 重投。入箱失败（Redis 故障）仍尝试直投，直投失败才算永久丢失。
3. 扩展现有 `SettleSweeper` 10s 循环多扫一箱：
   - 最老优先，每轮最多处理 **100** 条；
   - TTL **24h**：超龄 ⇒ 放弃 + `abandoned` 计数 + ERROR 日志；
   - 坏 JSON/坏结构 ⇒ 删除 + `corrupt` 计数 + ERROR 日志；
   - 单条失败只记 `failed` 并保留，继续下一条；整箱 `hgetall` 失败 ⇒ 本轮不再刷新该箱
     gauge（保留旧值），下一轮照常。
4. 新指标（全部带 `game_type`）：
   - `record_outbox_size`（gauge）
   - `record_outbox_oldest_seconds`（gauge）
   - `record_outbox_resend_total{game_type,result}`（counter；result = `ok|replayed|failed|abandoned|corrupt`）
5. 新告警 2 条（32 → 34 条，29 → 31 类）：
   - `RecordOutboxStuck`（warning；`oldest > 600s`）
   - `RecordOutboxAbandoned`（critical；`abandoned|corrupt` 近 1h 增量 > 0）
6. 同步：`scripts/verify-monitoring.mjs`（规则名单/谓词/头注释计数）、`Dockerfile.prometheus`、
   `docs/ops/first-deploy.md`（outbox 表 + runbook）。
7. 单测 + 源码闸目标清单 + conformance 真栈片 `slice-34-record-outbox`。

### 2.2 不做

- 不改 `RecordClient` 的传输语义（仍是 3s 单次尝试；重试只在 sweeper）。
- 不改 `record.write` 协议/请求形状/接收侧幂等键。
- 不动 `settle:outbox` / `recordmoney:outbox` 的 TTL（1h）、结构与 sweeper 顺序中前两箱的行为。
- 不新增配置键（TTL/上限/阈值都是常量）；不改数据库；不改协议；不改 admin；不改看板。
- 不补历史已丢失的记录；不重写记录内容；不做人工补录入口。
- 不把 `record_lost`（房间 TTL/形状不符）纳入 outbox —— 那些路径**没有可重投的请求**，
  保持既有「跳过 + 指标」语义。
- 不新增 IP/设备等字段。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 独立 `record:outbox` Hash + 扩展现有 `SettleSweeper` 循环 | 零新定时器/生命周期；与现有 outbox 运维口径一致；失败域与 settling 分离；实现面最小 | sweeper 与结算补偿共用一条 10s 链（结算箱慢会延后记录重投，但两者都很小） |
| B | 独立 `record:outbox` + 新 `RecordOutboxSweeper` | 隔离彻底、独立节奏 | 多一个定时器/关停闸/测试面/指标刷新点；当前收益不足以抵消复杂度 |
| C | 复用 `settle:outbox` | 少一个箱 | 结算条目是「已算好的货币载荷」，记录写入失败可能发生在结算前/独立失败；混箱会让两套失败语义、TTL 与告警互相牵制 |
| D（否决） | `RecordClient` 内部加重试 | 改动小 | 进程崩溃/重启仍丢；不是 durable outbox；与现有 outbox 设计不一致 |

**推荐 A**：记录与货币补偿是两条独立失败域，但可以共用同一条清扫节拍；独立 Hash 保证
互不污染，复用 sweeper 保证运维面不翻倍。

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 独立 Redis Hash `record:outbox`，field=`<room>:<version>`，value=`{request,createdAt,gameType}` | 用户裁决 U2；幂等键与接收侧唯一键同形 |
| D2 | **写前入箱**：先 `HSET` 再首次投递；成功 `HDEL`；失败留箱 | 只有写前入箱才能覆盖「进程在投递前崩溃」；成功后删除是 at-least-once 的标准收敛 |
| D3 | 入箱失败不阻断直投；直投成功照常 ack（空操作）；直投失败才计永久丢失 | Redis 故障时尽量保住记录；不因 outbox 不可用把本来能写成的记录打掉 |
| D4 | 入箱/删除都**不抛**（catch + 日志）；`enqueue` 返回 `boolean` 供调用方记录「是否已 durable」 | 局终链是 fire-and-forget，任何 Redis 抖动不得把广播/连接生命周期带崩 |
| D5 | 重投成功判定：`record.write` 返回 `true`（新写）或 `false`（幂等命中）都算成功 ⇒ `HDEL` | 接收侧唯一键保证幂等；`false` 是正常重复投递路径 |
| D6 | TTL = **24h**；每 10s 一轮；单轮最老优先 **≤100** 条 | 用户裁决 U3；记录是 C2 审计源，1h 太短；单轮上限防下游宕机时一轮被数千条×3s 拖死 |
| D7 | 超龄 ⇒ `HDEL` + `result=abandoned` + ERROR；坏 JSON/坏结构 ⇒ `HDEL` + `result=corrupt` + ERROR | 永久失败的条目不能每 10s 刷屏；两类都要 critical 告警（永久丢记录） |
| D8 | 单条重投失败 ⇒ 保留 + `result=failed` + WARN；不影响同轮其他条目 | 一次下游抖动不等于永久失败 |
| D9 | 指标：`record_outbox_size` / `record_outbox_oldest_seconds`（gauge，按玩法）；`record_outbox_resend_total{result}`（counter） | 与 A1 指标纪律一致；source 闸/标签声明测试同步 |
| D10 | 告警 2 条：`RecordOutboxStuck`（oldest>600s, warning）、`RecordOutboxAbandoned`（abandoned/corrupt>0, critical） | 10m 是「明显不健康」线；永久丢弃必须 critical |
| D11 | 不新增配置键；TTL/上限/阈值均为代码常量 | 首版最小面；调参走发版（与现有 10s sweeper 常量同口径） |
| D12 | 旧条目缺 `gameType` ⇒ 指标按 `doudizhu` 归组；请求原样重发（不要给旧请求补 `gameType`） | 「旧条目缺省 ddz」；补字段会改变旧请求形状 |
| D13 | 缺省/非法 `createdAt` ⇒ **不立即放弃**：按 `now` 计龄并 WARN，仍尝试重投 | 元数据缺失不应直接丢掉有效载荷；TTL 只对可判龄条目生效 |
| D14 | 多实例 sweeper 可并发重投同一条目 | 接收侧幂等；`HDEL` 幂等；不引入分布式锁（现有 sweeper 也无锁） |
| D15 | 无 DB 迁移、无协议/配置/admin 变更；回滚 = revert + 清箱 runbook | 风险最小 |
| D16 | Redis 仅 RDB 持久化是已知限制；建议部署侧评估 AOF，不纳入本片代码 | room-service 无 DB 连接；引入 DB outbox 远超本片 |

## 5. 实现设计

### 5.1 新模块 `RecordOutboxModule` / `RecordOutboxService`

文件：

- `packages/room-service/src/gateway/record-outbox.service.ts`（新增）
- `packages/room-service/src/gateway/record-outbox.module.ts`（新增）

```ts
export const RECORD_OUTBOX_KEY = 'record:outbox';
export const RECORD_OUTBOX_TTL_MS = 86_400_000;   // 24h
export const RECORD_OUTBOX_MAX_PER_SWEEP = 100;

export interface RecordOutboxEntry {
  request: RecordWriteRequest;
  createdAt: number;
  gameType?: GameType;
}

export function recordOutboxField(request: Pick<RecordWriteRequest, 'roomCode' | 'gameVersion'>): string {
  return `${request.roomCode}:${request.gameVersion}`;
}
```

`RecordOutboxService`（注入 `Redis` 与 `RecordClient`）：

| 方法 | 行为 |
|---|---|
| `enqueue(request): Promise<boolean>` | `HSET` 条目（`createdAt=Date.now()`、`gameType=normalizeGameType(request.gameType)`）；失败 ⇒ ERROR 日志 + `false`，**不抛** |
| `ack(request): Promise<void>` | `HDEL` 该 field；失败 ⇒ WARN，**不抛**（sweeper 会重投并再次 ack） |
| `resendEntry(field, raw, now): Promise<void>` | 解析 → 结构校验 → TTL → `record.write` → `HDEL` + 指标；失败保留 + `failed`；**自身不抛**（外层 catch 是纵深防御） |
| `refreshGauges(now): Promise<void>` | `hgetall` 全箱，按玩法统计 size/oldest，成功快照后**两种玩法都写**（缺失 0）；坏条目归 ddz + 汇总 WARN；`hgetall` 失败 ⇒ 抛给 sweeper（保留旧值） |
| `orderEntries(raw)`（导出纯函数） | 按 `createdAt` 升序（不可解析按 0），供 sweeper 取最老 100 条 |

结构校验（`resendEntry`）：

- `request` 必须是对象，且 `roomCode` 非空 string、`gameVersion` 为正整数、`mode`/`seats`/`result` 存在
  （只做**形状自保**，不做完整协议校验 —— 下游 `record.write` 仍有完整校验）；
- 不合法 ⇒ 视为 `corrupt`，删除并 ERROR；
- `createdAt` 不是有限数字 ⇒ 按 `now` 计龄 + WARN（D13）；
- `gameType` 非法/缺失 ⇒ `normalizeGameType` ⇒ ddz（仅指标/日志，请求不改）。

### 5.2 网关集成（`ws.gateway.ts`）

`WsGateway` 新增第 14 个构造参数 `recordOutbox: RecordOutboxService`（值导入；下标由
`ws.module.wiring.test.ts` 钉住）。`writeGameRecord` 在组装完成后：

```ts
const queued = await this.recordOutbox.enqueue(request);
try {
  const written = await this.record.write(request);
  await this.recordOutbox.ack(request);          // 不抛；失败则由 sweeper 重投后二次 ack
  this.logger.log(`Record written ... written=${written}`);
} catch (err) {
  throw new RecordWriteAttemptError(err, queued); // message = 原始错误文本
}
```

- `finalizeRoomEnd` 的 catch 保持既有指标 `record_write_failures_total{kind:'record'}` 与
  `Record write failed for room ...` 日志前缀（既有测试钉住），并追加：
  - `queued=true` ⇒ `... — queued for retry (record:outbox)`；
  - `queued=false` ⇒ `... — record lost (outbox unavailable)`。
- `enqueue` 返回 `false` 时网关**立即** WARN 一行（outbox 不可用，本条不 durable），但继续直投。
- 跳过路径（`!record || !version`、room TTL、形状不符）**不入箱**（没有可重投请求），既有指标不变。
- 广播与记录写入仍解耦：`settle` / `broadcast` 已在前面同步发出，记录失败不影响它们。

### 5.3 sweeper 集成（`settle.sweeper.ts`）

构造参数变为 `(redis, settle, recordOutbox)`；`sweepOnce` 顺序：

1. `settle:outbox`（既有，不变）
2. `recordmoney:outbox`（既有，不变）
3. `record:outbox`：
   ```ts
   const recordRaw = (await this.redis.hgetall(RECORD_OUTBOX_KEY)) ?? {};
   const ordered = orderEntries(recordRaw).slice(0, RECORD_OUTBOX_MAX_PER_SWEEP);
   for (const [field, raw] of ordered) {
     await this.recordOutbox.resendEntry(field, raw, now); // 自身不抛；外层 catch 兜底
   }
   ```
4. 刷新两个既有 gauge（不变）
5. 刷新 `record_outbox_*` 两个 gauge（新）

整箱 `hgetall` 失败 ⇒ `sweepOnce` reject（既有 `runOnce` catch + 下轮自重排），前两箱已处理；
`record_outbox_*` gauge 保留上一轮值。单条目失败不影响同轮其他条目（`resendEntry` 内部收敛）。

### 5.4 指标定义（`room.metrics.ts`）

```ts
export const recordOutboxSize: GaugeOf = createGauge(
  'record_outbox_size',
  '记录写入补偿队列条目数（record:outbox，按玩法；sweeper 每轮刷新）。',
  ['game_type'],
);
export const recordOutboxOldestSeconds: GaugeOf = createGauge(
  'record_outbox_oldest_seconds',
  '记录写入补偿队列最老条目滞留秒数（按玩法；空队列 0；RecordOutboxStuck 告警线 600s）。',
  ['game_type'],
);
export const recordOutboxResendTotal: CounterOf = createCounter(
  'record_outbox_resend_total',
  '记录补偿队列重投计数（result=ok|replayed|failed|abandoned|corrupt，按玩法）。',
  ['game_type', 'result'],
);
```

写点全部经 `incGame`/`setGame`；`metrics-game-type-invariant.test.ts` 的 `TARGETS` 追加
`recordOutboxSize`、`recordOutboxOldestSeconds`、`recordOutboxResendTotal`。

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
    runbook: 查 room-service 日志与 `record:outbox`；确认 user-service 可达后再决定人工重放

- alert: RecordOutboxAbandoned
  expr: sum by (game_type) (increase(record_outbox_resend_total{result=~"abandoned|corrupt"}[1h])) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: '记录永久丢弃（TTL 超龄/坏条目，{{ $labels.game_type }}）'
    runbook: 该局记录已不可自动恢复；按 room:version 人工核对并登记
```

`scripts/verify-monitoring.mjs`：

- `EXPECTED_ALERTS` 追加两条（34 条）；
- 头注释断言 `**34 条**` / `34 条 = 31 类`；
- `ALERT_PREDICATES` 追加：
  - `RecordOutboxStuck: ['record_outbox_oldest_seconds', '> 600']`
  - `RecordOutboxAbandoned: ['result=~"abandoned|corrupt"', '> 0']`
- 脚本自证：删一条告警 / 改头注释计数 ⇒ 必须红（手工验证并记录在 plan）。

`Dockerfile.prometheus` 注释「32 条规则」→「34 条规则」。

### 5.6 运维文档

`docs/ops/first-deploy.md`：

- 在 outbox 表（settle/recordmoney 两行）追加 `record:outbox` 一行：
  「待投递的**对局记录**（C1）；钱与余额不受影响，只是该局记录尚未落库」；
- 追加一小段 runbook：24h TTL、10s 重投、`oldest>600s` / `abandoned` 告警含义、
  查看命令 `docker exec -it ftl-redis redis-cli HGETALL record:outbox`、
  **不要手删**；回滚前先确认箱空或已导出。

### 5.7 conformance 真栈片 `slice-34-record-outbox`

新增 `tools/conformance/src/slices/slice-34-record-outbox.ts` + `run.ts` 注册 + `baselines.json` 条目。

设计（不依赖停服，验证 sweeper 真链路与幂等）：

1. 用 `docker compose exec -T redis redis-cli` 写一个有效条目（独立 room code，如 `OBOX` + 序号；
   seat 0 用本片登录账号，seat 1/2 机器人；`hand` 34 hex、`bottomCards` 6 hex、`result` 完整）；
2. 轮询 ≤60s：字段消失、`record_outbox_resend_total{result="ok"}` 增量、MySQL
   `SELECT COUNT(*) FROM game_records WHERE room_code=?` = 1；
3. 重投同一 field：`result="replayed"` 增量、记录仍 1 条（幂等）；
4. 坏 JSON：`result="corrupt"`、字段删除；
5. TTL 超龄有效条目（另一 room/version）：`result="abandoned"`、字段删除、记录 0 条；
6. 收尾：清掉本片 field；记录行留在测试库（CI 全新卷；本机脏卷可接受）。

限制（登记）：本片只验证 **sweeper 重投 + 幂等 + 三种终态**；**网关入箱路径由单测覆盖**
（真栈要停 user-service，成本/抖动不值得）。本机 Docker 不可用 ⇒ 先 `tsc`/lint，真栈读数
待权威轮；`baselines.json` 用源码静态计数初值，CI 实测后校正。

### 5.8 单测清单

新增 `packages/room-service/test/record-outbox.test.ts`：

- `enqueue`：字段/结构/`createdAt`/`gameType` 归一；Redis 失败 ⇒ 返回 `false`、不抛；
- `ack`：删除；Redis 失败 ⇒ 不抛；
- `resendEntry`：`true`/`false` 都删条目并分别计 `ok`/`replayed`；抛错 ⇒ 保留 + `failed`；
  TTL ⇒ `abandoned` 且不调 `record.write`；坏 JSON/坏结构 ⇒ `corrupt`；缺 `createdAt` ⇒ 不放弃、WARN；
  旧条目缺 `gameType` ⇒ 指标归 ddz、请求原样；
- `orderEntries`：`createdAt` 升序、坏值按 0；
- `refreshGauges`：按玩法分箱、两种玩法都写、坏条目归 ddz + WARN、`hgetall` 失败保留旧值。

`packages/room-service/test/currency/settle-outbox.test.ts`（更新）：

- 构造第三个参数；record 箱被扫描、最老优先、单轮 ≤100；
- 单条失败不阻断后续；`record:outbox` hgetall 失败 ⇒ gauge 保留旧值、前两箱照常已处理；
- 既有两箱语义/指标/自重排测试保持绿。

`packages/room-service/test/ws.gateway.test.ts`（更新）：

- harness 增加 `recordOutbox` 替身（默认 `enqueue=true`、`ack` 成功）；
- 组装成功：`enqueue` 先于 `write`，payload 与 `write` 相同，成功后 `ack`；
- `write` 抛：`ack` 不被调用、箱条目保留、`kind='record'` 指标 +1、日志含
  `queued for retry`、广播不受影响；
- `enqueue=false` + `write` 抛：日志含 `record lost`；
- room TTL/形状不符：`enqueue` 零调用。

`packages/room-service/test/record-pdk.test.ts`：构造参数补第 14 个；pdk 记录同样入箱，
条目 `gameType='paodekuai'`。

`packages/room-service/test/ws.module.wiring.test.ts`：`toHaveLength(14)`、第 14 个参数身份
`RecordOutboxService`、`WsModule.imports` 含 `RecordOutboxModule`、`CurrencyModule` 能把
`RecordOutboxService` 注入 `SettleSweeper`。

`packages/room-service/test/room-metrics-definitions.test.ts`：新指标标签声明与 `incGame/setGame` 写点。

`packages/room-service/test/metrics-game-type-invariant.test.ts`：`TARGETS` +3。

`scripts/verify-monitoring.mjs`：34 条规则 / 谓词 / 头注释。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 入箱成功、首次投递成功 | `HDEL`；日志 `written=true/false`；箱无残留 |
| 入箱成功、首次投递失败 | 条目保留；`kind='record'` 指标 +1；日志 `queued for retry`；sweeper 10s 后重投 |
| 入箱失败、首次投递成功 | 记录已落库；WARN「outbox 不可用，本条未 durable」；无残留 |
| 入箱失败、首次投递失败 | 永久丢失；`kind='record'` +1；日志 `record lost (outbox unavailable)` |
| 投递成功、`HDEL` 失败 | 条目残留；sweeper 重投 ⇒ `written=false` ⇒ `replayed` + `HDEL` 收敛 |
| 下游宕机 | 每条 3s 超时/连接拒绝；每轮最多 100 条；积压由 `oldest` 告警 |
| 条目超过 24h | 放弃 + `abandoned` + ERROR；critical 告警（永久丢记录） |
| 坏 JSON / 坏结构 | 删除 + `corrupt` + ERROR；critical 告警 |
| `createdAt` 缺失/非法 | 按 `now` 计龄 + WARN，仍重投（不静默丢有效载荷） |
| 同一 `<room>:<version>` 重复入箱 | field 相同，后写覆盖；请求内容应一致（同局同版本）；重投仍幂等 |
| 多实例并发 sweeper | 可能重复投递；接收侧幂等，`HDEL` 幂等；不加锁 |
| Redis 崩溃/丢数据 | 已知限制：RDB 可能丢最近一段；记录可能永久缺失；`abandoned`/积压告警可观测 |
| 房间 TTL/形状不符 | 不入箱（无可重投请求）；保持既有 `record_lost`/`room_ttl` 指标 |

**隐私/容量**：条目含 `hand`/`bottomCards` 的 hex（与 room 会话键同等敏感，最长 24h）；
单条 < 2KB；积压 10k 条约 20MB（Redis 量级可接受，`oldest`/size 告警先到）。

## 7. 迁移与回滚

- **无数据库迁移、无配置键、无协议变更、无 admin 变更**。
- Redis 新增 `record:outbox`（逻辑 TTL 24h，不设 Hash TTL）。
- 回滚：
  1. 先确认箱空（`HLEN record:outbox` = 0）或导出 `HGETALL record:outbox`；
  2. revert 本片提交；
  3. 旧代码不读该键 ⇒ 残留条目永远不会被处理；确认已导出/清空后 `DEL record:outbox`，
     否则会永久丢待投记录。
- 前进兼容：旧条目缺 `gameType` 按 ddz；未来条目多字段由 JSON 解析忽略（形状自保只校验必需键）。

## 8. 测试判据（完成定义）

1. 新增/更新单测全绿；`packages/room-service` 全量测试与 lint 通过。
2. `pnpm exec turbo run test lint --force` 全绿（0 cached 才算真跑）。
3. `node scripts/verify-monitoring.mjs` 通过（34 条 / 31 类）；判别力自证：删
   `RecordOutboxStuck` 或改头注释计数 ⇒ 红（手工验证并记录）。
4. `pnpm verify:admin` 不受影响（无 admin 变更）—— 仍跑一遍。
5. `tools/conformance` `tsc`/lint 通过；`slice-34-record-outbox` 已注册、基线静态初值；
   **真栈未跑（本机 Docker 不可用）⇒ 报告中登记「待权威轮」**。
6. 工作区干净（除用户未提交的 `apps/client/src/components/PdkSettlement.vue`，本片不碰）。
7. `git diff` 不含 `docs/superpowers/plans/2026-10-23-*`/slice-29/协议/DB/admin 文件。

## 9. 涉及文件

**生产代码**

- `packages/room-service/src/gateway/record-outbox.service.ts`（新增）
- `packages/room-service/src/gateway/record-outbox.module.ts`（新增）
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/room-service/src/gateway/ws.module.ts`
- `packages/room-service/src/currency/settle.sweeper.ts`
- `packages/room-service/src/currency/currency.module.ts`
- `packages/room-service/src/metrics/room.metrics.ts`

**监控/运维**

- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `docs/ops/first-deploy.md`

**测试 / conformance**

- `packages/room-service/test/record-outbox.test.ts`（新增）
- `packages/room-service/test/currency/settle-outbox.test.ts`
- `packages/room-service/test/ws.gateway.test.ts`
- `packages/room-service/test/record-pdk.test.ts`
- `packages/room-service/test/ws.module.wiring.test.ts`
- `packages/room-service/test/room-metrics-definitions.test.ts`
- `packages/room-service/test/metrics-game-type-invariant.test.ts`
- `tools/conformance/src/slices/slice-34-record-outbox.ts`（新增）
- `tools/conformance/src/run.ts`
- `tools/conformance/baselines.json`

**文档**

- 本 spec；`docs/superpowers/plans/2026-10-26-pdk-trust-c1-record-outbox.md`（下一步）
- `docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（已落）

## 10. 审查记录

（待独立对抗审查后回填）
