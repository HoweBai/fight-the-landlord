# 四川麻将 UI 升级 · Batch 3 实现计划 v0.1

> **依据**：`docs/superpowers/specs/2026-10-28-mahjong-ui-batch3-design.md` v0.2（4 阻断 / 9 高 / 3 低全处置）。
> **分支**：`majiang`。**接触面**：纯客户端 `apps/client/src/`，**零改动** protocol / shared / game-service / room-service / config-service / admin / 任何聊天功能。
> **计划审查待完成**（本计划写完即送独立 reviewer）。

## Global Constraints

- **闸纪律（animations.scss 顶部注释）**：`@import` 进组件，不能 `@use`；**只从位移/缩放起手**（零 opacity 起始）；零 JS 定时器；错峰靠内联 `--ftl-delay`。
- **新 keyframe 类名统一 `anim-` 前缀**。
- **循环动画用 `ease-in-out`，一次性动画用 `$ftl-ease`**。
- **`@media (prefers-reduced-motion: reduce)` 手动追加所有新 `anim-` 类**。
- **不动现有 `ftl-settlement-in`**（斗地主/跑得快三处共用），新建麻将专用 `ftl-mj-settlement-in`。
- **claimLabel 用 `opt.claim` 四值**（hu/gang/peng/pass），不是 `opt.kind`。Board.vue L190-200 现有实现已经正确用 `opt.claim`，Batch 3 只加 fan 字段展示。
- **Board.vue 只有 `seconds: number` prop**（由 table.vue useCountdown 驱动），没有独立 turnDeadline ref——Batch 3 不造独立倒计时。
- **SeatPanel 不传 ting prop**——game-service tingTiles 只给接收者自己算。
- **claim 窗口只在 Board.vue phase==='claim' 时替换成 ClaimTile**，play 窗口自摸胡/杠不改。
- **claimsForMe 多胡候选排序要防御式拷贝**：`[...props.options].sort((a, b) => (b.fan ?? 0) - (a.fan ?? 0))`。
- **MahjongFanDetail.items: string[]**（番型是中文字符串）——emoji 映射表拿中文 key 查。
- **animations.scss import 路径三层 `..`**：`@import '../../../styles/animations.scss'`。
- **shared 439 tests / protocol tests 必须保持全绿**。
- **无聊天功能**：零 chat/emoji/voice/回放相关文件改动。

---

## 任务总览

| 任务 | 内容 | 主要文件 | commit 粒度 |
|---|---|---|---|
| T1 | animations.scss 追加 ftl-claim-pulse + ftl-mj-settlement-in + 2 anim- 类 + reduced-motion 追列 | animations.scss | 1 commit |
| T2 | **新建** ClaimTile.vue | 新建组件 | 1 commit |
| T3 | Board.vue：claimLabel 加 fan 展示 + claim 窗口换成 ClaimTile + hand ting 高亮 + hand hint + exchange 计数 + 弃牌最新标记 | Board.vue | 1 commit |
| T4 | MahjongSeatPanel.vue：弃牌最新标记 + 渐隐遮罩 + .mj-river 类名 | SeatPanel.vue | 1 commit |
| T5 | MahjongSettlement.vue：入场动效换成 anim-mj-settlement-in + 番型 emoji + 金币冻结视觉 | Settlement.vue | 1 commit |
| T6 | 全量验证 + 闸扫描 | 多文件只读 | 验证 |

---

## T1 · animations.scss 追加 2 keyframe + 2 anim- 类 + reduced-motion 追列

**Files**
- 修改 `apps/client/src/styles/animations.scss`

**新增 keyframe（2 个，麻将专用）**

放在现有 `ftl-urgent-pulse` / `ftl-lack-pulse` 后面（Batch 2 已加）：

```scss
// —— 麻将 Batch 3 动画（2026-10-28）——

/// Claim 窗口呼吸：1.6s 循环 scale（和 lack-pulse 类似但更紧凑的 claim 紧急态）。
@keyframes ftl-claim-pulse {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.05); }
}

/// 麻将专用结算入场：从缩小 0.8 + 上方 20px 入场。只从位移/缩放起手（阻断 B3 修法）。
/// 不动现有的 ftl-settlement-in（斗地主/跑得快共用），这是麻将独立版本。
@keyframes ftl-mj-settlement-in {
  from { transform: scale(0.8) translateY(20px); }
  to   { transform: none; opacity: 1; }
}
```

