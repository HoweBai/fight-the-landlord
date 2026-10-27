#!/usr/bin/env bash
# HBuilderX 云打包 APK + **端点注入校验**（2026-10-27 白屏事故的防复发入口）。
#
# 用法：bash scripts/deploy/pack-apk.sh <host[:port]> [--publish]
#   例：bash scripts/deploy/pack-apk.sh ssh.yobeeo.com
#       bash scripts/deploy/pack-apk.sh ssh.yobeeo.com --publish   # 同时上传 Release + 秒传测试服
#
# 背景（真实事故）：HBuilderX 云打包**不经过** scripts/build-app.mjs，读的是 `.env*` 文件。
# 缺 `apps/client/.env.production.local` ⇒ App 启动 `session.start` 抛
# 「VITE_WS_ENDPOINT 为空」⇒ `createInstanceContext` 失败 ⇒ 白屏。
# 本脚本：写端点文件 → 云打包 → 下载 → **校验产物含端点** → 可选发布。
#
# 环境变量：HX_CLI（默认 E:/Softwares/HBuilder X/cli.exe）、
#           APK_NAME（默认 优比棋牌.apk）、APK_PACKAGE（默认 com.yobeeo.pokergame）。
# ⚠️ 版本号在 apps/client/src/manifest.json（versionCode 必须递增）。
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${1:-}"
PUBLISH="${2:-}"
if [ -z "$HOST" ] || [ "$HOST" = "-h" ] || [ "$HOST" = "--help" ]; then
  printf '用法：bash scripts/deploy/pack-apk.sh <host[:port]> [--publish]\n'
  exit 0
fi
case "$HOST" in
  http://* | https://*) printf '❌ 只传 host[:port]（不要带协议）：%s\n' "$HOST" >&2; exit 1 ;;
  localhost* | 127.* | 0.0.0.0*) printf '❌ 真机不可达的地址：%s（用域名或局域网 IP）\n' "$HOST" >&2; exit 1 ;;
esac
HX_CLI="${HX_CLI:-E:/Softwares/HBuilder X/cli.exe}"
APK_NAME="${APK_NAME:-优比棋牌.apk}"
APK_PACKAGE="${APK_PACKAGE:-com.yobeeo.pokergame}"
[ -x "$HX_CLI" ] || {
  printf '❌ 找不到 HBuilderX CLI：%s（可用 HX_CLI 覆盖）\n' "$HX_CLI" >&2
  exit 1
}
PROJECT="$(pwd)/apps/client"
if command -v cygpath >/dev/null 2>&1; then PROJECT="$(cygpath -w "$PROJECT")"; fi

# ① 端点文件（gitignore 覆盖：.env.*.local）
cat > apps/client/.env.production.local <<EOF
# 由 scripts/deploy/pack-apk.sh 生成（本机专用，不入库）
VITE_WS_ENDPOINT=https://$HOST
VITE_API_BASE=https://$HOST/api
EOF
printf '✅ [pack-apk] 已写入 apps/client/.env.production.local（%s）\n' "$HOST"

# ② 云打包
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
printf '⏳ [pack-apk] HBuilderX 云打包中（2–5 分钟）…\n'
"$HX_CLI" pack --project "$PROJECT" --platform android \
  --android.packagename "$APK_PACKAGE" --android.androidpacktype 3 \
  --unimpads true --ad.domestic sigmob >"$LOG" 2>&1
URL="$(grep -aoE 'https://app\.liuyingyong\.cn/build/download/[a-f0-9-]+' "$LOG" | tail -1)"
if [ -z "$URL" ]; then
  printf '❌ [pack-apk] 未拿到下载链接 —— HBuilderX 输出：\n' >&2
  tail -20 "$LOG" >&2
  exit 1
fi
printf '⬇️ [pack-apk] %s\n' "$URL"

# ③ 下载 + 产物校验（缺端点 ⇒ 拒绝发布，防再次白屏）
mkdir -p deploy/download
curl -L --fail -o "deploy/download/$APK_NAME" "$URL"
if ! unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/app-service.js" \
  | grep -q "$HOST"; then
  printf '❌ [pack-apk] 产物 app-service.js 未注入端点 %s —— 打包会白屏，拒绝继续\n' "$HOST" >&2
  exit 1
fi
VER="$(unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/manifest.json" 2>/dev/null \
  | grep -oE '"version":\{[^}]*\}' | head -1 || true)"
printf '✅ [pack-apk] 端点已注入；版本 %s\n' "${VER:-（未知）}"
printf '   产物：deploy/download/%s（%s bytes）\n' "$APK_NAME" "$(wc -c <"deploy/download/$APK_NAME" | tr -d ' ')"

# ④ 可选发布
if [ "$PUBLISH" = "--publish" ]; then
  bash scripts/deploy/publish-apk.sh "deploy/download/$APK_NAME"
  bash scripts/deploy/preview.sh download
  printf '\n🎉 [pack-apk] 已发布：Release apk-latest + 测试服 /download/%s\n' "$APK_NAME"
else
  printf '\n下一步：bash scripts/deploy/publish-apk.sh deploy/download/%s\n' "$APK_NAME"
  printf '        或立即预览：bash scripts/deploy/preview.sh download\n'
fi
