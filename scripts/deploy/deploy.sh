#!/usr/bin/env bash
# 把一个既有 tag 部署到 `/srv/pokergame/`。**工作流只调用它** ⇒ 本机也能一条命令演练
# （本仓的「门禁要能本地跑」纪律）。
#
# 用法：deploy.sh <tag>            部署（幂等：**同 tag 重跑**不得出现 `Recreated`；tag 变化时
#                                  `Recreated` 属预期 —— 是否「同 tag 重跑」在 up -d 前从**活栈**判定）
#       deploy.sh --assert-clean   只做部署后断言（C4 的机械闸；由 release.yml 的
#                                  `if: always()` 收尾步骤调用 ⇒ 它**必须能独立跑**）
# 环境（本地演练从 `.env.deploy.local` 读，CI 从密钥库注入 —— **同一套变量名**）：
#   SSH_HOST SSH_USER SSH_KEY SITE_URL GHCR_PULL_TOKEN GHCR_USER
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ 本地演练：从 `.env.deploy.local`（仓库根）读。它被既有规则 `.gitignore:21` 的
#    `.env.*.local` 覆盖（实测 `git check-ignore -v` 命中）⇒ **不需要新规则**。
if [ -f .env.deploy.local ]; then
  set -a; . ./.env.deploy.local; set +a
fi

: "${SSH_HOST:?缺 SSH_HOST}"
USER_="${SSH_USER:-ubuntu}"
: "${SSH_KEY:?缺 SSH_KEY（部署私钥的路径）}"
REMOTE_DIR="/srv/pokergame"
# ⚠️ 复评 Minor·第二轮（注入原语）：凡是**拼进「另一个 shell 会解析的文本」**的值（远端脚本的源码、
#    ssh 的命令串），一律先 `printf %q` 转义成「可被安全重解析的**单个词**」再拼。
#    只加引号**narrow 不 close**：值自带 `"` 时就逃出去了 —— `v1.2.3";id;#` ⇒ 送出的是
#    `export IMAGE_TAG="v1.2.3";id;#"` ⇒ 生产上 `id` 在 `pull` 之前**真的跑**。
#    `%q` 的产物**自带**防护 ⇒ 拼接时**不再**套引号（再包一层 `"…"` 会把 `\;` 之类原样留下，
#    在 `$'…'` 形态上还会直接出错 —— `%q` 只保证「**裸**拼回去」可安全重解析）。
Q_REMOTE_DIR="$(printf '%q' "$REMOTE_DIR")"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
TARGET="$USER_@$SSH_HOST"

ssh_do() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

