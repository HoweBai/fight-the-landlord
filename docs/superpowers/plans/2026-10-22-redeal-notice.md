# 重新发牌可感知化 实现计划

> 对应 spec：`docs/superpowers/specs/2026-10-22-redeal-notice-design.md`
> 分支：`dev` · 纯客户端 · 2026-10-22

## Global Constraints

- **纯客户端**：不改 `packages/**`、`services`、`config`、`admin`、数据库。
- **哑终端**：客户端不推断规则；只读 `PlayerView`（`bidPhase.redealCount` / `state`）。
- **不新造时钟**：`src/components/**` 与 `src/pages/table/**` 不得出现
  `setTimeout` / `setInterval`；计时器只放在 `src/composables/useRedealNotice.ts`
  （同 `useCountdown` / `useSettlementReveal` 先例）。
- **动画纪律**：起始态可见（不用 `opacity: 0` 起手）；`.anim-redeal-in` 必须 `backwards`；
  错峰走 `--ftl-delay`；新动画类必须进 `prefers-reduced-motion` 清单。
- **样式纪律**：组件 SCSS 只能用 `@import`（不得 `@use`）；不得出现裸十六进制色值。
- **提交纪律**：每个任务一个 commit，末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **验证命令**（Windows 优先）：
  - `pnpm -C apps/client test`
  - `pnpm -C apps/client run lint`（vue-tsc）
  - `pnpm -C apps/client build`（uni build）

---

## Task 1：`useRedealNotice` composable（T1–T6、T13）

### Files
- 新增 `apps/client/src/composables/useRedealNotice.ts`
- 新增 `apps/client/test/redeal-notice.test.ts`（本任务只写 composable 部分）

### Interfaces（精确）

```ts
export const REDEAL_BANNER_MS = 2000;

export function useRedealNotice(): {
  visible: Ref<boolean>;
  epoch: Ref<number>;
};
```

### Step 1.1：写失败测试

测试骨架（fake timers、`effectScope`、Pinia）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';
import { useRedealNotice, REDEAL_BANNER_MS } from '../src/composables/useRedealNotice';
import { bidPhase } from './helpers/bid-phase';
import { playerViewFixture } from './helpers/fake-socket';

function view(count: number, state: 'bidding' | 'playing' = 'bidding') {
  return playerViewFixture({ state, version: count + 10, bidPhase: bidPhase({ redealCount: count }) });
}

