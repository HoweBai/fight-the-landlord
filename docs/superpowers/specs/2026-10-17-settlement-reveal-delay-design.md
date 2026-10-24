# 终局结算延迟展示（2 秒）设计 · v2（对抗审查后修订）

- 日期：2026-10-17
- 状态：**对抗审查已通过并修订**（两轮审查记录见 §9）
- 范围：纯客户端；不碰协议、服务端与「终局亮牌」
- 关联：用户反馈「打出最后一手后结算立刻挡住牌桌，看不到最后一手」

## 1. 问题与目标

服务端在终局先下发 `game.state_update`（`state === 'ended'`，含最后一手），紧接着下发
`game.settlement`。客户端 `table.vue` 当前以 `v-if="store.settlement"` 立即挂载
`.table__scrim` 与 `<Settlement>` ⇒ 结算瞬间盖住牌桌。

**审查纠正（阻断项 B1）**：不能笼统说「最后一手已在出牌区」——
- **对手**的最后一手不受状态门控（`table.vue` 的左右出牌列只看 `leftAction/rightAction`），
  ended 下仍渲染；
- **我自己**的最后一手分支条件是 `store.isPlaying && myAction && myAction.cards`，
  而 `isPlaying` 在 ended 恒为 false ⇒ **玩家自己打出最后一手时，终局牌桌上根本看不到它**。
  这恰恰是用户反馈的主场景。

目标：

1. 终局 `state === 'ended'` 时，**我自己**的最后一手也渲染在 `.table__my-play`。
2. `game.settlement` 到达后先让牌桌完整停留 **2 秒**，再压暗并弹出结算面板。
3. 延迟窗口内不出现「可见可点但没反应」的控件（含键盘/读屏可达性）。

## 2. 范围

### 本期做

- ended 视图渲染我自己的最后一手（纯客户端，只读 `recentActions`，不读 `winner`）。
- 客户端终局结算延迟展示：`game.settlement` 到达后 2000ms 才渲染遮罩与结算面板。
- 延迟窗口内「更多 / 记牌器」保持可用；揭示瞬间触发器与面板一起离开 DOM，并复位开态。
- `store.settlement !== null` 时立即禁用/移除出牌、过牌、提示、叫抢动作与手牌交互
  （防止 ended 视图缺失/迟到时 2 秒窗口内仍可发请求）。
- 结算页金币列「5 秒定格」保持**从 settlement 到达起算的绝对 5 秒**（传到达时刻给面板）。
- 延迟按 settlement **首次到达时间**计算剩余；重进/重连不重新计满 2 秒。
- 相应测试、类型检查与注释同步。

### 本期不做

- 对手剩余手牌亮牌（需改 `PlayerView`、服务端裁剪、conformance 与反作弊评审）——另立片。
- 结算面板内增加「最后一手」摘要（用户裁决：本期只延迟）。
- 服务端延迟下发 `game.settlement`。
- 结算胜负音效延迟（保持即时；见 D4）。

## 3. 决策

| 编号 | 裁决 | 理由 |
|---|---|---|
| D1 | 延迟时长 **2000ms**，从 settlement **首次被客户端感知**起算（正常即牌桌页内到达；重进/重连按剩余时间计算，不重新计满） | 用户裁决；足够看清最后一手，又不明显拖慢节奏 |
| D2 | 新增 `useSettlementReveal()`，返回 `{ revealed, receivedAt }` | 时序逻辑独立可测；`receivedAt` 供金币列 5s 契约使用 |
| D3 | 延迟期间更多/记牌器**可用**；揭示瞬间**触发器与面板一起 `v-if` 移除**，并复位 `moreOpen/counterOpen` | 修死按钮：指针、键盘、读屏都不可达；`aria-expanded` 不再说谎 |
| D4 | 胜负音效仍在 settlement 到达时立即播放 | 结果先到、牌面停留；`audio.test.ts` 已有即时守卫 |
| D5 | 就地错误条 / 会话 notice 仍在 settlement 到达时立即清掉 | 避免错误条在遮罩后露边 |
| D6 | 金币列 5s 定格**保持绝对 5s**：`Settlement` 新增可选 `settlementReceivedAt`，挂载时用剩余时间起表 | 不改 `docs/design.md` / `docs/client-protocol.md` 的 5s 契约；2s 延迟不把兜底拖成 7s |
| D7 | 重进/重连时按 settlement 首次到达时间计算剩余；已过 2s 则立即揭示 | 与 D1 一致；避免「看过结算后重进又等 2s」 |
| D8 | 测试延迟覆写独立成小模块；延迟用例用 `__reset` 验证**生产默认值**，不用 `__set(2000)` | 防止「只验证测试覆写、生产默认被改也绿」 |
| D9 | ended 分支优先渲染我的最后一手；窗口里没有我的动作时仍显示「本局结束」 | 主场景可见；不破坏既有 ended 空夹具断言 |
| D10 | `store.settlement !== null` 即门控动作行与手牌交互（不等揭示） | ended 视图缺失/迟到时，2s 窗口不得暴露可发请求的 UI |
| D11 | 已揭示后同一 settlement 再次到达不重新隐藏 | 防闪烁；新局必须先经 `reset()` 的 null 态 |
| D12 | 计时器住在 `src/composables/**`，不得写进 `table.vue` / `Settlement.vue` | 牌桌区「不新造时钟」机械闸（`useGoldColumnFreeze` 同款落点） |

