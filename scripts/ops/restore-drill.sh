#!/usr/bin/env bash
# 片③-B：**恢复演练** —— **只在开发机 / CI 跑，永不投递生产**（设计 §4.3）。
#
# 范围 = DB 路径 + **一条经由真 user-service 的写路径**。
# ⚠️ 后者不是纯 DB 路径（第三轮审查 Important 2）：`register()` 走 `issue()` ⇒ 要写 Redis ⇒
#    scratch 里必须有一个真的 Redis。所以这里是三个容器：MySQL + Redis + user-service，
#    **共用 MySQL 的 netns**（不新建网络 —— 栈把 `172.28.0.0/16` 钉死了；也不发布宿主端口）。
#
# 流程：起 scratch → 等**真服务**就绪（`users` 表是它的迁移建的）→ 播种已知数据 → 备份 →
#       **毁库** → 恢复 → 四项比对 → 经由真服务走一条写路径 → 销毁。
#
# ⚠️ 期望值**只能**来自本脚本自己播种的数据，**不是** manifest：期望值与被测物都由 `backup.sh`
#    那条路径产出 ⇒ 只会**一起对、一起错**（设计 §4.3 末）。
# ⚠️ 容器名不得以 `ftl-` 开头（`conformance-stack.sh` 的收尾断言匹配 `^/ftl-`），且名字第二段是
#    **pid** —— 宿主的 `reapDeadRuns()` 按 pid 判活，认得出硬杀遗留的死 run。
# ⚠️ 口令是 scratch 的一次性假值（`probe-root`），**不是**任何真实凭据；本脚本永不投递生产。
set -euo pipefail
export MSYS_NO_PATHCONV=1

RUN_ID="c75b-$$-$(date +%s)"
MYSQL="${RUN_ID}-mysql"; REDIS="${RUN_ID}-redis"; APP="${RUN_ID}-user"
DB=ftl_probe
DRILL_ROOT="$(mktemp -d)"
DEST="$DRILL_ROOT/dest"; PROJ="$DRILL_ROOT/proj"; CADDY="$DRILL_ROOT/caddy-data"
mkdir -p "$DEST" "$PROJ" "$CADDY"
# 源卷必须**非空**（判据 c 的内容下限同族：对空卷打包是坏的），且条目数由本脚本自己知道。
printf 'PROBE-CERT\n' > "$CADDY/certificates.pem"
mkdir -p "$CADDY/sub"; printf '{"probe":true}\n' > "$CADDY/sub/account.json"
# 项目目录**恰好**两件（与生产同形）：`.env` 给 `--env-file` 用，compose 是占位
#（演练形态下 ⑥⑦ 整段跳过、走不到 compose；这一份是「万一跳过被改坏」时的纵深防御）。
printf 'JWT_SECRET=probe\nDB_PASSWORD=probe-root\n' > "$PROJ/.env"
printf '# 演练用的占位（empty --app-services ⇒ ⑥ 走不到这里）\n' > "$PROJ/docker-compose.yml"

cleanup() {
  for c in "$APP" "$REDIS" "$MYSQL"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  rm -rf "$DRILL_ROOT"
}
trap cleanup EXIT

# 开工前回收**死 run** 的残留（硬杀时 trap 不跑）：按名字里的 pid 判活，活的跳过（同机并发）。
# ⚠️ **只在 Linux 上做**（CI / 服务器）：MSYS 的 `kill -0 <Windows pid>` 对本机**活着**的进程也返回
#    失败（实测：explorer.exe / com.docker.backend.exe 都判死）⇒ 在 Windows 本机会把**别人正在用的**
#    `c75b-*` 容器当残留删掉（实测把切片的 scratch MySQL 删了，判据 c 当场 `No such container`）。
#    Windows 本机的死残留由切片的 `reapDeadRuns()` 收（它走 Node 的 `process.kill(pid, 0)`，语义正确）。
if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
  docker ps -a --filter 'name=^/c75b-' --format '{{.Names}}' | while read -r n; do
    p="${n#c75b-}"; p="${p%%-*}"
    case "$p" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$p" 2>/dev/null && continue
    echo "   ↳ 回收死 run 残留：$n"
    docker rm -f "$n" >/dev/null 2>&1 || true
  done
