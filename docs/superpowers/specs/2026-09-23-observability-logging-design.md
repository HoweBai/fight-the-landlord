# 斗地主平台 · 可观测性（一）：结构化日志 + traceId 全链（设计规格）

> **日期**：2026-09-23 · **状态**：设计规格 v1（**待用户复核**）
> **上游**：`docs/design.md` §15.3（结构化日志与 traceId，**已裁决未实现**）+ §1.3（YAGNI 清单）
> **归属**：本片的**设计真源**。实施计划另出。
> **触发**：用户 2026-09-23「需要日志采集，后续才方便定位问题」，并裁决**只做最小可扩展的一档**。
> **裁决（2026-09-23，用户）**：
> 1. 范围 = **最小可扩展**（结构化 + traceId 全链 + 日志上限），**不引入**采集器 / ES / 看板 / 告警；
> 2. traceId **串到全链**（含改协议把 RPC 那一跳接上）；
> 3. 网关对客户端传入的 `X-Trace-Id`：**总是生成**（不采信）。

---

## 0. 现状复核（**起草时逐条读代码核实**）

### 0.1 日志的形态与去处

| 事实 | 证据 |
|---|---|
| 日志是**纯文本一行**：`sink(level, line)`，`line = "[Context] body"` | `packages/shared/src/logging/redacting-logger.ts:79-94` |
| 五个服务的 sink 都是 `console.log/warn/error(line)` ⇒ **stdout/stderr** | `packages/*/src/main.ts`（如 `room-service/src/main.ts:19-24`） |
| **行里没有 `ts` / `level` / `service`**：级别只体现在 stdout vs stderr 之分；时间戳是 docker 加的 | 同上（`redact.ts` 头部与 `redacting-logger` 全文无 ts/level 字段） |
| 落盘 = dockerd 的 `json-file`，**无上限** | 实测 `docker inspect`：`LogConfig={"Type":"json-file","Config":{}}`；`LogPath=/var/lib/docker/containers/…/…-json.log` |
| 全仓**零处**把日志写成 JSON | `grep -rn "JSON.stringify" packages/*/src` 无日志用途命中 |

### 0.2 traceId 的**四处载体**（三处已实现、一处为零）

| # | 载体 | 现状 |
|---|---|---|
| ① | HTTP 边缘（网关） | 🔴 `packages/api-gateway/src/auth/jwt.middleware.ts:127-132`：**客户端给了就采用、没给才 `randomUUID()`**；⚠️ **公开路径不注入**（`:91-94` 早返回）；⚠️ 注释里「客户端值一律覆盖」那条原则**只管 `X-User-Id`**，`X-Trace-Id` 被显式排除在外（`:87`） |
| ② | 网关 → 下游（HTTP） | `packages/api-gateway/src/gateway/gateway.controller.ts:224-231` 的 `headersOf()` **只转发**中间件注入的头（注释逐字 "the headers **the middleware injected**"） |
| ③ | WS（网关 → room-service） | `packages/api-gateway/src/gateway/proxy.gateway.ts:269` **每条客户端连接**建一次 `traceId: randomUUID()` → 下游握手 `auth` → `packages/room-service/src/gateway/ws.gateway.ts:199,578-580` 存进 `socket.data.traceId` |
| ④ | **RPC（服务间 TCP）** | 🔴 **零**：7 个请求类型（`RobotAcquire/Release/Decide` + `StartGame/Action/Snapshot/View`）**都没有** traceId 字段（`packages/protocol/src/robot.ts:45,56,84`、`src/rpc.ts:68,92,102,108`） |

### 0.3 另外三条**决定设计**的事实

- **WS 的 traceId 是「连接级」**（③）：一条连接上所有消息共用它 ⇒ **分不开同一玩家的多次操作**。真正能分开一次操作的是**每条 WS 消息自带的 `reqId`（客户端生成，协议既有）**——`docs/design.md` §15.3 要求的正是「`reqId`（若有）」，规格早就把两者分开了。
- **§15.3 从未被审计**：台账里 `grep "§15"` **零命中** ⇒ 既没关闭、也没裁「不做」。这是一条**已裁决未实现**的规格债，本片是它的实现。
- **脱敏实现是按 JSON 文本设计的**：`packages/shared/src/logging/redact.ts` 的 `maskValue` 逐字「保留原来的引号风格：JSON 日志里 `"password":"pw"` 换成 `"password":"[REDACTED]"` 才仍然是合法 JSON」⇒ 本片**不动脱敏实现**（见 §2 的顺序纪律）。
- **部署原则**（2026-09-23 用户裁决，`docker-compose.yml` 该处注释 + `slice-07.2-deploy` ①c/②c）：生产只用最终镜像、容器不依赖宿主产物；**日志是允许挂载的两类之一**。

---

## 1. 裁决

| # | 裁决 | 性质 |
|---|---|---|
| **R1101** | 本片范围 = **最小可扩展的一档**：① 日志结构化 ② traceId 全链 ③ 日志有上限。**不引入**采集器 / Loki / ES / Kibana / 告警 / 看板 | 用户裁决 1 |
| **R1102** | 日志记录 = **一行一条 NDJSON**，字段**恰好九个**（不是「至少」）。⚠️ 沿用 `META_FIELDS` 的成例：**加字段必须先改判据** ⇒ 有人想往日志里塞 `hand` 之类会**撞判据**，而不是悄悄绕过脱敏 | 形状 |
| **R1103** | 脱敏**先做、序列化后做**（顺序本身是判据）：`msg` 在**未转义**状态下过 `redactText`，然后整条记录 `JSON.stringify`。⚠️ 反过来（先 stringify 再脱敏）会让**字符串参数里内嵌的 JSON** 因引号被转义成 `\"` 而**逃过正则** ⇒ 静默泄敏 | §0.3 第 3 条 |
| **R1104** | traceId **全链**：HTTP + WS + **RPC**。RPC 侧 **`RpcMeta` 只定义一次**（`{ traceId: string; reqId?: string; userId?: string }`），7 个请求类型各带一个**可选字段** `meta?: RpcMeta` —— ⚠️ **不是** `extends RpcMeta`（那会把三个 id **摊平**到载荷上，而 R1105 的省略语义与判据 5 要的是**一个可选字段**的在与不在） | 用户裁决 2 · 评审口径订正 |
| **R1105** | **省略语义**：`meta` 只在 ALS 里有 traceId 时**才出现**（不是 `meta: {traceId: undefined}`）⇒ 既有「逐字载荷」判据在**没有 ALS 的**单测里**不受影响**。⚠️ **复核⑮（实施期订正）**：这只覆盖「无 ALS」的路径 —— 由**入口/定时器包过**的路径（如 `scanOnce()` 里的四跳 RPC）**依法会带上 `meta`** ⇒ 那类断言要按「只增不减」**补一条 `meta` 断言**，而不是把 meta 当不存在 | R1104 的落地纪律 |
| **R1106** | 网关**总是生成** `X-Trace-Id`（**无条件覆盖**客户端传入的值），并把生成的 id **回给客户端**（响应头）；公开路径**也注入** | 用户裁决 3 / ⑥ |
| **R1107** | **无来源不编造**：ALS 里没有 traceId 时渲染 `traceId: null` 并带 `source` 说明原因。⚠️ **两条路径要分清**（复核⑬，本条的原始措辞把定时器与 `bootstrap` 并列，与 §2/§3 冲突）：**我们主动包过的定时器一轮** ⇒ `source: 'timer'` + **该轮新生成的 id**（同一轮的行因此能成组）；**没包过的**（轮级 catch、进程启动早期）⇒ `traceId: null` + `source` 如实说明。⚠️ 编造一个假 traceId 会让「串不起来的行」**伪装成**「串起来的行」；而把定时器行标成 `bootstrap`（含义是"启动早期"）是**另一种伪装**，同样禁止 | §0.3 第 2 条 / 复核⑬ |
| **R1108** | 日志上限 = `logging.options: {max-size: "10m", max-file: "5"}`（≈50MB/服务封顶）。⚠️ **轮转即丢弃**：本片**不做留存**，语义写明 | 用户裁决 1 |
| **R1109** | **零客户端改动**：WS 侧客户端本来就发 `reqId`；HTTP 回传头**只为将来用**。⚠️ **最终评审 M1 订正**：原稿把 `Access-Control-Expose-Headers` 推给"计划期处理"，而计划期**没做** ⇒ 跨源浏览器**读不到**回传的 `X-Trace-Id`（Node 探针/curl 能读 ⇒ 判据 6 照样绿，而用户侧的好处**静默不存在**）⇒ 已落地 `enableCors({ exposedHeaders: ['X-Trace-Id'] })` | 范围 |
| **R1110** | **判据只增不减**；且 §5 判据 8（S7 运行态泄敏采样）**必须继续绿** —— 日志形态变了，泄敏面必须复检 | 全局约束 |

