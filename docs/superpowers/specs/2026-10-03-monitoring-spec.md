# 监控片：事故第一时间可知（**规格层 v1.1**）

> **状态**：v1.1 —— **定稿本**。已过规格审查 r1（**1🔴 / 6🟠 / 13🟡 + 4 nit 全数落地**，见 §0）与收口复核（**「两文可定稿」**，新发现 N6+6🟡+nit 亦全数落地）。审查报告：`.superpowers/sdd/2026-10-03-monitoring/`（工作区工件不入库）。
> **分层**：本文 = 形式化层；上层依据 = `docs/superpowers/specs/2026-10-03-monitoring-design.md`（**设计层 v1.2 · 定稿**，两轮审查通过）。
> **来源**：设计全文 + 路线图「监控片」节 + 本会话用户裁决（设计 §1.1）+ 实测探查（设计 §2）。
> **口径**：判据只增不减（§4 为「按实测扩面」清单）；每次改动一个 commit；**实施期核对点**（本文标注 ⚙️ 的条目）= 规格不能预先钉死、**由实现者验证并回填本节**的条目——每条的验证动作写在该条目处，验证结果回填对应节；它们**不是**「待办留白」。

---

## 0. 修订对账

### v1.1 相对 v1.0（规格审查 r1 处置：1🔴 / 6🟠 / 13🟡 + 4 nit，全数落地）

| 级 | 条目 | 处置（落点） |
|---|---|---|
| 🔴 R1 | Grafana 面板被命名卷遮蔽 | §2.7 + §1.1：dashboards 落 **`/etc/grafana/dashboards`（卷外）** |
| 🟠 O1 | relay 基底与设计冲突 / slim 无 wget | §0 版本表 `node:20-alpine` + §2.6 COPY 次序约束 |
| 🟠 O2 | AM `authorization` 嵌套 | §2.5 改为 `http_config.authorization` |
| 🟠 O3 | entrypoint flag 重复 | §2.4ter（只补增量 flag + `"$@"`）/§2.5（**不**转发）+ §0 订正登记 |
| 🟠 O4 | queue 周期/落点背离设计 | §1.2/§2.2：挂 `match.service.ts` 既有扫描环（config 驱动，种子 5s）+ ZCARD 新增 |
| 🟠 O5 | C5 stub 可达性 | §3 C5：**切片自带容器化 stub（方案 a）** |
| 🟠 O6 | C7 样例写不进去 | §3 C7③：**经容器写**（`docker run -v … node:20-alpine sh -c`） |
| 🟡 Y1–Y13 | C4 跟随重定向 · C14 静态三断言 · 降级配方 checklist · robot 标签对齐+errors 计数 · rooms_active HELP 全栈口径 · backup 值域 `{ok,failure}`+trap 位 · 正则 `/?(ftl-.*)`+自证 · C10 基线化+拒握手负对照 · grafana `/metrics` ⚙️ · 计数清扫归因与清单（first-deploy/compose 头注） · 「13 条规则」 · douzero 四路集合 + 钉钉毫秒/固定向量 · node-exporter flag 收缩 | 各对应节 + §4 |
| nit | prom-client 注脚 · 行号漂移（`:591`/`:956-961`）· ⚙️ 责任人表述 · §2.1 骨架排版声明 | 各对应节 |

### v1.0 首版（无前版）设计层两轮审查（r1 双审/r2 验证）的处置已全部收进设计附录 A/B；本层只做形式化，不再重开设计取向。

**版本钉死表**（设计 §2.2 实测 + 本会话调研，2026-10-03）：

| 组件 | 版本 | 备注 |
|---|---|---|
| `prom/prometheus` | **v3.15.0** | 服务器 `docker manifest inspect` 实测 REACHABLE |
| `grafana/grafana` | **v13.2.3** | 同上 |
| `prom/alertmanager` | **v0.34.1** | 同上（≥0.22 才支持 `http_config.authorization.credentials_file`） |
| `prom/node-exporter` | **v1.12.1** | 同上 |
| cadvisor | **v0.60.6**（`ghcr.io/google/cadvisor:v0.60.6`——**官方现址**） | 2026-10-03 双端（服务器/开发机）实测该 tag **均可直拉**；gcr.io 路径版本 tag 已不存在 ⇒ **旧「CI 搬运到 GHCR」机制作废**（订正④） |
| `prom-client`（npm） | **15.1.3** | engines `^16 \|\| ^18 \|\| >=20`；**精确钉版**——受控升级（仓库外部依赖多用 `^`，此处刻意钉死以便安全扫描口径统一） |
| `prometheus-client`（PyPI，douzero） | **0.26.0** | uv.lock 同步更新 |
| Node 基础镜像 | **node:20-slim**（六个 Nest 服务同款；pnpm **9.15.0**）· **node:20-alpine**（alert-relay——BusyBox wget 供 healthcheck；规格审查 O1） | |

**对设计文本的三处订正登记（规格审查 O3/Y7/R1 后补；设计层不改，以本表为准）**：① **entrypoint flag 转发形态**（§2.4ter/§2.5）——设计 r2-B2 备忘的 `exec … "$@"` 与官方 CMD 叠加会重复 flag（prometheus 同值重复=kingpin 报错；AM 异值重复有 last-wins 静默吞生成配置之险）⇒ 规格改为「官方 CMD 提供 config/path，脚本只补增量 flag」（prometheus）/「脚本全给、不转发」（AM）；② **cadvisor 容器名正则加 `/` 容忍**（§2.4bis）——设计写 `name=~"ftl-.*"`，若驱动给前导 `/` 会静默失配 ⇒ 规格订正为 `/?(ftl-.*)` + **匹配自证断言**；③ **Grafana 面板落点移出数据卷**（§2.7）——设计「面板进镜像 ⇒ 改面板 = 发版」的意图会被 `grafana-data` 命名卷遮蔽（首启后卷内容冻结）⇒ 规格改为 `/etc/grafana/dashboards`（卷外）；④ **cadvisor 镜像源订正（2026-10-03 实施期实测）**——官方现址 = `ghcr.io/google/cadvisor:v0.60.6`（Google 的 GHCR 命名空间；服务器与开发机双端可直拉），gcr.io 的版本 tag 已不存在 ⇒ **搬运机制整体退役**：compose 字面名直引（§2.1）、`build-images.sh` 搬运步删除（§2.10）、`conformance-stack.sh` 的 PULL_MODE=0 供给段与 SERVICES 里的 cadvisor 项删除（§2.11）；设计 §D4 的搬运条目以本表为准。

> ⚙️ **回填注记（货币片 T11，2026-10-04）**：本文件全部「六个 Nest / 13 个 job（目标）」类计数为写作时（2026-10-03）事实；货币片新增 `currency-service`（独立指标端口 **9004**、第 13 个自建镜像、`conformance-stack.sh` 的 `SERVICES` 第 13 项）后 ⇒ 现状 **七个 Nest / 14 个 job**（`deploy/monitoring/prometheus/prometheus.yml` 的头注与 job 列表、`slice-16-monitoring` 的 `EXPECTED_JOBS=14`/`NEST_TARGETS` 已随货币片同改）。历史文本**不逐个改写**（不重写历史），以本注记为准。

---

