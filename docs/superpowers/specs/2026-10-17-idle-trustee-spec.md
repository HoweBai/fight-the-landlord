# 规格：挂机治理（超时缩短 + 自动托管 + 手动托管）v1.2

- 日期：2026-10-17 · 分支：dev（未开工）· 状态：**定稿**（收口复评 r3「可以定稿」，2 条文面项已订正）
- 修订史：v1.0 → 规格评审 r1「修后再评」（1 阻断 + 7 重要 + 8 次要）→ **v1.1 逐条处置**（处置 = 文内 ⚠️ 标记）→ **差量收口 r2「修后再评」（2 重要 + 6 次要）→ v1.2 处置** → **收口复评 r3「可以定稿」**（S1 归属收窄、S2 版本引用随版订正）。
- 依据：设计 `docs/superpowers/specs/2026-10-17-idle-trustee-design.md` **v1.6（六轮评审闭环 + 规格联动）**。
  本规格把设计落成**逐条可验证判据**；设计与规格冲突时以设计为准并回改本文件。

## §0 命名钉子（实现与判据共用，⛔ 不许就地变体）

| 项 | 精确形态 |
|---|---|
| 会话字段 | `players[i].timeoutCount: number` / `players[i].trustee: boolean`（`loadSession` 缺省 `?? 0` / `?? false`） |
| 视图字段 | `PlayerView.trustees: [boolean, boolean, boolean]`（按座位数组，照 `cardCounts` 先例） |
| C→S 消息 | `game.trustee { on: boolean }`（进 `CLIENT_MESSAGE_TYPES`；`@SubscribeMessage` 在 **room-service `ws.gateway.ts`**） |
| RPC 边 | `RPC_PATTERNS.gameTrustee`（`'game.trustee'`）+ `GameTrusteeRequest { roomCode, userId, on, via, meta? }`——⚠️ **r1 阻断 1 新增判别位**：`via: 'manual' \| 'reconnect' \| 'abandon'`（manual = 客户端按钮；reconnect = reconnect/room.join；abandon = 在局 leave）。语义：`via='manual'` 且 `on=false` ⇒ R8②（不重排）；`via='reconnect'` 且 `on=false` ⇒ R6 例外（按 count 基线重排）；`via='abandon'` 仅 `on=true`。响应 `RpcResult<{ version: number }>`；**必须走 `toResult(..., dto?.meta)`** |
| ack 载荷 | `{ code, data: { version } }`（快照走 `publishSeatViews`，ack 不带全量视图） |
| 生产时长 | normal 30000 / accel 10000 / trustee 1500 / 阈值 3 |
| 测试注入 | `GAME_TURN_TIMEOUT_MS` / `GAME_TURN_TIMEOUT_ACCEL_MS` / `GAME_TRUSTEE_DELAY_MS` / `GAME_TRUSTEE_AFTER`；读取形态逐字 **`Number(process.env.X) \|\| 默认`**（`\|\|` 非 `??`）；conformance 值 **1500 / 1000 / 400 / 3** |
| 错误码 | 照实态、不新造：`Init ⇒ 13009`（仅单测可造）/ `Ended ⇒ 13005` / `无会话/无房 ⇒ 12001` / `无可恢复房 ⇒ 12004` / 坏载荷 ⇒ `10001`（room-service 本地 `validateClientMessage` 产生，零 RPC）；⚠️ r3 S1：**非法 via×on 组合的 10001 归 C7b（game-service 守卫）**，不属本地校验腿 |
| 徽标文案 | 常量字面量 **「托管中」**（进组件测试钉住；⚠️ r2 M-b 回补） |

## §1 判据表

验证方式图例：【单测】vitest ·【静态闸】相关扫描闸 ·【conformance】真栈片（扩片或新片） ·【人工】用户侧。

### A. 状态机与计数（shared 纯函数层）

