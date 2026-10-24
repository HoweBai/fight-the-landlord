# 台费并入档位表 阶段 2：删除旧键与派生字段 — 设计

- 日期：2026-10-21
- 前置：阶段 1（台费并入档位表）已上线测试服；用户确认**当前没有旧客户端**需要 `/api/config.entryFeePercents`。
- 范围：protocol / config-service（含迁移）/ admin / 客户端 / conformance / 文档。
- 目标：删除旧配置键 `currency.entryFeePercents` 与 `/api/config` 的派生字段 `entryFeePercents`；
  客户端改读 `baseScoreLevels[].entryFeePercent`，配置面只剩**一份**台费真源。

## 1. 背景 / 问题

阶段 1 保留了旧键（只读弃用）与 `/api/config` 的派生字段，以换取客户端零改动。阶段 2 收口：

- 旧键已无消费方（room-service 改读档位表），继续存在于 `CONFIG_KEYS` 会让后台/快照/审计面多一份死配置；
- `/api/config` 的 `entryFeePercents` 是派生输出，客户端改读档位表后可删除，消除「同名字段两份语义」；
- 数据库里旧键行由新迁移删除；历史种子迁移保留（历史事实），回滚由新迁移 `down` 恢复。

## 2. 范围

**做**

- protocol：`CONFIG_KEYS` 52→51（删 `currency.entryFeePercents`）；删 `parseConfigValue` 分支与
  `parseEntryFeePercents`；`CLIENT_CONFIG_KEYS` 20→19（删 `entryFeePercents`）；`ClientConfig` 删该字段；
  新增 `entryFeeOfLevel(level: BaseScoreLevel): number`（内部复用 `entryFeeOf`，公式唯一）。
- config-service：删 `client-config.controller` 的派生输出与 `entryFeePercentsFromLevels` 导入；
  删 `platform-config.service` 的 D14 旧键写守卫（未知键自然 400）；**保留 D13**（旧形态档位表 400）；
  新增迁移 `1796000000000-RemoveEntryFeePercents.ts`：`up` 删除该行，`down` 重新插入历史种子四档×0。
- admin：从 `CONFIG_IA` / `STRUCT_KEYS` / `STRUCT_META` / `CONFIG_NOTES` 删除该键；
  删除 `HIDDEN_CONFIG_KEYS`（唯一元素已删）与两处过滤；删除 `buildEntryFeeEditor`、dispatch 行与
  `buildStructCard` 的禁用保存块；`STRUCT_KEYS` 5→4；静态闸键数 52→51、结构化 5→4。
- 客户端：`useClientConfig` 删除归一；`stores/game` 删除状态/赋值/类型导入；`lobby.vue` 的「门票 N」
  改为 `entryFeeOfLevel(lv)`；所有测试夹具删除该键；`base-score-selection` 台费用例改为档位项字段。
- conformance：所有 `/api/config` 20 键字面 → 19（含 slice-23:741 的 `length, 20`）；
  管理面 52 键断言 → 51；slice-25 的玩家面断言从 `entryFeePercents` 改为 `baseScoreLevels`；
  slice-14 的负断言用 `checks.that(cond, msg)`（`checks.ok` 只收 message，不能带条件）。
- room-service：`config-cache.test.ts:594-613` 的「旧键被忽略」夹具把旧键塞进
  `snapshotWith(Partial<Record<ConfigKey, unknown>>)`；CONFIG_KEYS 删键后会 **TS2353 编译红**。
  改写为「档位项缺 `entryFeePercent` ⇒ 与档位等长的全 0 行（不读旧键）」，保留判别力、去掉旧键字面。
- 源码/后台注释：`config-service` 的「五十键/二十键」头注与 `client-config.controller` 的键枚举串、
  `api-gateway` 头注、`admin/app.js` 历史键数、`admin/index.html` 旧键编辑器注释同步删除/改数。
