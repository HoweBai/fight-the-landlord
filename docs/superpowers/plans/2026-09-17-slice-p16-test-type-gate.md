# 切片 P16 实施计划：给 `test/**` 加类型闸（R481 收口）

**Goal:** 让**每个包含 `test/` 的包**都有 `tsconfig.test.json`，把 `test/**` 纳入类型闸并接进
`turbo run lint`（⇒ 六阶段 CI 的第 2 阶段覆盖它），**修掉暴露出的全部类型错误**；
闸的判别力用「**种错必红**」自证。

**为什么现在做**：P12 登记（**R481**）——`game-service` 的 `test/**` 不受任何类型闸管辖
（`tsconfig.json` 的 `include` 只有 `src/**`，`lint` = `tsc --noEmit`，vitest 走 esbuild 也不查类型）
⇒ **夹具的形状漂移长期不可见**（P12 实测 `view.builder.test.ts` 的 `makeSession()` 缺
`baseScore`/`turnDeadlineAt`、多一个已删的 `deck`、`createdAt` 还是 `Date`；当时只补了夹具、**未立条**）。
**本片开工前实测：这不是一家的问题 —— 9 个包全部 `include: ["src/**/*"]`，全仓没有任何 `tsconfig.test.json`。**

## 绑定数值（全部为本次实测，不得口头漂移）

| 项 | 数值 | 来源 |
|---|---|---|
| 有 `test/` 目录的包 | **7**：`api-gateway`(15 文件) · `game-service`(17) · `room-service`(17) · `robot-service`(11) · `user-service`(8) · `shared`(1) · `tools/mock-server`(1) | `find <pkg>/test -name '*.test.ts'` |
| 已被覆盖、**不动**的包 | `apps/client`（`tsconfig.json` 的 include 已含 `test/**`）· `packages/protocol`（4 个测试全在 `src/**`）· `tools/conformance`（无 `test/` 目录） | 同上 |
| 探针口径下的错误数（`module: NodeNext` 照抄包配置） | game 21 · room 17 · gateway 19 · robot 5 · user 3 · shared 1 = **66** | 临时 `tsconfig.testprobe.json` 实跑 |
| 错误码分布（同上） | TS2835×7 · TS7006×12 · TS1470×7 · TS2322×12 · TS2345×7 · TS2352×4 · TS18048×2 · TS6133×5 · TS7016 · TS7053 · TS2769 · TS2304 · TS2554 · TS2307 · TS1309 | 同上 |
| 换成 vitest 真实解析语义后的错误数 | gateway **36** · room **16** · game **13** · robot **3** · user **1** = **69**（TS1470/TS2835 全部消失，剩下的是**真的类型不匹配**） | 同上 + `module: ESNext` / `moduleResolution: Bundler` |
| 已用最大裁决号 | **R540**（P15 计划） | `grep -rho "R[0-9]\{3\}" docs/ \| sort -n \| tail` |
| 本片协调者区间 | **R541–R550** | 上一条 |

## 裁决（本片新增，执行时不得再自行解释）

- **R541 测试配置用 vitest 的真实解析语义**：`tsconfig.test.json` 里显式写
  `"module": "ESNext"` + `"moduleResolution": "Bundler"`（**不**照抄包的 `NodeNext`）。
  依据：实测 66 处里 **7 处 TS1470（`import.meta`）+ 7 处 TS2835（NodeNext 要求显式 `.js` 后缀）**
  全是**解析语义错配**，不是代码缺陷 —— vitest 用 esbuild + 类 bundler 解析，`import.meta` 与无后缀相对导入
  在测试里本来就能跑。把测试按 NodeNext 检查等于**用错的尺子量**，会逼人给测试加 `.js` 后缀这种纯噪音改动。
  ⚠️ **src 仍由既有 `lint`（NodeNext）守**，语义不丢（见 R542）。
