# 节奏/清理旋钮管理化（六键进业务配置面）**设计层 v1.3（冻结）**

> 日期：2026-10-09 · 状态：r1 全收口 → r2「有条件通过」全收口 → **r3「可通过（设计可冻结）」**（`review-design-r2.md` 末尾 r3 节；唯一登记级补列已随本版补入）· 关键数字以本文件为准（用户三裁决已入 §7）· 上游：`docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md` §8 第二梯队 + §「顺手清理项」；
> `docs/superpowers/specs/2026-10-06-pay-channel-admin-design.md` 附录 A/B；`docs/superpowers/plans/2026-10-07-post-notify-channel-handoff.md`。
> 行号一律取证于 2026-10-09 HEAD。

## 0. 一句话

把六个「节奏/清理」间隔环境变量（支付扫描/支付日自检/货币对账/风控扫描/风控设备清理/记录清理）从 `.env`（构造期一次读、改值须重启）搬进 **config-service 业务配置面（CONFIG_KEYS 第 35–40 键）**，六循环改为**每次排期现读配置缓存**——改键走管理页、无需重启、下一轮排期即生效；env 六行退役，conformance 注入链整体换源为管理面 PUT。

## 1. 输入

### 1.1 用户裁决（2026-10-09，逐条，本文全部设计不得与之冲突）

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | 搬迁范围 | **六键全搬**（否决「只搬生产可调的 PAY_SCAN/PAY_RECONCILE 两键」——键面代价两案相同，拆开做等于日后重做） |
| Q2 | 目标键面 | **进 34 键业务面（CONFIG_KEYS）**（否决「独立第四键空间（pull 型）」——对非密旋钮是重型工程且丢掉广播即时刷新） |
| Q3 | 改动生效语义 | **每轮读取：下一轮排期即生效**（否决「重启生效」与「变更事件即重排」） |

搭车建议（默认执行、非裁决项）：本机根 `.env` 遗留副本删除（**所列 8 行**：`DB_HOST/PORT/USER` + 四个 `*_SERVICE_URL` + `DOUZERO_URL`——已核确不被 compose 插值；r1 ⚪14 订正：文件共 18 行，另有 `DB_PASSWORD`/`DB_NAME`/`JWT_SECRET` 三行**被插值**〔值=默认故无害〕⇒ **不动**）；**本片零服务器 `.env` 动作**（六键生产从未设过）。

### 1.2 既有约束（本仓纪律，逐条适用）

- 判据只增不减；任何下调在提交信息写明理由（`tools/conformance/baselines.json:2`）。
- 「同一事实两处实现」须同源同步（假库双副本 / stack.sh 与 run.ts 双供给点同族教训 R96）。
- 六阶段（`bash scripts/ci.sh`）与 conformance 全序为交付闸；静态切片回填免首跑红仪式。
- 每波一次审、报告只写发现；终审 opus（token 口径）。

## 2. 现状（实测事实，带出处）

### 2.1 六键今天的形态

| env（`docker-compose.yml` 空默认透传行） | 消费循环（读点=HEAD 行号） | 读法 | 首轮延迟 | 默认（ms） |
|---|---|---|---|---|
| `PAY_SCAN_INTERVAL_MS`（:366） | payment `ScanService` 扫描链（`scan.service.ts:84-87` resolve；`:256/:289` 调用） | **每次重排现读**（但读 process.env） | 无（首轮=一个完整周期后，`⚙️16`） | 60,000 |
| `PAY_RECONCILE_INTERVAL_MS`（:367） | payment `ScanService` 日自检链（`:106-109` resolve；`:263/:307`） | 每次重排现读（读 env） | 30s（`PAY_RECONCILE_FIRST_RUN_DELAY_MS:93`） | 86,400,000 |
| `CURRENCY_RECONCILE_INTERVAL_MS`（:321） | currency `ReconcileService`（`:185-186` 构造期读；`:235/:246` 用字段） | **构造期一次** | 10s（`:198`） | 3,600,000 |
| `RISK_SCAN_INTERVAL_MS`（:183） | user `risk/scan.service.ts`（`:130-131` 构造期读；`:148/:170`） | 构造期一次 | 30s | 3,600,000 |
| `RISK_DEVICES_CLEANUP_INTERVAL_MS`（:184） | user `risk/devices-cleanup.service.ts`（`:67-68`；`:79/:101`） | 构造期一次 | 30s | 3,600,000 |
| `RECORDS_CLEANUP_INTERVAL_MS`（:178） | user `records/records-cleanup.service.ts`（`:84-85`；`:99/:123`） | 构造期一次 | 30s | 3,600,000 |

- 口径一律 `Number(process.env.X) || 默认`（空串=未设、`||` 语义）；生产 compose 空默认透传、**生产不设** ⇒ 全部走默认。
- 语义结论：**今天六键全为「重启才变」**（payment 两链虽现读，读的是进程 env——值在容器生命周期内不变）。
- 六键**无任何客户端/运维文档面**：`docs/ops/*` 零提及；`docs/design.md:1300` 一处提及（`PAY_RECONCILE_INTERVAL_MS`）。

### 2.2 业务配置面（34 键）与广播缓存机制

- 键面 = `packages/protocol/src/config.ts:14-74`（34 键）· 客户端子集 `:77-93`（14 键）· 写校验唯一入口 `parseConfigValue` `:146-175`（未知键抛 `未知配置键`）。
- 写路径：`PUT /api/admin/config/:key`（**网关 policy P4 = super_admin | operator**，`api-gateway/src/auth/admin-policy.ts:124-127`；⚠️ v1.0 曾误引 `gateway.controller.ts:159`——那是 pay-channel 块的注释；反证 `slice-23:974`「operator PUT 同路径 ⇒ 400（P4 放行到下游、未知键 400 拦）」）→ protocol 校验 → upsert + version++ + 审计（`config_changes`）→ Redis `config:changed` 广播 → 各服务 `ConfigCacheService` 重拉全量（推送 + 60s 安全网；模板见 `payment-service/src/config/config-cache.service.ts:130-456`）。
- 五服务各有自己的缓存副本（room/robot/user/currency/payment）；**本片只动 user（+3 getter）/ payment（+2）/ currency（+1）** 三份，形态照既有 getter（键级验证 + 代码默认回落，例 `:197-199`）。
- `waitForFirstSnapshot()` 五份模板均有（测试把手）：user `config-cache.service.ts` / payment `:327` / currency `:193`。
- 种子 = 每片一条迁移（`INSERT INTO platform_config … 'seed'`，最近 = `1791000001000-PayConfigSeed.ts`）；迁移计数测试在 `config-service/test/migration.test.ts:457-508` 一族。
- 管理页（仓根 `admin/app.js`）第一页签**由 API 驱动全量渲染**（`renderKeyList()` `:624-647`，不硬编码）；`CONFIG_NOTES` `:139-346` **恰 34 条**（维护注记 `:134-137`/`:290`）——加键后页面不红，仅缺备注块。

