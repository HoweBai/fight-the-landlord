# 跑得快审查问题修复设计（P0–P2）

- 日期：2026-10-27
- 状态：待对抗审查
- 输入：2026-10-27 跑得快整体审查的 13 项发现（P0 4 / P1 4 / P2 5）
- 范围裁决：用户选择 **P0–P2 全修**（不含 C3 资金异常检测等新增功能）

## 1. 背景与问题

跑得快（pdk）已合入 `dev` 并部署测试服，但审查发现 13 项缺陷，其中 P0 涉及金币损失、托管失效、
机器人池泄漏与玩家规则误导；P1/P2 涉及记录误报、开局重试卡死、结算分流、牌堆校验、提示漏牌与
结构性双真源。本片只修这些既有缺陷，不改变任何玩法规则、协议形状或配置键。

## 2. 范围

### 做

| 级别 | # | 缺陷 | 一句话修法 |
|---|---|---|---|
| P0 | 1 | `POST /api/rooms` 接受客户端 `roomCode`，可覆盖存活房 meta | HTTP DTO 删除该字段 + controller 显式白名单；service 保留测试缝但校验格式/冲突 |
| P0 | 2 | pdk 会话重载后 `trustees` 恒 false | `botIds` 归一化提前到 pdk 早退之前；视图谓词改“有效字符串” |
| P0 | 3 | 机器人恢复漏传 `gameType` | `recoverBotBindings` 增参并透传 |
| P0 | 4 | 大厅跑得快规则文案整段是斗地主 | 按 `docs/games/paodekuai.md` 重写 |
| P1 | 5 | 首出提示漏 14/16 张组合 | 结构化生成替代子集暴力枚举 |
| P1 | 6 | pdk BIGINT `ended_at` 数字字符串误报 | 数字字符串按 epoch ms 解析 |
| P1 | 7 | `startGame` 用 `JSON.stringify(rules)` 判幂等，配置热更新导致 12012 | 已有会话忽略 rules 差异，仅 WARN；保留玩法/人数校验 |
| P1 | 8 | `computeSettlement` 按结果形状而非 `room.gameType` 分流，缺座静默 0 | 入参加 `gameType`；形状/座位不完整则 dropWarn，不写钱 |
| P2 | 9 | `testDeck` 放行 NaN/小数 | `Number.isInteger` 校验 |
| P2 | 10 | `autoAction` 与 `handlePdkTimeout` 双实现 | 抽 shared 单一决策函数 |
| P2 | 11 | 局终同一房间 `findOne` 两次 | 复用首次读取；仅首读为 null 时兜底重读 |
| P2 | 12 | `validate.ts` 自建 `KNOWN_GAME_TYPES` | 抽无依赖叶子模块 `game-types.ts`，单一真源 |
| P2 | 13 | `PdkBoard` 提示候选每次视图变化全量重算（~55ms） | 结构化生成后候选数骤降；加确定性上界测试（不测耗时） |

> 编号 9–13 与审查报告顺序对应；#5 与 #13 同属提示模块，分两个任务实现（先正确性、后性能）。

### 不做

- 不新增 C3 资金异常检测、排行榜、记牌器、回放、聊天等产品功能。
- 不改跑得快规则、配置键、协议消息形状、结算公式。
- 不改斗地主玩家可见行为（除共享代码必须的等价重构）。
- 不调整金币场/2–4 人开关默认值。

## 3. 决策表

