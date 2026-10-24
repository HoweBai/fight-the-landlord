# 节奏/清理旋钮管理化（六键进业务配置面）**规格 v1.3（冻结；⚙️2 微审同步）**

> 日期：2026-10-09 · 状态：v1.0 → **r1「有条件通过」全收口（v1.1）** → **r2「可通过（规格可冻结）」**（`review-spec-r1.md` 末尾 r2 节；三条登记级精修已随本版补入） → **规格微审 v1.3（2026-10-09，W1-I1 原型链修复：⚙️2 派发形态逐字同步）** · **契约唯一真源**（实现与判据以本文件为准；设计 = `2026-10-09-interval-admin-design.md` v1.3 冻结 `920d9f8`）
> 行号一律取证于 2026-10-09 HEAD（`920d9f8` 树），实施时复核。

## 0. 一句话

六个「节奏/清理」间隔（env 六项）→ **CONFIG_KEYS 第 35–40 键**；六循环**排期处现读缓存**（下一轮排期即生效、免重启）；env 六行退役；conformance 注入链整体换源为管理面 PUT（还原写知基线值）；`RETIRED_ENVS` +6。

## 1. 上游与裁决（不得与之冲突）

- 设计 v1.3 冻结（`920d9f8`）：D1–D10 + 附录 A/B/C + 修订记录（r1/r2/r3 全收口）。
- 用户裁决（2026-10-09）：Q1 六键全搬 · Q2 进 34 键业务面 · Q3 每轮读取（下一轮排期即生效）。
- 设计在案的实现约束（r2 B1）：快路径真同步 / race 败方定时器显式清除 / `onModuleInit` 同步返回 / 常数落点与「不跨服务抽 helper」。

## 2. 规格正文

### ⚙️1 — 键面（第 35–40 键）逐字

| # | 键名 | 类型 | 界（ms，两端含） | 种子（=缺省） | 可见性 |
|---|---|---|---|---|---|
| 35 | `pay.scanIntervalMs` | int | `1 ≤ n ≤ 600000` | `60000` | 内部（不进 CLIENT_CONFIG_KEYS） |
| 36 | `pay.reconcileIntervalMs` | int | `1 ≤ n ≤ 864000000` | `86400000` | 内部 |
| 37 | `currency.reconcileIntervalMs` | int | `1 ≤ n ≤ 36000000` | `3600000` | 内部 |
| 38 | `risk.scanIntervalMs` | int | `1 ≤ n ≤ 36000000` | `3600000` | 内部 |
| 39 | `risk.devicesCleanupIntervalMs` | int | `1 ≤ n ≤ 36000000` | `3600000` | 内部 |
| 40 | `record.cleanupIntervalMs` | int | `1 ≤ n ≤ 36000000` | `3600000` | 内部 |

- `CONFIG_KEYS` 34 → **40**（追加于 `pay.withdrawTimeoutMinutes` 之后、依上表序）；`CLIENT_CONFIG_KEYS` **14 键零变化**；新键**不复用** `CYCLE_KEYS`（上界不同、族不同）。
- 上界 = 各键 10× 默认（照 `CYCLE_KEYS`「十倍余量」惯例）；下界 = 1 保 env 等价（现行 env 语义即 `>= 1`）。

### ⚙️2 — `parseIntervalMs` 校验契约（protocol/src/config.ts）

- 新族表 `INTERVAL_KEYS`（六键 → 上界，照 ⚙️1）+ `parseConfigValue` 派发（`Object.hasOwn(INTERVAL_KEYS, key)` ⇒ `parseIntervalMs(key, value)`）。
- 校验逐字：`typeof value === 'number' && Number.isInteger(value)` 否则抛 `ProtocolError(\`${key} 必须是整数毫秒\`)`；`value < 1 || value > INTERVAL_KEYS[key]` ⇒ 抛 `ProtocolError(\`${key} 必须在 1 ≤ n ≤ ${上界}（毫秒）范围内\`)`。
- 归一化：无（合法即原值返回）。
- 边界判据：`1` 合法 · 上界合法 · `0` / 负 / `1.5` / 上界+1 / `'3000'`（字符串）/ `null` 拒（`admin.controller.test.ts:138` 系错误文案断言面沿用）。
- 写面路径不变：`PUT /api/admin/config/:key`（policy **P4 = super_admin | operator**，`admin-policy.ts:124-127`）→ 校验 → upsert + version++ → 审计（非密键原文落 `config_changes`）→ `config:changed` 广播。