**新增 anim- 类（2 个）**，放在 Batch 2 的 anim- 类后面：

```scss
/// Claim 窗口呼吸（循环，ease-in-out）。
.anim-claim-pulse {
  animation: ftl-claim-pulse 1.6s ease-in-out infinite;
}
/// 麻将专用结算入场（一次性，$ftl-ease）。
.anim-mj-settlement-in {
  animation: ftl-mj-settlement-in 0.36s $ftl-ease both;
}
```

**reduced-motion 更新**：在 `@media (prefers-reduced-motion: reduce)` 的逗号列表末尾（现有 17 个 anim- 类后面）追加：
```
.anim-claim-pulse,
.anim-mj-settlement-in
```

**闸纪律验证**
- [ ] ftl-mj-settlement-in 起始态**只用 transform**（零 opacity 起始，阻断 B3 修法）
- [ ] ftl-claim-pulse 起始态可见（只 transform scale）
- [ ] 一次性动画用 $ftl-ease，循环用 ease-in-out
- [ ] anim- 前缀统一
- [ ] reduced-motion 手动追列（Batch 2 已追 17 个，现在 19 个）
- [ ] 不动现有 ftl-settlement-in（斗地主/跑得快继续用 0.24s 版本）

**提交**：
```bash
git commit -m "feat(mahjong): animations.scss 追加 claim-pulse + mj-settlement-in (麻将专用入场)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T2 · 新建 ClaimTile.vue

**Files**
- 新建 `apps/client/src/components/table/mahjong/ClaimTile.vue`

**组件设计**：

```vue
<script setup lang="ts">
/**
 * Claim 窗口独立组件。展示 claimsForMe 选项，胡候选按番数降序。
 * 只替换 Board.vue phase==='claim' 的按钮块，不动 play 窗口自摸胡/杠。
 *
 * Batch 3 闸纪律：
 *   - 胡候选用 opt.claim === 'hu'（不是 opt.kind），阻断 B1 修法
 *   - 多番防御式拷贝 sort，mutate 原数组
 *   - claim 响应**不造独立倒计时**（阻断 B4 砍掉，Board.vue 无 turnDeadline）
 */
import { computed } from 'vue';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';

const props = withDefaults(defineProps<{
  options: MahjongClaimOption[];
  busy?: boolean;
  showPass?: boolean;
  phase?: 'claim' | 'play' | string;
}>(), { busy: false, showPass: true });

const emit = defineEmits<{
  (e: 'claim', opt: MahjongClaimOption): void;
  (e: 'pass'): void;
}>();

// 阻断 B1 修正：sortedOptions 防御式拷贝 sort（不 mutate service 原数组）
const sortedOptions = computed(() =>
  [...props.options].sort((a, b) => (b.fan ?? 0) - (a.fan ?? 0)),
);

/** claim 候选 label：用 opt.claim 四值（不是 opt.kind）。 */
function claimLabel(opt: MahjongClaimOption): string {
  switch (opt.claim) {
    case 'peng': return '碰';
    case 'gang': return '杠'; // phase 区分暗杠/补杠的逻辑留在 Board.vue（现有实现 L192-196）
    case 'hu': {
      const base = opt.fan ? `${opt.fan} 番胡` : '胡';
      return base; // 是否显示"自摸"由 Board.vue 的 phase 区分
    }
    case 'pass': return '过';
  }
}

function optClass(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return 'mj-claim-tile__opt--hu';
  if (opt.claim === 'gang') return 'mj-claim-tile__opt--gang';
  return '';
}
</script>

<template>
  <view class="mj-claim-tile anim-claim-pulse">
    <text class="mj-claim-tile__prompt">可响应</text>
    <view class="mj-claim-tile__opts">
      <button
        v-for="(opt, i) in sortedOptions"
        :key="i"
        class="btn mj-claim-tile__opt"
        :class="optClass(opt)"
        :disabled="busy"
        @click="emit('claim', opt)"
      >
        {{ claimLabel(opt) }}
      </button>
      <button
        v-if="showPass"
        class="btn mj-claim-tile__pass"
        :disabled="busy"
        @click="emit('pass')"
      >过</button>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import '../../../styles/animations.scss'; // 三层 ..，闸纪律

