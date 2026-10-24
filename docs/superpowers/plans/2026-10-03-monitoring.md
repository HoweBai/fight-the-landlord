# 监控片实施计划（v2 —— 过计划审查后订正 6🟠+8🟡+提示 3 条；经收口复核定稿）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 事故第一时间可知——Prometheus 全栈（prometheus/grafana/alertmanager/node-exporter/cadvisor/alert-relay 六容器）+ 六服务独立指标端口 + 双通道告警（邮箱原生 + relay 转发飞书/钉钉/企微）+ `/grafana/` 公网看板；备份新鲜度只上板。

**Architecture:** `shared/src/metrics`（prom-client 模块：HTTP 中间件 + 独立指标监听端口 Bearer 守卫 + **构造器再导出**，**不碰** internal-token 豁免面）→ 六服务 `main.ts` 各 2 行接线 + 各域业务指标（room ws/队列/房、game 会话、robot 决策、user 记录清理）→ Prometheus 抓 **13 目标**（六服务 + douzero + node-exporter/cadvisor/prometheus/alertmanager/grafana/alert-relay）→ **13 条**规则 → Alertmanager（shell 条件拼装）→ 邮箱 + relay → 三 IM；Grafana 面板 as code 经门口 `/grafana/`。

**Tech Stack:** NestJS（六服务）· prom-client 15.1.3（shared）· prometheus_client 0.26.0（douzero）· Prometheus v3.15.0 · Grafana v13.2.3 · Alertmanager v0.34.1 · node-exporter v1.12.1 · cadvisor v0.60.6（GHCR 搬运）· Node 20（relay）· vitest · conformance · docker compose。

**权威文本（遇到与真实代码冲突 ⇒ 停下报协调者，不自行改设计）：** 规格 **v1.1** `docs/superpowers/specs/2026-10-03-monitoring-spec.md` · 设计 **v1.2 定稿** `…-design.md` · 审查史 `.superpowers/sdd/2026-10-03-monitoring/`。

## Global Constraints

- **提交纪律**：每次改动一个 commit；结尾固定带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **分支**：`feat/monitoring`（T1 第一步从 master 创建；收口 `--ff-only` 合入 master）。
- **版本钉死**（规格 §0 表，一处写死一处引用）：prometheus **v3.15.0** · grafana **v13.2.3** · alertmanager **v0.34.1** · node-exporter **v1.12.1** · cadvisor **v0.60.6** · prom-client **15.1.3** · prometheus-client **0.26.0** · node **20-slim**（六服务）/ **node:20-alpine**（relay，O1） · pnpm **9.15.0**。
- **不触面**（改了就是事故）：
  1. `internal-token.middleware.ts` 五份**零改动**、豁免面仍恰两条健康路径；
  2. 六服务 `main.ts` 只**插行**（trace 之后 + `listen()` 前），其余顺序一字不动；
  3. 结算链 / `game.settlement` 9 键契约 / 日志九字段 / `RECORDS_CLEANUP_INTERVAL_MS` 语义（只加指标写点）；
  4. 生产形态**零宿主端口**（新块一律 `expose`）；`edge` 的既有端口面不动；
  5. 动既有切片/脚本/工作流前**先全仓 grep**（规格 §4 头注——防隐藏文件相交）。
