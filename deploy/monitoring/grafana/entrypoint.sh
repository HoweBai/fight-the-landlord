#!/bin/sh
# deploy/monitoring/grafana/entrypoint.sh —— 守卫脚本（非模板；规格 §2.7）。
#
# 唯一职责 = **fail-closed 守卫**：`GF_SECURITY_ADMIN_PASSWORD` 缺失或空串 ⇒ 拒绝启动。
# 宁可起不来，也不要一个「无口令的 Grafana」躲在门口 `/grafana/` 后面（它是全片唯一新公网面）。
#
# ⚠️ 拼装零模板：`GF_SERVER_ROOT_URL` / `GF_SERVER_SERVE_FROM_SUB_PATH` 由 compose 直接
#    插值、口令走 GF_* 正规通道——本脚本不生成任何配置。
# ⚠️ 官方语义 =「**首启生效**」：改本 env **不会**改已有库里的口令（换口令走手册的
#    `grafana cli admin reset-admin-password` 小节）；但守卫**每次启动**都查 ⇒
#    漏配/被清空 ⇒ 容器起不来（而不是"静默无口令"）。
set -eu
: "${GF_SECURITY_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD required（compose 经 GF_SECURITY_ADMIN_PASSWORD 传入，空串也算未设）}"
exec /run.sh "$@"
