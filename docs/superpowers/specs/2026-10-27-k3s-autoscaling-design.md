# 扑克平台 · k3s 迁移与自动扩缩容（一期）设计

> 状态：草案（待用户评审）
> 日期：2026-10-27
> 流程：按 `docs/dev-process.md` v2026-10-15；设计对抗审查记录见 §10
> 前置阅读：`docs/appendix/platform-roadmap.md` §5.3、`docs/superpowers/specs/2026-09-23-multi-instance-safety-design.md`
> 交付拆分：本文覆盖一期三片（A 平台底座 → B 应用多副本安全 → C 弹性策略）；实现计划按片拆分，每片独立验收、独立提交，不合并成一个大上线。

---

## 0. 用户裁决（2026-10-27）

| # | 裁决 | 说明 |
|---|---|---|
| J1 | 目标 = **真弹性** | 预计流量会涨；规模不确定，按保守估设计 |
| J2 | 平台 = **自建 k3s** | 不用腾讯云 TKE 托管 |
| J3 | 机器 = 现有 1 台 + 新购 1 台 | 共 2 节点 |
| J4 | 数据层留集群内 | MySQL/Redis 钉固定节点、local-path、不 HA |
| J5 | 分期 | 一期做连接层与无状态服务；game-service 多实例后置 |
| J6 | 伸缩 = Pod 级 HPA | 节点固定 2 台，不做节点自动伸缩 |
| J7 | 迁移 = 接受一次夜间 1–2 小时停机 | 不做零停机/灰度切换 |

---

## 1. 背景与问题

当前生产是**单机 Docker Compose、单实例**：19 个容器、`container_name` 钉死、唯一入口是单个 Caddy edge。`restart: unless-stopped` 只提供容器级自愈，没有任何水平扩缩能力。

代码侧的关键事实（审查已核实）：

- `packages/game-service/src/game/game.service.ts`：会话真源在 Redis，但 `cache`、`timers`、`roomQueues` 是进程内状态；回合定时器只存在于持有实例。
- `packages/room-service/src/gateway/ws.gateway.ts`：`activeConnections` / `seatOwners` 是进程内 Map；socket.io 广播用 `server.to(roomCode)`；全仓未安装 socket.io Redis 适配器。
- room-service 的匹配扫描、自动开局、房间回收、结算清扫、局终业务链在每个副本都会执行。
- `user/config/currency/payment` 四个服务在进程启动时 `migrationsRun: true`。
- compose 靠门口固定 IP `172.28.0.250` 做可信代理；k8s 里 Pod IP 是动态的。
- 监控用 compose 服务名 static target；backup/deploy 脚本直接依赖 `docker` 容器名。

因此「把 compose 逐项翻译成 Deployment」会在客户端 IP、多副本连接语义、重复后台任务、单实例滚动更新、迁移回滚五处出阻断级故障（详见 §10）。

---

## 2. 范围

### 2.1 做（一期 = 片 A + 片 B + 片 C）

| 片 | 内容 | 独立交付判据 |
|---|---|---|
| **A 平台底座** | 2 节点 k3s；网络/存储/入口；Secret/RBAC；resources/QoS；监控、备份、CI 迁移；迁移夜 runbook | 新集群跑通全栈 + 冒烟；监控/备份/发布链路全绿 |
| **B 应用多副本安全** | 客户端 IP 信任链重做；room-service 适配器 + 跨副本连接登记；后台循环单实例化；局终链唯一执行；迁移 Job；优雅停机；game-service 定时器恢复 | 2 副本回归：顶替登录、跨 Pod 广播、局终只结算一次 |
| **C 弹性策略** | 连接数为主 + CPU 为辅的 HPA；PDB/摘流；压测定容量；看板与告警更新 | 压测触发扩容、缩容不断线、告警/看板数值正确 |

### 2.2 不做（明确登记）

- **game-service 多实例**（片 D 后置）：按 roomCode 路由/分布式锁 + 定时器外置，另立 spec。
- **节点级自动伸缩**：固定 2 台；撑不下时人工加机器或升配。
- **数据层 HA**：MySQL/Redis 单实例钉 node-a；接受节点故障即数据层中断。
- **零停机/蓝绿/灰度切换**：接受一次夜间停机。
- **云托管数据库、CDN、多地域、多集群**。
- **日志聚合/检索**：沿用容器日志轮转，不引入 Loki/ES。
- **客户端协议与界面改动**：除必要重连行为外不动。

---

## 3. 决策表