function mountComposable() {
  const scope = effectScope();
  const api = scope.run(() => useRedealNotice())!;
  return { scope, ...api };
}
```

用例：

| # | 步骤 | 断言 |
|---|---|---|
| T1 | `store.$patch({ view: view(1) })` 后再挂 composable | `visible=false`、`epoch=0` |
| T2 | 挂载（无视图）→ 推 `view(0)` → 推 `view(1)` | 第一次不触发；第二次 `visible=true`、`epoch=1`；`advanceTimersByTime(REDEAL_BANNER_MS - 1)` 仍 true，再 1ms → false |
| T3 | 推 `view(0)`（baseline）→ 推 `view(1)`（触发）→ 1000ms → 推 `view(2)` | `epoch=2`；从**第二次**触发起算：`REDEAL_BANNER_MS - 1` 仍可见，再 1ms 后 false（验证计时器被重置，不是沿用第一次的） |
| T4 | 推 `view(2)`（baseline）→ 推 `view(3,'playing')` | `visible=false`、`epoch` 不变（第 3 次流局不重发） |
| T5 | 推 `view(0)`（baseline）→ 推 `view(1)`（visible=true）→ 推 `view(0)` | `visible=false`、`epoch=0`、`vi.getTimerCount()===0`（新局回退并清计时器） |
| T6 | 推 `view(0)`（baseline）→ 推 `view(1)`（visible=true）→ `store.$patch({ view: null })` | `visible=false`、`epoch=0`、`vi.getTimerCount()===0`（计时器被清理，不是“不抛就算过”） |
| T13 | 推 `view(0)`（baseline）→ 推 `view(1)`（visible=true）→ 推同 count 的 `playing` 视图 | 横幅立即隐藏、`epoch` 不变、`getTimerCount()===0` |
| T14 | 首版 `view(1)`（baseline）→ resync 推 `view(2)`（页面不卸载、view 保留） | `visible=true`、`epoch=1`（同页面重连 = 真实重发；与 T1 的首版基线形成正反对照） |

> 每个 `$patch` 后 `await nextTick()`；`beforeEach` 里 `vi.useFakeTimers()`，`afterEach`
> `vi.useRealTimers()` + `scope.stop()`。断言用 `REDEAL_BANNER_MS` 常量，不写死 1999/2000
> （`noUnusedLocals` + 单一真源）。

### Step 1.2：跑红

`pnpm -C apps/client exec vitest run test/redeal-notice.test.ts`
预期：模块不存在 ⇒ 导入失败（红）。

### Step 1.3：最小实现

```ts
/**
 * 重新发牌的可感知化：把服务端 `bidPhase.redealCount` 的**递增**译成
 * 「横幅可见 + 手牌重放入场」两个展示位。
 *
 * ⚠️ 这里没有任何规则判定：是否重发、第几次、何时停 —— 全部由服务端视图决定。
 * ⚠️ 计时器落点：牌桌区组件不得新造时钟（animations.test.ts 的机械闸）；
 *    本文件与 useCountdown / useSettlementReveal 同族。
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { useGameStore } from '../stores/game';

export const REDEAL_BANNER_MS = 2000;

export function useRedealNotice(): { visible: Ref<boolean>; epoch: Ref<number> } {
  const store = useGameStore();
  const visible = ref(false);
  const epoch = ref(0);
  let baseline: number | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHide(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hide(): void {
    clearHide();
    visible.value = false;
  }

  watch(
    () => store.view?.bidPhase?.redealCount ?? null,
    (count) => {
      if (count === null) {
        baseline = null;
        hide();
        epoch.value = 0;
        return;
      }
      if (baseline === null) {
        baseline = count;
        return;
      }
      if (count < baseline) {
        baseline = count;
        hide();
        epoch.value = 0;
        return;
      }
      if (count === baseline) return;
      baseline = count;
      if (!store.isBidding) return;
      epoch.value += 1;
      visible.value = true;
      clearHide();
      hideTimer = setTimeout(() => {
        visible.value = false;
        hideTimer = null;
      }, REDEAL_BANNER_MS);
    },
    { immediate: true },
  );

  watch(
    () => store.view?.state ?? null,
    (state) => {
      if (state !== 'bidding') hide();
    },
  );

  onScopeDispose(clearHide);

  return { visible, epoch };
}
```

### Step 1.4：跑绿

`pnpm -C apps/client exec vitest run test/redeal-notice.test.ts` ⇒ 全绿。

### Step 1.5：提交

`feat(client): useRedealNotice 检测重新发牌（横幅+动画世代）`

---

## Task 2：动画资产 + 机械闸

### Files
- `apps/client/src/styles/animations.scss`
- `apps/client/test/animations.test.ts`

### Step 2.1：写失败测试

在 `animations.test.ts` 新增 describe：

1. `.anim-redeal-in` 规则存在，且 `animation: ... backwards`，不含 `both|forwards`
   （复用「正反对照」写法）。
2. `prefers-reduced-motion` 块（花括号配对截取）同时包含 `.anim-redeal-in` 与
   `.anim-redeal-banner`。
3. `.anim-redeal-banner` 规则存在，`animation` 时长走 `var(--ftl-redeal-ms`。
4. **单一真源（审查 L4）**：写一个纯 helper 从规则文本里截出
   `var(--ftl-redeal-ms, Nms)` 的兜底 `N`；对**真实文件**断言 `N === REDEAL_BANNER_MS`
   （import 自 `../src/composables/useRedealNotice`），并用**合成样本**做正反对照
   （合规样本命中、`3000ms` 样本不相等）。不要在真文件上改值做反控。

### Step 2.2：跑红

`pnpm -C apps/client exec vitest run test/animations.test.ts` ⇒ 新用例红。

### Step 2.3：最小实现

在 `animations.scss` 的 `.anim-deal-in` 之后加：

```scss
/// 重发整手入场：比首发位移更大、带旋转；仍从可见态起手（只动 transform）。
@keyframes ftl-redeal-in {
  from {
    transform: translateY(-48px) rotate(-8deg) scale(.86);
  }
  to {
    transform: none;
  }
}
.anim-redeal-in {
  animation: ftl-redeal-in .46s $ftl-ease backwards;
  animation-delay: var(--ftl-delay, 0ms);
}

/// 重新发牌横幅：入场（缩放可见）→ 停留 → 末段淡出。
/// 时长由内联 `--ftl-redeal-ms` 给（与 JS 的 REDEAL_BANNER_MS 同源）。
@keyframes ftl-redeal-banner-life {
  0% {
    transform: scale(1.18);
    opacity: 1;
  }
  12% {
    transform: scale(1);
    opacity: 1;
  }
  82% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.anim-redeal-banner {
  animation: ftl-redeal-banner-life var(--ftl-redeal-ms, 2000ms) $ftl-ease both;
}
```

并把 `.anim-redeal-in`、`.anim-redeal-banner` 加入 `@media (prefers-reduced-motion: reduce)`
的选择器清单。

### Step 2.4：跑绿

`pnpm -C apps/client exec vitest run test/animations.test.ts` ⇒ 全绿。

### Step 2.5：提交

`feat(client): 新增重发整手/横幅动画类并纳入降级清单`

---

## Task 3：`Hand` 的 `enter='redeal'` 档

### Files
- `apps/client/src/components/Hand.vue`
- `apps/client/test/card-hand-interaction.test.ts`（或 `hand-keys.test.ts`；选前者，已 direct-mount Hand）

### Step 3.1：写失败测试

`card-hand-interaction.test.ts` 的本地 `HandProps` 接口目前没有 `enter` 字段，先补：

```ts
interface HandProps {
  cards: readonly ProtocolCard[];
  interactive?: boolean;
  selected?: readonly number[];
  size?: 'normal' | 'small';
  emptyText?: string;
  sort?: 'none' | 'asc' | 'desc';
  enter?: 'deal' | 'played' | 'none' | 'redeal';
}
```

然后写两条（`makeCards` 已在该文件导入；不要用不存在的 `c()` helper）：

```ts
it("enter='redeal' 挂 anim-redeal-in（重发档）", () => {
  const wrapper = mountHand({ cards: makeCards(3, 4, 5), enter: 'redeal' });
  const card = wrapper.find('.card');
  expect(card.classes()).toContain('anim-redeal-in');
  expect(card.classes()).not.toContain('anim-deal-in');
});

it('D12：重发档只作用于挂载时的首批牌，后来新增的牌降回发牌档', async () => {
  const first = makeCards(3, 4, 5);
  const wrapper = mountHand({ cards: first, enter: 'redeal', sort: 'none' });
  for (const n of wrapper.findAll('.card')) {
    expect(n.classes()).toContain('anim-redeal-in');
  }

  await wrapper.setProps({ cards: makeCards(3, 4, 5, 6) });
  const classes = wrapper.findAll('.card').map((n) => n.classes());
  expect(classes[3], '新增的第 4 张必须是普通发牌档').toContain('anim-deal-in');
  expect(classes[3]).not.toContain('anim-redeal-in');
  expect(classes[0], '首批牌不得因 props 更新而改类（否则 CSS 动画重放）').toContain(
    'anim-redeal-in',
  );
});
```

同时保留一条正对照：默认 `enter` 仍是 `anim-deal-in`。
元素身份断言必须比较 `.element`（`find()` 每次返回新的 DOMWrapper，直接 `not.toBe` 恒真）。

### Step 3.2：跑红

### Step 3.3：最小实现

`Hand.vue`：

```ts
import { keyedHandOrder, type KeyedHandCard } from './hand-keys'; // L1：类型必须值/类型一起导

const enterClass = computed(
  () => ({ deal: 'anim-deal-in', played: 'anim-played-in', none: '', redeal: 'anim-redeal-in' })[props.enter],
);

/**
 * D12：重发档只属于**重挂载那一批牌**。之后在同一实例里新出现的牌
 * （地主摸的 3 张底牌 / 断线补齐）降回普通发牌档，避免把「定地主」也画成重发。
 * 🔴 必须放在 `keyedOrder` 的声明（Hand.vue:118）**之后** —— 否则 setup 期 TDZ
 * `Cannot access 'keyedOrder' before initialization`，所有 mount Hand 的用例全红。
 */
