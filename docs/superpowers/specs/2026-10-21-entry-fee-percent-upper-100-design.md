# 台费百分比上限 0–50 → 0–100 — 设计

- 日期：2026-10-21
- 前置：台费并入底分档位表（方案 A 阶段 1）已上线测试服（`dev-86011be` 起）；本片是用户后续微调前的**上限放开**。
- 用户裁决（2026-10-21）：上限放到 **100%**，不允许 >100 —— 保持 `台费 ≤ baseScore ≤ 入队门槛`；
  当前 1/2/5/10 配 100/50/20/10 实际都是 1 金币，**公式不改**，具体数值由用户后续自己调。
- 范围：`packages/protocol` / `packages/config-service`（测试与错误文案）/ `admin` / `scripts/verify-admin-static.mjs` / 文档。
- **客户端零改动**；`currency.rakePercent` 不动；旧键 `currency.entryFeePercents` 保持 0–50 只读弃用（任务 B 删除）。

## 1. 背景 / 问题

`game.baseScoreLevels[].entryFeePercent` 当前是整数 `0–50`。用户要把台费调到高于 50%
（最大 100%，即门票 = 底分），50% 的上限不够用。放宽上限**同时改变写入口校验与读侧解析**
（config-service / room-service / currency-service 共用 `parseConfigValue`），后台输入控件同步；
计费公式 `max(1, floor(baseScore × percent / 100))` 不变。51–100 从此在**读侧**也合法，
因此发布顺序/回滚窗口必须按「新代码先上、配置后调」执行（见 §7 R6）。

## 2. 范围

**做**

- `parseBaseScoreLevels` 的 `entryFeePercent` 校验上限 50 → 100（仍是整数、下界 0）；
- `BaseScoreLevel` 字段注释、`parseBaseScoreLevels` 注释、`entryFeeOf` 算术注释同步（单笔上限 4095 → 8191）；
  `packages/protocol/src/currency.ts:293` 的 `feeAmount` 注释「公式上界 4095」同步改 8191（域哨兵 1e6 不变）；
- admin 档位表第三列 `max=100`、保存校验 `>100` 拒绝、提示文案 0–100；`CONFIG_NOTES` 同步；
- `verify-admin-static` 增加**块级**断言：第三列 `max='100'`、getter `percent > 100`（且无 `percent > 50`）、
  文案含 0–100 且不含 0–50；`CONFIG_NOTES` 的档位表条目另做切片断言（它在 `buildLevelsEditor` 块外）；
- config-service：D13 旧形态错误文案里的「0–50」改「0–100」，并在 `config.validation.test.ts`
  把 D13 用例的 reason 收紧为「请硬刷新…0–100」；派生输出加一个 `entryFeePercent: 100` 用例；
- room-service：`config-cache.test.ts` 的越界夹具 `entryFeePercent: 51` 改为 `101`
  （放宽后 51 已合法；这是**必改**，否则该用例必红）；同文件补一条 `entryFeePercent: 100`
  读侧正例（钉住新域在钱路径上被接受）；
- 文档：`docs/design.md:1233`、`docs/ops/first-deploy.md:1021` 的新字段描述 0–50 → 0–100；
  `design.md:1266` 旧键行补半句「派生输出 percent 可为 0–100，不受本键 0–50 约束」；
  `first-deploy.md` 回滚段补「回滚前须把各档调回 ≤50」硬步骤。

**不做**

- 不改 `entryFeeOf` 公式/保底语义，不改计费调用链；
- 不扩宽旧键 `currency.entryFeePercents`（保持 0–50，只读弃用；任务 B 删除）；
- 不改 `currency.rakePercent`（0–50）；
- 不删派生字段、不改 `CLIENT_CONFIG_KEYS` / 键数；
- 不改客户端（`entryFeeOf` 消费派生表，percent=100 自然成立）；
- 不改 conformance（slice-25 只用 10%，无需重建镜像逻辑；镜像仍需重建是 protocol 变更的部署副作用）。

## 3. 决策表