### ⚙️3 — 种子迁移

- 新文件 `packages/config-service/src/migrations/1794000000000-IntervalConfigSeed.ts`：`INSERT INTO platform_config (key, value, version, updated_at, updated_by) VALUES` 六行（值 = ⚙️1 种子，`version=1`，`NOW(3)`，`'seed'`）；`down` = 删六行（IN 名单逐字六键）。形状逐字照 `1791000001000-PayConfigSeed.ts`。
- `migration.test.ts` 增计数块（照 `:457-508` pay 块先例）：列数=5 · 元组恰 6 · 六键名逐字 · down IN 名单独六。

### ⚙️4 — 三份 `ConfigCacheService`（getter 与常数落点）

| 服务 | 新 getter（+默认常数） |
|---|---|
| user（`packages/user-service/src/config/config-cache.service.ts`） | `riskScanIntervalMs()` +`RISK_SCAN_DEFAULT_INTERVAL_MS=3_600_000` · `devicesCleanupIntervalMs()` +`RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS=3_600_000` · `recordsCleanupIntervalMs()` +`RECORDS_CLEANUP_DEFAULT_INTERVAL_MS=3_600_000` |
| payment（`.../payment-service/src/config/config-cache.service.ts`） | `scanIntervalMs()` +`PAY_SCAN_DEFAULT_INTERVAL_MS=60_000` · `reconcileIntervalMs()` +`PAY_RECONCILE_DEFAULT_INTERVAL_MS=86_400_000` |
| currency（`.../currency-service/src/config/config-cache.service.ts`） | `reconcileIntervalMs()` +`CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS=3_600_000` |

