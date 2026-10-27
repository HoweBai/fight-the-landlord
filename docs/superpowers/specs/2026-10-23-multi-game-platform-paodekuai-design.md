# 多玩法平台化与跑得快接入 · 设计 v1.3

> **定位**：把当前「单一斗地主」服务端与客户端改造成可插拔的多玩法平台，并以「跑得快」作为第二个玩法验证整套接缝。
> **状态**：设计草案（已完成三轮独立对抗审查修订），待用户复核后进入实现计划。
> **修订**：v1.1 按第一轮 B1–B5/H1–H25/低 1–15；v1.2 按第二轮 RB1–RB2/RH1–RH6/N1–N6；
> v1.3 按第三轮 PB1/RH3-a–e/RH4-a/RH5-a/N1-a–b/RH1-a–b/N3-a/RH6-a；处置见 §10。
> **接触面**：`packages/protocol` · `packages/shared` · `packages/game-service` · `packages/room-service` · `packages/api-gateway` · `packages/robot-service` · `packages/user-service` · `packages/config-service` · `admin/` · `apps/client` · `tools/conformance` · 文档。
> **规则唯一来源**：实现时新建 `docs/games/paodekuai.md`（玩家可读的完整规则）；本 spec §5 是规则设计的裁决记录，二者冲突以规则文档为准，并由测试同步。

---

## §0 用户裁决（本设计不得与之冲突）

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 目标 = **平台化 + 跑得快**，增量交付；不做一次性大重写 | A′ 插件内核，斗地主行为零变化 |
| K2 | 服务端内核采用 **A′：玩法无关内核 + 每玩法 runtime 插件** | `GameRuntime` + `GameRegistry` |
| K3 | **向后兼容**：新字段在过渡期必须**类型可选**，缺省 `doudizhu`；旧客户端继续玩斗地主；只有 `undefined`/字段缺失算缺省，空串/非法值报错 | 所有协议/配置/房间/记录缺省斗地主；S0 可独立提交 |
| K4 | **免费场 + 金币场同时上** | 结算、入场费、抽水、余额广播全部按通用形状接入 |
| K5 | 跑得快用 **规则机器人**，不接 DouZero | robot-service 增加 pdk 规则 bot |
| K6 | 客户端用 **通用牌桌壳 + 玩法牌桌组合** | `table.vue` 拆壳；`DdzBoard` / `PdkBoard` |
| K7 | 用牌：去掉大小王、黑桃 2、梅花 2、方块 2、黑桃 A，**保留红桃 2**，共 48 张 | 花色 0♠ 1♥ 2♣ 3♦；红桃花色完整 |
| K8 | 人数：**2 / 3 / 4**；3 人各 16 张；4 人各 12 张；2 人分成 3 份×16 张，两家各拿一份，第三份扣下 | 引擎首版支持 2/3/4；客户端首版只做 3 人 |
| K9 | 首出：每局第一手从红桃 3→4→…→A→2 找第一张在玩家手中的红桃，持有者先出；**可出任意合法牌型**；2 人局若所有红桃都被扣，系统随机指定 | 先出牌规则见 §5.3 |
| K10 | **可以过牌**；其余玩家都过后，最后出牌者重新首出 | 首出时不可过牌 |
| K11 | **AAA 不当炸弹**；炸弹仅四张同点；最大炸弹 KKKK | 最大三张仍是 AAA；最大四带二是 KKKK+2 |
| K12 | **保本**：剩 1 张但未赢的输家付 0（可配置） | 结算边界 |
| K13 | 计分：**每个翻倍项独立开关**；默认炸弹/关牌/春天全开、封顶 64、保本开 | 配置键见 §4.7/§5.6 |
| K14 | 带牌规则可配置；默认：裸三张开、三带二关、裸飞机关、四带二开、四带二带牌成对关、飞机翅膀只带对 | 配置键见 §4.7/§5.4 |
| K15 | 牌面素材**直接复用斗地主** | 不新增牌面资产；只新增玩法图标/文案可选 |
| K16 | 2/4 人先到**引擎/接口层**；客户端首版只开 3 人 | 协议/房间/结算按 N 人泛化 |
| K17 | 先出牌规则必须有**玩家可读的文字描述** | `docs/games/paodekuai.md` 必须写清楚 |
| K18 | 规则文档是唯一规则来源 | 实现时创建 `docs/games/paodekuai.md`，测试与 spec 同步 |

---

## §1 背景与问题

### 1.1 现状（代码事实）

当前平台在运行时**没有任何 `gameType` 概念**：

- `room.match` 载荷只有 `{ mode, baseScore, deviceId? }`；匹配队列键是
  `match:queue:{mode}:{baseScore}:{region}`（`packages/room-service/src/match/match.service.ts`）。
- `RoomMeta` 只有 `{ code, mode, baseScore, maxPlayers: 3, status, createdAt, timeoutAt }`；
  `maxPlayers` 是字面量 `3`（`packages/room-service/src/rooms/rooms.service.ts`）。
- `game.start` 载荷没有玩法；`game-service` 的 `GameSession` 是斗地主专用结构
  （`bidPhase` / `playPhase` / `bottomCards` / `isLandlord`），直接 import `shared/ddz/*`
  （`packages/game-service/src/game/game.service.ts`）。
- `PlayerView` / `SettlementResult` / `RobotFeatures` / 17+3 定长记录编码都是地主语义
  （`packages/protocol/src/views.ts`、`robot.ts`、`records.ts`）。
- 机器人池键 `bot:pool:ddz`（`packages/robot-service/src/robot/robot.pool.ts`）。
- WS 命名空间 `/ws/ddz`（room-service / api-gateway / client）。
- 客户端 `GAME_MODES` 只有 `doudizhu`，且 `activeMode` 从不发给服务端
  （`apps/client/src/gameModes.ts`）。
- 管理后台配置 IA 只有「斗地主」一个玩法域（`admin/app.js`）。

### 1.2 为什么现在做

- `docs/appendix/platform-roadmap.md` §2.2 明确：路径 A（泛化 `GameSession`）与路径 B
  （按 `gameType` 分表）应在**第二个玩法开工前**决定。
- `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P4′ 把「gameType 横切」排在最前，
  并指出：队列键无 gameType、协议 9+9 条全地主语义、game-service 会话 DDZ 专用。
- 这次就是那个决策点；跑得快是第二个玩法。

### 1.3 目标

1. `gameType` 与 `playerCount` 贯穿协议、匹配、房间、会话、结算、记录、机器人、配置、客户端。
2. 斗地主行为**零变化**；旧客户端**零破坏**。
3. 跑得快完整上线：免费场 + 金币场、3 人（引擎支持 2/4）、规则机器人、结算、战绩。
4. 平台内核只承诺「固定座位、单局、回合制」玩法；麻将/德州扑克的边界写清楚，不假装万能。

---

## §2 范围

### 2.1 本片做

1. **协议与目录**：`GameType`、`GameMeta`、`playerCount`、按玩法判别的视图/结算/记录/机器人类型、旧客户端兼容缺省。
2. **服务端内核**：`GameRuntime` + `GameRegistry`；斗地主 runtime 适配现有 `shared/ddz/*`；
   game-service 的写队列/CAS/定时器/事件/机器人驱动保持通用。
3. **房间/匹配**：`gameType` + `playerCount` 进入队列键、票、房间元数据、开局链；旧键双读。
4. **配置**：按玩法档位、跑得快规则/计分键、开关、管理后台 IA、客户端配置子集。
5. **机器人**：按玩法池、规范 id、跑得快规则 bot、旧 `ddz` 池双读迁移。
6. **记录**：`game_type` / `player_count` 列、变长手牌 codec、跑得快结算/记录、历史页最小展示。
7. **跑得快**：48 张牌、2/3/4 人发牌、先出牌、全部牌型、结算、超时/托管、规则 bot。
8. **客户端**：玩法目录、大厅选择、匹配载荷、通用牌桌壳 + `DdzBoard` / `PdkBoard`、结算/历史适配。
9. **测试/门禁**：单元、契约、服务、客户端、conformance、配置键计数、admin 静态校验、golden 斗地主回归。

### 2.2 明确不做

- 麻将、德州扑克、其他玩法（只把边界与接缝写清楚）。
- 多盘制/多手牌（麻将）与多座位同时决策（碰/杠/胡抢牌）。
- 德州扑克的变座位、长桌、盲注/筹码/边池、每手结算。
- 跑得快的客户端 2/4 人牌桌（引擎/接口支持，客户端首版 3 人）。
- 跑得快记牌器、排行榜/ELO、观战/回放。（**牌型语音播报已于 2026-10-25 复用斗地主素材接入**，见 `2026-10-25-pdk-voice-announcements-design.md`。）
- 跑得快机器人接 DouZero 或专用 AI 模型。
- 改变斗地主的任何规则、视图形状（除新增字段）或结算结果。
- 重命名 WS 命名空间 `/ws/ddz`。
- 把 `game-service` 改造成每玩法独立服务。

### 2.3 交付切片（每个切片独立可测、可提交）

| 切片 | 内容 | 验收 |
|---|---|---|
| S0 | 协议/目录/兼容缺省/错误码/配置键骨架；冻结旧校验器与斗地主 golden 夹具 | 协议测试、旧客户端双向兼容测试、golden 夹具入库 |
| S1 | 内核 `GameRuntime`/`Registry` + 斗地主 runtime 适配 | 斗地主现有测试全绿 + golden 逐字回归 + 判别力自证 |
| S2 | 房间/匹配/机器人 `gameType`+`playerCount` 横切；旧队列键实际 key 透传 | room/robot 测试；斗地主端到端；旧键票开局/12007 |
| S3 | 跑得快纯规则（牌堆/牌型/回合/结算/autoplay）；依赖 S0/S1 的 `core/session` 基类 | shared 单测 + 真值表 + 固定牌堆用例 |
| S4 | 跑得快 game-service runtime + 视图/结算/记录/超时/机器人 | game-service 测试 + pdk conformance |
| S5 | 客户端通用牌桌壳 + `DdzBoard` 迁移 | 全部 table 相关测试 + 真浏览器斗地主回归 |
| S6 | 客户端 `PdkBoard` + 大厅/匹配/结算/历史 | 客户端测试 + 真浏览器 pdk 场景 |
| S7 | 管理后台、api-gateway、conformance 恰键集、回滚演练、全量验证、文档 | 全仓验证 + 回滚 runbook 演练 |

---

## §3 决策表

### 3.1 平台

| # | 决策 | 理由 |
|---|---|---|
| D1 | 规范玩法 id = `'doudizhu'` / `'paodekuai'`；`'ddz'` 只作为机器人池旧键别名 | 客户端已用 `doudizhu`；避免第三套 id |
| D2 | `GameMeta` 静态目录放 `protocol/src/game.ts`；`GameRuntime` 放 `game-service/src/games/` | 客户端/服务端共用元数据；runtime 依赖 Nest/协议，不塞进 shared |
| D3 | 会话键仍为 `game:session:{roomCode}`，只加 `gameType`/`playerCount`/`rules` 字段 | roomCode 全局唯一；改键形状会在部署窗口丢局 |
| D4 | 座位向量从 3 元组改为变长数组，按玩法/人数校验 | 跑得快 2/3/4 人；麻将 4 人；德扑 2–9 人都需要 |
| D5 | **斗地主继续使用旧 3 段键** `match:queue:{mode}:{baseScore}:{region}`（零迁移、零回滚风险）；跑得快使用 5 段键 `match:queue:{mode}:paodekuai:{playerCount}:{baseScore}:{region}`；解析器支持两种并带 `legacy` 标记 | K3 零破坏；S2 不改 ddz 键形状 |
| D6 | `playerCount` 进入 `room.match` / `MatchTicket` / `RoomMeta.maxPlayers`；`maxPlayers` 从字面量 3 改为 number | 匹配分组与房间容量按玩法人数 |
| D7 | 跑得快结算用通用 `scoreChanges/winnerSeats` 向量；**斗地主保持旧 9 键地主结算不变**，`SettleService` 按玩法分支（ddz 旧公式、pdk 新向量） | 旧客户端/slice-10 零变化；不强迫 ddz 发新字段 |
| D8 | **斗地主档位继续以 `game.baseScoreLevels` 为唯一真源**（不迁移、不双写）；跑得快新增 `game.levels.paodekuai`。`ConfigCacheService.baseScoreLevels(gameType)` 对斗地主读旧键、对跑得快读新键 | 旧 admin 仍写旧键，过渡期不会出现“运营改档位静默无效”；平台化让位于零破坏 |
| D9 | 新增错误码 `12012 GAME_UNAVAILABLE`（玩法未开放/人数不支持/客户端与房间玩法不符）；由 **room-service** 的 `DomainError` 产出（protocol 校验器只抛 `10001`），并补 `packages/room-service/src/http/errors.ts` 的 500→4xx 映射 | 不静默、不复用场次开关码；协议层拿不到配置/玩法支持判定 |
| D10 | 机器人池键 `bot:pool:{gameType}`；`doudizhu` 读旧 `bot:pool:ddz` 并迁移；`BotInstance` 持久化 `gameType`，release 从 bot 记录推导而非信任调用方 | 旧池在部署窗口仍有机器人；避免房键过期时 pdk 机器人误入 ddz 池 |
| D11 | **跑得快记录单独建表**（`game_records_pdk` / `game_record_players_pdk`），不复用斗地主表；旧 user-service 永远不会读到 pdk 行 | 斗地主表有 `winner/landlord_seat/bottom_cards NOT NULL`，混表会打挂旧历史页/回滚 |
| D12 | 客户端 `table.vue` 变通用壳；斗地主内容迁 `DdzBoard`，跑得快新建 `PdkBoard` | 避免单体页继续膨胀 |
| D13 | `game.paodekuai.enabled` 种子 `false`，暗上线；跑得快房间在开关关闭后不再新建，已在局中的跑完；等待中房间允许开完（明确登记） | 可随时止血；避免把等待中的玩家踢掉 |
| D14 | **保留** WS 命名空间 `/ws/ddz` | 改名平台收益为零，旧客户端风险非零 |
| D15 | **不新增客户端消息类型**：跑得快复用 `game.play` / `game.pass`；`game.bid` 仅斗地主 | 消息清单计数门禁不变；CAS 语义不变 |
| D16 | 旧客户端只能进斗地主房：`GET /api/rooms` 缺省过滤 doudizhu；**REST `POST /api/rooms/:code/join` 与 WS `room.join` 都校验 gameType**（缺省 doudizhu）；`room.matched`/`room.state_update` 带 gameType/playerCount | 防止旧客户端占跑得快座或收到 `PdkPlayerView` 崩溃 |
| D17 | 跑得快不扣记牌器权益：开局链按 `GameMeta.capabilities.cardCounter` 跳过 | 记牌器是斗地主专属付费能力 |
| D18 | 斗地主 golden 回归：**先在 dev/master HEAD 冻结** `PlayerView` / `SettlementResult` JSON 夹具；重构后剥掉约定新增字段逐字比较，并加“改坏一个旧字段能红”的判别力自证 | 防止快照自证；平台化不得改变斗地主行为 |
| D19 | `game.start` 携带 `rules` 快照；局中改配置不影响进行中的牌局 | 结算公平与可审计 |
| D20 | 2/4 人在引擎/协议/房间/结算/记录层**参数化并测试**；生产暴露由 `game.paodekuai.nonThreePlayerEnabled`（默认 `false`）闸住；客户端首版只发 3 人 | 满足“接口支持 2/4”且不在首版引入未验证的匹配面 |
| D21 | 麻将/德州扑克边界写进 §4.12；不为它们实现多窗口/多手牌 | 避免为不存在的需求过度抽象 |
| D22 | 管理后台 IA 按玩法分域（斗地主/跑得快），配置键归属明确 | 运营可独立调玩法 |
| D23 | 旧客户端兼容测试使用**冻结的旧版校验器/消息夹具**，不拿新校验器自证；同时测“旧客户端×新服务”“新客户端×旧服务”两个方向 | 防止兼容测试假绿 |
| D24 | conformance 的 pdk 新键集/配置键计数逐条更新；**斗地主 slice-10/18 的 9 键断言保持不变**（D7 不新增 ddz 字段） | 新玩法新形状，旧玩法旧形状 |
| D25 | `game.start` 幂等早退**先校验 gameType/playerCount/rules 与既有会话一致**，再返回旧会话 | 同房号不同玩法的重试不得静默复用 |

### 3.2 跑得快规则

| # | 决策 | 理由 |
|---|---|---|
| D30 | 48 张：54 − 大小王 − 黑桃2 − 梅花2 − 方块2 − 黑桃A；保留红桃2 | 用户裁决 K7；红桃完整 |
| D31 | 3 人各 16；4 人各 12；2 人 48 张洗牌分 3 份×16，seat0/seat1 各一份，第三份扣下 | 用户裁决 K8；扣下份内部保存、不出站 |
| D32 | 每局第一手按红桃 3→4→…→A→2 找第一张在玩家手中的红桃；2 人局全扣则随机；之后每手由上一手最后出牌者先出 | 用户裁决 K9/K17；可向玩家文字解释 |
| D33 | 可以过牌；其余玩家都过后，最后出牌者重新首出；首出时不可过牌 | 用户裁决 K10 |
| D34 | 炸弹仅四张同点；AAA 不当炸弹；最大炸弹 KKKK；最大三张 AAA；最大四带二 KKKK+2 | 用户裁决 K11 |
| D35 | 牌型/带牌可配置；默认裸三张开、三带二关、裸飞机关、四带二开、四带二带牌成对关、飞机翅膀只带对 | 用户裁决 K14 |
| D36 | 先出完者胜；剩 1 张未赢的输家保本付 0（可配置） | 用户裁决 K12 |
| D37 | 计分每项独立开关；默认全开、封顶 64、保本开 | 用户裁决 K13 |
| D38 | `倍数 = min(cap, 2^炸弹数 × 关牌?2:1 × 春天?2:1)`；输家付 `剩余张数×底分×倍数`；赢家所得为输家应付之和 | 零和、可配置、可审计 |
| D39 | 2 人局春天不适用（只有一个输家）；关牌仍适用；4 人局春天 = 三名输家都一张未出 | 人数边界 |
| D40 | 超时/托管：首出打最小单张；跟牌打最小可压组合；无解则过 | 与斗地主 autoplay 同构 |
| D41 | 规则错误按玩法映射；错误映射覆盖闸扫描所有玩法目录 | 新玩法不得绕过既有门禁 |
| D42 | 跑得快视图带服务端算好的 `canPass`、`bombCount`、`winnerSeats` | 客户端仍是哑终端，不本地判规则 |
| D43 | 2 人局扣下的 16 张**不出站**；仅存会话与记录供审计 | 防止客户端推导未发牌 |
| D44 | 跑得快记录：16/12 张手牌、剩余张数、倍数、炸弹数、关牌/春天/保本标记 | 历史页最小展示 |
| D45 | 客户端提示（hint）复用 `protocol` 的跑得快牌型解析；禁止本地规则实现 | 与斗地主 hint 同一边界 |

---

## §4 平台实现设计

### 4.1 分层与目录

```
packages/protocol/
  src/game.ts                 GameType / GameMeta / 兼容缺省
  src/views.ts                GameViewBase / DdzPlayerView / PdkPlayerView / GameView
  src/settlement.ts           SettlementVector / DdzSettlementResult / PdkSettlementResult
  src/messages.ts             room.match/join 新字段；game.finished 联合
  src/rpc.ts                  StartGameRequest 新字段；RecordWrite 变长
  src/rule.ts                 斗地主牌型（不动）
  src/pdk/rule.ts             跑得快牌型解析/比较（零依赖，客户端 hint 共用）
  src/pdk/rules.ts            PdkRulesConfig 类型（客户端 hint / bot 共用）
  src/records.ts              变长 encodeHand/decodeHand
  src/robot.ts                按玩法特征/决策联合
  src/config.ts               新配置键 + 解析
  src/errors.ts               12012

packages/shared/
  src/core/session.ts         GameSessionBase / GamePlayerBase / ActionLogEntryBase
  src/core/action.ts          GameAction 内部联合
  src/core/governance.ts      从 ddz/governance.ts 迁入（re-export 兼容）
  src/core/timer.ts           从 ddz/timer.ts 迁入（re-export 兼容）
  src/ddz/*                   现有规则（仅加 gameType/playerCount/rules 字段）
  src/pdk/deck.ts             48 张牌堆
  src/pdk/deal.ts             2/3/4 人发牌 + 首出解析
  src/pdk/types.ts            PdkSession / PdkPlayer / PdkGameState
  src/pdk/play.ts             出牌/过牌/胜负/保本/超时
  src/pdk/settle.ts           结算
  src/pdk/autoplay.ts         最小可压/首出
  src/pdk/features.ts         机器人公开特征
  src/pdk/rules.ts            PdkRulesConfig + 默认值 + 校验

packages/game-service/src/games/
  runtime.ts                  GameRuntime 接口 + RuntimeCtx/Transition
  registry.ts                 GameRegistry
  ddz/runtime.ts              斗地主适配（行为不变）
  ddz/view.ts                 现有 view.builder 迁入
  ddz/rule-error.mapping.ts   现有映射迁入
  pdk/runtime.ts              跑得快适配
  pdk/view.ts                 PdkPlayerView 投影
  pdk/rule-error.mapping.ts   跑得快错误映射

packages/room-service/src/
  match/match.service.ts      队列键/票/分组
  rooms/rooms.service.ts      RoomMeta gameType/maxPlayers
  rooms/rooms.start.ts        开局链传 gameType/playerCount/rules；记牌器能力位
  gateway/message.router.ts   room.match/join 校验
  gateway/ws.gateway.ts       事件信封 gameType；结算/记录
  currency/settle.service.ts  scoreChanges 通用
  config/config-cache.service.ts  按玩法档位/规则

packages/robot-service/src/robot/
  robot.pool.ts               池键/旧 ddz 双读
  bot.player.ts               按玩法分派
  bots/ddz.ts                 现有 DouZero/规则降级
  bots/pdk.ts                 跑得快规则 bot
  robot.service.ts            acquire/release/availability/decide 带 gameType

apps/client/src/
  gameModes.ts                玩法目录（GameMeta + 展示信息）
  pages/table/table.vue       通用壳
  components/table/ddz/DdzBoard.vue
  components/table/pdk/PdkBoard.vue
  stores/game.ts              GameView / gameType / playerCount / 按玩法 getter
  net/session.ts              联合视图/结算
  pages/lobby、pages/game、pages/history  玩法感知
```

### 4.2 `GameType` 与 `GameMeta`

`packages/protocol/src/game.ts`：

```ts
export const GAME_TYPES = ['doudizhu', 'paodekuai'] as const;
export type GameType = (typeof GAME_TYPES)[number];
export const DEFAULT_GAME_TYPE: GameType = 'doudizhu';

export interface GameCapabilities {
  cardCounter: boolean;
  bots: boolean;
  goldRoom: boolean;
  voiceAnnouncements: boolean;
}

export interface GameMeta {
  id: GameType;
  name: string;
  /** 升序；首版跑得快 = [2, 3, 4]，斗地主 = [3]。 */
  supportedPlayerCounts: readonly number[];
  defaultPlayerCount: number;
  capabilities: GameCapabilities;
}

