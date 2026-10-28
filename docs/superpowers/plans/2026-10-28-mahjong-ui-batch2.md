# 四川麻将 UI 升级 · Batch 2 实现计划 v0.1

> **依据**：`docs/superpowers/specs/2026-10-28-mahjong-ui-batch2-design.md` v0.2（5 阻断 / 9 高 / 3 低全处置）。
> **分支**：`majiang`。**接触面**：纯客户端 `apps/client/src/`，**零改动** protocol / shared / game-service / room-service / config-service / admin / useTableSound.ts。
> **计划审查待完成**（本计划写完即送独立 reviewer）。

## Global Constraints

- **闸纪律（animations.scss 顶部注释）**：`@import` 进组件不能 `@use`；起始态必须可见（opacity 只在结束态淡出）；零 JS 定时器（错峰靠内联 `--ftl-delay`）。
- **新 keyframe 类名统一 `anim-` 前缀**（设计 v0.2 闸纪律补充）。
- **循环动画（glow/pulse）缓动用 `ease-in-out`**（和现有 ftl-urgent-pulse 一致）；**一次性动画用 `$ftl-ease`**（cubic-bezier(.22,1,.36,1)）。
- **`@media (prefers-reduced-motion: reduce)` 必须手动追加所有新 `anim-` 类**（animations.scss L222-236 逗号列表，漏一个降级失效）。
- **`MahjongMeldKind` 是 protocol 3 值联合**：`'peng' | 'gang' | 'angang'`（无 addedGang/meldedGang）。
- **`MahjongHuInfo.selfDraw`（不是 isZimo）** 区分自摸/点炮胡。
- **零 JS setTimeout/setInterval**（除 CSS animationend 事件回调不是定时器）。
- **先加 `@import animations.scss` 再加动画规则**（MahjongMeld.vue / MahjongSeatPanel.vue 当前无 import，Sass 编译直接报 $ftl-ease 未定义）。
- **手牌 key 用 `hand-${phase}-${i}`**（不纳入 version，避免每轮摸牌重挂载）。
- **shared 439 tests / protocol tests 必须保持全绿**（Batch 2 零改动这两层）。

---

## 任务总览

| 任务 | 内容 | 主要文件 | commit 粒度 |
|---|---|---|---|
| T1 | animations.scss 追加 7 keyframe + 7 anim- 类 + reduced-motion 追列 | animations.scss | 1 commit |
| T2 | MahjongMeld.vue：import + pop prop + 增量动画 + 稳定 key | MahjongMeld.vue | 1 commit |
| T3 | MahjongSeatPanel.vue：import + active glow 类 | MahjongSeatPanel.vue | 1 commit |
| T4 | **新建** MahjongHuBanner.vue + Board.vue banner 逻辑 + 定位 | 新建组件 + Board.vue | 1 commit |
| T5 | Board.vue：定缺推荐 lackRecommendation + anim-lack-pulse | Board.vue | 1 commit |
| T6 | Board.vue：出牌 fly-out + hand key phase + flyingOutIndex | Board.vue | 1 commit |
| T7 | Board.vue：initialBootDone + meldKey + MahjongMeld :pop 传值（B3 阻断修法） | Board.vue | 1 commit |
| T8 | 全量验证 + 闸扫描 | 多文件只读 | 验证 |

---

## T1 · animations.scss 追加 7 keyframe + 7 anim- 类 + reduced-motion 追列

**Files**
- 修改 `apps/client/src/styles/animations.scss`

**新增 keyframe（7 个）**

