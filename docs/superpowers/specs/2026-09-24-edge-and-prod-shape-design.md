# 斗地主平台 · 上线运营层（一）：门口容器与上线形态（设计规格）

> **日期**：2026-09-24 · **状态**：**已实施并收口**（7 个任务全部合入 `master`；四轮设计/规格复核 §7.3–§7.5 + **最终全分支评审 §7.6** 后的修复轮 `f031d48`）
> **上游**：`docs/design.md` §1.3（YAGNI）· §2.1（服务与端口）· §2.2（部署拓扑）· §5.4（限流）· §7.1（R473）· §14.4（P3 DoD）
> **交接**：`docs/superpowers/plans/2026-09-23-observability-handoff.md` §3（下一片 = 上线运营层）
> **归属**：本片的**设计真源**。实施计划另出。
> **触发**：用户 2026-09-24 裁决「上线运营层**拆三片**，从 ① 门口与上线形态开始」。
> **本会话用户裁决**（逐条）：
> 1. 部署形态 = **单台 VPS**（4GB 内存，后续如需可多台）；**有域名**；
> 2. 反代/TLS 产物 = **纳入仓库**（`deploy/` + 门口服务 + H5 打进镜像）；R473 的「TLS 终止由部署层承担」**不被推翻**——本仓只是把部署层的那段**产物化**；
> 3. 监控 = 要**正经监控栈**，但**基础设施层本片不做**（另立一片；业务指标插桩再另立）；
> 4. 部署链路 = **GitHub + Actions**（片②）；
> 5. 可信代理范围 = **收窄到门口一跳**（不信任整个网段）；
> 6. `design.md §7.1` 的 TLS 标记 = **保持 `[部分实现]`** + 改写职责句（R473：不得为凑 0 改标题）；
> 7. 门口硬化 = 最小一组四项（HSTS · 禁止 MIME 猜测 · 请求体上限 · 访问日志）。

---

## 0. 现状复核（**本设计期逐条实测或读码核实**）

### 0.1 端口与拓扑现状（实测渲染 + 运行中容器）

| 事实 | 证据 |
|---|---|
| 生产形态（`-f docker-compose.yml`）**唯一**发布宿主端口的服务是 `api-gateway`，端口恰好 `3000` | `docker-compose.yml:282-283`；`slice-07.2-deploy.ts:441-453` 两条断言逐字钉住 |
| 开发形态（自动合并 override）发布 `3000/3001/3002/3003/3005` + RPC `3103/3105` + `6379/3306/2021` | `docker-compose.override.yml:16-72` |
| 8 个容器 healthy；网络 `pokergame_ftl-platform` 的 subnet 实测 `172.18.0.0/16`（**自动分配、未钉死**） | `docker compose ps`；`docker network inspect`。⚠️ 仓内有**网段变过**的证据：`2026-09-17-slice-ui-01-login-lobby.md:602` 当时记录的是 `172.19.0.1` |
| compose 的 `ports` 合并语义 = **并集**（override 再加一条 ≠ 覆盖） | 本次实测：基文件 80/443 + override 8443/8080 ⇒ 渲染出**四条**；与 override 文件头「`ports` 是**并集**」逐字一致 |
| `profiles` 在 override 里给基文件的服务打标记**有效**（不带 profile 即排除） | 本次实测（等价文件）：`config --services` 不带 profile 无 edge、带 `--profile edge` 有 |
| `--profile` 是**全局参数**：`docker compose up -d --profile edge` 报 `unknown flag` | 评审者实测；正确形态 `docker compose --profile edge up -d` |
| **`down` 删不掉带 profile 的容器**：不带 profile 的 `down` 只删无标记的服务，带标记的容器仍 `Up`，且网络因此删不掉 | 评审者实测（隔离项目）；⇒ 旧门口容器常驻 = **全部真栈判据测旧镜像**（记忆 `windows-dev-env-quirks` 第 9 条同族坑） |

### 0.2 客户端连接契约（读码核实；**门口配置的每一条都有依据**）

| 事实 | 证据 |
|---|---|
| HTTP 走 `/api`（相对路径 = **同源**） | `apps/client/src/config.ts:67`（默认值 `'/api'`） |
| 实时连接走 `/socket.io`，网关侧 `namespace: '/ws/ddz'`、`path: '/socket.io/'` | `apps/client/src/net/transport.ts:50`；`packages/api-gateway/src/gateway/proxy.gateway.ts:85`（`namespace`）/ `:86`（`path`） |
| H5 是 **hash 路由** ⇒ 门口**不需要** SPA 回退（服务端永远只发 `/`） | `apps/client/src/manifest.json:37-38`（`"mode": "hash"`） |
| **H5** 生产构建**不需注入任何变量**（同源是默认值） | `config.ts:66-68` 的 `readEnv(..., 默认)`；仓库**无** `.env.production`。⚠️ **App 端不适用**：`resolveWsEndpoint` / `resolveApiBase` **只对 `mp-weixin` 特判**（`net/http.ts:208-222` / `:167-176`；`net/mp-transport.ts:693-702` 判 App 为 `'app'`），App 归「浏览器类」⇒ 回退同源 ⇒ **真机必挂**（仓库自己的 `.env.development.local:3-8` 逐字同此结论）⇒ App 包必须用**绝对地址**构建（见 R1212 ⑧） |
| 产物里唯一的 `localhost:3000` 命中是 `resolveEndpoint` 的**不可达兜底**（浏览器有 `window.location.origin`） | 实测：产物 `assets/index-BbLZ8_Kw.js` 恰好 1 处；源码 `net/transport.ts:88-96` ⇒ ⚠️ **不得**把它写成判据（会假红） |

### 0.3 限流现状（**门口会改语义**，见 R1204–R1207）

| 事实 | 证据 |
|---|---|
| 网关有**两个按 IP 计数**的维度：单 IP HTTP `120/60s`、单 IP 并发 WS `5` 条 | `packages/api-gateway/src/http/rate-limit.ts:19`（HTTP-IP）/ `:30`（WS）/ `:33-36`（键）；§5.4 |
| HTTP 侧取 IP = `req.ip`（**未启用** Express `trust proxy` ⇒ 即 socket 对端）；WS 侧取 IP = `req.socket.remoteAddress`（**完全不看头**） | `http-rate-limit.middleware.ts:93-96` · `proxy.gateway.ts:187-190` |
| 除网关外**没有**按 IP 计数的地方（room-service 按 `socketId`） | grep 全仓：键面只有 `ratelimit:http:{userId}` / `http-ip:{ip}` / `ws-conn:{ip}`（网关）与 `ratelimit:ws:{socketId}`（room） |
| 纪律：**取不到 IP 不等于豁免**（否则「配上代理头」就成了绕过手法） | `http-rate-limit.middleware.ts:87-91`（R141） |
| 键里地址的形态是 **IPv4-mapped**（`::ffff:172.18.0.11`） | 本次实测（Redis `KEYS ratelimit:*`） |
| 键 **TTL 60s** ⇒ 读完即过期，「桶不存在」极易被误读 | `rate-limit.ts:81`（`expire`） |

### 0.4 构建面

- 生产镜像 **6 个**（5 个 Node 服务 + douzero python），各自 `Dockerfile.<服务>`，形态一致：`COPY packages/protocol` + 按依赖顺序 `pnpm --filter … build` + `COPY tsconfig.base.json`（`Dockerfile.api-gateway:14`；依赖顺序 build 在 `:24-27`）。
- `apps/client` **直接依赖** `@fight-the-landlord/protocol`（`apps/client/package.json:27`）⇒ 门口镜像必须 COPY 并构建它。
- `.dockerignore` **排除 `**/dist`**（⇒ 镜像内必须真的跑 H5 构建，不能指望宿主产物）。
- `.dockerignore` **未排除** `.env*` 本地覆盖（磁盘上存在 `apps/client/.env.development.local`，含局域网 IP）⇒ 见 R1202。
- `caddy:2-alpine`（实测 v2.11.4）：镜像**无** `HEALTHCHECK`；镜像内**有真 curl 8.22.0**（`/usr/bin/curl`）⇒ 健康检查可照抄既有形态。
- ✅ **「H5 在镜像内构建」已实测成立**（2026-09-24 构建探针，临时 Dockerfile 走 gitignore 路径、跑完即删）：
  `node:20-slim` 里 `COPY` 根清单 + `packages/protocol` + `packages/shared` + `apps/client` 后
  `pnpm install --no-frozen-lockfile --ignore-scripts` **在部分 workspace 下成功**；
  `pnpm --filter protocol build && pnpm --filter client build:h5` **成功**，产出 `assets/ index.html static/`（3.0M）。
  ⚠️ **但产物与宿主构建的哈希不同**（`index-BbLZ8_Kw.js` vs `index-VAvAlAdb.js`；19 个资源**同名同结构**、
  `index.html` 除内容哈希外**逐字节相同**）—— 差异来自构建环境（宿主 Node 24 / 镜像 Node 20）。
  ⇒ **任何判据都不得断言「镜像里构建的产物与宿主 dist 哈希一致」**（那是**假红**）；
  判据只能是行为性的（B2：页面与**一个真实静态资源** 200）。
- 阶段大小参考：web 阶段镜像 ≈ **839MB**；最终门口镜像只把 `/srv` 拷进 `caddy:2-alpine`（小得多）。

### 0.5 会被本片**打断**的既有判据与设施（评审者逐处核实，非推断）

