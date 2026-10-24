#!/usr/bin/env bash
# 片③-B：**人驱动**的恢复 —— 「数据没了能找回来」这条路径的正中央（设计 §4.2）。
#
# 用法（**以 ubuntu 身份、交互式**在服务器上跑）：
#   bash /home/ubuntu/ftl-ops/restore.sh --backup-ts 2026092603 --restore-caddy --restore-env
#
# 顺序**固定**（每一步都有事故可指，别调换）：
#   ① 现场备份（`restore-<ts>`，**在停任何容器之前** —— 证书卷那一步要 `docker exec` 门口容器，
#      停了就再也 exec 不了；而 dump 靠 `--single-transaction` 本来就是一致的，停不停它都一样）
#   ② 停业务面（清单来自 `--app-services`；**空清单 = 演练形态**：②⑥⑦ 整段跳过）
#   ③ 校验（sha256 与 manifest 对得上 + gzip 完整 + mysqldump 的收尾标记）
#   ④ DROP + 灌入（重建靠 dump 自带的 `CREATE DATABASE` ⇒ 字符集/排序规则一起回来）
#   ⑤ 按需还原证书卷 / `.env`（`--restore-caddy` / `--restore-env`，**默认都不还原**）
#   ⑥ **先校验镜像、再**起栈（本地没有那个 tag ⇒ 拒绝；记的是默认名 ⇒ 拒绝）
#   ⑦ 冒烟三条 + 打印「恢复了什么、从哪一份、耗时、属于哪一版代码」
#
# 参数：
#   --project-dir <目录>       在哪个栈上操作（默认 /srv/pokergame）
#   --compose-file <文件>      默认 <project-dir>/docker-compose.yml
#   --env-file <文件>          默认 <project-dir>/.env
#   --app-services "<清单>"    要停/起的业务面**容器名**（空格分隔）；传空串 = 演练形态
#   --mysql-container <名>     默认 ftl-mysql
#   --db-name <库名>           默认 fight_the_landlord（只接受字母数字下划线）
#   --edge-container <名>      证书卷的持有者，默认 ftl-edge
#   --stack-container <名>     从哪里读「运行中的镜像版本」，默认 ftl-api-gateway
#   --backup-dir <目录>        备份目录，默认 /home/ubuntu/ftl-backups
#   --backup-ts <ts>           恢复哪一份（默认：目录里最新的 `ok:true` 那一份）
#   --image-prefix <前缀>      镜像名前缀，默认 ghcr.io/howebai/fight-the-landlord
#   --image-tag <tag>          起栈用哪个 tag（默认：读 ① 现场备份记下的那个）
#   --restore-caddy            还原证书卷（默认**不**还原）
#   --restore-env              还原 `.env`（默认**不**还原）
#   --yes-i-know               **唯一**的非交互豁免开关（演练是它唯一的合法调用者）
#   --help                     打印这张表
#
# ⚠️ 不得在项目目录里留下任何新文件：日志与临时文件一律放 `--backup-dir`。
#    `deploy.sh --assert-clean` 钉死 `/srv/pokergame` 里「恰好 `.env` + `docker-compose.yml`」——
#    恢复路径最自然的实现会就地写 `restore.log` / `.env.bak`，那会让**下一次发布的收尾步骤**
#    在一次成功发布的末尾红（第三轮审查 Important 8）。
# ⚠️ 本脚本不含任何密钥：口令从 mysql 容器自己的 env 取。
# ⚠️ 参数化是为了能在 scratch 环境里**被真跑**（判据 b/c/d/i2/j），不是给生产换姿势。
set -euo pipefail

# ⚠️ Windows 本机迭代（Git Bash）：MSYS 会把交给**原生程序**（docker.exe）的裸参数里以 `/` 开头
#    的路径改写成宿主路径（`tar … -C /data` 之类）。关掉它；Linux/CI 上没有这个变量，此行是 no-op。
export MSYS_NO_PATHCONV=1

usage() { sed -n '2,33p' "$0"; }