fi

echo "▶ scratch：$MYSQL / $REDIS / $APP（库 $DB）"
# ⚠️ Windows 本机迭代：`-v` 的**宿主侧**路径必须是原生形态（`C:\…`）。本脚本已关掉 MSYS 的路径
#    转换（容器侧 `/data` 必须原样过去），所以这里手工转一次宿主侧；Linux 上没有 `cygpath`，
#    这一行退化成原值（no-op）。
MOUNT_SRC="$CADDY"
if command -v cygpath >/dev/null 2>&1; then MOUNT_SRC="$(cygpath -w "$CADDY")"; fi
docker run -d --name "$MYSQL" -e MYSQL_ROOT_PASSWORD=probe-root -e MYSQL_DATABASE="$DB" \
  -v "$MOUNT_SRC":/data mysql:8.0 >/dev/null
READY=0
for _ in $(seq 1 60); do
  # ⚠️ 不用裸 `mysqladmin ping`：首次初始化时 entrypoint 的**临时服务器**也会让 ping exit 0（实测）
  #    ⇒ 只 ping 会提前 break，紧接着的播种正好落进「临时服务器已停、真服务器未起」的窗口。
  if docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B "$DB" -e 'SELECT 1' >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "$READY" = 1 ] || { echo "❌ scratch MySQL 没起来" >&2; exit 1; }

docker run -d --name "$REDIS" --network "container:$MYSQL" redis:7-alpine >/dev/null
docker run -d --name "$APP" --network "container:$MYSQL" \
  -e REDIS_URL=redis://127.0.0.1:6379 -e DB_HOST=127.0.0.1 -e DB_NAME="$DB" \
  -e DB_USER=root -e DB_PASSWORD=probe-root \
  -e JWT_SECRET=probe-secret -e INTERNAL_SERVICE_TOKEN=probe-token \
  pokergame-user-service:latest >/dev/null

# 等**真服务**就绪（不只是等端口）：`users` 表是它自己的迁移建的（`migrationsRun: true`）——
# 表没建好就播种，会播进一张**假表** ⇒「恢复了表却用不了」这个形态反而抓不到。
HEALTH=000
for _ in $(seq 1 60); do
  HEALTH="$(docker exec "$APP" node -e \
    'fetch("http://127.0.0.1:3001/api/health").then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write("000"))' \
    2>/dev/null || echo 000)"
  [ "$HEALTH" = 200 ] && break
  sleep 2
done
[ "$HEALTH" = 200 ] || { echo "❌ scratch user-service 没就绪（/api/health 返回 $HEALTH）" >&2; exit 1; }

echo "▶ 播种已知数据（**期望值只能来自这里**）"
# ⚠️ 哈希是假的（`probe-hash-*`）：本演练只比对内容 + 走写路径，不做登录。
docker exec "$MYSQL" mysql -uroot -pprobe-root "$DB" -e \
  "DELETE FROM users;
   INSERT INTO users (id, phone, passwordHash, nickname) VALUES
     ('u1','13900000001','probe-hash-1','alice'),
     ('u2','13900000002','probe-hash-2','bob');"

# 四项比对的**基线**（都从源库派生 —— 表集合不硬编码，否则第一次合法加表就要改判据）
TABLES="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B -e "SHOW TABLES FROM $DB;" | sort | tr '\n' ' ')"
SUMS="$(for t in $TABLES; do docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B -e \
  "SELECT COUNT(*) FROM $DB.$t; CHECKSUM TABLE $DB.$t;" | tr '\t' ' ' | tr '\n' ' '; echo; done)"
# ⚠️ `group_concat_max_len`：默认 1024 B ⇒ 行多时拼串被**静默截断**（尾部变化抓不住）。
EXPECT="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B "$DB" -e \
  'SET SESSION group_concat_max_len=1048576; SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;')"

