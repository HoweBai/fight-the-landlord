# ②金币场 —— 规格（2026-10-04）

> **定位**：设计 `docs/superpowers/specs/2026-10-04-gold-room-design.md`（**v1.2**，用户已确认）的实施级展开。判据骨架 = 设计 §6 的 **C1–C23**（本规格逐条展开为可执行条目并指定载体，**只增不减**）；规格级裁定 = **⚙️1–⚙️14**（对设计留白处的落地裁决；含 3 处对设计的细化，见 ⚙️2/⚙️8 的「偏差登记」）。
> **必读**：① 货币设计 §1.3/§12 · ① 货币规格 §2.2/§2.3/§5（幂等/上限语义来源）· 本片设计 §2 D1–D13。
> **纪律**：任何「跑了」的表述必须指向本次产生的日志；静态切片基线回填免首跑红；迭代期只跑受影响包。

---

## §0 规格级裁定索引（⚙️1–⚙️14）

| ⚙️ | 类型 | 内容（详见节） | 来源 |
|---|---|---|---|
| ⚙️1 | 新增 | 配置六键逐字（parse 函数/范围/消息/种子/迁移 1789800000000-GoldRoom） | 设计 §3.5；审计 D12 |
| ⚙️2 | 细化 | 协议面：mode 三值逐处（含**保持二值**两处）；`game.balances` 逐字；`RoomPlayer.balance`；**客户端配置 7 键**（+entryMultiplier，偏差登记） | 设计 §2 D1/D7、§3.2/3.5 |
| ⚙️3 | 新增 | `record.moneyDelta` 契约/SQL/回执/收敛逐字 | 设计 §2 D5 |
| ⚙️4 | 新增 | 结算算法逐字（截断/分摊/抽水/残差/actionId/守卫） | 设计 §2 D3/D4 |
| ⚙️5 | 新增 | 失败分级实现映射/重试预算/outbox 双 hash/sweeper/TTL×告警分工 | 设计 §2 D4、C10/C11 |
| ⚙️6 | 新增 | 机器人水位派生函数逐字（泛化 + 非整百修正 + 不变量） | 设计 §2 D6、用户 J10 |
| ⚙️7 | 新增 | 机器人资金动作（ensure/结算后/失败传播/池） | 设计 §2 D6、C22 |
| ⚙️8 | 细化 | 上限 source 化逐字 + **baseScore ≤ 8191 校验**（偏差登记：int 容量论证） | 设计 §2 D3、C23 |
| ⚙️9 | 新增 | 救助端点（裁决序/翻码/响应/配置读） | 设计 §2 D10、C14 |
| ⚙️10 | 新增 | 错误码三条逐字（12010/14003/14004 + 三表同步） | 设计 §2 D2/D8/D10 |
| ⚙️11 | 新增 | 指标名/告警规则 YAML 逐字/Grafana 面板 | 设计 §2 D11、§3.6 |
| ⚙️12 | 新增 | 切片：`slice-18-gold-room` 设计 + 既有片同步 + 基线纪律 | 设计 §1.1、C17/C19 |
| ⚙️13 | 新增 | **⚙️14 真库双会话规程全文**（含判别力负对照）——开工第一任务的判据 | 设计 §2 D13、C18 |
| ⚙️14 | 新增 | 客户端交互规则（三态/占位条件/救助占位/扫描面） | 设计 §3.4、C16 |

---

## §1 配置面（⚙️1）

### 1.1 六键逐字

| # | 键 | parse 函数 | 规则 | 种子 | 客户端映射 |
|---|---|---|---|---|---|
| 12 | `room.freeRoomEnabled` | 复用 `parseStrictBoolean` | 严格 boolean | `true` | `freeRoomEnabled` |
| 13 | `room.goldRoomEnabled` | 复用 `parseStrictBoolean` | 严格 boolean | `false` | `goldRoomEnabled` |
| 14 | `currency.entryMultiplier` | `parseEntryMultiplier` | int `1..100` | `10` | `entryMultiplier`（⚙️2 偏差登记） |
| 15 | `currency.rakePercent` | `parseRakePercent` | int `0..50` | `0` | ❌ |
| 16 | `currency.reliefEnabled` | 复用 `parseStrictBoolean` | 严格 boolean | `false` | `reliefEnabled` |
| 17 | `currency.reliefAmount` | `parseReliefAmount` | int `1..1000000`（0 不可；停发用开关） | `200` | ❌ |