- 文档：删旧键行与相关迁移说明；键数 52→51、客户端可见 20→19；回滚段写「旧代码会读旧键，
  阶段 2 后回滚需先 `down`/SQL 恢复该行，并把档位表现有费率回填到旧键（≤50）」。`design.md:427`
  的「五十二键」与 `:1306/:1317` 的「共 47」也在同步面。

**不做**

- 不改 `entryFeeOf` / `entryFeePercentsFromLevels` 的公式与派生语义（room-service 仍用后者）；
- 不改 `currency.rakePercent`、`game.baseScoreLevels` 的 0–100 域；
- 不删除历史迁移 `1795200000000-EntryFeePercentsSeed.ts`（历史事实，保留可追溯）；
- 不改 mock-server（核对无该字段）；
- 不改旧测试 APK 的二进制（旧 APK 只是不再显示门票，不崩；要显示需重打 APK）。

## 3. 决策表

| # | 决策 | 依据 |
|---|------|------|
| D1 | `CONFIG_KEYS` 删除旧键（52→51），不重编号（历史键号保留，42 号位空缺） | 键号是历史标签；重编号会制造无意义的全仓改动 |
| D2 | 新迁移 `1796000000000`（晚于 `1795800000000`）：`up` 单条 DELETE；`down` `INSERT IGNORE` 历史四档×0 | 回滚到阶段 1/旧代码需要该行；种子形状与 `1795200000000` 逐字一致 |
| D3 | 删 D14 旧键守卫；**保留 D13**（档位表旧形态 400） | 用户 B 指令只要求删 D14；D13 仍防「旧 admin 缓存页面静默清零台费」，且新 admin 每条都写字段、不会误伤。**本片覆盖阶段 1 spec D13「阶段 2 移除该规则」的相反表述**（保留是当前用户指令下的更优选择） |
| D4 | `CLIENT_CONFIG_KEYS` 删 `entryFeePercents`（20→19）；`ClientConfig` 删字段 | 客户端改读档位表后，派生字段是第二份同义契约。**本片覆盖阶段 1 spec checklist 第 1/6 条「阶段 2 保留派生输出」**（用户已确认当前没有旧客户端） |
| D5 | 新增 `entryFeeOfLevel(level)`，内部 `entryFeeOf(level.baseScore, entryFeePercentsFromLevels([level]))` | 客户端与服务端共用同一公式；派生映射仍只有一份 |
| D6 | 客户端「门票」只由档位项 `entryFeePercent` 计算；`percent=0`/缺字段 ⇒ 不渲染 | 与大厅档位卡同源；缺字段 = 0（与 parser 语义一致） |
| D7 | admin 删除旧键全部痕迹（含隐藏集合与只读卡片）；`STRUCT_KEYS` 5→4 | 键已不存在；隐藏一个不存在的键是死代码 |
| D8 | 静态闸键数 52→51、结构化 5→4；删除旧键三条断言；保留档位表 0–100 断言 | 机械闸跟随键面真源 |
| D9 | conformance：20→19、52→51；slice-25 玩家面断言改 `baseScoreLevels` | 客户端新真源是档位表；派生字段已不存在 |
| D10 | 文档删除旧键行；`五十二键`→`五十一键`；客户端可见 20→19；回滚段补「先恢复旧键行」 | 运维/契约一致性 |
| D11 | 旧 APK（b19347a）不崩：不再显示门票，服务端照常按档位表收费；要显示门票需重打 APK | 用户已知悉并接受 |
| D12 | mock-server 不改 | 核对 `tools/mock-server` 无 `entryFeePercents`/`entryFee` 字段 |

## 4. 实现设计

### 4.1 protocol `packages/protocol/src/config.ts`

- `CONFIG_KEYS`：删除 `'currency.entryFeePercents'` 条目；文件头「五十键清单」→「五十一键清单」。
- `CLIENT_CONFIG_KEYS`：删除 `'entryFeePercents'`。
- `ClientConfig`：删除 `entryFeePercents: EntryFeePercent[]`。
- `parseConfigValue`：删除 `if (key === 'currency.entryFeePercents') …` 分支。
- 删除 `parseEntryFeePercents` 函数（`EntryFeePercent` 类型、`entryFeeOf`、`entryFeePercentsFromLevels` 保留）。
- 新增：

