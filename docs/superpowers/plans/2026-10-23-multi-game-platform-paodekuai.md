# 多玩法平台化与跑得快接入 — 实现计划 v2.1

- 依据：`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md`（v1.3，三轮设计审查 + 计划审查修订）
- 分支：`dev`（或 `feature/multi-platform` 合回 `dev`）；每个任务一个 commit
- 规则文档：S3 同步创建 `docs/games/paodekuai.md`（唯一规则来源）
- 计划审查记录：见文末「计划审查记录」

## Global Constraints（每个任务都适用）

1. **斗地主行为零变化**：`DdzSettlementResult` 旧 9 键；`game.finished` 斗地主旧 `{winner}`；
   斗地主队列旧 3 段键；WS 命名空间 `/ws/ddz`；`encodeHand/encodeCards` 旧一参调用保持可用。
2. **新增字段过渡期可选**：只有 `undefined`/缺失才缺省 ddz/3；`resolveGameType` 唯一入口；
   pdk 专属字段存在但缺 gameType ⇒ fail closed。
3. **pdk 规则快照字段名 = `pdkRules`**；`FORBIDDEN_OUTBOUND_KEYS` 必须新增 `rules`、`lastPlayedHand`、
   `unusedCards`、`initialHands`、`botIds`、`botSkillLevels`、`botThinkingSpeeds`，并有正向断言。
4. **不新增客户端消息类型**；pdk 只用 `game.play`/`game.pass`；`game.bid` 仅斗地主。
5. **跑得快记录单独建表**；旧 user-service/旧客户端只读斗地主表；`/api/records/mine` 缺省 ddz。
6. **服务端权威**：客户端不实现规则；pdk 牌型只在 `protocol/src/pdk/rule.ts`；hint/autoplay/bot
   全部用 `pdkRules` 快照。
7. **排队/开局**：`queueKeyOfTicket` 统一取键；全模式 `match:claim`；`startRoomOutcome` 三态，
   原 `startRoom(): Promise<boolean>` 保留为兼容包装；pdk 失败不 cancel、留 waiting 重试。
8. **barrel**：每个新增模块必须同步更新 `protocol/src/index.ts` 或 `shared/src/index.ts`
   （两个包无 `exports` 映射，不能深路径导入）。
9. **protocol 测试放 `src/*.test.ts`**（与现有约定一致；`tsconfig` 只 include `src/**/*`）；
   其余包测试放各自 `test/`。
10. **提交信息**末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
11. **TDD**：先失败测试 → 跑红 → 最小实现 → 跑绿 → 提交；不夹带无关重构。
12. **每个跨包任务**同步更新对应门禁（messages 计数、errors 表、protocol-doc-sync、
    source-boundary、rule-error-mapping、asset-budget、verify:admin、conformance 恰键集）。

---

## S0 契约与夹具（分两段：0A 纯新增，0B 消费者收口）

> S0 不是一个 commit。0A 只新增类型/可选字段，保持旧类型/旧签名；0B 才把联合/签名变更与
> 所有消费者放在同一任务，并以 `turbo run lint build test --force` 为门禁。

### Task 0.1 冻结斗地主 golden 与旧校验器夹具

**Files**
- 新增 `packages/game-service/test/fixtures/ddz-golden.json`
- 新增 `packages/protocol/src/fixtures/legacy-validator.ts`（旧 ddz 校验分支冻结副本）
- 新增 `packages/game-service/test/ddz-golden.test.ts`
- 新增 `packages/protocol/src/legacy-compat.test.ts`
- 新增 `packages/protocol/src/fixtures/legacy-validator.gate.test.ts`（源码扫描：副本不得 import 新实现）

**做法**
- **不依赖完整随机对局**（HEAD 的 `deckCards` 用 `Math.random`，无注入点）：
  手工构造固定 `GameSession`（固定 hands/bottomCards/actionLog），调用现有
  `buildPlayerView`/`settleGame` 生成 fixture；再补一场用 `vi.spyOn(Math,'random')` 固定的
  完整局，覆盖超时/托管/机器人分支。
- fixture 包含三家 `PlayerView`、9 键 `SettlementResult`、`game.finished {winner}`。
- `legacy-validator.ts` 复制当前 ddz 分支；gate 测试断言它不 import `./validate`/新类型。
- 测试：
  - `ddz-golden.test.ts`：当前代码 == fixture；
  - `legacy-compat.test.ts`：旧校验器接受新增字段（长度 3）；新校验器接受旧 ddz 消息。
- 命令：`pnpm -C packages/game-service exec vitest run test/ddz-golden.test.ts`、
  `pnpm -C packages/protocol exec vitest run src/legacy-compat.test.ts`。
- 提交：`test: 冻结斗地主 golden 与旧客户端校验器夹具`。

### Task 0.2 GameType / GameMeta（纯新增）

**Files**
- 新增 `packages/protocol/src/game.ts`
- 新增 `packages/protocol/src/game.test.ts`
- `packages/protocol/src/index.ts`

**Interfaces**
```ts
export const GAME_TYPES = ['doudizhu', 'paodekuai'] as const;
export type GameType = (typeof GAME_TYPES)[number];
export const DEFAULT_GAME_TYPE: GameType = 'doudizhu';
export interface GameCapabilities { cardCounter: boolean; bots: boolean; goldRoom: boolean; voiceAnnouncements: boolean; }
export interface GameMeta { id: GameType; name: string; supportedPlayerCounts: readonly number[]; defaultPlayerCount: number; capabilities: GameCapabilities; }
export const GAME_META: Readonly<Record<GameType, GameMeta>>;
export function isGameType(v: unknown): v is GameType;
export function parseGameType(v: unknown): GameType; // undefined ⇒ ddz；空串/非法 ⇒ ProtocolError
export function supportsPlayerCount(gameType: GameType, count: number): boolean;
```
- 测试元数据/默认人数/能力位/空串非法；跑红→实现→绿。
- 提交：`feat(protocol): 玩法目录与兼容缺省`。

### Task 0.3 PdkRulesConfig + shared 默认值 + pdk 配置键（纯新增）

**Files**
- 新增 `packages/protocol/src/pdk/rules.ts`
- 新增 `packages/protocol/src/pdk/rules.test.ts`
- **`packages/protocol/src/config.ts`**（追加 14 个 pdk 键 + `parseConfigValue` 分支）
- **`packages/protocol/src/config.test.ts`**
- `packages/protocol/src/index.ts`
- 新增 `packages/shared/src/pdk/rules.ts`
- 新增 `packages/shared/src/pdk/rules.test.ts`
- `packages/shared/src/index.ts`

**Interfaces**
```ts
// protocol
export interface PdkRulesConfig { /* 6 个牌型开关 + 3 个翻倍开关 + multiplierCap + baobenEnabled */ }
// shared
export const DEFAULT_PDK_RULES: PdkRulesConfig;
export function parsePdkRules(input: unknown): PdkRulesConfig; // 校验/夹取 cap
```
- `CONFIG_KEYS` 追加：`game.levels.paodekuai`、`game.paodekuai.enabled`、
  `nonThreePlayerEnabled`、6 个牌型键、3 个翻倍键、`multiplierCap`、`baobenEnabled`。
- `parseConfigValue` 增加 `airplaneWings` 枚举、boolean/int/BaseScoreLevel[] 分支。
- **为什么在 S0**：S2 的 `ConfigCacheService` 与 `pdkRules()` 依赖这些键；不能等 S5。
- 测试默认值、枚举、cap 范围、未知键、14 键清单；跑红→实现→绿。
- 提交：`feat(protocol,shared): 跑得快规则配置类型、默认值与配置键`。

### Task 0.4 协议可选字段（纯新增，不联合）

**Files**
- `packages/protocol/src/views.ts`
- `packages/protocol/src/messages.ts`
- `packages/protocol/src/rpc.ts`
- `packages/protocol/src/records.ts`（只加 `encodeHand` 新重载/可选 expected，旧一参不变）
- `packages/protocol/src/robot.ts`
- **`packages/protocol/src/validate.ts`**（`FORBIDDEN_OUTBOUND_KEYS` 增键）
- `packages/protocol/src/errors.ts`（12012）
- `packages/protocol/src/index.ts`
- 对应 `src/*.test.ts`
- 新增 `packages/protocol/src/pdk/types.ts`（**pdk 视图/结算/特征类型的唯一归属**；
  `settlement.ts`/`robot.ts` 只 import/re-export）

**做法**
- 旧 `PlayerView`/`SettlementResult`/`RobotFeatures`/`RecordWriteRequest.result` 保持原样。
- 新 `PdkPlayerView`/`PdkSettlementResult`/`PdkRobotFeatures` 定义在 `pdk/types.ts`；
  `settlement.ts`/`robot.ts` re-export（Task 0.5 再并入 union）。
- 在旧类型上加**可选** `gameType?`/`playerCount?`；`RoomInfo.gameType?`。
- `encodeHand(cards, expected?)`：expected 可选，缺省 17；`decodeHand` 同理。
- `StartGameRequest` 加可选 `gameType/playerCount/rules/seed/testDeck`；
  `GameStartedResponse` 的 `gameType/playerCount` 先可选。