- getter 行为逐字：`snapshot?.['<key>']?.value` 为整数且 `1 ≤ n ≤ ⚙️1 上界` ⇒ 用之；否则（缺键/类型漂移/越界/**快照整体不可用**）回落默认常数——**janitor fail-safe，不照钱面 fail-closed**（设计 D3；注释写明分层理由）。
- **user 缓存补 `hasSnapshot()`**（r1 🟠2a：现文件**缺失**实核——0 命中；payment/currency 两份已有可照搬；⚙️5 快路径六循环统一调它，不补则三循环不编译）。
- 默认常数**迁至**上表 cache 文件（唯一真源）；**loop 文件保留既有导出名 re-export**（`export { … } from '../config/config-cache.service'`），测试引用面免改。
- `SNAPSHOT_BOOT_WAIT_MS = 10_000`：**各服务 cache 文件导出**（三份克隆、注释互指「R96 同源纪律」），首排动作引用之。

### ⚙️5 — 六循环「首排动作」契约（统一形态）

```
onModuleInit(): void {                    // 必须同步返回；浮动续体
  <先置 0 类动作：records「records_cleanup_last_success=0」/ currency「currency_reconcile_last_success=0」/
   risk-scan「risk_scan_last_success=0」——三处保持 T0 同步，顺序即语义；devices/payment 两链无此动作，无此行>
  this.bootFirstScheduling();
}

private bootFirstScheduling(): void {
  if (this.configCache.hasSnapshot()) { this.afterSnapshotReady(); return; }   // 🔴 快路径：同帧，不得经 await/微任务
  let settled = false;
  const settle = (): void => {              // 🔴 once 闸（r1 🟠1）：两路先到先赢，后到者 no-op
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    this.afterSnapshotReady();
  };
  const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);                  // 超时路
  this.configCache.waitForFirstSnapshot().then(settle, settle);               // 就绪路（成功/失败两参同 settle）
}

private afterSnapshotReady(): void {      // 唯一落点（快/超时/就绪 三路共用，且经 once 闸至多一次）
  if (this.shuttingDown) return;          // 续体关停闸
  const interval = this.resolveIntervalMs();   // = cache getter；与「重排处」同一入口
  this.logger.log(<本循环启动行，⚙️6 逐字；interval 位 = 解析值>);
  this.scheduleNext(<首轮延迟见下>);
}
```

- 🔴 **「至多一次」语义逐字不可放宽（r1 🟠1）**：超时路先到、快照 >10s 迟到（`refreshOnce` 先赋 snapshot 再 resolve 等待者 ⇒ 此形态必然可发生）⇒ 就绪路必须 no-op——否则 `afterSnapshotReady` 二次 ⇒ **双排期双链**（关停只能 clear 一个 timer 句柄，另一条链在关停后复活）。
- 首轮延迟：**payment 扫描链 = 解析出的 interval**（维持「首轮=一个完整周期后」现语义）；**其余五链 = 各自常数**（`PAY_RECONCILE_FIRST_RUN_DELAY_MS=30_000` · `CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS=10_000` · `RISK_SCAN_FIRST_RUN_DELAY_MS=30_000` · `RISK_DEVICES_CLEANUP_FIRST_RUN_DELAY_MS=30_000` · `RECORDS_CLEANUP_FIRST_RUN_DELAY_MS=30_000`）——常数不动。
- 等待超时（降级拓扑）= 按缺省解析 + 照常打行排期；下一轮重排自愈（重排处现读）。
- 伪代码为**语义契约**：实现形态自选（服务内私有小函数允许），但**真同步 / once 闸（含败方清理）/ `onModuleInit` 同步返回**三条逐字不可放宽。

### ⚙️6 — 启动行逐字（判据物；值 = 解析值）

| 循环 | 启动行（现格式**逐字不变**，仅值来源变） |
|---|---|
| payment 扫描 | `Payment scan loop started (first round in <v>ms; loops: ① closeExpired ② sweepCreated ③ creditPending ④ resolveHolding ⑤ rollbackTimeout ⑥ refundResolveHolding ⑦ refundRollbackRecovery ⑧ refundUnknownReplay)` |
| payment 日自检 | `Payment reconcile loop started (first run in 30000ms, interval <v>ms; 入账勾稽 + 锚勾稽 ⇒ payment_reconcile_diff)` |
| currency 对账 | `Currency reconcile loop started (first run in 10000ms, interval <v>ms)` |
| risk 扫描 | `Risk scan loop started (first run in 30000ms, interval <v>ms)` |
| 设备清理 | `Risk devices cleanup loop started (first run in 30000ms, interval <v>ms)` |
| 记录清理 | `Records cleanup loop started (first run in 30000ms, interval <v>ms)` |

（五循环半句前缀以现文件逐字为准——上表只钉 `<v>` 位=解析值这一契约。）

### ⚙️7 — 重排现读与删除物

- 六循环 `scheduleNext(...)`/`scheduleNextReconcile(...)` 的调用点：`this.intervalMs`（四链 readonly 字段）或 `scanIntervalMs()`/`reconcileIntervalMs()`（payment 两链 env-resolve 函数）⇒ 统一改为**本服务 resolve 方法**（内部 = 对应 cache getter）。
- **构造注入（r1 🟠2b 补列）**：payment `ScanService` **+ `ConfigCacheService`**（现构造五依赖无它）；currency `ReconcileService` **+ `ConfigCacheService`**（现构造 = DataSource + Redis）。两服务 `ConfigModule` 均已在 `app.module` imports（payment `:46` / currency `:63`，`WalletController`/`OrdersService` 先例）——**值导入纪律**（DI 陷阱）；可见性以真容器启动实证为准（实施时 `docker compose up` 自证）。
- 删除物：四链 `private readonly intervalMs = Number(process.env.X) || …` 字段；payment 两 resolve 函数的 **env 读体**（导出面与调用点形态自选，测试引用面随迁——`scan.test.ts` 15 处 / `reconcile.test.ts` 18 处 / currency 两 test / user 三 test）。
- 保留物（逐字不动）：首轮延迟常数 · 关停闸 · 失败姿态与日志 · 指标写点与先置 0 · 批删/锁定/勾稽等一切轮内语义 · 多实例口径。

### ⚙️8 — env 退役与编排面

1. `docker-compose.yml` 删行：payment `:366-367`（两行；**`:359-365` 支付段注释块随删失真需一并改写**——r2 登记）· user `:178` + `:183-184`（三行；`:181-182` 注释段重写）· currency `:321`；`:352` 附近「26–34 键」注释句订正。
2. `conformance-stack.sh`：删 `:53-54` 两 export；渠道种子段后追加**六键种子**（`pay.scanIntervalMs=2000` / `pay.reconcileIntervalMs=2000` / 四键 `3600000`），经**新助手** `config_seed_put`（与渠道 `seed_put` 并列）：
   - 端点 `/api/admin/config/<encodeURIComponent(key)>`；body = `{"value": <JSON 数字>}`（**数值版构造**——现有 `seed_put` 的 `SEED_VAL` 恒为 JSON 字符串，`parseIntervalMs` 会拒字符串；不得照抄）；
   - 失败 ⇒ **响亮 exit 1**（照渠道种子同款纪律）；登录/网关地址/重试设施复用现段。
   - 注释段（`:36-46`）重写：两 export 语义退役 ⇒ 六键基线供给点 = 管理面种子。
3. `RETIRED_ENVS`（`packages/shared/test/design-md-ai-rollout.gate.test.ts:94-109`）**追加六条**（`PAY_SCAN_INTERVAL_MS` · `PAY_RECONCILE_INTERVAL_MS` · `CURRENCY_RECONCILE_INTERVAL_MS` · `RISK_SCAN_INTERVAL_MS` · `RECORDS_CLEANUP_INTERVAL_MS` · `RISK_DEVICES_CLEANUP_INTERVAL_MS`）+ 闸注释更新（「退役的守卫也机械化」；§2.3 已核零命中）。
4. `tools/conformance/src/run.ts` **不动**（六键不在 `??=` 面——声明性核销）。
5. **六 env 全仓清零核销（r1 🟡4；r2 措辞精修）**：树内 grep 六 env 名的期望残余 = **仅三类：「注册点」本体（`RETIRED_ENVS` 数组 + 闸注释——实现后必然含六名，须白名单）· 历史案卷（`docs/superpowers/**` 旧片）· 本片文档自身**；已知随 ⚙️9 一并清的 `step`/`info`/注释串（行号=HEAD，实施复核）：slice-15:690 · slice-17:1042 · slice-18:51 · slice-20:11/28/42/860 · slice-21:11-12 头注/881-883 注释 · slice-22:996-999 info——**逐片列入 plan 核销表**（`RETIRED_ENVS` 闸只扫 design.md §2.3，不扫树 ⇒ 此项不做就静默留陈）。

### ⚙️9 — conformance 迁移（逐片契约）

**统一形态**：`PUT 注入值 → GET 确认=注入值 → 重建目标容器 → 观测（判据不变）→ PUT 还原到知基线值 → GET 确认=基线 → 重建`。基线：pay 两键=**2000**（stack 种子段）· 四键=**3600000**（种子=缺省）。GET 确认是标准形态组成部分（防 PUT 静默失败；r2 🔴1(b) 裁定）。

| 片 | 现位置（HEAD） | 迁移后逐字契约 | 判据迁移 |
|---|---|---|---|
| slice-15 | `:691`/`:906` | 注入=`PUT record.cleanupIntervalMs=3000`+重建；还原=`PUT 3600000`+重建（均含 GET 确认） | 无 env/启动行断言（已核）⇒ 观测（清理轮删除行为）不变；`:727` 注释「≤30s 上界」→「≤40s」（等待预算） |
| slice-17 | `:1043`/`:1131`/`:1260` | 同形（`currency.reconcileIntervalMs` 3000↔3600000） | ⑨ 观测（runs≥2/last_success 前进）不变；窗口 `:1047-1056` 复算 |
| slice-18 | `:1295`/`:1332`/`:1386` | 同形（3000↔3600000） | 观测不变；`:855-856` 计数 34→40；90s 窗复算 |
| slice-20 | `:861`/`:978`/`:1294` | ④=`PUT risk.scanIntervalMs=5000`+重建；还原=`PUT 3600000`+重建；finally 兜底=PUT 基线 | **④ `:865-873` 与还原侧 `:982-992` 启动行断言逐字不变**（`interval 5000ms` / `interval 3600000ms`；仅通道换）；`:676-680`/`:131` 计数 34→40 |
| slice-20 新增 | **位置钉死：④ 之后、⑤ 之前**（r1 🟡5；④ 的降阈/复原闭环已完成、重建不扰——条目/旗跨重启存续已核；⑤ 起点的慢扫描态由本小组还原基线提供） | **设备清理节奏**：`PUT risk.devicesCleanupIntervalMs=5000`+GET 确认+重建 user-service → 观测**心跳日志 ≥2 行**（每行 `risk devices cleanup`，无指标——`:56`；**观测窗 ≥45s** = 30s 首轮 + 5s 间隔 + 重建等待 ≤10s 留量）→`PUT 3600000`+GET 确认+重建 | 新判据（含「还原后新启动行 `interval 3600000ms`」1 条）；第 6 键首获端到端 |
| slice-21 | ⓪ `:557` / ① `:581-592` / ⑬ `:881-910` | ⓪ 删 env 断言 ⇒ **归一**：`PUT pay.scanIntervalMs=2000` + `PUT pay.reconcileIntervalMs=2000`（照 `:574-578` 先例）+ 重建 payment-service + 启动行自证（`first round in 2000ms`）；① 块扩**十一键**（+`cfgOf('pay.scanIntervalMs')===2000`、+`===2000`；文本注明「两键=stack 种子基线，非出厂种子」）；⑬ `recreatePaymentServiceWithScanInterval(v)` 改「PUT v + 重建」（冻扫 `first round in 600000ms`；还原 PUT 2000 + 启动行 `first round in 2000ms` 替 `:909` env 断言）；窗口 `:1095` ⑯ 45s 复算 | ② 观测路径自证句（env 实读 → config 实读 + 启动行口径）；「⑨⑩⑫⑯ 观测路径由此可执行」论证句同口径改写 |
| slice-22 | ⑨ `:996-999`/`:1009`/`:1013-1014`/`:1048`/`:1052`；计数 `:808`/`:812-816`/`:988`/`:1034` | 删两键 `pickEnv` 保存与 compose 随行透传（`ADMIN_PASSWORD` 链逐字保留）；`:1013-1014`/`:1052` 替换为「窗口②/恢复② 重建后**启动行** `first round in 2000ms`」（观测路径不被重建破坏——对象不变；净条数按实测回填）；计数 34→40（**含 `:812-816` 硬断言——r1 🟡3 补列**） | 保真对象不变、来源换 config |
| slice-23 | `:27`/`:731`/`:735`/`:1237` | 计数「恰 34」→「恰 40」 | 纯计数 |

### ⚙️10 — 键面全量同步（实施核销；行号=HEAD 取证）

- **硬断言**：`protocol/config.test.ts:9-28`（数组+文案+新 parse 用例族）· `config-service/test/platform-config.service.test.ts:200-249 SEED/296-297/303-337` · `test/helpers/config-probe.ts:139-185`（**假库第二副本：与上一份 SEED 同源更新——严格读取纪律**）· `admin.controller.test.ts:169-223` · `config.rpc.test.ts:99-158`（`:528-551` 通知片第⑥不动）· `client-config.test.ts:92`（文案核）· `migration.test.ts`（⚙️3 新块）。
- **conformance 计数**：slice-18:8/855-856 · slice-20:5/131/676-680 · slice-22:28/808/**812-816**/988/1034 · slice-23:27/731/735/1237。
- **admin 页**：`CONFIG_NOTES` +6 条（下附逐条）+ 计数注记**六处**（`:134-137`/`:290` + `:110`/`:124`/`:607`/`:623`）+ 横幅**两变体**（`:743`「已保存（版本 N）；各服务 ≤60s 内生效」→「已保存（版本 N）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）」；`:746`「推送失败，将在 ≤60s 内经安全网生效」→「推送失败，安全网将在 ≤60s 内拉到新值（节奏类键自下一轮排期起生效）」）。
- **CONFIG_NOTES 六条（四段式；语义钉死、措辞可微调）**：
  - `pay.scanIntervalMs`：作用=支付扫描周期——八条补偿循环（过期关闭/重放入账/④⑤⑥⑦⑧）的统一节奏；取值=整数毫秒，1 ≤ n ≤ 600000（上限 10 分钟）。默认 60000（60 秒）；生效=保存后 payment-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，**下一轮排期起用新值**；注意=改小=补偿更及时；改大=卡住的单收敛更迟。
  - `pay.reconcileIntervalMs`：作用=支付日自检周期——入账勾稽 + 锚勾稽（钱的事故面第一道铃）；取值 1 ≤ n ≤ 864000000（上限 10 天），默认 86400000（24 小时）；生效同上；注意=启动后 30s 照跑首轮。
  - `currency.reconcileIntervalMs`：作用=货币对账周期——账实相符/缓存漂移自愈/孤儿诊断；取值 1 ≤ n ≤ 36000000（10 小时），默认 3600000（1 小时）；生效同上；注意=启动后 10s 首跑。
  - `risk.scanIntervalMs`：作用=风控扫描周期（内置闸 + 双谓词判定）；取值同（默认 1 小时）；生效同上；注意=启动后 30s 首轮；多实例有锁。
  - `risk.devicesCleanupIntervalMs`：作用=风控设备记录清理周期；取值同（默认 1 小时）；生效同上；注意=按 `risk.deviceRetentionDays` 保留期批删。
  - `record.cleanupIntervalMs`：作用=对局记录保留期清理周期；取值同（默认 1 小时）；生效同上；注意=保留天数在 `record.retentionDays` 单独调。
