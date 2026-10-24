# 台费并入档位表 阶段 2（删旧键 + 删派生字段）— 实现计划

> **For agentic workers:** 按任务逐条执行；每个任务先测试后实现（TDD），绿后提交。步骤用 `- [ ]` 勾选。

**Goal:** 删除 `currency.entryFeePercents` 配置键与 `/api/config.entryFeePercents` 派生字段；客户端改读 `baseScoreLevels[].entryFeePercent`；新增迁移删除旧键行，配置面只剩一份台费真源。

**Architecture:** 先加协议纯函数 `entryFeeOfLevel`（加法），再让客户端改读档位项（服务端阶段 1 仍同时下发两者，保持兼容），最后一次性删除协议键/字段、config-service 输出、admin 面、conformance 键面与数据库行。删除提交必须跨 protocol/config-service/admin/conformance 同批，否则编译或静态闸会红。

**Tech Stack:** TypeScript、Vitest、TypeORM 迁移、原生 JS（admin）、uni-app（客户端）。

**状态（2026-10-21）：** 全部完成。Task 0–4 完成；Task 5 代码审查（无 Critical；2 Important + 7 Minor
已修）、全量验证、推送与部署已执行。实现中发现迁移时间戳 `1795900000000` 与
`currency-service/CardCounterEntitlements1795900000000` 撞车，已改用 **`1796000000000`**
（全仓扫描确认空闲；spec/计划同步）。

**验证与部署证据（2026-10-21，tag `dev-a84464d`）：** protocol 216、config-service 449、
room-service 745、client 1168 passed / 2 skipped、`pnpm verify:admin` 246 checks、
conformance lint/build 4/4、`turbo run test lint --force` 44/44（0 cached）、client build DONE。
部署后：admin 51 键、玩家 `/api/config` 19 键且无 `entryFeePercents`、旧键 PUT ⇒ 400
「未知配置键：currency.entryFeePercents」、DB 旧行 0 / `platform_config` 51 行；
线上 admin 无 `buildEntryFeeEditor`/`HIDDEN_CONFIG_KEYS`；1 分档 100% 门票 1。

## Global Constraints

1. `CONFIG_KEYS` 52→51；`CLIENT_CONFIG_KEYS` 20→19；不重编号（42 号位空缺）。
2. 旧键 `currency.entryFeePercents` 从协议/服务/admin/文档全部删除；数据库行由新迁移删除，
   `down` 恢复历史种子四档×0。
3. `/api/config` 不再有 `entryFeePercents`；客户端门票只由 `baseScoreLevels[].entryFeePercent` 计算。
4. `entryFeeOf` / `entryFeePercentsFromLevels` 公式与派生语义不变；新增 `entryFeeOfLevel` 只做单档包装。
5. **保留 D13**（档位表旧形态 400）；只删 D14 旧键守卫。
6. 历史迁移 `1795200000000-EntryFeePercentsSeed.ts` 保留（历史事实）。
7. 每个任务提交后不得留红树；删除提交跨包同批。
8. 测试走 turbo：`pnpm exec turbo run test lint --filter=./packages/<pkg> --force`。
9. 每个任务：先改/加测试 → 跑红 → 最小实现 → 跑绿 → commit。
10. 提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
11. 最终：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、`pnpm verify:admin`、
    `pnpm exec turbo run lint build --filter=./tools/conformance --force`。

---

## Task 0 — spec + 计划落盘

- [ ] 提交 spec（含审查记录）与本计划。

Commit：`docs(spec+plan): 台费阶段 2 删旧键与派生字段`

---

## Task 1 — protocol：新增 `entryFeeOfLevel`（加法，树保持绿）

**Files**

- Modify: `packages/protocol/src/config.ts`（`entryFeePercentsFromLevels` 之后）
- Test: `packages/protocol/src/config.test.ts`（import + 新用例）

**Interfaces**

- Produces: `entryFeeOfLevel(level: BaseScoreLevel): number` —— 单档 `entryFeeOf` 包装，
  客户端门票与服务端收费同公式；后续 Task 2 客户端消费。

- [ ] **Step 1: 加测试（RED）**

`config.test.ts` 的 import 增加 `entryFeeOfLevel`，在 `entryFeePercentsFromLevels` 用例后加：