| 位置 | 现状 | 本片处置 |
|---|---|---|
| `slice-07.2-deploy.ts:441-445` | 「生产形态**只有** api-gateway 发布宿主端口」 | **替换**为 A1（只有 edge 发布，且是 80/443 参数化值） |
| `slice-07.2-deploy.ts:450-453` | 「api-gateway 发布的端口号恰好 3000」 | **替换**为 A2（api-gateway 生产形态**零**发布、仍 `expose` 3000） |
| `slice-07.2-deploy.ts:124-127` | `isolatedEnv()` 只剔 `INTERNAL_SERVICE_TOKEN` | 加剔 `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` / `TRUST_PROXY` / `TLS_MODE` / `SITE_ADDRESS`（否则新判据随宿主 shell 漂移 —— R147 同族） |
| `slice-07.2-deploy.ts:590-593` | 运行期日志上限清单**硬编码 8 个容器名** | 清单加 `ftl-edge`（门口跑起来时才有） |
| `slice-07.2-deploy.ts:535-557`（②/②b） | 开发形态直连端口清单 | 加 `api-gateway:3000`（它从基文件搬进 override，断言面不变） |
| `slice-07.2-deploy.ts:183-204`（③） | `-f docker-compose.yml run --no-deps api-gateway …` | **不受影响**（已核） |
| `scripts/dev.sh:20-47`（`docker-compose up -d --build` / `ps` / `down`）+ `README.md:23` 推荐它 | 用 `docker-compose`（**连字符**）形态调用；本机实测该二进制是 **v2 血统**（`Docker Compose version v5.5.1`）**且支持 profile** ⇒ **未证风险**只限"真有 v1 的机器"（v1 不支持 `profiles`） | 统一成 `docker compose`（空格）并在 README 对齐 —— 低风险、顺手做 |
| `slice-07.2-deploy.ts:437` 的 `composeConfig(['-f','docker-compose.yml'])` | 生产形态渲染的**唯一入口**（`--env-file <空文件>` + `isolatedEnv()`，定义在 `:130-135`） | 用 `${VAR:-}`（**推荐**）⇒ **本行不变**；A6a 另起一次「不喂值」渲染 + 一次运行期探针。⚠️ 若误用 `${VAR:?}` ⇒ 本行必须改成喂值，否则 ①/①b/①c/①d/③/③a **全红** |
| `.worktrees/{backend,frontend}/docker-compose.yml`（**未被 git 跟踪**：`.gitignore:11` 忽略；`git worktree list` 显示两者 **prunable**，注册路径是不存在的 Linux 路径 `/home/howe/pokergame/…`，但 Windows 侧目录实际存在） | 各含一份**旧形态** compose，其中 `:217` 仍是 `- "3000:3000"` | **冻结为旧快照**：不参与任何 grep 判据。⚠️ 本片新增的**全仓** grep 判据必须排除 `.worktrees/**` 与 `**/dist/**`，否则自始即假红源（实测：现有判据的扫描面都是窄域 —— `apps/client/src`、`<pkg>/test`、`packages/*/src` —— 所以这不是既存缺陷，是本片**新引入全仓扫描**才带来的风险）。若用户愿意，可另行 `git worktree prune` + 删两目录（本片**不擅自删**） |

### 0.6 会变成「假话」的文档与注释（**清单**，收尾用 grep 复核）

| 位置 | 现文 | 处置 |
|---|---|---|
| `docs/design.md:155` · `:1619` · `:1628` | 「8 个容器」 | 按形态分写（R1203/§8） |
| `docs/design.md:938`（§7.1） | 「本仓编排只发布 `api-gateway:3000` 的**明文** HTTP，TLS 由**部署层**终止」 | 按 R1210 改写 |
| `docs/design.md:936`（§7.1 的 **R473 注记**） | 「编排里**没有**终结者，代码与编排 `grep` 0 命中」 | 与 R1210 同批改写（门口**就是**本仓的 TLS 终结者；`.worktrees/**` 的旧快照不计） |
| `docs/design.md:135` / `:137` / `:148`（§2.1） | 表头「**对外** HTTP 端口」的定义，与 `api-gateway \| 3000` 那一行 | api-gateway 行标「**网内**（不发布，`expose: 3000`）」；`:148` 补一句「**对外 = 门口**；其余端口仅供网关/服务间使用」 |
| `docs/design.md:160-178`（§2.3 环境变量表） | 无门口五项、无 `TRUST_PROXY` | 加 5 行：`SITE_ADDRESS`（edge，**无默认值**）· `TLS_MODE`（edge，**无默认值**）· `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT`（edge，`80`/`443`）· `TRUST_PROXY`（**api-gateway**：基文件字面 = 门口地址 / 开发形态默认空）。⚠️ §14.4 的 P3 交付里本来就有「环境变量表核对（§2.3）」一条 |
| `docs/design.md:361`（§4.1 通信方式总表首行） | 「客户端 ↔ api-gateway \| HTTPS / WSS \| 全部对外流量」 | 改为「客户端 ↔ **edge**（HTTPS/WSS，终止于此）→ api-gateway（**网内明文** HTTP，§2.1）」 |
| `docs/design.md` §2.1 服务清单 | 无 edge 行 | 加一行（含内部端口与数据层「—」） |
| `docs/superpowers/plans/agent-briefs.md:1096` · `:1785` | 「生产形态只发布 api-gateway 3000」 | 改写 |
| `docs/superpowers/plans/deviation-ledger.md:595`（R509） | 「上线前必须确认**只放行 3000**」 | 改写为「只放行 80/443，3000 不发布」 |
| `README.md:34-41`（「## 服务端口」7 行清单） | 只有 `API Gateway: 3000` 等 7 条，无门口 | 加门口两行（`Edge (TLS): 443` · `Edge (HTTP→HTTPS): 80`），并把 api-gateway 一行标为**网内** |
| `docker-compose.yml:1-19`（文件头）· `docker-compose.override.yml:1-14` | 「只发布 3000」/「两样」 | 改写（override 的「两样」还要写清 3000 的来处） |

### 0.7 本设计期的实测证据（spike，已拆除；命令可复现）

把临时 `caddy:2-alpine` 接到 `pokergame_ftl-platform`、`tls internal`、挂载现有 `apps/client/dist/build/h5`：

- `curl -k https://localhost:18443/api/health` ⇒ **200** + `{"status":"ok","service":"api-gateway","checks":{"redis":"up"}}`
- `GET /` ⇒ 200 真 `index.html`；`/assets/index-*.js` ⇒ 200
- `/socket.io/?EIO=4&transport=polling` ⇒ engine.io 握手含 `"upgrades":["websocket"]`
- 真 socket.io 客户端：经门口**注册（201 + token）→ `wss://` 升级 → `/ws/ddz` 命名空间连接 `CONNECT OK`**
- Redis 实测：经门口产生的桶 = **门口容器地址**（`ratelimit:http-ip:::ffff:172.18.0.11`、`ratelimit:ws-conn:::ffff:172.18.0.11`）⇒ §0.3 的「门口会改语义」被坐实
- 伪造 `X-Forwarded-For: 9.9.9.9` 经门口 ⇒ **不产生** 9.9.9.9 的桶（Caddy 会**替换**客户端给的这个头；⚠️ 但它**原样透传** `Forwarded` / `X-Real-IP` —— 评审者隔离探针实测）
- ✅ **「H5 在镜像内构建」探针**（2026-09-24；临时 Dockerfile 在 gitignore 路径、跑完即删；**命令可复现**）：
  `FROM node:20-slim` → `COPY` 根清单（`package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`/`tsconfig.base.json`）+ `packages/protocol` + `packages/shared` + `apps/client` → `pnpm install --no-frozen-lockfile --ignore-scripts` → `pnpm --filter protocol build && pnpm --filter client build:h5`
  ⇒ **exit 0**；镜像内 `apps/client/dist/build/h5` 含 `assets/ index.html static/`（3.0M、19 个资源）；与宿主 dist **同名同结构、`index.html` 除内容哈希外逐字节相同**，而**哈希不同**（宿主 Node 24 / 镜像 Node 20）。
  ⚠️ 该探针**不是**真 `Dockerfile.edge`（无 caddy 阶段、无命名卷）⇒ §9 的 A 段仍要**在真镜像上重验**。

---

## 1. 裁决

