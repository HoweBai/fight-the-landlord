# 独立小片 P3 实施计划：工程收口（E2 / E6 / E7 / N9 / N12 / N14 / N15 后端半边 / N21）+ R243 判据重写

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把对账表「独立小片（P3 / 工程）」里**剩余的全部**工程类偏差一次收口 —— 端口从 env 读（E2）、`Room.timeoutAt` 落地（E6）、关掉 `synchronize` 并改用显式迁移（E7）、房间元数据按 §10.1 改成 **Hash**（N9）、未知路由返回 §11.1 信封（N12）、`/api` 之外的处理器一律 404 的机械闸（N14）、WS 连接限额挪到 **engine.io `allowRequest`**（N15 后端半边）、§9.6 兜底回收扫得到「`release` 丢失」的**绑定中**机器人（N21）；并顺手重写 `slice-11` 那条写死「全新栈」前提的池闭环判据（**R243**）。

**Architecture:** 这一片**不动分层**，只收口 8 个彼此独立的工程缺陷。唯一有结构影响的是 **N21**：它必须新增一个「绑定中」索引键（`bot:bound:{botId}`）才能让兜底回收看见「`release` 丢失」的机器人 —— 这条要同步写进 `docs/design.md` §10.1 的键表（否则下一个读键表的人会以为它不存在），并且**权威仍是 `bot:{botId}`**（`bot:bound:*` 只是它的反向视图，与切片 11 的 `bot:room:*` 同性质）。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / TypeORM 0.3 / mysql2 / socket.io 4 / Vitest / pnpm workspace + Turborepo / Docker Compose

**Spec:**
- `docs/design.md` v4.2 —— **§2.1（端口表）· §2.3（环境变量表：`PORT` 禁止硬编码）· §3.1（`Room`：`timeoutAt`）· §5.4（限流四维度）· §7.1（网关路由表 / 404 语义）· §9.6（池填充与兜底回收，逐字）· §10.1（Redis 键表，逐字）· §10.3（MySQL：`synchronize` 仅限开发）· §11.1（统一信封）**
- `docs/superpowers/plans/deviation-ledger.md` —— §1.2 的 **E2/E6/E7**、§1.5 的 **N9/N12/N14/N15/N21**、§2「独立小片（P3 / 工程）」与「独立小片（P4）」里的 **R243**
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」（bind-mount / `DOCKER_BUILDKIT=0` / 门禁 `--force` / conformance 必须**独占**跑 / **先清空机器人池**）+「切片 P4 新增的通用教训」
- **本片范围裁决（用户 2026-09-16 当场确认）**：7 项**一次全做**（含 E7），且 **E7 采用 `migrationsRun: true`（启动时自动跑迁移）**

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节（端口 / Vitest / `Transport.TCP` + `@MessagePattern` / 对外 REST 与内部 RPC 不共用方法 / socket.io ack / `baseVersion` CAS + `13004` / 5 位数字错误码 / 身份只从网关注入 / 裁剪 / 牌值 DouZero 进出判定还原内部 Rank / 前端哑终端 / `packages/protocol` 协调者独占）。

### 本切片的绑定数值（逐字，来自 `design.md`）

| 项 | 值 |
|---|---|
| `PORT`（§2.3） | **禁止硬编码端口** —— 每个服务都从 `process.env.PORT ?? <自身端口>` 读 |
| `Room.timeoutAt`（§3.1） | `timeoutAt: number;` —— **`waiting` 状态的超时时刻**（不是对局计时器） |
| `room:{code}`（§10.1） | **Hash**，TTL **3600s**，字段 `code`/`mode`/`baseScore`/`status`/`maxPlayers`/`createdAt`/`timeoutAt` |
| MySQL（§10.3） | 「`synchronize: true` **仅限开发环境**；MVP 上线前须改为**显式迁移脚本**」 |
| 404 信封（§11.1） | `{ code, message, data }`；**未知路由用哪个码**由 **R244** 定 |
| `/api` 前缀（§7.1 / N14） | 公开白名单**恰好四条**；**任何**在 `/api` 之外注册的处理器都整条绕过验签 ⇒ 必须 404 |
| WS 连接限额（§5.4） | 单 IP 并发 WS 连接 **5**；键 `ratelimit:ws-conn:{ip}`；被拒的客户端应拿到 **`connect_error`**（而不是「连上即被踢」） |
| §9.6 兜底回收（逐字） | 「空闲机器人在池中带 `idleSince`，回收 `idleSince` > **10 分钟**且 `roomCode` 指向的房间已不存在的」；**对局中的机器人不得回收** |
| `bot:pool:{gameType}`（§10.1） | **ZSET**，`member = botId`、`score = idleSince`；**池 = 空闲集合**（绑定中的机器人 `ZREM` 出池） |
| 本片相关错误码 | `10001` 参数非法 · `10002` 内部 token · `10006` 限流 · `10007` 下游不可达 · `12001` 房间不存在 —— **不新增任何错误码** |

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P4 的 **R243**，从 **R244** 起。执行期若发现与代码事实不符，**就地记「执行期裁决」并写进计划文件**（编号接着排，**不隐去历史**）。
> ⚠️ **派工前先划定编号区间**（P4 教训第 7 条）：**后端 agent 用 R260–R279**，**conformance agent 用 R280–R299**，协调者保留 R244–R259。

- **R244 N12 的「未知路由」错误码：用 `10001 BAD_PARAM`，并只覆盖**网关自己**的 404。**
  理由：§11.2 的码表里没有「路由不存在」这个语义的专用码，而 `10001` 的码义是「参数非法」——
  一个不存在的路径**就是**非法的请求目标，这是表内最贴近的一支；**新增错误码**违反 Global Constraint 7 与 §11.2 的封闭性（该表由 `errors.test.ts` 的 `SPEC_CODES` 机械校验）。
  **落地形态**：在网关加一个**全局异常过滤器**（`src/http/not-found.filter.ts`），把 **`NotFoundException`** 渲染成 `{ code: 10001, message, data: null }`。
  ⚠️ **只拦 404**，不得顺手改 401/403/429/503 的信封 —— 那会把 `slice-07.2-*` 的一大批既有断言打红（它们是**故意**区分状态码的）。
  ⚠️ **不得**把「路径不存在」与「房间不存在」（`12001`）混为一谈：后者是**业务** 404，由各控制器自己抛，必须保持 `12001`。

- **R245 N14 的机械闸：**「**非 `/api` 前缀的路径一律 404**」，且必须**区分**「404 的成因是路由不存在」与「401 被中间件挡住」。**
  ⚠️ 这条是本片最容易写错的地方（P4 的 **R241** 就是同一个坑）：`JwtMiddleware` 的
  `forRoutes('*')` 被 `setGlobalPrefix('api')` 收窄成 `/api/*` ⇒ **`/api` 之外的路径根本不经过中间件**，
  因此它们**不是** 401 而是 Nest 默认 404 —— 这正是 N14 的**实质**（「将来谁在 `/api` 外注册处理器就整条绕过验签」）。
  **闸的形态**（两条**并列**，缺一不可）：
  1. **行为闸**（真 HTTP）：对一组非 `/api` 路径（`/`、`/index.html`、`/games`、`/api`、`/apix`、`//api/rooms`）
     断言 **404 且响应体是 §11.1 信封**（R244 之后的形态；`code === 10001`）；
  2. **源码机械闸**（`packages/api-gateway/test/no-route-outside-api.gate.test.ts`）：
     `api-gateway/src/**` 里的 `@Controller(...)` 与 `@Get/@Post/...` 路径**不得**出现非 `/api` 前缀的注册
     —— 但**必须**先 `grep` 出真实命中集合再定正则与**正对照**（R150 的教训），
     并且**正对照必须能在当前源码上命中**（例如 `@Controller()` 空前缀是**合法**的：
     全局前缀会补上 `/api`；`@Controller('games')` 也是合法的。**非法**的是「显式写了 `/` 开头且不以 `/api` 开头」的路径）。
     ⇒ 闸要钉的是**后一种形态**，并配一条「注入 `@Get('/foo')` ⇒ 闸红」的判别力自证。

- **R246 N15 的落地形态：`allowRequest` 里做限额检查，**拒绝即 `connect_error`**。**
  §5.4 逐字要的是「单 IP 并发 WS 连接 5」。今天的实现在**握手之后**（`proxy.gateway.ts` 的
  `handleConnection` 里 `rejectHandshake`）⇒ 客户端先收到 `connect`、再 `system.error`、再被
  `io server disconnect`（R152 实测），前端只能靠**单向闩锁**兜住（N15 前端半边，已在切片 9 修）。
  **后端半边**：把检查挪到 **engine.io 的 `allowRequest`**（socket.io 适配器的
  `allowRequest` 选项由 `@WebSocketGateway` 的 `allowRequest` 传入，签名 `(req, callback)`）⇒
  超限时**在传输层就拒绝**，客户端拿到 **`connect_error`**（而不是 `connect` 后才被踢）。
  **判据必须同时钉住三件事**（否则会把「传输层拒绝」与「握手后踢」判成同一个东西）：
  ① 第 6 条连接拿到 **`connect_error`**；② 它**从未**收到 `connect`；③ 前 5 条**真的** connected（正对照）。
  ⚠️ 与 P4 的 R152 对照：R152 记录的是**旧**形态；本片之后 N15 的表述要改成「传输层拒绝」。
  ⚠️ `allowRequest` 是**异步**的（要查 Redis）⇒ 必须 `callback(null, boolean)`，**不得**在没有
  callback 的路径上 throw（否则连接会挂住）。Redis 故障时**fail closed**（S6 的既有语义）。

- **R247 N21 的落地形态：新增 `bot:bound:{botId}` 索引，并同步写进 §10.1。**
  §9.6 的兜底回收今天用 `ZRANGEBYSCORE bot:pool:ddz -inf <now-10min>` 取候选 —— 而
  `bot:pool` 是**空闲集合**（绑定中的机器人已 `ZREM` 出池）⇒ 「`release` 丢失、机器人一直绑定」
  这一情形**结构上永远扫不到**（切片 11 已登记为 N21，未擅自扩键）。
  **裁决：扩键，并把它写进 §10.1**（用户已确认 N21 在本片收口）：
  - 键：`bot:bound:{botId}` —— **String(JSON)** `{ roomCode, seat, boundAt }`，TTL 与房间一致（**3600s**）；
  - `acquire` 绑定时 `SET`、`release` 归池时 `DEL`（**与 `bot:pool` 的 `ZADD`/`ZREM` 成对**，
    两者是同一次状态转移的两个视图 ⇒ **必须在同一段代码里成对出现**，否则又是一处「第二真源」）；
  - `reclaimIdle()` **追加一轮扫描**：按 `bot:bound:*` 找「绑定中」的机器人，
    若 `room:{roomCode}` **不存在** ⇒ 回收（`DEL bot:bound:{botId}` + `DEL bot:{botId}`）；
    ~~`boundAt` 超过 **10 分钟**同样纳入候选（防「房间键还在但服务已崩」的长期悬挂）~~
    ⚠️ **这半句是错的，已被执行期裁决 R262 取代**：它与 §9.6「**对局中的机器人不得回收**」
    以及本 Task 自己的正对照用例直接冲突（一局可以打很久，`boundAt > 10min` 完全正常）。
    **最终语义：只有「`room:{roomCode}` 不存在」才回收**；`boundAt` 只用于日志与陈旧性核对。
  - ⚠️ **权威仍是 `bot:{botId}`**（含 `roomCode`/`seat`/`idleSince`）；`bot:bound:*` 只是**反向视图**，
    必须在 §10.1 里写明这条从属关系（照切片 11 给 `bot:room:*` 的写法）。
  - ⚠️ **不得**把 `bot:bound:*` 当成第二个真源去回答「机器人是否绑定」—— 绑定状态的读侧权威是 `bot:{botId}`。

