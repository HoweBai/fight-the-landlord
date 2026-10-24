# 独立小片 P4 实施计划：§4.2 的 TCP RPC 迁移（N20）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「服务间调用全是内部 HTTP + `X-Internal-Token` 过渡形态、`connectMicroservice` 与 3103/3105 **零监听方**」修成 §4.2 逐字要求的形态：`game-service` / `robot-service` 各起一个 `Transport.TCP` 微服务监听（3103 / 3105），**全部**内部调用点（`game.start` / `game.snapshot` / `game.view` / `game.action` / `robot.acquire` / `robot.release` / `robot.decide`）换成 `ClientProxy` + `@MessagePattern`，内部 HTTP 路由**整条删除**（一次全切，不留第二条路径），并把 conformance 的内部面判据从「直连 HTTP」改成「直连 TCP RPC」。

**Architecture:** 「对外 HTTP」与「对内 RPC」是**两条通道**，本片把内部面整条搬到 TCP：

```
客户端 ──HTTP/WS──▶ api-gateway ──HTTP──▶ game-service   仅「对客户端裁剪视图」(game.view)
                            └──HTTP──▶ room-service
                            └──HTTP──▶ user-service
room-service ──TCP 3103──▶ game-service   game.start / game.snapshot / game.view / game.action
room-service ──TCP 3105──▶ robot-service  robot.acquire / robot.release
game-service ──TCP 3105──▶ robot-service  robot.decide
game-service ──Redis pub/sub──▶ room-service ──socket.io──▶ 客户端
```

内部 HTTP 路由（`POST /api/games`、`GET /api/games/:roomCode/snapshot`、`POST /api/robots/acquire|release|decide`）**删除**；`GET /api/games/:roomCode`（+`/state` 别名）、`POST /api/games/:roomCode/{bid,play,pass}`、`GET /api/robots/list` 是网关/客户端可达面，**保留**。RPC 端口在基文件里只用 `expose`（生产形态不发布），宿主映射只出现在 `docker-compose.override.yml`（开发/联调形态），沿用 R98/R144 的既有形态。

**Tech Stack:** TypeScript / NestJS 10 / `@nestjs/microservices`（`Transport.TCP`）/ rxjs / ioredis / Vitest / pnpm workspace + Turborepo / socket.io 4 / Docker Compose

**Spec:**
- `docs/design.md` v4.2 —— **§2.1（服务清单与端口：`game-service` RPC 3103、`robot-service` RPC 3105）· §2.3（环境变量表：`RPC_PORT` / `*_RPC_HOST` / `*_RPC_PORT`）· §4.1（通信方式总表）· §4.2（TCP RPC 契约，逐字）· §4.3（超时 / 重试 / 降级表）· §5.2 规则 3（内部身份边界）**
- `docs/superpowers/plans/deviation-ledger.md` §1.5 **N20** + §2「独立小片（P4 / 基础设施）」
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」（robot-service 是 bind-mount、`DOCKER_BUILDKIT=0`、门禁必须 `--force` 且每条 conformance 套 `timeout`、conformance 必须**独占**跑）+ 「切片 11 新增的通用教训」第 5/7 条（机械闸的正对照会随功能落地而失效；「没扫到坏东西」在旧栈也可能是绿的 ⇒ 判别力要来自**正向**断言）
- **切片 11 的范围裁决 R200**：TCP RPC 迁移**不在**切片 11，登记为 N20 → 本片

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节（端口 / Vitest / **TCP+RPC pattern** / 对外 REST 与内部 RPC 严禁共用方法 / socket.io ack / `baseVersion` CAS + `13004` / 5 位数字错误码 / 身份只从网关注入 / 裁剪 / 牌值 DouZero 进出判定还原内部 Rank / 前端哑终端 / `packages/protocol` 协调者独占 / 所有出站路径过 `validateOutbound()`）。

### 本切片的绑定数值（逐字，来自 `design.md` §2.1 / §2.3 / §4.2 / §4.3）

| 项 | 值 |
|---|---|
| RPC 端口（§2.1） | `game-service` **3103** · `robot-service` **3105**；「仅供服务间 `Transport.TCP` 使用，**不对外暴露**」 |
| `RPC_PORT` 默认值（§2.3） | `game-service` `3103` · `robot-service` `3105` |
| `GAME_SERVICE_RPC_HOST` / `_PORT`（§2.3） | room-service：`game-service` / `3103` |
| `ROBOT_SERVICE_RPC_HOST` / `_PORT`（§2.3） | **room-service / game-service**：`robot-service` / `3105` |
| 监听方配置（§4.2 末段） | `app.connectMicroservice({ transport: Transport.TCP, options: { port: RPC_PORT } })` |
| `game.start`（room → game，§4.3） | **3s** / 重试 **1 次** / 失败 ⇒ 房间置 `cancelled`，通知玩家 |
| `game.snapshot`（room → game，§4.3） | **2s** / 重试 **1 次** / 失败 ⇒ 返回 `10007` |
| `robot.acquire`（room → robot，§4.3） | **3s** / 重试 **1 次** / 失败 ⇒ 以较少人数开局（不补机器人） |
| `robot.decide`（game → robot，§4.3） | **5s** / **不重试** / 失败 ⇒ 回退规则引擎（§9.3） |
| 幂等前提（§4.3） | 所有 RPC **幂等**（同一 `roomCode` 重复调用不产生副作用）—— 这是「重试 1 次」的前提 |
| `game.action` | §4.2 **未给动作定义 pattern**（动作的正规通路是 WS ack）。本片按 §4.1 的「room → game」表把它一并搬上 TCP（它今天也**只**由 room-service 调），pattern 名与形状见 **R219** |
| 本片相关错误码 | `10002` 内部 token 缺失/错误 · `10007` 下游不可达 · `12004` 不在本局 · `13004` 版本冲突 —— **不新增任何错误码** |

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接切片 11 的 **R217**，从 **R218** 起。执行期若发现与代码事实不符，**就地记「执行期裁决」并写进计划文件**（不隐去历史）。

- **R218（本片的总口径）「一次全切」，且切的是「内部面」而不是「所有 HTTP」。**
  - **删**（内部专用，改走 TCP）：`POST /api/games`（`game.start`）、`GET /api/games/:roomCode/snapshot`（`game.snapshot`）、`POST /api/robots/acquire` / `POST /api/robots/release` / `POST /api/robots/decide`。
  - **留**（对外/网关可达面）：`GET /api/games/:roomCode` 与 `GET /api/games/:roomCode/state`（§4.1 的「gateway → game-service HTTP」这条边**逐字保留**）、`POST /api/games/:roomCode/{bid,play,pass}`、`GET /api/robots/list`（conformance 的池检查判据要用它，§4.1 没有它但也没有禁止——它是**只读诊断**端点，见 R222）。
  - 裁决理由：§4.1 的总表**同一张表里**既有「gateway → game-service HTTP」又有「room-service → game-service TCP」，说明「对外 HTTP / 对内 TCP」是**按通道**分的，不是「全仓禁 HTTP」。把 `GET /api/games/:roomCode` 也搬走会让 §4.1 的那一行无处落地。
  - **禁止**：任何形式的两条路径并存（既留 HTTP 又加 TCP 同一语义）——那就是第二个真源，正是本片要消灭的东西。

- **R219 动作转发的 RPC 形状：单一 pattern `game.action`。**
  §4.2 没给动作定义 pattern，而 room-service 今天通过 `message.router.forwardAction()` 用**一个**抽象（`action: 'bid'|'play'|'pass'` + payload + `baseVersion`）调它。**不拆成三个 pattern**（那会把同一个 CAS 语义复制三份），定义：

  ```ts
  // packages/protocol/src/rpc.ts
  export const RPC_PATTERNS = {
    gameStart: 'game.start', gameView: 'game.view', gameSnapshot: 'game.snapshot',
    gameAction: 'game.action',
    robotAcquire: 'robot.acquire', robotRelease: 'robot.release', robotDecide: 'robot.decide',
  } as const;
  export interface GameActionRequest {
    roomCode: string; userId: string;
    action: 'bid' | 'play' | 'pass';
    payload: Record<string, unknown>;   // bid: {grab} / play: {cards} / pass: {}
    baseVersion: number;
  }
  ```
  **动作仍然不重试**（§4.3 的重试表只覆盖 `game.start` / `game.snapshot` / `robot.acquire`；动作是 CAS，重试会重复出牌）。

- **R220 错误码跨 RPC 边界的方式：显式信封，不用 Nest 的 `RpcException` 字符串。**
  Nest 的微服务异常在客户端侧只剩 `message`/`status`（字符串），而本仓的**硬性约束**是 5 位数字码 + 调用方按码分流（`message.router` 的 `isMissingGameError` 区分 `12004` 与 `10007`；R156 族）。因此**所有 RPC handler 返回信封**：

  ```ts
  export type RpcResult<T> =
    | { ok: true; data: T }
    | { ok: false; code: ErrCode; message: string };
  ```
  handler **不抛**业务错误（只让它成为 `{ok:false,...}`）；调用方按 `code` 分流。**传输层故障**（连不上 / 超时）仍由调用方映射成 `UPSTREAM_UNAVAILABLE (10007)`（与今天的 HTTP 分支逐字同码）。

- **R221 超时/重试的落地手法（§4.3 逐条）。**
  每个客户端方法 = `lastValueFrom(proxy.send(pattern, payload).pipe(timeout(TIMEOUT_MS), retry(...)))`：
  - `retry(RPC_MAX_ATTEMPTS - 1)`，`RPC_MAX_ATTEMPTS = 2`（**恰好重试 1 次**，与切片 11 的 A7⑤ 逐字同值）；
  - `timeout()` **在 `retry()` 之内** ⇒ 每次重试**重新计时**（正确的「每次尝试各自 3s」语义）；
  - `robot.decide` **不套 `retry()`**（5s / 不重试）；
  - **判据必须走真实 pipeline**：单测注入假 `ClientProxy`（`send()` 返回可控 Observable，例如 `throwError` / `NEVER` / `of(信封)`），而不是只断言「调了 `send()`」。

- **R222 `robot-service` 保持双栈（HTTP + TCP），`game-service` 同样。**
  §4.2 只要求「`game-service` 与 `robot-service` 必须启动 TCP 微服务监听」；两者的**对外 HTTP 面**（`GET /api/robots/list`、`GET /api/health`、`GET/POST /api/games/*`）必须继续存在（healthcheck 与网关都依赖它）。`user-service` / `room-service` / `api-gateway` **不**起 RPC 监听。

- **R223 内部 HTTP 路由删除后，`X-Internal-Token` 边界不变。**
  全局中间件（`createInternalTokenMiddleware()`，`/api/health` 豁免）继续保护 `game-service` / `robot-service` 的**剩余** HTTP 面 —— 删掉的是「被 TCP 取代的那几条路由」，不是这道边界。**TCP 监听方不走 HTTP 中间件**：TCP 端口本身只发布在 compose 内网（基文件 `expose`，宿主映射只在 override），未发布 ⇒ 外部不可达，与 §2.1「不对外暴露」逐字一致。

- **R224 `game.view` 在两侧都不接受 `seat`。**
  §4.2 逐字：「**seat 由服务端从 userId 解析，不由调用方提供**」。因此 RPC `game.view({roomCode, userId})` 与 HTTP `GET /api/games/:roomCode` **都**只吃 `userId`，且**共用同一个** `GameService.getViewForUser(roomCode, userId)`（座位解析的唯一实现），不允许出现第二处 `findSeatByUserId` 调用点。

- **R225 源码级机械闸换判据：从「钉住 HTTP 形态」改成「钉住**内部面没有 HTTP**」。**
  切片 11 的 A7④ 已经上过一课（判据钉 `fetch` 形态 ⇒ 实现一改就红在正对照上）。本片再加一条**结构性**闸 `packages/room-service/test/no-internal-http.gate.test.ts`：
  - 正向（**判别力来自正向断言**，切片 11 教训第 7 条）：`room-service/src` 里必须**存在** `RPC_PATTERNS.gameStart` / `robotAcquire` 的使用；
  - 反向：`room-service/src` 不得再出现 `/api/games`、`/api/robots/` 字符串（`game.client.ts` / `robot.client.ts` / `match.service.ts` 三处）；
  - **外加**一条对 `game-service` 的反向：`game.controller.ts` 不得再出现 `@Post()` / `@Post('...')` 的空路由与 `snapshot` 路由（`@MessagePattern` 侧由 `rpc.controller.test.ts` 正向覆盖）。
  - 闸必须带**探针判别力**自证（对合成字符串测正则正/负，照抄 `outbound-timeout.gate.test.ts` 判据 B′ 的手法）。

- **R227（协调者派工后自查追加，属 Task 3）`RobotClient` 在容器里**从来没有 provider** —— 与 R217 同族的「单测覆盖不到装配层」缺陷。**
  实测源码：`ws.gateway.ts:118/126` 用 `@Optional() robot?: RobotClient` 参数注入，而 `ws.module.ts` 的 `providers` 里**只有** `GAME_CLIENT`，**没有** `ROBOT_CLIENT`/`RobotClient`。⇒ 容器里 `this.robot === undefined`，`ws.gateway.ts:478` 的 `await this.robot.release(botIds)`（`game.ended` 的 §9.6 归池）**在生产路径上必然 `TypeError`**；而单测全是手工 `new`，因此**看不到**。这与 R217（`RobotPool` 缺 `@Injectable()` ⇒ `/api/robots/acquire` 500）是同一族。
  **处置（并在 Task 3 内完成）**：① `RobotClient` 补 `@Injectable()`；② `ws.module.ts` 注册 `ROBOT_CLIENT`（`ClientsModule.register` 用**独立内部 token**（如 `ROBOT_RPC_PROXY`）避免同名覆盖，再 `useFactory` 包成 `ROBOT_CLIENT`）；③ 去掉不再需要的 `@Optional()`（或保留但**必须**有判据证明容器里拿到的是真实例）；④ **判据必须真的 `Test.createTestingModule(...).compile()`**，断言 `moduleRef.get(ROBOT_CLIENT)`/`get(GAME_CLIENT)` 是实例且非 `undefined` —— `new XxxService(fake)` 式单测抓不到这一类（R216/R217 的教训）。
  **同族排查（执行时顺手做）**：`game-service` 的 `ROBOT_RPC_CLIENT` 也必须真的被 `useFactory` 提供，且 `game.robot.test.ts` 要有一条「容器里拿得到」的判据。

