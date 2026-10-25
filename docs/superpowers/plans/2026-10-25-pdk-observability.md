# 跑得快 A1 异常监控实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PDK 与斗地主在指标、看板、告警上可分别观测，并让 PDK 开局/结算/记录/机器人失败可被主动告警。

**Architecture:** 统一给现有 Prometheus 指标族加 `game_type` 标签（不新增平行指标族），所有写点经 shared 的 `incGame/setGame` 助手强制带标签；新增 4 个失败计数器 + 1 个跳过诊断计数器；新增 4 条按玩法告警；更新 4 块现有看板；conformance 修正规则数并新增 slice-30 做 PDK 指标真栈验证。

**Tech Stack:** TypeScript / NestJS / prom-client / Vitest / Prometheus / Grafana / conformance（docker exec + curl）。

**Spec:** `docs/superpowers/specs/2026-10-25-pdk-observability-design.md`（已过三轮对抗审查，commit `a7f84533`）。

## Global Constraints

- 指标 `game_type` 值域只能是 `doudizhu` 或 `paodekuai`；缺字段/空串/未知一律经 `normalizeGameType` 归一为 `doudizhu`。
- 所有带 `game_type` 的写点必须经 `incGame` / `setGame`；禁止直接 `.inc({...})` / `.set({...})` 带标签。**唯一豁免**：`match_queue_length`（它自带 `mode/game_type/player_count/base_score` 多标签，继续直接 `.set`，不在本片改造范围）。
- 跨包测试前先构建依赖包：`pnpm --filter @fight-the-landlord/protocol build && pnpm --filter @fight-the-landlord/shared build`（裸 `npx vitest` 不触发 turbo 的 build 依赖；worktree 里 dist 是 gitignored 的）。
- 失败计数器的 `reason/phase/kind` 只用枚举值；禁止把错误文本、roomCode、botId 放进标签。
- 新增计数一律在 catch 内计数后 **rethrow**（不吞错、不改状态机）。
- 采样类 gauge 先读后写；整条快照读取失败保留旧值；单键/单条目坏按 ddz + 汇总 WARN。
- 提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 不改数据库、不改协议出站形状、不改对局规则/结算算法。
- 不改 `tools/conformance/src/slices/slice-29-paodekuai.ts`；不改用户工作区的 `apps/client/src/components/PdkSettlement.vue`。
- 每个任务一个 commit；先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。
- 实施前用 `superpowers:using-git-worktrees` 建独立 worktree/分支 `feature/pdk-observability-a1`。

---

## Fixture 手册（避免“复用既有夹具”变成不可执行）

| 任务 | 现有夹具/入口 | 如何造目标场景 |
|---|---|---|
| Task 3 bot_fill | `packages/room-service/test/pdk-start-retry.test.ts` 的 `pdkRoom()` / `calls` / `configCache` | 在 RPC stub 中让 `robotAcquire` 返回业务错误（filter `RPC_PATTERNS.robotAcquire`），使 `fillBots` 返回 null |
| Task 3 pending_write | 同上 `redis` 假桩 | 让 `redis.hset` 在 key 以 `match:pending:` 开头时抛错一次 |
| Task 3 on_seats | `startRoomOutcome(..., { onSeats: async () => { throw new Error('x') } })` | ddz 房满员时传入 reject 的 `onSeats` |
| Task 3 start_rpc | `rooms.start.test.ts` 既有 `game.start` 失败夹具 | 让注入的 game client `start` reject；断言 `reason='start_rpc'` 只 +1 |
| Task 3 台费 | `packages/room-service/test/rooms.entry-fee.test.ts` 的 `service` 与收费夹具 | 断言 `entry_fee_skipped_total{game_type=...}` / `entry_fee_conflict_total{game_type=...}` |
| Task 4 局终 | `packages/room-service/test/ws.gateway.test.ts` 的 `ctx.gateway` | 直接构造 `GameEvent`（带/不带 `gameType`、`record`）调用 `onGameEvent` |
| Task 4 记录失败 | 同文件 `:1821-2110` 的记录拒绝/房缺失夹具 | `record.write` mock reject ⇒ `kind='record'`；`roomsService.findOne` 返回 null ⇒ `reason='room_ttl'`；room.gameType 与 record.gameType 不符 ⇒ `kind='record_lost'` |
| Task 5 PDK 结算 | `settle-pdk.test.ts` 的 `pdkResult()` / `pdkRoom()` | 复用该文件 `SettleService` 构造；`record.moneyDelta.mockRejectedValueOnce` 造 money_delta |
| Task 5 outbox | `settle-outbox.test.ts` 的 `settleEntry()` / `moneyEntry()` / `makeSweeper()` / `SettleHarness` | 超龄：`createdAt = now - TTL - 1`；部分匹配：moneyDelta 返回 `matched: [0]` |
| Task 6 坏条目 | 同上 `seedMoney(h, { ...moneyEntry(), createdAt: ... })` | 直接把条目值写成 `'{bad json'`，断言 ddz 组 +1 且 WARN |
| Task 7 资金 | `robot-funding.test.ts` 的 `makeHarness()` | 复用 refill/recall/ensure 失败用例；`gameType` 传 `'paodekuai'` |
| Task 8 匹配 | `match-player-count.test.ts` 的 PDK 队列夹具 | 构造 `queue.gameType='paodekuai'`，让 `randomGreedyPick` 走谓词拒绝路径 |
| Task 9 采样 | `room-metrics.test.ts` 的 `{ scan } as Redis` | 补 `pipeline` 桩：`pipeline()` 返回 `{ hget: vi.fn().mockReturnThis(), exec: async () => keys.map(() => [null, 'paodekuai']) }` |
| Task 10 结算失败 | `game.service.redis.test.ts` 的 C3 终局夹具 `:96-113` | mock `GameService.prototype.runtimeFor` 返回假 runtime（settle 抛错）；publish 失败直接 mock `redis.publish` reject |
| Task 11 PDK bot | `bot-pdk.test.ts` / `bot.player.test.ts` | 传 `features.gameType` 非 `paodekuai` 触发 feature guard；或构造无合法首出触发 `decidePdkBot` throw |
| Task 12 清理 | `records-cleanup.test.ts` 的 `FakeCleanupDb` / `runCleanupOnce` | 造 ddz 2 行、pdk 0 行；断言两个 game_type 序列（0 也写） |
| Task 12 风控 | `risk-scan.test.ts` 的扫描夹具 | 复用“PDK 2 局 2 胜”夹具，断言 `risk_scan_hits_total{game_type='paodekuai'}` |

---

### Task 1: shared 指标标签助手

**Files:**
- Create: `packages/shared/src/metrics/game-label.ts`
- Modify: `packages/shared/src/index.ts:31-36`
- Test: `packages/shared/src/metrics/game-label.test.ts`

**Interfaces:**
- Produces:
  - `normalizeGameType(value: unknown): GameType`
  - `gameLabel(value: unknown): { game_type: GameType }`
  - `incGame<T extends string>(counter: Counter<T>, gameType: unknown, amount?: number, labels?: Partial<Record<T, string | number>>): void`
  - `setGame<T extends string>(gauge: Gauge<T>, gameType: unknown, value: number): void`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/metrics/game-label.test.ts
import { describe, expect, it } from 'vitest';
import { createCounter, createGauge } from './registry';
import { gameLabel, incGame, normalizeGameType, setGame } from './game-label';

describe('normalizeGameType', () => {
  it('合法玩法原样返回', () => {
    expect(normalizeGameType('doudizhu')).toBe('doudizhu');
    expect(normalizeGameType('paodekuai')).toBe('paodekuai');
  });

  it('缺省/空串/未知值一律归一为斗地主', () => {
    for (const value of [undefined, null, '', 'pdk', 'PAODEKUAI', 1, {}, []]) {
      expect(normalizeGameType(value), JSON.stringify(value)).toBe('doudizhu');
    }
  });
});

describe('incGame / setGame', () => {
  it('amount=0 保留零值序列（残差 0 口径）', async () => {
    const counter = createCounter('test_inc_game_zero_total', 'test', ['game_type', 'kind']);
    incGame(counter, 'paodekuai', 0, { kind: 'settle' });
    const { values } = await counter.get();
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { game_type: 'paodekuai', kind: 'settle' }, value: 0 },
      ]),
    );
  });

  it('amount=2 累加 2，且缺省玩法归 ddz', async () => {
    const counter = createCounter('test_inc_game_amount_total', 'test', ['game_type']);
    incGame(counter, 'paodekuai', 2);
    incGame(counter, undefined, 1);
    const { values } = await counter.get();
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { game_type: 'paodekuai' }, value: 2 },
        { labels: { game_type: 'doudizhu' }, value: 1 },
      ]),
    );
  });

  it('调用方传入 game_type 不能覆盖助手归一值', async () => {
    const counter = createCounter('test_inc_game_override_total', 'test', ['game_type', 'kind']);
    incGame(counter, 'paodekuai', 1, { kind: 'x', game_type: 'doudizhu' } as never);
    const { values } = await counter.get();
    const hit = values.find((v) => v.labels.kind === 'x');
    expect(hit?.labels.game_type).toBe('paodekuai');
  });

  it('setGame 写入 game_type；gameLabel 与助手一致', async () => {
    const gauge = createGauge('test_set_game_gauge', 'test', ['game_type']);
    setGame(gauge, 'paodekuai', 7);
    expect(await gauge.get()).toMatchObject({
      values: [{ labels: { game_type: 'paodekuai' }, value: 7 }],
    });
    expect(gameLabel('paodekuai')).toEqual({ game_type: 'paodekuai' });
  });
});
```

- [ ] **Step 2: 跑红**

Run: `cd packages/shared && npx vitest run src/metrics/game-label.test.ts`
Expected: FAIL（`Cannot find module './game-label'`）。

- [ ] **Step 3: 最小实现**

```ts
// packages/shared/src/metrics/game-label.ts
import type { Counter, Gauge } from 'prom-client';
import { isGameType, type GameType } from '@fight-the-landlord/protocol';

/** 指标边界的玩法归一：合法值原样；缺省/空串/未知一律斗地主（有界标签）。 */
export function normalizeGameType(value: unknown): GameType {
  return isGameType(value) ? value : 'doudizhu';
}

export function gameLabel(value: unknown): { game_type: GameType } {
  return { game_type: normalizeGameType(value) };
}

/** 强制带 game_type 的 counter.inc；调用方无法覆盖归一后的 game_type。 */
export function incGame<T extends string>(
  counter: Counter<T>,
  gameType: unknown,
  amount = 1,
  labels: Partial<Record<T, string | number>> = {},
): void {
  const values = { ...labels, game_type: normalizeGameType(gameType) };
  (counter as Counter<string>).inc(values, amount);
}