| # | 判据 | 验证方式 |
|---|---|---|
| C1 | 超时（自动动作成功）⇒ `timeoutCount+1`；**count ≥ 3 ⇒ trustee=true**（用 ≥） | 【单测】 |
| C2 | 超时动作**抛错**（R106 分支）⇒ 不计数、不改会话 | 【单测】（负对照） |
| C2b | ⚠️ r1 重要 2 补：R106 错误重挂**按 normal 档时长**（`GAME_TURN_TIMEOUT_MS`）——**即使行动者处于 trustee 也不得用短延时**（注入态：断言重挂 1500 而非 400） | 【单测】 |
| C3 | ⚠️ r1 重要 1 订正：**手动**回合消耗型动作（bid/play/pass，**非超时链生成**）成功 ⇒ trustee=false + count=0。**复位只写在 applyAction 的人类动作成功路径**，⛔ 不写进共享 `handleBid/handlePlayTimeout`（超时链复用它们，写入会让 C1 永不达 3） | 【单测】（负对照：超时自动动作**不**复位） |
| C4 | `game.trustee{on:false, via:'manual'}`、`via:'reconnect'` ⇒ **只清 trustee，count 不动** | 【单测】（负对照：count 保持） |
| C5 | **机器人座位豁免**：非人类座位不累积 count、不置 trustee、视图 trustees 恒 false | 【单测】 |
| C6 | 非行动者动作不改变治理量 | 【单测】（负对照） |
| C6b | ⚠️ r1 重要 3 补：`loadSession` 旧会话缺字段 ⇒ 读出 `timeoutCount=0`/`trustee=false`（防 `undefined+1=NaN`）；坏形状不炸、不落错档 | 【单测】 |

### B. 转移语义（game-service）

| # | 判据 | 验证方式 |
|---|---|---|
| C7 | `game.trustee{on}` **守卫先于 no-op**：非法态先抛（Ended + 目标=现值 ⇒ **13005**，不是 0）（⚠️ r2 M-d：坏载荷 10001 由 room-service 本地校验产生、不属 game-service 层，见 C20b） | 【单测】 |
| C7b | ⚠️ r2 M-f 补：**非法 `via × on` 组合 ⇒ 10001 且不落盘/不 bump**（仅三个合法组合：manual×{on,off}、reconnect×off、abandon×on） | 【单测】 |
| C8 | **目标值 = 现值 ⇒ 完全 no-op**：不落盘、不 bump version、不 publish | 【单测】（spy 三面零调用） |
| C9 | 实际变更 ⇒ **轻量转移**：save + version+1 + `publishSeatViews`；**不重挂满额 timer**、不改 deadline——**限非行动者变更（R8③）**；行动者被置 trustee 的 deadline 收缩归 C11（⚠️ r1 次要 M2 加范围） | 【单测】 |

### C. timer / deadline 语义

| # | 判据 | 验证方式 |
|---|---|---|
| C10 | 回合时长按**行动者**治理态：trustee ⇒ 1.5s / count>0 ⇒ 10s / 否则 30s（注入值逐档）；叫抢与出牌同效 | 【单测】 |
| C10b | ⚠️ r1 重要 8 补：**机器人行动后的下一回合** deadline 按**下一行动者**档位写（⛔ 不用刚行动的机器人档——否则会给 trustee 人类写 30s；`game.service.ts:722` 写入点） | 【单测】 |
| C11 | R8①：行动者回合中**被置** trustee ⇒ 重排且 `turnDeadlineAt = now + max(0, min(旧剩余, trustee 延时))`（clamp 非负；**先改 deadline 再 publish**） | 【单测】+【conformance】 |
| C12 | R8②：行动者回合中 **`{on:false, via:'manual'}`** ⇒ **不重排不重算**（本轮仍按原短延时自动走一次） | 【单测】 |
| C13 | R8③：非行动者变更 ⇒ timer 与 deadline 均不动 | 【单测】 |
| C14 | R6 例外：**`{on:false, via:'reconnect'}`** 且 trustee 实际 `true→false` **且本人是行动者** ⇒ 按 count 基线重排 + 重算 deadline（count>0 ⇒ 10s；count=0 ⇒ 30s）；**非 trustee 者反复 join 不动 timer**；判别位见 §0（⚠️ r1 阻断 1：C12 与 C14 由 `via` 区分） | 【单测】+【conformance】 |

### D. 并发 / 串行（R10）

| # | 判据 | 验证方式 |
|---|---|---|
| C15 | **awaited per-room 队列覆盖四条写路径**（applyAction / onTurnTimeout / trustee 转移 / 机器人提交）；⛔ 不照 drop-on-reentry（无静默丢弃） | 【单测】（并发用例） |
| C16 | 同 tick 双发（出牌 + toggle）⇒ 串行生效、无覆盖、无同版本分叉 | 【单测】 |
| C17 | 机器人提交 × toggle：复验按 **state/actor**（纯 version 变化不丢）；被打断 ⇒ 丢弃并走循环下一轮重驱（锁内递归 no-op 的负对照）；复验通过 ⇒ 用**入锁后重读的会话 rebase** 应用决策 | 【单测】 |
| C18 | timer 回调按**回合身份**复核：非行动者 toggle 后定时到点 ⇒ 照常自动动作（纯 version 变化不失效）；回合已转移（actor/deadline 变）⇒ 放弃 | 【单测】+【conformance】 |

### E. 通道与转发（room-service）