PROJECT_DIR=/srv/pokergame
COMPOSE_FILE=""
ENV_FILE=""
APP_SERVICES="ftl-api-gateway ftl-user-service ftl-room-service ftl-game-service ftl-robot-service ftl-douzero ftl-edge"
MYSQL_CONTAINER=ftl-mysql
DB_NAME=fight_the_landlord
EDGE_CONTAINER=ftl-edge
STACK_CONTAINER=ftl-api-gateway
BACKUP_DIR=/home/ubuntu/ftl-backups
BACKUP_TS=""
IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord
IMAGE_TAG=""
RESTORE_CADDY=0
RESTORE_ENV=0
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --app-services) APP_SERVICES="$2"; shift 2 ;;
    --mysql-container) MYSQL_CONTAINER="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --edge-container) EDGE_CONTAINER="$2"; shift 2 ;;
    --stack-container) STACK_CONTAINER="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --backup-ts) BACKUP_TS="$2"; shift 2 ;;
    --image-prefix) IMAGE_PREFIX="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --restore-caddy) RESTORE_CADDY=1; shift ;;
    --restore-env) RESTORE_ENV=1; shift ;;
    --yes-i-know) YES=1; shift ;;
    --help) usage; exit 0 ;;
    *) echo "未知参数：$1（--help 看参数表）" >&2; exit 2 ;;
  esac
done
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

# ── 三道机械闸（优于手册措辞）────────────────────────────────────────────
# ① 身份：备份目录是 0700 ubuntu ⇒ root 写出的产物 ubuntu 读不到 ⇒ 新鲜度假红。
#    （实测「root 写出的 manifest 会假红」只在对产物 chmod 0600 时才成立 ⇒ 光靠手册措辞拦不住。）
if [ "$(id -u)" = 0 ]; then
  echo "拒绝以 root 运行：备份目录是 0700 ubuntu，root 写出的产物 ubuntu 读不到 ⇒ 新鲜度假红。" >&2
  echo "请以 ubuntu 身份运行：ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器>" >&2
  exit 2
fi
# ② 非交互：恢复永远是人决定的事。**唯一**的豁免开关是 --yes-i-know（演练是它唯一的合法调用者）。
if [ ! -t 0 ] && [ "$YES" != 1 ]; then
  echo "拒绝非交互执行（恢复永远是人决定的事）。演练请显式传 --yes-i-know。" >&2
  exit 2
fi
# ③ 空清单只属于演练形态：生产调用**必须**给非空清单（否则 ②⑥⑦ 整段跳过，等于「恢复了但没起栈」）。
if [ -z "$APP_SERVICES" ] && [ "$YES" != 1 ]; then
  echo "拒绝：--app-services 为空（演练形态）却没传 --yes-i-know —— 生产恢复必须给非空清单。" >&2
  exit 2
fi
# 库名要拼进 SQL（`DROP DATABASE`）⇒ 先机械校验，别把注入面留给一个手滑的参数。
case "$DB_NAME" in ''|*[!A-Za-z0-9_]*|[0-9]*) echo "拒绝：--db-name 只接受字母/数字/下划线，且不以数字开头：$DB_NAME" >&2; exit 2 ;; esac

# 日志与临时文件一律放备份目录（**绝不**进项目目录，见文件头）。
mkdir -p "$BACKUP_DIR"
LOG="$BACKUP_DIR/restore.log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
# 日志上限（与 backup.sh 同一条纪律 R1108）：超过 1MB 就留存最后 200 行。
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
START_EPOCH="$(date +%s)"
HERE="$(cd "$(dirname "$0")" && pwd)"

# ── 选一份备份：默认取目录里最新的 ok:true（排除 restore- 那串兜底备份）──────────
if [ -z "$BACKUP_TS" ]; then
  NEWEST=""
  for f in "$BACKUP_DIR"/manifest-*.json; do
    [ -e "$f" ] || continue
    b="${f##*/}"; t="${b#manifest-}"; t="${t%.json}"
    case "$t" in restore-*) continue ;; esac
    grep -q '"ok":true' "$f" || continue
    if [ -z "$NEWEST" ] || [ "$t" \> "$NEWEST" ]; then NEWEST="$t"; fi
  done
  BACKUP_TS="$NEWEST"
