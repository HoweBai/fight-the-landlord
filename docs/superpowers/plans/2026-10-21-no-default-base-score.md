# 删除冻结的缺省底分：实现计划

- 日期：2026-10-21
- 对应 spec：`docs/superpowers/specs/2026-10-21-no-default-base-score-design.md`（含 r1 设计审查、r2 计划审查）
- 分支：`dev`；每个任务一个 commit
- 用户裁决：底分对外必填；省略 ⇒ 档位表最低档；救助门槛同源；不迁移、不加键、不改协议
- **计划审查后的关键排序**：`DEFAULT_BASE_SCORE` 的**导出删除放到最后**（Task 6），
  否则 Tasks 2–5 会在测试跑起来之前就因 TS2305 失败，TDD 的 RED 全是编译错而不是断言红。

## Global Constraints

1. **不改协议线格式**、不加配置键、不加迁移；REST `CreateRoomDto.baseScore` 保持可选。
2. 缺省 = 档位表**数值最小档**（`Math.min`），不是数组首项。
3. 失败方向：建房/钱包 `10007`；广告回调瞬态抛错（不落 done）；客户端不点亮。**绝不回退到 15**。
4. 0 哨兵三道网：`game.start` 强校验 → `validateOutbound`（既有）→ `settleGame` 守卫。
5. 测试统一走 turbo（`test` 依赖本包 build；`lint` 依赖 `^build`），避免旧 `dist` 假绿：
   `pnpm exec turbo run test lint --force --filter=<包路径>`。
6. 每个任务：先改/加测试 → 跑红（写明 RED 形态）→ 最小实现 → 跑绿 → commit（带 attribution）。
7. 不夹带无关重构；只改任务列出的文件。
8. 中间提交的构建状态：Tasks 2–5 各自删本包 import 后，依赖包仍可构建（protocol 常量此时仍在）；
   唯一允许的「暂不可构建」是当前任务正在改的包。
9. 最终：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、
   `pnpm verify:admin`、工作区干净。conformance 留到合 master 权威轮（需重建镜像）。

---

## Task 0 — 计划落盘

把本计划提交（含下面的「计划审查记录」）。之后每个任务一个 commit。

Commit：`docs(plan): 删除冻结缺省底分实现计划 + 计划对抗审查`

---

## Task 1 — protocol：只删「表必须含 15」；config-service 同步

**Files**

- `packages/protocol/src/config.ts`
- `packages/protocol/src/config.test.ts`
- `packages/config-service/test/config.validation.test.ts`

**TDD**

1. 改 `config.test.ts`：
   - **新增**「不含 15 的表也合法」：`[{标准场,80}]` 通过；
   - 删除「表不含 15 ⇒ 抛 `/15/`」；
   - **暂时保留** `DEFAULT_BASE_SCORE` import 与「常量是 15」用例（Task 6 再删）；
   - 保留空表 / 名字空 / 0 / 8192 / 重复 ⇒ 抛。
2. 跑 protocol → **RED = 断言红**（新正例命中现行 membership 校验）。
3. 实现：只删 `parseBaseScoreLevels` 的 membership 分支；**不动常量导出**；更新该函数注释。
4. 跑 protocol → GREEN；此时 `config-service` 的 C18 用例会因写入口不再拒绝而 **RED**。
5. 删除 `config.validation.test.ts` 的 C18 用例（`档位表不含 15`），保留「含 15 ⇒ 200」正例。
6. 跑 `--filter=./packages/protocol --filter=./packages/config-service` → GREEN；lint。
7. Commit：`feat(protocol): 档位表不再强制包含缺省底分 15`

**RED 形态**：断言红（不是编译错——常量仍在，所有 import 仍可解析）。

---

## Task 2 — room-service：省略底分 ⇒ 最低档

**Files**

- `packages/room-service/src/rooms/rooms.service.ts`
- `packages/room-service/test/rooms.base-score.test.ts`
- `packages/room-service/test/rooms.start.test.ts`
- `packages/room-service/test/rooms.service.test.ts`
- `packages/room-service/test/rooms.controller.test.ts`
- `packages/room-service/test/rooms.controller-switch.test.ts`

**TDD**

