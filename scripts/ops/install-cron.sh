#!/usr/bin/env bash
# 装用户级 cron 的脚本（部署流水线投递到 /home/ubuntu/ftl-ops/，每次发布都调一次 ⇒ **必须幂等**）。
#
# 做的事只有一件：让 `# ftl-backup` 那一行**恰好出现一次**；别人的行一行不动。
#
# 🔴 只容忍「没有 crontab」这一种 `crontab -l` 失败（设计 I-4）：
#    · `crontab -l` 在**还没有 crontab** 的机器上就是这么失败的（stderr `no crontab for <用户>`、
#      退出码非零）—— 那是**良性**的（新机器必然如此），照装；
#    · **别的任何失败**（权限、磁盘、crontab 本身坏了……）必须**响亮退出、绝不写**。
#      写成 `crontab -l 2>/dev/null | … | crontab -` 的话，一次真故障会被吞成「空 crontab」，
#      于是我们那一行**覆盖掉用户的整个 crontab** —— 本仓把那种形态叫「静默」。
#      判据 k 把这条钉住的方式是：注入一次真故障 ⇒ 必须红，且 crontab **一字未动**。
#
# ⚠️ 用户级 crontab（ubuntu），**不需要 sudo** —— 手册 〇② 只记载交互式 sudo、没有 NOPASSWD，
#    非交互 ssh 用不了 sudo ⇒ 这也是不选 systemd timer 的理由（设计 §2）。
# ⚠️ 定时行用**绝对路径**：用户 crontab 的 PATH 只有 /usr/bin:/bin。
# ⚠️ 测试可注入：`CRONTAB_CMD`（默认 `crontab`）—— 判据 k 用替身跑，**永不碰真 crontab**。
# ⚠️ 本文件会被投递到服务器：里面**不含任何密钥/口令**。
set -euo pipefail
LINE='17 * * * * /bin/bash /home/ubuntu/ftl-ops/backup.sh >> /dev/null 2>&1 # ftl-backup'
CRONTAB_CMD="${CRONTAB_CMD:-crontab}"     # 测试可注入

# 监控片（规格 §1.2/§2.9）：node-exporter 的 textfile 目录必须在 compose up **之前**存在且 ubuntu 可写
# —— bind 源缺失时 docker 会以 **root** 自建目录 ⇒ backup.sh（ubuntu）永远写不进去 ⇒ 指标静默停更
# （备份新鲜度只有看板、没有告警规则）。本脚本在发布流水线里正是「装备份」步、先于 up。
# ⚠️ 测试注入点与 backup.sh **同名同先例**：TEXTFILE_DIR（判据 k 指向临时目录 —— CI 上真跑下面这两行
#    ⇒ mkdir 失败会 EPERM 打死脚本、把判据 k 红出来，即该行被那组判据真实覆盖；且永不碰 /home/ubuntu）。
#    替身模式（CRONTAB_CMD 注入）**不再跳过本段**——注入点即 TEXTFILE_DIR；真模式（服务器）下
#    建不出来 ⇒ **响亮退出**（set -e），绝不带着坏 bind 源继续装 cron。
TEXTFILE_DIR="${TEXTFILE_DIR:-/home/ubuntu/ftl-monitoring/textfile}"  # 测试可注入（判据 k 指临时目录）
mkdir -p "$TEXTFILE_DIR"
chmod 755 "$TEXTFILE_DIR"

cur="$("$CRONTAB_CMD" -l 2>/tmp/ftl-cron-err)" && rc=0 || rc=$?
# 🔴 只容忍「没有 crontab」这一种失败；别的失败必须响亮退出，绝不覆盖用户的 crontab
if [ "$rc" != 0 ] && ! grep -qi 'no crontab' /tmp/ftl-cron-err; then
  echo "❌ crontab -l 失败（非「没有 crontab」）：$(cat /tmp/ftl-cron-err)" >&2
  echo "❌ 本次**没有**安装、crontab 一个字节也没动。先修好 crontab -l，再重跑本脚本。" >&2
  exit 1
fi
printf '%s\n%s\n' "$(printf '%s\n' "$cur" | grep -v '# ftl-backup' | sed '/^$/d')" "$LINE" \
  | grep -v '^$' | "$CRONTAB_CMD" -
