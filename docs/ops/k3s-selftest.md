# k3s 自动扩缩容 · 自测清单

> 配套：`docs/ops/k3s-migration.md`、`docs/ops/k3s-runbook.md`。
> 原则：**能在本机测的不要拖到服务器；必须在真集群测的不要假装本机能测。**

## A. 本机（Windows，无 Docker/kubectl 也能跑）

```bash
# 1) 全仓测试 + 类型检查 + 真构建
pnpm test
pnpm lint
pnpm exec turbo run build --force     # 必须 --force，Cached 不算真跑

# 2) 新增的静态闸
pnpm verify:k8s                       # 清单结构/收录完整性/单实例策略/PDB/HPA
pnpm verify:shutdown                  # 8 个服务都启用优雅停机
node scripts/verify-monitoring.mjs
node scripts/verify-admin-static.mjs
node scripts/verify-agent-static.mjs
node scripts/admin-players-probe.mjs

# 3) 闸的自证（负样本必须红、正样本必须绿）
node scripts/verify-k8s-manifests.mjs --dir scripts/fixtures/k8s-invalid   # 期望 exit 1
node scripts/verify-k8s-manifests.mjs --dir scripts/fixtures/k8s-valid     # 期望 exit 0

# 4) 流水线接线（纯渲染，不需要栈）
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-07.4-pipeline --render
```

可选：装 `kubectl`（`winget install -e --id Kubernetes.kubectl`）后做渲染检查：

```bash
kubectl kustomize k8s/overlays/prod > /tmp/ftl-k8s.yaml
node scripts/verify-k8s-manifests.mjs --file /tmp/ftl-k8s.yaml
```

预期：所有命令绿；`verify:k8s` 会打印 99 个文档通过。

## B. 有 Docker 的测试机（应用回归）

```bash
docker compose up -d
docker compose --profile edge up -d edge
pnpm --filter @fight-the-landlord/conformance build
pnpm conformance                      # 既有全量联调（单实例）
```

⚠️ 单实例 compose **测不出**跨 Pod 顶替/广播；这些必须去 C 段。应用侧逻辑已由单测覆盖：
`room-service` 948、`game-service` 272、`api-gateway` 504。

为 k3s 预演构建**当前分支**镜像（不能直接用线上 tag —— 它们不含本分支代码）：

```bash
docker login ghcr.io
CACHE=0 IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord PUSH=1 \
  bash scripts/deploy/build-images.sh "sha-$(git rev-parse --short HEAD)"
```

## C. 预演环境（单节点 k3s 也能完整测 HPA）

> **单节点完全能扩缩容**：HPA 不要求多节点。我们之前只把节点角色写成同一个标签键的
> 两个值，现已拆成 `ftl-data` / `ftl-compute` 两个独立键 ⇒ 一台机器可以同时带两个标签。
> 单节点限制只有两条：容量上限（HPA 扩出的 Pod 可能 Pending）和「node-b 关机」这类
> 多节点故障演练做不了；跨 Pod 广播/顶替仍可测（不同 Pod 进程）。

1. 一台 Linux 机器（建议 8C16G；Windows 用 WSL2/VM）装单节点 k3s：

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --disable traefik --secrets-encryption --node-name node-a" sh -
kubectl label node node-a ftl-data=true ftl-compute=true
```

2. 一次性 bootstrap + 双命名空间 Secret：

```bash
kubectl apply -k k8s/bootstrap
# ftl 与 ftl-monitoring 各建 ftl-secrets 与 ghcr-pull（见 k3s-migration.md）
```

3. 预检 + 单节点 overlay 部署（HPA 阈值调低，便于观察）：

```bash
KUBECONFIG=/home/ubuntu/.kube/ftl-deploy.yaml bash scripts/deploy/k8s-preflight.sh
K8S_OVERLAY=overlays/single-node bash scripts/deploy/deploy-k3s.sh "sha-$(git rev-parse --short HEAD)"
```

生产两节点仍用默认 `overlays/prod`：node-a 只打 `ftl-data=true`、node-b 只打 `ftl-compute=true`。

4. 功能验收（按顺序点一遍）：

| 项 | 判据 |
|---|---|
| 登录/建房/进房 | 正常；`kubectl -n ftl get pods` 全 Ready，无 ImagePullBackOff |
| 完整一局 | 结算只弹一次；`games_ended_total` 每局只 +1；记录表只多一条 |
| 同账号两台设备 | 旧设备收到「账号已在其他设备登录」并被断开；新设备正常 |
| 同房跨副本 | 两个玩家在同一房间；双方都收到 `room.state_update`（拉两个不同 pod 的连接） |
| 滚动更新 | `kubectl rollout restart deployment/room-service` 后客户端能重连，名额不残留 |
| 自愈 | `kubectl delete pod <room-pod>` 后自动重建，服务不中断 |
| node-b 关机 | 入口/数据不受影响，Pod 调度回 node-a（容量允许） |
| HPA | `kubectl get hpa -w` 显示 currentMetrics 非 `<unknown>`；压测时副本上升、停止后 30 分钟才缩 |
| 备份 | 手动跑 `backup-k8s.sh`：manifest `ok:true`；Pushgateway 有 `backup_last_success_timestamp_seconds` |
| 恢复演练 | 按 `restore-k8s.sh` 在预演环境真恢复一次（含 caddy 证书） |
| 监控 | `/grafana/` 可开；`ws_connections`/`gateway_ws_connections` 有数据；`FtlBackupStale` 规则可见 |

5. HPA 压测（必须多源 IP，单源会被 5 条/HTTP 限流挡住）：

```bash
GW=https://<预演域名> pnpm --filter @fight-the-landlord/conformance ws-load -- --users 5 --hold 300
# 在多个源 Pod/机器上并行跑，单源 5 条，合计到目标连接数
```

6. 迁移夜预演 ≥ 2 次：按 `docs/ops/k3s-migration.md` 走「备份 → 停 compose → 入集群 →
   `kubectl apply -k k8s/overlays/data` → 数据校验 → deploy-k3s → 切 DNS → 回滚演练」。

## D. 预演环境必须记录的读数

- `kubectl get nodes`、`kubectl get pods -o wide`、`kubectl get hpa`、`kubectl top nodes/pods`
- Prometheus：每个 Pod 的 `ws_connections`、`gateway_ws_connections`、`up`
- 一局结束前后的 `games_ended_total`、记录条数、currency 账本条数
- 备份 manifest 的 `ok/bytes/sha256/users` 与 Pushgateway 时间戳
- 迁移夜每一步的墙钟（目标 ≤ 2 小时）与回滚耗时

## E. 明确不能在本机自测的

- 真实 DNS/TLS/公网源 IP（需要域名与公网入口）
- 支付渠道外部 HTTPS、COS 异地备份（需要凭据）
- HPA 真实扩缩与节点容量、local-path 绑定、GHCR 拉取
- 跨 Pod 广播/顶替的**强制**落点（无法强制两个连接落到不同 pod；靠单测 + 预演人工对局）
