#!/usr/bin/env bash
# 判据 h：备份新鲜度（**runner 侧** —— 设计 §5 明写本脚本**不落服务器**：它在发版末尾由
# release.yml 的独立 step ssh 出去跑，是「备份停了」目前**唯一**的自动信号）。
#
# 判六件事，每条红都有自己的文案（凌晨三点的人读到哪条就知道该做什么）：
#   ① ssh 够得到吗（够不到 ≠ 备份坏了 —— 那是「看不到」）；
#   ② 备份目录里有没有 manifest（一个都没有 ⇒ 从未成功过）；
#   ③ 有没有 **ok:true** 的（只有 ok:false ⇒ 最近几次全失败）；
#   ④ 最新那个 ok 的**三件产物在不在**（设计 §4.4：「新鲜」= 存在一个**可恢复的集合**）；
#   ⑤ 它在阈值（3 小时）内吗（太旧 ⇒ 备份停了）；
#   ⑥ backup.log 的**最后一次结果**不是 FAILED（最近一次备份失败 ⇒ 当场红）。
#
# 🔴 ⑥ 是**前瞻风险的对治**（Task 2 评审 Minor 6）：预检/锁那两条失败路径**不写 manifest**
#    （只写 backup.log）⇒ 纯 manifest 判活时，盘满这类**持续性**故障在头 3 小时里完全不可见
#    （要等 ⑤ 的年龄跨过阈值才报）。所以本脚本同时读 backup.log 的**最后一次结果**：最后一次
#    跑完却没成功 ⇒ 当场红，并把失败原话贴给读者。
#    ⚠️ 例外：**锁竞争不算失败**（设计 §5：那说明另一次备份正在跑 —— 「失败即红」的唯一豁免）；
#      但它**不能**替代 ⑤：锁被僵尸长期占住时最后一条永远是「拿不到锁」，那时靠年龄那条兜底。
#    ⚠️ 只看**最后一次**（不数历史失败）：一次失败之后又成功了就该回到绿 —— 否则任何一次历史
#      失败都会把闸永久钉红，那是**假红机器**（判据 h 有一条专门钉这个）。
#    ⚠️ 诚实边界：**看不见**「备份根本没被调度」（cron 行被删 / 机器关机）—— 那由 ⑤ 的年龄
#      跨过阈值报出来（最长一个发版周期 + 3h）；「一个月不发版 ⇒ 无人知」是设计 §9.2 的残余。
#
# ⚠️ 注入点两条（照 `install-cron.sh` 的 `CRONTAB_CMD` 先例；**生产里两条都不设**）：
#    · `SSH_CMD`     —— 默认 `ssh`。替身接到**同样的 argv**（-i / -o / ubuntu@host / 命令串）后
#      **本地执行**那条命令串 ⇒ 判据跑的是与生产**逐字相同**的命令串，被换掉的只有「谁来执行」。
#    · `BACKUP_DEST` —— 默认生产路径。判据用它指向 scratch 目录，**永不碰真服务器**。
#
# ⚠️ 本脚本**只读**：不 mkdir、不往服务器写任何东西（与 deploy.sh 的 `--assert-clean` 同一条纪律）。
set -euo pipefail
# ⚠️ Windows 本机迭代（Git Bash/MSYS）：MSYS 会把交给**原生程序**的裸参数里以 `/` 开头的路径
#    改写成宿主路径（backup.sh 文件头有实测记录）⇒ 关掉。生产（Linux）上没有这个变量，此行 no-op。
export MSYS_NO_PATHCONV=1

: "${SSH_HOST:?缺 SSH_HOST（ssh 到哪台服务器）}"
: "${SSH_KEY:?缺 SSH_KEY（ssh 用的私钥文件路径）}"

BACKUP_DEST="${BACKUP_DEST:-/home/ubuntu/ftl-backups}"
SSH_CMD="${SSH_CMD:-ssh}"
MAX_HOURS=3
SSH=("$SSH_CMD" -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "ubuntu@$SSH_HOST")

# 每条红共用的收尾（设计 §6.4 / I-1）：**这一条与本次发布无关** —— deploy.sh 在**任何**非零
# 退出时都会打印「❌ 部署失败。回滚命令…」，绝不能让「备份过期」被读成「快把好版本回滚掉」。
no_rollback() {
  echo "   站是好的，**别回滚**：这一条与本次发布无关；去看手册「备份还活着吗」那节与 ${BACKUP_DEST}/backup.log。" >&2
}
# 「够不到服务器」与「备份坏了」是两件事：把前者报成后者会把凌晨三点的人指向错误的方向。
ssh_fail() {
  echo "❌ 备份新鲜度：ssh 探测失败（够不到服务器 / 认证不过）—— 这不是「备份坏了」，是**看不到**。" >&2
  echo "   先修 ssh（SSH_HOST / SSH_KEY / 网络）再重跑这一步；本次**没有**做出任何关于备份的判断。" >&2
  no_rollback
}

# ① 探测：一次拿全部**小时链**的 manifest 名。
#    ⚠️ `manifest-[0-9]*.json` 故意**排除** `manifest-restore-*.json`（现场备份）：那串只在事故里
#       出现，拿它当「备份还活着」的证据 = 让一次恢复把闸喂绿。
#    ⚠️ `2>/dev/null || true` 在**远端**：只吞「glob 没匹配」那种失败，吞不掉 ssh 自己的失败
#       （连接不过 ⇒ 255）—— 「够不到服务器」与「备份全死了」必须分得开。
if ! manifests="$("${SSH[@]}" "ls -1 ${BACKUP_DEST}/manifest-[0-9]*.json 2>/dev/null || true")"; then
  ssh_fail; exit 1