- **R226 conformance 的 RPC 探针形态。**  conformance 在宿主机跑：**基文件只 `expose` RPC 端口 ⇒ 宿主连不上**，因此开发形态必须在 `docker-compose.override.yml` 里加 `3103:3103` / `3105:3105`（与 3001/3002/3003/3005 同一理由、同一位置）。
  探针是 `tools/conformance/src/lib/rpc.ts`（**零新依赖**）：Nest TCP 传输的线格式是 `{ pattern, data, id }` 的 JSON + `\n` 分帧，用 `node:net` 手写 ~60 行客户端即可；**契约由探针的 `RPC_PATTERNS` 常量钉住**（从 `@fight-the-landlord/protocol` import，不写字面量）。
  ⚠️ 若实测线格式与本假设不符（例如分帧不是 `\n`），**就地记「执行期裁决」并改探针**，**不得**为了让探针好写而改产品代码。
  新增切片名 **`slice-07.2-rpc`**（沿用 `slice-07.2-*` 命名），并把它登记进 `run.ts` 与 `tools/conformance/package.json`。

---

## 执行模型（与切片 5–11 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | **Task 0（派工前，契约 + 依赖落盘）**、评审、合并、门禁、`docs/**` 收口（N20 关闭 + §2.3 注记） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | **Task 1–5**（顺序执行；Task 3–4 依赖 Task 1–2 的产物） |
| **conformance agent** | `/home/howe/pokergame`（主检出，`tools/conformance/**`） | **Task 6**（新建探针 + 新切片 + 改造受影响的既有切片） |
| 前端 | —— | **本片无前端改动**（前端只经网关 HTTP/WS，通道一个字节都没变） |

**开工前固定动作（两个 agent 都逐字执行）**：

```bash
# 后端 agent
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current
git merge master --no-edit        # ⚠️ 用户明令：开工前先 merge（本片 Task 0 已把契约/依赖推到 master）
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ robot-service 新增 @nestjs/microservices + rxjs；裸 pnpm install 会写工作区外的 ~/.pnpm-store 而被沙箱拒绝
pnpm exec turbo run build --force # dist/ 是 gitignore 的

# conformance agent（主检出，master）
cd /home/howe/pokergame
pwd && git branch --show-current   # 必须是 master
git merge --ff-only origin/master 2>/dev/null || true
pnpm exec turbo run build --force  # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
```

**⚠️ conformance 必须独占跑**（网关按 IP 计并发 WS 连接、上限 5，§5.4）：conformance agent 在跑任何切片期间，**其他人不得**重建/重启容器、不得跑任何切片。

**汇报格式**（统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/protocol/src/rpc.ts                              Create: RPC_PATTERNS / RpcResult / GameActionRequest / GameActionResponse / StartGameRequest / GameStartedResponse（契约，协调者 Task 0）
packages/protocol/src/index.ts                            Modify: re-export rpc.ts
packages/protocol/src/messages.test.ts                    Modify: 断言 RPC pattern 名逐字 = §4.2 的七个字符串（防口口相传漂移）
packages/robot-service/package.json                       Modify: +@nestjs/microservices +rxjs（协调者 Task 0，含 pnpm-lock.yaml）
pnpm-lock.yaml                                            Modify: 同上（协调者独占）

packages/game-service/src/rpc/rpc.options.ts              Create: RPC_PORT / rpcServerOptions()（Transport.TCP 监听配置）
packages/game-service/src/rpc/game.rpc.controller.ts      Create: @MessagePattern(game.start|snapshot|view|action) ⇒ RpcResult 信封
packages/game-service/src/rpc/game.rpc.controller.test.ts Create: 四个 handler 的信封 + 幂等 + 座位只从 userId 解析
packages/game-service/src/main.ts                         Modify: connectMicroservice + startAllMicroservices()
packages/game-service/src/game/game.service.ts            Modify: getViewForUser(roomCode,userId)（R224 的唯一座位解析入口）
packages/game-service/src/game/game.module.ts             Modify: 注册 RPC 控制器 + ROBOT_RPC_CLIENT provider
packages/game-service/src/game/game.controller.ts         Modify: 删 @Post() 与 :roomCode/snapshot；view 改调 getViewForUser
packages/game-service/src/game/robot.client.ts            Modify: fetch ⇒ ClientProxy.send(RPC_PATTERNS.robotDecide)，5s/不重试，失败 ⇒ null
packages/game-service/test/robot.client.test.ts           Create: 假 ClientProxy 的三条判据（合法/抛错⇒null/5s 超时⇒null）
packages/game-service/test/game.controller.test.ts        Modify: 删掉两条已删除路由的用例
packages/game-service/test/game.robot.test.ts             Modify: 替身从 fetchImpl 改成 ROBOT_RPC_CLIENT

packages/room-service/src/gateway/rpc.options.ts          Create: gameClientOptions() / robotClientOptions()（RPC_HOST/PORT 客户端配置）
packages/room-service/src/gateway/game.client.ts          Modify: fetch/HttpService ⇒ ClientProxy.send；保留 GAME_CLIENT_TIMEOUT_MS / RPC_MAX_ATTEMPTS / GameServiceError / mapHttpStatus 的语义
packages/room-service/src/gateway/robot.client.ts         Modify: HttpService ⇒ ClientProxy.send(robot.acquire|release)
packages/room-service/src/gateway/ws.module.ts            Modify: HttpModule ⇒ ClientsModule.register([...]) + 两个 GAME_CLIENT/ROBOT_CLIENT provider
packages/room-service/src/match/match.service.ts          Modify: startGame/acquireBot 的 URL 拼接 ⇒ RPC 调用（语义逐字保留：超时/重试/降级/载荷）
packages/room-service/src/gateway/ws.gateway.ts           Modify: GameClient 的构造（useFactory 显式构造，R216 的手法不变）
packages/room-service/test/game.client.test.ts            Modify: 改成假 ClientProxy 的判据（超时/重试/错误码/不重试动作）
packages/room-service/test/match.service.test.ts          Modify: `callsTo(http, '/api/...')` ⇒ RPC 调用断言（载荷逐字）
packages/room-service/test/no-internal-http.gate.test.ts  Create: R225 的结构性机械闸（正向 + 反向 + 探针自证）
packages/room-service/test/ws.gateway.test.ts             Modify: 替身注入方式（若受影响）

docker-compose.yml                                        Modify: game/robot 加 `expose: ["3103"]/["3105"]` + RPC 环境变量；room 加 *_RPC_HOST/PORT
docker-compose.override.yml                               Modify: 开发形态加 "3103:3103" / "3105:3105"
Dockerfile.game-service / Dockerfile.robot-service         Modify: 仅在按 filter 安装依赖时需要（一般不用改 BUILD 步骤，验证即可）

packages/api-gateway/test/outbound-timeout.gate.test.ts   Modify: 正对照换掉「已不再走 fetch」的文件（R225 同族：判据钉性质不钉形态）
tools/conformance/src/lib/rpc.ts                          Create: 零依赖 TCP RPC 探针（R226）
tools/conformance/src/slices/slice-07.2-rpc.ts            Create: §4.2/§4.3 的在线判据（新增切片）
tools/conformance/src/run.ts / package.json               Modify: 注册 slice-07.2-rpc
tools/conformance/src/slices/slice-11-robot-system.ts     Modify: 第 6 组「直连 3005 acquire」⇒ TCP RPC 幂等 acquire
tools/conformance/src/slices/slice-07.2-boundary.ts       Modify: 内部面断言口径（被删路由 ⇒ 404；新面 ⇒ RPC）
tools/conformance/src/slices/slice-07.2-hardening.ts      Modify: 第 5 步直连 `POST /api/games` ⇒ RPC `game.start` 正对照；第 2/3 步注释；第 9 步 A7 闸
tools/conformance/src/slices/slice-07.2-deploy.ts         Modify: 生产形态「RPC 端口不得出现在宿主 ports」
docs/superpowers/plans/deviation-ledger.md                Modify: N20 ⇒ 已关闭（协调者收口）
docs/design.md §2.3 注记                                   Modify: `ROBOT_SERVICE_URL` 那行（协调者，§A.3 文档流程）
```

---

## Task 0（协调者，**派工前**）：契约 + 依赖落盘

> **必须先做**：两个 agent 的代码都 import 这些符号；不先落盘，两边会各自造一份（正是 R219/R224 要防的第二真源）。

**Files:** Create `packages/protocol/src/rpc.ts`；Modify `packages/protocol/src/index.ts`、`packages/protocol/src/messages.test.ts`、`packages/robot-service/package.json`、`pnpm-lock.yaml`

- [ ] **Step 1: 落 `packages/protocol/src/rpc.ts`**（字段逐字照 §4.2；注释标明来源与「内部类型，永不出站」）

```ts
/**
 * §4.2 的 TCP RPC 契约（N20 迁移的**唯一** pattern 名与载荷来源）。
 * ⚠️ 本文件的类型**永不**出现在任何 S→C 消息 / 客户端可达 REST 响应 / 日志里。
 */
import type { ErrCode } from './errors';
import type { PlayerView } from './views';

/** §4.2 的七个 pattern 名 —— **逐字**，不得改写（`messages.test.ts` 钉住）。 */
export const RPC_PATTERNS = {
  gameStart: 'game.start',
  gameView: 'game.view',
  gameSnapshot: 'game.snapshot',
  gameAction: 'game.action',   // R219：§4.2 未定义动作 pattern，本片按 §4.1 的 room→game 边补
  robotAcquire: 'robot.acquire',
  robotRelease: 'robot.release',
  robotDecide: 'robot.decide',
} as const;

/** R220：跨 RPC 边界的**显式信封** —— 5 位数字错误码必须原样到达调用方。 */
export type RpcResult<T> = { ok: true; data: T } | { ok: false; code: ErrCode; message: string };

/** §4.2 的 `StartGameRequest`（从 `game-service/src/game/dto.ts` 上移，契约唯一来源）。 */
export interface StartGameRequest {
  roomCode: string;
  baseScore: number;
  players: { id: string; seat: number; isRobot: boolean; botId?: string; skillLevel?: 'beginner' | 'intermediate' | 'advanced' }[];
}

/** §4.2 的 `GameStartedResponse`。 */
export interface GameStartedResponse { roomCode: string; state: string; version: number }

/** R219：动作转发（room → game）。`payload`：bid `{grab}` / play `{cards}` / pass `{}`。 */
export interface GameActionRequest {
  roomCode: string;
  userId: string;
  action: 'bid' | 'play' | 'pass';
  payload: Record<string, unknown>;
  baseVersion: number;
}

/** R219/R220：动作的应答 —— 成功时 `data` 是**该玩家自己的裁剪视图**（`actAndView` 的产物）。 */
export type GameActionResponse = PlayerView;

/** §4.2 的 `game.view` 入参（**seat 由服务端从 userId 解析**，R224）。 */
export interface GameViewRequest { roomCode: string; userId: string }
```

- [ ] **Step 2: 在 `messages.test.ts` 加一条「pattern 名逐字」判据**（防口口相传漂移）

```ts
it('§4.2 的 RPC pattern 名逐字不变（N20）', () => {
  expect(RPC_PATTERNS).toEqual({
    gameStart: 'game.start', gameView: 'game.view', gameSnapshot: 'game.snapshot',
    gameAction: 'game.action',
    robotAcquire: 'robot.acquire', robotRelease: 'robot.release', robotDecide: 'robot.decide',
  });
});
```

- [ ] **Step 3: `index.ts` re-export `./rpc`**（`export * from './rpc';`）。

- [ ] **Step 4: 给 `robot-service` 加依赖**（它是唯一缺 `@nestjs/microservices` / `rxjs` 的服务）：

```bash
cd /home/howe/pokergame
pnpm --filter @fight-the-landlord/robot-service add @nestjs/microservices@^10.4.0 rxjs@^7.8.2
```
⚠️ 这会改 `pnpm-lock.yaml`（**协调者独占**）。若 `pnpm add` 因写 `~/.pnpm-store` 被沙箱拒绝，改用 `CI=true pnpm install --store-dir .pnpm-store`（先手改 `package.json`）。

- [ ] **Step 5: 验证 + 提交**

```bash
pnpm --filter @fight-the-landlord/protocol test && pnpm --filter @fight-the-landlord/protocol build
pnpm --filter @fight-the-landlord/robot-service build
git add -A && git commit -m "feat(protocol): §4.2 RPC pattern 常量 + 共享 DTO + robot-service microservices 依赖（N20/P4 Task 0）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: `game-service` 起 TCP 监听 + 四个 `@MessagePattern` handler

**Files:** Create `packages/game-service/src/rpc/rpc.options.ts`、`packages/game-service/src/rpc/game.rpc.controller.ts`、`packages/game-service/test/game.rpc.test.ts`；Modify `src/main.ts`、`src/game/game.service.ts`、`src/game/game.module.ts`

**Interfaces:**
- Consumes: `RPC_PATTERNS` / `RpcResult` / `StartGameRequest` / `GameActionRequest` / `GameViewRequest`（Task 0，`packages/protocol`）；`GameService.startGame/getSnapshot/actAndView`（既有）
- Produces: `GameRpcController` 上的四个 handler（`start` / `snapshot` / `view` / `action`），**全部返回 `RpcResult<T>`**；`GameService.getViewForUser(roomCode: string, userId: string): Promise<PlayerView>`（R224 的唯一座位解析入口，HTTP `view()` 与 RPC `view` 共用）

- [ ] **Step 1: 写失败测试** `packages/game-service/test/game.rpc.test.ts`