const mountKeys = new Set(keyedOrder.value.map((entry) => entry.key));
function cardEnterClass(entry: KeyedHandCard): string {
  if (props.enter === 'redeal' && !mountKeys.has(entry.key)) return 'anim-deal-in';
  return enterClass.value;
}
```

模板里 `:class="[cardEnterClass(entry), { 'card--swipe-blocked': isSwiping }]"`。

### Step 3.4：跑绿 + 提交

`feat(client): Hand 增加 redeal 入场档（仅首批牌）`

---

## Task 4：`table.vue` 接线 + 页面集成测试（T7–T16）

### Files
- `apps/client/src/pages/table/table.vue`
- `apps/client/test/redeal-notice.test.ts`（页面集成部分）

### Step 4.1：写失败测试

在 `redeal-notice.test.ts` 追加页面集成段（`FakeSocket` + `mount(TablePage)`）；
`beforeEach` 里 `vi.useFakeTimers()`、`setActivePinia`、`setHapticsEnabled(true)`；
`afterEach` 卸载页面、`vi.useRealTimers()`、`stopGameSession()`。

**夹具**：两套 17 张手牌，**都含大王 `{r:30,s:4}`**（排序降序后第一张恒为大王，
`:key` 未生效时元素会被复用 ⇒ 元素身份断言有判别力）。

| # | 步骤 | 断言 |
|---|---|---|
| T7 | 推 `game.deal`（count 0, bidding, **v1**）→ 推 `game.state_update`（count 1, 新牌, **v2**） | `.table__redeal-banner` 存在、文本 `都不叫，重新发牌`；`.table__phase` 不渲染 |
| T8 | 同上 | `.table__me .hand .card` 第一张 `.element` 身份改变；**该范围内全部**牌带 `anim-redeal-in`（底牌位的 3 张 `.card` 不在此范围） |
| T9 | 推进 `REDEAL_BANNER_MS` | 横幅消失；`.table__phase` 文本 `叫抢中` |
| T10 | 首版视图 count=1 | 无横幅；`.table__me .card` 带 `anim-deal-in` |
| T11a | 首版 count=2 → 推 count=3 playing | 无横幅；手牌照旧 `.anim-deal-in` |
| T11b | 已观测一次重发（epoch=1）→ 推 count=3 playing | 无横幅；第一张牌 `.element` 身份**不变**（未重挂载） |
| T12 | 真重发 / 第 3 次流局 | `installUniStub()` 返回的 `stub.calls.vibrateShort` +1 / 不增加（`setHapticsEnabled(true)` 不清计数，显式用同一 stub 句柄断言） |
| T13 | 横幅可见时推 playing 视图 | 横幅立即消失（不等 2s） |
| T15 | 重发后推进 `REDEAL_BANNER_MS`（横幅消失） | 第一张牌 `.element` 不变、类仍为 `anim-redeal-in`（绑定 visible 会切回 `anim-deal-in` ⇒ 红） |
| T16 | 距第一次重发 1000ms 时推第二次重发 | 横幅 `.element` 身份改变（`:key` 重建）；无 `:key` 时复用 ⇒ 红 |

> T14（同页面重连语义）已在 Task 1 的 composable 单测覆盖，页面层不重复。
> **夹具版本必须递增**：`applySnapshot` 对 `version === currentVersion` 直接丢弃
> （`stores/game.ts:644-649`）⇒ 首版 v1、第二条 v2、后续每条 +1，照
> `table-bid-ui.test.ts:235-247` 的既有约定。元素身份一律比较 `.element`。

### Step 4.2：跑红

`pnpm -C apps/client exec vitest run test/redeal-notice.test.ts` ⇒ 页面集成红。

### Step 4.3：最小实现（table.vue）

1. import：

```ts
import { REDEAL_BANNER_MS, useRedealNotice } from "../../composables/useRedealNotice";
```

2. 解构 + 计算（放在 `useTableSound()` 附近）：

```ts
const { visible: redealVisible, epoch: redealEpoch } = useRedealNotice();
const dealEnterMode = computed<"deal" | "redeal">(() =>
  redealEpoch.value > 0 ? "redeal" : "deal",
);
watch(redealEpoch, (n, o) => {
  if (n > o) haptic("medium");
});
```

3. 手牌：

```html
<Hand
  :key="redealEpoch"
  :cards="store.hand"
  :interactive="store.settlement === null"
  :selected="selected"
  :enter="dealEnterMode"
  sort="desc"
  size="normal"
  reflow
  empty-text="手牌为空"
  @toggle="toggleCard"
  @swipe-select="onSwipeSelect"
  @swipe-deselect="onSwipeDeselect"
