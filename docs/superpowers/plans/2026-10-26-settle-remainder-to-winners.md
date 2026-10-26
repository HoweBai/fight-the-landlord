# 结算零头改为分给赢家（最大余数法）· 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本片按用户要求**在会话内直接执行**（节省 token），不走逐任务子代理。

**Goal:** 结算凑整零头不再销毁，按最大余数法分给赢家；抽水改按最终所得计算。

**Architecture:** 只改 room-service 的纯函数 `computeSettlement`（BigInt 精确分配）+ 其单测 + conformance 复算函数 + 注释/文档/面板文案。协议、数据库、客户端、admin 零改动。

**Tech Stack:** TypeScript ES2022（BigInt）、Vitest、conformance（tsc + 真栈切片）、Grafana JSON。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-10-26-settle-remainder-to-winners-design.md` v1.1（权威）。
- **期望值手算**：测试期望不得由被测公式再算。
- 不动 `burn` 载荷形状 / V3 校验 / outbox 结构 / 数据库 / 客户端。
- 每个任务一个 commit；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 分支 `dev`；`dev` 推送零 CI；不推 `master`、不打 tag、不部署（等用户发话）。
- 常用命令：`pnpm -C packages/room-service test`、`pnpm -C packages/room-service run lint`、
  `pnpm -C tools/conformance run lint`、`pnpm verify:monitoring`。

---

### Task 1: `computeSettlement` 最大余数法 + 判据矩阵

**Files:**
- Modify: `packages/room-service/src/currency/settle.service.ts:162-241`（算法 + 注释）
- Test: `packages/room-service/test/currency/settle-algorithm.test.ts:89-132`（改）+ 新 describe 块
- Test: `packages/room-service/test/currency/settle-failure.test.ts:263-273`（r2 断言）

**Interfaces:**
- `computeSettlement(input): SettleComputation` 签名与返回字段不变（`residue` 仍存在，正常路径恒 0）。

- [ ] **Step 1: 写失败测试（先改既有截断用例 + 新增矩阵）**

`settle-algorithm.test.ts` 把 89-113 行的截断用例替换为：

```ts
describe('computeSettlement：单输家截断 + 双赢家分摊（最大余数法）', () => {
  it('地主输、余额 25 < 应付 60 ⇒ 两赢家 13/12（零头给座位小者）；residue 0', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 9, round: 1,
      result: FARMERS_WIN(), seats: SEATS,
      balances: balances({ alice: 25, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });
    // 截断：alice 只付 25；g=floor(30×25/60)=12、frac 各 30 ⇒ R=1 给座位小者 seat1
    expect(out.deltas).toEqual([
      { seat: 0, delta: -25 }, { seat: 1, delta: 13 }, { seat: 2, delta: 12 },
    ]);
    expect(out.residue).toBe(0);
    expect(out.rakeTotal).toBe(0);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(0);
  });
```

文件末尾追加新 describe：

```ts
describe('computeSettlement：最大余数法（2026-10-26 spec C3–C11）', () => {
  const seatsOf = (n: 2 | 3 | 4): SettleSeatRef[] =>
    Array.from({ length: n }, (_, seat) => ({ seat, ownerId: `u${seat}`, ownerType: 'user' as const }));

  const pdkResult = (deltas: number[], playerCount: 2 | 3 | 4): PdkSettlementResult => ({
    roomCode: 'ROOM01', gameType: 'paodekuai', playerCount, baseScore: 1,
    winnerSeats: deltas.flatMap((delta, seat) => (delta > 0 ? [seat] : [])),
    scoreChanges: deltas.map((delta, seat) => ({ seat, delta })),
    remaining: deltas.map(() => 0), multiplier: 1, bombCount: 0,
    guan: false, spring: false, baobenSeats: [],
  });

  it('C3 两赢家截断：raw 8/8、P=15 ⇒ 8/7', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 10, round: 1,
      result: pdkResult([8, 8, -16], 3), seats: seatsOf(3),
      balances: balances({ u0: 1000, u1: 1000, u2: 15 }), rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 8 }, { seat: 1, delta: 7 }, { seat: 2, delta: -15 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C4 余数不等：raw 5/11、P=15 ⇒ +1 给余数大的 raw 5 ⇒ 5/10', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 11, round: 1,
      result: pdkResult([5, 11, -16], 3), seats: seatsOf(3),
      balances: balances({ u0: 1000, u1: 1000, u2: 15 }), rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 5 }, { seat: 1, delta: 10 }, { seat: 2, delta: -15 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C5 R=2：raw 2/2/2、输家 −6 余额 5 ⇒ 2/2/1、输家 −5', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 12, round: 1,
      result: pdkResult([2, 2, 2, -6], 4), seats: seatsOf(4),
      balances: balances({ u0: 1000, u1: 1000, u2: 1000, u3: 5 }), rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 2 }, { seat: 1, delta: 2 },
      { seat: 2, delta: 1 }, { seat: 3, delta: -5 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C6b 零头先分发后抽水：raw 10/10、P=19、rake 10% ⇒ 9/9（旧基数会得 10/9）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 13, round: 1,
      result: FARMERS_WIN({ landlordScoreChange: -20, farmerScoreChange: 10 }),
      seats: SEATS, balances: balances({ alice: 19, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 10,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -19 }, { seat: 1, delta: 9 }, { seat: 2, delta: 9 },
    ]);
    expect(out.rakeTotal).toBe(1);
    expect(out.residue).toBe(0);
  });

  it('C8 精度回归（合成算例）：大数整除不得少 1、残差不得虚增', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 14, round: 1,
      result: FARMERS_WIN({ landlordScoreChange: -433_049_076, farmerScoreChange: 216_524_538 }),
      seats: SEATS,
      balances: balances({ alice: 1_000_000_000, 'bot-aaaa1111': 1_000_000_000, carol: 1_000_000_000 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -433_049_076 },
      { seat: 1, delta: 216_524_538 },
      { seat: 2, delta: 216_524_538 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C11 防御：无赢家（三方全负）⇒ residue=P、不抛错', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01', version: 15, round: 1,
      result: LANDLORD_WINS({ landlordScoreChange: -10, farmerScoreChange: -5 }),
      seats: SEATS,
      balances: balances({ alice: 100, 'bot-aaaa1111': 100, carol: 100 }), rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -10 }, { seat: 1, delta: -5 }, { seat: 2, delta: -5 },
    ]);
    expect(out.residue).toBe(20);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(-(out.residue + out.rakeTotal));
  });
});
```

`settle-failure.test.ts:263-273` 改三处：

```ts
    // 重算：P=25、g=floor(30×25/60)=12，余数 1 给座位小者 ⇒ 13/12；residue 0
    expect(second.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: -25 },
      { ownerId: 'bot-int-1', ownerType: 'robot', delta: 13 },
      { ownerId: 'carol', ownerType: 'user', delta: 12 },
    ]);
    expect(first.burn).toEqual({ residue: 0, rake: 0 });
    expect(second.burn).toEqual({ residue: 0, rake: 0 });
    ...
    // 两轮 residue 均 0 ⇒ 指标不变
    await expect(metricValue(currencySettleResidueTotal)).resolves.toBe(residueBefore);
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/room-service exec vitest run test/currency/settle-algorithm.test.ts test/currency/settle-failure.test.ts`
Expected: FAIL —— C1 得 12/12（期望 13/12）、C3–C8 与 r2 断言同红。

- [ ] **Step 3: 实现（替换 `settle.service.ts` 215-228 行）**

```ts
  const winnerRawSum = winners.reduce((acc, s) => acc + rawOf(s), 0);
  let gainedSum = 0;
  let rakeTotal = 0;
  if (winners.length > 0 && winnerRawSum > 0) {
    // 最大余数法（spec 2026-10-26 D1/D4）：零头分给赢家，精确整数运算。
    if (!Number.isSafeInteger(pool) || pool < 0 || !Number.isSafeInteger(winnerRawSum)) {
      throw new Error(`settlement allocation input invalid: pool=${pool}, winnerRawSum=${winnerRawSum}`);
    }
    const bigS = BigInt(winnerRawSum);
    const bigPool = BigInt(pool);
    const rows = winners.map((s) => {
      const raw = rawOf(s);
      if (!Number.isSafeInteger(raw) || raw <= 0) {
        throw new Error(`settlement allocation input invalid: raw(${s.seat})=${raw}`);
      }
      const num = BigInt(raw) * bigPool;
      return { seat: s.seat, gain: num / bigS, frac: num % bigS };
    });
    const grantedBase = rows.reduce((acc, r) => acc + Number(r.gain), 0);
    const remainder = pool - grantedBase; // 精确算术下 ∈ [0, 赢家数)
    if (remainder < 0 || remainder >= winners.length) {
      throw new Error(`settlement remainder out of range: R=${remainder} (winners=${winners.length}, P=${pool})`);
    }
    const byFraction = [...rows].sort((a, b) =>
      a.frac === b.frac ? a.seat - b.seat : a.frac > b.frac ? -1 : 1,
    );
    for (let i = 0; i < remainder; i += 1) byFraction[i]!.gain += 1n;
    for (const r of rows) {
      const finalGain = Number(r.gain); // 前置断言保证安全整数
      const rake = Math.floor((finalGain * rakePercent) / 100); // D2：基数 = 最终所得
      deltaBySeat.set(r.seat, finalGain - rake);
      gainedSum += finalGain;
      rakeTotal += rake;
    }
  }
