# 四川麻将 UI 升级 · Batch 4 设计 v0.2

> **状态**：设计 v0.2（阻断已全修，待计划 + TDD）
> **定位**：Batch 3 "玩起来顺畅" → **Batch 4 "交互完整"**。弃牌点击 claim + 长按手牌看牌型 + SeatPanel 胡牌番型展示 + claim 窗口多家 active 差异化发光。
> **硬约束**：纯客户端 `apps/client/src/`，零 protocol / shared / game-service / room-service / config-service / admin 改动。**零聊天功能**（用户显式裁决）。

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | A+B+C+D 四个一起做 | Batch 4 范围 = 弃牌点击 claim + 长按看牌型 + 胡牌番型 + active 差异化 |
| K2 | 继续纯客户端 | 现有协议字段足够，零新增 |
| K3 | 不做聊天功能 | 零 chat/emoji/voice/回放 |

---

## §1 范围总览

| 组 | 主题 | 关键文件 | 复杂度 |
|---|---|---|---|
| **A** | 弃牌点击触发 claim 预览 | SeatPanel.vue + Board.vue + ClaimTile.vue | 低 |
| **B** | 长按手牌弹出"打出后仍能听" | Board.vue | 低（布尔判断，不做牌库搜索） |
| **C** | SeatPanel 胡牌番型展示（emoji + items + selfDraw） | SeatPanel.vue | 低 |
| **D** | claim 窗口多家 active 差异化发光 | SeatPanel.vue | 低 |

### Batch 4 不做（明确排除）

| # | 排除项 | 原因 |
|---|---|---|
| ✅ | **聊天/表情/语音/回放** | 用户显式裁决 |
| ✅ | SeatPanel 对手听牌徽标 | 需服务端 view 给其他座位推 tingTiles |
| ✅ | 精确到某张手牌的听牌关联高亮 | 需客户端算牌库（Batch 4 改用布尔判断） |
| ✅ | 出牌拖拽/上滑 | pure touch 实现 + 真机调优，放 Batch 5 |
| ✅ | 新增 protocol 字段 | 纯客户端 |

---

## §2 关键协议事实（已验证）

| 字段 | 位置 | 用途 |
|---|---|---|
| `MahjongClaimOption.tile?: Tile` | types.ts | **A 组核心**：服务端填 tile（点炮胡 tile=弃牌，自摸胡 tile=lastDraw），**永远不会是 undefined**（阻断 B2 修法） |
| `MahjongClaimOption.claim: MahjongClaim` | types.ts | 四值 hu/gang/peng/pass（Batch 3 已验证） |
| `MahjongHuInfo.items: string[]` | types.ts | **C 组核心**：番型字符串数组，SeatPanel 只渲染 fan 没渲染 items |
| `MahjongHuInfo.selfDraw: boolean` | types.ts | **C 组核心**：自摸 vs 点炮区分 |
| `activeSeats: number[]` | Board.vue L69 | **D 组核心**：血战 claim 窗口可能多家 active |
| `tingTiles?: Tile[]` | types.ts | **B 组核心**：客户端已有"我能赢哪些牌"数据 |
| `hand: Tile[]` | types.ts | **B 组核心**：本地可做不含判断 |

---

## §3 设计细节

### D-A · 弃牌点击触发 claim 预览

#### 现状

- Board.vue L526-534 + SeatPanel.vue L102-112 弃牌**纯展示**，无 click 事件
- claimsForMe 由服务端**自动过滤** phase==='claim' 的响应选项，客户端被动接收

#### 方案

**Step 1 — 弃牌 Tile 可点**

Board.vue `.mj__my-river` 和 SeatPanel.vue `.mj-river` 的 MahjongTile 加 `@click`。

SeatPanel 弃牌点击需要 emit 事件让 Board.vue 统一处理（因为 filteredClaimsForDiscard 的计算逻辑在 Board.vue）。但 Board.vue 的 SeatPanel 用 `v-bind="seatPanelProps()"` 传 props，弃牌在 SeatPanel 内部渲染。