### 2.3 conformance 现行注入链（迁移面实况）

- `scripts/deploy/conformance-stack.sh`：仅 export 支付两键（`:53-54`）。其余四键**不在 stack 级**——各切片在运行中以「内联 compose env + `--no-deps` 重建」注入、用完还原（空串复原）。
- `tools/conformance/src/run.ts` 的 `??=`（`:134-144`）只有 `PAY_CONFIG_ENC_KEY` + 两枚 PULL_TOKEN —— **六键不在其中，本片不涉**。
- 六个「重建点」（注入/还原/finally 兜底）：
  - slice-15（records）：`:691` 注入 / `:906` 还原；
  - slice-17（currency）：`:1043` 注入 / `:1131` 还原 / `:1260` finally；
  - slice-18（currency）：`:1295` 注入 / `:1332` 还原 / `:1386` finally；
  - slice-20（risk scan）：`:861` 注入 / `:978` 还原 / `:1294` finally；
  - slice-21（payment）：stack export 供 2000 基线；⓪ `:557` env 实读自证；⑬ `:881-909` 冻结（重建 `600000`）/还原（`:909` env 断言 2000）；
  - slice-22（pay-channel）：⑨ `:996-1014`（`pickEnv` 保存 + 每次重建随行透传 + 保真断言）、`:1048-1052` 恢复②、`:1131` 重建段。
- 🔴 `RISK_DEVICES_CLEANUP_INTERVAL_MS` **零 conformance 覆盖**（仅单测）——本片借机补最小端到端（见 D6）。
- 键面计数面（「恰 34」）：slice-18:855-856 · slice-20:130-131/676-680 · slice-22:808/812-816/988/1034 · slice-23:731/735/1237/1283（slice-14 **不数 34**；slice-17:1229 是客户端 14 键 CSV，与本片无关；mock-server 断言自持 7 键契约、不涉）。

### 2.4 启动竞态（新发现，设计必须处理）

`ConfigCacheService` 首拉是**异步**（不阻塞就绪，失败 1s 退避重试）；payment 扫描链「首轮 = 一个完整周期后」⇒ 若重建后首排期时快照未就位，首轮会落**默认 60000** 而不是配置值 2000 —— slice-21/22 的秒级观测窗在每次 payment-service 重建后当场红。其余五循环首轮是**常数延迟**（10s/30s），首读发生在首轮完成后（≥10s），快照几乎必然已就位——但尾部竞争仍需显式处置（见 D2）。

**判据面（r1 订正）**：
- **逐轮日志行真有**：五处——`records cleanup done: …` · 货币对账摘要行 · 风控扫描轮行 · 设备清理轮心跳行 · `payment reconcile done: …`；**payment 扫描链无每轮成功行**（只有启动两行 + 动作行〔入账/重放逐条〕+ 失败 catch 行），其节奏观测物 = **动作行为/状态推进**（既有切片观测形态）+ 重建后启动行。
- **启动行格式（判据物，逐字；r1 🔴1 取证）**：五循环 `… loop started (first run in <首轮>ms, interval <解析值>ms)`——**T0 同步打印**（改造前=构造期 env 值，改造后若不动形态=打印缺省，**判据不可依** ⇒ D2 首排动作）；payment 扫描链 `Payment scan loop started (first round in <解析值>ms; …)`——**无 `interval=` 字样**。⇒ 判据物 = **重建后新启动行**（与 slice-20 ④ `:865-873` 现行 poll 形态逐字兼容）。
- 指标面：records/currency/risk-scan/payment-reconcile 各有轮级写点；**payment 扫描链与设备清理无轮级 run 指标**（设备清理 `devices-cleanup.service.ts:56`「本任务不挂指标」）。

## 3. 设计决策

### D1 — 键面归属与命名/界（第 35–40 键）

| 新键 | 默认（=种子） | 界（ms，两端含） | 上界理由（10× 默认，照 `CYCLE_KEYS` 十倍余量惯例，`config.ts:122-123`） |
|---|---|---|---|
| `pay.scanIntervalMs` | 60,000 | 1 ≤ n ≤ 600,000 | 10×；且 = `CYCLE_KEYS` 上限（`slice-21` ⑬ 冻结值 600000 恰好顶格可用） |
| `pay.reconcileIntervalMs` | 86,400,000 | 1 ≤ n ≤ 864,000,000 | 10× |
| `currency.reconcileIntervalMs` | 3,600,000 | 1 ≤ n ≤ 36,000,000 | 10× |
| `risk.scanIntervalMs` | 3,600,000 | 1 ≤ n ≤ 36,000,000 | 10× |
| `risk.devicesCleanupIntervalMs` | 3,600,000 | 1 ≤ n ≤ 36,000,000 | 10× |
| `record.cleanupIntervalMs` | 3,600,000 | 1 ≤ n ≤ 36,000,000 | 10× |