- **R248 E7 的迁移形态（用户确认：启动时自动跑）。**
  - `synchronize: false` + `migrations: ['dist/migrations/*.js']` + `migrationsRun: true`；
  - 生成一份 **initial migration**，内容**对齐当前已存在的 `users` 表**（`id varchar(36) PK` /
    `phone varchar(20) UNIQUE` / `passwordHash varchar(255)` / `nickname varchar(50) NULL` /
    `avatar varchar(255) NULL` / `status varchar(10) DEFAULT 'active'` / `createdAt datetime(6) DEFAULT CURRENT_TIMESTAMP(6)`）——
    实测该表**已经存在**，因此首跑只会写 `migrations` 表；
  - 需要 `packages/user-service/src/data-source.ts`（TypeORM CLI 用）+ `package.json` 的
    `migration:generate` / `migration:run` 脚本；**新库**（docker volume 被清掉时）靠 `migrationsRun` 自动建表；
  - ⚠️ **判据必须证明「synchronize 关了、服务仍起得来」**：容器重启后 `users` 表仍在、user-service healthy。
    只断言配置项为 `false` 是**不够**的（那是「改了个字面量」）。

- **R249 N9 的 Hash 化**：`room:{code}` 从 **String(JSON)** 改为 **Hash**（§10.1 逐字）。
  - 字段与 §10.1 一致：`code` / `mode` / `baseScore` / `status` / `maxPlayers` / `createdAt` / `timeoutAt`；
  - **读侧必须全部改**：`findOne()` 用 `HGETALL`、`writeMeta()` 用 `HSET` + `EXPIRE`（**TTL 3600s 不能丢**）；
    类型全部以**字符串**存储 ⇒ 读回时 `Number(...)` 还原（并**断言字段名集合恰好 7 个**，防悄悄多/少）；
  - **爆炸半径已实测很小**：生产代码只有 `rooms.service.ts` 读写 `room:{code}`；
    `robot-service` 只做 `EXISTS room:{code}`（Hash/String 都成立，**不必改**）；
    测试里只有 `rooms.service.test.ts:99` 一条断言直接 `JSON.parse(redis.strings.get(...))` ⇒ 必须改。
  - ⚠️ **不得**用 `HSET` 做「读-改-写」（C11 的教训：座位原子性靠 `HSETNX`，元数据今天没有并发写
    的重灾区，但 `writeMeta` 必须**一次 `HSET` 全字段**，不要逐字段读改写）。

- **R250 R243 的判据重写：池闭环判据必须**与池的前置状态无关**。**
  今天 `slice-11` 第 5 组写死「全新栈」前提（`poolAfter.length - poolBefore.length === 本局新建数`），
  与本片之前新增的 `slice-07.2-rpc` **顺序耦合**（单独跑绿、全量跑红、清空池后全绿）。
  **改成两条与前置状态无关的绝对判据**（`slice-07.2-rpc` 第 2 组已承担「池索引自身一致性」）：
  1. **本局两个机器人都回到池里**（`afterSet` 含 `roomBotIds` 两个，已存在，保留）；
  2. **池里没有任何成员缺记录**（绝对不变式，已由 `slice-07.2-rpc` 第 2 组承担，这里保留一条**同源**断言）；
  3. **`bot:{botId}` 的 `roomCode`/`seat` 已清空**（已存在，保留）；
  4. ⚠️ **把那条等式改成「池**不因本局净减少**」**（`poolAfter.length >= poolBefore.length - reused`），
     或者**干脆删掉等式**、只留「两个机器人都回池」+「池自洽」这两条绝对性质。
     **采用后者**（删等式）：P4 已经用「池里每个成员都必须有记录」这条**绝对**性质覆盖了「池退化」，
     再留一条**相对量**等式只会再制造一次顺序耦合（R115 同族：相对量判据对绝对退化免疫）。
  - ⚠️ 重写后**必须**在两种前置状态各跑一次证明它顺序无关：
    ① 池空；② 池非空（先跑 `slice-07.2-rpc` 造出池成员）。**两次都必须绿**。
  - ⚠️ 顺带修掉那条失败消息的**自相矛盾**（文本写「净增 2」而断言值是 `expectedDelta`）——
    删掉等式后这条消息也一并消失；若保留任何池计数输出，**只作 `info`，不作断言**。
  - 门禁命令里那条 `DEL bot:pool:ddz`（P4 加的「池静默化」）**保留**（它仍是廉价的确定性保险），
    但**不再是**让 `slice-11` 绿的必要条件 —— 这正是本条要证明的。

---

## 执行模型（与切片 5–11 / P4 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | 评审、合并、门禁、`docs/**` 收口（`design.md` §10.1 键表 + §3.1/§10.3 注记 + 对账表关闭 E2/E6/E7/N9/N12/N14/N15/N21/R243） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | **Task 1–8**（E2 / E6 / E7 / N9 / N12 / N14 / N15 / N21）。**TDD，一项一提交**；编号区间 **R260–R279** |
| **conformance agent** | `/home/howe/pokergame`（主检出，`tools/conformance/**`） | **Task 9**（R243 判据重写 + N9/N12/N14/N15 的在线判据）。编号区间 **R280–R299** |
| 前端 | —— | **本片无前端改动**（N15 的前端半边已在切片 9 收口；本片只动传输层拒绝的形态） |

**开工前固定动作（两个 agent 都逐字执行）**：

```bash
# 后端 agent
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current          # 必须输出 feat/backend
git merge master --no-edit                # 协调者已把本计划与裁决推到 master
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ 必须带 --store-dir（工作区外的 ~/.pnpm-store 会被沙箱拒绝）
pnpm exec turbo run build --force         # dist/ 是 gitignore 的

# conformance agent（主检出，master）
cd /home/howe/pokergame
pwd && git branch --show-current          # 必须是 master
pnpm exec turbo run build --force         # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
```

**⚠️ conformance 必须独占跑**（网关按 IP 计并发 WS 连接、上限 5）：conformance agent 跑任何切片期间，
**其他人不得**重建/重启容器、不得跑任何切片。

**汇报格式**（统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/user-service/src/main.ts                        Modify: listen(Number(process.env.PORT ?? 3001))（E2）
packages/user-service/src/app.module.ts                  Modify: synchronize:false + migrations + migrationsRun（E7）
packages/user-service/src/data-source.ts                 Create: TypeORM CLI 用的 DataSource（E7）
packages/user-service/src/migrations/1*.ts               Create: initial migration（对齐现有 users 表）（E7）
packages/user-service/package.json                       Modify: migration:generate / migration:run 脚本 + typeorm CLI 依赖（E7）
packages/user-service/test/port.test.ts                  Create: PORT 生效的判据（E2）
packages/user-service/test/migration.test.ts             Create: synchronize 关闭 + users 表仍存在（E7）

packages/room-service/src/rooms/rooms.service.ts         Modify: 元数据 Hash 化 + timeoutAt 读写（E6/N9）
packages/room-service/src/rooms/rooms.service.test.ts    Modify: 那条 JSON.parse 断言 + Hash 形状/字段集断言
packages/room-service/src/rooms/rooms.timeout.ts         Create: waiting 超时时刻的唯一实现（E6）
packages/room-service/test/rooms.timeout.test.ts         Create: timeoutAt 的判据（E6）
packages/room-service/test/rooms.service.test.ts         Modify: Hash 形状 + 字段集恰好 7 个 + TTL 3600s

packages/api-gateway/src/http/not-found.filter.ts        Create: 未知路由 ⇒ §11.1 信封（R244/N12）
packages/api-gateway/src/main.ts                         Modify: 注册全局过滤器（N12）
packages/api-gateway/test/not-found.filter.test.ts       Create: 404 信封判据 + 「只拦 404」的反向判据（N12）
packages/api-gateway/src/gateway/proxy.gateway.ts        Modify: 连接限额挪到 allowRequest（N15）
packages/api-gateway/test/ws-allow-request.test.ts       Create: 超限 ⇒ connect_error 且**从未** connect（N15）
packages/api-gateway/test/no-route-outside-api.gate.test.ts Create: 非 /api 注册的源码机械闸 + 判别力自证（N14）

packages/robot-service/src/robot/robot.pool.ts           Modify: bot:bound:{botId} 索引 + reclaimIdle 第二轮扫描（N21）
packages/robot-service/src/robot/robot.pool.test.ts      Modify: 绑定索引 + 回收「release 丢失」的判据（N21）
packages/robot-service/test/helpers/fake-redis.ts        Modify: 假 Redis 支持新键的真实语义（N21）

tools/conformance/src/slices/slice-11-robot-system.ts    Modify: 池闭环判据重写为与前置状态无关（R250/R243）
tools/conformance/src/slices/slice-07.2-deploy.ts        Modify: 非 /api 404 信封（N14/N12）—— 与既有 prod 步骤并列
tools/conformance/src/slices/slice-07.2-hardening.ts     Modify: N15 的传输层拒绝形态 + N9 的 Hash 形状（redis-cli）
tools/conformance/src/lib/redis.ts                       Create: redis-cli 读取的共享助手（若需要；否则复用 slice-07.2-rpc 的手法）
docs/design.md                                           Modify: §10.1 键表补 bot:bound:*（N21）+ §3.1/§10.3 注记（协调者）
docs/superpowers/plans/deviation-ledger.md               Modify: 逐条关闭 + §0 重算（协调者）
docs/superpowers/plans/agent-briefs.md                   Modify: 门禁实测 + 教训（协调者）
```

---

## Task 1: E2 —— `user-service` 从 `PORT` 读端口

**Files:** Modify `packages/user-service/src/main.ts`；Create `packages/user-service/test/port.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `user-service` 监听 `Number(process.env.PORT ?? 3001)`；日志里报出**实际**端口