---

## 2. 记录形状（R1102 / R1103）

```jsonc
{"ts":"2026-09-23T01:02:03.456Z","level":"error","service":"room-service",
 "context":"WsGateway","traceId":"2f1c…","reqId":"a91b…","userId":"9912c3d1-…",
 "source":"edge","msg":"Room start failed for ABC123（补位失败或 game.start 失败）"}
```

| 字段 | 来源 | 备注 |
|---|---|---|
| `ts` | 应用侧 `new Date().toISOString()` | **加项**（§15.3 未要求）：docker 的时间是「收取时刻」，脱离 docker 就没有了；判据只断言「合法 ISO 字符串」，不断言具体值（R914 的注入纪律） |
| `level` | Nest 的 level | 原有信息，此前只体现在 stdout/stderr 之分 |
| `service` | 各 `main.ts` **显式传**（**短名**，如 `room-service`） | 配机械闸核对各自 `package.json` name 的**最后一段**（防改名漂移）。⚠️ 不用全名：npm scope 是注册表产物、不是服务身份，而这一格**每行日志都带**、运维要顺手 grep |
| `context` | Nest 的 context（原 `[Context]` 前缀） | 原样保留为字段 |
| `traceId` / `reqId` / `userId` | ALS（见 §3） | §15.3 逐字要求；无则 `null` |
| `source` | `edge` / `rpc` / `timer` / **`internal`** / `bootstrap` | **加项**（R1107）：解释「为什么没有 traceId」。⚠️ **`rpc` 不能省**（复核②）：RPC 接收侧（game-service 处理 `game.start`/`game.action`）既不是 edge、也不是 timer/bootstrap，原先三种取值**没有值可填**。五条各自的含义：`edge`=HTTP 边缘、WS 连接生命周期、或下游从 `X-Trace-Id` 继承 · `rpc`=由 RPC `meta` 带入 · `timer`=定时器自建一轮 · **`internal`=内部事件（Redis 订阅/进程内回调），无对应客户端请求 ⇒ 不编造 id**（**最终评审 I2 新增**）· `bootstrap`=**进程启动早期**（其原义，**不得**拿它当"未知来源"的兜底 —— 最终评审指出未插桩的载体曾原样落在这里，属"假话"形态） |
| `msg` | `emit()` 拼装后的文本，**已脱敏** | 对象参数仍走 `redactValue`（结构化），字符串走 `redactText`（文本）——**顺序不变，一行不改** |

---

## 3. 传播设计（R1104 / R1106 / R1107）

```
客户端 ──HTTP──▶ 网关 ──(X-Trace-Id，总是新生成)──▶ 下游 REST
   │              │
   │              └── 响应头回 X-Trace-Id（R1106）
   └──WS 握手──▶ 网关 ──(auth.traceId，每连接一个)──▶ room-service
                                                        │
                    ┌───────────────────────────────────┴──────────────┐
                    ▼                                                  ▼
          room-service ──(payload.meta{traceId,reqId})──▶ game-service  ──▶ robot-service
                                                                  （robot.decide 同载体）
```

