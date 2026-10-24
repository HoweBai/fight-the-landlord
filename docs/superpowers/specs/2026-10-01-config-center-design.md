# 配置中心与好友房开关（**设计层 v3**）

> **状态**：v3（**定稿本**）—— 已过**三轮**独立审查：r1（实列 2 Critical / 8 Important / 8 Minor；r1 抬头「9 Important」系其自身计数笔误，r2 复核订正——处置见**附录 A**）→ r2（2 Critical / 6 Important / 7 Minor——处置见**附录 B**）→ **r3 修复验证（0 Critical / 0 Major；10 处行级修正已落叶）**。审查报告在 `.superpowers/sdd/2026-10-01-config-center/`（工作区工件不入库）。**设计层定稿**；规格层已启动（`2026-10-01-config-center-spec.md`）。
> **分层**：本文 = 设计层（方案与取舍）；形式化层另起 `docs/superpowers/specs/2026-10-01-config-center-spec.md`。
> **来源**：本会话用户裁决（§1.1 #1–#7 + #9/#10）+ 既往裁决溯源（#8）+ 两路现状探查（§2，全部带 `文件:行号`）。
> **本片不做**：RBAC / 多管理员 / 配置版本历史（§7）。

---

## 0. 一句话

把散在各处的「可调参数」（三档模型、比例、规则引擎开关、周期常量、底分档位、好友房开关）收进**一个新的 config-service**：
**一处改（后台网页）→ 写库 → 推送失效 → 各服务内存缓存立刻重载**；底分档位那条已有的热配置路**收编成配置键**，并顺手把它「改了即生效」这条**一直在手工验证、没有永久闸**的性质补成机械判据。v1→v2 另修两个「按 v1 做下去必然撞车」的洞：**好友房默认关对既有判据的地震要有共存策略**（C-1）、**跨配置中心边界的回滚要修工具链**（C-2，用户裁决：本片顺手修好）。

---

## 1. 输入

### 1.1 用户裁决（逐条，本文全部设计不得与之冲突）

| # | 问题 | 裁决 | 来源 |
|---|---|---|---|
| 1 | 配置中心形态 | **新增 `config-service`**（新容器），不是「Redis 键 + 脚本」也不是「寄居 user-service」 | 本会话 |
| 2 | 下发架构 | **乙 · 推送式**：服务内存缓存 + config-service 写时发 Redis pub/sub 失效通知 | 本会话 |
| 3 | 范围 | 明确三件（**难度比例** / **规则引擎开关** / **好友房开关**）+ **④ 底分档位表** + **⑤ 四个周期常量** + **⑥ 难度档位→模型的映射** | 本会话 |
| 4 | 写入口 | **后台网页**（方便改配置），不是 CLI、不是裸 REST | 本会话 |
| 5 | 页面位置 | 由**门口（Caddy）托管 `/admin` 小页面**，与玩家 H5 同域名、完全分开 | 本会话 |
| 6 | 谁能改 | **一个管理口令**（env 配；不引入玩家账号体系与角色表） | 本会话 |
| 7 | 底分档位收编方式 | **收编成配置键**（不保留原表机制） | 本会话 |
| **8** | **好友房开关默认值** | **默认关（要显式开）** —— 上线后好友房处于关闭态，管理员显式打开才可用；本条随本片落地 | **`2026-10-01-ai-rollout-design.md:192-193` 裁决 15/16（溯源补登）** |
| **9** | **跨配置中心边界的回滚** | **本片顺手修好**：发布/回滚改为送「目标 tag 自己的编排文件」⇒ 任意版本一键回滚可用（详见 D8-5） | 本会话（r1-C-2 处置） |
| **10** | **旧端点退役的窄窗口** | **接受窄窗口**：部署瞬间已打开的旧 H5 页面会看到空档位 + 一次错误提示，刷新即恢复；不保留旧端点（详见 D5/§5.2-3） | 本会话（r1-I-8 处置） |

### 1.2 既有约束（本仓纪律，逐条适用）

- **判据只增不减**；`baselines.json` 只由 CI 回填；**每次改动一个 commit**（CLAUDE.md）。⚠️ 凡涉及「删除既有判据」的动作必须**显式登记**（本片唯一的疑似项见 D8-4，已消解）。
- **容器不依赖宿主产物**：配置只能进镜像或进库，**不得**挂宿主文件当配置源。
- **不可区分性**：机器人标识与难度**永不出站**；配置中心不得给客户端任何内部字段（`skillLevel`/`botId` 之类）。
- **哑终端**（§12.1/§12.3 M09）：客户端**不得**硬编码游戏规则常量；配置一律服务端下发。
- **手册的「预期输出」是判据的一部分**（片②血训）：凡改动会让手册里写死的输出读数失效的，必须同改（本片清单见 §5.1，最关键一处 = `first-deploy.md:249`）。
- 用户**没有运维背景**：文档讲「玩家会看到什么」，术语括号里带一次。

---

## 2. 现状（两路探查的实测事实，全部带出处；r1 已逐条核验，两处订正见下）

### 2.1 平台里已有的「热配置」只有一条

| 环节 | 事实 |
|---|---|
| 表 | MySQL `base_score_levels`（五列 `id/name/base_score(UNIQUE)/sort_order/enabled`），**显式迁移**建表 + **种子写在迁移里**（`packages/user-service/src/migrations/1789100000000-BaseScoreLevels.ts:16-32`）；`synchronize:false` + `migrationsRun:true`（`database.config.ts:31,35,42`） |
| 读 | `BaseScoreLevelsService.list()` **每次查库、刻意不缓存**（`base-score-levels.service.ts:26-31`, `:40-54`） |
| 出口① | REST `GET /api/base-score-levels`（经网关**验签**、不在五条公开白名单里）→ 客户端 `rest.baseScoreLevels()`（`apps/client/src/net/rest.ts:257-258`，大厅挂载时一次、不缓存） |
| 出口② | TCP RPC `config.baseScoreLevels`（**唯一一条 room→user 边**，`protocol/src/rpc.ts:50-51`；3s 超时、不重试、失败 ⇒ `10007`；`room-service/src/gateway/config.client.ts:36,55-85`） |
| 消费 | room-service **两处**：建房 `rooms.service.ts:186-213`、入队 `match.service.ts:205`+`:239-252`；**读不到 ⇒ `10007` 整体失败，绝不静默放行**。⚠️ 建房路径**仅当 `dto.baseScore !== undefined` 才读表**（`rooms.service.ts:194`）；缺省路径 `dto.baseScore ?? DEFAULT_BASE_SCORE` 不读表（`:222`） |
| 写 | **没有任何代码/脚本能写** —— 全仓唯一的写是迁移里那条一次性 `INSERT`；运维只能手工进 MySQL（命令在 `docs/superpowers/plans/2026-09-27-lobby-server.md:707-712`） |
| 「改了即生效」 | **人工验证过一次**（`…lobby-start-game-design.md:246`）；**没有永久闸**，规格自己记成已知缺口（`:187`, `:221`） |
| 语义债 | 片规格自认「**配置数据寄居在用户服务里**」（`…lobby-start-game-design.md:44`） |

### 2.2 好友房的全部触点（加开关要覆盖的面）

