# 终局结算延迟展示（2 秒）实现计划 · v2（计划对抗审查后修订）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终局先停留 2 秒展示最后一手（含玩家自己的最后一手），再显示结算；修复延迟窗口内的死按钮与可发请求的 UI。

**Architecture:** 新增 `settlementRevealDelay`（可测试的延迟值）与 `useSettlementReveal`（WeakMap 记录 settlement 首次到达，按剩余时间揭示）。`table.vue` 用 `settlementRevealed` 控制遮罩/结算/入口；ended 分支补渲染 `myAction`；settlement 非空即门控动作与手牌。`Settlement.vue` 接收 `settlementReceivedAt` 保持金币列绝对 5 秒。

**Tech Stack:** Vue 3 / Pinia / Vitest / Vue Test Utils / TypeScript

## Global Constraints

- 纯客户端：不改 `packages/protocol`、`packages/game-service`、`packages/room-service`。
- 不读取 `settlement.winner` 渲染最后一手（M07）。
- 计时器只能放在 `src/composables/**`，不得写进 `table.vue` / `Settlement.vue`。
- `tsconfig` 开启 `noUnusedLocals`：每个任务只导入本任务用到的标识符。
- 每个任务结束运行对应测试并提交；所有提交信息末尾附：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 最终验证：`pnpm -C apps/client test` + `pnpm -C apps/client run lint`。

---

### Task 1: 延迟模块 + useSettlementReveal + 测试环境

**Files:**
- Create: `apps/client/src/composables/settlementRevealDelay.ts`
- Create: `apps/client/src/composables/useSettlementReveal.ts`
- Modify: `apps/client/test/setup.ts`
- Test: `apps/client/test/settlement-reveal.test.ts`（本任务只写单元部分）

**Interfaces:**
- Produces: `SETTLEMENT_REVEAL_DELAY_MS = 2000`；`getSettlementRevealDelayMs(): number`；
  `__setSettlementRevealDelayForTest(ms: number): void`；`__resetSettlementRevealDelayForTest(): void`；
  `useSettlementReveal(): { revealed: Ref<boolean>; receivedAt: Ref<number | null> }`；
  `__resetSettlementRevealArrivalsForTest(): void`。

- [ ] **Step 1: 写失败测试（单元部分）**

新建 `apps/client/test/settlement-reveal.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SettlementResult } from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';
import {
  SETTLEMENT_REVEAL_DELAY_MS,
  __resetSettlementRevealDelayForTest,
  __setSettlementRevealDelayForTest,
  getSettlementRevealDelayMs,
} from '../src/composables/settlementRevealDelay';
import {
  useSettlementReveal,
  __resetSettlementRevealArrivalsForTest,
} from '../src/composables/useSettlementReveal';

const FIXTURE: SettlementResult = {
  roomCode: 'ROOM01',
  baseScore: 100,
  winner: 'landlord',
  landlordSeat: 2,
  farmerSeats: [0, 1],
  multiplier: 4,
  spring: 'spring',
  landlordScoreChange: 777,
  farmerScoreChange: -388.5,
};

function settlement(): SettlementResult {
  return { ...FIXTURE };
}

function mountComposable() {
  const scope = effectScope();
  const api = scope.run(() => useSettlementReveal())!;
  return { scope, ...api };
}

describe('useSettlementReveal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    __resetSettlementRevealArrivalsForTest();
    // D8：用 __reset 验证生产默认值，不用 __set(常量)（后者会掩盖模块初值被改错）。
    __resetSettlementRevealDelayForTest();
    expect(getSettlementRevealDelayMs()).toBe(SETTLEMENT_REVEAL_DELAY_MS);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __setSettlementRevealDelayForTest(0);
  });

  it('生产默认 2000ms：1999ms 不揭示，2000ms 揭示', async () => {
    const store = useGameStore();
    const { revealed } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(revealed.value).toBe(false);

    vi.advanceTimersByTime(1999);
    await nextTick();
    expect(revealed.value).toBe(false);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(revealed.value).toBe(true);
  });

  it('重挂载按剩余时间：1000ms 后卸载，重挂再等 999ms 不揭示、1ms 揭示', async () => {
    const store = useGameStore();
    store.settlement = settlement();

    const first = mountComposable();
    await nextTick();
    vi.advanceTimersByTime(1000);
    first.scope.stop();

    const second = mountComposable();
    await nextTick();
    vi.advanceTimersByTime(999);
    await nextTick();
    expect(second.revealed.value).toBe(false);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(second.revealed.value).toBe(true);
  });

  it('已揭示后同一 settlement 的副本再次进入 watch ⇒ 不重新隐藏', async () => {
    const store = useGameStore();
    const s = settlement();
    const { revealed } = mountComposable();
    store.settlement = s;
    await nextTick();
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(revealed.value).toBe(true);

    store.settlement = { ...s };
    await nextTick();
    expect(revealed.value).toBe(true);
  });

  it('settlement 置 null ⇒ 复位 revealed/receivedAt 并清表', async () => {
    const store = useGameStore();
    const { revealed, receivedAt } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(receivedAt.value).not.toBeNull();

    store.settlement = null;
    await nextTick();
    expect(revealed.value).toBe(false);
    expect(receivedAt.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('scope 停止 ⇒ 清定时器，推进时钟不再改 revealed', async () => {
    const store = useGameStore();
    const { scope, revealed } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);

    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(revealed.value).toBe(false);
  });

  it('测试覆写校验：负数 / NaN / Infinity 抛错', () => {
    expect(() => __setSettlementRevealDelayForTest(-1)).toThrow(/finite and >= 0/);
    expect(() => __setSettlementRevealDelayForTest(Number.NaN)).toThrow(/finite and >= 0/);
    expect(() => __setSettlementRevealDelayForTest(Number.POSITIVE_INFINITY)).toThrow(
      /finite and >= 0/,
    );
  });

  it('常量值恰为 2000（辅助断言）', () => {
    expect(SETTLEMENT_REVEAL_DELAY_MS).toBe(2000);
  });
});
```