| # | 裁决 | 性质 |
|---|---|---|
| **R1201** | 本片范围 = ① 门口容器（加密/静态站/反代）② 生产形态端口收敛 ③ 可信客户端 IP 语义修正 ④ 首次上线手册。**不含**：CI/CD 与镜像仓库（片②）· 监控与备份（片③）· 多实例与负载均衡 · CDN/缓存 · 客户端任何改动 | 用户裁决 1/2/4 |
| **R1202** | 门口 = 自建镜像 `Dockerfile.edge`（**两段式**：阶段一在镜像内构建 H5 —— ✅ **已实测成立**，见 §0.4；阶段二 `caddy:2-alpine` + 产物 + `deploy/Caddyfile`）+ `deploy/Caddyfile` 为**唯一真源**。⚠️ 镜像内**不得**含任何 `.env*`：`.dockerignore` 补 **`**/.env*`**（不只 `.local` —— R1212 会把**真密钥**写进仓库根 `.env`）。⚠️ **必须挂命名卷 `caddy-data:/data`**（证书与 ACME 账户库；命名卷**不算**宿主产物挂载 ⇒ ①c 不受影响）。**缺这条的后果**：每次重建容器 ⇒ 证书重签 ⇒ 撞 Let's Encrypt 配额（同域名集 5 张/周）⇒ **一周内签不出来**，代码侧无法补救（片② 自动化后**每次发布都会重建**） | 用户裁决 2 · 部署原则 · 复核 B-5 |
| **R1203** | **端口收敛**：生产形态**只有门口**发布宿主端口，且是参数化的 `80`/`443`；`api-gateway` 退为 `expose: 3000`（不发布）；`3000` 的宿主映射**移入 override**（开发形态照旧，conformance 直连依赖它）。⚠️ 端口号必须在**基文件**用 `${EDGE_HTTP_PORT:-80}` / `${EDGE_HTTPS_PORT:-443}` 参数化 —— compose 的 `ports` 是**并集**，override 里再加一条不会覆盖 | 用户裁决 2 |
| **R1204** | 🔴 **唯一的可信头 = `X-Forwarded-For`**；`Forwarded` / `X-Real-IP` **读入即不可信、一律不参与**判定 —— 这是**契约**，不只是"默认行为"（实测：前者被 Caddy **替换**，后两者被**原样透传** ⇒ 采信它们 = 零成本伪造）。⚠️ **为什么必须写成契约**：本仓的参考架构文档 `docs/2026-08-31-game-platform-architecture-design.md:950` 的 nginx 范例里有 `proxy_set_header X-Real-IP $remote_addr;`（把 `X-Real-IP` 当**可信来源头**建模），而 `design.md` 对 `X-Real-IP` **零命中**（权威层既没规定、也没禁止）⇒ 后来者「按参考架构对齐」就会开出伪造面 | 复核 A-1 + 补遗 |
| **R1205** | **信任范围 = 门口一跳**，机制写死：compose 网络的 `ftl-platform` 加 `ipam.config.subnet`（**钉死**）+ `edge` 服务声明 `ipv4_address`（**固定地址**）；⚠️ `TRUST_PROXY` 放在 **`api-gateway`** 的环境里（**限流在那里**；放门口是无效的）并指向**该地址**（不是网段）。⚠️ 理由（实测）：宿主与所有容器都落在该网段内（宿主 = `172.18.0.1`），而 `proxy-addr` 在"全链路可信"时会返回**最左**那个（=攻击者可指定）⇒ 信任网段 = 把「宽的信任」写进规格。开发形态**默认空**（override 写 `TRUST_PROXY=${TRUST_PROXY:-}`：宿主未设 ⇒ 空；⚠️ 这个写法**不是**「无条件置空」而是「透传 + 默认空」—— 实测宿主 `export TRUST_PROXY=9.9.9.9` 会漏进去；真·无条件置空要写 `TRUST_PROXY=`，但那样本机就验不了 B4/B6）⇒ **本机验证可信 IP 时显式注入** `TRUST_PROXY=<门口固定地址>`。基文件的值会**按键合并**漏进开发形态，而开发形态 `3000` 是发布的 —— 这正是 **A8 必须剔除该变量**的理由。⚠️ 两个已知代价写进手册：① 钉 subnet 会让现有网络**重建一次**（容器重建；命名卷数据不丢）；② 要与宿主上其它 docker 网络**避让**（重叠时 `up` 因地址池冲突失败） ⚠️ **固定地址怎么选**（评审者实测的三个坑）：取**高位、落在动态池之外**（建议 `172.18.0.250`；动态分配自 `.2` 起、本栈实测用到 `.10`）—— 低值地址会与动态分配撞车 ⇒ `Address already in use` ⇒ `up` 失败（症状像网络问题）。⚠️ **不得**写进 `ipam.config.aux_addresses`：实测（Docker 29.8.0）aux 保留的地址**容器绑不上**（同样 `Address already in use`）⇒ **死路**。⚠️ 与 B0 的顺序（先起 8 个 → 再起门口）叠加时，低值固定地址**必撞** ⇒ 手册 ⑥ 加一行「`Address already in use` ⇒ 固定地址与动态池重叠，换高位」 | 用户裁决 5 · 复核 A-2/A-3 · B-6 |
| **R1206** | **地址归一化**：`::ffff:a.b.c.d` 归一成 `a.b.c.d` ⇒ 同一客户端在两条路径下**同一个桶**（否则额度翻倍）。归一化是**判据的一部分**（单测正负成对） | 复核 A-6 |
| **R1207** | 解析器**只有一处**：输入 `(headers, socket 对端地址)`，**先验对端可信、再采信头**；HTTP 中间件与 WS `allowRequest` 共用它。**不改**Express 的 `trust proxy`（那会造出第二套实现）。依赖用 `proxy-addr`（Express 内部同款，**提升为直接依赖**），**不手写**头解析。⚠️ **交付物两行**：`packages/api-gateway/package.json` 的 `dependencies` 加 `proxy-addr`，**且** `devDependencies` 加 `@types/proxy-addr`（`proxy-addr@2.0.7`（**实际解析 2.0.8**；两者在本路径行为一致 —— 最终评审对照两版源码确认）**不带**声明文件；本仓 `strict` + `noImplicitAny` ⇒ 无类型必 TS7016 ⇒ 门禁红） | 复核 A-14 · 自审 2 · 复核 B-8 |
| **R1208** | 门口硬化四项：**HSTS** · **禁止 MIME 猜测** · **请求体上限** · **访问日志**。⚠️ 访问日志同时是 B4 判据的**独立取证源**（本仓既有裁决：访问日志由部署层反代承担），且**不引入采集器**（R1101 不变） | 用户裁决 7 |
| **R1209** | `edge` 加进**基文件**（生产形态第 9 个服务）；开发形态在 override 里给它打 `profiles: ["edge"]`（日常 `up -d` 仍是 8 个）。⚠️ **生命周期协议必须写死**（`--profile` 是全局参数；`down` 删不掉带 profile 的容器）⇒ 启动 `docker compose --profile edge up -d edge`、收尾 `docker compose --profile edge rm -sf edge`，并有一条**「收尾后无 `ftl-edge` 残留」**的判据。⚠️ **门口带 healthcheck**，且**必须形态无关**：实测 `curl -fk https://localhost:<port>/` 只在 `SITE_ADDRESS` 的 host 是 `localhost`（开发形态）时成立；**生产用域名 ⇒ SNI/Host 不匹配 ⇒ 握手失败 ⇒ 永远 `unhealthy`**（原写法方向反了）。改用容器内那个 `:80` 跳转监听这条（实测**两种形态都 `308`** ⇒ `curl -f` exit 0）：`test: ["CMD","curl","-fs","-o","/dev/null","http://localhost/"]`；compose **会**在 healthcheck 里插值 `${EDGE_HTTPS_PORT:-443}`（实测），故不需要把该变量传进容器环境。生产 ACME 可能数十秒才签发 ⇒ 同批给 `start_period`。⚠️ 手册 ④ 记一条：**`up -d` 返回 0 ≠ 门口在服务** —— fail-closed 表现为容器 `Restarting (1)`（`restart: unless-stopped` 是本仓成例） | 复核 A-5 · A-4 · B-15 |
| **R1210** | `design.md §7.1` **保持 `[部分实现]`**（R473：不得为凑 0 改标题；真证书路径**未验**）⇒ 改写职责句（门口成为**唯一对外入口**，api-gateway 变内部服务）+ 加注记（TLS 终止由本仓 `edge` 承担；**真证书路径未验证**） | 用户裁决 6 |
| **R1211** | **判据只增不减**；探针 `gate`/`full` **逐字不变**；**零客户端改动** | 全局约束 |
| **R1212** | 手册 `docs/ops/first-deploy.md`，**八节**、每条命令带预期输出：①**服务器准备**（Docker/Compose 版本下限 · 4GB 机首次构建的时长与磁盘 · `git clone` 目录）②**密钥与 env**（**五项都要**：`JWT_SECRET` / `DB_PASSWORD` / `INTERNAL_SERVICE_TOKEN`（各 `openssl rand -hex 32`）+ `SITE_ADDRESS=<域名，不带端口>` + `TLS_MODE=<ACME 邮箱>` —— 后两项**无默认值**，漏配 ⇒ 门口容器 `exit 1`；写仓库根 `.env`（已 gitignore）+ **自检**：`docker compose --env-file .env -f docker-compose.yml config` ⇒ 五项均非空。⚠️ 现存根 `.env` 只有 11 个键、**没有** `INTERNAL_SERVICE_TOKEN` ⇒ 直接复用会让服务起不来 —— 空 token 是 **fail-closed**，不是静默降级）③**DNS 与防火墙**（`dig +short <域名>` = VPS IP；入站只放行 `22/80/443`（ACME 需 80）**且反向自检** `curl -m3 http://<IP>:3000` **必须失败** = R1203 的可观测等价物）④**起栈**（`docker compose --env-file .env -f docker-compose.yml up -d` —— **必须带 `-f`**，否则会合并开发 override）⑤**自检**（**三条链**手工 curl + **证书判定**：不带 `-k` 能通 / `logs edge` 的签发记录）⑥**排错**（subnet 冲突 · **`Address already in use` ⇒ 固定地址与动态池重叠、换高位** · 443 占用 · 证书未签发（**先看 `docker volume ls | grep caddy-data` 还在不在** —— 卷丢了 ⇒ 每次重建重签 ⇒ 撞 ACME 配额）· `.env` 漏配 —— 各自症状与处置）⑦**代码怎么上去**（**临时手工路径**；片② 用镜像 + Actions **替换**该节 —— 写明，免得被当成返工）⑧**App 包**（⚠️ App **不能**依赖同源：`VITE_WS_ENDPOINT=https://<域名> VITE_API_BASE=https://<域名>/api pnpm --filter @fight-the-landlord/client build:app` ⇒ DONE；不注入 ⇒ 真机连不上，H5 不受影响） | 用户裁决 1/4 · 复核 B-1/B-7 |

---

## 2. 门口配置（R1202 / R1203 / R1208）

`deploy/Caddyfile`（**唯一真源**，参数化到"生产与本机只差环境变量"）：

