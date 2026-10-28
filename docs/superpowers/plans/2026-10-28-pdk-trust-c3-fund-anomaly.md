# C3 实施计划 v2：资金异常检测（四信号）

> 日期：2026-10-28 · 依据：`docs/superpowers/specs/2026-10-28-pdk-trust-c3-fund-anomaly-design.md`（v2）
> 分支：`feature/pdk-trust-c3`（自 `dev@13ac394f` 开出）· 上级总 spec U6–U10
> 纪律：每任务 TDD（红 → 绿）→ 提交；只读 `currency_ops`；不自动封禁；不改协议/迁移/配置键。
> v2 已吸收计划对抗审查 8 高 / 11 低（见「计划审查记录」）。

## Global Constraints

- **零 DB 迁移 / 零配置键 / 零协议 / 零客户端 / 零 admin 代码**；`currency_ops` / 记录表**只读**。
- 四信号阈值/窗口为代码常量（spec §5.2），不新增 `risk.*` 键；现有胜率/设备信号零改动。
- 评分：`score = 25×(hit1+hit2+hit3)`；C3 四信号合并为 **hit3 一项 +25**；自动限流线不变。
- 指标写点：带 `game_type` 的 `riskFundScanHitsTotal` **必须经 `incGame`**；新指标名/标签逐字。
- 告警 38 → **41 条 / 38 类**；新规则一律 `labels.severity` + `annotations.summary/runbook`；
  表达式全部 `max_over_time`（抗 ClusterIP 多副本，spec D16）。
- 查询逐条 `/*+ MAX_EXECUTION_TIME(30000) */` + 确定性 `ORDER BY` + 行数上限（分组 5000 /
  明细 200000）；超时=`sql`、超行=`truncated`。
- 降级：单玩法查询失败/截断 ⇒ 该玩法冻结；ops 失败 ⇒ 两玩法冻结（spec D11）。
- 命令（分开写）：
  - `pnpm -C packages/user-service test`
  - `pnpm -C packages/user-service lint`
  - `pnpm -C packages/room-service test -- metrics-game-type-invariant`
  - `node scripts/verify-monitoring.mjs`
  - `pnpm verify:admin`
  - `pnpm -C tools/conformance lint`
  - 全量：`pnpm exec turbo run test lint --force --concurrency=1`（0 cached；flake 单跑复证）
- 真栈：本机 Docker **不可用**（`docker` 命令不存在）⇒ slice-36 只做 tsc，**待权威轮**；
  slice-36 未过权威轮不得称 C3 完成/不得合 dev。

---

## Task 0：文档落盘（spec v2 + plan v2）

**Files**：`docs/superpowers/specs/2026-10-28-pdk-trust-c3-fund-anomaly-design.md`、
`docs/superpowers/plans/2026-10-28-pdk-trust-c3-fund-anomaly.md`。

- [x] 独立 reviewer 对抗审查（8 高 / 11 低，无阻断）。
- [x] 按审查结论修订 spec/plan；结论入 spec §10 与本文件「计划审查记录」。
- [ ] 提交：`docs(c3): C3 资金异常检测 spec 与计划（v2，含审查修订）`。

---

## Task 1：指标定义 + SQL 常量 + 源码闸目标

**Files**
- Modify: `packages/user-service/src/risk/risk.metrics.ts`
- Create: `packages/user-service/src/risk/fund-scan.ts`（本任务只放常量/SQL/类型骨架）
- Modify: `packages/room-service/test/metrics-game-type-invariant.test.ts`
- Modify: `packages/user-service/test/risk-metrics.test.ts`
- Create: `packages/user-service/test/fund-scan.test.ts`（本任务先放 SQL/指标/常量断言）

**Interfaces（后续任务依赖）**
- `risk.metrics.ts` 新导出：`riskFundScanHitsTotal`（counter，labels `check,game_type`）、
  `riskFundScanHitUsers`（gauge，无标签）、`riskFundScanRunsTotal`（counter，`result`）、
  `riskFundScanLastSuccessTimestampSeconds`（gauge，无标签）、
  `riskFundScanRoundFailures`（gauge，`scope,reason`）。
