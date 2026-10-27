# 四川麻将（血战到底）接入 · 设计 v0.2

> **定位**：在 `majiang` 分支为平台增加第 3 个玩法「四川麻将·血战到底」。
> **状态**：设计草案 v0.2，已按第 1 轮独立对抗审查修订（4 阻断 / 13 高 / 5 中低）；
> 审查结论与逐条处置见 §14。
> **规则唯一来源**：实现时新建 `docs/games/mahjong.md`（玩家可读完整规则 + 配置键口径）；
> 本 spec 是设计裁决记录，与规则文档冲突时以规则文档为准，并由 doc-sync 测试锁住。
> **接触面**：`packages/protocol` · `packages/shared` · `packages/game-service` ·
> `packages/room-service` · `packages/currency-service` · `packages/user-service` ·
> `packages/config-service` · `packages/robot-service` · `admin/` · `apps/client` ·
> `tools/conformance` · 文档。

---

## §0 用户裁决（本设计不得与之冲突）

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 玩法 = **四川麻将·血战到底**，4 人、108 张、定缺、刮风下雨、血战、荒庄查叫/花猪 | 不做 2/3 人、血流成河 |
| K2 | 规则默认按**成都线上主流**（审查修正后的番表/封顶/杠分/退税/过水），**全部数值与开关可配置** | 一个参数化引擎 + `chengdu`/`sbr` 预设 |
| K3 | 官方 **SBR 竞赛规则**（T/TFMJ 01-2024 / MIL SBR 2025）作为**预设**，不作为默认 | `sbr` 预设：3 番封顶、根含杠、无换三张、无呼叫转移、花猪 48 分 burn |
| K4 | 开通面与斗地主/跑得快**平台全量对齐**：匹配、金币场、好友房、机器人、风控、记录、admin | 配置暗上线，全部开关默认关 |
| K5 | 多人同时决策按 **B：多行动者窗口** 接内核 | `pendingActors`/`acceptsAction` + 共享 deadline |
| K6 | **一局一房**（一局 = 一次发牌到三家胡/荒庄） | 不做连庄/一圈；轮庄另立片 |
| K7 | 规则文档唯一真源；审查由开发方独立对抗完成 | `docs/games/mahjong.md` + 独立 reviewer |

---

## §1 背景与现状（代码事实）

平台已有 2 个玩法（斗地主、跑得快）。`docs/games/adding-a-game-mode.md` 明确：
第 3 个玩法不是“只填插件”，必须先做平台就绪审计与内核扩展。当前阻塞点：

| # | 现状 | 证据 |
|---|---|---|
| 1 | `GAME_TYPES` 只有两项 | `packages/protocol/src/game-types.ts:11` |
| 2 | 内核假设**单行动者 + 单计时器** | `packages/game-service/src/games/runtime.ts:98`（`currentActor`）、`packages/shared/src/core/session.ts:39-40`（`currentPlayer`/`turnDeadlineAt`） |
| 3 | 每个 runtime 的 `applyAction` 只认当前行动者；orchestrator 的 `sameTurn` 复验也只认单座 | `packages/game-service/src/games/ddz/runtime.ts`、`pdk/runtime.ts` 的 `applyAction`；`packages/game-service/src/game/game.service.ts:1224-1230`（机器人 `sameTurn`） |
| 4 | 动作联合只有 `bid/play/pass` | `packages/shared/src/core/action.ts:10` |
| 5 | 线上线格式只有 11 条 C→S 消息；`game.play` 载荷只有 `{cards}`；`CAS_MESSAGES` 只含 bid/play/pass | `packages/protocol/src/messages.ts:40-61,128-161` |
| 6 | `SettlementResult` 是 ddz\|pdk 封闭联合，gateway/persist 仍按 `isPdkSettlementResult` 形状分流 | `packages/protocol/src/settlement.ts:11`、`packages/room-service/src/gateway/ws.gateway.ts:1002`、`packages/user-service/src/rpc/record.rpc.controller.ts:133` |
| 7 | 出站校验 `assertGameView`/`assertSettlement` 非 pdk 一律按 ddz 形状 | `packages/protocol/src/validate.ts:316-345,391-397` |
| 8 | 视图解析：`undefined` 缺省斗地主；**未知字符串抛 `ProtocolError`** | `packages/protocol/src/views.ts:185-196` |
| 9 | 客户端把 `!== 'paodekuai'` 一律当斗地主 | `apps/client/src/stores/game.ts:489` |
| 10 | 协议已预留 `activeSeats?: number[]`（“麻将多决策窗口”）但无人使用 | `packages/protocol/src/views.ts:131` |
| 11 | 配置值本身是 JSON 列，管理后台有 JSON 编辑面 | `packages/config-service/src/config/platform-config.entity.ts:15`、`admin/app.js:2069` |
| 12 | 资金侧已有 `burned_residue`/`burned_rake` 与 `apply.burn`；**不变量只认 residue+rake** | `packages/currency-service/src/apply/apply.service.ts:281`、`packages/protocol/src/currency.ts:267-289` |
| 13 | 记录侧 pdk 是**独立双表**先例；斗地主/旧表无 `game_type` | `packages/user-service/src/migrations/1796300000000-PdkRecords.ts` |
| 14 | `game-service` 单副本、`runSerialized` 是进程内 Map | `k8s/base/game-service.yaml:22`、`packages/game-service/src/game/game.service.ts:692-697` |

麻将额外需要、当前内核没有的能力：

- **同时决策**：换三张（4 人同时选 3 张）、定缺（4 人同时选缺门）。
- **多行动者响应窗口**：一张打出后，其他未胡玩家可胡/杠/碰/过；优先级胡 > 杠 > 碰 > 摸牌；
  一炮多响；抢杠胡；杠上花/杠上炮。
- **多段/多赢家结算**：刮风下雨、点炮/自摸、血战多人胡、荒庄查叫/花猪/退税/呼叫转移。
- **花猪 burn**：官方 SBR 的花猪 48 分是“罚分归系统”，不是赔给对手；与零和结算不同。

---

## §2 范围

### 2.1 本片做

1. 平台收口：`GAME_TYPES`/`GAME_META` 扩 `mahjong`；协议联合扩展；形状分流改 `room.gameType`；
   客户端去掉隐式 ddz 兜底；结算分配器接逐座向量 + burn。
2. 内核多行动者窗口：`pendingActors`/`acceptsAction`/`windowId`；共享 deadline；超时统一结算窗口；
   机器人/托管逐座驱动；重连恢复 `activeSeats`；ddz/pdk 行为零变化。
3. 纯规则 `shared/mahjong/*`：牌/洗牌/发牌/换三张/定缺/胡牌分解/听牌/番型特征/计分策略/
   状态机/结算/autoplay；固定牌堆 + 真值表 + doc-sync + 差分测试。
4. 线格式：`game.play` 载荷扩展 `mahjong?: MahjongAction`；五处同批改动（messages / validate /
   router / ws.gateway / game-service）；`RequestMeta.windowId?` 用于窗口 CAS。
5. 服务端：runtime、view、record、robot/trustee/timeout/reconnect、多行动者窗口。
6. 房间/资金/记录/admin：4 人队列、匹配、台费/门槛/抽水、逐座结算、burn、outbox/对账、
   `game_type` 列/记录、玩家统计、财务 `byGame`、配置种子/admin、风控分桶。
7. 客户端：`GAME_MODES` 麻将条目、4 人牌桌、定缺/换三张/碰杠胡过/结算/历史、
   牌面资产（CC0）、能力位门控。
8. 观测/门禁：指标 `game_type=mahjong`、告警、conformance 新切片、暗上线矩阵、回滚手册。

### 2.2 明确不做（YAGNI）

- 2/3 人场（只 4 人）；血流成河。
- 多局轮庄/一圈/连庄（轮庄另立片）。
- 观战、完整复盘 UI（记录/回放数据保留，UI 复用历史页最小展示）。
- ML 机器人（首版启发式；不接 DouZero/Mortal；不调 `robot.decide`）。
- 天胡/地胡默认关（配置可开）；断幺九/海底/每杠/双龙七对/三龙七对/十八罗汉默认 0（配置可开）。
- 换三张的“洗回牌山重发”变体（只做“同花色 3 张交换”）。
- 比赛积分/名次/仲裁流程（SBR 预设只是单局计分口径，不是赛事系统）。
- 语音素材首版不做：`voiceAnnouncements=false`，先用文字横幅；素材到位后再开。

---

## §3 规则模型

### 3.1 默认 `chengdu` 预设（修正后的成都线上主流）

> 口径来源见 §13；村规差异全部进配置。**默认值**如下。

**牌/人数**：4 人，108 张（万/条/筒 1–9 各 4），无字牌/花牌；
不能吃，只能碰/杠。

**发牌/流程（唯一时序）**：

```text
洗牌 108
→ 每家 13 张（庄家也不例外）
→ [exchange 换三张, 可关]  每家选 3 张同花色；全部选完后按方向同时交换（仍 13 张）
→ lack 定缺                每家选一门缺；校验强制规则
→ 庄家摸第 14 张
→ play / claim / blood / draw / ended
```

