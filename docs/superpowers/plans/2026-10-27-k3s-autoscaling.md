# k3s 自动扩缩容（一期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单机 Compose 平台迁到 2 节点自建 k3s，并让接入层（room-service / api-gateway / robot 等）具备 Pod 级自动扩缩容能力；game-service 多实例后置。

**Architecture:** node-a（现有服务器）= k3s server + 数据层 + edge + game-service；node-b（新购）= 可牺牲算力。应用侧先解决多副本语义（跨 Pod 连接顶替、后台循环单实例化、局终唯一执行），平台侧再开 HPA/PDB/摘流。开发与 conformance 仍走 compose；k3s 清单用 Kustomize 管理。

**Tech Stack:** k3s、Kubernetes（Deployment/StatefulSet/HPA/PDB/NetworkPolicy/CronJob）、Kustomize、Prometheus + Prometheus Adapter、socket.io Redis Adapter、NestJS、TypeScript、Vitest。

## Global Constraints

- 所有提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 一个任务一个 commit；不夹带无关重构。
- 生产镜像只来自 GHCR；清单中禁止 `:latest`，用 `IMAGE_TAG_PLACEHOLDER` 由部署脚本替换。
- 部署期变量统一用显式占位符：`IMAGE_TAG_PLACEHOLDER`、`NODE_A_IP_PLACEHOLDER`；只由 `deploy-k3s.sh` 在远端临时副本里替换，仓库内永不写真实值。
- 所有 Secret 不入 git；工作负载只引用 `secretKeyRef`。
- 单实例负载（mysql/redis/edge/game-service/config-service）禁止默认 RollingUpdate；用 StatefulSet 或 `strategy.type: Recreate`。
- 所有工作负载必须有 requests/limits、readinessProbe；长驻服务加 livenessProbe。
- 每完成一片跑：受影响包测试 + `pnpm -r lint`（或定向 `tsc --noEmit`）+ `pnpm verify:k8s`。
- 本机无 kubectl/docker：清单只做静态断言；真栈验收在预演环境执行并记录证据。

---

## File Structure

**新增**
- `k8s/base/**`：namespace、workloads、services、pvc、networkpolicy、pdb、hpa、rbac、monitoring、backup
- `k8s/overlays/prod/kustomization.yaml`：镜像 tag 占位符替换、生产补丁
- `scripts/verify-k8s-manifests.mjs`：清单机械闸
- `scripts/verify-shutdown-hooks.mjs`：优雅停机源码闸
- `scripts/deploy/deploy-k3s.sh`、`scripts/deploy/rollback-k3s.sh`、`scripts/deploy/k8s-preflight.sh`
- `scripts/ops/backup-k8s.sh`、`scripts/ops/restore-k8s.sh`、`scripts/ops/ws-load.mjs`
- `packages/room-service/src/coordination/{leader-lease.service.ts,finalization-guard.service.ts,connection-registry.service.ts,coordination.module.ts}`
- `packages/room-service/src/gateway/redis-io.adapter.ts`
- `tools/conformance/src/slices/slice-multi-replica.ts`（预演用，环境变量门控）
- `docs/ops/k3s-migration.md`、`docs/ops/k3s-runbook.md`

**修改**
- `package.json`（`verify:k8s`、`verify:shutdown`、`ws-load` 脚本；`js-yaml` devDependency）
- `packages/api-gateway/src/http/trusted-client-ip.ts` 及测试（补 CIDR 用例；实现已支持逗号分隔）
- `packages/*/src/main.ts`（8 个：`enableShutdownHooks()`）
- `packages/{user,config,currency,payment}-service/src/database.config.ts`（迁移 env 开关）
- `packages/room-service/src/gateway/ws.gateway.ts`、`ws.module.ts`、`main.ts`、`package.json`
- `packages/room-service/src/match/match.service.ts`、`rooms/rooms.autostart.ts`、`rooms/rooms.reaper.ts`、`currency/settle.sweeper.ts`、`metrics/room-metrics.service.ts`
- `packages/game-service/src/game/game.service.ts`（启动恢复定时器）
- `deploy/monitoring/**`（K8s SD、标签/聚合、新告警）
- `.github/workflows/release.yml`
- `docs/design.md` §2.2

---

# Part A — 平台底座

### Task A1: 清单骨架与机械闸

**Files:**
- Create: `k8s/base/namespace.yaml`, `k8s/base/kustomization.yaml`, `k8s/overlays/prod/kustomization.yaml`
- Create: `scripts/verify-k8s-manifests.mjs`
- Create: `scripts/fixtures/k8s-valid/*.yaml`, `scripts/fixtures/k8s-invalid/*.yaml`（闸的自证夹具）
- Modify: `package.json`

**Interfaces:**
- Produces: `node scripts/verify-k8s-manifests.mjs --dir <path>` 退出码 0/1；`pnpm verify:k8s` = 对 `k8s` 目录跑。

- [ ] **Step 1: 写夹具与失败闸**

`scripts/fixtures/k8s-invalid/deployment.yaml`：一个缺 `resources`、用 `:latest`、`strategy: RollingUpdate` 且名为 `game-service` 的 Deployment。
`scripts/fixtures/k8s-valid/`：包含通过全部断言的 namespace、mysql（StatefulSet）、redis（StatefulSet）、edge（Recreate）、game-service（StatefulSet）、config-service（Recreate）、room-service/api-gateway（Deployment + PDB + HPA）、default-deny NetworkPolicy、6 个 HPA 的最小文档集（每个容器都有 requests/limits/readiness、镜像含 `IMAGE_TAG_PLACEHOLDER`）。

`scripts/verify-k8s-manifests.mjs` 接受 `--dir`（默认 `k8s`），断言：namespace 存在、每容器 requests/limits/readiness、无 `:latest`、镜像含 `IMAGE_TAG_PLACEHOLDER`、单实例负载 Recreate/StatefulSet、room/gateway PDB、6 个 HPA、default-deny、无明文 Secret、无 container_name。