- `fund-scan.ts` 新导出：`FUND_*` 常量（spec §5.2）、8 条 SQL 常量
  （`FUND_SAME_DEVICE_DDZ_SQL` / `FUND_SAME_DEVICE_PDK_SQL` / `FUND_PAIR_PDK_SQL` /
  `FUND_RAKE_COUNTS_DDZ_SQL` / `FUND_WIN_REFS_DDZ_SQL` / `FUND_RAKE_COUNTS_PDK_SQL` /
  `FUND_WIN_REFS_PDK_SQL` / `FUND_OPS_SQL`）、类型 `FundCheck` / `FundScope` / `FundFailure` /
  `FundHit` / `FundCollection`。

**Step 1（红）**
- `risk-metrics.test.ts`：5 个新名逐个 `getSingleMetric` 非空；标签面输出断言
  （`risk_fund_scan_hits_total{check="sameDevice",game_type="doudizhu"}`、
  `risk_fund_scan_round_failures{scope="ops",reason="truncated"}` 等）。
- `fund-scan.test.ts`：
  - 8 条 SQL **全文 `toBe`**（测试侧按 spec §5.3 独立誊写，含 ⑥/⑦ 与设备 `last_seen_at` 谓词、
    `ORDER BY`、`MAX_EXECUTION_TIME`）；
  - 参数占位次序：① ② `[from7d, now, deviceFrom, deviceFrom, min, limit]`；
    ③ `[cutoff26h, from7d, now, min7d, limit]`；④ ⑥ `[from26h, now, min, limit]`；
    ⑤ ⑦ `[from26h, now, limit]`；⑧ `[from27h, now, limit]`；
  - 常量逐值：7d / 26h / 27h / 3 / 5 / 0.8 / 1000 / 10 / 20 / 5000 / 3 / 5000 / 200000 / 30000。
- `metrics-game-type-invariant.test.ts`：TARGETS 增 `'riskFundScanHitsTotal'`。
- 跑红。

**Step 2（绿）**
- 按 spec §5.6 写 5 个指标（HELP 逐字写明窗口/口径/启动 0/多副本告警面）。
- 按 spec §5.2/§5.3 写常量与 8 条 SQL（**逐字**；DDZ/设备/ops 参数绑 `Date`、PDK `ended_at`
  绑 `number`）。
- 跑绿 + lint；提交 `feat(risk): C3 资金异常指标定义与 8 条只读 SQL`。

---

## Task 2：FundScanCollector（四信号采集与判定）

**Files**
- Modify: `packages/user-service/src/risk/fund-scan.ts`
- Modify: `packages/user-service/test/fund-scan.test.ts`

**Interfaces**
- `class FundScanCollector { constructor(dataSource: DataSource); collect(now: number, opts?: { window7dMs?; scanWindow24hMs?; opsWindowMs?; groupCap?; detailCap? }): Promise<FundCollection> }`
- `FundCollection = { reasonsByUser: Map<string, ScanReason[]>; hitsByUser: Map<string, FundHit[]>;
  hitUsers: number; degradedGames: GameType[]; failures: FundFailure[] }`
- `FundFailure = { scope: FundScope; reason: 'sql' | 'truncated' }`
- `FundHit = { check: FundCheck; gameType: GameType }`（每用户按 check+gameType 去重）。

**Step 1（红）** —— `fund-scan.test.ts` 加 Fake DS（按 8 条 SQL 常量回执；未识别 SQL reject）：
- 同设备：`games=3` 命中两侧；`2` 不命中（JS 复核面）；同对子两台设备 ⇒ 两条 reason；
  reason 带 `gameType/windowHours:168/pairUserId/deviceId`。
