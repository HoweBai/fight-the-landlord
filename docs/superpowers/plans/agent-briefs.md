# Agent 启动说明（角色路由）

> 用途：任何**全新 session** 都能凭本文 + `2026-09-13-parallel-dev.md` 直接接手一个角色，无需继承任何历史对话。
>
> ⚠️ **口径（R701，2026-09-20）**：范围 = **H5 + App**。小程序端（`mp-weixin`）排除在
> **一切设计/开发/测试**之外：代码保留冻结、不删、不入任何门禁、不为其写用例。
> 文中**历史记录**里的「三端」指的是当时的口径（H5 + 小程序 + App），**不改写历史**；
> 但**新写**的纪律一律只讲 H5 + App。
>
> **本文件只写「角色差异」。** 全局约束、任务分解、DoD、切片的完整内容都在 `2026-09-13-parallel-dev.md` 里，**每个角色都必须先读它**（尤其其中的 Global Constraints 12 条，逐字遵守）。

---

## 三个角色

| 角色 | 工作区 | 拥有的分支 | 主任务 |
|------|--------|-----------|--------|
| **协调者** | `/home/howe/pokergame`（主检出） | `master` | 拥有契约包与根配置、评审每个切片、合并、跑 conformance |
| **后端 agent** | `/home/howe/pokergame/.worktrees/backend` | `feat/backend` | 计划中的 Task 2，以及切片 5–10 的后端侧 |
| **前端 agent** | `/home/howe/pokergame/.worktrees/frontend` | `feat/frontend` | 计划中的 Task 3，以及切片 5–10 的前端侧 |

**任何人只在自己那个目录里工作。** 不要 `cd` 到别人的目录。

---

## 所有角色开头的固定动作

```bash
# 确认自己在哪
pwd && git branch --show-current

# 新 worktree 必须先 build —— dist/ 是 gitignore 的，
# 没有产物时 shared 会因解析不到 @fight-the-landlord/protocol 而 collect 失败
pnpm install && pnpm build

# 后端角色额外：**不需要**为单测起容器。
# ⚠️ 2026-09-15 更新（切片 7.1 / E10）：`match.service.test.ts` 过去有 5 条用例**真的**发网络请求
# （`startGame` 用全局裸 `fetch` 打 localhost:3003），异常被 try/catch 吞掉 ⇒ 容器在不在都通过（判据是假的）。
# 现在 `startGame` 走注入的 `HttpService`，且该文件在 `beforeEach` 装了「全局 fetch 抛错」探针
# —— 任何残留的裸 fetch 都会当场暴露。**只有在跑 conformance 时才需要容器**：
# `DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`（改过 room-service 只需重建它）。
```

**必读**：
1. `docs/design.md`（v4.1 主规格）——**权威依据**
2. `docs/games/doudizhu.md`（v1.2 玩法规则）
3. `docs/superpowers/plans/2026-09-13-parallel-dev.md`（计划 + Global Constraints）
4. 本文

---

## 协调者（角色）

