# 台费百分比上限 0–100 — 实现计划

> **For agentic workers:** 按任务逐条执行；每个任务先测试后实现（TDD），绿后提交。步骤用 `- [ ]` 勾选。

**Goal:** 把 `game.baseScoreLevels[].entryFeePercent` 的合法上限从 50 放宽到 100，同步 admin 输入/文案/静态闸/测试/文档；旧键与抽水不动，客户端零改动。

**Architecture:** 只改写入口校验域（protocol parser）+ 后台第三列控件与提示；`entryFeeOf` 公式不变，仅更新算术注释。旧键 `currency.entryFeePercents` 继续 0–50 只读弃用，任务 B 删除。

**Tech Stack:** TypeScript（protocol / config-service / room-service）、Vitest、原生 JS（admin）、Node 静态闸。

**状态（2026-10-21）：** 全部完成。Task 5 Step 1–2 完成（代码审查无 Critical/Important，
4 Minor + 1 可选已修）；Step 3–5 已执行：`dev` 推送 + tag **`dev-a84464d`** 部署测试服
（A+B 同批），A 验收通过 —— 1 分档台费设 **100%** ⇒ PUT 200（version 6），玩家面
`entryFeePercent:100`，客户端共享公式 `entryFeeOfLevel({baseScore:1,percent:100})=1`。

**验证证据（2026-10-21）：** protocol 216、config-service 449、room-service 745、
currency-service 384、client 1169 passed / 2 skipped；`turbo run test lint --force` 44/44 tasks
（0 cached）；`pnpm -C apps/client build` DONE；`pnpm verify:admin` 251 checks passed。
部署后最终态：admin 51 键、`/api/config` 19 键、旧键 PUT 400、DB 旧行 0、`platform_config` 51 行；
线上 admin 已无旧费率编辑器（`buildEntryFeeEditor`/`HIDDEN_CONFIG_KEYS` 均 0 命中）。

## Global Constraints

1. `entryFeePercent` 合法域 = 整数 `0 ≤ n ≤ 100`；`101` 必须拒绝。
2. 旧键 `currency.entryFeePercents` 的 `percent` **保持 0–50**（只读弃用，任务 B 删除）。
3. `currency.rakePercent` 保持 0–50，不动。
4. `entryFeeOf` 公式/保底语义不改；只改算术注释（单笔上限 4095 → 8191）。
5. 客户端零改动；`CLIENT_CONFIG_KEYS` / 键数 / conformance 断言不变。
6. 测试走 turbo（`test` 依赖 build，避免旧 dist 假绿）：
   `pnpm exec turbo run test lint --filter=./packages/<pkg> --force`。
7. **每个任务提交后不得留红树**：受协议域变化影响的既有夹具（room-service 的 51 越界）必须与
   parser 改动同一个提交完成。
8. 每个任务：先改/加测试 → 跑红（写明 RED 形态）→ 最小实现 → 跑绿 → commit。
9. 提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
10. 最终：`pnpm exec turbo run test lint --force`、`pnpm -C apps/client build`、`pnpm verify:admin`。

---

## Task 0 — spec + 计划落盘

- [ ] 提交 spec（含 r1 审查记录）与本计划（含计划审查记录）。

Commit：`docs(spec+plan): 台费百分比上限放开到 0–100`

---

## Task 1 — protocol + room-service：parser 上限、注释、契约夹具

**Files**

- Modify: `packages/protocol/src/config.ts:150`（字段注释）、`:619`（parser 注释）、`:648`（上限比较）、`:651`（错误文案）、`:668-669`（entryFeeOf 算术注释）
- Modify: `packages/protocol/src/currency.ts:293`（`feeAmount` 注释「公式上界 4095」→ 8191；域哨兵 1e6 不变）
- Test: `packages/protocol/src/config.test.ts:118-138`、`:235-246`
- Test: `packages/room-service/test/config-cache.test.ts:629`（51→101）、`:592` 后新增 100 正例

**Interfaces**

- Produces: `parseConfigValue('game.baseScoreLevels', …)` 接受 `entryFeePercent ∈ [0,100]`；
  `entryFeeOf(baseScore, percents)` 对 `percent=100` 返回 `baseScore`（函数体不变）。

- [ ] **Step 1: 改测试（RED）**

