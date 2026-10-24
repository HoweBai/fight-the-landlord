# 机器人拟人昵称（牌桌 / 结算 / 历史全链路）· 设计 v1.0

> **定位**：给补位机器人分配拟人昵称，消除「玩家N」这一事实上的机器人识别器。
> **状态**：设计草案，待对抗审查。
> **接触面**：`packages/room-service` · `packages/protocol` · `packages/user-service` · 文档；**客户端零改动**。

---

## §0 用户裁决（本设计不得与之冲突）

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 机器人**拟人化、与人类不可区分** | 牌桌、结算、历史战绩三处都显示拟人昵称 |
| K2 | **金币场也可以使用拟人机器人** | 不按 `room.mode` 分叉；金币场与免费场同规则 |
| K3 | **不新增配置键** | 昵称池 v1 硬编码在 room-service；运营化另立片 |
| K4 | **客户端零改动** | 只改服务端下发与记录快照；`nameOf()` / 历史页沿用现状 |
| K5 | 头像多样化**本片不做** | 同角色头像仍只有地主/农民两张素材图，另立片登记 |

---

## §1 背景与问题

1. 注册昵称已必填（[2026-10-17 昵称设计](2026-10-17-nickname-design.md)），新注册人类玩家一定有昵称。
2. 机器人座位不参与昵称回源，`players[].nickname` 恒缺省 ⇒ 客户端回落「玩家N」。
3. 因此「玩家N」已从「未知」变成**事实上的机器人标识**，与 `docs/design.md` §9.1/§9.8
   「机器人必须与人类在所有下发消息中不可区分」的硬约束相冲突。
4. 座位号是 0 基，还可能出现「玩家0」，占位符观感更强。
5. 历史战绩的机器人昵称快照恒 `NULL`，局后仍会露出「玩家N」。

---

## §2 范围

### 2.1 本片做

1. room-service 新增机器人昵称池与**房间级确定性分配**，写入现有昵称 Hash。
2. `room.join` ack / `room.state_update` 的机器人座位带 `nickname`（复用既有注入点）。
3. `record.write` 为机器人座补充昵称快照，历史战绩显示拟人名。
4. 单测、类型检查、文档同步。

### 2.2 明确不做

- 不改 `robot.acquire` 协议、不改 robot-service。
- 不改客户端牌桌 / 结算 / 历史页展示逻辑。
- 不做昵称池运营化（配置中心 / 后台管理）。
- 不做头像多样化、不做机器人行为拟人化。
- 不回填历史记录（旧对局的机器人仍显示「玩家N」）。
- 不做昵称敏感词服务；池内容在代码内人工精选并由测试钉住。

---

## §3 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 昵称由 **room-service** 分配，不由 robot-service 返回 | `robot.acquire` 逐座位调用且要求幂等（同 `{roomCode, seat}` 重试必须返回同一机器人并保持同一展示名）；room-service 本来就拥有昵称缓存与座位真源，可在房间内做去重，且无需改机器人协议 |
| D2 | 昵称池 = `rooms/bot-names.ts` 中的**精选常量数组**（目标 ≥ 200 个，2–8 字） | 无配置键、无新增服务；测试可机械校验长度/唯一性/禁词 |
| D3 | 分配种子 = `hash(roomCode + displayId + seat)`，同房间重试稳定、换房间重新抽名 | 避免同一机器人跨局固定同名被玩家归纳；确定性保证重连/重试一致 |
| D4 | 昵称写入现有 `room:{code}:nicknames` Hash，`field = displayId`、TTL = `ROOM_TTL_SECONDS` | `RoomNicknamesService.ensure` 与 `buildRoomPlayers` 读路径零改动即可自动带出 |
| D5 | 房间内机器人昵称互不重复；与人类昵称重复不处理。以**房间级短锁**串行化「读 Hash → 分配 → HSETNX」，逐字段 `HSETNX` 保证已写名字不被覆盖 | 人类昵称本身不唯一；`startRoom` 允许并发/重入（`rooms.start.ts:140-151`），无锁时两个批次可能选出同一名字或交叉覆盖 |
| D6 | 记录快照：`RecordWriteRequest.seats[].nickname?` 仅机器人座填充 | 人类继续由 user-service 按 `user_id` 查 `users` 做写入时快照，语义不变 |
| D7 | **新增路径** fail-open：机器人分配、昵称 Hash 写入、记录快照读取失败 ⇒ 省略昵称 ⇒ 回落「玩家N」 | 展示问题不得阻塞开局或记录写入。**不包含**既有 `RoomNicknamesService.ensure` 的 `hgetall`（本片不改变人类昵称的既有失败语义，见 §6） |
| D8 | 不新增「机器人可识别」字段；`displayId` 仍绝不落库 | 维持 §9.8 不可区分性与记录片 D2 |
| D9 | 客户端零改动 | 昵称已走 `RoomPlayer.nickname`；历史页已消费快照 |
| D10 | 记录快照的昵称 Hash 读取必须在 `updateStatus('finished')` **之前**发起 | reaper 对 finished 房间会立即 `deleteRoom`，删除集含 `nicknamesKey`；晚读会静默拿到空 Hash，历史页间歇性「玩家N」 |

