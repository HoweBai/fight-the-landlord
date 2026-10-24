# 片② 「机器人 AI 全量化」规格（**规格层 v4**）

> **状态**：草稿，**待审**（三轮审查已回、v4 已处置；✅ 终核判「能进计划层」）。
> **输入**：设计层 `docs/superpowers/specs/2026-10-01-ai-rollout-design.md`（**v10**，八轮审查 + 一次规格回写；对账 79 行含 14 P0）。
> **分工**：设计层管**方案与取舍**；本文管**改什么、改到哪、怎么验**。
> ⚠️ 本文每条改动都**必须能回指设计层的某条 D**；设计层每条 D 的「写死」都**必须**在本文 §3 有判据。
> **本片不做**：真·配置中心、好友房开关（裁决 12/15，另立一片，见设计层 §7）。

---

## 0. 修订对账

### v2 相对 v1（第一轮审查：事实核查 · 完整性与可执行性）

> 第二路的**总判是「不能进计划层」**。逐条处置：

| # | v1 的问题 | 级别 | v2 的处置 |
|---|---|---|---|
| s1 | 🔴🔴 **B1 的 memo 伪码给不出「每轮至多一次」**：①「原始值第 4 参」⇒ `??=` 只改形参、不回写调用方，而 `processQueue` 是**逐桶调用** ⇒ 跨桶 memo **从根上不成立**；② fail-open 返回 `undefined` 而 `??=` **对 `undefined` 不记忆** ⇒ 失败路径每桶重算 | P0 | 改成**轮次持有对象**（`round.can`，按引用传参）；`availability()` 的返回类型改为 **`Promise<boolean>`，永不返回 `undefined`**（fail-open ⇒ `true`） |
| s2 | 🔴 **A4/A9 的解析时机自相矛盾**（模块级常量 vs `main` 里 try/catch）+ **`parse*(undefined)` 语义未定义** | P1 | 新增 `src/robot/config.ts`：**只导出函数**、惰性 + 记忆化的 `getRobotConfig()`；`main` 在建容器**之前**调它，失败 ⇒ `logger.error` + `exit(1)`；**`undefined`（未设）⇒ 用户裁决 10 的默认值**。⚠️ v2 初稿写成「模块级 `ROBOT_CONFIG` + `assertRobotConfigValid()`」——**仍然不成立**（模块常量在 import 期就求值，早于 `main` 的函数体）⇒ **v3 再修**（见 §0 的 v3 段） |
| s3 | A6 要用 `DOUZERO_URL`，但它是 `douzero.client.ts:4` 的**非导出**常量 | P1 | A3 里**导出**它，A6 import（**不**二次读 env） |
| s4 | 🔴 **A7 的转发落点未钉**（controller vs service）⇒ 落成 controller 注入会让 `robot.rpc.test.ts:51-58` 整组红 | P1 | 钉死：加在 **`RobotService`** 上，controller **只转发、不新增构造依赖** |
| s5 | F1 缺三条口径：**只读挂载下写入失败**（J13 夹具正中此处）/ `missing` **按模型名** / **SIGTERM 语义** | P1 | 逐条写死（写失败 ⇒ 按缺失处理、绝不抛；missing 按模型名；SIGTERM 写进 README） |
| s6 | E2/E3 的 **`code`/`source` 写入点未写死**（单槽 notice 靠什么区分未定） | P1 | `SessionNotice` 加 `code?` + `source?: 'action' \| 'transport'`；写入点只有两个（`session.ts:115` 的 transport；toast 处理器的 action）；E4 的清只清 `source==='action' && code===12007` |
| s7 | 🔴 **§4.1 漏两条会红的既有判据**：`douzero.client.test.ts:120-141`（替身无 `text()` ⇒ 只补 `model` 仍红）、`robot.rpc.test.ts` 的 DI 红 | P1 | 两条都补进 §4.1（前者给处置，后者由 s4 消除） |
| s8 | §6 缺「**本机重建 douzero 镜像**」这一步；回滚缺「**只能用拉旧 tag**、不得用当前检出重建」的警告 | P1 | §6 补第 0 步与回滚例外 |
| s9 | §9 缺设计层 **R1/R3/R7/R8/R13** 的登记 | P2 | 新增 S6–S8（v3 订正：R8 的「写进运维手册」是**本规格新增的处置**，设计层并未这样要求 —— 原括注属误挂） |
| s10 | J13/J22/J20/J4/J11 的**前置**（挂载点/等待上界/桶数/观测量/载体）未写死 | P2 | 五行各自补前置 |
| s11 | 🔴 **C1 的订正与设计层 D10 末句相反、且未回写设计层** ⇒ 同一事实两个真源（S5 要求「停下报我」） | P1 | **设计层 v10 同步订正**（见设计层 §0.1 v10 段）；规格这条保留（它是对的） |
| s12 | 事实核查的六条：`MatchService` 无 `this.robot`（P1）· 决策日志在 `robot.service.ts:38-40` 而非 `bot.player.ts`（P2）· `decided` 的 `source` 并未丢失（P3）· `ftl-conformance-*` 先例归属（P3）· `makeFakeProxy` 落点（P3）· §1 表头计数（P4） | P1/P3 | 六条全改（本版 §2 的 A2/A2b、B1、C1、§4.2、§5、§1 抬头） |

### v3 相对 v2（第二轮核对：**只核落地**）

> 🔵 本轮结论：s1/s3–s12 的文本**属实且落地**（设计层 v10 那行也属实）；**s2 的处置不成立**（P0），另 4 条新写文本的洞。