- **文档面**：`docs/design.md` —— `:1140-1177` 键表 +6 行（第 35–40 键）· `:1179` 消费者段（payment/user/currency 句按 40 键现状补述）· `:1180`「四个周期键」→十个（4 既有 + 6 本片）· `:1185` 横幅锚述句（同新文案）· `:1207`/`:1218`「34 键面 12 处硬断言零改动」→「业务键面（本片起 40 键）零改动」口径 · `:1300` `PAY_RECONCILE_INTERVAL_MS` 句改指 `pay.reconcileIntervalMs` 配置键 · 计数句（`:142/408/492/499/1409/1558/2033` 择「陈述现状」者改）；`docs/ops/first-deploy.md:992-1026` 一览表 +6 行 + `:982-983`/`:985-986` 横幅两处同句订正 + 「节奏旋钮怎么调」一句（管理页改、**下一轮排期即生效**、已排定一轮不撤）；`docs/client-protocol.md:54` 视句义核改。
- **注释面**（口径 = 树内 grep「**三十四|34 键**」扫全——r1 🟡6 订正，两形态都扫）：protocol `config.ts:3` · **「34 键」形态八处（r1 🟡6 补列）：protocol `pay-channel.ts:4`/`pay-channel.test.ts:4-5,27`/`notify-channel.ts:4`/`notify-channel.test.ts:4-5,40` · config-service `pay-channel.service.ts:36`/`notify-channel.service.ts:38` · slice-18:106** · config-service src 五处/test 三处 · user/robot/room config 注释 · `1789100000000-BaseScoreLevels.ts:7` · `rpc.options.ts:35` · `gateway.controller.ts:127` · `conformance/lib/http.ts:248` · 各片头注（slice-14:64 核销留陈·slice-18:8·slice-20:5·slice-22:28·slice-23:27）· 六循环类注 env 口径句 · compose `:352`；`design.md:1177`「支付第 34 键」无需改。