```scss
/// 副露 pop 入场（碰）：从 scale 0.6 + 下方 12px 弹起。只动 transform —— 起始态可见。
@keyframes ftl-peng-pop {
  from { transform: scale(0.6) translateY(12px); }
  to { transform: none; }
}

/// 副露 pop 入场（杠）：和 peng 同形态但 4 张更重，时长稍长 0.06s。
@keyframes ftl-gang-pop {
  from { transform: scale(0.55) translateY(14px); }
  to { transform: none; }
}

/// 副露 pop 入场（暗杠）：和 gang 同。暗杠牌背视觉已够区分，时长不再差异化。
@keyframes ftl-angang-pop {
  from { transform: scale(0.5) translateY(16px); }
  to { transform: none; }
}

/// 胡牌 banner 飞出：起始态可见 transform-only；停留 0.4s 后 100% 才淡出。
@keyframes ftl-hu-banner {
  0%   { transform: scale(1.4) translateY(-10px); opacity: 1; }
  30%  { transform: none; opacity: 1; }
  70%  { transform: none; opacity: 1; }
  100% { transform: scale(0.9) translateY(-20px); opacity: 0; }
}

/// 手牌双击后向右上飞出（对齐弃牌河位置）。起始态可见。
@keyframes ftl-fly-out {
  from { transform: none; }
  to   { transform: translateY(-20px) translateX(12px) scale(0.7); opacity: 0; }
}

/// 当前玩家座位面板发光循环：box-shadow 呼吸。
@keyframes ftl-active-glow {
  0%, 100% { box-shadow: 0 0 8px rgba($ftl-color-gold, 0.25); }
  50%      { box-shadow: 0 0 22px rgba($ftl-color-gold, 0.55); }
}

/// 定缺推荐按钮呼吸（独立于 urgent-pulse，1.6s vs 0.8s）。
@keyframes ftl-lack-pulse {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.08); }
}
```

**新增 anim- 类（7 个）**，放在 animations.scss L213 左右（已有 anim-urgent-pulse 后面）：

```scss
// —— 麻将 Batch 2 动画（2026-10-28）——
.anim-meld-pop {
  animation: ftl-peng-pop 0.36s $ftl-ease both;
}
.anim-meld-pop--gang {
  animation: ftl-gang-pop 0.42s $ftl-ease both;
}
.anim-meld-pop--angang {
  animation: ftl-angang-pop 0.42s $ftl-ease both;
}
.anim-hu-banner {
  animation: ftl-hu-banner 0.8s $ftl-ease forwards;
}
.anim-fly-out {
  animation: ftl-fly-out 0.24s cubic-bezier(.22,1,.36,1) forwards;
}
.anim-active-glow {
  animation: ftl-active-glow 1.8s ease-in-out infinite;
}
.anim-lack-pulse {
  animation: ftl-lack-pulse 1.6s ease-in-out infinite;
}
```

**reduced-motion 更新**：在 `@media (prefers-reduced-motion: reduce)` 的逗号列表里手动追加：
```
anim-meld-pop, anim-meld-pop--gang, anim-meld-pop--angang,
anim-hu-banner, anim-fly-out, anim-active-glow, anim-lack-pulse
```

**闸纪律验证**
- [ ] 所有 keyframe 起始态 opacity:1（只有 hu-banner 结束态 100% 和 fly-out 结束态有 opacity:0，合法）
- [ ] 一次性动画用 `$ftl-ease`，循环动画用 `ease-in-out`
- [ ] 类名全部 `anim-` 前缀
- [ ] reduced-motion media query 里 7 个新类全列了
- [ ] 没有引入 @use / 没有引入 uni.scss

**提交**：
```bash
git commit -m "feat(mahjong): animations.scss 追加 Batch 2 七组麻将动画 + reduced-motion 追列

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T2 · MahjongMeld.vue：import + pop prop + 增量动画 + 稳定 key

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongMeld.vue`

**Step 1 — 补 import（B5 阻断 + 计划审查 B1）**
在 `<style scoped lang="scss">` 之后第一行加：
```scss
@import '../../../styles/animations.scss';
```
（三层 `..`：MahjongMeld.vue 在 `components/table/mahjong/`，animations.scss 在 `styles/`，往上三层才到 src/ — Board.vue L498 同样写法）

**Step 2 — 新增 pop prop**
```ts
const props = withDefaults(
  defineProps<{
    meld: MahjongMeldView;
    direction?: Direction;
    size?: 'sm' | 'md' | 'lg';
    /** true 时播放进场 pop 动画（增量新增时由 Board 传 true）。 */
    pop?: boolean;
  }>(),
  { size: 'sm', pop: false },
);
```