```ts
/** 单个档位的台费金额（客户端「门票」与服务端收费共用 `entryFeeOf` 公式）。 */
export function entryFeeOfLevel(level: BaseScoreLevel): number {
  return entryFeeOf(level.baseScore, entryFeePercentsFromLevels([level]));
}
```

### 4.2 config-service

- `client-config.controller.ts`：删除 `entryFeePercentsFromLevels` 导入与 `entryFeePercents:` 输出；
  头注「二十键」→「十九键」、「五十二键」→「五十一键」；**键枚举串删除 `entryFeePercents`**；
  `levels` 解析保持不变（`baseScoreLevels` 仍下发）。
- `platform-config.service.ts`：删除 D14 守卫（`if (key === 'currency.entryFeePercents') …`）；
  保留 D13；注释改为只描述 D13。
- 新迁移 `src/migrations/1796000000000-RemoveEntryFeePercents.ts`：

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

### 4.3 admin `admin/app.js`

- `CONFIG_IA` 的 `goldEconomy.keys` 删除旧键；
- `STRUCT_KEYS` 删除旧键（5→4）；
- 删除 `HIDDEN_CONFIG_KEYS` 常量与 `renderConfigRows` 两处过滤（搜索与域页签）；
- `STRUCT_META` 删除旧键；
- `CONFIG_NOTES` 删除旧键条目；
- 删除 `buildEntryFeeEditor` 整个函数；
- 删除 `buildStructCard` 的 `else if (key === 'currency.entryFeePercents')` dispatch 与禁用保存块；
- 注释/键数：52 条→51 条、四十九键→五十一键；`admin/index.html` 中旧键编辑器相关注释同步删除；
- 静态闸头注的陈旧计数一并改正为 51/47/4（原「50 键（45+5）」「44 简单键」）。

### 4.4 客户端

- `useClientConfig.ts`：`FAILSAFE_CLIENT_CONFIG` 与 `normalizeClientConfig` 删除 `entryFeePercents`；
  头注删除该项。
- `stores/game.ts`：删除 `EntryFeePercent` 类型导入、`entryFeePercents` 状态、`setClientConfig` 赋值、
  reset 注释中的键名；`ClientConfigState` 的 `Omit` 列表加入 `'entryFeePercents'`（阶段 2 客户端先于
  协议删字段，避免类型仍要求该键——Task 3 删协议字段后再移除）。
- `lobby.vue`：**删除 `entryFeeOf` 导入**，改导入
  `import { entryFeeOfLevel as feeOfLevel, type BaseScoreLevel } from "@fight-the-landlord/protocol";`
  本地函数改为 `ticketOfLevel(lv: BaseScoreLevel)`（金币场 guard + `feeOfLevel(lv)` + `>0` 才返回）；
  模板 `entryFeeOfLevel(lv.baseScore)` → `ticketOfLevel(lv)`（否则旧导入未使用 ⇒ `vue-tsc` 红）。
- 测试：所有 `entryFeePercents` 夹具行删除；`base-score-selection` 的
  `GOLD_FEE_CONFIG_OK` 改为档位项带 `entryFeePercent:10/12`；门票断言仍为 1/9；
  `percent=0` / 缺字段 ⇒ 零门票行；删除「响应缺 entryFeePercents」用例（字段已不存在）。

### 4.5 conformance

- 20 键字面（slice-14/17/18/21/24）删除 `entryFeePercents`，注释/步骤文案 20→19；
  **slice-23:741 的 `length, 20` 断言 → 19**（步骤文案 :731 同步）；
- 管理面 52 键断言（slice-18:1025、slice-22:1193、slice-23:735/1283、slice-24:809）→51，
  说明文案去掉「台费」项；
- slice-14 的 `Array.isArray(entryFeePercents)` 正断言改为负断言：
  `checks.that(!('entryFeePercents' in (c7.body?.data ?? {})), 'C7 派生字段已删除')`
  （`checks.ok` 只收 message，不能用它带条件）；