`packages/protocol/src/config.test.ts`——首个用例改标题与边界，非法值列表 `51`→`101`，
并把错误断言收紧到新文案（Task 2 之前会因 100 被拒先红）：

```ts
  it('🔴 baseScoreLevels.entryFeePercent：可选、0..100 整数、round-trip 保留字段', () => {
    const withFee = [{ name: '休闲场', baseScore: 15, entryFeePercent: 10 }];
    expect(parseConfigValue('game.baseScoreLevels', withFee)).toStrictEqual(withFee);
    const withoutFee = [{ name: '休闲场', baseScore: 15 }];
    const parsed = parseConfigValue('game.baseScoreLevels', withoutFee) as Array<
      Record<string, unknown>
    >;
    expect(parsed).toStrictEqual(withoutFee);
    expect('entryFeePercent' in parsed[0]!).toBe(false);
    for (const value of [0, 100]) {
      const input = [{ name: 'X', baseScore: 15, entryFeePercent: value }];
      expect(parseConfigValue('game.baseScoreLevels', input)).toStrictEqual(input);
    }
    for (const value of [-1, 101, 1.5, '10', null]) {
      expect(
        () => parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 15, entryFeePercent: value }]),
        `entryFeePercent=${JSON.stringify(value)} 必须拒绝`,
      ).toThrow(/0 ≤ n ≤ 100 的整数/);
    }
  });
```

`entryFeeOf` 用例标题追加，并在 `(8191,50)` 之后加两行：

```ts
  it('C3 金标向量：entryFeeOf（未命中⇒0；(15,10)⇒1；(80,5)⇒4；(480,12)⇒57；percent=0⇒0 无保底；(8191,50)⇒4095；(15,100)⇒15；(8191,100)⇒8191；floor 截断）', () => {
    // ...
    expect(entryFeeOf(8191, t(8191, 50))).toBe(4095); // floor(4095.5) = 4095（旧上界）
    expect(entryFeeOf(15, t(15, 100))).toBe(15); // floor(15) = 15（100% = 门票等于底分）
    expect(entryFeeOf(8191, t(8191, 100))).toBe(8191); // floor(8191) = 8191（新算术上界）
```

`packages/room-service/test/config-cache.test.ts`：

1. 越界夹具（改后新旧 parser 都判非法，两态皆绿）：

```ts
      [{ name: 'X', baseScore: 15, entryFeePercent: 101 }], // 越界（0–100 之外）
```

2. 在「快照值生效」用例后新增 100 读侧正例（Task 1 实现前为 RED）：

```ts
  it('🔴 上限 100 在读侧合法：entryFeePercent = 100 ⇒ percent 100', async () => {
    const { client, snapshot } = makeClient();
    snapshot.mockResolvedValue(
      snapshotWith({
        'game.baseScoreLevels': [{ name: '休闲场', baseScore: 15, entryFeePercent: 100 }],
      }),
    );
    const cache = new ConfigCacheService(client);
    cache.onModuleInit();
    await cache.waitForFirstSnapshot();
    expect(cache.entryFeePercents()).toEqual([{ baseScore: 15, percent: 100 }]);
    cache.onApplicationShutdown();
  });
```

- [ ] **Step 2: 跑红**

Run: `pnpm exec turbo run test lint --filter=./packages/protocol --force`
Expected: FAIL——`entryFeePercent: 100` 被 `> 50` 拒绝（`0 ≤ n ≤ 50` 文案不匹配新断言）。

Run: `pnpm exec turbo run test lint --filter=./packages/room-service --force`
Expected: FAIL——新增的 100 正例返回 `[]`（parser 拒绝整表，reader 走 fail-open）。

- [ ] **Step 3: 最小实现**

`packages/protocol/src/config.ts`：

```ts
  /** 台费百分比（整数 0–100；缺省 = 0 = 不收）。2026-10-21 起为台费唯一来源。 */
  entryFeePercent?: number;
```

```ts
 * 同日：每项可选 `entryFeePercent`（0–100 整数，缺省 0）= 台费唯一来源。**校验后必须写回**
```

```ts
        entryFeePercent > 100
```

```ts
          `底分档位「${name}」的 entryFeePercent 必须是 0 ≤ n ≤ 100 的整数`,
```

`entryFeeOf` 注释：

```ts
 * 算术界：`baseScore ≤ 8191`、`percent ≤ 100` ⇒ 单笔 ≤ 8191（双精度内精确；远低于
```