```

同步更新 168-181 行伪码注释与 `residue` 字段注释（`P − Σg[i]` → `正常路径恒 0；防御路径 = P`）。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/room-service exec vitest run test/currency/settle-algorithm.test.ts test/currency/settle-failure.test.ts`
Expected: PASS（全文件）。

- [ ] **Step 5: 跑整个 room-service**

Run: `pnpm -C packages/room-service test && pnpm -C packages/room-service run lint`
Expected: 全绿、tsc 0。

- [ ] **Step 6: Commit**

```bash
git add packages/room-service/src/currency/settle.service.ts \
  packages/room-service/test/currency/settle-algorithm.test.ts \
  packages/room-service/test/currency/settle-failure.test.ts
git commit -m "feat(settle): 零头改最大余数法分给赢家；抽水按最终所得（spec 2026-10-26）"
```

---

### Task 2: conformance 复算同步（slice-18）

**Files:**
- Modify: `tools/conformance/src/slices/slice-18-gold-room.ts:619-664`（`SettleRecount` 注释 + `recountSettlement`）、`:786-798`（断言文本）、`:1289-1292`/`:1347-1348`（文案）

**Interfaces:**
- `recountSettlement(s, preBalances, rakePercent): SettleRecount` 签名不变；`residue` 新口径恒 0。

