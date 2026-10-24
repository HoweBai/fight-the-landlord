#!/bin/sh
# deploy/monitoring/prometheus/entrypoint.sh —— 替换官方 ENTRYPOINT（规格 §2.4ter 写死骨架）。
#
# 职责只有一件：把 `INTERNAL_SERVICE_TOKEN` 落成 600 的 credentials_file
# （prometheus.yml 的七个 Bearer job 都指向它）；然后 exec 官方二进制。
#
# ⚠️ flag 转发形态（O3）：官方 CMD **含** `--config.file` / `--storage.tsdb.path`
#    ⇒ 本脚本**只补增量 flag**、末尾 `"$@"` 原样转发官方 CMD——
#    kingpin 对非累计值 flag 的**重复是同值也报错**（与 AM 的"不转发"成对，勿对调）。
# ⚙️ 实施期已核（2026-10-03，docker inspect prom/prometheus:v3.15.0 逐字）：
#    CMD = ["--config.file=/etc/prometheus/prometheus.yml","--storage.tsdb.path=/prometheus"]
#    ⇒ 两项都由 CMD 提供，本行不重复。⚠️ 该 CMD 由**本镜像的 Dockerfile 逐字重述**
#    （子 Dockerfile 里设 ENTRYPOINT 会清空继承来的 CMD、空 "$@" 下 prometheus 会以
#    相对路径 `prometheus.yml` 起不来——实测原文见 Dockerfile.prometheus 尾注）。
set -eu
: "${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN required}"
umask 077
printf '%s' "$INTERNAL_SERVICE_TOKEN" > /etc/prometheus/secret/internal_token

# `retention.size` 语态 = **按块回收的软上限**（官方口径）；磁盘硬兜底是 HostDiskSpace* 规则。
exec /bin/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.retention.size=5GB \
  --web.listen-address=:9090 "$@"