`packages/protocol/src/currency.ts:293`：

```ts
  /** 单笔台费（正整数 ≤ 1,000,000；公式上界 8191，此界为域哨兵）。 */
```

`parseEntryFeePercents`（旧键）与 `parseRakePercent` 不动。

- [ ] **Step 4: 跑绿**

Run: `pnpm exec turbo run test lint --filter=./packages/protocol --force`
Expected: 216 tests passed（改断言不增用例），lint 通过。

Run: `pnpm exec turbo run test lint --filter=./packages/room-service --force`
Expected: 745 tests passed（744 + 1），lint 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts packages/protocol/src/currency.ts packages/room-service/test/config-cache.test.ts
git commit -m "feat(protocol): 台费百分比上限放开到 0–100"
```

---

## Task 2 — config-service：D13 文案断言 + 派生输出 100 用例

**Files**

- Modify: `packages/config-service/src/config/platform-config.service.ts:128`
- Test: `packages/config-service/test/config.validation.test.ts:81-85`（D13 reason 收紧）
- Test: `packages/config-service/test/client-config.test.ts`（新增派生 100 用例）

**Interfaces**

- Consumes: Task 1 的 `parseConfigValue`（100 合法）。
- Produces: D13 错误文案含 `0–100`；`/api/config` 派生输出含 `percent:100`。

- [ ] **Step 1: 加测试（RED）**

`config.validation.test.ts` 的 D13 条目——把 reason 收紧（当前文案是 0–50 ⇒ 真红）：

```ts
    {
      name: 'D13：档位表旧形态（全部缺 entryFeePercent）⇒ 400 + 请硬刷新',
      key: 'game.baseScoreLevels',
      value: [{ name: '学习场', baseScore: 15 }],
      reason: /请硬刷新[\s\S]*0–100/,
    },
```

`client-config.test.ts` 在「🔴 entryFeePercents 由档位表派生」用例后新增（Task 1 后已绿，
作为端到端回归锚点；不在本任务 RED 中承担判别）：

```ts
  it('🔴 entryFeePercent = 100 ⇒ 派生 percent 100（上限放开到 100%）', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.set('game.baseScoreLevels', {
      value: [
        { name: '休闲场', baseScore: 15, entryFeePercent: 100 },
        { name: '标准场', baseScore: 80, entryFeePercent: 0 },
      ],
      version: 2,
      updatedAt: 'admin',
      updatedBy: 'admin',
    });
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.entryFeePercents).toEqual([
        { baseScore: 15, percent: 100 },
        { baseScore: 80, percent: 0 },
      ]);
    } finally {
      await probe.close();
    }
  });
```

- [ ] **Step 2: 跑红**

Run: `pnpm exec turbo run test lint --filter=./packages/config-service --force`
Expected: FAIL 仅 D13 一条——现文案「API 写入请显式给 0–50」不匹配 `/请硬刷新[\s\S]*0–100/`；
派生 100 用例应为绿（证明 Task 1 的端到端接线）。

- [ ] **Step 3: 最小实现（用户可见文案）**

`platform-config.service.ts:128`：

```ts
        '档位表写入缺少 entryFeePercent（管理页面已更新，请硬刷新后重试；API 写入请显式给 0–100）',
```

- [ ] **Step 4: 跑绿**

Run: `pnpm exec turbo run test lint --filter=./packages/config-service --force`
Expected: 26 files / 449 tests passed（448 + 1），lint 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/config-service/src/config/platform-config.service.ts packages/config-service/test/client-config.test.ts packages/config-service/test/config.validation.test.ts
git commit -m "fix(config): 台费上限文案与派生用例覆盖 100%"
```

---

## Task 3 — admin：第三列 0–100 + 静态闸

**Files**

- Modify: `admin/app.js:203`（CONFIG_NOTES）、`:1455`（`pctEl.max`）、`:1497`（提示）、`:1511-1512`（校验/错误文案）
- Test: `scripts/verify-admin-static.mjs`（第 8 节，`levelsFn` 断言后）

**Interfaces**

- Produces: 后台第三列允许 0–100；服务端同域；静态闸钉住控件、getter、文案三面。

- [ ] **Step 1: 加静态断言（RED）**

在 `verify-admin-static.mjs` 第 8 节「档位表编辑器有表头」断言之后加：