/** 强制带 game_type 的 gauge.set。 */
export function setGame<T extends string>(
  gauge: Gauge<T>,
  gameType: unknown,
  value: number,
): void {
  const values = { game_type: normalizeGameType(gameType) };
  (gauge as Gauge<string>).set(values, value);
}
```

`packages/shared/src/index.ts` 追加：

```ts
export * from './metrics/game-label';
```

- [ ] **Step 4: 跑绿**

Run: `cd packages/shared && npx vitest run src/metrics/game-label.test.ts && npx tsc --noEmit`
Expected: PASS；`npx tsc --noEmit` 0（若报 TS2352，说明 cast 仍走错重载——必须保持 `(counter as Counter<string>).inc(values, amount)` 形态）。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/metrics/game-label.ts packages/shared/src/metrics/game-label.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): 指标 game_type 标签助手（incGame/setGame）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: room-service 指标定义与测试助手

**Files:**
- Modify: `packages/room-service/src/metrics/room.metrics.ts`
- Modify: `packages/room-service/test/helpers/metric-readout.ts`
- Modify: `packages/room-service/test/client-message-wiring.gate.test.ts:229-250`
- Test: `packages/room-service/test/room-metrics-definitions.test.ts`（新建）

**Interfaces:**
- Produces:
  - `gameStartFailuresTotal`（labels `game_type, reason`）
  - `recordWriteFailuresTotal`（labels `game_type, kind`）
  - `recordWriteSkipsTotal`（labels `game_type, reason`）
  - `exactSeriesValue(metric, labels): Promise<number | undefined>`（标签集**完全相等**才命中）
- 现有指标按 spec §4.1 追加 labelNames（`games_started_total` / `games_ended_total` / `rooms_active` / `currency_settle_result_total` / `currency_settle_residue_total` / `currency_settle_outbox_size` / `currency_settle_outbox_oldest_seconds` / `entry_fee_skipped_total` / `entry_fee_conflict_total` / `currency_robot_topup_total` / `currency_robot_ensure_failed_total` / `match_predicate_rejections_total` / `match_selection_rounds_total` / `match_no_legal_group_total`）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/room-service/test/room-metrics-definitions.test.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { incGame } from '@fight-the-landlord/shared';
import {
  entryFeeConflictTotal,
  gameStartFailuresTotal,
  gamesEndedTotal,
  gamesStartedTotal,
  recordWriteFailuresTotal,
  recordWriteSkipsTotal,
} from '../src/metrics/room.metrics';
import { exactSeriesValue } from './helpers/metric-readout';

describe('room 指标定义（A1）', () => {
  it('新增失败/跳过计数器带 game_type 且有界 reason/kind', async () => {
    incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: 'rules' });
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })).toBe(1);

    incGame(recordWriteFailuresTotal, 'paodekuai', 1, { kind: 'record_lost' });
    expect(await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'record_lost',
    })).toBe(1);

    incGame(recordWriteSkipsTotal, 'doudizhu', 1, { reason: 'room_ttl' });
    expect(await exactSeriesValue(recordWriteSkipsTotal, {
      game_type: 'doudizhu', reason: 'room_ttl',
    })).toBe(1);
  });

  it('既有指标已声明 game_type：incGame 后序列带该标签', async () => {
    incGame(gamesStartedTotal, 'paodekuai');
    expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'paodekuai' })).toBeGreaterThan(0);

    incGame(gamesEndedTotal, undefined);
    expect(await exactSeriesValue(gamesEndedTotal, { game_type: 'doudizhu' })).toBeGreaterThan(0);

    incGame(entryFeeConflictTotal, 'paodekuai');
    expect(await exactSeriesValue(entryFeeConflictTotal, { game_type: 'paodekuai' })).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `cd packages/room-service && npx vitest run test/room-metrics-definitions.test.ts`
Expected: FAIL（`gameStartFailuresTotal` 未导出 / `exactSeriesValue` 不存在）。

- [ ] **Step 3: 实现**

1. 在 `room.metrics.ts` 的既有定义上补 labelNames（逐个按 spec §4.1 表格）：

```ts
export const gamesStartedTotal: CounterOf = createCounter(
  'games_started_total',
  '已开局的对局数（按玩法；room-service 开局成功点计数；game.start 失败的假开局不计入）。',
  ['game_type'],
);
export const gamesEndedTotal: CounterOf = createCounter(
  'games_ended_total',
  '已结束的对局数（按玩法；room-service 收到 game.ended 事件计数）。',
  ['game_type'],
);
export const roomsActive: GaugeOf = createGauge(
  'rooms_active',
  '活跃房间数（全栈口径：Redis SCAN 聚合 room:* 非派生键；按玩法）。',
  ['game_type'],
);
export const currencySettleResultTotal: CounterOf = createCounter(
  'currency_settle_result_total',
  '金币场结算处置计数（按玩法；ok|replayed|retried|r2|outboxed|dropped；终态看 ok|replayed）。',
  ['result', 'game_type'],
);
export const currencySettleResidueTotal: CounterOf = createCounter(
  'currency_settle_residue_total',
  '金币场结算的截断残差销毁总额（按玩法；floor 分摊余数；无截断时为 0）。',
  ['game_type'],
);
export const currencySettleOutboxSize: GaugeOf = createGauge(
  'currency_settle_outbox_size',
  '金币场结算补偿队列条目数（settle:outbox + recordmoney:outbox，按玩法；sweeper 每轮刷新）。',
  ['game_type'],
);
export const currencySettleOutboxOldestSeconds: GaugeOf = createGauge(
  'currency_settle_outbox_oldest_seconds',
  '金币场结算补偿队列最老条目年龄（秒，按玩法；空队列为 0；告警阈值 >300s）。',
  ['game_type'],
);
export const currencyRobotTopupTotal: CounterOf = createCounter(
  'currency_robot_topup_total',
  '机器人虚拟币补款/回收动作计数（action=refill|recall，按玩法）。',
  ['action', 'game_type'],
);
export const currencyRobotEnsureFailedTotal: CounterOf = createCounter(
  'currency_robot_ensure_failed_total',
  '机器人 ensure（补给观测 → 注资）失败计数（按玩法）。',
  ['game_type'],
);
export const entryFeeSkippedTotal: CounterOf = createCounter(
  'entry_fee_skipped_total',
  '台费免单计数（reason=insufficient_funds|unknown_outcome|internal_error，按玩法）。',
  ['reason', 'game_type'],
);
export const entryFeeConflictTotal: CounterOf = createCounter(
  'entry_fee_conflict_total',
  '台费 op 冲突计数（14002：同锚已有成功提交，台费已收——不是漏收；按玩法）。',
  ['game_type'],
);
export const matchPredicateRejectionsTotal: CounterOf = createCounter(
  'match_predicate_rejections_total',
  '匹配谓词拒绝计数（随机抽取中每对谓词拒绝计一次，按 predicate/玩法）。',
  ['predicate', 'game_type'],
);
export const matchSelectionRoundsTotal: CounterOf = createCounter(
  'match_selection_rounds_total',
  '匹配随机抽选的轮次计数（每轮每个 ≥3 真人的队列桶计一次，按玩法）。',
  ['game_type'],
);
export const matchNoLegalGroupTotal: CounterOf = createCounter(
  'match_no_legal_group_total',
  '≥3 人但本轮随机贪心未凑出合法三人组的桶次计数（按玩法）。',
  ['game_type'],
);
```

2. 文件末尾追加三个新指标：

```ts
/** A1：开局失败（按玩法 + 有界 reason）。 */
export const gameStartFailuresTotal: CounterOf = createCounter(
  'game_start_failures_total',
  '开局失败计数（reason=start_rpc|pending_write|bot_fill|rules|on_seats|cancelled，按玩法）。',
  ['game_type', 'reason'],
);

/** A1：记录写失败/丢失（按玩法 + 有界 kind）。 */
export const recordWriteFailuresTotal: CounterOf = createCounter(
  'record_write_failures_total',
  '对局记录写失败/丢失计数（kind=record|money_delta|record_lost，按玩法）。',
  ['game_type', 'kind'],
);

/** A1：记录写跳过（预期窗口，仅诊断，不告警）。 */
export const recordWriteSkipsTotal: CounterOf = createCounter(
  'record_write_skips_total',
  '对局记录写跳过计数（reason=room_ttl；预期窗口，仅诊断，不告警）。',
  ['game_type', 'reason'],
);
```

3. `metric-readout.ts` 追加：

```ts
/** 标签集**完全相等**才命中；不存在 ⇒ undefined（防子集首条假绿）。 */
export async function exactSeriesValue(
  metric: { get(): Promise<unknown> },
  labels: Record<string, string>,
): Promise<number | undefined> {
  const { values } = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  const wantKeys = Object.keys(labels).sort();
  const hits = values.filter(
    (v) =>
      Object.keys(v.labels).sort().join('\u0000') === wantKeys.join('\u0000') &&
      wantKeys.every((k) => String(v.labels[k]) === labels[k]),
  );
  if (hits.length > 1) throw new Error(`exactSeriesValue 命中多条：${JSON.stringify(labels)}`);
  return hits[0]?.value;
}
```

4. `client-message-wiring.gate.test.ts` 的 mock 增加：

```ts
gameStartFailuresTotal: counter,
recordWriteFailuresTotal: counter,
recordWriteSkipsTotal: counter,
```

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/shared build && cd packages/room-service && npx vitest run test/room-metrics-definitions.test.ts && npx tsc --noEmit`
Expected: PASS；`npx tsc --noEmit` 0（若报 TS2352，说明 cast 仍走错重载——必须保持 `(counter as Counter<string>).inc(values, amount)` 形态）。

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/metrics/room.metrics.ts packages/room-service/test/helpers/metric-readout.ts packages/room-service/test/room-metrics-definitions.test.ts packages/room-service/test/client-message-wiring.gate.test.ts
git commit -m "feat(room): 指标补 game_type + 失败/跳过计数器定义
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 开局链计数（rooms.start.ts）

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.start.ts:212-417, 918-949`
- Test: `packages/room-service/test/rooms.start.test.ts`, `packages/room-service/test/pdk-start-retry.test.ts`

**Interfaces:**
- Consumes: `incGame`、`gameStartFailuresTotal`、`gamesStartedTotal`
- Produces: `failPdkStart(code, room, seats, metricReason: 'bot_fill'|'pending_write'|'rules'|null, detail: string, onSeats?)`

- [ ] **Step 1: 写失败测试**（追加到 `pdk-start-retry.test.ts`）。先把 `beforeEach` 里的局部 `const send = vi.fn(...)` 提升为 describe 级 `let rpcSend: ReturnType<typeof vi.fn>;`，并在 `beforeEach` 赋值为 `rpcSend = vi.fn(...)`、`const proxy = { send: rpcSend } as never;`——否则 bot_fill 用例无法覆写 RPC 行为。

```ts
import { exactSeriesValue } from './helpers/metric-readout';
import { gameStartFailuresTotal } from '../src/metrics/room.metrics';

it('A1：rules 失败按 reason=rules 计数；第 5 次取消额外计 cancelled', async () => {
  await pdkRoom('PDKM1');
  configCache.pdkRules.mockImplementation(() => { throw new Error('bad config'); });
  const before = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'rules',
  })) ?? 0;
  for (let i = 0; i < START_ATTEMPTS_MAX; i += 1) {
    await service.startRoomOutcome('PDKM1', { strict: false });
  }
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'rules',
  })).toBeGreaterThanOrEqual(before + START_ATTEMPTS_MAX);
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'cancelled',
  })).toBeGreaterThanOrEqual(1);
});

it('A1：bot fill 失败计 reason=bot_fill（不出现 rules）', async () => {
  // 先在 beforeEach 把局部 `const send` 提升为 describe 级 `rpcSend`
  const original = rpcSend.getMockImplementation()!;
  rpcSend.mockImplementation((pattern: string, data: unknown) =>
    pattern === RPC_PATTERNS.robotAcquire
      ? of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'down' })
      : original(pattern, data),
  );
  await pdkRoom('PDKM2');
  const beforeBot = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'bot_fill',
  })) ?? 0;
  const beforeRules = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'rules',
  })) ?? 0;

  const outcome = await service.startRoomOutcome('PDKM2', { strict: false });

  expect(outcome).toBe('retryable');
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'bot_fill',
  })).toBe(beforeBot + 1);
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'rules',
  })).toBe(beforeRules);
});

it('A1：pending_write 失败计 reason=pending_write', async () => {
  await pdkRoom('PDKM3');
  const originalHset = redis.hset.bind(redis);
  vi.spyOn(redis, 'hset').mockImplementation(async (key: string, ...args: never[]) => {
    if (String(key).startsWith('match:pending:')) throw new Error('redis down');
    return originalHset(key, ...args as never[]);
  });
  const before = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'pending_write',
  })) ?? 0;

  const outcome = await service.startRoomOutcome('PDKM3', { strict: false });

  expect(outcome).toBe('retryable');
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'paodekuai', reason: 'pending_write',
  })).toBe(before + 1);
});
```

`rooms.start.test.ts` 追加（复用 `manualRoom` / `handlers` / `service`）；顶部补 `import { exactSeriesValue } from './helpers/metric-readout';` 与 `import { gameStartFailuresTotal, gamesStartedTotal } from '../src/metrics/room.metrics';`。

```ts
it('A1：开局成功按 game_type=doudizhu 计数', async () => {
  await manualRoom('A1S01', ['u1', 'u2', 'u3']);
  const before = (await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })) ?? 0;

  expect(await service.startRoom('A1S01', { strict: true })).toBe(true);

  expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })).toBe(before + 1);
});

it('A1：start_rpc 失败恰计一次', async () => {
  await manualRoom('A1S02', ['u1', 'u2', 'u3']);
  handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));
  const before = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'doudizhu', reason: 'start_rpc',
  })) ?? 0;

  expect(await service.startRoom('A1S02', { strict: true })).toBe(false);

  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'doudizhu', reason: 'start_rpc',
  })).toBe(before + 1);
});

it('A1：ddz onSeats 失败计 reason=on_seats', async () => {
  await manualRoom('A1S03', ['u1', 'u2', 'u3']);
  const before = (await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'doudizhu', reason: 'on_seats',
  })) ?? 0;

  const outcome = await service.startRoomOutcome('A1S03', {
    strict: false,
    onSeats: async () => { throw new Error('hook down'); },
  });

  expect(outcome).toBe('fatal');
  expect(await exactSeriesValue(gameStartFailuresTotal, {
    game_type: 'doudizhu', reason: 'on_seats',
  })).toBe(before + 1);
});
```

**注意**：`start_rpc` 还必须验证“不因 pdk 的 `failPdkStart('game.start failed')` 二次计”——用上面 PDK rules 用例与 ddz 用例的差值断言，或加一条源内调用点断言（`failPdkStart(..., null, 'game.start failed'`）。

`rooms.entry-fee.test.ts`：顶部补 `import { exactSeriesValue } from './helpers/metric-readout';` 与两个台费指标 import；**不要新起场景**，在既有“余额不足免单”与“14002 冲突”用例末尾追加断言（见下）。

```ts
// 追加到既有“余额不足免单”用例末尾：
// 追加到既有“14002 冲突”用例末尾：
  expect(await exactSeriesValue(entryFeeSkippedTotal, {
    game_type: 'doudizhu', reason: 'insufficient_funds',
  })).toBeGreaterThan(0);
  // 14002 冲突场景：
  expect(await exactSeriesValue(entryFeeConflictTotal, { game_type: 'doudizhu' })).toBeGreaterThan(0);
});
```
```

- [ ] **Step 2: 跑红**

**既有断言同步**：`rooms.start.test.ts:503-538` 的 `metricValue(gamesStartedTotal)` 是 `values[0]`；改为 `exactSeriesValue(..., {game_type:'doudizhu'})`，否则新 PDK 序列插入后顺序依赖。

Task 9 同理：`room-metrics.test.ts:34` 的 `metricValue(roomsActive)` 改为 `exactSeriesValue(roomsActive, { game_type: 'doudizhu' })`。

Run: `cd packages/room-service && npx vitest run test/pdk-start-retry.test.ts test/rooms.start.test.ts`
Expected: FAIL（reason 标签无序列 / 计数缺失）。

- [ ] **Step 3: 实现**

`rooms.start.ts`：

```ts
import { incGame } from '@fight-the-landlord/shared';
import { gameStartFailuresTotal, gamesStartedTotal } from '../metrics/room.metrics';

type PdkStartFailureReason = 'bot_fill' | 'pending_write' | 'rules' | null;
```

`failPdkStart` 签名与计数：

```ts
private async failPdkStart(
  code: string,
  room: Room,
  seats: Seat[],
  metricReason: PdkStartFailureReason,
  detail: string,
  onSeats?: (seats: Seat[]) => Promise<void>,
): Promise<StartRoomOutcome> {
  const key = startAttemptsKey(code);
  const attempts = await this.redis.incr(key);
  await this.redis.expire(key, ROOM_TTL_SECONDS);
  if (metricReason !== null) {
    incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: metricReason });
  }
  const expired = isWaitingExpired(room, this.rooms.now());
  this.logger.warn(
    `pdk start failed for ${code} (attempt ${attempts}/${START_ATTEMPTS_MAX}${expired ? ', waiting expired' : ''}): ${detail}`,
  );
  if (attempts >= START_ATTEMPTS_MAX || expired) {
    incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: 'cancelled' });
    // ...既有 cancel 逻辑逐字保留
  }
  // ...
}
```