- `CONFIG_KEYS` 数组 11→17（追加六项，注释照第 10/11 键样板）；`parseConfigValue` 加六个分支。
- 错误消息逐字（照 `parseSignupGrant` 风格）：`currency.entryMultiplier 必须是整数` / `currency.entryMultiplier 必须在 1 ≤ n ≤ 100 范围内`；`currency.rakePercent 必须是整数` / `currency.rakePercent 必须在 0 ≤ n ≤ 50 范围内`；`currency.reliefAmount 必须是整数金币` / `currency.reliefAmount 必须在 1 ≤ n ≤ 1000000 范围内`。
- 迁移：`config-service/src/migrations/1789800000000-GoldRoom.ts`（照 `1789700000000-SignupGrant.ts` 样板），up = 六行 INSERT（值为上表种子），down = 六行 DELETE；`migration.test.ts` 加第 12–17 键用例 + 时间戳单调。
- 测试族同步（键数 11→17 / 客户端 3→7）：`protocol/src/config.test.ts`、`config-service/test/platform-config.service.test.ts`、`helpers/config-probe.ts`、`admin.controller.test.ts`、`config.rpc.test.ts`、`client-config.test.ts`、`migration.test.ts`、`user-service/test/config-cache.test.ts`、**room-service `test/config-cache.test.ts`（entryMultiplier getter）**、`tools/mock-server/test/rest.test.ts`。
- 管理页 `admin/app.js` `CONFIG_NOTES` 加六条（11→17，注释 :47-48 同步），文案要点：gold 开关「上线要开放金币场 ⇒ 第一件事就是打开它」；entryMultiplier「改动同时影响门槛与机器人水位（补线/目标/回收线随 max 底分 × 本值联动）」；rakePercent「默认 0；>0 从赢家所得扣、系统回收」；reliefAmount「要 ≥ 最低档门槛（15×entryMultiplier），否则领完回不了桌」。
- 手册 `docs/ops/first-deploy.md` 键表 11→17 行；`docs/design.md §7.5` 表 + 「十一键」散点清扫**清单**（`docs/design.md` :142,403,487,494,1091-1117（表）,**:1113「正整数」→「1..8191」**,1279,1428,1887 · `admin/app.js` :29,37,47-48,186,206 · `admin/style.css:275` · `api-gateway` 注释 :118,:131 · `docs/client-protocol.md:54` · `docker-compose.yml:332,438` · `conformance/lib/http.ts:225` · `protocol/src/config.ts:2`（头注）· config-service `admin.controller.ts:86`、`client-config.controller.ts:17`、`platform-config.entity.ts:10`、`platform-config.service.ts:44,56` · room-service `gateway/config.client.ts:21`、`gateway/rpc.options.ts:35` · robot-service `src/config/config.client.ts:14` · `user-service/src/config/config.client.ts:15` · 迁移注释 `1789100000000-BaseScoreLevels.ts:7`）。**兜底口径**：以**限定范围的字面量扫描**（C17 的仓库扫描断言）为最终判据——扫描面 = §1.1 所列现行文件 + `packages/**|admin/**|deploy/**|tools/**` 源文件；**显式排除 `docs/superpowers/**`（历史片文档与用户已确认设计，不得改）与 `dist/**`（构建产物）**；上列点位是已知命中集（行号以实施时 grep 为准）。

## §2 协议面（⚙️2）

### 2.1 mode 三值化（逐处）

**三值化（`'random' | 'practice' | 'gold'`）**：
- `protocol/src/messages.ts:41`（room.match payload 联合）；`protocol/src/validate.ts:332-333`（校验分支 + 错误消息 `$.payload.mode must be 'random' | 'practice' | 'gold'`）。
- `protocol/src/rpc.ts:211`（RecordWriteRequest.mode）；`protocol/src/views.ts:31`（RoomInfo.mode）。
- `room-service`：`match.service.ts:27`（MatchMode）、`:37`（MATCH_MODES）、**:197（readMeta 改保真三值**——非法/缺省仍落 'random' 兼容旧 meta）；`message.router.ts:293`（签名联合）、**:313（探测改为覆盖其余两种模式**：除本次 mode 外的两个键都探）。
- `rooms/rooms.service.ts:12`（RoomMode 类型）。**`rooms/rooms.dto.ts` 的 REST 枚举不加 gold**（REST 建房 practice-only）。
- `user-service`：`records/records.service.ts:50`（类型）、`rpc/record.rpc.controller.ts:57`（校验字符串 + 消息）。
- 客户端：`net/rest.ts:345`（MyRecord.mode）、`history.vue:53-56`（中文映射 +「金币场」）。（消息类型表 `net/socket.ts:1159-1172` 属 §2.2 的 `game.balances` 落点。）

**保持二值（勿机械三值化）**：`net/rest.ts:288`（createRoom 载荷）、`game.vue:274-275`（practice 建房调用点）。

### 2.2 新 S→C 消息 `game.balances`

```ts
| { type: 'game.balances'; version: number;
    payload: { balances: { seat: number; balance: number }[] } }   // 恰 3 条、座位升序
```
- `SERVER_MESSAGE_TYPES` 9→10；`messages.test.ts:38` `toHaveLength(9)`→10；`docs/client-protocol.md` §5 表加第 10 行（**表头「S→C：九条」→「十条」**，:155）；`protocol-doc-sync.test.ts:86-98` 的表对账随之（**该测试文件仅 127 行，改动落点在文档表**）。
- `version` = `game.ended` 事件信封的 version（与 `game.settlement` 同值）；只在**金币场**房内广播（广播目标 = 该房间在线连接）。
- 发送时机：settle 例程「成功 / replayed / 全零」三态之一（⚙️5）；同一局至多一条有效凭据（outbox 重发成功后才发）。
- 语义：`balance` = 该座 owner 的**结算时刻**钱包余额（replayed 响应的 `balanceAfter` 是历史快照——apply.service.ts:424-427 自注，客户端只做展示，余额 chip 以后续拉取/推送为准）。
- **客户端接线（落点）**：`net/session.ts:137-181` 逐条 `client.on(...)` **新增 `game.balances` 分流** → `stores/game.ts` 接收（更新三座余额 / 结算页金币列数据源）；不接线 = 消息到达但无源、静默缺列。

### 2.3 `RoomPlayer.balance?`

- `protocol/src/views.ts:39-43` 加可选字段 `balance?: number`。
- **仅金币场**填充：`room.matched` 后随 `room.state_update` 下发（开局时 room-service 对三座做一次 `currency.get`；**读失败 ⇒ 省略该字段**（客户端显「—」），不阻塞开局——与结算资金安全不同级）。
- 免费场/好友房：永不出现该字段（客户端「—」形态不变——不可区分性，设计 D7）。

### 2.4 客户端配置 7 键（**偏差登记**：设计 §3.5 为 6 键）