- [ ] **Step 1: 写失败测试**（`packages/user-service/test/port.test.ts`）—— 判据是「**源文件不再硬编码**」+「**env 真的被读**」两条并列
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'src/main.ts'),
  'utf-8',
);

describe('E2：user-service 必须从 PORT 读端口（§2.3「禁止硬编码端口」）', () => {
  it('反向：源码里不得再出现 `listen(3001)` 这种字面量调用', () => {
    expect(/listen\(\s*3001\s*\)/.test(SRC), 'main.ts 仍在硬编码 listen(3001)').toBe(false);
  });
  it('正向：必须读 process.env.PORT，并以 3001 为默认值', () => {
    expect(SRC).toMatch(/process\.env\.PORT/);
    expect(SRC, 'PORT 的默认值必须是本服务的端口 3001').toMatch(/PORT\s*\?\?\s*'3001'/);
  });
  it('探针判别力：把硬编码写回去，第一条必须红', () => {
    expect(/listen\(\s*3001\s*\)/.test('  await app.listen(3001);')).toBe(true);
  });
});
```
- [ ] **Step 2: 跑测试确认失败** → `pnpm --filter @fight-the-landlord/user-service test -- port`；Expected: FAIL（`main.ts 仍在硬编码 listen(3001)`）
- [ ] **Step 3: 实现**（**与其余四个服务逐字同形**，见 `game-service/src/main.ts` 的写法）
```ts
  const port = parseInt(process.env.PORT ?? '3001');
  await app.listen(port);
  console.log(`User Service running on port ${port}`);
```
- [ ] **Step 4: 跑绿 + lint** → `pnpm --filter @fight-the-landlord/user-service test && pnpm --filter @fight-the-landlord/user-service lint`
- [ ] **Step 5: 提交**（`fix(user): 从 PORT 读端口，不再硬编码 3001（E2）`）

---

## Task 2: E6 —— `Room.timeoutAt`（§3.1）

**Files:** Modify `packages/room-service/src/rooms/rooms.service.ts`；Create `packages/room-service/src/rooms/rooms.timeout.ts`、`packages/room-service/test/rooms.timeout.test.ts`

**Interfaces:**
- Consumes: `RoomMeta`（Task 3 会把它 Hash 化，本任务先把字段加进去）
- Produces: `RoomMeta.timeoutAt: number`；`waitingTimeoutAt(now: number): number`（唯一实现）；`isWaitingExpired(room, now): boolean`

- [ ] **Step 1: 写失败测试**（`rooms.timeout.test.ts`）
```ts
import { describe, expect, it } from 'vitest';
import { WAITING_TIMEOUT_MS, waitingTimeoutAt, isWaitingExpired } from '../src/rooms/rooms.timeout';

describe('E6：§3.1 的 Room.timeoutAt（waiting 状态的超时时刻）', () => {
  it('waitingTimeoutAt = now + WAITING_TIMEOUT_MS（唯一实现，常量导出）', () => {
    expect(waitingTimeoutAt(1_000)).toBe(1_000 + WAITING_TIMEOUT_MS);
    expect(WAITING_TIMEOUT_MS).toBeGreaterThan(0);
  });
  it('只有 waiting 且已过期才算过期（playing/finished/cancelled 一律不算）', () => {
    const t = 5_000;
    const base = { timeoutAt: t } as const;
    expect(isWaitingExpired({ ...base, status: 'waiting' }, t)).toBe(true);
    expect(isWaitingExpired({ ...base, status: 'waiting' }, t - 1)).toBe(false);
    for (const status of ['playing', 'finished', 'cancelled'] as const) {
      expect(isWaitingExpired({ ...base, status }, t + 1), `${status} 不得被判过期`).toBe(false);
    }
  });
});
```
- [ ] **Step 2: 跑测试确认失败** → `Cannot find module '../src/rooms/rooms.timeout'`
- [ ] **Step 3: 实现**
```ts
// packages/room-service/src/rooms/rooms.timeout.ts
/** §3.1：`waiting` 状态的超时时刻。**唯一**的等待窗口常量（与 §8.4 的 30s 补位窗口同值，但不是同一个东西）。 */
export const WAITING_TIMEOUT_MS = 30_000;
export const waitingTimeoutAt = (now: number): number => now + WAITING_TIMEOUT_MS;
/** 只有 `waiting` 且已越过 `timeoutAt` 才算过期（终态房间永不过期）。 */
export const isWaitingExpired = (
  room: { status: string; timeoutAt: number },
  now: number,
): boolean => room.status === 'waiting' && now >= room.timeoutAt;
```
`rooms.service.ts`：`RoomMeta` 加 `timeoutAt: number`；`create()` 写 `timeoutAt: waitingTimeoutAt(Date.now())`；`updateStatus()` 里若目标状态**不再是 `waiting`**，把 `timeoutAt` 置为 `0`（表示「窗口已关闭」，避免留一个过期时刻误导读侧）。
- [ ] **Step 4: 跑绿 + lint**
- [ ] **Step 5: 提交**（`feat(room): Room.timeoutAt（§3.1）+ waiting 超时时刻的唯一实现（E6）`）

---

## Task 3: N9 —— `room:{code}` 改为 **Hash**（§10.1）+ 一并落 `timeoutAt`

**Files:** Modify `packages/room-service/src/rooms/rooms.service.ts`、`packages/room-service/test/rooms.service.test.ts`

**Interfaces:**
- Consumes: `waitingTimeoutAt` / `isWaitingExpired`（Task 2）
- Produces: `room:{code}` 是 **Hash**，字段**恰好** `code`/`mode`/`baseScore`/`status`/`maxPlayers`/`createdAt`/`timeoutAt`，TTL **3600s**；`RoomMeta` 对外形状不变

- [ ] **Step 1: 写失败测试**（改 `rooms.service.test.ts`）
```ts
it('N9：room:{code} 必须是 Hash（§10.1），字段恰好 7 个，且每个都是字符串', async () => {
  const created = await service.create({ mode: 'random' });
  const key = `room:${created.code}`;
  // 反向：它不得再是 String(JSON)
  expect(redis.strings.has(key), 'room:{code} 仍是 String —— §10.1 要求 Hash').toBe(false);
  const hash = redis.hashes.get(key)!;
  expect(hash, 'room:{code} 不是 Hash').toBeDefined();
  expect(Object.keys(hash).sort()).toEqual(
    ['baseScore', 'code', 'createdAt', 'maxPlayers', 'mode', 'status', 'timeoutAt'].sort(),
  );
  for (const [f, v] of Object.entries(hash)) expect(typeof v, `${f} 必须是字符串`).toBe('string');
  // TTL 不能因为改成 Hash 而丢
  expect(await redis.ttl(key)).toBeGreaterThan(0);
});

it('N9/E6：读回时类型必须还原（Number 字段不得变字符串）', async () => {
  const created = await service.create({ mode: 'random' });
  const room = await service.findOne(created.code);
  expect(typeof room!.baseScore).toBe('number');
  expect(typeof room!.maxPlayers).toBe('number');
  expect(typeof room!.createdAt).toBe('number');
  expect(typeof room!.timeoutAt).toBe('number');
  expect(room!.timeoutAt).toBeGreaterThan(room!.createdAt);
});

it('N9：findAll 仍能列出房间（SCAN 的派生键排除逻辑不受 Hash 化影响）', async () => {
  await service.create({ mode: 'random' });
  const all = await service.findAll();
  expect(all).toHaveLength(1);
});
```
- [ ] **Step 2: 跑测试确认失败** → 第一条在 `room:{code} 仍是 String` 上红（RED 原文里能看到 `strings.has(key) === true`）
- [ ] **Step 3: 实现**（`readMeta` / `writeMeta` 两个**私有**方法集中改；`findOne`/`findAll`/`updateStatus` 都走它们）
```ts
  /** §10.1：`room:{code}` 是 Hash。字段与此处的读写**必须**是同一张表。 */
  private static readonly META_FIELDS = [
    'code', 'mode', 'baseScore', 'maxPlayers', 'status', 'createdAt', 'timeoutAt',
  ] as const;

  private async readMeta(code: string): Promise<RoomMeta | null> {
    const flat = await this.redis.hgetall(`room:${code}`);
    if (!flat || Object.keys(flat).length === 0) return null;
    return {
      code: flat.code,
      mode: flat.mode as RoomMode,
      baseScore: Number(flat.baseScore),
      maxPlayers: Number(flat.maxPlayers) as 3,
      status: flat.status as RoomStatus,
      createdAt: Number(flat.createdAt),
      timeoutAt: Number(flat.timeoutAt),
    };
  }

  private async writeMeta(meta: RoomMeta): Promise<void> {
    const key = `room:${meta.code}`;
    // ⚠️ 一次 HSET 全字段（不做读-改-写）；随后**必须**补 EXPIRE（Hash 不会继承任何 TTL）
    await this.redis.hset(key, {
      code: meta.code, mode: meta.mode, baseScore: String(meta.baseScore),
      maxPlayers: String(meta.maxPlayers), status: meta.status,
      createdAt: String(meta.createdAt), timeoutAt: String(meta.timeoutAt),
    });
    await this.redis.expire(key, ROOM_TTL_SECONDS);
  }