export const GAME_META: Readonly<Record<GameType, GameMeta>> = {
  doudizhu: {
    id: 'doudizhu', name: '斗地主',
    supportedPlayerCounts: [3], defaultPlayerCount: 3,
    capabilities: { cardCounter: true, bots: true, goldRoom: true, voiceAnnouncements: true },
  },
  paodekuai: {
    id: 'paodekuai', name: '跑得快',
    supportedPlayerCounts: [2, 3, 4], defaultPlayerCount: 3,
    capabilities: { cardCounter: false, bots: true, goldRoom: true, voiceAnnouncements: false }, // 2026-10-25 语音复用后为 true（见语音 spec）
  },
};

export function isGameType(value: unknown): value is GameType;
export function parseGameType(value: unknown): GameType; // undefined ⇒ DEFAULT_GAME_TYPE；空串/非法值抛 ProtocolError
export function supportsPlayerCount(gameType: GameType, count: number): boolean;
```

- `GameMeta` 是**静态目录**，不进配置中心；开关在配置中心（`game.paodekuai.enabled`）。
- 回合时长沿用现有挂机治理档位（normal/accel/trustee），`GameMeta` **不设**
  `turnDurationMs` 第二真源；若将来某玩法需要不同基础时长，另加配置键。
- `parseGameType` 的兼容语义：**字段缺失** ⇒ `doudizhu`；**字段存在但非法** ⇒ `ProtocolError`
  （不得把拼错的玩法 id 静默当斗地主）。旧客户端不会带该字段，新客户端带合法值。
- 客户端 `GAME_MODES` 从 `GAME_META` 生成名称/id，另加 tagline/icon；禁止再抄一份 id 列表。

### 4.3 `GameRuntime` 与 `GameRegistry`

`packages/game-service/src/games/runtime.ts`：

```ts
export interface CreateGameInput {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  players: StartGamePlayer[];   // 已按 seat 升序
  rules?: unknown;              // 玩法快照；跑得快为 PdkRulesConfig
  random: () => number;
  /** 内部测试钩子（仅 INTERNAL_TEST_HOOKS=1）：固定随机种子/牌堆。 */
  seed?: number;
  testDeck?: Card[];
}

export interface RuntimeCtx {
  now: number;
  random: () => number;
  governance: GovernanceDurations;
}

export interface Transition<S extends GameSessionBase> {
  session: S;
  ended: boolean;
}

export interface GameRuntime<S extends GameSessionBase = GameSessionBase> {
  readonly gameType: GameType;
  readonly meta: GameMeta;

  create(input: CreateGameInput): S;
  applyAction(session: S, action: GameAction, ctx: RuntimeCtx): Transition<S>;
  onTimeout(session: S, ctx: RuntimeCtx): Transition<S>;
  isFinished(session: S): boolean;
  /** 补齐终局字段（winner/winnerSeats/state/finishedAt）；orchestrator 在 isFinished 为真时调用。 */
  finish(session: S, now: number): S;
  settle(session: S): SettlementResult;

  buildView(session: S, seat: number): GameView;
  /** 按 session.players 遍历；替代 ddz 专用 buildAllSeatViews/SEATS。 */
  buildAllViews(session: S): GameView[];
  buildRobotInput(session: S, seat: number): { view: GameView; features: RobotFeatures };
  buildRecord(session: S): RecordEnvelope | undefined;
  /** 当前行动者；斗地主叫抢用 bidPhase.currentBidder，跑得快用 currentPlayer。 */
  currentActor(session: S): number;
  /** 当前计时阶段；斗地主叫抢/出牌两档，跑得快恒 play。 */
  timerPhase(session: S): 'bid' | 'play';
  turnDuration(session: S, seat: number, policy: GovernanceDurations): number;
  /** 超时、托管、机器人降级共用的自动动作。 */
  autoAction(session: S, seat: number): GameAction;
}
```

- `finish` 把斗地主的 `checkWinCondition`/`winner`/`state=ended`/`finishedAt` 语义收进
  runtime；orchestrator 不再直接调用 `checkWinCondition`。
- `autoAction` 承接现有超时路径与 `ruleDecision` 的最小可压逻辑；跑得快 robot 与超时共用。
- `StartGamePlayer` 复用 `protocol/src/rpc.ts` 的 `StartGameRequest.players[]` 元素形状。

记录信封按玩法联合（`game.ended` 的 `record` 字段）：

```ts
export interface DdzRecordEnvelope {
  gameType: 'doudizhu';
  playerCount: 3;
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string }>;
  bottomCards: string;
}
export interface PdkRecordEnvelope {
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string; playedCount: number }>;
  /** 2 人局扣下的 16 张；3/4 人局缺省。仅审计，不进客户端视图。 */
  unusedCards?: string;
}
export type RecordEnvelope = DdzRecordEnvelope | PdkRecordEnvelope;
```

- `GameService` 保留：Redis 会话读写、per-room 串行写队列、CAS、事件发布、计时器句柄、机器人驱动、
  指标、trustee 守卫顺序。规则相关全部走 runtime。
- `GameRegistry` 在 `GameModule` 注册 `DdzRuntime`、`PdkRuntime`；`get(gameType)` 找不到 ⇒
  响亮失败，绝不回落到斗地主。
- **game-service 不判定“玩法开关”**（它不依赖 config-service）：开关只在 room-service 的
  match/create/start 门。game-service 只校验 `gameType` 已知、`playerCount` 在 `GameMeta`
  支持集内。
- runtime 增 `buildAllViews(session): GameView[]`（按 `session.players` 遍历），替代斗地主专用的
  `buildAllSeatViews`/`SEATS=[0,1,2]`；座位校验用 `playerCount`，2/4 人不得漏座或抛错。
- **S1 替换点机械清单**（每一处都必须改走 runtime，不得按 `GameState` 硬分支）：

| GameService 现分支 | 改走 |
|---|---|
| `GameState.Init/Bidding/Ended` 判断 | `runtime.currentActor/timerPhase/isFinished` |
| `bidPhase.currentBidder` | `runtime.currentActor` |
| `turnDurationFor` | `runtime.turnDuration` |
| `handleBid`/`handlePlayTimeout` | `runtime.onTimeout` |
| `ruleDecision`/`findSmallestBeatingCards` | `runtime.autoAction` |
| `checkWinCondition`/`session.winner` | `runtime.isFinished`/`runtime.finish` |
| `settleGame` | `runtime.settle` |
| `buildPlayerView`/`buildAllSeatViews` | `runtime.buildView`/`buildAllViews` |
| `buildPublicFeatures` | `runtime.buildRobotInput` |
| `buildRecordEnvelope` | `runtime.buildRecord` |
| `applyById` 的 bid/play/pass 分派 | `runtime.applyAction` |

- **斗地主 runtime 是适配层**：`create` 调 `createSession` + `dealCards`；`applyAction` 调
  `handleBid`/`handlePlayCards`/`handlePass`；`onTimeout` 调 `handleBid(false)`/`handlePlayTimeout`；
  `isFinished` 调 `checkWinCondition`；`settle` 调 `settleGame`；`buildView` 调现有
  `buildPlayerView`；`buildRobotInput` 调 `buildPublicFeatures`；`buildRecord` 调现有信封。
  这些函数签名不变，因此斗地主行为可逐字回归。
- `game-service/src/game/dto.ts` 的 `StartGameRequest`/`GameStartedResponse` **删除重复定义**，
  统一从 `protocol/src/rpc.ts` 导入；`GameSnapshotResponse`/`GameViewResponse` 改用
  `GameSessionBase`/`GameView`，不得留第二份类型真源。
- **`runtime.buildRecord` 是唯一记录信封入口**：不得让 pdk 走斗地主的 `buildRecordEnvelope`
  （它对 pdk 会先 `encodeCards(undefined)` 抛错）；pdk runtime 自己编码手牌/扣牌。

### 4.4 会话与存储

`packages/shared/src/core/session.ts`：

```ts
/** 牌元泛型位：首版两种玩法都实例化为 Card；麻将以后用 Tile。 */
export interface GamePlayerBase<P = Card> {
  id: string;
  seat: number;
  hand: P[];
  isBot: boolean;
  isOffline: boolean;
  timeoutCount: number;
  trustee: boolean;
}