```caddyfile
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

| 变量 | 本机（验证用） | 生产 | 说明 |
|---|---|---|---|
| `SITE_ADDRESS` | `localhost:8443`（与 `EDGE_HTTPS_PORT` **同一个变量驱动**） | 域名（**不带端口**） | Caddy 的站点地址同时决定**监听端口**与证书对象；**带端口 ⇒ 只监听该端口**（spike 实测：只发布 `18443` 一条即够） |
| `TLS_MODE` | `internal`（自签） | **ACME 邮箱** | ⚠️ 生产**必须**显式给（见 A6a 的 fail-closed） |

- ⚠️ **fail-closed（与 `INTERNAL_SERVICE_TOKEN` 同一成例）**：基文件写 `SITE_ADDRESS=${SITE_ADDRESS:-}` / `TLS_MODE=${TLS_MODE:-}`（**不给默认值**）—— 未配置 ⇒ 容器内为空 ⇒ **Caddy 启动即失败**（实测 v2.11.4：`tls {$TLS_MODE}` 读到空参数是**硬解析错**（`wrong argument count … after 'tls'`）；`{$SITE_ADDRESS}` 为空报 `server block without any key`；两者都 `exit 1`）。⇒ 宁可起不来，也不要「用仓库里的自签常量跑起来」。⚠️ **不要用 `${VAR:?}`** —— 那是**渲染期**硬失败，会打断**既有**的生产形态渲染（`slice-07.2-deploy.ts:437` 是唯一入口），且与本仓成例（`INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}` + **运行期** fail-closed）不一致。开发形态由 override 提供本机值。
- ⚠️ **监听与发布必须分开写**（评审者实测 —— 本节曾有三处互相矛盾且两处与实测相反）：
  - **容器内监听**：`SITE_ADDRESS` 的端口（如 `localhost:8443`），**外加一个固定的 `:80` 跳转监听**（boot log 报 `HTTP/2 skipped … addr=:80`、`/proc/net/tcp` 有 `:0050`）—— 生产用域名时那个 `:80` **正是 ACME HTTP-01 所需**。
  - **宿主发布两条**：`"${EDGE_HTTP_PORT:-80}:80"` 与 `"${EDGE_HTTPS_PORT:-443}:${EDGE_HTTPS_PORT:-443}"`。⚠️ **左侧（宿主侧）才是 `EDGE_HTTP_PORT` 该动的地方**：跳转监听**固定在容器 `:80`**，所以写 `${EDGE_HTTP_PORT:-80}:80`（两侧同值的写法只在默认值下巧合正确）。⚠️ **只发 `443` ⇒ ACME HTTP-01 收不到挑战 ⇒ 签不出证书**（症状与「证书未签发」同形）。
  - ⚠️ **基文件的这两条发布对两种形态都生效**（`ports` 是**并集**，override **减不掉**）⇒ 实测 dev+edge 形态发布 `80` + `${EDGE_HTTPS_PORT}`（设 `8443` ⇒ `{80, 8443}`；**不设 ⇒ `{80, 443, 8443}`，其中宿主 `443` 是**死映射**且占着宿主 443**）。⇒ 本机验证时**显式**给 `EDGE_HTTP_PORT`（如 `8080`）以免占宿主 `80`。
  - 开发形态的 `SITE_ADDRESS=localhost:${EDGE_HTTPS_PORT:-8443}`；两处不一致 ⇒ 容器监听的端口没人映射（**响的**，不是静默）。生产形态用域名，**自定义端口只属开发形态**。
- ⚠️ **`TRUST_PROXY` 不在这里**（它属于 `api-gateway` —— 限流在网关；放门口**完全无效**）：基文件写**字面**的门口固定地址，override 写 `${TRUST_PROXY:-}`（透传 + 默认空）。见 R1205 与 A4/A5。
- ⚠️ **访问日志走 `output stdout`**（`log { output stdout }`）⇒ 上限由既有 `logging.options`（json-file）承担，与其余 8 容器**同族**。**不得落文件**：json-file 的上限**只管 stdout/stderr**，容器可写层里的文件它管不到（评审者实测：`/var/log/caddy/access.log` 真被写入 ⇒ 4GB 机器上**无界增长**）。若确要落文件，必须改用 Caddy 自己的轮转（`roll_size`/`roll_keep`）并在 A7 里另判。
- 转发目标写 `api-gateway:3000`（compose 服务名）。
- `/socket.io*` **必须**匹配无斜杠形态（客户端请求是 `/socket.io/?…`）。
- 静态站从镜像内的 `/srv` 提供（H5 产物），**hash 路由 ⇒ 不需要 SPA 回退**。

---

## 3. 可信客户端 IP（R1204–R1207）

```
clientIp(headers, socketAddr):
  if 信任表为空:              return norm(socketAddr)          # 开发形态 = 现状
  if NOT trusted(socketAddr): return norm(socketAddr)          # 对端不可信 ⇒ 完全不看头（R141）
  return norm(firstUntrusted(headers['x-forwarded-for'], norm(socketAddr)))
