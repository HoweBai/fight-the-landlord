# C3 资金异常检测设计（v2，首版四信号）

> 日期：2026-10-28 · 状态：已按计划对抗审查修订（8 高 / 11 低，无阻断）· 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`（§2 C3 / §3 U6–U10 / §5.3）
> 依赖：C1（记录可晚到 ≤24h、`record:outbox` TTL 24h）、C2（金额口径：`money_delta` / `score_change` /
> `burned_rake` 的可解释关系；只报不改纪律）。
> 前置事实：`origin/dev@13ac394f`；C1/C2 已合入 dev/master（master `d064da15`，权威真栈 40/40）。

## 1. 背景与问题

C3 要回答「钱与记录之外，**谁在用异常方式搬钱**」。现有 `ScanService`（user-service，1h 一轮）
只检测胜率集中与设备数；`risk_reviews` / `risk_actions` / 管理端审核队列与自动限流是既成的
处置面。异常资金行为（同设备多账号同桌、固定对子对刷、24h 高频对子、高抽水/高流水）目前
**完全不可见**：

| 信号 | 现有能力 | 数据面 |
|---|---|---|
| 同设备同桌 | 无（`user_devices` 只服务设备数阈值与账号-设备绑定） | `user_devices` + `game_records(_pdk)` / `game_record_players(_pdk)` |
| 对子胜率集中 | 无（胜率只按单账号；无「同一对子」维度） | `game_records_pdk` / `game_record_players_pdk`（2 人局） |
| 24h 高频对子 | 无 | 同上 |
| 高抽水/高流水 | 无（`burned_rake` 只在 currency 侧报表） | `currency_ops.burned_rake` + 对局记录（同库只读） |

用户裁决（总 spec §3）：U6 两玩法通用信号 + PDK 2 人专属信号；U7 四信号全做，阈值逐字；
U8 同 IP 不做；U9 命中参与现有自动限流（score +25），不自动封禁；U10 保留期不动。

## 2. 范围

### 2.1 做

1. **扫描扩展**：在既有 `ScanService` 的同一轮（1h / 启动 30s 首跑 / Redis 锁 / 自调度）内，
   新增 C3 采集（`risk/fund-scan.ts`）并并入**同一份** `applyScanResult` 快照：
   - 四信号：`sameDevice`（两玩法，7d≥3 局）、`pairWinRate`（PDK 2 人，7d≥5 局且同一方
     胜率≥80%、该方净赢≥1000 金币）、`pairFrequency`（PDK 2 人，24h 口径≥10 局，扫窗 26h）、
     `highRake`（两玩法，金币局 24h 口径≥20 局且抽水上界≥5000 金币，扫窗 26h）。
   - 每个信号每用户最多贡献一次命中；四信号合并为**一个** `hit3`（U9「score +25」）。
   - 所有 reason 恒带 `detail.gameType` 与 `detail.windowHours`（可解释 + 玩法维度承重）。
2. **审核队列 reason**：`ScanReason.check` 扩 4 值（统一别名 `ScanCheck`）；`game_type` 推导与
   「玩法不可用冻结」（`reviewInvolvedGames`）把新 check 纳入；管理端沿用既有 reasons JSON
   展示（零前端改动）。
3. **指标 5 个**：`risk_fund_scan_hits_total{check,game_type}`、`risk_fund_scan_hit_users`、
   `risk_fund_scan_runs_total{result}`、`risk_fund_scan_last_success_timestamp_seconds`、
   `risk_fund_scan_round_failures{scope,reason}`（gauge；告警面对多副本安全，见 D15/D16）。
4. **告警 3 条**（38 → 41 条 / 35 → 38 类）：`RiskFundScanQueryFailures`(warning)、
   `RiskFundScanStalled`(warning)、`RiskFundHitsHigh`(warning)；表达式用 `max_over_time` 抗
   ClusterIP 轮询多副本。
5. 单测（SQL 全文/阈值边界/降级/指标/评分/排队 + 真实 `ReviewsService` 端到端落库）+ 真栈片
   `slice-36-fund-anomaly`。

### 2.2 不做

- 不新增表/列/迁移/配置键；不改协议/客户端/管理端代码/`risk_reviews` 结构。
- 不自动封禁；不新增自动动作（只沿用现有 `applyScanResult` 状态机与自动限流线）。
- 不做同 IP（U8；历史 IP 无存储，登记为已知缺口）；不采集历史 IP。
- 不改胜率/设备数既有两个信号的阈值、SQL、评分与调度；不改 `ReconcileService` / C2 对账。
- 不做实时流式检测（口径 = 1h 批扫描）；不做图分析/跨窗口长期画像。
- 不重做 A1 看板（指标可被面板引用，但本片不改 `06-risk.json`）。
- **不打开任何玩法/场次开关**（父 spec §2.1 红线；PDK 2 人/金币场/rake 的种子现状只登记）。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | C3 采集并入 `ScanService` 同一轮、同一 `applyScanResult` 快照；采集逻辑独立文件 | 评分/自动限流/降级只有一份状态机；无新循环/新锁/新写入口 | `ScanService` 变长（用独立采集器隔离） |
| B | 独立 `FundScanService` + 独立循环，单独写 `risk_reviews` | 文件隔离 | 两个写入口互相覆盖 score/reasons 快照 ⇒ 自动限流误释放/误武装；需新锁/新指标口径 |
| C | 离线 SQL 日报 | 简单 | 无法进入审核队列/自动限流；不可解释到用户 |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 扩展 `ScanService` 单轮；`fund-scan.ts` 只做采集/判定，不持状态机 | 一个用户一份快照；与既有降级/限流语义同源 |
| D2 | 四信号归属：`sameDevice`/`highRake` 两玩法；`pairWinRate`/`pairFrequency` 仅 PDK `player_count=2` | U6「两玩法通用 + PDK 2 人专属」；2 人局「对子」定义无歧义 |
| D3 | 窗口：`sameDevice`/`pairWinRate` = **7d**；`pairFrequency`/`highRake` = **扫窗 26h**（24h 口径 + 2h 晚到/相位余量）；按记录 `ended_at` 计数 | U7 阈值；C1 outbox TTL 24h + 扫描周期 1h+耗时 d + 抓取相位 ⇒ 25h 只是下界；26h 覆盖 `24h+d+相位`。**不是硬保证**（TTL 修复可再顺延，见 D20） |
| D4 | 阈值/窗口全部为代码常量（**零新增配置键**） | U7 裁决绝对值；C1/C2 均零配置键；调参 = 发版（与告警阈值同纪律）。`risk.*` 既有键不动 |
| D5 | 对子 = 无序用户对（`a.user_id < b.user_id`，两人均非机器人、均 active）；两个账号**都**记 reason/命中 | 对刷的两侧（赢家与送钱方）都是参与人；只罚赢家会漏掉资金源 |
| D6 | 同设备 = **同一 `device_id`** 且同桌 ≥3 局；两条设备行都必须 `last_seen_at >= from7d` | 防「一年前共用过平板、如今各自手机碰巧同桌」的陈旧绑定误报（与既有设备数信号口径一致） |
| D7 | 对子胜率：`max(wins_a,wins_b)/games ≥ 0.8` 且 `games ≥ 5`，净赢 = 胜方 `Σmoney_delta ≥ 1000`；对子频次：26h 扫窗内 `games ≥ 10` | U7 逐字（≥ 含等于）；净赢只认金币（`money_delta`，NULL 按 0） |
| D8 | 高抽水：**金币局**（`mode='gold'`）26h 内 ≥20 局，且该用户**获胜局**对应 settle op 的 `Σmax(burned_rake) ≥ 5000`（同 ref 取最大、NULL 跳过） | 抽水只存在于金币场；赢家是抽水承担方 ⇒ 赢局总抽水是「该用户产生抽水」的上界；`burned_rake` 是唯一历史事实（当前费率不能反推） |
| D9 | 评分：`hit3 = 任一 C3 信号`，`score = 25×(hit1+hit2+hit3)` ∈ {0,25,50,75}；`autoThrottleLine` **不变** | U9「score +25；与胜率/设备叠加到线」；C3 单独 25 分不自动限流 |
| D10 | reasons：每个 **(check, gameType)** 每用户至多 3 条（防某玩法证据被另一玩法挤掉）；被截断条数进轮末聚合日志 | 按玩法分别封顶 ⇒ `deriveReviewGameType`/冻结涉及面永远看得到两玩法证据 |
| D11 | 降级粒度：`sameDevice`/`highRake` 按玩法；PDK 对子查询失败 ⇒ 降级 `paodekuai`；ops 失败 ⇒ 降级两玩法 | 与既有「单玩法 SQL 失败 ⇒ 该玩法本轮冻结」同形；ops 缺失会让高抽水假阴性 ⇒ 冻结防误释放。整玩法冻结是**粗粒度安全取向**（D20 登记） |
| D12 | 采集查询逐条 `MAX_EXECUTION_TIME(30000)` 提示 + **确定性 ORDER BY** + 行数上限（分组 5000 / 明细 200000）；超时 = `sql`、超行 = `truncated` | `LIMIT` 只是结果上限、不是成本上限；30s 提示是成本上限；ORDER BY 保证截断/复跑结果确定 |
| D13 | `currency_ops` 只读走 `idx_ops_source_created`（`source='game_settle' AND created_at ∈ [now−27h, now)`），内存按 `ref_id` 关联；**不写**、不 JOIN 记录表 | `ref_id` 无索引；27h = 26h 扫窗 + settle outbox 1h TTL；C2 同款只读纪律 |
| D14 | 进程/健康指标不带 `game_type`；失败用 `scope`（`doudizhu|paodekuai|ops`）+ `reason`（`sql|truncated`）；带 `game_type` 的只有 `hits_total` | `ops` 跨玩法；沿用 C2 进程指标先例；A1 指标闸只约束带玩法的写点 |
| D15 | 失败面用 **gauge** `risk_fund_scan_round_failures{scope,reason}`（每轮全 6 组合 set，含 0），不用 counter 告警 | ClusterIP 单 target 轮询多副本时 counter 会被当成 reset ⇒ `increase` 假放大；gauge + `max_over_time` 与副本数无关 |
| D16 | 告警 3 条，表达式全部 `max_over_time(...[15m])`：查询失败（首轮可见）、停滞（>2h 未全量成功）、命中集中（单轮命中用户 >10 持续 2h） | 抗多副本 series 抖动；单条命中不告警（进审核队列，避免噪声）。既有 `RiskScanStalled` 同类隐患另立（不属 C3 改动面） |
| D17 | 零 DB 迁移 / 零配置键 / 零协议 / 零客户端 / 零 admin 代码；回滚 = revert | 最小面；reasons JSON 前端已原样展示 |
| D18 | 管理端展示沿用 reasons JSON；`game_type` 过滤器随推导扩展自动生效 | 审核人可按 pairUserId/deviceId/games/windowHours 解释；不新增面板字段 |
| D19 | 真栈片 `slice-36` 用**注册用户** + `mysqlExec` 注入记录/设备/ops + 重启 user-service 触发首跑；断言 reasons/score/game_type/9001 gauges/零写/清理 | slice-33 的触发 + slice-35 的注入；fake id 会被 `JOIN users … active` 全过滤（权威轮必红），必须真用户 |
| D20 | 已知边界登记（见 §6.1）：记录无 `device_id`；旧客户端无 deviceId；设备保留期清理；`money_delta` 晚到 >1h 永久 NULL；rake=0 信号静默；PDK 2 人/金币场种子关闭；TTL 修复可越过扫窗；窗口衰减 ⇒ 自动解除/再武装循环；整玩法冻结的粗粒度 | 诚实登记，不伪装精确；不擅自打开开关 |

## 5. 实现设计

### 5.1 文件与骨架

- 新增 `packages/user-service/src/risk/fund-scan.ts`：
  - 8 条 SQL 常量（§5.3）与窗口/阈值/上限常量；
  - `FundScanCollector` 类（构造入参 `DataSource`；非 Nest provider、无生命周期）；`collect(now, opts?)`
    返回 `FundCollection`（§5.5）。
- 修改 `packages/user-service/src/risk/scan.service.ts`：构造函数体 `this.fundScan = new FundScanCollector(dataSource)`；
  `runScanWork(now)` 内调用采集器，合并命中/降级/指标。
- 修改 `packages/user-service/src/risk/reviews.service.ts`：新增 `export type ScanCheck`；
  `ScanReason.check: ScanCheck`；`deriveReviewGameType` / `reviewInvolvedGames` 纳入新 check。
- 修改 `packages/user-service/src/risk/risk.metrics.ts`：5 个新指标。
- 监控四件套 + conformance（§5.7 / §5.8）。

### 5.2 常量（`fund-scan.ts` 导出，测试侧独立誊写）

```ts
export const FUND_WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;           // 7d；sameDevice / pairWinRate
export const FUND_SCAN_WINDOW_24H_MS = 26 * 60 * 60 * 1000;         // 「24h」口径的扫窗 26h（D3）
export const FUND_OPS_WINDOW_MS = 27 * 60 * 60 * 1000;              // 26h + settle outbox 1h（D13）
export const FUND_SAME_DEVICE_MIN_GAMES = 3;
export const FUND_PAIR_MIN_GAMES_7D = 5;
export const FUND_PAIR_WIN_RATE = 0.8;
export const FUND_PAIR_MIN_NET_WIN = 1000;
export const FUND_PAIR_MIN_GAMES_24H = 10;
export const FUND_RAKE_MIN_GAMES = 20;
export const FUND_RAKE_MIN_AMOUNT = 5000;
export const FUND_MAX_REASONS_PER_CHECK_GAME = 3;
export const FUND_GROUP_CAP = 5000;
export const FUND_DETAIL_CAP = 200_000;
export const FUND_QUERY_MAX_EXECUTION_MS = 30_000;
```

### 5.3 SQL（8 条；`?` 占位；逐条带 `/*+ MAX_EXECUTION_TIME(30000) */` 与确定性 `ORDER BY`）

参数类型（D3/D13）：DDZ `ended_at`、`user_devices.last_seen_at`、`currency_ops.created_at` 绑
`Date`；PDK `ended_at` 绑 `number`（ms）。所有 `COUNT/SUM` 回执一律 `Number()` 归一。

```sql
-- ① 同设备同桌 · 斗地主
-- params: [from7d:Date, now:Date, deviceFrom:Date, deviceFrom:Date, min:number, limit:number]
SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games
FROM game_record_players a
JOIN game_record_players b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0
JOIN game_records r ON r.id = a.record_id
JOIN user_devices d ON d.user_id = a.user_id
JOIN user_devices e ON e.user_id = b.user_id AND e.device_id = d.device_id
JOIN users ua ON ua.id = a.user_id AND ua.status='active'
JOIN users ub ON ub.id = b.user_id AND ub.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 AND d.last_seen_at >= ? AND e.last_seen_at >= ?
GROUP BY a.user_id, b.user_id, d.device_id
HAVING COUNT(*) >= ?
ORDER BY games DESC, a.user_id ASC, b.user_id ASC, d.device_id ASC
LIMIT ?

