# 四川麻将：血流成河 + 三个规则开关 + 报牌语音（设计 spec）

> 状态：**v0.2**（v0.1 已过第 1 轮设计对抗审查，本版逐条处置；见 §9 审查记录）。
> 规则真源：`docs/games/mahjong.md`（本片先改它，再由 `doc-sync.test.ts` 锁住）。
> 对标来源：`D:\Code\babykylin_scmj`（幼麟四川麻将开源版，Cocos 2.0.6 + Node v6）。
> 开发流程：`docs/dev-process.md`；新玩法接入红线：`docs/games/adding-a-game-mode.md`。

## 0. 背景与问题

现有平台只有一种麻将口径（四川麻将·血战到底），对标项目有两个玩法：

- **血战到底（xzdd）**：胡牌者退场，其余人打到三家胡或牌墙空 —— 我们已实现。
- **血流成河（xlch）**：胡牌者**不退场**，继续摸打、可多次胡，直到牌墙摸完 —— 我们未实现
  （`docs/games/mahjong.md` §9 明确列为"首版不做"）。

同时对标项目有三项规则口径我们缺：**门清 +1 / 中张 +1**、**点杠花（点炮/自摸）**、
**报牌语音**（27 个牌名 + 11 条动作语音）。

本片把上述玩法/规则/语音**按语义移植**。代码不可直接对接（Cocos/Node6 vs uni-app/NestJS），
只搬素材、规则语义与交互。

**素材授权**：用户裁决本片不考虑授权问题；现有牌面/音频已在 `THIRD-PARTY-NOTICES.md` 登记为
"来源待核实"。本片新增素材（27 条牌名语音）沿用同一登记口径。

## 1. 范围

### 1.1 做

| 切片 | 内容 | 独立可交付 |
|---|---|---|
| **S1 规则开关** | `menQing` / `zhongZhang` 可选番 + `pointGangHuaMode` | ✅ 只动规则/配置/表单 |
| **S2 血流成河** | 房间级 `variant` + 引擎 + 服务 + 历史链 + 客户端 + conformance | ✅ 默认关，好友房先行 |
| **S3 报牌语音** | 27 条牌名语音 + 出牌事件播放 | ✅ 纯客户端 |

### 1.2 不做（YAGNI）

- **血流成河的匹配场**（队列键 5→6 段、池子分裂）—— 另立片；本片**匹配房恒血战**。
- 多局连打（4/8 局）、房卡经济、房主自选底分/封顶。
- 文字/快捷/表情聊天、语音聊天。
- 表情动画、碰杠胡特效、UI 换皮、回放。
- 2/3 人麻将、换三张"洗回牌山重发"变体。
- SBR 官方竞赛口径校准（门清/中张按"可选番"实现，不宣称竞赛口径）。

## 2. 现状审计（实现前已核，含审查追加）

| 层 | 现状 | 本片要动 |
|---|---|---|
| 规则文档 | `mahjong.md` 只有血战口径；§8 有 17 个规则键 | 血流章节 + 3 个规则键 |
| 纯规则 | 事件账结算；`isOut`=胡即退场；`hu` 单条；`cloneSession` 深拷但**不含 huHistory** | `hued` 维度、多胡记录、血流回合 |
| 协议 | `MahjongPlayerView` **无摸牌字段**（`lastDraw` 只在服务端与机器人特征里） | 新增"仅本人"摸牌字段 |
| 协议 | `MahjongRulesConfig` 17 键；`optionalFans` 8 项 | +variant/+pointGangHuaMode，+2 可选番 |
| game-service | `view.ts` 按 `isOut` 投影亮牌；`record.ts` 单 `hu` | 按 `hued` 投影、多胡记录 |
| **记录链** | RPC `RecordWriteRequest.seats` **无 rules/huHistory**；`won` 列 = isOut；历史 DTO 无 rules | 修 `won` 口径 + 变体列/标签（见 §4.7） |
| room-service | 房间无规则选择；开局读全局规则快照；`writeMeta` 只对 `gameType` 特判 undefined | 房间级 `variant` + Hash 读写特判 + 三处恰集闸 |
| config/admin | 11 个麻将键；规则表单 8 组/20 字段/34 番输入；`CONFIG_NOTES` 96 条 | 第 12 键 + 表单 3 项 + 四处计数闸 |
| 客户端 | Board/SeatPanel/Settlement 齐；音效已接 11 条 | 胡态/多胡/变体入口/摸牌高亮/语音 |
| conformance | `slice-36-mahjong`；**driver 弃牌固定取 hand[0]** | 新增 slice-37 + driver 摸牌改造 |