| 面 | 位置 | 现状 |
|---|---|---|
| 列表 | 网关 `GET /api/rooms` → `rooms.controller.ts:24-28` | 返回 `RoomInfo[]`（已滤 `cancelled`） |
| 建房 | 网关 `POST /api/rooms` → `rooms.controller.ts:41-54` | `CreateRoomDto{ mode, roomCode?, baseScore? }`；建房**不入座**（`players: []`） |
| 占座 | 网关 `POST /api/rooms/:code/join` → `rooms.controller.ts:56-64` | 无 body；身份取网关注入的 `X-User-Id` |
| WS 进房 | `src/gateway/message.router.ts:333-408` 的 `handleJoin` | **匹配人与好友房人共用同一条**；放行判据 = `room.players` 成员身份 **或** `match:pending.{userId}.roomCode` |
| 自动开局 | `rooms.autostart.ts:78-111` | 扫全部非 cancelled 房间，但**只对有补位死线的房间生效**：`fillAt = readFillDeadline(code)`，`null ⇒ return false`（`:105`「不是手动房」） |
| 「这是好友房」的**服务端判据** | 键 `room:{code}:fillat`（`rooms.seats.ts:39`） | 由两处写：① 手动路径（`rooms.controller.ts:49`、`rooms.service.ts:321`）② ⚠️ **r1 订正**：`resetWaitingWindow`（`rooms.service.ts:314-322`）由 `message.router.ts:369`（join 成功）/`:432`（leave）对**所有 waiting 房**调用 ⇒ 匹配房同样被写 fillat（**先于本片**的现状）⇒ `mode === 'practice'` **不是**判据（`validate.ts:331-337` 只校验取值），`fillAt === null ⇒ 非手动房` 这条反推也**被污染**。台账登记，§5.2-6 如实改写 |
| 客户端入口 | `apps/client/src/pages/game/game.vue:369-378`（按钮）· `:388-452`（弹层：创建/输房号/列表） | 四个动作共用**唯一一个** `join()`（`:208-248`）；源码级判据钉在 `lobby-ux.test.ts:341-352` |
| 现成的错误码 | **`12006 FRIEND_ROOM_FAILED`**（`protocol/src/errors.ts:36`，处置 `TOAST`，`docs/design.md:1356`） | **全仓零触发点**（r1 grep 复核）—— 语义对口且未被占用 |

### 2.3 客户端拿到服务端配置的**唯一**通道

只有底分档位那一条（`GET /api/base-score-levels`，大厅挂载时一次）。其余开关（`ROBOT_RULE_FALLBACK` 等）**不下发客户端**，也没有任何通用配置通道。

### 2.4 基础设施面（新增容器会牵动的清单）

- 7 个自建镜像（`scripts/deploy/build-images.sh` 的 `--print` 恰好 7 个 target：api-gateway / douzero / edge / game / robot / room / user）· `docker-compose.yml` 的 `ftl-*` 容器名与健康检查 · `scripts/deploy/conformance-stack.sh:18` 的 `SERVICES` · `tools/conformance/src/slices/slice-07.2-deploy.ts` 的镜像/容器清单断言（`:552` 七项 + A12「恰好」、`:919-921` 容器名、`:123`/`:131` 的 5 项清单）。
- 门口（Caddy）镜像**已经在构建 H5 静态产物**并托管（`docs/ops/first-deploy.md:440` 提到「门口镜像里没有页面 ⇒ H5 那一步没成功」）⇒ 加 `/admin` 静态页走的是同一套机制。Caddyfile 的 `handle` 按**源码顺序**首个匹配生效（`deploy/Caddyfile:29-38` 现为 `/api/*` → `/socket.io*` → catch-all——r2-M1 订正行号）。
- 备份脚本**不含 Redis**（`scripts/ops/backup.sh` 只备 MySQL + 证书卷 + `.env`）⇒ **配置必须有 MySQL 这份持久源**（本设计正是如此）。
- 回滚工具链现状：**全量换 tag**（单一 `IMAGE_TAG`，`deploy.sh:146`），送机的是**本检出**的 compose（`deploy.sh:106` `scp … docker-compose.yml`），dispatch（回滚）路径检出的固定是 master（手册 `first-deploy.md:796-825`）⇒ **跨配置中心边界的回滚会拉不存在的镜像**（D8-5 修复）。

---

## 3. 设计决策

### D1 — 新服务：`config-service`（**第 8 个自建镜像**；开发形态**第 9 个**容器 / 生产形态**第 10 个**容器）

- **形态**：NestJS，与现有 **5 个 NestJS 服务**同形（`main.ts` 的 fail-closed 内部 token 检查、`/api/health` 就绪 + `/api/health/live` 存活、`RedisProviderModule`、TypeORM）。
- **端口**：沿用 30xx/31xx 惯例 —— HTTP **3006**、RPC **3106**（compose 里 `expose`、不 `ports`；`CONFIG_SERVICE_RPC_HOST/PORT` 注入各消费方）。
- **存储**：MySQL 表 `platform_config`（本服务**自己的迁移**建表 + 种子，与 user-service 同一个 MySQL 实例、同库不同表）。
  - 🔴 **配置的持久真源必须是 MySQL**：备份只覆盖 MySQL（§2.4）；Redis 只做**失效广播**，不做存储。
  - 🔴 **`migrationsTableName` 必须显式独立**（如 `migrations_config`）：现状 user-service 用默认表名 `migrations`，两个服务共写同名表会互相把对方的迁移记录当「未知已执行」（r1 无法核验项 2）——设计层先钉死。
- **表结构**（种子与代码默认值同值）：
  ```
  platform_config(key PK, value JSON NOT NULL, version BIGINT NOT NULL DEFAULT 1, updated_at, updated_by)
  ```
  - **version 语义（新增列，r1-I-4）**：**每键单调计数器**，写事务内 `version = version + 1`（行锁；key 不存在 ⇒ INSERT 从 1 起）；**持久化 ⇒ 重启不倒退、只增不减**。快照携带**每键 version**，全局 `version = MAX(每键)`（派生值）；客户端 `GET /api/config` 的 `version` 即此全局值。⚠️ 并发**首建**同键需 `ON DUPLICATE KEY` 或唯一键冲突重试（r2-B5；规格层补一条并发单测）；全仓无 raw-query 自增先例（`health.service.ts:72` 是唯一 raw `SELECT 1`）⇒ 属「新写法、标准做法」。
  - ⚠️ 不做变更历史表（用户未选；§7 登记为不做）。
- **健康检查**：`/api/health` 的 `checks = {redis, mysql}`（与 user-service 同构）；compose 配 `healthcheck`（**运维可见性用**；⚠️ **不作为消费服务的启动门**——v3 按 r2-C1 改「不加硬门」，见 D8-3/§5.2-9）。
- **Redis 订阅连接（r1-M-5）**：ioredis 进入 subscribe 模式后**该连接不能再发普通命令** ⇒ 订阅 `config:changed` 必须用**专用连接**（独立 `new Redis(...)`），不得复用各服务现有 provider 实例。
- **三个出口**：
  | 出口 | 谁用 | 形态 |
  |---|---|---|
  | TCP RPC `config.snapshot` | 各服务（读） | 一次返回**全部可见键**（`{key: {value, version}}` + 派生 `version`） |
  | REST `GET /api/config` | 玩家客户端（读**子集**） | 经网关验签；只含客户端可见键（§D5） |
  | REST `/api/admin/*` | 管理页（读全量 + 写） | 经网关转发的**独立鉴权**（§D6） |

### D2 — 推送式热更新：缓存 + pub/sub **+ 安全网**（本片最要紧的一条）

- **写路径**：`/api/admin/config/:key` PUT → 校验（D3）→ 写库（version+1）→ `PUBLISH config:changed { keys: [...] }` → 返回 `{saved: true, announced: <bool>, version}`。
  - 🔴 **announce 结果必须可见**（r1-I-6/D-2）：publish 失败**不拦写入**，但响应里 `announced: false` + 一条 WARN 日志（NDJSON）——不许出现「改了没生效、而日志里查不出来」。
- **读路径（每个消费服务）**：
  1. **启动**：`config.snapshot` 拉全量 → 存进进程内缓存 → 订阅 `config:changed`；⚠️ **启动拉取失败 ⇒ 1s 退避重试直到首次成功**（不阻塞服务就绪；期间按下面「失败语义」分层行事）；
  2. **收到通知**：重拉快照（全量很小，不做增量，少一处出错的地方）→ 换缓存；
  3. 🔴 **安全网：默认每 60s 无条件重拉一次**（与 pub/sub 无关）。
- 🔴 **为什么必须有安全网**：**Redis 的 pub/sub 没有投递保证**（at-most-once；订阅者断线期间的消息**永久丢失**，重连也不会补发）。没有安全网就会出现「改了没生效、而且日志里查不出来」。安全网把最坏情况从「永久陈旧」压到「≤60s 陈旧」。
  - **与 C1 的关系（r1-D-7）**：C1 要求「30s 内生效」⇒ **30s < 60s 是刻意设计**：C1 只证**推送路径**；安全性由 C2 单独证（不依赖推送、等安全网）。两处判据的窗口不许再调（谁把 C1 调宽到 >60s，判别力就没了）。