**Step 3 — 动画类 computed**
```ts
const popAnimClass = computed(() => {
  if (!props.pop) return '';
  switch (props.meld.kind) {
    case 'peng': return 'anim-meld-pop';
    case 'angang': return 'anim-meld-pop anim-meld-pop--angang';
    default: return 'anim-meld-pop anim-meld-pop--gang';
  }
});
```

**Step 4 — 模板里加 :class**
```html
<view class="mj-meld" :class="[styleClass, `mj-meld--${size}`, popAnimClass]">
```

**Step 5 — animationend 自动清理**（可选，但避免 prop 残留时动画重放）
在根 view 上加 `@animationend="onPopDone"`：
```ts
function onPopDone(e: AnimationEvent): void {
  // 只处理 ftl-peng-pop/gang-pop/angang-pop 的结束
  if (e.animationName.startsWith('ftl-')) emit('pop-done');
}
```
定义 emit：
```ts
const emit = defineEmits<{ (e: 'pop-done'): void }>();
```
Board.vue 收到后清 newMeldKeySet。

**闸纪律验证**
- [ ] import 用相对路径 `../../styles/animations.scss`（MahjongMeld.vue 在 components/table/mahjong/，animations.scss 在 styles/，两级相对路径正确）
- [ ] 动画起始态可见（ftl-peng-pop 起始 transform scale 0.6 translateY 12px，opacity 不变）
- [ ] 没有引入 setTimeout/setInterval

**提交**：
```bash
git commit -m "feat(mahjong): MahjongMeld 增量 pop prop + animations.scss import (B5+B3 阻断修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T3 · MahjongSeatPanel.vue：import + active glow

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`

**Step 1 — 补 import（B5 阻断 + 计划审查 B1）**
在 `<style scoped lang="scss">` 之后第一行加：
```scss
@import '../../../styles/animations.scss';
```

**Step 2 — 模板里 `.mj-seat--active` 条件类里加 anim-active-glow**
找到模板 L63-69 附近：
```html
<view
  class="mj-seat"
  :class="{
    'mj-seat--me': isMe,
    'mj-seat--active': active,
    'mj-seat--out': isOut,
    'mj-seat--compact': compact,
    'anim-active-glow': active,  <!-- 加这一行 -->
  }"
>
```

**Step 3 — 保留原有 box-shadow**
`.mj-seat--active` 现有的 box-shadow `0 0 12px rgba($ftl-color-gold, 0.25)` 保留——`ftl-active-glow` keyframe 循环会覆盖它，取消 active 时从循环瞬停回普通规则（H8 接受）。

**闸纪律验证**
- [ ] import 路径正确（MahjongSeatPanel.vue 在 components/table/mahjong/，animations.scss 在 styles/）
- [ ] 没有引入 setTimeout/setInterval

**提交**：
```bash
git commit -m "feat(mahjong): MahjongSeatPanel active glow 循环 (B5 阻断修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T4 · 新建 MahjongHuBanner.vue + Board.vue banner 逻辑

**Files**
- 新建 `apps/client/src/components/table/mahjong/MahjongHuBanner.vue`
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`（import + ref + watch + 定位 + 模板）

### 4a · MahjongHuBanner.vue

