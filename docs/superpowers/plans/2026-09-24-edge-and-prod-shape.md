# 门口容器与上线形态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让站点能以一个「加密 + 发网页 + 转发」的门口容器对外服务（生产形态只发布 80/443、`api-gateway` 退为网内），并让网关在门口之后**仍然按真实客户端 IP 计限流**。

**Architecture:** 新增第 9 个容器 `edge`（自建镜像：阶段一在镜像内构建 H5，阶段二 `caddy:2-alpine` + 产物 + `deploy/Caddyfile`）。生产形态只有门口发布宿主端口；`api-gateway` 只 `expose`。网关内新增**唯一一处**「可信客户端 IP」解析器（先验对端可信、再采信 `X-Forwarded-For`），HTTP 限流中间件与 WS `allowRequest` 共用；信任**只给门口一跳**（compose 网络钉死 subnet + 门口固定地址）。

**Tech Stack:** Docker Compose v2 · Caddy 2（`caddy:2-alpine`）· NestJS 10 / Express（api-gateway）· `proxy-addr`（Express 内部同款）· vitest · 既有 conformance runner（`tools/conformance`）

**设计真源：** `docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md`（R1201–R1212 · 判据 A1–A9 / B0–B6 / C1–C8 / D）。**任务与判据的编号一律以它为准**；本计划只负责「怎么落地」。

## Global Constraints

- **判据只增不减**：各包与各 conformance slice 的条数**不得回退**；新增条数在回填时逐项列出。
- **探针逐字不变**：`scripts/browser-e2e.mjs` 的 blob 必须仍是 `052b98b7ab779ae280d6673729053145e9829604`；`gate 18/18` · `full 33/33`。
- **零客户端改动**：`apps/client/src/**` 一个字节都不动（R1211）。
- **文档复核实「逐行」**（「旧句在该文件内不存在 + 新句存在」），**不做**全仓 0 命中；全仓 grep 排除 `.worktrees/**`、`**/dist/**`、`docs/superpowers/**`。
- **条数不预测**：任何跨文件条数（slice 断言数、包测试数）**留白给实施者实测**并写进提交信息 —— 本仓为此栽过（计划里写死的预测与实测不符）。
- **Windows Git Bash**：容器内执行一律 `node -e` / `sh -c 'cd …'`；`docker run -v` 用 `D:/Code/pokergame/...` 正斜杠形式（别让 MSYS 转路径）。
- **环境纪律**：docker 栈热着（8 容器）。**跑真栈判据前先重建镜像**（`DOCKER_BUILDKIT=0 docker compose build <svc> && docker compose up -d <svc>`），并照 §4-2 查 DI 陷阱：`docker compose logs <svc> --since 30s | grep -i error`。
- 每个任务**先写/改判据 → 跑红 → 实现 → 跑绿 → 提交**。
- **`checks.eq` 用 `!==` 比较 ⇒ 数组/对象字面量永远不相等**（R176）：判数组用 `checks.that(arr.length === 0, msg + arr.join(' | '))`，判对象先 `JSON.stringify` 成字符串再比。
- **slice 的签名是 `export async function runSliceX(): Promise<Checks>`**，结尾 `return checks;`（`run.ts` 靠返回值统计断言数）。

## 与 spec §9 的两处计划期偏差（登记）

1. **A4/A5 提前到 Task 2**：spec §9 把它们放在 B 段，但它们是**纯渲染判据**（不依赖解析器）⇒ 与 A1/A2/A3/A8/A9 同批落地，省一轮 slice 改动与复跑。
2. **手册（R1212）移到末段 Task 6**：spec §9 的 A 段完成判据里提到「手册可执行（除可信 IP 一节）」；本计划一次写全（含可信 IP 一节），避免同一文件改两轮。

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `deploy/Caddyfile` | 新建 | 门口配置**唯一真源**（参数化到"生产与本机只差环境变量"） |
| `Dockerfile.edge` | 新建 | 两段式：镜像内构建 H5 → `caddy:2-alpine` + 产物 + 配置 |
| `.dockerignore` | 改 | 补 `**/.env*`（R1212 会把真密钥写进仓库根 `.env`） |
| `docker-compose.yml` | 改 | 加 `edge` 服务（含 ipam 固定地址、`caddy-data` 卷、healthcheck、日志上限）；`api-gateway` 的 `ports` → `expose` + **字面** `TRUST_PROXY`；网络钉 `ipam.config.subnet` |
| `docker-compose.override.yml` | 改 | `edge` 的 `profiles: ["edge"]` + 本机默认值；`3000` 的宿主映射**移进这里**；`TRUST_PROXY=${TRUST_PROXY:-}` |
| `packages/api-gateway/src/http/trusted-client-ip.ts` | 新建 | 可信客户端 IP 的**唯一实现**（R1204/R1206/R1207） |
| `packages/api-gateway/src/http/http-rate-limit.middleware.ts` | 改 | `clientIp()` 改用解析器 |
| `packages/api-gateway/src/gateway/proxy.gateway.ts` | 改 | `requestIp()` 改用解析器 |
| `packages/api-gateway/package.json` | 改 | `dependencies` + `proxy-addr`；`devDependencies` + `@types/proxy-addr` |
| `packages/api-gateway/test/trusted-client-ip.test.ts` | 新建 | C1–C6、C8 |
| `tools/conformance/src/slices/slice-07.2-deploy.ts` | 改 | A1/A2/A3（替换原 ① 两条）· A5/A9 · A6a/A6b · A7 运行期半边 · A8（`isolatedEnv`） |
| `tools/conformance/src/slices/slice-07.3-edge.ts` | 新建 | B0–B6（真栈） |
| `tools/conformance/src/run.ts` · `tools/conformance/package.json` | 改 | 注册并暴露 `slice-07.3-edge` |
| `docs/ops/first-deploy.md` | 新建 | 首次上线手册（八节，每条命令带预期输出） |
| `docs/design.md` · `README.md` · `scripts/dev.sh` | 改 | §0.6 全表同步（逐行复核） |

---

## Task 1: 门口镜像与配置（R1202 · A6a/A6b · B2 的前置）

**Files:**
- Create: `deploy/Caddyfile`
- Create: `Dockerfile.edge`
- Modify: `.dockerignore`
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`（加 A6a/A6b）

**Interfaces:**
- Produces: 镜像 `ftl-edge`（内含 `/srv` 的 H5 产物与 `/etc/caddy/Caddyfile`）· `deploy/Caddyfile` 的参数契约（`SITE_ADDRESS` / `TLS_MODE`）· A6a/A6b 两个判据。
- Consumes: 既有 `slice-07.2-deploy.ts` 的 `checks`/`info`/`step` 与 `composeConfig()`。

- [ ] **Step 1: 先写闸 A6b（红）**

在 `tools/conformance/src/slices/slice-07.2-deploy.ts` 的 ① 区块之后加：

```ts
    // ── ①e A6b：门口配置的**文本闸** —— 自签只能经变量传入 ──
    const caddyfile = readFileSync(join(REPO_ROOT, 'deploy', 'Caddyfile'), 'utf8');
    const literalInternal = /^\s*tls\s+internal\b/m.test(caddyfile);
    checks.that(
      !literalInternal,
      `deploy/Caddyfile 的 \`tls\` 只经 \`{\$TLS_MODE}\` 传入（自签只能经变量，非字面量）—— 实际命中：${literalInternal}`,
    );
```

（`REPO_ROOT`/`readFileSync`/`join`：文件里已有 `REPO_ROOT` 与 `node:fs`/`node:path` 的既有导入则复用，缺哪个补哪个。）

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.2-deploy`
Expected: **红**（`ENOENT: deploy/Caddyfile`）—— 这就是"文件还不存在"的判别力。

- [ ] **Step 2: 写 `deploy/Caddyfile`（唯一真源）**

