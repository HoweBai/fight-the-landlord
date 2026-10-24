#!/usr/bin/env bash
# 片③-B：一次备份。由 cron 每小时调用；也可由 restore.sh 以 --artifact-prefix restore- 调用。
# ⚠️ 不含任何密钥：口令从 mysql 容器自己的 env 取。
# ⚠️ 不引任何新镜像：证书卷用已在机器上的 edge 容器打包。
set -euo pipefail

# ⚠️ Windows 本机迭代（Git Bash/MSYS）：MSYS 会把交给**原生程序**（docker.exe）的裸参数里
#    以 `/` 开头的路径改写成宿主路径 —— `tar … -C /data` 里的 `/data` 会被换成
#    `E:/Softwares/Git/data`（本机实测）⇒ 容器里 tar 直接失败。关掉这个转换；Linux/CI 上
#    没有这个变量，此行是 no-op。（scratch 演练与本机迭代都要走这条路径。）
export MSYS_NO_PATHCONV=1

DEST=/home/ubuntu/ftl-backups
RETENTION_DAYS=14
MIN_FREE_MB=2048
MYSQL_CONTAINER=ftl-mysql
DB_NAME=fight_the_landlord
EDGE_CONTAINER=ftl-edge
ENV_FILE=/srv/pokergame/.env
STACK_CONTAINER=ftl-api-gateway
ARTIFACT_PREFIX=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --min-free-mb) MIN_FREE_MB="$2"; shift 2 ;;
    --mysql-container) MYSQL_CONTAINER="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --edge-container) EDGE_CONTAINER="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --stack-container) STACK_CONTAINER="$2"; shift 2 ;;
    --artifact-prefix) ARTIFACT_PREFIX="$2"; shift 2 ;;
    --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# 监控片（规格 §2.9）：textfile 指标 —— node-exporter 的 `--collector.textfile.directory=/textfile`
# 读这里写的 backup.prom ⇒ Prometheus 抓 node-exporter ⇒ 备份新鲜度**上板**（只上板、不设规则，§2.4bis）。
# 本块**必须**装在参数解析完成之后（Y6——理由见 trap 行前的注释）；目录 755 / 文件 644（node-exporter
# 以 nobody 读）、原子写（tmp + mv）；目录本身由 install-cron.sh 在发布流水线里先建好（先于 compose up）。
TEXTFILE_DIR="${TEXTFILE_DIR:-/home/ubuntu/ftl-monitoring/textfile}"   # 测试注入点；生产不设

write_textfile() {                     # EXIT trap：ok / failure 两态（Y6）
  local code=$? now result prev="" cur tmp
  mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
  cur="$TEXTFILE_DIR/backup.prom"; tmp="$cur.tmp.$$"
  # `tr -d '\r'`：旧文件若被手工编辑成 CRLF，GNU sed 会把 `\r` 带进值 ⇒ Prometheus 解析器
  # 无 `\r` 处理、**整文件**解析失败（T11 审查 N2 硬化：防御手工脏文件，本机 MSYS sed 本就剥离）。
  [ -f "$cur" ] && prev=$(sed -n 's/^backup_last_success_timestamp_seconds //p' "$cur" | head -1 | tr -d '\r')
  now=$(date +%s)
  case "$code" in
    0) result=ok ;;
    *) result=failure ;;   # 锁竞争（拿不到锁 exit 1；符号引用——行号会随文件漂移，M1 同款教训）与真失败同码 ⇒ 同为 failure。
                           # Y6：值域收缩为 {ok,failure}——不加独立退出码（避免碰 slice-07.5 对锁路径的既有断言）
  esac
  { echo "# HELP backup_last_attempt_timestamp_seconds Last backup attempt (epoch)."
    echo "backup_last_attempt_timestamp_seconds $now"
    echo "# HELP backup_last_attempt_result Last backup result (series present = current state)."
    echo "backup_last_attempt_result{result=\"$result\"} 1"
    if [ "$result" = "ok" ]; then echo "backup_last_success_timestamp_seconds $now"
    elif [ -n "$prev" ]; then echo "backup_last_success_timestamp_seconds $prev"; fi
  } > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$cur" \
    || log "WARN: textfile 写入失败（不影响备份本身）"
}
# ⚠️ trap 必须装在**参数解析完成之后**（Y6）：早装会把 `--help`（exit 0）写成假的 ok+成功时间戳、
#    未知参数（exit 2）写成假 failure。
trap write_textfile EXIT

