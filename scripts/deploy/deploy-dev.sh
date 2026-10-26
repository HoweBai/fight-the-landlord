#!/usr/bin/env bash
# 部署 `dev` 分支当前 HEAD 到**开发测试服**（目标取自 `.env.deploy.local` 的 `SSH_HOST` /
# `SITE_URL` —— 开发测试环境，**不是生产**）：一条命令 = tag → **GitHub Actions 构建** → deploy。
# 零 CI：`dev-` 前缀只触发 `images` workflow（构建 + 推 GHCR），不触发 ci / conformance / release；
# **`v*` 前缀才会**（release.yml，≈41 分钟额度 + 走 CI 部署链）。
#
# 用法：bash scripts/deploy/deploy-dev.sh        # 无参数
#
# 2026-10-27 起**本机不再构建**（本地可能没有 Docker）：
#   ① `git tag dev-<7 位短 sha>` + 推 origin —— 推 tag 即触发 GitHub `images` workflow；
#   ② 用 `gh` 等该 tag 的构建成功（幂等：已有成功 run 直接复用）；
#   ③ `bash scripts/deploy/deploy.sh <tag>`（部署 + 冒烟三条）→ 钉 IP 复核。
#
# 前置：`gh` 已登录（`gh auth status`）；`git` / `ssh`；`.env.deploy.local`（deploy.sh 共用）。
#
# 🔴 **分支必须是 `dev`**：本脚本只负责 dev → 测试服；别的提交要部署 ⇒ 手动三步。
# 🔴 工作树**脏不再阻断**：镜像由 GitHub 从 **tag 提交**构建、compose 也取自 tag ——
#    工作树不参与本次部署（仅提示）。
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
  printf '   要部署别的提交：手动三步（tag → 等 GitHub 构建 → deploy.sh），命令见本脚本头部。\n' >&2
  exit 1
fi
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  printf '⚠️ [deploy-dev] 工作树有未提交改动（已忽略：镜像/compose 都取自 tag 提交）：\n%s\n' "$DIRTY" >&2
fi

SHA="$(git rev-parse --short=7 HEAD)"
TAG="dev-$SHA"
printf 'ℹ️ [deploy-dev] 目标 = dev@%s → tag `%s`（GitHub 构建）\n' "$SHA" "$TAG"

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
  printf '✅ [deploy-dev] tag 已推 origin（`dev-` 前缀 → 只触发 images 构建）\n'
else
  printf '⚠️ [deploy-dev] 常规推送失败（多半是代理 127.0.0.1:8889 没开）—— 绕代理直连重试\n' >&2
  git -c http.proxy= -c https.proxy= push origin "$TAG"
  printf '✅ [deploy-dev] tag 已推 origin（直连）\n'
fi

# ── ② 等 GitHub Actions 构建（images workflow，dev-* tag 触发）────────────────
# 幂等：同一 tag 已有成功 run ⇒ 直接复用（不重复等待）；并发/排队中的 run ⇒ 等到终态。
# 墙钟上限 BUILD_WAIT_MAX（默认 3600s）—— 防 run 挂死把本脚本一起拖住。
printf '\n=== [deploy-dev] ② 等待 GitHub 构建：%s ===\n' "$TAG"
if ! command -v gh >/dev/null 2>&1; then
  printf '❌ [deploy-dev] 缺 `gh` CLI（GitHub 构建入口）。装好后 `gh auth login`。\n' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  printf '❌ [deploy-dev] `gh` 未登录 —— `gh auth login` 后重跑。\n' >&2
  exit 1
fi

RUN_ID=""
for _try in $(seq 1 20); do
  RUN_ID="$(gh run list --workflow=images.yml --limit 100 \
    --json databaseId,headBranch \
    --jq "[.[] | select(.headBranch == \"$TAG\")] | sort_by(.databaseId) | last | .databaseId // empty" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && break
  sleep 6
done
if [ -z "$RUN_ID" ]; then
  printf '❌ [deploy-dev] 没找到 tag `%s` 触发的 images 运行。\n' "$TAG" >&2
  printf '   若该 tag 在本仓加入 `dev-*` 触发规则**之前**已存在，重推 tag 才会触发（内容不变）：\n' >&2
  printf '     git push origin :refs/tags/%s && git push origin %s\n' "$TAG" "$TAG" >&2
  exit 1
fi
RUN_URL="$(gh run view "$RUN_ID" --json url --jq '.url // empty' 2>/dev/null || true)"
printf '   run: %s\n' "${RUN_URL:-#$RUN_ID}"

WAIT_MAX="${BUILD_WAIT_MAX:-3600}"
START_TS="$(date +%s)"
TICK=0
while :; do
  READ="$(gh run view "$RUN_ID" --json status,conclusion \
    --jq '[.status, (.conclusion // "")] | @tsv' 2>/dev/null || true)"
  ST="${READ%%$'\t'*}"
  CC="${READ#*$'\t'}"
  if [ "$ST" = "completed" ]; then
    if [ "$CC" = "success" ]; then
      printf '✅ [deploy-dev] GitHub 构建成功（run %s）\n' "$RUN_ID"
      break
    fi
    printf '❌ [deploy-dev] GitHub 构建失败（%s）：%s\n' "${CC:-unknown}" "${RUN_URL:-run $RUN_ID}" >&2
    printf '   修好后重跑：`gh run rerun %s`（或直接重跑本脚本，tag 复用）\n' "$RUN_ID" >&2
    exit 1
  fi
  if [ $(( $(date +%s) - START_TS )) -ge "$WAIT_MAX" ]; then
    printf '❌ [deploy-dev] 等待构建超过 %ss（BUILD_WAIT_MAX）：%s\n' "$WAIT_MAX" "${RUN_URL:-run $RUN_ID}" >&2
    exit 1
  fi
  TICK=$((TICK + 1))
  if [ $((TICK % 6)) -eq 0 ]; then
    printf '   … %s（已等 %ss）\n' "${ST:-unknown}" "$(( $(date +%s) - START_TS ))"
  fi
  sleep 20
done

# ── ③ 部署（deploy.sh：送 compose + 登录 + pull + up -d + 幂等判据 + 冒烟三条）──────
[ -f .env.deploy.local ] || {
  printf '❌ [deploy-dev] 缺 `.env.deploy.local`（deploy 的 SSH 凭据来源，与 deploy.sh 共用）\n' >&2
  exit 1
}
set -a; . ./.env.deploy.local; set +a
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
printf '   服务器腾空间（镜像按 tag 累积）：`docker image prune -a -f`（只删未使用镜像；GHCR 可重拉）\n'