.mj-claim-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  border: 2px solid rgba($ftl-color-gold, 0.6);
  background: rgba($ftl-color-gold, 0.15);
}
.mj-claim-tile__prompt {
  font-size: $ftl-font-sm;
  color: $ftl-color-gold;
  font-weight: 600;
  text-align: center;
}
.mj-claim-tile__opts {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}
.mj-claim-tile__opt--hu {
  background: rgba($ftl-color-gold, 0.4) !important;
  border-color: $ftl-color-gold-deep !important;
}
.mj-claim-tile__opt--gang {
  background: rgba($ftl-color-gold, 0.25) !important;
}
.mj-claim-tile__pass {
  opacity: 0.6;
}
</style>
```

**闸纪律验证**
- [ ] @import 三层 ..
- [ ] 零 setTimeout/setInterval
- [ ] anim-claim-pulse 类名 anim- 前缀
- [ ] 起始态可见（ftl-claim-pulse 只 transform scale）
- [ ] 不造独立倒计时（无任何 deadline/deadlineAt 引用）

**提交**：
```bash
git commit -m "feat(mahjong): ClaimTile 组件（claim 窗口 claimLabel 用 opt.claim 四值）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T3 · Board.vue 四处改动

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

### 3a · claimLabel 加 fan 展示

现有 L190-200：
```ts
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return phase.value === 'play' ? '自摸胡' : '胡';
  if (opt.claim === 'gang') {
    if (phase.value === 'play' && opt.tile) {
      return selfGangAction(opt.tile).type === 'concealedGang' ? '暗杠' : '补杠';
    }
    return '杠';
  }
  if (opt.claim === 'peng') return '碰';
  return '过';
}
```

**Batch 3 只加 fan 字段展示**（保留暗杠/补杠区分逻辑）：
```ts
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') {
    const fanPart = opt.fan ? `${opt.fan} 番` : '';
    return `${fanPart}${phase.value === 'play' ? '自摸胡' : '胡'}`;
  }
  if (opt.claim === 'gang') {
    if (phase.value === 'play' && opt.tile) {
      return selfGangAction(opt.tile).type === 'concealedGang' ? '暗杠' : '补杠';
    }
    return '杠';
  }
  if (opt.claim === 'peng') return '碰';
  return '过';
}
```

### 3b · claim 窗口换成 ClaimTile（阻断 B1 修法 + Board.vue 补函数）

现有 L590-602 claim 按钮块替换成 ClaimTile。**阻断 B1 修法**：Board.vue 没有 submitClaim/submitPass/canPass，也没有 `type: 'pass'`（actions.ts L11-18 确认 MahjongAction 无 type:'pass'，pass 是 claim 四值）。

**补三个定义**（放在 Board.vue 现有函数附近）：
```ts
// 阻断 B1：submit 正确调用方式
function submitClaim(opt: MahjongClaimOption) {
  submit({ type: 'claim', claim: opt.claim, tile: opt.tile });
}
function submitPass() {
  // pass 是 MahjongClaim 四值之一（不是 MahjongAction type）
  submit({ type: 'claim', claim: 'pass' });
}
const canPass = computed(() =>
  (phase.value === 'claim' || phase.value === 'play') && myClaims.value.length > 0,
);
```

模板替换：
```vue
<ClaimTile
  v-else-if="!settlementArrived && phase === 'claim' && amActive"
  :options="myClaims"
  :busy="busy"
  :show-pass="canPass"
  @claim="submitClaim"
  @pass="submitPass"
/>
```

### 3c · 手牌整体 ting 高亮 + hand hint（阻断 B3 修法 + 高项 H2/H4 处置）

手牌容器 L510：
```vue
<view class="mj__hand mj__hand--relative" :class="{ 'mj__hand--ting': tingTiles.length > 0 }">
```

**阻断 B3 修法**：`.mj__hand` 没有 position: relative（Board.vue L896-905 确认），两个 absolute 会错位。加一个修饰类 `mj__hand--relative`（或直接改 .mj__hand 加 `position: relative`）。

