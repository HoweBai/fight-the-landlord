/**
 * 切片 7.2 完整片 conformance：**R98 / §A.3 部署闸门**的机械判据。
 *
 * 计划：`docs/superpowers/plans/2026-09-15-slice-07.2-security-hardening.md` Task 7 Step 2。
 * 裁决：R98 / R144 / R145 / R147。
 *
 * §A.3 的直接原因就是这两条：**N4/N7 的关闭只对「不发布下游端口 + 显式配置
 * `INTERNAL_SERVICE_TOKEN`」的部署成立**，而**开发形态**（override 自动合并 —— 修前这些
 * 「反例面」都在唯一一份 `docker-compose.yml` 里）两条都不满足（片⑦ 起是 10 个服务全发布
 * 宿主端口；十一个服务带一个**写在仓库里**的公开默认 token）。因此本片
 * 不是用「更严的单测」来证明安全，而是用**编排的渲染结果 + 服务的启动行为**来证明
 * 「内部面没有交给宿主、默认密钥不存在」。
 *
 * 两条断言，一条结构、一条运行期：
 *   ① `docker compose --env-file <空文件> -f docker-compose.yml config --format json`
 *      ⇒ **只有门口 `edge` 发布宿主端口**（`80/443`；R1203 的端口收敛 —— 原断言「只有 `api-gateway`」
 *      随门口片**替换**为 A1/A2：`api-gateway` 生产形态零发布、退为 `expose: 3000`）；
 *      同一份渲染里再判门口固定地址 == `api-gateway` 的 `TRUST_PROXY`（A5，R1205）；
 *      十一个服务的 `INTERNAL_SERVICE_TOKEN` 渲染为 `""`；
 *      **且 `services.*.volumes` 里没有任何 `bind` 落进 `/app`**（①c：容器不得依赖宿主机产物，
 *      2026-09-23 用户裁决的部署原则 —— 修前 `robot-service` 挂着宿主 `dist`，见 ①c 的注释）。
 *      ⚠️ ①c 的**正对照**在 ②c：同一条谓词必须在**开发形态**上看见那条挂载（否则谓词恒空 = 空测）。
 *   ② 运行期 fail-closed：用**生产形态**跑起一个服务并显式给空 token ⇒ 退出码非 0
 *      且 stderr 含 `INTERNAL_SERVICE_TOKEN is required`；显式给一个值 ⇒ 8 秒内**不退出**
 *      （被本用例的超时以 SIGTERM 杀掉）。这条把「配置为空」与「服务拒绝启动」连成闭环
 *      （R89/R92 的意图延伸到 compose 层）：**宁可起不来，也不要「用仓库里公开的常量」跑起来**。
 *
 * ⚠️ 两处确定性条件（都是实测踩出来的，不是形式主义）：
 *   1. **必须 `--env-file <空文件>`（隔离仓库 `.env`）＋ 从 `env` 里剔除同名变量
 *      （隔离父进程 shell 环境）** —— 后者优先级更高：
 *      任何人在 shell 里 `export INTERNAL_SERVICE_TOKEN=...` 过，R98 的「生产形态 token
 *      为空」就会红得莫名其妙（那是判据本身不确定，不是缺陷）。R147 只写了前半条。
 *      ⚠️ 门口片把剔除清单扩到 `ISOLATED_KEYS`（A8：`INTERNAL_SERVICE_TOKEN` 之外再加 7 个）：
 *      `SITE_ADDRESS` / `TLS_MODE` / `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` / `TRUST_PROXY` /
 *      `IMAGE_PREFIX` / `IMAGE_TAG`（后两项是 A11/R1303 的镜像命名输入）
 *      —— 判别力自证在 ①j（故意注入）。
 *      ⚠️ 空文件由 `withEmptyEnvFile` 运行时生成，**不写 `/dev/null`** —— 后者在 Windows 上被解析成 `D:\dev\null`。
 *   2. **必须显式 `-f docker-compose.yml`**：不带 `-f` 时 Compose 自动合并
 *      `docker-compose.override.yml`（开发形态），token 就有默认值了 ⇒ 负对照失效。
 *
 * ⚠️ 运行期探针的两条约束：`--no-deps`（否则会连带把 redis/mysql 拉起来）与
 * **超时**（否则「成功启动」会让用例**永久挂住**）。超时用 `spawnSync` 的**原生**
 * `timeout` 选项，**不用 POSIX `timeout` 命令**（后者是 POSIX 专有工具，Windows 上
 * **能否解析、解析到哪个由 PATH 顺序决定** —— 本机实测 `where timeout` 同时命中 Git 自带的
 * coreutils 与 `C:\Windows\System32\timeout.exe`，前者语义正确、后者是交互式等待命令）
 * —— 而 `execFileSync` 直接跑不退出，永远不返回。
 *
 * 修前（master）预期：第 ① 步就在第一个断言上红 ——
 *   `生产形态**只有** api-gateway 发布宿主端口（实际 api-gateway, douzero, game-service,
 *    mysql, redis, robot-service, room-service, user-service）`。
 * （门口片 R1203 之后，第一条断言换成「**只有**门口（edge）发布宿主端口」。）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠️ **第 ⑤ 步（`health`，独立小片 P5 / Task 5 / R300–R319）**：§2.4 健康检查的**在线判据**。
 *
 * `docs/design.md` §2.4 给了就绪面的**响应体**（`{status, service, checks}`）与**状态码语义**
 * （`ok ⇒ 200` / `degraded ⇒ 503`），R267 又把它拆成**就绪/存活**两面、R285 裁决存活面
 * **不含 `checks` 键**、R296 汇总了交付给 conformance 的口径。本步把这三条钉成判据。
 *
 * ⚠️ **拓扑必须先量再写（R150/R241 的教训）**：网关的 `/api/health` 是**它自己的**健康面
 * （`service: 'api-gateway'`），**不代理**四个下游的 —— 实测。
 * ⇒「经网关」只对网关那一跳成立；3001/3002/3003/3005 必须**直连**（compose 开发形态发布了这四个端口）。
 * 若按「网关代理下游健康面」的想象去写，这条判据会在**正确的实现**上红（假红）。
 *
 * ⚠️ **近邻负对照**（R293 的直接推论）：`/api/healthz`・`/api/health/livex` 必须 **401**。
 * 两处的豁免清单都是**精确**匹配（网关的 `isPublicPath()` —— R462 后真源是 `src/auth/public-paths.ts`
 * 的 `PUBLIC_PATHS` / 下游的 `exemptPaths.includes`），
 * 本步就是在钉「豁免是精确条目、不是前缀」。⚠️ 401 **只**证明「这条路径不是公开面」
 * （`JwtMiddleware` 跑在路由之前，R241）—— 所以正对照（同一次探测里 `/api/health` 与
 * `/api/health/live` 匿名 = 200）是本条的**必要一半**，缺了它，「探针瞎了」也会全绿。
 *
 * ⚠️ **`degraded ⇒ 503` 的构造**：用**一次性容器**（**不**停/改常驻的 10 个 —— A7 的 e2e 就是
 * 因为「不能污染同轮其它切片」而刻意不做的，先例在案）。做法（R294 已实测可复现）：
 * 用 `pokergame-api-gateway` 镜像起一个 `-e REDIS_URL=redis://127.0.0.1:6399`（**没有监听**）
 * 的容器，宿主端口映射到 3999 ⇒ 就绪面 **503 + checks.redis=down**，而存活面**仍是 200**
 * （这同时就是 R267 两半的判据：`degraded ⇒ 503` + 「存活面不受下游抖动影响」）。
 * 容器**跑完即删**，并在 `finally` 里断言删除成功（`docker ps -a --filter name=…` 为空）——
 * 与第 ③ 步的「不留半死的栈」同一条门禁约定。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 步骤选择器 `CONFORMANCE_DEPLOY_STEPS`（默认=全部，合法 id：prod, dev, caddy, runtime, n14, health）：
 *   与 `slice-07.2-hardening` 的 `CONFORMANCE_STEPS` **同一理由** —— `run.js` 是 fail-fast，
 *   修前的第 ① 步会挡住 ③，而 ③ 的机制必须能被**单独**验证（它在修前修后都该绿，
 *   是「删掉默认 token」与「服务拒绝启动」之间的那条闭环）。它只能**只减不增**，
 *   未知 id 直接抛错。**门禁 / 最终判定必须不带该环境变量**。
 *   子块（`caddy`，终审 M6 重排：原先这行插在上一句中间，「同一理由」会被误挂到它头上）：
 *   ⚠️ `caddy` 的守卫在 `if (runs('prod'))` **之内**（它是 ① 区块里唯一一段独立的 docker 调用）
 *   ⇒ **`caddy` 必须与 `prod` 同选**：单独 `=caddy` 会**响亮抛错** —— 否则是「跑 0 条 caddy 断言
 *   却退出码 0」，一个合法 id 静默地少做（R115 同族）。
 *
 * ⚠️ **第 ④ 步（N12/N14，独立小片 P3 / R244/R245）**：`/api` 之外的路径一律 **404 + §11.1 信封**
 *   （`code === 10001`），未知 `/api` 路径同样；**反向**判据是「匿名 `GET /api/rooms` = 401 + 10002」，
 *   外加「带 token `GET /api/rooms` = 200 + code 0」的正对照 —— 三条并列才能证明
 *   「非 `/api` ⇒ 404」**不是**「一律 404」，也**不是**把 `/api` 内的业务 404（`12001`）混进来。
 *   ⚠️ 修前（master 实测）：`/`、`/games`、`/apix` 都是 Nest 默认 404（`{"message":"Cannot GET …",
 *   "error":"Not Found","statusCode":404}`），**没有** `code` 字段（N12）。
 *   ⚠️ 执行期实测（**R280**）：裸 `/api` 匿名是 **401**（中间件匹配 `/api`）⇒ 不在 404 名单里，
 *   与计划 R245 的字面清单不符（那里把 `/api` 当成了「非 /api 路径」）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withEmptyEnvFile } from '../lib/env-file';
import { join, resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import {
  directJson,
  GAME_URL,
  getJson,
  GATEWAY_URL,
  registerUser,
  ROBOT_URL,
  ROOM_URL,
  USER_URL,
} from '../lib/http';

/** 仓库根（`dist/slices/*.js` 与 `src/slices/*.ts` 同深度 ⇒ 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** 修前写在 `docker-compose.yml` 里的**公开**默认 token（R98 要删掉的那个常量）。 */
const LEAKED_DEFAULT_TOKEN = 'dev-internal-token-change-in-production';

/**
 * 十一个服务的 token 默认值都必须是空（未配置 ⇒ 启动期 fail-closed，R98）。
 *
 * ⚠️ 监控片 **+3**（规格 §4）：`prometheus` / `alertmanager` / `alert-relay` —— 三者都带
 * `INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}`（前两者另有 entrypoint 的 `:?` 守卫、
 * relay 用于 /webhook 与 /metrics 的 Bearer 守卫）。`node-exporter` / `cadvisor` / `grafana`
 * **不入列**——它们没有 token 行（各 +6 不成立，逐表口径）。
 * ⚠️ 货币片 T1：`currency-service` **同规入列**（compose 基文件里那行无默认值 —— fail-closed）。
 * ⚠️ 支付片 T2：`payment-service` **同规入列**（同上，fail-closed）。
 */
const TOKEN_SERVICES = ['user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service', 'api-gateway', 'prometheus', 'alertmanager', 'alert-relay'];

/**
 * 直连断言（`slice-07.2-boundary` / `slice-07.2-security` / `slice-07.1` 的 20 路 burst）依赖的宿主端口。
 *
 * ⚠️ **A3**（R1203）：`api-gateway:3000` 的宿主映射从基文件**移入** override ⇒ 开发形态照旧
 * 发布它（断言面不变，② 组里一并判）。把它列进来防「3000 搬走后开发形态没人发布 3000」这类静默回归。
 */