| 环节 | 载体 | 本次改动 |
|---|---|---|
| 边缘 HTTP | `X-Trace-Id` | 🔴 **生成点要上移**（复核⑧）：今天在 `jwt.middleware.ts:131`（验签**之后**）⇒ 限流等更早的 warn 都没有 traceId。改为在 `main.ts` 的中间件链**第一件事**里：无条件生成/覆盖 + `als.run` + `res.setHeader('X-Trace-Id', …)`。⚠️ **回传头不要写进 controller**（复核⑥）：网关的 HTTP 转发是 `http-proxy-middleware` 的**逐路由封装**（`gateway.controller.ts:63/69/76/88/94/99/109…` 各自 `forwardToXxxSvc(..., res, …)`）⇒ 在 controller 里加要改 N 处；中间件里一行覆盖所有响应路径含错误。`jwt.middleware.ts:130-132` 的三元随之**简化**（前置中间件已保证存在） |
| 边缘身份（**复核⑩**） | `userId` 进 ALS 的**时机** | 🔴 网关形态（`overwriteExisting: true`）的中间件**不读** `x-user-id`（客户端自带的身份永不可信）；`userId` 由 `JwtMiddleware` **验签成功之后**用 `runWithTrace({ userId: 已验证的 sub, … })` **嵌套重跑**写入（嵌套 run 覆盖余下处理）。⚠️ 否则：网关的 trace 中间件是第一个 `app.use`，而 `JwtMiddleware` 是模块中间件（init 期才注册、必然更晚）⇒ 客户端带 `X-User-Id: 受害者` 就能把自己这次请求的**日志归属**写成受害者 |
| 边缘 WS | 握手 `auth.traceId` | 🔴 **生成点要上移**（复核⑦）：今天在 `proxy.gateway.ts:269`（建**下游连接**时才 `randomUUID()`），而网关自己的 `Client connected` 日志在 `:244`（**更早**）⇒ 那行拿不到 id。改为在 `handleConnection` **开头**生成 → `als.run` 包住整条连接的处理 → 同一个 id 既进 ALS 又用于下游 `auth`（`Client connected` / `room-service connected` 因此**共用同一个 id**）。⚠️ **复核⑫**：`Client disconnected` **不在** `runWithTrace` 的**天然**覆盖里 —— ALS 按**发出事件者的异步上下文**传播，而 socket 关闭链起于 `runWithTrace` 之外。⚠️ **最终评审 I2 订正**：这**不是**"拿不到"，而是"**处理函数没包**"—— 各连接的回调闭包里就有那个 id ⇒ **已补包裹**（见下表的「WS 连接生命周期」行）；因此在**本片收口后**，`Client disconnected` 一族也带连接级 id + `edge`，**不再**是 `null` + `bootstrap` |
| WS 消息 | `socket.data.traceId`（连接级）+ 消息自带 `reqId` | 在**消息入口一处**（`message.router.ts`）`als.run({traceId, reqId, userId})` 包住处理 |
| 下游 REST | `X-Trace-Id` / `X-User-Id` | 每个服务在 `main.ts` 装一个中间件：读这两头 → `als.run` |
| **RPC** | `payload.meta` | ① 协议：`RpcMeta { traceId: string; reqId?: string; userId?: string }` + 7 个请求类型 `extends` ② 调用侧：`GameClient` / `RobotClient` 的 send 封装**统一**从 ALS 取并附加（**只改封装，不改调用点**）③ 接收侧：各服务在 `to-result.ts` 的 `toResult()` 里 `als.run(dto.meta)` 包住 handler（**一处统一**） |
| 定时器（**五条循环**） | 一轮自建一个 id：`runWithTrace({traceId: randomUUID(), source: 'timer'})` | **五条**定时循环全部要包（复核⑭ —— 原表只列了三条，漏了匹配扫描器与 robot 回收任务；漏包的后果是它们的行被标成 `bootstrap`，而那个值的含义是"启动早期"，**是假话**）：room 的房间回收 · room 的自动开局扫描 · **room 的匹配扫描** · **robot 的机器人回收** · game 的回合计时器。⚠️ **包法按「工作在哪」定**（评审者 M4 订正）：**工作方法可被直接调用**的三条 room 循环，工作单元自包（带自建 id），另在 `setInterval` **回调**外包一次 `{traceId: null, source: 'timer'}` 覆盖**轮级 catch**；而 **robot 那条的工作体就在回调里** ⇒ 只包回调、且包的是**带自建 id** 的一层（若照抄 null 层，`Reclaimed …` 这些**工作行**会被打成 null，反而违反判据 11） |
| **WS 连接生命周期**（**最终评审 I2 补**） | 连接级 id：`runWithTrace({traceId: socket.data.traceId, source: 'edge'})` | `Client connected` / `Client disconnected` / `Ignoring stale disconnect` / `Reconnect window refreshed` / 传输层 `Rejecting WS handshake` / 网关的 `Client disconnected`·`Failed to release WS conn slot`。⚠️ 这些路径原先**在任何 `runWithTrace` 之外** ⇒ 渲染成 `bootstrap`（**假话**：那值表示"启动早期"，而它们其实是某人连上/断了）。⚠️ 修法很便宜：room-service 的握手上游**在打 `Client connected` 之前 4 行**就已写好 `socket.data.traceId`（该串已于 2026-10-12 重连片改名为 `Reconnect record refreshed`；本片判据在 ws.gateway.test.ts 重新钉住） |
| **内部事件**（**最终评审 I2 补**） | `runWithTrace({traceId: null, source: 'internal'})` | Redis 订阅 / 进程内回调（如 room-service 的 `Invalid game/match event from Redis`）—— 没有对应的客户端请求 ⇒ 无已知来源、**不编造** id（R1107 的原始场景） |
| **网关 WS 的已验证身份**（**最终评审 I3 补**） | 验签成功后**嵌套** `runWithTrace({…同一个 traceId, userId: <已验证的 sub>, source: 'edge'})` | HTTP 载体做了（`jwt.middleware` 验签后嵌套重跑），WS 载体原先**没做** ⇒ 网关侧 WS 行一律 `userId: null`，而 §15.3 的语义是「`userId`（若有）」——这里**有**（已验证）。⚠️ **绝不**采信 `auth.userId`（客户端可控） |

⚠️ **`RpcMeta` 为什么要带 `userId`**（自审⑧）：不带的话，`game.start` / `game.action` 在 **game-service 侧**的日志里 `userId` 只能是 `null` —— 而 §15.3 要求「`userId`（**若有**）」，这两条链上"有"。带上它，跨服务的行才能按玩家切片。

⚠️ **与 R146 的关系**（已核，自审⑨）：R146 的原则是「公开路径也要剥**身份头**（`X-User-Id`/`X-Token-Jti`），但 `X-Trace-Id` 是链路追踪、不在其列」—— R1106 **不推翻**它（我们仍然不把 traceId 当身份）。但 `jwt.middleware.ts:87` 与 `jwt.middleware.test.ts:131` 那两处「**保留**」注释会因此**过期**（改后不再是"保留客户端值"而是"总是覆盖"）⇒ **必须同步订正**，否则下一个人会读错。

**ALS 纪律（要写进注释与判据）**：`createRedactingLogger` 必须在 **`emit()` 时**读 ALS —— **绝不能**在构造期缓存（缓存会让全部行带同一个 traceId，是一种「看起来完全正常」的错）。见 §5 判据 2′。

---

## 4. 日志上限（R1108）

两个 compose 文件的 8 个服务各加：

```yaml
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
```

- 效果：每服务 ≈50MB 封顶、超出轮转删最旧 ⇒ **磁盘锁住，代价是丢弃**（本片不做留存）
- 生产形态（`docker-compose.yml`）与开发形态（override）**都要加**：这是**运行期**配置，与 R98/R226 的「宿主映射只许在 override」不是同一类东西（那条管的是**暴露面**）
- 生效需要**重建容器**；判据落在**渲染结果**上（§5 判据 9）

---

## 5. 判据（只增不减；每条都要能机械判 + 带负对照）

