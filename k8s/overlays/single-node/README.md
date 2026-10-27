# 单节点预演 overlay

用途：一台 Linux 机器（建议 8C16G）上跑完整栈并观察 HPA 扩缩。

```bash
# 一个节点同时带两个角色标签
kubectl label node <node> ftl-data=true ftl-compute=true

# 部署时指定 overlay
K8S_OVERLAY=overlays/single-node bash scripts/deploy/deploy-k3s.sh <tag>
```

- 只把 room-service / api-gateway 的 HPA 调成 min 1 / max 3、连接数目标 1，
  便于用 5 条 WS（单 IP 上限）观察扩容。
- 容量不足时 Pod 会 Pending；这是 HPA 上限而非配置错误。可减少监控/降低
  douzero request，或换更大机器。
- 单节点无法做「node-b 关机」演练；跨 Pod 广播/顶替仍可测（不同 Pod 进程）。