```js
ok(levelsFn.includes("pctEl.max = '100'"), '档位表第三列上限 = 100（0–100%）');
ok(levelsFn.includes('percent > 100)'), '档位表 getter 上限 = 100');
ok(levelsFn.includes('percent < 0'), '档位表 getter 下界 = 0');
ok(!levelsFn.includes('percent > 50'), '档位表 getter 不再使用 50 上限');
ok(levelsFn.includes('0–100'), '档位表台费文案为 0–100');
ok(!levelsFn.includes('0–50'), '档位表不再出现 0–50');
ok(!app.includes('0–50'), 'app.js 不再出现 0–50（旧键/抽水用语是 0 ≤ n ≤ 50）');
const notesStart = app.indexOf("'game.baseScoreLevels': [");
const notesEnd = app.indexOf("'game.cardCounterEnabled': [");
ok(
  notesStart !== -1 && notesEnd > notesStart,
  'CONFIG_NOTES 档位表切片锚点存在（起/止）',
);
const notesSrc = app.slice(notesStart, notesEnd);
ok(notesSrc.includes('0–100'), 'CONFIG_NOTES 档位表条目为 0–100');
```

- [ ] **Step 2: 跑红**

Run: `pnpm verify:admin`
Expected: FAIL 7 条（`pctEl.max='50'`、getter `> 50`、文案 0–50、CONFIG_NOTES 0–50）。

- [ ] **Step 3: 实现**

`admin/app.js`：

```js
    pctEl.max = '100';
```

```js
    el('p', 'struct-note', '底分须为正整数、唯一、≤ 8191；台费为 0–100 的整数百分比（0 = 不收，100 = 门票等于底分）；省略底分时取表内最低档。'),
```

```js
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
          throw new Error('台费须为 0–100 的整数百分比（0 = 不收，100 = 门票等于底分）');
        }
```

`CONFIG_NOTES['game.baseScoreLevels']` 的「取值」：

```js
    ['取值', '非空数组，每项 {name, baseScore, entryFeePercent}：name 非空字符串、baseScore 正整数且 ≤ 8191（上限 = 金币金额列 int 的容量上界，超出会被拒绝）、档位值不得重复；entryFeePercent 为 0–100 的整数百分比（0 = 不收台费，100 = 门票等于底分，缺省即 0）；省略底分时取表内最低档。默认 15 / 80 / 480 / 1200（台费全 0）。'],
```

- [ ] **Step 4: 跑绿**

Run: `pnpm verify:admin`
Expected: `admin static verify: 251 checks passed`（基线 242 + 9；含审查加固的 `percent < 0` 与切片锚点）。

- [ ] **Step 5: Commit**

```bash
git add admin/app.js scripts/verify-admin-static.mjs
git commit -m "feat(admin): 台费第三列上限放到 100%"
```

---

## Task 4 — 文档

**Files**

- Modify: `docs/design.md:1233`、`:1266`
- Modify: `docs/ops/first-deploy.md:1021`、回滚段（「台费并入档位表」小节）

- [ ] **Step 1: 改文档**

`docs/design.md:1233`（新字段）：

```text
`entryFeePercent` 可选整数 0–100（缺省 0，100 = 门票等于底分）= **台费唯一来源**
```

`docs/design.md:1266`（旧键行末补半句）：

```text
`/api/config` 的 `entryFeePercents` 改为**由档位表派生**（客户端契约不变；派生输出 `percent` 可为 0–100，不受本键 0–50 约束）
```

`docs/ops/first-deploy.md:1021`：

```text
**第三列 `entryFeePercent` = 台费 0–100%（100 = 门票等于底分）**
```

`docs/ops/first-deploy.md` 的「台费并入档位表——迁移与回滚手顺」在「回滚注意」后补：

```text
- **台费上限 0–100 的回滚硬步骤**：若档位表里有 >50 的 `entryFeePercent`，旧镜像（≤50 parser）
  会解析失败 ⇒ `/api/config` 档位表下发空表（大厅无档位可打）、room-service 台费静默 0、
  救助不可用。回滚前必须在新栈把各档调回 ≤50（或 0）并 `GET /api/config` 自证；旧键值域也是
  0–50，不能承载 >50 的费率。conformance 镜像未重建前不得跑 slice-25（旧 protocol 会把 100 判 400）。
```

- [ ] **Step 2: 核对无残留**