| # | 判据 | 位置 | 判别力 |
|---|---|---|---|
| 1 | 输出是**合法 JSON 一行**；`Object.keys().sort()` **恰好**九个；`level`/`context`/`service` 正确 | `shared` 单测 | `JSON.parse` 失败即红 |
| 2 | ALS 有值 ⇒ 三个 id 填上且 `source: "edge"`；**ALS 无值 ⇒ 三个都是 `null` 且 `source` 表明原因** | `shared` 单测 | 负对照：防编造假 traceId（R1107） |
| 2′ | **读取时机**：同一 logger 实例连发两条、中间换 ALS ⇒ 两行的 traceId **必须不同** | `shared` 单测 | 钉住「emit 时读」，构造期缓存即红 |
| 3 | **顺序闸**：字符串参数里内嵌 `"password":"pw"` ⇒ 输出里必须 `[REDACTED]` | `shared` 单测 | 钉住 R1103 的顺序；写反就红 |
| 4 | 机械闸：5 个 `main.ts` 传的 `service` === 各自 `package.json` name 的**最后一段（去 scope）** —— ⚠️ 本仓包名带 scope（`@fight-the-landlord/room-service`），而日志字段要的是**短名**（见 §2）；闸的意图不变：服务改名 ⇒ 短名跟着变 ⇒ 照样红 | `packages/api-gateway/test/service-name.gate.test.ts`（与既有的 `no-raw-console.test.ts` 同处 —— 都是日志面的源码闸） | 防改名漂移 |
| 5 | `RpcMeta` 省略语义：**无 traceId 时载荷里没有 `meta`**；有则带 `{traceId, reqId, userId}` | `room-service` 单测（`payloadsOf`）+ `game-service` 的 robot client 同族一条（对称） | 钉住 R1105（既有逐字断言因此不受影响） |
| 6 | **HTTP 一路到底**：建房一次 ⇒ **响应头里的 traceId** 必须能在 room-service 的日志行里找到**同一个** | conformance（slice-12 或新 slice） | 证明 生成 → 转发 → ALS → 记录 四段一致，且 R1106 的回传有效。⚠️ **不**断言"网关侧也有行" —— 网关在 HTTP **成功**路径上今天**零日志**（`gateway.controller.ts` 的 `logger.` 计数 = 0；只有上游失败才记 `proxy.gateway.ts:516`）⇒ 那样写是一条**跑不通的判据**（自审⑦） |
| 6′ | **WS 两侧都有**：客户端连上 ⇒ 网关的 `Client connected` 行与 room-service 侧处理该连接**第一条消息**时的行，**同一 traceId** | conformance | 这才是"两侧都有"的可判形态（两侧本来都有日志，不需要新增）。⚠️ 它**依赖复核⑦ 的生成点上移** —— 今天 `Client connected`（`proxy.gateway.ts:244`）在生成点（`:269`）**之前**，那行拿不到 id |
| 7 | **RPC 跳**：单人房补位开局 ⇒ `game.start` 的 `meta` 与 game-service 侧日志**同一 traceId** | conformance | 钉住「改了协议的 meta 真被透传」，不是只改了类型 |
| 8 | **S7 运行态泄敏**：五个服务的日志里**不得**出现牌面 / 令牌 / 口令 / 手机号（10 类模式 **0 命中**）。⚠️ **必须在重建容器之后跑**（复核③：不重建 ⇒ 采到的是**旧形态**） | `slice-12`（**本片新实现**） | **本片最关键的回归判据**：日志形态变了，泄敏面必须复检。⚠️ **复核⑯**：规格原写「既有采样…继续绿」，但全仓 `tools/conformance` **没有**采样代码 —— P14 那次是**一次性人工验证** ⇒ 本片把它**实现成自动化判据**（含**正对照**：10 个模式必须全部命中合成样本；含**反空测**：真实样本里必须有足够多的 NDJSON 行） |
| 9 | 生产与开发**两种形态**的渲染结果里，每个服务的 `LogConfig.Config` 都带 `max-size`/`max-file` | `slice-07.2-deploy`（加一步） | 与 ①c/②c 同一机制（渲染 + 结构断言） |
| 9′ | **真栈**：重建后 `docker inspect --format '{{json .HostConfig.LogConfig}}' <svc>` 里必须看到 `max-size`/`max-file` | `slice-07.2-deploy`（runtime 步） | 渲染 ≠ 生效（复核④）：同族教训是"假 Redis 证不了原子性"——**配置文件证不了运行中的容器** |
| 10 | 负对照：客户端带 `X-Trace-Id: 1111…` ⇒ 下游日志里的 traceId **必须不是**它 | 单测（gateway） | 钉住 R1106「不可伪造」 |
| 11 | **R1107 的判据（真栈）**：room-service 扫描器**一轮工作**的日志行（如 `Reaped N room(s)`）必须 `source: "timer"` 且 `traceId !== null`（**该轮自建**，同一轮的行因此成组）；**轮级 catch** 的行（如 `Room reap failed`，整轮炸了才打）是 `source: "timer"` + `traceId: null`（看不到内层 id）。⚠️ **不得**出现被标成 `bootstrap` 的定时器行 —— 那是**假话**（复核⑬⑭ 修订：原措辞写成"必须 `null`"，与 §2/§3 的"自建一个 id"自相矛盾，由 Task 7 的实现者发现） | conformance | 复核① 补：R1107 原本**只有裁决、没有判据**；⑬⑭ 修的是**措辞与覆盖面** |
| 12 | **身份归属不可伪造（复核⑩ 的判据）**：客户端带 `X-User-Id: victim` ⇒ ① **公开路径**（未验签）的日志 `userId` 必须是 `null`（**不得**是 `victim`）② **验签路径**的日志 `userId` 必须等于**令牌里的 `sub`**（不得是头里的值）③ **WS 孪生**（**最终评审 R2 补**）：握手 `auth: { token, userId: 'victim' }` ⇒ 下游 `auth.userId` 与网关侧日志的 `userId` 都必须等于令牌里的 `sub`。⚠️ 判据 10 只钉了 `traceId` 的同款面 | `api-gateway` 单测 | 与判据 10 同族：**日志不得成为可被客户端操纵的归因通道**。⚠️ ①② 只锁 HTTP ⇒ ③ 补 WS（否则下一个会把"身份面都锁住了"当真） |
| 13 | **`reqId` 不得成为客户端可控的注入面**（**最终评审 I1 的判据**）：① 超长 `reqId`（如 5000 字符）⇒ 记录里 ≤ **64** 字符；② `reqId` 里塞手机号 / JWT 形状 ⇒ **原值不落盘**（`redactText` 的既有规则给出 `139****5678` / `[REDACTED_JWT]` 这类占位；⚠️ **不是**字面的 `[REDACTED]` —— 本仓的脱敏器对手机号保留前 3 后 4、对 JWT 用类型化占位，判据说的是"**原值不落盘**"且**判据 8 的两个模式不命中**）。⚠️ 为什么必须有：① 客户端发 `reqId:"13912345678"` 就能把**判据 8 的泄敏采样打成红**（那是本片最关键的回归判据）；② engine.io 单帧上限 1MB × 限流 20 条/5s ⇒ 单连接 ≈4MB/s ⇒ 50MB 上限会在**十几秒**内被冲掉（把本片的目的反过来用） | `shared` 单测（+ 判据 8 的采样因此不可被操纵） | 与判据 10/12 同族：**客户端可控的值不得进入归因/留存的任何一格**。修法两件都做：ALS 边界限长 + `buildLogRecord` 对 `reqId` 过 `redactText`（于是"**日志的每一格都进过脱敏器**"成为可对外声明的不变量） |
| 14 | **未插桩的载体不得伪装成"启动早期"**（**最终评审 I2 的判据**）：WS 连接生命周期与内部事件（Redis 订阅）的行 ⇒ ① `source` 必须是 `edge`（连接类，带连接级 id）或 `internal`（内部事件，`traceId: null`）；② **不得**出现被标成 `bootstrap` 的这类行。⚠️ 判据 11 的正则只覆盖五条定时消息 ⇒ 这两族**没有任何闸看得见** | conformance（真栈）+ 单测 | 复核⑭ 自己定的纪律（"把定时器标成 `bootstrap` 是另一种伪装"）在 socket 与 Redis 两个载体上的原样残留 |