- 命名照近邻先例（`robot.reclaimIntervalMs` / `room.matchScanIntervalMs`）；`record.` 用单数（域键 `record.retentionDays` 已立）。
- 校验：protocol 新 **interval 族**（`INTERVAL_KEYS` 上界表 + `parseIntervalMs`：int 且 `1 ≤ n ≤ 上界`；**不复用** `CYCLE_KEYS`——上界不同、语义族不同）。下界 = 1 保 **env 等价**（现行 env 语义即 `>=1`；六片注入值 2000/3000/5000 全在域内）；「防热循环抬到 1000」**不做**（YAGNI，改动语义面）。
- 六键**不进** `CLIENT_CONFIG_KEYS`（内部键，客户端零变化；`client-config.controller.ts` 兜底面不动——仅需核文案）。
- **权益面：显式决策 = 零改动**。写面 = 既有 **P4（super_admin | operator，`admin-policy.ts:124-127`）**。裁决：六键与既有周期键（`robot.reclaimIntervalMs` / `room.*IntervalMs` 等）**同族同权**，沿用 P4（operator 可写；非密、可审计、可回滚）；收窄为 super_admin 会是首例且无威胁面理由（若需收窄 = 一行 policy，另立裁决）。对比 pay/notify 两片的 E′-类裁决——本片不需要。

### D2 — 生效语义：每轮读取（Q3 裁决落地）

- 六循环统一改**「排期处现读」**：删除 `readonly intervalMs`（构造期 env 读）或 env resolve 函数体，换成排期时调用本服务 `ConfigCacheService` 的键级 getter；`scheduleNext(this.xxxIntervalMs())`。
- 语义表述（入手册）：**已排定的一轮不撤；该轮跑完按现读值排下一轮** ⇒ 改键最坏在「当前已排间隔 + 新间隔」内生效，生产免重启。广播 ⇒ 缓存秒级刷新；安全网 ⇒ 最坏 60s 陈旧。
- **首轮延迟两常数不动**（10s/30s 两组，注入无关的既有口径）。
- 🔴 **六循环统一的「首排动作」（r1 🔴1 修）：有界等首快照 → 解析 → 打启动行 → 排首轮**。`onModuleInit`：`hasSnapshot()` 已就绪 ⇒ 同帧解析（快路径）；否则 `Promise.race([waitForFirstSnapshot(), sleep(SNAPSHOT_BOOT_WAIT_MS)])` 续体解析（常数 10_000，导出供测试）。续体**先查 `shuttingDown`**（照关停闸纪律；r1 ⚪13）再打/排。等待发生在**为定时器排期**而非就绪面（不阻塞容器 readiness）；降级拓扑（配置服务不可用）⇒ ≤10s 后按缺省解析打印 + 排期，下一轮重排自愈。
  - 动机一（阻断项）：**启动行是 conformance 的判据物**（§2.4/附录 B）——解析+日志移入续体后，重建后新启动行逐字携带**解析后的配置值**（五循环 `interval <值>ms`；payment 扫描 `first round in <值>ms`），「注入生效/还原生效」两侧观测物的**形态与 slice-20 ④ 现行 poll 逐字兼容**。（v1.0 的「日志在 T0 同步打印配置值」不可成立——不改形态必打缺省。）
  - 动机二：五循环原「首读发生在首轮完成后 ≥10s、竞态窗口可忽略」的尾不为零（配置服务慢启/重建风暴）⇒ 统一等待把「首轮锚」与「判据锚」合并为一处，六循环形态只有一种。
  - 残留风险（登记）：等待超时窗口内启动行落缺省值——注入侧该形态=响亮红（期望注入值）；**还原侧在该窗口内理论上假绿**（缺省恰等于基线）——缓解 = 全序环境 config-service 健康为前提 + 10s 预算内 1s 退避重试约 10 次 + **还原侧 GET 值复核（D6 标准形态的组成部分，非「可选」——r2 🔴1(b) 二选一已裁）**；判据判别力登记在案（r1 空测纪律）。
- **实现约束（r2 B1，计划期不得含糊）**：
  ① **快路径必须真同步**：`hasSnapshot()` 就绪 ⇒ 同帧直接解析+打+排，**不得经任何 `await`/微任务**——节奏边界用例的时序语义依赖它（`records-cleanup.test.ts:163-189`、`risk-scan.test.ts:1098-1143` 的 `advance(FIRST_RUN_DELAY−1)` 裁定；`reconcile.test.ts:444-470` 的首成功时间戳锚）。
  ② **race 败方定时器显式清除**：晚到态 `Promise.race` 的 `sleep(SNAPSHOT_BOOT_WAIT_MS)` 分支须 clearTimeout（否则悬挂 10s timer——`vi.getTimerCount()===0` 风格断言先例 `currency-service/test/config.client.test.ts:221`）。
  ③ **`onModuleInit` 必须同步返回**（浮动续体 `void …`；禁 `async onModuleInit`——否则 Nest 引导 await 它 ⇒ 就绪延后 ≤10s、波及 `up --wait` 与 slice-07.2 降级窗口）。
  ④ **常数与形态落点（r2 B4）**：`SNAPSHOT_BOOT_WAIT_MS = 10_000` 放**各服务 `config-cache.service.ts` 导出**（三份克隆同值、注释互指——照缓存五副本同构先例；不新开 shared 抽取）；首排动作**不跨服务抽共享 helper**（各服务内可抽私有小函数，实现自由度留计划）。
- 指标先置 0（**records / currency / risk scan 三处**——`scan.service.ts:142-150` 先 `set(0)` 再排期，单测 `risk-scan.test.ts:1145-1153` 断同步；r2 🔴1(a) 补；devices/payment 两链无此动作）**保持 T0 同步**（顺序即语义，别对调），等待在其后。
- 判据写法：单测以 fake timers 断「重排处现读」（改假缓存返回值 ⇒ 下一轮延迟变）+「首排动作」三态（就绪/晚到/超时）+ 续体关停闸；conformance 判据 = **重建后新启动行含解析值**（逐循环格式见 §2.4）+ 行为/动作观测；「重启生效」形态的判据（进程 env 断言）**退役**。

### D3 — 回落姿态：fail-safe（与钱面 fail-closed 的刻意分层）

- 键级回落：快照缺该键 / 类型漂移 / 越界 ⇒ **代码默认**（=种子值）；**整个快照不可用**（从未拉到/持续失败）同样回落代码默认 —— 六循环**永不因配置不可用停摆**（janitor 循环的运行是数据卫生前提；默认值即现行生产行为）。
- 对照登记：钱面（充值/提现闸）用 `hasSnapshot()` **fail-closed 拒**——两者分层是**刻意的**（「不确定不放松钱」vs「不确定不停扫」），防将来评审当缺陷改。
- 坏值双层防御：写入口校验（400）+ 库里坏值（直改 DB/旧值残留）由 getter 越界回落。