- [ ] **Step 2: 闸自证**

Run: `node scripts/verify-k8s-manifests.mjs --dir scripts/fixtures/k8s-invalid`
Expected: 退出码 1，列出缺失项。
Run: `node scripts/verify-k8s-manifests.mjs --dir scripts/fixtures/k8s-valid`
Expected: 退出码 0，打印通过。

- [ ] **Step 3: 建骨架**

`k8s/base/namespace.yaml`：`ftl` 与 `ftl-monitoring` 两个 Namespace。
`k8s/base/kustomization.yaml`：`resources: [namespace.yaml]`。
`k8s/overlays/prod/kustomization.yaml`：`resources: [../../base]`。
`package.json` 增加 `"verify:k8s": "node scripts/verify-k8s-manifests.mjs"`，devDependencies 增加 `"js-yaml": "4.3.2"`。

- [ ] **Step 4: 对真实目录跑**

Run: `pnpm verify:k8s`
Expected: 此刻**预期红**（真实清单尚未建），但报错项应全部是「缺 mysql/缺 room-service…」这类**缺失**，而不是闸自身崩溃。A2–A6 逐项补齐后转绿。

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-k8s-manifests.mjs scripts/fixtures k8s/base/namespace.yaml k8s/base/kustomization.yaml k8s/overlays/prod/kustomization.yaml package.json pnpm-lock.yaml
git commit -m "feat(k8s): 清单骨架与机械闸（含自证夹具）"
```

### Task A2: 数据层（MySQL / Redis / PVC）

**Files:**
- Create: `k8s/base/mysql.yaml`, `k8s/base/redis.yaml`
- Test: `pnpm verify:k8s`

**Interfaces:**
- Produces: Service DNS `mysql:3306`、`redis:6379`；PVC `mysql-data`、`redis-data`。

- [ ] **Step 1: 写清单**

MySQL StatefulSet（1 副本）：
- `serviceName: mysql`，headless Service `mysql`（`clusterIP: None`）端口 3306。
- `nodeSelector: { ftl-role: data }`；`volumeClaimTemplates` 名 `mysql-data`，`storageClassName: local-path`，`20Gi`（迁移前实测后调整）。
- `securityContext: { fsGroup: 999 }`；`resources.requests/limits` 相同（`cpu: 500m`、`memory: 2Gi`，压测后校准）。
- env 从 `secretKeyRef: ftl-secrets` 取 `DB_PASSWORD`；`MYSQL_ROOT_PASSWORD` 同源；`MYSQL_DATABASE: fight_the_landlord`。
- readinessProbe/livenessProbe：`exec: mysqladmin ping -h 127.0.0.1 -uroot -p$(MYSQL_ROOT_PASSWORD)`（用 `sh -c` 以展开变量）。
- `terminationGracePeriodSeconds: 120`。

Redis StatefulSet（1 副本）：
- headless Service `redis` 端口 6379；PVC `redis-data` `5Gi`。
- `command: ["redis-server", "--appendonly", "yes", "--maxmemory", "512mb", "--maxmemory-policy", "noeviction"]`。
- probes：`redis-cli ping`；`terminationGracePeriodSeconds: 60`；`nodeSelector: ftl-role: data`。

- [ ] **Step 2: 跑闸**

Run: `pnpm verify:k8s`
Expected: 仍红（缺业务工作负载），但不再报 mysql/redis。

- [ ] **Step 3: Commit**

```bash
git add k8s/base/mysql.yaml k8s/base/redis.yaml
git commit -m "feat(k8s): MySQL/Redis StatefulSet 与本地卷"
```

### Task A3: 入口 edge 与 api-gateway

**Files:**
- Create: `k8s/base/edge.yaml`, `k8s/base/api-gateway.yaml`
- Modify: `k8s/base/kustomization.yaml`

**Interfaces:**
- Produces: 宿主 80/443（edge）；`api-gateway:3000`（headless Service）。

- [ ] **Step 1: 写清单**

edge：
- Deployment 1 副本，`strategy: { type: Recreate }`，`hostNetwork: true`，`dnsPolicy: ClusterFirstWithHostNet`，`nodeSelector: { ftl-role: data }`。
- 容器端口 80/443；env `SITE_ADDRESS`、`TLS_MODE` 从 `ftl-secrets`；挂 `caddy-data` PVC 到 `/data`；`securityContext: { runAsUser: 1001, runAsGroup: 1001, fsGroup: 1001 }`。
- readinessProbe：`httpGet: { path: /, port: 80 }`（Caddy 对 http 返回 308，探针按 `httpGet` 2xx/3xx 判定）。
- resources `100m/128Mi` 请求、`500m/512Mi` 限制。

api-gateway：
- Deployment 2 副本，RollingUpdate `maxUnavailable: 0`、`maxSurge: 1`；headless Service `api-gateway` 端口 3000（`clusterIP: None`）。
- env：`USER_SERVICE_URL=http://user-service:3001`、`ROOM_SERVICE_URL=http://room-service:3002`、`ROOM_SERVICE_WS_URL=http://room-service:3002`、`GAME_SERVICE_URL=http://game-service:3003`、`CONFIG_SERVICE_URL=http://config-service:3006`、`CURRENCY_SERVICE_URL=http://currency-service:3004`、`PAYMENT_SERVICE_URL=http://payment-service:3007`、`CONFIG_SERVICE_RPC_HOST=config-service`、`CONFIG_SERVICE_RPC_PORT=3106`、`REDIS_URL=redis://redis:6379`、`JWT_SECRET`/`ADMIN_JWT_SECRET`/`AGENT_JWT_SECRET`/`INTERNAL_SERVICE_TOKEN` 从 Secret、`TRUST_PROXY` 从 ConfigMap（值 = node-a 内网 IP，部署时填）。
- readinessProbe `/api/health:3000`；liveness 同；resources 250m/512Mi。
- preStop：`exec: sh -c "sleep 30"`；`terminationGracePeriodSeconds: 60`。