| # | 决策 | 依据 |
|---|------|------|
| D1 | `entryFeePercent` 合法域 = 整数 `0 ≤ n ≤ 100` | 用户裁决；100% = 门票等于底分，仍满足 `fee ≤ baseScore` |
| D2 | 旧键 `currency.entryFeePercents` 的 `percent` 保持 `0 ≤ n ≤ 50` | 键已只读且任务 B 删除；API 面对该键的任何写入都被 D14 先拒，0–50 只在单测/迁移/直读面可见；扩宽它只会扩大死代码与测试面 |
| D3 | `currency.rakePercent` 保持 `0 ≤ n ≤ 50` | 本任务只动台费新字段；抽水是另一语义 |
| D4 | `entryFeeOf` 代码不变，只改算术注释：`percent ≤ 100` ⇒ 单笔 `≤ 8191` | 公式与保底已由 `entryFeePercent` 域约束；8191 × 100 = 819,100 远低于双精度误差界 |
| D5 | admin 第三列 `max=100`，getter 校验 `percent > 100` 拒绝，提示 0–100 | 写入口与服务端同域；避免「后台让填、服务端拒」 |
| D6 | `verify-admin-static` 断言收窄在 `buildLevelsEditor` 函数块内：`pctEl.max = '100'`、`percent > 100`、无 `percent > 50`、`0–100` 存在、`0–50` 不存在；`CONFIG_NOTES` 条目另做切片断言 | 全局 `includes('100')` 恒真；块级 + 负断言 + getter 数值边界才防「只改控件不改校验」与文案漂移 |
| D7 | D13 旧形态错误文案「API 写入请显式给 0–100」 | 管理页面行内错误是用户可见面，必须与服务端域一致 |
| D8 | config-service 派生用例用 `entryFeePercent: 100` ⇒ `/api/config` 的 `entryFeePercents` 含 `{ percent: 100 }` | 证明 protocol 放宽后 controller 的复核/派生链接受 100（坏值路径仍 `[]`） |
| D9 | 文档只改新字段两处；旧键行保持 0–50，并补半句「派生输出可为 0–100」；运维手册回滚段补「回滚前调回 ≤50」 | 旧键仍是历史只读契约（任务 B 再删）；回滚窗口是新域带来的真实运维风险 |
| D10 | 客户端零改动 | 派生表形状不变；`entryFeeOf` 对 100% 返回 `baseScore`，大厅「门票 N」显示正确 |

## 4. 实现设计

### 4.1 `packages/protocol/src/config.ts`

- `BaseScoreLevel.entryFeePercent` 注释：`整数 0–100；缺省 = 0 = 不收`；
- `parseBaseScoreLevels` 的 `entryFeePercent > 50` → `> 100`，错误文案 `0 ≤ n ≤ 100`；
- `parseBaseScoreLevels` 头顶注释 `（0–50 整数…）` → `（0–100 整数…）`；
- `entryFeeOf` 注释：`percent ≤ 50 ⇒ 单笔 ≤ 4095` → `percent ≤ 100 ⇒ 单笔 ≤ 8191`；
- `parseEntryFeePercents`（旧键）**不动**。

### 4.2 `packages/config-service`

- `platform-config.service.ts` D13 错误文案：`API 写入请显式给 0–50` → `0–100`；
- `test/client-config.test.ts` 新增（或扩展现有派生用例）：档位含 `entryFeePercent: 100`
  ⇒ `entryFeePercents` 含 `{ baseScore: 15, percent: 100 }`；
- 其余派生/坏值/旧键不读用例保持。

### 4.3 `admin/app.js` + `scripts/verify-admin-static.mjs`

- `buildLevelsEditor`：`pctEl.max = '100'`；getter `percent > 100` 拒绝；
  `struct-note` 与行内错误文案 0–100；`CONFIG_NOTES['game.baseScoreLevels']['取值']` 0–100；
- `verify-admin-static.mjs` 在第 8 节增加：
  - `levelsFn.includes("pctEl.max = '100'")`
  - `levelsFn.includes('0–100')`
  - `!levelsFn.includes('0–50')`
  - 并把 `buildLevelsEditor` 的提示/校验文本纳入同一块级断言。