/>
```

4. 阶段遮罩层（替换 1108–1118）：

```html
<view v-if="!settlementRevealed" class="table__phase-overlay">
  <view
    v-if="redealVisible"
    :key="redealEpoch"
    class="table__redeal-banner anim-redeal-banner"
    :style="{ '--ftl-redeal-ms': `${REDEAL_BANNER_MS}ms` }"
  >
    <text class="table__redeal-text">都不叫，重新发牌</text>
  </view>
  <text v-else-if="store.isBidding" class="table__phase">叫抢中</text>
  <text v-else-if="store.isPlaying" class="table__phase">出牌中</text>
  <text v-else-if="store.isEnded" class="table__phase">已结束</text>
  <text v-else class="table__phase">{{ store.view?.state ?? "等待发牌" }}</text>
</view>
```

5. 样式（`.table__phase` 规则附近）：

```scss
.table__redeal-banner {
  display: flex;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-gold;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-deep, 0.86);
  box-shadow:
    0 6px 24px rgba($ftl-color-night-deep, 0.5),
    0 0 16px rgba($ftl-color-gold, 0.35);
  pointer-events: none;
  white-space: nowrap;
}
.table__redeal-text {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
  font-weight: 700;
  letter-spacing: 2px;
  text-shadow: 0 2px 6px rgba($ftl-color-night-deep, 0.7);
}
```

### Step 4.4：跑绿

`pnpm -C apps/client exec vitest run test/redeal-notice.test.ts`
再跑受影响面：`animations` / `table-bid-ui` / `table-bid-bottom` / `audio` / `hand-reflow` / `card-hand-interaction`。

### Step 4.5：提交

`feat(client): 重新发牌整手重放+中央横幅+震动`

---

## Task 5：全量验证

1. `pnpm -C apps/client test`（全量，预期全绿）
2. `pnpm -C apps/client run lint`（vue-tsc，预期 0 错误）
3. `pnpm -C apps/client build`（uni build，预期成功）
4. 真浏览器冒烟（无后端路径，本机可行）：
   - 起 H5 dev server（`pnpm -C apps/client dev`），Chrome 走 CDP 打开
     `http://localhost:5173/#/pages/table/table`；
   - 通过 `#app.__vue_app__.config.globalProperties.$pinia._s.get('game')` 直接
     `$patch` 注入「count 0 叫抢视图」→ 再注入「count 1 + 新手牌」；
   - 断言真实 DOM：`.table__redeal-banner` 出现、`.table__me .card` 带
     `anim-redeal-in`、`getAnimations().length > 0`（**不要**断言
     `animation-name === 'ftl-redeal-in'`：scoped 样式会把 keyframes 改名为
     `ftl-redeal-in-<hash>`，见审查 H4）；2.2s 后横幅消失；截图留档到 `.tmp_shots/`
     （或等价本机目录，不入库）。
   - ⚠️ 这是**机械冒烟**：观感（错峰、幅度）仍需人眼判定；不得把截图当“动画流畅”的证明。
