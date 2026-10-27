# k3s 清单安全加固（KSV 配置扫描清零）

- 日期：2026-10-27
- 触发：`dev → master` 合并后 `security-scan` 首次跑 trivy config，暴露 k3s 清单 9 类 KSV HIGH/CRITICAL（与依赖升级无关）
- 分支：`fix/k3s-security-hardening`（从 `dev@45ca45df`）
- 目标：`trivy config --severity HIGH,CRITICAL --exit-code 1` 在 k8s 清单上清零（不扩大 `.trivyignore` 白名单）

## 变更

1. **工作负载 securityContext**
   - 应用/Job/监控：pod 级 `runAsNonRoot` + `runAsUser/Group/fsGroup` + `seccompProfile: RuntimeDefault`；
     container 级 `allowPrivilegeEscalation: false` + `readOnlyRootFilesystem: true` + `capabilities.drop: [ALL]`。
   - UID：Node 服务 1000、edge 1001、douzero 1001、mysql/redis 999、监控按镜像既有 UID（65534/472）。
   - 可写目录用 emptyDir：所有容器 `/tmp`；mysql 额外 `/var/run/mysqld`；edge 额外 `/config`（Caddy autosave）。
   - edge 保留 `NET_BIND_SERVICE`（非 root 绑 80/443）。
2. **edge 去 hostNetwork（KSV-0009）**
   - 新增 `Service edge`（`type: LoadBalancer` + `externalTrafficPolicy: Local`）暴露 80/443；
     `externalTrafficPolicy: Local` 保留真实客户端 IP，替代原 hostNetwork 的目的。
   - `scripts/verify-k8s-manifests.mjs` 的判据从「edge 必须 hostNetwork」改为「必须 LB + Local」。
3. **cadvisor 移除（KSV-0017/0121/0009/0024）**
   - 删除 cadvisor Service + DaemonSet；Prometheus 改走 kubelet `/metrics/cadvisor`
     （SA 已有 `nodes/metrics`，`tls_config.insecure_skip_verify=true`）。
   - `deploy-k3s.sh`  rollout 列表移除 cadvisor。
4. **node-exporter（KSV-0009/0024/0121）**
   - 去掉 hostNetwork/hostPort；保留 headless Service（Prometheus static target 仍可用）。
   - 去掉 hostPath `/`，改 `hostPID: true` + 只读 `/proc` 挂载 + `--path.procfs=/host/proc --path.sysfs=/sys`。
   - 代价：host 网络命名空间与 host 根文件系统的部分 collector 指标会缺失（登记）。
5. **RBAC**
   - KSM ClusterRole 去掉 `secrets`（KSV-0041）；确认看板/告警未使用 `kube_secret_*`。
   - 两个 deployer Role 去掉 `pods/exec`、`pods/portforward`（KSV-0053）；
     运维 `kubectl exec` 改走管理员 break-glass（runbook 已注）。
   - `services`/`networkpolicies` 的写权限暂保留（部署脚本 `apply -k` 需要）——若 trivy 仍报
     KSV-0056，则下一轮拆「网络资源管理员预应用」或加受控例外（见待办）。

## 验证

- `pnpm verify:k8s`：99 文档通过（edge 判据已改）。
- `pnpm verify:monitoring`：267 checks 通过（compose 面未变）。
- `gh workflow run ci.yml --ref fix/k3s-security-hardening`（run `40529165489`）：
  **ci / render-gate / security-scan 三 job 全 success**；trivy 0 条 HIGH/CRITICAL（3 条平台固有项入受控例外）。
- 真集群验证（部署前）：MySQL/Redis 非 root + 只读根、node-exporter 指标覆盖、edge LB Local 的客户端 IP、
  kubelet cadvisor 抓取权限 —— 均需在 k3s 预演/自测清单里逐项验。
- **不在本片范围**：master 全量 conformance 仍红于 `slice-35-records-reconcile`
  （C2 已知待权威轮项，日志：currency-service 70s 内未出现新配置快照应用行）；与本片改动无关。

## 受控 KSV 例外（3 条）

`.trivyignore` 新增且仅允许以下 3 条（`slice-07.4` 的 `KSV_ALLOWED` 白名单同步收口）：

| ID | 原因 | 收窄面 |
|---|---|---|
| KSV-0010 | node-exporter 采集主机指标必须 `hostPID` | 仅 node-exporter DaemonSet |
| KSV-0121 | node-exporter 必须只读挂载 host `/proc` | 仅 `/host/proc`，不再挂 `/` 或 `/sys` |
| KSV-0056 | ftl-deployer `apply -k` 必须能写 Service/NetworkPolicy | 仅两个 deployer Role；已移除 exec/portforward |

> 决策：未把 Service/NetworkPolicy 写权限拆成「管理员预应用」——那会改变部署语义且无法在 CI 验证；
> 先以受控例外收口，后续若做 GitOps/Argo 再拆。


## 风险与已知代价

| 风险 | 说明 | 处置 |
|---|---|---|
| mysql/redis 只读根 + 非 root | 官方镜像 entrypoint 可能需要写 `/var/run`、`/tmp`；已加 emptyDir，但未真集群验证 | k3s 自测清单加项 |
| node-exporter 指标缩水 | 去 hostNetwork/rootfs 后 host 网络与根文件系统 collector 可能缺失 | 登记；用 kubelet/主机指标补 |
| edge 客户端 IP | LB `externalTrafficPolicy: Local` 在单节点保留源 IP；多节点需确认 | 预演验证；否则回退 hostPort+例外 |
| deployer services/networkpolicies 写权限 | KSV-0056 可能仍红 | 下一轮拆权限或受控例外 |
| kubelet cadvisor 证书 | `insecure_skip_verify: true` 仅集群内抓取 | 可换 kubelet CA |

## 涉及文件

`k8s/base/*.yaml`（15 个工作负载文件）、`k8s/base/monitoring/prometheus.yml`、
`k8s/base/rbac.yaml`、`k8s/bootstrap/rbac-cluster.yaml`、`scripts/verify-k8s-manifests.mjs`、
`scripts/deploy/deploy-k3s.sh`、`docs/ops/k3s-runbook.md`。

## 审查记录

- 待安全扫描迭代与独立审查。