## 3. 决策表

| # | 决策 | 结论 | 依据 / 审查修正 |
|---|---|---|---|
| **D1** | 血流载体 | **房间级 `variant`，GameType 仍 `mahjong`** | 新 GameType 触发全套扩面且池子分裂；全局单键不能并存 |
| **D2** | 首发入口 | **仅好友房（practice）可带 xlch；匹配房（random/gold）恒 xzdd** | 审查高-5：匹配房继承全局变体会让 admin 一拨全变血流；金币场也没有长局资金闸 |
| **D3** | 变体真源 | **规则快照 `rules.variant` 为唯一真源**；房间字段只在开局合并 | 视图/记录/结算都读 `session.rules` |
| **D4** | 血流结束 | **仅牌墙摸完** | 对齐 babykylin xlch |
| **D5** | 已胡者状态 | **新 `hued`（`huHistory.length>0`），`isOut` 保持"退场"** | `activeSeats` 有 4 个调用点（claims/杠付款/胡付款/抢杠），合成一个布尔必错 |
| **D6** | 胡后手牌 | **冻结手牌**：自摸胡把胡牌移出；点炮胡不收牌；**每回合摸一打一**（弯杠除外） | 不写"恒定 13 张"（有杠时为 13−3×副露+杠数，低-6） |
| **D7** | 胡后限制 | **不能碰、不能直杠、不能暗杠；可弯杠** | babykylin 规则文本与代码一致 |
| **D8** | 已胡者支付 | **照付**自摸/暗杠/弯杠/被点炮；**不参与花猪/查叫/退税** | 审查高-10：babykylin 的查叫**收款侧仍会把 hued 算进去**（其 hued 手牌常有听牌面）。我们**有意偏差**：双向排除，写进规则文档 + deviation ledger |
| **D9** | 点炮胡后谁摸 | **放炮者下家** | 与现有血战一致；babykylin 的"最后胡者下家"是实现怪癖，不移植 |
| **D10** | 门清/中张载体 | `optionalFans.menQing` / `.zhongZhang`，默认 0 | 加法番；默认关 = 行为不变 |
| **D11** | 门清/中张生效路径 | **named + additive 两条都生效** | 只进 named 会成为 sbr 下的死配置（`chajiaoAllSameState` 教训） |
| **D12** | 点杠花键名/默认 | `pointGangHuaMode: 'selfDraw' \| 'dianPao'`，默认 `selfDraw` | 默认保持现状（我们当前 = 杠上花自摸） |
| **D13** | 点杠花实现 | **不改 `selfDraw` 调用参**：`checkHu` 仍按自摸组牌；新增 `HuContext.pointGangHua` 事实，只改**付款人与自摸加成** | 审查高-3：传 false 会让手牌拼成 15 张、必胡不了；且会误触发过水锁 |
| **D14** | 血流 kill switch | 新增 `game.mahjong.xlchEnabled`（默认 false） | 好友房建房与所有 xlch 开局双闸 |
| **D15** | 报牌语音通道 | 走现有 SFX 通道，不新增设置项 | 尊重静音/音效关闭 |
| **D16** | 报牌语音触发 | 仅出牌（所有座位） | 对齐 babykylin `game_chupai_notify` |
| **D17** | 摸牌事实出站 | 视图新增 `lastDrawTile?`（**仅本人**） | 审查阻断-1：否则血流"只能打摸牌"在哑终端与 conformance 驱动下不可实现 |
| **D18** | 历史链 | 本片**必须**修 `won` 口径与变体标签（见 §4.7） | 审查阻断-2：`won`=isOut 会让 xlch 赢家全显示"未胡" |

## 4. 实现设计

### 4.1 规则文档（先改，后由 doc-sync 锁）

`docs/games/mahjong.md`：

