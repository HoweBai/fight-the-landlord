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
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Checks, ConformanceError, fieldSetViolations, info, step, type SkippedAssertion } from '../lib/assert';

const REPO_ROOT = resolve(__dirname, '../../../..');
const BACKUP_SH = join(REPO_ROOT, 'scripts', 'ops', 'backup.sh');
/** 装用户级 cron 的脚本（Task 4）：由部署流水线投递到 `/home/ubuntu/ftl-ops/`（设计 §5）。 */
const INSTALL_CRON = join(REPO_ROOT, 'scripts', 'ops', 'install-cron.sh');
// ⚠️ 这两个常量与 `shQuiet` 供后续任务（restore.sh 的判据 b/c/d/i2/j）在本文件内使用；
//    `export` 是必需的：本包 tsconfig `noUnusedLocals: true` ⇒ 未导出且未被读取的声明
//    会让 `tsc` 报 TS6133、`noEmitOnError` 下直接 build 失败。
export const RESTORE_SH = join(REPO_ROOT, 'scripts', 'ops', 'restore.sh');
/** 恢复**演练**脚本：**只在开发机 / CI 跑，永不投递生产**（设计 §4.3）。 */
export const RESTORE_DRILL = join(REPO_ROOT, 'scripts', 'ops', 'restore-drill.sh');
export const COMPOSE = join(REPO_ROOT, 'docker-compose.yml');

/** 每次调用唯一的前缀 —— 固定名会让重跑假红（本仓有 21 条全红的前科）。 */
const RUN_ID = `c75b-${process.pid}-${Date.now().toString(36)}`;
const MYSQL = `${RUN_ID}-mysql`;
const REDIS = `${RUN_ID}-redis`;
const APP = `${RUN_ID}-user`;
const DB = 'ftl_probe';

/**
 * manifest 顶层字段集（**恰好**这七个 —— 设计 §4.1「manifest 字段完整」）。
 * 判据 a 用它做 key-set 检查：只断言 ok/ts/三条 sha256 时，一份**静默丢掉**
 * `failed_at` / `caddy_entries` / `image_tag` / `image_tag_usable` 的 manifest 照样全绿。
 */
const MANIFEST_FIELDS = ['ts', 'ok', 'failed_at', 'artifacts', 'caddy_entries', 'image_tag', 'image_tag_usable'] as const;
/** 每件产物的字段集（**恰好** —— 设计 §4.1：manifest「只记 sha256 / 大小 / 结构 / 版本」）。 */
const ARTIFACT_FIELDS = ['sha256', 'bytes'] as const;

/**
 * `restore.sh` 截断检测的锚点：mysqldump 写在 dump **最后一行**的收尾标记。
 *
 * 脚本那一侧是 `tail -c 400 "$PLAIN" | grep -q 'Dump completed'`；这里多带行首的 `-- `，
 * 是为了让判据 ③ 的负对照能**精确截在那一行前面**（随便砍 N 字节有可能恰好留下那 14 个字符
 * ⇒ 负对照会飘）。两处口径必须一起改，改一处 ⇒ 负对照当场红。
 */
const TRUNC_MARKER = '-- Dump completed';

function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}
export function shQuiet(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'ignore' });
}
/** 容错版：失败不抛，用于 `finally` 里的清理。 */
function shTry(cmd: string, args: string[]): void {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch { /* 清理路径，吞掉 */ }
}

/** 容错版 + **读回输出**：失败返回 `''`（`finally` 里要读一点东西时用 —— `shTry` 只吞、不返）。 */
function shTryOut(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return ''; }
}

/** `kill(pid, 0)` 探活；EPERM（进程在、但不归本用户）**保守算活着** —— 宁可漏收，不误杀并发 run。 */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * 回收**已死进程**遗留的 scratch 容器（复核 Minor 3）**与网络**（第三轮复核 Important 1）。
 *
 * ⚠️ 名字是**进程唯一**的（`RUN_ID` 带 pid）⇒ 开工前 `docker rm -f <自己的名字>` 只防
 *    **进程内重入**（`up()` 被调两次），**永远匹配不到**上一轮的死残留；而
 *    `conformance-stack.sh` 的收尾断言只匹配 `^/ftl-`、**看不见** `c75b-*`。硬杀
 *    （Ctrl-C / SIGKILL）时 `finally` 不执行 ⇒ 残留只能由**下一轮**收 —— 这段就是它
 *    （不硬杀时它是空转，一行也不删）。
 * ⚠️ 不能按 `c75b-` 前缀一律删：**同机并发**的另一个 run 也用这个前缀、且它活着。
 *    所以按名字里的 **pid** 判活（唯一命名时特意放进去的）：活 ⇒ 跳过；pid 复用 /
 *    EPERM ⇒ 保守算活。名字第二段解析不出整数（不是本切片的命名形态）⇒ 一并跳过。
 */
function reapDeadRuns(): void {
  const names = sh('docker', ['ps', '-a', '--filter', 'name=^/c75b-', '--format', '{{.Names}}'])
    .split('\n').map((n) => n.trim()).filter((n) => n !== '');
  for (const name of names) {
    const pid = Number(name.split('-')[1]);
    if (!Number.isInteger(pid) || processAlive(pid)) continue;
    info(`回收死 run 残留：docker rm -f ${name}（进程 ${pid} 已不存在）`);
    shTry('docker', ['rm', '-f', name]);
  }
  // **网络**：判据 j4 的 `docker compose up -d` 会在宿主上建一个 bridge 网络（`<project>_default`）
  // —— 硬杀（Ctrl-C / SIGKILL）时 `finally` 不跑 ⇒ 残留只能由**下一轮**收，与容器同一条纪律。
  // 不收的话每跑几次就净吃掉一个 172.x/16，最后本栈自己的 `docker compose up`（钉死
  // 172.28.0.0/16）会 `Pool overlaps …` —— 红点长在别的工具里，根因却在这一片。
  // ⚠️ 顺序：**先收容器、再收网络**（网络上有**活动** endpoint 时 `network rm` 会失败；实测容器已停
  //    时不会失败 —— 不赌它，一律先收容器）。
  for (const net of dockerNetworkNames()) {
    if (!deadRunNetwork(net)) continue;
    const pid = Number(net.split('-')[1]);
    info(`回收死 run 残留：docker network rm ${net}（进程 ${pid} 已不存在）`);
    shTry('docker', ['network', 'rm', net]);
  }
}

/** 宿主上所有 docker 网络名（收尾断言与 `reapDeadRuns` 共用）。 */
function dockerNetworkNames(): string[] {
  return sh('docker', ['network', 'ls', '--format', '{{.Name}}'])
    .split('\n').map((n) => n.trim()).filter((n) => n !== '');
}

/**
 * 这条网络名是不是「一个**已经没人管**的 run 留下的」：`c75b-<pid>-…` 且那个 pid 已不存在。
 *
 * ⚠️ 与容器的回收**同一条纪律**：名字是进程唯一的，所以能按名字里第二段的 pid 判活；
 *    活 ⇒ 不是残留（**同机并发**的另一个 run 也用这个前缀）；pid 解析不出整数（不是本切片
 *    的命名形态）⇒ 一并跳过；`EPERM`（进程在但不归本用户）保守算活着 —— 宁可漏收，不误杀。
 */
function deadRunNetwork(name: string): boolean {
  if (!name.startsWith('c75b-')) return false;
  const pid = Number(name.split('-')[1]);
  return Number.isInteger(pid) && !processAlive(pid);
}

/**
 * 收尾断言的判据：这条网络算不算本片**泄漏**的 —— 本 run 自己的（`RUN_ID` 前缀；判据 j4 的
 * `<project>_default` 就是它）**或**一个死 run 留下的。
 *
 * 唯一实现（正断言与负对照共用 ⇒ 谓词有没有判别力可以拿合成名字直接证明）。
 */
function leakedRunNetwork(name: string): boolean {
  return name.startsWith(RUN_ID) || deadRunNetwork(name);
}

/**
 * 取文件的 sha256（**裸哈希**，无前导反斜杠）。
 *
 * ⚠️ Windows 本机迭代：MSYS 的 `sha256sum` 对**含反斜杠的路径**（`join()` 在 Windows 上的产物，
 *    如 `C:\Users\…\users-…sql.gz`）会输出 `\<hash>  C:\\…` —— 前导 `\` 是**转义标记**，不是哈希
 *    的一部分。Linux/CI 上是裸 `hash  /path`。不剥掉它，`\hash !== hash` ⇒ 判据 a 在 Windows 上
 *    假红（实测：MSYS coreutils 8.32）。
 */
function sha256Of(file: string): string {
  return sh('sha256sum', [file]).trim().split(/\s+/)[0].replace(/^\\/, '');
}

/**
 * 判据 d 的**派生期望**（支付配置管理化片规格 ⚙️15）：恢复产物 = 源 `.env` 逐行过滤
 * `^PAY_CONFIG_ENC_KEY=` 行后的**逐字内容**（行序 / 换行不变）。规则来自判据自己、**不读产物**
 * —— 拿产物当期望就是「一起对、一起错」（本文件已有同族纪律：期望值只能来自播种的源）。
 *
 * 与 `backup.sh` ⓒ 的 awk 剥离**同源假设**：锚定行首、裸 `KEY=` 行（无前导空白 / `export ` 前缀）——
 * 用户 `first-deploy` 手顺维持该形态。`startsWith` 即 `^` 锚定；对 CRLF 行同样成立（`\r` 在行尾、
 * 不影响行首判定，与 awk 的 record 语义一致）。
 * ⚠️ 一处与 awk 的边角差（**播种形态下不可达**）：源末行**无换行**时 awk 按 ORS 补一个 `\n`，
 * 本函数 split/join 不补；播种的 `.env` 恒以 `\n` 结尾，两者逐字一致（将来若改播种形态需同步）。
 */
function deriveEnvExpectation(source: string): string {
  return source.split('\n').filter((line) => !line.startsWith('PAY_CONFIG_ENC_KEY=')).join('\n');
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
    // 播种 `.env` 源文件 —— 与源卷同一条纪律（判据 d 要「与源**派生值**」比对：期望 = 源剔除
    // `PAY_CONFIG_ENC_KEY=` 行后的逐字内容，规则见 `deriveEnvExpectation`，期望值来自这里）。
    // ⚠️ 且 backup.sh ⓒ 是 `awk '!/^PAY_CONFIG_ENC_KEY=/' "$ENV_FILE" | gzip -c`：源文件不存在时
    //    awk **exit 2**（pipefail 接住）⇒ 备份走失败分支、判据 a 永远绿不了 ⇒ 必须播种。
    // ⚠️ 里面多一行 `SITE_ADDRESS`：恢复路径的 ⑦（冒烟）从**恢复后的** .env 里读它。
    //    值指向一个必然连不上的地址 ⇒ 判据 j 的那次恢复里冒烟**快速失败**（断言的是
    //    「冒烟真的跑了三条 curl」，**不是**「冒烟通过」—— scratch 里没有真的站，宣称它通过就是空头支票）。
    // ⚠️ 里面多一行 `PAY_CONFIG_ENC_KEY=probe`（T12 主钥剥离）：备份 ⓒ **必须剥掉**它。源里**必须有**
    //    这行，否则「剥离」判据退化成恒真谓词（源里没有 ⇒ 剥不剥拷出来都一样 ⇒ 把 awk 删了也没人红）。
    writeFileSync(this.envFile, 'JWT_SECRET=probe\nDB_PASSWORD=probe-root\nSITE_ADDRESS=127.0.0.1:1\nPAY_CONFIG_ENC_KEY=probe\n');
  }

  /**
   * 播种的源卷**文件集与内容** —— 判据 c 的期望值**只能**来自这里（设计 §6.1-c 第三轮 I-6）：
   * manifest 里那份是 `backup.sh` 自己数的，与产物**同生共死** ⇒ 拿它当期望值等于「一起对、一起错」。
   */
  readonly caddySeed: ReadonlyArray<{ readonly rel: string; readonly content: string }> = [
    { rel: 'certificates.pem', content: 'PROBE-CERT\n' },
    { rel: 'sub/account.json', content: '{"probe":true}\n' },
  ];

  /** 播种的源卷文件数 —— 判据 c 的内容下限（**来自测试自己，不是 manifest**）。 */
  readonly caddySeedFiles: number;

  up(): void {
    // 开工前清残留：① **死 run** 的（硬杀遗留 —— 唯一名字让下面这条同名自清永远匹配不到它们，
    //    真正的回收者是 reapDeadRuns）；② 同名自清只防**本进程重入**（up 被调两次）。
    reapDeadRuns();
    for (const c of [APP, REDIS, MYSQL]) shTry('docker', ['rm', '-f', c]);

    sh('docker', ['run', '-d', '--name', MYSQL,
      '-e', 'MYSQL_ROOT_PASSWORD=probe-root',
      '-e', `MYSQL_DATABASE=${DB}`,
      // 🔴 挂到 **/data**，不是别处：backup.sh 的证书卷那一步是 `docker exec <edge> tar … -C /data .`
      //    ⇒ scratch 里必须真有一个容器把「源卷」挂在 /data。mysql 自己的 datadir 是
      //    /var/lib/mysql，/data 空着 ⇒ 借用它当「卷持有者」，**不必再拉一个新镜像**。
      '-v', `${this.caddyDir}:/data`,
      'mysql:8.0']);

    // 等就绪（不用宿主端口 ⇒ 在容器内探）。
    // ⚠️ 探针**不能是裸 `mysqladmin ping`**：首次初始化时 entrypoint 的**临时服务器**会在同一个
    //    socket 上让 ping **exit 0**（本机实测时间线：t≈9–10s 一次，t≈10.5–14.4s 又失败），
    //    随后真服务器才起（t≈15.7s 起稳定应答）⇒ 只 ping 会提前 break，紧接着的 seed 正好落进
    //    「临时服务器已停、真服务器未起」的窗口，吃 `ERROR 2002 … socket (2)`（本机实测发生过）。
    // 🔴 2026-10-03 CI 实证再收紧（监控片 T13b 轮）：曾以为「真查一次库」就够 —— 但**临时服务器
    //    在库建好后同样答 `SELECT 1`**（它只是 skip-networking）⇒ 仍可能提前放行吃到同一个 2002。
    //    判定谓词改为 `SELECT @@port`：临时服务器 = 0（skip-networking），真服务器 = 3306
    //    ——**只有真服务器过**。且耗尽预算必须**响亮**（带容器日志），不许静默放行把底层错留给 seed。
    //    （这两点合起来才是「拦得住最像正确答案的那个错」：`SELECT 1` 就是那个最像的答案。）
    let mysqlReady = false;
    for (let i = 0; i < 90 && !mysqlReady; i++) {
      try {
        const port = sh('docker', ['exec', MYSQL, 'mysql', '-uroot', '-pprobe-root', '-N', '-B', '-e', 'SELECT @@port;']).trim();
        mysqlReady = port === '3306';
      } catch {
        // 尚未就绪（或正处于临时/真服务器的空档）——继续等
      }
      if (!mysqlReady) execFileSync('sleep', ['2']);
    }
    if (!mysqlReady) {
      let logs = '';
      try {
        logs = sh('docker', ['logs', '--tail', '30', MYSQL]);
      } catch {
        logs = '(docker logs 亦失败)';
      }
      throw new Error(`scratch mysql 未在预算内就绪（SELECT @@port 恒 ≠ 3306，90×2s）——容器日志尾部：\n${logs}`);
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
    // ⚠️ `SET SESSION group_concat_max_len`：默认 1024 B ⇒ 行多时拼串被**静默截断**，
    //    摘要就成了「截断后前缀」的摘要（尾部变化抓不住）—— 这正是判据 b 要杀的形态。
    const out = sh('docker', ['exec', MYSQL, 'mysql', '-uroot', '-pprobe-root', '-N', '-B', DB, '-e',
      'SET SESSION group_concat_max_len=1048576;' +
      'SELECT COUNT(*), COALESCE(GROUP_CONCAT(id,nickname ORDER BY id SEPARATOR "|"),"") FROM users;']).trim();
    const [count, concat] = out.split('\t');
    // ⚠️ digest 必须是**内容摘要**（复核 Minor 2）：此前这里是 `printf %s | wc` 式的**字符串长度** ——
    //    不是摘要，且 Tasks 2–5 原样复用 ⇒ 谁把它当内容比对谁得到**恒绿谓词**（判据 b 的负对照
    //    「行数相同、内容不同」正是长度谓词抓不住的形态）。改：sha256(拼串)，拼串口径与计划里
    //    演练脚本（`GROUP_CONCAT(id,nickname …)`）**同一编码**，两处比对可互相印证。
    return { count: Number(count), digest: createHash('sha256').update(concat, 'utf8').digest('hex') };
  }

  down(): void {
    for (const c of [APP, REDIS, MYSQL]) shTry('docker', ['rm', '-f', c]);
    // ⚠️ **删之前先把卷的属主交还给宿主进程**（CI 第二次 conformance 跑实测的红，见下）。
    //    `-v <caddyDir>:/data` 起过的容器**未必**留下宿主属主的文件：redis 官方镜像的 entrypoint 是
    //    `find . \! -user redis -exec chown redis '{}' +`，而它的 `WORKDIR` **就是 `/data`**
    //    ⇒ 判据 c 生产形态那条 `docker run … -v ${s.caddyDir}:/data redis:7-alpine` 一起，
    //    整棵树（含目录本身）就归 redis(999) 了。此后**任何宿主侧写/删都会 EACCES** ——
    //    CI 实测：先 `writeFileSync …/caddy-data/sub/account.json` 抛 EACCES（切片当场挂），
    //    紧接着这里的 `rmSync` 又 `unlink …/caddy-data/certificates.pem` EACCES。
    //    判据 c 的**三方内容比对**与这里的清理都建立在「宿主能读/能删」上 ⇒ 必须让它与属主无关。
    //    ⚠️ 这是**竞态**（容器 entrypoint 的 chown 与宿主下一次文件操作谁先到），同一份代码上一轮是绿的、
    //       这一轮红 —— 「睡一下再重试」那种只缩小窗口的修法不算修。这里的做法是不依赖属主：
    //       用一个 root 容器把属主 `chown -R` 回**本进程的 uid:gid**。卷在生产里只由容器写
    //       （`ftl-edge` 是 caddy 官方镜像，`/data` 是**命名卷**）⇒ 宿主侧本来就不该写它；
    //       这条 chown 只是把**本来就属于宿主**的权限交还，好让下面的 `rmSync` 照常干活。
    //    ⚠️ **不是「吞掉 EACCES」**：下面那个 `try` 仍是原样的兜底（Windows 上「打开着的 .lock 删不掉」
    //       那一族），本条 chown 失败时不吞结论、也不改任何判据 —— 判据一条都没变松。
    //    ⚠️ `--entrypoint sh` 是**必须**的：不覆盖 entrypoint 的话，redis 自己又会 chown 一次。
    //    ⚠️ Windows 没有 uid 语义（bind mount 不保留属主、chown 是空转）⇒ 取不到就退回 0:0
    //       （那边宿主侧本来也删得掉）。
    if (existsSync(this.caddyDir)) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
      shTry('docker', ['run', '--rm', '--entrypoint', 'sh', '-v', `${this.caddyDir}:/data`,
        'redis:7-alpine', '-c', `chown -R ${uid}:${gid} /data`]);
    }
    // ⚠️ 扩展（Task 2 锁判据带来）：`root` 里现在还有**测试自己 spawn 的进程**打开的 `.lock`
    //    （Windows 上「打开着的文件」可能删不掉）⇒ 删不干净**不许**把结论顶掉（一个 EPERM 抛出去
    //    会把真正的判据红盖成「跑挂」）。释放与等待见 `releaseLockHolders()`。
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch (e) {
      info(`scratch 目录没能删净（临时目录交给 OS 回收）：${String(e)}`);
    }
  }
}

/**
 * backup.sh 在 scratch 里的标准参数（判据 a 起各场景共用同一组；**不含**开头的 `bash` 本身）。
 * `extra` **追加在最后** ⇒ 同名参数覆盖前面的（脚本的参数循环是「后写赢」）。
 */
function backupArgs(s: Scratch, dest: string, extra: string[] = []): string[] {
  return [BACKUP_SH, '--dest', dest, '--mysql-container', MYSQL, '--db-name', DB,
          '--edge-container', MYSQL,          // scratch 里用 mysql 容器当「卷持有者」跑 tar
          '--env-file', s.envFile, '--stack-container', MYSQL, '--min-free-mb', '0', ...extra];
}

/**
 * 非抛出版跑一次 `backup.sh`，返回退出码与 `$DEST/backup.log` 全文。
 *
 * ⚠️ **预期会失败**的那几次备份**不许**用 `sh('bash', …)` 跑：`execFileSync` 抛的是
 *    `Command failed: …`，而 `run.ts` 只打印 `err.message`（**不含 stderr**）⇒「为什么失败」
 *    （`backup.log` 里那一行）在结论里看不见 —— 本仓明写过「跑挂 ≠ 判据红」。
 */