- **R542 接线：`lint` 跑两遍 tsc，不改 `ci.sh`**：各包 `"lint": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json"`。
  依据：① `turbo run lint` 就是 `scripts/ci.sh` 第 2 阶段，**不动 §13.4 的六阶段脚本**（少一处规格偏离）；
  ② 两把尺子各量各的（NodeNext 量 src，Bundler 量 src+test），不互相掩盖。
  代价若判错：每包多一次 tsc（实测约 2–5s，7 包合计 < 30s）。
- **R543 白名单/降级策略（闸必须仍然有牙）**：
  - **我们自己的类型（协议载荷、store/view、内部接口）**：**必须精确** —— 夹具缺字段/字段类型错**一律改夹具**，
    **不得** 用 `as`/`any`/`@ts-ignore` 绕过；
  - **第三方接口的测试替身**（ioredis `Redis`、socket.io `Socket`、express 的 `Request/Response` 等）：
    允许**一处**带注释的 `as unknown as X`（替身**故意**只实现子集，这是行业常规），但必须写明「为什么无法结构性满足」；
  - **禁止** `@ts-ignore`；`@ts-expect-error` 只允许在**故意断言错误用法**的用例里出现，
    且**逐条列进报告**（数量与位置）；
  - 报告必须给出**三类计数**：改夹具 N1 / 加替身 cast N2 / 其它（并说明）N3，且 `N1+N2+N3 = 总错误数`。
- **R544 判别力自证（本仓硬规矩）**：闸必须有「种错必红」的证据，**两条**：
  ① 在一个**协议载荷夹具**里删掉一个必填字段（或改错类型）⇒ `pnpm --filter <pkg> lint` 当场红；
  ② 在 `src/**` 里种一个类型错误 ⇒ 同一命令红（证明 R542 的两遍都真的在跑）。
  证据取**原文**（命令 + 输出尾部），随后**还原**。
- **R545 覆盖范围一次到位**：7 个包全做（不允许「只做 game-service」）。
  依据：R481 的**实质**是「夹具漂移不可见」，而漂移不挑包；只做一家等于把同一类风险留给其余六家。
- **R546 不改产品代码来迁就测试**：若某处错误只能靠改 `src/**` 的类型才能修，**停下报告**（那属于设计变更，
  要另立片裁决），不得为了过闸放宽产品类型。

## Tasks

### Task 0（协调者）：覆盖面与口径复核 —— **已完成（见上表）**
- [x] 枚举哪些包的 `test/**` 未受闸；确认 `client`/`protocol`/`conformance` 已被覆盖
- [x] 两种口径下的错误数与错误码分布（NodeNext 66 / vitest 语义 69）

### Task 1（协调者）：配置层 + 接线 + 种错证牙
- [x] 7 个包各加 `tsconfig.test.json`（`extends: "./tsconfig.json"`，`noEmit`，`rootDir: "."`（不落盘），
      `module: ESNext`，`moduleResolution: Bundler`，`include: ["src/**/*", "test/**/*"]`）
- [x] 7 个包的 `lint` 改成 R542 的双 tsc
- [x] **R544 的两条种错证据**（原文 + 还原）
- [x] 判据：`pnpm exec turbo run lint --force` **在修错之前**必须**红**（列出错误数），这本身就是闸生效的证据

#### Task 1 实测（2026-09-17，协调者；commit `c52b34c`）

```bash
pnpm exec turbo run lint --force --continue      # ❌ EXIT=2（**闸生效**）
# 逐包错误数（改前）：api-gateway 36 · room-service 16 · game-service 13 · robot-service 3 · user-service 1
#                    = **69**；shared / mock-server **0**（不用动）
```

**R544 判别力自证（两条原文，随后均还原、工作区干净）**：

```
① 夹具漂移（我们自己的类型）：packages/game-service/test/view.builder.test.ts 的 `version: 7` → `'7'`
   ⇒ test/view.builder.test.ts(34,5): error TS2322: Type 'string' is not assignable to type 'number'.
② src 里的错误（证明第一遍 tsc 也在跑）：packages/user-service/src/main.ts 末尾种 `const __p16Probe: number = "not-a-number";`
   ⇒ src/main.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.
   ⇒ src/main.ts(42,7): error TS6133: '__p16Probe' is declared but its value is never read.
```

