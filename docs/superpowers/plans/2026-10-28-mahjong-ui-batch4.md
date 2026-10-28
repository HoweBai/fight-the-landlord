# 四川麻将 UI 升级 · Batch 4 实现计划 v0.1

> **依据**：`docs/superpowers/specs/2026-10-28-mahjong-ui-batch4-design.md` v0.2（2 阻断 / 6 高 全修）。
> **分支**：`majiang`。**接触面**：纯客户端 `apps/client/src/`，**零改动** protocol / shared / game-service / room-service / config-service / admin / 任何聊天功能。
> **计划审查待完成**（本计划写完即送独立 reviewer）。

## Global Constraints

- **闸纪律（animations.scss 顶部注释）**：`@import` 进组件，不能 `@use`；**只从位移/缩放起手**（零 opacity 起始）；零 JS 定时器；错峰靠内联 `--ftl-delay`。
- **本批无 animations.scss 改动**：复用现有 `ftl-active-glow` keyframe；`@longpress` 是 uni-app 内置事件，零手写 setTimeout。
- **SeatPanel scoped 动画 reduced-motion**：组件内直接写 `animation:` 属性（不是 anim- 类引用），animations.scss 的 media query 管不到，需组件自己加 `@media (prefers-reduced-motion: reduce)`。
- **Board.vue `.mj__discard--selected` 用 outline 不用 box-shadow**：避免和 `.mj__discard--latest` 金色 box-shadow 叠加冲突。
- **ClaimOption.tile 永远不是 undefined**（game-service 给任何 hu 都填 tile）——A 组 filter 只按 tileType 匹配。
- **activeLevel 替换 active**：SeatPanel.vue 现有 `active: boolean` prop 改成 `activeLevel?: 'strong' | 'weak' | null`；Board.vue seatPanelProps 改传 activeLevel，删 active。
- **animations.scss import 路径三层 `..`**：`@import '../../../styles/animations.scss'`。
- **shared 439 tests / protocol tests 必须保持全绿**。
- **无聊天功能**：零 chat/emoji/voice/回放相关文件改动。

---

## 任务总览

| 任务 | 内容 | 主要文件 | commit 粒度 |
|---|---|---|---|
| T1 | ClaimTile.vue 加 filteredOptions prop | ClaimTile.vue | 1 commit |
| T2 | SeatPanel.vue 三件事：FAN_EMOJI + activeLevel + discard-click emit | SeatPanel.vue | 1 commit |
| T3 | Board.vue 四件事：弃牌过滤 + @longpress + 弹层 + seatActiveLevel | Board.vue | 1 commit |
| T4 | 全量验证 + 闸扫描 | 多文件只读 | 验证 |

---

## T1 · ClaimTile.vue 加 filteredOptions prop

**Files**
- 修改 `apps/client/src/components/table/mahjong/ClaimTile.vue`

### 现状

ClaimTile.vue L14-18：只有 `options` / `busy` / `showPass` 三个 prop。渲染时用 `sortedOptions = [...options].sort(...)`。

### 改动

新增 `filteredOptions?: MahjongClaimOption[]` prop。传入时优先用它渲染（Board.vue 计算过滤结果后传入），不传时保持现有行为。

```ts
// props 新增
const props = withDefaults(defineProps<{
  options: MahjongClaimOption[];
  busy?: boolean;
  showPass?: boolean;
  /** Batch 4 A 组：弃牌点击后 Board.vue 传入的过滤结果。传入则优先使用。 */
  filteredOptions?: MahjongClaimOption[];
}>(), { busy: false, showPass: true });
```

sortedOptions 改：
```ts
const sortedOptions = computed(() => {
  const source = props.filteredOptions ?? props.options;
  return [...source].sort((a, b) => (b.fan ?? 0) - (a.fan ?? 0));
});
```

### 闸纪律验证
- [ ] 纯 prop 新增，零 JS 逻辑改动
- [ ] 零定时器
- [ ] @import 路径不变
- [ ] 不影响现有调用方（不传 filteredOptions 则行为不变）

**提交**：
```bash
git commit -m "feat(mahjong): ClaimTile 加 filteredOptions prop（弃牌点击过滤用）"
```

---

