#!/usr/bin/env bash
# 上传/替换 APK 到 GitHub Release 资产（2026-10-27）。`images` workflow 构建前会把它
# 拉进 `deploy/download/` 再烘进 edge 镜像（fail-closed：拉不到就拒绝构建）。
#
# 用法：bash scripts/deploy/publish-apk.sh <apk路径> [release-tag]
#   默认 release-tag = `apk-latest`（可用环境变量 APK_RELEASE_TAG 覆盖；
#   与 images.yml 的 `vars.APK_RELEASE_TAG` 保持同名语义）。
#
# ⚠️ 资产名保持**原文件名**（uni-ad 表单填的是 `/download/优比棋牌.apk`，逐字一致）。
# ⚠️ Release tag `apk-latest` 不是版本 tag（不匹配 `v*` / `dev-*`）⇒ 不会触发任何 workflow。
# ⚠️ 只上传/替换资产，不重建 APK —— APK 仍由 HBuilderX 云打包产出（见 deploy/download/README.md）。
set -euo pipefail
cd "$(dirname "$0")/../.."

APK="${1:-}"
TAG="${2:-${APK_RELEASE_TAG:-apk-latest}}"
if [ -z "$APK" ] || [ "$APK" = "-h" ] || [ "$APK" = "--help" ]; then
  printf '用法：bash scripts/deploy/publish-apk.sh <apk路径> [release-tag（默认 apk-latest）]\n'
  exit 0
fi
[ -f "$APK" ] || {
  printf '❌ [publish-apk] 文件不存在：%s\n' "$APK" >&2
  exit 1
}
case "$APK" in
  *.apk | *.APK) ;;
  *) printf '❌ [publish-apk] 不是 .apk 文件：%s\n' "$APK" >&2; exit 1 ;;
esac
command -v gh >/dev/null 2>&1 || {
  printf '❌ [publish-apk] 缺 `gh` CLI\n' >&2
  exit 1
}
gh auth status >/dev/null 2>&1 || {
  printf '❌ [publish-apk] `gh` 未登录 —— `gh auth login` 后重跑\n' >&2
  exit 1
}

ASSET_NAME="youbi-pokergame.apk"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$APK" "$STAGE/$ASSET_NAME"
echo "ℹ️ [publish-apk] Release=$TAG · 资产=$ASSET_NAME（$(wc -c <"$APK" | tr -d ' ') bytes；本地名 $(basename "$APK")）"
if gh release view "$TAG" >/dev/null 2>&1; then
  # 清掉历史资产名（含曾被 gh 改写的 default.apk / 中文名），保证资产集合可预期。
  gh release delete-asset "$TAG" "default.apk" --yes >/dev/null 2>&1 || true
  gh release delete-asset "$TAG" "优比棋牌.apk" --yes >/dev/null 2>&1 || true
  gh release upload "$TAG" "$STAGE/$ASSET_NAME" --clobber
  echo "✅ [publish-apk] 已替换 Release $TAG 的资产"
else
  gh release create "$TAG" "$STAGE/$ASSET_NAME" --title "APK 发布资产" --notes "APK 分发资产（不参与版本 tag；由 scripts/deploy/publish-apk.sh 更新）" --prerelease
  echo "✅ [publish-apk] 已创建 Release $TAG 并上传资产"
fi

gh release view "$TAG" --json assets --jq '.assets[] | [.name, .size] | @tsv'
printf '\n下一步：正式部署（bash scripts/deploy/deploy-dev.sh）时 images 构建会自动带上该 APK；\n'
printf '        或立即预览：bash scripts/deploy/preview.sh download\n'