四个调用点：

```ts
// :224 bot fill
this.failPdkStart(code, room, room.players, 'bot_fill', 'bot fill failed', options.onSeats)
// :274 pending write
this.failPdkStart(code, room, filled.seats, 'pending_write', 'match:pending write failed', options.onSeats)
// :301 rules
this.failPdkStart(code, room, filled.seats, 'rules', `pdk rules unavailable: ${...}`, options.onSeats)
// :337 game.start failed —— start_rpc 已在 catch 计过
this.failPdkStart(code, room, filled.seats, null, 'game.start failed', options.onSeats)
```

ddz 三路径（与 pdk 分支同处）：

```ts
// !filled
if (isPdk) return this.failPdkStart(...);
incGame(gameStartFailuresTotal, gameType, 1, { reason: 'bot_fill' });
return 'fatal';
// match:pending catch
if (isPdk) return this.failPdkStart(...);
incGame(gameStartFailuresTotal, gameType, 1, { reason: 'pending_write' });
return 'fatal';
// onSeats catch（ddz）
incGame(gameStartFailuresTotal, gameType, 1, { reason: 'on_seats' });
return 'fatal';
```

`startAndAnnounce` 的 `game.start` catch：

```ts
} catch (err) {
  incGame(gameStartFailuresTotal, gameType, 1, { reason: 'start_rpc' });
  this.logger.error(`Failed to start game for room ${code}: ${String(err)}`);
  ok = false;
}
```

台费三处写点（同文件，方法内已有 `gameType`）：

```ts
// chargeOne（:791）
incGame(entryFeeConflictTotal, gameType, 1);
// recordEntryFeeSkip（:873/:876）
incGame(entryFeeSkippedTotal, gameType, 1, { reason });
```

成功点：

```ts
if (ok) incGame(gamesStartedTotal, gameType);
```

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/shared build && cd packages/room-service && npx vitest run test/pdk-start-retry.test.ts test/rooms.start.test.ts test/rooms.entry-fee.test.ts && npx tsc --noEmit`
Expected: PASS；原有 outcome/warning 断言不变。

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/rooms/rooms.start.ts packages/room-service/test/pdk-start-retry.test.ts packages/room-service/test/rooms.start.test.ts packages/room-service/test/rooms.entry-fee.test.ts
git commit -m "feat(room): 开局成功/失败按玩法计数（6 种 reason）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 局终与记录计数（ws.gateway.ts）

**Files:**
- Modify: `packages/room-service/src/gateway/ws.gateway.ts:128-139, 924-928, 1106-1196`
- Test: `packages/room-service/test/ws.gateway.test.ts`

**Interfaces:**
- Consumes: `incGame`、`gamesEndedTotal`、`recordWriteFailuresTotal`、`recordWriteSkipsTotal`
- Produces: 私有方法 `resolveGameEventType(event: GameEvent): GameType`

- [ ] **Step 1: 写失败测试**

```ts
import { exactSeriesValue } from './helpers/metric-readout';
import {
  gamesEndedTotal, recordWriteFailuresTotal, recordWriteSkipsTotal,
} from '../src/metrics/room.metrics';

it('A1：game.ended 按 gameType 计结束；缺省归 ddz', async () => {
  const ctx = makeGateway();
  const RESULT = { roomCode: 'R2', baseScore: 15, winner: 'landlord', landlordSeat: 0, farmerSeats: [1, 2], multiplier: 2, spring: 'none', landlordScoreChange: 60, farmerScoreChange: -30 } as never;
  const pdk = {
    roomCode: 'R1', gameType: 'paodekuai', playerCount: 3, baseScore: 15,
    winnerSeats: [0], scoreChanges: [{ seat: 0, delta: 30 }, { seat: 1, delta: -15 }, { seat: 2, delta: -15 }],
    remaining: [0, 5, 5], multiplier: 1, bombCount: 0, guan: false, spring: false, baobenSeats: [],
  };
  const beforePdk = (await exactSeriesValue(gamesEndedTotal, { game_type: 'paodekuai' })) ?? 0;
  ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'R1', version: 1, gameType: 'paodekuai', result: pdk } as never);
  expect(await exactSeriesValue(gamesEndedTotal, { game_type: 'paodekuai' })).toBe(beforePdk + 1);

  const beforeDdz = (await exactSeriesValue(gamesEndedTotal, { game_type: 'doudizhu' })) ?? 0;
  ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'R2', version: 1, result: RESULT } as never);
  expect(await exactSeriesValue(gamesEndedTotal, { game_type: 'doudizhu' })).toBe(beforeDdz + 1);
});

it('A1：记录投递失败计 record；房间 TTL 跳过计 room_ttl；形状不符计 record_lost', async () => {
  const { recordClient, rooms, ctx } = await makeRecordFixtures();

  const beforeRecord = (await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'doudizhu', kind: 'record',
  })) ?? 0;
  recordClient.write.mockRejectedValueOnce(new Error('down'));
  ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 30, result: RESULT, record: envelope() });
  await vi.waitFor(() => expect(exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'doudizhu', kind: 'record',
  })).resolves.toBe(beforeRecord + 1));

  const beforeSkip = (await exactSeriesValue(recordWriteSkipsTotal, {
    game_type: 'doudizhu', reason: 'room_ttl',
  })) ?? 0;
  rooms.findOne.mockResolvedValueOnce(null);
  ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 31, result: RESULT, record: envelope() });
  await vi.waitFor(() => expect(exactSeriesValue(recordWriteSkipsTotal, {
    game_type: 'doudizhu', reason: 'room_ttl',
  })).resolves.toBe(beforeSkip + 1));

  const beforeLost = (await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'record_lost',
  })) ?? 0;
  rooms.findOne.mockResolvedValueOnce({ ...(await rooms.findOne()), gameType: 'doudizhu' } as never);
  ctx.gateway.onGameEvent({
    event: 'game.ended', roomCode: 'ROOM1', version: 32,
    result: { ...(RESULT as object), gameType: 'paodekuai' } as never,
    record: { ...envelope(), gameType: 'paodekuai' } as never,
  });
  await vi.waitFor(() => expect(exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'record_lost',
  })).resolves.toBe(beforeLost + 1));
});
```

- [ ] **Step 2: 跑红**

**既有断言同步**：`ws.gateway.test.ts:2228-2234` 的 metrics 断言用 `values[0]`；改为按 `game_type` 精确读。

Run: `cd packages/room-service && npx vitest run test/ws.gateway.test.ts`
Expected: FAIL（标签无序列/计数缺失）。

- [ ] **Step 3: 实现**

1. `GameEvent` 增加：

```ts
gameType?: GameType;
```

2. 类内私有方法（`ws.gateway.ts` 顶部已从 protocol 导入 `isPdkSettlementResult`，补 `isGameType` 与 `type GameType`）：

```ts
private resolveGameEventType(event: GameEvent): GameType {
  const raw = event.gameType;
  const recordRaw = event.record?.gameType;
  if (raw !== undefined && !isGameType(raw)) {
    this.logger.warn(`game.ended carries invalid gameType ${JSON.stringify(raw)} — treating as doudizhu`);
  }
  if (recordRaw !== undefined && !isGameType(recordRaw)) {
    this.logger.warn(`game.ended record carries invalid gameType ${JSON.stringify(recordRaw)}`);
  }
  if (isGameType(raw)) return raw;
  if (isGameType(recordRaw)) return recordRaw;
  return 'doudizhu';
}
```

3. `game.ended` 分支：

```ts
const endedGameType = this.resolveGameEventType(event);
incGame(gamesEndedTotal, endedGameType);
```

4. 记录投递 catch：

`finalizeRoomEnd` 与 `onGameEvent` 是不同方法：catch 内**重新解析**，不得引用 `endedGameType`：

```ts
const recordGameType = this.resolveGameEventType(event);
incGame(recordWriteFailuresTotal, recordGameType, 1, { kind: 'record' });
this.logger.error(`Record write failed for room ${event.roomCode}: ${String(err)}`);
```

5. `writeGameRecord` 两个跳过分支：

```ts
// room 缺失
incGame(recordWriteSkipsTotal, record.gameType, 1, { reason: 'room_ttl' });
this.logger.warn(...);
return;

// 形状/玩法不符
incGame(recordWriteFailuresTotal, record.gameType, 1, { kind: 'record_lost' });
this.logger.warn(...);
return;
```

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/ws.gateway.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/gateway/ws.gateway.ts packages/room-service/test/ws.gateway.test.ts
git commit -m "feat(room): 局终/记录写失败按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 结算计数（settle.service.ts）

**Files:**
- Modify: `packages/room-service/src/currency/settle.service.ts:307-533, 573-705, 731-770, 850-895, 898-916`
- Test: `packages/room-service/test/currency/settle-pdk.test.ts`, `packages/room-service/test/currency/settle-outbox.test.ts`

**Interfaces:**
- Consumes: `incGame`、`currencySettleResultTotal`、`currencySettleResidueTotal`、`recordWriteFailuresTotal`
- Produces: `applyGraded(..., gameType: GameType)`、`readBalances(ownerIds, gameType)`、`dropWarn(..., gameType)`、`dropError(..., gameType)`、`gameTypeFromResult(result): GameType`

- [ ] **Step 1: 写失败测试**（`settle-pdk.test.ts`）

```ts
import { exactSeriesValue } from '../helpers/metric-readout';
import {
  currencySettleResultTotal, currencySettleResidueTotal, recordWriteFailuresTotal,
} from '../../src/metrics/room.metrics';

it('A1：PDK 结算 ok 与残差按 game_type 计数', async () => {
  const h = makeHarness();
  const input = validInput({ room: pdkRoom(3), result: pdkResult(3, [30, -15, -15]) });
  h.currency.get.mockResolvedValue({
    balances: ['u0', 'u1', 'u2'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
  });
  h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
    applyOk(req.actionId, req.entries, { u0: 1000, u1: 1000, u2: 1000 }),
  );
  const okBefore = (await exactSeriesValue(currencySettleResultTotal, {
    result: 'ok', game_type: 'paodekuai',
  })) ?? 0;
  const residueBefore = (await exactSeriesValue(currencySettleResidueTotal, {
    game_type: 'paodekuai',
  })) ?? 0;

  await h.svc.settle(input);

  expect(await exactSeriesValue(currencySettleResultTotal, {
    result: 'ok', game_type: 'paodekuai',
  })).toBe(okBefore + 1);
  const residueAfter = (await exactSeriesValue(currencySettleResidueTotal, {
    game_type: 'paodekuai',
  })) ?? 0;
  expect(residueAfter - residueBefore).toBe(0); // 夹具余额充足、无截断 ⇒ 残差增量为 0
});

it('A1：moneyDelta 失败/部分计 kind=money_delta', async () => {
  const h = makeHarness();
  const input = validInput({ room: pdkRoom(3), result: pdkResult(3, [30, -15, -15]) });
  h.currency.get.mockResolvedValue({
    balances: ['u0', 'u1', 'u2'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
  });
  h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
    applyOk(req.actionId, req.entries, { u0: 1000, u1: 1000, u2: 1000 }),
  );
  h.record.moneyDelta.mockRejectedValueOnce(new Error('down'));
  const before = (await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'money_delta',
  })) ?? 0;

  await h.svc.settle(input);

  expect(await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'money_delta',
  })).toBe(before + 1);
});
```

`settle-outbox.test.ts` 追加超龄放弃用例（复用 `settleEntry/moneyEntry/makeSweeper/SettleHarness`）：

```ts
it('A1：recordmoney 超龄放弃计 money_delta + dropped{game_type}', async () => {
  const h = makeHarness();
  const entry = moneyEntry({ gameType: 'paodekuai', createdAt: 0 }); // TTL 已过
  const beforeDropped = (await exactSeriesValue(currencySettleResultTotal, {
    result: 'dropped', game_type: 'paodekuai',
  })) ?? 0;
  const beforeMoney = (await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'money_delta',
  })) ?? 0;

  await h.svc.resendRecordMoneyOutboxEntry('f1', entry as never, Date.now());

  expect(await exactSeriesValue(currencySettleResultTotal, {
    result: 'dropped', game_type: 'paodekuai',
  })).toBe(beforeDropped + 1);
  expect(await exactSeriesValue(recordWriteFailuresTotal, {
    game_type: 'paodekuai', kind: 'money_delta',
  })).toBe(beforeMoney + 1);
});
```

- [ ] **Step 2: 跑红**

Run: `cd packages/room-service && npx vitest run test/currency/settle-pdk.test.ts test/currency/settle-outbox.test.ts`
Expected: FAIL（标签序列不存在）。

- [ ] **Step 3: 实现**

按以下映射替换所有 `currencySettleResultTotal.inc` / `currencySettleResidueTotal.inc`：

```ts
incGame(currencySettleResultTotal, gameType, 1, { result: 'ok' });
incGame(currencySettleResultTotal, gameType, 1, { result: 'r2' });
incGame(currencySettleResultTotal, gameType, 1, { result: 'retried' });
incGame(currencySettleResultTotal, gameType, 1, { result: 'outboxed' });
incGame(currencySettleResultTotal, gameType, 1, { result: outcome.kind });
incGame(currencySettleResultTotal, gameType, 1, { result: data.replayed ? 'replayed' : 'ok' });
incGame(currencySettleResidueTotal, gameType, computed.residue);
```

参数贯穿（**逐调用点，不得漏**）：

```ts
// 顶层兜底（:313）——房间可能缺失，从 result 反推
const topGameType = input.result !== undefined && isPdkSettlementResult(input.result)
  ? 'paodekuai' : 'doudizhu';