export interface ActionLogEntryBase<P = Card> {
  version: number;
  seat: number;
  cards: P[];
  kind: 'play' | 'pass';
}

export interface GameSessionBase<P = Card> {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  state: string;
  players: GamePlayerBase<P>[];
  currentPlayer: number;
  turnDeadlineAt: number;
  version: number;
  actionLog: ActionLogEntryBase<P>[];
  createdAt: number;
  finishedAt: number | null;
  /** 开局时的规则快照；斗地主不用。 */
  rules?: unknown;
  // ── 服务端内部字段（永不出站；两种玩法共用） ──
  /** 机器人内部 ID，按座位索引；人类为 undefined。 */
  botIds?: Array<string | undefined>;
  /** 机器人难度，按座位索引。 */
  botSkillLevels?: Array<'beginner' | 'intermediate' | 'advanced' | undefined>;
  /** 机器人基础手速（ms），按座位索引。 */
  botThinkingSpeeds?: Array<number | undefined>;
  /** 发牌后、动作前的初始手牌冻结快照（记录用）。 */
  initialHands?: P[][];
}
```

- 斗地主 `GameSession extends GameSessionBase<Card>`，`state: GameState`、`players: GamePlayer[]`；
  新增 `gameType: 'doudizhu'`、`playerCount: 3`；`rules?: never`。
- 跑得快 `PdkSession extends GameSessionBase<Card>`，`state: PdkGameState`、`players: PdkPlayer[]`；
  额外 `unusedCards?: Card[]`（2 人局扣牌，永不出站）、`lastPlayedHand`、`lastPlayerIdx`、
  `consecutivePasses`、`bombCount`、`playPhase` 等。
- **旧会话兼容**：反序列化时若缺 `gameType`：
  - 有 `bidPhase`/`playPhase`/`bottomCards` ⇒ 视为 `doudizhu` + `playerCount=3`；
  - 有 `lastPlayedHand` 但无地主字段、或已有 pdk 字段 ⇒ **抛错**（不允许把跑得快当斗地主）。
- 会话键不变；`SESSION_TTL_SECONDS` 不变。`game:events` 信封增加 `gameType`/`playerCount`；
  room-service 缺省按斗地主处理（部署窗口）。

### 4.5 协议

#### 4.5.1 视图

```ts
/** 牌元泛型位：首版两种玩法都实例化为 Card；麻将以后用 Tile。 */
export interface RecentActionBase<P = Card> {
  seat: number;
  cards: P[] | null;
}

export interface GameViewBase<P = Card> {
  roomCode: string;
  /** 过渡期可选：缺失 = doudizhu（K3）；新生产者一律写。 */
  gameType?: GameType;
  /** 过渡期可选：缺失 = 3；新生产者一律写。 */
  playerCount?: number;
  version: number;
  state: string;
  baseScore: number;
  seat: number;
  hand: P[];
  cardCounts: number[];
  trustees: boolean[];
  currentPlayer: number;
  recentActions: RecentActionBase<P>[];
  turnDeadlineAt: number;
  /** 预留：麻将多决策窗口；首版两种玩法恒 [currentPlayer]。 */
  activeSeats?: number[];
}

export interface DdzPlayerView extends GameViewBase<Card> {
  gameType?: 'doudizhu'; playerCount?: 3;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  bottomCards: Card[] | null;
  landlordSeat: number | null;
  bidPhase: { /* 现状不变 */ };
  playPhase: { bombCount: number };
  winner?: 'landlord' | 'farmer';
}

export interface PdkPlayerView extends GameViewBase<Card> {
  gameType: 'paodekuai'; playerCount: 2 | 3 | 4;
  state: 'playing' | 'ended';
  /** 服务端算好：首出 false，跟牌 true。 */
  canPass: boolean;
  /** 当前已打出的炸弹数（显示/结算预览）。 */
  bombCount: number;
  /** 本局规则快照：客户端 hint / 显示牌型必须按它判定（RH5）。
   *  ⚠️ 字段名不得叫 `rules`：`FORBIDDEN_OUTBOUND_KEYS` 含 `rules`（内部会话快照禁出站）。 */
  pdkRules: PdkRulesConfig;
  /** 结束时有值。 */
  winnerSeats?: number[];
}

export type GameView = DdzPlayerView | PdkPlayerView;
/** 旧代码兼容别名；首版两种玩法都用 Card。 */
export type RecentAction = RecentActionBase<Card>;
/** 旧代码兼容别名；新通用代码用 GameView。 */
export type PlayerView = DdzPlayerView;

/** 视图玩法解析：只有字段缺失才缺省斗地主；pdk 字段存在但 gameType 缺失 ⇒ 抛错。 */
export function resolveGameType(view: GameViewBase): GameType;
```

- `resolveGameType`: `gameType === 'paodekuai'` ⇒ pdk；`gameType === 'doudizhu'` 或
  `undefined` 且无 pdk 专属字段 ⇒ doudizhu；有 pdk 专属字段但 `gameType` 缺失 ⇒ `ProtocolError`。
- `cardCounts` / `trustees` 从 3 元组改为变长数组。JSON 线上仍是数组；旧客户端按 3 长度消费，
  斗地主仍为 3。`validateOutbound` 按 `gameType` + `playerCount` 校验长度：
  - 字段缺失 ⇒ 按斗地主/3 校验；
  - 字段存在非法 ⇒ 抛错。
- `recentActions` 继续窗口 2、旧→新、`cards: null` = 不出；跑得快复用。
- `FORBIDDEN_OUTBOUND_KEYS` 增加 `unusedCards`、`lastPlayedHand`、`rules`、`initialHands`、
  `botIds`、`botSkillLevels`、`botThinkingSpeeds`、`actionLog`（现有集合 + pdk 内部字段）。
- 跑得快视图**不包含** `lastPlayedHand` 的规则字段；只给显示窗口和服务端算好的 `canPass`。

#### 4.5.2 结算

```ts
/** 跑得快等新玩法使用的通用结算向量。 */
export interface SettlementVector {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  winnerSeats: number[];
  scoreChanges: Array<{ seat: number; delta: number }>;
}

/** 斗地主：线上保持旧 9 键，不得新增字段（D7/N1）。 */
export interface DdzSettlementResult {
  roomCode: string;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  farmerSeats: number[];
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number;
  farmerScoreChange: number;
}

export interface PdkSettlementResult extends SettlementVector {
  gameType: 'paodekuai'; playerCount: 2 | 3 | 4;
  remaining: number[];
  multiplier: number;
  bombCount: number;
  guan: boolean;
  spring: boolean;
  baobenSeats: number[];
}

export type SettlementResult = DdzSettlementResult | PdkSettlementResult;
```

- **斗地主结算不新增字段**：`SettleService.computeSettlement` 用
  `'gameType' in result && result.gameType === 'paodekuai'` 判别（Ddz 结果没有 `gameType` 键）；
  斗地主继续用 `landlordScoreChange`/`farmerScoreChange` 旧公式，pdk 用 `scoreChanges`。
- `game.finished` 载荷：

```ts
| { type: 'game.finished'; version: number;
    payload:
      | { winner: 'landlord' | 'farmer' }              // 斗地主：旧形状不变
      | { gameType: 'paodekuai'; winnerSeats: number[] } }