- 新增 **§3A 血流成河（`variant='xlch'`）**：
  1. 开局时序与血战相同（换三张 → 定缺 → 庄摸第 14 张）。
  2. 胡牌后**不退场**：手牌**冻结**（自摸胡把胡牌移出、点炮胡不收牌）；每回合摸 1 张、
     **只能打出刚摸的这张**（弯杠后打补牌）；可继续自摸/点炮胡，**可多次胡**。
  3. 胡后**不能碰、不能直杠、不能暗杠；可弯杠**。
  4. 已胡者**照付**自摸/杠分、可被点炮；**不参与花猪/查大叫/退税**（双向）。
     ⚠️ 与 babykylin 的有意偏差：其查叫收款侧含 hued，本片按"已胡者不进不出"。
  5. 结束：**牌墙摸完**；`liuju` 仅当**无赢家**时为 true（有赢家不显示荒庄）。
  6. 已胡者手牌**公开**（冻结手牌）。
  7. 点炮胡后**放炮者下家**摸牌；自摸胡后胡牌者下家摸牌。
  8. 抢杠、过水、最后四张必胡、海底、呼叫转移：与血战同口径。
- §4 番表：新增**可选番**门清/中张（默认 0）：
  - 门清：副露无碰、无明杠、无补杠（暗杠不影响）。
  - 中张：手牌 + 副露均非 1/9；**主番为将对时不计**。
  - ⚠️ 中张判定与断幺九同源（`!hasTerminalTile`），两键同开会对同一特征重复计番 —— 文档写明。
- §5 杠：`pointGangHuaMode='dianPao'` 时**仅直杠后补牌胡**按点炮结算给放杠者、
  不计自摸加成（`selfDrawBonusBase=0`、不加自摸番）、仍计杠上花番；`selfDraw`（默认）不变。
- §8 配置键：新增 `variant`、`pointGangHuaMode`、`optionalFans.menQing/zhongZhang`、
  `game.mahjong.xlchEnabled`。
- §9 "首版不做"删除"语音素材"条目（S3 后）。
- `doc-sync.test.ts`：血流章节关键词、三键默认值、variant 枚举。

### 4.2 协议层（`packages/protocol`）

`mahjong/rules.ts`：

```ts
export type MahjongVariant = 'xzdd' | 'xlch';
export type MahjongPointGangHuaMode = 'selfDraw' | 'dianPao';
interface MahjongOptionalFans { /* 现有 8 项 */ menQing: number; zhongZhang: number; }
interface MahjongRulesConfig { /* 现有 */ variant: MahjongVariant; pointGangHuaMode: MahjongPointGangHuaMode; }
```

- 两套预设默认：`variant:'xzdd'`、`pointGangHuaMode:'selfDraw'`、`menQing:0`、`zhongZhang:0`
  —— **默认输出与今天逐字节等价**。
- `parseMahjongRules`：缺键补默认；非法值抛 `ProtocolError`。
- `MAHJONG_OPTIONAL_FAN_KEYS` 追加两项。
- `mahjong/types.ts`：
  - `MahjongPlayerView.lastDrawTile?: Tile` —— **仅接收者本人**（重建快照同样下发；
    服务端只在本人的 view 填，其他人的 view 不填，避免"摸牌=手牌信息"出站）。
  - `MahjongRecordSeat` 增加 `huHistory?: MahjongHuInfo[]`；`hu` 保留**最后一条**（旧读侧兼容）。
  - `MahjongSettlementResult.winnerSeats` = 有胡记录者；新增 `variant: MahjongVariant`；
    `endReason` 血流恒 `wallEmpty`；`liuju` 血流 = 无赢家。
- `validate.ts`：`assertMahjongPlayerView` 增 `lastDrawTile` 可选 `assertTile`；
  `assertMahjongSettlement` 增 `variant` 枚举断言（现校验器不拒未知键，但新字段必须被锁）。
- `mahjong/rule-summary.ts`：新增 `MAHJONG_XLCH_RULE_SUMMARY`，`gameModes.ts` 按变体引用
  （审查低-3：现文案写死血战口径）。
- `GAME_META.mahjong.capabilities.voiceAnnouncements`：S3 起改 `true`
  （审查低-4：能力位要接消费点，`useTableSound` 已有）。

### 4.3 纯规则层（`packages/shared/mahjong`）

**session.ts**

```ts
interface MahjongPlayer { isOut: boolean; huHistory: MahjongHuInfo[]; /* 替换 hu */ }
```

