#!/bin/bash
# Task 2 的 DoD 复现脚本（人工验收用）。
#
# 前置：基础设施已起（redis/mysql/douzero），且四个服务在 3000-3003 上跑本 worktree 的 dist。
# 用法：bash scripts/verify-dod.sh
set -u

BASE=${BASE:-http://localhost:3000}
INTERNAL=${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}

echo "== 1) S1：匿名写操作必须被拒 =="
printf 'POST /api/rooms            -> %s (期望 401)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rooms")"
printf 'GET  /api/rooms            -> %s (期望 401)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/rooms")"
printf 'GET  /api/games/ABC        -> %s (期望 401)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games/ABC")"
printf '外部携带 X-Internal-Token  -> %s (期望 403 + code 10003)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rooms" -H "X-Internal-Token: $INTERNAL")"
printf '公开路径 /api/auth/login   -> %s (期望非 401)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{}')"
printf '公开路径 /api/health       -> %s (期望 200)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"

echo
echo "== 2) S2/S8 与骨架路径：交给端到端脚本（真实 3 人一局） =="
echo "  cd packages/api-gateway && node ../../scripts/verify-e2e.mjs"
echo "  cd packages/api-gateway && node ../../scripts/verify-authz.mjs"

echo
echo "== 3) 测试 =="
echo "  pnpm --filter @fight-the-landlord/api-gateway test"
echo "  pnpm test"
