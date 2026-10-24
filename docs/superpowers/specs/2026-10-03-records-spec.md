# 记录片：对局记录 +「我的历史战绩」（**规格层 v1.1 · 定稿**）

> **状态**：v1.1 —— **定稿本**。已过独立规格审查（0🔴/5🟠/10🟡，处置见 §0；审查报告 `.superpowers/sdd/2026-10-03-records/review-spec-r1.md`）。设计层 = `docs/superpowers/specs/2026-10-03-records-design.md` **v1.2（定稿）**（三轮审查，附录 A 21 行处置）。
> **来源标注**：每行/每条判据的 `来源` 列回指设计条款（D1–D8 与 §编号）。
> **口径**：事实依据见设计 §2（全部实测带出处）；本文只写「改什么、改成什么、怎么判」。
>
> **2026-10-22 更新（机器人拟人昵称片，已取代本文相关结论）**：`record.write` 的 `seats[]`
> 新增可选 `nickname`（仅机器人座）；机器人昵称快照**不再恒 `NULL`**。人类路径不变。
> 见 [机器人拟人昵称设计](2026-10-22-bot-display-nicknames-design.md)。

---

## 0. 修订对账

### v1.1 相对 v1（规格审查处置：0🔴 / 5🟠 / 10🟡）

| # | 问题 | 处置 |
|---|---|---|
| S-1 | 改动面漏**网关新路由**行（设计 D4 明文要求） | +`I1` 行（`@Get('records/mine')` → `forwardToUserSvc`，不进白名单=默认验签）⇒ 38 行 |
| S-2 | B2 测试路径错（`src/game/` → 实为 `test/`） | 订正 |
| S-3 | r3-6 的「**排序后**副本」半句未带进规格 | A8/C2 订正（`game.ts:104-107` 排序形态） |
| S-4 | C8 注入链缺一环（compose 透传行） | E1 补 `RECORDS_CLEANUP_INTERVAL_MS=${…:-}`（先例 :288-289）+ §2.5 引用 |
| S-5 | §4 漏一条必红：config-service 静态九行 SEED vs 动态清单 | §4 +第 9 项（含 admin.controller.test / config-probe 失真面） |
| 🟡 | G1 编号滑点 / codec 值域「包络 vs 合法集」（包络内非法值须抛）/ C9 先例欠准（真先例 `slice-14:432/442`；ClientProxy 重连已有绿证） | 逐处订正 |

### v1（首版）

形式化增量：① 改动面**行级**表（§1）；② 新契约写死（§2：codec / RPC / DTO / 游标 / 清理节奏 / DDL）；③ 判据 C1–C11 形式化（§3）；④ 会红的既有判据同提交清单（§4）；⑤ conformance 与回填（§5）。

---

## 1. 改动面一览（**38 行**：protocol 9 · game 2 · room 5 · user 8 · **api-gateway 1** · 编排 3 · client 5 · conformance 2 · 文档/台账 3）

> **新** = 新文件；**改** = 修改。