- **口径**：空串 = 未设（`${VAR:-}` 透传 + `||` 消费）· webhook URL/secret **永不进日志/指标标签** · textfile **原子写（tmp+mv）** · fail-closed（缺 token/口令 ⇒ 401/拒起）· `retention.size` = 按块回收软上限。
- **⚙️ 实施期核对点（规格 ⚙️ 原文逐条钉到可执行 step，共 11 处）**：robot 决策落点行（T5）· cadvisor healthcheck 工具/权限（T9b 实测定去留）· route `req.route?.path` 模板形（**T12 真栈探针**）· `container_last_seen` 可用性（T12 生效核对）· cadvisor relabel 标签口径/重建语义（T12）· **官方 CMD `docker inspect` 逐字**（T9a）· `amtool check-config`（T9a，无则以「起容器即验证」兜底）· 锁竞争退出码（T11）· AM payload golden（T12 真栈 dump 一例 ⇒ 回填 T8 fixture）· **grafana `/metrics` 鉴权**（T12，Y9）· **node-exporter `--help`/procfs-sysfs 收缩核**（T9b 实测 + T12 生效核对：`node_filesystem_*`/`node_memory_*` 在则收缩安全，否则回填加回——防 HostDisk/Memory 规则静默哑火）。
- **迭代纪律（本片新口径）**：迭代期只跑受影响包测试；**六阶段只在 push 前跑一次**；全序 conformance = 验收一次；本机真栈只在 T12（`conformance-stack.sh`，`--profile monitoring`）与 T13 各用一轮。
- **判据只增不减**；baselines：静态读数本机先填 + CI 首跑实测回填（纪律 #4）。
- **参考成例**：`Dockerfile.user-service`（relay 镜像 COPY 次序模板）· `shared/src/logging/trace-middleware.ts`（结构类型中间件先例）· `deploy/Caddyfile:37-54`（redir/handle 实测经验 + /admin 两条）· `slice-07.5-backup.ts:306-310`（backup.sh 的 CLI flags 测试先例 + 全程 `docker exec` 先例）· `tools/conformance/src/lib/client.ts`（WS 客户端）· `slice-14-config-center.ts:531/:561`（C20 先例）· `conformance-stack.sh:71,:13-14,:62/:64`。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `packages/shared/src/metrics/*`（新 4 + 测试）+ `shared/package.json` | 指标模块（registry/HTTP 中间件/独立监听） | T1 |
| 六个 `packages/*/src/main.ts` | 各 2 行接线 | T2 |
| `packages/room-service/src/{metrics/room.metrics.ts,metrics/room-metrics.service.ts,match/match.service.ts,gateway/ws.gateway.ts,gateway/ws.module.ts,rooms/rooms.start.ts}` | 指标定义（模块级常量）+ rooms 采样器 + **队列读数挂既有扫描环** + 开局/结算计数 | T3 |
| `packages/game-service/src/{metrics/game.metrics.ts,metrics/game-metrics.service.ts,game/game.service.ts,app.module.ts}` | games_active | T4 |
| `packages/robot-service/src/robot/{robot.metrics.ts,robot.service.ts}` | 决策计数（定义与落点同包） | T5 |
| `packages/user-service/src/records/{records.metrics.ts,records-cleanup.service.ts}` | 四指标 | T6 |
| `douzero/{server.py,pyproject.toml,uv.lock}` | /metrics + 三指标 | T7 |
| `packages/alert-relay/*`（新包） | AM→IM 转发 | T8 |
| `Dockerfile.{prometheus,grafana,alertmanager,alert-relay}` · `deploy/monitoring/**` · `deploy/Caddyfile` | 镜像与配置 | T9 |
| `docker-compose.yml` · `docker-compose.override.yml` | 六服务块 + 卷 + dev 面 | T9 |
| `tools/conformance/src/slices/slice-07.2-deploy.ts` 等四文件 | 既有闸更新（**与 T9 同提交**） | T10 |
| `scripts/deploy/{build-images.sh,conformance-stack.sh}` · `scripts/ops/{backup.sh,install-cron.sh}` | 供给链 | T11 |
| `tools/conformance/src/slices/slice-16-monitoring.ts` · `run.ts` · `baselines.json` | 新判据 | T12 |
| `.github/workflows/*` · `docs/ops/first-deploy.md` · `docs/design.md` · 路线图 · 台账 | 收口 | T13 |

## 执行顺序与依赖