- 新增 `isHued(p)` / `huedSeats(s)` helper；`activeSeats()` 语义**不变**（退场过滤）。
- `cloneSession`：深拷 `huHistory: p.huHistory.map((h) => ({ ...h }))`（审查低-7）。
- `finish()` / `finishMahjong`：`winnerSeats` 取 `huHistory` 非空座位；`liuju` 血流 = 无赢家。
- `lastDraw` 扩为 `{ seat, tile, fromKong, kongKind?: 'melded'|'added'|'concealed', gangPayer?: number }`，
  由 `drawFor(..., fromKong=true)` 从最近一次杠事件填充（审查 (c)：与抢杠清空不冲突）。

**claims.ts**

- `checkHu`：`isOut` 拒绝；hued 允许。**签名不变**（点杠花不改 selfDraw 参）。
- `canPeng` / `canGangFromDiscard`：xlch 下 hued 拒绝。
- `claimCandidates`：hued 仍进胡候选；碰/杠由上面自然过滤。
- `huContext`：新增 `pointGangHua`：
  `selfDraw && last.fromKong && last.kongKind === 'melded' && rules.pointGangHuaMode === 'dianPao'`。

**actions.ts**

- `discard`：xlch 下 hued 只能打 `lastDraw.tile`，否则 `ProtocolError`。
- `concealedGang`：xlch 下 hued 拒绝；`addedGang`：hued 允许（弯杠，可被抢）。
- `markHu`：新增 `payerSeat?: number` 参数（点杠花用），并分支：
  - xzdd：现状（isOut=true；点炮胡收牌入手的旧行为保留）。
  - xlch：push `huHistory`；自摸胡把 `lastDraw.tile` 移出手牌；点炮胡不改手牌；不置 isOut。
  - `payerSeat` 提供时：**不触碰任何人的手牌/弃牌堆**，`addHuEvent` 的付款人 = `[payerSeat]`。
- `addHuEvent`：付款人 = `payerSeat ?? (fromSeat === null ? activeSeats(含 hued) : [fromSeat])`。
- `applySelfDrawHu` / `resolveClaims`：xlch 不触发 `threeWinners`。
- `checkFinished`：xlch 只在 `wall.length === 0` 结束。
- `autoAction`：xlch 下 hued 不能胡时**必须打 `lastDraw.tile`**（现有实现打最小牌，会撞新校验）。

**scoring.ts**

- `HuContext.pointGangHua` 传入 `scoreNamed/scoreAdditive`：
  - `selfDrawBonusBase` 计算加 `&& !ctx.pointGangHua`；
  - `selfDrawMode==='addFan'` 的自摸番加 `&& !ctx.pointGangHua`；
  - `winAfterKong` 不变（杠上花番照计）。
- named 路径（`gen` 之后、自摸加成之前）+ additive 路径（`underTheSea` 之后）追加：
  - `optionalFans.menQing>0 && 门清` → +N，item `门清+N`；
  - `optionalFans.zhongZhang>0 && 中张 && baseName!=='jiangDui'` → +N，item `中张+N`。
- ⚠️ 测试注意：sbr `fanCap=3` 会让高特征手撞顶（审查低-1），断言用**低特征手**；
  并登记"现有 8 个 optionalFans 在 additive 路径本就未消费"这一既有不对称（另立片）。

**settle.ts**

- 新增 `notHuedSeats(session)` = `!isOut && huHistory.length===0`；
  **花猪/查叫/退税一律用它**。
- `huazhuPayees==='nonFlowerPig'` 分支的 `[0,1,2,3]` 硬编码改为 `notHuedSeats`（审查高-6）。
- `winnerSeats` = huHistory 非空座位；`liuju` 血流 = winnerSeats 为空；零和断言不变。

### 4.4 game-service（`games/mahjong`）

- `view.ts`：
  - `lastDrawTile`：仅当 `session.currentPlayer === seat && state==='play'` 时填 `lastDraw.tile`。
  - `huInfos` = `players.flatMap(p => p.huHistory)`。
  - `revealedHands`：xzdd=isOut、xlch=hued。
  - `tingSeatsOf`：跳过 hued。
  - `claimsForMe`：
    - claim 窗口：hued 只出 `hu`/`pass`；
    - play 分支（审查高-4）：**hued 过滤暗杠、保留弯杠**，并只允许 `lastDrawTile` 作为可出牌。
  - 注：`view.activeSeats` 实为"待决策座位"（`pendingSeats`），与 shared `activeSeats` 同名字异义，
    文档/注释写清（审查高-6）。
