/**
 * conformance 用例：**门口**（TLS 终止 + H5 静态站 + 反代）的三条链（spec B1–B3）、
 * 生命周期协议（B0）与**可信客户端 IP 的真栈面**（B4 限流归属 / B5 伪造负对照 / B6 头面契约）。
 * ⚠️ 生命周期是判据的一部分：
 *   - `--profile` 是**全局参数**（必须写在子命令**之前**）；
 *   - `down` **删不掉**带 profile 的容器 ⇒ 旧门口容器常驻会让本 slice 全部**测旧镜像**；
 *   - `up -d edge`（只点名服务）**不重建 api-gateway** ⇒ 注入到不了网关 ⇒ B4/B6 变空测；
 *   - 收尾**必须复原网关**（`TRUST_PROXY=` 空）⇒ 否则残留注入态让**下一轮**的 B4/B5/B6 空测；
 *   - **先清再断言**（修复轮 3）：`ratelimit:http-ip:*` 的 TTL 是 60s ⇒ 旧键会让正向断言
 *     **空转通过**（真实回归形态 = 本轮请求根本没被计数，而旧键还在）。B4 造流量前清空全部、
 *     B6 发请求前清掉**网桥地址段**的桶 —— 清过之后，"键存在"才只能来自本轮请求。
 *
 * 计划：`docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md` §5 的 B0–B6
 * （裁决 R1202/R1204/R1205/R1208/R1209）。Task 1/2 已交付 `deploy/Caddyfile`、`Dockerfile.edge`
 * 与 compose 的 `edge` 服务（`container_name: ftl-edge`、开发形态 `profiles: ["edge"]`、
 * 固定地址 `172.28.0.250`）；Task 4 交付了唯一实现 `packages/api-gateway/src/http/trusted-client-ip.ts`。
 *
 * ⚠️ 本 slice 会**真起第 10 个容器**（门口）并在收尾删掉它。**不得** stop/down 那 9 个
 * 常驻容器（B0 的 `up -d --build --no-deps api-gateway edge` 只重建这两者）。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { Checks, info, step } from '../lib/assert';
import { GATEWAY_URL, registerUser } from '../lib/http';
import { redisLines } from '../lib/redis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { io } from 'socket.io-client';

const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';
const EDGE_BASE = `https://localhost:${EDGE_HTTPS_PORT}`;
const EDGE_TRUST_ADDR = '172.28.0.250'; // 与基文件的 ipv4_address 同值（A5 钉着两处一致）
const EDGE_CONTAINER = 'ftl-edge';
/** 门口镜像名（R1303：唯一命名规则 `${IMAGE_PREFIX:-pokergame}-edge:${IMAGE_TAG:-latest}` 的默认形态）。 */
const EDGE_IMAGE = 'pokergame-edge:latest';
/** B2′ 的镜像内扫描容器（`--rm` + 固定名 ⇒ 被超时杀掉时的残留可以确定地清掉）。 */
const ENV_SCAN_CONTAINER = 'ftl-edge-env-scan';
const COMPOSE_PROJECT = 'pokergame';
const COMPOSE_NETWORK = `${COMPOSE_PROJECT}_ftl-platform`;

/**
 * 门口容器的**网络端点**视图（`{{json .NetworkSettings.Networks}}`）。
 *
 * ⚠️ 存在理由（2026-09-25，CI 首跑）：`docker network inspect … .IPAM.Config[].Gateway` 是
 * **平台相关**的 —— linux runner 上那个字段根本不存在，而容器端点上的 `Gateway` 两处都有。
 * 解析失败一律给空对象（调用方按「取不到」处理，不抛）。
 */