- **失败语义（分层，写死；「拿不到」的定义在此形式化，r1-I-3）**：
  - **「拿不到」= 缓存为空，且一次即时拉取（启动重试循环中）也失败**；缓存非空（哪怕是 60s 前的旧值）一律**用缓存**、不报错。
  | 类别 | 「拿不到」时 |
  |---|---|
  | **热项**（开关 / 比例 / 常量 / 模型映射） | **用代码默认值** + 一次 WARN（**不得**因为配置中心挂了就停止服务） |
  | **底分档位** | **保持 fail-closed**：建房（显式 `baseScore`）/入队拿不到 ⇒ `10007` 整体失败（**绝不静默放行**）。⚠️ 与既有语义的差异**显式登记**：旧语义 =「每一次读都可能 10007」（每次 RPC）；新语义 =「仅缓存为空的窗口内才可能 10007」。C4 的判据据此改造夹具（mock 快照客户端失败 + 空缓存）|
- **测试可见的开关（r1-I-5，变异自证的前提）**：消费服务读两个**仅测试注入**的 env —— `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）· `CONFIG_SYNC_DISABLE_PUSH`（默认关；conformance 步骤里注入）。生产 compose **不设**这两项。
- **可观测性**：重载成功/失败、缓存版本变化、pub/sub 断连都记 NDJSON（九字段；`source = config-reload` 之类），管理页的每次写入记一条（含 key、改动人、announced 结果）。

### D3 — 配置项清单（键 · 形状 · 默认值 · 消费者 · 生效方式）

| 键 | 形状 | 代码默认（= 种子） | 消费者 | 生效 |
|---|---|---|---|---|
| `robot.skillDistribution` | `{beginner,intermediate,advanced}` 权重 | `0.15 / 0.35 / 0.5` | robot-service | 热（下一次抽档） |
| `robot.ruleFallback` | boolean | `true` | robot-service | 热 |
| `robot.modelBySkill` | `{beginner,intermediate,advanced}` → 模型名 | `sl / douzero_WP / douzero_ADP` | robot-service | 热 |
| `robot.reclaimIntervalMs` | number | `60000` | robot-service | 热（下一轮） |
| `room.matchScanIntervalMs` | number | `5000` | room-service | 热（下一轮） |
| `room.autostartIntervalMs` | number | `5000` | room-service | 热（下一轮） |
| `room.reapIntervalMs` | number | `60000` | room-service | 热（下一轮） |
| `room.friendRoomEnabled` | boolean | **`false`**（裁决 8：默认关） | room-service + 客户端 | 热 |
| `game.baseScoreLevels` | `{name, baseScore}[]`（enabled 语义并入：列表即有效集合） | 四档 `15/80/480/1200` | room-service + 客户端 | 热 |

九键默认值已由 r1 逐键对代码现值核验（全部一致，见审查报告 §3.2）。

- **校验（**服务端一处**；r2-I3 修订）**：逐键形状/值域校验函数**住在 protocol 包**（config-service 依赖它；`protocol` 是叶子包、依赖方向成立——r2-B3 实证）；非法值 ⇒ 写入被拒（**400 + 明确原因**），**不落库**。⚠️ **管理页不做校验**：它是**无构建**静态页、无法 import workspace 包（r2-I3 的结构性矛盾）——页面只做输入形状提示，错误原因由服务端 400 回显（页面本来就依赖服务端响应）。
  - 沿用片② 两条血泪：① 值域校验（比例三档齐全、非负、归一化；`baseScore` 非空且唯一；模型名 ∈ 已知三档；周期常量 > 0 且 ≤ 10 分钟）② **漏传/非法一律响亮失败**，不静默退化。
  - 🔴 **底分专项（r1-I-1；r2-I1 修正落点）**：**当前缺省值 15 必须 ∈ 提交的档位表** —— `DEFAULT_BASE_SCORE = 15` 是成对常量（`rooms.service.ts:48` ↔ `shared/ddz/game.ts:13-15`），而缺省路径**不读表**（§2.1）。表变可编之后，「缺省 ∈ 表」这条不变量只能靠**写入校验**保住（缺省值**冻结为 15**，本轮不做「可改缺省」——YAGNI）。提交不含 15 的表 ⇒ 400 不落库。⚠️ 两处常量的一致性判据**已存在、勿重造**：`rooms.base-score.test.ts:154-157`（同值对，`:150-152` 有判别力自证）与 `:158-162`（∈档位表）——**收编改造后逐条仍须绿**（C10/C18）。
- **周期常量的「热」实现（口径精确化，r1-M-6）**：四个定时循环从 `setInterval` 改成 **`setTimeout` 自重排** —— 每轮**结束后**读缓存里的当前值决定**下一轮**延迟。口径：**「当前一轮按旧值跑完，其后按新值排下一轮」**；判据断言点以此为准（改小后，**再下一轮**的间隔变化）。
- **env 的去向**：片② 的 `ROBOT_RULE_FALLBACK` / `ROBOT_SKILL_DISTRIBUTION` 与四个周期 env（**r1 订正：四个全部不在 compose**，文档侧只有 `docs/design.md:188` 登记了 `ROBOT_RECLAIM_INTERVAL_MS`）**全部退役**：它们现在的值成为**配置中心的种子 + 代码默认值**。
  - 依据：片② 设计层原话「配置中心落地时**只换数据源**」（`2026-10-01-ai-rollout-design.md:305`）。
  - ⚠️ **兼容**：env 退役 ⇒ compose 里那两行删掉；**老镜像 + 新库**的组合下老 robot-service 仍读 env（其默认值与种子同值）⇒ 滚动升级期行为不变。

### D4 — 好友房开关：服务端三面强制 + 客户端隐藏 + **默认关的共存策略**

- **判据（服务端）**：`room.friendRoomEnabled === false` 时——
  | 面 | 行为 | 理由 |
  |---|---|---|
  | `POST /api/rooms`（建房） | **拒**：`12006 FRIEND_ROOM_FAILED`，文案「好友房暂未开放」 | 入口本体 |
  | `POST /api/rooms/:code/join`（占座） | **拒**：同上 | 否则老页面/手搓请求仍能进 |
  | `GET /api/rooms`（列表） | **返回空数组**（不报错）。**落层 = controller 入口**（与建房/占座同层，r2-M6） | 它是只读视图；报错会让老客户端弹错误条，空列表更自然 |
  | WS `room.join` | **不动** | ①②③ 关了之后**没有合法路径**能造出/占住好友房；且在途房间（切换前建的）应允许打完 —— §5.2-1 的「明知取舍」 |
- 🔴 **判据落在哪一层（r1-I-2）**：拒绝点落在**手动路径的入口**（`rooms.controller.ts` 的 `POST /api/rooms` 与 `POST /:code/join`）；**不得**落在 `rooms.service.create()` 服务体 —— 该方法**被手动与匹配两条路径共用**（`rooms.service.ts:175-182` 文档注释逐字：「本方法被两条路径共用」，现有区分手段是 `options.timeoutMs` 的 `MANUAL_ROOM_TIMEOUT_MS` vs `WAITING_TIMEOUT_MS`）。落错层会连坐匹配（C8 有正对照判据：开关关时匹配照常成局）。
- **客户端**：`game.vue:369-378` 的「好友房」入口按配置显示/隐藏（关时**不渲染**）；即便 `onMounted` 里 `loadRooms()` 仍被无条件调用（`game.vue:297-298`），服务端列表也只会返回空数组（r1-M-3 订正口径）。**fail-safe（r1-D-9；r2-B6 复核）**：配置**未加载/拉取失败** ⇒ **隐藏入口**（`stores/game.ts` 的 `friendRoomEnabled` **初值 = `false`**，规格写死）。到 game 页**必经大厅挂载**（路由对齐：`usePageAlignment` 会把冷启直入 reLaunch 回大厅——r2-B6 读码证明）⇒ 无「首屏直入漏取配置」场景；**会话中途**管理员关开关时客户端照旧显示，由服务端 `12006` TOAST 兜底（§5.2-5 同族窗口）。
- **错误码**：用现成的 **`12006 FRIEND_ROOM_FAILED`**（TOAST）——它**零触发点**且语义对口；`docs/design.md:1356` 的文案由「好友房创建失败」改成「好友房暂未开放」（覆盖创建/加入两种语义）。
- 🔴 **默认关与既有判据/探针的共存（r1-C-1，本片必做的适配面）**：
  - **铁律**：conformance/探针栈的种子值**就是生产默认 `false`**（不许偷偷种 true —— 那会静默丢掉 C8 的默认态覆盖）；**fresh 栈断言 `friendRoomEnabled === false`**（C11）。
  - **需要好友房的切片：开头经 admin API 显式开启并轮询至生效**（≤30s 窗口）——这同时是 C1 写入路径的**第一批真实用户**。逐条处置（改夹具、**不改断言语义**）：
    | 切片/探针 | 位置 | 处置 |
    |---|---|---|
    | slice-06-auth-rooms | `:68`（POST 建房）、`:80`（列表非空）、`:91`（房在列表） | 开头开启；另 `:109-121` 的旧端点读取改 `GET /api/config` |
    | slice-07.1-room-atomic-seating | `:144`（POST 建房作夹具） | 开头开启 |
    | slice-07.2-hardening | `:1142-1145`（网关 POST /api/rooms 契约，期望 201） | 开头开启 |
    | slice-12-manual-join | `:91`、`:419`（practice 房，本片核心路径） | 开头开启 |
    | browser-e2e | `:609-697`（`game__friends-open` → `game__create-room`）；`:474` 等旧端点 | 探针 setup 开启 + 改指 `GET /api/config` |
    | 新 C8 切片 | — | 自设**关闭态**开局测三面 + 开启态正对照 + 收尾**还原 false** |
  - **运营口径**：部署完成后好友房处于**关闭态**；要开时管理员登录 `https://<域名>/admin` 打开（写进 first-deploy 的「怎么改配置」节；部署收尾把管理口令交给用户）。