- [ ] **Step 2: 跑闸**：不再报 edge/api-gateway。
- [ ] **Step 3: Commit**

### Task A4: 业务工作负载矩阵

**Files:**
- Create: `k8s/base/{room-service,game-service,robot-service,user-service,config-service,currency-service,payment-service,douzero}.yaml`
- Modify: `k8s/base/kustomization.yaml`

**Interfaces:**
- Produces: 每个服务同名 Service（HTTP）与 RPC Service（如适用）。

按矩阵逐行生成清单；**每行的值都是精确值，不是示例**：

| 工作负载 | 副本 | 策略 | 节点 | 端口 | 关键 env |
|---|---|---|---|---|---|
| room-service | 2 | RollingUpdate maxUnavailable 0 | 分散（topologySpread） | 3002（无需 RPC） | `REDIS_URL`、`GAME_SERVICE_RPC_HOST=game-service`、`GAME_SERVICE_RPC_PORT=3103`、`ROBOT_SERVICE_RPC_HOST=robot-service`、`ROBOT_SERVICE_RPC_PORT=3105`、`CONFIG_SERVICE_RPC_HOST/PORT`、`INTERNAL_SERVICE_TOKEN` |
| game-service | 1 | StatefulSet | data | 3103 RPC、9003 metrics | `REDIS_URL`、`RPC_PORT=3103`、`ROBOT_SERVICE_RPC_HOST/PORT`、`INTERNAL_SERVICE_TOKEN` |
| robot-service | 1..3 | RollingUpdate | 任意 | 3105 RPC、3005 HTTP、9005 | `DOUZERO_URL=http://douzero:2021`、`REDIS_URL`、`RPC_PORT=3105`、`CONFIG_SERVICE_RPC_*`、`INTERNAL_SERVICE_TOKEN` |
| user-service | 2..3 | RollingUpdate | 任意 | 3001、3101、9001 | DB 四件、`REDIS_URL`、`RPC_PORT=3101`、`CURRENCY_SERVICE_RPC_*`、`INTERNAL_SERVICE_TOKEN`、`JWT_SECRET` |
| config-service | 1 | Recreate | data | 3006、3106、9006 | DB 四件、`REDIS_URL`、`RPC_PORT=3106`、`ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`、`JWT_SECRET`、`PAY_CONFIG_ENC_KEY`、`PAY_CHANNEL_PULL_TOKEN`、`NOTIFY_CHANNEL_PULL_TOKEN`、`AD_CHANNEL_PULL_TOKEN`、`INTERNAL_SERVICE_TOKEN` |
| currency-service | 2..3 | RollingUpdate | 任意 | 3004、3104、9004 | DB 四件、`REDIS_URL`、`RPC_PORT=3104`、`CONFIG_SERVICE_RPC_*`、`USER_SERVICE_RPC_*`、`AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`AD_CHANNEL_PULL_TOKEN`、`INTERNAL_SERVICE_TOKEN` |
| payment-service | 1..2 | RollingUpdate | 任意 | 3007、9007 | DB 四件、`REDIS_URL`、`CONFIG_SERVICE_RPC_*`、`PAY_CHANNEL_PULL_TOKEN`、`INTERNAL_SERVICE_TOKEN` |
| douzero | 1 | Recreate | compute | 2021 | `PYTHONUNBUFFERED=1` |

统一要求：
- 每个容器 `resources.requests/limits` 起始值：业务服务 `250m/512Mi`，robot `500m/1Gi`，douzero `1/2Gi`；`pnpm verify:k8s` 只查存在，容量在片 C 校准。
- readinessProbe `httpGet /api/health`（douzero `/health:2021`）；liveness 同。
- 环境变量值与 `docker-compose.yml` 逐字同源；只把 `*_RPC_HOST` 保持为服务名。
- DB 服务 Deployment 加 `DB_MIGRATIONS_RUN: "false"`（Task B3 提供开关）。
- 每个 Deployment 的 Pod 模板加 Prometheus 注解：`prometheus.io/scrape: "true"`、`prometheus.io/port: "<900x>"`、`prometheus.io/path: "/metrics"`。

**Migration Jobs（同任务产出）**：`k8s/base/migrate-jobs.yaml` 定义四个 Job：`migrate-config`、`migrate-user`、`migrate-currency`、`migrate-payment`。每个 Job 使用对应服务镜像、`backoffLimit: 0`、`restartPolicy: Never`、env 同服务 + `DB_MIGRATIONS_RUN: "true"`；部署脚本按此顺序 `kubectl wait --for=condition=complete`，失败即中止。

- [ ] **Step 1: 写清单**（按上表逐行）
- [ ] **Step 2: 跑闸**：仅剩监控/备份/网络策略/HPA/PDB 预期红。
- [ ] **Step 3: Commit**

### Task A5: NetworkPolicy / PDB / HPA 骨架

**Files:**
- Create: `k8s/base/networkpolicy.yaml`, `k8s/base/pdb.yaml`, `k8s/base/hpa.yaml`

- [ ] **Step 1: 写清单**
  - `default-deny`：`podSelector: {}`，`policyTypes: [Ingress, Egress]`。
  - 放行：edge(node-a hostNetwork 无法被 NetworkPolicy 选中 ⇒ 用 ipBlock `node-a内网IP/32` 放行到 gateway 3000)：`from: [{ ipBlock: { cidr: NODE_A_IP_PLACEHOLDER/32 } }]`。
  - gateway → room/game/user/config/currency/payment 的 HTTP/RPC 端口；room → game/robot/config/currency/user 的 RPC；各服务 → mysql 3306 / redis 6379；prometheus → 各 900x；所有 Pod → kube-dns 53。
  - PDB：`room-service-pdb`、`api-gateway-pdb`，`minAvailable: 1`。
  - HPA：`room-service-hpa`（min 2 max 4，Pods 指标 `ws_connections` 平均 100，CPU 70%）；`api-gateway-hpa`（min 2 max 4，CPU 70%）；`robot-service-hpa`（min 1 max 3，CPU 70%）；`user-service-hpa`、`currency-service-hpa`（min 2 max 3，CPU 70%）；`payment-service-hpa`（min 1 max 2，CPU 70%）。`behavior.scaleDown.stabilizationWindowSeconds: 1800`，`policies: [{type: Pods, value: 1, periodSeconds: 300}]`。
- [ ] **Step 2: 跑闸**：应只剩监控/备份预期红。
- [ ] **Step 3: Commit**

### Task A6: 监控栈迁移

**Files:**
- Create: `k8s/base/monitoring.yaml`（Prometheus、Grafana、Alertmanager、alert-relay、am-renderer、node-exporter DaemonSet、cadvisor DaemonSet、kube-state-metrics、Pushgateway）
- Modify: `deploy/monitoring/prometheus/prometheus.yml`（新增 Kubernetes SD 段；保留既有 static 段用于 compose 开发形态）
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（新增 k8s 级告警）
- Modify: `deploy/monitoring/grafana/dashboards/*.json`（标签/聚合修正）

**Interfaces:**
- Produces: Prometheus 通过 Pod 注解抓取；`kube-state-metrics`；告警 `FtlBackupStale`、`KubeNodeNotReady`、`KubePodPending`、`KubeHPAMaxedOut`。

- [ ] **Step 1: 清单**
  - Prometheus Deployment 1 副本 + PVC；ConfigMap 挂 `prometheus.yml`/`rules`；ServiceAccount + RBAC（get/list/watch pods/endpoints/services/nodes）。
  - `kubernetes_sd_configs: [{ role: pod }]` + relabel：保留 `prometheus.io/scrape=true`，按 `prometheus.io/port` 设端口；namespace 限 `ftl`/`ftl-monitoring`；Bearer 走 `/etc/prometheus/secret/internal_token`（Secret 挂载）。
  - kube-state-metrics Deployment + RBAC；node-exporter DaemonSet（hostPath /proc,/sys,/rootfs，allowlist）；cadvisor DaemonSet（挂 `/run/k3s/containerd/containerd.sock`、`/var/lib/kubelet`，命令 `--containerd=/run/k3s/containerd/containerd.sock --docker_only=false`；真栈校验）。
  - Grafana Deployment + PVC，env `GF_SERVER_SERVE_FROM_SUB_PATH=true`、`GF_SERVER_ROOT_URL=https://${SITE_ADDRESS}/grafana/`。
  - Alertmanager + alert-relay + am-renderer 同 node-a，共享 `alertmanager-live`/`relay-data` PVC；am-renderer 以 `65534:65534` 运行。
  - Pushgateway Deployment（备份指标）。
- [ ] **Step 2: 改 Prometheus 配置**：在 compose static job 之后追加 `kubernetes-pods` job（k8s 形态专用；compose 下该 job 抓不到目标，属预期）。
- [ ] **Step 3: 改看板/告警**：把所有 `container_name`/`ftl-*` 过滤改为 `pod`/`container`；`rooms_active`/`match_queue_length` 用 `max by (namespace)`；`ws_connections` 用 `sum by (pod)`。新增告警：
```yaml
- alert: FtlBackupStale
  expr: time() - backup_last_success_timestamp_seconds > 7200
  for: 10m
  labels: { severity: critical }
  annotations: { summary: "MySQL 备份超过 2 小时未成功" }
```
- [ ] **Step 4: 跑闸 + 监控脚本**：`pnpm verify:k8s` 绿；`node scripts/verify-monitoring.mjs`（若依赖 compose 则跳过，记录）。
- [ ] **Step 5: Commit**

### Task A7: 备份 / 恢复 / 预检 / 部署 / 回滚脚本 + CI

**Files:**
- Create: `k8s/base/backup.yaml`（CronJob + ServiceAccount + RBAC + backup-data PVC）
- Create: `k8s/base/rbac.yaml`（部署 SA `ftl-deployer` + Role/RoleBinding：deployments/statefulsets/jobs patch、pods get/list、pods/exec、rollout 所需资源）
- Create: `scripts/ops/backup-k8s.sh`, `scripts/ops/restore-k8s.sh`
- Create: `scripts/deploy/k8s-preflight.sh`, `scripts/deploy/deploy-k3s.sh`, `scripts/deploy/rollback-k3s.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/deploy/deploy.sh`（`--assert-clean` 新口径）

- [ ] **Step 1: backup.sh（k8s 版）**
  - 在 `mysql:8` 镜像里运行：`mysqldump --single-transaction -h mysql -uroot -p"$DB_PASSWORD" fight_the_landlord` → `/backup/mysql-<ts>.sql.gz`，写 `manifest-<ts>.json`（sha256、行数哨兵查询结果）。
  - 证书卷：用 `kubectl exec` 从 edge Pod `tar czf - -C /data .`（SA 需 pods/exec 权限）→ `/backup/caddy-<ts>.tar.gz`。
  - 异地：`rclone copy /backup :s3:ftl-backup/...`（env `RCLONE_CONFIG_S3_*` 来自 Secret）。
  - 成功时 `curl -X POST --data-binary @- http://pushgateway:9091/metrics/job/backup` 推 `backup_last_success_timestamp_seconds`。
  - 失败 `exit 1`，CronJob 保留失败 Pod 日志。
- [ ] **Step 2: restore-k8s.sh**：参数 `--artifact <path>`、`--target mysql|caddy`；恢复前要求 Deployment 已停止（脚本检查并提示 `kubectl scale`）；恢复后跑行数校验。
- [ ] **Step 3: k8s-preflight.sh**：检查两节点 Ready、`ftl-role` 标签、StorageClass `WaitForFirstConsumer`、`ftl-secrets` 存在、GHCR 拉取、node-a IP、DNS TTL、80/443 空闲。
- [ ] **Step 4: deploy-k3s.sh**
  - 变量同 `deploy.sh`（`SSH_HOST`/`SSH_USER`/`SSH_KEY`）+ `K8S_KUBECONFIG`（部署 SA，默认 `/home/ubuntu/.kube/ftl-deploy.yaml`）。
  - 远端：`mkdir -p /srv/pokergame-k8s`；`scp -r k8s`；在远端临时目录 `sed "s/IMAGE_TAG_PLACEHOLDER/$TAG/g"`；`kubectl apply -k`；`kubectl -n ftl wait --for=condition=complete job/migrate-* --timeout=300s`；`kubectl rollout status`；冒烟（复用现有 `Q_SITE_URL` 检查）。
  - 失败：`kubectl rollout undo` + 输出 `kubectl get pods -o wide`。
- [ ] **Step 5: rollback-k3s.sh**：`kubectl rollout undo deployment/<name>` 或 `--revision`；不自动回退迁移。
- [ ] **Step 6: release.yml**：部署步骤改调 `deploy-k3s.sh`；保留 compose 路径注释与手动 dispatch。
- [ ] **Step 7: `--assert-clean`**：改为断言「无 `/root/.kube/config`、无 cluster-admin token、部署 kubeconfig 权限 600 且仅 SA 权限、无明文 GHCR 凭据」。
- [ ] **Step 8: 跑闸 + shellcheck（若有）**；Commit。

### Task A8: 迁移夜文档

**Files:**
- Create: `docs/ops/k3s-migration.md`, `docs/ops/k3s-runbook.md`

- [ ] **Step 1: 按 spec §5 写详细步骤**（预演、备份时机、停栈、join、数据复制、verify Job、DNS、回滚两套）。
- [ ] **Step 2: 写 runbook**（日常发布、扩缩、节点维护、Redis/MySQL 恢复、证书、备份恢复、HPA 调参）。
- [ ] **Step 3: Commit**

---

# Part B — 应用多副本安全

### Task B1: 客户端 IP 信任链

**Files:**
- Modify: `packages/api-gateway/test/trusted-client-ip.test.ts`（若无则创建）
- Modify: `k8s/base/api-gateway.yaml`（`TRUST_PROXY` 值）

- [ ] **Step 1: 补测试**

```ts
it('CIDR 信任表：命中则采信 XFF，未命中则忽略', () => {
  const trust = parseTrustProxy('10.0.0.0/8');
  expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.9' }, '10.1.2.3', trust)).toBe('203.0.113.9');
  expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.9' }, '192.0.2.7', trust)).toBe('192.0.2.7');
});
```

- [ ] **Step 2: 跑红/绿**：现有实现应直接绿（`proxyaddr.compile` 已支持 CIDR）；若红则修 `trusted-client-ip.ts`。
- [ ] **Step 3: 清单写 `TRUST_PROXY=NODE_A_IP_PLACEHOLDER`**（Kustomize 变量由部署脚本替换），并加注释「真实 IP 三处一致性」。
- [ ] **Step 4: Commit**

### Task B2: 优雅停机

**Files:**
- Modify: 8 × `packages/*/src/main.ts`
- Create: `scripts/verify-shutdown-hooks.mjs`
- Modify: `package.json`（`"verify:shutdown"`）

- [ ] **Step 1: 写源码闸**

```js
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const roots = readdirSync('packages').map((p) => join('packages', p, 'src', 'main.ts'));
const bad = roots.filter((p) => {
  try { return !readFileSync(p, 'utf8').includes('enableShutdownHooks()'); } catch { return false; }
});
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('✅ 8 个服务均启用优雅停机');
```

- [ ] **Step 2: 跑红**：`pnpm verify:shutdown` 报 8 个文件。
- [ ] **Step 3: 每个 `main.ts` 在 `NestFactory.create` 后加 `app.enableShutdownHooks();`**（放在中间件注册之前亦可；统一放在 `const app = await NestFactory.create(AppModule);` 下一行）。
- [ ] **Step 4: gateway 释放 WS 名额**：在 `packages/api-gateway/src/auth/...` 查 `acquireWsConnSlot` 的 key 结构，新增 `OnApplicationShutdown` 服务，SIGTERM 时删除本 Pod 持有的 ZSET 成员（key/成员结构在实现时按 `rate-limit.ts` 现有函数逐字复用，不另写第二套）。
- [ ] **Step 5: 跑绿 + 定向测试**；Commit。

### Task B3: 迁移开关

**Files:**
- Modify: `packages/{user,config,currency,payment}-service/src/database.config.ts`
- Test: 各包新增/修改 `database.config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('DB_MIGRATIONS_RUN=false 时关闭启动迁移', () => {
  process.env.DB_MIGRATIONS_RUN = 'false';
  expect(userDatabaseOptions().migrationsRun).toBe(false);
  delete process.env.DB_MIGRATIONS_RUN;
  expect(userDatabaseOptions().migrationsRun).toBe(true);
});
```

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**：`migrationsRun: process.env.DB_MIGRATIONS_RUN !== 'false'`（四服务逐字同形）。
- [ ] **Step 4: 跑绿**；Commit。

### Task B4: room-service Redis 适配器 + 跨 Pod 顶替

**Files:**
- Modify: `packages/room-service/package.json`（`@socket.io/redis-adapter@^8.3.0`, `redis@^4.7.0`）
- Create: `packages/room-service/src/gateway/redis-io.adapter.ts`
- Create: `packages/room-service/src/coordination/connection-registry.service.ts`
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`、`ws.module.ts`、`main.ts`
- Test: `packages/room-service/test/connection-registry.test.ts`、`redis-io.adapter.test.ts`