## 1. 改动面一览

### 1.1 新增文件（分组清单；精确路径以计划为准，组内不遗漏）

| 组 | 文件 |
|---|---|
| 镜像配方（仓库根） | `Dockerfile.prometheus` · `Dockerfile.grafana` · `Dockerfile.alertmanager` · `Dockerfile.alert-relay` |
| Prometheus 配置 | `deploy/monitoring/prometheus/{prometheus.yml,rules/ftl-alerts.yml,entrypoint.sh}` |
| Alertmanager 配置 | `deploy/monitoring/alertmanager/{alertmanager.yml.tmpl,entrypoint.sh}` |
| Grafana 配置 | `deploy/monitoring/grafana/{entrypoint.sh,provisioning/datasources/prometheus.yml,provisioning/dashboards/ftl.yml,dashboards/01-overview.json,dashboards/02-business.json,dashboards/03-hosts.json,dashboards/04-records-backup.json}`（Dockerfile 把 `dashboards/*.json` COPY 到 **`/etc/grafana/dashboards`（卷外）**——R1） |
| shared 指标模块 | `packages/shared/src/metrics/{registry.ts,http-metrics.ts,metrics-listener.ts,index.ts}` + `*.test.ts` |
| relay 服务 | `packages/alert-relay/{package.json,tsconfig.json,src/{config.ts,format.ts,sinks.ts,metrics.ts,server.ts}}` + `test/*.test.ts` |
| 业务采样/计数落点（新文件部分） | `packages/room-service/src/metrics/room-metrics.service.ts`（+测试）· `packages/game-service/src/metrics/game-metrics.service.ts`（+测试） |
| conformance | `tools/conformance/src/slices/slice-16-monitoring.ts` |

### 1.2 修改文件（按包）

| 包/文件 | 行级动作 |
|---|---|
| `docker-compose.yml` | +6 服务块（§2.1）+3 命名卷（`prometheus-data`/`grafana-data`/`alertmanager-data`） |
| `docker-compose.override.yml` | +6 服务：`profiles: ["monitoring"]` + 宿主端口（3010/9090/9093/9100/8081:8080/8090）+ dev env（`GRAFANA_ADMIN_PASSWORD` 默认、监控三服务 `INTERNAL_SERVICE_TOKEN` 默认、`GF_SERVER_ROOT_URL` 显式 dev 值） |
| `packages/shared/src/metrics/`（新目录 4 文件 + `index.ts` 导出两行） | §2.3；`shared/package.json` +依赖 `prom-client@15.1.3` |
| 六个 `packages/*/src/main.ts` | 各 +2 行（`app.use(createHttpMetricsMiddleware())` 插在 trace 之后；`startMetricsListener({port})` 在 `listen()` 前）；端口：gateway 9000 / user 9001 / room 9002 / game 9003 / robot 9005 / config 9006 |
| `packages/room-service/src/gateway/ws.gateway.ts` | `ws_connections` gauge 升降（`handleConnection` :248 / `handleDisconnect` :396；**两处特殊路必须恰一次**：硬换手 :295-312、陈旧断线早返 :416-422）+ 在 `ws.module.ts` 注册 `RoomMetricsService` |
| `packages/room-service/src/metrics/room-metrics.service.ts`（新）+ `match/match.service.ts`（改） | `match_queue_length{mode,base_score}` **挂进 `match.service.ts` 既有扫描环**（周期 = config `room.matchScanIntervalMs`，种子 5000ms——设计 r1a-36 口径；**ZCARD 为新增**读深）；`room-metrics.service.ts` 只采 `rooms_active`（15s，`SCAN room:*` 排派生键，照 `rooms.service.ts:164-169` 判别）+ `games_started_total`/`games_ended_total` 落点（`rooms.start.ts` 开局成功点 / `game.ended` 订阅处理点） |
| `packages/game-service/src/metrics/game-metrics.service.ts`（新）+ `game.service.ts`（+1 个 getter） | 15s 采样 `games_active` = `cache.size`（`game.service.ts:77`；**per-instance 语义**写进 HELP） |
| `packages/robot-service/src/robot/robot.service.ts` | `robot_decisions_total{result,skill}` 计数：`result∈{douzero,rule}`、`skill∈SKILL_LEVELS`（`robot/config.ts:6`，恰 3 值）+ `robot_decision_errors_total{reason}`（失败路径）；**⚙️ 已回填（T5 交付 + 审查核实）**：decisions 收口 = `robot.service.ts:64` 恰一次；errors 落在 `bot.player.ts:97/:104` 两条回落路径（收口点区分不了叫抢恒-rule 与真失败，且 timeout/unreachable 分档需原始错误对象——偏离文件清单属 ⚙️ 授权，有据登记） |
| `packages/user-service/src/records/records-cleanup.service.ts` | 四指标写点：`onModuleInit` 置 `records_cleanup_last_success_timestamp_seconds 0`；成功分支（`:127-135` 附近）set 时间戳 + `records_rows_deleted_total` inc + `records_table_bytes`（`information_schema` 两表 DATA+INDEX 求和）；失败 catch（`:97-99`）inc `records_cleanup_failures_total` |
| `douzero/server.py` | `prometheus_client`：`/metrics` 路由（`do_GET`）+ `douzero_decides_total{result}`（`result∈{ok,unknown_model,not_loaded,error}`，对应 :261/:264/:276/:280 四路）+ `douzero_decide_seconds` 直方图（只包 `_act`）+ `douzero_models_loaded` gauge（启动装载后 set = `len(loaded_agents)`） |
| `douzero/{pyproject.toml,uv.lock}` | +`prometheus-client==0.26.0` |
| `scripts/deploy/build-images.sh` | **无改动**（cadvisor 搬运步随订正④退役——官方现址 ghcr.io 直拉） |
| `scripts/deploy/conformance-stack.sh` | 三段改（§2.11）：up `--profile monitoring` · down 点名 rm · `SERVICES` 扩四名（**不含 cadvisor**——订正④） |
| `deploy/Caddyfile` | +两条 handle（§2.8） |
| `scripts/ops/backup.sh` | +`write_textfile()` + `trap … EXIT`（§2.9） |
| `scripts/ops/install-cron.sh` | +`mkdir -p /home/ubuntu/ftl-monitoring/textfile && chmod 755`（**先于** compose up——bind 源目录须存在且 ubuntu 可写） |
| `.github/workflows/*` + `scripts/deploy/build-images.sh` | 「8 个」文案**6 处实测分布**（Y10 归因订正）：`release.yml:43/:82` · `images.yml:1/:31` · **`build-images.sh:2/:32`**；+ `conformance.yml:4`「7 镜像」+ release.yml `:43` 步骤名/`:78-90` 预算算术 |
| `tools/conformance/src/run.ts` | import + `CASES['slice-16-monitoring']`（标题：`监控片（指标面/守卫/告警链/边缘路由/供给链）`） |
| `tools/conformance/src/slices/{slice-07.2-deploy,slice-07.2-hardening,slice-07.3-edge,slice-07.4-pipeline}.ts` | §4 清单 |
| `tools/conformance/baselines.json` | §5 |
| `docs/ops/first-deploy.md` | 五小节（设计 §D10）+ `.env` 新增变量表 + 「发布前注意」登记 |
| `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` | 收口批：`:62`（七个→6 Nest+douzero）· `:66`（2–3→6）措辞订正 |

