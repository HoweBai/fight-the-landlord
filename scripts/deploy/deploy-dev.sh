#!/usr/bin/env bash
# 部署 `dev` 分支当前 HEAD 到**开发测试服**（目标取自 `.env.deploy.local` 的 `SSH_HOST` /
# `SITE_URL` —— 开发测试环境，**不是生产**）：一条命令 = tag → build+push → deploy（用户 2026-10-15 拍板）。
# 零 CI：`dev-` 前缀不触发任何 workflow；**`v*` 前缀才会**（release.yml，≈41 分钟额度 + 走 CI 部署链）。
#
# 用法：bash scripts/deploy/deploy-dev.sh        # 无参数
#
# 三步都走**正典**入口（本脚本不重实现任何一步）：
#   ① `git tag dev-<7 位短 sha>` + 推 origin
#   ② `CACHE=0 IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord PUSH=1 bash scripts/deploy/build-images.sh`
#   ③ `bash scripts/deploy/deploy.sh <tag>`（部署 + 冒烟三条在它内部），随后本脚本做**钉 IP 复核**：
#      health 200 + `/admin/app.js` 与**该 tag 的 blob** 逐字节一致（方法已在 v1.13.6 部署上预验证）。
#
# 🔴 两条为什么是硬闸（不是提示）：
#   * **分支必须是 `dev`**：本脚本的职责只有一个方向（dev → 测试服）；别的提交要部署 ⇒ 手动三步。
#   * **工作树必须干净**：build-images.sh 从**工作树**烘镜像、deploy.sh 从 **tag** 取 compose ——
#     脏树 = 部署的镜像与 tag 指向的提交**不是一回事**（tag 没有说谎，只是说的不是你以为的那件事）。
# 🔴 复核一律**钉 IP**（`--resolve`）：本机 DNS 缓存可能把域名指到**别的机器**（记忆 quirks 12）。
set -euo pipefail
cd "$(dirname "$0")/../.."

case "${1:-}" in
  -h | --help)
    printf '用法：bash scripts/deploy/deploy-dev.sh（把 dev 当前 HEAD 部署到开发测试服；无参数）\n'
    exit 0
    ;;
  '') ;;
  *)
    printf '用法：bash scripts/deploy/deploy-dev.sh（无参数）\n' >&2
    exit 2
    ;;
esac

# ── 前置守卫 ────────────────────────────────────────────────────────────────
BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "dev" ]; then
  printf '❌ [deploy-dev] 当前分支是 `%s`（不是 `dev`）—— 本脚本只负责 dev → 测试服。\n' "$BRANCH" >&2
  printf '   要部署别的提交：手动三步（tag → build-images.sh → deploy.sh），命令见本脚本头部。\n' >&2
  exit 1
fi
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  printf '❌ [deploy-dev] 工作树不干净 —— 镜像从**工作树**烘、compose 从 **tag** 取 ⇒ 脏树会让 tag 说谎：\n%s\n' "$DIRTY" >&2
  printf '   提交（或清理）后再跑。\n' >&2
  exit 1
fi

SHA="$(git rev-parse --short=7 HEAD)"
TAG="dev-$SHA"
printf 'ℹ️ [deploy-dev] 目标 = dev@%s → tag `%s`\n' "$SHA" "$TAG"

# ── ① tag（幂等：已存在且 == HEAD ⇒ 复用；指向别处 ⇒ 拒绝）──────────────────────
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAGGED_SHA="$(git rev-parse "$TAG^{commit}")"
  HEAD_SHA="$(git rev-parse HEAD)"
  if [ "$TAGGED_SHA" != "$HEAD_SHA" ]; then
    printf '❌ [deploy-dev] tag `%s` 已存在但指向 %s（≠ HEAD %s）—— 拒绝带着错的语义往下走\n' "$TAG" "$TAGGED_SHA" "$HEAD_SHA" >&2
    exit 1
  fi
  printf 'ℹ️ [deploy-dev] tag 已存在且 == HEAD ⇒ 复用（幂等重跑）\n'