### D5 — 客户端的配置下发：一条 `GET /api/config` 收编

- 新端点 `GET /api/config`（经网关**验签**）返回**客户端可见子集**：
  ```json
  { "baseScoreLevels": [{"name":"休闲场","baseScore":15}, …],
    "friendRoomEnabled": false,
    "version": 42 }
  ```
  —— `baseScoreLevels` 形状与既有 `BaseScoreLevelsResponse` 的 `levels` 兼容（客户端改动最小）；`version` = D1 的派生全局版本（⚠️ 本轮**无强制消费者**：供展示/日志/未来缓存用，规格层注明用途——r2-M4）。
- **客户端改动**：`rest.baseScoreLevels()` → `rest.clientConfig()`；`stores/game.ts` 同时存 `baseScoreLevels` 与 `friendRoomEnabled`；`lobby.vue` 的挂载时机不变（一次、不缓存）；失败态 = 入口隐藏（D4 fail-safe）+ 底分表空（**既有行为**，`lobby.vue:86-100`）。
- **旧端点退役**：`GET /api/base-score-levels` **删除**（网关路由、user-service 控制器、`rest.baseScoreLevels()`、相关判据；完整清单 §5.1/§5.2）。
  - **退役依据（r1-I-8 复核后的三句话）**：① App 侧从未打包发布 ⇒ **没有已发布的老 App** ✅；② H5 每次加载取最新产物，但**部署瞬间已打开的旧页面**技术上必然存在 ⇒ 它会 404 ⇒ 空档位 + 一次错误提示；③ **用户裁决 10：接受这个窄窗口**（窗口 = 部署那几分钟；部署选低峰；客户端 404 容错 = 既定行为）。⛔ 不保留旧端点。

### D6 — 管理面：门口托管的 `/admin` + 一个口令

- **页面**：一个**无构建步骤**的独立静态页（`admin/` 目录：`index.html` + `app.js` + 极简样式），由门口镜像**在新的一步里 COPY 进去**，Caddy 加一条 `handle /admin/*` 静态路由（与玩家 H5 分开，互不影响）。
  - ⚠️ **`handle` 顺序（r1-M-4③）**：Caddy 的 `handle` 按**源码顺序**首个匹配生效 ⇒ `handle /admin/*` 必须插在 **catch-all 之前**；`/admin`（无斜杠）定义为 301 → `/admin/`。
  - ⚠️ 它**不**进玩家 H5 的构建产物（不污染包体积，也不与 uni-app 的样式/路由纪律纠缠）。
  - 观感**我自己定**：深色、等宽、左侧键列表 + 右侧编辑器；保存后显示「**已保存（版本 N）；各服务 ≤60s 内生效**」；`announced: false` 时显示「推送失败，将在 ≤60s 内经安全网生效」（r1-I-6 的诚实文案）。
- **鉴权（fail-closed）**：
  - env `ADMIN_PASSWORD`（**未设 ⇒ 管理面整体关闭**：`POST /api/admin/login` 回 **404**（「管理面未启用」），页面据此提示 —— r1-M-4①：**不用 10007**，它是 `UPSTREAM_UNAVAILABLE`，拿它表示常态关闭会把「没开」伪装成「故障」）；
  - `POST /api/admin/login { password }` → **常数时间比较** → 签发**短期管理令牌**（JWT，独立密钥 `ADMIN_JWT_SECRET`，未设则用 `JWT_SECRET` + 独立 `aud`），有效期 **2 小时**，存浏览器 `sessionStorage`，请求经 **`Authorization: Bearer` 头**携带（⚠️ 非 cookie ⇒ 跨站表单/请求天然不适用 CSRF）；
  - 网关侧**两条缝**（r2-I5 分列，勿混同）：
    ① **玩家验签（`JwtMiddleware`）对 `/api/admin/*` 整段跳过** —— 否则所有 admin 请求先吃 401（无玩家 Bearer；即使带管理令牌也过不了玩家 session 白名单）。挂点 = **`public-paths.ts` 单一真源**（R462：不得另抄字面量）；⚠️ 与五条公开白名单**分开列**——语义不同：这里是「**不适用**玩家凭据」，不是「**无需**凭据」。
    ② **admin 鉴权中间件**（新）：校验管理令牌并注入 `X-Admin: 1`；🔴 **同时剥离客户端伪造的 `X-Admin` 头**（同 `X-User-Id` 纪律，r1-M-4②）；**豁免恰好一条**：`POST /api/admin/login` 是入口本身、按定义没有令牌（防「顺手多豁免」的洞，规格层给判据）。
  - **顺序与叠加（r2-I5；r3 限定面）**：admin 鉴权中间件必须在限流中间件**之前**（与 R141 的 `JwtMiddleware → RateLimit` 顺序纪律同族）；**登录**与**持令牌写**两条路径**跳过**既有 IP 120/60s 维（自己的维度更严，不叠加双罚）；⚠️ **其余 `/api/admin/*` 请求（不登录、又无有效令牌者，含对非 login 路径的随机令牌探测）保留 IP 维**——不然它们落在所有维度之外，「更严」的理由不成立。
  - **限流（r1-I-6 定界；r2-I5 机制）**：现状 `/api/admin/*` 请求无 `x-user-id` ⇒ 实际只剩**单 IP 120/60s**（`http-rate-limit.middleware.ts:14,53`）——对「唯一凭据是一个口令」**不叫防爆破**。设计定界：**登录按 IP 5 次/5 分钟**（**失败计次、成功清零**）+ **写操作按管理令牌 30 次/5 分钟**。⚠️ 「失败计次」= **响应感知计数**（登录响应的 finish 钩子），现有 helper 是请求计数、不支持——**新实现点**（r2-B4）；语义写死：**桶达界 ⇒ 窗口内正确口令也 429**（防爆破本来就该如此）。
- **不做**：RBAC、多管理员、操作审计表（§7）。

### D7 — 判据（**把「改了即生效」从手工验证升级成永久闸**）

这是本片相对既有状态最大的增量：那条性质**一直在手工验证、规格自己记为已知缺口**（§2.1）。