this.dropError(input.roomCode, input.version, topGameType, 'unexpected error', err);

// 房间已知后统一：
const gameType = room.gameType ?? DEFAULT_GAME_TYPE; // **守卫③之前**（:336 的 dropWarn 也要用；:356 现有声明位置太晚）
this.dropWarn(roomCode, version, gameType, '...');   // :336/:344/:360/:364
this.resolveSeats(room, input.botBySeat, version, playerCount, gameType); // :373
this.readBalances(..., gameType);                    // :381/:420
this.applyGraded(..., gameType);                     // :410/:442
this.dropError(roomCode, version, gameType, '...', err); // :383/:422/:479/:541/:549

// resendSettleOutboxEntry（:781）开头：
const gameType = isGameType(entry.gameType) ? entry.gameType : DEFAULT_GAME_TYPE;
// 超龄 dropped、replayed/ok、finalize 的 gameType 全用它；:838 的 dropError 也用它
```

`resolveSeats` 增加 `gameType: GameType` 形参，内部两处 `dropWarn` 使用它。
**删除**原计划里的 `beforeRoom` 死变量（`noUnusedLocals` 会红）。

`resendRecordMoneyOutboxEntry`：

```ts
const gameType = isGameType(entry.gameType) ? entry.gameType : DEFAULT_GAME_TYPE;
// 超龄放弃
incGame(currencySettleResultTotal, gameType, 1, { result: 'dropped' });
incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
// 部分/失败
incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
```

`pushMoneyDelta`：

```ts
// partial 分支与 catch 分支各一次
incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
```

`finalize` 的 `record.moneyDelta` 入箱失败 catch：

```ts
incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
```

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/currency/settle-pdk.test.ts test/currency/settle-outbox.test.ts test/currency/settle-algorithm.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/currency/settle.service.ts packages/room-service/test/currency/settle-pdk.test.ts packages/room-service/test/currency/settle-outbox.test.ts
git commit -m "feat(room): 结算处置/残差/moneyDelta 按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: outbox 采样（settle.sweeper.ts）

**Files:**
- Modify: `packages/room-service/src/currency/settle.sweeper.ts:110-127`
- Test: `packages/room-service/test/currency/settle-outbox.test.ts`

**Interfaces:**
- Consumes: `setGame`、`currencySettleOutboxSize`、`currencySettleOutboxOldestSeconds`
- Produces: `refreshOutboxGauges(now)` 先读后写、按条目 `gameType` 分组

- [ ] **Step 1: 写失败测试**

```ts
it('A1：outbox gauge 按 game_type 分组；hgetall 失败保持旧值', async () => {
  const h = makeHarness();
  const sweeper = makeSweeper(h);
  await seedSettle(h, settleEntry({ gameType: 'paodekuai', createdAt: Date.now() }));
  await seedMoney(h, moneyEntry({ createdAt: Date.now() })); // 缺省 gameType ⇒ ddz
  // 让两条都留在箱里：settle 重发失败、money 部分匹配
  h.currency.apply.mockRejectedValueOnce(new Error('down'));
  h.record.moneyDelta.mockResolvedValueOnce({ matched: [0] });
  await sweeper.sweepOnce(Date.now());

  const pdk = await exactSeriesValue(currencySettleOutboxSize, { game_type: 'paodekuai' });
  const ddz = await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' });
  expect(pdk).toBe(1);
  expect(ddz).toBe(1);

  h.redis.hgetall.mockRejectedValueOnce(new Error('redis down'));
  await sweeper.sweepOnce(Date.now()).catch(() => undefined);

  expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'paodekuai' })).toBe(pdk);
  expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })).toBe(ddz);
});

it('A1：未知 gameType 的 outbox 条目归 ddz 并汇总 WARN', async () => {
  const h = makeHarness();
  const sweeper = makeSweeper(h);
  await seedMoney(h, moneyEntry({ gameType: 'pdk', createdAt: Date.now() }));
  const before = (await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })) ?? 0;

  await sweeper.sweepOnce(Date.now());

  expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })).toBe(before + 1);
});
```

- [ ] **Step 2: 跑红**

Run: `cd packages/room-service && npx vitest run test/currency/settle-outbox.test.ts`
Expected: FAIL（无 game_type 序列）。

- [ ] **Step 3: 实现**（替换 `refreshOutboxGauges`）

```ts
private async refreshOutboxGauges(now: number): Promise<void> {
  // 整条读取失败 ⇒ 抛给 runOnce 的 catch，gauge 保留旧值（不得先置 0）
  const settleRaw = (await this.redis.hgetall(SETTLE_OUTBOX_KEY)) ?? {};
  const moneyRaw = (await this.redis.hgetall(RECORD_MONEY_OUTBOX_KEY)) ?? {};

  const sizes = new Map<GameType, number>([
    ['doudizhu', 0],
    ['paodekuai', 0],
  ]);
  const oldest = new Map<GameType, number>([
    ['doudizhu', 0],
    ['paodekuai', 0],
  ]);
  let badEntries = 0;

  for (const raw of [...Object.values(settleRaw), ...Object.values(moneyRaw)]) {
    let parsed: { createdAt?: unknown; gameType?: unknown };
    try {
      parsed = JSON.parse(raw) as { createdAt?: unknown; gameType?: unknown };
    } catch {
      // 设计 §5：单条目 JSON 坏 ⇒ 归 ddz + 汇总 WARN（整条 hgetall 失败才保留旧值）
      badEntries += 1;
      sizes.set('doudizhu', (sizes.get('doudizhu') ?? 0) + 1);
      continue;
    }
    const gameType = normalizeGameType(parsed.gameType);
    sizes.set(gameType, (sizes.get(gameType) ?? 0) + 1);
    if (typeof parsed.createdAt === 'number') {
      const age = Math.max(0, Math.round((now - parsed.createdAt) / 1000));
      oldest.set(gameType, Math.max(oldest.get(gameType) ?? 0, age));
    }
  }

  if (badEntries > 0) {
    this.logger.warn(`Settle outbox gauge: ${badEntries} unparseable entr(ies) counted as doudizhu`);
  }
  for (const gameType of ['doudizhu', 'paodekuai'] as const) {
    setGame(currencySettleOutboxSize, gameType, sizes.get(gameType) ?? 0);
    setGame(currencySettleOutboxOldestSeconds, gameType, oldest.get(gameType) ?? 0);
  }
}
```

坏条目按设计 §5 归 ddz（`badEntries` 汇总 WARN）；整条 `hgetall` 抛错时不会走到写 gauge。

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/currency/settle-outbox.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/currency/settle.sweeper.ts packages/room-service/test/currency/settle-outbox.test.ts
git commit -m "feat(room): outbox gauge 按玩法分组且失败保留旧值
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 机器人资金指标（robot-funding.ts）

**Files:**
- Modify: `packages/room-service/src/currency/robot-funding.ts:142-166, 176-275`
- Test: `packages/room-service/test/currency/robot-funding.test.ts`

**Interfaces:**
- Consumes: `incGame`、`currencyRobotTopupTotal`、`currencyRobotEnsureFailedTotal`
- Produces: `applyFunding(...)` 增加 `gameType: GameType` 参数

- [ ] **Step 1: 写失败测试**

```ts
// 顶部补：import { labeledValue } from '../helpers/metric-readout'; 以及两个 metric 的 import
it('A1：补款与 ensure 失败按 game_type 计数', async () => {
  const h = makeHarness();
  const beforeRefill = (await labeledValue(currencyRobotTopupTotal, {
    action: 'refill', game_type: 'paodekuai',
  })) ?? 0;
  await h.svc.ensureBots(['bot-1'], 'paodekuai');
  expect(await labeledValue(currencyRobotTopupTotal, {
    action: 'refill', game_type: 'paodekuai',
  })).toBe(beforeRefill + 1);

  const beforeFailed = (await labeledValue(currencyRobotEnsureFailedTotal, {
    game_type: 'paodekuai',
  })) ?? 0;
  h.currency.get.mockRejectedValueOnce(new Error('down'));
  await h.svc.ensureBots(['bot-2'], 'paodekuai');
  expect(await labeledValue(currencyRobotEnsureFailedTotal, {
    game_type: 'paodekuai',
  })).toBe(beforeFailed + 1);
});
```

- [ ] **Step 2: 跑红** → FAIL。**既有断言同步**：`robot-funding.test.ts:87-90` 用 `values[0]`；改为按 `{action,game_type}` 精确读。
- [ ] **Step 3: 实现**

把 `currencyRobotTopupTotal.inc({ action })` 改为：

```ts
incGame(currencyRobotTopupTotal, gameType, 1, { action });
```

`currencyRobotEnsureFailedTotal.inc()` 改为：

```ts
incGame(currencyRobotEnsureFailedTotal, gameType);
```

`applyFunding` 签名补 `gameType: GameType`，调用点从 `ensureBots`/`afterSettle` 传入。

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/currency/robot-funding.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/currency/robot-funding.ts packages/room-service/test/currency/robot-funding.test.ts
git commit -m "feat(room): 机器人资金指标按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 匹配指标（match.service.ts）

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts:966-990, 1093-1110, 1297-1357`
- Test: `packages/room-service/test/match-player-count.test.ts`（PDK 队列夹具在该文件）

**Interfaces:**
- Consumes: `incGame`、三个匹配指标
- Produces: `randomGreedyPick(..., playerCount, gameType)`、`accountRejection(..., gameType)`

- [ ] **Step 1: 写失败测试**

```ts
it('A1：PDK 抽选轮与谓词拒绝带 game_type=paodekuai', async () => {
  // 顶部补：import { exactSeriesValue } from './helpers/metric-readout';
  // import { matchPredicateRejectionsTotal, matchSelectionRoundsTotal } from '../src/metrics/room.metrics';
  const h = make();
  enablePdk(h);
  const beforeRounds = (await exactSeriesValue(matchSelectionRoundsTotal, {
    game_type: 'paodekuai',
  })) ?? 0;
  await enqueuePdk(h, ['a1', 'a2'], 2);
  await h.service.scanOnce();
  expect(await exactSeriesValue(matchSelectionRoundsTotal, {
    game_type: 'paodekuai',
  })).toBe(beforeRounds + 1);

  const beforeRej = (await exactSeriesValue(matchPredicateRejectionsTotal, {
    predicate: 'sameDevice', game_type: 'paodekuai',
  })) ?? 0;
  await (h.service as unknown as {
    accountRejection: (...args: unknown[]) => Promise<void>;
  }).accountRejection(
    'a1', 'a2', { ok: false, memory: false, rejected: [{ name: 'sameDevice' }] }, T0, new Set(), 'paodekuai',
  );
  expect(await exactSeriesValue(matchPredicateRejectionsTotal, {
    predicate: 'sameDevice', game_type: 'paodekuai',
  })).toBe(beforeRej + 1);
});
```

- [ ] **Step 2: 跑红** → FAIL。**既有断言同步**：`match-player-count.test.ts` / `match.service.test.ts` 中 `values[0]` 断言改为按 `game_type` 精确读（后者 `:2228-2235/:2444-2452`）；本片新用例统一放前者。
- [ ] **Step 3: 实现**

- `randomGreedyPick` 增加 `gameType: GameType` 参数；两个调用点（:971/:1096）传 `queue.gameType`。
- `accountRejection` 增加 `gameType` 参数；调用点（:1332）传入。
- **5 处** inc（不是 3 处）全部改：

```ts
// :970 / :1095
incGame(matchSelectionRoundsTotal, queue.gameType);
// :986 / :1108
incGame(matchNoLegalGroupTotal, queue.gameType);
// :1351
incGame(matchPredicateRejectionsTotal, gameType, 1, { predicate: predicate.name });
```

测试落点统一为 **`match-player-count.test.ts`**（它有 PDK 队列夹具；`match.service.test.ts` 无 PDK 夹具）。Step 4 的 Run 与 Step 5 的 `git add` 都必须是该文件；不要只改 match.service.test。

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/match-player-count.test.ts test/predicates.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/match/match.service.ts packages/room-service/test/match-player-count.test.ts
git commit -m "feat(room): 匹配抽选/谓词指标按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 房间采样（room-metrics.service.ts）

**Files:**
- Modify: `packages/room-service/src/metrics/room-metrics.service.ts:71-84`
- Test: `packages/room-service/test/room-metrics.test.ts`

**Interfaces:**
- Consumes: `setGame`、`roomsActive`
- Produces: `sampleOnce()` 用 pipeline `HGET gameType`，先读后写

- [ ] **Step 1: 写失败测试**

```ts
it('A1：rooms_active 按 game_type 分组；pipeline 整条失败保留旧值', async () => {
  const exec = vi.fn(async () => [[null, 'doudizhu'], [null, 'paodekuai']]);
  const pipeline = { hget: vi.fn().mockReturnThis(), exec };
  const scan = vi.fn(async (cursor: string) =>
    cursor === '0' ? ['0', ['room:AAA', 'room:BBB']] : ['0', []],
  );
  const service = new RoomMetricsService({ scan, pipeline } as unknown as Redis);

  await service.sampleOnce();
  const ddz = await exactSeriesValue(roomsActive, { game_type: 'doudizhu' });
  const pdk = await exactSeriesValue(roomsActive, { game_type: 'paodekuai' });
  expect(ddz).toBe(1);
  expect(pdk).toBe(1);

  exec.mockRejectedValueOnce(new Error('redis down'));
  await expect(service.sampleOnce()).rejects.toThrow('redis down');
  expect(await exactSeriesValue(roomsActive, { game_type: 'doudizhu' })).toBe(ddz);
  expect(await exactSeriesValue(roomsActive, { game_type: 'paodekuai' })).toBe(pdk);
});
```