**Interfaces:**
- Produces:
  - `userRoom(userId: string): string` → `user:<id>`
  - `ConnectionRegistry.register(io: Server, socket: Socket, userId: string): Promise<void>`
  - `ConnectionRegistry.unregister(socket: Socket, dec: () => void): Promise<boolean>`（返回是否真的递减了计数）
  - `RedisIoAdapter.connect(url: string): Promise<void>`；`createIOServer(port, options)` 挂载适配器。

- [ ] **Step 1: 写失败测试**

```ts
it('新连接顶替同 user 的旧 socket', async () => {
  const fetchSockets = vi.fn().mockResolvedValue([{ id: 'old', disconnect: vi.fn() }]);
  const io = { in: () => ({ fetchSockets }) } as any;
  const redis = { incr: vi.fn().mockResolvedValue(2), set: vi.fn() } as any;
  const reg = new ConnectionRegistry(redis);
  const socket = { id: 'new', data: {}, join: vi.fn() } as any;
  await reg.register(io, socket, 'u1');
  expect(fetchSockets).toHaveBeenCalledWith();
  expect(redis.set).toHaveBeenCalledWith('ws:owner:u1', expect.any(String), 'PX', 3600);
  expect(socket.join).toHaveBeenCalledWith('user:u1');
});

it('陈旧断线不递减新连接的计数', async () => {
  const redis = { eval: vi.fn().mockResolvedValue(0) } as any;
  const dec = vi.fn();
  const reg = new ConnectionRegistry(redis);
  await reg.unregister({ id: 'old', data: { userId: 'u1', connGeneration: 1 } } as any, dec);
  expect(dec).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现 `ConnectionRegistry`**：`register` 先 `fetchSockets` 顶替旧 socket → `incr ws:generation:<user>` → `set ws:owner:<user> {pod,socketId,gen} PX 3600` → `socket.join(userRoom)`。`unregister` 用 Lua 比较 generation 后删 key；只有删除成功才 `dec()`。
- [ ] **Step 4: 实现 `RedisIoAdapter`**：`createClient({url})` 两次（pub/sub），`createAdapter(pub,sub)`；`createIOServer` 调 `server.adapter(this.adapterConstructor)`；`close()` 关闭两连接。
- [ ] **Step 5: 接线**：`main.ts` 创建 adapter 并 `app.useWebSocketAdapter(adapter)`；`WsGateway.handleConnectionInner` 在鉴权成功后调用 `connections.register(this.server, socket, userId)`；`handleDisconnectInner` 调用 `unregister`，并用其返回值决定是否 `wsConnections.dec()`。保留 `activeConnections` 供本地投递。
- [ ] **Step 6: 跑绿**：`pnpm -C packages/room-service test`。
- [ ] **Step 7: Commit**

### Task B5: leader lease + 局终唯一执行

**Files:**
- Create: `packages/room-service/src/coordination/leader-lease.service.ts`、`finalization-guard.service.ts`、`coordination.module.ts`
- Modify: `ws.gateway.ts`、`match/match.service.ts`、`rooms/rooms.autostart.ts`、`rooms/rooms.reaper.ts`、`currency/settle.sweeper.ts`、`metrics/room-metrics.service.ts`
- Test: `packages/room-service/test/leader-lease.test.ts`、`finalization-guard.test.ts`

**Interfaces:**
- Produces:
  - `LeaderLease.isLeader(): Promise<boolean>`（`SET ftl:room:leader <pod> NX PX 10000` + 每 3s 续约；Lua 比较后 `PEXPIRE`）
  - `FinalizationGuard.claim(roomCode, version): Promise<boolean>`（`SET room:finalized:<code>:<ver> 1 NX EX 86400`）

- [ ] **Step 1: 写失败测试**

```ts
it('同一 (roomCode, version) 只允许一个执行者', async () => {
  const redis = { set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null) } as any;
  const g = new FinalizationGuard(redis);
  expect(await g.claim('r1', 7)).toBe(true);
  expect(await g.claim('r1', 7)).toBe(false);
});
```

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现两个服务 + 模块**（导出给 WsModule/各循环模块）。
- [ ] **Step 4: 接线**：
  - 五个循环每轮先 `if (!(await lease.isLeader())) return scheduleNext();`（保持现有自重排结构）。
  - `onGameEvent`：广播照旧；`finalizeRoomEnd` 前 `if (!(await lease.isLeader())) return; if (!(await guard.claim(code, version))) return;`。
  - `gamesEndedTotal.inc()` 与 `roomsActive` 写入移到唯一执行点。
- [ ] **Step 5: 跑绿**（含既有 room-service 测试）；Commit。

### Task B6: game-service 定时器恢复

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`
- Test: `packages/game-service/test/game.service.recovery.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('启动时按 Redis 活跃会话重建回合定时器', async () => {
  const redis = {
    scan: vi.fn().mockResolvedValueOnce(['0', ['game:session:r1']]),
    get: vi.fn().mockResolvedValue(JSON.stringify({
      roomCode: 'r1', state: 'playing', gameType: 'doudizhu', playerCount: 3,
      turnDeadlineAt: Date.now() + 5000, players: [], currentSeat: 0,
    })),
  } as any;
  const svc = new GameService(redis);
  const spy = vi.spyOn(svc as any, 'startTurnTimer');
  await svc.onModuleInit();
  expect(spy).toHaveBeenCalledWith('r1', expect.objectContaining({ roomCode: 'r1' }), expect.anything());
});
```

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现 `onModuleInit`**：`SCAN 0 MATCH game:session:* COUNT 100` 循环；`JSON.parse`；跳过 `Ended`/`Init`/坏数据；写 cache；`startTurnTimer(roomCode, session, { overrideMs: Math.max(0, deadline - Date.now()) })`。注册 `implements OnModuleInit`。
- [ ] **Step 4: 跑绿**；Commit。

