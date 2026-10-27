# k3s 日常运维手册

> 迁移夜见 `docs/ops/k3s-migration.md`。集群约定：node-a = 控制面 + 数据 + 入口；node-b = 可牺牲算力。

## 1. 发布与回滚

```bash
# 发布（CI 也会在 DEPLOY_TARGET=k3s 时调用）
bash scripts/deploy/deploy-k3s.sh v1.2.3

# 回滚到既有 tag（迁移不回退，先确认 schema 兼容）
bash scripts/deploy/rollback-k3s.sh v1.2.2
```

发布流程：删除旧迁移 Job → apply → 顺序等四个迁移 Job → rollout → 冒烟。
失败时脚本保留现场并打印 Pod/日志；**不自动回滚**（迁移可能已部分生效）。

## 2. 扩缩容

```bash
kubectl -n ftl get hpa
kubectl -n ftl describe hpa room-service-hpa
kubectl -n ftl get pods -l app=room-service -o wide
```

- room-service / api-gateway：连接数为主、CPU 为辅；缩容稳定窗 30 分钟。
- 节点固定 2 台；撑不下时先看容量：

```bash
kubectl top nodes
kubectl top pods -n ftl
```

- 调 HPA 阈值/上限：改 `k8s/base/hpa.yaml` 后走发布；压测脚本（必须从**多个源 IP**分别运行，单源受 WS 5 条/HTTP 限流）：

```bash
GW=https://<域名> pnpm --filter @fight-the-landlord/conformance ws-load -- --users 5 --hold 300
```

## 3. 节点维护

```bash
# 摘流（PDB 保护 room/gateway 至少 1 个）
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
kubectl uncordon <node>
```

⚠️ 数据层（mysql/redis/edge/game-service/监控）钉在 node-a：node-a 维护 = 全站维护窗口。
⚠️ local-path PV 不会漂移；节点重装前必须备份并人工迁移。

## 4. 数据层

### MySQL

```bash
kubectl -n ftl exec -it statefulset/mysql -- mysql -uroot -p
kubectl -n ftl logs statefulset/mysql --tail=200
```

恢复见 `scripts/ops/restore-k8s.sh`；恢复前把所有 Deployment 与 game-service 缩到 0。

### Redis

```bash
kubectl -n ftl exec -it statefulset/redis -- redis-cli INFO memory
kubectl -n ftl exec -it statefulset/redis -- redis-cli DBSIZE
```

⚠️ Redis 重启 = 登录态与在局会话丢失；看板关注内存与驱逐，`maxmemory-policy=noeviction` 会写失败而不是静默丢数据。

## 5. 备份与恢复

- 备份：node-a 的 cron（每小时第 17 分）执行 `scripts/ops/backup-k8s.sh`，产物在 `/home/ubuntu/ftl-backups/`；配置了 `RCLONE_REMOTE` 时同步到 COS。
- 新鲜度告警：`FtlBackupStale`（`time() - backup_last_success_timestamp_seconds > 7200`）。
- 恢复：

```bash
KUBECONFIG=/home/ubuntu/.kube/ftl-deploy.yaml \
  bash scripts/ops/restore-k8s.sh --mysql /home/ubuntu/ftl-backups/mysql-<ts>.sql.gz \
  --caddy /home/ubuntu/ftl-backups/caddy-<ts>.tar.gz --yes
```

- 首次安装 cron：`bash scripts/ops/install-cron-k8s.sh`。

## 6. 证书

- edge 的 `caddy-data` PVC 保存证书与 ACME 账户；迁移/恢复必须保留属主（uid 1001）。
- Let's Encrypt 同域名每周有签发配额；反复失败时先查 80/443 与 DNS，不要连续重试。

## 7. 密钥轮换

- `ftl-secrets` 更新后滚动重启对应 Deployment：`kubectl -n ftl rollout restart deployment/<name>`。
- `ghcr-pull` PAT 按季度轮换；轮换后重启所有 Deployment（或重建 Pod）。
- 部署账户 `ftl-deployer` 只有命名空间写权限；集群级变更走管理员 kubeconfig。

## 8. 监控与告警

- Prometheus：`kubectl -n ftl-monitoring port-forward svc/prometheus 9090:9090`
- Grafana：经 edge `/grafana/`。
- 关键告警：NodeNotReady、PodPending、HPA 顶到 max、备份过期、证书到期。
- 看板聚合：全栈 gauge 用 `max`，per-Pod gauge 用 `sum by (pod)`。

## 9. 已知限制（一期）

- node-a 三重单点（控制面/数据/入口）；node-b 故障不影响入口与数据。
- 节点数量固定 2 台，无节点自动伸缩。
- game-service / douzero 单实例；game-service 重启会靠启动恢复重建定时器。
- 备份一期用 node-a 主机 cron（不是 CronJob）；COS 异地副本需提供 `RCLONE_REMOTE` 与凭据。
- 入口 DNS 指向 node-a；node-a 故障需人工改指向（后续可加 CLB）。
