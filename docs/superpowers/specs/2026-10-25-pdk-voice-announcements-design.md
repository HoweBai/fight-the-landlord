# 跑得快语音播报（复用斗地主）· 设计 spec

> 日期：2026-10-25。分支：`dev`。范围：**纯客户端 + `GAME_META` 能力位**；
> 不动服务端、不加素材、不加配置键。
> 依据：`2026-10-22-card-voice-announcements-design.md`（斗地主语音全量接入）。

## 1. 背景与现状

斗地主已有 50 条牌型播报素材（牌桌分包 `/pages/table/static/audio/`）与成熟接线：
`cueForPlay`（`parseHand` 选音）、`cueForPass`、`cueForBid`、报单/报双、输赢。
跑得快目前只播：炸弹 `Bomb`、过牌 `Buyao*`、输赢；其余出牌静音。
`GAME_META.paodekuai.capabilities.voiceAnnouncements = false`。

跑得快与斗地主共享牌面编码（3–14 / 17=2）与大部分牌型语义，多数语音可直接复用。
**不能直接复用 `cueForPlay` 的硬原因**：
- 跑得快连对最少 **2 对**，斗地主 `parseHand` 要求 **≥3 对** ⇒ 2 对连对会被判 `Invalid` 静音；
- 顺子/连对/飞机的 `keyRank` 取**最大**点数（斗地主取最小），规则判定不能混用；
- 牌型开关由 `pdkRules` 决定（裸三张/三带二/裸飞机/四带二/对子带牌），斗地主没有这些开关；
- 没有王/王炸、没有叫地主/抢地主、没有「四带两对」8 张型。
因此走独立的 `cueForPdkPlay`，只共享「点数 → 素材」映射。

## 2. 范围

**做**：全量复用可用的斗地主语音：单/对/三张点数播报、三带一/三带二、顺子/连对、
飞机（裸/带翅膀）、四带二、炸弹、过牌、报单/报双、输赢。
`voiceAnnouncements` 能力位改 true。

**不做**：王单张/王炸/叫抢语音；新增素材；4 人第 4 条过牌音；服务端/协议消息改动；
语音独立开关（沿用现有音效开关）。

## 3. 决策表

| # | 决策 | 依据/后果 |
|---|---|---|
| D1 | 新增 `src/audio/pdk-play-cues.ts`：`cueForPdkPlay(cards, rules)` | 与 `play-cues.ts`（ddz）分文件；牌型选择可独立单测 |
| D2 | 单/对/三张的点数映射复用 `play-cues.ts` 的共享 helper | 避免第二份 rank 表；2 → 素材序号 15 |
| D3 | 全量复用：牌型 + 过牌 + 报单/报双 + 输赢 | 用户裁决（2026-10-25）；音效开关可关 |
| D4 | 不接王单张、王炸、叫地主/抢地主 | 跑得快没有这些概念 |
| D5 | 4 人局过牌 seat 3 沿用 `Buyao1` | 素材只有 3 条；登记限制（不加素材） |
| D6 | `GAME_META.paodekuai.capabilities.voiceAnnouncements = true` | 能力位如实描述；无消费者依赖，仅契约 |
| D7 | 语音沿用现有音效开关/静音 | 无新配置键；`playCue` 已统一门控 |
| D8 | 报单/报双：任何座位剩 1/2 张都播；结算锁后不播 | 与斗地主同源；4 人局更热闹但可关 |

## 4. 牌型 → 语音映射

| 跑得快 `PdkHandType` | cue | 备注 |
|---|---|---|
| `Single` 3–14 / 17 | `Single{3..14}` / `Single15` | 2 = 17 → 15 |
| `Pair` 3–14 / 17 | `Pair{3..14}` / `Pair15` | |
| `Trio` 3–14 / 17 | `Trio{3..14}` / `Trio15` | 裸三张（受 `bareTrioEnabled`） |
| `TrioWithSingle` | `TrioWithSingle` | 三带一 |
| `TrioWithPair` | `TrioWithPair` | 三带二（受 `trioWithPairEnabled`，默认关） |
| `FourWithTwo` | `FourWithTwo` | 对子带牌受 `fourWithTwoPairKickerAllowed`（默认关）；不是 DDZ 的「四带两对」8 张 |
| `Straight` | `Straight` | |
| `ConsecutivePairs` | `PairStraight` | 连对 |
| `Airplane`（受 `bareAirplaneEnabled`，默认关） / `AirplaneWithWings` | `Plane` | 飞机 |
| `Bomb` | `Bomb` | 裸四张 |
| `Invalid` / 解析抛错 / 未知 | `null` | 静默 |

> **防御性映射**：跑得快牌堆只有一张 2（仅红桃 2），`Pair15` / `Trio15` 在真实对局**不可达**；
> 保留映射只为未来规则变化，测试 fixture 必须遵守 48 张牌（不得造两张 2 或四张 A）。

过牌：`cueForPass(seat)`（seat 3 回退 `Buyao1`）。报单/报双：`Baojing1` / `Baojing2`。
输赢：`Win` / `Lose`（已有）。

## 5. 实现设计

- `play-cues.ts`：导出 `cueForSingleRank(r)` / `cueForPairRank(r)` / `cueForTrioRank(r)`
  （内部复用现有 rank 表），`cueForPlay` 改为调它们（行为不变）。
- `pdk-play-cues.ts`：
  ```ts
  export function cueForPdkPlay(
    cards: Card[],
    rules: PdkRulesConfig | null,
  ): CueName | null {
    // rules === null ⇒ null；parsePdkHand(cards, rules)；按 §4 映射；绝不抛
  }
  ```
