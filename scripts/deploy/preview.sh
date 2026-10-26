#!/usr/bin/env bash
# 测试服**快速预览**（静态秒传，2026-10-27）。不构建镜像、不重启容器：
#   admin/**      → tar 流直投 ftl-edge:/srv/admin   （Caddy 立即读到）
#   agent/**      → tar 流直投 ftl-edge:/srv/agent
#   apps/client/** → 本地 `uni build:h5` 后投 /srv（H5 根；**不需要本机 Docker**）
#
# 用法：
#   bash scripts/deploy/preview.sh --dry-run           # 只打印变更分类，不动服务器
#   bash scripts/deploy/preview.sh auto                # 默认：按分类同步（有需重建镜像的改动则拒绝）
#   bash scripts/deploy/preview.sh admin|agent|client  # 强制同步某一面（显式覆盖分类）
#   选项：--base <ref>   分类基线（默认 = 服务器上正在运行的 dev-* tag）
#
# ⚠️ 这是**预览通道**，不是部署：
#   * 覆盖只进容器可写层 —— 下一次正式部署（deploy-dev.sh）或容器重建即复位；
#   * 不做 tag/blob 校验；同步进来的内容可能来自**未提交的工作树**（预览本意）；
#   * 只覆盖/新增，不删除（删文件请走正式部署）；
#   * 依赖 `.env.deploy.local` 的 SSH 凭据（与 deploy.sh 共用）。
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="auto"
DRY=0
BASE_REF=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    --dry-run) DRY=1; shift ;;
    --base) BASE_REF="${2:?--base 需要 ref}"; shift 2 ;;
    auto | admin | agent | client) MODE="$1"; shift ;;
    *) printf '用法：bash scripts/deploy/preview.sh [auto|admin|agent|client] [--dry-run] [--base <ref>]\n' >&2; exit 2 ;;
  esac
done

[ -f .env.deploy.local ] || {
  printf '❌ [preview] 缺 `.env.deploy.local`（SSH 凭据来源）\n' >&2
  exit 1
}
set -a; . ./.env.deploy.local; set +a
: "${SSH_HOST:?缺 SSH_HOST}"
: "${SSH_KEY:?缺 SSH_KEY}"
SSH_USER_="${SSH_USER:-ubuntu}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
TARGET="$SSH_USER_@$SSH_HOST"
ssh_do() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

# ── 基线：默认取服务器上正在跑的 dev-* tag ───────────────────────────────────
git fetch --tags --force >/dev/null 2>&1 || true
if [ -z "$BASE_REF" ]; then
  BASE_REF="$(ssh_do 'docker ps --format "{{.Image}}" | grep -oE "dev-[0-9a-f]{7}" | sort -u | head -1' 2>/dev/null || true)"
fi
if [ -n "$BASE_REF" ] && git rev-parse -q --verify "${BASE_REF}^{commit}" >/dev/null; then
  BASE_NOTE="基线 $BASE_REF"
else
  BASE_REF=""
  BASE_NOTE="基线（空）：只看工作树改动"
fi

# ── 变更集合 = 基线以来已提交 + 工作树（含未跟踪） ───────────────────────────
PATHS="$(mktemp)"
trap 'rm -f "$PATHS"' EXIT
{
  if [ -n "$BASE_REF" ]; then git diff --name-only "$BASE_REF" -- . 2>/dev/null || true; fi
  git status --porcelain=v1 2>/dev/null | sed -E 's/^[ MARCUD?!]{1,2} +//' | sed 's/.* -> //'
} | sed '/^$/d' | sort -u >"$PATHS"