1. 改测试：
   - `rooms.base-score.test.ts`：
     - 删除 `SHARED_DEFAULT_BASE_SCORE` 同值对与「缺省 ∈ 表」旧用例；
     - **替换** :132-136「不传 baseScore 走缺省、不校验」为「省略 ⇒ 桩表最低档 15，且
       `baseScoreLevels` **被调用一次**」；同步改写 :30-31 的「不传不查表」纪律注释；
     - 判别力：桩表 `[{80},{5},{15}]` ⇒ 省略得 5（min，不是首项/常量）；
     - 「表不可用 + 省略 ⇒ 10007，Redis 零写入」；
     - 「表元素坏 ⇒ 10007」——坏表用例走**省略路径**，并做类型逃逸：
       `makeConfigCache([{ name: 'X', baseScore: '5' }] as unknown as { name: string; baseScore: number }[])`；
     - 显式非法值 ⇒ `BAD_PARAM`；显式合法值 ⇒ 通过（保留现状断言）。
   - 其余 4 个文件：`DEFAULT_BASE_SCORE` 导入替换为字面量 `15`（或 `BASE_SCORE_TIERS[0].baseScore`），
     `Room` 夹具补合法底分。
2. 跑 room-service → **RED = 断言红**（旧实现：省略用常量 15、不调表；min=5 用例得 15）。
3. 实现 `create()`（spec §4.2，**形状自证在成员校验之前**）：
   ```ts
   let levels; try { levels = await this.configCache.baseScoreLevels(); } catch (err) { /* 原样 */ }
   if (!levels.every((l) => Number.isInteger(l.baseScore) && l.baseScore > 0)) throw 10007;
   if (dto.baseScore !== undefined && !levels.some((l) => l.baseScore === dto.baseScore)) throw BAD_PARAM;
   const baseScore = dto.baseScore ?? Math.min(...levels.map((l) => l.baseScore));
   ```
   - 删除 `DEFAULT_BASE_SCORE` import / re-export；更新类注释。
4. 重跑 → GREEN；lint。
5. Commit：`feat(room): 省略底分改取档位表最低档`

**RED 形态**：断言红（protocol 常量仍在，编译通过）。

---

## Task 3 — shared + game-service：删兜底、加守卫

**Files**

- `packages/shared/src/ddz/game.ts`、`packages/shared/src/ddz/settle.ts`、`packages/shared/src/ddz/types.ts`（注释）
- `packages/shared/src/ddz/types.test.ts`、`packages/shared/src/ddz/settle.test.ts`
- `packages/game-service/src/game/game.service.ts`、`packages/game-service/src/game/view.builder.ts`
- `packages/game-service/test/game.service.test.ts`
- `packages/game-service/test/game.robot.test.ts`
- `packages/game-service/test/view.builder.test.ts`

**TDD**

1. 改测试：
   - `types.test.ts`：删 `DEFAULT_BASE_SCORE` import/断言；`createSession(..., 15)` ⇒ 15；
     `createSession(...)` 省略 ⇒ 0；手写 `GameSession` 夹具用字面量。
   - `settle.test.ts`：新增「finished session + baseScore 0 / -1 / 1.5 ⇒ 抛 `Invalid baseScore`」；
     保留「未结束局先报 `Game not finished`」（守卫位置判据）。
   - `game.service.test.ts`：`startGame` 对 0 / -1 / 1.5 抛 `BAD_PARAM` 且不建会话；
     「缺失」用例需类型逃逸：`{ roomCode, players } as unknown as StartGameRequest`；
     已有会话的重复 start（本次传 0）⇒ 幂等返回既有会话、不报错。
   - `view.builder.test.ts`：新增「`baseScore: 0` 的会话 ⇒ `buildPlayerView` 抛 `ProtocolError`」
     （0 哨兵第一道网的集成判据）。
   - `game.robot.test.ts:314`：`createSession('ROOM-OLD', [...], () => 0, 100)`，注释写明旧会话底分由
     `game.start` 写入。
2. 跑 shared + game-service → **RED**：
   - `createSession(..., 15)` 当前签名只有 3 参 ⇒ TS2554（**类型红**，属正常：第 4 参是接口变更）；
   - `settleGame` 0 底分当前不抛（行为红）；
   - `startGame` 1.5 / 0 当前被兜底成 15（行为红）；缺失用例经类型逃逸后行为红。