| # | 决策 | 备选 | 结论与理由 |
|---|---|---|---|
| D1 | `roomCode` 入口处置 | A 保留并加格式/存在性校验；B 仅好友房允许；C 从 HTTP DTO 删除 | **C**。客户端与 conformance 零调用点，HTTP 无合法用途；仅移除 DTO 不够（controller 测试手搭 server 绕过 ValidationPipe），controller 必须显式白名单构造入参。service 保留 `roomCode?` 作为内部/测试缝；只校验“非空、≤32、不含 `:`/空白、未占用”，**不强制 6 位格式**（既有 8 处夹具用 `ROOM1`/`PDK1`/`ROOM10N` 等短码，强格式会误伤） |
| D2 | `roomCode` 冲突错误 | 新错误码 / 12001 / 10001 | 用 `10001 BAD_PARAM`。该路径仅内部/测试可达，不新增协议错误码 |
| D3 | `botIds` 归一化位置 | A pdk 分支内重复一遍；B 提到公共前缀 | **B**。`botIds` 是两种玩法公共基类字段，纯 map；提前后 pdk 坏形状会 fail-closed 为 null，可接受。视图谓词同步改 `typeof === 'string' && length > 0` 双保险 |
| D4 | 规则快照幂等 | A 规范化深比较；B 已有会话忽略 rules 差异 | **B**。规格 D19 已定“局中改配置不影响在途局”；roomCode 一局一码，`playing` 房不会重开。保留 `gameType/playerCount` 不同即 12012，rules 差异仅 WARN |
| D5 | 结算形状校验位置 | A 只在 `computeSettlement` 抛；B 先在 `settleInner` drop | **B + A**。`settleInner` 先做严格形状/座位完整性守卫并 `dropWarn`（不写钱、不重试）；`computeSettlement` 仍按 `gameType` 分流并对非法输入抛错，保持纯函数可独立复用 |
| D6 | pdk 结算缺座 | 静默 0 / 抛错 / drop | **dropWarn**。缺座属于结果损坏，免付会让输家白逃；drop 后由现有告警/对账发现，绝不静默结算 |
| D7 | 提示候选生成 | A 只补 14/16 特判；B 结构化生成 | **B**。A 只解决漏牌，55ms 全量枚举仍在；结构化生成同时解决正确性与性能，并用差分测试证明与暴力枚举等价 |
| D8 | `autoAction` 抽取位置 | shared/pdk/autoplay.ts / play.ts / game-service | **autoplay.ts**。它已持有 `chooseLeadPdk`/`findSmallestBeatingPdk`；只返回 `GameAction`，不落状态。`play.ts` 与 `runtime.ts` 各自保留守卫后调用，依赖方向不变 |
| D9 | `ended_at` 解析 | 各服务各写 / 抽公共包 | 本片在 user-service 内加私有 helper（与 `records.service.ts:bigintMs` 同口径）。跨服务抽公共包属更大重构，登记不做 |
| D10 | 局终双读 | A 完全合并（首读失败则记录也跳过）；B 正常路径复用、null 时兜底重读 | **B**。保持现有“首读失败仍可写记录”的降级行为，正常路径只读一次 |
| D11 | `GAME_TYPES` 单一真源 | A `satisfies Record<GameType,true>` 本地对象；B 抽无依赖叶子模块 | **B**。`game.ts` 与 `validate.ts` 有运行时环（`game.ts` 值导入 `ProtocolError`），只能抽叶子；`game.ts` re-export 保持 API。新增玩法只改 `game-types.ts` + 必填 `GAME_META`，validate 自动跟随 |
| D12 | 分支与提交 | 直接 dev / feature 分支 | 从 `dev` 开 `fix/pdk-review-findings`，三个切片各自小步提交；完成后按用户指示合回/推送 |

## 4. 实现设计

### 4.1 T1 `roomCode` 入口收口（P0）

- `rooms.dto.ts`：删除 `roomCode` 字段。
- `rooms.controller.ts` `create()`：不再把 `dto` 原样透传，显式构造
  `{ mode: dto.mode, baseScore: dto.baseScore, gameType: dto.gameType, playerCount: dto.playerCount }`。
  这样即使测试/旧客户端绕过 ValidationPipe，`roomCode` 也不会到达 service。
- `rooms.service.ts create()`：
  - 若 `dto.roomCode !== undefined`（仅内部/测试）：校验非空、长度 ≤32、不含 `:` 与空白，
    且 `EXISTS room:{code}` 为假；否则 `10001 BAD_PARAM`。
  - **不强制 6 位格式**：既有 5 个测试文件 8 处直接以 `ROOM1`/`PDK1`/`ROOM10N` 等短码调
    `create()`（ws.gateway.test.ts:1903、record-pdk.test.ts:80、rooms.start.test.ts:407、
    entry-fee:121、rooms.service:327、start:894 等），强格式会让它们未改实现先红。
    `:`/空白已足以阻断派生键注入。
  - 不做 HSETNX 原子改造（正常 HTTP 路径已无法指定房号；随机码碰撞可忽略）。在注释中写明
    “HTTP 边界已收口，本校验是纵深防御”。
  - 已知边界：`EXISTS` 与 `writeMeta` 之间仍有理论竞态；该路径 HTTP 不可达，登记不修。
- 测试：
  - controller：body 带 `roomCode` 时，service.create 收到的入参不含 `roomCode`；房间号由服务端生成。
  - DTO 元数据：`roomCode` 不在可写字段（沿用 `room-create-game-type.test.ts` 范式）。
  - service：非法格式/已存在房间号被拒；不传时行为不变。