if [ "${1:-}" = "--assert-clean" ]; then
  # ── C4（R1306③）：把「服务器上无长期凭据」从人工判据升级成**机械闸** ──
  # ⚠️ 为什么必须是**独立入口**（复评 Minor 7：此前这段注释把超时情形说反了）：部署后的
  #    `if: always()` 步骤覆盖的是**普通失败路径**（前面的步骤红了时它仍会跑）；而 job 超时 /
  #    runner 失联时**任何步骤都不会跑** —— 连那个收尾步骤也不跑（`deploy.sh` 自己的 trap 同样
  #    不执行）。那种情况真正兜得住的性质是：**`--assert-clean` 是一个可独立重跑的入口** ——
  #    由下一次运行、或由人手随时再执行一次。
  out="$(ssh_do 'cat ~/.docker/config.json 2>/dev/null || echo "{}"')"
  if printf '%s' "$out" | grep -q 'ghcr.io'; then
    printf '❌ [deploy] 服务器 ~/.docker/config.json 里**仍有** ghcr.io 条目：\n%s\n' "$out" >&2
    exit 1
  fi
  # ⚠️ 只查 `ghcr.io` 会被**凭据助手**骗过去（复评 Minor 8）：配了 `credsStore`/`credHelpers` 时
  #    `docker login` 把凭据写进助手自己的存储，config.json 里一条 ghcr.io 都不留 ⇒ 第三层登出
  #    既没拦住、也没兜住。⇒ 「助手本身」也是服务器上不该有的东西，一并断言。
  if printf '%s' "$out" | grep -qE '"credsStore"|"credHelpers"'; then
    printf '❌ [deploy] 服务器 ~/.docker/config.json 里配了凭据助手（credsStore/credHelpers）—— `docker login` 会把凭据写进**助手自己的存储**，config.json 里看不到 ghcr.io 条目 ≠ 服务器上没有凭据：\n%s\n' "$out" >&2
    exit 1
  fi
  # ⚠️ 终审 M15：目录**还不存在**时不要把这条报成「第二处故障」。第一次部署若失败在**送 compose
  #    之前**（ssh 不通、密钥错、`SSH_HOST` 写错…），release.yml 的 `if: always()` 会把这个收尾
  #    步骤也拉起来 —— 修前它会再报一条「内容不是恰好 .env + docker-compose.yml」，读起来像
  #    「又坏了一处」，恰好在人最需要一条清晰信息的时候。
  #    ⇒ 先探目录：不存在 ⇒ 这条按「不适用」处理（真正的故障在上面那条红里已经说过了）；
  #      ssh 本身失败（拿不到回答）⇒ 仍然**响亮红** —— 否则整条 C4 会在「ssh 坏了」时静默变空测。
  probe="$(ssh_do "test -d $Q_REMOTE_DIR && echo yes || echo no" || true)"
  case "$probe" in
    yes) ;;
    no)
      printf 'ℹ️ [deploy] C4：%s 尚不存在 ⇒ 无文件可查（这一条按「不适用」处理；本次部署多半在更早的步骤就失败了 —— 原因看上面那处红）\n' "$REMOTE_DIR"
      exit 0 ;;
    *)
      printf '❌ [deploy] C4：ssh 探测 %s 失败（拿不到回答）—— 无法完成「只有 .env + docker-compose.yml」这条断言\n' "$REMOTE_DIR" >&2
      exit 1 ;;
  esac
  ls_out="$(ssh_do "ls -A $Q_REMOTE_DIR")"
  # ⚠️ **只有**这两个文件（R1306：服务器上不放仓库、不放部署密钥）。
  # ⚠️ `LC_ALL=C sort`（复评 Minor 6）：期望值 `.env docker-compose.yml ` 是 **C 排序**下的字节序；
  #    某些 locale 里这两个名字的相对次序会反过来 ⇒ 干净服务器也假红。
  if [ "$(printf '%s\n' "$ls_out" | LC_ALL=C sort | tr '\n' ' ')" != ".env docker-compose.yml " ]; then
    printf '❌ [deploy] %s 下的内容不是「恰好 .env + docker-compose.yml」：%s\n' "$REMOTE_DIR" "$ls_out" >&2
    exit 1
  fi
  printf '✅ [deploy] C4：服务器上无 ghcr 凭据、且 %s 只有两个文件\n' "$REMOTE_DIR"
  exit 0
fi

TAG="${1:?用法：deploy.sh <tag> | deploy.sh --assert-clean}"
: "${SITE_URL:?缺 SITE_URL（冒烟的目标，如 https://game.example.com）}"
: "${GHCR_PULL_TOKEN:?缺 GHCR_PULL_TOKEN}"
# ⚠️ `GHCR_USER` 也在这里拦一道：它在**本地**展开（下面 heredoc 里 `-u "$GHCR_USER"` 是本地变量
#    展开后送过去的），缺了它 `set -u` 报的是 `GHCR_USER: unbound variable` 直接死 ——
#    既不是一条「缺 …」提示，还会**跳过**下面的回滚提示（实测：stub 探针）。
: "${GHCR_USER:?缺 GHCR_USER（GHCR 用户名；CI 里是 github.actor）}"