function runBackupRaw(s: Scratch, dest: string, extra: string[] = []): { status: number | null; log: string } {
  const r = spawnSync('bash', backupArgs(s, dest, extra), { encoding: 'utf8' });
  const logPath = join(dest, 'backup.log');
  return { status: r.status, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}

/** 日志尾部 —— 失败断言里带上它，结论里才看得见原因。 */
function tail(log: string, lines = 2): string {
  return log.trim().split('\n').slice(-lines).join(' / ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3（restore.sh / restore-drill.sh）用的工具。**逐字复用 Task 1/2 的 `sh`/`Scratch`/`truth`**。
// ─────────────────────────────────────────────────────────────────────────────

/** `bash <script> <args…>` 的非抛出版，stdout+stderr 一起收 —— 断言失败时原因才看得见。 */
function runScript(script: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 输出尾部若干行（跑挂/红时把现场带进结论）。 */
function tailOut(out: string, lines = 6): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/**
 * `bash -c <program> _ <args…>` —— 在**受控环境**里跑（顶掉 `id`、伪造 TTY 都靠它）。
 * 参数经 `$@` 传进去 ⇒ 不必手工拼引号，Windows 的路径也不会在拼接处被改写。
 */
function runBashC(program: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync('bash', ['-c', program, '_', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 单引号 shell 引用（只用在一个地方：把整条命令交给 `script -qec`）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 宿主路径 → POSIX 形态。
 * ⚠️ Windows 上 `C:\Users\…` 交给 bash 当**脚本路径**会在反斜杠上炸；而在**参数**位置上
 *    MSYS 的 coreutils 反而两种都收（backup.sh 的参数一直是 Windows 形态，Task 1/2 实测可跑）。
 *    所以只在「当脚本路径 / 写进生成脚本」时用它。
 */
function posixPath(p: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

/** 镜像 tag —— 与 `backup.sh` ⓓ **同一口径**（`[[IMG##*:]]` == 最后一个冒号之后）。 */
function imageTagOf(container: string): string {
  const img = sh('docker', ['inspect', '--format', '{{.Config.Image}}', container]).trim();
  const i = img.lastIndexOf(':');
  return i < 0 ? '' : img.slice(i + 1);
}

/** 四件套里三件产物的文件名（与 `backup.sh` 逐字一致）。 */
function productFile(ts: string, key: 'users' | 'caddy' | 'env'): string {
  return key === 'users' ? `users-${ts}.sql.gz` : key === 'caddy' ? `caddy-data-${ts}.tgz` : `env-${ts}.gz`;
}

/** 目录下的**文件**清单（相对路径、POSIX 分隔符、**含隐藏文件**、递归）。 */
function listFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * 证书卷的三方比对（**唯一一份实现**，正/负对照共用 ⇒ 谓词有没有判别力可以用合成输入直接证明）。
 *
 * 三方 = 播种进 scratch 源卷的那份（**内容下限**）· 备份产物里的归档清单 · 解包结果。
 * ⚠️ 期望值**不来自 manifest**（第三轮 I-6）：manifest 的 `caddy_entries` 是 `backup.sh` 数的，
 *    与产物同生共死；这里只把 manifest 那一份用于「归档清单 vs 解包结果」这一层。
 */
function caddyViolations(extracted: string[], archive: string[], seed: string[]): string[] {
  const v: string[] = [];
  const miss = seed.filter((f) => !extracted.includes(f));
  if (miss.length > 0) v.push(`解包结果缺 ${miss.join(',')}（内容下限：脚本自己播种的源卷文件）`);
  const extra = extracted.filter((f) => !seed.includes(f));
  if (extra.length > 0) v.push(`解包结果多了 ${extra.join(',')}（凭空出现的条目同样是坏）`);
  const aMiss = archive.filter((f) => !extracted.includes(f));
  if (aMiss.length > 0) v.push(`归档清单里有而解包结果没有：${aMiss.join(',')}`);
  const aExtra = extracted.filter((f) => !archive.includes(f));
  if (aExtra.length > 0) v.push(`归档清单里没有而解包结果有：${aExtra.join(',')}`);
  return v;
}

/**
 * 归档清单（**文件**条目，去掉目录项与 `./` 前缀）。
 *
 * ⚠️ 用**容器里的 tar** 读（`docker exec -i … tar tzf -`，tgz 从 stdin 进）而不是宿主的 tar：
 *    Windows 的 MSYS tar 对 `C:\…` 形态的路径参数会先炸在反斜杠上，而容器那边是 GNU tar、
 *    与 `backup.sh` ⓑ 打包用的**同一族** ⇒ 口径也一致。
 */
function tarFileList(dockerContainer: string, tgz: string): string[] {
  const r = spawnSync('docker', ['exec', '-i', dockerContainer, 'tar', 'tzf', '-'],
    { input: readFileSync(tgz), encoding: 'utf8' });
  if (r.status !== 0) throw new ConformanceError(`读归档清单失败（${tgz}）：${tailOut(r.stderr ?? '', 3)}`);
  return r.stdout.split('\n').map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'))
    .map((l) => l.replace(/^\.\//, ''))
    .sort();
}

/**
 * 造一个「项目目录」（`--project-dir`）：**恰好** `.env` + `docker-compose.yml`。
 *
 * 用途有二：① 判据 d 的 `.env` 落点（生产里 `.env` 就在这里）；② 设计 Important 8 的断言 ——
 * 恢复之后这里必须**还是恰好这两件**（最自然的实现会就地写 `restore.log` / `.env.bak`，
 * 那会让 `deploy.sh --assert-clean` 在**一次成功发布的末尾**红）。
 * `.env` 里先写毒（与源不同）⇒「⑤ 真的写了」才有可观测的差别（否则「没写」也照样等于源）。
 */
function makeProjDir(root: string, name: string, composeBody?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), 'POISONED-ENV\n');
  writeFileSync(join(dir, 'docker-compose.yml'), composeBody ?? '# 占位：本形态下 ⑥ 走不到 compose\n');
  return dir;
}

/**
 * `docker` / `curl` 的**记录型垫片**（BASH_ENV 注入的 shell 函数）。
 *
 * 为什么必须从调用现场证明：判据 i2 要证明的是「**一次 stop/start 都没发生**」、
 * 判据 j 要证明「⑥ 用的是**带 `-f` 与 `--env-file` 的** compose，且两个 export 已就位」、
 * 「⑦ 的冒烟**真的**发了三条 curl」—— 这些在事后看容器状态**看不见**（没发生的事没有痕迹）。
 * ⚠️ 调用方必须**自证垫片装着**（断言日志里有正常调用）—— 否则日志为空时「没有 stop」是**空测**。
 * ⚠️ 垫片只活在本次测试的临时目录里；生产/CI 的脚本调用路径**一个字都不变**。
 */
function dockerShim(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'shim.sh');
  writeFileSync(p, [
    '# 测试用的记录型垫片（由 slice-07.5-backup 生成）：先记一行，再原样转发给真命令。',
    'docker() {',
    '  { printf "docker"; printf " %q" "$@";',
    '    printf " | IMAGE_PREFIX=%s IMAGE_TAG=%s\\n" "${IMAGE_PREFIX:-}" "${IMAGE_TAG:-}"; } >> "${FTL_SHIM_LOG:-/dev/null}"',
    '  command docker "$@"',
    '}',
    'curl() {',
    '  { printf "curl"; printf " %q" "$@"; printf "\\n"; } >> "${FTL_SHIM_LOG:-/dev/null}"',
    '  command curl "$@"',
    '}',
    '',
  ].join('\n'));
  return p;
}

/** 垫片日志里**首个子命令**为 `sub` 的调用行（`docker <sub> …` / `curl …`）。 */
function shimCalls(log: string, tool: 'docker' | 'curl', sub?: string): string[] {
  return log.split('\n')
    .filter((l) => l.startsWith(`${tool} `))
    .filter((l) => sub === undefined || l.split(' ')[1] === sub);
}

/** 容器的「身份指纹」：状态变过（停过/起过）这条就变 ⇒ 用来证明「一次都没碰」。 */
function containerStates(containers: string[]): string[] {
  return containers.map((c) => sh('docker', ['inspect', '--format', '{{.State.StartedAt}}|{{.State.Status}}', c]).trim());
}

/** `restore.sh` 的**演练形态**参数（空 `--app-services`）；`extra` 追加在最后 ⇒ 同名参数覆盖前面的。 */
function restoreArgs(o: { dest: string; ts: string; proj: string; extra?: string[] }): string[] {
  return [
    '--yes-i-know',
    '--app-services', '',                      // 空集 = 演练形态（②⑥⑦ 整段跳过）
    '--mysql-container', MYSQL, '--db-name', DB,
    '--edge-container', MYSQL, '--stack-container', MYSQL,
    '--backup-dir', o.dest, '--backup-ts', o.ts,
    '--project-dir', o.proj,
    ...(o.extra ?? []),
  ];
}

/** 把一套四件套**逐字复制**到另一个目录（负对照要在副本上动手，别污染正本）。 */
function cloneSet(srcDir: string, dstDir: string, ts: string): void {
  mkdirSync(dstDir, { recursive: true });
  const { products, manifest } = setNames(ts);
  for (const f of [...products, manifest]) copyFileSync(join(srcDir, f), join(dstDir, f));
}

/**
 * 篡改副本里的某件产物，**同时**把 manifest 里那条的 `sha256`/`bytes` 改成与它自洽。
 *
 * 🔴 这一步是判据 b/d 负对照的**全部要害**：不改 manifest，篡改会先撞上 ③ 的 sha256 闸
 *    ⇒ 测到的成了「sha 校验」而不是「内容比对」（设计 §6.1-b 第三轮 Important 3 点名的形态：
 *    「把比对整段删掉也照样红」）。改成自洽之后，③ 会放行 ⇒ **只有内容比对能抓住它**。
 */
function retamper(dstDir: string, ts: string, key: 'users' | 'caddy' | 'env', mutate: (b: Buffer) => Buffer): void {
  const p = join(dstDir, productFile(ts, key));
  const b = mutate(readFileSync(p));
  writeFileSync(p, b);
  const mfPath = join(dstDir, `manifest-${ts}.json`);
  const mf = JSON.parse(readFileSync(mfPath, 'utf8')) as { artifacts: Record<string, { sha256: string; bytes: number }> };
  mf.artifacts[key] = { sha256: sha256Of(p), bytes: b.length };
  writeFileSync(mfPath, `${JSON.stringify(mf)}\n`);
}

/**
 * 判据 b 负对照用的**变异体** `restore.sh`：把真脚本原样跑完，然后**只改一条昵称**。
 *
 * 「行数相同、内容不同」正是设计 §6.1-b 要求的形态：改一个字节会先让 `gunzip` 报错
 * （那是在测解压，把比对删掉也照样红）⇒ 这里让恢复**成功**、内容**不同**。
 * 演练（`restore-drill.sh`）用 `dirname "$0"` 找兄弟脚本 ⇒ 会用到本文件
 * ⇒ **被测的是交付物自己的比对逻辑**（比对若被删/写成恒真，这个演练就会「通过」）。
 */
const MUTANT_RESTORE = `#!/usr/bin/env bash
# ⚠️ 由测试在临时目录里生成（判据 b 的负对照），**不进仓库、不进交付物**。
set -euo pipefail
bash "__REAL_RESTORE__" "$@"
MYSQL_ARG=""; DB_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mysql-container) MYSQL_ARG="$2"; shift 2 ;;
    --db-name) DB_ARG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$MYSQL_ARG" ] && [ -n "$DB_ARG" ] || { echo "变异体：没解析到 --mysql-container/--db-name" >&2; exit 9; }
docker exec "$MYSQL_ARG" sh -c "mysql -uroot -p\\"\\$MYSQL_ROOT_PASSWORD\\" '$DB_ARG' -e \\"UPDATE users SET nickname='mallory' WHERE id='u1'\\""
`;


/** 四件套的文件名（与 `backup.sh` 的命名逐字一致；判据 e 与后续任务的比对都从这里取）。 */
function setNames(ts: string): { products: string[]; manifest: string } {
  return {
    products: [`users-${ts}.sql.gz`, `caddy-data-${ts}.tgz`, `env-${ts}.gz`],
    manifest: `manifest-${ts}.json`,
  };
}

/** 目录里的产物清单：去掉日志与**点文件**（`.lock` / `.restore-lock` 不是产物）。 */
function namesIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => n !== 'backup.log' && !n.startsWith('.'));
}

/** 与脚本同一口径的 UTC 小时 ts（脚本那一侧是 `date -u +%Y%m%d%H`，窗口是 `ts < CUTOFF`）。 */
function utcHourTs(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/**
 * 播一份「四件套」假备份（判据 e 用）。名字里的 `<ts>` 是我们指定的、内容无关紧要 ——
 * 清理只看文件名，**这正是被测性质**。
 * `manifestMtimeNow`：manifest 的 mtime 定成「现在」而三件产物定成 20 天前 ⇒「按 mtime 清理」
 * 的实现会留下**孤儿 manifest**（产物被删而 manifest 还在）—— 判据 e 第 3 条冲它去。
 */
function plantSet(dir: string, ts: string, opts: { manifestMtimeNow?: boolean } = {}): void {
  const old = new Date(Date.now() - 20 * 86400000);
  const { products, manifest } = setNames(ts);
  for (const f of products) {
    const p = join(dir, f);
    writeFileSync(p, 'PLANTED\n');
    utimesSync(p, old, old);
  }
  const mp = join(dir, manifest);
  writeFileSync(mp, '{"planted":true}\n');
  const m = opts.manifestMtimeNow ? new Date() : old;
  utimesSync(mp, m, m);
}

/** 同步轮询一个文件出现（holder/releaser 都是**独立 OS 进程**，同步等它们没问题）。 */
function waitForFile(p: string, timeoutMs: number, what: string): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new ConformanceError(`等待超时（${what}）：${p} 未出现`);
    execFileSync('sleep', ['1']);
  }
}

/** `flock -n` 探活：拿得到 ⇒ 已释放（比 kill 持有者可靠，见 `spawnLockHolder` 的注释）。 */
function waitForLockFree(lock: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnSync('bash', ['-c', 'exec 9>"$1"; flock -n 9', '_', lock]).status === 0) return true;
    execFileSync('sleep', ['1']);
  }
  return false;
}

/** 本次运行 spawn 出来的「持锁者」的放行标记 —— 收尾时要把它们全放掉（见 `spawnLockHolder`）。 */
const LOCK_RELEASES: string[] = [];

/**
 * 持锁进程：拿到 `<lock>` 后写 `<ready>`，直到 `<release>` 出现才退出（退出 = 自动放锁）。
 *
 * ⚠️ 用「标记文件」而不是固定 `sleep N`：固定时长有**窗口竞态** —— 本机慢一点、持有者先退出，
 *    被测的那一次反而拿到锁 ⇒ 锁判据假红。标记文件把窗口拉成无限宽。
 * ⚠️ 另加 60s 自限（`i<300`）：无论测试怎么挂，持有者不会变成永久残留。
 * ⚠️ **收尾不 kill 它**：MSYS 的 `sleep` 子进程会继承 fd 9 ⇒ kill 掉持有者，锁还攥在子进程手里。
 */
function spawnLockHolder(lock: string, ready: string, release: string): ChildProcess {
  LOCK_RELEASES.push(release);
  const p = spawn('bash', ['-c',
    'exec 9>"$1"; flock 9; : > "$2"; i=0; while [ ! -e "$3" ] && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
    '_', lock, ready, release], { stdio: 'ignore' });
  // bash 起不来时它永远不写 ready、由 waitForFile 超时报错 —— 这里只吞掉 unhandled 'error'。
  p.on('error', () => { /* 见上 */ });
  p.unref();
  return p;
}

/** `<secs>` 秒后写 `<release>`（L2 用：被测进程同步阻塞时，只有独立进程能按时放行）。 */
function spawnDelayedTouch(p: string, secs: number): void {
  const c = spawn('bash', ['-c', `sleep ${secs}; : > "$1"`, '_', p], { stdio: 'ignore' });
  c.on('error', () => { /* 同 spawnLockHolder：交给超时/断言报错 */ });
  c.unref();
}

/** 收尾：放掉所有持锁者（写标记 → 它们 0.2s 内自己退出），给它们一点时间再拆临时目录。 */
function releaseLockHolders(): void {
  for (const p of LOCK_RELEASES) {
    try { writeFileSync(p, ''); } catch { /* 目录可能已不存在；持有者另有 60s 自限 */ }
  }
  if (LOCK_RELEASES.length > 0) {
    LOCK_RELEASES.length = 0;
    shTry('sleep', ['1']);
  }
}

/**
 * 宿主有没有 `flock` —— 与 `backup.sh` 的预检是**同一判据**（`command -v flock`）。
 *
 * 两处必须一致：脚本据此决定「上真锁」还是「响亮告警后继续（不上锁）」，本切片据此决定
 * 「跑锁判据」还是「逐条**显式跳过**」。判据不同步的两种后果都会当场响：脚本无 flock 而切片
 * 以为有 ⇒ 锁判据红在等待上；脚本有 flock 而切片以为没有 ⇒ 锁判据被冤枉跳过（收尾汇总里
 * 的「跳过 N 项」会点名原因，不会伪装成通过）。
 */
function hostHasFlock(): boolean {
  return spawnSync('bash', ['-c', 'command -v flock >/dev/null 2>&1']).status === 0;
}

/** 锁判据被跳过的**唯一**原因（逐条打印，也进收尾汇总的「跳过 N 项（…）」）。 */
const NO_FLOCK_REASON =
  '宿主没有 flock（util-linux；Windows 的 Git Bash 不带）⇒ 锁判据在本环境无法构造'
  + '（持锁进程都起不来）。CI/Linux 上 flock 恒在、这 11 条会真跑 —— 本机这是**跳过**，不是「通过」。';

/**
 * flock 不在时被跳过的锁断言清单 —— **与 else 分支里的 11 条一一对应**。
 *
 * ⚠️ 为什么要有这份清单：跳过必须**逐条可见**（判据存在 ≠ 判据有效；一条不可能失败的断言
 *    比没有断言更坏，它制造的是虚假的信心）。清单是「本机跳过了哪几条」的唯一真源。
 * ⚠️ 锁段增删断言时必须同步这里：else 分支的收尾有一条**机械守卫**（锁段的
 *    `checks.passed.length` 增量必须等于本清单长度）—— 漂移会让 CI 当场红，而不是让
 *    本机默默少报几条。
 */
const LOCK_SKIPPED: readonly string[] = [
  '锁：cron 拿不到锁 ⇒ **算这一次失败**（不是「跳过」）',
  '锁：失败必须点名锁（否则本判据会在别的失败上也绿）',
  '锁：拿不到锁 ⇒ 一件产物也不许落盘',
  '锁：持有者退出后锁必须自动释放（flock 随进程/描述符退出而放）',
  '锁：锁空出来之后必须能跑通',
  '锁：跑通的那一次必须真落了产物（否则上一条可能是空转）',
  '锁：cron 用的锁文件必须叫 $DEST/.lock（Task 3 的接口）',
  '锁：.restore-lock 被占时，restore- 前缀必须**等**（救人用的锁不许被一次 cron 拒掉）',
  '锁：上面那一次必须真的等过（≥4000ms；放行在 6s）',
  '锁：restore- 前缀用的锁文件必须叫 $DEST/.restore-lock（与 cron 的 .lock **不是同一个**）',
  '锁：--artifact-prefix 必须体现在产物名上（现场备份与小时那串分得开）',
];

/** pty 闸被跳过的**唯一**原因（与 `NO_FLOCK_REASON` 同一条纪律：说清缺什么、哪里会真跑）。 */
const NO_PTY_REASON =
  '宿主没有 script(1)（util-linux；Windows 的 Git Bash 不带）⇒ 伪造不出 TTY。'
  + 'CI/Linux 上它恒在、这 3 条会真跑 —— 本机这是**跳过**，不是「通过」。';

/**
 * 「空清单闸（交互式）」那一段的**三条**断言 —— **与 else 分支一一对应**。
 *
 * ⚠️ 复核 Minor 2：`lib/assert.ts` 的 `skip()` 契约是「**一条跳过顶一条断言**」。这 3 条
 *    曾挤在一个 `checks.skip` 里 ⇒ 本机少报 2 条、而 CI 上跑过的又比「本机通过 + 跳过」
 *    多 2 条 ⇒ 后来的 `baselines.json` 地板会按错口径算。清单是「本机跳过了哪几条」的唯一真源，
 *    else 分支的收尾有一条**机械守卫**（段内 `checks.passed.length` 增量必须等于本清单长度）。
 */
const EMPTY_PTY_SKIPPED: readonly string[] = [
  '空清单闸：交互式 + 空 --app-services（生产调用必须给非空清单）⇒ 必须拒绝',
  '空清单闸：拒绝文案必须点名唯一的豁免开关',
  '空清单闸：拒绝必须发生在任何动作之前',
];

// ─────────────────────────────────────────────────────────────────────────────
// Task 4（`install-cron.sh`）用的工具。**不需要 docker**：纯文件系统 + 一个 `crontab` 替身。
// ─────────────────────────────────────────────────────────────────────────────

/** 定时行里的标记 —— 「幂等」就定义在它上面（**恰好一行**带它）。 */
const CRON_MARKER = '# ftl-backup';

/**
 * 期望的定时行（**期望值只能来自测试这一侧**，不许从 `install-cron.sh` 里读出来 —— 那是
 * 「一起对、一起错」）。口径两处都有出处：绝对路径（设计 §5：用户 crontab 的 PATH 只有
 * `/usr/bin:/bin`）、`/bin/bash` 显式解释器 + 每小时（计划 Task 4 逐字）。
 */
const CRON_LINE = '17 * * * * /bin/bash /home/ubuntu/ftl-ops/backup.sh >> /dev/null 2>&1 # ftl-backup';

/**
 * `crontab` 的替身（**由判据生成在临时目录里，不进仓库、不进交付物**）。
 *
 * 契约三件事（缺一条，判据 k 就成了空测）：
 * ① 空态 `-l` **像真 crontab 那样失败**：stderr 打 `no crontab for <user>`、exit 1 ——
 *    不许以 `exit 0` + 空输出蒙混：那样被测脚本里「只容忍 no crontab」那条分支根本不会被执行，
 *    「容忍」与「不容忍」就分不开了；
 * ② `$FTL_CRON_STATE/fail_other` 在 ⇒ `-l` 报**另一种**失败（stderr **不含** `no crontab`）、exit 1；
 * ③ 写回（`-` 读 stdin）在**两种失败态下都照常落盘** —— 这是**故意**的：若失败态下写不进去，
 *    「失败 ⇒ crontab 一字未动」就成了恒真谓词（什么都改不动，当然没变），而它要抓的正是
 *    「先覆盖、后失败」那种脚本。
 */
function stubCrontab(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'crontab-stub.sh');
  writeFileSync(p, [
    '#!/usr/bin/env bash',
    '# `crontab` 的替身（由 slice-07.5-backup 生成；契约见该切片的 stubCrontab 注释）。',
    'set -euo pipefail',
    'S="${FTL_CRON_STATE:?替身缺 FTL_CRON_STATE}"',
    'F="$S/crontab.txt"',
    'case "${1:-}" in',
    '  -l)',
    '    if [ -e "$S/fail_other" ]; then',
    '      echo "crontab: cannot open /var/spool/cron/crontabs/ubuntu: Permission denied" >&2',
    '      exit 1',
    '    fi',
    '    if [ -f "$F" ]; then cat "$F"; else echo "no crontab for ubuntu" >&2; exit 1; fi ;;',
    '  -) cat > "$F" ;;',
    '  *) echo "用法：crontab [-l|-]" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  // MSYS（Windows Git Bash）对带 shebang 的文件本来就能直接执行（本机实测），chmod 是给
  // 权限语义更严的宿主（CI 的 Linux）兜底 —— 被测脚本是**直接** `"$CRONTAB_CMD" -l` 调它的。
  chmodSync(p, 0o755);
  return posixPath(p);
}

/** 一个「有 crontab 的机器」的假世界：一个 state 目录 + 指向替身的环境。 */
interface CronWorld {
  /** 被测脚本的环境（也留给负对照用）。 */
  readonly env: Record<string, string>;
  /** 跑一次被测的 `install-cron.sh`（与其余各判据同一形态：`bash <脚本>`）。 */
  run(): { status: number | null; out: string };
  /** **直接**跑替身的 `-l`（不经被测脚本）—— 自证「这一种失败长什么样」。 */
  stubList(): { status: number | null; out: string };
  /** crontab 现状（**字节原文**）—— 「一字未动」那条断言比的就是它。 */
  text(): string;
  /** 非空行清单。 */
  lines(): string[];
  /** 带 `# ftl-backup` 标记的行。 */
  marker(): string[];
  /** 不带标记的行（=「别人的行」）。 */
  others(): string[];
  /** 预置 crontab 内容（模拟这台机器上**已有的**东西）。 */
  seed(lines: string[]): void;
  /** 打开「另一种失败」开关（模拟一次真的 `crontab -l` 故障）。 */
  failOther(): void;
}

function cronWorld(root: string, name: string, stub: string): CronWorld {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'crontab.txt');
  // ⚠️ 监控片（T11）：install-cron.sh 现在会建 textfile 目录（注入点 `TEXTFILE_DIR` —— 与 backup.sh
  //    同名同先例）⇒ 注入到本世界的 scratch 子目录：CI 上**真跑**那两行 mkdir/chmod（若环境不可写，
  //    `set -e` 会当场打死脚本 ⇒ 本判据组红 —— 即那一行被这组判据**真实覆盖**），且永不碰
  //    /home/ubuntu。只加一个 env 键：断言集与 baselines 计数均不受影响。
  const env = { CRONTAB_CMD: stub, FTL_CRON_STATE: posixPath(dir), TEXTFILE_DIR: posixPath(join(dir, 'textfile')) };
  const text = (): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const lines = (): string[] => text().split('\n').filter((l) => l !== '');
  return {
    env,
    run: () => runScript(INSTALL_CRON, [], env),
    stubList: () => runScript(stub, ['-l'], env),
    text,
    lines,
    marker: () => lines().filter((l) => l.includes(CRON_MARKER)),
    others: () => lines().filter((l) => !l.includes(CRON_MARKER)),
    seed: (ls) => writeFileSync(file, ls.length === 0 ? '' : `${ls.join('\n')}\n`),
    failOther: () => writeFileSync(join(dir, 'fail_other'), ''),
  };
}

/** 行的**多重集**相等（顺序不算错 —— 「那行必须还在」不要求位置；少行/多行/改写要抓）。 */
function sameLineMultiset(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 5（`check-backup-fresh.sh` / 判据 h）用的工具。**不需要额外容器**：复用 scratch 栈跑两次
// 真备份，其余靠一个 `ssh` 替身与合成/复制的目录（照判据 k 的 `crontab` 替身先例）。
// ─────────────────────────────────────────────────────────────────────────────

/** 被测的「备份新鲜度」闸（**runner 侧** —— 设计 §5：它不落服务器，由 release.yml 在 deploy 之后 ssh 出去跑）。 */
const CHECK_BACKUP_FRESH = join(REPO_ROOT, 'scripts', 'ops', 'check-backup-fresh.sh');

/**
 * 判据 h 的**七条红文案**（每条红打且只打其中一句）—— 它们是**判据的一部分**：
 * 「从未成功过」/「最近几次全失败」/「太旧（备份停了）」/「产物不全」/「最近一次失败」/
 * 「ssh 够不到」/「判不出年龄」在凌晨三点是**七个完全不同的动作**。两处一起改。
 */
const H_RED_SSH = 'ssh 探测失败';
const H_RED_NEVER = '备份从未成功过';
const H_RED_NOOK = '最近几次全失败';
const H_RED_ARTIFACTS = '产物不全';
const H_RED_STALE = '备份停了';
const H_RED_LASTFAIL = '最近一次备份失败了';
const H_RED_AGE = '判不出年龄';
const H_ALL_REDS: readonly string[] = [
  H_RED_SSH, H_RED_NEVER, H_RED_NOOK, H_RED_ARTIFACTS, H_RED_STALE, H_RED_LASTFAIL, H_RED_AGE,
];

/**
 * 一条红的**可分辨性**：它必须打**自己**那句话，且**不许**同时打别条红的话。
 *
 * 为什么这是判据而不是形式主义：本片的正中央是「凌晨三点有人照着跑」。两条红混成一条
 * （或都退化成「备份有问题」）时，读者分不出「备份**从未**成功过」（要重装/重跑）与
 * 「备份**停了**」（去看 backup.log）—— 那是两条不同的路。
 */
function redIsDistinct(out: string, mine: string, others: readonly string[]): boolean {
  return out.includes(mine) && !others.some((o) => out.includes(o));
}

/** 除 `mine` 之外的所有红文案（「不许同时出现」的清单）。 */
function otherReds(mine: string): readonly string[] {
  return H_ALL_REDS.filter((r) => r !== mine);
}

/**
 * `ssh` 的替身（**由判据生成在临时目录里，不进仓库、不进交付物**）。
 *
 * 契约三条（缺一条，判据 h 就成了空测）：
 * ① **本地执行**远端命令串（argv 最后一个参数）并把它的退出码原样带出 —— 与真 ssh 同一条语义
 *    （`ssh host cmd` 的退出码 = 远端 cmd 的退出码）。被测脚本因此走**生产同一条代码路径**：
 *    同样的命令串、同样的引号与转义、同样的失败传播；被换掉的只有「谁来执行」。
 * ② **永不碰真服务器**：不解析 `-i`/`-o`/目标，只把整条 argv **逐参数一行**记进 `$FTL_SSH_LOG`
 *    —— 判据据此断言「它确实是按 ssh 的形态被调用的」（否则注入点没被走，绿是假的）。
 * ③ 两种故障注入：`FTL_SSH_MODE=off` ⇒ 一律 exit 255（够不到服务器）；`badage` ⇒ 含 `date` 的
 *    那一趟回一行非数字（远端算不出年龄）。缺省 = 正常执行。
 */
function sshStub(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'ssh-stub.sh');
  writeFileSync(p, [
    '#!/usr/bin/env bash',
    '# `ssh` 的替身（由 slice-07.5-backup 生成；契约见该切片的 sshStub 注释）。',
    'set -euo pipefail',
    '{ printf "ssh\\n"; printf "%s\\n" "$@"; } >> "${FTL_SSH_LOG:-/dev/null}"',
    'case "${FTL_SSH_MODE:-}" in',
    '  off) exit 255 ;;',
    '  badage) case "${!#}" in *date*) printf "NOT-A-NUMBER\\n"; exit 0 ;; esac ;;',
    'esac',
    'exec bash -c "${!#}"',
    '',
  ].join('\n'));
  // MSYS（Windows Git Bash）对带 shebang 的文件本来就能直接执行（判据 k 的替身同款，本机实测），
  // chmod 是给权限语义更严的宿主（CI 的 Linux）兜底 —— 被测脚本是**直接** `"$SSH_CMD" …` 调它的。
  chmodSync(p, 0o755);
  return posixPath(p);
}

/**
 * 播一份「四件套」并**如实**写一份紧凑 manifest（`"ok":true` / `"ok":false`）—— 判据 h 的合成样本。
 *
 * ⚠️ 为什么 h 允许合成：它判的是**时间**（太旧）与**缺席**（没有 manifest / 缺一件产物），
 *    这两类只能靠构造。**绿**那条路径与**「最后一次失败」**那条都用**真 `backup.sh`** 的产物
 *    （见判据 h 的 ②/⑥）—— 合成只用来摆出「缺席」与「时间」。
 */
function plantHourSet(dir: string, ts: string, ok: boolean): void {
  const { products, manifest } = setNames(ts);
  for (const f of products) writeFileSync(join(dir, f), 'PLANTED\n');
  writeFileSync(join(dir, manifest),
    `{"ts":"${ts}","ok":${ok},"failed_at":${ok ? 'null' : '"mysqldump"'},"artifacts":{},` +
    `"caddy_entries":0,"image_tag":"probe","image_tag_usable":false}\n`);
}

/** 把一份**真备份**的四件套复制到另一个目录、改名成另一个 `<ts>`（内容一字不动）—— 「做旧」。 */
function copySetAs(srcDir: string, srcTs: string, dstDir: string, dstTs: string): void {
  mkdirSync(dstDir, { recursive: true });
  const a = setNames(srcTs);
  const b = setNames(dstTs);
  copyFileSync(join(srcDir, a.manifest), join(dstDir, b.manifest));
  for (let i = 0; i < a.products.length; i++) {
    copyFileSync(join(srcDir, a.products[i]), join(dstDir, b.products[i]));
  }
}

/** 与脚本同一口径的 UTC 小时 ts，**按小时**回推（既有的 `utcHourTs` 只到「天」）。 */
function utcHourTsAgo(hours: number): string {
  return utcHourTs(hours / 24);
}

/** `backup.log` 里一行「锁竞争」的失败（判据 h 的豁免条款与 backup.sh 的措辞同源，见文本钉子）。 */
function lockFailureLine(): string {
  return '2026-09-26T03:20:11Z FAILED: 拿不到锁 /home/ubuntu/ftl-backups/.lock\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 6（`PREFIX_FILES` / 投递 / `release.yml` 两步）用的工具：判据 **i1 / l**。
//   两条都**不碰 docker、不碰服务器**：纯文件（手册 + 脚本）与 git 自己的索引。
//   被判的是**交付物之间的一致性** —— 手册是交付物的一部分（设计 §7）。
// ─────────────────────────────────────────────────────────────────────────────

/** 手册（`docs/ops/first-deploy.md`）。 */
const MANUAL = join(REPO_ROOT, 'docs', 'ops', 'first-deploy.md');

/**
 * 手册里**一节**的正文：从 `heading` 那一行起，到**下一个顶层标题**（`## ` 开头）之前。
 *
 * ⚠️ 判据 i1 **必须**按节抽取（设计 §6.1-i1 第三轮 Important 1 的反面）：整份手册的 `--flag`
 *    集合里混着 `docker compose` 的 `--profile` / `--force` / `--no-deps` / `--format` /
 *    `--filter` / `--entrypoint` 等 —— 那些**不是** `restore.sh` 的旗标（实测：整份文件抽出
 *    18 个，其中 12 个在 `--help` 里找不到）⇒ 从整份文件抽取**当场红**，而最诱人的
 *    「修法」是把判据删掉。只抽「数据没了怎么办」那一节 —— 读者照抄命令的那一节，
 *    也正是旗标必须齐全的地方。
 */
export function manualSection(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** 一节正文里出现过的全部 `--flag`（去重 + 排序）。 */
export function manualFlags(section: string): string[] {
  return [...new Set(section.match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
}

/**
 * 谓词：`flag` 是否**以词**出现在 usage 文本里（词边界：前后都不许是 `[A-Za-z0-9-]`）。
 *
 * ⚠️ 词边界是判据的一部分 —— 本片的核心负对照正是 `--backup-ts` → `--ts`：裸 `includes`
 *    对这一个虽也判得对（`--backup-ts` 里没有 `--ts` 这个子串），但对更近的错拼（`--tag`
 *    之于 `--image-tag`、`--ts` 之类）会把子串当命中 ⇒ 一个字母之差的手册错拼被判绿，
 *    而凌晨三点照抄的人就卡在那一步。
 */
export function flagInUsage(flag: string, usage: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`).test(usage);
}

/** 这一节里**找不到**的旗标（空数组 = 全部都能在 usage 里找到）。正断言与负对照共用它。 */
export function flagsMissingFromUsage(flags: readonly string[], usage: string): string[] {
  return flags.filter((f) => !flagInUsage(f, usage));
}

/**
 * `git check-ignore -v <相对路径>`：命中忽略规则 ⇒ 返回那条规则（含 `.gitignore:行号`），
 * 否则 `null`。⚠️ 问的是 **git 自己**（同一个匹配器），因此这条判的是「规则在不在、灵不灵」，
 * 而不是「今天恰好没有这种文件」——两者必须一起成立（设计 §6.1-l 的配套动作）。
 */
function ignoreRuleFor(rel: string): string | null {
  const r = spawnSync('git', ['check-ignore', '-v', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/** 备份产物的两种扩展名（判据 l；与 `backup.sh` 的命名逐字一致：`users-<ts>.sql.gz` / `caddy-data-<ts>.tgz`）。 */
const ARTIFACT_SUFFIXES: readonly RegExp[] = [/\.sql\.gz$/, /\.tgz$/];

export async function runSlice075Backup(): Promise<{ passed: string[]; skipped: SkippedAssertion[] }> {
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

    // ⚠️ 用 runBackupRaw（非抛出）而不是 `sh('bash', …)`：备份**失败**时 execFileSync 抛的是
    //    `Command failed: …`，而 run.ts 只打印 `err.message`（**不含 stderr**）⇒「为什么失败」
    //    （`backup.log` 里那一行）在结论里看不见 —— 本仓明写过「跑挂 ≠ 判据红」。
    //    ✅ 成功路径与原来逐字相同：同一组 argv（见 `backupArgs`）、下面每一条断言都没动。
    const a0 = runBackupRaw(s, s.dest);
    checks.eq(a0.status, 0, `判据 a：备份必须成功退出 —— 日志尾部：${tail(a0.log)}`);

    const names = readdirSync(s.dest);
    const mfName = names.find((n) => n.startsWith('manifest-'));
    checks.that(mfName !== undefined, '判据 a：必须有 manifest-<ts>.json');
    const m = JSON.parse(readFileSync(join(s.dest, mfName!), 'utf8'));
    // 字段集**恰好**七字段（复核 Important ii）：只断言 ok/ts/三条 sha256 时，一份**静默丢掉**
    // failed_at / caddy_entries / image_tag / image_tag_usable 的 manifest 照样全绿。
    // `fieldSetViolations` 同时抓「少报」与「多报」（多报正是 R267 点名的假信息形态）。
    const fieldViolations = fieldSetViolations(Object.keys(m), MANIFEST_FIELDS);
    checks.that(fieldViolations.length === 0,
      `判据 a：manifest 字段集**恰好**是 ${JSON.stringify(MANIFEST_FIELDS)} —— ` +
      `实际 ${JSON.stringify(Object.keys(m))}（${fieldViolations.join(' | ')}）`);
    checks.eq(m.ok, true, '判据 a：manifest 的 ok 必须为 true');
    checks.that(typeof m.ts === 'string' && m.ts.length > 0, '判据 a：manifest 必须记 ts');

    for (const [key, prefix] of [['users', 'users-'], ['caddy', 'caddy-data-'], ['env', 'env-']] as const) {
      const file = names.find((n) => n.startsWith(prefix));
      checks.that(file !== undefined, `判据 a：必须有 ${prefix}* 产物`);
      const actual = sha256Of(join(s.dest, file!));
      // ⚠️ 可选链不是装饰（复核 Minor 4）：manifest 若带着 `ok:true` 却把 artifacts 留空/少项，
      //    裸取 `m.artifacts[key].sha256` 会抛 **TypeError** —— 跑挂 ≠ 判据红，且报错读不出是哪条判据。
      const recorded = m.artifacts?.[key]?.sha256;
      checks.that(typeof recorded === 'string',
        `判据 a：manifest 必须记 artifacts.${key}.sha256 —— 实际 ${JSON.stringify(m.artifacts?.[key])}`);
      // 嵌套字段集同样**恰好** {sha256, bytes}（复核 Important ii 点名的 `artifacts.*.bytes`）：
      // 顶层 key-set 检查看不见**嵌套**丢字段。
      const innerViolations = fieldSetViolations(Object.keys(m.artifacts?.[key] ?? {}), ARTIFACT_FIELDS);
      checks.that(innerViolations.length === 0,
        `判据 a：artifacts.${key} 的字段集**恰好**是 ${JSON.stringify(ARTIFACT_FIELDS)} —— ` +
        `实际 ${JSON.stringify(Object.keys(m.artifacts?.[key] ?? {}))}（${innerViolations.join(' | ')}）`);
      checks.eq(actual, recorded, `判据 a：${key} 的 sha256 必须与实物一致`);
    }

    // ── 判据 a 的**负对照**（设计 §6.1：「改一个字节 ⇒ 必须报错」）───────────────────
    // 用**合成输入**自证上面那条 `checks.eq(actual, recorded)` 不是恒真谓词：把 users 产物复制
    // 一份、改 1 字节，重算的 sha256 必须与 manifest 记录**不同**（⇒ 实物与记录一旦脱钩，该比对
    // 真的会红）。⚠️ 副本写 scratch 根目录（随 down() 一起删）—— 写进 `dest` 会污染产物目录
    // （判据 c/e 要数那里的文件，且 `names` 扫描会多看见一个）。
    const tampered = join(s.root, 'tampered-users.sql.gz');
    const buf = readFileSync(join(s.dest, names.find((n) => n.startsWith('users-'))!)); // 上面已断言存在
    const mid = Math.floor(buf.length / 2);
    buf[mid] = buf[mid] ^ 0xff;
    writeFileSync(tampered, buf);
    const tamperedSha = sha256Of(tampered);
    checks.that(tamperedSha !== m.artifacts?.users?.sha256,
      `判据 a 负对照：改 1 字节后重算的 sha256 必须与 manifest 记录不同（否则「sha256 与实物一致」` +
      `是恒真谓词）—— 实测 ${JSON.stringify(tamperedSha)} vs 记录值 ${JSON.stringify(m.artifacts?.users?.sha256)}`);

    // ── 判据 e：保留按 <ts>，且不会「产物被删而 manifest 还在」 ──────────────
    step('判据 e：保留策略（按文件名里的 <ts>，不按 mtime）');
    // ⚠️ 独立 dest：往判据 a 的目录里播旧文件会**污染它的扫描**（它用 `names.find` 找产物），
    //    而且保留测试会删东西 ⇒ e/f/g/锁 各用各的目录。
    const retDest = join(s.root, 'ret-dest');
    mkdirSync(retDest, { recursive: true });
    // 窗口口径：脚本删的是 `ts < CUTOFF`（CUTOFF = 现在 − 14 天，按小时截断）⇒ 取 15 天与 13 天
    // 两套，**不踩**「正好 14 天」那一小时的边界（那一刻 ts == CUTOFF、算「还在」，是 `<` 的语义）。
    const tsOld = utcHourTs(15);
    const tsKeep = utcHourTs(13);
    plantSet(retDest, tsOld, { manifestMtimeNow: true });
    plantSet(retDest, tsKeep);
    const eRun = runBackupRaw(s, retDest);
    checks.eq(eRun.status, 0,
      `判据 e：保留测试里那次真备份必须成功（否则目录里的文件数什么也说明不了）—— 日志尾部：${tail(eRun.log)}`);
    const retNames = namesIn(retDest);
    const eOldLeft = retNames.filter((n) => n.includes(tsOld));
    checks.that(eOldLeft.length === 0,
      `判据 e：15 天前的四件套必须被删净（${tsOld}）—— 实际还在 ${JSON.stringify(eOldLeft)}`);
    const eKeepLeft = retNames.filter((n) => n.includes(tsKeep));
    checks.eq(eKeepLeft.length, 4,
      `判据 e：13 天前的四件套必须还在（${tsKeep}）—— 实际 ${JSON.stringify(eKeepLeft)}`);
    // 孤儿不变式：目录里**任何** manifest 的三件产物都必须在（按名字里的 <ts> 配对）。
    // 这条专抓「按 mtime 清理」：plantSet 把 manifest 的 mtime 定成现在、三件产物定成 20 天前 ⇒
    // mtime 实现会删产物、留 manifest（= 设计 §4.1 点名要避免的形态）。
    const retMfTs = retNames.filter((n) => n.startsWith('manifest-') && n.endsWith('.json'))
      .map((n) => n.slice('manifest-'.length, n.length - '.json'.length));
    const eOrphans = retMfTs.filter((ts) => setNames(ts).products.some((p) => !retNames.includes(p)));
    checks.that(eOrphans.length === 0,
      `判据 e：不得出现「产物被删而 manifest 还在」—— 孤儿 manifest 的 ts = ${JSON.stringify(eOrphans)}`);
    const eFreshTs = retMfTs.filter((ts) => ts !== tsOld && ts !== tsKeep);
    checks.eq(eFreshTs.length, 1,
      `判据 e：这次运行自己那套必须原封不动（保留不许删掉刚做的那份备份）—— manifest ts = ${JSON.stringify(retMfTs)}`);

    // 判据 e 的负对照（设计 §6.1-e：「保留期设 0 ⇒ 必须全删」）：证明上面「13 天还在」不是 prune
    // 空转出来的恒真谓词 —— 同一段清理代码，窗口一收紧就真的删。
    const ret0Dest = join(s.root, 'ret0-dest');
    mkdirSync(ret0Dest, { recursive: true });
    const tsCtl = utcHourTs(2);
    plantSet(ret0Dest, tsCtl);
    const eCtl = runBackupRaw(s, ret0Dest, ['--retention-days', '0']);
    checks.eq(eCtl.status, 0, `判据 e 负对照：那次备份必须成功 —— 日志尾部：${tail(eCtl.log)}`);
    const ret0Names = namesIn(ret0Dest);
    const eCtlLeft = ret0Names.filter((n) => n.includes(tsCtl));
    checks.that(eCtlLeft.length === 0,
      `判据 e 负对照（保留 0）：${tsCtl} 那一套必须被全删 —— 实际还在 ${JSON.stringify(eCtlLeft)}`);
    checks.eq(ret0Names.filter((n) => n.startsWith('manifest-')).length, 1,
      `判据 e 负对照：保留 0 时**刚做的那套**必须还在（自删 = 灾难；顺带钉住 \`<\` 与 \`<=\` 的边界）—— ` +
      `实际 ${JSON.stringify(ret0Names)}`);

    // ── 判据 f：注入失败（不存在的库名）⇒ 不留半个文件 + manifest ok:false + failed_at 点名 ──
    step('判据 f：失败原子性（注入：一个不存在的库名 —— 最廉价的注入）');
    const failDest = join(s.root, 'fail-dest');
    mkdirSync(failDest, { recursive: true });
    const absentDb = `ftl_absent_${process.pid}`;
    const fRun = runBackupRaw(s, failDest, ['--db-name', absentDb]);
    checks.that(typeof fRun.status === 'number' && fRun.status !== 0,
      `判据 f：库名不存在（${absentDb}）必须让这一次非零退出 —— 实际 status=${JSON.stringify(fRun.status)}；` +
      `日志尾部：${tail(fRun.log)}`);
    const failNames = namesIn(failDest);
    // 「失败的 dest 里只允许有 manifest」一条抓四件事：半件产物（`users-*.sql.gz`）、
    // 不走 `.tmp` 直接写目标（截断的 gz）、`rm -f "$DUMP.tmp"` 掉了（留 `*.tmp`）、
    // 以及失败后 caddy/env 那两步还继续跑。
    const fLeft = failNames.filter((n) => !n.startsWith('manifest-'));
    checks.that(fLeft.length === 0,
      `判据 f：失败不得留下半个文件（尤其 users-*.sql.gz 与 *.tmp）—— 实际 ${JSON.stringify(fLeft)}`);
    const fMf = failNames.find((n) => n.startsWith('manifest-'));
    checks.that(fMf !== undefined,
      `判据 f：失败也**必须**写 manifest（判据 h 就是靠最近的 manifest 看「备份还活着吗」）—— ` +
      `实际目录 ${JSON.stringify(failNames)}`);
    const fm = JSON.parse(readFileSync(join(failDest, fMf!), 'utf8')) as
      { ok: unknown; failed_at: unknown; artifacts: unknown };
    checks.eq(fm.ok, false, '判据 f：失败那次的 manifest 必须是 ok:false（失败记成成功 ⇒ 判据 h 瞎掉）');
    checks.eq(fm.failed_at, 'mysqldump',
      '判据 f：failed_at 必须**点名**卡在哪一步（库名不存在 ⇒ 挂在 mysqldump）');
    checks.that(fieldSetViolations(Object.keys((fm.artifacts ?? {}) as Record<string, unknown>), []).length === 0,
      `判据 f：失败的 manifest 不得声称有产物 —— 实际 artifacts=${JSON.stringify(fm.artifacts)}`);

    // ── 判据 g：空间预检阈值 > 可用 ⇒ 不跑且失败 ───────────────────────────
    step('判据 g：空间预检');
    const spaceDest = join(s.root, 'space-dest');
    mkdirSync(spaceDest, { recursive: true });
    const gRun = runBackupRaw(s, spaceDest, ['--min-free-mb', '999999999']);
    checks.that(typeof gRun.status === 'number' && gRun.status !== 0,
      `判据 g：阈值（999999999MB）大于可用空间 ⇒ 必须非零退出（不跑）—— 实际 status=${JSON.stringify(gRun.status)}`);
    // 「失败来自预检」而不是「别处碰巧失败」：点名 `backup.log` 里那一行（脚本的文案含「可用空间」）。
    checks.that(gRun.log.includes('可用空间'),
      `判据 g：失败必须来自空间预检（backup.log 里写「可用空间 …」）—— 实际日志尾部：${tail(gRun.log)}`);
    const gNames = namesIn(spaceDest);
    checks.that(gNames.filter((n) => !n.startsWith('manifest-')).length === 0,
      `判据 g：预检失败 ⇒ **一件产物都不许落盘**（连 mysqldump 都不许开始）—— 实际 ${JSON.stringify(gNames)}`);
    const gOkTrue = gNames.filter((n) => n.startsWith('manifest-'))
      .filter((n) => (JSON.parse(readFileSync(join(spaceDest, n), 'utf8')) as { ok?: unknown }).ok === true);
    checks.that(gOkTrue.length === 0,
      `判据 g：预检失败不许留下 ok:true 的 manifest（失败记成成功 = 判据 h 会瞎）—— 实际 ${JSON.stringify(gOkTrue)}`);

    // ── 降级路径（flock 不在 ⇒ 告警 + 继续）：CI 上不可达 ⇒ 用源文本钉住它存在 ────────
    step('降级路径（缺 flock ⇒ 告警 + 继续）：CI 上这一支不可达 ⇒ 用源文本钉住它存在');
    // 为什么这里是**文本级**断言：Linux（CI）恒有 flock ⇒ 降级那一支在 CI 上永远不可达，
    // 它的 2 条行为断言只在缺 flock 的机器（本机）上跑。若不在此处钉住源文本，「把降级删掉 /
    // 改回 exit 1 / 把告警改成看不出后果」的改动在 CI 上**一条断言都不会红**。
    // 抓的失败：① 降级被删（回到「缺工具 ⇒ 整个脚本不跑」= 用户 2026-09-26 裁决的正面否决）
    // ② `command -v flock` 预检没了（「工具缺失」又会被误报成「拿不到锁」的那句假话）
    // ③ 告警丢了后果（「未上锁」「不受并发保护」缺一 ⇒ 无锁跑看起来像有锁跑）。
    const backupSrc = readFileSync(BACKUP_SH, 'utf8');
    checks.that(
      backupSrc.includes('command -v flock') && backupSrc.includes('未上锁') && backupSrc.includes('不受并发保护'),
      '降级路径：backup.sh 源文本必须含 `command -v flock` 预检 + 后果明确的告警（「未上锁」「不受并发保护」）' +
      '—— 缺任何一个 ⇒ 缺工具的机器上会静默不上锁、或整个脚本干脆不跑');

    // ── 锁（设计 §3.1 性质 3：**两个不同的锁**）──────────────────────────────
    step('锁：cron 的 .lock 拿不到 = 这次失败；restore- 前缀的 .restore-lock = 等待');
    const lockDest = join(s.root, 'lock-dest');
    mkdirSync(lockDest, { recursive: true });
    if (!hostHasFlock()) {
      // 宿主没有 flock ⇒ 上面那些锁判据**无法构造**（持锁进程都起不来）。两条纪律：
      //   ① 降级路径自己也必须有断言看着（下面 2 条，本机真跑）—— 否则「静默地不上锁」
      //      （告警被删）与「缺工具就崩溃」（裁决被回退）都能绿过去；
      //   ② 11 条锁判据**逐条登记为跳过**（`Checks.skip`，绝不 `ok()`）—— 一条不可能失败的
      //      断言比没有断言更坏，它制造的是虚假的信心。跳过条数计入收尾汇总（「跳过 N 项」）。
      const d = runBackupRaw(s, lockDest);
      checks.eq(d.status, 0,
        `[无 flock 降级] 缺工具时备份必须**照常跑完**（降级 = 告警后继续，不是崩溃）—— 日志尾部：${tail(d.log)}`);
      checks.that(d.log.includes('未上锁') && d.log.includes('不受并发保护'),
        '[无 flock 降级] 每一次无锁运行都必须在 backup.log 里**响亮**写出后果（含「未上锁」「不受并发保护」）' +
        `—— 否则「不上锁」就是静默降级 —— 实际日志尾部：${tail(d.log)}`);
      for (const m of LOCK_SKIPPED) checks.skip(m, NO_FLOCK_REASON);
    } else {
      const lockAssertionsBefore = checks.passed.length;
      const lReady = join(s.root, 'lock-ready');
      const lRelease = join(s.root, 'lock-release');
      spawnLockHolder(join(lockDest, '.lock'), lReady, lRelease);
      waitForFile(lReady, 20000, 'cron 锁的持有者就位');
      const l1 = runBackupRaw(s, lockDest);
      checks.that(typeof l1.status === 'number' && l1.status !== 0,
        `锁：cron 拿不到锁 ⇒ **算这一次失败**（不是「跳过」）—— 实际 status=${JSON.stringify(l1.status)}；` +
        `日志尾部：${tail(l1.log)}`);
      checks.that(l1.log.includes('拿不到锁'),
        `锁：失败必须点名锁（否则本判据会在别的失败上也绿）—— 日志尾部：${tail(l1.log)}`);
      const l1Names = namesIn(lockDest);
      checks.that(l1Names.filter((n) => !n.startsWith('manifest-')).length === 0,
        `锁：拿不到锁 ⇒ 一件产物也不许落盘 —— 实际 ${JSON.stringify(l1Names)}`);
      // 释放 ⇒ **同一个目录**必须能跑通：否则「拿不到锁」可能只是「锁文件存在就拒绝」（那不是 flock）。
      writeFileSync(lRelease, '');
      checks.that(waitForLockFree(join(lockDest, '.lock'), 30000),
        '锁：持有者退出后锁必须自动释放（flock 随进程/描述符退出而放）');
      const l1b = runBackupRaw(s, lockDest);
      checks.eq(l1b.status, 0, `锁：锁空出来之后必须能跑通 —— 日志尾部：${tail(l1b.log)}`);
      const l1bNames = namesIn(lockDest);
      checks.that(l1bNames.some((n) => n.startsWith('users-')),
        `锁：跑通的那一次必须真落了产物（否则上一条可能是空转）—— 实际 ${JSON.stringify(l1bNames)}`);
      checks.that(readdirSync(lockDest).includes('.lock'),
        `锁：cron 用的锁文件必须叫 $DEST/.lock（Task 3 的接口）—— 实际目录 ${JSON.stringify(readdirSync(lockDest))}`);

      // restore- 前缀 ⇒ 另一个锁（`.restore-lock`），且**等待 + 超时**而不是拒
      const rlDest = join(s.root, 'restore-lock-dest');
      mkdirSync(rlDest, { recursive: true });
      const rlReady = join(s.root, 'restore-lock-ready');
      const rlRelease = join(s.root, 'restore-lock-release');
      spawnLockHolder(join(rlDest, '.restore-lock'), rlReady, rlRelease);
      waitForFile(rlReady, 20000, '.restore-lock 的持有者就位');
      spawnDelayedTouch(rlRelease, 6);   // 6 秒后放行 —— 被测的那一次必须一直在等（留 2s 余量给慢跑者）
      const t0 = Date.now();
      const l2 = runBackupRaw(s, rlDest, ['--artifact-prefix', 'restore-']);
      const waitedMs = Date.now() - t0;
      checks.eq(l2.status, 0,
        `锁：.restore-lock 被占时，restore- 前缀必须**等**（救人用的锁不许被一次 cron 拒掉）—— ` +
        `status=${JSON.stringify(l2.status)}；日志尾部：${tail(l2.log)}`);
      checks.that(waitedMs >= 4000,
        `锁：上面那一次必须真的等过（实测 ${waitedMs}ms，要求 ≥4000ms；放行在 6s）—— ` +
        `立刻成功 ⇒ 它拿的不是 .restore-lock`);
      checks.that(readdirSync(rlDest).includes('.restore-lock'),
        `锁：restore- 前缀用的锁文件必须叫 $DEST/.restore-lock（与 cron 的 .lock **不是同一个**）—— ` +
        `实际目录 ${JSON.stringify(readdirSync(rlDest))}`);
      // ⚠️ `\d{10,14}`（收尾复核 Important）：现场备份的戳已改成**秒粒度 14 位**（小时链仍是 10 位）。
      //    本条的主题是「前缀体现在产物名上」——**宽度不是它的主题** ⇒ 两种宽度都接受；
      //    「比小时细」那半边由下面那一段**专条**钉住（它在没有 flock 的宿主上也会真跑）。
      checks.that(namesIn(rlDest).some((n) => /^users-restore-\d{10,14}\.sql\.gz$/.test(n)),
        `锁：--artifact-prefix 必须体现在产物名上（现场备份与小时那串分得开）—— 实际 ${JSON.stringify(namesIn(rlDest))}`);
      // 机械守卫（防「两份清单漂移」）：本段实际跑过的断言条数必须等于本机跳过清单的长度 ——
      // 谁在锁段增删了断言而没同步 `LOCK_SKIPPED`，CI 在这里**当场红**，而不是让本机默默少报。
      checks.eq(checks.passed.length - lockAssertionsBefore, LOCK_SKIPPED.length,
        '锁段断言数必须等于跳过清单长度（锁段增删断言 ⇒ 同步 LOCK_SKIPPED，否则本机跳过的条数会少报）');
    }

    // ── 复核 Important（收尾轮）：现场备份的戳必须**比小时细** ─────────────────────
    // 抓的失败：戳是 10 位 `%Y%m%d%H` 时，同一个 UTC 小时内恢复**第二次** ⇒ ① 的 `mv -f` 把
    // **第一份**现场备份（真正该留住的「恢复前现场」）覆盖成「此刻的库」—— 也就是刚被灌错的
    // 那一份。随后：③ 拿它跟它自己刚写的那份 manifest 比 ⇒ 照样通过；收尾行照旧说「恢复完成：
    // 恢复的是 restore-<ts> 那一份」—— 而手册把那份卖作「恢复错了的**第二次机会**」。
    // ⇒ 兜底**在需要它的那一刻**消失，且没有一句话说它消失了（本片头号教训的倒影：消失的
    // 正是那张安全网，而文案说它成功了）。
    // ⚠️ 这是**性质**断言（两次调用必须留下两份），不是形状断言：实现换成任何**足够细**的戳、
    //    只要名字不同就算对（形状那半边由锁段的 `users-restore-…` regex 看着）。
    // ⚠️ **不许**把「拒绝覆盖」当成修法（复核 Important 原文）：`restore.sh` 的缺镜像文案明写
    //    「重跑安全：① 会再记一份现场备份」⇒ 同一小时内重跑是**被鼓励**的；硬闸会把凌晨三点
    //    的人困死在最坏的那一刻。要变的只有**名字**。
    step('复核 Important：相隔 1 秒的两次现场备份（restore- 前缀）⇒ 必须留下**两份**、名字不同');
    const tsDest = join(s.root, 'restore-ts-dest');
    mkdirSync(tsDest, { recursive: true });
    const ts1 = runBackupRaw(s, tsDest, ['--artifact-prefix', 'restore-']);
    checks.eq(ts1.status, 0, `复核 Important 前提：第一份现场备份必须成功 —— 日志尾部：${tail(ts1.log)}`);
    // ⚠️ 两次之间 `sleep 1`：这是让两次调用**确定性**地跨过秒边界的唯一办法 —— 少了它，两个戳
    //    可能落在同一秒 ⇒ 一条**正确**的实现也会在这里红（本仓明写：假红比红更贵）。
    //    间隔 ≥1s ⇒ 秒粒度下两个戳必然不同（`floor(t1+1) ≥ floor(t1)+1`）。
    execFileSync('sleep', ['1']);
    const ts2 = runBackupRaw(s, tsDest, ['--artifact-prefix', 'restore-']);
    checks.eq(ts2.status, 0, `复核 Important 前提：第二份现场备份必须成功 —— 日志尾部：${tail(ts2.log)}`);
    const safetyNames = namesIn(tsDest).filter((n) => /^users-restore-.*\.sql\.gz$/.test(n));
    checks.that(safetyNames.length === 2 && new Set(safetyNames).size === 2,
      '复核 Important：相隔 1 秒的两次现场备份 ⇒ 必须留下**两份**（名字不同）—— ' +
      `实际 ${JSON.stringify(safetyNames)}。` +
      '10 位戳（= 比小时粗/正好等于小时）的失效形态：第二次的 `mv -f` 把第一份覆盖成「此刻的库」' +
      '⇒ 目录里只剩一份，而手册把它卖作「恢复错了的第二次机会」；③ 拿它跟自己新写的 manifest 比' +
      '照样通过、收尾行照旧说「恢复完成」—— 兜底消失且没有任何一句话说它消失了。' +
      '（本条**只看名字**：两次调用相隔 ≥1s ⇒ 只要戳细到秒，两份必然不同名。）');

    // ══════════════════════════════════════════════════════════════════════════
    // Task 3：恢复路径（`restore.sh` / `restore-drill.sh`）—— 判据 b / c / d / i2 / j
    //
    // 本片的正中央是 `restore.sh`：**凌晨三点有人照着跑的那条路**。演练（判据 b）存在的
    // 意义就是证明**这条路径**能用 —— 用测试自己播种的数据（期望值**不来自** manifest：
    // 那条路径与备份同生共死，只能一起对、一起错）。
    // ══════════════════════════════════════════════════════════════════════════
    const DECOY = `${RUN_ID}-decoy`;              // 判据 j 的「业务面」替身（真容器，能被 stop）
    const DECOY_EDGE = `${RUN_ID}-edge`;          // 判据 c 生产形态的「证书卷持有者」替身（挂 /data）
    const J4_PROJECT = `${RUN_ID}-j4stack`;       // 判据 j 那个 scratch compose 的 project 名
    /** 目录里**最新**一个 manifest 的 `<ts>`（`includeRestore=false` 时排除现场备份那串）。 */
    const manifestTs = (dir: string, includeRestore = false): string | null => {
      const tss = readdirSync(dir)
        .filter((n) => n.startsWith('manifest-') && n.endsWith('.json'))
        .map((n) => n.slice('manifest-'.length, n.length - '.json'.length))
        .filter((t) => includeRestore || !t.startsWith('restore-'));
      return tss.sort().pop() ?? null;
    };
    try {
      // ── 判据 b：恢复演练（设计 §6.1-b / §4.3）──────────────────────────────
      step('判据 b：恢复演练 restore-drill.sh（播种→备份→毁库→恢复→比对→真服务写路径）');
      const b1 = runScript(RESTORE_DRILL, []);
      checks.eq(b1.status, 0, `判据 b：演练必须端到端跑通 —— 输出尾部：${tailOut(b1.out)}`);
      checks.that(b1.out.includes('演练通过'),
        `判据 b：演练必须打出通过标记（收尾汇总靠它判读）—— 输出尾部：${tailOut(b1.out)}`);
      checks.that(/写路径 HTTP (200|201)/.test(b1.out),
        '判据 b：演练必须**真的经由真 user-service 走通一条写路径**（设计 §4.3 第 4 项）—— ' +
        '只验「起得来」不够：唯一的迁移是 `CREATE TABLE IF NOT EXISTS` 且 `migrationsRun: true` ' +
        `⇒ **空库也起得来** —— 输出尾部：${tailOut(b1.out)}`);

      // ── 判据 b 的负对照（设计 §6.1-b；第三轮 Important 3）────────────────────
      // 🔴 形态**必须**是「行数相同、内容不同」：改一个字节会先撞上 ③ 的 gzip/sha256
      //    ⇒ 那是在测解压，**把比对整段删掉也照样红**。这里让恢复**成功**、内容差一条昵称。
      // 做法：把演练脚本与 backup.sh **逐字复制**到临时目录，同目录里放一个「变异体」
      //    `restore.sh`（真脚本照跑完 + 之后改一条昵称）。演练用 `dirname "$0"` 找兄弟脚本
      //    ⇒ 跑的是**交付物自己的比对逻辑**（比对被删/写成恒真 ⇒ 这个演练会「通过」）。
      step('判据 b 负对照：恢复后的内容与播种差一条昵称（行数相同）⇒ 比对必须红');
      const mutOps = join(s.root, 'mut', 'scripts');
      mkdirSync(mutOps, { recursive: true });
      for (const f of ['restore-drill.sh', 'backup.sh']) {
        copyFileSync(join(REPO_ROOT, 'scripts', 'ops', f), join(mutOps, f));
      }
      writeFileSync(join(mutOps, 'restore.sh'), MUTANT_RESTORE.replace('__REAL_RESTORE__', posixPath(RESTORE_SH)));
      const b2 = runScript(join(mutOps, 'restore-drill.sh'), []);
      checks.that(typeof b2.status === 'number' && b2.status !== 0,
        '判据 b 负对照：恢复结果与播种**差一条昵称**（行数仍相同）⇒ 演练必须红 —— ' +
        `status=${JSON.stringify(b2.status)}；输出尾部：${tailOut(b2.out)}`);
      checks.that(b2.out.includes('与播种的期望值不一致'),
        '判据 b 负对照：红必须来自**内容比对**那一步（别的步骤先挂了不算数）—— ' +
        `输出尾部：${tailOut(b2.out)}`);
      checks.that(b2.out.includes('mallory') && b2.out.includes('期望'),
        '判据 b 负对照：比对必须把「期望」与「实得」都打出来（否则凌晨三点的人看不出差在哪）—— ' +
        `输出尾部：${tailOut(b2.out)}`);
      checks.that(!b2.out.includes('写路径 HTTP'),
        '判据 b 负对照：比对红了就**不该**再走到写路径（出现它说明红的位置在比对之前/之后分不清）');

      // ── 判据 c：证书卷真的可恢复（设计 §6.1-c；第三轮 I-6 的期望值来源）────────────
      step('判据 c：证书卷真的可恢复（解包条目 ≥ 自己播种的源卷文件数，且与归档清单一致）');
      const tsA = manifestTs(s.dest);
      if (tsA === null) throw new ConformanceError('判据 c：scratch 备份目录里没有非 restore- 的 manifest（判据 a 应当已产出）');
      const planted = s.caddySeed.map((f) => f.rel);
      const archive = tarFileList(MYSQL, join(s.dest, productFile(tsA, 'caddy')));
      // 毁掉源卷：**这才是演练** —— 不毁就分不清「恢复了」与「本来就在」。
      sh('docker', ['exec', MYSQL, 'sh', '-c', 'rm -rf /data/*']);
      checks.eq(listFilesUnder(s.caddyDir).length, 0,
        '判据 c：毁卷这一步必须真的把 scratch 的 /data 清空（否则下面的比对是空测）');
      const projCD = makeProjDir(s.root, 'proj-cd');
      checks.eq(readFileSync(join(projCD, '.env'), 'utf8'), 'POISONED-ENV\n',
        '判据 d：恢复前目标 .env 是**故意写坏的**（否则「恢复对了」与被恢复这件事无关）');
      const cdRun = runScript(RESTORE_SH, restoreArgs({
        dest: s.dest, ts: tsA, proj: projCD, extra: ['--restore-caddy', '--restore-env'],
      }));
      checks.eq(cdRun.status, 0,
        `判据 c/d：带 --restore-caddy --restore-env 的恢复必须成功 —— 输出尾部：${tailOut(cdRun.out)}`);
      const extracted = listFilesUnder(s.caddyDir);
      const cViol = caddyViolations(extracted, archive, planted);
      checks.that(cViol.length === 0,
        '判据 c：解包结果必须**覆盖自己播种的源卷文件集**、且与归档清单一致 —— ' +
        `解包=${JSON.stringify(extracted)} 归档=${JSON.stringify(archive)} 播种=${JSON.stringify(planted)}（${cViol.join(' | ')}）`);
      for (const f of s.caddySeed) {
        checks.eq(readFileSync(join(s.caddyDir, f.rel), 'utf8'), f.content,
          `判据 c：解包回来的 ${f.rel} 必须与**播种进 scratch 源卷的那份**逐字一致（期望值不来自 manifest）`);
      }
      checks.eq(m.caddy_entries, planted.length,
        '判据 c：manifest 记的 caddy_entries 必须等于播种的源卷文件数（manifest 那份只用于「归档清单 vs 解包结果」这一层）');
      // 负对照（设计 §6.1-c 的两问）：① 清单里去掉一个条目 ⇒ 红；② 对空卷打包 ⇒ 红（内容下限）。
      const cNeg1 = caddyViolations(planted.slice(0, 1), archive, planted);
      checks.that(cNeg1.length > 0,
        `判据 c 负对照①：解包结果少一个条目必须红 —— 合成输入 ${JSON.stringify(planted.slice(0, 1))} ⇒ ${JSON.stringify(cNeg1)}`);
      const cNeg2 = caddyViolations([], [], planted);
      checks.that(cNeg2.length > 0,
        `判据 c 负对照②（内容下限）：**空卷**打包出来什么都没有必须红 —— 实得 ${JSON.stringify(cNeg2)}`);
      const cNeg3 = caddyViolations(planted, planted.slice(0, 1), planted);
      checks.that(cNeg3.length > 0,
        `判据 c 负对照③：归档清单里少一条（解包结果却有）也必须红 —— 实得 ${JSON.stringify(cNeg3)}`);

      // ── 判据 c 的**生产形态**：② 停掉证书卷持有者 ⇒ ⑤ 把它起回来再解包（设计 §4.2 的固定顺序）──
      step('判据 c 生产形态：② 停掉持有 /data 的容器 ⇒ ⑤ 起回它再解包；且现场备份必须在**停之前**');
      // 生产形态（**非空清单**）下 ② 真的会停容器 ⇒ 这条链只有在非空清单下才验得到：
      //   ① 现场备份必须**在停之前**做完（那一刻 edge 还活着，`docker exec … tar` 才跑得动）；
      //   ⑤ 面对一个**已被 ② 停掉**的容器，必须能把它起回来、清空、再解包。
      // ⚠️ 卷要**先毒掉**（改一个文件的内容 + 多留一个 stale 文件）而不是先清空：
      //   清空的话「⑤ 什么都没做」也是绿的（+ 现场备份会如实地记 0 条 —— 那正是上一次跑红的形态）；
      //   毒掉之后，「清空 + 解包」与「什么都没做」在**文件集与内容**上都分得开。
      shTry('docker', ['rm', '-f', DECOY_EDGE]);
      sh('docker', ['run', '-d', '--name', DECOY_EDGE, '-v', `${s.caddyDir}:/data`, 'redis:7-alpine']);
      // ⚠️ 毒卷**必须由容器侧写**（`docker exec` 默认 = 镜像里的 root），**不能**用宿主侧
      //    `writeFileSync`：上面那行一旦起过容器，这棵树的属主就**未必**还是宿主了 ——
      //    redis 的 entrypoint 会把 `WORKDIR`（就是 `/data`）整棵 `chown` 成 redis(999)，
      //    而它对宿主来说发生在**不确定的时刻**（entrypoint 与宿主下一次文件操作是竞态）
      //    ⇒ 宿主侧那次写的成败要看运气：CI 第二次跑就红在这里（`EACCES … sub/account.json`），
      //    而上一轮同代码是绿的。详见 `Scratch.down()` 的注释（同一根因的另一半）。
      //    ⚠️ 换成容器侧写**不削弱任何判据**：紧接着的「毁/毒卷必须真的改变了 /data」仍然断言文件集，
      //       后面「stale 文件必须消失」与「内容必须是播进去的那份」仍然断言毒掉的那版被覆盖 ——
      //       差别只在**谁的手**写的；而卷在生产里同样只由容器写 ⇒ 容器侧写其实更保真，
      //       也与判据 c 的「毁卷」那步（`docker exec … 'rm -rf /data/*'`）同一形态。
      sh('docker', ['exec', DECOY_EDGE, 'sh', '-c',
        'printf "POISONED\\n" > /data/sub/account.json && printf "STALE\\n" > /data/stale.txt']);
      const poisoned = listFilesUnder(s.caddyDir);
      checks.eq(poisoned.join(','), 'certificates.pem,stale.txt,sub/account.json',
        '判据 c 生产形态：毁/毒卷必须真的改变了 /data（否则下面「解包填回来」是空测）');
      // 前提自证（R115 同族）：只断**文件集**还不够 —— 一个把毒写成「与播种同一份内容」的实现，
      // 会让下面那两条「内容必须是**播进去的那份**」变成恒真谓词。毒必须真的落在**内容**上。
      // ⚠️ 这条是随「毒改由容器侧写」一起加的：改的是**谁的手**，正断言一个字都没动。
      checks.eq(readFileSync(join(s.caddyDir, 'sub', 'account.json'), 'utf8'), 'POISONED\n',
        '判据 c 生产形态 前提：毒必须真的写进了内容（否则「内容必须是播进去的那份」是恒真谓词）');
      const projC2 = makeProjDir(s.root, 'proj-c2');
      const c2 = runScript(RESTORE_SH, restoreArgs({
        dest: s.dest, ts: tsA, proj: projC2,
        extra: ['--app-services', DECOY_EDGE, '--edge-container', DECOY_EDGE, '--restore-caddy'],
      }));
      // C-1（第二轮 Critical）：① 现场备份必须在**停任何容器之前**做完。反过来的实现
      //（先停 edge 再备份）会让「`docker exec <已停容器> tar`」失败 ⇒ 现场备份整个失败
      // ⇒ 下面两条红。这是**唯一**能证明那个顺序的判据（后果级，不是读源码）。
      const safetyTs = readdirSync(s.dest)
        .filter((n) => n.startsWith('manifest-restore-') && n.endsWith('.json'))
        .map((n) => n.slice('manifest-restore-'.length, n.length - '.json'.length)).sort().pop();
      if (safetyTs === undefined) throw new ConformanceError('判据 c：没找到现场备份的 manifest-restore-*.json');
      const safetyMf = JSON.parse(readFileSync(join(s.dest, `manifest-restore-${safetyTs}.json`), 'utf8')) as
        { ok: unknown; caddy_entries: unknown };
      checks.eq(safetyMf.ok, true,
        '判据 c/C-1：现场备份必须成功（它失败 ⇒ 恢复就该停；先停 edge 再备份的实现在这里就是 ok:false）');
      checks.atLeast(Number(safetyMf.caddy_entries), poisoned.length,
        '判据 c/C-1（第二轮 Critical）：现场备份里的证书卷条目数必须**等于停服前那一刻的真实条目数** —— ' +
        '即 ① 确实在**停任何容器之前**做完（先停 edge 再 tar ⇒ 对已停容器 exec 失败 ⇒ 这里只可能是 0）');
      checks.eq(listFilesUnder(s.caddyDir).join(','), s.caddySeed.map((f) => f.rel).sort().join(','),
        '判据 c 生产形态：② 停过的容器被 ⑤ 起回来之后，解包必须把卷**清空并填回原样**（stale 文件必须消失）' +
        `—— 实际 ${JSON.stringify(listFilesUnder(s.caddyDir))}`);
      for (const f of s.caddySeed) {
        checks.eq(readFileSync(join(s.caddyDir, f.rel), 'utf8'), f.content,
          `判据 c 生产形态：${f.rel} 的内容必须是**播进去的那份**（毒掉的那版必须被覆盖）`);
      }
      checks.that(c2.out.indexOf('证书卷已还原') >= 0 && c2.out.indexOf('证书卷已还原') < c2.out.indexOf('拒绝起栈'),
        '判据 c 生产形态：⑤（还原证书卷）必须发生在 ⑥（校验镜像/起栈）**之前** —— ' +
        `实际：还原=${c2.out.indexOf('证书卷已还原')} 拒绝起栈=${c2.out.indexOf('拒绝起栈')}；输出尾部：${tailOut(c2.out, 8)}`);
      checks.that(typeof c2.status === 'number' && c2.status !== 0 && c2.out.includes('拒绝起栈'),
        '判据 c 生产形态：这一次必然在 ⑥ 被拒（那个替身容器没有对应镜像）—— 用来**钉住走到了 ⑥** ' +
        `（否则「⑤ 在 ⑥ 之前」可能只是两处都没跑）—— status=${JSON.stringify(c2.status)}；输出尾部：${tailOut(c2.out, 8)}`);

      // ── 判据 d：`.env` 往返（与源**派生值**逐字一致）＋ 判别力自证 ＋ 一个字符的负对照 ──────────
      step('判据 d：.env = 源剔除 PAY_CONFIG_ENC_KEY 行（⚙️15）；判别力自证；负对照 = 内容差一个字符 ⇒ 必须红');
      // 期望 = **派生值**（⚙️15）：源文件逐行过滤 `^PAY_CONFIG_ENC_KEY=` 后的逐字内容，行序/换行不变。
      // 派生规则来自判据一侧（`deriveEnvExpectation`）、**不读产物**（拿产物当期望 = 一起对、一起错）。
      const envSource = readFileSync(s.envFile, 'utf8');
      const envExpected = deriveEnvExpectation(envSource);
      const dContent = readFileSync(join(projCD, '.env'), 'utf8');
      checks.eq(dContent, envExpected,
        '判据 d：--restore-env 之后项目目录里的 .env 必须与**源剔除 PAY_CONFIG_ENC_KEY 行的派生期望**' +
        '逐字一致（期望从播种的源文件派生，不读产物）');
      checks.that(!dContent.includes('PAY_CONFIG_ENC_KEY'),
        '判据 d：恢复产物里**不得**出现 PAY_CONFIG_ENC_KEY（显式负向，冗余保险 —— 即便派生规则被改坏，' +
        '这一条也独立钉住「主钥不进备份」）');
      // 判别力自证（T12）：把**未过滤的源内容**当作「产物」喂同一个期望 ⇒ 必须**不相等**。
      // 若这里相等（派生规则退化成恒等 / 忘了过滤），「backup 忘了剥 + 期望跟着一起错」会让判据 d
      // 恒真（证据套证据）—— 这一条正是拦那个耦合形态的。
      checks.that(envExpected !== envSource,
        '判据 d 判别力自证：派生期望必须**真的**与未剥的源内容不同（相等 ⇒ 「忘了剥」的产物也能过判据 d）—— ' +
        `源 ${JSON.stringify(envSource)}；派生 ${JSON.stringify(envExpected)}`);
      // 负对照：把备份里的 env 产物改一个字符，**并**把 manifest 的那条 sha256/bytes 改成自洽
      //（不改的话会先撞上 ③ 的 sha 闸 ⇒ 测的就成了「sha」而不是「往返」），再恢复一次 ⇒
      // 目标文件必须**不等于派生期望**（否则「与派生期望一致」是恒真谓词）。
      const envDest = join(s.root, 'env-tamper-dest');
      cloneSet(s.dest, envDest, tsA);
      retamper(envDest, tsA, 'env', (b) =>
        gzipSync(Buffer.from(gunzipSync(b).toString('utf8').replace('JWT_SECRET=probe', 'JWT_SECRET=probeX'), 'utf8')));
      const projD2 = makeProjDir(s.root, 'proj-d2');
      const dNeg = runScript(RESTORE_SH, restoreArgs({ dest: envDest, ts: tsA, proj: projD2, extra: ['--restore-env'] }));
      checks.eq(dNeg.status, 0,
        '判据 d 负对照：自洽（sha 对得上）但内容不同 ⇒ 恢复**必须成功**（红要红在比对那一步，不是红在 ③）—— ' +
        `输出尾部：${tailOut(dNeg.out)}`);
      const dNegContent = readFileSync(join(projD2, '.env'), 'utf8');
      checks.that(dNegContent !== envExpected,
        '判据 d 负对照：内容差一个字符 ⇒ 「与派生期望逐字一致」这个比对必须红（恒真谓词在这里就露馅）');
      checks.that(dNegContent.includes('JWT_SECRET=probeX'),
        '判据 d 负对照：恢复出来的必须就是**给它的那一份**（差在内容，不是别处崩了）—— ' +
        `实际 ${JSON.stringify(dNegContent)}`);

      // ── 判据 ③ 的闸：dump 与 manifest 对不上 ⇒ 拒绝灌库、数据库毫发无损 ────────────
      step('判据 ③：dump 与 manifest 的 sha256 对不上 ⇒ 拒绝灌库（灾难不许发生）');
      const tamperDest = join(s.root, 'dump-tamper-dest');
      cloneSet(s.dest, tamperDest, tsA);
      // ⚠️ 这一份**不**改 manifest：要的就是「实物与记录脱钩」这个形态。
      const tDump = join(tamperDest, productFile(tsA, 'users'));
      writeFileSync(tDump, gzipSync(Buffer.from(
        gunzipSync(readFileSync(tDump)).toString('utf8').replace("'alice'", "'mallory'"), 'utf8')));
      const truthT = s.truth();
      const projT = makeProjDir(s.root, 'proj-t');
      const tRun = runScript(RESTORE_SH, restoreArgs({ dest: tamperDest, ts: tsA, proj: projT }));
      checks.that(typeof tRun.status === 'number' && tRun.status !== 0,
        '判据 ③：篡改过的 dump（sha256 与 manifest 对不上）必须让恢复**拒绝执行** —— ' +
        `status=${JSON.stringify(tRun.status)}；输出尾部：${tailOut(tRun.out)}`);
      checks.that(/sha256|对不上/.test(tRun.out),
        `判据 ③：拒绝必须点名「对不上」这件事（否则读者不知道坏在哪）—— 输出尾部：${tailOut(tRun.out)}`);
      checks.eq(JSON.stringify(s.truth()), JSON.stringify(truthT),
        '判据 ③：拒绝之后数据库必须**毫发无损**（③ 被删 ⇒ 篡改的 dump 会被灌进去 ⇒ 这条红）');

      // ── 判据 ③ 的**截断检测**负对照：dump 被写短（收尾标记没了）⇒ 必须拒绝 ────────────
      // 复核 Minor 6：截断检测此前**只有通过分支被执行过**（好 dump 一律放行）⇒ 它是一条
      // **不可能失败**的断言（本仓点名的反模式：判据存在 ≠ 判据有效）。
      // 造样本的要害：sha256 **必须自洽**（`retamper` 同步改 manifest）—— 否则会先撞上 sha 闸，
      // 测到的就成了「sha 校验」而不是「截断检测」。截在收尾行**开头**（不是随便砍 N 字节：
      // 砍 40 字节有可能恰好留下 `Dump completed` 这 14 个字符 ⇒ 那种「负对照」会飘）。
      step('判据 ③ 负对照（截断）：dump 被写短（收尾标记没了，sha256 自洽）⇒ 必须拒绝，且不许灌库');
      const truncDest = join(s.root, 'dump-trunc-dest');
      cloneSet(s.dest, truncDest, tsA);
      retamper(truncDest, tsA, 'users', (b) => {
        const plain = gunzipSync(b);
        const at = plain.lastIndexOf(TRUNC_MARKER);
        // 前提自证：正本里必须有那条收尾行 —— 没有 ⇒ 这份负对照**造不出来**（mysqldump 换了 footer）
        if (at < 0) {
          throw new ConformanceError(`判据 ③ 负对照（截断）：正本 dump 里找不到 ${TRUNC_MARKER} ⇒ 造不出截断样本`);
        }
        return gzipSync(plain.subarray(0, at));   // 砍掉收尾行及其后的一切（gzip 本身仍是完整的）
      });
      const truthTrunc = s.truth();
      const projTrunc = makeProjDir(s.root, 'proj-trunc');
      const truncRun = runScript(RESTORE_SH, restoreArgs({ dest: truncDest, ts: tsA, proj: projTrunc }));
      checks.that(typeof truncRun.status === 'number' && truncRun.status !== 0,
        '判据 ③ 负对照（截断）：sha256 自洽但**被截短**的 dump 必须让恢复拒绝执行 —— ' +
        `status=${JSON.stringify(truncRun.status)}；输出尾部：${tailOut(truncRun.out)}`);
      checks.that(/截断|收尾标记/.test(truncRun.out),
        '判据 ③ 负对照（截断）：红必须来自**截断检测**那一条（别的检查先挂了不算数）—— ' +
        `输出尾部：${tailOut(truncRun.out)}`);
      checks.eq(JSON.stringify(s.truth()), JSON.stringify(truthTrunc),
        '判据 ③ 负对照（截断）：拒绝必须发生在**动数据库之前**（被截断的 dump 一旦灌进去就是第二次事故：' +
        'DROP 已经执行、数据只剩半份）');

      // ── 判据 i2：空 --app-services = 演练形态 ────────────────────────────────────
      step('判据 i2：空清单 ⇒ 一次 stop/start/compose/curl 都不许发生 + 项目目录不留新文件');
      // 垫片（BASH_ENV 注入的 shell 函数）：从**调用现场**证明「没发生」—— 事后看容器状态看不见。
      const shim = dockerShim(join(s.root, 'shim'));
      const i2Log = join(s.root, 'shim-i2.log');
      const i2Proj = makeProjDir(s.root, 'proj-i2');
      const statesBefore = containerStates([MYSQL, REDIS, APP]);
      // ⚠️ 这一跑**不传 `--backup-ts`**（传空串 = 当作没传）⇒ 顺带钉住「缺省选取」那个分支：
      //    它必须挑到那份**小时备份**，而不是目录里 `restore-*` 兜底备份（后者记的是事故现场，
      //    不是要恢复的数据）。其余每一跑都显式传 ts ⇒ 不这样加一条，缺省分支就是**从未执行过的代码**。
      const i2 = runScript(RESTORE_SH, restoreArgs({ dest: s.dest, ts: tsA, proj: i2Proj, extra: ['--backup-ts', ''] }),
        { BASH_ENV: shim, FTL_SHIM_LOG: i2Log });
      checks.eq(i2.status, 0, `判据 i2：空清单的恢复必须跑通（演练形态）—— 输出尾部：${tailOut(i2.out)}`);
      const i2Calls = existsSync(i2Log) ? readFileSync(i2Log, 'utf8') : '';
      // 🔴 非空性自证：垫片必须**真的装着** —— 否则日志为空时「没有 stop」是**空测**。
      checks.that(shimCalls(i2Calls, 'docker', 'exec').length > 0,
        '判据 i2：垫片必须真的装着（日志里得有 docker 调用；否则「没有 stop」什么也证明不了）—— ' +
        `实际日志：${JSON.stringify(i2Calls.slice(0, 400))}`);
      const i2Banned = ['stop', 'start', 'restart', 'compose'].flatMap((s2) => shimCalls(i2Calls, 'docker', s2))
        .concat(shimCalls(i2Calls, 'curl'));
      checks.that(i2Banned.length === 0,
        `判据 i2：空清单 ⇒ **一次 stop/start/restart/compose/curl 都不许发生**（②⑥⑦ 整段跳过）—— 实际 ${JSON.stringify(i2Banned)}`);
      checks.eq(containerStates([MYSQL, REDIS, APP]).join(','), statesBefore.join(','),
        '判据 i2：空清单不得改变任何 scratch 容器的状态（StartedAt/Status 逐字不变）');
      checks.eq(readdirSync(i2Proj).sort().join(','), '.env,docker-compose.yml',
        '判据 i2（设计 Important 8）：恢复不得在**项目目录**里留下任何新文件（否则 `deploy.sh --assert-clean` ' +
        `会在一次**成功**发布的末尾红）—— 实际 ${JSON.stringify(readdirSync(i2Proj))}`);
      checks.that(i2.out.includes(`要恢复的是：${tsA}`) && i2.out.includes('耗时'),
        '判据 i2/⑦：收尾必须打印「恢复了哪一份、耗时多少」（凌晨三点的人靠它确认跑对了）—— ' +
        `实际输出尾部：${tailOut(i2.out, 12)}`);
      // 复核 Minor 8：②⑥⑦ 的「跳过」行在**输出中段**，而凌晨三点的人只读**最后一行** ——
      // 空清单形态的最后一行必须自己带前提，否则「✅ 恢复完成」被读成「站已经好了」。
      // ⚠️ 断言**只认最后一行**：拿整段输出去 includes('演练形态') 会被中段那三行跳过行喂饱（假绿）。
      const i2LastLine = i2.out.trimEnd().split('\n').map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
      checks.that(i2LastLine.includes('✅ 恢复完成') && i2LastLine.includes('演练形态') && i2LastLine.includes('未冒烟'),
        '判据 i2/收尾行（复核 Minor 8）：空清单形态的**最后一行**必须自己说出「演练形态：站未起、未冒烟」—— ' +
        `实际最后一行：${JSON.stringify(i2LastLine)}`);
      // 负对照（设计 §6.1-i2）：非空清单 ⇒ 该演练环境里**没有**那些容器 ⇒ 必须拒绝（且不许碰数据库）。
      step('判据 i2 负对照：清单里有一个不存在的容器 ⇒ 必须拒绝，且数据库毫发无损');
      const i2nLog = join(s.root, 'shim-i2n.log');
      const i2nProj = makeProjDir(s.root, 'proj-i2n');
      const truthI2n = s.truth();
      const missingSvc = `no-such-svc-${process.pid}`;
      const i2n = runScript(RESTORE_SH,
        restoreArgs({ dest: s.dest, ts: tsA, proj: i2nProj, extra: ['--app-services', missingSvc] }),
        { BASH_ENV: shim, FTL_SHIM_LOG: i2nLog });
      checks.that(typeof i2n.status === 'number' && i2n.status !== 0,
        `判据 i2 负对照：清单里有不存在的容器（${missingSvc}）⇒ 必须拒绝执行 —— ` +
        `status=${JSON.stringify(i2n.status)}；输出尾部：${tailOut(i2n.out)}`);
      checks.that(i2n.out.includes(missingSvc),
        `判据 i2 负对照：拒绝必须**点名**那个容器（否则读者不知道该改哪个名字）—— 输出尾部：${tailOut(i2n.out)}`);
      const i2nCalls = existsSync(i2nLog) ? readFileSync(i2nLog, 'utf8') : '';
      checks.that(shimCalls(i2nCalls, 'docker', 'stop').length === 0,
        '判据 i2 负对照：校验要**先**做、停服要**后**做 ⇒ 一个容器都不该被停 —— ' +
        `实际 ${JSON.stringify(shimCalls(i2nCalls, 'docker', 'stop'))}`);
      checks.eq(JSON.stringify(s.truth()), JSON.stringify(truthI2n),
        '判据 i2 负对照：拒绝必须发生在**动数据库之前**');

      // ── 身份闸 / 非交互闸（机械闸优于散文 —— 设计 §7 末 + §4.2）───────────────────
      step('身份闸与非交互闸：root ⇒ 拒；无 --yes-i-know ⇒ 拒；空清单 + 交互式 ⇒ 拒');
      const gateDest = join(s.root, 'gate-dest');
      mkdirSync(gateDest, { recursive: true });
      const gateBase = ['--backup-dir', gateDest, '--backup-ts', tsA, '--mysql-container', MYSQL,
        '--db-name', DB, '--edge-container', MYSQL, '--stack-container', MYSQL];
      // ① root 闸：用 shell 函数顶掉 `id` ⇒ `$(id -u)` = 0（**不是**真的以 root 跑 —— 本机与 CI 都做不到）。
      const asRoot = runBashC('id() { printf "%s" 0; }; export -f id; exec bash "$@"', [RESTORE_SH, ...gateBase]);
      checks.eq(asRoot.status, 2,
        '身份闸：`id -u` = 0 时必须**拒绝**（exit 2；机械闸，不是手册里的一句散文）—— ' +
        `输出尾部：${tailOut(asRoot.out)}`);
      checks.that(/root/.test(asRoot.out) && /ubuntu/.test(asRoot.out),
        `身份闸：拒绝文案必须给出**怎么做**（以 ubuntu 身份跑）—— 输出尾部：${tailOut(asRoot.out)}`);
      checks.eq(readdirSync(gateDest).length, 0,
        '身份闸：拒绝必须发生在**任何动作之前**（连现场备份都不许开始）');
      // ② 非交互闸：stdin 不是 TTY（spawn 的 stdin 是管道）且没传 --yes-i-know。
      const noTty = runScript(RESTORE_SH, gateBase);
      checks.eq(noTty.status, 2,
        `非交互闸：stdin 不是 TTY 且没传 --yes-i-know ⇒ 必须拒绝 —— 输出尾部：${tailOut(noTty.out)}`);
      checks.that(noTty.out.includes('--yes-i-know'),
        `非交互闸：拒绝文案必须点名**唯一**的豁免开关 —— 输出尾部：${tailOut(noTty.out)}`);
      checks.eq(readdirSync(gateDest).length, 0,
        '非交互闸：拒绝必须发生在任何动作之前（连现场备份都不许开始）');
      // ③ 空清单 + **交互式**（真 TTY）⇒ 也必须拒（这份豁免只属于演练）。
      if (spawnSync('bash', ['-c', 'command -v script >/dev/null 2>&1']).status !== 0) {
        // ⚠️ 一条 `checks.skip` 顶一条断言（复核 Minor 2）：这一段有 3 条断言 ⇒ 登记 3 条跳过。
        //    挤成一条会让本机少报 2 条，而 CI 上又比「本机 + 跳过」多 2 条 ⇒ 计数口径对不上。
        for (const m of EMPTY_PTY_SKIPPED) checks.skip(m, NO_PTY_REASON);
      } else {
        const ptyAssertionsBefore = checks.passed.length;
        const ptyCmd = ['bash', posixPath(RESTORE_SH), '--app-services', '', ...gateBase].map(shellQuote).join(' ');
        const emptyPty = runBashC('script -qec "$1" /dev/null', [ptyCmd]);
        checks.eq(emptyPty.status, 2,
          '空清单闸：交互式 + 空 --app-services（生产调用必须给非空清单）⇒ 必须拒绝 —— ' +
          `输出尾部：${tailOut(emptyPty.out)}`);
        checks.that(emptyPty.out.includes('--yes-i-know'),
          `空清单闸：拒绝文案必须点名唯一的豁免开关 —— 输出尾部：${tailOut(emptyPty.out)}`);
        checks.eq(readdirSync(gateDest).length, 0,
          '空清单闸：拒绝必须发生在任何动作之前');
        // 机械守卫（与锁段同一个办法）：本段**真跑过**的断言数必须等于跳过清单长度 ——
        // 谁在本段增删断言而没同步 `EMPTY_PTY_SKIPPED`，CI（有 script(1) 的那一侧）在这里**当场红**；
        // 本机那一侧看不见这里的漂移，所以守卫必须放在 else 里。
        checks.eq(checks.passed.length - ptyAssertionsBefore, EMPTY_PTY_SKIPPED.length,
          '空清单闸断言数必须等于 EMPTY_PTY_SKIPPED 的长度（本段增删断言 ⇒ 同步清单，否则本机跳过的条数会少报）');
      }

      // ── 判据 j：manifest 记镜像版本 + ⑥ 先校验再起栈 ──────────────────────────────
      step('判据 j：manifest 记的镜像版本与运行中容器一致；默认名 ⇒ usable:false；⑥ 先校验再起栈');
      checks.eq(m.image_tag, imageTagOf(MYSQL),
        '判据 j：manifest 的 image_tag 必须等于被 inspect 的容器的镜像 tag（**机制层**）。' +
        '⚠️ 诚实边界：CI 里 `conformance-stack.sh` 会把镜像**改回默认名** ⇒ 这条在 CI 里只能证明' +
        '「记了一个版本字符串」，**不能**证明版本保真 —— 真正的证据在 §6.2 的生产验收');
      checks.eq(m.image_tag_usable, true,
        '判据 j：带版本号的 tag（scratch 里是 mysql 的 `8.0`）必须被记为 usable:true');
      // 默认名 ⇒ usable:false（**用真容器注入**：user-service 的镜像是 `pokergame-user-service:latest`）
      const jDest = join(s.root, 'j-dest');
      mkdirSync(jDest, { recursive: true });
      const jBackup = runBackupRaw(s, jDest, ['--stack-container', APP]);
      checks.eq(jBackup.status, 0, `判据 j：那次备份必须成功 —— 日志尾部：${tail(jBackup.log)}`);
      const jTs = manifestTs(jDest);
      if (jTs === null) throw new ConformanceError('判据 j：j-dest 里没有 manifest（备份应已产出）');
      const jm = JSON.parse(readFileSync(join(jDest, `manifest-${jTs}.json`), 'utf8')) as
        { image_tag: unknown; image_tag_usable: unknown };
      checks.eq(jm.image_tag, 'latest', '判据 j：默认名必须被**如实**记下（scratch 里就是 latest）');
      checks.eq(jm.image_tag_usable, false,
        '判据 j：latest（默认名）⇒ image_tag_usable 必须是 false（⑥ 据此拒绝起栈；设计 §6.1-j）');
      // ⑥ 的两道闸：**业务面替身**（真容器，能被 stop；名字不以 ftl- 开头）
      shTry('docker', ['rm', '-f', DECOY]);
      sh('docker', ['run', '-d', '--name', DECOY, 'redis:7-alpine']);
      const jLog = join(s.root, 'shim-j.log');
      const jProj = makeProjDir(s.root, 'proj-j');
      const jRef = runScript(RESTORE_SH, restoreArgs({
        dest: jDest, ts: jTs, proj: jProj, extra: ['--app-services', DECOY, '--stack-container', APP],
      }), { BASH_ENV: shim, FTL_SHIM_LOG: jLog });
      checks.that(typeof jRef.status === 'number' && jRef.status !== 0,
        '判据 j/⑥：现场备份记的是默认名（latest）⇒ **必须拒绝起栈**（否则会在数据库已被换掉、' +
        `站点已停的那一刻去拉镜像）—— status=${JSON.stringify(jRef.status)}；输出尾部：${tailOut(jRef.out)}`);
      checks.that(/默认名|usable|image_tag/.test(jRef.out),
        `判据 j/⑥：拒绝理由必须点名「默认名 / image_tag_usable:false」那一项 —— 输出尾部：${tailOut(jRef.out)}`);
      const jCalls = existsSync(jLog) ? readFileSync(jLog, 'utf8') : '';
      checks.that(shimCalls(jCalls, 'docker', 'compose').length === 0,
        `判据 j/⑥：拒绝必须发生在 compose **之前**（先校验、再起栈）—— 实际 ${JSON.stringify(shimCalls(jCalls, 'docker', 'compose'))}`);
      checks.eq(shimCalls(jCalls, 'docker', 'stop').length, 1,
        '判据 j/⑥：这一形态下业务面（替身）**应当**被停 —— 说明它真的走到了 ⑥，而不是更早就退了');
      checks.eq(s.truth().count, 2,
        '判据 j/⑥：拒绝发生在 ④ **之后**（数据库已经被换过 —— 这正是「先校验、再起栈」要防的那一刻）');
      // ⑥ 的第二道闸：本地没有那个镜像 ⇒ 也要拒绝（点名缺哪个引用）
      const j3Log = join(s.root, 'shim-j3.log');
      const j3Proj = makeProjDir(s.root, 'proj-j3');
      const j3 = runScript(RESTORE_SH, restoreArgs({
        dest: jDest, ts: jTs, proj: j3Proj,
        extra: ['--app-services', DECOY, '--image-prefix', 'pokergame', '--image-tag', 'v0.0.0-nope'],
      }), { BASH_ENV: shim, FTL_SHIM_LOG: j3Log });
      checks.that(typeof j3.status === 'number' && j3.status !== 0,
        `判据 j/⑥：本地没有那个 tag ⇒ 必须拒绝起栈 —— status=${JSON.stringify(j3.status)}；输出尾部：${tailOut(j3.out)}`);
      checks.that(j3.out.includes(`pokergame-${DECOY}:v0.0.0-nope`),
        `判据 j/⑥：拒绝必须点名**本地缺的那个镜像引用**（否则读者不知道该补什么）—— 输出尾部：${tailOut(j3.out)}`);
      // 复核 Minor 3：这是**数据库已经被换过、站是停的**那一刻（设计自己点名的危险态）——
      // 文案必须给出**可执行的下一步**（看本机有哪个版本 + 显式传 --image-tag 重跑），
      // 只说「本地没有」等于把凌晨三点的人留在悬崖上（兄弟分支 `:262` 就是这么做的）。
      checks.that(j3.out.includes('docker image ls') && j3.out.includes('--image-tag'),
        '判据 j/⑥（复核 Minor 3）：本地缺镜像的拒绝文案必须给出**怎么做** —— ' +
        '`docker image ls`（看本机有哪个版本）+ 显式传 `--image-tag <本机确实有的版本>` 重跑 —— ' +
        `输出尾部：${tailOut(j3.out)}`);
      const j3Calls = existsSync(j3Log) ? readFileSync(j3Log, 'utf8') : '';
      checks.that(shimCalls(j3Calls, 'docker', 'compose').length === 0,
        `判据 j/⑥：本地缺镜像也必须停在 compose **之前** —— 实际 ${JSON.stringify(shimCalls(j3Calls, 'docker', 'compose'))}`);
      // ⑥⑦ 的**通过**路径：镜像在本地 ⇒ 起栈（命令必须与手册 ④4.1 逐字同形）⇒ ⑦ 冒烟真的发三条 curl。
      // ⚠️ scratch 的 compose 只有一个「起完即退」的服务，冒烟的地址指向必然连不上的地方
      //    ⇒ 断言的是「起栈命令的形态」与「冒烟真的跑了」，**不是**「站是好的」（那要在生产上验）。
      const j4Tag = 'j4tag';
      sh('docker', ['tag', 'redis:7-alpine', `pokergame-${DECOY}:${j4Tag}`]);
      const j4Proj = makeProjDir(s.root, 'proj-j4',
        `name: ${J4_PROJECT}\nservices:\n  noop:\n    image: redis:7-alpine\n    command: ["true"]\n`);
      const j4Log = join(s.root, 'shim-j4.log');
      const j4 = runScript(RESTORE_SH, restoreArgs({
        dest: s.dest, ts: tsA, proj: j4Proj,
        extra: ['--app-services', DECOY, '--image-prefix', 'pokergame', '--image-tag', j4Tag, '--restore-env'],
      }), { BASH_ENV: shim, FTL_SHIM_LOG: j4Log, SMOKE_BUDGET_S: '3' });
      const j4Calls = existsSync(j4Log) ? readFileSync(j4Log, 'utf8') : '';
      const composeCall = shimCalls(j4Calls, 'docker', 'compose')[0];
      if (composeCall === undefined) {
        throw new ConformanceError('判据 j/⑥：镜像校验通过之后**必须真的起栈** —— 实际 compose 调用：' +
          `${JSON.stringify(shimCalls(j4Calls, 'docker', 'compose'))}；输出尾部：${tailOut(j4.out)}`);
      }
      checks.that(/ --env-file /.test(composeCall) && / -f /.test(composeCall) && /(^| )up -d( |$)/.test(composeCall),
        '判据 j/⑥（第二轮 C-2）：起栈命令必须与手册 ④4.1 逐字同形（`--env-file` + `-f` + `up -d`）—— ' +
        '⛔ 绝不能是裸 `docker compose up -d`（那会去找服务器上不存在的 `pokergame-*:latest`）—— ' +
        `实际 ${JSON.stringify(composeCall)}`);
      checks.that(composeCall.includes('proj-j4') && composeCall.includes('docker-compose.yml'),
        `判据 j/⑥：compose 必须操作 \`--compose-file\` 指向的那个栈 —— 实际 ${JSON.stringify(composeCall)}`);
      checks.that(composeCall.includes('IMAGE_PREFIX=pokergame') && composeCall.includes(`IMAGE_TAG=${j4Tag}`),
        '判据 j/⑥：compose 进程里必须**已经 export 好** IMAGE_PREFIX/IMAGE_TAG（少了它们，compose 会去' +
        `找 \`pokergame-*:latest\`）—— 实际 ${JSON.stringify(composeCall)}`);
      const j4Curls = shimCalls(j4Calls, 'curl').join('\n');
      checks.that(shimCalls(j4Calls, 'curl').length >= 3,
        `判据 j/⑦：冒烟必须**真的发出三条 curl**（不许有跳过它的后门）—— 实际 ${JSON.stringify(shimCalls(j4Calls, 'curl'))}`);
      checks.that(/\/api\/health/.test(j4Curls) && /socket\.io/.test(j4Curls) && /127\.0\.0\.1:1/.test(j4Curls),
        '判据 j/⑦：三条必须是 health / 首页 / socket.io，且**打在恢复后的 .env 里的 SITE_ADDRESS 上**' +
        `（说明它读的是恢复出来的那份配置）—— 实际 ${JSON.stringify(j4Curls)}`);
      checks.that(typeof j4.status === 'number' && j4.status !== 0,
        '判据 j/⑦：冒烟没过（scratch 里没有真的站）⇒ 恢复必须**非零退出**（数据恢复了，但「站对外是好的」' +
        `没被证明 ⇒ 不许静默）—— status=${JSON.stringify(j4.status)}；输出尾部：${tailOut(j4.out)}`);
      checks.that(/冒烟/.test(j4.out),
        `判据 j/⑦：非零退出的理由必须点名冒烟 —— 输出尾部：${tailOut(j4.out)}`);
    } finally {
      // ⚠️ 本任务起过的东西必须**每条退出路径**都收掉（硬杀时 `finally` 不跑 ⇒ 由下一轮的
      //    `reapDeadRuns()` 收 —— 它按 `c75b-<pid>-…` 里的 pid 判活，实测有效）。
      shTry('docker', ['rm', '-f', DECOY]);
      shTry('docker', ['rm', '-f', DECOY_EDGE]);
      shTry('docker', ['rm', '-f', `${J4_PROJECT}-noop-1`]);
      shTry('docker', ['rmi', `pokergame-${DECOY}:j4tag`]);
      // 🔴 **网络**（第三轮复核 Important）：判据 j4 的 `docker compose up -d` 会在宿主上建一个
      //    bridge 网络 `<project>_default` —— 只删容器不删它 ⇒ **每跑一次本片就净占一个 172.x/16**。
      //    实测：连跑 8 次之后宿主上 172.18–172.25 全被这样的网络占住，之后**任何**
      //    `docker compose up`（本栈钉死 `172.28.0.0/16`、恢复路径自己的 ⑥、开发栈）都会
      //    `Pool overlaps with other one on this address space` —— 红点长在**别的工具**里，
      //    没人会想到根因是这一片。设计 §4.3 ②「不新建网络」正是冲这类事故来的 ⇒ 收尾与容器同级。
      // ⚠️ 网络上有活动 endpoint 时 `network rm` 会失败 ⇒ 先按 compose 的 project 标签把容器兜一遍
      //    （起栈半途失败时容器名未必是 `-noop-1`），再删网络。
      const j4Ids = shTryOut('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${J4_PROJECT}`])
        .split(/\s+/).filter((x) => x !== '');
      for (const id of j4Ids) shTry('docker', ['rm', '-f', id]);
      shTry('docker', ['network', 'rm', `${J4_PROJECT}_default`]);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Task 4：`install-cron.sh` —— 判据 k（设计 §5 / §6.1-k）
    //
    // `crontab -l` 会以**两种完全不同的方式**失败，把它们混为一谈的写法
    // （`crontab -l 2>/dev/null | … | crontab -`）会用我们那一行**覆盖掉整个 crontab**
    // —— 正是设计 I-4 点名要杀的「静默」形态。本段钉三件事：连跑两次恰好一行 ·
    // 别人的行原样还在（包括第二次）· 真故障 ⇒ 红且 crontab **一字未动**。
    //
    // 被测脚本**永不碰真 crontab**：`CRONTAB_CMD` 是它自己留的注入点，这里指向替身
    // （它若忽略注入点去调真的 `crontab`：本机没有那个命令 ⇒ 响亮红，不会静默碰到谁的真 crontab）。
    // ══════════════════════════════════════════════════════════════════════════
    step('判据 k：install-cron.sh —— 连跑两次恰好一行 · 别人的行原样还在 · 真故障 ⇒ 红且一字未动');
    const kStub = stubCrontab(join(s.root, 'cron-bin'));
    const kEmpty = cronWorld(s.root, 'cron-state-empty', kStub);

    // ① 空态：「没有 crontab」是**良性**失败 ⇒ 照常安装；连跑两次恰好一行。
    //    先自证替身在空态**真的以失败作答**（非零 + no crontab）—— 若它是 exit 0 + 空输出蒙混，
    //    下面那次安装就没走「容忍」分支，「容忍」与「不容忍」也就分不开了（前半判据是空测）。
    const kProbe = kEmpty.stubList();
    checks.that(kProbe.status !== 0 && /no crontab/i.test(kProbe.out),
      '判据 k：替身在空态必须像真 crontab 那样**失败**（非零 + stderr 说 no crontab）—— 若它是 ' +
      'exit 0 + 空输出蒙混，下面那次安装根本没走「容忍」那条分支 ⇒ 这条判据的前半是空测 —— ' +
      `实际 status=${JSON.stringify(kProbe.status)}，输出=${JSON.stringify(tailOut(kProbe.out))}`);
    const k1 = kEmpty.run();
    checks.eq(k1.status, 0,
      `判据 k：**没有 crontab** 是良性失败 ⇒ 必须照常安装（不许把它当成故障退出）—— 输出尾部：${tailOut(k1.out)}`);
    checks.eq(kEmpty.marker().length, 1,
      `判据 k：安装后必须**恰好一行**带 ${CRON_MARKER} 标记 —— 实际 ${JSON.stringify(kEmpty.marker())}`);
    checks.eq(kEmpty.marker()[0], CRON_LINE,
      '判据 k：那一行必须与期望的定时行**逐字相同**（绝对路径 —— 用户 crontab 的 PATH 只有 ' +
      '/usr/bin:/bin，裸命令名/相对路径都会在凌晨三点失败）');
    checks.that(kEmpty.others().length === 0,
      `判据 k：空态安装出来的 crontab 里只许有我们那一行（不许夹带别的）—— 实际 ${JSON.stringify(kEmpty.lines())}`);
    const k1Text = kEmpty.text();
    const k2 = kEmpty.run();
    checks.eq(k2.status, 0, `判据 k：第二次运行必须照常成功（幂等 ≠ 第二次报错）—— 输出尾部：${tailOut(k2.out)}`);
    checks.eq(kEmpty.marker().length, 1,
      `判据 k：**连跑两次**之后仍必须恰好一行（幂等的全部要害：第二次不许再加一行）—— 实际 ${JSON.stringify(kEmpty.marker())}`);
    checks.eq(kEmpty.text(), k1Text,
      '判据 k：第二次运行不得改动 crontab 的任何字节（恰好一行 + 字节相等 = 真幂等）');

    // ② 别人的行：预置三行（含一条真正的定时行与一条注释）⇒ 必须**逐字还在**，第二次之后也是。
    const kOther = cronWorld(s.root, 'cron-state-others', kStub);
    const OTHERS = [
      '# 别人的注释行：不许动',
      '*/5 * * * * /home/ubuntu/keepme.sh >> /home/ubuntu/keepme.log 2>&1',
      'MAILTO=ops@example.com',
    ];
    kOther.seed(OTHERS);
    const o1 = kOther.run();
    checks.eq(o1.status, 0, `判据 k（别人的行）：必须成功安装 —— 输出尾部：${tailOut(o1.out)}`);
    checks.that(sameLineMultiset(kOther.others(), OTHERS),
      '判据 k（别人的行）：预置的行必须**逐字还在**（不多、不少、不改写）—— ' +
      `期望 ${JSON.stringify(OTHERS)}，实得 ${JSON.stringify(kOther.others())}`);
    checks.eq(kOther.marker().length, 1,
      `判据 k（别人的行）：恰好一行带标记 —— 实际 ${JSON.stringify(kOther.marker())}`);
    checks.eq(kOther.marker()[0], CRON_LINE, '判据 k（别人的行）：那一行必须与期望的定时行逐字相同');
    const o1Text = kOther.text();
    const o2 = kOther.run();
    checks.eq(o2.status, 0, `判据 k（别人的行）：第二次运行也必须成功 —— 输出尾部：${tailOut(o2.out)}`);
    checks.that(sameLineMultiset(kOther.others(), OTHERS),
      '判据 k（别人的行）：**第二次之后**别人的行仍必须逐字还在（brief 明文「包括第二次」）—— ' +
      `期望 ${JSON.stringify(OTHERS)}，实得 ${JSON.stringify(kOther.others())}`);
    checks.eq(kOther.marker().length, 1,
      `判据 k（别人的行）：第二次之后仍恰好一行 —— 实际 ${JSON.stringify(kOther.marker())}`);
    checks.eq(kOther.text(), o1Text, '判据 k（别人的行）：非空 crontab 上的第二次运行也必须零字节改动');

    // ③ 真故障：`crontab -l` 报的是**别的**失败 ⇒ 响亮红，且 crontab **一字未动**。
    //    ⚠️ 承重的是「一字未动」那条（**不是**退出码）：一个「先覆盖、后失败」的脚本退出码也是
    //    非零 —— 下面那个变异体就是这种形态，它证明这条断言真的有牙。
    const kFail = cronWorld(s.root, 'cron-state-fail', kStub);
    kFail.seed(OTHERS);        // 别人的行要在场：这条判据考的就是「别毁掉别人的东西」
    kFail.failOther();
    const fProbe = kFail.stubList();
    checks.that(fProbe.status !== 0 && !/no crontab/i.test(fProbe.out),
      '判据 k：替身的「另一种失败」必须非零且**不含** no crontab 字样 —— 若它含，被测脚本的正确' +
      `行为就成了「继续安装」，这条判据测反了 —— 实际 status=${JSON.stringify(fProbe.status)}，` +
      `输出=${JSON.stringify(tailOut(fProbe.out))}`);
    const fBefore = kFail.text();
    const fReal = kFail.run();
    checks.that(typeof fReal.status === 'number' && fReal.status !== 0,
      '判据 k：`crontab -l` 的**真故障**必须让安装**响亮失败**（不许当成「没有 crontab」继续）—— ' +
      `status=${JSON.stringify(fReal.status)}；输出尾部：${tailOut(fReal.out)}`);
    checks.that(fReal.out.includes('crontab -l') && fReal.out.includes('Permission denied'),
      '判据 k：失败文案必须点名**哪条命令**失败了、并把底层错误原文带出来（否则读者分不清这是' +
      `「这台机器还没有 crontab」还是真故障）—— 输出尾部：${tailOut(fReal.out)}`);
    checks.eq(kFail.text(), fBefore,
      '判据 k（承重）：真故障下 crontab 必须**一字未动** —— 这一条才是「2>/dev/null 吞掉一切」' +
      '那个形态的杀手（吞掉之后 `crontab -l` 输出为空 ⇒ 整个 crontab 被我们那一行覆盖）');
    // 负对照（本仓惯例：判据的判别力要**当场自证**）：同一个状态上跑一个「朴素实现」——
    // 吞掉 stderr、照写不误（设计 I-4 逐字点名的形态）。它退出码**也是非零**（pipefail 把
    // `crontab -l` 的失败带了出来），却**真的**把 crontab 覆盖掉了 ⇒ 「只查退出码」抓不住它。
    const mutPath = join(s.root, 'naive-install.sh');
    writeFileSync(mutPath, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '# 朴素实现（判据 k 的负对照，由切片生成；不进仓库、不进交付物）：吞掉 crontab -l 的一切失败，照写不误。',
      '"$CRONTAB_CMD" -l 2>/dev/null | grep -v "# ftl-backup" | sed "/^$/d" | "$CRONTAB_CMD" -',
      '',
    ].join('\n'));
    const mut = runScript(mutPath, [], kFail.env);
    checks.that(typeof mut.status === 'number' && mut.status !== 0,
      '判据 k 负对照：朴素实现这一次**也是非零退出**（pipefail 把 crontab -l 的失败带了出来）—— ' +
      `正是它让「只查退出码」看起来是对的 —— status=${JSON.stringify(mut.status)}；输出尾部：${tailOut(mut.out)}`);
    checks.that(kFail.text() !== fBefore,
      '判据 k 负对照：同一个状态上，朴素实现**真的把 crontab 覆盖了**（毁成了 ' +
      `${JSON.stringify(kFail.text())}）—— ⇒ 抓得住它的是上面那条「一字未动」，不是退出码`);

    // ══════════════════════════════════════════════════════════════════════════
    // Task 5：`check-backup-fresh.sh` —— 判据 h（设计 §4.4 / §6.1-h）
    //
    // 本片最靠外的一条链：它是「备份停了」目前**唯一**的自动信号（监控是另一片）。它跑在
    // runner 上、ssh 出去读服务器上的备份目录 ⇒ 判据**永不碰真服务器**：`ssh` 替身接到
    // **同样的 argv** 后本地执行同一条命令串（照判据 k 的 `CRONTAB_CMD` 先例），目标目录由
    // `BACKUP_DEST` 注入 ⇒ 被换掉的只有「谁来执行」与「读哪个目录」，命令串本身逐字相同。
    //
    // 🔴 前瞻风险专条（Task 2 评审 Minor 6）：预检/锁那两条失败路径**不写 manifest**（只写
    //    backup.log）⇒ 纯 manifest 判活会在盘满这类**持续性**故障的头 3 小时里保持绿。判据 h
    //    的 ⑥ 用**真 backup.sh** 造出那个形态（同一目录里：新鲜的 ok manifest + 真预检失败的
    //    日志）并断言闸**当场红**、且把失败原话贴给读者。
    // ══════════════════════════════════════════════════════════════════════════
    step('判据 h：备份新鲜度闸 —— 绿 / 太旧 / 只有 ok:false / 一个都没有 / 最后一次失败 / ssh 够不到（文案可分辨）');
    const hStub = sshStub(join(s.root, 'h-bin'));
    const hHost = 'probe.invalid';
    const hKey = posixPath(join(s.root, 'h-probe.key'));
    // ⚠️ 每个「替身写、断言读」的日志都要**两副面孔**：交给 bash 的用 `posixPath`（MSYS 才认得），
    //    Node 自己去读的用宿主形态 —— `posixPath` 出来的 `/c/…` 在 Node 眼里是 `C:\c\…`（本机实测：
    //    `existsSync('/c/Users/…') = false`，而替身那边**写成功了**）⇒ 只留一副面孔时断言会读到空文件。
    const hLog = posixPath(join(s.root, 'h-ssh.log'));                  // 替身的 argv 记录（多数跑共用；只写不读）
    const hLogGreenWin = join(s.root, 'h-ssh-green.log');               // 绿那次单独一份（Node 侧读它）
    const hLogGreen = posixPath(hLogGreenWin);                          // 交给 bash 的形态
    /** 一次闸运行**必须红**：非零退出（`null` = 进程没起来 —— 也算失败，但消息里打得出区别）。 */
    const gateRed = (r: { status: number | null }): boolean => r.status !== null && r.status !== 0;
    /** 跑一次被测闸：两个注入点 + 一个「显式摘掉某变量」开关（环境里恰好有同名变量时不许误绿）。 */
    const gate = (o: { dest?: string; mode?: string; log?: string; unset?: string[] } = {}):
    { status: number | null; out: string } => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        SSH_CMD: hStub, SSH_HOST: hHost, SSH_KEY: hKey, FTL_SSH_LOG: o.log ?? hLog,
      };
      if (o.dest !== undefined) env.BACKUP_DEST = posixPath(o.dest);
      if (o.mode !== undefined) env.FTL_SSH_MODE = o.mode;
      for (const k of o.unset ?? []) delete env[k];
      return runScript(CHECK_BACKUP_FRESH, [], env);
    };

    // ① 替身自证（照判据 k 的替身先例）：它必须**真跑**命令、**真带出**退出码与 stdout ——
    //    否则后面所有绿都是空测（一个 exit 0 的哑替身会让任何闸看起来都对）。
    const hSelfLog = join(s.root, 'h-stub-self.log');
    const stubRun = (cmd: string): { status: number | null; out: string } =>
      runScript(hStub, ['-i', 'k', '-o', 'X', `ubuntu@${hHost}`, cmd], { FTL_SSH_LOG: posixPath(hSelfLog) });
    const hs1 = stubRun('printf hi; exit 7');
    checks.eq(hs1.status, 7,
      `判据 h：替身必须把远端命令的退出码原样带出（否则「闸红了」可能只是替身在红）—— 输出尾部：${tailOut(hs1.out, 2)}`);
    checks.eq(hs1.out.trim(), 'hi', '判据 h：替身必须把 stdout 原样带出（远端命令的输出就是闸读的那些行）');

    // ② 绿：**真 backup.sh** 刚做出来的一整套（同一小时 ⇒ 年龄 0）⇒ 闸必须绿，且自报年龄与产物齐。
    const hGreen = join(s.root, 'h-green');
    mkdirSync(hGreen, { recursive: true });
    const hReal = runBackupRaw(s, hGreen);
    checks.eq(hReal.status, 0, `判据 h：绿样本必须来自一次**真的**成功备份 —— 日志尾部：${tail(hReal.log)}`);
    const hTs = manifestTs(hGreen);
    if (hTs === null) throw new ConformanceError('判据 h：真备份成功后 h-green 里没有 manifest ⇒ 后面的「做旧 / 缺产物」样本构造不出来');
    const hGreenRun = gate({ dest: hGreen, log: hLogGreen });
    checks.eq(hGreenRun.status, 0,
      `判据 h：真备份刚做完（同一小时）⇒ 闸必须绿 —— status=${JSON.stringify(hGreenRun.status)}；` +
      `输出尾部：${tailOut(hGreenRun.out, 4)}`);
    checks.that(/✅ 备份新鲜度/.test(hGreenRun.out) && /\d+ 小时前/.test(hGreenRun.out)
      && hGreenRun.out.includes('产物齐'),
      '判据 h：绿行必须自报「多久前成功过」与「三件产物齐」（否则这个绿什么也没证明）—— ' +
      `输出尾部：${tailOut(hGreenRun.out, 4)}`);

    // ③ ssh 形态（注入点的**保真度**断言）：闸必须按 ssh 的形态调替身 —— `-i <私钥>`、两个 `-o`、
    //    `ubuntu@<host>`。少任何一项，本段的绿就**不能**代表生产的绿（例：少了 ConnectTimeout，
    //    生产上会一路挂到 job 超时 —— 那时闸既没红也没绿）。
    const hGreenCalls = existsSync(hLogGreenWin) ? readFileSync(hLogGreenWin, 'utf8') : '';
    const hArgLines = hGreenCalls.split('\n');
    checks.that(hArgLines.includes('ssh') && hArgLines.includes(hKey),
      '判据 h：闸必须真的**经由 ssh 替身**（argv 里有 `-i <SSH_KEY>`）—— 否则本判据在测一条生产不存在的' +
      `路径 —— 实得 argv 前 8 行：${JSON.stringify(hArgLines.slice(0, 8))}`);
    checks.that(hArgLines.includes('ConnectTimeout=15') && hArgLines.includes('StrictHostKeyChecking=accept-new')
      && hArgLines.includes(`ubuntu@${hHost}`),
      '判据 h：ssh 的 argv 必须与部署同形（`-o ConnectTimeout=15` / `-o StrictHostKeyChecking=accept-new` / ' +
      `ubuntu@<host>）—— 实得前 8 行：${JSON.stringify(hArgLines.slice(0, 8))}`);

    // ④ 注入点**不许**改掉生产默认：不设 `BACKUP_DEST` 时，探测必须打在生产路径上。
    //    ⚠️ 只断言命令串（性质），**不**断言这一次的结论 —— 那台机器上这个目录存不存在是
    //    **平台现象**（本仓纪律：判据测性质，不测平台现象）。
    const hDefLogWin = join(s.root, 'h-ssh-default.log');
    gate({ log: posixPath(hDefLogWin), unset: ['BACKUP_DEST'] });
    const hDefCalls = existsSync(hDefLogWin) ? readFileSync(hDefLogWin, 'utf8') : '';
    checks.that(hDefCalls.includes('/home/ubuntu/ftl-backups/manifest-'),
      '判据 h：不设 BACKUP_DEST 时探测必须打在生产路径 `/home/ubuntu/ftl-backups` 上（注入点不许改掉默认）—— ' +
      `实得：${JSON.stringify(hDefCalls.split('\n').slice(0, 6))}`);

    // ⑤ 一个 manifest 都没有 ⇒ 红，且只打「从未成功过」这一句。
    const hEmpty = join(s.root, 'h-empty');
    mkdirSync(hEmpty, { recursive: true });
    const hEmptyRun = gate({ dest: hEmpty });
    checks.that(gateRed(hEmptyRun) && redIsDistinct(hEmptyRun.out, H_RED_NEVER, otherReds(H_RED_NEVER)),
      '判据 h：一个 manifest 都没有 ⇒ 必须红，且只说「从未成功过」（别的红的话一句都不许出现 —— ' +
      `两条红不可分辨时，凌晨三点的人分不出该重装还是该去看日志）—— status=${JSON.stringify(hEmptyRun.status)}；` +
      `输出：${tailOut(hEmptyRun.out, 4)}`);

    // ⑥ 只有 ok:false ⇒ 红，且只说「最近几次全失败」（**不许**把 ok:false 当成活着的证据：
    //    `grep -l 'ok'` 那种实现会在这里绿）。
    const hFalse = join(s.root, 'h-falseonly');
    mkdirSync(hFalse, { recursive: true });
    plantHourSet(hFalse, utcHourTs(0), false);
    plantHourSet(hFalse, utcHourTsAgo(1), false);
    const hFalseRun = gate({ dest: hFalse });
    checks.that(gateRed(hFalseRun) && redIsDistinct(hFalseRun.out, H_RED_NOOK, otherReds(H_RED_NOOK)),
      '判据 h：只有 ok:false ⇒ 必须红，且只说「最近几次全失败」（把 ok:false 读成「有 manifest ⇒ 活着」' +
      `是这一条的杀手）—— status=${JSON.stringify(hFalseRun.status)}；输出：${tailOut(hFalseRun.out, 4)}`);

    // ⑦ 太旧 ⇒ 红；1 小时前 ⇒ 仍绿（新鲜 ≠ 「任何非零年龄」）。样本 = **真备份**改个名字（做旧）。
    //    ⚠️ 这两个目录里**没有 backup.log** ⇒ 顺带钉住「日志不在 ⇒ 不许红」（manifest 那条链的
    //    证据更强；把「没有日志」当成「备份坏了」会在任何一次日志轮转事故里假红）。
    const hAge1 = join(s.root, 'h-age1h');
    copySetAs(hGreen, hTs, hAge1, utcHourTsAgo(1));
    checks.that(!existsSync(join(hAge1, 'backup.log')),
      '判据 h 前提：做旧样本里必须没有 backup.log（否则上面那条「日志不在也不许红」是空测）');
    const hAge1Run = gate({ dest: hAge1 });
    checks.eq(hAge1Run.status, 0,
      `判据 h：1 小时前的成功备份必须是**绿**（阈值 3h；任何非零年龄就红 = 把容错窗口压成 0）—— ` +
      `status=${JSON.stringify(hAge1Run.status)}；输出尾部：${tailOut(hAge1Run.out, 4)}`);
    const hAge3 = join(s.root, 'h-age3h');
    copySetAs(hGreen, hTs, hAge3, utcHourTsAgo(3));
    const hAge3Run = gate({ dest: hAge3 });
    checks.that(gateRed(hAge3Run) && redIsDistinct(hAge3Run.out, H_RED_STALE, otherReds(H_RED_STALE)),
      '判据 h：3 小时前（**正好在阈值上**）⇒ 必须红 —— 脚本那一侧是 `-ge`，`-gt` 的实现在这里会绿 —— ' +
      `status=${JSON.stringify(hAge3Run.status)}；输出：${tailOut(hAge3Run.out, 4)}`);
    const hAge4 = join(s.root, 'h-age4h');
    copySetAs(hGreen, hTs, hAge4, utcHourTsAgo(4));
    const hAge4Run = gate({ dest: hAge4 });
    checks.that(gateRed(hAge4Run) && redIsDistinct(hAge4Run.out, H_RED_STALE, otherReds(H_RED_STALE)),
      '判据 h：4 小时前的成功备份 ⇒ 必须红且只说「备份停了」—— ' +
      `status=${JSON.stringify(hAge4Run.status)}；输出：${tailOut(hAge4Run.out, 4)}`);
    checks.that(hAge4Run.out.includes('别回滚'),
      '判据 h（设计 §6.4 / I-1）：这一条必须自带「站是好的，别回滚」—— 它跑在 deploy **之后**，' +
      `被读成「部署坏了 ⇒ 回滚」就是把刚发上去的好版本撤下来 —— 输出：${tailOut(hAge4Run.out, 4)}`);

    // ⑧ 「锁竞争」不是备份失败（设计 §5：那说明另一次备份正在跑）⇒ 最后一条是它时**不许**红；
    //    但它**救不了**已经停掉的链（下一条：同样的豁免 + 4 小时前的 ok ⇒ 仍红，年龄那条兜底）。
    const hLock = join(s.root, 'h-locklog');
    copySetAs(hGreen, hTs, hLock, utcHourTsAgo(1));
    writeFileSync(join(hLock, 'backup.log'), lockFailureLine());
    const hLockRun = gate({ dest: hLock });
    checks.eq(hLockRun.status, 0,
      '判据 h：最后一次是**锁竞争**（拿不到锁 = 另一次备份正在跑，设计 §5 明写它不红）⇒ 必须仍绿 —— ' +
      `status=${JSON.stringify(hLockRun.status)}；输出尾部：${tailOut(hLockRun.out, 4)}`);
    const hStaleLock = join(s.root, 'h-stale-locklog');
    copySetAs(hGreen, hTs, hStaleLock, utcHourTsAgo(4));
    writeFileSync(join(hStaleLock, 'backup.log'), lockFailureLine());
    const hStaleLockRun = gate({ dest: hStaleLock });
    checks.that(gateRed(hStaleLockRun) && hStaleLockRun.out.includes(H_RED_STALE),
      '判据 h：锁竞争的豁免**不许**把一条停掉的链救活（4 小时前的 ok + 最后一条是「拿不到锁」⇒ 仍红）—— ' +
      `锁被僵尸长期占住时「最后一次永远是拿不到锁」，那时只有年龄那条兜底 —— status=${JSON.stringify(hStaleLockRun.status)}；` +
      `输出：${tailOut(hStaleLockRun.out, 4)}`);

    // ⑨ 前瞻风险专条（Task 2 评审 Minor 6）——**真 backup.sh** 造出的形态：
    //    先在 h-green 里跑一次**真成功**（② 已做：新鲜的 ok manifest），再跑一次**真预检失败**
    //    （`--min-free-mb` 顶到天上，判据 g 同款注入；盘满就是这个形态）。
    //    此刻目录里：manifest 那条链**全绿**（新鲜的 ok + 三件产物齐）—— 只有 backup.log 知道
    //    备份已经坏了。闸必须**当场红**并贴出失败原话。
    const hPre = runBackupRaw(s, hGreen, ['--min-free-mb', '999999999']);
    checks.that(gateRed(hPre) && hPre.log.includes('可用空间'),
      '判据 h 前提：预检失败那一次必须真的非零退出、且日志里写「可用空间」（否则下面测的不是预检失败）—— ' +
      `status=${JSON.stringify(hPre.status)}；日志尾部：${tail(hPre.log)}`);
    const hPreRun = gate({ dest: hGreen });
    checks.that(gateRed(hPreRun) && redIsDistinct(hPreRun.out, H_RED_LASTFAIL, otherReds(H_RED_LASTFAIL)),
      '判据 h（前瞻风险）：**最新的 ok manifest 还是新鲜的**（刚成功过）而最后一次跑完是失败的 ⇒ 闸必须' +
      '**当场红**（纯 manifest 判活的实现在这里会绿 —— 盘满后头 3 小时它什么也看不见）—— ' +
      `status=${JSON.stringify(hPreRun.status)}；输出：${tailOut(hPreRun.out, 4)}`);
    checks.that(hPreRun.out.includes('可用空间'),
      '判据 h：这一类红的文案必须把**失败原话**贴出来（凌晨三点的人第一眼要看的就是「盘满」两个字，' +
      `不是让他自己去 ssh 翻日志）—— 输出：${tailOut(hPreRun.out, 4)}`);
    checks.that(hPreRun.out.includes('别回滚'),
      `判据 h：这一条同样要自带「别回滚」（它跑在 deploy 之后）—— 输出：${tailOut(hPreRun.out, 4)}`);
    // ⑨b 自愈：失败之后**又成功了一次** ⇒ 必须回到绿（只看**最后一次**，不数历史失败 ——
    //    否则任何一次历史失败都会把闸永久钉红，那是**假红机器**）。
    const hHeal = runBackupRaw(s, hGreen);
    checks.eq(hHeal.status, 0, `判据 h 前提：第三次真备份必须成功 —— 日志尾部：${tail(hHeal.log)}`);
    const hHealRun = gate({ dest: hGreen });
    checks.eq(hHealRun.status, 0,
      '判据 h：失败之后又成功了一次 ⇒ 必须回到绿（数历史失败 / 只看「有没有出现过 FAILED」的实现' +
      `在这里会红 —— 那会让每一次历史失败都把闸钉死）—— status=${JSON.stringify(hHealRun.status)}；` +
      `输出尾部：${tailOut(hHealRun.out, 4)}`);

    // ⑩ 缺一件产物 ⇒ 红，且**点名**缺的那件（「不全」两个字在凌晨三点没有用）。
    //    ✅ 这是设计 §4.4 的原话：「新鲜」= 存在一个**可恢复的集合**，不只是一个近期时间戳。
    //    ⚠️ 删产物**在副本里**做（`h-green` 原样留着）：本段后面的判据还要从它复制出一整套，
    //       就地删会让那些**构造前提**炸掉（本仓的纪律：别让一个判据的副作用改掉另一个的样本）。
    const hArt = join(s.root, 'h-artifacts');
    copySetAs(hGreen, hTs, hArt, hTs);
    const hMissing = productFile(hTs, 'users');
    rmSync(join(hArt, hMissing));
    const hArtRun = gate({ dest: hArt });
    checks.that(gateRed(hArtRun) && redIsDistinct(hArtRun.out, H_RED_ARTIFACTS, otherReds(H_RED_ARTIFACTS))
      && hArtRun.out.includes(hMissing),
      `判据 h：最新 ok manifest 的产物缺一件（${hMissing}）⇒ 必须红、且点名缺的是哪一件 —— ` +
      `status=${JSON.stringify(hArtRun.status)}；输出：${tailOut(hArtRun.out, 4)}`);

    // ⑪ `restore-` 前缀的**现场备份**不是小时链的证据：一次事故恢复会把它写得很新鲜 —— 若它被
    //    当成「最新一个 ok」，一条已经停掉的小时链就会被一次**恢复**喂绿（它恰恰发生在事故里）。
    //    构造 = 真备份改名做旧（4h）+ 一份**新鲜**的 `manifest-restore-<ts>.json` 四件套。
    const hShield = join(s.root, 'h-restore-shield');
    copySetAs(hGreen, hTs, hShield, utcHourTsAgo(4));
    plantHourSet(hShield, `restore-${utcHourTs(0)}`, true);
    const hShieldRun = gate({ dest: hShield });
    checks.that(gateRed(hShieldRun) && redIsDistinct(hShieldRun.out, H_RED_STALE, otherReds(H_RED_STALE)),
      '判据 h：restore- 前缀的现场备份不许被当成小时链的证据（4 小时前的小时链 + 刚刚的现场备份 ' +
      `⇒ 仍必须报「备份停了」，而不是被那份新鲜的喂绿）—— status=${JSON.stringify(hShieldRun.status)}；` +
      `输出：${tailOut(hShieldRun.out, 4)}`);

    // ⑫ ssh 够不到 ⇒ 红，且**不许**说「备份从未成功过」（那是误诊：网络断了不等于备份死了，
    //    两条路一个修网络一个修备份）。`FTL_SSH_MODE=off` = 替身一律 exit 255（真 ssh 的连接失败码）。
    const hOffRun = gate({ dest: hGreen, mode: 'off' });
    checks.that(gateRed(hOffRun) && redIsDistinct(hOffRun.out, H_RED_SSH, otherReds(H_RED_SSH)),
      '判据 h：ssh 拿不到回答 ⇒ 必须红，且只说「够不到服务器」（报成「备份从未成功过」会把凌晨三点' +
      `的人指向错误的方向）—— status=${JSON.stringify(hOffRun.status)}；输出：${tailOut(hOffRun.out, 4)}`);
    // ⑫b 远端算不出年龄（名字形态不认识）⇒ 必须红：`[ "垃圾" -ge 3 ]` 在 bash 里**不是**错误、
    //     而是**假** —— 没有这条守卫时，闸会带着垃圾年龄**打绿行**（fail-open）。
    const hBadAgeRun = gate({ dest: hAge1, mode: 'badage' });
    checks.that(gateRed(hBadAgeRun) && hBadAgeRun.out.includes(H_RED_AGE) && !hBadAgeRun.out.includes('✅ 备份新鲜度'),
      '判据 h：远端返回的年龄不可解析 ⇒ 必须红（`[ 垃圾 -ge 3 ]` 在 bash 里是「假」不是错误 ⇒ 没有' +
      `这条守卫时闸会带着垃圾年龄打**绿行**）—— status=${JSON.stringify(hBadAgeRun.status)}；` +
      `输出：${tailOut(hBadAgeRun.out, 4)}`);

    // ⑬ 锁豁免的**措辞同源**（文本钉子）：豁免靠 backup.sh 那句日志里的「拿不到锁」—— 改任一侧
    //    而不同步另一侧，后果是**锁竞争变成假红**（另一次备份正在跑，每次发版都红）。
    //    这条钉子让那种改动**当场**红在这里，而不是三个月后在生产上。
    checks.that(readFileSync(CHECK_BACKUP_FRESH, 'utf8').includes('拿不到锁')
      && backupSrc.includes('FAILED: 拿不到锁'),
      '判据 h：锁竞争豁免的措辞必须与 backup.sh **同源**（两边都写「拿不到锁」）—— 不同步时锁竞争' +
      '会变成假红（另一次备份正在跑 ⇒ 每次发版都红）');

    // ⑭ 环境闸：缺 SSH_HOST / SSH_KEY ⇒ 响亮退（不许拿空主机名去 ssh）。
    const hNoHost = gate({ unset: ['SSH_HOST'] });
    checks.that(gateRed(hNoHost) && hNoHost.out.includes('SSH_HOST'),
      `判据 h：缺 SSH_HOST ⇒ 必须非零退出并点名它 —— status=${JSON.stringify(hNoHost.status)}；` +
      `输出尾部：${tailOut(hNoHost.out, 3)}`);
    const hNoKey = gate({ unset: ['SSH_KEY'] });
    checks.that(gateRed(hNoKey) && hNoKey.out.includes('SSH_KEY'),
      `判据 h：缺 SSH_KEY ⇒ 必须非零退出并点名它 —— status=${JSON.stringify(hNoKey.status)}；` +
      `输出尾部：${tailOut(hNoKey.out, 3)}`);

    // ══════════════════════════════════════════════════════════════════════════
    // Task 6：接线面 —— 判据 **i1**（手册引用的旗标 ↔ `restore.sh --help`）与
    // **l**（仓库里没有被跟踪的备份产物）。两条都不需要 scratch 容器。
    // ══════════════════════════════════════════════════════════════════════════
    step('判据 i1：手册「数据没了怎么办」引用的每个旗标都能在 `restore.sh --help` 里找到');
    const section = manualSection(readFileSync(MANUAL, 'utf8'), '## 数据没了怎么办');
    // 前提自证：抽到的必须**真是**那一节 —— 抽空/抽错节时，下面「每个旗标都能找到」是空测。
    checks.that(section.includes('restore.sh') && section.includes('ftl-ops'),
      '判据 i1 前提：按节抽取必须真的抽到「数据没了怎么办」那一节（正文里含 `restore.sh` 的命令行）' +
      `—— 实际 ${section.length} 字符，头部：${JSON.stringify(section.slice(0, 60))}` +
      '（抽不到 ⇒ 下面那条断言在空集合上恒绿）');
    const usage = sh('bash', [RESTORE_SH, '--help']);
    const flags = manualFlags(section);
    // 前提自证②：负对照（`--backup-ts` → `--ts`）**造得出来** —— 那一节必须点名 `--backup-ts`。
    // 少了它，`misspelled` 与 `flags` 就是同一个集合、负对照退化成重跑正断言（恒绿）。
    checks.that(flags.includes('--backup-ts'),
      '判据 i1 前提：那一节必须点名 `--backup-ts`（「恢复错了」那段用它，它是**唯一**要读者填的旗标）' +
      `—— 实际 ${JSON.stringify(flags)}（少了它 ⇒ 下面的错拼负对照造不出来）`);
    checks.atLeast(flags.length, 3,
      `判据 i1：那一节必须真的点名旗标（抽出来 ${flags.length} 个：${JSON.stringify(flags)}）` +
      '—— 下限 3 是**留了余量**的：当前 6 个里只有 `--restore-caddy` / `--restore-env` / `--backup-ts`' +
      ' 是读者要敲的，其余（`--env-file` / `--image-tag` / `--backup-dir`）是行文里顺带提到的；' +
      '低于 3 ⇒ 抽取面塌了 ⇒ 下面那条「每个旗标都能找到」是空测');
    const missing = flagsMissingFromUsage(flags, usage);
    checks.that(missing.length === 0,
      '判据 i1：手册那一节引用的**每一个**旗标都必须能在 `restore.sh --help` 里找到 —— ' +
      `找不到的是 ${JSON.stringify(missing)}（那一节全部 ${JSON.stringify(flags)}）` +
      '（手册是交付物的一部分：读者照抄一条不存在的旗标 ⇒ 凌晨三点卡在那一步，而这正是本片的正中央）');
    // 负对照（设计 §6.1-i1 逐字）：把手册里的 `--backup-ts` 改成 `--ts` ⇒ 同一谓词必须报它找不到。
    // ⚠️ **不能**用「删掉手册里一步」当对照（第三轮 Important 1）：那只会让集合更小、**恒绿**。
    const misspelled = flags.map((f) => (f === '--backup-ts' ? '--ts' : f));
    const negMissing = flagsMissingFromUsage(misspelled, usage);
    checks.that(negMissing.includes('--ts'),
      '判据 i1 负对照：把手册里的 `--backup-ts` 改成 `--ts` ⇒ 同一谓词**必须**判它不在 `--help` 里' +
      `（实际报缺 ${JSON.stringify(negMissing)}）—— 若这条绿了 ⇒ 谓词退化成「包含」或恒真，正断言是空测`);

    step('判据 l：仓库里没有被跟踪的 `*.sql.gz` / `*.tgz`（且忽略规则真的生效）');
    const tracked = sh('git', ['ls-files']).split('\n').map((l) => l.trim()).filter((l) => l !== '');
    checks.atLeast(tracked.length, 50,
      `判据 l：\`git ls-files\` 必须真的扫到东西（实际 ${tracked.length} 个被跟踪文件）` +
      '—— 少了这条，git 抽风/空输出时下面那条「没有产物」会静默变成空测');
    const artifactFiles = tracked.filter((f) => ARTIFACT_SUFFIXES.some((re) => re.test(f)));
    checks.that(artifactFiles.length === 0,
      '判据 l：仓库里**不得有**被跟踪的 `*.sql.gz` / `*.tgz`（备份产物是 16MB 级的二进制：' +
      `误提交一次就永久留在历史里）—— 实际 ${JSON.stringify(artifactFiles)}（共扫过 ${tracked.length} 个被跟踪文件）`);
    // 机械自证（设计 §6.1-l 的配套动作：规则与断言**一起**落地）：`git check-ignore` 走 git 自己的
    // 匹配器 ⇒ 这一条判的是「那两条规则在不在、灵不灵」，而不是「今天恰好没有这种文件」。
    const probeGz = ignoreRuleFor('tools/conformance/probe-ignore.sql.gz');
    const probeTgz = ignoreRuleFor('tools/conformance/probe-ignore.tgz');
    checks.that(probeGz !== null && probeTgz !== null,
      '判据 l：`.gitignore` 必须真的忽略 `*.sql.gz` 与 `*.tgz`（拿 `git check-ignore` 问 git 自己）—— ' +
      `实际 .sql.gz ⇒ ${JSON.stringify(probeGz)}；.tgz ⇒ ${JSON.stringify(probeTgz)}`);
    // 负对照：不匹配那两条规则的路径**必须不**被判成忽略 —— 否则上面那条可能只是「整棵目录树
    // 都被忽略了」，与那两条规则无关（探测路径是合成的，**不落盘**：`check-ignore` 不要求文件存在）。
    // ⚠️ 探测后缀用 `.txt`（第一轮修复轮 M1）：此前用的是 `probe-ignore.sql` —— 一条**未来合法**的
    //    `*.sql` 规则（例如有人把 SQL 快照纳入忽略）会让这条负对照**假红**，而它的文案说的是
    //    「忽略生效与那两条规则无关」⇒ 把凌晨三点的人指向一个根本不存在的问题。`.txt` 与任何
    //    **合理**的忽略规则都不相干（真实规则见 `.gitignore`：产物/日志/临时目录/素材源库）。
    const probeOther = ignoreRuleFor('tools/conformance/probe-ignore.txt');
    checks.that(probeOther === null,
      '判据 l 负对照：探测路径 `probe-ignore.txt`（与任何合理的忽略规则无关）**必须不**被忽略 —— ' +
      `实际 ${JSON.stringify(probeOther)}（若这条红了 ⇒ 上面那条「忽略生效」与那两条规则无关；` +
      '⚠️ 也可能是有人新加了一条会命中 `.txt` 的规则 —— 那时**换探测路径**，别删这条负对照）');

    // ── 收尾断言：跑完**不许**在宿主上留下任何 c75b-* 网络（第三轮复核 Important）──────────────

    // 抓的失败：上面 `finally` 里那句 `docker network rm` 被删 / 被挪出 finally ⇒ 本片**每跑一次**
    //    就在宿主上净留一个 bridge 网络 ⇒ 172.x/16 的池子被逐次吃掉，几次之后连**本栈自己**的
    //    `docker compose up` 都 `Pool overlaps …`（那时红点长在别的工具里，与上面同一条事故链）。
    // 判据是 `leakedRunNetwork`（本 run 的 + 死 run 的）：同机**并发**的活 run 也会建同名形态的
    //    网络 ⇒ 不判它（与 `reapDeadRuns` 同一条纪律，否则并发时假红）。
    const leakedNets = dockerNetworkNames().filter(leakedRunNetwork);
    checks.that(leakedNets.length === 0,
      `收尾：本片跑完不得在宿主上留下任何 c75b-* 网络（本 run 的 ${J4_PROJECT}_default 与死 run 遗留）—— ` +
      `实际 ${JSON.stringify(leakedNets)}`);
    // 负对照（R115）：谓词必须**真的能判**泄漏 —— 三条合成名字自证它既不恒假、也不误伤并发 run。
    checks.that(
      leakedRunNetwork(`${J4_PROJECT}_default`),
      '收尾断言负对照①：本 run 自己那个 compose 网络**必须**被判成泄漏（否则上面那条是空测）—— ' +
      `实测 leakedRunNetwork(${JSON.stringify(`${J4_PROJECT}_default`)}) = ${leakedRunNetwork(`${J4_PROJECT}_default`)}`);
    checks.that(
      leakedRunNetwork('c75b-2147483647-zz-j4stack_default') && !leakedRunNetwork(`c75b-${process.pid}-zz-j4stack_default`),
      '收尾断言负对照②：死 pid 留下的要判成泄漏、**活 pid** 的不许判（后者是同机并发 run 的网络 ⇒ 判它=假红）—— ' +
      `死 ${leakedRunNetwork('c75b-2147483647-zz-j4stack_default')} 活 ${leakedRunNetwork(`c75b-${process.pid}-zz-j4stack_default`)}`);
    checks.that(!leakedRunNetwork('bridge'),
      '收尾断言负对照③：非 c75b-* 的网络一律不许判成泄漏（否则这条断言会在宿主上有 bridge/none 时假红）—— ' +
      `实测 leakedRunNetwork("bridge") = ${leakedRunNetwork('bridge')}`);
  } finally {
    releaseLockHolders();
    s.down();
  }
  // ⚠️ `skipped` 必须原样交出去（`run.ts` 的收尾汇总靠它把「跳过 N 项」写进结论）——
  //    被跳过的断言**绝不**进 `passed`（判据存在 ≠ 判据有效：不能失败的断言不许记成通过）。
  return { passed: checks.passed, skipped: checks.skipped };
}