- 回归：rooms.controller / controller-switch / rooms.service / rooms.start / pdk-start-retry。

### 4.2 T2 pdk 重载 trustees（P0）

- `game.service.ts loadSession()`：把 `botIds` 归一化（现 327–336）移到 pdk 早退（271）之前；
  归一化逻辑不变（非空字符串保留，其余折 `undefined`）。
- `games/pdk/view.ts`：机器人判定改为 `typeof botId === 'string' && botId.length > 0`。
- 测试：
  - 新 pdk 重载用例：稀疏 `botIds` 经 `saveSession`→新 `GameService`→`loadSession`→
    `buildPdkPlayerView`：人类受托座位 `trustees=true`，机器人座 `false`。
  - 重载后 `trustee` toggle（on→off）仍生效。
  - ddz 既有 `session-reload-bot-seats` / governance 迁移测试保持绿。

### 4.3 T3 机器人恢复透传 `gameType`（P0）

- `recoverBotBindings(code, seats, known, gameType)`；`fillBots` 调用处传已算出的 `gameType`。
- 测试：pdk 房开局重试进入恢复分支时，`robot.acquire` 载荷含 `gameType:'paodekuai'`，
  且原 `botId` 不被替换；ddz 恢复用例不变。

### 4.4 T4 大厅规则文案（P0）

- 重写 `apps/client/src/gameModes.ts` 的 pdk `description`，严格对齐 `docs/games/paodekuai.md`：
  - 48 张、无大小王；2/3 人 16 张、4 人 12 张；2 人第三份 16 张扣下不公开。
  - 红桃 3→…→A→2 持有者首出；首出可出任意合法牌型；其余人过牌后由最后出牌者重出。
  - 牌型与默认开关（裸三开、三带二关、四带二开、裸飞机关、连对 ≥2 对、翅膀可配）。
  - 炸弹为最大牌型；AAA 非炸弹、KKKK 最大；同型同 length 比较。
  - 计分：剩余×底分×倍数；炸弹/关牌/春天翻倍；封顶；保本；春天 2 人局不适用。
  - 超时/托管策略。
- 保留 lobby 解析要求的 `【标题】`、空行、`·` 列表格式；保留 `id: GAME_META.paodekuai.id`。
- **文案中不得出现“王炸/地主/叫抢”**（避免与斗地主概念混淆），测试才能用“不含”断言。
- 测试：新增 `pdk-rules-text.test.ts`：
  - 复用/复刻 lobby 解析逻辑，断言 `description` 以 `【基本规则】` 起、含
    `【牌型与比较】/【计分】/【超时与托管】` 四段，且每段有 `·` 列表；
  - 断言含“红桃 3/48 张/12 张/保本/关牌/春天”；
  - 断言不含“王炸/地主/叫抢/大王 > 小王”。
  - 不做裸 substring 全篇断言（lobby 会丢弃首行非【】段，substring 可能假绿）。

### 4.5 T5 首出提示结构化生成（P1）

- `apps/client/src/game/pdk-hint.ts`：把 `1..min(12,n) + 15` 的子集枚举替换为按点数分组的结构化生成：
  - 同点：单/对/三/炸弹；三带一、三带二；四带二（带两单或一对，按配置）。
  - **四张同点可拆三**：三张/三带一/三带二/飞机 body 均可从 4 张同点中取 3 张
    （与 `parsePdkHand` 一致）；但飞机翅膀不得拆第 4 个三张（H17，rule.ts:133-144）。
  - 顺子滑窗（5–12，3–A，不含 2）；连对滑窗（2–8 对，不含 2）；裸飞机（2–5 三）；
    飞机带单/带对（翅膀点数与 body 点数不重叠，对翅点数两两不同；`both` 两种都生成）。
  - 所有候选仍交 `parsePdkHand` 校验并按现有偏好排序、按 canonical key 去重。