| # | 仓/包 | 文件 | 改动 | 来源 |
|---|---|---|---|---|
| A1 | protocol | `src/records.ts`（**新**） | `encodeHand/decodeHand/encodeCards/decodeCards`：每张牌 1 字节 `r*5+s`（**合法集 = `{3–14,17,20,30}×5+{0–4}`，包络 15–154；包络内非法值如 75（r=15）亦须抛**——r3/spec-r1 订正）、**定长 hex**（hand 34 / cards 6）；**张数不符（≠17/≠3）或值域外/非法值 ⇒ 抛**（中文原因） | D1 |
| A2 | protocol | `src/records.test.ts`（**新**） | C1 用例（全集往返/定长/非法抛） | D1 |
| A3 | protocol | `src/rpc.ts` | + `RPC_PATTERNS.recordWrite = 'record.write'` + `RecordWriteRequest/Response`（响应 = `RpcResult<{written:boolean}>`）；**`:14-16` 传输形态注释订正**（3101 复活——r2-12.3） | D2 |
| A4 | protocol | `src/messages.test.ts:53-64` | pattern 清单「九个」→「十个」+`recordWrite`（**同提交**，含标题——r1-F3） | §2.7 |
| A5 | protocol | `src/config.ts` | `CONFIG_KEYS` 第 10 键 `record.retentionDays` + **`parseConfigValue` 分支**（int、`1 ≤ n ≤ 3650`、抛中文原因——唯一校验点，r2-12.1） | D5 |
| A6 | protocol | `src/config.test.ts:9-18` | 恰好九键 → 恰好十键（**含测试名**——r1-F4） | D5 |
| A7 | shared | `src/ddz/types.ts` | `GameSession` + **`initialHands?: Card[][]`**（可选——T2 审查订正：旧会话反序列化无键/未发牌 = 假值，与 C3 守卫公式同构；内部字段区注释「不出站」；**冻结副本**语义） | D1 |
| A8 | shared | `src/ddz/game.ts` | `dealCards()` **在内部排序之后**写 `initialHands`（**切片/深拷贝**，不与 `hand` 共享引用——`game.ts:104-107` 排序形态；spec-r1-S3 订正：不写排序后副本则 C2 的「与当次 hands 一致」恒假红）；流局重发路径天然覆盖 | D1 |
| A9 | shared | `src/ddz/game.test.ts` | C2 用例（17×3/冻结/重发覆盖） | D1 |
| B1 | game-service | `src/game/game.service.ts` | `publishEnded()` 附 `record` 信封（`startedAt = session.createdAt`；`seats[{seat, playerId, hand}]` 自 `initialHands` 编码；`bottomCards`）；**无快照 ⇒ 不附 record、绝不抛**（窗口守卫——r3-3） | D1 |
| B2 | game-service | `test/game.service.redis.test.ts` | C3 用例（信封形状 + 窗口守卫路径） | D1 |
| C1 | room-service | `src/gateway/ws.gateway.ts` | `game.ended` 分支：**顶部先读一次 `room:{code}:bots`**（座位对齐，供归池与组装共用——r3-2）；组装 + 调 `RecordClient`，**与广播各自独立 try**；`!record \|\| !version` ⇒ 跳过+WARN；房间数据缺失/形状不符 ⇒ 跳过+WARN | D1/D2 |
| C2 | room-service | `src/gateway/record.client.ts`（**新**） | TCP client（user-service:3101）；超时 3s、**不重试**、发送侧 `...metaFromTrace()`；装配照 `config.client` 范本 | D2 |
| C3 | room-service | `src/gateway/rpc.options.ts` | + `USER_SERVICE_RPC_HOST/PORT`（默认 `user-service`/`3101`） | D2 |
| C4 | room-service | `test/no-internal-http.gate.test.ts` | **同提交五处**：`RPC_USAGE` 闭集 +`recordWrite` 分支；`RPC_CLIENTS`/`ROOM_CALL_SITES` 两张清单 +record.client；**手写探针正/负两行**（闸注释：只加名字不配负对照 = 无效补丁——r1-F3） | §2.7 |
| C5 | room-service | `test/ws.gateway*.test.ts` | 既有 settlement 广播测试保持绿；+ 组装路径用例（跳过判据三态） | D2 |
| D1 | user-service | `src/rpc/record.rpc.controller.ts`（**新**） | `@MessagePattern(RPC_PATTERNS.recordWrite)`；payload 校验；**事务**写 1+3 行（`dataSource.transaction`）；幂等 `(room_code, game_version)`——duplicate 时**比对 `ended_at`**，|差|>阈值 ⇒ **error 日志**，否则 `data.written=false`；昵称快照按 `user_id` IN 查（机器人 NULL） | D2/D3 |
| D2 | user-service | `src/records/records.service.ts` + `records.controller.ts`（**新**） | `GET /api/records/mine`：`WHERE user_id = :X-User-Id`（等值写死）；keyset（`ended_at DESC, id DESC`）；`mySeat` 自 JOIN 命中行；epoch ms；`limit` 缺省 20 / **上限 100 / clamp**；`nextCursor` **不透明字符串**（编码收在服务端） | D4 |
| D3 | user-service | `src/records/records-cleanup.service.ts`（**新**） | 自调度（`setTimeout` 自重排）；**默认 1h + 启动后 30s 首轮 + 注入面 `RECORDS_CLEANUP_INTERVAL_MS`**（仿 `CONFIG_SYNC_*`：空串=未设、生产不设）；批删两表（`LIMIT 1000` 循环，均按 `ended_at` 索引）；九字段日志 | D5 |
| D4 | user-service | `src/config/config.client.ts` + `config-cache.service.ts`（**新**） | 克隆 room 模板（超时 3s、`...metaFromTrace()`、专用连接订阅、60s 安全网）；getter `retentionDays()` 缺省 365；测试 env 两枚 | D5 |
| D5 | user-service | `src/migrations/1789400000000-GameRecords.ts`（**新**） | 两表 DDL（§2.6 逐字）+ 唯一键 + 三索引 | D3 |
| D6 | user-service | `src/main.ts` | **重挂 TCP**：`connectMicroservice({TCP, port: RPC_PORT ?? 3101})` + `startAllMicroservices()`（删前形态 `0da4448^` 为范本；顺序照 `game-service/src/main.ts:69-84`）；**不设**应用层 token（R223）；bootstrap `INTERNAL_SERVICE_TOKEN` fail-closed 保持 | D2 |
| D7 | user-service | `src/app.module.ts` | 装配 rpc controller（**J21 要求的 `controllers:` 注册**）+ records 模块 + config 模块 | D2 |
| D8 | user-service | `test/`（**新**×4 + 改×1） | `record.rpc.test.ts`（写/幂等/事务回滚/昵称快照）、`records.query.test.ts`（只本人/游标/limit）、`records-cleanup.test.ts`（**时钟注入**）、`migration.test.ts` 扩列形状、`config-cache.test.ts`（缺省 365） | D2/D3/D5 |
| E1 | 编排 | `docker-compose.yml` + `docker-compose.override.yml` | user-service：`expose` 加回 `3101`（基文件）+ dev 映射 `3101:3101`（override）+ **`RECORDS_CLEANUP_INTERVAL_MS=${RECORDS_CLEANUP_INTERVAL_MS:-}` 空默认透传**（C8 注入链的一环；先例 `docker-compose.yml:288-289`）——**C4 幂等真栈用例的前提** | D2 |
| E2 | 编排 | `docker-compose.yml`（注释） | 端口叙事注释与 3101 复活对齐（r2-12.3） | D2 |
| E3 | config | `config-service/src/migrations/`（**新**种子迁移） | 第 10 键种子 `record.retentionDays = 365` | D5 |
| F1 | client | `src/pages.json` | 注册第 5 页 `pages/history/history`（**同提交**——否则真机导航失败，单测看不见） | D6 |
| F2 | client | `src/pages/history/history.vue`（**新**） | 列表（倒序/`onReachBottom`/`nextCursor` 原样透传）+ 卡片（时间/模式/**我的身份与胜负**/我的分）+ 展开（三家明细 + 底牌，牌面**复用** `components/Card.vue`/`Hand.vue`/`BottomCards.vue`）；空态/失败态照既有惯例 | D6 |
| F3 | client | `src/pages/lobby/lobby.vue` | `PlayerChip` 包可点容器 → 页内弹层（**列表结构**，1 项）→「历史战绩」→ `uni.navigateTo` | D6 |
| F4 | client | `src/net/rest.ts` + `src/stores/*`（按需） | `fetchMyRecords(cursor?)`；**模式标签映射写死**：`random→「匹配」`、`practice→「好友房」`（**禁「练习」字样**） | D6 |
| F5 | client | `test/`（**新**/改） | 入口弹层/翻页/空态/展开/标签映射 单测 | D6 |
| G1 | conformance | `src/slices/slice-15-records.ts`（**新**） | 真栈用例（§3 的 **C4 幂等载体** + C6/C7/C8/C9；spec-r1-S 编号订正） | D7 |
| G2 | conformance | `src/run.ts` | `CASES` **末尾**追加 `slice-15-records`（工作流零改动——动态枚举） | D7 |
| H1 | 文档 | `docs/design.md` | 登记：第 10 配置键 / 记录服务面（REST+RPC+表）/ user-service 重挂 TCP（3101+R223 口径） | D8 |
| H2 | 台账 | `deviation-ledger.md` | 四条登记：①丢记录窗口 ②房间缺失跳过 ③码复用 duplicate 告警语义 ④清理多实例 | D8 |
| H3 | client | `lobby.vue` 素材槽位 | 头像可点态/历史图标（若需）按「元素名 + 尺寸」登记，真素材一行替换 | D6 |
| I1 | api-gateway | `src/gateway/gateway.controller.ts` | + `@Get('records/mine')` → `forwardToUserSvc('GET', '/api/records/mine', null, res, headersOf(req))`（**不进公开白名单 = 默认验签**；**首次 GET query 透传**——按 R75 纪律编码 cursor） | D4 |