---

## 2. 新契约（写死）

### 2.1 compose 六服务块（骨架逐字；注释密度照既有块，实施时补）

```yaml
  prometheus:
    build: { context: ., dockerfile: Dockerfile.prometheus }
    image: ${IMAGE_PREFIX:-pokergame}-prometheus:${IMAGE_TAG:-latest}
    container_name: ftl-prometheus
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["9090"]
    environment:
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}
    volumes:
      - prometheus-data:/prometheus
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks: [ftl-platform]

  grafana:
    build: { context: ., dockerfile: Dockerfile.grafana }
    image: ${IMAGE_PREFIX:-pokergame}-grafana:${IMAGE_TAG:-latest}
    container_name: ftl-grafana
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["3010"]
    environment:
      - GF_SERVER_HTTP_PORT=3010
      - GF_SERVER_ROOT_URL=https://${SITE_ADDRESS:-}/grafana/
      - GF_SERVER_SERVE_FROM_SUB_PATH=true
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_METRICS_ENABLED=true
    volumes:
      - grafana-data:/var/lib/grafana
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3010/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    networks: [ftl-platform]

  alertmanager:
    build: { context: ., dockerfile: Dockerfile.alertmanager }
    image: ${IMAGE_PREFIX:-pokergame}-alertmanager:${IMAGE_TAG:-latest}
    container_name: ftl-alertmanager
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["9093"]
    environment:
      - SMTP_HOST=${SMTP_HOST:-}
      - SMTP_PORT=${SMTP_PORT:-}
      - SMTP_USER=${SMTP_USER:-}
      - SMTP_PASS=${SMTP_PASS:-}
      - ALERT_EMAIL_TO=${ALERT_EMAIL_TO:-}
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}
    volumes:
      - alertmanager-data:/alertmanager
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9093/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks: [ftl-platform]

  node-exporter:
    image: prom/node-exporter:v1.12.1
    container_name: ftl-node-exporter
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["9100"]
    command:
      # Y13：只留 rootfs（`/:/rootfs:ro` 已覆盖）；⚙️⑥ **已回填（T12 真栈实测，2026-10-03）**：
      # `node_filesystem_avail_bytes`/`node_filesystem_size_bytes`（各 57 条序列）与
      # `node_memory_MemAvailable_bytes`（1 条）均在 ⇒ 收缩**安全**，维持两 flag、不加回 procfs/sysfs。
      - --path.rootfs=/rootfs
      - --collector.textfile.directory=/textfile
    volumes:
      - /:/rootfs:ro
      - /home/ubuntu/ftl-monitoring/textfile:/textfile:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9100/metrics"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks: [ftl-platform]

  cadvisor:
    image: ghcr.io/google/cadvisor:v0.60.6   # 官方现址字面名（订正④：无 build、无搬运）
    container_name: ftl-cadvisor
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["8080"]
    command: ["--docker_only=true", "--housekeeping_interval=30s", "--disable_metrics=percpu,sched,tcp"]
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
      - /dev/disk/:/dev/disk:ro
    # healthcheck：⚙️ **已回填（T12 真栈实测，2026-10-03）**：官方镜像**自带** HEALTHCHECK
    # （`docker inspect` 实测：`CMD-SHELL /usr/bin/healthcheck.sh`，interval 30s/timeout 3s/
    # start-period 5s；镜像内含 `/usr/bin/wget`）⇒ compose 无需补、`up --wait` 能等它真就绪。
    networks: [ftl-platform]

  alert-relay:
    build: { context: ., dockerfile: Dockerfile.alert-relay }
    image: ${IMAGE_PREFIX:-pokergame}-alert-relay:${IMAGE_TAG:-latest}
    container_name: ftl-alert-relay
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["8090"]
    environment:
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}
      - FEISHU_WEBHOOK_URL=${FEISHU_WEBHOOK_URL:-}
      - DINGTALK_WEBHOOK_URL=${DINGTALK_WEBHOOK_URL:-}
      - DINGTALK_SECRET=${DINGTALK_SECRET:-}
      - WECOM_WEBHOOK_URL=${WECOM_WEBHOOK_URL:-}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8090/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks: [ftl-platform]
```

- 六块**一律 `expose` 不 `ports`**（生产面）；cadvisor **无 `build:`**（官方镜像字面名，订正④）；四个自建服务命名沿 R1303 模板。
- 卷声明（顶层 `volumes:` 追加三个 `driver: local`）。
- **骨架形态声明**（nit-4）：上表语义逐字；`logging` 等块的实际排版照既有块的多行样式统一——**形态可调、语义不动**。
- dev 形态（override）：六块各 + `profiles: ["monitoring"]` + `ports`（`3010:3010` · `9090:9090` · `9093:9093` · `9100:9100` · `8081:8080` · `8090:8090`）+ 监控三服务 `INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}` + grafana `GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-dev-grafana-pass}` + `GF_SERVER_ROOT_URL=http://localhost:3010/grafana/`。**指标端口（9000–9006）不发宿主口**（探针走 `docker exec`）。

### 2.2 指标注册表（终表；标签基数全部有界）

| 指标 | 类型 | 标签（值域） | 落点 | 备注 |
|---|---|---|---|---|
| `http_requests_total` | counter | `method` · `route`（Express 模板；未匹配 = `unmatched`）· `status` | shared `createHttpMetricsMiddleware`（六服务） | ⚙️ 真栈核对 `req.route?.path` 在 Nest 下确为模板形（探针：带 query 请求后 metrics 里无原始 URL） |
| `http_request_duration_seconds` | histogram（桶 `[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5]`） | `method` · `route` | 同上 | 状态码不进直方图（基数） |
| prom-client 默认集（`process_*`/`nodejs_*`） | — | — | shared `initMetrics()`（`collectDefaultMetrics`，幂等） | |
| `ws_connections` | gauge | — | room `ws.gateway.ts`（§1.2 行） | 恰一次升降；单测覆盖硬换手/陈旧断线 |
| `match_queue_length` | gauge | `mode` · `base_score`（配置有界） | **`match.service.ts` 既有扫描环**（周期 = config `room.matchScanIntervalMs`，种子 5s；**ZCARD 新增**读深） | region 维求和（现单 region）；HELP 写明 |
| `rooms_active` | gauge | — | `room-metrics.service.ts`（15s，`SCAN room:*` 排除派生键） | HELP：**全栈口径（Redis SCAN 聚合）**——现部署单实例下与全局等价（Y5） |
| `games_active` | gauge | — | game `game-metrics.service.ts`（15s，`cache.size`） | HELP 注明 **per-instance** |
| `games_started_total` / `games_ended_total` | counter | — | room（开局成功点 / `game.ended` 处理点） | |
| `robot_decisions_total` | counter | `result∈{douzero,rule}`（= 设计的 `result` 名，值域登记） · `skill∈{beginner,intermediate,advanced}`（= 设计 `difficulty` 的对应） | robot 决策收口（⚙️ 行） | Y4：叫牌期恒 `{result="rule",skill}` ⇒ 不能当失败读；失败读下行 |
| `robot_decision_errors_total` | counter | `reason`（值域实施钉，如 `douzero_timeout`/`douzero_unreachable`） | robot 决策失败路径（Y4） | 面板「机器人失败」读此 |
| `records_cleanup_last_success_timestamp_seconds` | gauge | — | user `records-cleanup.service.ts`（**启动置 0**→成功 set） | 「从未成功」也会被规则命中 |
| `records_cleanup_failures_total` | counter | — | 同上（失败 catch） | |
| `records_rows_deleted_total` | counter | — | 同上（成功分支，`recordsDeleted`） | |
| `records_table_bytes` | gauge | — | 同上（`information_schema` 两表 `DATA_LENGTH+INDEX_LENGTH`） | 近似值（HELP 注明） |
| `douzero_decides_total` | counter | `result∈{ok,unknown_model,not_loaded,error}` | douzero `server.py` 四路（**集合**：`:261` unknown_model · `:264` not_loaded · `:276` ok · `:280` error——Y12 订正配对） | |
| `douzero_decide_seconds` | histogram | — | douzero（只包 `_act`） | |
| `douzero_models_loaded` | gauge | — | douzero（启动装载后 `len(loaded_agents)`） | |
| `alert_deliveries_total` | counter | `sink∈{feishu,dingtalk,wecom}` · `result∈{ok,error}` | relay | |
| `backup_last_success_timestamp_seconds` | gauge | — | textfile（backup.sh） | 失败**不擦**上一次成功值（carry-forward，§2.9） |
| `backup_last_attempt_timestamp_seconds` | gauge | — | 同上（每次运行恒写） | |
| `backup_last_attempt_result` | gauge（=1） | `result∈{ok,failure}`（Y6 收口——值域收缩，无 skipped） | 同上 | 锁竞争与真失败同码 ⇒ 同为 `failure`（`backup.sh:105-108` exit 1） |