**简化修法**（高项 H5 采纳）：SeatPanel 弃牌点击 emit 'discard-click' 事件，Board.vue 在 seatPanelProps 里不加事件（因为 `v-bind` 只传 props），而是在 Board.vue 里手动给每个 SeatPanel 加 `@discard-click="onSeatDiscardClick(seat, tile)"`。

SeatPanel.vue 新增 emit：
```ts
const emit = defineEmits<{
  (e: 'discard-click', tile: Tile): void;
}>();
```

SeatPanel 弃牌渲染加 `@click="emit('discard-click', tile)"`。

Board.vue 模板改：
```vue
<MahjongSeatPanel
  v-bind="seatPanelProps(leftSeat)"
  :direction="directionOf(leftSeat)"
  compact
  @discard-click="onSeatDiscardClick(leftSeat, $event)"
/>
```

**Step 2 — 点击过滤 claimsForMe**

Board.vue 新增（阻断 B2 修法：**删掉错误的 tile===undefined 条件**）：
```ts
const discardClickTarget = ref<Tile | null>(null);

function onSeatDiscardClick(seat: number, tile: Tile) {
  if (phase.value !== 'claim' || !amActive.value) return;
  // 再次点击同一张 → 取消
  if (discardClickTarget.value && tileType(discardClickTarget.value) === tileType(tile)) {
    discardClickTarget.value = null;
    return;
  }
  discardClickTarget.value = tile;
}

// ClaimTile 的 filteredOptions prop 用
const filteredClaimsForDiscard = computed<MahjongClaimOption[]>(() => {
  if (!discardClickTarget.value) return myClaims.value; // 未选中 → 全量
  // 只保留 tile 匹配的 claim；claim='hu' 也在 claim 窗口（点炮胡 tile=弃牌）
  const tt = tileType(discardClickTarget.value);
  return myClaims.value.filter(opt => opt.tile && tileType(opt.tile) === tt);
});
```

**阻断 B2 验证**：
- game-service 给任何 hu 都填 tile（自摸胡 tile=lastDraw，点炮胡 tile=弃牌）——**永远不会是 undefined**
- claim 窗口 phase==='claim' 时 activeSeats 是点炮响应者，hu 的 tile 就是弃牌 —— 过滤自然命中
- 自摸胡在 phase==='play' 时由 Board.vue L217-225 的 onClaimOption 处理（submit selfDrawHu），不在 claim 窗口

**高项 H1 — reset 时机**：
```ts
// phase 变非 claim → 清；myClaims 变化（服务端换了窗口）→ 清
watch(phase, (to) => { if (to !== 'claim') discardClickTarget.value = null; });
watch(myClaims, () => { discardClickTarget.value = null; }, { deep: true });
```

**Step 3 — ClaimTile 组件扩展**

ClaimTile.vue 新增 `filteredOptions?: MahjongClaimOption[]` prop（高项 H5 采纳）：
- 传入 filteredOptions 时用它渲染，不传或空时用 options（现有行为）
- 这样过滤逻辑在 Board.vue，ClaimTile 只管渲染

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

**Step 4 — 视觉反馈（高项 H6 采纳）**

弃牌选中态**不用 box-shadow**（避免和 `.mj__discard--latest` 金色 box-shadow 叠加），改用 outline：

```scss
.mj__discard--selected {
  outline: 2px solid $ftl-color-blue;
  outline-offset: -2px; // 向内收缩，不碰 latest 的 box-shadow
  // 不用 transform 或 scale（避免挤压周围弃牌）
}
```

Board.vue 模板里 my-river 的 MahjongTile 加：
```vue
:class="{ 'mj__discard--selected': discardClickTarget && i === myDiscards.length - 1 }"
```
（claim 窗口的弃牌就是最新弃牌 i=length-1）

SeatPanel.vue 里也加同样的逻辑（需要 Board.vue 把 discardClickTarget 传给 SeatPanel 或让 SeatPanel 自己加——**A 组只在 Board.vue 的 my-river 点击**，SeatPanel 弃牌点了只是 emit 事件，视觉反馈只在 Board.vue 的中央 claim-tile 区域显示过滤后的选项，SeatPanel 里的弃牌不加 selected 高亮）。

