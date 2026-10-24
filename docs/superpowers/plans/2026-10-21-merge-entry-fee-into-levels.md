# 台费并入底分档位表（方案 A 阶段 1）— 实现计划

- 日期：2026-10-21
- 对应 spec：`docs/superpowers/specs/2026-10-21-merge-entry-fee-into-levels-design.md`（r1 + r2 审查记录）
- 分支：`dev`；每个任务一个 commit
- 用户裁决：方案 A；客户端零改动；阶段 2（删旧键）另立片

## Global Constraints

1. **不改客户端代码**；`/api/config` 的 `entryFeePercents` 形状不变（派生输出）。
2. **旧键 `currency.entryFeePercents` 阶段 1 只读**：读/快照保留，写入一律 400。
3. **旧形态档位表写入一律 400**：提交数组所有条目都缺 `entryFeePercent`（旧 admin 页面）⇒ 拒绝，
   不落库、不静默清零。
4. parser **必须写回** `entryFeePercent`；缺省时不写 `undefined` 自有属性。
5. 派生逻辑唯一实现 = `entryFeePercentsFromLevels`。
6. 失败方向：room 收费 `[]`（不收）；config 输出 `[]`（不 500）；建房仍 10007。
7. 测试走 turbo（`test` 依赖 build，避免旧 dist 假绿）：
   `pnpm exec turbo run test lint --filter=./packages/<pkg> --force`。
8. 每个任务：先改/加测试 → 跑红（写明 RED 形态）→ 最小实现 → 跑绿 → commit。
9. 不夹带阶段 2（不删键、不改键数、不写迁移）。
10. 最终：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、`pnpm verify:admin`。

---

## Task 0 — spec + 计划落盘

提交 spec（含 r1/r2 审查记录）与本计划。Commit：
`docs(spec+plan): 台费并入档位表（方案 A 阶段 1）+ 对抗审查`

---

## Task 1 — protocol：类型、parser 写回、派生 helper

**Files**

- `packages/protocol/src/config.ts`
- `packages/protocol/src/config.test.ts`

**TDD**

1. 加测试（RED）：
   - `parseBaseScoreLevels` round-trip：
     - `[{name:'休闲场',baseScore:15,entryFeePercent:10}]` ⇒ `toStrictEqual` 保留字段；
     - `[{name:'休闲场',baseScore:15}]` ⇒ 结果对象**不含** `entryFeePercent` 自有属性
       （`toStrictEqual` 判别，不用 `toEqual`）；
     - 0 / 50 通过；-1 / 51 / 1.5 / `'10'` / `null` ⇒ 抛。
   - `entryFeePercentsFromLevels`：
     - `[{15,10},{80}]` ⇒ `[{15,10},{80,0}]`；空表 ⇒ `[]`；顺序保持。
2. 跑 protocol → RED（parser 当前丢弃字段 / helper 不存在）。
3. 实现：
   ```ts
   export interface BaseScoreLevel { name: string; baseScore: number; entryFeePercent?: number }
   export function entryFeePercentsFromLevels(levels: ReadonlyArray<BaseScoreLevel>): EntryFeePercent[] {
     return levels.map((l) => ({ baseScore: l.baseScore, percent: l.entryFeePercent ?? 0 }));
   }
   ```
   - `parseBaseScoreLevels`：`entryFeePercent !== undefined` 时校验整数 0–50（`null` 不是 undefined ⇒ 拒绝）；
     校验后 `const out: BaseScoreLevel = { name, baseScore }; out.entryFeePercent = entryFeePercent;`
     （仅当定义时写）。
4. 重跑 → GREEN；lint。
5. Commit：`feat(protocol): 档位项支持 entryFeePercent 并提供派生 helper`

---

## Task 2 — config-service：派生输出 + 两道写守卫

**Files**

- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/config/platform-config.service.ts`
- `packages/config-service/test/client-config.test.ts`
- `packages/config-service/test/config.validation.test.ts`
- `packages/config-service/test/platform-config.service.test.ts`
- （必要时）`packages/config-service/test/admin.controller.test.ts`

**TDD**

1. 改/加测试（RED）：
   - `client-config.test.ts`：
     - 库中 levels 带 `entryFeePercent:10` ⇒ 输出 `entryFeePercents` 含 `{15,10}`；
     - 旧键设为非零、levels 全 0/缺字段 ⇒ 输出全 0（旧键不再被读）；
     - levels 非数组/坏元素 ⇒ `baseScoreLevels: []` + `entryFeePercents: []`（200，不 500）。
   - `config.validation.test.ts`：
     - 既有档位夹具补 `entryFeePercent: 0`（保持原验证目的）；
     - 新增：PUT levels **全部缺** `entryFeePercent` ⇒ 400 且库未变；
     - 新增：PUT `currency.entryFeePercents` ⇒ 400（旧键只读）；
     - 新增：PUT levels 带 `entryFeePercent:10` ⇒ 200，GET 读回含字段。
   - `platform-config.service.test.ts`：
     - `set('currency.entryFeePercents', …)` / `set('game.baseScoreLevels', 旧形态)` ⇒ ProtocolError，
       且**不发生锁定读/UPDATE/INSERT/留痕**（守卫在 parse 之前）。
     - 守卫**在 parse 之前**的判别：旧键传一个 parse 本身会拒的值（如 `'x'`）⇒ message 含「已并入」
       而不是「必须是数组」；旧形态且 baseScore 重复 ⇒ message 含「缺少 entryFeePercent」
       而不是「唯一」。
     - 带任一 `entryFeePercent` 的 levels ⇒ 成功；缺字段条目按 0（读回值缺字段）。
2. 跑 config-service → RED。
3. 实现：
   - controller：`parseConfigValue('game.baseScoreLevels', raw ?? [])` try/catch；
     `baseScoreLevels: levels`、`entryFeePercents: entryFeePercentsFromLevels(levels)`；删旧键读取与旧注释。
   - `platform-config.service.set`：在 `parseConfigValue` **之前**加 D14/D13 两道守卫
     （spec §4.3 代码形状；`isLegacyShape` 用 `Array.isArray` + `'entryFeePercent' in item`）；
     导入 `ProtocolError`。
4. 重跑 → GREEN；lint。
5. Commit：`feat(config): 费率改由档位表派生，旧键与旧形态写入拒绝`

---

## Task 3 — room-service：收费数据源改为档位表派生

**Files**

- `packages/room-service/src/config/config-cache.service.ts`
- `packages/room-service/test/config-cache.test.ts`

**TDD**

1. 加测试（RED）：
   - **删除/重写** `config-cache.test.ts:573-625` 的「旧键 reader」整块（它以
     `snapshotWith({ 'currency.entryFeePercents': [...] })` 驱动并断言返回旧表；新实现必红，
     不得保留旧键回退）：
   - levels `[{15,10},{80}]` ⇒ `entryFeePercents()` = `[{15,10},{80,0}]`（等长、非 `[]`）；
   - levels 全缺字段 ⇒ 与档位等长的全 0 行；
   - 旧键非零 + levels 缺字段 ⇒ 全 0（旧键被忽略）；
   - levels 缺键/非数组/坏元素 ⇒ `[]`（fail-open）。
2. 跑 room-service → RED。
3. 实现 spec §4.4 代码形状（读 `game.baseScoreLevels`、`parseConfigValue`、派生 helper）；
   `rooms.start.ts` 不动。
4. 重跑 → GREEN；lint；`rooms.entry-fee.test.ts` 保持绿。
5. Commit：`feat(room): 台费派生自档位表（旧键不再读取）`

---

## Task 4 — admin：三列档位表 + 旧费率键只读弃用

**Files**

- `admin/app.js`
- `scripts/verify-admin-static.mjs`

**TDD**

1. 加静态断言（RED）：
   - `balancedBlock(app, 'function buildLevelsEditor', '{', '}')` 中三参串
     `addRow(item?.name, item?.baseScore, item?.entryFeePercent)` **恰好出现 2 次**
     （初始渲染 + reset；只出现 1 次说明漏改 reset）；
   - `balancedBlock(app, 'function buildEntryFeeEditor', '{', '}')` 含 `已弃用`/`只读`，
     不含 `+ 添加费率`；
   - `balancedBlock(app, 'function buildStructCard', '{', '}')` 满足邻近性正则
     `currency\.entryFeePercents[\s\S]{0,200}saveBtn\.disabled`（不能只查两个串各自存在——
     `currency.entryFeePercents` 在 if dispatch 里已存在，会恒真）。
   - `pnpm verify:admin` → RED。
2. 实现：
   - `buildLevelsEditor` 第三列（0–50）、getter 校验/输出、初始渲染与 reset 都传 `entryFeePercent`；
   - `buildEntryFeeEditor` 只读弃用卡片（展示旧值参考）；
   - `buildStructCard` 对该键禁用保存；
   - `CONFIG_NOTES` / `STRUCT_META` 文案同步。
3. `pnpm verify:admin` → GREEN。
4. Commit：`feat(admin): 台费并入档位表（旧费率键只读弃用）`

---

## Task 5 — conformance slice-25：快照/改 15/恢复 + 两处断言

**Files**

- `tools/conformance/src/slices/slice-25-entry-fee.ts`

**步骤**

1. 删除 `ENTRY_FEE_KEY` / `ENTRY_FEE_ON` / `ENTRY_FEE_SEED`；把 `canonicalFeeTable` 改造成
   `canonicalLevels`（按 `{name,baseScore,entryFeePercent: ??0}` 重建），不要留下未使用的旧 helper
   （`noUnusedLocals` 会让 `tsc` 报 TS6133）。
2. A 组前：
   - `let levelsForWrite: Level[] | null = null;`（**try 外声明**，供 finally 判断）；
   - `levelsBefore = await adminGetConfigValue(admin, 'game.baseScoreLevels')`；
   - 校验非空数组且含 `baseScore===15`，否则 `ConformanceError` 中止（不改表）；
   - `levelsForWrite = levelsBefore.map(l => ({...l, entryFeePercent: l.entryFeePercent ?? 0}))`；
   - `LEVELS_FEE_ON = levelsForWrite.map(l => l.baseScore===15 ? {...l, entryFeePercent:10} : l)`。
3. A 组：
   - `putConfigAndWaitEffect(admin, 'game.baseScoreLevels', LEVELS_FEE_ON, 'room-service')`；
   - `adminGetConfigValue` 读回，用 `canonicalLevels` 断言 = `LEVELS_FEE_ON`。
4. B 组 `registerUser` 之后：用 `humans[0].accessToken` GET `/api/config`，
   断言 `entryFeePercents` **整表** = `entryFeePercentsFromLevels(LEVELS_FEE_ON)`
   （不假定其余档为 0——快照可能含人工费率）。
5. 收尾：PUT `levelsForWrite`（语义快照）；读回断言 = `levelsForWrite`；再用玩家 token 断
   `/api/config` 的 `entryFeePercents` = `entryFeePercentsFromLevels(levelsForWrite)`；
   成功后 `levelsForWrite = null`（避免 finally 重复写）。
6. `finally`：仅当 `levelsForWrite !== null` 时 PUT 写回（吞错只 info）；未取得快照则跳过并 info。
7. 跑 `pnpm exec turbo run lint build --filter=./tools/conformance --force` → GREEN。
8. Commit：`test(conformance): slice-25 改用档位表开关台费（快照/恢复）`

---

## Task 6 — 文档

**Files**

- `docs/design.md`（:1233 / :1266 / :1278）
- `docs/ops/first-deploy.md`（:1037）
- `docs/client-protocol.md`（:52）
- `admin/app.js` 的 CONFIG_NOTES（已在 Task 4）

**步骤**

1. 键表：`game.baseScoreLevels` 描述「第三列台费%」；`currency.entryFeePercents` 标「阶段 1 只读弃用」；
   room-service 消费面改为档位表派生。
2. 运维手册：台费 = 档位表第三列；旧键只读；部署前查旧键全 0。
3. 客户端协议：`baseScoreLevels` 增加可选 `entryFeePercent` 说明；`entryFeePercents` 为派生输出。
4. Commit：`docs: 台费并入档位表的契约与运维说明`

---

## Task 7 — 代码审查 + 全量验证

1. 独立 reviewer 审本片 diff（对照 spec/plan）；Critical/Important 必修。
2. 全量：
   - `pnpm exec turbo run test lint --force`
   - `pnpm -C apps/client build`
   - `pnpm verify:admin`
   - `git status --short` 为空。
3. conformance：本片需真实栈；部署到测试服后跑 slice-25（需重建镜像；注意 APK 文件仍在
   `deploy/download/`，edge 重建会带上它）。
4. 部署前硬检查（可执行路径）：
   - 查 `currency.entryFeePercents` 是否全 0（测试服当前种子全 0）。
   - 若非 0：**先部署新镜像**（此时新配置读档位表）→ 放量前用新 admin 把旧费率抄进档位表
     `entryFeePercent` → GET 自证派生正确 → 再放量。不要试图用旧栈回填（旧 parser 会丢字段）。
   - 回滚前：把当前档位表费率同步回旧键（旧代码会重新读旧键），否则回滚后静默停收。
5. 交付报告：变更、测试证据、提交范围、部署/未部署、阶段 2 待办。

## 回归命令速查

| 面 | 命令 |
|---|---|
| protocol | `pnpm exec turbo run test lint --filter=./packages/protocol --force` |
| config-service | `pnpm exec turbo run test lint --filter=./packages/config-service --force` |
| room-service | `pnpm exec turbo run test lint --filter=./packages/room-service --force` |
| conformance | `pnpm exec turbo run lint build --filter=./tools/conformance --force` |
| client | `pnpm -C apps/client test && pnpm -C apps/client lint` |
| admin | `pnpm verify:admin` |
| 全仓 | `pnpm exec turbo run test lint --force` |

## 计划审查记录（r1，独立 reviewer）

结论：可开工；1 高 + 1 中低 + 5 低，全部已写入计划。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| H1 | 高 | admin 静态断言只查 block `includes`，初始渲染与 reset 同形态 ⇒ 漏改 reset 仍绿 | Task 4 改为三参串**恰好出现 2 次** |
| H2 | 低 | `buildStructCard` 断言中 `currency.entryFeePercents` 已出现在 if dispatch 里 ⇒ 半边恒真 | 改为邻近性正则 `currency…saveBtn.disabled` |
| M1 | 低 | 「零库操作」不能证明守卫在 parse 之前 | Task 2 增加「parse 非法值也返回弃用/刷新文案」两条 |
| M2 | 低 | conformance 恢复后硬编码「全 0」与快照语义矛盾 | B/收尾改为与快照派生整表比较 |
| L1 | 低 | Task 3 未点名 `config-cache.test.ts:573-625` 旧键 reader 块会红 | 明确删除/重写该块 |
| L2 | 低 | 删常量后 `canonicalFeeTable` 未使用 ⇒ TS6133 | 改造成 `canonicalLevels` |
| L3 | 低 | 「非零先回填」在旧栈不可执行 | Task 7 写死「先上新镜像 → 放量前写档位表 → 自证 → 放量」与回滚同步 |
| L4 | 低 | `finally` 在快照校验失败时 `levelsForWrite` 未定义 | try 外声明 null；仅非 null 写回；正常恢复后置空 |

## 代码审查记录（r1，独立 reviewer，`0c001bc..HEAD`）

结论：**无 Critical / Important 代码缺陷**；1 条 Important 属运维/回滚路径缺口，6 条 Minor，全部已修。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| C1 | Important（流程） | D14 写守卫使「回滚前同步旧键」在 new stack 无受支持写入路径；ops 文档无迁移/回滚步骤 | `first-deploy.md` 增加「台费并入」迁移与回滚手顺（旧键全 0 检查、非 0 回填时序、分阶段回滚/直连 SQL） |
| C2 | Minor | `ClientConfig.entryFeePercents` 与 CONFIG_KEYS 注释仍写旧语义 | 改为「由档位表派生」「弃用/只读」 |
| C3 | Minor | controller 头、`rooms.start.ts`、`config-cache.stub.ts` 注释仍指旧键 | 同步改写 |
| C4 | Minor | D13 正半边用 `toMatchObject`，查不出 `undefined` 自有属性 | 改 `toStrictEqual` |
| C5 | Minor | `client-protocol.md` 的 `/api/config` 响应被缩写成 `...`，丢掉 18 键契约 | 恢复完整形状，仅补 `entryFeePercent?` 与派生说明 |
| C6 | Minor | 运维手册「四十九键一览」与 52 键不符 | 改「五十二键一览」 |

正向核验（reviewer 实测）：三包测试全绿（protocol 216 / config-service 448 / room-service 744）、
`verify:admin` 240 项通过；parser round-trip、D13/D14 守卫先于 parse、room 派生、admin 三列/禁用保存、
conformance 两处断言的判别力均成立；客户端/mock-server 真零改动；钱路径无 0/NaN 进入乘法。