`CLIENT_CONFIG_KEYS = ['baseScoreLevels','friendRoomEnabled','freeRoomEnabled','goldRoomEnabled','reliefEnabled','entryMultiplier','version']`——**+`entryMultiplier`**。理由：大厅门槛提示（「需 ≥ baseScore×N」）与救助按钮点亮条件都在客户端计算，需要该值。机械面：`client-config.controller.ts` 组装 + 恰 7 键断言（`client-config.test.ts:26-27` 等）+ 前缀泄漏扫描不变（`entryMultiplier` 无 `currency.` 前缀，天然过扫描）；`admin/app.js` 注释与手册键表按「客户端可见」标注。
- **编译强制面（逐处）**：`protocol/src/config.ts:33-37` 的 `ClientConfig` interface 扩张 ⇒ 构造点全列随改：`lobby.vue:68` `FAILSAFE_CLIENT_CONFIG`、客户端测试 stubFetch/fixture（`auth-ui-wiring:123`、`lobby-ux:113`、`table-center:60,71`、`base-score-selection`/`friend-room-gate`/`history-records` 各自数据）。
- **缺键语义（服务端旧版/落后时）**：`freeRoomEnabled` 缺 ⇒ 按**开**（与种子一致）；`goldRoomEnabled`/`reliefEnabled` 缺 ⇒ 按**关**；`entryMultiplier` 缺 ⇒ 不做门槛提示（服务端仍权威）。

## §3 `record.moneyDelta`（⚙️3）

```ts
// protocol/src/rpc.ts：RPC_PATTERNS.recordMoneyDelta = 'record.moneyDelta'
export interface RecordMoneyDeltaRequest {
  roomCode: string;          // 非空、≤16
  gameVersion: number;       // 正整数
  deltas: { seat: number; delta: number }[];   // 恰 3 条、座位 {0,1,2} 各一、升序；delta 整数含 0；|delta| ≤ 2147483647
}
export interface RecordMoneyDeltaData { matched: number[] }   // 命中的座位集合（升序）
```
- user-service 新 handler（`rpc/record.rpc.controller.ts` 同族）：校验失败 ⇒ `{ok:false, BAD_PARAM}`；SQL 逐座：
  `UPDATE game_record_players p JOIN game_records r ON p.record_id = r.id SET p.money_delta = ? WHERE r.room_code = ? AND r.game_version = ? AND p.seat = ?`
  （⚠️ 该表只有 `record_id` 列——`1789400000000-GameRecords.ts:48-66`；**回执行存在性**：先 `SELECT p.seat …` 得存在集合，再对交集 UPDATE；**不得用 affectedRows**——同值重写返回 0 会把幂等重发误判为未落库）。
- room-service 收敛：`matched ⊇ {0,1,2}` ⇒ 完成；否则留 `recordmoney:outbox` 重试（⚙️5）；`record.write` 契约零改动。
- records 读取面：`records.service.ts:219` 白名单 DTO 加 `moneyDelta`（**MyRecord 11→12 键**）；`slice-15-records.ts:382,412` 逐字断言同步（MYRECORD_KEYS 在 :382、money_delta 注释在 :412）。

## §4 结算算法（⚙️4）

> **2026-10-26 起**：零头改按最大余数法分给赢家（residue 恒 0），见 `docs/superpowers/specs/2026-10-26-settle-remainder-to-winners-design.md`；本节公式为历史口径。

**入口**：`finalizeRoomEnd`（`ws.gateway.ts:790-825`）在 :809 处 `void this.settleMoney(...)`（releaseRobots 之后、`!record||!version` 早返 :812-817 之前）。

**守卫（缺任 ⇒ WARN + 指标 + 不结算）**：`mode==='gold'` ∧ `result` 存在 ∧ **`event.version` 非空**（缺 ⇒ 跳过——actionId 与 moneyDelta 的 gameVersion 全依赖它，`settle:<room>:undefined` 会一路撞到 10001）∧ 三座位齐 ∧ **机器人座映射齐**（C25）。⚠️ **映射与座位的来源 = `finalizeRoomEnd` 顶部那次读取**（`botBySeat`，:797-802）+ 房间元数据（`roomsService.findOne`，同 :865 口径）；**settle 内不得重读 `room:{code}:bots`**——:805-808 的 `releaseRobots` 已 DEL 该键（releaseRobots 内注释自警「晚读会静默取到空」），重读恒空 ⇒ 带机器人的主场景会恒不结算。settle 例程以 `botBySeat` 为**入参透传**。room 数据缺失（TTL 窗）⇒ WARN 跳过。

**算法（逐字）**：
```
raw[i]   = seat i 是 landlord ? result.landlordScoreChange : result.farmerScoreChange
输家 i:  pay[i] = min(−raw[i], balance[i])            // 余额 = 结算前 currency.get；balance 缺失(exists=false)按 0
         delta[i] = −pay[i];  P += pay[i]
赢家 i:  g[i] = floor(raw[i] × P / Σraw[赢家])         // Σraw[赢家] = Σraw[输家]（玩法守恒）
         rake[i] = floor(g[i] × rakePercent / 100)
         delta[i] = g[i] − rake[i]
residue  = P − Σg[i]                                   // ∈ [0, 赢家数)；销毁，计 currency_settle_residue_total
entries  = 非零 delta 的 {ownerId, ownerType, delta}   // 人类 userId/'user'；机器人 botId/'robot'
rakeTotal = Σrake[i]                                   // 销毁（J7），随 residue 一并可核对
Σentries = −(residue + rakeTotal)                      // 无截断且 rake=0 ⇒ 恒 0（零和自明）
```
- `actionId = settle:<roomCode>:<version>`；重算轮 `:r2`（至多一轮）；`refId = <roomCode>:<version>`；source `game_settle`；带 meta（traceId）。
- **全零**（entries 空）⇒ 不调 apply；仍走「广播 + moneyDelta(全 0) 」收尾（⚙️5 三态之二）。
- 分差为 0 的座位（理论不发生）⇒ 不产生 entry，但 moneyDelta 向量仍含 0。

## §5 失败分级与补偿（⚙️5）

**apply 结果 → 动作映射（逐字）**：

