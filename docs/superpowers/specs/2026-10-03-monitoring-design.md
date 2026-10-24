# 监控片：事故第一时间可知（Prometheus 全栈 · **设计层 v1.2 · 定稿**）

> **状态**：v1.2 —— **定稿本**。已过**两轮**独立审查：r1（事实核验 52 条：成立 44/部分 8/不成立 0 + 引用小错 5 · 完备性 🔴3/🟠5/🟡10，全数处置）· r2（修订验证：处置落地 32/32；新发现 🔴1〔cadvisor 供给链缺 PULL_MODE=0 支路，已补两路供给〕/🟠3/🟡8，全数处置；**收口复核通过 · 放行**）。审查报告在 `.superpowers/sdd/2026-10-03-monitoring/`（工作区工件不入库）。**设计层定稿；规格层已可启动。** 处置对照见**附录 A**（r1）与**附录 B**（r2）。
> **分层**：本文 = 设计层；形式化层另起 `docs/superpowers/specs/2026-10-03-monitoring-spec.md`。
> **来源**：路线图 `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`「监控片」节 + 本会话用户裁决（§1.1）+ 实测探查（§2，全部带出处）。
> **本片不做**：日志聚合/检索（Loki/ES）· APM/分布式追踪 · 短信/电话/值班升级 · 外部 dead-man switch（改为无外部依赖的 Watchdog 心跳）· M0.3 的自动暂停登录（只提供读数）· 备份新鲜度告警（独立闸在先，本片只上板）。
> ⚙️ **回填注记（货币片 T11，2026-10-04）**：本文件全部「六个 Nest 服务 / 13 个目标（job）」类计数为设计时（2026-10-03）事实；货币片 +`currency-service`（独立指标端口 **9004**、第 13 个自建镜像）后 ⇒ 现状 **七个 Nest / 14 个 job**（`deploy/monitoring/prometheus/prometheus.yml` 与 `slice-16-monitoring` 的 `EXPECTED_JOBS=14` 已随货币片更新）。历史文本**不逐个改写**（不重写历史），以本注记为准。

---

## 0. 一句话

同机新增 **6 个小容器**（Prometheus · Grafana · Alertmanager · node-exporter · cadvisor · alert-relay；**容器数是对路线图草案「2–3 个容器」的实测修订**，见 §2.2）：六个 Nest 服务各起一条**独立内部指标端口**（HTTP 端口 + 6000，Bearer token 守卫，**不碰**既有 `x-internal-token` 豁免面）、douzero 在自身 2021 端口加 `/metrics`；Prometheus 抓取全部目标，规则覆盖**服务下线 / 5xx 错误率 / 磁盘 / 内存 / WS 连接数 / 容器重启潮 / 记录清理**七类，外加一条「告警链自身投递失败」的元告警与一条 **Watchdog 心跳**；告警走 Alertmanager = **邮箱（原生）+ relay 转发飞书/钉钉/企微**（三个 IM 槽位谁配谁生效；邮箱与 relay 通道**结构性冗余**；SMTP 未配时 AM **照常健康**、只是没有邮件通道）；Grafana 面板经门口 **`https://<域名>/grafana/`** 对外（登录保护），Prometheus/Alertmanager UI 不发布；**备份新鲜度只上板不设铃**（路线图裁决，独立闸在先）；日志面零改动（分工：日志管细节追查，监控管阈值打铃 + 曲线）。

---

## 1. 输入

### 1.1 用户裁决（逐条，本设计不得与之冲突）

| # | 问题 | 裁决 | 来源 |
|---|---|---|---|
| 1 | 下一步做哪个 | **监控片**（本次开工） | 本会话 |
| 2 | 告警通道 | **邮箱 + 飞书 + 钉钉/企业微信**（多通道冗余；IM 走转发小容器——三槽位配置驱动，谁配谁生效） | 本会话 |
| 3 | Grafana 访问 | **公网路径 `/grafana/`**（现有域名与证书，零 DNS 改动；靠 Grafana 登录保护） | 本会话 |
| 4 | （顺延裁决）原 M0.2「最小日志告警」 | **不做**；真监控系统由本片落地 | 路线图 2026-10-03 裁决 |
| 5 | 备份新鲜度 | **只做可视化**、不设监控侧告警（独立闸在先） | 路线图监控片范围草案 |

**对路线图的两处措辞订正（r1b-E1）**：路线图 `:62` 写「Nest **七个**服务走 prom-client」——本仓 Nest 服务是 **6 个**（gateway/user/room/game/robot/config），**6 + douzero = 七个采集目标**；路线图 `:66` 的「**2–3 个容器**」是草案估值，本设计经实测（§2.2）定为 **6 个**。两处订正随本片收口写回路线图（§D9）。

### 1.2 既有约束（本仓纪律，逐条适用）

- **生产形态只 edge 发布宿主端口**（R98/R1203）：新增 6 服务一律 `expose` 不 `ports`；对外新面只有 `/grafana/` 一条路由。
- **镜像唯一来源 = CI 构建推 GHCR**（R1303/R1304）；服务器不构建，`build-images.sh`（bake 自 compose `build:` 条目）**自动纳入新服务**——「8 个自建镜像」的文案与判据按实测更新为 12（§D9）；**cadvisor 另需 CI 从 gcr.io 搬运到 GHCR**（服务器拉不到 gcr，§2.2 实测）。
- **部署原则**（2026-09-23 用户裁决）：*部署统一使用最终镜像，容器不依赖宿主机产物；挂载只用于日志、需要持久化的内容*。①c 判据（`slice-07.2-deploy`）钉的是「**落进 `/app` 的 bind**」（真身 `slice-07.2-deploy.ts:301`）——node-exporter/cadvisor 的宿主只读挂载（`/proc`、`/sys`、`/rootfs`）与 textfile 目录 bind **都不在其列，本片不触、不放宽该判据**。
- **配置进镜像、密钥只从服务器 `.env` 进容器**：配置源文件进仓库 → CI bake 进镜像（照 `deploy/Caddyfile` + **仓库根 `Dockerfile.edge`** 先例——`deploy/` 下只有 Caddyfile，r2-🟡1 订正）；密钥在容器启动时由 entrypoint 从环境变量生成——**仓库与镜像零明文密钥**；生成文件 mode 600、webhook URL 等凭据**永不进日志**（S2）。
- **fail-closed 纪律**（R89 同类）：Grafana 无口令 ⇒ entrypoint 守卫**拒绝启动**（真机制，非声明，O4）；Prometheus 拿不到 token ⇒ 全部目标 401（监控整体响亮地红，而不是静默裸奔）。
- **内部 token 边界不动**：`createInternalTokenMiddleware` 的豁免面**仍然只有健康检查两条**；本片的指标端点走**独立监听端口 + 自有 Bearer 守卫**，与它完全平行（§D2）。
- **不重造日志面**：九字段 NDJSON（`log-record.ts` 的 `LOG_FIELDS` 恰九项）+ traceId 全链已跑；本片只加指标面。
- **判据只增不减**；每次改动一个 commit（CLAUDE.md）；**静态切片的基线回填免首跑红仪式**（本机确定性读数先填 + CI 首跑即验）。
- 用户**没有运维背景**：手册讲「你/玩家会看到什么」，术语括号里带一次。

---

## 2. 现状（实测事实，全部带出处；引用经 r1a 逐条核）

### 2.1 栈与部署形态

