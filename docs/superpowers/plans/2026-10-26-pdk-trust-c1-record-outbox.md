# C1 实施计划：`record.write` durable outbox

> 日期：2026-10-26 · 依据：`docs/superpowers/specs/2026-10-26-pdk-trust-c1-record-outbox-design.md`（v4）
> 分支：`feature/pdk-trust-c` · worktree：`D:/Code/ftl-trust-c` · 基线 `origin/dev@7460a3ce`
> 纪律：每任务 TDD（红 → 最小实现 → 绿）→ 提交；不夹带无关重构；不碰 slice-29 / `PdkSettlement.vue`。

## Global Constraints

- 只改 C1 面的文件；**不**改 protocol / DB migration / config keys / admin / 看板 / slice-29。
- 告警计数固定 **35 条 / 32 类**（新增 `RecordOutboxStuck` / `RecordOutboxAbandoned` / `RecordLost`）。
- 指标 3 个新目标，全部经 `incGame/setGame`；`TARGETS` +3。
- 真栈：本机 Docker 不可用 ⇒ slice-15 C9 扩展与 slice-34 只做 `tsc`/lint，报告登记「待权威轮」。
- 提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 验证命令：
  - 单包：`pnpm -C packages/room-service test`、`pnpm -C packages/room-service lint`
  - 监控：`node scripts/verify-monitoring.mjs`
  - 管理端：`pnpm verify:admin`
  - conformance：`pnpm -C tools/conformance lint`
  - 全量：`pnpm exec turbo run test lint --force`（0 cached）

## Task 1：指标定义 + 源码闸目标

**Files**：`packages/room-service/src/metrics/room.metrics.ts`、
`test/room-metrics-definitions.test.ts`、`test/metrics-game-type-invariant.test.ts`、
`test/client-message-wiring.gate.test.ts`。

**Step 1（红）**：
- 在 `room-metrics-definitions.test.ts` 加用例：`setGame(recordOutboxSize,...)`、`setGame(recordOutboxOldestSeconds,...)`、
  `incGame(recordOutboxResendTotal,'paodekuai',1,{result:'ok'})` 后 `exactSeriesValue` 命中合法标签。
- 在 `metrics-game-type-invariant.test.ts` 的 `TARGETS` 追加 3 个名字，并为 3 个新名字各加一条
  **正向自证**（拼错名字时负扫不得静默失效）。
- 在 `client-message-wiring.gate.test.ts` 的 no-op metrics 桩追加 3 个导出。
- 跑红：`pnpm -C packages/room-service exec vitest run test/room-metrics-definitions.test.ts test/metrics-game-type-invariant.test.ts`。

**Step 2（绿）**：
- `room.metrics.ts` 追加：
  ```ts
  export const recordOutboxSize: GaugeOf = createGauge('record_outbox_size',
    '记录写入补偿队列条目数（record:outbox，按玩法；sweeper 每轮从同一快照刷新；多实例时用 max by）。',
    ['game_type']);
  export const recordOutboxOldestSeconds: GaugeOf = createGauge('record_outbox_oldest_seconds',
    '记录写入补偿队列最老条目滞留秒数（按玩法；空队列 0；RecordOutboxStuck 告警线 600s）。',
    ['game_type']);
  export const recordOutboxResendTotal: CounterOf = createCounter('record_outbox_resend_total',
    '记录补偿队列结局计数（result=ok|replayed|failed|abandoned|corrupt|rejected，按玩法）。',
    ['game_type', 'result']);
  ```
- 更新 `recordWriteFailuresTotal` HELP 为 spec §5.4 文案。
- 跑测试 + `pnpm -C packages/room-service lint` 绿。

**Step 3**：提交 `feat(room): record outbox 指标定义（3 个新目标）`。

## Task 2：RecordOutboxService 骨架（enqueue/ack + CAS 脚本）