- 跟牌路径仍用 `handSize(target)` 生成同型候选，不改语义。
- 测试：
  - 定向用例：3–10 八连对（16 张）、3–9 七连对（14 张）、4 连三+4 单（16 张）、
    4 人 12 张的 6 连对/12 顺/4 裸三、四张同点拆三带一。
  - **差分测试 A（小牌）**：随机 10 张手牌，暴力枚举全部 ≤1024 子集 + `parsePdkHand`
    的合法集合与结构化生成集合相等（按 canonical key）。
  - **差分测试 B（16 张，覆盖本缺陷）**：至少 5 手固定/随机 16 张合法手牌，暴力枚举全部
    `2^16 = 65536` 个子集 + `parsePdkHand`，与结构化生成集合相等。该规模在测试中可接受；
    7 连对/8 连对/4 连三+4 单必须由生成器产出。
  - 规则开关矩阵：三带二关、裸飞机关、翅膀 pairs/singles/both、四带二带对开关下不得产出非法候选。
  - **性能判据（确定性，不测耗时）**：对最坏 16 张手牌，`suggestPdkPlays` 返回候选数
    `< 2000`（当前实现 4008，结构化后应显著更低）；若未来回退到子集枚举该断言必红。
  - 既有 `pdk-hint.test.ts` / `pdk-board.test.ts` 全绿。

### 4.6 T6 BIGINT `ended_at`（P1）

- `record.rpc.controller.ts`：新增私有 `toEpochMs(value: Date | string | number): number`：
  - `Date` → `getTime()`；`number` → 原值；
  - `string` 且 `/^-?\d+$/` → `Number(trimmed)`；
  - 其余 string → `new Date(s).getTime()`。
- `flagEndedAtMismatch` 用它算 `diff`；`Number.isFinite(diff)` 才比较。
- 测试：
  - pdk 假库返回 `String(endedAt)` 且同值 ⇒ 不告警。
  - 超阈值 ⇒ 告警一次，文案含 room/version。
  - ddz `Date` 与 ISO 字符串路径不变。

### 4.7 T7 开局幂等与规则漂移（P1）

- `startGame()`：已有会话时：
  - `gameType` / `playerCount` 不一致 ⇒ 仍抛 `12012`；
  - `rules` 不一致 ⇒ `logger.warn`（含 roomCode、首次快照键摘要），**不抛**；会话保留首次快照。
- 测试：
  - pdk 同房二次 start，rules 增删改 ⇒ 成功且 `session.rules` 仍为首次值。
  - gameType/playerCount 变化 ⇒ 12012。
  - ddz 无 rules 幂等不变。

### 4.8 T8 结算按 `gameType` 分流（P1）

- `computeSettlement(input)` 增 `gameType: GameType`：
  - `paodekuai`：要求 `isPdkSettlementResult(result)`；`scoreChanges` 必须对
    `seats` 每个座位恰好一条；否则 `throw new Error(...)`。
  - `doudizhu`：要求非 pdk 形状且 `landlordSeat`/`farmerScoreChange` 可用；否则抛错。
- `settleInner`：在 **result 守卫③之后、version 守卫④之前**插入严格校验
  （形状 + pdk 人数 + 座位覆盖；当前代码④是 version，spec 旧稿“守卫④处”有误）。
  失败 `dropWarn(..., 'settlement result incomplete vs gameType')` 并 return。
  通过后才调用 `computeSettlement`。
- 两条失败路径明确：
  - `settleInner` 预校验失败 ⇒ `dropWarn` + 指标，不写钱、不进 outbox；
  - 若 `computeSettlement` 仍意外抛错（预校验遗漏/直接复用）⇒ 冒泡到 `settle()` 顶层
    catch（settle.service.ts:345-351）⇒ `dropError`。两条都绝不写钱。
- 测试：
  - 纯函数：pdk 形状 + `gameType='doudizhu'`（及反向）抛错；pdk 缺一座抛错。
  - `settle()`：pdk 结果缺 `gameType` 键 / 缺座 ⇒ 不调用 currency、只 WARN 一次。
  - ddz 既有零和/截断/抽水用例不变；pdk 2/3/4 人用例全绿。
  - `settle-algorithm.test.ts` 现有 21 处 `computeSettlement` 调用需机械补 `gameType`
    （按各用例房间玩法），并保留判别力。

### 4.9 T9 `testDeck` 整数校验（P2）

- `deck.ts isPdkCard`：`typeof c === 'object' && c !== null && Number.isInteger(c.r) &&
  Number.isInteger(c.s)` 后再范围比较；`assertPdkDeck` 沿用。
- 测试：`{r:NaN,s:0}`、`{r:3.5,s:0}`、`{r:3,s:0.5}`、`{r:Infinity,s:0}` 均被拒；
  game-service test-hook 对应返回 `10001`。合法 48 张仍通过。