- `RecordWriteRequest` 加可选 `gameType/playerCount/unusedCards`、`seats[].playedCount?`。
- `RobotDecideRequest.view` 暂不改联合（0B 再改）。
- `JoinRoomDto` **不放 protocol**（class-validator 归属 room-service，见 Task 2.2）。
- `FORBIDDEN_OUTBOUND_KEYS` 新增 `rules/lastPlayedHand/unusedCards/initialHands/botIds/
  botSkillLevels/botThinkingSpeeds`；加一条“带 `rules` 的载荷必须抛”的正向断言。
- `ErrCode.GAME_UNAVAILABLE=12012`；`errors.test.ts` SPEC_CODES 同步。
- 测试旧 JSON 仍通过；新可选字段可缺省；12012；禁键正向。
- 提交：`feat(protocol): 多玩法可选字段、pdk 类型与 12012`。

### Task 0.5 联合类型 + 全部消费者收口（B1）

**Files（必须全列，同一 commit 内改绿）**
- protocol：`src/views.ts`、`src/settlement.ts`（新）、`src/messages.ts`、`src/rpc.ts`、
  `src/records.ts`、`src/robot.ts`、`src/validate.ts`、`src/config.ts`、`src/index.ts`
- shared：`src/ddz/settle.ts`（返回 Ddz 9 键）、`src/ddz/game.ts`（GameSession 类型）、
  `src/index.ts`、`src/ddz/settle.test.ts`、**`src/ddz/types.test.ts`**
- game-service：`src/game/{game.service,view.builder,dto}.ts`、`src/rpc/game.rpc.controller.ts`、
  `test/*`（含 `game.service.redis.test.ts` 的 record 恰三键断言）
- room-service：`src/currency/settle.service.ts`、`src/gateway/ws.gateway.ts`、
  `src/gateway/message.router.ts`（view trustees）、`src/rooms/rooms.start.ts`、`test/*`
- robot-service：`src/robot/{bot.player,robot.service}.ts`、`test/*`
- user-service：`src/rpc/record.rpc.controller.ts`、`src/records/records.service.ts`、`test/*`
- client：`src/stores/game.ts`、`src/net/session.ts`、**`src/components/Settlement.vue`**、`test/*`
- conformance：`src/slices/slice-15-records.ts`、`slice-20-risk-control.ts`、
  `src/lib/ddz-driver.ts`

**做法**
- `GameView = DdzPlayerView | PdkPlayerView`；`SettlementResult` 联合；`game.finished` 联合；
  `RobotDecideRequest.view: GameView`；`RobotFeatures` 联合。
- **所有读取方按 `'gameType' in x` 或 `resolveGameType()` 收窄**；不得用 `as` 绕过。
- 旧 `encodeHand(hand)` 一参仍可用；新增 `encodeHand(hand, expected)` 重载。
- `DdzSettlementResult` 保持 9 键；`PdkSettlementResult` 用 `SettlementVector`。
- 每个消费者补一条类型/行为测试；`pnpm exec turbo run lint build test --force` 绿。
- 提交：`refactor: 多玩法联合类型与全消费者收口`。

**注意**：这是 S0 唯一允许跨多包的大 commit；不拆则 S0 必红。

### Task 0.6 S0 门禁

- `pnpm exec turbo run lint build test --force`（必须真跑，`Cached` 不算）
- `pnpm -C packages/protocol exec vitest run src/legacy-compat.test.ts`
- `pnpm -C packages/game-service exec vitest run test/ddz-golden.test.ts`
- 更新 `messages.test.ts`（计数不变）、`errors.test.ts`、`protocol-doc-sync`。
- 提交：`test: S0 契约门禁`。

---

## S1 内核 + 斗地主 runtime（行为不变）

### Task 1.1 `shared/core` + ddz 类型改造

**Files**
- 新增 `packages/shared/src/core/{session,action}.ts`
- 迁移 `packages/shared/src/ddz/{governance,timer}.ts` → `core/`，ddz 保留 re-export
- **`packages/shared/src/ddz/types.ts`**：`GameSession extends GameSessionBase<Card>`，
  加 `gameType:'doudizhu'`/`playerCount:3`/`rules?: never`；保留 ddz 专有字段
- `packages/shared/src/index.ts`
- `packages/shared/src/core/*.test.ts`、`packages/shared/src/ddz/types.test.ts`

**Interfaces**
- `GameSessionBase<P=Card>`：含 `gameType/playerCount/rules/botIds/botSkillLevels/
  botThinkingSpeeds/initialHands`。
- `GameAction = {kind:'bid';grab}|{kind:'play';cards}|{kind:'pass'}`。
- 测试：ddz 会话可赋给基类；现有 shared 测试全绿；re-export 等价。
- 提交：`refactor(shared): 抽出玩法无关会话与治理基类`。

### Task 1.2 GameRuntime / Registry（先用 fake）

**Files**
- 新增 `packages/game-service/src/games/{runtime,registry}.ts`
- `packages/game-service/test/registry.test.ts`
- **不改 `game.module.ts`**（DdzRuntime 尚未存在；注册放 Task 1.3 末尾）

**Interfaces**
- `CreateGameInput` 含 `seed?/testDeck?`。
- `GameRuntime<S>`：`create/applyAction/onTimeout/isFinished/finish/settle/buildView/
  buildAllViews/buildRobotInput/buildRecord/currentActor/timerPhase/turnDuration/autoAction`。
- `GameRegistry.register/get`；测试用 fake runtime。
- 提交：`feat(game-service): 玩法 runtime 接口与注册表`。

### Task 1.3 斗地主 runtime / view / 错误映射迁移

**Files**
- 新增 `packages/game-service/src/games/ddz/{runtime,view,rule-error.mapping}.ts`
- `packages/game-service/src/game/{view.builder,rule-error.mapping}.ts`（re-export/删除）
- `packages/game-service/src/game/game.module.ts`（末尾注册 DdzRuntime）
- `packages/game-service/test/ddz-runtime.test.ts`

**做法**
- 按 spec §4.3 实现 `DdzRuntime`；`create` 设 bot 字段；`finish` 设 winner/Ended/finishedAt；
  `buildAllViews` 遍历 players；`buildRecord` 现有信封。
- 测试 runtime 各方法 == 现有函数输出；module 注册测试。
- 提交：`refactor(game-service): 斗地主 runtime 适配层`。

### Task 1.4 GameService 收口到 runtime（完整替换清单）

**Files**
- `packages/game-service/src/game/game.service.ts`
- `packages/game-service/src/game/game.module.ts`
- `packages/game-service/src/rpc/game.rpc.controller.ts`
- **`packages/game-service/src/game/game.controller.ts`**
- `packages/game-service/src/game/dto.ts`（删除重复 `StartGameRequest`，统一 protocol）
- `packages/game-service/src/games/ddz/runtime.ts`（`DdzRecordEnvelope` 加可选
  `gameType?:'doudizhu'`/`playerCount?:3`）
- `packages/game-service/test/*`（含 `full-game`、`game.robot`、`concurrency`、`game.timer`、
  `di-metadata.positive-control`、`game.module.wiring`、`game.service.redis`）

**替换清单（逐项）**
| 现分支 | 改走 |
|---|---|
| `startGame` 幂等 | 先比对 gameType/playerCount/rules，再早退；`runtime.create` |
| **`loadSession` 旧会话** | 缺 `gameType` 且有 ddz 字段 ⇒ ddz/3；有 pdk 字段但缺 gameType ⇒ fail closed；补旧 Redis 会话测试 |
| `getView`/`getViewForUser`/`actAndView` | `runtime.buildView`；HTTP/RPC 返回 `GameView` |
| `publishSeatViews` | `runtime.buildAllViews`；事件信封带 gameType/playerCount |
| `finishTransition`/`publishEnded`/`buildRecordEnvelope` | `runtime.isFinished/finish/settle/buildRecord` |
| `startTurnTimer`/`deadlineFor` | `runtime.currentActor/timerPhase/turnDuration` |
| `onTurnTimeoutLocked` | `runtime.onTimeout` |
| `applyTrusteeLocked` | `runtime.autoAction` |
| `driveRobotTurn`/`driveOneRobotTurn` | `runtime.buildRobotInput` |
| `commitRobotDecisionLocked`/`applyDecisionToSession` | `runtime.applyAction` |
| `ruleDecision`/`findSmallestBeatingCards` | `runtime.autoAction` |
| `backfillSuits`/`isBotSeat`/`governanceOf` | 通用或保留（无 ddz 规则调用） |

- 会话存储类型统一 `GameSessionBase`（或 `DdzSession | PdkSession`），`getSession` 返回联合；
  runtime 按 `gameType` 分派。
- **pdk 路径 smoke 测试**（用 fake runtime）：即使 PdkRuntime 未实现，也证明
  `getView/actAndView/driveOneRobotTurn/publishEnded` 不再直接调 ddz 函数。