```caddyfile
# deploy/Caddyfile —— 门口配置的**唯一真源**。本机与生产**只差环境变量**：
#   本机：SITE_ADDRESS=localhost:8443  TLS_MODE=internal（自签）
#   生产：SITE_ADDRESS=<域名>          TLS_MODE=<ACME 邮箱>（自动签发）
# ⚠️ 两个变量**无默认值** ⇒ 未配置时 Caddy 启动即失败（fail-closed，与 INTERNAL_SERVICE_TOKEN 同一成例）。
# ⚠️ 不得写死 `tls internal`（判据 A6b 会红）。
{
	admin off
}

{$SITE_ADDRESS} {
	tls {$TLS_MODE}
	encode gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
	}

	request_body {
		max_size 1MB
	}

	# 访问日志走 stdout ⇒ 上限由 compose 的 logging.options（json-file）承担。
	# ⚠️ 不要 `output file` —— json-file 的上限**管不到**容器可写层里的文件。
	log {
		output stdout
	}

	handle /api/* {
		reverse_proxy api-gateway:3000
	}
	handle /socket.io* {
		reverse_proxy api-gateway:3000
	}
	handle {
		root * /srv
		file_server
	}
}
```

- [ ] **Step 3: 写 `Dockerfile.edge`**

```dockerfile
# platform/Dockerfile.edge —— 门口（TLS 终止 + H5 静态站 + 反代）。两段式：
#   阶段一在**镜像内**构建 H5（宿主 dist 不进镜像 —— 部署原则：容器不依赖宿主产物）。
#   阶段二只把产物与配置塞进 caddy 官方镜像。
# ⚠️ 不得 COPY 任何 `.env*`（R1202 契约；`.dockerignore` 已排除）。
FROM node:20-slim AS web
WORKDIR /app
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./
# 每个包的 tsconfig.json 都 extends 它；缺了它 tsc 会退回默认 target（ES5）
COPY tsconfig.base.json ./
# 依赖方向：protocol 零依赖 → client 依赖 protocol
COPY packages/protocol ./packages/protocol
COPY packages/shared ./packages/shared
COPY apps/client ./apps/client
RUN npm install -g pnpm@9.15.0 && pnpm install --no-frozen-lockfile --ignore-scripts
RUN pnpm --filter @fight-the-landlord/protocol build \
 && pnpm --filter @fight-the-landlord/client build:h5

FROM caddy:2-alpine
COPY --from=web /app/apps/client/dist/build/h5 /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# 证书与 ACME 账户库落在 /data ⇒ **必须**挂命名卷（否则每次重建都重签 ⇒ 撞 Let's Encrypt 配额）
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fs -o /dev/null http://localhost/ || exit 1
```

- [ ] **Step 4: `.dockerignore` 补一行**

```
**/.env*
```

（放在既有 `**/dist` 附近；它同时把 `apps/client/.env.development.local` 与 R1212 要建的仓库根 `.env` 挡在镜像外。）

- [ ] **Step 5: 跑 A6b 变绿 + 语法/行为实测**

Run:
```bash
pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.2-deploy
# 语法：喂值 ⇒ 0；任一为空 ⇒ 非 0（A6a 的运行层）
docker run --rm -v "D:/Code/pokergame/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e SITE_ADDRESS=localhost:8443 -e TLS_MODE=internal caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker run --rm -v "D:/Code/pokergame/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e SITE_ADDRESS= -e TLS_MODE=internal caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; echo "exit=$?"
```
Expected: slice 的 A6b 绿；第一条 `Valid configuration`（exit 0）；第二条报 `server block without any key` 且 **`exit=1`**。

- [ ] **Step 6: A6a 的两层都在 Task 2 Step 5 落地**

本任务只交 A6b（文本闸）与镜像；A6a 的「渲染层断言 + 运行层 `exit≠0` + 显式喂值的负对照」**全部在 Task 2 Step 5**（它需要 `edge` 服务已存在于 compose 里）。

- [ ] **Step 7: 实测「镜像内构建 H5」在真镜像上成立**

Run:
```bash
DOCKER_BUILDKIT=0 docker build -f Dockerfile.edge -t ftl-edge-probe .
docker run --rm --entrypoint sh ftl-edge-probe -c 'ls /srv; ls /srv/assets | head -3; grep -c "localhost:3000" -r /srv || true'
# ⚠️ 泄漏面只看**dev 环境值**（局域网 IP / dev token），**不要**断言「VITE_* 一个都不出现」：
#    `VITE_` 是 client 源码里的字符串（`config.ts` 实测 6 处），宿主与镜像两边一样多 ⇒ 那种断言是**假红形态**。
docker run --rm --entrypoint sh ftl-edge-probe -c 'grep -rl "192.168.5.27\|dev-internal-token" /srv || echo "(no dev env values leaked)"'
docker run --rm --entrypoint sh ftl-edge-probe -c 'find /app -name ".env*" | head; find /srv -name ".env*" | head; echo "(应两处皆空)"'
docker rmi -f ftl-edge-probe
```
Expected: `/srv` 含 `assets/ index.html static/`；**没有 dev 环境值**；两处 `.env*` 查询皆空；`localhost:3000` 的命中数与宿主 dist 一致（**唯一那处是不可达兜底**，见 spec §0.2 —— 不得把它写成判据）。

- [ ] **Step 8: 提交**

```bash
git add deploy/Caddyfile Dockerfile.edge .dockerignore tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "feat(edge): 门口镜像与配置（R1202）+ A6b 文本闸"
```

---

## Task 2: compose 三形态改造（R1203/R1205/R1209 · A1/A2/A3/A4/A5/A8/A9）

**Files:**
- Modify: `docker-compose.yml`、`docker-compose.override.yml`
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`

**Interfaces:**
- Consumes: Task 1 的 `Dockerfile.edge` 与 `deploy/Caddyfile`；既有 `hostArtifactMounts()` / `servicesWithoutLogLimit()` / `isolatedEnv()` / `publishedServices()` / `composeConfig()`。
- Produces: 三形态（8 / 9 / 9）与固定地址契约（`services.edge.networks["ftl-platform"].ipv4_address` = `services.api-gateway.environment.TRUST_PROXY`）。

- [ ] **Step 1: 基文件 —— 网络钉 subnet + 门口服务**

在 `docker-compose.yml` 末尾的网络声明处：

```yaml
networks:
  ftl-platform:
    # ⚠️ **钉死 subnet**（R1205）：门口要一个**固定地址**当"唯一可信代理"，
    #    而固定地址必须落在声明过的网段里。⚠️ 选段要避让宿主上其它 docker 网络。
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

`api-gateway` 服务：把 `ports: ["3000:3000"]` **删掉**，改为：

```yaml
    expose:
      - "3000"
    environment:
      # …（既有变量不动）
      # ⚠️ **可信代理 = 门口一跳**（R1205）。值必须与 edge 的 ipv4_address **逐字相同**
      #    （判据 A5 会在同一份 config --format json 里比这两处）。
      - TRUST_PROXY=172.28.0.250
```

新增 `edge` 服务（放在 `api-gateway` 之后）：

```yaml
  edge:
    build:
      context: .
      dockerfile: Dockerfile.edge
    image: ftl-edge:latest
    # ⚠️ 与本仓既有 8 个服务同形（`ftl-<svc>`）—— A7 的运行期条目与 Task 3/5 的生命周期判据
    #    都按**这个名字**找容器；不加 ⇒ 容器叫 `pokergame-edge-1` ⇒ 那些判据**恒空测**。
    container_name: ftl-edge
    restart: unless-stopped
    ports:
      # ⚠️ 宿主侧才跟 EDGE_HTTP_PORT 走：容器内那个跳转监听**固定是 :80**
      - "${EDGE_HTTP_PORT:-80}:80"
      - "${EDGE_HTTPS_PORT:-443}:${EDGE_HTTPS_PORT:-443}"
    environment:
      # ⚠️ **无默认值** ⇒ 未配置 ⇒ 容器内为空 ⇒ Caddy 启动即失败（fail-closed）
      - SITE_ADDRESS=${SITE_ADDRESS:-}
      - TLS_MODE=${TLS_MODE:-}
    volumes:
      # 证书与 ACME 账户库（R1202；命名卷 ⇒ 不算宿主产物挂载，①c 不受影响）
      - caddy-data:/data
    networks:
      ftl-platform:
        # 固定地址（R1205）⇒ A5 用它当"唯一可信代理"的锚
        ipv4_address: 172.28.0.250
    depends_on:
      api-gateway:
        condition: service_started
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
    healthcheck:
      # ⚠️ 必须**形态无关**：`curl -fk https://localhost:<port>/` 只在站点 host 是 localhost 时成立
      #    ⇒ 生产用域名会握手失败、永远 unhealthy。走容器内那个 :80 跳转监听（两种形态都 308）。
      test: ["CMD", "curl", "-fs", "-o", "/dev/null", "http://localhost/"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
```

并在文件顶部的 `volumes:` 段加 `caddy-data:`（与既有 `redis-data`/`mysql-data` 同形）。

- [ ] **Step 2: override —— 门口按需启动 + 把 3000 收进来**

```yaml
  api-gateway:
    ports:
      # ⚠️ 3000 的宿主映射**从基文件移到这里**（R1203）：生产形态不发布它。
      - "3000:3000"
    environment:
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}
      # ⚠️ **透传 + 默认空**（不是"无条件置空"）：宿主未设 ⇒ 空（= 不信任何人）；
      #    宿主 export 了 ⇒ 会漏进来 ⇒ A8 必须把该变量剔出渲染环境。
      - TRUST_PROXY=${TRUST_PROXY:-}

  edge:
    # 按需启动：日常 `docker compose up -d` 仍是 8 个容器
    profiles: ["edge"]
    environment:
      - SITE_ADDRESS=localhost:${EDGE_HTTPS_PORT:-8443}
      - TLS_MODE=internal