- [ ] **Step 2: 跑红** → FAIL（gauge 无标签 / pipeline 不存在）。同时把本文件既有两个用例的 `{ scan } as Redis` 补 `pipeline` 桩（返回 `{ exec: async () => keys.map(() => [null, 'doudizhu']) }`），否则旧用例先红。
- [ ] **Step 3: 实现**

```ts
async sampleOnce(): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await this.redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      if (key.slice('room:'.length).includes(':')) continue;
      keys.push(key);
    }
  } while (cursor !== '0');

  const pipeline = this.redis.pipeline();
  for (const key of keys) pipeline.hget(key, 'gameType');
  const results = await pipeline.exec(); // 整条失败 ⇒ 抛给 runRound，gauge 保留旧值

  const counts = new Map<GameType, number>([
    ['doudizhu', 0],
    ['paodekuai', 0],
  ]);
  let bad = 0;
  for (const [err, value] of results ?? []) {
    if (err) {
      bad += 1;
      counts.set('doudizhu', (counts.get('doudizhu') ?? 0) + 1);
      continue;
    }
    if (value !== null && value !== undefined && !isGameType(value)) bad += 1;
    const gameType = normalizeGameType(value);
    counts.set(gameType, (counts.get(gameType) ?? 0) + 1);
  }
  if (bad > 0) this.logger.warn(`rooms_active sample: ${bad} room(s) missing/invalid gameType — counted as doudizhu`);
  for (const gameType of ['doudizhu', 'paodekuai'] as const) {
    setGame(roomsActive, gameType, counts.get(gameType) ?? 0);
  }
}
```

- [ ] **Step 4: 跑绿**

Run: `cd packages/room-service && npx vitest run test/room-metrics.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/metrics/room-metrics.service.ts packages/room-service/test/room-metrics.test.ts
git commit -m "feat(room): rooms_active 按玩法采样（先读后写）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: game-service（games_active / 结算失败）

**Files:**
- Modify: `packages/game-service/src/metrics/game.metrics.ts`
- Modify: `packages/game-service/src/metrics/game-metrics.service.ts:68-70`
- Modify: `packages/game-service/src/game/game.service.ts:359-361, 825-843`
- Test: `packages/game-service/test/game-metrics.test.ts`, `packages/game-service/test/game.service.redis.test.ts`

**Interfaces:**
- Produces:
  - `gameSettleFailuresTotal`（labels `game_type, phase`）
  - `GameService.activeSessionCountByGameType(): Record<'doudizhu'|'paodekuai', number>`

- [ ] **Step 1: 写失败测试**

`game-metrics.test.ts`：

在 `game.service.redis.test.ts` 顶部补 `import { gameSettleFailuresTotal } from '../src/metrics/game.metrics';`，并把 `exactGauge` 也定义在该文件（或抽 `test/helpers/metric-readout.ts`）。

```ts
async function exactGauge(metric: { get(): Promise<unknown> }, labels: Record<string, string>): Promise<number | undefined> {
  const { values } = (await metric.get()) as { values: Array<{ labels: Record<string, string>; value: number }> };
  return values.find((v) => Object.keys(v.labels).sort().join('|') === Object.keys(labels).sort().join('|') &&
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))?.value;
}

it('A1：games_active 按 game_type 采样', async () => {
  const service = new GameMetricsService({
    activeSessionCountByGameType: () => ({ doudizhu: 2, paodekuai: 1 }),
  } as unknown as GameService);
  service.sampleOnce();
  expect(await exactGauge(gamesActive, { game_type: 'doudizhu' })).toBe(2);
  expect(await exactGauge(gamesActive, { game_type: 'paodekuai' })).toBe(1);
});
```

**既有用例同步**：`game-metrics.test.ts` **两处** fake（`fakeGame` 与第二个 inline `{ activeSessionCount }`）都要补 `activeSessionCountByGameType`（返回 `{doudizhu: count, paodekuai: 0}`），并把所有 `gaugeValue` 改成上面的 `exactGauge`。`GameService` 真对象用例同时断言 `activeSessionCountByGameType()`。

`game.service.redis.test.ts`：

```ts
it('A1：settle 抛错 ⇒ 计数 {phase:"settle"} 且仍抛出；publish 抛错同理', async () => {
  const redis = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    publish: vi.fn().mockResolvedValue(1),
    quit: vi.fn(async () => undefined),
  };
  const svc = new GameService(redis as unknown as Redis);
  const session = { gameType: 'doudizhu', playerCount: 3, version: 1 } as never;
  const fakeRuntime = {
    settle: vi.fn(() => { throw new Error('boom'); }),
    buildRecord: vi.fn(() => undefined),
  };
  (svc as unknown as { runtimeFor: (s: unknown) => unknown }).runtimeFor = () => fakeRuntime;

  const beforeSettle = (await exactGauge(gameSettleFailuresTotal, {
    game_type: 'doudizhu', phase: 'settle',
  })) ?? 0;
  await expect(
    (svc as unknown as { publishEnded: (r: string, s: unknown) => Promise<void> }).publishEnded('R1', session),
  ).rejects.toThrow('boom');
  expect(await exactGauge(gameSettleFailuresTotal, {
    game_type: 'doudizhu', phase: 'settle',
  })).toBe(beforeSettle + 1);

  fakeRuntime.settle.mockReturnValue({ winner: 'landlord' } as never);
  redis.publish.mockRejectedValueOnce(new Error('pub'));
  const beforePublish = (await exactGauge(gameSettleFailuresTotal, {
    game_type: 'doudizhu', phase: 'publish',
  })) ?? 0;
  await expect(
    (svc as unknown as { publishEnded: (r: string, s: unknown) => Promise<void> }).publishEnded('R1', session),
  ).rejects.toThrow('pub');
  expect(await exactGauge(gameSettleFailuresTotal, {
    game_type: 'doudizhu', phase: 'publish',
  })).toBe(beforePublish + 1);
});
});
```

- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**

`game.metrics.ts`：

```ts
import { createCounter, createGauge } from '@fight-the-landlord/shared';

type GaugeOf = ReturnType<typeof createGauge>;
type CounterOf = ReturnType<typeof createCounter>;

export const gamesActive: GaugeOf = createGauge(
  'games_active',
  'game-service 本实例内存缓存中的活跃对局会话数（按玩法；per-instance 语义）。',
  ['game_type'],
);
export const gameSettleFailuresTotal: CounterOf = createCounter(
  'game_settle_failures_total',
  '局终结算失败计数（phase=settle|publish，按玩法；计数后仍抛出）。',
  ['game_type', 'phase'],
);
```

`GameService`：

```ts
activeSessionCountByGameType(): Record<'doudizhu' | 'paodekuai', number> {
  const out = { doudizhu: 0, paodekuai: 0 };
  for (const session of this.cache.values()) {
    out[normalizeGameType(session.gameType)] += 1;
  }
  return out;
}
```

`publishEnded`：

```ts
let result: SettlementResult;
try {
  result = runtime.settle(session);
} catch (err) {
  incGame(gameSettleFailuresTotal, session.gameType, 1, { phase: 'settle' });
  this.logger.error(`Game settle failed for room ${roomCode} (gameType=${String(session.gameType)}, phase=settle): ${String(err)}`);
  throw err;
}
// buildRecord 不包（内部吞错）
try {
  await this.redis.publish(GAME_EVENTS_CHANNEL, JSON.stringify({ ... }));
} catch (err) {
  incGame(gameSettleFailuresTotal, session.gameType, 1, { phase: 'publish' });
  this.logger.error(`Game ended publish failed for room ${roomCode} (gameType=${String(session.gameType)}, phase=publish): ${String(err)}`);
  throw err;
}
```

`game-metrics.service.ts`：

```ts
for (const [gameType, n] of Object.entries(this.game.activeSessionCountByGameType())) {
  setGame(gamesActive, gameType, n);
}
```

- [ ] **Step 4: 跑绿**

Run: `cd packages/game-service && npx vitest run test/game-metrics.test.ts test/game.service.redis.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/game-service/src/metrics/game.metrics.ts packages/game-service/src/metrics/game-metrics.service.ts packages/game-service/src/game/game.service.ts packages/game-service/test/game-metrics.test.ts packages/game-service/test/game.service.redis.test.ts
git commit -m "feat(game): games_active 与结算失败按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: robot-service

**Files:**
- Modify: `packages/robot-service/src/robot/robot.metrics.ts:59-70`
- Modify: `packages/robot-service/src/robot/robot.service.ts:66-78`
- Modify: `packages/robot-service/src/robot/bot.player.ts:69-79, 118-126`
- Test: `packages/robot-service/test/robot.metrics.test.ts`, `packages/robot-service/test/bot.player.test.ts`, `packages/robot-service/test/bot-pdk.test.ts`

**Interfaces:**
- Produces:
  - `robotDecisionsTotal` labels `result, skill, game_type`
  - `robotDecisionErrorsTotal` labels `reason, game_type`
  - `robotRuleErrorsTotal` labels `game_type, reason`

- [ ] **Step 1: 写失败测试**

先把 `robot.metrics.test.ts` 里的 `series/counterValue` 抽到 `packages/robot-service/test/helpers/metrics.ts`（导出 `counterValue`），供本任务三个测试文件共用。

```ts
// bot.player.test.ts
import { counterValue } from './helpers/metrics';

it('A1：PDK 规则 bot 抛错计 decision_error 并 rethrow', async () => {
  const base = request();
  const pdkBad = {
    ...base,
    view: { ...base.view, gameType: 'paodekuai' },
    features: { gameType: 'doudizhu' }, // feature 形状不符 ⇒ PDK 分支 guard 抛错
  } as never;
  const before = await counterValue('robot_rule_errors_total', {
    game_type: 'paodekuai', reason: 'decision_error',
  });

  const { bot } = makePlayer(async () => [9]);
  await expect(bot.decide(pdkBad)).rejects.toThrow();

  expect(await counterValue('robot_rule_errors_total', {
    game_type: 'paodekuai', reason: 'decision_error',
  })).toBe(before + 1);
});

// robot.metrics.test.ts（服务级：决策收口恰一次）
it('A1：成功决策按 game_type + result + skill 计数', async () => {
  const { service } = makeService(async () => [9]);
  const before = await counterValue('robot_decisions_total', {
    result: 'douzero', skill: 'advanced', game_type: 'doudizhu',
  });
  await service.decide(request());
  expect(await counterValue('robot_decisions_total', {
    result: 'douzero', skill: 'advanced', game_type: 'doudizhu',
  })).toBe(before + 1);
});

it('A1：DouZero 失败按玩法计数（errors 含 game_type）', async () => {
  // 复用本文件“DouZero 失败回落规则”夹具：const { service } = makeService(async () => { throw new Error('timeout'); });
  // 断言 counterValue('robot_decision_errors_total', { reason:'douzero_timeout', game_type:'doudizhu' }) +1
});
```

**既有用例同步**：`counterValue` 的精确键数匹配会让所有旧断言（只有 result/skill 或 reason）读到 0；必须逐条补 `game_type:'doudizhu'`。

- [ ] **Step 2: 跑红** → FAIL。既有 `robot.metrics.test.ts` 的 `counterValue` 要求标签键数完全相等；加 `game_type` 后必须把它改为按 `{result,skill,game_type}` / `{reason,game_type}` 精确匹配。
- [ ] **Step 3: 实现**

`robot.metrics.ts`：

```ts
export const robotDecisionsTotal = createCounter(
  'robot_decisions_total',
  '机器人**完成**的决策次数（result 来源 douzero|rule · skill 难度 · game_type）。DouZero 错误率 = errors/decisions；PDK 规则 bot 错误率 = errors/(decisions+errors)。',
  ['result', 'skill', 'game_type'],
);
export const robotDecisionErrorsTotal = createCounter(
  'robot_decision_errors_total',
  'DouZero 未能给出可用决策的次数（按 reason/玩法；随后回落规则引擎并仍完成决策）。',
  ['reason', 'game_type'],
);
export const robotRuleErrorsTotal = createCounter(
  'robot_rule_errors_total',
  'PDK 规则 bot 决策抛错次数（reason=decision_error，按玩法；抛错不进 decisions）。',
  ['game_type', 'reason'],
);
```

`robot.service.ts`：

```ts
incGame(robotDecisionsTotal, req.view.gameType, 1, {
  result: decision.source,
  skill: req.skillLevel,
});
const model = req.view.gameType === 'paodekuai' ? '-' : this.configCache.modelBySkill()[req.skillLevel];
this.logger.log(
  `Bot ${req.botId} decided ${decision.kind} (source=${decision.source}, model=${model}, cards=${decision.cards?.length ?? 0})`,
);
```

`bot.player.ts` PDK 分支：

```ts
if (view.gameType === 'paodekuai') {
  try {
    if (req.features.gameType !== 'paodekuai' || !('pdkRules' in req.features)) {
      throw new Error(`paodekuai decide requires PdkRobotFeatures (bot ${req.botId})`);
    }
    return decidePdkBot({ ...req, view, features: req.features } as PdkRobotDecideRequest);
  } catch (err) {
    incGame(robotRuleErrorsTotal, 'paodekuai', 1, { reason: 'decision_error' });
    this.logger.error(`PDK rule bot decision failed for bot ${req.botId}: ${String(err)}`);
    throw err;
  }
}
```

DouZero 两处 `robotDecisionErrorsTotal.inc({reason})` 改为 `incGame(..., req.view.gameType, 1, {reason})`。

- [ ] **Step 4: 跑绿**