## 4. 实现设计

### 4.1 延迟模块

新增 `apps/client/src/composables/settlementRevealDelay.ts`：

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

**源码闸**：`src/**` 不得 import 两个 `__` 测试函数（新增机械断言）。

### 4.2 `useSettlementReveal()`

新增 `apps/client/src/composables/useSettlementReveal.ts`：

```ts
import { onScopeDispose, ref, watch } from 'vue';
import { useGameStore } from '../stores/game';
import { getSettlementRevealDelayMs } from './settlementRevealDelay';

/**
 * settlement 对象 → 首次到达时间。WeakMap 跨页面卸载存活（同一 JS 运行时），
 * 重进页面时据此计算剩余延迟，而不是重新计满。
 */
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
      // 已揭示：同一 settlement 的重复对象/重挂载不得重新隐藏（D11）。
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

- 监听默认 `flush: 'pre'`；测试必须在推消息后 `await nextTick()` 再推进时钟。
- 重进页面：同一 settlement 对象的 `arrivals` 命中，剩余时间 = `2000 - elapsed`。
- settlement 置 null（`reset()`）⇒ 清表、复位、`receivedAt=null`。
- 已揭示后新 settlement 对象：保持可见（D11）；新局应经 null 态。

### 4.3 `table.vue` 接线

**延迟与揭示**

```ts
const { revealed: settlementRevealed, receivedAt: settlementReceivedAt } =
  useSettlementReveal();

watch(settlementRevealed, (revealed) => {
  if (!revealed) return;
  moreOpen.value = false;
  counterOpen.value = false;
});
```

**遮罩与结算面板**

```vue
<view v-if="store.settlement && settlementRevealed" class="table__scrim" />
<Settlement
  v-if="store.settlement && settlementRevealed"
  :settlement="store.settlement"
  :settlement-received-at="settlementReceivedAt ?? undefined"
  @again="onAgain"
  @back="auth.navigate('lobby')"
/>
```

**入口与面板（D3）**

```vue
<!-- 顶栏右段 -->
<button v-if="!settlementRevealed" type="button" class="btn btn--small table__more" @click="moreOpen = true">
  更多
</button>

<MoreMenu v-if="moreOpen && !settlementRevealed" ... />

<!-- 顶栏左段 -->
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

揭示瞬间触发器与面板同时离开 DOM ⇒ 指针/键盘/读屏都不可达。

**我自己的最后一手（D9）**

把 ended 分支改为：

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

- 只读 `recentActions` / `myAction`，不读 `winner`（M07）。
- 窗口里没有我的动作时保持原「本局结束」形态（`table-ended-ui` 空夹具不破）。
- 对手的最后一手仍在各自出牌列渲染（不依赖 `isPlaying`）。

**动作与手牌 fail-safe（D10）**

- 叫抢我的回合：`store.isBidding && store.isMyTurn && !store.settlement`。
- 出牌我的回合：`store.isPlaying && store.isMyTurn && !store.settlement`。
- 我的上一手 / 我的「不出」：追加 `!store.settlement`（避免 settlement 已到但 ended 视图未到时仍显示旧动作）。
- 出牌期等待文案前补一支：`store.isPlaying && store.settlement` ⇒ `.table__ended`「本局结束」。
- 手牌：`<Hand ... :interactive="store.settlement === null" />`。

**注释同步**

- `table.vue` 的 `moreOpen` / `counterOpen` 注释、scrim 与面板注释、`.table__my-play` 注释、
  `.table__scrim` 的「同生共灭」说明，全部改为「settlement **揭示**」语义。
- `CardCounter.vue` 头注释的门控说明同步（组件本身不读 settlement，仍由宿主控制）。