### D-B · 长按手牌弹出"打出后仍能听"

#### 现状

- 手牌**只有 click**（单击选中 / 双击出牌），无长按识别
- tingTiles 已渲染在 `.mj__ting` 区域，但**手牌里哪张打出后 ting 不变**完全没展示

#### 方案

**阻断 B1 — 用 uni-app 内置 @longpress，零 setTimeout**

根据 uni-app 官方文档（uniapp.dcloud.net.cn），`@longpress` 是内置事件，H5/小程序/App 三端都支持。触发后**不会触发后续的 @click**（天然没有幽灵 click，高项 H3 一并解决）。

Board.vue 手牌 MahjongTile 加 `@longpress`：
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
/>
```

```ts
const handHintIndex = ref<number | null>(null);

function onTileLongPress(index: number) {
  if (!handSelectable.value || phase.value !== 'play') return;
  if (props.settlementArrived) return;
  handHintIndex.value = index;
}

// 关闭弹层
watch(phase, () => { handHintIndex.value = null; });
watch(() => hand.value.length, () => { handHintIndex.value = null; });
function closeHandHint() { handHintIndex.value = null; }
```

**闸纪律验证**：
- `@longpress` 是 uni-app 框架**原生事件**，内部实现由框架负责
- 零手写 setTimeout，完全符合 animations.scss L26 "牌桌区不新造时钟"纪律
- 同时解决了高项 H3（长按触发后不触发 click，天然无幽灵 click）

**高项 H4 — 简化弹层**

只做**布尔判断**，不做牌库搜索：
- 手牌里**不包含**这张 → tingTiles 不变 → 弹层显示"打出后仍能听"
- 手牌里**包含**这张 → tingTiles 可能变 → 弹层显示"打出后可能影响听牌"

```ts
const handHintAffected = computed(() => {
  if (handHintIndex.value === null) return null;
  const hintTile = hand.value[handHintIndex.value];
  if (!hintTile) return null;
  // 手牌不含这张 → ting 不受影响
  const handWithout = hand.value.filter((_, i) => i !== handHintIndex.value!);
  const stillHas = handWithout.some(t => tileType(t) === tileType(hintTile));
  return {
    tile: hintTile,
    stillSafe: !stillHas, // 手牌打完这张就没了 → ting 不变
  };
});
```

弹层 UI（Board.vue 内 view，不新建文件）：
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

弹层样式：轻量浮层，半透明背景遮罩（整个 Board 区），点击遮罩关闭。

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

### D-C · SeatPanel 胡牌番型展示

#### 现状

SeatPanel.vue L81-83：只有 `hu.fan`（番数），没有番型（`hu.items: string[]`），也没有 selfDraw 区分。

#### 方案

SeatPanel.vue 内部定义 FAN_EMOJI 映射（不抽 utils，纯数据常量），和 Batch 3 Settlement.vue 保持一致。

```vue
<!-- SeatPanel.vue L78-92 区域替换 -->
<view v-if="hasMeta" class="mj-seat__meta">
  <text v-if="lackLabel" class="mj-seat__badge mj-seat__badge--lack">{{ lackLabel }}</text>
  <text v-if="trustee" class="mj-seat__badge">托管</text>
  <template v-if="hu">
    <text class="mj-seat__badge mj-seat__badge--hu">
      {{ hu.selfDraw ? '自摸' : '胡' }}{{ hu.fan > 0 ? ` ${hu.fan}番` : '' }}
    </text>
    <text
      v-if="hu.items.length > 0"
      class="mj-seat__badge mj-seat__badge--fan"
      :title="hu.items.join('、')"
    >
      {{ fanEmoji(hu.items[0]) }}{{ hu.items[0] }}
      <text v-if="hu.items.length > 1" class="mj-seat__badge--fan-more">等{{ hu.items.length }}种</text>
    </text>
  </template>
  <text v-else-if="isOut" class="mj-seat__badge mj-seat__badge--out">已出局</text>
  ...