**可写**：`packages/protocol/**`、根配置（`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `turbo.json` / `tsconfig.base.json` / `.gitignore`）、`tools/**`、`docs/**`

**职责**
1. **契约的唯一裁决者**：任何 agent 提出契约变更，由你决定并落到 `packages/protocol`（**破坏性变更必须两端同一个 PR**）
2. **每个切片后评审**：读该切片的关键 diff（不要通读全部），核对是否符合 spec；发现反复犯同一约定错误（例如又用字符串错误码、又信任 body 的 `playerId`）就**重新派生该 agent** 并把教训补进本文件
3. **合并**：两个 worktree 目录不重叠，合并应干净；冲突一律由你解
4. **联调**：跑 `tools/conformance`（见下）

**`tools/conformance`（协调者拥有，切片 5 建立）**

```bash
pnpm --filter @fight-the-landlord/conformance build
pnpm --filter @fight-the-landlord/conformance conformance:slice-05   # 或 node tools/conformance/dist/run.js slice-05
```

它**刻意不挂 `turbo run test`**（需要 3000-3003 的服务在跑，挂进去会让无容器环境假红）。
**跑之前必须先重建镜像**，否则测的是旧代码：
`docker compose build && docker compose up -d`。

**当前待办（2026-09-16，独立小片 P8 收口后）**：**切片 5–11 + 独立小片 7.1/7.2/P3/P4/P5/P6/P7/P8 全部收口**（`docs/design.md` 附录 A.2 的 53 条偏差 + 新增 N 系列；对账表 §0 现为 **80 条：78 已关闭 / 0 部分关闭 / 2 仍开放**）。
**P5（上线准备收口）已交付**：**N25** §2.4 的 `checks` + 存活/就绪分离（五个服务）· **N24** §13.3 覆盖率门槛入配置（**会失败**，实测 97.58%）+ §13.4 的 `scripts/ci.sh` 六阶段（Actions 薄调用）· **N23** 删除 `rule/beat.ts` 的 `canBeatWithHand` 死代码 · **R268** §12.4 落地形态裁决（以既有 vitest 源码闸为准，不照搬 ESLint 插件）。
**P6（工程债收尾）已交付**：**R253** `slice-11` 第 6 组的相对量池判据 → 纯谓词的三条绝对性质（`slice-11` 46 → **50** 项；窗口边界与受控构造的反直觉前提见下方教训）· **R310** `api-gateway` 补 `reflect-metadata` 直接依赖（探针实测 RED → GREEN）· **R119 → 新登记 N26**（实证「无影响」+ 一条约束，**不改代码**）· `design.md` **12 处**过期注记清理（`[偏差]` 33 → 21 处）· 台账 §3 销掉 5 行**自己已过期**的登记。
**唯一仍开放的是 N13**（登录/注册/刷新**无 IP 维度限流** —— 登记时就写明：§5.4 只定义了四个维度、没有「单 IP HTTP」，凭空加一维会打伤 conformance 的造数步骤；治理它属**风控/防刷**，归 roadmap §16，**不是本 MVP 的安全边界**）。⇒ **MVP 范围内的偏差已全部关闭。**
**P4（基础设施）已完成**：**N20** §4.2 的 TCP RPC 迁移（`connectMicroservice` + 3103/3105 + compose + 全部调用点，一次全切）+ 同片关闭 **N22**（池幽灵成员）。
**P3（工程）已完成**：**E2** PORT · **E6** `Room.timeoutAt` · **E7** 关 `synchronize` + 显式迁移（`migrationsRun`）· **N9** 房间元数据 Hash 化 · **N12** 未知路由信封 · **N14** 非 `/api` 机械闸 · **N15 后端半边**（限额挪到 `allowRequest`）· **N21**（`bot:bound` + 回收扫得到 `release` 丢失）· **R243**（`slice-11` 池判据重写）。
**切片 10 已收口**（见下方「切片 10 门禁实测」）：**C1/C2/C3/C26 + N1/N17 关闭**；**新增 N19 并同片关闭**（`match.service` 硬编码 `baseScore: 100`，让 §3.1→§4.2 的底分链路断在最后一跳）。
**⚠️ 切片 10 开工前必读的三条（已完成，留档；每条都按预测兑现）**：
1. **N1 的后果比原登记强得多**：`game.settlement` **整条被网关的出站校验拦掉**，客户端**只收到 `game.finished`** —— 不是「字段是 `undefined`」，而是**事件不存在**（`store.settlement` 恒为 `null`，结算页永远不显示）。实测原文（网关日志 6 条 = 2 次对局结束 × 3 家）：
   `[ProxyGateway] Blocked outbound game.settlement for client <id>: ProtocolError: $.payload.baseScore must be a finite number, got undefined`。
   根因：`settle.ts` 的内部 `SettlementResult` 与契约同名不同形，而 `ProxyGateway` 对**每一条** S→C 推送都过 `validateOutbound`（§6.4 规则 4）⇒ 校验失败即 `return`。
   **结局**：`e773637` 删掉内部类型改为 re-export 契约类型；**重建容器后整轮 11 条切片跑完，网关 `Blocked outbound game.settlement` = 0 条**。
2. **N1 修好后必须回 `tools/conformance/src/slices/slice-09-play-rotation.ts` 恢复那条断言**。**结局**：`4ad2715` 恢复了 5 条（场景 A 的 `winner`/`spring`/`multiplier` + 场景 B 的 `winner`/`spring`），`slice-09` 从 155 → **160 项**；未修栈上这 5 条确实红（`A0/B1 等 game.settlement 超时（8000ms）`）⇒ 恢复不是装饰。
3. **`settle.test.ts` 里那条「两名农民手牌都为空」的旧用例恒真、无判别力** ⇒ **结局（复核结论）**：它**已由切片 9 改写**（现为「只有一名农民为空」），本片重写该文件时保留判别形态 —— 退回 `farmers.every(...)` 会让 `settleGame` 抛 `Game not finished` ⇒ 必红。**该条复核闭环，无需再动。**
**切片 9 已收口**（见下方「切片 9 门禁实测」）：**C16/C18/C19/C20 + N2/N16/N18 关闭**；**C5/C6/N15 部分关闭**（各自写明剩下哪一半：C5+E4 的 §9.1 ①②③ → 切片 11；C6 的 `HandType.Invalid` 启用 → 切片 11；N15 的后端半边 → 独立小片 P3）；新增 **N17**（已由切片 10 关闭）。
**切片 7.2 已收口**（`0617152`）：S4/S5/S6/S7/A6 + N5/N6 + R98 + N10/N11 全部关闭，**§A.3 部署闸门解除**；A7 收窄为部分关闭（剩两半归切片 11）；新增 N12–N15 待办。
另外：各切片评审里记为 deferred 的 Minor 项（见 `.superpowers/sdd/2026-09-13-parallel-dev/progress.md` 的「延后项」）
与对账表 §2 的 `独立小片（P3）`（E2 / E6 / E7 / **N9** / **N15 后端半边** / N12 / N14）；**R119**（`GameService.timers` 从不自我清理）仍是**未修隐患**，只登记未立条。

---

## 切片 5 新增的固定动作（两端都要照做）

- **开工前 `git merge master --no-edit`**：master 会带着协调者的裁决与构建修复往前走，不 merge 会基于过期契约实现。
- **`pnpm install && pnpm build` 要重跑**：master 新增工作区包（如 `tools/conformance`）后，不重装会因
  `Cannot find module 'socket.io-client'` 之类的**假失败**浪费一轮。
- **契约有歧义时不要自行解释**：切片 5 期间出现的三处真歧义（重连窗口起点、`game.resync` 的 `baseVersion`、
  §12.4 的 ESLint 落地形态）全部由协调者裁决并落盘。提问比猜便宜。

---

## 后端 agent（角色）

**可写**：`packages/{api-gateway,user-service,room-service,game-service,robot-service,shared}/**`、`docker-compose.yml`

**只读**：`packages/protocol/**`、`docs/**`、根配置文件、`apps/**`

**硬性约束**（违反即打回）
- **不得修改 `packages/protocol`** —— 需要改契约就在汇报里提出
- **严禁信任请求体里的 `userId`/`playerId`**；身份只从 `X-User-Id`（HTTP）或 socket 握手 `auth.userId`（WS）取
- **错误码必须是 5 位数字**（`packages/protocol` 的 `ErrCode`）；不得新增字符串码
- **对外 REST 与内部 RPC 严禁共用方法**：对外走 `game.view`（裁剪），对内走 `game.snapshot`（完整）
- 所有出站路径必须接 `validateOutbound()` —— 它会机械拦住 `actionLog`/`isRobot`/`botId`/`skillLevel`/他人手牌的泄漏

**当前任务**：**切片 11、独立小片 P4（N20 TCP RPC）、独立小片 P3（工程收口）的后端侧都已完成并合并**。P3 的后端侧交付：`user-service` 读 `PORT`、`Room.timeoutAt`、`room:{code}` Hash 化、关 `synchronize` + 显式迁移、网关 404 信封、非 `/api` 机械闸、WS 限额挪到 `allowRequest`、`bot:bound` 索引 + 兜底回收。计划 `2026-09-16-slice-p3-engineering-closeout.md`（裁决 **R244–R266**）。P4 的后端侧交付：两个服务的 TCP 监听 + 七个 `@MessagePattern` + 全部调用点迁到 `ClientProxy` + 内部 HTTP 路由整条删除 + compose 端口 + 两条源码级机械闸（`no-internal-http.gate` / `rpc-listen-bind`）。计划 `2026-09-16-slice-p4-tcp-rpc-migration.md`。
**下一片 = 无指定的垂直切片**（MVP 范围内的偏差已全部关闭，且 P7 之后**台账里不再有代码相关的真缺陷**）。若要继续，候选按**性价比**排序：**文档复审**（`design.md` 剩余 **22** 处未核实的 `[偏差]` + **18** 处 `[部分实现]`/`[待实现]` 标题标记 + `docs/games/doudizhu.md` 的 2 条过期注记 —— 需要逐节判断「实现是否真的完成了这一节的全部条款」）、**N13**（风控/限流，roadmap §16 —— 是 feature 不是 bug）、以及 `conformance` 里三份 `redis-cli` 探针外壳的统一（R393 登记的余量）。
**待办清单**：对账表 §3「文档待更新」全表 + §2。
⚠️ **P4 留给后来人的一条硬约束**：`connectMicroservice` 的 `options` **只能是一层 `{host, port}`**，且必须显式写 `connectMicroservice<MicroserviceOptions>(...)` —— 多嵌一层会让端口静默回落到 3000 并且**照样打 success 日志**（R239，本片最贵的一条坑）。

---

## 前端 agent（角色）

**可写**：`apps/client/**`（uni-app 工程，需新建）

**只读**：其它全部（**尤其 `packages/shared` 不要动、也不要 import**）

**硬性约束**（违反即打回）
- **不得 import `@fight-the-landlord/shared`** —— 它含游戏规则。**只允许 import `packages/protocol`**
- **不得出现任何牌型判定、倍数计算、底分常量、叫抢规则**（§12 的 F01/F02/F09/F10）。你不知道也不该知道「什么是顺子」
- 每个入站消息先过 `validateInbound()`
- 每个错误码走 `CLIENT_ACTION` 表分支。**`13004` 的唯一处置是「就地刷新快照」，不是断线重连**
- **不得修改 `packages/protocol`** —— 需要改契约就在汇报里提出

**关键语义**（易错，务必照做）
- 一次状态转移会发**两条**推送（`game.state_update` → `game.current_turn`），**共享同一 `version`**：快照类按 `version` 判定与丢弃，**事件类不按 version 丢弃**；先应用快照再处理事件
- `baseVersion` 只有 `game.bid`/`game.play`/`game.pass` 需要真实值，其余传 `0`；**请求必须串行**（收到 ack 或 `game.state_update` 后才允许下一次）
- **叫抢阶段的行动者是 `bidPhase.currentBidder`，不是 `currentPlayer`**
- 「谁是地主」的唯一来源是 `PlayerView.landlordSeat`
- 心跳只用 socket.io 内置，不要写应用层 ping/pong

**当前任务**：**切片 9 已完成并合并**（前端 `00f00c5` / `32e7e09` / `db8b698`；选牌/出牌/过牌/倒计时的接线判据 + N15 前端半边）。
**切片 9 修掉的一个真实前端缺陷（R173 / N18，值得记住）**：选中态原本按**牌值**记录（`toggleCard` 用 `indexOf(value)`），
后果是阻断级的 —— 同一个点数**最多只能选一张**（点第二张同点数的牌会把第一张取消）⇒ **对子/三张/炸弹/四带二/连对从 UI 永远送不出去**；
且 `Hand.vue` 用 `selected.includes(value)` 标记 ⇒ 同点数的牌**整组高亮**（UI 在说谎）。
现按 `store.hand` 的**下标**（牌实例）记录，并加手牌内容指纹 watcher 兜「下标过期」。**规则：UI 的选中态必须钉在实例上，不能钉在值上。**
**N15 的机制表述已校正（原表述不准确）**：socket.io 客户端对被服务端踢线（`io server disconnect`）**本身不会**自动重连；
真正要堵的是「后续 `connect` 事件触发**我们自己的** `game.reconnect` 恢复流程」（`serverRejected` 闩锁 + `handleSocketReconnect` 早退）。
N15 **部分关闭**：剩下的一半是把限额检查挪到 namespace middleware / engine.io `allowRequest`（→ 独立小片 P3）。
**下一片有前端 = 切片 10（已完成）**：结算页 `Settlement.vue`（纯展示 `winner`/`spring`/`multiplier`/`baseScore`/座位/分差，**零计算**）+ **N17**（局终 `state='ended'` 视图 ⇒ 终局态 UI `.table__ended` + 顶栏三态「叫抢中/出牌中/已结束」）。
**切片 10 交付**（`e9f1017` / `220d416`）：`Settlement.vue` 的 9 个稳定 class、`spring` 三态文案映射（`无/春天/反春天`）、`isEnded` getter；判据 9 条（6 + 3），且**已把新组件纳入 `source-boundary.test.ts` 的「扫描器确实读到了文件」自证**（+5 行，配变异探针自证判别力）。

---

## 汇报格式（所有 agent 统一）

```
## 完成情况
（逐条对应 DoD，附实际命令与输出）

## 改动清单
（文件 + 一句话说明 + commit sha）

## 阻塞/未完成
（明确说明）

## 需要协调者裁决的事项
（例如契约需要改的地方；没有就写"无"）

## 我发现的、文档未记录的问题
（有价值——本项目前几轮的缺陷都是这样发现的）
```

---

## 交接现状（截至 `d5a3700`（P23）；本表最后一行 = **P24**）

| 项 | 状态 |
|----|------|
| 契约包 `packages/protocol` | ✅ 完成（39 测试全绿）。零依赖，前后端唯一契约源 |
| 计划 + 全局约束 | ✅ `2026-09-13-parallel-dev.md` |
| Task 1 两个 worktree | ✅ 已建、已同步 |
| Task 2 后端骨架 | ✅ **完成并已合并**（S1/S2/S8 修复 + 身份透传 + WS 接线 + 真机端到端验证） |
| Task 3 前端骨架 | ✅ **完成并已合并**（`apps/client`，Vite+Vue3 等价骨架） |
| Task 4 mock 服务 | ✅ 完成（`tools/mock-server`，端口 3400） |
| Task 4 conformance | ✅ **完成**：`tools/conformance`（切片 5 建立），真实后端 + 真实 socket.io 客户端 |
| **切片 5 断线重连** | ✅ **完成并已合并**（后端 `feat/backend` + 前端 `feat/frontend`），门禁 [见下](#切片-5-门禁实测) |
| **切片 6 登录+房间列表** | ✅ **完成并已合并**（`42b64bb`），门禁 [见下](#切片-6-门禁实测) |
| **切片 7 匹配→进房** | ✅ **完成并已合并**（`9dcbaa6`），门禁 [见下](#切片-7-门禁实测) · 裁决 R42–R71 见 `2026-09-13-slice-07-match-and-join.md` |
| **A.2 偏差对账表** | ✅ `docs/superpowers/plans/deviation-ledger.md` —— 51 条 A.2 偏差 + 5 条新增，逐条**判定/证据/关闭者/归属**，并附**按切片的待办清单**。**每个切片开工前先读它。** |
| **切片 7.2-P0/P1 安全收口** | ✅ **完成并门禁通过** —— P0 `?seat=` 手牌泄漏（`ff44a4d`）、P1 下游身份边界（`9084bf9`）；`slice-07.2-security` 39 · `slice-07.2-boundary` 70 |
| **切片 7.2 完整片** | ✅ **完成并门禁通过**（`0617152`）—— S4/S5/S6/S7/A6 + N5/N6 + **R98/N10/N11** 关闭；`slice-07.2-hardening` **53** · `slice-07.2-deploy` **22**（§A.3 部署闸门解除）；A7 部分关闭（剩两半归切片 11）；新增 N12–N15 |
| **切片 7.1 room 收尾** | ✅ **完成并门禁通过**（`9eb410c` 合并 + `8496ab8`）—— C11 原子入座 + E10 单测去网络依赖 + N8；`slice-07.1` **28 项**；负对照确定性红（见下） |
| **切片 8 叫抢地主** | ✅ **完成并已合并**（`ef7c89c`），门禁 [见下](#切片-8-门禁实测) · 裁决 R101–R123 见 `2026-09-15-slice-08-bidding.md` |
| **切片 9 出牌轮转** | ✅ **完成并门禁通过**（后端 `4b8974b`/`bab2c26`/`2cff749`/`9e7c85b`/`1b0548a`+合并 `0487543`；前端 `00f00c5`/`32e7e09`/`db8b698`+合并 `c0469e7`；conformance `e81c84f`/`eee42d4`/`6f70ab0`/`cb2b208`）—— `slice-09` **155 项**；关闭 **C16/C18/C19/C20/N2/N16/N18**，部分关闭 **C5/C6/N15**（各写明剩下哪一半），新增 **N17**，**N1 的后果被实测校正**（见下）。计划 `2026-09-15-slice-09-play-rotation.md`（裁决 R157–R171 + 执行期 R172–R181） |
| **切片 10 结算** | ✅ **完成并门禁通过**（后端 `9f4d69f`/`e773637`/`5a3a1e0` + 合并 `e37ee24`；前端 `e9f1017`/`220d416` + 合并 `1395b71`；conformance `c78f14f`/`4ad2715`；协调者 `a2dde40`/`d32a6cc`）—— `slice-10` **185 项**（新增）· `slice-09` **160 项**（155 → +5 恢复的 `game.settlement` 断言）；关闭 **C1/C2/C3/C26/N1/N17**，**新增 N19 并同片关闭**；**N1 的后果被实测校正后又实测归零**（网关 `Blocked outbound game.settlement` 0 条）。计划 `2026-09-15-slice-10-settlement.md`（裁决 R182–R193） |
| **切片 11 §9 机器人系统** | ✅ **完成并门禁通过**（后端 `11c42b6`…`d511fda` + 合并 `ed33156`；conformance `9865efa`/`e056c6d`；协调者门禁修复 `robot.pool`/`ws.module`/`robot.controller`/两张源码闸）—— `slice-11` **44 项**（新增，六组：驱动/出牌/收束/§9.8/池/幂等）· 12/12 conformance 全绿；关闭 **C7/C8/C9/E4/E9/A7④⑤ + C5、C6 的剩余半边 + §9.4**；新增 **N20**（TCP RPC → P4）与 **N21**。计划 `2026-09-15-slice-11-robot-system.md`（裁决 R200–R217） |
| **独立小片 P4（N20 TCP RPC 迁移）** | ✅ **完成并门禁通过**（`aca891b`/`24188cd`/`b5d02ce` + 之前 8 个 commit）—— `game-service`/`robot-service` 起 TCP 监听（3103/3105）+ 七个 `@MessagePattern`（`RPC_PATTERNS` 常量化）+ **全部**调用点走 `ClientProxy`（超时/重试逐字照 §4.3）+ 内部 HTTP 路由整条删除 + compose 只 `expose`。`slice-07.2-rpc` **61 项**（新增）· **13/13** conformance 全绿 · 关闭 **N20**，**新登记并同片关闭 N22**（`robot.pool.takeIdle()` 幽灵成员吃容量）。计划 `2026-09-16-slice-p4-tcp-rpc-migration.md`（裁决 **R218–R242**）。⚠️ 门禁期抓到 **4 个真缺陷**（全部「单测全绿、容器/门禁红」），见下方「切片 P4 门禁实测」 |
| **独立小片 P3（工程收口）** | ✅ **完成并门禁通过** —— `turbo run test lint --force` **29/29** · `build --force` **10/10** · 前端零改动 · conformance **13/13** · 关闭 **E2/E6/E7/N9/N12/N14/N15（后端半边）/N21 + R243**。计划 `2026-09-16-slice-p3-engineering-closeout.md`（裁决 **R244–R266** + 执行期 **R280–R283**） |
| **独立小片 P5（上线准备收口）** | ✅ **完成并门禁通过** —— §2.4 健康检查（`checks` + 存活/就绪）· §13.3 覆盖率门槛 · §13.4 CI 六阶段 · §12.4 闸形态（R268）· N23 死代码。见下方「切片 P5 门禁实测」。计划 `2026-09-16-slice-p5-launch-readiness.md`（裁决 **R267–R271** + 后端 **R284–R296** + conformance **R300–R319**） |
| **独立小片 P6（工程债收尾）** | ✅ **完成并门禁通过** —— **R253**（`slice-11` 第 6 组相对量判据 → 绝对性质，`slice-11` 46 → **50** 项）· **R310**（`api-gateway` 补 `reflect-metadata` 直接依赖）· **R119 → 新登记 N26**（实证「无影响」+ 一条约束，**不改代码**）· `design.md` **12 处**过期注记清理（33 → 21 处 `[偏差]`）。见上方「切片 P6 门禁实测」。计划 `2026-09-16-slice-p6-engineering-debt.md`（裁决 **R309–R313** + 后端 **R320–R323** + conformance **R340–R342**） |
| **独立小片 P7（收掉最后两条真缺陷）** | ✅ **完成并门禁通过** —— **B1** `slice-07.2-rpc` 第 6 组的相对量判据换绝对性质（61 → **65**，谓词抽 `lib/pool-idempotency.ts` 作唯一实现）；**B2** 删除遗留第二契约 `shared/src/protocol/message.ts`（4 处）+ 新增 **21** 条防复活闸并注册进 `ci.sh` 第 6 阶段（§12.4 现 **6** 条闸）。见上方「切片 P7 门禁实测」。⇒ **台账里不再有代码相关的真缺陷**。计划 `2026-09-16-slice-p7-last-defects.md`（裁决 **R360–R363** + 后端 **R370–R378** + conformance **R390–R393** + 协调者 **R394**） |
| **独立小片 P8（文档复审）** | ✅ **完成并门禁通过** —— `design.md` **28 处**过期标记清理（14 内联 `[偏差]` + 14 行内 `[待实现]`/`[部分实现]`）+ **18 处小节标记**按逐条取证调整（12 上调 `[已实现]` / 6 保持 `[部分实现]` 并写明缺哪条）+ 附录 A.2 关闭 A2/C17/E4、订正 A3 + `doudizhu.md` 删 C16/C17。见上方「切片 P8 门禁实测」。计划 `2026-09-16-slice-p8-docs-review.md`（裁决 **R395–R402**）。
| **N27 收口（P8 的后续动作）** | ✅ **已完成并验证**（`2b228c0` + `dc8c093`）—— 删除 `GameSession.deck` 死字段（§3.2 逐字要求删）：**先删声明让 tsc 暴露引用面**（精确报出 5 处）⇒ 逐个收；`tools/conformance` 的 `LEAK_KEYS`/`slice-05` 文案同步（`PlayerView` 自始不含它 ⇒ 原禁止项**空转**）。⚠️ **判据比原来更强**：原断言 `dealt.deck` **长度为 0**（恰好允许字段以空数组存在）⇒ 改为断言 **`'deck' in dealt === false`**（字段不存在）。验证：`shared` 187 · 全量 **29/29** · conformance `slice-05`/`slice-11`/`slice-07.2-boundary` 全绿 · 8 容器 healthy。 |
| **真浏览器验证（本仓第一次）** | ✅ **已通过**（`a5a0cb6` 修复两处阻塞后）—— 真浏览器从注册走到**牌桌**（房间 v10、出牌中、地主 16 张、我 13 张、上一手 `A A`、底牌 `J 6 3`、出牌/过牌可用）。⚠️ **第一次验证是失败的**，抓到两个**CI 不可能发现**的阻塞缺陷：**N28**（真后端每条 S→C 推送都被客户端拒收 —— 网关 body 不带 `type`、mock 带 ⇒ **对着 mock 能过、对着真网关必挂**）· **N29**（客户端默认 socket 端点指向 mock 3400，`dist/` 里也打进 ⇒ 默认连不上真网关）。见上方「真浏览器验证」两节。 |
| **切片 P9（真浏览器门禁 + N32/N30② 跨局复位）** | ✅ **完成并门禁通过** —— **把「前端 ↔ 真后端」这条接缝接进门禁**（零依赖 CDP 探针 `scripts/browser-e2e.mjs`，`pnpm run e2e:browser`）· **N32 关闭**（换局边界复位 `currentVersion`）· **N30 转「部分关闭」**（只关 ②）· **N31 完成定位取证**（根因 = `updateStatus(code,'playing')` 从未被调用）。见下方「切片 P9 门禁实测」。计划 `2026-09-17-slice-p9-browser-e2e-and-session-reset.md`（裁决 **R415–R430**，其中 R415–R422 开工前已落盘） |
| **切片 P10（uni-app 多端打包迁移）** | ✅ **已完成并门禁通过**（`fde341e` Task 1 · `65a5ea4`/`07483ca`/`f5e0526` Task 2 · `302ffca`/`e9f9d68`/`4acf0db`/`335cbce` Task 3 · 前置 `1cac186` · 探针加固 `ed76361` · 收口见本表新增的「切片 P10 门禁实测」行）—— **原记录**：📋 已裁决要做、尚未开工（R428，2026-09-17 用户裁决）—— `apps/client` 实际是 **Vite 6 + Vue 3.5 SPA**，而 `design.md` §1.4 的「目标态」是 uni-app、`2026-09-13-parallel-dev.md` 的 Task 3 要求新建 uni-app 工程 ⇒ 台账 **N33**（真欠账）。计划 `2026-09-17-slice-p10-uniapp-migration.md`（裁决 **R428–R450**）。⚠️ **开工前有两个前置必须确认**：① **目标端清单**（uni-app 出**小程序**、**不出微信小游戏** —— 后者是 canvas 引擎的另一条轨道）；② **是否接受 Vite 降级**。两条硬约束已实测并写进计划：**uni-app 的 Vue3 线在 `vue3`/`alpha` dist-tag 上（`latest` 是 Vue 2 线 ⇒ `pnpm add` 会装错）**；**`@dcloudio/vite-plugin-uni` 的 peer 是精确 `vite: "5.2.8"`**（当前 Vite 6 ⇒ 必然降级）。爆炸半径已量：7 个 `.vue` / ~92 个 HTML 标签 · 6 个 `mount()` 测试 · 探针 5 个标签依赖选择器 |
| **切片 P11（A 类真缺口）** | ✅ **已完成并门禁通过**（`785019f`/`325ba0d`/`cfd1a83`/`ea5618a`/`9d1a7bd`/`7ace70b`，裁决 **R451–R462**）—— 3 个前端/后端子 agent 的产物 + 协调者门禁。**关闭 `N13`（单 IP 120/min + §5.4 补第五维）· `N30`（①③）**；**`N31` 转部分关闭**（状态机两个写入点已补；剩「终局无清理」与「`isWaitingExpired` 零消费者」）；**新登记 N34/N35/N36**。⚠️ **门禁抓到一条可用性回归**（R462）：IP 维度放在未认证早退之前 ⇒ **`/api/health/live` 变成查依赖**（Redis 挂时 503）违反 §2.4/R285，`slice-07.2-deploy` 当场红；修复 = 健康端点豁免（`publicPaths` 提成单一真源 + 顺序改为「豁免 → IP → 用户」）。**最终门禁**：`build` 10/10 · `test lint` **29/29**（单测 **978 passed + 2 skipped**：room-service 204 · api-gateway 149 · client 185）· `ci` 六阶段全绿 · 8/8 healthy · **conformance 13/13（1194 项）** · 探针 **gate 16/16 · full 20/20** |
| **切片 P12–P14（B/C/D 三类）** | ✅ **三类全部执行完毕并门禁通过** —— **B（P12）** `design.md` 的 6 处 `[部分实现]` 6 → 3 · **C（P13）** `doudizhu.md` 的 32 处 `[偏差]` 32 → 0 · **D（P14）** 台账 §4 的 8 条 → **1**（逐条见下三行）。（2026-09-17 用户要求「依次完成，能分派 agent 就分派」）—— 把上一轮盘点里「还没完成」的 **A/B/C/D 四类**各写成一份可独立执行的计划：<br>**A → `2026-09-17-slice-p11-real-gaps.md`**（裁决 **R451–R470**）：`N31` 房间状态机落地 `playing`/`finished`（含 `cardCount` 死分支复活的连带，R451）· `N13` 单 IP HTTP 维度限流（120/min，R453 并把阈值写进 §5.4）· `N30①③` 大厅建房入口 + 房间列表可点 + 连不上时呈现连接状态（R454/R455）。**三条互不依赖，可并行派工**。<br>**B → `2026-09-17-slice-p12-spec-partial-closeout.md`**（**R471–R490**）：`design.md` 剩余 **6** 处 `[部分实现]`—— 只有 2 处是真代码（§5.3⑦ `playerId`→`12003`；§3.2 类型形状并删除模块增强），其余 4 处是裁决+文档收口（§7.1 TLS 归部署层 / §8.3 是 R53 的刻意不做 / §8.4① 单 region 无对象 / §9.8 已由 R399#6 裁决不补闸）。**明确不承诺降到 0**。<br>**C → `2026-09-17-slice-p13-doudizhu-docs-review.md`**（**R491–R505**）：`docs/games/doudizhu.md` 的 **32** 处 `[偏差]` 全量复审（P8 只做了 `design.md` 那批）。与 P8 同形：**零代码改动 ⇒ 轻量门禁** + 2 个**只读审计 agent** + 协调者编辑。<br>**D → `2026-09-17-slice-p14-unverified-items.md`**（**R506–R520**）：台账 §4「无法确认的项」**8 条**逐条了结（甲组 5 条现在就能验 · 乙组 1 条用**一次性隔离容器**造下游超时 · 丙组 2 条本机不可能验、改写为部署前提/结案）。 |
| **切片 P12（B 类：`design.md` 剩余 `[部分实现]` 收口）** | ✅ **已完成并门禁通过**（`02f72d9`/`2445161`/`3430a8a`，裁决 **R471–R476** + 执行期 **R478–R482**）—— **只有 2 处是真代码**：**§5.3⑦** `playerId` 一致性校验 ⇒ `12003`（R471，修前 RED `expected +0 to be 12003`）· **§3.2** 类型形状收口（`turnDeadlineAt` 必填上移 + `createdAt`/`finishedAt` → `number` + `game.types.ts` 模块增强**整体删除**，R472）。**处置**：`grep -c '^### .*\[部分实现\]' docs/design.md` **6 → 3** —— 3 处上调 `[已实现]`（§3.2 / §5.3 / §9.8）· 3 处**保留**并写明理由（§7.1 TLS 归**部署层** R473 · §8.3 **刻意不做** R474 · §8.4① 单 region 无对象 R475）· §9.8↔§12.4 补**交叉引用**（R476 沿用 R399#6：性质由**阶段 4** 覆盖，刻意不补阶段 6 第 7 条闸）。**最终门禁**：`build` 10/10 · `test lint` **29/29、0 cached**（单测 **985 passed + 2 skipped**：room-service 204 → **207**）· `ci` 六阶段全绿（第 6 阶段 8/8/5/6/3/21）· 8/8 healthy · **conformance 13/13**（slice-11 50 · rpc 65 · deploy 104 · hardening 103 · boundary 82 · security 40 · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 129 · 05 29）· 探针 **gate 16/16 · full 20/20** · 网关 `Blocked outbound` **0**。⚠️ **执行期发现**：`game-service` 的 `test/**` **从不过 `tsc`**（`include` 只有 `src/**`）⇒ 夹具形状漂移长期不可见（`makeSession()` 缺 `baseScore`/`turnDeadlineAt`、多一个已删的 `deck`）；本片已补齐，**结构性缺口登记待办**（R481）。 |
| **切片 P13（C 类：`doudizhu.md` 的 32 处 `[偏差]` 全量复审）** | ✅ **已完成并门禁通过**（裁决 **R491–R505** + 执行期 **R496–R502**）—— **零代码**（Global Constraint 1）⇒ **轻量门禁**（R491）：`git diff --stat` **只 docs/** · `turbo run test lint --force` **29/29、0 cached** · `node scripts/ledger-counts.mjs` ✅ 逐区一致。**形态口径**：`grep -c '\[偏差\]' docs/games/doudizhu.md` **32 → 0** · `[待实现]` **2 → 0** · `[部分实现]` **2 → 0**（**净删 92 行**，533 → 461）。**32 条构成**：9 行内（§1–§7）+ 5 行内（§8–§9）+ 18 行 §11 表，**非注记提及 = 0**（本文件**无大纲级** `[偏差]`）。**处置分布**：**删除 31 / 改写 1 / 保留 0 / 无法确认 0 = 32**（两个**只读审计 agent** 独立取证：Part A 9/9 全删、Part B 22 删 + 1 改；每条附 `文件:行` + 复核命令）。**同源遗漏面一并处置**（R498/R501，**分开计数、不混入 32**）：另 **4 处别的形态**标记全过期（§10 `[部分实现]` + §11 表 `[待实现]`×2 / `[部分实现]`×1）· §11 **一行无标记但叙述过期** · §9.1 **两段**过期实现断言 · §8.4 **一段**建议已落地 · **2 处**纯坐标漂移。**新登记 N37（仍开放）**：动作被规则拒绝时 `applyAction()` 已 `clearTimer()` 却**无任何路径重挂** ⇒ **该回合零时限**（§9 前言被违反）。⚠️ 两个 agent 都**顶回**了派工单的事实错误（`rule/beat.ts` 已随 N23/`e0642ca` 删除 · DouZero 在**仓库根** `douzero/` 而非 `tools/douzero/`）。 |
| **切片 P14（D 类：台账 §4「无法确认的项」逐条了结）** | ✅ **已完成并门禁通过**（裁决 **R506–R520** + 执行期 **R511–R515**）—— **§4 由 8 条 → 1 条**。**7 条搬出**（终态 + 命令 + 原文输出落盘进 §4 的「已搬出」表）：**S2/S8** ⇒ 本片**新增** `slice-07.2-security` 第 6b 步（§4 逐字要的「**非本房 token + `%3F` 走私**」**组合**，此前只有两半各自被覆盖）实测 `HTTP 400 / 10001` 且不含 A/B 手牌 ⇒ **40 → 43 项** · **S7 运行态泄敏** ⇒ 跑完一局后采样，**10 类危险模式全 0**（非零读数逐条归因到 `handshake` 子串 / 拒绝原因文案的 `token` / 机器人内部 id 运维日志）· **C22/C28 计时器** ⇒ 真 Redis + 多进程下**不投任何客户端动作**：playing `v60→63`（行动者轮转 + `turnDeadlineAt` **每次重挂**）、bidding `v1→3`（**`currentPlayer` 恒 0** 而 `currentBidder` `0→1→2`）· **C15 DouZero** ⇒ **原前提已证伪**（`ftl-douzero Up 16h healthy`）+ 真 `source=douzero` 决策 + **46** 条 §9.4 降级 + 牌堆守恒 **54 = 32+22**（无 +3 异常）· **A7 下游超时** ⇒ **一次性隔离容器**（accept 不响应 + 一次性网关）实测 `503` + `10007` + **5.03s**，**正对照**指向真实下游 ⇒ `404` + **0.039s**，跑完残留 **0**、常驻栈 **8/8 healthy** · **socket.io 拒绝握手** ⇒ **结案**（R510：依据 R152 + N15） · **C20 `length`** ⇒ **全量枚举**（前端消费者只有 1 处，只读 `.cards`）。**仍留 1 条 = 生产网络隔离** ⇒ 按 R509 改写为「**部署前提**」。⚠️ **两处计划事实断言被实测推翻**：网络名是 `pokergame_ftl-platform`（非计划猜的 `pokergame_default`）· C15 判据 `grep -c "DouZero"` 实测 **0**（日志是小写 `source=douzero`）。**门禁（改了 `tools/conformance` ⇒ 标准全套）**：`build` 10/10 · 镜像重建 + **8/8 healthy** · **conformance 13/13**（security **43**）· 探针 **20/20** · `test lint` **29/29、0 cached** · `ledger-counts` ✅（90：84/1/5/0）。 |
| **切片 P15（台账 §1.5 的 5 条真缺口）** | ✅ **已完成并门禁通过**（计划 `7100109`；实现 `f229222`/`4cb3b00`/`7d59138`/`4288442`/`e2e4061`；裁决 **R521–R527** + 执行期 **R528–R531**）—— 按用户裁决（2026-09-17「**先做 P15**」）：**N35 补写入点** · **N36 不改语义 ⇒ 裁为「不实现」并改文档** · **N31 接入回收**；N34/N37 无需裁决。**关闭 5 条**：**N37**（`applyAction` 的 catch 重挂计时器 —— 修前该回合**零时限**，玩家掉线即**永久停摆**）· **N34**（`room.join` **兜底清票**，R418 同族）· **N35**（`room:{code}:cardcount` 的**写入方**：由 room-service 从**已收到**的 `seatViews` 派生 ⇒ **不需要**新跨服务边；键名提成单一真源 `cardCountKey()`）· **N31①+②**（新增 `RoomsReaperTask`：终局清理 + `isWaitingExpired()` 的**首个消费者**）· **N36**（§4.3 的 `game.start` 降级裁为「**本仓不实现**」+ 把现状钉成判据 —— 含义沿用 **N26** 先例）；**新登记 N38**（前端 `roomPlayers`/`seatedOthers` **零消费者**的死状态）。⚠️ **两条执行期发现**：**R530** `findAll()` **刻意排除 `cancelled`** ⇒ 回收**不能**建在它上面（`cancelled` 会成为**隐形**堆积源）⇒ 抽 `scanAllRooms()` + 新增 `listForReap()`；**R531** 假 Redis 的 `scan` 原为**恒返回 `[]` 的桩** ⇒ 回收在单测里是**空测**（已按真实语义实现）。**门禁（标准全套）**：`build` 10/10 · 镜像重建 + **8/8 healthy** · **conformance 13/13**（security 43，其余不回归；⚠️ `slice-06` 项数由历史 279 → **104** ＝回收任务在真栈里**真的**清掉了终局房间）· 探针 **20/20** · `test lint` **29/29、0 cached**（单测 **998 passed + 2 skipped**：room-service 207 → **219** · game-service 106 → **107**）· `ledger-counts` ✅（**91：89/0/2**）。 |
| **切片 P10（uni-app 多端打包迁移）门禁实测** | ✅ **完成并门禁通过**（计划 `2026-09-17-slice-p10-uniapp-migration.md`，裁决 **R428–R450** + 执行期 **R448–R450 / R441 补 / R449 补**）。**四段**：**Task 0** 前置 POC（零生产代码，三问全绿：H5 能起 / vitest 能 mount 新标签 / 探针 12 个选择器里 3 个失效）；**Task 1** 工程骨架 + 依赖（`1cac186` 前置 + `fde341e`）；**Task 2** 92 个标签改写 + `wot-design-uni` easycom + token/rpx（`65a5ea4`/`07483ca`/`f5e0526`）；**Task 3** 端能力替换（`302ffca` 存储 / `e9f9d68` 页面栈 / `4acf0db` 直接调用 / `335cbce` 小程序传输）。**门禁**：`turbo run build --force` **10/10** · `turbo run test lint --force` **29/29、0 cached**（单测 **1064 passed + 2 skipped**：client **251**+2 · room-service 219 · shared 187 · api-gateway 149 · game-service 107 · user-service 58 · robot-service 47 · protocol 44 · mock-server 2）· `pnpm run ci` **六阶段全绿**（阶段 6 的 8 条闸一条未放宽）· **三端构建 DONE**（`dist/build/{h5,mp-weixin,app}`；mp `usingComponents` **15/15 解析**）· 真浏览器探针 dev `gate` **16/16**（连续 3 次冷启动）+ `full` **20/20** · **发行产物级探针**（`build:h5` + `preview` 4173）`minimal` **8/8** + `gate` **16/16** · **conformance 13/13**（⚠️ **配方修正**：`slice-07.2-rpc` 的判据依赖机器人池基线 —— 本次实测在「先跑 `slice-11`」之后它红（`探针清理后池成员数回到基线（ZCARD 1 → 3）`），**单独 `DEL bot:pool:ddz` 后再跑即 65 项通过**；⇒ 跑 rpc 之前**再 DEL 一次**，或把 rpc 排在 slice-11 之前 —— 这是门禁状态耦合，**不是代码回归**） · `ledger-counts` ✅（**92：90/0/2**）。**台账**：**N33 关闭**（前端已是 uni-app）+ **新登记 N39**（小程序/App 运行期未验证）。 |
| **切片 P16（`test/**` 类型闸，R481 收口）** | ✅ **已完成并门禁通过**（`c52b34c` Task 1 配置层 · `b23b9ca`/`a311a2c`/`9e93413`/`d161b86`/`f9ead13` Task 2 修错 · `29e768c` 补 `@types/express`；计划 `2026-09-17-slice-p16-test-type-gate.md`，裁决 **R541–R550**）。**原状（实测）**：9 个包的 `tsconfig.json` **全部**只 `include: ["src/**/*"]`、全仓**没有**任何 `tsconfig.test.json` ⇒ `test/**` 不受任何类型闸管辖（vitest 走 esbuild 不查类型）⇒ 夹具漂移长期不可见（P12/R481）。**落地**：7 个包各加 `tsconfig.test.json`（`module: ESNext` + `moduleResolution: Bundler` = vitest 真实语义，R541）＋ `lint` 改双 tsc（NodeNext 量 src / Bundler 量 src+test，R542，**不动 ci.sh 六阶段**）；开闸一次暴露 **69 处**并全部修掉（**改夹具 12 / 替身 cast 4 / 其它 42 / 补依赖 11**），`src/**` **0 行改动**（R546）、无 `as any`/`@ts-ignore`、无删用例（577 → 577）。**判别力自证**（R544）：夹具字段类型写错 ⇒ `view.builder.test.ts(34,5) error TS2322`；src 种错 ⇒ `src/main.ts(42,7) error TS2322`；**修完之后再复证一次**。**门禁**：`turbo run lint --force --continue` **12/12** · `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` **六阶段全绿**（阶段 6 一条未放宽）· `ledger-counts` ✅（**94：91/0/3**）。**台账**：**新登记 N40 并同片关闭**（R481 收口）＋ **新登记 N41**（`design:paramtypes` 在测试环境恒 `undefined` ⇒ DI 装配回归结构上抓不到，仍开放）。⚠️ **未跑**：conformance / docker 重建 / 真浏览器探针 —— 本片零运行时改动（`src/**` 0 行）。 |
| **切片 P17（小程序端 REST 与端点，N42）** | ✅ **已完成并门禁通过**（`fc5500d` 适配器 · `a6ed72` 端点校验 · `df60433` 构建入口+用例 · `9fa6fc2` 修复轮 1；计划 `2026-09-17-slice-p17-miniprogram-rest-and-endpoint.md`，裁决 **R549–R560**）。**原状（产物实证）**：`dist/build/mp-weixin/net/rest.js` 用**裸 `fetch`**（计数 2），而整包 **fetch polyfill = 0** ⇒ 小程序运行时（只有 `wx.request`/`uni.request`）**注册/登录第一步就挂** —— P10 Task 3 只适配了 socket 传输，**REST 被漏掉**。**落地**：`src/net/rest.ts` 经新的 `src/net/http.ts`（**一个适配器、按平台两条传输**：mp ⇒ `uni.request`，其余 ⇒ `fetch` 且 H5 行为一字不改）；mp 端点**配错就响亮报错**（`VITE_API_BASE` 相对 / `VITE_WS_ENDPOINT` 空或相对 ⇒ 抛错点名变量与命令）；跨平台入口 `node scripts/build-mp-weixin.mjs <host:port> [--dev]`（一个参数同时配 REST 与 WS）。**门禁**：client **273 passed + 2 skipped**（251+2 ⇒ +22）· 三端 build **DONE** · **mp `net/rest.js` 裸 fetch 2 → 0** · 探针 dev `gate` **16/16** + **发行产物级 `gate` 16/16** · `turbo run test lint --force` **29/29、0 cached** · `ci` 六阶段全绿 · `ledger-counts` ✅ **95：92/0/3**。**台账**：**新登记 N42 并同片关闭**。⚠️ **运行期仍归 N39**（本片只到「结构上能跑 + 配错响亮报错」）。 |
| **切片 P18（测试环境发出 DI 元数据，N41 收口）** | ✅ **已完成并门禁通过**（`d755382` 插件+接线 · `6739009` 拆垫片+机械闸 · `afaa33c` 修复轮 1；计划 `2026-09-17-slice-p18-test-di-metadata.md`，裁决 **R561–R575**）。**原状**：`Reflect.getMetadata('design:paramtypes', X)` 在测试环境**恒 `undefined`**（Vitest/esbuild 不发出 `emitDecoratorMetadata`，esbuild 的 `.d.ts` 里无此选项）⇒ 5 个测试文件用 **7 处 `Reflect.defineMetadata`** 手工补回，**垫片把「期望的依赖清单」写死** ⇒ 产品侧漏 `@Inject`/改参数顺序，测试照样绿。**落地**：`scripts/vitest-plugins/emit-decorator-metadata.ts`（**全仓唯一一份**，`typescript` 的 `transpileModule`，**零新依赖**）+ 5 包 `vitest.config.ts` 挂它并 `setupFiles: ['reflect-metadata']`（顺序要求）+ **7 处垫片全删**。**拆垫片确实抓到东西**：`gateway.controller.test.ts` 报 `Nest can't resolve … ProxyGateway at index [0]` ⇒ 定性「测试期望写错」（测试把替身挂在**自造的 `ProxyGatewayToken`** 上，而产品构造签名是 `ProxyGateway`）⇒ 挂到真实 token，**17 条判据一字未改**。**修复轮 1**：11 处过期注释改写 + `room-service` 那处「读不到 token」的断言**升级为更强形态**（实测 `design:paramtypes` 长度 6、下标 4/5 是真实类引用 ⇒ 原注释已不成立；新增 3 条断言、不删不弱化）。**门禁**：用例数 **577 → 582**（只增不减，耗时 +0.2~0.6s/包已量化）· `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` **六阶段全绿** · `src/**` **0 行** · 无新依赖。**台账**：**N41 → 已关闭** ⇒ **95：93/0/2**。 |
| **切片 P19（小程序端 `require("url")` 阻断级缺陷，N43）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-p19-miniprogram-url-crash.md`，裁决 **R569–R573**）。**来源：用户 N39 回填的第一轮实测**（开发者工具 3.17.2）：编译通过但运行期 `Error: module 'url.js' is not defined, require args is 'url'` ＋ `Page "pages/login/login" has not been registered yet.`。**根因**：产物里 `config.js`/`net/transport.js` 各含一处 `require("url")` —— **打包器为 `import.meta` 生成的 helper**，由源码里的 **`typeof import.meta !== 'undefined'` 守卫**触发；小程序 service 没有 `document` ⇒ 必走该分支 ⇒ 抛错 ⇒ `app.js` 模块求值中断（页面注册从未执行，故两个症状同源）。⚠️ **P10 的三端结构判据抓不到它**。**处置**：守卫改**直接属性访问**（`import.meta.env.*`，构建期替换成字面量）+ **源码级闸** `apps/client/test/import-meta-guard.gate.test.ts` + **产物级断言**（`scripts/build-mp-weixin.mjs` 构建成功后自动扫 `require("url")`/`pathToFileURL`，命中即非零退出）。**门禁**：client **276 passed + 2 skipped**（+3）· 三端 build DONE · mp 产物 `require("url")` = **0** · dev 探针 16/16 · 发行产物级 16/16 · turbo **29/29、0 cached** · ci 六阶段全绿 · `ledger-counts` ✅ **96：94/0/2**。⚠️ **小程序端运行期仍待用户复跑确认**（重建 + 开发者工具重载）——归 N39。 |
| **切片 P20（小程序传输的 engine.io 契约面，N44）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-p20-miniprogram-engine-transport-contract.md`，裁决 **R574–R585**）。**来源：用户 N39 回填第二轮实测**（P19 的 `require("url")` 已消失）：`TypeError: Cannot set properties of undefined (setting 'sid')` ← `engine.io-client 的 Socket.onHandshake`。**含义**：连接**已建到服务端**、服务端也回了 handshake ⇒ 是**对象契约**缺了一块。**根因**：基类 `Transport` 公开 `opts/query/socket/supportsBinary`，而 `Socket.onHandshake` 写 `this.transport.query.sid`（`socket.js:276`）；我们的独立类**漏了 `query`**（与基类空实现的 `pause`）。**处置**：显式公开那四个字段 + `pause()`；`uri()` 改读 `this.query`（与 engine 共享引用）。⚠️ **未**改成 `extends Transport`（会把 `engine.io-client` 引进 `src/**` 裸依赖 ⇒ 动 §12.4 白名单，R435 不许）。**判据**：新增真消费者契约测试（**真 engine.io-client `Socket`** + 假 `wx` 跑真实握手；**负对照**：把 `query` 打回 `undefined` ⇒ 三条全红，含用户那条崩溃原文）。`engine.io-client` 仅 devDependency。**门禁**：client **279 passed + 2 skipped**（+3）· 三端 build DONE · dev 探针 16/16 · turbo **29/29、0 cached** · ci 六阶段全绿 · `ledger-counts` ✅ **97：95/0/2**。⚠️ **小程序端运行期仍待用户复跑** —— 归 N39。 |
| **切片 P21（小程序传输 `drain` 时序 + pong 归属，N45）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-p21-miniprogram-drain-and-pong.md`，裁决 **R577–R590**）。**来源：用户 N39 回填第三轮实测**（P19/P20 的报错均已消失）：`RangeError: Maximum call stack size exceeded`，栈 `Socket._onDrain ← 我们的 emit ← write ← send ← Socket.flush ← _onDrain …`。**根因**：engine.io 的 `Socket.flush()` **先 `transport.send()`、后 `_prevBufferLen = n`** ⇒ 传输层**同步** `emit("drain")` 会让 `_onDrain()` 用**过期的 0** 清缓冲（清不掉）⇒ flush ⇒ send ⇒ 递归。**同片第二处（互相掩护的双 bug）**：我们把 pong 当传输层职责（收到 `2` 回 `3`），而 v4 的 pong 归 **engine 的 `Socket`** ⇒ 每 ping 两帧 pong；旧实现又 `continue` 掉 engine 的 pong ⇒ **正主的 pong 没上线**（服务端超时踢线）。**处置**：drain 延到下一 tick（写期间 `writable=false`）· 传输层只透传、pong 归 engine 并删掉过滤 · **反转 3 条编码了错误行为的旧用例** · 新增 2 条真消费者判据（发送不递归 / 恰好一帧 pong），**两条负对照均取证**（同步 drain ⇒ 用户那条 `RangeError`；代回 pong ⇒ `[ '3', '3' ]`）。**门禁**：client **281 passed + 2 skipped**（+2）· 三端 build DONE · dev 探针 16/16 · 发行产物级 16/16 · turbo **29/29、0 cached** · ci 六阶段全绿 · `ledger-counts` ✅ **98：96/0/2**。⚠️ 小程序端运行期仍待用户复跑 —— 归 N39。 |
| **切片 P22（N39 小程序端收口 · 用户实测）** | ✅ **小程序端已验证**（2026-09-17）。用户在 **Windows + 微信开发者工具 3.17.2** 上跑通 **注册 → 大厅 → 随机匹配 → 牌桌 17 张牌 → 完成对局**（连续三局，无阻塞）。**协同旁证**（协调者取自本机日志，非口述）：`Client connected: … (user: 9912c3d1-…)`（长连接）＋ `Released 2/2 bot(s) for QZTYNX / 8VRZJU / RT6XSR`（机器人释放只在对局收束时发生，⇒ 至少三局真打完）。⇒ **硬约束 (e) 有答案**：`socket.io` 经 `mp-transport` 在小程序端**确实连得上**；REST（P17 `uni.request`）与传输（P20/P21）在真机端到端走通。**过程中修掉四处阻断级缺陷**：P17（REST 裸 `fetch`）· P19（`require("url")` 求值期崩）· P20（传输缺 `query`）· P21（同步 `drain` 栈溢出 + pong 归属）。⚠️ **App 端仍未验证**（HBuilderX 调试/云打包；真实 APK/IPA 需 DCloud 凭据、iOS 需 macOS）⇒ 台账 **N39 转「部分关闭」**（小程序半边已关闭），App 半边清单见 `2026-09-17-n39-miniprogram-app-backfill.md` 的 B1–B4。台账：**98：96/1/1**。 |
| **切片 P23（删除 N38 前端死状态，R591 = 删除）** | ✅ **已完成并门禁通过**（`d5a3700`；计划 `2026-09-17-slice-p23-n38-dead-state.md`，裁决 **R591/R592**）。**删掉四个符号**：`RoomPlayerView` / `roomPlayers`（只写不读） / `seatedOthers`（零消费者） / `reset()` 里的清空；`applyRoomState()` **保留**（删掉那行后仍有两条实职责：R61 的 status 条件写入 ＋ 用 `payload.players` 校正 `mySeat`）；载荷类型**去重**到 protocol 的 `RoomPlayer`（契约唯一真源）。**终态自证**：`grep -rn "roomPlayers\|seatedOthers\|RoomPlayerView" apps/client/src apps/client/test` = **0 命中**。**测试**：删掉的 5 条全是寄生在有真实判据的用例里的纯死状态 `expect` 行，**一个用例都没删**（`it()` 数量前后全等）。**裁决 R592**：**不加**「防复活」名字闸（名字闸会禁止将来合法使用，且无不变量支撑）。**门禁**：client **281 passed + 2 skipped** · 三端 build DONE · dev 探针 16/16 · 发行产物级 16/16 · turbo **29/29、0 cached** · ci 六阶段全绿。台账 **N38 → 已关闭** ⇒ **98：97/1/0**（仍开放 **0**）。 |
| **切片 P24（台账 §3「文档待更新」收口 + `design.md` 附录 A.2 本体的活状态断言订正）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-p24-ledger-docs-closeout.md`，裁决 **R601–R616**）。**零代码**（Global Constraint 1）⇒ **轻量门禁**（R601，逐字同 R491/R395）：改动**只落 `docs/**`** · `turbo run test lint --force` **29/29、0 cached**（client **281 passed + 2 skipped**）· `ledger-counts` ✅ **98：97/1/0**（本片**零台账条目变动**，未新登记 N）。<br>**作业面**：§3 里**所有没有 ✅ 的行** —— 机械底数 §3 共 **27** 条以竖线开头的行（= **25** 数据行 + 表头 + 分隔行），**不含 ✅ 的数据行 8 条**（`534`/`536`/`537`/`538`/`546`/`549`/`551`/`554`）。**处置分布**：**补 ✅ 5**（`538` 被下一行取代 · `546` **全表唯一「已修但没打勾」** · `549` 数字订正为 `98/97/1/0` · `551` N16 已关 + P13 已复审 · `554` P6 已清）· **补 ✅ 并注明被取代 2**（`534` · `537`）· **仍成立并已实际处置 1**（`536`，5 个子项**结论各异**：①②⑤ 成立 / ③ 失效 / ④ 不成立）。⇒ **收口后 §3 数据行「无 ✅」= 0**（`grep -vc '✅'` 剩 **2**，恰为表头与分隔行）。<br>**⚠️ 本片最重要的发现 = R614：A.2 的「表格快照基准」不是「审计基准」**。原头部逐字「本表是**审计基准 `fafb36a`（2026-09-14）的历史快照** ——「偏差」列描述的是**当时**的代码」把两件事并成一件。实测：A.2 的**主体 37 行写于 `3da457f`**（v4.0 文档合并，2026-09-13 **10:07**），**审计基准才是 `fafb36a`**（同日 **19:26**。判定**执行**于 09-14），**两者相隔 99 个 commit**；且行集合本身长过（**37 → 50 → 49 → 52 → 53**），后追加的 16 行（`S8`/`C15–C28`/`E9`/`E10`）还沿用**更早**审计稿的行号（`C13` 的 `:75`、`C25` 的 `:66` 对应 `895f5d8`）。⇒ **「位置」列连「一个统一的历史快照」都不是**，头部已换成**三-commit 对照表** + 「定位当前实现请 `grep` 符号名」的读法规则。<br>**四类编辑（分开计数，R606 成对）**：① A.2 头部 **4 处活指针**订正 —— 撤掉复述台账数字的「80/79/0/1 + N13」句（**R604**：那句写下时（P8）**是准确的**，只是每关一条就过期一次）· `#` 列锚点 `S1`…`E9` → `S1`…**`E10`**（off-by-one）· 撤掉「本表是审计当时的 **39 行**、缺 `C15–C28`/`E10`/`C16`/`C17`」**整句**（实测 **53** 数据行、那 14 行自基准起就在表里）· 新增三-commit 表（**R614**）；② A.2 **`C28` 行**位置列订正（补 `room-service/` 模块前缀 + 现落点 `:88-90`；**R610**）；③ **R612**：`design.md` §14.1 的「`doudizhu.md` §11 的 18 条 `[偏差]` + 1 + 2」是 **P13 漏掉的跨文档引用**（实测三者现全为 **0**、`[已实现]`=15）⇒ 补 ✅ 完成注记；④ **R613**：台账 §1.2 `E10` / §1.4 `A7④` 的「载体 = 注入的 `HttpService`」已被 **N20/P4** 再换一次（现为 **TCP RPC `ClientProxy.send()`**；`HttpService` 在 room-service 只剩 **3 处注释**）⇒ 就地补「载体又换了一次、**判据一字未变**」。另有 **R615**：台账 §1.2 `E1` 的「实测 **69/69（5 files）**」实测已是 **151 passed / 15 files** ⇒ 订正 + 写明「**实测计数会随测试增长被动过期**」。<br>**A.2 逐行散文一律保留为快照**（**R402 未变**，R603 的分界）：53 行在当前代码上**全部已修**（§1.1–§1.4 复核 = **53 已关闭 / 0 其他**）⇒ 逐行追改只会制造**第三份会过期的叙述**。 |
| **切片 P25（R572：§12 源码闸「对注释盲」收口）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-p25-r572-comment-blind-gate-fix.md`，裁决 **R617–R634**（含执行期 R625–R634）；commits `05be575`…`1764771` + 协调者 `1450a64`/`f8e698b`/`2d34f07`/`615a4c1`/`80bc347`/`811a30a`/`e51e233` ＋ **固定轮**（**C1 引号盲守卫** + 两条不变量补合成样本 + 文档读数订正 ⚠️ 见下方 R618 的范围说明））。**零生产代码**（只改 `apps/client/test/**` + 文档）⇒ **中量门禁**（R623）。**作业面比登记大**：`source-boundary.test.ts` 的 **8 条断言里有 7 条**注释盲（登记只点名了 import 那条），**同源遗漏面**还有 **4 份逐字副本**（含**换了名字**的 `stripSfcComments` —— 我按 `grep "function stripComments"` 数，整条漏掉）。<br>**落地**：① 剥注释收敛成**客户端唯一实现**（落进既有的 `apps/client/test/helpers/source-scan.ts`），7 条违规断言改读剥注释视图、**存在性**断言仍读原始文本（R622）；② 新增 **15** 条对照（23 − 8 条原有；7 正 + 7 负 + 1 条**生产视图守卫**）；③ 4 份副本换成 import（`ui-tokens` 用 `stripComments as stripSfcComments` 别名保调用点不动），`(scss: string)` 两规则变体**故意不并入**（R619：并入会加 `<!-- -->` ⇒ 删得更多 ⇒ 更松）；④ 跨包 **5 处**只登记不修（**N46**）。<br>**核心安全判据（R618）**：两条**可执行不变量** —— 逐文件 `len(new) >= len(old)` + 对每条闸的违规谓词 `offenders_old ⊆ offenders_new`（固定轮起跑**语料 + 合成样本**、前件覆盖 11 个谓词）⇒ **机械证明「相对被替换掉的旧副本只更严、不可能更松」**（R435），而不是「我检查过了」。⚠️ 它**不**证明「相对**原始文本**没变松」：剥注释器**对引号盲**是切视图时引进的一处**已知变松**（固定轮已上闸「C1 守卫」，并把该契约变更挂 **N46** 待裁决）。**判别力自证**：M1（`() => ''`）⇒ 7 正对照全红；M2（恒等）⇒ ③⑥ 与 7 负对照 + 守卫全红；M3a（`codeSources = sources`）/M3a-3（删声明）⇒ 守卫红；M3b（两处派生点）⇒ 7 负对照红。<br>**台账**：**N46 新登记**（跨包 5 处 / 三套写法两套语义）⇒ §0 **99：97/1/1**；§3 新增一行（原先**没有** R572 的登记 —— R499 先例）。 |
| **切片 UI 重设计 ①（前两屏：➊ 登录/注册 + ➋ 大厅含玩法选择）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-ui-01-login-lobby.md`；spec `2026-09-17-game-ui-redesign-design.md`）。**用户裁决**：spec §7 三条「都按推荐」（**简约纸牌风** = CSS + 令牌 + `view`/`text`，照抄信息结构不照抄美术；**只做斗地主入口** + 玩法选择区**列表结构**留位；「提示」**本批不做**，单独立片）。**零新增令牌 · 零新依赖 · 零新 `wd-*` · `packages/**` 与 `scripts/**` 一个字节未动**。<br>**交付**：`src/net/copy.ts`（错误码 → 人话，**纯查表**，未知码兜底带码）· `login.vue` 重排（分段控件 / 唯一主按钮 / 注册态确认密码 / 密码可见性 / 加载态 / 字段级校验 = 只做「非空 + 两次一致」，**格式权威仍在服务端**）· `lobby.vue` 拆出**玩法入口区**（`GAME_MODES` 单元素 `v-for` 列表容器 + `.lobby__mode-enter`「进入」；**不含第二个玩法的任何实现**、**不造 `RoomInfo` 里没有的字段**）+ **开局区**（匹配 / 建房 / 房号入房 / 房间列表四路**原位保锚**，默认可见可用）。<br>**门禁（协调者本机实跑，HEAD `5354902`）**：`pnpm run ci` **六阶段全绿**（阶段 6 = 23/8/5/6/3/21）· 三端 build `--force` **DONE**（`dist/build/{app,h5,mp-weixin}`）· `turbo run test lint --force` **29/29、0 cached**（client **337 passed + 2 skipped**）· 探针 **gate 16/16** 与 **full 20/20** · `ledger-counts` ✅ **99：97/1/1**（本片**零台账条目变动**）。<br>**判据不减自证**：`git diff --stat 6b4dde3 HEAD` 只出现 `apps/client/**` + `docs/**`；8 个既有契约测试的字面 `it(` **55 → 59**（唯一增量 = `auth-flow` 的 F1 4 条）；新增 `auth-error-copy`(13) · `login-screen`(10) · `lobby-modes`(6)。<br>**执行期裁决 R664–R668**（详见计划）：R664 用例数笔误订正（13 / 327）· R665 接受新测试文件的 2 行宿主装配 · R666 分段选中态令牌口径订正（原写 `$ftl-color-on-primary` = 白字白底）· **R667 新判据的违规类源码断言一律读剥注释视图**（`stripComments`；原计划让实现者被闸逼着删模板注释）· R668 计划片段里 `GAME_MODES` 块正则订正。<br>**commits**：`7eba36b`（➊）· `b506147`（F1 空 message 回落）· `6fe52de`（➋）· `5354902`（➋ 评审 F1）· docs `fd77dc5` 等。 |
| **切片 UI 重设计 ②（牌桌：➌ 座位几何 · ➍ 卡牌与手牌 · ➎ 出牌区与反馈 · ➏ 叫抢与底牌 · ➐ HUD · ➑ 结算演出）** | ✅ **已完成并门禁通过**（计划 `2026-09-17-slice-ui-02-table.md`）。**零新依赖 · 零新 `wd-*` · `packages/**` 与 `scripts/**` 一个字节未动**（探针 9 个锚点全保留、文案逐字）。<br>**交付**：`Seat.vue`（头像位/昵称/牌背扇/地主标/轮次指示/倒计时条，只消费 props ⇒ 零自造时钟）· `Card.vue`（角标+中央点数，唯一来源 `protocol.toDisplay`；`faceDown` 牌背；`.card--wide` 处理双字符面值）· `Hand.vue`（`sort` 只改**展示顺序**、`toggle` 恒 emit **原始下标**）· `PlayArea.vue`（**最近一手 + 归属指向**，R656）· `BidPanel.vue` + `BottomCards.vue`（底牌未翻开时 **零 `data-value`**）· `TableHud.vue`（倍数/炸弹**个数**/房间码，**原样**、零换算）· `Settlement.vue` 重写（9 个稳定 class 与逐字文案**零改动**，新增胜负标题/三家分数行/载荷明细/再来一局）· `src/net/action-copy.ts`（错误码→人话**纯查表**）· `stores/game.ts` 的 `rematchPending`/`requestRematch`/`consumeRematch`。<br>**门禁（协调者本机实跑，HEAD `5fed3ee`）**：`pnpm run ci` **六阶段全绿**（阶段 6 = 23/8/5/6/3/21）· 三端**逐端**构建（删 `dist/build/{mp-weixin,app}` 后重生成 ⇒ 新鲜）· `turbo run test lint --force` **29/29、0 cached**（client **401 passed + 2 skipped**）· 探针 **gate 16/16** 与 **full 20/20** · `ledger-counts` ✅ **99：97/1/1**（零台账变动）。<br>**判据不减自证**：8 个既有契约测试字面 `it(` **55 → 65**（本计划贡献 `table-bid-ui` 4→7 · `table-settlement-ui` 4→5 · `lobby-ux` 16→18，其余 5 文件零改动）；新增 6 个测试文件（5/8/10/9/7/5 条）。<br>**执行期裁决 R671–R684**（详见计划「开工前裁决」表）：R676 **子组件必须自持 `.btn` 样式**（父 scoped 规则只到子组件**根节点** ⇒ 抽组件会静默丢样式，而所有闸都看不见）+ 机械闸 · R679/R681 **单根闸**（模板注释放根前 = 多根 ⇒ `classes()` 返回 `[]`；一并抓出 `table.vue` 的既有缺陷）· R680 R675 扫描面纳入 `table.vue` · R684 「再来一局」**接收半边**补页面级判据（原为删掉 `lobby.vue:263` 仍全绿）· R672 有界清理轮 · R669 三端必须逐端构建。<br>**commits**：`76eed0d`（➌）· `813c958`/`ea561b3`（➍ + R672）· `7d43db4`（➎）· `7d93bd8`/`ed5e31e`（➏ + R676）· `abb5c7b`/`aafbce0`（➐ + R679/R680）· `7c7fa4c`/`5fed3ee`（➑ + R684）。<br>**遗留（登记，未修）**：`lobby.vue`/`login.vue` 的 fragment root（R681 延后）· `lobby-ux.test.ts` 第二条幂等断言在当前夹具下不可观测（首次 `send` 占满串行槽、`FakeSocket` 从不 ack ⇒ 计数恒 1）· `.settlement__again` 无端到端探针覆盖（裁决接受）· 若干 Minor（气泡寿命、`--seat-N` 无样式、`LOCAL_SCORING_TRACES` 两处重复、报告 §5-⑦ 旧读数）。 |
| **新片已交接：素材接入 + 花色协议（2026-09-18）** | 📋 **已交接、待新会话用 `writing-plans` 细化后执行**。两份交接文档：<br>· **`docs/superpowers/plans/2026-09-18-slice-ui-assets-and-suit-protocol.md`** —— 裁决 **R688–R694** + 素材契约 + **花色协议契约（含待定分叉 (甲)/(乙)）** + **6 个 Task 骨架** + 必须带过去的 10 条纪律与陷阱 + 新会话固定动作。<br>· **`docs/superpowers/specs/2026-09-18-reference-ui-teardown.md`** —— `reference/` 两个开源斗地主的**耐久拆解**（`dsh-doudizhu` 零位图的牌面/几何/动效/行动叙事全表 + `CardGame` 的素材清单/许可结论/可借 5 条/它的 6 个坑 + 我方对照实测 + 体积与端策略）。<br>**本片新裁决**：**R688** 全套素材已取得授权（仍须 `static/ASSETS.md` 溯源）· **R689 只做 H5 与 App**（H5 = 迭代与门禁面，**App = 主要目标**）· **R690 小程序保留代码、撤出门禁**（后续开发/测试**不涉及**小程序；不删 `mp-transport.ts`/`net/http.ts` 平台分支/`build-mp-weixin.mjs`/mp 契约测试，但不再把 `build:mp-weixin` 放进每 Task 门禁，也不做 mp 素材/音频/字体适配）· **R691 `PlayerView.hand` 整体改成带花色的结构**（契约变更，跨 `packages/**` 与 client）· **R692** 音效只用「我方数据就能触发」那批（牌型播报不做）· **R693** 用 2x 图、允许退役纯 CSS 画牌（保留最简兜底）· **R694** `reference/` 加入 `.gitignore`（实测它现在是 `?? reference/`，22MB+ 未忽略）。 |
| **下一步（**按序**，新会话从这里接手）** | ★ **新片已交接**（见上一行）⇒ 用 `writing-plans` 写计划 + `subagent-driven-development` 派工；★ **花色片已全部执行完毕**：①协议侧（R695–R697，8 Task，merge `d70977a`）· ②素材/观感侧（R700 的第②份）。两者是**按方法执行**的（R706：改动面由 `tsc` 反推），**真实记录在改动面清单与 `git log` 里，不在计划正文**。⚠️ **小程序口径变了**：**只做 H5 + App**，小程序**保留代码、撤出门禁**（`test/uni-api-access.test.ts` 等三端闸保留，但 mp 构建/适配不再是验收面）。上一片 = 对局 UI 重设计：① ~~前两屏（➊➋）~~ ✅ · ② ~~牌桌（➌–➑）~~ ✅ 两者都已交付并门禁通过（见上两行）。⚠️ 计划② 的**开工前实测裁决 R654–R663 已写死在计划里**（`PlayerView` 无 `baseScore` ⇒ HUD 不显示底分/我的分 · DouZero 无花色 ⇒ 不画花色、理牌只按点数 · 契约只有 `lastPlayedHand`/`lastPlayerIdx` ⇒ 出牌区只渲染最近一手 · 不做「叫/抢」阶段推断 · 结算明细只用载荷字段 · 扫描面 1→8 且违规类断言读剥注释视图 · 自己座位不画牌背扇 · 缺字段容错 · 排序保原始下标）；spec 另有 **§12 执行期订正**（五处「设计要求 vs 契约实测」）。**下一段候选（按性价比）**：① **本片最终全分支评审的 triage 项**（见上一行「遗留」：`lobby`/`login` 多根、幂等断言空洞、`.settlement__again` 无 e2e）。② **N39 的 App 半边**（部分关闭；**需用户机器**：HBuilderX + 云打包；清单 `2026-09-17-n39-miniprogram-app-backfill.md` 的 B1–B4；用户不在场时只能准备清单/脚本，不得写成「已支持」）。③ **§4 的「生产网络隔离」**（按 R509 已改写为**部署前提**，本机无法验）。④ **N46**（跨包 5 处注释剥离副本，需一次裁决）。⑤ roadmap §2.2 的多玩法路径 A/B（规格要求**第二个玩法开工前**才决定，**现在不要做**）。② 历史序列：① ~~P11~~…⑤ ~~P15~~ ✅ · ⑥ ~~**P10**~~ ✅ · ⑦ ~~**P16**~~ ✅ · ⑧ ~~**P17**~~ ✅ · ⑨ ~~**P18**~~ ✅ · ⑩ ~~**P19**~~ ✅ · ⑪ ~~**P20**~~ ✅ · ⑫ ~~**P21**~~ ✅ · ⑬ ~~**P22**~~ ✅（小程序端验证）· ⑭ ~~**P23**~~ ✅（删除 N38）· ⑮ ~~**P24**~~ ✅（§3「文档待更新」收口 + A.2 本体活指针订正）· ⑯ ~~**P25**~~ ✅（**R572：§12 源码闸的注释盲收口 + 跨包副本登记为 N46**）。⇒ **§0/§1.x 的偏差台账已没有「仍开放」的项**（**99：97 已关闭 / 1 部分关闭 / 1 仍开放** —— 新增的 1 条是 **N46**，它是**测试基建**的登记项，不是产品缺陷）；**§3「文档待更新」的数据行已全部有终态**（「无 ✅」= **0**）。**剩下的三件事（按性价比）**：① **N39 的 App 半边**（部分关闭的那 1 条，**需用户机器**）：HBuilderX 运行调试 + 云打包；真实 APK/IPA 需 DCloud 凭据、iOS 需 macOS；清单 `2026-09-17-n39-miniprogram-app-backfill.md` 的 B1–B4。**用户不在场时只能准备清单/脚本，不得写成「已支持」**。② **§4 的「生产网络隔离」**（唯一仍未验证项，已按 R509 改写为**部署前提**，**本机无法验 ⇒ 不要试图在本机「验」它**）。③ **跨包 5 处注释剥离副本**（**N46**，P25 只登记不修）：收敛它们要抽一个跨包共享的测试工具（本仓没有 `test-utils` 包）+ 各自重跑该包门禁 ⇒ **需一次裁决**。⚠️ 其中 **2 处没有 `:` 守卫**（`room-service` 逐行变体与 `user-service` 的**箭头函数常量**）—— 取数时**不能按单个函数名 grep**（见 N46 的三层判据 A/B₂/C）。④ roadmap §2.2 的多玩法路径 A/B（规格逐字要求**第二个玩法开工前**才决定，**现在不要做**）。 |
| **剩余** | 对账表 §0 = **99 条：97 已关闭 / 1 部分关闭 / 1 仍开放**。**部分关闭 1 条 = N39**（小程序端 ✅ **用户实测通过**（P22）；**App 端未验证**）。**仍开放 1 条 = N46**（**切片 P25** 新登记的**测试基建**项：跨包 5 份注释剥离副本，P25 只登记不修）。<br>**本会话关闭/收口**：N33（P10）· N40（P16）· N41（P18）· N42（P17）· N43（P19）· N44（P20）· N45（P21）· **N38（P23，删除死状态）**；小程序端验证 **P22**（用户实测 + 本机日志旁证）。<br>**P24 不动台账条目**（**零 N 登记**）：它收的是**文档层**余量 —— §3 的 8 条无 ✅ 数据行全部定终态（补 ✅ 5 / 补 ✅ 并注明被取代 2 / 仍成立并已处置 1）+ `design.md` A.2 头部 4 处活指针订正（含 **R614**：**表格快照基准 `3da457f` ≠ 审计基准 `fafb36a`**，相隔 99 commit）。 |
| **已知但未立条的工程债** | ① ✅ **已收（P7/R360）**：`slice-07.2-rpc` 第 6 组的同源相对量等式；② ✅ **已收（P7/R361）**：`shared/src/protocol/message.ts` 那份遗留「第二契约」**已整条删除** + 新增 21 条防复活闸；③ ✅ **已收（P8 + P13）**：`docs/games/doudizhu.md` 的内联 `[偏差]` —— P8 删了 C16/C17 两条，**P13 把余下 32 处全部复核完毕（`[偏差]` 32 → 0、`[待实现]`/`[部分实现]` 亦清零）**；④ ✅ **已收（P8，P12 复核）**：`design.md` 的内联 `[偏差]` 已由 P8 清到 **`grep -c '[偏差]'` = 3，且 3 处全是非注记提及（0 处真注记）**；P12 复核后该数**仍是 3**。**⇒ 这一行四条全部收起，不再有「已知但未立条」的文档债**（台账 §3 的对应行均已标 ✅）。 |
| **已知但未立条的新工程债（P12 登记）** | ✅ **已收（P16 + P18）**：原 ⚠️「① `game-service` 的 `test/**` 不受任何类型闸管辖」= **R481**，已由 **P16** 收口（7 个包加 `tsconfig.test.json` + `lint` 改双 tsc，一次暴露并修掉 69 处；台账 **N40** 新登记并同片关闭），**P18** 又补上测试环境的 DI 元数据机制（`emitDecoratorMetadata` + 删 7 处垫片；台账 **N41** 已关闭）⇒ **这一行不再有未立条的债**。 |

