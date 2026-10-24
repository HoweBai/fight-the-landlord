#!/usr/bin/env bash
# 构建并推送 14 个自建镜像到镜像库。**唯一的构建配方** —— `images.yml` 与 `release.yml`
# 都调它（本仓对「同一事实两处实现」付过多次代价）。
#
# 用法：build-images.sh <tag> [<tag>...]
# 环境：
#   IMAGE_PREFIX  镜像库前缀（默认 `pokergame` = 本地形态；CI 里由工作流传
#                 `ghcr.io/howebai/fight-the-landlord`）
#   PUSH          `1` = `--push`（默认）；`0` = 只构建不推（本机演练用）
#   CACHE         `1` = 用 buildx 的 GHA 缓存（默认，只在 CI 里有效）；`0` = 关
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$#" -lt 1 ]; then
  printf '用法：%s <tag> [<tag>...]\n' "$0" >&2
  exit 2
fi

# ⚠️ **必须显式给 `IMAGE_PREFIX`**：默认值 `pokergame` 得到的是 `pokergame-<svc>` ——
#    **非** registry 限定的名字 ⇒ `bake --push` 会往 `docker.io/library/` 推（推不上去），
#    服务器那条 `docker compose pull` 找的也是 `ghcr.io/...`（拉不到）。
#    CI 里必须给成 `ghcr.io/howebai/fight-the-landlord`。
#    ⚠️ 与**检出目录名**无关（别把这条写成理由）：项目名由顶层 `name: pokergame` 钉死，
#       隐式名本来就不会随目录漂移 —— 实测：不带 `IMAGE_PREFIX` 跑 bake，tag 逐字是
#       `pokergame-*`，目录名一次都不出现。
export IMAGE_PREFIX="${IMAGE_PREFIX:-pokergame}"
PUSH="${PUSH:-1}"
CACHE="${CACHE:-1}"

# ⚠️ `docker buildx bake` 直接读 compose 文件 = **不产生第二份构建真源**
#    （context / dockerfile / build args 全部来自 `docker-compose.yml`）。
#    ⚠️ 实测：`--print` 恰好列出 14 个 target（redis/mysql/node-exporter/cadvisor 无 `build:` ⇒ 不在其中）。
BAKE_ARGS=(-f docker-compose.yml)

# 每个 tag 都要打上（`images.yml` 给 `sha-<短> latest`；`release.yml` 给 `sha-<短> <tag>`）。
# bake 的 tags 由 compose 的 `image:` 决定 ⇒ 逐个 tag 跑一轮（tag 数少，代价可忽略）。
for tag in "$@"; do
  export IMAGE_TAG="$tag"
  args=("${BAKE_ARGS[@]}")
  if [ "$CACHE" = "1" ]; then
    # ⚠️ `mode=max` 才能让被多阶段复用的层（`Dockerfile.edge` 的 web 阶段）也进缓存。
    args+=(--set "*.cache-from=type=gha")
    args+=(--set "*.cache-to=type=gha,mode=max")
  fi
  if [ "$PUSH" = "1" ]; then
    args+=(--push)
  fi
  printf '\n=== [build-images] IMAGE_PREFIX=%s IMAGE_TAG=%s ===\n' "$IMAGE_PREFIX" "$tag"
  docker buildx bake "${args[@]}"
done

# ── cadvisor：**无需搬运**（2026-10-03 订正）────────────────────────────────────
# 早先的「gcr 拉 → retag 推 GHCR」搬运步随事实消亡：cadvisor 的**官方现址 = Google 在 GHCR
# 平台上的 cadvisor 仓**（完整镜像名见 docker-compose.yml 的 cadvisor 块 `image:` 行——**唯一真源**），
# 服务器与开发机**双端实测均可直拉**版本 tag；gcr 路径的版本 tag 已不存在（仅一个陈旧的 `latest`）。

printf '\n=== [build-images] 完成：%s\n' "$(printf '%s ' "$@")"