```html
<script setup lang="ts">
/**
 * 胡牌 banner（浮动 view，position: absolute; z-index: 10）。
 * 动画结束后 emit('done') 让父组件 FIFO 队列下一条。
 *
 * 起始态可见（闸纪律），0.8s 内 transform 缩放 → 停留 → 淡出。
 */
import { computed } from 'vue';
// （无 protocol import — 本组件不需要）

const props = withDefaults(defineProps<{
  seat: number;
  fan: number;
  selfDraw: boolean;
  /** 座位位置（百分比），由 Board.vue directionOf 算出 */
  leftPct: number;
  topPct: number;
}>(), { fan: 0, selfDraw: false, leftPct: 50, topPct: 50 });

const emit = defineEmits<{ (e: 'done'): void }>();

const bannerStyle = computed(() => ({
  left: `${props.leftPct}%`,
  top: `${props.topPct}%`,
}));

function onAnimEnd(e: AnimationEvent): void {
  if (e.animationName === 'ftl-hu-banner') emit('done');
}
</script>

<template>
  <view class="mj-hu-banner anim-hu-banner" :style="bannerStyle" @animationend="onAnimEnd">
    <text class="mj-hu-banner__text">{{ selfDraw ? '自摸' : '胡牌' }}</text>
    <text v-if="fan > 0" class="mj-hu-banner__fan">{{ fan }} 番</text>
  </view>
</template>

<style scoped lang="scss">
@import '../../../styles/animations.scss';

.mj-hu-banner {
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%); /* 居中对齐座位上方 */
  pointer-events: none;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 12px;
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(255, 180, 60, 0.95), rgba(220, 100, 30, 0.9));
  box-shadow: 0 4px 16px rgba(255, 120, 0, 0.5);
  border: $ftl-hairline solid rgba(255, 220, 100, 0.6);
  white-space: nowrap;
}
.mj-hu-banner__text {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.mj-hu-banner__fan {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 800;
}
</style>
```

### 4b · Board.vue 新增逻辑

**import**：
```ts
import MahjongHuBanner from './MahjongHuBanner.vue';
```

**refs + Set**：
```ts
// 胡牌 banner：diff Set + FIFO queue（H3 修法）
const seenHuSeats = new Set<number>();
const bannerQueue = ref<Array<{ seat: number; fan: number; selfDraw: boolean }>>([]);
const currentBanner = ref<typeof bannerQueue.value[0] | null>(null);

// 计划审查 B2 阻断：seenHuSeats / seenMeldKeys 跨局残留 reset
watch(
  () => props.view?.state,
  (to, from) => {
    // 新局开始：from 是 'ended'（上一局结束）或 null（首次进房无 view）
    // 或 from 是任何非 exchange 的 phase（一局进行中）
    const newRound =
      (from === 'ended' && to === 'exchange') ||
      (from === null && to === 'exchange') ||
      (from && from !== 'exchange' && to === 'exchange');
    if (newRound) {
      seenHuSeats.clear();
      bannerQueue.value = [];
      currentBanner.value = null;
    }
  },
);
```

**watch huInfos**：
```ts
watch(
  () => props.view?.huInfos ?? [],
  (infos) => {
    const newlyAdded: typeof bannerQueue.value = [];
    for (const info of infos) {
      if (!seenHuSeats.has(info.seat)) {
        seenHuSeats.add(info.seat);
        newlyAdded.push({ seat: info.seat, fan: info.fan, selfDraw: info.selfDraw });
      }
    }
    if (newlyAdded.length > 0) {
      bannerQueue.value.push(...newlyAdded);
      if (!currentBanner.value) showNextBanner();
    }
  },
  { deep: true },
);

function showNextBanner() {
  currentBanner.value = bannerQueue.value.shift() ?? null;
}
```

**direction → 座位位置映射**（H9 定位方案，近似百分比）：
```ts
function bannerPosition(seat: number): { leftPct: number; topPct: number } {
  // 座位面板大致位置（百分比近似）
  if (seat === me.value) return { leftPct: 50, topPct: 90 }; // 底部
  if (seat === topSeat.value) return { leftPct: 50, topPct: 10 }; // 顶部
  if (seat === leftSeat.value) return { leftPct: 8, topPct: 50 }; // 左侧
  return { leftPct: 92, topPct: 50 }; // 右侧
}
```

**模板里加 banner**（放在 `</template>` 前、slot 前）：
```html
<MahjongHuBanner
  v-if="currentBanner"
  :seat="currentBanner.seat"
  :fan="currentBanner.fan"
  :self-draw="currentBanner.selfDraw"
  :left-pct="bannerPosition(currentBanner.seat).leftPct"
  :top-pct="bannerPosition(currentBanner.seat).topPct"
  @done="showNextBanner"
/>
```