fi
if [ -z "$BACKUP_TS" ]; then
  log "拒绝：$BACKUP_DIR 里没有 ok:true 的 manifest ⇒ 没有可恢复的集合（去看手册「备份还活着吗」那节）"
  exit 1
fi

DUMP="$BACKUP_DIR/users-${BACKUP_TS}.sql.gz"
MANIFEST="$BACKUP_DIR/manifest-${BACKUP_TS}.json"
TGZ="$BACKUP_DIR/caddy-data-${BACKUP_TS}.tgz"
ENVGZ="$BACKUP_DIR/env-${BACKUP_TS}.gz"
# 明文 dump 的落地位置（**只在备份目录**，绝不在项目目录）。先落盘再检查、再灌库：
# ⚠️ 不能写 `gzip -dc … | head -c N | grep` —— `head` 提前退出会给 gzip 一个 SIGPIPE，
#    而 `set -o pipefail` 会把 141 当成失败 ⇒ 好 dump 也被判成坏的（实测：这一族的假红很贵）。
PLAIN="$BACKUP_DIR/.users-${BACKUP_TS}-$$.sql"
trap 'rm -f "$PLAIN"' EXIT
log "要恢复的是：$BACKUP_TS（--backup-dir $BACKUP_DIR；业务面清单：「${APP_SERVICES:-<空：演练形态>}」）"

# ── ⓪ 库还在不在？（这决定 ① 有没有东西可保）─────────────────────────────
# 🔴 **实测的坑**（scratch 演练先 `DROP DATABASE` 再恢复时踩到）：库整个没了是最坏的那种事故，
#    而 `mysqldump --databases <不存在的库>` 会失败（`Got error: 1049`）⇒ 若 ① 是「失败即停」，
#    恢复路径就**恰好在最需要它的时候**不可用（本脚本第一版就是这样，演练当场红）。
#    ⇒ 解法**不是**给 ① 开豁免（那是一条「跳过兜底」的后门），而是**先把空库建出来**：
#      现场备份于是如实记下「此刻这个库是空的」—— **这就是此刻的真状态**。
#      ④ 反正会 DROP 掉它再按 dump 灌入 ⇒ 语义不变。
DB_THERE="$(docker exec "$MYSQL_CONTAINER" sh -c \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -B -e \"SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'\"" 2>/dev/null || true)"
if [ "$DB_THERE" != "$DB_NAME" ]; then
  log "⓪ 库 $DB_NAME 现在**不存在**（最坏的事故形态）⇒ 先建一个空库：现场备份要如实记下「此刻是空的」"
  docker exec "$MYSQL_CONTAINER" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'CREATE DATABASE IF NOT EXISTS $DB_NAME'"
fi

# ── ① 现场备份（**在停任何容器之前**；独立锁 ⇒ 会等 cron 让路，不拒）──────────────
log "① 现场备份（restore- 前缀；在停任何容器之前 —— 证书卷那一步要 exec 门口容器）"
bash "$HERE/backup.sh" --dest "$BACKUP_DIR" --artifact-prefix restore- \
  --mysql-container "$MYSQL_CONTAINER" --db-name "$DB_NAME" \
  --edge-container "$EDGE_CONTAINER" --env-file "$ENV_FILE" --stack-container "$STACK_CONTAINER"

SAFETY_MF=""
for f in "$BACKUP_DIR"/manifest-restore-*.json; do
  [ -e "$f" ] || continue
  SAFETY_MF="$f"
done
if [ -z "$SAFETY_MF" ]; then
  log "拒绝：现场备份没留下 manifest ⇒ 不知道刚才那份恢复点在不在，继续下去就失去兜底"
  exit 1
fi
log "   现场备份：${SAFETY_MF##*/}（恢复错了它就是第二次机会）"

# ── ② 停业务面（mysql 与 redis **留着**）──────────────────────────────────
if [ -n "$APP_SERVICES" ]; then
  # 先校验、再动作：清单里有不存在的容器 ⇒ **一个都不停**、立刻拒绝。
  # （否则会「停掉一半才发现名字写错了」，而那时数据库还没换、站已经半死。）
  for svc in $APP_SERVICES; do
    docker inspect --format '{{.State.Status}}' "$svc" >/dev/null 2>&1 || {
      log "拒绝继续：业务面容器 $svc 不存在（--app-services 的清单要和服务器上的容器名一致）。数据库**没有被碰过**；先确认容器名（或先把栈起回来）再来。"
      exit 1
    }
  done
  for svc in $APP_SERVICES; do
    log "② 停 $svc"
    docker stop "$svc" >/dev/null
  done