# 🔴 戳的**粒度按用途分**（收尾复核 Important）：
#    · cron 那条小时链（无前缀）：10 位 `%Y%m%d%H` —— **定宽 ⇒ 字典序 = 时间序**，保留期（ⓕ）与
#      新鲜度闸（`check-backup-fresh.sh` 的年龄算术）都按这个口径读，**不许动**。
#    · 现场备份（`--artifact-prefix restore-`）：**秒粒度 14 位** `%Y%m%d%H%M%S`。
#      抓的失败：10 位戳下，同一个 UTC 小时内恢复**第二次**时，① 的 `mv -f` 会把**第一次那份**
#      现场备份（= 真正该留住的「恢复前现场」）覆盖成「此刻的库」—— 也就是刚被灌错的那一份；
#      ③ 拿它跟它自己刚写的那份 manifest 比 ⇒ 照样通过；收尾行照旧说「恢复完成：恢复的是
#      restore-<ts> 那一份」—— 而手册把那份卖作「恢复错了的**第二次机会**」⇒ 兜底**在需要它
#      的那一刻**消失，且**没有一句话**说它消失了。人的窗口 = 「发现恢复错了」的几分钟，
#      撞上 60 分钟边界 ⇒ 约 5/6 的二次恢复会把兜底毁掉。
#      ⚠️ **不许**改成「拒绝覆盖」来修：`restore.sh` 的缺镜像文案明写「重跑安全：① 会再记一份
#      现场备份」⇒ 同一小时内重跑是**被鼓励**的；硬闸会把凌晨三点的人困死在最坏的那一刻。
#      （唯一要变的只有名字：秒粒度下两次调用的名字必然不同。）
if [ -n "$ARTIFACT_PREFIX" ]; then
  TS="$(date -u +%Y%m%d%H%M%S)"
else
  TS="$(date -u +%Y%m%d%H)"
fi
NAME="${ARTIFACT_PREFIX}${TS}"
mkdir -p "$DEST"
chmod 700 "$DEST"

LOG="$DEST/backup.log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
# 日志上限（R1108 同族）：超过 1MB 就留存最后 200 行
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# ⓞ 空间预检（设计 §4.1）：可用 < 阈值 ⇒ **不跑**并失败 —— 把「盘满时备份加速拖死生产库」
#    降级成「备份自己失败」（保护生产库优先于「多做一份备份」）。
# ⚠️ 位置对计划文本有一处偏离（Task 2 实测，两处都是真的会咬人）：
#    计划写「插在 `TS=` 之前」，但那里 ① `log()` 还没定义 ⇒ `log: command not found`（exit 127）；
#    ② `mkdir -p "$DEST"` 还没跑 ⇒ `df` 对不存在的目录输出为空 ⇒ `[ -n "$AVAIL_MB" ]` 直接
#    **跳过检查**（fail-open，本机实测 df 对不存在的路径输出 0 行）。放在 `mkdir/chmod` 与日志
#    机制之后、任何备份动作之前 —— 语义（预检不过就不开工）不变，只把「工具还没准备好」修掉。
AVAIL_MB="$(df -Pm "$DEST" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
  log "FAILED: 可用空间 ${AVAIL_MB}MB < ${MIN_FREE_MB}MB ⇒ 本次不备份"
  exit 1
fi