| # | 决策 | 理由 / 来源 |
|---|---|---|
| D1 | 自建 k3s（Kubernetes 轻量发行版） | J2 |
| D2 | node-a = 现有服务器 = k3s server（控制面）；node-b = 新购 = agent | 审查阻断-4：控制面与数据同失败域，避免制造第二个全站故障域 |
| D3 | node-a 承载：MySQL、Redis、edge、game-service、监控；node-b 承载：可牺牲的接入/业务算力 | node-a 是唯一「不能死」的机器；node-b 故障不影响数据与入口 |
| D4 | 入口继续用 Caddy edge，不用 Traefik Ingress | 静态站/TLS/反代配置零改动；k3s 关闭 Traefik |
| D5 | edge 以 `hostNetwork` + `nodeSelector: node-a` 运行，DNS 指向 node-a EIP | 保住真实客户端 IP；避免 ServiceLB 源 IP 不确定；控制面/入口同机 |
| D6 | 客户端 IP 信任链改为「node-a 内网 IP」为唯一可信代理；网关支持 CIDR/列表配置 | 审查阻断-1；compose 的 `172.28.0.250` 假设在 k8s 不成立 |
| D7 | 单实例负载（game、MySQL、Redis、edge）一律 StatefulSet 或 `Recreate` / `maxSurge: 0` | 审查阻断-5：默认滚动更新会短暂双实例 |
| D8 | game-service 固定 1 副本，钉 node-a | J5；与数据同机、避免无意义跨节点迁移 |
| D9 | MySQL/Redis 用 local-path PVC + nodeSelector node-a；`volumeBindingMode: WaitForFirstConsumer` 实测确认 | 审查高-4 |
| D10 | 数据迁移采用「先建卷 → 复制 → 校验 Job → 再启动」，校验失败阻止 rollout | 审查高-13：空库会自动初始化并静默通过健康检查 |
| D11 | 四个 `migrationsRun` 服务改为：Deployment 关闭迁移，独立迁移 Job（`parallelism: 1`）先跑 | 审查高-5：解锁多副本、避免并发 DDL |
| D12 | room-service 多副本模型 = **socket.io Redis 适配器 + user 房间 + 跨 Pod 顶替**；事件驱动推送保留「每副本订阅、只投本地 socket」；副作用抽到唯一执行点 | 审查阻断-2/3；见 §4.10.2 |
| D13 | 后台循环（匹配扫描/自动开局/回收/结算清扫/指标）用 Redis leader lease 单实例执行；局终链再加 `(roomCode, version)` 幂等闸 | 审查阻断-3 |
| D14 | HPA 以 `ws_connections` 为主指标（Prometheus Adapter），CPU 为辅；minReplicas ≥ 2；缩容稳定窗 ≥ 30 分钟 | 审查高-2 |
| D15 | 所有工作负载必须声明 requests/limits；数据层用 Guaranteed QoS + 高 PriorityClass | 审查高-1：无 requests 时 HPA 恒 `<unknown>`，BestEffort 会被优先驱逐 |
| D16 | 所有 Nest 服务启用 `enableShutdownHooks()`；preStop 摘流 + `terminationGracePeriodSeconds` > 排空时间 | 审查高-3 |
| D17 | CI 用 namespace 级 ServiceAccount + RBAC；不用 cluster-admin kubeconfig；k3s 开 `--secrets-encryption` | 审查高-11 |
| D18 | 默认拒绝 NetworkPolicy + 显式放行；ghcr 拉取用只读 imagePullSecret | 审查高-11 |
| D19 | 备份改为 k8s CronJob，保留本机副本 + 同城对象存储（COS）异地副本；加备份新鲜度告警 | 审查高-7；异地凭据由用户开通 |
| D20 | 发布形态 = `k8s/` 原生清单 + Kustomize；`deploy-k3s.sh` 走 `kubectl apply -k` + `rollout status` + 冒烟 | 不引入 Helm 模板语言；机械闸可读 |
| D21 | 开发/联调与 conformance 继续用 compose；多副本回归用 compose 双实例 profile 或 k3s 预演环境 | 保留既有 dev 工作流 |
| D22 | 压测定容量放在片 C；压测结果决定片 D（game-service）优先级 | 审查高-10：真正热点可能在 game/douzero |

---

## 4. 目标架构

### 4.1 拓扑

```
                 DNS（TTL 60s）→ node-a EIP
                              │
              ┌───────────────┴────────────────┐
              │ node-a（现有服务器）             │
              │  k3s server（控制面, SQLite）    │
              │  edge（hostNetwork 80/443）      │
              │  MySQL / Redis（local-path）     │
              │  game-service（1 副本）          │
              │  监控栈（Prometheus/Grafana/AM） │
              │  room/gateway/robot 副本         │
              └───────────────┬────────────────┘
                              │ 同 VPC 私网（flannel VXLAN）
              ┌───────────────┴────────────────┐
              │ node-b（新购）                  │
              │  k3s agent                     │
              │  room/gateway/robot/user/… 副本 │
              │  douzero（CPU 重负载）           │
              └────────────────────────────────┘
```

