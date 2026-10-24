# 片③-B 备份与恢复路径 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已上线的服务器加一套每小时自动备份（MySQL + 门口证书卷 + `.env` + 运行中栈的镜像版本），并把「数据没了能找回来」做成一条**演练过、写进手册、被机械判据守着**的恢复路径。

**Architecture:** 五个 shell 脚本住在 `/home/ubuntu/ftl-ops/`（由发布流水线投递，服务器上不放仓库）；一个每小时的用户级 crontab 跑 `backup.sh`；一个新 conformance 切片 `slice-07.5-backup` 用**一次性容器**从测试自己喂的已知数据出发，走完「备份 → 恢复 → 比对」并配内容级负对照；发布流水线里加一个**独立 step** 断言备份新鲜度。

**Tech Stack:** bash · Docker（`mysqldump` / `tar` / 一次性 MySQL 与 Redis 容器）· TypeScript（conformance 切片）· GitHub Actions。

**设计真源：** [`docs/superpowers/specs/2026-09-25-backup-and-restore-design.md`](../specs/2026-09-25-backup-and-restore-design.md)（**已批准**，经三轮对抗式审查）。
**先读它的 §3.1 跨节时序表** —— 三轮审查的每一条 Critical 都是「两次修订的产物在同一张时间轴上打架」，而逐节读看不见。

## Global Constraints

- **判据只增不减**：不得放宽 `schema-*` / `tools/conformance/baselines.json` / 任何 slice 的条数下限。新增切片要回填 `full` 列。
- **零客户端改动**：`git diff --stat <BASE>..HEAD -- apps/client/src` 必须为空。
- **`--assert-clean`（`deploy.sh:75`）**：`/srv/pokergame` 必须**恰好** `.env` + `docker-compose.yml` ⇒ 备份产物、脚本、日志、临时文件**一律不得**落在那里。
- **A12（`slice-07.2-deploy.ts:552-556`）**：compose 的 `build:` 服务面**恰好**是现有 7 个 ⇒ **不得新增 compose 服务**（演练用的一次性容器不触它，但它们**不得以 `ftl-` 开头**）。
- **`EXPECTED_RELEASE_JOBS`（`slice-07.4-pipeline.ts:30`）**：`release.yml` 的 job 集合**恰好** `{images, conformance, deploy}` ⇒ 新鲜度那一步**必须是 step，不是 job**。
- **`deploy.sh:243`**：任何非零退出都会打印「❌ 部署失败。回滚命令…」⇒ 备份相关的任何失败**绝不能落进 `deploy.sh` 的 rc 路径**。
- **`run.ts:119`**：非 `--render` 时**无条件**调 `assertGatewayHealthy()` ⇒ 新切片**需要真栈**，只跑在 `conformance` job。本机迭代用 `--render`。
- **ops 脚本不得含密钥**；口令一律从容器自己的 env 取。
- **`$DEST` 与 `$FTL_OPS` 均 `0700`**；manifest **不含密钥材料**（runner 会 `cat` 它）。
- 提交信息按本仓 `CLAUDE.md`，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

### 已知陷阱（**Task 1 实测踩到并修好的，后续任务别再踩**）

- 🔴 **`Checks.ok` 只收一个参数**（`tools/conformance/src/lib/assert.ts:38` 是 `ok(message: string)`）
  ⇒ 判据写 `checks.ok(cond, 'msg')` 会 **TS2554 编不过**。条件式断言用 `checks.eq(a, b, msg)`
  或先自己 `if (!cond) throw`。计划 Task 1 的片段里曾写成两参，**Task 2–6 一律照这条**。
- 🔴 **scratch 必须自己播种 `--env-file` 指向的那个文件**，否则 `gzip -c "$ENV_FILE"` 退出 1
  ⇒ 备份判据在任何平台都**永不绿**。
- 🔴 **Windows 的 Git Bash 会把 `-C /data`、`-v "$DIR:/data"` 这类参数改写成 Windows 路径**
  （实测：`-v "$CADDY:/caddy-seed"` 被转成 `;` 分隔的路径表，容器里根本没有那个目录）。
  ⇒ **所有会碰容器内路径的脚本与测试，开头都 `export MSYS_NO_PATHCONV=1`**（Linux 上是 no-op）；
  必要时对宿主侧路径用 `cygpath -w`。**Task 3 的 drill 一定会踩这条。**
- 🔴 **scratch MySQL 的就绪探针不能用裸 `mysqladmin ping`**：MySQL 初始化期间会先起一个临时服务器，
  那时 ping 会**假就绪**（实测 t≈9s 就通过，而真服务器 t≈15.7s 才好）⇒ 用 `mysql -e 'SELECT 1'`。
- 🔴 **MSYS 会给子进程输出的哈希串加前导 `\`** ⇒ manifest 会变成非法 JSON。两侧都要剥掉。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `scripts/ops/backup.sh` | **创建**。一次备份：空间预检 → dump → tar 证书卷 → gzip `.env` → 记镜像版本 → 写 manifest → 按 `<ts>` 清理 |
| `scripts/ops/restore.sh` | **创建**。人驱动的恢复：现场备份 → 停业务面 → 校验 → 灌库 → 按需还原证书卷/`.env` → 校验镜像后起栈 → 冒烟 |
| `scripts/ops/install-cron.sh` | **创建**。幂等安装一条 `# ftl-backup` 标记的定时 |
| `scripts/ops/restore-drill.sh` | **创建**。**只在开发机/CI**：起 scratch MySQL+Redis → 播种 → backup → restore → 比对 → 销毁 |
| `scripts/ops/check-backup-fresh.sh` | **创建**。**runner 侧**：ssh 出去读最近一个 `ok:true` manifest 并断言三件产物都在 |
| `tools/conformance/src/slices/slice-07.5-backup.ts` | **创建**。13 条判据 + 负对照 |
| `tools/conformance/src/run.ts` | 修改：`CASES` 末尾加一行 |
| `tools/conformance/baselines.json` | 修改：回填 `full` 列 |
| `tools/conformance/src/slices/slice-07.4-pipeline.ts` | 修改：`PREFIX_FILES` 加 5 个 ops 脚本 |
| `scripts/deploy/deploy.sh` | 修改：投递 ops 脚本（**不碰不加引号的 heredoc 正文**，见 Task 6） |
| `.github/workflows/release.yml` | 修改：加两个 step（投递+装 cron+首跑；新鲜度） |
| `docs/ops/first-deploy.md` | 修改：两个新顶层节 + `16→17` + 旧机事实 |
| `.gitignore` | 修改：加 `*.sql.gz` / `*.tgz` |