# 🔒 锁（设计 §3.1 性质 3：**两个不同的锁**）：
#    · cron（默认）：`$DEST/.lock`，`-w 0` ⇒ 拿不到就算**这一次失败**（不是「跳过」）
#    · 现场备份（`--artifact-prefix restore-`）：`$DEST/.restore-lock`，**等待 + 超时**
#      —— 救人用的锁不能因为一次 cron 正在跑就被拒（恢复路径的第一步是硬步骤）
# 🔴 先机械地确认 `flock` 在：**工具缺失**与**锁被占**是两件事，文案必须分得开 ——
#    没有这次预检时 `if ! flock …` 会把「本机没这个工具」误报成「拿不到锁」，
#    本机实测（Windows 的 Git Bash 不带 util-linux）：日志里就是那么一句**假话**。
# 两条支路（用户裁决 2026-09-26）：
#    · flock 在（生产 Ubuntu / CI，util-linux 自带）：走下面的真锁 —— **行为与加此分支前逐字相同**
#      （`-w 0` 拿不到 = 这一次失败；`restore-` 用 `.restore-lock` 等待 + 超时）
#    · flock 不在（如 Windows 的 Git Bash）：**响亮告警后继续（不上锁）**。理由：锁防的是两个
#      并发备份；开发机连锁工具都没有时，「整个脚本不跑」比「这一次没上锁」代价更大
#      （后续任务在本机全都要迭代）。告警把后果写清 ⇒ 没人会把无锁跑误当成有锁跑。
#      生产/CI 恒有 flock ⇒ 永远不会走到这一支，那里的行为**一个字都不变**。
if ! command -v flock >/dev/null 2>&1; then
  log "WARNING: 本机没有 flock（util-linux）⇒ 本次运行**未上锁**、不受并发保护：可能与另一备份（cron/现场）同时跑！"
  log "WARNING: 上面这一支只出现在缺工具的机器上（本机迭代用）；生产/CI 恒有 flock ⇒ 恒走真锁，无此告警。"
else
  if [ -n "$ARTIFACT_PREFIX" ]; then
    LOCK="$DEST/.restore-lock"; LOCK_WAIT=60    # 救人用的锁：等待 + 超时
  else
    LOCK="$DEST/.lock"; LOCK_WAIT=0             # cron：拿不到就算这次失败
  fi
  exec 9>"$LOCK"
  if ! flock -w "$LOCK_WAIT" 9; then
    log "FAILED: 拿不到锁 $LOCK"
    exit 1
  fi
fi

MANIFEST="$DEST/manifest-${NAME}.json"
FAILED_AT=""
ok=0
write_manifest() {
  local arts="$1" caddy_entries="$2" tag="$3" usable="$4"
  local okv="false"; [ "$ok" = 1 ] && okv="true"
  printf '{"ts":"%s","ok":%s,"failed_at":%s,"artifacts":%s,"caddy_entries":%s,"image_tag":"%s","image_tag_usable":%s}\n' \
    "$(date -u +%FT%TZ)" "$okv" \
    "$([ -n "$FAILED_AT" ] && printf '"%s"' "$FAILED_AT" || printf 'null')" \
    "$arts" "$caddy_entries" "$tag" "$usable" > "$MANIFEST"
}
# ⚠️ `tr -d '\\'`：MSYS 的 sha256sum 对**含反斜杠的路径**（Windows 本机迭代时 `--dest` 就是
#    反斜杠路径）会在哈希前加一个 `\` 转义标记（`\<hash>  C:\\…`）⇒ 直接拼进 manifest 就是
#    **非法 JSON 转义**（JSON.parse 报 "Bad escaped character"，本机实测）⇒ 只取裸哈希。
#    Linux/CI 上没有这个前导符，此行是 no-op。
sha_of() { sha256sum "$1" | cut -d' ' -f1 | tr -d '\\'; }

# ⓐ mysqldump（四条硬要求，见 doc；pipefail 已由 set -o pipefail 覆盖）
DUMP="$DEST/users-${NAME}.sql.gz"
if docker exec "$MYSQL_CONTAINER" sh -c \
     "mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --set-gtid-purged=OFF --databases '$DB_NAME'" \
     | gzip > "$DUMP.tmp"; then
  mv "$DUMP.tmp" "$DUMP"
else
  FAILED_AT="mysqldump"; rm -f "$DUMP.tmp"; write_manifest '{}' 0 '' false
  log "FAILED at mysqldump"; exit 1
fi

# ⓑ 证书卷（用已在机器上的 edge 容器；空卷也要如实记录条目数）
TGZ="$DEST/caddy-data-${NAME}.tgz"
if docker exec "$EDGE_CONTAINER" tar czf - -C /data . > "$TGZ.tmp" 2>/dev/null; then
  mv "$TGZ.tmp" "$TGZ"