- `runtime.ts`：`autoAction` 委托 shared。
- `record.ts`：`seats[].huHistory`；`hu`=最后一条；`resultSummary.endReason/liuju/winnerSeats` 用新口径。

### 4.5 room-service

- `RoomMeta` / `Room` / `RoomInfo` 新增 `variant?: MahjongVariant`。
  - **`META_FIELDS` + `OPTIONAL_META_FIELDS` 都要加**（审查高-1）；
  - `writeMeta`：`variant` 无值写**空串**（不是 `"undefined"`）；`readMeta` 空串/缺失归一为 undefined；
  - 同提交更新三处机械闸：`tools/conformance/src/slices/slice-07.2-hardening.ts` 的
    `ROOM_META_FIELDS` 恰集、`packages/room-service/test/rooms.service.test.ts` 的"恰好八个字段"、
    `slice-06-auth-rooms.ts` 的 `RoomInfo` 恰键集。
- `CreateRoomDto`：`@IsOptional() @IsIn(['xzdd','xlch']) variant?` + 控制器显式白名单。
- `RoomsService.create`：variant 仅麻将房合法；非麻将房带 variant ⇒ `12012`。
- `rooms.start.ts` 规则快照：

```ts
const isPractice = room.mode === 'practice';
const variant: MahjongVariant = isPractice ? (room.variant ?? rules.variant) : 'xzdd';
if (variant === 'xlch' && !this.configCache.mahjongXlchEnabled()) {
  return this.failPdkStart(code, room, filled.seats, 'rules', 'xlch disabled', options.onSeats);
}
rules = { ...rules, variant };
```

  - **匹配房强制 xzdd**（D2）；好友房用房间字段，缺省取全局默认（admin 的"好友房默认变体"）。
  - 快照随 `game.start(strict:true, rules)` 下发，幂等判据不变。
- `config-cache.service.ts`：`mahjongXlchEnabled()`（默认 false）。
- 顺手修 `failPdkStart` 的失败指标标签恒为 `'paodekuai'`（审查低-8，一行）。

### 4.6 config-service / admin

- 配置键新增 `game.mahjong.xlchEnabled`（第 12 键，`EXACT_KEYS` 等闸同步）。
- `admin/app.js` 规则表单：
  - "玩法变体"选择（xzdd/xlch，标注"**仅好友房默认值；匹配场恒血战**"）；
  - "可选番"追加门清/中张；"杠与转账"追加点杠花模式。
- **四处硬编码计数同提交更新**（审查高-8）：
  - `scripts/admin-mahjong-rules-form-probe.mjs`：8 组 → 9 组、20 字段 → 22、34 番输入 → 36；
  - `scripts/verify-admin-static.mjs`：`CONFIG_NOTES` 96 → 97 条；
  - `admin-rules-form.gate.test.ts`：`groups.length===8` → 9；fanLabels 覆盖新键；
  - `admin/app.js` 的 `CONFIG_NOTES` / `MAHJONG_RULES_FORM` 条目。
- 验证命令追加 `pnpm verify:admin-mahjong-rules`（CI 已接入）。

### 4.7 历史/记录链（审查阻断-2，本片必做）

- `SettlementResult`：`MahjongSettlementResult.variant`（§4.2）随 `result` 全量进记录。
- user-service `record.rpc.controller.ts`：
  - `won` 列改为 `result.winnerSeats.includes(seat.seat)`（不再用 `is_out`）；
  - `game_records_mahjong` 新增 `variant VARCHAR(8) NULL` 列（**新迁移**，时间戳沿用
    `1798…` 之后的下一号段，避开历史撞车）；
  - 记录查询 SQL/DTO 返回 `variant`。
- `records.service.ts` + `apps/client/src/pages/history/history.vue`：
  - 座位"胡/未胡"改用 `winnerSeats`（不再读 `isOut`）；
  - 记录卡片显示变体标签（血战到底/血流成河）。
- `MahjongRecordView` 增加 `variant`（可选，旧记录 null ⇒ 按血战显示）。
- 测试：user-service 记录单测 + 历史页渲染 + 迁移 up/down。

### 4.8 客户端（`apps/client`）