```

| 场景 | 结果 | 为什么 |
|---|---|---|
| 开发形态（信任表空） | 对端地址 | 维持现状；客户端塞头无效 |
| 生产·经门口（对端 = 门口，可信） | XFF 里**最右的不可信**那节 = 真实客户端 | Caddy 会替换 XFF、并**扔掉**客户端伪造的前缀 |
| 生产·网内其它容器直接打网关（对端不可信） | 对端自己的地址 | ⇒ 伪造 `X-Forwarded-For: 9.9.9.9` **无效**（B5 判据形态） |
| 非法配置值 | **响亮失败** | 禁止静默降级成"信任一切" |

**两处调用点**：HTTP 中间件（`http-rate-limit.middleware.ts` 的 `clientIp`）与 WS `allowRequest`（`proxy.gateway.ts` 的 `requestIp`）。两处**共用** §3 的解析器；判据 C7 指名既有测试文件与条数，防「改优先级」造成成片红而无人知。

⚠️ **空值语义（必须写死）**：`TRUST_PROXY` 为空/全空白 ⇒ **信任表 = 空** ⇒ 直接返回对端地址；**不得**把空值喂给 `proxyaddr.compile` —— 评审者实测 `proxy-addr@2.0.7` 的三种空值行为**互不相同**：`compile('')` **抛错**、`compile([])` 返回 **`undefined`**（⇒ **请求期**抛错 ⇒ **每个请求 500**）、`compile([''])` 抛错。正确形态：信任表为空时**根本不调 `compile`**（或传 `() => false`）。⇒ **C5 的「响亮失败」只针对非空且不可解析的值**（夹具：`9.9.9.9.9`、`172.18.0.250/33`）；空值走 C1。

---

## 4. 三种形态对照（R1203 / R1209）

| 形态 | 服务数 | 发布宿主端口 | **`api-gateway` 的** `TRUST_PROXY` | 门口的 `TLS_MODE` |
|---|---|---|---|---|
| 开发（默认，不带 `-f`） | **8** | `3000-3003/3005` + `3103/3105` + `6379/3306/2021` | **空**（`${TRUST_PROXY:-}` = 透传 + 默认空；宿主**显式 `export` 时会漏入** —— A8 的剔除正是为此） | 无门口 |
| 开发 + 门口（`--profile edge`；**本机验 B4/B6 的形态**） | 9 | 上述 + **`80`** + `${EDGE_HTTPS_PORT}`（实测：设 `8443` ⇒ `{80, 8443}`；不设 ⇒ `{80, 443, 8443}` —— ⚠️ 基文件的两条发布**对两种形态都生效**、override 减不掉；**不想占宿主 `80` ⇒ 显式 `EDGE_HTTP_PORT=8080`**） | **门口固定地址**（**连 `api-gateway` 一起点名**注入，见 B0；不注入即为空 ⇒ 该形态下 B4/B6 **不成立**） | `internal` |
| 生产（`-f docker-compose.yml`） | **9** | **只有门口**的 `80/443` | 门口固定地址 | **ACME 邮箱** |

⚠️ **DoD 的容器数必须按形态分写**（写「9」会让不带 profile 的 `up -d` 永远验不过 —— 那是"跑不通的判据"）。

---

## 5. 判据（只增不减；每条能机械判 + 带负对照）

### A · 结构（渲染判据；位置 = `slice-07.2-deploy.ts`，与"生产形态结构"同源）

| # | 判据 | 判别力 / 负对照 |
|---|---|---|
| A1 | 生产形态发布的宿主端口服务集 = **仅门口**；**默认渲染**下端口为 `80/443`，**第二次渲染**（`EDGE_HTTP_PORT=18080 EDGE_HTTPS_PORT=18443`）下恰为 `{18080, 18443}` 且宿主/容器两侧同值 | **替换**原 ① 的两条。⚠️ 只判「默认是 `80/443`」**无判别力**（写死字面量也渲染同样的结果）⇒ **第二渲染**才是判别力来源；负对照：开发形态仍多发布（② 那组继续绿） |
| A2 | 生产形态 `api-gateway` **零**发布、仍 `expose: 3000` | 与 A1 配对 ⇒ 防"顺手把 3000 留下" |
| A3 | 开发形态发布 `3000-3003/3005` + RPC `3103/3105`（既有断言**补 3000**；`3306/6379/2021` 见既有 ② 组 —— 真实 dev 渲染共 **10** 条映射） | 既有 ②b 同族 |
| A4 | 开发形态渲染出的 `TRUST_PROXY` = **空**（宿主未设时） | 负对照：**生产形态**渲染出的 = 门口**固定地址**（**非空**）⇒ 断言「两种形态**不同**」，而不是「某形态为空」 |
| A5 | **生产形态**渲染出的 `TRUST_PROXY` **逐字等于** `services.edge.networks["ftl-platform"].ipv4_address`（**同一份 `config --format json` 内**两处相比；取到 `null` ⇒ **红**，不许当 skip） | 钉子：**基文件把该值写成字面地址**（不是 `${VAR:-}`）—— 否则空 env-file 渲染两边都空 ⇒ A5 恒红、而 A4 的负对照恒取不到。**证伪**：把 `ipv4_address` 改成同网段另一个值 ⇒ A5 必红 |
| A6a | **fail-closed（两层）**：(i) **渲染层**：不提供 `SITE_ADDRESS`/`TLS_MODE` ⇒ 渲染出的值是**空**（可机械断言）；(ii) **运行层**：拿仓库 Caddyfile 起基础镜像、两个变量喂**空**（`docker run --rm -e SITE_ADDRESS= -e TLS_MODE= … caddy:2-alpine caddy validate --config …`，或等价的 `compose run --no-deps edge`）⇒ **退出码 ≠ 0** | **负对照必须显式喂值**（空 env-file 取不到非空值）：`--env-file prod.env`（域名 + ACME 邮箱）⇒ 渲染非空、退出 0。⚠️ 原写「渲染值 ≠ `internal`」**不可判**（自喂自判）—— 本形态才有判别力 |
| A6b | `deploy/Caddyfile` 的**文本**里不得出现 `tls` 后跟**字面** `internal`（判据按「`tls` 指令 + 字面 `internal`」写，避免把注释里的 `internal` 误判；自签只能经变量传入） | 防「图省事把自签写死」；与 A6a 配对（一个管配置文本、一个管渲染与运行行为）。⚠️ **2026-09-24 收紧**（最终评审 M1）：改为**剥掉行注释后断言全文不含字面 `internal`** —— 覆盖 `tls { issuer internal }` 多行式（v2.11.4 合法、原单行正则可被绕过）；`tls {$TLS_MODE}` 本身不受影响 |
| A7 | 门口带 `logging.options`（`max-size`/`max-file`）**且访问日志走 stdout**；`LOG_LIMIT_TARGETS` 加 `ftl-edge` | ⚠️ **运行期半边**：既有形态对「没在跑」的容器只 `info` ⇒ 会**静默通过** ⇒ 写成「**若** `ftl-edge` 在跑 ⇒ 上限必须对」（与其余 8 个同形）。⚠️ **「不存在」不在这条**（否则合法跑过 `--profile edge` 又没收尾的人会红，症状像无关回归）—— 残留闸归 **B0** |
| A9 | 渲染结果里 `services.edge.volumes` 含 `{type: volume, target: /data}`（证书库持久化） | 钉 R1202 的第三句。**证伪**：删掉该卷 ⇒ A9 必红。缺它 ⇒ 每次重建重签 ⇒ 撞 ACME 配额（同域名集 5 张/周） |
| A8 | `isolatedEnv()` 剔除新增的 5 个变量 | ⚠️ **不是可省项**：A1 的「恰好 `80/443`」与 A4 的「空」都**只有剔除后才稳**（实测：宿主 `export` 该变量会渲染进结果）—— R147 同族 |

### B · 真栈（**唯一真源 = 新 slice `slice-07.3-edge`**，本机 Windows 可跑）

| # | 判据 | 判别力 / 负对照 |
|---|---|---|
| B0 | 生命周期：**先起 8 个**（`docker compose up -d`）→ 再起门口**并让注入真的到达网关**（`EDGE_HTTPS_PORT=8443 TRUST_PROXY=<门口固定地址> docker compose --profile edge up -d --build api-gateway edge` —— ⚠️ **必须连 `api-gateway` 一起点名**）→ **自证注入到位**（`docker inspect ftl-api-gateway --format '{{json .Config.Env}}'` 必须含该值，否则**红**）→ 跑 → `docker compose --profile edge rm -sf edge`；**收尾后无 `ftl-edge` 残留** | 防两类**空测**：① 旧门口容器常驻 ⇒ 判据测旧镜像；② ⚠️ **`up -d edge`（只点名服务）不会重建 `api-gateway`**（评审者实测）⇒ 网关仍是 `TRUST_PROXY=`（空）⇒ **B4/B6 静默量错形态且不响**。`--profile` 是**全局参数**，必须在子命令**之前** |
| B1 | `https` 打 `/api/health` ⇒ 200 + 网关真 JSON | 链条 1：加密 + 转发 |
| B2 | `GET /` 200 + `index.html` 形状，**且一个真实静态资源 200** | 链条 2：静态站。⚠️ 不只断言页面（记忆：探针**盖不住**素材 404） |
| B3 | 经门口：注册 → `wss://` 升级 → `/ws/ddz` 连接 → **一次业务往返** | 链条 3：实时连接（spike 已证可行） |
| B4 | 限流归属：经门口的桶 = **真实客户端地址**（与"同源直连 3000 的控制桶"比，归一化后相等）**且 ≠** `docker inspect ftl-edge` 的地址 | 链际一致性。⚠️ 造流量与读键**同一步**；键缺失 ⇒ 报「没记到账」（**响亮**，不许写成"不在门口地址上"）。⚠️ **拿什么造桶**：`/api/health*` 是**豁免**、匿名打受保护路径会被 `JwtMiddleware` **先** 401（中间件顺序）⇒ 两者**都不产生** IP 桶；必须用 `/api/auth/register` / `login`（公开**且**计入该维度）或带 token 的请求。⚠️ 两条链必须出自**同一起源方**（本机 = 宿主；换探针容器会改变对端地址 ⇒ 相等不成立） |
| B5 | **从信任边界内部注入**：一次性探针容器接同一网络，直接对 `api-gateway:3000` 带 `X-Forwarded-For: 9.9.9.9` ⇒ 桶必须是**该容器自己的地址** | 钉 R1205（只信任门口一跳）。⚠️ **不能**用"经门口带伪造头"当负对照 —— Caddy 已替我们替换，那条在**修前也绿**（评审者实测 ⇒ 恒绿） |
| B6 | 带 `Forwarded: for=7.7.7.7` 与 `X-Real-IP: 6.6.6.6` 经门口 ⇒ 与不带时**逐字相同** | 钉 R1204（这两个头 Caddy 会原样透传）。⚠️ 造桶方式**同 B4**（`/api/health*` 豁免、匿名打受保护路径**先** 401 ⇒ 必须用 `/api/auth/register`/`login`）；键缺失要**响亮** |

### C · 单测（`packages/api-gateway`）

| # | 判据 |
|---|---|
| C1 | 信任表为空 ⇒ 忽略该头（= 现状，钉死） |
| C2 | 对端可信 + XFF ⇒ 取最右不可信那节；**客户端伪造的前缀不改变结果** |
| C3 | 对端**不可信** ⇒ 完全不看头（返回对端地址） |
| C4 | 归一化：`::ffff:1.2.3.4` 与 `1.2.3.4` 得到**同一个键** |
| C5 | 非法配置值 ⇒ **响亮失败**（不得静默降级成"信任一切"） |
| C6 | 无 `headers` / 无 `socket` 夹具下的降级语义（照 `proxy.gateway.test.ts:534` 的 R141 形态） |
| C7 | 既有判据继续绿，**指名文件与条数**：`http-rate-limit.test.ts` **15** · `rate-limit.test.ts` **5** · `ws-allow-request.test.ts` **2** · `proxy.gateway.test.ts` **38** |
| C8 | **头面契约**（R1204 的单测半边，真栈半边是 B6）：传入伪造的 `Forwarded: for=7.7.7.7` 与 `X-Real-IP: 6.6.6.6` ⇒ 派生 IP 与**不带这两个头时逐字相同** |

### D · 门禁

`pnpm run ci` 六阶段 · conformance **全量**（含新 slice）· 探针 `gate 18/18` / `full 33/33` 且 `scripts/browser-e2e.mjs` **逐字不变** · `build:h5` / `build:app` DONE · **`docker compose --profile edge build`** 全绿（含 `ftl-edge` 镜像）。⚠️ 不带 `--profile` 的 `build` 会**跳过带 profile 的服务**（实测：唯一可构建服务带 profile 时输出 `No services to build`）⇒ 门口镜像**根本不会构建**，§7.2 第 8 条「镜像内构建 H5」那一步就永远没人跑。

---

## 6. 明确不做（**不是遗漏**）

| 项 | 为什么 |
|---|---|
| GitHub 仓库 / Actions / 镜像仓库 / 自动部署 | 片②（用户已裁该路线，本片只保证不返工：镜像名与构建上下文现在定死） |
| 监控栈（Prometheus/Grafana/探针）与告警 | 片③（用户裁决：基础设施层先做、业务指标另立）。⚠️ 片③ 要**同步改 `design.md §1.3`** 的 YAGNI 行（它把 Prometheus/Grafana/Elasticsearch 明文列为不做）—— 免得下片在同一条上再卡一次 |
| DB 备份与恢复演练 | 片③ |
| **真证书签发路径的验证** | 本机无域名 ⇒ 只能验自签那条路。⚠️ **不写「Caddy 签发失败会退回自签」当事实**（本机未证）⇒ 手册给**判别检查**：不带 `-k` 能通 = 真证书；另由 A6a/A6b 两道闸挡自签模式进生产 |
| 多实例 / 负载均衡 / 粘性会话 | 另立（`rooms.start.ts` 的清单 + 片⑥ 已知未覆盖项） |
| CDN / 缓存策略 / 图片压缩 | YAGNI（Caddy 已开 gzip） |
| 访问日志的**采集** | R1101 不变（走 stdout、受上限约束） |
| 客户端任何改动 | R1211（**H5** 同源契约本来就成立；App 的绝对地址是**构建期**要求，不是代码改动 ⇒ 见 R1212 ⑧） |
| 内部服务之间的 mTLS / 额外加固 | YAGNI（compose 网络已隔离，且 R1205 只信任一跳） |

---

## 7. 设计期自审 + 独立复核

### 7.1 我的自审（5 条，**1 条硬错**）