---

## Task 1: 切片骨架 + `backup.sh` 的产物与 manifest（判据 a）

**Files:**
- Create: `scripts/ops/backup.sh`
- Create: `tools/conformance/src/slices/slice-07.5-backup.ts`
- Modify: `tools/conformance/src/run.ts`（`CASES` 末尾加一行）
- Test: 该切片自带的判据 a

**Interfaces:**
- Produces: `backup.sh` 的参数表（`--dest --retention-days --min-free-mb --mysql-container --db-name --edge-container --env-file --stack-container --artifact-prefix`）· 产物命名 `users-<ts>.sql.gz` / `caddy-data-<ts>.tgz` / `env-<ts>.gz` / `manifest-<ts>.json` · manifest 字段 `{ts, ok, failed_at, artifacts:{...sha256,bytes}, caddy_entries, image_tag, image_tag_usable}`

- [ ] **Step 1: 写失败判据（切片骨架 + scratch 环境 + 判据 a）**

创建 `tools/conformance/src/slices/slice-07.5-backup.ts`。**先写这整套 scratch 环境助手** —— 后面每个任务都复用它：

```ts
/**
 * conformance 用例：**备份与恢复路径**（片③-B）。
 *
 * ⚠️ 本切片**需要真栈**（`run.ts:119` 无条件调 `assertGatewayHealthy()`）⇒ 只跑在 conformance job。
 *    本机迭代：`node tools/conformance/dist/run.js slice-07.5-backup --render`
 *
 * ⚠️ 三条隔离纪律（设计 §4.3）：
 *   ① scratch 容器**不得以 `ftl-` 开头** —— `conformance-stack.sh:71-72` 的收尾断言匹配 `name=^/ftl-`
 *   ② **不新建网络**：让三个 scratch 容器共用 scratch MySQL 的 netns ⇒ 撞不上栈钉死的 172.28.0.0/16
 *   ③ **不发布宿主端口**：一律 `docker exec` 进去跑
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Checks, info, step } from '../lib/assert';

const REPO_ROOT = resolve(__dirname, '../../../..');
const BACKUP_SH = join(REPO_ROOT, 'scripts', 'ops', 'backup.sh');
const RESTORE_SH = join(REPO_ROOT, 'scripts', 'ops', 'restore.sh');
const COMPOSE = join(REPO_ROOT, 'docker-compose.yml');

/** 每次调用唯一的前缀 —— 固定名会让重跑假红（本仓有 21 条全红的前科）。 */
const RUN_ID = `c75b-${process.pid}-${Date.now().toString(36)}`;
const MYSQL = `${RUN_ID}-mysql`;
const REDIS = `${RUN_ID}-redis`;
const APP = `${RUN_ID}-user`;
const DB = 'ftl_probe';

function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}
function shQuiet(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'ignore' });
}
/** 容错版：失败不抛，用于 `finally` 里的清理。 */
function shTry(cmd: string, args: string[]): void {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch { /* 清理路径，吞掉 */ }
}

/** scratch 环境：MySQL + Redis + user-service，三者共用 MySQL 的 netns。 */
class Scratch {
  readonly root: string;
  readonly dest: string;
  readonly envFile: string;
  readonly caddyDir: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), `${RUN_ID}-`));
    this.dest = join(this.root, 'dest');
    this.envFile = join(this.root, '.env');
    this.caddyDir = join(this.root, 'caddy-data');
    mkdirSync(this.dest, { recursive: true });
    mkdirSync(this.caddyDir, { recursive: true });
    // 播种「源卷」内容 —— 判据 c 带**内容下限**（「对空卷打包必须红」），
    // 所以 scratch 的源卷必须是**非空**的，且条目数被测试自己知道。
    writeFileSync(join(this.caddyDir, 'certificates.pem'), 'PROBE-CERT\n');
    mkdirSync(join(this.caddyDir, 'sub'), { recursive: true });
    writeFileSync(join(this.caddyDir, 'sub', 'account.json'), '{"probe":true}\n');
    this.caddySeedFiles = 2;
  }

  /** 播种的源卷文件数 —— 判据 c 的内容下限（**来自测试自己，不是 manifest**）。 */
  readonly caddySeedFiles: number;

  up(): void {
    // 开工前清残留（唯一名字，但仍防上一轮异常退出）
    for (const c of [APP, REDIS, MYSQL]) shTry('docker', ['rm', '-f', c]);

    sh('docker', ['run', '-d', '--name', MYSQL,
      '-e', 'MYSQL_ROOT_PASSWORD=probe-root',
      '-e', `MYSQL_DATABASE=${DB}`,
      // 🔴 挂到 **/data**，不是别处：backup.sh 的证书卷那一步是 `docker exec <edge> tar … -C /data .`
      //    ⇒ scratch 里必须真有一个容器把「源卷」挂在 /data。mysql 自己的 datadir 是
      //    /var/lib/mysql，/data 空着 ⇒ 借用它当「卷持有者」，**不必再拉一个新镜像**。
      '-v', `${this.caddyDir}:/data`,
      'mysql:8.0']);

    // 等就绪（不用宿主端口 ⇒ 在容器内探）
    for (let i = 0; i < 60; i++) {
      try {
        sh('docker', ['exec', MYSQL, 'mysqladmin', 'ping', '-uroot', '-pprobe-root']);
        break;
      } catch { execFileSync('sleep', ['2']); }
    }

    // Redis 与 user-service 共享 MySQL 的 netns ⇒ 互相够得到、且不出现在宿主网络上
    sh('docker', ['run', '-d', '--name', REDIS, '--network', `container:${MYSQL}`, 'redis:7-alpine']);
    sh('docker', ['run', '-d', '--name', APP, '--network', `container:${MYSQL}`,
      '-e', 'REDIS_URL=redis://127.0.0.1:6379',
      '-e', `DB_HOST=127.0.0.1`,
      '-e', `DB_NAME=${DB}`,
      '-e', 'DB_USER=root', '-e', 'DB_PASSWORD=probe-root',
      '-e', 'JWT_SECRET=probe-secret', '-e', 'INTERNAL_SERVICE_TOKEN=probe-token',
      'pokergame-user-service:latest']);
  }

  /** 播种**测试自己知道的**已知数据 —— 期望值只能来自这里，不能来自 manifest（设计 §4.3）。 */
  seed(rows: Array<{ id: string; nickname: string }>): void {
    const values = rows.map((r) => `('${r.id}','${r.nickname}')`).join(',');
    sh('docker', ['exec', MYSQL, 'mysql', '-uroot', '-pprobe-root', DB, '-e',
      `CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY, nickname VARCHAR(64));` +
      `DELETE FROM users; INSERT INTO users (id,nickname) VALUES ${values};`]);
  }

  /** 源库的真值 —— 独立于任何备份产物。 */
  truth(): { count: number; digest: string } {
    const out = sh('docker', ['exec', MYSQL, 'mysql', '-uroot', '-pprobe-root', '-N', '-B', DB, '-e',
      'SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;']).trim();
    const [count, concat] = out.split('\t');
    return { count: Number(count), digest: sh('printf', ['%s', concat]).length.toString() };
  }

  down(): void {
    for (const c of [APP, REDIS, MYSQL]) shTry('docker', ['rm', '-f', c]);
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function runSlice075Backup(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const s = new Scratch();
  try {
    s.up();
    s.seed([{ id: 'u1', nickname: 'alice' }, { id: 'u2', nickname: 'bob' }]);
    info(`scratch 就绪：${MYSQL} / ${REDIS} / ${APP}（库 ${DB}）`);

    // ── 判据 a：三件产物 + manifest 齐、字段完整、sha256 与实物对得上 ──────────
    step('判据 a：备份产物与 manifest');
    const { count: seedCount } = s.truth();
    checks.eq(seedCount, 2, '判据 a：播种的已知数据必须是 2 行（否则后面的比对是空测）');

    sh('bash', [BACKUP_SH, '--dest', s.dest, '--mysql-container', MYSQL, '--db-name', DB,
                '--edge-container', MYSQL,          // scratch 里用 mysql 容器当「卷持有者」跑 tar
                '--env-file', s.envFile, '--stack-container', MYSQL, '--min-free-mb', '0']);

    const names = readdirSync(s.dest);
    const mfName = names.find((n) => n.startsWith('manifest-'));
    checks.ok(mfName !== undefined, '判据 a：必须有 manifest-<ts>.json');
    const m = JSON.parse(readFileSync(join(s.dest, mfName!), 'utf8'));
    checks.eq(m.ok, true, '判据 a：manifest 的 ok 必须为 true');
    checks.ok(typeof m.ts === 'string' && m.ts.length > 0, '判据 a：manifest 必须记 ts');

    for (const [key, prefix] of [['users', 'users-'], ['caddy', 'caddy-data-'], ['env', 'env-']] as const) {
      const file = names.find((n) => n.startsWith(prefix));
      checks.ok(file !== undefined, `判据 a：必须有 ${prefix}* 产物`);
      const actual = sh('sha256sum', [join(s.dest, file!)]).split(' ')[0];
      checks.eq(actual, m.artifacts[key].sha256, `判据 a：${key} 的 sha256 必须与实物一致`);
    }
  } finally {
    s.down();
  }
  return { passed: checks.passed };
}
```