### 4.4 文档

- `docs/design.md:1233`：`entryFeePercent` 可选整数 0–50 → 0–100；
- `docs/ops/first-deploy.md:1021`：`台费 0–50%` → `台费 0–100%`；
- `docs/design.md:1266` / `first-deploy.md:1037`（旧键）**不改**。

## 5. 错误处理与边界

| 情况 | 行为 |
|---|---|
| `entryFeePercent = 100` | 合法；`entryFeeOf` = `baseScore`（如 15 分 ⇒ 15 金币） |
| `entryFeePercent = 101` / `-1` / `1.5` / `'10'` / `null` | 写入口 400，文案 `0 ≤ n ≤ 100 的整数` |
| 旧键被写入（任意值，含 51） | 一律 400「已并入/只读」（D14 守卫先于 parse）；parser 自身仍保持 0–50，仅单测/迁移/直读可见 |
| admin 第三列填 101 | 行内错误「台费须为 0–100 的整数百分比」；不发请求 |
| admin 第三列留空 | 0（现状） |
| 派生输出 percent = 100 | 客户端 `entryFeeOf` 返回底分；服务端收费同一函数 |

## 6. 测试判据

1. **protocol**：`entryFeePercent` 0 / 100 通过；101 / -1 / 1.5 / `'10'` / `null` 拒绝；
   `entryFeeOf(15, [{15,100}]) = 15`、`entryFeeOf(8191, [{8191,100}]) = 8191`；
2. **config-service**：派生输出含 `{ baseScore: 15, percent: 100 }`；D13 错误文案断言含
   「请硬刷新…0–100」；既有派生/旧键不读/坏值 `[]` 全绿；
3. **room-service**：越界夹具改 101 后全绿；`entryFeePercent: 100` 读侧正例 ⇒ `[{percent:100}]`；
4. **admin**：`pnpm verify:admin` 全过（基线 242 + 9 条新断言，含审查加固 2 条），且新增断言在旧实现上会红：
   `pctEl.max='100'`、`percent > 100)`、`percent < 0`、无 `percent > 50`、文案 `0–100`、无 `0–50`、
   CONFIG_NOTES 切片锚点存在且条目为 `0–100`、全局无 `0–50`；
5. **回归**：客户端全量测试零改动；货币/结算/收费既有用例全绿；
6. **全量**：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、`pnpm verify:admin`。

## 7. 风险

| # | 风险 | 处置 |
|---|------|------|
| R1 | 100% 时台费 = 底分，玩家赢局净收益变小 | 用户明确要放开到 100%；公式与保底不变；运营自行配置 |
| R2 | 只改 protocol 不改 admin ⇒ 后台无法输入 >50 | 同片改 admin + 静态闸 |
| R3 | 只改测试不改文档 ⇒ 运维手册误导 | 文档两处同片更新；旧键行保持 |
| R4 | 旧键被误扩宽 | 明确不动 `parseEntryFeePercents`；测试保持 51 拒绝（单测面） |
| R5 | 静态闸假绿 | 块级断言 + `0–50` 负断言 + getter 数值边界断言 + CONFIG_NOTES 切片 |
| R6 | **新旧镜像混跑/回滚窗口**：配置一旦含 51–100，旧代码解析失败 ⇒ `/api/config` 的 `baseScoreLevels` 空表（大厅档位卡消失）、room-service 台费静默 0、currency-service 救助不可用；旧键写不下 51–100，旧回滚手顺失效 | 发布顺序 = **新镜像先全量上**（14 target 同提交重建）→ 再调 >50；回滚前在新栈把各档 `entryFeePercent` 调回 ≤50（或 0）并自证；conformance 镜像未重建不得跑 slice-25（旧 protocol 会把 100 判 400）。写入 ops 回滚段 |
| R7 | 运营不知道 100% 的含义 | admin CONFIG_NOTES 与运维手册补「100 = 门票等于底分（赢局净收益相应变小）」 |

## 8. 涉及文件