| 事实 | 依据 |
|---|---|
| 生产形态 = `docker-compose.yml` 单文件（10 服务：redis · mysql · douzero · user/config/room/game/robot-service · api-gateway · edge），**只有 edge 发布宿主端口**（80/443） | `docker-compose.yml:1-11`（两形态说明）+ `:514-517`（唯一 `ports` 块 = edge） |
| 项目名钉死 `name: pokergame`；网络 `ftl-platform` 钉 `172.28.0.0/16`；edge 固定 `172.28.0.250` | `docker-compose.yml:51,552-559,528` |
| 各服务内网端口：gateway 3000 · user 3001(+RPC 3101) · room 3002 · game 3003(+3103) · robot 3005(+3105) · config 3006(+3106)；douzero 2021 · redis 6379 · mysql 3306。⚠️ `expose` 只见于 5 块（user `:151-153` · config `:220-222` · game `:345-346`〔仅 3103〕· robot `:389-390`〔仅 3105〕· gateway `:452-453`）；room/douzero/redis/mysql 无 `expose`——端口值另据各 `main.ts` 缺省与 override 宿主映射核（r1a-12） | 逐块对照 + `douzero/server.py:27` |
| 日志上限 `10m×5`：**10 个服务齐全**；健康检查：六个 Nest 服务 `curl /api/health`（`:180,:258,:316,:362,:427,:496`），redis=`redis-cli ping`（`:69`）· mysql=`mysqladmin`（`:93`）· douzero=python urllib `/health`（`:121`）· edge=curl :80（`:538`）（r1a-13） | 逐块对照 |
| **开发形态** = 不显式给 `-f` 时自动合并 `docker-compose.override.yml`；**门口用 profile 机制**：基文件不带 profile、override 里 `profiles: ["edge"]`（`override:106-108`），`docker compose --profile edge up` 才起——「基线常开、开发按需」的**既有先例**（本片监控栈照此办理） | `docker-compose.yml:6-11`；`conformance-stack.sh:33-35` |
| conformance 起栈脚本 = `conformance-stack.sh up|down`：开发形态 + `--profile edge`；GHCR 拉取路径把 8 个镜像 retag 回本地名（`SERVICES` 数组 `:22`）；`DEGRADED_IMAGE` 常量依赖 `pokergame-api-gateway:latest` 本地名；**`down` 删不掉带 profile 的容器（R1209）——必须按 profile 点名 `rm -sf` 门口（`:71`）再 `docker compose down`（`:73`）**，残留检查 `:75-77` | `conformance-stack.sh:22,44-51,66-77` |

### 2.2 生产机资源实测（2026-10-03，SSH 只读；`VM-0-7-ubuntu` · `<DEV_HOST_IP>`）

| 项 | 读数 |
|---|---|
| CPU / 内存 | 4 核；7.5 GiB 总，**used 1.6 GiB、available 5.9 GiB**；swap 1.9 GiB（用 524 KiB） |
| 磁盘 | `/` 118 GiB，**used 30 GiB（26%）、avail 84 GiB** |
| 全栈 10 容器内存（`docker stats` 快照） | mysql 401.6 MiB · douzero 95.1 · api-gateway 58.3 · user 56.6 · config 54.5 · room 43.3 · game 39.8 · robot 39.7 · edge 13.3 · redis 4.3 —— **合计 ≈ 806 MiB** |
| 全部容器 healthy（服务近日发布后 20h 稳定） | 同次 `docker ps` |
| **镜像源可达性（同次 `docker manifest inspect`）** | `prom/prometheus:v3.15.0` · `grafana/grafana:13.2.3` · `prom/alertmanager:v0.34.1` · `prom/node-exporter:v1.12.1` —— **全部 REACHABLE**；**`gcr.io/cadvisor/cadvisor:v0.60.6` 与 `ghcr.io/google/cadvisor/cadvisor` 均 UNREACHABLE**（gcr 被墙；GHCR 上无该镜像）⇒ cadvisor 必须由 CI 搬运到 GHCR（§D4） |

⇒ 结论：监控栈（预估 ≤1 GiB 含 cadvisor）在同机预算内——路线图「立项时实测资源后定」已完成；**容器数 2–3（草案）→ 6（实测后定）的差值在此登记**。

### 2.3 服务启动链与中间件序（本片接线点）

| 事实 | 依据 |
|---|---|
| 六个服务 `main.ts` 同形：`INTERNAL_SERVICE_TOKEN` 缺失即 `process.exit(1)`（R89）→ `Logger.overrideLogger(redacting)` → `NestFactory.create` → `app.use(createTraceMiddleware(...))` → `app.use(createInternalTokenMiddleware())`（网关为 CORS/pipes 等，无此中间件）→ pipes → `setGlobalPrefix('api')` | `user-service/src/main.ts:12-47`；`api-gateway/src/main.ts:9-55` |
| 五份 `internal-token.middleware.ts` **同形**：user/config/room 三份**逐字**；game 仅注释差异；**robot 为常量级差异**（不 import protocol，本地 `const UNAUTHENTICATED = 10002`，值相同）（r1a-17） | 五文件对照；`protocol/src/errors.ts:17` |
| trace 中间件在 `shared`（`packages/shared/src/logging/trace-middleware.ts`），服务侧只 `app.use()` —— **通用可观测中间件放 shared 的既有先例** | 同上注释 |
| `shared` 目前仅依赖 `protocol`（零外部运行时依赖）；**client 明确只依赖 protocol**（包描述「哑终端」）⇒ 给 shared 加指标依赖**不会**进客户端打包 | `shared/package.json:13-15`；`apps/client/package.json:6,27` |
| 全仓目前 **零处** `prom-client` 使用（监控从零起）；npm 最新 `prom-client@15.1.3`（engines node ^16\|\|^18\|\|>=20） | 全仓 grep 零命中；2026-10-03 实测 |

### 2.4 内部 token 边界（本片必须绕开、不修改）

| 事实 | 依据 |
|---|---|
| 中间件罩住**一切路径**，豁免面 = 恰两条精确匹配（`/api/health`、`/api/health/live`）；注释明文「**豁免面仍然只有健康检查**：不得为业务路由开任何例外」 | `internal-token.middleware.ts:41-43` |
| 拒绝语义：缺失/不配 ⇒ `10002` 401（`ErrCode.UNAUTHENTICATED`）；未配置 `INTERNAL_SERVICE_TOKEN` 时**一切**业务路由拒（再兜一层 fail-closed） | 同文件 `:62-79` |
| ⇒ **`/metrics` 不得走「加入豁免清单」的路**（那是判据放宽）；本片在**独立端口**上起指标监听，与主 HTTP 管线完全平行 | 本设计 §D2 |

### 2.5 可观测性现状（分工地基）

| 事实 | 依据 |
|---|---|
| 日志片已交付：九字段 NDJSON + traceId 全链（含 RPC `meta`）+ 日志上限；**指标/看板当时明确不做** | `observability-logging-design.md:160-161`；`docs/design.md:84`（§1.3 YAGNI 行） |
| 本片反转 `design.md` §1.3 的「数据看板、Prometheus/Grafana」YAGNI 行——依据 = 路线图监控片（`:53` 整节）+ 用户裁决（§1.1） | 路线图 `:12,:25,:53` |

### 2.6 部署 / CI 链（本片要接入的四条）

| 事实 | 依据 |
|---|---|
| `images.yml`（push master）与 `release.yml`（tag）都调**唯一构建配方** `scripts/deploy/build-images.sh:2,30-33,49`：`docker buildx bake -f docker-compose.yml`，**目标自动来自 compose 的 `build:` 条目**（现「恰好 8 个」是注释，不是清单） | `images.yml:7-9,36`；`release.yml:54-56` |
| `release.yml` = images→conformance→deploy 三 job 串行（`:27,:58,:68,:72`）；部署 = `deploy.sh`（送 compose `:114-118` → pull `:159` → `up -d` `:207` → 冒烟三条 `:238-240` → prune `:266`）+ **`release.yml` deploy job 的备份核查链**（装备份 `:130`、首次备份 `:187`、C4 收尾断言 `:230`、备份新鲜度（最后一步）`:250`）——**核查链不在 `deploy.sh` 里**（r1a-26） | 如上 |
| 服务器 `.env` 手工维护（手册 **§2.2**「必须五项」`first-deploy.md:219-230` + 片⑦ 两个运维键）；**部署不校验 .env 完整性**——缺 key 的行为由各容器自己的 fail-closed 决定 | `first-deploy.md:205,219-230` |
| 备份链：宿主 cron 每小时跑 `backup.sh`；**四件产物**（manifest/users sql/caddy-data/env）⇒ **服务器 `.env` 自动在备份伞内**；新鲜度闸 `check-backup-fresh.sh` **只在 runner 侧跑、刻意不落服务器**（`:2-4`；`MAX_HOURS=3` `:40`） | `first-deploy.md:988,1008`；`check-backup-fresh.sh:2-4,40,82` |
| `backup.sh` 现无任何 textfile 写入：备份目录 `chmod 700`（`:59`）、失败早退 5 处（`:78,:107,:136,:145,:152`）、成功尾 `:181` —— 本片要在此加 textfile 落点（O1，§D1/D9） | `scripts/ops/backup.sh` 逐行核 |