| 结果 | 判定 | 动作 |
|---|---|---|
| `ok` / `replayed` | 响应 `ok:true` | 走收尾（机器人动作 + moneyDelta + 广播） |
| 超时 / 传输故障 / `10007` | 客户端抛出或信封 code | **同 id 同载荷**重发，至多 2 次（退避 300ms/1s）；仍失败 ⇒ 入 `settle:outbox` |
| `14001` | 信封 code | 重读余额、重算，`actionId :r2` 重发**至多一轮**；仍 14001 ⇒ 入 outbox |
| `10001` | 信封 code | **终态**：ERROR（九字段，含 roomCode/version）+ 指标 `dropped`；**不入 outbox、不重试** |
| `14002` | 信封 code | **终态**（他方已结算，胜出载荷不可见）：ERROR + 指标 `dropped`；`money_delta` 留 NULL；runbook（以 `currency_flows` 核对）；P5 登记 |

**outbox（Redis，两个 Hash）**：
- `settle:outbox`：field=`<roomCode>:<version>`，value=JSON`{actionId, entries, roomCode, gameVersion, round, seats, createdAt}`；
- `recordmoney:outbox`：field=`<roomCode>:<version>`，value=JSON`{roomCode, gameVersion, deltas, createdAt}`。
- **sweeper**：room-service 自重排链（照 `rooms.reaper.ts` 模式），周期 = 常量 `SETTLE_SWEEP_INTERVAL_MS = 10_000`（不设配置键）；每轮：settle 条目**原样重发**（同 id 同载荷），成功 ⇒ 走完整收尾并从两箱清除；moneyDelta 条目重发，`matched` 齐三座 ⇒ 清除。**TTL = 1h**：age>1h ⇒ ERROR「放弃」日志 + 指标 + 删条目（人工 runbook）；**告警阈值 = 最老条目 > 300s（2m）**——告警先于 TTL 到达，TTL 只做清理。
- 收尾顺序（各自独立 try/catch，互不阻塞）：① 广播 `game.balances`（玩家可见优先）→ ② `record.moneyDelta`（不齐 ⇒ 入 recordmoney:outbox）→ ③ 机器人动作（失败 fail-open，只记指标/日志；**零 delta 座无 `balanceAfter` ⇒ 该座跳过；全零局无 apply ⇒ 整体跳过 ③**）。

## §6 机器人水位（⚙️6）

```ts
// room-service；top = max(baseScoreLevels) × entryMultiplier（默认 1200×10=12000）
function robotWaterLevels(botId: string, top: number) {
  const { h1, h2, h3, h4 } = sha256Uint32x4(botId);        // 前 16 字节大端四段
  const nudge = (v: number) => (v % 100 === 0 ? v + 1 : v); // 非整百修正（含整千）
  const refillLine = nudge(Math.floor(top * 1.025) + (h1 % (Math.floor(top * 0.05) + 1)));
  const target     = nudge(Math.floor(top * 1.15)  + (h2 % (Math.floor(top * 0.2)  + 1)) + (h3 % 97));
  const recallLine = nudge(Math.floor(target * 2.8) + (h4 % (Math.floor(target * 0.4) + 1)));
  return { refillLine, target, recallLine };
}
```
- **不变量（写成测试）**：任意 `top ≥ 15` 下 `refillLine < target < recallLine`；三者 `%100 ≠ 0`；默认 top=12000 时 `refillLine∈[12300,12900]`、`target∈[13800,16296]`、`recallLine∈[38640,52147]`。
- sha256：room-service 用 `node:crypto`（服务端，不受客户端依赖面约束）。
- 确定性：同 botId 永恒同值（重启/多实例一致）。
- **口径边界（对 J10 的诚实化）**：非整百保证只对三个**派生水位（补给落点）**成立；余额随对局输赢漂移（步长 = 底分×倍数），**整百偶发、与人类同形**——J10 要消灭的是「所有机器人都是 10000/5000」的系统性整数，不是数学上永不整百。

## §7 机器人资金动作（⚙️7）

- **池账户**：常量 `owner_id='robot-pool'`、`owner_type='robot'`；种子 runbook（⚙️11/手册）拆 **5 笔 × 1,000,000**（`currency.apply`/管理面单笔上限 1e6）。**种子通道（自查补）**：`POST /api/admin/wallet/adjust` 扩展**可选 `ownerType`**（缺省 `'user'` 向后兼容；池种子/机器人注资传 `'robot'`）——现端点只透传 ownerId/delta（`admin-wallet.controller.ts:127-133`），不透传会以 `user` 建池户、与 refill 载荷的 `ownerType:'robot'` 相撞（10001 类型闸）。同步面：该 controller + 其测试族（§16）。
- **ensure（金币场 `fillBots` 内、`game.start` 前）**：
  1. `currency.get(botIds)`（3s；失败 ⇒ **抛**，走既有补位失败路径：`fillBots` 返回 null → 不开局 → 匹配路径 cancel + attempts+1）；
  2. 对「账户缺失（exists=false）或 `balance < refillLine(bot)`」的机器人：`apply { actionId: rr:<botId>:<target>:<观测余额|0>, source:'robot_pool', refId:botId, entries:[{pool, −x, 'robot'}, {bot, +x, 'robot'}] }`（x = target − 观测）；apply 失败 ⇒ 同上抛。
- **结算后动作**（settle 成功收尾第 ③ 步，fail-open）：以 apply 响应 `balanceAfter` 为准，`< refillLine` ⇒ 同 rr 式补；`> recallLine` ⇒ `rc:<botId>:<target>:<观测>`（bot→pool）回收至 target。同观测重复触发 ⇒ 同 id 同载荷 ⇒ replayed（不双补）；池余额不足（14001）⇒ WARN + 指标（runbook 充值）。
- **无定时 job**（设计 D6）；**僵尸余额**：不补、不删（通缩）；观测 = `currency_robot_accounts_balance_sum`（⚙️11）。
- ensure 后未上桌（开局失败/房间取消/N36）：补款留账户，下轮复用、不双补——**明确接受**（设计 v1.2）。