```
Wave1（文件不相交，可三路并行）：
  T1（shared 指标模块）┐
  T8（alert-relay）    ├─ 互不共享文件
  T9（镜像+编排，T10 同提交）+ T11（供给链）┘
Wave2（依赖 T1；六路小任务，可并行）：
  T2（六 main.ts）· T3（room）· T4（game）· T5（robot）· T6（user）· T7（douzero）
  ⚠️ Wave2 前置：T1 完成后先 `pnpm --filter @fight-the-landlord/shared build`（workspace 经
     `main: dist` 解析——不 build 则 T2–T6 跑在缺/陈旧 dist 上；迭代期改动 shared 后同理）
  ⚠️ T9 的「四镜像真构建」验证须在 T8 落地后执行（Dockerfile 要 COPY 新包）；起草可并行
Wave3：
  T12（slice-16 + run.ts + baselines）——依赖 T2–T9/T11 全落地；含真栈一轮
Wave4：
  T13（收口：文档/文案/全序一次/push master → CI 派出去回头收）→ handoff（用户 .env + 上线 + 验收演练）
```

**同提交硬约束**：T9 与 T10 **必须一个提交**（compose 六块 + R1303「8→12」渲染断言 + 07.4-pipeline「恰好 8」——分开提交 ⇒ render-gate 在中间那次 push **必红**）。

## 判据 → 任务对照（防漏）

| 判据 | 落点 |
|---|---|
| C1 七目标 401/200（exec） | T12（依赖 T1–T7） |
| C2 targets 13 + 降级参数化 + rules 计数 | T12（`MONITORING_EXPECT_CADVISOR`） |
| C3 promtool check config/rules | T12 |
| C4 边缘 /grafana 301/200 + /metrics 404 | T10（07.3-edge 断言）+ T12（真栈 301/200 与负对照） |
| C5 relay 格式/隔离/守卫（stub） | T8（单测）+ T12（真栈 stub） |
| C6 Grafana 四面板 + 未设口令不启动 | T9a（守卫）+ T12 |
| C7 备份 textfile 两向 + carry-forward + 上板 | T11（backup.sh）+ T12 |
| C8 relay 单测（golden/签名/隔离/无 URL） | T8 |
| C9 shared 单测（归一化/守卫） | T1 |
| C10 WS gauge 恰一次 + 真栈探针 | T3（单测）+ T12 |
| C11 业务 gauge 存在性/值域 | T3/T4/T5（实现）+ T12 |
| C12 记录清理四指标 + 初值语义 | T6（单测）+ T12 |
| C13 渲染面（R1303/零端口/日志上限） | T10（与 T9 同提交） |
| C14 供给链（静态三断言 + 两形态渲染；真 up/down 由 CI 天然覆盖） | T11 + T12（切片内静态） |

---

## Task 1: shared 指标模块（`packages/shared/src/metrics/`）

**Files:**
- Create: `packages/shared/src/metrics/{registry.ts,http-metrics.ts,metrics-listener.ts,index.ts}`（index 可并入 registry）
- Create: `packages/shared/src/metrics/{registry,http-metrics,metrics-listener}.test.ts`
- Modify: `packages/shared/src/index.ts`（导出）+ `packages/shared/package.json`（`"prom-client": "15.1.3"`）+ **`pnpm-lock.yaml`**（随 `pnpm install` 一并提交——CI 阶段 1 是 `--frozen-lockfile`）

**Interfaces（规格 §2.3 + 本版补钉）：** `metricsRegistry(): Registry`（单例）· `initMetrics(): void`（幂等）· `createCounter(name, help, labelNames?)` / `createGauge(...)` / `createHistogram(name, help, labelNames?, buckets?)`——**再导出构造器并强制 `registers: [metricsRegistry()]`**（registry 同一性由构造器保证：任何业务指标不可能静默落到别的 registry；T3–T6 一律经它构造，**不**给各包直连 prom-client 的路径）· `createHttpMetricsMiddleware(): (req,res,next)=>void`（`res.on('finish')` 时按 `req.route?.path ?? 'unmatched'` 计数；`http_requests_total{method,route,status}` + `http_request_duration_seconds{method,route}` 9 桶）· `startMetricsListener({port}): {close():Promise<void>}`（`GET /metrics`；`Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`，env 未设 ⇒ 一律 401；其余路径 404；**不经** HTTP 中间件）。