```
⚠️ `maxPlayers` 的类型是字面量 `3`（§3.1）⇒ 从 Hash 读回时是 `number`，需要一次 `as 3` 收窄（**不要**把 `RoomMeta.maxPlayers` 放宽成 `number`，那会动契约）。
⚠️ 那处 `JSON.parse(redis.strings.get(...))` 的旧断言**改成** Hash 形状断言（就是 Step 1 的第一条）。
- [ ] **Step 4: 跑绿 + lint**（`rooms.service.test.ts` 全绿；`room-service` 其余用例不得回归）
- [ ] **Step 5: 提交**（`refactor(room): room:{code} 改为 Hash（§10.1）并落 timeoutAt（N9/E6）`）

---

## Task 4: E7 —— 关 `synchronize` + 显式 initial migration + `migrationsRun`

**Files:** Modify `packages/user-service/src/app.module.ts`、`package.json`；Create `src/data-source.ts`、`src/migrations/<ts>-InitialUsers.ts`、`test/migration.test.ts`

**Interfaces:**
- Consumes: `users` 实体（既有）
- Produces: `synchronize: false`；`migrations` + `migrationsRun: true`；`data-source.ts` 导出 `AppDataSource`（CLI 用）；`users` 表在新库上由迁移创建

- [ ] **Step 1: 写失败测试**（`test/migration.test.ts`）—— **不许**只断言配置项，必须证明「关了仍可用」
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_MODULE = readFileSync(join(ROOT, 'src/app.module.ts'), 'utf-8');

describe('E7：§10.3 —— synchronize 仅限开发，改用显式迁移', () => {
  it('反向：不得再有 synchronize: true', () => {
    expect(/synchronize\s*:\s*true/.test(APP_MODULE), 'app.module.ts 仍开着 synchronize: true').toBe(false);
  });
  it('正向：必须 synchronize:false + migrations + migrationsRun（用户裁决 R248）', () => {
    expect(APP_MODULE).toMatch(/synchronize\s*:\s*false/);
    expect(APP_MODULE).toMatch(/migrations\s*:/);
    expect(APP_MODULE).toMatch(/migrationsRun\s*:\s*true/);
  });
  it('正向：必须有一份 initial migration，且与现有 users 表的列集合一致', async () => {
    const { InitialUsers } = await import('../src/migrations/InitialUsers');
    const sql = (InitialUsers.prototype.up as (q: unknown) => Promise<void>).toString();
    for (const col of ['id', 'phone', 'passwordHash', 'nickname', 'avatar', 'status', 'createdAt']) {
      expect(sql, `migration 里没有列 ${col}`).toContain(col);
    }
    expect(InitialUsers).toBeDefined();
  });
});
```
- [ ] **Step 2: 跑测试确认失败** → 第一条红（`仍开着 synchronize: true`）
- [ ] **Step 3: 实现**
  - `data-source.ts`：导出 `AppDataSource`（读与 `app.module.ts` **同一组** env，`entities: [...]`、`migrations: [...]`）；CLI 脚本用它。
  - `InitialUsers`：`CREATE TABLE users (...)` —— 列定义**逐字对齐实测的现有表**（见下方门禁块里的 `SHOW COLUMNS` 原文）；**必须** `CREATE TABLE IF NOT EXISTS`（现有库里表已存在，首跑只写 `migrations` 表）。
  - `app.module.ts`：
```ts
      synchronize: false,
      migrations: [join(__dirname, 'migrations/*.js')],
      migrationsRun: true,   // 用户裁决 R248：启动时自动跑（开发形态零操作负担、不漂移）
```
  - `package.json`：`"migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/data-source.ts"`、`"migration:run": "typeorm-ts-node-commonjs migration:run -d src/data-source.ts"`（若 CLI 不可用，退化为「手写迁移 + 用 `AppDataSource.runMigrations()` 的脚本」，并记执行期裁决）。
- [ ] **Step 4: 跑绿 + lint** + **真容器验证**（`docker compose restart user-service` 后 healthy 且 `users` 表仍在）
- [ ] **Step 5: 提交**（`feat(user): 关闭 synchronize + 显式 initial migration + 启动时自动迁移（E7, R248）`）

---

## Task 5: N12 —— 未知路由返回 §11.1 信封

**Files:** Create `packages/api-gateway/src/http/not-found.filter.ts`、`test/not-found.filter.test.ts`；Modify `src/main.ts`

**Interfaces:**
- Consumes: `ErrCode.BAD_PARAM`（R244）
- Produces: 网关**自身**的 404 ⇒ `{ code: 10001, message, data: null }`；**其余状态码信封一字不改**

- [ ] **Step 1: 写失败测试**
```ts
it('未知路由 → 404 + §11.1 信封（code 10001，R244）', async () => {
  const res = await request(app.getHttpServer()).get('/definitely-not-a-route');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ code: 10001, message: expect.any(String), data: null });
});

it('反向：过滤器**只**拦 404 —— 业务 404 必须保留自己的码（12001）', async () => {
  // 造一条下游返回 404 + {code:12001} 的响应，断言经网关后 code 仍是 12001
  //（关键：不得把「房间不存在」改写成 10001）
});

it('反向：非 404 状态码的信封不得被改（401/429 的原状）', async () => {
  const unauth = await request(app.getHttpServer()).get('/api/rooms');
  expect(unauth.status).toBe(401);
  expect(unauth.body.code).toBe(10002);
});
```
- [ ] **Step 2: 跑测试确认失败** → 第一条拿到 Nest 默认 `{statusCode,message,error}`
- [ ] **Step 3: 实现**（`@Catch(NotFoundException)` 的全局过滤器；在 `main.ts` 里 `app.useGlobalFilters(new NotFoundEnvelopeFilter())`）
  ⚠️ 过滤器里**必须**放行「响应已经写过」的情况（`res.headersSent` ⇒ 直接 rethrow/委托默认 handler），否则会把下游代理已经写好的 404 再写一次（`ERR_HTTP_HEADERS_SENT`）。
- [ ] **Step 4: 跑绿 + 全量 gateway 单测 + lint**
- [ ] **Step 5: 提交**（`feat(gateway): 未知路由返回 §11.1 信封（N12, R244）`）

---

## Task 6: N14 —— 「非 `/api` 前缀一律 404」的机械闸

**Files:** Create `packages/api-gateway/test/no-route-outside-api.gate.test.ts`

**Interfaces:**
- Consumes: `main.ts` 的 `setGlobalPrefix('api')`（既有）
- Produces: 一条**源码机械闸** + 一条**行为闸**（见 R245 的两条并列判据）

- [ ] **Step 1: 先 `grep` 出真实命中集合再定正则与正对照**（R150 的强制动作）
```bash
grep -rn "@Controller(\|@Get(\|@Post(\|@Put(\|@Delete(\|@Patch(" packages/api-gateway/src
```
  ⇒ 预期：`@Controller()`（空前缀，**合法**）与 `@Controller('games')` 等**相对**路径（**合法**）。
  **非法**形态 = 路径**以 `/` 开头且不以 `/api` 开头**。把这三种都写进测试注释。