- 对子胜率：`games=5 & winRate=0.8 & net=1000` 命中两侧；`net=999` / `4 局` 不命中；
  `dominantUserId` 指向胜方；reason 带 `gameType:'paodekuai', playerCount:2, windowHours:168`。
- 对子频次：`games_24h=10` 命中；`9` 不命中；与 pairWinRate 同时命中 ⇒ 两条 reason、两条 hit；
  reason 带 `windowHours:26`。
- 高抽水：`20 局 & 5000` 命中；`19 局` / `4999` 不命中；同 ref 两条 op 取 max；NULL/无 op 按 0；
  未获胜局不计抽水；reason 带 `windowHours:26`。
- 失败/截断：任一 SQL reject ⇒ `failures[{scope,reason:'sql'}]` + 对应 `degradedGames`，
  其余信号照常；`limit+1` 行 ⇒ `truncated` 且该查询结果整段丢弃；ops 失败 ⇒ 两玩法降级。
- reason cap：同 (check, gameType) 4 组 ⇒ 恰 3 条（排序断言）；两玩法各有证据时**都保留**
  （ddz 3 + pdk 3）。
- 空数据 ⇒ 零命中、零降级、零失败、`hitUsers=0`。
- 参数窗口：`[now-7d, now)` / `[now-26h, now)` / `[now-27h, now)` 逐毫秒（DDZ Date、PDK number）。
- 跑红。

**Step 2（绿）**
- 实现 `collect`：按 spec §5.4 的顺序/判定/JS 复核/上限/排序/cap；`Number()` 归一；
  `refRake` 取 max；失败入 `failures` 并降级；不抛（单查询错误内部消化）。
- 跑绿 + lint；提交 `feat(risk): C3 资金异常四信号采集与判定`。

---

## Task 3：审核队列 reason 的玩法维度与降级涉及面

**Files**
- Modify: `packages/user-service/src/risk/reviews.service.ts`
- Modify: `packages/user-service/test/risk-scan.test.ts`（ReviewsService 段）

**Step 1（红）** —— 新增用例：
- 新增 `export type ScanCheck`；`ScanReason.check` 改用它（既有断言不破）。
- `applyScanResult` 用 `[{check:'pairWinRate',detail:{gameType:'paodekuai',...}}]` + score 25，
  无行 ⇒ INSERT open 且 `game_type='paodekuai'`；
- `sameDevice` ddz + `pairFrequency` pdk 同批 ⇒ `game_type='mixed'`；
- `highRake` ddz + `devices` ⇒ `game_type='doudizhu'`（devices 不改变玩法集合）；
- 最新行 `mixed` + `unavailableGames=['paodekuai']` ⇒ 零写（涉及面含新 check）；
- 最新行 `game_type='doudizhu'` 但 reasons 含 C3 pdk ⇒ 视为涉及 pdk（reasons 兜底）。
- 跑红。

**Step 2（绿）**
- `ScanCheck` 扩 4 值；`deriveReviewGameType` / `reviewInvolvedGames` 把新 check 的
  `detail.gameType` 并入集合（`paodekuai` 特判，其余按 ddz）；`autoThrottleLine` **不动**。
- 跑绿；提交 `feat(risk): C3 reason 的玩法维度与降级涉及面`。

---

## Task 4：ScanService 单轮接入（评分/降级/指标）

**Files**
- Modify: `packages/user-service/src/risk/scan.service.ts`
- Modify: `packages/user-service/test/risk-scan.test.ts`（ScanService 段）

**Step 1（红）** —— 扩 `FakeScanDb`（8 条新 SQL 回执 + `failFund*` 开关），新增用例：
- C3-only 命中用户（不在 SQL1/1b/2 结果里）仍进并集 ⇒ `applyScanResult(user,25,reasons,now,[])`；
- 评分矩阵：C3-only=25；winRate+C3=50；devices+C3=50；winRate+devices+C3=75；
- reasons 顺序：既有 winRate(按人数升序) → devices → sameDevice → pairWinRate →
  pairFrequency → highRake；