```ts
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { GameRpcController } from '../src/rpc/game.rpc.controller';
import { GameService } from '../src/game/game.service';

/** 最小替身：只实现本片用到的三个方法。 */
function fakeGameService() {
  return {
    startGame: vi.fn(async () => ({ roomCode: 'R1', state: 'bidding', version: 1 })),
    getSnapshot: vi.fn(async () => ({ roomCode: 'R1' }) as never),
    getViewForUser: vi.fn(async () => ({ roomCode: 'R1', seat: 0 }) as never),
    actAndView: vi.fn(async () => ({ roomCode: 'R1', seat: 0 }) as never),
  };
}

describe('game-service 的 §4.2 RPC handler（N20/R220）', () => {
  let controller: GameRpcController;
  let svc: ReturnType<typeof fakeGameService>;

  beforeEach(async () => {
    svc = fakeGameService();
    const mod = await Test.createTestingModule({
      controllers: [GameRpcController],
      providers: [{ provide: GameService, useValue: svc }],
    }).compile();
    controller = mod.get(GameRpcController);
  });

  it('pattern 名逐字来自 RPC_PATTERNS（不是手写字面量）', () => {
    // 反射读装饰器元数据。⚠️ 键名是 Nest 内部的 `PATTERN_METADATA = 'microservices:pattern'`
    // （`@nestjs/microservices/constants`，**未**从包根导出 ⇒ 只能写字面量，已在 `node_modules` 上核对）。
    const patterns = Reflect.getMetadata('microservices:pattern', GameRpcController.prototype.start) as string[];
    expect(patterns).toEqual([RPC_PATTERNS.gameStart]);
  });

  it('game.start：成功 ⇒ {ok:true}；游戏层抛错 ⇒ {ok:false,code}（不抛裸错）', async () => {
    await expect(controller.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toEqual({
      ok: true, data: { roomCode: 'R1', state: 'bidding', version: 1 },
    });
    svc.startGame.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: ErrCode.ILLEGAL_ACTION }));
    await expect(controller.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toEqual({
      ok: false, code: ErrCode.ILLEGAL_ACTION, message: 'boom',
    });
  });

  it('game.snapshot：找不到 ⇒ {ok:false,code:12003}（旧 HTTP 是 404 + code 12003）', async () => {
    svc.getSnapshot.mockResolvedValueOnce(null);
    await expect(controller.snapshot({ roomCode: 'NOPE' })).resolves.toEqual({
      ok: false, code: ErrCode.ROOM_NOT_FOUND, message: expect.any(String),
    });
  });

  it('game.view：R224 —— 只吃 userId，座位由服务端解析（handler 里不得出现 seat 入参）', async () => {
    await expect(controller.view({ roomCode: 'R1', userId: 'u1' })).resolves.toEqual({
      ok: true, data: { roomCode: 'R1', seat: 0 },
    });
    expect(svc.getViewForUser).toHaveBeenCalledWith('R1', 'u1');
    svc.getViewForUser.mockRejectedValueOnce(Object.assign(new Error('not in'), { code: ErrCode.NOT_IN_ROOM }));
    await expect(controller.view({ roomCode: 'R1', userId: 'u9' })).resolves.toEqual({
      ok: false, code: ErrCode.NOT_IN_ROOM, message: 'not in',
    });
  });

  it('game.action：把 action/payload/baseVersion 原样交给 actAndView（不重试的语义在调用方）', async () => {
    await controller.action({ roomCode: 'R1', userId: 'u1', action: 'play', payload: { cards: [3] }, baseVersion: 7 });
    expect(svc.actAndView).toHaveBeenCalledWith('R1', 'u1', 'play', { cards: [3] }, 7);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/howe/pokergame/.worktrees/backend && pnpm --filter @fight-the-landlord/game-service test -- game.rpc`
Expected: FAIL — `Cannot find module '../src/rpc/game.rpc.controller'`

- [ ] **Step 3: 写最小实现**

`packages/game-service/src/rpc/rpc.options.ts`：

```ts
// packages/game-service/src/rpc/rpc.options.ts
/**
 * §4.2 末段 + §2.3：`game-service` 的 TCP RPC 监听端口。
 * 默认 3103（§2.3 的 `RPC_PORT`）；**必须是数字**（`Transport.TCP` 的 `options.port`）。
 */
export const GAME_RPC_PORT = Number(process.env.RPC_PORT ?? 3103);
```

`packages/game-service/src/rpc/game.rpc.controller.ts`：

```ts
// packages/game-service/src/rpc/game.rpc.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode, RPC_PATTERNS,
  type GameActionRequest, type GameStartedResponse, type GameViewRequest,
  type PlayerView, type RpcResult, type StartGameRequest,
} from '@fight-the-landlord/protocol';
import { GameService } from '../game/game.service';

/** 把任意抛错收敛成 R220 的信封（`GameError` 带 `code`，其余归 `ILLEGAL_ACTION`，与旧 HTTP 逐字同码）。 */
function toResult<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      const code = (err as { code?: number })?.code;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, code: (code ?? ErrCode.ILLEGAL_ACTION) as ErrCode, message };
    },
  );
}

/**
 * §4.2 的 RPC 监听方（N20/P4）。
 *
 * ⚠️ **对外 REST 与内部 RPC 严禁共用方法**（Global Constraint 4）：本控制器的方法**只**被
 * `@MessagePattern` 调用；HTTP 面（`GameController`）继续走它自己的 `view()` / `action()`。
 * 两侧**唯一**共享的是 `GameService` 的业务方法本身（那本来就是同一份状态机）。
 */
@Controller()
export class GameRpcController {
  constructor(private readonly gameService: GameService) {}

  @MessagePattern(RPC_PATTERNS.gameStart)
  start(@Payload() dto: StartGameRequest): Promise<RpcResult<GameStartedResponse>> {
    return toResult(async () => {
      const started = await this.gameService.startGame(dto);
      return { roomCode: started.roomCode, state: started.state, version: started.version };
    });
  }

  @MessagePattern(RPC_PATTERNS.gameSnapshot)
  snapshot(@Payload() dto: { roomCode: string }): Promise<RpcResult<unknown>> {
    return toResult(async () => {
      const session = await this.gameService.getSnapshot(dto.roomCode);
      if (!session) throw Object.assign(new Error('Game not found'), { code: ErrCode.ROOM_NOT_FOUND });
      return session;   // §4.2：仅服务间，绝不可用于对外路由
    });
  }

  /** R224：**seat 只从 userId 解析**，调用方不得指定座位（§4.2 的逐字要求）。 */
  @MessagePattern(RPC_PATTERNS.gameView)
  view(@Payload() dto: GameViewRequest): Promise<RpcResult<PlayerView>> {
    return toResult(() => this.gameService.getViewForUser(dto.roomCode, dto.userId));
  }

  @MessagePattern(RPC_PATTERNS.gameAction)
  action(@Payload() dto: GameActionRequest): Promise<RpcResult<PlayerView>> {
    return toResult(() =>
      this.gameService.actAndView(dto.roomCode, dto.userId, dto.action, dto.payload, dto.baseVersion),
    );
  }
}
```

`GameService.getViewForUser()`（把 `game.controller.ts` 里 `view()` 的座位解析搬进 service —— R224 的唯一实现）：

```ts
  /** R224（§4.2）：座位**只**由 userId 解析 —— HTTP 与 RPC 两个面的唯一入口。 */
  async getViewForUser(roomCode: string, userId: string): Promise<PlayerView> {
    const session = await this.getSnapshot(roomCode);
    if (!session) throw Object.assign(new Error('Game not found'), { code: ErrCode.ROOM_NOT_FOUND });
    const seat = findSeatByUserId(session, userId);
    if (seat < 0) throw Object.assign(new Error('You are not in this game'), { code: ErrCode.NOT_IN_ROOM });
    const view = await this.getView(roomCode, seat);
    if (!view) throw Object.assign(new Error('Game not found'), { code: ErrCode.ROOM_NOT_FOUND });
    return view;
  }
```

`main.ts`（§4.2 末段逐字）：

```ts
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { GAME_RPC_PORT } from './rpc/rpc.options';
// …
  app.setGlobalPrefix('api');
  // §4.2 / N20：TCP RPC 监听方。**必须**在 `listen()` 之前连、之后 `startAllMicroservices()`。
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: { host: '0.0.0.0', port: GAME_RPC_PORT },
  });
  const port = parseInt(process.env.PORT ?? '3003');
  await app.startAllMicroservices();
  await app.listen(port);
  console.log(`Game Service running on port ${port} (RPC ${GAME_RPC_PORT})`);
```

`game.module.ts`：把 `GameRpcController` 加进 `controllers`。

- [ ] **Step 4: 跑测试确认通过 + lint**

Run: `pnpm --filter @fight-the-landlord/game-service test -- game.rpc && pnpm --filter @fight-the-landlord/game-service lint`
Expected: PASS（5 条）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(game): §4.2 TCP RPC 监听 + game.* 四个 MessagePattern（N20/P4 Task 1）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1b: `robot-service` 起 TCP 监听 + 三个 `@MessagePattern` handler

**Files:** Create `packages/robot-service/src/rpc/rpc.options.ts`、`packages/robot-service/src/rpc/robot.rpc.controller.ts`、`packages/robot-service/test/robot.rpc.test.ts`；Modify `src/main.ts`、`src/robot/robot.module.ts`

**Interfaces:**
- Consumes: `RPC_PATTERNS` / `RpcResult` / `RobotAcquireRequest` / `RobotReleaseRequest` / `RobotDecideRequest`（Task 0）；`RobotService.acquire/release/decide`（既有）
- Produces: `RobotRpcController` 的三个 handler（`acquire` / `release` / `decide`），**全部返回 `RpcResult<T>`**；`ROBOT_RPC_PORT`（默认 3105）

- [ ] **Step 1: 写失败测试** `packages/robot-service/test/robot.rpc.test.ts`（与 Task 1 Step 1 同形：pattern 元数据逐字 = `RPC_PATTERNS`；`acquire` 成功 ⇒ `{ok:true,data:{bots}}`；`decide` 的 `RobotService.decide` 抛错 ⇒ `{ok:false,code}`；`release` ⇒ `{ok:true,data:{released}}`）
- [ ] **Step 2: 跑测试确认失败**（`Cannot find module '../src/rpc/robot.rpc.controller'`）
- [ ] **Step 3: 实现** —— `rpc.options.ts` 的 `ROBOT_RPC_PORT = Number(process.env.RPC_PORT ?? 3105)`；`RobotRpcController` 复用 Task 1 的 `toResult()` 手法（把它提到 `packages/robot-service/src/rpc/to-result.ts`，与 game-service 各自一份 —— **不进 `shared`**，它是 Nest/Nest 微服务层的细节）；`main.ts` 加 `connectMicroservice` + `startAllMicroservices()`
- [ ] **Step 4: 跑绿 + lint**
- [ ] **Step 5: 提交**（`feat(robot): §4.2 TCP RPC 监听 + robot.* 三个 MessagePattern（N20/P4 Task 1b）`）

> ⚠️ **`robot-service` 是 bind-mount**（`docker-compose.yml:176` 把宿主 `dist/` 挂进容器）：跑 conformance 前**必须**先 `pnpm exec turbo run build --force`，否则容器里跑的是**没有 RPC 监听**的旧代码，症状是 `robot.*` 全部 `ECONNREFUSED` —— 那**不是**本片实现错。

---

## Task 2: 删掉 `game-service` 的内部 HTTP 路由（`POST /api/games`、`:roomCode/snapshot`），HTTP `view` 改走 `getViewForUser`

**Files:** Modify `packages/game-service/src/game/game.controller.ts`、`packages/game-service/test/game.controller.test.ts`

**Interfaces:**
- Consumes: `GameService.getViewForUser`（Task 1）
- Produces: `GameController` 只剩对外面 —— `GET :roomCode`、`GET :roomCode/state`、`POST :roomCode/{bid,play,pass}`

- [ ] **Step 1: 写失败测试**（在 `game.controller.test.ts` 里加/改）

```ts
it('R218：内部专用的两条路由**不存在**了（被 TCP RPC 取代，不留第二路径）', async () => {
  const res = await request(app.getHttpServer()).post('/api/games').send({ roomCode: 'R1', players: [] });
  expect(res.status).toBe(404);
  const snap = await request(app.getHttpServer()).get('/api/games/R1/snapshot').set('X-Internal-Token', 'x');
  expect(snap.status).toBe(404);
});

it('R224：HTTP 的 GET /api/games/:roomCode 走 getViewForUser（座位只从 X-User-Id 解析）', async () => {
  const res = await request(app.getHttpServer()).get('/api/games/R1').set('X-User-Id', 'u1');
  expect(res.status).toBe(200);
  expect(gameService.getViewForUser).toHaveBeenCalledWith('R1', 'u1');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service test -- game.controller`
Expected: FAIL — `expected 201 to be 404`（两条路由仍在）

- [ ] **Step 3: 实现**：删 `@Post() create()` 与 `@Get(':roomCode/snapshot') snapshot()` 两个方法及其专用 import（`INTERNAL_TOKEN_HEADER`、`StartGameRequest`）；把 `private view()` 的座位解析换成 `this.gameService.getViewForUser(roomCode, userId)`（错误码与文案不变）。

- [ ] **Step 4: 跑测试确认通过 + 全量 game-service 单测**

Run: `pnpm --filter @fight-the-landlord/game-service test && pnpm --filter @fight-the-landlord/game-service lint`
Expected: PASS（原本 83 条 + 新增；`create`/`snapshot` 的旧用例已删）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "refactor(game): 删除被 TCP RPC 取代的内部 HTTP 路由，HTTP view 复用 getViewForUser（R218/R224）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `room-service` 的三个调用点全部改走 `ClientProxy`（`game.start` / `game.snapshot` / `game.view` / `game.action` / `robot.acquire` / `robot.release`）

**Files:** Create `packages/room-service/src/gateway/rpc.options.ts`、`packages/room-service/test/no-internal-http.gate.test.ts`；Modify `src/gateway/game.client.ts`、`src/gateway/robot.client.ts`、`src/gateway/ws.module.ts`、`src/match/match.service.ts`、`src/gateway/ws.gateway.ts`、`test/game.client.test.ts`、`test/match.service.test.ts`

**Interfaces:**
- Consumes: `RPC_PATTERNS` / `RpcResult` / `StartGameRequest` / `GameActionRequest`（Task 0）；Task 1 的监听方
- Produces: `GAME_CLIENT` / `ROBOT_CLIENT` 两个 Nest token（形状不变，仍是 `GameClient` / `RobotClient` 类实例）；`GameClient` 的公开方法 `start(dto)` / `snapshot(roomCode)` / `view(roomCode,userId)` / `action(roomCode,action,userId,payload)` **签名逐字不变**；`RobotClient.release(botIds)` 签名不变；`match.service.acquireBot()` 不变

- [ ] **Step 1: 写失败测试** —— 假 `ClientProxy`（R221：判据必须走真实 pipeline）