**不在改动面（有意）**：`scripts/ci.sh` / 四个 workflow（闭集不触）；结算逻辑（settleGame 零改动）；`game.settlement` 契约（零改动，C5 又由 slice-10 锁死）；手册（r2 核过无需改）。

---

## 2. 新契约（写死）

### 2.1 牌编码（`protocol/src/records.ts`）

- 单张牌 = 1 字节 `r*5+s`（`r∈{3–14,17,20,30}`、`s∈{0–4}` ⇒ **包络 15–154；包络内存在非法值**（如 75 = r15）——合法性以 `decode→re-encode == 原值` 复核，spec-r1 订正），**定长 2 位小写 hex**（零填充）。
- `encodeHand(hand)`：恰 17 张 ⇒ 34 字符；`encodeCards(cards)`：恰 3 张 ⇒ 6 字符；张数不符或值域外 ⇒ `throw ProtocolError`（中文原因）。`decode*` 互为逆（`floor(v/5), v%5`），解码后张数/值域复核。
- **冻结副本**语义：`initialHands` 与后续被摘除/排序的 `hand` **不共享引用**（切片写入）。

### 2.2 RPC `record.write`（`protocol/src/rpc.ts`）

```ts
RPC_PATTERNS.recordWrite = 'record.write'
interface RecordWriteRequest {
  roomCode: string; gameVersion: number;
  mode: 'random' | 'practice'; baseScore: number;
  result: SettlementResult;                       // 全量，原样
  seats: Array<{ seat: number; userId: string | null; isRobot: boolean; robotId: string | null; hand: string }>;  // 恰 3 条、按座位序
  bottomCards: string;
  startedAt: number; endedAt: number;             // epoch ms
  meta?: RpcMeta;                                 // ...metaFromTrace()
}
type RecordWriteResponse = RpcResult<{ written: boolean }>;   // 照 rpc.ts:70-72 信封
```
- 服务端（user-service）校验：seats 恰 3、座位 0/1/2 各一、hand 长 34、bottomCards 长 6、`userId` 与 `isRobot` 语义自洽（`isRobot ⇒ userId === null`）；不合法 ⇒ `{ok:false, code, message}`。