- **不允许**“庄家先 14 张再摸一次”。庄家的第 14 张在定缺之后摸，且不参与换三张。
- 牌墙余量：108 − 52 = 56；庄家摸第 14 张后 55。
- 摸牌/杠后补牌都从**牌墙前部**取（川麻口径；TMT 原文“杠牌后从牌墙首部继续抓牌”）。

**阶段**：

```text
exchange(换三张, 可关) → lack(定缺) → play(摸打) ⇄ claim(响应窗口) / rob(抢杠窗口)
                                             ↓
                                     blood(有人胡, 离场续战)
                                             ↓
                                     draw(荒庄查叫/花猪) / ended
```

| 阶段 | 规则 |
|---|---|
| `exchange` | 每家选 **3 张同花色**；方向默认随机（下家/上家/对家）；超时自动选；全部选完后同时交换 |
| `lack` | 每家选一门缺；**必须先打完缺门牌**；**不能碰/杠缺门牌**；手里有缺门牌不能胡 |
| `play` | 摸牌 → 可暗杠/补杠/自摸胡 → 出牌；出牌后开 `claim` 窗口 |
| `claim` | 其他未胡玩家可 **胡 > 杠 > 碰 > 过**；一炮多响；超时=过（强胡时=胡） |
| `rob` | 补杠时先开抢杠窗口；可胡者 **胡 > 过**；被抢则杠无效、杠分退回 |
| `blood` | 胡牌者离场（手牌公开），剩余继续；**3 人胡或牌墙摸空**结束 |
| `draw` | 荒庄：先查花猪，再查大叫；已胡玩家不参与 |

**阶段细节**：

- 定缺：起手只有 2 门 ⇒ 第三门为缺；只有 1 门 ⇒ 可在另两门中选；3 门 ⇒ 任选。
- 换三张：所选 3 张必须同花色；某花色不足 3 张不能选。
- 摸牌顺序：按座位递增（下家）；杠后补牌从牌墙前部取。
- **最后 4 张**：`wallCount <= 4` 时，能胡必胡（自摸自动胡，点炮不可过）。
- **牌墙空**：最后一次摸牌后的**弃牌仍开 claim 窗口**；窗口结算完、无人胡才荒庄。
  不得在牌墙刚空时立刻荒庄而吞掉海底炮。
- **杠的最低余量**：牌墙余量 ≥ 1 才能杠（补牌可取最后一张）；余量 0 时杠非法。
- **海底**（可选番）：胡最后一张（自摸）或最后一张弃牌被胡（海底炮）时 +1。
- 过水：同一张牌过胡后，自己摸牌前不能再胡同一张；**加番可胡**（默认 `sameTileOrHigherFan`）。
- 已胡者：不再参与任何支付/收取（刮风下雨/自摸/杠上花/查叫/花猪）。
- 一炮多响：每个赢家分别向点炮者收；点炮者付总和。
- 抢杠胡：只抢**补杠（弯杠）**，暗杠不可抢；被抢则杠无效、杠分退回。
- 杠上炮：杠后打出的牌被胡，杠分按 `gangTransfer` 处理（默认转给胡牌者）。
- 自摸：其余未胡玩家各付；默认 `addBase`（每家多付 1×底）。
- 庄家：首局随机；一局一房不轮庄；无庄家加倍。

**番型默认表**（`fan` 为“平胡=1、每 +1 翻倍”口径；倍率 = `2^(min(fan, cap)-1)`）：

| 主番 | 番 | 说明 |
|---|---:|---|
| 平胡 | 1 | 基础 |
| 对对胡 | 2 | 4 副刻子/杠 + 将 |
| 清一色 | 3 | 单一花色 |
| 带幺九 | 3 | 每副牌都含 1/9 |
| 七对 | 3 | 7 个对子 |
| 清对（清碰） | 4 | 清一色 + 对对胡；**取代**清一色/对对胡 |
| 将对 | 4 | 全 2/5/8 的对对胡；**取代**对对胡 |
| 龙七对 | 5 | 七对含 1 个四张；**取代**七对，且该四张不计根 |
| 清七对 | 5 | 清一色 + 七对；**取代**清一色/七对 |
| 清幺九 | 5 | 清一色 + 带幺九；**取代**清一色/带幺九 |
| 清龙七对 | 6 | 清一色 + 龙七对；**取代**清一色/七对/龙七对，且定义四张不计根 |
| 天胡 / 地胡（默认关） | 6 | 配置开启；开启时**只算该主番**，不再算其他主番/另加番 |

**另加番**（叠加后封顶；不取代主番）：

| 项 | 默认 |
|---|---:|
| 杠上花 | +1 |
| 杠上炮 | +1 |
| 抢杠胡 | +1 |
| 金钩钓 | +1 |
| 根（四张相同且**未杠**；龙七对/清龙七对的定义四张不算根） | +1/根 |
| 自摸 | 加底（`addBase`；可配 `addFan`/`none`） |
| 断幺九（默认关） | +1 |
| 海底（默认关） | +1 |
| 每杠（默认关） | +1/杠 |
| 双龙七对/三龙七对/十八罗汉（默认关） | 配置值 |

**封顶**：默认 `fanCap=6`（32× 底）；可配 1–8。

**`named` 计分裁决（阻断项 11 的修法）**：

1. 先由 `hu.ts` 产出**全部合法分解**；每个分解产出规范特征。
2. `scoring.ts` 对每个分解计算**所有适用命名番**；命名番有固定的 `supersedes` 图
   （清对 ⊃ 清一色+对对胡；清七对 ⊃ 清一色+七对；龙七对 ⊃ 七对；清龙七对 ⊃ 清一色+七对+龙七对；
   将对 ⊃ 对对胡；清幺九 ⊃ 清一色+带幺九）。
3. **取“单一最高命名番”作为主番，不把被取代的组成番相加**；另加番只加成，不参与主番比较。
4. 多个分解 ⇒ 取**最终番最大**者；并列时按固定优先级：
   `更高主番 → 更多根 → 更少杠 → 分解键字典序`（写进规则文档 + 测试）。
5. 结果 `{ fan, multiplier, items[] }`；`items` 含主番 + 每个另加番，供结算/记录展示。
6. `additive` 策略（SBR）不走命名番：按规范特征逐项相加，封顶；见 §3.2。

**刮风下雨默认**：

| 杠型 | 默认支付 |
|---|---|
| 直杠（明杠） | 点杠者付 2×底；可选「家家有」= 2×点杠者 + 其余未胡每家 1×底 |
| 补杠（弯杠） | 其余未胡每家 1×底；必须摸到第四张后立即补杠；被抢杠则取消并退回 |
| 暗杠（下雨） | 其余未胡每家 2×底；不可抢 |

**荒庄默认**：

- 花猪（手里仍有缺门牌）：`huazhuMode='payEach'` ⇒ 赔每个 **未胡且非花猪** 玩家
  `封顶倍 × 底`（`huazhuPayees='active'` 默认；可配 `'nonFlowerPig'`）；并退税；不参与查叫。
- 查大叫：未听牌者赔每个听牌者 `该听牌者最大可胡番` 的分（封顶），并退税。
- 退税：未听牌者（含花猪）退回**尚未转移**的刮风下雨所得；被抢杠也退。
- 呼叫转移：杠上炮时，本次杠分转给胡牌者（默认开）；一炮多响按 `toEachWinner`/`split` 配置。
- 三番起胡：默认关（`minFanToHu=0`）；可配 3。

### 3.2 `sbr` 预设（官方竞赛口径）

用同一引擎表达，差异如下：

| 项 | `sbr` |
|---|---|
| 封顶 | 3 番 / 8 分（`fanBase=0`；倍率 = `2^fan`） |
| 番表 | 根 1/组（**含杠**）、碰碰胡 1、金钩钓 1（+碰碰胡 1）、清一色 2、七对 2、杠上花 1、杠上炮 1、抢杠 1、海底 1 |
| 换三张 | 关 |
| 呼叫转移 | 关（杠后点炮退回杠分） |
| 自摸 | +1 分（`addPoint`；每家付 `倍率×底 + 底`） |
| 花猪 | 48 分 **burn**（对手不得分） |
| 退税 | 仅**杠者**荒庄未听退全部杠分 |
| 过水 | 同张（`sameTile`；不同张可胡） |
| 三番起胡 | 关 |
| 天胡/地胡/断幺九/海底/每杠/双龙/十八罗汉 | 关 |
| 多局轮庄 | 不做（一局一房） |

> **命名纪律**：在拿到 T/TFMJ 01-2024 全文逐条核对前，对外文案用 **“SBR 预设（近似）”**，
> 不写“官方认证”。`sbr` 预设的 `huazhuMode='burn48'` 默认只在免费场/好友房可用；
> 金币场使用需显式打开 `game.mahjong.sbrGoldEnabled` 并设 burn 上限。

### 3.3 配置化模型

一个 JSON 键 `game.mahjong.rules`，结构：