### 切片 P13 门禁实测（文档复审，**零代码 ⇒ 轻量门禁**，R491）

```bash
cd /home/howe/pokergame
git diff --stat                       # ✅ **只**出现 docs/ 三个文件（本片唯一需要机械证明的事）
                                      #    doudizhu.md 92 行净删 · P13 计划 +107 · ledger +6
pnpm exec turbo run test lint --force # ✅ 29 successful / 0 cached（廉价兜底）
node scripts/ledger-counts.mjs        # ✅ §0 与 §1.x 逐区一致（**90：84/1/5/0**）
grep -c '\[偏差\]'  docs/games/doudizhu.md   # 32 → **0**
grep -c '\[待实现\]' docs/games/doudizhu.md  # 2 → **0**
grep -c '\[部分实现\]' docs/games/doudizhu.md # 2 → **0**
grep -c '\[已实现\]' docs/games/doudizhu.md  # **15**（§11 状态表现全绿）
```

**明确不跑**（R491，逐字同 R395）：`build --force` · `docker compose build/up` · 13 条 conformance · 浏览器探针 ——
它们**不读 `docs/**`**，信息量为零，代价是 ~10 分钟 + 一次脆弱的镜像重建。

**本片处置**：**32 处 `[偏差]` 全部复核**（删除 31 / 改写 1 / 保留 0 / 无法确认 0 = 32）——
9 行内 §1–§7 + 5 行内 §8–§9 + 18 行 §11 表；**非注记提及 0**；**另有 4 处别的形态 + 1 行无标记叙述 + 2 段散文 + 1 段建议 + 2 处坐标**一并处置（R498/R501）。
**新登记 N37**（台账 §0 由 89 → **90 条**，仍开放 4 → **5**）。

### 切片 P13 新增的通用教训（四条）

1. **玩法文档的注记与 `design.md` 那批**不是一回事**，严禁外推**（R494，本片最贵的一条）。
   `design.md` 的 28 处注记在 P8 复核时**绝大多数已过期**（实现早就改好了，只是没人回头改注记）。
   若照该经验外推 `doudizhu.md`，会得出「反正都过期了」的结论 —— 而实测这里是
   **31/32 过期 + 1/32 部分过期**，但**过期原因不同**：它们描述的正是 8/9/10/11 各片**真修过**的缺陷
   （`57ad8ca`/`4b8974b`/`bab2c26`/`2cff749`/`11c42b6`…），而不是「另有隐情」。
   ⇒ **规矩**：一批注记是否过期，只能**逐条看代码**；**同族文档的经验不是证据**。
2. **四类处置的计数必须相加等于核实条数，且「异形遗漏面」要分开计数**（R493/R498）。
   本片 `删除 31 + 改写 1 + 保留 0 + 无法确认 0 = 32`（逐条可点）。
   ⚠️ 同时清掉的 **4 处别的形态标记 + 5 处散文/坐标**若混进这 32，四类计数就**无法自证**。
   ⇒ 这正是 P8 教训 2 的**第三次发作**（按单一形态计数必漏）：本文件除 32 处 `[偏差]` 外，
   还有 `[待实现]`×2 / `[部分实现]`×2 —— **数「还剩多少」之前先问「这个问题有几种写法」**。
3. **同一处偏差被文档描述两遍时，必须成对/成组编辑**（本片实测）。
   `doudizhu.md` 把 13 处偏差同时写在**正文行内注记**与 **§11 状态表**里。只删一处 ⇒ 文档自相矛盾；
   而「相邻注记必须一起看」的形态在**表格行**上尤其容易漏（行与行之间隔着几十行）。
   ⇒ 派工时让 agent **显式输出「重复描述清单」**（本片两份证据表都给了），协调者按它成对处置。
   推论：**一处「清理由」必须配一处「补清理」** —— N37 就是这么翻出来的（`clearTimer` 在 `applyAction`
   开头无条件执行，而重挂散在 4 个**互不重叠**的出口）。
4. **计划里的「有登记可销」必须先 `grep` 确认真有那条登记**（R499；P6 教训 3 同族）。
   P13 计划的 Goal 写「让台账 §3 的**这条登记**销掉」，实测 §3 **从来没有**这条登记 ——
   这 32 处从审计基准 `fafb36a` 起**既没回核、也没立条**。若照计划「销掉」，会产生一次凭空操作
   （既没删对东西，也没记录本片的处置）⇒ 处置改为**新增**一行。

### 切片 P14 门禁实测（§4 逐条了结；**改了 `tools/conformance` ⇒ 标准门禁全套**）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force                    # ✅ 10/10
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                                    # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13：slice-11 50 · rpc 65 · deploy 104 · hardening 103 · boundary 82 ·
#    **security 43**（40 → +3：§4 逐字要求的那条「非本房 token + %3F 走私」组合断言）·
#    07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 279 · 05 29
node scripts/browser-e2e.mjs --scenario full         # ✅ 20/20
docker ps -a --filter name=ftl-p14- | wc -l          # ✅ 0（一次性容器已清理）
pnpm exec turbo run test lint --force                # ✅ 29/29、0 cached
node scripts/ledger-counts.mjs                       # ✅ 逐区一致（90：84/1/5/0）
sed -n '/^## 4\./,/^## 5\./p' docs/superpowers/plans/deviation-ledger.md \
  | grep -c '^| \*\*生产网络隔离\*\*'                 # ✅ 1（原 8）
```

**本片处置**：台账 §4 的 8 条 → **1**（`已验证` 6 · `结案` 1 · `仍无法验证` 1）。
新增 **1** 条 conformance 断言（`slice-07.2-security` 第 6b 步）。

### 切片 P14 新增的通用教训（四条）

1. **「未验证」清单自己会过期，而且过期的是**前提**、不是结论**（P6 教训 3 的同族，本片实测）。
   §4 有一条写「robot-service/DouZero 未起」—— 实测 `ftl-douzero Up 16 hours (healthy)`。
   ⇒ **验一条「未验证项」的第一步是复核它的前提**，而不是直接去补证据。
2. **判据形态写错会让「已验证」变成空测，而且误导方向是**双向**的**（R512）。
   计划给的 `grep -c "DouZero"` 实测 **0**，而机器人**真的**在用 DouZero（日志是小写 `source=douzero`）。
   ⚠️ 一个**恒 0** 的读数会被读成「没调用」⇒ 把一条**已经成立**的项误判为「仍无法验证」。
   ⇒ 与 P5 教训 4（门槛类判据必须自证会失败）同族：**先证明读数能看到「有」，再相信它说的「没有」。**
3. **验证「不可控的下游」要用一次性隔离容器，且**正对照不可省**（R508/R513，本片最贵的一条）。
   两个配方都被实测推翻：① 网络名不是猜的 `pokergame_default`，而是 **`pokergame_ftl-platform`**；
   ② 计划给的 `alpine … sleep` **不监听任何端口** ⇒ 只会 `ECONNREFUSED`，**造不出超时**
   （而 A7 要验的正是**超时**路径）。改用 `node:20-slim` 起一个 **accept 但永不响应** 的 TCP 服务，
   并补**正对照**（同一一次性网关 → 真实下游：`HTTP=404` + **0.039s**）——
   **没有这一对，「503 + 5.03s」就可能只是「一次性网关自己坏了」的产物。**
4. **存在性前提（「探针能提供 X」）也必须实测**（R514）。
   计划说「探针的 `--trace` 时间线可直接提供超时证据」；实测 `autoPlayUntilEnded()`（`scripts/browser-e2e.mjs:472`）
   **每 500ms 轮询、轮到人类就立刻动作** ⇒ 人类回合**永远不会**走到 30s 超时 ⇒
   真局探针**不产生任何超时驱动的状态转移**。
   处置改为**更直接也更强的形态**：在真 Redis + 多进程上**不投任何客户端动作**观察存量会话
   —— 它**排除**了「客户端动作造成 version 递增」这一竞争解释，并**一次**同时给出 C22（重挂+落盘）与
   C28（叫抢期用 `currentBidder`）的判别性证据（`currentPlayer` 恒 0 而 `currentBidder` 0→1→2）。

### 切片 P15 门禁实测（台账 §1.5 的 5 条真缺口；**改了 service 代码 ⇒ 标准门禁全套**）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force                  # ✅ 10/10
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                                  # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13：slice-11 50 · rpc 65 · deploy 104 · hardening 103 · boundary 82 · security 43
#    · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · **06 104**（历史 279 ⇒ 回收任务真的在清终局房间）· 05 29
node scripts/browser-e2e.mjs --scenario full       # ✅ 20/20
pnpm exec turbo run test lint --force              # ✅ 29/29、0 cached（998 passed + 2 skipped）
node scripts/ledger-counts.mjs                     # ✅ §0 与 §1.x 逐区一致（91：89/0/2）
```

**本片处置**：关闭 **N31（剩余两半）/ N34 / N35 / N36 / N37** + 新登记 **N38**。
单测分项：`room-service` 207 → **219** · `game-service` 106 → **107**。
⚠️ **门禁期遇到一次环境故障**（不是代码问题）：`docker compose build` 的镜像内 `pnpm install`
**因 registry 超时挂住**（`ERR_PNPM_META_FETCH_FAIL`，日志 17 分钟无写入）⇒ 只重建失败的那个服务
（`docker compose build room-service`）即通过。**另踩一坑**：`pkill -f "docker compose build"` **匹配到了
我自己的命令行**（把当前 shell 杀了）—— 与本仓记过的 `pkill -f chrome` 同款，**要用 `pkill -x` 或先 `pgrep`**。

### 切片 P15 新增的通用教训（五条）

1. **「列出 X」在对外视图与维护视图里的语义不同 —— 复用同一个方法会让维护任务悄悄漏掉一整类对象**（R530，本片最贵的一条）。
   `findAll()` **刻意排除 `cancelled`**（对外列表不该显示终态房间，那是**正确**行为）⇒ 回收任务拿它做枚举时
   `cancelled` **永远扫不到**；而它**对外不可见** ⇒ 是最**隐形**的堆积源。
   修法：抽出唯一底层 `scanAllRooms()`，`findAll()` 在其上做 API 侧过滤、新增 `listForReap()` 给维护类代码。
   ⚠️ 这条**只有跑起来才会暴露**（我先按计划用了 `findAll()`，`cancelled` 用例当场红）。
2. **替身的「恒返回空」是空测的温床**（R531；P3 那条老教训的又一次发作）。
   假 Redis 的 `scan` 原为**恒返回 `['0', []]` 的桩** ⇒ 任何真的去扫键的产品代码在单测里
   **看不到任何房间**，缺陷会以「夹具没数据」的形态出现。⇒ 写替身时先问「真实 Redis 在这里会怎样」。
3. **「动作被拒」与「服务端异常」是两类事件，日志级别必须分开**（R528）。
   照抄超时路径的 `logger.error` 会把**正常客户端行为**（点错、越权尝试）刷成错误日志、淹没真异常 ⇒ 用 `warn`。
4. **判据要防「恒真」的假绿：先问它在**未修**实现上会不会红**（N37 的用例）。
   `expect(timers.get(room)).not.toBe(fired)` 在未修实现上是**恒真**的（`clearTimer` 会把表项**删掉**
   ⇒ `undefined !== fired` 照样成立）⇒ 必须补 `toBeDefined()`；而「换上一个空句柄」也能满足它
   ⇒ 还要再加一条「再过 30s 这一局**真的**被推进」。**三段缺一不可。**
5. **文档里的「失败降级」必须与实现可区分**（N36）。
   一条用例的**标题**声称「失败 ⇒ 房间 `cancelled` + 通知玩家」，而它**只断言重试次数** ——
   这种「标题声称有、判据没有」的形态会让下一个读代码的人**以为降级存在**。
   ⇒ 裁决为「不实现」时**同时**做三件事：改文档（§4.3 节内注明）、**把现状钉成判据**、
   断言**两半**（「`playing` 照样被写入」**且**「从未 `cancelled`」—— 只写后者是空测）。


### 切片 P10 新增的通用教训（六条，写给每一个后来人）

1. **「每段门禁绿」有**维度**，漏一个维度就等于没验**（R441 补③，本片最便宜也最贵的一条）。
   Task 1 交付的页壳用了 `<component :is="current">`：`build:h5` 绿、探针绿、单测绿，而
   **`build:mp-weixin` 直接红**（`[vite:vue] <component is=""/> is not supported`）——
   因为当段门禁只跑了当时的 `pnpm build`（= H5）。⇒ **迁移类切片的门禁必须逐端**：
   `build:h5` + `build:mp-weixin` + `build:app`；端维度的红**不会**在另一个端上显形。
2. **「dev 绿」与「发行绿」是两件事，而且差异可以完全静默**（Task 3 实测，本片最贵的一条）。
   H5 发行构建默认摇树时，uni 只注入空的 `window.uni = {}`；`uni.xxx(…)` 必须写成**直接成员调用**
   才会被编译器改写成 `@dcloudio/uni-h5` 的 import。写成 `const api = uni; api.getStorageSync(…)`
   ⇒ **dev 全绿、发行版存储不落地、`reLaunch` 不跳页**，而**探针默认跑 dev，结构上抓不到**。
   ⇒ 两条处置缺一不可：① 源码级机械闸（`test/uni-api-access.test.ts`，正/反样本自证判别力）；
   ② **发行产物级**端到端（`build:h5` + `preview` + 探针，R449 补④）。**任何「编译器改写/注入」类的机制都要配这两条。**
3. **判据取在了「状态变更」上、而事实发生在「渲染之后」⇒ 假红，而且看起来像产品缺陷**（R449 补②/③）。
   本片连撞两次：① 冷启动时先填表再等 DOM（`inputs.length < 2` 静默返回、`clickByText` 的 `not-found` 从未被断言）；
   ② 换成真实页面栈后 `auth.page` 先写 store、`reLaunch` 才渲染页面 ⇒ 「数出 17 张牌」数到 0。
   ⇒ **凡是要读 DOM 的判据，动手前先有界地等元素**（`waitForSelector` / `waitForSelectorCount`），
   并把「点击结果/元素个数」写进 RED 的 detail。**注意：这是加前置等待，不是放宽阈值。**
4. **「`App.vue` 是根组件」这个直觉在 uni-app 里是错的**（Task 0 Q3 实测）。
   uni-app 的 `App.vue` 是**应用外壳**，**模板不渲染**（真实 DOM 只有 `pages.json` 声明的页面）；
   靠 `App.vue` 做「按 `auth.page` 切页」的形态**必然整体搬家**。⇒ 迁移前先问一句
   「我依赖的是框架的哪一条语义？它在目标框架里还成立吗？」（本条是所有「框架换掉后静默失效」的总纲）。
5. **拿唯一的已验证路径做实验，是最贵的省事**（R441 补②）。
   本机**只能**验 H5（小程序/App 跑不起来）⇒ 交互控件（`button`/`input`）保持 uni-app core 组件、
   组件库只用 easycom 的展示型组件。这样「唯一可验路径」的每一环都留在原地，
   新增的库只影响观感（且观感有 H5 探针兜底）。**若反过来做，验证能力会先于功能一起丢掉。**
6. **`pkill -f "<含自己命令行的模式>"` 会杀掉自己** —— 本仓记过一次（P15），本片**又踩了一次**
   （`pgrep -f "p10-poc"` 命中了自己的 bash 进程，命令当场 SIGTERM）。
   ⇒ 一律 `pgrep -x` / 用不会匹配自身的模式（如 `p10[-]poc`），或**先 `ps -eo pid,pgid,args` 看清再按进程组杀**。

### 切片 P16 新增的通用教训（五条）

1. **「测试不过类型闸」是结构性缺口，不是「测试写得松」——缺口的大小只能靠**开闸**量出来**。
   实测：**9 个包无一例外**只 `include: ["src/**/*"]`，全仓没有任何 `tsconfig.test.json`；开闸后一次性暴露 **69 处**。
   ⇒ 与 P10 的 Task 0 同族：**先量（一个可逆的探针）再决定做不做、做多大**；
   凭「大概没几处」开工会低估一个数量级。
