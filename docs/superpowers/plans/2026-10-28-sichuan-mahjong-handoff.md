# 四川麻将 · 会话交接（2026-10-28）

> 分支：`majiang`。规则真源：`docs/games/mahjong.md`。
> 设计：`docs/superpowers/specs/2026-10-28-sichuan-mahjong-design.md` v0.2。
> 计划：`docs/superpowers/plans/2026-10-28-sichuan-mahjong.md` v0.1（已过一轮计划审查）。
> 素材：幼麟棋牌（牌面/音效已提取到 `apps/client/src/pages/table/static/{mahjong,audio/mahjong}`）。

## 已完成（均有提交）

| 提交 | 内容 |
|---|---|
| `5796a5b2` | 设计 spec v0.2（第 1 轮对抗审查修订） |
| `e4244807` | 实现计划 v0.1 |
| `3f41d433` | protocol 麻将类型/视图/结算/动作 + `game.play.mahjong` + `RequestMeta.windowId` |
| `775a9f6f` | 牌堆/发牌/换三张/定缺/副露 |
| `8f34214d` | 多行动者窗口内核（pendingActors/acceptsAction/windowId/deadline/CAS/机器人/托管） |
| `2adb3f8d` | `startTurnTimer` 只读 deadline（拒绝/超时不续命） |
| `220484f9` | 形状三路守卫 + `game.mahjong.*` 配置键 + `parseMahjongRules` |
| `9a61daa9` | 胡牌/番型/听牌/状态机/事件账结算/autoplay + 真值表 |
| `2e577d80` | MahjongRuntime/view/record + mahjong/windowId 入站全链 |
| `76ce77e2` | 配置种子/读取器/客户端 boot/开局规则快照 |
| `9891558a` | `CurrencyBurn.penalty` + `burned_penalty` 列 + settle 麻将 burn |
| `eda5dd26` | 用户记录双表 + record/moneyDelta + prepareRecord 麻将字段 |

## 最近绿灯

- protocol 313；shared 433；game-service 280；room-service 1003；currency 590；config 492。
- `tsc --noEmit`：protocol/shared/game-service/room-service/currency-service/user-service/config-service 均绿（客户端未跑）。

## 未提交 / 进行中（T11 客户端）

工作树已有：
- `apps/client/src/gameModes.ts` 加麻将条目 + `CLIENT_TABLE_PLAYER_COUNTS.mahjong=[4]`。
- `packages/protocol/src/messages.ts`：`game.current_turn` 加 `seats?`/`windowId?`；`game.finished` 加 mahjong 形状。
- `packages/room-service/src/gateway/ws.gateway.ts`：`currentTurnPayload` 产出 `seats`/`windowId`。
- `apps/client/src/pages/table/static/mahjong/`：27 张牌 + 牌背（75×113，幼麟 HK 套从 `Z_my`/`Z_bottom` 提取）。
- `apps/client/src/pages/table/static/audio/mahjong/`：碰/杠/胡/刮风/下雨/发牌/洗牌/理牌/倒计时/两首 BGM。

还需：
1. `apps/client/src/stores/game.ts`
   - `ActiveTurn` 加 `seats: number[]`/`windowId?`，`game.current_turn` 赋值。
   - `mahjongView` getter；`isMyTurn` 对麻将用 `view.activeSeats.includes(mySeat)`。
   - `ddzView`/ddz 系 getter 排除 mahjong（现在 `!== 'paodekuai'` 会把麻将当斗地主）。
   - `finished` 状态加 mahjong 分支；`game.finished` payload 处理。
2. `apps/client/src/components/table/mahjong/MahjongBoard.vue`
   - props 同 PdkBoard；emit `mahjong(action, windowId?)`/`trustee`/`more`/`leave`。
   - 牌面 `static/mahjong/{wan,tong,tiao}-1..9.png` + `back.png`；四向用 CSS 旋转。
   - 定缺/换三张/出牌/碰杠胡过/倒计时/牌墙/副露/弃牌/已胡亮牌/花猪/查叫/退税。
   - 只展示 `claimsForMe`；不判规则。
3. `apps/client/src/components/MahjongSettlement.vue`（番型/杠分/退税/花猪/查叫/burn/writtenOff）。
4. `apps/client/src/pages/table/table.vue`
   - 引入 `MahjongBoard`/`MahjongSettlement`；`ddzView` 排除 mahjong。
   - 分支：ddz `!isPdk && !isMahjong`；pdk `isPdk`；mahjong `isMahjong`。
   - `send()` 加 `windowId?`，`onMahjong` 调 `send('game.play',{mahjong:action},windowId)`。
5. `apps/client/src/net/socket.ts`
   - `buildRequestPayload(type,payload,baseVersion,windowId?)` 输出 `windowId`；`send(type,payload,windowId?)` 透传。
6. `apps/client/src/audio/cues.ts`/`useTableSound` 接麻将 cue（peng/gang/hu/guafeng/rain/deal/shuffle/sort/timeup）。
7. `THIRD-PARTY-NOTICES.md` 新增幼麟素材来源/待清权属说明。
8. `pnpm -C apps/client test`、`pnpm -C apps/client run lint`、真浏览器 e2e。

## 计划审查未闭合项（按优先级）

- **结算截断层**：当前 `settleMahjong` 产未截断事件账，`computeSettlement` 仍走净额 pool/最大余数（不是逐事件 payer 截断）；记录 `scoreChanges` 与 `moneyDelta` 可能双源。计划审查要求把截断唯一化到 `computeSettlement`（事件账 + balances），先修 spec/plan 再改实现。
- **呼叫转移/杠上炮**：`settle` 目前只有荒庄退税，没有 transfer 事件；`gangTransfer` 配置未消费。
- **`refundOnDraw`**：`nonReadyAll`/`kongDeclarerOnly` 目前同义，仅杠者未听退。
- **`MahjongSettlementResult` 缺 `dealerSeat`**：记录表 `dealer_seat` 暂写 `req.seats[0].seat`。
- **draw 动作未入 actionLog**：回放缺摸牌记录；`applyMahjongAction` 的 `drawFor` 未写日志。
- **SBR 预设矛盾**：spec §3.2 番表写“海底 1”、同节又写“海底关”；当前 `optionalFans.haiDi=0`，需定稿。
- **`sbrGoldEnabled` 消费点**：配置键已种，但 rooms.start 未做“金币场 + sbr 预设 + 未开启 ⇒ 拒开”的闸。
- **conformance/真栈**：T12 未做；基线/镜像重建/回滚手册未做。
- **客户端 store/table 仍按单座语义**，麻将会被误判为斗地主；先按上面 T11 修。
- **计划审查提到的“T1 后全仓 typecheck 红”**：已用三路守卫修掉 room/user；client 还未跑。

## 关键命令

```bash
pnpm -C packages/protocol test
pnpm -C packages/shared test
pnpm -C packages/game-service test
pnpm -C packages/room-service test
pnpm -C packages/currency-service test
pnpm -C packages/user-service test
pnpm -C packages/config-service test
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm test && pnpm lint
```

## 已知约定

- `Tile { s:0=万,1=筒,2=条, r:1..9 }`；27 位计数串用于记录。
- 发牌：每家 13 → 换三张（可关）→ 定缺 → 庄摸第 14；杠后补牌从牌墙前部。
- 一局一房；不连庄。
- 花猪 burn 走 `CurrencyBurn.penalty`，`currency_ops.burned_penalty`。
- `game-service` 单副本前提；窗口串行依赖进程内 `runSerialized`。