### 2.7 既有闸面（本片同提交机械面总表；§D9 引用）

| 闸 | 现状 | 本片动作 |
|---|---|---|
| `slice-07.2-deploy` ①c/①c′/②c（`:812-847,:920-932`，谓词 `:301`） | 两形态「落 `/app` 的 bind」= 零 | **不触**（新挂载都不落 `/app`，§1.2） |
| `slice-07.2-deploy` R1303 渲染面 | `BUILD_SERVICES` 8 项（`:555`）+「恰好这 8 个」断言（`:560-564`）+ 两种渲染的镜像名（`:565-583`）；另有一批服务清单断言（`TOKEN_SERVICES:124` · `DIRECT_PORT_SERVICES:132` · `HEALTH_TARGETS:364` · `LOG_LIMIT_TARGETS:955-959`） | **8→12**：清单 + 各服务清单 + 镜像名渲染（新自建服务**沿 R1303 命名模板**）；判据形状不动 |
| `slice-07.4-pipeline` | 从 compose 派生「带 `build:` 服务集合」断言**恰好 8**（`:956-960`，注释 `:66`）——`ci.yml:56-63` 的 render-gate **每次 push/PR 都跑**（不需要 docker）⇒ **现在是「每次 push 必红点」**（r1b-R2） | 8→12 + 注释；baselines 的 render 列同提交回填 |
| `slice-07.2-hardening` 出站超时闸 | 硬编码包清单 `:963`（`api-gateway,user-service,room-service,game-service,robot-service,shared`）——**不含未来的 alert-relay**（r1b-Y3） | 清单 += `alert-relay` |
| `slice-07.3-edge` / Caddyfile | `redir` 显式 matcher 与 handle 组按 matcher 重排的**实测经验**在 `deploy/Caddyfile:37-45`、`/admin` 两条 handle 在 `:48-54`；**`/admin` 301 的 C20 判据住在 `slice-14-config-center.ts:531/:561`**（`run.ts:61` 映射）——不在 edge 切片（r1a-31） | 新增 `/grafana` 两 handle 断言（先例引对）；**新旧 handle 次序必须真栈实测**（引先例机制） |
| Dockerfile 对账闸（`shared/test/dockerfile-workspace-copy.gate.test.ts:154-161` · `dockerfile-patches-copy.gate.test.ts:97-104`） | 动态扫 `Dockerfile.*`：凡 `COPY package.json`+`pnpm install` 者必须 COPY 齐工作区依赖与 `patches/` | `Dockerfile.alert-relay` **照 `Dockerfile.user-service` 的 COPY 次序模板**（Y4）；另 3 个（FROM 官方+COPY 配置）不参与 |
| `conformance-stack.sh` | `SERVICES` 8 项；`--profile edge`；**down 侧 R1209 点名 rm** | 三路径全扩（up/down/pull-retag；§D9） |
| `tools/conformance/src/slices/` | 现至 `slice-15-records`（211 断言，`baselines.json:32`） | 新增 `slice-16-monitoring` |
| `baselines.json` | 按 CI 实测回填（静态读数可本机先填） | 新切片基线 + full/render 列更新 |

---

## 3. 设计决策

### D1 — 采集面（指标注册表；每项都有用途行）

**通用（六个 Nest 服务，独立指标端口）**：

| 指标 | 类型 | 标签（基数界） | 用途 |
|---|---|---|---|
| `http_requests_total` | counter | `method` × `route`（Express 模板，~30/服务）× `status`；未匹配落 `unmatched` | 错误率告警（5xx 占比）+ RPS 面板 |
| `http_request_duration_seconds` | histogram（9 桶 5ms–2.5s） | 同上 | p95 面板；**P5 触发条件的「延迟读数」** |
| prom-client 默认集（`process_*` / `nodejs_*`） | gauge/counter | — | 每服务内存/事件循环/句柄；RSS 曲线 |

**业务（各服务的 in-process 态；维度有界，标签里永不出现 userId/roomCode）**：

| 指标 | 类型 | 来源（落点） | 用途 |
|---|---|---|---|
| `ws_connections` | gauge | room-service `ws.gateway.ts`：`handleConnection`（`:248`）/`handleDisconnect`（`:396`）升降；**实现时必须核两处会让朴素计数出错的路**——硬换手（新连接顶旧，`:295-312`）与陈旧断线早返（`:416-422`，"Ignoring stale disconnect"），保证每条连接恰一次加减（r1a-35 订正：全仓无「transfer」之名） | **连接数告警（M0.3 的 8000 线）** + 面板 |
| `match_queue_length{mode,base_score}` | gauge | room-service `match/match.service.ts`：`SCAN match:queue:*`（键格式 `:79`、pattern `:83`、既有 SCAN `:283/:409`）；**周期由 config `room.matchScanIntervalMs` 驱动（种子 5000ms**，`config-cache.service.ts:27` / `PlatformConfig.ts:38`；旧 ~15s 是设计笔误，r1a-36 订正）；**深度读取（ZCARD）现无、由本片新增** | 排队拥堵面板 |
| `rooms_active` | gauge | room-service rooms 域（源在规格层定稿；**单实例语义**标注） | 进行中对局读数 |
| `games_started_total` / `games_ended_total` | counter | room-service 开局/结算点 | 业务速率面板；结算异常对比 |
| `robot_decisions_total{result,difficulty}` | counter | robot-service 决策收口（result 值域规格定稿） | 机器人健康面板 |
| `records_cleanup_last_success_timestamp_seconds` | gauge | user-service `records/records-cleanup.service.ts`——**启动即以 0 初始化**（语义 =「本次进程从未成功」，O3：缺席会让告警永不响），成功时 set 当前时间（落点即成功分支 `:131` 处） | 「清理任务停滞」告警 |
| `records_cleanup_failures_total` | counter | 同文件失败分支（现仅日志 `:97-99` 处补 inc） | 「清理任务失败」告警 |
| `records_rows_deleted_total` | counter | 成功分支按删除行数 inc | 清理速率面板 |
| `records_table_bytes` | gauge | 每轮用 `information_schema` 近似值 set（DATA+INDEX 长度） | 记录表增长面板（P1 新事故面） |

**基础设施**：

| 目标 | 方式 | 用途 |
|---|---|---|
| douzero `:2021/metrics`（`/health` 保持公开不动——健康检查要用，`server.py:241-247`） | Python `prometheus_client`（`pyproject.toml` 加依赖）：`douzero_decides_total{result}` · `douzero_decide_seconds` 直方图 · `douzero_models_loaded` gauge | AI 引擎健康；决策延迟 |
| `node-exporter`（官方，`prom/node-exporter:v1.12.1`） | 宿主 `/proc` `/sys` `/rootfs` 只读挂载 + **`--collector.textfile.directory=/textfile`**（挂宿主 `/home/ubuntu/ftl-monitoring/textfile`，见 D9-O1；目录 755 / 文件 644、**原子写（tmp+mv）**〔node-exporter 以 nobody(65534) 读〕；写失败仅 warn、不拖垮备份——r2-🟡7） | 主机 CPU/内存/磁盘/负载；**磁盘告警**；**备份新鲜度上板**（`backup_last_success_timestamp_seconds` / `backup_last_attempt_timestamp_seconds{result}`，由 `backup.sh` 写入） |
| `cadvisor`（**镜像经 CI 搬运到 GHCR**，§D4；版本 v0.60.6） | 官方推荐只读挂载（**不 privileged 优先**，实测定策）；relabel **白名单**（`container_cpu_usage_seconds_total` · `container_memory_working_set_bytes` · `container_start_time_seconds` · `machine_memory_bytes` 等）+ `name=~"ftl-.*"` + docker_only。**语义边界（规格钉）**：`changes(container_start_time_seconds[1h])` 对**同 ID 重启**（crash-loop）灵敏；**容器重建**（每次发布 recreate）是否计入取决于 relabel 是否保留 `id` 标签——「重启潮 = crash-loop 监测」写进规则注释（Y5） | **容器重启潮告警**；覆盖 edge/mysql/redis 这些没有自暴露指标的容器（edge 挂 = 全站挂） |
| 元监控 | Prometheus 自抓 · Alertmanager · Grafana（`GF_METRICS_ENABLED=true`）· relay 的 `alert_deliveries_total{sink,result}`（`/metrics` **带 Bearer 守卫**，与六服务同口径，S2） | **告警链自身的失败可见**（relay 发信失败会在拿到指标后由邮件通道报出） |