- **控制面单点**：node-a 控制面挂掉时，已运行 Pod 继续工作，但调度/HPA/endpoint 更新停止；node-a 本身也是数据层与入口的单点。这是 J4/J7 下明确接受的限制。
- **node-b 可牺牲**：故障只损失算力，数据与入口不受影响；副本会被调度回 node-a（容量允许时）。
- 两台机器必须**同 VPC/私网互通**；安全组只放行节点间 6443/tcp、10250/tcp、8472/udp 与运维 IP。

### 4.2 工作负载表

| 工作负载 | 类型 | 副本 | 策略 | 节点 | HPA |
|---|---|---|---|---|---|
| edge | Deployment + hostNetwork | 1 | Recreate | node-a | 否 |
| api-gateway | Deployment | 2..4 | RollingUpdate | 分散 | 连接数 + CPU |
| room-service | Deployment | 2..4 | RollingUpdate | 分散 | 连接数 + CPU |
| robot-service | Deployment | 1..3 | RollingUpdate | 任意 | CPU |
| user-service | Deployment | 2..3 | RollingUpdate | 任意 | CPU |
| config-service | Deployment | 1 | Recreate | node-a | 否 |
| currency-service | Deployment | 2..3 | RollingUpdate | 任意 | CPU |
| payment-service | Deployment | 1..2 | RollingUpdate | 任意 | CPU |
| game-service | StatefulSet | 1 | Recreate/OnDelete | node-a | 否 |
| douzero | StatefulSet | 1 | Recreate | node-b | 否 |
| mysql | StatefulSet | 1 | Recreate | node-a | 否 |
| redis | StatefulSet | 1 | Recreate | node-a | 否 |
| prometheus / grafana / alertmanager / alert-relay / am-renderer | Deployment | 1 | Recreate | node-a | 否 |
| node-exporter / cadvisor | DaemonSet | 每节点 | — | 全部 | 否 |

> 副本上限是**容量预算**，不是目标值：片 C 压测后按实际 CPU/内存校准；HPA `maxReplicas` 不得超过预算。

### 4.3 网络与入口

- k3s 安装参数：`--disable traefik`，保留 servicelb、metrics-server、local-path、coredns。
- **edge**：`hostNetwork: true` + `nodeSelector node-a`，直接绑定宿主 80/443；TLS 证书在 `caddy-data` PVC。
- **Caddy 上游**：
  - `/api`、`/socket.io` → `api-gateway` Service；
  - `/grafana/` → `grafana` Service；
  - 静态站/下载/agent/admin 仍由 edge 镜像内文件提供。
- **gateway 的 HTTP 上游**用 headless Service，避免 Caddy keepalive 把请求集中到单个 Pod（审查低-3）；WS 长连接天然按连接分发。
- **客户端 IP 信任链**（阻断-1 的修法）：
  1. Caddy 显式配置 `trusted_proxies`，只信任自身注入链路，并写 `X-Forwarded-For`；
  2. gateway `TRUST_PROXY` 改为 **node-a 内网 IP**（稳定值），支持逗号分隔列表/CIDR；
  3. NetworkPolicy 只允许 edge（node-a hostNetwork）访问 gateway 3000；
  4. 上线前端到端断言：真实公网 IP 在 Caddy 日志、网关 `clientIp`、risk 上报三处一致；
  5. 若实测 node-a 出站被 SNAT 成其他地址，按实测值配置，不再使用「容器固定 IP」假设。
- **NetworkPolicy**（默认拒绝）：
  - ingress：edge → gateway；gateway → room/game/user/config/currency/payment；room → game/robot/config/currency/user；prometheus → 各 `/metrics`；
  - egress：各服务 → mysql/redis/dns；业务需要的外部 HTTPS（支付渠道/广告回调）显式放行；
  - ⚠️ `hostNetwork` 的 edge **不受 NetworkPolicy 约束**（k3s 默认 CNI 的已知边界）⇒ 入口面靠节点安全组 + 网关自身鉴权/限流兜底，安全组只放行公网 80/443 与运维端口。
- **WS 粘性**：客户端全部 `transports: ['websocket']`，当前无需 sticky；Caddy 对 `/socket.io` 保持 websocket-only 配置（审查低-1）。

### 4.4 存储