- DI 测试：`di-metadata.positive-control`/`game.module.wiring` 同步（属性注入或内联装配）。
- 先跑现有全量基线；每替换一项跑对应测试；最后 `turbo run lint test --force`。
- 提交：`refactor(game-service): 规则调用收口到 runtime（斗地主零变化）`。

### Task 1.5 S1 门禁

- `pnpm -C packages/game-service test`、`pnpm -C packages/shared test`、
  `pnpm -C packages/protocol test`
- `ddz-golden` 逐字通过；`game.service.redis.test.ts` 的 record 信封断言更新为
  “旧 3 键 + 可选 gameType/playerCount”的明确形状。
- 提交：`test(game-service): S1 斗地主 golden 回归`。

---

## S2 房间/匹配/机器人横切

> **S2 执行状态（2026-10-23）**：Task 2.1–2.7 全部完成。
> 提交：`0fc1eee2` → `9d06966e` → `d93539ff` → `5c19a54a` → `4ea4a453` → `2f8449bd` → 本门禁提交。
> 验证：room-service **872** / robot-service **132** / protocol **250** / shared **305** /
> game-service **225** / user-service **315**；`turbo run lint test --force` **19/19（0 cached）**；
> 真栈 conformance `slice-05` **68** · `slice-06` **73** · `slice-07` **39** · `slice-12` **90**，
> 另跑 `slice-10` **187**（斗地主终局视图/结算旧形状零变化）。
>
> **实现期偏差登记**（均已在代码注释写明）：
> 1. `match:claim` 的值 = **roomCode**（spec §4.6.1；覆盖 Task 2.1 原文的 `'1'` 措辞）——
>    扫描器据此识别「已开局但 onSeats 未删票」并幂等 `cancelQueue`。
> 2. `start_attempts` 键放在 `rooms/rooms.seats.ts` 叶子模块（不新增 `match-keys` 依赖）；
>    `rooms.autostart.ts` 无需改动：重试/取消预算由 `startRoomOutcome` 内部处理，扫描器只按周期重试。
> 3. pdk `robot.availability` 恒 `canProvide:true`：规则 bot 可按需创建，**不探测 DouZero**；
>    不把「池暂时为空」当成不可用（否则首个 pdk 局会因空池被门禁拦住）。

### Task 2.1 队列键 + queueKeyOfTicket + 全模式 match:claim

**Files**
- `packages/room-service/src/match/match.service.ts`
- `packages/room-service/src/gateway/message.router.ts`
- `packages/room-service/test/{match-queue-key,match-claim,match-switch-game}.test.ts`

**Interfaces**
```ts
type ParsedQueueKey = { key: string; mode: MatchMode; gameType: GameType; playerCount: number; baseScore: number; region: string; legacy: boolean };
function matchQueueKey(mode, gameType, playerCount, baseScore, region): string; // ddz 旧 3 段; pdk 新 5 段
function parseMatchQueueKey(key): ParsedQueueKey | null;
function queueKeyOfTicket(ticket): string;
```
- `MatchTicket` 加 `queueKey?/gameType?/playerCount?`。
- `match:claim:{playerId}` **去掉 gold-only 条件**（`readClaimFlags` 不再判 `mode==='gold'`）；
  扫描跳过 claim 持有者；TTL。
- 测试必须覆盖 `random`/`practice` 也写入 claim、扫描跳过、并发不重复开局。
- `cancelQueue/failMatch/probe` 全部用 `queueKeyOfTicket`。
- `handleMatch` 不同维度先 cancel 旧票再入队。
- 测试：ddz 旧键/pdk 新键/旧 meta/old ticket cancel 无残留/重新 match 不双入队/
  claim random+practice/并发扫描。
- 提交：`feat(room-service): 玩法/人数队列键与全模式 claim`。

### Task 2.2 房间元数据 / REST+WS join / POST 建房

**Files**
- `packages/room-service/src/rooms/{rooms.service,rooms.controller,rooms.dto}.ts`
- `packages/room-service/src/gateway/{ws.gateway,message.router}.ts`
- `packages/room-service/src/http/errors.ts`（12012 → 4xx）
- `packages/room-service/src/config/config-cache.service.ts`（按玩法档位/台费/规则）
- `packages/room-service/test/{rooms-meta,room-join-game-type,room-create-game-type,config-cache}.test.ts`

**做法**
- `RoomMeta.gameType?`；`META_FIELDS` 增 `gameType`；`readMeta` 缺失/非法（含 `"undefined"`）⇒ ddz+WARN；
  `writeMeta` 写 `?? ddz`；`deleteRoom` 删除集含 `start_attempts`。
- `RoomInfo` 增 `gameType?`；`playerCount` 保持当前占用。
- `JoinRoomDto`/`CreateRoomDto` 放 **room-service `rooms.dto.ts`**（class-validator；
  protocol 零依赖，不放 DTO）；`ValidationPipe({whitelist:true})` 不得剥掉 gameType/playerCount。
- REST join：占座前校验 gameType；不带 ⇒ ddz；pdk 房 12012 不占座。
- `POST /api/rooms`：gameType/playerCount、`game.paodekuai.enabled`、`nonThreePlayerEnabled`、
  `assertKnownBaseScore(gameType, baseScore)`。
- **WS `room.match`**：`handleMatch`/`addToQueue` 同样做 enabled/nonThree/`assertKnownBaseScore`
  判定；非法 ⇒ `12012`（DomainError，不是 10001）。
- `GET /api/rooms?gameType=` 缺省 ddz。
- `ConfigCacheService`：`baseScoreLevels(gameType)`（ddz 旧键/pdk 新键）、
  `entryFeePercents(gameType)`、`levelNameFor(gameType)`、`pdkRules()`；新参数缺省 ddz，
  既有调用不破。
- `message.router.ts` 的 `viewWithTrusteeCleared` 改为 `view.trustees.map(...)`/
  长度 `playerCount`，不得截 3 元组；补 2/4 人 reconnect 测试。
- `http/errors.ts` 补 12012 映射（按 §11.2 的 4xx）。
- `room.matched`/`room.state_update` 带 gameType/playerCount。
- 测试：旧 Hash 往返、REST/WS join、POST 建房、12012 的 **HTTP status**、ConfigCache 分玩法、
  random/practice match 的 enabled/人数闸。
- 提交：`feat(room-service): 房间玩法元数据与 REST/WS/建房守卫`。

### Task 2.3 匹配分组/2-4 人（逐函数）

**Files**
- `packages/room-service/src/match/match.service.ts`
- `packages/room-service/test/match-player-count.test.ts`

**逐函数清单**
- `processQueue`：`alive.length >= 3` → `>= playerCount`；`selected.length === 3` → playerCount。
- `randomGreedyPick`：组大小/窗口/attempts 读 playerCount。
- `maxLegalSubset`：`subset.length >= 3` → playerCount。
- `greedyHumanGroups`：依赖 maxLegalSubset。
- `timedOutFallback`：`group.length < 3`/`=== 3` → playerCount。
- `processQueueNoBots`：恰好 3 真人 → 恰好 playerCount。
- `startGroup`：座位数 = playerCount。
- 首版 `nonThreePlayerEnabled=false` 只允许 3；开关打开覆盖 2/4。
- 指标标签加 `game_type`/`player_count`。
- 测试：4 人凑 4、2 人凑 2、3 人桶与 2 人桶隔离、开关关拒绝。
- 提交：`feat(room-service): 2/3/4 人匹配参数化`。

### Task 2.4 开局链：规则快照 / 三态 / warning / onSeats

**Files**
- `packages/room-service/src/rooms/rooms.start.ts`
- `packages/room-service/src/match/match.service.ts`（`startGroup` 三态消费）
- `packages/room-service/src/rooms/rooms.autostart.ts`
- `packages/room-service/src/gateway/{ws.gateway,match-keys}.ts`
- `packages/room-service/test/{rooms.start,rooms.card-counter,rooms.entry-fee,match.service,
  rooms-start-pdk,pdk-start-retry}.test.ts`

**做法**
- **保留 `startRoom(): Promise<boolean>` 兼容包装**；新增
  `startRoomOutcome(): Promise<'started'|'retryable'|'fatal'|'legacy-failed'>`。
  `startGroup` 用 outcome：只有 `fatal` 才 `cancelIfStillWaiting`；pdk `retryable` 留等待；
  **ddz `strict:false` 的 `game.start` 失败仍写 `playing`（N36）⇒ `'legacy-failed'`**，
  包装层返回 false，`startGroup` 保持旧行为（不新增 cancel）。
- pdk 顺序：读规则成功 → announce → `game.start(strict:true, rules)` → `onSeats` 后置。
- `onSeats` 在 `game.start` 成功后失败 ⇒ WARN + 下一轮按 `queueKeyOfTicket` 幂等
  `cancelQueue`，不把已开局的房判失败、不重复匹配；补“start 成功 + onSeats 失败 + 下一轮扫描”测试。
- 失败：不 cancel/不删票；`room:{code}:start_attempts` INCR（TTL=ROOM_TTL，deleteRoom 删除）；
  ≥5 或 waiting timeout ⇒ cancel + `system_warning {playerIds,code:10007,message}` +
  `robot.release`（带 gameType）。