### 2.3 REST `GET /api/records/mine`（`user-service`，经网关转发）

- 查询参数：`cursor`（**不透明字符串**，服务端内编码 `(endedAt,id)`，客户端原样回传；URL 编码由网关侧按 R75 纪律处理——网关**首次** GET query 透传）；`limit`（缺省 20、**上限 100、服务端 clamp**）。
- 响应 DTO（**逐字**；键集即 C7 白名单）：
  ```ts
  MyRecord = {                    // 11 键
    roomCode: string; mode: 'random'|'practice';
    endedAt: number;              // epoch ms
    baseScore: number; winner: 'landlord'|'farmer';
    landlordSeat: number; multiplier: number;
    spring: 'none'|'spring'|'anti-spring';
    mySeat: number;
    bottomCards: Card[];          // 恰 3
    players: Array<{ seat: number; nickname: string|null; role: 'landlord'|'farmer';
                     scoreChange: number; won: boolean; hand: Card[] }>;  // 恰 3 条；hand 恰 17
  }
  MyRecordsPage = { items: MyRecord[]; nextCursor: string | null }
  ```
- **永不出站**：`userId`/`playerId`/`robotId`/`isRobot`/`deviceId`/`money_delta`/`startedAt`（内部面）——C7 递归恰好键集锁死。

### 2.4 配置键 `record.retentionDays`

- int；`1 ≤ n ≤ 3650`；种子 = **365**；`parseConfigValue` 分支抛中文原因；消费方 = user-service `retentionDays()`（缓存缺省 365）。

### 2.5 清理节奏与环境注入面