- `game_type` 推导（ddz C3 / pdk 对子 / mixed）；
- 降级：C3 pdk SQL 抛 ⇒ `applyScanResult` 第 5 参含 `paodekuai`，轮仍 `ok`；ops 抛 ⇒ 含两玩法；
- 指标：`risk_fund_scan_hits_total{check,game_type}` 每用户每 check 恰 +1（对子两侧各 +1）；
  `risk_fund_scan_hit_users` = 去重 C3 用户数；**仅 winRate/devices 命中的轮次 ⇒ hit_users 保持 0**；
  `runs{ok}`/`last_success` 成功轮推进；C3 失败轮 `runs{fail}` + last_success **不**推进 +
  `round_failures` 对应组合 ≥1；成功轮 `round_failures` 6 组合全 0；boot 置 0；
- `autoThrottleScore=25` + C3-only pdk（25 分）⇒ 不武装（线仍 50）；
- 轮摘要日志含 `fundHits=`（用 capturing sink）；
- **端到端承重**：FakeScanDb 对子命中 + 真实 `ReviewsService`（FakeRiskDb/FakeRedis）⇒
  落库行 `game_type='paodekuai'` 且 reasons 带 `detail.gameType`（防 H1 组合缺陷）；
- 更新既有精确断言：查询顺序测试改为「SQL1 → SQL1b → SQL2 → 8 条 C3 → 自愈 → open」；
  轮次计数测试按新查询数调整（只数 SQL1 的用例不变）。
- 跑红。

**Step 2（绿）**
- `ScanService` 构造函数体 `this.fundScan = new FundScanCollector(dataSource)`；
- `onModuleInit` 置 `risk_fund_scan_last_success=0` / `hit_users=0` / 6 个 `round_failures` 0；
- `runScanWork`：既有统计后 `fundScan.collect(now)` → 合并并集/reasons/hit3/降级/指标；
- 轮末成功/失败分支与日志（spec §5.6）；`RiskScanRoundResult` 形状不变。
- 跑绿 + lint；提交 `feat(risk): C3 四信号并入风险扫描单轮（评分/降级/指标）`。

---

## Task 5：告警 + 静态闸 + 计数同步 + 运维文档

**Files**
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- Modify: `scripts/verify-monitoring.mjs`
- Modify: `Dockerfile.prometheus`
- Modify: `tools/conformance/src/slices/slice-16-monitoring.ts`、`slice-18-gold-room.ts`、
  `slice-24-ads-relief.ts`
- Modify: `docs/ops/first-deploy.md`

**Step 1（红）**
- `verify-monitoring.mjs`：EXPECTED_ALERTS +3；头注释判据 `**41 条**` / `41 条 = 38 类`；
  ALERT_PREDICATES +3（含 `max_over_time`、`round_failures`、`hit_users`、`last_success`）；
  GLOBAL_ALERTS +3（三条 expr 均不含 `game_type`）；C3 结构断言逐条；
  `dockerfile`/`slice-16`/`slice-18`/`slice-24` 计数改 41 与名集 +3。
- 跑红（`node scripts/verify-monitoring.mjs` + `pnpm -C tools/conformance lint` 预期红）。

**Step 2（绿）**
- 按 spec §5.7 逐字写 3 条告警（表达式含 `max_over_time`）；头部 41/38；Dockerfile 注释 41；
- slice-16 EXPECTED_RULES +3 与文案；slice-18 `C3_ALERT_RULES` + 数量 41；slice-24 同；
- `first-deploy.md` 监控节追加 C3 三告警一段；
- 判别力自证：把 `RiskFundScanStalled` 的 `severity` 移出 `labels` ⇒ verify-monitoring 红；
  恢复后绿（记录读数）。
- 提交 `feat(monitoring): C3 三条资金异常告警与 41/38 同步`。

---

## Task 6：conformance slice-36 + baselines