---

## 6. 明确不做（**不是遗漏**）

| 项 | 为什么 |
|---|---|
| 采集器 / Loki / ES / Kibana / 告警 / 看板 | R1101（用户裁决）；且 `design.md` §1.3 已把「数据看板、Prometheus/Grafana/Elasticsearch」裁为 MVP 不做 ⇒ 本片**不推翻**它 |
| 指标与链路追踪（OpenTelemetry） | 同上（§1.3） |
| 日志**留存**（超上限即丢） | R1108 的语义写明；留存属下一档（采集器接上就解决） |
| 客户端改动 | R1109（WS 已有 `reqId`；HTTP 回传头只给将来用） |
| **给网关加「每个 HTTP 请求一行访问日志」** | 自审⑦ 顺带发现：网关在 HTTP **成功**路径上零日志 ⇒ 「这次请求到过网关吗」只能从下游反推。**不加**的理由：日志量按请求数线性增长，而**访问日志本就该由部署层的反代承担**（`design.md` §7.1 的分工：TLS/反代不在本仓）。若将来要，另立 |
| `douzero`（python）接 traceId | 它只被 robot-service 调用；**登记为已知边界**（它的日志保持原样） |
| 反代 / LB 注入 id 的采信 | 属部署层（`design.md` §7.1：TLS/反代不在本仓）；R1106 下网关总是生成 |
| **各服务 `main.ts` 的启动横幅与 fail-closed 报错仍是裸 `console`** | **登记的例外**（最终评审 M3）：`no-raw-console` 白名单本就允许 `main.ts` 内 console；conformance 侧由 `safeJson` 过滤非 JSON 行 ⇒ 写明在这里，免得下一个人把它当"格式坏了"的证据或当 bug |
| **轮级 catch 行与它那一轮的 id 不能成组** | **取舍**：一轮工作在**工作方法**里自建 id（`reapOnce` / `scanOnce` / `scanAndMatch` 三条 —— 它们既可被循环驱动、也可被测试与运维**直接调用**；robot 那条的工作体就在回调里，故由回调带 id），而轮级 catch 起于 `setInterval` 回调、**看不到内层 id** ⇒ 它渲染 `traceId: null`（`source: 'timer'` 仍如实）。替代方案是给那三个工作方法各加一个 `traceId` 参数（一条链一个 id、catch 也能成组），代价大于收益 ⇒ 登记为已知取舍 |
| 改 `redact.ts` 的规则本身 | R1103：只挪顺序，不动规则（S7 判据全绿是硬要求） |

---

## 7. 设计期自审（起草 3 条 + 复核 6 条，**全是硬错**）

| # | 硬错 | 处置 |
|---|---|---|
| ① | **我把现状读错了（两次）**：先说「生成点只有一个：网关」，又说「HTTP 路径今天根本没有 traceId」。实测 `jwt.middleware.ts:127-132` 是**采用客户端值 / 缺则生成**，且 **公开路径不注入**。错因：只看了 `headersOf()`（它只转发），没往上游读到中间件 | §0.2 按实测重写；R1106 改成「无条件覆盖 + 公开路径也注入」（比原设想小：3–5 行） |
| ② | **「同一玩家的多次操作靠 traceId 分开」是错的**：WS 的 traceId 是**连接级**（`proxy.gateway.ts:269` 每连接一个）⇒ 一次连接上的 20 手牌共用一个 id。真正的操作级 id 是**协议既有的 `reqId`** | 设计里把两者明确分开（§2/§3）；也正是 §15.3 早就写着「`reqId`（若有）」的原因 |
| ③ | **「脱敏要在 JSON 的值上做」方向错了**，且**顺序不能反**：`redact.ts` 本就按 JSON 文本设计（引号风格保留）⇒ 实现一行不改；但必须**先脱敏后序列化**（反了会因引号被转义而漏脱敏） | R1103 + §5 判据 3（把顺序钉成可机械判的） |
| ④ | 「**落盘**」的语义含糊：只写上限就是**丢弃** | R1108 + §6 写明 |
| ⑤ | `source` / `ts` 是我**加的字段**，§15.3 没有 | §2 表格里逐条标为「加项」并给理由 |
| ⑥ | 漏了**安全面**：客户端可指定 `X-Trace-Id`（可伪造关联、可注入畸形值） | R1106 + §5 判据 10（负对照） |
| ⑦ | **判据 6 原写法跑不通**：我写「gateway 与 room-service 两侧都有行」，但网关在 HTTP **成功**路径上**零日志**（`gateway.controller.ts` 的 `logger.` 计数 = 0）⇒ 那是一条**永远绿不了**的判据（本仓最贵的一类） | 改判：HTTP 只证「一路到底」（响应头 id == 下游日志 id）；「两侧都有」改由 **⑥′（WS）** 与 **⑦（RPC）** 承担 —— 那两处两侧本来都有日志 |
| ⑧ | **`RpcMeta` 原缺 `userId`** ⇒ `game.start`/`game.action` 在 game-service 侧的 `userId` 只能是 `null`，与 §15.3「`userId`（若有）」冲突 | `RpcMeta` 加 `userId?: string` |
| ⑨ | 漏核：R1106 与 **R146**（「公开路径也要剥身份头，但 traceId 不在此列」）的关系 | 已核：**不冲突**（我们仍不把 traceId 当身份）。但 `jwt.middleware.ts:87` 与 `jwt.middleware.test.ts:131` 两处「**保留**」注释会过期 ⇒ 列入必改项 |

**已核过的两条**（自审里列为「不能凭猜」，已实测）：
- 协议包里**没有**「载荷字段集恰好」的机械闸（`packages/protocol/src/*.test.ts` 只有错误码集合与 CAS 消息计数两类）⇒ 加 `meta` 不会先撞闸
- 会因 R1106 变红的既有判据：`jwt.middleware.test.ts:322`（「injects X-Trace-Id」）与可能受影响的 `proxy.gateway.test.ts:667`（`X-Trace-Id === 't1'`）⇒ **计划期点清并同步更新**（预计 1–2 处）

### 7.1 规格复核（第二轮，2026-09-23）

> 与片⑥ 的 `4f89c2c` 同形：规格落盘后**独立再走一轮**，专找硬错与**判据边界**。共**八条**（⑦⑧ 是在用户追问「拆不拆」时核实出来的 —— 它们同时说明了「生成点位置」这处设计细节必须写死）。