注意：本任务**不导入** `mount` / `FakeSocket` / `makeCards`——它们在 Task 2/3 首次使用时再加入，
避免 `noUnusedLocals` 在任务边界报红。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现延迟模块**

`apps/client/src/composables/settlementRevealDelay.ts`：

```ts
/** 终局结算延迟展示时长（生产默认值；用户裁决 2000ms）。 */
export const SETTLEMENT_REVEAL_DELAY_MS = 2000;

let delayMs = SETTLEMENT_REVEAL_DELAY_MS;

export function getSettlementRevealDelayMs(): number {
  return delayMs;
}

/** 仅供测试：覆写延迟（0 = 立即揭示）。有限、非负。 */
export function __setSettlementRevealDelayForTest(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`settlement reveal delay must be finite and >= 0 (got ${ms})`);
  }
  delayMs = ms;
}

/** 仅供测试：恢复生产默认值。 */
export function __resetSettlementRevealDelayForTest(): void {
  delayMs = SETTLEMENT_REVEAL_DELAY_MS;
}
```

- [ ] **Step 4: 实现 composable**

`apps/client/src/composables/useSettlementReveal.ts`：

```ts
import { onScopeDispose, ref, watch } from 'vue';
import { useGameStore } from '../stores/game';
import { getSettlementRevealDelayMs } from './settlementRevealDelay';

/** settlement 对象 → 首次到达时间；WeakMap 跨页面卸载存活。 */
let arrivals = new WeakMap<object, number>();

/** 仅供测试：清空到达时间缓存（WeakMap 无法 clear，直接换新实例）。 */
export function __resetSettlementRevealArrivalsForTest(): void {
  arrivals = new WeakMap();
}

export function useSettlementReveal() {
  const store = useGameStore();
  const revealed = ref(false);
  const receivedAt = ref<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  watch(
    () => store.settlement,
    (settlement) => {
      if (!settlement) {
        clear();
        revealed.value = false;
        receivedAt.value = null;
        return;
      }
      let t0 = arrivals.get(settlement);
      if (t0 === undefined) {
        t0 = Date.now();
        arrivals.set(settlement, t0);
      }
      receivedAt.value = t0;
      if (revealed.value) return;
      const remaining = Math.max(0, getSettlementRevealDelayMs() - (Date.now() - t0));
      clear();
      if (remaining <= 0) {
        revealed.value = true;
        return;
      }
      timer = setTimeout(() => {
        revealed.value = true;
        timer = null;
      }, remaining);
    },
    { immediate: true },
  );

  onScopeDispose(clear);
  return { revealed, receivedAt };
}
```

- [ ] **Step 5: 测试环境默认 0ms**