⚠️ `sha256sum` 在 Windows 的 Git Bash 里存在；若某台开发机没有，用 `node:crypto` 算（Ubuntu 与 CI 上一定存在）。

在 `run.ts` 顶部加 `import { runSlice075Backup } from './slices/slice-07.5-backup';`，并在 `CASES` **末尾**加：

```ts
  'slice-07.5-backup': { title: '备份与恢复路径（片③-B）', run: runSlice075Backup },
```

- [ ] **Step 2: 跑它，确认失败**

```bash
pnpm --filter @fight-the-landlord/conformance build 2>&1 | tail -3
node tools/conformance/dist/run.js slice-07.5-backup --render
```
Expected: 红 —— `scripts/ops/backup.sh` 不存在（`ENOENT`）。

- [ ] **Step 3: 写 `scripts/ops/backup.sh` 的最小实现**

```bash
#!/usr/bin/env bash
# 片③-B：一次备份。由 cron 每小时调用；也可由 restore.sh 以 --artifact-prefix restore- 调用。
# ⚠️ 不含任何密钥：口令从 mysql 容器自己的 env 取。
# ⚠️ 不引任何新镜像：证书卷用已在机器上的 edge 容器打包。
set -euo pipefail

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

TS="$(date -u +%Y%m%d%H)"
NAME="${ARTIFACT_PREFIX}${TS}"
mkdir -p "$DEST"
chmod 700 "$DEST"

LOG="$DEST/backup.log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
# 日志上限（R1108 同族）：超过 1MB 就留存最后 200 行
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
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
sha_of() { sha256sum "$1" | cut -d' ' -f1; }

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

# ⓒ .env
ENVGZ="$DEST/env-${NAME}.gz"
if gzip -c "$ENV_FILE" > "$ENVGZ.tmp"; then mv "$ENVGZ.tmp" "$ENVGZ"; else
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
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%d%H 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y%m%d%H)"
for f in "$DEST"/users-*.sql.gz "$DEST"/caddy-data-*.tgz "$DEST"/env-*.gz "$DEST"/manifest-*.json; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"; ts="${base##*-}"; ts="${ts%%.*}"
  case "$ts" in ''|*[!0-9]*) continue ;; esac
  [ "$ts" \< "$CUTOFF" ] && rm -f "$f"
done

log "OK ${NAME}: caddy_entries=${CADDY_ENTRIES} image_tag=${TAG} usable=${USABLE}"
```