- slice-25：删除 `entryFeePercentsFromLevels` 导入与 `canonicalFeeTable`；B 组与收尾的玩家面断言
  改读 `/api/config` 的 `baseScoreLevels`，用 `canonicalLevels` 与临时/快照档位表比较；
- slice-20 步骤文案 52→51（断言用 `CONFIG_KEYS.length` 动态，无需改数值）。

### 4.6 文档

- `docs/design.md`：删除 `currency.entryFeePercents` 行（1266）；`五十二键`→`五十一键`
  （143/427/529/536/1221/1512/1664/2144）；快照清单去「台费〔费率表〕」；
  1306/1317 的「本片起 41 键…共 47」→「共 46」；
  客户端可见键 20→19 并删除台费片增量描述（1278）。
- `docs/ops/first-deploy.md`：`五十二键一览`→`五十一键一览`；删除旧键行（1037）；
  「台费并入」迁移/回滚段改为阶段 2：新迁移删除旧行；回滚旧代码前用 `down`/SQL 恢复**四档**行，
  **并把档位表现有 `entryFeePercent`（≤50）回填旧键**，否则旧代码读旧键 = 静默不收费；
  删除「旧键行由种子迁移保证存在」的旧表述（阶段 2 后该行已被删）。
- `docs/client-protocol.md`：`/api/config` 响应删除 `entryFeePercents`；「五十键」→「五十一键」；
  「20 键」→「19 键」。
- `packages/config-service` / `api-gateway` / protocol 的头注键数同步（「五十键」→「五十一键」、
  「二十键」→「十九键」；`client-config.controller` 的键枚举串删项）；`EntryFeePercent` 与
  `entryFeePercentsFromLevels` 的注释去掉「旧第 42 键」「config-service 输出共用」的过期表述。

## 5. 错误处理与边界

| 情况 | 行为 |
|---|---|
| PUT `currency.entryFeePercents` | 400「未知配置键」（键不在 CONFIG_KEYS；不再有 D14 专用文案） |
| 档位表旧形态（全部缺 `entryFeePercent`） | 仍 400（D13 保留） |
| 数据库旧键行 | 新迁移 `up` 删除；`down` 恢复四档×0 |
| `/api/config` | 恒 19 键；不再有 `entryFeePercents` |
| 客户端旧服务端（响应无 `baseScoreLevels[].entryFeePercent`） | 门票行不渲染（0/缺省），档位卡照常 |
| 旧 APK 请求新服务端 | 忽略多出的 `entryFeePercent`，不再有派生字段 ⇒ 不显示门票，不崩 |
| 新客户端请求旧服务端（阶段 1） | 阶段 1 已下发档位项 `entryFeePercent` ⇒ 门票正常 |
| 回滚旧代码 | 旧代码读旧键 ⇒ 先 `down` 恢复该行（四档×0 种子）或 SQL 恢复，且值 ≤50 |

## 6. 测试判据

1. **protocol**：`CONFIG_KEYS` 恰 51、`CLIENT_CONFIG_KEYS` 恰 19；
   `entryFeeOfLevel`：15×10%⇒1、15×100%⇒15、缺字段/0⇒0；旧键写入 ⇒ 400 未知键（真管线，见 2）；
2. **config-service**：`GET /api/admin/config` 51 键；`GET /api/config` 19 键且无 `entryFeePercents`；
   `platform-config.service` 的 SEED 51 行；旧键 PUT ⇒ 400 未知键（真管线）；
   **残留旧键行不泄漏**：假库直塞旧键行 ⇒ `/api/config` 仍 19 键且无该字段；D13 保留用例全绿；
3. **room-service**：`config-cache.test.ts` 去掉旧键夹具后编译绿；「档位项缺字段 ⇒ 等长全 0 行」仍绿；
4. **迁移**：新迁移 `up` 恰一条 DELETE；`down` 恰一条 INSERT IGNORE + 历史种子逐字；
   时间戳晚于 1795800000000 且全仓唯一；