- 默认间隔 **1h**；**启动后 30s 首轮**；`RECORDS_CLEANUP_INTERVAL_MS`（**空串 = 未设**、用 `||` 解析、生产 compose 空默认**透传**——行在 E1）——conformance 注入短值。

### 2.6 DDL（`1789400000000-GameRecords.ts` 逐字）

即设计 §D3 的两张表（`game_records` / `game_record_players`，`UNIQUE uk_room_version (room_code, game_version)`；`game_records`: `KEY idx_ended_at`；`game_record_players`: `KEY idx_user_ended (user_id, ended_at)` + `KEY idx_ended_at (ended_at)` + `KEY idx_record (record_id)`；`nickname VARCHAR(50)`、`hand CHAR(34)`、`bottom_cards CHAR(6)`、`money_delta INT NULL` 预留）。

---

## 3. 判据（C1–C11 形式化）

| # | 判据 | 载体 | 判别力（负/正对照） |
|---|---|---|---|
| C1 | **codec**：54 张全集往返、定长（34/6）、张数≠17/3 或值域外 ⇒ 抛 | protocol 单测 | 负：16 张/35 字符/值 155 ⇒ 抛；正：真实两副样例往返 |
| C2 | **发牌采集**：`dealCards` 后 `initialHands` 恰 17×3 与当次 hands 的**排序后冻结副本**一致；**流局重发覆盖**（旧快照不留） | shared 单测 | 负：出牌摘除后快照不变（反向证明非共享引用）；重发后快照 = 新发牌 |
| C3 | **窗口守卫**：无 `initialHands` 的会话走 `publishEnded` ⇒ **不带 record 且不抛**（`game.ended` 照常发布） | game-service 单测 | 负：快照存在 ⇒ 附 record 且形状对 |
| C4 | **幂等**：`rpcCall` 直投 3101 **×2** ⇒ 恰一组行 + 第二次 `data.written=false`；码复用 `ended_at` 差异 ⇒ error 日志 | conformance（`rpcCall`/`compose exec mysql` 先例） | 负：改 payload version ⇒ 新行 |
| C5 | **客户端零变化**：`game.settlement` payload 恰 9 键（**引用 slice-10 既有断言**——record/hands 泄漏自动红） | slice-10（**不另起**） | 已有 N1 判别力背书 |
| C6 | **只本人**：双账号；A 的响应绝不含 B 的 roomCode | conformance（`registerUser` 先例） | 负：B 查 ⇒ 各自只见己局 |
| C7 | **响应白名单（不可区分性；唯一机械防线）**：`fieldSetViolations` 式**递归恰好键集**（MyRecord 11 / player 6 / Card 2）+ 数组长度（3/17/3）；**不得用 `assertNoLeak`**（含 `players`） | conformance | **判别力自证必做**（REST 无既有出站闸）：正/负对照（注入多一键 ⇒ 红；真响应 ⇒ 齐），形态照 `slice-10:62,124` |
| C8 | **保留期即生效**：改键（管理面，slice-14 先例）→ 缓存刷新；`compose exec mysql` backdate 旧行 + 容器注入 `RECORDS_CLEANUP_INTERVAL_MS` 短值 ⇒ 清理轮删；改回 ⇒ 不删新行 | conformance + user 单测（时钟注入） | 负：保留期内新行不被删 |
| C9 | **失败姿态**：停 user-service ⇒ 打一局 ⇒ 结算广播照常 + room 出现 error 行（NDJSON 断言，slice-12 先例）+ 恢复后可写。`ClientProxy` 同类重连**已在 `slice-14:432/442`（C16③）有绿证**（spec-r1 订正先例与措辞）；仍留观察项（若环境差异导致不自动恢复 ⇒ 实现层处置并登记） | conformance（**停/起真先例 = `slice-14:432/442`**；`slice-07.3-edge:461` 是复原重启、仅作参考） | 负对照 = 广播不因记录失败而缺失 |
| C10 | **契约面三闸**：`messages.test.ts` 十键清单 / J21 接收侧（含 `controllers:` 注册）/ `meta-on-every-rpc-send`（两处新 `.send` 均带 meta） | 既有闸**同提交**更新 | 闸自带负对照 |
| C11 | **迁移形状**：列/唯一键/三索引（`migration.test.ts` 惯例；`migrationsRun:true` 启动即执行） | user-service 单测 | 照既有惯例 |