| # | v2 的问题 | 级别 | v3 的处置 |
|---|---|---|---|
| v3-1 | 🔴🔴 **s2 的处置仍不可执行**：v2 改成「模块级 `ROBOT_CONFIG` + `assertRobotConfigValid()`」——**仍然合取不可满足**：`main.ts:3` 的静态 `import { AppModule }` 会把求值链（app.module → robot.module → RobotPool → config.ts）**全拉到 `main` 的函数体之前** ⇒ 非法 env 仍在 import 期抛裸栈，`assert` 根本走不到 | P0 | 改成**只导出函数 + 惰性记忆化的 `getRobotConfig()`**（模块求值不读 env、不抛；`main` 在建容器前调它，失败 ⇒ `logger.error` + `exit(1)`）；**并清掉 A4 里与之互斥的旧句**（「改为从 `parseSkillDistribution(process.env…)` 来」）。🔴 **J4 补第二观测**（Node 未捕获异常的退出码**也是 1** ⇒ 只看退出码分不出「干净退出」与「裸栈崩溃」，而这两者的区别正是 A5 要钉的） |
| v3-2 | **A6 的返回类型被误抄**：v2 写 `Promise<boolean>`，而 `reason` 的唯一来源就是 A6 ⇒ 协议里的 `reason` **永远不产生**（「永不 undefined」那条约束属**房间侧**，抄错了对象） | P1 | A6 返回 `{ canProvide; reason? }`；「RPC 失败 ⇒ `true`」归 **B2** |
| v3-3 | 🔴 **§4.1 又漏两组构造点**：`robot.decide.test.ts:206`（`new RobotService(bot, fakePool)`，全仓唯一直接构造）会因 A6 进 `RobotService` 而红；`match.service.test.ts` 的三处 `new MatchService(…)`（`:306`/`:665`/`:1263`）会因 B1 的第 5 参而红 | P1 | 两条都补进 §4.1（v2 刚补过两条同类，**这一类连续两轮都在漏**） |
| v3-4 | **§6 的行数错**：写「19 行」，实为 **21 数据行 − 指向交接的 1 行 = 20 行** | P2 | G2 与文档段各改一处 |
| v3-5 | **A3 的导出指令落点错位**：写在 A6 段 ⇒ 按 A 行切任务时 A3 的负责人看不到 | P2 | 指令挪进 A3，A6 只留引用 |
| v3-6 | s9 的「R8 另要求写进运维手册」**误挂**（设计层无此要求） | P2 | 订正为「本规格新增的处置」 |

### v4 相对 v3（第三轮终核）

> 🔵 本轮结论：**能进计划层**。v3-1 的惰性方案经逐句核实可执行、无自相矛盾（J4 的双观测成立、且兼作「有人把惰性写回模块级常量」的回归守卫）；v3-2/4/5/6 全部落地。以下四条顺手。

| # | v3 的问题 | 级别 | v4 的处置 |
|---|---|---|---|
| v4-1 | 🔴 **§4.1 又漏一处构造点**：`room-service/test/message.router.test.ts:998` 也是 4 参 `new MatchService(…)` ⇒ B1 后编译红。**这一类已连续三轮在漏**（v2 漏两条 → v3 补两条又漏一条） | P1 | 补进 §4.1（四处一起列），并写明「实现时先全仓搜一遍」 |
| v4-2 | §4.1 把 `robot.rpc.test.ts:51-58` 也叫「构造点必须同步补参数」——它是 **`useValue` 替身、无直接构造** ⇒ 本就不红 | P3 | 订正（真正红的只有 `robot.decide.test.ts:206`） |
| v4-3 | 「§4.2 的替身清单要含 A6 的 stub」没落进 §4.2 表 | P3 | §4.2 补一行 |
| v4-4 | 文首仍称输入是「设计层 v9」（实际已是 v10）；A2b 的行号 `:37-39` 实为 `:38-40` | P3/P4 | 两处订正 |

---

## 1. 改动面一览（表内 **29 行**：代码 23 · 文档与编排 3 · conformance 3）