**闸纪律验证**
- [ ] 无 setTimeout/setInterval（只有 CSS animationend 事件）
- [ ] 起始态可见（hu-banner keyframe 0% opacity:1）
- [ ] import 路径正确
- [ ] 新增逻辑全部在 Board.vue 现有 watch 体系里，不新增 store 依赖

**提交**：
```bash
git commit -m "feat(mahjong): MahjongHuBanner 组件 + Board.vue huInfos diff FIFO + 跨局 reset (H3+H9+B2 修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T5 · Board.vue：定缺推荐 lackRecommendation + anim-lack-pulse

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

**lackRecommendation computed**（替换或追加到现有 computed 块里）：
```ts
const lackRecommendation = computed<MahjongSuit | null>(() => {
  if (phase.value !== 'lack' || !amActive.value) return null;
  // 手牌必须加载完（至少 10 张，防 exchange→lack 时序）
  if (hand.value.length < 10) return null;
  const counts = [0, 0, 0];
  for (const t of hand.value) counts[t.s]++;
  let minIdx = 0, minCount = counts[0];
  let hasUniqueMin = true;
  for (let i = 1; i < 3; i++) {
    if (counts[i] < minCount) { minCount = counts[i]; minIdx = i; hasUniqueMin = true; }
    else if (counts[i] === minCount) { hasUniqueMin = false; }
  }
  // H7 edge case: 全相等不推荐；最小为 0（绝张/自动定缺）不推荐
  if (!hasUniqueMin) return null;
  if (minCount === 0) return null;
  return minIdx as MahjongSuit;
});
```

**模板改动**（lack 按钮块 L419-430）：
```html
<template v-else-if="!settlementArrived && phase === 'lack' && amActive">
  <button
    v-for="suit in ([0, 1, 2] as const)"
    :key="`lack-${suit}`"
    type="button"
    class="btn mj__lack"
    :class="{
      'anim-lack-pulse': lackRecommendation === suit,
      'mj__lack--recommend': lackRecommendation === suit,
    }"
    :disabled="busy"
    @click="onLack(suit)"
  >
    缺{{ MAHJONG_SUIT_NAMES[suit] }}
    <text v-if="lackRecommendation === suit" class="mj__lack--hint">推荐</text>
  </button>
</template>
```

**CSS 补充**（Board.vue scoped style 末尾）：
```scss
.mj__lack--recommend {
  border-color: $ftl-color-gold-deep !important;
  background: linear-gradient(180deg, rgba(255, 200, 80, 0.45), rgba(200, 130, 30, 0.5)) !important;
  color: $ftl-color-on-primary !important;
  box-shadow: 0 4px 12px rgba(255, 152, 0, 0.5) !important;
}
.mj__lack--hint {
  margin-left: 4px;
  font-size: 10px;
  color: $ftl-color-gold-light;
  font-weight: 700;
}
```

**闸纪律验证**
- [ ] 无 setTimeout/setInterval
- [ ] anim-lack-pulse 是循环动画，用 ease-in-out（已在 T1 animations.scss 里）
- [ ] H7 edge case 全覆盖（hand.length < 10 / hasUniqueMin / minCount === 0）

**提交**：
```bash
git commit -m "feat(mahjong): lackRecommendation 定缺推荐 + anim-lack-pulse 呼吸 (H1+H7 修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T6 · Board.vue：出牌 fly-out + hand key phase + flyingOutIndex + 发牌入场

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

### 6a · flyingOutIndex ref

在现有 ref 块（L85-88 附近）追加：
```ts
// 出牌 fly-out 追踪（D5-2 B2 修法：watch hand 变化时 reset）
const flyingOutIndex = ref(-1);
```

### 6b · watch hand 变化时 reset flyingOutIndex

现有 L91-97 的 watch：
```ts
watch(
  () => hand.value.map(tileType).join(','),
  () => {
    selected.value = [];
    lastClickIndex.value = -1;
    flyingOutIndex.value = -1; // ← 加这一行
  },
);
```

### 6c · 双击出牌路径 flyingOutIndex 赋值

