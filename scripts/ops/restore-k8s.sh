#!/usr/bin/env bash
# k3s 恢复：MySQL dump 与 edge 证书卷。恢复前必须把所有业务工作负载缩到 0。
# 用法：restore-k8s.sh --mysql <file> [--caddy <file>] --yes
set -euo pipefail
: "${KUBECONFIG:?需要 KUBECONFIG}"
MYSQL_FILE=''; CADDY_FILE=''; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mysql) MYSQL_FILE="$2"; shift 2 ;;
    --caddy) CADDY_FILE="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "$MYSQL_FILE" ] || { echo '缺 --mysql <file>' >&2; exit 2; }
[ "$YES" = 1 ] || { echo '恢复会覆盖数据；确认后加 --yes' >&2; exit 2; }

kc=(kubectl --kubeconfig "$KUBECONFIG")
live="$("${kc[@]}" -n ftl get deploy -o jsonpath='{range .items[*]}{.spec.replicas}{"\n"}{end}' | grep -v '^0$' || true)"
if [ -n "$live" ]; then
  echo '❌ 仍有 Deployment 副本 > 0。先执行：' >&2
  echo '   kubectl -n ftl scale deploy --all --replicas=0' >&2
  echo '   kubectl -n ftl scale statefulset/game-service --replicas=0' >&2
  exit 1
fi

mysql_pod="$("${kc[@]}" -n ftl get pod -l app=mysql -o jsonpath='{.items[0].metadata.name}')"
echo "── 恢复 MySQL 到 $mysql_pod ──"
gunzip -c "$MYSQL_FILE" | "${kc[@]}" -n ftl exec -i "$mysql_pod" -- sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" fight_the_landlord'

users="$("${kc[@]}" -n ftl exec "$mysql_pod" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM fight_the_landlord.users"')"
echo "恢复后 users 行数：$users"
[ "$users" -gt 0 ] || { echo '❌ users 行数为 0，恢复失败' >&2; exit 1; }

if [ -n "$CADDY_FILE" ]; then
  echo '── 恢复 caddy-data（一次性 Pod）──'
  name="caddy-restore-$RANDOM"
  "${kc[@]}" -n ftl run "$name" --rm -i --restart=Never --image=alpine:3.20 \
    --overrides='{"apiVersion":"v1","spec":{"containers":[{"name":"restore","image":"alpine:3.20","stdin":true,"stdinOnce":true,"command":["tar","xzf","-","-C","/data"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"caddy-data"}}]}}' \
    < "$CADDY_FILE"
fi

echo '✅ 恢复完成。确认数据后重新部署：bash scripts/deploy/deploy-k3s.sh <tag>'