| # | 仓/包 | 文件 | 改动 | 来源 |
|---|---|---|---|---|
| A1 | robot-service | `src/robot/models.ts`（**新**） | `MODEL_BY_SKILL` 映射 + `DouZeroModel` 类型 | D2 |
| A2 | robot-service | `src/robot/bot.player.ts` | 出牌恒走 DouZero（三分支）；删 `skillLevel` 路由 | D1 |
| A2b | robot-service | `src/robot/robot.service.ts` | **决策日志加 `model=`**（`source=` 已有，`robot.service.ts:38-40` 是全服务唯一决策行） | D10 |
| A3 | robot-service | `src/robot/douzero.client.ts` | 请求体加**必填** `model` | D2/D7 |
| A4 | robot-service | `src/robot/robot.pool.ts` | 抽取搬到 `acquire` 的新绑定分支；`createBot(roll)`；比例可配；删 `ERROR_RATE`/`errorRate` | D2/D3/D9 |
| A5 | robot-service | `src/robot/config.ts`（**新**） | `parseSkillDistribution` / `parseRuleFallback` / `getRobotConfig`（惰性 + 记忆化） | D3/D4 |
| A6 | robot-service | `src/robot/douzero.health.ts`（**新**） | `/health` 探测 + 5s 缓存 + 读开关 ⇒ `canProvide` | D5/D6 |
| A7 | robot-service | `src/rpc/robot.rpc.controller.ts` | 新增 `@MessagePattern(RPC_PATTERNS.robotAvailability)` | D5/D11 |
| A8 | robot-service | `src/robot/robot.module.ts` | 注册新 provider（DI 用值导入，见 memory `di-type-import-trap`） | D5 |
| A9 | robot-service | `src/main.ts` | 建容器**之前**调 `getRobotConfig()`（非法 ⇒ `logger.error` + `exit(1)`） | D3/D4 |
| B1 | room-service | `src/match/match.service.ts` | 门禁（每轮至多一次 memo ⇒ 第 4 参）；失败集 = 自己窗口到点的人；`failMatch` 幂等（ZREM 先于 publish、只发子集）；中文文案 | D5/D8 |
| B2 | room-service | `src/gateway/robot.client.ts` | `availability()` 客户端，**2s** 超时、不重试 | D5/D11 |
| C1 | game-service | `src/game/game.service.ts` | 第三条决策路径的两条日志（`decide` 失败 / 动作被拒） | D10 |
| D1 | protocol | `src/robot.ts` | `RobotAvailabilityRequest/Response`；删 `BotPersonality.errorRate`；`source` 注释订正 | D5/D9 |
| D2 | protocol | `src/rpc.ts` | `RPC_PATTERNS.robotAvailability`（第 9 个） | D11 |
| E1 | client | `src/net/action-copy.ts` | 加 `MATCH_TIMEOUT`；新增 `actionCopyFor(code): string \| null` | D8 |
| E2 | client | `src/net/session.ts` | `SessionNotice.code?`；toast 文案走文案表；推送 `system.error` 只消费 TOAST 类**与未登记码** | D8 |
| E3 | client | `src/composables/useGameSession.ts` | 「连接不可用」那条 notice 带自己的来源 | D8 |
| E4 | client | `src/pages/game/game.vue` | 发起 `room.match` 时清掉匹配失败类 notice | D8 |
| F1 | douzero | `server.py` | 9 模型 + `model` 字段 + `/health` 形状 + 线程/backlog + 下载(temp+rename) + 400/503 | D6/D7 |
| F2 | douzero | `Dockerfile` | runtime 段加 `test -f` 九路径 | D7 |
| F3 | douzero | `models/` + `models/SOURCES.md` | 布局 `models/<model>/<position>.onnx` + 九个 URL/sha256 | D7 |
| F4 | douzero | `README.md` | 同步五项（布局/URL/model 字段/health 形状/并发） | D7 |
| G1 | 编排 | `docker-compose.yml` | robot-service 加两个 env（`${VAR:-默认}` 形态） | D3/D4 |
| G2 | 文档 | `docs/design.md` | §6 的 **20 行**修订（设计层 §6 表体 21 行，其中 1 行指向交接文档、由 G3 承接） | 设计层 §6 |
| G3 | 文档 | 交接文档 §3.1 | **原地勘误**（三个错数） | 设计层 §6 末行 |
| H1 | conformance | `src/slices/slice-13-ai-rollout.ts`（**新**） | 见 §5 | — |
| H2 | conformance | `src/slices/slice-11-robot-system.ts` | 扩 `runDouZeroContract`（J26/J33） | — |
| H3 | conformance | `src/run.ts` + `baselines.json` | 注册 slice-13；`full` 列由 CI 回填 | — |

---

## 2. 改动清单（逐处）

### A. robot-service

**A1 `src/robot/models.ts`（新）**
```ts
export type DouZeroModel = 'sl' | 'douzero_WP' | 'douzero_ADP';
export const MODEL_BY_SKILL: Record<SkillLevel, DouZeroModel> = {
  beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP',
};
```
取值与 douzero 的模型目录名**逐字相同**（一套词汇，少一层映射）。

**A2 `bot.player.ts`**
- `decidePlay`：**删掉** `if (req.skillLevel === 'advanced')`；改为**无条件**先 `getMove`，三分支：
  1. 抛错/超时 ⇒ `ruleDecide`；
  2. 非空但 `isPlausible` 为假 ⇒ `ruleDecide`；
  3. **空数组 ⇒ `{kind:'pass', source:'douzero'}`，不降级**（顺序：空数组判断必须在 `isPlausible` 之前）。
- `buildDouZeroContext`：加 `model: MODEL_BY_SKILL[req.skillLevel]`。
- 三条既有 WARN 保留（牌不在手 / DouZero 失败 / `lastMoveMeta` 缺失）；🔴 **决策成功日志不在本文件**（在 `robot.service.ts:38-40`，见 A2b）。
- ⚠️ **不得** import `parseRuleFallback`/任何开关符号（J29 钉）。

**A2b `robot.service.ts:38-40`**：现有 `logger.log(\`Bot ${req.botId} decided ${decision.kind} (source=${decision.source}, …)\`)` ⇒ **加 `model=${MODEL_BY_SKILL[req.skillLevel]}`**（`source=` 已有，别重复加）。回退到规则时 `model` 记的是「本该用的那个模型」（可归因）。

**A3 `douzero.client.ts`**
- 🔴 **把 `DOUZERO_URL` 导出**（现状 `:4` 是模块私有；A6 要用它 ⇒ **不**二次读 env）。
- `DouZeroContext` 加 `model: DouZeroModel`（**必填**）；`DouZeroRequestBody` 加 `model: string`（**必填**，不给默认）。
- 非 200 时**先读 body 再抛**：`const detail = await response.text().catch(() => '')`，错误消息带 `detail`。
- `test/douzero.client.test.ts:103-117` 的**契约键清单加 `model`**。

**A4 `robot.pool.ts`**
- 删 `ERROR_RATE`（`:47-52`）与其使用（`:438`）；`BotPersonality` 只留 `thinkingSpeed`。
- `createBot(roll: { skillLevel: SkillLevel; thinkingSpeed: number })`：**不再抽随机**（D2）。
- `acquire`：`findBound` 命中 ⇒ **原样返回**；`takeIdle()`/新建那条 ⇒ **抽 2 个随机数**（skill + speed）、写回持久化（D2/J5c）。
- 🔴 `SKILL_DISTRIBUTION` 改为 **`getRobotConfig().skillDistribution`**（A5；⚠️ **不是**模块级常量、**不是**直接读 env —— v2 初稿那句「改为从 `parseSkillDistribution(process.env….)` 来」与 A5 的惰性形态互斥，已清）。
- `pickSkillLevel()` 的兜底从 `return 'beginner'` 改成**返回最后一档**（D3）。

