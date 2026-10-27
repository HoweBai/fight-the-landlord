#!/usr/bin/env bash
# k3s 部署：把 k8s/ 清单送到服务器，替换 tag/IP 占位符，apply、等迁移、等 rollout、冒烟。
# 用法：deploy-k3s.sh <tag> | --assert-clean
# 环境：SSH_HOST SSH_USER SSH_KEY SITE_URL NODE_A_IP [K8S_KUBECONFIG]
#       （本地演练从 .env.deploy.local 读，变量名与 compose 部署一致）
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f .env.deploy.local ]; then
  set -a; . ./.env.deploy.local; set +a
fi

: "${SSH_HOST:?缺 SSH_HOST}"
: "${SSH_KEY:?缺 SSH_KEY（部署私钥路径）}"
USER_="${SSH_USER:-ubuntu}"
K8S_KUBECONFIG="${K8S_KUBECONFIG:-/home/ubuntu/.kube/ftl-deploy.yaml}"
K8S_OVERLAY="${K8S_OVERLAY:-overlays/prod}"
REMOTE_DIR="/srv/pokergame-k8s"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
TARGET="$USER_@$SSH_HOST"
Q_REMOTE_DIR="$(printf '%q' "$REMOTE_DIR")"
Q_KUBECONFIG="$(printf '%q' "$K8S_KUBECONFIG")"

ssh_do() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

if [ "${1:-}" = "--assert-clean" ]; then
  ssh_do "KUBECONFIG_PATH=$Q_KUBECONFIG bash -s" <<'REMOTE'
set -euo pipefail
fail=0
bad() { echo "❌ [assert-clean] $*" >&2; fail=1; }
[ -f "$KUBECONFIG_PATH" ] || bad "缺部署 kubeconfig：$KUBECONFIG_PATH"
if [ -f "$KUBECONFIG_PATH" ]; then
  mode="$(stat -c '%a' "$KUBECONFIG_PATH")"
  [ "$mode" = "600" ] || bad "部署 kubeconfig 权限 $mode（期望 600）"
fi
# 部署账户不得是 cluster-admin
if kubectl --kubeconfig "$KUBECONFIG_PATH" auth can-i '*' '*' --all-namespaces 2>/dev/null | grep -qx yes; then
  bad "部署账户拥有全局 * 权限（cluster-admin）"
fi
if kubectl --kubeconfig "$KUBECONFIG_PATH" auth can-i create clusterroles 2>/dev/null | grep -qx yes; then
  bad "部署账户可以创建 ClusterRole（权限过大）"
fi
[ ! -f /root/.kube/config ] || bad "服务器上存在 /root/.kube/config（cluster-admin 凭据）"
if [ -f "$HOME/.docker/config.json" ] && grep -q 'ghcr.io' "$HOME/.docker/config.json"; then
  bad "服务器 ~/.docker/config.json 里仍有 ghcr.io 明文凭据"
fi
[ "$fail" -eq 0 ] && echo "✅ [assert-clean] 部署账户与服务器凭据检查通过"
exit "$fail"
REMOTE
  exit $?
fi

TAG="${1:?用法：deploy-k3s.sh <tag> | --assert-clean}"
: "${SITE_URL:?缺 SITE_URL（冒烟用）}"
: "${NODE_A_IP:?缺 NODE_A_IP（edge 可信代理与 NetworkPolicy 用）}"
Q_TAG="$(printf '%q' "$TAG")"
Q_SITE="$(printf '%q' "$SITE_URL")"
Q_NODE_A="$(printf '%q' "$NODE_A_IP")"
Q_OVERLAY="$(printf '%q' "$K8S_OVERLAY")"

echo "───── 投递 k8s/ 与运维脚本 ─────"
ssh_do "mkdir -p /home/ubuntu/ftl-ops $Q_REMOTE_DIR && chmod 700 /home/ubuntu/ftl-ops"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
  scripts/ops/backup-k8s.sh scripts/ops/restore-k8s.sh scripts/ops/install-cron-k8s.sh \
  "$TARGET:/home/ubuntu/ftl-ops/"
ssh_do "chmod 700 /home/ubuntu/ftl-ops/*.sh"
tar -czf - k8s | ssh_do "rm -rf $Q_REMOTE_DIR && mkdir -p $Q_REMOTE_DIR && tar -xzf - -C $Q_REMOTE_DIR"

echo "───── apply + 迁移 + rollout + 冒烟 ─────"
ssh_do "IMAGE_TAG=$Q_TAG SITE_URL=$Q_SITE NODE_A_IP=$Q_NODE_A KUBECONFIG_PATH=$Q_KUBECONFIG OVERLAY=$Q_OVERLAY bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/pokergame-k8s
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -a k8s/. "$tmp"/
find "$tmp" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0 \
  | xargs -0 sed -i "s|IMAGE_TAG_PLACEHOLDER|$IMAGE_TAG|g; s|NODE_A_IP_PLACEHOLDER|$NODE_A_IP|g"