### 4.10 T10 自动出牌单一决策（P2）

- `shared/src/pdk/autoplay.ts` 新增 `decidePdkAutoAction(session, seat): GameAction`：
  - 只封装**决策**：找座位、`lastPlayedHand` 为空或 `lastPlayerIdx===seat` 时首出最小单张，
    否则找最小可压，压不过返回 `{ type: 'pass' }`。
  - **不接管守卫**：不校验 `state`、空手牌、是否当前玩家；这些语义留在两个入口：
    - `runtime.autoAction` 保持现状（显式 seat、不新增守卫）；
    - `handlePdkTimeout` 保留 `assertPlaying` 与空手牌抛错，再委托决策并调
      `handlePdkPlay/Pass`。
  - 返回类型固定 `GameAction`（`{type:'play',cards}` | `{type:'pass'}`）。
- 测试：
  - 决策矩阵（首出/跟牌/压不过/非当前座位）经两个入口结果一致。
  - 补 `lastPlayerIdx===seat` 必须首出、空手牌在 timeout 入口抛错（runtime 入口语义不变）、
    非当前座位语义用例。
  - 既有 `pdk-runtime` onTimeout/autoAction 与 `play` 用例全绿。

### 4.11 T11 局终单次读房（P2）

- `finalizeRoomEnd`：把已读的 `settleRoom` 透传给 `prepareRecord(event, ..., room)`。
- `prepareRecord`：`room ?? await findOne(...)`——正常路径一次读；首读为 null 时兜底重读，
  保持“settle 跳过但记录仍可写”的既有降级。
- 测试：
  - 正常局终：**finalize/prepareRecord 链路**内 `findOne` 只调用一次
    （注意 `updateStatus()` 内部也会 `findOne`，计数须限定链路，否则假红）；
    记录字段与结算一致。
  - 首读 null、二读成功：settle 跳过、记录写入（既有行为）。
  - 改写 `ws.gateway.test.ts` 中依赖“两次读返回不同值”的两组用例。

### 4.12 T12 `GAME_TYPES` 单一真源（P2）

- 新增 `packages/protocol/src/game-types.ts`（无任何 import）：
  `GAME_TYPES`、`GameType`、`DEFAULT_GAME_TYPE`、`isGameType`。
- `game.ts`：改为从 `./game-types` 导入并 re-export；`GAME_META`/`parseGameType` 留在原地。
- `validate.ts`：`import { GAME_TYPES } from './game-types'`；`KNOWN_GAME_TYPES = GAME_TYPES`；
  删除本地元组与“避免环”注释（改为说明叶子模块）。
- `index.ts` 导出面不变（继续经 `game.ts`）。
- 测试：
  - 遍历 `GAME_TYPES`，六个 `assertOptionalGameType` 调用点全部接受。
  - 未知值在 `PlayerView`/`game.balances`/`room.matched`/`room.state_update`/`room.match`/`room.join`
    各拒一次。
  - `game.test.ts` 值域用例不变。

## 5. 测试判据汇总

- 每个任务先写失败测试并确认红，再最小实现转绿、提交。
- 三个切片结束各跑一次受影响包测试；全片结束跑：
  - `pnpm -C packages/protocol test && pnpm -C packages/shared test`
  - `pnpm -C packages/game-service test && pnpm -C packages/room-service test`
  - `pnpm -C packages/user-service test && pnpm -C apps/client test`
  - `pnpm -C apps/client run lint`
  - `pnpm lint` / `pnpm test`（全仓；权威轮前不得以 Cached 充数）
- 不新增 conformance 切片；T12/T1 变更后跑 `tools/conformance` 类型检查（`tsc`）。
- 真栈/真浏览器：本片为缺陷修复，若 T1/T8 涉及 PostgreSQL-free 真栈路径，优先跑
  `slice-05`（建房）与 `slice-29`（pdk 规则）本地 conformance；不可跑则如实登记。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| HTTP 请求带 `roomCode` | 被 controller 白名单剥离；正常建房，绝不复用该码 |