2. **隐式 any（TS7006）常常是「声明文件缺席（TS7016）」的派生，别在派生处逐个打补丁**。
   game-service 的 11 处里 10 处是 `TS7006`：`@types/express` 一装，**0 行代码改动**全消
   （`app.get(path, handler)` 的签名把 `Request`/`Response` 上下文推断出来了）。
   在回调上逐个写显式标注只是把根因留在原地（而且会让下一处新写法继续踩）。
3. **闸的判别力要在「修完之后」再复证一次**。
   本片两条自证（夹具漂移 / src 种错）都在修错**前**做过；修完 69 处之后**又做了一遍**同样的夹具漂移探针，
   仍然红 —— 因为「修完顺手把尺子改松」（弱化配置、加 `as any`）正是这类工作的典型退化路径。
4. **测试替身与真实接口的差距用「一处带注释的 cast」收口，而不是改产品接口**（R546/R543）。
   本片 4 处 cast 全是第三方接口的替身（`Redis` 440+ 成员 / `Socket` 70+ / `RobotPool` 是类）；
   **我们自己的类型（协议载荷、夹具）一个 `as` 都不许加** —— 那条线就是这道闸能长期活着的前提：
   一旦允许「夹具错了就 cast」，夹具漂移又会回到不可见状态。
5. **「测试通过」可能测的是测试自己写进去的东西**（N41）。
   `Reflect.getMetadata('design:paramtypes', X)` 在 vitest/esbuild 下**恒 `undefined`**（不发出 `emitDecoratorMetadata`），
   而全仓 7 个测试文件用 `Reflect.defineMetadata(...)` 手工补回 ⇒ 依赖元数据的装配测试
   **测的是垫片，不是产品真实发出的 metadata**：产品侧漏了 `@Inject`/改了参数顺序，测试照样绿。
   ⇒ 通用形态：**当测试必须先「摆好一个产品本该自己产生的中间物」时，这条测试对那一环就没有判别力**，
   要么让测试链路具备产品同样的产生机制（此处是 `emitDecoratorMetadata`），要么加一条「清单互证」的机械闸。

### 切片 P17 新增的通用教训（三条）

1. **「换框架」时要盘点的不是「组件」，而是「**运行时假设**」**（本片最值钱的一条）。
   P10 明确处理了 socket 传输（`wx.connectSocket`），却漏了 REST 的 `fetch` —— 因为盘点时按「模块」清点，
   而没按「**我依赖了宿主提供的哪些全局对象**」清点。产物证据：`net/rest.js` 是裸 `fetch(`，而整包 polyfill = 0。
   ⇒ 迁移/换端的检查表应当写成**全局对象清单**（`fetch` / `XMLHttpRequest` / `WebSocket` / `localStorage` /
   `Blob` / `FileReader` / `window.location` …）逐项问「目标端有没有」，而不是按目录问「这一层改了吗」。
2. **「相对路径」与「同源回退」是多端迁移里最隐蔽的一类失效**。
   `apiBase = '/api'` 在浏览器里天经地义（dev 有代理、prod 同源），在小程序里**根本不存在**这个概念；
   `resolveEndpoint()` 的 `http://localhost:3000` 回退在开发者工具里**看着是对的**、真机上必挂。
   ⇒ 这类配置要么**显式要求绝对地址**，要么**响亮报错**；**不要**留一个「在某个端上恰好能用」的默认值
   （它会让你以为配好了）。本片因此采用 R550：小程序端配错就抛错，并点名变量与构建命令。
3. **判据要对准「运行期可达」而不是「文本上存在」**（R558）。
   本片最自然的一句判据是「全产物 `grep fetch(` = 0」，但它**会误判**：`net/http.js` 里保留的 fetch 分支
   是运行期平台分支，在 mp 上不可达。⇒ 写判据时先问「这个读数为 0，是因为真的没有，还是因为我不该那样数？」
   （与 P14 教训 2「恒定读数会被读成没调用」同族，这里是它的镜像：**恒为 0 的读数会被读成已修好**。）

### 切片 P18 新增的通用教训（三条）

1. **测试若必须先「摆好一个产品本该自己产生的中间物」，那条测试对那一环就没有判别力**（N41 的形态）。
   本仓 7 处 `Reflect.defineMetadata('design:paramtypes', …)` 就是这种垫片：它让 Nest 装配跑起来了，
   但**测的是测试刚写进去的那份元数据**。修法有且只有一条正确方向：**让测试链路具备产品同样的产生机制**
   （这里是 `emitDecoratorMetadata`），**不是**继续摆 —— 摆得越像，掩盖得越深。
   ⚠️ 本片一拆垫片就抓到东西：`gateway.controller.test.ts` 把替身挂在**自造的 token** 上，
   而产品构造签名用的是另一个类 ⇒ 「测试绑的依赖」与「产品真实依赖」**不是同一个**，垫片写法把这件事藏了很久。
2. **判据/注释会随机制变更一起过期，而它们通常不会自己报红**（R567）。
   本片换掉元数据机制后，11 处注释仍在说旧结论，其中一处**注释性断言**（“读不到 token、只会是 `Object`”）
   在机制修好后**实测已不成立**。⇒ 换机制时必须**成批回头核实**所有「因为旧机制才这么写/才这么断言」的地方
   （与 P8/P13 的「过期注记」同族，但这次过期的是**判据的理由**，比文档更危险）。
   处置模式值得复用：**注释改成新事实 + 把那条断言升级为更强形态**（而不是把注释改成与弱断言自洽）。
3. **`@Inject(TOKEN)` 不会抹掉类型元数据**（本片实测的机制知识，值得单独记）：
   tsc 对 `@Inject(字符串 token)` 的参数**同时**发出 `__param(i, Inject(TOKEN))` 与
   `__metadata("design:paramtypes", […, 该参数的类型类])`。于是「Nest 最终用 token 解析」
   **不等于**「类型元数据里没有那个类」—— 本仓曾把前者误推成后者，并据此写了注释与一条反向断言。
   ⇒ 凡是要断言「某个运行时机制一定不会发生」的判据，**先实测一次**再写（P14 教训 2 的同族）。

### 切片 P19 新增的通用教训（三条）

1. **「结构判据全绿」与「运行期能跑」之间隔着一条河，而只有真机/真工具能过桥**（本片最值钱的一条）。
   P10 对小程序的判据是：产物存在 + `app.json#pages` 正确 + `usingComponents` 15/15 解析 + 组件四件套齐全 ——
   **全部满足**，而实际打开开发者工具是**求值期就崩**。⇒ 端到端的「未验证」不能靠**加更多结构判据**消掉；
   要么真的在那一端跑起来（用户机器），要么就诚实地留着「未验证」（R440 的口径是对的）。
2. **「编译通过」不等于「模块能求值」**：`require("url")` 这类 Node 内建引用在**编译期**完全合法
   （打包器甚至帮我们生成了它），只在**目标运行时缺那个模块**时才炸。⇒ 多端迁移时，除了盘「用了哪些全局对象」
   （P17 教训 1），还要盘「**产物里被引入的 Node 内建模块**」：`url`/`path`/`fs`/`os` 在端上都不存在。
   本片把它做成了**构建入口自带的产物级断言**（谁构建谁被检查，不依赖人记得跑）。
3. **「解释得越清楚，闸越红」是本仓的常驻形态，第 3 次发作**（R571，前两次见 `ui-tokens` / `uni-api-access`）。
   本仓注释习惯逐字引用真实写法，而 §12 的 import 扫描**不剥注释** ⇒ 注释里写 `require("url")` 会让它
   把一个不存在的依赖算进来。⇒ 写**新**扫描器时一律先剥注释（并配合成样本自证）；
   已有的 §12 扫描器这条待办已登记（P19 回填区），但**不在修 bug 的片子里顺手改**（R435）。

### 切片 P20 新增的通用教训（三条）

1. **「自己写的接口单测全绿」不能证明「真实消费方能正确使用这个对象」**（本片最贵的一条）。
   mp 传输此前有 **31 条**用例（包编解码/收发/close/平台分支）全绿，而真实消费方 engine.io 的 `Socket`
   一上手就在**握手最后一步**崩：它要写 `transport.query.sid`，而我们没公开 `query`。
   ⇒ **为「给别人用的对象」写判据时，必须把那个「别人」拉进来**（这里是 `engine.io-client` 的真实 `Socket`），
   否则你测的是**你想象中的接口**。这与 P18 的「垫片测自己」是同一族，但方向相反：
   P18 是**测试替身**掩盖了差异，P20 是**接口子集**掩盖了缺口。
2. **跨运行时/跨库的适配层要对着**源码清单**验证，而不是对着直觉**。
   权威清单可以机械取得：`grep -oE "this\.transport\.[a-zA-Z_]+" socket.js | sort -u` ⇒
   `{close,name,pause,query,removeAllListeners,send,writable}`；基类字段则看它的 `constructor`。
   ⇒ 写适配层时**先取清单，再逐条对照**，比「跑起来看看」便宜得多（本片两次崩溃都是清单没对齐）。
3. **不要为了「更正确」去动 §12 的白名单**（R574 的取舍）。
   本次最「自然」的修法是 `extends Transport`（契约自动同步），但它要求把 `engine.io-client` 引进 `src/**` 的裸依赖，
   而那条白名单是 §12.4 的机械闸、R435 明确不许放宽。⇒ 选**补四个字段 + 真消费者判据**：
   代价是契约靠测试维持，收益是**没有动一条 FORBIDDEN 闸**，并且拿到了一个比继承更强的判据
   （继承不会告诉你 `Socket` 到底访问了什么；`grep` + 真消费者测试会）。

### 切片 P21 新增的通用教训（三条）

1. **「字段齐了」不等于「时序对了」**：适配层的缺陷分两层 —— **形状**（成员存在）与**时序**（谁先谁后）。
   P20 补的是形状（`query` 存在），P21 补的是时序（`drain` 必须晚于 engine 的记账），**两者都要判据**；
   而**时序类的缺陷只能在「真消费者 + 真一拍」下暴露**（本片靠 `setTimeout(…, 0)` 之后断言 `writeBuffer` 被清空）。
2. **「去重」是掩盖症状的常见手法，往往把正主一起干掉**（本片最隐蔽的一处）。
   旧实现发现「pong 可能发两帧」，于是**加了过滤**——但过滤掉的恰是 **engine 真正要发的那一帧**，
   而自己那帧（错的）照发 ⇒ 服务端收不到 pong，`pingInterval + pingTimeout` 后踢线。
   ⇒ 遇到「重复」先问**哪一个是正主**（读消费方源码），**不要**用去重把两个都留下/一个都发不出。
   本仓同族先例：P10 的「同名不同形类型」，P18 的「垫片把期望写死」。
3. **实测能推翻当初「已知差异、暂不处理」的清单**（P10 实现者当时明确写了「两处已知差异：pong 去重、同步 `drain`」）。
   这两条在 H5 上永远不触发，在单测里也「看着合理」，**只有真机/真工具**会把它变成 `RangeError` 与「连上几分钟后被踢」。
   ⇒ 凡是登记为「已知差异」的地方，都要写明**它在哪个端、以什么症状发作**，并在那一端第一次真跑时**优先复核它**。

### 切片 P24 门禁实测（文档收口，**零代码 ⇒ 轻量门禁**，R601）

```bash
cd /home/howe/pokergame
git status --short                            # ✅ **只有 docs/** 三条（2 改 + 1 新）⇒ R601 成立
pnpm exec turbo run test lint --force         # ✅ 29 successful / 0 cached（client 281 passed + 2 skipped）
node scripts/ledger-counts.mjs                # ✅ §0 与 §1.x 逐区一致（98：97/1/0）
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md | grep -c '^|'
                                              #   28（= 26 数据行 + 表头 + 分隔行）
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md \
  | grep '^|' | grep -vc '✅'                  #   **2**（恰为表头与分隔行）⇒ 数据行里「无 ✅」= 0
sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' docs/design.md \
  | grep -cE '^\| \*{0,2}[SCAE][0-9]+\*{0,2} \|'   # 53（未变）
grep -c '它是审计当时的 39 行' docs/design.md       # 0（该伪断言已删；仅在更正说明里作引文出现一次）
# 本片的定性判据（R614）：
for sha in 3da457f fafb36a; do printf '%s: ' "$sha"; \
  git show $sha:packages/room-service/src/match/match.service.ts | sed -n '53p'; done
#   3da457f:   startMatchingLoop(): void {     ← A.2 的 A4 行号**精确命中**
#   fafb36a:   （常量区，不命中）
```

**明确不跑**（R601，逐字同 R491/R395）：`build --force` · `docker compose build/up` · 13 条 conformance ·
真浏览器探针 —— 它们**不读 `docs/**`**，信息量为零；本片 `src/**`/`tools/**` **0 行改动**。

**处置**：§3 的 8 条无 ✅ 数据行全部定终态（**补 ✅ 5** / **补 ✅ 并注明被取代 2** / **仍成立并已实际处置 1** = 8）；
A.2 头部 **4 处活指针**订正（含 **R614** 的三-commit 对照表）· A.2 `C28` 行**位置列**订正（R610）·
`design.md` §14.1 **跨文档引用**补清理（R612）· 台账 `E10`/`A7④` **载体表述**订正（R613）· 台账 `E1` **实测计数**订正（R615）。
**台账条目数零变动**（**98：97/1/0**，未新登记 N 系列）。

### 切片 P24 新增的通用教训（五条，本会话最贵的一条在第 2 条）

1. **「历史快照」的基准必须**是一个 commit**，不能是一个概念**（R614，本片最值钱的一条）。
   `design.md` 附录 A.2 的头部逐字自称「**审计基准 `fafb36a` 的历史快照** ——「偏差」列描述的是**当时**的代码」。
   实测：**表的散文与行号写于 `3da457f`**（v4.0 文档合并，2026-09-13 **10:07**），**审计基准才是 `fafb36a`**（同日 **19:26**），
   **相隔 99 个 commit**；而且**行集合本身长过三次**（**37 → 50 → 49 → 52 → 53**），后追加的 16 行还沿用**更早**审计稿的行号。
   ⇒ **「位置」列连「一个统一的历史快照」都不是**。判「某条历史声明是否从来不准」之前，**必须先确定它写于哪一版**
   （`git log -S` 找它出现的 commit + 逐版本数行集合），再拿**那一版**去证。
   ⚠️ 这是**第四类**结论（前三是「真缺陷 / 快照随后过期 / 无法确认」）：**判据用错基准**。
2. **拿错基准 ⇒ 一次**反向的**错误清理，比不清理更糟**（R616，本片最险的一处）。
   本片派了两个只读 agent：Part A 找到了真基准 `3da457f`，Part B 按 `fafb36a` 判出「**13 行从来就不准确**」。
   **两者在同几行上给出互相矛盾的一列**。协调者逐条回测 `3da457f` —— 那 13 行里至少 **8** 条
   （`A1`:22 · `A3`:13 · `A4`:53 · `A5`:293 · `A8`:25 · `E3`:10 · `E6` 三字段全缺 · `E8`:51-52）**逐字精确命中**。
   ⇒ 若只派 Part B（它的报告更长、更细、还带实跑测试），本片就会把 8 条**本来准确**的历史声明改成「从来不准」，
   **污染台账的判定依据**。⇒ **两个独立取证 agent 的价值恰恰在于它们会给出互相矛盾的列**；协调者**不许**按「哪份更详细」或「多数」取舍，**只按回测**。
3. **「实测计数」类断言会随**被测量**的增长被动过期**（R615，两个 agent 各自独立翻出）。
   台账 §1.2 `E1` 写「`api-gateway` 实测 **69/69 通过（5 files）**」，本片复跑是 **151 passed / 15 files**；
   同族：§3 的 P12 行自称「`[待实现]` = 0」，而它自己引用的口径 `grep -c` 实为 **3**（全部非注记）。
   ⇒ **状态判据要写「有没有失败」，不要写计数**（`Test Files 15 passed` / `Tests 151 passed` 才是判据）；
   必须写计数时，**在同句里写明它是「当次读数」**，并把它排除在状态口径之外（与 R604 同一条纪律：**不要复述会变动的数字**）。
4. **`git diff --stat` 看不见未跟踪文件** —— 轻量门禁的「改动只在 `docs/`」判据要配上 `git status --short`。
   本片新增了计划文件（`?? docs/superpowers/plans/2026-09-17-slice-p24-…md`），`git diff --stat` **完全不显示它**。
   ⇒ 凡以「`git diff --stat` 只出现 `docs/`」当防伪判据的切片（R395/R491/R601），**必须同时看 `git status --short`**
   （否则「新增了一个 `apps/` 下的文件」这种改动会**静默通过**这条判据）。
5. **「同源遗漏面」永远不会一次清完 —— 清完 A 要回头核所有**引用 A**的地方**（R612，P13 教训 3 的第四次发作）。
   P13 把 `docs/games/doudizhu.md` 的 21 条标记清到 0，却漏了 `design.md` §14.1 那句
   「`doudizhu.md` §11 的 **18 条 `[偏差]` + 1 条 `[部分实现]` + 2 条 `[待实现]`**」。
   ⇒ 清理类切片的收尾动作里应固定加一步：**`grep` 被清对象的**名字**（不是它的标记形态），把跨文档引用一起改**
   （本片 `grep -c '\[偏差\]' docs/design.md` = 3 里就有这一处）。

### 切片 P25 门禁实测（R572 收口；**零生产代码** ⇒ 中量门禁，R623）

```bash
cd /home/howe/pokergame
git status --short                                  # ✅ 只 docs/ 与 apps/client/test/**
pnpm exec turbo run test lint --force               # ✅ 29 successful / 0 cached（client 用例数只增不减）
pnpm run ci                                         # ✅ 六阶段全部通过（第 6 阶段就是本片要护的那六条源码闸）
# 形态口径（名字无关 + 排除 helper，R625 的教训）：
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers | wc -l   # 5 → 1
grep -rnE "const strip[A-Za-z]*Comments?\s*=" apps/client/test packages/*/test | wc -l          # ⇒ 1（user-service 箭头常量）
grep -rnF 'replace(/\/\*[\s\S]*?\*\//g' apps/client/test packages/*/test | wc -l             # 8 = 7 实现 + 1 oracle
grep -c "^  it(" apps/client/test/source-boundary.test.ts                                       # 8 → 23
node scripts/ledger-counts.mjs                                                                  # ✅ 99：97/1/1
```

**明确不跑**（R623）：`build --force`（`test/**` 不进任何产物）· docker · 13 条 conformance · 真浏览器探针 ——
它们**不读 `apps/client/test/**`**，信息量为零。本片 `apps/client/src/**` 与 `packages/**/src/**` **0 行改动**。

**新登记 N46**（跨包 5 处注释剥离副本，**仍开放**）⇒ §0 由 **98：97/1/0 → 99：97/1/1**。

### 切片 P25 新增的通用教训（七条；第 1、4、6 条最贵）

1. **「按名字计数」会**双向**失效 —— 而这次是我自己踩的**（R1/R8，本片最贵的一条）。
   `grep "function stripComments"` 同时犯两个错：**误命中** oracle（省掉 `(` 的形态会子串命中 `stripCommentsNaive`），
   以及**漏掉换名副本**（`ui-tokens.test.ts:33` 的 `stripSfcComments` 与另外三份**逐字相同**）。
   漏报比误报危险得多。⇒ 判据要用**三层**：**A 命名族**（`function strip*Comments?(`）· **B₂ 第二种声明形式**（`const … =`）·
   **C 结构性兜底**（`grep -rnF 'replace(/\/\*[\s\S]*?\*\//g'` —— 与名字、写法都无关，**唯一**能抓到无名内联实现的那条；
   本片因此多发现一处 `packages/user-service/test/migration.test.ts:43-44` 的**箭头函数常量**）。
   ⚠️ 三层仍有残余：不写那个字面正则的手写状态机式剥离器全逃 ⇒ 靠人评审。
   ⚠️ **C 必须 `-F`**：带正则元字符的写法实测返回 **0 命中（假绿）**。
2. **「剥注释」这类改动必须**机械证明只让闸更严**（R618/R435）。
   本片用两条**可执行不变量**：① 逐文件 `len(new) >= len(old)`；② 对每条闸的违规谓词 `offenders_old ⊆ offenders_new`（真实语料 + 合成样本）。
   方向还是**结构性**的：新实现只是把字符类从 `[^:]` 收窄到 `[^:\]` ⇒ 删得**更少** ⇒ 下游只会更严。
   ⇒ **不要**用「我检查过了」代替；把它写成会在 CI 里红的断言。
3. **潜伏缺陷没有现成红灯 —— RED 必须**构造**，而且必须**永久化**（R2）。
   `source-boundary` 的 7 条注释盲断言在**当前语料上全是绿的**（今天没有一条注释命中那 7 条判据），
   7 条**正**对照也直接调 Task 1 的产物 ⇒ 改动前就绿。真正钉住本任务改动的是**负对照**（纯注释样本 ⇒ 7 条判据零违规），
   而 implementer 最初只用了一次性临时探针 —— 它随 `.superpowers/`（gitignored）一起消失。⇒ 探针必须**升级为永久测试**。
4. **「守卫」必须观察被守卫的那份输入本身**（R4/R5）。
   负对照**自己造语料**（`commentOnly`）⇒ 与生产语料（`codeSources`）**不相交** ⇒ 两块是**并联**而非串联：
   把 7 条生产断言改回原始文本、负对照**一条都不会红**。⇒ 补一条守卫直接比较两个视图（`codeSources` 与 `sources` 逐文件不同）。
   推论：**守卫的书面承诺必须与它的射程一致** —— 它抓不到的那一态（逐条改回 `sources` 而留下死常量）要么关掉、
   要么**写进注释**；关掉它要加**自指静态计数**，那会在重命名/重排时**假红**，是本仓更贵的一类病。
5. **自己写的注释会在自己的改动里过期**（R6/R7）。
   Task 3 一收敛，Task 1 写的「**今天** = 5 行 / **今天** = 4 行」立刻变假；台账 §5 的桶清单自初始台账起就没更新过。
   ⇒ **注释里不要写「今天」**：写「Task N 落地时 / 收敛后」，或者只写**判据**（判据不会过期）。
   这与 P24 的 R604（不要复述会变动的数字）是同一条纪律的第二次发作。
6. **自指类文档是假断言的高发区**（R9/R10，本片最磨人的一条）。
   Task 4（登记 N46）的**三轮**修复，**每一轮**都在「怎么数我自己」的文字里引入一条**新的假事实**：
   「两条名字判据都抓不到它」（实际 B₂ 抓得到）·「三套语义」（台账口径是两套）·「241/31」（无路径的计数会把
   `.superpowers/` 里引用这些源码行的过程文档也数进去，于是**每轮膨胀**）。⇒ 派复评时明确要求
   **对改动行里的每一条事实断言、每一条处方命令都只读实跑一遍**；写这类文本时**只写判据与位置**，少写举例数字。
7. **`grep` 没有文件参数会读 stdin** —— 放进 `while read` 循环会**吃掉后续命令**、循环提前结束（implementer 实测）。
   ⇒ 文档/脚本里给的命令**必须带路径**，否则「可原样复制并复现读数」是假的（本片 R10 的 Minor 就是这一条）。

**主检出实测（切片 7 合并后，commit `9dcbaa6`，全部 `--force`、`Cached: 0 cached`）**：
`turbo run test+lint` → **29/29**；`build` → **10/10**；`client` 137(+2 skipped) · `room-service` **126** ·
`api-gateway` 69 · `game-service` 52 · `user-service` 21 · `protocol` 39 · `shared` 91 · `robot-service` 2。
conformance：`slice-07` ✅ 39 项 / 31.5s · `slice-06` ✅ 99 项 · `slice-05` ✅ 29 项 / 55.8s。

**主检出实测（切片 6 合并后，commit `42b64bb`）**：
`turbo run build/test/lint` → **19/19 三项全绿**；`client` 119 · `room-service` 103 · `api-gateway` 69 ·
`game-service` 52 · `user-service` 21 · `protocol` 39 · `shared` 91 · `robot-service` 2。

### 切片 UI 重设计① 新增的通用教训（三条，写计划的与读计划的人都要看）

1. **计划里的「源码级判据」必须逐条声明读哪个视图**（原始文本 vs 剥注释）。本仓 R572/R622 已定死：**违规类**断言读 `helpers/source-scan.ts` 的 `stripComments` 视图，**存在性/计数**断言（「文件被读到了」「清单长度」）才读原始文本。本片实测付了一次代价 —— 计划片段抄了 legacy 的 raw 形态，实现者第一次 GREEN 时模板注释里的「在线人数」四字被闸打红，**唯一能变绿的做法就是删掉解释**（P19 已为同一件事付过代价），后来按 **R667** 改成剥注释视图并把解释加回来。⇒ 写计划时：判据片段里出现 `file.content` 就自问一句「这条是违规类还是存在性」，并顺手写好**真对照**（真违规 + 解释它的注释 ⇒ 仍报错；纯注释样本 ⇒ 不报错）——「样本里写了那个词」式的对照是空转。
2. **计划文本里的正则也是「代码」，要对着真实源码跑一次。** 本片 Task 2 的 `GAME_MODES` 块正则写成 `\];`，而真实代码是 `] as const;`（**匹配不到**，R668）；同一批还有两处令牌口径自相矛盾（选中态写成白字白底、牌背令牌数少算两个）。⇒ 派工前把每个判据片段对着目标文件 `grep` 一次，比评审阶段回退便宜得多。
3. **「判据只增不减」的读数要固定口径，并写进计划。** 本片两次读数混淆：`it.each` 的**展开数**（vitest 报的 Tests）与字面 **`it(` 数**（评审用的形态）差很多（14 vs 13、23 vs 25）；CI 阶段 6 的判据数也是**陈旧快照**（计划写 6/6/5/6/3/21，实测 23/8/5/6/3/21 —— 更早切片加过判据）。⇒ 计划里写死口径（推荐：8 个契约测试的**字面 `it(`/`it.each(` 计数**）并记下**基线数字**，收口时贴「前 → 后」。

### 切片 UI 重设计②（牌桌）新增的通用教训（六条，全是本片实际付过代价的）

1. **`mount()` 会把 SFC 样式完整注入 jsdom 且不做 scope 过滤 ⇒ 行为判据看不见「样式丢失」类回归。**
   ➏ 把两个叫抢按钮抽进 `BidPanel.vue` 后，它们在三端**全部丢掉 `.btn` 样式**（8 条新测试全绿、探针只点击 ⇒ 无闸可见）。根因：`scoped` 样式只作用于「本组件模板 + 子组件**根节点**」，子组件模板内部的元素拿不到父 scope（产物里父规则是 `.btn[data-v-<父>]`，按钮只带子组件的 scope id）。
   ⇒ **跨组件抽样式时，判据只能是「组件自持 `@include ftl-btn`」或「产物 CSS 的 scope 对齐」**，不能只靠 `mount` 断言。本片已上闸（`table-bid-bottom.test.ts` 的 F3：`src/components/**` 里渲染 `class="btn` 的组件必须自持 mixin；渲染 `btn--primary` 的必须自持主色 `background`）。
2. **模板注释放在根元素之前 ⇒ 组件变多根（fragment）**：`wrapper.classes()` 返回 `[]`、父组件传 `class` 会走 attrs 回退警告路径；jsdom/VTU 都能观测（`hasMultipleRoots` ⇒ `element` 退到父容器）。**注释一律放根元素内部**；本片已上单根闸（`mount(组件).classes()` 断言根 class，覆盖牌桌区 8/8）—— 它一上就抓出 `table.vue` 自己的既有缺陷。
3. **派工单里写「不许做 X」挡不住 X**：➐ 的派工单明令「模板注释只能放单根元素内部」，实现者仍放外面且自报合规。⇒ **把纪律变成闸，而不是变成叮嘱**（本片两次验证：R672 的清理轮、R679 的单根闸）。
4. **遗留 raw 判据的「注释陷阱」有两条**：`table-bid-ui.test.ts` 第一条 `localScoringTraces` 读 `table.vue` 的**原始文本** ⇒ 牌桌区源码**与注释**里都不要写 `×` 紧跟数字、`底分`、`baseScore`、`bidMultiplier *`（➍ 清理轮与 ➐ 各被咬一次）；另外**注释里不要逐字写注释定界符**（`<!-- -->`、`/* */`）—— `comment-stripping` 的 C1 守卫（引号盲 vs 引号感知）会红（➐ 被咬一次）。
5. **「没有判据的链路等于没有实现」**：➑ 的「再来一局」实现正确，但**接收半边（大厅消费意向）零判据** —— 删掉 `lobby.vue:263` 整套测试仍全绿、探针也看不到（它从 `.table__bar .btn` 退出）。⇒ 新链路要**两端都判**（发送端写意向 + 接收端兑现），并且**先写先红**（临时删掉那一行必须红）。
6. **证据卫生**：一份「全绿」日志的 **mtime 早于**最后一轮文件改动 ⇒ **它未必覆盖最终树**（R682）。⇒ 门禁跑在最终 HEAD 上、且日志与 commit 的时序要对得上；对不上就重跑（或说明由后续门禁覆盖）。

### 切片 7.1 门禁实测（room 原子入座 + E10，合并 `feat/backend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29（room-service 134 → 156 · client 142+2 skipped
                                           #            shared 100 · protocol 39 · game-service 67
                                           #            api-gateway 81 · user-service 29 · robot 12）
pnpm exec turbo run build --force          # ✅ 10/10

pnpm exec turbo run build --force                  # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build room-service && docker compose up -d room-service
node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.4s（新增）
node tools/conformance/dist/run.js slice-07               # ✅ 39 项（回归：匹配/进房/补机器人）
node tools/conformance/dist/run.js slice-06               # ✅ 169 项（房间数参与计数；只要尾行 ✅ 即通过）
node tools/conformance/dist/run.js slice-08               # ✅ 55 项
node tools/conformance/dist/run.js slice-07.2-security    # ✅ 39 项
node tools/conformance/dist/run.js slice-07.2-boundary    # ✅ 70 项
node tools/conformance/dist/run.js slice-05               # ✅ 29 项，55.7s（无回归）
```

**关闭的偏差**：**C11 / E10 / N8**（`deviation-ledger.md` §1.1 §1.2 §1.5 已逐条改写）；
**新增编号 N9**（§10.1 的「`room:{code}` 元数据应是 Hash」此前**只在 design.md 的 `[偏差]` 段里、对账表无编号**）。

**负对照（未修镜像上跑同一条用例，8 容器 healthy，4 次重跑一致）**：

```
❌ slice-07.1 失败：重复 join 后 playerCount（旧实现 = 2）：期望 1，实际 2
```
（容器内取证：`players.push` ×2、`hsetnx` ×0 —— 比「镜像旧」更硬。）

### 切片 7.1 新增的通用教训（两条，写给每个 agent）

1. **「并发复现竞态」的结论必须先写明连接预热条件**（R132，本轮真金白银撞出来的）。
   旧实现的 `GET→push→SET` 丢更新窗口确实存在，但**只在连接已就绪、请求同一 tick 写出时**才打得开：
   用 `fetch` 发 **冷连接** 20 路并发时，TCP 建连 + accept 把到达时刻**串行化**，localhost 的亚毫秒往返
   往往在下一条请求的数据事件之前就结束 ⇒ **旧实现意外正确**（`ok=3 / playerCount=3`，用例**假绿**）。
   同一份代码、同一台机器，预热前后可以量出 green 与 red 两种结论。
   **规则**：并发用例要用**显式 keep-alive 连接池**（`node:http` 的 `Agent({keepAlive:true})`）**并先预热**，
   且**预热与 burst 必须用同一个 agent**（「用 `fetch` 预热 `fetch`」是最容易踩空的地方 —— 那是两个池）。
2. **「不丢人」与「不超员」是两个独立不变量**（R132）：旧实现实测 **`ok=4 / playerCount=3`**
   （4 个人被告知入座成功、房间只有 3 席）—— 三条 `playerCount` 断言全绿，**只有「并发成功路数 === 3」抓到了它**。
   推论：并发用例里**计数类断言（成功数/失败数）才是不丢人的判据**，容量类断言（总数/长度）只能证不超员。
3. **假 Redis 比真 Redis 宽容 = 静默假绿**（本轮由后端 agent 自查 + 协调者复核）：
   `test/helpers/fake-redis.ts` 的 `del` 只删 String 键、`exists`/`ttl` 不认 ZSet —— 真实 Redis 三者**都不看类型**。
   于是任何 `del(hashKey)` / `expect(await redis.exists(queueZSet)).toBe(0)` 的断言都会**静默通过**。
   已按真实语义补齐（`58aa73f` + `8496ab8`），每一条都配了「旧实现会红」的用例。
   **规则**：**替身的宽容度就是对缺陷的容忍度** —— 写替身时先问「真实 Redis 在这里会怎样」。

### 切片 8 门禁实测（叫抢地主，合并 `feat/backend` + `feat/frontend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29（shared 100 · robot 12 · game-service 67
                                           #            client 142+2 skipped · room-service 134
                                           #            api-gateway 81 · user-service 29 · protocol 39）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 142 passed · vue-tsc 干净 · build OK