```ts
interface MahjongRulesConfig {
  preset: 'chengdu' | 'sbr';       // 展开默认值；显式键覆盖
  rulesVersion: number;            // 快照版本，进记录/outbox 指纹，不进 start 拒绝条件
  // 番/封顶
  scoringPolicy: 'named' | 'additive';
  fanBase: 0 | 1;                  // sbr=0, chengdu=1
  fanCap: number;                  // chengdu 6, sbr 3, 1..8
  fanTable: Record<string, number>; // named 番值
  additiveFanTable: Record<string, number>; // root/allPungs/goldenWait/fullFlush/sevenPairs/...
  rootIncludesKong: boolean;       // chengdu false, sbr true
  selfDrawMode: 'addBase' | 'addFan' | 'addPoint' | 'none';
  minFanToHu: number;              // 0 或 3
  // 流程
  exchangeThreeEnabled: boolean;
  exchangeDirection: 'random' | 'clockwise' | 'counterclockwise' | 'opposite';
  lastFourForcedHu: boolean;
  passHuMode: 'off' | 'sameTile' | 'sameTileOrHigherFan';
  // 杠/荒庄
  directGangMode: 'contract' | 'everyone';
  gangTransfer: 'none' | 'toEachWinner' | 'split';
  refundOnDraw: 'nonReadyAll' | 'kongDeclarerOnly';
  huazhuMode: 'payEach' | 'burn48' | 'off';
  huazhuPayees: 'active' | 'nonFlowerPig';
  chajiaoEnabled: boolean;
  chajiaoAllSameState: 'none' | 'pay';
  // 截断固定 writeOff（payer 少付、payee 少收，不把差额转嫁；redistribute 不做）
  // 可选番
  optionalFans: { duanYaoJiu: number; haiDi: number; perGang: number; shuangLong: number; ... };
  // 时长
  claimWindowMs: number;           // 默认 5000
  exchangeWindowMs: number;        // 默认 15000
  lackWindowMs: number;            // 默认 15000
}
```

- **预设展开 + 逐项覆盖**：`preset` 先展开为完整默认值，再应用显式键；未知键/越界值 ⇒ `ProtocolError`。
- 开局时把**展开后的完整快照**放进 `StartGameRequest.rules` / `MahjongSession.rules` /
  `MahjongRecordEnvelope.rules`；重试/幂等用**快照**，不读实时配置（防 `12012`）。
- `game.mahjong.*` 闸键见 §6；`rules` 是一个 JSON 键，不拆成几十个配置键。
- **`rulesVersion` 只进记录/outbox 指纹**；`game.start` 幂等沿用“首快照权威、差异 WARN”，
  不把 rules 放进拒绝条件（`game.service.ts:397-411` 的既有裁决）。

**预设默认值（必须逐项钉死）**：

| 键 | `chengdu` | `sbr` |
|---|---|---|
| `exchangeThreeEnabled` | `true` | `false` |
| `exchangeDirection` | `random` | `random`（不生效） |
| `fanCap` | `6` | `3` |
| `fanBase` | `1` | `0` |
| `rootIncludesKong` | `false` | `true` |
| `selfDrawMode` | `addBase` | `addPoint` |
| `minFanToHu` | `0` | `0` |
| `passHuMode` | `sameTileOrHigherFan` | `sameTile` |
| `lastFourForcedHu` | `true` | `true` |
| `directGangMode` | `contract` | `contract` |
| `gangTransfer` | `toEachWinner` | `none` |
| `refundOnDraw` | `nonReadyAll` | `kongDeclarerOnly` |
| `huazhuMode` | `payEach` | `burn48` |
| `huazhuPayees` | `active` | `active`（burn 不生效） |
| `chajiaoEnabled` | `true` | `true` |
| `chajiaoAllSameState` | `pay` | `none` |
| `optionalFans.*` | `0` | `0` |
| `claimWindowMs` | `5000` | `5000` |
| `exchangeWindowMs` | `15000` | `15000`（不生效） |
| `lackWindowMs` | `15000` | `15000` |

**关键语义补充**：

- `minFanToHu > 0` 时：只有 `fan >= minFanToHu` 的胡才算合法；“听牌”= 存在合法胡张；
  `lastFourForcedHu` 只强制合法胡；过水锁只记录合法胡机会。
- `selfDrawMode='addFan'`：先 `fan += 1`，再按封顶算 `mult`；`addBase`/`addPoint` 是
  “倍率分 + 1×底”，不改变 `fan`。
- `gangTransfer='toEachWinner'`：多个赢家各收一份本次杠分（杠者多付）；
  `'split'`：本次杠分在多个赢家间**均分**，余数按座位升序分配。
- `huazhuPayees='active'`：只赔**未胡且非花猪**；`'nonFlowerPig'`：赔所有非花猪（含已胡）。
- `named` 并列主番按固定 `NAMED_PRIORITY`：
  `清龙七对 > 清七对 > 清幺九 > 龙七对 > 清对 > 将对 > 清一色 > 带幺九 > 七对 > 对对胡 > 平胡`；
  仍并列时按 §3.1 第 4 条的根/杠/字典序裁决。

---

## §4 架构与模块

### 4.1 类型归属（阻断项 2 的修法）

**所有跨包/线格式类型放 `packages/protocol/src/mahjong/`；`shared` 只导入，不反向定义**：

| 文件 | 内容 |
|---|---|
| `protocol/src/mahjong/tile.ts` | `Tile { s: 0\|1\|2; r: 1..9 }`、`MahjongSuit`、排序/编码/解码（27 位计数串） |
| `protocol/src/mahjong/actions.ts` | `MahjongAction`、`MahjongClaim` |
| `protocol/src/mahjong/rules.ts` | `MahjongRulesConfig`、`MahjongRulesPublic`、默认值形状（**常量在 shared**） |
| `protocol/src/mahjong/types.ts` | view / settlement / record / robot features / meld / score event |
| `protocol/src/mahjong/index.ts` | 统一导出 |

- `packages/protocol` **不新增 workspace 依赖**；`shared` 继续 `shared → protocol`。
- `shared/src/mahjong/rules.ts` 放 `DEFAULT_CHENGDU_RULES`/`DEFAULT_SBR_RULES`/`parseMahjongRules`
  （与 pdk 的 `shared/pdk/rules.ts` 同构）。
- `GameAction`（shared）引用 protocol 的 `MahjongAction`——方向仍是 shared → protocol，不成环。
- `GameSessionBase<P, L = ActionLogEntryBase<P>>` 增加**日志条目泛型** `L`（默认值保持
  ddz/pdk 不变）；`MahjongSession` 用 `MahjongActionLogEntry`（exchange/lack/draw/discard/peng/gang/hu/pass），
  不再把麻将动作塞进 `kind:'play'|'pass'` 的旧日志形状。
- `MahjongRecordEnvelope` 的 `rngSeed`/完整手牌是**服务端内部字段**；客户端历史用
  `MahjongRecordView` 裁剪形态，不复用内部信封。
- `hand` = 发牌后、换三张前的 **初始 13 张**；`finalHand` = 终局手牌（含胡牌张，13/14 张）；
  两者都是 27 位计数串。超时自动动作也要写 `actions`（`auto:true`）。

### 4.2 纯规则 `packages/shared/src/mahjong/`

| 文件 | 职责 |
|---|---|
| `tile.ts` | 导入 protocol `Tile`；计数/排序/编码辅助 |
| `deck.ts` | 108 张构造、洗牌、发牌（13×4）；测试用固定牌堆 |
| `exchange.ts` | 换三张选择校验、方向映射、同时交换 |
| `lack.ts` | 定缺校验/强制规则/缺门清理 |
| `meld.ts` | 碰/直杠/补杠/暗杠的合法性、副露结构 |
| `hu.ts` | 胡牌分解（4 副+将、七对）；返回全部分解/特征；缺门校验 |
| `ting.ts` | 听牌枚举、每张听牌的最大番、进听数（hint/bot 用） |
| `features.ts` | 规范特征：根数、碰碰胡、金钩钓、清一色、七对、幺九、258、杠数、胡牌上下文 |
| `scoring.ts` | `scoreHand(features, rules)`：`named`/`additive` 两套策略；`supersedes` 图；并列裁决 |
| `session.ts` | `MahjongSession`/`MahjongPlayer` 类型与创建 |
| `actions.ts` | 动作应用：换三张/定缺/出牌/暗杠/补杠/胡/碰/杠/过 |
| `claims.ts` | 候选计算、优先级、一炮多响、抢杠、过水锁、最后四张强胡 |
| `settle.ts` | 事件账（杠/胡/转移/退税/查叫/花猪）→ 逐座净额 + burn |
| `autoplay.ts` | `decideMahjongAutoAction`：换三张/定缺/出牌/响应/杠/胡 |
| `rules.ts` | `DEFAULT_CHENGDU_RULES`/`DEFAULT_SBR_RULES`/`parseMahjongRules` |
| `doc-sync.test.ts` | 锁 `docs/games/mahjong.md` 与代码常量/番表一致 |

**设计原则**：

- 纯函数，无 Nest/Redis/UI 依赖；固定牌堆 + 真值表 + 差分测试。
- **特征与计分分离**：`hu.ts` 只产出可验证的牌型分解/特征；`scoring.ts` 只消费特征 + 规则。
  这样 `chengdu` 命名番与 `sbr` 叠加番共用同一套胡牌/听牌算法，不出现第二套规则引擎。
- 客户端**不实现规则裁决**；hint/听牌/可胡/可碰杠由服务端下发（偏离指南 §2.11 的“客户端 hint 枚举”，
  理由：麻将 hint 组合爆炸，双实现必漂移；在 spec 登记为有意偏离）。

### 4.3 game-service