抓取参数：`scrape_interval` 15s（cadvisor 30s）；Prometheus 保留 **30 天 + 5 GiB**（`retention.size` 是**按块回收意义下的软上限**——官方口径，规格写明语态，Y6；磁盘另有 `HostDiskSpaceLow` 兜底）。

### D2 — 代码归属与按服务接线（绕开豁免面，零主管线改动）

- **`packages/shared/src/metrics/`**（照 `logging/` 先例；无 Nest/express 依赖，结构类型）：
  - `createHttpMetrics()`——Express 形 `(req,res,next)` 中间件，`res.on('finish')` 时按 `req.route?.path ?? 'unmatched'` 计数；**自身端口不经过它**（天然不吃自抓取流量）。
  - `startMetricsListener({ port, service })`——`node:http` 独立小服务器：`GET /metrics` 输出 prom-client registry；**Bearer 守卫**（`Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`，与 env 比对，fail-closed）——与主 HTTP 管线**完全平行**，`internal-token.middleware.ts` 一字不动。
  - `prom-client@15.1.3` 成为 `shared` 第一个外部运行时依赖（rationale：logging 当时零依赖是「不需要」，指标**必须**有 prom-client；client 不引 shared 已实测，§2.3）。
- **端口约定**：指标端口 = 服务 HTTP 端口 **+6000** → gateway 9000 · user 9001 · room 9002 · game 9003 · robot 9005 · config 9006（全为容器内监听；**生产零发布；dev 形态也不发布**——探针与本地调试一律 `docker exec`〔**六个 Nest 镜像**内有 curl（`Dockerfile.user-service:6,9`）；**douzero 无 curl/wget** ⇒ 它的 exec 探针用 `python3 -c urllib`（照其 healthcheck，compose `:121`；r2-🟡5）。`slice-07.5` 全程 exec 有先例〕，O5②）。
- **接线（每服务 `main.ts` 两行）**：`app.use(createHttpMetrics())`（**trace 之后、最前**——401/404 也计数）+ `startMetricsListener(...)`（`listen()` 前）。网关同样两行。
- **Prometheus 侧认证**：`authorization: {type: Bearer, credentials_file: <镜像内路径>}`——配置零模板、密钥零入库；token 由 prometheus 镜像 entrypoint 从 env 写入**预建的可写目录**（R3③，§D4）。
- **douzero / grafana 的 `/metrics` 无守卫**（网络内、无发布；douzero 现状对 `/health` 亦无认证）——**不对称如实登记**，理由 = 两者无既有 token 链、且只在内网。
- **e2e 保护**：任何一处接线漏掉 ⇒ 「七目标全 200」的 conformance 探针当场红（§D9）。

### D3 — 监控栈部署形态（compose 六服务）

| 服务 | 镜像（tag 规格层钉死，**不用 latest**） | 内网端口 | 卷 | 关键 env | healthcheck |
|---|---|---|---|---|---|
| `prometheus` | 自建（bake：配置 + 规则）：`${IMAGE_PREFIX:-pokergame}-prometheus:${IMAGE_TAG:-latest}`（FROM `prom/prometheus:v3.15.0`） | 9090 | `prometheus-data:/prometheus` | `INTERNAL_SERVICE_TOKEN` | wget `/-/healthy`（BusyBox 有 wget ✓） |
| `grafana` | 自建：`…-grafana:…`（FROM `grafana/grafana:13.2.3`） | **3010** | `grafana-data:/var/lib/grafana` | `GRAFANA_ADMIN_PASSWORD`（**必填**，守卫见 D4）· `GF_SERVER_ROOT_URL`/`SERVE_FROM_SUB_PATH`（compose 直插 `https://${SITE_ADDRESS}/grafana/`） | wget `/api/health` |
| `alertmanager` | 自建：`…-alertmanager:…`（FROM `prom/alertmanager:v0.34.1`） | 9093 | `alertmanager-data:/alertmanager` | SMTP 四件套 + `ALERT_EMAIL_TO`（**全齐才启用邮件；半配 ⇒ 拒绝启动**，R3②）· `INTERNAL_SERVICE_TOKEN` | wget `/-/healthy` |
| `node-exporter` | 官方 `prom/node-exporter:v1.12.1`（无 build、无前缀） | 9100 | `/proc` `/sys` `/`（ro）+ `/home/ubuntu/ftl-monitoring/textfile:/textfile:ro` | — | wget `/metrics`（BusyBox 有 wget ✓；精确端点规格定） |
| `cadvisor` | **`${IMAGE_PREFIX:-pokergame}-cadvisor:${IMAGE_TAG:-latest}`（CI 从 gcr 搬运，§D4）** | 8080 | 宿主若干 ro（照官方推荐；**不** privileged 优先，实测定策） | — | **待实测镜像内工具后定**（有 wget/curl 才配；没有 ⇒ 免 healthcheck + 登记理由，Y5①） |
| `alert-relay` | 自建：`…-alert-relay:…`（FROM `node:*-alpine`；`packages/alert-relay`） | 8090 | — | `INTERNAL_SERVICE_TOKEN` · `FEISHU_WEBHOOK_URL` / `DINGTALK_WEBHOOK_URL`+`DINGTALK_SECRET` / `WECOM_WEBHOOK_URL`（**各可选；空串 = 未设**，S2②） | wget `/health` |

- 全部：`restart: unless-stopped` · 同款 `logging` 上限 · 加入 `ftl-platform` · **生产零 `ports`** · `container_name: ftl-*` · 自建服务命名**沿 R1303 模板**。
- **开发形态**：override 里给六个服务打 `profiles: ["monitoring"]` + 宿主端口（grafana 3010 · prometheus 9090 · alertmanager 9093 · node-exporter 9100 · **cadvisor 8081**（避让 dev edge 的 8080，`conformance-stack.sh:13-14` 供）· relay 8090）+ `GRAFANA_ADMIN_PASSWORD` 的 **dev 默认值**（照 `ADMIN_PASSWORD` 的「脚本 export + 两处同源」先例）+ **监控三服务（prometheus/alertmanager/alert-relay）的 dev `INTERNAL_SERVICE_TOKEN` 默认值**（`dev-internal-token-change-in-production`，与六服务同款同源——否则 dev/CI 抓取全 401、探针 2 必红，r2-F3）+ **dev 形态 `GF_SERVER_ROOT_URL` 显式给一份**（如 `http://localhost:3010/grafana/`；生产走 `SITE_ADDRESS` 插值，而 dev 该变量为空——r2-🟡8 登记，真栈起后以 `docker logs` 钉一次行为）——机制与 `profiles: ["edge"]` 同族。**指标端口不发宿主口**（D2）。
- `deploy.sh` 不改（`up -d` 自动带上新服务；回滚到旧 tag 时旧 compose 无监控服务，孤儿提示可接受，登记）；`conformance-stack.sh` 三路径全改（§D9-R1）。