| # | 发现 | 处置 |
|---|---|---|
| ① | 🔴 **信任设计没写死"信任谁"**：填单个容器地址（容器重建即失配，且若缓存解析会**静默**退化成"全服一个桶"）或填"所有私网段"（**有洞**：CGNAT 玩家的真实地址也可能落在私网段 ⇒ 被跳过、反而采信伪造前缀）都不可接受 | R1205（固定地址）+ A5（两处一致） |
| ② | 别手写头解析（IPv6 / 多值 / `Forwarded` 都是坑） | R1207（用 `proxy-addr`，提升为直接依赖） |
| ③ | 「8 个容器」是**散布的叙述**，改 9 之后会变假话 | §0.6 清单 + 收尾 grep 复核 |
| ④ | `apps/client` 直接依赖 `protocol` ⇒ 门口镜像要 COPY 并构建它 | R1202 / §0.4 |
| ⑤ | 手册里「代码怎么上去」是**临时**路径（片② 替换） | R1212 写明 |

### 7.2 独立复核（评审者，15 条；**其中 6 条是恒绿/跑不通/空测级**）

**判据级（6 条）**：
1. 🔴 **B5 原设计恒绿** ⇒ 改为**信任边界内部注入**（B5）；并点名**唯一采信 `X-Forwarded-For`**（`Forwarded`/`X-Real-IP` 被透传 —— 评审者隔离探针实测）
2. 🔴 **`TRUST_PROXY` 会按键合并漏进开发形态**（而开发形态 3000 是发布的）⇒ override 显式置空 + A4
3. 🔴 **可信集 = 整个网段 ⇒ 宿主与所有容器都可信**，而"全链路可信"时解析库取**最左**（=可指定）⇒ 收窄到一跳（R1205 + A5）
4. 🔴 **DoD「9 个容器」在开发形态恒不成立**（profile 默认不起门口）⇒ 按形态分写（§4）
5. 🔴 **`down` 删不掉带 profile 的容器** ⇒ 旧门口容器常驻 = 空测 ⇒ B0 生命周期协议 + 残留判据
6. 🔴 **B4 的地址形态与 TTL 陷阱**（`::ffff:` vs 纯 IPv4；键 60s 过期）⇒ 与**控制桶**比 + 与 `inspect` 比 + 同一步读写 + 缺失要响亮

**交付物与契约面（9 条）**：7 爆炸半径清单（§0.6 已逐条收录，含我漏掉的 README 与 R509）· 8 「镜像内构建 H5」**从未跑过** ⇒ 列为**必须实测**的步骤 + `.dockerignore` 补 `.env*.local` + 「Dockerfile 不得 COPY `.env`」契约定死 · 9 `isolatedEnv`（A8）· 10 门口日志上限与运行期清单（A7）· 11 C7 指名文件与条数（原文「判据 10/12 继续绿」**无指认对象**）· 12 门口硬化与运维面（R1208 + 手册的证书判别检查）· 13 §7.1 必须**裁决**而非顺手改（R1210）· 14 WS 侧不能用 Express 的 `trust proxy`（R1207）· 15 `--profile` 全局参数 + `ipam` 避让（R1209 + 手册排错表）

**我未照单全收的 1 条**：评审者称「证书签发失败时 Caddy 会退回自签并继续 200」—— 本机**证不了**（只跑了 `tls internal`）⇒ 不写进 spec 当事实，改为**判别检查**（§6）+ A6a/A6b 两道闸。

**范围结论**（评审者）：**不建议再拆**；必须并入的 = 第 7/8/9/10/12 条（已并入 A5–A8、B0、手册与文档同步）。

### 7.3 规格交付后复核（第二轮：本轮在 spec 落盘后逐节重读）

| # | 发现 | 处置 |
|---|---|---|
| ① | 🔴 **A6 原写法不可判**：「渲染出的 `TLS_MODE` ≠ `internal`」是**测试自己喂的值自己判** —— 没有判别力 | 改为 **A6a**（fail-closed：不提供 ⇒ 渲染**必须失败**）+ **A6b**（Caddyfile 文本不得含字面 `tls internal`） |
| ② | 🔴 **§4 表把 `TRUST_PROXY` 标成"门口的"** —— 它属于 **`api-gateway`**（限流在那里）；放门口**完全无效** | §4 表头改正 + R1205 写明归属 |
| ③ | ⚠️ **端口与 `SITE_ADDRESS` 的耦合没写**：容器**监听**的端口由站点地址决定 ⇒ 两处必须**同一个变量驱动**，否则"容器监听的端口没人映射" | §2 新增一条 ⚠️ + 生产用域名（无端口） |
| ④ | ⚠️ **本机不需要 `8080`**（spike 实测：只发布一个端口就够；站点地址带端口 ⇒ 不另开跳转监听） | §4 表 —— ⚠️ **后半句在第四轮被实测推翻**（容器内**确实**另开固定的 `:80` 跳转监听），完整更正见 §7.5 A-2 |
| ⑤ | ⚠️ **B0 的命令缺端口变量**（会按默认 443 绑定，本机可能撞端口）+ `--profile` 位置 | B0 补 `EDGE_HTTPS_PORT=8443` 与位置说明 |
| ⑥ | ⚠️ `design.md §5.5` 之类的**陈旧数字与引用**在本轮改动后需一并核对（`A6`/`C7`/`C8` 的交叉引用） | 已逐处改 |

### 7.4 规格复核（第三轮：spec 落盘后，**独立评审者**；13 处必修 + 1 条建议，全部折进）

| # | 发现 | 处置 |
|---|---|---|
| 1 | 三处**引用错**（`apps/client/package.json:24`→**`:27`** · `Dockerfile.api-gateway:22`→**`:14`** · `rate-limit.ts:24-38`→**`:19`/`:30`/`:33-36`**）—— 我已逐处复核实属 | §0.3 / §0.4 订正 |
| 2 | 🔴 **A6a 的形态选错**：`${VAR:?}` 是**渲染期**硬失败 ⇒ 会打断 `slice-07.2-deploy.ts:437` 这**唯一**生产渲染入口（①/①b/①c/①d/③/③a 全红）；且与 `INTERNAL_SERVICE_TOKEN` 的成例（`:-` + **运行期** fail-closed）不一致。**实测**：Caddy 读到空 `TLS_MODE`（`wrong argument count … after 'tls'`）或空 `SITE_ADDRESS`（`server block without any key`）**都是 `exit 1`** ⇒ 运行期 fail-closed 天然成立 | §2 的 ⚠️ 与 A6a 改写 |
| 3 | 遗漏：§0.5 未收「生产渲染的**环境供给**」这一行（既有共享设施） | §0.5 加 `:437` 行 |
| 4 | 🔴 **A4/A5 的渲染值语义没闭合**：基文件若写 `${TRUST_PROXY:-}` ⇒ 两边都空 ⇒ A5 恒红、A4 的负对照**永远取不到** | A4/A5 改写（基文件写**字面**地址；`null` ⇒ **红**；给出证伪法） |
| 5 | 🔴 **R1205 的「显式置空」措辞错**：`${TRUST_PROXY:-}` 是**透传 + 默认空**，宿主设了会漏进去（实测三种写法对比） | R1205 改写（并说明为何不用无条件 `TRUST_PROXY=`） |
| 6 | 🔴 **§4 与 B4/B6 自相矛盾**：§4 说该形态信任为空，而 B4/B6 要求非空（否则 **B6 恒绿空测**） | §4 行 + B0 命令改为**显式注入** |
| 7 | 🔴 **§D 的 `docker compose build` 不构建门口**（带 profile 的服务被跳过；实测唯一可构建服务带 profile 时输出 `No services to build`） | §D 改为 `--profile edge build` |
| 8 | 🔴 **A7 运行期半边在开发形态静默通过**（既有形态对「没在跑」的容器只 `info`） | A7 改为**按形态**断言 |
| 9 | 遗漏：`design.md:936`（R473 注记「编排里**没有**终结者」）也会变假话 | §0.6 加行 |
| 10 | 遗漏：§2.1 的「**对外** HTTP 端口」语义与 `api-gateway` 行 | §0.6 加行 |
| 11 | 🔴 **§8 的「全仓 0 命中」做不到**（「8 个容器」在开发形态下必须继续存在；`3000` 在 `design.md` 有 15 处命中、只有 2 处要动） | §8 改为**逐行**复核 + 窄域 grep |
| 12 | 遗漏：两条全局约束（探针逐字不变 / 判据只增不减）**没有可执行判据** | §8 加「全局约束（可执行）」行 |
| 13 | 遗漏：手册缺**变量与密钥的来源面**（落点 / 生成 / 自检） | R1212 展开为**七节** |
| 14 | 建议：§2 变量表无 `TRUST_PROXY` 行 · B4 未写「拿什么造桶」· A6b 防注释误判 | 三处已补 |

**评审者已实测验明、无需改**：`deploy/Caddyfile` 逐项（`caddy validate` 通过 · `handle /api/*` 与 `/socket.io*`（含无斜杠）与兜底 ✓ · HSTS/`nosniff` 出现在**所有**响应 · `request_body 1MB` 超限 ⇒ **413** · 日志真写文件 · 站点地址带端口 ⇒ 只监听该端口）· B0 生命周期命令 ✓（补注入后）· B4 在本机稳定（控制桶 = 宿主网桥地址）· §0 其余引用逐条 ✓ · `ledger-counts.mjs` 存在 ✓。

⚠️ 评审者顺带查到**环境里有一个旧的残留容器** `pokergame-robot-service-run-4aa96bc71099`（某次 `compose run` 留下的、`Up 5h` 且 `unhealthy`）—— 属「常驻容器 ⇒ 判据可能测旧镜像」同族，需清理（已在本会话处理，见交接/台账）。

### 7.5 规格复核（第四轮：**两路独立评审并行**，分工不重叠）

> 组织方式（本仓首例）：**A 攻判据与机制**、**B 攻事实与边界**，各自独立跑、互不参考；我负责汇总与折算。
> ⚠️ **过程教训**：本轮期间 spec 被**并发改动**（370 → 380 → 387 行），评审者 A 因此三次重算行号，并有一条发现"在折算中顺手被修掉" ⇒ **下一轮先冻结文件**（本仓规矩：判据/引用的行号会随折算漂移）。