## T2 · SeatPanel.vue 三件事

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`

### 2a · C 组：胡牌番型展示

**新增 FAN_EMOJI + fanEmoji 函数**（放在 `<script setup>` 内）：
```ts
// 和 Settlement.vue 保持一致的映射表（纯数据常量，不抽 utils）
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  龙七对: '🐉', 清对: '🎯', 将对: '⚔️',
};
function fanEmoji(name: string): string { return FAN_EMOJI[name] ?? '🏆'; }
```

**模板改**（L81-83 区域）：
```vue
<!-- 现有 -->
<text v-if="hu" class="mj-seat__badge mj-seat__badge--hu">
  胡{{ hu.fan > 0 ? ` ${hu.fan}番` : '' }}
</text>

<!-- Batch 4 C 组改 -->
<template v-if="hu">
  <text class="mj-seat__badge mj-seat__badge--hu">
    {{ hu.selfDraw ? '自摸' : '胡' }}{{ hu.fan > 0 ? ` ${hu.fan}番` : '' }}
  </text>
  <text
    v-if="hu.items.length > 0"
    class="mj-seat__badge mj-seat__badge--fan"
  >
    {{ fanEmoji(hu.items[0]) }}{{ hu.items[0] }}
    <text v-if="hu.items.length > 1" class="mj-seat__badge--fan-more">等{{ hu.items.length }}种</text>
  </text>
</template>
```

**CSS 新增**：
```scss
.mj-seat__badge--fan {
  background: rgba($ftl-color-accent, 0.25);
  color: #fbbf24;
}
.mj-seat__badge--fan-more {
  font-size: 9px;
  opacity: 0.8;
}
```

### 2b · D 组：activeLevel 替换 active

**prop 改**（L21-42）：删掉 `active: boolean`，新增 `activeLevel?: 'strong' | 'weak' | null`。

```ts
const props = withDefaults(
  defineProps<{
    // ... 其他 prop 不变
    /** Batch 4 D 组：发光强度分级。null = 不发光。 */
    activeLevel?: 'strong' | 'weak' | null;
    /** @deprecated 旧 active: boolean 已替换为 activeLevel。保留 0 位默认值以防遗漏调用方。 */
    active?: boolean;
  }>(),
  { compact: false, direction: 'my', activeLevel: null, active: false },
);
```

**模板改**（L61-69）：
```vue
<!-- 现有 -->
<view
  class="mj-seat"
  :class="{
    'mj-seat--active': active,
    'anim-active-glow': active,
  }"
>

<!-- Batch 4 D 组改 -->
<view
  class="mj-seat"
  :class="{
    'mj-seat--active-strong': activeLevel === 'strong',
    'mj-seat--active-weak': activeLevel === 'weak',
  }"
>
```

**CSS 改**（L145-149）：删掉旧 `.mj-seat--active`，新增两套：
```scss
// 旧代码（删除）：
// .mj-seat--active {
//   border-color: $ftl-color-gold;
//   background: rgba($ftl-color-gold, 0.12);
//   box-shadow: 0 0 12px rgba($ftl-color-gold, 0.25);
// }

// Batch 4 D 组新增：
.mj-seat--active-strong {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.12);
  animation: ftl-active-glow 1.2s ease-in-out infinite;
  box-shadow: 0 0 14px rgba($ftl-color-gold, 0.5);
}
.mj-seat--active-weak {
  border-color: rgba($ftl-color-gold, 0.6);
  background: rgba($ftl-color-gold, 0.06);
  animation: ftl-active-glow 2.2s ease-in-out infinite;
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.25);
}

// 高项 H2 修法：组件 scoped reduced-motion（animations.scss media query 管不到
// 组件内直接写的 animation 属性，需要自己加）
@media (prefers-reduced-motion: reduce) {
  .mj-seat--active-strong,
  .mj-seat--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2);
  }
}
```

### 2c · A 组：弃牌点击 emit

**emit 新增**：
```ts
const emit = defineEmits<{
  // ... 现有 emits
  /** Batch 4 A 组：用户点击弃牌，让 Board.vue 统一处理过滤逻辑。 */
  (e: 'discard-click', tile: Tile): void;
}>();
```

**模板改**（L102-112）：给 SeatPanel 弃牌 MahjongTile 加 `@click`：
```vue
<view v-if="discards.length > 0" class="mj-seat__row mj-seat__row--river mj-river">
  <MahjongTile
    v-for="(tile, i) in discards"
    :key="`discard-${i}`"
    :tile="tile"
    size="sm"
    :direction="direction"
    :class="{ 'mj__discard--latest': i === discards.length - 1 && discards.length > 0 }"
    @click="emit('discard-click', tile)"
  />
  <view class="mj-river__mask" />
