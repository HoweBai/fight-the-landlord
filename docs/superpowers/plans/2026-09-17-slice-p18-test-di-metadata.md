# 切片 P18 实施计划：让测试环境发出 DI 元数据（N41 收口）

**Goal:** 让**测试环境**具备与产品相同的 DI 元数据产生机制（`emitDecoratorMetadata`），
**拆掉 7 处 `Reflect.defineMetadata('design:paramtypes', …)` 垫片**，
并加一条机械闸防止垫片复活 —— 使「装配测试」测的是**产品真实发出的 metadata**，而不是测试自己写进去的那份。

**为什么现在做**（`deviation-ledger.md` **N41**，本片开工前协调者已复现）：
`Reflect.getMetadata('design:paramtypes', X)` 在本仓测试环境**恒为 `undefined`**
—— Vitest/esbuild **不发出** `emitDecoratorMetadata`（实测探针：`[P16 探针] design:paramtypes = undefined`；
esbuild 的 `.d.ts` 里**没有**这个选项）。而全仓有 **5 个测试文件（7 处）**用 `Reflect.defineMetadata(...)` 手工补回：

| 文件 | 补的 token |
|---|---|
| `api-gateway/test/health.test.ts` | `[HealthService]` → `HealthController` |
| `api-gateway/test/gateway.controller.test.ts` | `[ProxyGatewayToken]` → `GatewayController` |
| `api-gateway/test/ws-allow-request.test.ts` | （多行写法，同族） |
| `game-service/test/game.rpc.test.ts` | `[GameService]` → `GameRpcController` |
| `game-service/test/game.controller.test.ts` | `[GameService]` → `GameController` |
| `game-service/test/game.module.wiring.test.ts` | ×2：`GameController` / `GameRpcController` |
| `robot-service/test/robot.rpc.test.ts` | `[RobotService]` → `RobotRpcController` |

⚠️ **风险形态**：垫片把「期望的依赖清单」**写死在测试里** ⇒ 产品侧一旦漏了 `@Inject`、或构造参数顺序/类型变了，
**测试仍然绿**（它测的是刚写进去的那份 metadata）。⇒ 这是**真缺口**，不是测试写法问题。

## 绑定数值（本次实测）

| 项 | 数值 |
|---|---|
| 垫片数量 | **7 处**（5 个测试文件；3 个包：api-gateway / game-service / robot-service） |
| 需要该插件的包 | **5**：api-gateway · game-service · room-service · robot-service · user-service（都含 Nest 装饰器 DI） |
| **不需要**的包 | `shared` · `protocol` · `tools/mock-server` · `tools/conformance` · `apps/client`（无 Nest 装饰器 DI） |
| 各包 `vitest.config.ts` 现状 | **都没有** `setupFiles` |
| `reflect-metadata` | 各 Nest 包**已有**该依赖（无需新增） |
| 可行性 | **协调者已探针验证**：`ts.transpileModule` + `experimentalDecorators` + `emitDecoratorMetadata` 挂在 Vite 插件里 ⇒ `HealthService` 的 `design:paramtypes` 从 `undefined` 变为 `["Object","DataSource"]`（**零新依赖**：`typescript` 已在每个包） |
| 已用最大裁决号 | **R560**（P17 计划区间尾） |

## 裁决（本片新增，执行时不得再自行解释）

- **R561 用「零新依赖的 TS 转换插件」，且全仓只有一份**：新建
  `scripts/vitest-plugins/emit-decorator-metadata.ts`（`scripts/**` 归协调者，本片授权实现者新建**这一个文件**），
  内部用 `typescript` 的 `transpileModule`，只对**工作区内、含 `@Injectable|@Controller|@Module|@Inject` 的 `.ts`** 生效；
  5 个包的 `vitest.config.ts` **各自 import 这一份**。
  **不许**在包里各抄一份（本仓为「第二真源」付过多次代价）；**不许**新增 `@swc/core`/`unplugin-swc` 等依赖
  （可行性已用零依赖路径证明，且本片不值得为此动 lockfile）。
  代价若判错：`transpileModule` 与被 esbuild 转译的文件在**语义上可能有细微差异**（见 R566 的验证要求）。
- **R562 `reflect-metadata` 必须先于被装饰的类求值**：5 个包的 `vitest.config.ts` 加
  `setupFiles: ['reflect-metadata']`（路径以各包解析为准）。
  依据：`emitDecoratorMetadata` 编译出的 `__metadata` 助手是
  `if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v)`——
  **reflect-metadata 未先加载时它会静默 no-op**（元数据又变 `undefined`，而测试可能仍然绿）。
  代价若判错：插件看起来「没生效」，排查成本高（所以要有 R565 的正对照）。