（`ⓞ 空间预检`、`flock`、`ok:false` 的失败路径细化在 Task 2。）

- [ ] **Step 4: 补完判据 a 的断言并跑绿**

在 Step 1 的 `try` 块里补：

```ts
    sh('bash', [BACKUP_SH, '--dest', dest, '--mysql-container', MYSQL,
                '--db-name', SCRATCH_DB, '--edge-container', EDGE,
                '--env-file', envSrc, '--stack-container', MYSQL]);
    const names = readdirSync(dest);
    const mf = names.find((n) => n.startsWith('manifest-'))!;
    const m = JSON.parse(readFileSync(join(dest, mf), 'utf8'));
    checks.eq(m.ok, true, '判据 a：manifest 的 ok 必须为 true');
    for (const [k, v] of Object.entries(m.artifacts as Record<string, { sha256: string }>)) {
      const file = names.find((n) => n.includes(k === 'users' ? 'users-' : k === 'caddy' ? 'caddy-data-' : 'env-'))!;
      const actual = sh('sha256sum', [join(dest, file)]).split(' ')[0];
      checks.eq(actual, v.sha256, `判据 a：${k} 的 sha256 必须与实物一致`);
    }
```

Run: `node tools/conformance/dist/run.js slice-07.5-backup --render`
Expected: 绿。

- [ ] **Step 5: 提交**

```bash
git add scripts/ops/backup.sh tools/conformance/src/slices/slice-07.5-backup.ts tools/conformance/src/run.ts
git commit -m "feat(ops): backup.sh 的产物与 manifest + slice-07.5-backup 骨架（判据 a）"
```

---

## Task 2: 空间预检、失败原子性、保留策略、锁（判据 e/f/g）

**Files:**
- Modify: `scripts/ops/backup.sh`
- Modify: `tools/conformance/src/slices/slice-07.5-backup.ts`

**Interfaces:**
- Consumes: Task 1 的参数表与 manifest 结构
- Produces: `$DEST/.lock`（cron 用）与 `$DEST/.restore-lock`（现场备份用，**两个锁不同**）；失败路径写 `ok:false` + `failed_at`

- [ ] **Step 1: 写失败判据**

在切片里加三段：

```ts
    // ── 判据 e：保留按 <ts>，且不会「产物被删而 manifest 还在」 ──────────
    // ── 判据 f：注入失败（不存在的库名）⇒ 不留半个文件 + manifest ok:false + failed_at 点名
    // ── 判据 g：空间预检阈值大于可用 ⇒ 不跑且失败
```

（判据 f 的注入 **必须用 `--db-name` 传一个不存在的库名** —— 这是最廉价的注入，且**不能**用「改坏一个字节」，那会让 gunzip 先报错、测不到比对逻辑。）

- [ ] **Step 2: 跑，确认红**

```bash
node tools/conformance/dist/run.js slice-07.5-backup --render
```
Expected: 红 —— 空间预检与 `flock` 尚未实现。

- [ ] **Step 3: 实现**

在 `backup.sh` 的 `TS=` 之前插入：

```bash
# ⓞ 空间预检：可用 < 阈值 ⇒ 不跑并失败（保护生产库）
AVAIL_MB="$(df -Pm "$DEST" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
  log "FAILED: 可用空间 ${AVAIL_MB}MB < ${MIN_FREE_MB}MB ⇒ 本次不备份"
  exit 1
fi

# 锁：cron 用 .lock，现场备份（--artifact-prefix restore-）用 .restore-lock
if [ -n "$ARTIFACT_PREFIX" ]; then
  LOCK="$DEST/.restore-lock"; LOCK_WAIT=60      # 救人用的锁：等待 + 超时
else
  LOCK="$DEST/.lock"; LOCK_WAIT=0               # cron：拿不到就算这次失败
fi
exec 9>"$LOCK"
if ! flock -w "$LOCK_WAIT" 9; then
  log "FAILED: 拿不到锁 $LOCK"
  exit 1
fi
```

并把三处失败分支的 `write_manifest '{}' 0 '' false` 保留（它们已经写了 `ok:false` + `failed_at`）。

- [ ] **Step 4: 跑绿**

```bash
node tools/conformance/dist/run.js slice-07.5-backup --render
```
Expected: 绿。

- [ ] **Step 5: 提交**

```bash
git add scripts/ops/backup.sh tools/conformance/src/slices/slice-07.5-backup.ts
git commit -m "feat(ops): backup.sh 的预检/锁/原子失败 + 判据 e/f/g"
```

---

## Task 3: `restore.sh` + `restore-drill.sh`（判据 b/c/d/i2/j）

**Files:**
- Create: `scripts/ops/restore.sh`
- Create: `scripts/ops/restore-drill.sh`
- Modify: `tools/conformance/src/slices/slice-07.5-backup.ts`

**Interfaces:**
- Consumes: `backup.sh` 的全部参数 + manifest 结构（`image_tag` / `image_tag_usable` / `artifacts` / `caddy_entries`）
- Produces: `restore.sh` 的完整参数表（含 `--image-tag` `--stack-container` `--app-services` `--restore-caddy` `--restore-env` `--yes-i-know`）；root 身份拒绝

- [ ] **Step 1: 写失败判据**（判据 b 的内容级负对照、c 的内容下限、d、i2、j）

**判据 b 的负对照必须是「行数相同、内容不同」**（改掉一条 INSERT 的昵称），否则会先撞上 sha256 或行数截断检测 —— 那等于没测比对逻辑。

- [ ] **Step 2: 跑，确认红**（`restore.sh` 不存在）

- [ ] **Step 3: 写 `restore.sh`**