- 新增 `packages/game-service/src/games/mahjong/runtime.ts`、`view.ts`、`record.ts`。
- `MahjongRuntime implements GameRuntime<MahjongSession>`，`gameType='mahjong'`，`meta=GAME_META.mahjong`。
- `create`：`parseMahjongRules` 快照、发牌、机器人内部字段按座位。
- `applyAction`：按 `MahjongAction` 分派；非法动作抛 `RuleError`（映射到错误码）。
- `onTimeout`：结算**整个窗口**（换三张/定缺/claim/rob/play 的自动动作）。
- `pendingActors`：窗口内所有待决策座位；`acceptsAction`：座位 ∈ pendingActors。
- `windowId`：`exchange` / `lack` / `claim:<turnSeq>` / `rob:<turnSeq>` / `turn:<turnSeq>`；
  同一窗口内动作**不顺延** deadline。
- `windowDuration`：exchange/lack/claim/rob 用规则里的窗长；play 用治理档。
- `currentActor` 语义（必须写进 runtime 注释 + 测试）：
  - `exchange`/`lack`：按座位序第一个未选者；
  - `play`：当前摸打者；
  - `claim`/`rob`：按优先级第一个未响应者；
  - `draw`/`ended`：`-1`。
- `buildView`：自己手牌明文；他家只给张数/副露/弃牌/缺门/是否已胡；
  已胡者手牌进 `revealedHands: Array<{seat, tiles: Tile[], huTile: Tile}>`（仅已胡者）；
  牌墙只给张数。字段名用 `tiles` 而不是 `hand`，避免撞 `assertNoLeak` 的禁键。
- `buildRecord`：初始手牌、换三张方向/RNG、定缺、每次摸打/碰杠胡、番型明细、每座分数变化。
- `buildRobotInput`：裁剪视图 + 公开特征；**不含**牌墙、他家手牌、`botId`/`skillLevel`/`rngSeed`。
- 单一决策入口 `decideMahjongAutoAction`，超时/托管/机器人共用。

### 4.4 内核（多行动者窗口）

`GameRuntime` 增加**可选**方法，ddz/pdk 不实现 ⇒ 行为零变化：

```ts
interface GameRuntime<S> {
  pendingActors?(session: S): number[];
  acceptsAction?(session: S, seat: number): boolean;
  windowId?(session: S): string;
  windowDuration?(session: S, policy: GovernanceDurations): number;
}
```

orchestrator 改动点（**逐条落到现有行号**）：

| 位置 | 改动 |
|---|---|
| `applyAction` 授权 | `acceptsAction(session, seat)`；不再只认 `currentActor` |
| `deadlineFor`/`finishTransition`（`game.service.ts:976-986,1256,1381`） | **唯一 deadline 写入函数**：动作后若 `windowId` 未变且 `pendingActors` 非空 ⇒ 保留旧 `turnDeadlineAt`；否则 `now + windowDuration` |
| `startTurnTimer`（`993-1033`） | `timeoutMs` 必须取 `Math.max(0, session.turnDeadlineAt - Date.now())`；不得再用 `deadlineFor - now` 重算满额 |
| 人类动作 `791` | 改为调用统一写入函数，禁止无条件覆写 |
| 超时复核（`1340-1348`） | 身份 = `{windowId, deadlineAt}`；不匹配时**必须重挂剩余时间**，不得直接 return 留空计时器 |
| 拒绝动作重挂（`767-771`） | 用 `min(remaining, normal)`；剩余 ≤0 时立即触发超时，不得把窗口续命 |
| `onTurnTimeout`（`1351-1381`） | 调 runtime `onTimeout` 结算整个窗口；`timeoutCount`/`trustee` 对**每个** pending 座位记，不只第一个 |
| `driveRobotTurn`（`1092-1107`） | 麻将走独立 `driveMahjongWindow`；状态守卫改为“麻将 active 阶段 + 有 pending 机器人”；遍历 pendingActors |
| `commitRobotDecisionLocked`（`1212-1262`） | 麻将不走 `RobotDecideResponse`；用 `windowId + seat ∈ pendingActors` 复核 |
| 托管 `applyTrustee`（`581-599`） | 托管只触发**本人**自动动作（2s 后），**不得**修改共享 deadline；其他座位不受影响 |
| 重连/重驱 | `activeSeats = pendingActors`；`turnDeadlineAt` 共享 |
| 指标 | `activeSeats.length`；窗口等待时长 |

**时序钉死**：

- 同一 claim/rob 窗口内，任一玩家响应**不顺延** deadline；只有窗口整体结算后才进入下一窗口。
- 超时 = 对**所有** pending 座位执行自动动作（pass/自动定缺/自动换三张/自动出牌/强胡），
  不是只对第一个。
- 窗口内动作仍走 per-room 串行队列；CAS 按 §4.5。
- 机器人决策被拒 ⇒ 回退 `autoAction`；仍失败 ⇒ 记录并让窗口继续（不静默吞错）。
- **部署前提**：v1 要求 `game-service` 单副本（`runSerialized` 是进程内 Map）。
  若扩副本，必须先把 per-room 串行/CAS 下沉 Redis（见 §10）。
- **麻将机器人路径**：不调 `robot-service`、不使用 `RobotDecideResponse`（它只有 play/pass）；
  直接调 `runtime.autoAction` → `{kind:'mahjong', action}` → `applyAction`。
  这是显式偏差，登记在规则文档/计划里。

### 4.5 线格式与 CAS（阻断项 1/13 的修法）

**不新增 C→S 消息**；扩展 `game.play` 载荷：

```ts
| { type: 'game.play'; meta: RequestMeta; payload: {
    cards?: Card[];            // ddz/pdk
    mahjong?: MahjongAction;   // mahjong；与 cards 二选一
  } }
```

- `RequestMeta` 增加可选 `windowId?: string`（非麻将忽略）。
- `CAS_MESSAGES` 不变（`game.play` 已在列）。
- **五处同批改动**：
  1. `packages/protocol/src/messages.ts`：payload 联合、`validateClientMessage` 分支；
  2. `packages/room-service/src/gateway/message.router.ts:402-408`：`game.play` 转发 `{cards, mahjong}`；
  3. `packages/room-service/src/gateway/ws.gateway.ts:733-746`：RPC 载荷；
  4. `packages/protocol/src/rpc.ts`：`game.play` 请求 schema 加 `mahjong?`；
  5. `packages/game-service/src/game/game.service.ts:617-665`：`actAndView`/`applyById` 接受
     `mahjong`，按房间 `gameType` 构造 `{kind:'mahjong', action}`；非麻将收到 `mahjong` ⇒ 13001。
- **校验**：`validateClientMessage` 只校验形状；动作合法性由 game-service 按会话重算，
  **绝不信任** `claimsForMe`/客户端牌。
- **CAS 规则**：
  - 单人回合（play/lack/exchange 的单座动作）：沿用 `baseVersion`；不符 ⇒ 13004。
  - 多行动者窗口：若 `meta.windowId === runtime.windowId(session)` 且 `seat ∈ pendingActors`
    ⇒ 接受**过期 `baseVersion`**（per-room 串行队列保证顺序）；否则 13004。
  - 客户端收到 13004 且仍在窗口 ⇒ `game.resync` 后重发；窗口已结束 ⇒ 丢弃并提示。
  - 服务端返回的 view 带 `activeSeats`/`windowId`（`windowId` 只在 view 内，客户端回传）。

### 4.6 结算（阻断项 3/8/9 的修法）

**事件账 → 逐座净额**，不再用“净额向量”直接表达规则支付。

```ts
type MahjongScoreEvent =
  | { kind:'gang'; seq:number; seat:number; gang:'melded'|'added'|'concealed';
      tile:Tile; payers:Array<{ seat:number; amount:number }> }
  | { kind:'hu'; seq:number; seat:number; fromSeat:number|null;
      fan:number; multiplier:number; payers:Array<{ seat:number; amount:number }>;
      items:string[] }
  | { kind:'transfer'; seq:number; ref:number; fromSeat:number; toSeat:number;
      amount:number; reason:'gangShoot' }
  | { kind:'refund'; seq:number; ref:number; fromSeat:number;
      toSeats:Array<{ seat:number; amount:number }>;
      reason:'robbed'|'shootAfterGang'|'notReady' }
  | { kind:'chajiao'; seq:number; fromSeat:number; toSeat:number; amount:number; fan:number }
  | { kind:'huazhu'; seq:number; seat:number; amount:number;
      mode:'payEach'|'burn48'; payees:Array<{ seat:number; amount:number }> };
```

**顺序（钉死）**：

1. 按 `seq` 应用杠事件（杠发生时已记录 payer；已胡者不在 payer 中）。
2. 杠上炮：`gangTransfer != 'none'` ⇒ 对本次杠事件生成 `transfer`，把收款人改为胡牌者；
   `='none'` ⇒ 生成 `refund`，把钱退回原 payer。**同一笔杠分只能走一条**。
3. 抢杠：本次杠事件 `refund`；被抢的杠不成立；胡牌者 +1 番。
4. 荒庄退税：按 `refundOnDraw` 对**尚未转移**的杠分生成 `refund`；
   已转移给胡牌者的部分不再退（避免双付）。
5. 胡事件（点炮者/自摸未胡者 → 赢家）。
6. 查叫事件（未听 → 听牌，逐对）。
7. 花猪事件：`payEach` 付 `huazhuPayees`；`burn48` 不生成 payee，进 `burn.penalty`。
8. 抽水：对第 5–7 步后的**正收益**按 `rakePercent` 计，进 `burn.rake`。