| # | 判据 | 验证方式 |
|---|---|---|
| C19 | 新 RPC 边全链在位：pattern + 请求类型（含 `via`）+ controller 方法（R220 信封）+ `GameClient.trustee()`（2s 超时，签名含 via）+ `routeClientMessage` case + `@SubscribeMessage`；⚠️ r2 M-e：**四处转发的 via 取值钉死**——客户端 case ⇒ `'manual'`；在局 `room.leave` ⇒ `'abandon'`；reconnect 与在局 `room.join` ⇒ `'reconnect'`（逐处单测断言，错映射即红） | 【单测】 |
| C20 | R4b 错误码透传：**12001/12004/13005** 经 C→S 面不塌缩成 10007 | 【单测】+【conformance】 |
| C20b | ⚠️ r2 M-d / r3 S1：**坏载荷（`on` 非严格 boolean 等）⇒ ack 10001 且零 RPC 调用**（room-service 本地 `validateClientMessage` 产生；via×on 组合守卫见 C7b） | 【单测】（负对照：spy 零调用） |
| C21 | 弃局转发：awaited 解析（清记录之前）→ 仅 `status==='playing'` 且 **`consistent`（或 target == payload roomCode）**（⚠️ r1 次要 M1 补回）才 fire-and-forget（`via:'abandon'`）→ 清记录 → ok；失败只 warn；waiting 房 leave 零转发（负对照：零 RPC 调用） | 【单测】 |
| C22 | 重连/回桌（reconnect 与在局 `room.join` 两条）⇒ trustee-off（`via:'reconnect'`）**先清后 ack**——⚠️ r1 重要 7 条件化：**清除成功时** ack 快照不带 trustee=true；**清除失败（已登记的 fail-open 接受格）不受此断言约束**；失败不阻断 reconnect/join | 【单测】+【conformance】 |

### F. 协议 / 视图

| # | 判据 | 验证方式 |
|---|---|---|
| C23 | `PlayerView.trustees` 恰三元 boolean；`assertPlayerView` 同款校验（坏形状响亮） | 【单测】 |
| C24 | `CLIENT_MESSAGE_TYPES` 数量与穷尽断言同步（`messages.test.ts:37` 及 `:55-76` 全对象断言）；`game.trustee` 条目在位；**载荷校验 case**（validate.ts 穷尽 switch 加 case，⛔ 裸 break——`on` 严格 boolean） | 【单测】 |
| C25 | 夹具连带全绿（⚠️ r1 重要 4 列全）：`game-service/test/game.controller.test.ts:143`（14 键穷尽）· `protocol/src/messages.test.ts:15/:37/:55-76` · `protocol/src/rpc.test.ts:27` · `protocol/src/robot.test.ts:17` · `room-service/test/ws.gateway.test.ts:1018/:1328` · `game-service/test/view.builder.test.ts:33` · `shared/src/ddz/features.test.ts:28` · `shared/src/ddz/types.test.ts:20/:37` · `room-service/test/game.client.test.ts:133`（`GAME_CLIENT_TIMEOUT_MS` toEqual 增 trustee 键）· `apps/client/test/helpers/fake-socket.ts:195` · `tools/mock-server/src/index.ts:255`（never 穷尽 switch）与 `:265-274`（订阅表补 `game.trustee`）· **`tools/mock-server/src/scripted-game.ts:204`（`viewFor(): PlayerView` 字面量）** · **robot-service 三夹具（⚠️ r2 N2 回归回补）：`test/robot.decide.test.ts:37` / `test/bot.player.test.ts:34` / `test/robot.metrics.test.ts:34`** | 【单测】（tsc + 断言） |

### G. 接线闸（本片自带防回归）

| # | 判据 | 验证方式 |
|---|---|---|
| C26 | 新闸**两条腿**：① 遍历 `CLIENT_MESSAGE_TYPES` 每条都有 `@SubscribeMessage`；② 遍历同清单走 `routeClientMessage`（stub deps）不命中「Unhandled client message type」；各带正/负对照（判别力自证）。deps 工厂当前是 `message.router.test.ts` 文件内局部函数——实现时复制或导出，闸不得依赖私有构造 | 【单测】（room-service） |

### H. 客户端

| # | 判据 | 验证方式 |
|---|---|---|
| C27 | 「托管」按钮翻活：真实 toggle（`game.trustee{on}`）；状态来自 `trustees[自己的座位]`；托管中按钮态正确 | 【单测】+【人工】 |
| C28 | 座位「托管中」徽标按 `trustees[i]` 渲染；倒计时零改动；⚠️ r1 次要 M6：**缺字段不崩**（`trustees?.[i] ?? false`——`browser-e2e.mjs:578-585` 注入的 store view 无 trustees 且 `turnDeadlineAt:null`，照 R661 先例） | 【单测】+【人工】 |
| C29 | `more-menu.test.ts` 的 disabled 断言同批改为 toggle 断言 | 【单测】 |