顺序**固定**（见设计 §4.2）：① 现场备份（**在停服之前**）→ ② 停业务面 → ③ 校验+截断检测 → ④ DROP+灌入 → ⑤ 按需还原 → ⑥ **先校验镜像再**起栈 → ⑦ 冒烟。

关键片段：

```bash
# 身份机械闸（优于手册措辞 —— 实测「root 写的 manifest 会假红」只在对产物 chmod 0600 时才成立）
if [ "$(id -u)" = 0 ]; then
  echo "拒绝以 root 运行：备份目录是 0700 ubuntu，root 写出的产物 ubuntu 读不到 ⇒ 新鲜度假红。" >&2
  echo "请以 ubuntu 身份运行：ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器>" >&2
  exit 2
fi

# 非交互豁免：唯一的开关就是 --yes-i-know
if [ ! -t 0 ] && [ "$YES" != 1 ]; then
  echo "拒绝非交互执行（恢复永远是人决定的事）。演练请显式传 --yes-i-know。" >&2
  exit 2
fi

# ① 现场备份（独立锁，等待+超时）
bash "$(dirname "$0")/backup.sh" --dest "$BACKUP_DIR" --artifact-prefix restore- \
  --mysql-container "$MYSQL_CONTAINER" --db-name "$DB_NAME" \
  --edge-container "$EDGE_CONTAINER" --env-file "$ENV_FILE" --stack-container "$STACK_CONTAINER"

# ② 停业务面（清单来自 --app-services；空集 = 演练形态）
for svc in $APP_SERVICES; do docker stop "$svc" >/dev/null; done

# ⑥ 先校验、再起栈
for svc in $APP_SERVICES; do
  docker image inspect "${IMAGE_PREFIX}-${svc}:${IMAGE_TAG}" >/dev/null 2>&1 || {
    echo "拒绝起栈：本地没有 ${IMAGE_PREFIX}-${svc}:${IMAGE_TAG}" >&2; exit 1; }
done
export IMAGE_PREFIX IMAGE_TAG
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
```

- [ ] **Step 4: 写 `restore-drill.sh`（只在开发机/CI）**

```bash
#!/usr/bin/env bash
# 恢复演练 —— **只在开发机 / CI 跑，永不投递到生产**（设计 §4.3）。
# 范围 = DB 路径 + 一条经由真 user-service 的写路径。
set -euo pipefail

RUN_ID="c75b-$(date +%s)-$$"
MYSQL="${RUN_ID}-mysql"; REDIS="${RUN_ID}-redis"; APP="${RUN_ID}-user"
DB=ftl_probe
ROOT="$(mktemp -d)"
DEST="$ROOT/dest"; ENVF="$ROOT/.env"; CADDY="$ROOT/caddy"
mkdir -p "$DEST" "$CADDY"
printf 'JWT_SECRET=probe\nDB_PASSWORD=probe-root\n' > "$ENVF"

cleanup() {
  for c in "$APP" "$REDIS" "$MYSQL"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  rm -rf "$ROOT"
}
trap cleanup EXIT

# ── 起 scratch（三者共用 MySQL 的 netns ⇒ 不新建网络、不发布宿主端口）──────────
docker run -d --name "$MYSQL" -e MYSQL_ROOT_PASSWORD=probe-root -e MYSQL_DATABASE="$DB" \
  -v "$CADDY":/caddy-seed mysql:8.0 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$MYSQL" mysqladmin ping -uroot -pprobe-root >/dev/null 2>&1 && break
  sleep 2
done
docker run -d --name "$REDIS" --network "container:$MYSQL" redis:7-alpine >/dev/null
docker run -d --name "$APP" --network "container:$MYSQL" \
  -e REDIS_URL=redis://127.0.0.1:6379 -e DB_HOST=127.0.0.1 -e DB_NAME="$DB" \
  -e DB_USER=root -e DB_PASSWORD=probe-root \
  -e JWT_SECRET=probe -e INTERNAL_SERVICE_TOKEN=probe \
  pokergame-user-service:latest >/dev/null

# ── 播种已知数据（期望值**只能**来自这里，不能来自 manifest）────────────────
docker exec "$MYSQL" mysql -uroot -pprobe-root "$DB" -e \
  "CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY, nickname VARCHAR(64));
   INSERT INTO users VALUES ('u1','alice'),('u2','bob');"
EXPECT="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B "$DB" -e \
  'SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;')"

# ── 备份 ────────────────────────────────────────────────────────────────
bash "$(dirname "$0")/backup.sh" --dest "$DEST" --mysql-container "$MYSQL" --db-name "$DB" \
  --edge-container "$MYSQL" --env-file "$ENVF" --stack-container "$MYSQL" --min-free-mb 0

# ── 破坏源库，然后恢复（**这才是演练**：不破坏就分不清「恢复了」与「本来就在」）──
docker exec "$MYSQL" mysql -uroot -pprobe-root -e "DROP DATABASE $DB;"
bash "$(dirname "$0")/restore.sh" --yes-i-know \
  --app-services "" \
  --mysql-container "$MYSQL" --db-name "$DB" \
  --backup-dir "$DEST" \
  --backup-ts "$(ls -1 "$DEST"/manifest-*.json | tail -1 | sed 's/.*manifest-//;s/\.json//')" \
  --skip-caddy --skip-env

# ── 比对（期望值来自我们自己的播种）────────────────────────────────────
ACTUAL="$(docker exec "$MYSQL" mysql -uroot -pprobe-root -N -B "$DB" -e \
  'SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;')"
if [ "$ACTUAL" != "$EXPECT" ]; then
  echo "❌ 演练失败：恢复后的内容与播种的期望值不一致" >&2
  echo "   期望：$EXPECT" >&2; echo "   实得：$ACTUAL" >&2
  exit 1
fi

# ── 判据 4：经由真 user-service 走一条写路径 ────────────────────────────
# 只验「起得来」不够：唯一的迁移是 CREATE TABLE IF NOT EXISTS 且 migrationsRun: true
# ⇒ **空库也起得来**。必须真的写一次，才证明「恢复了表却用不了」被抓到。
# 契约（实测 packages/user-service/src/users/users.controller.ts:16 + users.dto.ts:3-14）：
#   POST /auth/register   body {phone(≥11位), password(≥6位), nickname?}   → {code, data}
# 走服务自己的端口（默认 3001；三个 scratch 容器同一 netns ⇒ 127.0.0.1 够得到）
REG="$(docker exec "$APP" node -e '
  fetch("http://127.0.0.1:3001/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "13800000001", password: "Drill!2345", nickname: "drill" }),
  }).then(async (r) => { process.stdout.write(String(r.status)); })
    .catch((e) => { process.stderr.write(String(e)); process.exit(9); });
')"
if [ "$REG" != "201" ] && [ "$REG" != "200" ]; then
  echo "❌ 演练失败：恢复后的库**喂给真 user-service 走不通写路径**（HTTP $REG）" >&2
  exit 1
fi
echo "   ↳ 写路径 HTTP $REG（注册走通 ⇒ 恢复后的 schema 被代码用得起来）"

echo "✅ 演练通过：恢复后的内容与播种一致（${ACTUAL}），且真服务写路径走通"
```