node tools/conformance/dist/run.js slice-08             # ✅ 55 项，10.4s（1 抢 2 不抢 → 地主 20 张）
node tools/conformance/dist/run.js slice-07             # ✅ 39 项
node tools/conformance/dist/run.js slice-06             # ✅ 124 项（房间数参与计数；只要尾行 ✅ 即通过）
node tools/conformance/dist/run.js slice-07.2-security  # ✅ 39 项
node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项
node tools/conformance/dist/run.js slice-05             # ✅ 29 项，54.9s（无回归）
```

**关闭的偏差**：**C4 / C15 / C22 / C23 / C24**（`deviation-ledger.md` §1.1 与 §2 已改写）。

### 切片 8 新增的必须照做的约定（R101–R123，细节见计划文件）

- **底牌并入地主手牌是「一处真源 + 三处连带」，漏一处就是硬失败**（R101）：
  真源在 `shared/ddz/bid.ts` 的 `finalizeBidding()`；连带是 `game-service/view.builder.ts` 的临时并入、
  `robot-service/bot.player.ts` 的 `+3`、以及**执行期才发现的第四处**
  `computePlayedCards()` 的「再减一次底牌」（R116）。**判据只有新增用例**——
  旧补偿在 `hand.push` 后重算 `cardCounts`，人为满足 `protocol/src/validate.ts:100`，
  而协议校验**不检查牌堆守恒** ⇒ 既有用例一条也抓不到 23 张（R118）。
- **流局必须重新洗牌发牌，且回座位 0**（R102/R104）：`resetBidding()` 复用 `dealCards()`
  （唯一发牌实现，**不要**再写一份洗牌），并且 `currentBidder` 是**覆盖为 0**而不是再推进一次。
  🔴 **2026-09-30 订正（片① R1）**：后半条「覆盖为 **0**」**已作废** —— 起始座位改为**随机**
  （`resetBidding` 用注入的 `random` **重摇**；见 `docs/games/doudizhu.md` §3.1 v1.3）。
  **随机座位是规格要求的，不是 bug。**
- **`timers.has(roomCode)` 不能当「有活动计时器」用**（R119，**隐患未修**）：
  `GameService.timers` 从不自我清理，计时器触发后旧句柄仍留在 map 里。
  要断言「真的重挂了」必须用**结构性判据**：句柄被换掉 + 再过一回合会**第二次**触发。
- **`GameService.onTurnTimeout` 的两条铁律**（R106）：超时动作抛错后
  ① 必须记 `logger.error`（房间/座位/原文），**不得**静默吞；
  ② 必须用**当前会话**重挂 30s，且**不得**落盘/改 `version`（那等于替服务端编造一次状态转移）。
  §9.1 的「出牌超时四步 / 首出打最小单张」**不在本片**，归切片 9。
- **前端叫抢 UI 的四个稳定 class**（R107）：`.table__bid-grab` / `.table__bid-pass` / `.table__play` /
  `.table__pass`。行动者只读 `store.actorSeat`（bidding 期 = `bidPhase.currentBidder`），
  且夹具必须让 `currentPlayer !== currentBidder`，否则「误用 `currentPlayer`」无区分力（R114）。

### 切片 7.2 门禁实测（安全收口，合并 `feat/backend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force     # ✅ 29/29，0 cached（api-gateway 84→106 · shared 100→116
                                          #   · room-service 156→157 · robot-service 12→15
                                          #   · game-service 67 · user-service 29 · protocol 39 · client 142+2 skipped）
pnpm exec turbo run build --force         # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 前端零改动、无回归

pnpm exec turbo run build --force         # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
node tools/conformance/dist/run.js slice-07.2-hardening   # ✅ 53 项，10.6s（新增）
node tools/conformance/dist/run.js slice-07.2-deploy      # ✅ 22 项，9.8s（新增；**R98 核心闸门**）
node tools/conformance/dist/run.js slice-07.2-boundary    # ✅ 70 项（N6 口径更新后全绿）
node tools/conformance/dist/run.js slice-07.2-security    # ✅ 40 项（+1：N6 信封断言）
node tools/conformance/dist/run.js slice-07.1             # ✅ 28 项
node tools/conformance/dist/run.js slice-07                # ✅ 39 项，37.8s（30 秒补机器人：room→robot 带 token 的端到端回归）
node tools/conformance/dist/run.js slice-06                # ✅ 209 项（房间数参与计数；只要尾行 ✅）
node tools/conformance/dist/run.js slice-08                # ✅ 55 项，10.8s
node tools/conformance/dist/run.js slice-05                # ✅ 29 项，55.4s
```

**关闭的偏差**：**S4 / S5 / S6 / S7 / A6 / N5 / N6 / N10 / N11**（`deviation-ledger.md` §1.3/§1.4/§1.5 逐条改写）；
**§A.3 部署闸门解除**（S1–S8 全 8/8 关闭）。**A7 收窄为「部分关闭」**（网关侧 + `acquireBot` 已完成，剩两半归切片 11）。
**新增编号**：**N12**（未知路由错误体非 §11.1 信封）· **N13**（登录/注册无 IP 维度限流）· **N14**（`/api` 之外的处理器整条绕过验签）·
**N15**（WS 上限在握手之后执行 ⇒ 超限客户端 connect/kick 循环）—— 四条**仍开放**，均不在 §A.3 范围内。另：对账表 **§0 的统计漂移**（C 区 26→27 等）已用新脚本校正。

**负对照（conformance 方在**未修** master 镜像上逐条取的 RED 原文；`slice-07.2-hardening` 是 fail-fast，故用 `CONFORMANCE_STEPS` 逐步取）**：

```
a6     匿名 GET / → 200 + `<!DOCTYPE html>…`（23KB 的验证页，含牌型引擎）
s4     经网关 POST /api/robots/move → 500（路由存在、下游吃整份 session）
s5     经网关 POST /api/robots/create → 201 + {"id":"bot-7610e84c",…}   ← S5 的活体形态
s98    ✅ 修前也绿（**预期**：它是回归锚点；判别力来自探针正/负对照 4/4 与 0 命中、扫描面 7 条非空）
n5     经网关 POST /api/games → 201（任何已认证客户端都能开局）
n6     经网关 GET /api/games/<code> → body.code === undefined（裸 PlayerView）
http   20 连发耗时 313ms、全部 200；第 21/22 次仍 200 ⇒ 超限被拒 **0** 次
ws     前 5 条静置后仍 connected；第 6 条**也**一直连着（限额不存在）
a7     proxy.gateway.ts 既无 AbortSignal 也无 signal:（机械闸红）
deploy 生产形态发布宿主端口的服务 = 全部 8 个（含 redis 6379 / mysql 3306 / douzero 2021）
```

**门禁期抓出的三处真问题（都不是「跑绿已有测试」能发现的）**：

- **R154**：`turbo.json` 的 `lint` 任务**没有** `dependsOn: ["^build"]`（`test` 有）⇒ `robot-service:lint` 先于 `shared:build`
  跑、读到过期的 `packages/shared/dist/index.d.ts` ⇒ `TS2305: … has no exported member 'createRedactingLogger'`。
  **只在「跨包新增导出 + 主检出 dist 过期」时出现**（历次切片都没这一步）；worktree 里因为跑过 build 而是绿的。
  已修（`lint` 补 `^build`），修后 29/29、0 cached。
- **R155**：本片新增的 §5.4「单 IP 并发 WS 连接 5」**撞到了我们自己的用例** —— `slice-08` 同时开着 P 房 3 条 + Q 房 3 条 = **6 条**
  ⇒ 第 6 条在握手后被拒（网关日志 `10006 too many connections from this IP`），它的 `room.match` 永远等不到 ack（`code=-1`）。
  **改用例**（开 Q 房前先关掉 P 房客户端并静置 400ms 等 `ZREM`），**不放宽限额**（5 是 §5.4 逐字）。
- **R156**：`tools/conformance/dist/run.js` 失败时**会永久卡住** —— `run.ts` 只设 `process.exitCode` 而不 `process.exit`，
  而失败路径泄漏的 socket 会吊住事件循环（实测卡 **693s** 直到 SIGTERM）。两处已修：`run.ts` 末尾兜底强制退出、
  `slice-08` 的 `startFreshRoom` 抛出前先关掉已连上的 client。**跑门禁时给每条切片套 `timeout` 是廉价保险。**

### 切片 7.2-P0/P1 门禁实测（安全收口，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force   # ✅ 29/29（robot 7 · api-gateway 81 · game-service 61 · room-service 134 · user-service 29 …）
node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项（四服务直连边界 / health 豁免 / 外部伪造被拒）
node tools/conformance/dist/run.js slice-07.2-security   # ✅ 39 项（?seat= 通道已堵）
node tools/conformance/dist/run.js slice-07               # ✅ 39 项（补机器人现在真的经过 token 校验）
node tools/conformance/dist/run.js slice-06               # ✅ 94 项
node tools/conformance/dist/run.js slice-05               # ✅ 29 项
```

⚠️ 跑这几条之前镜像必须是当前代码（`DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`）——
容器一律只吃镜像（宿主产物挂载已于 2026-09-23 整条删除，见「已知环境事实」）。

### 切片 7 门禁实测（合并 `feat/backend` + `feat/frontend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29（protocol 39 · shared 91 · robot 2 · user 21
                                           #            gateway 69 · game 52 · room-service 126 · client 137）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 137 passed · vue-tsc 干净 · build OK

node tools/conformance/dist/run.js slice-07   # ✅ 39 项断言，31.5s（单人 30.7s 后补位成局 → game.deal）
node tools/conformance/dist/run.js slice-06   # ✅ 99 项（房间数参与计数；只要尾行 ✅ 即通过）
node tools/conformance/dist/run.js slice-05   # ✅ 29 项，55.8s（无回归）
```

**`slice-07` 的三次结果构成完整判别力证据链**：修复前 → 前 6 组过、第 7 组超时；
只修一半（R42–R66）→ **仍红**，顺着查到 **R70**（`acquireBot` 少 `/api` → 404）；
R70 修复后 → ✅ 通过。**用例先抓住旧缺陷，又抓住了一个更隐蔽的新缺陷。**

⚠️ **门禁必须 `--force`**：合并后第一次 `pnpm test` 打印的是 `Cached: 19 cached / FULL TURBO`
—— 那是 turbo 从 `.turbo/cache` **回放日志**，不是真跑。不 `--force` 你看到的绿可能是回放出来的。

### 切片 7 新增的必须照做的约定（R42–R70，细节见计划文件）

- **`match:meta:{playerId}`（排队，TTL 300s）与 `match:pending:{playerId}`（匹配结果 `{roomCode,seat}`，TTL 300s）
  是两个键**（R42）——旧实现把排队信息写进 `match:pending`，已废除。
- **超过 30 秒等待窗口的唯一正确行为是「补机器人开局」**（§8.4②/R44）。
  旧实现把超时玩家当 stale **静默丢出队列** —— 这是本片的核心缺陷，任何形式都不许保留。
  超时的**唯一**出口是 `12007`，经 S→C `system.error` 下发（R46）。
- **机器人出站 id 不得以 `bot` 为前缀**（§9.8/R48）：出站走 `seat-${seat}` 掩码，
  但 `seatOwners` / `game.deal` 的**投递路由必须用 `room.players` 的真实 id** —— 两者不得共用同一个数组。
- **前端收到 `room.matched` 后必须自动 `room.join`**（§8.2/R50），且只有 ack `code 0` 才导航到牌桌。
  不 join 的后果：服务端不写 `reconnect:active`、`socket.join(roomCode)` 从不发生。
- **`12009`（已在队列中）在前端是幂等成功，不是错误**（R51）：`CLIENT_ACTION` 表把它归为 `IGNORE`，
  页面必须自己置「匹配中」。
- **`packages/protocol` 本片零改动**（R54）。
- **`room-service` 的 `lint` 是 `tsc --noEmit` 且 `noUnusedLocals: true`**：按任务顺序加 import，
  不要在 Task 1 就导入 Task 2 才用到的 `ErrCode`（否则 lint 红）。

### 切片 6 门禁实测

```bash
pnpm build && pnpm test && pnpm lint              # 19/19 三项全绿
node tools/conformance/dist/run.js slice-06       # ✅ 39 项断言（注册/登录/列表/轮换/登出吊销）
node tools/conformance/dist/run.js slice-05       # ✅ 29 项断言（回归：切片 5 不得被打回）
```

`slice-06` 覆盖：注册 → 重复注册 `11001`/409 → 登录失败两分支（`11002`/`11004`）→ 登录成功 →
**匿名 `GET /api/rooms` → 401**（§7.1 白名单只有 4 条）→ 建房间 → 列表为 `{code,data:RoomInfo[]}`
且每个房间**恰好六个字段**、无泄漏 → `refresh` 轮换且旧 refresh 被拒 → 旧 access 轮换后仍可用 →
`logout` → **登出后同一 access token 变 `10004`**（R26：白名单真的被查询）→ 登出后 refresh 被拒 → 另一账号不受影响。

### 切片 5 门禁实测

三者**同时通过**才算完成，这也是下一片的开工条件：

```bash
# 1) 工作区 DoD
pnpm build && pnpm test && pnpm lint          # 19/19 三项全绿
# 2) conformance（需先 docker compose build && up -d，否则测的是旧镜像）
node tools/conformance/dist/run.js slice-05   # ✅ 29 项断言，用时 ~53s
```

conformance 覆盖：断线前**刻意保持连接 40 秒**（越过旧实现的 35 秒记录窗口）→ 断线 10 秒 →
重连 ack 的快照与同一时刻另一路 `game.resync` **逐字段相等** → 重连后**仍收得到**
`game.state_update`（投递链路恢复）→ 反例「从未入房者 → `13010` 而非 `12001`」→ 全量 §6.4 泄漏扫描。

**负对照（证明用例不是空测）**：在**未含**后端修复的 master 镜像上跑同一用例，
匹配/发牌/进房/叫抢/resync 全部走通，**恰好**在重连那一步拿到 `13010`。

### 切片 9 门禁实测（出牌轮转，合并 `feat/backend` + `feat/frontend` + conformance 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（shared 116→127 · game-service 67→73
                                           #   · client 142→154(+2 skipped) · 其余不回归）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 154 passed · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 155 项，26.1s（新增）
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，6.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53 项，15.5s
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.2s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.9s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.0s
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，33.4s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 249 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，56.0s
```

**关闭的偏差**：**C16 / C18 / C19 / C20 / N2 / N16 / N18**（`deviation-ledger.md` §1.1/§1.5 已逐条改写）；
**部分关闭**：**C5**（§9.1 ①②③ 最优跟牌 ⇒ 切片 11，与 E4 同改）· **C6**（`HandType.Invalid` 启用 ⇒ 切片 11）· **N15**（后端半边 ⇒ 独立小片 P3）；
**新增 N17**（局终不下发 `state='ended'` 视图 ⇒ 切片 10）。

**门禁期抓出的三处真问题（都不是「跑绿已有测试」能发现的）**：
- **R172（计划自身缺陷）**：§7 的结束路径**不发** `game.state_update` ⇒ 终局手必须等 `game.finished`；计划初稿让终局手也等「更新的快照版本」，会**在已修的实现上假红 8 秒**。协调者评审期修正（`9e8a1bc`）。
- **N1 的真实后果（比登记强）**：首次真正打到对局结束才发现 `game.settlement` **整条被网关出站校验拦掉** ——
  `[ProxyGateway] Blocked outbound game.settlement for client <id>: ProtocolError: $.payload.baseScore must be a finite number, got undefined`（网关日志 6 条 = 2 次结束 × 3 家）。
  客户端只收 `game.finished`，`store.settlement` 恒为 `null`（不是「字段是 undefined」，是**事件不存在**）。**切片 9 刻意不修**（N1 是切片 10 的头条；只改形状会把 `spring:'none'`/写死的 `baseScore` 当**正确**结算推给前端，比不推更糟）。
- **R179（机械闸失效模式）**：`SHARED_SRC` 的相对路径在 `.worktrees/<role>/` 布局下**静默扫到主检出的同名文件** ⇒ 覆盖闸全程绿灯却对本分支一无所知。修法见下方教训第 1 条。

**负对照（未修栈，`CONFORMANCE_STEPS` 逐条取 RED）**：未知步骤 id 在任何网络动作**之前**抛错 · **C18** `首出过牌 ⇒ 13001：期望 13001，实际 0` · **C20** `单张的 length 应为 0，实际 1`（19 条，**确定性**）· **C19** `keyRank 应为内部 Rank 15，实际 17`（**机会性**：只有真的打出 DouZero `17` 才分歧）· **C16** `B1 等 game.finished 超时（8000ms）`。
⚠️ **C5 不构成 e2e 覆盖**（需真实 30s；判别证据在 `game.timer.test.ts` 的 fake timers）；**合跑（门禁形态）只证明 C20（+机会性 C19）**，因为 fail-fast 停在场景 A 的第一条断言。

### 切片 9 新增的通用教训（五条，都是「判据/闸靠推论」会踩的坑）

1. **源码级机械闸的路径解析会在 worktree 布局下静默扫到别的检出（R179）。**
   `.worktrees/<role>/packages/game-service/test/` 里的相对路径写错一层，就会落到 `<root>/shared/src`（ENOENT）或**主检出**的同名文件（存在、但是**旧的**）——后者让闸**恒绿**且对本分支一无所知（实测症状：注入的探针 `PLANT 0`，且扫不到本片新增的 `Cannot pass on the opening lead`；换成五级路径后在主检出里则 ENOENT ⇒ 门禁红）。
   **规则**：闸不要用固定层数的相对路径，改成**向上找到含目标文件的目录**（找不到即抛错）；并且**必须**把「扫到了本分支独有的标记」写成**断言**（不是 debug 打印）。这与 R150（正则漏扫模板字面量）同族但根因不同，**两条都要防**。
2. **UI 的选中态必须钉在**实例**上，不能钉在**值**上（R173/N18）。**
   按值记录（`indexOf(value)`）会让「同值的多个对象」退化成「最多一个」——实测后果是**阻断级**的：同点数最多选一张 ⇒ 对子/三张/炸弹/四带二/连对**从 UI 永远送不出去**（点第二张会把第一张取消，`expected +0 to be 2`）；而且渲染用 `includes(value)` 会把同点数的牌**整组高亮**（UI 在说谎）。判据必须包含「两个同值元素各自可选」，并带一条「点一张确实置位」的**正对照**（否则「换手牌后清空」那条可能是空测）。
3. **不要用 `Checks.eq` 比数组/对象字面量（R176）。**
   `Checks.eq` 用 `!==` ⇒ `checks.eq(violations, [])` 是**两个不同的数组引用**，**在任何实现上都不成立**（包括修好的）。这类「判据自身写错」的表现是**在已修的实现上假红**，最坏的地方是逼人改弱判据。判数组用 `checks.that(arr.length === 0, msg + arr.join(' | '))`，顺便把违例原文带进 RED。
4. **跨 socket 的「读一版、发下一版」必须先让**所有**参与者同步到同一 version（R177）。**
   `waitForNewerVersion(actor, v)` 只保证**行动者**拿到新版；用它去读**另一个** socket 的状态（`currentView(clients[0])`）会读到上一版 ⇒ 把请求发给**上一轮**的行动者（实测 `期望 0，实际 12003`）。**已合并的 `slice-08` 有同款竞态**，切片 9 一并修掉。
5. **覆盖度必须在输出里自证。**
   fail-fast 会在断言处中止；若 `info`/标签只放在断言**之后**，原始输出里就没有「这一跑打出了哪些牌、走到哪一步」⇒「没红」极易被读成「有覆盖」。切片 9 把 `info` 一律放在断言**之前**，并给每条动作标签带上牌值（`（DouZero 3）`），使任一跑的覆盖度可从原文判读。
   **另一条同族纪律**：领域常量（「一副牌有几个 2」）写进注释前**去 `createDeck()` 数一遍** —— 本片两次把推论当事实（`37%`/`61%` 分别假设 1 个/2 个 `2`，真值是**四个**，正确覆盖率为 85.3% / 79.1%）。

### 切片 10 门禁实测（结算，合并 `feat/backend` + `feat/frontend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（shared 127→135 · game-service 73→74
                                           #   · room-service 157→159 · client 154→163(+2 skipped)
                                           #   · mock-server 0→2；protocol 39 · robot 15 · gateway 106 · user 29）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项，21.0s（新增）
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项，26.1s（155 → +5：恢复的结算断言）
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，8.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53 项，15.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.0s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.8s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.1s
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，39.0s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 374 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，55.6s
docker compose logs api-gateway | grep -c 'Blocked outbound game.settlement'   # ✅ 0（修前每结束一局 3 条）
```

**关闭的偏差**：**C1 / C2 / C3 / C26 / N1 / N17**（`deviation-ledger.md` §1.1/§1.5 已逐条改写）；**新增 N19 并同片关闭**。

**负对照（未修栈 = 合并前的 master 镜像，`CONFORMANCE_STEPS` 逐步取 RED）**：
```
slice-10 a  → ❌ slice-10 失败：S10A0 等 game.settlement 超时（8000ms）   （N1 的活体形态：事件不存在）
slice-10 b  → ❌ slice-10 失败：S10B0 等 game.settlement 超时（8000ms）
slice-09    → ✅ 地主恰好用了 20 墩 = 20；✅ 口径…在线可观测 19 手        （19/20 = N17 的量化形态）
              ❌ slice-09 失败：A0 等 game.settlement 超时（8000ms）     （恢复的断言确有判别力）
slice-09 b  → ✅ 农民恰好再首出 16 墩 = 16；✅ 口径…在线可观测 16 手
              ❌ slice-09 失败：B1 等 game.settlement 超时（8000ms）
单测        → C1 `expected 3 to be 4` · C2 `expected undefined to be 1` · C3×3 `expected undefined to be 'spring'/'anti-spring'/'none'`
              · C26 `expected undefined to be 200` · N1 字段集 `[farmerScoreChange,…(5)]` vs `[baseScore,…(8)]`
              · N19 `expected 100 to be 200` · N17 `终局必须发一版 state==="ended" 的 game.state_updated: expected -1 to be >= 0`
              · room `version 7 实际 ['game.state_update','game.current_turn']，期望 ['game.state_update']`
```

### 切片 10 新增的通用教训与约定（六条）

1. **「同名不同形」的类型只要存在一天，就会有一个整条功能被静默拦掉（N1）。**
   `shared` 的内部 `SettlementResult` 与契约同名不同形 ⇒ 网关的 `validateOutbound`（§6.4 规则 4）把**整条** `game.settlement` `return` 掉，
   客户端**只收到 `game.finished`**。**它烂了整整 5 个切片没被发现，唯一原因是此前的切片从不把一局打完**——
   任何「S→C 事件能不能到达客户端」的性质，**只有把一局打完的 e2e 才能判**。
   **规则**：内部类型**直接复用**契约类型（切片 9 的 `lastPlayedHand`、切片 10 的 `SettlementResult` 都是这一手法）；
   新增任何跨进程载荷后，**必须**有一条「喂给 `validateOutbound` 不抛」的判据 + 一条「客户端真的收到了」的在线判据。
2. **修好 N1 后必须恢复被注释掉的那条断言，且要证明恢复本身有判别力。**
   `slice-09` 恢复的 5 条在未修栈上**确定性红**（`等 game.settlement 超时`）—— 这才是「恢复不是装饰」的证据。
   **规则**：任何被暂时降级成 `info` 的断言，都要在缺陷关闭的那一片恢复，并在负对照里逐条取 RED。
3. **「倍数/底分/春天」这类数值规格，判据必须**同时**钉住公式与守恒，且夹具要能隔离各个因子（R183）。**
   `bombCount=1 + bidMultiplier=2` 这条判据若不让 `farmerPlays > 0`，春天会让期望从 `4` 变 `8`，
   把 C1 的判据污染成 C3 的；`baseScore` 的用例要用 `200`（不是 100），否则「读字段」与「硬编码 100」同值、判据恒真；
   分数还要单独断言 `地主变动 + 农民变动 × 2 === 0`（§8.4）。
4. **变异探针是判据的唯一自证手段，本片用了三次且都抓到了东西。**
   ① `landlordSeat: landlord.seat` → `session.players.indexOf(landlord)` ⇒ `expected 2 to be 1`（C2 抓得住「误用下标」）；
   ② 前端 `source-boundary` 闸里临时塞 `computeMultiplier` ⇒ 闸红（新文件确实被扫到）；
   ③ mock-server 的倍数退回 `bombCount + 1` ⇒ `expected 3 to be 8` / `expected 2 to be 4`。
   **规则**：**每一条新判据都要问「把被测行为改坏，它会不会红」**；答不上来的判据等于没有。
5. **「同一事实的第二真源」会在测试与联调里教坏下一个人（R192）。**
   `tools/mock-server` 也产结算，它的倍数同样是加法（`bombCount + 1`）且丢掉叫抢倍数 ——
   前端 agent 的 `mock-e2e` 与联调都照着它写。**规则**：本仓出现第二份「规则数值」时，同片对齐并配判别性用例
   （`bombCount=1` 时加法/乘法**碰巧**相同 ⇒ 判据必须用 `bombCount=2`）。
6. **判据要「结构性」，不要「墙钟式」（本片全部照做）。**
   N17 的三层判据都是结构性的：`ended` 快照在 `received` 里的**下标**小于 `settlement`、版本相等、终局版 `current_turn` 计数为 0
   （且先证明上一版确有 `current_turn`）。**没有一条依赖 sleep 或时间差**，因此与负载无关。

### 切片 11 门禁实测（机器人系统，合并 `feat/backend` 后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（shared 135→171 · room-service 159→173
                                           #   · game-service 75→83 · robot-service 15→37 · api-gateway 106→107）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项，93.4s（新增：drive/play/finish/leak/pool/idem）
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，35.8s（补位回归：机器人现在会自己行动）
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项，20.7s
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项，25.4s
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，8.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 54 项，14.9s（+1：A7 判据 A′）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.7s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.0s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.9s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.0s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 299 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，53.4s
docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0
```

**关闭的偏差**：**C7 / C8 / C9 / E4 / E9 / A7④⑤**（`deviation-ledger.md` §1.1/§1.2/§1.4 已逐条改写）+ **C5、C6 的剩余半边** + **§9.4**；
**新增 N20（TCP RPC 迁移未落地 → P4）与 N21（§9.6 的回收扫不到「`release` 丢失」的绑定机器人）**。

**门禁期抓到三处「单测全绿但容器/闸红」的真问题（都不是跑绿已有测试能发现的）**：
- **R216**：`{ provide: GAME_CLIENT, useClass: GameClient }` 让 Nest 去解析 `GameClient` 构造函数里那个**带默认值的 `options` 参数**
  （Nest 看不见默认值，只看见一个没有 provider 的依赖）⇒ room-service **crash-loop**：
  `Nest can't resolve dependencies of the GameClient (HttpService, ?)`。修法：`useFactory` 显式构造。
- **R217**：`RobotPool` **缺 `@Injectable()`** ⇒ Nest 用 `new RobotPool()` **无参构造** ⇒ `this.redis === undefined`
  ⇒ `/api/robots/acquire` **500**（`Cannot read properties of undefined (reading 'hget')`）。修法：补 `@Injectable()` +
  **Redis 值导入**（`import type` 会让 `emitDecoratorMetadata` 退化成 `Object`，token 对不上）+ `clock` 标 `@Optional()`。
  **教训**：`new XxxService(fake)` 式单测**永远覆盖不到 Nest 装配层** —— 只有容器门禁能抓。
- **两张源码级闸的指名正对照必然失效**（R150 同族第三次发作）：A7④ 把 `game.client.ts` 从 `fetch` 改成注入式 `HttpService` 后，
  `api-gateway/test/outbound-timeout.gate.test.ts` 与 conformance `slice-07.2-hardening` 第 9 步都**硬要求它出现在
  `callsFetch` 的命中集合里** ⇒ 修好后反而红。修法：正对照只列**仍走 fetch** 的文件，另加**判据 A′**（注入式客户端必须带 `timeout:`）——
  **判据要钉「有超时」这个性质，不是钉 `fetch` 这个形态**。
- 另：`robot.controller` 的 `acquire/release/decide` 显式 `@HttpCode(200)`（POST 默认 201 是「创建资源」的语义，而三者都是**动作**）。

### 切片 11 新增的通用教训（六条；门禁实测待收口时补写）

> 本片是「**协调者自己的裁决也会错**」的一课：下面第 1 条是本片最大的坑，而且它比 agent 写错更危险 —— agent 是照裁决实现的。

1. **裁决里引规格必须**逐字抄**，不能凭记忆概括（R204 自查纠错）。**
   我在 R204 里把 C5 的收口写成「跟牌时可过牌 ⇒ 过牌（保持切片 9 行为）」，并把 §9.1 的 ①②③ 推给 robot-service。**那是错的**：`docs/games/doudizhu.md` **§9.1 的标题就是「出牌超时的自动行为」**，逐字是「跟牌 ⇒ ① 同型同 length 最小可压 → ② 最小炸弹 → ③ 王炸 → ④ 均无才过牌；首出 ⇒ 最小单张」。按初稿实现，**C5 会永远关不掉**（对账表里它的剩余半边**正是** ①②③）。
   **规则**：裁决里凡出现「规格 X 说……」都必须**把原文抄进来**（本片最终形态就是引用了 §9.1 的代码块）；发现裁决与规格冲突时，**先改计划文件、再通知 agent**，并在计划里留一段「修正说明」（不隐去历史）。
2. **「牌型引擎」的形态缺陷只有「结果自洽性」判据抓得住（E4 的真实缺陷）。**
   飞机带单的 `takePlaneWithWings()` 用 `takeOfRank(hand, r, 3)` 取主体，**若该点数有 4 张**，第 4 张留在 `rest` 里；而翅膀候选只排除了「张数 = 4 的点数」，**没排除主体点数** ⇒ 第 4 张被当翅膀 ⇒ 同点数出现 4 张 ⇒ `parseHand` 判 **`Invalid`（非法动作）**。实测反例：手牌 `5×4 6×3 7×3 8 9`、目标为 2 组三张的飞机带单 ⇒ 返回 `[5,5,5,6,6,6,5,7]`（应为 `[…,7,8]`）。
   **规则**：给「构造合法动作」的引擎加一条**全表通用**的自洽断言 —— `parseHand(结果)` 必须合法 **且** `canBeat(结果, 目标)` 为真；逐型人工核对的用例表**抓不住**这类形态错误。协调者另用**随机化属性测试**独立复现（14 型 × 800 手牌 = 2937 个样本，0 违例）——那是对该断言的随机化版本。