# ⚠️ 下面那条远端 heredoc 里的**一切本地展开**先经 `printf %q`（复评 Minor·第二轮，见 `REMOTE_DIR`
#    处的说明）：它们都以**源码文本**形式进入生产上被 bash 解析的脚本。$TAG 是 dispatch 输入 /
#    argv 的自由文本（此前只加引号 ⇒ 自带 `"` 的载荷可逃逸）；令牌/用户名/URL 同样原理，
#    一并转义 —— 三个 URL 逐个整体转义（而不是拼 `$Q_SITE_URL/…`），免得转义产物与路径拼接。
Q_TAG="$(printf '%q' "$TAG")"
Q_SITE_URL_HEALTH="$(printf '%q' "$SITE_URL/api/health")"
Q_SITE_URL_ROOT="$(printf '%q' "$SITE_URL/")"
Q_SITE_URL_SOCKET="$(printf '%q' "$SITE_URL/socket.io/?EIO=4&transport=polling")"
Q_GHCR_PULL_TOKEN="$(printf '%q' "$GHCR_PULL_TOKEN")"
Q_GHCR_USER="$(printf '%q' "$GHCR_USER")"

# ── 片⑦（裁决 9 / D8-5）：送机 compose = **目标 tag 自己的**，不是本检出 ─────────────
# ⚠️ 必须放在 `--assert-clean` 早退块**之后**（那块是独立入口，不得被 git 操作拖累）。
# ⚠️ 失败 ⇒ 响亮失败（fail-closed）：不静默回退到本检出（那正是「回滚送 master compose
#    ⇒ 拉不存在的 config-service:旧tag ⇒ 中止」的根因，r2 实测）。
git fetch --tags --force >/dev/null 2>&1 || true
COMPOSE_DEPLOY="$(mktemp)"
if ! git show "refs/tags/${TAG}:docker-compose.yml" > "$COMPOSE_DEPLOY" 2>/dev/null; then
  printf '❌ [deploy] 取不到 tag %s 的 docker-compose.yml（回滚目标版本不存在？）——拒绝继续\n' "$TAG" >&2
  exit 1
fi
trap 'rm -f "$COMPOSE_DEPLOY"' EXIT

printf '=== [deploy] 送 compose 基文件到 %s:%s/ ===\n' "$TARGET" "$REMOTE_DIR"
# ⚠️ **只送基文件**（R1306）：override 是**开发面**，不该出现在服务器上。
#    服务器的 `.env` **手工写一次、部署永不覆盖** ⇒ 这里不碰它。
ssh_do "mkdir -p $Q_REMOTE_DIR"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$COMPOSE_DEPLOY" "$TARGET:$REMOTE_DIR/docker-compose.yml"

# ── 片③-B：投递 ops 脚本到 /home/ubuntu/ftl-ops/（设计 §5）──────────────────────────
# ⚠️ 这里**只投文件**（投递 = 与发布同生共死的那一件，与上面送 `docker-compose.yml` 同一条纪律）。
#    「装 cron」与「首次立刻跑一次备份」**不在这里**：它们是 `release.yml` 里
#    `if: github.event_name == 'push'` 的**独立 step**（设计 §3.1 的 ①/②/③）。两条理由都会咬人：
#      ① 本脚本的**任何**非零退出都会打印「❌ 部署失败。回滚命令…」（见下面的 `$rc` 分支）
#         ⇒ 一条备份问题（crontab 坏了 / 盘满）会变成「把**刚发上去的好版本**撤下来」的指令；
#      ② dispatch（回滚）那条路径也跑本脚本 —— 回滚不该被与它无关的备份问题弄红。
# ⚠️ **恰好三个**：`restore-drill.sh` 是开发/CI 工具、`check-backup-fresh.sh` 是 runner 侧的闸
#    —— 两个都**不许**进生产（手册「数据没了怎么办」让读者 `ls /home/ubuntu/ftl-ops/` 到恰好三个）。
# ⚠️ 本段在**不加引号的远端 heredoc 之外**（那段血泪纪律见下面的注释）：不碰它的正文，无需转义。
printf '=== [deploy] 投递 ops 脚本到 %s:/home/ubuntu/ftl-ops/ ===\n' "$TARGET"
ssh_do "mkdir -p /home/ubuntu/ftl-ops && chmod 700 /home/ubuntu/ftl-ops"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
  scripts/ops/backup.sh scripts/ops/restore.sh scripts/ops/install-cron.sh \
  "$TARGET:/home/ubuntu/ftl-ops/"