**A5 `src/robot/config.ts`（新）**
```ts
export function parseSkillDistribution(raw: string | undefined): readonly [SkillLevel, number][];
export function parseRuleFallback(raw: string | undefined): boolean;
export function getRobotConfig(): { skillDistribution: …; ruleFallback: boolean };   // 惰性 + 记忆化
```
- 比例：`beginner=0.15,intermediate=0.35,advanced=0.5` 形态；三档齐全各一次、非负、至少一个 >0；**按总和归一化**；非法 ⇒ **抛**；🔴 **`undefined`（未设）⇒ 用用户裁决 10 的默认值**。
- 开关：只认 `'true'`/`'false'`；**`undefined` ⇒ `true`**；**其它（含 `''`）⇒ 抛**。
- ⚠️ 空串的两种形态语义（compose 的 `${VAR:-默认}` vs `docker run -e VAR=`）写进注释与手册。

🔴 **解析时机钉死（v2 修 v1 的自相矛盾，v3 再修一次）**：
- v1 写「`SKILL_DISTRIBUTION` 是模块级常量」+「`main.ts` 里 try/catch + `exit(1)`」——**两句合取不可满足**：模块级常量在 **import 期**就求值，而 `main.ts` 的 import 语句先于它的函数体 ⇒ 非法 env 会在 `assertRobotConfigValid()` 之前抛裸栈。
- ⇒ 定死为**惰性 + 记忆化**：`config.ts` **只导出函数**（模块求值不读 env、不抛）；`getRobotConfig()` 首次调用时解析并缓存；`main.ts` 在建容器**之前** `try { getRobotConfig(); } catch (e) { logger.error(e); process.exit(1); }`；`RobotPool` 与 A6 各自 `getRobotConfig()` 取（此时已记忆化，且已保证合法）。**不要**用模块级常量、**不要**用 `useFactory` 里抛（那样退出形态不受控）。

**A6 `src/robot/douzero.health.ts`（新）**
- 🔴 **`DOUZERO_URL` 现在是非导出常量**（`douzero.client.ts:4`）⇒ **A3 里导出它**（见 A3 第一条），A6 `import { DOUZERO_URL }`（**不要**二次读 env —— 那会变成同一 env 两个真源、默认值抄两遍）。
- 🔴 **A6 的返回类型是 `Promise<{ canProvide: boolean; reason?: 'douzero-unreachable' | 'models-incomplete' }>`**（v3 订正：v2 误写成 `Promise<boolean>` —— 那会让协议里的 `reason` **永远不产生**；「永不返回 undefined」那条约束属于**房间侧**（B1/B2：RPC 失败 ⇒ `true`），不要抄到这一侧）。
- **开关 ON ⇒ 恒 `true`，不探测**；开关 OFF ⇒ `GET {DOUZERO_URL}/health`，**超时 1s**，缓存 **5s**（代码常量）：
  - 200 且 `models` 是 `typeof m === 'object' && m !== null && !Array.isArray(m)` 且三档各含三个**位置名** ⇒ `true`；
  - 可解析但缺档 ⇒ `false`（reason `models-incomplete`，**记日志**）；
  - 非 200 / 连接被拒 / **超时** ⇒ `false`（reason `douzero-unreachable`，**记日志**）；
  - `models` 缺失/非普通对象 ⇒ **`true`**（fail-open，**记 WARN**）。

**A7/A8**：🔴 **转发落点钉死（v2）**：`availability()` 加在 **`RobotService`** 上（controller **只转发**，**不新增构造依赖**）—— 否则 `test/robot.rpc.test.ts:51-58` 的 testing module（只 provide 了 `RobotService`）会因依赖解析失败而整组红。新 provider（A6）用**值导入**注册进 `RobotModule`。

**A9 `main.ts`**：在建容器**之前** `try { getRobotConfig(); } catch (e) { logger.error(e); process.exit(1); }`（范式 `main.ts:13-16`）。⚠️ **不要**在建容器之后、也不要靠模块级常量在 import 期抛（那会变成裸栈）。

### B. room-service

**B1 `match.service.ts`**
- 🔴 **先加构造依赖（v2 补，事实核查 P1）**：`MatchService` 现在**没有** `robot` 字段（构造器 `:128-149` = `redis`/`roomsService`/`roomStart`/`config`）⇒ 要给 `MatchService` **新增 `RobotClient` 构造依赖**；`match.module.ts:16` 已 import `RpcClientsModule`（其 `exports` 含 `RobotClient`）⇒ 可注入，但⚠️ **必须值导入**（memory `di-type-import-trap`：`import type` 会让容器启动即崩，而单测与 tsc 都看不见）。
- `scanAndMatchInner`（`:331`）的 for **之前**建一个**轮次持有对象**：`const round = { can: undefined as boolean | undefined };` —— ⚠️ **必须按引用传参**（`processQueue(mode, baseScore, region, round)`）：`processQueue` 是**逐桶调用**，传原始值只改形参、不回写调用方 ⇒ 跨桶 memo **从根上不成立**（v1 的伪码正是这么写的，判据 J20 因此不可满足）。
- 在 `:427` 的早退之后、`:429` 之前插入（`mode/baseScore/region/now/alive` 都在 `processQueue` 作用域内）：
  ```
  if (alive.length < 3) {                       // 只在需要机器人时
    if (round.can === undefined) round.can = await this.robot.availability();   // 每轮至多一次
    if (round.can === false) {                  // 只有明确的 false 才触发
      const expired = alive.filter(q => now - q.enteredAt >= BOT_FILL_WAIT_MS);
      if (expired.length > 0) await this.failMatch(expired.map(q=>q.playerId), mode, baseScore, region, '当前无匹配的玩家');
      return;                                   // 🔴 必须 return，不得继续建房（J6 负例）
    }
  }
  ```
- 🔴 **`availability()` 的返回类型是 `Promise<boolean>`，永不返回 `undefined`**：RPC 抛错/超时/`canProvide` 字段缺失 ⇒ **返回 `true`**（fail-open，由客户端层吸收）+ 记 WARN。⚠️ v1 写的「失败 ⇒ `undefined`」与 `??=` 的语义**合取不可满足**（`??=` 对 `undefined` **不记忆** ⇒ 失败路径每桶重算）。
- `failMatch`（`:531-552`）改序：**先 `zrem`、按返回值收子集**，再 publish **子集**（空则不发），`del match:meta` 保持每票执行。
- 既有 60s 文案（`:419`）改中文 `当前无匹配的玩家`。

