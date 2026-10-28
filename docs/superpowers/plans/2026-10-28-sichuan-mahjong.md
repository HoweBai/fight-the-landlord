# 四川麻将（血战到底）接入 · 实现计划 v0.1

> 依据：`docs/superpowers/specs/2026-10-28-sichuan-mahjong-design.md` v0.2（已过第 1 轮对抗审查）。
> 规则唯一来源：`docs/games/mahjong.md`（本计划 T1 新建）。
> 分支：`majiang`。素材：幼麟棋牌（`babykylin/babykylin_scmj` / 同源 `zhaozhifei/scmj`）。
> 纪律：每个任务 TDD（红→绿→提交）；不夹带工具链升级；提交带
> `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 协议类型全部在 `packages/protocol/src/mahjong/`；`shared` 只导入，不反向定义。
- 线格式：`game.play` 载荷加 `mahjong?: MahjongAction`；`RequestMeta.windowId?`。
- 单副本前提：`game-service replicas=1`；窗口串行/CAS 复用现有 per-room 队列。
- 结算：事件账 → 逐付款人截断（writeOff）→ 净额；`scoreChanges` 零和；burn 独立。
- 规则默认 `chengdu`（6 番/32×），`sbr` 预设可配；所有规则进 `game.mahjong.rules` JSON。
- 不做：2/3 人、血流、多局轮庄、ML 机器人、语音首版。

---

## T1 规则文档 + protocol 类型 + 形状分流骨架

**Files**
- 新建 `docs/games/mahjong.md`
- 新建 `packages/protocol/src/mahjong/{tile,actions,rules,types,rule-summary,index}.ts`
- 改 `packages/protocol/src/game-types.ts`、`game.ts`、`views.ts`、`settlement.ts`、
  `records.ts`、`robot.ts`、`validate.ts`、`messages.ts`、`rpc.ts`、`index.ts`
- 测试：`packages/protocol/src/mahjong/*.test.ts`、`game.test.ts`、`multi-game-contract.test.ts`

**Steps**
1. 写 `docs/games/mahjong.md`：发牌时序（13→exchange→lack→庄摸 14）、阶段、优先级、
   番表/封顶、杠分/退税/呼叫转移/花猪/查叫/过水/最后四张、配置键口径。
2. `GAME_TYPES` 加 `'mahjong'`；`GAME_META` 加 `mahjong`（4 人、capabilities）。
3. 定义 `Tile`/`MahjongSuit`/`MahjongAction`/`MahjongRulesConfig`/`MahjongPlayerView`/
   `MahjongSettlementResult`/`MahjongRecordEnvelope`/`MahjongRobotFeatures`。
4. `GameView`/`SettlementResult`/`RecordEnvelope`/`GameRobotFeatures` 联合扩展；
   `resolveGameType`/`assertGameView`/`assertSettlement`/`assertNoLeak` 三路。
5. `game.play` 载荷 `{cards?, mahjong?}`；`RequestMeta` 加 `windowId?`；
   `validateClientMessage` 二选一校验；`rpc.ts` 同步。
6. 测试：GAME_META 编译期、view 禁出站（wall/他人手牌/rngSeed）、settlement 形状、
   `game.play` 二选一、旧 ddz/pdk 类型不变。
7. 跑 `pnpm -C packages/protocol test`；提交。

## T2 内核多行动者窗口

**Files**
- `packages/shared/src/core/{action,session}.ts`
- `packages/game-service/src/games/runtime.ts`
- `packages/game-service/src/game/game.service.ts`
- 测试：`packages/game-service/test/mahjong-window.test.ts`、现有 ddz/pdk golden

**Steps**
1. `GameAction` 加 `{kind:'mahjong'; action: MahjongAction}`；
   `GameSessionBase<P,L>` 加日志泛型（默认保持旧行为）。
2. `GameRuntime` 加可选 `pendingActors`/`acceptsAction`/`windowId`/`windowDuration`。
3. orchestrator：
   - 授权走 `acceptsAction`；
   - `turnDeadlineAt` 唯一写入函数：`windowId` 未变且 pending 非空 ⇒ 保留；
   - `startTurnTimer` 用 `turnDeadlineAt - now`，不得重算满额；
   - 人类动作/机器人/超时三处赋值统一；
   - 超时复核 `{windowId,deadlineAt}`，不匹配重挂剩余；拒绝动作 clamp；
   - 超时对每个 pending 座位记 `timeoutCount`/托管；
   - `driveMahjongWindow`：麻将不调 robot-service，直接 `autoAction`；
   - 托管只触发本人自动动作，不改共享 deadline。
4. 窗口 CAS：`meta.windowId === runtime.windowId && seat ∈ pendingActors` 接受过期
   `baseVersion`；否则 13004。
5. fake runtime 测试：4 人同时 claim、超时不续命、机器人逐座、重连、ddz/pdk golden。
6. 跑 `pnpm -C packages/game-service test` + `pnpm -C packages/shared test`；提交。

## T3 纯规则：牌/发牌/换三张/定缺

**Files**：`packages/shared/src/mahjong/{tile,deck,exchange,lack,meld}.ts` + tests。

**Steps**
1. 108 张构造、洗牌/固定牌堆、13×4 发牌；27 位计数编码。
2. 换三张：3 张同花色校验、方向映射（下家/上家/对家）、同时交换、超时自动选。
3. 定缺：2 门强制、1 门二选一、缺门优先打/不能碰杠。
4. 真值表 + 边界测试（不足 3 张、超时、方向置换）。
5. 跑 `pnpm -C packages/shared test`；提交。

## T4 纯规则：胡牌/听牌/番型/计分

**Files**：`packages/shared/src/mahjong/{hu,ting,features,scoring,rules}.ts` + tests。

**Steps**
1. 胡牌分解（4 副+将、七对），返回全部分解/特征；缺门校验。
2. 听牌枚举 + 每张最大番；`minFanToHu` 口径。
3. 规范特征：根（含/不含杠按配置）、碰碰胡、金钩钓、清一色、七对、幺九、258、杠数、
   胡牌上下文。
4. `scoring`：`named`（最大单一命名番 + supersedes + 并列优先级）与 `additive`（SBR）：
   封顶、自摸 addBase/addFan/addPoint、根/杠、可选番。
5. 差分测试：胡牌 vs 慢速参考；听牌 vs 枚举；命名番组合；SBR 3 番封顶。
6. 跑 `pnpm -C packages/shared test`；提交。

## T5 纯规则：状态机/claim/结算/autoplay

**Files**：`packages/shared/src/mahjong/{session,actions,claims,settle,autoplay}.ts` + tests。

**Steps**
1. `MahjongSession`/`MahjongPlayer`、阶段与窗口状态。
2. 动作应用：exchange/lack/discard/concealedGang/addedGang/selfDrawHu/claim。
3. claim/rob：候选、优先级、一炮多响、抢杠、过水、最后四张强胡、下一行动者。
4. 事件账：gang/hu/transfer/refund/chajiao/huazhu；顺序、截断/writeOff、零和、burn。
5. `decideMahjongAutoAction`：换三张/定缺/出牌/响应/杠/胡。
6. 测试：固定牌堆完整局、抢杠/杠上炮/退税/呼叫转移/花猪/查叫、零和独立重算。
7. 跑 `pnpm -C packages/shared test`；提交。

## T6 game-service runtime

**Files**：`packages/game-service/src/games/mahjong/{runtime,view,record}.ts`、`registry` 装配、
`game.service.ts` 动作路径；测试 `packages/game-service/test/mahjong-*.test.ts`。

**Steps**
1. `MahjongRuntime` 实现全部接口；`pendingActors`/`acceptsAction`/`windowId`/`windowDuration`。
2. `create` 快照/发牌/机器人字段；`testTiles` 测试钩子。
3. `applyAction` 分派、规则错误映射；`onTimeout` 结算整个窗口。
4. `buildView` 禁出站（wall/他人手牌/rngSeed）；`revealedHands.tiles`。
5. `buildRecord` 初始 13/finalHand/actions/exchangeDirection/rngSeed。
6. 动作路径：`actAndView`/`applyById` 接受 `mahjong`；非麻将收到 mahjong ⇒ 13001。
7. 测试：完整机器人局、窗口/超时/托管/重连、record 形状、禁出站。
8. 跑 `pnpm -C packages/game-service test`；提交。

## T7 config-service + config-cache

**Files**：`packages/protocol/src/mahjong/rules.ts`、`packages/shared/src/mahjong/rules.ts`、
`packages/config-service/src/migrations/1798100000000-MahjongConfigSeed.ts`、
`packages/room-service/src/config/config-cache.service.ts`、`client-config.controller.ts`、admin。

**Steps**
1. `parseMahjongRules`：preset 展开/覆盖/未知键/越界；`DEFAULT_CHENGDU_RULES`/`DEFAULT_SBR_RULES`。
2. 迁移种子：`game.mahjong.*`（enabled/free/gold/friend/freeBotFill/goldBotFill/entryMultiplier/
   rakePercent/sbrGoldEnabled/rules）+ `game.levels.mahjong`；up/down。
3. `config-cache.mahjongRules()`；`levelsKeyOf`/`gameEnabled`/room flags/botFill/entry/rake
   加 mahjong；缺键 fail-closed。
4. `client-config` boot 加麻将；admin 配置域 + JSON 编辑。
5. 键计数/admin 静态闸同步；测试。
6. 跑 `pnpm -C packages/config-service test` + `pnpm -C packages/room-service test`；
   `pnpm verify:admin`；提交。

## T8 room/match 4 人

**Files**：`packages/room-service/src/match/match.service.ts`、`rooms/rooms.start.ts`、
`rooms/rooms.service.ts`、`rooms/rooms.bots.ts`。

**Steps**
1. 队列键/票/房间 meta 加 mahjong（4 人）；旧键双读。
2. `rooms.start` 规则快照：`MahjongRulesConfig`；`testTiles` 钩子。
3. 台费/档位/机器人池/风控分桶按 mahjong。
4. 测试：4 人匹配、开局、规则快照失败 strict/retry、旧 ddz/pdk 不变。
5. 跑 `pnpm -C packages/room-service test`；提交。

## T9 currency burn + settle service

**Files**：`packages/protocol/src/currency.ts`、`packages/currency-service/src/apply/apply.service.ts`、
`admin/finance-query.service.ts`、`reconcile/*`、`packages/room-service/src/currency/settle.service.ts`、
迁移 `1798300000000-BurnPenalty.ts`。

**Steps**
1. `CurrencyBurn.penalty?`；校验/不变量/hash/apply/outbox 全链。
2. `burned_penalty` 列；迁移 up/down；财务 summary/byGame 加 penalty。
3. `settle.service` 三路：shape/rawOf/computeSettlement；mahjong 事件净额不 pool；
   burn 独立；截断 writeOff；记录 `deltas`。
4. 测试：旧 canonical 不变、penalty 上账/幂等/对账、麻将截断/零和/burn。
5. 跑 `pnpm -C packages/currency-service test` + `pnpm -C packages/room-service test`；提交。

## T10 user records

**Files**：`packages/user-service/src/migrations/1798200000000-MahjongRecords.ts`、
`rpc/record.rpc.controller.ts`、`records/*`、`risk/*`。

**Steps**
1. 双表 `game_records_mahjong`/`game_record_players_mahjong`（hand 27 位、melds/discards JSON）。
2. `record.rpc.controller` 三路校验收发；`persist` 分流；`ws.gateway.prepareRecord` 带
   gameType/playerCount/rules/events/burn。
3. 查询 `GET /api/records?gameType=mahjong`；历史页最小展示。
4. 测试：写入/拒收/旧记录双读/不泄露 rngSeed/他人手牌。
5. 跑 `pnpm -C packages/user-service test`；提交。

## T11 客户端

**Files**：`apps/client/src/gameModes.ts`、`stores/game.ts`、`pages/game/game.vue`、
新增 `pages/table/MahjongBoard.vue`、`static/ui/mahjong/*`（幼麟素材）、`static/audio/mahjong/*`。

**Steps**
1. 从 `zhaozhifei/scmj`（或 babykylin 同源）提取 27 张牌 + 牌背 + 四向牌；
   `Z_my.plist` 75×113；导出 H5 SVG/PNG 与 App @2x/@3x。
2. 音效：`nv/peng|gang|hu`、`guafeng`、`rain`、`deal`、`shuffle`、`sort`、`timeup_alarm`、
   `bgMain`、`bgFight`；登记 `THIRD-PARTY-NOTICES.md`。
3. `GAME_MODES` 加麻将；`CLIENT_TABLE_PLAYER_COUNTS.mahjong=[4]`；
   `game.vue`/store 显式 `gameType` 分支。
4. `MahjongBoard`：定缺/换三张/出牌/碰杠胡过/倒计时/牌墙/副露/弃牌/结算/花猪/查叫/退税；
   `activeSeats` 多座倒计时；`seats[]` current_turn；`finished` mahjong payload。
5. 资产加载/预加载；108 张按需渲染；不新造时钟。
6. 测试：`pnpm -C apps/client test`、`pnpm -C apps/client run lint`；真浏览器 e2e（如时间允许）。
7. 提交。

## T12 观测/conformance/全量验证

**Files**：`packages/shared/src/metrics/*`、`packages/room-service/src/metrics/*`、
`tools/conformance/*`、`k8s`（如需）、`docs/superpowers/plans/*-handoff.md`。

**Steps**
1. 指标 `game_type=mahjong`、窗口/结算/burn/重连；告警。
2. conformance 新 slice：boot/config、4 人匹配、完整机器人局、claim 窗口、重连、
   结算/对账、记录、admin、暗上线。
3. 暗上线矩阵：enabled/free/gold/friend/botFill 开与关。
4. 全量：`pnpm test`、`pnpm lint`、`pnpm exec turbo run test lint --force`、
   `pnpm verify:admin`；工作区干净。
5. 代码审查（独立 reviewer）→ 修 Critical/Important → 复跑。
6. 提交/交付报告；推送/部署按用户裁决。

---

## Verification Commands

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
pnpm verify:admin
pnpm test
pnpm lint
```

## Plan Review Checklist

- [ ] 任务顺序可独立提交/回滚
- [ ] 每个任务有红→绿判据
- [ ] 线格式/protocol 归属/禁出站/结算 burn 不变量有测试
- [ ] ddz/pdk golden 零变化
- [ ] 配置键/迁移时间戳/键计数同步
- [ ] 客户端不实现规则；服务端重算
- [ ] 无工具链升级夹带
