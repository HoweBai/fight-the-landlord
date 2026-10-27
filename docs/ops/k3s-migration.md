# k3s 迁移夜手册（compose → 2 节点 k3s）

> 配套设计：`docs/superpowers/specs/2026-10-27-k3s-autoscaling-design.md`
> 日常运维见 `docs/ops/k3s-runbook.md`。本文是**一次性切换**手册。

## 0. 前置（切换前 3–7 天）

- [ ] 新购机器与现有服务器**同 VPC/私网互通**；安全组放行 6443/tcp、10250/tcp、8472/udp（仅节点间与运维 IP）。
- [ ] 新机器装 k3s server（单节点预演）：

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --disable traefik --secrets-encryption --node-name node-b" sh -
```

- [ ] 现有服务器装 agent（预演阶段先不装；切换夜再执行）。
- [ ] 打节点标签：

```bash
kubectl label node <node-a> ftl-role=data
kubectl label node <node-b> ftl-role=compute
```

- [ ] 用管理员 kubeconfig 应用 bootstrap（一次性）：

```bash
kubectl apply -k k8s/bootstrap
```

- [ ] 创建 Secret（**不落 git**）：`ftl-secrets` 含
  `DB_PASSWORD`、`JWT_SECRET`、`ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`、`AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`INTERNAL_SERVICE_TOKEN`、`PAY_CONFIG_ENC_KEY`、`PAY_CHANNEL_PULL_TOKEN`、`NOTIFY_CHANNEL_PULL_TOKEN`、`AD_CHANNEL_PULL_TOKEN`、`GRAFANA_ADMIN_PASSWORD`、`GRAFANA_ROOT_URL`、`SITE_ADDRESS`、`TLS_MODE`。
- [ ] 创建 `ghcr-pull`（只读 PAT）：

```bash
kubectl -n ftl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<read-only-pat>
```

  ⚠️ 清单尚未统一引用 `imagePullSecrets`；应用前确认每个 Pod 模板已加（或给 `ftl-deployer`/default SA 绑定）。
- [ ] 生成部署 kubeconfig（SA `ftl-deployer`）到 `/home/ubuntu/.kube/ftl-deploy.yaml`，权限 600。
- [ ] 预演：空库部署全栈 → 冒烟 → 备份/恢复 → 2 副本回归（`slice-multi-replica`）→ HPA 压测。
- [ ] DNS TTL 提前 24h 降到 60s。

## 1. 切换夜顺序（预计 1–2 小时）

1. 公告维护窗口。
2. **compose 仍在运行时**备份（`--single-transaction`）：

```bash
bash scripts/ops/backup.sh
```

   确认最新 manifest 为 `"ok":true`。
3. 正常停栈（给 MySQL/Redis 关停时间）：

```bash
docker compose -f docker-compose.yml stop -t 120
```

4. 现有服务器装 k3s agent 加入 node-b：

```bash
curl -sfL https://get.k3s.io | K3S_URL=https://<node-b-ip>:6443 K3S_TOKEN=<token> INSTALL_K3S_EXEC="agent --node-name node-a" sh -
```

5. 校验：`kubectl get nodes` 两节点 Ready；跨节点 Pod 网络连通；`kubectl get sc local-path -o yaml` 的 `volumeBindingMode=WaitForFirstConsumer`。
6. 创建 PVC 并确认 Bound：

```bash
kubectl apply -k k8s/overlays/prod
kubectl -n ftl get pvc
kubectl -n ftl-monitoring get pvc
```

7. 迁移数据：
   - MySQL：优先用第 2 步的 dump 恢复到 `mysql-0`；或复制旧 datadir 到 `mysql-data` PV（保持属主）。
   - Redis：可复制 RDB（可选；维护窗口内丢失的会话可接受）。
   - caddy-data：从旧卷打包复制，**保持 uid 1001 属主**。
8. 跑 verify：行数 `users`/`platform_config`/四张迁移表；配置键数；checksum。失败 ⇒ 中止，按 §2 回滚。
9. 正式部署：

```bash
bash scripts/deploy/deploy-k3s.sh <tag>
```

10. 切 DNS 到 node-a EIP；观察 30 分钟。
11. 旧 Docker 卷保留 **72 小时**，确认无误后再删。

## 2. 回滚

### 2.1 DNS 切换前（首选）

```bash
kubectl delete -k k8s/overlays/prod
kubectl delete -k k8s/bootstrap
# 卸载 node-a 上的 k3s agent
/usr/local/bin/k3s-agent-uninstall.sh
docker compose -f docker-compose.yml up -d
```

旧卷未被改动 ⇒ 数据完整；新栈维护窗口内的写入丢弃可接受。

### 2.2 DNS 切换后

1. 停 k3s 业务工作负载（保留 PVC）。
2. 从切换前备份恢复到 compose 的 MySQL volume。
3. 证书卷回拷到旧的 `caddy-data`。
4. 启动 compose，改 DNS。
5. **RPO = 切换前备份点至故障点**；迁移 Job 已写入的 schema 需人工评估旧镜像兼容性。

> 不承诺无损回滚。回滚决策由人做，脚本只提供路径。

## 3. 切换后 7 天观察

- [ ] 无未解释的 Pod 重启/驱逐。
- [ ] HPA 扩缩正常，缩容未断线。
- [ ] 备份每小时成功，`backup_last_success_timestamp_seconds` 新鲜。
- [ ] 监控看板按 Pod 聚合正确（不是 N 倍）。
- [ ] 告警能送达。