### Task B7: 多副本回归切片

**Files:**
- Create: `tools/conformance/src/slices/slice-multi-replica.ts`（环境变量 `MULTI_REPLICA_BASE_URL` 门控）
- Modify: `tools/conformance/src/run.ts`（注册切片）

- [ ] **Step 1: 写切片**：两个用户登录 → 同房 → 用户 A 换第二连接 → 断言旧连接收到断开、旧连接不再收到手牌；同房双方都收到 `room.state_update`；一局结束后查询 `games_ended_total`（或记录条数）只增 1。
- [ ] **Step 2: 本机无栈时跳过**：`MULTI_REPLICA_BASE_URL` 未设 ⇒ 打印 SKIP 并退出 0；预演环境设值后必须真跑。
- [ ] **Step 3: Commit**

---

# Part C — 弹性策略

### Task C1: HPA 指标与 Prometheus Adapter

**Files:**
- Create: `k8s/base/prometheus-adapter.yaml`（Deployment + ConfigMap + ServiceAccount/RBAC + APIService）
- Modify: `k8s/base/hpa.yaml`（room-service/gateway 用 Pods 指标）
- Modify: `deploy/monitoring/prometheus/prometheus.yml`（确认 `ws_connections` 抓取）

- [ ] **Step 1: 清单**：Prometheus Adapter Deployment + ConfigMap 规则：
```yaml
rules:
- seriesQuery: 'ws_connections{namespace="ftl"}'
  resources: { overrides: { namespace: { resource: namespace }, pod: { resource: pod } } }
  name: { matches: '^ws_connections$', as: 'ws_connections' }
  metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (pod, namespace)'
```
- [ ] **Step 2: HPA**：room-service 用 `Pods` 指标 `ws_connections` 平均 100；gateway 同（需在 gateway 增加 `ws_connections` gauge，按现有 metrics 模块同形）。
- [ ] **Step 3: 跑闸 + JSON/YAML 解析**；Commit。