### D4 — 种子迁移（生产第 0 天行为零变化）

- 新迁移 `packages/config-service/src/migrations/1794000000000-IntervalConfigSeed.ts`：一条 INSERT 六行（值=§D1 默认，`version=1`，`updated_by='seed'`）；`down` 删六行。形状逐字照 `1791000001000-PayConfigSeed.ts`。
- `migration.test.ts` 增本迁移计数块（六元组 + down IN 名单独六；照 `:457-508` 先例）。

### D5 — env 退役与编排面

- `docker-compose.yml` 删六行透传 + 相关注释：payment `:366-367` · user `:178-184`（三行 + 注释段）· currency `:321`；核对 `:352` 附近「26–34 键」注释句。
- `conformance-stack.sh`：删 `:53-54` 两 export；渠道种子段之后追加**六键种子 PUT**（`pay.scanIntervalMs=2000` / `pay.reconcileIntervalMs=2000`——与现行 export 值逐字同；`currency.reconcileIntervalMs` / `risk.scanIntervalMs` / `risk.devicesCleanupIntervalMs` / `record.cleanupIntervalMs` = **3600000**——=种子值=缺省，**行为等价**）——「唯一供给点」纪律保持 + **跨 run 残留收拢点**（r1 🟠3：config 残留跨 run 持久[down 不带 `-v`，命名卷保留]，env 版经 `up` 重建自愈；config 版由本种子段在每次 `up` 归一到基线）。⚠️ **端点与值型（r2 B4）**：走 **`/api/admin/config/<encodeURIComponent(key)>`**（**非**渠道面）；body = `{"value": <JSON 数字>}`（`parseIntervalMs` 拒字符串——现有 `seed_put` 的 `SEED_VAL` 拼串形态只适合字符串值 ⇒ 数值键须写数值版 body 构造）。
- `run.ts` **不涉**（六键不在 `??=` 面）。
- **机械闸（r1 🟠4 订正）**：**零新 env ⇒ `NEW_ENVS` 不动**；但本片**退役六 env** ⇒ **`RETIRED_ENVS` 追加六条**（`design-md-ai-rollout.gate.test.ts:94-109`；「退役的守卫也机械化——不得直接删旧正向断言」，照通知九键 N71 先例「§2.3 现零命中，加列即绿」；六 env 已核 §2.3 零命中）+ 闸注释更新。经此，六 env 名被机械拦住，未来改动无法静默「回流」§2.3。
- 服务器/本机 `.env`：六键从未设过 ⇒ **零动作**；本机根 `.env` 清理为搭车项（边界见 §7 订正）。

### D6 — conformance 注入链迁移（统一形态 + 核销表）

- **统一迁移形态**（六片一致，r1 三轮订正后）：`PUT 注入短值 → 重建目标容器 → 观测（判据=重建后新启动行含解析值 + 行为/动作观测，形态不变）→ PUT 还原到**知基线值** → 重建`。
  - **还原写基线、不写「现值」（r1 🟠3）**：pay 两键基线=**2000**（stack 种子段值）；四键基线=**种子 3600000**——与 env 版「空串复原（复原到已知态）」逐字对应。v1.0 的「GET 现值→…→还原现值」在残留场景把残留**写回**，已废弃。**GET 值复核 = 标准形态的组成部分（非「可选」——r2 🔴1(b)）**：注入后 GET 确认=注入值、还原后 GET 确认=基线（防 PUT 静默失败；兼作 🔴1 超时窗假绿的判别力补偿）。
  - 残留收拢：**stack 种子段六键归一**（每次 `up` 复原基线——对应 env 版经重建随 compose 值自愈）+ **slice-21 ⓪ 保留归一动作**（照 `:574-578` 两开关先例：PUT 两键=2000 + 重建 + 启动行自证——crashed-run 残留与「起栈未走 stack.sh」环境缺陷在此收拢；⓪ 的响亮红语义由「启动行不信 ⇒ 观测路径不可执行」承接）。
- 判据迁移原则：**判据对象（观测路径完整性）不消失、只换来源**——「env 透传保真」类断言替换为「重建后新启动行含解析值（逐循环格式见下）+ 两键重建后仍=2000」等价断言；逐条核销见附录 B。
- **注入生效的判据物（逐循环，逐字格式）**：records / currency / risk-scan / devices / payment-reconcile = `… loop started (first run in <首轮>ms, interval <解析值>ms)`；payment 扫描 = `Payment scan loop started (first round in <解析值>ms; …)`。两者均在 D2 首排动作续体内打印（解析值=配置值）⇒ **slice-20 ④（`:865-873`）与还原侧（`:978-992`）断言逐字不变**（只换注入通道与还原值来源）。
- **新增（借本片补面）**：
  1. slice-20 增「设备清理节奏」小组：PUT `risk.devicesCleanupIntervalMs=5000` + 重建 + 观测**每轮心跳日志 ≥2 行**（该服务无指标——`:56`「本任务不挂指标」；r1 🟡7）+ 还原 —— 第 6 键首次获端到端覆盖；
  2. slice-21 ① 的「pay.* 九键逐字」块扩为**十一键**（两 interval 键断言值 = **2000**，来源=stack 种子段——非种子 60000/86400000，r1 🟡5）；⓪ env 自证 → 归一 + 启动行自证（`first round in 2000ms`）；⑬ 冻结/还原改 PUT（600000 / 还原 2000）；
  3. slice-22 ⑨ 透传面（`:996-1014`）替换为 config 面等价断言（见附录 B）；
  4. 「恰 34」计数 → 「恰 40」（slice-18:856 · slice-20:131 · slice-22:808/988 取值处 · slice-23:735/1237）。