**B2 `robot.client.ts`**：`availability()` 用 `RPC_PATTERNS.robotAvailability`，`timeout(2000)`、**不重试**、带 `metaFromTrace()`。🔴 **返回类型 `Promise<boolean>`、永不 `undefined`**：RPC 抛错/超时/**应答缺 `canProvide`** ⇒ **返回 `true`**（fail-open）+ WARN（v3 订正：这条约束属**房间侧** —— v2 把它误抄到了 robot-service 侧，导致 A6 的 `reason` 永远不产生）。

### C1 game-service

- `:613-614` 的 warn 加标记 `(fallback=game-service-rule reason=decide-failed)`；🔴 **`:646-647` 那条「动作被拒」的 warn 已经存在** ⇒ 只把标记补进它（`reason=action-rejected`），**不要新增第二条**（v5 订正：本节原写「`:627-631` 新增一条」——那一支在 `decided === null` 时**恒不执行**，见设计层 D10 的 v10 订正）。
- ⚠️ **订正（事实核查 P3）**：`RobotDecideResponse` **自带 `source`**（`protocol/src/robot.ts:133`）⇒ `first.source` 展开后仍在，**没有丢**；拿不到的只有 `model`（它从不进响应，game-service 手上只有 `skillLevel`）。且 `:613` 这一支恰是 `decided === null` ⇒ 无论展开前后都没有来源可取。**照这条改，别照「展开前取」那句改。**

### D. protocol

- `robot.ts`：新 `RobotAvailabilityRequest { meta?: RpcMeta }` / `RobotAvailabilityResponse { canProvide: boolean; reason?: … }`；删 `errorRate`；`source` 的注释改为「来源而非档位」。
- `rpc.ts`：`RPC_PATTERNS.robotAvailability = 'robot.availability'`。
- `messages.test.ts:52-63`：八键 ⇒ **九键**（判别力自证那条保留）。
- `robot.test.ts:58`：夹具去掉 `errorRate`。

### E. client

- `action-copy.ts`：`[ErrCode.MATCH_TIMEOUT]: '当前无匹配的玩家'`；新增 `actionCopyFor(code): string | null`（**不动** `actionErrorMessage` 的签名——`:63` 有源码级闸）。
- `session.ts`：🔴 **`code`/`source` 的写入点钉死（v2）**：`SessionNotice` 加 `code?: number; source?: 'action' | 'transport'`；`notice()` 的签名随之扩展（或在调用处直接传对象）；**写入点只有两个**：`session.ts:115` 的 `onConnectUnavailable` 传 `source:'transport'`（无 code）；`:174-176` 的 toast 处理器传 `code: report.code, source:'action'`。推送路径对 `CLIENT_ACTION[code] === TOAST` **或未登记**的码调 `reportErrorCode`（导航类**不**消费）；toast 文案 `actionCopyFor(report.code) ?? describeAction(report)`。
- E3/E4：**「连接不可用」那条由 `session.ts:115` 打 `source:'transport'`**（它**不是** `useGameSession.ts` 产生的）；`game.vue` 的 `room.match` 发起处只清 **`source === 'action' && code === MATCH_TIMEOUT`** 那一条 —— 单槽 notice 靠这个条件区分，不误伤连接不可用。

### F. douzero

- `server.py`：
  - `MODELS = ['sl','douzero_WP','douzero_ADP']`、`POSITIONS` 不变；`sessions[model][position]`；
  - `HF_BASE` 模板化（`.../models_onnx/{model}/{position}.onnx`）+ 九个 URL；
  - 下载：**先写同目录 `.tmp`、成功后 `os.replace`**；单文件超时 **30s**、总预算 **60s**、不重试；🔴 **写入失败（含只读挂载的 `EROFS`）⇒ 按缺失处理、**继续启动，绝不抛**（J13 的夹具正是只读空目录：九次下载全失败）；**文件存在但加载失败 ⇒ 不删、只报告**；
  - 启动：加载全部存在的模型，**无论几个都不退出**；一个都没有也只是报告；🔴 **打印每个模型的加载结果**（成功/缺失/失败，含只读挂载下的写失败）；
  - `/health` 恒 200，body = `{status:'ok', models:{…}, missing:[…], agents:[已加载模型名升序]}`；🔴 **`missing` 的粒度 = 模型名**（某档只加载了 2/3 个位置 ⇒ 该档整个进 `missing`），不是按位置；
  - **SIGTERM / 在途请求（写进 README）**：daemon 线程 ⇒ 进程退出不等在途请求；`docker stop` 时正在推理的请求被切断，game-service 侧表现为 5s 超时 ⇒ 回退规则引擎。**这是已知且可接受的**。
  - `/decide_play` 读 `model`（缺省 `douzero_WP`；未知 ⇒ **400**；已知未加载 ⇒ **503**），body 统一 `{"action": [], "error": "<原因>"}`；
  - `ThreadingHTTPServer` 的**子类** + `request_queue_size = 128` 写成**类属性**（🔴 **v5 订正**：构造后赋实例属性是**死代码** —— 构造里已 `listen()`；片② Task 5 实测 + 运行镜像 CPython 源码双证）；
  - 删 `src/__pycache__/`（14 个 .pyc）并加进 `.gitignore`。
- `Dockerfile`：**runtime 段**（`COPY --from=builder /app/models` 之后）加 `RUN test -f` 九路径。
- `models/`：搬到 `models/<model>/<position>.onnx`；新增 `SOURCES.md`（九个 URL + sha256）。

### G. 编排与文档

- `docker-compose.yml` 的 robot-service 段加：
  `- ROBOT_RULE_FALLBACK=${ROBOT_RULE_FALLBACK:-true}`、`- ROBOT_SKILL_DISTRIBUTION=${ROBOT_SKILL_DISTRIBUTION:-beginner=0.15,intermediate=0.35,advanced=0.5}`。
- `docs/design.md`：按设计层 §6 的 **20 行**逐条改（表体 21 行 − 指向交接文档的那 1 行）。
- 交接文档 §3.1：**原地加勘误段**（265ms / 3.8 每秒 / ~18 三个数全订正，指向设计层 §2）。

---

## 3. 判据（J1–J33）

> 通用纪律（设计层 §8）：每条都能说出**替代错实现**；涉 douzero 的性能类断言**容器内 vantage**；涉随机**注入确定性序列**；正向断言配**负向对照**。
> 下表只写**断言要点**与**层**；「替代错实现」逐条见设计层 §8。

| # | 断言要点 | 层 |
|---|---|---|
| J1 | 三档各调一次 DouZero；`ctx.model` 逐档对应；**出站字节**含对应 `model` | robot-service vitest ×2 | 
| J2 | 映射字面量（不 import 被测表） | robot-service vitest |
| J3 | 默认比例精确落点（确定性序列，容差 0）+ `<` 边界 + `15,35,50` ≡ 归一配置 | robot-service vitest |
| J4 | 两 env 的边界值（含空串/垃圾值 ⇒ 启动失败）。🔴 **conformance 那半的观测量钉死**：入口 = `Dockerfile.robot-service` 的实际 CMD；断言 **退出码 = 1** 🔴 **且 stderr 含 `logger.error` 那一行**（v3 补：Node 的未捕获异常退出码**也是 1** ⇒ 只看退出码分不出「fail-closed 干净退出」与「裸栈崩溃」，而这两者的区别正是 A5 要钉的） | vitest（纯函数）+ conformance 一次性容器 |
| J5/J5b | release→acquire 后难度独立；`thinkingSpeed ∈ THINKING_SPEED[新档]`；**写回持久化** | robot-service vitest |
| J5c | 每新绑定 **Δ=2**、幂等命中 **Δ=0**（计数桩） | robot-service vitest |
| J6 | 开关 OFF + 不可用 ⇒ 第 30s、`A(31s)+B(2s)` ⇒ **只判 A**、中文文案、**且未建房**（负例） | room-service vitest |
| J7 | OFF + 可用 ⇒ 照常补位（同替身先 false 后 true） | room-service vitest |
| J8 | RPC 抛错/未知 pattern ⇒ fail-open | room-service vitest |
| J9 | 3 真人 ⇒ 门禁**根本没被调用** | room-service vitest |
| J10 | 探测六态（含两态「真源」构造） | robot-service vitest |
| J11 | 20 路并发 20/20 成功 + 0 重置；同变体比值 ≤ K(=60)（**容器内**）。🔴 **载体钉死**：`docker exec` 进**一个跑着的**容器发（不必新起一次性容器 —— §4.2 的封装清单里不含 J11） | conformance |
| J12 | 未知 model ⇒ 400（正对照：已知 ⇒ 200 且返回该模型动作） | conformance |
| J13 | 只读挂载空目录 ⇒ **不退出** + 报 missing + 该档 503 + healthcheck 命令退出码 0。🔴 **前置**：挂载目标 = `/app/models`（`DOUZERO_MODELS` 的值，`Dockerfile:24`）；**等待有上界**（只读下下载必失败，但网络超时仍要封顶）；「healthcheck 退出码 0」= **在容器内手工执行 Dockerfile 的 HEALTHCHECK 原命令** | conformance |
| J14 | 推送 12007 ⇒ 等待页文本 = 「当前无匹配的玩家」 | 客户端 |
| J15 | 推送 10004 不导航；推送 10007 仍产 notice（正对照） | 客户端 |
| J16 | 重新匹配 ⇒ 清匹配失败 notice；连接不可用 ⇒ 仍显示（**两段断言**） | 客户端 |
| J17 | 全链无泄漏（沿用 slice-11 第 4 组） | conformance |
| J18 | `docs/design.md` 三条机械闸（§9.3 整节零 `errorRate`／两个新 env 进 §2.3／三个模型字面量） | `packages/shared/test/`（阶段 4） |
| J19 | `RPC_PATTERNS` 九键；`RPC_USAGE` 负对照；两张文件清单同步 | 既有闸 |
| J20 | 每轮至多 1 次 availability（NEVER 替身）；5s 缓存只探一次。🔴 **夹具必须 ≥2 个桶**（1 个桶 ⇒ 恒绿、零判别力） | room + robot vitest |
| J21 | 每个 pattern 有接收侧 `@MessagePattern` **且承载类被模块注册**（全包扫描） | `packages/protocol/` 源码闸 |
| J22 | 真栈真打 `robot.availability`：**ON 那半打常驻栈**（`ROBOT_RPC`，得 `true`）；**OFF 那半只需一只**一次性容器（`-e ROBOT_RULE_FALLBACK=false -e DOUZERO_URL=http://127.0.0.1:9 -e RPC_PORT=<空闲端口>` + 显式发布该端口，得 `false`）；**带「端口未被占用」前提断言** + 后置残留断言 | conformance |
| J23 | 两条失败路径的 `message` 逐字中文 | room-service vitest |
| J24 | 老/新 `BotInstance` 都可读；字段集**只减不增** | robot-service vitest |
| J25 | 第三条路径两成因各一条日志 | game-service vitest |
| J26 | 真栈 `/health` 三档齐备、**每档恰好三个名字** | conformance（slice-11 扩展） |
| J27 | `failMatch` 幂等：`[P(已判过), Q]` ⇒ publish 恰好 `[Q]` | room-service vitest |
| J28 | RPC 超时 2s > 探测 1s | vitest（或源码闸） |
| J29 | `bot.player.ts` 及决策链**不得**读开关 | 源码级闸 |
| J30 | `rooms.start.ts`/`rooms.autostart.ts` **不得**读 `robot.availability` | 源码级闸 / vitest |
| J31 | Dockerfile 的 `test -f` 在 runtime 段 `--from` 之后 | 源码级闸 |
| J32 | 只缺一个文件 ⇒ 补下 + 加载 + `/health` 齐备 | conformance（需网） |
| J33 | 不带 `model` ≡ 显式 `douzero_WP`（响应逐字节同；夹具用已实测的判别局面） | conformance（slice-11 扩展） |

**J33 的判别局面（实测可得，直接当夹具）**：
```json
{"position":"landlord_up","hand":[3,4,5],"bottom_cards":[],"last_move":[5],
 "last_move_position":"landlord","num_cards_left":{"landlord":5,"landlord_down":5,"landlord_up":3},
 "played_cards_landlord":[],"played_cards_landlord_down":[],"played_cards_landlord_up":[],
 "card_play_action_seq":[],"must_play":true}
```
⇒ `sl=[4]` · `douzero_WP=[3]` · `douzero_ADP=[5]`（三档两两不同）。

---

## 4. 测试与夹具迁移

### 4.1 会红的既有判据（逐条处置）

| 判据 | 为什么红 | 处置 |
|---|---|---|
| `robot.decide.test.ts:134-160` | 断言 `beginner ⇒ 规则引擎` 且「不得调 DouZero」 | **翻**（改成「beginner 也调 DouZero，`model=sl`」） |
| `robot-service/test/bot.player.test.ts:196/208` | 用 beginner 造请求；替身 `async () => []` ⇒ 现在走「空数组 = 明确 pass」 | **改替身**（让它抛错），**不是**改档位 |
| `robot.pool.test.ts:67` | `expect(personality.errorRate).toBe(0.15)` | 随 D9 删 |
| `robot.pool.test.ts:384-398` | `random=0.6` 断 `intermediate`（D3）；`:388/:395` 的 errorRate（D9） | 两条归因分别改 |
| `robot-service/test/douzero.client.test.ts` | `model` 必填 ⇒ **编译红**（`tsc --noEmit`，CI 阶段 2） | 补 `model` + 扩看门狗键清单 |
| 🔴 `robot-service/test/douzero.client.test.ts:120-141`（**v2 补**） | 「throws on API error」的替身是 `{ok:false,status:500,statusText:…}`、**没有 `text()`**，而 A3 要求「先读 body 再抛」⇒ `response.text is not a function` ⇒ `rejects.toThrow('DouZero HTTP 500')` **运行红**（阶段 4 可见） | 给替身补 `text: async () => '…'`；**只补 `model` 不够** |
| 🔴 `robot-service/test/robot.rpc.test.ts:51-58` + **`robot.decide.test.ts:206`**（**v3 补**） | `robot.decide.test.ts:206` 是 `new RobotService(bot, fakePool)`（**全仓唯一直接构造**，2 参）；A7 把 A6 加进 `RobotService` ⇒ **构造参数 +1** ⇒ 编译红 | 补第 3 个参数（A6 的 stub）。⚠️ `robot.rpc.test.ts:51-58` 是 **`useValue` 替身、无直接构造** ⇒ 它**本就不红**（v4 订正：v3 误把它也叫「构造点」） |
| 🔴 **`room-service/test/match.service.test.ts` 的 `:306`/`:665`/`:1263`** 与 **`message.router.test.ts:998`**（**v3 补前三条、v4 补第四条**） | B1 给 `MatchService` 加第 5 参（`RobotClient`）⇒ **四处** 4 参构造全红（tsc，阶段 2） | 四处补 `robot` 替身。⚠️ **这一类已连续三轮在漏**（v2 漏两条 → v3 补两条又漏一条 → v4 补上）⇒ 实现时**先全仓搜一遍** `new MatchService(` / `new RobotService(` |
| `protocol/src/messages.test.ts:52-63` | 八键精确集 | **翻**为九键 |
| `protocol/src/robot.test.ts:58` | 夹具含 `errorRate` | 删子字段 |
| room-service 四处 fixture（`match.service.test.ts:212` / `robot.client.test.ts:127` / `rooms.autostart.test.ts:222` / `rooms.start.test.ts:37`） | 同上 | 同上 |
| `slice-11` 的 idem 判据（`:929-1084`，断言在 `:1006-1008`） | 只断 `botId`/`displayId` | **加** `skillLevel` 断言（旁证；主判据是 J5c） |
| `match.service.test.ts` 的 **14 处**越窗用例 | 替身默认回 `{ok:true,data:{}}` ⇒ 命中「字段缺失 ⇒ 能给」 | **不改**（这正是 D5 那条 fail-open 规则的用途）；但要确认全绿 |

### 4.2 新夹具/道具

| 需要什么 | 用途 | 落点 |
|---|---|---|
| `makeDouZeroStub()`（六态 fetch 替身） | J10 | `robot-service/test/helpers/` |
| availability 假 RPC（可答 true/false/抛错/**缺字段**） | J6/J7/J8/J9/J20 | 🔴 **`makeFakeProxy` 定义在 `room-service/test/match.service.test.ts:226`**（不在 `test/helpers/`）⇒ 扩它，或把新替身放进 `test/helpers/`（目录已存在，现有 `config-client.stub.ts`/`fake-redis.ts`/`internal-token-harness.ts`/`room-fixture.ts`） |
| 确定性 random 序列 + **计数桩** | J3/J5/J5b/J5c | robot-service vitest 内联 |
| `docker compose run` 一次性容器封装 | J4/J12/J13/J22/J32 | conformance（照 `slice-07.2-deploy` 的 `runOneShot` 形态） |
| **A6 的 stub**（`DouZeroHealth` 替身） | `robot.decide.test.ts:206` 补构造参数用 | `robot-service/test/helpers/` |

---

## 5. conformance

- **新片 `slice-13-ai-rollout`**（`slice-12` 已被手动进房占用）：J11（并发，**容器内 vantage**）、J12（未知 model）、J13（只读挂载缺模型）、J32（缺一个 ⇒ 补下）。
- **slice-11 扩展**：`runDouZeroContract` 里加 J26（`/health` 清单三档 × 三名字）、J33（不带 model ≡ WP，用 §3 的判别局面）；**不加** J17（既有第 4 组已覆盖）。
- **登记点**：`tools/conformance/src/run.ts` 的 import 区（`:29`）与 `CASES`（`:37-55`）。
- **baselines.json**：`full` 列**必须由 CI 运行回填**（`_backfill` 明写不得用本机读数）；本机跳过 14 条断言。
- ⚠️ **J26 是本片唯一「实现前必红」的判据**（真栈 `/health` 现在没有 `models` 键）⇒ 计划里必须排在 **douzero 镜像重建之后**。
- ⚠️ **不停真栈容器**（`slice-07.5` 的纪律）；一次性容器🔴 **命名与纪律两个先例分别挂在两处**（事实核查 P3 订正）：**命名**先例 = `slice-07.2-deploy.ts:202/:461` 的 `ftl-conformance-*`；**纪律**先例 = `slice-07.3-edge` 的「先 `docker rm -f` 同名残留 + 后置无残留断言」（`:226`/`:409-413`），它自己的容器名以 `ftl-` 开头（`ftl-edge-env-scan`）。

---

## 6. 部署与回滚

**上线顺序**（7 个镜像同版本；`docker compose pull` + `up -d`）：
0. 🔴 **本机开发栈：`docker compose build douzero` + `up -d --force-recreate douzero`**（模型布局变了，旧镜像认不出新目录；⚠️ 不带 `--force-recreate` compose 会判「无变化」⇒ 本机 conformance/J26 会打旧镜像）；
1. CI 构建 7 镜像并推 GHCR（douzero 镜像**变大** ≈ +35 MB）；
2. 服务器 `docker compose pull` → `up -d`；
3. **douzero 先起**（game/robot 的 `depends_on: service_healthy` 会等它）；
4. 起完立即验 `/health` 的 `models` 三档齐备（人工一次，或直接看 conformance 的 J26）。
⚠️ **回滚的例外**：回滚**只能用「拉旧 tag 的镜像」**，**不得**用当前检出重建旧 tag —— 新 `server.py` + 新布局的镜像配旧 tag 会自己骗自己（老代码认不出新目录 ⇒ 全档缺失）。

**回滚**：`IMAGE_TAG=<旧版本> docker compose up -d`（镜像不可变，回滚 = 换 tag）。⚠️ **Redis 里的老 `BotInstance`**（带 `errorRate`）新代码读得动；**反向**（新记录被旧镜像读）也安全（本片只删不加）。

**新 env 的两处默认值**：不配 = `ROBOT_RULE_FALLBACK=true`（与今天一致）、比例 = 用户裁决 10 的那组（**行为变更**：advanced 15% → 50%）。

---

## 7. 兼容面（可测的部分）

| 组合 | 判据 |
|---|---|
| 旧 robot-service + 新 douzero（不带 `model` ⇒ WP） | **J33** |
| 老 Redis 记录 | **J24** |
| 新客户端 + 老服务端（无中文文案） | 本地文案表仍给中文（客户端单测） |
| 新 room-service + 老 robot-service | **J8**（未知 pattern ⇒ fail-open，替身形状照 `lib/rpc.ts` 的实测枚举） |
| 新 robot-service + 旧 douzero | ❌ CI 无旧镜像，**只能靠推理**（如实标注） |

---

## 8. 明确不做

1. 真·配置中心 / 好友房开关（裁决 12/15）。
2. 多进程 worker（裁决 8）。
3. 抽档按可用模型过滤（R11；替代方案留作 refinement）。
4. 跨队列的重复 12007（R12；只修重叠轮那条）。
5. 推送 `system.error` 全量走 `CLIENT_ACTION`（导航副作用，登记）。
6. `store.notices` 渲染点、`thinkingSpeed` 接线、`intra_op`、5s/30s 的既有超时值。

---

## 9. 风险

| # | 风险 | 处置 |
|---|---|---|
| S1 | **默认比例反转**（advanced 15%→50%）上线即生效 | R5 + J3；用户已裁 |
| S2 | 客户端文案改动会动到别的 TOAST 码 | 只加 `MATCH_TIMEOUT` 一行 + `actionCopyFor`；两处格式化分叉**本片不修**（R15） |
| S3 | conformance 的 slice-13 会让 `baselines.json` 先报「未回填」 | 由 CI 运行回填（**不得**用本机读数） |
| S4 | doubling 的模型入库 +35 MB | R6；将来可迁 LFS |
| S5 | 实现期若发现设计层的写死与真实代码冲突 | **停下报我**，不自行改设计（片① 的教训：文本会照字面传播） |
| S6 | 设计层 **R1**（裁决 4 的前提被实测推翻）· **R3**（三档体感区分度可能不足）· **R7**（`sl` 强度未实测） | 已在设计层 §2/§9 呈报；本规格不新增判据（属产品观察项） |
| S7 | 设计层 **R8**：门禁失败走**终局路径**（`failMatch` 删 `match:meta`）⇒ **不累积 `attempts`**、无退避 | 写进运维手册（「开关 OFF + DouZero 长时间不可用 = 玩家反复等 30s 得 12007」）；J6 已钉语义 |
| S8 | 设计层 **R13**：B1 的调序带来新代价 —— 进程在 `zrem` 与 `publish` 之间崩溃 ⇒ 该票**静默丢失** | 取舍已登记（宁可丢一条通知，不可重复发）；**不写判据**（进程崩溃不可测） |

---

## 10. 下一步

1. **本文过审**（审查 → 用户过目）；
2. `superpowers:writing-plans` 出**实施计划**（任务切分 + 每任务的判据 + 依赖顺序）；
3. 计划过审 → 按计划实现（子 agent，用 `task-brief` / `review-package`）→ 逐任务审查 → 全量验收 → 整支终审 → 收口。
