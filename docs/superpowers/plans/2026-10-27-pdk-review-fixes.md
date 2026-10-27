# 跑得快审查问题修复实现计划（P0–P2）

- 日期：2026-10-27
- 依据：`docs/superpowers/specs/2026-10-27-pdk-review-fixes-design.md`（含设计对抗审查记录）
- 分支：从 `dev` 开 `fix/pdk-review-findings`
- 范围：13 项发现，12 个任务（#5 与 #13 合并），三切片独立可测、可提交

## Global Constraints

- 不改跑得快规则、配置键、协议消息形状、结算公式；斗地主玩家可见行为不变。
- 每个任务严格 TDD：先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。
- 一个任务一个 commit；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 不夹带无关重构；不新增 conformance 切片；不跑全量权威轮（合 master 才跑）。
- 跨包改动后同步机械闸：无配置键变更（不需改 config 计数）；无 admin 变更。
- 工作区必须干净后进入下一任务。

## 切片 A：P0（安全 / 资金 / 可用性）

### A0. 开分支与基线

1. `git switch dev && git pull --ff-only`（若有远端更新先合并并复跑基线）。
2. `git switch -c fix/pdk-review-findings`。
3. 记录基线：`git rev-parse HEAD`；工作区干净。

### A1. T1 HTTP 房号收口

**Files**
- `packages/room-service/src/rooms/rooms.dto.ts`
- `packages/room-service/src/rooms/rooms.controller.ts`
- `packages/room-service/src/rooms/rooms.service.ts`
- `packages/room-service/test/rooms.controller.test.ts`
- `packages/room-service/test/room-create-game-type.test.ts`
- `packages/room-service/test/room-code-guard.test.ts`（新）

**Interfaces**
- `CreateRoomDto` 删除 `roomCode?: string`。
- controller `create()` 显式构造
  `{ mode, baseScore, gameType, playerCount }`，不把 `dto` 透传。
- `RoomsService.create(dto)` 保留 `roomCode?`（测试/内部缝）；新增私有
  `assertExplicitRoomCodeUsable(code)`：非空、长度 ≤32、不含 `:`/空白、`EXISTS room:{code}` 为假；
  违反 → `DomainError(ErrCode.BAD_PARAM, '房间号不可用')`。

**Steps**
1. RED：
   - controller 测试：请求体带 `roomCode:'ABC:seats'`，捕获 `service.create` 入参，
     断言无 `roomCode` 且 `mode` 等字段原样。
   - DTO 测试：用 class-validator `validate(plain, { whitelist: true, forbidNonWhitelisted: true })`
     断言 `roomCode` 被拒/剥离（`room-create-game-type.test.ts:52-58` 用的是
     `validate()`，不是 `getMetadataArgsStorage`）；或直接断言 controller 入参。
   - 删除 `roomCode` 字段时同步删除 `rooms.dto.ts` 顶部的 `IsString` 导入
     （`noUnusedLocals` 会让 room-service lint 红）。
   - service 测试：`''`、`'A:B'`、`'A B'`、33 字符、已存在房号 → `10001`；
     `'ROOM1'`（短码）可正常建房。
2. 跑红：
   `pnpm -C packages/room-service test -- rooms.controller room-create-game-type room-code-guard`
3. GREEN：改 DTO/controller/service。
4. 回归：
   `pnpm -C packages/room-service test -- rooms.controller rooms.controller-switch rooms.service rooms.start pdk-start-retry`
5. 处理既有夹具：5 文件 8 处短码保持可用（不强制 6 位）；若 `EXISTS` 夹具冲突，按测试隔离修正。
6. 提交：`fix(room): 建房 HTTP 入口剥离客户端 roomCode，服务端校验内部缝`

**DoD**
- 任意已认证客户端无法通过 `POST /api/rooms` 覆盖存活房 meta。
- 内部短码测试缝不受影响。

### A2. T2 pdk 重载 trustees

**Files**
- `packages/game-service/src/game/game.service.ts`
- `packages/game-service/src/games/pdk/view.ts`
- `packages/game-service/test/pdk-session-reload.test.ts`（新）

**Interfaces**
- 无公开签名变化；`loadSession` 内 `botIds` 归一化移到 pdk 早退前。
- `buildPdkPlayerView` 机器人判定：
  `typeof botId === 'string' && botId.length > 0 ? false : atSeat.trustee === true`。