⚠️ **一处执行期澄清（R541 的边界）**：两种口径下的错误数**不是同一个集合** —— 照抄包配置（NodeNext）时是 **66** 处
（含 7 处 `import.meta` 的 TS1470 与 7 处「相对导入要显式 `.js`」的 TS2835），换成 vitest 真实语义（Bundler）后是 **69** 处
（上面那 14 处噪音消失，反而多暴露了 api-gateway 的一批 `TS2345`——替身与真实接口不匹配）。
⇒ **R541 的价值就在这里**：用错的尺子量，会得到「一半是噪音、另一半被掩盖」的清单。

### Task 2（实现者）：修掉全部暴露出的类型错误（按包分批提交）—— ✅ 已完成
- [x] 逐包修到 `tsc --noEmit -p tsconfig.test.json` **0 错误**；遵守 **R543** 的三分类与禁令
- [x] 每包一个 commit，message 写明：错误数、三类计数、以及每一处替身 cast 的理由
- [x] 判据：`pnpm --filter <pkg> lint` 干净 + `pnpm --filter <pkg> test` 全绿（**用例数只增不减**）

#### Task 2 实测（2026-09-17，实现者交付 + 协调者独立复核）

**交付**：`b23b9ca` robot-service 3→0 · `a311a2c` user-service 1→0 · `9e93413` room-service 16→0 ·
`d161b86` game-service 13→11 · **协调者** `29e768c` 补 `@types/express@^4.17.0` ·
`f9ead13` api-gateway 36→0。

**三类计数总账（69 处）**：**改夹具 12 / 替身 cast 4 / 其它 42**（+ game-service 的 11 处属**「补依赖」**类）。
逐包：api-gateway 0/3/33 · game-service 0/0/2(+11) · room-service 12/0/4 · robot-service 0/1/2 · user-service 0/0/1。

**4 处替身 cast（全部在原地带「替身故意只实现子集、无法结构性满足」注释）**：
① `api-gateway/test/helpers/health-redis-double.ts` 的 `healthRedisInstanceAsRedis()`（替身只实现 ping/on/quit，`Redis` 有 440+ 成员）；
② `api-gateway/test/proxy.gateway.test.ts` 的 `makeClient`（替身 9 个成员 vs `Socket` 70+，**一处收口 24 个 TS2345**）；
③ `robot-service/test/robot.decide.test.ts` 的 `fakePool = {} as unknown as RobotPool`（用例只调 `decide`）；
④⑤ 同文件两处 `client.conn.on as unknown as { mock: { calls: … } }`（读 engine.io 真实类型上的调用记录）。

**协调者的独立复核（三条，都是重新实跑而不是采信报告）**：
```bash
git diff --name-only c52b34c..HEAD | grep -E "packages/[^/]+/src/" | wc -l   # ✅ 0（R546：src 一行未动）
git diff c52b34c..HEAD | grep -cE "^\+.*(as any|@ts-ignore|@ts-nocheck|\.skip\(|it\.todo)"   # ✅ 0（无静默手段）
pnpm exec turbo run lint --force --continue                                  # ✅ 12/12（7 包 × 双 tsc）
pnpm exec turbo run test lint --force                                        # ✅ 29/29、0 cached
pnpm run ci                                                                  # ✅ 六阶段全绿（阶段 2 已覆盖新闸；阶段 6 一条未放宽）
# 逐包用例数（与改前逐字一致，无删无跳）：149 · 107 · 219 · 58 · 44 = 577 → 577
```
**闸的判别力在「修完之后」又复证了一次**（R544 复证，防止「修完顺手把尺子改松」）：
把 `view.builder.test.ts` 的 `version: 7` 再改成 `'7'` ⇒ 仍然 `test/view.builder.test.ts(34,5): error TS2322`
（原文已取，改动已还原）。