### D4 — 配置与密钥交付（配置进镜像 / 密钥只从 `.env`；**按 R3 重写为可执行机制**）

- **四个新镜像**：`Dockerfile.prometheus` / `Dockerfile.grafana` / `Dockerfile.alertmanager`（FROM 官方 + COPY `deploy/monitoring/**` 配置）与 `Dockerfile.alert-relay`（**照 `Dockerfile.user-service` 的 COPY 次序模板**——工作区依赖 + `patches/` 在 install 之前，Y4 两门对账闸）；relay 源码即 `packages/alert-relay`；规则文件 `rules/*.yml` 进镜像 + **promtool 校验**（§D9）。
- **密钥机制（逐镜像定死；BusyBox 系无 envsubst、无 gettext，R3①）**：
  - **prometheus**：Dockerfile `USER root` 阶段预建 `/etc/prometheus/secret`（**`chown 65534:65534`、目录 mode 显式 700**，官方镜像以 `nobody` 运行）→ 回 `USER 65534`；entrypoint（`/bin/sh`）`printf '%s' "$INTERNAL_SERVICE_TOKEN" > /etc/prometheus/secret/internal_token && chmod 600` 后 **`exec prometheus "$@"`**（转发官方 CMD 参数——`--config.file`/`--storage.tsdb.path` 等；r2-B2 备忘）（R3③）。
  - **alertmanager**：entrypoint **shell 条件拼装**（heredoc，不用 envsubst）生成 `alertmanager.yml` 到**数据卷内**（nobody 可写，`--config.file` 指过去，文件 600）：`webhook` receiver（指向 relay，Bearer via `credentials_file`）**恒在**；`global.smtp_*` 与 `email_configs` **仅当 SMTP 四件套全非空时拼入**（半配 ⇒ 打印明确错误并 `exit 1`——响亮）；**`heartbeat` receiver 恒以「已定义」形态存在**——SMTP 已配 = 带 `email_configs`，未配 = **空接收器**（官方认可的丢弃形态；AM 对「路由引用了未定义 receiver」是**载入失败**，所以不能只删 receiver 留路由——r2-🟡6，alertmanager#2429）；YAML 引号纪律：变量值含 `"`、`\` 或换行 ⇒ 拒绝启动（响亮），文档附「授权码是字母数字」的前提（R3②：这样 **SMTP 未配时 AM 照常健康**——CI 无 SMTP 起栈不再红，生产也没了静默 crash-loop）。
  - **grafana**：**零模板**——`GF_SERVER_ROOT_URL`/`GF_SERVER_SERVE_FROM_SUB_PATH` 由 compose 直接插值，口令走 `GF_SECURITY_ADMIN_PASSWORD` 正规通道；entrypoint 只做**守卫**：`${GRAFANA_ADMIN_PASSWORD:?}`（真 fail-closed，O4；注意官方语义 =「仅首启生效」，换口令走手册的 `grafana cli` 小节）。
  - **alert-relay**：Node 直接读 `process.env`；日志与错误信息**永不落 webhook URL**（URL 即凭据，S2③）。
- **cadvisor 镜像搬运与供给（本会话实测新增；r2-F1 补全两条支路）**：`build-images.sh` 在 bake 之后加一步——`docker pull gcr.io/cadvisor/cadvisor:v0.60.6` → `tag` 成 `${IMAGE_PREFIX}-cadvisor:${IMAGE_TAG 们}` → `push`（CI runner 可达 gcr；服务器只认 GHCR/docker.io）；compose 里 cadvisor 用前缀名引用。**`conformance-stack.sh` 两条支路都要供给**：PULL_MODE=1 走 pull+retag 名单（§D9）；**PULL_MODE=0**（本机开发链 + push-CI）在 `up` 前补 `docker pull ${GHCR_PREFIX}-cadvisor:<tag> || docker pull gcr.io/cadvisor/cadvisor:v0.60.6` → retag `pokergame-cadvisor:latest`（**否则 compose 对无 `build:` 的该镜像只能试 docker.io ⇒ 起栈必红**，r2-F1）。两条边界（规格写死）：① CI push 路径与 images.yml **并跑** ⇒ 首次 push 时 GHCR 尚无 cadvisor ⇒ 走 gcr 直拉兜底（runner 可达）；② 本机迁移当天先预置一次（跑一次 images 或手工同款命令；**本机拉 GHCR 需一次 `docker login ghcr.io`**，手册给命令）。
- 服务器 `.env` 新增变量表（含「怎么拿」说明，落手册 §D10）：`GRAFANA_ADMIN_PASSWORD`（必填）· `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/ALERT_EMAIL_TO`（**全齐才启用邮件**）· `FEISHU_WEBHOOK_URL` / `DINGTALK_WEBHOOK_URL` / `DINGTALK_SECRET` / `WECOM_WEBHOOK_URL`（各可选；**空串 = 未设**）。**零改动**进既有备份伞（`env-*.gz`，§2.6）。

### D5 — 告警链（AM → 邮箱 + relay → IM；含 Watchdog 心跳）

```
Prometheus rules ──▶ Alertmanager ──┬─▶ email_configs（原生 SMTP；不经 relay）
   (group_wait 30s · group_interval 5m · repeat_interval 4h · 文件 600)  │
                                    ├─▶ webhook ──▶ alert-relay ──┬─▶ 飞书（webhook）
                                    │   (Bearer 守卫)  (本片新服务)  ├─▶ 钉钉（webhook + HMAC 加签）
                                    │                              └─▶ 企业微信（webhook）
                                    └─▶ heartbeat 路由（仅 email · repeat 24h）：Watchdog 心跳
```

- **结构性冗余**：邮箱与 relay 是两条独立通道——relay（或任一 IM 平台）挂了，邮件照达；SMTP 未配/挂了，IM 照达。relay 的每次投递按 `{sink,result}` 计数（§D1 元监控行），发不出去的告警**会在下一次邮件里被报告**。
- **Watchdog 心跳（O2）**：`Watchdog` 规则恒定 firing（`vector(1)`），经**独立路由**（`alertname="Watchdog"`）只发 `heartbeat` 接收器（email，`repeat_interval: 24h`）——**每天一封「监控活着」的邮件**；它不来了 = Prometheus/AM 进程级死亡或主机全挂（三者是超集关系），手册写明这个判读口径。**残余登记**：未配邮箱 ⇒ 心跳不存在（回到「无人知」），§4 如实记。
- relay 形状：`POST /webhook`（AM 载荷 schema）→ 渲染中文文案（服务名/指标/当前值/持续时长/一行「可能是什么+先看哪里」）→ **并发扇出**到已配置槽位；**单槽失败不拖累他槽**；**出站 fetch 带超时（规格钉常量，如 5s，Y3-配套）**；不重试——**首投失败到 AM 重投最长 `repeat_interval`（4h）的临界告警语义，规格明说**；`GET /health`（无守卫）、`GET /metrics`（**Bearer 守卫**）。
- 路由：主 `route` → `receiver: all`（email〔已配时〕+ webhook 双通道）；`inhibit_rules` critical 抑制同 `alertname` 的 warning。告警文案模板**钉死不含任何用户数据**（飞书/钉钉/企微是第三方）。
- 静默：AM UI/API 不对外（§D8）；手册给一条 ssh + `docker exec` + `curl` 的静默操作命令模板（含 JSON 样板）。
- **备选与否决**（登记）：Grafana Unified Alerting（原生钉钉）——否决：规则离开 git、双引擎二选一，本仓纪律 = 规则进仓库 + promtool 可校验；Grafana Cloud/外部 SaaS——数据出箱 + 外部账号，否决；VictoriaMetrics——资源收益在实测余量（§2.2）下无差别，非本仓正统，否决。

### D6 — 规则集（草案；阈值 = 版本化 YAML，改阈值 = 发版）