- [ ] **Step 1: 建分支** `git checkout -b feat/monitoring`
- [ ] **Step 2: 写失败测试**（C9）：① route 归一化——两个不同 query 的同 path 合一条；无 route ⇒ `unmatched`；② 守卫——无 header/错 header/env 未设 ⇒ 401，正确 ⇒ 200 且 body 可被正则解析出 `http_requests_total`；③ `initMetrics()` 调两次不重复注册（默认指标数不翻倍）；④ **registry 同一性**——用 `createGauge()` 造的指标出现在 `metricsRegistry().metrics()` 输出里（反例：直接 `new Gauge()` 不在——证明构造器的强制是必要的）。
- [ ] **Step 3: 实现**（结构类型、零 Nest/express 依赖——照 `trace-middleware.ts` 先例；`startMetricsListener` 用 `node:http`；构造器包装层 ~10 行）。
- [ ] **Step 4: 验证**：`pnpm --filter @fight-the-landlord/shared test`、`pnpm --filter @fight-the-landlord/shared lint`（两条分开——pnpm 只认一个脚本名）、**`pnpm --filter @fight-the-landlord/shared build`（产出 dist = Wave2 的前置）**。
- [ ] **Step 5: Commit**：`feat(shared): 监控片地基 —— metrics 模块（HTTP 中间件 + 独立监听 + Bearer 守卫 + 构造器）`。

## Task 2: 六服务 `main.ts` 接线

**Files:** Modify 六份 `packages/*/src/main.ts`（各 2 行）。
**端口表：** gateway 9000 · user 9001 · room 9002 · game 9003 · robot 9005 · config 9006。
- [ ] `app.use(createHttpMetricsMiddleware())` 插在 `createTraceMiddleware()` 之后（**网关**：trace 之后、`enableCors()` 之前）；`startMetricsListener({ port })` 插在 `listen()` 前。
- [ ] **⚙️**：route 模板形**不在此测**（main.ts 接线物理上测不了）——真栈探针归 **T12**；本任务只对接线位置与六包编译负责。
- [ ] **验证**：六包各跑 `pnpm --filter @fight-the-landlord/<pkg> test` 与 `… lint`（两条分开；前置：shared 已 build）。
- [ ] **Commit**：一次提交六服务（同一改动面）。

## Task 3: room-service 指标（ws gauge + 采样器 + 计数）

**Files:** Create `packages/room-service/src/metrics/{room.metrics.ts,room-metrics.service.ts}`（+测试）；Modify `packages/room-service/src/match/match.service.ts`（**队列读数挂进既有扫描环**——周期 = config `room.matchScanIntervalMs` 种子 5s；**ZCARD 新增**）· `packages/room-service/src/gateway/ws.gateway.ts` · `packages/room-service/src/gateway/ws.module.ts` · `packages/room-service/src/rooms/rooms.start.ts`（开局计数——`startRoom` :106 成功点）· `game.ended` 订阅处理点（`ws.gateway.ts:670`，结算计数）。
**Interfaces：** `room.metrics.ts` = **模块级导出常量**（经 shared `createGauge/createCounter` 构造）：`ws_connections`（**inc 点必须在鉴权/注册完成之后**——`:248` 只是入口，⚙️ 钉实际行；`handleDisconnect:396` dec——**硬换手 :295-312 与陈旧断线早返 :416-422 恰一次**）· `games_started_total`/`games_ended_total`（**WsModule（ws.gateway）与 StartModule（rooms.start）双侧直接 import 常量——避开跨模块 DI**）；`room-metrics.service.ts`：**只采 `rooms_active`**（15s，`SCAN room:*` 排派生键，照 `rooms.service.ts:164-169` 判别）。（`match_queue_length` 在 match 扫描环内 set——O4。）
- [ ] **Step 1: 失败测试**（C10/C11 单测半边）：连接→1、断线→0、硬换手不双计、陈旧断线不误减；采样器对假 redis（mock scan 返回两条键）产出正确 gauge 值。
- [ ] **Step 2: 实现**（采样器自重排 timer + 关停闸——照 `records-cleanup.service.ts` 的 setTimeout 链形态；`room-metrics.service.ts` 注册进 `ws.module.ts`）。
- [ ] **Step 3: 验证**：`pnpm --filter @fight-the-landlord/room-service test`、`pnpm --filter @fight-the-landlord/room-service lint`（两条分开）。
- [ ] **Step 4: Commit**：`feat(room): 监控片 —— ws 连接/队列/房间/开结算指标`。