- **R563 拆垫片是本片的核心判据，且拆完的红必须先定性**：7 处全部删除。
  拆完若有用例红，**先判定**属于哪一类，并在报告里逐条写：
  ① **产品缺 `@Inject` / 构造参数与 `providers` 不匹配**（真缺陷）⇒ **停下报告**、按真缺口登记，
  **不许**为了过测试而把垫片加回来；
  ② **测试自己的期望写错**（例如 provider 列表与真实依赖不符）⇒ 修测试，并写明「语义不变」的论证；
  ③ **插件本身的问题**（元数据发出来了但形态不对）⇒ 修插件。
  代价若判错：拆垫片会暴露一批红 —— 那正是本片的价值，不是失败。
- **R564 机械闸（防复活）**：新增判据：`packages/*/test/**` 与 `tools/*/test/**`
  **不得**再出现 `Reflect.defineMetadata('design:paramtypes'`（**剥注释**后扫描，避免「解释这个坑」把闸打红）。
  必须带**判别力自证**（合成样本必须报错）。
- **R565 正对照（证明环境真的发出了元数据）**：至少一条用例**直接断言产品侧的真实元数据**
  （例如 `Reflect.getMetadata('design:paramtypes', GameController)` 为 `[GameService]` 这种**非 undefined** 的值），
  且**不许**在同一条用例里先 `defineMetadata`（否则又是自证）。
  依据：R562 的坑会让插件「看起来生效、其实 no-op」——没有这条正对照，整片可能是一场空测（P14 教训 2 的同族）。
- **R566 只测链路改动 ⇒ 门禁取轻量版，但必须有「未跑及理由」**：
  本片**只动** `scripts/vitest-plugins/**`、5 个包的 `vitest.config.ts`、`packages/*/test/**`；
  **不得**动 `src/**`（`git diff --name-only | grep src/` 必须为 0）⇒ 运行时行为零变化 ⇒
  conformance / docker 重建 / 真浏览器探针**信息量为零**、明确不跑（在报告与回填区写明）。
  同时**必须记录**：① 每个包 `pnpm test` 的用例数与耗时（插件会多一次 TS 转译，**要给出改前/改后对比**，
  若某包启动显著变慢要写明数值）；② `turbo run test lint --force` 与 `pnpm run ci` 全绿。
  代价若判错：`transpileModule` 的语义差异只在测试里可见 —— 用「用例数与判据都不变 + 全绿」兜住。

## Tasks

### Task 1（实现者）：插件 + 接线 + 正对照
- [x] 新建 `scripts/vitest-plugins/emit-decorator-metadata.ts`（R561），并在文件头写清「为什么不能用 esbuild 的选项」
- [x] 5 个包的 `vitest.config.ts`：挂插件 + `setupFiles: ['reflect-metadata']`（R562）
- [x] 加 **R565 正对照**用例（直接断言产品侧元数据非 `undefined`，同一文件里**不得**出现 `defineMetadata`）
- [x] 判据：5 个包 `pnpm test` 全绿；**用例数只增不减**

### Task 2（实现者）：拆 7 处垫片 + 定性红
- [x] 删除 7 处 `Reflect.defineMetadata('design:paramtypes', …)`（**只删这些行/注释，不动判据**）
- [x] 若红：按 **R563** 的三分类逐条定性并写进报告（① 类必须停下报告）
- [x] 加 **R564 机械闸**（带判别力自证）
- [x] 判据：5 个包 `pnpm test` 全绿；用例数与 Task 1 后一致或更多

#### Task 1+2 实测（2026-09-17，实现者交付 + 1 轮修复 + 协调者独立复核）

**交付**：`d755382` 插件 + 5 包接线 + 正对照 · `6739009` 拆 7 处垫片 + 机械闸 · **`afaa33c` 修复轮 1**（过期注释 + 断言升级）。
**BASE = `506a045`。**

| 项 | 读数 |
|---|---|
| 用例数 | **577 → 582**（api-gateway 149→**151** · game-service 107→**110** · room 219 · robot 58 · user 44；**只增不减**） |
| 耗时（test 命令） | 每包 +0.2~0.6s（插件的 `transpileModule` + `reflect-metadata` 首载）；`turbo run test lint` 总 52.3s |
| `src/**` 改动 | **0 行**（`git diff --name-only 506a045..HEAD \| grep src/` = 0） |
| 依赖/lockfile/根配置/`apps`/`tools` | **0 改动** |
| 插件份数 | **1**（`scripts/vitest-plugins/emit-decorator-metadata.ts`；5 个包的 `vitest.config.ts` 各自 import 它） |
| 门禁（协调者实跑） | `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` **六阶段全绿** |