- [ ] **Step 2: 写失败测试**（探针必须先自证判别力）
```ts
/** 非法：显式写了以 `/` 开头、又不是 `/api` 的路径（会被注册到 `/api` 之外 ⇒ 整条绕过验签）。 */
const ILLEGAL = /@(?:Controller|Get|Post|Put|Delete|Patch)\(\s*['"`]\/(?!api(?:\/|['"`]))/;

it('判别力：非法形态被命中，合法形态不命中', () => {
  expect(ILLEGAL.test("@Get('/foo')")).toBe(true);
  expect(ILLEGAL.test("@Controller('/games')")).toBe(true);
  expect(ILLEGAL.test("@Get('games')")).toBe(false);      // 相对路径：全局前缀会补 /api
  expect(ILLEGAL.test('@Controller()')).toBe(false);       // 空前缀：合法
  expect(ILLEGAL.test("@Get('/api/rooms')")).toBe(false);  // 显式 /api：合法
});

it('反向：api-gateway/src 里不得有非 /api 的显式路径注册', () => {
  for (const f of walk(join(REPO, 'packages/api-gateway/src'))) {
    const hits = readFileSync(f, 'utf-8').split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => ILLEGAL.test(line));
    expect(hits, `${f} 有非 /api 的显式注册：${JSON.stringify(hits)}`).toEqual([]);
  }
});

it('正对照：闸真的读到了 controller 文件（否则上面那条是空测）', () => {
  const files = walk(join(REPO, 'packages/api-gateway/src'));
  const withController = files.filter((f) => readFileSync(f, 'utf-8').includes('@Controller'));
  expect(withController.length).toBeGreaterThanOrEqual(2);
});
```
  ⚠️ 路径解析**不要**用固定层数的相对路径（R179：会静默扫到主检出的旧文件 ⇒ 闸恒绿）。
- [ ] **Step 3: 跑测试确认通过**（若它**红**，就说明今天真有非法注册 ⇒ 先修产品代码再加闸，并在汇报里写明）
- [ ] **Step 4: 提交**（`test(gateway): 非 /api 显式路径注册的机械闸（N14, R245）`）

---

## Task 7: N15 —— WS 连接限额挪到 engine.io `allowRequest`

**Files:** Modify `packages/api-gateway/src/gateway/proxy.gateway.ts`；Create `packages/api-gateway/test/ws-allow-request.test.ts`

**Interfaces:**
- Consumes: `wsConnRateLimitKey` / 既有的 Redis 计数逻辑（`src/http/rate-limit.ts`）
- Produces: `allowRequest(req, callback)` —— 超限时**在传输层**拒绝（客户端拿 `connect_error`）；`handleConnection` 里那句 `rejectHandshake(RATE_LIMITED)` **删除**

- [ ] **Step 1: 写失败测试**（三件事并列，缺一不可）
```ts
it('N15：第 6 条连接拿到 connect_error，且**从未** connect；前 5 条真的 connected', async () => {
  const ok = await Promise.all([0,1,2,3,4].map(() => connectProbe()));
  expect(ok.filter((r) => r.connected).length, '前 5 条必须真的连上（正对照）').toBe(5);

  const sixth = await connectProbe();
  expect(sixth.connected, '第 6 条不得进入 connected —— 否则还是「连上即被踢」').toBe(false);
  expect(sixth.connectError, '第 6 条必须拿到 connect_error（传输层拒绝），实际看到的事件：' + JSON.stringify(sixth.events)).toBeTruthy();
  expect(sixth.events, '第 6 条**不得**出现过 connect 事件').not.toContain('connect');
});
```
- [ ] **Step 2: 跑测试确认失败** → `第 6 条不得进入 connected` 或 `不得出现过 connect 事件` 上红（旧形态：先 connect 再被踢）
- [ ] **Step 3: 实现**
  - `@WebSocketGateway({ ..., allowRequest: (req, callback) => this.allowRequest(req, callback) })`
    ⚠️ `allowRequest` 在**装饰器求值期**取到的是**实例方法**，必须用 `this` 绑定（`allowRequest: (req, cb) => this.checkAllowRequest(req, cb)`）；
  - `checkAllowRequest`：取 IP（`req.socket.remoteAddress`，与既有 `rejectHandshake` 同源）⇒
    Redis 计数（**fail closed**：Redis 故障 ⇒ `callback(null, false)`）⇒ 超限 `callback(null, false)`，否则 `callback(null, true)`；
  - 把「计数 / 拒绝」的那段逻辑抽成**一个**私有方法，**两处调用点不得各写一遍**（那是第二个真源）——
    `handleConnection` 里的旧检查**删掉**；
  - ⚠️ `allowRequest` 是**异步**的：**必须**恰好调一次 `callback`（两条路径都要覆盖，含 throw 时）；
  - ⚠️ 保留既有 `system.error{10006}` 的下发（HTTP 维度的限流仍走它；WS 维度现在由传输层拒绝，`system.error` 不再可达）——
    若某条既有断言依赖「WS 超限会收到 `system.error`」，**必须**改成新的 `connect_error`（并在汇报里单列）。
- [ ] **Step 4: 跑绿 + 全量 gateway 单测 + lint**
- [ ] **Step 5: 提交**（`feat(gateway): WS 连接限额挪到 engine.io allowRequest（N15 后端半边, R246）`）

---

## Task 8: N21 —— `bot:bound:{botId}` 索引 + 兜底回收扫得到「`release` 丢失」的机器人

**Files:** Modify `packages/robot-service/src/robot/robot.pool.ts`、`test/robot.pool.test.ts`、`test/helpers/fake-redis.ts`

**Interfaces:**
- Consumes: `bot:pool:{gameType}`（ZSET）/ `bot:{botId}`（String）/ `bot:room:{roomCode}`（Hash）（既有）
- Produces: `bot:bound:{botId}` —— String(JSON) `{ roomCode, seat, boundAt }`，TTL 3600s；`botBoundKey(botId)` 导出；`reclaimIdle()` 增加第二轮扫描

- [ ] **Step 1: 写失败测试**（三条正向 + 一条正对照）
```ts
it('N21：acquire 必须写绑定索引；release 必须删掉它（成对）', async () => {
  const { bots } = await pool.acquire({ roomCode: 'R1', seats: [1] });
  const botId = bots[0]!.botId;
  expect(await redis.get(botBoundKey(botId)), 'acquire 没写 bot:bound 索引').toBeTruthy();
  await pool.release({ botIds: [botId] });
  expect(await redis.get(botBoundKey(botId)), 'release 没清 bot:bound 索引').toBeNull();
});

it('N21：兜底回收必须扫得到「release 丢失」的绑定机器人（房间已不存在）', async () => {
  const { bots } = await pool.acquire({ roomCode: 'GONE1', seats: [1] });
  const botId = bots[0]!.botId;
  // 只让「房间键」消失（模拟 room-service 崩了、release 从未发出）
  await redis.del('room:GONE1');
  const reclaimed = await pool.reclaimIdle(Date.now() + 11 * 60_000);
  expect(reclaimed, `回收没扫到绑定的孤儿机器人 ${botId}（N21 的核心判据）—— 实际 ${JSON.stringify(reclaimed)}`).toContain(botId);
  expect(await redis.get(botBoundKey(botId))).toBeNull();
});

it('N21 正对照：房间**还在**的绑定机器人**不得**被回收（§9.6「对局中的机器人不得回收」）', async () => {
  const { bots } = await pool.acquire({ roomCode: 'ALIVE', seats: [1] });
  await redis.set('room:ALIVE', 'x');
  const reclaimed = await pool.reclaimIdle(Date.now() + 11 * 60_000);
  expect(reclaimed).not.toContain(bots[0]!.botId);
});
```
- [ ] **Step 2: 跑测试确认失败** → `acquire 没写 bot:bound 索引`（旧实现没有这个键）⇒ 第 2 条也会红（回收扫不到绑定中的机器人）
- [ ] **Step 3: 实现**
  - `export const botBoundKey = (botId: string): string => \`bot:bound:${botId}\`;`
  - `acquire` 的绑定分支：`SET bot:bound:{botId} {roomCode,seat,boundAt} EX 3600`（**与 `ZREM bot:pool` 同一段代码里成对**）；
  - `release`：`DEL bot:bound:{botId}`（**与 `ZADD bot:pool` 成对**）；
  - `reclaimIdle()` **第二轮**：`SCAN bot:bound:*` ⇒ 对每个 `{roomCode}`：
    `EXISTS room:{roomCode}` 为 0 ⇒ 回收（`DEL bot:bound:{botId}` + `DEL bot:{botId}`）；
    或 `boundAt` 早于 `now - 10min` ⇒ 同样回收（防「房间键在但服务已崩」的长期悬挂）。
    两轮都要 `logger.warn` 记原文（含 botId 与原因）；
  - ⚠️ **权威仍是 `bot:{botId}`**：`bot:bound:*` 只用于**发现**候选，判定「是否绑定」仍读 `bot:{botId}`（且与它交叉核对，不一致就按 `bot:{botId}` 走并清掉悬挂的 `bot:bound:*`）；
  - `fake-redis.ts` 必须支持 `scan` 的新 pattern 与 `set(..., 'EX', n)`（R212：**替身的宽容度就是对缺陷的容忍度** —— 先问「真实 Redis 在这里会怎样」）。
- [ ] **Step 4: 跑绿 + 全量 robot-service 单测 + lint**
- [ ] **Step 5: 提交**（`feat(robot): bot:bound 索引 + 兜底回收扫得到 release 丢失的机器人（N21, R247）`）

**后端 DoD**：`cd .worktrees/backend && pnpm exec turbo run test lint --force` 全绿（0 cached）+ `pnpm exec turbo run build --force` 10/10；汇报附**每条判据的修前 RED 原文**（尤其 N9 的 `room:{code} 仍是 String`、N15 的「第 6 条出现过 connect」、N21 的「回收没扫到」）。

---

## Task 9（conformance agent）：R243 判据重写 + N9/N12/N14/N15 的在线判据

**Files:** Modify `tools/conformance/src/slices/slice-11-robot-system.ts`、`slice-07.2-hardening.ts`、`slice-07.2-deploy.ts`；（如需）Create `tools/conformance/src/lib/redis.ts`

**Interfaces:**
- Consumes: 后端 Task 3/5/7/8 的产物；`slice-07.2-rpc` 的 `redisCli` 手法
- Produces: 与池前置状态**无关**的池闭环判据；N9 的 Hash 形状在线判据；N12/N14 的 404 信封判据；N15 的 `connect_error` 判据

- [ ] **Step 1: R250 —— 重写 `slice-11` 第 5 组的池闭环判据**
  - **删掉** `poolAfter.length - poolBefore.length === expectedDelta` 那条**相对量**等式（它与池的前置状态耦合；
    「池退化」已由 `slice-07.2-rpc` 第 2 组的**绝对**性质「每个成员都必须有记录」覆盖）；
  - **保留/强化**三条**绝对**性质：① 本局两个机器人都回到池里；② 池里没有成员缺记录；③ `bot:{botId}` 的 `roomCode`/`seat` 已清空；
  - 池计数只作 `info`，**不作断言**；顺带**消灭**那条自相矛盾的失败消息（文本说「净增 2」而断言值是 `expectedDelta`）。
- [ ] **Step 2: 顺序无关性自证（**本条的验收形态**）** —— 两种前置状态各跑一次，**都必须绿**：
```bash
# ① 池空
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11        # ✅
# ② 池非空（先让 slice-07.2-rpc 造出池成员）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc  # ✅（它会 acquire/release 一次 ⇒ 池里留下成员）
timeout 300 node tools/conformance/dist/run.js slice-11        # ✅ ← ⚠️ **R281 纠正**：这一条在修前**并不是**红的
                                                              #   （那条等式两边是同一本账 ⇒ 池静止时恒成立）。
                                                              #   它的价值是「证明重写后与前置状态无关」，不是 RED 对照。
# ③ 门禁形态（连着跑）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc && timeout 300 node tools/conformance/dist/run.js slice-11  # ✅
```
  ⚠️ **必须**取到 ② 的**修前 RED 原文**（那条等式在池非空时红）与修后 GREEN —— 否则「重写有效」没有证据。
- [ ] **Step 3: N9 的在线判据**（`slice-07.2-hardening` 或新建一组）：
  用 `redis-cli`（照抄 `slice-07.2-rpc` 第 2 组的 `spawnSync` 手法）断言
  `TYPE room:<code>` = **hash**、`HKEYS room:<code>` 字段集**恰好** 7 个、`TTL` > 0，
  且**反向**断言 `GET room:<code>` 报 WRONGTYPE（证明确实不是 String）。
  ⚠️ 房号取自一条真实的 `POST /api/rooms`（经网关），不要自己造键。
- [ ] **Step 4: N12/N14 的在线判据**：
  经网关打一组非 `/api` 路径与一条未知 `/api` 路径 ⇒ **404 + §11.1 信封**（`code === 10001`）；
  **并列**一条**反向**判据：`GET /api/rooms` 匿名 ⇒ **401 + `10002`**（证明「非 /api ⇒ 404」不是「一律 404」）。
  ⚠️ 这条与 P4 的 **R241** 是同一个坑：**不要**在不带凭证的情况下断言业务路由的 404。
- [ ] **Step 5: N15 的在线判据**：
  单 IP 连 5 条（正对照：5 条都 connected）⇒ 第 6 条必须拿到 **`connect_error`** 且**从未**出现 `connect` 事件；
  并断言前 5 条**不受影响**（仍 connected）。
  ⚠️ 网关按 **IP** 计名额、释放是**异步**的 ⇒ 用例改法与 `slice-08` 同款（**先关掉上一局的客户端并静置 400ms**），
  否则会踩到「上一个切片的 ZREM 还没落地」而假红（环境事实）。
- [ ] **Step 6: 跑（独占）**
```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-11
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary
timeout 300 node tools/conformance/dist/run.js slice-07
```
- [ ] **Step 7: 交接**：附每条新判据的**修前 RED 原文** + R243 的「两种前置状态都绿」证据。

**conformance DoD**：上面 6 条切片全绿 + R243 的**顺序无关性**证据（① 池空绿、② 池非空绿、③ 连着跑绿）+ 每条新判据的修前 RED 原文。

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
# R243 之后这条**不应再是必要条件**（判据已与池前置状态无关）—— 但保留作廉价保险
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项（R243 重写后）
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 60+ 项（N9/N12/N15）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 28+ 项（N14 非 /api 404）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（房间数参与计数，只看尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0

# R243 的顺序无关性（**门禁的一部分**，不是可选）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11                                  # ✅ 池空
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc >/dev/null && \
  timeout 300 node tools/conformance/dist/run.js slice-11                                # ✅ 池非空（R281：修前此处**也**是绿的，见下）

# E7：关掉 synchronize 之后，服务**仍然**起得来、表**仍然**在（R248 的核心验收）
docker compose restart user-service && sleep 15
docker compose ps user-service --format '{{.Status}}'                # ✅ healthy
docker compose exec -T mysql mysql -uroot -proot -N -e \
  "SHOW COLUMNS FROM fight_the_landlord.users;" 2>/dev/null | wc -l  # ✅ 7（表与列都还在）

# N21：绑定索引键真的存在过（跑一局之后）
docker compose exec -T redis redis-cli --scan --pattern 'bot:bound:*'   # 观测用（对局中才有；局终应清空）

# 生产形态自检（R98 不回归）
docker compose --env-file /dev/null -f docker-compose.yml config --format json \
  | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(Object.keys(c.services).length)'
```

**收口（协调者）**：
1. `docs/design.md` **§10.1 键表**补 `bot:bound:{botId}` 行（写清它是 `bot:{botId}` 的**反向视图**、权威是 `bot:{botId}`，照 `bot:room:*` 的写法）；§3.1 与 §10.3 的 `[偏差]` 注记按 §A.3 流程改写；
2. `deviation-ledger.md`：**E2 / E6 / E7 / N9 / N12 / N14 / N15 / N21** 逐条改「已关闭」（写清关闭者 commit 与证据）+ §2 的 P3 小节改写 + **R243 从待办移入已关闭** + §0 用 `node scripts/ledger-counts.mjs` 重算；
3. `agent-briefs.md`：追加 P3 的门禁实测块 + 通用教训；更新「交接现状」与「剩余工作」；
4. 本计划文件追加「门禁实测」块。

---

## Self-Review

**Spec coverage**

| 规格 | 落在哪个 Task |
|---|---|
| §2.3「禁止硬编码端口」（E2） | Task 1 |
| §3.1 `Room.timeoutAt`（E6） | Task 2 + Task 3（一起落进 Hash） |
| §10.1 `room:{code}` 是 Hash（N9） | Task 3 |
| §10.3 `synchronize` 仅限开发 + 显式迁移（E7） | Task 4（R248：`migrationsRun: true`） |
| §11.1 统一信封（N12） | Task 5（R244：`10001`，只拦 404） |
| §7.1 `/api` 之外一律 404（N14） | Task 6（R245：源码闸 + 行为闸） |
| §5.4 单 IP 并发 WS 5（N15 后端半边） | Task 7（R246：`allowRequest` ⇒ `connect_error`） |
| §9.6 兜底回收扫得到「`release` 丢失」（N21） | Task 8（R247：`bot:bound:{botId}` + 第二轮扫描） |
| R243（池闭环判据与前置状态无关） | Task 9 Step 1–2（R250） |
| §10.1 键表同步（N21 的新键） | 收口第 1 条（协调者） |

**Placeholder scan**：无 TBD / 「稍后补」。Task 4 的 `migration:generate` 留了「CLI 不可用 ⇒ 手写迁移 + `runMigrations()`」的**已知退路**（执行期择一并记裁决），不是占位符。

**Type consistency**：`RoomMeta` 在 Task 2 加 `timeoutAt`、Task 3 换成 Hash 读写（**同一张字段表** `META_FIELDS`）；`waitingTimeoutAt`/`isWaitingExpired` 在 Task 2 定义、Task 3 消费；`botBoundKey` 在 Task 8 定义并导出（Task 8 的测试与 conformance 都可能用它）；`NotFoundEnvelopeFilter` 只在 Task 5 出现（全局过滤器，无跨任务签名）。

**⚠️ 本片的三个高风险点（执行时优先验证）**
1. **E7 可能让 user-service 起不来**：`migrationsRun: true` + `CREATE TABLE IF NOT EXISTS` 是保险；**先**在容器里验证再谈绿。
2. **N15 会改一条既有断言的形态**：任何依赖「WS 超限 ⇒ `system.error{10006}`」的用例都要改成 `connect_error`（`slice-07.2-hardening` 第 8 步最可能受影响）—— 这是**判据形态随实现变化**，必须在汇报里单列（R152 的记录也要一并更新）。
3. **N9 的 TTL**：Hash 化最容易丢的就是 `EXPIRE`（String 的 `SET EX` 是一次性的，Hash 必须**显式**补）⇒ Task 3 的判据里有 `ttl > 0` 一条。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：**后端 agent 用 R260–R279、conformance agent 用 R280–R299**，说明「计划怎么写 / 事实是什么 / 怎么改的」。）

<!-- 合并冲突已在收口时解决：两个 agent 都往同一回填区追加，**两块都保留**（按 Task 顺序：后端 → conformance → 协调者）。 -->

### R260（后端 agent）N14 行为闸的路径清单含 `/api`，与实测不符

- **计划怎么写**：R245 与 Task 6 Step 1 要求对「一组非 `/api` 路径（`/`、`/index.html`、
  `/games`、`/api`、`/apix`、`//api/rooms`）」断言 **404 且响应体是 §11.1 信封**。
- **事实是什么**（本片用真 Nest 应用 + 真全局前缀实测，Nest 10.4.22）：
  ```
  GET /            -> 404 + 10001   验签中间件 mwCalls=0
  GET /index.html  -> 404 + 10001   mwCalls=0
  GET /games       -> 404 + 10001   mwCalls=0
  GET /apix        -> 404 + 10001   mwCalls=0
  GET //api/rooms  -> 404 + 10001   mwCalls=0
  GET /api         -> 401 + 10002   mwCalls=1   ← 与计划不符
  ```
  `/api` **就是那个前缀**：`RouteInfoPathExtractor` 为通配符产出 `[prefix + '$', prefix + '/*']`，
  `/api$` 这条中间件路径**恰好**匹配 `/api` 本身 ⇒ 它**经过**验签（匿名 ⇒ 401；带凭证才是
  404 + 10001）。它不是「`/api` 之外的注册」那条通道，因此**不**属于「必须 404」的集合。
- **怎么改的**：行为闸的「必须 404 且 mwCalls===0」集合取 `['/', '/index.html', '/games',
  '/apix', '//api/rooms']`；`/api` 单列一条判据（匿名 401 + mwCalls===1、带凭证 404 + 信封），
  并在测试注释里写明原因。`@Controller()` / `@Controller('health')` / 相对路径 / 显式 `/api`
  都是**合法**形态，闸只钉「显式 `/` 开头且不以 `/api` 开头」。

### R261（后端 agent）E7 的 CLI 形态：本仓没有 ts-node

- **计划怎么写**：Task 4 Step 3 写 `"migration:run": "typeorm-ts-node-commonjs migration:run -d src/data-source.ts"`。
- **事实是什么**：`typeorm-ts-node-commonjs` 这个 bin **存在**（typeorm 自带），但它要
  `require('ts-node')`，而本仓**没有** ts-node（`node_modules/.pnpm` 里 0 命中）；
  装它要新增 devDependency ⇒ 会动 `pnpm-lock.yaml`（本片 Global Constraint 明令禁止）。
- **怎么改的**：脚本指向**编译产物**（`typeorm migration:run -d dist/data-source.js`，
  用 typeorm 自带的 `typeorm` bin，不需要 ts-node），并在 `data-source.ts` 的类注释里写明
  「先 `pnpm build`」。`migration:generate` 同理（输出路径写 `src/migrations/Generated`）。

### R262（后端 agent）R247 的 `boundAt` 单独触发回收与 §9.6 冲突

- **计划怎么写**：R247 写「`boundAt` 超过 **10 分钟**同样纳入候选（防「房间键还在但服务已崩」
  的长期悬挂）」；而 Task 8 Step 1 的**正对照**用例又要求在「房间**还在** + now 推过 11 分钟」
  时**不得**回收。
- **事实是什么**：两条要求**互相矛盾**，且与 §9.6 逐字冲突 —— §9.6 写「**对局中的机器人不得
  回收**」，而 `room:{code}` 存在恰恰意味着对局**可能**仍在进行（一局可以打很久，
  `boundAt > 10min` 完全正常）。计划自己的正对照用例（房间还在 + 11 分钟 ⇒ 不回收）只能
  在「房间不存在才回收」这一种实现下通过。
- **怎么改的**：**取 §9.6**。第二轮的回收判据**只有**「`room:{authorityRoom}` 不存在」；
  `boundAt` 只用于 ① 日志（绑得过久 + 房间仍在 ⇒ `logger.warn`，不回收）与
  ② 与权威交叉核对时的陈旧性说明。正对照用例改为断言「不回收且视图保留」。

### R263（后端 agent）N9 的爆炸半径比计划写的大

- **计划怎么写**：R249 与 Task 3 写「测试里只有 `rooms.service.test.ts:99` 一条直接
  `JSON.parse(redis.strings.get(...))`」。
- **事实是什么**：同一文件里有**四条**（32 / 41 / 99 / 123 行）直接读 `redis.strings.get('room:…')`
  并 `JSON.parse`；另外 `join` 用例里的 `expect(redis.hset).not.toHaveBeenCalled()`（56 行）
  在元数据 Hash 化之后**必然假红** —— `create()` 本来就会 `HSET room:{code}`。
- **怎么改的**：四条全部改成 Hash 形状断言；`hset` 那条改成**按键**过滤
  （`hset.mock.calls.filter(([key]) => key === seatsKey('JOIN01'))`），断言的是「**座位键**只允许
  `HSETNX`」这条真正的契约（而不是「hset 一次都没被调用」这个实现细节）。

### R264（后端 agent）E7 的判据不钉实现形态

- **计划怎么写**：Task 4 Step 1 的用例对 `app.module.ts` 的**源码文本**做正则
  （`synchronize: false` / `migrations:` / `migrationsRun: true`）。
- **事实是什么**：那是「钉实现形态」（本仓 P4 的教训）；而且连接/迁移选项写在
  `app.module.ts` 里会让 `data-source.ts`（CLI）**再写一份** ⇒ 第二真源，两处漂移时
  单侧测试测不出来。
- **怎么改的**：选项集中到 `src/database.config.ts`（`userDatabaseOptions()` 给运行期、
  `userDataSourceOptions()` 给 CLI，**同一份** mysql 选项），`app.module.ts` 只做一行装配；
  判据改成四层：① 断言**有效选项**（`synchronize===false`、`migrationsRun===true`、
  `migrations` 指向 `migrations/*.js`）；② **扫全 `packages/user-service/src/**`** 的机械负向闸
  （不得出现 `synchronize: true`，且**先剥注释** —— 否则文件里引用 §10.3 原文就会假红）；
  ③ 迁移 SQL 的**完整列定义**（对齐 `SHOW CREATE TABLE` 实测读数）；④ 容器级验证
  （重启后 healthy + `users` 表 7 列，见本片汇报）。

### R265（后端 agent）N15 让 6 条既有断言必须改形态

- **计划怎么写**：Task 7 Step 3 的 ⚠️ 提示「若某条既有断言依赖『WS 超限会收到 `system.error`』，
  必须改成新的 `connect_error`」。
- **事实是什么**：`packages/api-gateway/test/proxy.gateway.test.ts` 的 **R141 组 6 条**
  全部以 `handleConnection` 为入口（旧检查点的位置）：第 6 条被拒 10006 / 存储故障 10007 /
  名额按 IP 记账 / `handshake.address` 缺失降级 / disconnect 释放 / heartbeat 续期。
  另外「超限 ⇒ `system.error{10006}`」这条**形态本身**必须消失（新形态是客户端
  `connect_error`，服务端不再有那个事件）。
- **怎么改的**：入口换成 `gateway['checkAllowRequest'](req, cb)`（engine.io 真正调的那一处），
  判据一条没少（含新增：「**恰好**回调一次」三条路径、「超限不记账」、「限额判定只有一处 ——
  `handleConnection` 不再判、也不再发 10006」）；`handleConnection` 相关的两条
  （disconnect 释放 / heartbeat 续期）改成「先 `checkAllowRequest(req)`、再把**同一个** `req`
  交给 `handleConnection`」的两步形态（与生产的真实调用顺序一致）。

### R266（后端 agent）N15 的 IP 来源与「释放侧不重新推导 IP」

- **计划怎么写**：Task 7 Step 3 写「取 IP（`req.socket.remoteAddress`，与既有 `rejectHandshake` 同源）」。
- **事实是什么**：两处 IP 来源**并不逐字相同** —— `handleConnection` 里的 `handshake.address`
  在 websocket 传输下取 `req.websocket._socket.remoteAddress`，polling 下取
  `req.connection.remoteAddress`；而 `allowRequest` 的 `req` 上**还没有** `websocket` 字段
  （engine.io 在 `onWebSocket` 里才 `req.websocket = websocket`）。两者都指向同一个底层
  net.Socket（实测同值），但「两处各推导一次」本身就是名额泄漏的温床。
- **怎么改的**：`allowRequest` 里把 `{ ip, member }` **一起**挂到请求对象上
  （`attachWsConnSlot`），`disconnect` / heartbeat 续期都用 `wsConnSlotOf(client)` 取回同一份
  —— 两处**不可能**用不同的键或不同的 member。`clientIp(client)`（旧实现）随之删除，
  单测里 `handshake.address` 的降级用例改成 `req.socket.remoteAddress` 缺失。

### conformance agent（Task 9）—— 2026-09-16 实测回填

- **R280 N12/N14 的「非 `/api` 路径」清单与实测不符：裸 `/api` 是 **401**，不是 404。**
  - **计划怎么写**：R245 的行为闸要求对 `/`、`/index.html`、`/games`、`/api`、`/apix`、`//api/rooms`
    断言「**404** 且响应体是 §11.1 信封（`code === 10001`）」。
  - **事实是什么**（主检出、master、实测）：
    ```
    匿名 GET /            → 404（Nest 默认体，无 code）
    匿名 GET /index.html  → 404
    匿名 GET /games       → 404
    匿名 GET /apix        → 404
    匿名 GET /api         → 401 {"code":10002,"message":"Missing or invalid Authorization header","data":null}
    匿名 GET //api/rooms  → 404
    ```
    `JwtMiddleware` 经 `consumer.apply(...).forRoutes('*')` + `setGlobalPrefix('api')` **确实匹配裸 `/api`**
    ⇒ 把它列进「404 名单」会让判据在**正确的实现**上假红。
  - **怎么改的**：404 名单取 `/`、`/index.html`、`/games`、`/apix`、`//api/rooms`（实测全部 404、
    且**都不经过**中间件 —— 这正是 N14 的实质）；未知 `/api` 路径改成**带 token** 断言 404 + 10001
    （不带 token 拿到的是中间件的 401 —— R241 的坑）；**反向**判据保留「匿名 `GET /api/rooms` = 401 + 10002」，
    并加一条**正对照**「带 token `GET /api/rooms` = 200 + `code 0`」（证明网关活着、路由真的存在，
    而不是「全站 404」）。落在 `tools/conformance/src/slices/slice-07.2-deploy.ts` 第 ④ 步（id `n14`）。

- **R281 R250 的前置状态前提在今天的 master 上不成立：池非空**单独**不会红；RED 的必要条件是「窗口内有第三方写入池」。**
  - **计划怎么写**：Task 9 Step 2 —— 「先跑 `slice-07.2-rpc` 造出池成员 ⇒ 修前的 `slice-11` **在这一条上是红的**」。
  - **事实是什么**（修前 `dist`，2026-09-16 实测）：
    ① `DEL bot:pool:ddz` ⇒ `slice-11` ✅ **44 项**（池 0→2）；
    ② `slice-07.2-rpc` ✅ ⇒ `slice-11` **也 ✅**（现场 `ZCARD` **4 → 4**：本局复用 2 个、新建 0 个，
    等式两边都是 0）。
    原因：那条等式的两边是**同一本账**（「复用 k 个 + 新建 2−k 个」）⇒ 只要池是**静止**的，它必然自洽，
    **与 `poolBefore` 是否为空无关**。历史 RED（R243 原文 `净增 1（…其中 1 个…复用了）= 1 → 3：期望 1，实际 2`）
    的必要条件是**窗口内有第三方写入池**：`releaseRobots()` 是 `void` 异步的、`reclaimIdle()` 每 60s 一趟、
    手工 `DEL bot:pool:ddz` 与晚到的 `release` 之间有竞态。robot-service 日志实测到这种**跨运行**的晚到 release：
    ```
    [RobotPool] Released bot bot-af3a2d58 back to the pool (idleSince=…852625)
    [RobotPool] Released bot bot-4fe793ac back to the pool (idleSince=…852626)
    ```
    （它们落在两次运行之间，把 `ZCARD` 从 2 抬到 4 ⇒ 下一次 `slice-11` 读到的 `poolBefore` 不是上一次的读数。）
  - **怎么改的**：判据仍按 R250 **删掉那条等式**（它实际断言的是「没有别人动过池」）；RED 证据改用
    **受控复现**（复现的是同一个机制）：池里只留 1 个空闲成员（= rpc 留下的那个），并在本局进入 `playing`
    之后注入 1 个「外部 release」（`ZADD` + **带记录**，与真实 release 同形）⇒ 修前逐字复现历史消息
    `❌ §9.6 池闭环：…净增 1（本局 2 个机器人 − 其中 1 个开局前本就空闲、复用了）= 1 → 3（…）：期望 1，实际 2`，
    修后**同一前置状态** ✅ **46 项**。顺序无关性证据：池空 ✅（`ZCARD 0 → 2`）、池非空 ✅（`ZCARD 2 → 2`，复用 2 个）。

- **R282 N15 的判据形态必须随实现变（旧的 `kicked` 断言在新实现上必红），且判别力自证的载体要换。**
  - **计划怎么写**：R246 要求三条并列（① 第 6 条拿到 `connect_error`；② 它**从未** `connect`；③ 前 5 条**真的** connected）；
    Task 9 ④ 另要求写明「`slice-07.2-hardening` 第 8 步今天断言的是旧形态」。
  - **事实是什么**（修前实现实测）：`第 6 条连接（静置 2000ms）：静置后 connected=false，sawConnect=true，
    sawConnectError=false，kicked=true` —— 旧断言（`sixth.kicked` + `!connected`）**通过**，而本片要求的
    传输层判据**红在第 1 条**（这正是要换掉的形态）。
    另：判别力自证**不能**用「连一个不存在的端口」—— 本机 `127.0.0.1` 上未监听端口的 SYN 被**丢弃**
    （不是 RST，R229 同族）⇒ 实测 2.5s 内**零事件**（连接挂住＝空测）。实测改用**故意用错的 socket.io path**
    （`/definitely-not-socketio/`）⇒ 立刻 `connect_error: websocket error`，且该路径**不经过** socket.io 服务器
    （它只挂在 `/socket.io/`）⇒ 既不占连接名额、也不污染 R147 的桶。
  - **怎么改的**：第 8 步三条并列（`sawConnectError` / `!sawConnect` / 第 6 条被拒后前 5 条仍 connected）；
    自证换成上面的错误 path；无效 token 的自证从「`sawConnect && kicked && !connected`」**放宽为**
    「静置后 `!connected`」（**形态无关** —— 验签将来若也挪进 `allowRequest` 不该假红，R115/R241），
    并移到「第 6 条」与「释放名额」两步之后（那时桶里只有 4 个 member，该连接能越过 `allowRequest` 落到验签阶段）。
  - ⚠️ **这是判据形态随实现变化，不是放宽**：`sawConnectError` 与 `sawConnect` 各自单独断言，比原来那个
    把两件事混成一个布尔的 `kicked || error` 更严；「限额生效」仍被三条钉住（前 5 条活、第 6 条被拒、
    关掉 2 条后新连接能进）。**代价**：本判据自此**硬依赖**后端 Task 7（R246）**已合并** ——
    后端未合并前 `slice-07.2-hardening` 必然红在该条（这是预期的 RED，不是回归）。

- **R283（环境事实）conformance 在本次执行期**没有**独占：robot-service 日志里出现了非本 agent 发起的
  机器人补位局（`O317F1`/`T1EOSZ`/`T7MUUX`/`6MVBGB`），且它们的 `release` 与我的运行交错落地。**
  - 影响：`slice-11` 第 5 组读到的 `poolBefore/poolAfter` 会被这些**并发**写入污染 —— 这正是 R281 里
    「历史 RED 需要第三方写入」在今天的复现源。**判据本身已经与前置状态无关，因此照常绿**；
    但这再次证明「相对量池判据」在这个仓库里**不可能**稳定。
  - 处置建议（留给协调者）：门禁仍按原规矩**独占**跑；若要排查池相关红色，先看 robot-service 日志里
    有没有不属于本次运行的 `Acquired/Released` 行。


### R251（协调者）**接受 R281，并纠正本计划自身的一处错误前提** —— 那条等式的失效机制不是「池非空」

- **我（协调者）在计划里写的**（R243 / Task 9 Step 2 / 门禁块）：「`slice-11` 第 5 组的池闭环判据写死了
  **全新栈**前提 ⇒ `slice-07.2-rpc` 排在它前面并留下**可复用**机器人 ⇒ 判据红」。
- **事实是什么**（conformance agent 实测 + 我**独立复核**）：**这个前提是错的**。
  修前 `dist` 上 ① 池空 ⇒ ✅；② `slice-07.2-rpc` → `slice-11` ⇒ **也 ✅**。
  我复核的现场：`slice-07.2-rpc` 之后 `ZCARD=1`，紧接着 `slice-11` **通过 46 项**。
  真正的机制（R281）：那条等式的两边是**同一本账**（复用 k + 新建 2−k）⇒ **池静止时它恒成立**；
  它实际断言的是「**在我这一局的时间窗内没有第三方动过池**」。历史 RED 的必要条件是
  `releaseRobots()` 是 `void` 异步、`reclaimIdle()` 每 60s 一趟、以及跨运行的晚到 `release`。
- **结论**：**结论不变**（那条**相对量**等式必须删 —— 它测的是「没有并发」，不是任何规格性质），
  但**理由要按事实改写**：不是「池非空会红」，而是「**它把并发噪声当缺陷**」。
  ⚠️ 这正是本项目反复出现的那一类错误：**我用一个听起来合理但未经验证的机制解释了一次观测**，
  而正确的做法是像 conformance agent 那样**在修前 dist 上把两种前置状态各跑一次**再下结论。
  计划里那两处措辞已就地改正（Task 9 Step 2 与门禁块），**不隐去历史**（本条即记录）。
- **RED 证据形态**：接受「**受控复现同一机制**」（池留 1 个空闲成员 + 本局 `playing` 后注入 1 个与真实
  `release` 同形的外部写入）⇒ 逐字复现历史消息。这与本仓既有的「变异探针」是同一标准
  （**判据的判别力必须被主动证明**，而不是等它自己红）。

### R252（协调者）接受 R280 与 R282；**合并顺序固定为「先后端、后 conformance」**

- **R280（裸 `/api` 不入 404 名单）接受**：`forRoutes('*')` 被 `setGlobalPrefix('api')` 展开成
  `['api$', 'api/*']`（`main.ts` 的既有注释即此）⇒ **裸 `/api` 是被中间件覆盖的**，匿名得 **401**。
  它不是 N14 语义下的「`/api` 之外的注册」。改用实测 404 的 `//api/rooms` 是对的。
- **R282（N15 判据形态随实现变）接受**：旧 `kicked` 布尔在新实现上必红；新三条并列**更严**
  （把「拿到了 connect_error」与「从未 connect」拆成两个独立观测通道，而不是混成一个布尔）。
- **合并顺序的连带约束（我必须自己守）**：conformance 的 `ws`/`n9`/`n14` 三条判据**硬依赖**后端 Task 3/5/7。
  conformance 已直接提交到 **master**，因此**当前 master 是红的**（这三步）。
  ⇒ **必须先把 `feat/backend` 合进 master，再跑门禁**；在合并之前看到的这三条红是**预期 RED，不是回归**，
  不得据此回退 conformance 的改动。

### R253（协调者）登记一处**同族、本片不修**的相对量判据

- `slice-11` **第 6 组**（幂等 acquire）有一条「两次 acquire 之间 `ZCARD` **不净增**」的相对量断言 ——
  与 R250/R281 同族：窗口内若有第三方 `release`，它会假红。conformance agent 正确地**没有顺手改**
  （超出本片范围）。
- **处置**：**登记**，不在本片修。它与 P4 登记的 **R243** 是同一族（「相对量池判据在本仓库不可能稳定」），
  收口时一并写进对账表 §2 的待办，交给下一片把 `slice-11` 的池判据**整体**收敛成绝对性质。
- ⚠️ 这也解释了为什么本片的池判据问题**反复出现**：只要仓库里同时存在「相对量池判据」与
  「多进程/多运行共享同一个 Redis」，它们就会互相制造假红。**根治办法是消灭相对量判据**，而不是逐个修。


### R254（协调者）**接受 R260–R266，并第二次纠正本计划自身的错误** —— R247 的 `boundAt` 语义被 §9.6 否决

- **R262 接受，且这是我（协调者）写错的第二条裁决。** §9.6 逐字是：
  「`robot-service` 的定期任务回收 **`idleSince` 超过 10 分钟 _且_ `roomCode` 指向的房间已不存在**的机器人」
  —— 一个**合取**；紧接着一句「**对局中机器人不得被回收**」。
  我在 R247 里加的「`boundAt` 超过 10 分钟**或**……」把合取改成了**析取**，
  会把**正在打的一局**里的机器人回收掉（一局超过 10 分钟完全正常）。
  ⇒ **取 §9.6 与后端 agent 的实现**：第二轮的回收判据**只有**「房间不存在」；`boundAt` 只做日志与陈旧性核对。
  ⚠️ **同一片里我第二次犯同一类错**（第一次是 R251 的池等式机制）：**写下了一个听起来合理、
  但没有回到规格逐字、也没有实测的机制**。两次都是 agent 用「§9.6 原文 / 修前 dist 上实跑」把我顶回来的 ——
  这正是本项目要求 agent「有据就顶」的价值所在。R247 的原文已就地标注取代，**不隐去历史**。
- **R260 接受**（`/api` 是前缀本身、被 `['api$','api/*']` 覆盖 ⇒ 匿名 **401**，不是 N14 语义下的「`/api` 之外」）。
  值得记一笔：**后端 agent 与 conformance agent 独立地、以不同方式（行为闸 / 在线判据）发现了同一件事**，
  并各自从自己的清单里剔掉了裸 `/api` —— 两边结论一致，这是判据互证的好信号（不是重复劳动）。
- **R261 / R263 / R264 / R265 / R266 接受**：
  R261（本仓无 ts-node ⇒ CLI 指向 `dist/data-source.js`，**未动 `pnpm-lock.yaml`**）；
  R263（N9 的爆炸半径是 **4** 条 `strings.get` 而非我写的 1 条 —— 我低估了）；
  R264（E7 判据不钉实现形态）；R265（N15 让 6 条既有断言改成以 `checkAllowRequest` 为入口，
  并新增「限额判定只有一处」的结构判据 —— 这是**形态随实现变化**，不是放宽）；
  R266（限额名额挂请求对象，释放侧取回同一份而**不重新推导 IP** —— 与 §5.4 的 IP 语义一致）。

#### 后端 agent 报的四条「文档未记录的问题」——**全部采纳，收口时写进 `agent-briefs.md`**

1. **`api-gateway` 的 `reflect-metadata` 不在它的依赖里**：它今天能跑**只因为** `@nestjs/common/index.js`
   内部 `require('reflect-metadata')`。任何只 import 子路径的入口会丢 polyfill，而**单测里
   `import 'reflect-metadata'` 会直接 `Failed to load url`**（从 api-gateway 解析不到）。
   ⇒ 这是一条**潜在的启动期陷阱**，登记为环境事实（本片不补依赖 —— 补它会动 `pnpm-lock.yaml`，
   且今天无实际故障；但下一个人必须知道它为什么能工作）。
2. **`Test.createTestingModule` + 手补 `Reflect.defineMetadata('design:paramtypes', …)` +
   `createNestApplication()` + `listen(0)` 在 vitest/esbuild 下真的可用** —— 本仓此前只记了
   「esbuild 不发 paramtypes ⇒ 只能手搭 Express」。这条让本片的 N12 用**真 Nest 应用**、
   N15 用**真 Nest 应用 + 真 socket.io 客户端端到端**。⇒ **写进 agent-briefs**（它直接提升今后判据的强度）。
3. **`@WebSocketGateway` 的 `allowRequest` 只能给模块级闭包**：装饰器求值期没有实例，
   `this` 是模块作用域 —— **我在 R246 里写的「用 `this` 绑定」是错的**（本轮我写错的第三处，但这条
   是**实现细节**、由 agent 在执行期发现并给了正确落法：构造时登记进模块级槽位、闭包转发、未登记即 fail-closed）。
4. **websocket 传输上拿不到握手 403 的错误体**（engine.io-client 只报泛化的 `TransportError('websocket error')`；
   只有 polling 传输能拿到 `description=403`）⇒ **任何依赖「错误文本」的 WS 判据在 ws 传输上不可能成立**。
   这解释了为什么 conformance 的 N15 判据只能钉「`sawConnectError` 的**存在**」而不能钉文本 —— 两边一致。
5. **假 Redis 的宽容度又咬了一次**：`fake-redis.ts` 的 `hset` 只支持 `(key, field, value)` 形态，
   生产代码一旦用对象形态 `HSET`，替身会把 `[object Object]` 写成字段值**却让断言全绿**（R212 同族）。
   已修（两种形态都支持并返回**新增**字段数）。⇒ **这是 R212 的第 N 次发作**，写进教训。

---

## 门禁实测（master `182c660`，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    本片零前端改动（`apps/` 的 diff 为空）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
# ⚠️ **收口期实测的一个坑**：上一轮 `docker compose build` 被会话中断打断 ⇒ **api-gateway 镜像仍是旧的**
#    （实测症状：未知路由仍返回 Nest 默认体、`not-found.filter.js` 不在容器里）。
#    ⇒ **重建后必须核对镜像时间晚于 dist**，或直接用冒烟测试确认新行为生效（本次三条都冒烟过：
#    未知路由 `{code:10001}` / `TYPE room:XKSY2A = hash` / `HKEYS` 恰好 7 字段 + `TTL=3600`）。
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 46 项（44 → +2）
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 73 项（60 → +13）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 55 项（28 → +27）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（只看尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
# ⇒ **13/13 全绿**

# R243 的**顺序无关性**（门禁的一部分）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 池空 ⇒ 46 项
# 种子（经 robot RPC acquire×2 → release×2）⇒ ZCARD=2，再跑：
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 池非空 ⇒ 46 项

# E7 容器级验收（**只断言配置项不够**）
docker compose restart user-service && sleep 18
docker compose ps user-service --format '{{.Status}}'                                  # ✅ healthy
docker compose exec -T mysql mysql -uroot -proot -N -e   "SHOW COLUMNS FROM fight_the_landlord.users;" | wc -l                                # ✅ 7
docker compose exec -T mysql mysql -uroot -proot -N -e   "SELECT id,name FROM fight_the_landlord.migrations;"                                 # ✅ InitialUsers1789000000000

# N21 在线实证（**本条存在的全部理由**：旧实现下这种机器人结构上不可能被发现）
docker compose logs robot-service | grep -i reclaim
# ✅ [RobotPool] Reclaimed bound bot bot-6ffc78dbc (the room S11IDEM referenced by the view is gone; boundAt age=58998ms)

# 生产形态（R98 不回归）
docker compose --env-file /dev/null -f docker-compose.yml config --format json
# ✅ 只有 api-gateway 发布宿主端口（3000）；game/robot 是 ports=[] expose=["3103"/"3105"]；五个服务 token 渲染为 ""

docker compose logs api-gateway | grep -c 'Blocked outbound'                          # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0
```

**关闭的偏差**：**E2 / E6 / E7 / N9 / N12 / N14 / N15（后端半边）/ N21** + **R243**。
对账表 §0 现为 **75 条：74 已关闭 / 0 部分关闭 / 1 仍开放**（唯一仍开放：**N13**，风控 roadmap）。

**门禁期抓到的 5 个真问题**（两处是**协调者自己的裁决写错**，三处是**判据自身**的缺陷）：
① **R247 的 `boundAt` 析取与 §9.6 的合取冲突**（会把正在对局的机器人回收掉）—— 后端 agent 用规格原文顶回；
② **R243 的「池非空即红」机制解释被实测证伪** —— conformance agent 在**修前 dist** 上跑出反例、我独立复核；
③ conformance 的自查不变式 `allFilesStillHttp` **语义写反 ⇒ 恒绿**（R242）；
④ `NOT_YET_MIGRATED` 迁移完成后**未清空**（R242）；
⑤ **探针判别力自证用「连一个不存在的端口」= 空测**（本机 SYN 被丢弃、2.5s 零事件）⇒ 改用「错的 socket.io path」（R282）。

---

## 下一步

- 计划落盘 → 派**后端 agent**（Task 1–8）与 **conformance agent**（Task 9）→ 两方 settle 后协调者合并、跑门禁、收口 `design.md` §10.1 + 对账表。