</view>
```

### 闸纪律验证
- [ ] 复用 ftl-active-glow keyframe，零新增 keyframe
- [ ] 零 JS 定时器
- [ ] SeatPanel scoped reduced-motion 覆盖 .mj-seat--active-strong/weak
- [ ] @import 三层 .. 不变
- [ ] activeLevel 默认 null，active 默认 false（保留一个版本以防遗漏）
- [ ] FAN_EMOJI 是纯数据常量，零逻辑

**提交**：
```bash
git commit -m "feat(mahjong): SeatPanel 番型展示+activeLevel替换+discard-click emit"
```

---

## T3 · Board.vue 四件事

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

### 3a · D 组：seatActiveLevel 函数 + seatPanelProps 改

**新增函数**（放在 directionOf 附近 L246-256 后面）：
```ts
/** Batch 4 D 组：claim 窗口多家 active 差异化。最早 active = strong，其余 weak。 */
function seatActiveLevel(seat: number): 'strong' | 'weak' | null {
  const idx = activeSeats.value.indexOf(seat);
  if (idx === -1) return null;
  if (phase.value === 'claim') {
    return idx === 0 ? 'strong' : 'weak';
  }
  // play / exchange / lack / play 窗口单回合只有一个 active → strong
  return 'strong';
}
```

**seatPanelProps 改**（L257-276）：
```ts
function seatPanelProps(seat: number) {
  return {
    seat,
    name: nameOf(seat),
    cardCount: v ? (v.cardCounts[seat] ?? 0) : 0,
    lackSuit: v?.lackSuits[seat] ?? null,
    melds: v?.melds[seat] ?? [],
    discards: v?.discards[seat] ?? [],
    hu: v?.huInfos.find((h) => h.seat === seat) ?? null,
    revealed: v?.revealedHands.find((r) => r.seat === seat) ?? null,
    isOut: v?.isOut[seat] ?? false,
    trustee: v?.trustees[seat] ?? false,
    // 删：active: activeSeats.value.includes(seat),
    activeLevel: seatActiveLevel(seat), // Batch 4 D 组
    isMe: seat === me.value,
    isDealer: seat === dealerSeat.value,
    balance: seatBalance(seat),
    pendingDelta: pendingDelta(seat),
  };
}
```

**模板改**：给四个 SeatPanel 加 `@discard-click`。现有是 `v-bind="seatPanelProps(...)"` 不带事件，需要手动加：
```vue
<MahjongSeatPanel
  v-bind="seatPanelProps(topSeat)"
  :direction="directionOf(topSeat)"
  compact
  @discard-click="onSeatDiscardClick(topSeat, $event)"
/>
<!-- 其他三个同理 -->
```

### 3b · A 组：弃牌点击过滤

**新增状态 + 函数**：
```ts
// —— Batch 4 A 组：弃牌点击过滤 ——
const discardClickTarget = ref<Tile | null>(null);

/** SeatPanel 弃牌点击 handler：只在 claim 窗口 + 我 active 时响应。 */
function onSeatDiscardClick(seat: number, tile: Tile) {
  if (phase.value !== 'claim' || !amActive.value) return;
  // 再次点击同一张 → 取消过滤
  if (discardClickTarget.value && tileType(discardClickTarget.value) === tileType(tile)) {
    discardClickTarget.value = null;
    return;
  }
  discardClickTarget.value = tile;
}

/** 过滤 claimsForMe：只保留 tileType 匹配的选项。
 * 阻断 B2 修法：不写 opt.tile === undefined —— game-service 任何 hu 都填 tile。
 * 自摸胡在 play 窗口响应（Board.vue L217-225），不在 claim 窗口。 */