## 3. 判据计划（§5 式）

- **P1 protocol**：⚙️2 边界族（合法 1/上界/典型；0/负/1.5/上界+1/字符串/null ⇒ 抛 + 文案）+ 40 键清单 + 客户端 14 零变化。
- **P2 config-service**：⚙️3 迁移计数 · SEED 双副本 40 · 平台服务 list/值 · 管理面 GET 40 名单 · PUT 六键各一（200 + 审计行原文落痕）· RPC 快照 40 · `client-config` 文案。
- **P3 缓存**：六 getter 三态（合法/缺键/越界回落默认）；`SNAPSHOT_BOOT_WAIT_MS` 三份同值自证。
- **P4 六循环（单测）**：env 注入用例迁移为假缓存注入（**fake cache 接口面须扩**：+`hasSnapshot→true`、+`waitForFirstSnapshot→resolved`——现全为 min-mock）· **「重排现读」每循环 ≥1**（fake timers：一轮后改假值 ⇒ 下一轮延迟=新值）· **「首排动作」每循环 ≥1**（快路径同帧[真同步]；晚到 ⇒ 续体用配置值且败方 timer 已清；超时 ⇒ 缺省；**超时后快照迟到 ⇒ 恰一次排期（once 闸，r1 🟠1）**；续体关停闸不排）· 启动行=解析值断言。
- **P5 conformance**：⚙️9 迁移逐片 + 新设备小组 + slice-21 ⓪/①/⑬ + 计数回填 + 窗口复算（slice-15 ≤40s / 17 / 18 / 20 双侧 30s / 20 新小组 ≥45s / 21 ⑯ 45s）。
- **P6**：六阶段（`bash scripts/ci.sh`）+ 全序（28 片）+ baselines 实测回填（下调需提交理由）。