```ts
// packages/room-service/test/game.client.test.ts（重写后的骨架）
import { of, throwError, NEVER } from 'rxjs';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { GameClient, RPC_MAX_ATTEMPTS, GameServiceError } from '../src/gateway/game.client';

/** 可控的假 ClientProxy：按 pattern 返回预置 Observable，并记录调用。 */
function fakeProxy(handlers: Record<string, () => unknown>) {
  const calls: Array<{ pattern: string; data: unknown }> = [];
  return {
    calls,
    send: (pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      return (handlers[pattern] ?? (() => of({ ok: true, data: null })))();
    },
  };
}

it('start：打 RPC_PATTERNS.gameStart，载荷逐字，信封解包后返回 data', async () => {
  const proxy = fakeProxy({ [RPC_PATTERNS.gameStart]: () => of({ ok: true, data: { roomCode: 'R1', state: 'bidding', version: 1 } }) });
  const client = new GameClient(proxy as never);
  await expect(client.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toEqual({
    data: { roomCode: 'R1', state: 'bidding', version: 1 },
  });
  expect(proxy.calls).toEqual([{ pattern: 'game.start', data: { roomCode: 'R1', baseScore: 100, players: [] } }]);
});

it('snapshot：信封 ok:false 的 5 位码必须**原样**变成 GameServiceError.code（R220）', async () => {
  const proxy = fakeProxy({ [RPC_PATTERNS.gameSnapshot]: () => of({ ok: false, code: ErrCode.ROOM_NOT_FOUND, message: 'nope' }) });
  const client = new GameClient(proxy as never);
  await expect(client.snapshot('R1')).rejects.toMatchObject({ code: ErrCode.ROOM_NOT_FOUND });
});

it('幂等的 start/snapshot：第一次失败 ⇒ **同参数再发一次**（恰好 1 次重试，R221）', async () => {
  let n = 0;
  const proxy = fakeProxy({ [RPC_PATTERNS.gameStart]: () => (++n === 1 ? throwError(() => new Error('ECONNRESET')) : of({ ok: true, data: { roomCode: 'R1' } })) });
  const client = new GameClient(proxy as never);
  await expect(client.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toBeTruthy();
  expect(proxy.calls).toHaveLength(RPC_MAX_ATTEMPTS);   // 2
});

it('start：两次都失败 ⇒ GameServiceError(UPSTREAM_UNAVAILABLE)（§4.3 的降级前提）', async () => {
  const proxy = fakeProxy({ [RPC_PATTERNS.gameStart]: () => throwError(() => new Error('down')) });
  const client = new GameClient(proxy as never);
  await expect(client.start({ roomCode: 'R1', baseScore: 100, players: [] })).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
  expect(proxy.calls).toHaveLength(RPC_MAX_ATTEMPTS);
});

it('start：超时（3s）也算失败并重试（用假定时器压掉真实等待）', async () => {
  vi.useFakeTimers();
  const proxy = fakeProxy({ [RPC_PATTERNS.gameStart]: () => NEVER });
  const client = new GameClient(proxy as never);
  const p = client.start({ roomCode: 'R1', baseScore: 100, players: [] });
  const assertion = expect(p).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
  await vi.advanceTimersByTimeAsync(GAME_CLIENT_TIMEOUT_MS.start * RPC_MAX_ATTEMPTS + 50);
  await assertion;
  vi.useRealTimers();
});

it('view：12004（NOT_IN_ROOM）⇒ 返回 null（不是抛错）—— 与旧 HTTP 分支逐字同义', async () => {
  const proxy = fakeProxy({ [RPC_PATTERNS.gameView]: () => of({ ok: false, code: ErrCode.NOT_IN_ROOM, message: 'no' }) });
  const client = new GameClient(proxy as never);
  await expect(client.view('R1', 'u9')).resolves.toBeNull();
});

it('action：**不重试**（CAS 动作重试会重复出牌）', async () => {
  const proxy = fakeProxy({ [RPC_PATTERNS.gameAction]: () => throwError(() => new Error('down')) });
  const client = new GameClient(proxy as never);
  await expect(client.action('R1', 'play', 'u1', { cards: [3], baseVersion: 7 })).rejects.toBeInstanceOf(GameServiceError);
  expect(proxy.calls).toHaveLength(1);
  expect(proxy.calls[0].data).toEqual({ roomCode: 'R1', userId: 'u1', action: 'play', payload: { cards: [3], baseVersion: 7 } });
});
```

`match.service.test.ts` 的 RPC 化（**保留**切片 7/10/11 全部语义判据，只换断言载体）：

```ts
it('acquireBot 打的是 RPC_PATTERNS.robotAcquire（R219/R218：内部面已无 HTTP）', async () => {
  // …（前置照旧）
  expect(rpc.calls.map((c) => c.pattern)).toContain(RPC_PATTERNS.robotAcquire);
  expect(rpc.calls.find((c) => c.pattern === RPC_PATTERNS.robotAcquire)!.data).toEqual({ roomCode, seats: [seat] });
});

it('N19 回归：房间底分 200 ⇒ game.start 载荷 baseScore 必须是 200（换载体不换判据）', async () => {
  // …
  expect(rpc.calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data).toMatchObject({ baseScore: 200 });
});

it('E10 回归：生产代码不再有任何裸 fetch / HttpService 出站（由 no-internal-http.gate.test.ts 机械钉住）', () => {
  // 断言交给 Task 5 的源码闸；此处只留一条「RPC 客户端被真正调用」的正向判据
  expect(rpc.calls.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- game.client match.service`
Expected: FAIL — `GameClient` 仍走 `this.http`（`no HttpService` ⇒ `UPSTREAM_UNAVAILABLE`）/ 断言 `proxy.calls` 为空

- [ ] **Step 3: 实现**

`packages/room-service/src/gateway/rpc.options.ts`：

```ts
// packages/room-service/src/gateway/rpc.options.ts
import { Transport, type ClientOptions, type TcpClientOptions } from '@nestjs/microservices';

/** §2.3：`GAME_SERVICE_RPC_HOST` / `_PORT`（默认 `game-service` / `3103`）。 */
export const gameClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.GAME_SERVICE_RPC_HOST ?? 'game-service',
    port: Number(process.env.GAME_SERVICE_RPC_PORT ?? 3103),
  },
});

/** §2.3：`ROBOT_SERVICE_RPC_HOST` / `_PORT`（默认 `robot-service` / `3105`）。 */
export const robotClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.ROBOT_SERVICE_RPC_HOST ?? 'robot-service',
    port: Number(process.env.ROBOT_SERVICE_RPC_PORT ?? 3105),
  },
});

/** ⚠️ 本地开发（不在 compose 里跑）时的兜底：主机名解析不到 compose 服务名 ⇒ 退回 localhost。 */
export const LOCAL_FALLBACK_HOST = 'localhost';
```

`game.client.ts`（**超时/重试/错误码语义逐字保留**，只换传输）：

```ts
export class GameClient {
  constructor(private readonly proxy: ClientProxy) {}

  start(dto: StartGameRequest): Promise<GameHttpResponse> {
    return this.withRetry(() => this.call(RPC_PATTERNS.gameStart, dto, TIMEOUT_MS.start));
  }

  snapshot(roomCode: string): Promise<GameHttpResponse> {
    return this.withRetry(() => this.call(RPC_PATTERNS.gameSnapshot, { roomCode }, TIMEOUT_MS.snapshot));
  }

  /** R224：只传 userId（seat 由 game-service 解析）。12004 ⇒ null，其余照抛。 */
  async view(roomCode: string, userId: string): Promise<PlayerView | null> {
    try {
      const resp = await this.call(RPC_PATTERNS.gameView, { roomCode, userId }, TIMEOUT_MS.view);
      return (resp.data ?? null) as PlayerView | null;
    } catch (err) {
      if (err instanceof GameServiceError && err.code === ErrCode.NOT_IN_ROOM) return null;
      throw err;
    }
  }

  /** R219：单个 `game.action`；**不重试**。 */
  async action(roomCode, action, userId, payload): Promise<unknown> {
    const resp = await this.call(
      RPC_PATTERNS.gameAction,
      { roomCode, userId, action, payload },
      TIMEOUT_MS.view,
    );
    return resp.data;
  }

  /** R221：超时在 `retry()` 之内 ⇒ 每次重试重新计时。 */
  private async call<T>(pattern: string, payload: unknown, timeoutMs: number, attempt = 0): Promise<GameHttpResponse> {
    try {
      const res = await lastValueFrom(
        this.proxy.send<RpcResult<T>>(pattern, payload).pipe(timeout(timeoutMs)),
      );
      if (!res?.ok) {
        throw new GameServiceError((res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode, res?.message ?? pattern);
      }
      return { data: res.data };
    } catch (err) {
      if (err instanceof GameServiceError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, `game-service unavailable: ${reason}`);
    }
  }
}
```

⚠️ **`retry()` 必须在 `call()` 之外**（`call` 抛的是 `GameServiceError`，`withRetry` 均匀重试它 —— 与旧实现的「任何失败都重试一次」逐字同义）。**不要**把 UI 层 `mapHttpStatus` 一起删掉：它仍被 `message.router` 的注释与测试引用，**保留导出**（`mapHttpStatus` 现在是死代码，删它要同步删/改用例 —— 归类为**允许删除**，删则同步删它的用例）。

`ws.module.ts`：

```ts
import { ClientsModule } from '@nestjs/microservices';
import { gameClientOptions, robotClientOptions } from './rpc.options';

@Module({
  imports: [
    ClientsModule.register([
      { name: GAME_CLIENT, ...gameClientOptions() },
      { name: ROBOT_CLIENT, ...robotClientOptions() },
    ]),
  ],
  providers: [
    // R216 的手法不变：构造函数有可选参数时用 useFactory 显式构造
    { provide: GAME_CLIENT, useFactory: (c: ClientProxy) => new GameClient(c), inject: [GAME_CLIENT] },
    { provide: ROBOT_CLIENT, useFactory: (c: ClientProxy) => new RobotClient(c), inject: [ROBOT_CLIENT] },
  ],
})
```
⚠️ `ClientsModule.register` 已经用 `name` 提供 `ClientProxy`；**不要**再写一个同名 provider，否则覆盖掉的是「客户端实例」而不是「我们的封装」。**正确写法由执行期确定**（可选：`ClientsModule.register` 用 `name: GAME_RPC_PROXY`，再 `useFactory` 包一层成 `GAME_CLIENT`）—— 执行期裁决记进计划文件。

`match.service.ts`：`startGame()` 的 `firstValueFrom(this.http.post(...))` ⇒ `this.game.start(dto)`（`baseScore` 的 N19 透传与重试语义逐字不变）；`acquireBot()` ⇒ 注入 `RobotClient.acquire({roomCode, seats:[seat]})`。

- [ ] **Step 4: 跑测试确认通过 + lint**

Run: `pnpm --filter @fight-the-landlord/room-service test && pnpm --filter @fight-the-landlord/room-service lint`
Expected: PASS（原 173 条全部保留语义 + 新增 RPC 判据）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "refactor(room): game/robot 全部内部调用迁到 TCP RPC（N20/P4 Task 3）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `game-service` 的 `robot.decide` 迁到 RPC（5s / 不重试 / 失败 ⇒ 规则引擎）

**Files:** Modify `packages/game-service/src/game/robot.client.ts`、`src/game/game.module.ts`、`test/game.robot.test.ts`；Create `packages/game-service/test/robot.client.test.ts`

**Interfaces:**
- Consumes: `RPC_PATTERNS.robotDecide` / `RpcResult` / `RobotDecideRequest` / `RobotDecideResponse`（契约）
- Produces: `RobotClient.decide(req): Promise<RobotDecideResponse | null>` —— 签名不变；`ROBOT_DECIDE_TIMEOUT_MS = 5000` 不变；**任何失败都返回 `null`**（不抛）

- [ ] **Step 1: 写失败测试** `packages/game-service/test/robot.client.test.ts`

```ts
import { of, throwError, NEVER } from 'rxjs';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RobotClient, ROBOT_DECIDE_TIMEOUT_MS } from '../src/game/robot.client';

it('decide：打 RPC_PATTERNS.robotDecide，载荷逐字', async () => {
  const calls: Array<[string, unknown]> = [];
  const proxy = { send: (p: string, d: unknown) => { calls.push([p, d]); return of({ ok: true, data: { kind: 'play', cards: [3], source: 'rule' } }); } };
  const c = new RobotClient(proxy as never);
  await expect(c.decide(req)).resolves.toEqual({ kind: 'play', cards: [3], source: 'rule' });
  expect(calls).toEqual([['robot.decide', req]]);
});

it('decide：传输抛错 ⇒ **null**（由调用方回退规则引擎，C9）', async () => {
  const proxy = { send: () => throwError(() => new Error('down')) };
  await expect(new RobotClient(proxy as never).decide(req)).resolves.toBeNull();
});

it('decide：超时 5s ⇒ null，且**不重试**（§4.3 逐字：不重试）', async () => {
  vi.useFakeTimers();
  let n = 0;
  const proxy = { send: () => { n += 1; return NEVER; } };
  const p = new RobotClient(proxy as never).decide(req);
  await vi.advanceTimersByTimeAsync(ROBOT_DECIDE_TIMEOUT_MS + 50);
  await expect(p).resolves.toBeNull();
  expect(n).toBe(1);
  vi.useRealTimers();
});

it('decide：形状非法的应答（kind 不是 play/pass）⇒ null（与旧实现逐字同义）', async () => {
  const proxy = { send: () => of({ ok: true, data: { kind: 'zzz' } }) };
  await expect(new RobotClient(proxy as never).decide(req)).resolves.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service test -- robot.client`
Expected: FAIL — `Cannot find module ...` / `RobotClient` 仍要求 `fetchImpl`

- [ ] **Step 3: 实现**：`RobotClient` 的构造函数改成 `(private readonly proxy: ClientProxy)`；`decide()` 用 `lastValueFrom(this.proxy.send(RPC_PATTERNS.robotDecide, req).pipe(timeout(ROBOT_DECIDE_TIMEOUT_MS)))`，`try/catch ⇒ null`，**不套 `retry()`**；删 `fetchImpl` / `baseUrl` / `internalToken` 与 `ROBOT_SERVICE_URL`。`game.module.ts` 注册 `ClientsModule`。

- [ ] **Step 4: 跑测试确认通过 + `game.robot.test.ts` 的替身改成注入 `ClientProxy`**，再跑全量

Run: `pnpm --filter @fight-the-landlord/game-service test && pnpm --filter @fight-the-landlord/game-service lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "refactor(game): robot.decide 迁到 TCP RPC（5s 不重试，失败回退规则引擎）（N20/P4 Task 4）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 源码级机械闸 `no-internal-http.gate.test.ts`（R225）+ compose 端口

**Files:** Create `packages/room-service/test/no-internal-http.gate.test.ts`；Modify `docker-compose.yml`、`docker-compose.override.yml`、`packages/api-gateway/test/outbound-timeout.gate.test.ts`

- [ ] **Step 1: 写失败测试**（探针自带正/负对照 —— 切片 11 教训第 7 条）

```ts
// packages/room-service/test/no-internal-http.gate.test.ts
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

/** 内部面的 HTTP 路径（删掉的那几条）—— 出现在 room-service 源码里就是**复活**了第二条路径。 */
const INTERNAL_HTTP = /\/api\/(games|robots)\//;
/** 内部面的 RPC pattern 用法（正向判据 —— 判别力必须来自正向断言）。 */
const RPC_USAGE = /RPC_PATTERNS\.(gameStart|gameSnapshot|gameView|gameAction|robotAcquire|robotRelease)/;