`onTileClick` 函数里 isDoubleClick 分支（L117-124）：
```ts
if (isDoubleClick) {
  const tile = hand.value[index];
  if (tile && !props.busy) {
    flyingOutIndex.value = index; // ← 加在 submit 之前（B2+H4 修法）
    submit({ type: 'discard', tile });
    selected.value = [];
    lastClickIndex.value = -1;
  }
  return;
}
```

### 6d · hand key 改 phase（H2 修法）+ fly-out class + deal-in

手牌 v-for（L481-490）：
```html
<MahjongTile
  v-for="(tile, i) in hand"
  :key="`hand-${phase}-${i}`"  <!-- 从 hand-${i} 改成 hand-${phase}-${i} -->
  :tile="tile"
  size="lg"
  :selected="selected.includes(i)"
  :disabled="!handSelectable"
  :class="{
    'anim-fly-out': flyingOutIndex === i,
    'anim-deal-in': phase === 'play',
  }"
  :style="{ '--ftl-delay': `${i * 30}ms` }"
  @click="onTileClick(i)"
/>
```

注意：
- `anim-deal-in` 类已在 animations.scss L134-137 定义（不需要新建 keyframe）
- `anim-deal-in` 走 `backwards` 填充（L126-130 注释），播完归还 transform，不会压住选中态抬升
- `anim-fly-out` 走 `forwards` 填充，结束后 transform 停在飞出位置，但因为 hand key 变了（下一次重绘）整组 tile 重建，旧 DOM 卸载，不会永久卡住在飞出位置

**闸纪律验证**
- [ ] hand key 只纳入 phase（不纳入 version），避免每摸一张牌重挂载
- [ ] flyingOutIndex 在 watch hand 变化时 reset（B2 阻断修法；Vue watch 默认 flush='pre'，在 DOM 更新前 reset，不存在旧 class 残留）
- [ ] 无 setTimeout/setInterval
- [ ] anim-fly-out / anim-deal-in 类名都 anim- 前缀
- [ ] reduced-motion media query 已在 T1 追列
- [ ] **anim-fly-out 的 animation 属性会覆盖 anim-deal-in**（同为单个 class specificity）——被双击的牌只播 fly-out 不再播 deal-in，视觉上被飞出的牌本来就不该播入场动画，预期行为（计划审查 H2 登记）

**提交**：
```bash
git commit -m "feat(mahjong): flyingOutIndex + hand key phase + anim-fly-out + anim-deal-in (B2+H2+H4 修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T7 · Board.vue：initialBootDone + meldKey + MahjongMeld :pop 传值（B3 阻断修法）

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

### 7a · 新增 import

Board.vue 需要 onMounted：
```ts
import { computed, ref, watch, onMounted } from 'vue'; // onMounted 加进去
```

### 7b · initialBootDone + seenMeldKeys + 跨局 reset

```ts
// 防中途进入 mount 爆炸（B3 阻断修法）
const initialBootDone = ref(false);
const seenMeldKeys = new Set<string>();
const newMeldKeySet = ref<Set<string>>(new Set());

function meldKey(m: MahjongMeldView): string {
  return `${m.kind}:${m.tiles.map(tileType).join('_')}`;
}

// 计划审查 B2 阻断：新局开始时 reset seenMeldKeys（和 T4b 的 seenHuSeats reset 同 watch）
// 注意：T4b 已有 watch state 的 reset，合并成一个更干净。如果 T4b 的 watch 已经有了：
// 在那个 watch 的 newRound 分支里追加：
//   seenMeldKeys.clear();
//   newMeldKeySet.value.clear();
//   initialBootDone.value = false; // 让新局 onMounted 再次记录
// （计划审查 H5 登记：seenMeldKeys 是跨座位全局 Set，跨座位同 kind+同 tiles 副露极罕见可忽略）
```

### 7c · onMounted 记录已有副露

```ts
onMounted(() => {
  // 记录所有玩家的所有已有副露 key
  for (const seatMelds of props.view?.melds ?? []) {
    for (const m of seatMelds) {
      seenMeldKeys.add(meldKey(m));
    }
  }
  initialBootDone.value = true;
});
```

### 7d · watch melds 变化标记新增

```ts
watch(
  () => props.view?.melds ?? [],
  (allMelds) => {
    if (!initialBootDone.value) return;
    const newlySeen = new Set<string>();
    for (const seatMelds of allMelds) {
      for (const m of seatMelds) {
        const k = meldKey(m);
        newlySeen.add(k);
        if (!seenMeldKeys.has(k)) {
          seenMeldKeys.add(k);
          newMeldKeySet.value.add(k);
          // 给 500ms 时间让动画播完后清理（这里用 CSS animationend 事件清理，不用 JS timer）
          // —— 但如果不用 JS timer，那怎么让 newMeldKeySet 的临时标记消失？
          // —— MahjongMeld.vue 在 animationend 时 emit('pop-done')，Board.vue 收到后 delete
        }
      }
    }
  },
  { deep: true },
);