3. 实现：
   - `createSession` 第 4 参 `baseScore = 0`，返回对象用形参；删 import/re-export；
   - `settleGame`：winner → landlord → **baseScore 守卫** → multiplier/unitScore；
   - `game.service.startGame`：幂等早退之后加正整数校验；`createSession(..., this.random, dto.baseScore)`；
     删 `session.baseScore = …` 兜底；
   - `view.builder.ts` 删 re-export 与 docstring；`types.ts` 注释更新。
4. 重跑 → GREEN；lint。
5. Commit：`feat(game): game.start 底分必填为正整数，删除代码缺省`

---

## Task 4 — currency-service：救助门槛 = 最低档 × 倍率

**Files**

- `packages/currency-service/src/config/config-cache.service.ts`
- `packages/currency-service/src/config/config.client.ts`（注释）
- `packages/currency-service/src/wallet/wallet.controller.ts`
- `packages/currency-service/src/ads/ad-callback.service.ts`
- `packages/currency-service/test/config-cache.test.ts`
- `packages/currency-service/test/relief.test.ts`
- `packages/currency-service/test/ad-callback.test.ts`

**TDD**

1. 改测试：
   - `config-cache.test.ts`：`minBaseScoreLevel` 四态；「取最小」用**首项非最小**的表
     `[{80},{5}]`（否则 `levels[0]` 实现也绿）。
   - `relief.test.ts`：配置桩加 `minBaseScoreLevel`；现有 150/149 边界保持（桩最低档 15）；
     新增「桩最低档 5 ⇒ 门槛 50 / 49」；「最低档 null ⇒ 503/10007、不签发、claim 键零新增」
     （先 `seedBalanceCache` 预热余额）。
   - `ad-callback.test.ts`：配置桩加方法；`THRESHOLD` 改为桩常量 15×10；
     新增「最低档 5 ⇒ 门槛 50 / 49」；「最低档 null ⇒ 抛、不落 done」。
2. 跑 currency-service → **RED**：
   - `minBaseScoreLevel` 调用 ⇒ TS2339（新方法尚未存在；类型红）；
   - 门槛判别用例 ⇒ 行为红（旧实现恒用 15×10）。
3. 实现（spec §4.5）：
   - `minBaseScoreLevel()`（`parseConfigValue` 复用，fail ⇒ null）；
   - 钱包在「开关关」之后取最低档，null ⇒ `503/10007`；
   - 广告回调 null ⇒ 抛瞬态；门槛用最低档；
   - 注释：`config.client.ts:17-19`「消费面只有三键」→ 四键（档位表无代码默认，fail-closed）；
     `config-cache.service.ts:84` 写成「三键默认 + 档位表 fail-closed」；`:197`、
     `wallet.controller.ts:37,166`、`ads/ad-callback.service.ts:33` 的「15 ×」→「最低档 ×」。
4. 重跑 → GREEN；lint。
5. Commit：`feat(currency): 救助门槛改为档位表最低档 × 入场倍率`

---

## Task 5 — 客户端：救助门槛取档位表最低档

**Files**

- `apps/client/src/stores/game.ts`
- `apps/client/test/lobby-ux.test.ts`
- `apps/client/test/source-boundary.test.ts`

**TDD**

1. 改测试：
   - `lobby-ux.test.ts` 新增：
     - 档位表 `[80,5]`、余额 **49 ⇒ 点亮**、**50 ⇒ 不点亮**（判别带；平衡 60 也可，但 49/50 是
       该表的精确边界。旧常量 15 ⇒ 门槛 150，50 < 150 会错误点亮 ⇒ 断言红）；
     - 档位表 `[]` ⇒ `reliefAvailable === false`（余额 0 也不点亮）。
   - `source-boundary.test.ts`：删除 `DEFAULT_BASE_SCORE` 两条正则（:363-364）**与 :389 正例**；
     :393 合法样本改为 `lowest * s.entryMultiplier`；:350-354 注释同步。