- **入口门控**（审查高-2）：`ClientGameConfig` 增加 `xlchEnabled?: boolean`（缺省 false）；
  `client-config.controller.ts` 映射 `game.mahjong.xlchEnabled`；store 读取；
  `rest.createRoom` 负载类型加 `variant?`。`/api/config/boot` **不动**（有恰键集闸）。
- **好友房**：`game.vue` 弹层新增"血流成河"选项（仅 mahjong + `xlchEnabled` 时显示），
  创建时带 `variant:'xlch'`。
- **牌桌读点**（审查高-7，逐个改）：
  - `myHu`：`.find` → 取**最后一条**（或按需全列）；
  - `seatPanelProps.hu`：`.find` → 全部/最后一条 + 胡次数；
  - 胡 banner 的 `seenHuSeats` Set：改为按 `(seat, huInfos 中该座序号)` 去重；
  - `endReason`：不再用 `isOut` 计数，改用 `huInfos` 去重座位数；
  - hued 本人的手牌**只渲染一处**（去掉 `hand` 与 `myRevealed` 双渲染）；
  - `lastDrawTile` 高亮；hued 时只能点它（服务端仍兜底）。
- **结算/历史文案**：`liuju` 且无赢家才显示"荒庄"；血流显示"牌墙摸完"（审查低-2）。
- **规则介绍**：按 `mahjongRules.variant` 选 `MAHJONG_RULE_SUMMARY` / `…XLCH…`。
- **报牌语音（S3）**：
  - 素材：babykylin `nv/` 27 条牌名；**花色映射**（审查低-5）：
    babykylin 筒 0–8→21–29、条 9–17→1–9、万 18–26→11–19；我们的 `Tile.s` 是
    `0=万/1=筒/2=条` ⇒ `wan r → 10+r`、`tong r → 20+r`、`tiao r → r`（1–9）。
  - 命名 `Mj_voice_wan_1.mp3…`；**必须匹配 `[A-Za-z0-9_]+\.mp3` 且无孤儿文件**
    （`asset-budget.test.ts` 双向比对）；`table/audio` 实测 ~1868/2048 KiB，27 条约 71 KiB
    转码后放得下，超 184 KiB 即红。
  - `audio/mahjong-voice.ts`：`tileVoiceCue(tile)`；`useTableSound` 按座位 diff `discards`，
    新弃牌播牌名；bootstrap 不补播、结算锁后不播；走 SFX 通道。
  - `capabilities.voiceAnnouncements` 改 true。

### 4.9 conformance

- **driver 改造**（审查阻断-1）：`tools/conformance/src/lib/mahjong-driver.ts` 的
  `pickDiscardTile` 优先用视图 `lastDrawTile`（服务端下发时），否则 hand[0]；补 driver 单测。
- 新增 `slice-37-mahjong-xlch`：
  1. 保存**整份** `game.mahjong.rules` 快照（不只 variant）后再 PUT，收尾**整份还原**
     （审查高-9：否则污染测试服人工配置）；`enabled/freeRoomEnabled/xlchEnabled` 按 slice-36 纪律还原。
  2. 好友房路径建房（带 `variant:'xlch'`）→ 校验视图中 `mahjongRules.variant==='xlch'`、无泄漏。
  3. 驱动打到牌墙空：断言首胡后对局**未结束**、**某 hued 座位仍收到回合并成功打出摸牌**
     （强于"出现在 activeSeats"）、4 座零和、`endReason='wallEmpty'`、`winnerSeats` 与
     `huInfos` 座位一致。
  4. 记录：`gameType='mahjong'`、`variant='xlch'`、`won` 与 `winnerSeats` 一致。
  5. 匹配房回归：同一开关下 random 房仍是 xzdd。
- `slice-36` 不回归（xzdd 语义不变）。

## 5. 测试判据