```

- `game.settlement` 载荷 `SettlementResult`；斗地主仍 9 键。
- `game.balances` 载荷可增 `gameType?`/`playerCount?`（旧客户端忽略）；按座位升序，
  长度 = `playerCount`（缺失 = 斗地主/3）。旧 gateway 只认 3 条，pdk 必须等 gateway 升级后再开。
- `SettleOutboxEntry` 增 `gameType?`/`playerCount?`（旧条目缺省 ddz/3）；`resend/finalize`
  广播 `game.balances` 与 `record.moneyDelta` 时从条目取，不得缺省成 3 座（N2）。
- `record.moneyDelta` 请求带 `gameType`/`playerCount`；pdk outbox 重发同样带。

#### 4.5.3 请求与 RPC

- `room.match` payload 增 `gameType?: GameType`、`playerCount?: number`；
  缺省 `doudizhu` / `GameMeta.defaultPlayerCount`。
- `room.join` payload 增 `gameType?: GameType`（客户端能力声明）；缺省 `doudizhu`。
- **REST join**：`POST /api/rooms/:code/join` 请求体 `JoinRoomDto { gameType?: GameType }`
  （缺省 `doudizhu`）；客户端 `rest.joinRoom(code, gameType?)`。语义与 WS 一致（§4.6.2）。
- `StartGameRequest` 增 `gameType?: GameType`、`playerCount?: number`、`rules?: unknown`；
  另增**内部测试专用** `seed?: number`/`testDeck?: Card[]`（仅 `INTERNAL_TEST_HOOKS=1`
  且 internal token；生产默认关闭）。
- `GameStartedResponse` 增 `gameType`/`playerCount`。
- `GameActionResponse`/`GameViewResponse` 改为 `GameView` / `GameView | null`（N5）；
  `GameRpcController.action` 同步，pdk 不得被伪装成 ddz。
- `RecordWriteRequest` 增 `gameType?`/`playerCount?`（缺省斗地主/3）、`unusedCards?: string`
  （仅 pdk 2 人局，32 hex）；`seats[].hand` 变长；`bottomCards?` 可选；
  `seats[].playedCount` 仅 pdk 必需（RH1/N6）。
- `RecordMoneyDeltaRequest` 增 `gameType?`/`playerCount?`（缺省斗地主/3）；`deltas` 变长，
  校验长度 = `playerCount`、座位 `0..playerCount-1` 升序。
- `RobotAcquireRequest`/`Release`/`Availability`/`Decide` 增 `gameType?: GameType`。
- `RobotDecideRequest.view` 改为 `GameView`；`features` 改为按玩法联合。
- **不新增消息类型**；`CLIENT_MESSAGE_TYPES`/`SERVER_MESSAGE_TYPES` 计数不变。
- `CAS_MESSAGES` 不变（`game.bid/play/pass`）；跑得快只用 `play/pass`。
- `room.matched` payload 增 `gameType?`/`playerCount?`；`room.state_update` payload 增
  `gameType?`/`playerCount?`。旧客户端忽略；新客户端据此选 board/自动 join。

#### 4.5.4 校验与兼容

- `validateOutbound` 按 `gameType` 分派：
  - 字段缺失 ⇒ 按斗地主/3 校验（旧服务消息）；
  - `doudizhu`：现有校验 + 变长数组（恰 3）；
  - `paodekuai`：`playerCount ∈ {2,3,4}`；`hand.length === cardCounts[seat]`；
    `cardCounts.length === trustees.length === playerCount`；`canPass` 严格 boolean；
    `winnerSeats` 在 ended 时非空、否则缺省。
- `validateInbound` / `validateClientMessage`：
  - `room.match` 的 `gameType` 缺失 ⇒ 斗地主；非法 ⇒ `10001`。
  - `room.join` 的 `gameType` 缺失 ⇒ 斗地主；非法 ⇒ `10001`。
  - **玩法是否开放 / 人数是否支持不在 protocol 校验器判定**（它拿不到配置）；
    由 room-service 的 `handleMatch`/REST 建房/join 产出 `12012`。
- **旧客户端兼容断言**（测试钉住，使用冻结的旧版校验器/消息夹具，见 D23）：
  1. 旧 `room.match` 载荷（无 gameType/playerCount）⇒ 斗地主 3 人。
  2. `GET /api/rooms` 无 gameType ⇒ 只返回斗地主房。
  3. REST join 与 WS `room.join` 无 gameType 进跑得快房 ⇒ `12012`，且 REST 不占座。
  4. 旧 `PlayerView` 校验器（冻结副本）遇到新增 `gameType`/变长数组（长度 3）不报错。
  5. 旧 `SettlementResult` 校验器（冻结副本）遇到 `scoreChanges`/`winnerSeats` 不报错。
  6. 旧 `game.finished` 处理器只读 `winner`；斗地主载荷仍带 `winner`。
  7. 旧服务发出的 ddz 消息（无 `gameType`）被新 gateway/新客户端按斗地主处理。
  8. 新服务发出的 ddz 消息（带 `gameType`）被旧 gateway/旧客户端忽略新增字段。

### 4.6 房间与匹配

#### 4.6.1 队列键

```ts
// 斗地主：保持旧 3 段键，零迁移
match:queue:{mode}:{baseScore}:{region}
// 跑得快：新 5 段键
match:queue:{mode}:paodekuai:{playerCount}:{baseScore}:{region}
```

- `matchQueueKey(mode, gameType, playerCount, baseScore, region)` 按玩法选形状：
  `doudizhu` 恒旧 3 段（playerCount 必须 3）；`paodekuai` 恒新 5 段。
- `parseMatchQueueKey` 先按新 5 段解析，再按旧 3 段解析；旧 3 段 ⇒
  `{ gameType:'doudizhu', playerCount:3, legacy:true }`；未知玩法/人数 ⇒ `null`。
- **所有按键操作必须用票/扫描结果的真实键**：
  - `ParsedQueueKey { key, mode, gameType, playerCount, baseScore, region, legacy }`；
  - `MatchTicket` 增 `queueKey?`/`gameType?`/`playerCount?`；旧 `match:meta` 缺字段 ⇒
    ddz/3/legacy；
  - 统一 helper `queueKeyOfTicket(ticket)`：有 `queueKey` 用原键；旧票（缺 gameType/playerCount）
    返回旧 3 段键；否则按 `matchQueueKey` 构造；
  - `processQueue/failMatch/cancelQueue/handleMatch 探测` 全部用 `queueKeyOfTicket` 或扫描实际
    key，**不得**用解析值重建新键。
- `handleMatch` 重复/换队：
  - 同 `(mode, gameType, playerCount, baseScore, region)` ⇒ `12009`；
  - 不同维度 ⇒ 先按旧票的 `queueKeyOfTicket` `cancelQueue`，再入新队（不得双入队/幽灵票）。
- 分组键 = `(mode, gameType, playerCount, baseScore, region)`；组大小 = `playerCount`。
- **2/3/4 人匹配参数化**：`randomGreedyPick` 的 `>=3`/`===3`、`processQueueNoBots` 的
  “恰好 3 真人”、`startGroup` 的座位数、等待窗口/attempts 全部改读 `playerCount`。
  首版生产由 `game.paodekuai.nonThreePlayerEnabled=false` 闸住（只允许 3 人），
  但代码与测试必须覆盖 2/4；开关打开前不得把 2/4 暴露给客户端。
- **开局占用（RH3-a）**：`startGroup` 在 `startRoom` 前为参战人类写
  `match:claim:{playerId}`（roomCode + TTL，**所有模式**，不只金币场）；扫描器/`randomGreedyPick`
  跳过仍持有 claim 的玩家；`onSeats`/开局完成后释放或让其过期。即使 `game.start` 成功但
  `onSeats` 延迟/失败，玩家也不会被下一轮扫描重复选中。补“start 成功 + onSeats 延迟/失败 +
  并发扫描”测试。
- `assertKnownBaseScore(gameType, baseScore)` 查按玩法档位；跑得快档位来自 `game.levels.paodekuai`。
- 机器人补位开关仍按 `mode`；补位数量 = `playerCount - humans`。
- `robot.availability` 带 `gameType`；跑得快不检查 DouZero。
- `matchQueueLength` 指标标签增加 `game_type`/`player_count`（至少不把两种玩法同底分聚合）。

#### 4.6.2 房间元数据

```ts
export interface RoomMeta {
  code: string;
  mode: RoomMode;
  /** 过渡期可选：旧房间 Hash 缺该字段 ⇒ 读作 doudizhu（不视为坏房）。 */
  gameType?: GameType;
  maxPlayers: number;      // 旧房间缺省 3；跑得快 = 座位数（2/3/4）
  baseScore: number;
  status: RoomStatus;
  createdAt: number;
  timeoutAt: number;
}
```

- **`RoomInfo.playerCount` 保持现有语义 = 当前已占座位数**（旧客户端房态显示依赖它）；
  **不得**改成 `maxPlayers`。容量继续用 `maxPlayers`；新增 `gameType?`。
- `RoomMeta` 的严格读取（`META_FIELDS`/`readMeta`）必须把缺失/非法 `gameType`
  （含写回的字符串 `"undefined"`）容错为 `doudizhu` + WARN，否则部署窗口内仍在等待的旧房间
  会读成 `null`（列表消失、join 12001）。**`META_FIELDS` 必须新增 `gameType`**；
  `writeMeta` 必须写 `source.gameType ?? 'doudizhu'`，不得把 `undefined` 写成字符串；
  旧 Hash 读 → 写回补齐 → 再读的往返测试必须存在。
- `GET /api/rooms` 增可选 `gameType` 查询；缺省 `doudizhu`。新客户端按 `activeMode` 传；
  旧客户端不传 ⇒ 只看到斗地主房。
- `POST /api/rooms` 增可选 `gameType`/`playerCount`；`mode` 仍 practice-only；
  校验开关/人数支持，非法 ⇒ `12012`。
- **REST join 的请求形状（RB1）**：`POST /api/rooms/:code/join` 请求体
  `JoinRoomDto { gameType?: GameType }`（缺省 `doudizhu`）；客户端
  `rest.joinRoom(code, gameType?)` 发送 `activeMode`。服务端顺序：
  读房产 → 未满/未开局检查 → **gameType 与房间不符 ⇒ `12012`（在占座之前）** → 占座。
  旧客户端不带 body ⇒ 斗地主；进 pdk 房 ⇒ 12012，不占座。
- WS `room.join` 同样校验 gameType（缺省 doudizhu）；与 REST 语义一致。
- `room.matched` / `room.state_update` 带 `gameType`/`playerCount`；客户端自动 join 原样回传。
  注意消息名是 `room.matched`，不是 `game.matched`。
- 自动开局/补位/超时/回收全部按 `maxPlayers`，不再写死 3。
- `RoomsAutostartTask` 对开关关闭后的等待中 pdk 房：**允许开完**（D13），但不再新建；
  补位/开局链仍校验规则配置，失败则留 `waiting` 并告警（见 §4.6.3 的 strict/重试预算）。

#### 4.6.3 开局链

`rooms.start.ts`：

1. `fillBots` 补到 `room.maxPlayers`；`robot.acquire` 带 `gameType`/`seats`。
2. 写 `match:pending`/reconnect（不变）。
3. 金币场余额快照（不变；长度 = maxPlayers）。
4. **pdk 开局序列（RH3，必须按此实现）**：
   - 读规则快照；失败 ⇒ **不 announce、不 start、不调 `onSeats`**；房间留 `waiting`，
     独立键 `room:{code}:start_attempts` INCR（不进 `RoomMeta`，避免动七字段闸），
     下一轮扫描重试；
   - **顺序固定**：读规则成功 → announce（`announceFirst`，客户端进房等待）→ `game.start`；
     规则失败发生在 announce 之前，因此「规则失败不 announce」与 `announceFirst` 不冲突；
     规则就绪后才调 `game.start`，且 **pdk 全程 `strict:true`**（匹配路径也一样）：
     失败**不得**写 `playing`；
   - **`onSeats`（匹配路径取消队列票）必须在 `game.start` 成功之后**调用；
     若 `onSeats` 失败：只 WARN + 由下一轮扫描的 `cancelQueue`（按 `queueKeyOfTicket`）
     幂等清理，不把已开局的房判失败；
   - `room:{code}:start_attempts` 设 TTL = `ROOM_TTL_SECONDS`，随房回收；
     **`RoomsService.deleteRoom` 的删除集必须包含该键**（RH3-d）。
   - `game.start` 失败：不写 `playing`、不调 `onSeats`、**不取消房/不取消票**；
     `room:{code}:start_attempts` INCR，留 `waiting`，下一轮重试；
   - 重试预算：`room:{code}:start_attempts >= 5` 或 waiting timeout ⇒ 取消房，并对已收到
     `room.matched` 的玩家发 `system.warning`（`10007`，message 区分「正在重试」/「已取消」）；
     票按 `queueKeyOfTicket` 清理；**释放已绑定的机器人**（`robot.release` 带 gameType）。
   - **warning 事件形状（RH3-b）**：`MatchEvent` 增
     `{ event:'system_warning'; playerIds: string[]; code: number; message: string }`；
     `WsGateway.onMatchEvent` 收到后按 playerIds 定向 `emit('system.warning', {code,message})`；
     `rooms.start` 经 `match:events` 发布。不得临时发明第二条 socket 通路。
   - **`startGroup` 对 pdk strict 失败不得 `cancelIfStillWaiting`**：返回可重试状态，
     由扫描器下一轮重试；否则会出现「票已删、房已 cancelled、玩家收到 matched」的人票两空。
   - **返回形状（RH3-c）**：`startRoom` 返回 `'started' | 'retryable' | 'fatal'`；
     `startGroup` 只对 `fatal` 调 `cancelIfStillWaiting`；pdk strict 失败 / 规则读取失败 ⇒
     `retryable`；斗地主沿用现有语义（`false` 视为 `fatal`），不得改变旧行为。

```ts
await this.game.start({
  roomCode: code,
  gameType: room.gameType ?? 'doudizhu',
  playerCount: room.maxPlayers,
  baseScore,
  rules: (room.gameType ?? 'doudizhu') === 'paodekuai' ? pdkRules : undefined,
  players,
  // 测试钩子字段仅在 INTERNAL_TEST_HOOKS=1 时透传
  seed: startSeed,
  testDeck: startTestDeck,
});
```

5. `game.start` 成功后：
   - **pdk 在此之后调用 `onSeats`**（取消队列票）；失败只 WARN；
   - `chargeEntryFees` 用**按玩法档位**的 `entryFeePercent`；
   - `levelNameFor`/台费/日志档位名按 `gameType` 取表：斗地主 `game.baseScoreLevels`、
     跑得快 `game.levels.paodekuai`，不得混用；
   - `updateCardCounterStatuses` 仅当 `GAME_META[gameType].capabilities.cardCounter` 为真；
   - 跑得快不调用记牌器消费。
6. `room.matched`/`room.state_update` 带 `gameType`/`playerCount`。
7. `ws.gateway.onGameEvent` 的 `game.finished` 按玩法分支
   （`'gameType' in result && result.gameType === 'paodekuai'`）：
   - 斗地主发 **旧形状** `{ winner }`（不加 gameType；保持 9 键/旧客户端零变化）；
   - 跑得快发 `{ gameType:'paodekuai', winnerSeats }`；
   - 不得把 pdk 结果塞进 `{ winner:'landlord' }`。
8. `game.balances` 载荷带 `gameType`/`playerCount`；旧 api-gateway 只认 3 条，
   pdk 2/4 人余额广播必须等 gateway 升级后再开启（暗上线期间不暴露）。

### 4.7 配置

#### 4.7.1 新增配置键

| 键 | 类型/范围 | 默认 | 客户端可见 | 消费方 |
|---|---|---|---|---|
| `game.levels.paodekuai` | `BaseScoreLevel[]` | 与斗地主同四档：休闲 15 / 标准 80 / 竞技 480 / 豪侠 1200，`entryFeePercent=0` | 是（`games.paodekuai`） | room/config/client |
| `game.paodekuai.enabled` | boolean | `false` | 是（`games.paodekuai.enabled`） | room/config/client |
| `game.paodekuai.nonThreePlayerEnabled` | boolean | `false` | 是（`games.paodekuai.supportedPlayerCounts` 据此收窄） | room/config |
| `game.paodekuai.bareTrioEnabled` | boolean | `true` | 否 | room→game rules |
| `game.paodekuai.trioWithPairEnabled` | boolean | `false` | 否 | room→game rules |
| `game.paodekuai.bareAirplaneEnabled` | boolean | `false` | 否 | room→game rules |
| `game.paodekuai.fourWithTwoEnabled` | boolean | `true` | 否 | room→game rules |
| `game.paodekuai.fourWithTwoPairKickerAllowed` | boolean | `false` | 否 | room→game rules |
| `game.paodekuai.airplaneWings` | enum `pairs/singles/both` | `pairs` | 否 | room→game rules |
| `game.paodekuai.bombMultiplierEnabled` | boolean | `true` | 否 | room→game rules |
| `game.paodekuai.guanMultiplierEnabled` | boolean | `true` | 否 | room→game rules |
| `game.paodekuai.springMultiplierEnabled` | boolean | `true` | 否 | room→game rules |
| `game.paodekuai.multiplierCap` | int `1..1024` | `64` | 否 | room→game rules |
| `game.paodekuai.baobenEnabled` | boolean | `true` | 否 | room→game rules |

- **斗地主档位继续以 `game.baseScoreLevels` 为唯一真源**（D8）：不迁移、不双写、不新增
  `game.levels.doudizhu`。`ConfigCacheService.baseScoreLevels(gameType)` 对斗地主读旧键、
  对跑得快读 `game.levels.paodekuai`。旧 admin/旧客户端行为完全不变。
- `parseConfigValue` 增加 `airplaneWings` 枚举校验；其余复用 boolean/int/levels 解析。
- 配置快照：room-service 读 pdk 键组装 `PdkRulesConfig`，随 `game.start` 进入会话快照；
  game-service 不直接依赖 config-service。
- `nonThreePlayerEnabled=false` 时，room-service 把 pdk 的可用人数收窄为 `[3]`；
  协议/引擎仍支持 2/4，测试与 conformance 通过开关打开覆盖。
- pdk 规则键**不进 `/api/config`**；但每局 `PdkPlayerView.pdkRules` 与
  `PdkRobotFeatures.pdkRules` 携带本局规则快照，供客户端 hint 与 bot 判定使用
  （这是对局状态，不是运营配置泄露）。

#### 4.7.2 客户端配置

```ts
export interface ClientGameConfig {
  enabled: boolean;
  supportedPlayerCounts: number[];
  defaultPlayerCount: number;
  baseScoreLevels: BaseScoreLevel[];
}

export interface ClientConfig {
  // ...现有字段不变...
  /** 旧客户端只读 baseScoreLevels；新客户端读 games。 */
  games?: Partial<Record<GameType, ClientGameConfig>>;
}
```

- 旧客户端：`baseScoreLevels` 仍是斗地主档位，行为不变。
- 新客户端：按 `games[activeMode]` 渲染玩法卡与档位；`enabled=false` 时隐藏。

#### 4.7.3 管理后台

- `admin/app.js` 的 `CONFIG_IA` 增加「跑得快」域：
  - 规则：牌型开关/带牌开关；
  - 档位：`game.levels.paodekuai`；
  - 经济：与金币场共用的 `currency.*`；
  - 计分：三个翻倍键（炸弹/关牌/春天）+ 封顶 + 保本；
  - 开关：`game.paodekuai.enabled`、`game.paodekuai.nonThreePlayerEnabled`。
- 斗地主域**继续读 `game.baseScoreLevels`**（不迁移）；旧 admin 继续可写。
- `pnpm verify:admin` 的静态键清单/IA 断言同步更新。

### 4.8 机器人

- 规范池键：`bot:pool:doudizhu`、`bot:pool:paodekuai`；旧 `bot:pool:ddz` 双读：
  - `acquire('doudizhu')` 先读新池，空则读旧池并把机器人迁移到新池；
  - `release` 写回规范池；旧池只读不写。
- **`BotInstance` 持久化 `gameType`**（绑定/实例记录的一部分）；`release` 从 bot 记录推导玩法，
  不信任调用方（房键过期时 `finalizeRoomEnd` 可能拿不到 room.gameType）。
- `robot.acquire/release/availability/decide` 全链路带 `gameType`；room-service 从房间元数据取。
- `reclaimIdle/listIdle/poolSize/takeIdle` 全部按 `gameType` 参数化；pdk 空闲机器人必须能被回收，
  不得只扫 `bot:pool:ddz`。
- `bot.player.ts` 变分派器：
  - `doudizhu`：现有 DouZero + 规则降级；
  - `paodekuai`：纯规则 bot（`shared/pdk/autoplay.ts` + 简单策略），`source:'rule'`。
- `RobotFeatures` 按玩法联合：

```ts
export interface DdzRobotFeatures { /* 现状不变，增 gameType:'doudizhu' */ }
export interface PdkRobotFeatures {
  gameType: 'paodekuai';
  seat: number;
  lastMove: { type: PdkHandType; keyRank: number; length: number; cards: number[] } | null;
  numCardsLeft: number[];
  playedCards: number[][];     // 按座位
  actionSeq: number[][];
  passCount: number;
  bombCount: number;
  canPass: boolean;
  /** 本局规则快照：bot 的牌型/比较必须与服端一致（RH5）。不得叫 `rules`（禁出站键）。 */
  pdkRules: PdkRulesConfig;
}
export type RobotFeatures = DdzRobotFeatures | PdkRobotFeatures;
```

- 跑得快 bot 只拿自己的 `PdkPlayerView.hand` + 公开特征；**不得**拿 `unusedCards`/他人手牌。
- `robot.availability`：doudizhu 仍检查 DouZero/模型；paodekuai 只检查池内可用 bot（规则 bot 不依赖模型）。
- 超时/托管的自动动作与 bot 共用 `shared/pdk/autoplay.ts`，保证同口径。

### 4.9 记录与历史

**核心决策（D11）**：跑得快记录**单独建表**，不复用斗地主表。理由：
- `game_records` 的 `winner/landlord_seat/spring/landlord_score_change/...` 是 `NOT NULL`，
  `bottom_cards` 是 `char(6) NOT NULL`；pdk 没有这些字段，混表会打挂写入；
- 旧 user-service / 回滚后的旧服务只会查斗地主表，pdk 行不会进入旧历史页；
- 旧客户端 `/api/records/mine` 不带 `gameType` 时默认只查斗地主表，零破坏。

#### 4.9.1 DDL（新迁移）

```sql
CREATE TABLE game_records_pdk (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_code VARCHAR(16) NOT NULL,
  game_version INT NOT NULL,
  mode VARCHAR(16) NOT NULL,
  player_count TINYINT NOT NULL,
  base_score INT NOT NULL,
  winner_seat TINYINT NOT NULL,
  remaining JSON NOT NULL,          -- 按座位升序，含赢家 0
  multiplier INT NOT NULL,
  bomb_count INT NOT NULL,
  guan TINYINT(1) NOT NULL,
  spring TINYINT(1) NOT NULL,
  baoben_seats JSON NOT NULL,
  score_changes JSON NOT NULL,      -- [{seat, delta}]
  unused_cards VARCHAR(32) NULL,    -- 仅 2 人局：16 张 × 2 hex
  started_at BIGINT NOT NULL,
  ended_at BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_pdk_room_version (room_code, game_version),
  INDEX idx_pdk_ended_at (ended_at)
);