| # | 发现 | 处置 |
|---|---|---|
| ① | 🔴 **裁决有、判据没有**：R1107（无来源不编造）在起草时写过一条真栈负对照判据，**重排判据表时丢了** ⇒ 落盘的版本里它一条判据都没有 —— 正是本仓最恨的「标题声称有、判据没有」（N36 那次改名） | 补为 **判据 11** |
| ② | 🔴 **`source` 取值域缺 `rpc`**：RPC 接收侧没有值可填 | §2 取值域改 `edge/rpc/timer/bootstrap` 并逐条解释 |
| ③ | ⚠️ **判据 8（S7 泄敏）会变成空测**：不重建容器 ⇒ 采到的是**旧形态**（纯文本），而本片改的正是形态 —— 与片⑥「旧镜像让真 Redis 判据变成空测」**同一个坑** | 判据 8 加备注 + §8 完成判据写明「重建后跑」 |
| ④ | ⚠️ **判据 9 只证「渲染」不证「生效」**：渲染出来的 compose 不能证明运行中的容器带了这个 LogConfig | 补 **判据 9′**（重建后 `docker inspect` 真容器） |
| ⑤ | ⚠️ **判据边界要声明**（本仓规矩）：单测（1/2/2′/3）只能证「logger 会渲染 ALS 里的值」，**证不了「谁把值放进去」** —— 后者只有真栈判据（6/6′/7）能证。另一个实例：判据 5 的「无 `meta`」那条分支在**真栈上不可达**（入口都有 traceId）⇒ 只有单测覆盖 | §5 表头加**判据边界**一节（见下） |
| ⑥ | ⚠️ **回传头没有单一落点**：网关是 `http-proxy-middleware` 逐路由封装（7+ 处 `forwardToXxxSvc`），写进 controller 要改 N 处 | §3 定 hook 点：边缘中间件里统一 `res.setHeader` |
| ⑦ | 🔴 **判据 6′ 今天跑不通**：WS 的 traceId 在 `proxy.gateway.ts:269`（建**下游连接**时）生成，而网关自己的 `Client connected` 行在 `:244`（**更早**）⇒ 那行拿不到 id，"两侧同一 id"无从成立 | §3 定：**生成点上移到 `handleConnection` 开头**（`als.run` 包住整条连接的处理，同一 id 用于下游 `auth`）—— 顺带让 `Client connected`/`room-service connected`/`Client disconnected` 共用同一个 id |
| ⑧ | 🔴 **HTTP 的生成点也偏低**：在 `jwt.middleware.ts:131`（验签**之后**）⇒ 限流等更早的 warn 没有 traceId；且**公开路径根本不注入** | §3 定：生成/覆盖 + `als.run` + `res.setHeader` 都在 `main.ts` **中间件链第一件事**里（`jwt.middleware` 那三元随之简化） |
| ⑨ | 🔴 **规格与计划自相矛盾**（**实施期**由 Task 3 的实现者发现并证明负对照）：规格 §5 判据 4 写「`service` === `package.json` 的 name」，而**本仓包名带 scope**（`@fight-the-landlord/room-service`）、§2 的记录示例却是短名 ⇒ 两者不可兼得 | **控制者裁决：取短名**（§2 示例即真源；日志每行都带它、运维不会输入 scope；scope 是注册表产物不是服务身份）⇒ 判据 4 的措辞改成「name 的**最后一段**」，闸的意图（防改名漂移）不变 |
| ⑩ | 🔴 **身份归属可被客户端操纵**（**实施期**由 Task 4 的评审者发现）：网关的 trace 中间件是第一个 `app.use`，而 `JwtMiddleware` 是模块中间件（更晚）⇒ 中间件直读 `x-user-id` 会把**客户端自带**的值写进 ALS ⇒ 每行日志都记成受害者；公开路径上任意字符串直接进日志。⚠️ 自审⑨ 只核了 `traceId` 与 R146，**漏了 `userId` 这一维** —— 同一个"边缘不可信"的道理，换个字段就漏 | §3 新增一行（网关形态**不读** `x-user-id`；`userId` 由 `JwtMiddleware` 验签后用**嵌套** `runWithTrace` 写入）+ **判据 12**（①公开路径 `userId: null` ②验签路径等于令牌 `sub`）+ 计划 Task 6 扩范围 |
| ⑪ | ⚠️ **写回 `req.headers['x-trace-id']` 零断言**（Task 4 评审者）：删掉那行，4 条测试全绿，而判据 6 的「生成→转发→ALS→记录」会**静默断** | 判据 10 的测试补一条断言（写回值与响应头**一致**），并入 Task 6 |
| ⑫ | ⚠️ **我自己写错了一处**声称（Task 5 评审者）：§3 与代码注释都说 `Client disconnected` 会共用连接级 id。但 **ALS 按「发出事件者」的异步上下文传播**，而 socket 关闭链起于 `runWithTrace` 之外 ⇒ 那行实际是 `traceId: null` + `source: 'bootstrap'`（R1107 的诚实降级 —— 不是缺陷，**声称它共用才是**） | §3 措辞改正 + 计划 Task 6 顺带修正 `proxy.gateway.ts` 的那处注释（**只改注释**）。⚠️ 教训：ALS 的边界是「**谁发起的**」而不是「**在哪里注册的**」—— 同族的还有定时器（那个我们**主动**包了 `source: 'timer'`，所以不是缺口） |
| ⑬ | 🔴 **规格内部自相矛盾**（Task 7 的实现者发现）：R1107 的括注把定时器与 `bootstrap` 并列（读成"traceId 应为 `null`"），而 §2/§3 说 `timer` 是**自建**一个 id ⇒ **判据 11（真栈）按前一种写法写的，Task 9 一跑就会红** | R1107 括注重写（**我们主动包过的一轮** ⇒ `timer` + 自建 id；**没包过的** ⇒ `null` + 如实说明）；判据 11 同步改成 `traceId !== null` |
| ⑭ | 🔴 **覆盖面漏了两个定时循环**（控制者在处理 ⑬ 时顺带发现）：§3 只列了「room 两条扫描器 + game 回合计时器」，但**匹配扫描器**与 **robot 回收任务**同样是定时器驱动 ⇒ 它们的行会被标成 `bootstrap`（含义是"启动早期"）—— **是假话**，正是 R1107 要禁的"伪装"，而且**没有任何判据**会抓 | §3 的定时器行改成**五条循环** + 各循环的 **`setInterval` 回调**也包一次（轮级 catch 落在 `bootstrap` 同样是假话）⇒ 补一个修复任务 |
| ⑮ | ⚠️ **我在计划里写错了一处事实**（实施期由 Task 11 的实现者实测订正）：我写「既有『逐字载荷』断言都在无 ALS 的单测里、必须继续绿」—— 但 `match.service.test.ts` 那两条跑在 `scanOnce()` 内，而 `scanOnce` **自包 timer 上下文**（Task 7）⇒ 载荷**依法**带上 `meta`。两个任务**交互**产生了原稿没预见的形态 | R1105 加订正句（见上）；那两条断言按「只增不减」改成「**业务字段仍逐字** + `meta` 另断言 + **同一轮的四跳 RPC 共用一个 traceId**（钉 R1104）」。⚠️ 后者比原判据更强：它证明**一次扫描轮次**的 4 跳 RPC 共享同一个 id |
| ⑯ | 🔴 **规格把一条不存在的判据写成「既有」**（控制者在 Task 13 实测时发现）：判据 8 写「S7 运行态泄敏（**既有采样**：10 类危险模式 0 命中）**继续绿**」—— 但全仓 `tools/conformance` **没有**采样代码，P14 那次是**一次性人工验证**（只活在台账的叙述里） | 把「一次性人工验证」**实现成自动化判据**（`slice-12`，含**正对照** 10/10 + **反空测** ≥50 行）⇒ 实测：**10/10 命中**合成样本、真实样本 **1097 行**、**违例 0**。它同时补上「日志形态刚改过 ⇒ 新形态真的在写」这条证据 |
| ⑰ | 🔴 **真栈判据的「哪两行」我凭推断写错三次**（控制者，Task 13）：① 单人房开局 ⇒ 那条链**成功时不打日志**；② 匹配房的 `Matched N seats` ⇒ **本用例没有匹配路径的房间**；③ 「最后一个入座者的 `joined … at seat 2`」⇒ 那是 **REST 占座**（另一次操作），而房间由**紧随其后的 WS `room.join`** 同步触发 ⇒ 两者**本就该不同 id** | 最终形态**不依赖"哪两行"的推断**：断言接收侧那行的 id **在调用方日志里出现过**（那个 id 只可能来自我们发过去的 `meta`）。⚠️ **教训写进 §7.1**：真栈判据必须先看实测数据（`docker compose logs`）确定"哪两行"，**不能凭"链路应该长这样"推断** —— 单测层永远发现不了这类错 |

