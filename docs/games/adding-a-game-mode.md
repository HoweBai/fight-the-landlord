# 新增玩法接入指南（跑得快经验修订版）

> 截至 **2026-10-28** 的平台现状。代码会演进，开工前请先复核本文标注的“残留点”。
> 用途：第 3 个及以后玩法（麻将/德州/其他）的接入 checklist 与平台就绪审计。
> 规则口径仍以 `docs/games/<game>.md` 为唯一真源；开发流程见 `docs/dev-process.md`。

## 0. 先给结论

平台化资产是真的，但**“新玩法只填插件”不成立**。第三个玩法的真实成本 =
纯规则插件 + 协议联合扩展 + 跨服务分支 + 配置/运维面。开工前先做“平台就绪审计”，
比直接写玩法更重要。

## 1. 哪些真的通用，哪些仍要手工扩

| 层 | 状态 | 新玩法要做什么 |
|---|---|---|
| game-service 内核（会话/Redis/CAS/计时/事件/机器人驱动） | ✅ 通用 | 只注册 runtime |
| room-service 匹配/房间/开局/机器人池 | ✅ 基本通用 | 队列键、人数、配置键按玩法参数化 |
| currency 结算/outbox/对账 | ✅ 通用 | 结算结果与分配器要扩展 |
| 客户端 table 壳 | ✅ 通用 | 新增 board、历史/结算分支、资产 |
| 纯规则（`shared/<game>/`） | ✅ 插件 | 牌堆/发牌/牌型/回合/结算/autoplay |
| `AnyGameSession` / `GameView` / `GameAction` / `SettlementResult` / `RecordEnvelope` | ❌ **封闭联合** | 每加一个玩法都要手工扩 |
| gateway finished payload、user-service 记录分支 | ❌ 仍有形状分流 | 第 3 玩法前必须收口 |
| 配置键/种子/admin/指标标签/告警/conformance 键集 | ❌ 每玩法一套 | 机械闸要同步 |

## 2. 经验条目（修正版）

1. **规则文档是唯一真源**：先改 `docs/games/<game>.md`，再用 doc-sync 测试锁住代码。
2. **纯函数先行**：牌堆/发牌/牌型/比较/回合/结算/autoplay 全部无 Nest/Redis/UI 依赖；
   用固定牌堆和真值表测试。
3. **能力位不是开关**：目前只有 `cardCounter` 有真实消费方
   （`rooms.start.ts` 的 `GAME_META[gameType].capabilities.cardCounter`、
   `game.vue` 的同名判断）；`goldRoom` / `bots` / `voiceAnnouncements` 仍是声明态。
   新玩法要么接消费点，要么别写进“能力位决定”。
4. **`gameType` 显式贯穿，禁止靠结果形状猜玩法**：结算主路径已按 `room.gameType`；
   但 `ws.gateway.ts` 的 `game.finished` payload 与 `record.rpc.controller.ts` 的
   `persist()` 仍按 `isPdkSettlementResult(result)` 分流。第 3 玩法前先改成
   `room.gameType` / `req.gameType` 权威分流，形状只做一致性校验。
5. **单一真源要编译期兜底**：`GAME_TYPES` 放零依赖叶子模块，`GameMeta` 用
   `Record<GameType, GameMeta>` 强制补元数据；`validate.ts` 直接引用同一元组。
6. **`playerCount` 参数化，但默认值是旧兼容不是新玩法捷径**：`?? 3` 仍出现在
   `settle.service.ts` 与 `ws.gateway.ts` 的旧 outbox/记录路径。新记录/outbox 必须
   显式带 `gameType` + `playerCount`；内部新代码不要依赖 `?? DEFAULT_GAME_TYPE`。
7. **视图投影独立**：只有自己的手牌明文；扣牌/底牌/规则态/机器人内部字段永不出站。
   新玩法先写“禁出站键”清单，再写 view builder。
8. **托管/超时/机器人共用同一决策函数**：跑得快曾有两套 `autoAction`，抽成
   `decidePdkAutoAction` 后行为才一致。新玩法从第一天就只留一个决策入口。
9. **组合型逻辑用差分测试**：提示枚举曾用“1..12 + 特判 15”，改为按点数多重集枚举后
   用 `2^16` 全子集暴力对拍，既补 14/16 张漏牌，又消除 6.5 万组合。
   凡“枚举候选”类逻辑都值得这样做。
10. **资金/记录 fail-closed**：缺座、形状不符、`gameType` 不符一律 drop/告警，
    不静默按 0；outbox + 对账是标配。结算分配器要泛化成“逐座向量”，
    不能只留 ddz/pdk 两路分支。