**两条执行期发现（值得记住）**：
1. **`@types/express` 一到，game-service 的 11 处里 10 处（TS7006）零代码改动即消**：那 10 处是
   **TS7016 的派生**（声明文件缺席 ⇒ `express` 的返回值是 `any` ⇒ `app.get(path, handler)` 的回调拿不到上下文类型）。
   ⇒ 这类「隐式 any」先在**依赖/声明**层面找根因，不要在回调上逐个加显式标注（那是把根因留在原地）。
   game-service 因此**没有任何** `→ 0` 的代码 commit（依赖由协调者装），实现者**没有**用空 commit 去凑序列。
2. ⚠️ **`Reflect.getMetadata('design:paramtypes', X)` 在本仓测试环境恒为 `undefined`**（Vitest/esbuild **不发出**
   `emitDecoratorMetadata`）——协调者亲自复现：临时探针实测 `[P16 探针] design:paramtypes = undefined`，
   而全仓有 **7 个测试文件**用 `Reflect.defineMetadata(...)` 手工补回（`gateway.controller.test.ts` /
   `health.test.ts` / `ws-allow-request.test.ts` / `game.controller.test.ts` …）。
   ⇒ **登记 N41（仍开放）**：DI 装配类的回归在单测里**结构上抓不到**（垫片本身就把期望写死了）。

### Task 3（协调者）：门禁 + 收口

### Task 3（协调者）：门禁 + 收口
- [ ] 标准门禁（见下）；台账 **新登记 N40 并同片关闭**（R481 收口）；`design.md` §13.1/§13.4 若有「类型闸只覆盖 src」
      的断言则同步订正；`agent-briefs.md` 记环境事实 + 教训

## 门禁

```bash
cd /home/howe/pokergame
git diff --stat                                     # 只允许 packages/**/tsconfig*.json、各包 package.json、test/**、docs/**
pnpm exec turbo run build --force                   # ✅ 10/10
pnpm exec turbo run test lint --force               # ✅ 29/29、0 cached（lint 现在是双 tsc）
pnpm run ci                                         # ✅ 六阶段全绿（阶段 2 覆盖新闸；阶段 6 一条未放宽）
node scripts/ledger-counts.mjs                      # ✅ §0 与 §1.x 逐区一致
# 种错必红（R544）：两条，取原文后还原
```

**明确不跑**：`docker compose build/up`、conformance、真浏览器探针 —— 本片**不改任何运行时行为**
（只加类型闸 + 改测试里的类型），探针与 conformance 的信息量为零；**跑完必须补一句「未跑及理由」**。
（若 Task 2 的修复**碰到** `src/**`（R546 本应阻止），则恢复全量门禁。）

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加一条并编号：本片协调者区间 **R541–R550**。）

- **R547**（协调者，执行期）**`Reflect.getMetadata('design:paramtypes', …)` 在测试环境恒 `undefined` 这件事
  按「真缺口」登记，而不是按「测试写法」就地了结**（→ 台账 **N41**，仍开放）。
  依据：协调者亲自复现（临时探针 `[P16 探针] design:paramtypes = undefined`）+ 全仓 **7 个**测试文件
  用 `Reflect.defineMetadata(...)` 手工补回 ⇒ **DI 装配回归在单测里结构上抓不到**（垫片把期望写死，
  产品侧一旦漏了 `@Inject`/装饰器，测试仍绿）。
  **修法方向（留给下一片）**：给测试链路加 `emitDecoratorMetadata`（如 vitest 的 swc/ts 转换或
  `unplugin-swc`），**或**加一条源码级机械闸（每个 `@Injectable`/`@Controller` 的构造参数都必须在
  某个测试里被显式 `defineMetadata` 覆盖到 —— 让「垫片清单」与产品类清单互相自证）。
  代价若判错：多一条台账项；**不登记**的代价是这条缺口继续隐形（P8 教训 5 的同族）。
- **R548**（协调者，执行期）**game-service 不以空 commit 凑「→ 0」的序列**。
  依据：那 11 处是「补依赖」类（`@types/express` 到位即消，0 行代码改动），
  空 commit 会把「改了代码」的假象写进历史；事实记在该包的 `d161b86` message 与本计划的 Task 2 实测里。
  代价若判错：`git log` 里少一个「归零」锚点（用计划/台账补足）。