const SRC = [
  'packages/room-service/src/gateway/game.client.ts',
  'packages/room-service/src/gateway/robot.client.ts',
  'packages/room-service/src/match/match.service.ts',
];

describe('N20/P4：内部面不得残留 HTTP（R218/R225）', () => {
  it('正向：三个调用点都真的在用 RPC pattern（否则下面的反向判据可能是空测）', () => {
    for (const rel of SRC) expect(RPC_USAGE.test(read(rel)), `${rel} 没有 RPC pattern 用法`).toBe(true);
  });

  it('反向：三个调用点都不得再出现内部 HTTP 路径', () => {
    for (const rel of SRC) {
      const hit = read(rel).match(INTERNAL_HTTP);
      expect(hit?.[0], `${rel} 仍残留内部 HTTP 路径 ${hit?.[0]}`).toBeUndefined();
    }
  });

  it('game-service 的内部 HTTP 路由不得复活（只有 @MessagePattern 侧提供）', () => {
    const ctrl = read('packages/game-service/src/game/game.controller.ts');
    expect(/@Post\(\)/.test(ctrl), 'POST /api/games（game.start）不得复活').toBe(false);
    expect(ctrl.includes(':roomCode/snapshot'), 'game.snapshot 的 HTTP 路由不得复活').toBe(false);
  });

  it('探针判别力（正/负对照）', () => {
    expect(INTERNAL_HTTP.test("await this.http.post(`${base}/api/games`, dto)")).toBe(true);
    expect(INTERNAL_HTTP.test("this.proxy.send(RPC_PATTERNS.gameStart, dto)")).toBe(false);
    expect(RPC_USAGE.test('RPC_PATTERNS.robotAcquire')).toBe(true);
    expect(RPC_USAGE.test('robot.acquire')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- no-internal-http`
Expected: 在**未改**的源上应**红**（`game.client.ts` 仍含 `/api/games`）—— 这也顺手证明闸有判别力

- [ ] **Step 3: 实现**

`docker-compose.yml`（**生产形态：只 `expose`，绝不 `ports`**）：

```yaml
  game-service:
    expose:
      - "3103"     # §2.1：RPC 端口「仅供服务间 Transport.TCP 使用，不对外暴露"（N20/P4）
    environment:
      - RPC_PORT=3103
      # GAME_SERVICE_URL 保留：网关 → game-service 的对外 HTTP 边（§4.1）仍需要它
  robot-service:
    expose:
      - "3105"
    environment:
      - RPC_PORT=3105
      # ⚠️ ROBOT_SERVICE_URL 不再需要（room/game 都改走 RPC）—— 删
  room-service:
    environment:
      - GAME_SERVICE_RPC_HOST=game-service
      - GAME_SERVICE_RPC_PORT=3103
      - ROBOT_SERVICE_RPC_HOST=robot-service
      - ROBOT_SERVICE_RPC_PORT=3105
      # ⚠️ GAME_SERVICE_URL / ROBOT_SERVICE_URL 从 room-service 的 environment 里删掉
  api-gateway:
    environment:
      - GAME_SERVICE_URL=http://game-service:3003   # 保留
```

`docker-compose.override.yml`（**开发形态才发布宿主端口**，R226）：

```yaml
  game-service:
    ports:
      - "3103:3103"
  robot-service:
    ports:
      - "3105:3105"
```

`outbound-timeout.gate.test.ts`（R225 同族：判据钉性质不钉形态）：`INJECTED_OUTBOUND` 里**删掉** `packages/room-service/src/gateway/game.client.ts`（它已不再出站 HTTP），把判据 A′ 的说明改成「改用 **ClientProxy** 的出站文件不在本闸范围内（它由 `no-internal-http.gate.test.ts` 的正向判据覆盖）」。

- [ ] **Step 4: 跑测试确认通过（两个包）+ compose 渲染自检**

```bash
pnpm --filter @fight-the-landlord/room-service test -- no-internal-http
pnpm --filter @fight-the-landlord/api-gateway test -- outbound-timeout
DOCKER_BUILDKIT=0 docker compose config | grep -A2 'expose'          # 生产形态：3103/3105 只 expose
docker compose config | grep -E '"?(3103|3105)'                      # 开发形态：合并后宿主映射出现
```
Expected: 全绿；两条 `config` 输出分别符合「只 expose」与「有 ports」

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "test(room,gateway): 内部面无 HTTP 的结构性闸 + compose RPC 端口（生产 expose / 开发 ports）（R225/R226）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**后端 DoD**：`cd .worktrees/backend && pnpm exec turbo run test lint --force` 全绿（0 cached）+ `pnpm exec turbo run build --force` 10/10；汇报必须附**每条判据的修前 RED 原文**（尤其：`start` 的重试次数、`robot.decide` 的「超时且只发 1 次」、闸在未资源码上的红）。

---

## Task 6（conformance agent）: 零依赖 TCP RPC 探针 + `slice-07.2-rpc` 新切片 + 既有切片口径改造

**Files:** Create `tools/conformance/src/lib/rpc.ts`、`tools/conformance/src/slices/slice-07.2-rpc.ts`；Modify `run.ts`、`package.json`、`slices/slice-07.2-boundary.ts`、`slices/slice-07.2-hardening.ts`、`slices/slice-07.2-deploy.ts`、`slices/slice-11-robot-system.ts`

**Interfaces:**
- Consumes: `RPC_PATTERNS` / `RpcResult` / `ErrCode`（`@fight-the-landlord/protocol`，**不写字面量**）；`lib/http.ts` 的 `INTERNAL_TOKEN` / `GATEWAY_URL` / `registerUser` / `getJson`；`lib/client.ts` 的 WS 客户端
- Produces: `rpcCall<T>(host: string, port: number, pattern: string, data: unknown, timeoutMs?: number): Promise<RpcResult<T>>`（宿主直连 TCP，`node:net`，`{pattern,data,id}` JSON + `\n` 分帧）；`GAME_RPC` / `ROBOT_RPC` 两个 `{host, port}` 常量（读 `GAME_SERVICE_RPC_PORT` / `ROBOT_SERVICE_RPC_PORT` env，默认 3103 / 3105，host 默认 `localhost`）

- [ ] **Step 1: 写探针 `lib/rpc.ts`**（含**判别力自证**：对不存在的端口必须在 1s 内 `ECONNREFUSED` 而不是挂住）

```ts
/**
 * §4.2 的 TCP RPC 探针（N20/P4）。**零新依赖**：Nest 的 TCP 传输 = `{pattern,data,id}` JSON + `\n`。
 * ⚠️ 线格式若与实测不符，改**探针**，不得改产品代码（R226）。
 */
export async function rpcCall<T>(host: string, port: number, pattern: string, data: unknown, timeoutMs = 3000): Promise<RpcResult<T>>;
```

- [ ] **Step 2: 写切片 `slice-07.2-rpc.ts`**（六组判据，全部**正向**为主）

1. **监听方存在**：`rpcCall(game 3103, RPC_PATTERNS.gameSnapshot, {roomCode:'NOPE'})` ⇒ 返回 `{ok:false,code:12003}`（**不是** ECONNREFUSED / 超时）。旧栈 RED 原文：`connect ECONNREFUSED 127.0.0.1:3103`。
2. **`game.start` 走 RPC 真的能开一局、且走 `game.view` 能拿回自己的手牌**：先经网关匹配/进房（走既有 `lib/client.ts` 的 WS 客户端），再 `rpcCall(game, gameView, {roomCode, userId})` ⇒ `ok:true`，`data.hand` 与经网关 `GET /api/games/<code>` 拿到的**逐张相等**（判据：两个通道同一真源）。
3. **内部 HTTP 路由确实没了**（R218 的**结构性**判据）：经网关与直连 3003/3005 打 `POST /api/games`、`GET /api/games/<code>/snapshot`、`POST /api/robots/{acquire,release,decide}` ⇒ **404**（旧栈是 201/200）。
4. **`robot.acquire` 走 RPC 幂等**（把 `slice-11` 第 6 组的判据换载体）：同一 `{roomCode:'S72RPC', seats:[1]}` 调两次 ⇒ 同一 `botId`/`displayId`；`docker compose exec -T redis redis-cli ZCARD bot:pool:ddz` 不净增。
5. **§4.3 超时的可观测形态**：`rpcCall` 对**不存在的 pattern**（`:memory:` 之类的合法 JSON，例如 `'no.such.pattern'`）⇒ Nest 返回 `{err:...}` 且客户端侧在超时窗口内**失败而非挂住**；对**不存在的端口** ⇒ `ECONNREFUSED`（正向证明探针真的在等网络）。
6. **生产形态不发布 RPC 端口**：`docker compose --env-file /dev/null -f docker-compose.yml config --format json` ⇒ game/robot 的 `ports` 为空数组、`expose` 含 `3103`/`3105`（与 `slice-07.2-deploy` 的既有断言合并，见 Step 4）。

- [ ] **Step 3: 注册切片**：`run.ts` 的 `CASES` 加 `'slice-07.2-rpc'`（title：`§4.2 TCP RPC 迁移（N20/P4）`）、`package.json` 加 `conformance:slice-07.2-rpc`。

- [ ] **Step 4: 改造既有切片（逐条，**只换载体不弱化判据**）**

`slice-11-robot-system.ts` 第 6 组：`directJson(ROBOT_URL, '/api/robots/acquire', ...)` ⇒ `rpcCall(ROBOT_RPC, RPC_PATTERNS.robotAcquire, {roomCode:'S11IDEM', seats:[1]})`；断言从 `first.body` 改成 `first.data`，`HTTP 200` 改成 `ok:true`。
`slice-07.2-boundary.ts`：第 1/2 步的 `gameGetJson('/api/games/<code>/state')` 与 `directJson(ROBOT_URL,'/api/robots/list')` **保留**（这两条路由没被删，N4/N7 的边界仍在）；**新增**一句断言：被删的内部路由直连 ⇒ **404**（证明边界是「路由不存在」而不是「401 放行」）。
`slice-07.2-hardening.ts`：第 5 步的 `directJson(GAME_URL, '/api/games', ...)` 正对照 ⇒ 换成 `rpcCall(GAME_RPC, RPC_PATTERNS.gameStart, {...})`（`ok:true` 作正对照、经网关仍 404 作负对照）；第 2/3 步（`robots/move`、`robots/create` 404）保持不变（它们本来就该 404，现在更强）；第 9 步 A7 闸的**指名正对照**按 R225 更新（照抄 `outbound-timeout.gate.test.ts` 的改法）。
`slice-07.2-deploy.ts`：`DIRECT_PORT_SERVICES` 与「只有 api-gateway 发布宿主端口」的断言**必须继续成立**（RPC 端口**不得**出现在生产形态的 `ports` 里 —— 这正是第 6 组判据的结构性版本）。

- [ ] **Step 5: 跑（**独占**，且必须先在主检出 build）**

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force                 # ⚠️ robot-service 是 bind-mount
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 新增
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项（第 6 组换载体后仍绿）
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 54+ 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项
```

- [ ] **Step 6: 交接**：把这 5 条切片的**修前 RED 原文**（在改动前的 master 镜像上逐条取，用 `CONFORMANCE_STEPS` 逐步）写进汇报，并说明「哪几条在旧栈上也是绿的、为什么」（切片 11 教训第 7 条：机械扫描没扫到坏东西不等于有判别力）。

**conformance DoD**：上面 5 条切片全绿 + 每条新判据的**修前 RED 原文** + 「探针真的在等网络」的正向证据（`ECONNREFUSED` 原文）。

---

## 门禁（协调者，两个 agent 都 settle **之后**执行；conformance 独占）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit

pnpm exec turbo run test lint --force      # ✅ 期望 29/29、0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 前端无改动，回归

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 新增（N20 的核心判据）
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项（机器人局仍驱动到结束 ⇒ 三条 RPC 都活着）
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 54+ 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项（生产形态不发布 RPC 端口）
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 299 项
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0
# ⚠️ R229/R232①：本机 127.0.0.1 对未监听端口**丢 SYN**（表现为超时），`ECONNREFUSED` 不会出现
# ⇒ 这条只是**负向**判据（「没留下错」）；判别力由 slice-07.2-rpc 第 1/2/4 组的**正向**判据承担
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET|connect timeout'   # ✅ 0

# R231/R232②：池健康度（正向判据）—— 池里每个成员都必须有 bot:{id} 记录
# 修前实测：ZCARD=2 而两个成员 EXISTS 都是 0（悬挂）⇒ 该判据在修前必然红
for id in $(docker compose exec -T redis redis-cli ZRANGE bot:pool:ddz 0 -1 | tr -d '\r'); do
  printf '%s exists=%s\n' "$id" "$(docker compose exec -T redis redis-cli EXISTS "bot:$id" | tr -d '\r')"
done   # ✅ 每个成员 exists=1（无悬挂成员）

# 生产形态自检（R98 不回归 + RPC 端口不发布）
docker compose --env-file /dev/null -f docker-compose.yml config --format json \
  | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const s of ["game-service","robot-service"])console.log(s,"ports=",JSON.stringify(c.services[s].ports??[]),"expose=",JSON.stringify(c.services[s].expose??[]))'
# ✅ ports 为空、expose 含 3103/3105
```

**收口（协调者）**：
1. `docs/superpowers/plans/deviation-ledger.md` §1.5 **N20 ⇒ 已关闭**（写清关闭者 commit + 三条证据：单测/`slice-07.2-rpc`/生产形态 `config`）+ §0 统计重算（`node scripts/ledger-counts.mjs`）+ §2 的 P4 行改写；
2. `docs/design.md` §4.2 的 `[偏差]` 注记（「三个服务只有 `app.listen`、没有任何 `connectMicroservice`」）**删除**（它已落地），§2.3 的 `ROBOT_SERVICE_URL` 行按 §A.3 文档流程改写；
3. `agent-briefs.md` 追加 P4 的门禁实测块 + 本片新教训；
4. 本计划文件追加「门禁实测」块。

---

## Self-Review

**Spec coverage**

| 规格 | 落在哪个 Task |
|---|---|
| §2.1 RPC 端口 3103/3105 + 「不对外暴露」 | Task 5（compose `expose`）+ Task 6 第 6 组（生产形态 `config`） |
| §2.3 `RPC_PORT` / `*_RPC_HOST` / `*_RPC_PORT` | Task 1（`GAME_RPC_PORT`）+ Task 3（`gameClientOptions`/`robotClientOptions`）+ Task 5（compose 环境变量） |
| §4.1 通信总表（gateway→game **HTTP** 保留；room→game / room→robot / game→robot **TCP**） | R218（留/删的划分）+ Task 2（HTTP 只留对外）+ Task 3/4（三条边走 TCP） |
| §4.2 `game.start` / `game.snapshot` / `game.view` 三个 pattern | Task 0（常量）+ Task 1（监听方）+ Task 3（调用方） |
| §4.2 `StartGameRequest` / `GameStartedResponse` / `PlayerView` | Task 0（上移到 `protocol`）+ Task 1 |
| §4.2 「seat 由服务端从 userId 解析」 | R224 + Task 1（`getViewForUser`）+ Task 2（HTTP 复用同一方法）+ Task 3（`view` 只传 userId） |
| §4.2 `robot.acquire` / `robot.decide` | Task 3（acquire/release）+ Task 4（decide）+ Task 6 第 4 组 |
| §4.2 末段 `connectMicroservice` | Task 1（`game-service`）+ **Task 1b**（`robot-service`） |
| §4.3 超时 / 重试 / 降级（3s/2s/3s/5s、重试 1 次、decide 不重试） | R221 + Task 3（`withRetry` + `timeout`）+ Task 4（decide 不重试）+ Task 6 第 5 组 |
| §5.2 规则 3（内部身份边界） | R223 + Task 5（剩余 HTTP 面的中间件不动）+ Task 6 第 3 组（被删路由 ⇒ 404） |
| N20（对账表 §1.5 / §2-P4） | 全片；收口时关闭 |
| **R231 池幽灵成员**（conformance agent 撞出的既有缺陷，非 N20） | 产品侧（后端 agent 追加交付）+ 单测（合成悬挂成员）+ conformance 正向判据（R232②）；收口时**单独**登记进 §1.5 |

**⚠️ Self-Review 抓到的遗漏（已就地修补）**

1. **`robot-service` 也要写 `connectMicroservice`** —— 已补为 **Task 1b**（`RPC_PORT` 默认 **3105**、三个 handler、`robot.rpc.test.ts` 同形判据）。
2. **`game-service` 需要 `ROBOT_RPC` 客户端配置** —— Task 4 用到 `ClientsModule`，`packages/game-service/src/rpc/rpc.options.ts` 要同时导出 `robotClientOptions()`（与 room-service 同形，`RPC_PORT` 默认 3105）。
3. **`ROBOT_CLIENT` token**：`room-service` 今天只有 `GAME_CLIENT`；本片新增 `ROBOT_CLIENT`（`ws.module.ts` 里注册，`match.service` 与 `ws.gateway` 注入），`game-service` 新增 `ROBOT_RPC_CLIENT`。
4. **`RobotClient` 在容器里从来没有 provider**（**R227**，派工后自查发现）—— 并入 Task 3，判据必须真的 `Test.createTestingModule(...).compile()`。
5. **`robot.pool.takeIdle()` 的幽灵成员**（**R231**，conformance agent 取 RED 时撞出 + 协调者独立复核）—— 追加为产品侧交付 + 单测 + conformance 正向判据（**R232②**）；本片关闭，收口时单独登记。**它是既有缺陷，不是 N20 的一部分**（范围说明写在这里，避免下一个人误以为本片偷偷扩了范围）。

**Placeholder scan**：无 TBD / 「稍后补」。Task 3 Step 3 的 `ws.module.ts` 注册形态留了两种写法 —— 那是**已知的 DI 细节**（R216 同类坑：`useClass` 会去解析带默认值的构造参数），执行期必须择一并记「执行期裁决」，不是占位符。

**Type consistency**：`RPC_PATTERNS` 的七个键名在 Task 0 定义、Task 1/3/4/6 消费（不出现字面量 pattern）；`RpcResult<T>` 在 Task 0 定义、Task 1/3/4 消费；`GameHttpResponse` 的**名字保留**（`{data}` 形状不变，避免连锁改 `match.service` 的类型）；`GameService.getViewForUser` 在 Task 1 定义、Task 2/3 消费；`GAME_RPC_PORT` 在 Task 1 定义、Task 5 的 compose 环境变量对齐。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号 **R228+**，说明「计划怎么写 / 事实是什么 / 怎么改的」。）

### R228（conformance agent，Task 6）Nest 的 `Transport.TCP` 线格式**不是**「JSON + `\n`」——是「**长度前缀 + `#`**」

- **计划怎么写**（R226 / Task 6 Step 1 与第 1008 行）：Nest 的 TCP 传输线格式是 `{ pattern, data, id }` 的 JSON + `\n` 分帧。
- **事实是什么**（读 `@nestjs/microservices@10.4.22` 的**源码**，不是猜）：
  `server/server-tcp.js` 与 `client/client-tcp.js` 的默认 `socketClass` 都是 `helpers/json-socket.js` 的 `JsonSocket`，它的分帧**没有换行**：
  - 发送 `formatMessageData()`：`const messageData = JSON.stringify(message); return messageData.length + '#' + messageData;`
  - 接收 `handleData()`：先把 buffer 拼起来，找 **`#`** ⇒ 前缀 `parseInt(...,10)` = **内容长度** ⇒ 再凑够那么多**字符** ⇒ 一条完整报文。
  - ⚠️ 长度按 **`string.length`（字符）** 而非字节计；探针必须同样 `socket.setEncoding('utf8')` 后按 `string.length` 比，否则中文 `message` 会分帧错位。
- **响应包形状**（`server-tcp.js#handleMessage`）：有 handler ⇒ `{ id, response: <handler 返回值>, isDisposed: true }`（**Nest 不再包一层**，所以 R220 的 `RpcResult` 信封就在 `response` 上）；无 handler ⇒ `{ id, status:'error', err: 'There is no matching message handler defined in the remote service.' }`。
- **怎么改的**：探针按真实格式实现（`tools/conformance/src/lib/rpc.ts`），并且**把「没有 handler」单独归类成协议层故障**（`kind:'protocol'`，保留 `err` 原文），**不**翻译成 `{ok:false}` —— 否则「探针 pattern 打错」会被读成「服务端业务错误」。
  另：`rpcCall` 在**传输层失败时 reject**（`RpcTransportError`，带 `kind`/`code`/`elapsedMs`），**不**返回 `{ok:false,code:10007}`：把 `ECONNREFUSED` 与业务错误压成同一个返回值，会让「3103 没监听」与「服务返回了业务错误」在断言层不可区分 —— 而那正是本片要分开的两件事（R220 的「传输层故障由调用方映射」在 conformance 这一侧体现为「探针如实上报，不替调用方翻译」）。
- **影响**：**无产品代码改动**（线格式是 Nest 决定的，探针复刻它）；计划里那条「若不符则改探针」的要求已满足。

### R229（conformance agent，Task 6）「未监听端口 ⇒ `ECONNREFUSED`」**依赖地址**：`127.0.0.1` 在本机是**黑洞**（超时），`172.17.0.1` 才回 RST

- **计划怎么写**（Task 6 Step 1 / 第 5 组）：对不存在的端口必须在 **1s 内 `ECONNREFUSED`**，并把它当作「探针真的在等网络」的正向证据。
- **事实是什么**（本机主检出实测，2026-09-16）：
  - `127.0.0.1`（或 `localhost`）/ 任意空闲端口 ⇒ **`ETIMEDOUT`**（SYN 被丢弃、不回 RST）：`node net.connect` 无 `error` 事件；独立复核 `curl -m 5 http://127.0.0.1:3999` **退出码 28**、`nc -zv 127.0.0.1 3999` **退出码 124**。
  - `172.17.0.1`（docker0 网桥网关）/ 任意空闲端口（如 3999）⇒ **`ECONNREFUSED`，1–2ms**。
  ⇒ 「`ECONNREFUSED` 是未监听端口的必然结果」**不成立**，它是**地址属性**，不是缺陷。
- **怎么改的**（`slice-07.2-rpc` 第 5 组，两条**并列**的探针自证，不弱化任何一条）：
  - ① 打 `REFUSING_HOST = 172.17.0.1:3999` ⇒ 断言 **`kind === 'ECONNREFUSED'`** 且 `elapsedMs < 1000`。这是**唯一**能证明「探针看得见对端 RST」的地址。
  - ② 打默认 `127.0.0.1`（探针实际要用的 host 形态）⇒ 断言「**在超时窗口附近失败**（≤ timeout+200ms）」且 `kind ∈ {ECONNREFUSED, timeout}`。它证明探针**不会静默成功、也不会挂住**。
  - 第 1/2/4 组的失败原文因此是 `RPC 传输层故障（timeout）… localhost:3103`（**不是**计划预言的 `connect ECONNREFUSED 127.0.0.1:3103`）—— 归因不变（3103 无监听），**措辞按实测**。
- **给协调者的提醒**：门禁里 `docker compose logs game-service robot-service | grep -c 'ECONNREFUSED'` 那条判据在**本机**对 RPC 侧的失败**不会**出现 `ECONNREFUSED` 字样（会是 `ETIMEDOUT`/超时）。如果那条 grep 期望覆盖「RPC 通道全程可用」，请改成同时认 `ETIMEDOUT`/`timeout`，或只按「0 条」断言（它现在就是这么用的）。

### R230（conformance agent，Task 6）第 3 组的「经网关」那一半在**旧栈上也是绿的** —— 判据的判别力只在「直连」那一半

- **计划怎么写**（Task 6 Step 2 第 3 组 / Step 4 的 `slice-07.2-boundary`）：经网关与直连 3003/3005 打 `POST /api/games` 等被删路由 ⇒ **404**（旧栈是 201/200）。
- **事实是什么**（本机实测，旧栈 / master 镜像）：
  - **经网关**：`api-gateway` 从来没有这三条路由（那是历史偏差 S4/S5/N5 已经删掉的）⇒ 带**合法用户 token** 时恒为 Nest 的 `Cannot POST /api/games` **404**；**不带** token 时是网关自己的 **401**；带**内部 token** 时是边缘检查 **403**（`10003` 不属于下方列表）。
    ⇒ 这一半**在旧栈上就是绿的**，**零判别力**。
  - **直连**（带**正确**内部 token）：`POST /api/games`（**合法 body**）⇒ **201** + `{code:0,data:{roomCode,…}}`；`GET /api/games/<code>/snapshot` ⇒ **200** + 完整会话（含三家 `hand`）；`POST /api/robots/acquire` ⇒ **200** `{bots:[…]}`；`release` ⇒ **200** `{"released":0}`；`decide` ⇒ **500**。
    ⇒ **判别力全部在这里。**
- **另两个实测口径修正**（都影响判据能不能红）：
  1. **`POST /api/games` 必须用合法 body**：空 body（`{}`）在旧栈上只得 DTO 的 **400**（`roomCode and players are required`）—— 拿它当探针的话，断言「≠201」会**在旧栈也绿**，判据失效。
  2. **`game.snapshot` 对不存在房间的码是 `12001`（`ROOM_NOT_FOUND`），不是计划预言的 `12003`**：实测 `GET /api/games/NOPE/snapshot` 带内部 token ⇒ `404 {"code":12001,"message":"Game not found"}`（HTTP 状态映射表里 `ROOM_NOT_FOUND → 404`）。
- **怎么改的**：`slice-07.2-rpc` 第 3 组与 `slice-07.2-boundary` 第 6 步都**保留**两半，但在文件头/步骤说明里**写明「网关那一半在旧栈上也绿」**，并把判别力明确归到直连那一半 + 「404 的成因是**路由不存在**」的形状断言（`Cannot POST` vs game-service 自己的 `{code:12001}`）；`slice-07.2-rpc` 第 1 组的期望码钉 `ErrCode.ROOM_NOT_FOUND(12001)`（实测值），并保留一条「必须是 5 位数字业务码」的形态判据。
- **为什么这不是「弱化判据」**：两半都仍在断言（也没删任何一条），只是**如实标注判别力分布** —— 切片 11 教训第 7 条要求的正是这个（「机械扫描没扫到坏东西」在旧栈也可能成立）。

### R231（协调者，Task 6）`robot.pool.takeIdle()` 的**幽灵成员会静默吃掉机器人容量** —— conformance agent 取 RED 时撞出的既有缺陷，**本片一并修**

- **怎么发现的**：conformance agent 跑完 `slice-11` 后查池，发现 `ZCARD bot:pool:ddz = 2` 而两个成员的 `EXISTS bot:<id>` **都是 0**（索引有、记录无）。协调者**独立复核**了同一现场（原文见门禁实测块）。
- **根因**（`packages/robot-service/src/robot/robot.pool.ts:216-226`）：`takeIdle()` **先 `zrem` 再 `get`**，`get` 为 `null` 时**直接 `return null`** ⇒ 该名额**永久消失**，调用方以为「池空」去新建 ⇒ 容量净减。与 `reclaimIdle`（会 `zrem` 悬挂成员）**口径不一致**。第二成因是 **TTL 不对称**：`bot:{botId}` 有 TTL，`bot:pool:ddz` 的成员没有。
- **为什么既有判据抓不到**（R115 同族，第 N 次发作）：`slice-11` 第 5 组只断言「按机器人数**净增**」、第 6 组只断言「两次 acquire 之间 ZCARD **不变**」—— 两者都是**相对量**，对绝对容量退化为 0/1 完全免疫。
- **裁决**：**本片修**（不推到下一片）。定位照旧：这条**不是 N20 的一部分**，收口时单独登记进 `deviation-ledger.md` 的 §1.5，**归本片关闭**。
  - 产品侧：`takeIdle()` 循环到**取到记录存在**的成员为止（空记录 ⇒ `zrem` + `continue`，带上界保护）；TTL 口径对齐。
  - 判据（TDD）：`robot.pool.test.ts` 注入**合成悬挂成员** ⇒ ① 仍返回新建机器人；② 悬挂成员被清；③ **再 acquire 一次仍拿得到**（证明不是「拿到 null 就放弃」）。**修前 RED 必须是「ZCARD 净减 1」同类可观测差**，不是「返回了机器人」。
  - conformance 侧（**由 conformance agent 补**，见 R232）：一条**正向**判据「`bot:pool:ddz` 的每个成员都必须有 `bot:{id}` 记录」。

### R232（协调者，Task 6 补做）两处**门禁脚本**口径修正（由 R229/R231 逼出）

1. **`grep -c 'ECONNREFUSED'` 在本机是空判据（R229）**：本机 `127.0.0.1` 对未监听端口**丢弃 SYN**（表现为 `ETIMEDOUT`/超时），只有 `172.17.0.1` 回 RST。⇒ 门禁里 `docker compose logs game-service robot-service | grep -c 'ECONNREFUSED'` **不能**作为「RPC 通道全程可用」的判据。改成 `grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET|connect timeout'` = 0，并且**明确**：这是**负向**判据（只能说「没留下错」），判别力必须由 `slice-07.2-rpc` 的**正向**判据承担（第 1/2/4 组真的通过 TCP 拿到业务应答）。
2. **新增一条池健康度的**正向**判据**（R231 的验收，conformance 侧）：跑完一局后，`bot:pool:ddz` 的**每个**成员都 `EXISTS bot:<id>` = 1。用 `spawnSync` 调 `docker compose exec -T redis redis-cli`（手法照抄 `slice-07.2-deploy.ts`）。**这一条在修前必然红**（实测两个悬挂成员），是本片「池不再静默掉容量」的唯一判据。
   - **已交付**（`f7838a9`）：`slice-07.2-rpc` 第 2 组「前置」，纯 `redis-cli`、**不经 RPC** ⇒ 在**当前 master 上**就取到了确定性 RED（两次运行悬挂清单逐字相同）。判别力自证放在绝对断言**之前**：注入 `bot-PROBE-R232`（只 `ZADD`）⇒ 必须看见；补记录 ⇒ 必须消失；`finally` 清理并断言 `ZCARD` 回基线。GREEN 形态**已实测演示**（非推测）：健康成员 ⇒ `悬挂 0 个：[]` ⇒ 4 项断言通过；空池同样通过（故「release 后池非空」的正对照必要）。

### R233（conformance agent，Task 6）**fail-fast 运行器下，「前置自证」若排在会红的断言组之后，就永远不可见** —— 一个**顺序**变体

- **怎么发现的**：`slice-07.2-rpc` 的两条前置自证（「探针真的在等网络」×「池一致性」）原先排在会红的 `listen` 组**之后**。旧栈上 `run.js` 是 **fail-fast** ⇒ 输出在第 3 组就断了，**那几行 ✅ 永远看不到** —— 而「这两条不是空测」的唯一证据恰好就是它们。
- **裁决**：执行顺序改成 `pool（纯 Redis，标签「第 2 组」）· probe（自证，标签「第 1 组」）· listen · view · gone · idem · prod`；
  ⚠️ 两组前置的**标签编号与执行次序故意不同**（协调者复核时被绊过一次）：文件头写的顺序**就是**代码里 `runs(...)` 的排列，读顺序读那一行、不要读 `step()` 的编号。文件头 1–7 的**叙述**编号不变，另加一段「fail-fast 下的步骤顺序」说明两套编号的关系（同时修掉重排后暴露的标签错位：`game.view` 的失败信息曾写成「第 6 组」）。
  ⇒ **门禁即使在第 3 组红，原文里也能看到前置的 ✅**。已实测：门禁形态（不带 `CONFORMANCE_STEPS`）的输出以第 2 组的探针正/负对照 ✅ 开场。
- **为什么这是通用教训**（挂到 R115 / 切片 11 教训第 7 条下）：**判别力不仅要有，还必须排在失败之前才拿得到**。「有判别力的断言」与「判别力**可见**」是两件事，fail-fast 把后者变成了一个顺序问题。
- **登记一处同类、**本片不修**（留给下一片）**：`slice-11-robot-system.ts` 的 §9.8 探针自证也排在会红的分组之后，旧栈上同样看不到。它不在本片范围（本片没让 `slice-11` 变红），且它今天在新栈上是绿的 ⇒ **只登记**，不顺手改（避免把「本片范围」进一步撑大）。已经由 conformance agent 在代码注释里写明。

### R233-bis（协调者，合并期）编号冲突：后端 agent 的 R227–R231 **顺移为 R234–R238**

- **发生了什么**：两个 agent **各自**在「执行期裁决」区从 R227 起编号（后端 agent 收到的指示是「从 R227+」，那是在协调者自查占用 R227 **之前**发出去的），而协调者与 conformance agent 已经用掉了 **R227–R233**。合并后同一份文件里出现了**两组** `### R228`…`### R231`。
- **怎么处置的**：**内容一字不改**，把后端 agent 的五条**顺移**为 **R234–R238**；协调者/conformance 的 R227–R233 保持原号（它们已被 `agent-briefs`/对账表引用）。
- **教训（写给下一个派工的人）**：**裁决编号是全局资源**，派工时必须**指定起始号并预留区间**（例如「你用 R240–R259」），否则并行 agent 必然撞号。本次撞号没有造成内容损失，只多花了一次人工顺移 —— 但若两个 agent 的裁决**互相引用**，撞号就会变成真的错误。
- **给后来人的提示**：本文件的裁决里，**R234–R238 是后端 agent 的**，**R228–R233 是 conformance agent / 协调者的**；两者的编号**不表示时间顺序**。

### R234（后端 agent，Task 1/4）：`game-service` **缺 `rxjs` 直接依赖**，计划没写这一步 ⇒ 必须补

- **计划怎么写**：Task 0 Step 4 只给 **`robot-service`** 加了 `@nestjs/microservices` + `rxjs`
  （「它是**唯一**缺 `@nestjs/microservices` / `rxjs` 的服务」）；Task 1 / Task 4 的实现片段
  直接 `import { timeout, lastValueFrom } from 'rxjs'`（`game-service/src/game/robot.client.ts`）并
  `ClientsModule.register(...)`，但**没有任何一步**给 `game-service` 加 `rxjs`。
- **事实是什么**：`game-service` **本来就已有** `@nestjs/microservices`（lockfile
  `packages/game-service.dependencies` 里有），因此 Task 0 的「唯一缺」判断对
  `@nestjs/microservices` 成立、对 **`rxjs` 也成立**（`game-service/package.json` 的
  `dependencies` **没有** `rxjs`）。实测（pnpm 严格 node_modules）：

  ```bash
  node -e "console.log(require.resolve('rxjs/package.json',{paths:['packages/game-service']}))"
  # ⇒ Error: Cannot find module 'rxjs/package.json'   （UNRESOLVABLE）
  ```

  于是 `game-service` 侧 `import ... from 'rxjs'` 在 **vitest 与 tsc 下都解析失败**
  （实测 RED：`Failed to load url rxjs (resolved id: rxjs) in …/game.robot.test.ts`）。
  `room-service` 有自己的 `rxjs` ⇒ 它的片段不受影响；**本片只有 `game-service` 缺**。
- **怎么改的**：在 `packages/game-service/package.json` 的 `dependencies` 补
  `"rxjs": "^7.8.2"`（与 `room-service` / Task 0 给 `robot-service` 的 specifier **逐字同值**），
  并跑 `CI=true pnpm install --store-dir .pnpm-store` 让 `pnpm-lock.yaml` 与新 `package.json`
  一致（只新增 `game-service` importer 的一条 `rxjs`，**不改任何已有条目**）。
  ⚠️ 这动了「协调者独占」的 `pnpm-lock.yaml` —— 是本片**唯一**一次，且是**机械同步**
  （不改契约、不改版本、不动 `packages/protocol/**`）。协调者收口时请核对该 diff 只有这一条。

### R235（后端 agent，Task 3）：`MatchModule ⇄ WsModule` 会**循环依赖** ⇒ 客户端装配必须单独成模块

- **计划怎么写**：Task 3 Step 3 只写「`ws.module.ts`：删 `HttpModule`，改
  `ClientsModule.register([{name: GAME_CLIENT,…},{name: ROBOT_CLIENT,…}])` + 两个 `useFactory`」，
  并把 `GAME_CLIENT` / `ROBOT_CLIENT` 都放在 `ws.module.ts`；
  同一步又说 `match.service.ts` 要注入这两个客户端。
- **事实是什么**：`WsModule` 的 `imports` 里**本来就有 `MatchModule`**（`ws.module.ts:13`），
  而 `MatchService` 住在 `MatchModule` 里。把两个客户端 provider 放在 `WsModule` ⇒
  `MatchModule` 需要 `WsModule`、`WsModule` 又 import `MatchModule` ⇒ **循环依赖**
  （Nest 会要求 `forwardRef`，那是脆的补丁，且与 R216 的「装配层必须能被容器门禁验证」
  相性很差 —— 循环 `forwardRef` 下 `Test.createTestingModule` 的解析顺序更难断言）。
- **怎么改的**：新增 `packages/room-service/src/gateway/rpc-clients.module.ts`
  （`RpcClientsModule`）**独占**那两个客户端 provider + proxy 的 `ClientsModule.register`，
  并 `exports: [GameClient, RobotClient]`；`WsModule` 与 `MatchModule` **都** import 它。
  依赖因此变成单向：`WsModule → RpcClientsModule`、`MatchModule → RpcClientsModule`。
  同时 `ws.module.ts` 里的 `HttpModule` 与 `match.module.ts` 里的 `HttpModule` 都删掉。
  ⚠️ 这一条**不影响计划里任何判据**（`GAME_CLIENT` / `ROBOT_CLIENT` 两个 token 的对外形状
  一字未变），只是把 provider 挪到正确的模块里。

### R236（后端 agent，Task 3）：`RobotClient` 的 token 形态与 `game-service` **不同形**，且 `ws.gateway` 的 `@Optional()` 必须删

- **计划怎么写**：Task 3 的 `ws.module.ts` 片段同时写了「`ClientsModule.register` 已经用
  `name` 提供 `ClientProxy`；**不要**再写一个同名 provider」与
  「`{provide: ROBOT_CLIENT, useFactory: (c) => new RobotClient(c), inject: [ROBOT_CLIENT]}`」
  —— 这两句**互相矛盾**（后半句正是它警告的同名覆盖），计划把它标为「正确写法由执行期确定」。
- **事实是什么（执行期的抉择）**：**两个 token 必须不同**（协调者对 room-service 的提醒，
  本片采纳）：
  - `room-service`：`GAME_RPC_PROXY` / `ROBOT_RPC_PROXY`（内部 token，挂**裸 `ClientProxy`**）
    + `GAME_CLIENT`（字符串 token，挂**包装类 `GameClient`**）+ **`RobotClient`（类 token）**。
    ⚠️ `room-service` 的 `GAME_CLIENT` 是**字符串 token**（历史形态，`ws.gateway.ts` 导出），
    而 `RobotClient` 是**类 token** —— 两者**故意不同形**：GAME_CLIENT 那个 token 被
    `ws.gateway.test.ts` 等既有用例引用，改它会无谓地动一片用例；`RobotClient` 是类，
    类 token 更自然且与 `game-service` 同形。**不为对称而对称**。
  - `game-service`：`ROBOT_RPC_PROXY`（内部 token，裸 proxy）+ `RobotClient`（类 token）
    + `GameService.robotClient` 的**属性注入** `@Inject(forwardRef(() => RobotClient))`。
- **为什么 `GameService` 用属性注入而不是构造参数**：`GameService` 在**七个**单测文件里
  是 `new GameService()` 直接构造的；改构造函数签名会波及全部，而属性注入 + 无参构造
  正是它今天的形态（`robotDelay` 同款）。**代价**是默认值从 `new RobotClient()` 变成
  `null`，因此 `driveOneRobotTurn()` 里加了 **fail-loud** 分支（装配没接上时记 `error`，
  而不是静默把「装配缺失」伪装成「决策失败 ⇒ 规则引擎」—— R217 的同一课）。
- **`@Optional()` 必须删（协调者点名的 R217 同族缺陷）**：`ws.gateway.ts` 早就
  `@Optional() robot?: RobotClient`，而 `ws.module.ts` **从来没有 `ROBOT_CLIENT` provider**
  ⇒ 容器里 `this.robot === undefined` ⇒ `game.ended` 分支的 `robot.release()`（§9.6 归池）
  **在生产路径上一次都没跑过**，只有单测手工 `new WsGateway(..., fake)` 时才工作。
  本片：`GAME_CLIENT` / `ROBOT_CLIENT` 都改成**必需**注入（`@Inject(...)`，**无 `@Optional`**）
  —— 缺 provider 时 **Nest 启动即崩**（fail loud），而不是让整条归池路径静默消失。
  另加容器门禁 `test/ws.module.wiring.test.ts`（真 compile `RpcClientsModule` +
  断言 `WsGateway` 的构造元数据要求这两个 token 且**没有** `@Optional`）。
  该闸对修前源码**实测 RED**：
  `× 结构性：… → expected [ 'ROOM_SERVICE_GAME_CLIENT' ] to include 'ROOM_SERVICE_ROBOT_CLIENT'`。

### R237（后端 agent，Task 3）：`game.action` 的 `baseVersion` 必须从 `message.router` 的扁平载荷里**提升到顶层**

- **计划怎么写**：R219 定义 `GameActionRequest = { roomCode, userId, action, payload, baseVersion }`
  （`baseVersion` 与 `payload` **平级**）；Task 3 的判据片段又写
  `proxy.calls[0].data === {roomCode,userId,action,payload:{cards:[3],baseVersion:7}}`
  （即 `baseVersion` **在 `payload` 里**，且顶层也有一份）。
- **事实是什么**：`message.router.forwardAction()` 今天调
  `deps.game.action(roomCode, action, userId, { ...payload, baseVersion })` ——
  `baseVersion` 被**平铺进 `payload`**（旧 HTTP 形态如此：`dto.baseVersion` 从 body 读）。
  若原样转成 RPC，handler 拿到的 `dto.baseVersion` 会是 `undefined` ⇒ **CAS 静默失效**
  （动作不再做版本校验，`13004` 永不返回 —— 而**所有单测都可能绿**，因为 CAS 失效只表现为
  「陈旧动作被接受」，需要**并发/陈旧版本**的判据才看得见）。
- **怎么改的**：在 `GameClient.action()` 内部把 `baseVersion` 从 `payload` 里**摘出来**
  并提升到顶层（`const { baseVersion, ...params } = payload`），载荷因此是
  `{ roomCode, userId, action, payload: params, baseVersion }` ——
  与 R219 契约**逐字一致**，而 `message.router` **一行都不用改**
  （它的 4 条既有判据 `toHaveBeenCalledWith('ROOM1','bid','alice',{grab:true,baseVersion:0})`
  因此全部保持绿）。两种调用形态（扁平 / 分层）都能得到正确契约。
- 判据：`test/game.client.test.ts` 的
  「`action()` 把 payload 的业务字段与 `baseVersion` **分开**（R219 的顶层字段）」
  逐字断言五元组的形状。

### R238（后端 agent，Task 5 之后 / 协调者要求 A）：`robot.pool.ts` 的**幽灵成员**吃掉池容量 —— 属于本片，已修

- **协调者怎么写**：「不是 N20 的一部分，是 conformance agent 在取 RED 时顺带撞出来的
  既有缺陷……若你判断它会让本片范围失控，明确告诉我」。**后端 agent 的判断：不让范围失控，
  已在本片内修掉**（它落在本片可写区 `packages/robot-service/**`，改动 ~25 行 + 2 条判据，
  且本片正在动 `robot-service` 的启动方式 —— 合并窗口上它是有依赖的：RPC 通道通了之后
  `robot.acquire` 的**绝对容量**退化才可被观测）。
- **现场事实**（conformance agent 受控复现 + 协调者独立复核）：`ZCARD bot:pool:ddz` = **2**，
  而两个成员的 `EXISTS bot:<id>` **都是 0** —— 索引有、记录无。
- **根因**：`takeIdle()` **先 `zrem` 再 `get`**，`get` 为 `null` 直接 `return null`
  ⇒ ① 那个成员**已经**被 `zrem` 掉、函数却报「池空」⇒ 调用方 `createBot()` 新建
  ⇒ **容量净减**；② 与 `reclaimIdle()`（会清悬挂）**口径不一致**。
  另有口径问题：`poolSize()` 直接用 `ZCARD`，把幽灵算进「空闲数」，与 `listIdle()`
  （按记录过滤）**分叉** ⇒ conformance 的池检查判据对幽灵**免疫**（R115 同族：
  `slice-11` 第 5/6 组只断言 ZCARD 的**相对**变化）。
- **怎么改的（最小改动，键表不动 —— 仍是 §10.1 的 ZSET）**：
  1. `takeIdle()`：改成「取到记录**真实存在**的成员为止」——空记录 ⇒ `zrem` 清掉 ⇒ `continue`；
     加**防御性上界** `MAX_TAKE_IDLE_SCAN = 64`（病态数据下不空转，取不到即当池空）；
  2. `poolSize()`：不再直接用 `ZCARD`，改为**只读**地按记录过滤（清理职责仍归
     `takeIdle()` / `reclaimIdle()`，观测接口不写）。
- **判据（修前 RED 原文，在原 `takeIdle`/`poolSize` 上实测）**：

  ```
  × ⑤″ 幽灵成员不得吃掉容量 → expected 1 to be +0     （poolSize 把幽灵算成 1）
  × ⑤‴ 正对照：幽灵与真实空闲并存 → expected 'bot-6bdda61d' to be 'bot-58777366'
    （旧实现先**跳过**了真实空闲机器人，并把幽灵留在池里）
  ```

  判据是三重正向（照 TDD 要求，**不是**只断言「返回了机器人」——旧实现也会新建一个）：
  ① 悬挂成员被 `zrem`（`ZSCORE` 为 null）；② 两次 `acquire` **都**拿到机器人；
  ③ `poolSize()` 与 `listIdle()` 口径一致。外加一条**正对照**（真实空闲照样被复用，
  防止把 `takeIdle` 写成「一律返回 null」也能过）。修后 `robot-service` 44/44 绿。

---

---

## 门禁期裁决（协调者，合并后；**这四条都是「单测全绿、容器/门禁红」**）

> 本片的门禁不是「跑绿已有测试」，而是抓到了 **4 个真缺陷 + 2 个判据自身缺陷**。
> 下面按发现顺序编号（接 R238）。

### R239 `connectMicroservice({transport, options})` 的 `options` **被多嵌了一层** —— RPC 端口从头到尾没被绑上

- **症状（修前）**：容器日志照打 `[NestMicroservice] Nest microservice successfully started`，
  但 3103/3105 上**没有任何监听**：容器内 `127.0.0.1:3103` ⇒ **`ECONNREFUSED`**，
  `/proc/net/tcp` 里只有 3003。
- **一个必须记下的观测陷阱**：**宿主侧** `nc -z 127.0.0.1 3103` 反而报 **OPEN**
  （Docker 用户态代理先把连接收下、后端没人再关掉）⇒ 宿主探针读到「端口开着、但读连接就 reset」。
  **只有进容器内连**才看得到 `ECONNREFUSED`。这是本片最耗时的一段误诊。
- **根因**：`rpc.options.ts` 的 `gameRpcServerOptions()` 返回的是**整个**
  `{transport, options:{host, port}}`，而调用方 `main.ts` 又把它放进
  `connectMicroservice({transport: Transport.TCP, options: <它>})` ⇒ port 落在
  `options.options.port`；而 `ServerTCP` 读的是 `this.getOptionsProp(options, 'port')`
  ⇒ 取到 `undefined` ⇒ **静默回落到 `TCP_DEFAULT_PORT`(3000)** ⇒ `EADDRINUSE`
  走进 `server-tcp.js` 里那个「**只对 `EADDRINUSE`/`ECONNREFUSED` 调 callback**」的分支
  ⇒ 回调照样被调用 ⇒ 照样打 success 日志。
- **掩盖它的东西**：`main.ts` 的注释写着「`connectMicroservice()` **不加类型参数**……
  显式写它会让 tsc 报 TS2345」—— 那正是把**形状错误**藏起来的原因。
  正确写法是 `connectMicroservice<MicroserviceOptions>({transport, options: {host, port}})`
  （`TcpOptions.options` 是 `TcpServerOptions`，嵌错会被 tsc 当场拒）。
- **修法**：两个 `rpc.options.ts` 的 `*RpcServerOptions()` **只返回那一层 `{host, port}`**；
  `main.ts` 显式写类型参数。
- **为什么所有单测都绿**：`game.rpc.test.ts` / `robot.rpc.test.ts` 直接 `new` 控制器（不经端口）；
  `*.wiring.test.ts` compile 的是 DI 图（不绑端口）。**「DI 通了」不蕴含「端口真的在听」**。
- **新判据** `packages/game-service/test/rpc-listen-bind.test.ts`（**单测层第一次真的绑端口**）：
  ① 正向 —— 绑一个随机空闲端口 + 手写 `JsonSocket` 线格式请求 ⇒ 真的拿到
  `{response:{ok:true,data:'pong'}}`；
  ② 反向（判别力自证）—— 把 port 嵌进内层 ⇒ 断言它**没有被采纳**（落到别处或 `EADDRINUSE`），
  并断言目标端口上无应答；**刻意与环境无关**（3000 在本机被 gateway 占着，所以不能断言
  「一定落到 3000」—— 那会让判据随环境假红/假绿）。

### R240 三条内部 HTTP 路由**漏删**（`robot-service`）—— conformance 抓住的第一个产品缺陷

- **原文**：`❌ slice-07.2-rpc 失败：direct3005 POST /api/robots/acquire 的 HTTP 状态
  （R218：这条路由整条删除）：期望 404，实际 200`。
- **事实**：`robot.controller.ts` 的 `@Post('acquire'|'release'|'decide')` 三条还在
  （后端 agent 只删了 `game-service` 的两条）。⇒ 「同一语义两条通道」，正是 R218 禁止的第二真源。
- **修法**：删三条路由；`RobotService.acquire/release/decide` **保留**（那是唯一实现，RPC 侧要调）。
- **为什么没有单测看得见**（值得记的教训）：`robot.rpc.test.ts` 只测 RPC 控制器；
  而 `robot.decide.test.ts` 的第 ⑤ 组用的是 `helpers/internal-token-harness` **自己挂的假路由**
  （返回 `{route: PATH}`）⇒ 与真实 `RobotController` 无关，真实路由删掉后它**照样全绿**
  —— 「测的是自己的脚手架」（切片 7.2 教训第 5 条）。该组已作废并删除。
- **新判据**（锚在**真实控制器 + 真 HTTP**）：带**正确**内部 token + **合法** body 打三条被删路由
  ⇒ 必须 **404**（401/400 都说明路由还在）；正对照 `list`/`create` 仍在；
  三条语义仍由 `@MessagePattern` 承载。
  ⚠️ 初稿用 `Reflect.getMetadata('path', …)` 读 `@Post` 路由串，**实测本仓编译链下读不到**
  （`getOwnMetadataKeys` 为空）⇒ 改真 HTTP 请求（否则判据恒真/恒假）。

### R241 `slice-07.2-hardening` 的一条**假红**：不带 token 的请求**永远是 401**，不可能是 404

- **原文**：`❌ 直连 game:3003 POST /api/games 的 HTTP 状态：期望 404，实际 401`（body `{"code":10002,…}`）。
- **根因（判据自身，不是产品）**：`createInternalTokenMiddleware()` 是 `app.use` 的**全局中间件**，
  跑在 Nest **路由之前** ⇒ 不带 token 时**任何**路径都先得 401（含根本不存在的路径）。
  ⇒ 「不带 token ⇒ 404」在**正确实现上不可能成立**；且它在旧栈上也不具判别力（401 修前修后都有）。
- **修法**：带**正确** token ⇒ 越过中间件 ⇒ 路由不存在 ⇒ **404**；修前带 token 是 **201**
  （路由还在、真的开了一局）⇒ 判别力反而更强。

### R242 `slice-07.2-hardening` 自查不变式**写反**（恒绿）+ `NOT_YET_MIGRATED` 清空

- **根因**：`allFilesStillHttp` 在「**任一**文件已无 HTTP 路径字面量」时就被置 `false`
  —— 与它的名字和下游判据的意图（「**所有**文件都还留着 HTTP」）**相反**
  ⇒ 迁移一旦**部分**完成就误报；而它本该守住的「忘了清空 xfail 清单」**永远不触发**（恒绿）。
- **修法**：`hits.length > 0` 才置 `false`；随之把 `NOT_YET_MIGRATED` 清空为 `[]`
  （四个调用点已全部改用 `RPC_PATTERNS.*`、内部 HTTP 路径字面量 0 命中；它是 **xfail 而非状态**）。
- **效果**：`slice-07.2-hardening` 由 54 → **60 项断言**，全绿。

---

## 门禁实测（master `b5d02ce`，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    （前端本片零改动；apps/ 的 diff 为空）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
# ⚠️ **池静默化**（见 R243）：本条是**必须**的，不是可选优化 ——
#    `slice-11` 第 5 组的池闭环判据写死了「全新栈」前提（`poolBefore` 必须为空），
#    而本片新增的 `slice-07.2-rpc` **排在它前面**且会真的 acquire/release 一次
#    ⇒ 池里留下可复用的空闲机器人 ⇒ 那条判据的前提被打破（实测：单独跑绿、全量跑红）。
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项，4.3s（新增）
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项，95.9s
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项，19.2s
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项，25.4s
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，8.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 60 项，14.9s（54 → +6）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 28 项，10.1s（22 → +6）
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项，4.7s（70 → +12）
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.8s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.3s
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，37.5s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（房间数参与计数，随 Redis 累积而变；只看尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，54.5s
# ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'                       # ✅ 0
docker compose logs game-service robot-service   | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET|connect timeout'                   # ✅ 0
# R231 的**正向**判据（池里每个成员都必须有 bot:{id} 记录）—— 由 slice-07.2-rpc 第 2 组承担
docker compose exec -T redis redis-cli ZCARD bot:pool:ddz                          # ✅ 0（无悬挂成员）
```

**单测分项（`--force`，0 cached）**：`shared` 171 · `room-service` **190**（173 → +17）· `game-service` **100**（83 → +17）·
`robot-service` **45**（37 → +8）· `api-gateway` 108 · `user-service` 29 · `protocol` **45**（43 → +2）· `client` 163(+2 skipped，**零改动**) · `mock-server` 2。

**生产形态（R98 不回归 + RPC 端口不发布）**：

```
api-gateway    ports= [3000]        expose= []
game-service   ports= []            expose= ["3103"]
robot-service  ports= []            expose= ["3105"]
room-service   ports= []            expose= []
user-service   ports= []            expose= []
INTERNAL_SERVICE_TOKEN 渲染： 五个服务全部 ""
```

**关闭的偏差**：**N20**（§4.2 的 TCP RPC 迁移落地）+ **N22**（新登记，见 §1.5：`robot.pool.takeIdle()`
的幽灵成员静默吃掉容量 —— R231/R238，conformance 取 RED 时撞出的既有缺陷，本片一并修）。

---

### R243（协调者，收口期）`slice-11` 的池闭环判据**写死了「全新栈」前提**，与本片新增的 `slice-07.2-rpc` **顺序耦合**

- **现象**：全量门禁（`slice-07.2-rpc` → `slice-11` → …）里 `slice-11` 红：
  `§9.6 池闭环：局终后 ZCARD(bot:pool:ddz) 净增 1（本局 2 个机器人 − 其中 1 个开局前本就空闲、复用了）= 1 → 3：期望 1，实际 2`；
  而**单独**跑 `slice-11` 是绿的。
- **它不是我引入的缺陷**：那条判据来自 `slice-11` 的**原始 commit**（`9865efa`）。此前之所以没暴露，
  是因为它前面跑的是「不碰机器人池」的切片；本片新增的 `slice-07.2-rpc` **排在它前面**，
  且第 2 组会真的走一轮 `acquire`/`release`（→ 池里留下**可复用**的空闲机器人）
  ⇒ `slice-11` 的 `poolBefore` 不再为空 ⇒ 它那条 `poolAfter - poolBefore === 本局新建数` 的等式
  在「有人复用旧机器人」时**不成立**。
- **证据链**：① 单独跑 `slice-11` ⇒ ✅ 44 项；② 全量跑 ⇒ ❌（上面原文）；
  ③ **先把池清空再全量跑** ⇒ ✅ **13/13**（`slice-11` 44 项、池净增符合预期）。
- **处置**：**门禁命令里显式清空池**（`redis-cli DEL bot:pool:ddz`，见上方门禁块）——
  把「池的状态」当成**测试前置条件**而不是运气，这与「conformance 必须独占跑」是同一类处置。
  ⚠️ **本片不重写那条判据**（它会动 `slice-11` 的池语义判据，超出 N20 范围，且需要重新取 RED/GREEN；
  另：该判据的失败消息自身也自相矛盾 —— 文本说「净增 2」而断言值是 `expectedDelta`，
  下一片重写它时**必须**先把这个歧义解决）。
- **登记为待办**（→ P3 或紧随其后的小片）：把 `slice-11` 第 5 组的池闭环判据改成**与池的前置状态无关**的形态
  （例如「本局两个 bot 都回到池且 `roomCode` 清空」+「池的**绝对**一致性」= 已由 `slice-07.2-rpc` 第 2 组承担，
  见 R231/N22），而不是依赖 `poolBefore` 为空。

---

## 下一步

- 计划落盘 → 协调者做 Task 0（契约 + 依赖）→ 派**后端 agent**（Task 1–5）与 **conformance agent**（Task 6）→ 两方 settle 后协调者合并、跑门禁、收口 `deviation-ledger.md` / `design.md` / `agent-briefs.md`。