Run: `cd packages/robot-service && npx vitest run test/robot.metrics.test.ts test/bot.player.test.ts test/bot-pdk.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/robot-service/src/robot/robot.metrics.ts packages/robot-service/src/robot/robot.service.ts packages/robot-service/src/robot/bot.player.ts packages/robot-service/test/robot.metrics.test.ts packages/robot-service/test/bot.player.test.ts packages/robot-service/test/bot-pdk.test.ts
git commit -m "feat(robot): 决策/失败指标按玩法计数，PDK 错误有分母口径
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: user-service（记录清理 / 风控命中）

**Files:**
- Modify: `packages/user-service/src/records/records.metrics.ts:39-56`
- Modify: `packages/user-service/src/records/records-cleanup.service.ts:196-237`
- Modify: `packages/user-service/src/risk/risk.metrics.ts:22-51`
- Modify: `packages/user-service/src/risk/scan.service.ts:355-390`
- Test: `packages/user-service/test/records-cleanup.test.ts`, `packages/user-service/test/risk-scan.test.ts`

**Interfaces:**
- Produces:
  - `recordsRowsDeletedTotal` labels `game_type`
  - `riskScanHitsTotal` labels `game_type`

- [ ] **Step 1: 写失败测试**

```ts
// 先在 records-cleanup.test.ts 定义 labeledMetric（代码见 Step 3）；risk-scan.test.ts 同样复制该 helper
// records-cleanup.test.ts（复用 FakeCleanupDb / runCleanupOnce）
it('A1：记录清理按玩法分别计数（pdk 0 行也写序列）', async () => {
  const db = new FakeCleanupDb();
  db.records.push({ ended_at: new Date(T0 - 400 * DAY_MS) });
  db.records.push({ ended_at: new Date(T0 - 401 * DAY_MS) });
  const { cache } = makeCache({ days: 365 });
  const svc = new RecordsCleanupService(db.dataSource as never, cache);
  const beforeDdz = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' });
  const beforePdk = await labeledMetricByGame('records_rows_deleted_total', { game_type: 'paodekuai' });

  await svc.runCleanupOnce(T0);

  expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' })).toBe(beforeDdz + 2);
  expect(await labeledMetricByGame('records_rows_deleted_total', { game_type: 'paodekuai' })).toBe(beforePdk);
});

// risk-scan.test.ts（复用 mkSvc / db.pdkWinRows / callsByUser）
it('A1：胜率命中按玩法计 risk_scan_hits_total', async () => {
  db.pdkWinRows = [{ user_id: 'u-pdk', games: 101, wins: 90 }];
  const before = await labeledMetricByGame('risk_scan_hits_total', { game_type: 'paodekuai' });

  await mkSvc(makeScanConfig({ pdkMinGames: 100, pdkWinRateThreshold: 0.8 })).runScanOnce(T0);

  expect(await labeledMetricByGame('risk_scan_hits_total', { game_type: 'paodekuai' })).toBe(before + 1);
  expect(await labeledMetricByGame('risk_scan_hits_total', { game_type: 'doudizhu' })).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**

`records.metrics.ts`：

```ts
export const recordsRowsDeletedTotal = createCounter(
  'records_rows_deleted_total',
  '记录清理累计删除的 game_records 行数（按玩法；players 侧删除量见日志行）。',
  ['game_type'],
);
```

`records-cleanup.service.ts`：

```ts
const ddzPlayers = await this.deleteBatches('game_record_players', cutoff);
const pdkPlayers = await this.deleteBatches('game_record_players_pdk', cutoff.getTime());
const ddzRecords = await this.deleteBatches('game_records', cutoff);
const pdkRecords = await this.deleteBatches('game_records_pdk', cutoff.getTime());
const playersDeleted = ddzPlayers + pdkPlayers;
const recordsDeleted = ddzRecords + pdkRecords;
...
incGame(recordsRowsDeletedTotal, 'doudizhu', ddzRecords);
incGame(recordsRowsDeletedTotal, 'paodekuai', pdkRecords);
```

`risk.metrics.ts`：

```ts
export const riskScanHitsTotal = createCounter(
  'risk_scan_hits_total',
  '风控胜率命中次数（按玩法；每用户每玩法命中 +1；设备命中不纳入本指标）。',
  ['game_type'],
);
```

`scan.service.ts`：

```ts
if (ddzHit) incGame(riskScanHitsTotal, 'doudizhu');
if (pdkHit) incGame(riskScanHitsTotal, 'paodekuai');
```

`records-cleanup.test.ts` 的 `simpleMetric('records_rows_deleted_total')` 是“无标签行”正则，会直接抛；改为本文件内的标签感知读数：
```ts
async function labeledMetricByGame(name: string, labels: Record<string, string>): Promise<number> {
  const text = await metricsRegistry().metrics();
  const hit = text.split('\n').find((line) => line.startsWith(`${name}{`) &&
    Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`)));
  return hit ? Number(hit.slice(hit.lastIndexOf(' ') + 1)) : 0;
}
```
既有断言改为 `labeledMetricByGame('records_rows_deleted_total', { game_type: 'doudizhu' })`。`risk-scan.test.ts` 已有 `labeledMetric(name, labelsString)`，新用例统一用 `labeledMetricByGame`（两个文件各定义一份，签名一致），避免重名/对象被拼成 `[object Object]`。

- [ ] **Step 4: 跑绿**

Run: `cd packages/user-service && npx vitest run test/records-cleanup.test.ts test/risk-scan.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add packages/user-service/src/records/records.metrics.ts packages/user-service/src/records/records-cleanup.service.ts packages/user-service/src/risk/risk.metrics.ts packages/user-service/src/risk/scan.service.ts packages/user-service/test/records-cleanup.test.ts packages/user-service/test/risk-scan.test.ts
git commit -m "feat(user): 记录清理与胜率命中按玩法计数
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 告警规则与静态闸

**Files:**
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- Modify: `Dockerfile.prometheus:1`
- Modify: `scripts/verify-monitoring.mjs`
- Test: 运行脚本 + 手工负例

**Interfaces:**
- Produces: 31 条规则；4 条新告警；verify-monitoring 解析告警与 per-target 看板

- [ ] **Step 1: 写失败测试（静态）**

在 `verify-monitoring.mjs` 的 `if (failures.length)` **之前**加入（Step 1/Step 3 两段都在 exit 块之前；追加到文件末尾会成为死代码）：

```js
const ALERT_FILE = join(ROOT, 'deploy/monitoring/prometheus/rules/ftl-alerts.yml');
const EXPECTED_ALERTS = [
  'Watchdog', 'ServiceDown', 'Http5xxRatioHigh', 'Http5xxRatioCritical',
  'HostDiskSpaceLow', 'HostDiskSpaceCritical', 'HostMemoryAvailableLow',
  'WsConnectionsHigh', 'WsConnectionsCritical', 'ContainerRestartFlapping',
  'RecordsCleanupStalled', 'RecordsCleanupFailing', 'AlertDeliveryFailing',
  'CurrencySettleOutboxStuck', 'CurrencyReconcileDrift', 'CurrencyRobotPoolLow',
  'RiskScanStalled', 'MatchPredicateRejectionHigh',
  'PaymentFundOpStalled', 'PaymentNotifyBadSignSpike', 'WithdrawBacklog',
  'PaymentLateNotifyReopen', 'PaymentReconcileDiff',
  'NotifyEmailIncomplete', 'NotifyDingtalkIncomplete',
  'ReliefCallbackBroken', 'ReliefGrantZero',
  'GameStartFailuresHigh', 'GameSettleFailures', 'SettleDroppedByGame', 'RecordWriteFailuresHigh',
];
const alertText = readFileSync(ALERT_FILE, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
const alertNames = [...alertText.matchAll(/^\s*-\s+alert:\s*(\S+)/gm)].map((m) => m[1]);
ok(alertNames.length === EXPECTED_ALERTS.length, `告警规则恰 ${EXPECTED_ALERTS.length} 条（实测 ${alertNames.length}）`);
ok(EXPECTED_ALERTS.every((n) => alertNames.includes(n)), `告警名集齐（缺 ${EXPECTED_ALERTS.filter((n) => !alertNames.includes(n)).join(',') || '无'}）`);
for (const name of ['GameStartFailuresHigh', 'GameSettleFailures', 'SettleDroppedByGame', 'RecordWriteFailuresHigh']) {
  const block = new RegExp(`- alert: ${name}[\\s\\S]*?(?=\\n\\s*- alert:|$)`).exec(alertText)?.[0] ?? '';
  ok(block !== '', `存在 ${name}`);
  ok(/^\s*expr:\s*.*game_type/m.test(block), `${name} 的 expr 含 game_type`);
}
```

Run: `node scripts/verify-monitoring.mjs`
Expected: FAIL（规则数 27 / 新规则缺失）。

- [ ] **Step 2: 加规则**

在 `ftl-alerts.yml` 末尾追加（每条含 runbook）：

```yaml
      # ── 多玩法（2026-10-25 A1）：按玩法分维的开局/结算/记录失败 ─────────────
      - alert: GameStartFailuresHigh
        expr: '(sum by (game_type) (increase(game_start_failures_total[15m])) >= 5) or (sum by (game_type) (increase(game_start_failures_total{reason="cancelled"}[15m])) > 0)'
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.game_type }} 开局失败（15m ≥5 次或有房被取消）'
          runbook: '看 room-service `pdk start failed` / `Failed to start game` 日志的 reason；按 roomCode 追查规则快照/补位/写凭据。'
      - alert: GameSettleFailures
        expr: 'sum by (game_type, phase) (increase(game_settle_failures_total[10m])) > 0'
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: '{{ $labels.game_type }} 局终失败（phase={{ $labels.phase }}）'
          runbook: '看 game-service error 日志（gameType/phase）；settle 失败会让 game.ended 不发布，publish 失败会让 room 收不到终局。'
      - alert: SettleDroppedByGame
        expr: 'sum by (game_type) (increase(currency_settle_result_total{result="dropped"}[10m])) > 0'
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.game_type }} 金币结算被丢弃（10m > 0）'
          runbook: '看 room-service `Currency settle skipped/failed` 的 reason；outbox 超龄放弃与 CurrencySettleOutboxStuck 可能先后响。'
      - alert: RecordWriteFailuresHigh
        expr: '(sum by (game_type, kind) (increase(record_write_failures_total[15m])) >= 3) or (sum by (game_type, kind) (increase(record_write_failures_total{kind="record_lost"}[15m])) > 0)'
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.game_type }} 记录写失败（kind={{ $labels.kind }}）'
          runbook: '看 room-service `Record write failed/skipped`（record）、`moneyDelta` 日志（money_delta）；record_lost 为真实丢记录。'
```

同步头注释：`**31 条 = 28 类**`；`Dockerfile.prometheus:1` 的 `27 条规则` → `31 条规则`。

- [ ] **Step 3: 告警语义断言 + 负例自证**

在 `verify-monitoring.mjs` 的 `if (failures.length)` **之前**（追加到文件末尾会变成死代码）加入关键谓词断言：

```js
const ALERT_PREDICATES = {
  GameStartFailuresHigh: ['reason="cancelled"', '>= 5'],
  GameSettleFailures: ['phase', '> 0'],
  SettleDroppedByGame: ['result="dropped"'],
  RecordWriteFailuresHigh: ['kind="record_lost"', '>= 3'],
};
for (const [name, needles] of Object.entries(ALERT_PREDICATES)) {
  const block = new RegExp(`- alert: ${name}[\\s\\S]*?(?=\\n\\s*- alert:|$)`).exec(alertText)?.[0] ?? '';
  for (const needle of needles) ok(block.includes(needle), `${name} 含关键谓词 ${needle}`);
  ok((alertText.match(new RegExp(`- alert: ${name}\\b`, 'g')) ?? []).length === 1, `${name} 规则名唯一`);
}
```

负例自证（手工执行一次并记录在提交信息里）：
1. 临时删掉 `GameSettleFailures` → 脚本红；
2. 把 `GameStartFailuresHigh` 的 `reason="cancelled"` 删掉 → 脚本红（语义断言，不只看名字/数量）；
3. 还原后脚本绿。

- [ ] **Step 4: 跑绿**

Run: `node scripts/verify-monitoring.mjs`
Expected: `monitoring verify: N checks passed`（N 增加）。

- [ ] **Step 5: 提交**