function onMeldPopDone(key: string) {
  newMeldKeySet.value.delete(key);
}
```

### 7e · myMelds 渲染改稳定 key + :pop prop

Board.vue L372-378 当前：
```html
<MahjongMeld
  v-for="(meld, i) in myMelds"
  :key="`my-meld-${i}`"
  :meld="meld"
  direction="my"
  size="sm"
/>
```

改成：
```html
<MahjongMeld
  v-for="meld in myMelds"
  :key="meldKey(meld)"
  :meld="meld"
  direction="my"
  size="sm"
  :pop="newMeldKeySet.has(meldKey(meld))"
  @pop-done="onMeldPopDone(meldKey(meld))"
/>
```

### 7f · 其他 SeatPanel 的 MahjongMeld pop

**Batch 2 决策（简化，计划审查 H4）**：**只给 Board.vue 的 myMelds 传 :pop**，其他座位的 MahjongMeld（在 SeatPanel 里）不传——减少跨组件 prop 传递链，也符合实际视觉焦点（自己的副露最显眼）。如果后续觉得其他座位也需要 pop，再给 SeatPanel 新增 `meldsPop` prop 传下去。

闸纪律验证：
- [ ] 无 setTimeout/setInterval（cleanup 靠 CSS animationend 事件，不是 JS 定时器）
- [ ] initialBootDone 在 onMounted 后才设 true，中途进入房已有副露一律不标记 new
- [ ] seenMeldKeys 是全局 Set，跨座位防重复

**提交**：
```bash
git commit -m "feat(mahjong): initialBootDone + seenMeldKeys 增量判定 + MahjongMeld :pop 传值 + 跨局 reset (B3+B2 阻断修法)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T8 · 全量验证 + 闸扫描

### 8a · VS Code 诊断（GetDiagnostics）
```
GetDiagnostics
```
预期：
- MahjongHuBanner.vue 新增文件零错误
- Board.vue / Meld.vue / SeatPanel.vue 改动零错误
- animations.scss 零错误

### 8b · 前端 lint（vue-tsc）
```bash
pnpm -C apps/client run lint
```
预期：可能仍报 vite/client 类型缺失（项目级已知问题 P1），但新增 Batch 2 文件不引入新错误。

### 8c · shared 回归
```bash
pnpm -C packages/shared test
```
预期：439 tests 全绿（Batch 2 零改动 shared）。

### 8d · protocol 回归（如环境支持）
```bash
pnpm -C packages/protocol test
```
预期：全绿（Batch 2 零改动 protocol）。

### 8e · JS 定时器闸扫描
```powershell
# 在 Batch 2 新增/修改的文件里 grep setTimeout/setInterval
Select-String -Path "apps/client/src/components/table/mahjong/MahjongBoard.vue","apps/client/src/components/table/mahjong/MahjongMeld.vue","apps/client/src/components/table/mahjong/MahjongSeatPanel.vue","apps/client/src/components/table/mahjong/MahjongHuBanner.vue","apps/client/src/styles/animations.scss" -Pattern "setTimeout|setInterval"
```
预期：**零命中**（animationend CSS 事件不是 JS 定时器）。