2. 跑客户端 → **RED = 断言红**。
3. 实现 `reliefAvailable`（spec §4.6）：空表显式 false；`reduce` 取最低档；删 import；更新注释。
4. 重跑 → GREEN；`pnpm -C apps/client lint`（vue-tsc）。
5. Commit：`feat(client): 救助门槛取服务端档位表最低档`

---

## Task 6 — 删除 `DEFAULT_BASE_SCORE` 导出（收尾）

**Files**

- `packages/protocol/src/config.ts`（删除常量、文件头说明）
- `packages/protocol/src/config.test.ts`（删除「常量是 15」用例与 import）
- 全仓 grep 清点残留（`packages/shared/src/ddz/game.ts` 的 re-export 已在 Task 3 删除）

**步骤**

1. `grep -R "DEFAULT_BASE_SCORE" packages apps tools scripts admin docs` 确认只剩：
   protocol 常量与测试、注释/文档（Task 7 处理）。
2. 删除常量与测试用例。
3. 跑 `pnpm exec turbo run test lint --force`（全仓）→ GREEN；任何残留 import 会在这里暴露。
4. Commit：`chore(protocol): 删除 DEFAULT_BASE_SCORE（已无消费方）`

---

## Task 7 — admin / 文档 / 注释

**Files**

- `admin/app.js`
- `scripts/verify-admin-static.mjs`
- `docs/design.md`
- `docs/ops/first-deploy.md`
- 注释：`tools/conformance/src/lib/ddz-driver.ts`、`tools/conformance/src/slices/slice-06-auth-rooms.ts`、
  `tools/conformance/src/slices/slice-12-manual-join.ts`、
  `apps/client/src/pages/lobby/lobby.vue`、`apps/client/src/pages/game/game.vue`、
  `apps/client/src/net/rest.ts`、`scripts/verify-authz.mjs`、`scripts/verify-e2e.mjs`

**TDD / 步骤**

1. `scripts/verify-admin-static.mjs` 增加断言：`admin/app.js` 不含
   `必须包含缺省底分 15`、`缺省底分 15 档不可删除`、`缺省建房固定用 15` → `pnpm verify:admin` **RED**。
2. 改 `admin/app.js`（逐行清单）：
   - `:203` 取值说明：删「必须包含缺省底分 15」，改「省略底分时取表内最低档」；
   - `:205` 注意行：改「档位可自由增删（含 15）；省略底分时取表内最低档；改动只影响之后的新开局」；
   - `:268` / `:289` / `:293` / `:295`：「15 × 本值」→「档位表最低档 × 本值」；
   - `:1419` 注释：删「缺省 15 不可删（服务端同样拒绝）」；
   - `:1443-1447` 删除按钮的 15 拦截；
   - `:1466` 结构提示：「底分须为正整数、唯一、≤ 8191；省略底分时取表内最低档」；
   - `:1482` 保存校验「必须包含缺省底分 15」删除。
3. `pnpm verify:admin` → GREEN。
4. 文档：
   - `design.md`：:53、:257、:298、:1233；
   - `first-deploy.md`：:1021（必须含 15 → 省略取最低档；补「机器人水位要求
     `max(档位) × entryMultiplier ≥ 15`」）、:1036（救济金额 ≥ 最低档 × 倍率）、:1065；
   - **不改** `:1037`（`currency.entryFeePercents` 行；种子四档的说明在 :1021）。
5. 注释批次（行为零改动）。
6. Commit：`docs+admin: 缺省底分改为档位表最低档（后台与文档同步）`

---

## Task 8 — 代码审查 + 全量验证

1. 独立 reviewer 审本片全部提交对照 spec/plan；Critical/Important 必修。
2. 修完补测试 → 重跑受影响包。
3. 全量：
   - `pnpm exec turbo run test lint --force`
   - `pnpm -C apps/client build`（含 vue-tsc）
   - `pnpm verify:admin`
   - `git status --short` 为空。
4. conformance：本片不部署；登记合 master 权威轮需重建镜像后跑
   slice-05 / 06 / 07.1 / 12 / 18-G / 24 / 25。
5. 交付报告（变更、证据、提交范围、未做项）。

## 回归命令速查