3. **「特征真实化」的判据是**反向**的：未出的牌一张都不许出现（C8）。**
   旧 `bot.player.ts` 的 `computePlayedCards()` 用「总牌堆 − 当前手牌」反推、再按 `lastPlayerIdx` 倒序**硬分配**给三家 ⇒ 把**未出的牌估成已出**。修好后必须有这条反向判据：**所有 `playedCards` 与任何玩家当前手牌的交集为空**（协调者探针实测 7/7）。只断言「已出的牌在里面」是**不够**的 —— 那正是旧实现也能过的那一半。
4. **新增敏感字段要单独做一次「出站泄漏体检」（`actionLog` 是三家全部牌面）。**
   体检要回答三个问题：① 全仓哪些地方序列化整个 `GameSession`（唯一允许的是 `game.service.saveSession` → Redis 持久化）；② 出站是否只走 `buildPlayerView()`（显式字段表）+ `validateOutbound()`（`FORBIDDEN_OUTBOUND_KEYS` 已含 `actionLog`/`isRobot`/`botId`/`skillLevel`）；③ 服务间全量通道（`game.snapshot`）是否**需要内部 token 且网关未暴露**。三条都成立才算「没有泄漏路径」。
5. **机械闸的「正对照」会随功能落地而**必然**失效 —— 必须同步换探针（S4/§9.5）。**
   `packages/robot-service/test/no-session-boundary.test.ts` 原先拿「`bot.player.ts` 仍然 `import GameSession`」当正对照；切片 11 把机器人改成只吃 `view + features` 之后，这条对照**注定消失**。得换成不会随实现演进而消失的探针（对合成字符串测正则）。
   同处还记下一个**正则坑**：`/import[\s\S]*?GameSession/` 的 `[\s\S]*?` 会**跨语句边界**，于是**注释里提到 `GameSession` 也会被判成「import 了它」**（实测误报）⇒ 用 `[^;]*` 把匹配限制在一条语句内。
6. **逐步取 RED 时，RED 必须归因到**被选中的那一组**。**
   `slice-11` 初版在「整局超时」处**直接抛第 3 组的错**，于是 `CONFORMANCE_STEPS=play` 单跑也会报「第 3 组没打完」—— 归因错位。改成**只跳出循环**、让被选中组的收口断言去红；并让 `CONFORMANCE_STEPS=leak` 单跑**不必等整局**（§9.8 的扫描面在「开局 + 叫抢」就已展开，正对照「机器人对外 id」在 `room.join` ack 里就可见）。

7. **「机械扫描没扫到坏东西」在**旧栈**也可能成立 —— 判别力必须来自**正向**断言。**
   切片 11 的 §9.8 四标记扫描（`bot-`/`isRobot`/`botId`/`skillLevel`）在**未修栈上同样全绿**：因为旧实现把机器人的对外 id 掩码成 `seat-1`/`seat-2`。⇒ 「不可区分性」的真正判据是**正向**的那条：机器人的对外 id 必须形如 `p_<8位>`（E9 的 `displayId`），且这条要写成**硬断言**（外加「本房确实有机器人」的正对照）。**同族提醒**：任何「禁止出现 X」的扫描都要配一条「Y 确实出现」的正向断言，否则它在旧实现上也可能是绿的。

### 切片 P4 门禁实测（§4.2 TCP RPC 迁移 / N20，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（shared 171 · room-service 190（+17）
                                           #   · game-service 100（+17）· robot-service 45（+8）
                                           #   · api-gateway 108 · user-service 29 · protocol 45（+2）
                                           #   · client 163(+2 skipped，**零改动**) · mock-server 2）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 前端零改动、无回归

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
# ⚠️ **先清空机器人池**（R243）：`slice-11` 第 5 组的池闭环判据写死了「全新栈」前提，
#    而 `slice-07.2-rpc` 排在它前面且会真的 acquire/release 一次 ⇒ 不清空则 slice-11 假红
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项（新增）
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 60 项（54 → +6）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 28 项（22 → +6）
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项（70 → +12）
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（房间数参与计数，随 Redis 累积而变；只看尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
# ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'  # ✅ 0
# 生产形态（**2026-09-24 门口片 R1203 更新**）：**只有门口 edge** 发布宿主端口（80/443）；
#   api-gateway 是 ports=[] expose=["3000"]，game/robot 是 ports=[] expose=["3103"/"3105"]
```

**关闭的偏差**：**N20**；**新登记并同片关闭 N22**（`robot.pool.takeIdle()` 的幽灵成员）。

**门禁期抓到 4 个真缺陷（全部「单测全绿、容器/门禁红」）**：
- **R239（最贵的一条）**：`connectMicroservice({transport, options: {transport, options:{host,port}}})`
  —— `rpc.options.ts` 的工厂返回了**整个**入参形状、调用方又嵌了一层 ⇒ port 落在
  `options.options.port`，而 `ServerTCP` 读 `options.port` ⇒ `undefined` ⇒
  **静默回落到 `TCP_DEFAULT_PORT`(3000)** ⇒ `EADDRINUSE` 走进 `server-tcp.js` 里那个
  「只对 `EADDRINUSE`/`ECONNREFUSED` 调 callback」的分支 ⇒ **日志照打「Nest microservice
  successfully started」而 RPC 端口从头到尾没绑上**。
  ⚠️ **观测陷阱**：宿主 `nc -z 127.0.0.1 3103` 反而报 **OPEN**（Docker 用户态代理先收下连接、
  后端没人再关掉）⇒ **必须进容器内连**才看得到 `ECONNREFUSED`。修法：工厂只返回
  `{host, port}`，并显式写 `connectMicroservice<MicroserviceOptions>(...)` 让 tsc 守住形状
  （此前「不加类型参数」的注释正是把形状错误藏起来的原因）。
- **R240**：`robot-service` 的三条内部 HTTP 路由（`acquire`/`release`/`decide`）**漏删**
  ⇒ 「同一语义两条通道」。`slice-07.2-rpc` 第 5 组先抓住（`期望 404，实际 200`）。
  **当时没有任何单测看得见**：`robot.rpc.test.ts` 只测 RPC 控制器，而 `robot.decide.test.ts`
  第 ⑤ 组测的是 `internal-token-harness` **自己挂的假路由** ⇒ 真实路由删掉后**照样全绿**
  （「测的是自己的脚手架」，切片 7.2 教训第 5 条）。
- **R241**：一条**假红** —— 「直连 `POST /api/games` **不带** token ⇒ 404」。
  `createInternalTokenMiddleware()` 是 `app.use` 全局中间件、跑在**路由之前** ⇒ 不带 token 时
  **任何**路径都先得 401（含不存在的路径）⇒ 该断言在**正确实现上不可能成立**。
  改为**带正确 token** 后判别力更强（修前 201、修后 404）。
- **R242**：一条**恒绿** —— conformance 的自查不变式 `allFilesStillHttp` 语义写反
  （「任一文件清干净就置 false」而非「所有文件都还留着」）⇒ 迁移部分完成就误报，
  而它本该守住的「忘了清空 xfail 清单」永远不触发。

### 切片 P4 新增的通用教训

1. **「DI 通了」与「端口真的在听」是两条不同的命题**（R216/R217/R227/**R239** 同族第四次发作）。
   `Test.createTestingModule(...).compile()` 通过、日志打「successfully started」，
   都**不**蕴含端口真的绑上了。要覆盖这一类，判据必须**真的绑一个端口 + 真的连一次**：
   本片 `packages/game-service/test/rpc-listen-bind.test.ts` 用 `port: 0`（内核分配，不抢常驻端口）
   + 手写 `JsonSocket` 线格式请求，并在**同一个文件**里放一条「把形状改坏 ⇒ 断言它抓得住」的
   反向判据（判别力自证，R115）。
2. **框架「成功」日志不能当绑定的证据**：Nest 的 `ServerTCP.listen()` 在
   `EADDRINUSE`/`ECONNREFUSED` 上照样走 callback ⇒ 照样打 success 日志。
   **要证明监听存在，只能从对端连一次**（或在容器 `/proc/net/tcp` 里看到那个端口）。
3. **宿主侧探针会被 Docker 的用户态代理骗**：容器内没人监听时，宿主 `nc`/`connect` 仍可能
   「连上」然后被 reset。**症状是「端口开着但读连接就 ECONNRESET」⇒ 一律进容器内核实**。
4. **`app.use` 全局中间件跑在路由之前** ⇒ 「不带 token 打一条不存在的路由」得到的是 **401 而非 404**。
   任何「某路由已删除」的判据**必须带正确的凭证**，否则它测的是中间件、且会在正确实现上假红。
5. **「待迁移清单」写进闸里会把「迁移完成」变成一个人工动作**：本片最终形态是
   「**正向**断言 + **反向**扫描」（清单为空是**结果**而非状态），并在迁移完成时清空 xfail ——
   否则那条闸只会**恒绿**。同类：任何 `NOT_YET_*`/`ALLOWLIST` 都要配一条「它已该为空」的不变式。
6. **新增的切片会打破已有切片的「全新栈」前提**（R243）：`slice-11` 第 5 组的池闭环判据依赖
   `poolBefore` 为空（它的注释写着「全新栈上 = 净增 2」）。本片把 `slice-07.2-rpc` 排在它前面、
   且那一组会真的 `acquire`/`release` 一次 ⇒ 池里留下**可复用**的空闲机器人 ⇒ 判据红。
   **症状极像真缺陷**（数字对不上），实际是**顺序耦合**：单独跑绿、全量跑红、清空池后全绿。
   ⇒ 规矩：**用例不得依赖「别人没留下状态」**；确有依赖时，把前置条件**写进门禁命令**
   （本片即 `redis-cli DEL bot:pool:ddz`），并登记那条判据待重写为与前置状态无关的形态。
7. **裁决编号是全局资源，派工前必须划定区间**：两个并行 agent 各自从 R227 起编号
   ⇒ 合并后同一份文件里出现两组 `R228`…`R231`。本次只多花了一次顺移，但若两边**互相引用**
   就会变成真错误。**派工时写「你用 R2xx–R2yy」**。
   ⚠️ **P5 实测：这个坑连划了区间也会踩** —— P5 的计划把后端 agent 划到 `R280–R299`，
   而 **R280–R283 早在 P3 就被 conformance agent 用掉了**（派 P3 时又划错了一次）。
   ⇒ 划区间前**必须先把已用过的最大编号查出来**，不要照抄上一片的区间：
   ```bash
   grep -rhno "R[0-9]\{3\}" docs/ --include=*.md | sed 's/.*://' | sort -u | tail -20
   ```

### 切片 P5 门禁实测（上线准备收口，全部 `--force`、0 cached）

```bash
cd /home/howe/pokergame
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
timeout 1200 pnpm run ci                   # ✅ §13.4 六阶段全绿（**本片的核心 DoD**）
#  1/6 install 3s · 2/6 lint 9s(12/12) · 3/6 build 10s · 4/6 test 26s · 5/6 coverage 2s
#  6/6 eslint-forbidden (§12.4) 5s：client/source-boundary ✓ 8 · room-service/no-internal-http.gate ✓ 8
#    · api-gateway/outbound-timeout.gate ✓ 5 · api-gateway/no-route-outside-api.gate ✓ 6
#    · game-service/rule-error-mapping ✓ 3
#  ⇒ 「=== [ci] 六阶段全部通过 ===」，CI_EXIT=0
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK（**零前端改动**）

pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ All files 97.58% ≥ 80（门槛已入配置）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy（§14.4 的 DoD 逐字）
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s localhost:$p/api/health; echo; done
#  ✅ :3001 = {"checks":{"redis":"up","mysql":"up"}}；其余四个恰好 {"redis":"up"}
curl -s localhost:3002/api/health/live      # ✅ 200 {"status":"ok","service":"room-service"}（**不含 checks**）
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/healthz      # ✅ 401（近邻：豁免是精确条目）
curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/api/health/livex # ✅ 401

docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null   # 池静默化（保险，R243 后已非必要）
for s in slice-07.2-deploy slice-07.2-hardening slice-11 slice-07.2-rpc slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ slice-07.2-deploy **104**（55 → +49：§2.4 健康检查）· slice-07.2-hardening **103**（73 → +30：§12.4 闸判别力 + §13.3 门槛变异）
#    · slice-11 46 · slice-07.2-rpc 61 · slice-07.2-boundary 82 · slice-07.2-security 40 · slice-07.1 28
#    · slice-07 39 · slice-10 185 · slice-09 160 · slice-08 55 · slice-06 199 · slice-05 29
#  ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'                                    # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0
```

**关闭的偏差**：**N23**（删除 `rule/beat.ts` 的 `canBeatWithHand` 死代码）· **N24**（§13.3 覆盖率门槛 + §13.4 CI 六阶段）· **N25**（§2.4 的 `checks` + 存活/就绪分离）。另按 **R268** 裁决了 §12.4 的落地形态（以既有 vitest 源码闸为准，不照搬 ESLint 插件），并按 **R269** 把 CI 做成可本地执行的 `scripts/ci.sh`。
**对账表 §0 现为 78 条：77 已关闭 / 0 部分关闭 / 1 仍开放** —— 唯一仍开放的是 **N13**（风控 roadmap）。

⚠️ **门禁期抓到 3 个真缺陷（全部「单测全绿、只有真容器能看见」）** —— Task 1 改的是五个服务的**启动路径**，第一轮容器验收时 `turbo run test lint` 是 **29/29 全绿**，但：
1. **`/api/health/live` 恒 401**：网关 `publicPaths` 与四个下游 `DEFAULT_EXEMPT_PATHS` 都**只**列了 `/api/health`，且两处都是**精确**匹配 ⇒ 新端点天然不被豁免。（修法：加**精确**条目，**不得**改成前缀。）
2. **`ftl-robot-service` crash-loop**：`HealthController` **同时**被 `AppModule` 与 `RobotModule` 注册；没有构造参数时无害，本片给它加了 `HealthService` 依赖后 `RobotModule` 上下文解析不到 provider ⇒ `Nest can't resolve dependencies of the HealthController (?)`。
3. **`:3000/api/health` 没有 `checks`**：`GatewayController.@Get('health')` 与 `HealthController.@Get()` **同路径重复注册**，Express 取先注册者 ⇒ §2.4 在网关这一跳**静默失效**。⚠️ 它藏在 `gateway.controller.ts` 里，计划里「改五个 `health.controller.ts`」的说法**找不到它**。
⇒ 处置：修三处 + 新增 `packages/api-gateway/test/container-assembly.gate.test.ts`（8 条用例、**三条装配不变式**、每条自证判别力）：健康路由 ⊆ 免鉴权清单 · 一个控制器只被一个模块注册（**按服务**判定 —— 五个服务各有一个同名 `HealthController`，它们是五个不同的类）· 同一服务内无同路径同动词重复路由。提取器**必须先去注释**（本仓控制器注释里就写着 `@Get('live')`，按原始文本提取会造出**幽灵路由** ⇒ 假红）。

### 切片 P5 新增的通用教训

1. **「改五个同名文件」的计划说法会漏掉第六处**（R294）：`api-gateway` 的 `/api/health` 有两个处理器，一个在 `health.controller.ts`、另一个在 `gateway.controller.ts`。**做「每个服务改一份」这类改动前，先 `grep -rn "<路由字符串>" packages/*/src` 枚举真实注册点**，不要按文件名推断覆盖面。
2. **新增一条公开路由要改两个互相独立的清单**（网关 `publicPaths` + 四个下游 `DEFAULT_EXEMPT_PATHS`），且两处都是**精确**匹配 ⇒ 此前无任何闸守着（R23 的**有意重复** + 新路由 = 天然漂移点）。现在有不变式闸；**配套的负对照必须是「近邻路径仍 401」**（`/api/healthz`・`/api/health/livex`），否则「把前缀放行」这个最诱人的错误修法不会被抓住。
3. **vitest 的 `coverage.exclude` 是整体覆盖、不是增量**（R289）：自己写数组会**静默取消** vitest 默认的 `**/*.test.ts` 排除 ⇒ **测试文件进分母**，读数不再是「`src` 行覆盖率」。必须 `...coverageConfigDefaults.exclude` 打头。⚠️ **这是最容易把覆盖率门槛做假的地方** —— 而且它**不会报错**，只会让数字变小。
4. **门槛类判据必须自证「会失败」**（R270/R291，与 P3 的 `allFilesStillHttp`/`NOT_YET_MIGRATED` 同族）：覆盖率门槛用「临时抬到 99 ⇒ 产品脚本非零退出」自证；CI 第 6 阶段的每条闸必须断言 `Tests N passed ≥ 1`（过滤名与文件名脱节时 vitest 会「**0 用例而退出码 0**」）。⚠️ 后者的自证方式是**换探针**：把五条闸换成「`--passWithNoTests` + 假过滤名」的探针 A，脚本必须仍然退出 1。
5. **esbuild 不发 `design:paramtypes`**（R286）：靠**类型**解析的 `@Inject` 在 tsc 生产路径正确，在 vitest 里会**静默注入 `undefined`**。本仓既有惯例就是显式 token（`session.guard.ts`/`token.service.ts`/`http-rate-limit.middleware.ts`）⇒ **新增 `@Injectable` 构造依赖一律写显式 `@Inject(...)`**：它比 `design:paramtypes` **更严**，且让「注入的是什么」在源码里可读。
6. **「覆盖率基线」可能只是口径 artifact**（R290）：计划里引用的 93.94% 是**含测试文件与两个不可执行文件**的默认口径；真实口径是 95.38%（删死代码后 97.58%）。⇒ 引用覆盖率数字时**必须同时写口径**（`include`/`exclude`）。
7. **判据改形态时，把「为什么修前不红」写出来而不是删掉它**（R307）：新的「近邻 401」判据在修前栈上**也是绿的**（那两条路径当时本来就不公开）⇒ 它是**回归闸**、不是缺陷探测闸。它的判别力由**成对的实测观测值**承担：匿名 `/api/healthz` = **401**（来自验签中间件）vs **带凭证** `/api/healthz` = **404 + 10001**（走到路由层）。**没有这一对，「401」就可能只是「全站都 401」的产物。**
8. **调度冲突也要用「现象是否真实存在」的纪律**（P5 独有的教训）：P5 因为一次 session 异常中断，协调者在恢复后**重复派了同一个 Task** ⇒ 两个 agent 同时改写 `tools/conformance/**`。其中一个 agent **靠 mtime 秒级推进**把「活的并发写入」与「残留状态」区分开，并援引「并发跑 conformance ⇒ 网关按 IP 计并发 WS 名额（上限 5）⇒ 双方假红」而**选择停手不抢写**。⇒ 两条规矩：① **恢复中断的 session 前先 `list_agents` 核实有没有还活着的 agent**；② 任何 agent 发现自己不是唯一写入者时，**停手 + 上报**比抢写正确。

### 切片 P6 门禁实测（工程债收尾，全部 `--force`、0 cached）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit            # ✅ 冲突无（auto-merge 计划文件）
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
timeout 1200 pnpm run ci                   # ✅ 六阶段全绿（CI_EXIT=0）；第 6 阶段 8/8/5/6/3 passed
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ All files 97.58% ≥ 80
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13：slice-11 **50**（46 → +4：三条正对照 + 一条负对照）· slice-07.2-rpc 61
#    · slice-07.2-deploy 104 · slice-07.2-hardening 103 · boundary 82 · security 40 · 07.1 28
#    · slice-07 39 · slice-10 185 · slice-09 160 · slice-08 55 · slice-06 174 · slice-05 29

# R253 的顺序无关性（门禁的一部分，协调者独立复核）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11   # ✅ 池空 ZCARD=0 ⇒ 50 项
# 种子：经 robot RPC acquire 两个再一起 release ⇒ 池里 2 个空闲成员
timeout 300 node tools/conformance/dist/run.js slice-11   # ✅ 池非空 ZCARD=2 ⇒ 50 项

docker compose logs api-gateway | grep -c 'Blocked outbound'   # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0
```

**关闭/登记的项**：**R253**（`slice-11` 第 6 组相对量判据 → 绝对性质）· **R310**（`api-gateway` 补 `reflect-metadata` 直接依赖）· **R119 → 新登记 N26**（实证「无影响」+ 一条约束，**不改代码**）· `design.md` 的 **12 处**过期注记清理（§3 表点名的 + `web/` 簇 + 四处自相矛盾的标题标记）。
**对账表 §0 现为 79 条：78 已关闭 / 0 部分关闭 / 1 仍开放**（仍开放 = **N13**，风控 roadmap）。

**⚠️ 门禁期确认的三条事实**
1. **`slice-11` 判据数 46 → 50**（4 条是判别力自证：三条正对照 + 一条负对照）。
2. **`api-gateway` 的 `reflect-metadata` 缺依赖是真实的、可复现的**：探针 `import 'reflect-metadata'` 在补依赖前实测 `Failed to load url reflect-metadata … Does the file exist?`，补后绿（`pnpm-lock.yaml` 只新增 3 行）。
3. **`design.md` 的内联 `[偏差]` 从 33 处降到 22 处** —— **本片刻意不清干净**（R312：未立条的余量一律不动），所以**不要**把「21」读成「还剩 21 个待办缺陷」。

### 切片 P6 新增的通用教训

1. **相对量判据的收尾比它的发现更贵**（R253/R340/R341）—— 本仓最后一次这类残留。两个反直觉点值得记住：
   - **换形态 ≠ 改等号右边**：绝对性质「窗口内没有新增成员」的**窗口必须紧贴被测动作**。P6 实测：用「第 1 次 acquire 之后」那次读当窗口左端 ⇒ **新判据继承旧等式的同一个假红**（同一份观测值：**宽窗口 1 条违规 / 窄窗口 0 条**）。分界线是**窗口的右边界紧贴第 2 次 acquire**。
   - **构造「第三方写入」有前提**：必须注入 **≥2 个**真实池成员，且要**先把两个都 acquire 再一起 release**。只注入一个时，第 2 次 acquire 走幂等路径（`findBound()` 命中即 `continue`、**完全不碰池**）⇒ 那个成员原样留在窗口前后两次读里、长度不变 ⇒ **旧等式照样绿**；而「acquire 一个→release 它→再 acquire 下一个」只会复用同一个 `botId`。
   - ⇒ **推论（本次最重要的发现）**：「两次 acquire 之间池计数不变」这类判据在本仓**几乎是恒真的** —— 它对「acquire 污染池」有判别力，但对「池退化成 0 / 容量静默丢失 / 幽灵成员（N22）」**完全免疫**。**R253 那条等式即使旧形态也从没抓到过它本该抓的 bug**，它的判别力全部来自「窗口外有人动池」这个**假红来源**。
2. **「有依赖但不 import」是一种隐性依赖，补 `package.json` 只是让它可被显式声明**（R310）：补了 `api-gateway` 的 `reflect-metadata` 之后，`packages/{api-gateway,room-service}/src/main.ts` 仍**不** `import 'reflect-metadata'`（另外三个服务都 import）—— 今天都不故障只因 `@nestjs/common/index.js` 内部 `require` 兜底。**P3 的环境事实逐字记过**：只 import 子路径（如 `@nestjs/common/decorators`）的入口会丢掉 polyfill。⇒ 排查「某个入口忽然缺装饰器元数据」时先看它 import 的第一行。
3. **台账自己会过期，而且比代码过得更快**（P6 最便宜的一条）：`deviation-ledger.md` §3 表登记了 13 行「文档待更新」，实测 **5 行本身已作废** —— 其中 3 行（§2.3 / §10.1 / §4.2）的内容**早在 P3/P4 就被修好了**，1 行（§3.1）的注记早被删了，1 行（§5.5）**从登记起就指错位置**（design.md 的 §5.5 从来没有内联 `[偏差]`，「脱敏机制完全不存在」出自审计文件而不是规格）。
   ⚠️ **更扎心的是：协调者自己在 P5 收口时写下的一行也是错的** —— `git blame` 显示那行「⏳ 仍未处理」出自 `e133a78`（P5 的收口提交），它把 P3/P4 已修的 3 项又列为「未处理」。
   ⇒ 三条规矩：① **写「待办清单」前逐条看现状**，不要照抄上一份清单；② 台账里的**计数与位置要用命令算**（`node scripts/ledger-counts.mjs`；数 `[偏差]` 要用**排除元提及**的 `grep -vE '^(40|145[0-9]|166[0-9]):'`，原样 grep 会多算 3 行）；③ **`design.md` 里指向已删文件（`web/`）的注记会整簇作废** —— 删一个目录要顺手 grep 它的路径。
4. **「判定值只能是那四个」的闸会挡住「这不是缺陷」的表述**（N26/`ledger-counts.mjs`）：R309 的结论是「R119 已实证、**无影响**，它是一条**约束**而不是缺陷」，但 `scripts/ledger-counts.mjs` 的 `VERDICTS` 只允许「已关闭 / 部分关闭 / 仍开放 / 文档过期」。
   ⇒ 处置：**判定值服从闸**（写「已关闭」），**在同行的说明里逐字写明它的含义是「已实证、无需改代码」而不是「修好了一个缺陷」**。⚠️ **不要**为了表达得更准去放宽闸 —— 那道闸的全部价值就是让口径漂移当场可见（它本次又当场抓到了我漏更的 §0）。
5. **计划里的事实断言也要被 agent 复核，而不是被 agent 服从**（R320/R321/R322/R323）：P6 的计划里协调者写了四条事实，**四条全被 agent 顶回来**：`@Inject(DataSource)` 的 token 形态说错了（默认数据源返回的是**类本身**、不是 `'DataSource'` 字符串）；§1.4/§12.5 **不是**内联 `[偏差]`（且 §12.5 有 2 处入站引用 ⇒ 不能删标题）；R313 的前提「四处正文已写 `[已实现]`」**只对一处成立**；`[偏差]` 的枚举命令少算了 3 行。
   ⇒ 与 P3 教训第 1 条同族：**裁决里凡出现「因为 X，所以 Y」，X 必须是实测的或逐字引用的**。「我验证过」与「我认为」在裁决里必须可区分。⇒ 派工时请**显式授权 agent 顶回计划的事实错误**（否则它只能服从，而服从会把错误固化进收口）。

### 切片 P7 门禁实测（收掉最后两条真缺陷，全部 `--force`、0 cached）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit            # ⚠️ 冲突：两个 agent 各自回填同一节 ⇒ 协调者保留双方
rm -rf packages/shared/dist                 # ✅ R378：`tsc` 只写不删 ⇒ 清掉第二契约的陈旧产物
pnpm exec turbo run build --force          # ✅ 10/10 ⇒ `ls packages/shared/dist/protocol` 不存在
pnpm exec turbo run test lint --force      # ✅ 29/29, 0 cached
timeout 1200 pnpm run ci                   # ✅ 六阶段全绿（CI_EXIT=0）
#  第 6 阶段现 **6** 条闸：8 / 8 / 5 / 6 / 3 / **21** passed（新增 shared/no-legacy-message-names.gate）
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 187 tests · 97.58%（不低于 P6 基线）
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · 零改动

pnpm exec turbo run build --force
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ⚠️ 第一轮：slice-07.2-hardening ❌ exit=1（R394 —— 新闸注册进 ci.sh 但不在 conformance 的 EXPECTED_GATES）
# ✅ 修好后 13/13：slice-11 **50**（硬底线不回归）· slice-07.2-rpc **65**（61 → +4）· deploy 104
#    · hardening **103** · boundary 82 · security 40 · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 269 · 05 29

# 顺序无关性（协调者独立复核）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc   # ✅ 池空 ZCARD=0 ⇒ 65 项
timeout 300 node tools/conformance/dist/run.js slice-11         # ✅ 池空 ⇒ 50 项
# 种子：robot RPC acquire 两个 → 一起 release ⇒ ZCARD=2
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc   # ✅ 池非空 ZCARD=2 ⇒ 65 项
docker compose logs api-gateway | grep -c 'Blocked outbound'    # ✅ 0
```

**关闭的项**：**B1**（`slice-07.2-rpc` 第 6 组判据换形态）· **B2**（删遗留第二契约 + 21 条防复活闸）· **R394**（新闸注册进 `ci.sh` + 同步 `EXPECTED_GATES`）。
⇒ **台账里不再有「代码相关」的真缺陷**；剩下的是**文档复审**（`design.md` 22 处 `[偏差]` + 18 处标题标记 + `doudizhu.md` 2 条）与产品向的 **N13**。

### 切片 P7 新增的通用教训

1. **「两份必须同步的清单」是本仓一类结构性风险**（R394）：`scripts/ci.sh` 的第 6 阶段闸清单（**产品**）与 `tools/conformance/src/slices/slice-07.2-hardening.ts` 的 `EXPECTED_GATES`（**判据**）是同一事实的两处表达 —— **加闸要同时改两处**。我只改了一处，门禁当场红：
   `❌ 探针负对照：真实接线 + 一个「每个过滤名都能找到同名文件」的合成解析器 ⇒ 不报违规：期望 0，实际 1`。
   根因是那条负对照的**合成解析器只覆盖 `EXPECTED_GATES` 里出现过的包** ⇒ 对它不认识的 `shared` 返回空数组 ⇒ 判「匹配不到文件」。
   ⚠️ **最有价值的一点**：这条负对照**是活的**（它抓到了真实的接线变化）。如果我当时为了换绿而**撤掉 `ci.sh` 那一行**，就同时失去「`missingExpected` 保护」与「负对照」两层 —— 那正是本仓「**假红逼人把判据改弱**」的教科书形态。⇒ 规矩：**遇到「加了产品配置就红」时，先判断红来自「判据不完整」还是「产品错了」，再决定改判据还是改产品**；能两处同步的就同步（更强），不要撤产品来迁就判据。
2. **删一个源码文件要顺手看三个地方**（R378/R290）：① **构建产物**（`tsc` **只写不删** ⇒ 删源码后 `dist/protocol/message.{js,d.ts,map}` 仍在，内容逐字是旧契约）；② **桶导出**（`shared/src/index.ts` 的 `export *`）；③ **为它开的例外**（本仓是 `vitest.config.ts` 的 `coverage.exclude` —— 它当年正是为这个文件加的，删了文件不删排除项就是「指空的死配置」）。⚠️ 这个文件还是「**同一文件同时被三处供着**」的例子：桶导出 + 覆盖率排除 + 只有它自己的测试在测它。
3. **「零消费者」这种断言必须自己重测，且要注意采样盲面**（R371）：计划给的两条 grep 各有三个盲面（`--include=*.ts` 漏 Vue 工程；只搜类型名不搜**模块路径**（桶导出/深路径 import 看不见）；只搜 `apps/` 而五个 `packages/*-service` 都依赖 `shared`）。agent 补了三条都零命中，结论不变 —— 但 P6 教训 5（「计划里的零命中是协调者测的」）这次**是有实际内容的**，不是套话。
4. **判别力自证的粒度要跟着「清单的长度」走**（R377）：只注入一个被禁名字，只能证明**那一条 pattern** 是活的；`new RegExp` 清单里的**死条目**会让「零命中」变成假绿。⇒ 本片对 **18 个**禁止名**逐个**注入各断言一次，并断言「每条坏输入**只**触发一条违规」（防「抓到的是另一条分支」的空测）。
5. **覆盖率读数要区分「分母里有没有它」**（R370）：计划猜「删掉纯类型文件 ⇒ 覆盖率**略升**」，实测**持平** —— 因为那个文件**本来就在 `coverage.exclude` 里**、从不在分母。⇒ 写覆盖率预期前先看配置：**「删了会升」与「删了不动」的分界是「它在不在分母里」**。⚠️ 真正的危险动作是「**只删排除项、不删文件**」（分母变大、读数下降）。
6. **写入判据的注入物要避开同一包内并发的 `lint`**（R374）：`turbo.json` 里 `test` 的 `dependsOn` 是同包 `build`、`lint` 是 `^build` ⇒ 同包 `lint`（`tsc --noEmit`）与 `test` **并发**，探针会被 tsc 读到。实测**点前缀文件不被 tsc 的 glob 收录** ⇒ 探针命名 `.zz-*.ts`，而扫描器**不过滤**点前缀（管辖面不缩小）。
7. **「数一个东西」的命令必须按形态写，不能按行号写**（P7 协调者自己踩的）：台账要登记「`design.md` 还剩多少处 `[偏差]` 注记」，P6 给的口径是 `grep … | grep -vE '^(40|145[0-9]|166[0-9]):'` —— **它把行号写死了**，而 `design.md` 每次编辑都会让行号漂移 ⇒ 同一个问题在三次测量中得出 **21 / 24 / 22** 三个数，每次都「看起来有依据」。
   ⇒ 正确口径：`grep -c '\[偏差\]' docs/design.md`（= **25** 全部提及）**减去 3 处非注记提及**（`:40` 图例 / 指向 `doudizhu.md` 的引用 / 文末收尾规则）= **22**。
   ⇒ 规矩：**凡「计数」类登记，口径里不得出现行号**；要排除就排除**形态**（图例行、跨文档引用、文末约定），并在命令旁逐条写明**排除了什么**。这与 P6 教训 3（台账自己会过期）同根因：**依赖易变坐标的登记，会在下一次编辑后静默失真**。