## Task 4: game-service `games_active`

**Files:** Create `packages/game-service/src/metrics/{game.metrics.ts,game-metrics.service.ts}`（+测试）；Modify `packages/game-service/src/game/game.service.ts`（加只读 getter `activeSessionCount(): number` → `cache.size`）· `packages/game-service/src/app.module.ts`。
- [ ] 15s 采样 set gauge（定义经 shared `createGauge`，HELP 注明 **per-instance**）；单测：注入假 service（size 3）⇒ gauge=3；关停后不再排 timer。
- [ ] **验证**：`pnpm --filter @fight-the-landlord/game-service test`、`… lint`（两条分开）。**Commit**：`feat(game): 监控片 —— 活跃会话数指标（per-instance 语义）`。

## Task 5: robot-service 决策计数

**Files:** Create `packages/robot-service/src/robot/robot.metrics.ts`（counters 定义：`robot_decisions_total{result,skill}`——result∈{douzero,rule}（= 设计 result 名对齐）+ `robot_decision_errors_total{reason}`（Y4：叫牌期恒 rule，失败读这里）；Modify `packages/robot-service/src/robot/robot.service.ts`（决策收口返回点；⚙️ 实施时钉行——在 `result∈{douzero,rule}` 分支各 inc 恰一次；失败路径 inc errors）。
- [ ] 单测（可在既有 robot.service 测试内加例）：走 douzero 路径 ⇒ `{result="douzero"}` inc；规则回落路径 ⇒ `{result="rule"}` inc；douzero 超时/不可达路径 ⇒ `robot_decision_errors_total` inc；skill 标签 ∈ `SKILL_LEVELS`。
- [ ] **验证**：`pnpm --filter @fight-the-landlord/robot-service test`、`… lint`（两条分开）。**Commit**：`feat(robot): 监控片 —— 决策计数（result×skill）+ 失败计数`。

## Task 6: user-service 记录清理四指标

**Files:** Create `packages/user-service/src/records/records.metrics.ts`（四指标定义：shared 构造器）；Modify `packages/user-service/src/records/records-cleanup.service.ts`（+测试增例）。
- [ ] 写点（规格 §1.2 行）：`onModuleInit` ⇒ `records_cleanup_last_success_timestamp_seconds 0`；成功分支（`:127-135` 附近）⇒ set 时间戳 + `records_rows_deleted_total.inc(recordsDeleted)` + `records_table_bytes`（`information_schema` 两表 DATA+INDEX 求和——**查询失败不得影响清理本身**，catch 后仅 WARN）；失败 catch（`:97-99`）⇒ `records_cleanup_failures_total.inc()`。
- [ ] 单测：① 首轮成功 ⇒ 时间戳 >0 且 deleted 计数=返回值；② 构造「从未成功」（直接 new 后不跑）⇒ gauge=0（C12 初值语义）；③ 失败一轮 ⇒ failures+1 且时间戳**不变**。
- [ ] **验证**：`pnpm --filter @fight-the-landlord/user-service test`、`… lint`（两条分开）；**Commit**：`feat(user): 监控片 —— 记录清理四指标`。

## Task 7: douzero `/metrics`