| 层 | 判据 |
|---|---|
| protocol | 规则解析默认/非法值；`lastDrawTile` 只在本人视图；admin 表单键集/组数/字段数/番行数 |
| shared | 血流真值表：胡后不退场/手牌冻结/只能打摸牌/禁碰杠(弯杠例外)/多次胡/结束=墙空；已胡者付自摸杠、不参与花猪查叫退税；点炮胡后放炮者下家摸牌；零和 |
| shared | 点杠花：`checkHu` 仍按自摸组牌（**15 张回归锚**）；dianPao 只对直杠、payer=放杠者、无自摸加成、仍计杠上花；selfDraw 输出与今日逐字节一致 |
| shared | 门清/中张：named+additive 两路径；低特征手断言（避开 fanCap 饱和）；将对不计中张；默认 0 输出不变 |
| shared | `cloneSession` 深拷 huHistory；xzdd 现有测试全绿 |
| game-service | 视图：lastDrawTile 归属、hued 亮牌、claim/play 候选过滤（弯杠保留/暗杠过滤）；记录 huHistory |
| room-service | variant 合法/非法/闸；writeMeta 不写 "undefined"、readMeta 归一；恰集闸；匹配房恒 xzdd |
| user-service | `won` 由 winnerSeats；variant 列迁移 up/down；历史 DTO |
| client | 多胡四处读点、双渲染、荒庄文案、变体介绍、入口门控、`tileVoiceCue` 映射（含花色顺序）、弃牌 diff 播放 |
| 素材 | `asset-budget.test.ts` 全绿（42 假设：命名/孤儿/体积） |
| conformance | slice-37 真栈；slice-36 不回归；测试服配置整份还原 |
| 全量 | `pnpm exec turbo run test lint`、`pnpm verify:admin`、`pnpm verify:admin-mahjong-rules`、H5 build、真浏览器冒烟 |

## 6. 错误处理与边界

- 旧数据：无 `variant` ⇒ xzdd；旧规则 JSON 无新键 ⇒ 默认；旧记录无 variant ⇒ 按血战显示。
- fail-closed：`xlchEnabled=false` 时任何 xlch 房开局失败（`failPdkStart('rules')`），不降级为 xzdd。
- 非法组合：非麻将房带 variant ⇒ `12012`；非法值 ⇒ `10001`。
- 托管/超时/机器人：共用 `autoAction`；hued 自动出牌 = 打摸牌。
- 牌墙空与 claim：最后一次弃牌仍开窗口；结算完无人胡才荒庄（与血战同）。
- 资金：血流仅好友房（无抽水/门槛）；金币场 `burn48` 闸原样生效。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `isOut`/`hued` 混用 | D5 分离；4 个 `activeSeats` 调用点逐处判；settle 零和 + slice-37 |
| 记录链漏改（赢家显示未胡） | §4.7 纳入本片范围；user-service 测试 + 历史页测试 |
| Hash 元数据写坏房间 | variant 进 OPTIONAL + 写空串/读归一 + 三处恰集闸同提交 |
| 匹配场被误切血流 | D2 匹配房强制 xzdd；conformance 回归断言 |
| 死配置重演 | 门清/中张两路径 + 点杠花两档差异断言；既有 optionalFans 不对称另登记 |
| 客户端多胡/双渲染 | §4.8 四处读点逐条改 + 组件测试 |
| 测试服污染 | slice-37 整份规则快照保存/还原 |
| 语音素材预算/命名 | 转码前先跑 asset-budget；命名正则；花色映射单测 |
| 局时长/机器人资金 | 好友房先行；conformance 观察时长 |

## 8. 涉及文件（预估）

**规则/协议**：`docs/games/mahjong.md`、`packages/protocol/src/mahjong/{rules,types,rule-summary}.ts`、
`packages/protocol/src/{config,game,validate}.ts`、`packages/shared/src/mahjong/{session,claims,actions,scoring,settle,doc-sync.test}.ts`
**服务**：`packages/game-service/src/games/mahjong/{view,record,runtime}.ts`、
`packages/room-service/src/{rooms,config,gateway}/**`、`packages/protocol/src/rpc.ts`、
`packages/user-service/src/{rpc/record.rpc.controller,records/records.service}.ts` + 新迁移、
`packages/config-service/src/config/client-config.controller.ts` + 新键种子
**admin/门禁脚本**：`admin/app.js`、`scripts/admin-mahjong-rules-form-probe.mjs`、
`scripts/verify-admin-static.mjs`、`packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`
**客户端**：`apps/client/src/pages/game/game.vue`、`components/table/mahjong/*`、
`components/MahjongSettlement.vue`、`pages/history/history.vue`、`stores/game.ts`、`net/rest.ts`、
`audio/{cues,index,mahjong-voice}.ts`、`composables/useTableSound.ts`、`pages/table/static/audio/Mj_voice_*.mp3`
**conformance**：`tools/conformance/src/lib/mahjong-driver.ts`、
`tools/conformance/src/slices/slice-37-mahjong-xlch.ts`、`slice-06/auth`、`slice-07.2/hardening`、`run.ts`