**高项 H2 处置**：Board.vue L536 动作栏已有 exchange 计数 `<text>已选 {{ selected.length }}/3</text>`——Batch 3 只保留 hand hint 的 **play 窗口"再点一次出牌"提示**，exchange 计数**不去 hand hint 重复加**：

```vue
<view
  v-if="phase === 'play' && handSelectable && selected.length === 1"
  class="mj__hand-hint"
>
  <text>再点一次出牌（或点"出牌"按钮）</text>
</view>
```

CSS：
```scss
.mj__hand--relative { position: relative; }
.mj__hand--ting {
  &::after {
    content: '听牌中';
    position: absolute;
    top: -20px;
    right: 0;
    font-size: 10px;
    color: $ftl-color-gold;
    font-weight: 700;
    background: rgba($ftl-color-gold, 0.2);
    padding: 2px 6px;
    border-radius: 4px;
  }
}
.mj__hand-hint {
  position: absolute;
  bottom: -16px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: $ftl-color-gold-light;
  opacity: 0.8;
  pointer-events: none;
}
```

### 3d · 弃牌最新标记

Board.vue `.mj__my-river` v-for（L510-518），给最后一张加 class：
```vue
<MahjongTile
  v-for="(tile, i) in myDiscards"
  :key="`my-discard-${i}`"
  :tile="tile"
  size="sm"
  direction="my"
  :class="{ 'mj__discard--latest': i === myDiscards.length - 1 && myDiscards.length > 0 }"
/>
```

CSS：
```scss
.mj__discard--latest {
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.5);
}
```

**闸纪律验证**
- [ ] ClaimTile import 路径正确（三层 .. 相对路径 `./ClaimTile.vue`）
- [ ] claimLabel 用 opt.claim 四值，保留暗杠/补杠区分逻辑
- [ ] ting 手牌整体高亮是纯视觉，不依赖 protocol 新字段
- [ ] hand hint / exchange 计数是纯展示层
- [ ] 弃牌最新标记 box-shadow 不被 overflow:hidden 裁（Board.vue `.mj__my-river` 用的是 flex 不是 overflow:hidden）

**提交**：
```bash
git commit -m "feat(mahjong): Board.vue claimLabel+fan + ClaimTile接线 + ting高亮 + hand hint +弃牌标记

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T4 · MahjongSeatPanel.vue 弃牌最新标记 + 渐隐遮罩 + 类名

**Files**
- 修改 `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`

### 4a · 弃牌最新标记

SeatPanel v-for discards（L102-110），给最后一张 MahjongTile 加 class：
```vue
<MahjongTile
  v-for="(tile, i) in discards"
  :key="`discard-${i}`"
  :tile="tile"
  size="sm"
  :direction="direction"
  :class="{ 'mj__discard--latest': i === discards.length - 1 && discards.length > 0 }"
/>
```

### 4b · 渐隐遮罩 + .mj-river 类名

SeatPanel L102-110 `.mj-seat__row--river` view：
```vue
<view v-if="discards.length > 0" class="mj-seat__row mj-seat__row--river mj-river">
  <!-- 现有 MahjongTile 渲染 -->
  <view class="mj-river__mask" />
</view>
```

CSS：
```scss
.mj-river {
  // 统一的弃牌河类名（Board.vue 和 SeatPanel 共用）
}
.mj-river__mask {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 16px;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.5));
  pointer-events: none;
}
```

**低项 L1 验证**：SeatPanel L209-211 `max-height: 84px; overflow: hidden`——`.mj__discard--latest` 的 box-shadow 会被裁掉吗？box-shadow 不占布局空间，overflow:hidden 会裁掉它。**Batch 3 修法**：把 `max-height: 84px` 改成 `max-height: 90px; overflow: visible;`，让 box-shadow 有 6px 的呼吸空间。但这可能让弃牌超出面板其他元素——**实现时需要验证 visual impact**，可能只在 `direction === 'my'` 时改 overflow。

**闸纪律验证**
- [ ] 无新 import
- [ ] 无 JS 定时器
- [ ] 类名不冲突

**提交**：
```bash
git commit -m "feat(mahjong): SeatPanel 弃牌最新标记 + 渐隐遮罩 + .mj-river 类名

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T5 · MahjongSettlement.vue 入场动效 + 番型 emoji + 金币冻结视觉