**Files**：`src/gateway/record-outbox.service.ts`（新）、`test/record-outbox.test.ts`（新）、
`test/helpers/fake-redis.ts`。

**Step 1（红）**：
- `test/record-outbox.test.ts`：
  - `enqueue`：HSETNX 写入字段/结构/createdAt/gameType 归一；
  - same endedAt ⇒ `{status:'existing', raw}`；different endedAt ⇒ `conflict` 且 field 不变；
    Redis 抛 ⇒ `unavailable` 不抛；existing 非 JSON ⇒ conflict；existing 合法 JSON 但结构不合法
    （缺 endedAt 等）⇒ conflict（**不得覆盖**）；
  - `ack`：CAS 删除成功 true；raw 不匹配 false 且 field 保留；Redis 抛 false 不抛。
- `fake-redis.ts` 的 `makeFakeEval` 增加 `CAS_HDEL_RECORD_OUTBOX` / `CAS_HSET_RECORD_OUTBOX`
  两个脚本的内存实现（比对 `HGET` 与期望 raw，再 `HDEL`/`HSET`）。
- 跑测试确认红（服务文件不存在）。

**Step 2（绿）**：实现 `record-outbox.service.ts`：
- 常量/类型按 spec §5.1；导出两个 Lua 脚本常量。
- `enqueue(request)`：`now=Date.now()`；raw=JSON.stringify({request,createdAt:now,gameType:normalizeGameType(request.gameType)})；
  `hsetnx(key,field,raw)`；0 ⇒ `hget` 解析/结构校验（含 endedAt）→ existing/conflict；异常 ⇒ unavailable。
- `ack(field, raw)`：`redis.eval(CAS_HDEL_RECORD_OUTBOX,1,KEY,field,raw)`；异常 WARN false。
- 结构自保函数 `isValidRecordRequest`（roomCode/gameVersion/endedAt/mode/seats/result）。
- 跑测试 + lint 绿。

**Step 3**：提交 `feat(room): record outbox 服务（enqueue/ack CAS）`。

## Task 3：RecordOutboxService.sweep（分类/投递/清理/gauge）

**Files**：`src/gateway/record-outbox.service.ts`、`test/record-outbox.test.ts`。

**Step 1（红）**：追加用例（均直接调 `sweep(raw, now, nowFn?)`）：
- ok/replayed（CAS 删除成功才计）；HDEL=0 不计；
- 传输失败保留 + failed；BadParam ⇒ rejected；未知 RecordClientError ⇒ failed 保留；
- 坏 JSON/坏结构 ⇒ corrupt；TTL 超龄 ⇒ abandoned；>100 超龄本轮清理 ≤500；
- 非法 createdAt ⇒ CAS 自愈后投递；**自愈成功必须改用 new raw 做后续 ack/drop**（否则条目多留一轮、不计数）；
  repair CAS 失败仍投递一次且不删；**未来 5min 内合法（不重置）、超过 5min 才自愈**；
- 并发新 enqueue（createdAt=now+1ms）不被误删/不判 corrupt；
- 快照后同 field 新 enqueue ⇒ 旧 drop/ack CAS 不删新；
- 最老优先/100 截断/2s 预算（注入可控 `nowFn`）；单条异常不影响后续；
- gauge 从同一快照分玩法、两种玩法都写、删除项扣除、未删坏条目归 ddz + WARN；
- 非 `RecordClientError`（编程/未知异常）⇒ failed 保留（不进 rejected）。

**Step 2（绿）**：实现 `sweep(raw, now, nowFn = Date.now)`：
- 一次 parse + 分类；corrupt/abandoned/repair 列表；**分类时记录每个 field 的 currentRaw**；
- 候选按有效 createdAt 升序；`deliveryStart=nowFn()`；逐条检查 2s；`resendOne` 逐条 try/catch；
- 投递后清理 corrupt/abandoned（≤500，CAS HDEL，CAS>0 才计数）；
- `resendOne`：`record.write` 成功 ⇒ `ack(field, raw)`；CAS 成功计 ok/replayed；BadParam ⇒ drop rejected；
  其他 ⇒ inc failed + 保留；不抛；