### 7.2 最终全分支评审（**最强模型**，23 个提交 / 294KB）—— 三条 Important + 一轮修复

| # | 发现 | 处置 |
|---|---|---|
| **I1** | 🔴 **客户端可控的 `reqId` 未脱敏 + 无长度上限就进了每行日志**。后果：① 客户端发 `reqId:"13912345678"` 就能把**判据 8 的泄敏采样打成红**；② engine.io 单帧上限 1MB × 限流 20 条/5s ⇒ 单连接 ≈4MB/s ⇒ **50MB 上限十几秒被冲掉**（把本片的目的反过来用） | **判据 13**：ALS 边界**限长 64** + `buildLogRecord` 对 `reqId` 过 `redactText`（于是「**日志的每一格都进过脱敏器**」成为可声明的不变量） |
| **I2** | 🔴 **socket 生命周期与 Redis 订阅族的行落成 `source: 'bootstrap'`**（该值含义是"启动早期"）—— 与复核⑭ 同一条纪律的**原样残留**，而判据 11 的正则只覆盖五条定时消息 ⇒ **没有闸看得见**。⚠️ 且**不是 ALS 的固有限制**：room-service 的握手上游在打 `Client connected` **前 4 行**就已写好 `socket.data.traceId` | §3 新增两行（WS 连接生命周期 · 内部事件）+ 新增第 5 个 source 值 **`internal`** + **判据 14**。⚠️ **规格层面的订正**：`source` 的四值域里原**没有**「这个载体我们没插桩」这一格 ⇒ `bootstrap` 事实上被当成了"未知来源"的兜底，与 §2 的定义冲突 ⇒ 现在**显式定义五值**，`bootstrap` 回归"进程启动早期" |
| **I3** | 🔴 **网关 WS 侧从不把已验证的 `userId` 写进 ALS**（HTTP 侧做了）⇒ 网关侧 WS 行一律 `userId: null`，而 §15.3 说「`userId`（若有）」——这里**有**（`verifyClient` 已返回验签后的 `sub`） | §3 新增一行（验签后**嵌套**重跑，与 HTTP 载体同形）+ **判据 12③**（WS 孪生） |
| M1 | ⚠️ **R1109 的承诺没落地**：`Access-Control-Expose-Headers` 被推给"计划期"而计划期没做 ⇒ 跨源浏览器读不到回传头（用户侧的好处**静默不存在**） | 已落地 `enableCors({ exposedHeaders: ['X-Trace-Id'] })` |
| M2 / M4 / M3 | 接收侧 `meta` 用内联形状复刻 `RpcMeta` · 新增测试的 `Logger.overrideLogger` 不还原 · 启动横幅不是 NDJSON | 前两条顺手收紧；第三条**登记为明确例外**（§6） |
| R1 | **结构性防线缺失**：RPC 发送点靠"三处手写 + 每条边的单测"，新增第四条边/搬家一次 `send` 会**静默丢掉那一跳**（真栈判据 7 只覆盖 `game.start`） | 新增**源码闸**：`packages/*/src` 里每处 RPC `send` 必须与 `metaFromTrace()` **同现** |

⚠️ 评审者也核了一处**结构性风险**（结论：声明属实）：main.ts 里 `app.use(traceMiddleware)` 是否真排在模块中间件之前 —— 对着 Nest 10.4.22 源码核了 `initialize()`（只扫描+实例化、**不调 `init()`**）与 `init()`（由 `listen()` 触发）⇒ 链序正确，判据 12② 在生产上不会因链序失效。另：性能面**无需优化**（每行多一次 `toISOString()` + 一次序列化 + 一次 `getStore()`，与既有的 6 趟 `redactText` 同量级）。

**判据边界（本片的四句话，写给下一个人）**

1. **单测证机制、真栈证贯穿**：判据 1/2/2′/3 证明的是「ALS → 日志行」这一段；「谁把值放进 ALS」只能由 6/6′/7 在真栈上证 —— **不得**用判据 2 代替"贯穿已成立"。
2. **渲染证配置、`inspect` 证生效**（判据 9 vs 9′）。
3. **旧容器证不了新形态**（判据 8 的前置条件）。
4. **`meta` 的"无值"分支只活在单测里**（真栈上入口都带 traceId）⇒ 那不是缺口，是**结构性不可达**，写明即可。

---

## 8. 完成判据

| 项 | 判据 |
|---|---|
| 结构化 | §5 判据 1、2、2′、3 全绿（含两条负对照） |
| 全链 | §5 判据 6、6′、7 在**真栈**上绿（HTTP 一路到底 / WS 两侧 / 跨 RPC 各一条） |
| 无来源不编造 | §5 判据 11 绿（**R1107 的唯一判据** —— 复核① 补） |
| 不可伪造 | §5 判据 10 绿 |
| 日志有上限 | §5 判据 9（渲染）**与 9′（真容器 `inspect`）**都绿 |
| 不受影响 | §5 判据 8（S7 泄敏采样）绿 —— ⚠️ **必须在重建容器之后跑**（复核③；否则测的是旧日志形态） · 探针 `gate`/`full` **逐字不变** · conformance 9 例全绿 |
| 判据只增不减 | `shared` / `api-gateway` / `room-service` / `game-service` / `protocol` 各包条数不减少 |
| 门禁 | `pnpm run ci` 六阶段 · `build:app` |
| 声明落盘 | 落地后给 `docs/design.md` **§15.3 加 `[已实现]`**（与 §13.5 的 `[已修复]` 同形）；本片新开 `R1101–R1110`，**不推翻** §1.3 的 YAGNI |

---