const DIRECT_PORT_SERVICES = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service'];

/**
 * §4.2 / §2.1（**N20/P4 Task 6 新增**；片规格 §2.1/§2.3 扩到**三个**监听方）：`Transport.TCP`
 * 的**内部 RPC 端口** —— `game-service` 3103 / `robot-service` 3105 / **`config-service` 3106**
 * （片⑦ T13 换键：原 `user-service` 3101 随其 RPC 监听退役 —— config 的 base `expose` 与
 * override `3106:3106` 在 T4 已就位 ⇒ 换键即刻全绿，①b/②b 无红窗）。
 * ⚠️ 货币片 T1：**`currency-service` 3104** 入表（`currency.apply`/`currency.get` 的接收侧；
 * base `expose: ["3004","3104"]` + override `"3104:3104"` 同提交就位）。
 *
 * 它们**只能**出现在 `expose`（compose 内网可达，§4.1 的四条 TCP 边靠它），
 * **不得**出现在生产形态的 `ports`（§2.1 逐字：「仅供服务间 `Transport.TCP` 使用，**不对外暴露**」）。
 * 宿主映射只允许在 `docker-compose.override.yml`（开发/联调形态；conformance 的 TCP 探针依赖它 —— R226）。
 */
const RPC_PORTS: Record<string, string> = {
  'game-service': '3103',
  'robot-service': '3105',
  'config-service': '3106',
  'currency-service': '3104',
};

/**
 * 剔除父进程同名变量：渲染判据不得随宿主 shell 漂移（R147 的延伸）。
 *
 * ⚠️ **A8**（门口片的复核结论）：只剔 `INTERNAL_SERVICE_TOKEN` 已不够 —— 新增的 6 个
 * `${VAR:-}` 输入（`SITE_ADDRESS` / `TLS_MODE` / `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` /
 * `IMAGE_PREFIX` / `IMAGE_TAG`）与 `TRUST_PROXY`（override 的 `${TRUST_PROXY:-}` 是**透传**
 * 语义 —— 宿主 export 了就会漏进渲染结果）都会让 A1 的「恰好 80/443」、A4/A6a 的「为空」与
 * A11 的默认渲染随宿主漂移。
 * 判别力自证在 ①j：**故意**把同名变量注入 `process.env`，渲染结果不得跟着变。
 */
const ISOLATED_KEYS = [
  'INTERNAL_SERVICE_TOKEN',
  'TRUST_PROXY',
  'SITE_ADDRESS',
  'TLS_MODE',
  'EDGE_HTTP_PORT',
  'EDGE_HTTPS_PORT',
  // ⚠️ A11（R1303）：两个镜像命名变量同样是 `${VAR:-}` 输入 ⇒ 宿主 `export` 会让
  //    「默认渲染那半」漂移（R147/A8 同族）。加入剔除后，A11 的默认半边才稳。
  'IMAGE_PREFIX',
  'IMAGE_TAG',
];
function isolatedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !ISOLATED_KEYS.includes(key)));
}

/**
 * 渲染一种形态的 compose 配置（`args` 里带 `-f docker-compose.yml` = 生产形态）。
 *
 * `extraEnv`：**调用方故意喂**的值（空 env-file 取不到非空值 ⇒ 负对照必须显式喂；
 * A1 的第二渲染也走这里）。合并顺序 = 先剔净宿主漂移、再叠加喂的值。
 */