## §8 上限 source 化 + 底分上限（⚙️8）

```ts
// protocol/src/currency.ts
const MAX_ABS_DELTA = 1_000_000;                        // 缺省（各 source 通用）
const MAX_ABS_DELTA_BY_SOURCE: Partial<Record<CurrencySource, number>> = {
  game_settle: 2_147_483_647,                           // int 列容量（2^31−1）——哨兵：抓算法 bug，不是经济参数
  robot_pool:  2_147_483_647,
};
// validateCurrencyApply：const cap = MAX_ABS_DELTA_BY_SOURCE[source] ?? MAX_ABS_DELTA;（消息里的上限显示 cap）
```
- **哨兵取 `2^31−1`（对设计 §2 D3 与 C23「1e12」的订正，理由）**：`balance`/`delta`/`balance_after`/`money_delta` 列均为 int——`(2^31−1, 1e12]` 区间会「过协议校验但落库 1264 报错 ⇒ 伪 10007 ⇒ 重试/outbox」，与「哨兵=终态 10001」语义相悖；取 int 容量后 `>2^31−1` 在**校验层**即为 10001 终态。现档位下单局真实上界 ≈3.15e8（余 ~6.8×），且 C24 保证任何档位下真实值 ≤ int。
- **偏差登记（对设计 §6 C23 的加强）**：`parseBaseScoreLevels` 加单档上限 **`baseScore ≤ 8191`**（= `floor((2^31−1) / 2^18)`，论证：`money_delta`/`balance` 列均为 int，最坏单条 = `baseScore × 2^18`（地主 ±2u、u = 底分×BID8×2^13×春天2）；8191 是「任何派生金币数都装得进 int」的充分上界）。新拒绝消息：`底分档位「{name}」的 baseScore 必须在 1..8191 范围内（金币金额列 int 的容量上界）`；`config.test.ts` 加边界用例；`CONFIG_NOTES` 的 `game.baseScoreLevels` 条目补一句。
- C23 断言更新：`game_settle`/`robot_pool` 合法大额（>1e6 且 ≤2,147,483,647）可结；其余 source 仍 1e6 拒；>2^31−1 拒（校验层 10001 终态）。

## §9 救助端点（⚙️9）

- 路由：`POST /api/wallet/relief`（`currency-service/src/wallet/wallet.controller.ts` 新 handler，`X-User-Id` 头）。
- **机械面（逐处）**：api-gateway 是**逐端点路由表**（`gateway.controller.ts:177-231`）——须加 `POST /api/wallet/relief` 行 + `gateway.controller.test.ts` 同步；currency-service 首次接 config RPC ⇒ `docker-compose.yml` currency 段补 `CONFIG_SERVICE_RPC_HOST/PORT`（照 user/room 段 :339/:444 样板）+ `ClientsModule` 装配（config client 模块）。
- 裁决序（逐字）：`reliefEnabled` 关 ⇒ **14004**（消息「救助暂未开放」）→ `currency.get(userId)` 余额 ≥ `15 × entryMultiplier` ⇒ **14004**（消息「余额充足，无需救助」）→ `apply { actionId: relief:<userId>:<YYYY-MM-DD 按 Asia/Shanghai>, source:'relief_grant', entries:[{ownerId:userId, delta:+reliefAmount}], refId:userId }`。
  - 首次 ⇒ `{ok:true, data:{granted:true, amount, balance}}`；replayed ⇒ `{granted:false, replayed:true}`；**14002（同日改金额再领）⇒ 捕获并翻成 `{granted:false, replayed:true}`**（不暴露冲突）。
- currency-service 首次接配置：照 `user-service/src/config/config-cache.service.ts` 样板（config.snapshot RPC **带 meta**、缓存 + 推送失效），仅读 `currency.reliefEnabled`/`currency.reliefAmount`/`currency.entryMultiplier`；测试族（getter 三支 + 默认值）随行。
- 配置读取失败 ⇒ 503/10007（**不默认放行**）。

## §10 错误码（⚙️10）

| 码 | enum 名 | 触发 | 消息（示例，运行时含具体值） | CLIENT_ACTION |
|---|---|---|---|---|
| 12010 | `ROOM_MODE_DISABLED` | 场次开关关闭时 `room.match` | 该场次暂未开放 | TOAST |
| 14003 | `E_ENTRY_THRESHOLD` | 金币不足入场门槛 | 金币不足：该场次需要 ≥ {needed} | TOAST |
| 14004 | `E_RELIEF_UNAVAILABLE` | 救助关闭 / 余额充足 / 判定不过 | 见 ⚙️9 两文案 | TOAST |

三表同步：`protocol/src/errors.ts`（enum + CLIENT_ACTION）→ `errors.test.ts` 的 `SPEC_CODES` → `docs/design.md §11.2` 表；客户端文档 `docs/client-protocol.md` §7 错误表（protocol-doc-sync 对账）。

## §11 观测与运维（⚙️11）

### 11.1 指标（名字逐字）

**room-service**（既有 `/metrics` 同族扩展）：`currency_settle_result_total{result}`（result ∈ `ok|replayed|retried|r2|outboxed|dropped`）· `currency_settle_residue_total` · `currency_settle_outbox_size` · `currency_settle_outbox_oldest_seconds` · `currency_robot_topup_total{action}`（`refill|recall`）· `currency_robot_ensure_failed_total`。
**currency-service**：`currency_robot_pool_balance`（gauge，对账循环每轮刷新）· `currency_robot_accounts_balance_sum`（gauge，同处）· `currency_relief_total{result}`（`granted|replayed|rejected`）。
**偏差登记（命名）**：指标名与标签集**以本规格为准**（对设计 D11 的细化：结果标签按处置分流 `retried|r2|outboxed|dropped`，比设计的 `insufficient|timeout|conflict|invalid` 更贴运维口径）；实施时在设计 D11 附注同步一行。