| # | 判据 | 层 |
|---|---|---|
| C1 | **改了即生效（推送路径）**（真栈）：经 admin API 改 `room.friendRoomEnabled` ⇒ `POST /api/rooms` **30s 内**变 `12006`；还原 ⇒ 恢复 201。⚠️ 30s < 安全网 60s ⇒ **C1 只证推送路径**（写进该判据的注释，防后人调宽） | conformance（新片） |
| C2 | **推送丢失的安全网**：直接改库（造「丢消息」）⇒ 不依赖 pub/sub、等 ≤ 安全网周期 ⇒ 值仍然生效。**主体键与还原写死**（r2-M5）：改 `room.friendRoomEnabled`（库里 UPDATE）⇒ 断言建房行为 ≤ 安全网周期翻转；**收尾经 admin API 写回原值并轮询至生效**（快速路径） | conformance |
| C3 | **热项在配置中心不可用时用默认值起服务**（不得启动失败/停摆） | 服务级单测 |
| C4 | **底分档位保持 fail-closed**：**缓存为空 + 拉取失败** ⇒ `10007`、合法值也失败、不落库（既有用例改桩；语义差异见 D2 登记） | room-service 单测 |
| C5 | **写入校验**：非法比例/空档位表/未知模型名/负周期 ⇒ **400 且不落库** | config-service 单测 + conformance |
| C6 | **管理面 fail-closed**：未设口令 ⇒ 登录 404；口令错 ⇒ 401 且**不签令牌**；令牌过期 ⇒ 401。⚠️ 「未设」半边构造 = **步骤级 unset + 重建 config-service**（override 会带 dev 口令，r2-I4；先例 slice-07.3:141-177/:461 形态） | config-service 单测 + conformance |
| C7 | **客户端看不到内部键**：`GET /api/config` 的字段集**恰好**是子集三个键（防泄漏） | conformance + protocol 单测 |
| C8 | 好友房三面行为（建房拒 / 占座拒 / 列表空）+ **匹配路径不受影响**（开关关时匹配照常成局） | conformance + room-service 单测 |
| C9 | 周期常量**改完下一轮生效**（自重排证据：改小后，当前一轮跑完、**其后**间隔变化——假时钟） | room-service 单测 |
| C10 | 底分档位**收编后语义不变**：既有全部判据（非法值拒 / 拿不到 10007 / 缺省属于表 / 客户端选择）逐条仍绿（改造夹具） | 既有判据 |
| **C11** | **默认态铁律（r2-C2 改形）**：**workflow 前置断言** —— `conformance-stack.sh up` 之后、切片循环之前跑一次 `GET /api/config`，断言 `friendRoomEnabled === false`。⚠️ **不能做成切片**：新片追加在末尾（`run.ts:56-57` 纪律）⇒ 到它运行时默认态早已被前序切片改过（恒红或空洞二选一——恰是头号血训）。三条默认态好友房行为（12006/空数组）在 C8 内以**显式置 false 开局**覆盖 | workflow 前置步（conformance.yml） |
| **C12** | **写成功 / 发布失败可见**：mock publish 失败 ⇒ 响应 `announced: false` + WARN 日志 | config-service 单测 |
| **C13** | **并发写**：同键两个并发 PUT ⇒ 都 200、终值其一、**version 严格各 +1 不撕裂**、各服务缓存收敛到终值 | conformance + config-service 单测 |
| **C14** | `GET /api/config` **匿名 401**（鉴权强度，C7 只证字段集） | conformance |
| **C15** | **管理面限流界**：窗口内 N 次错口令 ⇒ 429（界值 = D6）。🔴 **收尾必须清失败计数键**（r2-I6：CI 串行同一 runner IP，桶残留会让后续切片/浏览器探针的正确口令也 429；**不能只等窗口**）——清理机制（如工作流侧特权步骤）规格层定 | conformance |
| **C16** | **启动错序 + 自愈**：config-service 后起 ⇒ 消费服务无需重启、≤ 重试/安全网周期生效；期间底分面 10007、热项面默认值照常。**构造**（r2-C1 改形后天然可跑）：`docker compose up -d room-service`（**不加**硬门 ⇒ 不碰 config-service）⇒ 观察默认值/10007 ⇒ 再起 config-service ⇒ 观察自愈 | conformance |
| **C17** | **变异自证**：`CONFIG_SYNC_DISABLE_PUSH` 注入 ⇒ **C1 必须红**；`CONFIG_SYNC_SAFETY_NET_MS` 注入超大 ⇒ **C2 必须红** | conformance（步骤级） |
| **C18** | **缺省 ∈ 表（写入侧）**：提交不含 15 的档位表 ⇒ 400 不落库（**config-service 一处**，新真增量）。⚠️ 两处常量一致性**引用既有判据**（`rooms.base-score.test.ts:154-163`——勿重造、改造后仍绿，r2-I1） | config-service 单测 + 既有判据 |
| **C19** | **客户端 fail-safe**：`GET /api/config` 失败 ⇒ 好友房入口隐藏（不渲染） | 客户端单测 |
| **C20** | **`/admin` 静态面**：`GET /admin/` 与 `GET /admin` 均 **200 且响应含管理页标志串**（title/元素 class——「非 404」太松，r2-M7）；路由顺序在 catch-all 前 | conformance |
| **C21** | **跨边界回滚（工具链）**：① **静态判据**（弱：部署脚本含「按 tag 取 compose + fail-closed」）；② **演练**（强）：v1.3.0 → v1.2.0 → v1.3.0 —— ⚠️ **发布后才能执行**（v1.3.0 尚不存在），**验收项单列**（r2-M3；先例片③-B） | conformance 静态 + 发布后演练（验收） |

- **`baselines.json`**：新切片由 **CI 运行**回填（本机跳过项的纪律不变）；新切片只进 `full` 列（`ci.yml:47-53` 的「render 列键集恰好相等」机制会强制这个决定是显式的）。
- **并发/性能**：不在本片判据里（配置读取是缓存命中，不引入热路径耗时）。

### D8 — 迁移与部署顺序（上线时逐条做）

1. **新增第 8 个镜像**：`build-images.sh` 的 target 7 → 8；compose 加 `config-service`（`ftl-config-service`、`expose` 3006/3106、不 `ports`、`healthcheck`、依赖 mysql/redis）；`conformance-stack.sh:18` 的 `SERVICES` 加它；🔴 **测试 `ADMIN_PASSWORD` 要进三处**（r2-I4）：`conformance-stack.sh` + `conformance.yml` 的**起栈步 env** + `conformance.yml` 的**切片循环步 env**（`:51-52` 有 env 块、`:71-73` 循环**没有**——GW/INTERNAL_TOKEN 有 `lib/http.ts` 默认值兜底、口令没有）；`slice-07.2-deploy` 的清单类断言同步（**「清单只增不减」的已知牵动面**，见 §5.1）；**+ conformance.yml 加 fresh 态前置步**（C11）。
2. **库**：config-service 的迁移建 `platform_config` 并**种下全部九键**（值与代码默认值同，含 `friendRoomEnabled: false`）——**底分的种子与旧表逐值相同**，因此**顺序无关**；config-service 显式 `migrationsTableName`（D1）。
3. **上线顺序（r1-I-3 修订 → r2-C1 再修订：不加硬门）**：`room-service` / `robot-service` / `game-service` 对 `config-service` **刻意不加 `depends_on`** —— r2 实测证实 `service_healthy` 硬门与 D2 的软依赖承诺正面冲突（配置中心不健康时**连 no-op `up -d` 都 exit 1**、需重建的消费服务被停并停在 Created）。启动错序由 **D2 的 1s 退避重试 + 安全网**兜住（代价 = 已登记的短暂窗口；C16 以 `up -d room-service` 直接构造）。**对比**：mysql/redis 是**硬数据依赖**（healthy 门是公认语义，照旧）；config-service 是**软依赖**——此区别登记 §5.2-9，并写进 compose 注释。config-service 自身 `depends_on` mysql/redis（healthy）+ 自带 `healthcheck`（`docker compose ps` 运维可见性用，不作用于消费服务顺序）。
4. **老表处置**：`base_score_levels` **留在库里不删**；🔴 **迁移文件 `1789100000000-BaseScoreLevels.ts` 与其测试 `migration.test.ts` 一并保留**（r1 无法核验项 1：删迁移文件后 TypeORM 对「迁移表有记录、代码无此类」的行为未证实 ⇒ 保留即完全绕开，且回滚时天然一致；「判据不减」也由此保住——**唯一疑似判据减少点消解**）。代码侧删除：entity / service / controller / RPC controller / 模块注册（清单 §5.2）。`deviation-ledger` 登记「遗留表 + 遗留迁移，待确认后清理」。
5. **回滚与工具链（r1-C-2 修复；用户裁决 9）**：
   - **修复**：送机 compose 从「本检出的 `docker-compose.yml`」改为「**目标 tag 自己的 `docker-compose.yml`**」——`deploy.sh`（`rollback.sh:37` 转发实证：修一处覆盖三路：CI push / CI dispatch / 本机 rollback）在 scp 前执行 `git fetch --tags --force && git show "refs/tags/$IMAGE_TAG:docker-compose.yml"`，**取不到就响亮失败**（fail-closed，不静默回退到本检出）；远端文件名与「`/srv` 恰好两文件」纪律不变。⇒ 任意版本一键回滚可用。r2 浅克隆实测：`fetch --tags` 后 `git show` 全通（is-shallow 保持 true 也可用）；不存在的 tag ⇒ exit 128 ⇒ fail-closed 有效。
     - **落地纪律①（r2-B1）**：`git fetch/show` 必须放在 `--assert-clean` 早退块（`deploy.sh:36-81`）**之后**——规格写死位置。
     - **落地纪律②（r2-M2，登记为刻意偏离）**：ops 脚本仍从**本检出**送机（`deploy.sh:120-123`）——ops 脚本是版本无关运维工具，且**按 tag 取会坏**：早于片③-B 的旧 tag（`git ls-tree` 实测：v1.0.0 / v1.0.1 均 0 个文件；v1.1.0 起为 5 个）根本没有 `scripts/ops/` 文件 ⇒ 保持本检出是正确选择；「全量换 tag」的口径限定为「**镜像 + compose**」。
   - **语义**：回滚 = **全量换 tag**（单一 `IMAGE_TAG`）；🔴 **禁止按服务手工混部**（工具链不存在按服务回退的入口，手工混部只会制造文档过去误导的那个坏形态）。
   - **孤儿容器**：回滚到旧 tag 时旧 compose 不含 config-service ⇒ 该容器**不被触碰、留作孤儿运行**（无人接线、无害）；再次前进时自动复用。写进手册。
   - **演练（验收项 C21）**：v1.3.0 → v1.2.0 → v1.3.0 各一次。