```bash
git add deploy/monitoring/prometheus/rules/ftl-alerts.yml Dockerfile.prometheus scripts/verify-monitoring.mjs
git commit -m "feat(monitoring): 新增 4 条按玩法告警 + 规则/看板静态闸
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: 看板 JSON

**Files:**
- Modify: `deploy/monitoring/grafana/dashboards/02-business.json`
- Modify: `deploy/monitoring/grafana/dashboards/04-records-backup.json`
- Modify: `deploy/monitoring/grafana/dashboards/05-currency.json`
- Modify: `deploy/monitoring/grafana/dashboards/06-risk.json`
- Modify: `scripts/verify-monitoring.mjs`（per-target 白名单与断言强度）

**Interfaces:**
- Consumes: Task 13 的告警闸
- Produces: 所有 spec §4.4 列出的面板/refId 按玩法分组

- [ ] **Step 1: 改 JSON**（逐 target 的最终值）

| 看板 / 面板 / refId | 新 `expr` | 新 `legendFormat` |
|---|---|---|
| 02 / 匹配队列深度 / A | `sum by (game_type, mode, player_count, base_score) (match_queue_length)` | `{{game_type}} / {{mode}} / {{player_count}}人 / 底分 {{base_score}}` |
| 02 / 活跃房间 / 对局 / A | `sum by (game_type) (rooms_active)` | `{{game_type}}` |
| 02 / 活跃房间 / 对局 / B | `sum by (game_type) (games_active)` | `{{game_type}}` |
| 02 / 活跃房间 / 对局 / C（新增） | `sum(rooms_active)` | `合计房间` |
| 02 / 活跃房间 / 对局 / D（新增） | `sum(games_active)` | `合计对局` |
| 02 / 开局 / 结算速率 / A | `sum by (game_type) (rate(games_started_total[5m]))` | `开局 {{game_type}}` |
| 02 / 开局 / 结算速率 / B | `sum by (game_type) (rate(games_ended_total[5m]))` | `结算 {{game_type}}` |
| 02 / 机器人… / A | `sum by (game_type, result, skill) (rate(robot_decisions_total[5m]))` | `{{game_type}} / {{result}} / {{skill}}` |
| 02 / 机器人… / B | `sum by (game_type, reason) (rate(robot_decision_errors_total[5m]))` | `{{game_type}} 失败：{{reason}}` |
| 02 / 机器人… / C（新增） | `sum by (game_type) (rate(robot_rule_errors_total[5m]))` | `{{game_type}} 规则 bot 失败` |
| 05 / 结算补偿队列最老滞留 / A | `max by (game_type) (currency_settle_outbox_oldest_seconds)` | `{{game_type}} 最老滞留` |
| 05 / 结算结果速率 / A | `sum by (game_type, result) (rate(currency_settle_result_total[5m]))` | `{{game_type}} / {{result}}` |
| 05 / 残差销毁增速 / A | `sum by (game_type) (rate(currency_settle_residue_total[5m]))` | `{{game_type}} 残差销毁` |
| 05 / 机器人补给/回收速率 / A | `sum by (game_type, action) (rate(currency_robot_topup_total[5m]))` | `{{game_type}} / {{action}}` |
| 05 / 机器人 ensure 失败累计 / A | `sum by (game_type) (currency_robot_ensure_failed_total)` | `{{game_type}} 累计失败` |
| 05 / 台费收/漏 / A | `sum by (game_type, reason) (rate(entry_fee_skipped_total[5m]))` | `{{game_type}} 漏收 {{reason}}` |
| 05 / 台费收/漏 / B | `sum by (game_type) (rate(entry_fee_conflict_total[5m]))` | `{{game_type}} 冲突（视为已收）` |
| 04 / 记录删除速率 / A | `sum by (game_type) (rate(records_rows_deleted_total[1h]))` | `{{game_type}} 删除速率` |
| 06 / 谓词拒绝速率 / A | `sum by (game_type, predicate) (rate(match_predicate_rejections_total[5m]))` | `{{game_type}} / {{predicate}}` |
| 06 / 抽选轮与不成组 / A | `sum by (game_type) (rate(match_selection_rounds_total[5m]))` | `{{game_type}} 抽选轮次/s` |
| 06 / 抽选轮与不成组 / B | `sum by (game_type) (rate(match_no_legal_group_total[5m]))` | `{{game_type}} 贪心未成组/s` |
| 06 / 抽选轮与不成组 / C | 保持原平台级 ratio 不变 | 保持原图例 |
| 06 / 风险扫描 / A/B | 保持原样 | 保持原图例 |
| 06 / 风险扫描 / C（新增） | `sum by (game_type) (increase(risk_scan_hits_total[2h]))` | `{{game_type}} 胜率命中（2h）` |

“不改清单”的面板（05 池余额/账户余额/救助、04 表字节、06 待审队列/处置动作）原样不动。

在 `verify-monitoring.mjs` 的 `if (failures.length)` **之前**加入完整 per-target 白名单（覆盖 spec §4.4 全表，含“不改”target；追加到文件末尾是死代码）：

```js
const dashboardTargets = [
  ['02-business.json', '匹配队列深度（按模式/档位）', 'A', 'match_queue_length', true],
  ['02-business.json', '活跃房间 / 对局', 'A', 'rooms_active', true],
  ['02-business.json', '活跃房间 / 对局', 'B', 'games_active', true],
  ['02-business.json', '活跃房间 / 对局', 'C', 'rooms_active', false],
  ['02-business.json', '活跃房间 / 对局', 'D', 'games_active', false],
  ['02-business.json', '开局 / 结算速率', 'A', 'games_started_total', true],
  ['02-business.json', '开局 / 结算速率', 'B', 'games_ended_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'A', 'robot_decisions_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'B', 'robot_decision_errors_total', true],
  ['02-business.json', '机器人决策速率与失败（失败看 errors，别看 rule——叫牌期恒 rule）', 'C', 'robot_rule_errors_total', true],
  ['05-currency.json', '结算补偿队列最老滞留（告警线 300s）', 'A', 'currency_settle_outbox_oldest_seconds', true],
  ['05-currency.json', '结算结果速率（按 result / 5m：ok|replayed|retried|r2|outboxed|dropped）', 'A', 'currency_settle_result_total', true],
  ['05-currency.json', '残差销毁增速', 'A', 'currency_settle_residue_total', true],
  ['05-currency.json', '机器人补给/回收速率（按 action / 5m：refill|recall）', 'A', 'currency_robot_topup_total', true],
  ['05-currency.json', '机器人 ensure 失败累计', 'A', 'currency_robot_ensure_failed_total', true],
  ['05-currency.json', '台费收/漏（按 reason / 5m：insufficient_funds|unknown_outcome|internal_error）', 'A', 'entry_fee_skipped_total', true],
  ['05-currency.json', '台费收/漏（按 reason / 5m：insufficient_funds|unknown_outcome|internal_error）', 'B', 'entry_fee_conflict_total', true],
  ['05-currency.json', '虚拟池余额（告警线 100 万）', 'A', 'currency_robot_pool_balance', false],
  ['05-currency.json', '机器人账户余额总量（僵尸余额通缩观测）', 'A', 'currency_robot_accounts_balance_sum', false],
  ['05-currency.json', '救助速率（按 result / 5m：granted|replayed|rejected）', 'A', 'currency_relief_total', false],
  ['04-records-backup.json', '记录删除速率', 'A', 'records_rows_deleted_total', true],
  ['04-records-backup.json', 'records 表字节', 'A', 'records_table_bytes', false],
  ['06-risk.json', '谓词拒绝速率（按 predicate / 5m：sameDevice|sameIp；记忆拒绝不计）', 'A', 'match_predicate_rejections_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'A', 'match_selection_rounds_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'B', 'match_no_legal_group_total', true],
  ['06-risk.json', '抽选轮与不成组（+ 拒绝率——告警线 0.5）', 'C', 'match_predicate_rejections_total', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'A', 'risk_scan_runs_total', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'B', 'risk_scan_last_success_timestamp_seconds', false],
  ['06-risk.json', '风险扫描（runs 速率 + 距上次成功；RiskScanStalled 告警线 7200s）', 'C', 'risk_scan_hits_total', true],
  ['06-risk.json', '待审队列水位（risk_reviews_open；无自动告警——目视）', 'A', 'risk_reviews_open', false],
  ['06-risk.json', '处置动作速率（按 action / 5m：auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen）', 'A', 'risk_actions_total', false],
];
const dashboards = new Map(
  readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(DIR, f), 'utf8'))]),
);
const byPanel = new Map();
for (const [file, title, refId, metric, expectGameType] of dashboardTargets) {
  const dash = dashboards.get(file);
  const panel = dash?.panels?.find((p) => p.title === title);
  const target = panel?.targets?.find((t) => t.refId === refId);
  ok(target !== undefined, `${file}「${title}」存在 target ${refId}`);
  if (!target) continue;
  const expr = String(target.expr);
  ok(expr.includes(metric), `${file}「${title}」${refId} 引用 ${metric}`);
  if (expectGameType) {
    ok(/by\s*\([^)]*game_type/.test(expr), `${file}「${title}」${refId} 用 by (game_type)（实际：${expr}）`);
  } else {
    ok(!/game_type/.test(expr), `${file}「${title}」${refId} 不应出现 game_type（实际：${expr}）`);
  }
  const key = `${file}\u0000${title}`;
  const expected = byPanel.get(key) ?? new Set();
  expected.add(refId);
  byPanel.set(key, expected);
}
for (const [key, expected] of byPanel) {
  const [file, title] = key.split('\u0000');
  const dash = dashboards.get(file);
  const panel = dash?.panels?.find((p) => p.title === title);
  const actual = new Set((panel?.targets ?? []).map((t) => t.refId));
  ok(
    actual.size === expected.size && [...expected].every((r) => actual.has(r)),
    `${file}「${title}」target refId 集合严格等于白名单（实际 ${[...actual].join(',')}；期望 ${[...expected].join(',')}）`,
  );
}
```

**断言强度**（防 H7 假绿）：
- `expectGameType=true` 时断言 `/by\s*\([^)]*\bgame_type\b/`（不接受 `game_type=~`/`label_replace` 等旁路）；
- `expectGameType=false` 时用 `\bgame_type\b` 整词否定；
- 每个受影响面板的 `targets.map(t=>t.refId)` 集合必须**严格等于**白名单中该面板的 refId 集合（旧聚合 target 不得与新 target 并存）。

- [ ] **Step 2: 跑绿**

Run: `node scripts/verify-monitoring.mjs`
Expected: PASS。

- [ ] **Step 3: 负例自证**

把任一按玩法 target 的 `game_type` 去掉 → 脚本红；还原 → 绿。

- [ ] **Step 4: 提交**

```bash
git add deploy/monitoring/grafana/dashboards/02-business.json deploy/monitoring/grafana/dashboards/04-records-backup.json deploy/monitoring/grafana/dashboards/05-currency.json deploy/monitoring/grafana/dashboards/06-risk.json scripts/verify-monitoring.mjs
git commit -m "feat(monitoring): 业务/记录/货币/风控看板按玩法分组
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: conformance slice-16 / slice-18

**Files:**
- Modify: `tools/conformance/src/slices/slice-16-monitoring.ts:93, 704-705, 767-768, 1152-1249`
- Modify: `tools/conformance/src/slices/slice-18-gold-room.ts:744, 1537-1541, 1575`
- Modify: `tools/conformance/baselines.json`（slice-16 / slice-18）

**Interfaces:**
- Produces: 规则数 31、C11 标签感知 started 断言、slice-18 ended 增量断言

- [ ] **Step 1: 改 slice-16**

- `EXPECTED_RULES` 追加 4 名；
- `:93` 注释、`:704-705`、`:767-768` 的 27 全部改 31 / `EXPECTED_RULES.length`；
- C11 在 `room.match` 前：

```ts
const startedBefore = seriesValue(readNestMetrics(roomSvc), 'games_started_total', { game_type: 'doudizhu' }) ?? 0;
```

局内新增标签感知轮询：

```ts
async function pollSeriesValue(
  read: () => string,
  metric: string,
  labels: Record<string, string>,
  want: (n: number | null) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; last: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  for (;;) {
    last = seriesValue(read(), metric, labels);
    if (want(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

const startedUp = await pollSeriesValue(
  () => readNestMetrics(roomSvc),
  'games_started_total',
  { game_type: 'doudizhu' },
  (n) => n !== null && n >= startedBefore + 1,
  30_000,
);
checks.that(startedUp.ok, `C11：games_started_total{game_type="doudizhu"} ≥ 基线+1（${startedBefore} → ${startedUp.last}）`);
```

- [ ] **Step 2: 改 slice-18**

- **F 组 `runGoldGame` 之前（E 组结束后）**取基线（E 自己也打完一局；若在 E 前取，E 会满足 +1，F 丢事件也绿）：

```ts
const gamesEndedBefore = seriesValue(readRoomMetrics(), 'games_ended_total', { game_type: 'doudizhu' }) ?? 0;
```

- F 组结束后有界轮询：

```ts
let endedNow: number | null = null;
const endedDeadline = Date.now() + 30_000;
for (;;) {
  endedNow = seriesValue(readRoomMetrics(), 'games_ended_total', { game_type: 'doudizhu' });
  if (endedNow !== null && endedNow >= gamesEndedBefore + 1) break;
  if (Date.now() >= endedDeadline) break;
  await sleep(1_000);
}
checks.that(
  endedNow !== null && endedNow >= gamesEndedBefore + 1,
  `H：games_ended_total{game_type="doudizhu"} ≥ 基线+1（${gamesEndedBefore} → ${endedNow}）`,
);
```

- `terminalSettles` 改为按 `result` 对多序列求和（H12）：

```ts
function sumMetricWhere(text: string, name: string, labels: Record<string, string>): number {
  return parseProm(text)
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
}

const terminalSettles =
  sumMetricWhere(roomMetrics, 'currency_settle_result_total', { result: 'ok' }) +
  sumMetricWhere(roomMetrics, 'currency_settle_result_total', { result: 'replayed' });
```

- 若 slice-18 的 `H room-service /metrics 含 ...` 清单需要同步断言 outbox 两族仍在，不变。
- outbox 读数：

```ts
const outboxSize = sumMetric(roomMetrics, 'currency_settle_outbox_size');
const outboxOldest = sumMetric(roomMetrics, 'currency_settle_outbox_oldest_seconds');
```

- `:1575` 条件+消息 27 → 31。

- [ ] **Step 3: 更新 baselines**

`slice-16` 断言数 +1（`pollSeries` 一条）→ 87；`slice-18` +1 → 151。若本机无真栈，按源内静态计数回填并在提交信息注明“待权威轮校正”。

- [ ] **Step 4: 编译**

Run: `cd tools/conformance && npx tsc --noEmit`
Expected: 0。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance/src/slices/slice-16-monitoring.ts tools/conformance/src/slices/slice-18-gold-room.ts tools/conformance/baselines.json
git commit -m "test(conformance): 规则数 31 + 按玩法 started/ended 断言
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: slice-30 PDK 指标真栈 + 公共解析助手

**Files:**
- Create: `tools/conformance/src/lib/prom-text.ts`
- Create: `tools/conformance/src/slices/slice-30-pdk-metrics.ts`
- Modify: `tools/conformance/src/run.ts:46, 121`
- Modify: `tools/conformance/baselines.json`

**Interfaces:**
- Consumes: `INTERNAL_TOKEN`（`lib/http.ts`）、`startPdkRoom/playPdkToEnd`（`lib/pdk-driver.ts`）、`adminLogin/adminPutConfig`、`registerUser`
- Produces:
  - `parseProm(text): Array<{name, labels, value}>`
  - `seriesValueExact(text, name, labels): number | null`
  - `sumMetric(text, name): number`
  - `execCurl(container, port, token, path?): { status, body }`

- [ ] **Step 1: 写 lib**