else
  log "② 跳过：--app-services 为空（演练形态：只走 DB 路径，不停/不起任何业务面容器）"
fi

# ── ③ 校验（sha256 与 manifest 对得上 + 截断检测）─────────────────────────
[ -f "$MANIFEST" ] || { log "拒绝：找不到 $MANIFEST"; exit 1; }
[ -f "$DUMP" ] || { log "拒绝：找不到 $DUMP"; exit 1; }
grep -q '"ok":true' "$MANIFEST" || { log "拒绝：$MANIFEST 不是 ok:true（拿一份失败的备份去覆盖生产 = 第二次事故）"; exit 1; }
# ⚠️ `tr -d '\\'`：MSYS 的 sha256sum 对含反斜杠的路径会加一个 `\` 转义标记（与 backup.sh 同一处理）。
sha_of() { sha256sum "$1" | cut -d' ' -f1 | tr -d '\\'; }
check_sha() { # <key> <file> <说明>
  wish="$(sed -n "s/.*\"$1\":{[^}]*\"sha256\":\"\\([a-f0-9]*\\)\".*/\\1/p" "$MANIFEST" | tail -1)"
  [ -n "$wish" ] || { log "拒绝：manifest 里没有 artifacts.$1.sha256"; exit 1; }
  have="$(sha_of "$2")"
  [ "$wish" = "$have" ] || { log "拒绝：$3 与 manifest 记录的 sha256 对不上（实物被改过或传坏了）—— 记录 $wish，实测 $have"; exit 1; }
}
check_sha users "$DUMP" "dump（users-${BACKUP_TS}.sql.gz）"
[ "$RESTORE_CADDY" = 1 ] && check_sha caddy "$TGZ" "证书卷归档"
[ "$RESTORE_ENV" = 1 ] && check_sha env "$ENVGZ" ".env 归档"
# 解开到 $PLAIN（明文只落在备份目录里）：解压本身失败即坏（截断最经典的来源），
# 之后所有检查都在明文上做（不再有 `gzip | head` 的 SIGPIPE 陷阱）。
gzip -dc "$DUMP" > "$PLAIN"
# 截断检测（比得上 ≠ 数据对，但**比不上**一律是坏的）：mysqldump 的收尾标记在不在。
# ⚠️ **与设计 §4.2 ③ 的偏离，显式记在这里**：设计那句话说「用 manifest 里的**每表行数**做截断检测」，
#    但 manifest **不记行数**（`backup.sh` 的字段集是「恰好七项」：sha256/bytes/结构/版本），
#    而给 manifest 加一列行数会当场破坏判据 a 的「字段集恰好」断言 ⇒ 这个替换是**被逼的**、不是偷懒。
#    替代机制用 mysqldump 自己写在 dump **最后一行**的收尾标记 `-- Dump completed on …`：
#    把 dump 写短的所有经典形态（管道中断、磁盘满、`head -c`）都会首先砍掉这一行，而合法 dump 一定有它。
#    判别力**不靠这句话**：判据 ③ 有一条负对照 —— 合成一份 sha256 自洽、只砍掉收尾行的 dump ⇒ 这里必须红。
tail -c 400 "$PLAIN" | grep -q 'Dump completed' || { log "拒绝：dump 缺 mysqldump 的收尾标记（截断检测）"; exit 1; }
# ⚠️ 还要核一件事：这份 dump 是不是**这个库**的。`--db-name` 打错时，④ 会 DROP 掉 A 库、
#    把 B 库灌进去 —— 而报告上写着「恢复成功」（最坏的一类假信息）。重建靠 dump 自带的
#    `CREATE DATABASE`，所以这里连「重建所需的语句在不在」一起核了。
grep -q "CREATE DATABASE.*\`$DB_NAME\`" "$PLAIN" || {
  log "拒绝：dump 里没有 \`CREATE DATABASE \`$DB_NAME\`\`（不是这个库的备份，或它不是 --databases 产出的）"; exit 1; }