⚠️ **`--app-services` 传空集 = 演练形态**：`restore.sh` 收到空清单时，②（停业务面）与
⑥⑦（校验镜像 / 起栈 / 冒烟）**整段跳过** —— 这就是「演练只走 DB 路径」的落地方式。
**不要**为它另加什么 `--restart-hook` / `--smoke-hook`：那会多出一处可注入面
（「恢复」就有了跳过起栈与冒烟的后门），而空清单本来就能表达同一件事。
生产调用**必须**给非空清单；`restore.sh` 应当在清单为空**且**没传 `--yes-i-know` 时拒绝执行。

- [ ] **Step 5: 跑绿 + 提交**

```bash
node tools/conformance/dist/run.js slice-07.5-backup --render
git add scripts/ops/restore.sh scripts/ops/restore-drill.sh tools/conformance/src/slices/slice-07.5-backup.ts
git commit -m "feat(ops): restore.sh（参数化+身份闸）+ restore-drill.sh + 判据 b/c/d/i2/j"
```

---

## Task 4: `install-cron.sh`（判据 k）

**Files:** Create `scripts/ops/install-cron.sh`；Modify 切片

- [ ] **Step 1: 写失败判据**（连跑两次恰好一行；别人的行还在；crontab 命令失败 ⇒ 红且**不得改动 crontab**）
- [ ] **Step 2: 跑，确认红**
- [ ] **Step 3: 实现**

```bash
#!/usr/bin/env bash
set -euo pipefail
LINE='17 * * * * /bin/bash /home/ubuntu/ftl-ops/backup.sh >> /dev/null 2>&1 # ftl-backup'
CRONTAB_CMD="${CRONTAB_CMD:-crontab}"     # 测试可注入

cur="$("$CRONTAB_CMD" -l 2>/tmp/ftl-cron-err)" && rc=0 || rc=$?
# 🔴 只容忍「没有 crontab」这一种失败；别的失败必须响亮退出，绝不覆盖用户的 crontab
if [ "$rc" != 0 ] && ! grep -qi 'no crontab' /tmp/ftl-cron-err; then
  echo "❌ crontab -l 失败（非「没有 crontab」）：$(cat /tmp/ftl-cron-err)" >&2
  exit 1
fi
printf '%s\n%s\n' "$(printf '%s\n' "$cur" | grep -v '# ftl-backup' | sed '/^$/d')" "$LINE" \
  | grep -v '^$' | "$CRONTAB_CMD" -
```

- [ ] **Step 4: 跑绿 + 提交**

```bash
git commit -am "feat(ops): install-cron.sh（只容忍「没有 crontab」一种失败）+ 判据 k"
```

---

## Task 5: `check-backup-fresh.sh`（判据 h）

**Files:** Create `scripts/ops/check-backup-fresh.sh`；Modify 切片

- [ ] **Step 1: 写失败判据**：`ok:true` 且三件产物齐 ⇒ 过；做成旧的 ⇒ 红；**只有 `ok:false` ⇒ 红**；**一个都没有 ⇒ 红**（两种红**文案可分辨**）
- [ ] **Step 2: 跑，确认红**
- [ ] **Step 3: 实现**

> ⚠️ **订正（收尾轮，2026-09-26）**：下面这段原先写的是 `manifest-*.json`（**没有 `[0-9]`**）—— 那是个**真缺陷**：`manifest-restore-…json`（恢复脚本给自己留的现场备份）也是 `manifest-` 开头，无差别的 glob 会把**一次恢复**读成「每小时的备份还活着」。
> 落地时**没有照抄这一段**：判据 h 的实现（`scripts/ops/check-backup-fresh.sh`）从出生（`5cda6f2`）起就是 `manifest-[0-9]*.json`；同一个缺陷**另外**出现在手册里，由「手册修复轮」的 **I1**（`b087cb8`）订正。
> ⇒ 下面已按**已落地**的形态重写（两处 glob），照它抄。