`apps/client/test/setup.ts` 追加：

```ts
import { beforeEach } from 'vitest';
import { __setSettlementRevealDelayForTest } from '../src/composables/settlementRevealDelay';
import { __resetSettlementRevealArrivalsForTest } from '../src/composables/useSettlementReveal';

beforeEach(() => {
  __setSettlementRevealDelayForTest(0);
  __resetSettlementRevealArrivalsForTest();
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/composables/settlementRevealDelay.ts \
  apps/client/src/composables/useSettlementReveal.ts \
  apps/client/test/setup.ts apps/client/test/settlement-reveal.test.ts
git commit -m "feat(client): 结算揭示延迟 composable（按首次到达计算剩余）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: table.vue 延迟揭示 + 入口门控

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Test: `apps/client/test/settlement-reveal.test.ts`（集成部分）
- Test: `apps/client/test/more-menu.test.ts`、`apps/client/test/card-counter.test.ts`（语义/注释）

**Interfaces:**
- Consumes: Task 1 的 `useSettlementReveal()`。

- [ ] **Step 1: 补 import 与文件级脚手架**

在 `settlement-reveal.test.ts` 顶部追加：

```ts
import { mount, type VueWrapper } from '@vue/test-utils';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';
```

在测试文件顶层（unit describe 之外）加入：

```ts
let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable() {
  const socket = new FakeSocket();
  // 🔴 顺序：先 setActivePinia（文件级 beforeEach），再 startGameSession。
  // 反了会让 createSessionOptions 在无 active pinia 时抛，或把消息写进旧 store。
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}
```

- [ ] **Step 2: 写失败测试**

追加：

```ts
it('延迟窗口内更多/记牌器可用；揭示时触发器与面板一起离开 DOM', async () => {
  __resetSettlementRevealDelayForTest();
  __resetSettlementRevealArrivalsForTest();
  vi.useFakeTimers();
  try {
    const { wrapper, socket, store } = mountTable();
    store.cardCounterEnabled = true;
    socket.push(
      serverMessage('game.state_update', playerViewFixture({ state: 'playing', version: 2 }), 2),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    // 0ms：两个入口仍可用
    expect(wrapper.find('.table__more').exists()).toBe(true);
    await wrapper.find('.table__more').trigger('click');
    expect(wrapper.find('.table__more-mask').exists()).toBe(true);
    await wrapper.find('.table__counter').trigger('click');
    expect(wrapper.find('.counter').exists()).toBe(true);
    expect(wrapper.find('.table__settlement').exists()).toBe(false);

    // 1999ms：仍可用，结算仍未出现
    vi.advanceTimersByTime(1999);
    await nextTick();
    expect(wrapper.find('.table__more-mask').exists()).toBe(true);
    expect(wrapper.find('.counter').exists()).toBe(true);
    expect(wrapper.find('.table__settlement').exists()).toBe(false);

    // 2000ms：面板、触发器、横条一起消失
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find('.table__more-mask').exists(), '揭示时弹层卸载').toBe(false);
    expect(wrapper.find('.table__more').exists(), '揭示时更多触发器卸载').toBe(false);
    expect(wrapper.find('.table__counter').exists(), '揭示时记牌器触发器卸载').toBe(false);
    expect(wrapper.find('.counter').exists(), '揭示时记牌器横条卸载').toBe(false);
    expect(wrapper.find('.table__settlement').exists()).toBe(true);

    // 开态已复位：清除 settlement 后弹层/横条不得自动重现
    store.settlement = null;
    await nextTick();
    expect(wrapper.find('.table__more-mask').exists(), 'moreOpen 已复位').toBe(false);
    expect(wrapper.find('.counter').exists(), 'counterOpen 已复位').toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts`
Expected: FAIL（settlement 立即出现 / 触发器仍在）

- [ ] **Step 4: 实现**

`table.vue`（`watch` 已在文件内导入，无需新增）：

```ts
import { useSettlementReveal } from "../../composables/useSettlementReveal";
...
const { revealed: settlementRevealed, receivedAt: settlementReceivedAt } =
  useSettlementReveal();

watch(settlementRevealed, (revealed) => {
  if (!revealed) return;
  moreOpen.value = false;
  counterOpen.value = false;
});
```

模板：

```vue
<view v-if="store.settlement && settlementRevealed" class="table__scrim" />
<Settlement
  v-if="store.settlement && settlementRevealed"
  :settlement="store.settlement"
  :settlement-received-at="settlementReceivedAt ?? undefined"
  @again="onAgain"
  @back="auth.navigate('lobby')"
/>

<button
  v-if="!settlementRevealed"
  type="button"
  class="btn btn--small table__more"
  @click="moreOpen = true"
>
  更多
</button>

<MoreMenu v-if="moreOpen && !settlementRevealed" ... />

<button
  v-if="store.cardCounterEnabled && !settlementRevealed"
  type="button"
  class="btn btn--small table__counter"
  :aria-expanded="counterOpen"
  @click="counterOpen = !counterOpen"
>
  记牌器
</button>

<CardCounter v-if="counterOpen && !settlementRevealed" />
```

更新注释：`moreOpen` / `counterOpen` / scrim / MoreMenu / CardCounter 的让位语义统一为
「settlement **揭示**」。

- [ ] **Step 5: 更新既有测试名/注释**

- `more-menu.test.ts` ④：测试名/注释改为「结算**揭示**即让位」；断言值不变。
- `card-counter.test.ts` 结算让位用例：同样改为「揭示即让位」；断言值不变。

- [ ] **Step 6: 运行测试**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts test/more-menu.test.ts test/card-counter.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/pages/table/table.vue apps/client/test/settlement-reveal.test.ts \
  apps/client/test/more-menu.test.ts apps/client/test/card-counter.test.ts
git commit -m "feat(table): 结算延迟揭示，入口在揭示时与面板一起让位

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ended 渲染我的最后一手 + 动作/手牌 fail-safe

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Test: `apps/client/test/settlement-reveal.test.ts`
- Regression: `apps/client/test/table-ended-ui.test.ts`、`table-play-ui.test.ts`、`action-feedback.test.ts`、`table-play-area-window.test.ts`

- [ ] **Step 1: 补 import**

在 `settlement-reveal.test.ts` 的 helper import 中加入 `makeCards`：

```ts
import { FakeSocket, makeCards, playerViewFixture, serverMessage } from './helpers/fake-socket';
```

- [ ] **Step 2: 写失败测试**

追加：

```ts
it('核心场景：我自己打出最后一手 ⇒ 2s 内 .table__my-play 仍在，结算不出现', async () => {
  __resetSettlementRevealDelayForTest();
  __resetSettlementRevealArrivalsForTest();
  vi.useFakeTimers();
  try {
    const { wrapper, socket, store } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'ended',
          version: 2,
          seat: 0,
          recentActions: [{ seat: 0, cards: makeCards(9, 9) }],
        }),
        2,
      ),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    expect(store.isEnded).toBe(true);
    expect(wrapper.find('.table__scrim').exists()).toBe(false);
    expect(wrapper.find('.table__settlement').exists()).toBe(false);
    expect(wrapper.find('.settlement__again').exists()).toBe(false);
    expect(wrapper.find('.settlement__lobby').exists()).toBe(false);
    expect(
      wrapper.findAll('.table__my-play .card').map((c) => c.attributes('data-value')),
      '我的最后一手（按槽位限定，不数对手槽位）',
    ).toEqual(['9', '9']);

    vi.advanceTimersByTime(1999);
    await nextTick();
    expect(wrapper.find('.table__my-play').exists()).toBe(true);
    expect(wrapper.find('.table__settlement').exists()).toBe(false);
    expect(wrapper.find('.settlement__again').exists()).toBe(false);
    expect(wrapper.find('.settlement__lobby').exists()).toBe(false);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find('.table__settlement').exists()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('对手打出最后一手：对手槽位仍渲染最后一手（正对照）', async () => {
  const { wrapper, socket } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({
        state: 'ended',
        version: 2,
        seat: 0,
        recentActions: [{ seat: 1, cards: makeCards(10, 10) }],
      }),
      2,
    ),
  );
  await nextTick();
  expect(
    wrapper.findAll('.table__play-col .card').map((c) => c.attributes('data-value')),
  ).toContain('10');
});

it('ended 且窗口里没有我的动作 ⇒ 仍显示「本局结束」', async () => {
  const { wrapper, socket } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({ state: 'ended', version: 2, seat: 0, recentActions: [] }),
      2,
    ),
  );
  await nextTick();
  expect(wrapper.find('.table__ended').text()).toBe('本局结束');
  expect(wrapper.find('.table__my-play').exists()).toBe(false);
});