echo "▶ 备份（cron 那种形态：无前缀）"
bash "$(dirname "$0")/backup.sh" --dest "$DEST" --mysql-container "$MYSQL" --db-name "$DB" \
  --edge-container "$MYSQL" --env-file "$PROJ/.env" --stack-container "$MYSQL" --min-free-mb 0
TS="$(ls -1 "$DEST"/manifest-*.json | tail -1 | sed 's/.*manifest-//;s/\.json$//')"
[ -n "$TS" ] || { echo "❌ 备份没留下 manifest" >&2; exit 1; }

echo "▶ 毁库（**这才是演练**：不毁就分不清「恢复了」与「本来就在」）"
docker exec "$MYSQL" mysql -uroot -pprobe-root -e "DROP DATABASE $DB;"

echo "▶ 恢复（restore.sh；--app-services 为空 = 演练形态：②⑥⑦ 整段跳过）"
bash "$(dirname "$0")/restore.sh" --yes-i-know \
  --app-services "" \
  --mysql-container "$MYSQL" --db-name "$DB" \
  --edge-container "$MYSQL" --stack-container "$MYSQL" \
  --backup-dir "$DEST" --backup-ts "$TS" \
  --project-dir "$PROJ"

echo "▶ 比对（期望值来自我们自己播种的那份）"
TABLES2="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B -e "SHOW TABLES FROM $DB;" | sort | tr '\n' ' ')"
SUMS2="$(for t in $TABLES2; do docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B -e \
  "SELECT COUNT(*) FROM $DB.$t; CHECKSUM TABLE $DB.$t;" | tr '\t' ' ' | tr '\n' ' '; echo; done)"
ACTUAL="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B "$DB" -e \
  'SET SESSION group_concat_max_len=1048576; SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;')"
FAIL=0
if [ "$TABLES2" != "$TABLES" ]; then
  echo "❌ 演练失败：表集合与源库不一致" >&2
  echo "   期望：$TABLES" >&2; echo "   实得：$TABLES2" >&2; FAIL=1
fi
if [ "$SUMS2" != "$SUMS" ]; then
  echo "❌ 演练失败：每张表的行数/校验和与源库不一致" >&2
  echo "   期望：$(printf '%s' "$SUMS" | tr '\n' ' ')" >&2
  echo "   实得：$(printf '%s' "$SUMS2" | tr '\n' ' ')" >&2; FAIL=1
fi
if [ "$ACTUAL" != "$EXPECT" ]; then
  echo "❌ 演练失败：恢复后的内容与播种的期望值不一致" >&2
  echo "   期望：$EXPECT" >&2
  echo "   实得：$ACTUAL" >&2
  FAIL=1
fi
[ "$FAIL" = 0 ] || exit 1

# 只验「起得来」是不够的：唯一的迁移是 `CREATE TABLE IF NOT EXISTS` 且 `migrationsRun: true`
# ⇒ **空库也起得来**。必须真的写一次，才证明「恢复了表却用不了」被抓到。
echo "▶ 经由真 user-service 走一条写路径"
REG="$(docker exec "$APP" node -e \
  'fetch("http://127.0.0.1:3001/api/auth/register", { method: "POST",
     headers: { "content-type": "application/json", "x-internal-token": "probe-token" },
     body: JSON.stringify({ phone: "13800000001", password: "Drill!2345", nickname: "drill" }) })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write("000"));' 2>/dev/null || echo 000)"
if [ "$REG" != "201" ] && [ "$REG" != "200" ]; then
  echo "❌ 演练失败：恢复后的库**喂给真 user-service 走不通写路径**（HTTP $REG）" >&2
  exit 1
fi
echo "   ↳ 写路径 HTTP $REG（注册走通 ⇒ 恢复后的 schema 被代码用得起来）"
echo "✅ 演练通过：恢复后的内容与播种一致（$ACTUAL），且真服务写路径走通"