**截断**：

- `settleMahjong` 先在内存按上列顺序对 events 做余额截断，产出 `appliedEvents` /
  `scoreChanges` / `writtenOff`；**`computeSettlement` 的 mahjong 分支不得再 pool**，
  只做形状校验、余额复核（余额变动则二次截断 + writeOff）与 rake。
- 按事件顺序逐 payer 扣款；payer 余额不足 ⇒ 本次只付余额，`writtenOff` 记录差额；
  **不把差额转嫁给其他 payer**（固定 `writeOff`；`redistribute` 不做）。
- 截断后的事件净额仍零和（payer 少付、payee 少收，双方同时减少）。
- `huazhu burn48` 的 payer 也只烧余额内的部分；差额 `writtenOff`，不产生负余额。
- 不允许把 burn 的负数摊给赢家（与 pdk 的 pool 语义不同；麻将走事件账）。

**结果**：

```ts
interface MahjongSettlementResult extends SettlementVector {
  gameType: 'mahjong';
  playerCount: 4;
  winnerSeats: number[];
  scoreChanges: Array<{ seat: number; delta: number }>; // 截断后事件净额；零和；不含 burn/rake
  fanDetails: Array<{ seat: number; fan: number; multiplier: number; items: string[] }>;
  events: MahjongScoreEvent[];
  burn: Array<{ seat: number; amount: number; reason: 'flowerPig' }>; // 花猪罚分（不含抽水）
  rakeTotal: number;            // 抽水（burn.rake）
  chajiao: Array<{ from: number; to: number; amount: number }>;
  liuju: boolean;
  huazhuSeats: number[];
  endReason: 'threeWinners' | 'wallEmpty';
  writtenOff: Array<{ seat: number; amount: number; reason: string }>;
}
```

**资金落库**：

- `computeSettlement` 增加 `gameType='mahjong'` 分支：
  - 校验 `scoreChanges` 覆盖 4 座、零和、整数；
  - `entries` = `scoreChanges` 非零项 + burn payer 的负项；
  - 对正收益扣 `rakePercent`，`rakeTotal`；
  - `burn = { residue: 0, rake: rakeTotal, penalty: Σ flowerPig burn }`；
  - 不变量：`Σentries + residue + rake + penalty === 0`；
  - `deltas`（record.moneyDelta）= 截断+抽水后的实际值。
- `CurrencyBurn` 加 `penalty: number`（可选；缺省 0 保持旧 canonical 兼容）。
- `currencyApplyHash` 在 `penalty` 存在时纳入 canonical；旧载荷逐字节不变。
- `currency_ops` 加 `burned_penalty` 列（迁移，见 §6）；`apply` 写入；
  outbox 条目/重放/财务 summary/byGame 全部带上 penalty。
- **outbox**：mahjong 的 `SettleOutboxEntry` 必须含 `burn.penalty`；旧 outbox 重放不带 penalty
  ⇒ 按 0 处理；新条目缺 penalty 字段 ⇒ 视为旧格式（0）。
- **对账**：`records-reconcile` 增加麻将记录源；`byGame` 从两玩法扩为
  `Record<GameType, ...>`；burn 汇总加 penalty；财务/管理后台过滤器加 mahjong。

### 4.7 记录（阻断项 4 的修法）

**裁决：新建麻将独立双表**（沿用 pdk D11 先例，不污染 ddz 旧表）：

- `game_records_mahjong`：每局 1 行；`uk_mahjong_room_version(room_code, game_version)` 幂等；
  `game_type='mahjong'`、`base_score`、`dealer_seat`、`end_reason`、`liuju`、
  `huazhu_seats` JSON、`burn` JSON、`rules` JSON、`started_at`、`ended_at`。
- `game_record_players_mahjong`：每局 4 行；`hand varchar(27)`（27 位计数串）、
  `melds JSON`、`discards JSON`、`lack_suit tinyint`、`is_out`、`fan`、`multiplier`、
  `score_change`、`won`、`ended_at`；`uk_mahjong_record_seat(record_id, seat)`、
  `idx_mahjong_user(user_id, ended_at)`。
- 迁移时间戳：user-service `1798200000000-MahjongRecords.ts`（> 1797000000005；见 §6.2）。
- `record.rpc.controller`：
  - `gameType` 白名单加 `mahjong`；
  - `invalidMahjongReason()`：4 座、手牌 13/14 张、27 位计数串、`winnerSeats` 覆盖、
    `scoreChanges` 零和、`burn` 合法、`rules.preset` 合法；
  - `persist()` 按 `req.gameType` 三路分流（doudizhu/paodekuai/mahjong），不按形状猜。
- `ws.gateway.prepareRecord`：mahjong 必须带 `gameType/playerCount`，不得写 `bottomCards`；
  带 `rules`/`events`/`burn`/`writtenOff`。
- 查询：`GET /api/records?gameType=mahjong`；历史页最小展示（结果/番型/分数/花猪）。
- **禁止出站**：`MahjongRecordEnvelope` 含全场初始手牌与 `rngSeed`，只存服务端；
  历史 API 返回 `MahjongRecordView`（自己手牌 + 已胡者亮牌 + 公开副露/弃牌），
  绝不返回他人未胡手牌或 RNG。

### 4.8 房间/资金/机器人/配置

- `GAME_META.mahjong = { id:'mahjong', name:'四川麻将', supportedPlayerCounts:[4], defaultPlayerCount:4, capabilities:{ cardCounter:false, bots:true, goldRoom:true, voiceAnnouncements:false } }`。
- 队列键按 `gameType` + `playerCount` 参数化；4 人匹配；旧键双读。
- 房间 meta：`gameType`、`maxPlayers=4`；开局链 `rules` 快照。
- 台费/门槛/抽水：按 §6 键；`levelsKeyOf` 加 `game.levels.mahjong`；
  `entryFeePercents`/`entryMultiplier`/`rakePercent` 按玩法读。
- 机器人：`bot:pool:mahjong`；启发式策略；**不调 robot-service**；
  机器人只拿裁剪视图；失败回退 `autoAction`。
- 风控：`game_type=mahjong` 分桶；同设备/同 IP/胜率阈值；自动限流沿用现有键。
- 金币场：结算逐座向量 + outbox + 对账；burn 走 `burned_penalty`。

### 4.9 客户端

- `GAME_MODES` 加麻将条目（名称/文案/图标位）；`CLIENT_TABLE_PLAYER_COUNTS.mahjong=[4]`。
- `game.vue` 按 `view.gameType` 显式分支；新增 `MahjongBoard`（复用 table 壳），禁止
  `!== 'paodekuai'` 兜底。
- 交互：
  - 换三张：同花色选 3 张，倒计时；确认后等待其他家。
  - 定缺：三门按钮 + 张数；强制规则提示。
  - 出牌：点牌 → 出牌；缺门牌优先/只能打缺门。
  - 响应：胡/杠/碰/过按钮；按优先级展示；倒计时用 `activeSeats` + `turnDeadlineAt`。
  - 自摸/暗杠/补杠：回合内按钮；补杠需刚摸到第四张。
  - 结算：番型明细、杠分、退税、呼叫转移、花猪/查叫、burn 提示、`writtenOff` 提示。
  - 过水锁/最后四张强胡：服务端下发 `claimsForMe`，客户端只展示。
  - 已胡亮牌：`revealedHands: Array<{seat, tiles: Tile[], huTile: Tile}>`（仅已胡者）。
- `game.current_turn`：载荷扩为 `{ seat: number; seats: number[]; timeoutMs: number }`；
  `seat` 保留给旧玩法/旧客户端，`seats` = `activeSeats`；麻将客户端以 `seats` 渲染。
- `game.finished`：mahjong 用 `{ gameType:'mahjong', winnerSeats, endReason, huazhuSeats }`；
  不再落 `{winner:'landlord'}`。
- 牌面资产：FluffyStuff CC0（万/条/筒子集）；`THIRD-PARTY-NOTICES.md` 登记；
  图标/音效后续片；语音首版关。
- 客户端规则文案：不复制规则文档；麻将说明由 `packages/protocol/src/mahjong/rule-summary.ts` 的
  `MAHJONG_RULE_SUMMARY` 常量提供（客户端只依赖 protocol，不新增 shared 依赖）；
  `shared/mahjong/doc-sync.test.ts` 断言它与 `docs/games/mahjong.md` 关键口径一致。
- 历史页：麻将记录最小展示（结果/番型/分数）；完整回放后续。
- 牌面/动画：复用 table 壳；108 张按需渲染；不新造时钟（沿用 animations 闸）。

---

## §5 状态机与结算细节

### 5.1 发牌/换三张/定缺

1. 洗牌 108；每家 13 张（庄家也 13）。
2. `exchange`（若开）：每家选 3 张同花色；全部选完后按方向交换；交换后仍 13 张。
   - 方向：`random`（均匀三选一）/`clockwise`/`counterclockwise`/`opposite`；
     结算时记录 `exchangeDirection` + `rngSeed`（服务端审计）。
   - 方向映射必须是座位置换：下家 i→i+1；上家 i→i-1；对家 i→i+2。
   - 超时自动选：选**张数最少**的花色（并列按万→条→筒），取 3 张。