6. **手动滚动的兼容面**：见 §4 矩阵。
7. **运维两处新 env**：`ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`（服务器 `.env` 手工追加 + compose 透传；first-deploy 环境变量表同改）。

---

## 4. 兼容面与混部（r1 复核后更新）

| 组合 | 行为 | 能否测 |
|---|---|---|
| 新 config-service + 旧 room-service（读老 RPC） | 老 RPC 已删 ⇒ **失败**（10007）⇒ 建房/入队不可用 ⚠️ **工具链全量换 tag ⇒ 不存在稳态混合**（重建期瞬态以秒计，由 D2 重试自愈） | 只能推理（并禁止手工制造） |
| 新 room-service + 旧 config-service | RPC 不存在 ⇒ 热项用默认值；**底分 fail-closed** ⇒ 建房失败（吵闹） | conformance（可造） |
| 老 robot-service（读 env） + 配置中心在跑 | 老代码不读配置中心 ⇒ 用 env 默认值；值与种子同 ⇒ **行为不变** | 只能推理 |
| 老客户端（部署瞬间已打开的旧 H5 页面） | 调旧端点 ⇒ 404 ⇒ 空档位 + 一次错误提示；**刷新即恢复**（用户裁决 10：接受窄窗口） | 只能推理（§5.2-3） |
| 在途好友房（切换前建的） | 建/占座已拒，**在途房间可正常打完**（WS 路径不拦） | conformance（可造） |
| **回滚跨配置中心边界**（v1.3.0 ⇄ v1.2.x） | 工具链修复后：一键回滚可用；孤儿 config-service 容器无害留存 | **演练（C21）** |

---

## 5. 对权威文档/代码的修订口径

### 5.1 修订面全表（r1-I-7 补全；「加第 8 镜像/第 9–10 容器」会使其过期的一切地方）

**A. `docs/design.md`**（10+ 处）：

| 位置 | 改什么 |
|---|---|
| §2.1 服务清单 | + `config-service`（HTTP 3006 / RPC 3106、职责、数据层 Redis+MySQL）；`:539`/`:543` 两处 pattern 计数/编号句（「第八个 pattern（user-service 3101）」「第九个 pattern…现在是九个」）随 RPC 收编 + `config.snapshot` 新增改写（名单换、总数仍九——r2-I2③） |
| `:157` §2.2 拓扑 | **开发 9 容器（8 + config-service）⇒ 加门口 10**；**生产 10** = 9 + 门口（🔴 r1-M-1：v1 拟写的「第 9 个容器」是错的） |
| `:159` | 「7 个自建镜像」→ 8（config-service 入列） |
| `:999` | 「编排第 9 个服务」（edge）编号随计数更新 |
| `:1587` | images.yml「构建 7 个自建镜像」→ 8 |
| `:1718/:1727` | 「8 容器 healthy」「8/8 healthy」→ 9 / 9/9（开发形态口径） |
| `:188` §2.3 | **删** `ROBOT_RECLAIM_INTERVAL_MS` 行（⚠️ r1 订正：v1 只写了删两个，实际四个周期 env 全不在 compose、文档侧就这一行） |
| §2.3 环境变量表 | + `ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`、`CONFIG_SERVICE_RPC_*`；**删** `ROBOT_RULE_FALLBACK`/`ROBOT_SKILL_DISTRIBUTION` |
| §2.4 健康检查 | `config-service` 的 `checks` = `{redis, mysql}` |
| §4.1 通信方式总表 | + 三行：`* → config-service`（TCP RPC 读快照）、`gateway → config-service`（REST 读/写）、`config-service → Redis`（**publish** 失效通知） |
| §4.2 RPC 契约 | + `config.snapshot`（形状 + 失败语义）；**删** `config.baseScoreLevels` |
| §4.3 超时/重试/降级 | + `config.snapshot` 一行（超时 / 不重试 / 降级 = 用缓存或默认值；**底分例外，保持 10007**） |
| §7.1 路由与白名单 | + `GET /api/config`；+ `/api/admin/*`（**独立鉴权**、不进五条白名单）；**删** `GET /api/base-score-levels`（`:1012` 是**4 行块状条目**含 2026-09-27 复核订正史，按块删） |
| §10.1 Redis 键表 | + `config:changed`（pub/sub 频道） |
| §10.3 MySQL | 补 `platform_config`（含 version 列）；`base_score_levels` 标「遗留、无读者」 |
| §11.2 错误码 | `12006` 文案改「好友房暂未开放」并覆盖创建/加入 |
| 新增一节「配置中心」 | 九键清单、缓存+推送+安全网、管理面与口令、fail-closed 边界 |

**B. `docs/ops/first-deploy.md`（14+ 处；⚠️ 手册预期输出 = 判据的一部分）**：

- `:3/:25/:32/:123`「8 个服务容器 + 门口（第 9 个）」「9 个容器」「7 个镜像 ≈4.9GB」→ 更新计数；
- `:223`「INTERNAL_SERVICE_TOKEN 5 个服务」→ 6；🔴 **`:249`「预期：10 行…5 次…JWT_SECRET 恰好 2 次…其余三项各 1 次」→ 行数与次数按新栈重算**（这是全清单最关键一处）；
- `:670/:680/:699/:716/:732/:736/:781-783`（「7 个镜像」多处、「每版 7 个 ≈4.9GB」、「七个镜像必须同 tag」、17 切片 baselines）→ 同步；
- **+**「怎么改配置」一节（打开 `https://<域名>/admin`、口令从哪来、改完看「已保存/已生效」）；**+** 回滚注意（D8-5：全量换 tag、孤儿容器、跨边界演练记录）；环境变量表删两个、加两个。

**C. `.github/workflows`（5 处）**：`images.yml:1/:31`「7 个自建镜像」→8；`release.yml:43` 与 **`:78-86`**（「构建并推送 7 个镜像」+ 60 分钟超时按「7 个服务镜像 ≈4.9GB」的算术——r2-M1 订正行号）；`ci.yml:39`、`conformance.yml:49`「不构建 5 个服务」→6；**+ release.yml**：按 tag 取 compose 步（D8-5）；**+ conformance.yml**：起栈步与切片循环步**两处**注入 `ADMIN_PASSWORD` + fresh 态前置步（C11）。

**D. `README.md:35-44`** 服务端口表：+ config-service（3006/3106）；**顺手补**表里漏的 robot-service:3005（历史遗留）。