### 切片 P8 门禁实测（文档复审，**零代码影响 ⇒ 轻量门禁**）

```bash
cd /home/howe/pokergame
git diff --stat 17b8a68..HEAD         # ✅ **只**出现 docs/ 下三个文件 —— 本片的核心判据（R395）
pnpm exec turbo run test lint --force # ✅ 29 successful / 0 cached（逐批各跑一次，均绿）
node scripts/ledger-counts.mjs        # ✅ §0 与 §1.x 逐区一致（80 条：78 关闭 / 0 部分 / 2 仍开放）
grep -c '\[偏差\]' docs/design.md    # 25 → **3**，逐行核对后 **0 处真注记**
grep -c '^### .*\[待实现\]' docs/design.md     # 7 → 0
grep -c '^### .*\[部分实现\]' docs/design.md   # 11 → 6（每处都写明「缺哪条」）
grep -c '\[偏差\]' docs/games/doudizhu.md      # 34 → 32
```

**明确不跑**（R395）：`build --force` · `docker compose build/up` · 13 条 conformance —— 它们**不读 `docs/**`**，信息量为零，而代价是 ~10 分钟 + 一次脆弱的镜像重建。
⚠️ **但保留一条防伪**：若 `git diff --stat` 出现**任何**非 `docs/` 路径，该裁决作废、按标准门禁跑全套。

**本片处置**：**28 处**过期标记在 `design.md` 被删除或改写（14 内联 `[偏差]` 删 + 1 改写为 `[说明]` + 14 行内 `[待实现]`/`[部分实现]`）· **18 处小节标记**按逐条取证调整（**12 处**上调 `[已实现]` 并各补「依据 = 文件:行/裁决号」，**6 处**保持 `[部分实现]` 并写明缺哪条）· 附录 A.2 关闭 **A2/C17/E4** 三行 + 订正 **A3** 的过期计数 · `doudizhu.md` 删 C16/C17。
**新登记 N27**（`GameState.deck` 死字段：规格要求删、实现未删 —— P8 复审翻出的**唯一硬缺口**，按 R398 只登记不修代码）。

### 切片 P8 新增的通用教训

1. **「审计基准的注记」会**系统性**过期，而且过期的是**整个批次**，不是零星几处**：`design.md` 的那批内联 `[偏差]` 写于审计基准 `fafb36a`（2026-09-14），此后十几轮切片把它们描述的问题**逐条修掉了**，但**没有任何一轮回头改注记**。P8 实测：P6 之后剩 22 处真注记，**逐条取证后 21 处过期**（只有 1 处仍成立）。⇒ 规矩：**修掉一个偏差时，顺手 `grep` 一下 `design.md` 里描述它的那条注记** —— 一行 grep 换下一轮不必做一次全量复审。
2. **「按标记形态计数」会漏掉同源遗漏面**（P7 教训 7 的**第二次发作**）：P6/P7 用 `grep -c '\[偏差\]'` 数余量，得出结论「还剩 22 处」—— 而**同一批遗漏面里还有 14 处行内 `[待实现]`/`[部分实现]`**（例如「`findSmallestBeatingCards()` **`[部分实现]`**…只覆盖 5/14 型…**当前无人调用**」），**形态不同所以整个没被看见**。⇒ 数「还剩多少」之前，先问「**这个问题有几种写法**」，并对每种各数一遍；**计数口径要按语义写，不要只按一个字符串写**。
3. **口径里的坐标一旦写死就会静默失真**（P7 教训 7 的同族，P8 再现）：台账最初的余量口径写成 `grep … | grep -vE '^(40|145[0-9]|166[0-9]):'` —— **把行号写死了**。同一问题在三次测量里得出 **21 / 24 / 22** 三个数。⇒ **计数命令里不得出现行号**；要排除就排除**形态**（图例行 / 跨文档引用 / 文末约定），并逐条写明排除了什么。
4. **大纲（Heading）标记是「断言」，不是「标签」**：把 `[部分实现]` 改成 `[已实现]` 等于声称「这一节**每一条**都做完了」。P8 的判据是「**该节条款逐条枚举 → 每条都要有实现 + 测试覆盖**」，结果 18 处里 **12 处**能上调、**6 处**不能（各自缺哪一条都写进了节内）。⇒ **宁缺勿假**：一个保守的 `[部分实现]` + 一句「缺 X」比一个凑出来的 `[已实现]` 有价值得多（错误断言会误导下一轮的整体判断）。
5. **「规格要求」与「刻意不做」必须分开记，而「刻意不做」必须有**落盘的出处**：审计发现 §8.3 的 `MatchPredicate` 框架没实现 —— 但切片 7 的 **R53** 明确裁过「本片不实现 §8.3 谓词框架」。⚠️ 问题是 **R53 在 `design.md` 与台账里都 0 命中**（只活在切片 7 的计划文件里）⇒ 只看规格的人**必然**以为欠账。⇒ 规矩：**任何「本片不做某条规格」的裁决，必须在 `design.md` 对应小节留一句 + 在台账登记**，否则它等于「漏做」。
6. **计划里的「事实断言」会被 agent 顶回，而且**这是设计出来的**（P6 教训 5 的延续，P8 两批各顶回一次）**：P8 我（协调者）写的编辑清单里两处出错 —— ① 把 A.2 的 E4 行断言成「应写 `parseRule(结果)`」，而全仓**没有** `parseRule`（真实符号是 `parseHand`）；② 断言「删掉 doudizhu 的 C16/C17 ⇒ §14.2 的 `§11` 计数 18 → 16」，而 C16/C17 是**内联 blockquote、不在 §11 表里**（表内 P8 前后都是 18）。两次都是执行 agent **先实测、再跳过并汇报**。⇒ 派工时继续显式授权「**原文与清单不符就跳过并汇报**」；**照抄错误清单的代价是往文档里写进一个假事实**。
7. **「已处置」这种台账登记必须附**可机械复核的计数**（R401）**：我口算的处置细目（「14 处删除 / 1 处改写 / …」）与 `git show --numstat` 对不上账（被修改的行同时计入删与增）。⇒ 台账只写**能点数或能 grep 复核**的数据（例如「`grep -c` 从 25 降到 3」+「12 处上调 / 6 处保持」这种逐条可数的类别），**不写无法自证的合计数** —— 与 §5 第 6 条（`ledger-counts.mjs`）同族。

### 真浏览器验证（2026-09-17）—— 本仓**第一次**用真浏览器跑端到端

```bash
# 零新依赖：Playwright 缓存的 chromium + Node v24 内置 WebSocket 直连 CDP
CHROME=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
"$CHROME" --headless=new --disable-gpu --no-sandbox --remote-debugging-port=9222 \
          --user-data-dir=$(mktemp -d) http://localhost:5173/ &
# 然后 Node 连 /json 里的 webSocketDebuggerUrl，用 Runtime.evaluate 驱动 DOM
```

**第一次验证：失败，抓到两个阻塞缺陷**（`a5a0cb6` 修复）—— 详见台账 **N28/N29**：
- **N28**：真后端的**每一条** S→C 推送都被客户端拒收（`ProtocolError: $.type must be a string, got undefined`）；
- **N29**：客户端默认把 socket.io 指向 mock（3400），真后端反而要人工改配置（`dist/` 里也打进了它）。

**第二次验证：通过，但边界是「一次页面加载 = 一局」** —— 真浏览器**打完了整局**：叫抢 → 真实 `game.play` 被服务端接受（ack code 0）→ `v1→v50` →
`game.finished` + `game.settlement`（倍数 4、地主 +800 / 农民 −400）+ 结算面板渲染；四轮运行 `exceptionThrown` 与 `error` 级 console **计数全为 0**。
截图：`/tmp/p9-play.png`（牌桌，上一手=我打出的王炸）、`/tmp/p9-settlement.png`（结算）。

**另外登记 3 项未修**：**N30**（三处浏览器体验缺陷）· **N31**（`/api/rooms` 状态与实际对局不一致 + 房间堆积）· **N32**（**同一页面会话里第二局永久进不去** —— `onRoomMatched` 不清 store，上一局的 `currentVersion=50` 把新房间的 `v1` 快照按 M08 永久丢弃，
并触发 `game.reconnect` **重连风暴**；终局后服务端无任何终止码 ⇒ 无自愈入口；刷新页面即恢复。⚠️ 与 N30② 同族但**不是同一条**）。

### 真浏览器验证带来的通用教训（**本仓最贵的一类**）

1. **「对着 mock 能过」是一类**结构性**盲区**：`tools/mock-server` 发 `socket.emit(checked.type, checked)`
   （**body 带 `type`**），而真网关发 `client.emit(type, message)`（**body 不带 `type`**，`type` 在事件名上）
   ⇒ 客户端 `validateInbound` 要求 body 带 `type`，于是 **mock 过、真后端必挂**。
   而客户端的端到端测试与 conformance 都在**同一个 mock 形态**上写断言。
   ⇒ **规矩**：**mock 必须复刻真实现的线格式**（不只是逻辑）；每个「mock 专属」的宽容度都是一个潜在盲区。
   ⇒ 更强的规矩：**至少有一条判据跑在「真实现 + 真传输 + 真 UI」上** —— 本仓的 13 条 conformance 全是
   **协议级**（自己拼 WS 帧），因此**整整一层浏览器路径长期无人覆盖**。
2. **CI 里没有的东西，就等于没有验证**：B1/B2 能活到今天，唯一原因是**没有浏览器在 CI 里**。
   conformance 覆盖了后端协议、单测覆盖了客户端逻辑（对 mock），但「前端 ↔ 真后端」这条**接缝**是空的。
   ⇒ 这类接缝要靠**真浏览器/真端到端**判据守，且必须能在门禁里跑（哪怕只是一条最小路径）。
3. **默认配置会变成事实标准**：`VITE_WS_ENDPOINT` 的 fallback 写死 mock 端口，连 `dist/` 都打进去了
   ⇒ 「默认路径连不上真后端」长期成立，而**没人会去读那句注释**（注释写的是「联调真实后端时把它注释掉」）。
   ⇒ 默认值应当是**生产/真实路径**，mock 走**显式 opt-in**（本片改成 `.env.mock` + `.local`）。
4. **验证要走到「用户能看见的那一步」才算数**：我先前说「可以体验了」，依据是「5173 在跑 + `/api` 代理通 +
   socket.io 握手 200」—— 这三条**全都成立**，但**游戏玩不了**。⇒ **接缝类断言不许用「各段的证据」外推**：
   握手成功 ≠ 消息被处理；进程在跑 ≠ 功能可用（与 P4 教训「DI 通了 ≠ 端口在听」同族，这是它的**第四次**发作）。

### 切片 P9 门禁实测（真浏览器门禁 + N32/N30②，全部 `--force`、0 cached）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force          # ✅ 10/10（conformance 前必跑：robot-service 是 bind-mount）
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（client 169 passed(+2 skipped)）
pnpm run ci                                # ✅ 六阶段全绿；第 6 阶段 8/8/5/6/3/21 passed
cd apps/client && pnpm lint && cd ../..    # ✅ vue-tsc 干净

# ── 本片新增的接缝判据（与 conformance 同级的**独立显式入口**，R415）──────────
node scripts/browser-e2e.mjs               # ✅ **16/16**（gate = 最小路径 + N32 受控复现）
node scripts/browser-e2e.mjs --scenario full   # ✅ **20/20**（真打完一局 → 返回大厅 → 第二局）

# ── conformance 13/13（独占跑；每条套 timeout 300）────────────────────────
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13：slice-11 50 · rpc 65 · deploy 104 · hardening 103 · boundary 82 · security 40
#    · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 244 · 05 29

node scripts/ledger-counts.mjs             # ✅ §0 与 §1.x 逐区一致（85：82/1/2/0）
```

**修前 RED（N32，两条路径各跑一次，机制逐帧一致）**：

```
# 受控复现（注入「上一局 v50 已结束」形态后匹配）—— 判据 2 组 5 项全红
C→S game.reconnect {"lastVersion":50}            × 9 条
notice「reconnect_ack 快照 version 1 回退于已应用的 50；按 M08 主动重连，不做本地修复」
# 真打完一局（v56 ended → 返回大厅 → 随机匹配 → 新房间 HGC1JS）—— 判据 2′ 组 5 项全红
C→S game.reconnect {"lastVersion":56}            × 7 条
S→C {"code":13010,"message":"Reconnect record has expired"}  ⇒ 被踢回大厅，第二局永远进不去
```

**修后**：`rollbackEvents === 0`、`game.reconnect` 帧数 **0**、第二局进入的是**新房间**（`v1`、17 张牌、DOM 渲染 17 张）。

**本片处置**：**N32 关闭**（`30bc636`）· **N30 转部分关闭**（②，R419）· **N31 定位取证**（R421，未修）·
`design.md` **v4.3**（§6.2 + §12.3 M08 补「比较集限于同一局」，**只做澄清不改语义**）。

### 切片 P9 新增的通用教训（前三条是**本仓最贵那一类**的机械化）

1. **「接缝判据」不能由「各段的证据」拼出来 —— 但可以机械化成一个真浏览器断言**。
   「握手成功 ≠ 消息被处理」这条教训此前**只能靠人工**执行一次。本片把它变成
   `node scripts/browser-e2e.mjs`：判据取「**用户能看见的那一步**」——
   `game.deal` 被 store 接受（`view.roomCode === roomCode` 且 `hand.length === 17`）**且 DOM 真的渲染出 17 张牌**。
   ⇒ 规矩：**一条接缝教训落盘时，要问「它能不能变成一条命令」**；不能，它下个 session 就会被忘掉。
2. **受控复现必须与真路径对照，否则你测的可能是别的东西**（本片真金白银撞到）：
   第一版 N32 受控复现写成「先匹配 → 返回大厅 → 注入 v50 → 再匹配」，
   实测发现**服务端把同一个 `roomCode` 又发了一次**（玩家仍坐在那局里）⇒ 那测的是「同一局的重复匹配」，
   **不是**跨局边界，判据**假绿**。改成「注入后立刻匹配」才命中机制。
   ⇒ **处置**：受控复现必须配一条**真路径对照**（`--scenario full`），两者结论一致才算数。
3. **探针自己会「静默假绿」，形态与产品缺陷一样隐蔽**：第一版 `newPageSession` 没有清 `localStorage`，
   于是第二次 `Page.navigate` 后 `auth.hydrate()` 直接把页面恢复成大厅 —— **「注册」这一步被整个跳过**
   （连 `.login__field input` 都不存在），而断言**照样通过**。⇒ 已加两条硬断言：
   **加载后必须停在登录页** + **`localStorage` 必须为空**。
   ⇒ 规矩：**凡是「先做 X 再断言 Y」的探针，都要断言 X 真的发生过**（与 R115「先证明探针有效」同族）。
4. **沙箱里跑真浏览器有四条硬前提（少一条就 core dump，实测原文 `Trace/breakpoint trap (core dumped)`）**：
   `HOME=<可写临时目录>`（否则 crashpad 写 `~/.config` 被拒）+ `--disable-dev-shm-usage`（`/dev/shm` 不可写）
   + `--disable-crash-reporter` + `--no-sandbox`。⚠️ 另外两个**进程管理**的坑：
   `pkill -f chrome-linux64/chrome` 会**匹配到自己的命令行**（把当前 shell 杀掉，表现为「无输出 + SIGTERM」）——
   用 `pkill -x chrome`；`pnpm dev` 要用 `detached: true` 建进程组、按**组**回收，否则 5173 被残留的 vite 占着。
5. **「同一个 `roomCode`」与「新一局」是两个不同的东西**（第 2 条的推论，也是 N32 的边界）：
   服务端的「新局」= **新房间号**；客户端判「换局」必须看 `roomCode` **变了没有**，而不是看「收到了 `room.matched`」。
   后者会把**重复送达**误判成换局并清掉进行中的对局 ⇒ 复位必须带幂等守卫，且配一条**正对照**。
6. **`grep` 出来的「调用了没有」比「看起来该被调用」可靠**：N31 的根因只用**一条命令**就定位
   （`grep -rn "updateStatus(" packages/*/src apps/*/src tools/` 只有定义 + `'cancelled'` 一处调用）——
   而它挂在那里被「只观察未深挖」了两轮。⇒ **登记一条「未深挖」的偏差时，先把能一条命令查清的部分查掉。**

### 切片 P3 门禁实测（工程收口，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    （**本片零前端改动**；`apps/` 的 diff 为空）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null   # 池静默化（R243 之后已非必要，保留作保险）
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 46 项（44 → +2：R250 重写）
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 73 项（60 → +13：N9 第 10 步 + N15 换形态）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 55 项（28 → +27：N12/N14 第 ④ 步）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（房间数参与计数，只看尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
# ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'                        # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0

# E7 的容器级验收（**只断言配置项不够** —— 那只是改了个字面量）
docker compose restart user-service && sleep 18 && docker compose ps user-service --format '{{.Status}}'   # ✅ healthy
docker compose exec -T mysql mysql -uroot -proot -N -e "SHOW COLUMNS FROM fight_the_landlord.users;" | wc -l  # ✅ 7
docker compose exec -T mysql mysql -uroot -proot -N -e "SELECT id,name FROM fight_the_landlord.migrations;"   # ✅ InitialUsers…

# R243 顺序无关性（**门禁的一部分**）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 池空 ⇒ 46 项
# 种子：经 robot RPC acquire 两个再 release ⇒ 池里 2 个空闲成员，然后再跑
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 池非空（ZCARD=2）⇒ 46 项

# N21 的**在线**实证（协调者，真实栈）—— 这是本条存在的全部理由
docker compose exec -T redis redis-cli --scan --pattern 'bot:bound:*'  # 观测「绑定中」的反向索引
docker compose logs robot-service | grep -i reclaim
# ⇒ [RobotPool] Reclaimed bound bot bot-6ffc78dbc (the room S11IDEM referenced by the view is gone; boundAt age=58998ms)
#    （`release` 丢失 + 房间已消失 ⇒ 回收；该机器人在旧实现下**结构上不可能被发现**：池是空闲集合、它不在池里）
```

**关闭的偏差**：**E2 / E6 / E7 / N9 / N12 / N14 / N15（后端半边）/ N21** + **R243**（判据重写）。
**对账表 §0 现为 75 条：74 已关闭 / 0 部分关闭 / 1 仍开放** —— **唯一仍开放的是 N13**
（登录/注册/刷新无 IP 维度限流，登记时就写明属 §16 风控 roadmap，不是本 MVP 的安全边界）。

### 切片 P3 新增的通用教训（六条；前两条是**协调者自己**的错）

1. **我（协调者）在同一片里写错了两条裁决，两次都是 agent 用「规格原文 / 修前实测」把我顶回来的。**
   - **R247**：我写「`boundAt` 超过 10 分钟**或**房间不存在 ⇒ 回收」。§9.6 逐字是「回收 `idleSince` 超过 10 分钟
     **_且_** `roomCode` 指向的房间已不存在的机器人」（**合取**），紧接着「**对局中机器人不得被回收**」。
     我的**析取**会在**一局打得久**（>10 分钟，完全正常）时把**正在对局**的机器人回收掉。
   - **R243**：我把那条池等式的失效机制解释成「池非空 ⇒ 修前红」。实测（agent 在**修前 dist** 上把两种前置
     状态各跑一次 + 我独立复核）：池非空时修前**也是绿的**。真机制是等式两边**同一本账**（复用 k + 新建 2−k），
     它实际断言的是「**我这一局的时间窗内没有第三方动过池**」。
   ⇒ **规矩**：裁决里凡出现「因为 X，所以 Y 会红/会错」，**X 必须是实测的或逐字引用的规格原文**，
   不能是听起来合理的机制。「我验证过」与「我认为」在裁决里必须**可区分**。
   ⇒ **推论**：**修前 RED 的取法本身就是判据的一部分** —— 要么在**修前**代码上实跑（而不是想当然假设它会红），
   要么用**受控复现**复现同一机制（见下面第 3 条）。
2. **相对量判据在「多运行共享同一 Redis」的仓库里不可能稳定**（R243/R250/R253）。
   那条等式、以及 `slice-11` 第 6 组仍在的「两次 acquire 之间 `ZCARD` 不净增」，都是**相对量**：
   只要窗口内有第三方写入（`releaseRobots()` 是 `void` 异步、`reclaimIdle()` 每 60s、跨运行的晚到 release），
   它们就假红；而它们对「池退化成 0 / 绝对容量丢失」**完全免疫**（旧的真实缺陷正是这样藏了很久）。
   ⇒ **判据要钉绝对性质**（「每个成员都必须有记录」「两个机器人都回到池里」），不要钉差值。
   ⇒ 本片还实测到 **conformance 没有独占**（robot-service 日志里有非本次运行的补位局与 release 交错落地，
   把 `ZCARD` 从 2 抬到 4）—— **这就是相对量判据的假红来源**。门禁必须独占跑。
3. **「判别力自证」的载体选错，自证就是空测**（R282 + R229 同族）。
   要证明「探针看得见 `connect_error`」，自然的写法是「连一个不存在的端口」—— **在本机它是空测**：
   `127.0.0.1` 未监听端口的 SYN 被**丢弃**（不是 RST）⇒ 2.5 秒内**零事件**（连接挂住）。
   实测改用**故意用错的 socket.io path**（`/definitely-not-socketio/`）⇒ 立刻 `connect_error: websocket error`，
   且该路径**不经过** socket.io 服务器 ⇒ 既不占 §5.4 的连接名额、也不污染 R147 的限流桶。
   ⇒ 选自证载体前先量它**在本机**的行为；「制造一个错误」比「制造一个不存在的服务」可靠得多。
4. **判据形态会随实现变，改形态时要把「更严」证明出来**（R265/R282）。
   N15 把限额挪到 `allowRequest` 后，原来的合成布尔 `kicked || error` **必红**；新形态把两件事拆成
   **两个独立观测通道**（`sawConnectError` 与 `!sawConnect`）+ 一条**正对照**（前 5 条都观测到 `connect`），
   因此比原来**更严**。⚠️ 只有 polling 传输能拿到握手 403 的 `description`；**websocket 传输拿不到错误文本**
   （engine.io-client 只报泛化的 `TransportError('websocket error')`）⇒ **任何依赖错误文本的 WS 判据在 ws 传输上不可能成立**。
5. **假 Redis 的宽容度再一次咬人（R212 第 N 次发作）**：`room-service/test/helpers/fake-redis.ts` 的 `hset`
   原先只支持 `(key, field, value)`；生产代码一旦用**对象形态** `HSET`（N9 之后就是这么写的），
   替身会把 `[object Object]` 写成字段值**却让断言全绿**。已改成两种形态都支持并返回**新增**字段数。
   ⇒ 老规矩：**写替身时先问「真实 Redis 在这里会怎样」**。
6. **判据的「绝对不变式」要配一条「它已该为空」的自查**（R242/R250）：把 `NOT_YET_MIGRATED` 这类 xfail
   清单写进闸里，「迁移完成」就变成一个人工动作；本片的处置是**正向断言 + 反向扫描**，清单为空是**结果**而非状态。

### 切片 P3 新增的环境事实与可用技法（提升今后判据的强度）

- **`api-gateway` 的 `reflect-metadata` 不在它的依赖里**（`package.json` 无、`main.ts` 也不 import）——
  它能跑**只因为** `@nestjs/common/index.js` 内部 `require('reflect-metadata')`。
  任何只 import**子路径**（如 `@nestjs/common/decorators`）的入口都会丢掉 polyfill。
  ⚠️ 而**单测里 `import 'reflect-metadata'` 会直接 `Failed to load url`**（从 api-gateway 解析不到）
  ⇒ 写 api-gateway 的单测时不要 import 它。（补依赖会动 `pnpm-lock.yaml`，本片**未补**。）
- **`Test.createTestingModule` + 手补 `Reflect.defineMetadata('design:paramtypes', [...], Klass)` +
  `createNestApplication()` + `listen(0)` 在 vitest/esbuild 下真的可用。**
  本仓此前只记了「esbuild 不发 paramtypes ⇒ 只能手搭 Express」。这条让 P3 的 N12 用**真 Nest 应用**、
  N15 用**真 Nest 应用 + 真 socket.io 客户端端到端**——比手搭脚手架强得多，**优先用它**。
  （`listen(0)` 让内核分配端口，不抢常驻端口。）
- **`@WebSocketGateway` 的 `allowRequest` 只能给模块级闭包**：装饰器求值期**没有实例**，
  箭头函数里的 `this` 是**模块作用域**而不是实例。落地手法：实例在构造时登记进**模块级槽位**、
  闭包只做转发，**未登记即 fail-closed**。
- **`bot:{botId}` 没有 TTL**（`TTL = -1`，持久），`bot:pool:*` 也没有；`bot:room:*` 与 `bot:bound:*` 是 3600s。
  ⇒ 排查「池里有成员但记录没了」时**不要**先假设是过期 —— 记录不是被 TTL 清掉的（实测过）。

### 已知环境事实（新 session 必读）