11. **客户端不实现规则裁决，但 hint 枚举仍是客户端逻辑**：提示/校验走 protocol parser，
    候选生成与排序要单独设计；规则文案必须从规则文档派生或加断言，
    不能复制斗地主文案。
12. **暗上线矩阵**：`enabled` / `freeRoom` / `goldRoom` / `friendRoom` / 2·3·4 人
    分别测开启与禁用态；只测开启态会漏掉门控 bug。
13. **观测/风控是玩法的一部分**：指标打 `game_type` 标签、告警族、按人数风控分桶、
    自动限流阈值、记录↔资金对账；不要等上线后补。
14. **Conformance 先分诊**：先看栈健康与**第一个失败切片**；早期切片超时会让后面切片
    “缺席”，不能直接冲后面的 C2/资金断言。
15. **工具链升级单独做**：uni-app 锁 Vite、Vitest 大版本升级这类事和新玩法混在一个切片，
    排查成本会翻倍。

## 3. 新玩法接入清单（按真实改动面）

**Phase 0 适配性判断**：当前内核假设“单 `currentActor`、固定座位、一局一结算”。
麻将/德州的多窗口下注、边池、多手牌要先扩内核，不是加 runtime。

**Phase 1 协议**：`GAME_TYPES/GAME_META`、人数、能力位、错误码、配置键命名空间、
**联合类型扩展**（`GameView` / `GameAction` / `SettlementResult` / `RecordEnvelope`）、
view 禁出站键、validator。

**Phase 2 纯规则**：牌堆/发牌/牌型/比较/回合/结算/autoplay；固定牌堆 + 真值表 +
doc-sync + 差分测试。

**Phase 3 game-service**：runtime 全接口、registry、`AnyGameSession` 扩展、view builder、
record envelope、超时/托管/机器人驱动。

**Phase 4 room-service**：队列键/匹配人数、房间 meta、开局链、机器人池、台费/门槛/抽水、
结算向量、outbox、风控分桶。

**Phase 5 user/currency/admin**：新表或 `game_type` 列、迁移/回填、清理任务、对账、
玩家统计、财务 `byGame`、配置种子/admin 文案/权限审计。

**Phase 6 client**：`gameModes`、active mode、table 壳 + 新 board、历史/结算、hint、
图标/音效/语音、能力位门控。

**Phase 7 门禁**：单测、golden 旧玩法、conformance slices、browser e2e、admin 静态闸、
配置键计数、迁移 up/down。

**Phase 8 灰度/回滚**：开关矩阵、旧会话归一化、旧记录双读、回滚手册、outbox 重放。

## 4. 红线（最容易重犯）

- 第二真源：本地 `GAME_TYPES` 副本、规则文案复制、autoplay 双实现、客户端自制规则。
- 形状猜玩法：第 3 玩法复用向量形状就会走错记录/结算分支。
- 默认值静默落 ddz：`?? DEFAULT_GAME_TYPE`、`?? 3` 只允许旧客户端/旧条目兼容。
- 静默降级：结算缺座 `??0` 免付、房间 TTL 双读、BIGINT 数字串 `Invalid Date`。
- 边界层信任客户端：HTTP 传 `roomCode` 覆盖房间 meta；controller 必须显式白名单。
- 配置热更新与重试耦合：`startGame` 用 rules 全量 JSON 判幂等，配置一变就 12012。
- 客户端“看起来像”就复制斗地主：文案、牌型、记牌器；用能力位和 parser 隔离。
- 工具链升级夹带进玩法切片。

## 5. 开第 3 玩法前的平台就绪审计

1. 清掉 `ws.gateway` finished payload 与 `record.persist` 的形状分流。
2. 把 `AnyGameSession` / `GameView` / `GameAction` / `SettlementResult` / `RecordEnvelope`
   的扩展步骤写成文档模板。
3. 给 `?? 3` / `?? DEFAULT_GAME_TYPE` 加 `gameType` 守卫，或在新代码里改成必填。
4. 明确能力位的真实消费点；没有消费方的位不要宣传成“门控”。
5. 把结算分配器泛化成通用逐座向量。
6. 先跑一次栈健康与 conformance 分诊，确认基线不是红的。

## 6. 流程

按 `docs/dev-process.md`：spec（含“不做清单”）→ 设计对抗审查 → plan → 计划对抗审查 →
TDD → 代码审查 → 全量验证 → 权威轮。每个切片独立可回滚；conformance 当“新玩法毕业考”。