**E. compose 注释与 override**：`docker-compose.yml:142`、`docker-compose.override.yml:46` 引用 `config.baseScoreLevels` 的两处注释；**+「config-service 是软依赖、刻意不加硬门」的理由注释**（D8-3/§5.2-9；原「gateway 不加依赖」的理由并入此条）；**+ `docker-compose.override.yml` 的 config-service 块 = `ADMIN_PASSWORD` 的 dev 供给点**（browser-e2e 用；形态 = stack 脚本 `:13-14` 的 export 或 override `${VAR:-}` 二选一——规格层落定时须保证 C6「未设」步骤可在**裸 `docker compose`**（不经 stack 脚本）下构造；先例 slice-07.3 的「注入式 env + 裸 up 复原」即此形）。

**F. protocol 包**：`messages.test.ts:52-61`（逐字九 pattern 名，含 `baseScoreLevels` —— 退役+新增后仍是九，名单要换）；`robot-availability-wiring.gate.test.ts:12,211`（J21 门禁会自动要求 `config.snapshot` 有真接收侧——好消息）；`rpc.ts:50-51,156-165`。

**G. room-service**：`gateway/config.client.ts` + `test/config.client.test.ts`（改 RPC 名与形状）；`test/no-internal-http.gate.test.ts:76`（**源码级门禁正则**列了 `baseScoreLevels`，新增 `configSnapshot` 同步）。

**H. user-service**：`src/config/` ×4（entity/service/controller/module）+ `src/rpc/base-score-levels.rpc.controller.ts` **删**；`src/migrations/1789100000000-*.ts` + `test/migration.test.ts` **保留**（D8-4）；`test/base-score-levels.test.ts`、`test/base-score-levels.rpc.test.ts` 随源码删；`health/health.service.ts:34` 注释（「本服务是唯一报 mysql 的」）改。

**I. 客户端**：`net/rest.ts`、`pages/lobby/lobby.vue`、`stores/game.ts`、`pages/game/game.vue`（入口门控）；`test/auth-ui-wiring.test.ts`、`test/base-score-selection.test.ts`、`test/table-center.test.ts`。

**J. mock-server**：`src/rest.ts:117`（正在服务旧端点）、`src/index.ts:16,:59`（头注释+挂载说明）、`test/rest.test.ts` —— 旧端点换新端点。

**K. conformance/探针**：`slice-06-auth-rooms.ts:109-121`（读旧端点 → 新端点）+ D4 共存表全部切片；`browser-e2e.mjs:474/:609-697`；**新切片/新步骤（完整名单 = §D7 中「conformance」层各条：切片 C1/C2/C5(半)/C6(半)/C7/C8/C13/C14/C15/C16/C20/C21①，workflow 前置步 C11）**。

**L. 脚本清单**：`build-images.sh:2/:32`、`conformance-stack.sh:18`、`slice-07.2-deploy.ts:552/:919-921/:123/:131/:71`（「8 个常驻容器」）；**+ `deploy.sh`：按 tag 取 compose**（D8-5）。

**M. `docs/client-protocol.md`**（r2-I2①；r3 扩范围）：**替换** `:52` 旧端点行为 `GET /api/config`（+ 鉴权列）+ **改写** `:54-60` 解释段（**保留**「底分只能取自这张表」活契约；「每次查库、不缓存」句**语义反转**为缓存 + 推送 + 安全网）+ 修 `:62-63` 的「第 8 条」定位引用（删行后成悬空引用、且新表第 8 条恰是 `GET /api/config`——该表不在机械闸内，漏改无 CI 拦）。

**N. api-gateway 包**（r2-I2②，v2 整包漏列）：`gateway/gateway.controller.ts`（+ `/api/config` 与 `/api/admin/*` 转发、删旧端点转发）、`auth/public-paths.ts`（admin 整段跳过挂点——R462 单一真源、与五条白名单分列）、`auth/jwt.middleware.ts`（按需）、`http/http-rate-limit.middleware.ts`（admin 新维度 + 顺序）、`test/gateway.controller.test.ts:122-134`（旧端点转发测试）。

**O. `tools/conformance/src/lib/http.ts`**：`request()` 加 **PUT** 支持（管理写接口需要——r2-B2①；现仅 `'GET' | 'POST'`）。

**P. `docs/games/doudizhu.md`**：`:341`「`baseScore` 默认 **100**」→ 15（过期文本，顺手修——附录 M-8 的落点）。

### 5.2 明知取舍（写进文档，不留给后人猜）

1. **WS `room.join` 不设好友房判据**：三面拒了之后无合法路径；在途房间允许打完。代价：切换瞬间已持有房号且已占座的人仍能进（可接受）。
2. **回滚 = 全量换 tag**（**镜像 + compose** 按 tag；ops 脚本保持本检出——D8-5 落地纪律②的刻意偏离）；**禁止按服务手工混部**；孤儿 config-service 容器无害留存（warn 不删、回头自动复用——r2 实测）。旧 tag 的 compose 由 `git show` 取出（取不到 ⇒ 响亮失败）。
3. **旧端点的窄窗口**：部署瞬间已打开的旧页面底分选择器空 + 一次错误提示，刷新恢复（用户裁决 10）。**接受**。
4. **pub/sub 可能丢消息**：靠安全网（≤60s）兜底 —— 「配置了但慢一拍」而不是「永久陈旧」。**与 C1 的 30s 关系**：C1 只证推送路径（30s < 60s），安全性由 C2 证（D2）。
5. **档位表变更的 ≤60s 窗口效应**：管理员刚加/改的档位，在传播完成前可能被拒（新档）或按旧值成交（改价）——频率极低，接受；管理页文案已如实（D6）。
6. **`room.mode` 不是好友房判据，且 `fillAt` 反推也被污染**（r1-M-2 订正）：`resetWaitingWindow` 对**所有** waiting 房的入座/退座都写 fillat（`message.router.ts:369/:432`）⇒「`fillAt === null` ⇒ 非手动房」不成立。**任何新判断不得依赖这两者**；现状已在台账登记。
7. **管理面只有一个口令**：口令泄露 = 配置可改（可改口令止损）；限流界见 D6；不做 RBAC。
8. **遗留表 `base_score_levels` 不删**（表 + 迁移文件 + 其测试全保留、无读者）：DROP 风险大于收益，登记待清理。
9. **config-service 是软依赖**（与 mysql/redis 的硬依赖相对）：其不健康**不得**拦消费服务的启动/重建（刻意不加 `depends_on` 硬门，r2-C1）；错序窗口由 D2 重试 + 安全网兜（C16）。此条也写进 compose 注释。

---

## 6. 判据计划

见 §D7 的 **C1–C21**。⚠️ **分层（r2-M3）**：C1–C20 主体 + C21① 静态判据 = **本片判据**；**C21② 演练**与 fresh 态前置步的部署级验证 = **验收项**（发布后执行、单列——先例片③-B）。补充四条纪律：
- **每条判据都要能说出替代错实现**（本仓第一号纪律）；
- **C1/C2 是本片的价值点**（把手工验证的性质变成永久闸）：变异自证用 `CONFIG_SYNC_*` 两个测试 env 注入（C17）；
- **C1 的 30s < 安全网 60s 是刻意设计**（只证推送路径）——注释进判据，防「修 flake」把判别力删掉；C1 的真推送丢包风险（flake 面）同样记明；
- `baselines.json` 的 `full` 列由 **CI 回填**，不得用本机读数；新切片**不进** `render` 列（显式决定，机制见 D7 注）。

---

## 7. 明确不做（YAGNI）

1. **RBAC / 多管理员 / 权限表**（本片只有口令）。
2. **配置变更历史表 / 一键回滚到上一版**（写入有日志，不做版本历史）。
3. **灰度重启机制**（热更新到位 ⇒ 不需要；周期常量「下一轮生效」）。
4. **配置放 Redis**（Redis 不在备份范围 ⇒ 持久真源必须是 MySQL）。
5. **客户端可视化配置** / 玩家侧任何管理入口。
6. **基础设施类 env**（`DOUZERO_URL`/`DB_*`/`SITE_ADDRESS` 等）进配置中心：它们是**部署形态**，不是**运行期可调**。
7. **配置中心自身多实例**（单实例即可）；⚠️ 但**消费侧读路径的多实例安全性已推演并登记**：每实例独立拉快照 + pub/sub 广播 + 安全网 ⇒ **多实例安全**（免得下一个人重推）。

---