| 规则 | 表达式骨架 | for | severity | 理由 |
|---|---|---|---|---|
| `ServiceDown` | `up{job=~".+"} == 0` | 2m | critical | 「事故第一时间可知」的第一条 |
| `Http5xxRatioHigh` | `5xx rate / 总 rate`（按 job）> **5%** / > **20%** | 10m / 5m | warning / critical | 错误率（路线图点名） |
| `HostDiskSpaceLow` | `avail/size < 20%`（`/`，剔除 tmpfs/overlay）< **10%** | 10m | warning / critical | 磁盘（路线图点名；镜像+TSDB 增长见 §4） |
| `HostMemoryAvailableLow` | `MemAvailable < 800 MiB` | 10m | warning | OOM 会在别处表现为「莫名挂了」 |
| `WsConnectionsHigh` | `> 4000` / `> 8000` | 10m / 5m | warning / critical | 连接数（路线图点名）；**8000 = M0.3 既定线**（路线图 `:29`），监控先到岗 |
| `ContainerRestartFlapping` | `changes(container_start_time_seconds{name=~"ftl-.*"}[1h]) > 2`（语义边界见 D1-cadvisor 行，Y5②） | 5m | warning | 重启潮 = crash-loop 监测 |
| `RecordsCleanupStalled` | `time() - records_cleanup_last_success_timestamp_seconds > 7200`——gauge **启动即 0 初值** ⇒「从未成功过」也会命中（O3 的核心）；`for: 10m` 给首轮（+30s）留窗 | 10m | warning | 清理停 = 表只涨不清 |
| `RecordsCleanupFailing` | `increase(records_cleanup_failures_total[6h]) > 0` | 5m | warning | 同上（失败有日志细节，指标负责打铃） |
| `AlertDeliveryFailing` | `rate(alert_deliveries_total{result="error"}[30m]) > 0` | 15m | warning | 元告警：打铃的铃坏了要有人知道（经邮件送达） |
| `Watchdog` | `vector(1)`（恒 firing） | — | none | 心跳：走独立路由（email · 24h），「预期心跳没来」= 监控系统自身死亡（O2） |

- **备份新鲜度**：**不设规则**（路线图 `:64` 裁决；`check-backup-fresh.sh` 独立闸在先）——只在面板上板（§D7 第 4 块 + `node-exporter` textfile 信号）。
- 阈值初值全部可在规格层微调（上表写的是**草案锚点**）；`for` 一律给足抖动容忍。

### D7 — 展示面（Grafana；provisioned as code）

| 面板 | 内容 |
|---|---|
| ① 总览 | 服务 up 矩阵 · RPS · 5xx 率 · p95 延迟 · WS 连接数 · 主机 CPU/内存/磁盘 |
| ② 业务与队列 | 匹配队列深度（按模式/档位）· 活跃房间 · 开局/结算速率 · 机器人决策速率与失败 · douzero 决策延迟 |
| ③ 主机与容器 | CPU/负载/内存/磁盘 IO/网络 · 每容器内存/CPU/重启（cadvisor） |
| ④ 记录与备份 | records 表字节/删除速率/清理任务新鲜度 · **备份新鲜度**（last success 时间线 + 「多久前」单值） |

数据源 = Prometheus（provisioned，uid 固定）；面板 JSON 进仓库 → bake 进镜像（改面板 = 发版，与「配置进镜像」纪律一致）。

### D8 — 访问面（对外只多一条路由）

- `deploy/Caddyfile` 新增（放在 catch-all 之前）：

```
	handle /grafana {
		redir * /grafana/ 301
	}
	handle /grafana/* {
		reverse_proxy grafana:3010
	}
```

  —— 照 `/admin` 两条 handle 的**实测经验**写法（`redir` 必须显式给 matcher；handle 组按 matcher 重排，不依赖源码次序；`deploy/Caddyfile:37-45` 即注释源；**新块上线后真栈实测匹配行为**，判据见 §D9）。这是全片**唯一**新增公网面；Grafana 强制登录（`GF_USERS_ALLOW_SIGN_UP=false`——**正确键名**，S3：v1.0 写的 `GF_USERS_ALLOW_OWN_SIGN_UP` 不存在；默认即 false，本片**显式钉住**）、匿名关闭、防爆破用其内置节流（默认开：5 次失败/5 分钟）。
- Prometheus / Alertmanager UI **不发布**（生产零宿主端口）——需要静默或看 Prometheus 时用手册给的 `ssh + docker exec curl` 命令模板。**已知成本**：比点开网页麻烦；若日后要更顺手的 AM UI，可单开一个小改动把「loopback 宿主发布」加进判据白名单（**那是判据放宽，本片不做**，如实登记）。

### D9 — 判据与闸（初稿；规格层细化到行）

**新增 `slice-16-monitoring`（conformance，对真栈）**——探针草案：

| # | 探针 | 判别力要点 |
|---|---|---|
| 1 | 七目标 `/metrics`（**访问路径 = `docker exec`**：六个 Nest 容器内用 curl；**douzero 容器内用 `python3 -c urllib`**——它无 curl，compose `:121` 先例，r2-🟡5；O5②）：**无**凭据 ⇒ 401；带 Bearer ⇒ 200 且含 `http_requests_total`（douzero 免凭据、但必须 200 含 `douzero_decides_total`） | 接线全齐 + 守卫生效（正/负两向） |
| 2 | Prometheus `/api/v1/targets`：**钉死目标清单与数量**（13 = 6 Nest + douzero + node-exporter + cadvisor + prometheus + alertmanager + grafana + relay）；cadvisor 期望值**参数化**——降级形态（§4）下「缺席」是**合法且被条件化断言**的，不是 skip（Y2）；relay/grafana 冷启动给重试窗；`rules` 数量 = 文件内规则数；**`promtool check config/rules`（同 tag 镜像内跑，不进 render-gate）** | 抓取面/规则面机械验证 |
| 3 | 边缘面：`GET /grafana` ⇒ 301 到 `/grafana/`；`GET /grafana/` ⇒ 200 登录页；**负对照**：`GET /metrics` 经边缘 ⇒ 404 | 唯一新公网面正确、指标面不出网 |
| 4 | relay：合成 AM 载荷 POST（dev 形态 + conformance 自带 stub sink）⇒ 各**已配**槽位收到格式正确的请求（钉钉签名对照向量）；未配置槽位 ⇒ 不发（**空串=未配** 负对照）；stub 返回 500 ⇒ 只该槽 `result=error` 计数上升；`/metrics` 无 Bearer ⇒ 401 | 通道格式 + 失败隔离 + 守卫 |
| 5 | Grafana provisioning：`/api/search`（登录后）含四面板；datasource 指向 prometheus；**未设口令 ⇒ 容器不启动**（O4 判据） | 面板 as code + 真 fail-closed |
| 6 | 备份 textfile **两向**（O1；r2-F2 订正——`SSH_CMD`/`BACKUP_DEST` 是 `check-backup-fresh.sh` 的注入点、**不是** `backup.sh` 的，且前者不调用后者）：① 照 `slice-07.5` 先例以 **CLI flags**（`backupArgs`，`slice-07.5-backup.ts:306-310`：`--dest` 指向临时目录、`--mysql-container`/`--db-name` 给 scratch 替身）跑一次**真 `backup.sh`** ⇒ textfile 写出且 `backup_last_success_timestamp_seconds` 前进；② 让替身 mysqldump 报错再跑一次 ⇒ `result` 指标变化；③ 宿主写样例 `.prom` ⇒ Prometheus 查到（上板链路通） | 「backup.sh 真的会写」+ 失败路径也写 + 上板链路通 |

**单测面**：`shared/src/metrics/`（route 归一化含 unmatched/负例、Bearer 守卫 fail-closed、registry 输出可解析）· `packages/alert-relay`（三 sink 载荷 golden、钉钉签名对照向量、禁用槽不发、失败隔离、URL 不入日志）· 规则文件语法（promtool，见探针 2）。

**既有面更新（判据只增不减）**：