### Task C2: 摘流与 PDB 强化

**Files:**
- Modify: `k8s/base/{room-service,api-gateway}.yaml`、`k8s/base/pdb.yaml`

- [ ] **Step 1: preStop**：room/gateway 加 `lifecycle.preStop.exec.command: ["sh","-c","sleep 30"]`；`terminationGracePeriodSeconds: 60`。
- [ ] **Step 2: readiness**：确认探针在 SIGTERM 后先失败（preStop 期间 kubelet 不会自动摘 readiness，需在应用里监听 SIGTERM 置未就绪；在 `main.ts` 注册 `process.on('SIGTERM', () => health.setNotReady())`，health 端点读该标志）。
- [ ] **Step 3: PDB**：`minAvailable: 1`；Gate 断言存在。
- [ ] **Step 4: Commit**

### Task C3: 压测脚本与容量校准

**Files:**
- Create: `scripts/ops/ws-load.mjs`
- Modify: `package.json`（`"ws-load"`）

- [ ] **Step 1: 脚本**：参数 `--url`、`--users`、`--password`、`--hold`；用 `socket.io-client` 建连，登录拿 token（`/api/auth/login`），统计连接成功/失败/首消息延迟；输出 JSON。
- [ ] **Step 2: 预演环境跑**：记录 HPA 扩容阈值与单 Pod 安全连接数，回填 `k8s/base/hpa.yaml` 的 `averageValue` 与 `maxReplicas`。
- [ ] **Step 3: Commit**