**拆垫片时唯一的红（R563 定性的样本）**：`api-gateway/test/gateway.controller.test.ts` 报
`Nest can't resolve dependencies … ProxyGateway at index [0]` ⇒ 定性为 **② 测试自己的期望写错**：
产品的构造签名就是 `GatewayController(proxyGateway: ProxyGateway)`，插件发出的元数据与它**逐字一致**；
错在这条测试把替身挂在**自造的 `ProxyGatewayToken`** 上。修法 = 挂到产品真实 token（`useValue` 不需要容器构造它），
**17 条判据一字未改、17/17 绿**。
⚠️ 这条红本身就是 N41 的价值证明：**垫片旧写法掩盖了「测试绑的 token 与产品真实依赖不是同一个」这件事**。

**修复轮 1（我复核其报告后指派的，范围三件）**：
1. **11 处过期注释统一改写**（原话「Vitest/esbuild 不发出 `design:paramtypes`」在 P18 后已不成立）；
2. **`room-service/test/ws.module.wiring.test.ts:149-152` 的断言升级为更强形态**（实测驱动）：
   该处原注释断言「`design:paramtypes` 读不到内部 token、只会是 `Object`」——**实测两条都不成立**：
   `design:paramtypes = ["Redis","MatchService2","ReconnectService2","RoomsService2","GameClient2","RobotClient2"]`（长度 6），
   且下标 4/5 是 `GameClient`/`RobotClient` 的**真实类引用**。机制（读插件产物确认）：tsc 对
   `@Inject(字符串 token)` 的参数**也**发类型元数据（`__param(i, Inject(TOKEN))` 与 `__metadata("design:paramtypes", […])` 并存）。
   升级 = `self:paramtypes` **原样保留** + **新增 3 条** `design:paramtypes` 断言（非 undefined / 长度恰 6 /
   token 下标处是函数）⇒ 把「构造签名形状」与「该机制本身」钉成回归判据。
   **无断言被删或弱化**（复核：`git diff -U0 506a045..HEAD -- packages/*/test | grep '^-' | grep -E "expect\(|it\("` = **空**）。
3. 协调者裁决「不动」两条：21 处冗余 `import 'reflect-metadata'`（无害且自解释）· 插件纯函数未单测
   （由 R565 正对照 + R564 机械闸 + 5 包全绿端到端覆盖）。

### Task 3（协调者）：门禁 + 收口
- [ ] 轻量门禁（R566）+ 独立复核（`src/**` 0 行、无新依赖、插件只有一份）
- [ ] 台账 **N41 → 已关闭**（附证据）· §0 重算 · `design.md` §13.1/§13.2 若提到「测试环境不发出元数据」则同步
- [ ] `agent-briefs.md`：环境事实（这条坑 + 插件位置 + reflect-metadata 顺序）+ 门禁实测 + 教训

## 门禁（R566）

```bash
cd /home/howe/pokergame
git diff --name-only <BASE>..HEAD | grep -E "packages/[^/]+/src/|apps/[^/]+/src/" | wc -l   # ✅ 必须为 0
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
pnpm run ci                                  # ✅ 六阶段全绿
# 逐包用例数与耗时对比（改前/改后）—— 写进报告
```

**明确不跑**：conformance / `docker compose build` / 真浏览器探针 —— 本片零运行时改动（`src/**` 0 行），
三者信息量为零；**必须在报告与回填区写明「未跑及理由」**。

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加并编号：本片协调者区间 **R561–R575**。）

- **R567**（协调者，执行期，**修复轮 1**）**「机制换了之后，注释与断言会一起过期」在本片按一个可交付项处理**。
  依据：本片换掉测试环境的元数据机制后，全仓有 **11 处注释**仍在说旧结论，其中
  `room-service/test/ws.module.wiring.test.ts:149-152` 的注释性**断言**（「读不到 token、只会是 `Object`」）
  在 `design:paramtypes` 真的发出来之后**实测已不成立**（实测：长度 6、下标 4/5 是真实类引用）。
  处置：① 注释统一改成新事实并保留**真实选型理由**（手搭 Nest 装配是**选型**，不再是**绕坑**）；
  ② 那处断言**升级为更强形态**（原地新增 3 条 `design:paramtypes` 断言，**不删不弱化**；
  复核证据：`git diff -U0 506a045..HEAD -- packages/*/test | grep '^-' | grep -E "expect\(|it\("` = 空）。
  代价若判错：注释比代码乐观 —— 所以升级的 3 条是**实测驱动**的，机制形态变会红。
- **R568**（协调者，执行期）**21 处冗余 `import 'reflect-metadata'` 与「插件纯函数无直接单测」两条「不动」**。
  依据：前者无害且自解释（删它要动 21 个文件、换不来任何判别力）；后者由 R565 正对照 + R564 机械闸 +
  5 包端到端全绿覆盖（本仓规矩是「闸要有牙」，不是「每个纯函数都要单测」）。
  代价若判错：插件退化时靠端到端红（已有正对照，不会静默）。