**Steps**
1. RED：新测试
   - 构造 pdk 会话：座位 0 人类且 `trustee=true`，座位 1 机器人（`botIds[1]='bot-x'`），
     座位 2 人类未托管；`saveSession`（JSON 往返产生 `null` 空洞）→ 新 `GameService.loadSession`
     → `buildPdkPlayerView(0/1/2)`：
     - 座位 0 `trustees[0] === true`；
     - 座位 1 `trustees[1] === false`；
     - 座位 2 `false`。
   - **RED 只保留视图三座断言**：`applyTrustee` 已走有效字符串谓词
     （`game.service.ts:914-919`），重载后取消托管今天就能成功——toggle 用例降为回归断言，
     不作为 RED 判据。
2. 跑红：`pnpm -C packages/game-service test -- pdk-session-reload`
3. GREEN：移动归一化 + 视图谓词。
4. 回归：`pnpm -C packages/game-service test -- pdk-session-reload trustee pdk-trustee session-reload-bot-seats governance`
5. 提交：`fix(pdk): 会话重载后保留人类座位托管状态`

**DoD**
- pdk 视图 `trustees[]` 在会话重载后正确；机器人座位不被误判。

### A3. T3 机器人恢复透传 gameType

**Files**
- `packages/room-service/src/rooms/rooms.start.ts`
- `packages/room-service/test/pdk-start-retry.test.ts`

**Interfaces**
- `private recoverBotBindings(code: string, seats: Seat[], known: ReadonlyArray<BotBinding>, gameType: GameType)`。
- `fillBots` 调用处传 `gameType`。

**Steps**
1. RED：扩展 `pdk-start-retry` 恢复分支用例：捕获 `robot.acquire` 载荷，
   断言 `gameType === 'paodekuai'`，且返回 `botId` 与既有绑定一致（不被替换）。
2. 跑红：`pnpm -C packages/room-service test -- pdk-start-retry`
3. GREEN：加参并透传。
4. 回归：`pnpm -C packages/room-service test -- pdk-start-retry rooms-start-pdk rooms.start match.service`
5. 提交：`fix(room): pdk 机器人恢复透传 gameType，避免错池与泄漏`

**DoD**
- pdk 开局重试不再把 pdk 机器人换绑成 ddz；两个池不泄漏。

### A4. T4 大厅跑得快规则文案

**Files**
- `apps/client/src/gameModes.ts`
- `apps/client/test/pdk-rules-text.test.ts`（新）

**Interfaces**
- 仅 `GAME_MODES` 中 pdk `description` 文本；保留 `id: GAME_META.paodekuai.id`。
- 文案禁用“王炸/地主/叫抢/大王 > 小王”；必须含四段标题与关键规则。

**Steps**
1. RED：新测试按 `\n\n` + `【标题】` 分段（复刻 `lobby.vue:769-802` 的解析假设）：
   - 首段标题 `【基本规则】`；
   - 存在 `【牌型与比较】/【计分】/【超时与托管】`；
   - 每段至少一条 `·`；
   - 含“红桃 3”“48 张”“12 张”“保本”“关牌”“春天”；
   - 不含“王炸”“地主”“叫抢”“大王 > 小王”。
2. 跑红：`pnpm -C apps/client test -- pdk-rules-text`
3. GREEN：重写文案（2/3 人 16 张、4 人 12 张；2 人扣一份；红桃 3 首出；
   牌型默认开关；炸弹最大、AAA 非炸弹；计分/保本/封顶；超时托管）。
4. 回归：`pnpm -C apps/client test -- pdk-rules-text lobby-modes game`
5. 提交：`fix(client): 跑得快大厅规则文案改为真实规则`

**DoD**
- 玩家点 info 看到的是跑得快规则，不再出现斗地主概念。

## 切片 B：P1（正确性）

### B1. T5 首出提示结构化生成 + 性能

**Files**
- `apps/client/src/game/pdk-hint.ts`
- `apps/client/test/pdk-hint.test.ts`

**Interfaces**
- `suggestPdkPlays(hand, target, rules): Card[][]` 签名不变。
- 新增内部结构化生成器（可导出供测试但标注 internal），产出仍由
  `parsePdkHand` 校验、`compareCandidate` 排序、canonical key 去重。