**Files**
- 修改 `apps/client/src/components/MahjongSettlement.vue`

### 5a · 入场动效替换

Settlement.vue L122 Panel class 现有：
```vue
<Panel class="mj-settlement anim-settlement-in" variant="blue">
```

**替换成**：
```vue
<Panel class="mj-settlement anim-mj-settlement-in" variant="blue">
```

### 5b · 番型 emoji 前缀

**新增映射表**：
```ts
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴',
  七对: '👯',
  大对: '🔶',
  根: '🌳',
  杠上开花: '💥',
  海底捞月: '🌙',
  十三幺: '👻',
  对对胡: '🃏',
  平胡: '✨',
  抢杠胡: '⚡',
};
function fanEmoji(name: string): string {
  return FAN_EMOJI[name] ?? '';
}
```

渲染逻辑（`d.items.map(item => ...)`）里改：
```vue
<text>{{ fanEmoji(item) }}{{ item }}</text>
```

### 5c · 金币冻结视觉

找到 useGoldColumnFreeze 的使用位置（L32-36），给冻结金额加淡灰 + 锁 emoji。具体实现：
```vue
<text :class="{ 'mj-settlement__gold--frozen': isFrozen(seat) }">
  {{ isFrozen(seat) ? '🔒' : '' }}{{ amount }}
</text>
```

CSS：
```scss
.mj-settlement__gold--frozen {
  opacity: 0.6;
  color: $ftl-color-muted;
}
```

**闸纪律验证**
- [ ] 不动现有 ftl-settlement-in（斗地主/跑得快继续用 anim-settlement-in）
- [ ] 无 JS 定时器
- [ ] 只改展示层，不改 useGoldColumnFreeze 逻辑

**提交**：
```bash
git commit -m "feat(mahjong): Settlement 入场动效换 mj-settlement-in + 番型 emoji + 金币冻结视觉

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## T6 · 全量验证 + 闸扫描

### 6a · VS Code 诊断（GetDiagnostics）
预期：ClaimTile.vue 新增零错误；Board.vue / SeatPanel.vue / Settlement.vue / animations.scss 改动零错误。

### 6b · 前端 lint（vue-tsc）
可能仍报 vite/client 类型缺失（项目级 P1），新增 Batch 3 文件零新错。

### 6c · shared 回归
```bash
pnpm -C packages/shared test
```
预期 439/439 全绿（Batch 3 零改动 shared）。

### 6d · JS 定时器闸扫描
Batch 3 新增/修改文件 grep setTimeout/setInterval 必须零命中。

### 6e · reduced-motion media query 验证
确认 animations.scss media query 里有 anim-claim-pulse / anim-mj-settlement-in。

### 6f · 斗地主/跑得快结算未改验证
grep `anim-settlement-in` 确认 3 处使用位置——只有麻将的 L122 从 anim-settlement-in 换成 anim-mj-settlement-in，斗地主和跑得快继续用 anim-settlement-in。

---

## 计划审查记录

### 第 1 轮（本计划写完即送）

待独立 reviewer 审查以下重点：
1. Board.vue 现有 import 列表——加 `import ClaimTile from './ClaimTile.vue'` 位置对吗
2. Board.vue claimLabel 现有暗杠/补杠区分逻辑保留——Batch 3 加 fan 展示会不会 break 现有 switch 结构（现有是 if chain 不是 switch）
3. SeatPanel `.mj__discard--latest` box-shadow 会被 overflow:hidden 裁——计划 L186-188 提到了但修法粗糙，需要更精细方案
4. MahjongFanDetail.items 的实际渲染位置——Settlement.vue L53 `for (const d of props.settlement.fanDetails)` 遍历 d.items 时具体代码在哪
5. ClaimTile 里 phase==='play' 自摸胡的"自摸"标签——Board.vue 现有 claimLabel 已经加了 phase==='play' ? '自摸胡' : '胡'，ClaimTile 单独组件后这个区分逻辑要 Board.vue 传给 ClaimTile，还是 ClaimTile 自己算？
6. reduced-motion media query 里 19 个 anim- 类完整列表（Batch 2 已有 17 个 + Batch 3 新增 2 个）需要手动追列