if grep -Rq 'PLACEHOLDER' "$tmp" --include='*.yaml' --include='*.yml'; then
  echo "❌ 渲染后仍含 PLACEHOLDER（检查 deploy-k3s.sh 的替换链）" >&2
  grep -Rn 'PLACEHOLDER' "$tmp" --include='*.yaml' --include='*.yml' >&2 || true
  exit 1
fi

kc=(kubectl --kubeconfig "$KUBECONFIG_PATH")
rollback_on_fail() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "❌ 部署失败（rc=$rc）——尝试 rollout undo 到上一 revision" >&2
    for d in api-gateway room-service robot-service user-service config-service currency-service payment-service douzero edge; do
      "${kc[@]}" -n ftl rollout undo "deployment/$d" >/dev/null 2>&1 || true
    done
    for s in mysql redis game-service; do
      "${kc[@]}" -n ftl rollout undo "statefulset/$s" >/dev/null 2>&1 || true
    done
    "${kc[@]}" -n ftl get pods -o wide >&2 || true
  fi
  exit "$rc"
}
trap rollback_on_fail EXIT
"${kc[@]}" -n ftl delete job -l app=migrate --ignore-not-found >/dev/null

echo "───── 阶段一：迁移 Job（先于业务滚动）─────"
"${kc[@]}" apply -k "$tmp/overlays/migrate"
for j in migrate-config migrate-user migrate-currency migrate-payment; do
  if ! "${kc[@]}" -n ftl wait --for=condition=complete "job/$j" --timeout=300s; then
    echo "❌ 迁移 Job $j 失败；业务工作负载尚未更新，保留现场" >&2
    "${kc[@]}" -n ftl describe "job/$j" >&2 || true
    "${kc[@]}" -n ftl logs "job/$j" --tail=100 >&2 || true
    exit 1
  fi
done

echo "───── 阶段二：业务与监控（overlay=$OVERLAY）─────"
"${kc[@]}" apply -k "$tmp/$OVERLAY"

echo "───── rollout ─────"
for d in api-gateway room-service robot-service user-service config-service currency-service payment-service douzero edge prometheus-adapter; do
  "${kc[@]}" -n ftl rollout status "deployment/$d" --timeout=300s 2>/dev/null \
    || "${kc[@]}" -n ftl-monitoring rollout status "deployment/$d" --timeout=300s
done
for s in mysql redis game-service; do
  "${kc[@]}" -n ftl rollout status "statefulset/$s" --timeout=300s
done
for d in prometheus grafana alertmanager alert-relay am-renderer kube-state-metrics pushgateway; do
  "${kc[@]}" -n ftl-monitoring rollout status "deployment/$d" --timeout=300s
done
for d in node-exporter cadvisor; do
  "${kc[@]}" -n ftl-monitoring rollout status "daemonset/$d" --timeout=300s
done

echo "───── 安装备份 cron ─────"
KUBECONFIG_PATH="$KUBECONFIG_PATH" bash /home/ubuntu/ftl-ops/install-cron-k8s.sh

echo "───── imagePullSecret 断言 ─────"
for ns in ftl ftl-monitoring; do
  bad="$("${kc[@]}" -n "$ns" get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.imagePullSecrets[0].name}{"\n"}{end}' | grep -v ' ghcr-pull$' || true)"
  if [ -n "$bad" ]; then
    echo "❌ $ns 中以下 Pod 未引用 imagePullSecrets=ghcr-pull：$bad" >&2
    exit 1
  fi
done

echo "───── 冒烟（真证书）─────"
smoke_ok=0
for i in $(seq 1 60); do
  if curl -fsS --connect-timeout 5 --max-time 15 "$SITE_URL/api/health" >/dev/null \
    && curl -fsS --connect-timeout 5 --max-time 15 "$SITE_URL/" >/dev/null \
    && curl -fsS --connect-timeout 5 --max-time 15 "$SITE_URL/socket.io/?EIO=4&transport=polling" | grep -q '"sid"'; then
    smoke_ok=1; break
  fi
  [ "$i" -lt 60 ] && sleep 5
done
if [ "$smoke_ok" != 1 ]; then
  echo "❌ 冒烟失败；保留现场" >&2
  "${kc[@]}" -n ftl get pods -o wide >&2 || true
  exit 1
fi
echo "✅ 部署完成：$IMAGE_TAG"
REMOTE