Run: `grep -rn "0–50" docs/design.md docs/ops/first-deploy.md admin/app.js packages/protocol/src/config.ts packages/config-service/src/config/platform-config.service.ts`
Expected: 仅 2 处**有意保留**——`design.md:1266` 旧键行的「不受本键 0–50 约束」说明、
`first-deploy.md` 回滚段的「旧键值域也是 0–50」；新字段/后台/parser 文案无残留。

- [ ] **Step 3: Commit**

```bash
git add docs/design.md docs/ops/first-deploy.md
git commit -m "docs: 台费上限 0–100 同步设计表、运维手册与回滚步骤"
```

---

## Task 5 — 代码审查 + 全量验证 + 推送/部署

- [ ] **Step 1: 独立 reviewer 审 `BASE..HEAD`**（对照 spec/plan）；Critical/Important 必修，
  结论写入 spec §9 与本计划「计划审查记录」之后。
- [ ] **Step 2: 全量**

```bash
pnpm exec turbo run test lint --force
pnpm -C apps/client build
pnpm verify:admin
git status --short
```

Expected: 全绿；`git status --short` 为空。

- [ ] **Step 3: 推送 dev**

```bash
git push origin dev
```

（会带上未推的 `a182c4b`；`dev` 零 CI。）

- [ ] **Step 4: 部署测试服（按用户指示）**

```bash
bash scripts/deploy/deploy-dev.sh
```

注意：protocol 改动 ⇒ 全部 14 个 target 需重建；脚本内部按既有方式串行 buildx bake
（并行会因容器内 npm TLS 断连失败）。edge digest 变化时首次可能报「同 tag 重跑出现 Recreated」，
重跑一次即通过。

- [ ] **Step 5: 部署后验收**

- 硬刷新 admin；把 1 分档台费设 100% 保存 ⇒ 200；
- 客户端大厅该档「门票 1」显示正确（`entryFeeOf(1,100)=1`）；
- `GET /api/admin/config` 键数仍 52、`GET /api/config` 仍 20 键（本任务不删键）。

## 回归命令速查

| 面 | 命令 |
|---|---|
| protocol | `pnpm exec turbo run test lint --filter=./packages/protocol --force` |
| config-service | `pnpm exec turbo run test lint --filter=./packages/config-service --force` |
| room-service | `pnpm exec turbo run test lint --filter=./packages/room-service --force` |
| admin | `pnpm verify:admin` |
| 全仓 | `pnpm exec turbo run test lint --force` |

## 计划审查记录（r1，独立 reviewer）

结论：可开工；1 高 + 4 中 + 2 低，全部已写入计划。

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| H1 | 高 | Task 2 的派生 100 用例在 Task 1 后已绿（RED 不可复现），且唯一实现改动（D13 文案）无断言 | Task 2 先把 D13 reason 收紧为 `/请硬刷新[\s\S]*0–100/`（真 RED），派生 100 用例明确标注为回归锚点 |
| M1 | 中 | Task 1 提交后 room-service 51 夹具仍红，留红树 | 51→101 与 100 正例并入 Task 1 提交；删除原 Task 3 |
| M2 | 中 | 静态闸漏 getter `percent > 50` ⇒ 只改 max/文案仍全绿 | 增加 `percent > 100` 正断言与 `percent > 50` 负断言 |
| M3 | 中 | CONFIG_NOTES 无闸 | 增加 CONFIG_NOTES 切片断言 + 全局 `!app.includes('0–50')` |
| M4 | 中 | 回滚面未写；>50 配置回滚后旧栈大厅档位消失、台费静默 0 | Task 4 运维回滚段 + spec R6；Task 5 明确推送/部署步骤 |
| L1 | 低 | Task 5 残留 grep 的期望不成立/路径漏 | 改为对 5 个文件 grep `0–50`，期望仅 2 处有意保留（旧键说明 + 回滚段） |
| L2 | 低 | protocol 新错误文案未钉 | 非法值循环断言收紧为 `/0 ≤ n ≤ 100 的整数/` |

正向核验（reviewer 实测）：行号引用与现文件一致；无缺失 import / `noUnusedLocals`；
`balancedBlock` 用法与 `0–100`（U+2013）一致；基线 protocol 216 / config-service 448 /
room-service 744 / verify:admin 242；客户端零改动成立；除已列项外无遗漏的 0–50 文案。