**Files:** Modify `douzero/server.py`（`do_GET` +3 指标）· `douzero/pyproject.toml` · `douzero/uv.lock`（`prometheus-client==0.26.0`）。
- [ ] `prometheus_client` 默认集 + `douzero_decides_total{result}`（四路 :261/:264/:276/:280 分别 `unknown_model`/`not_loaded`/`ok`/`error`）· `douzero_decide_seconds`（只包 `_act`）· `douzero_models_loaded`（启动装载后 set）。
- [ ] **⚙️**：`import` 顺序/`multiprocess` 不需要（单进程）确认；`uv lock` 更新锁。
- [ ] **验证**：`python -m py_compile douzero/server.py`；真栈 curl 归 T12（C1）。
- [ ] **Commit**：`feat(douzero): 监控片 —— /metrics（决策计数/延迟/模型数）`。

## Task 8: alert-relay 服务（`packages/alert-relay/`）

**Files:** Create `package.json`（name `@fight-the-landlord/alert-relay`、`prom-client@15.1.3`、tsc/vitest）· `tsconfig.json` · `src/{config.ts,format.ts,sinks.ts,metrics.ts,server.ts}` · `test/{format,sinks,sign,server}.test.ts`；Modify **`pnpm-lock.yaml`**。
**契约：** 规格 §2.6 逐字（`POST /webhook` Bearer · 200/500 语义 · 三 sink 载荷与签名 · 5s 超时 · 空串=未设 · `/health` 无守卫 · `/metrics` 带守卫 · URL/secret 不进日志）。
- [ ] **Step 1: 失败测试**（C8）：format golden（含多 alert/含特殊字符）· 钉钉签名**对照向量**（固定 ts+secret ⇒ 固定 sign，手工算一例）· 槽位开关（空串不发）· 单槽 500 隔离（其余仍 200）· 全槽 500 ⇒ 500 · 日志捕获断言无 URL/secret。
- [ ] **Step 2: 实现**（`node:http` 无框架；`Promise.allSettled` + `AbortSignal.timeout(5000)`）。
- [ ] **Step 3: ⚙️**：AM payload golden —— T12 真栈 dump 一例后回填 `test/` 的 fixture。
- [ ] **验证**：`pnpm --filter @fight-the-landlord/alert-relay test`、`… lint`（两条分开；新包自动进 workspace 六阶段）。
- [ ] **Commit**：`feat(alert-relay): 监控片 —— AM webhook → 飞书/钉钉/企微 转发服务`。

## Task 9: 镜像与编排（**与 T10 同提交**）

**Files:** Create `Dockerfile.{prometheus,grafana,alertmanager,alert-relay}` · `deploy/monitoring/**`（规格 §1.1 全组）· Modify `deploy/Caddyfile`（§2.8 两条 handle）· `docker-compose.yml`（§2.1 六块 + 三卷）· `docker-compose.override.yml`（dev 面）。
- [ ] **9a 镜像侧**：prometheus/AM/grafana 的 Dockerfile（FROM 官方 + COPY 配置 + entrypoint；prometheus 预建 `/etc/prometheus/secret` `chown 65534:65534` mode 700；**entrypoint flag 形态照规格 §2.4ter/§2.5 的 O3 订正**——prometheus 只补增量 flag，AM 不转发 `"$@"`；⚙️ `docker inspect` 钉官方 CMD）· relay Dockerfile（**`node:20-alpine`**，O1）照 `Dockerfile.user-service` COPY 次序（两门对账闸）· 三份 entrypoint（§2.4ter/§2.5/§2.7）· prometheus.yml + **13 条**规则（§2.4/§2.4bis）· provisioning 三件 + 四面板 JSON（dashboards COPY 到 **`/etc/grafana/dashboards`**——卷外，R1）· **⚙️** amtool（无则以「起容器即验证」兜底）。
- [ ] **9b 编排侧**：compose 六块（逐字照 §2.1；house 注释补全 + **node-exporter flag 收缩**（Y13：保留 `--path.rootfs` **与** `--collector.textfile.directory=/textfile` 两个 flag））· override 六块（profiles/ports/dev env/GF dev root_url）· Caddyfile 两条 handle · **不做 TEXTFILE_HOST_DIR**——样例写入走 C7 的**经容器写**（O6：daemon 侧解析路径，Linux CI 与 Windows dev 通吃；不加新变量、不加 `.gitignore` 条目）。
- [ ] **验证**：`docker compose -f docker-compose.yml config`（零未定义变量、六块渲染正确）· `docker compose config`（dev 形态）· dry = `docker buildx bake -f docker-compose.yml --print`（应恰 **12** 个 target——cadvisor 无 `build:` 不计入）· 真 build 用脚本既有用法 `PUSH=0 bash scripts/deploy/build-images.sh dev`（**⚠️ relay 镜像构建须在 T8 落地后**）。**⚙️** cadvisor 搬运镜像落地后核 healthcheck 工具与权限。
- [ ] **Commit（与 T10 合并）**：`feat(infra): 监控片 —— 六服务编排/镜像/Caddy 路由 + 既有渲染判据同步（8→12）`。