it('fail-safe：settlement 已到但 ended 视图缺失 ⇒ 动作行不渲染、手牌禁用、不发请求', async () => {
  const { wrapper, socket, store } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({
        state: 'playing',
        version: 2,
        seat: 0,
        currentPlayer: 0,
        hand: makeCards(3, 4, 5),
      }),
      2,
    ),
  );
  await nextTick();
  socket.push(serverMessage('game.settlement', FIXTURE, 3));
  await nextTick();

  expect(wrapper.find('.table__play').exists()).toBe(false);
  expect(wrapper.find('.table__pass').exists()).toBe(false);
  expect(wrapper.find('.table__hint').exists()).toBe(false);
  expect(wrapper.find('.table__ended').exists()).toBe(true);
  expect(wrapper.findAll('.table__me .card--disabled')).toHaveLength(store.hand.length);
  expect(socket.emittedOf('game.play')).toHaveLength(0);
  expect(socket.emittedOf('game.pass')).toHaveLength(0);
});

it('fail-safe：settlement 到达时我的上一手/不出回显也必须消失', async () => {
  const { wrapper, socket } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({
        state: 'playing',
        version: 2,
        seat: 0,
        recentActions: [{ seat: 0, cards: makeCards(9) }],
      }),
      2,
    ),
  );
  await nextTick();
  socket.push(serverMessage('game.settlement', FIXTURE, 3));
  await nextTick();

  expect(wrapper.find('.table__my-play').exists()).toBe(false);
  expect(wrapper.find('.table__ended').exists()).toBe(true);
});