**口径附注**：经 outbox 收敛的局（sweeper 重发成功），`currency_settle_residue_total` **少计**（少计额 = 该局 residue）—— outbox 条目结构不含 residue/rake，重发路径不再累计（残差只在 in-process 结算路径埋点；账以 entries 为准）。

### 11.2 告警规则（`deploy/monitoring/prometheus/rules/ftl-alerts.yml` 追加，13→16 条；文件头注释同步为「16 条 = 13 类」）

```yaml
      # ── 资金面（金币场）────────────────────────────────────────────────
      - alert: CurrencySettleOutboxStuck
        expr: currency_settle_outbox_oldest_seconds > 300
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: 金币结算补偿队列有条目滞留 > 5 分钟（钱没动，账面不一致可见）
          runbook: 看 room-service 九字段日志（含 roomCode/version/round）；核 currency-service 可用性与池；对账用 currency_flows 按 actionId 查
      - alert: CurrencyReconcileDrift
        expr: currency_reconcile_drift_accounts > 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: 货币对账出现漂移账户（账实不符或缓存漂移未自愈）
          runbook: 看 currency-service 对账日志（三检查哪一类的哪些账户）；先让自愈跑一轮，仍漂移 ⇒ 人工核对 currency_accounts 与 flows
      - alert: CurrencyRobotPoolLow
        expr: currency_robot_pool_balance < 1000000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 机器人虚拟池余额 < 100 万（补给将开始失败）
          runbook: 管理面注入虚拟池（拆笔、单笔 ≤ 100 万）；注入前先看补给/回收速率指标判断方向
```

### 11.3 Grafana

新面板 1 块（名字 `资金面 / Currency`），至少含：池余额、`currency_settle_result_total` 按 result 的速率、`currency_relief_total`、`currency_settle_residue_total` 增速。`slice-16` 的面板计数断言 4→5 与名单同核（:717-721）。

### 11.4 手册（`docs/ops/first-deploy.md`）

- 键表 11→17。
- 新节「虚拟池：种子与充值」：5 笔 `POST /api/admin/wallet/adjust` 的具体命令（ownerId=`robot-pool`、actor/reason 填写规范）；触发时机（首次上线 / 收到 `CurrencyRobotPoolLow`）。
- 新节「金币结算失败怎么处置」：outbox 两 hash 的语义、`dropped` 终态的含义、`CurrencySettleOutboxStuck` 的处置顺序、以 `currency_flows` 按 `settle:<room>:<ver>` 核账。

## §12 conformance（⚙️12）

### 12.1 新片 `slice-18-gold-room`（`run.ts` 追加于末尾；`baselines.json` full 行按 CI 首轮回填——**本机读数不回填**）

断言组（标题：金币场（开关/门槛/结算/机器人池/救助/三值化））：
- **A 配置**：`/api/config` 恰 7 键、含三新布尔与 `entryMultiplier`；内部键零泄漏（显式名单：`currency.signupGrant`/`currency.rakePercent`/`currency.reliefAmount` + 既有前缀扫描）；管理面改 `room.goldRoomEnabled` 后 `/api/config` 生效。
- **B 开关**：gold 关 ⇒ `room.match gold` → 12010；开 ⇒ 不再 12010。free 关 ⇒ random → 12010；恢复。
- **C 门槛**：0 余额用户 gold 匹配 15 → 14003（含所需金额消息）；管理面补足 ⇒ 入队成功（随后 unmatch 清理）。
- **D 取消排队（C21）**：gold 入队 → `room.unmatch` → 探针断言 `match:queue:gold:*` 无该成员、meta 已清、窗口内不被撮合；再入队 ⇒ 复用 12009 语义正确。
- **E 完整金币局**：两真人（管理面预充 **5,000,000** ≥ 15×2^18，确保人类侧不截断；机器人位不预充）+ 机器人补位 → 打完整局 → 断言：`game.settlement` 广播；`game.balances` 恰 3 座（升序）；**按结算广播 + 结算前余额复算期望 delta（复算内含截断/分摊/残差公式）再逐座比对**——**不得直断「和=0」**（炸弹局会因机器人侧截断产生残差；**2026-10-26 起**零头分给赢家、residue 恒 0，见 `2026-10-26-settle-remainder-to-winners-design.md`）；botId 于**局中**读 `room:{code}:bots`（局终 DEL，slice-11:404-407 先例）→ 管理面查其账户：`owner_type='robot'`、余额 ≥ 12000（非整百断言由单测承载，见 ⚙️6 口径边界）；`GET /api/records/mine` 的 `moneyDelta` = 实际变动。
  **驱动（本片交付物）**：`ddz-driver` 现硬编码 `mode:'random'`+**注册并撮合 3 个真人**（`lib/ddz-driver.ts:123-149,136`）、遇机器人座直接抛（:476-478）⇒ 扩展 driver：启动参数化 `mode/baseScore` **与真人人数（E = 2 真人，经 30s 补位窗口由机器人补位）** + 机器人回合推进（自 slice-11 `mustAdvance` 区抽共享 helper）+ bots 键局中读 helper；列入计划任务。