const filteredClaimsForDiscard = computed<MahjongClaimOption[]>(() => {
  if (!discardClickTarget.value) return myClaims.value; // 未选中 → 全量
  const tt = tileType(discardClickTarget.value);
  return myClaims.value.filter(opt => !!opt.tile && tileType(opt.tile) === tt);
});

// 高项 H1：discardClickTarget reset 时机
watch(phase, (to) => { if (to !== 'claim') discardClickTarget.value = null; });
watch(myClaims, () => { discardClickTarget.value = null; }, { deep: true });
```

**ClaimTile 调用改**（L607-614）：
```vue
<ClaimTile
  v-else-if="!settlementArrived && phase === 'claim' && amActive"
  :options="myClaims"
  :filtered-options="discardClickTarget ? filteredClaimsForDiscard : undefined"
  :busy="busy"
  :show-pass="canPass"
  @claim="submitClaim"
  @pass="submitPass"
/>
```

**my-river 弃牌也加点击**（L526-535）：Board.vue 自己的弃牌河也需要 click 能力（玩家自己看自己刚出的弃牌是否能 claim 虽然不太常见，但 claim 窗口理论上能响应任何座位的弃牌）：
```vue
<view v-if="myDiscards.length > 0" class="mj__my-river mj-river">
  <MahjongTile
    v-for="(tile, i) in myDiscards"
    :key="`my-discard-${i}`"
    :tile="tile"
    size="sm"
    direction="my"
    :class="{
      'mj__discard--latest': i === myDiscards.length - 1 && myDiscards.length > 0,
      'mj__discard--selected': discardClickTarget && i === myDiscards.length - 1
    }"
    @click="onSeatDiscardClick(me, tile)"
  />
</view>
```

**CSS 新增**：
```scss
// 高项 H6：outline 替代 box-shadow（避免和 .mj__discard--latest 金色 box-shadow 叠加）
.mj__discard--selected {
  outline: 2px solid $ftl-color-blue;
  outline-offset: -2px;
}
```

### 3c · B 组：@longpress + 弹层

**新增状态 + 函数**：
```ts
// —— Batch 4 B 组：长按手牌看牌型 ——
const handHintIndex = ref<number | null>(null);

function onTileLongPress(index: number) {
  if (!handSelectable.value || phase.value !== 'play') return;
  if (props.settlementArrived) return;
  handHintIndex.value = index;
}
function closeHandHint() { handHintIndex.value = null; }

watch(phase, () => { handHintIndex.value = null; });
watch(() => hand.value.length, () => { handHintIndex.value = null; });

/** 高项 H4：纯布尔判断，不做牌库搜索。
 * 手牌打完这张就没了 → tingTiles 不变 → stillSafe=true
 * 手牌还有同款 → tingTiles 可能变 → stillSafe=false */
const handHintAffected = computed(() => {
  if (handHintIndex.value === null) return null;
  const hintTile = hand.value[handHintIndex.value];
  if (!hintTile) return null;
  const handWithout = hand.value.filter((_, i) => i !== handHintIndex.value!);
  const stillHas = handWithout.some(t => tileType(t) === tileType(hintTile));
  return { tile: hintTile, stillSafe: !stillHas };
});
```

**手牌 MahjongTile 加 @longpress**（L635-648）：
```vue
<MahjongTile
  v-for="(tile, i) in hand"
  :key="`hand-${phase}-${i}`"
  :tile="tile"
  size="lg"
  :selected="selected.includes(i)"
  :disabled="!handSelectable"
  @click="onTileClick(i)"
  @longpress="onTileLongPress(i)"
  ...
/>
```

**弹层 view 加到模板末尾**（在 MahjongHuBanner 后面）：
```vue
<view
  v-if="handHintIndex !== null && handHintAffected"
  class="mj__hand-hint-popup"
  @click="closeHandHint"
>
  <view class="mj__hand-hint-popup__card" @click.stop>
    <text class="mj__hand-hint-popup__title">
      打出 {{ MAHJONG_SUIT_NAMES[handHintAffected.tile.s] }}{{ handHintAffected.tile.r }}
    </text>
    <text class="mj__hand-hint-popup__result" :class="{
      'mj__hand-hint-popup__result--safe': handHintAffected.stillSafe,
      'mj__hand-hint-popup__result--warn': !handHintAffected.stillSafe,
    }">
      {{ handHintAffected.stillSafe ? '✓ 仍能听牌' : '⚠ 可能影响听牌' }}
    </text>
    <text v-if="tingTiles.length > 0" class="mj__hand-hint-popup__ting">
      听 {{ tingTiles.length }} 张
    </text>
  </view>