else
  FAILED_AT="caddy-tar"; rm -f "$TGZ.tmp"; write_manifest '{}' 0 '' false
  log "FAILED at caddy-tar"; exit 1
fi
CADDY_ENTRIES="$(docker exec "$EDGE_CONTAINER" sh -c 'find /data -type f | wc -l' | tr -d ' ')"

# ⓒ .env（**剥离主钥** —— 支付配置管理化片 ⚙️14 / 用户 Q3 裁决）
#    · `PAY_CONFIG_ENC_KEY`（渠道密钥存储主钥）**不进备份**：备份产物会被恢复/演练投递到别处，
#      主钥只留在服务器 `.env`，副本由用户另行自持（恢复手册行文同步该口径，手册本体属 T17）。
#    · 为什么用 awk 而不是裸 `grep -v`：源里若只剩该行（或剥完为空），`grep -v` 输出为空 ⇒ **exit 1**
#      ⇒ 在 `set -o pipefail` 下整个管道变失败，被误判成「这份 .env 备份失败」走 FAILED_AT="env"。
#      awk 对空输入恒 exit 0；源文件缺失时 awk exit 2（gzip 对空管道 exit 0）⇒ 失败分支仍接得住。
#    · 剥离模式**锚定行首** `^PAY_CONFIG_ENC_KEY=`：假设 `.env` 为裸 `KEY=` 行（**无**前导空白、
#      **无** `export ` 前缀）—— 用户 `first-deploy` 手顺维持该形态；带前缀的写法剥不掉（恢复侧
#      同一假设，该假设同步写在恢复手册的那一行里）。
ENVGZ="$DEST/env-${NAME}.gz"
if awk '!/^PAY_CONFIG_ENC_KEY=/' "$ENV_FILE" | gzip -c > "$ENVGZ.tmp"; then mv "$ENVGZ.tmp" "$ENVGZ"; else
  FAILED_AT="env"; rm -f "$ENVGZ.tmp"; write_manifest '{}' 0 '' false; log "FAILED at env"; exit 1
fi

# ⓓ 运行中栈的镜像版本（只记 tag；默认名 ⇒ usable=false）
IMG="$(docker inspect --format '{{.Config.Image}}' "$STACK_CONTAINER" 2>/dev/null || echo '')"
TAG="${IMG##*:}"
USABLE=true
case "$TAG" in latest|''|pokergame*) USABLE=false ;; esac

# ⓔ manifest 最后写
ARTS="$(printf '{"users":{"sha256":"%s","bytes":%s},"caddy":{"sha256":"%s","bytes":%s},"env":{"sha256":"%s","bytes":%s}}' \
  "$(sha_of "$DUMP")" "$(wc -c < "$DUMP")" \
  "$(sha_of "$TGZ")" "$(wc -c < "$TGZ")" \
  "$(sha_of "$ENVGZ")" "$(wc -c < "$ENVGZ")")"
ok=1; write_manifest "$ARTS" "$CADDY_ENTRIES" "$TAG" "$USABLE"

# ⓕ 按文件名里的 <ts> 清理（不按 mtime —— 否则会出现「产物被删、manifest 还在」）
# ⚠️ 目录里现在**两种宽度的 <ts> 混存**（小时链 10 位 + 现场备份 14 位）：下面的字符串比较仍是对的
#    —— CUTOFF 是 10 位定宽，前 10 位相同就按「谁更长/更细」继续比，而 14 位那份落在**同一小时内**
#    ⇒ 恒比 10 位的 CUTOFF 大（= 还不该删），跨过那条边界的小时则先在第 9–10 位分出大小（= 该删）。
#    即：14 位的现场备份与 10 位的小时备份**按同一口径**被扫掉（实证见收尾报告）。
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%d%H 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y%m%d%H)"
for f in "$DEST"/users-*.sql.gz "$DEST"/caddy-data-*.tgz "$DEST"/env-*.gz "$DEST"/manifest-*.json; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"; ts="${base##*-}"; ts="${ts%%.*}"
  case "$ts" in ''|*[!0-9]*) continue ;; esac
  [ "$ts" \< "$CUTOFF" ] && rm -f "$f"
done

log "OK ${NAME}: caddy_entries=${CADDY_ENTRIES} image_tag=${TAG} usable=${USABLE}"