**Steps**
1. RED：
   - 定向：3–10 八连对（16 张）、3–9 七连对（14 张）、4 连三+4 单（16 张）、
     4 人 12 张的 6 连对/12 顺/4 裸三、四张同点拆三带一。
   - 差分 A：随机 10 张手牌，暴力枚举全部子集 + `parsePdkHand`，集合按 canonical key 相等。
   - 差分 B：≥5 手固定/随机 16 张合法手牌，暴力枚举 `2^16` 子集 + `parsePdkHand`，集合相等。
   - 规则开关矩阵：三带二关、裸飞机关、翅膀 `pairs/singles/both`、四带二带对开关。
   - 性能上界：最坏 16 张手牌返回候选数 `< 2000`（当前 4008）。
2. 跑红：`pnpm -C apps/client test -- pdk-hint`
3. GREEN：实现结构化生成（同点组、滑窗、翅膀选择、四带二），不枚举任意子集。
   **命名约束**：`source-boundary.test.ts:80-96` 扫描 `src/**` 并禁用
   `isBomb/isStraight/isPair/isTriple` 等标识符；生成器用 `groupByRank`/`collectShapes`/
   `hasRankCount` 等命名，避免撞闸。
4. 回归：`pnpm -C apps/client test -- pdk-hint pdk-board source-boundary`
5. 提交：`fix(client): 跑得快提示改为结构化生成，补 14/16 张组合并消除全量枚举`

**DoD**
- 7/8 连对、4 连三+4 单可被提示；候选集合与暴力枚举等价；候选数 <2000。

### B2. T6 BIGINT ended_at

**Files**
- `packages/user-service/src/rpc/record.rpc.controller.ts`
- `packages/user-service/test/record-pdk-write.test.ts`

**Interfaces**
- 新增私有 `toEpochMs(value: Date | string | number): number`：
  `Date` → getTime；number → 原值；数字字符串 → Number；其余 → `Date.parse`。

**Steps**
1. RED：pdk 假库 `ended_at: String(endedAt)`：
   - 重复投递同值 ⇒ `logger.error` 不被调用；
   - 超阈值 ⇒ 调用一次，文案含 room/version。
   - **夹具注意**：`record-pdk-write.test.ts` 的 FakePdkDb INSERT 存 Number（:142），
     幂等 SELECT 投影（:134）需在该用例改为返回 `String(...)`，否则模拟不到 BIGINT 数字串。
2. 跑红：`pnpm -C packages/user-service test -- record-pdk-write`
3. GREEN：helper + `flagEndedAtMismatch` 使用。
4. 回归：`pnpm -C packages/user-service test -- record-pdk-write record.rpc`
5. 提交：`fix(records): pdk BIGINT ended_at 数字字符串按 epoch ms 解析`

**DoD**
- 正常重试不再误报“房间复用”；真实 mismatch 仍告警。

### B3. T7 开局幂等与规则漂移

**Files**
- `packages/game-service/src/game/game.service.ts`
- `packages/game-service/test/pdk-start-idempotent.test.ts`（新）

**Interfaces**
- `startGame` 已有会话时：`gameType/playerCount` 不等仍 `12012`；
  `rules` 不等仅 `logger.warn`，保留 existing.rules。

**Steps**
1. RED：新测试
   - pdk 同房二次 start（rules 改一个值）⇒ 成功，`getSession().rules` 仍首次值；
   - gameType/playerCount 变化 ⇒ `GAME_UNAVAILABLE 12012`；
   - ddz 无 rules 幂等不变。
2. 跑红：`pnpm -C packages/game-service test -- pdk-start-idempotent`
3. GREEN：替换 `JSON.stringify(rules)` 比较为 WARN + 保留快照。
4. 回归：`pnpm -C packages/game-service test -- pdk-start-idempotent game.service pdk-start-retry`
5. 提交：`fix(game): 开局重试不再因规则快照漂移报 12012`

**DoD**
- 配置热更新窗口内开局重试可成功；跨玩法/人数复用仍被拒。

### B4. T8 结算按 gameType 分流

**Files**
- `packages/room-service/src/currency/settle.service.ts`
- `packages/room-service/test/currency/settle-algorithm.test.ts`
- `packages/room-service/test/currency/settle-pdk.test.ts`
- `packages/room-service/test/currency/settle-guard.test.ts`

**Interfaces**
- `computeSettlement(input: { roomCode; version; round; gameType: GameType; result; seats; balances; rakePercent })`。
- `settleInner` 在 result③ 后、version④ 前做严格形状/座位校验。