ssh_do "chmod 700 /home/ubuntu/ftl-ops/*.sh"

printf '=== [deploy] tag=%s 拉取 + 起栈 + 冒烟 ===\n' "$TAG"
# ⚠️ 一整段在一个 ssh 会话里跑：`trap … EXIT` 才能覆盖**所有**失败路径（R1306 三层登出的第 ① 层）。
#    第 ② 层是工作流的 `if: always()`；第 ③ 层是 `--assert-clean`。
# ⚠️ 本 heredoc **不加引号** ⇒ 本地变量在送出**前**展开；因此：
#    * 从本地带过去的展开一律用上面 `printf %q` 转义过的 `Q_*`，且**裸拼**（%q 产物自带防护；
#      复评 Minor·第二轮：只加引号挡不住值自带的 `"` —— `v1.2.3";id;#` 能逃出赋值并在生产上
#      执行 `id`）；
#    * 新加的**远端侧**变量必须写成 `\$…`（否则本地就展开了 —— `set -u` 下直接死）；
#    * 🔴 **反引号（以及 `$(`）一律先转义**（写 `\`` / `\$(`）：不加引号的 heredoc 会做**命令替换**
#      ⇒ 正文里的裸反引号被**本地 shell 执行**、输出按**远端脚本的行**插进去。首次真部署实测：
#      注释里一个裸 `docker compose config --images` ⇒ 9 个镜像名变成远端脚本的第 15–23 行 ⇒
#      `set -e` 在**拉完镜像之后**撞上 `pokergame-game-service:v1.0.0: command not found`（127）。
#      ⚠️ **heredoc 正文不按注释解析** —— 注释行里的反引号同样中招（本地只有 `\n` 的那一层是注释）。
set +e
ssh_do "bash -s" <<REMOTE
set -euo pipefail
cd $Q_REMOTE_DIR
# ⚠️ 登**任何时候**退出都要登出（含中间任一步失败）。
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
echo $Q_GHCR_PULL_TOKEN | docker login ghcr.io -u $Q_GHCR_USER --password-stdin >/dev/null
export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord
export IMAGE_TAG=$Q_TAG
docker compose -f docker-compose.yml pull

# ── 幂等判据的前置（C3 + 复评 Critical + 终审 M2）：这次是不是「同 tag 重跑」？──────────
# 只在**栈上已经恰好跑着「本次要用的镜像」**时，「Recreated」才是违规；tag 变化（每次发布、每次回滚）
# 必然 Recreated ⇒ 那时判据不适用（此前无条件断言 ⇒ 发布/回滚在**成功之后**假红）。判定只看
# **活栈**、在 up -d **之前**做；**不落任何标记文件** —— /srv/pokergame 被 --assert-clean 钉死为
# 恰好「.env + docker-compose.yml」两个文件。
# ⚠️ 终审 M2：「本次要用的镜像名」**派生**自 \`docker compose config --images\` —— 修前是从镜像名
#    **反推**（「恰好以 :\$IMAGE_TAG 结尾」或「以 \$IMAGE_PREFIX- 开头」才算本仓镜像，其余当上游）。
#    反推的漏网形态：服务器上若已是**按默认名**构建的栈（片① 的形态 \`pokergame-*:latest\`、更早的
#    \`ftl-edge:latest\`），那些名字两条都不满足 ⇒ 被当成上游镜像 ⇒ 判成「同 tag 重跑」⇒ \`up -d\`
#    真的重建之后**退出 1**，附一条误导性的回滚提示、且**跳过冒烟**（栈已经换完了，报的却是
#    「同 tag 重跑出了 Recreated」）。派生之后：运行中的镜像只要**不在**本次的镜像集合里
#    （本仓镜像的别的 tag、别的名字，含默认名），就按「tag/名字变了 ⇒ 判据不适用」处理。
#    ⚠️ 上游镜像（redis/mysql）本来就在 \`config --images\` 的集合里 ⇒ 照旧「存在即可」，不受影响。
same_tag=0
services="\$(docker compose -f docker-compose.yml config --services 2>/dev/null || true)"
if [ -n "\$services" ]; then
  same_tag=1
  target_imgs="\$(docker compose -f docker-compose.yml config --images 2>/dev/null | sort -u || true)"
  if [ -z "\$target_imgs" ]; then
    # ⚠️ 派生不出（compose 太老 / 渲染失败）时**不敢认**「同 tag」，但也不能静默 —— 那等于这条
    #    判据整条不生效（R115 同族），所以**响亮**说一句。
    echo "⚠️ [deploy] 无法从「docker compose config --images」派生本次镜像名集合 ⇒ 幂等判据（C3）本次不适用" >&2
    same_tag=0
  fi
  for svc in \$services; do
    [ "\$same_tag" = 1 ] || break
    cid="\$(docker compose -f docker-compose.yml ps -qa "\$svc" 2>/dev/null || true)"
    if [ -z "\$cid" ]; then
      same_tag=0; break          # 有服务还没有容器（首次部署等）⇒ 不是同 tag 重跑
    fi
    img="\$(docker inspect --format '{{.Config.Image}}' "\$cid" 2>/dev/null || true)"
    if [ -z "\$img" ]; then
      same_tag=0; break          # inspect 拿不到镜像名 ⇒ 不敢认「同 tag」
    fi
    if ! printf '%s\n' "\$target_imgs" | grep -Fxq "\$img"; then
      same_tag=0; break          # 跑的不是本次要用的镜像（别的 tag / 别的名字）⇒ 会重建，判据不适用
    fi
  done