- **F 抽水**：`currency.rakePercent=10` → 再打一局（同 E 的预充与复算口径）→ 赢家实收 = `finalGain − floor(finalGain×10/100)`（**2026-10-26 起**基数含分得的零头，见 `2026-10-26-settle-remainder-to-winners-design.md`）、entries 和 = −(抽水+残差)（管理面读余额核对）；复原 0。
- **G 救助**：开关开、金额 200 → 低余额领取 +200；同日再领 ⇒ `granted:false`；余额抬至 ≥150 ⇒ 14004；开关关 ⇒ 14004。
- **H 观测**：room-service `/metrics` 含新指标名（settle/outbox/topup）；currency-service `/metrics` 含池 gauge/救助计数；Prometheus `/api/v1/rules` 恰 16 条且含三条新规则名。
- **I 对账**：金币局后触发/等待对账一轮 ⇒ `currency_reconcile_drift_accounts == 0`。
- **J 记录**：金币局记录 `mode='gold'`；战绩列表含该局。
- 时长预算：E/F 各一局完整对局（复用既有切片打法）；**基线以 CI 回填为准**。

### 12.2 既有片同步

- `slice-14-config-center.ts:490-497`（C7：恰 3 键 → 恰 7 键）。
- `slice-15-records.ts:381,411`（MyRecord 11→12 键逐字）。
- `slice-16-monitoring.ts`：规则数 13→16（:88-94 名单、:592 promtool 文案、:655 名字集合）；面板 4→5（:717-721）；jobs/services 计数**不变**（无新容器/服务）。
- `slice-17-currency.ts:1221-1233`（C14 键集 → 恰 7 键 + 内部键显式名单）；:1136-1151 job 计数不变。
- `scripts/deploy/conformance-stack.sh`、`api-gateway/test/container-assembly.gate.test.ts`：**不变**（服务集合不变）。

## §13 ⚙️14 真库双会话规程（⚙️13，**开工第一任务**，先于任何机器人资金写入）

1. **形态回归**：读 `apply.service.ts` 断言 ⚙️14 形态在场（快照步 `SELECT … FOR UPDATE` + `owner_type` 断言 + `affectedRows===1`）；假遮蔽面在案（`test/helpers/fake-currency-db.ts` 事务路径只认锁定读形态（`d2ae3af` 起）+ 头注「夹具不能证 InnoDB 并发」）。
2. **真库交错用例**（dev MySQL 8.0.46；证据 = 命令 + 逐字输出，入台账）：
   ```
   S1(mysql 会话): BEGIN;
                   INSERT INTO currency_accounts(owner_id, owner_type, balance)
                   VALUES('bot-t14check', 'robot', 0);            -- 不提交
   并发:            调 currency.apply（ownerType='user'，ownerId='bot-t14check'，delta=+1）
   S1:              COMMIT;          -- 须在 apply 进入后 ≤1s 内提交（调用侧超时 3s 量级；拖长观察到的是 10007 而非 10001）
   期望:            apply 的锁定读阻塞至 S1 提交后读到 owner_type='robot'
                   ⇒ 10001「类型闸」整批回滚；账户行余额仍 0（SELECT 复核）
   ```
3. **判别力负对照（必做）**：在**本地补丁**把快照步临时回退为普通 SELECT（REPEATABLE READ 快照）⇒ 同交错**必红**（apply 误判成功/写坏行）⇒ 证明用例能抓住旧形态；随后还原实现，复跑第 2 步全绿。负对照的补丁 diff 与红/绿两次输出一并入台账。
4. 机器人语料变体：`bot-t14check` 即 botId 形态（`bot-`+8hex 形态位）。
5. 未过 ⇒ **不进** ⚙️7（ensure/补给）与 §4 结算的施工。

## §14 客户端（⚙️14）

- **大厅**：余额 chip（`GET /api/wallet/balance`；登录后拉、回厅刷新、`game.balances` 到达时可本地更新）；场次切换（免费/金币，按开关渲染，双关空态）；金币档位卡阈值提示（`baseScore × entryMultiplier`——**不得硬编码 150/800/…**（source-boundary 扫描照得到））；余额不足置灰 + 14003 消息展示；「领取救助」入口（`reliefEnabled` ∧ 余额 < `15×entryMultiplier`）。
- **开始游戏**（`game.vue`）：`room.match` 载荷 `mode` = **当前所选场次**（`random|gold`）——**替换 :139 的硬编码 `'random'`**；REST 建房两处（:274-275）保持 `practice`（§2.1 保持二值行）。
- **牌桌**：`PlayerChip`/`Seat`——金币场显 `balance`（缺字段 ⇒「—」）；免费场恒「—」。
- **结算页**：金币列三态——`game.balances` 到达 ⇒ 显值；5s 未达 ⇒ 定格「—」（**不得永久「结算中…」**）；免费场不加列。
- **战绩页**：`mode='gold'` 行显金币列（`moneyDelta`；NULL ⇒「—」）；mode 中文映射 +「金币场」。
- **救助流程（占位版）**：点击 → 确认弹层（文案注明占位，广告小片接入点预留）→ `POST /api/wallet/relief` → 按 `granted` 分支 toast + 刷余额。
- 测试族：**`auth-ui-wiring`（「开始游戏 mode 接线」断言落此**——`lobby-modes.test.ts` 头注自述开始游戏覆盖在 auth-ui-wiring）/`base-score-selection`/`player-chip`/`table-settlement-ui`/`history-records`/`source-boundary`/`protocol-doc-sync` 各自补新面用例；`net/socket.ts` 类型表 + `stores/game.ts` 余额/场次状态 + `net/rest.ts` 新函数（relief、以及 MyRecord 类型）。

## §15 判据总表（C1–C23 × 载体）