```bash
#!/usr/bin/env bash
# runner 侧：ssh 出去读 manifest。阈值默认 3 小时。
set -euo pipefail
: "${SSH_HOST:?缺 SSH_HOST}"; : "${SSH_KEY:?缺 SSH_KEY}"
DEST=/home/ubuntu/ftl-backups; MAX_HOURS=3
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "ubuntu@$SSH_HOST")

if ! out="$("${SSH[@]}" "ls -1 $DEST/manifest-[0-9]*.json 2>/dev/null || true")"; then
  echo "❌ 备份新鲜度：ssh 探测失败（拿不到回答）—— 无法完成断言" >&2; exit 1
fi
[ -n "$out" ] || { echo "❌ 备份新鲜度：**一个 manifest 都没有** —— 备份从未成功过" >&2; exit 1; }

newest_ok="$("${SSH[@]}" "grep -l '\"ok\":true' $DEST/manifest-[0-9]*.json 2>/dev/null | sort | tail -1 || true")"
[ -n "$newest_ok" ] || { echo "❌ 备份新鲜度：**没有任何 ok:true 的 manifest** —— 最近几次全失败" >&2; exit 1; }

# 同一趟里断言三件产物都在
"${SSH[@]}" "set -e; d=\$(dirname $newest_ok); n=\$(basename $newest_ok .json); n=\${n#manifest-}; \
  for f in users-\$n.sql.gz caddy-data-\$n.tgz env-\$n.gz; do [ -f \"\$d/\$f\" ] || { echo MISSING_\$f; exit 1; }; done" \
  || { echo "❌ 备份新鲜度：最新 ok manifest 的**产物不全** —— 绿着但没有可恢复的东西" >&2; exit 1; }

age_h="$("${SSH[@]}" "ts=\$(basename $newest_ok .json); ts=\${ts#manifest-}; \
  echo \$(( ( \$(date -u +%s) - \$(date -u -d \"\${ts:0:8} \${ts:8:2}:00:00\" +%s) ) / 3600 ))")"
if [ "$age_h" -ge "$MAX_HOURS" ]; then
  echo "❌ 备份新鲜度：最近一次成功备份在 **${age_h} 小时前**（阈值 ${MAX_HOURS}h）。站是好的，**别回滚**，去看手册「备份还活着吗」那节" >&2
  exit 1
fi
echo "✅ 备份新鲜度：${age_h} 小时前成功过，且产物齐"
```

- [ ] **Step 4: 跑绿 + 提交**

```bash
git commit -am "feat(ops): check-backup-fresh.sh（读最近一个 ok manifest + 断言产物齐）+ 判据 h"
```

---

## Task 6: 接线 —— `PREFIX_FILES` · `deploy.sh` 投递 · `release.yml` **三步**（判据 i1/l）

> ⚠️ **订正（收尾轮，2026-09-26）—— 两件事**：
> ① **标题原写「两步」，落地后实际是三步。** T6 落地时（`10034bb`）确实只加了两步（「装备份」那一步把「投递 + 装 cron + **仅当还没有 ok:true 就立刻跑一次**」挤在一起）；**第一轮修复轮 C1**（`1b9a3c0`）把「首跑」拆成**独立一步**、并移到**部署之后**（排在部署之前会让**首次发布死锁**：栈还没起 ⇒ `docker exec ftl-mysql` 必红 ⇒ 隐式 `success()` 把 `部署` 那一步跳过）⇒ 现在是**三步**：装备份 / 首次备份 / 备份新鲜度（下面 Step 4 的片段是**拆之前**的形态）。
> ② **执行顺序实际是 T7 先于 T6。** 本任务的判据 i1 读的是手册「数据没了怎么办」那一节，而那一节是 **T7** 才写出来的 —— 按计划原序（T6→T7）执行，i1 会读到一个**还不存在**的节（抽取为空 ⇒ 前提自证红，或退化成空测）。实际顺序：**T7（`4334a07`）→ 手册修复轮（`b087cb8`）→ T6（`10034bb`）**。

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.4-pipeline.ts`（`PREFIX_FILES`）
- Modify: `scripts/deploy/deploy.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `.gitignore`
- Modify: `tools/conformance/src/slices/slice-07.5-backup.ts`（i1、l）

**Interfaces:**
- Consumes: 五个脚本
- Produces: `/home/ubuntu/ftl-ops/` 恰好三个脚本（`backup.sh` `restore.sh` `install-cron.sh`）

- [ ] **Step 1: `PREFIX_FILES` 加 5 个文件（**逐个列出，不是 glob**）**

```ts
  'scripts/ops/backup.sh',
  'scripts/ops/restore.sh',
  'scripts/ops/install-cron.sh',
  'scripts/ops/restore-drill.sh',
  'scripts/ops/check-backup-fresh.sh',
```

⚠️ 与五个脚本**同一个提交**落地，否则那个提交上扫描必红（`readFileSync` ENOENT）。

- [ ] **Step 2: `.gitignore` 加两行**

```
*.sql.gz
*.tgz
```

- [ ] **Step 3: `deploy.sh` 投递（🔴 **不得碰不加引号的 heredoc 正文**）**

在 `deploy.sh` 里 `scp … docker-compose.yml "$TARGET:$REMOTE_DIR/docker-compose.yml"` **那一行之后**、
`printf '=== [deploy] tag=%s 拉取 + 起栈 + 冒烟 ===\n'` **那一行之前**加：

```bash
printf '=== [deploy] 投递 ops 脚本到 %s/ftl-ops/ ===\n' "$TARGET"
ssh_do "mkdir -p /home/ubuntu/ftl-ops && chmod 700 /home/ubuntu/ftl-ops"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
  scripts/ops/backup.sh scripts/ops/restore.sh scripts/ops/install-cron.sh \
  "$TARGET:/home/ubuntu/ftl-ops/"
ssh_do "chmod 700 /home/ubuntu/ftl-ops/*.sh; bash /home/ubuntu/ftl-ops/install-cron.sh"
```

⛔ **只在 heredoc 之外加** —— 那段正文里注释的裸反引号都真的在生产上跑过（片② 的血泪）。

- [ ] **Step 4: `release.yml` 加三步（**step，不是 job**）**（原写「两步」；见本任务头部订正①）

投递+首跑那一步放在 `deploy` 步骤**之前**；新鲜度那一步放在 `deploy` 步骤**之后**：

> ⚠️ **这一句的前半已被 C1 证伪**：**首跑必须在 `deploy` 之后**（排在前面会让首次发布死锁 —— 见本任务头部订正①）。落地形态：**投递 + 装 cron** 那一步在 `deploy` 之前（照此段）；**首跑**独立成步、在 `deploy` **之后**；新鲜度仍是最后一步。

