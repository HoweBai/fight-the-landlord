# 记录片：对局记录 +「我的历史战绩」（**设计层 v1.2 · 定稿**）

> **状态**：v1.2 —— **定稿本**。已过**三轮**独立审查：r1（事实核验：39 条，成立 33/部分 4/不成立 2）· r2（完备性与可执行性：1🔴/4🟠/7🟡 + 十问答卷 + 核过 20 条）· **r3 修复验证（20/20 处置落地；2🟠+3🟡 小修已落：键数 11 / robotId 真源与读时机 / 旧会话窗口守卫 / 行号与计数）**。审查报告在 `.superpowers/sdd/2026-10-03-records/`（工作区工件不入库）。**设计层定稿**；规格层已可启动。
> **分层**：本文 = 设计层；形式化层另起 `docs/superpowers/specs/2026-10-03-records-spec.md`。
> **来源**：路线图 `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` 的 P1′「记录」+ 本会话用户裁决（§1.1）+ 实测探查（§2，全部带出处）。
> **本片不做**：风控（IP/deviceId 数据链 + 谓词框架 + `match:rejected`）——紧随其后的独立片 · actionLog 全量/出牌过程回放 · 货币列实现（P2 后接账本）· 后台/看板查询面。
>
> **2026-10-22 更新（机器人拟人昵称片，已取代本文相关结论）**：机器人（`user_id IS NULL`）的
> `nickname` 快照**不再恒 `NULL`** —— room-service 通过 `record.write.seats[].nickname` 提供展示昵称，
> user-service 原样落库；人类路径与「不暴露 `isRobot`」结论不变。
> 见 [机器人拟人昵称设计](2026-10-22-bot-display-nicknames-design.md)。

---

## 0. 一句话

每局结束把「**结算 + 发牌快照**」落进 MySQL（**一处写、幂等、不双写**）：game-service 在**发牌那一刻**给会话记初始手牌快照（新内部字段——结算时刻的 `hand` 是**残牌**，不可现取），结算时随 `game.ended` 的 `record` 信封带出（三家各 17 编码 + 底牌 3）→ room-service（有座位→userId、mode、时间戳）组装 → 新增 **room→user RPC** 写入 user-service 两张新表；玩家在大厅**点自己头像 →「历史战绩」**看自己的对局（身份/手牌/胜负/分数；**机器人不标注**——人类昵称今日恒空 ⇒ 同形回落「玩家{seat}」，零区分器）；保留期 = **配置中心第 10 键**（默认 365 天，可改）+ user-service 自建清理任务。

---

## 1. 输入

### 1.1 用户裁决（逐条，本设计不得与之冲突）

| # | 问题 | 裁决 | 来源 |
|---|---|---|---|
| 1 | 记录范围 | **结算 + 发牌快照**（三家初始手牌 + 底牌）；支持玩家查看自己的对战历史；展示：昵称 / 身份（地主·农民）/ 对局所有人手牌 / 胜负 / **输赢货币（列预留，可空）**；**不含**出牌过程（actionLog 全量另拍） | 本会话 |
| 2 | 保留期 | **可配置，默认 1 年** | 本会话 |
| 3 | deviceId | **采**（在风控片）；**仅服务器可见**、永不出站 | 本会话 |
| 4 | 历史入口 | 客户端**点击自己的头像** → 「历史战绩」选项 | 本会话 |
| 5 | 拆片 | **本片 = 记录 + 历史页**；风控（数据链 + 谓词）独立成片 | 本会话 |
| 6 | 货币时点 | 货币列**预留可空**；P2 落地后由**货币账本**（真源）写入或查询时联接——**不造第二本账** | 本会话（呈报已确认） |

### 1.2 既有约束（本仓纪律，逐条适用）

- **不可区分性**：机器人标识（`isRobot`/botId）与难度**永不出站**——本片新增**玩家可读的 REST**，其键集白名单是**全片唯一机械防线**（REST 无既有出站闸，§D7-C5），必须带判别力自证。
- **内部调用必须 RPC**：room 侧 `no-internal-http.gate.test.ts`（**模块名闭集 + 每文件正向断言**，非「白名单」；新条目须**同提交**补 `RPC_USAGE` 分支 + `RPC_CLIENTS`/`ROOM_CALL_SITES` 两张清单 + **手写探针正/负两行**——闸注释明文「只加名字不配负对照 = 无效补丁」）。
- **RPC 契约面三件套**（新边必须同提交）：`protocol/src/messages.test.ts` 的 pattern 清单（现「九个」，加 `recordWrite` 当场红）· `robot-availability-wiring.gate.test.ts`（J21：**每个 `RPC_PATTERNS` 条目必须有真接收侧**（键集合动态相等）+ 承载类经 `*.module.ts` 的 `controllers:` 注册）· `meta-on-every-rpc-send.gate.test.ts`（**每一处 `.send(` 实参必须出现 `metaFromTrace()`**，扫描面含 user-service）。
- **结算契约唯一**（settleGame 只此一份，R161/R187）；**`game.settlement` 不得多形状**（客户端零变化，§D1）。
- **EXPECTED_FILES 闭集 / I1 / M9**：本片不动工作流文件（conformance 全量循环按 `--list` 动态枚举 ⇒ 新切片追加进 `CASES` 即自动入 CI）。
- **判据只增不减**；baselines 按 CI 实测回填；每次改动一个 commit（CLAUDE.md）。
- **手册纪律**：r2 已核 `first-deploy.md` 两节**无表清单读数**、`backup.sh` 整库导出 ⇒ 新表天然在备份伞内，**无需改手册**（§D8 收口）。
- 用户**没有运维背景**：文档讲「玩家会看到什么」。