- [ ] **Step 1: 替换 `recountSettlement` 的赢家段（现 653-663 行）**

```ts
  const winnerIdx = seats.map((_, i) => i).filter((i) => raw[i]! > 0);
  const rawWinSum = winnerIdx.reduce((acc, i) => acc + raw[i]!, 0);
  let gainedSum = 0;
  let rakeTotal = 0;
  if (winnerIdx.length > 0 && rawWinSum > 0) {
    // 最大余数法（2026-10-26 spec D1/D2/D4）：零头分给赢家；抽水基数 = 最终所得。
    const bigS = BigInt(rawWinSum);
    const bigPool = BigInt(pool);
    const rows = winnerIdx.map((i) => {
      const num = BigInt(raw[i]!) * bigPool;
      return { i, gain: num / bigS, frac: num % bigS };
    });
    const remainder = pool - rows.reduce((acc, r) => acc + Number(r.gain), 0);
    const byFraction = [...rows].sort((a, b) =>
      a.frac === b.frac ? a.i - b.i : a.frac > b.frac ? -1 : 1,
    );
    for (let k = 0; k < remainder; k += 1) byFraction[k]!.gain += 1n;
    for (const r of rows) {
      const gain = Number(r.gain);
      const rake = Math.floor((gain * rakePercent) / 100);
      expected[r.i] = gain - rake;
      gainedSum += gain;
      rakeTotal += rake;
    }
  }
  return { expected, pool, residue: pool - gainedSum, winners: winnerIdx.length, rakeTotal };
```

- [ ] **Step 2: 断言与注释文案**

- `SettleRecount.residue` 注释（现 620-621 行）：`P − Σg` → `P − Σ最终 g（新口径恒 0；非 0 即实现回归）`。
- 786-798 行：`recount.residue >= 0 && recount.residue < recount.winners` 改为
  `recount.residue === 0`，消息改为
  `` `${what}：新口径残留应恒 0（residue=${recount.residue}）—— 口径：P=${recount.pool} − Σ最终 g（最大余数法，零头已分给赢家）` ``。
- 1292 行文案：`E settle op burn 两列 = 复算（residue:rake；新代码恒带）`（不变，核对仍成立）。
- 1348 行文案不变（恒等式仍成立，residue 恒 0）。

- [ ] **Step 3: 类型检查**

Run: `pnpm -C tools/conformance run lint`
Expected: 0 错误。

- [ ] **Step 4: Commit**

```bash
git add tools/conformance/src/slices/slice-18-gold-room.ts
git commit -m "test(conformance): slice-18 复算同步最大余数法与抽水基数"
```

---

### Task 3: 注释、历史文档指针、监控面板（D7/D9）