- `MatchEvent` 增 `system_warning`；`onMatchEvent` 定向 emit `system.warning`。
- 记牌器能力位；pdk 不扣费。
- `game.start` 透传 seed/testDeck（测试钩子）。
- `game.finished` ddz 旧 `{winner}` / pdk `{gameType,winnerSeats}`（`'gameType' in result`）。
- 既有 `startRoom` 64 处 `toBe(true/false)` 测试保持绿（包装语义不变）。
- 测试：pdk 规则失败/重试/5 次取消/onSeats 延迟/并发 claim/warning 事件/ddz 旧路径。
- 提交：`feat(room-service): 跑得快开局链与重试预算`。

### Task 2.5 结算/余额/outbox/校验器

**Files**
- `packages/room-service/src/currency/settle.service.ts`
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/protocol/src/validate.ts`（`game.balances` 长度）
- `packages/protocol/src/rpc.ts`（`validateRecordMoneyDelta` 长度）
- `packages/room-service/test/{settle-pdk,settle-outbox-player-count}.test.ts`
- `packages/protocol/src/validate.test.ts` / `rpc.test.ts`

**做法**
- `computeSettlement`：`'gameType' in result && result.gameType==='paodekuai'` ⇒ pdk 向量；
  否则旧地主公式（9 键不变）。
- `resolveSeats`/`coversAllSeats` 按 playerCount。
- `SettleOutboxEntry` **与** `RecordMoneyOutboxEntry` 都加 `gameType?/playerCount?`；
  resend/finalize 广播与 moneyDelta 从条目取。
- `game.balances` 校验按 `playerCount`（缺失 ddz/3）；`validateRecordMoneyDelta` 按 playerCount。
- 测试：ddz 9 键不变、pdk 2/3/4、全保本 0、outbox 2/4、旧 outbox 缺省。
- 提交：`feat(room-service,protocol): 按玩法结算与 N 座校验`。

### Task 2.6 机器人池框架（pdk bot 实现留 S3.6）

**Files**
- `packages/robot-service/src/robot/{robot.pool,bot.player,robot.service}.ts`
- `packages/protocol/src/pdk/types.ts`（`PdkRobotFeatures.lastMove` 加 `wingMode?`）
- `packages/protocol/src/robot.ts`（只 re-export `RobotFeatures` 联合）
- `packages/shared/src/ddz/features.ts`（`gameType:'doudizhu'`）
- `packages/robot-service/test/{pool-game-type,bot-player-dispatch,robot.pool,robot.decide,bot.player}.test.ts`

**做法**
- `BotInstance.gameType`；池键 `bot:pool:{gameType}`；旧 `bot:pool:ddz` 双读迁移；
  release 从 bot 记录推导；reclaim/list/poolSize 按玩法。
- `bot.player` 分派；ddz 走现有；pdk 先返回“未实现”错误（**不作为 S2 完成条件**），
  S3.6 再补 `bots/pdk.ts`。
- `RobotFeatures` 联合；`PdkRobotFeatures.lastMove` 带 `wingMode?`。
- 测试：池/回收/双读；ddz 分发不变。
- 提交：`feat(robot-service): 按玩法机器人池与分发框架`。

### Task 2.7 S2 门禁

- `pnpm -C packages/room-service test`、`pnpm -C packages/robot-service test`
- conformance 05/06/07/12 斗地主旧键。
- 提交：`test: S2 房间/匹配/机器人回归`。

---

## S3 跑得快纯规则

> **S3 执行状态（2026-10-24）**：Task 3.1–3.7 全部完成。
> 提交：`83450c0b`（3.1 牌堆/发牌）→ `4b0c8f52`（3.2 牌型/规则文档）→ `bd64d29c`（3.3 回合/胜负）
> → `d3d2995b`（3.4 结算）→ `8b42a8ce`（3.5 autoplay/特征）→ `8a9fb14a`（3.6 规则 bot）→ 本门禁提交。
> 验证：protocol **276** / shared **392** / robot-service **142** / game-service **225**（斗地主回归）；
> `turbo run lint test --force` **13/13（0 cached）**；`turbo run build --force` **5/5**；
> shared 覆盖率 **97.34%**；`doc-sync` 绿（规则文档默认值与 `DEFAULT_PDK_RULES` 一致）。
>
> **实现期偏差/口径登记**：
> 1. `PdkHandType`/`PdkParsedHand` 继续归属 `protocol/src/pdk/types.ts`（S0 决策），`rule.ts` 只放
>    `parsePdkHand`/`canBeatPdk`，不复制类型。
> 2. `PdkSession` 增 `winnerSeats?: number[]`（spec §5.5 的终局字段）；`settlePdk` 以**实际手牌**
>    判定唯一赢家（未结束/多赢家 fail-closed）。
> 3. `handlePdkTimeout` 在 3.3 是最小实现（跟牌一律过牌），3.5 已升级为与规则 bot 共用的
>    `findSmallestBeatingPdk`（无解才过牌）。
> 4. autoplay 只枚举「目标同型大小 + 炸弹 4 张」的组合，用 `parsePdkHand`/`canBeatPdk` 同源校验；
>    「最小」= 非炸弹优先 → keyRank → 点数序列 → 花色序列。关闭牌型/翅膀形状由解析器过滤。
> 5. `buildPdkFeatures.lastMove.cards` 从 `actionLog` 最后一条 play 派生（公开信息），会话不额外
>    存 `lastPlayedCards`；`passCount` = `consecutivePasses`。
> 6. 规则 bot 首版 = autoplay；`features.pdkRules` 为唯一规则输入（RH5），不调用 DouZero；
>    策略产出自检非法时回退 autoplay。game-service 侧的「被拒回退」在 S4 接线。

### Task 3.1 牌堆/发牌/会话类型

**Files**
- 新增 `packages/shared/src/pdk/{deck,deal,types}.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/pdk/{deck,deal,types}.test.ts`

**Interfaces**
```ts
export interface PdkSessionInput { roomCode; playerCount: 2|3|4; baseScore; rules: PdkRulesConfig; players: {id,seat,isBot}[]; random: () => number; testDeck?: Card[]; }
export function createPdkDeck(): Card[]; // 48 张
export function dealPdk(input: PdkSessionInput): { hands: Card[][]; unusedCards?: Card[] };
export function resolveFirstLeader(hands, playerCount, random): number;
```
- 测试：48/去牌/红桃2/3-4 人/2 人扣牌/红桃3..2/全扣 testDeck/非法 testDeck。
- 提交：`feat(shared): 跑得快牌堆与 2/3/4 人发牌`。

### Task 3.2 牌型解析/比较（protocol）+ 规则文档

**Files**
- 新增 `packages/protocol/src/pdk/rule.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/pdk/rule.test.ts`
- 新增 `docs/games/paodekuai.md`（规则文档初稿）
- 新增 `packages/shared/src/pdk/doc-sync.test.ts`（文档默认值/关键口径对账）

**Interfaces**
```ts
export enum PdkHandType { Invalid=0, Single, Pair, Trio, TrioWithSingle, TrioWithPair, FourWithTwo, Straight, ConsecutivePairs, Airplane, AirplaneWithWings, Bomb }
export interface PdkParsedHand { type: PdkHandType; keyRank: number; length: number; wingMode?: 'pairs'|'singles'; }
export function parsePdkHand(cards: Card[], rules: PdkRulesConfig): PdkParsedHand;
export function canBeatPdk(candidate: PdkParsedHand, target: PdkParsedHand, rules: PdkRulesConfig): boolean;
```
- keyRank 取最大；解析优先级按 spec §5.4；单翅点数两两不同；不得拆第 4 个三张。
- 真值表：AAA/KKKK/四带二/飞机/三带二开关/炸弹可拆/A 高顺 vs 7 高顺。
- 提交：`feat(protocol): 跑得快牌型解析与比较`。

### Task 3.3 回合/胜负/保本

**Files**
- 新增 `packages/shared/src/pdk/play.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/pdk/play.test.ts`

**Interfaces**
```ts
export function createPdkSession(input: PdkSessionInput): PdkSession;
export function handlePdkPlay(session, playerId, cards): PdkSession;
export function handlePdkPass(session, playerId): PdkSession;
export function handlePdkTimeout(session): PdkSession;
export function isPdkFinished(session): boolean;
export function finishPdk(session, now): PdkSession;
```
- 首出不可过；全过回最后出牌者；出完即结束；playedCount。
- 测试：首出/跟牌/过/全过/胜负/非法/不是回合/精确摘牌/保本。
- 提交：`feat(shared): 跑得快回合流转与胜负`。

### Task 3.4 结算

**Files**
- 新增 `packages/shared/src/pdk/settle.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/pdk/settle.test.ts`

**Interfaces**
```ts
export function settlePdk(session: PdkSession): PdkSettlementResult;
```
- 公式见 spec §5.6；默认/逐项关/封顶/保本/2 人/4 人/春天/零和。
- 提交：`feat(shared): 跑得快结算与保本`。

### Task 3.5 autoplay / features

**Files**
- 新增 `packages/shared/src/pdk/{autoplay,features}.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/pdk/{autoplay,features}.test.ts`

**Interfaces**
```ts
export function findSmallestBeatingPdk(hand, target, rules): Card[] | null;
export function chooseLeadPdk(hand, rules): Card[];
export function buildPdkFeatures(session, seat): PdkRobotFeatures;
```
- 关闭牌型不产出；炸弹可拆；`lastMove` 带 wingMode；公开特征不含未出牌。
- 提交：`feat(shared): 跑得快 autoplay 与机器人特征`。

### Task 3.6 机器人 pdk bot 实现

**Files**
- 新增 `packages/robot-service/src/robot/bots/pdk.ts`
- `packages/robot-service/src/robot/bot.player.ts`（接线）
- `packages/robot-service/test/bot-pdk.test.ts`

**做法**
- 用 `findSmallestBeatingPdk/chooseLeadPdk` + `features.pdkRules`；非法被拒回退 autoplay。
- 测试：合法动作、关牌型、首出/跟牌、降级。
- 提交：`feat(robot-service): 跑得快规则 bot`。

### Task 3.7 S3 门禁

- `pnpm -C packages/shared test`、`packages/protocol test`、`packages/robot-service test`
- `doc-sync` 绿。
- 提交：`test: S3 跑得快规则真值表`。

---

## S4 跑得快 game-service

> **S4 执行状态（2026-10-24）**：Task 4.0–4.5 全部完成。
> 提交：`3df0ff30`（4.0 user-service 表/写入）→ `7cbc763e`（4.1 runtime/视图/错误映射）→
> `3ccf4063`（4.2 超时/托管/机器人 + GameService 泛化）→ `e88d7caf`（4.3 结算/记录/ws 映射）→
> `33ae86a6`（4.4 seed/testDeck + conformance 接口预留）→ 本门禁提交。
> 验证：user-service **333** / game-service **262** / room-service **877** / shared **392**；
> 各包 `lint`（tsc 含 test tsconfig）绿；conformance `build` 绿。
>
> **实现期偏差/口径登记**：
> 1. **GameService 存储类型**：内部用 `AnyGameSession = GameSession | PdkSession`，但
>    `getSession/loadSession/getSnapshot/bid/playCards/pass` 用**泛型默认 `GameSession`**
>    ——既有 ddz 调用点/测试零改动，pdk 侧显式 `getSession<PdkSession>()`。`loadSession`
>    对 pdk 做形状守卫（缺 rules/players/actionLog/lastPlayerIdx ⇒ fail closed）。
> 2. **pdk 终局字段**：`shared/pdk/play.ts` 在出完最后一张时即 `finishPdk`（state/winnerSeats/
>    finishedAt 已落）；`PdkRuntime.finish` 幂等 ⇒ orchestrator 的 `finish(now)` 不改写
>    `finishedAt`（是动作时刻，不是收尾时刻）。
> 3. **记录信封双份定义**：room-service `RecordEnvelope` 按跨服务边界保留独立定义
>    （与既有 ddz 信封同款），形状与 game-service `PdkRecordEnvelope` 对齐。
> 4. **seed 确定性**：`PdkRuntime` 用 mulberry32（seed 仅内部钩子；`game.start` 入口门控）。
> 5. **规则错误覆盖闸**：扫描器补「多行实参 + 尾逗号」支持（`shared/pdk/settle.ts` 的真实
>    形态；原正则会把后续源码吞成畸形消息）；扫描面扩到 `shared/src/{pdk,core}` 与
>    `protocol/src/pdk`。
> 6. **room-service `writeGameRecord`**：pdk 请求显式带 `gameType/playerCount/playedCount/
>    unusedCards`；斗地主请求**保持旧形状**（仍带 `bottomCards`，省略上述 pdk 专有键）。
> 7. **mode/底分**：记录写入沿用 room 元数据；pdk 2 人局 `unusedCards` 只在 2 人信封出现。

### Task 4.0 user-service pdk 表/写入（前置，RH9）

**Files**
- `packages/user-service/src/migrations/*PdkRecords*`
- `packages/user-service/src/rpc/record.rpc.controller.ts`（pdk 写入分支）
- `packages/user-service/src/records/records.service.ts`（写入分支）
- `packages/user-service/test/record-pdk-write.test.ts`

**做法**
- 建 spec §4.9.1 的 pdk 两表（含 `ended_at`/索引）。
- `record.write` 按 `request.gameType` 分支：pdk 校验 seats/手牌/playedCount/unusedCards；
  写父表 + players；`record.moneyDelta` 写 pdk players。
- 旧表零迁移；旧请求缺省 ddz。
- 测试：pdk 3 人写入/幂等/2 人扣牌/playedCount；旧 ddz 不变。
- 提交：`feat(user-service): 跑得快战绩写入与表结构`。

### Task 4.1 PdkRuntime / 视图 / 错误映射

**Files**
- 新增 `packages/game-service/src/games/pdk/{runtime,view,rule-error.mapping}.ts`
- `packages/game-service/src/games/runtime.ts`（类型）
- `packages/game-service/src/game/game.module.ts`（注册）
- `packages/game-service/test/{pdk-runtime,rule-error-mapping}.test.ts`

**做法**
- `create`：`dealPdk` + rules 快照 + leader；`buildView`：`PdkPlayerView`（`pdkRules`/canPass/
  bombCount/winnerSeats）；`buildAllViews`；`currentActor`/`timerPhase='play'`/`turnDuration`。
- `applyAction`：bid ⇒ 13001；play/pass；`finish`。
- `autoAction`：`findSmallestBeatingPdk/chooseLeadPdk`。
- `settle`：`settlePdk`；`buildRecord`：PdkRecordEnvelope（playedCount/unusedCards）。
- **rule-error mapping**：新文件 + 扫描面扩到 `shared/src/pdk`/`shared/src/core`/`protocol/src/pdk`；
  `PROTOCOL_RULE` 从单文件改目录；加正向/负向探针。
- 测试：3 人完整局/2/4 人/视图裁剪/扣牌不出站/pdkRules/错误码。
- 提交：`feat(game-service): 跑得快 runtime/视图/错误映射`。

### Task 4.2 超时/托管/机器人接线

**Files**
- `packages/game-service/src/game/game.service.ts`（验证通用路径）
- `packages/game-service/test/{pdk-timeout,pdk-trustee,pdk-robot}.test.ts`

- 测试：pdk 超时首出/跟牌/无解；托管；bot 被拒回退；`driveOneRobotTurn` 走 runtime。
- 提交：`feat(game-service): 跑得快超时/托管/机器人`。

### Task 4.3 结算/记录 / ws 映射

**Files**
- `packages/game-service/src/games/pdk/{runtime,view}.ts`
- `packages/room-service/src/gateway/ws.gateway.ts`（`RecordEnvelope` 联合、`writeGameRecord`
  pdk 分支、`exactlySeats(0..playerCount-1)`）
- `packages/game-service/test/pdk-settle-record.test.ts`
- `packages/room-service/test/record-pdk.test.ts`

**做法**
- pdk 结算向量/记录信封/2 人扣牌/playedCount/无底牌；`record.write` 字段映射
  （gameType/playerCount/seats[].playedCount/unusedCards，省略 bottomCards）。
- 提交：`feat: 跑得快结算与记录链路`。

### Task 4.4 seed/testDeck + conformance 通道

**Files**
- `packages/game-service/src/game/game.service.ts`
- `packages/game-service/src/games/pdk/runtime.ts`
- `packages/room-service/src/rooms/rooms.start.ts`（测试钩子参数）
- `packages/game-service/test/pdk-test-hooks.test.ts`
- `tools/conformance/src/lib/game-driver.ts`（接口预留）

**做法**
- `INTERNAL_TEST_HOOKS=1` 时 seed/testDeck 生效；**关闭时忽略并 WARN**（不拒绝、不 10001）。
- **选定链路**：`startRoom` options 增 `{ seed?: number; testDeck?: Card[] }`（仅测试钩子），
  conformance driver 经 match/room 开局时由测试专用入口传入；**不选 RPC 直调**。
- 非法 testDeck（非 48 张/pdk 非法集/重复）⇒ `10001`。
- 测试：开启生效、关闭忽略+WARN、非法 10001。
- 提交：`feat: 跑得快确定性测试钩子`。

### Task 4.5 S4 门禁

- `pnpm -C packages/game-service test`、`packages/room-service test`、`packages/shared test`
- 提交：`test: S4 跑得快服务端`。

---

## S5 配置前置 + 客户端通用壳

> **S5 执行状态（2026-10-24）**：Task 5.0/5.1/5.2a/5.2b/5.2c/5.3/5.4 全部完成。
> 5.2c 真浏览器回归已在本机真栈执行：`--scenario gate` **22/22**（本地 Vite + 本地网关）。
> 提交：`74f6378d`（5.0 gateway query/出站）→ `d33a2358`（5.1 config 种子/games）→
> `dc4a6eea`（5.2a+5.2b shell/DdzBoard 合并提交）→ `0161d19d`（5.3 store/session）→
> `c4a28fd9`（5.4 大厅/匹配载荷）。
> 验证：api-gateway **478** / config-service **453** / client **1462**（仅两条既有已知无关失败：
> more-menu 返回箭头 PNG、card-hand-interaction isH5Runtime）；`verify:admin` 323 项；
> 客户端 build 绿。
>
> **实现期偏差登记**：
> 1. 5.2a/5.2b 合并为一个提交（shell 与 DdzBoard 一次迁移完成，无临时 `DdzTableInner` 阶段）。
> 2. `useTableSound`/`usePlayedCards`/重发横幅留在壳（读 store）——board 不读 store 的边界
>    以「board 只收 props」为准；音效是视图 diff 的通用职责。
> 3. pdk 非炸弹出牌**静音**（素材库无「通用出牌」音效；首版只播炸弹/过牌/输赢）——登记为素材缺口。**2026-10-25 语音复用 spec 已取代（牌型播报复用斗地主素材）。**
> 4. PdkBoard 不显示「实时倍数」（视图无该字段，只有 bombCount；倍数在结算载荷）——不本地计算。

### Task 5.0 api-gateway query/出站（前置，RH10）

**Files**
- `packages/api-gateway/src/gateway/gateway.controller.ts`（`GET /api/rooms` 转发 `gameType`；
  records query 白名单加 `gameType`）
- `packages/api-gateway/src/gateway/proxy.gateway.ts`（pdk 出站消息放行）
- `packages/api-gateway/test/{rooms-query,records-query,pdk-outbound}.test.ts`

**做法**
- `GET /api/rooms` 不再固定丢 query；`recordsQueryOf` 白名单加 `gameType`。
- pdk 视图/结算/finished/balances 放行；旧 ddz 消息不变；旧 gateway 负对照。
- 必须在 Task 5.4/6.3 之前完成，否则真栈房间列表/历史仍只走 ddz。
- 提交：`feat(api-gateway): 跑得快 query 与出站契约`。

### Task 5.1 config-service pdk 键/种子/客户端 games（从 S7 前移）

**Files**
- `packages/config-service/src/migrations/*MultiGameConfig*`
- `packages/config-service/src/config/{platform-config.service,client-config.controller}.ts`
- `packages/config-service/test/*`
- `packages/protocol/src/config.ts`（`CLIENT_CONFIG_KEYS` 加 `games`）
- **`packages/protocol/src/config.test.ts`**（19→20 键断言同步）

**做法**
- 种子 pdk 键（默认值见 spec §4.7.1）；`game.levels.paodekuai` 四档；`enabled=false`；
  `nonThreePlayerEnabled=false`。
- `/api/config` 输出 `games`；旧 `baseScoreLevels` 不变；`CLIENT_CONFIG_KEYS` 19→20。
- 测试：种子/解析/客户端子集/旧配置不变。
- 提交：`feat(config-service): 跑得快配置种子与客户端配置`。

### Task 5.2 shell/board 边界 + DdzBoard 迁移

**Files**
- 5.2a：`apps/client/src/pages/table/table.vue`（shell）、
  `apps/client/src/components/table/ddz/DdzTableInner.vue`（临时承载旧内容）、
  `apps/client/test/ddz-board-shell.test.ts`
- 5.2b：`apps/client/src/components/table/ddz/DdzBoard.vue`、
  `apps/client/test/table-*.test.ts`（11 个）、
  `apps/client/test/{settlement-reveal,settlement-rematch,swipe-select,card-counter-*,
  hint-*,audio,landscape-*}.test.ts`
- 5.2c：`scripts/browser-e2e.mjs`（斗地主回归）

**做法**
1. **5.2a shell 骨架**：`table.vue` 只留会话接线/LandscapeStage/NoticeStack/
   ConnectionOverlay/SettlementReveal/useCountdown/通用音效/返回重开；board 插槽；
   写 `ddz-board-shell.test.ts`（渲染 DdzBoard、props/emits）。
2. **5.2b DdzBoard 迁移**：把叫抢/底牌/记牌器/斗地主 hint/牌型播报/滑动选牌移入
   `DdzBoard.vue`；逐条迁移上述测试；`pnpm -C apps/client test` + lint 绿。
3. **5.2c 真浏览器斗地主回归**：大厅→匹配→叫抢→出牌→结算→再来一局。
- 提交：`refactor(client): 通用牌桌壳`、`refactor(client): DdzBoard 迁移`、
  `test(client): 斗地主回归`。
- **边界**：shell 持有会话/房间/通知/连接/结算揭示/倒计时；board 只收
  `view/mySeat/interactive` 并 emits `play/pass/bid/trustee/leave/rematch`；
  board 不直接读 store（避免隐性重写）。

### Task 5.3 store/net/useGameSession

**Files**
- `apps/client/src/stores/game.ts`
- `apps/client/src/net/{session,socket}.ts`
- **`apps/client/src/composables/useGameSession.ts`**
- `apps/client/test/{game-view,pdk-view,room-matched-join}.test.ts`
- `apps/client/test/{auth-ui-wiring,lobby-ux}.test.ts`（精确 payload 断言改 `toMatchObject`）

**做法**
- store `view: GameView | null`；`resolveGameType`；`activeMode`/`playerCount`；
  ddz getters 仅 ddz；pdk getters；`game.finished` 联合。
- `room.matched` 写 activeMode/playerCount；自动 join 发送 gameType；旧 payload 回落 activeMode。
- 测试：旧 ddz 无 gameType；pdk；自动 join；既有精确 payload 更新。
- 提交：`feat(client): 玩法感知的会话与 store`。

### Task 5.4 大厅/开始游戏页

**Files**
- `apps/client/src/gameModes.ts`
- `apps/client/src/pages/lobby/lobby.vue`
- `apps/client/src/pages/game/game.vue`
- `apps/client/src/net/rest.ts`（`rooms(gameType)`/`joinRoom(code, gameType)`/`mine(gameType)`）
- **`apps/client/src/pages.json`**（标题中性）
- `apps/client/test/{lobby-modes,match-payload,room-list-pdk,base-score-selection}.test.ts`

**做法**
- `GAME_MODES` 两玩法，按 `clientConfig.games[id].enabled` 过滤；按玩法档位。
- `room.match` 带 gameType/playerCount；`rooms(gameType)`；`joinRoom(code, gameType)`。
- `pages.json` 标题中性。
- 提交：`feat(client): 大厅玩法选择与匹配载荷`。

### Task 5.5 S5 门禁

- `pnpm -C apps/client test` + lint
- 真浏览器斗地主回归
- 提交：`test(client): S5 斗地主牌桌回归`。

---

## S6 跑得快客户端

> **S6 执行状态（2026-10-24）**：Task 6.1/6.2/6.3/6.4 代码完成。
> 提交：`50ec9a7e`（6.1–6.3 PdkBoard/hint/音效/结算/历史）→ `f23e6bda`（6.4 browser-e2e 场景）。
> 验证：客户端 pdk-board **6** / pdk-hint **4** / pdk-sound **1** / pdk-settlement **3** /
> history-pdk **3**；全量 client **1462** 通过（同上两条已知无关失败）。
> 6.4 真浏览器 pdk 场景已在本机真栈执行：`--scenario pdk` **13/13**（大厅切玩法→匹配→出牌/过牌→结算→返回大厅）。
>
> **实现期偏差登记**：
> 1. pdk hint 组合枚举在客户端 `game/pdk-hint.ts`：只做组合枚举/排序，牌型与比较全部调用
>    `protocol.parsePdkHand`/`canBeatPdk`，规则快照取 `view.pdkRules`。
> 2. 历史页默认「斗地主」页签（旧行为零破坏）；切「跑得快」才请求
>    `/api/records/mine?gameType=paodekuai`。
> 3. 2/4 人：壳在收到 `playerCount !== 3` 的 pdk 视图时提示并复位回大厅（首版客户端只做 3 人）。

### Task 6.1 PdkBoard

**Files**
- 新增 `apps/client/src/components/table/pdk/PdkBoard.vue`
- `apps/client/src/pages/table/table.vue`（按 gameType 渲染）
- `apps/client/test/pdk-board.test.ts`

**做法**
- 3 人座位；无叫抢/底牌/地主徽标/记牌器；显示剩余/倍数；动作栏出牌/不出/提示；
  结算名次/剩余/倍数/关牌/春天/保本/金币。
- `playerCount !== 3` ⇒ 提示“当前客户端暂不支持该人数”并回大厅（首版只做 3 人）。
- 提交：`feat(client): 跑得快牌桌`。

### Task 6.2 hint/音效/结算适配

**Files**
- `apps/client/src/game/hint.ts`（pdk 分支，用 `view.pdkRules`）
- `apps/client/src/audio/*`（pdk 音效策略）
- `apps/client/src/components/Settlement.vue`（壳/变体）
- `apps/client/test/{pdk-hint,pdk-sound,pdk-settlement}.test.ts`

**做法**
- hint 窗口内无有效出牌时隐藏/降级；关闭牌型不提示；跑得快只播出牌/过牌/输赢。**（2026-10-25 语音复用 spec 已取代：牌型播报复用斗地主素材。）**
- 提交：`feat(client): 跑得快提示/音效/结算`。

### Task 6.3 历史页

**Files**
- `apps/client/src/pages/history/history.vue`
- `apps/client/src/net/rest.ts`（MyRecord/PdkRecord）
- `apps/client/test/history-pdk.test.ts`

**做法**
- 列表按 gameType；pdk 详情剩余/倍数/炸弹/关牌/春天/保本；旧 ddz 不变。
- 提交：`feat(client): 跑得快历史战绩`。

### Task 6.4 真浏览器 pdk 场景（随 S6）

**Files**
- `scripts/browser-e2e.mjs`（pdk 场景）

**做法**
- **前置**：测试环境把 `game.paodekuai.enabled=true`（经 config-service 管理 PUT 或
  测试种子夹具），否则 `games.paodekuai.enabled=false` 时 pdk 卡不渲染；在场景脚本里
  先断言 pdk 卡可见。
- 大厅切玩法→匹配→出牌/过牌→结算→重进；依赖 Task 5.1 的 `games` 输出。
- 提交：`test(client): S6 跑得快端到端`。

---

## S7 后台/记录/conformance/网关/验证

> **S7 执行状态（2026-10-24，进行中）**：
> 提交：`03ccce84`（7.1 admin IA）→ `16ed7b15`（7.2 user-service 查询/清理）→
> `4ac61333`（7.3 conformance slice-29/键集/池键）→ `bdf7df6d`（7.4 旧 gateway 负对照）；
> 7.5 全量门禁与真栈验证见下。
>
> **包级门禁（权威轮）**：`turbo run lint build --force` **30/30（0 cached）**；
> `turbo run test --force`（除 client）**27/27（0 cached）**。各包：protocol **282** /
> shared **392**（覆盖率 **97.34%**）/ game-service **262** / room-service **877** /
> user-service **339** / robot-service **142** / config-service **453** / api-gateway **478** /
> currency-service **386** / payment-service **456** / alert-relay **124** / test-utils **7**。
> client：**1462 通过 / 2 已知无关失败**（more-menu 返回箭头 PNG、card-hand-interaction
> isH5Runtime；均非本任务产物）。`verify:admin` **323 checks**。
>
> **真栈验证（2026-10-24，本机 9+ 容器 + 本地 Vite）**：
> conformance `slice-29-paodekuai` **55 断言 / 12.0s**（匹配/16 张/规则快照/无泄漏/房间过滤/
> 出牌过牌到终局/winnerSeats/零和结算/pdk 记录/旧查询不含 pdk）；
> ddz 回归 `slice-05` 68 · `slice-06` 73 · `slice-07` 39 · `slice-12` 90 · `slice-10` 187；
> 键集/池：`slice-14` 78 · `slice-15` 211 · `slice-17` 185 · `slice-18` 150 · `slice-21` 340 ·
> `slice-23` 380 · `slice-24` 224 · `slice-11` 64 · `slice-07.2-rpc` 69。
> 真浏览器：ddz `--scenario gate` **22/22**；pdk `--scenario pdk` **13/13**。
> 回滚演练与 runbook：`docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`
> （边界、机器人池迁移、pdk 数据保留；本机验证「旧查询不读 pdk 表」「旧键不受影响」）。
>
> **实现期偏差登记**：
> 1. `slice-29` 的确定性：不依赖 `testDeck`（跨进程不可达），改用**独立 oracle 的单张策略**
>    （不 import 服务端跑得快规则）驱动随机发牌到终局；`seed/testDeck` 钩子由
>    `pdk-test-hooks` 单测覆盖。
> 2. 旧 gateway 负对照用 S0 冻结的旧校验器在 protocol 侧机械证明（真栈正向由 slice-29 走真网关）；
>    「旧 gateway 镜像 + 新 pdk 消息」不在本机可构造。
> 3. 真栈镜像需按已知配方在 10 个 Dockerfile 临时 `COPY .npmrc ./` 后构建（不提交），
>    构建完成即还原。
> 4. 本机宿主 3105 被其它进程占用 ⇒ `slice-07.2-rpc`/`slice-11` 临时把 compose 映射改为
>    `13105:3105` 并以 `ROBOT_SERVICE_RPC_PORT=13105` 运行，跑完还原（compose 无残留改动）。
> 5. 真栈修正（验证期发现并已修）：`pdk-driver` 从**行动者自己的视图**取手牌 + 复用
>    `sendThrottled` + 等结算帧；`records.service` BIGINT `ended_at` 用 `Number()`（不得走
>    `new Date(数字串)`）；PdkBoard 跟牌目标跳过「过牌」条目；浏览器 pdk 场景按
>    `.lobby__mode-name` 选玩法、补点「开始游戏」。

### Task 7.1 admin IA

**Files**
- `admin/app.js`、`admin/index.html`
- `scripts/verify-admin-static.mjs`
- `admin/test/*` 或静态校验

**做法**
- 玩法域：斗地主（继续 `game.baseScoreLevels`）/跑得快（档位/规则/计分/开关）。
- 键清单/IA 断言更新；不迁移 ddz 键。
- 提交：`feat(admin): 跑得快配置域`。

### Task 7.2 user-service pdk 查询/清理/历史 API

**Files**
- `packages/user-service/src/records/{records.service,records.controller,records-cleanup.service}.ts`
- `packages/user-service/test/{records-pdk-query,records-cleanup-pdk}.test.ts`

**做法**
- `GET /api/records/mine?gameType=`：缺省 ddz；pdk 详情；旧客户端只读斗地主表。
- `RecordsCleanupService` 按 `ended_at` 清理 pdk 两表；`records_table_bytes` 含 pdk。
- 测试：pdk 查询/旧客户端默认/cleanup/幂等；写入由 Task 4.0 已覆盖。
- 提交：`feat(user-service): 跑得快战绩查询与保留期清理`。

### Task 7.3 conformance

**Files**
- `tools/conformance/src/lib/{game-driver,ddz-driver,pdk-driver}.ts`
- `tools/conformance/src/slices/29-paodekuai.ts`
- `tools/conformance/src/slices/{10,14,15,18,19,23,24}-*`
- **`slice-07.2-rpc.ts`、`slice-11-robot-system.ts`、`slice-18-gold-room.ts`（bot pool 键）**
- `tools/conformance/baselines.json`

**做法**
- 抽象 driver；pdk driver 用 seed/testDeck + 独立 oracle。
- slice 29：匹配/建房/开局/首出/过牌/结束/结算/记录。
- ddz slice-10/18 9 键不变；配置/记录键集更新；07.2/11/18 的 `bot:pool:ddz` 改新池/双读断言。
- 提交：`test(conformance): 跑得快 slice 与键集同步`。

### Task 7.4 api-gateway 真栈负对照

**Files**
- `packages/api-gateway/test/*`（真栈/夹具）
- `tools/conformance/src/slices/29-paodekuai.ts`（走真网关的 query/出站断言）

**做法**
- Task 5.0 已实现 query/出站；本任务补真栈/旧 gateway 负对照：
  旧 gateway + pdk 消息被拦、新 gateway + 旧 ddz 放行、rooms/records query 真栈生效。
- 提交：`test(api-gateway): 跑得快真栈兼容`。

### Task 7.5 全量验证 / 回滚演练 / 文档

拆三个 commit：
1. **全量门禁**：`pnpm exec turbo run lint build test --force`、`pnpm verify:admin`、
   `pnpm -C apps/client test` + lint、`node scripts/browser-e2e.mjs`、conformance 全量。
2. **回滚演练**：
   - S0/S1 直接回滚；
   - S2：停新匹配 → 排空 → 把 `bot:pool:doudizhu` 空闲机器人**迁回 `bot:pool:ddz`** →
     回滚 room/robot；
   - pdk：关开关 → 排空 → 清 pdk 队列/池 → 保留 pdk 记录表 → 回滚镜像；
   - 验证旧 user-service 读 pdk 表不报错、旧 room-service 不受 pdk 键影响、旧 client 只看到 ddz。
3. **文档**：`docs/games/paodekuai.md` 定稿、`docs/client-protocol.md`、`docs/design.md` §11.2、
   `docs/appendix/platform-roadmap.md` §2.2、`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P4′。

---

## 计划审查必查项（第二轮计划复审）

1. S0.5 是否真的把全部消费者列齐，`turbo lint build test --force` 是否绿；
2. 每个新增模块的 `index.ts` 是否在 Files；
3. `shared/ddz/types.ts` 是否改、GameService 存储类型是否统一；
4. S1 替换清单是否含 `driveOneRobotTurn/ruleDecision/applyDecisionToSession/backfillSuits/
   getView/actAndView/publishEnded/buildRecordEnvelope`；
5. `startRoom` 兼容包装/64 处断言；
6. Task 2.3 六个匹配函数是否逐项参数化；
7. Task 2.2 POST 建房/12012/ConfigCache/JoinRoomDto 位置；
8. Task 5.1 配置前移、Task 6.4 browser-e2e 随 S6；
9. Task 7.3 bot pool 键、Task 7.4 gateway.controller query；
10. pdk bot 实现（3.6）与 rules 默认值（0.3）、rule-error mapping（4.1）；
11. 假绿：fixture 自证、mock-only、选择器过宽、rule-error 扫描面；
12. protocol 测试放 `src/*.test.ts`、文档对账测试文件。

---

## 计划审查记录（第一轮，2026-10-23）

> 独立 reviewer 结论：**不可执行**；B1–B10 必须先修。v2 处置如下。

| # | 缺陷 | v2 处置 |
|---|---|---|
| B1 | S0 联合类型打断 5 个包 | S0 拆 0A 纯新增 / 0B 全消费者收口（Task 0.5）+ turbo 门禁 |
| B2 | barrel 导出缺失 | 每个新增模块任务 Files 加 `index.ts` |
| B3 | GameSessionBase 未落 ddz/GameService | Task 1.1 加 `ddz/types.ts`；Task 1.4 统一存储类型 |
| B4 | S1 替换清单漏分支 | Task 1.4 逐项扩到 `driveOneRobotTurn/ruleDecision/applyDecisionToSession/backfillSuits/getView/actAndView/publishEnded/buildRecordEnvelope` |
| B5 | startRoom 三态破坏 64 处断言 | 保留 boolean 包装 + 新增 `startRoomOutcome`；Task 2.4 Files 加既有测试 |
| B6 | pdk bot 空桩无回填 | 新增 Task 3.6 实现；Task 2.6 只做框架 |
| B7 | gateway controller 不转发 query | Task 7.4 加 `gateway.controller.ts` |
| B8 | S6 反向依赖 S7 | Task 5.1 配置前移；Task 6.4 browser-e2e 随 S6 |
| B9 | pdk rule-error mapping 缺失 | Task 4.1 增文件/扫描面/探针 |
| B10 | shared pdk rules 默认值缺失 | Task 0.3 建 `shared/src/pdk/rules.ts` |
| H1 | 0.3 依赖 0.5 | 0.3 先建 PdkRulesConfig |
| H2 | HEAD 固定随机源不可行 | 0.1 用手工 session + `vi.spyOn(Math,'random')` |
| H3 | `rules` 不在 FORBIDDEN | 0.4 新增 `rules` 等并加正向断言 |
| H4 | dto 重复类型 | Task 1.4 删除 dto 重复定义 |
| H5 | registry 注册顺序 | Task 1.2 先 fake；1.3 末尾注册 |
| H6 | 2/4 匹配漏函数 | Task 2.3 逐项六函数 |
| H7 | POST /api/rooms 无任务 | Task 2.2 覆盖 CreateRoomDto/enabled/12012 |
| H8 | ConfigCache 无任务 | Task 2.2 加文件/测试 |
| H9 | http/errors 12012 | Task 2.2 |
| H10 | JoinRoomDto 放 protocol 问题 | 放 room-service `rooms.dto.ts`（class-validator） |
| H11 | useGameSession 未列 | Task 5.3 |
| H12 | trustees 截 3 元组 | Task 0.5/2.2 参数化 |
| H13 | record.write pdk 映射 | Task 4.3 |
| H14 | conformance bot pool 键 | Task 7.3 |
| H15 | 回滚池方向写反 | Task 7.5 改为迁回 `bot:pool:ddz` |
| H16 | 精确 payload 测试 | Task 5.3 更新 auth-ui-wiring/lobby-ux/room-matched-join |
| H17 | RobotFeatures 文件归属 | Task 2.6 加 protocol/robot.ts + shared/ddz/features.ts |
| H18 | PdkRobotFeatures 缺 wingMode | Task 2.6 加 `wingMode?` |
| H19 | conformance seed 通道 | Task 4.4 明确 startRoom options/RPC 路径 |
| H20 | balances/moneyDelta 3 座校验 | Task 2.5 加 validate.ts/rpc.ts |
| H21 | DI 测试 | Task 1.4 加 di-metadata/wiring |
| H22 | claim/onSeats 清理 | Task 2.1/2.4 明确去 gold-only + 失败清理 |
| 低 1 | protocol 测试路径 | 全部改 `src/*.test.ts` |
| 低 2 | 文档测试 | Task 3.2 加 doc-sync.test.ts |
| 低 3 | createPdkSession input | Task 3.1 定义 `PdkSessionInput` |
| 低 4 | 5.1/7.5 过大 | 拆 5.2a/b/c、7.5 三个 commit |
| 低 5 | start_attempts 测试 | Task 2.2/2.4 |
| 低 6 | 两个 outbox entry | Task 2.5 |
| 低 7 | hint 窗口 | Task 6.2 |
| 低 8 | game:events 信封 | Task 1.4/4.1 |
| 低 9 | CLIENT_CONFIG_KEYS games | Task 5.1 |
| 低 10 | PdkBoard 2/4 fallback | Task 6.1 |
| 低 11 | S0 全仓门禁 | Task 0.6 turbo |
| 低 12 | legacy 副本 import 守卫 | Task 0.1 gate test |

---

## 计划审查记录（第二轮，2026-10-23）

> 同一 reviewer 复审 v2：B1–B10 大部分闭合；残余 RB1/RB2 + RH1–RH13 + N1–N9。
> v2.1 处置如下。

| # | 缺陷 | v2.1 处置 |
|---|---|---|
| RB1 | Task 0.5 漏 `Settlement.vue`/`ddz/types.test.ts`；Task 1.4 漏 `game.controller.ts` | Task 0.5/1.4 Files 已补 |
| RB2 | pdk 配置键契约未在 S0；S2 依赖 S5 | Task 0.3 增加 `protocol/config.ts` + 14 键 + `parseConfigValue`；Task 5.1 只做种子/games |
| RH1 | `handleMatch` 未做 enabled/nonThree/档位 | Task 2.2 明确 WS match + `assertKnownBaseScore(gameType)` |
| RH2 | `config-cache.test.ts` 未列 | Task 2.2 Files 已加；新参数缺省 ddz |
| RH3 | 12012 只看 code 会漏 500 | Task 2.2 测试加 HTTP status 断言 |
| RH4 | `viewWithTrusteeCleared` 仍截 3 元组 | Task 2.2 改为 map/playerCount + 2/4 reconnect 测试 |
| RH5 | conformance seed 通道未选定 | Task 4.4 选定 `startRoom` options，不选 RPC 直调 |
| RH6 | `onSeats` 失败分支未写 | Task 2.4 补 WARN + 下一轮 cancelQueue + 测试 |
| RH7 | `startRoomOutcome` 无法表达 ddz N36 | Task 2.4 加 `'legacy-failed'`，包装层保持旧 false |
| RH8 | `loadSession` 旧会话未默认化 | Task 1.4 补 ddz/3 默认、pdk 缺 gameType fail closed + 旧 Redis 测试 |
| RH9 | user-service pdk 写入在 S7，S4/S6 会拒 | 新增 Task 4.0 前置；Task 7.2 只留查询/cleanup |
| RH10 | gateway query 在 S7，S5/S6 已用 | 新增 Task 5.0 前置；Task 7.4 只留真栈负对照 |
| RH11 | `protocol/config.test.ts` 19 键未列 | Task 5.1 Files 已加 |
| RH12 | FORBIDDEN 处置不在 0.4 Files | Task 0.4 Files 已加 `validate.ts` + 正向断言 |
| RH13 | robot 既有测试未列 | Task 2.6 Files 已加 3 个既有测试 |
| N1 | pdk 类型所有权不清 | Task 0.4 定死 `protocol/src/pdk/types.ts` 唯一归属；其余 re-export |
| N2 | Task 5.2 无 Files | 5.2a/b/c 已列明确 Files/测试/命令 |
| N3 | `pages.json` 未列 | Task 5.4 Files 已加 |
| N4 | testDeck 关闭时忽略/拒绝未定 | Task 4.4 定为**忽略 + WARN** |
| N5 | 7.5 缺 build | 改为 `turbo run lint build test --force` |
| N6 | Task 0.4 缺 index.ts | Files 已加 |
| N7 | ddz RecordEnvelope 形状不明 | Task 1.4 明确加可选 `gameType?/playerCount?` |
| N8 | S6 pdk 开关未打开 | Task 6.4 加启用步骤/断言 |
| N9 | claim random/practice 测试未明确 | Task 2.1 明确去 gold-only + random/practice 测试 |

### 执行前提

- 先按 Task 0.1 冻结 golden/旧校验器，再动任何协议类型。
- S0.5 是唯一跨多包大 commit；必须 `turbo run lint build test --force` 绿后再继续。
- S2 前必须完成 Task 0.3 的 14 个配置键；S4 前必须完成 Task 4.0；S5/S6 前必须完成
  Task 5.0/Task 5.1。
- 每个任务完成后按 Global Constraint 10 提交；不通过门禁不进入下一任务。