NEED_ADMIN=0; NEED_AGENT=0; NEED_CLIENT=0
BLOCKED=(); NOOP=()
while IFS= read -r p; do
  case "$p" in
    admin/*) NEED_ADMIN=1 ;;
    agent/*) NEED_AGENT=1 ;;
    apps/client/*) NEED_CLIENT=1 ;;
    docs/* | scripts/* | .github/* | .superpowers/* | *.md | LICENSE* | .gitignore) NOOP+=("$p") ;;
    *) BLOCKED+=("$p") ;;
  esac
done <"$PATHS"

printf 'ℹ️ [preview] 模式=%s · %s · 变更 %s 个文件\n' "$MODE" "$BASE_NOTE" "$(wc -l <"$PATHS" | tr -d ' ')"
[ "${#NOOP[@]}" -gt 0 ] && printf '   （忽略 %s 个不参与部署的改动）\n' "${#NOOP[@]}"

if [ "$DRY" = 1 ]; then
  printf '   静态可秒传：admin=%s agent=%s client(H5)=%s\n' "$NEED_ADMIN" "$NEED_AGENT" "$NEED_CLIENT"
  if [ "${#BLOCKED[@]}" -gt 0 ]; then
    printf '   ⛔ 需要重建镜像（%s 个）：\n' "${#BLOCKED[@]}"
    printf '     %s\n' "${BLOCKED[@]}" | head -20
  fi
  exit 0
fi

# ── auto：必须重建镜像的改动 ⇒ 拒绝，引导正式部署 ───────────────────────────
if [ "$MODE" = "auto" ] && [ "${#BLOCKED[@]}" -gt 0 ]; then
  printf '⛔ [preview] 检测到必须重建镜像的改动（静态秒传不会生效）：\n' >&2
  printf '   %s\n' "${BLOCKED[@]}" | head -20 >&2
  printf '   走正式部署：bash scripts/deploy/deploy-dev.sh（GitHub 构建）\n' >&2
  printf '   只想预览 H5（即使 protocol/shared 有改动）：bash scripts/deploy/preview.sh client\n' >&2
  exit 2
fi
if [ "$MODE" = "auto" ] && [ "$NEED_ADMIN$NEED_AGENT$NEED_CLIENT" = "000" ]; then
  printf 'ℹ️ [preview] 没有可秒传的静态改动 —— 无需操作。\n'
  exit 0
fi
if [ "$MODE" != "auto" ] && [ "${#BLOCKED[@]}" -gt 0 ]; then
  printf '⚠️ [preview] 仍有需要重建镜像的改动（本次不处理）：%s\n' "${BLOCKED[*]:0:5}" >&2
fi

sync_dir() { # <local_dir> <remote_dir> <label>
  printf '⬆️ [preview] 同步 %s → ftl-edge:%s\n' "$3" "$2"
  tar -C "$1" -cf - . | ssh "${SSH_OPTS[@]}" "$TARGET" "docker exec -i ftl-edge tar -x -C '$2'"
}

verify_file() { # <local_file> <remote_file> <label>
  local lr
  lr="$(ssh_do "docker exec ftl-edge sha256sum '$2'" | awk '{print $1}')"
  local ll
  ll="$(sha256sum "$1" | awk '{print $1}')"
  if [ "$ll" != "$lr" ]; then
    printf '❌ [preview] %s 校验失败（local %s ≠ remote %s）\n' "$3" "${ll:0:12}" "${lr:0:12}" >&2
    exit 1
  fi
  printf '✅ [preview] %s 已生效（sha256 %s…）\n' "$3" "${ll:0:12}"
}

DO_ADMIN=0; DO_AGENT=0; DO_CLIENT=0
case "$MODE" in
  auto) DO_ADMIN=$NEED_ADMIN; DO_AGENT=$NEED_AGENT; DO_CLIENT=$NEED_CLIENT ;;
  admin) DO_ADMIN=1 ;;
  agent) DO_AGENT=1 ;;
  client) DO_CLIENT=1 ;;
esac

if [ "$DO_ADMIN" = 1 ]; then
  # 秒级结构闸（<1s）：坏结构不进预览。
  pnpm verify:admin >/dev/null || { printf '⛔ [preview] pnpm verify:admin 未过 —— 拒绝同步 admin
' >&2; exit 1; }
  sync_dir admin /srv/admin 'admin/'
  verify_file admin/app.js /srv/admin/app.js 'admin/app.js'
fi
if [ "$DO_AGENT" = 1 ]; then
  pnpm verify:agent >/dev/null || { printf '⛔ [preview] pnpm verify:agent 未过 —— 拒绝同步 agent
' >&2; exit 1; }
  sync_dir agent /srv/agent 'agent/'
  verify_file agent/app.js /srv/agent/app.js 'agent/app.js'
fi
if [ "$DO_CLIENT" = 1 ]; then
  [ -f packages/protocol/dist/index.js ] || pnpm -C packages/protocol build
  printf '🔨 [preview] 本地构建 H5（uni build，约 1–2 分钟）…\n'
  pnpm -C apps/client build:h5
  sync_dir apps/client/dist/build/h5 /srv 'H5 dist'
  verify_file apps/client/dist/build/h5/index.html /srv/index.html 'H5 index.html'
fi

printf '\n🎉 [preview] 完成。浏览器请**硬刷新**（Ctrl/Cmd+Shift+R；手机端可先清站点缓存）。\n'
printf '   预览是临时覆盖：下一次正式部署（deploy-dev.sh）或容器重建会复位。\n'