```ts
  it('entryFeeOfLevel：单档 ⇒ entryFeeOf 同值（10%⇒1、100%⇒底分、缺省/0⇒0）', () => {
    expect(entryFeeOfLevel({ name: '休闲场', baseScore: 15, entryFeePercent: 10 })).toBe(1);
    expect(entryFeeOfLevel({ name: '休闲场', baseScore: 15, entryFeePercent: 100 })).toBe(15);
    expect(entryFeeOfLevel({ name: '标准场', baseScore: 80 })).toBe(0);
    expect(entryFeeOfLevel({ name: '标准场', baseScore: 80, entryFeePercent: 0 })).toBe(0);
  });
```

- [ ] **Step 2: 跑红**

Run: `pnpm exec turbo run test lint --filter=./packages/protocol --force`
Expected: FAIL——`entryFeeOfLevel` 未导出（TS/运行时未定义）。

- [ ] **Step 3: 实现**

`config.ts` 在 `entryFeePercentsFromLevels` 后加：

```ts
/**
 * 单档台费金额（客户端「门票」与服务端收费共用 `entryFeeOf` 公式）。
 * 档位项 ⇒ 单项费率表 ⇒ `entryFeeOf`；派生映射仍只有 `entryFeePercentsFromLevels` 一份。
 */
export function entryFeeOfLevel(level: BaseScoreLevel): number {
  return entryFeeOf(level.baseScore, entryFeePercentsFromLevels([level]));
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm exec turbo run test lint --filter=./packages/protocol --force`
Expected: 217 tests passed（216 + 1），lint 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts
git commit -m "feat(protocol): 新增 entryFeeOfLevel（单档台费）"
```

---

## Task 2 — 客户端：门票改读档位项（服务端仍双发，树保持绿）

**Files**

- Modify: `apps/client/src/composables/useClientConfig.ts`
- Modify: `apps/client/src/stores/game.ts`
- Modify: `apps/client/src/pages/lobby/lobby.vue`
- Test: `apps/client/test/*.test.ts`（删除夹具键；重写 `base-score-selection` 台费用例）

**Interfaces**

- Consumes: Task 1 的 `entryFeeOfLevel`。
- Produces: 客户端不再依赖 `entryFeePercents`；`ClientConfigState` 不含该键。

- [ ] **Step 1: 改客户端测试（RED / 契约变更）**

1. 所有测试夹具删除 `entryFeePercents` 行（`auth-ui-wiring`、`card-counter-gate`、`lobby-ux`、
   `table-center`、`wallet-entry`、`wallet-page`、`base-score-selection` 的稳定空表）。
2. `base-score-selection.test.ts`：
   - 删除 reset 用例里的 `entryFeePercents` 夹具与 `store.entryFeePercents` 断言；
   - `GOLD_FEE_CONFIG_OK.data.baseScoreLevels` 改为：

```ts
      baseScoreLevels: [
        { name: '休闲场', baseScore: 15, entryFeePercent: 10 },
        { name: '标准场', baseScore: 80, entryFeePercent: 12 },
      ],
```

   并删除 `entryFeePercents: [...]`；
   - 门票用例标题改「档位项 `entryFeePercent` > 0 ⇒ 逐档渲染」；
   - `percent=0` 用例改为：15 档 `entryFeePercent: 0`、80 档**缺字段** ⇒ 零门票行；
   - 删除「响应缺 `entryFeePercents` 键」用例（字段已不属于契约）。

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test`
Expected: FAIL——`store.entryFeePercents` 仍存在但夹具已删、门票仍读旧 store 字段；
（`lobby.vue` 未改时门票断言也会红）。

- [ ] **Step 3: 实现客户端**

`useClientConfig.ts`：删除 `FAILSAFE_CLIENT_CONFIG.entryFeePercents`、`normalizeClientConfig` 的
`entryFeePercents` 行、头注该条。

`stores/game.ts`：

- 删除 `type EntryFeePercent` 导入；
- `ClientConfigState` 的 `Omit` 列表加入 `'entryFeePercents'`（协议字段仍存在，先让 state 不要求它）；
- 删除 state 的 `entryFeePercents: [] as EntryFeePercent[]` 及其注释；
- 删除 `setClientConfig` 的 `this.entryFeePercents = cfg.entryFeePercents;`；
- 删除 reset 注释中的 `entryFeePercents`；头注键数「十六键全写」→「十五键全写」。

`lobby.vue`：

```ts
import { entryFeeOfLevel as feeOfLevel, type BaseScoreLevel } from "@fight-the-landlord/protocol";
```

```ts
function ticketOfLevel(lv: BaseScoreLevel): number | null {
  if (store.roomMode !== "gold") return null;
  const fee = feeOfLevel(lv);
  return fee > 0 ? fee : null;
}
```

模板：`v-if="entryFeeOfLevel(lv.baseScore) !== null"` → `v-if="ticketOfLevel(lv) !== null"`，
`门票 {{ entryFeeOfLevel(lv.baseScore) }}` → `门票 {{ ticketOfLevel(lv) }}`；
注释改为「金额只由 `entryFeeOfLevel` 算」。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C apps/client test && pnpm -C apps/client lint && pnpm -C apps/client build`
Expected: 全绿；build DONE。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src apps/client/test
git commit -m "feat(client): 门票改读档位项 entryFeePercent"
```

---

## Task 3 — 契约删除：协议/服务/迁移/admin/conformance（同一提交，树保持绿）

**Files**

- Modify: `packages/protocol/src/config.ts`（CONFIG_KEYS / CLIENT_CONFIG_KEYS / ClientConfig / parse 分支 / parseEntryFeePercents）
- Test: `packages/protocol/src/config.test.ts`
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Modify: `packages/config-service/src/config/platform-config.service.ts`
- Create: `packages/config-service/src/migrations/1796000000000-RemoveEntryFeePercents.ts`
- Modify: `packages/config-service/test/{client-config,config.validation,platform-config.service,admin.controller,config.rpc,migration}.test.ts`
- Modify: `packages/config-service/test/helpers/config-probe.ts`
- Modify: `packages/room-service/test/config-cache.test.ts`（旧键夹具 → 档位项缺字段）
- Modify: `admin/app.js`、`admin/index.html`、`scripts/verify-admin-static.mjs`
- Modify: `packages/config-service/src/config/{admin.controller,platform-config.entity,platform-config.service,client-config.controller}.ts`（注释/键枚举串）
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（注释）
- Modify: `tools/conformance/src/slices/slice-{14,17,18,21,22,23,24,25}.ts`

**Interfaces**

- Consumes: Task 2 的客户端已不读 `entryFeePercents`。
- Produces: `CONFIG_KEYS` 51、`CLIENT_CONFIG_KEYS` 19；旧键 PUT ⇒ 未知键 400；新迁移删行。

- [ ] **Step 1: 协议测试（RED）**

`config.test.ts`：

- 顶层标题「五十二键清单」→「五十一键清单」；「恰好五十二键；客户端子集恰好二十键」→
  「恰好五十一键；客户端子集恰好十九键」；key 数组删除 `'currency.entryFeePercents'` 与客户端子集的
  `'entryFeePercents'`；
- 删除整个 `台费第 42 键 currency.entryFeePercents：E1–E4 …` 用例（键已不存在）；
- 保留 `entryFeeOf` / `entryFeePercentsFromLevels` / `entryFeeOfLevel` 用例。

- [ ] **Step 2: config-service 测试（RED）**

- `test/helpers/config-probe.ts`：SEED 删除旧键两项；注释「四十九键」→「五十一键」，
  迁移清单删去 `1795200000000-EntryFeePercentsSeed.ts` 的「第 42 键」描述（改为历史迁移说明）。
- `test/platform-config.service.test.ts`：SEED 删除旧键；`rows` 断言 52→51；标题「五十键」→「五十一键」；
  删除 D14 用例（`svc.set('currency.entryFeePercents', …)`，删键后是 TS 错误）；保留 D13 两用例。
- `test/admin.controller.test.ts`：标题「四十九键」→「五十一键」；字面 key 列表删除旧键。
- `test/config.rpc.test.ts`：字面 key 列表删除旧键。
- `test/client-config.test.ts`：
  - 子集键集 20→19，删除 `'entryFeePercents'`；
  - 删除两个派生用例（「entryFeePercents 由档位表派生」「100 派生」；字段已不存在）；
  - 「旧键不再被读」改写为「残留旧键行不泄漏」：仍 `db.rows.set('currency.entryFeePercents', …)`，
    断言 `/api/config` 仍 19 键且 `!('entryFeePercents' in body.data)`（防迁移未跑/回滚残留）；
  - 种子响应断言删除 `entryFeePercents` 块；坏值用例删除 `entryFeePercents: []` 断言；
  - 缺行用例删除 `db.rows.delete('currency.entryFeePercents')` 与末尾断言；注释二十键→十九键。
- `test/config.validation.test.ts`：删除 D14 用例；`cases` **保留** `nope.key` 的未知键用例，
  另加一条旧键 `key: 'currency.entryFeePercents'`（reason `/未知配置键/`；`key` 是 string，不触发 TS）。
- `test/migration.test.ts`：import 新迁移；新增 describe（三条 `it`）：
  - `up()` 恰一条 `DELETE FROM platform_config WHERE key = 'currency.entryFeePercents'`；
  - `down()` 恰一条 `INSERT IGNORE`，值逐字 = 历史四档×0；
  - 时间戳 1796000000000 > 1795800000000 且全仓唯一。
- `packages/room-service/test/config-cache.test.ts:594-613`：`snapshotWith` 的入参类型是
  `Partial<Record<ConfigKey, unknown>>`，旧键字面在删键后会 TS2353。把该用例改为
  「档位项缺 `entryFeePercent` ⇒ 与档位等长的全 0 行（不读旧键）」——删除
  `'currency.entryFeePercents': [...]` 一行，保留两条 0 行断言与 `entryFeePercent` 缺省语义。

- [ ] **Step 3: admin 静态闸（RED）**

`scripts/verify-admin-static.mjs`：

- `STRUCT_KEYS` 删除旧键（5→4）；`ok(STRUCT_KEYS.every(...), '5 个结构化键')` → 4；
- `52 键 = 47 简单 ∪ 5 结构化` → `51 键 = 47 简单 ∪ 4 结构化`；
- `protoSet.size === 52` / `iaKeySet.size === 52` → 51；第 5 节头注同步为 51/47/4；
- 第 8 节删除 **5 条**旧键断言：`renderRowsSrc`/`HIDDEN_CONFIG_KEYS`、`feeFn !== ''`、
  「已弃用 && 只读」、`!feeFn.includes('+ 添加费率')`、`buildStructCard` 禁用保存；
  相关变量 `feeFn`/`structFn`/`renderRowsSrc` 一并删除（防 `noUnusedLocals`）；
  保留档位表三列/上限/文案断言。

- [ ] **Step 4: conformance（RED / 字面同步）**

- 20 键字面删除 `entryFeePercents`（slice-14/17/18/21/24），注释/步骤 20→19；
  **slice-23:741 的 `checks.eq(Object.keys(cfgData).length, 20, …)` → 19**（步骤文案 :731 同步）；
- 管理面 52 键断言 → 51（slice-18:1025、slice-22:1193、slice-23:735/1283、slice-24:809），
  说明文案去掉「台费」项；
- slice-14 的 `Array.isArray(entryFeePercents)` 正断言改为
  `checks.that(!('entryFeePercents' in (c7.body?.data ?? {})), 'C7 派生字段已删除')`
  （`checks.ok` 只收 message，不能用它带条件）；
- slice-25：删除 `entryFeePercentsFromLevels` 导入与 `canonicalFeeTable`；B 组与收尾的玩家面断言改为：

```ts
    const cfgRes = await getJson<{ baseScoreLevels: BaseScoreLevel[] }>(
      '/api/config',
      humans[0]!.accessToken,
    );
    checks.eq(cfgRes.status, 200, 'B GET /api/config 状态');
    checks.eq(
      canonicalLevels(cfgRes.body?.data?.baseScoreLevels),
      canonicalLevels(levelsFeeOn),
      'B /api/config 的 baseScoreLevels = 临时档位表（15⇒10%，其余按快照）',
    );
```

  收尾同理与 `levelsForWrite` 比较；slice-20 步骤文案 52→51（断言用 `CONFIG_KEYS.length` 动态）。

- [ ] **Step 5: 跑红**

Run: `pnpm exec turbo run test lint --filter=./packages/protocol --force`
Expected: FAIL——`CONFIG_KEYS` 仍 52 / 旧键用例仍在。
Run: `pnpm exec turbo run test lint --filter=./packages/config-service --force`
Expected: FAIL——键数 51 断言、D14 删除、派生字段删除均未实现。
Run: `pnpm exec turbo run test lint --filter=./packages/room-service --force`
Expected: TS2353——旧键字面仍在 `snapshotWith` 入参（Step 2 已改测试后此处应为绿；
若未改则这条就是 B1 的判别）。

- [ ] **Step 6: 协议实现**

`config.ts`：

- `CONFIG_KEYS` 删除 `'currency.entryFeePercents'` 条目与注释；文件头「五十键清单」→「五十一键清单」；
- `CLIENT_CONFIG_KEYS` 删除 `'entryFeePercents'` 条目与注释；
- `ClientConfig` 删除 `entryFeePercents: EntryFeePercent[]` 与注释；
- `parseConfigValue` 删除旧键分支；
- 删除 `parseEntryFeePercents` 函数；
- `EntryFeePercent`、`entryFeeOf`、`entryFeePercentsFromLevels`、`entryFeeOfLevel` 保留；
- 注释同步：`EntryFeePercent` 去掉「旧第 42 键的读入形状」；`entryFeePercentsFromLevels`
  去掉「config-service 的 `/api/config` 输出共用」（阶段 2 后只有 room-service 与
  `entryFeeOfLevel` 用）。

- [ ] **Step 7: config-service 实现**

`client-config.controller.ts`：删除 `entryFeePercentsFromLevels` 导入与 `entryFeePercents:` 输出；
头注「二十键」→「十九键」、`五十二键`→`五十一键`。

`platform-config.service.ts`：删除 D14 守卫块；注释只保留 D13；`ProtocolError` 仍被 D13 使用。

新迁移 `1796000000000-RemoveEntryFeePercents.ts`：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 台费并入档位表 阶段 2：删除旧第 42 键 `currency.entryFeePercents` 行。 */
export class RemoveEntryFeePercents1796000000000 implements MigrationInterface {
  name = 'RemoveEntryFeePercents1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'currency.entryFeePercents'");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('currency.entryFeePercents', '[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]', 1, NOW(3), 'seed')`,
    );
  }
}
```

- [ ] **Step 8: admin 实现**

`admin/app.js`：

- `CONFIG_IA` 的 `goldEconomy.keys` 删除旧键；
- `STRUCT_KEYS` 删除旧键（5→4）；
- 删除 `HIDDEN_CONFIG_KEYS` 常量；`renderConfigRows` 搜索过滤与域页签过滤删除该判断；
- `STRUCT_META` 删除旧键；
- `CONFIG_NOTES` 删除旧键条目；
- 删除 `buildEntryFeeEditor` 函数、dispatch 行、`buildStructCard` 禁用保存块；
- `admin/index.html` 中旧键编辑器相关注释同步删除；
- 注释/键数：52 条→51 条、四十九键→五十一键；`CONFIG_CONTROLS` 段头注 45+5=50 → 47+4=51；
  `game.baseScoreLevels` 的「原『台费费率表』键已弃用」→「旧费率键已删除」。

- [ ] **Step 9: 源码头注/注释同步**

- `packages/config-service/src/config/client-config.controller.ts`：键枚举串删除 `entryFeePercents`；
  「二十键」→「十九键」、「五十二键」→「五十一键」；
- `packages/config-service/src/config/{admin.controller,platform-config.entity,platform-config.service}.ts`：
  「五十键」→「五十一键」；
- `packages/api-gateway/src/gateway/gateway.controller.ts:142`：「五十键」→「五十一键」；
- `apps/client/src/stores/game.ts`：`ClientConfigState` 的 `Omit` 列表删除 `'entryFeePercents'`
  （Task 3 协议字段已删，保留也可编译但属死代码）。

- [ ] **Step 10: conformance 实现**

按 Step 4 的字面改完；确认 `slice-25` 无未使用 import/helper（`noUnusedLocals`）。

- [ ] **Step 11: 跑绿**

```bash
pnpm exec turbo run test lint --filter=./packages/protocol --force
pnpm exec turbo run test lint --filter=./packages/config-service --force
pnpm exec turbo run test lint --filter=./packages/room-service --force
pnpm verify:admin
pnpm exec turbo run lint build --filter=./tools/conformance --force
pnpm -C apps/client test && pnpm -C apps/client lint
```

Expected: protocol 217、config-service 以输出为准（删派生/旧键用例、增迁移用例与残留守卫；
预计 448 上下）、room-service 745、admin 246、conformance 构建绿、client 全绿。

- [ ] **Step 12: Commit**

```bash
git add packages/protocol packages/config-service packages/room-service packages/api-gateway admin scripts/verify-admin-static.mjs apps/client tools/conformance
git commit -m "feat(config)!: 删除旧台费键与 /api/config 派生字段（阶段 2）"
```

---

## Task 4 — 文档

**Files**

- Modify: `docs/design.md`（1266 行删除；143/529/536/1221/1512/1664/2144 键数；1278 客户端键数；427 快照清单）
- Modify: `docs/ops/first-deploy.md`（1016 键数；1037 删除；迁移/回滚段）
- Modify: `docs/client-protocol.md`（52 行响应；57/96 键数）

- [ ] **Step 1: design.md**

- 删除 `currency.entryFeePercents` 整行；
- `五十二键` → `五十一键`（143/427/529/536/1221/1512/1664/2144）；
- 427 行快照清单删除「台费〔费率表〕」；
- 1306/1317 的「本片起 41 键…共 47」→「共 46」；
- 1278 行客户端可见键：删除台费片增量、计数 16/17/18/20 → 15/16/17/19。

- [ ] **Step 2: first-deploy.md**

- `五十二键一览` → `五十一键一览`；
- 删除 `currency.entryFeePercents` 行；
- 「台费并入」段改写为阶段 2：迁移删除旧行；回滚旧代码前用新迁移 `down` 或 SQL 恢复**四档**行，
  并**把档位表现有 `entryFeePercent`（≤50）回填旧键**（否则旧代码读旧键 = 静默不收费）；
  删除「旧键行由种子迁移保证存在」；示例 UPDATE 补齐四档。

- [ ] **Step 3: client-protocol.md**

- 第 8 条响应删除 `entryFeePercents` 字段与说明；
- 「五十键之一」→「五十一键之一」；
- 「20 键」→「19 键」。

- [ ] **Step 4: 核对残留**

```bash
grep -rn "entryFeePercents" docs/design.md docs/ops/first-deploy.md docs/client-protocol.md admin/app.js packages/protocol/src/config.ts packages/config-service/src packages/config-service/test packages/room-service/test scripts/verify-admin-static.mjs apps/client/src tools/conformance/src
```

Expected: 仅历史迁移/新迁移的键名（`1795200000000`、`1796000000000`）与迁移测试断言、
room-service 残留守卫用例的直塞键名；运行面/契约面零残留。

- [ ] **Step 5: Commit**

```bash
git add docs/design.md docs/ops/first-deploy.md docs/client-protocol.md
git commit -m "docs: 台费阶段 2 删除旧键与派生字段"
```

---

## Task 5 — 代码审查 + 全量验证 + 推送/部署

- [ ] **Step 1: 独立 reviewer 审 `a63f3a5..HEAD`**（A 的最后提交 → B HEAD），对照 spec/plan；
  Critical/Important 必修，结论写入 spec/plan。
- [ ] **Step 2: 全量**

```bash
pnpm exec turbo run test lint --force
pnpm -C apps/client build
pnpm verify:admin
pnpm exec turbo run lint build --filter=./tools/conformance --force
git status --short
```

Expected: 全绿；工作区干净。
- [ ] **Step 3: 推送 dev + 部署测试服**（A+B 一次部署；14 target 串行 bake）。
- [ ] **Step 4: 部署后验收**
  - A：1 分档台费设 100% ⇒ 200；客户端门票 = 1；切后台无旧费率卡；
  - B：`GET /api/admin/config` 51 键、`GET /api/config` 19 键且无 `entryFeePercents`；
    `PUT /api/admin/config/currency.entryFeePercents` ⇒ 400 未知键；
  - 迁移：库中旧键行已删（`SELECT` 0 行）。

## 回归命令速查

| 面 | 命令 |
|---|---|
| protocol | `pnpm exec turbo run test lint --filter=./packages/protocol --force` |
| config-service | `pnpm exec turbo run test lint --filter=./packages/config-service --force` |
| client | `pnpm -C apps/client test && pnpm -C apps/client lint && pnpm -C apps/client build` |
| conformance | `pnpm exec turbo run lint build --filter=./tools/conformance --force` |
| admin | `pnpm verify:admin` |
| 全仓 | `pnpm exec turbo run test lint --force` |

## 计划审查记录（r1，独立 reviewer）

结论：可开工；1 阻断 + 2 高 + 9 低，全部已写入计划。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| B1 | 阻断 | `room-service/test/config-cache.test.ts:594-613` 的旧键字面在删键后 TS2353；计划文件清单漏 room-service | Task 3 Files/Step 2 改写该用例并加入 room-service；Step 5/11 加 room-service 跑测 |
| H1 | 高 | slice-23:741 还有一条 `length, 20` 运行期断言 | Task 3 Step 4 补 slice-23:741（文案 :731） |
| H2 | 高 | `checks.ok` 只收 message；`checks.ok(cond,msg)` 会 TS2554，单参则假绿 | 改用 `checks.that(cond, msg)` |
| L1 | 低 | 阶段 1 spec 的 D13/派生输出相反承诺未登记 | spec D3/D4 加 supersession |
| L2 | 低 | design.md:427、1306/1317 键数漏改 | Task 4 补 |
| L3 | 低 | 静态闸旧键断言实为 5 条、头注 50/45 stale | Task 3 Step 3 逐条列并改头注 |
| L4 | 低 | 源码头注「五十键」与 controller 枚举串 | Task 3 Step 9 逐文件同步 |
| L5 | 低 | lobby.vue 未说删 `entryFeeOf` 导入/加类型 | Task 2 Step 3 写全导入替换 |
| L6 | 低 | 回滚只恢复四档×0，非零费率会静默不收费 | Task 4 写明回填 + 四档示例 |
| L7 | 低 | `EntryFeePercent`/`entryFeePercentsFromLevels`/admin 注释漂移 | Task 3 Step 6/8 同步 |
| L8 | 低 | spec §6.1 判据与计划 HTTP 400 不一致 | spec 改为「PUT 旧键 ⇒ 400 未知键（真管线）」 |
| L9 | 可选 | 删「旧键不再被读」后失去残留旧键守卫 | 改写为「残留旧键行不泄漏」用例 |

正向核验（reviewer 实测）：mock-server 无该字段；52 键断言全集 = 5 处 conformance + config-service
SEED 长度 + 静态闸两处；迁移同事务无 52/51 窗口；down 种子逐字可复用；D13 保留不误伤新 admin；
Task 1→2→3 过渡可编译；slice-25 改断档位表仍保持判别力；客户端夹具清单完整。

## 代码审查记录（r1，独立 reviewer，`a63f3a5..d0b8921`）

结论：无 Critical；2 Important（文档/注释）+ 7 Minor，全部已修。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| I1 | Important | config-probe 种子注释旧时间戳 + 迁移枚举漏项/乱序 | 改 1796000000000，补齐 179570/179580，按序重写 |
| I2 | Important | 运维回滚示例四档全 0，照抄会静默不收费 | 改非零示例 + 替换警告 |
| M1 | Minor | room-service 注释仍指 config-service 输出 | 改指 `entryFeeOfLevel` 共用公式 |
| M2 | Minor | design 可见键序号重复 | 16/17/18/19 重排 |
| M3 | Minor | store 头注计数与实现不符 | 去掉绝对计数 |
| M4 | Minor | slice-18/24 注释混计/悬空指代 | 重写 |
| M5 | Minor | 本地 dist 残留旧迁移 | 删除 |
| M6 | Minor | 多处「四十九键」陈旧注释 | 统一五十一键 |
| M7 | Minor | 计划 admin 251 / spec 编号重复 | 改 246；编号 1–8 |