- 自愈：`CAS_HSET` 成功 ⇒ 用返回的 new raw 更新后续 ack/drop；失败 ⇒ 保持快照 raw，投递一次但不删；
- `drop(field, raw, entry, result)`：`ack` CAS 删除成功才 inc + ERROR；
- gauge 从快照减已删除 field；`setGame` 两玩法；未来 5min 内合法（age clamp 0），超容差自愈。
- **10k 基准**：在 `test/record-outbox.test.ts` 加一个 10k 条快照的 parse+classify+sort 计时用例，
  记录耗时到测试输出（不做硬时限断言）；Task 10 报告；>500ms 触发升级 B/优化登记。
- 跑测试 + lint 绿。

**Step 3**：提交 `feat(room): record outbox sweep（分类/投递/CAS 清理/gauge）`。

## Task 4：模块装配 + WsGateway 第 14 参数

**Files**：`src/gateway/record-outbox.module.ts`（新）、`src/gateway/ws.module.ts`、
`src/currency/currency.module.ts`、`test/ws.module.wiring.test.ts`。

**Step 1（红）**：
- wiring test：`design:paramtypes` 长度 14、第 14 个参数 `RecordOutboxService`；
  `RecordOutboxModule` providers/exports 含服务、imports 含 RedisProviderModule/RpcClientsModule；
  `WsModule.imports`/`CurrencyModule.imports` 含 `RecordOutboxModule`；
  `CurrencyModule` compile 后 `mod.get(RecordOutboxService)` 为实例，且
  `(mod.get(SettleSweeper) as any).recordOutbox === mod.get(RecordOutboxService)`（同一实例）；
  `design:paramtypes[13] === RecordOutboxService`；**不编译 WsModule**（真 Redis），残余登记。
- 跑确认红。

**Step 2（绿）**：
- `record-outbox.module.ts` 按 spec §5.1。
- `ws.module.ts` imports + `WsGateway` 构造第 14 参数（值导入，先只赋值不接线）。
- `currency.module.ts` imports `RecordOutboxModule`（供后续 sweeper）。
- 更新 `ws.gateway` 构造签名；同步所有 `new WsGateway(...)`（`ws.gateway.test.ts`、
  `record-pdk.test.ts`）补第 14 个替身（默认 `{enqueue:async()=>({status:'queued',raw:'x'}),ack:async()=>true,sweep:async()=>{}}`）。
- 跑测试 + lint 绿。

**Step 3**：提交 `feat(room): RecordOutboxModule 装配 + WsGateway 第 14 依赖`。

## Task 5：网关记录链（prepare/deliver/conflict/skip 指标）

**Files**：`src/gateway/ws.gateway.ts`、`test/ws.gateway.test.ts`、`test/record-pdk.test.ts`。

**Step 1（红）**：追加用例：
- settle 在 record 之前，且记录失败不影响 settle；
- deferred `enqueue` ⇒ `record.write` 在 enqueue resolve 后才调用；payload 一致；
- queued/existing + write 成功 ⇒ `ack(field, raw)`；
- **`write` 返回 false（幂等命中）⇒ 视为成功并 ack，不得计失败**；`ack` 返回 false ⇒ 无失败指标、
  field 可能保留、下一轮 replayed；`write=false` + `ack=false` 组合同样不失败；
- conflict ⇒ `record.write` 零调用、`record_lost` +1、日志含 conflict；
- unavailable + write 成功 ⇒ 无失败指标 + WARN；unavailable + write 失败 ⇒ `record_lost`；
- write 抛 owned ⇒ `record`；非 owned ⇒ `record_lost`；
- enqueue 抛 ⇒ 仍 write；ack 抛 ⇒ 无失败指标；
- skip 三态指标：`!record||!version` 零指标；room 缺失 `recordWriteSkipsTotal`；形状不符 `record_lost`。