---

## 2. 现状（实测事实，全部带出处；行号经 r1 逐条核）

### 2.1 结算链路（本片是旁路接入）

| 环节 | 事实 |
|---|---|
| 结算实现 | `settleGame(session)`（**`shared/src/ddz/settle.ts:16`，全仓唯一**）；输出契约 `SettlementResult`（`protocol/src/views.ts:137-147`，9 字段） |
| 事件发布 | `game.service.ts` `publishEnded()`（**`:457-464`**）→ Redis `game:events` 发布 `{event:'game.ended', roomCode, version, result}`；`notifyRoomEnded()`（`:466-475`，**测试用**）payload **既无 record 也无 version** |
| 客户端广播 | `ws.gateway.ts:636`（订阅点 `:545`）`broadcast(roomCode,'game.settlement',version,result)`——**只带 result** |
| **发牌数据（v1.1 订正）** | ⚠️ **结算时刻 `players[].hand` 是残牌**（`play.ts:39-45` 逐张 `splice` 摘除；赢家 = 0 张；地主叫抢后 20 张 `bid.ts:145-152`），**`initialHands` 全仓不存在**（grep 0 命中）⇒ **初始手牌必须在发牌点采集**：`dealCards()`（`shared/src/ddz/game.ts:90-117`）新增 `session.initialHands` 快照（**流局重发** `bid.ts:185` 会再调 `dealCards`，两条路径天然覆盖；注释落入 `types.ts` 的「服务端内部字段」区、不出站）。`bottomCards`（`types.ts:59`，`bid.ts:167` 确认保留不清空）**结算时仍在场** ✓ |
| 卡编码 | `Card { r, s }`（`views.ts:14-19`）：`r∈{3–14,17,20,30}`、`s∈{0–4}`（R695/R696）；真实牌堆对账在 `shared/src/card/card.ts:57-70` |

### 2.2 落库归属（实测）

| 事实 | 依据 |
|---|---|
| MySQL 只在 user-service 与 config-service（同实例；user 默认 `migrations` 表、config `migrations_config`） | `user-service/src/database.config.ts` / `config-service/src/database.config.ts:36` |
| **room-service 没有 MySQL**（无 typeorm/mysql2） | room package.json |
| **user-service 当前无 TCP RPC**（片⑦删：提交 `0da4448`，删前形态含 `connectMicroservice({TCP, RPC_PORT ?? 3101})`；出处 = **片⑦规格 §1 表 L1**，非计划） | `git show 0da4448^:packages/user-service/src/main.ts` |
| ⚠️ **TCP 面不设应用层 token**（R223 成文）：全仓 3103/3105/3106 三条既有 RPC 边**都没有** token 守卫；安全边界 = compose `expose` 内网 + 宿主映射只在 override；bootstrap 的 `INTERNAL_SERVICE_TOKEN` 是**进程级** fail-closed | `game-service/src/main.ts:67` 等处逐字同款注释 |
| room 有 **no-internal-http 闸**（机制见 §1.2；**扫描面 = room 4 文件 + game 的 robot.client（共 5），不含 user-service**——r3-5 订正计数） | `room-service/test/no-internal-http.gate.test.ts:81-97,169-190` |
| users 表：`nickname varchar(50) NULL`（`InitialUsers.ts:35`）；注册 `nickname ?? null`（`auth.service.ts:31`）；客户端 `displayName = nickname \|\| phone \|\| userId` | 逐条已核 |

### 2.3 网关与 REST 面

| 事实 | 依据 |
|---|---|
| 逐路由显式转发（`forwardToUserSvc/ConfigSvc/RoomSvc`，方法体 `proxy.gateway.ts:514-580`，URL 直拼） | `gateway.controller.ts:61-266` |
| `X-User-Id` **注入与防伪**在 `auth/jwt.middleware.ts:101`（剥伪造）与 `:146`（验签后写入）；控制器 `headersOf()`（`:284-289`）透传 | 同上 |
| 公开白名单 = 恰五条精确匹配（`public-paths.ts:42-49`）；新 REST 不进白名单 = 默认验签 ✓ | 同上 |
| ⚠️ **现有全部转发无一条 GET query 先例**（静态路径或路径参数）；`PUT /api/admin/config/:key` 注释有 R75 查询走私纪律 | `gateway.controller.ts:120-133` |
| **REST 无既有出站闸**：`validateOutbound`/`FORBIDDEN_OUTBOUND_KEYS` 只作用于 WS S→C（`proxy.gateway.ts:372`）；REST `forward()` 是裸 fetch | `proxy.gateway.ts:582-627` |