CREATE TABLE game_record_players_pdk (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  record_id BIGINT NOT NULL,
  seat TINYINT NOT NULL,
  user_id VARCHAR(36) NULL,
  is_robot TINYINT(1) NOT NULL,
  robot_id VARCHAR(64) NULL,
  nickname VARCHAR(64) NULL,
  hand VARCHAR(34) NOT NULL,        -- 16 张=32 hex / 12 张=24 hex
  played_count SMALLINT NOT NULL,
  money_delta INT NULL,
  ended_at BIGINT NOT NULL,         -- 保留期清理用（与父行同值）
  UNIQUE KEY uk_pdk_record_seat (record_id, seat),
  INDEX idx_pdk_user (user_id),
  INDEX idx_pdk_ended_at (ended_at)
);
```

- 斗地主表**不加列**、不改 `NOT NULL`；旧记录零迁移。
- pdk 表的 `money_delta` 在 `record.moneyDelta` 落库；`record.write` 与
  `record.moneyDelta` 都可能乱序，各自幂等（`UNIQUE` + `UPDATE ... WHERE money_delta IS NULL`）。
- `unused_cards` 只用于审计；任何客户端接口都不返回它（历史详情也不展示）。
- **保留期清理**：`RecordsCleanupService` 必须同时删 `game_record_players_pdk`（按 `ended_at`）
  与 `game_records_pdk`（按 `ended_at`），并纳入 `records_table_bytes` 指标；
  不得只删斗地主两表（RH1）。

#### 4.9.2 写入/查询分支

- `RecordWriteRequest` 增 `gameType`/`playerCount`；旧请求/旧 outbox 缺省斗地主/3。
  `record.rpc.controller` 按 `gameType` 分支：
  - `doudizhu`：现有校验/写入不变；
  - `paodekuai`：`seats.length === playerCount`、手牌恰 16（3/2 人）或 12（4 人）、
    `bottomCards` 必须缺省、`result` 为 `PdkSettlementResult`、`unusedCards` 可选且 32 hex；
    `seats[].playedCount` 必须是非负整数，且等于「初始手牌数 − remaining[seat]」
    （初始手牌数 = 16/12；2 人局扣牌不影响）。
- `record.moneyDelta` 增 `gameType`/`playerCount`；deltas 长度 = `playerCount`、座位
  `0..playerCount-1` 升序。outbox 条目同样带 `gameType`/`playerCount`；**旧条目缺省斗地主/3**。
  sweeper 重发按分支写对应表；pdk 写 `game_record_players_pdk.money_delta`。
- `ws.gateway.finalizeRoomEnd` 的 `exactlySeats012` 改为
  `exactlySeats(0..playerCount-1)`；pdk 2/4 人不得因座位数被跳过记录。
- **`SettleService` 的三座守卫必须参数化（RH2）**：`resolveSeats` 按实际座位集合
  `0..playerCount-1`，`coversAllSeats` 按 `matched.length === playerCount`；
  不得写死 `[0,1,2]`，否则 pdk 2/4 金币局会静默不结算。
- 查询 API：
  - `GET /api/records/mine?gameType=`：缺省 `doudizhu`（旧客户端零破坏）；
  - 新客户端进入跑得快历史时传 `gameType=paodekuai`；
  - 响应按玩法判别：斗地主 `MyRecord` 形状**不变**；跑得快 `PdkRecord`
    含 `remaining/multiplier/bombCount/guan/spring/baobenSeats/scoreChanges`；
  - 管理后台玩家详情按 `gameType` 渲染 role/结果；pdk 不显示地主/农民。

#### 4.9.3 codec 与历史展示

```ts
export function encodeHand(cards: Card[], expected: number): string;
export function decodeHand(s: string, expected: number): Card[];
export function encodeCards(cards: Card[], expected: number): string;
export function decodeCards(s: string, expected: number): Card[];
```

- 旧 `encodeHand(hand)` 17 张调用改为 `encodeHand(hand, 17)`；pdk 用 16/12。
- 历史页：
  - 列表按 `gameType` 分组/筛选；
  - 跑得快详情展示名次、剩余张数、倍数、炸弹数、关牌/春天/保本标记、金币变动；
  - 不做逐手回放。
- 旧记录/旧客户端：只读斗地主表，形状/键集不变。
- 回滚：pdk 表与旧服务完全隔离；旧服务不会读、不会写、不会因 pdk 行报错。

### 4.10 客户端

#### 4.10.1 玩法目录与大厅

- `gameModes.ts` 从 `GAME_META` 生成 `id/name`，另加 `tagline/icon`：

```ts
export const GAME_MODES = [
  { id: 'doudizhu', name: GAME_META.doudizhu.name, tagline: '三人一局，比谁先出完手牌', icon: undefined },
  { id: 'paodekuai', name: GAME_META.paodekuai.name, tagline: '三人跑得快，剩牌越少越赢', icon: undefined },
] as const;
```

- 大厅按 `clientConfig.games[id].enabled` 过滤；`baseScoreLevels` 按选中玩法取。
- `activeMode` 缺省 `doudizhu`；切换玩法时若当前档位不在新玩法档位表，回落到第一档。
- 开始游戏页 `room.match` 发送 `{ mode, baseScore, gameType: activeMode, playerCount: 3, deviceId }`。
- 好友房 `POST /api/rooms` 带 `gameType`/`playerCount`；**`GET /api/rooms` 也必须带
  `gameType: activeMode`**（`rest.rooms(gameType?)`），否则新客户端在跑得快模式只看到斗地主房。
- **所有 `room.join` 调用点都发送 `gameType`**：手动加入、`room.matched` 自动加入、
  重连/重启恢复。`room.matched`/`room.state_update` 携带 `gameType`/`playerCount`；
  `useGameSession` 用它写 `activeMode`，不得只发 `{ roomCode }`。
- 重启/重连：`view.gameType` 缺失按斗地主解析；有 pdk 专属字段但缺 gameType ⇒ 报错并回大厅，
  不得把跑得快视图当斗地主渲染。
- `pages.json` 标题改中性（如「牌桌」/「优比棋牌」）。

#### 4.10.2 牌桌壳与玩法牌桌

- `pages/table/table.vue` 只保留通用职责：
  - `useGameSession` 会话接线、`LandscapeStage`、`NoticeStack`、`ConnectionOverlay`、
    `useSettlementReveal`、`useCountdown`、通用音效（出牌/过牌/输赢）、返回/重开。
  - 根据 `store.view.gameType` 渲染 `<DdzBoard>` 或 `<PdkBoard>`。
- `DdzBoard.vue`：现有斗地主模板/逻辑迁移。**迁移前先定 shell/board 边界**：
  - shell 持有会话接线、房间状态、通知/连接、结算揭示、倒计时、通用音效、返回/重开；
  - board 接收 `view`/`mySeat`/`interactive`， emits `play/pass/bid/trustee/leave/rematch`；
  - 叫抢/底牌/记牌器/斗地主提示/牌型播报留在 `DdzBoard`；共享状态留在 store。
  - 受影响测试不止 11 个 `table-*`：还包括 `settlement-reveal`、`settlement-rematch`、
    `swipe-select`、`card-counter-*`、`hint-*`、`audio`、`landscape-*`；迁移清单逐条列出。
  - S5 验收加一次真浏览器斗地主回归（大厅→匹配→叫抢→出牌→结算→再来一局）。
- `PdkBoard.vue`：
  - 3 人座位（首版）；左侧/右侧对手、中央出牌区、底部手牌与动作栏；
  - 动作栏：出牌 / 不出（`view.canPass` 控制）/ 提示；
  - 无叫抢、无底牌、无地主徽标、无记牌器；
  - 顶部显示底分/倍数/剩余张数；
  - 结算展示：名次、剩余张数、倍数、关牌/春天/保本标记、金币变动。
- 共享组件：`Card`、`Hand`、`PlayArea`、`Seat`、`TurnTimer`、`Settlement` 壳、`TableHud` 复用；
  `Seat` 增 `role?: 'landlord' | 'farmer' | 'none'`（跑得快不画地主角标）。
- 音效：`useTableSound` 按玩法分派；跑得快首版只播出牌/过牌/输赢，不播斗地主牌型播报。**2026-10-25 起已被语音复用 spec 取代：跑得快复用斗地主牌型播报。**
- 提示：`game/hint.ts` 增加跑得快枚举，合法性委托 `protocol/src/pdk/rule.ts`；
  `source-boundary` 闸继续禁止客户端自写规则。
- 历史页：按 `gameType` 显示；跑得快详情最小展示。

### 4.11 兼容与灰度

- **部署顺序**：protocol/shared → config-service（种子）→ room-service → game-service →
  robot-service → user-service → **api-gateway** → client。pdk 开关在所有新镜像就位且
  api-gateway 能识别 pdk 消息后才打开；monorepo 镜像可一次构建，但滚动更新时契约需双读。
- **api-gateway 必须进接触面**：它会对出站消息做 `validateOutbound`；旧 gateway 会把 pdk 的
  `game.finished/game.settlement/game.balances` 当非法丢弃。S7 增加“旧 gateway + 新 pdk 消息”
  的负对照与“新 gateway + 旧 ddz 消息”的正对照。
- **旧客户端**：见 §4.5.4 的八条断言，使用冻结旧校验器/夹具。
- **在局会话**：旧会话缺 `gameType` 按地主形状识别；跑得快会话一律写 `gameType`，缺失即 fail closed。
- **开关关闭**：`game.paodekuai.enabled=false` ⇒ 新匹配/建房拒绝 `12012`；已在局与等待中房间跑完；
  历史记录仍可读。
- **2/4 人**：`nonThreePlayerEnabled=false` 时 room-service 把 pdk 可用人数收窄为 `[3]`；
  引擎/协议/结算/记录仍按 2/4 测试，开关打开即可用。
- **回滚边界（必须如实告知）**：
  - **S0/S1 可独立回滚**（只加协议/内核字段，斗地主路径不变）；
  - **S2 不能直接回滚**：斗地主队列键虽不变（D5），但机器人池已规范化为
    `bot:pool:doudizhu`、房间 Hash 多写 `gameType`。回滚前必须：停新匹配 → 排空在局房间 →
    把 `bot:pool:doudizhu` 的空闲机器人迁回/清空 → 再回滚旧 room/robot 镜像；
  - **pdk 开关打开并产生真实数据后不可“无脑回滚”**：旧 game-service 会把在局 pdk 会话当斗地主、
    旧 user-service 不会读 pdk 表（历史页只显示 ddz）、旧 room-service 不认识 pdk 新队列键、
    旧 robot-service 只回收 `bot:pool:ddz`；
  - pdk 回滚 runbook：先关 `game.paodekuai.enabled` 并等 pdk 局结束 → 清
    `match:queue:*` 中的 pdk 键与 `bot:pool:paodekuai` 空闲池 → 保留 pdk 记录表（旧服务不读）
    → 回滚镜像；
  - 回滚演练必须包含：旧 user-service 读 pdk 记录不报错、旧 room-service 不受 pdk 新键影响、
    ddz 队列在 S2 回滚前后一致、新池机器人不丢。

### 4.12 未来玩法边界

| 玩法 | A′ 适配度 | 现在不做、以后需要的扩展 |
|---|---|---|
| 跑得快/争上游 | 高 | 无（本片验证） |
| 掼蛋（4 人） | 中高 | 4 座（已泛化）、队友关系、进贡/还贡、多局升级 |
| 麻将 | 中低 | ① 牌元泛型（万/条/筒/字/花）② 多座位同时决策 + 优先级 ③ **orchestrator 多 actor/多 deadline/多行动者仲裁** ④ **room 多盘制生命周期 + 多次结算/记录** ⑤ 固定 4 座 |
| 德州扑克 | 低 | **独立牌桌域**：变座位 2–9、长桌多手、玩家两手之间进出、盲注/筹码/边池、每手结算；复用 protocol/配置/货币/记录，**不复用 room 匹配与一局制房间** |

- 本片只保留两个便宜接缝：**变长座位数组**、**会话/视图的牌元泛型位**（首版仍实例化为 `Card`）。
- `activeSeats` 字段预留但不实现多窗口调度。麻将不是“只加 runtime”：当前 `currentActor` 单值、
  单 timer、一次性 `finishTransition`、room 一局制都要改；因此 §4.12 把它标为**中低适配**，
  不再承诺“不动内核”。
- 德州扑克的“独立牌桌域”判断成立；但连 room 匹配/一局制房间也不能直接复用，`table-service`
  需要自己的座位、买卖入与多手生命周期。

---

## §5 跑得快规则设计

> 玩家可读版本实现时落 `docs/games/paodekuai.md`；本节是代码口径。

### 5.1 用牌与编码

- 牌堆：现有 54 张 `createDeck()` 过滤后剩 48 张：
  - 去掉大小王（`r=20/30`）；
  - 去掉黑桃2（`s=0,r=17`）、梅花2（`s=2,r=17`）、方块2（`s=3,r=17`）；
  - 去掉黑桃A（`s=0,r=14`）；
  - 保留红桃2（`s=1,r=17`）。
- 花色：0♠ 1♥ 2♣ 3♦（王 4 不出现）。
- 牌值编码复用 DouZero：3–14、17(=2)；无王。
- 牌面素材复用斗地主 `pages/table/static/cards/manifest.json`；不新增牌面。

### 5.2 发牌与人数

| 人数 | 每人张数 | 发法 | 扣牌 |
|---|---|---|---|
| 2 | 16 | 48 张洗牌分 3 份×16；seat0=第1份、seat1=第2份 | 第3份扣下 |
| 3 | 16 | 48 张洗牌后连续切 3 份 | 无 |
| 4 | 12 | 48 张洗牌后连续切 4 份 | 无 |

- 随机源可注入（`random: () => number`），测试确定性。
- **conformance 确定性通道**：`game.start` 增内部专用 `seed?`/`testDeck?`（仅
  `INTERNAL_TEST_HOOKS=1` 且 internal token；生产默认关闭，开启时日志/告警）。
  `pdk-driver` 用它构造固定手牌，不得 import `protocol/src/pdk/rule` 当裁判（要用独立 oracle）。
  `testDeck` 必须**恰 48 张、全部属于 pdk 合法牌集合、无重复**，否则 `10001`；
  不得把“牌堆错误”当成测试红。
- 2 人局扣下的 16 张存 `PdkSession.unusedCards`，**永不出站**；记录中可按需编码供审计。
- `initialHands` 快照按座位存发牌，供记录；2 人局不含扣牌。

### 5.3 先出牌与回合流转

**玩家可读规则**：

> 每局第一手，从红桃 3 开始，按红桃 3 → 红桃 4 → 红桃 5 → … → 红桃 K → 红桃 A → 红桃 2
> 的顺序，找到第一张在玩家手中的红桃牌，持有该牌的玩家先出。先出玩家可以出任意合法牌型，
> 不要求包含这张红桃牌。
> 2 人局若上述红桃牌全部在扣下的那份中（极端情况），由系统随机指定一名玩家先出。
> 每局第一手之后，由上一手最后出牌的玩家先出；若其余玩家都过牌，该玩家重新先出。

**代码口径**：

```ts
const HEART_LEAD_ORDER = [3,4,5,6,7,8,9,10,11,12,13,14,17] as const; // r；s=1
function resolveFirstLeader(session: PdkSession, random: () => number): number {
  for (const r of HEART_LEAD_ORDER) {
    const seat = session.players.findIndex(p => p.hand.some(c => c.r === r && c.s === 1));
    if (seat >= 0) return seat;
  }
  return Math.floor(random() * session.playerCount);
}
```

- 3/4 人局红桃3必在场上 ⇒ 总是红桃3持有者先出。
- 2 人局扣牌可能包含红桃3…红桃2；按序找第一张在场上者。
- 首出 `lastPlayedHand = null`，`canPass=false`；必须出牌。
- 跟牌可过；`consecutivePasses` 等于 `playerCount - 1` 时，`lastPlayedHand=null`、
  `currentPlayer=lastPlayerIdx`、`consecutivePasses=0`。
- 出牌后：`lastPlayedHand=解析结果`、`lastPlayerIdx=seat`、`consecutivePasses=0`、
  `currentPlayer=(seat+1) % playerCount`。
- 手牌出完 ⇒ 立即结束；不再询问其他玩家。

### 5.4 牌型

| 牌型 | 定义 | 比较键 | `length` 单位 | 默认 |
|---|---|---|---|---|
| 单张 | 1 张 | 点数 | 0 | 开 |
| 对子 | 2 张同点 | 点数 | 0 | 开 |
| 裸三张 | 3 张同点 | 点数 | 0 | 开（可配） |
| 三带一 | 三张+1 张不同点单牌 | 三张点数 | 0 | 开 |
| 三带二 | 三张+1 对（不同点） | 三张点数 | 0 | **关**（可配） |
| 四带二 | 四张+2 张带牌（默认必须不同点单牌） | 四张点数 | 0 | 开（可配） |
| 顺子 | ≥5 张连续单牌，3–A，不含 2 | 最大点数 | 张数 | 开 |
| 连对 | ≥2 个连续对子，3–A，不含 2 | 最大对子点数 | 对子数 | 开 |
| 裸飞机 | ≥2 个连续三张，3–A，不含 2 | 最大三张点数 | 三张数 | **关**（可配） |
| 飞机带翅膀 | 连续三张 + 同数量翅膀；翅膀默认对子 | 最大三张点数 | 三张数 | 开 |
| 炸弹 | 恰 4 张同点 | 点数 | 4 | 开 |

- **解析/比较签名**：`parsePdkHand(cards, rules)`、`canBeatPdk(candidate, target, rules)`；
  `rules` 来自 `PdkPlayerView.pdkRules` / `PdkRobotFeatures.pdkRules` 的本局快照。
  关闭某牌型后，客户端 hint 与 bot 都不得再产出该牌型（RH5）。

- **AAA 不是炸弹**：`parsePdkHand([A,A,A])` = 裸三张（或按配置无效）；`[A,A,A]+x` = 三带一。
- **KKKK 是最大炸弹**（四张 A 不可能：黑桃 A 已去掉）。
- 四张同点作为炸弹或四带二由玩家选择；只有**裸四张**计入炸弹数。
- 四带二带牌默认必须是不同点单牌；`fourWithTwoPairKickerAllowed=true` 时允许两张同点成对。
- 飞机翅膀的**无歧义口径**（H17）：
  - `pairs`（默认）：恰 n 个对子，对子点数两两不同，且都不属于主三张的点数集合；
  - `singles`：恰 n 张单牌，**点数两两不同**，且都不属于主三张的点数集合；
  - `both`：先按 `pairs` 解析，失败再按 `singles`；`wingMode` 是对比字段；
  - 因此第 4 个连续三张**不能被拆成单翅**：如 `333444555666` 在
    `bareAirplaneEnabled=false` 且 `airplaneWings='singles'/'both'` 时为非法，
    不得靠“拆第 4 个三张”凑翅膀；
  - 翅膀不能与三张同点；对子/单翅之间点数互不相同。
- 顺子/连对/飞机不能含 2；A 可作最高（如 10JQKA、QQKKAA；飞机带翅膀中如
  QQQKKKAAA + 同数量对子）。
- 炸弹可拆；没有“炸弹不得拆”的斗地主约束。
- **`keyRank` 口径**：顺子/连对/飞机一律取**最大点数**；不得复用斗地主
  `parseHand` 的“最小点数”口径（那是 ddz 的 `length`/比较约定，抄错会让 A 高顺子压不过 7 高顺子）。
- 解析优先级（避免同一手牌多解）：
  1. 4 张同点 ⇒ 炸弹；
  2. 6 张 = 四张 + 2 张带牌 ⇒ 四带二；
  3. 连续三张（含/不含翅膀）⇒ 飞机；
  4. ≥5 张连续单牌 ⇒ 顺子；
  5. ≥2 个连续对子 ⇒ 连对；
  6. 3+2 ⇒ 三带二（若开）；3+1 ⇒ 三带一；3 张同点 ⇒ 裸三张（若开）；
  7. 2 张同点 ⇒ 对子；1 张 ⇒ 单张。
- 比较：
  - 同牌型、同 `length`（顺子张数/连对对数/飞机三张数）才能比；
  - 主键大者胜；带牌不参与比较；
  - 炸弹压任何非炸弹；炸弹之间按点数比；没有王炸；
  - 飞机带单与飞机带对是不同形状，不能互压；`both` 模式下按 `wingMode` 区分。

### 5.5 出牌/过牌/胜负/保本

- 出牌先按 `(r,s)` 精确摘除；找不到 ⇒ 非法（`INVALID_CARDS`/`ILLEGAL_ACTION` 按映射）。
- `parsePdkHand` 返回 `Invalid` ⇒ 拒绝；再 `canBeatPdk` 判定。
- 过牌：首出不可过；跟牌可过；其余玩家都过后回到最后出牌者。
- 胜负：任一玩家手牌为 0 ⇒ 该玩家胜，`winnerSeats=[seat]`，`state=ended`，`finishedAt=now`。
- `remaining[i] = players[i].hand.length`；赢家为 0。
- `playedCount[i]` = 该座位实际打出的牌张数（不含过牌）；用于关牌。
- `baobenSeats` = 输家中 `remaining===1` 且 `baobenEnabled` 的座位。
- 2 人局：`playerCount=2`，输家 1 人；春天不适用。
- 4 人局：输家 3 人；春天 = 三名输家都 `playedCount===0`。

### 5.6 结算

配置快照（`PdkRulesConfig`）在开局时写入 `PdkSession.rules`。**类型在
`protocol/src/pdk/rules.ts`**（客户端 hint/bot 共用）；默认值与校验在
`shared/src/pdk/rules.ts`：

```ts
export interface PdkRulesConfig {
  bareTrioEnabled: boolean;
  trioWithPairEnabled: boolean;
  bareAirplaneEnabled: boolean;
  fourWithTwoEnabled: boolean;
  fourWithTwoPairKickerAllowed: boolean;
  airplaneWings: 'pairs' | 'singles' | 'both';
  bombMultiplierEnabled: boolean;
  guanMultiplierEnabled: boolean;
  springMultiplierEnabled: boolean;
  multiplierCap: number;
  baobenEnabled: boolean;
}
export const DEFAULT_PDK_RULES: PdkRulesConfig; // 与 §4.7.1 默认一致
```

结算：

```ts
const losers = allSeats.filter(s => s !== winnerSeat);
const guan = losers.some(s => playedCount[s] === 0);
const spring = playerCount >= 3 && losers.every(s => playedCount[s] === 0);
const bombFactor = rules.bombMultiplierEnabled ? 2 ** bombCount : 1;
const guanFactor = rules.guanMultiplierEnabled && guan ? 2 : 1;
const springFactor = rules.springMultiplierEnabled && spring ? 2 : 1;
const multiplier = Math.min(rules.multiplierCap, bombFactor * guanFactor * springFactor);