**Step 2（绿）**：
- `finalizeRoomEnd` 保持 settle 调用（完整实参），记录部分改为 `prepareRecord` + `deliverRecord`；
- `prepareRecord` 自己的 `findOne` + 现有 skip 判据 + 组装 + `enqueue`；组装异常 ⇒ `record_lost` + null；
- `deliverRecord`：conflict ⇒ 抛 `RecordConflictError`；成功 ⇒ owned 时 `ack`；失败 ⇒
  `RecordWriteAttemptError(original, owned)`；
- finalize catch 按 owned 计 `record`/`record_lost`，日志后缀按 spec。
- 跑测试 + lint 绿。

**Step 3**：提交 `feat(room): 记录链写前入箱 + conflict/ack 所有权`。

## Task 6：Sweeper 接入（record 阶段最先 + 硬超时/在途闸）

**Files**：`src/currency/settle.sweeper.ts`、`test/currency/settle-outbox.test.ts`、
`test/currency/helpers.ts`。

**Step 0（修既有构造点，防 lint 阻断）**：
- `helpers.ts` 的 `SettleHarness` 增加 `recordOutbox` 替身（默认 `sweep: vi.fn().mockResolvedValue(undefined)`）；
- `makeSweeper` 传第三参数；第三参数保持**必填**，不得 optional（防 `undefined.sweep` 被 phase catch 吞掉）。

**Step 1（红）**：
- `SettleSweeper` 第三构造参数；record 阶段最先；record 阶段失败/超时 ⇒ legacy 仍处理；
  legacy 慢 ⇒ record 仍每轮有进展；record HGETALL 失败 ⇒ 既有 gauge 仍刷新、record gauge 保留；
  `recordPhaseInFlight` 时跳过本轮 record 且 legacy 照常；
  **未注入 recordOutbox 时构造/执行必须失败**（自证必填）。
- 用 fake `recordOutbox.sweep` 挂起/抛错/延迟；key-aware hgetall 注入；5s 超时用 fake timers，
  避免真等 5s。

**Step 2（绿）**：
- 构造 `(redis, settle, recordOutbox)`（值导入）；
- `sweepOnce` 按 spec §5.3：record 阶段 try/catch + `withTimeout(5s)` + 在途闸；随后既有两箱 + 既有 gauge；
- `withTimeout` 用 `Promise.race` + `finally clearTimeout`；超时后不取消底层 promise，
  `.finally` 清在途闸。
- 跑测试 + lint 绿。

**Step 3**：提交 `feat(room): sweeper 接入 record 阶段（最先/5s 硬超时/在途闸）`。

## Task 7：告警 + 监控静态闸 + conformance 计数

**Files**：`deploy/monitoring/prometheus/rules/ftl-alerts.yml`、`scripts/verify-monitoring.mjs`、
`Dockerfile.prometheus`、`tools/conformance/src/slices/slice-16-monitoring.ts`、
`slice-18-gold-room.ts`、`slice-24-ads-relief.ts`。

**Step 1（红）**：先改 `verify-monitoring.mjs` 的 EXPECTED/谓词/头注释断言（35/32），
跑 `node scripts/verify-monitoring.mjs` 确认红（规则不存在）。

**Step 2（绿）**：
- 加 3 条告警（spec §5.5 表达式）；头部 35/32；Dockerfile 35；
- slice-16 EXPECTED_RULES 加 3 名、注释 35；slice-18/24 32→35（slice-24 文件头/步骤 31→35）；
- 跑 `verify-monitoring` 绿；手工自证：临时删 `RecordLost`/改头注释 ⇒ 红，恢复。
- 复扫三处精确锚点：`slice-16` 的 `EXPECTED_RULES`、`slice-18-gold-room.ts:1594`、
  `slice-24-ads-relief.ts:706`（不要用宽泛 `grep "32\b"`，会命中历史注释）。