- rank helper 签名显式 `CueName | null`，返回处保留 `?? null`
  （`noUncheckedIndexedAccess` 未开，照抄索引会被推成 `CueName`）。
- `useTableSound.ts`：
  - 出牌分支：跑得快调 `cueForPdkPlay(newest.cards, rules)`（rules 为 null ⇒ 静默）；
  - `cardCounts` watcher：删除跑得快豁免，只保留 `store.settlement` 锁；
  - 头注释同步（`cueForPlay`/`cueForPdkPlay` 分别服务两种玩法）；不再写「只播出牌/过牌/输赢」。
- `audio/index.ts`：`cueForPass` 注释补 4 人回退规则（逻辑不变）。
- `packages/protocol/src/game.ts`：pdk `voiceAnnouncements: true`；`game.test.ts` 同步。

## 6. 测试判据

- `pdk-play-cues.test.ts`：全部牌型/点数（fixture 遵守 48 张：只有一张 2、无四张 A）；
  2 → `*15`（防御性）；无王映射；关闭的牌型（三带二/裸飞机/对子带牌）⇒ `null`；
  2 对连对 ⇒ `PairStraight`（与 DDZ 的分界）；空牌/非法/rules=null ⇒ `null`；不抛。
- `pdk-sound.test.ts`：单张精确播 `Woman_6.mp3`；对子/连对/炸弹；过牌；
  4 人 seat 3 过牌精确 `Woman_buyao1.mp3`；报单（2→1）/报双（3→2）在跑得快也播；
  **首版快照已含 1/2 张 ⇒ 零 cue**（bootstrap 不补播），随后真实跃迁 ⇒ 播；
  结算后不播牌型。现有 `toEqual([])` 与 `toContain` 改为精确断言。
- `packages/protocol`：能力位 true（只改 `game.test.ts` 一处）。
- 既有 `play-cues.test.ts` 全绿（ddz 行为不变；rank helper 返回 null 不得变 undefined）。

## 7. 边界与风险

| 场景 | 行为 |
|---|---|
| 4 人局 | 三个对手都播报；过牌 seat 3 用 `Buyao1`（素材限制） |
| 音效关闭/静音 | `playCue` 统一门控，语音不播 |
| 挂载时无视图的首版快照 | 只对齐游标、不补播历史；同一挂载内的 `game.reconnect` 快照仍会 diff（与斗地主同源，已登记） |
| 结算后 | 结算锁；不再播牌型/过牌（与斗地主一致） |
| 关闭的牌型 | `parsePdkHand` 返回 Invalid ⇒ 静默（服务端也不会下发非法牌） |
| 音量/打断 | 沿用 `playCue` 单通道最新优先 |
| 同一次视图更新多条动作 | 只播最新一条（每次状态转移是独立 WS 消息；同 flush 时旧 cue 本来也会被打断） |
| 首次出某点数 | 素材按需下载（DDZ spec D8 同口径，不预热 48 条）；登记为可感知延迟风险 |
| 4 人报单/报双 | 沿用斗地主的震动（`haptic`）；一次出牌只掉一座，不会同 flush 连震 |
| 播报频率放大 | `disposeCue` 的 abandoned 分支被顶掉概率上升；登记（不加超时兜底，保持与 DDZ 同实现） |

## 8. 涉及文件

- `apps/client/src/audio/play-cues.ts`（导出 rank helper）
- 新增 `apps/client/src/audio/pdk-play-cues.ts`
- `apps/client/src/composables/useTableSound.ts`
- `apps/client/src/audio/index.ts`（注释）
- `packages/protocol/src/game.ts`、`game.test.ts`
- `apps/client/test/{pdk-play-cues,pdk-sound}.test.ts`（新/改）
- `docs/games/paodekuai.md`（一句说明）
- 旧多玩法 spec/plan 各加一行「已被 2026-10-25 语音 spec 取代」指针


## 9. 设计对抗审查记录（2026-10-25）

独立 reviewer：**阻断 0 / 高 0 / 低 13**，全部处置。

| 发现 | 处置 |
|---|---|
| rank helper 可能返回 undefined（未开 noUncheckedIndexedAccess） | §5：显式 `CueName \| null` + `?? null` |
| `cueForPdkPlay` 未处理 rules=null | §5：签名 `PdkRulesConfig \| null`，null ⇒ null |
| 漏记 pdk 连对最少 2 对 / keyRank 取最大 / 规则开关 | §1 补为「不能直接复用 cueForPlay」的硬证据 |
| 裸飞机/对子带牌受默认关开关限制 | §4 补注 |
| 只有一张 2 ⇒ Pair15/Trio15 不可达 | §4 注明防御性映射与 fixture 约束 |
| 首版快照/重连不补播报单报双 | §6 补判据 |
| 4 人 seat 3 过牌断言不够精确 | §6 改精确 `Woman_buyao1.mp3` |
| useTableSound 头注释半真 | §5 明确同步 |
| 旧多玩法 spec/plan 冲突 | §8 加取代指针 |
| 首次出牌素材按需下载 | §7 登记 |
| pdk 报单/报双带震动 | §7 登记（一次出牌只掉一座） |
| 同 flush 多条只播最新 | §7 登记 |
| abandoned cue 频率放大 | §7 登记（保持与 DDZ 同实现） |

## 10. 代码审查记录（2026-10-25）

独立 reviewer：**Critical 0 / Important 0 / Minor 9**，全部处置：测试改精确数组断言、
补同快照「牌型→报单」顺序与打断断言、bootstrap 补 `vibrateLong=0`、王 fixture 改合法花色
（由点数上界拦截）、补 Trio15/both/点数遍历/非数组入参、旧计划冲突点补取代注记、
spec 重连措辞收窄、导入合并。