---

## §4 实现设计

### 4.1 昵称池与分配（room-service）

新增 `packages/room-service/src/rooms/bot-names.ts`：

```ts
/** 精选中文昵称池：2–8 字、无重复、不含机器人/AI/电脑/bot 等字样。 */
export const BOT_DISPLAY_NAMES: readonly string[];

/** FNV-1a 32 位：稳定、零依赖、跨进程一致。 */
export function fnv1a32(input: string): number;

/**
 * 纯函数：为一批机器人分配昵称（测试直接消费）。
 * - 输入按 seat 升序处理（确定性）；
 * - 起始下标 = fnv1a32(`${roomCode}:${displayId}:${seat}`) % BOT_DISPLAY_NAMES.length；
 * - 与 `taken`（房间内已存在的昵称）或本批已分配昵称重复时向后线性探测（最多池长次）；
 * - 返回 `Array<{ displayId, nickname }>`，顺序与输入排序后一致。
 */
export function assignBotDisplayNames(
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
  taken?: Iterable<string>,
): Array<{ displayId: string; nickname: string }>;

/**
 * 房间级落盘（唯一入口）：读 Hash → 短锁 → 分配 → HSETNX → EXPIRE。
 * 任何失败只 WARN，**不抛**（fail-open）。
 */
export async function ensureBotDisplayNames(
  redis: Redis,
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
): Promise<void>;
```

`ensureBotDisplayNames` 的执行序：

1. `robots` 为空 ⇒ 直接返回。
2. **抢房间短锁**：`SET room:{code}:botnames:lock <token> EX 3 NX`；未抢到则自旋
   15 × 20ms（覆盖一次正常的分配写入），仍失败 ⇒ WARN 后返回（由持锁方负责）。
   测试可注入 `{ sleep }` 以避免真实等待。
3. `hgetall(nicknamesKey)` 读房间昵称 Hash；读失败 ⇒ WARN + 空对象。
4. 过滤掉 Hash 中**已存在**的 `displayId`（重试/部分补位不覆盖既有名字）。
5. `assignBotDisplayNames(code, missing, Object.values(hash))`。
6. 逐字段 `HSETNX`（并发下第一个写者胜出），随后 `EXPIRE`（Hash 不继承 TTL）。
7. 尽力释放锁（Lua compare-and-delete）；释放失败由 3s TTL 兜底。
   该脚本必须同步扩展 `test/helpers/fake-redis.ts` 的 `makeFakeEval`（本仓纪律：
   新增脚本不得静默返回假结果）。

约束：

- 池大小 ≥ 200；元素 trim 后长度 2–8；池内唯一；不得包含
  `机器人` / `人机` / `电脑` / `AI` / `bot` / `系统` / `官方`。
- 线性探测最多 `BOT_DISPLAY_NAMES.length` 次；耗尽时跳过该机器人（fail-open）。
- `taken` 传入房间昵称 Hash 的**全部非空值**（含人类与已分配机器人），减少撞名。
- `assignBotDisplayNames` 是纯函数（无 IO），便于对确定性/去重做机械断言。

### 4.2 开局写入（`rooms.start.ts`）

**写入点**：`startRoom()` 中 `fillBots()` 成功返回之后、`match:pending` 写入 / 金币场余额 /
`startAndAnnounce` 之前：

```ts
const filled = await this.fillBots(code, room);
if (!filled) return false;
await ensureBotDisplayNames(
  this.redis,
  code,
  filled.seats.filter((s) => s.isRobot).map((s) => ({ seat: s.seat, displayId: s.userId })),
);
```