3. `lack`：每家选缺；校验强制规则；庄家摸第 14 张；进入 `play`。
   - 超时自动：3 门 ⇒ 张数最少；2 门 ⇒ 缺的那门；1 门 ⇒ 另两门按万→条→筒先者。
4. 若换三张关：直接 `lack`。

### 5.2 摸打

- `play` 当前玩家持有 14 张（或杠后补牌）；可：
  - `selfDrawHu`（自摸，含杠上花/海底）；
  - `concealedGang`（4 张相同；补牌后继续）；
  - `addedGang`（已碰 + 刚摸到第 4 张；先开 `rob` 窗口）；
  - `discard`（必须遵守缺门优先；出牌后开 `claim` 窗口）。
- 摸牌来源：普通摸牌/杠后补牌都从牌墙前部；牌墙余量 0 ⇒ 不能再杠。
- **最后 4 张**：自摸能胡自动胡；点炮能胡强制胡（不可过）。
- **牌墙空**：最后一次摸牌后的弃牌仍开 claim 窗口；窗口结算完无人胡 ⇒ 荒庄。
- 过水锁：过胡后记录 `{tileType, fan}`；自己下次摸牌后清除；同一张牌在锁定期内不可胡，
  除非 `sameTileOrHigherFan` 且新手牌番更高。
- 已胡者不进入 `play`/`claim`/`rob`；其手牌在 `revealedHands` 公开。

### 5.3 响应窗口（claim/rob）

候选 = 其他未胡玩家中，能胡/能杠/能碰者（缺门牌不能碰/杠；胡必须满足缺门/番数/过水/强胡）。

- 窗口内所有候选都可提交；`pass` 合法（强胡时除外）。
- **CAS**：`meta.windowId` 匹配且 seat ∈ pendingActors ⇒ 接受过期 `baseVersion`；
  否则 13004。
- 超时：未提交者按 `pass`（强胡时按 `hu`）；`timeoutCount` 逐座记。
- 结算优先级：
  1. **胡**：所有胡 claimant 同时成立（一炮多响）；点炮者付每个赢家；赢家离场；
     下一行动者 = 点炮者之后的下一个未胡座位（摸牌）。
  2. **杠**：优先级高于碰；同一张牌多个杠/碰 claimant ⇒ 杠优先，同级按点炮者之后最近座位。
  3. **碰**：claimant 取牌成副露，出牌；下一行动者 = claimant。
  4. **过**：下一行动者 = 点炮者之后的下一个未胡座位，摸牌。
- 杠后补牌：claimant 取牌成杠，收杠分，补牌；若补牌可胡 ⇒ 杠上花（自摸）。
- 杠上炮：杠者补牌后打出的牌被胡 ⇒ 胡牌者 +1 番；杠分按 `gangTransfer` 转/退。
- 抢杠：`addedGang` 先开 `rob` 窗口；有人胡 ⇒ 杠无效、杠分退回、胡牌者 +1 番；
  无人胡 ⇒ 补杠成立、收杠分、补牌。
- 一炮多响的支付：点炮者付每个赢家；payer 截断按 §4.6。
- 已胡者不再进入任何后续窗口/支付；已胡者的手牌公开。

### 5.4 荒庄

- 牌墙空（且不足 3 人胡）且最后一次弃牌窗口结算完 ⇒ `draw`：
  1. 花猪：手里仍有缺门牌（三门/未打完缺门）⇒ 按 `huazhuMode`：
     - `payEach`：赔 `huazhuPayees`（默认 `active`：未胡且非花猪）`封顶倍 × 底`；
     - `burn48`：付 `48 × 底` 到系统 burn，对手不得分；
     - `off`：不算。
  2. 查叫（`chajiaoEnabled`）：未听牌者赔每个听牌者其最大可胡番（封顶）；**花猪不参与查叫**（固定）；
     若所有未胡者同状态且 `chajiaoAllSameState='none'` ⇒ 不结算。
  3. 退税：按 `refundOnDraw`：
     - `nonReadyAll`：所有未听牌者（含花猪）退回**尚未转移**的杠分；
     - `kongDeclarerOnly`：仅杠者荒庄未听退回**尚未转移**的杠分。
  4. 呼叫转移：若本局有杠上炮且 `gangTransfer != 'none'`，已转移的杠分不再退（见 §4.6 顺序）。
- 结算后 `ended`；记录/资金/推送同现有局终链。

### 5.5 结算公式

- 设 `unit = baseScore`；`mult = 2^(min(fan, fanCap) - fanBase)`。
- 点炮：每个赢家收 `mult × unit`，点炮者付总和。
- 自摸：每个未胡玩家付：
  - `addBase`/`addPoint`：`mult × unit + unit`；
  - `addFan`：先 `fan+1` 再算 `mult × unit`；
  - `none`：`mult × unit`。
- 杠分：直杠 2×/补杠 1×/暗杠 2× × unit（按 `directGangMode`）。
- 查叫：`mult(该听牌者最大番) × unit` 逐对。
- 花猪：`2^(fanCap - fanBase) × unit`（payEach）或 `48 × unit`（burn48）。
- 抽水：对赢家正收益 `floor(gain × rakePercent / 100)`；`rakeTotal` 进 burn.rake。
- 零和：`Σ scoreChanges = 0`；`burn` 独立；`Σentries + residue + rake + penalty = 0`。
- **独立重算**：测试必须从 `events` 重算 `scoreChanges`，不得用 `settle.ts` 自己的输出求和。

---

## §6 配置/迁移/管理后台

### 6.1 配置键（与 pdk 同构）

| 键 | 默认 | 说明 |
|---|---|---|
| `game.mahjong.enabled` | `false` | 总开关 |
| `game.mahjong.freeRoomEnabled` | `false` | 免费场 |
| `game.mahjong.goldRoomEnabled` | `false` | 金币场 |
| `game.mahjong.friendRoomEnabled` | `false` | 好友房 |
| `game.mahjong.freeBotFillEnabled` | `false` | 免费场补位 |
| `game.mahjong.goldBotFillEnabled` | `false` | 金币场补位 |
| `game.mahjong.entryMultiplier` | `10` | 台费倍率 |
| `game.mahjong.rakePercent` | `0` | 抽水 |
| `game.mahjong.sbrGoldEnabled` | `false` | sbr 预设是否允许金币场（burn 风险） |
| `game.mahjong.rules` | `chengdu` 展开 JSON | 规则快照 |
| `game.levels.mahjong` | 档位数组 | 档位表（迁移种子） |

**读者改动（缺一不可）**：

- `levelsKeyOf`：加 `game.levels.mahjong`；不得回退 ddz 档位。
- `gameEnabled`：加 mahjong；缺失 ⇒ false。
- `freeRoomEnabled`/`goldRoomEnabled`/`friendRoomEnabled`：mahjong 缺失 ⇒ **false**
  （现有 `free` 缺省 true、`gold` 非 pdk 缺省 true 的代码必须显式分支）。
- `freeBotFillEnabled`/`goldBotFillEnabled`：mahjong 缺失 ⇒ **false**。
- `entryMultiplier`/`rakePercent`：按玩法读；缺失 10/0。
- `entryFeePercents`：读 mahjong 档位；缺失 ⇒ 空表（不收）。
- `supportsRoomPlayerCount` / 队列键 / 机器人池：加 mahjong。
- `robot-funding`：按 mahjong 档位发钱，禁止落 ddz。

### 6.2 迁移时间戳（避免第 N 次撞车）

| 包 | 文件 | 时间戳 |
|---|---|---|
| config-service | `MahjongConfigSeed` | `1798100000000` |
| user-service | `MahjongRecords` | `1798200000000` |
| currency-service | `BurnPenalty` | `1798300000000` |

> 当前全仓最大为 `1798000000000`；以上递增且互不碰撞。迁移 up/down 都要有测试。

### 6.3 幂等

- `game.start` 的 `rules` 用**展开快照**；沿用“首快照权威、差异 WARN”
  （`game.service.ts:397-411`），**不把 rules 放进 start 拒绝条件**。
- `rulesVersion` 只进记录/outbox 指纹；配置热更新不改变已开局会话。
- 防 `12012`：不得用实时配置重新组装 rules 判幂等。

---

## §7 观测/风控/conformance

- 指标（`game_type=mahjong`）：
  - `mahjong_hands_started_total` / `mahjong_hands_ended_total{endReason}`
  - `mahjong_hu_total{fan, selfDraw}` / `mahjong_fan_histogram`
  - `mahjong_claim_window_seconds` / `mahjong_window_timeout_total{phase}`
  - `mahjong_flower_pig_total` / `mahjong_burn_total{penalty,rake}`
  - `mahjong_settlement_fail_total` / `mahjong_outbox_backlog` / `mahjong_written_off_total`
  - `mahjong_reconnect_total{phase}`
- 告警：结算失败、outbox 积压、房间无计时器、窗口超时率异常、burn 异常、对账漂移。
- 风控：`game_type=mahjong` 分桶；同设备/同 IP/胜率阈值/自动限流；记录↔资金对账。
- **对账/财务/指标泛化**：
  - `records-reconcile` 的 `byGame` 从 `{doudizhu,paodekuai}` 改为 `Record<GameType,...>`；
    加麻将记录源；合计遍历 `GAME_TYPES`。
  - `room-metrics` 的 `rooms_active` 遍历 `GAME_TYPES`，加 mahjong 序列。
  - `admin-finance` 过滤器/文案加 mahjong；burn summary 加 penalty。