## 8. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | **收编底分档位 = 动一条已上线且判据完备的路径** | 判据「只增不减」（C4/C10 + C18），既有 12 条相关判据逐条保留、只换数据源；上线顺序（D8-3）与回滚口径（D8-5）写进手册 |
| R2 | **配置中心成为新单点** | 缓存 + 默认值 + 安全网（D2）；只有底分档位保持 fail-closed，且缓存有值时不受影响 |
| R3 | **管理口令爆破** | 常数时间比较 + **独立限流界**（D6）+ 短期令牌；未设口令 ⇒ 管理面整体关闭 |
| R4 | **`/admin` 页面成为新的攻击面** | 静态页无后端渲染、只调 `/api/admin/*`；写接口全要求管理令牌（Authorization 头，非 cookie）；页面不含配置值；`X-Admin` 伪造头剥离 |
| R5 | **清单类判据的牵动**（镜像 7→8 / 容器数 / SERVICES / deploy 切片 / 手册预期输出） | §5.1 全表逐条；「清单只增不减」的既有闸会响亮拦截 |
| R6 | **回滚跨配置中心边界**（v1 的断点） | **工具链修复**（D8-5）+ **跨边界回滚演练**（C21 验收项）+ 手册写死「全量换 tag、禁止混部、孤儿容器说明」 |
| R7 | **改发布管道本身**（D8-5 动 deploy.sh/release.yml） | 改动面小、两路（dispatch/rollback.sh）共用一处；`git show` 失败 **fail-closed**；下次发布即真实检验；演练护住 |

---

## 9. 下一步

1. ✅ **设计层已定稿**（三轮审查闭环：r1 → r2 → r3 修复验证，0 Critical / 0 Major 遗留；本文即定稿本）。
2. 出**规格层**（逐文件改动清单 + C1–C21 逐条形式化 + 迁移与部署步骤 + 回滚演练脚本）；
3. 规格过审 → 写计划 → 计划过审 → 实现（子 agent）→ 自测。

---

## 附录 A — r1 审查处置表（v1 → v2；r2 已逐行复核：**成立 14 / 部分成立 7 / 不成立 0**——修正项见附录 B）

| r1 发现 | 处置 | 落在哪 |
|---|---|---|
| C-1 好友房默认关的地震 | 默认关有据（裁决 8 溯源）；**共存策略** = 种子=生产默认 + 铁律 C11 + 需要好友房的切片经 admin API 先开启（逐条表）；运营口径进手册 | §1.1#8、D4、D8-2、§5.1-B |
| C-2 回滚工具链 | **用户裁决 9：本片修好** —— 送「目标 tag 的 compose」（fail-closed）；禁止混部；孤儿容器说明；C21 演练 | §1.1#9、D8-5、§5.2-2、R6 |
| I-1 缺省 15 ∉ 九键 | 校验加「15 必须 ∈ 表」（缺省冻结）；两处常量补一致性判据 | D3、C18 |
| I-2 D4 落层 | 明写落**手动入口**、不得落共用 `create()` | D4 |
| I-3 启动空窗 + 顺序不可执行 | 启动 1s 退避重试；顺序机制（v2 先写 `depends_on: service_healthy`，**v3 按 r2-C1 改「不加硬门」——见附录 B**）；C16；软依赖理由 | D2、D8-3、§5.2-9、C16 |
| I-4 version 缺口 | 新增 `version BIGINT` 每键单调列 + 快照/客户端语义 | D1、C13 |
| I-5 C2 变异不可执行 | `CONFIG_SYNC_SAFETY_NET_MS` / `CONFIG_SYNC_DISABLE_PUSH` 测试 env | D2、C17 |
| I-6 管理面限流与「已生效」 | 独立限流界（5/5min、30/5min）；文案「已保存…≤60s」；`announced` 可见 | D6、C12、C15 |
| I-7 修订面不完整 | §5.1 全表（A–L） | §5.1 |
| I-8 退役依据 | **用户裁决 10：接受窄窗口**；理由三句话写死 | §1.1#10、D5、§5.2-3 |
| M-1 计数口径 | 「第 8 自建镜像 / 开发 9 / 生产 10」；「与 5 个 NestJS 同形」 | D1、§5.1 |
| M-2 fillat 订正 | §2.2 如实改写 + 台账登记 + §5.2-6 改写 | §2.2、§5.2-6 |
| M-3 `loadRooms` 句 | 改口径（服务端返空） | D4 |
| M-4 管理面细节 | 404（非 10007）、X-Admin 剥离、Caddy 顺序、Authorization 头 | D6 |
| M-5 ioredis 订阅连接 | 专用连接点名 | D1 |
| M-6 C9 口径 | 「本轮跑完、其后按新值排下一轮」 | D3、D7 |
| M-7 零散修订点 | 并入 §5.1（compose 注释 / design.md:539 / README+3005 / health 注释） | §5.1 |
| M-8 doudizhu.md | 空操作行删除；顺手修 `:341` 过期文本（默认 100→15） | §5.1-**P**（v3 补上该行——r2-I2④） |
| 无法核验 1（TypeORM 迁移） | **保留迁移文件 + 其测试** ⇒ 绕开 + 判据不减 | D8-4 |
| 无法核验 2（migrations 表同名） | config-service 显式 `migrationsTableName` | D1 |
| §5.3（取舍诚实性/多实例） | §5.2-2/-4 重写；多实例结论登记 §7 | §5.2、§7 |

---

## 附录 B — r2 审查处置表（v2 → v3）

> r2 报告：`.superpowers/sdd/2026-10-01-config-center/review-design-r2.md`（含浅克隆实测与 compose 依赖语义实测）。

| r2 发现 | 处置 | 落在哪 |
|---|---|---|
| r2-C1 `service_healthy` 硬门与软依赖承诺冲突（实测：不健康时 no-op `up -d` 恒红、消费服务被停在 Created） | **不加 `depends_on` 硬门**；软依赖语义登记；C16 以 `up -d room-service` 天然构造 | D8-3、§5.2-9、C16 |
| r2-C2 C11 不可执行（追加纪律下恒红/空洞二选一） | C11 改 **workflow 前置断言**（起栈后、切片循环前）；理由写死 | C11、D8-1、§5.1-C |
| r2-I1 一致性判据已存在且落点不可行 | C18 改「**引用既有判据**（`rooms.base-score.test.ts:154-163`）」；D3 删「补一条」 | D3、C18 |
| r2-I2 §5.1 缺口（client-protocol / gateway 包 / :543 / http.ts / M-8 落空） | + **M/N/O/P** 四节 + `:539`/`:543` 合并行 | §5.1 |
| r2-I3 「两侧校验」与无构建页矛盾 | 校验**服务端一处**；页面不做校验（只形状提示） | D3 |
| r2-I4 凭证供给链三缺 | `ADMIN_PASSWORD` 进**三处**（stack + 起栈步 + 循环步）；dev 口令入 override；C6「未设」= 步骤级 unset+重建 | D8-1、C6、§5.1-C |
| r2-I5 网关缝四缺口 | 两套豁免分列（R462 挂点）；顺序 admin 鉴权→限流；跳过既有 IP 维；「失败计次」= 响应感知新实现点 | D6 |
| r2-I6 C15 桶污染后续切片 | 收尾**必须清失败计数键**（不能只等窗口） | C15 |
| r2-M1 引用漂移 | `deploy/Caddyfile:29-38`、`release.yml:78-86`、`message.router` 带 `src/gateway/` 目录 | §2.2、§2.4、§5.1-C |
| r2-M2 ops 脚本偏离 | 登记为**刻意偏离**（旧 tag v1.0.0/v1.0.1 实测无 `scripts/ops/` 文件，按 tag 取会坏） | D8-5②、§5.2-2 |
| r2-M3 C21 分层 | 静态判据 vs **发布后演练（验收项单列）** | C21、§6 |
| r2-M4 client `version` 无消费者 | 注明用途（留白） | D5 |
| r2-M5 C2 主体键/还原未写 | 写死（`friendRoomEnabled` 改库 + admin API 写回） | C2 |
| r2-M6 list 返空落层未写 | controller 入口（与 create/join 同层） | D4 |
| r2-M7 C20 谓词太松 | 200 + 管理页标志串 | C20 |
| r2 无法核验 ×6 | 边界如实登记；TypeORM 并发交错 ⇒ 规格层补并发单测；C17 步骤链 ⇒ 规格层给完整链 | r2 报告 §5 |