为什么不在 `fillBots` 内部写（对抗审查 阻断-1）：

- `fillBots` 有两条返回：房间已满时早返 `bindings: []`；正常返回只含**本次** acquire 的
  机器人。已入座但不在本次 `bindings` 的机器人（预置机器人、半途 acquire 失败后重试补上的
  机器人、首次昵称写入失败后重试）会永远拿不到名字。
- 以 `filled.seats` 的 `Seat.isRobot` 为权威输入，覆盖**全量机器人座位**，与是否本次
  acquire 无关。
- `writeBotBindings` 仍留在 `fillBots` 内（局终归池依赖它）；昵称写入与绑定表解耦。

时序与容错：

- 必须在 `startAndAnnounce` 之前完成，保证开局后的首次 `buildRoomPlayers` 能读到名字。
- `ensureBotDisplayNames` 内部吞掉全部异常（fail-open）；昵称失败**不得**让 `startRoom`
  返回 `false`，否则会把展示问题升级成「开不了局」。

### 4.3 下发链路（零改动）

- `RoomNicknamesService.ensure()` 读取 Hash 后会返回**所有**非空昵称（不区分人机），
  `humanIds` 过滤只影响「是否回源」，不影响已缓存条目的返回。
- `buildRoomPlayers()` 以 `Seat.userId` 查昵称；机器人 `Seat.userId = displayId`，正好命中
  昵称 Hash 的字段。
- `room.join` ack 与 `room.state_update` 共用该组装点，自动生效。
- 客户端 `seatNicknames` / `nameOf()` / 结算页 / 历史页均无需改动。

### 4.4 历史战绩快照

1. `packages/protocol/src/rpc.ts` 的 `RecordWriteRequest`：

```ts
seats: Array<{
  seat: number;
  userId: string | null;
  isRobot: boolean;
  robotId: string | null;
  hand: string;
  /**
   * 仅机器人座：本局展示昵称快照（room 从 `room:{code}:nicknames` 读取）。
   * 人类座必须省略/null —— 人类昵称仍由 user-service 按 `user_id` 查 `users`。
   */
  nickname?: string | null;
}>;
```

2. **读取时机（对抗审查 高-2 / D10）**：
   - `onGameEvent` 的 `game.ended` 分支把 `void finalizeRoomEnd(...)` 移到
     `void updateStatus('finished')` **之前**调用。
   - `finalizeRoomEnd` 在**第一个 `await` 之前**先发出
     `this.redis.hgetall(nicknamesKey(event.roomCode))`（失败 ⇒ 空对象 + WARN），
     再等待 bots 绑定表读取；这样昵称读命令先于 `finished` 状态写入进入 Redis，
     reaper 来不及在两者之间删 Hash。
   - 读到的 `Map<displayId, nickname>` 作为参数传入 `writeGameRecord`；
     `writeGameRecord` 不再自己读 Hash。
3. `ws.gateway.ts#writeGameRecord`：
   - 机器人座：`nickname: botNames.get(seat.userId) ?? null`（`seat.userId` 是 displayId，
     只用于查 Map，**不落库**）；
   - 人类座：`nickname: null`（发送侧显式置空，避免误用）。
4. `user-service` 校验与落库：
   - `nickname` 允许 `undefined` / `null` / 字符串；字符串 trim 后必须 1–50 字符；
   - **人类座携带非空 nickname ⇒ 拒收**（`BAD_PARAM`）：人类快照只允许来自 `users`；
   - 增补既有不变量：`!isRobot && userId === null` ⇒ 拒收（防止「人类行没有 user_id」的脏数据）；
   - INSERT 的 `nickname` 列：
     `seat.isRobot ? (seat.nickname?.trim() || null) : (nicknameById.get(seat.userId!) ?? null)`；
   - `game_record_players.is_robot` / `user_id` / `robot_id` 写入规则不变。
5. 历史查询 / 展示逻辑零改动（`nickname` 原样透出）。

### 4.5 文档同步

- `docs/design.md`：
  - 更新 `:1337`、`:1351-1352` 的「机器人昵称恒 NULL」「零区分器」表述；
  - §10.1 Redis 键表（`:1621-1639`）补 `room:{code}:nicknames`（Hash、room-service、
    3600s、field = userId/displayId、空串 = 已知无昵称）；
  - §6.4 / §9.1 / §9.8 中与昵称相关的不可区分性表述同步。