**Steps**
1. RED：
   - 纯函数：pdk 形状 + `gameType='doudizhu'`（及反向）抛错；pdk 缺一座抛错。
   - `settle()`：**pdk 结果缺一座** ⇒ 不调用 `currency.apply`，只 WARN 一次。
   - 既有玩法/人数守卫（`settle.service.ts:396-409`）今天已拦“缺 gameType 键”与跨玩法；
     该两例降为回归断言，不作为 RED。真实缺口是 **缺座被 `?? 0` 静默免付**
     （`settle.service.ts:199`）。
2. 跑红：`pnpm -C packages/room-service test -- settle-algorithm settle-pdk settle-guard`
3. GREEN：
   - `computeSettlement` 按 `gameType` 分流并校验座位覆盖；
   - `settleInner` 预校验 → `dropWarn`；
   - 机械补全部 `computeSettlement` 调用 `gameType`：`settle-algorithm` 21 处 +
     `settle-pdk.test.ts:191` + `settle.service.ts:429/466` = **24 处**。
4. 回归：`pnpm -C packages/room-service test -- currency`
5. 提交：`fix(settle): 结算按房间玩法分流并对缺座结果 fail-closed`

**DoD**
- 结果形状/座位与房间不符时零资金写入、可观测；合法 pdk 2/3/4 人结算不变。

## 切片 C：P2（结构性）

### C1. T9 testDeck 整数校验

**Files**
- `packages/shared/src/pdk/deck.ts`
- `packages/shared/src/pdk/deal.test.ts`（或 `deck.test.ts`）
- `packages/game-service/test/pdk-test-hooks.test.ts`

**Steps**
1. RED：`{r:NaN,s:0}`、`{r:3.5,s:0}`、`{r:3,s:0.5}` 被拒；
   game-service test hook 返回 `10001`；合法 48 张仍通过。
   `{r:Infinity,s:0}` 现已被范围检查拒（`deck.ts:26`），降为回归断言。
2. 跑红：`pnpm -C packages/shared test -- deal deck`、
   `pnpm -C packages/game-service test -- pdk-test-hooks`
3. GREEN：`isPdkCard` 加 `Number.isInteger` 与非空对象守卫。
4. 回归同上。
5. 提交：`fix(pdk): testDeck 拒绝 NaN/小数/Infinity`

### C2. T10 自动出牌单一决策

**Files**
- `packages/shared/src/pdk/autoplay.ts`
- `packages/shared/src/pdk/play.ts`
- `packages/game-service/src/games/pdk/runtime.ts`
- `packages/shared/src/pdk/play.test.ts`
- `packages/game-service/test/pdk-runtime.test.ts`

**Interfaces**
- `decidePdkAutoAction(session: PdkSession, seat: number): GameAction`
  只封装 mustLead / 最小可压 / pass；不接管 state/空手牌/当前玩家守卫。
  **返回判别键是 `kind`**：`{ kind: 'play'; cards }` / `{ kind: 'pass' }`
  （`packages/shared/src/core/action.ts:11-13`；`GameAction` 还有 bid 分支，
  本函数永不返回）。

**Steps**
1. RED：决策矩阵（首出/跟牌/压不过/非当前座位）双入口一致；
   `lastPlayerIdx===seat` 必须首出；timeout 空手牌抛错；runtime 语义不变。
   **结构性判别**：mock/spy `autoplay.decidePdkAutoAction`，断言 `play.ts` 与 `runtime.ts`
   两个入口都调用它；若 ESM 绑定不可 spy，加源码闸断言两文件均引用该符号
   （仅比对结果的一致性测试今天就能绿，不能作为唯一判据）。
2. 跑红：`pnpm -C packages/shared test -- play`、
   `pnpm -C packages/game-service test -- pdk-runtime`
3. GREEN：抽函数并委托。
4. 回归同上。
5. 提交：`refactor(pdk): 托管/超时/机器人共用单一自动出牌决策`

### C3. T11 局终单次读房