| 判据 | 载体 |
|---|---|
| C1/C2 开关 | slice-18 B；room-service 单测（router 分支） |
| C3 客户端配置（7 键） | slice-18 A；`client-config.test.ts`；`protocol-doc-sync` |
| C4 门槛 | slice-18 C；room-service 单测 |
| C5 零和结算 | slice-18 E；room-service 单测（算法） |
| C6 机器人首入局水位 | slice-18 E（非整百+≥top）；room-service 单测（公式/不变量） |
| C7 money_delta 向量/幂等 | slice-18 E/J；user-service 单测（JOIN 回执） |
| C8 抽水 | slice-18 F；单测（floor 口径） |
| C9 截断 | room-service 单测（假层：余额不足/大倍数/分摊/残差） |
| C10 失败分级 | room-service 单测（假 currency client 四类）+ r2 轮用例 |
| C11 outbox | room-service 单测（入箱/重发/收敛/超龄）+ slice-18 H（指标/规则存在） |
| C12 refill/recall | room-service 单测（事件驱动/幂等/replayed） |
| C13 池告警 | slice-18 H（规则名与表达式） |
| C14 救助 | slice-18 G；currency-service 单测 |
| C15 断线结算 | room-service 单测（座位口径守卫） |
| C16 客户端 | 客户端测试族（§14） |
| C17 机械面同步 | 全仓关键词扫描断言（⚙️14 扫描面）+ 各包测试族 |
| C18 ⚙️14 规程 | §13（证据入台账） |
| C19 对账 | slice-18 I；slice-17 既有对账用例回归 |
| C20 record 零回归 | slice-15 全绿 + 既有测试族 |
| C21 取消排队 | slice-18 D；match 单测（三值 readMeta） |
| C22 ensure 失败 | room-service 单测（fillBots 失败路径） |
| C23 上限 source 化 | protocol 单测（cap 分档）+ C24 |
| **C24（新增）** 底分 ≤ 8191 | `config.test.ts` 边界 + CONFIG_NOTES |
| **C25（新增）** 守卫含机器人映射 | room-service 单测（映射缺 ⇒ 不结算 + 告警） |
| **C26（新增）** 管理面 ownerType 透传 | currency-service 单测（池以 'robot' 建户；缺省 'user' 兼容） |

## §16 闸族对账（设计 D12 × 本规格）

D12 各行均已落到本文：配置键/客户端配置/种子/测试族/管理页/手册/主设计/错误码/协议消息/协议文档闸/视图/货币协议/RPC/user-service/room-service/客户端/conformance/注释杂项 —— 见 §1–§12 各节；**无未落行**。新增行：`records.service.ts:219` + `slice-15:382,412`（§3）· currency-service 配置族（§9）· room-service `config-cache.test.ts`（§1）· **管理面 ownerType 透传**：`admin-wallet.controller.ts:127-133` + 其测试族（§7）· **api-gateway `POST /api/wallet/relief` 路由行 + `gateway.controller.test.ts`**、**compose currency 段两行 env**（§9）· **`ddz-driver` 扩展**（§12.1 E 的交付物）。

---

## 修订记录

- **v1.0**（2026-10-04）：首稿。由设计 v1.2（用户已确认）+ 三路接缝调研 + 契约面逐字核对（currency.ts/rpc.ts/messages.ts/errors.ts/ftl-alerts.yml/管理页/协议文档）展开；含对设计的两处偏差登记（⚙️2 客户端配置 7 键、⚙️8 底分 ≤8191）。
- **v1.1**（2026-10-04）：r1 评审（1🔴+9🟡+3🟢）全数处置。映射：🔴1→§14 补「开始游戏 mode 接线」+ 测试族点名 auth-ui-wiring · 🟡2→§4 守卫钉死 `botBySeat` 入参透传（禁重读，releaseRobots 已 DEL）· 🟡3→§12.1 E 驱动列交付物（ddz-driver 扩展）+ bots 键局中读 · 🟡4→E/F 断言改「复算期望」+ 真人预充 5,000,000 · 🟡5→§11.1 指标命名偏差登记 · 🟡6→§1.1 清扫清单补全（admin/app.js 散点、client-protocol:54、四处 config.client、design.md:1113）+ 扫描兜底口径 · 🟡7→§2.4 编译强制面/缺键语义 · 🟡8→§9 网关路由行 + compose env + 测试 · 🟡9→§2.1/§2.2 session.ts 分辨流落点 · 🟡10→§4 守卫加 `event.version` · 🟢11→§5 收尾③跳过口径 · 🟢12→§8 哨兵改 2^31−1（订正设计 C23 的 1e12）· 🟢13→§13 规程加时序预算 · 另：§3 slice-15 行号订正 :382/:412。
- **v1.2**（2026-10-04）：闭合复核残留处置（3+nano）：§12.1 E 驱动交付补「**真人人数参数化（2 真人，30s 补位窗口）**」（`ddz-driver.ts:123-149` 硬编码 3 真人注册/撮合）· §2.1 撤下错位的 `socket.ts:1159-1172`（属 §2.2）· §1.1 兜底扫描改**限定范围**（**排除 `docs/superpowers/**` 历史与已确认文档、`dist/**` 产物**——否则假红且诱导改上游）· §8 订正句补点名设计 §2 D3。
- **v1.3**（2026-10-04）：计划评审连带锚点订正两处：§2.2 replayed 自注行号 :452-459→**:424-427**（:452-459 实为 ⚙️13 重排序区）· §13 假遮蔽点表述改中性（`:216-218` 系对账假实现区；实据 = 事务路径形态钉死 + 头注「夹具不能证 InnoDB 并发」）。
- **v1.4**（2026-10-04）：实施期勘误与附注（T13 注记）：**§6 浮点勘误：真实区间 = 12299–12899 / 13799–16295 / 38637–52144（IEEE754 —— `12000×1.025 = 12299.999999999998` 一类舍入），不变量保持**（口径以单测 `robot-water.test.ts` 为准）；§11.1 附注：经 outbox 收敛的局 `currency_settle_residue_total` 少计（少计额 = 该局 residue）。
- **v1.5**（2026-10-04）：**2026-10-04 用户裁决：金币场默认开（原默认关），免费场开关维持默认开** —— 种子迁移/服务端 getter 缺省/管理面缺行兜底/客户端缺键语义与 fail-safe/测试族/slice-18 收尾态全链同步翻转为「默认开」（救助开关维持默认关不动）。
