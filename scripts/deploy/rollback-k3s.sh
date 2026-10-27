#!/usr/bin/env bash
# k3s 回滚：重新部署一个既有 tag（镜像不可变 ⇒ 等价于 rollout undo）。
# ⚠️ 数据库迁移只向前：回滚镜像前必须人工确认旧镜像与新 schema 兼容。
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="${1:?用法：rollback-k3s.sh <tag>}"
cat >&2 <<EOF
⚠️ 回滚将部署 tag：$TAG
   · 迁移 Job 不会反向执行；旧镜像必须兼容当前 schema。
   · 若迁移已改变列/表，先按 docs/ops/k3s-runbook.md 评估。
EOF
read -r -p '确认继续？输入 yes：' ans
[ "$ans" = yes ] || { echo '已取消'; exit 1; }
exec bash scripts/deploy/deploy-k3s.sh "$TAG"