5. **admin**：`pnpm verify:admin` 全过（protoSet/iaKeySet 51、STRUCT_KEYS 4、简单 47）；
   旧键不再出现在 CONFIG_IA/STRUCT_KEYS/HIDDEN/CONFIG_NOTES/STRUCT_META；
6. **客户端**：全量测试；大厅门票用档位项字段；缺字段/0 不渲染；所有夹具无旧字段；
   `pnpm -C apps/client build`；
7. **conformance**：`turbo run lint build --filter=./tools/conformance --force` 绿；
   slice-25 玩家面断言走 `baseScoreLevels`；
8. **全量**：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、`pnpm verify:admin`。

## 7. 风险

| # | 风险 | 处置 |
|---|------|------|
| R1 | 旧 APK 不再显示门票 | 用户已确认无旧客户端；要显示需重打 APK；服务端收费不受影响 |
| R2 | 回滚旧代码缺旧键行 | 新迁移 `down` 或 SQL 恢复；运维回滚段写明 |
| R3 | 旧 admin 缓存页保存旧形态档位表 | D13 保留 ⇒ 400 提示硬刷新；不清零 |
| R4 | conformance 键数硬编码遗漏 | 本片集中改 20→19、52→51；grep 复核 |
| R5 | 测试夹具漏删派生字段 ⇒ TS 编译红 | 全量 client/protocol/config-service 测试兜底 |
| R6 | 迁移 down 的种子与历史不一致 | down 逐字复用 `1795200000000` 的 JSON 数组；迁移测试钉 |
| R7 | 部分部署窗口：新客户端已发、旧服务端未上 | 先上服务端（阶段 2）再发客户端；或客户端对缺字段按 0（已实现） |

## 8. 涉及文件

**生产代码（约 10）**：`packages/protocol/src/config.ts`、`packages/config-service/src/config/client-config.controller.ts`、
`packages/config-service/src/config/platform-config.service.ts`、
`packages/config-service/src/migrations/1796000000000-RemoveEntryFeePercents.ts`（新建）、
`admin/app.js`、`apps/client/src/composables/useClientConfig.ts`、`apps/client/src/stores/game.ts`、
`apps/client/src/pages/lobby/lobby.vue`。

**测试 / 静态闸（约 21）**：`packages/protocol/src/config.test.ts`、
`packages/config-service/test/{client-config,config.validation,platform-config.service,admin.controller,config.rpc,migration}.test.ts`、
`packages/config-service/test/helpers/config-probe.ts`、`packages/room-service/test/config-cache.test.ts`、
`scripts/verify-admin-static.mjs`、`apps/client/test/*.test.ts`（夹具）、
`tools/conformance/src/slices/slice-{14,17,18,21,22,23,24,25}.ts`。

**注释/静态资源（约 6）**：`packages/config-service/src/config/{admin.controller,platform-config.entity,platform-config.service,client-config.controller}.ts`、
`packages/api-gateway/src/gateway/gateway.controller.ts`、`admin/index.html`。

**文档（3）**：`docs/design.md`、`docs/ops/first-deploy.md`、`docs/client-protocol.md`。