log "③ 校验通过：sha256 对得上、gzip 完整、收尾标记在、库名对得上"

# ── ④ DROP + 灌入（在容器内执行；口令从容器自己的 env 取，不进命令行）─────────
log "④ DROP DATABASE $DB_NAME + 灌入（重建靠 dump 自带的 CREATE DATABASE）"
docker exec "$MYSQL_CONTAINER" sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'DROP DATABASE IF EXISTS $DB_NAME'"
docker exec -i "$MYSQL_CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < "$PLAIN"
log "   灌入完成"

# ── ⑤ 按需还原（各自独立；默认都不还原）───────────────────────────────────
if [ "$RESTORE_CADDY" = 1 ]; then
  log "⑤ 还原证书卷（容器 $EDGE_CONTAINER 的 /data）"
  docker start "$EDGE_CONTAINER" >/dev/null 2>&1 || { log "拒绝：$EDGE_CONTAINER 起不来 ⇒ 无法还原证书卷（它在 ② 里被停了；这步必须能 exec 它）"; exit 1; }
  docker exec "$EDGE_CONTAINER" sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true'
  docker exec -i "$EDGE_CONTAINER" tar xzf - -C /data < "$TGZ"
  log "   证书卷已还原：$(docker exec "$EDGE_CONTAINER" sh -c 'find /data -type f | wc -l' | tr -d ' ') 个文件"
fi
if [ "$RESTORE_ENV" = 1 ]; then
  # ⚠️ 临时文件写在**备份目录**里（不在项目目录里留 `.env.bak` 之类）；跨盘时 `mv` 退化为 copy+unlink，
  #    极端情况下会留半份 —— 但 ① 的现场备份里就是上一份 `.env`，可再取回。
  TMP_ENV="$BACKUP_DIR/.env-restore-$$"
  log "⑤ 还原 .env（$ENV_FILE）"
  gunzip -c "$ENVGZ" > "$TMP_ENV"; chmod 600 "$TMP_ENV"
  mv -f "$TMP_ENV" "$ENV_FILE"
fi

# ── ⑥ 先校验镜像、**再**起栈 ──────────────────────────────────────────────
if [ -n "$APP_SERVICES" ]; then
  if [ -z "$IMAGE_TAG" ]; then
    IMAGE_TAG="$(sed -n 's/.*"image_tag":"\([^"]*\)".*/\1/p' "$SAFETY_MF" | tail -1)"
    USABLE="$(sed -n 's/.*"image_tag_usable":\(true\|false\).*/\1/p' "$SAFETY_MF" | tail -1)"
    case "$IMAGE_TAG" in ''|latest|pokergame*) USABLE=false ;; esac
    if [ "$USABLE" != "true" ]; then
      log "拒绝起栈：现场备份记的镜像版本是「$IMAGE_TAG」（默认名/latest ⇒ image_tag_usable:false）。此刻数据库**已经**被换过了，而拿它 up -d 会去拉一个不存在的镜像 —— 请显式传 --image-tag <版本> 再来。"
      exit 1
    fi
  else
    # 显式传的 tag 也**必须**是有版本号的那个：默认名正是「在数据库已被换掉的那一刻去拉镜像」那条路。
    case "$IMAGE_TAG" in latest|pokergame*) log "拒绝起栈：--image-tag $IMAGE_TAG 是默认名（latest/pokergame-*）—— 恢复路径不允许用它"; exit 1 ;; esac
  fi
  for svc in $APP_SERVICES; do
    img="${IMAGE_PREFIX}-${svc#ftl-}:${IMAGE_TAG}"
    docker image inspect "$img" >/dev/null 2>&1 || {
      # ⚠️ 这是设计自己点名的**最危险的那一刻**：数据库**已经被换过**、站**是停的**。
      #    所以文案不能只说「本地没有」（那把凌晨三点的人留在悬崖上）—— 必须把**怎么继续**写到手上：
      #    先看本机有哪个版本（`docker image ls`），再显式传 `--image-tag <本机确实有的版本>` 重跑。
      log "拒绝起栈：本地没有 $img —— 此刻数据库**已经**被换过、站是停的，别慌：先用 \`docker image ls\` 看本机到底有哪个版本，再显式传 --image-tag <本机确实有的版本> 重跑（重跑安全：① 会再记一份现场备份、④ 按同一份 dump 重灌）。**绝不**让 compose 去拉。"
      exit 1
    }
  done
  export IMAGE_PREFIX IMAGE_TAG
  log "⑥ 起栈（与手册 ④4.1 逐字同形）：docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d（IMAGE_PREFIX=$IMAGE_PREFIX IMAGE_TAG=$IMAGE_TAG）"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