### 2.3 shared metrics 模块 API（写死）

```ts
// packages/shared/src/metrics/registry.ts
export function metricsRegistry(): Registry;  // 单例（模块级）
export function initMetrics(): void;          // collectDefaultMetrics({register}); 幂等（多次调用不重复注册）
export function createCounter(name, help, labelNames?): Counter;   // 构造器再导出——
export function createGauge(name, help, labelNames?): Gauge;       // 强制 registers: [metricsRegistry()]
export function createHistogram(name, help, labelNames?, buckets?): Histogram;  // （C9 的 registry 同一性由此保证）

// packages/shared/src/metrics/http-metrics.ts
// 结构类型 (req,res,next)（无 express/@nestjs 依赖——照 trace-middleware 先例）
export function createHttpMetricsMiddleware(): (req: …, res: …, next: () => void) => void;
// res.on('finish') 时按 req.route?.path ?? 'unmatched' 计数；不影响任何响应

// packages/shared/src/metrics/metrics-listener.ts
export function startMetricsListener(opts: { port: number }): { close(): Promise<void> };
// node:http 独立服务器；GET /metrics ⇒ registry.metrics()（Content-Type: text/plain; version=0.0.4）
// 守卫：Authorization: Bearer <process.env.INTERNAL_SERVICE_TOKEN>；缺失/不匹配 ⇒ 401（fail-closed：
//   env 未设 ⇒ 一律 401）。其余路径 404。该服务器**不**经 createHttpMetricsMiddleware。
```

- `shared/package.json` dependencies +`"prom-client": "15.1.3"`（精确钉版——受控升级，理由同 §0 表）。
- **构造器可选参数语义（R1 实施期登记）**：`labelNames`/`buckets` 省略是契约的一部分，实现必须条件展开——显式 `undefined` 会覆盖 prom-client 内部默认值（无标签指标加载即崩）；`buckets` 省略时**不得**回落 `[]`（只剩 `+Inf` 桶）。
- **监听失败语义（R2 实施期登记）**：端口被占等 `'error'` ⇒ 结构化错误日志（含端口号）+ `process.exit(1)`（fail-loud；指标静默缺失比起不来更坏）。
- 六个 `main.ts` 接线各 2 行（顺序：`app.use(createHttpMetricsMiddleware())` 紧跟 `createTraceMiddleware` 之后；`startMetricsListener({ port })` 在 `listen()` 前）。