| 面 | 动作 |
|---|---|
| `slice-07.2-deploy` | `BUILD_SERVICES` 8→12（`:555`）+「恰好」断言（`:560-564`）+ 两渲染镜像名（`:565-583`，新自建服务**沿 R1303 命名**）+ 服务清单断言**逐表口径**（r2-F4）：「各 +6」**不成立**——`TOKEN_SERVICES:124` **+3**（prometheus/alertmanager/alert-relay；其余三服务无 token 行）· `DIRECT_PORT_SERVICES:132` 与 `HEALTH_TARGETS:364` **语义不符、不动**（前者=dev 宿主端口 >0 + dev token 断言，监控服务不发布端口/走 exec；后者=GET `/api/health` 验收面，监控目标是**另设清单**）· `LOG_LIMIT_TARGETS:955-959` **+6** |
| `slice-07.4-pipeline` | 「恰好 8」（`:956-960`+注释 `:66`）→ 12；**这是 render-gate 每次 push 的必红点**（`ci.yml:56-63`） |
| `slice-07.2-hardening` | 出站超时包清单（`:963`）+= `alert-relay` |
| `slice-07.3-edge` | +`/grafana` 两 handle 断言（先例引 `slice-14-config-center` 的 C20） |
| `conformance-stack.sh` **三路径全改**（R1；r2-F1/F3 补全） | up：`--profile monitoring`；**down：先 `docker compose --profile monitoring rm -sf <六服务>` 再 down**（照门口 `:71` 先例，残留检查保留）；pull-retag：`SERVICES` += `prometheus grafana alertmanager alert-relay cadvisor`（**四个自建 + cadvisor 搬运镜像**；不扩的后果 = 复用路径对缺失本地名静默本地构建，正是该文件 `:24-29`/`:59-61` 警告的 R1314⑤，r2-🟡3 订正引用）；**PULL_MODE=0 支路补 cadvisor 前置供给**（F1：GHCR 拉 → retag；不可达走 gcr 直拉兜底；本机需一次 ghcr 登录）；dev 默认面（照 `ADMIN_PASSWORD` 三处同源先例）+= `GRAFANA_ADMIN_PASSWORD` **与监控三服务的 `INTERNAL_SERVICE_TOKEN`**（六服务同款 dev 值，F3） |
| `images.yml` / `build-images.sh` / `release.yml` / `conformance.yml` | 「8 个」文案**实测 6 处**（`release.yml:43/:82` · `images.yml:1/:31` · `build-images.sh:2/:32`）+ `conformance.yml:4`「自己构建 7 镜像」同类过期（r2-🟡4；规格层再全量扫一遍）；release.yml `:43` 步骤名与 `:78-90` 预算算术（首发布拉取 ≈8GB 重估，R1314 成本控制）；`build-images.sh` 加 **cadvisor 搬运步骤**（§D4） |
| `baselines.json` | render 列 + full 列回填（静态读数本机先填，纪律 #4） |
| `docs/ops/first-deploy.md` | §D10 四小节 + 换口令小节 + 心跳判读口径 + `.env` 新增变量表；「下次发布注意」登记 `GRAFANA_ADMIN_PASSWORD` 前置 |
| 路线图 | 收口时订正 `:62`（七个→6+douzero）与 `:66`（2–3→6）两处措辞（E1） |

### D10 — 手册与运维动作（用户要做的三件）

| # | 动作 | 时点 |
|---|---|---|
| 1 | 服务器 `.env` 加 `GRAFANA_ADMIN_PASSWORD`（强口令）；要开哪些通道就加哪些变量 | **发布前**（grafana entrypoint 守卫 fail-closed：没口令它起不来——响亮不静默） |
| 2 | 按手册分步拿通道凭据：邮箱开 SMTP 拿授权码 / 飞书建群机器人拿 webhook / 钉钉拿 webhook+加签 secret / 企微拿 webhook | 随时（谁配谁生效；**SMTP 要全齐**） |
| 3 | **验收演练（需用户在场）**：制造一条真告警（如停一个容器 2 分钟）⇒ 邮箱 + 已配 IM 收到；确认 Watchdog 心跳邮件的到点 | 切片验收阶段 |

手册新增五小节（讲「你会看到什么」）：监控在哪看（`https://<域名>/grafana/`）· 怎么加/换告警通道 · 怎么临时静默 · **怎么换 Grafana 口令**（官方语义 = 仅首启生效；`docker exec … grafana cli admin reset-admin-password`）· **心跳口径**（「每天一封『监控活着』的邮件；它不来了说明什么」）+ 常见故障自查（Grafana 打不开 ⇒ 查 SITE_ADDRESS/口令/容器状态三条）。

---

## 4. 兼容面与风险

| 面 | 结论 |
|---|---|
| **玩家可见面** | **零变化**（无任何既有 HTTP/WS 契约改动；新增都是旁路监听与容器） |
| 对外新面 | 恰一条：`/grafana/`（登录保护）——安全审查面变化如实登记，附：**镜像漏洞扫描不在本片**（存量 8 镜像同样无；CI 安全三路只扫依赖/密钥/配置），公网组件升级节奏 = 改 compose tag + 走常规发版（S4） |
| 磁盘 | +6 镜像（4 自建 + cadvisor 搬运 + node-exporter，约 0.9–1.1 GiB/版）+ TSDB（30 天软上限 5 GiB，估计 ≤2 GiB）+ grafana/AM 数据卷；现余 84 GiB；`HostDiskSpaceLow` 覆盖其增长（r2-🟡2 订正计数） |
| 内存 | 实测余 5.9 GiB；监控栈预估 ≤1 GiB（cadvisor 为大头）——**上线后按容器实测回填** |
| 镜像源 | cadvisor 经 CI 搬 GHCR（§D4）；其余 docker.io 直达（§2.2 实测）；**gcr.io 依赖为零** |
| 部署 | `deploy.sh`/`release.yml` 零改动（仅文案/算术）；`.env` 一个必填项 ⇒ 手册「发布前注意」登记（先例：edge `/data` 属主迁移那条）；回滚到旧 tag ⇒ 旧 compose 无监控服务、留孤儿提示（无害，登记） |
| 假红面 | 抓取 401 若 token 两处异源 ⇒ 全目标红（响亮）；token 同源 = 同一 `.env` 变量逐字同传（先例：`JWT_SECRET` 三处 `:160/:251/:471` 同值纪律，判据 `slice-07.2-deploy.ts:781-787`） |
| cadvisor | cgroup v2 兼容与所需挂载/权限**实施时实测**（清单在规格）；不行则降级为 node-exporter-only 并登记（不阻塞其余；探针 2 已按条件化期望写，Y2） |
| 告警风暴 | `group_wait/interval` + inhibit（critical 抑 warning）；阈值含 `for` 抖动容忍 |
| 单点边界（如实） | ① 主机全挂 ⇒ 本机所有告警源同挂 = 无外发告警；② **Prometheus/AM 进程级死亡 ⇒ 全链静默（① 的超集）**——两者都由 **Watchdog 心跳**（邮件通道已配时）兜底；未配邮箱 ⇒ 回到「无人知」，登记为已知残余；外部 dead-man switch **明确不做**（§6） |
| 隐私 | IM 通道经第三方：文案模板只含服务名/指标/数值，**无用户数据**；webhook URL 等凭据不入日志（S2③）；`.env` 新密钥自动进备份伞（§2.6） |
| 数据可弃性 | TSDB/grafana 数据**不入备份**（可重建）；配置全在仓库/镜像内 ⇒ 灾难恢复不依赖它们 |

## 5. 判据计划（初稿 → 规格层落行号）

- 新增：`slice-16-monitoring`（D9 六组探针 + 单测面）；`packages/shared/src/metrics/*.test.ts`；`packages/alert-relay/src/*.test.ts`；CI 内 `promtool` 校验。
- 更新：§D9「既有面更新」逐条（全部为「按实测扩面」，无删减）。
- 回填纪律：本片绝大多数判据是**静态读数**（配置/渲染/promtool）⇒ 本机确定性读数先填 + CI 首跑即验（纪律 #4）；真栈动态读数（目标 up、relay e2e）按 CI 实测回填。

## 6. 明确不做（防歧义）