### 4.4 `Settlement.vue` 金币列 5s 契约（D6）

```ts
const props = defineProps<{
  settlement: SettlementResult;
  /** settlement 到达时刻（毫秒时间戳）；缺省 ⇒ 从本组件挂载起算满 5s。 */
  settlementReceivedAt?: number;
}>();

const goldFreezeDelayMs =
  props.settlementReceivedAt === undefined
    ? GOLD_FREEZE_MS
    : Math.max(0, GOLD_FREEZE_MS - (Date.now() - props.settlementReceivedAt));

const goldFrozen = useGoldColumnFreeze({
  active: showGold,
  arrived: computed(() => store.settlementBalances !== null),
  delayMs: goldFreezeDelayMs,
});
```

- 直接挂载 `Settlement` 的既有测试不传 prop ⇒ 保持 5s。
- 表级：settlement t=0 到达、t=2000 面板挂载 ⇒ 剩余 3000ms；总计仍是从 settlement 起 5s 定格。

### 4.5 测试环境

`apps/client/test/setup.ts`：

```ts
import { beforeEach } from 'vitest';
import { __setSettlementRevealDelayForTest } from '../src/composables/settlementRevealDelay';
import { __resetSettlementRevealArrivalsForTest } from '../src/composables/useSettlementReveal';

beforeEach(() => {
  __setSettlementRevealDelayForTest(0);
  __resetSettlementRevealArrivalsForTest();
});
```

- 既有结算用例保持「立即出现」。
- 延迟用例：先 `__resetSettlementRevealDelayForTest()`（用生产默认 2000），
  `vi.useFakeTimers()` → mount/push → `await nextTick()` → advance → `await nextTick()`；
  `finally` 中 `vi.useRealTimers()` + `__setSettlementRevealDelayForTest(0)`。
- **已知限制**：`vi.resetModules()` 会重建模块图，全局 0 覆写不传递给新实例；
  结算类测试不得使用 `vi.resetModules()`，或在重新 import 后显式置 0。写入 spec 登记。

## 5. 测试判据

### 5.1 核心场景（阻断项 B1）

新建 `apps/client/test/settlement-reveal.test.ts`（假时钟、生产默认延迟）：

1. 推入 `state:'ended'`、`mySeat` 本人打出最后一手的 `recentActions`，再推 `game.settlement`；
   - 0ms / 1999ms：`.table__scrim`、`.table__settlement`、`.settlement__again`、
     `.settlement__lobby` 都不在 DOM；
   - 同一时刻：`.table__my-play` **在 DOM**，且卡片文本/数量逐字等于夹具（按槽位限定，
     不用通用 `.table__played-slot`，防对手槽位假绿）；
   - 2000ms：scrim 与结算面板同时出现，`.table__more` / `.table__counter` /
     `.table__more-mask` / `.counter` 都不在 DOM。
2. 对手打出最后一手：对手槽位仍渲染最后一手（正对照）。
3. ended 且窗口里没有我的动作：`.table__ended`「本局结束」仍在（回归 `table-ended-ui`）。

### 5.2 延迟窗口内入口可用（D3）

4. settlement 到达后（0–1999ms）点「更多」⇒ 弹层出现；推进 2000ms ⇒ 弹层与触发器
   同时不在 DOM，结算面板在 DOM；`moreOpen` 已复位（清除 settlement 后不自动重现）。
5. 记牌器同样：打开横条 → 推 settlement → 0/1999ms 横条仍在 → 2000ms 横条与触发器都不在 DOM。

### 5.3 动作 fail-safe（D10）

6. 只推 `playing` 视图 + `game.settlement`（**不推 ended 视图**）：
   - `.table__play` / `.table__pass` / `.table__hint` / `.table__bid-grab` 不在 DOM；
   - `Hand` 的交互禁用（选牌不改变 `selected` 或按钮不出现）；
   - 不产生 `game.play` / `game.pass` 请求。

### 5.4 5s 金币契约（D6）

7. 表级假时钟：settlement t=0 → 推进 2000（面板出现，三行「结算中…」）→
   推进 2999 ⇒ 仍「结算中…」→ 再推进 1 ⇒ 三行「—」（总计 5s）。
8. 延迟窗口内 `game.balances` 到达（t=1000）⇒ t=2000 面板挂载即显真值，不出现「结算中…」。

### 5.5 重进 / 重复 / 清理

9. 同一 settlement：挂载 → 推进 1000 → 卸载/重挂 → 推进 999 仍不揭示、再推进 1 揭示
   （剩余时间而非重新计满）。