else
  git tag "$TAG"
  printf '✅ [deploy-dev] 已打 tag `%s`（本地）\n' "$TAG"
fi

# ⚠️ 本机 git 全局挂着 `http(s).proxy=127.0.0.1:8889`（qv2ray）；代理没开时常规推送直接失败
#    —— 绕代理直连重试一次（记忆 quirks 25；别动 ~/.gitconfig）。
if git push origin "$TAG" 2>/dev/null; then
  printf '✅ [deploy-dev] tag 已推 origin（`dev-` 前缀 → 零 CI）\n'
else
  printf '⚠️ [deploy-dev] 常规推送失败（多半是代理 127.0.0.1:8889 没开）—— 绕代理直连重试\n' >&2
  git -c http.proxy= -c https.proxy= push origin "$TAG"
  printf '✅ [deploy-dev] tag 已推 origin（直连）\n'
fi

# ── ①b 基础镜像预拉（防 DNS 污染截到假 IPv6 整轮败——记忆 quirks 26）──────────────
# FROM 全集**从 Dockerfile 派生**（不另抄一份清单 —— 抄的那份会漂移）；cadvisor 等上游运行镜像
# 不经本地构建，不在此面。
[ -f douzero/Dockerfile ] || {
  printf '❌ [deploy-dev] `douzero/Dockerfile` 不在 —— 预拉面派生会静默少一项（先查它是否搬家）\n' >&2
  exit 1
}
FROM_IMAGES="$(grep -hE '^FROM ' Dockerfile* douzero/Dockerfile 2>/dev/null | awk '{print $2}' | sort -u || true)"
BASE_N="$(printf '%s\n' "$FROM_IMAGES" | grep -c . || true)"
if [ "$BASE_N" -lt 5 ]; then
  printf '❌ [deploy-dev] 从 Dockerfile 只派生出 %s 个 FROM 镜像（< 5）—— 派生面疑似被扫空（Dockerfile 改名/搬家？）\n' "$BASE_N" >&2
  exit 1
fi
while IFS= read -r img; do
  [ -n "$img" ] || continue
  if docker image inspect "$img" >/dev/null 2>&1; then continue; fi
  printf '⬇️ [deploy-dev] 本机缺基础镜像 %s —— 拉取（最多 3 次；间歇污染的特征是重试即通）\n' "$img"
  pulled=0
  for _try in 1 2 3; do
    if timeout 180 docker pull "$img"; then pulled=1; break; fi
    printf '⚠️ [deploy-dev] %s 第 %s 次拉取失败 —— 重试\n' "$img" "$_try" >&2
  done
  [ "$pulled" = 1 ] || {
    printf '❌ [deploy-dev] %s 三次都拉不下来 —— 先修网络（代理/污染）再跑：带着缺口进构建必败\n' "$img" >&2
    exit 1
  }
done <<<"$FROM_IMAGES"
printf '✅ [deploy-dev] 基础镜像齐（FROM 派生 %s 项）\n' "$BASE_N"

# ── ①c GHCR 登录面（quirk 27：`conformance-stack.sh up` / `rollback.sh` 收尾都会**登出本机** ghcr
#   —— 延迟显影：之后 build --push 报 `failed to fetch anonymous token … 403`，看着像 GHCR 抽风）──
[ -f .env.deploy.local ] || {
  printf '❌ [deploy-dev] 缺 `.env.deploy.local`（deploy 的 SSH/GHCR 凭据来源，与 deploy.sh 共用）\n' >&2
  exit 1
}
set -a; . ./.env.deploy.local; set +a
DOCKER_CFG="$HOME/.docker/config.json"
if [ -f "$DOCKER_CFG" ] && grep -q 'ghcr\.io' "$DOCKER_CFG"; then
  printf '✅ [deploy-dev] 本机 ghcr 凭据在场\n'