function composeConfig(args: string[], extraEnv: NodeJS.ProcessEnv = {}): any {
  const out = withEmptyEnvFile((envFile) =>
    execFileSync(
      'docker',
      ['compose', '--env-file', envFile, ...args, 'config', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { ...isolatedEnv(), ...extraEnv }, maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return JSON.parse(out);
}

interface RunResult {
  status: number | null;
  /** 被本用例的超时以 SIGTERM 杀掉（= 进程到点仍在跑）。`status` 此时为 `null`。 */
  signal: NodeJS.Signals | null;
  /** 本用例的超时生效（等价于 `signal === 'SIGTERM'`，单独留一个语义名给判据读）。 */
  timedOut: boolean;
  /** 子进程的 stdout（诊断用：NDJSON 启动日志都走它）。 */
  stdout: string;
  stderr: string;
}

/** 一次性探针容器的固定名字（`--name`），让**残留清理**是确定的。 */
const PROBE_CONTAINER = 'ftl-conformance-deploy-probe';

/**
 * 清掉探针容器（不存在就什么都不做）。
 *
 * ⚠️ 为什么必须显式清：本用例的超时杀掉的是 **`docker compose` 客户端**，客户端被信号
 * 终止时**不会**执行自己的 `--rm` 清理（实测：留下一个仍在运行的
 * `<project>-api-gateway-run-<hash>` 容器）。不处理的话每跑一次本用例就多一个在跑的
 * 服务 —— 而门禁的约定是**不留半死的栈**。跑之前也要清：否则上一次的残留会让
 * `--name` 冲突，`run` 直接失败，断言会以「退出码不是 1、也没被信号杀掉」的形式红掉，
 * 而原因是残留、不是产品缺陷。
 */
function removeProbeContainer(): void {
  spawnSync('docker', ['rm', '-f', PROBE_CONTAINER], { cwd: REPO_ROOT, stdio: 'ignore' });
}

/**
 * 用**生产形态**起一个一次性容器并显式注入 `INTERNAL_SERVICE_TOKEN`。
 *
 * `--no-deps` 的理由见文件头；`-T` 是「无 TTY 环境下不要分配 TTY」。
 *
 * ⚠️ **超时用 `spawnSync` 原生能力，不用 POSIX `timeout` 命令**（本片中立化）：
 * 后者是 POSIX 专有工具 —— Windows 上**解析到哪个同名程序由 PATH 顺序决定**：Git 自带的
 * coreutils（正确语义），或 `C:\Windows\System32\timeout.exe`（交互式等待，语义完全不同）。
 * 实测 `where timeout` 两者都命中 ⇒ 现状是**碰巧能用**而非保证可用；原生超时没有这个不确定性。
 * 原生超时在到点时以 `killSignal`（默认 SIGTERM）杀掉子进程：
 * `status === null` 且 `error.code === 'ETIMEDOUT'`（实测）。
 *
 * ⚠️ 因此**判据不能再读 124**：124 是 POSIX `timeout` 命令自己的退出码约定，
 * 中立化后不存在。表达同一意图（「不是自己退出的，是被我们的超时杀掉的」）
 * 的中立形态是 `signal === 'SIGTERM'`。
 */
function runOneShot(token: string, seconds: number): RunResult {
  removeProbeContainer();
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--name',
      PROBE_CONTAINER,
      '-e',
      `INTERNAL_SERVICE_TOKEN=${token}`,
      'api-gateway',
      'node',
      'packages/api-gateway/dist/main.js',
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', env: isolatedEnv(), timeout: seconds * 1000 },
  );
  return {
    status: res.status,
    signal: res.signal,
    // `@types/node` 把 `SpawnSyncReturns.error` 标成 `Error`（无 `code`）⇒ 收窄到 `NodeJS.ErrnoException`（同 `lib/probe.ts`）。
    timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

function publishedServices(config: any): string[] {
  return Object.entries(config.services as Record<string, any>)
    .filter(([, service]) => (service.ports ?? []).length > 0)
    .map(([name]) => name)
    .sort();
}

function tokenOf(config: any, service: string): unknown {
  return (config.services?.[service]?.environment ?? {}).INTERNAL_SERVICE_TOKEN;
}

/**
 * **挂进镜像内应用树（`/app`）的宿主机路径** —— 用户 2026-09-23 的部署原则：
 *
 * > *实际部署的时候统一使用最终镜像，容器不依赖于宿主机产物。挂载只用于日志、需要持久化的内容。*
 *
 * ⇒ 生产形态里这个集合**必须为空**。
 *
 * ⚠️ 为什么按 `target` 落在 `/app` 之内判，而不是「凡 bind 皆违规」：原则的第二句
 * 本来就**允许**日志/持久化用 bind（它们挂 `/var/log`、`/data` 这类**容器自己的**路径）；
 * 而 `/app` 是**镜像里构建产物所在** —— 把宿主机的东西挂进那里 = 容器在吃宿主产物。
 * 命名卷（`type: volume`，如 `redis-data:/data`）不算，它由 Docker 管理、不依赖宿主文件。
 *
 * 渲染形状实测（`docker compose config --format json`）：长语法 `{type, source, target}`；
 * 生产形态下没有挂载的服务该字段是 `null`（不是 `[]`）—— 因此下面用 `?? []`。
 */
function hostArtifactMounts(config: any): Array<{ service: string; source: string; target: string }> {
  const hits: Array<{ service: string; source: string; target: string }> = [];
  for (const [service, def] of Object.entries(config.services as Record<string, any>)) {
    for (const volume of def.volumes ?? []) {
      const type = String(volume?.type ?? '');
      const target = String(volume?.target ?? '');
      if (type === 'bind' && target.startsWith('/app')) {
        hits.push({ service, source: String(volume?.source ?? ''), target });
      }
    }
  }
  return hits.sort((a, b) => `${a.service}:${a.target}`.localeCompare(`${b.service}:${b.target}`));
}

/** 渲染成一行，失败时看得见挂的是什么。 */
function describeMounts(mounts: Array<{ service: string; source: string; target: string }>): string {
  return mounts.length === 0 ? '（无）' : mounts.map((m) => `${m.service}: ${m.source} → ${m.target}`).join(' | ');
}

/**
 * §4 / **R1108**：缺**日志上限**的服务（渲染结果里 `logging.options` 没同时带 `max-size` 与 `max-file`）。
 *
 * ⚠️ 上限写在**基文件**里（两个形态都生效）—— 日志增长是**运行期**事实，与"只该出现在开发形态"的
 * 宿主端口 / dev token（那两个是**暴露面**）不是一类东西。因此本谓词对**两种形态**都该返回空。
 * ⚠️ 只证"渲染"不够（复核④）⇒ 另有 9′ 在 **runtime 步**用 `docker inspect` 证**真容器**。
 */
function servicesWithoutLogLimit(config: any): string[] {
  return Object.entries(config.services as Record<string, any>)
    .filter(([, service]) => {
      const options = (service.logging?.options ?? {}) as Record<string, unknown>;
      return !options['max-size'] || !options['max-file'];
    })
    .map(([name]) => name)
    .sort();
}

/**
 * **A6b 谓词**（M1 收紧；纯函数 —— 判据与判别力自证共用一份实现）。
 *
 * 剥掉**行注释**（`#` 起到行尾）后，全文**不得**含字面 `internal`。
 *
 * ⚠️ 为什么从「行首锚正则」改成「剥注释后查全文」（最终评审 M1 实测）：原实现
 * `/^\s*tls\s+internal\b/m` 只认**单行** `tls internal` —— 多行式
 * `tls {\n\tissuer internal\n}`（Caddy 同样接受、同样是自签）能**整条绕过**。
 * 剥注释则两种写法都命中，而注释里的 `internal`（Caddyfile 文件头第 2/5 行就写着该词）
 * 不会误伤 —— A6b 的本意本就是「注释不算」（spec §行 241 的措辞）。
 */
function hasLiteralInternal(caddyfileText: string): boolean {
  const withoutComments = caddyfileText
    .split('\n')
    .map((line) => line.split('#')[0] ?? '')
    .join('\n');
  return withoutComments.includes('internal');
}

// ── §2.4 健康检查（R267 / R285 / R293 / R294 / R296）─────────────────────────

/**
 * 一个服务的两个健康面。
 *
 * `checks` 是 §2.4 **就绪面** `checks` 的键集合，**恰好**（R267：「checks 只报自己真的依赖的」）。
 * `baseUrl` 是**直连**基址 —— 见文件头：网关不代理下游的健康面。
 */
interface HealthTarget {
  service: string;
  baseUrl: string;
  checks: readonly string[];
}

const HEALTH_TARGETS: readonly HealthTarget[] = [
  { service: 'api-gateway', baseUrl: GATEWAY_URL, checks: ['redis'] },
  // R296：五个服务**只有这一处**不同 —— `user-service` 真的依赖 MySQL。
  { service: 'user-service', baseUrl: USER_URL, checks: ['redis', 'mysql'] },
  { service: 'room-service', baseUrl: ROOM_URL, checks: ['redis'] },
  { service: 'game-service', baseUrl: GAME_URL, checks: ['redis'] },
  { service: 'robot-service', baseUrl: ROBOT_URL, checks: ['redis'] },
];

const GATEWAY_TARGET = HEALTH_TARGETS[0]!;

/** 一个 HTTP 面的原始观测值（谓词的输入 —— 纯数据，便于正/负对照）。 */
interface HttpFace {
  status: number;
  body: any;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * **就绪面**谓词（纯函数）：返回违规清单，空数组 = 通过。
 *
 * 它是本步全部健康判据的**唯一**实现 —— 实际断言与「修前形态的受控复现」共用它，
 * 因此下面那两条 `expectViolations(...)` 直接证明了本谓词抓得住 R294 的缺陷形态。
 */
function readinessViolations(face: HttpFace, target: HealthTarget): string[] {
  const v: string[] = [];
  if (face.status !== 200) v.push(`HTTP ${face.status}（§2.4：status=ok ⇒ 200）`);
  if (face.body?.status !== 'ok') v.push(`body.status=${JSON.stringify(face.body?.status)}（期望 "ok"）`);
  if (face.body?.service !== target.service) {
    v.push(`body.service=${JSON.stringify(face.body?.service)}（期望 ${target.service}）`);
  }
  const checks = face.body?.checks;
  if (!isPlainObject(checks)) {
    // R294 的缺陷形态正是「一个**没有** checks 的 200 体」——消息里把原文带上。
    v.push(`body.checks=${JSON.stringify(checks)}（§2.4：必须是对象，且键集合恰好 ${JSON.stringify(target.checks)}）`);
    return v;
  }
  const fields = Object.keys(checks);
  const setViolations = fieldSetViolations(fields, target.checks);
  if (setViolations.length > 0) {
    v.push(`checks 字段集：${setViolations.join('、')}（实际 ${JSON.stringify(fields)}）`);
  }
  const notUp = Object.entries(checks).filter(([, state]) => state !== 'up');
  if (notUp.length > 0) {
    v.push(`status=ok 时每个 check 都必须是 "up"（实际 ${JSON.stringify(notUp)}）`);
  }
  return v;
}

/**
 * **存活面**谓词（纯函数）：字段集**恰好** `{status, service}`。
 *
 * ⚠️ R285 的裁决：`live` **不含 `checks` 键**（不是 `checks: {}`）——「报一个空 checks 会让读侧
 * 误以为『检查过、都过了』」。所以这里比的是**键集合恰好**，多一个键（哪怕值是 `{}`）都算违规。
 */
function livenessViolations(face: HttpFace, target: HealthTarget): string[] {
  const v: string[] = [];
  if (face.status !== 200) v.push(`HTTP ${face.status}（R267：存活面恒 200，不查依赖）`);
  if (face.body?.status !== 'ok') v.push(`body.status=${JSON.stringify(face.body?.status)}（期望 "ok"）`);
  if (face.body?.service !== target.service) {
    v.push(`body.service=${JSON.stringify(face.body?.service)}（期望 ${target.service}）`);
  }
  const fields = isPlainObject(face.body) ? Object.keys(face.body) : [];
  const setViolations = fieldSetViolations(fields, ['status', 'service']);
  if (setViolations.length > 0) {
    v.push(`字段集：${setViolations.join('、')}（实际 ${JSON.stringify(fields)}；R285：存活面**不含** checks）`);
  }
  return v;
}

/** **降级面**谓词（纯函数）：§2.4 的 `degraded ⇒ 503` + 「down 的那个依赖必须如实报 down」。 */
function degradedViolations(face: HttpFace, target: HealthTarget): string[] {
  const v: string[] = [];
  if (face.status !== 503) v.push(`HTTP ${face.status}（§2.4：status=degraded ⇒ 503）`);
  if (face.body?.status !== 'degraded') {
    v.push(`body.status=${JSON.stringify(face.body?.status)}（期望 "degraded"）`);
  }
  if (face.body?.service !== target.service) {
    v.push(`body.service=${JSON.stringify(face.body?.service)}（期望 ${target.service}）`);
  }
  const checks = face.body?.checks;
  if (!isPlainObject(checks)) {
    v.push(`body.checks=${JSON.stringify(checks)}（降级面**同样**必须报 checks —— 只说「degraded」等于没说）`);
    return v;
  }
  const setViolations = fieldSetViolations(Object.keys(checks), target.checks);
  if (setViolations.length > 0) {
    v.push(`checks 字段集：${setViolations.join('、')}（实际 ${JSON.stringify(Object.keys(checks))}）`);
  }
  const wrong = Object.entries(checks).filter(([, state]) => state !== 'down');
  if (wrong.length > 0) {
    v.push(`依赖不可用时每个 check 都必须是 "down"（实际 ${JSON.stringify(wrong)}）`);
  }
  return v;
}

/** 一次性降级探针容器的固定名字（让残留清理是确定的）。 */
const DEGRADED_CONTAINER = 'ftl-conformance-health-degraded';
const DEGRADED_IMAGE = 'pokergame-api-gateway:latest';
/** 宿主端口（避开 3000–3005 与 3103/3105）。启动前会断言它没被别的容器占用。 */
const DEGRADED_PORT = 3999;
/** 无监听的地址 ⇒ ioredis 立刻 `ECONNREFUSED`（配 `enableOfflineQueue:false` ⇒ ping 立即失败）。 */
const DEAD_REDIS_URL = 'redis://127.0.0.1:6399';

function removeDegradedContainer(): void {
  spawnSync('docker', ['rm', '-f', DEGRADED_CONTAINER], { cwd: REPO_ROOT, stdio: 'ignore' });
}

/** `docker ps -a --filter name=<name>` 里的容器名（空串 = 不存在）。 */
function containerNames(name: string): string {
  const res = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );
  return String(res.stdout ?? '').trim();
}

/** 全部容器的端口映射原文（用于「宿主端口没被占用」这条前提）。 */
function publishedPortMappings(): string {
  const res = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return String(res.stdout ?? '');
}

const DEPLOY_STEPS = ['prod', 'dev', 'caddy', 'runtime', 'n14', 'health'] as const;
type DeployStep = (typeof DEPLOY_STEPS)[number];

export async function runSlice072Deploy(): Promise<Checks> {
  const checks = new Checks();
  const only = process.env.CONFORMANCE_DEPLOY_STEPS;
  const selected = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  if (selected) {
    const unknownSteps = [...selected].filter((s) => !(DEPLOY_STEPS as readonly string[]).includes(s));
    if (unknownSteps.length > 0) {
      throw new ConformanceError(
        `CONFORMANCE_DEPLOY_STEPS 里有未知步骤：${unknownSteps.join(', ')}（合法值：${DEPLOY_STEPS.join(', ')}）`,
      );
    }
  }
  // ⚠️ `caddy` 的守卫在 `if (runs('prod'))` **之内** ⇒ 它隐含依赖 `prod`。
  //    不拦的话，`CONFORMANCE_DEPLOY_STEPS=caddy` 会**跑 0 条 caddy 断言且退出码 0** ——
  //    一个合法 id 静默地少做，正是 R115 要防的形态。宁可响亮。
  if (selected?.has('caddy') && !selected.has('prod')) {
    throw new ConformanceError(
      "步骤 caddy 位于 `if (runs('prod'))` 区块内 ⇒ 必须与 prod 同选\n" +
        '（合法组合：不带该变量 / prod / prod,dev / prod,dev,caddy）',
    );
  }
  const runs = (id: DeployStep): boolean => selected === undefined || selected.has(id);

  // ── ① 生产形态：结构断言（R98 / R144 / R145）────────────────────────
  if (runs('prod')) {
    step('① 生产形态（`-f docker-compose.yml` + `--env-file <空文件>` + 剔除父进程同名变量）的结构断言');
    const base = composeConfig(['-f', 'docker-compose.yml']);

    const basePublished = publishedServices(base);
    info(`生产形态发布宿主端口的服务：${basePublished.join(', ') || '（无）'}`);
    // ── ①a A1：生产形态**只有门口**发布宿主端口（替换原"只有 api-gateway"）──
    // R1203：门口是唯一对外入口；下游一律网内可达（`expose`）。
    const edgePorts = (base.services?.edge?.ports ?? [])
      .map((p: any) => String(p.published ?? p)).sort();
    checks.that(
      JSON.stringify(basePublished) === JSON.stringify(['edge']),
      `生产形态**只有**门口（edge）发布宿主端口 —— 实际 ${basePublished.join(', ') || '无'}`,
    );
    checks.that(
      JSON.stringify(edgePorts) === JSON.stringify(['443', '80']),
      `门口默认发布的宿主端口恰为 80/443（实际 ${edgePorts.join(', ') || '无'}）`,
    );

    // ── ①a′ A1 的判别力（spec 复核 A-11）：**默认渲染判不出**「参数化」与「写死字面量」──
    // 第二次渲染喂非默认端口 ⇒ 发布集必须**跟着变量走**（宿主侧 18080；HTTPS 两侧同值；
    // HTTP 容器侧**固定 :80** —— 那是 ACME HTTP-01 与门口 healthcheck 共用的跳转监听）。
    const paramEdgePorts = (composeConfig(['-f', 'docker-compose.yml'], {
      EDGE_HTTP_PORT: '18080',
      EDGE_HTTPS_PORT: '18443',
    }).services?.edge?.ports ?? [])
      .map((p: any) => `${String(p.published)}:${String(p.target)}`)
      .sort();
    checks.that(
      JSON.stringify(paramEdgePorts) === JSON.stringify(['18080:80', '18443:18443']),
      `喂 EDGE_HTTP_PORT=18080 / EDGE_HTTPS_PORT=18443 ⇒ 门口发布恰为 18080:80 与 18443:18443` +
        `（宿主侧跟变量走、HTTP 容器侧固定 :80）—— 实际 ${JSON.stringify(paramEdgePorts)}`,
    );

    // ── ①a″ A11/A12：镜像命名方案（R1303）─────────────────────────────
    // ⚠️ A11 的**判别力全在第二次渲染**：只渲染一次判不出「参数化」与「写死
    //    `image: pokergame-room-service:latest`」—— 两者在默认值下**一模一样**。
    // 监控片（R1303 面的扩展）：+4 个自建服务（prometheus/grafana/alertmanager/alert-relay——
    // node-exporter/cadvisor **无 `build:`**，不在此面；cadvisor 用**官方字面名**直拉（2026-10-03 订正④，非自建命名）。
    const BUILD_SERVICES = ['alert-relay', 'alertmanager', 'api-gateway', 'config-service', 'currency-service', 'douzero', 'edge', 'game-service', 'grafana', 'payment-service', 'prometheus', 'robot-service', 'room-service', 'user-service'];
    const buildServices = Object.entries(base.services ?? {})
      .filter(([, svc]: [string, any]) => svc?.build)
      .map(([name]) => name)
      .sort();
    // A12：服务面**恰好** —— 防「新增服务绕开镜像库」、防「顺手给官方镜像也加前缀」。
    checks.that(
      JSON.stringify(buildServices) === JSON.stringify(BUILD_SERVICES),
      `A12：带 \`build:\` 的服务恰好这 14 个（且就是 A11 的断言面）—— 实际 ${JSON.stringify(buildServices)}`,
    );
    const defaultImages = buildServices.map((n) => `${n}=${base.services?.[n]?.image ?? '<缺 image:>'}`);
    checks.that(
      buildServices.every((n) => base.services?.[n]?.image === `pokergame-${n}:latest`),
      `A11：默认渲染下每个带 \`build:\` 的服务 \`image\` = \`pokergame-<svc>:latest\` —— 实际 ${JSON.stringify(defaultImages)}`,
    );
    checks.that(
      base.services?.redis?.image === 'redis:7-alpine' && base.services?.mysql?.image === 'mysql:8.0',
      `A12：官方镜像**不受参数化波及**（redis/mysql 逐字不变）—— 实际 ${base.services?.redis?.image} / ${base.services?.mysql?.image}`,
    );
    // 第二次渲染：喂**非默认**前缀与 tag ⇒ 十四个镜像名必须整体跟着变量走。
    const paramServices = composeConfig(['-f', 'docker-compose.yml'], {
      IMAGE_PREFIX: 'ghcr.io/x/y',
      IMAGE_TAG: 'v9',
    }).services ?? {};
    const paramImages = BUILD_SERVICES.map((n) => `${n}=${paramServices[n]?.image ?? '<缺 image:>'}`);
    checks.that(
      BUILD_SERVICES.every((n) => paramServices[n]?.image === `ghcr.io/x/y-${n}:v9`),
      `A11 第二次渲染：\`IMAGE_PREFIX=ghcr.io/x/y\` + \`IMAGE_TAG=v9\` ⇒ \`ghcr.io/x/y-<svc>:v9\`（十四个都要跟）` +
        ` —— 实际 ${JSON.stringify(paramImages)}`,
    );
    // A12 的**第二次渲染半**：官方镜像同样**不得**被参数化 —— 「redis:${IMAGE_TAG:-7-alpine}」在
    // 默认渲染下与字面量**逐字一样**，所以只判默认渲染会漏掉这种泄漏（复评 Minor 的补点）。
    checks.that(
      paramServices?.redis?.image === 'redis:7-alpine' && paramServices?.mysql?.image === 'mysql:8.0',
      `A12 第二次渲染：参数化**不得波及官方镜像**（\`redis\`/\`mysql\` 仍逐字不变）` +
        ` —— 实际 ${paramServices?.redis?.image} / ${paramServices?.mysql?.image}`,
    );

    // ── ①h A2：api-gateway 生产形态**零发布**、仍 expose 3000（与 A1 配对：防"顺手把 3000 留下"）──
    const gwPorts = (base.services?.['api-gateway']?.ports ?? []).length;
    const gwExpose = (base.services?.['api-gateway']?.expose ?? []).map(String);
    checks.eq(gwPorts, 0, '生产形态 api-gateway 零宿主端口发布（R1203）');
    checks.that(
      gwExpose.includes('3000'),
      `生产形态 api-gateway 仍 expose 3000（网内可达）—— 实际 ${JSON.stringify(gwExpose)}`,
    );

    // ── ①i A9：门口的证书库必须持久化（缺它 ⇒ 每次重建重签 ⇒ 撞 ACME 配额）──
    const edgeVolumes = (base.services?.edge?.volumes ?? []) as any[];
    checks.that(
      edgeVolumes.some((v) => String(v?.target) === '/data'),
      `门口必须挂命名卷到 /data（证书与 ACME 账户库）—— 实际 ${JSON.stringify(edgeVolumes)}`,
    );

    // ── ①g A5：门口的**固定地址** == api-gateway 的 TRUST_PROXY（同一份 json 里两处相比）──
    const edgeAddr = base.services?.edge?.networks?.['ftl-platform']?.ipv4_address ?? null;
    const trustProxy = base.services?.['api-gateway']?.environment?.TRUST_PROXY ?? null;
    checks.that(
      typeof edgeAddr === 'string' && edgeAddr.length > 0,
      `生产形态门口必须有字面固定地址（取到 ${JSON.stringify(edgeAddr)} —— null/undefined 一律算红）`,
    );
    checks.eq(trustProxy, edgeAddr, 'TRUST_PROXY 必须**逐字等于**门口的固定地址（防两处漂移）');

    // ── ①f A6a：fail-closed 两层 —— (i) 渲染层：不喂值 ⇒ 渲染为空；(ii) 运行层：空值 ⇒ 起不来 ──
    const edgeEnv = (base.services?.edge?.environment ?? {}) as Record<string, string>;
    checks.eq(edgeEnv.SITE_ADDRESS ?? '', '', '生产形态不给 SITE_ADDRESS ⇒ 渲染为空');
    checks.eq(edgeEnv.TLS_MODE ?? '', '', '生产形态不给 TLS_MODE ⇒ 渲染为空');

    // (i) 的负对照（**必须显式喂值** —— 空 env-file 取不到非空值）：
    const fed = composeConfig(['-f', 'docker-compose.yml'], {
      SITE_ADDRESS: 'example.com',
      TLS_MODE: 'ops@example.com',
    });
    checks.eq(
      fed.services?.edge?.environment?.SITE_ADDRESS,
      'example.com',
      '显式喂 SITE_ADDRESS ⇒ 渲染出该值（负对照；证明上一条不是"恒空"）',
    );
    checks.eq(
      fed.services?.edge?.environment?.TLS_MODE,
      'ops@example.com',
      '显式喂 TLS_MODE ⇒ 渲染出该值（负对照；与上一条成对 —— 基文件把该变量写成空字面量时这条会红）',
    );

    if (runs('caddy')) {
      // ── A6a(ii) 运行层（**fail-closed 的第二层**）：拿仓库 Caddyfile 起 `caddy:2-alpine`
      //    跑 `caddy validate` —— 两个变量喂**空** ⇒ 退出码 ≠ 0；显式喂值 ⇒ 退出码 0。
      //    ⚠️ 判别力**实测形态**（M1 订正，原注释强于事实）：只有**两处都写死**（站点地址与
      //       `tls` 都成字面量，例如 `localhost:8443 { tls internal }`）时，空值那一跑才会
      //       exit 0 ⇒ 这条才红。**只**把 `SITE_ADDRESS` 写死（`tls {$TLS_MODE}` 不动）时，
      //       空值那跑仍非 0 —— `tls` 无参本身是解析错（本机实测原文见 ⑥ 详注 ⑤）⇒ 本断言
      //       不红；那半边由 ①e 的 A6b 文本闸看（`tls` + 字面 `internal`）。
      //    ⚠️ `docker run --rm` 自带拉取/清理 ⇒ 这条**不依赖** `--profile edge`（门口容器不必在跑）。
      //    ⚠️ **必须带原生超时**（I1a，最终评审）：首次运行要**拉取** `caddy:2-alpine`（或 daemon
      //       卡住）⇒ 不设 `timeout` 时这条会把**整个 slice 悬挂**（而不是变红）—— 与
      //       `runOneShot` 同一条纪律（`:237` 的成例把原生超时列为必需）。
      //    ⚠️ 宿主侧路径转正斜杠：`join()` 在 Windows 出反斜杠；`spawnSync` 不经 shell ⇒
      //       Task 1 报告 `:267` 记的 Git Bash MSYS 转写坑只影响手敲命令，不影响这里（正斜杠两种都稳）。
      // ⚠️ **独立步骤 id（`caddy`，R1309①/B2）**：这是 `prod`+`dev` 两段里**唯一**的
      //    非 compose docker 调用 ⇒ 纯渲染形态（`CONFORMANCE_DEPLOY_STEPS=prod,dev
      //    --render`）必须能免掉它，否则「每次 push 都跑」就不成立。
      //    ⚠️ 默认（不设 `CONFORMANCE_DEPLOY_STEPS`）**照旧执行** —— 本步只加守卫，不改语义。
      const hostCaddyfile = join(REPO_ROOT, 'deploy', 'Caddyfile').replace(/\\/g, '/');
      const validateWith = (env: Record<string, string>): number => {
        const args = ['run', '--rm', '-v', `${hostCaddyfile}:/etc/caddy/Caddyfile:ro`];
        for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
        args.push('caddy:2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
        return spawnSync('docker', args, {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 64 * 1024 * 1024,
        }).status ?? -1;
      };
      const emptyExit = validateWith({ SITE_ADDRESS: '', TLS_MODE: '' });
      info(`A6a(ii) 空值 validate ⇒ exit ${emptyExit}（期望 ≠ 0）`);
      checks.that(emptyExit !== 0, `空 \`SITE_ADDRESS\`/\`TLS_MODE\` ⇒ Caddy **拒绝启动**（实得 exit ${emptyExit}）`);
      const fedExit = validateWith({ SITE_ADDRESS: 'localhost:8443', TLS_MODE: 'internal' });
      checks.that(fedExit === 0, `显式喂值 ⇒ Caddy 校验通过（实得 exit ${fedExit}）—— 这是上一条的**负对照**`);
    }

    // ── ①j A8 的判别力自证（R147 同族）：宿主 shell **故意**注入同名变量 ⇒ 渲染不得漂移 ──
    // 没有这条，`ISOLATED_KEYS` 少写一项也**没有闸会红**（本机 shell 恰好没设这些变量时）——
    // 而 A1 的「恰好 80/443」与 A4/A6a 的「为空」正是靠剔除才稳的。注入只在本块内有效（finally 复原）。
    // ⚠️ 消息与断言**逐字对齐**（一条注什么、读什么，消息就写什么）：曾出现「消息称注了
    //    SITE_ADDRESS/TLS_MODE 而只读 SITE_ADDRESS」+「TRUST_PROXY 没注入也没读」的弱化形态。
    // ⚠️ **M5**（最终评审）：先把 7 个键的**原值存下来**，finally **逐键复原** —— 原先的实现是
    //    无条件 `delete`，与「finally 复原」的注释**不符**：若宿主 shell 本来就 `export` 过其中之一
    //    （本文件头 R147/A8 正是为这种漂移源设的闸），`delete` 会把宿主环境**改掉**（跑完门禁后
    //    shell 环境不再是原样）。原值本就缺键的（`undefined`）才删。
    const POISONED: Record<string, string> = {
      SITE_ADDRESS: 'poisoned.example.com',
      TLS_MODE: 'ops@poisoned.example.com',
      TRUST_PROXY: 'poisoned.example.com',
      EDGE_HTTP_PORT: '18080',
      EDGE_HTTPS_PORT: '18443',
      IMAGE_PREFIX: 'ghcr.io/poisoned/x',
      IMAGE_TAG: 'v-poisoned',
    };
    const savedEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(POISONED)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const poisoned = composeConfig(['-f', 'docker-compose.yml']);
      const poisonedEnv = (poisoned.services?.edge?.environment ?? {}) as Record<string, string>;
      checks.eq(poisonedEnv.SITE_ADDRESS ?? '', '', '宿主 shell 注了 SITE_ADDRESS ⇒ 生产渲染仍为空（A8：`isolatedEnv()` 剔除生效）');
      checks.eq(poisonedEnv.TLS_MODE ?? '', '', '宿主 shell 注了 TLS_MODE ⇒ 生产渲染仍为空（A8：`isolatedEnv()` 剔除生效）');
      const poisonedPorts = (poisoned.services?.edge?.ports ?? [])
        .map((p: any) => String(p.published))
        .sort();
      checks.that(
        JSON.stringify(poisonedPorts) === JSON.stringify(['443', '80']),
        `宿主 shell 注了 EDGE_HTTP_PORT/EDGE_HTTPS_PORT ⇒ 生产渲染的门口发布**仍是** 80/443（A8）` +
          `—— 实际 ${JSON.stringify(poisonedPorts)}`,
      );
      // ⚠️ A11 的注入自证（R147/A8 同族）：宿主注了 IMAGE_PREFIX/IMAGE_TAG ⇒ 默认渲染的
      //    十四个镜像名**必须仍是** `pokergame-<svc>:latest`。少了这条，`ISOLATED_KEYS` 漏写这两项
      //    时**没有闸会红**（本机 shell 恰好没设它们时）。
      const poisonedImages = BUILD_SERVICES.map((n) => `${n}=${poisoned.services?.[n]?.image ?? '<缺 image:>'}`);
      checks.that(
        BUILD_SERVICES.every((n) => poisoned.services?.[n]?.image === `pokergame-${n}:latest`),
        `宿主 shell 注了 IMAGE_PREFIX/IMAGE_TAG ⇒ 默认渲染的十四个镜像名**仍是** \`pokergame-<svc>:latest\`（A11/A8）` +
          ` —— 实际 ${JSON.stringify(poisonedImages)}`,
      );
      // TRUST_PROXY 的生产半边被基文件字面量钉住（A5），**透传面在开发形态**（override 的
      // `${TRUST_PROXY:-}`）⇒ 自证必须读开发形态的渲染：剔除不生效时注入值会漏入，这里就得红。
      const devPoisoned = composeConfig([]);
      checks.eq(
        String(devPoisoned.services?.['api-gateway']?.environment?.TRUST_PROXY ?? '<键缺失，视为红>'),
        '',
        '宿主 shell 注了 TRUST_PROXY ⇒ 开发形态渲染仍为空（A8：`isolatedEnv()` 剔除生效；缺键也算红）',
      );
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value; // 复原**原值**（M5：原先这里是无条件 `delete`）
      }
    }

    for (const name of TOKEN_SERVICES) {
      checks.eq(tokenOf(base, name), '', `${name} 的 INTERNAL_SERVICE_TOKEN 默认渲染为空（R98：去掉公开常量）`);
    }
    checks.that(
      !JSON.stringify(base).includes(LEAKED_DEFAULT_TOKEN),
      `生产形态的渲染结果里不得再出现公开常量 ${LEAKED_DEFAULT_TOKEN}`,
    );

    // ── ①k A10（Task 7 Step 0 的缺陷修复）：`JWT_SECRET` 必须在**同一份渲染**里两处逐字一致 ──
    // 令牌由 user-service **签发**、由网关**验签** ⇒ 两处必须拿到同一个密钥。修前基文件只有
    // user-service 块里有这行（网关回落代码里的公开默认值 `?? 'dev-secret-change-in-production'`）
    // ⇒ 生产给真密钥后**每个登录令牌都验不过**（Task 6 实测发现，**生产阻断级**）。
    // 缺键/`null` 一律算红 —— **两边都缺不是"一致"**。证伪实测（Task 7 报告）：把那行从
    // `docker-compose.yml` 删掉 ⇒ 本条红（`验签方=null`）。
    const jwtSigner = base.services?.['user-service']?.environment?.JWT_SECRET ?? null;
    const jwtVerifier = base.services?.['api-gateway']?.environment?.JWT_SECRET ?? null;
    checks.that(
      typeof jwtSigner === 'string' && jwtSigner.length > 0 && jwtVerifier === jwtSigner,
      '生产形态 `api-gateway`（**验签方**）的 `JWT_SECRET` 必须**逐字等于** `user-service`（**签发方**）的' +
        '（同一份渲染两处比；缺键/null 一律红 —— 两边都缺不是"一致"）：' +
        `签发方=${JSON.stringify(jwtSigner)}，验签方=${JSON.stringify(jwtVerifier)}`,
    );

    // ── ①k-bis（片⑦ T17 审查补登，C4-1 同族）：**管理令牌**回落链的**两侧同钥** ────────
    // 管理令牌由 config-service **签发**、由 api-gateway **验签**，两侧代码链都写死了
    // `ADMIN_JWT_SECRET || JWT_SECRET || 'dev-secret-change-in-production'`
    // （config `src/config/admin-auth.service.ts` / 网关 `src/auth/admin.middleware.ts`）。
    // ①k 钉的是**玩家**令牌（user-service 签 / 网关验）；本条钉**管理令牌**这另一半。
    // 修前缺陷（生产阻断级、被 dev 形态掩盖 —— dev 里 JWT_SECRET 默认值与 dev 兜底逐字相同）：
    // 基文件只给 user-service / api-gateway 递了 `JWT_SECRET` ⇒ 生产 `.env` 给真钥且未设
    // `ADMIN_JWT_SECRET` 时：签发侧落**公开 dev 兜底**、验签侧用真钥 ⇒ 登录 200 之后
    // **每个 `/api/admin/*` 都 401**（T9 只修了 `ADMIN_JWT_SECRET` 半环）。
    // 两个**替代错实现**各自必须能红：(i) 任一侧少 `ADMIN_JWT_SECRET` 行（生产设了它时
    // 那一侧收不到 ⇒ 又回异钥）；(ii) config-service 少 `JWT_SECRET` 行（回落环在签发侧断链）。
    const hasAdminSecret = (svc: string): boolean => {
      const env = (base.services?.[svc]?.environment ?? {}) as Record<string, unknown>;
      return typeof env.ADMIN_JWT_SECRET === 'string';
    };
    checks.that(
      hasAdminSecret('config-service') && hasAdminSecret('api-gateway'),
      '生产形态 `config-service`（**签发方**）与 `api-gateway`（**验签方**）的 environment **都必须有**' +
        ' `ADMIN_JWT_SECRET` 行（空默认透传 ⇒ 渲染为空串也算有；缺键/`null` 一律红 —— C4-1：' +
        '漏一侧 ⇒ 生产 `.env` 设了它时那一侧收不到 ⇒ 管理令牌签/验异钥、登录后全 401）—— ' +
        `实际 config-service=${hasAdminSecret('config-service')}，api-gateway=${hasAdminSecret('api-gateway')}`,
    );
    const adminFallbackSigner = base.services?.['config-service']?.environment?.JWT_SECRET ?? null;
    const adminFallbackVerifier = base.services?.['api-gateway']?.environment?.JWT_SECRET ?? null;
    checks.that(
      typeof adminFallbackSigner === 'string' &&
        adminFallbackSigner.length > 0 &&
        adminFallbackVerifier === adminFallbackSigner,
      '生产形态 `config-service`（**管理令牌签发方**）的 `JWT_SECRET` 必须**逐字等于** `api-gateway`' +
        '（**验签方**）的（未设 `ADMIN_JWT_SECRET` 时两侧**同环回落**；缺键/`null` 一律红 —— ' +
        '两边都缺不是"一致"）：' +
        `签发方=${JSON.stringify(adminFallbackSigner)}，验签方=${JSON.stringify(adminFallbackVerifier)}`,
    );

    // ── ①b N20/P4（R226）：RPC 端口在**生产形态**下只在 `expose`，**不**在 `ports` ──
    // 这条是 `slice-07.2-rpc` 第 6 组判据的结构性版本：那里也断言同一件事（两处同源、一起红/绿），
    // 差别在于本步把它挂进「§A.3 部署闸门」的整体判据里 —— 单跑任一文件都能发现回归。
    for (const [service, port] of Object.entries(RPC_PORTS)) {
      const ports = (base.services?.[service]?.ports ?? []).map((p: any) => String(p.published ?? p));
      const expose = (base.services?.[service]?.expose ?? []).map((p: any) => String(p));
      info(`生产形态的 ${service}：ports=${JSON.stringify(ports)}，expose=${JSON.stringify(expose)}`);
      checks.that(
        !ports.includes(port),
        `生产形态的 ${service} 宿主端口里**不得**有 ${port}（§2.1：内部 RPC 端口不对外暴露；` +
          `实际 ports=${JSON.stringify(ports)}）—— 宿主映射只允许出现在 docker-compose.override.yml`,
      );
      checks.that(
        expose.includes(port),
        `生产形态的 ${service} \`expose\` 必须含 ${port}（§4.1 的四条 TCP 边靠 compose 内网；` +
          `实际 expose=${JSON.stringify(expose)}）`,
      );
    }

    // ── ①c 部署原则（2026-09-23 用户裁决）：两种形态**都不得**把宿主机产物挂进 /app ──
    // 修前实测：`robot-service` 挂着 `./packages/robot-service/dist:/app/packages/robot-service/dist`
    //（DouZero 集成期 `0452b09` 留下的开发便利，后来的「生产形态」收敛 R98/N10 没注意到它）。
    // 在**干净部署机**上它的两个后果：宿主 dist 不存在 ⇒ Docker 建**空目录**盖住镜像内构建好的
    // dist ⇒ 容器起不来；宿主 dist 陈旧 ⇒ **静默跑旧代码**。⇒ 先移入 override；**再整条删除**
    //（2026-09-23 用户裁决，连开发形态也不留：版本偏斜 + 「跑真栈前先宿主 build」的前置纪律，
    //  代价大于便利）⇒ 本条与 ②c 现在判的是**两种形态都为零**。
    const prodMounts = hostArtifactMounts(base);
    info(`生产形态挂进 /app 的宿主机路径：${describeMounts(prodMounts)}`);
    checks.that(
      prodMounts.length === 0,
      `生产形态的宿主机 bind 挂载**零**条落进 /app（部署统一使用最终镜像、容器不依赖宿主机产物；` +
        `只有日志/持久化才允许挂，且它们不落在 /app）—— 实际 ${describeMounts(prodMounts)}`,
    );

    // ── ①c′ 谓词判别力自证（R115）：喂**合成样本**，`hostArtifactMounts()` 必须看得见那条 /app bind ──
    // 这条自证原先借的是 ②c 的一条**真实**挂载（「开发形态必须保留 robot-service 宿主 dist 挂载」）。
    // 2026-09-23 用户裁决把那条挂载整条删掉（版本偏斜）⇒ 真实样本消失，改用合成样本，判别力不变：
    // 没有它，把 `hostArtifactMounts()` 写成恒返回 `[]` 也能让 ①c / ②c 双绿（本仓为「闸恒绿」付过代价）。
    // 三个样本覆盖两个方向：/app 的 bind 必须**看见**；非 /app 的 bind 与**命名卷**必须**不误报**。
    const synthetic = {
      services: {
        probe: {
          volumes: [
            { type: 'bind', source: '/host/artifacts', target: '/app/packages/probe/dist' },
            { type: 'bind', source: '/host/logs', target: '/var/log/probe' },
            { type: 'volume', source: 'probe-data', target: '/app/probe-data' },
          ],
        },
      },
    };
    const syntheticSeen = hostArtifactMounts(synthetic);
    info(`谓词对合成样本的读数：${describeMounts(syntheticSeen)}`);
    checks.that(
      syntheticSeen.length === 1 && syntheticSeen[0]!.target === '/app/packages/probe/dist',
      `谓词判别力自证：合成样本里**恰好**那条「bind 且 target 在 /app」被看见（非 /app 的 bind ` +
        `与命名卷都不得误报）—— 实际 ${describeMounts(syntheticSeen)}`,
    );

    // ── ①d §4 / R1108：日志上限（判据 9 的生产形态半边）──────────────────
    const prodNoLimit = servicesWithoutLogLimit(base);
    info(`生产形态缺日志上限的服务：${prodNoLimit.join(', ') || '（无）'}`);
    checks.that(
      prodNoLimit.length === 0,
      `生产形态**每个**服务都必须带日志上限（\`logging.options\` 的 max-size + max-file，R1108：` +
        `每服务 ≈50MB 封顶、超出轮转删最旧）—— 缺：${prodNoLimit.join(', ') || '（无）'}`,
    );
  }

  // ── ①e A6b（M1 收紧）：门口配置的**文本闸** —— 自签只能经变量传入 ──
  const caddyfile = readFileSync(join(REPO_ROOT, 'deploy', 'Caddyfile'), 'utf8');
  const caddyfileHasLiteralInternal = hasLiteralInternal(caddyfile);
  checks.that(
    !caddyfileHasLiteralInternal,
    `deploy/Caddyfile 的**非注释文本**不得含字面 \`internal\`（自签只能经 \`{\$TLS_MODE}\` 传入；` +
      `单行 \`tls internal\` 与多行 \`tls { issuer internal }\` 两种写法都命中）—— 实际命中：${caddyfileHasLiteralInternal}`,
  );
  // 判别力自证（R115 同族）：谓词必须**真的看得见**「字面 internal」—— 没有它，把谓词写成
  // 恒 `false` 也能让上面那条恒绿（本仓为「闸恒绿」付过代价）。三个样本覆盖两个方向。
  checks.that(hasLiteralInternal('x {\n\ttls internal\n}'), '谓词判别力：单行 `tls internal` 必须被看见');
  checks.that(
    hasLiteralInternal('x {\n\ttls {\n\t\tissuer internal\n\t}\n}'),
    '谓词判别力：**多行式** `tls { issuer internal }` 必须被看见 —— 它是原行首锚正则' +
      '`/^\\s*tls\\s+internal\\b/m` 的**绕过形态**（M1 实测：多行式不是 `tls` + 空白 + `internal`）',
  );
  checks.that(
    !hasLiteralInternal('# 注释里的 `tls internal` 不算\nx {\n\ttls {$TLS_MODE}\n}'),
    '谓词负对照：**注释里**的 `internal` 不得误报（A6b 的本意是「注释不算」—— Caddyfile 文件头就写着该词）',
  );

  // ── ② 开发形态：自动合并 override 后仍可直连（R144）────────────────
  if (runs('dev')) {
    step('② 开发形态（不带 `-f`，Compose 自动合并 `docker-compose.override.yml`）仍提供直连端口与 dev token');
    const dev = composeConfig([]);
    for (const name of DIRECT_PORT_SERVICES) {
      const ports = dev.services?.[name]?.ports ?? [];
      checks.that(
        ports.length > 0,
        `开发形态仍发布 ${name} 的宿主端口（conformance 的直连断言依赖它；这条在修前修后都该绿）`,
      );
      checks.eq(
        tokenOf(dev, name),
        LEAKED_DEFAULT_TOKEN,
        `开发形态的 ${name} token 是 dev 默认值（override 按键覆盖基文件）`,
      );
    }
    // ── ②b N20/P4（R226）：TCP 探针依赖的宿主映射只在**开发形态**（override）里 ──
    for (const [service, port] of Object.entries(RPC_PORTS)) {
      const ports = (dev.services?.[service]?.ports ?? []).map((p: any) => String(p.published ?? p));
      info(`开发形态的 ${service} 宿主端口：${JSON.stringify(ports)}`);
      checks.that(
        ports.includes(port),
        `开发形态必须发布 ${service} 的 RPC 端口 ${port}（R226：conformance 在宿主机跑，` +
          `基文件只 \`expose\` ⇒ 不加 override 映射就永远连不上；与 3001/3002/3003/3005 同一理由）—— ` +
          `实际 ${JSON.stringify(ports)}`,
      );
    }

    // ── ②e A4：开发形态的信任表默认**空**（宿主未设时）；负对照在 A5 ──
    // 基文件的字面 `TRUST_PROXY=172.28.0.250` 会**按键合并**漏进开发形态，而开发形态的 3000
    // 是**发布**的（宿主可直连）⇒ override 必须把信任表盖回空（`${TRUST_PROXY:-}` = 透传 + 默认空），
    // 否则开发形态会在「对端 = 宿主/任意容器」的现实下采信代理头。生产形态的**非空**对照在 A5。
    checks.eq(
      (dev.services?.['api-gateway']?.environment?.TRUST_PROXY ?? '') || '',
      '',
      '开发形态 TRUST_PROXY 默认渲染为空',
    );

    // ── ②c ①c 的**开发形态**半边（2026-09-23 裁决：连开发形态也不留宿主产物挂载）──
    // 原先是「正对照：谓词必须看得见 dev 的那条挂载」；那条挂载已整条删除（版本偏斜 + 与生产同构）
    // ⇒ 谓词判别力改由 ①c′ 的**合成样本**自证，本条回归纯粹的「两形态同构」断言。
    const devMounts = hostArtifactMounts(dev);
    info(`开发形态挂进 /app 的宿主机路径：${describeMounts(devMounts)}`);
    checks.that(
      devMounts.length === 0,
      `开发形态与生产形态**同构**：宿主机 bind 挂载**零**条落进 /app（一律走镜像 ⇒ 不再有` +
        `「宿主 dist 陈旧 / 旧服务代码 + 镜像新 shared」的版本偏斜）—— 实际 ${describeMounts(devMounts)}`,
    );

    // ── ②d §4 / R1108：日志上限（判据 9 的开发形态半边）──────────────────
    // 上限写在基文件 ⇒ 合并后开发形态同样该有（这条与 ②c 的正对照同族：谓词对**两种形态**都判）。
    const devNoLimit = servicesWithoutLogLimit(dev);
    info(`开发形态缺日志上限的服务：${devNoLimit.join(', ') || '（无）'}`);
    checks.that(
      devNoLimit.length === 0,
      `开发形态同样**每个**服务都要有日志上限（R1108；上限在基文件里，合并后自然继承）—— ` +
        `缺：${devNoLimit.join(', ') || '（无）'}`,
    );
  }

  // ── ③ 运行期 fail-closed（R89/R92 的意图延伸到 compose 层）──────────
  if (runs('runtime')) {
    step('③ 运行期 fail-closed：空 token ⇒ 服务拒绝启动；给了值 ⇒ 起得来（`-f docker-compose.yml` + `--no-deps`）');
    info('基线（协调者在 master 镜像上实测）：空 token ⇒ 退出码 1 + 那一行 error；给了值 ⇒ 被本用例的超时以 SIGTERM 杀掉。');

    // ── ③a §4 / R1108 的**生效**判据（判据 9′ · 复核④：渲染 ≠ 生效）──────────
    // 「配置文件证不了运行中的容器」—— 同族教训是「假 Redis 证不了原子性」。
    // ⚠️ 前提：这些容器是**重建之后**的（未重建 ⇒ 它们还没有上限 ⇒ 本判据红 —— 那是**响的**，
    //    不是假红；同族坑见片⑥：旧镜像会让真 Redis 判据变空测）。监控片 +6：六块都带
    //    R1108 上限（列表 +6，规格 §4）；「不在跑」照旧只 info（监控六容器按 profile 起停）。
    // ⚠️ **A7 按形态**（R1209）：门口是第 12 个服务、只在 `--profile edge` 时在跑 ——
    //    「没在跑」只 info（既有形态）⇒ 对 ftl-edge 而言那是**静默通过**。
    //    语义：**若**门口在跑 ⇒ 它的日志上限必须对；「不存在」是 B0 的残留闸，不在这里判
    //    （合法跑过 `--profile edge` 又没收尾的人不该在这条上红 —— 症状会像无关回归）。
    const LOG_LIMIT_TARGETS = [
      'ftl-redis', 'ftl-mysql', 'ftl-douzero', 'ftl-user-service',
      'ftl-room-service', 'ftl-game-service', 'ftl-robot-service', 'ftl-config-service',
      'ftl-api-gateway', 'ftl-edge',
      // ⚠️ 货币片 T1（#25）：不加不红 = 静默失明（监控片 +6 先例）
      'ftl-currency-service',
      // ⚠️ 支付片 T2：同上 —— 不加不红 = 静默失明。
      'ftl-payment-service',
      // 监控片 +6（与上六块逐字对应）
      'ftl-prometheus', 'ftl-grafana', 'ftl-alertmanager',
      'ftl-node-exporter', 'ftl-cadvisor', 'ftl-alert-relay',
      // ⚠️ 通知通道管理化片 T15：同上 —— 不加不红 = 静默失明（无 `build:` 的共享镜像形态，
      //    但有独立容器与独立 R1108 日志上限块）。
      'ftl-am-renderer',
    ];
    const withoutLimit: string[] = [];
    const notRunning: string[] = [];
    for (const name of LOG_LIMIT_TARGETS) {
      const res = spawnSync('docker', ['inspect', '--format', '{{json .HostConfig.LogConfig}}', name], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      if (res.status !== 0) {
        notRunning.push(name);
        continue;
      }
      if (!String(res.stdout ?? '').includes('max-size')) withoutLimit.push(name);
    }
    info(`不在跑的容器：${notRunning.join(', ') || '（无）'}；在跑但没有上限的：${withoutLimit.join(', ') || '（无）'}`);
    checks.that(
      withoutLimit.length === 0,
      '在跑的容器必须带日志上限（docker inspect 的 LogConfig —— 渲染不等于生效，R1108 / 判据 9′）—— ' +
        `在跑却没上限的：${withoutLimit.join(', ') || '（无）'}`,
    );

    const empty = runOneShot('', 60);
    info(`空 token：退出码 ${empty.status}，stderr=${JSON.stringify(empty.stderr.slice(-400))}`);
    checks.eq(empty.status, 1, '空 token 时进程**自己**以退出码 1 结束（`process.exit(1)`；被杀表示它反而活到了超时）');
    checks.that(
      !empty.timedOut,
      '空 token 时**不得**落到超时分支（那样等于服务照常启动，只是被杀了）',
    );
    checks.that(
      empty.stderr.includes('INTERNAL_SERVICE_TOKEN is required'),
      '空 token 时必须打出 fail-closed 的那句 error 日志（`INTERNAL_SERVICE_TOKEN is required`）',
    );

    const withValue = runOneShot('probe-value', 8);
    info(`给了 token：退出码 ${String(withValue.status)}，signal=${String(withValue.signal)}，timedOut=${String(withValue.timedOut)}（SIGTERM = 仍在 listen，被本用例的超时杀掉）`);
    // ⚠️ **诊断（2026-09-25，CI 首次真栈跑）**：linux runner 上这一步拿到的是「退出码 255、
    //    signal=null」—— 进程**自己**退出了。而 `packages/api-gateway/src/main.ts` **只有**
    //    一处 `process.exit(1)`（fail-closed），**没有** 255 —— 即 255 来自更下游（Nest 启动
    //    失败 / Node 致命错 / compose 客户端自身）。原先这行**只打状态不打输出** ⇒ 证据全丢，
    //    只能靠猜。⇒ 只要结果不是「被超时 SIGTERM 杀掉」，就把两路输出打出来。
    if (!withValue.timedOut) {
      info(`  ↳ 非预期退出 ⇒ stdout（尾 700）：${withValue.stdout.slice(-700)}`);
      info(`  ↳ 非预期退出 ⇒ stderr（尾 700）：${withValue.stderr.slice(-700)}`);
    }
    // ⚠️ 判据参数由 `status === 124` 改为 `signal === 'SIGTERM'`（本片唯一一处判据参数变化）。
    // 意图不变：证明「进程不是自己退出的，而是被我们的超时杀掉的」——否则
    // 「空 token 起不来」无从归因到 fail-closed。124 是 POSIX `timeout` 命令的退出码约定，
    // 中立化后不存在；SIGTERM 是同一意图的中立表达，且更直接。
    // 🔴 **判据订正（2026-09-25，CI 首次在 Linux 上跑抓到根因）**：原判 `signal === 'SIGTERM'`，
    //    而那是**平台相关的代理**、不是要证的那条性质。实测（linux runner，诊断输出）：
    //    **`timedOut=true`、退出码 255、`signal=null`** —— 超时**确实**生效（进程到点仍在跑），
    //    只是 `docker compose` **客户端**在 linux 上**捕获 SIGTERM 后自己以 255 退出**
    //    ⇒ Node 看到的是「正常退出」而非「被信号打死」；本机（Windows）同一路径下客户端是被
    //    信号打死的 ⇒ `signal='SIGTERM'`。**同一性质、两种平台形态。**
    //    ⇒ 要证的性质 = 「**到点时进程仍在跑**」= `timedOut`（Node 超时机制自己置的位）。
    //    ⚠️ 它**不是**弱化：进程若在 8 秒内自退，Node 就**不会**置 ETIMEDOUT ⇒ 照样红。
    //    ⚠️ 且它**已有负对照**：上面「空 token」那条是自己退出 ⇒ 断言 `!empty.timedOut` 绿。
    //    ⚠️ 判据**条数不变**（仍两条）。
    checks.that(
      withValue.timedOut,
      '给了 token 时进程必须**留在 listen**（8 秒内不自行退出 ⇒ 被本用例的超时杀掉）—— 否则「空 token 起不来」无从归因到 fail-closed' +
        ` —— 实际 timedOut=${String(withValue.timedOut)}，退出码 ${String(withValue.status)}，signal=${String(withValue.signal)}`,
    );
    // 第二闸：把「被超时打断」的**已知两种平台形态**钉住 —— 形态再多一种就红（而不是静默接受）。
    checks.that(
      withValue.signal === 'SIGTERM' || withValue.status === 255,
      '被超时打断的形态必须属于**已知两种**之一：① `signal=SIGTERM`（客户端被信号打死，本机 Windows 实测）' +
        ' ② `退出码 255`（linux 上 compose 客户端捕获 SIGTERM 后自己退出，CI runner 实测）' +
        ` —— 实际 signal=${String(withValue.signal)}，退出码=${String(withValue.status)}`,
    );

    // 收尾：上面那次超时杀的是 compose 客户端，容器还在跑 ⇒ 显式清掉（见 `removeProbeContainer`）。
    removeProbeContainer();
    const leftover = spawnSync(
      'docker',
      ['ps', '-a', '--filter', `name=${PROBE_CONTAINER}`, '--format', '{{.Names}}'],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    const leftoverNames = String(leftover.stdout ?? '').trim();
    checks.eq(leftoverNames, '', '收尾后不得留下探针容器（门禁约定：不留半死的栈）');
  }

  // ── ④ N12/N14：`/api` 之外一律 404 + §11.1 信封（R244/R245）────────
  if (runs('n14')) {
    step(
      '④ N12/N14：非 `/api` 路径一律 **404 + §11.1 信封**（R244：`code=10001`），' +
        '未知 `/api` 路径同样 404 + 10001；反向：匿名 `/api/rooms` = **401 + 10002**',
    );
    info('修前（master 实测）：`/` `/games` `/apix` 都是 Nest 默认 404 ——');
    info('  `{"message":"Cannot GET /games","error":"Not Found","statusCode":404}`：**没有** `code` 字段（N12 的活体形态）。');
    info('⚠️ R241：**不要**在不带凭证的情况下断言**业务路由**的 404 —— 全局 `JwtMiddleware` 跑在路由之前，');
    info('   匿名请求任何 `/api/*` 路径都会先得到 **401**，看不到路由层面的 404。');
    info('⚠️ 执行期实测（R280）：**裸 `/api`** 匿名是 **401**（中间件确实匹配 `/api`，`forRoutes(\'*\')` + 全局前缀）');
    info('   ⇒ 它**不在**本步的 404 名单里（计划 R245 把 `/api` 列进了「非 /api 路径」，与实测不符）。');
    info('   `//api/rooms` 匿名实测是 404（中间件不匹配双斜杠）—— 与「/api 之外」同族，故计入 404 名单。');
    const a = await registerUser(0);

    // 非 `/api` 前缀：**匿名**即可（这些路径根本不经过中间件 —— 这也正是 N14 的实质：
    // 「将来谁在 /api 之外注册处理器就整条绕过验签」）。
    for (const path of ['/', '/index.html', '/games', '/apix', '//api/rooms']) {
      const res = await getJson<unknown>(path);
      const body = (res.body ?? null) as any;
      info(`匿名 GET ${path} → HTTP ${res.status}，body=${JSON.stringify(res.body)}`);
      checks.eq(res.status, 404, `匿名 GET ${path} 的 HTTP 状态（§7.1/R245：/api 之外的处理器必须 404）`);
      checks.eq(
        body?.code,
        ErrCode.BAD_PARAM,
        `匿名 GET ${path} 的 §11.1 信封 code（R244：未知路由用 10001）—— 修前是 Nest 默认体（无 code）`,
      );
      checks.that(
        typeof body?.message === 'string' && body.message.length > 0,
        `匿名 GET ${path} 的信封 \`message\` 必须是非空字符串 —— 实际 ${JSON.stringify(body?.message)}`,
      );
      checks.that(
        !('statusCode' in (body ?? {})),
        `匿名 GET ${path} 不得再是 Nest 默认 404 体（含 statusCode/error；§11.1 是 {code,message,data}）—— ` +
          `实际 ${JSON.stringify(body)}`,
      );
    }

    // 未知 `/api` 路径：必须**带** token（否则拿到的是中间件的 401，不是路由的 404 —— R241）
    const unknownApi = await getJson<unknown>('/api/does-not-exist', a.accessToken);
    const unknownBody = (unknownApi.body ?? null) as any;
    info(`未知 /api 路径（带 token）GET /api/does-not-exist → HTTP ${unknownApi.status}，body=${JSON.stringify(unknownApi.body)}`);
    checks.eq(unknownApi.status, 404, '带 token 的未知 `/api` 路径的 HTTP 状态（N12 也覆盖网关自己的 404）');
    checks.eq(unknownBody?.code, ErrCode.BAD_PARAM, '未知 `/api` 路径的 §11.1 信封 code（R244：10001）');
    checks.that(
      !('statusCode' in (unknownBody ?? {})),
      `未知 \`/api\` 路径不得再是 Nest 默认 404 体 —— 实际 ${JSON.stringify(unknownBody)}`,
    );

    // 反向判据：同一条真实路由**匿名** ⇒ 401 + 10002（证明「非 /api ⇒ 404」不是「一律 404」）
    const anon = await getJson<unknown>('/api/rooms');
    info(`匿名 GET /api/rooms → HTTP ${anon.status}，body=${JSON.stringify(anon.body)}`);
    checks.eq(anon.status, 401, '匿名 GET /api/rooms 的 HTTP 状态（§7.1：/api 内的业务路由先过鉴权）');
    checks.eq(anon.body?.code, ErrCode.UNAUTHENTICATED, '匿名 GET /api/rooms 的 §11.1 信封 code（10002）');

    // 正向对照：同一条路由**带** token ⇒ 200 + code 0（证明网关活着、路由真的存在 —— 不是「全站 404」）
    const authed = await getJson<unknown>('/api/rooms', a.accessToken);
    info(`带 token GET /api/rooms → HTTP ${authed.status}，body=${JSON.stringify(authed.body).slice(0, 160)}`);
    checks.eq(authed.status, 200, '带 token GET /api/rooms 的 HTTP 状态（正对照：路由确实存在）');
    checks.eq(authed.body?.code, ErrCode.OK, '带 token GET /api/rooms 的 body.code（正对照：0）');
  }

  // ── ⑤ §2.4 健康检查（R267/R285/R293/R294/R296；P5 / Task 5 Step 1）────
  if (runs('health')) {
    step(
      '⑤ §2.4 健康检查：就绪面 `checks` 字段集**恰好** + 存活面**不含 checks** + ' +
        '近邻路径**不是**公开面 + `degraded ⇒ 503`（一次性容器构造）',
    );
    info('拓扑（**实测**，R150/R241 的教训：先量再写）：网关的 `/api/health` 是**它自己的**健康面');
    info('  （`service: "api-gateway"`），**不代理**四个下游的 ⇒「经网关」只对网关那一跳成立，');
    info('  3001/3002/3003/3005 必须**直连**（开发形态发布了这四个宿主端口）。');
    info('修前 RED 原文（R293/R294 的容器验收，2026-09-16，修前镜像实测）：');
    info('  :3000 200 {"status":"ok","service":"api-gateway"}   ← **没有** checks（R294：GatewayController 遮蔽了就绪面）');
    info('  curl :3002/api/health/live → 401 {"code":10002,…}   ← 新端点不在任何免鉴权清单里（R293）');

    // ── 谓词判别力自证（R115：断言「没发生」之前先证明谓词看得见「发生」）──
    // ⚠️ 排在会红的分组**之前**（R193③）：run.js 是 fail-fast，放后面就永远看不到。
    checks.eq(
      readinessViolations({ status: 200, body: { status: 'ok', service: 'api-gateway', checks: { redis: 'up' } } }, GATEWAY_TARGET).length,
      0,
      '谓词负对照：正确的就绪体不报违规',
    );
    const preR294 = readinessViolations(
      { status: 200, body: { status: 'ok', service: 'api-gateway' } },
      GATEWAY_TARGET,
    );
    checks.that(
      preR294.length > 0,
      '谓词判别力（受控复现 R294 的修前形态）：`{"status":"ok","service":"api-gateway"}`（**无 checks**）⇒ 必须报违规',
    );
    info(`   ↳ 判据原文：${preR294.join('；')}`);
    const extraCheck = readinessViolations(
      { status: 200, body: { status: 'ok', service: 'api-gateway', checks: { redis: 'up', mysql: 'up' } } },
      GATEWAY_TARGET,
    );
    checks.that(
      extraCheck.length > 0,
      '谓词判别力：网关多报一个自己并不依赖的 `mysql` ⇒ 必须被字段集抓住（R267：不得为了看起来齐全而报假信息）',
    );
    info(`   ↳ 判据原文：${extraCheck.join('；')}`);
    checks.eq(
      livenessViolations({ status: 200, body: { status: 'ok', service: 'api-gateway' } }, GATEWAY_TARGET).length,
      0,
      '谓词负对照：正确的存活体（恰好 {status, service} 两字段）不报违规',
    );
    const emptyChecks = livenessViolations(
      { status: 200, body: { status: 'ok', service: 'api-gateway', checks: {} } },
      GATEWAY_TARGET,
    );
    checks.that(
      emptyChecks.length > 0,
      '谓词判别力（R285）：存活体是 `checks: {}`（空对象）时**必须**报违规 —— 「不含 checks 键」与「checks 为空」是两个形状',
    );
    info(`   ↳ 判据原文：${emptyChecks.join('；')}`);
    const notDegraded = degradedViolations(
      { status: 200, body: { status: 'ok', service: 'api-gateway', checks: { redis: 'up' } } },
      GATEWAY_TARGET,
    );
    checks.that(notDegraded.length > 0, '谓词判别力：`degraded ⇒ 503` —— 一个 200/ok 的体喂给降级面谓词必须报违规');
    info(`   ↳ 判据原文：${notDegraded.join('；')}`);

    // ── ① 五个服务的两个面（直连；网关那一跳就是它自己）────────────────
    interface Faces {
      ready: HttpFace;
      live: HttpFace;
    }
    const faces = new Map<string, Faces>();
    for (const target of HEALTH_TARGETS) {
      const readyRes = await directJson<unknown>(target.baseUrl, '/api/health');
      const liveRes = await directJson<unknown>(target.baseUrl, '/api/health/live');
      const ready: HttpFace = { status: readyRes.status, body: readyRes.raw };
      const live: HttpFace = { status: liveRes.status, body: liveRes.raw };
      faces.set(target.service, { ready, live });
      info(`${target.service} GET /api/health      → HTTP ${ready.status}，body=${JSON.stringify(ready.body)}`);
      info(`${target.service} GET /api/health/live → HTTP ${live.status}，body=${JSON.stringify(live.body)}`);
      const readiness = readinessViolations(ready, target);
      checks.that(
        readiness.length === 0,
        `${target.service} 就绪面满足 §2.4：200 + status=ok + checks 字段集**恰好** ` +
          `${JSON.stringify(target.checks)} 且每个值都是 "up"（判据原文：${readiness.join('；') || '无差异'}）`,
      );
      const liveness = livenessViolations(live, target);
      checks.that(
        liveness.length === 0,
        `${target.service} 存活面满足 R267/R285：200 + 字段集**恰好** {status, service}（**不含** checks；` +
          `判据原文：${liveness.join('；') || '无差异'}）`,
      );
    }

    // ── ② 拓扑断言：网关那一跳报的是**它自己**，不是任何下游的转发 ──────
    const gwReady = faces.get('api-gateway')!.ready;
    const gwLive = faces.get('api-gateway')!.live;
    checks.eq(
      gwReady.body?.service,
      'api-gateway',
      '网关 `/api/health` 的 `body.service` 是 "api-gateway"（**它自己的**健康面 —— 判据按实测拓扑写，' +
        '不按「网关代理五个下游」的想象写）',
    );

    // ── ③ 修前形态的**实测**受控复现 ──────────────────────────────────
    // 修前 :3000/api/health 的实测体（R294 原文）逐字等于今天**存活面**的形状
    // ⇒ 把真实测到的存活体喂给就绪面谓词，必须红。这把「谓词在修前栈上会红」从推断变成**实测输入**。
    const reproduced = readinessViolations({ status: 200, body: gwLive.body }, GATEWAY_TARGET);
    checks.that(
      reproduced.length > 0,
      `受控复现：把**实测到的**存活体 ${JSON.stringify(gwLive.body)} 当作就绪体 ⇒ 必须报违规 ` +
        `（修前 :3000/api/health 的实测原文就是这个形状）`,
    );
    info(`   ↳ 判据原文：${reproduced.join('；')}`);

    // ── ④ 近邻负对照：豁免是**精确**条目，不是前缀（R293 的直接推论）──
    // 正对照见 ①：同一次匿名探测里 `/api/health` 与 `/api/health/live` 都是 200
    // （所以下面的 401 不可能是「探针瞎了」）。
    const neighborFaces = new Map<string, HttpFace>();
    for (const path of ['/api/healthz', '/api/health/livex']) {
      const anon = await getJson<unknown>(path);
      neighborFaces.set(path, { status: anon.status, body: anon.body });
      info(`匿名（经网关）GET ${path} → HTTP ${anon.status}，body=${JSON.stringify(anon.body)}`);
      checks.eq(
        anon.status,
        401,
        `匿名 GET ${path} 必须是 401（R293：白名单是**精确**条目 —— 有人把 \`/api/health\` 改成前缀时这里立刻红）`,
      );
      checks.eq(anon.body?.code, ErrCode.UNAUTHENTICATED, `匿名 GET ${path} 的 §11.1 信封 code（10002）`);
      for (const target of HEALTH_TARGETS.slice(1)) {
        const direct = await directJson<unknown>(target.baseUrl, path);
        info(`  直连 ${target.service} GET ${path}（不带内部 token）→ HTTP ${direct.status}`);
        checks.eq(
          direct.status,
          401,
          `直连 ${target.service} 匿名 GET ${path} 必须 401（下游的 \`DEFAULT_EXEMPT_PATHS\` 同样是精确匹配）`,
        );
        checks.eq(
          direct.body?.code,
          ErrCode.UNAUTHENTICATED,
          `直连 ${target.service} GET ${path} 的 §11.1 信封 code（10002）`,
        );
      }
    }

    // ── ④b 「401 是中间件给的」的**实测**证据（不是机制推断，R150/P3 教训第 1 条）──
    // 带一个**有效凭证**再打同一条路径：中间件放行 ⇒ 请求落到路由层 ⇒ 那条路由**不存在** ⇒ 404。
    // 两个观测值合起来说明：①匿名的 401 只能来自验签中间件；②「白名单变成前缀」这个回归会让
    // 匿名请求走到路由层拿到 **404**（而不是 401）⇒ 上面那条 `checks.eq(status, 401)` 立刻红。
    const probeUser = await registerUser(0);
    const authedNeighbour = await getJson<unknown>('/api/healthz', probeUser.accessToken);
    info(`带凭证（授权过的）GET /api/healthz → HTTP ${authedNeighbour.status}，body=${JSON.stringify(authedNeighbour.body)}`);
    checks.eq(
      authedNeighbour.status,
      404,
      '带凭证时同一条路径是 **404**（路由不存在）—— ⇒ 匿名时的 **401 只能来自验签中间件**；' +
        '若白名单被改成前缀，匿名请求会走到路由层拿到 404，上一条 401 判据立刻红（判别力**实测**，不是推断）',
    );

    // ── ④c 修前 `/api/health/live` 恒 401 的**实测**受控复现 ────────────
    // 修前（R293 原文）`curl :3002/api/health/live → 401 {"code":10002,…}`。
    // 今天没有任何一条**公开**路径会返回 401，但 `/api/healthz`（真实 HTTP 响应）就是那个形状
    // ⇒ 把它喂给存活面谓词，必须红 —— 这把「本判据在修前栈上会红」变成**实测输入**。
    const liveFrom401 = livenessViolations(neighborFaces.get('/api/healthz')!, GATEWAY_TARGET);
    checks.that(
      liveFrom401.length > 0,
      '受控复现：把**真实的** 401 响应（= 修前 `/api/health/live` 的实测形态）喂给存活面谓词 ⇒ 必须报违规',
    );
    info(`   ↳ 判据原文：${liveFrom401.join('；')}`);

    // ── ⑤ `degraded ⇒ 503`：一次性容器 + 无监听的 REDIS_URL ────────────
    info('降级构造（R294 已实测可复现）：一次性容器 + `REDIS_URL=redis://127.0.0.1:6399`（容器内无监听）⇒ 依赖不可用。');
    info('⚠️ **不**停/改常驻的 11 个容器 —— 那会让同一轮门禁里的其它切片假红（A7 的 e2e 就是因此刻意不做的）。');
    info(`  docker run -d --name ${DEGRADED_CONTAINER} -p ${DEGRADED_PORT}:3000 -e REDIS_URL=${DEAD_REDIS_URL} … ${DEGRADED_IMAGE}`);
    // 先清：上一次的残留会让 `--name` 冲突 ⇒ 症状看起来像产品缺陷（同第 ③ 步的 removeProbeContainer）。
    removeDegradedContainer();
    let bodyError: unknown;
    let cleanupProblem: string | undefined;
    try {
      checks.that(
        !publishedPortMappings().includes(`:${DEGRADED_PORT}->`),
        `前提：宿主端口 ${DEGRADED_PORT} 未被任何容器占用（被占用时先处理它 —— 端口冲突不是产品缺陷）`,
      );
      const imageCheck = spawnSync('docker', ['image', 'inspect', DEGRADED_IMAGE], { cwd: REPO_ROOT, stdio: 'ignore' });
      checks.eq(imageCheck.status, 0, `前提：镜像 ${DEGRADED_IMAGE} 存在（协调者已构建）`);
      const started = spawnSync(
        'docker',
        [
          'run', '-d', '--name', DEGRADED_CONTAINER,
          '-p', `${DEGRADED_PORT}:3000`,
          '-e', `REDIS_URL=${DEAD_REDIS_URL}`,
          '-e', 'INTERNAL_SERVICE_TOKEN=conformance-probe-value',
          DEGRADED_IMAGE,
        ],
        { cwd: REPO_ROOT, encoding: 'utf-8' },
      );
      checks.eq(
        started.status,
        0,
        `\`docker run\` 起一次性降级容器必须成功（stderr=${JSON.stringify(String(started.stderr ?? '').trim())}）`,
      );
      // ⚠️ R115 正对照：那条「收尾后不留容器」的断言只有在**探针看得见容器时**才有意义。
      //    少了这一条，`docker ps -a --filter` 写错（或 docker 命令整体失败、stdout 为空）
      //    会让收尾判据**恒绿** —— 本仓两次翻车（allFilesStillHttp / NOT_YET_MIGRATED）都是这个形状。
      checks.that(
        containerNames(DEGRADED_CONTAINER) !== '',
        '探针正对照：容器**存在时** `docker ps -a --filter name=…` 必须看得见它（否则收尾那条「为空」是空测）',
      );

      const base = `http://localhost:${DEGRADED_PORT}`;
      let live: HttpFace | undefined;
      for (let i = 0; i < 60 && live === undefined; i += 1) {
        try {
          const res = await directJson<unknown>(base, '/api/health/live');
          if (res.status === 200) live = { status: res.status, body: res.raw };
        } catch {
          // 还没 listen —— 继续等（容器首次启动要几秒）
        }
        if (live === undefined) await sleep(500);
      }
      if (live === undefined) {
        const logs = spawnSync('docker', ['logs', '--tail', '20', DEGRADED_CONTAINER], { cwd: REPO_ROOT, encoding: 'utf-8' });
        throw new ConformanceError(
          `一次性容器 30s 内没有在 ${base} 提供存活面（容器日志尾部：\n` +
            `${String(logs.stdout ?? '')}${String(logs.stderr ?? '')}）`,
        );
      }
      info(`LIVE  ${base}/api/health/live => ${live.status} ${JSON.stringify(live.body)}`);
      checks.eq(
        live.status,
        200,
        '降级容器里**存活面仍是 200**（R267 的另一半：存活探针不该因为下游抖动而失败）',
      );
      checks.that(
        livenessViolations(live, GATEWAY_TARGET).length === 0,
        `降级容器的存活面必须是 {status, service} 两字段（实测 ${JSON.stringify(live.body)}）`,
      );

      const readyRes = await directJson<unknown>(base, '/api/health');
      const ready: HttpFace = { status: readyRes.status, body: readyRes.raw };
      info(`READY ${base}/api/health => ${ready.status} ${JSON.stringify(ready.body)}`);
      const degraded = degradedViolations(ready, GATEWAY_TARGET);
      checks.that(
        degraded.length === 0,
        `依赖不可用 ⇒ §2.4 的降级形态（503 + status=degraded + checks 字段集恰好 ` +
          `${JSON.stringify(GATEWAY_TARGET.checks)} 且 redis=down）：${degraded.join('；') || '无差异'}`,
      );

      // 反向：把**降级容器的存活体**（= 修前就绪面的形状）喂给就绪面谓词 ⇒ 必须红。
      const reproducedDegraded = readinessViolations({ status: 200, body: live.body }, GATEWAY_TARGET);
      checks.that(
        reproducedDegraded.length > 0,
        `受控复现：降级容器上的存活体 ${JSON.stringify(live.body)}（= 修前 :3000/api/health 的实测形状）` +
          '喂给就绪面谓词 ⇒ 必须报违规',
      );
      info(`   ↳ 判据原文：${reproducedDegraded.join('；')}`);
    } catch (err) {
      bodyError = err;
    } finally {
      removeDegradedContainer();
      const leftover = containerNames(DEGRADED_CONTAINER);
      if (leftover !== '') {
        cleanupProblem = `一次性容器 ${DEGRADED_CONTAINER} 未被删除（残留：${leftover}）—— 门禁约定：不留半死的栈`;
      }
    }
    // ⚠️ 收尾断言**不得吞掉**体内的失败：两者都报，且恢复失败优先（它是环境污染）。
    if (cleanupProblem !== undefined) {
      throw new ConformanceError(
        bodyError === undefined
          ? cleanupProblem
          : `${cleanupProblem}；此外体内断言先失败：${bodyError instanceof Error ? bodyError.message : String(bodyError)}`,
      );
    }
    if (bodyError !== undefined) throw bodyError;
    checks.ok(`收尾：一次性容器已删除（\`docker ps -a --filter name=${DEGRADED_CONTAINER}\` 为空）`);
  }

  return checks;
}
