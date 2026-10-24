#!/bin/sh
# deploy/monitoring/alertmanager/entrypoint.sh —— 替换官方 ENTRYPOINT（通知通道管理化片 T15 重写）。
#
# 配置**拼装退役**：生成物改由 am-renderer（alert-relay 镜像第二入口）渲染到共享卷
# /alertmanager-live/alertmanager.yml（静态段唯一真源迁 renderer TS；旧 alertmanager.yml.tmpl
# 已删除）。本脚本只剩四件事（规格 §3.5 逐字）：
#   1) 有界等待生成物（90s = 45 × 2s；超时 ⇒ exit 1 响亮——文案 §2.9）；
#   2) umask 077 + 写 /alertmanager/secret/internal_token（600，照旧——webhook 接收器的
#      credentials_file）；
#   3) amtool check-config 预检生成物（失败 ⇒ exit 1）；
#   4) exec /bin/alertmanager（两 flag 由脚本全给）。
#
# ⚠️ 不转发 `"$@"`（O3）：官方 CMD 的 `--config.file` 指向镜像自带默认配置，
#    异值重复有「last-wins 静默吞掉生成配置」之险 ⇒ 两 flag 由脚本全给。
# ⚙️ 实测（2026-10-03，docker inspect / which）：USER=nobody(65534)；官方 CMD =
#    ["--config.file=/etc/alertmanager/alertmanager.yml","--storage.path=/alertmanager"]；
#    镜像内**有** amtool ⇒ 载入前预检启用（不再以「起容器即验证」兜底）。
set -eu

: "${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN required}"

yml=/alertmanager-live/alertmanager.yml

# 1) 有界等待生成物 —— renderer 首轮落 baseline 即满足（无值依赖）；超时 = 渲染面从未落盘
#    （真故障）⇒ 拒绝启动，不让 AM 以空配置挂在半态（90s = 45 × 2s）。
waited=0
while [ ! -f "$yml" ]; do
  waited=$((waited + 1))
  if [ "$waited" -gt 45 ]; then
    echo "[alertmanager] 等待 $yml 超时（90s）——拒绝启动" >&2
    exit 1
  fi
  sleep 2
done

# 2) token 落盘（600）——webhook 接收器的 credentials_file
umask 077
mkdir -p /alertmanager/secret
printf '%s' "$INTERNAL_SERVICE_TOKEN" > /alertmanager/secret/internal_token
chmod 600 /alertmanager/secret/internal_token

# 3) 载入前预检（renderer 落盘前也预检；此处守「卷上存量文件」与读取竞态面——
#    「undefined receiver」这类载入错在读得懂的位置拦下）
if ! amtool check-config "$yml"; then
  echo "[alertmanager] 生成的 $yml 未通过 amtool check-config —— 拒绝启动" >&2
  exit 1
fi

# 4) 起 AM（脚本给全 flag；不转发 "$@"——O3）
exec /bin/alertmanager --config.file="$yml" --storage.path=/alertmanager