**Files**
- Create: `tools/conformance/src/slices/slice-36-fund-anomaly.ts`
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/baselines.json`（若基线格式要求）

**Step 1**：按 spec §5.8 写 slice（**registerUser 真用户** → 注入 → 重启 → 轮询审核队列/9001
gauges → 零写 → 清理）。覆盖：四信号正例；负例独立用户（4 局对子 / 19 局金币 / 10 局但都
>26h ⇒ 只有 pairWinRate / 陈旧设备 last_seen 8 个月前 / 机器人局 / 7d 外 / 仅 winRate 用户用于
hit_users 不变）；`currency_ops` 逐列 NOT NULL；`user_devices` 走 `uk_user_device`；
reason 精确集 + score=25 + `game_type` 过滤 + `hits_total{check}` 四 check + `hit_users≥正例数` +
`round_failures` 全 0 + `last_success>0` + 注入行数不变（零写）。
**Step 2**：`run.ts` 注册 `slice-36-fund-anomaly`；baselines 增 full 基线；
`pnpm -C tools/conformance lint` 绿；提交 `test(conformance): C3 资金异常真栈切片（slice-36）`。
**Step 3**：本机无 Docker ⇒ 真栈登记「待权威轮」（spec/交付报告双处），并写明当前种子下
仅 sameDevice/DDZ highRake 可响（PDK 2 人/金币场关闭、rake=0）。

---

## Task 7：全量验证 + 独立代码审查 + 修复

1. `pnpm -C packages/user-service test` / `lint`；`pnpm -C packages/room-service test --
   metrics-game-type-invariant`；
2. `node scripts/verify-monitoring.mjs`；`pnpm verify:admin`；`pnpm -C tools/conformance lint`；
3. 全量 `pnpm exec turbo run test lint --force --concurrency=1`（0 cached；flake 单跑复证）；
4. 独立 reviewer 审 `BASE..HEAD`（spec/plan 逐条核对；Critical/Important 必修）；
5. 修复后复跑 1–3；工作区干净；交付报告（含 slice-36 待权威轮硬闸、默认种子可响面）；
6. 提交审查修复（可多条）；spec/plan 填执行记录。

## 回滚

- 每任务独立提交；无迁移/无配置/无协议；revert 即可；扫描只读，无残留数据。

## 计划审查记录（v1 → v2）

独立 reviewer（2026-10-28）：**无阻断 / 8 高 / 11 低**。处置：

| # | 级别 | 发现 | v2 处置 |
|---|---|---|---|
| H1 | 高 | 对子 reason 缺 gameType ⇒ 玩法错标/冻结失效/误释放 | Task 2/4：四类 reason 恒带 gameType；真实 ReviewsService 端到端用例 |
| H2 | 高 | hit_users 口径未钉死 ⇒ 告警常亮 | Task 4：仅 C3 hitUsers；winRate-only 轮次 hit_users=0 用例 |
| H3 | 高 | 25h 不覆盖周期+相位 | Task 1：扫窗 26h、ops 窗 27h；spec D20-7 登记非硬保证 |
| H4 | 高 | money_delta 永久 NULL 盲区未登记 | spec D20-4 登记（不放宽阈值） |
| H5 | 高 | 设备关联无 last_seen 窗 ⇒ 陈旧误报 | Task 1/2 + slice-36 陈旧设备负例 |
| H6 | 高 | 种子下三信号不响 | spec D20-5/6 登记；交付报告如实说明；不开开关 |
| H7 | 高 | 多副本 gauge/counter 告警失效 | Task 1/5：round_failures 改 gauge + 三条 max_over_time |
| H8 | 高 | slice-36 假 id / ops NOT NULL 缺列 | Task 6：真用户、ops 逐列、devices uk、清理策略 |
| L1 | 低 | ScanCheck 不存在 | Task 3 真加别名 |
| L2 | 低 | fundScan/fundCollector 漂移 | Task 4 统一 `this.fundScan` |
| L3 | 低 | 假测试 vs SQL HAVING | Task 2：JS 复核全部阈值 |
| L4 | 低 | slice-36 负例矛盾 | Task 6：每负例独立用户、精确 reason 集 |
| L5 | 低 | ⑥/⑦ 未逐字；p.won 误判 | Task 1：逐字 + `p.won = 1` |
| L6 | 低 | LIMIT 无 ORDER BY/非成本上限 | Task 1/2：ORDER BY；截断整段丢弃；30s 成本上限 |
| L7 | 低 | 超时/截断标签矛盾 | 超时=sql、超行=truncated |
| L8 | 低 | 24h 常量命名漂移 | `FUND_SCAN_WINDOW_24H_MS=26h` |
| L9 | 低 | 窗口衰减自动解除循环 | spec D20-8 登记 |
| L10 | 低 | 每 check 3 条丢玩法证据 | 每 (check,gameType) 3 条 |
| L11 | 低 | 整玩法冻结过宽 | spec D11/D20-9 登记安全取向 |

## 代码审查记录（2026-10-28，独立 reviewer 审 `13ac394f..HEAD`）

**Critical 0 / Important 0 / Minor 7 / PLAUSIBLE 3**。逐条处置见 spec §10.2；修复提交
`e7355ce2`（含 M1–M7、P2、P3；P1 登记为与既有 `RiskScanStalled` 共享的多副本抓取债务）。
另有一条**与本片无关的既有 lint 红**在首轮全量 turbo 暴露：
`packages/room-service/test/ws.gateway.test.ts:2916` TS2345（`62d5bbd3` 订阅修复后遗症，
文件与 dev 逐字相同）⇒ 最小修复独立提交 `0e69dea8`，运行期零变化。

## 执行记录（2026-10-28）

- 分支：`feature/pdk-trust-c3`（自 `dev@13ac394f` 开出）。
- 提交（按序）：`0afac76a` 文档 v2 → `b10e8370` 指标/SQL → `595ebca4` 采集判定 →
  `58462c47` reason 玩法维度 → `2fb7f21d` 扫描接入 → `47f3c25c` 告警 41/38 →
  `44fc67a1` slice-36 → `0e69dea8` 既有 lint 修复 → `e7355ce2` 代码审查修复。
- 本机验证（最终树）：
  - `pnpm -C packages/user-service test`：29 文件 / **452 tests** 全绿；
    `lint`（tsc 双配置）通过。
  - 全量 `pnpm exec turbo run test lint --force --concurrency=1`：**45/45 successful，
    0 cached**（3m41s）。关键读数：user 452 · room 1009 · currency 592 · config 492 ·
    game 278 · payment 465 · gateway 505 · robot 146 · client 1541。
  - `node scripts/verify-monitoring.mjs`：**288 checks**；判别力自证（
    `RiskFundScanStalled` 的 severity 移出 labels ⇒ 1 FAILED）执行并恢复。
  - `pnpm verify:admin`：**620 checks**；`tools/conformance` tsc 双配置通过；
    `check-baselines.mjs --self-test` 4/4；`baselines.json` JSON 校验通过。
  - 基线：slice-18 152 / slice-24 226（各 +1 名集断言）；slice-36 = **64**（静态计数）。
- **真栈：本机 Docker 不可用（`docker` 命令不存在）⇒ slice-36 仅 tsc，未跑；登记
  「待权威轮」**。按 spec §8.7：slice-36 未过权威轮不得称 C3 完成/不得合 dev。
  当前种子下仅 sameDevice 与 DDZ highRake 可响（PDK 2 人/金币场关闭、rake=0；
  本片不改开关）。
- 已知边界：spec §6.1（含 P1 多副本抓取粘滞、`money_delta` 晚到 NULL、>26h 晚到、
  rake=0、整玩法冻结粗粒度、窗口衰减自动解除循环）。
- 工作区：干净；diff 无迁移/配置键/协议/客户端/admin 代码。