-- ② 同设备同桌 · 跑得快（params 同上；表 = _pdk）
SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games
FROM game_record_players_pdk a
JOIN game_record_players_pdk b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0
JOIN game_records_pdk r ON r.id = a.record_id
JOIN user_devices d ON d.user_id = a.user_id
JOIN user_devices e ON e.user_id = b.user_id AND e.device_id = d.device_id
JOIN users ua ON ua.id = a.user_id AND ua.status='active'
JOIN users ub ON ub.id = b.user_id AND ub.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 AND d.last_seen_at >= ? AND e.last_seen_at >= ?
GROUP BY a.user_id, b.user_id, d.device_id
HAVING COUNT(*) >= ?
ORDER BY games DESC, a.user_id ASC, b.user_id ASC, d.device_id ASC
LIMIT ?

-- ③ PDK 2 人对子
-- params: [cutoff26h:number, from7d:number, now:number, min7d:number, limit:number]
SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b,
       COUNT(*) AS games_7d,
       SUM(CASE WHEN a.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_a,
       SUM(CASE WHEN b.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_b,
       COALESCE(SUM(a.money_delta), 0) AS net_a,
       COALESCE(SUM(b.money_delta), 0) AS net_b,
       SUM(CASE WHEN r.ended_at >= ? THEN 1 ELSE 0 END) AS games_24h
FROM game_record_players_pdk a
JOIN game_record_players_pdk b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0
JOIN game_records_pdk r ON r.id = a.record_id
JOIN users ua ON ua.id = a.user_id AND ua.status='active'
JOIN users ub ON ub.id = b.user_id AND ub.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.player_count = 2 AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0
GROUP BY a.user_id, b.user_id
HAVING COUNT(*) >= ?
ORDER BY games_7d DESC, a.user_id ASC, b.user_id ASC
LIMIT ?

-- ④ 金币局局数 · 斗地主
-- params: [from26h:Date, now:Date, min:number, limit:number]
SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, COUNT(*) AS games
FROM game_record_players p
JOIN game_records r ON r.id = p.record_id
JOIN users u ON u.id = p.user_id AND u.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0
GROUP BY p.user_id
HAVING COUNT(*) >= ?
ORDER BY games DESC, p.user_id ASC
LIMIT ?

-- ⑤ 金币局胜局 ref · 斗地主
-- params: [from26h:Date, now:Date, limit:number]
SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version
FROM game_record_players p
JOIN game_records r ON r.id = p.record_id
JOIN users u ON u.id = p.user_id AND u.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1
ORDER BY p.id ASC
LIMIT ?

-- ⑥ 金币局局数 · 跑得快（params 同 ④；表 = _pdk）
SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, COUNT(*) AS games
FROM game_record_players_pdk p
JOIN game_records_pdk r ON r.id = p.record_id
JOIN users u ON u.id = p.user_id AND u.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0
GROUP BY p.user_id
HAVING COUNT(*) >= ?
ORDER BY games DESC, p.user_id ASC
LIMIT ?

-- ⑦ 金币局胜局 ref · 跑得快（params 同 ⑤；p.won 自 A2 迁移起存在且已回填）
SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version
FROM game_record_players_pdk p
JOIN game_records_pdk r ON r.id = p.record_id
JOIN users u ON u.id = p.user_id AND u.status='active'
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1
ORDER BY p.id ASC
LIMIT ?

-- ⑧ 结算 op 抽水（params: [from27h:Date, now:Date, limit:number]）
SELECT /*+ MAX_EXECUTION_TIME(30000) */ o.ref_id AS ref_id, o.burned_rake AS burned_rake
FROM currency_ops o
WHERE o.source = 'game_settle' AND o.created_at >= ? AND o.created_at < ? AND o.burned_rake IS NOT NULL
ORDER BY o.id ASC
LIMIT ?
```

### 5.4 判定（`collect`）

1. 八条查询按序；任一失败 ⇒ 记 `round_failures{scope,reason:'sql'}` + ERROR 日志 + 把对应玩法
   加入 `degradedGames`；超行 ⇒ `reason:'truncated'`；**继续**执行其余查询。
2. 同设备行（① ②）：SQL 已 `HAVING ≥3`；采集器**再复核** `games >= 3`（防御性，正确性不依赖
   SQL 谓词）；对 `user_a` 与 `user_b` 各产出一条
   `{check:'sameDevice', detail:{gameType, windowHours:168, pairUserId, deviceId, games}}`。
3. 对子行（③）：`games=games_7d`；**复核** `games >= 5`；`dominant = wins_a >= wins_b ? a : b`；
   `winRate = maxWins/games`；`netWin = dominant.net`；
   - `winRate >= 0.8 && netWin >= 1000` ⇒ 两侧各一条
     `pairWinRate`（detail 含 `gameType:'paodekuai', playerCount:2, windowHours:168,
     pairUserId/dominantUserId/games/wins/winRate/netWin`）；
   - `games_24h >= 10` ⇒ 两侧各一条 `pairFrequency`（detail 含 `gameType:'paodekuai',
     playerCount:2, windowHours:26, pairUserId/games`）。
4. 高抽水（④–⑦ ⑧）：
   - `counts` 行（已 `HAVING ≥20`）⇒ 采集器**再复核** `games >= 20` 得合格用户集；
   - `refRake: Map<"room:version", number>` = ⑧ 行按 `ref_id` 取 `max(burned_rake)`；
   - 对每个合格用户：`rakeUpperBound = Σ refRake.get(`${room_code}:${game_version}`) ?? 0`（只看
     其胜局行）⇒ `>= 5000` 出 `{check:'highRake', detail:{gameType, windowHours:26, games,
     rakeUpperBound}}`。
5. `hitsByUser`：每个 `(userId, check, gameType)` 去重一次（指标用）；`reasonsByUser` 是
   cap 后的 reasons（**每 (check, gameType) ≤3**，D10；排序：同 check 内 games 降序/净赢降序，
   再 pairUserId/deviceId 升序；check 顺序 sameDevice → pairWinRate → pairFrequency → highRake）。
6. `hitUsers` = `reasonsByUser` 的非空用户数（**只算 C3**；不含 winRate/devices）。

### 5.5 评分、reason 与降级

- `reviews.service.ts` 新增：
  `export type ScanCheck = 'winRate'|'devices'|'revived'|'sameDevice'|'pairWinRate'|'pairFrequency'|'highRake'`，
  `ScanReason.check` 改用它。
- `ScanService` 合并：`hit3 = fundReasons.length > 0`；`score = 25×(hit1+hit2+hit3)`。
  reasons 顺序 = 既有（winRate ddz → pdk 按人数升序 → devices）→ fund 四类。
- `deriveReviewGameType`：新 check 的 `detail.gameType`（缺省/未知 ⇒ ddz；`paodekuai` 特判）
  与 winRate 一起并入玩法集合；两玩法 ⇒ `mixed`；仅 devices ⇒ `platform`；无 reasons ⇒ null。
- `reviewInvolvedGames`：同样纳入新 check ⇒ 该玩法本轮不可用 ⇒ 最新行涉及它时 `applyScanResult`
  零写（既有语义）。
- `autoThrottleLine` **不改**：C3-only 命中（25 分）不武装；C3+胜率/设备（≥50）按既有线武装。
- **端到端承重用例**：FakeScanDb 对子命中 + 真实 `ReviewsService`（FakeRiskDb/FakeRedis）⇒
  落库行 `game_type='paodekuai'` 且 reasons 的 `detail.gameType` 在场（防「无 gameType ⇒ 玩法错标
  ⇒ 降级冻结失效 ⇒ 自动限流误释放」）。

### 5.6 扫描接入与指标

`scan.service.ts`：

- `onModuleInit`：`riskFundScanLastSuccessTimestampSeconds.set(0)`、`riskFundScanHitUsers.set(0)`、
  `riskFundScanRoundFailures` 6 个 `{scope,reason}` 组合 `set(0)`（与 `riskScanLastSuccessTimestampSeconds.set(0)`
  同点）。
- `runScanWork(now)`：既有 SQL1/1b/2 之后调用 `this.fundScan.collect(now)`；
  `degradedGames.push(...fund.degradedGames)`；把 `fund.hitsByUser` 的用户补进并集；
  逐用户拼 `fund.reasonsByUser` 并计入 `hit3`；对 `fund.hitsByUser` 的每个去重 `(check,gameType)`
  `incGame(riskFundScanHitsTotal, gameType, 1, { check })`。
- 轮末（自愈/open 计数之后）：
  - `riskFundScanRoundFailures` 6 组合按本轮 `failures` 计数 `set`（无失败全 0）；
  - 无 C3 失败 ⇒ `runs{result:'ok'}.inc()`、`last_success.set(now/1000)`、
    `hit_users.set(fund.hitUsers)`（**只有 C3 命中用户**）；
  - 有失败/截断 ⇒ `runs{result:'fail'}.inc()`、**不推进** last_success、**不刷新** hit_users；
  - 轮摘要日志追加 `fundHits=<fund.hitUsers> fundDegraded=<games> fundFailures=<n>`。
- `RiskScanRoundResult` **形状不变**（命中数走指标/日志，避免既有断言大面积改动）。

### 5.7 指标与告警

```text
risk_fund_scan_hits_total{check,game_type}        counter  check=sameDevice|pairWinRate|pairFrequency|highRake
risk_fund_scan_hit_users                          gauge    本轮 C3 命中用户数（仅全量成功轮刷新；启动 0）
risk_fund_scan_runs_total{result}                 counter  result=ok|fail
risk_fund_scan_last_success_timestamp_seconds     gauge    启动 0；全量成功轮写
risk_fund_scan_round_failures{scope,reason}       gauge    scope=doudizhu|paodekuai|ops；reason=sql|truncated；每轮全 6 组合 set
```

告警 3 条（`deploy/monitoring/prometheus/rules/ftl-alerts.yml`，38 → **41 条 / 38 类**）：

```yaml
- alert: RiskFundScanQueryFailures
  expr: 'max by (scope) (max_over_time(risk_fund_scan_round_failures[15m])) > 0'
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: '资金异常采集查询失败（scope={{ $labels.scope }}）'
    runbook: '看 user-service 日志 scope 对应查询（doudizhu/paodekuai/ops）；超时/截断/表权限；本轮对应玩法冻结，下一轮自愈。'
- alert: RiskFundScanStalled
  expr: 'time() - max_over_time(risk_fund_scan_last_success_timestamp_seconds[15m]) > 7200'
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: '资金异常采集 >2h 未全量成功（含从未成功）'
    runbook: '查 user-service 扫描日志、currency_ops/game_records(_pdk) 可达性；round_failures 分 scope/reason。'
- alert: RiskFundHitsHigh
  expr: 'max_over_time(risk_fund_scan_hit_users[15m]) > 10'
  for: 2h
  labels:
    severity: warning
  annotations:
    summary: '资金异常信号集中（单轮命中用户 >10 持续 2h）'
    runbook: '看管理端审核队列（reasons 的 pairUserId/deviceId）与 06-risk 面板；按对子/设备人工核对，不自动封禁。'
```

同步面（机械闸）：头部 41/38、`scripts/verify-monitoring.mjs`（EXPECTED_ALERTS +3、头注释、
ALERT_PREDICATES +3、GLOBAL_ALERTS +3、结构断言 +3）、`Dockerfile.prometheus` 注释、
`slice-16` EXPECTED_RULES +3、`slice-18`/`slice-24` 38→41 + C3 名集、`docs/ops/first-deploy.md`
监控节 +1 段。

### 5.8 测试与 conformance

- `test/fund-scan.test.ts`（新）：8 条 SQL 全文/参数类型/占位次序（含设备 `last_seen_at` 两个
  cutoff）/`ORDER BY`/`LIMIT=cap+1`；四信号阈值边界的 `==` 与 `+1`（采集器 JS 复核面，
  fake 行不依赖 SQL HAVING）；每条 reason 的 `detail.gameType/windowHours`；机器人/练习/好友房/
  非 active 由 SQL 钉；对子两侧都命中；同设备多设备分组；`ref_id` 重复取 max；NULL rake/无 op
  跳过；cap 按 (check,gameType)；失败/截断 ⇒ degraded + round_failures；`user_devices` 缺行/
  陈旧 `last_seen_at` ⇒ 无同设备命中。
- `test/risk-scan.test.ts`（扩）：`FakeScanDb` 识别 8 条新 SQL；C3-only=25、C3+winRate=50、
  C3+devices=50、三项=75；reasons 拼接顺序；`game_type` 推导（ddz/pdk/mixed）；降级冻结
  （C3 pdk 失败 + 最新 pdk 行 ⇒ 零写；ops 失败 ⇒ 两玩法）；`autoThrottleScore=25` 时 C3-only
  仍不武装；runs/last_success/hit_users/round_failures/hits_total 指标；**仅 winRate/devices
  命中的轮次 ⇒ hit_users 保持 0**；启动置 0；轮摘要日志；**真实 ReviewsService 端到端落库
  `game_type='paodekuai'`**。
- `test/risk-metrics.test.ts`（扩）：5 个指标名/标签面。
- `room-service/test/metrics-game-type-invariant.test.ts`：TARGETS + `riskFundScanHitsTotal`。
- `tools/conformance/src/slices/slice-36-fund-anomaly.ts`（新）：
  - **用户**：`registerUser` 注册全部测试用户（`JOIN users … active` 承重；fake id 会被全过滤）。
    RUN_TAG 前缀用于清理标记。
  - **注入**（`mysqlExec`，逐列写全）：
    - 对子正例 uA/uB：10 条 PDK 2 人记录（uA 全胜），`money_delta` 分别 +150/−150（SQL UPDATE
      回填）⇒ pairWinRate + pairFrequency；
    - 只命中 pairWinRate 的对子 uD/uE：10 局都 >26h 且 <7d ⇒ pairWinRate 有、pairFrequency 无；
    - 同设备正例 uA/uB：3 条同桌记录 + `user_devices` 共享 device_id（`last_seen_at=NOW()`）⇒
      sameDevice；另插一对 `last_seen_at` 8 个月前的共享设备 + 3 局 ⇒ **不得** sameDevice；
    - 高抽水 uC：20 条 DDZ 金币记录（uC 全胜）+ 20 条 `currency_ops`
      （`action_id, request_hash, source, game_type, ref_id, burned_rake, created_at` 逐列；
      ref=`room:ver`，rake=300）⇒ highRake 6000；
    - 负例：4 局对子 uF/uG；19 局金币 uH；陈旧设备（`last_seen` 8 个月前）；7d 外记录；
      **仅 devices 命中**用户 uI（4 台设备 > 阈值 3）⇒ 证明 `hit_users` 不因既有信号变化。
      （实现说明：winRate-only 需要把全局胜率阈值压到很小，会让全部正例同时命中胜率、
      破坏 score=25 判据；devices-only 同样覆盖「既有信号不进 hit_users」的口径，且零阈值污染。）
  - **触发**：`PUT risk.scanIntervalMs=5000` → `docker restart ftl-user-service` → 健康 →
    **清 `risk:scan:lock`**（旧实例在轮中被杀时 EX 600 会挡窗）→ 轮询
    `GET /api/admin/risk/reviews`（keyset 翻页最多 3 页；等待**期望 check 集齐**而非仅
    reasons 非空，防部分快照假红）。
  - **断言**：逐用户精确 reason 集（正例四类详情字段、负例缺具体 check）；score=25；
    `gameType` 与 `game_type` 过滤（paodekuai/doudizhu 各自只回对应+mixed）；
    `execCurl('ftl-user-service', 9001, INTERNAL_TOKEN)`：
    `risk_fund_scan_hit_users` ≥ C3 正例用户数且 **≤ 队列中带 C3 reason 的用户数**
    （口径上界），`hits_total` 四 check 在场、`last_success > 0`、
    `runs{result="ok"} ≥1`、`round_failures` 全 0；
  - **零写**：注入前后本片 room/action 前缀的记录/ops 行数不变（扫描不改记录/ops）。
  - **清理**：删注入行（记录/players/devices/ops）、dismiss 条目、还原 `risk.scanIntervalMs`；
    注册用户保留（无删除接口；以 RUN_TAG 标记）。
  - baselines 只进 full；本机 Docker 不可用 ⇒ 只做 `tsc`；**slice-36 未过权威轮不得称 C3 完成/
    不得合 dev**。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 单条 C3 SQL 失败/超时 | `round_failures{scope,'sql'}` + 对应玩法降级；其余查询继续 |
| 查询返回超 cap | `round_failures{scope,'truncated'}` + 降级；该查询结果**整段丢弃**（不参与判定） |
| ops 查询失败/截断 | 两玩法均降级（高抽水不可判） |
| 全部 C3 查询失败 | 两玩法降级 + 6 个失败 gauge 计数；轮不因此整轮失败（既有 win-rate 失败路径不变） |
| 玩法降级 + 用户最新审核行涉及该玩法 | `applyScanResult` 零写（冻结，防误释放自动限流） |
| 无任何命中 | score 0/25/50/75 照常快照；hit_users=0 |
| `money_delta` NULL | 按 0 计（净赢只认金币；见 §6.1 晚到边界） |
| `burned_rake` NULL / 无 op | 该局抽水按 0（上界；可能假阴性） |
| 同 ref 多条 op | 取 `max(burned_rake)`（防 r2/重试双计） |
| `user_devices` 无行 / 陈旧 / 设备清理 | 无同设备命中（D6/D20） |
| 旧客户端无 deviceId | 无同设备命中（D20） |
| 记录晚到超过 26h 扫窗 | 永久漏计（D20；C1 的 RecordLost/outbox 指标是人工补偿入口） |
| 房号复用 | 只按 `room:version` 取 op；`ref_id` 唯一性由 settle 侧保证，登记边界 |
| 冻结/降级持续 | `RiskFundScanQueryFailures` 5m、`RiskFundScanStalled` 2h |

### 6.1 已知边界（D20 全表）

1. **记录无 `device_id`**：同设备信号 = 「账号-设备绑定（7d 内见过）∩ 同桌」的近似，不是逐局
   设备证据。
2. **旧客户端不带 `deviceId`** ⇒ 该客户端不产生同设备证据。
3. **设备保留期清理**（365 天）会丢历史关联；`last_seen_at` 7d 过滤已挡住陈旧绑定。
4. **`money_delta` 晚到 >1h 永久 NULL**（`recordmoney:outbox` TTL 1h）：pairWinRate 的净赢
   门槛对该批对局不可判（按 0 ⇒ 假阴性）；pairFrequency 仍覆盖频次。**不**放宽 U7 阈值。
5. **rake=0**（种子默认）⇒ 高抽水信号静默；金币场须显式开抽水。
6. **PDK 2 人场 / PDK 金币场种子关闭** ⇒ pairWinRate/pairFrequency/PDK highRake 在默认部署下
   不响；本片不打开开关（父 spec 红线），交付报告如实说明当前可响面。
7. **扫窗不是硬保证**：C1 outbox 的 `createdAt` 修复路径（非法/未来时间 ⇒ 重置为 now）可把
   投递推迟到 `ended_at+24h` 之后；26h 扫窗覆盖「24h TTL + 1h 扫描周期 + 1h 相位」，更晚的
   晚到仍会漏计。补偿策略 = 不做自动补偿；由 C1 的 `RecordLost`/`RecordOutboxAbandoned` 告警
   与人工核对兜底。
8. **窗口衰减 ⇒ 自动解除/再武装循环**：winRate+C3=50 的用户停止行为后，24h/7d 口径信号随窗口
   滑出 ⇒ score 回落到 25 < 线 50 ⇒ `throttled(auto)` 自动解除；再犯再武装。这是既有状态机
   语义（`risk_actions` 有审计），登记为预期行为。
9. **整玩法冻结是粗粒度安全取向**：任一 C3 查询持续失败会冻结该玩法所有用户的评分更新（含
   胜率）；由 QueryFailures/Stalled 立即告警；若线上观测到长期冻结，另立「按 check 精确降级」。
10. **多副本抓取粘滞（与既有 `RiskScanStalled` 共享债务）**：C3 告警用 `max_over_time`
    抗「抓取在副本间交替」的 series 抖动；但 Prometheus 对 `user-service:9001` 单
    ClusterIP target 的 HTTP keep-alive 可能**粘在一个未持锁副本**上（该副本
    `last_success` 恒 0、gauge 恒 0）⇒ Stalled 可能常亮、QueryFailures/HitsHigh 可能失明。
    根治 = 副本间共享进度（Redis 进度键并由各副本镜像到本地 gauge）或 per-pod 抓取 +
    `max by` 聚合；**另立项**（同样覆盖既有 RiskScanStalled，不在 C3 单方面改口径）。

## 7. 迁移与回滚

- 零 DB 迁移 / 零配置键 / 零协议 / 零客户端 / 零 admin 代码；回滚 = revert 本片提交。
- 不新增 Redis 键；沿用 `risk:scan:lock` 与 1h 自调度。
- 部署顺序不变（user-service 既有表 + currency_ops 已在库）。

## 8. 测试判据

1. `pnpm -C packages/user-service test` / `lint` 全绿。
2. `pnpm -C packages/room-service test -- metrics-game-type-invariant` 绿（TARGETS 增量）。
3. `node scripts/verify-monitoring.mjs` 绿（41/38 + 结构断言）；判别力自证（把 severity 移出
   labels ⇒ 红）执行并恢复。
4. `pnpm -C tools/conformance lint`（tsc）绿；slice-36 注册/baseline 可检。
5. 全量 `pnpm exec turbo run test lint --force --concurrency=1`（0 cached；环境 flake 单跑复证）。
6. `pnpm verify:admin`（零 admin 改动，防回归）。
7. **真栈 slice-36 必须在权威轮通过**（本机 Docker 不可用 ⇒ 待权威轮；未过不得称完成）。
8. 工作区干净；diff 不含协议/迁移/配置键/客户端/slice-29/PdkSettlement.vue。

## 9. 涉及文件

生产：
- `packages/user-service/src/risk/fund-scan.ts`（新）
- `packages/user-service/src/risk/scan.service.ts`
- `packages/user-service/src/risk/reviews.service.ts`
- `packages/user-service/src/risk/risk.metrics.ts`

监控/文档：
- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `docs/ops/first-deploy.md`
- C3 spec/plan

测试/conformance：
- `packages/user-service/test/fund-scan.test.ts`（新）
- `packages/user-service/test/risk-scan.test.ts`
- `packages/user-service/test/risk-metrics.test.ts`
- `packages/room-service/test/metrics-game-type-invariant.test.ts`
- `tools/conformance/src/slices/slice-36-fund-anomaly.ts`（新）
- `tools/conformance/src/run.ts`、`baselines.json`
- `slice-16-monitoring.ts`、`slice-18-gold-room.ts`、`slice-24-ads-relief.ts`

## 10. 审查记录

### 10.1 计划对抗审查（2026-10-28，独立 reviewer）

结论：**无阻断**；8 高 / 11 低。处置全部并入 v2：

| # | 级别 | 发现 | v2 处置 |
|---|---|---|---|
| H1 | 高 | pairWinRate/pairFrequency 的 reason 无 `detail.gameType` ⇒ 审核行玩法错标 + 降级冻结失效 + 自动限流误释放 | D2/§5.4：四类 reason 恒带 `gameType`；§5.5 增真实 `ReviewsService` 端到端落库用例；fund-scan 测试断言每条 reason |
| H2 | 高 | `hit_users` 口径未钉死（若含 winRate/devices ⇒ RiskFundHitsHigh 常亮） | §5.4-6/§5.6：`hit_users := FundCollection.hitUsers`（仅 C3）；单测「仅 winRate/devices ⇒ hit_users 0」；slice-36 加仅 winRate 用户 |
| H3 | 高 | 25h 在「周期 1h+d」与 TTL 修复下不保证覆盖 | D3：24h 信号扫窗改 **26h**；D13 ops 窗 **27h**；D20-7 登记「非硬保证 + 不自动补偿（C1 告警兜底）」 |
| H4 | 高 | 记录晚到 >1h ⇒ `money_delta` 永久 NULL，pairWinRate 净赢门槛失效未登记 | D20-4：显式登记（按 0 假阴性；频次仍覆盖；不放宽阈值） |
| H5 | 高 | `user_devices` 无 `last_seen_at` 窗口 ⇒ 陈旧绑定误报 | D6/§5.3：① ② 加 `d/e.last_seen_at >= ?`（绑 from7d）；slice-36 加陈旧设备负例 |
| H6 | 高 | 默认/种子下 PDK 2 人、PDK 金币、rake=0 ⇒ 四信号实际只响一个 | D20-5/6：登记三前置；不打开开关（父 spec 红线）；交付报告如实说明可响面 |
| H7 | 高 | 裸 gauge + ClusterIP 多副本 ⇒ 新告警 `for:` 失效/抖动；counter `increase` 假放大 | D15/D16/§5.7：失败面改 gauge `round_failures`（每轮 6 组合 set，含 0）；三条表达式全用 `max_over_time`；既有 RiskScanStalled 隐患另立登记 |
| H8 | 高 | slice-36 未说明真用户与 `currency_ops` NOT NULL 列 ⇒ 权威轮必红 | D19/§5.8：`registerUser` 真用户、ops 逐列写全、devices 走 `uk_user_device`、清理/保留策略写明 |
| L1 | 低 | `ScanCheck` 类型不存在 | §5.1/§5.5：在 `reviews.service.ts` 真加别名 |
| L2 | 低 | `fundScan` / `fundCollector` 字段名漂移 | §5.1/§5.6 统一 `this.fundScan` |
| L3 | 低 | 假测试与 SQL HAVING 矛盾 | §5.4：采集器 JS 侧复核全部阈值（SQL HAVING 只降行数）；测试用 fake 行覆盖边界 |
| L4 | 低 | slice-36 负例清单自相矛盾 | §5.8：每负例独立用户、逐用户精确 reason 集 |
| L5 | 低 | ⑥/⑦ 未逐字；「PDK 无 p.won」错误 | §5.3 逐字给出 ⑥/⑦；改用 `p.won = 1`（A2 迁移已回填） |
| L6 | 低 | LIMIT 无 ORDER BY、不构成成本上限 | D12/§5.3：8 条全加确定性 ORDER BY；LIMIT=结果上限、30s 提示=成本上限；截断结果整段丢弃 |
| L7 | 低 | 超时/截断 reason 标签矛盾 | D12/§6：超时=`sql`、超行=`truncated` |
| L8 | 低 | `FUND_WINDOW_24H_MS=25h` 命名与裁决口径漂移 | §5.2：改名 `FUND_SCAN_WINDOW_24H_MS = 26h`，注释写明「24h 口径 + 2h 余量」 |
| L9 | 低 | 窗口衰减 ⇒ 自动解除/再武装循环 | D20-8：登记为既有状态机预期行为 |
| L10 | 低 | 每 check 3 条上限可能丢某玩法证据 | D10：改为每 **(check, gameType)** 3 条 |
| L11 | 低 | 整玩法冻结过宽（可选优化） | D11/D20-9：保留安全取向并登记；长期另立按 check 精确降级 |

### 10.2 代码对抗审查（2026-10-28，独立 reviewer 审 `13ac394f..HEAD`）

结论：**Critical 0 / Important 0 / Minor 7 / PLAUSIBLE 3**。处置（全部已修或登记）：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| M1 | Minor | C3 runs/round_failures 在整轮失败路径（双玩法 SQL/设备 SQL/apply 全败/自愈抛）跳过，与 HELP「每轮结束 +1」矛盾 | 已修：`runScanInner` 的 catch 记 `risk_fund_scan_runs_total{fail}`；补「设备 SQL 抛 ⇒ fund runs fail+1」用例 |
| M2 | Minor | D10「被截断条数进轮末聚合日志」未实现 | 已修：`FundCollection.droppedByCap` + 轮末日志 `fundDropped=`；cap 用例断言 |
| M3 | Minor | last_success 用 `Date.now()` 而非注入 `now`；单测被 setSystemTime 掩盖 | 已修：改 `now / 1000`；测试移除 setSystemTime（真实时钟≠T0） |
| M4 | Minor | slice-36 uI 用 devices-only（spec 原写 winRate-only），且 hit_users≥5 无法发现口径污染 | 已修：uI 用 devices-only（阈值污染说明入 spec）；新增 `hit_users ≤ 队列中带 C3 reason 用户数` 上界 |
| M5 | Minor | slice-36 未断言 runs{ok}、缺 game_type 过滤断言 | 已修：断言 `runs{result="ok"}≥1`；补 paodekuai/doudizhu 过滤的 6 条断言 |
| M6 | Minor | degradedGames 可含重复玩法 | 已修：交状态机前 `[...new Set()]`；补「胜率+C3 同玩法失败」用例 |
| M7 | Minor | 边界缺口：B 支配分支 / 分组截断 scope / 非法回执 | 已修：三条用例 |
| P1 | PLAUSIBLE | 多副本 + ClusterIP keep-alive 粘滞 → 新告警可能常亮/失明（与既有 RiskScanStalled 同病） | 登记 §6.1-10：`max_over_time` 只解交替抖动；根治（Redis 进度镜像 / per-pod + max 聚合）另立项，覆盖既有告警 |
| P2 | PLAUSIBLE | slice-36 真栈时序：部分快照受理 / 首页找不到命中 / 锁残留 | 已修：等待**期望 check 集齐**、keyset 翻页 3 页、触发后清 `risk:scan:lock` |
| P3 | PLAUSIBLE | plan 参数次序笔误（⑤⑦ 写成 from27h） | 已修 plan |