- `packages/protocol/src/views.ts` 的 `RoomPlayer.nickname` 注释（`:50-53`）：
  改为「缺省 = 服务端不知道（RPC 失败 / 存量用户 / 未分配）；机器人通常由 room-service 分配」。
- `docs/superpowers/specs/2026-10-17-nickname-design.md`：§3.3 / §6 相关段落标注
  「机器人昵称由 2026-10-22 设计取代」。
- 历史设计文档加「已被取代」注记（不改写其历史结论）：
  - `docs/superpowers/specs/2026-10-03-records-design.md:190,217,309`
  - `docs/superpowers/specs/2026-10-03-records-spec.md:50`
- 如 `docs/client-protocol.md` / `packages/protocol/src/views.ts` 对机器人昵称有说明，同步更新。

---

## §5 测试判据

### 5.1 room-service

- `bot-names.test.ts`
  - 池：非空、≥ 200、元素唯一、trim 后 2–8 字、不含禁词。
  - `assignBotDisplayNames`：输入乱序时按 seat 升序处理；同输入多次调用结果一致。
  - 房间内不重：构造同哈希/同前缀输入，断言本批名字互不相同且不在 `taken` 中；
    探测上界 = 池长，耗尽时该机器人被跳过而不是死循环。
  - 换房间换名：固定 `displayId/seat`，遍历 **50 个** `roomCode` 后断言结果集合 > 1。
  - `ensureBotDisplayNames`：
    - 正常路径：Hash 字段 = displayId、值 = 昵称、TTL = `ROOM_TTL_SECONDS`；
    - 已存在 displayId 不被覆盖（`HSETNX` 返回 0 时保留旧值）；
    - 锁被占用（fake Redis 首次 `SET NX` 返回 null）⇒ 自旋后放弃、不抛；
    - 读 Hash / 写 Hash / 抢锁抛错 ⇒ 全部 fail-open（`ensure` 不抛）。
  - `robots` 为空 ⇒ 零 Redis 调用直接返回。
- `rooms.start.test.ts`
  - 预置机器人 `p_deadbeef`（不走本次 acquire）在 `startRoom` 后有昵称
    —— 直接覆盖对抗审查阻断-1。
  - 半途 acquire 失败 ⇒ 重试补位后，先入座机器人与新机器人都带昵称。
  - 昵称写入失败 ⇒ `startRoom` 仍返回 `true` 且 `game.start` 照常发出。
  - 既有 `isRobot` 透传用例不回归。
- `room-nicknames.service.test.ts`（真实服务 + fake Redis，**不许 mock ensure**）
  - Hash 预置 `{ p_abc: '阿豆' }` ⇒ `ensure` 返回 `p_abc → 阿豆` 且
    `getNicknames` **不被调用**（证明读路径不依赖 RPC）。
  - 无缓存 ⇒ 仍只回源人类座位（既有正/负对照保留）。
- `message.router.test.ts`
  - `buildRoomPlayers` 对机器人座带 `nickname` 的集成用例必须使用**真实**
    `RoomNicknamesService`（或至少真实 `ensure`），不得只 mock 一个 Map 后断言
    —— 否则旧实现也能绿（对抗审查 高-3）。
- `ws.gateway.test.ts`
  - 记录请求：机器人座带昵称；人类座为 `null`；昵称 Hash 读失败 ⇒ `null`。
  - 时序：`game.ended` 分支中昵称 `hgetall` 发生在 `updateStatus('finished')` 之前
    （fake Redis 记录调用顺序；reaper 删除在之后也不影响快照）。
  - 既有精确 `toEqual` 断言（`:1857-1871`）随新增字段同步更新。
  - §9.8 出站扫描仍绿（不出现 `isRobot` / `botId` / `bot-` 前缀）。

### 5.2 protocol

- `RecordWriteRequest` 可构造带 `nickname` 的机器人座（`tsc --noEmit` 判别）。
- 既有协议测试不回归。

### 5.3 user-service

- `record.rpc.test.ts`
  - 机器人座 `userId=null, isRobot=true` + `nickname='阿豆'` ⇒ 落库昵称 = `阿豆`（trim 后）。
  - 机器人座未带昵称 ⇒ 落库 `NULL`（兼容旧发送方）。
  - 人类座即使携带 `nickname` ⇒ **拒收** `BAD_PARAM`；正常人类座仍按 `users` 快照落库。
  - `!isRobot && userId === null` ⇒ 拒收 `BAD_PARAM`。
  - 昵称非字符串 / trim 后为空 / 超 50 字 ⇒ 拒收。
  - `displayId` 仍绝不落库（既有断言保持）。