## 4. 边界与错误语义

- 写不合法 ⇒ 400 + ⚙️2 文案；写合法 ⇒ 生效语义 = **已排定的一轮不撤；其后按现读值排期**（最坏 = 一个旧间隔 + 新间隔）。
- getter 回落 = 代码默认（含快照整体不可用——janitor fail-safe；与钱面 fail-closed 分层写在注释）。
- 启动竞态：⚙️5 有界等待（≤10s）+ 自愈；还原侧假绿窗有 GET 确认兜底（⚙️9）。
- 残留收拢：stack 种子段六键归一（每次 `up`）+ 切片还原写基线（不写现值）+ slice-21 ⓪ 归一。
- 混部：新键旧画像不消费（envelope 无害）；旧 compose 行删除对生产零影响（六键从未设过）。

## 5. 文档与台账

- ⚙️10 文档面全清单；`deviation-ledger.md` 新条目（六 env 退役、compose 六行删、四片注入语义退役、`RETIRED_ENVS` 加列、slice-22 透传面替换——本片偏离集中登记）。
- 交接文档（片收口时写）：`docs/superpowers/plans/2026-10-09-post-interval-admin-handoff.md`。

## 6. 测试 env 面变更

- **退役**：六 env 名（全仓除历史案卷外清零——compose/stack.sh/单测/规则句全链；`RETIRED_ENVS` 拦截回流）。
- **不动**：`CONFIG_SYNC_SAFETY_NET_MS` / `CONFIG_SYNC_DISABLE_PUSH`（仍仅测试注入）· `PAY_CONFIG_ENC_KEY` / 两 PULL_TOKEN / `ADMIN_PASSWORD`（stack 供给链照旧）· run.ts 全部 `??=`。