**A 路（判据与机制）：8 必修 + 4 小修**（全部折进）

| # | 发现 | 处置 |
|---|---|---|
| A-1 | 🔴 **B0 的注入打不到网关**（实测：`up -d edge` 只点名服务 ⇒ **不重建 `api-gateway`** ⇒ 网关仍是空信任）⇒ **B4/B6 静默量错形态** | B0 改为**连 `api-gateway` 一起点名** + 一条**自证注入到位**的 `docker inspect` 断言（否则红） |
| A-2 | 🔴 **§2/§4 三处「跳转监听 / 发布到宿主」互相矛盾，且两处与实测相反**（实测：容器内**确实**另开 `:80`；基文件两条发布**对两种形态都生效**、override 减不掉 ⇒ dev+edge 实发 `{80,8443}`，不设变量时还有一条**死映射**占宿主 443） | §2 改写为「**监听与发布分开写**」（宿主侧才跟 `EDGE_HTTP_PORT`：`"${EDGE_HTTP_PORT:-80}:80"`）+ §4 端口格改正 |
| A-3 | 🔴 §4 第 1 行仍写「空（显式置空）」—— 与已改对的 R1205 自相矛盾 | 改为「透传 + 默认空；宿主显式 export 会漏入 ⇒ A8 的剔除正是为此」 |
| A-4 | 🔴 **我加的门口 healthcheck 在生产必不健康**（实测：`curl -fk https://localhost:<port>/` 只在站点 host 是 `localhost` 时成立；生产用域名 ⇒ 握手失败 ⇒ 永远 `unhealthy`）—— 方向反了 | 改用**形态无关**的那条（容器内 `:80` 跳转 ⇒ 实测两形态都 `308` ⇒ `curl -f` exit 0）+ `start_period`；手册 ④ 记「`up -d` 返回 0 ≠ 门口在服务」 |
| A-5 | 🔴 **§8 的「探针逐字不变」机械形态是空测**（`git diff --exit-code` 只比索引 vs 工作树 ⇒ 提交后恒绿） | 改为 **blob 钉死**（`git rev-parse HEAD:scripts/browser-e2e.mjs` = 实测值） |
| A-6 | §8 缺 A6a/A6b/A7/A8/A9 的完成行；「四条链」与 §5 的三条链不符 | 加「门口闸」行；统一为**三条链** |
| A-7 | 「见 R1212 ⑦」两处应为 **⑧**（R1212 已扩成八节） | 已改（全文 2 处） |
| A-8 | **App 包「绝对地址注入」无可观测量**（不注入的构建同样 DONE ⇒ 判别力 0） | R1212 ⑧ 的预期输出改为可判：构建后 `grep -rl "https://<域名>" apps/client/dist/build/app \| wc -l ≥ 1` |
| A-9 | 🔴 **空信任表 vs 非法值的边界没写死**；`proxy-addr` 三种空值行为**互不相同**（`compile('')` 抛错 · `compile([])` → `undefined` ⇒ **请求期 500** · `compile([''])` 抛错） | §3 加「空值语义」段：空 ⇒ 信任表为空、**根本不调 `compile`**；C5 只判**非空不可解析**（夹具 `9.9.9.9.9` / `172.18.0.250/33`） |
| A-10 | §0.5 的 `dev.sh` 行把「用的是 v1」当事实 —— 本机实测是 **v2 血统**（v5.5.1）且支持 profile | 降级为「未证风险只限真有 v1 的机器」 |
| A-11 | A1 的「参数化后的 80/443」无判别力（写死字面量也渲染同样结果） | A1 加**第二次渲染**（`18080/18443` ⇒ 发布集恰为该两者、两侧同值）作判别力来源 |
| A-12 | A3 的枚举与 §0.1（真实 dev 渲染 **10** 条映射）不一致 | 补指向既有 ② 组（`3306/6379/2021`） |
| A-13 | B6 缺 B4 的两句（造桶方式、缺失要响亮）；B4 缺「两条链必须同一来源方」 | 已互相补齐 |

**B 路（事实与边界）：12 必修 + 5 建议**（全部折进；详见上方各节，含三条「不修就上线出事」的：**证书命名卷**（A9 + R1202）· **固定地址选址**（R1205 + 手册）· **App 端同源为假**（§0.2 + R1212 ⑧））

**两路共同印证**（各自独立测到同一结论）：Caddy **替换** `X-Forwarded-For` 而**透传** `Forwarded`/`X-Real-IP` · `--profile` 是全局参数 · `down` 删不掉带 profile 的容器 · 空 `SITE_ADDRESS`/`TLS_MODE` ⇒ `caddy validate` exit 1（A6a 运行层成立）· C7 条数 15/5/2/38 · `request_body 1MB` **不伤实时连接**（WS 升级 + 一帧往返实测通过；超限 ⇒ 413）。

### 7.6 最终全分支评审（整片 30 提交 / 283KB，最强模型）+ 修复轮（`f031d48`）

**verdict：With fixes** —— **0 Critical · 4 Important · 10 Minor · 4 Recommendations**。评审者独立核实了本片的**心脏**
（一跳信任 + 只采信 `X-Forwarded-For`）**是闭的**，并做了 `proxy-addr` **2.0.7 vs 2.0.8** 的对照实验（本路径行为一致 ⇒ R1207 的版本号已订正为「2.0.7（实际解析 2.0.8）」）；
逐条试过伪造头/端口泄露/fail-closed 语义，无可达洞；并独立复跑了手册 ②2.3 的渲染自检（恰好 10 行）。

| # | 发现 | 处置 |
|---|---|---|
| **I1** | 两处 docker 子进程**无上限**：`validateWith` 缺 `timeout`、`up --wait` 缺 `--wait-timeout` ⇒ 会把门禁**挂死而不是变红**。⚠️ **同一族第三次**（T2-M2 / T3-M7 / T5-M3） | 补 `timeout: 180_000` + `--wait-timeout 300` |
| **I2** | 🔴 **本次评审最有价值的一条：WS 维度没有任何判据** —— 而本片动机正是「5 条并发 WS」的 IP 维度；WS 侧静默退回 `'unknown'` 时**本片修的 bug 会原地复活且全绿** | B4 补判据（见 §10 的 B 行）+ 证伪。⚠️ 实施者**订正了我的指令**：`disconnect` 会 ZREM、最后一名成员被删则**整键消失** ⇒ 不能复用 B3 的桶，必须自开一条 wss 连接（否则是假红） |
| **I3** | `JWT_SECRET=${…:-dev-secret-change-in-production}` 与 `DB_PASSWORD:-root` 是**静默**失败（与 `INTERNAL_SERVICE_TOKEN` 的 fail-closed 方向相反），而 ①k 看不见它（两边同一默认值 ⇒ 「逐字相等」照样成立） | 手册 ② 加一条**必须 0 命中**的自检 |
| **I4** | 两处**控制者已裁决但未执行**的动作 | 删除死文件 `Dockerfile.services`（0 活引用 + `COPY .env.local` 已不可满足）· 补 R1202 的**镜像层**判据（`find /srv -name ".env*"` 为空；镜像不在则只 info） |

**Minor**：修掉 M1（A6b 收紧为「剥行注释后不含字面 `internal`」+ 那条强于事实的注释）· M2（B4「控制桶」措辞强于事实）· M5（`finally` 应为复原而非 `delete`）· M6（基文件加顶层 `name: pokergame`，实测目录名无关）；**登记不修** M3（`parseTrustProxy` 接受具名预置/CIDR —— 风险有界）· M4（每请求 compile，微秒级）· M7（`--no-frozen-lockfile` 与 `node:20-slim` EOL，全仓既有选择 ⇒ 建议下一片）· M8（裸 `/api` 落 `file_server` 404）· M9（两条「已清」守卫的窄假红窗 ⇒ 建议进已知假红清单）。

**Recommendations → 交下一片**：
- **R2（→ 片②）**：`pnpm run ci` 与 Actions **完全不含 conformance** ⇒ 本片新增的生产形态保证（A1–A10）**没有任何自动闸**。接法只需让 `run.ts` 的 `main()` 对纯渲染用例跳过 `assertGatewayHealthy()`，即可在 Actions 加一个 job（`docker compose config` **不需要 daemon**）。
- **R4（产品级）**：本片让按 IP 限流**第一次真正生效**（此前生产等价于「全服一个桶」）；对**共用出口 IP**（移动网络 / CGNAT）的玩家是硬阈值（单 IP 5 条并发 WS / 120 次 HTTP 每分钟）⇒ 上线后观察；退路是「已认证按 `userId`、匿名按 IP」。
- R3（手册补磁盘卫生）已落地：⑦7.3 加 `docker image prune -f`（本机实测回收 **1.734GB**；只删悬空镜像）。

---

## 8. 完成判据