| PVC | 用途 | 节点 | 说明 |
|---|---|---|---|
| `mysql-data` | MySQL datadir | node-a | 容量 = 现有卷 ×1.5，迁移前实测 |
| `redis-data` | Redis AOF/RDB | node-a | 开 AOF；`maxmemory` 与驱逐策略显式配置 |
| `caddy-data` | 证书/ACME 账户 | node-a | 保属主复制（uid 1001），迁移前校验 |
| `prometheus-data` / `grafana-data` / `alertmanager-data` | 监控状态 | node-a | 数据可弃性不变 |
| `alertmanager-live` / `relay-data` | AM 生成配置 / 通知 last-good | node-a | am-renderer 与 alertmanager 必须同节点 |

- 所有挂卷 Pod 设置 `securityContext.fsGroup` 或 initContainer chown（caddy 1001、grafana 472、prometheus/alertmanager 65534、node relay）。
- local-path StorageClass 必须确认 `volumeBindingMode: WaitForFirstConsumer`；PVC 先建、确认 Bound 且 PV 亲和指向 node-a 后再启动工作负载。
- 节点名用 `--node-name` 固定，避免重装后 PV 亲和不匹配。

### 4.5 配置与密钥

- 命名空间：`ftl`（业务）、`ftl-monitoring`（监控）。
- `Secret ftl-secrets`（一次性创建、CI 永不覆盖）：
  `DB_PASSWORD`、`JWT_SECRET`、`ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`、`AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`INTERNAL_SERVICE_TOKEN`、`PAY_CONFIG_ENC_KEY`、`PAY_CHANNEL_PULL_TOKEN`、`NOTIFY_CHANNEL_PULL_TOKEN`、`AD_CHANNEL_PULL_TOKEN`、`GRAFANA_ADMIN_PASSWORD`、`SITE_ADDRESS`、`TLS_MODE`。
- 非敏感项进 ConfigMap；测试注入型 env（`CONFIG_SYNC_*`、`GAME_*`）只在需要时给。
- k3s 开 `--secrets-encryption`；Secret 不落 git、不进日志。
- `imagePullSecret: ghcr-pull` 为只读 PAT；按季度轮换。

### 4.6 可观测性

- Prometheus 改用 **Kubernetes SD**（role: pod/endpoints），按 Pod 抓取并携带 `pod`/`namespace`/`node` 标签；每个 Deployment 暴露 metrics 端口（900x）到 Service。
- 引入 **kube-state-metrics**；cadvisor 改走 kubelet/containerd（去掉 `--docker_only` 与 `/var/lib/docker` 挂载）。
- 看板/告警从 `ftl-*` 容器名改为 `pod`/`container` 标签；全栈 gauge（`rooms_active`、`match_queue_length`）用 `max`，per-Pod gauge 用 `sum`。
- 新增告警：NodeNotReady、PodPending、CrashLoopBackOff、PVC 水位、HPA 长期顶到 max、备份新鲜度、证书到期。
- `am-renderer` 与 alertmanager 同节点共享卷的现状保留；跨节点不成立已由 nodeSelector 钉死。

### 4.7 备份与恢复

- **CronJob `mysql-backup`**：每小时 `mysqldump --single-transaction`，写 PVC，校验和 + `manifest.json`；再复制到腾讯云 COS（异地副本）。
- **CronJob `caddy-backup`**：证书卷（含属主）每天备份。
- **告警**：`backup_last_success_timestamp_seconds` 超过 2 小时即告警（现有「只上板不告警」升级）。
- **恢复**：`restore-k8s.sh` 支持「恢复到新 PVC / 指定时间点备份」；迁移前在预演环境真跑一次完整恢复演练（含证书与 `.env` 之外的全部 Secret 清单核对）。
- 旧 Docker 卷在切换后保留 72 小时，校验通过才删除。

### 4.8 CI/CD 与发布

- 镜像构建/推送沿用 `.github/workflows/images.yml`（GHCR，不可变 tag）。HPA 扩容时预拉镜像：节点配 `registries.yaml` mirror 到腾讯云 TCR，或 `imagePullPolicy: IfNotPresent` + 预拉 DaemonSet。
- 新增 `k8s/`：Kustomize base + 生产 overlay；`kubectl kustomize` 渲染是机械闸。
- `scripts/deploy/deploy-k3s.sh <tag>`：
  1. 用**部署专用 ServiceAccount**（namespace 级 RBAC：更新 Deployment/StatefulSet、读 Pod、`rollout`）的 kubeconfig 连接；
  2. `kubectl apply -k` 更新镜像 tag；
  3. 先跑迁移 Job 并等成功；
  4. `kubectl rollout status` + 冒烟（登录、建房、WS、机器人对局、admin、支付配置读取）；
  5. 失败自动 `kubectl rollout undo` 并保留现场。
- `scripts/deploy/rollback-k3s.sh <tag|revision>`：`kubectl rollout undo`（无迁移回退；迁移只向前，回退镜像需人工评估 schema 兼容）。
- `release.yml` 改调用 `deploy-k3s.sh`；`--assert-clean` 口径更新为「服务器无长期 GHCR 明文凭据、无 cluster-admin kubeconfig；imagePullSecret 只存在于集群内」。
- 开发/联调与 conformance 仍走 compose；新增 **2 副本 profile**（两个 room-service 容器 + 两个 gateway 容器，共享 Redis）用于多副本回归，不依赖 k3s。

### 4.9 扩缩容策略

- **指标**：`ws_connections` 为 room-service / gateway 主指标（Prometheus Adapter 暴露为 Pods 自定义指标），目标 = 单 Pod 安全连接数的 70–80%；CPU 70% 为辅。
- **行为**：
  - `minReplicas`: room/gateway = 2；robot/user/currency = 1；
  - `scaleUp`: 30s 稳定窗，允许翻倍；
  - `scaleDown`: 30–60 分钟稳定窗 + 每次最多 1 个 Pod；
  - `maxReplicas` 受容量预算约束（以片 C 压测结果为准）。
- **摘流**：preStop 先失败 readiness，等待 30s 让新连接不再进入，再优雅关闭 socket；`terminationGracePeriodSeconds ≥ 60`。
- **PDB**：room/gateway `minAvailable: 1`；注意 PDB 不覆盖 HPA 缩容，缩容靠 HPA behavior 控制。
- **数据层与单实例**：不参与 HPA；Guaranteed QoS + 高 PriorityClass；kubelet 预留 system-reserved。

### 4.10 应用侧改造

#### 4.10.1 api-gateway

- `TRUST_PROXY` 从单值改为「列表/CIDR」，默认生产 = node-a 内网 IP；单测覆盖「不在信任表则忽略 XFF」。
- `enableShutdownHooks()`；SIGTERM 时主动释放 Redis 里的 WS 连接名额（不等 60s TTL）。
- 多副本无状态；限流、令牌白名单已在 Redis。

#### 4.10.2 room-service

- 安装 `@socket.io/redis-adapter`（复用 `REDIS_URL`，pub/sub 用独立连接）。
- 每个 socket 加入 `user:<userId>` 与 `room:<roomCode>` 房间。
- **跨 Pod 顶替**：握手时 `io.in('user:'+id).fetchSockets()`，对旧 socket 以 `SESSION_REPLACED` 主动断开；`seatOwners` 改为 Redis 权威键（`ws:owner:{userId}`，带连接代次 + TTL），陈旧断线不误减指标。
- **请求驱动广播**（join/leave/toggle/state_update）走 `io.to(room)`，由适配器跨 Pod 扇出。
- **事件驱动推送**（`game:events` / `match:events`）：保留「每个副本订阅、只投本地 socket」的模型，保证每条消息对每个 socket 恰好一次；不改成适配器广播，避免 N 倍重复。
- **副作用唯一执行**：`game.ended` 触发的结算、`record.write`、`robot.release`、`updateStatus`、指标累加，全部移到 leader lease 保护下的单执行点；再加 `SET NX EX` 的 `(roomCode, version)` 幂等闸兜底。
- **后台循环**（match 扫描、autostart、reaper、settle sweeper、room metrics）：Redis leader lease（`SET NX PX 10s`，每 3s 续约）；非 leader 不执行。
- **指标**：`games_ended_total` 只在唯一执行点加一；`rooms_active` 等全栈 gauge 由 leader 写。

#### 4.10.3 game-service

- 一期固定 1 副本（StatefulSet），钉 node-a；`Recreate`/`OnDelete`，禁止滚动更新双实例。
- **定时器恢复**：启动时扫描 `game:session:*` 中 `playing` 会话，按 `turnDeadlineAt` 重建回合定时器；`roomQueues` 仍为进程内（单副本成立）。
- 发布窗口选择低峰；发布前确认在局房间可接受重启（或先排空）。

#### 4.10.4 数据库迁移

- `database.config.ts` 增加 env 开关（如 `DB_MIGRATIONS_RUN`）：compose 默认 `true`，k8s Deployment 设 `false`。
- 迁移 Job 使用同一镜像、`parallelism: 1`、`backoffLimit: 0`；失败阻止后续 rollout。
- 迁移前自动做一次 pre-migration 备份。

#### 4.10.5 优雅停机（全服务）

- 所有 `packages/*/src/main.ts` 调 `app.enableShutdownHooks()`。
- socket.io 关闭时使用可重连的关闭方式，避免客户端 `io server disconnect` 不自动重连。
- preStop：sleep/失败 readiness → 等待排空 → SIGTERM。

---

## 5. 迁移夜 runbook（概要，详细版另立 `docs/ops/k3s-migration.md`）

### 5.1 预演（提前 3–7 天）

1. 新机器装单节点 k3s（server），按本 spec 部署空库全栈，跑冒烟 + conformance 子集。
2. 验证：HPA 扩容/缩容、备份/恢复、证书、监控看板、2 副本 room-service 回归。
3. 预演两次「迁移夜」全流程（含回滚）。

### 5.2 切换夜

1. 提前 24h 把 DNS TTL 降到 60s；公告维护窗口。
2. **在 compose 仍运行时**执行备份（`mysqldump --single-transaction`），校验 manifest/checksum。
3. `docker compose stop -t 120` 正常停 MySQL/Redis/edge。
4. node-a 安装 k3s agent 加入 node-b server；确认两节点 Ready、跨节点 Pod 网络、StorageClass。
5. 创建 PVC → 确认 Bound 且 PV 亲和 = node-a。
6. 复制 MySQL 数据（dump 恢复优先）与 Redis RDB、caddy-data（保属主）；启动数据层。
7. 跑 **verify Job**：行数（users / platform_config / 各迁移表）、配置键数、checksum；失败即中止。
8. 部署业务工作负载；`rollout status` + 冒烟（登录/建房/WS/机器人对局/admin/支付配置）。
9. 切 DNS；观察 30 分钟；旧 Docker 卷保留 72h。

### 5.3 两套回滚

- **DNS 切换前**：删 k8s 工作负载/LoadBalancer，卸载 agent，`docker compose up -d`（旧卷完好；新栈写入处于维护窗口内，丢弃可接受）。
- **DNS 切换后**：从切换前备份恢复到 compose；接受 RPO = 备份点至故障点；迁移 Job 已写入的 schema 需人工评估旧镜像兼容性。**明确不承诺无损回滚。**

---

## 6. 测试与验收判据

### 6.1 机械闸

| 判据 | 方式 |
|---|---|
| 每个工作负载有 requests/limits、readiness/liveness、PDB（适用者） | 清单静态断言脚本 |
| `kubectl kustomize k8s/overlays/prod` 可渲染、kubeconform 通过 | CI |
| 无 cluster-admin kubeconfig / 无明文 GHCR 长期凭据 | `--assert-clean` 新口径 |
| Secret 不入 git、日志不含敏感值 | 既有扫描 + 新增清单扫描 |
| 单实例负载不是默认 RollingUpdate | 清单断言 |

### 6.2 应用回归

| 场景 | 预期 |
|---|---|
| 同一用户在两副本上先后连接 | 旧 socket 被 `SESSION_REPLACED` 断开；旧设备不再收到手牌 |
| 用户 A 在副本 1、用户 B 在副本 2，同房 | 双方都收到 `room.state_update`/`game.*` |
| 一局结束（2 副本） | 结算/记账/`record.write`/归池各恰好一次；`games_ended_total` +1 |
| 匹配/回收/自动开局（2 副本） | 同一轮只执行一次 |
| 真实客户端 IP | Caddy 日志、网关 `clientIp`、risk 上报三处一致；单 IP WS 上限不再全站共享 |
| SIGTERM/滚动更新 | 连接有可重连的关闭原因；gateway 名额立即释放 |
| game-service 重启 | 在局会话的回合定时器按 `turnDeadlineAt` 恢复 |
| 迁移 Job 并发 | 两副本同时启动不会并发 DDL |

### 6.3 真栈验收

- 2 节点 k3s 预演环境跑通全栈 + 冒烟。
- 压测：逐步加到目标连接数（片 C 定值），验证 HPA 扩容、消息延迟、Redis/网关瓶颈；缩容时不断线。
- 故障演练：node-b 关机 → 服务不中断；node-a 关机 → 按已知限制记录恢复时间；Redis/MySQL 重启 → 恢复路径符合 runbook。
- 备份/恢复演练：从 COS/本机备份完整恢复一次。
- 迁移夜全流程预演 ≥ 2 次。

---

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| node-a（控制面+数据+入口）故障 | 已知单点：平台不可用；按 runbook 人工恢复；DNS/数据恢复时间写入 SLA |
| node-b 故障 | 副本调度回 node-a（容量允许），入口与数据不受影响 |
| Redis 重启 | 登录态与在局会话丢失；按 runbook 公告/重建；监控内存/驱逐并告警 |
| MySQL 重启 | 数据层短暂不可用；Guaranteed QoS + 正常关停；备份可恢复 |
| HPA 缩容 | 先摘 readiness、等待排空、优雅关闭；缩容稳定窗 ≥ 30 分钟 |
| 镜像拉取失败 | 节点预热/mirror；`ImagePullBackOff` 告警 |
| 证书签发失败/配额 | 证书卷先行迁移并校验；失败不启动 edge；备份证书 |
| 迁移校验失败 | 阻止 rollout、保留旧栈与旧卷 |
| 数据 Pod 被驱逐 | Guaranteed QoS + PriorityClass；PVC/PV 水位告警 |

---

## 8. 风险与已知限制

| # | 限制 | 处置 |
|---|---|---|
| R1 | node-a 是控制面、数据层、入口三重单点 | 明确接受；备份/恢复演练；后续可 CLB + 数据层 HA |
| R2 | 2 节点固定，无节点自动伸缩 | 容量预算 + 人工升配；HPA max 受限 |
| R3 | game-service / douzero 单实例，是真正 CPU 热点 | 片 C 压测量化；片 D 后置 |
| R4 | game-service 重启丢在局定时器 | 一期做启动恢复（§4.10.3） |
| R5 | Redis 重启 = 全站登出 + 在局丢失 | AOF + maxmemory 策略 + runbook + 告警 |
| R6 | 迁移夜停机与 RPO | 两套回滚 + 预演两次 + 维护窗口 |
| R7 | k3s 自建运维负担（升级、SQLite 备份、证书） | runbook + 固定升级窗口；评估将来迁 TKE |
| R8 | GHCR 大陆可达性 | TCR mirror/节点预热 |
| R9 | 成本：+1 台服务器 + COS 异地备份 | 用户确认 |

---

## 9. 涉及文件（预计）

**新增**
- `k8s/base/**`、`k8s/overlays/prod/**`（Deployment/StatefulSet/Service/Ingress 不用/PVC/NetworkPolicy/PDB/HPA/CronJob/ServiceAccount/RBAC）
- `scripts/deploy/deploy-k3s.sh`、`scripts/deploy/rollback-k3s.sh`、`scripts/deploy/k8s-preflight.sh`
- `scripts/ops/backup-k8s.sh`、`scripts/ops/restore-k8s.sh`
- `docs/ops/k3s-migration.md`、`docs/ops/k3s-runbook.md`
- `docs/superpowers/plans/2026-10-27-k3s-autoscaling.md`（下一步）

**修改**
- `packages/api-gateway/src/http/trusted-client-ip.ts`（+ 测试）
- `packages/room-service/src/gateway/ws.gateway.ts`、`ws.module.ts`、`package.json`（适配器、user 房间、顶替、leader lease、副作用唯一执行）
- `packages/room-service/src/match/match.service.ts`、`rooms/rooms.autostart.ts`、`rooms/rooms.reaper.ts`、`currency/settle.sweeper.ts`、`metrics/room.metrics.ts`
- `packages/game-service/src/game/game.service.ts`（启动定时器恢复 + 测试）
- `packages/*/src/main.ts`（`enableShutdownHooks`）
- `packages/{user,config,currency,payment}-service/src/database.config.ts`（迁移 env 开关）
- `.github/workflows/release.yml`、`scripts/deploy/deploy.sh`（`--assert-clean` 新口径）
- `deploy/monitoring/**`（K8s SD、kube-state-metrics、标签/聚合修正、新告警）
- `docs/design.md` §2.2（部署拓扑更新）

---

## 10. 审查记录（对抗审查，2026-10-27）

审查方式：独立 reviewer 子代理，只读仓库，从反方向攻击架构草案。共 24 条：阻断 6 / 高 14 / 低 4。以下逐条给处置。

### 10.1 阻断（6）

| # | 发现 | 处置 |
|---|---|---|
| B1 | `TRUST_PROXY=172.28.0.250` 在 k8s 失效 → 全站共享一个 IP，WS 上限 5 条 | **修**：D5/D6、§4.3 信任链重做 + 端到端断言 |
| B2 | room-service 多副本：`activeConnections`/`seatOwners` 本地 Map，适配器不解决定向推送/顶替 | **修**：D12、§4.10.2 user 房间 + `fetchSockets` 顶替 + Redis 权威 `seatOwners` |
| B3 | 后台循环/局终链每个副本重复执行 → 重复结算/记录/归池/指标翻倍 | **修**：D13、§4.10.2 leader lease + `(roomCode,version)` 幂等闸 + 指标单点 |
| B4 | 控制面放 node-b 制造第二个全站故障域 | **修**：D2/D3，控制面改放 node-a |
| B5 | 单实例负载默认 RollingUpdate → game 双实例、MySQL/Redis 双开、edge 双写证书 | **修**：D7、§4.2 策略列、§6.1 机械闸 |
| B6 | 回滚到 compose 不成立（备份时机、反向数据、svclb 占 80/443） | **修**：§5.2/§5.3 两套回滚 + 备份先于停机 + 保留旧卷 72h |

### 10.2 高（14）

| # | 发现 | 处置 |
|---|---|---|
| H1 | 无 resources/requests → HPA 不工作、数据 Pod BestEffort 被驱逐 | **修**：D15、§4.2/§4.9 |
| H2 | CPU HPA 与 WS 不匹配；缩容断长连接 | **修**：D14、§4.9 连接数主指标 + 慢缩容 |
| H3 | 无优雅停机/PDB/摘流；gateway 名额 60s 残留 | **修**：D16、§4.9/§4.10.5 |
| H4 | local-path PV 钉节点/RWO/绑定模式；证书卷 | **修**：D9、§4.4 |
| H5 | `migrationsRun` 与单副本绑死；发布停机、并发 DDL | **修**：D11、§4.10.4 |
| H6 | 监控迁移：static target、cadvisor docker_only、标签/聚合失效 | **修**：§4.6 + 机械闸/真栈验收 |
| H7 | 备份/CI/运维脚本依赖 docker 容器名；无异地/无告警 | **修**：D19、§4.7/§4.8 |
| H8 | 卷属主与非 root 镜像 → CrashLoop；证书配额 | **修**：§4.4 fsGroup/chown + 证书先行迁移校验 |
| H9 | 网络前置：同 VPC、安全组、Docker FORWARD、svclb 与 compose 抢端口、镜像拉取 | **修**：§4.1/§4.3/§5.1 预检；预演验证 |
| H10 | 扩缩目标错配：game/douzero 是热点但一期不能扩 | **登记 + 验证**：R3、D22 压测定容量 |
| H11 | 安全：API 6443 暴露、CI cluster-admin、Secret 不加密、无 NetworkPolicy、imagePullSecret 与 C4 冲突 | **修**：D17/D18、§4.3/§4.5/§4.8 |
| H12 | Redis 热路径无 QoS/持久化设计；重启全站登出 | **修**：R5、§4.4/§4.9 |
| H13 | 数据搬迁无「建卷→复制→校验→启动」→ 空库静默初始化 | **修**：D10、§5.2 |
| H14 | game-service 重启后定时器不重建 → 在局卡住 | **修**：§4.10.3 启动恢复 |

### 10.3 低（4）

| # | 发现 | 处置 |
|---|---|---|
| L1 | 当前 websocket-only 无需 sticky；未来 polling 会暴露 | **登记**：§4.3、客户端保持 websocket-only |
| L2 | 旧架构文档 k8s 章节与本期矛盾；conformance 单实例无覆盖 | **修**：§9 更新 design.md；§4.8 2 副本 profile |
| L3 | Caddy keepalive 集中 HTTP 流量 | **修**：§4.3 headless 上游 |
| L4 | GHCR 拉取与 `latest` tag | **修**：§4.8 不可变 tag + TCR mirror/预热 |

### 10.4 审查中需真栈实证的断言

以下机制性判断在预演环境必须实测，不以推理代替：

- k3s ServiceLB / hostNetwork 的源 IP 行为（直接决定 §4.3 方案）；
- local-path StorageClass 的实际 `volumeBindingMode` 与 PV 亲和；
- metrics-server 的采集粒度与 HPA 首次扩缩延迟；
- GHCR/TCR 在两台节点的拉取耗时；
- MySQL/Redis 在 k3s 下的正常关停时间与 `terminationGracePeriodSeconds` 取值。

---

## 11. 完成判据（一期）

1. 2 节点 k3s 生产集群稳定运行 ≥ 7 天，无未解释的重启/驱逐。
2. 6 个阻断项全部关闭，14 个高优先级项全部「修复」或按 §8 明确登记。
3. §6.2 的应用回归全绿（2 副本）。
4. 压测达到约定连接数，HPA 扩容生效、缩容不断线。
5. 备份/恢复演练成功；备份新鲜度告警可触发。
6. 迁移夜预演 ≥ 2 次，切换后冒烟全绿。
7. 文档：`docs/ops/k3s-migration.md`、`docs/ops/k3s-runbook.md`、`docs/design.md` §2.2 更新完毕。