else
  log "⑥ 跳过：--app-services 为空（演练形态不做校验镜像/起栈）"
fi

# ── ⑦ 冒烟三条（与 deploy.sh 同一形态）+ 打印 ─────────────────────────────
if [ -n "$APP_SERVICES" ]; then
  SITE_ADDRESS="$(sed -n 's/^SITE_ADDRESS=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
  if [ -z "$SITE_ADDRESS" ]; then
    log "⚠️ 站已经起来了，但 .env 里没有 SITE_ADDRESS ⇒ 无法冒烟：**没能证明它对外服务是好的**（数据是恢复好了的）"
    exit 1
  fi
  BASE="https://$SITE_ADDRESS"
  SMOKE_BUDGET_S="${SMOKE_BUDGET_S:-90}"
  # 三条**每次都全跑**（不因第一条失败就返回）：一次尝试就把「哪几条没过」讲清，
  # 而不是让人一轮一轮猜（诊断价值高于省两条 curl —— 每次尝试的硬上限仍是 3×15s，与 deploy.sh 同）。
  smoke() {
    bad=0
    curl -fsS --connect-timeout 5 --max-time 15 "$BASE/api/health" >/dev/null || { echo "  ↳ 冒烟①/api/health 未就绪"; bad=1; }
    curl -fsS --connect-timeout 5 --max-time 15 "$BASE/" >/dev/null || { echo "  ↳ 冒烟②/ 未就绪"; bad=1; }
    curl -fsS --connect-timeout 5 --max-time 15 "$BASE/socket.io/?EIO=4&transport=polling" | grep -q '"sid"' || { echo "  ↳ 冒烟③socket.io 未就绪"; bad=1; }
    return "$bad"
  }
  deadline=$((SECONDS + SMOKE_BUDGET_S))
  i=0
  smoke_ok=0
  while :; do
    i=$((i + 1))
    if smoke; then smoke_ok=1; break; fi
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 5
  done
  if [ "$smoke_ok" != 1 ]; then
    log "❌ 冒烟在 ${SMOKE_BUDGET_S}s 预算内（第 $i 次尝试）没过 ⇒ 站可能没起来。**数据已经恢复好了**，先把站弄起来（见手册 ⑥）；现场备份在 ${SAFETY_MF##*/}。"
    exit 1
  fi
  log "⑦ 冒烟三条通过（第 $i 次尝试）"
else
  log "⑦ 跳过：--app-services 为空（演练形态不做冒烟）"
fi

ELAPSED=$(( $(date +%s) - START_EPOCH ))
# ⚠️ 收尾行必须**自己**说出「站没起」（复核 Minor 8）：②⑥⑦ 的跳过行在**输出中段**，而凌晨三点的人
#    只读最后一行。演练形态（`--app-services ""` + `--yes-i-know`）是一串**可以被照抄进生产**的参数，
#    而「✅ 恢复完成」不带这个前提读起来就是「站已经好了、对外在服务」—— 那是本仓点名的假信息形态。
DRILL_NOTE=""
if [ -z "$APP_SERVICES" ]; then
  DRILL_NOTE="（演练形态：②⑥⑦ 已跳过 —— 站未起、未冒烟）"
fi
log "✅ 恢复完成：恢复的是 $BACKUP_TS 那一份（--backup-dir $BACKUP_DIR），耗时 ${ELAPSED}s，属于镜像版本 ${IMAGE_TAG:-（本形态不用）}；兜底现场备份在 ${SAFETY_MF##*/}$DRILL_NOTE"