```

- [ ] **Step 3: 替换原 ① 的两条 + 加 A2/A9（先红）**

把 `slice-07.2-deploy.ts` 里 `basePublished === ['api-gateway']` 与 `gatewayPorts === ['3000']` 两条**替换**为：

```ts
    // ── ①a A1：生产形态**只有门口**发布宿主端口（替换原"只有 api-gateway"）──
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

    // ── ①b A2：api-gateway 生产形态**零发布**、仍 expose 3000 ──
    const gwPorts = (base.services?.['api-gateway']?.ports ?? []).length;
    const gwExpose = (base.services?.['api-gateway']?.expose ?? []).map(String);
    checks.eq(gwPorts, 0, '生产形态 api-gateway 零宿主端口发布（R1203）');
    checks.that(
      gwExpose.includes('3000'),
      `生产形态 api-gateway 仍 expose 3000（网内可达）—— 实际 ${JSON.stringify(gwExpose)}`,
    );

    // ── ①d A9：门口的证书库必须持久化（缺它 ⇒ 每次重建重签 ⇒ 撞 ACME 配额）──
    const edgeVolumes = (base.services?.edge?.volumes ?? []) as any[];
    checks.that(
      edgeVolumes.some((v) => String(v?.target) === '/data'),
      `门口必须挂命名卷到 /data（证书与 ACME 账户库）—— 实际 ${JSON.stringify(edgeVolumes)}`,
    );
```

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.2-deploy`
Expected: **绿**（compose 已在 Step 1–2 改好）；若你把 Step 3 写在 Step 1 之前 ⇒ 先红后绿。

- [ ] **Step 4: A4/A5（信任渲染两处一致）+ A8（isolatedEnv）**

```ts
    // ── ①g A5：门口的**固定地址** == api-gateway 的 TRUST_PROXY（同一份 json 里两处相比）──
    const edgeAddr = base.services?.edge?.networks?.['ftl-platform']?.ipv4_address ?? null;
    const trustProxy = base.services?.['api-gateway']?.environment?.TRUST_PROXY ?? null;
    checks.that(
      typeof edgeAddr === 'string' && edgeAddr.length > 0,
      `生产形态门口必须有字面固定地址（取到 ${JSON.stringify(edgeAddr)} —— null/undefined 一律算红）`,
    );
    checks.eq(trustProxy, edgeAddr, 'TRUST_PROXY 必须**逐字等于**门口的固定地址（防两处漂移）');
```

以及 `isolatedEnv()`：

```ts
/** 剔除父进程同名变量：渲染判据不得随宿主 shell 漂移（R147 的延伸）。 */
const ISOLATED_KEYS = [
  'INTERNAL_SERVICE_TOKEN',
  'TRUST_PROXY',
  'SITE_ADDRESS',
  'TLS_MODE',
  'EDGE_HTTP_PORT',
  'EDGE_HTTPS_PORT',
];
function isolatedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !ISOLATED_KEYS.includes(k)));
}
```

开发形态半边（② 组里）：

```ts
    // ── ②e A4：开发形态的信任表默认**空**（宿主未设时）；负对照在 A5 ──
    checks.eq(
      (dev.services?.['api-gateway']?.environment?.TRUST_PROXY ?? '') || '',
      '',
      '开发形态 TRUST_PROXY 默认渲染为空',
    );
```

- [ ] **Step 5: A6a 的第二层（渲染 + 运行）与负对照**

```ts
    // ── ①f A6a：fail-closed 两层 —— (i) 不喂值 ⇒ 渲染为空；(ii) 喂值 ⇒ 非空 ──
    const edgeEnv = (base.services?.edge?.environment ?? {}) as Record<string, string>;
    checks.eq(edgeEnv.SITE_ADDRESS ?? '', '', '生产形态不给 SITE_ADDRESS ⇒ 渲染为空');
    checks.eq(edgeEnv.TLS_MODE ?? '', '', '生产形态不给 TLS_MODE ⇒ 渲染为空');
```

负对照（**必须显式喂值** —— 空 env-file 取不到非空值）：

```ts
    const fed = composeConfig(['-f', 'docker-compose.yml'], {
      SITE_ADDRESS: 'example.com',
      TLS_MODE: 'ops@example.com',
    });
    checks.eq(
      fed.services?.edge?.environment?.SITE_ADDRESS,
      'example.com',
      '显式喂 SITE_ADDRESS ⇒ 渲染出该值（负对照；证明上一条不是"恒空"）',
    );
```

（`composeConfig(args, extraEnv?)`：给既有函数加可选第二参，把它并进传给 `execFileSync` 的 `env` —— 与 `isolatedEnv()` 同一处。）

- [ ] **Step 6: A7 的运行期半边（若在跑 ⇒ 上限必须对）**

在 `LOG_LIMIT_TARGETS` 加 `'ftl-edge'`，并把该循环改成**按形态**：

```ts
        // 「没在跑」只 info（既有形态）⇒ 对 ftl-edge 而言那是**静默通过**。
        // 语义：**若**门口在跑 ⇒ 它的日志上限必须对；「不存在」是 B0 的残留闸，不在这里判。
```

- [ ] **Step 7: 钉死的网段会让网络重建一次 —— 实测收尾**

Run:
```bash
docker compose down && docker compose up -d && sleep 20 && docker compose ps --format "table {{.Service}}\t{{.Status}}"
docker network inspect pokergame_ftl-platform --format '{{range .IPAM.Config}}subnet={{.Subnet}}{{end}}'
```
Expected: 8 个容器 healthy；子网 = `172.28.0.0/16`。（本次 `down` 只重建**网络与容器**，命名卷数据不丢。）

- [ ] **Step 8: 提交**

```bash
git add docker-compose.yml docker-compose.override.yml tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "feat(compose): 门口服务 + 端口收敛（生产只发 80/443）+ 信任锚（R1203/R1205/R1209）"
```

---

## Task 3: 真栈 —— 生命周期与三条链（R1202/R1208 · B0/B1/B2/B3）

**Files:**
- Create: `tools/conformance/src/slices/slice-07.3-edge.ts`
- Modify: `tools/conformance/src/run.ts`、`tools/conformance/package.json`

**Interfaces:**
- Consumes: `Checks`/`step`/`info`/`sleep`（`lib/assert`）· `registerUser`（`lib/http`）· `socket.io-client`（已有依赖）。
- Produces: `runSlice073Edge()`；`pnpm --filter @fight-the-landlord/conformance conformance:slice-07.3-edge`。

- [ ] **Step 1: 建 slice 骨架 + 注册**

`tools/conformance/src/slices/slice-07.3-edge.ts`：