### 2.4 prometheus.yml（逐字）

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files:
  - /etc/prometheus/rules/*.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
scrape_configs:
  # 六个 Nest：Bearer 走 credentials_file（entrypoint 生成，600）
  - { job_name: api-gateway,   static_configs: [{ targets: ["api-gateway:9000"] }],   authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: user-service,  static_configs: [{ targets: ["user-service:9001"] }],  authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: room-service,  static_configs: [{ targets: ["room-service:9002"] }],  authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: game-service,  static_configs: [{ targets: ["game-service:9003"] }],  authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: robot-service, static_configs: [{ targets: ["robot-service:9005"] }], authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: config-service,static_configs: [{ targets: ["config-service:9006"] }],authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
  - { job_name: douzero,       static_configs: [{ targets: ["douzero:2021"] }] }   # 无守卫（网络内）
  - { job_name: node-exporter, static_configs: [{ targets: ["node-exporter:9100"] }] }
  - job_name: cadvisor
    scrape_interval: 30s
    static_configs: [{ targets: ["cadvisor:8080"] }]
    metric_relabel_configs:   # 白名单：只留四类（基数与磁盘控制）
      - source_labels: [__name__]
        regex: "container_(cpu_usage_seconds_total|memory_working_set_bytes|start_time_seconds|last_seen)|machine_memory_bytes"
        action: keep
  - { job_name: prometheus,    static_configs: [{ targets: ["prometheus:9090"] }] }
  - { job_name: alertmanager,  static_configs: [{ targets: ["alertmanager:9093"] }] }
  - { job_name: grafana,       metrics_path: /grafana/metrics, static_configs: [{ targets: ["grafana:3010"] }] }
  - { job_name: alert-relay,   static_configs: [{ targets: ["alert-relay:8090"] }],   authorization: { type: Bearer, credentials_file: /etc/prometheus/secret/internal_token } }
```
（cadvisor 的 `name` 过滤在**规则里**做 `name=~"ftl-.*"`，不在这层——relabel 只做指标名白名单。⚙️② **已回填（T12 真栈实测，2026-10-03）**：`container_last_seen` 在 v0.60.6 **仍导出**（17 条序列）⇒ 白名单保留；`name` 标签实测**无前导 `/`**（`name="ftl-api-gateway"`），规则/自证侧的 `/?(ftl-.*)` 两形态都接。⚙️⑤ **已回填（同实测）**：grafana `/metrics` **不是鉴权问题而是子路径重定向问题**——`GF_SERVER_SERVE_FROM_SUB_PATH=true` ⇒ `/metrics` 回 301、Location 用 `GF_SERVER_ROOT_URL` 拼成 `<root>/grafana/metrics`（dev 指 `http://localhost:3010` ⇒ Prometheus 跟随后连**自己容器内**的 localhost⇒目标恒 down；prod 形态会指向公网域名打一次出站回环并叠出假 ServiceDown）；该路径**无鉴权**（实测 200）⇒ 处置 = `metrics_path: /grafana/metrics`（上图已改，不需要 basic_auth）。）

### 2.4bis rules/ftl-alerts.yml（**13 条** = 10 类，3 类按 severity 拆名——Y11；逐条完整）

| 规则名 | `expr` | `for` | `severity` | `annotations`（中文，含一行「先看哪里」） |
|---|---|---|---|---|
| `Watchdog` | `vector(1)` | — | `none` | summary：「监控活着」心跳（每 24h 一封；它不来了 = 监控自己坏了） |
| `ServiceDown` | `up{job=~".+"} == 0` | `2m` | `critical` | summary：`{{ $labels.job }} 抓不到了`；runbook：先看容器 `docker ps`，再看九字段日志 traceId 追查 |
| `Http5xxRatioHigh`（warning） | `sum by (job) (rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (job) (rate(http_requests_total[5m])), 1e-9) > 0.05` | `10m` | `warning` | |
| `Http5xxRatioHigh`（critical） | 同上 `> 0.2`（规则名 `Http5xxRatioCritical`） | `5m` | `critical` | |
| `HostDiskSpaceLow` | `(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",mountpoint="/"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay",mountpoint="/"}) < 0.2`（critical `< 0.1`，名 `HostDiskSpaceCritical`） | `10m` | `warning`/`critical` | |
| `HostMemoryAvailableLow` | `node_memory_MemAvailable_bytes < 800 * 1024 * 1024` | `10m` | `warning` | |
| `WsConnectionsHigh`（warning） | `ws_connections > 4000` | `10m` | `warning` | `WsConnectionsCritical`：`> 8000` / `5m` / `critical`（**8000 = M0.3 既定线**） |
| `ContainerRestartFlapping` | `changes(container_start_time_seconds{name=~"/?(ftl-.*)"}[1h]) > 2`（**正则加前导 `/` 容忍 + 自证**——Y7/§0 订正登记②） | `5m` | `warning` | 注释写明语义 = **同 ID 重启（crash-loop）**；⚙️③ **已回填（T12 实测）**：`name` 标签无前导 `/`、且跨重建保持同名（值是容器 start_time）⇒ **重建与重启一样推进该值 ⇒ `changes()` 两者都计入**（= 期望语义：反复重建/重启即 flapping） |
| `RecordsCleanupStalled` | `time() - records_cleanup_last_success_timestamp_seconds > 7200` | `10m` | `warning` | 启动置 0 ⇒「从未成功」也命中；首轮 30s 成功即消失 |
| `RecordsCleanupFailing` | `increase(records_cleanup_failures_total[6h]) > 0` | `5m` | `warning` | |
| `AlertDeliveryFailing` | `rate(alert_deliveries_total{result="error"}[30m]) > 0` | `15m` | `warning` | 经邮件通道送达（relay 挂了邮件仍在） |

**备份新鲜度不设规则**（设计 §D6；独立闸在先，只上板）。**匹配自证**（Y7）：C2 附带 `count(container_start_time_seconds{name=~"/?(ftl-.*)"}) >= 6`——正则失配不许静默。

### 2.4ter prometheus entrypoint.sh（写死骨架）

```sh
#!/bin/sh
set -eu
: "${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN required}"
umask 077
printf '%s' "$INTERNAL_SERVICE_TOKEN" > /etc/prometheus/secret/internal_token
# `--config.file` / `--storage.tsdb.path` 由**转发的官方 CMD** 提供（零重复——O3：kingpin 非累计值重复=报错）；
# 本行只补增量 flag，末尾 "$@" 原样转发 CMD。
# ⚙️ 实施期以 `docker inspect <image>` 钉官方 CMD 逐字（若 CMD 不含那两项，则在本行显式补回）。
exec /bin/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.retention.size=5GB \
  --web.listen-address=:9090 "$@"
```
（Dockerfile：`USER root` 段 `mkdir -p /etc/prometheus/secret && chown 65534:65534 /etc/prometheus/secret && chmod 700 /etc/prometheus/secret`，之后回 `USER 65534`。`retention.size` 语态 = **按块回收的软上限**，注释写明。）

### 2.5 alertmanager 生成逻辑（entrypoint 条件拼装）

输出到 `/alertmanager/alertmanager.yml`（数据卷内、nobody 可写、600；`--config.file` 指过去），**不用 envsubst**：

1. `global:`：当且仅当 SMTP 四件套（`SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`）+ `ALERT_EMAIL_TO` **全非空**时拼入 `smtp_smarthost/smtp_from/smtp_auth_username/smtp_auth_password/smtp_require_tls: true`；否则整段省略。
2. `receivers:` 恒有 `webhook`（`webhook_configs: [{url: http://alert-relay:8090/webhook, http_config: {authorization: {type: Bearer, credentials_file: /alertmanager/secret/internal_token}}}]`——**`authorization` 必须在 `http_config` 之下**（O2：平铺是未知字段，AM 载入报错）；token 由同一 entrypoint 先落盘 600）；`email` 接收器与 `heartbeat` 接收器**恒存在**：SMTP 已配 ⇒ `email_configs` 指向 `ALERT_EMAIL_TO`；未配 ⇒ `heartbeat` = **已定义的空接收器**（`receivers: [{name: heartbeat}]`），`email` 接收器不出现（路由不引用它）。**N2 澄清（2026-10-03，T9 审查登记）**：route 的引用口径以**实现（`entrypoint.sh`）为真源**——生成物采用「聚合接收器 + 具名接收器」形态时，未被 route 引用的具名接收器 AM 会**跳过创建**（零行为影响，日志可见）；本条的「恒存在/不出现」描述的是**语义**（SMTP 未配 ⇒ 邮件通道不存在），不是逐字文本形状。
3. `route:`：默认 `receiver: all`（`all` = 已启用接收器的并集：`webhook` 恒在 + `email` 已配时）；`group_by: [alertname, job]` · `group_wait: 30s` · `group_interval: 5m` · `repeat_interval: 4h`；子路由 `{ matchers: [alertname="Watchdog"], receiver: heartbeat, repeat_interval: 24h }`。
4. `inhibit_rules:`：`{ source_matchers: [severity="critical"], target_matchers: [severity="warning"], equal: [alertname, job] }`。
5. **引号纪律（fail-closed）**：任何注入值含 `"`、`\` 或换行 ⇒ 打印明确错误并 `exit 1`；SMTP **半配**（四件套或收件人部分为空）⇒ 同样拒起（响亮）。entrypoint 末尾 `exec /bin/alertmanager --config.file=/alertmanager/alertmanager.yml --storage.path=/alertmanager`（**不转发 `"$@"`**——O3：官方 CMD 的 `--config.file` 指向镜像自带默认配置，异值重复有「last-wins 静默吞掉生成配置」之险；脚本已给全三个 flag。⚙️ 以 `docker inspect` 钉官方 CMD 逐字）。⚙️ 可选预检：`amtool check-config`——**镜像内无 amtool 时以「起容器即验证」兜底**（O2 留案）。

### 2.6 alert-relay（HTTP 契约 + 三 sink）

- 技术：纯 Node（`node:http`，无框架）+ `prom-client`；TS 编译产物 `dist/server.js`；`PORT=8090`（env 可覆写）。**基底 `node:20-alpine`**（O1：BusyBox wget 供 healthcheck）；**Dockerfile 照 `Dockerfile.user-service` 的 COPY 次序模板**（工作区依赖 + `patches/` 先于 install——两门 Dockerfile 对账闸会抓）。**监听失败语义（M1 实施期登记）**：端口被占等 `'error'` ⇒ 结构化错误（含端口号）+ `exit(1)`；启动日志挂 `'listening'` 事件（不留假 listening 行）。**出站不跟随重定向（M2 实施期登记）**：`fetch` 带 `redirect:'error'`——302 终态 2xx 会被记成假成功、307 会跨主机重放方法与正文。
- `POST /webhook`：Authorization Bearer 校验（同 §2.3 口径，401 fail-closed）；body = Alertmanager webhook payload（v4 schema：`alerts[]`/`commonLabels`/`status`）；返回语义：**至少一个已配置 sink 成功 ⇒ 200**；已配置 sink **全部**失败 ⇒ 500（让 AM 按 `repeat_interval` 重投；**首投失败到重投最长 4h，规格接受**——不内置重试）；无任何 sink 配置 ⇒ 200（明示 no-op）。⚙️ **已回填（T12 真栈 dump，2026-10-03）**：真 AM v0.34.1 载荷 = `packages/alert-relay/test/fixtures/alertmanager-v4-real.golden.json`（`test/am-payload-real.test.ts` 消费；含类型定义未声明的 v0.34 新字段 `notification_reason`/`routeLabels` —— 合成 fixture 里没有，真载荷里必须被容错吞掉）。
- 文案（`format.ts`）：标题 `[{{severity}}] {{alertname}}`；正文逐 alert：`job/实例 · 当前值（第一条 annotation 或 expr 摘要）· 开始时间 · 持续`；**只含服务名/指标/数值**（无用户数据、无 URL）。
- 三 sink（`sinks.ts`，`Promise.allSettled` 并发、单槽失败隔离；**每槽出站超时 5s**（`AbortSignal.timeout`））：
  - 飞书：`POST FEISHU_WEBHOOK_URL` `{"msg_type":"text","content":{"text": "标题\n正文"}}`；
  - 企业微信：`POST WECOM_WEBHOOK_URL` `{"msgtype":"markdown","markdown":{"content": "**标题**\n正文"}}`；
  - 钉钉：`POST DINGTALK_WEBHOOK_URL&timestamp=…&sign=…`（sign = `base64(HMAC-SHA256(secret, timestamp + "\n" + secret))` → urlencode；**timestamp 单位 = 毫秒**——Y12，钉钉对秒级会 310000 静默拒收；`{"msgtype":"markdown","markdown":{"title":…,"text":…}}`）。
- 槽位启用 = **env 非空**（**空串 = 未设**，与全仓口径一致）；钉钉要求 URL+SECRET 同时非空（只有其一 ⇒ 拒启动，响亮）。
- `GET /health`（**无守卫**，供 healthcheck）；`GET /metrics`（**Bearer 守卫**，输出 `alert_deliveries_total{sink,result}` + 默认集）。
- **URL 即凭据**：日志/错误信息/`alert_deliveries_total` 的标签**永不出现** webhook URL 或 secret（单测 C8 钉）。

### 2.7 Grafana（provisioning 骨架）

- `provisioning/datasources/prometheus.yml`：datasource `Prometheus`（uid 固定 `ftl-prometheus`），url `http://prometheus:9090`，`isDefault: true`。
- `provisioning/dashboards/ftl.yml`：provider 指向 **`/etc/grafana/dashboards`**（**卷外**——R1：`grafana-data` 卷遮蔽 `/var/lib/grafana`，面板必须落卷之外才不随首启冻结；镜像内 COPY 目标 = 同一路径）。
- entrypoint.sh（守卫，非模板）：`: "${GF_SECURITY_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD required}"` 后 `exec /run.sh`（官方 ENTRYPOINT；**改口令**走手册 `grafana cli admin reset-admin-password`——设计 §D10）。
- 四面板 JSON 内 datasource 引用统一 `{"type":"prometheus","uid":"ftl-prometheus"}`。

### 2.8 Caddyfile diff（插在 `/admin` 两条 handle 之后、catch-all 之前）

```
	# 监控片：Grafana 看板（片内唯一新公网面；写法照 /admin 的实测经验：
	# redir 必须显式给 matcher；handle 组按 matcher 重排，源码次序不是保证——2026-10-01 实测）
	handle /grafana {
		redir * /grafana/ 301
	}
	handle /grafana/* {
		reverse_proxy grafana:3010
	}
```

### 2.9 backup.sh textfile（逐字骨架）

```bash
TEXTFILE_DIR="${TEXTFILE_DIR:-/home/ubuntu/ftl-monitoring/textfile}"   # 测试注入点；生产不设

write_textfile() {                     # EXIT trap：ok / failure 两态（Y6）
  local code=$? now result prev="" cur tmp
  mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
  cur="$TEXTFILE_DIR/backup.prom"; tmp="$cur.tmp.$$"
  [ -f "$cur" ] && prev=$(sed -n 's/^backup_last_success_timestamp_seconds //p' "$cur" | head -1)
  now=$(date +%s)
  case "$code" in
    0) result=ok ;;
    *) result=failure ;;   # 锁竞争（backup.sh:105-108 exit 1）与真失败同码 ⇒ 同为 failure。
                           # Y6：值域收缩为 {ok,failure}——不加独立退出码（避免碰 slice-07.5 对锁路径的既有断言）
  esac
  { echo "# HELP backup_last_attempt_timestamp_seconds Last backup attempt (epoch)."
    echo "backup_last_attempt_timestamp_seconds $now"
    echo "# HELP backup_last_attempt_result Last backup result (series present = current state)."
    echo "backup_last_attempt_result{result=\"$result\"} 1"
    if [ "$result" = "ok" ]; then echo "backup_last_success_timestamp_seconds $now"
    elif [ -n "$prev" ]; then echo "backup_last_success_timestamp_seconds $prev"; fi
  } > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$cur" \
    || log "WARN: textfile 写入失败（不影响备份本身）"
}
# ⚠️ trap 必须装在**参数解析完成之后**（Y6）：早装会把 `--help`（exit 0）写成假的 ok+成功时间戳、
#    未知参数（exit 2）写成假 failure。
trap write_textfile EXIT
```
- 目录：**755**、文件 **644**（node-exporter 以 nobody 读）；**原子写**（tmp + mv）；`install-cron.sh` 负责 `mkdir -p` + chmod（发布流水线「装备份」步先于 `up` 执行 ⇒ bind 源存在）。
- `TEXTFILE_DIR` 是**新注入点**（测试用）；生产不设。

### 2.10 build-images.sh —— **无需改动**（订正④：搬运步退役）

早先方案（CI 从 `gcr.io/cadvisor/cadvisor:v0.60.6` 拉取 → retag `${IMAGE_PREFIX}-cadvisor` → 推 GHCR）**作废**：2026-10-03 双端实测——`ghcr.io/google/cadvisor:v0.60.6` **服务器与开发机均可直拉**，而 gcr.io 路径的版本 tag 已不存在（仅陈旧 `latest`）。compose 直接字面名引用；`build-images.sh` 回归原样（bake 后无任何 cadvisor 步骤）。

### 2.11 conformance-stack.sh 三段改

1. **up**：两处 `up`（PULL_MODE 0/1）都追加 `--profile monitoring`（与 `--profile edge` 并写）。
2. **down**：`docker compose down` **之前**加 `docker compose --profile monitoring rm -sf prometheus grafana alertmanager node-exporter cadvisor alert-relay || true`（照门口 `:71` 先例；残留检查保留）。
3. **PULL_MODE=0 无需供给**（订正④）：cadvisor 是官方字面名，`up --build` 对它自动 pull（双端实测可达）；旧的“GHCR→gcr 兜底 + retag”供给段已删除。**PULL_MODE=1**：`SERVICES` 数组（`:22`）扩四名（`prometheus grafana alertmanager alert-relay`——**不含 cadvisor**），retag 环自动覆盖。

---

## 3. 判据（C1–C14；载体：`slice-16-monitoring` + 单测；全部同提交）

| # | 判据 | 判别力要点（负对照/敏感性） |
|---|---|---|
| C1 | 七目标 `/metrics`：无凭据 401 / 带 Bearer 200 且含 `http_requests_total`（douzero 免凭据、含 `douzero_decides_total`）——**`docker exec` 路径**（Nest 用 curl、douzero 用 `python3 -c urllib`） | 两向都测；漏一处接线/守卫失效当场红 |
| C2 | Prometheus `/api/v1/targets`：**恰 13 个目标、名字逐个**、`health=up`（relay/grafana 给 15s×4 重试窗；**grafana `/metrics` ⚙️⑤ 已回填（T12 真栈实测）**——不是鉴权而是**子路径 301**：`serve_from_sub_path` ⇒ `/metrics` 301 到 `<root_url>/grafana/metrics`、Prometheus 跟随后连不上（dev 恒 down / prod 假 ServiceDown）⇒ scrape 已改 `metrics_path: /grafana/metrics`（实测该路径无鉴权 200）；**修正后 13 目标全 up**）；`/api/v1/rules` 计数 = **13**；**容器名正则自证** `count(container_start_time_seconds{name=~"/?(ftl-.*)"}) >= 6`（Y7；**实测 = 16**，`name` 无前导 `/`）；**降级配方（Y3）**：env `MONITORING_EXPECT_CADVISOR`（默认 `1`）为 `0` 时断言「cadvisor 缺席且其余 12 个 up」——**注入点**：CI 由 `conformance.yml` 的 job env、本机 `export`；**随动清单**：compose 摘 cadvisor 块、`conformance-stack.sh` 的 rm 名单同步、**`prometheus.yml` 摘 cadvisor job（含其 relabel 段）**、C13 六块断言改五块——降级 = 一次显式小改动，不是运行时开关 | 目标清单逐个钉；降级写成 checklist |
| C3 | `promtool check config /etc/prometheus/prometheus.yml` + `promtool check rules /etc/prometheus/rules/*.yml`（在**同 tag** 的 prometheus 容器内 `docker exec` 跑） | 语法闸；不依赖 render-gate |
| C4 | 边缘面：`GET /grafana` ⇒ 301 至 `/grafana/`；`GET /grafana/` ⇒ **跟随重定向后** 200（未登录 = 302 → `/grafana/login`，Y1）；**负对照** `GET /metrics` 经边缘 ⇒ 404 | 唯一新公网面 + 指标面不出网 |
| C5 | relay（**机制 = 切片自带容器化 stub，方案 a——O5**：`docker run --rm -d --network pokergame_ftl-platform node:20-alpine node -e '<内联 stub：记录请求 + `GET /_received` 回读>'`；**relay 探针实例** = 同 tag 的 relay 镜像 + 受控 env（各槽位 URL 指 `http://<stub 容器名>:18990/…`）；经 `docker exec <stub> wget -qO- …/_received` 读回；用例含「全未配」「部分配」「stub 500」三种 env 组合）：合成 AM payload ⇒ 各**已配**槽位收到逐字格式正确的请求；未配槽位不发（负对照）；stub 500 ⇒ 仅该槽 `{result="error"}` 上升、其余照达、HTTP 200；全槽失败 ⇒ 500；`/metrics` 无 Bearer ⇒ 401 | 格式/隔离/守卫三向；自包含、不动 compose/workflow |
| C6 | Grafana：登录后 `/api/search` 含**四块**面板名；datasource uid = `ftl-prometheus`；**未设口令 ⇒ 容器不启动**（`docker run --rm -e GF_SECURITY_ADMIN_PASSWORD= <img>` ⇒ 非零退出） | provisioning 真生效 + 真 fail-closed |
| C7 | 备份 textfile **两向**：① 照 `slice-07.5-backup.ts:306-310` 的 CLI flags 对 scratch 替身实跑 `backup.sh` ⇒ `backup.prom` 两指标出现且时间戳前进（**再跑一次断言 carry-forward**）；② 替身 mysqldump 报错 ⇒ `{result="failure"}` 变化且**上次成功时间戳保留**；③ **经容器写**样例（O6：`docker run --rm -v <textfile 挂载源>:/t node:20-alpine sh -c 'printf … > /t/sample.prom && chmod 644 /t/sample.prom'`——路径由 daemon 侧解析，Linux CI 与 Windows dev 通吃）⇒ Prometheus 查到（上板链路通） | 「backup.sh 真的会写」+ 失败不擦成功值 + 上板链路 |
| C8 | relay 单测：三 sink golden 载荷 · 钉钉签名**对照向量取固定值**（官方文档样例）+ **时钟注入**——不得用测试自身现算时间戳自证（单位错不捕获，Y12）· 禁用槽不发 · 失败隔离 · **URL/secret 不进日志/标签**（捕获 console） · 空串=未设 · 三槽 env 组合（全未配/部分/全配） | 安全面（S2）+ 签名单位 |
| C9 | shared metrics 单测：route 归一化（模板/`unmatched`/负例：同名不同 query 合并为一串）· Bearer 守卫 fail-closed（无 env ⇒ 401）· **构造器 registry 同一性**（`createGauge()` 造的指标出现在 `metricsRegistry().metrics()` 输出里；直连 `new Gauge()` 不在——证明强制必要）· registry 输出可被 prom 语法解析 | |
| C10 | WS gauge：单测覆盖 连接→1、断线→0、**硬换手不双计**、**陈旧断线不误减**、**拒握手不计入**（缺 token/缺 userId 两条拒绝路径；**inc 点必须在鉴权/注册完成之后**——`:248` 是入口，直接 inc 会把拒握手算进去，⚙️ 钉实际行）；真栈探针：**基线化口径**（先读基线 → 连接一条 → 基线+1 → 断开 → 回基——避免前序余音假红，Y8） | 两处特殊路 + 拒握手负对照 |
| C11 | 业务 gauge 存在性 + 值域 sanity（真栈）：`match_queue_length`（造一张票后 ≥1 **且与 Redis ZCARD 对账**）· `rooms_active`（**与 Redis 真值对账 + 本局房在册**——净增量口径在 CI 首跑被同期到期房抵掉〔19→19 而本房在册〕，T13b 订正为确定性两条件）· `games_active` 开局后 ≥ 基线+1（per-instance cache，无到期面）· `robot_decisions_total` 在一局含机器人后上升 | |
| C12 | 记录清理四指标：真栈等首轮（≤30s+窗口）⇒ `last_success > 0`；**初始 0 语义**单测（构造从未成功场景断言规则表达命中） | O3 的「最该响的场景」 |
| C13 | 渲染面（进既有切片）：六新服务的 `image:` 命名 R1303 形（`slice-07.2-deploy` A11 两渲染）· 生产零 `ports` 断言对新块自动覆盖 · `logging` 上限六块齐 | §4 |
| C14 | 供给链：**切片内静态断言**（`conformance-stack.sh` up 两处含 `--profile monitoring`、down 含点名 `rm -sf` 六容器、`SERVICES` 恰 12 项〔含四监控自建、**不含 cadvisor**——订正④〕）+ `docker compose config` 两形态渲染；**真 up/down 一轮零残留**由 CI 每轮起栈/收栈**天然覆盖**（不进切片——切片内拆栈会中途打断套件，Y2） | 静态断言 + CI 天然覆盖 |

---

## 4. 会红的既有判据（同提交清单；实现期先全仓 grep 再动）

| 文件 | 动作 |
|---|---|
| `tools/conformance/src/slices/slice-07.2-deploy.ts` | `BUILD_SERVICES:555` 8→12；「恰好」断言 `:560-564`；两渲染镜像名 `:565-591`（nit-2 行号订正）；`TOKEN_SERVICES:124` **+3**（prometheus/alertmanager/alert-relay）；`DIRECT_PORT_SERVICES:132`/`HEALTH_TARGETS:364` **不动**（语义不符，监控目标另设清单）；`LOG_LIMIT_TARGETS:955-959` **+6** |
| `tools/conformance/src/slices/slice-07.4-pipeline.ts` | `:956-961` 8→12（nit-2 行号订正） + 注释 `:66`（**render-gate 每次 push 跑**） |
| `tools/conformance/src/slices/slice-07.2-hardening.ts` | 出站超时包清单 `:963` += `"alert-relay"` |
| `tools/conformance/src/slices/slice-07.3-edge.ts` | +`/grafana` 两 handle 断言（C4 的镜像半边；先例引 `slice-14-config-center` 的 C20） |
| `run.ts` / `baselines.json` | 注册 `slice-16-monitoring`；回填（§5） |
| `.github/workflows/*` + `scripts/deploy/build-images.sh` | 「8 个」文案**6 处实测分布**（Y10）：`release.yml:43/:82` · `images.yml:1/:31` · **`build-images.sh:2/:32`**；+ `conformance.yml:4`「7 镜像」+ release.yml `:43` 步骤名/`:78-90` 算术 |
| `docs/ops/first-deploy.md` **计数清扫**（Y10） | `:25`/`:32`（第 10 个 / 9 个容器）· `:123`（10 个容器 + 8 个镜像）· `:693`/`:703`/`:739`（**19 个切片**——出现在**预期输出串**里）· `:722`/`:755`/`:759`/`:806`（8 个镜像；`:806` 列镜像名）；**收口前全仓再 grep 一遍** |
| `docker-compose.yml` 头注 | `:2`/`:8`/`:10`（9/10 个服务、第 10 个容器）随 +6 块订正 |
| `docs/ops/first-deploy.md` | 五小节 + `.env` 表 + 发布前注意 |

---

## 5. conformance 与回填

- `slice-16-monitoring` 进 `run.ts` `CASES`（全量循环按 `--list` 动态枚举 ⇒ 自动入 CI）。
- **回填纪律（design 纪律 #4）**：本片判据以**静态读数**为主（渲染/promtool/单测/golden）⇒ 本机确定性读数**先填** + CI 首跑即验；真栈动态读数（C1/C2/C5/C7/C10–C12）按 CI 实测回填。baselines 的 `slice-16-monitoring` 值与 **full 列**同批回填。
- 断言数预估：**90–150**（C1–C14 展开）。回填口径：本机可确定性跑出的（渲染/promtool/单测）**先数先填**；纯真栈项按 CI 首跑实测回填——二者同批进 `baselines.json`（静态切片基线回填免首跑红仪式，纪律 #4）。

## 6. 部署与回滚

- **发布前（用户动作）**：服务器 `.env` 加 `GRAFANA_ADMIN_PASSWORD`（必填；守卫 fail-closed ⇒ 不加它 grafana 起不来）。通道变量随配随生效。
- 发布链零改动（images→conformance→deploy）；「装备份」步先建 textfile 目录 ⇒ 首次 `up` 时 bind 源已存在且 ubuntu 可写。
- **回滚**：旧 tag 的 compose 无监控服务 ⇒ 六容器变孤儿**继续运行**（无流量职责、无害；资源占用 ≈1GB）；再次前进自动复用（先例：片⑦ config-service 的孤儿口径）。三个命名卷跨版本保留（TSDB/Grafana 状态不丢）。

## 7. 兼容面（摘要，详情见设计 §4）

玩家可见面零变化 · 唯一新公网面 `/grafana/` · 磁盘 +6 镜像 ≈1GiB/版（**M-3 注记：2026-10-03 `docker images` 实测 4 自建 ≈2.9GB/版——grafana 单镜像 ≈1.9GB；运营侧〔手册「12 镜像 ≈8.7GB」/ release 预算 90min〕已按实测，本条保留设计原估值**）+ TSDB（30d/5GiB 软上限） · 内存预估 ≤1GiB（上线回填） · 镜像源（**全部 dv/ghcr 直拉，gcr 依赖为零**——订正④后 cadvisor 也在 ghcr.io） · 假红面（token 同源 = 同一 `.env` 逐字同传） · cadvisor 降级路径 · Watchdog 依赖邮箱通道（未配 ⇒ 残余，登记） · 隐私（IM 文案无用户数据、URL 不入日志） · 数据可弃性（TSDB/Grafana 不入备份；配置全在仓库）。

## 8. 明确不做

同设计 §6（日志聚合 · APM · 短信/电话/值班 · 外部 dead-man · M0.3 自动暂停 · 备份新鲜度告警 · 镜像漏洞扫描 · 多用户 RBAC · 阈值进配置中心 · 多实例指标语义 · K8s/HA · 审计留存 · Bark/ntfy）。

## 9. 风险

① cadvisor 全链为准（**官方 ghcr.io 字面名直拉〔订正④，搬运机制已退役〕** + cgroup v2 权限 + healthcheck 工具三项 ⚙️ 实施核；有降级路径）；② AM 生成器是本片唯一自写模板引擎（三重防线：引号纪律/半配拒起/⚙️ amtool 预检）；③ Grafana 子路径与 Caddy handle 次序（C4 + 真栈实测）；④ 通道凭据到位时点（空转无害；验收演练覆盖）。

## 10. 下一步

1. 审规格（子代理；**规格+计划可同轮审**——本次按「计划先行起草、两文同轮送审」执行，纪律 #3）；
2. 计划（任务拆分照「文件不相交的组可 worktree 并行」）；
3. 实现（子 agent 逐任务 + 转录型自查/判断型全审）→ 终审 → 收口。