- **窗口复算（r2 B2，spec 落格）**：统一形态 =「重建 + ≤10s 等待」（健康栈实测增耗毫秒级——快照就位即止）；受影响窗口逐处复算：slice-20 双侧 30s poll（`:865-873`/`:982-991`）· slice-21 ⑯ 45s 预算（`:1095`，最坏路径余量收窄）· slice-15 `:727` 注释「≤30s 上界」→「≤40s」· slice-17 `:1047-1056` 与 slice-18 的 90s 窗。
- baselines：受改切片按**实测回填**；若有切片条数下降，提交信息写明理由（替换/退役判据对象已变——照 `baselines.json:2` 纪律）。
- **不新开 slice-24**：本片零新机制（无新表/RPC/令牌/容器），迁移落在受影响六片内 + 计数回填；新键的写校验断言分域落地（pay 两键→slice-21；currency→slice-17；risk 两键→slice-20；record→slice-15，各含一条非法写 400 负例）。

### D7 — 键面全量同步清单（「34 键面」实况=20+ 处，逐条核销）

分类清单（完整行号见附录 C）：

1. **protocol**：`config.test.ts:9-28`（34→40 逐字数组 + 文案）+ 新增 interval 族 parse 用例。
2. **config-service 测试**：`platform-config.service.test.ts:200-249 SEED/296-297 行数/303-337 值` · `helpers/config-probe.ts:139-185`（**假库第二副本，严格读取纪律：两副本同源**）· `admin.controller.test.ts:169-223` · `config.rpc.test.ts:99-158`（:528-551 通知片第⑥不动）· `client-config.test.ts:92`（「没有任何三十四键键名」文案——六键带既有前缀，扫描名单无需扩）· `migration.test.ts` 新计数块。
3. **conformance**：slice-18:8/855-856 · slice-20:5/131/676-680 · slice-22:28/808/988/1030-1034 区 · slice-23:731/735/1237/1283；slice-14 **不动**（不数 34）；slice-17:1229 核过不动（客户端键集）。
4. **admin 页**：`CONFIG_NOTES` +6 条（中文注记含「默认值 + 改后下一轮排期生效」语义句）+ 计数注记**六处**订正（`:134-137`/`:290` + r1 🟡8 补列 `:110`/`:124`/`:607`/`:623`）。
5. **文档**：`docs/design.md` —— `:1140-1177` 键表 +6 行、`:1179` 消费者段、`:1180`「四个周期键的『热』口径」句（4→10 或改措辞——r1 🟡11）、两处「34 键面 12 处硬断言零改动」叙述（`:1207`/`:1218`，改为本片后的新事实）、`:1300` `PAY_RECONCILE_INTERVAL_MS` 句（改指配置键）、计数句（`:142/408/492/499/1409/1558/2033` 择「陈述现状」者改）、`:1185` 横幅锚述句（与下条同批）；`docs/ops/first-deploy.md:992-1026`「三十四键一览」表 +6 行 + 「节奏旋钮怎么调」一句（管理页、下一轮排期生效）+ `:982-983` 保存横幅 mockup 同句；`docs/client-protocol.md:54` 视句义核改。**历史片叙述（`docs/superpowers/**` 案卷）不追溯改**（本设计/规格/台账是新事实层）。
   - **横幅文案统一裁决（r1 🟡10 + r2 残余）**：`admin/app.js:743` 现文案「已保存（版本 N）；各服务 ≤60s 内生效」对节奏键失实（缓存刷新 ≤60s ≠ 节奏生效；最坏 = 一个旧间隔）⇒ 三处同句（`admin/app.js:743`、`design.md:1185`、`first-deploy.md:982`）改 **「已保存（版本 N）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）」**；**同块第二变体 `admin/app.js:746`**「推送失败，将在 ≤60s 内经安全网生效」同批订正（「生效」→「拉到新值（节奏类键自下一轮排期起生效）」）；**`first-deploy.md:985-986` 两条解释要点**同说法的两句一并核改；若判据引用同句，随片迁移（spec 核）。
6. **机械闸**：`NEW_ENVS` 不动（零新 env）；**`RETIRED_ENVS` 追加六条** + 闸注释更新（r1 🟠4，见 D5）。

### D8 — 六循环改造落点

| # | 落点（HEAD） | 改造 |
|---|---|---|
| 1 | payment `scan.service.ts` 扫描链（`:84-87/:256/:289`） | `scanIntervalMs()` 函数体改读 cache（注入 `ConfigCacheService`——现构造五依赖无它，需加；DI 值导入纪律）；`onModuleInit` 改**首排动作**（D2 统一形态：等快照→解析→启动行→排期）；重排处已是现读形态 |
| 2 | payment 日自检链（`:106-109/:263/:307`） | 同上（`reconcileIntervalMs()` 改读 cache）；首轮 30s 常数不动；首排动作照 D2 |
| 3 | currency `ReconcileService`（`:185-186/:235/:246`） | 注入 `ConfigCacheService`（现构造 = DataSource+Redis）；删 readonly 字段 → 排期处现读；首排动作照 D2 |
| 4 | user `risk/scan.service.ts`（`:130-131/:148/:170`） | readonly 字段 → 排期处现读（`configCache` 已在构造）；首排动作照 D2 |
| 5 | user `risk/devices-cleanup.service.ts`（`:67-68/:79/:101`） | 同上 |
| 6 | user `records/records-cleanup.service.ts`（`:84-85/:99/:123`） | 同上；类注「其后按（现读的缓存）新值影响」（`:43-44`）由预留表述**修正为事实** |

- **默认常数唯一真源迁至各 `ConfigCacheService`**（照 `RETENTION_DAYS_DEFAULT` 先例 `user config-cache.service.ts:22`——r1 ⚪12 订正）：user 缓存 +3 getter（`riskScanIntervalMs`/`devicesCleanupIntervalMs`/`recordsCleanupIntervalMs`）+3 默认常数；payment 缓存 +2（`scanIntervalMs`/`reconcileIntervalMs`）；currency 缓存 +1（`reconcileIntervalMs`）。loop 文件保留既有导出名（re-export 默认常数）防测试大改；getter 形态照既有（键级验证 + 回落）。
- `EXPORTED` 解析函数（`scanIntervalMs()` 等）签名可保（内部改读 cache）——测试迁移面最小化留给计划期定稿。