## Task 10: 既有闸更新（**并入 T9 的提交**）

**Files:** Modify `tools/conformance/src/slices/{slice-07.2-deploy,slice-07.4-pipeline,slice-07.2-hardening,slice-07.3-edge}.ts`。
- [ ] 07.2-deploy：`BUILD_SERVICES:555` 8→12、`:560-564` 「恰好」、`:565-591` 镜像名渲染、`TOKEN_SERVICES:124` +3、`LOG_LIMIT_TARGETS:955-959` +6（`DIRECT_PORT_SERVICES`/`HEALTH_TARGETS` 不动——语义不符，规格 §4）。
- [ ] 07.4-pipeline：`:956-961` 8→12 + `:66` 注释。
- [ ] 07.2-hardening：`:963` 包清单 += `alert-relay`。
- [ ] 07.3-edge：+`/grafana` 两 handle 断言（先例引 slice-14 的 C20）。
- [ ] **验证**：先 `pnpm --filter @fight-the-landlord/conformance build`（不 build ⇒ dist 陈旧：「先红」红不了、「后绿」测的是**旧切片**）；然后 `CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy --render`（**逐字照 `ci.yml:53`**——不带 env 会连真栈四步一起跑）与 `node tools/conformance/dist/run.js slice-07.4-pipeline --render`——**先红后绿**各一次。

## Task 11: 供给链（build-images / conformance-stack / backup / install-cron）

**Files:** Modify `scripts/deploy/build-images.sh`（§2.10 搬运步）· `scripts/deploy/conformance-stack.sh`（§2.11 三段）· `scripts/ops/backup.sh`（§2.9 textfile + trap）· `scripts/ops/install-cron.sh`（mkdir textfile 目录）。
- [ ] **⚙️**：backup.sh 的锁竞争退出码口径实施时钉（规格 §2.9 的 case 分支）。
- [ ] **验证**：`bash -n` 四脚本；backup.sh 以 `TEXTFILE_DIR=$(mktemp -d)` + CLI flags 对 scratch 替身**本地实跑一轮**（C7 的单测半边；失败注入路径也跑一轮）。
- [ ] **Commit**：`feat(ops): 监控片 —— cadvisor 搬运/监控 profile 三路径/备份 textfile 指标`。

## Task 12: conformance `slice-16-monitoring` + 注册 + baselines