- 跑 `pnpm -C tools/conformance lint` 绿。

**Step 3**：提交 `feat(monitoring): record outbox 三条告警 + 35/32 计数同步`。

## Task 8：运维/设计/台账文档

**Files**：`docs/ops/first-deploy.md`、`docs/design.md`、
`docs/superpowers/plans/deviation-ledger.md`。

- ops：三个补偿队列 + `record:outbox` 行；runbook（24h/10s/2s/5s 硬超时/在途闸/三条告警/查看/
  不要手删）；`:1284` 告警清单 +3；`:1476` 查看命令加 `record:outbox`。
- design：`:702/:718/:1380` 改为「失败先入 record:outbox（24h 重投）；永久丢失仅剩形状不符/
  outbox conflict/入箱不可用且直投失败；组装异常也计永久丢失；unavailable 且直投成功不算丢失」。
- ledger：N49 追加「C1 起由 record:outbox 收敛（24h），N49 关闭」；N50 保持。
- 提交 `docs(ops): record outbox 运维与设计口径`。

## Task 9：conformance（slice-15 C9 扩展 + slice-34 + run.ts + baselines）

**Files**：`tools/conformance/src/slices/slice-15-records.ts`、
`slice-34-record-outbox.ts`（新）、`run.ts`、`baselines.json`、`lib/redis.ts`（如需要写助手）。

**Step 1**：slice-15 C9：
- C9② 日志断言加 `queued for retry (record:outbox)`；
- C9③ 保留局 2；新增局 1 回查（records=1、players=3、HKEYS 无 `<room1>:` 前缀；全部 `pollUntil`）；
- 基线按新增断言静态分解上调。

**Step 2**：slice-34：
- 复制 slice-33 `craftDdzWinningRecord` 夹具（注明来源）；`RUN_TAG` room code；前置 COUNT=0；
- `createdAt=now-1000`（防未来容差边界）；五态用例；强判据 field 消失 + DB 行/玩家；
  指标只断言 `>= before`（不强求恰 +1）；收尾删 field；
- `run.ts` CASES 追加；`baselines.json` full 列新增（静态计数分解写入注释）。

**Step 3**：`pnpm -C tools/conformance lint`；提交
`test(conformance): C1 记录 outbox 真栈切片（slice-15 C9 + slice-34）`。
**真栈**：本机 Docker 不可用 ⇒ 不运行，报告登记「待权威轮」。

## Task 10：全量验证 + 代码审查

1. `pnpm -C packages/room-service test`、`lint`；
2. `node scripts/verify-monitoring.mjs`；`pnpm verify:admin`；`pnpm -C tools/conformance lint`；
3. `pnpm exec turbo run test lint --force`（0 cached）；
4. `node scripts/check-baselines.mjs --self-test`（若脚本支持；不支持则登记）与
   `node scripts/check-baselines.mjs`（本机无 Docker 时按脚本约定跳过真栈比较）；
5. 10k 基准读数写入交付报告（>500ms 触发升级 B 登记）；
6. 独立 code review（subagent 审 `BASE..HEAD`，对照 spec）；Critical/Important 修复并复跑；
7. 工作区干净；提交最终修复；写交付报告（分支/SHA、测试证据、真栈待跑项、合 dev 建议）。

## 回滚

- 每任务独立提交，可单独 revert；无 DB 迁移。
- 整体回滚：先 drain `record:outbox` 到 HLEN=0（或导出 HGETALL），再 revert；未 drain/未导出不得 DEL。

## 计划审查记录