**收口读数**（真栈验收）：打一局（真人×3 或真人+机器人）→ `/api/records/mine` 字段逐项对局内事实（手牌/底牌/身份/分数）→ 清理注入轮生效 → 全序 conformance 全绿。

---

## 4. 会红的既有判据（同提交清单；实现期先全仓 grep）

1. `protocol/src/messages.test.ts:53-64`（九→十，含标题）；
2. `protocol/src/config.test.ts:9-18`（九→十，含测试名）；
3. `room-service/test/no-internal-http.gate.test.ts`（RPC_USAGE 分支 + 两清单 + **探针正/负两行**）；
4. `meta-on-every-rpc-send.gate.test.ts`（**自动**覆盖两处新 `.send`——若忘 meta 即红）；
5. `robot-availability-wiring.gate.test.ts`（J21：加键必须同提交有真接收侧 + `controllers:` 注册）；
6. `slice-10-settlement.ts`（**保持绿**，勿动——C5 靠它）；
7. `ws.gateway` 既有广播测试（record 缺失路径保持绿）；
8. `packages/protocol/src/rpc.ts:14-16` 注释（3101 复活 ⇒ 同提交订正）；
9. **`config-service/test/platform-config.service.test.ts:216-223`**（静态九行 SEED vs 动态 `[...CONFIG_KEYS]`——第 10 键 ⇒ **必红**，spec-r1-S5 补）+ 同族同步面：`config-service/test/admin.controller.test.ts:172-186`、`helpers/config-probe.ts`、**`config.rpc.test.ts:54-66`（seedDb 九键硬清单——计划审查补第四面）**（九键读数失真面）。
10. **`room-service/test/ws.module.wiring.test.ts:192`**（构造参数 `toHaveLength(7)` ⇒ 8——`ws.gateway*.test.ts` glob 盖不到该文件名——计划审查补）。

## 5. conformance 与回填

1. 新切片 `slice-15-records` 追加 `run.ts` CASES **末尾**（`--list` 动态枚举 ⇒ 工作流零改动）；**render 列不进**（真栈切片）；
2. 本地 `bash scripts/deploy/conformance-stack.sh up` + `node …/run.js slice-15-records` ⇒ 全绿（`RECORDS_CLEANUP_INTERVAL_MS` 短值注入）；
3. CI：首跑因 `full` 列**未回填**红一次 ⇒ 按既有流程用 **CI 实测**回填 `baselines.json` `full` 列。

## 6. 部署与回滚

- user-service 镜像重建（compose `expose`/override 回填 3101）；迁移 `migrationsRun:true` 随容器启动执行；**旧会话窗口**（SESSION_TTL 1h）由 C3 守卫覆盖、无人工步骤。
- 回滚 = revert 批次 commit；**记录表不删**（数据向后兼容：旧版代码不读新表，表留在备份伞内）；3101 若随回滚消失，room 侧 RecordClient 调用失败 ⇒ 走 C9 失败姿态（广播不受影响）——**无损回滚**。

## 7. 兼容面

| 面 | 预期 |
|---|---|
| 旧客户端 | 零感知（`game.settlement` 零改动；历史页是新增页面） |
| 旧会话（无 initialHands） | 不产记录、不抛、WARN（1h 窗口自愈） |
| 网关 GET query | 首次 query 透传——按 R75 纪律编码（`cursor` 含逗号须 URL 编码） |
| 机器人可区分性 | 昵称全空 ⇒ 同形；触发登记（设计 §2.6） |
| `ClientProxy` 重连 | C9 候选风险——未知则实现期处置并登记 |

## 8. 明确不做

同设计 §6（actionLog 全量 / 货币列实现 / 风控链 / 看板 / 导出 / 单条删除 / 搜索筛选）。

## 9. 风险

同设计 §4 表（发牌采集重发路径 / TCP 重挂口径 / 码复用静默吞保险 / C9 重连性 / 清理多实例登记）。

## 10. 下一步

1. 本文**过规格审查**（两路：判别力与可执行 + 事实一致性）→ 修复验证 → 定稿；
2. **计划层**（task-brief 拆分）→ 审计划 → 实现 → 自测 → 收口。