</view>
```

**CSS 新增**：
```scss
.mj__hand-hint-popup {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj__hand-hint-popup__card {
  padding: 16px 24px;
  border-radius: 12px;
  background: rgba(20, 50, 30, 0.92);
  border: 2px solid rgba($ftl-color-gold, 0.6);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mj__hand-hint-popup__title { color: rgba(255,255,255,0.9); font-size: 16px; }
.mj__hand-hint-popup__result--safe { color: #4ade80; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__result--warn { color: #fbbf24; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__ting { color: $ftl-color-text-muted; font-size: 12px; }
```

### 闸纪律验证
- [ ] 零 setTimeout/setInterval（@longpress 是 uni-app 框架事件）
- [ ] 不新增 keyframe
- [ ] 复用 tileType 比较 tile（Board.vue 已 import）
- [ ] MAHJONG_SUIT_NAMES 已从 protocol import
- [ ] handHintIndex reset：phase watch + hand.length watch + 点击遮罩关闭
- [ ] discardClickTarget reset：phase watch + myClaims deep watch

**提交**：
```bash
git commit -m "feat(mahjong): Board.vue 弃牌过滤+@longpress+弹层+seatActiveLevel"
```

---

## T4 · 全量验证 + 闸扫描

### 4a · VS Code 诊断（GetDiagnostics）
预期：SeatPanel.vue 新增 prop 改动零错误；Board.vue 模板改零错误；ClaimTile.vue 新增 prop 零错误。

### 4b · JS 定时器闸扫描
Batch 4 新增/修改文件 grep `setTimeout|setInterval` 必须零命中。

### 4c · reduced-motion media query 验证
- animations.scss media query 覆盖 anim-active-glow（batch 2 已加）
- SeatPanel.vue scoped style 自己覆盖 .mj-seat--active-strong/weak

### 4d · 斗地主/跑得快零误伤验证
grep `.mj-seat--active`（旧类名）——SeatPanel.vue 里已删除，Board.vue 里 seatPanelProps 已不传 active。确保没有其他文件引用旧的 active boolean prop。

### 4e · 零聊天功能改动验证
grep `chat|emoji|voice|replay|回放|表情|语音|聊天` 在修改文件里零命中。

---

## 计划审查记录

### 第 1 轮（本计划写完即送）

待独立 reviewer 审查以下重点：
1. SeatPanel.vue 保留 active: boolean（deprecated）还是直接删？——如果整个 workspace 只有 Board.vue 传 active，直接删更干净
2. SeatPanel.vue @click="emit('discard-click', tile)" 会不会因为 scoped style pointer-events 被禁？——MahjongTile 应该继承 click 能力
3. Board.vue SeatPanel v-bind 加 event handler 的写法 `v-bind="seatPanelProps(topSeat)" @discard-click="..."` ——Vue 3 里 v-bind 对象 + 独立 @event 是合法的（对象里没有同名 key 时）
4. my-river 的 @click —— 玩家自己弃的牌 claim 窗口能响应吗？game-service 给 claimsForMe 的 tile 应该是弃牌（任何座位的），所以我自己弃的牌也应该在 claim 窗口有 claimsForMe 项——但自己刚弃完牌就 claim 自己的牌逻辑上不太对（除非上家同时 claim？血战到底 claim 窗口应该有多个响应者）
5. SeatPanel discard-click 在非 claim 窗口也会 emit —— 但 Board.vue onSeatDiscardClick 第一行就 `if (phase !== 'claim') return`，安全
6. @longpress 在 H5 的表现（长按 500ms 触发）——uni-app 框架默认 500ms，不可配置；H5 端如果长按触发后 click 还会触发就有幽灵 click 问题——但 uniapp.dcloud.net.cn 文档说 longpress 触发后不触发 click
7. handHintAffected 的"打出后仍能听"判断——只是布尔，实际 tingTiles 可能变了（打出的张可能减少了），但弹层里显示 tingTiles.length 是打出前的数字，会不会误导？