</view>
```

```ts
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  // 四川麻将番型补充
  龙七对: '🐉', 清对: '🎯', 对对胡: '🃏', 将对: '⚔️',
};
function fanEmoji(name: string): string { return FAN_EMOJI[name] ?? '🏆'; }
```

新增 badge class：
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

### D-D · claim 窗口多家 active 差异化发光

#### 现状

Batch 2 已给 `.mj-seat--active` 加了 `anim-active-glow` box-shadow 循环（animations.scss L299-302）。血战到底 claim 窗口时 activeSeats 可能 2-4 家同时发光——"到底谁最该响应"不明确。

#### 方案

**阻断项：active prop 类型变更**

现有 SeatPanel.vue 有 `active: boolean` prop。改成 `activeLevel: 'strong' | 'weak' | null`（高项 H2 采纳）。

**Board.vue 改传 activeLevel**：
```ts
function seatActiveLevel(seat: number): 'strong' | 'weak' | null {
  const idx = activeSeats.value.indexOf(seat);
  if (idx === -1) return null;
  if (phase.value === 'claim') {
    // claim 窗口：最早 active = 最紧迫 = 强发光，其余弱发光
    return idx === 0 ? 'strong' : 'weak';
  }
  // play / exchange / lack 窗口：单回合只有一个 active → 都用 strong
  return 'strong';
}
```

**seatPanelProps 改**：
```ts
function seatPanelProps(seat: number) {
  return {
    ...
    activeLevel: seatActiveLevel(seat),
    // 删掉 active: activeSeats.value.includes(seat),
    ...
  };
}
```

**SeatPanel.vue 改 prop + CSS**：

删掉旧的 `active: boolean` prop，新增 `activeLevel?: 'strong' | 'weak' | null`。

```vue
<view
  class="mj-seat"
  :class="{
    'mj-seat--me': isMe,
    'mj-seat--out': isOut,
    'mj-seat--compact': compact,
    'mj-seat--active-strong': activeLevel === 'strong',
    'mj-seat--active-weak': activeLevel === 'weak',
  }"
>
```

**CSS（SeatPanel scoped style 内部）**：
```scss
// 删掉旧的 .mj-seat--active + anim-active-glow 引用
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