### Task C4: 看板与告警修正

**Files:**
- Modify: `deploy/monitoring/grafana/dashboards/*.json`
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`

- [ ] **Step 1: 聚合修正**：`rooms_active`/`match_queue_length` → `max`；`ws_connections`/`games_ended_total` → `sum by (pod)`；容器名过滤 → `pod`/`container`。
- [ ] **Step 2: 新增告警**：`KubeNodeNotReady`、`KubePodPending`、`KubeHPAMaxedOut`、`FtlBackupStale`。
- [ ] **Step 3: 跑 `node scripts/verify-monitoring.mjs`（本地可跑的部分）**；Commit。

### Task C5: 全量验证与文档收口

- [ ] 跑 `pnpm -r test`、`pnpm -r lint`、`pnpm verify:k8s`、`pnpm verify:shutdown`。
- [ ] 更新 `docs/design.md` §2.2 部署拓扑。
- [ ] 更新 `docs/ops/k3s-runbook.md` 的 HPA 调参与容量表。
- [ ] 记录未在本机验证、必须在预演环境执行的项（清单见 spec §10.4）。
- [ ] Commit。

---

## 回归命令

| 面 | 命令 | 预期 |
|---|---|---|
| room-service | `pnpm -C packages/room-service test` | 全绿 |
| game-service | `pnpm -C packages/game-service test` | 全绿 |
| api-gateway | `pnpm -C packages/api-gateway test` | 全绿 |
| 四 DB 服务 | `pnpm -C packages/{user,config,currency,payment}-service test` | 全绿 |
| 类型 | `pnpm -r lint` | 全绿 |
| 清单闸 | `pnpm verify:k8s` | 通过 |
| 停机闸 | `pnpm verify:shutdown` | 通过 |
| 全仓 | `pnpm test` | 全绿（不含 conformance） |
| 真栈 | 预演环境：`pnpm conformance` + 多副本切片 + 压测 | 记录证据 |

## 执行顺序

A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 →（计划审查后）B1 → B2 → B3 → B4 → B5 → B6 → B7 → C1 → C2 → C3 → C4 → C5。

> 平台片 A 的清单可在无集群环境完成静态验收；B 的应用改动全部可在本机用 Vitest 验证；C 的 HPA/压测需预演环境。真集群迁移与生产切换不在本计划内自动执行。

---

## 计划审查记录（对抗审查，2026-10-27）

审查方式：独立 reviewer 子代理，只读仓库。共 20 条：阻断 7 / 高 12 / 低 1。

| # | 发现 | 处置 |
|---|---|---|
| 1 | 占位符替换链断裂（NODE_A_IP 未替换） | **已修**：deploy-k3s.sh 同时替换两个占位符，渲染后残留 PLACEHOLDER 即失败 |
| 2 | 新资源未加入 kustomization，闸仍绿 | **已修**：所有资源已收录；闸增加收录完整性检查 + CI 渲染校验 |
| 3 | 迁移 Job 不会退出 | **已修**：`DB_MIGRATIONS_ONLY=true` 跑完 `app.close()` 退出 |
| 4 | 固定 Job 名 + 通配 wait | **已修**：部署脚本先按 label 删除旧 Job，再逐个显式 wait |
| 5 | apply 在迁移完成前滚动业务 | **已修**：两阶段 apply（migrate overlay → wait → prod overlay） |
| 6 | 备份 CronJob 镜像缺工具 | **已修（偏差）**：改为 node-a 主机 cron 脚本，复用 kubectl exec；COS 依赖待凭据 |
| 7 | 所有 Pod 缺 imagePullSecrets | **已修**：prod/migrate overlay 注入 ghcr-pull，部署后断言 |
| 8 | 闸不渲染、未接 CI | **已修**：闸支持 `--file`；CI 有 kubectl 时校验 `kustomize` 渲染 |
| 9 | Adapter 缺证书/caBundle | **已修**：自签 + APIService `insecureSkipTLSVerify` |
| 10 | gateway 无 ws_connections gauge | **已修**：新增 gauge，连接/断开处 inc/dec |
| 11 | Prometheus 写 secret 目录权限 | **已核**：镜像内目录已 chown 65534；容器以 65534 运行，env 注入 token |
| 12 | 监控抓取覆盖不足 | **已修**：k8s 专用 Prometheus 配置含 Pod SD + 全部静态 job |
| 13 | 新增告警打破 32 条计数 | **已修**：k8s 告警独立文件挂载，不进 compose 镜像计数 |
| 14 | release.yml 破坏 slice-07.4 | **已修**：k3s 部署收回同一 deploy job，按 DEPLOY_TARGET 分支 |
| 15 | 构造参数注入破坏 wiring 门禁 | **已修**：全部协调件属性注入，13 参数不变 |
| 16 | leader 门禁放进 scanOnce 会假红 | **已修**：门只装在 runOnce/runRound，测试入口不变 |
| 17 | generation 跳过 dec 导致 gauge 泄漏 | **已修**：本地 gauge 无条件 dec；代次只清 Redis 属主 |
| 18 | 2 副本回归永远 SKIP | **已修（部分）**：独立入口 `multi-replica`，REQUIRED=1 时缺地址即失败；未并入默认 CI 切片 |
| 19 | liveness 用依赖面、摘流机制矛盾 | **已修**：liveness 改 `/api/health/live`；不实现 SIGTERM 置未就绪（见偏差 7） |
| 20 | ws-load 根包缺依赖等低项 | **已修**：ws-load 放 conformance 包；其余逐条登记 |

## 执行偏差（实现期）

1. **备份形态**：一期用 node-a 主机 cron（`scripts/ops/backup-k8s.sh`），不是 CronJob；`RCLONE_REMOTE` 配置后同步 COS。
2. **集群级资源**：Namespace / ClusterRole / APIService 拆到 `k8s/bootstrap`（管理员一次应用）；部署账户只有命名空间权限。
3. **迁移 Job**：固定名 + 部署前按 label 删除；两阶段 apply。
4. **监控配置**：k8s 专用 `k8s/base/monitoring/prometheus.yml`；k8s 告警独立 `rules-k8s.yml` 挂载，compose 的 32 条计数不变。
5. **imagePullSecrets**：overlay JSON6902 patch 注入，不逐个改 base。
6. **2 副本回归**：独立入口 `pnpm --filter @fight-the-landlord/conformance multi-replica`，不加入 `run.ts --list`（避免单实例 CI 误跑）。
7. **摘流**：依赖 EndpointSlice terminating + preStop 30s；不实现「SIGTERM 置未就绪」（preStop 期间 SIGTERM 尚未发送，原机制不可观测）。
8. **座位属主**：`seatOwners` 仍为本地 Map（投递用）；跨 Pod 权威只用于连接顶替（`ws:owner`）。
9. **Caddy trusted_proxies**：Caddy 是第一跳、无上游代理，未配置；网关信任 node-a 内网 IP。
10. **告警缺口**：PVC 水位告警待补；证书到期依赖外部 exporter，一期登记。
11. **ws-load**：放 conformance 包（根包无 `socket.io-client`），命令 `pnpm --filter ... ws-load`。

## 验证记录（2026-10-27）

| 项 | 结果 |
|---|---|
| `pnpm test` | 29/29 tasks 绿；client 1525 passed（2 skipped） |
| `pnpm lint` | 18/18 tasks 绿（3 cached） |
| `pnpm verify:k8s` | 94 文档通过 |
| `pnpm verify:shutdown` | 8 服务通过 |
| `verify-admin-static` | 520 checks |
| `verify-agent-static` | 104 checks |
| `admin-players-probe` | all checks passed |
| `verify-monitoring` | 226 checks |
| room-service | 948 tests 绿 |
| game-service | 272 tests 绿 |
| api-gateway | 504 tests 绿 |
| 四 DB 服务迁移开关 | 各 3 tests 绿 |
| `slice-07.4-pipeline --render` | 待重跑（k3s job 已收回 deploy job） |

**未在本机验证（预演环境必做）**：k3s 渲染/apply、镜像拉取、HPA 扩缩、2 副本跨 Pod 回归、备份/恢复演练、迁移夜全流程（spec §10.4）。