### D9 — 判据计划（设计层）

1. **protocol**：六键 parse 族（合法 1/上界/典型值；0/负/非整/上界+1 ⇒ `ProtocolError` 中文原因）；40 键清单。
2. **config-service**：SEED 双副本/行数/逐值 · 管理面 GET 全量名单 · PUT 新键 → 200 + 审计行 + 广播（既有机制回归） · RPC 快照名单 · 迁移计数。
3. **三服务缓存**：六 getter 的合法/缺键/坏值回落单测。
4. **六循环**：env 注入用例**迁移**为假缓存注入——⚠️「模式现成、接口须补」（r2 B1 同族）：现有 fake cache 全是 **min-mock**（`records-cleanup.test.ts:121-127` 仅 `{retentionDays}`；`risk-devices-cleanup.test.ts:95`、`risk-scan.test.ts:1090` 同形态）⇒ 接口面扩 +`hasSnapshot()→true`、+`waitForFirstSnapshot()→resolved`；**新增「重排现读」判据各 ≥1**（fake timers：跑一轮 → 改假缓存值 → 断言下一轮延迟 = 新值）；**「首排动作」判据每循环 ≥1**（快照就绪 ⇒ 同帧解析[真同步，D2-①]；晚到 ⇒ 续体用配置值[败方定时器已清，D2-②]；超时 ⇒ 缺省；续体关停闸不排；启动行=续体内**解析值**，逐循环格式 §2.4）。
5. **conformance**：附录 B 迁移 + D6 新增 + 计数回填；扫描链节奏判据用**动作/状态推进**（无轮行、无 run 指标——r1 🟡6）。
6. **六阶段 + 全序（28 片）+ baselines 回填**；对账含「六片读数 ≥ 下限」。

### D10 — 上线 / 回滚 / 文档

- 上线 = 惯例 `tag v* + deploy.sh`；**服务器零动作**（无新 env、无新容器、迁移随 config-service 启动自动跑）。部署后管理页六键即现（种子值），改键下一轮排期生效。
- 回滚 = 部署旧 tag：旧画像读 env（生产从未设 ⇒ 空 ⇒ 默认，等价）；DB 六行对旧画像**休眠无害**（旧快照/RPC 面按旧键集消费——外键行不被未知键破坏）；重前进无需清行。
- 文档：D7-5 清单 + 运营手顺一句（`first-deploy.md`）：「节奏旋钮（六键）在管理页『配置中心』改，**下一轮排期即生效**（已排定的一轮不撤），秒级节奏最坏等一个旧间隔；无需重启」。

## 4. 兼容面与混部

- 混部（新旧镜像并存窗口）：新写键 → 旧画像不消费该键（envelope 兼容，快照多键无害）；旧 env 透传行在新 compose 已删——旧镜像是「读 env 空默认」与「读 env=旧 .env 值」两态，但生产/本机 `.env` 从未设六键 ⇒ 两态同一。conformance 栈整栈同 tag，无混部面。
- 管理面契约：新键 GET/PUT 复用既有端点与 policy；响应形状不变。

## 5. 明确不做（YAGNI）

- 变更事件即重排（订阅钩子/值变化检测/重排纪律——与五循环同形态先例不一致；Q3 已否）。
- 管理页「立即跑一轮」按钮 · interval 指标 gauge（轮行/动作观测已够判据；避免动监控片「恰 N 指标」断言面）。
- 下界抬至 1000ms · 客户端可见 · `CONFIG_SYNC_*` 迁移 · 第四键空间 · 四键 stack 级全片短值化（会改变其余 20+ 片环境，破等价原则）。
- 不追溯改历史片规格/计划案卷（新事实由本设计+规格+台账承接）。

## 6. 风险

1. **迁移面完整性**：20+ 处「恰 34」散点无机械闸覆盖（NEW_ENVS 只管 env）⇒ 附录 C 核销 + 全序兜底；特别盯**假库第二副本**（config-probe 与 platform-config.service.test 两份 SEED 同源）与 **migration 计数**。
2. **启动竞态（六循环统一首排动作）**：有界等首快照是必须件且**全六循环**（v1.0 只给 payment 扫描是误判——五循环的启动行判据同样依赖解析后值）；若漏 ⇒ slice-20 ④ 红 / 还原侧空测、slice-21/22 观测窗红。残留登记：等待超时窗口内还原侧启动行判据理论假绿（缺省=基线值）——判别力前提 = config-service 健康（全序环境成立）。
3. **分层姿态被误读**：janitor fail-safe vs 钱面 fail-closed ⇒ D3 明文登记。
4. **最坏延迟口径**：改键生效最坏 = 一个旧间隔 ⇒ 必须写进运营手顺与 CONFIG_NOTES（防「改了没生效」误报；横幅同句一并订正——D7-5）。
5. **残留形态（r1 🟠3 订正）**：config 残留**跨 run 持久**（env 残留随重建自愈）⇒ 收拢双点：stack 种子段六键归一（每次 `up`）+ 切片还原写基线（不写现值）；单轮内崩溃残留与 env 版单轮残留等价（finally 兜底照旧）。
6. **baseline 下调面**：slice-22 透传面替换可能净减条数 ⇒ 提交信息写明理由（纪律在案）。

## 7. 产品问与裁决（2026-10-09 已裁，在案）

| # | 问题 | 选项 | 裁决 |
|---|---|---|---|
| Q1 | 搬迁范围 | 六键全搬 vs 只搬支付两键 | **六键全搬** |
| Q2 | 目标键面 | 34 键业务面 vs 独立第四键空间 | **进业务面** |
| Q3 | 生效语义 | 每轮读取 vs 重启生效 vs 变更事件即重排 | **每轮读取（下一轮排期即生效）** |

搭车（建议照做，非裁决）：本机根 `.env` 删除**所列 8 行**遗留副本（`DB_HOST/PORT/USER` + 四个 `*_SERVICE_URL` + `DOUZERO_URL`；其余被插值三行不动——r1 ⚪14）；CONFIG_NOTES 计数注记同批订正。

---

## 附录 A — 六键逐项对位表（env → 新键 → 消费链）