**Files:**
- Modify: `packages/protocol/src/currency.ts:68-77`
- Modify: `packages/room-service/src/metrics/room.metrics.ts:144-151`
- Modify: `docs/superpowers/specs/2026-10-04-gold-room-spec.md`（§4 标题下、§12.1 E）
- Modify: `docs/superpowers/specs/2026-10-04-gold-room-design.md:98-103`
- Modify: `docs/superpowers/specs/2026-10-14-burn-on-op-spec.md:74-77`
- Modify: `deploy/monitoring/grafana/dashboards/05-currency.json`（图例 + 标题）
- Modify: `scripts/verify-monitoring.mjs:149`

- [ ] **Step 1: 代码注释**

`currency.ts` 的 `CurrencyBurn` 注释改为：
```
 * 结算销毁（仅 `game_settle`）：截断残差 / 抽水，**二者恒同在**。
 * 写者 = room-service 结算（`computeSettlement` 的 residue/rakeTotal 原样）；
 * **2026-10-26 起**：零头改分给赢家 ⇒ `residue` 正常路径恒 0（防御路径可能非 0）；
 * 字段保留，历史载荷/旧 outbox 条目照旧合法。两值上限 2^31−1 = int 列容量哨兵。
```
`room.metrics.ts` 注释改为：
```
/**
 * 残差（回归哨兵）：新口径正常路径恒 0；非 0 = 分配算法回归（历史值仍属销毁）。
 * **零和局也 inc 0**（保证任何一局金币局之后该序列必然出现）。
 */
```

- [ ] **Step 2: 历史文档指针（各一行）**

统一插入文本（措辞可随上下文）：
`> **2026-10-26 起**：零头改按最大余数法分给赢家（residue 恒 0），见 docs/superpowers/specs/2026-10-26-settle-remainder-to-winners-design.md。`

插入位置：gold-room spec `## §4 结算算法` 标题下；gold-room spec §12.1 E 的「炸弹局…产生残差」句尾；
gold-room design D3「残差 … 销毁」条目下；burn-on-op spec 的 `CurrencyBurn` 注释块下。

- [ ] **Step 3: Grafana 面板**

`05-currency.json`：`"legendFormat": "{{game_type}} 残差销毁"` → `"{{game_type}} 残差"`；
`"title": "残差销毁增速"` → `"title": "残差（应恒 0，非 0 即回归）"`。
`scripts/verify-monitoring.mjs:149`：期望标题同步改为 `残差（应恒 0，非 0 即回归）`。

- [ ] **Step 4: 验证**

Run: `pnpm verify:monitoring && pnpm -C packages/protocol test`
Expected: 监控校验通过（面板/指标针脚全命中）、protocol 测试全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/currency.ts packages/room-service/src/metrics/room.metrics.ts \
  docs/superpowers/specs/2026-10-04-gold-room-spec.md docs/superpowers/specs/2026-10-04-gold-room-design.md \
  docs/superpowers/specs/2026-10-14-burn-on-op-spec.md \
  deploy/monitoring/grafana/dashboards/05-currency.json scripts/verify-monitoring.mjs
git commit -m "docs/obs: 残差口径改为回归哨兵；历史文档指针与面板文案同步"
```

---

### Task 4: 全量验证 + 代码审查（dev-process §7/§8）

- [ ] **Step 1: 受影响包全量**

Run: `pnpm -C packages/room-service test && pnpm -C packages/room-service run lint`
Run: `pnpm -C packages/protocol test && pnpm -C tools/conformance run lint`
Expected: 全绿。

- [ ] **Step 2: 全仓权威本机轮**

Run: `pnpm exec turbo run test lint --force`（后台跑；`Cached` 不算真跑）
Expected: 全绿；若红，按 `ci-flake-known` 单跑确认是否已知假红。

- [ ] **Step 3: 独立代码审查**

派独立 reviewer（sonnet）审 `2fdaceac..HEAD` diff，对照 spec v1.1 逐条核对：
Critical/Important 必须修；Minor 登记或顺手修。审查结论回填 spec §9「代码审查记录」。

- [ ] **Step 4: 修复后复跑**

受影响测试 + lint 复跑绿；工作区干净。

- [ ] **Step 5: 推送 dev**

`git push origin dev`（零 CI）。不推 master、不打 tag、不部署。

- [ ] **Step 6: 交付报告**

变更、验证证据（测试数/结果）、提交 SHA、已推 dev、已知边界（真栈 slice-18 E/F 不保证覆盖 R>0；部署待用户发话）。