独立 reviewer 计划对抗审查（2026-10-26）：1 阻断 / 5 高 / 5 低。处置：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 阻断 | Task 6 未列 `new SettleSweeper` 测试构造点，lint 必红 | Task 6 Step 0：`helpers.ts`/`makeSweeper` 传第三参数；必填；未注入即失败自证 |
| 2 | 高 | CAS 自愈后未用 new raw 做 ack/drop | Task 3：记录 currentRaw；自愈成功用 new raw；两条判别测试 |
| 3 | 高 | write=false / ack=false 成功语义未测 | Task 5：false 视为成功；false+false 组合不失败 |
| 4 | 高 | 未钉同一 RecordOutboxService 实例 | Task 4：`SettleSweeper['recordOutbox'] === mod.get(...)` + paramtypes[13] |
| 5 | 高 | 未来 createdAt 缺 5min 容差判别 | Task 3：now+5min 合法、now+5min+1 自愈 |
| 6 | 高 | 10k 基准未落任务 | Task 3 加计时用例；Task 10 报告；>500ms 升级 B |
| 7 | 低 | existing 结构不合法未测；enqueue conflict vs sweep corrupt 口径 | Task 2/3 分别钉：enqueue 结构坏 ⇒ conflict；sweep 结构坏 ⇒ corrupt |
| 8 | 低 | TARGETS 新名字无正向自证 | Task 1 三个名字各加自证 |
| 9 | 低 | baseline self-test / slice-34 细节 | Task 9/10：`check-baselines --self-test`；createdAt=now-1000；指标 >= before；C9 精确 1/3 |
| 10 | 低 | withTimeout 未清 timer；测试命令写法 | Task 6：finally clearTimeout + fake timers；Task 1 用 `exec vitest run` |
| 11 | 低 | grep 过宽；design/runbook 漏文案 | Task 7 精确锚点；Task 8 补组装异常/unavailable 成功/5s 在途闸 |

## 执行记录（2026-10-26）

- 分支/worktree：`feature/pdk-trust-c` @ `D:/Code/ftl-trust-c`，基线 `origin/dev@7460a3ce`。
- 提交（按序）：`5e9a6a0f` 总 spec+C1 spec → `dffbae90` v2 → `8d1699ab` v3 → `aecf55e4` v4 →
  `5513c4eb` plan → `aa71c875` 指标 → `cd520e5b` 服务 → `d2695005` 网关/sweeper 接线 →
  `7dbe7c96` 告警/计数 → `c62ac8cb` conformance → `b453738e` 错误类补提交 →
  `937f7985` 运维/设计/台账。
- 本机验证：
  - room-service：56 文件 / **959 tests** 全绿；lint 通过。
  - `node scripts/verify-monitoring.mjs`：**241 checks**；自证「改头注释 35→34 ⇒ 1 FAILED」已执行并恢复。
  - `pnpm verify:admin`：**520 checks**。
  - `tools/conformance`：`tsc --noEmit` 通过；`check-baselines.mjs --self-test` 4/4。
  - 10k 分类/排序基准：**83.6ms**（<500ms，不触发升级 B）。
  - 全量 turbo：首跑/二跑/三跑各有一例**环境性**失败（config 迁移 5s 超时、currency internal-token 端口冲突、
    bcrypt 原生绑定未构建）——三包单独复跑分别 489/489、538/538、404/404 全绿；已修 bcrypt 后串行重跑（结果见交接）。
- 真栈：本机 Docker 不可用；`slice-15-records` C9 扩展与 `slice-34-record-outbox` 只做 tsc，
  **待权威轮**。
- 代码审查（2026-10-26，独立 reviewer 审 `origin/dev..HEAD`）：**0 Critical / 1 Important / 5 Minor**。
  - Important：sweep 失败/清理/自愈日志逐条刷屏 ⇒ 已改按轮聚合（`72794727`），补聚合用例。
  - Minor：enqueue/ack 意外抛兜底、HSETNX 并发删除重试、repair/drop 分支用例、测试缺口、注释 32→35
    ⇒ 已修/补测；仅「repair 异常仍投递一次」与设计文字一致，无偏离。
  - 复审确认：所有权/CAS/conflict 不直投/unavailable 仍直投/write=false 与 ack=false 语义均正确；
    未发现仍会误删或丢记录的路径。
