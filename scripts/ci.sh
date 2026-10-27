#!/usr/bin/env bash
# §13.4 的 CI 六阶段（R269）。阶段名与顺序**逐字**照规格。
#
# ⚠️ 本脚本是「门槛」的门面：**必须失败即非零退出**，且每阶段都要在输出里可辨认 ——
#    否则「六个阶段都跑过了」无法从原文判读（本仓已有两次「判据恒绿」的前科：
#    `allFilesStillHttp`、`NOT_YET_MIGRATED`）。
#
# ⚠️ 本文件是六阶段的**单一真源**：`.github/workflows/ci.yml` 只做薄调用，
#    **不得**在 YAML 里重抄一遍（那是第二个真源，本仓为「第二真源」付过多次代价）。
set -euo pipefail
cd "$(dirname "$0")/.."

# ─── 阶段计时（每阶段都要能被单独观测）───────────────────────────────
STAGE_NAME=''
STAGE_START=0

stamp() { date +%s; }

finish_stage() {
  if [ "$STAGE_START" -ne 0 ]; then
    printf '=== [ci] %s 结束（耗时 %ss）===\n' "$STAGE_NAME" "$(( $(stamp) - STAGE_START ))"
  fi
  STAGE_START=0
}

stage() {
  finish_stage
  STAGE_NAME="$1"
  STAGE_START="$(stamp)"
  printf '\n=== [ci] %s ===\n' "$STAGE_NAME"
}

# 失败时必须能一眼看出**是哪个阶段**失败的。
trap 'printf "\n!!! [ci] 阶段「%s」失败（见上方输出）\n" "$STAGE_NAME" >&2' ERR

# ─── 第 6 阶段的闸执行器：跑一条源码闸，并**验证它真的跑了用例** ──────────
#
# ⚠️ 为什么需要这一层：`pnpm --filter X test -- <过滤名>` 里的过滤名一旦与实际文件名
#    脱节，vitest 会**一个用例都不跑**（或直接报 no test files）—— 前者正是「闸恒绿」
#    的形态（本仓 R115 的规矩：先证明探针有效，再相信它的结论）。
#    因此这里**捕获并打印**输出，再断言 `Tests  <n> passed` 且 n ≥ 1。
run_gate() {
  local label="$1"
  shift
  local out passed
  if ! out="$("$@" 2>&1)"; then
    printf '%s\n' "$out"
    printf '!!! [ci] %s 失败\n' "$label" >&2
    return 1
  fi
  printf '%s\n' "$out"
  # ⚠️ **必须先剥掉 ANSI 转义再解析**。彩色输出的汇总行长这样：
  #   ESC[2m      Tests ESC[22m ESC[1mESC[32m23 passed ESC[39m
  # —— `Tests` 与数字之间夹着转义序列，而下面的正则只允许**空格**。
  # 不剥颜色，正则对**每一道** gate 都恒不匹配 ⇒ 守卫会对全部 6 道闸误报「0 用例」。
  # （vitest 在 `TERM=xterm-256color` 下会着色，**即使输出被管道捕获**。）
  plain="$(printf '%s\n' "$out" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g')"
  passed="$(printf '%s\n' "$plain" | sed -nE 's/.*Tests +([0-9]+) passed.*/\1/p' | tail -n 1)"
  if [ -z "$passed" ] || [ "$passed" -lt 1 ]; then
    printf '!!! [ci] %s 没有跑任何用例（Tests=%s）—— 过滤名失效会让这道闸恒绿\n' \
      "$label" "${passed:-0}" >&2
    return 1
  fi
  printf '[ci] %s ✓ %s passed\n' "$label" "$passed"
}