- conformance：新增 mahjong slice（boot/config、4 人匹配、完整机器人局、claim 窗口、
  重连、结算/对账、记录、admin 配置、暗上线开关）。
- 暗上线矩阵：`enabled` / `freeRoom` / `goldRoom` / `friendRoom` / `botFill` 分别测开与关。

---

## §8 测试判据

| 层 | 判据 |
|---|---|
| `shared/mahjong` | 固定牌堆真值表；胡牌分解与慢速参考实现对拍；听牌枚举与全牌型枚举对拍；`named` 命名番取最大/取代图/多分解并列；`additive` 逐项；换三张/定缺/过水/强胡/抢杠/杠上炮/退税/花猪/查叫边界；事件账→净额**独立重算**；截断/writeOff；burn 分离 |
| protocol | `GAME_TYPES`/`GameMeta` 编译期完整；`MahjongAction`/view/settlement/record 校验；禁出站键；`game.play` 二选一；`windowId` CAS；旧 ddz/pdk 类型不变 |
| game-service | 多行动者窗口 fake runtime：并发/超时/机器人/托管/重连/CAS；ddz/pdk golden 零变化；麻将完整机器人局；窗口内动作不顺延 deadline；拒绝动作重挂不续命；13004 窗口重发 |
| room-service | 4 人队列/匹配/开局；结算事件/截断/burn；outbox/对账；形状/座位/`gameType` fail-closed |
| currency-service | `burn.penalty` 上账/幂等/对账；财务 `byGame`；缺座/非法载荷拒收；旧载荷 canonical 不变 |
| user-service | 麻将记录写入/查询/历史；旧记录双读；非法记录拒收；`rngSeed`/他人手牌不出站 |
| config-service | 预设展开/覆盖/未知键/越界；缺键 fail-closed；迁移 up/down；键计数 |
| admin | 配置域/JSON 编辑/审计/静态闸 |
| client | `game.vue` 显式分支；MahjongBoard 交互；`vue-tsc`；真浏览器 e2e |
| 全仓 | `pnpm test` / `pnpm lint` / `turbo --force`；conformance；真栈机器人局 |

**防假绿**：

- 结算零和必须从 `events` 独立重算，不得用 `settle.ts` 输出自证。
- doc-sync 必须先改规则文档再改代码；测试断言两边常量，不允许同一次提交双向改。
- 完整机器人局用 `INTERNAL_TEST_HOOKS` + 固定牌堆 + 最低手速；conformance 时长写进判据。
- 负路径：伪造座位/牌/窗口、过期 `windowId`、余额不足、非法 burn、旧 outbox。

---

## §9 切片计划

| 片 | 内容 | 独立回滚 |
|---|---|---|
| **S0a** | 平台收口：`GAME_TYPES` 扩 id、协议联合骨架、形状分流改 `room.gameType`、`assertGameView`/`assertSettlement`/`resolveGameType`、客户端显式分支、线格式 `game.play.mahjong` 骨架 | 是 |
| **S0b** | 内核多行动者窗口：`pendingActors`/`acceptsAction`/`windowId`/`windowDuration`、deadline 唯一来源、CAS、机器人/托管/重连、fake runtime 测试、ddz/pdk golden | 是 |
| **S1** | 纯规则 `shared/mahjong/*` + `docs/games/mahjong.md` + doc-sync + 差分测试 | 是 |
| **S2** | game-service runtime/view/record + 窗口接线 + 超时/托管/机器人/重连 | 是 |
| **S3** | room/currency/user/admin/config/risk/observability + 麻将双表 + `burned_penalty` + config readers + outbox/reconcile | 是 |
| **S4** | 客户端 MahjongBoard/资产/历史/能力位/current_turn/finished | 是 |
| **S5** | conformance/真栈/暗上线/回滚手册/交付报告 | 是 |

> 每个切片按 `docs/dev-process.md`：TDD（红→绿→提交）→ 代码审查 → 全量验证。
> 设计/计划各一轮独立对抗审查；不把审查推给用户。

---

## §10 风险与部署前提

| 风险 | 处置 |
|---|---|
| 内核多行动者改动破坏 ddz/pdk | 可选方法默认退化；golden 全量回归；conformance 基线先绿 |
| **game-service 单副本前提** | v1 保持 `replicas=1`；扩副本前把 per-room 串行/CAS 下沉 Redis；spec/ops 明文 |
| 规则配置爆炸/漂移 | 预设 + 严格 schema + doc-sync + admin 校验 + 记录快照 |
| 结算 burn 破坏零和/对账 | `scoreChanges` 与 `burn` 分离；`burned_penalty` 列；独立重算断言 |
| claim 窗口重连/超时竞态 | 共享 deadline + `windowId` 身份；窗口内不顺延；超时结算整个窗口 |
| 机器人质量 | 启发式 + 单一决策入口 + 失败回退；不进 ML |
| 客户端 108 张性能 | SVG/CC0 资产、按需渲染、复用 table 壳 |
| 配置热更新/幂等 | 开局快照；首快照权威；`rulesVersion` 不进 start 拒绝条件 |
| 一局一房与比赛体验差异 | 规则文档写明；轮庄另立片 |
| 花猪 burn 与金币场体感 | chengdu 默认 `payEach`；sbr `burn48` 仅免费/好友房；`sbrGoldEnabled` 显式开 |
| SBR 预设命名 | 未拿到 T/TFMJ 全文前称“SBR 预设（近似）”，不称官方认证 |
| 旧服务兼容 | 旧 currency 拒 `burn.penalty`、旧 user 拒 `game_type=mahjong`：部署顺序/在途 outbox 见回滚手册 |

---

## §11 涉及文件（初稿）

- protocol：`game-types.ts`、`game.ts`、`views.ts`、`settlement.ts`、`records.ts`、`robot.ts`、
  `validate.ts`、`messages.ts`、`rpc.ts`、`index.ts`、新增 `mahjong/*`。
- shared：`core/action.ts`、`core/session.ts`、`index.ts`、新增 `mahjong/*`、`test/mahjong-*`。
- game-service：`games/runtime.ts`、`games/registry.ts`、`game/game.service.ts`、
  `game/view.builder.ts`、`game/rule-error.mapping.ts`、新增 `games/mahjong/*`。
- room-service：`rooms/rooms.start.ts`、`rooms/rooms.service.ts`、`match/*`、
  `config/config-cache.service.ts`、`currency/settle.service.ts`、`gateway/ws.gateway.ts`、
  `gateway/message.router.ts`、`currency/robot-funding.ts`。
- currency-service：`apply/apply.service.ts`、`admin/finance-query.service.ts`、
  `reconcile/*`、新增迁移 `BurnPenalty`。
- user-service：`rpc/record.rpc.controller.ts`、`records/*`、`risk/*`、新增迁移 `MahjongRecords`。
- config-service：`migrations/*-MahjongConfigSeed.ts`、`config/client-config.controller.ts`、
  `config/platform-config.service.ts`、`config/config-cache` 读取器。
- admin：`app.js`（麻将配置域/JSON 编辑/审计/财务过滤）。
- client：`gameModes.ts`、`stores/game.ts`、`pages/game/game.vue`、`pages/table/*`、
  新增 `MahjongBoard`/资产。
- conformance：新增 mahjong slice。
- docs：`docs/games/mahjong.md`、本 spec、plan、handoff、deviation ledger。

---

## §12 形状判别点清单（必须逐处改 + 正反测试）

| # | 位置 | 现状 | 改法 |
|---|---|---|---|
| 1 | `room-service/currency/settle.service.ts:175-209` | `settlementShapeProblem` 非 pdk 按 ddz | 三路 `gameType` |
| 2 | `settle.service.ts:231-325,466-493` | `computeSettlement` 净额 pool | mahjong 事件账分支 + burn |
| 3 | `protocol/validate.ts:316-345,391-397` | `assertGameView`/`assertSettlement` 非 pdk 按 ddz | 三路 |
| 4 | `user-service/rpc/record.rpc.controller.ts:133,246-283,411-415` | pdk/ddz 二路 | 三路 + 麻将校验 |
| 5 | `room-service/gateway/ws.gateway.ts:1001-1005` | finished payload 二形 | 麻将三形 |
| 6 | `ws.gateway.ts:1294-1311,1327,1349-1358` | `gameType ?? 'doudizhu'`、`playerCount ?? 3` | 麻将显式带 |
| 7 | `api-gateway/proxy.gateway.ts:464-477` | 校验失败静默丢帧 | 麻将分支；测试断言不丢 |
| 8 | `client/stores/game.ts:489` | `!== 'paodekuai'` 当 ddz | 显式 `gameType` |
| 9 | `client/gameModes.ts` | 两条 | 加麻将；文案 doc-sync |
| 10 | `currency/reconcile/records-reconcile.service.ts:69,457,803-813` | `byGame` 两玩法 | `Record<GameType>` |
| 11 | `currency/admin/finance-query.service.ts` | burn 只 residue/rake | 加 penalty/byGame |
| 12 | `room-service/metrics/room-metrics.service.ts:100-119` | 两玩法 | 遍历 `GAME_TYPES` |
| 13 | `room-service/config/config-cache.service.ts:391-396` | `levelsKeyOf` 非 pdk 回 ddz | 加 mahjong |
| 14 | `config-cache.service.ts:209-233,281-284` | 缺键默认 ddz/true | mahjong fail-closed |
| 15 | `protocol/src/messages.ts` / `rpc.ts` | `game.play` 只有 cards | 加 `mahjong?` |
| 16 | `room-service/gateway/message.router.ts:402-408` | forward 只 cards | 加 mahjong |
| 17 | `game-service/game.service.ts:617-665` | actAndView 只 bid/play/pass | 加 mahjong |
| 18 | `game-service/game.service.ts:976-986,993-1033,1256,1341-1381` | 单 deadline | 窗口 deadline |
| 19 | `game-service/game.service.ts:1092-1107,1278-1312` | robot 单座/play|pass | 麻将窗口路径 |
| 20 | `protocol/src/currency.ts:75-80,267-289,427-453` | burn 只 residue/rake | 加 penalty + 不变量 + hash |
| 21 | `currency/apply/apply.service.ts:67-70` | OPS_INSERT 9 列 | 加 `burned_penalty` |
| 22 | `user-service` 记录表 | pdk 双表 | 麻将双表 + 查询 |