| 内部/测试显式传非法或已存在 `roomCode` | `10001 BAD_PARAM`，不写 meta |
| pdk 会话 `botIds` 坏形状（非数组） | `loadSession` fail-closed 返回 null（既有 catch） |
| 结算结果形状/座位不完整 | `dropWarn` + 指标，不写钱、不重试 |
| pdk 结果缺 `gameType` 键 | 视为形状不符，drop |
| 规则热更新遇开局重试 | 保留首次快照，WARN，不抛 12012 |
| testDeck 非整数/NaN/Infinity | `ProtocolError` → `10001` |
| 首读房失败、二读成功 | settle 跳过、记录照写（既有降级） |
| 未来新增第三种玩法 | 只改 `game-types.ts` + `GAME_META`；validate 自动接受 |

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| controller 白名单漏字段导致建房能力回退 | 中 | controller 测试逐字段断言；rooms 全量回归 |
| 结算严格化误伤合法 pdk 结果 | 高 | 先跑 shared 结算向量单测；新增缺座/缺 gameType 判别例；2/3/4 人全矩阵 |
| 提示结构化生成漏形状 | 高 | 与暴力枚举做差分测试（≤10 张全子集）；规则开关矩阵 |
| `botIds` 提前归一化影响 ddz 迁移 | 中 | ddz governance/重载测试 + 新增 pdk 重载用例 |
| `autoAction` 抽取造成行为漂移 | 中 | 决策矩阵双入口对拍；补 `lastPlayerIdx===seat` 等缺口用例 |
| `game-types.ts` 抽离改变导出顺序 | 中 | protocol 全量测试 + tsc；index 导出面不变 |
| 双读合并改变 TTL 降级语义 | 低 | 保留首读 null 兜底；改写既有两次读用例 |
| 本片改动面横跨 6 包，回归成本高 | 中 | 三切片独立提交；每片结束跑受影响包；最后全仓 |

## 8. 涉及文件

- 客户端：`apps/client/src/gameModes.ts`、`apps/client/src/game/pdk-hint.ts`、对应 `apps/client/test/*`。
  `PdkBoard.vue` 预计不改（结构化生成在 hint 层；仅当候选数上界测试证明需要暴露计数再评估）。
- room-service：`rooms/rooms.controller.ts`、`rooms/rooms.dto.ts`、`rooms/rooms.service.ts`、
  `rooms/rooms.start.ts`、`gateway/ws.gateway.ts`、`currency/settle.service.ts`、对应 `test/*`。
- game-service：`game/game.service.ts`、`games/pdk/view.ts`、`games/pdk/runtime.ts`、对应 `test/*`。
- user-service：`rpc/record.rpc.controller.ts`、对应 `test/*`。
- shared：`src/pdk/deck.ts`、`src/pdk/autoplay.ts`、`src/pdk/play.ts`、对应 `test/*`。
- protocol：`src/game-types.ts`（新）、`src/game.ts`、`src/validate.ts`、对应 `test/*`。
- 文档：本 spec、实现计划、必要时的偏差台账。

## 9. 审查记录

### 2026-10-27 设计对抗审查（独立 reviewer）

结论：3 阻断 / 3 高 / 3 低，全部处置后进入计划。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| R1 | 阻断 | T1 强制 6 位房号格式会打红 5 文件 8 处既有短码夹具 | 放宽为“非空、≤32、不含 `:`/空白、未占用”；夹具迁移列入 T1 执行步骤 |
| R2 | 阻断 | T5 仅 ≤10 张差分无法覆盖 14/16 张缺陷；生成规则未对齐 parser 细节 | 增加 2^16 全子集差分（≥5 手 16 张）+ 四张拆三/H17/翅膀不重叠等细则 |
| R3 | 阻断 | T8 守卫编号错位（④是 version）；抛错路径与 §6 不符 | 明确插在 result③ 后、version④ 前；区分 dropWarn 与顶层 dropError |
| R4 | 高 | T11 “findOne 一次”必假红（updateStatus 也读） | 判据限定 finalize/prepareRecord 链路 |
| R5 | 高 | D4 文案要求含“无王炸”与测试“不含王炸”矛盾；substring 断言假绿 | 文案禁用“王炸/地主/叫抢”；测试改用分段解析断言 |
| R6 | 高 | D10 空手牌/非当前座位语义未统一 | 决策函数只封装决策，不接管守卫；两入口语义保持不变并补用例 |
| R7 | 低 | T13“必要时缓存”无验收判据 | 改为确定性候选数上界 `< 2000` |
| R8 | 低 | `settle-algorithm` 21 处调用需补 `gameType` 未列 | 已列入 4.8 |
| R9 | 低 | D1 无隐藏调用点、D3 谓词一致、D9/D11 成立 | 无需变更 |

审查后修订：D1/D7 决策表、4.1/4.4/4.5/4.8/4.10/4.11 及本节。