## 9. 审查记录（r1，独立 reviewer）

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| B1 | 阻断 | `room-service/test/config-cache.test.ts:594-613` 把旧键塞进 `snapshotWith(Partial<Record<ConfigKey,unknown>>)`，删键后 TS2353；spec/plan 文件清单漏 room-service | §2/§6/§8 补该文件；改写为「档位项缺字段 ⇒ 等长全 0 行」，保留判别力 |
| H1 | 高 | slice-23:741 还有一条 `length, 20` 运行期断言，只跑 conformance build 抓不到 | §4.5/§6 补 slice-23:741（步骤文案 :731 同步） |
| H2 | 高 | `checks.ok` 只收 message；计划里的 `checks.ok(cond, msg)` 会 TS2554，改成单参又会假绿 | §4.5 改用 `checks.that(cond, msg)` |
| L1 | 低 | 阶段 1 spec 说「阶段 2 移除 D13 / 保留派生输出」，本片相反且未登记 | D3/D4 增加 supersession 说明 |
| L2 | 低 | `design.md:427` 的「五十二键」与 `:1306/:1317` 的「共 47」会漏改 | §4.6 补 427、1306/1317 |
| L3 | 低 | 静态闸旧键断言实为 5 条（非 3），头注 50/45/44 陈旧 | §4.3 补头注改正；计划逐行列出 5 条删除 |
| L4 | 低 | 源码头注多用「五十键」（按 52→51 搜会漏）；controller 键枚举串含旧键 | §4.6/§8 逐文件列入；枚举串删项 |
| L5 | 低 | lobby.vue 只说加新导入，未说删 `entryFeeOf` 导入/加 `BaseScoreLevel` 类型 ⇒ 编译红 | §4.4 写全导入替换 |
| L6 | 低 | 回滚段只恢复四档×0；非零费率会静默不收费；示例 UPDATE 只有两档 | §4.6 写明「回填现有费率（≤50）+ 四档示例」，删「种子保证存在」 |
| L7 | 低 | `EntryFeePercent`/`entryFeePercentsFromLevels`/admin 注释仍指旧键或 config-service 输出 | §4.6/§8 列入注释同步 |
| L8 | 低 | §6.1 协议函数级判据与计划的 HTTP 400 不一致 | §6.1 改为「旧键写入 ⇒ 400 未知键（真管线）」 |
| L9 | 可选 | 删除「旧键不再被读」用例后，失去「残留旧键行不泄漏」守卫 | §6.2 增加：假库直塞旧键行 ⇒ `/api/config` 仍 19 键且无该字段 |

正向核验（reviewer 实测）：mock-server 确无该字段；52 键断言全集 = spec 所列 5 处 + config-service
SEED 长度 + 静态闸两处；迁移同事务执行，无 52/51 观察窗口；`down` 的 `INSERT IGNORE` + version 1
与历史种子逐字一致；D13 保留不误伤新 admin；Task 1→2→3 过渡可编译；slice-25 改断 `baseScoreLevels`
仍保持判别力；客户端夹具清单完整；回滚/部分部署风险处置成立。

## 10. 代码审查记录（r1，独立 reviewer，`a63f3a5..d0b8921`）

结论：**无 Critical**；2 条 Important（文档/注释级）、7 条 Minor，全部已修。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| I1 | Important | `config-probe.ts:29-38` 种子来源注释仍写 1795900000000，且迁移枚举漏记牌器两迁移/时序不单调 | 改为 1796000000000，补齐 179570/179580，按时间序重写 |
| I2 | Important | 运维回滚示例把四档 percent 全写 0，与「必须回填当前费率」矛盾 ⇒ 照抄会静默不收费 | 示例改非零并加粗警告「四个 percent 必须替换为档位表当前值」 |
| M1 | Minor | room-service `config-cache.service.ts` 仍说派生 helper「与 config-service 输出同一实现」 | 改为「与客户端 `entryFeeOfLevel` 共用 `entryFeeOf` 公式」 |
| M2 | Minor | design.md 可见键序号未重排（出现两个「第 19 个」） | 16/17/18/19 重排 |
| M3 | Minor | `stores/game.ts` 头注绝对计数与实现不符 | 去掉绝对计数，改为「含某键」表述 |
| M4 | Minor | slice-18/24 注释混用阶段前后计数、悬空指代 | 重写注释 |
| M5 | Minor | 本地 `dist` 残留 179590 旧迁移产物 | 清理（镜像/git 均不含 dist） |
| M6 | Minor | robot/room/user 源码与测试仍写「四十九键」 | 统一改五十一键 |
| M7 | Minor | 计划 admin 预期 251、spec §6 编号重复 | 改 246；编号 1–8 |

正向核验（reviewer 实测）：旧键自然 400（真管线 + 零写库）；D13 仍先于 parse；迁移 up/down
逐字与唯一性；残留旧键行不泄漏；客户端门票只读档位项；conformance 20/52 字面全同步且
`checks.that` 用法正确；admin 旧键零残留、246 checks；未发现假绿。