---

## §13 规则来源（默认值依据）

- 腾讯欢乐麻将·四川麻将血战到底：<http://minigame.qq.com/m_gamerule/rule_jp92/rule_jp92_xz.html>
- 2016 TMT 赛事规则（川麻）：<http://majiang.qq.com/webplat/info/news_version3/7207/25932/25933/25936/m16340/201611/523252.shtml>
- 波克血战麻将·基本牌型番种：<https://www.pook.com/mobile/xzmj/rule/rule-3.html>
- 腾讯云·成都麻将规则和番数计算：<https://cloud.tencent.cn/developer/article/1069132>
- 萌娘百科·四川麻将：<https://mzh.moegirl.org.cn/zh-hans/四川麻将>
- B 站·川麻血战到底规则与算点：<https://www.bilibili.com/opus/781492105988014102>
- T/TFMJ 01-2024《四川麻将竞赛规则》（四川天府新区麻将运动协会，2024-07；团体标准，全文付费）：
  <https://www.spc.org.cn/online/8534be527fea7b9a02bf61429c646ef0.html>、
  <https://www.ndls.org.cn/standard/detail/32dcbcf0ee708b7b40eaa7cd51accf68>
- MIL SBR 2025（国际麻将联盟规则与规则委员会，公开 PDF）：
  <https://sheauhaw.com/old_blogs/tools/rules/MIL-SBR.pdf>
- CMF Brief Introduction to Bloody Mahjong：<https://www.cmf-mahjong.org/_files/ugd/70959c_e213ff3233584f00a5f5cdbc58352c8d.pdf>
- World Mahjong Tour SBR rules：<https://worldmahjongtour.live/wp-content/uploads/SC-rules-and-scoring-1-sheet-reference-En-1.pdf>
- MahjongSoft English SBR rules：<https://mahjongsoft.com/files/SBR_ENG_part_1.pdf>
- 新增玩法接入指南（跑得快经验修订版）：`docs/games/adding-a-game-mode.md`

> 村规差异极大；本 spec 的默认值是“成都线上主流”的交叉验证结果，全部可配置。
> 官方 SBR 预设定稿前，如需严格按 T/TFMJ 01-2024，需取得该标准全文逐条核对。

---

## §14 审查记录（第 1 轮，独立 reviewer）

> 审查对象：v0.1。分级：阻断 / 高 / 中低。处置状态：已修 / 部分修 / 驳回。

### 14.1 阻断（4）

| # | 发现 | 处置 |
|---|---|---|
| B1 | 麻将动作没有线上线格式/入站路径；`ClientMessage` 11 条、`game.play` 只有 `{cards}` | **已修**：§4.5 扩展 `game.play` 载荷 `mahjong?`，列五处同批改动 + `windowId` CAS |
| B2 | `Tile`/规则类型放 shared 与 protocol 依赖方向冲突 | **已修**：§4.1 类型归属表；所有线格式类型进 protocol，shared 只导入 |
| B3 | `burn.penalty` 撞 `Σentries+residue+rake=0` 不变量，金币局会 10001/丢钱 | **已修**：§4.6 + §6.2；`CurrencyBurn.penalty`、不变量、hash、outbox、reconcile、财务、`burned_penalty` 列 |
| B4 | 麻将记录没有落库表/分支，user-service 会拒收或错表 | **已修**：§4.7 新建麻将双表 + 迁移 `1798200000000` + 三路分流 + 查询/裁剪 |

### 14.2 高（13）

| # | 发现 | 处置 |
|---|---|---|
| H5 | “窗口内动作不顺延 deadline”在现有 orchestrator 上不成立（三处无条件覆写、timer 重算满额） | **已修**：§4.4 逐行列出三处赋值、timer 取 `turnDeadlineAt`、拒绝重挂 clamp、超时复核重挂 |
| H6 | 机器人/超时驱动假设单 `currentActor` + ddz 状态枚举；`RobotDecideResponse` 无法表达麻将 | **已修**：§4.4 独立 `driveMahjongWindow`，不调 robot-service，显式偏差 |
| H7 | 托管 R8 重排/超时计数只记单座，与共享窗口冲突 | **已修**：§4.4 托管只触发本人、不改共享 deadline；`timeoutCount` 逐 pending 座 |
| H8 | 结算净额向量无法表达逐事件支付/逐付款人截断 | **已修**：§4.6 事件账 → 截断 → 净额（固定 writeOff，不转嫁）；独立重算 |
| H9 | 退税/呼叫转移/花猪/已胡者组合无收款人与顺序，可能双退/非零和 | **已修**：§4.6 事件顺序 1–8；转移后不再退；花猪 `huazhuPayees`；已胡者退出 |
| H10 | 配置键面与读取器错位：档位/台费落 ddz、botFill 死键、rake 无键、金币场缺省开 | **已修**：§6.1 键全集 + 读者清单；缺键 mahjong fail-closed |
| H11 | `named` 未定义“取最大/能否叠加”，同牌型两套赔付 | **已修**：§3.1 `named` 计分裁决 + supersedes + 多分解并列规则 + 测试 |
| H12 | 形状判别点未清点：漏一处则网关丢帧/金币局不结算 | **已修**：§12 22 处清单 + 正反测试 |
| H13 | 多行动者并发提交触发 baseVersion CAS 冲突 | **已修**：§4.5 `windowId` + seat 授权；过期 baseVersion 在窗口内接受；客户端重发 |
| H14 | 对账/财务/指标仍两玩法硬编码 | **已修**：§7 `Record<GameType>`、加麻将记录源、burn penalty、room gauge、admin |
| H15 | 发牌/换三张/定缺次序矛盾；方向/RNG 未入记录 | **已修**：§3.1/§5.1 唯一时序（13→exchange→lack→庄摸第 14）；记录 `exchangeDirection`/`rngSeed` |
| H16 | 牌墙/杠补/海底/最后四张时序未定义；补牌方向 | **部分修**：§3.1/§5.2 牌墙余量、杠最低余量、最后弃牌仍开窗口、海底定义、强胡；**驳回**“补牌从前部与主流相反”——TMT 川麻原文“杠牌后从牌墙首部继续抓牌”，前部正确 |
| H17 | 入站动作必须服务端重算；robot features/record 禁出站未覆盖 | **已修**：§4.5 服务端重算；§4.3/§4.7 `MahjongRobotFeatures`/`MahjongRecordView` 禁出站；exchange 校验 |

### 14.3 中低（6）

| # | 发现 | 处置 |
|---|---|---|
| M18 | SBR 预设未按付费标准全文核对却称“官方”；48×底 burn 金币场失控 | **已修**：§3.2 “SBR 预设（近似）”；`sbrGoldEnabled`；burn 截断/上限 |
| M19 | 测试假绿：完整机器人局超时、doc-sync 双向改、零和自证 | **已修**：§8 防假绿四条 |
| M20 | `game.current_turn`/`game.finished` 多行动者语义未定义 | **已修**：§4.9 `seats[]` + finished mahjong payload |
| M21 | 客户端规则文案第二真源；已胡亮牌无法表达 | **已修**：§4.9 `rule-summary.ts` doc-sync；`revealedHands` |
| M22 | §6.2 `rules.version` 进幂等可能重引 12012 | **已修**：§6.3 首快照权威；version 只进记录/outbox |
| L23 | §1 两处引用错位；单副本前提未声明 | **已修**：§1 第 3/8 条订正；§4.4/§10 单副本前提 |

### 14.4 缺失项（10）落点

1. 线格式 → §4.5；2. protocol 归属 → §4.1；3. 记录落库 → §4.7；
4. 金额契约 → §4.6；5. 配置键/读者 → §6.1；6. 共享窗口契约 → §4.4；
7. 重连/重同步 UX → §4.4/§4.9；8. 记录确定性 → §5.1/§4.7；
9. 规则文档先裁决点 → §3.1/§5；10. 灰度/回滚 → §10/§9。

> 第 2 轮审查在计划阶段前进行；若本版仍有阻断/高项，继续修订。