### 8f · prefers-reduced-motion media query 验证
```powershell
Select-String -Path "apps/client/src/styles/animations.scss" -Pattern "anim-meld-pop|anim-hu-banner|anim-fly-out|anim-active-glow|anim-lack-pulse" -Context 0,0
```
预期：media query 里每个新 anim- 类都有且仅有一次出现。

---

## 计划审查记录

### 第 1 轮 · 独立对抗 reviewer（v0.1 → 已修）

**2026-10-28**，独立 reviewer 读了计划 v0.1 + 所有 7 个关键源码文件（Board.vue L12/L91-97/L483/L498、animations.scss L134-137/L222-237、types.ts L17/L26-35 等）。

#### 阻断（3 个，全部已修）

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| **B1** | import 路径两层 `..` 错了 | 计划 T2/T3/T4a 写 `../../styles/animations.scss`，实际 Board.vue L498 是三层 | 三处全部改成 `../../../styles/animations.scss` |
| **B2** | seenHuSeats + seenMeldKeys 跨局残留脏数据 | 两个 Set 在一局结束（phase='ended'）后新局（phase='exchange'）不会自动 reset | T4b 追加 watch state 的 newRound reset；T7b 注释 seenMeldKeys 同 watch reset |
| **B3** | MahjongHuBanner.vue 有未使用的 `MahjongSuit` import | 计划 T4a 里错误写了 protocol import | 删掉未使用的 import |

#### 高（5 个，全部处置）

| # | 问题 | 处置 |
|---|---|---|
| **H1** | 全部 7 个 commit 消息缺 Co-Authored-By attribution | 每个 commit 消息末尾追加 `\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` |
| **H2** | anim-fly-out 覆盖 anim-deal-in 的 animation 属性（同为单个 class specificity） | T6d 闸纪律验证里加说明——被双击的牌本来就不该播入场动画，预期行为 |
| **H3** | T6d flyingOutIndex 文字解释有误（说新 DOM 一瞬间会有 fly-out class） | 实际 Vue watch 默认 flush='pre'，在 DOM 更新前 reset，不存在残留。闸纪律验证里修正了说明 |
| **H4** | T7f 做法 A/B 冗余 | 删掉做法 A，直接给简化决策的清晰描述 |
| **H5** | seenMeldKeys 跨座位同 kind+同 tiles 概率极低 | 登记即可（每种牌只有 4 张） |

#### 低（3 个，登记即可）
- L1: `bannerQueue` 用 ref 数组 + `.shift()` 变异不触发 Vue 响应式——OK（只是取第一个不需要视图更新）
- L2: `@pop-done="onMeldPopDone(meldKey(meld))"` 每次渲染创建新闭包——微小性能开销，可接受
- L3: 设计文档 D3 曾写 `info.isZimo` 但 protocol 实际是 `selfDraw`——计划代码正确，实现时别被设计文档误导

#### 审查结论

v0.1 阻断 3 个全修、高 5 个全处置、低 3 个登记。计划现在可以进入 Step 6：TDD 实现。

---

## 任务状态

| 任务 | 状态 | 备注 |
|---|---|---|
| T1 · animations.scss 追加 7 keyframe + 7 anim- 类 + reduced-motion 追列 | ✅ 已写 | |
| T2 · MahjongMeld.vue：import + pop prop + 增量动画 + 稳定 key | ✅ 已写 | |
| T3 · MahjongSeatPanel.vue：import + active glow | ✅ 已写 | |
| T4 · 新建 MahjongHuBanner.vue + Board.vue banner 逻辑 + 定位 | ✅ 已写 | |
| T5 · Board.vue：定缺推荐 lackRecommendation + anim-lack-pulse | ✅ 已写 | |
| T6 · Board.vue：出牌 fly-out + hand key phase + flyingOutIndex + 发牌入场 | ✅ 已写 | |
| T7 · Board.vue：initialBootDone + seenMeldKeys + MahjongMeld :pop 传值 + 跨局 reset | ✅ 已写 | |
| T8 · 全量验证 + 闸扫描 | ✅ 已写 | 实现后执行 |