## 附录 A — 判据核销表（旧→新）

| # | 旧判据（对象） | 处置 |
|---|---|---|
| 1 | 六 env「空串=未设/非法回落默认」语义用例（scan.test 等） | **退役**（对象=env 解析，随 env 退役）；替代 = P3 getter 三态 + P4 首排/重排（覆盖同语义面：缺省回落 + 动态改值） |
| 2 | slice-15/17/18 注入/还原重建（env 通道） | 换源 PUT+基线（⚙️9）；观测判据逐字保留 |
| 3 | slice-20 ④/还原 启动行断言 | **逐字保留**（通道换；值来源=config） |
| 4 | slice-21 ⓪ env 实读自证 | 替换 = 归一 PUT + 重建 + 启动行 `first round in 2000ms` 自证（观测路径可执行性对象不变） |
| 5 | slice-21 ⑬ env 实读（`:909`） | 替换 = 启动行 `first round in 2000ms` |
| 6 | slice-22 ⑨ env 透传保真（`:1013-1014`/`:1052`） | 替换 = 重建后启动行 `first round in 2000ms`（对象「观测路径不被重建破坏」不变；净条数实测回填） |
| 7 | `containerEnv` 六键断言（全仓） | 退役（env 不再存在；`RETIRED_ENVS` 拦截回流） |

## 附录 B — 六循环现状→目标速查