5. 若 9 容器真栈已具备，再跑 `node scripts/browser-e2e.mjs --scenario minimal`；
   不具备则在交付报告如实说明（当前 `docker ps` 只有 buildkit，未见业务容器）。
6. `git status` 干净；提交（如有走查脚本/文档改动）。

### 回归面清单

- `test/animations.test.ts`（新类必须入降级清单、backwards、时长单一真源）
- `test/table-bid-ui.test.ts`（TABLE_AREA / TIMER_TRACES 保持绿）
- `test/table-bid-bottom.test.ts`（阶段文字所在层）
- `test/more-menu.test.ts`（`.table__phase-overlay .table__phase` 存在性）
- `test/table-ended-ui.test.ts`（overlay 文本含「已结束」）
- `test/audio.test.ts`（**唯一会真实触发新特性的既有用例**：519-560 的流局重发；
  新增横幅/重挂载/震动后原有音频断言仍需绿）
- `test/card-hand-interaction.test.ts`、`test/hand-reflow.test.ts`（Hand 行为不变）
- `test/settlement-reveal.test.ts`（fake timers 互不影响）

## 预计提交序列

1. `docs(plan): …`（spec 与设计审查记录已在 `e6670ae4` 提交）
2. `feat(client): useRedealNotice …`
3. `feat(client): 新增重发整手/横幅动画类 …`
4. `feat(client): Hand 增加 redeal 入场档（仅首批牌）`
5. `feat(client): 重新发牌整手重放+中央横幅+震动`
6. （如需要）`test/docs: 走查记录`

## 计划审查记录

