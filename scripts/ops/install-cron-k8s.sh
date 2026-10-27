#!/usr/bin/env bash
# 安装 k3s 备份 cron（幂等：只维护 `# ftl-backup-k8s` 那一行）。
set -euo pipefail
KUBECONFIG_PATH="${KUBECONFIG_PATH:-/home/ubuntu/.kube/ftl-deploy.yaml}"
LINE="17 * * * * KUBECONFIG=$KUBECONFIG_PATH /bin/bash /home/ubuntu/ftl-ops/backup-k8s.sh >> /home/ubuntu/ftl-backups/backup.log 2>&1 # ftl-backup-k8s"
( crontab -l 2>/dev/null | grep -v '# ftl-backup-k8s' || true; printf '%s\n' "$LINE" ) | crontab -
echo "✅ 已安装：$LINE"