**生产代码（3）**：`packages/protocol/src/config.ts`、`packages/protocol/src/currency.ts:293`（注释）、`admin/app.js`
**服务端文案（1）**：`packages/config-service/src/config/platform-config.service.ts`
**测试 / 静态闸（4）**：`packages/protocol/src/config.test.ts`、
`packages/config-service/test/client-config.test.ts`、`packages/config-service/test/config.validation.test.ts`、
`packages/room-service/test/config-cache.test.ts`、`scripts/verify-admin-static.mjs`
**文档（2）**：`docs/design.md:1233`（+ `:1266` 派生说明）、
`docs/ops/first-deploy.md:1021`（+ 回滚段）

## 9. 审查记录（r1，独立 reviewer）

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| B1 | 阻断 | `room-service/test/config-cache.test.ts:629` 把 51 当越界，放宽后必红；且「只影响写入口」错——parse 同时是读侧校验 | §1 改写；§2/§6/§8 列入该文件；越界值 51→101，并补 100 读侧正例 |
| H1 | 高 | 新旧镜像混跑/回滚窗口：配置含 51–100 时旧代码大厅档位消失、台费静默 0、救助不可用；旧回滚手顺依赖旧键写不下 >50 | §7 R6 + 运维回滚段 + 部署顺序（新镜像先全量上）；conformance 镜像未重建不跑 slice-25 |
| L1 | 低 | 静态闸只钉 max/文案，漏改 getter `percent > 50` 仍全绿 | D6/§6.4 增加 `percent > 100` 正断言与 `percent > 50` 负断言 |
| L2 | 低 | `CONFIG_NOTES` 在 `buildLevelsEditor` 块外，块级断言覆盖不到 | D6/§6.4 增加 CONFIG_NOTES 切片断言 |
| L3 | 低 | `packages/protocol/src/currency.ts:293` 的「公式上界 4095」注释遗漏 | §2/§8 列入同片改 8191（域哨兵 1e6 不变） |
| L4 | 低 | §5「旧键 percent=51 仍 400」理由不实（实际由 D14 只读先拒）；旧键/派生同名字段易被未来「一致性修复」误伤 | §5 改写；`design.md:1266` 补「派生输出可为 0–100」 |
| L5 | 低 | 「100 = 门票等于底分」只写在风险表，运营看不到 | R7：admin CONFIG_NOTES 与运维手册补一句 |

正向核验（reviewer 实测）：客户端零改动成立；conformance 源码零改动成立（唯一附加约束=镜像先重建）；
旧键运行期无消费方；钱路径无溢出（fee ≤ 8191 ≪ 1e6）；`台费 ≤ baseScore ≤ 入队门槛` 保持；
fail-safe 方向不变；边界表与 parser 语义一致；除上述两处外无遗漏的 0–50 文案。

## 10. 代码审查记录（r1，独立 reviewer，`a182c4b..HEAD`）

结论：**无 Critical / Important**；4 条 Minor + 1 条可选覆盖建议，全部已修。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| C1 | Minor | 静态闸 `percent > 100` 子串会被 `percent > 1000` 蒙混 | 改为闭合断言 `percent > 100)`；顺手补 `percent < 0` |
| C2 | Minor | CONFIG_NOTES 切片终点锚缺失时 `slice(start, -1)` 会假绿 | 先断言 `notesStart !== -1 && notesEnd > notesStart` 再切片 |
| C3 | Minor | 运维手册只写回滚方向，未写「新镜像先全量上再调 >50」 | 回滚段补上线顺序（14 镜像全新建好再调） |
| C4 | Minor | 「旧 protocol 会把 slice-25 的 100 判 400」理由不成立（slice-25 只写 10） | 改为「conformance 镜像随本提交重建；本片未改 slice-25」 |
| C5 | 可选 | currency-service 读侧无 100 正例（覆盖不对称） | 在 `minBaseScoreLevel` 正例表中加 `entryFeePercent:100` 档，期望不变 |

正向核验（reviewer 实测）：写入口/读侧三服务/admin/静态闸/文档/钱路径逐条一致；
7 条新断言在旧实现上全部为红（用 `git show a182c4b:admin/app.js` 回放）；
protocol 43/43、静态闸 249/249 真跑通过。