## 10. 完成状态（**实施后回填**，2026-09-23）

| 项 | 结果 |
|---|---|
| 判据 1 / 2 / 2′ / 3（结构化 · 读取时机 · 顺序闸） | ✅ 全绿。判据 3 的判别力由评审者**实测**：把「先脱敏后序列化」写反 ⇒ 引号被转义 ⇒ 正则失配 ⇒ 红 |
| 判据 4（`service` 名机械闸） | ✅ 5/5（含负对照：写成全名恰红 1 条） |
| 判据 5（`meta` 正 / 负对照） | ✅ 正：逐字 `{traceId,reqId,userId}`；负：`'meta' in payload === false`（无 ALS 时） |
| 判据 6 / 6′（HTTP 一路到底 / WS 两侧） | ✅ 真栈：命中 **1 行** / 同一 id **2 行**且 `source: edge` |
| 判据 7（跨 RPC） | ✅ 真栈：接收侧 `source: rpc` + 该 id **在调用方侧出现过（2 行）** ⇒ **meta 真的跨过 TCP**；这一条也**经验性地**回答了「ValidationPipe 会不会剥掉载荷里的 meta」——**没剥** |
| 判据 8（S7 泄敏） | ✅ 五个服务 **1097 条** NDJSON 行、**违例 0**；**正对照 10/10 命中**合成样本。⚠️ **它是本片新实现的**（规格原写「既有采样」实为**不存在**，见 §7.1-⑯） |
| 判据 9 / 9′（日志上限：渲染 + 真容器） | ✅ `slice-07.2-deploy` **109 项全绿**（106 → 109） |
| 判据 10 / 11 / 12（不可伪造 traceId / 无来源不编造 / 身份归属不可伪造） | ✅ 全绿（11 含真栈；10/12 含负对照；12 的 **③ WS 孪生**由修复轮补上） |
| **判据 13 / 14**（修复轮新增：`reqId` 客户端可控面 · 未插桩载体不得伪装成 `bootstrap`） | ✅ 全绿（含变异实验 RED 证据：`expected 5000 to be 64` · `expected 'bootstrap' not to be 'bootstrap'`） |
| **最终全分支评审**（最强模型 · 23 提交 / 294KB） | ✅ verdict = **With fixes** ⇒ 三条 Important（I1 `reqId` · I2 `bootstrap` 假话 · I3 网关 WS 缺已验证 userId）+ M1/M2/M3/M4/R1 **全部收掉**（`a120a79` / `5887a6d` / `b964089`）；复跑真栈 **slice-12 77 · hardening 103 · deploy 109** 全绿 |
| 判据只增不减 | ✅ shared **182 → 199** · room **275 → 296** · api-gateway **151 → 163** · game **110 → 114** · robot **59 → 62** · protocol **45 → 49**（合计 **+59**）；client **500** 与 user-service **44** 一条未动 |
| 门禁 `pnpm run ci` | ✅ **六阶段一次通过**（EXIT=0） |
| `build:app` | ✅ DONE |
| conformance 9 例 | ✅ 全绿：slice-05 **29** · slice-06 **54** · slice-07 **39** · slice-07.1 **28** · slice-08 **55** · slice-09 **160** · slice-10 **185** · slice-11 **50** · slice-12 **77**（69 → 77 = 判据 6 的跨源半边 + 7 + 8）· 另 `slice-07.2-deploy` **109** · `slice-07.2-hardening` **103** |
| 探针 | ✅ `gate` **18/18**（**逐字不变**）· `full` **33/33** |
| 声明落盘 | ✅ `docs/design.md` §15.3 已加 `[已实现]` |
| 已知取舍（§6） | 轮级 catch 与它那一轮的 id 不能成组 · `douzero`（python）不接 traceId · 网关不加「每请求一行访问日志」 |

### 10.1 执行期发现（**17 条自审/复核 + 最终评审 1 轮**：见 §7 自审 9 条 · §7.1 复核 ⑨–⑰ · **§7.2 最终评审的 3 Important + 5 顺带 + R1**）

⚠️ **本片的自审/复核密度是本项目里最高的一次**（17 条，其中 **8 条是我自己的错**：
口径自相矛盾、把不存在的判据写成"既有"、真栈判据的"哪两行"凭推断写错三次…）。
**这不是自谦，是给下一个人的警示**：这条链（日志 → 上下文 → 跨进程）看起来"显然"，
而每一条"显然"都得用实测数据核过 —— 单测层**结构上**发现不了这类错。

---

## 9. 范围：**一片做完**，但实施顺序按 A → B（2026-09-23 用户裁决）

改动面很宽（`shared` 日志器 + ALS 基建 + 协议 7 个接口 + 网关边缘 + 5 个服务入口 + 2 条定时器 + compose ×2 + 4 个包与 conformance 的判据）。**曾考虑拆两片，已否决** —— 理由如实记：

| 曾用来支持「拆」的论据 | 复核后的结论 |
|---|---|
| 「先用一周 A 的日志，才知道 B 该串哪几条链」 | ❌ **不成立**：`RpcMeta` 带 `traceId/reqId/userId` 三个字段的成本可忽略（内网 RPC，几十字节）⇒ 需求校准换不来什么 |
| 「B 风险面独立」 | ⚠️ 削弱：本仓判据是**分层**的（协议问题先在判据 5/7 暴露，日志器问题先在 1–4 暴露）⇒ 归因面差别不大 |
| 「回退粒度更细」 | ⚠️ 削弱：按片回退本来就够用 |
| 「A 能独立交付价值」 | ⚠️ 部分成立（HTTP/WS 两条链在 A 之后就能串），但代价是**多跑一轮完整门禁**（`ci` 六阶段 + conformance 9 例 + 探针 full ≈ 15–25 分钟机器时间）+ 两轮 spec/plan/回填 + **A 阶段判据表只能半绿**（判据 6/6′ 绿、7 不绿），而本仓对判据表的洁癖很强 |

**净结论**：拆片省不下什么，反而多一轮门禁与一轮文档；因此**一片做完**，只把 A/B 当作**实施顺序**（先日志底座并就地验证"HTTP/WS 已能串"，再扩到协议那一跳）—— 中途可见进展，但不付两轮的代价。

| 顺序 | 内容 | 完成时能看到什么 |
|---|---|---|
| **A · 日志底座**（先做） | R1102/R1103（形状 + 脱敏顺序）· R1108（上限）· `source`/`ts` · ALS 基建 + 入口包裹（HTTP/WS/**定时器**，含复核⑦⑧ 的生成点上移）· §5 判据 1–4、2′、9、9′、11 | 日志变得**可读可查**（时间戳/级别/服务名/上下文 + 磁盘有上限），且 **HTTP 与 WS 两条链已经能串**（载体 ①②③ 本来就实现了） |
| **B · traceId 全链**（后做） | R1104/R1105（协议 `meta` + 两侧封装）· R1106（网关总是生成 + 回传 + 公开路径）· §5 判据 5、6、6′、7、10 | **跨 RPC 那一跳**也串起来（room → game / robot，含机器人决策） |