fi
if [ -z "$manifests" ]; then
  echo "❌ 备份新鲜度：**一个 manifest 都没有** —— 备份从未成功过（或备份目录被清空 / 搬走了）。" >&2
  no_rollback
  exit 1
fi

# ② 最新一个 ok:true 的（`<ts>` 是定宽 YYYYMMDDHH ⇒ 字典序即时间序，`sort | tail -n 1`）。
if ! newest_ok="$("${SSH[@]}" "grep -l '\"ok\":true' ${BACKUP_DEST}/manifest-[0-9]*.json 2>/dev/null | sort | tail -n 1 || true")"; then
  ssh_fail; exit 1
fi
if [ -z "$newest_ok" ]; then
  echo "❌ 备份新鲜度：**没有任何 ok:true 的 manifest** —— 目录里有 manifest，但**最近几次全失败**。" >&2
  no_rollback
  exit 1
fi

# ③ 三件产物都得在（设计 §4.4：新鲜 = **存在一个可恢复的集合**，不只是一个近期时间戳）。
#    缺哪件就点名哪件 —— 「不全」两个字在凌晨三点没有用。
if ! missing="$("${SSH[@]}" "d=\$(dirname '$newest_ok'); n=\$(basename '$newest_ok' .json); n=\${n#manifest-}; \
    for f in users-\$n.sql.gz caddy-data-\$n.tgz env-\$n.gz; do [ -f \"\$d/\$f\" ] || echo \"\$f\"; done")"; then
  ssh_fail; exit 1
fi
if [ -n "$missing" ]; then
  echo "❌ 备份新鲜度：最新 ok manifest 的**产物不全** —— 绿着，但**没有可恢复的东西**。" >&2
  echo "   缺：$(printf '%s' "$missing" | tr '\n' ' ')" >&2
  no_rollback
  exit 1
fi

# ④ backup.log 的**最后一次结果**（最后一条 OK/FAILED 行；WARNING 是「这一次正在跑」的中途话，跳过）。
#    ⚠️ 取 5 行是为了容忍「最后一行是 WARNING」那种尾巴（本机那种无 flock 的机器上正在跑）。
#    日志不在 / 没有结果行 ⇒ 空 ⇒ 不红（manifest 那条链的证据更强，见文件头）。
if ! last="$("${SSH[@]}" "tail -n 5 '${BACKUP_DEST}/backup.log' 2>/dev/null | grep -E ' (OK |FAILED)' | tail -n 1 || true")"; then
  ssh_fail; exit 1
fi

# ⑤ 年龄（在**服务器上**算 ⇒ runner 与服务器的时钟不必一致；比较用服务器自己的 now）。
#    ⚠️ 远端只用 POSIX + GNU date（不依赖远端登录 shell 是 bash）；算不出（名字形态不认识）时回
#    一行 `UNPARSABLE` 让**本地**判红 —— 绝不能变成「空年龄 ⇒ 比较为假 ⇒ 假绿」。
if ! age_h="$("${SSH[@]}" "ts=\$(basename '$newest_ok' .json); ts=\${ts#manifest-}; \
    d=\$(printf '%s' \"\$ts\" | cut -c1-8); h=\$(printf '%s' \"\$ts\" | cut -c9-10); \
    e=\$(date -u -d \"\$d \$h:00:00\" +%s 2>/dev/null) || { echo UNPARSABLE; exit 0; }; \
    echo \$(( ( \$(date -u +%s) - \$e ) / 3600 ))")"; then
  ssh_fail; exit 1
fi
case "$age_h" in
  ''|*[!0-9]*)
    echo "❌ 备份新鲜度：**判不出年龄**（远端算出来的是 ${age_h:-空}）—— manifest 的名字形态不认识，" >&2
    echo "   闸**无法下结论**（宁可报「不知道」，也不做乐观假设报「绿」）。" >&2
    no_rollback
    exit 1 ;;
esac
if [ "$age_h" -ge "$MAX_HOURS" ]; then
  echo "❌ 备份新鲜度：最近一次成功备份在 **${age_h} 小时前**（阈值 ${MAX_HOURS}h）—— **备份停了**。" >&2
  if [ -n "$last" ]; then echo "   backup.log 的最后一次结果：${last}" >&2; fi
  no_rollback
  exit 1
fi

# ⑥ 最后一次跑完却不是成功 ⇒ 红（见文件头 ⑥）。⚠️ 锁竞争豁免（设计 §5）：豁免的**措辞**与
#    backup.sh 同源（`FAILED: 拿不到锁 …`）—— 判据 h 有一条文本钉子把两边钉在一起。
if [ -n "$last" ]; then
  case "$last" in
    *' FAILED'*)
      case "$last" in
        *'拿不到锁'*) : ;;
        *)
          echo "❌ 备份新鲜度：**最近一次备份失败了** —— ${last#* }" >&2
          echo "   这一类失败要么**不写 manifest**（预检 / 锁），要么写成 ok:false（mysqldump / env / caddy）" >&2
          echo "   —— 两种都不是「备份还活着」。去看 ${BACKUP_DEST}/backup.log。" >&2
          no_rollback
          exit 1 ;;
      esac ;;
  esac
fi
echo "✅ 备份新鲜度：最近一次成功备份在 ${age_h} 小时前，三件产物齐（${newest_ok##*/}）；backup.log 的最后一次结果：${last:-（没有结果行）}"
