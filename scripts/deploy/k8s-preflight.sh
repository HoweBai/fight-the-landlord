#!/usr/bin/env bash
# k3s 预检：在集群节点上执行（需要 kubectl 与可读的 kubeconfig）。
# 用法：KUBECONFIG=/home/ubuntu/.kube/ftl-deploy.yaml bash scripts/deploy/k8s-preflight.sh
set -euo pipefail

: "${KUBECONFIG:?需要 KUBECONFIG（部署 SA）}"
NS=ftl
fail=0
say() { printf '%s\n' "$*"; }
bad() { printf '❌ %s\n' "$*" >&2; fail=1; }

say '── 节点 ──'
nodes="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.metadata.labels.ftl-role}{"\n"}{end}')"
printf '%s\n' "$nodes"
[ "$(printf '%s\n' "$nodes" | grep -c $'\tTrue\t' || true)" -ge 2 ] || bad 'Ready 节点少于 2 个'
printf '%s\n' "$nodes" | grep -q $'\tTrue\tdata' || bad '缺 ftl-role=data 节点（node-a）'
printf '%s\n' "$nodes" | grep -q $'\tTrue\tcompute' || bad '缺 ftl-role=compute 节点（node-b）'

say '── bootstrap ──'
for ns in ftl ftl-monitoring; do
  kubectl get namespace "$ns" >/dev/null 2>&1 || bad "缺 namespace $ns（先跑 k8s/bootstrap）"
done
for cr in ftl-prometheus ftl-kube-state-metrics ftl-deployer-read; do
  kubectl get clusterrole "$cr" >/dev/null 2>&1 || bad "缺 ClusterRole $cr（先跑 k8s/bootstrap）"
done

say '── 存储 ──'
sc="$(kubectl get storageclass local-path -o jsonpath='{.volumeBindingMode}' 2>/dev/null || true)"
[ "$sc" = 'WaitForFirstConsumer' ] || bad "StorageClass local-path 的 volumeBindingMode=$sc（期望 WaitForFirstConsumer）"

say '── Secret / 镜像 ──'
kubectl -n "$NS" get secret ftl-secrets >/dev/null 2>&1 || bad '缺 Secret ftl-secrets（按 runbook 创建）'
kubectl -n "$NS" get secret ghcr-pull >/dev/null 2>&1 || bad '缺 imagePullSecret ghcr-pull'

say '── 入口端口 ──'
if command -v ss >/dev/null 2>&1; then
  if ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN; then
    bad '宿主 80/443 已被占用（旧 compose 的 edge 未停？）'
  fi
else
  say '⚠️ 无 ss，跳过端口检查'
fi

say '── 备份目录 ──'
mkdir -p /home/ubuntu/ftl-backups
[ -w /home/ubuntu/ftl-backups ] || bad '/home/ubuntu/ftl-backups 不可写'

if [ "$fail" -ne 0 ]; then
  echo '❌ 预检未通过' >&2
  exit 1
fi
echo '✅ 预检通过'