10. 已揭示后同一 settlement 对象再次进入 watch ⇒ 不重新隐藏（D11）。
11. 定时器清理：`effectScope` 包裹 composable，卸载后 `vi.getTimerCount()` 回到基线，
    推进时钟不再改 `revealed`。
12. 生产默认值：`SETTLEMENT_REVEAL_DELAY_MS === 2000`（辅助断言）；
    主判据是 §5.1 用 `__reset` + 假时钟的行为。

### 5.6 机械闸与回归

13. 源码闸：`src/**` 不得 import `__setSettlementRevealDelayForTest` /
    `__resetSettlementRevealDelayForTest`。
14. 回归：`table-ended-ui.test.ts`、`table-play-ui.test.ts`（我的上一手分支改动）、
    `more-menu.test.ts`、`card-counter.test.ts`、`table-settlement-ui.test.ts`、
    `animations.test.ts`、`audio.test.ts`（即时音效守卫）。
15. 全量 `apps/client` 测试 + `vue-tsc --noEmit`。

## 6. 错误处理与边界

- settlement 与 ended state_update 顺序：服务端先 state_update 后 settlement
  （`game.service.ts` / `ws.gateway.ts`），同一 WebSocket 保序；客户端仍按 D10 做 fail-safe。
- ended 视图缺失/迟到：2s 窗口内显示「本局结束」，动作与手牌已禁用。
- 页面卸载：`onScopeDispose` 清定时器；`arrivals` WeakMap 随对象回收，不泄漏。
- 连接断开：连接浮层（z-index 20）优先；恢复后按已揭示状态显示。
- 返回大厅/结算返回：既有行为不变（不清 settlement）；若重连把玩家拉回牌桌，
  按剩余时间揭示（D7）。
- 胜负音效即时：保留 `audio.test.ts` 的即时守卫；这是有意的「结果先到」通道。
- 遮罩堆叠：揭示时触发器已从 DOM 移除，不再依赖「scrim 是否盖住顶栏」来防死按钮。

## 7. 风险

1. `arrivals` 以 settlement 对象为键；若服务端以**新对象**重发同一局结算，可能重新计 2s。
   已用 `revealed` 短路（已揭示不重置）；未揭示前视为一次新的到达，可接受。
2. `Date.now()` 受系统时钟回拨影响；只用于展示延迟，不参与规则判定。
3. 2s 的实际可读性需真机走查；时长是用户裁决，不在本设计重议。
4. 对手剩余手牌仍需另立片（协议 + 反作弊评审）。
5. 金币剩余窗口在面板 setup 时按「此刻剩余」算一次；若 `showGold` 在挂载后才翻真
   （迟到的 state_update 带余额），定格可能略晚于 settlement+5s。主路径（join ack 已有余额）
   不受影响，登记为已知边界。

## 8. 涉及文件

- 新增：`apps/client/src/composables/settlementRevealDelay.ts`
- 新增：`apps/client/src/composables/useSettlementReveal.ts`
- 新增：`apps/client/test/settlement-reveal.test.ts`
- 修改：`apps/client/src/pages/table/table.vue`
- 修改：`apps/client/src/components/Settlement.vue`
- 修改：`apps/client/test/setup.ts`
- 验证：`apps/client/test/table-ended-ui.test.ts`（空窗口「本局结束」回归；无需改动）
- 验证：`apps/client/test/table-play-ui.test.ts`（ended 夹具无冲突；无需改动）
- 修改：`apps/client/test/more-menu.test.ts`（揭示语义 + 延迟窗口）
- 修改：`apps/client/test/card-counter.test.ts`（延迟窗口 + 揭示让位）
- 修改：`apps/client/test/table-settlement-ui.test.ts`（绝对 5s + 延迟内余额到达）
- 源闸/回归：`apps/client/test/settlement-reveal.test.ts` 内扫描测试函数使用
- 提交与验证：按根 `CLAUDE.md`，每个任务单独提交并运行对应测试,
  最终 `pnpm -C apps/client test` + `pnpm -C apps/client run lint`。

## 9. 审查记录

### 第一轮：设计自审（2026-10-17）

| 编号 | 结论 | 处置 |
|---|---|---|
| P1 | 延迟窗口内更多/记牌器成死按钮 | v2 D3：延迟期间可用，揭示时触发器+面板一起移除 |
| P2 | 测试延迟覆写是可变生产 API | v2 D8：独立模块 + 校验 + 源码闸 + 全局复位 |
| P2 | 5s 兜底变 7s | v2 D6：传 `settlementReceivedAt`，保持绝对 5s |
| P2 | 重进重新计 2s | v2 D7：WeakMap 记录首次到达，按剩余时间揭示 |