**Files**
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/room-service/test/ws.gateway.test.ts`

**Interfaces**
- `prepareRecord(event, record, result, botBySeat, botNicknames, endedAt, room: Room | null)`；
  内部 `room ?? await findOne(...)`。

**Steps**
1. RED：正常局终仅 finalize/prepareRecord 链路一次 `findOne`（当前两次 ⇒ 红）。
   首读 null、二读成功 ⇒ settle 跳过、记录写入：**今天已成立**，降为回归断言。
2. 跑红：`pnpm -C packages/room-service test -- ws.gateway`
3. GREEN：透传 `settleRoom` + null 兜底。
4. 回归并改写 `ws.gateway.test.ts:2151-2195`、`:2366-2384` 两组两次读用例。
5. 提交：`perf(room): 局终复用房间读取，消除同局双 findOne`

### C4. T12 GAME_TYPES 单一真源

**Files**
- `packages/protocol/src/game-types.ts`（新）
- `packages/protocol/src/game.ts`
- `packages/protocol/src/validate.ts`
- `packages/protocol/src/game.test.ts`
- `packages/protocol/src/multi-game-contract.test.ts`

**Interfaces**
- 叶子模块导出 `GAME_TYPES`、`GameType`、`DEFAULT_GAME_TYPE`、`isGameType`（零 import）。
- `game.ts` re-export；`validate.ts` `KNOWN_GAME_TYPES = GAME_TYPES`。

**Steps**
1. RED：
   - 遍历 `GAME_TYPES`，六个调用点（PlayerView、game.balances、room.matched、
     room.state_update、room.match、room.join）全部接受；未知值各拒一次
     （当前值域相同 ⇒ 行为测试今天即绿，只防未来漂移）。
   - **判别力来自源码闸**：断言 `validate.ts` 不再自建元组且引用 `GAME_TYPES`
     （否则保留双实现也能绿）。
2. 跑红：`pnpm -C packages/protocol test -- multi-game-contract game`
3. GREEN：抽叶子模块、改导入、保持 `index.ts` 导出面。
4. 回归：`pnpm -C packages/protocol test`。
5. 提交：`refactor(protocol): GAME_TYPES 抽叶子真源，validate 不再自建元组`

## 收尾

### V1 全量验证

- `pnpm -C packages/protocol test`
- `pnpm -C packages/shared test`
- `pnpm -C packages/game-service test`
- `pnpm -C packages/room-service test`
- `pnpm -C packages/user-service test`
- `pnpm -C apps/client test`
- `pnpm -C apps/client run lint`
- `pnpm exec turbo run test lint --force`（全仓，0 cached；排除已知环境性 flake 时须单独复跑）
- `pnpm exec tsc -p tools/conformance/tsconfig.json --noEmit`（若路径不同，用仓库既有命令）
- 真栈/conformance（spec §5）：优先跑
  `pnpm --filter @fight-the-landlord/conformance conformance:slice-05`（建房）与
  `conformance:slice-29-paodekuai`（pdk 规则）。不可跑则在本计划「验证记录」写明原因。
- `git status` 干净。

### V2 代码审查

- 独立 reviewer 审 `dev..HEAD`，对照 spec/plan 逐条核对；Critical/Important 必修，修后补测试重跑。
- 审查结论写入本计划「计划审查记录」之后新增的「代码审查记录」。

### V3 交付

- 更新 spec/plan 状态与偏差；必要时更新交接 memory。
- 提交文档、报告 SHA/验证证据/未做事项（C3、4 人金币真栈、权威轮）。
- 推送/合并按用户指示执行（不擅自推远端）。

## 计划审查记录

### 2026-10-27 计划对抗审查（独立 reviewer）

结论：1 阻断 / 3 高 / 4 低，全部处置后开工。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P1 | 阻断 | C2 返回类型写成 `{type:'play'|'pass'}`；实际 `GameAction` 判别键是 `kind` | 已改为 `{kind:'play';cards}` / `{kind:'pass'}`，注明 bid 分支不返回 |
| P2 | 高 | B4 RED 假绿：缺 gameType 键今天已被现有守卫拦；调用点 24 处非 21 | RED 收敛到“缺座”；计数改 24 |
| P3 | 高 | A2 toggle 用例今天已绿，RED 不判别 | RED 只保留视图三座断言；toggle 降为回归 |
| P4 | 高 | 漏 spec §5 真栈/conformance 判据 | V1 增 slice-05 与 slice-29-paodekuai（不可跑登记） |
| P5 | 低 | A1 删字段后 `IsString` 未用、DTO 测试范式写错 | 已注明同步删 import，改用 class-validator `validate()` |
| P6 | 低 | B1 结构化生成器可能撞 source-boundary 标识符禁令 | 已加命名约束与 source-boundary 回归 |
| P7 | 低 | C2/C4 行为断言今天即绿，双真源仍可保留 | C2 加 spy/源码闸；C4 加源码闸 |
| P8 | 低 | C1 Infinity 已拒、B2 夹具存 Number、C3 兜底已成立 | 分别降为回归/点名投影改造/只留单次读 RED |

## 代码审查记录

- 待实现完成后填写。