### 2.4 配置中心

| 事实 | 依据 |
|---|---|
| 九键机制：`CONFIG_KEYS`（`protocol/src/config.ts:13-23`——r3-4 订正行号）+ 种子迁移 + 缓存三件套（启动退避拉取/专用连接订阅/60s 安全网） | room `config-cache.service.ts:182/266/98`；robot 侧同形 |
| **`parseConfigValue`（`config.ts:46-61`）是配置写入的唯一校验点**（末尾 `throw 未知配置键`）——新键不加分支 ⇒ 管理页写它被 400 拒 | 同上 |
| `protocol/src/config.test.ts:9-18`「**恰好九键**」硬清单（加第 10 键当场红，须同提交更新含测试名） | r1-F4 已核 |
| 消费模板两份（room/robot 的 `config.client.ts` + `config-cache.service.ts`）；user-service **零配置客户端**（仅一句退役注释） | 逐条已核 |
| 管理页**键驱动**（`admin/app.js:172` `Object.keys(currentConfig)`）⇒ 新键自动可见 ✓ | r1-36 已核 |

### 2.5 客户端

| 事实 | 依据 |
|---|---|
| 页面 = login/lobby/game/table（`pages.json` 四条） | 已核 |
| 大厅顶栏 = `PlayerChip :name="auth.displayName"` + 唯一「退出」按钮；明文忌讳「点了没反应的活按钮」 | `lobby.vue:181-186` |
| 牌面/弹层成件齐：`components/` 有 `Card.vue`/`Hand.vue`/`BottomCards.vue`/`Settlement.vue`；`game.vue` 有弹层先例 | 已核 |
| ⚠️ **表格页先例订正（r1-F5）**：`table.vue:271-273` 有 `nameOf(seat) = 我 / 玩家{seat}` 并渲染——**从无昵称渲染**；该 `玩家{seat}` 文案正是 §D4 同形回落的**既有先例** | 同上 |

### 2.6 展示面事实（不可区分性的地基；v1.1 订正）

- **游戏内客户端从不显示对手昵称**（table.vue 无 nickname/displayName 渲染；只有 `nameOf()` 的「我/玩家{seat}」）。
- 机器人**没有展示名**（robot-service 零 nickname/displayName）。
- ⚠️ **今日「同形」成立的真正原因（r2-B9 订正）**：**人类昵称也恒为空**——登录/注册只有手机号+密码，客户端**没有任何设置昵称的面**（`login.vue`；`auth.service.ts:31`）⇒ 历史页每个座位都落「玩家{seat}」，**零区分器**。这不是「可空是常态」的修辞，是当下事实。
- **触发登记（写死）**：任何引入「人类可设/可展示昵称」的切片，**必须同时解决机器人展示名**（否则历史页立刻变成统计识别器——全机器人房的三家全是「玩家N」而人类房出现真名）。

### 2.7 既有闸面（本片同提交机械面总表；§D7/§D8 引用）

| 闸 | 要求 | 本片动作 |
|---|---|---|
| `messages.test.ts:53-64` | §4.2 pattern 名逐字（现「九个」） | 同提交 +`recordWrite`，改清单与标题 |
| `robot-availability-wiring.gate.test.ts`（J21） | 每 pattern 有真接收侧（键集合动态相等）+ `controllers:` 注册 | user-service 落真 `@MessagePattern` + 模块注册 |
| `meta-on-every-rpc-send.gate.test.ts` | 七包 `src` 每处 `.send(` 带 `metaFromTrace()` | RecordClient 与 user 配置客户端**都**带 |
| `no-internal-http.gate.test.ts`（room） | `RPC_USAGE` 闭式 + 两清单 + **手写探针正/负** | 同提交五处（分支/两清单/探针两行） |
| `protocol/src/config.test.ts:9-18` | 恰好九键硬清单 | 同提交改（含测试名），属「按实测更新」非删判据 |
| `slice-10-settlement.ts:62,124` | `game.settlement` payload **恰好 9 键**（判别力有 N1 历史背书） | **C3 免费保险**——record/hands 泄漏会当场红（引用即可，不另起弱形态） |
| `parseConfigValue`（`config.ts:46-61`） | 唯一写入校验点 | 新键同提交加分支（1≤n≤3650） |

---

## 3. 设计决策

### D1 — 数据采集：发牌点快照 + `game.ended` 的 `record` 信封（内部通道，客户端零变化）