fi
if [ "\$same_tag" = 1 ]; then
  echo "ℹ️ [deploy] 前置判定：栈上容器**全部**已在跑本次要用的镜像（:\$IMAGE_TAG）⇒ 同 tag 重跑，幂等判据生效"
else
  echo "ℹ️ [deploy] 前置判定：容器不齐 / 跑的不是本次要用的镜像（:\$IMAGE_TAG）⇒ 首次部署或 tag 变化；Recreated 属预期，幂等判据**不适用**"
fi

echo "───── up -d ─────"
docker compose -f docker-compose.yml up -d 2>&1 | tee /tmp/ftl-up.log
# ⚠️ 幂等（C3）：**同 tag 重跑**不得出现 Recreated。前提：两跑之间没改 .env/compose。
if grep -q Recreated /tmp/ftl-up.log; then
  if [ "\$same_tag" = 1 ]; then
    echo "❌ 幂等判据（C3）：同 tag 重跑出现 Recreated" >&2
    exit 1
  fi
  echo "ℹ️ [deploy] up -d 报了 Recreated —— 首次部署 / tag 变化下的**预期**行为（幂等判据只约束同 tag 重跑）"
fi

echo "───── 冒烟三条（**不带 -k** —— 真证书；单条 curl 有上限，总预算 5 分钟）─────"
# ⚠️ 为什么要**有界重试**（复评 Important 2）：「up -d」返回 ≠ 就绪 —— edge 的 healthcheck 带
#    「start_period: 60s」（docker-compose.yml ≈408 行），网关还要等 redis/mysql 与四个上游；
#    而**首次部署**还多一段**证书签发**（ACME 要回连 80 端口；本仓计划文档写明「几十秒到几分钟」）。
#    ⇒ 预算必须盖得住「冷启动 + 签证书」，否则第一次上线会在**还不可能就绪**时耗尽重试、
#    打出一条误导性的回滚指令（最糟糕的时机给出最糟糕的消息）。
# 🔴 终审 I2：修前三条 curl **没有任何单次上限** ⇒ 「5 分钟」不是上限而是**假话** —— 对端把包
#    **丢掉**（而不是拒绝；手册自己记载「端口没放行」就是这个形态）时，一条 curl 要等内核
#    \`tcp_syn_retries\`（Linux 默认 6 ⇒ ≈130s）才回 ⇒ 60 次的最坏墙钟 ≈2.2 小时。
#    ⇒ 现在有**两层界**：
#      ① 每条 curl 自带 \`--connect-timeout 5 --max-time 15\`（挂死的对端也不再能拖住单次尝试）；
#      ② 总预算 = **墙钟 300s**：只在「剩余预算还装得下一次尝试（3 条 × 15s = 45s）+ 它的间隔
#         （5s）」时才发起下一次 ⇒ 每次尝试都在预算内收尾 ⇒ 总墙钟 ≤ 300s = **5 分钟**（算术见
#         下面循环里的那处判断）。「快失败」形态（连接被拒/503，立即返回）下 60 次 × 5s 间隔
#         ≈ 5 分钟照旧 —— 同一个数兜住两条路径。
#    判据本身**不放松**：仍是同样三条 curl（只多了上限 ⇒ 真证书 + 真 200 —— 不加 \`-k\`、不加
#    \`--insecure\`），耗尽仍**响亮**失败（本地半打印回滚提示并以非零退出）。
SMOKE_BUDGET_S=300          # 总预算（墙钟秒）
SMOKE_ATTEMPT_MAX_S=45      # 一次尝试的硬上限 = 3 条 curl × --max-time 15
SMOKE_SLEEP_S=5             # 两次尝试之间的间隔
smoke() {
  curl -fsS --connect-timeout 5 --max-time 15 $Q_SITE_URL_HEALTH >/dev/null || { echo "  ↳ 冒烟①/api/health 未就绪"; return 1; }
  curl -fsS --connect-timeout 5 --max-time 15 $Q_SITE_URL_ROOT >/dev/null || { echo "  ↳ 冒烟②/ 未就绪"; return 1; }
  curl -fsS --connect-timeout 5 --max-time 15 $Q_SITE_URL_SOCKET | grep -q '"sid"' || { echo "  ↳ 冒烟③socket.io 未就绪"; return 1; }
}
smoke_ok=0
smoke_deadline=\$((SECONDS + SMOKE_BUDGET_S))
for i in \$(seq 1 60); do
  if smoke; then smoke_ok=1; break; fi
  # ⚠️ 终审 I2 的落点：剩余预算装不下「下一次尝试 + 它的间隔」⇒ 停。
  #    归纳：每次尝试**起手时**剩余 > 50s ⇒ 它最迟在剩余 5s 时收尾 ⇒ 总墙钟 ≤ SMOKE_BUDGET_S。
  if [ \$((smoke_deadline - SECONDS)) -le \$((SMOKE_ATTEMPT_MAX_S + SMOKE_SLEEP_S)) ]; then
    echo "⚠️ [deploy] 冒烟第 \$i/60 次未过，且 5 分钟预算只剩 \$((smoke_deadline - SECONDS))s（装不下一次尝试 45s + 间隔 5s）—— 不再重试" >&2
    break
  fi
  if [ "\$i" -lt 60 ]; then
    echo "⚠️ [deploy] 冒烟第 \$i/60 次未过（up -d 返回 ≠ 就绪）—— 5s 后重试" >&2
    sleep 5
  else
    echo "⚠️ [deploy] 冒烟第 60/60 次仍未过 —— 不再重试" >&2
  fi
done
if [ "\$smoke_ok" != 1 ]; then
  echo "❌ [deploy] 冒烟在 5 分钟预算内（最多 60 次）都没过 —— 见上方 ↳ 指出的那条" >&2
  exit 1
fi
echo "✅ [deploy] 冒烟三条通过（第 \$i/60 次尝试）"
# ⚠️ 磁盘卫生（R1307）：**只许 -f**（只删悬空）。加 -a 会删掉上一个 tag 的镜像，
#    把「秒级回滚」变成一次网络拉取。
docker image prune -f
REMOTE
rc=$?
set -e

if [ $rc -ne 0 ]; then
  printf '\n❌ [deploy] 部署失败。回滚命令（把上一个 tag 换上）：\n' >&2
  printf '    bash scripts/deploy/rollback.sh <上一个 tag>\n' >&2
  printf '    或在 GitHub 上跑 release 工作流的 workflow_dispatch，image_tag 填上一个 tag。\n' >&2
  exit $rc
fi
printf '\n✅ [deploy] tag=%s 部署完成\n' "$TAG"