日志聚合/检索（Loki/ES/Kibana）· APM/分布式追踪（OpenTelemetry）· 短信/电话/值班升级/PagerDuty 类 · 外部 dead-man switch（Watchdog 心跳即本片的无外部依赖替代）· M0.3 自动暂停登录（本片只给读数）· 备份新鲜度告警（独立闸在先）· **容器镜像漏洞扫描**（存量同缺，另片）· 看板多用户/RBAC（单管理员账号）· 阈值进配置中心（v1 = 版本化 YAML）· 多实例指标语义（**按单实例标注**；多实例是 P5 的题）· K8s/HA · 审计与长期留存 · 移动端 App 推送（Bark/ntfy——用户未选）。

## 7. 风险

1. **cadvisor**（唯一「类目级」不确定）：cgroup v2/权限组合需实测；有降级路径（§4）；镜像搬运链路（gcr→GHCR）在 CI 首跑验证。
2. **Grafana 子路径**（root_url/serve_from_sub_path 配套）与 **Caddy handle 重排**：两者都有本仓实测经验的近亲（`/admin`），但仍需真栈实测钉住（D9 探针 3）。
3. **通道凭据到位时点**：三个 IM 槽位在用户配置前为空转（不报错、只不投递）；心跳依赖邮箱通道——手册与验收演练覆盖「配一个、演一个」。
4. **AM entrypoint 的 shell 拼装**（R3 修法）是本片唯一「自写模板引擎」：YAML 引号纪律 + 半配拒绝启动 + `amtool check-config` 预检（规格定）三重防线。

## 8. 下一步

1. ✅ **设计已定稿**（v1.2 `6c56239`；r2 收口复核通过 · 放行）；
2. 规格层 `…-monitoring-spec.md`（版本钉死、端口/env/文件级清单、判据落行号）→ 审规格；
3. 计划 → 审计划 → 实现（子 agent 逐任务）→ 终审 → 收口；
4. 用户动作时点见 §D10（发布前 `.env`；通道凭据随时；验收演练需在场）。

---

## 附录 A — 审查处置表（v1.0 → v1.1）

> 报告：`.superpowers/sdd/2026-10-03-monitoring/review-design-r1-facts.md`（r1a）· `…-r1-completeness.md`（r1b）。全部处置已落入本版对应章节。

| 来源 | 条目 | 处置（落点） |
|---|---|---|
| r1a | 🟠×7：端口表出处 · 健康检查形态 · 中间件「逐字同形」 · 备份链归属 · C20 切片归属 · transfer 路径名 · SCAN 周期/ZCARD | §2.1/§2.3/§2.6/§2.7/D1 逐条订正（含行号） |
| r1a | 🟠×1 + E1：容器数 2–3→6 / 「七个 Nest」 | §1.1 措辞订正 + §2.2 登记差值 |
| r1a | 🟡×5：五处引用行号/节号 | 全数改（`:1-11,514-517` · `:51,528,552-559` · `build-images.sh:2,30-33,49`/`images.yml:7-9,36` · 手册 §2.2 · `check-backup-fresh.sh:2-4`） |
| r1a | 附注：R1303 命名沿模板 + 各服务清单断言 | §2.7/D9 更新表 |
| r1b | 🔴R1：conformance-stack.sh 收栈 R1209 | §D9「三路径全改」行 |
| r1b | 🔴R2：slice-07.4-pipeline 恰好 8 | §2.7/§D9 行（render-gate 每次 push） |
| r1b | 🔴R3：密钥机制三连（envsubst/AM 可选块/credentials_file 属主） | §D4 整节重写（shell 条件拼装 + 预建可写目录 + 半配拒绝启动） |
| r1b | 🟠O1：backup textfile 落点/权限/探针 | §D1 基础设施行 + §D9 探针 6（两向 + 注入点先例） |
| r1b | 🟠O2：进程级死亡单点 | §D5 Watchdog + §D6 规则行 + §4 残余表 + §D10 手册口径 |
| r1b | 🟠O3：RecordsCleanupStalled 缺席 | §D1（0 初值）+ §D6（表达式/for）+ 写点落行 |
| r1b | 🟠O4：Grafana fail-closed 无机制 | §D4 守卫 + §D10 换口令小节 + §D9 探针 5 |
| r1b | 🟠O5：CI/dev 供给面 | §D3（dev 口令默认）+ §D2（exec 探针路径）+ §D9 三路径 |
| r1b | 🟡Y1–Y6 · S2–S4 · E1 | §D9 更新表（Y1/Y2/Y3/Y4）· §D1 cadvisor 行（Y5）· §D1 保留行（Y6）· §D5/S2+§D4（S2）· §D8（S3）· §4 安全行（S4）· §1.1（E1） |
| 本会话实测 | cadvisor 镜像 gcr 不可达 | §1.2/§2.2/§D3/§D4 搬运步骤 + §4 镜像源行 + §D9 清单 |
| r1a 存档更正 | 6 号条目误证据（「`deploy/Dockerfile.edge` 存在」不成立；`deploy/` 下只有 Caddyfile） | 已在报告文末登记更正；设计侧于 v1.2 🟡1 订正 |

---

## 附录 B — r2 处置表（v1.1 → v1.2）

> 报告：`.superpowers/sdd/2026-10-03-monitoring/review-design-r2-verify.md`（处置落地 32/32 核过；新发现 🔴1/🟠3/🟡8）。全部处置已落入本版对应章节。

| 来源 | 条目 | 处置（落点） |
|---|---|---|
| r2 🔴F1 | cadvisor 供给链缺 PULL_MODE=0 支路 | §D4 搬运节扩为「两路供给」（含两条边界）+ §D9 conformance-stack 行 |
| r2 🟠F2 | 探针 6 注入点张冠李戴 | §D9 探针 6 重写为 CLI flags 先例（`slice-07.5-backup.ts:306-310`） |
| r2 🟠F3 | dev/CI 缺监控侧 `INTERNAL_SERVICE_TOKEN` | §D3 开发形态行 + §D9 conformance-stack 行 |
| r2 🟠F4 | 「各 +6」逐表口径 | §D9 slice-07.2-deploy 行拆写（+3 / 不动 / 不动 / +6） |
| r2 🟡1 | `deploy/Dockerfile.edge` 路径错 | §1.2 订正（仓库根）+ 附录 A 加 r1a 存档更正行 |
| r2 🟡2 | §4「+7 镜像」 | §4 磁盘行改 +6 |
| r2 🟡3 | `:54-58` 引用偏移 | §D9 conformance-stack 行改 `:24-29`/`:59-61` |
| r2 🟡4 | 「三处『8 个』」计数 | §D9 文案行改「6 处 + conformance.yml:4『7 镜像』」 |
| r2 🟡5 | douzero 无 curl | §D2 端口约定行 + §D9 探针 1（`python3 -c urllib`） |
| r2 🟡6 | SMTP 未配时 heartbeat 形态 | §D4 alertmanager 节（已定义空接收器 + AM#2429 依据） |
| r2 🟡7 | textfile 原子写/权限细节 | §D1 node-exporter 行（755/644 + tmp+mv + 写失败仅 warn） |
| r2 🟡8 | dev `GF_SERVER_ROOT_URL`（SITE_ADDRESS 空） | §D3 开发形态行（显式 dev 值 + 真栈 `docker logs` 钉一次） |
| r2 B 备忘 | `chown 65534:65534`/目录 mode/CMD 转发 | §D4 prometheus 节（`exec prometheus "$@"` + mode 700） |
| r2 复核（收口） | v1.2 `6c56239` 只读复核（r2 审查者） | **通过 · 放行**：F1–F4 与 🟡1–8 + B2 备忘全数落入正文、引用逐字属实（F1 含两边界与 `GHCR_PREFIX` 名核对；F2 CLI flags 与注入点归位；F3 与 override 同源值；F4 逐表 +3/不动/不动/+6）；附录 A 的 r1a 存档更正行属实。新引入仅标题行版本号一行 nit（随定稿提交订正）。**「设计层定稿」成立。** |