- **发牌快照（v1.1 核心订正；v1.2 补两处）**：`GameSession` 新增服务端内部字段 **`initialHands: Card[][]`**（按座位序；语义 = **发牌后、叫抢前**的 17×3 **冻结副本**——**必须切片/深拷贝**，不得与后续会被排序/摘除的 `hand` 共享引用（r3-6）；地主的两张多牌由 `bottomCards` 分列表达）——写入点 **`dealCards()`**（`shared/src/ddz/game.ts:90-117`；**流局重发** `bid.ts:185` 再次调用天然覆盖）；字段注释落 `types.ts` 的内部字段区并标「不出站」。⚠️ **部署窗口守卫（r3-3）**：旧会话（SESSION_TTL 1h 内）可能无 `initialHands` ⇒ **`publishEnded` 对无快照的会话「不带 record 发布」、绝不抛**（异常不得阻断 `game.ended`；去向 = 既有 `!record` 跳过闸 + WARN）——「张数不符 ⇒ 抛」只许留在 **C1 编解码器**这一层。
- **信封**（`publishEnded()` 追加；`result` 不动）：
  ```
  record: {
    startedAt: session.createdAt,          // 开局时刻真源 = 会话创建（types.ts:131-132；房间侧无此戳）
    seats: [ { seat, playerId, hand:<34 hex> } ×3 ],   // hand 自 initialHands；playerId = players[].id
    bottomCards: <6 hex>
  }
  ```
  - `isBot`/`robot_id` **不进信封**——真源在 room 侧（§D2）。
  - 编码/解码唯一实现：`protocol/src/records.ts`（`encodeHand/decodeHand/encodeCards/decodeCards`）；**前置条件写死：入参张数不符（≠17/≠3）⇒ 抛**（与 C1 非法输入同族）。
- **跳过判据写死**：`!record || !version` ⇒ room 侧跳过写入 + WARN（`notifyRoomEnded` 路径两者都缺，天然覆盖）；**房间数据缺失/座位数与信封不符**（房键 TTL 窗口）⇒ 同样跳过 + WARN，后果并入「已接受窗口」台账（§D8）。
- **「不记」面显式声明**：**只有到达结算（`game.ended`）的对局才产记录**——waiting 取消/超时回收/playing 中重启丢会话的对局不产记录（口径 = 记录范围即结算事件）。
- **客户端零变化**：`record` 在 room 消费后**丢弃、不转发**；`game.settlement` 仍只发 `result`（C3 由 slice-10 恰好 9 键断言锁死）。

### D2 — 写入编排：room 组装 → **新增 room→user RPC**（一处写、事务、幂等）

- 组装字段：`{ roomCode, gameVersion, mode, baseScore, result(全量), seats:[{seat, userId, isRobot, robotId, hand}], bottomCards, startedAt, endedAt }`。
  - **`isRobot` 真源 = room 侧 `Seat.isRobot`**（单一真源，不得与信封并存两套；game 侧 `session.botIds` 仅作旁证）。
  - **`robotId` 真源 = `room:{code}:bots` Hash**（`rooms.bots.ts:34-44` 写入形态 = `HSET field=<座位号> value=<内部botId>`）——**按座位号对齐读出**（现有 `readBotBindings` 会把座位键丢掉，混合房照抄会错位）。⚠️ **读时机写死（r3-2）：`game.ended` 分支顶部先读一次、供机器人归池与组装共用**——归池是 fire-and-forget（`ws.gateway.ts:650→730` 的 DEL），晚读会静默取到 NULL（无任何跳过/WARN）。
  - **`userId` 写入规则写死**：人类 = `Seat.userId`（真用户 id）；**机器人座 ⇒ NULL**（绝不写 displayId）。
  - `startedAt` 从信封取（**不留「实现期核」**）；`endedAt` = room 收事件时刻。
- **RPC 形态**：`record.write`；`protocol/src/rpc.ts` 增 `RPC_PATTERNS.recordWrite = 'record.write'` + 请求/响应类型（响应 = **`RpcResult<{written:boolean}>`**，照 `rpc.ts:70-72` 既有信封）；room 侧新 `RecordClient`（超时 3s、不重试、**发送侧 `...metaFromTrace()`**）。⚠️ **user-service 重挂 TCP**：端口 **3101**（片⑦删前形态为范本：`git show 0da4448^`；`connectMicroservice → startAllMicroservices → listen` 顺序照 `game-service/src/main.ts:69-84`）；**不设**应用层 token（R223）；bootstrap `INTERNAL_SERVICE_TOKEN` fail-closed 保持既有行为。
- **幂等**：唯一键 `(room_code, game_version)`；重复投递 ⇒ 命中既有行时**比对 `ended_at`**，|差| 超阈值 ⇒ **error 级日志**（响亮不静默——码复用静默吞的保险）；否则 `data.written = false` 返回。
- **事务**：`dataSource.transaction` 内写 1 行 `game_records` + 3 行 `game_record_players`（防「有记录无 players」孤儿）。
- **失败姿态**：写入与结算广播**解耦**（各自独立 await + try）；失败 = error 级九字段日志 + 台账登记「room→user 单次尝试失败即丢该局记录」（与 pub/sub at-most-once 同族；**不静默**）。

### D3 — 表结构（user-service 新迁移 `1789400000000-GameRecords.ts`，照 `1789100000000-BaseScoreLevels.ts` 形状）

