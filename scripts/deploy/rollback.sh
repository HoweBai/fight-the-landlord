#!/usr/bin/env bash
# 回滚到**一个已存在的旧 tag**（R1308）。走的是与 deploy **完全同一条路径**（代码不动），
# 只换 tag —— 因为镜像已经在 GHCR 上（`docker image prune -f` 保住了它）⇒ **秒级**。
#
# 用法：rollback.sh <旧 tag>
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f .env.deploy.local ]; then
  set -a; . ./.env.deploy.local; set +a
fi

TAG="${1:?用法：rollback.sh <旧 tag>}"
: "${SSH_HOST:?缺 SSH_HOST}"
: "${SSH_KEY:?缺 SSH_KEY}"
: "${GHCR_PULL_TOKEN:?缺 GHCR_PULL_TOKEN}"
# ⚠️ 同上（deploy.sh 里同一条）：缺了它 `set -u` 报的是 `GHCR_USER: unbound variable` 直接死，
#    而下面那句 `if ! … docker login` 是拦不住的（nounset 在管道里也是致命错）。
: "${GHCR_USER:?缺 GHCR_USER（GHCR 用户名；CI 里是 github.actor）}"

# ⚠️ R1308 的前提：**只 pull 已存在的 tag**（否则会拉到一个不存在的镜像 ⇒ 部署到一半失败）。
#    先问镜像库「这个 tag 在不在」—— 不在就**别动服务器**。
printf '=== [rollback] 先确认 %s 在镜像库上存在 ===\n' "$TAG"
if ! echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  printf '❌ [rollback] docker login 失败\n' >&2; exit 1
fi
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
if ! docker manifest inspect "ghcr.io/howebai/fight-the-landlord-api-gateway:$TAG" >/dev/null 2>&1; then
  printf '❌ [rollback] 镜像库里没有 tag `%s`（先确认 tag 名；可 `gh api /user/packages/...` 或本地 `docker images` 找）\n' "$TAG" >&2
  exit 1
fi
printf '✅ [rollback] %s 存在 ⇒ 走与 deploy 同一条路径\n' "$TAG"
# ⚠️ **不用 `exec`**（复评 Minor 4）：`exec` 会把当前 shell **替换**掉，而 bash 的 `exec` **不跑**
#    EXIT trap ⇒ 上面那条本地 `docker logout`（登出第 ② 层）在**成功路径**上被跳过，操作者的
#    `~/.docker/config.json` 会一直留着 ghcr 凭据。普通调用同样把退出码透传出来（`|| rc=$?`）。
rc=0
bash scripts/deploy/deploy.sh "$TAG" || rc=$?
exit $rc