### 第一轮：独立对抗审查（子代理，2026-10-22）

结论：**无阻断；4 高、10 低**。实现路线可执行；问题集中在测试判别力与验证判据。

| 编号 | 级别 | 结论 | 处置 |
|---|---|---|---|
| H1 | 高 | T3 步骤与断言互斥：首版 `view(1)` 只做基线，`epoch=2` 不可能成立 | T3 改为 `view(0)` 基线 → `view(1)` 触发 → 1000ms → `view(2)` |
| H2 | 高 | composable T13 空转：`view(1)` 是基线，横幅从未出现 | T13 改为 `view(0)` 基线 → `view(1)` 可见 → 同 count `playing` |
| H3 | 高 | T6/T5 空转：从未 arm 计时器，“不抛”恒真；陈旧计时器掐掉新横幅的缺陷无判据 | T5/T6 改为「触发后」再回退/置 null，并断言 `vi.getTimerCount()===0` |
| H4 | 高 | Task 5 冒烟断言 `animation-name === 'ftl-redeal-in'` 必假红：scoped 样式把 keyframes 改名为 `<name>-<hash>` | 冒烟改为断言 `getAnimations().length > 0`，并注明原因 |
| L1 | 低 | Task 3 缺 `KeyedHandCard` 类型导入 | 计划已补 `import { keyedHandOrder, type KeyedHandCard }` |
| L2 | 低 | `mountKeys` 放在 `enterClass` 后会在 setup 期 TDZ（`keyedOrder` 在 :118 才声明） | 计划明确要求放在 `keyedOrder` 之后，并写明不得改成 computed/ref |
| L3 | 低 | Task 3 测试是伪代码（`cards`/`c()` 不存在） | 改为 `makeCards(...)`（该文件已导入） |
| L4 | 低 | 页面集成夹具没写 version，`applySnapshot` 会丢弃同版本 | 明确 v1 → v2 → 逐条 +1 |
| L5 | 低 | T12 没给 uni 替身句柄与计数复位 | 明确用 `installUniStub()` 返回值做断言 |
| L6 | 低 | 元素身份断言未钉 `.element`（DOMWrapper 直接比较恒真） | 计划已写明一律比较 `.element` |
| L7 | 低 | 受影响面漏 `more-menu` / `table-ended-ui` / `audio`（后者是唯一真实触发新路径的既有用例） | 回归清单已补三个文件 |
| L8 | 低 | 测试骨架导入 `REDEAL_BANNER_MS` 但断言用字面量 ⇒ `noUnusedLocals` 红 | 断言改用常量 |
| L9 | 低 | 提交序列第一条 `docs(spec)` 已存在 | 改为 `docs(plan)` |
| L10 | 低 | T5 的“复位半场”偏弱 | 与 H3 一并改为「触发后回退」 |

处置后：**H1–H4 全部落成可执行步骤；L1–L10 全部处置**。可开工。

## 执行记录（2026-10-22）

| 任务 | 提交 | 结果 |
|---|---|---|
| Task 1 `useRedealNotice` | `04fd19ab` | 8 个 composable 用例绿 |
| Task 2 动画资产 + 机械闸 | `94258cc1` | animations 14 用例绿（含跨文件时长单一真源） |
| Task 3 Hand `redeal` 档 + D12 | `83745efe` | card-hand-interaction 23 用例绿（含 D12 新牌降档） |
| Task 4 table 接线 + 集成 | `75521ffe` | redeal-notice 17 用例绿；受影响面 10 文件 147 用例绿 |
| Task 5 全量验证 | — | 全量 **1319 passed / 2 skipped**（代码审查补测后）；`vue-tsc` 0 错误；`uni build` 成功 |
| 真浏览器冒烟 | — | 真 Chromium（headless）+ CDP 注入两版视图：10/10 断言通过（横幅文本/17 张牌重挂载/`ftl-redeal-in-<hash>` 在播/横幅 duration=2000ms/2.3s 后消失且不重放）；截图在 `.tmp_shots/redeal-smoke/`（gitignored） |
| 代码审查 | — | 0 Critical / 0 Important / 5 Minor；M1–M3、M5 修并补测试，M4 登记为已知局限 |

代码审查后的补测：T6b（卸载清计时器）、T12b（2 秒内两次重发震两次）、T10/T11a 长度前置断言；
`Hand.vue` 的 `DEAL_CLASS` 常量收敛。修完需重跑全量验证。