```sql
CREATE TABLE game_records (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_code      VARCHAR(16)  NOT NULL,
  game_version   INT          NOT NULL,
  mode           VARCHAR(16)  NOT NULL,          -- random | practice（practice = 好友房/手动房）
  base_score     INT          NOT NULL,
  winner         VARCHAR(8)   NOT NULL,          -- landlord | farmer
  landlord_seat  TINYINT      NOT NULL,
  multiplier     INT          NOT NULL,
  spring         VARCHAR(16)  NOT NULL,          -- none | spring | anti-spring
  landlord_score_change INT   NOT NULL,
  farmer_score_change   INT   NOT NULL,
  bottom_cards   CHAR(6)      NOT NULL,          -- 3 张 × 2 hex
  started_at     DATETIME(3)  NOT NULL,          -- 自信封（会话创建时刻）
  ended_at       DATETIME(3)  NOT NULL,
  created_at     DATETIME(3)  NOT NULL,
  UNIQUE KEY uk_room_version (room_code, game_version),
  KEY idx_ended_at (ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE game_record_players (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  record_id    BIGINT       NOT NULL,
  seat         TINYINT      NOT NULL,
  user_id      VARCHAR(64)  NULL,                -- 人类真 id；机器人 = NULL（绝不写 displayId）
  is_robot     TINYINT(1)   NOT NULL,            -- 🔴 定死（P3 榜过滤复用；永不出站）
  robot_id     VARCHAR(64)  NULL,                -- 内部 botId（非 displayId）
  nickname     VARCHAR(50)  NULL,                -- 快照；宽度 = users.nickname 同宽（r2-11 订正）
  role         VARCHAR(8)   NOT NULL,            -- landlord | farmer
  score_change INT          NOT NULL,
  won          TINYINT(1)   NOT NULL,
  hand         CHAR(34)     NOT NULL,            -- 17 张 × 2 hex（自 initialHands）
  money_delta  INT          NULL,                -- 🔴 预留（P2 货币账本落地后写；P1 恒 NULL）
  ended_at     DATETIME(3)  NOT NULL,            -- 冗余（keyset 排序 + 清理）
  KEY idx_user_ended (user_id, ended_at),
  KEY idx_ended_at (ended_at),                   -- 🔴 清理用（r2-11 订正：光有 idx_user_ended 服务不了纯 ended_at 范围）
  KEY idx_record (record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- `score_change`：landlord 座位 = `landlordScoreChange`，farmer 座位 = `farmerScoreChange`（`settle.ts:35-50` 已核）；`won` =（role 与 winner 一致）。
- 昵称快照 = handler 内按 `user_id` IN 查 users 表；`user_id IS NULL`（机器人）⇒ `nickname = NULL`。
- **不建 TTL**（MySQL 无此物）——清理见 D5。

### D4 — 读取面：`GET /api/records/mine`（只本人；白名单 DTO）

- 网关新路由 → `forwardToUserSvc('GET', '/api/records/mine', …)`；**不进公开白名单** = 默认 JWT 验签（`jwt.middleware.ts:101/146`）。
- ⚠️ **网关 query 透传是新机制**（无 GET query 先例）：按 R75 查询走私纪律做编码（`cursor` 含 `,` 须 URL 编码）；**编码规则收在服务端内部**——`nextCursor` 为**不透明字符串**，客户端原样回传。
- 查询：`JOIN`，`WHERE user_id = :X-User-Id`，`ORDER BY ended_at DESC, id DESC`（keyset；游标 = 服务端内编码的 `(ended_at, id)`）。
- **时区口径**：DTO `endedAt` 与游标一律 **epoch 毫秒整数**（本仓毫秒时间戳惯例）；`limit` 缺省 20、**上限 100、服务端 clamp**（超出截断）。
- 响应 DTO（**字段即白名单**）：
  ```ts
  interface MyRecord {                  // 11 键
    roomCode: string; mode: 'random' | 'practice';
    endedAt: number;                    // epoch ms
    baseScore: number; winner: 'landlord' | 'farmer';
    landlordSeat: number; multiplier: number;
    spring: 'none' | 'spring' | 'anti-spring';
    mySeat: number;                     // 🔴 v1.1 新增（r2-2）：服务器从 JOIN 命中行取——「我的身份/分数」才能呈现
    bottomCards: Card[];                // 3 张（解码后）
    players: Array<{                    // 按座位序，恒 3 条；6 键/条
      seat: number; nickname: string | null;
      role: 'landlord' | 'farmer'; scoreChange: number; won: boolean;
      hand: Card[];                     // 17 张
    }>;
  }
  interface MyRecordsPage { items: MyRecord[]; nextCursor: string | null }
  ```
- 🔴 **不可区分性**：机器人座位 `nickname=NULL`；**今日人类昵称也恒空**（§2.6）⇒ 客户端统一回落「**玩家{seat}**」（`table.vue:271-273` 的既有文案）——**零区分器**。响应 **不含**：`userId`/`playerId`（信封的）/`robotId`/`isRobot`/`deviceId`/`money_delta`。手机号绝不进对手展示面。

### D5 — 保留期：配置中心第 10 键 + user-service 清理任务

- **配置键 `record.retentionDays`**：int、校验 `1 ≤ n ≤ 3650`——① `CONFIG_KEYS` 第 10 键（protocol）；② **`parseConfigValue` 同提交加分支**（唯一校验点，否则管理页 400）；③ config-service 种子迁移（默认 **365**）；④ `protocol/src/config.test.ts` 恰好九键清单同提交更新（含测试名）；⑤ 管理页自动可见（键驱动 ✓）。
- **user-service 接第一条配置消费链**：克隆 room 模板（`config.client.ts` 超时 3s + **`...metaFromTrace()`**；`config-cache.service.ts` 专用连接订阅 + 安全网）+ 测试 env 两枚照 `CONFIG_SYNC_*` 口径（**空串=未设、生产不设**）；getter `retentionDays()` 缺省回落 365。登记：这条是 M0.3「暂停注册/登录」的前置的一半。
- **清理任务**：自调度自重排（`setInterval`→`setTimeout`，每轮读缓存）；**节奏写死：默认间隔 1h + 启动后 30s 首轮 + 测试注入面 `RECORDS_CLEANUP_INTERVAL_MS`**（仿 `CONFIG_SYNC_*`，conformance 起容器时注入短值 ⇒ C6 可执行）；批删（`LIMIT 1000` 循环）两表（均按 `ended_at` 索引）。**多实例登记一行**：DELETE 幂等、per-实例读缓存互不干扰（无需锁；先例登记形态见 `rooms.start.ts:88-104`）。
- 备份交互：记录表在 MySQL 实例内 ⇒ 备份伞内（r1-35 已核 `backup.sh:131` 整库导出）。

### D6 — 客户端：头像入口 + 历史页（第 5 页）

- **入口**：`lobby.vue` 顶栏 `PlayerChip` 包一层可点容器 → 页内弹层（1 项也做列表结构）→「历史战绩」→ `uni.navigateTo('/pages/history/history')`。**`pages.json` 同提交注册第 5 页**（否则真机导航失败——单测看不见的形态）。
- **模式标签映射写死**：`random →「匹配」`、`practice →「好友房」`——**不得出现「练习」字样**（本仓不存在练习房，误标会让好友房玩家看到错误模式名）。
- **历史页**：列表（倒序、`onReachBottom` 翻页、`nextCursor` 原样透传）+ 卡片：时间 / 模式 / **我的身份与胜负**（自 `mySeat` 定位）/ 我的分；点击展开：三家明细（昵称或「玩家{seat}」、身份、分、**手牌 17 张**）+ 底牌 3 张——牌面**复用** `components/` 现成件。空态/失败态照既有惯例；素材槽位按「元素名 + 尺寸」登记。

### D7 — 判据与闸（初稿）

- **C1 编码**：`protocol/src/records.ts` 单测——54 张全集往返、17×2/3×2 定长、**张数不符 ⇒ 抛**（仅编解码器层）；**+ 发牌采集单测**：`dealCards` 后 `initialHands` 恰 17×3 且与当次 hands 的**冻结副本**一致（**后续出牌摘除/排序不得影响快照**——r3-6）；**流局重发后快照被覆盖**（旧快照不留）；**+ 窗口守卫**：无 `initialHands` 的会话走发布路径 ⇒ **不带 record 且不抛**（r3-3）。
- **C2 幂等**：`tools/conformance/src/lib/rpc.ts` 的 `rpcCall` 直投 user-service **3101 ×2**（零依赖 TCP 探针，`slice-07.2-rpc` 先例）⇒ 恰一组行（`compose exec mysql` 查，`slice-14` 先例）+ **断言 `data.written`**（第二次 false）。**前提：override 补 `3101:3101`**（片⑦删前形态）。
- **C3 客户端零变化**：**引用 slice-10 的恰好 9 键断言**（record/hands 泄漏自动红；判别力有 N1 历史背书）——不另起弱形态。
- **C4 只本人**：双账号（`registerUser` 先例）——A 查得自己的局；**B 的 roomCode 绝不出现在 A 的响应**（负对照）。
- **C5 响应白名单（不可区分性；全片唯一机械防线）**：用 **`fieldSetViolations` 式递归恰好键集**（`assert.ts:135` 形态；**不得复用 `assertNoLeak`**——其 `LEAK_KEYS` 含 `players`，记录响应合法地有它，误用假红）；**逐节点键集清单**：`MyRecord` **11 键** / player 6 键 / `Card {r,s}` 2 键 + **数组长度断言**（players 恒 3、hand 恒 17、bottomCards 恒 3）；**判别力自证**（正/负对照，形态照 `slice-10:62,124`）。
- **C6 保留期即生效**：改键走管理面（slice-14 先例）+ `compose exec mysql` 造旧行 + **容器注入 `RECORDS_CLEANUP_INTERVAL_MS` 短值** ⇒ 清理轮删掉；改回 ⇒ 不再删新记录。
- **C7 失败姿态**：停 user-service ⇒ 打一局 ⇒ 结算广播**照常** + room 日志有 error 行 + 恢复后可写。⚠️ **候选风险（登记）**：Nest `ClientProxy` 在目标重启后的**重连性本仓未验过**——C7 后半条会把它逼出来；若不自动恢复 ⇒ 实现层处置（属 C7 覆盖面）。
- **C8 RPC_USAGE**：同提交五处（§2.7 行 4）。
- **C9 迁移**：列形状/唯一键/三索引（`migration.test.ts` 惯例；`migrationsRun: true` 容器启动即执行）。
- **既有判据影响面（同提交）**：§2.7 全表的六项 + `ws.gateway` 广播测试（record 缺失路径保持绿）+ `packages/protocol/src/rpc.ts:14-16` 传输形态注释（3101 复活 ⇒ 订正）。

### D8 — 修订面与登记

| 处 | 改法 |
|---|---|
| `docs/design.md` | 第 10 配置键、记录服务面（REST/RPC/表）、user-service 重挂 TCP（3101 复活 + R223 口径） |
| `docker-compose.yml` / override | user-service 块加回 `expose: 3101` + dev 映射 `3101:3101`（片⑦删前形态 `git show 0da4448^`）；**C2 的前提** |
| 台账 `deviation-ledger.md` | ①「room→user 单次尝试失败即丢该局记录」②「房间数据缺失/形状不符 ⇒ 跳过」③码复用 duplicate 比对告警语义 ④清理任务多实例登记 |
| 路线图 | P1 记录片状态（收口时） |
| baselines | 新 slice 追加 `CASES` 末尾（工作流零改动）；`full` 列 CI 回填；render 列不进 |
| 手册 | **已核无需改**（r2：两节无表清单；整库导出自动覆盖新表）——本条从 v1 的「实现期 grep」收口 |
| 同提交机械面 | §2.7 六项 + `parseConfigValue` + `pages.json` + `rpc.ts` 注释 + `RPC_CLIENTS`/`ROOM_CALL_SITES` + 探针两行 |

---

## 4. 兼容面与风险

| 面 | 风险 | 缓释 |
|---|---|---|
| **发牌采集** | 新字段进 `GameSession`（经 `saveSession` 落 Redis，54 张数据量可忽略）；漏掉流局重发路径 ⇒ 快照是上一局 | C1 的「重发覆盖」用例 |
| **user-service 重挂 TCP** | 片⑦刚删、理由（退役）与现在（新边）不同——代码注释写清「为什么加回」；**不设 token**（R223，r1-F2 订正）；安全边界 = expose 内网 + 宿主映射仅 override | 范本 `git show 0da4448^` + `game-service/src/main.ts:69-84` 顺序 |
| 记录丢失窗口 | room→user 单次尝试失败即丢（解耦的代价）| 台账登记；幂等键已就位、未来可加重试 |
| 码复用静默吞 | `(roomCode, version)` 撞车概率极低（36⁶ × version 相同）但存在 | duplicate 时 `ended_at` 比对 + error 日志（一行保险） |
| 不可区分性 | 今日零区分器（人类昵称恒空）**是事实、不是保证** | §2.6 触发登记写死；C5 键集闸 |
| 清理任务 | 长事务（批删已缓）· 多实例（幂等已登记） | 节奏注入面（C6） |
| REST 出站 | **无既有出站闸** | C5 即唯一防线 ⇒ 必须带判别力自证 |
| no-internal-http 面 | 该闸不扫 user-service（**答案已收口，不需等价面**）；user 侧唯一新发送点（配置客户端）被 meta 闸覆盖 | §2.7 |

## 5. 判据计划

见 §D7（C1–C9；形式化编号与判别力自证在规格层细化）。

## 6. 明确不做（防歧义）

actionLog 全量/出牌过程（另拍）· 货币列**实现**（P2 后接账本）· 风控链与谓词（下一片）· 后台/看板查询 · 记录导出 · 删除单条记录（保留期统一清理）· 历史页搜索/筛选（YAGNI）。

## 7. 风险

见 §4 表（重点：发牌采集的重发路径 / TCP 重挂口径 / C7 的 ClientProxy 重连性候选风险）。

## 8. 下一步

1. 本文（v1.1）**过修复验证轮（r3）**（r1/r2 各条处置是否落地 + 新引入一致性）；
2. 定稿 ⇒ 规格层 → 审规格；
3. 计划 → 审计划 → 实现 → 自测 → 收口。

---

## 附录 A — 审查处置表（v1 → v1.1）

> 两路独立审查：r1（事实核验，39 条：成立 33/部分 4/不成立 2）· r2（完备性与可执行性：1🔴/4🟠/7🟡 + 十问答卷 + 核过 20 条）。

| # | 来源 | 发现 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | r1-F1 = r2-🔴R2-1 | **发牌快照无来源**（结算时刻 hand 是残牌；全仓无初始快照） | **采纳 A 案（采集）**：`GameSession.initialHands` 新字段 + `dealCards()` 写入（含流局重发覆盖）+ 信封只作载体；D1/§0/§2.1 全面订正 | §0 · §2.1 · D1 · C1 |
| 2 | r1-F2 | 「TCP 面 fail-closed token 检查」不成立（R223：TCP 不走中间件、全仓无 token 守卫） | **采纳**：改写为 R223 口径（expose 内网 + 不发布宿主端口 + bootstrap 进程级 fail-closed + 顺序范本） | §2.2 · §D2 · §4 |
| 3 | r1-F3 / r2-🟡R2-12 | RPC 契约面漏三闸（meta 闸 / messages 清单 / J21 接收侧）；「白名单/自动覆盖」表述不实 | **采纳**：新增 **§2.7 既有闸面总表**；D7-C8/D8 改「同提交五处（分支+两清单+手写探针两行）」 | §1.2 · §2.7 · D7 · D8 |
| 4 | r1-F4 | `config.test.ts` 恰好九键硬清单会当场红 | **采纳**：D5 第 ④ 项 + §2.7 表 | D5 · §2.7 |
| 5 | r1-F5 | 「table.vue 全文无 name」字面不成立（有 `nameOf()` 先例） | **采纳**：§2.5/§2.6 订正——`玩家{seat}` 是同形回落的**既有先例**（反向加强论证） | §2.5 · §2.6 · D4 |
| 6 | r1-F6 = r2-🟠R2-5.1 | `startedAt` 房间侧不存在、留白不可接受 | **采纳**：**`startedAt = session.createdAt`**，game 侧放进信封；D2 删除「实现期核」 | D1 · D2 |
| 7 | r1-F7 | 行号小错（publishEnded `:457-464`；L1 出处=片⑦**规格** §1 表；X-User-Id 在 `jwt.middleware.ts:101/146`） | **采纳**：逐处订正 | §2.1 · §2.2 · §2.3 |
| 8 | r1-F8 | `notifyRoomEnded` 同时缺 `version` | **采纳**：跳过判据写死 `!record \|\| !version` | D1 |
| 9 | r2-🟠R2-2 | DTO 缺 `mySeat` ⇒ D6「我的」不可实现 | **采纳**：`MyRecord` +`mySeat`（JOIN 命中行取），C5 键集同步 **11 键**（r3-1 订正计数） | D4 · D7-C5 |
| 10 | r2-🟠R2-3 | 清理节奏未定 ⇒ C6 不可执行 | **采纳**：默认 1h + 启动后 30s 首轮 + 注入面 `RECORDS_CLEANUP_INTERVAL_MS`；多实例登记一行 | D5 · D7-C6 · D8 |
| 11 | r2-🟠R2-4 | C5 机制两陷阱（`assertNoLeak` 含 `players`；REST 无既有出站闸） | **采纳**：`fieldSetViolations` 式递归恰好键集 + 逐节点键集/长度清单 + **判别力自证** | D7-C5 · §4 |
| 12 | r2-🟠R2-5.2/.3 | `GamePlayer.isBot` 恒 false（真源是 `botIds`/`Seat`）；`robot_id` 误取 displayId | **采纳**：`isRobot` 真源 = room `Seat.isRobot`（单源）；`robotId` = 内部 botId；`user_id` 机器人 ⇒ NULL（绝不写 displayId） | D2 · D3 |
| 13 | r2-🟡R2-6 | 「不记」面与房间缺失降级未声明 | **采纳**：D1 显式声明「只有到达结算才产记录」+ 房间缺失 ⇒ 跳过 + WARN（并入台账） | D1 · D8 |
| 14 | r2-🟡R2-7 | 码复用下 `ON DUPLICATE` 静默吞 | **采纳**：duplicate 时 `ended_at` 比对 + error 日志（一行保险） | D2 · §4 |
| 15 | r2-🟡R2-8 | mode 语义与标签未钉 | **采纳**：`practice = 好友房/手动房` 登记；标签写死「匹配/好友房」（**禁「练习」字样**） | D3 · D6 |
| 16 | r2-🟡R2-9 | 昵称统计面：今日零区分器成立（**因为人类昵称也恒空**）+ 将来触发 | **采纳**：§2.6 订正根因 + 触发登记写死 | §2.6 |
| 17 | r2-🟡R2-10 | 游标/时区/上限/网关 query 透传四处未钉 | **采纳**：epoch ms 口径 + 不透明 `nextCursor`（编码收在服务端）+ limit clamp 100 + R75 纪律 | D4 |
| 18 | r2-🟡R2-11 | 表结构小修（nickname 50 / players 清理索引 / 事务 / `recorders` 错字 / `RpcResult` 形状） | **采纳**：逐处改（含 D3 SQL） | D2 · D3 |
| 19 | r2-🟡R2-12 | 同提交机械面（`parseConfigValue` 分支 / `pages.json` / `rpc.ts` 注释 / RPC_CLIENTS+探针） | **采纳**：D5 ② · D6 · D8 表 | D5 · D6 · D8 |
| 20 | r1「没能核验」5 项 + r2 核过 20 条 | 运行时事实（带宽/锁/丢包率）留实测面；备份伞/工作流闭集/手册/台账/入口纪律等 20 条核过无误 | **登记**：运行时面并入 C6/C7 真栈判据；核过项不动作 | §D7 · §4 |
| 21 | r3（修复验证） | 🟠 键数三处「10」实为 **11**；🟠 `robotId` 真源实为 `room:{code}:bots` Hash 且被归池并发清除（须钉读时机）；🟡 旧会话无快照时「抛」会吞掉整条 `game.ended`（须守卫）；🟡 行号/计数三处 | **采纳**：逐处落文（键数 11 / bots Hash+分支顶部先读 / 发布路径永不抛+守卫用例 / `config.ts:13-23` / 扫描面计数 / 冻结副本） | D1 · D2 · D4 · D7 · §2.2 · §2.4 |