for (const s of losers) {
  const baoben = rules.baobenEnabled && remaining[s] === 1;
  delta[s] = baoben ? 0 : -(remaining[s] * baseScore * multiplier);
}
delta[winnerSeat] = -sum(delta[losers]); // 零和
```

- `bombCount` 只统计**裸四张炸弹**打出次数；AAA/四带二不计。
- `multiplierCap` 夹到 `1..1024`；默认 64。
- 春天成立时关牌也必然成立（多家未出 ⇒ 至少一家未出），公式按两项**叠乘**（春天 ×4）；
  运营若不想叠乘，关闭 `guanMultiplierEnabled` 或 `springMultiplierEnabled` 之一。
- 保本玩家付 0；其他输家照常乘倍数。
- `保本` 玩家付 0；若所有输家都保本，赢家所得为 0（settle-service 不产生货币条目，但记录照写）。
- `PdkSettlementResult` 带 `remaining`、`multiplier`、`bombCount`、`guan`、`spring`、`baobenSeats`、
  `winnerSeats`、`scoreChanges`。
- `SettleService` 用 `scoreChanges`；输光截断、抽水、residue、idempotent actionId 规则不变。
- 金币场余额广播 `game.balances` 长度 = `playerCount`。

### 5.7 超时/托管/机器人

- 超时/托管动作：
  - 首出：`chooseLeadPdk(hand, rules)`（当前实现为最小单张）；
  - 跟牌：`findSmallestBeatingPdk(hand, target, rules)`；有解则出，无解则过；
  - `rules` 恒取 `session.rules`（开局快照），不得用默认值。
- 复用挂机治理纯函数（`timeoutCount`/`trustee`/档位）；跑得快无叫抢，计时恒 play 档。
- 规则 bot：
  - 跟牌：`findSmallestBeatingPdk(hand, target, features.pdkRules)`；
  - 首出：`chooseLeadPdk(hand, features.pdkRules)`，策略层可优先长牌型；
  - 难度档位只影响策略随机性/是否保留炸弹；首版保持简单。
- 机器人返回的牌必须经服务端同一 `applyAction` 校验；被拒回退 autoplay，不得直接过。
- **关闭某牌型后，autoplay/bot 都不得产出该牌型**；补“关 `fourWithTwoEnabled`/`bareTrioEnabled`
  后超时与 bot 仍合法”的测试。
- `PdkRobotFeatures` 只含公开信息；`unusedCards`、他人手牌永不出站。

### 5.8 规则错误

- `parsePdkHand`/`canBeatPdk` 抛错或返回 `Invalid` 的每一处，都要在
  `game-service/src/games/pdk/rule-error.mapping.ts` 有映射行；
  `rule-error-mapping.test.ts` 的扫描面扩到 `shared/src/pdk`、`shared/src/core`、`protocol/src/pdk`。
- 跑得快收到 `game.bid` ⇒ `ILLEGAL_ACTION (13001)`；只有 `game.play`/`game.pass` 合法。
- 错误码沿用 `13001`/`13006`/`13009`/`13005`，不新增玩法专用码。
- 机器人决策失败沿用 `13008`（内部，不出站）。

### 5.9 规则文档

- 实现时新建 `docs/games/paodekuai.md`，至少包含：
  - 用牌/去牌/花色；
  - 2/3/4 人发牌与扣牌；
  - 先出牌规则（含 2 人局全扣随机）；
  - 全部牌型/比较/带牌配置默认值；
  - 过牌/胜负/保本；
  - 计分公式与配置项；
  - 超时/托管说明。
- `protocol-doc-sync`/规则文档测试：代码中的默认配置与文档表格一致。

---

## §6 测试判据

### 6.1 协议/契约

- `protocol` 测试：
  - `GAME_META` 两种玩法/人数/能力位；
  - `parseGameType` 缺省 vs 非法；
  - `DdzPlayerView` 新增字段后旧 JSON 兼容；
  - `PdkPlayerView` 长度/`canPass`/`winnerSeats` 校验；
  - `SettlementResult` 联合；**斗地主仍恰 9 键**；pdk 新向量；
  - `GameActionResponse`/`GameViewResponse` 为 `GameView`；
  - `game.finished` 联合；
  - 变长 `encodeHand/decodeHand`（16/12/17）；
  - 旧 `room.match`/`room.join` 缺省斗地主；
  - 错误码 `12012` 与 `CLIENT_ACTION`。
- `messages.test.ts` 的 11/12 计数与 `RPC_PATTERNS` 表不变（不新增消息/模式）。
- `protocol-doc-sync` 更新 `docs/client-protocol.md`。

### 6.2 共享规则

- `pdk/deck.test.ts`：48 张；被去掉的 6 张不在；红桃2在；无王；花色正确。
- `pdk/deal.test.ts`：
  - 3 人 16/16/16；4 人 12×4；2 人 16/16 + 16 扣牌；
  - 红桃3先出；红桃3被扣时红桃4/…/红桃2依次；
  - 所有红桃被扣（用 `testDeck`/固定牌堆构造，不靠概率）⇒ 注入随机源决定；
  - 注入随机源确定性。
- `pdk/rule.test.ts` 真值表：
  - 单/对/裸三/三带一/三带二（开/关）/四带二（带对开/关）/顺子/连对/裸飞机（开/关）/
    飞机带对/带单/两者/炸弹；
  - AAA 不是炸弹；KKKK 最大炸弹；四张 A 不存在；
  - 2 不进顺子/连对/飞机；A 可作最高；
  - 同型比较、炸弹压非炸弹、飞机翅膀形状不可互压；
  - 炸弹可拆。
- `pdk/play.test.ts`：
  - 首出不可过；跟牌可过；全过回到最后出牌者；
  - 精确摘牌；非法牌型/压不过/不是自己回合；
  - 出完即结束；`playedCount` 正确。
- `pdk/settle.test.ts`：
  - 默认全开公式；逐项关；封顶；保本；全保本赢家 0；
  - 2 人无春天；4 人春天；关牌；
  - 零和；`scoreChanges` 与 `remaining` 一致。
- `pdk/autoplay.test.ts`：
  - 首出最小单张；跟牌最小可压；无解返回 null；
  - 对炸弹/飞机/四带二的覆盖；
  - **炸弹可拆**（规则允许）：autoplay 的最小可压不因“四张”身份跳过拆分；
    策略层若要保留炸弹，必须另行实现且仍返回合法动作。

### 6.3 服务

- `game-service`：
  - `GameRegistry` 按 gameType 取 runtime；未知 ⇒ 响亮失败（`10001`/内部错误）；
    **不在 game-service 判“禁用”**（开关只在 room-service）。
  - 斗地主 golden：**S1 前在 dev/master HEAD 冻结** `PlayerView`/`SettlementResult` JSON；
    重构后剥掉约定新增字段逐字比较；加“改坏一个旧字段能红”的判别力自证。
  - 旧会话缺 gameType ⇒ 斗地主；pdk 字段缺 gameType ⇒ fail closed。
  - 跑得快：开局/出牌/过/**超时（首出最小单张、跟牌最小可压）**/托管/结算/记录/机器人；
  - 2/3/4 人会话；`buildAllViews` 遍历全部座位；视图裁剪（他人手牌、扣牌不出站）。
  - `game.start` 幂等：先比对 gameType/playerCount/rules，再早退。
- `room-service`：
  - **斗地主旧 3 段键、跑得快新 5 段键**；`queueKeyOfTicket` 统一取键；
    补“旧键票开局/cancel 不残留/重新 match 不双入队”端到端测试。
  - 2/3/4 人分组/窗口/补位；`handleMatch` 换玩法/换人数；`nonThreePlayerEnabled` 闸。
  - `RoomMeta` 旧形状 Hash 缺/非法 gameType 仍可读；`writeMeta` 不写 `"undefined"`；
    `RoomInfo.playerCount` 仍是当前占用。
  - REST `JoinRoomDto { gameType? }` + WS `room.join` + `room.matched` + 自动 join 的
    gameType 链路；旧客户端 REST 占 pdk 座负对照。
  - pdk 开局 strict/重试预算/`onSeats` 后置/不 `cancelIfStillWaiting`；
  - 记牌器能力位：跑得快不扣费。
  - `computeSettlement` 按玩法分支：ddz 旧公式、pdk `scoreChanges`；
    `resolveSeats`/`coversAllSeats` 按 playerCount，2/4 不静默跳过；
  - `record.moneyDelta` N 座 + outbox 带 gameType/playerCount（旧条目缺省）；
  - `SettleOutboxEntry` 带 gameType/playerCount，重发广播/回写不得缺省 3 座；
  - `game.balances` N 座 + 旧 gateway 3 条负对照。
- `robot-service`：
  - 池键规范/旧 ddz 双读；`BotInstance.gameType`；release 从 bot 记录推导；
    reclaim/list/poolSize 按玩法。
  - pdk bot 决策合法性/降级；availability 按玩法。
- `user-service`：
  - pdk 单独建表/写入/查询；斗地主表零迁移；
  - 旧客户端 `/api/records/mine` 无 gameType ⇒ 只读斗地主表；
  - pdk 记录详情/`unusedCards` 审计/`playedCount` 来源；moneyDelta N 座；
  - `RecordsCleanupService` 按 `ended_at` 清理 pdk 两表；`records_table_bytes` 含 pdk；
  - 回滚模拟：旧 user-service 不读 pdk 表、不报错。

### 6.4 客户端

- `gameModes`/大厅：两玩法、开关过滤、按玩法档位、切换回落。
- `room.match` 载荷带 gameType/playerCount；好友房 REST 带 gameType；
  **`loadRooms`/`GET /api/rooms` 带 activeMode**。
- 牌桌壳按 `resolveGameType(view)` 渲染对应 board；`DdzBoard` 迁移后以下测试全绿：
  11 个 `table-*` + `settlement-reveal`/`settlement-rematch`、`swipe-select`、
  `card-counter-*`、`hint-*`、`audio`、`landscape-*`。
- `PdkBoard`：首出/跟牌/过牌/提示/结算/剩余张数/倍数；`canPass` 控制按钮。
- `room.matched` 自动 join 发送 gameType；重启/重连按 `view.gameType` 恢复玩法。
- 旧客户端模拟：无 gameType 的 match/join/rooms 只走斗地主；REST join pdk 房不占座。
- `source-boundary`：pdk 牌型只在 protocol；客户端无本地规则实现。
- 历史页按玩法显示；旧客户端只读斗地主记录。
- **真浏览器**：斗地主回归（迁移前后）+ 跑得快（大厅切玩法→匹配→出牌/过牌→结算→重进）。

### 6.5 conformance

- `tools/conformance/src/lib/game-driver.ts` 抽象：建桌、驱动到结束、断言结算守恒。
- 保留 `ddz-driver.ts`；新增 `pdk-driver.ts`（3 人；开关打开时覆盖 2/4）。
- **pdk driver 的 oracle**：用 `game.start.seed/testDeck`（仅测试钩子）构造固定手牌；
  出牌/比较用独立 oracle 或手工脚本，**不得 import `protocol/src/pdk/rule` 当裁判**；
  判据不能只验“结算守恒”，至少覆盖固定手牌的牌型/比较/过牌/保本。
- 新增 slice `29-paodekuai`：匹配/建房/开局/首出/过牌/结束/结算/记录。
- **恰键集断言**：
  - **斗地主 `slice-10` 的 9 键结算、`slice-18` 的金币结算保持不变**（D7/D24）；
  - `slice-14` 19 键客户端配置、`slice-23` 19/51 键、`slice-24` 51 键按新增 pdk 键更新；
  - `slice-15` MyRecord 12 键（斗地主不变；pdk 记录另一形状/接口）；
  - `verify-admin-static` 的配置键计数；
  - pdk 新 slice `29` 的键集/结算/记录单独断言。
- `MATCH_BASE_SCORE` 从配置/玩法 driver 读取，不再写死 15。

### 6.6 门禁

- `pnpm -C packages/protocol test`
- `pnpm -C packages/shared test`（覆盖率 ≥80%）
- `pnpm -C packages/game-service test`
- `pnpm -C packages/room-service test`
- `pnpm -C packages/robot-service test`
- `pnpm -C packages/user-service test`
- `pnpm -C packages/config-service test`
- `pnpm -C apps/client test` + `pnpm -C apps/client run lint`
- `pnpm verify:admin`
- `pnpm exec turbo run test lint --force`（权威轮）
- `node scripts/browser-e2e.mjs`（斗地主回归 + 跑得快：大厅切玩法→匹配→出牌/过牌→结算→重进）
- 旧客户端/旧 gateway 兼容夹具（冻结旧校验器；双向对照）
- conformance 全量/对应 slice
- 配置键计数/IA/规则错误映射/源码边界/资产预算/文档同步门禁
- 工作区干净

---

## §7 错误处理与边界

### 7.1 错误码

- 新增 `12012 GAME_UNAVAILABLE`：玩法未开放 / 该人数不支持 / 客户端与房间玩法不符。
  `CLIENT_ACTION = TOAST`；message 区分三种原因。由 **room-service** 的 `DomainError` 产出
  （protocol 校验器只抛 `10001`）；`packages/room-service/src/http/errors.ts` 必须补
  12012 → HTTP 4xx 映射，避免 REST 建房/join 变 500。
- 其余沿用：`10001`（载荷非法）、`12001`（房间不存在）、`12004`（不在房）、
  `13001/13005/13006/13009`（动作/终局/牌/未开始）、`10007`（配置/上游不可用）。

### 7.2 边界表

| 场景 | 处置 |
|---|---|
| `room.match` 未知/缺失 gameType | 缺失 ⇒ 斗地主；未知 ⇒ `10001` |
| `gameType` 为空串 | 非法（`10001`）；只有 `undefined`/字段缺失算缺省 |
| 玩法关闭 | `12012`，不建队列票/房间 |
| `playerCount` 不在 `supportedPlayerCounts` 或 `nonThreePlayerEnabled=false` 且 ≠3 | `12012` |
| 旧客户端 REST/WS join 跑得快房 | `12012`，REST 在占座前拒绝、WS 不返回视图 |
| 新客户端 REST join | 必带 `JoinRoomDto { gameType }`；不带 ⇒ 斗地主，进 pdk 房 12012 |
| 旧票 cancel/probe | 用 `queueKeyOfTicket` 取旧 3 段键；不得重建新键 |
| 斗地主结算 | 恰旧 9 键，不新增 gameType/scoreChanges |
| pdk 结算 | `SettlementVector`（gameType/playerCount/winnerSeats/scoreChanges） |
| pdk outbox 重发 | 条目带 gameType/playerCount；不得缺省 3 座 |
| RoomMeta 写回 | `gameType ?? 'doudizhu'`；不得写字符串 `"undefined"` |
| `GET /api/rooms` 无 gameType | 只返回斗地主房 |
| 旧房间 Hash 缺 gameType | 读作 doudizhu，不视为坏房 |
| `game.start` gameType/playerCount/rules 与既有会话不符 | 拒绝（幂等只对同参数） |
| 旧会话缺 gameType 且有地主字段 | 按斗地主 |
| 旧会话缺 gameType 且有 pdk 字段 | fail closed（记录 + 拒服务） |
| 跑得快规则快照缺失/非法 | pdk 开局 `strict`：不 announce、不写 playing、留 waiting + ERROR；`10007` |
| 配置枚举非法 | `parseConfigValue` 拒绝；后台写入失败 |
| 2 人局所有红桃被扣 | 注入随机源指定先出；测试可复现 |
| 所有输家保本 | 赢家 0；不产生货币条目；记录照写 |
| 保本 + 翻倍 | 保本玩家 0；其他输家正常乘倍数 |
| 4 人局春天 | 三名输家都未出牌 ⇒ ×2（关牌同时成立 ⇒ ×4） |
| 2 人局春天 | 不适用 |
| 炸弹数超过 cap | `multiplierCap` 夹住 |
| 机器人无可用 | 不补位；真人等待/超时（沿用既有） |
| 跑得快记牌器 | 能力位 false ⇒ 不扣费、不下发入口 |
| 跑得快收到 `game.bid` | `13001` |
| 旧客户端收到新增字段 | 冻结旧校验器夹具证明可忽略；不以新校验器自证 |
| 旧 gateway 收到 pdk `game.balances` | 暗上线期间不暴露 pdk；gateway 升级后才开 |
| 配置窗口 | 斗地主仍用 `game.baseScoreLevels`（不迁移）；跑得快用 `game.levels.paodekuai` |

### 7.3 fail-safe 原则

- 玩法/会话识别**绝不**把未知当斗地主；只有**字段缺失**的旧载荷才缺省斗地主；
  空串/非法值一律报错。
- 跑得快内部字段（`unusedCards`、他人手牌、`initialHands`、`botId` 等）永不出站；
  出站校验机械拦截。
- 规则/配置错误在开局前暴露；不在牌局中途静默降级。
- 结算零和必须由测试断言；任何非零和视为阻断缺陷。
- 旧客户端兼容断言使用**冻结旧校验器/消息夹具**，不以新校验器自证；双向（旧×新、新×旧）
  都是发布门禁，不是“尽量兼容”。

---

## §8 风险

| 风险 | 级别 | 缓解 |
|---|---|---|
| 平台化重构破坏斗地主 | 高 | 斗地主 runtime 只做适配；S1 前冻结 golden JSON；S0/S1 可独立回滚，S2 按 §4.11 runbook |
| 旧客户端收到跑得快视图 | 高 | 房间列表/REST join/WS join 守卫 + 冻结旧客户端模拟测试 |
| REST join 无 gameType 形状 / 旧票 cancel 重建键 | 高 | `JoinRoomDto` + `queueKeyOfTicket`；旧票端到端测试 |
| 旧 gateway 拦截 pdk 消息 | 高 | api-gateway 进部署顺序；暗上线；旧 gateway 负对照 |
| pdk 记录打挂旧历史/回滚 | 高 | pdk 单独建表；旧查询默认斗地主；旧服务不读 pdk 表 |
| 协议变长数组破坏旧客户端 | 中 | 新增字段类型可选；斗地主仍 3 长度；冻结旧校验器测试 |
| 配置双真源/旧 admin | 中 | 斗地主继续用 `game.baseScoreLevels`；跑得快新键；不迁移/不双写 |
| 跑得快规则歧义 | 中 | 规则文档 + 真值表；飞机单翅/第 4 个三张已定死口径 |
| 2 人局扣牌/红桃3边界 | 中 | 专门测试；随机源/固定牌堆可注入；扣牌永不出站 |
| 2/4 人匹配写死 3 | 高 | 组大小/窗口/补位/结算/记录全参数化；开关默认只开 3 |
| 结算公式与保本/翻倍交互 | 中 | 公式表 + 逐项开关测试 + 零和断言 |
| 客户端拆壳回归面 | 中 | 先定 shell/board 边界；迁移清单含全部 table 相关测试；真浏览器回归 |
| 机器人太弱 | 低 | 首版规则 bot 可接受；后续另立 AI 片 |
| 管理面配置膨胀 | 低 | 按玩法 IA 分组；配置键门禁 |
| 未来麻将/德扑过度期待 | 中 | §4.12 明确“麻将需 orchestrator/room 生命周期改造”；德扑独立牌桌域 |

---

## §9 涉及文件

### protocol
- `src/game.ts`（新）、`src/views.ts`、`src/settlement.ts`（新）、`src/messages.ts`、
  `src/rpc.ts`、`src/validate.ts`、`src/config.ts`、`src/records.ts`、`src/robot.ts`、
  `src/errors.ts`、`src/pdk/{rule,rules}.ts`（新）、`src/index.ts`
- `test/*`（新增/更新）

### shared
- `src/core/{session,action,governance,timer}.ts`（新/迁移）
- `src/pdk/{deck,deal,types,play,settle,autoplay,features,rules}.ts`（新）
- `src/ddz/types.ts`（加 gameType/playerCount）、`src/ddz/governance.ts`/`timer.ts`（re-export）
- `src/index.ts`
- `src/**/*.test.ts`（新增/更新）

### game-service
- `src/games/{runtime,registry}.ts`（新）
- `src/games/ddz/{runtime,view,rule-error.mapping}.ts`（迁移）
- `src/games/pdk/{runtime,view,rule-error.mapping}.ts`（新）
- `src/game/game.service.ts`、`src/game/game.module.ts`、`src/game/view.builder.ts`、
  `src/game/dto.ts`、`src/game/rule-error.mapping.ts`、`src/rpc/*`
- `test/*`

### room-service
- `src/match/match.service.ts`、`src/rooms/rooms.service.ts`、`src/rooms/rooms.start.ts`、
  `src/rooms/rooms.dto.ts`、`src/rooms/rooms.controller.ts`（`JoinRoomDto`）、
  `src/rooms/rooms.autostart.ts`、`src/gateway/message.router.ts`、
  `src/gateway/ws.gateway.ts`、`src/currency/settle.service.ts`、`src/config/config-cache.service.ts`、
  `src/http/errors.ts`（12012 映射）
- `test/*`

### api-gateway
- `src/gateway/proxy.gateway.ts`（出站校验、`/ws/ddz` 命名空间、pdk 消息放行）
- `test/*`

### robot-service
- `src/robot/robot.pool.ts`（`BotInstance.gameType`、按玩法回收）、`src/robot/bot.player.ts`、
  `src/robot/bots/ddz.ts`（新）、`src/robot/bots/pdk.ts`（新）、`src/robot/robot.service.ts`、
  `src/config/config-cache.service.ts`
- `test/*`

### user-service
- `src/migrations/*PdkRecords*`（新表，不改斗地主表）、`src/rpc/record.rpc.controller.ts`、
  `src/records/records.service.ts`、`src/records/records.controller.ts`、
  `src/records/records-cleanup.service.ts`（pdk 保留期/指标）、记录 DTO
- `test/*`

### config-service
- `src/migrations/*MultiGame*`（新迁移）、`src/config/platform-config.service.ts`、
  `src/config/client-config.controller.ts`
- `test/*`

### admin
- `admin/app.js`、`admin/index.html`

### client
- `src/gameModes.ts`、`src/stores/game.ts`、`src/net/*`、`src/pages/lobby/lobby.vue`、
  `src/pages/game/game.vue`、`src/pages/table/table.vue`、
  `src/components/table/ddz/DdzBoard.vue`（新）、`src/components/table/pdk/PdkBoard.vue`（新）、
  `src/components/*`（Seat/Settlement/音效适配）、`src/pages/history/history.vue`、
  `src/router.ts`、`src/pages.json`
- `test/*`

### conformance / scripts / docs
- `tools/conformance/src/lib/{game-driver,ddz-driver,pdk-driver}.ts`、`src/slices/29-*`、
  `src/slices/{10,14,15,18,19,23,24}-*`（恰键集/配置键/MyRecord/结算断言）、`baselines.json`
- `scripts/verify-admin-static.mjs`（配置键计数/IA）、`scripts/browser-e2e.mjs`（pdk 场景）
- `docs/games/paodekuai.md`（新，规则唯一来源）、`docs/client-protocol.md`、
  `docs/design.md` §11.2（12012）、`docs/appendix/platform-roadmap.md` §2.2、
  `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P4′

---

## §10 审查记录

### 10.1 第一轮独立对抗审查（2026-10-23）

- 审查员：独立 subagent（未参与设计），读 spec + 真实代码后反向攻击。
- 结论：**v1.0 不能直接进入实现计划**；5 个阻断 + 25 个高 + 15 个低。
- 处置：v1.1 已逐项修订；处置如下。

#### 阻断项

| # | 缺陷 | 处置（v1.1） |
|---|---|---|
| B1 | 新字段在类型上必填，违反 K3；新校验器会拒绝旧服务消息 | 新增字段全部改为**过渡期可选**；`resolveGameType` 只有字段缺失才缺省；§4.5.1/§4.5.2/§4.5.4；D23 冻结旧校验器 |
| B2 | 跑得快记录无数据模型，混表会打挂旧历史/回滚 | D11 + §4.9：**pdk 单独建表**；旧查询默认斗地主；moneyDelta 分支；`unusedCards` 审计列 |
| B3 | `RoomInfo.playerCount` 被重定义为容量，破坏旧房态 | §4.6.2：**保持 `playerCount` = 当前占用**；容量用 `maxPlayers`；只新增 `gameType?` |
| B4 | 旧队列键能解析但 process/fail/cancel 重建新键，旧票永不匹配 | §4.6.1：扫描器**透传实际 key**；加旧键开局/12007/cancel 端到端测试 |
| B5 | `room.join` gameType 链路未闭合（REST 无守卫、room.matched 不带、自动 join 不传） | §4.5.3/§4.6.2/§4.10.1：REST+WS 双守卫、`room.matched` 带 gameType/playerCount、自动 join/重连全链路 |

#### 高优先级项

| # | 缺陷 | 处置（v1.1） |
|---|---|---|
| H1 | `readMeta` 严格字段会让旧房间消失 | §4.6.2：缺失 gameType 容错为 doudizhu + 旧形状测试 |
| H2 | 2/4 人匹配写死 3 | §4.6.1：组大小/窗口/补位参数化；`nonThreePlayerEnabled=false` 首版只开 3；2/4 测试 |
| H3 | `handleMatch` 换队判定忽略 gameType/playerCount | §4.6.1：`sameDimensions`/探测键加两维 |
| H4 | `game.balances` 无法按人数校验；旧 gateway 只认 3 | §4.5.2/§4.6.3：载荷带 gameType/playerCount；gateway 升级后才开 pdk |
| H5 | pdk `game.finished` 仍发地主形状 | §4.6.3：按 `'gameType' in result` 分支，pdk 发 winnerSeats |
| H6 | `record.moneyDelta` outbox 无 playerCount，重发被拒 | §4.9.2：outbox 带 gameType/playerCount，旧条目缺省 ddz/3 |
| H7 | SettleService 3 座守卫让 pdk 2/4 静默不结算 | §6.3：按 playerCount 参数化；2/4 金币结算测试 |
| H8 | pdk 规则失败仍写 playing（N36 假开局） | §4.6.3：规则先读、pdk strict、失败留 waiting、不 announce |
| H9 | 基类缺 botIds/skillLevels/thinkingSpeeds/initialHands | §4.4：这些服务端字段进基类；pdk 机器人/记录测试 |
| H10 | game-service 无 config 依赖，无法判“禁用” | §4.3：开关只在 room-service；game-service 只校验已知玩法/人数 |
| H11 | conformance 恰键集断言与“baseline 不变”冲突 | §6.5：逐条更新 10/14/15/18/19/23/24/29 与 admin 计数 |
| H12 | golden 回归会变成快照自证 | D18/S0/S1：重构前冻结 JSON + 剥新增字段比较 + 判别力自证 |
| H13 | 旧客户端兼容测试用新校验器，假绿 | D23/§4.5.4：冻结旧校验器/夹具；旧×新、新×旧双向 |
| H14 | 旧 admin 写旧档位键、新读新键 ⇒ 静默无效 | D8：斗地主继续以 `game.baseScoreLevels` 为真源；不迁移/不双写 |
| H15 | 回滚承诺不成立（pdk 记录/会话/队列/机器人） | §4.11：明确回滚边界 + runbook + 演练 |
| H16 | api-gateway 不在接触面/部署顺序，会拦 pdk 消息 | §4.11/§9：加入部署顺序/文件/负对照 |
| H17 | 飞机单翅/第 4 个三张多解；keyRank 可能抄错 | §5.4：单翅点数两两不同、不得拆第 4 个三张；keyRank 取最大点数；解析优先级 |
| H18 | 机器人池 release/reclaim 缺可靠 gameType | §4.8：`BotInstance.gameType`；release 从记录推导；回收按玩法 |
| H19 | 新客户端 pdk 房间列表不带 gameType | §4.10.1：`loadRooms`/`rest.rooms(gameType)` |
| H20 | DdzBoard 迁移回归面低估 | §4.10.2：先定 shell/board 边界；全部 table 相关测试 + 真浏览器 |
| H21 | pdk conformance driver 无独立 oracle/固定牌堆 | §5.2/§6.5：`seed/testDeck` 测试钩子 + 独立 oracle |
| H22 | 无 pdk 真浏览器用例 | §6.6：pdk 浏览器场景 |
| H23 | `buildAllSeatViews/SEATS/assertSeat(0..2)` 仍 ddz 专用 | §4.3：`buildAllViews`/playerCount 校验 |
| H24 | 麻将扩展估计不足；德扑 room 复用过乐观 | §4.12：麻将标中低适配、需 orchestrator/room 生命周期；德扑不复用 room |
| H25 | GameService 仍有 ddz 专用分支（超时等） | §4.3：S1 替换点机械清单 |

#### 低优先级项

| # | 缺陷 | 处置 |
|---|---|---|
| 1 | parseGameType 空串语义矛盾 | 只有 `undefined` 缺省；空串非法 |
| 2 | protocol 校验器无法产出 12012 | 由 room-service `DomainError` 产出；补 HTTP 4xx 映射 |
| 3 | “四个翻倍键”与三键不符 | 改为三个翻倍键 + 封顶 + 保本 |
| 4 | 写了不存在的 `game.matched` | 改为 `room.matched` |
| 5 | game-service dto 重复类型 | 删除重复，统一 protocol |
| 6 | FORBIDDEN 未含 lastPlayedHand/rules | 已加入 |
| 7 | GameMeta.turnDurationMs 第二真源 | 删除，沿用治理档位 |
| 8 | matchQueueLength 标签缺玩法 | 增加 game_type/player_count |
| 9 | S3 依赖 S1 基类 | 切片表写明依赖 |
| 10 | “所有红桃被扣”难构造 | `testDeck` 固定牌堆 |
| 11 | 开关关闭后等待中 pdk 房 | 明确允许开完 |
| 12 | levelNameFor/台费仍读旧档位 | 按 gameType 取表 |
| 13 | pdk 复用 ddz buildRecordEnvelope 会抛 | runtime.buildRecord 唯一入口 |
| 14 | settle outbox 与 record money outbox 混淆 | 分别处理，均带 gameType/playerCount |
| 15 | startGame 幂等早退在参数校验前 | 先比对参数再早退 |

### 10.2 第二轮复审（2026-10-23）

- 复审员：同一独立 subagent，只验证修订是否闭合 + 新问题。
- 结论：B1/B2 方向/B3 已闭合；**RB1、RB2 仍未闭合**；另有 RH1–RH6、N1–N6。
- v1.2 处置：

| # | 缺陷 | 处置（v1.2） |
|---|---|---|
| RB1 | REST join 没有 gameType 请求形状，新客户端进不了 pdk 好友房 | §4.5.3/§4.6.2：`JoinRoomDto { gameType? }`；`rest.joinRoom(code, gameType?)`；占座前校验 |
| RB2 | `cancelQueue`/`handleMatch` 探测仍重建新键，旧票可重复/幽灵 | §4.6.1：**斗地主恒旧 3 段键、跑得快新 5 段键**；`queueKeyOfTicket` 统一取键；换队先 cancel 旧票 |
| RH1 | pdk 记录缺 `unusedCards`/`playedCount` 来源与保留期清理 | §4.3/§4.5.3/§4.9：信封加 `playedCount`/`unusedCards`；DDL 加 `ended_at`；cleanup/metrics 覆盖 pdk |
| RH2 | `SettleService` 三座守卫未在正文落 | §4.9.2：`resolveSeats`/`coversAllSeats` 按 playerCount |
| RH3 | pdk strict × `onSeats`/`cancelIfStillWaiting` 会人票两空 | §4.6.3：`onSeats` 后置、失败不 cancel、`start_attempts` 重试预算、warning |
| RH4 | S0–S2 可独立回滚不成立 | §4.11：S0/S1 可回滚；S2 需排空+迁回机器人池；pdk 另列 runbook |
| RH5 | rules 快照没送到 `parsePdkHand`/hint/bot | §4.5.1/§4.8/§5.4/§5.6：`PdkRulesConfig` 进协议；视图/特征带 `pdkRules`（避开禁出站 `rules`）；解析/autoplay 签名带 rules |
| RH6 | `seed/testDeck` 没进 `CreateGameInput` | §4.3：`CreateGameInput` 增 `seed?/testDeck?`；startGame 透传 |
| N1 | ddz 9 键 vs 新增结算字段矛盾 | D7/§4.5.2：**ddz 保持旧 9 键**，pdk 用 `SettlementVector`；SettleService 按玩法分支 |
| N2 | `SettleOutboxEntry` 无 gameType/playerCount | §4.5.2/§4.9.2：outbox 带两字段，重发广播/回写从条目取 |
| N3 | `RoomMeta.gameType` 可能写 `"undefined"` | §4.6.2：`writeMeta` 写 `?? 'doudizhu'`；`readMeta` 容错 |
| N4 | `buildAllViews` 未进接口 | §4.3：已加入接口代码块 |
| N5 | `GameActionResponse` 仍是 `PlayerView` | §4.5.3：改为 `GameView` |
| N6 | pdk 记录 `played_count`/`unusedCards` 字段缺口 | 同 RH1：已补信封/请求/DDL |

### 10.3 第二轮复审结论

- 第二轮阻断项 RB1/RB2 已在 v1.2 闭合；RH1–RH6、N1–N6 已写入设计正文或测试判据。
- 剩余为**实现期必须遵守的机械清单**（§4.3 替换点、§4.6.1 `queueKeyOfTicket`、§4.9 记录分支、
  §4.11 回滚 runbook），不再有设计层面的未决项。
- 进入实现计划；计划阶段需把这 14 条作为“计划审查”的必查项。

### 10.4 第三轮终审（2026-10-23）

- 终审员：同一独立 subagent，只验证 v1.2 的 RB1/RB2/RH1–RH6/N1–N6。
- 结论：上述主体闭合；新增 **PB1（阻断）** 与 RH3-a–e / RH4-a / RH5-a / N1-a–b /
  RH1-a–b / N3-a / RH6-a。
- v1.3 处置：

| # | 缺陷 | 处置（v1.3） |
|---|---|---|
| PB1 | `PdkPlayerView.rules` 必填，但 `rules` 在 `FORBIDDEN_OUTBOUND_KEYS` 中 ⇒ pdk 视图全被拦 | 字段改名 **`pdkRules`**（视图/特征均改），`rules` 继续禁出站 |
| RH3-a | `onSeats` 后置会留下“已开局但票未删”的并发重复匹配窗口 | §4.6.1：**所有模式** `match:claim` 占用；扫描跳过 claim；补并发测试 |
| RH3-b | warning 无事件形状/发送点 | §4.6.3：`MatchEvent.system_warning{playerIds,code,message}`；`onMatchEvent` 定向 emit |
| RH3-c | `startRoom/startGroup` 返回 boolean，无法区分可重试/致命 | §4.6.3：`'started'|'retryable'|'fatal'`；只有 fatal 才 `cancelIfStillWaiting` |
| RH3-d | `start_attempts` 未入 `deleteRoom` | §4.6.3：TTL + `deleteRoom` 删除集 |
| RH3-e | “规则失败不 announce”与 announceFirst 表述冲突 | §4.6.3：顺序固定为读规则 → announce → game.start |
| RH4-a | §8 仍写 S0–S2 可独立回滚 | §8：S0/S1 可独立；S2 按 §4.11 runbook |
| RH5-a | `findSmallestBeatingPdk` 不带 rules | §5.7：`findSmallestBeatingPdk/chooseLeadPdk` 带 rules；超时/托管/bot 全传快照 |
| N1-a | ddz `game.finished` 两处形状不一致 | §4.6.3：ddz 保持旧 `{winner}`；pdk 才带 gameType/winnerSeats |
| N1-b | `result.gameType` 在 Ddz 上不存在 | §4.5.2/§4.6.3：`'gameType' in result` 类型守卫 |
| RH1-a | pdk 父表缺 `ended_at` 索引 | §4.9.1：`idx_pdk_ended_at` |
| RH1-b | pdk 记录校验漏 `playedCount` | §4.9.2：非负且 = 初始手牌 − remaining |
| N3-a | `META_FIELDS` 未明写加 gameType | §4.6.2：`META_FIELDS` 增 gameType + 往返测试 |
| RH6-a | `testDeck` 无合法性校验 | §5.2：恰 48 张/pdk 合法集/无重复，否则 10001 |

### 10.5 终审结论

- PB1 与 RH3-a–e/RH4-a/RH5-a/N1/N3/RH1/RH6 已在 v1.3 写入设计正文。
- 设计层面无剩余未决项；以下作为**计划审查必查项**：
  1. `pdkRules` 字段名与出站禁键的机械闸；
  2. `match:claim` 全模式占用与并发扫描测试；
  3. `startRoom` 三态返回与 `startGroup` 取消条件；
  4. `queueKeyOfTicket` 覆盖 cancel/probe/fail；
  5. ddz 9 键结算/`game.finished` 旧形状的 golden 回归；
  6. pdk 记录 cleanup/playedCount/unusedCards；
  7. autoplay/bot/hint 全部用 `pdkRules`；
  8. 回滚 runbook 的 ddz 机器人池与 pdk 数据清理。
- **可进入实现计划。**