- `records.query.test.ts`
  - 机器人座昵称快照非空 ⇒ 历史查询原样返回。
  - 旧数据（机器人昵称 `NULL`）仍返回 `null`，客户端回落规则不变。

### 5.4 回归面排查

- 用 `rg 'nickname' tools/conformance scripts apps/client/test packages/*/test`
  找出对 `players` 做**精确相等**断言的用例，随新增字段同步更新；
  conformance 若断言机器人无昵称，改为「昵称可为空或为展示名，但不得含机器人标识」。
- protocol 先构建，再跑 room-service / user-service 定向测试。
- 全仓 `pnpm test`、`pnpm lint`（按 [dev-process §8](../dev-process.md#8-全量验证)）。

---

## §6 错误处理与边界

| 场景 | 行为 |
|---|---|
| 昵称 Hash 读失败（开局分配） | `taken = []`，照常分配并写；WARN，不抛 |
| 昵称 Hash 写失败（开局分配） | WARN，不阻塞 `startRoom` / `game.start`；该局回落「玩家N」 |
| 抢房间短锁超时 | 自旋约 300ms 后 WARN 放弃；由持锁方写入；不抛 |
| 昵称 Hash 读失败（记录快照） | 机器人 `nickname = null`，写入 NULL；WARN |
| 记录快照读取时机 | 在 `updateStatus('finished')` 之前发起；避免 reaper 删除 `nicknamesKey` |
| Hash 中已有该 `displayId` | `HSETNX` 保留第一次写入的名字（重试/补位重入不覆盖） |
| `fillBots` 早返（房间已满） | 仍以 `filled.seats` 全量机器人分配，覆盖预置/重试机器人 |
| 房间 TTL 到期 | Hash 随房间一起过期，无额外清理 |
| 旧对局记录 | 机器人昵称仍为 `NULL` ⇒ 历史页「玩家N」；不回填 |
| 人类与机器人重名 | 允许（人类昵称本身不唯一） |
| 池探测耗尽（理论） | 跳过该机器人 ⇒ 回落「玩家N」；不死循环 |
| 记录重复投递 | 幂等键与 `ended_at` 逻辑不变；昵称只影响新写入 |
| 既有 `RoomNicknamesService.ensure` 的 `hgetall` 失败 | **本片不改变**：与现状一致，`room.join` 可能失败；不在 D7 fail-open 范围内 |

---

## §7 风险

1. **跨局归纳**：昵称池有限，玩家长时间游戏后仍可能归纳出「某些昵称常出现的机器人」。
   缓解：池 ≥ 200 + 每房间按 `roomCode` 重新分配；残余风险接受。后续可扩池或运营化。
2. **金币场合规**：用户已确认金币场使用拟人机器人没有问题；本设计不再分场次。
3. **旧记录不一致**：历史页新旧对局对机器人展示不同；接受，不回填。
4. **确定性哈希碰撞**：不同 `(roomCode, displayId, seat)` 可能映射到同一昵称；
   房间内由短锁 + 线性探测解决，跨房间无影响。
5. **昵称池内容风险**：池为人工精选常量，测试钉住长度/唯一性/禁词；后续运营改池需走代码评审。
6. **锁失败/超时（已登记）**：抢锁自旋超时或写失败 ⇒ 该局机器人可能无昵称、回落「玩家N」。
   展示问题，不阻塞开局；下一局重新分配。极窄窗口，接受。
7. **记录快照读与 reaper（已缓解）**：昵称读取先于 `finished` 状态写入发起；
   若 Redis 命令乱序/读失败，仍可能落 `NULL`。历史页回落「玩家N」，不回写。
8. **`ensure` 既有读路径**：本片不改其 fail-open 语义；Redis 故障时 `room.join` 行为与现状一致。

---

## §8 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/room-service/src/rooms/bot-names.ts` | 新增：昵称池、哈希、纯分配、短锁 + 落盘 |
| `packages/room-service/src/rooms/rooms.start.ts` | `startRoom` 在 `fillBots` 后对**全量**机器人座位分配昵称（fail-open） |
| `packages/room-service/src/gateway/ws.gateway.ts` | `onGameEvent` 提前启动 `finalizeRoomEnd`；顶部读昵称 Hash；记录组装补机器人快照 |
| `packages/room-service/src/rooms/rooms.service.ts` | `deleteRoom` 已含 `nicknamesKey`，确认无需改动 |
| `packages/protocol/src/rpc.ts` | `RecordWriteRequest.seats[].nickname?` |
| `packages/protocol/src/views.ts` | `RoomPlayer.nickname` 注释同步 |
| `packages/user-service/src/rpc/record.rpc.controller.ts` | 校验（人类座禁带昵称、`!isRobot && userId=null` 拒收）+ 机器人昵称落库 |
| `packages/room-service/test/bot-names.test.ts` | 新增单测（池/确定性/去重/锁/fail-open） |
| `packages/room-service/test/rooms.start.test.ts` | 预置机器人、半途失败重试、fail-open |
| `packages/room-service/test/room-nicknames.service.test.ts` | 真实 `ensure` + 机器人缓存正/负例 |
| `packages/room-service/test/message.router.test.ts` | 真实 `ensure` 的机器人昵称下发 |
| `packages/room-service/test/ws.gateway.test.ts` | 记录快照、读取时序、精确断言更新 |
| `packages/protocol/src/rpc.test.ts` | 类型可构造 |
| `packages/user-service/test/record.rpc.test.ts` | 落库 / 校验 |
| `packages/user-service/test/records.query.test.ts` | 查询透出 |
| `docs/design.md`、`2026-10-17-nickname-design.md`、`2026-10-03-records-*.md` | 文档同步 / 取代注记 |

---

## §9 验收标准

1. 机器人座在 `room.join` ack、`room.state_update` 中带非空 `nickname`，且不含任何机器人标识。
2. 同一局重连 / 状态重推名字不变；不同房间同一机器人可换名；
   **预置机器人、半途 acquire 失败后重试补上的机器人**同样有昵称。
3. 历史战绩里机器人座显示本局昵称（新对局），旧对局维持「玩家N」；
   昵称快照读取先于 `finished` 状态写入。
4. 昵称分配/写入/记录快照读取故障不阻塞开局、不阻塞记录写入；回落「玩家N」。
5. 客户端零 diff；服务端定向测试 + 全仓测试 + lint 通过。

---

## §10 审查记录

### 设计对抗审查（独立 reviewer，2026-10-22）

| # | 分级 | 发现 | 处置 |
|---|---|---|---|
| 阻断-1 | 阻断 | 分配只覆盖 `fillBots` 本次 `botBindings`，预置/半途失败重试的机器人永远无昵称 | **已修**：写入点移到 `startRoom`，以 `filled.seats.filter(isRobot)` 为输入（§4.2） |
| 高-1 | 高 | 「读 Hash → 分配 → HSET」非原子；并发 `startRoom` 可能重名或覆盖 | **已处置**：房间级短锁串行化 + 逐字段 `HSETNX` + 自旋；锁失败登记为 fail-open 风险（§4.1 / §7-6） |
| 高-2 | 高 | 记录快照读 Hash 晚于 `updateStatus('finished')`，reaper 可能已删键 | **已修**：`finalizeRoomEnd` 提前调用，昵称 `hgetall` 在首个 await 前发起（§4.4 / D10） |
| 高-3 | 高 | 下发链路测试用 mock `ensure`，属假绿 | **已修**：测试判据改为真实 `RoomNicknamesService` + 正/负例（§5.1） |
| 高-4 | 高 | D7「全链路 fail-open」与 `ensure` 无 try/catch 矛盾 | **已修**：D7 收窄为新增路径；既有 `ensure` 失败语义明确排除（§3 D7 / §6） |
| 低-1 | 低 | user-service 用 `userId===null` 判机器人；缺 `!isRobot && userId=null` 反向校验 | **已修**：改用 `seat.isRobot` 分支；补拒收规则（§4.4） |
| 低-2 | 低 | 文档同步清单不完整 | **已修**：补齐 design.md 行号、records 设计/spec、`views.ts`、§10.1 键表（§4.5 / §8） |
| 低-3 | 低 | 空 assignments / TTL / 探测上界 / 换房测试弱判据 | **已修**：空输入早返、探测上界、50 房号、禁止死循环（§4.1 / §5.1） |

结论：阻断项已修，高/低项均已处置或登记；进入实现计划。