| env（退役） | 新键（第 N 键） | 默认=种子 | 界 | 消费循环（服务） | 首轮（首排动作见 D2） | 迁移后现读点 |
|---|---|---|---|---|---|---|
| `PAY_SCAN_INTERVAL_MS` | `pay.scanIntervalMs`(35) | 60,000 | ≤600,000 | payment 扫描链 | 首轮=一个周期（解析在首排动作续体） | 重排处 |
| `PAY_RECONCILE_INTERVAL_MS` | `pay.reconcileIntervalMs`(36) | 86,400,000 | ≤864,000,000 | payment 日自检 | 30s（续体内解析+启动行） | 重排处 |
| `CURRENCY_RECONCILE_INTERVAL_MS` | `currency.reconcileIntervalMs`(37) | 3,600,000 | ≤36,000,000 | currency 对账 | 10s（同上） | 重排处 |
| `RISK_SCAN_INTERVAL_MS` | `risk.scanIntervalMs`(38) | 3,600,000 | ≤36,000,000 | user 风控扫描 | 30s（同上） | 重排处 |
| `RISK_DEVICES_CLEANUP_INTERVAL_MS` | `risk.devicesCleanupIntervalMs`(39) | 3,600,000 | ≤36,000,000 | user 设备清理 | 30s（同上） | 重排处 |
| `RECORDS_CLEANUP_INTERVAL_MS` | `record.cleanupIntervalMs`(40) | 3,600,000 | ≤36,000,000 | user 记录清理 | 30s（同上） | 重排处 |

## 附录 B — conformance 迁移核销表（逐片；行号=HEAD，实施时复核）

| 片 | 位置 | 现形态 | 新形态 | 判据迁移 |
|---|---|---|---|---|
| stack.sh | `:53-54` | 两 export（2000/2000） | 种子段 PUT ×6（pay 两键=2000 观测基线；四键=3600000=种子值——行为等价 + 跨 run 残留收拢点） | 供给点唯一性保持（注释重写） |
| slice-15 | `:691`/`:906` | 内联 env 注入/空串还原 + 重建 | PUT 3000→重建；还原 PUT **基线 3600000**→重建 | 注入值域内断言照旧；env 面 0 断言；启动行判据（若该片用到）换 config 值同形 |
| slice-17 | `:1043`/`:1131`/`:1260` | 同（3000） | 同上（还原基线 3600000） | ⑨ 观测（runs≥2/last_success 前进）不变 |
| slice-18 | `:1295`/`:1332`/`:1386` | 同（3000） | 同上 | 观测不变；`:856` 计数 34→40 |
| slice-20 | `:861`/`:978`/`:1294` | 同（5000） | PUT 5000→重建；还原 PUT 基线 3600000→重建 | **④ `:865-873` 与还原侧 `:982-992` 启动行断言逐字不变**（只换通道）；**新增设备清理小组**（心跳 ≥2 行）；`:131` 计数 34→40 |
| slice-21 | stack 供给/⓪ `:557`/⑬ `:881-909` | env 实读自证/env 冻结还原 | stack 六键种子供 2000 基线；⓪=归一（PUT 两键=2000 + 重建）+ 启动行自证（`first round in 2000ms`）；⑬ PUT 600000 ↔ 还原 2000 | ①「九键」块扩十一键（两键断言值=2000）；「env 实读」论证句改 config 面 |
| slice-22 | ⑨ `:996-1014`/`:1048-1052`/`:1131` | env `pickEnv` 保存+随行透传+保真断言 | 删除 env 保存链路；替换为「两键值重建后仍=2000（1–2 行自证）+ 重建后启动行 `first round in 2000ms`」 | 「观测路径不被 slice-22 重建破坏」对象不变；净条数按实测回填 |
| 计数面 | slice-18:856 · slice-20:131 · slice-22:808/988 · slice-23:27/735/1237 | 恰 34 | 恰 40 | 纯计数（r1 🟡9 补 slice-23:27） |
| 单测（片外） | scan.test.ts(15 处)/reconcile.test.ts(18 处)/currency 两 test/user 三 test | process.env 注入 | 假缓存注入（**接口面须扩**：+hasSnapshot/+waitForFirstSnapshot——r2 B1）+ 重排现读/首排动作新增 | 「空串=未设」语义用例退役（对象=env 解析，已随 env 退役） |

**还原形态注（全表统一）**：还原一律 = `PUT 基线 → GET 确认=基线 → 重建`（GET 复核为组成部分——D6；r2 🔴1(b)）。

## 附录 C — 键面全量同步清单（实施核销用；行号=HEAD）

**协议**：`protocol/src/config.ts`（+6 键 + INTERVAL_KEYS + parseIntervalMs）· `config.test.ts:9-28`（数组与文案）。
**config-service 测试**：`platform-config.service.test.ts:200-249/296-297/303-337` · `helpers/config-probe.ts:139-185`（第二副本同源）· `admin.controller.test.ts:169-223` · `client-config.test.ts:92` · `config.rpc.test.ts:99-158` · `migration.test.ts`（新块）。
**conformance**：slice-18:8/855-856 · slice-20:5/131/676-680 · slice-22:28/808/988/1030-1034 · slice-23:**27**/731/735/1237/1283（r1 🟡9 补 :27）。
**admin 页**：`admin/app.js` CONFIG_NOTES（:139-346，+6）· 计数注记**六处**（:134-137/:290 + :110/:124/:607/:623——r1 🟡8）· 保存横幅 :743-748（同句订正，r1 🟡10）。
**文档**：`docs/design.md:1140-1177` 键表 · `:1179` · `:1180`（r1 🟡11）· `:1207`/`:1218` · `:1300` · `:1185` 横幅锚述句 · 计数句（择现状段）· `docs/ops/first-deploy.md:992-1026` + **:982-983 横幅 mockup** + 节奏旋钮手顺 · `docs/client-protocol.md:54`（核）。
**源码/测试注释面（「三十四」陈述现状者批量扫改；历史叙述不改——r2 B3；**口径 = 树内 grep「三十四|34 键」扫全为准**）**：protocol `config.ts:3` · config-service src（`platform-config.service.ts:45,57` · `platform-config.entity.ts:10` · `client-config.controller.ts:22` · `admin.controller.ts:101`）· config-service test（`platform-config.service.test.ts:290,529` · `admin.controller.test.ts:20`）· user/robot/room 各 `config.client.ts` 与 `config-cache.test.ts` 注释 · **补列（r3）：`user-service/src/migrations/1789100000000-BaseScoreLevels.ts:7` · `room-service/src/gateway/rpc.options.ts:35`** · `api-gateway/gateway.controller.ts:127` · `tools/conformance/src/lib/http.ts:248`；**两条核销**：slice-14:64 注释留陈（断言不数 34、slice-14 本体不动——注释文本一句随批订正或登记不改）；`design.md:1177`「支付第 34 键」**无需改**（新键 35–40 追加，34 号位不变）。
**源码注释**（陈述现状者）：`docker-compose.yml:352` · payment `orders.service.ts:8`/`app.module.ts:88`/`replay-anchor.ts:44`/`payment.metrics.ts:170` · 六循环类注（env 口径句改配置面口径）。