> **切片 P24（文档收口）新增的环境事实两条 —— 动 `docs/**` 的历史声明之前必读**：
> 1. ⚠️ **`design.md` 附录 A.2 的「位置」列没有单一快照基准**（R614 实测）：表的**主体 37 行写于 `3da457f`**
>    （v4.0 文档合并，2026-09-13 **10:07**），而**审计基准是 `fafb36a`**（同日 **19:26**，判定执行于 09-14），
>    **相隔 99 个 commit**；且行集合**本身长过**（`3da457f` **37** → `a4bf89a` 50 → `73c6c9a` 49 → `6d737d5` 52 → `8f15ba8` **53**），
>    后追加的 16 行（`S8`/`C15–C28`/`E9`/`E10`）还沿用**更早**审计稿的行号（`C13`:75、`C25`:66 对应 `895f5d8`）。
>    ⇒ **任何「A.2 描述的是审计基准那一版的代码」的推论都是错的**；定位当前实现**只能 `grep` 符号名**。
> 2. ✅ **`git show <sha>:<path>` 是只读取证的**标准手法，**不碰工作树**（本片两个只读 agent 都只用它 + `grep`）。
>    判「某条历史声明是否从来不准」的固定动作：① `git log -S"<短语>" -- <file>` 找它**写于哪个 commit**；
>    ② 逐版本**数行集合**（`git show <sha>:<file> | sed -n '/<区间>/p' | grep -c …`）；
>    ③ **拿那一版**去证。⚠️ 直接拿当前的「审计基准」去证，会得到一类**假结论**（「表写错了」而真相是「表写得更早」）。
>
> **切片 P10（uni-app 迁移）新增的环境事实 —— 动 `apps/client` 之前必读九条**（每条都是实测，违反会浪费一轮）：
> 1. **依赖只能按 `vue3` dist-tag 的显式版本装**：`@dcloudio/uni-app` 的 `latest` 是 **Vue 2 线**（`2.0.2-…`）；
>    Vue 3 线在 `dist-tags.vue3`（现为 `3.0.0-alpha-5020620260914001`）。`pnpm add @dcloudio/uni-app` **必装错**。
> 2. **Vite 被钉在 `5.2.8`**（`@dcloudio/vite-plugin-uni` 的 peer 是**精确** `vite: "5.2.8"`，用户裁决 R431 接受降级）。
>    改这个版本会同时改 `apps/client/vite.config.ts` 上长着的 dev server / 代理 / 探针。
> 3. **`import uni from '@dcloudio/vite-plugin-uni'` 拿到的不是函数**（CJS 双 default 互操作）⇒ 必须
>    `const uni = (uniModule.default ?? uniModule)`，否则 `uni is not a function`。
> 4. **uni-app 内部把 `resolve.preserveSymlinks` 设成 `true`**（`uni-cli-shared/dist/resolve.js:24`、
>    `vite-plugin-uni/dist/config/resolve.js:64`）⇒ pnpm 符号链接布局下**深层裸 import 解析失败**
>    （`Rollup failed to resolve import "socket.io-parser"`）。修法：在 `uni()` **之后**追加一个
>    `config: () => ({ resolve: { preserveSymlinks: false } })` 插件（plugin `config` 后合并者胜）。
> 5. **monorepo 下微信小程序端还要再修一次路径**：`preserveSymlinks:false` 让 Rollup 看到
>    `<repo>/node_modules/.pnpm/…` 的真实路径，而 uni 的 `normalizeNodeModules()` 每个 `node_modules`
>    只吃一层 `../` ⇒ 多出来的相对段违反 Rollup 的命名约束。`apps/client/vite.config.ts` 的
>    `ftl-miniprogram-path-clamp` 插件（`configResolved` 里 clamp `normalizeMiniProgramFilename`）是现修法。
> 6. **三端产物目录不对称**：`dist/build/h5` · `dist/build/mp-weixin` · **`dist/build/app`**（不是 `app-plus`）。
> 7. ⚠️ **H5 发行构建默认摇树**：uni 只注入**空的** `window.uni = {}`，真正可用的是编译器把
>    **`uni.xxx(…)` 的直接成员调用**改写成 `@dcloudio/uni-h5` 的 import ⇒ **写成 `const api = uni` 会
>    「dev 正常、发行版静默失效」**（存储不落地、`reLaunch` 不跳页）。`test/uni-api-access.test.ts` 是闸。
> 8. ⚠️ **探针默认跑 dev，抓不到第 7 条**：本片因此加了一条**发行产物级**探针（R449 补④）：
>    `pnpm --filter @fight-the-landlord/client build:h5 && pnpm --filter @fight-the-landlord/client preview`
>    然后 `node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server`（`preview.proxy` 与 dev 同源）。
> 9. ⚠️ **`pnpm dev` 的进程必须是新的**：本机残留过**迁移前**启动的 `sh -c vite`（内存里是 Vite 6），
>    它对 `vite.config.ts` 的改动会「热重启」⇒ **看起来是 uni-app 在跑、其实混着一份旧 Vite**。
>    跑探针前先 `ss -ltnp | grep 5173` + `pgrep -af vite` 确认，杀旧进程组用 `kill -TERM -<pgid>`；
>    **不要** `pkill -f "vite"`（本仓记过的自杀式命令，P15 已踩过一次，P10 又踩了一次）。
>
> **切片 P21（`drain` 时序与 pong 归属）新增的环境事实一条**：
> ⚠️ **自定义 engine.io 传输有两处**时序/职责**陷阱，且症状都很晚才炸**：
> ① **`drain` 必须延到下一个 tick**（浏览器传输原文：`// fake drain` / `// defer to next tick to allow
> Socket to clear writeBuffer`）—— 因为 `Socket.flush()` 是「先 `transport.send()`、后 `_prevBufferLen = n`」，
> 同步 emit `drain` ⇒ `_onDrain()` 用 0 清缓冲 ⇒ 无限递归（`RangeError: Maximum call stack size exceeded`）。
> ② **pong 归 engine 的 `Socket`**（`case "ping": _sendPacket("pong")`），传输层只透传；
> 若传输层也回一帧、又「去重」掉 engine 那帧 ⇒ 服务端每个 ping 收两帧、且**正主的 pong 没上线**（超时踢线）。
> 判据：`apps/client/test/mp-transport-engine-contract.test.ts`（真 engine.io `Socket` 驱动 + 两条负对照）。
>
> **切片 P20（engine.io 传输契约）新增的环境事实一条**：
> ⚠️ **自定义 engine.io 传输必须自己补齐基类契约面**：`opts` / `query` / `socket` / `supportsBinary`
> 四个字段，以及 `close/name/pause/removeAllListeners/send/writable` 这套成员
> （`grep -oE "this\.transport\.[a-zA-Z_]+" engine.io-client/build/esm/socket.js | sort -u` 就是权威清单）。
> 我们的小程序传输是**独立类**（没继承 `Transport`）⇒ 容易只实现「收发 + 事件」而漏掉**公开字段**，
> 症状是**连接已建立、服务端也回了包，却在握手最后一步崩**（`undefined.sid = …`）。
> 判据：`apps/client/test/mp-transport-engine-contract.test.ts`（**真 engine.io-client `Socket`** 驱动 + 负对照）。
>
> **切片 P19（小程序端 `require("url")` 崩溃）新增的环境事实两条**：
> 1. ⚠️ **`src/**` 里禁止 `typeof import.meta` 与 `import.meta.url`**：它们会让打包器把 `import.meta` 实体化，
>    产物里生成 `{ url: typeof document === 'undefined' ? require(<Node url>).pathToFileURL(__filename).href : … }`；
>    **微信小程序 service 没有 `document`** ⇒ 必走该分支 ⇒ `module 'url.js' is not defined` ⇒
>    `app.js` 模块求值中断（连带的 `Page "…" has not been registered yet` 是**同一个根因**，别去查页面注册）。
>    正确写法：`import.meta.env.VITE_X` / `import.meta.env?.[key]`（构建期替换成字面量）。
>    闸：`apps/client/test/import-meta-guard.gate.test.ts`（源码级）＋ `scripts/build-mp-weixin.mjs`（**产物级**，
>    构建成功后自动扫 `require("url")`/`pathToFileURL` ⇒ 命中就非零退出）。
> 2. ✅ **客户端侧已不再对注释盲（P25/R572 起）；跨包侧仍未**。原状：`test/source-boundary.test.ts` 的
>    扫描**不剥注释** ⇒ 注释里引用真实写法会被当成**真实依赖**（P19 实测：注释里写 `require("url")`
>    ⇒ 该闸报第 4 个裸依赖 `url`），于是「解释得越清楚、闸越红」，第三次撞到时只能删掉解释。
>    **现状**：客户端 7 条违规断言一律读剥注释视图（`helpers/source-scan.ts` 是**唯一实现**），
>    存在性断言仍读原始文本（R622）。**跨包 4 个包仍有 5 处副本**（台账 **N46**，其中 2 处没有 `:` 守卫）
>    ⇒ 在 `packages/*/test` 里写扫描器时**仍要**遵守旧纪律（注释里别逐字写 `require("...")`，
>    需要引用时用不含引号的写法，如 `require(<Node 的 url 模块>)`）。
>
> **切片 P18（测试环境 DI 元数据）新增的环境事实两条**：
> 1. **测试环境现在会发出 `emitDecoratorMetadata`**：`scripts/vitest-plugins/emit-decorator-metadata.ts`
>    （全仓唯一一份）+ 5 个包（api-gateway/game-service/room-service/robot-service/user-service）的
>    `vitest.config.ts` 里 `setupFiles: ['reflect-metadata']`。
>    ⚠️ **`reflect-metadata` 必须先于被装饰的类求值**，否则编译出的 `__metadata` 助手会**静默 no-op**
>    （元数据又变 `undefined`、而测试可能仍然绿）。
> 2. **不要再写 `Reflect.defineMetadata('design:paramtypes', …)` 垫片**：有机械闸
>    `packages/api-gateway/test/no-di-metadata-shim.gate.test.ts` 拦（剥注释扫描 + 判别力自证）；
>    正对照在 `packages/game-service/test/di-metadata.positive-control.test.ts`。
>    测试文件里的 `import 'reflect-metadata'` 现在是**冗余但无害**（`setupFiles` 已保证），不必删。
>
> **切片 P17（小程序端 REST）新增的环境事实三条**：
> 1. **小程序运行时没有全局 `fetch`**（只有 `wx.request`/`uni.request`）；**产物里也不会有 fetch 的 polyfill**
>    （实测 `common/vendor.js` 的 polyfill 计数 = 0）。⇒ 任何**浏览器 API**（`fetch`/`XMLHttpRequest`/`Blob`/`FileReader`）
>    在小程序端都必须先过适配器：socket 走 `src/net/mp-transport.ts`，REST 走 `src/net/http.ts`。
>    **判据不要写「全产物 grep `fetch(` = 0」** —— `net/http.js` 里保留的 fetch 分支是**运行期平台分支**（mp 上不可达）；
>    真正的防线是**源码级机械闸**（`src/**` 只有 `net/http.ts` 一处豁免）。
> 2. **小程序端没有「同源」概念**：`apiBase` 的相对路径与「同源回退」都不成立 ⇒
>    构建时必须给**绝对地址**。用 `node scripts/build-mp-weixin.mjs <host:port> [--dev]`
>    （同一个参数同时导出 `VITE_API_BASE=http://<host:port>/api` 与 `VITE_WS_ENDPOINT=http://<host:port>`）；
>    只用开发者工具时 host 用 `localhost`，**真机必须用局域网 IP**。
> 3. **`uni.request` 与 `fetch` 的失败语义不同**：`uni.request` 的 `fail` 是回调（我们转成 `TransportFailureError` ⇒
>    `rest.ts` 落成既有信封 `10007`）；`fetch` 是**拒绝的 Promise**（H5 上一字未改、继续上抛）。
>    这处不对称是**刻意**的（H5 路径被探针压着），不要「顺手对齐」。
>
> **切片 P16（`test/**` 类型闸）新增的环境事实三条**：
> 1. **每个含 `test/` 的包都有 `tsconfig.test.json`，`lint` 是双 tsc**
>    （`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`）。**不要「简化」成单遍** ——
>    那样会丢掉一把尺子：src 要 NodeNext（构建语义），test 要 Bundler（vitest 语义）。
> 2. **测试配置必须用 vitest 的真实解析语义**（`module: ESNext` + `moduleResolution: Bundler`）。
>    照抄包的 `NodeNext` 会产出 7 处 `TS1470`（`import.meta`）+ 7 处 `TS2835`（要求显式 `.js` 后缀）的**纯噪音**，
>    那不是缺陷 —— 而按 Bundler 量反而多暴露了 api-gateway 的一批真实 `TS2345`（替身与真实接口不匹配）。
> 3. **`@types/*` 在 pnpm 隔离布局下不会「顺带」可见**：`game-service` 缺 `@types/express` 时，
>    根 `node_modules/@types/` 里**没有**它（只有 `.pnpm/@types+express@…`），表现为
>    `TS7016` + 一串派生 `TS7006`（回调形参隐式 any）。补依赖的命令仍与 P10 同款：
>    `pnpm add -D --config.frozen-lockfile=false --filter <pkg> @types/express@^4.17.0`。
>
> 另：**「每段门禁绿」在 uni-app 下必须逐端**（R441 补③）—— 只跑 `build:h5` 会漏掉
> `<component :is>` 这类在小程序端**编不过**的写法（Task 1 就是这样漏的）。

- **真浏览器探针**（切片 P9 起）：`pnpm run e2e:browser`（= `node scripts/browser-e2e.mjs`）。
  **零新依赖** —— Playwright 缓存的 chromium + Node v24 内置 `WebSocket` 直连 CDP（`--cdp-port 9333`）。
  前置：**8 个容器在跑**；dev server（默认 `http://localhost:5173/`）不在跑时探针会**自己拉起**并在退出时按进程组回收。
  ⚠️ **它要经 5173 → 3000 打真网关 ⇒ 与 conformance 同属「独占纪律」的适用范围**（网关按 IP 计并发 WS 连接，上限 5）。
  场景：`--scenario gate`（默认：最小路径 + N32 受控复现，`--scenario full` 加「真打完一局再开第二局」，
  单游戏 ~47s + 每次匹配 ~32s）。失败时自动打印**帧时间线**（`room.matched`/`game.deal`/`game.reconnect`/`13010`
  + store 的 page/version/hand/rollback 变化）；`--trace` 实时打印，`--keep-open` 保留浏览器与截图。
  ⚠️ **不挂 `turbo run test`、也不进 `scripts/ci.sh` 的六阶段**（R415）—— 与 `tools/conformance` 同级的独立显式入口，
  理由与它逐字相同：需要容器/服务在跑，挂进去会让无容器环境假红；而 §13.4 的六阶段是**规格逐字**。
  ⚠️ 本机**沙箱**下的 chromium 启动参数是硬要求（少一条就 `core dumped`）：
  `HOME=<可写临时目录>` + `--disable-dev-shm-usage` + `--disable-crash-reporter` + `--no-sandbox`。

- **`docker compose build` 若在解析 `node:20-slim` 时报 EOF / i/o timeout，是本机镜像源挂了，不是仓库的问题。**
  实测 `/etc/docker/daemon.json` 里配的三个 `registry-mirrors`（ustc / 163 / baidubce）**全部不可达**，
  而上游 `registry-1.docker.io` 经代理是通的（`/v2/` 返回健康的 401）。BuildKit 在镜像源失败后
  **不会**回退到上游，因此 `docker compose build` 直接失败。**解决办法：用经典构建器**，它会回退到上游：

  ```bash
  DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
  ```

  （不要为此去改 `daemon.json` 并重启 docker —— 那是系统级改动，经典构建器已足够。）
- **8 个 Docker 容器需要运行**；后端测试依赖它们（曾全部停止导致假失败）。
  跑 conformance 前镜像必须是当前代码：`DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`。
  ⚠️ **（2026-09-23 更新）robot-service 的宿主 dist 挂载已整条删除** ⇒ 五个服务一律只吃镜像。
  在那之前，那条挂载让 robot-service 对「重建镜像」免疫、容器只跑宿主 `dist/`，于是要额外记一条
  「跑 conformance 前先在主检出 `pnpm exec turbo run build --force`」的纪律（`slice-07.2-P1` 踩过：
  四个服务里只有 robot 的直连断言返回 200 而不是 401，症状是**只有某一个服务「不听话」**，
  而镜像里明明有新代码）。⇒ 现在这类症状只可能来自「忘了重建镜像」，处置是
  `docker compose build <svc> && docker compose up -d <svc>`（无宿主 dist 参与，不会再有版本偏斜）。
  ⚠️ **停止这 5 个应用容器会让 3000-3003 空出来但服务不可用**；`docker compose stop` 后务必
  `docker compose up -d` 恢复，否则后端的 `match.service.test` 会假失败。
- **`docker compose build` 此前在本仓库必然失败**，由切片 5 修复（commit `1f38dba`）。三处原因，
  改动 Dockerfile / 根构建配置时**不要退回去**：
  1. 五个 `Dockerfile.*` 必须 `COPY packages/protocol`（每个服务与 `shared` 都 import 它）
     并按 `protocol → shared → <service>` 顺序 `pnpm --filter ... build`；
  2. 必须 `COPY tsconfig.base.json`（每个 `tsconfig.json` 都 extends 它；缺了它 tsc 退回
     target ES5，在 vitest 的 `.d.ts` 上报 `TS18028: Private identifiers ...`）；
  3. 必须有 `.dockerignore`（否则 `COPY packages/*` 会把宿主的 `node_modules` 与 `dist` 带进镜像）。
- **网关有「两个验签点」**（切片 6 评审查出的 Critical）：HTTP 中间件 `jwt.middleware.ts`
  与 WS 握手 `gateway/proxy.gateway.ts` 的 `verifyClient()`。任何「验签之后要额外做的事」
  （`session:{jti}` 白名单、`typ === 'access'`、限流、脱敏）**必须在两处都做**；
  只改一处 = 门开着，而**单侧测试测不出来**（HTTP 全绿、WS 可绕过）。
- **`tools/conformance` 刻意不挂 `turbo run test`**（它需要 3000-3003 的服务在跑，挂进去会让
  无容器环境假红）。由协调者在每个切片的门禁里显式运行：
  `pnpm --filter @fight-the-landlord/conformance build && pnpm --filter @fight-the-landlord/conformance conformance:slice-05`
- **`turbo run test lint --force` 在「跨包新增导出 + 主检出 dist 过期」时会假红**（切片 7.2 实测，R154）：
  `turbo.json` 的 `lint` 任务此前**没有** `dependsOn: ["^build"]`（`test` 有），于是 `robot-service:lint` 的 `tsc --noEmit`
  会先于 `shared:build` 跑、读到**过期的** `packages/shared/dist/index.d.ts` ⇒ `TS2305: … has no exported member 'createXxx'`
  （外加由它派生的 `TS7006` implicit any）。`dist/` 是 gitignore 的 ⇒ **主检出里只有跑过 build 才是新的**。
  **本片已修**（`lint` 补 `^build`），但**跑门禁前先 `pnpm exec turbo run build --force` 仍是双保险**。
  ⚠️ 副作用：`turbo run test lint` 的任务总数会比 29 略多（lint 现在也会构建它的依赖），**那不是回归**。
- **WS 相关的 conformance 切片之间有「连接名额」耦合**（切片 7.2 的 S6/R141 引入，实测踩到两次）：
  网关按 **IP** 计并发连接（上限 5，键 `ratelimit:ws-conn:{ip}`），名额靠 `disconnect` 的 `ZREM` 释放，
  **释放是异步的**。于是：① 同一用例里**同时**开超过 5 条（`slice-08` 曾经 P 房 3 条 + Q 房 3 条 = 6 条）
  ⇒ 第 6 条「连上即被踢」，它的 `room.match` 永远等不到 ack（`code=-1`，症状**很像**后端挂了）；
  ② 上一个切片刚关掉的客户端，其 `ZREM` 可能还没落地。
  **处置（写进规矩）**：用例要开新一局之前**先关掉上一局的客户端并静置**（`slice-08` 现为关掉 + `sleep(400)`）；
  若某条 WS 切片报 `code=-1`，先 `docker compose exec -T redis redis-cli --scan --pattern 'ratelimit:ws-conn:*'`
  逐个 `del` 再重跑 —— **不要**去动产品里的 5 这条限额（§5.4 逐字规定）。
- **`tools/conformance/dist/run.js` 失败时也曾会「永久卡住」**（R156）：`run.ts` 只设 `process.exitCode`
  而不调 `process.exit`，于是**失败路径泄漏的 socket 会把事件循环吊住** ⇒ 门禁卡死而不是红
  （切片 7.2 实测卡了 **693s** 直到被 SIGTERM）。已修两处：`run.ts` 末尾 `setTimeout(() => process.exit(...), 50).unref()`
  兜底强制退出；`slice-08` 的 `startFreshRoom` 在抛出前先关掉已连上的 client。**跑门禁时给每条切片套 `timeout` 是廉价的保险。**
- ✅ **覆盖率已可测量（P5 起，本条原先写的是「本机无法测量」—— 已过期）**：
  `@vitest/coverage-v8` 由 P5 的 Task 0 落盘（`packages/shared/package.json` 的 devDependency，`^2.1.0`，
  与 `vitest` 同版本线），且 §13.3 的门槛已写进 `packages/shared/vitest.config.ts`
  （`include:['src/**']` + `exclude:[...coverageConfigDefaults.exclude, 'src/index.ts']`
  + `thresholds.lines: 80`；⚠️ 原先还有第二项 `src/protocol/message.ts`，**该文件已随 P7/R361 整条删除**，排除项与注释一并清掉）。
  **命令**：`pnpm --filter @fight-the-landlord/shared test:coverage`
  （P6/P7 门禁实测 **97.58%**，EXIT=0）。
  ⚠️ 三条仍然要记：① `coverage.exclude` 是**整体覆盖**，必须 `...coverageConfigDefaults.exclude` 打头，
  否则**测试文件会进分母**（R289）；② 引用读数时必须写清**口径**；
  ③ **「用例全绿」仍然不等于覆盖率达标** —— 说明分别读。
- **`pnpm install` 需要写 `~/.pnpm-store`（工作区之外）**。若被沙箱拒绝，
  症状是「三个包 build 失败 + `apps/client` 装不上」，看起来像代码问题其实是权限问题。
  替代方案：`pnpm install --store-dir .pnpm-store`（`.gitignore` 已忽略该目录）。
  在无 TTY 的环境里再加 `CI=true`，否则 pnpm 可能交互式提问。
- **新 worktree 必须先 `pnpm install && pnpm build`**：`dist/` 是 gitignore 的，
  没有产物时 `shared` 会因解析不到 `@fight-the-landlord/protocol` 而 collect 失败。
- **跨包改**类型**比改代码更容易被过期 `dist` 咬（切片 10 实测）**：在 worktree 里删掉 game-service 模块增强的
  `baseScore` 之后，`pnpm lint` 立刻报 `game.service.ts: TS2339: Property 'baseScore' does not exist on type 'GameSession'`
  与 `view.builder.ts: TS2305: no exported member 'DEFAULT_BASE_SCORE'` —— 因为 `packages/shared/dist` 还是旧的。
  **处置**：跨包新增/删除导出或接口字段后，先 `pnpm --filter @fight-the-landlord/shared build`（或跑一次
  `turbo run build --force`）再跑 lint。与 R154 同族（`lint` 依赖 `^build` 只覆盖 turbo 入口）。
- **worktree 里 `docker compose ps` 为空 ≠ 服务没起**：Compose 的 **project 名按工作目录推导**，
  主检出跑起来的 8 个 `ftl-*` 容器属于 project `pokergame`、`workdir=/home/howe/pokergame`；
  在 `.worktrees/<role>/` 里查会算成 `backend`/`frontend` ⇒ 空表。**查状态用 `docker ps`（或 `docker compose -p pokergame ps`）。**
  契约测试真的依赖这 8 个容器，别把它读成「没有容器所以跳过」。
- **跑 conformance 必须独占（一次只跑一个人）**：网关按 **IP** 计并发 WS 连接（上限 5，§5.4）且切片之间共享 Redis 房间状态，
  两个并发跑各开 3 条客户端就是 **6 条** ⇒ 第 6 条「连上即被踢」，症状是 `code=-1` / ack 超时，**与真缺陷极像**。
  切片 10 门禁期协调者因此**在 conformance 一方 settle 之前不跑任何切片**（也不重建镜像/重启容器 —— 那会打断它正在跑的 e2e）。
- **`PlayerView.playPhase` 只暴露 `{ bombCount }`**（`packages/protocol/src/views.ts`，与 `docs/design.md` §6.4 一致），
  **没有** `landlordPlays`/`farmerPlays` ⇒ conformance 在线**无法独立复算春天**，只能「构造条件（两农民全程过牌 / 地主恰好一手）
  + 断言服务端下发的 `spring` 字段」。若将来要一条「不信任 `spring` 字段」的判据，得先扩契约（`packages/protocol` 归协调者）。
- **`api-gateway` 的 WS 代理有 `__ackId` 内部约定**（§6.1.1），改代理时必须两端一致。
- 后端遗留的临时文件：`packages/game-service/src/game/game.types.ts` 是**模块增强补的类型**
  （切片 10 已删掉其中的 `baseScore`，剩 `turnDeadlineAt`/`winner`/`botIds`）；这些字段全部上移到
  `packages/shared/src/ddz/types.ts` 后**应整体删除该文件**。

- **编排现在有「两种形态」，靠 Compose 的 override 合并切换**（切片 7.2 / R98 / R144）：
  - `docker-compose.yml` = **生产形态**：**只有门口 `edge`** 发布宿主端口（`80` / `443`；2026-09-24 门口片 R1203 更新 —— 此前是「只发布 `api-gateway:3000`」）；
    `api-gateway:3000` 与下游 3001/3002/3003/3005 及 redis 6379 / mysql 3306 / douzero 2021 **都不发布**（各自 `expose`），
    且 `INTERNAL_SERVICE_TOKEN` **没有默认值**（`${INTERNAL_SERVICE_TOKEN:-}`）⇒ 未配置时容器里的值是**空**，
    由 R89/R92 的**启动期 fail-closed** 让服务拒绝启动 —— 宁可起不来，也不要「用仓库里公开的常量」跑起来。
  - `docker-compose.override.yml` = **开发/联调形态**：把上述宿主端口（含 `api-gateway:3000`）与 dev 默认 token 放回来（conformance 的**直连断言**依赖它）。
  - **不带 `-f` 时 Compose 自动合并 override**（本机 Compose v5.5.1 实测）⇒ **日常命令一字不改**：
    `DOCKER_BUILDKIT=0 docker compose build && docker compose up -d` 仍是开发形态；只有 R98 的判据显式
    `docker compose -f docker-compose.yml config`（只读生产形态）。
  - ⚠️ **症状识别**：某个容器 crash-loop 且日志是 `INTERNAL_SERVICE_TOKEN is required` ⇒ 说明**没走 override**（漏了默认值），**不是**服务有 bug。
- **`docker compose config` 的判据必须先隔离两处环境**（R147）：`--env-file /dev/null`（隔离仓库里的 `.env`）
  **并且**从子进程 env 里剔除 `INTERNAL_SERVICE_TOKEN`（**shell 环境优先级高于 `--env-file`**）。
  任一处没隔离，「生产形态 token 渲染为空」的断言就会红得莫名其妙 —— 那是**判据不确定**，不是缺陷。
- **`${VAR:?}` 与 `${VAR:-}` 的区别会咬人**：base 文件的插值**先于** override 合并发生，所以 base 里写 `:?`
  会让**合并后的 dev 命令**也直接失败（override 给的默认值救不了它）。生产形态要的是「空值 + 运行期 fail-closed」，
  因此用 `${VAR:-}`。

- **§5.4 的 WS 限额有**两**条，不只「连接名额 5」**：`room-service/src/gateway/message.router.ts:32`
  是 **per-socket 消息 20 条 / 5 秒**（`WS_RATE_LIMIT = { max: 20, windowMs: 5000 }`）。任何「一局要发 >20 手」
  的 conformance 都必须节流 —— 实测不节流的原文：`❌ slice-09 失败：地主第 18 墩首出单张（seat 0）：期望 0，实际 10006`
  （`room.match` + `room.join` + `game.bid` + 17×`game.play` = 20 条，第 21 条即第 18 墩被拒）。
  现成参考：`tools/conformance/src/slices/slice-09-play-rotation.ts` 的 `sendThrottled`（同一 client 两条消息间隔 ≥300ms ≈ 16.7 条/5s）。
- **源码级机械闸在 worktree 里的路径陷阱**（R179）：写「扫 `packages/**` 源码」的闸时，
  相对路径必须在**两个环境**各验一次（`.worktrees/<role>` 与主检出）—— 写错一层会**静默扫到主检出的旧源码**
  （闸恒绿），或直接 ENOENT（门禁红）。做法与判据见「切片 9 新增的通用教训」第 1 条。

### 切片 7 新增的通用教训（写给每个 agent，不只是切片 7）

这四条都是切片 7 执行期**真金白银撞出来的**，每一条都对应一次假绿或假红：

1. **替身断言「调用次数」不等于断言契约。** `HttpService` 替身对任何 URL 都返回成功，
   于是 `acquireBot` 打 `/robots/create`（少了 `/api`）时单测全绿，**真实拓扑里 404**，
   30 秒补机器人从未成功过（R70）。**契约类断言必须比对完整参数**（URL/路径/载荷），
   跨服务调用改路径时先 `grep -rn "<path>" packages/*/src` 枚举全部调用点。
   约定：**env 里的是 base（不含 `/api`），路径里必须带 `/api`** —— 五个服务全都有 `setGlobalPrefix('api')`。
2. **`vi.waitFor` 不能证明「没发生」。** 它一旦通过就返回。**反向断言**必须写成
   「正向 `vi.waitFor` + 一小段静默窗（如 `setTimeout(20)`）+ 计数/状态不变」。
3. **变异测试必须自证变异生效。** 一个看起来能反证某行为的变异，可能对被测输入**恒等**（no-op），
   于是「反证失败」被你误读成「用例不够」。**反证失败时先怀疑变异是 no-op，再怀疑用例。**
4. **稳定性证据必须在与门禁相同的负载下取。** 单文件连跑 10 次通过 ≠ 门禁里不假红：
   `pnpm exec turbo run test --force` 会并发跑 19（test）/ 29（test+lint）个任务，
   定时器与调度压力完全不同 —— **两者不是同一个被测系统**。
   规则：① 尽量在**同级负载**下复现 RED；② 若本地负载等级低于门禁、**无法**复现 RED，
   必须**显式声明**并给出量化解释（例如用临时探针测出真实分布），
   **不得用低负载全绿冒充证据**；③ 涉及墙钟/定时的断言优先改成**结构性判据**
   （切片 7 的最终形态：spy `setTimeout` 断言排入的**延时值**、断言窗口内**尚未**分派、
   按**分派序号**而非时间断言顺序 —— 三者都与负载无关）。
5. **控制流的因果必须靠插桩确认，不能靠读代码推断。** 切片 7 里「`CLIENT_ACTION` 的恢复请求会抢先
   等待者」这条推断是**错的**：实测 `finishRequest` 先清槽位 → `notifyAction` 里同步 `send()`
   **立即 emit** → `flushIdleWaiters` 因 `pending !== null` 整体早退 → 等待者被推迟到该请求释放时唤醒。
   结论相同（等待者让路），**因果完全不同** —— 而用例只能钉住因果。

### 切片 8 新增的通用教训（同样写给每个 agent）

1. **jsdom 下 `trigger('click')` 打在 `disabled` 按钮上是静默 no-op**（R115，前端实测）。
   探针正对照：`disabled = true → clicks = 0`、`disabled = false → clicks = 1`（事件根本不派发）。
   推论：**任何「按钮被禁用 ⇒ 点它也不会发请求」的反向断言都是空测**；要抓住「本该禁用却可点」，
   **唯一**可靠的手段是断言 `disabled` 属性本身（`wrapper.find('.x').attributes('disabled')`）。
   这是「`vi.waitFor` 不能证明『没发生』」在 UI 层的同一族问题：**在断言「没发生」之前，
   先证明你的探针真的能观测到「发生」**。
2. **CAS 类请求的 ack 不等于串行队列已释放。** `game.bid`/`game.play`/`game.pass` 属于 CAS 消息：
   ack 返回后 `finishRequest` 若见 `awaitingStateVersion` 未满足（还没收到**更新 version** 的
   `game.state_update`）就**不释放队列**（`apps/client/src/net/socket.ts` 的 `stillAwaitingState`）。
   因此「同一 mount 里 ack 完马上点第二个按钮」在真实实现上**发不出第二个请求**，
   组件 `busy` 也仍为 true。要测两次连续动作，**开两次独立 mount**（或先喂一条更新版本的推送）。
3. **前端夹具 `playerViewFixture` 只做顶层覆盖。** `bidPhase` 之类的嵌套对象**整体替换、不合并**
   （必须写全）；而 `cardCounts` 的第 `seat` 位由夹具按 `hand.length` 重算（写不写等价）。
   写用例前读一眼 `apps/client/test/helpers/fake-socket.ts`，不要凭计划里的描述推断。
   （`playerViewFixture` 的手牌字面量也必须用**合法** DouZero 值：3–14 / 17 / 20 / 30。）

### 切片 7.2 新增的通用教训（四条，都是「判据/机制靠名字推断」会踩的坑）

> 这四条都不是「跑绿了就行」，而是**不写出来下一个人一定会踩**：前两条让服务**启动即崩**，
> 后两条让判据**假红**（而假红最危险的地方在于，它逼着人把判据改弱）。

1. **Nest 的自定义 logger 必须实现 `setLogLevels`，否则启动即崩（R148）。**
   `NestFactory.create(AppModule, { logger: ['error','warn','log'] })` → `registerLoggerConfiguration()`
   → `Logger.overrideLogger(数组)`，而 `@nestjs/common/services/logger.service.js` 的数组分支是
   `return this.staticInstanceRef?.setLogLevels(logger)` —— **可选链只挂在实例上，方法本身没有 `?.`**。
   五个服务里只有 `api-gateway` 传了 `logger` 数组，所以只有它会 `TypeError`。
   推论：**给 Nest 装自定义 logger 时，把 `LoggerService` 的每个可选方法（`fatal`/`setLogLevels`）都实现掉** ——
   接口上它们是可选的，运行时**不是**。
2. **`forRoutes('*')` 不等于「挂在所有路径」；`setGlobalPrefix('api')` 会把它收窄成 `/api/*`（R149/N14）。**
   实测（运行中的网关）：`GET /foo` 匿名 → **404**（不是 401）、`/api/rooms` → 401。
   ⇒ ① 写「未认证必须 401」这类判据前先量真实作用域；② **任何在 `/api` 之外注册的处理器都整条绕过验签** ——
   今天网关没有这种路由（`web/index.html` 的静态处理器是本片删掉的最后一个），**但这是下一个加路由的人的坑**。
3. **socket.io 客户端上「服务端在握手之后拒绝」= `connect` → `system.error` → `disconnect(io server disconnect)`，
   *不是* `connect_error`（R152）。** 实测（非法 token 走网关 `rejectHandshake`）：`connect` +18ms · `system.error {10005}` +19ms ·
   `disconnect reason=io server disconnect` +20ms · 最终 `socket.connected=false`。根因：socket.io 服务端**先发 CONNECT 包**，
   之后才调用 Nest 的 `connection` 处理器（我们才在里面 `client.disconnect(true)`）。
   ⇒ **连接类判据一律「静置 N ms 后读 `socket.connected`」**，并把「见过 connect / 被踢 / 传输错误」都打出来；
   写成「没有 `connect`」就是**假红**（限流正确工作时反而会红）。这条与 R115（断言「没发生」前先证明探针能观测到「发生」）同族。
4. **机械闸的探测正则必须盖住「注入式」写法，且先把底数 grep 出来（R150）。**
   `packages/room-service/src/gateway/game.client.ts` 走的是 `this.fetchImpl(...)`（测试靠注入替身），
   源码里**没有** `fetch(` 子串 —— 只匹配 `fetch(` 的闸会漏扫它，而「正对照名单里必须有它」会让闸**在自己的正对照上红**，
   最可能的错误「修法」是把正对照删掉（判别力一起没）。
   ⇒ 写源码级机械闸前，先 `grep -rn '<模式>' packages/*/src` 把**实际命中集合**列出来，再决定正则与正对照。
   **推论（本片两方各自踩过一次，值得当规矩）**：**每一条源码级机械闸都必须自带一条「探针判别力」用例** ——
   即「这个模式必然命中某段真实代码、且必然**不**命中某个近似写法」。否则闸会在某次无害重构后静默变成恒真/恒假，
   而恒假的表现是「在正对照上红」，最诱人的修法恰好是把正对照删掉。
   （本片两条闸都补了：`outbound-timeout` 的判据 B′（`fetchImpl(` 命中 / `typeof fetch` 不命中）、
   `no-raw-console` 的两条正对照。）
5. **手搭脚手架的 fixture 自己拼响应形状 ⇒ 可能与真实控制器漂移，于是「改口径」的 RED 测的是 fixture 而不是生产。**
   本片 `packages/game-service/test/game.controller.test.ts` 的 `create` 路由 fixture 就把控制器返回的
   `{code,data}` 又包了一层（而生产形状本来就是 `{code,data}`）。N6 的 RED 之所以仍然可信，是因为
   **conformance 在真机上独立确认了 `body.code === undefined`**（`slice-07.2-hardening` 第 6 步）。
   ⇒ 写「响应形状」类断言时，fixture 要**原样透传**控制器返回值（`res.json(await controller.x(...))`），
   并且**至少有一条真机判据**背书 —— 否则你测的是自己的脚手架。

### 切片开工前的必读
除本文件与计划外，**务必读 `docs/design.md` 附录 A.2**（53 条偏差，就是各切片的待办清单）
与 `docs/games/doudizhu.md` §11（玩法侧 18 条偏差）。其中 **C15 有「必须同时删除两处补偿」的警告**，
漏删会让地主拿到 23 或 21 张牌。