```ts
/**
 * conformance 用例：**门口**（TLS 终止 + H5 静态站 + 反代）的三条链（spec B1–B3）
 * 与生命周期协议（B0）。⚠️ 生命周期是判据的一部分：
 *   - `--profile` 是**全局参数**（必须写在子命令**之前**）；
 *   - `down` **删不掉**带 profile 的容器 ⇒ 旧门口容器常驻会让本 slice 全部**测旧镜像**；
 *   - `up -d edge`（只点名服务）**不重建 api-gateway** ⇒ 注入到不了网关 ⇒ B4/B6 变空测。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { Checks, info, sleep, step } from '../lib/assert';
import { registerUser } from '../lib/http';
import { ErrCode } from '@fight-the-landlord/protocol';
import { io } from 'socket.io-client';

const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';
const EDGE_BASE = `https://localhost:${EDGE_HTTPS_PORT}`;
const EDGE_TRUST_ADDR = '172.28.0.250'; // 与基文件的 ipv4_address 同值（A5 钉着两处一致）
const EDGE_CONTAINER = 'ftl-edge';
const COMPOSE_PROJECT = 'pokergame';
const COMPOSE_NETWORK = `${COMPOSE_PROJECT}_ftl-platform`;
```

`run.ts`：`import { runSlice073Edge } from './slices/slice-07.3-edge';` + 注册表加
`'slice-07.3-edge': { title: '门口（TLS/静态站/反代 + 可信 IP）', run: runSlice073Edge },`
`package.json`：加 `"conformance:slice-07.3-edge": "node dist/run.js slice-07.3-edge"`。

- [ ] **Step 2: B0 生命周期 + 自证注入到位**

```ts
export async function runSlice073Edge(): Promise<void> {
  const checks = new Checks();
  // ⚠️ 开头**先清一次残留**（同 `slice-07.2-deploy` 的 `removeProbeContainer()` 成例）：
  //    上一次若在收尾前抛错，`ftl-edge` 会留到这一轮 ⇒ 本轮的"无残留"判据会**假红**。
  spawnSync('docker', ['rm', '-f', EDGE_CONTAINER], { encoding: 'utf8', stdio: 'ignore' });
  // ⚠️ 启动时也**幂等自愈**网关（控制者裁定，回应 Task 5 实施者的提问）：上一轮若被 Ctrl-C / 管道
  //    SIGPIPE 中断，`finally` **不会**跑 ⇒ 网关停在**注入态**；此时若先跑步别的门禁，就会量到错形态。
  //    仅在**非空**时重建（避免无谓开销）。
  let gwEnv0 = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
    { encoding: 'utf8' }).stdout ?? '';
  if (!/^TRUST_PROXY=$/m.test(gwEnv0)) {
    info('启动自愈：网关停在注入态 ⇒ 复原为开发默认（空）');
    spawnSync('docker', ['compose', 'up', '-d', '--no-deps', 'api-gateway'], { cwd: REPO_ROOT, encoding: 'utf8' });
    // ⚠️ **重读**：断言要钉的是「自愈**之后**」的状态（若只读一次，注入态起跑就会红 —— 与合同
    //    「注入态起跑必须全绿」矛盾；Task 5 修复轮实测订正）。
    gwEnv0 = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      { encoding: 'utf8' }).stdout ?? '';
  }
  checks.that(/^TRUST_PROXY=$/m.test(gwEnv0), `起手态：网关信任为空（必要时已自愈）—— 实际 ${JSON.stringify(gwEnv0.match(/TRUST_PROXY=.*/)?.[0] ?? '（无该键）')}`);
  const compose = (...args: string[]) => {
    const r = spawnSync('docker', ['compose', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EDGE_HTTPS_PORT,
        EDGE_HTTP_PORT: process.env.EDGE_HTTP_PORT ?? '8080',
        TRUST_PROXY: EDGE_TRUST_ADDR,
      },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  step('B0 生命周期：起门口（连 api-gateway 一起点名）→ 收尾无残留');
  const up = compose('--profile', 'edge', 'up', '-d', '--build', '--no-deps', 'api-gateway', 'edge');
  // ⚠️ `--no-deps` **必需**（Task 3 实测）：不带它时 `--build` 会把传递依赖闭包全纳入构建计划
  //    （实测 7 个服务），其中 `douzero` 需要本机没有的 `python:3.14-slim` ⇒ `up` exit 1。
  //    Task 5 复用同一生命周期命令 ⇒ 这个坑对它同样成立。
  info(`docker compose --profile edge up -d --build api-gateway edge ⇒ exit ${up.code}`);
  checks.eq(up.code, 0, '门口与网关一起被重建（点名两个服务）');
  await sleep(8000);
  const env = spawnSync('docker', ['inspect', 'ftl-api-gateway', '--format', '{{json .Config.Env}}'], { encoding: 'utf8' });
  checks.that(
    (env.stdout ?? '').includes(`TRUST_PROXY=${EDGE_TRUST_ADDR}`),
    `注入必须**真的到达网关**（否则本 slice 全是空测）—— 实际 ${(env.stdout ?? '').slice(0, 200)}`,
  );
```

- [ ] **Step 3: B1/B2 —— 加密 + 静态站**

```ts
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
```

同文件底部的两个辅助（⚠️ 用 `node:https` 而**不是** `fetch` —— undici 不接受 per-request 的 `rejectUnauthorized`；也**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，那是进程级、会影响同轮其它 slice）：

```ts
/** 走门口取一次（自签证书 ⇒ `rejectUnauthorized: false`）。`path` 以 `/` 开头。 */
function httpsGet(path: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const u = new URL(`${EDGE_BASE}${path}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, string> }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 统一收 **path**（别混用整 URL）：`edgeFetch('/api/health')`。 */
const edgeFetch = (path: string) => httpsGet(path);
```

- [ ] **Step 4: B3 —— wss 升级 + 一次业务往返**

⚠️ 用**真事件**（`CLIENT_MESSAGE_TYPES` 里没有 `room.list`）：`room.join` 一个**不存在的房号** ⇒ 期望 `ErrCode.ROOM_NOT_FOUND`（`12001`）。这是**确定性的业务码**（超时哨兵是 `-1` ⇒ 打不通就红），既证明升级成功、又证明服务端真的处理了这一帧。

```ts
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
```

- [ ] **Step 5: B0 收尾 + 无残留**

⚠️ **收尾必须在 `finally` 里**（B0–B3 的断言中途抛错时若不收尾，容器会留给下一轮 ⇒ 下一轮的"无残留"判据**假红**）：

```ts
  try {
    // …B0–B3 的全部断言…
  } finally {
    const down = compose('--profile', 'edge', 'rm', '-sf', 'edge');
    info(`收尾 docker compose --profile edge rm -sf edge ⇒ exit ${down.code}`);
  }
  const ps = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
  const names = (ps.stdout ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  // ⚠️ **不要**用 `--filter name=ftl-edge`：那是**子串**匹配 ⇒ 探针名 `ftl-edge-probe` 会被命中 ⇒
  //    上一轮的探针残留会让本条**假红**（Task 5 实施者实测）。按**精确名**比。
  checks.that(
    !names.includes(EDGE_CONTAINER),
    `收尾后 ${EDGE_CONTAINER} 无残留（残留 ⇒ 下次跑的是旧镜像）—— 实际 edge 相关容器：${JSON.stringify(names.filter((n) => n.includes('edge')))}`,
  );
  return checks; // ⚠️ 必须**返回** checks（run.ts 靠它统计断言数）
}
```

⚠️ B0 的启动命令**必须带 `EDGE_HTTP_PORT=8080`**（基文件的两条发布对两种形态都生效，不设它会占宿主 `80`）。

- [ ] **Step 6: 跑（实测条数写进提交信息）**

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.3-edge`
Expected: 全绿。⚠️ **不预测条数**（本仓教训）；把实测数字写进提交信息。

- [ ] **Step 7: 提交**

```bash
git add tools/conformance/src/slices/slice-07.3-edge.ts tools/conformance/src/run.ts tools/conformance/package.json
git commit -m "test(conformance): slice-07.3-edge —— 门口三条链与生命周期（B0–B3）"
```

---

## Task 4: 网关可信客户端 IP（R1204/R1206/R1207 · C1–C8）

**Files:**
- Create: `packages/api-gateway/src/http/trusted-client-ip.ts`
- Create: `packages/api-gateway/test/trusted-client-ip.test.ts`
- Modify: `packages/api-gateway/package.json`、`src/http/http-rate-limit.middleware.ts`、`src/gateway/proxy.gateway.ts`

**Interfaces:**
- Produces: `parseTrustProxy(raw)` · `normalizeAddress(addr)` · `clientIpFrom(headers, socketAddress, trust)` · `TRUST_TABLE`。
- Consumes: `proxy-addr`（新直接依赖）。

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @fight-the-landlord/api-gateway add proxy-addr
pnpm --filter @fight-the-landlord/api-gateway add -D @types/proxy-addr
```

（`proxy-addr@2.0.7` **不带**声明文件；本包 `strict` + `noImplicitAny` ⇒ 缺 `@types` 必 TS7016 ⇒ 门禁红。）

- [ ] **Step 2: 先写测试（红）**

```ts
// packages/api-gateway/test/trusted-client-ip.test.ts
import { describe, expect, it } from 'vitest';
import { clientIpFrom, normalizeAddress, parseTrustProxy } from '../src/http/trusted-client-ip';

const EDGE = '172.28.0.250';

describe('可信客户端 IP（R1204–R1207）', () => {
  it('C1 信任表为空 ⇒ 忽略头（= 现状）', () => {
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9' }, '172.28.0.9', [])).toBe('172.28.0.9');
  });

  it('C2 对端可信 + XFF ⇒ 取最右不可信那节；**客户端伪造的前缀不改变结果**', () => {
    const trust = parseTrustProxy(EDGE);
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, EDGE, trust)).toBe('203.0.113.7');
    // 前缀伪造：多一个更左的假地址，结果**不变**
    expect(clientIpFrom({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 203.0.113.7' }, EDGE, trust)).toBe('203.0.113.7');
  });

  it('C3 对端**不可信** ⇒ 完全不看头（B5 的单测半边）', () => {
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9' }, '172.28.0.9', parseTrustProxy(EDGE))).toBe('172.28.0.9');
  });

  it('C4 归一化：::ffff:1.2.3.4 与 1.2.3.4 同一个桶', () => {
    expect(normalizeAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientIpFrom({}, '::ffff:1.2.3.4', [])).toBe('1.2.3.4');
    expect(clientIpFrom({ 'x-forwarded-for': '1.2.3.4' }, EDGE, parseTrustProxy(EDGE))).toBe('1.2.3.4');
  });

  it('C5 非空且不可解析的值 ⇒ **响亮失败**（不得静默信任一切）', () => {
    expect(() => parseTrustProxy('9.9.9.9.9')).toThrow();
    expect(() => parseTrustProxy('172.28.0.250/33')).toThrow();
  });

  it('C5′ 空 / 全空白 ⇒ **空信任表**（绝不把空值喂给 compile —— 实测它有三种不同行为）', () => {
    expect(parseTrustProxy(undefined)).toEqual([]);
    expect(parseTrustProxy('')).toEqual([]);
    expect(parseTrustProxy('   ')).toEqual([]);
  });

  it('C6 无 socket / 无 headers 的降级语义（R141：取不到 IP 不等于豁免）', () => {
    expect(clientIpFrom({}, '', [])).toBe('');
    expect(clientIpFrom({}, '', parseTrustProxy(EDGE))).toBe('');
  });

  it('C8 头面契约：`Forwarded` / `X-Real-IP` **读入即不可信**', () => {
    const trust = parseTrustProxy(EDGE);
    const base = clientIpFrom({ 'x-forwarded-for': '203.0.113.7' }, EDGE, trust);
    expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.7', forwarded: 'for=7.7.7.7', 'x-real-ip': '6.6.6.6' }, EDGE, trust)).toBe(base);
  });
});
```

Run: `pnpm --filter @fight-the-landlord/api-gateway test -- trusted-client-ip`
Expected: **红**（模块不存在）。

- [ ] **Step 3: 实现解析器**

```ts
// packages/api-gateway/src/http/trusted-client-ip.ts
import proxyaddr from 'proxy-addr';

/** 信任表：空数组 = **不信任任何人**（开发形态）。 */
export type TrustTable = readonly string[];

/**
 * 解析 `TRUST_PROXY`（逗号分隔的地址/CIDR）：
 *  - 空 / 全空白 ⇒ **空信任表**（⚠️ 绝不把这三种空值喂给 `proxyaddr.compile` ——
 *    实测 v2.0.7：`compile('')` 抛错、`compile([])` 返回 `undefined`（⇒ 请求期抛 ⇒ 每请求 500）、
 *    `compile([''])` 抛错 ⇒ 三种行为互不相同）；
 *  - 非空且不可解析 ⇒ **抛错**（fail-closed：宁可起不来，也不要静默信任一切）。
 */
export function parseTrustProxy(raw: string | undefined): TrustTable {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return [];
  proxyaddr.compile([...items]); // 启动期校验（C5）
  return items;
}

/** IPv4-mapped（`::ffff:a.b.c.d`）归一成 IPv4（R1206），其余原样。 */
export function normalizeAddress(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m ? m[1]! : addr;
}

/**
 * 可信客户端 IP —— **唯一实现**（R1207）：HTTP 中间件与 WS `allowRequest` 共用。
 * 输入是 `(headers, socket 对端地址)`（WS 那边没有 Express，拿不到 `req.ip`）。
 * 纪律：**先验对端可信、再采信头**；取不到 IP 不等于豁免（R141）。
 */
export function clientIpFrom(
  headers: Record<string, unknown>,
  socketAddress: string,
  trust: TrustTable,
): string {
  if (trust.length === 0) return normalizeAddress(socketAddress);
  const compiled = proxyaddr.compile([...trust]);
  if (!compiled(socketAddress, 0)) return normalizeAddress(socketAddress);
  const req = { headers, socket: { remoteAddress: socketAddress } };
  return normalizeAddress(proxyaddr(req as never, compiled));
}

/** 进程内信任表（模块加载时解析一次 ⇒ 非法值**启动即失败**）。 */
export const TRUST_TABLE: TrustTable = parseTrustProxy(process.env.TRUST_PROXY);
```

Run: `pnpm --filter @fight-the-landlord/api-gateway test -- trusted-client-ip`
Expected: **绿**（8 条）。

- [ ] **Step 4: 接入两处调用点**

`src/http/http-rate-limit.middleware.ts`：

```ts
import { clientIpFrom, TRUST_TABLE } from './trusted-client-ip';

/**
 * ⚠️ **socket 优先、无 socket 退回 `req.ip`**（Task 4 实测订正）：既有测试的夹具是 `{ headers, ip }`
 * **没有 socket** ⇒ 只读 socket 会打红 4 条既有断言。两者在"**未启用** Express `trust proxy`"时
 * **同源**（生产路径与只读 socket 逐字等价）；信任判定仍然**只**在 `clientIpFrom` 里做。
 */
function clientIp(req: Request): string {
  const address = (req as { socket?: { remoteAddress?: unknown } }).socket?.remoteAddress;
  const peer =
    typeof address === 'string' && address.length > 0
      ? address
      : typeof req.ip === 'string' && req.ip.length > 0
        ? req.ip
        : 'unknown';
  return clientIpFrom((req.headers ?? {}) as Record<string, unknown>, peer, TRUST_TABLE);
}
```

`src/gateway/proxy.gateway.ts` 的 `requestIp()`：

```ts
  private requestIp(req: unknown): string {
    const r = req as { headers?: Record<string, unknown>; socket?: { remoteAddress?: unknown } };
    const address = r?.socket?.remoteAddress;
    const peer = typeof address === 'string' && address.length > 0 ? address : 'unknown';
    return clientIpFrom(r?.headers ?? {}, peer, TRUST_TABLE);
  }
```

并把两处**既有注释**改写成指向 §3/R1204–R1207（原注释描述的是"不看头"的旧行为）。

- [ ] **Step 5: 跑包测试 + lint（C7 条数不减）**

Run:
```bash
pnpm --filter @fight-the-landlord/api-gateway test
pnpm --filter @fight-the-landlord/api-gateway lint
```
Expected: 全绿；`http-rate-limit.test.ts` / `rate-limit.test.ts` / `ws-allow-request.test.ts` / `proxy.gateway.test.ts` 的条数**各自不减**（实测值写进提交信息）。

- [ ] **Step 6: 重建容器并查 DI 陷阱**

```bash
DOCKER_BUILDKIT=0 docker compose build api-gateway && docker compose up -d api-gateway
docker compose logs api-gateway --since 30s | grep -i error || echo "(no errors)"
```
Expected: 无 error（`import type` 陷阱的最短检测 —— 见记忆 `di-type-import-trap`）。

- [ ] **Step 7: 提交**

```bash
git add packages/api-gateway/package.json pnpm-lock.yaml \
  packages/api-gateway/src/http/trusted-client-ip.ts \
  packages/api-gateway/src/http/http-rate-limit.middleware.ts \
  packages/api-gateway/src/gateway/proxy.gateway.ts \
  packages/api-gateway/test/trusted-client-ip.test.ts
git commit -m "feat(gateway): 可信客户端 IP 解析（R1204/R1206/R1207）+ C1–C8"
```

---

## Task 5: 真栈 —— 限流归属与伪造负对照（B4/B5/B6）

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.3-edge.ts`

**Interfaces:**
- Consumes: Task 3 的 slice 骨架与生命周期；`lib/redis.ts` 的 `redisCli` / `redisLines`。
- Produces: B4/B5/B6 三条判据。

- [ ] **Step 0: 顺手加固同一文件（Task 3 评审的 Minor，4 处）**

本任务要扩的就是 `slice-07.3-edge.ts`，把 Task 3 评审指出的四条**同文件**加固一并做掉（都是小改，且都让本任务自己的 B4–B6 更稳）：

1. **`sleep(8000)` → `up -d --wait`**：两个服务都已有 healthcheck；固定睡眠在负载下会让 B1 因为"重建未就绪"红（响的但无谓）。
   `compose('--profile', 'edge', 'up', '-d', '--build', '--no-deps', '--wait', 'api-gateway', 'edge')`
2. **给 compose 的 `spawnSync` 抬 `maxBuffer: 64 * 1024 * 1024`**（与 `slice-07.2-deploy.ts:169` 同值）—— 否则 `--build` 的日志超过默认 1MiB 会 `ENOBUFS` ⇒ `status` 为 null ⇒ `code -1` ⇒ **误导性红**。
3. **`finally` 里的收尾加 `timeout: 120_000`** —— `docker compose rm` 挂住会把整个 slice 吊死（同文件 `:237` 的成例）。
4. **残留判据的消息改成正面陈述**（现在是 `收尾后不得有 … = ""`，成功时打印出来像红）：改成 `收尾后 ftl-edge 无残留`。
5. **补 R1206 的判别性单测**（Task 4 评审的 Minor 1）：`packages/api-gateway/test/trusted-client-ip.test.ts` 里**没有任何一条**覆盖「**IPv4-mapped 对端 + 纯 IPv4 信任表**」—— 而那正是生产里的**真实形态**（docker 网桥下 Node 报 `::ffff:172.28.0.250`；spike 的键 `ratelimit:http-ip:::ffff:…` 即此形态）。补：
   ```ts
   it('C4′ 生产真实形态：映射对端 + 纯 IPv4 信任表 ⇒ 采信 XFF（且结果已归一）', () => {
     const trust = parseTrustProxy('172.28.0.250');
     expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.7' }, '::ffff:172.28.0.250', trust)).toBe('203.0.113.7');
     expect(clientIpFrom({ 'x-forwarded-for': '::ffff:203.0.113.7' }, '::ffff:172.28.0.250', trust)).toBe('203.0.113.7');
   });
   ```
   ⚠️ 第二条若与库的实际返回形态不符，**以实测为准**并在报告里记下真实形态（别为了让它绿而改判据）。补完复跑该文件与整包，**条数只增不减**。

- [ ] **Step 1: B4 —— 桶必须记在**真实客户端地址**上**

```ts
  step('B4 限流归属：经门口产生的桶 = 真实客户端地址（且 ≠ 门口容器地址）');
  // ⚠️ 造桶**必须**用公开且计入该维度的路径：`/api/health*` **豁免**、
  //    匿名打受保护路径会被 JwtMiddleware **先** 401（中间件顺序）⇒ 两者都不产生桶。
  const norm = (s: string) => s.replace(/^::ffff:/, '');
  const edgeIp = norm(dockerInspectIp(EDGE_CONTAINER));
  const bridgeIp = norm(
    spawnSync('docker', ['network', 'inspect', COMPOSE_NETWORK, '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
      { encoding: 'utf8' }).stdout?.trim() ?? '',
  );
  checks.that(edgeIp.length > 0 && bridgeIp.length > 0, `必须能取到 门口地址(${edgeIp}) 与 网桥地址(${bridgeIp}) —— 取不到 ⇒ 红，不许 skip`);

  // 两条链**出自同一来源方**（都在宿主机上跑）：直连 3000（开发形态发布它）+ 经门口。
  // ⚠️ 这两条**同时补上 Task 3 的覆盖缺口**（T3-M1）：带 body 的 POST 经门口（Caddyfile 的
  //    `handle /api/*` + `request_body`）此前没有任何判据走过 —— B1 是 GET、B3 的注册是直连。
  await directPost('/api/auth/login', { phone: '13900000000', password: 'wrong1' });
  await edgePost('/api/auth/login', { phone: '13900000000', password: 'wrong1' });

  const keys = redisLines(['KEYS', 'ratelimit:http-ip:*']);
  info(`ratelimit:http-ip 键：${keys.join(' | ') || '（无）'}`);
  checks.that(keys.length > 0, `造流量后必须**记到账**（键缺失 = 没记上，不是"不在门口地址上"）—— 实际 ${JSON.stringify(keys)}`);
  checks.that(!keys.some((k) => k.includes(edgeIp)), `桶**不得**记在门口容器地址上（那正是本片要修的 bug）—— 门口地址 ${edgeIp}`);
  // ⚠️ 比的是**键里的地址段**（精确相等），**不是**子串：`includes('172.28.0.1')` 会被
  //    `172.28.0.11`（门口！）或上一轮探针的 `172.28.0.1x` 满足 ⇒ B4 可能**空转通过**（实施者实测指出的弱点）。
  const keyAddr = (k: string): string => norm(k.split(':').slice(2).join(':'));
  checks.that(keys.some((k) => keyAddr(k) === bridgeIp), `桶必须记在**真实客户端地址**（本机 = 网桥 ${bridgeIp}）上 —— 实际 ${JSON.stringify(keys.map(keyAddr))}`);
```

（`dockerInspectIp(name)` 与 `directPost` / `edgePost` 三个小辅助写在同一文件底部；`edgePost` 用 `node:https` 的 POST 版本。`redisLines` 来自 `lib/redis`。）

- [ ] **Step 2: B5 —— 从**信任边界内部**注入的伪造负对照**

```ts
  step('B5 伪造负对照（信任边界**内部**注入）：不可信对端带 XFF ⇒ 桶仍是它自己的地址');
  // ⚠️ 三条**实测**订正（Task 5 实施者）：
  //   ① 探针必须**先清再断言** —— 断言抛错会跳过后面的 `docker rm -f`，留下容器；
  //   ② 探针要**自报地址**（`hostname -i`）—— 容器**退出后** `docker inspect --format '{{.IPAddress}}'`
  //      会渲染成字面量 `invalid IP`（而且退出码 0）⇒ 根本拿不到地址；
  //   ③ 所以探针**阻塞跑完**（不 `-d`、不 sleep），地址由它自己打出来；镜像用**本地已有**的
  //      `caddy:2-alpine`（内含真 curl），避免外网拉取。
  // ⚠️ 配方**以已交付代码为准**（Task 5 评审 Minor 2 —— 计划原稿的 `caddy:2-alpine sh -c` 是**错的**：
  //    caddy 的 ENTRYPOINT 会吞掉 `sh -c`，**必须** `--entrypoint sh`）。三条要点（实现见
  //    `slice-07.3-edge.ts` 的 B5 段）：① 探针名带**时间戳** + **显式 `rm -f`**（不用 `--rm`：要先等它跑完再清）；
  //    ② 地址取 `hostname -i` 的**首个** token（多地址容器会取错，但失败方向**响亮**——B5 正向会红）；
  //    ③ **先清探针再断言**（断言抛错会跳过清理 ⇒ 留下容器）。
  const probe = `ftl-edge-probe-${Date.now()}`;
  const probeOut = spawnSync('docker', ['run', '--name', probe, '--network', COMPOSE_NETWORK,
    '--entrypoint', 'sh', 'caddy:2-alpine', '-c',
    'echo "PROBE_IP=$(hostname -i)"; curl -s -o /dev/null -H "X-Forwarded-For: 9.9.9.9" ' +
      '-X POST -H "content-type: application/json" -d \'{"phone":"13900000001","password":"wrong1"}\' ' +
      'http://api-gateway:3000/api/auth/login'], { encoding: 'utf8' });
  const probeIp = (probeOut.stdout ?? '').match(/PROBE_IP=(\S+)/)?.[1] ?? '';
  spawnSync('docker', ['rm', '-f', probe], { encoding: 'utf8', stdio: 'ignore' }); // **断言前**清干净
  checks.that(probeIp.length > 0, `探针必须能**自报地址**（空串是任何键的子串 ⇒ 否则下一条永真空转）—— 实际 ${JSON.stringify(probeOut.stdout)}`);
  const after = redisLines(['KEYS', 'ratelimit:http-ip:*']);
  checks.that(!after.some((k) => k.includes('9.9.9.9')), `伪造的 9.9.9.9 **不得**产生桶 —— 实际 ${JSON.stringify(after)}`);
  checks.that(after.some((k) => keyAddr(k) === norm(probeIp)), `桶必须记在**探针容器自己的地址**上（${probeIp}）—— 实际 ${JSON.stringify(after.map(keyAddr))}`);
```

⚠️ 探针镜像可换成本地已有的（避免拉网）；跑完**必须** `docker rm -f` 并断言无残留。

- [ ] **Step 3: B6 —— 两个头**不参与**判定**

```ts
  step('B6 头面契约：`Forwarded` / `X-Real-IP` 经门口 ⇒ 与不带时**逐字相同**');
  const before = redisLines(['KEYS', 'ratelimit:http-ip:*']).sort();
  await edgePost('/api/auth/login', { phone: '13900000002', password: 'wrong1' }, {
    forwarded: 'for=7.7.7.7', 'x-real-ip': '6.6.6.6',
  });
  const after6 = redisLines(['KEYS', 'ratelimit:http-ip:*']).sort();
  checks.that(!after6.some((k) => k.includes('7.7.7.7') || k.includes('6.6.6.6')), `这两个头**不得**影响派生 IP —— 实际 ${JSON.stringify(after6)}`);
  // B6 的第 2 条（规格 §5 该行明写「键缺失要**响亮**」，brief 片段漏了）：桶仍须落在**真实客户端地址**上
  checks.that(after6.some((k) => keyAddr(k) === bridgeIp), `带这两个头之后，桶仍记在真实客户端地址（${bridgeIp}）上 —— 实际 ${JSON.stringify(after6.map(keyAddr))}`);
  info(`B6 前后键集合：${before.length} → ${after6.length}（同一来源方 ⇒ 同一桶，键集不因这两个头而多）`);
```

⚠️ **本文件的一条统一纪律**（Task 5 修复轮定下）：**正向**的「某键的地址段等于 X」一律用 `keyAddr(k) === norm(X)`；
**负向**的「不得含 Y」保持 `includes`（子串形态在负向更严，方向安全）。

- [ ] **Step 4: 跑 + 实测条数写进提交信息 + 收尾复原网关**

⚠️ **收尾必须把网关还原为开发默认形态**（Task 3 交接的缺口）：B0 会把 `ftl-api-gateway` 重建为**注入形态**
（`TRUST_PROXY=172.28.0.250`）而**不复原** ⇒ 残留的注入态会让**下一轮**的 B4/B5/B6 变成**空测**
（注入路径真坏了也照样绿 —— 正是本片 B0 要防的那一类）。在同一个 `finally` 里补：

```ts
    // 复原网关的开发默认形态（`TRUST_PROXY=` 空 —— 见 override 的 `${TRUST_PROXY:-}`）
    spawnSync('docker', ['compose', 'up', '-d', '--no-deps', 'api-gateway'], { cwd: REPO_ROOT, encoding: 'utf8' });
```

并加一条断言（阳性陈述）：`docker inspect ftl-api-gateway` 的 `TRUST_PROXY` **回到空值** ⇒ 「收尾后网关回到开发默认形态」。

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.3-edge`
Expected: 全绿（B4/B5/B6 + Task 3 的 B0–B3）。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance/src/slices/slice-07.3-edge.ts
git commit -m "test(conformance): slice-07.3-edge —— 限流归属与伪造负对照（B4–B6）"
```

---

## Task 6: 首次上线手册（R1212）

**Files:**
- Create: `docs/ops/first-deploy.md`

**Interfaces:** Consumes Task 1–5 的全部产物与命令；Produces 手册（**八节**、每条命令带预期输出）。

- [ ] **Step 1: 写手册（八节全文）**

按 spec R1212 的八节逐条写，**每条命令都给预期输出**：

```markdown
# 首次上线手册（单台 VPS）
> 形态：8 个服务容器 + 门口（第 9 个）。对外只开 80/443；`3000` 不发布。
> ⚠️ 第 ⑦ 节的「代码怎么上去」是**临时手工路径**，片② 会用镜像 + Actions 替换该节。

## ① 服务器准备
- 要求：Linux · 2 核 / 4GB 内存起 · 磁盘 ≥ 20GB（首次构建镜像会占数 GB）
- `curl -fsSL https://get.docker.com | sh` ⇒ 结尾打印 `Docker version 2x.x.x` 与 `Docker Compose version v2.x`
- `docker compose version` ⇒ `Docker Compose version v2.20+`（**必须是 v2**，profiles 与 `--env-file` 都依赖它）

## ② 密钥与 env（三项密钥 + 两个门口变量 = **五项**）
- `openssl rand -hex 32` ⇒ 每次输出 64 位十六进制（`JWT_SECRET` / `DB_PASSWORD` / `INTERNAL_SERVICE_TOKEN` 各来一次）
- 仓库根写 `.env`（已被 .gitignore）：
  ```
  JWT_SECRET=<粘贴>
  DB_PASSWORD=<粘贴>
  INTERNAL_SERVICE_TOKEN=<粘贴>
  SITE_ADDRESS=game.example.com
  TLS_MODE=you@example.com
  ```
- 自检：`docker compose --env-file .env -f docker-compose.yml config | grep -E "JWT_SECRET|SITE_ADDRESS|TLS_MODE"` ⇒ 五项均非空

## ③ DNS 与防火墙
- `dig +short game.example.com` ⇒ 回你 VPS 的 IP
- `ufw allow 22,80,443/tcp && ufw enable`（80 是 ACME 取证书必需）
- **反向自检**：`curl -m3 http://<VPS_IP>:3000/api/health` ⇒ **必须失败**（连接被拒）

## ④ 起栈
- `docker compose --env-file .env -f docker-compose.yml up -d`（**必须带 `-f`**，否则会合并开发 override）
- `docker compose ps` ⇒ 9 个容器，8 个 `(healthy)`
- ⚠️ `up -d` 返回 0 **不等于**门口在服务：若 `SITE_ADDRESS`/`TLS_MODE` 漏配，容器会 `Restarting (1)`

## ⑤ 自检（三条链 + 证书判定）
- `curl -sS https://game.example.com/api/health` ⇒ `{"status":"ok",...}`（**不加 `-k`** ⇒ 通 = 真证书）
- `curl -sS https://game.example.com/ | head -3` ⇒ `<!doctype html>`
- `docker compose logs edge | grep -i "certificate obtained"` ⇒ 有签发记录
- 浏览器打开 `https://game.example.com/` ⇒ 地址栏有锁、能注册/登录/进房

## ⑥ 排错
| 症状 | 根因 | 处置 |
|---|---|---|
| `Address already in use` | 门口固定地址与动态分配撞车 | 换高位地址（如 `172.28.0.250` → 另一个高位）|
| 门口 `Restarting (1)` | `SITE_ADDRESS`/`TLS_MODE` 漏配（fail-closed）| 补齐 `.env` 后 `up -d edge` |
| 证书签不出来 | ① 80 没放行 ② DNS 未生效 ③ **`caddy-data` 卷丢了**（每次重建重签 ⇒ 撞配额）| `dig`、`ufw status`、`docker volume ls \| grep caddy-data` |
| `up` 报子网冲突 | `172.28.0.0/16` 与宿主既有网络重叠 | 改 `docker-compose.yml` 的 `ipam` 段 |
| 服务起不来且无错误消息 | Nest `abortOnError` 把消息藏了 | 见记忆 `windows-dev-env-quirks` 9b 的钩子 |

## ⑦ 代码怎么上去（**临时手工路径**）
- `git clone <仓库> /srv/pokergame && cd /srv/pokergame`（局域网/中间机器上 `git bundle` 亦可）
- `DOCKER_BUILDKIT=0 docker compose build`（4GB 机器上首次约 10–20 分钟；建议先 `docker compose stop` 再构建）
- 之后同 ④

## ⑧ App 包（⚠️ App **不能**依赖同源）
- `VITE_WS_ENDPOINT=https://game.example.com VITE_API_BASE=https://game.example.com/api pnpm --filter @fight-the-landlord/client build:app` ⇒ DONE
- 判别：`grep -rl "https://game.example.com" apps/client/dist/build/app | wc -l` ⇒ **≥ 1**（不注入 ⇒ 0 ⇒ 真机连不上）
```

- [ ] **Step 2: 逐条自查可执行性**

Run: `for c in "docker compose version" "openssl rand -hex 32"; do echo "\$ $c"; done`（本机把能跑的都跑一遍；跑不了的（ufw/dig）标注"服务器上执行"）
Expected: 手册里每条命令本机能跑的都有实测输出对照；不能跑的已注明。

- [ ] **Step 3: 提交**

```bash
git add docs/ops/first-deploy.md
git commit -m "docs(ops): 首次上线手册（R1212，八节，每条命令带预期输出）"
```

---

## Task 7: 文档同步 + 收尾门禁（R1210/R1211 · §0.6 全表）

**Files:**
- Modify: `docs/design.md`（§2.1/§2.2/§2.3/§4.1/§7.1/§14.4）、`README.md`、`scripts/dev.sh`
- Modify: 各 compose 文件头注释（若要）

- [ ] **Step 0: 修一处**既有**缺陷 —— `JWT_SECRET` 没传给 `api-gateway`**（Task 6 实测发现，**生产阻断级**）

证据（Task 6 实施者实测 + 控制者复核）：基文件里 `JWT_SECRET` **只有一处**（`docker-compose.yml:114`，在 **user-service** 块内），
而网关在**两处**用它验签（`packages/api-gateway/src/app.module.ts:15`、`auth/jwt.strategy.ts:12`，都写 `?? 'dev-secret-change-in-production'`）
⇒ 生产里 `.env` 给真密钥后：**user-service 用真密钥签、网关用仓库里的公开默认值验** ⇒ **每个登录令牌都验不过**（站点不可用）。
开发形态之所以正常，只是因为两边都回落到**同一个字面量**。

**要做**：
1. `docker-compose.yml` 的 `api-gateway.environment` 加一行：`- JWT_SECRET=${JWT_SECRET:-dev-secret-change-in-production}`（与 user-service 同形）。
2. **判据**（渲染层，进 `slice-07.2-deploy`）：**生产形态**渲染里 `api-gateway` 的 `JWT_SECRET` **逐字等于** `user-service` 的
   （同一份 `config --format json` 两处比；取到 `null` 或缺键 ⇒ **红**）。**证伪**：把那行删掉 ⇒ 必红，实测数字写进提交信息。
3. 手册 `docs/ops/first-deploy.md` ⑥ 里那条**临时补丁**（第 9 条）**删除**（缺陷已修，手册不该再教人打补丁）。

- [ ] **Step 1: 逐行同步（spec §0.6 全表）**

按 spec §0.6 的表格**逐行**改：`design.md:155/1619/1628`（容器数按形态分写）· `:936/938`（§7.1 注记与「只发布 3000」）· `:135/137/148`（§2.1 对外语义 + api-gateway 标网内）· `:160-178`（§2.3 加 5 个变量）· `:361`（§4.1 通信表）· `agent-briefs.md:1096/1785` · `deviation-ledger.md:595`（R509）· `README.md:34-41` · compose 文件头 · `scripts/dev.sh`（`docker-compose` → `docker compose`）。

- [ ] **Step 2: 逐行复核（**不做**全仓 0 命中）**

Run（示例，逐个文件做）：
```bash
grep -n "只发布 api-gateway:3000\|编排里没有终结者" docs/design.md || echo "OK: 旧句已不在 design.md"
grep -n "对外 = 门口" docs/design.md | head -2
```
Expected: 每处「旧句不存在 + 新句存在」都成立；全仓 grep 只用于窄域新增（如 `deploy/Caddyfile` 的无字面 `tls internal` —— ⚠️ **必须用与 A6b 同一个行首锚正则** `^\s*tls\s+internal`：该文件**注释里**含这个字面（`# ⚠️ 不得写死 \`tls internal\``），**字面 grep 会假红** —— 实施者实测），且排除 `.worktrees/**`、`**/dist/**`、`docs/superpowers/**`。

- [ ] **Step 3: 收尾门禁（全量）**

Run:
```bash
pnpm run ci                                                  # 六阶段
pnpm --filter @fight-the-landlord/conformance build
for s in slice-05 slice-06 slice-07 slice-07.1 slice-08 slice-09 slice-10 slice-11 slice-12 slice-07.2-security slice-07.2-boundary slice-07.2-hardening slice-07.2-deploy slice-07.2-rpc slice-07.3-edge; do
  echo "== $s"; node tools/conformance/dist/run.js "$s" | tail -2
done
pnpm --filter @fight-the-landlord/client build:h5 && pnpm --filter @fight-the-landlord/client build:app
test "$(git rev-parse HEAD:scripts/browser-e2e.mjs)" = 052b98b7ab779ae280d6673729053145e9829604 && echo "探针 blob 未变"
node scripts/ledger-counts.mjs
```
Expected: `ci` 六阶段全绿；**每个 slice 全绿且条数只增不减**（实测值写进提交信息）；双 build DONE；探针 blob 未变；`gate 18/18` / `full 33/33`（探针跑法见记忆 `windows-dev-env-quirks` 第 6 条的三处 Windows 绕法 + `scripts/browser-e2e.mjs` 的 `--scenario`）。

- [ ] **Step 4: spec §10 回填 + 提交**

在 spec 的 §10 表里逐项填实测结果（判据 A/B/C/D、门禁与探针、文档同步、已知取舍）。

```bash
git add -A && git commit -m "docs: 门口与上线形态收尾 —— §0.6 全表同步 + 门禁实测回填"
```

---

## Self-Review（写完计划后的自检）

**1. Spec 覆盖**
- R1202（镜像/配置/卷/`.env` 排除）→ Task 1 + Task 2 Step 1（卷）；R1203 → Task 2；R1204/R1206/R1207 → Task 4；R1205 → Task 2（ipam/ipv4_address/TRUST_PROXY 字面值）+ Task 4（解析）；R1208 → Task 1（Caddyfile 四项）；R1209 → Task 2（profile/healthcheck/日志上限）；R1210 → Task 7；R1211 → Global Constraints + Task 7 Step 3；R1212 → Task 6。
- 判据：A1/A2/A3/A4/A5/A8/A9 → Task 2；A6a/A6b → Task 1（+ Task 2 Step 5 的负对照）；A7 → Task 2 Step 6；B0–B3 → Task 3；B4–B6 → Task 5；C1–C8 → Task 4；D → Task 7 Step 3。
- ⚠️ **已知不覆盖**：真证书签发路径（无域名 ⇒ 只能验自签；手册的**判别检查**兜住）· 片②③ 的交付（明确不做）。

**2. 占位符扫描**：无 TBD/TODO；每条命令与代码都在计划内写全；**条数一律留白**（本仓教训：预测 vs 实测不符）。

**3. 类型/命名一致性**：`clientIpFrom` / `normalizeAddress` / `parseTrustProxy` / `TRUST_TABLE` 在 Task 4 的定义与 Task 5 的引用一致；slice 的导出名 `runSlice073Edge` 与 `run.ts` 注册一致；`ftl-edge` 容器名在 B0/B4/B5 一致。

**4. 写完计划后按"去查而不是猜"核过的三处（初稿都是错的，已改）**：
- `run.ts` 要求 slice **返回** `Checks`（`Promise<Checks>` + `return checks;`）—— 初稿写成 `Promise<void>` + 不存在的 `checks.report()`；
- `CLIENT_MESSAGE_TYPES` 里**没有** `room.list` ⇒ B3 改用真事件 `room.join` + 假房号 ⇒ 期望 `ErrCode.ROOM_NOT_FOUND`（`12001`，确定性业务码；超时哨兵 `-1` ⇒ 打不通必红）；
- `Checks.eq` 用 `!==` ⇒ 数组/对象永远不等（R176）⇒ 已写成 `checks.that(JSON.stringify(...))` 形态。