## 9. 审查记录

### 第 1 轮（2026-10-29，独立 reviewer，v0.1 → v0.2）

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断-1 | 血流"只能打摸牌"无出站数据源；driver 固定打 hand[0] | D17：视图新增仅本人 `lastDrawTile`；driver 改造 + 单测；用户裁决进 §4.8/4.9 |
| 阻断-2 | 记录链不承载 variant/huHistory，`won`=isOut ⇒ 血流赢家全显示未胡 | D18 + §4.7 纳入本片：`won` 由 winnerSeats、新 variant 列、历史页改读 winnerSeats |
| 高-1 | `writeMeta` 会把 undefined 写成 `"undefined"`，匹配房开局必失败 | §4.5：variant 进 META+OPTIONAL、写空串/读归一、三处恰集闸同提交 |
| 高-2 | 客户端门控载体写错（boot 恰键集；实际读 `/api/config`） | §4.8：`ClientGameConfig.xlchEnabled` + 控制器映射 + store + rest 类型 |
| 高-3 | 点杠花"selfDraw 传 false"会导致 15 张手牌、永远胡不了 | D13 + §4.3：签名不变，`HuContext.pointGangHua`，只改付款/加成；markHu 新 `payerSeat` 分支 |
| 高-4 | `claimsForMe` play 分支会砍掉弯杠、留下暗杠 | §4.4：hued 过滤暗杠、保留弯杠、只允许摸牌出牌 |
| 高-5 | 全局 variant 会让 admin 一键把匹配/金币场全切血流 | D2：匹配房强制 xzdd；admin 标注"仅好友房默认值" |
| 高-6 | `activeSeats` 4 个调用点；settle `nonFlowerPig` 硬编码绕过过滤 | §4.3/§4.4：逐点判定；nonFlowerPig 改用 notHuedSeats；写明 view/settle 同名异义 |
| 高-7 | 客户端 4 个读点 + 双渲染未列 | §4.8 逐个点名 |
| 高-8 | admin 探针 8/20/34、CONFIG_NOTES 96、gate groups 8、CI 探针未列 | §4.6 四处计数 + `verify:admin-mahjong-rules` |
| 高-9 | slice-37 不整份还原会污染测试服；断言过弱 | §4.9：整份快照还原；改"hued 座位成功打出摸牌" |
| 高-10 | D8"对齐 babykylin"不成立（其查叫收款含 hued） | D8/§4.1：标记为**有意偏差**，写规则文档 + deviation ledger |
| 低-1 | additive 路径 fanCap 饱和 + 既有 optionalFans 不对称 | §4.3 测试指引；既有不对称另立片 |
| 低-2 | `liuju` 恒 true ⇒ 有赢家也显示荒庄 | §4.1/§4.7：血流 liuju=无赢家；结算/历史文案同改 |
| 低-3 | 玩法介绍文案写死血战口径 | §4.2：新增 XLCH 文案按 variant 引用 |
| 低-4 | 能力位 voiceAnnouncements=false、文档 §9 残留 | §4.2/S3 改 true；§4.1 删条目 |
| 低-5 | 素材预算/命名/花色映射 | §4.8：映射公式、命名正则、预算跑闸 |
| 低-6 | "手牌恒定 13 张"在有杠时不成立 | D6 改为"冻结手牌 + 摸一打一" |
| 低-7 | `cloneSession` 未深拷 huHistory | §4.3 补 |
| 低-8 | `failPdkStart` 指标标签恒 paodekuai | §4.5 顺手修 |

**结论**：v0.2 已处置全部阻断与高优先级项，可进入实现计划阶段（plan 仍需过计划对抗审查）。

## 10. 切片与顺序

1. **S1 规则开关**（门清/中张/点杠花）—— 最小、先落地。
2. **S2 血流成河** —— 协议 → shared → game-service → room → user-service/历史 → client → conformance。
3. **S3 报牌语音** —— 纯客户端，可与 S2 并行。

S1/S2 独立可回滚；S2 默认暗上线（`xlchEnabled=false`，仅好友房可开）。