```ts
// tools/conformance/src/lib/prom-text.ts
import { spawnSync } from 'node:child_process';

export interface PromSample { name: string; labels: Record<string, string>; value: number; }

export function parseProm(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? ([-+0-9.eE]+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(part);
        if (kv) labels[kv[1]!] = kv[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const value = Number(m[3]);
    out.push({ name: m[1]!, labels, value: Number.isFinite(value) ? value : NaN });
  }
  return out;
}

export function seriesValueExact(text: string, name: string, want: Record<string, string>): number | null {
  const hits = parseProm(text).filter(
    (s) => s.name === name &&
      Object.keys(s.labels).sort().join('\u0000') === Object.keys(want).sort().join('\u0000') &&
      Object.entries(want).every(([k, v]) => s.labels[k] === v),
  );
  if (hits.length > 1) throw new Error(`seriesValueExact 命中多条 ${name} ${JSON.stringify(want)}`);
  return hits[0]?.value ?? null;
}

export function sumMetric(text: string, name: string): number {
  return parseProm(text)
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
}

export function execCurl(container: string, port: number, token: string, path = '/metrics'): { status: number; body: string } {
  const out = spawnSync('docker', [
    'exec', container, 'curl', '-s', '-w', '\n__STATUS__%{http_code}',
    '-H', `Authorization: Bearer ${token}`,
    `http://127.0.0.1:${port}${path}`,
  ], { encoding: 'utf8', timeout: 30_000 });
  const m = /__STATUS__(\d+)\s*$/.exec(out.stdout ?? '');
  return { status: m ? Number(m[1]) : 0, body: (out.stdout ?? '').replace(/__STATUS__\d+\s*$/, '') };
}
```

- [ ] **Step 2: 写 slice-30**

```ts
// tools/conformance/src/slices/slice-30-pdk-metrics.ts
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { INTERNAL_TOKEN, adminLogin, adminPutConfig, postJson, registerUser } from '../lib/http';
import { playPdkToEnd, startPdkRoom } from '../lib/pdk-driver';
import { execCurl, seriesValueExact } from '../lib/prom-text';

const PDK_ENABLED_KEY = 'game.paodekuai.enabled';
const ROOM_SERVICE = { container: 'ftl-room-service', port: 9002 } as const;

async function enablePdk(): Promise<() => Promise<void>> {
  const admin = await adminLogin();
  const disable = async () => {
    for (const key of ['game.paodekuai.friendRoomEnabled', PDK_ENABLED_KEY]) {
      const off = await adminPutConfig(key, false, admin);
      if (off.body?.code !== ErrCode.OK) throw new ConformanceError(`还原 ${key} 失败`);
    }
  };
  try {
    // 探测走 `POST /api/rooms` ⇒ controller 先查好友房开关；PDK 好友房种子是 false。
    for (const [key, value] of [
      [PDK_ENABLED_KEY, true],
      ['game.paodekuai.friendRoomEnabled', true],
    ] as const) {
      const put = await adminPutConfig(key, value, admin);
      if (put.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`开启 ${key} 失败：${JSON.stringify(put.body)}`);
      }
    }
    // 与 slice-29 不同的账号序号（90 已被 slice-29 的探针占用，复用会撞 12011 等待房）
    const probeUser = await registerUser(95);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const probe = await postJson('/api/rooms', { mode: 'random', gameType: 'paodekuai', playerCount: 3 }, probeUser.accessToken);
      if (probe.body?.code === ErrCode.OK) break;
      if (Date.now() >= deadline) throw new ConformanceError(`game.paodekuai.enabled=true 60s 内未生效`);
      await sleep(1_000);
    }
  } catch (err) {
    await disable().catch(() => undefined); // 部分失败也要先还原再抛
    throw err;
  }
  return disable;
}

export async function runSlice30(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const disable = await enablePdk();
  try {
    const readMetrics = () => execCurl(ROOM_SERVICE.container, ROOM_SERVICE.port, INTERNAL_TOKEN);
    const startedBefore = seriesValueExact(readMetrics().body, 'games_started_total', { game_type: 'paodekuai' }) ?? 0;
    const endedBefore = seriesValueExact(readMetrics().body, 'games_ended_total', { game_type: 'paodekuai' }) ?? 0;

    step('① 开 PDK ⇒ 匹配开局 ⇒ games_started_total{game_type="paodekuai"} 增量');
    const room = await startPdkRoom('S30');
    let started: number | null = null;
    const startedDeadline = Date.now() + 30_000;
    for (;;) {
      started = seriesValueExact(readMetrics().body, 'games_started_total', { game_type: 'paodekuai' });
      if (started !== null && started >= startedBefore + 1) break;
      if (Date.now() >= startedDeadline) break;
      await sleep(1_000);
    }
    checks.that(started !== null && started >= startedBefore + 1, `started = ${started}（基线 ${startedBefore}）`);

    step('② 打到终局 ⇒ games_ended_total{game_type="paodekuai"} 增量');
    await playPdkToEnd(room, 'S30 一局');
    let ended: number | null = null;
    const endedDeadline = Date.now() + 30_000;
    for (;;) {
      ended = seriesValueExact(readMetrics().body, 'games_ended_total', { game_type: 'paodekuai' });
      if (ended !== null && ended >= endedBefore + 1) break;
      if (Date.now() >= endedDeadline) break;
      await sleep(1_000);
    }
    checks.that(ended !== null && ended >= endedBefore + 1, `ended = ${ended}（基线 ${endedBefore}）`);
    info(`slice-30：started ${startedBefore}→${started} · ended ${endedBefore}→${ended}`);
  } finally {
    await disable();
  }
  return { passed: checks.passed };
}
```

- [ ] **Step 3: 注册切片与基线**

`run.ts`：

```ts
import { runSlice30 } from './slices/slice-30-pdk-metrics';
// CASES 末尾：
'slice-30-pdk-metrics': { title: '跑得快指标（真栈：按玩法 started/ended）', run: runSlice30 },
```

`baselines.json` 的 `full` 增加 `"slice-30-pdk-metrics": 2`（两条 `checks.that`；无其他断言）。提交信息注明“源内静态计数，待权威轮校正”。

- [ ] **Step 4: 编译**

Run: `cd tools/conformance && npx tsc --noEmit`
Expected: 0。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance/src/lib/prom-text.ts tools/conformance/src/slices/slice-30-pdk-metrics.ts tools/conformance/src/run.ts tools/conformance/baselines.json
git commit -m "test(conformance): slice-30 PDK 指标真栈（按玩法 started/ended）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: 文档、源码闸与全量验证

**Files:**
- Modify: `docs/ops/first-deploy.md`（如有告警类别清单/outbox 查询说明）
- Modify: `docs/ops/entry-fee-reconcile.md`（如有单序列读数）
- Test: 源码闸（room-service / game-service 各一份）+ 各包标签声明测试

- [ ] **Step 1: 源码闸 + 标签声明测试**

`packages/room-service/test/metrics-game-type-invariant.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGETS = [
  'gamesStartedTotal', 'gamesEndedTotal', 'roomsActive', 'gamesActive',
  'currencySettleResultTotal', 'currencySettleResidueTotal',
  'currencySettleOutboxSize', 'currencySettleOutboxOldestSeconds',
  'entryFeeSkippedTotal', 'entryFeeConflictTotal',
  'currencyRobotTopupTotal', 'currencyRobotEnsureFailedTotal',
  'matchPredicateRejectionsTotal', 'matchSelectionRoundsTotal', 'matchNoLegalGroupTotal',
  'recordsRowsDeletedTotal', 'robotDecisionsTotal', 'robotDecisionErrorsTotal',
  'robotRuleErrorsTotal', 'riskScanHitsTotal',
  'gameStartFailuresTotal', 'gameSettleFailuresTotal',
  'recordWriteFailuresTotal', 'recordWriteSkipsTotal',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('A1 源码闸：指标写点必须经 incGame/setGame', () => {
  it('src 下不得直接对目标指标 .inc()/.set()', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'packages'))) {
      if (file.includes('/test/') || file.endsWith('.test.ts')) continue;
      // 先剥注释，避免注释里的示例误报
      const src = readFileSync(file, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const name of TARGETS) {
        // 覆盖 .inc( / .set( / .labels( / ?.inc( 等直写形态
        if (new RegExp(`\\b${name}\\s*\\??\\s*\\.\\s*(inc|set|labels)\\b`).test(src)) {
          offenders.push(`${file.replace(ROOT, '')}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

`packages/game-service/test/metrics-game-type-invariant.test.ts`：同上但只列 `gamesActive` / `gameSettleFailuresTotal`（game-service 的源码树单独扫，避免跨包路径耦合）。

**标签声明校验**（每个包在自己的指标定义测试里做）：对本片改造的每个指标调用一次 `incGame(metric, 'paodekuai')`；若该指标未声明 `game_type` labelName，prom-client 会抛 `Added label ... is not included in initial labelset` ⇒ 测试红。room/game/robot/user 各自的指标定义测试各覆盖本包指标。

- [ ] **Step 2: 文档**

- `docs/ops/first-deploy.md`：告警类别清单补 4 条；注明 `currency_settle_outbox_*` 现在按玩法多条序列，查询用 `sum by (game_type)` 或 `sum()`。
- `docs/ops/entry-fee-reconcile.md`：若查询单序列，改为按玩法分组。

- [ ] **Step 3: 全量验证**

```bash
pnpm --filter @fight-the-landlord/shared build
pnpm exec turbo run test lint --force
cd tools/conformance && npx tsc --noEmit
cd ../.. && node scripts/verify-monitoring.mjs && node scripts/verify-admin-static.mjs
```

Expected: 全部 0 退出；记录测试文件/用例数。`turbo run test lint --force` 覆盖各包测试类型检查（`tsconfig.test.json`）；Cached 不算真跑。

- [ ] **Step 4: 工作区检查**

Run: `git status --porcelain`
Expected: 仅剩用户已有的 `apps/client/src/components/PdkSettlement.vue`（不得提交）。本片 spec/plan/实现均已各自提交；若 spec 仍有未提交改动，先单独提交再进本任务。

- [ ] **Step 5: 提交**

```bash
git add docs/ops packages/room-service/test/metrics-game-type-invariant.test.ts packages/game-service/test/metrics-game-type-invariant.test.ts
git commit -m "docs+test(monitoring): 告警/查询口径文档 + registry 标签不变量
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 计划自检（写完后的覆盖核对）

- [x] spec §4.1 指标矩阵 → Task 2/5/6/7/8/9/10/11/12
- [x] spec §4.2 失败/跳过计数器 → Task 2/3/4/5/10/11
- [x] spec §4.3 告警 → Task 13
- [x] spec §4.4 看板 → Task 14
- [x] spec §4.5 静态闸/conformance → Task 13/15/16
- [x] spec §4.6 单测 → 各任务
- [x] spec §5 边界语义 → Task 6/9 + 全局约束
- [x] spec §7 文件清单 → Task 1–17
- [x] 类型一致性：`incGame(counter, gameType, amount?, labels?)` / `setGame(gauge, gameType, value)` / `exactSeriesValue(metric, labels)` / `seriesValueExact(text, name, labels)` 全计划一致。


---

## 计划审查记录（2026-10-25，独立 reviewer）

结论：**需修订后再开工**（6 阻断 / 14 高）。修订如下：

| 编号 | 发现 | 处置 |
|---|---|---|
| B1 | `incGame` 泛型 cast 走错 prom-client 重载，Task 1 tsc 必红 | 改为 `(counter as Counter<string>).inc(values, amount)` / `(gauge as Gauge<string>).set(values, value)` |
| B2 | 台费两指标三个写点未改，源码闸必红 | Task 3 补 `chargeOne` / `recordEntryFeeSkip` 三处 `incGame` + entry-fee 测试 |
| B3 | `endedGameType` 跨方法引用（TS2304） | Task 4 记录 catch 内改用 `this.resolveGameEventType(event)` |
| B4 | slice-30 探测建房被 PDK 好友房闸拦 12006 | enable 同时开 `friendRoomEnabled`，finally 还原；探针账号换序号 |
| B5 | slice-18 outbox 读错 metrics 源（currency-service），断言恒真 | 改用 `roomMetrics` |
| B6 | settle 参数贯穿缺调用点清单 + `beforeRoom` 死变量 | 已列 9 个 drop*/read/apply 调用点、`resolveSeats` 传参；删除 `beforeRoom` |
| H1 | shared 未 build，跨包测试 import 失败 | 全局约束加 `pnpm --filter @fight-the-landlord/shared build` |
| H2/H13 | 测试步骤大量注释占位/夹具不存在 | 新增「Fixture 手册」逐任务给出夹具与造场景方式；补 reason 覆盖 |
| H3 | match 有 5 处 inc 不是 3 处 | Task 8 改为 5 处 + 2 个调用点 |
| H4 | 既有 `values[0]`/子集读数 | Task 3/4/7/8/9/10/11/12 各自列明同步改造 |
| H5 | 坏 outbox 条目语义与 spec 冲突 | Task 6 坏条目归 ddz + WARN |
| H6 | 看板闸在 Task 13 先于看板改动 | 看板白名单整体移到 Task 14 |
| H7 | per-target 断言只看 substring | 改为 `by (game_type)` 正则 + refId 集合严格相等 |
| H8 | slice-18 基线在 E 前，F 丢失也绿 | 基线移到 F 前 |
| H9 | 残差断言恒真 | 改 before/after 精确增量（夹具增量为 0） |
| H10 | 全局约束与 `match_queue_length` 矛盾；源码闸可绕过 | 显式豁免 `match_queue_length`；源码闸剥注释并覆盖 `.labels(`/`?.` |
| H11 | 验证命令不覆盖测试类型检查；工作区期望过期 | 改用 `turbo run test lint --force`；注明 spec/plan 已提交 |
| H12 | slice-18 `terminalSettles` 仍取首条 | 新增 `sumMetricWhere` 按 result 求和 |
| H14 | 告警闸只查名字/存在性 | 增加关键谓词与阈值断言 |