// 高项 H2 修法：组件 scoped 动画在组件内加 reduced-motion 规则
// animations.scss 的 media query 管不到组件内新定义的 scoped 动画 keyframe 引用
// 但这里我们是复用 ftl-active-glow（全局 keyframe），动画类名仍在 animations.scss 的
// reduced-motion media query 里被覆盖 —— 实际上 anim-active-glow 已在 L342 被覆盖
// 但因为我们不再用 .anim-active-glow 类名，而是直接在 CSS 里写 animation 属性，
// 所以需要在组件里自己加 reduced-motion 规则：
@media (prefers-reduced-motion: reduce) {
  .mj-seat--active-strong,
  .mj-seat--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2); // reduced-motion 下只保留弱发光
  }
}
```

**闸纪律**：
- 复用现有 `ftl-active-glow` keyframe（只调整 animation-duration 和 box-shadow）
- 不新增 keyframe
- SeatPanel 组件内的 scoped reduced-motion 规则覆盖 .mj-seat--active-strong/weak

---

## §4 涉及文件

| 操作 | 文件 | 说明 |
|---|---|---|
| **修改** | `MahjongBoard.vue` | A 组：discardClickTarget + filteredClaimsForDiscard + SeatPanel @discard-click + handHintIndex + seatActiveLevel；B 组：@longpress + handHintAffected + 弹层 |
| **修改** | `MahjongSeatPanel.vue` | A 组：弃牌 emit discard-click；C 组：FAN_EMOJI + hu.items + selfDraw；D 组：activeLevel prop + 两套 active CSS + reduced-motion |
| **修改** | `ClaimTile.vue` | A 组：新增 filteredOptions prop，优先用它渲染 |
| **不动** | `animations.scss` | 复用现有 keyframe；D 组 SeatPanel 直接在 CSS 里引用 ftl-active-glow |

**明确不动**：
- protocol / shared / game-service / room-service / config-service / admin
- useTableSound.ts / Settlement.vue / HuBanner.vue / Meld.vue / Tile.vue
- animations.scss 现有 keyframe（只复用不新增）
- **任何聊天/表情/语音/回放相关文件**

---

## §5 闸纪律验证清单

- [x] 零新增 protocol 字段
- [x] 零新增 JS setTimeout（@longpress 是 uni-app 内置事件，框架实现）
- [x] 动画起始态可见（SeatPanel active-strong/weak 只动 animation-duration + box-shadow，复用 ftl-active-glow）
- [x] 所有组件 `@import '../../../styles/animations.scss'`（三层 ..）
- [x] 循环动画用 ease-in-out（ftl-active-glow 本身就是）
- [x] reduced-motion 覆盖：animations.scss 管 anim-active-glow，SeatPanel 自己加 .mj-seat--active-strong/weak 的 reduced-motion
- [x] 零聊天功能相关改动

---

## §6 阻断修法 vs 原审查

| 阻断 | 原设计问题 | v0.2 修法 |
|---|---|---|
| **B1 长按 setTimeout 违反闸纪律** | v0.1 用手写 setTimeout，违反 animations.scss L26 | **改用 uni-app 内置 @longpress**（uniapp.dcloud.net.cn 文档确认），零 setTimeout，同时天然无幽灵 click（H3 一并解决） |
| **B2 自摸胡 tile===undefined 条件错误** | `opt.claim === 'hu' && opt.tile === undefined` 永远不命中——game-service 任何 hu 都填 tile | **删掉条件**，filter 只按 tileType 匹配；自摸胡在 play 窗口响应，不在 claim 窗口 |
| **H1 discardClickTarget 缺 reset** | 未考虑 phase 切换或 myClaims 变化 | 加两个 watch（phase !== 'claim' → 清；myClaims deep 变化 → 清） |
| **H2 SeatPanel active CSS 遗留** | 改 activeLevel 后旧 .mj-seat--active + anim-active-glow 成死代码 | 两套 .mj-seat--active-strong/weak CSS；组件内加 reduced-motion（animations.scss media query 管不到 scoped style 里直接写的 animation 属性） |
| **H3 长按幽灵 click** | 如果用 touchstart/touchend + setTimeout，长按触发后 click 仍会触发 | @longpress 是 uni-app 框架事件，触发后不触发 click，天然无此问题 |
| **H4 弹层文案误导** | v0.1 简化方案"同花色重叠判断"告诉玩家没用信息 | **纯布尔判断**：手牌打完这张就没了 → ting 不变（"仍能听"），否则 → "可能影响"；不做牌库搜索 |
| **H5 A 组过滤后交互流不清晰** | Board.vue 过滤结果怎么传递给 ClaimTile | **ClaimTile 新增 filteredOptions prop**，优先用它渲染；Board.vue 计算后传入 |
| **H6 box-shadow 叠加** | `.mj__discard--selected` 用 box-shadow 和 `.mj__discard--latest` 金色 box-shadow 叠加冲突 | **改用 outline: 2px solid**（不叠加、不替换） |

---

## §7 审查记录

### 第 1 轮（v0.1 → v0.2）

**阻断修法验证**：
1. ✅ uni-app @longpress —— 官方文档 uniapp.dcloud.net.cn 确认内置，H5/小程序/App 三端支持
2. ✅ game-service hu 永远填 tile —— Batch 3 审查已验证（game-service L58-62），自摸胡 tile=lastDraw，点炮胡 tile=弃牌
3. ✅ animations.scss L26 原文 "牌桌区不新造时钟" —— @longpress 是框架实现，零手写 setTimeout，完全符合
4. ✅ ClaimTile filteredOptions prop —— 最小改动，现有 options prop 兼容不变
5. ✅ outline vs box-shadow —— Batch 3 .mj__discard--latest 已用金色 box-shadow，outline 不叠加不冲突
6. ✅ SeatPanel activeLevel reduced-motion —— 组件内 scoped 动画属性（不是 anim- 类引用），animations.scss media query 管不到，需组件自己加

### 第 2 轮（待计划审查）

计划阶段按 dev-process.md 走：实现计划 → 对抗审查 → TDD → 代码审查。