function networksJson(): Record<string, { Gateway?: string; IPAddress?: string }> {
  const r = spawnSync('docker', ['inspect', EDGE_CONTAINER, '--format', '{{json .NetworkSettings.Networks}}'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  try {
    return JSON.parse(String(r.stdout ?? '{}'));
  } catch {
    return {};
  }
}

/**
 * 由 CIDR 推「第一个可用地址」= Docker 给 bridge 的默认网关约定（网络地址 + 1）。
 *
 * ⚠️ 只是**退化来源**（首选容器端点的 `Gateway`）。两来源都取到时 B4 会**互相印证**，
 * 不一致就红 —— 所以这个推算不是「信它」，而是「它必须与真值一致」。
 */
function firstUsableAddress(cidr: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) return '';
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return '';
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const gw = ((ip & mask) + 1) >>> 0;
  return [(gw >>> 24) & 255, (gw >>> 16) & 255, (gw >>> 8) & 255, gw & 255].join('.');
}

/**
 * **C4 的静态半边**（监控片，规格 §4）：`deploy/Caddyfile` 里 `/grafana` 两条 handle 的谓词。
 *
 * 判据（返回违规列表；空 = 合规）：
 *  ① `handle /grafana {` 块存在，且块内含**显式 matcher** 的重定向 `redir * /grafana/ 301`
 *     —— 2026-10-01 实测坑：`redir /grafana/ 301` 会把 `/grafana/` 当 from-matcher 简写、
 *     Location 编译成字面量 `301` 且永不命中（catch-all 之外的直接表现 = 不是 301）；
 *  ② `handle /grafana/*` 块存在，且块内 `reverse_proxy grafana:3010`（与 compose 的
 *     `expose: ["3010"]` 逐字对应）；
 *  ③ 两条都在 catch-all `handle {` **之前**（设计 r1-M-4③ 的钉死位置）。
 *
 * ⚠️ 本谓词**不**判真实跳转/代理行为 —— 那半边的**运行期**形态（`/grafana/` 跟随重定向后
 *    200 + `/metrics` 负对照）归 `slice-16-monitoring` 的 C4（对监控栈在跑的形态判）。
 *    注释行（`#` 起头）不参与（防「注释里写着就当有」）。
 */
export function grafanaHandleViolations(src: string): string[] {
  const lines = src.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  const violations: string[] = [];
  /** 取 `handle …{` 起、到下一个独占一行的 `}` 之间的块体（本仓 Caddyfile 是单层块）。 */
  const blockBody = (matcher: RegExp): string[] | null => {
    const start = lines.findIndex((line) => matcher.test(line));
    if (start === -1) return null;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\}\s*$/.test(lines[i]!)) break;
      body.push(lines[i]!);
    }
    return body;
  };
  const redirect = blockBody(/^\s*handle\s+\/grafana\s*\{\s*$/);
  if (redirect === null) violations.push('缺 `handle /grafana {` 块');
  else if (!redirect.some((l) => /^\s*redir\s+\*\s+\/grafana\/\s+301\s*$/.test(l))) {
    violations.push(
      '`handle /grafana` 块内缺**显式 matcher** 的重定向 `redir * /grafana/ 301`' +
        '（redir 的第一个以 / 开头的参数会被当 from-matcher —— 2026-10-01 实测坑）',
    );
  }
  const proxy = blockBody(/^\s*handle\s+\/grafana\/\*\s*\{\s*$/);
  if (proxy === null) violations.push('缺 `handle /grafana/*` 块');
  else if (!proxy.some((l) => /^\s*reverse_proxy\s+grafana:3010\s*$/.test(l))) {
    violations.push('`handle /grafana/*` 块内缺 `reverse_proxy grafana:3010`');
  }
  // 次序：两条都必须在 catch-all 之前（catch-all 在组内最容易把 `/grafana/` 接走）。
  const catchAllAt = lines.findIndex((l) => /^\s*handle\s*\{\s*$/.test(l));
  if (catchAllAt === -1) {
    violations.push('缺 catch-all `handle {`（本谓词用它的位置判次序）');
  } else {
    for (const [name, re] of [
      ['`handle /grafana`', /^\s*handle\s+\/grafana\s*\{\s*$/],
      ['`handle /grafana/*`', /^\s*handle\s+\/grafana\/\*\s*\{\s*$/],
    ] as const) {
      const at = lines.findIndex((l) => re.test(l));
      if (at !== -1 && at > catchAllAt) violations.push(`${name} 在 catch-all \`handle {\` **之后**（会被静态站接走）`);
    }
  }
  return violations;
}

/**
 * B5 探针镜像：**本地已有**（避免外网拉取）+ 自带**真 `curl`**。
 *
 * ⚠️ 选它而不是审查里写的 `curlimages/curl:latest`：后者本机**没有**、registry 又不可达
 * （与 Task 3 的 `python:3.14-slim` 同款坑）⇒ 探针起不来 ⇒ B5 假红。`alpine` 自带的
 * busybox `wget` 不支持这里要的 `-X POST` + JSON 头/体组合，故不用。
 */
const PROBE_IMAGE = 'caddy:2-alpine';

/** `compose()` 的选项（无选项时传 `{}`）。 */
interface ComposeOpts {
  /** 传给 `spawnSync` 的超时（ms）。省略 = 不设超时（首次 `up --build` 要几分钟）。 */
  timeout?: number;
}

/**
 * 仓库根（`dist/slices/*.js` 与 `src/slices/*.ts` 同深度 ⇒ 同一个相对路径）。
 *
 * ⚠️ 每个 `docker` 子进程都显式带 `cwd: REPO_ROOT`：本 slice 的**产出接口**之一是
 * `pnpm --filter … conformance:slice-07.3-edge`，而 pnpm 跑脚本时的 cwd 是**包目录**
 * （`tools/conformance`）—— 不带 cwd 时 `docker compose` 在包目录里找不到 compose 文件
 * ⇒ `up` 直接非 0（假红）。同 `slice-07.2-deploy` 的成例。
 */
const REPO_ROOT = resolve(__dirname, '../../../..');

export async function runSlice073Edge(): Promise<Checks> {
  const checks = new Checks();
  // ⚠️ 开头**先清一次残留**（同 `slice-07.2-deploy` 的 `removeProbeContainer()` 成例）：
  //    上一次若在收尾前抛错，`ftl-edge` 会留到这一轮 ⇒ 本轮的"无残留"判据会**假红**。
  spawnSync('docker', ['rm', '-f', EDGE_CONTAINER], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'ignore' });
  // ⚠️ 启动时也**幂等自愈**网关（控制者裁定，回应 Task 5 实施者的提问）：上一轮若被 Ctrl-C / 管道
  //    SIGPIPE 中断，`finally` **不会**跑 ⇒ 网关停在**注入态**；此时若先跑步别的门禁，就会量到错形态。
  //    仅在**非空**时重建（避免无谓开销）。
  let gwEnv0 = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
    { encoding: 'utf8' }).stdout ?? '';
  if (!/^TRUST_PROXY=$/m.test(gwEnv0)) {
    info('启动自愈：网关停在注入态 ⇒ 复原为开发默认（空）');
    // ⚠️ `timeout` / `maxBuffer` 与同族调用**同值**（修复轮 3 必改 3）：这一行跑在 `try` **之前**
    //    ⇒ 在这里挂住就**没有** `finally` 可言（同 Step 0 给 `compose()` 抬 maxBuffer 的理由：
    //    默认 1MiB 上限会把 `up` 的日志变成 `ENOBUFS` ⇒ `status` 为 `null` ⇒ 误导性红；
    //    `timeout` 则防它把整个 slice 吊死）。
    spawnSync('docker', ['compose', 'up', '-d', '--no-deps', 'api-gateway'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    // ⚠️ **自愈后重读**（对计划片段的一处订正，实施者 2026-09-24）：下面那条断言量的是
    //    "起手可用态"（必要时**已**自愈）—— 若仍读自愈前那份，注入态起跑时它必然红，与本条
    //    要钉住的不变式（"开跑时网关信任必为空"）矛盾。
    gwEnv0 = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      { encoding: 'utf8' }).stdout ?? '';
  }
  // 起手态断言（钉住不变式本身；消息**正面陈述** —— 成功时也打印实际值）。
  checks.that(/^TRUST_PROXY=$/m.test(gwEnv0), `起手态：网关信任为空（必要时已自愈）—— 实际 ${JSON.stringify(gwEnv0.match(/TRUST_PROXY=.*/)?.[0] ?? '（无该键）')}`);
  // ⚠️ 同一条纪律也管 B5 的探针容器（名字带时间戳 ⇒ 上一轮无法按名清"别人"）：
  //    断言失败/进程被打断时它会留下，污染 `docker ps -a`（实测 2026-09-24 的证伪轮就漏了一个）。
  const staleProbes = spawnSync('docker', ['ps', '-a', '--filter', 'name=ftl-edge-probe-', '--format', '{{.Names}}'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  const staleNames = (staleProbes.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (staleNames.length > 0) info(`开头清残留：删除上一次遗留的探针容器 ${staleNames.join(' | ')}`);
  for (const name of staleNames) {
    spawnSync('docker', ['rm', '-f', name], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'ignore' });
  }
  const compose = (opts: ComposeOpts, ...args: string[]) => {
    const r = spawnSync('docker', ['compose', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // ⚠️ 与 `slice-07.2-deploy.ts:169` 同值（64MiB）：`--build` 的日志超过 spawnSync 的
      //    默认上限（1MiB）会以 `ENOBUFS` 失败 ⇒ `status` 为 `null` ⇒ 下面折成 `code -1`
      //    ⇒ 失败消息看起来像"compose 退 1"，**误导性红**（实测根因反而是缓冲）。
      maxBuffer: 64 * 1024 * 1024,
      // `undefined` = 不设超时（Node 的 spawnSync 显式跳过它）；收尾必须设（见 `finally`）。
      timeout: opts.timeout,
      env: {
        ...process.env,
        EDGE_HTTPS_PORT,
        EDGE_HTTP_PORT: process.env.EDGE_HTTP_PORT ?? '8080',
        TRUST_PROXY: EDGE_TRUST_ADDR,
      },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  try {
    // ── B0：生命周期（起门口 + 注入自证）──────────────────────────────
    step('B0 生命周期：起门口（连 api-gateway 一起点名）→ 收尾无残留');
    // ⚠️ `--no-deps`（**实测订正**，2026-09-24）：不带它时 compose 的 `--build` 会把
    //    **传递依赖**一起纳入构建计划（实测 7 个服务全在构建；`robot-service`/`game-service`
    //    依赖的 `douzero` 也进计划 ⇒ 要 `python:3.14-slim`）—— 而本机没有该 base 镜像、
    //    又到不了 registry（`failed to fetch oauth token … auth.docker.io`）⇒ `up` exit 1。
    //    带上它后构建集**恰为**点名的两个服务（`--dry-run` 实测），且顺带保护那 9 个常驻
    //    容器不被无谓重建（本 slice 的约定：只起/删门口，网关只做「注入重放」）。
    // ⚠️ `--wait`（Step 0 订正，2026-09-24）：两个服务都已有 healthcheck ⇒ 等**真就绪**。
    //    原先的 `sleep(8000)` 是固定睡眠 —— 在负载下会让 B1 因为"重建未就绪"红（响的但无谓）。
    // ⚠️ `--wait` **没有默认超时**（`up --help` 已核）⇒ 容器永远不健康时这条**不会红、会一直等**
    //    （I1b，最终评审）⇒ 必须显式给 `--wait-timeout 300`（秒）。
    //    ⚠️ 这里**不**加 spawnSync 级 `timeout`（有意）：首次 `--build` 含**镜像内 H5 构建**
    //    （实测 203.7s），固定的进程级超时会**误杀**这一跑 —— 本步的超时语义只由
    //    `--wait-timeout 300`（等**就绪**）承担，构建阶段不设上限。
    const up = compose({}, '--profile', 'edge', 'up', '-d', '--build', '--no-deps', '--wait', '--wait-timeout', '300', 'api-gateway', 'edge');
    info(`docker compose --profile edge up -d --build --no-deps --wait --wait-timeout 300 api-gateway edge ⇒ exit ${up.code}`);
    // 诊断用（不改判据）：首次 `--build` 要**镜像内构建 H5**（几分钟），失败时必须看得见原因。
    if (up.code !== 0) info(`构建/启动输出（尾部 800 字）：${up.out.slice(-800)}`);
    checks.eq(up.code, 0, '门口与网关一起被重建（点名两个服务）');
    const env = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{json .Config.Env}}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    checks.that(
      (env.stdout ?? '').includes(`TRUST_PROXY=${EDGE_TRUST_ADDR}`),
      `注入必须**真的到达网关**（否则本 slice 全是空测）—— 实际 ${(env.stdout ?? '').slice(0, 200)}`,
    );
    // ⚠️ 运行期孪生 A5（brief 之外的**一处**增补，理由：`noUnusedLocals` 要求
    //    `COMPOSE_NETWORK` 被读，且 A5 只钉**渲染**——上面的注入自证只证明网关**环境里**
    //    有那个值，不证明运行中的门口**就在**该地址上；两处不一致时 B4/B6 会量错对象）。
    const net = spawnSync('docker', ['inspect', EDGE_CONTAINER, '--format', '{{json .NetworkSettings.Networks}}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    checks.that(
      (net.stdout ?? '').includes(`"${COMPOSE_NETWORK}"`) && (net.stdout ?? '').includes(`"IPAddress":"${EDGE_TRUST_ADDR}"`),
      `运行期孪生 A5：门口必须挂在 ${COMPOSE_NETWORK} 上、地址恰为 ${EDGE_TRUST_ADDR}` +
        `（注入的信任锚必须指向**运行中的**门口）—— 实际 ${(net.stdout ?? '').slice(0, 200)}`,
    );

    // ── B1/B2：加密 + 静态站 ──────────────────────────────────────────
    step('B1/B2 经门口取 /api/health 与 H5 静态站（自签证书 ⇒ 显式不校验证书）');
    const health = await edgeFetch('/api/health');
    checks.eq(health.status, 200, '经 https 打 /api/health ⇒ 200');
    checks.that(health.body.includes('"service":"api-gateway"'), `响应体必须是网关的真 JSON —— 实际 ${health.body.slice(0, 120)}`);
    checks.that(
      (health.headers['strict-transport-security'] ?? '').length > 0,
      '响应必须带 HSTS（R1208 的硬化四项之一）',
    );

    const index = await edgeFetch('/');
    checks.eq(index.status, 200, 'GET / ⇒ 200（H5 index.html）');
    const asset = /\/assets\/[A-Za-z0-9_.-]+\.js/.exec(index.body)?.[0];
    checks.that(typeof asset === 'string', `index.html 必须引用至少一个 /assets/*.js —— 实际 ${index.body.slice(0, 120)}`);
    const assetRes = await edgeFetch(asset!);
    checks.eq(assetRes.status, 200, `**一个真实静态资源**必须 200（${asset}）—— 不只断言页面（素材 404 的教训）`);

    // ── C4 的**镜像半边**（监控片，规格 §4；先例 = slice-14 的 C20）──────────────
    // 真栈全形态（`/grafana/` 跟随重定向后 200 + `/metrics` 负对照）归 `slice-16-monitoring`；
    // 本片判**静态面**（Caddyfile 两条 handle 在位、写法正确、位置在 catch-all 之前）
    // + 一条**不需要 grafana 在跑**的运行期观察（裸 `/grafana` 的 301 由门口直接应答——
    // 若 redir 被写成实测坑形态，这条当场红，而不是等 slice-16 才暴露）。
    step('C4 的镜像半边（监控片）：Caddyfile 的 /grafana 两条 handle（静态） + 裸 /grafana ⇒ 301（运行期）');
    const caddySrc = readFileSync(join(REPO_ROOT, 'deploy', 'Caddyfile'), 'utf8');
    const grafanaViolations = grafanaHandleViolations(caddySrc);
    info(`/grafana handle 谓词读数：${grafanaViolations.length === 0 ? '零违规' : JSON.stringify(grafanaViolations)}`);
    checks.that(
      grafanaViolations.length === 0,
      'deploy/Caddyfile 必须含 `/grafana` 两条 handle（显式 matcher 的 301 + `reverse_proxy grafana:3010`）' +
        `且都在 catch-all 之前 —— 违规：${JSON.stringify(grafanaViolations)}`,
    );
    // 判别力自证（合成样本；R115/R150 同族）：谓词必须正/负分明 ——
    // 没有这几条，上面「零违规」在谓词写瞎（恒返回 []）时也绿。
    const GRAFANA_GOOD = [
      '\thandle /grafana {',
      '\t\tredir * /grafana/ 301',
      '\t}',
      '\thandle /grafana/* {',
      '\t\treverse_proxy grafana:3010',
      '\t}',
      '\thandle {',
      '\t\tfile_server',
      '\t}',
      '',
    ].join('\n');
    checks.eq(
      grafanaHandleViolations(GRAFANA_GOOD).length,
      0,
      '谓词正对照：合规样本（两条 handle + catch-all 在后）⇒ 零违规',
    );
    checks.that(
      grafanaHandleViolations(GRAFANA_GOOD.replace('redir * /grafana/ 301', 'redir /grafana/ 301')).length > 0,
      '谓词负对照：`redir /grafana/ 301`（第一参数被当 matcher 的**实测坑**写法）⇒ 必须违规',
    );
    const GRAFANA_BAD_ORDER = [
      '\thandle {',
      '\t\tfile_server',
      '\t}',
      '\thandle /grafana {',
      '\t\tredir * /grafana/ 301',
      '\t}',
      '\thandle /grafana/* {',
      '\t\treverse_proxy grafana:3010',
      '\t}',
      '',
    ].join('\n');
    checks.that(
      grafanaHandleViolations(GRAFANA_BAD_ORDER).length > 0,
      '谓词负对照：两条 handle 在 catch-all **之后** ⇒ 必须违规（次序是判据的一部分）',
    );
    checks.that(
      grafanaHandleViolations('\thandle {\n\t\tfile_server\n\t}\n').length > 0,
      '谓词负对照：整个 /grafana 面缺失 ⇒ 必须违规（防「谓词对缺失恒绿」）',
    );
    const grafanaRedirect = await edgeFetch('/grafana');
    info(`运行期：经门口 GET /grafana（不跟随）⇒ ${grafanaRedirect.status} · Location=${JSON.stringify(grafanaRedirect.headers.location ?? null)}`);
    checks.eq(
      grafanaRedirect.status,
      301,
      `经门口 GET /grafana ⇒ 301（裸路径由 redir handle 直接应答，不需要 grafana 在跑）—— 实际 ${grafanaRedirect.status}`,
    );
    checks.that(
      (grafanaRedirect.headers.location ?? '').endsWith('/grafana/'),
      '301 的 Location 必须指向 `/grafana/`（不得是字面量 `301` —— redir 第一参数被当 matcher 的实测坑）' +
        ` —— 实际 ${JSON.stringify(grafanaRedirect.headers.location ?? null)}`,
    );

    // ── B2′（I4b，最终评审）：**镜像层**不得含任何 `.env*`（R1202）────────────────
    // R1202 逐字要求「镜像内不得含任何 `.env*`」—— 既有判据只到**文件层**（`.dockerignore`
    // 排除了它，A6b/素材判据亦然）。`.dockerignore` 被改坏、或 Dockerfile 里多一行
    // `COPY …`，文件层都看不出来 ⇒ 必须把**镜像**拉起来查：`find /srv -name ".env*"` 为空。
    // ⚠️ 常驻判据；**镜像不在本地时只 `info` 跳过（不红）**—— 本片 B0 会构建它，正常跑法里
    //    必然在；「不在本地」只可能是单跑本步（前提缺失，不是产品缺陷）。
    // ⚠️ `--rm` + 固定 `--name`（跑前先清同名残留）：客户端被超时杀掉时 `--rm` 不会执行，
    //    固定名让下一次跑可以确定地清掉它（同 `slice-07.2-deploy` 的探针成例）。
    const edgeImage = spawnSync('docker', ['image', 'inspect', EDGE_IMAGE], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (edgeImage.status !== 0) {
      info(`镜像 ${EDGE_IMAGE} 不在本地 ⇒ 跳过「镜像内 .env*」判据（info，不红）`);
    } else {
      spawnSync('docker', ['rm', '-f', ENV_SCAN_CONTAINER], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'ignore' });
      const scan = (shExpression: string) =>
        spawnSync(
          'docker',
          ['run', '--rm', '--name', ENV_SCAN_CONTAINER, '--entrypoint', 'sh', EDGE_IMAGE, '-c', shExpression],
          { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
        );
      // 正对照（R115 同族）：先证明 find 探针**看得见**静态站产物（/srv 非空且在扫），
      // 否则「没有 .env*」在 find 写错 / 路径写错时照样绿（空测）。
      const control = scan('find /srv -name "index.html"');
      const controlOut = (control.stdout ?? '').trim();
      info(`镜像内探针正对照（find /srv -name "index.html"）：${controlOut || '（无命中）'}`);
      checks.that(
        controlOut.length > 0,
        `探针正对照：镜像内的 /srv 必须找得到 index.html（否则下面那条"无 .env*"是空测）—— 实际 ${JSON.stringify(controlOut)}`,
      );
      const envScan = scan('find /srv -name ".env*"');
      const envFound = (envScan.stdout ?? '').trim();
      info(`镜像内 .env* 扫描（find /srv -name ".env*"）：${envFound || '（无命中）'}`);
      checks.that(
        envFound === '',
        `门口镜像内**不得**含任何 .env*（R1202 —— 既有判据只到文件层；\`.dockerignore\` 的 \`**/.env*\` 不生效时这里立刻红）` +
          ` —— 实际命中：${JSON.stringify(envFound)}`,
      );
    }

    // ── B3：wss 升级 + 一次业务往返 ───────────────────────────────────
    // ⚠️ 用**真事件**（`CLIENT_MESSAGE_TYPES` 里没有 `room.list`）：`room.join` 一个
    //    **不存在的房号** ⇒ 期望 `ErrCode.ROOM_NOT_FOUND`（`12001`）。这是**确定性的业务码**
    //    （超时哨兵是 `-1` ⇒ 打不通就红），既证明升级成功、又证明服务端真的处理了这一帧。
    step('B3 经门口：注册 → wss 升级 → /ws/ddz 连接 → 一次业务往返（room.join 假房号 ⇒ 12001）');
    const user = await registerUser(9); // index 与其它 slice 错开，号码不撞
    const sock = io(`${EDGE_BASE}/ws/ddz`, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token: user.accessToken },
      rejectUnauthorized: false,
    });
    const connected = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      sock.on('connect', () => { clearTimeout(t); resolve(true); });
      sock.on('connect_error', () => { clearTimeout(t); resolve(false); });
    });
    checks.that(connected, 'wss:// 升级 + 命名空间连接必须成功（经门口）');

    const ack = await new Promise<{ code: number; message?: string }>((resolve) => {
      const t = setTimeout(() => resolve({ code: -1, message: 'ack timeout' }), 10_000);
      sock.emit('room.join', { reqId: randomUUID(), baseVersion: 0, timestamp: Date.now(), payload: { roomCode: 'ZZZZZZ' } },
        (res: { code: number }) => { clearTimeout(t); resolve(res ?? { code: -2, message: 'empty ack' }); });
    });
    checks.eq(ack.code, ErrCode.ROOM_NOT_FOUND, '一次业务往返拿到**确定性的业务码**（证明帧真的被服务端处理）');
    sock.close();

    // ── B4：限流归属（经门口 vs 直连的控制桶）────────────────────────
    step('B4 限流归属：经门口产生的桶 = 真实客户端地址（且 ≠ 门口容器地址）');
    // ⚠️ 造桶**必须**用公开且计入该维度的路径：`/api/health*` **豁免**、
    //    匿名打受保护路径会被 JwtMiddleware **先** 401（中间件顺序）⇒ 两者都不产生桶。
    const norm = (s: string) => s.replace(/^::ffff:/, '');
    const edgeIp = norm(dockerInspectIp(EDGE_CONTAINER));
    // 网桥地址 = 「容器看到的默认网关」。🔴 **判据订正（2026-09-25，CI 首次在 Linux 上跑）**：
    //    原先从 `docker network inspect … .IPAM.Config[].Gateway` 取 —— 而**那个字段平台相关**：
    //    linux runner 上**根本不存在**（诊断实测 `IPAM.Config=[{"Subnet":"172.28.0.0/16"}]`），
    //    本机 Docker Desktop 才有（`"Gateway":"172.28.0.1"`）。⇒ 改用**容器端点**的 `Gateway`
    //    （A5 已在读同一份 JSON；本机实测 `"Gateway":"172.28.0.1"`），取不到时退化为**由 subnet
    //    推第一个可用地址**（Docker 给 bridge 的默认约定）；两者都取到时**互相印证** —— 不一致就红，
    //    而不是悄悄选一个。
    const containerGw = norm(String(networksJson()[COMPOSE_NETWORK]?.Gateway ?? ''));
    const subnetOnly = spawnSync('docker', ['network', 'inspect', COMPOSE_NETWORK, '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}'],
      { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
    const subnetGw = firstUsableAddress(subnetOnly);
    const bridgeIp = containerGw || subnetGw;
    if (containerGw.length > 0 && subnetGw.length > 0) {
      checks.eq(containerGw, subnetGw, `网桥地址的两个来源必须一致（容器端点 vs subnet 推算）—— 实测容器端点 ${containerGw} / subnet ${subnetOnly} 推得 ${subnetGw}`);
    } else {
      info(`网桥地址只取到一个来源：容器端点="${containerGw}"，subnet="${subnetOnly}" 推得 "${subnetGw}"（另一来源在该平台上不可用，非缺陷）`);
    }
    if (bridgeIp.length === 0) {
      const rawIpam = spawnSync('docker', ['network', 'inspect', COMPOSE_NETWORK, '--format', '{{json .IPAM.Config}}'],
        { cwd: REPO_ROOT, encoding: 'utf8' });
      info(`B4 两个来源都取不到网桥地址 —— 诊断：IPAM.Config=${(rawIpam.stdout ?? '').trim().slice(0, 300)}；容器端点 JSON=${JSON.stringify(networksJson()).slice(0, 300)}`);
    }
    checks.that(edgeIp.length > 0 && bridgeIp.length > 0, `必须能取到 门口地址(${edgeIp}) 与 网桥地址(${bridgeIp}) —— 取不到 ⇒ 红，不许 skip`);

    // ⚠️ **先清再断言**（修复轮 3 必改 2）：`ratelimit:http-ip:*` 的 TTL 是 60s —— 上一轮
    //    （或本仓其它门禁）留下的键在 60s 内仍在 ⇒ 下面三条断言会被**旧键**满足
    //    （「记到账」与两条正向断言**空转通过**：真实回归形态 = 本轮请求根本没被计数，而旧键还在）。
    //    清空后，B4 的三条只关乎**本轮**造的桶；顺带也让 B5 的"桶记在探针自己地址上"非空转
    //    （探针容器地址逐轮相同，旧键同样能满足它）。
    const stale4 = redisLines(['KEYS', 'ratelimit:http-ip:*']);
    if (stale4.length > 0) redisLines(['DEL', ...stale4]);
    const stale4Left = redisLines(['KEYS', 'ratelimit:http-ip:*']);
    checks.that(stale4Left.length === 0, `B4 造流量前必须清空 ratelimit:http-ip:*（否则旧键让下面三条空转）—— 实际残留 ${JSON.stringify(stale4Left)}`);

    // 两条链**出自同一来源方**（都在宿主机上跑）：直连 3000（开发形态发布它）+ 经门口。
    // ⚠️ **措辞订正（M2，最终评审实测）**：本机（Docker 网桥）下这两条链在网关看到的真实客户端
    //    地址**相同**（宿主 ⇒ 网桥 `.1`）⇒ 它们产出**同一个键**，「两条链相互对照」与实现
    //    不等价，**不是**判别力来源。本步的判别力在**归属**那一半：桶必须记在真实客户端地址
    //    （网桥）上、且**不得**记在门口容器地址上（派生 IP 失效时正是后者/`unknown` 的形态）。
    // ⚠️ 这两条**同时补上 Task 3 的覆盖缺口**（T3-M1）：带 body 的 POST 经门口（Caddyfile 的
    //    `handle /api/*` + `request_body`）此前没有任何判据走过 —— B1 是 GET、B3 的注册是直连。
    const direct = await directPost('/api/auth/login', { phone: '13900000000', password: 'wrong1' });
    const viaEdge = await edgePost('/api/auth/login', { phone: '13900000000', password: 'wrong1' });
    info(`造桶两条链（**同一来源方**：宿主）：直连 ${GATEWAY_URL} ⇒ HTTP ${direct.status}；经门口 ⇒ HTTP ${viaEdge.status}（凭据是错的 ⇒ 4xx 属预期）`);

    const keys = redisLines(['KEYS', 'ratelimit:http-ip:*']);
    info(`ratelimit:http-ip 键：${keys.join(' | ') || '（无）'}`);
    checks.that(keys.length > 0, `造流量后必须**记到账**（键缺失 = 没记上，不是"不在门口地址上"）—— 实际 ${JSON.stringify(keys)}`);
    checks.that(!keys.some((k) => k.includes(edgeIp)), `桶**不得**记在门口容器地址上（那正是本片要修的 bug）—— 门口地址 ${edgeIp}`);
    // ⚠️ 比的是**键里的地址段**（精确相等），**不是**子串：`includes('172.28.0.1')` 会被
    //    `172.28.0.11`（门口！）或上一轮探针的 `172.28.0.1x` 满足 ⇒ B4 可能**空转通过**（实施者实测指出的弱点）。
    const keyAddr = (k: string): string => norm(k.split(':').slice(2).join(':'));
    checks.that(keys.some((k) => keyAddr(k) === bridgeIp), `桶必须记在**真实客户端地址**（本机 = 网桥 ${bridgeIp}）上 —— 实际 ${JSON.stringify(keys.map(keyAddr))}`);

    // ── B4′（I2，最终评审）：**WS 维度的派生 IP** 判据 ────────────────────
    // 动机：本片修的 bug 是「第 6 个玩家连不上」—— 5 条并发 WS 的 **IP 维度**。上面三条只读
    // `ratelimit:http-ip:*`（HTTP 维度）；若 WS 侧哪天拿不到 `headers`（`proxy.gateway.ts` 的
    // `requestIp` 静默退回 `'unknown'`/门口桶），本片修的 bug **原地复活且全绿** ⇒ 必须补。
    // 载体走**经门口**的连接（B3 的成例）：只有经门口才经过可信代理那一跳，「派生 IP」才有意义
    //（直连 3000 的对端天然就是真实地址，测不到派生逻辑）。
    // ⚠️ **为什么这里自开一条连接，而不是"用 B3 现成的桶"**（对计划的一处**实测订正**）：
    //    `ws-conn` 的 ZSET 成员在 `disconnect` 时被 `ZREM` 释放，最后一名成员被移除 ⇒ Redis
    //    **删掉整个键**（TTL 60s 只是崩溃兜底）。修复轮探针实测：连接期间
    //    `ratelimit:ws-conn:172.28.0.1` 存在，`sock.close()` 后 2 秒查询为空 —— 而 B3 收尾
    //    就 `sock.close()` ⇒ B4 跑到这里时它那条桶**已经不存在**。⇒ 判据自开一条、保持到
    //    三条断言跑完再关（`finally`）。
    // ⚠️ **先清再断言**（同族纪律，同上面的 `http-ip`）：`ws-conn` 键同样是 60s TTL/崩溃残留
    //    ⇒ 不清的话「至少存在一个键 / 某个键在网桥地址上」会被**旧键**满足（本轮没记上账也照样绿）。
    const staleWs = redisLines(['KEYS', 'ratelimit:ws-conn:*']);
    if (staleWs.length > 0) redisLines(['DEL', ...staleWs]);
    const staleWsLeft = redisLines(['KEYS', 'ratelimit:ws-conn:*']);
    checks.that(staleWsLeft.length === 0, `B4 的 WS 判据造桶前必须清空 ratelimit:ws-conn:*（否则旧键让下面三条空转）—— 实际残留 ${JSON.stringify(staleWsLeft)}`);

    const wsSock = io(`${EDGE_BASE}/ws/ddz`, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token: user.accessToken },
      rejectUnauthorized: false,
    });
    try {
      const wsConnected = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 10_000);
        wsSock.on('connect', () => { clearTimeout(t); resolve(true); });
        wsSock.on('connect_error', () => { clearTimeout(t); resolve(false); });
      });
      checks.that(wsConnected, 'WS 判据的前置：经门口再开一条 wss 连接必须成功（桶只在连接存活期间存在）');
      const wsKeys = redisLines(['KEYS', 'ratelimit:ws-conn:*']);
      info(`ratelimit:ws-conn 键：${wsKeys.join(' | ') || '（无）'}`);
      checks.that(
        wsKeys.length > 0,
        `经门口的一条 wss 连接必须产生 \`ratelimit:ws-conn:*\` 桶（键缺失 = 没记到账）—— 实际 ${JSON.stringify(wsKeys)}`,
      );
      checks.that(
        wsKeys.some((k) => keyAddr(k) === bridgeIp),
        `WS 连接的桶必须记在**真实客户端派生地址**（本机 = 网桥 ${bridgeIp}——派生 IP 由门口那一跳的 XFF 得出）上` +
          ` —— 实际 ${JSON.stringify(wsKeys.map(keyAddr))}`,
      );
      checks.that(
        !wsKeys.some((k) => keyAddr(k) === edgeIp),
        `WS 连接的桶**不得**记在门口容器地址（${edgeIp}）上 —— 记在那里的形态=派生 IP 退回对端地址（头没被采信）` +
          ` —— 实际 ${JSON.stringify(wsKeys.map(keyAddr))}`,
      );
    } finally {
      wsSock.close();
    }

    // ── B5：从信任边界**内部**注入的伪造负对照 ───────────────────────
    step('B5 伪造负对照（信任边界**内部**注入）：不可信对端带 XFF ⇒ 桶仍是它自己的地址');
    // ⚠️ 探针**必须**与网关同一网络、直连 `api-gateway:3000`（= 信任边界**内部**）。
    //    **不能**用"经门口带伪造头"当负对照 —— Caddy 会替我们替换掉那个头 ⇒ 那条在
    //    **修前也绿**（恒绿，等于没测）。
    // ⚠️ 探针形态**实测订正**（2026-09-24，见任务报告）：容器**退出后**在本机 Docker 上
    //    `docker inspect --format '{{.IPAddress}}'` 渲染成**字面量 `invalid IP`**（端点随退出
    //    被释放，`{{json …}}` 里是空串）⇒ 计划里的"`-d` + `sleep(3000)` + inspect"会红且原因难读。
    //    改成：探针**自报**地址（`hostname -i`）并**阻塞**跑到 curl 结束（spawnSync 的
    //    `status` = curl 的退出码）—— 不依赖"退出后 inspect"，也不依赖任何固定睡眠。
    const probe = `ftl-edge-probe-${Date.now()}`;
    const probeRun = spawnSync('docker', ['run', '--name', probe, '--network', COMPOSE_NETWORK,
      '--entrypoint', 'sh', PROBE_IMAGE, '-c',
      `hostname -i; curl -s -o /dev/null -H 'X-Forwarded-For: 9.9.9.9' -X POST -H 'content-type: application/json' -d '{"phone":"13900000001","password":"wrong1"}' http://api-gateway:3000/api/auth/login`],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });
    const probeIp = (probeRun.stdout ?? '').trim().split(/\s+/)[0] ?? '';
    info(`B5 探针（${PROBE_IMAGE}）自报地址 ${JSON.stringify(probeIp)}；curl 退出码 ${probeRun.status ?? -1}（null = 被 30s 超时杀掉）`);
    // ⚠️ 顺序**订正**（实测 2026-09-24）：**先清探针、再断言** —— brief 的顺序（断言在前）在
    //    判据失败时会**跳过** `docker rm -f` ⇒ 把探针容器留在 `docker ps -a` 里（证伪轮实漏一个）。
    //    探针是**阻塞**跑完的（curl 已结束）⇒ 此刻清它不影响任何后续观测。
    spawnSync('docker', ['rm', '-f', probe], { cwd: REPO_ROOT, encoding: 'utf8' });
    const probeLeft = spawnSync('docker', ['ps', '-a', '--filter', `name=${probe}`, '--format', '{{.Names}}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    checks.that((probeLeft.stdout ?? '').trim() === '', `B5 探针容器已清理（无残留）—— 实际 ${JSON.stringify((probeLeft.stdout ?? '').trim())}`);
    // ⚠️ brief 之外的**一处**增补：空串是**任何**字符串的子串 ⇒ 取不到地址时下面那条
    //    "桶必须记在自己地址上"会**空转**成永真（空测）。与 B4 的"取不到 ⇒ 红，不许 skip"同形。
    checks.that(probeIp.length > 0, `探针必须能自报地址（否则"桶记在自己地址上"会空转）—— 实际 stdout ${JSON.stringify(probeRun.stdout ?? '')}`);

    const after = redisLines(['KEYS', 'ratelimit:http-ip:*']);
    checks.that(!after.some((k) => k.includes('9.9.9.9')), `伪造的 9.9.9.9 **不得**产生桶 —— 实际 ${JSON.stringify(after)}`);
    checks.that(after.some((k) => keyAddr(k) === norm(probeIp)), `桶必须记在**探针容器自己的地址**上（${probeIp}）—— 实际 ${JSON.stringify(after.map(keyAddr))}`);

    // ── B6：头面契约（唯一采信的只有 XFF）────────────────────────────
    step('B6 头面契约：`Forwarded` / `X-Real-IP` 经门口 ⇒ 与不带时**逐字相同**');
    // ⚠️ **发请求前先清掉网桥那个桶**（修复轮 3 必改 1）：B4/B5 已在**同一地址（网桥）**上造过桶，
    //    60s TTL 内仍在 ⇒ 不清的话，下面第 2 条正向断言读的是**整副键集**，即使本次请求根本
    //    没被计数（真实回归形态：带 `Forwarded`/`X-Real-IP` 的请求**静默绕过限流**）它也**照样绿**
    //    —— 声称了断言没有的覆盖。清掉**网桥地址段**的所有桶（含 `::ffff:` 前缀形态 ——
    //    `keyAddr` 已归一；`DEL` 不存在的键是 no-op）后，"存在一个网桥地址的桶"就只能来自本次请求。
    const pre6 = redisLines(['KEYS', 'ratelimit:http-ip:*']);
    const staleBridge6 = pre6.filter((k) => keyAddr(k) === bridgeIp);
    if (staleBridge6.length > 0) redisLines(['DEL', ...staleBridge6]);
    const before = redisLines(['KEYS', 'ratelimit:http-ip:*']).sort();
    checks.that(!before.some((k) => keyAddr(k) === bridgeIp), `B6 发请求前网桥桶（${bridgeIp}）必须已清（否则第 2 条正向断言会被旧键满足 ⇒ 空转）—— 实际 ${JSON.stringify(before.map(keyAddr))}`);
    await edgePost('/api/auth/login', { phone: '13900000002', password: 'wrong1' }, {
      forwarded: 'for=7.7.7.7', 'x-real-ip': '6.6.6.6',
    });
    const after6 = redisLines(['KEYS', 'ratelimit:http-ip:*']).sort();
    checks.that(!after6.some((k) => k.includes('7.7.7.7') || k.includes('6.6.6.6')), `这两个头**不得**影响派生 IP（R1204）—— 实际 ${JSON.stringify(after6)}`);
    // ⚠️ brief 之外的**一处**增补（规格 §5 的 B6 行明写「键缺失要**响亮**」）：只查"没有
    //    7.7.7.7/6.6.6.6"在"这条请求根本没被计数"时也是绿的 ⇒ 必须同时证明桶**仍在真实客户端地址上**。
    //    修复轮 3 起这条**有判别力**：发请求前已清掉网桥桶 ⇒ 键存在**只能**是本次请求造成的
    //    （清桶前的老形态读整副键集，被 B4 的旧键满足 —— 即便本次没被计数也照样绿）。
    checks.that(after6.some((k) => keyAddr(k) === bridgeIp), `带这两个头时桶必须**重新记在**真实客户端地址（${bridgeIp}）上（发请求前已清桶 ⇒ 键缺失 = 这次没记到账）—— 实际 ${JSON.stringify(after6.map(keyAddr))}`);
    // 纯描述（修复轮 3 必改 4）：只报实测的前后键数与地址列表 —— 不构成判断
    //（键数的任何变化都可能来自 TTL，不可当"这两个头没影响"的证据；那条由上面两条断言钉）。
    info(`B6 实测键集（地址段）：${before.length} → ${after6.length} 条 · 前 ${JSON.stringify(before.map(keyAddr))} · 后 ${JSON.stringify(after6.map(keyAddr))}`);
  } finally {
    // ⚠️ **收尾必须在 `finally` 里**（B0–B6 的断言中途抛错时若不收尾，容器会留给下一轮
    //    ⇒ 下一轮的"无残留"判据**假红**）。
    // ⚠️ `timeout: 120_000`（Step 0 订正）：`docker compose rm` 挂住会把**整个 slice 吊死**
    //    （同 `slice-07.2-deploy.ts` 的 `runOneShot` 成例：超时用 `spawnSync` 原生能力）。
    const down = compose({ timeout: 120_000 }, '--profile', 'edge', 'rm', '-sf', 'edge');
    info(`收尾 docker compose --profile edge rm -sf edge ⇒ exit ${down.code}`);
    if (down.code !== 0) info(`收尾输出（尾部 400 字）：${down.out.slice(-400)}`);

    // ⚠️ **复原网关的开发默认形态**（`TRUST_PROXY=` 空 —— override 的 `${TRUST_PROXY:-}` 是
    //    **透传 + 默认空**）：B0 会把 `ftl-api-gateway` 重建为**注入形态**而不复原 ⇒ 残留的
    //    注入态会让**下一轮**的 B4/B5/B6 变成**空测**（注入路径真坏了也照样绿 —— 正是 B0 要防的）。
    //    ⚠️ **不能**走上面的 `compose()` 助手（它的 env 会把 `TRUST_PROXY=门口地址` 再注入一遍）
    //    —— 这里要的是**宿主** env（未设 ⇒ 空）。
    const restore = spawnSync('docker', ['compose', 'up', '-d', '--no-deps', 'api-gateway'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    info(`收尾 docker compose up -d --no-deps api-gateway（复原开发默认形态）⇒ exit ${restore.status ?? -1}`);
    if ((restore.status ?? -1) !== 0) {
      info(`复原输出（尾部 400 字）：${`${restore.stdout ?? ''}${restore.stderr ?? ''}`.slice(-400)}`);
    }

    // ⚠️ **必须把门口起回来**：本片按契约只测生命周期（起/删），但删完之后
    //    `slice-16-monitoring`（C4 经门口）/`slice-19`/`slice-24` 都要 `ftl-edge` 在场。
    //    2026-10-26 dev 全序实测：只复原 api-gateway ⇒ 后续三片全部 `No such object: ftl-edge`。
    //    用同一个 `compose()` 助手（带 EDGE_HTTPS_PORT/EDGE_HTTP_PORT/TRUST_PROXY 与 profile）。
    const restoreEdge = compose(
      { timeout: 120_000 },
      '--profile',
      'edge',
      'up',
      '-d',
      '--no-deps',
      '--wait',
      '--wait-timeout',
      '120',
      'edge',
    );
    info(`收尾 docker compose --profile edge up -d --no-deps edge（复原常态化门口）⇒ exit ${restoreEdge.code}`);
    if (restoreEdge.code !== 0) info(`复原门口输出（尾部 400 字）：${restoreEdge.out.slice(-400)}`);
  }
  // ⚠️ 2026-10-26：收尾现在**故意**把 `ftl-edge` 起回来（后续 slice-16/19/22/24 都要它），
  //    所以这里判「已复原且 healthy」，而不是「无残留」。旧镜像残留仍由 B0 之前的清理负责
  //    （`docker ps -a` 精确名命中会被先删）。
  const edgeState = spawnSync(
    'docker',
    ['inspect', EDGE_CONTAINER, '--format', '{{.State.Status}}/{{.State.Health.Status}}'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const edgeStatus = (edgeState.stdout ?? '').trim();
  checks.that(
    edgeStatus === 'running/healthy',
    `收尾后 ${EDGE_CONTAINER} 已复原并 healthy（后续切片依赖门口）—— 实际 ${JSON.stringify(edgeStatus)}`,
  );
  // ⚠️ 收尾的**阳性自证**（Task 3 交接的缺口）：网关必须**真的**回到开发默认形态。
  //    它既是本轮的证据，也是**下一轮非空测**的前提；`TRUST_PROXY=` 是**恰好**元素
  //    （用 `includes('TRUST_PROXY=')` 判原文会把 `TRUST_PROXY=172.…` 也判真 ⇒ 必须逐元素比）。
  const gwEnv = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{json .Config.Env}}'], { cwd: REPO_ROOT, encoding: 'utf8' });
  let gwEnvArr: string[] = [];
  try {
    gwEnvArr = JSON.parse((gwEnv.stdout ?? '').trim()) as string[];
  } catch {
    gwEnvArr = [];
  }
  checks.that(
    gwEnvArr.includes('TRUST_PROXY='),
    `收尾后网关回到开发默认形态（TRUST_PROXY 为**空值** —— 非空 = 注入态残留 ⇒ 下一轮 B4/B5/B6 会空测）` +
      ` —— 实际 ${JSON.stringify(gwEnvArr.filter((e) => e.startsWith('TRUST_PROXY')))}`,
  );
  return checks; // ⚠️ 必须**返回** checks（run.ts 靠它统计断言数）
}

/**
 * `docker inspect <容器>` 的网内地址（取不到时为空串，由调用方**响亮**处理）。
 *
 * ⚠️ **只对运行中的容器可靠**：容器退出后 Docker 释放其网络端点（`{{json .NetworkSettings.Networks}}`
 * 里 `IPAddress` 是空串），`{{.IPAddress}}` 会渲染成**字面量 `invalid IP`**（本机实测 2026-09-24）
 * —— 需要已退出容器的地址时，请让容器**自报**（见 B5 的 `hostname -i`）。
 */
function dockerInspectIp(container: string): string {
  const r = spawnSync(
    'docker',
    ['inspect', container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

/**
 * **直连**网关宿主发布端口的 POST（开发形态发布 3000）—— B4 的第二条造桶链。
 *
 * ⚠️ **措辞订正（M2，最终评审）**：它与 `edgePost` **同一来源方**（都在宿主机上跑），
 * docker 网桥下两条链在网关看到的真实客户端地址**相同**（本机 = 网桥网关地址）⇒ 产出
 * **同一个桶** —— 因此这条链**不是**独立对照（此前的注释说「两个桶归一化后必须相等」，
 * 把一条实现上不存在的比较说成了判据）。它在本步的价值是**覆盖**：让经网关联的
 * 3000 直连 POST（带 body）也被计入一次。
 */
async function directPost(path: string, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text(); // 排空响应体（否则连接不释放）
  return { status: res.status, body: text };
}

/**
 * 经门口 POST 一次（自签证书 ⇒ `rejectUnauthorized: false`）。
 *
 * `extraHeaders` 用于**故意**带不该带的头（B6 的 `Forwarded` / `X-Real-IP`）。
 */
function edgePost(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  // ⚠️ 别把局部变量取名 `body` / `headers`：它们会遮蔽同名参数（读起来像用了入参，实则没有）。
  const payload = JSON.stringify(body);
  return httpsRequest('POST', path, {
    body: payload,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...extraHeaders,
    },
  });
}

/**
 * 走门口的一次 HTTPS 请求（自签证书 ⇒ `rejectUnauthorized: false`）。`path` 以 `/` 开头。
 *
 * ⚠️ 用 `node:https` 而**不是** `fetch` —— undici 不接受 per-request 的 `rejectUnauthorized`；
 * 也**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，那是进程级、会影响同轮其它 slice。
 */
function httpsRequest(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const u = new URL(`${EDGE_BASE}${path}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method,
        rejectUnauthorized: false,
        ...(opts.headers ? { headers: opts.headers } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, string> }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** 统一收 **path**（别混用整 URL）：`edgeFetch('/api/health')`。 */
const edgeFetch = (path: string) => httpsRequest('GET', path);