**Files:** Create `tools/conformance/src/slices/slice-16-monitoring.ts`；Modify `src/run.ts`（import + `CASES` 注册——**追加在末尾**：`run.ts:58-63` 注释「顺序即 CI 切片循环与 full 回填顺序」）· `baselines.json`。
- [ ] 实现 C1–C14（规格 §3 逐条；载体形态照 slice-07.5 的 `docker exec` 先例与 lib 设施；跑前先 `pnpm --filter @fight-the-landlord/conformance build`）。
- [ ] **真栈一轮（本片验收前唯一一次）**：`bash scripts/deploy/conformance-stack.sh up`（contains `--profile monitoring` 供给 cadvisor）⇒ 跑 `slice-16-monitoring` **单切片** ⇒ 修复 ⇒ 再跑绿 ⇒ `down`（零残留断言）。
- [ ] **⚙️ 真栈核对组**：① route 模板形（带 query 请求后 metrics 里**无原始 URL**）；② `container_last_seen` 实际可用性（不可用 ⇒ 从 relabel 白名单去掉并在规格回填）；③ cadvisor relabel 的标签口径与重建/重启语义；④ AM payload **dump 一例** ⇒ 回填 T8 的 golden fixture；⑤ grafana `/metrics` 鉴权（Y9——若需鉴权则 scrape 加 basic_auth 并回填规格 C2）。
- [ ] **C2 自证/降级**：正则自证 `count(container_start_time_seconds{name=~"/?(ftl-.*)"}) >= 6`；降级按规格 checklist（env `MONITORING_EXPECT_CADVISOR=0` 的注入点与随动清单，Y3）。
- [ ] **C5 机制（O5）**：切片自带**容器化 stub**（`node:20-alpine` 内联脚本记录请求 + `docker exec … wget -qO- /_received` 回读）+ **同 tag relay 探针实例**（受控 env 三种组合：全未配/部分/全配）。
- [ ] **C7③ 经容器写**（O6）：`docker run --rm -v <textfile 挂载源>:/t node:20-alpine sh -c 'printf … > /t/sample.prom && chmod 644 /t/sample.prom'` ⇒ Prometheus 查到（上板链路）。
- [ ] **C10 基线化口径**（Y8）：先读基线 → 连接一条 → 基线+1 → 断开 → 回基；单测补「拒握手不计入」负对照。
- [ ] **baselines 回填**：`slice-16-monitoring` 计数 + full 列（静态先填项本机数出；纯 CI 项 CI 首跑回填）。
- [ ] **Commit**：`test(conformance): 监控片 slice-16（指标面/守卫/告警链/边缘路由/供给链）`。

## Task 13: 收口

**Files:** Modify `.github/workflows/{images,release,conformance}.yml` + `scripts/deploy/build-images.sh`（「8 个」**6 处实测分布**（Y10）：`release.yml:43/:82` · `images.yml:1/:31` · `build-images.sh:2/:32`；+「7 镜像」+ release 算术）· `docs/ops/first-deploy.md`（五小节 + `.env` 表 + 发布前注意 + **计数清扫**：`:3`/`:25`/`:32`/`:123`/`:396`/`:693`/`:703`/`:722`/`:739`/`:755`/`:759`/`:806`，收口前全仓再 grep）· `docker-compose.yml` 头注（`:2`/`:8`/`:10`）· `docs/design.md`（§1.3 YAGNI 行注记「监控片已落地」）· `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`（`:62`/`:66` 措辞订正）· 台账。
- [ ] **六阶段一次**：`pnpm run ci`（push 前唯一一次）→ 全绿。
- [ ] **全序 conformance（本机，验收一次）**：`conformance-stack.sh up` ⇒ `run.js`（全量列表）⇒ 绿 ⇒ `down`。
- [ ] **合入**：`--ff-only` 合 `feat/monitoring` → master；push master（**CI 三个 workflow 派出去、回头收**：ci/conformance/images 全绿 = 收口证据）。
- [ ] **首跑回路**：若 CI 首跑 conformance 因 `slice-16` 计数与 `baselines.json` 差/缺席而红 ⇒ 按 CI 日志订正 `baselines.json`（**render 列不动**）⇒ 再 push（照记录片 T10②/③ 同型）。
- [ ] **Handoff（交用户，非本计划可执行步骤）**：① 服务器 `.env` 加 `GRAFANA_ADMIN_PASSWORD`（必填）与通道变量；② 打 tag 上线（先 push master——既有纪律）；③ **验收演练需用户在场**（停一个容器 2 分钟 ⇒ 收邮件/IM + Watchdog 心跳到点）。