| 循环 | 现状读法（HEAD） | 目标 | 首排 | 启动行 |
|---|---|---|---|---|
| payment 扫描 | 每次重排读 env（`:84-87/:256/:289`） | 排期处现读 getter | ⚙️5（首轮=解析 interval） | ⚙️6 |
| payment 日自检 | 每次重排读 env（`:106-109/:263/:307`） | 同 | 30s 常数 | ⚙️6 |
| currency 对账 | 构造期一次（`:185-186/:235/:246`） | 同 | 10s 常数 | ⚙️6 |
| risk 扫描 | 构造期一次（`:130-131/:148/:170`） | 同 | 30s 常数 | ⚙️6 |
| 设备清理 | 构造期一次（`:67-68/:79/:101`） | 同 | 30s 常数 | ⚙️6 |
| 记录清理 | 构造期一次（`:84-85/:99/:123`） | 同 | 30s 常数 | ⚙️6 |

---

## 自检（防审出低级项）

- 六键默认/上界与设计 ⚙️1 逐字一致；`600000` = slice-21 ⑬ 冻结值顶格合法。
- 启动行表（⚙️6）与设计 §2.4 一致；slice-20 双向断言「逐字不变」两处（`interval 5000ms`/`interval 3600000ms`）在 ⚙️5 机制下真红/真绿路径成立。
- 四键还原基线 3600000 = 种子值（slice-15/17/18 对 `3600000` 零命中已核——还原不触其它断言）。
- 「假库第二副本」双 SEED 同源（platform-config.service.test + config-probe）在 ⚙️10 显式点名。
- `run.ts` / `NEW_ENVS` / slice-14 / mock-server / apps/client 五个「疑似涉点」逐条声明不涉。

## 修订记录（v1.0 → v1.1；报告 `review-spec-r1.md`，r1 结论 = 有条件通过）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 🟠1 | 重要 | ⚙️5「两路汇一」缺「至多一次」——超时后快照迟到 ⇒ 双排期双链（关停只清一个句柄） | ⚙️5 伪代码改 **once 闸 `settle()`**（先到先赢、后到 no-op、败方定时器清除）；「至多一次」列入不可放宽三条；P4 增「超时后快照迟到 ⇒ 恰一次排期」用例 |
| 🟠2a | 重要 | user 缓存**缺 `hasSnapshot()`**（⚙️5 三循环统一调它 ⇒ 不补不编译） | ⚙️4 补列「user 缓存补 `hasSnapshot()`」（payment/currency 已有可照） |
| 🟠2b | 重要 | payment/currency 两服务**需新增 `ConfigCacheService` 构造注入**未列 | ⚙️7 补列（含值导入纪律与 app.module 可见性实证要求） |
| 🟡3 | 次要 | slice-22:812-816「snapshot 恰 34 键」硬断言漏列 | ⚙️9/⚙️10 计数清单补列 |
| 🟡4 | 次要 | 六 env「全仓清零」无核销清单（残留 ~20 处） | ⚙️8-5 补核销清单（逐片残留点 + plan 核销表要求） |
| 🟡5 | 次要 | slice-20 新小组位置留白 + 观测窗数字缺失 | ⚙️9 钉死「④ 后、⑤ 前」+ 观测窗 ≥45s；P5 窗口复算补入 |
| 🟡6 | 次要 | 注释面 grep 口径丢「34 键」形态（8 处未入清单） | ⚙️10 口径改「三十四\|34 键」+ 八处补列 |
| ⚪7 | 观察 | 「② Ⓡ」记号未定义 | ⚙️9 改「② 观测路径自证句（env 实读 → config 实读 + 启动行口径）」（P5 同词同步） |

### v1.2 → v1.3（规格微审；报告 `review-wave1.md` W1）

- 规格微审 v1.3（2026-10-09）：⚙️2 派发形态 ✕ `key in INTERVAL_KEYS` ⇒ ✓ `Object.hasOwn(INTERVAL_KEYS, key)`（W1 评审 I1 原型链实测修复）。
- 实现期勘误（2026-10-10，W5 波审登记）：⚙️9 slice-21 行「计数 `:988/:1034`」为**文本残留**（那两处属 slice-22 行；T14 无应改未改 —— HEAD 该两行无任何 34-计数）⇒ 勘误删除该片段（契约/判据零变更）。