| 面 | 命令 |
|---|---|
| protocol | `pnpm exec turbo run test lint --filter=./packages/protocol --force` |
| shared | `pnpm exec turbo run test lint --filter=./packages/shared --force` |
| room-service | `pnpm exec turbo run test lint --filter=./packages/room-service --force` |
| game-service | `pnpm exec turbo run test lint --filter=./packages/game-service --force` |
| currency-service | `pnpm exec turbo run test lint --filter=./packages/currency-service --force` |
| config-service | `pnpm exec turbo run test lint --filter=./packages/config-service --force` |
| client | `pnpm -C apps/client test && pnpm -C apps/client lint` |
| admin | `pnpm verify:admin` |
| 全仓 | `pnpm exec turbo run test lint --force` |

（用目录过滤器而不是包名，避免 `@fight-the-landlord/...` 名称与实际 `package.json` 不一致。）

## 计划审查记录（r1，独立 reviewer）

| # | 级别 | 发现（已核对） | 处置 |
|---|------|----------------|------|
| P1 | 高 | `config-service/test/config.validation.test.ts` 的 C18 用例无人认领，Task 1 后必红 | 并入 Task 1 步骤 4–6（先让它红，再删用例） |
| P2 | 高 | 若 Task 1 删常量导出，Tasks 2–5 先撞 TS2305，TDD 的 RED 全是编译错 | 重排：Task 1 只删校验；Task 6 最后删常量；计划明确 RED 形态 |
| P3 | 高 | admin `:203` 也含「必须包含缺省底分 15」，Task 7 的 GREEN 不可达；`:205/:268/:289/:293/:295/:1419` 漏改 | Task 7 改为逐行清单，verify 断言扩到三条旧串 |
| P4 | 低 | 0 哨兵经 `buildPlayerView` 抛 `ProtocolError` 的集成用例缺失 | Task 3 增加 `view.builder.test.ts` 用例 |
| P5 | 低 | min 判别用例可能写成首项实现也绿；客户端 [80,5] 边界不带判别力 | 明确「首项非最小」与 49/50 两侧 |
| P6 | 低 | 坏表 + 显式值会落到 10001，与 §5 的 10007 冲突 | 形状自证提到成员校验之前（spec §4.2 已改）；坏表用例走省略路径 |
| P7 | 低 | 坏表夹具与「缺失 baseScore」在 `tsc` 下是类型错 | 计划点名 `as unknown as` 逃逸写法 |
| P8 | 低 | 陈旧注释/线号清单不完整（base-score :132-136、source-boundary :350-354、currency「三键」测试、view.builder docstring、ops :1037） | 已并入对应任务/注释清单 |
| P9 | 低 | 计划文档自身未提交；Task 8 要求工作区干净 | 新增 Task 0 先提交计划 |

## 代码审查记录（r1，独立 reviewer，`5df0303..HEAD`）

结论：**无 Critical / Important**；4 条 Minor，全部已修（C1–C4）。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| C1 | Minor | `docs/games/doudizhu.md:342` 仍写「`baseScore` 默认 15」，与「无代码缺省」矛盾；设计清单漏了该文件 | 已改为「无代码缺省；省略取档位表数值最小档（当前种子 15）」 |
| C2 | Minor | `RoomsService.create` 形状自证对 `null`/空表不完整：`l.baseScore` 会抛 TypeError（落到 10001），空表可通过 `.every`（`Math.min(...[]) = Infinity`） | 已补 `length > 0` + `l !== null && typeof l === 'object'`；新增 `[null]` / `[]` ⇒ 10007 用例 |
| C3 | Minor | spec §6.5 要求的「缺失 baseScore」用例缺失（需类型逃逸） | 已在 `game.service.test.ts` 补：缺失 ⇒ BAD_PARAM 且不建会话 |
| C4 | Minor | 两处过期注释：`rooms.base-score.test.ts:6-7` 的同值对说明、`lobby-ux.test.ts:990` 的「15×」 | 已同步改写 |

正向核验（reviewer 实测）：全仓源码零 `DEFAULT_BASE_SCORE`；钱路径各失败分支 fail-closed、无 0/NaN 进入乘法；
钱包与广告回调的 min=5 判别边界双侧覆盖；admin 旧拦截已删除且静态闸 234 checks 绿。