### I. 文档

| # | 判据 | 验证方式 |
|---|---|---|
| C30 | `docs/design.md`：`:309`/`:348`/`:1517`/§9 的 30s 与「每次状态转移后重算」表述改治理口径；§4.2 签名表（含 `via`）、§4.3 超时表（新边 2s/不重试/fail-open）、§6.3 消息清单（`game.trustee` 行）、`:814`「CLIENT_MESSAGE_TYPES 九条」与 `:633` pattern 计数（现 16 vs 实 19 ⇒ 本片后应为 **20**；⚠️ r1 次要 M4 订正括注）；§6.3 表既有缺行（`room.match.extend`/`match.wait_prompt`）**登记为既有漂移**、本片顺手补齐 | 【静态】 |
| C31 | `docs/games/doudizhu.md` **7 处**（`:77`/`:167`/`:284`/`:301`/`:403`/`:436`/`:439`）+ 新增「挂机治理」小节 | 【静态】 |
| C32 | `docs/client-protocol.md`：`game.trustee` 消息 + `trustees` 字段 | 【静态】 |
| C33 | env 登记：compose game-service 块四个 `${VAR:-}` 透传；**不进 design.md §2.3**（照 CONFIG_SYNC_* 先例）；conformance runner 注释登记 | 【静态】 |

### J. conformance 真栈

| # | 判据 | 验证方式 |
|---|---|---|
| C34 | 注入 1500/1000/400/3 跑全链：超时加速两档 → 三次自动托管（规则引擎动作可见 + **`trustees` 数组实读**；⚠️ r2 M-c：徽标是客户端 DOM、真栈不可达，观测量 = trustees）→ **复位断言在 accel 档（1000ms）执行**（先 `{on:false, via:'manual'}` 解除，再在其回合内手动动作；⚠️ r1 重要 6：⛔ 不在 trustee 400ms 窗口赌 RTT）；**count 观测面 = redis 实读**（`game:session:<code>`，lib/redis.ts 先例；⚠️ r1 次要 M5）→ **弃局立即托管 → 回桌（`room.join`）拿回**（⚠️ r1 重要 5：弃局后 reconnect 必 13010 且 slice-05 C5 已钉死，⛔ 不写 reconnect 路径） | 【conformance】 |
| C35 | R8 三格 + C14 例外 + C18 回调复核各一格（真栈） | 【conformance】 |
| C36 | `finally` 还原 env + 健康复验；slice-11 的「<5s ⇒ 非超时兜底」依赖默认 30s——还原后恢复 | 【conformance】 |
| C37 | 连跑两跑读数一致；片注册（`run.ts`）与 baselines **仅 full 列**回填（依据写明） | 【conformance】 |

### K. 人工验收（用户侧）

| # | 判据 | 验证方式 |
|---|---|---|
| C38 | 真浏览器/App：一个 30s 后有人 10s；三次后自动托管可见（徽标 + 自动出牌）；托管按钮开/关；回桌拿回控制；对手徽标可见 | 【人工】 |
| C39 | 暗上线零变化（⚠️ r1 次要 M7 订正为可测形态）：**既有全序不回归** + 手动动作后下一回合仍按 count 档（无复位旁路）；生产 30s 档不在注入片中测 | 【conformance（既有片）】+【人工】 |

## §2 实施纪律

1. **TDD 顺序**：每任务先失败测试（本次日志）→ 实现 → 绿；⛔ 不「重跑直到绿」；「跑了/绿了」必须指向本次日志；每跑独立日志文件名，不覆盖。
2. **fake timers** 用于 shared/game-service 单测（⛔ 单测等真实 30s）；真栈只用注入值且不测真实 30s。
3. **并发用例**用 fake timers + 受控 await 构造（同 tick 双发 / 机器人窗口 / 陈旧回调三格），不得依赖真实竞速。
4. **注入 env 收尾还原**是硬判据（C36）：`finally` 还原 + 健康探针复验。
5. 文案/字段/时长/错误码/`via` 以 §0 与设计 v1.6 为准；任何就地变体按缺陷处理。
6. 已知面登记不设断言：交替 on/off 的合法 bump（上界 = WS 限流 20/5s）；去抖留将来。

## §3 开放项

1. 管理端可调时长（四值进 CONFIG_KEYS）——不做，仅 env 测试注入；另立案。
2. DouZero 托管——用户已裁不做。