it('fail-safe：settlement 到达时我的「不出」回显也必须消失', async () => {
  const { wrapper, socket } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({
        state: 'playing',
        version: 2,
        seat: 0,
        recentActions: [{ seat: 0, cards: null }],
      }),
      2,
    ),
  );
  await nextTick();
  socket.push(serverMessage('game.settlement', FIXTURE, 3));
  await nextTick();

  expect(wrapper.find('.table__my-pass').exists()).toBe(false);
  expect(wrapper.find('.table__ended').exists()).toBe(true);
});
```

叫抢态的 fail-safe 并入睡牌用例（若 `playerViewFixture` 的 `bidPhase` 默认不是我的回合，
显式覆盖）：

```ts
it('fail-safe：settlement 到达时叫抢按钮也不渲染', async () => {
  const { wrapper, socket } = mountTable();
  socket.push(
    serverMessage(
      'game.state_update',
      playerViewFixture({
        state: 'bidding',
        version: 2,
        seat: 0,
        bidPhase: {
          currentBidder: 0,
          bidMultiplier: 1,
          landlordCandidate: -1,
          grabActions: 0,
          redealCount: 0,
          kind: 'call',
          decisions: [],
        },
      }),
      2,
    ),
  );
  await nextTick();
  socket.push(serverMessage('game.settlement', FIXTURE, 3));
  await nextTick();

  expect(wrapper.find('.table__bid-grab').exists()).toBe(false);
  expect(wrapper.find('.table__bid-pass').exists()).toBe(false);
  expect(wrapper.find('.table__ended').exists()).toBe(true);
  expect(socket.emittedOf('game.bid')).toHaveLength(0);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts`
Expected: FAIL（ended 下 `.table__my-play` 不存在 / 动作行仍在）

- [ ] **Step 4: 实现**

1. ended 分支替换：

```vue
<template v-else-if="store.isEnded">
  <PlayArea
    v-if="myAction && myAction.cards"
    class="table__my-play"
    :cards="myAction.cards"
  />
  <text v-else class="table__ended">本局结束</text>
</template>
```

2. 在 ended 分支之后插入通用兜底（覆盖 bidding/playing + settlement 且 ended 视图缺失）：

```vue
<text v-else-if="store.settlement" class="table__ended">本局结束</text>
```

3. 动作门控：
   - 叫抢我的回合：`v-if="store.isBidding && store.isMyTurn && !store.settlement"`。
   - 叫抢等待：`v-else-if="store.isBidding && !store.settlement"`。
   - 出牌我的回合：`v-else-if="store.isPlaying && store.isMyTurn && !store.settlement"`。
   - 我的上一手：`v-else-if="store.isPlaying && !store.settlement && myAction && myAction.cards"`。
   - 我的「不出」：`v-else-if="store.isPlaying && !store.settlement && myPassEcho"`。
   - 其余等待：`v-else-if="store.isPlaying"`。
   - 通用兜底必须在 ended 之后、出牌分支之前（否则被后面的分支抢先）。

4. 手牌：

```vue
<Hand
  :cards="store.hand"
  :interactive="store.settlement === null"
  ...
/>
```

5. 更新 `.table__my-play` 注释：同时服务 playing（我刚出的牌）与 ended（我的最后一手）。

- [ ] **Step 5: 运行测试与回归**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts test/table-ended-ui.test.ts test/table-play-ui.test.ts test/action-feedback.test.ts test/table-play-area-window.test.ts`
Expected: PASS

若 `table-play-ui` 的 ended 夹具继承了我的 recentAction 导致多出 `.table__my-play`，
按新语义更新断言；不得删除「ended + 空 recentActions ⇒ 本局结束」的覆盖。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/pages/table/table.vue apps/client/test/settlement-reveal.test.ts \
  apps/client/test/table-ended-ui.test.ts apps/client/test/table-play-ui.test.ts
git commit -m "fix(table): ended 渲染我的最后一手；settlement 到达即门控动作与手牌

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 金币列绝对 5 秒

**Files:**
- Modify: `apps/client/src/components/Settlement.vue`
- Test: `apps/client/test/table-settlement-ui.test.ts`

- [ ] **Step 1: 补 import 与失败测试**

`table-settlement-ui.test.ts` 顶部追加：

```ts
import {
  __resetSettlementRevealDelayForTest,
  __setSettlementRevealDelayForTest,
} from '../src/composables/settlementRevealDelay';
import { __resetSettlementRevealArrivalsForTest } from '../src/composables/useSettlementReveal';
```

追加用例：

```ts
it('延迟揭示不拖长金币兜底：settlement t=0，面板 t=2s 挂载，总计 5s 定格', async () => {
  vi.useFakeTimers();
  __resetSettlementRevealDelayForTest();
  __resetSettlementRevealArrivalsForTest();
  try {
    const { wrapper, socket, store } = mountTable(0);
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0, balance: 1000 },
        { id: 'p1', seat: 1, balance: 2000 },
        { id: 'p2', seat: 2, balance: 3000 },
      ],
    });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(2000);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
      '结算中…', '结算中…', '结算中…',
    ]);

    vi.advanceTimersByTime(2999);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
      '结算中…', '结算中…', '结算中…',
    ]);

    vi.advanceTimersByTime(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual(['—', '—', '—']);
  } finally {
    vi.useRealTimers();
    __setSettlementRevealDelayForTest(0);
  }
});

it('延迟窗口内 balances 到达 ⇒ 面板挂载即显真值，不出现「结算中…」', async () => {
  vi.useFakeTimers();
  __resetSettlementRevealDelayForTest();
  __resetSettlementRevealArrivalsForTest();
  try {
    const { wrapper, socket, store } = mountTable(0);
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0, balance: 1000 },
        { id: 'p1', seat: 1, balance: 2000 },
        { id: 'p2', seat: 2, balance: 3000 },
      ],
    });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(1000);
    await wrapper.vm.$nextTick();
    socket.push(
      serverMessage(
        'game.balances',
        {
          balances: [
            { seat: 0, balance: 111 },
            { seat: 1, balance: 222 },
            { seat: 2, balance: 333 },
          ],
        },
        3,
      ),
    );
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(1000);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
      '333', '111', '222',
    ]);
  } finally {
    vi.useRealTimers();
    __setSettlementRevealDelayForTest(0);
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/client && pnpm exec vitest run test/table-settlement-ui.test.ts`
Expected: FAIL（金币列定格时点不符）

- [ ] **Step 3: 实现**

`Settlement.vue`：

```ts
import { GOLD_FREEZE_MS, useGoldColumnFreeze } from '../composables/useGoldColumnFreeze';

const props = defineProps<{
  settlement: SettlementResult;
  /** settlement 到达时刻（毫秒时间戳）；缺省 ⇒ 从本组件挂载起算满 5s。 */
  settlementReceivedAt?: number;
}>();

const goldFreezeDelayMs =
  props.settlementReceivedAt === undefined
    ? GOLD_FREEZE_MS
    : Math.min(
        GOLD_FREEZE_MS,
        Math.max(0, GOLD_FREEZE_MS - (Date.now() - props.settlementReceivedAt)),
      );

const goldFrozen = useGoldColumnFreeze({
  active: showGold,
  arrived: computed(() => store.settlementBalances !== null),
  delayMs: goldFreezeDelayMs,
});
```

更新注释：5s 契约从 settlement 到达起算；2s 延迟揭示不改变总时长。

- [ ] **Step 4: 运行测试**

Run: `cd apps/client && pnpm exec vitest run test/table-settlement-ui.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/Settlement.vue apps/client/test/table-settlement-ui.test.ts
git commit -m "fix(settlement): 金币列 5s 定格从 settlement 到达起算

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 源码闸 + 全量回归

**Files:**
- Test: `apps/client/test/settlement-reveal.test.ts`
- Verify: 全量 `apps/client`

- [ ] **Step 1: 写源码闸（只匹配 import/export-from，排除定义处）**

追加：

```ts
import { collectSourceFiles, stripComments } from './helpers/source-scan';

it('源码闸：src/** 不得 import 测试专用延迟函数（定义文件本身不算）', () => {
  const IMPORT_OF_TEST_HOOK =
    /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\b__(?:setSettlementRevealDelayForTest|resetSettlementRevealDelayForTest|resetSettlementRevealArrivalsForTest)\b[^}]*\}\s*from\s*['"]/;
  const offenders = collectSourceFiles()
    .filter((f) => f.path.startsWith('src/'))
    .filter((f) => IMPORT_OF_TEST_HOOK.test(stripComments(f.content)))
    .map((f) => f.path);
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: 运行源码闸**

Run: `cd apps/client && pnpm exec vitest run test/settlement-reveal.test.ts`
Expected: PASS

- [ ] **Step 3: 全量回归**

Run: `cd apps/client && pnpm test`
Expected: 全部 PASS（既有 skip 除外）

Run: `cd apps/client && pnpm run lint`
Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add apps/client/test/settlement-reveal.test.ts
git commit -m "test(client): 结算延迟源码闸与全量回归

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证

- [ ] `pnpm -C apps/client test`
- [ ] `pnpm -C apps/client run lint`
- [ ] `git status --short`（确认无未提交改动）
- [ ] 汇总：延迟行为、最后一手主场景、入口可达性、金币 5s、重进剩余时间、动作 fail-safe

## 计划审查记录（2026-10-17，独立对抗审查）

| 编号 | 结论 | 处置 |
|---|---|---|
| B1 | 源码闸正则命中定义处，Step 2 必红 | 改为只匹配 import/export-from（Task 5） |
| B2 | 缺 `__reset*` / `makeCards` / `GOLD_FREEZE_MS` import；`stopGameSession` 未使用 | 逐任务补齐 import；`stopGameSession` 用于文件级 afterEach |
| B3 | `startGameSession` 先于 `setActivePinia`；无 unmount/afterEach ⇒ 首条红、后续 push 抛 | 文件级 beforeEach/afterEach + `mounted` 数组 + 正确顺序（Task 2） |
| B4 | 金币期望值 `['33','11','22']` 错 | 改为 `['333','111','222']`（Task 4） |
| H1 | 单元 beforeEach 用 `__set(常量)` 掩盖默认值 | 改用 `__reset` + `getSettlementRevealDelayMs()` 断言（Task 1） |
| H2 | `moreOpen/counterOpen` 复位断言缺失 | 揭示后清 settlement，断言不自动重现（Task 2） |
| H3 | 记牌器横条延迟窗口未测 | 0/1999/2000ms 三态断言（Task 2） |
| H4 | bid / 请求 / 我的上一手/不出 门控未测 | 补充 bidding+settlement、recentActions 两态、emittedOf 断言（Task 3） |
| H5 | bidding + settlement 显示等待语；通用兜底缺失 | 叫抢等待加 `!settlement`；ended 后加通用 `v-else-if="store.settlement"`（Task 3） |
| H6 | 0/1999ms 未显式断言结算按钮不在 DOM | 已补 `.settlement__again/.settlement__lobby`（Task 3） |
| L1 | 提交信息缺 attribution | 五个提交全部补齐 |
| L2 | 欠 Infinity 校验 | 已补 |
| L3 | 金币延迟未封顶 | `Math.min(GOLD_FREEZE_MS, …)` |