# ─── 1/6 install ────────────────────────────────────────────────────
stage "1/6 install"
# ⚠️ `--frozen-lockfile` **始终保留**：它是这条判据的语义（lockfile 必须与 package.json
#    同步，CI 不得静默改依赖解析）。
#
# ⚠️ `--store-dir` 只在本机出现：本机沙箱禁止写工作区之外的 `~/.pnpm-store`，
#    实测 `pnpm install --frozen-lockfile` 直接
#    `ERR_PNPM_EACCES … open '/home/howe/.pnpm-store/v3/files/…'`（详见执行期裁决 R285）。
#    判据不变、只是让 store 落在工作区内；**真正的 CI 上 `.pnpm-store` 不存在**
#    （`.gitignore` 已忽略它）⇒ 该参数不出现，命令与 §13.4 逐字一致。
STORE_ARG=()
if [ -d .pnpm-store ]; then
  STORE_ARG=(--store-dir .pnpm-store)
fi
pnpm install --frozen-lockfile ${STORE_ARG[@]+"${STORE_ARG[@]}"}
finish_stage

# ─── 2/6 lint（`tsc --noEmit`，全包）────────────────────────────────
stage "2/6 lint"
pnpm exec turbo run lint --force
finish_stage

# ─── 3/6 build（`turbo run build`）──────────────────────────────────
stage "3/6 build"
pnpm exec turbo run build --force
finish_stage

# ─── 4/6 test（`turbo run test`）───────────────────────────────────
stage "4/6 test"
pnpm exec turbo run test --force
finish_stage

# ─── 5/6 coverage（shared ≥ 80%，低于门槛失败）─────────────────────
stage "5/6 coverage (shared ≥ 80%)"
# 门槛写在 `packages/shared/vitest.config.ts` 的 `test.coverage.thresholds.lines`（R270）
# ⇒ 低于 80% 时这条**非零退出**（本片已实测：临时改成 99 ⇒ 红）。
pnpm --filter @fight-the-landlord/shared test:coverage
finish_stage

# ─── 6/6 eslint-forbidden（§12.4，发现 FORBIDDEN 即阻断）───────────
stage "6/7 eslint-forbidden (§12.4)"
# R268：本仓的 §12.4 落地形态是 **vitest 源码级闸**（不是 ESLint 插件）——
# 它们同属「FORBIDDEN 必须被机械拦住」这一性质，逐个列出以便从输出判读覆盖面。
# 阶段名**逐字**保留规格的 `eslint-forbidden`（名字是规格的，形态是本仓的）。
run_gate "client/source-boundary" \
  pnpm --filter @fight-the-landlord/client test -- source-boundary
run_gate "room-service/no-internal-http.gate" \
  pnpm --filter @fight-the-landlord/room-service test -- no-internal-http.gate
run_gate "api-gateway/outbound-timeout.gate" \
  pnpm --filter @fight-the-landlord/api-gateway test -- outbound-timeout.gate
run_gate "api-gateway/no-route-outside-api.gate" \
  pnpm --filter @fight-the-landlord/api-gateway test -- no-route-outside-api.gate
run_gate "game-service/rule-error-mapping" \
  pnpm --filter @fight-the-landlord/game-service test -- rule-error-mapping
# P7（R361）：防「遗留第二契约在 shared 里复活」的源码闸 —— 它守的是「§6.3 是消息名清单真源」
# 这条性质（`seq` / 应用层 `ping` / 已废除的旧消息名都不得再出现在 `packages/shared/src`）。
run_gate "shared/no-legacy-message-names.gate" \
  pnpm --filter @fight-the-landlord/shared test -- no-legacy-message-names.gate
finish_stage

printf '\n=== [ci] 六阶段全部通过 ===\n'

stage "7/8 admin/agent/monitoring static verify"
npm run verify:admin
npm run verify:admin-players
npm run verify:agent
npm run verify:monitoring
finish_stage

stage "8/8 k8s static verify"
npm run verify:k8s
npm run verify:shutdown
if command -v kubectl >/dev/null 2>&1; then
  kubectl kustomize k8s/overlays/prod > /tmp/ftl-k8s-rendered.yaml
  node scripts/verify-k8s-manifests.mjs --file /tmp/ftl-k8s-rendered.yaml
else
  printf '⚠️ 无 kubectl，跳过渲染校验（清单原始闸已跑）\n'
fi
finish_stage

printf '\n=== [ci] 八阶段全部通过 ===\n'