---

## 复审要点（自检，防审出低级项）

- 六键默认值与现行常量逐字一致（60000/86400000/3600000×4）——§2.1 表已对。
- slice-21 ⑬ 冻结值 600000 = `pay.scanIntervalMs` 上界（顶格合法）——已在 D1 标注。
- 六键全为**内部键**：客户端 14 键面与 `apps/client` 零改动——已核（agent 取证）。
- `run.ts`/`NEW_ENVS`/`slice-14`/`mock-server` 四个「疑似涉点」已逐一排除并留痕；`RETIRED_ENVS` 是本片**要动**的闸面（+6，r1 🟠4）。
- 启动行判据逐循环格式与真实日志逐字一致（五循环 `interval <v>ms`；扫描链 `first round in <v>ms`）——r1 🔴1 订正后核对。

## 修订记录（v1.0 → v1.1，r1 评审全收口；报告 `.superpowers/sdd/2026-10-09-interval-admin/review-design-r1.md`）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 🔴1 | 阻断 | 启动日志判据不可依（五循环 T0 同步打印=缺省值；扫描链无 `interval=`）⇒ slice-20 ④ 必红、还原侧空测 | **D2 六循环统一「首排动作」**（有界等首快照→解析→启动行→排首轮）；D6 判据物订正为「重建后新启动行含解析值」+ 逐循环真实格式（§2.4）；slice-20 断言逐字不变的迁移路径（附录 B） |
| 🟠2 | 重要 | 写面 policy 事实错误（P4=super_admin｜operator，误引 pay-channel 注释） | §2.2/D1 订正 + **显式决策：沿用 P4（六键与既有周期键同族同权）** |
| 🟠3 | 重要 | config 残留跨 run 持久、还原写现值=残留写回；slice-21 ⓪ 归一动作被删 | D6 还原改**写知基线值**；stack 种子段**六键归一**（跨 run 收拢点）；⓪ 保留归一动作（照 `:574-578` 先例）；风险 #5 订正 |
| 🟠4 | 重要 | 退役六 env 未登记 RETIRED_ENVS | D5/D7-6：**`RETIRED_ENVS` +6**（照 N71 先例；已核 §2.3 零命中） |
| 🟡5 | 次要 | slice-21 ① 两键断言值（种子 vs 2000）矛盾 | 定为 **2000（来源=stack 种子段）**（D6-2/附录 B） |
| 🟡6 | 次要 | §2.4「payment scan 轮摘要」不实 | §2.4 按实况订正（扫描链无轮行/无 run 指标；判据=动作/状态推进 + 启动行） |
| 🟡7 | 次要 | 设备清理小组「指标推进」落空 | 判据改**每轮心跳日志 ≥2 行** |
| 🟡8 | 次要 | admin 页「三十四」注记漏四处 | D7-4 补列 `:110`/`:124`/`:607`/`:623` |
| 🟡9 | 次要 | 计数面漏 slice-23:27 | 附录 B/C 补 |
| 🟡10 | 次要 | 「≤60s 内生效」横幅对节奏键失实 | D7-5 统一裁决：三处同句改「≤60s 内读到新值（节奏类键自下一轮排期起生效）」 |
| 🟡11 | 次要 | design.md:1180「四个周期键」句漏列 | D7-5 补列 |
| ⚪12 | 观察 | RETENTION_DAYS_DEFAULT 引注 :18→:22 | D8 订正 |
| ⚪13 | 观察 | 等待续体无关停闸 | D2 续体先查 `shuttingDown`（并入 🔴1 修） |
| ⚪14 | 观察 | 根 .env 清点不准（「七行」误计/边界未定） | §1.1/§7 订正为「所列 8 行；被插值三行不动」 |

### v1.1 → v1.2（r2 评审收口；报告 `review-design-r2.md`，r2 结论 = 有条件通过）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| r2 🔴1(a) | 部分 | 「指标先置 0」枚举漏 risk scan | D2 补为三处（records/currency/risk scan；devices/payment 无此动作） |
| r2 🔴1(b) | 部分 | 「GET 值复核」与「可选」互斥 | 裁定：**GET 复核 = 标准形态组成部分**（D6 订正；附录 B 加统一注） |
| r2 🟡10 残 | 部分 | 横幅第二变体（app.js:746）+ first-deploy:985-986 两要点漏列 | D7-5 补 |
| r2 B1 | 重要 | D2 缺三条实现约束 + fake cache 全为 min-mock | D2 实现约束 ①（快路径真同步）②（race 败方定时器清除）③（onModuleInit 同步返回）+ D9-4 口径订正「模式现成、接口须补」 |
| r2 B2 | 次要 | conformance 窗口未复算 | D6 窗口复算清单（spec 落格） |
| r2 B3 | 次要 | 附录 C 漏注释面 ≥15 处 | 附录 C 批量组 + 两条核销（slice-14:64 / design.md:1177） |
| r2 B4 | 次要 | 常数落点/helper 形态/stack 种子端点与值型 | D2 ④（常数放各服务 cache 导出、不跨服务抽 helper）+ D5 端点值型注（/api/admin/config + JSON 数字） |