else
  : "${GHCR_PULL_TOKEN:?缺 GHCR_PULL_TOKEN（.env.deploy.local）—— 本机 ghcr 未登录且无凭据可重登}"
  : "${GHCR_USER:?缺 GHCR_USER（.env.deploy.local）}"
  printf 'ℹ️ [deploy-dev] 本机 ghcr 未登录（多半被 conformance-stack.sh / rollback.sh 登出过）—— 重登\n'
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# ── ② 构建 + 推 GHCR（14 镜像；CACHE=0 —— GHA 缓存只在 CI 有效，本机吃层缓存）────────
printf '\n=== [deploy-dev] ② 构建 + 推 GHCR：%s ===\n' "$TAG"
if ! CACHE=0 IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord PUSH=1 bash scripts/deploy/build-images.sh "$TAG"; then
  printf '\n❌ [deploy-dev] 构建/推送失败。若日志尾部是代理瞬态（`WSAEINVAL` / `bind: An invalid argument was supplied`）\n' >&2
  printf '   ⇒ 原样重跑本脚本即可（幂等：tag 复用、层缓存已在）；否则先看日志。\n' >&2
  exit 1
fi

# ── ③ 部署（deploy.sh：送 compose + 登录 + pull + up -d + 幂等判据 + 冒烟三条）──────
printf '\n=== [deploy-dev] ③ 部署 %s ===\n' "$TAG"
bash scripts/deploy/deploy.sh "$TAG"

# ── ④ 钉 IP 复核（quirk 12：域名可能被本机 DNS 缓存指到别的机器）──────────────────
SITE_HOST="${SITE_URL#*://}"; SITE_HOST="${SITE_HOST%%/*}"; SITE_HOST="${SITE_HOST%%:*}"
CURL_PIN=(curl -s --connect-timeout 8 --max-time 30 -H 'Cache-Control: no-cache' --resolve "$SITE_HOST:443:$SSH_HOST")
printf '\n=== [deploy-dev] ④ 钉 IP 复核：%s → %s ===\n' "$SITE_HOST" "$SSH_HOST"
code="$("${CURL_PIN[@]}" -o /dev/null -w '%{http_code}' "$SITE_URL/api/health" || true)"
if [ "$code" != "200" ]; then
  printf '❌ [deploy-dev] 钉 IP `/api/health` = %s（≠ 200）—— 部署脚本已绿但复核未过：先查这一条（DNS/TLS/门口）\n' "$code" >&2
  exit 1
fi
printf '✅ [deploy-dev] /api/health = 200（钉 IP）\n'
# admin 静态面 == **该 tag 的 blob**，逐字节（「本次 tag 的静态内容真的在线上」的机械判据；
# 方法在 v1.13.6 部署上预验证：live == `git show v1.13.6:admin/app.js`，双端 CR=0）。
ADMIN_LIVE="$(mktemp)"
trap 'rm -f "$ADMIN_LIVE"' EXIT
"${CURL_PIN[@]}" -o "$ADMIN_LIVE" "$SITE_URL/admin/app.js"
live_sum="$(sha256sum <"$ADMIN_LIVE" | awk '{print $1}')"
tag_sum="$(git show "$TAG:admin/app.js" | sha256sum | awk '{print $1}')"
if [ "$live_sum" != "$tag_sum" ]; then
  printf '❌ [deploy-dev] `/admin/app.js` 与 `%s:admin/app.js` **逐字节不一致**（live %s ≠ tag %s）\n' "$TAG" "$live_sum" "$tag_sum" >&2
  printf '   静态面没有换新（edge 镜像没换？缓存？）—— 别放行。\n' >&2
  exit 1
fi
printf '✅ [deploy-dev] /admin/app.js 与 tag 逐字节一致（sha256 %s…）\n' "${live_sum:0:12}"

printf '\n🎉 [deploy-dev] 完成：dev@%s → 测试服（tag `%s`）\n' "$SHA" "$TAG"
printf '   回滚（秒级，镜像仍在 GHCR/服务器）：bash scripts/deploy/rollback.sh <上一个 dev-tag>\n'
printf '   本机腾空间（约定：逐项 `docker rmi`，**保留基础镜像与最近回滚面**；⛔ 别用 system prune）：\n'
printf '     docker images | grep fight-the-landlord\n'