| 项 | 判据 |
|---|---|
| 门口三条链 | B1/B2/B3 在本机**真栈**上绿（加密 · 静态站 · `/api` 转发 · `wss` 升级 + 一次业务往返） |
| 门口闸 | A6a/A6b 绿（fail-closed 两层 + 负对照）· A7 绿（日志上限 + 访问日志走 stdout）· A8 绿（`isolatedEnv` 剔除 5 变量）· **A9 绿（`/data` 命名卷）** |
| 端口收敛 | A1/A2/A3 绿（生产只门口发布；api-gateway 零发布） |
| 可信 IP | A4/A5 绿 + B4/B5/B6 绿 + C1–C6 与 C8 绿（含伪造负对照与归一化）；C7 = 既有四个文件条数不减 |
| 形态与生命周期 | §4 的三形态对照逐项可复现；B0 收尾无残留 |
| 容器数 | 开发 **8** · `--profile edge` **9** · 生产形态渲染 **9**（§4；DoD 按此写） |
| 不受影响 | 探针 `gate`/`full` **逐字不变**；`slice-07.2-hardening` 与其余 slice 全绿；既有 C7 四个文件条数不减 |
| 门禁 | `pnpm run ci` 六阶段 · conformance 全量 · `build:h5`/`build:app` |
| 声明落盘 | `docs/design.md` §2.1/§2.2/**§2.3**/**§4.1**/§7.1/§14.4 与 §0.6 全表同步；`README.md` 服务端口清单更新（含门口两行、api-gateway 标网内）。⚠️ 复核 = **逐行**（「旧句在**该文件**内不存在 + 新句存在」）；**不**做全仓 0 命中 —— 「8 个容器」在**开发形态**下必须继续存在，且 `3000` 在 `design.md` 有 15 处命中、只有 2 处要动。全仓 grep 只用于**窄域新增**（如「`deploy/Caddyfile` 不得出现字面 `tls internal`」），并排除 `.worktrees/**`、`**/dist/**`、`docs/superpowers/**`（历史记录） |
| 全局约束（可执行） | 探针「逐字不变」= **blob 钉死**：`test "$(git rev-parse HEAD:scripts/browser-e2e.mjs)" = 052b98b7ab779ae280d6673729053145e9829604`（⚠️ 裸 `git diff --exit-code` **只比索引 vs 工作树** ⇒ 提交后**恒绿**、是空测 —— 评审者实测）+ 探针 `gate 18/18` / `full 33/33` + `node scripts/ledger-counts.mjs`（对账闸）+ `scripts/ci.sh` 的 `run_gate`（0 用例即红） |
| 手册 | `docs/ops/first-deploy.md` 存在，且**每条命令带预期输出**、「代码怎么上去」一节标明是临时路径 |
| 判据只增不减 | 各包条数不减；新增条数在回填时逐项列出 |

---

## 9. 范围与顺序（**一片做完**，实施按 A → B）

| 顺序 | 内容 | 完成时能看到什么 |
|---|---|---|
| **A · 形态与门口骨架** | R1202/R1203/R1208/R1209/R1210 · §0.6 文档同步 · A1–A3 / A6a / A6b / A7 / **A9** / A8 · B0–B3 | 门口在本机**三条链**跑通；生产形态端口收敛完成；手册可执行（除可信 IP 一节）。⚠️「镜像内 H5 构建」已由**简易探针**验过（§0.7），真 `Dockerfile.edge` 上**仍需重验** |
| **B · 可信 IP 与硬化收口** | R1204–R1207 · A4/A5 · B4–B6 · C1–C8 | 限流在门口之后**语义不变**（含伪造负对照）；生产形态的信任配置有两处一致的机械闸 |

**为什么这个顺序**：A 把「形态」一次改到位（端口/镜像/生命周期），B 才在稳定的形态上改语义 —— 避免两个变量同时动、归因面变糊。中途可见进展，但不付两轮的 spec/plan/门禁代价。

---

## 10. 完成状态（**实施后回填**，2026-09-24）

| 项 | 结果 |
|---|---|
| 判据 A / B / C / D | **A（结构，`slice-07.2-deploy`）全绿**：A1/A1′（第二次渲染 `18080:80` + `18443:18443`）/A2/A3/A4/A5（TRUST_PROXY 逐字等于门口固定地址）/A6a(i)/A6b/A7/A8（含 ①j 注入自证）/A9（`/data` 命名卷）。**A6a(ii) 运行层**：空值 `caddy validate` exit ≠ 0（实得 1）/ 喂值 exit 0。**B（真栈，`slice-07.3-edge`）33/33 全绿**：B0 生命周期（自证注入到位 + 收尾无残留）/ B1/B2/B3 三条链 / B4/B5/B6 限流归属 + 边界内注入 + 两个透传头的伪造负对照。**最终评审后补**：① **WS 维度的派生 IP 判据**（I2 —— 本片动机正是「5 条并发 WS」，原三条判据只读 `http-ip` ⇒ B4 现自开一条**经门口的 wss 连接**并断言 `ratelimit:ws-conn:*` 的**地址段 == 网桥地址**且**≠ 门口地址**；⚠️ 实测：`disconnect` 会 ZREM、最后一名成员被删则**整键消失** ⇒ 不能复用 B3 的桶，必须自开；证伪：把 `requestIp` 改成 `return 'unknown'` 重建网关 ⇒ 该断言红、复原后绿）；② **镜像层 `.env*` 检查**（I4b：`find /srv -name ".env*"` 为空；镜像不在本地时只 info）。**C（单测）**：C1–C6、C8 绿；C7 四个文件条数 **15 / 5 / 2 / 38** 逐字不减（本机实测）。**D**：见下格。 |
| 门禁与探针 | **`pnpm run ci` 六阶段全绿**（install / lint / build / test / coverage / eslint-forbidden）。**包条数（不减）**：shared **199** · room **296** · api-gateway **172** · game **114** · robot **62** · protocol **49** · client **500** · user-service **44**（另 mock-server 2；turbo 19/19 tasks successful）。**conformance 15/15 全绿**：05 **29** · 06 **44→114**（⚠️ **计数随 Redis 累积房间数变**：8 固定 + 2×房间数；实测 18 房间 ⇒ 44、53 房间 ⇒ 114，两次都 ✅ —— 与既有口径「只看尾行 ✅」一致）· 07 **39** · 07.1 **28** · 08 **55** · 09 **160** · 10 **185** · 11 **50** · 12 **77** · 07.2-security **43** · 07.2-boundary **82** · 07.2-hardening **103** · **07.2-deploy 130 → 134** · 07.2-rpc **65** · 07.3-edge **26 → 33**（数字为**最终修复轮后**实测；控制者复跑 deploy **134**/21.0s 与 edge **33**/24.1s）。**双 build DONE**（`build:h5` / `build:app`）；**`docker compose --profile edge build` 绿 ⇒ 7 镜像 Built（含 `ftl-edge:latest`）**。**探针**：`gate 18/18` · `full 33/33`（Windows 三处绕法：自起 dev server + `--no-server`、`CHROME_BIN`、`--cdp-port 18800`）；`git rev-parse HEAD:scripts/browser-e2e.mjs` = **052b98b7ab779ae280d6673729053145e9829604**（逐字不变）。**对账闸**：`node scripts/ledger-counts.mjs` ⇒ §0 与 §1.x 逐区一致（99 条：97 关闭 / 1 部分关闭 / 1 仍开放 / 0 文档过期）。**真栈卫生**：8 常驻容器全程 healthy；各轮收尾后无 `ftl-edge` / `ftl-conformance-*` 残留。 |
| 文档同步 | **§0.6 全表逐行完成**：`docs/design.md` §2.1（加 `edge` 行 + api-gateway 标**网内** + 「对外 = 门口」）· §2.2（容器数按形态：开发 8 / `--profile edge` 9 / 生产 9）· §2.3（**+5 变量**）· §4.1（客户端 ↔ **edge** → 网内明文）· §7.1（**R1210**：门口**就是**本仓 TLS 终结者；`[部分实现]` 保留、理由改写为「真证书路径未验证」）· §14.4（两处「8 个容器」标注为开发形态）；`README.md` 服务端口（**+门口两行**、api-gateway 标网内）；`agent-briefs.md` 两处；`deviation-ledger.md` R509（只放行 **80/443**、3000 不发布）；`scripts/dev.sh`（`docker-compose` → `docker compose` 全量：检查 + 4 处调用 + 2 处提示）；两份 compose 文件头（Task 2 已改到位，本轮复核 `只发布 3000|两样` 0 命中）。**复核 = 逐行**（「旧句在**该文件**内不存在 + 新句存在」，逐条实测；**不做**全仓 0 命中 —— 「8 个容器」在**开发形态**下继续存在、`3000` 在 `design.md` 有多处其它命中）；窄域新增 grep（`deploy/Caddyfile` 无字面 `tls internal`）用与 A6b **同一个行首锚正则** `^\s*tls\s+internal` ⇒ 0 命中（注释里的字面**不**误报）。**Step 0（既有缺陷，生产阻断级）**：`docker-compose.yml` 的 api-gateway 补 `JWT_SECRET=${JWT_SECRET:-dev-secret-change-in-production}` + 新判据 **①k/A10**（证伪实测：删行 ⇒ 红，原文「验签方=null」）+ 手册 ⑥ 详注⑨ 临时补丁**删除**（速查表第 9 行同删；② 三处交叉引用同步自洽：2.3 渲染自检 **9 行 → 10 行**、`JWT_SECRET` 恰好 2 行且逐字相同）。 |
| 已知取舍与遗留 | ① **真证书（ACME）签发路径未验证**（本机无域名 ⇒ 只验过自签 `tls internal`；手册 ⑤5.4 的「不加 `-k` 能通 = 真证书」判别检查 + A6a/A6b 两道闸兜住）；② 片②（GitHub/Actions/镜像仓库）与片③（监控/备份）**明确不做**（§6）；③ `.worktrees/**` 两份旧形态 compose **冻结为旧快照**、不参与任何 grep 判据（本片未删，§0.5）；④ **环境事实（非仓库缺陷）**：`--profile edge build` 首跑红 —— `python:3.14-slim` 不在本地 + `auth.docker.io` 解析失败 ⇒ `docker pull python:3.14-slim` 后重跑全绿（记忆 `windows-dev-env-quirks` 第 8 条同族：**先看 base 镜像在不在本地**）；⑤ 常驻容器与新建镜像的 **image ID 不同**（classic vs BuildKit 元数据差异），但 5 个 Node 服务的 `dist` 聚合 md5 **逐字节一致**（逐服务实测）⇒ 本片门禁读数对**最终镜像**同样成立（反「常驻容器 = 旧镜像」空测的成例，记忆第 9 条）。 |
