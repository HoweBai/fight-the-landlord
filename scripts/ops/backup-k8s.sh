#!/usr/bin/env bash
# k3s 备份（在 node-a 上由 cron 调用）：MySQL dump + edge 证书卷 + manifest + 可选异地。
# 环境：KUBECONFIG（必填）、DEST、RETENTION_DAYS、RCLONE_REMOTE（可选）
set -euo pipefail
export MSYS_NO_PATHCONV=1

: "${KUBECONFIG:?需要 KUBECONFIG}"
DEST="${DEST:-/home/ubuntu/ftl-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
NS="${NAMESPACE:-ftl}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"
exec 9>"$DEST/.lock"
if ! flock -n 9; then
  echo '拿不到锁：另一次备份正在跑' >&2
  exit 3
fi

kc=(kubectl --kubeconfig "$KUBECONFIG")
mysql_pod="$("${kc[@]}" -n "$NS" get pod -l app=mysql -o jsonpath='{.items[0].metadata.name}')"
edge_pod="$("${kc[@]}" -n "$NS" get pod -l app=edge -o jsonpath='{.items[0].metadata.name}')"
tag="$("${kc[@]}" -n "$NS" get deployment api-gateway -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')"

MYSQL_FILE="$DEST/mysql-$TS.sql.gz"
CADDY_FILE="$DEST/caddy-$TS.tar.gz"
MANIFEST="$DEST/manifest-$TS.json"
ok=false

write_manifest() {
  local status="$1" rc="$2"
  local g_users="${users:-null}" g_configs="${configs:-null}"
  local size_m size_c sum_m sum_c offsite=false
  size_m="$(stat -c '%s' "$MYSQL_FILE" 2>/dev/null || echo 0)"
  size_c="$(stat -c '%s' "$CADDY_FILE" 2>/dev/null || echo 0)"
  sum_m="$(sha256sum "$MYSQL_FILE" 2>/dev/null | cut -d' ' -f1 || true)"
  sum_c="$(sha256sum "$CADDY_FILE" 2>/dev/null | cut -d' ' -f1 || true)"
  [ -n "${RCLONE_REMOTE:-}" ] && offsite=true
  cat > "$MANIFEST" <<JSON
{"ok":$status,"rc":$rc,"tag":"$tag","ts":"$TS","mysql":{"file":"$(basename "$MYSQL_FILE")","bytes":$size_m,"sha256":"$sum_m","users":$g_users,"configKeys":$g_configs},"caddy":{"file":"$(basename "$CADDY_FILE")","bytes":$size_c,"sha256":"$sum_c"},"offsite":$offsite}
JSON
}

on_exit() {
  local rc=$?
  if [ "$ok" != true ]; then
    write_manifest false "$rc" || true
    echo "❌ 备份失败（rc=$rc），manifest: $MANIFEST" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "── mysqldump ──"
"${kc[@]}" -n "$NS" exec "$mysql_pod" -- sh -c 'exec mysqldump --single-transaction -uroot -p"$MYSQL_ROOT_PASSWORD" fight_the_landlord' | gzip > "$MYSQL_FILE"
users="$("${kc[@]}" -n "$NS" exec "$mysql_pod" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM fight_the_landlord.users"')"
configs="$("${kc[@]}" -n "$NS" exec "$mysql_pod" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM fight_the_landlord.platform_config"' 2>/dev/null || echo null)"
[ "$users" -gt 0 ] || { echo "❌ users 行数为 0" >&2; exit 1; }

echo "── caddy 证书卷 ──"
"${kc[@]}" -n "$NS" exec "$edge_pod" -- tar czf - -C /data . > "$CADDY_FILE"
[ -s "$CADDY_FILE" ] || { echo "❌ caddy 备份为空" >&2; exit 1; }

if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  echo "── 异地副本 ──"
  rclone copy "$DEST" "$RCLONE_REMOTE" --include "mysql-$TS*" --include "caddy-$TS*" --include "manifest-$TS*"
fi

ok=true
write_manifest true 0
echo "✅ 备份完成：$MANIFEST"

# 备份新鲜度指标（Pushgateway 走 port-forward）
"${kc[@]}" -n ftl-monitoring port-forward svc/pushgateway 19091:9091 >/dev/null 2>&1 &
pf=$!
sleep 2
printf 'backup_last_success_timestamp_seconds %s\n' "$(date +%s)" \
  | curl -fsS --max-time 10 --data-binary @- http://127.0.0.1:19091/metrics/job/backup >/dev/null || true
kill "$pf" 2>/dev/null || true

find "$DEST" -maxdepth 1 -type f -mtime "+$RETENTION_DAYS" -delete
