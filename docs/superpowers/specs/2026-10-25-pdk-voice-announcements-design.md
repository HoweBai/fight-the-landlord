# 跑得快语音播报（复用斗地主）· 设计 spec

> 日期：2026-10-25。分支：`dev`。范围：**纯客户端 + `GAME_META` 能力位**；
> 不动服务端、不加素材、不加配置键。
> 依据：`2026-10-22-card-voice-announcements-design.md`（斗地主语音全量接入）。

## 1. 背景与现状

斗地主已有 50 条牌型播报素材（牌桌分包 `/pages/table/static/audio/`）与成熟接线：
`cueForPlay`（`parseHand` 选音）、`cueForPass`、`cueForBid`、报单/报双、输赢。
跑得快目前只播：炸弹 `Bomb`、过牌 `Buyao*`、输赢；其余出牌静音。
`GAME_META.paodekuai.capabilities.voiceAnnouncements = false`。

跑得快与斗地主共享牌面编码（3–14 / 17=2）与大部分牌型语义，多数语音可直接复用；
差异只有：没有王/王炸、没有叫地主/抢地主、没有「四带两对」8 张型。

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
| `TrioWithPair` | `TrioWithPair` | 三带二（受 `trioWithPairEnabled`） |
| `FourWithTwo` | `FourWithTwo` | 含对子带牌；不是 DDZ 的「四带两对」8 张 |
| `Straight` | `Straight` | |
| `ConsecutivePairs` | `PairStraight` | 连对 |
| `Airplane` / `AirplaneWithWings` | `Plane` | 飞机 |
| `Bomb` | `Bomb` | 裸四张 |
| `Invalid` / 解析抛错 / 未知 | `null` | 静默 |

过牌：`cueForPass(seat)`（seat 3 回退 `Buyao1`）。报单/报双：`Baojing1` / `Baojing2`。
输赢：`Win` / `Lose`（已有）。

## 5. 实现设计

- `play-cues.ts`：导出 `cueForSingleRank(r)` / `cueForPairRank(r)` / `cueForTrioRank(r)`
  （内部复用现有 rank 表），`cueForPlay` 改为调它们（行为不变）。
- `pdk-play-cues.ts`：
  ```ts
  export function cueForPdkPlay(cards: Card[], rules: PdkRulesConfig): CueName | null {
    // parsePdkHand(cards, rules)；按 §4 映射；绝不抛
  }
  ```
- `useTableSound.ts`：
  - 出牌分支：跑得快调 `cueForPdkPlay(newest.cards, rules)`，`null` 静默；
  - `cardCounts` watcher：删除跑得快豁免，只保留 `store.settlement` 锁；
  - 头注释同步（不再写「只播出牌/过牌/输赢」）。
- `audio/index.ts`：`cueForPass` 注释补 4 人回退规则（逻辑不变）。
- `packages/protocol/src/game.ts`：pdk `voiceAnnouncements: true`；`game.test.ts` 同步。

## 6. 测试判据

- `pdk-play-cues.test.ts`：全部牌型/点数；2 → `*15`；无王映射；关闭的牌型（如三带二）
  ⇒ `null`；空牌/非法 ⇒ `null`；不抛。
- `pdk-sound.test.ts`：单张播 `Woman_6`；对子/连对/炸弹；过牌；4 人 seat 3 过牌；
  报单（2→1）/报双（3→2）在跑得快也播；结算后不播牌型。
- `packages/protocol`：能力位 true。
- 既有 `play-cues.test.ts` 全绿（ddz 行为不变）。

## 7. 边界与风险

| 场景 | 行为 |
|---|---|
| 4 人局 | 三个对手都播报；过牌 seat 3 用 `Buyao1`（素材限制） |
| 音效关闭/静音 | `playCue` 统一门控，语音不播 |
| 重连/重挂载 | bootstrap 只对齐游标，不补播历史 |
| 结算后 | 结算锁；不再播牌型/过牌（与斗地主一致） |
| 关闭的牌型 | `parsePdkHand` 返回 Invalid ⇒ 静默（服务端也不会下发非法牌） |
| 音量/打断 | 沿用 `playCue` 单通道最新优先 |

## 8. 涉及文件

- `apps/client/src/audio/play-cues.ts`（导出 rank helper）
- 新增 `apps/client/src/audio/pdk-play-cues.ts`
- `apps/client/src/composables/useTableSound.ts`
- `apps/client/src/audio/index.ts`（注释）
- `packages/protocol/src/game.ts`、`game.test.ts`
- `apps/client/test/{pdk-play-cues,pdk-sound}.test.ts`（新/改）
- `docs/games/paodekuai.md`（一句说明）