### 第二轮：独立对抗审查（子代理，2026-10-17）

| 编号 | 级别 | 结论 | 处置 |
|---|---|---|---|
| B1 | 阻断 | 玩家自己打出最后一手时，ended 下我的出牌区被 `isPlaying` 挡住 ⇒ 核心场景不成立 | v2 D9：ended 分支渲染 `.table__my-play`；§5.1 用本人最后一手作主判据 |
| B2 | 阻断 | 死按钮只修了指针对；键盘/读屏仍可达触发器，`aria-expanded` 说谎 | v2 D3：触发器与面板一起 `v-if`；揭示时复位开态；§5.2 覆盖 |
| H1 | 高 | 5s→7s 与 `docs/design.md` / `client-protocol.md` 契约冲突，且无测试 | v2 D6：保持绝对 5s；§5.4 新增表级 5s 用例 |
| H2 | 高 | 测试假绿口：用 `__set(2000)` 而非生产默认；缺 CardCounter 用例；假时钟顺序不明；`vi.resetModules` 绕过覆写；选择器可能命中对手槽位 | v2 D8 / §4.5 / §5.1 / §5.2 / §5.6 逐条修正 |
| H3 | 高 | ended 视图缺失时，2s 窗口仍渲染可发请求的动作行与可交互手牌 | v2 D10：settlement 非空即门控动作与手牌；§5.3 覆盖 |
| H4 | 高 | 遮罩盖住顶栏是未测试的 CSS 不变量 | v2 D3 从 DOM 移除触发器，不再依赖堆叠；§5.2 断言触发器不在 DOM |
| H5 | 高 | 重进/重连重新计 2s，且返回大厅不清 settlement | v2 D7：按首次到达计算剩余；返回大厅行为登记为既有不变 |
| H6 | 高 | 第二个 settlement 对象会让已显示面板重新隐藏 | v2 D11：已揭示短路；§5.5 覆盖 |
| H7 | 高 | 定时器清理无测试 | v2 §5.5 用 `effectScope` + `vi.getTimerCount()` 覆盖 |
| H8 | 高 | 即时音效与延迟揭示的取舍未钉住 | v2 D4 明确保留即时音效，引用 `audio.test.ts` 守卫 |
| L1 | 低 | 注释/测试名过期 | §8 列出同步点；实现时逐处更新 |
| L2 | 低 | `__set` 缺校验、测试函数可能被 src import | §4.1 增加有限非负校验 + §5.6 源码闸 |
| L3 | 低 | `settlement-rematch.test.ts` 实际无需改动 | §8 标为「验证」 |
| L4 | 低 | 计时器放 `src/composables` 是合规落点，避免误判 | D12 登记 |
| L5 | 低 | M07 保持成立 | `settlementRevealed` 只延迟；末手只读 `recentActions`，不读 `winner` |

### 第三轮：实现代码审查（子代理，2026-10-17）

| 编号 | 级别 | 结论 | 处置 |
|---|---|---|---|
| C1 | 重要 | 生产默认值 `delayMs` 的**模块初值**从未被观测——`__reset` 也会把错误初值改回常量，全量测试可全绿 | 测试模块顶层捕获 `INITIAL_DELAY_MS`，断言为 2000 |
| C2 | 次要 | ended + 我「不出」无用例，`v-if="myAction"` 变异不会被抓 | 新增 ended + `cards: null` 用例 |
| C3 | 次要 | `.table__scrim` 只断言延迟窗口内不存在，未断言揭示时出现 | 1999ms 不存在 / 2000ms 存在 |
| C4 | 次要 | fail-safe 的「不发请求」断言恒真，未尝试点击 | 点击禁用卡后断言无 `.card--selected`、无 `game.play` |
| C5 | 次要 | 源码闸无正对照、可被 namespace/dynamic 形态绕过 | 改为裸标识符 + 排除定义文件 + 三种正对照 |
| C6 | 次要 | 对手最后一手断言未限定左右槽位 | 断言 `.table__play-col--right` 恰为 `['10','10']`，左列为空 |
| C7 | 次要 | 金币剩余窗口在 setup 只算一次 | 主路径不受影响；§7-5 登记为已知边界，不在本片阻塞 |
| C8 | 流程 | spec 的 arrivals 复位同步未提交 | 随本轮审查修复一并提交 |