```yaml
      - name: 装备份（投递 + 装 cron + 首次立刻跑一次）
        if: github.event_name == 'push'
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_USER: ${{ secrets.SSH_USER }}
          SSH_KEY: ${{ runner.temp }}/deploy_key
          DEPLOY_KEY_CONTENT: ${{ secrets.SSH_KEY }}
        run: |
          set -euo pipefail
          printf '%s\n' "$DEPLOY_KEY_CONTENT" > "$SSH_KEY"; chmod 600 "$SSH_KEY"
          # ⚠️ 仅当还没有 ok:true 的 manifest 时才立刻跑 —— 见设计 §5（否则新鲜度判据恒绿）

      - name: 备份新鲜度（与本次发布无关 —— **站是好的，别回滚**）
        if: github.event_name == 'push'
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_KEY: ${{ runner.temp }}/deploy_key
          DEPLOY_KEY_CONTENT: ${{ secrets.SSH_KEY }}
        run: |
          set -euo pipefail
          printf '%s\n' "$DEPLOY_KEY_CONTENT" > "$SSH_KEY"; chmod 600 "$SSH_KEY"
          bash scripts/ops/check-backup-fresh.sh
```

- [ ] **Step 5: 判据 i1 与 l**

i1：从手册恢复那节抽取所有 `--flag`，断言每个都能在 `restore.sh --help` 里找到；**负对照 = 把 `--backup-ts` 改成 `--ts` ⇒ 必须红**（⚠️ **不能**用「删掉手册里一步」，那只会让集合更小、恒绿）。
l：断言仓库里没有被跟踪的 `*.sql.gz` / `*.tgz`。

- [ ] **Step 6: 跑 + 提交**

```bash
pnpm run ci                      # 六阶段（含 slice-07.4-pipeline 的前缀扫描）
git commit -am "feat(ci): ops 脚本进 PREFIX_FILES + deploy 投递 + release 两步 + 判据 i1/l"
```

---

## Task 7: 手册两节 + 订正

**Files:** Modify `docs/ops/first-deploy.md`

- [ ] **Step 1: 加两个**顶层**节**（与 ⑧ 回滚并列）：**「数据没了怎么办」**（= `restore.sh` 的手册化，**含一条逐字可复制的整行命令**）与**「备份还活着吗」**（`cat` 最新 manifest 看 `"ok": true`；⚠️ **不用 `ls -lt`**）
- [ ] **Step 2: ⑥ 的速查表补一行**「数据/表不见了 ⇒ 去看『数据没了怎么办』」
- [ ] **Step 3: 订正 详注④** 的「代码侧无法补救」（本片上线的正是它的补救路径）
- [ ] **Step 4: `16 个切片` ⇒ 17，连同同一句里的构成**（`15 个真栈 + 1 个流水线清点` ⇒ `16 + 1`）
- [ ] **Step 5: 订正旧机事实**（`≈33G` ⇒ 新机，**写清哪台机器、哪天量的**；保留「**≥20GB** 才是有约束力的要求」）
- [ ] **Step 6: 提交**

```bash
git commit -am "docs(ops): 手册新增「数据没了怎么办」「备份还活着吗」+ 16→17 + 旧机事实订正"
```

---

## Task 8: 基线回填 + 全量门禁

**Files:** Modify `tools/conformance/baselines.json`

- [ ] **Step 1: 起真栈**（新切片需要它 —— `run.ts:119`）

```bash
bash scripts/deploy/conformance-stack.sh up
```

- [ ] **Step 2: 跑新切片并回填 `full` 列**

```bash
node tools/conformance/dist/run.js slice-07.5-backup
```
把实测条数填进 `baselines.json` 的 `full` 段（键 = `slice-07.5-backup`）。

- [ ] **Step 3: 负对照（必做）**：把该键调高 1 ⇒ 重跑 ⇒ **必须红**在 `check-baselines`；复原 ⇒ 绿。

- [ ] **Step 4: 全量门禁**

```bash
pnpm run ci
for c in $(node tools/conformance/dist/run.js --list); do node tools/conformance/dist/run.js "$c"; done
node scripts/check-baselines.mjs --self-test
node scripts/browser-e2e.mjs --scenario gate   # --no-server + CHROME_BIN + --cdp-port 18800
node scripts/browser-e2e.mjs --scenario full
git hash-object scripts/browser-e2e.mjs        # 052b98b7ab779ae280d6673729053145e9829604
```

- [ ] **Step 5: 拆栈 + 提交**

```bash
bash scripts/deploy/conformance-stack.sh down
git commit -am "test(conformance): slice-07.5-backup 基线回填（判据只增不减）"
```

---

## Task 9: 生产验收（**交接文档级粒度**）

**Files:** Create `docs/superpowers/plans/2026-09-<date>-backup-production-acceptance.md`

> ⚠️ 本任务**需要用户在场**（真实恢复由人驱动）。按设计 §6.2 的四步走。
> ⚠️ 生产 `users` 表 **0 行**、且有现场备份兜底 ⇒ 风险极低。

- [ ] **Step 1: 装 + 第一份 manifest**：推 master ⇒ 断言 `ok:true` manifest 出现
- [ ] **Step 2: 新鲜度必须能红**：把**所有** `ok:true` manifest 移出目录 ⇒ 发布 ⇒ **新鲜度那步必须红，且只因为这一个原因**；放回 ⇒ 发布 ⇒ 绿
- [ ] **Step 3: 真人恢复一次**：照手册逐条做 ⇒ **记录每步命令与实得输出、耗时**
- [ ] **Step 4: 写进交接文档**（照 `2026-09-25-deploy-handoff.md` 的格式）

---

## Self-Review 记录

- **Spec coverage**：§4.1→T1/T2 · §4.2→T3 · §4.3→T3 · §4.4→T5 · §5→T6 · §6.1(a–l)→T1/T2/T3/T4/T5/T6 · §6.2→T9 · §6.4→T6 · §7→T7 · §8/§9→贯穿 · 基线回填→T8。
- **类型一致性**：参数名在 T1 定义、T3/T5/T6 引用一致（`--dest` `--db-name` `--artifact-prefix` `--image-tag` `--stack-container` `--yes-i-know`）。
- **上游仍未定的**（计划层合法解决，不是缺陷）：scratch Redis 的具体启动参数 · 文件命名的细节 · `PREFIX_FILES` 的最终枚举。
