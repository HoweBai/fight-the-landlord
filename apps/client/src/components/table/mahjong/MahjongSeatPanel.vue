<script setup lang="ts">
/**
 * 麻将单座信息面板（哑组件）：昵称 / 张数 / 定缺 / 副露 / 弃牌 / 已胡亮牌 / 状态徽标。
 *
 * 只渲染 props 里服务端已经算好的字段；不判规则、不算分。暗杠按牌背展示
 *（副露结构里的 `angang` 仍是服务端公开的「有暗杠」事实，具体牌面不必亮出）。
 */
import { computed } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  type MahjongHuInfo,
  type MahjongMeldView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';
/** 与 MahjongTile.Rotate 对齐。 */
type Rotate = 'left' | 'right';

const props = withDefaults(
  defineProps<{
    seat: number;
    name: string;
    cardCount: number;
    lackSuit: MahjongSuit | null;
    melds: MahjongMeldView[];
    discards: Tile[];
    hu: MahjongHuInfo | null;
    revealed: { seat: number; tiles: Tile[]; huTile: Tile } | null;
    isOut: boolean;
    trustee: boolean;
    /** Batch 4 D 组：发光强度分级。null = 不发光。替换旧 active: boolean。 */
    activeLevel?: 'strong' | 'weak' | null;
    /** Batch 5 B 组：对手是否听牌（服务端 tingSeats 广播）。 */
    ting?: boolean;
    isMe: boolean;
    isDealer: boolean;
    balance: number | null;
    pendingDelta: number;
    /** 横向布局（左右两侧）时收窄弃牌区。 */
    compact?: boolean;
    /** 牌面方向，透传给 MahjongTile/MahjongMeld。 */
    direction?: Direction;
  }>(),
  { compact: false, direction: 'my', activeLevel: null, ting: false },
);

const emit = defineEmits<{
  /** Batch 4 A 组：用户点击弃牌，让 Board.vue 统一处理过滤逻辑。 */
  (e: 'discard-click', tile: Tile): void;
}>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

// Batch 4 C 组：番型 emoji 映射（纯数据常量，和 Settlement.vue 保持一致）
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  龙七对: '🐉', 清对: '🎯', 将对: '⚔️',
};
function fanEmoji(name: string): string { return FAN_EMOJI[name] ?? '🏆'; }

const lackLabel = computed(() =>
  props.lackSuit === null ? '' : `缺${MAHJONG_SUIT_NAMES[props.lackSuit]}`,
);
const hasMeta = computed(
  () => props.trustee || props.hu !== null || props.isOut || lackLabel.value !== '',
);
/** P1a 对手暗牌堆：cardCount 张牌背（服务端 cardCounts 已经是手牌数，不含副露）。 */
const showDarkTiles = computed(() => !props.isMe && props.cardCount > 0 && !props.isOut);
// compact 模式下左/右/顶面板窄，限制暗牌数量防溢出遮挡副露/弃牌
// 计算依据：sm tile 26px 宽，-12px overlap，8 张 = 26 + 7*14 = 124px ≈ 面板可用宽
const DARK_TILE_LIMIT = props.compact ? 8 : 13;
const darkTileCount = computed(() => Math.min(props.cardCount, DARK_TILE_LIMIT));
// 用 computed 数组让 v-for 跑 key 稳定
const darkTileIndices = computed(() => Array.from({ length: darkTileCount.value }, (_, i) => i));

// —— P2 compact 限制：副露 ≤2 组、弃牌 ≤6 张。compact 面板窄，多行太多会溢出。——
const DISCARD_LIMIT = props.compact ? 6 : 99;
const MELD_LIMIT = props.compact ? 2 : 99;
const visibleMelds = computed(() => props.melds.slice(0, MELD_LIMIT));
const visibleDiscards = computed(() => props.discards.slice(0, DISCARD_LIMIT));
const discardOverflow = computed(() => props.discards.length > DISCARD_LIMIT);

/**
 * 左/右家竖排旋转：direction='left' → rotate(-90°) 朝右 / 'right' → rotate(90°) 朝左。
 * 强制 Tile/Meld 用 my/ 竖置正立素材 + DOM 宽高交换 + transform rotate。
 */
const isVertical = computed(() => props.direction === 'left' || props.direction === 'right');
const rotateDir = computed<Rotate | undefined>(() =>
  props.direction === 'left' || props.direction === 'right' ? props.direction : undefined,
);
</script>

<template>
  <view
    class="mj-seat"
    :class="{
      'mj-seat--me': isMe,
      'mj-seat--out': isOut,
      'mj-seat--compact': compact,
      'mj-seat--vertical': isVertical,
      'mj-seat--active-strong': activeLevel === 'strong',
      'mj-seat--active-weak': activeLevel === 'weak',
    }"
  >
    <view class="mj-seat__head">
      <text class="mj-seat__name">{{ name }}</text>
      <text v-if="isDealer" class="mj-seat__badge mj-seat__badge--dealer">庄</text>
      <text v-if="cardCount > 0" class="mj-seat__count">{{ cardCount }} 张</text>
      <text v-if="balance !== null" class="mj-seat__balance">金币 {{ balance }}</text>
    </view>

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
        >
          {{ fanEmoji(hu.items[0]) }}{{ hu.items[0] }}
          <text v-if="hu.items.length > 1" class="mj-seat__badge--fan-more">等{{ hu.items.length }}种</text>
        </text>
      </template>
      <text v-else-if="isOut" class="mj-seat__badge mj-seat__badge--out">已出局</text>
      <text v-if="ting && !isOut && !hu" class="mj-seat__badge mj-seat__badge--ting">听</text>
      <text
        v-if="pendingDelta !== 0"
        class="mj-seat__badge"
        :class="pendingDelta > 0 ? 'mj-seat__badge--pos' : 'mj-seat__badge--neg'"
      >
        {{ pendingDelta > 0 ? `+${pendingDelta}` : pendingDelta }}
      </text>
    </view>

    <!-- P1a 对手暗牌堆：横向堆叠的牌背。isOut 后手牌被 reveal 或清零，不再画。 -->
    <view v-if="showDarkTiles" class="mj-seat__row mj-seat__row--dark">
      <MahjongTile
        v-for="i in darkTileIndices"
        :key="`dark-${i}`"
        back
        size="sm"
        :direction="direction"
        :rotate="rotateDir"
      />
    </view>

    <!-- T5 Batch 1: 副露用 MahjongMeld 独立组件；P2 compact 限制 ≤2 组 -->
    <view v-if="visibleMelds.length > 0" class="mj-seat__row">
      <view v-for="(meld, i) in visibleMelds" :key="`meld-${i}`" class="mj-seat__meld">
        <text class="mj-seat__meld-label">{{ MELD_LABEL[meld.kind] }}</text>
        <MahjongMeld :meld="meld" :direction="direction" size="sm" :rotate="rotateDir" :vertical="isVertical" />
      </view>
      <text v-if="props.melds.length > visibleMelds.length" class="mj-seat__overflow">
        +{{ props.melds.length - visibleMelds.length }}
      </text>
    </view>

    <!-- P2 compact 限制弃牌 ≤6 张，多余的标 +N -->
    <view v-if="visibleDiscards.length > 0" class="mj-seat__row mj-seat__row--river mj-river">
      <MahjongTile
        v-for="(tile, i) in visibleDiscards"
        :key="`discard-${i}`"
        :tile="tile"
        size="sm"
        :direction="direction"
        :rotate="rotateDir"
        :class="{
          'mj__discard--latest': i === visibleDiscards.length - 1 && visibleDiscards.length > 0,
        }"
        @click="emit('discard-click', tile)"
      />
      <text v-if="discardOverflow" class="mj-seat__overflow mj-seat__overflow--river">
        +{{ props.discards.length - visibleDiscards.length }}
      </text>
      <view v-if="visibleDiscards.length > 6" class="mj-river__mask" />
    </view>

    <view v-if="revealed" class="mj-seat__row mj-seat__row--revealed">
      <MahjongTile
        v-for="(tile, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="tile"
        size="sm"
        :direction="direction"
        :rotate="rotateDir"
        dim
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
// Batch 2 闸纪律：必须 @import 进组件（animations.scss 顶部注释）
@import '../../../styles/animations.scss';

.mj-seat {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  min-height: 80px; // 放大后副露 sm 牌高 51px + badge + margin 需要更多垂直空间
  padding: 6px 8px;
  border-radius: $ftl-radius-sm;
  background: rgba(0, 0, 0, 0.28);
  border: $ftl-hairline solid transparent;
  color: $ftl-color-text;
  transition: border-color 0.15s, background 0.15s;
}
// Batch 4 D 组：activeLevel 替换旧 active: boolean
// 复用 ftl-active-glow keyframe（只调 animation-duration + box-shadow），零新增 keyframe
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
// animations.scss 的 media query 管不到组件内直接写的 animation 属性
@media (prefers-reduced-motion: reduce) {
  .mj-seat--active-strong,
  .mj-seat--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2);
  }
}
.mj-seat--out {
  opacity: 0.6;
}
.mj-seat--me {
  border-color: rgba(255, 255, 255, 0.18);
}
.mj-seat__head {
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  min-width: 0;
}
.mj-seat__name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: $ftl-font-sm;
  font-weight: 600;
}
.mj-seat__count,
.mj-seat__balance {
  flex: 0 0 auto;
  font-size: 10px;
  color: $ftl-color-text-muted;
}
.mj-seat__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mj-seat__badge {
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.4;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.85);
}
.mj-seat__badge--dealer {
  background: $ftl-color-accent;
  color: $ftl-color-on-primary;
}
.mj-seat__badge--lack {
  background: rgba(120, 170, 255, 0.3);
}
.mj-seat__badge--hu,
.mj-seat__badge--pos {
  background: rgba($ftl-color-gold, 0.35);
  color: $ftl-color-gold-light;
}
// Batch 4 C 组：番型 emoji badge
.mj-seat__badge--fan {
  background: rgba($ftl-color-accent, 0.25);
  color: $ftl-color-hint-warn;
}
.mj-seat__badge--fan-more {
  font-size: 9px;
  opacity: 0.8;
}
.mj-seat__badge--ting {
  background: rgba(74, 222, 128, 0.25);
  color: $ftl-color-hint-safe;
}
.mj-seat__badge--out,
.mj-seat__badge--neg {
  background: rgba($ftl-color-danger, 0.3);
}
.mj-seat__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 2px;
  max-height: 84px;
  overflow: hidden;
}
// P1a 暗牌堆：比手牌更紧的重叠（-12px），形成一叠牌背效果
.mj-seat__row--dark {
  gap: 0;
  // P0 回归修法：恢复默认 overflow: hidden，让超出的牌背自然裁切，
  // 避免 compact 模式下暗牌堆溢出遮挡副露/弃牌。
  max-height: none;
}
.mj-seat__row--dark :deep(.mj-tile) {
  margin-left: -16px; // 放大后 sm 宽 34px，overlap -16px ≈ 47%
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.mj-seat__row--dark :deep(.mj-tile:first-child) {
  margin-left: 0;
}
// compact 限制已在 script 里用 DARK_TILE_LIMIT = 8 控数量，overlap 不用再加 override
.mj-seat__row--river {
  padding-top: 3px;
  border-top: $ftl-hairline dashed rgba(255, 255, 255, 0.12);
  // 高项 H1 修法：overflow:hidden 会裁 box-shadow；弃牌河不受 compact max-height 约束
  overflow: visible;
  max-height: none;
  position: relative; // 渐隐遮罩 absolute 定位需要
}
.mj-river__mask {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 16px;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.5));
  pointer-events: none;
  // 让它只在有牌时才可见（无牌时不占空间）
  display: block;
}
.mj-seat__row--revealed {
  opacity: 0.85;
}
.mj-seat__meld {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 6px;
}
// P0 修复：副露 label 改为和其他 badge 一致的 pill 样式，深色面板上可见
.mj-seat__meld-label {
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.4;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.85);
  flex: 0 0 auto;
  align-self: center;
}
// P2 compact overflow 提示：副露/弃牌多时标 +N
.mj-seat__overflow {
  align-self: center;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: $ftl-color-text-muted;
  line-height: 1.4;
}
.mj-seat__overflow--river {
  margin-left: 2px;
}
.mj-seat__tiles {
  display: flex;
  gap: 2px;
}
// P0 修复：compact 面板副露/暗牌行从 60px 提到 80px，给副露 label + meld + overflow +N 留足空间
.mj-seat--compact .mj-seat__row:not(.mj-seat__row--river):not(.mj-seat__row--revealed) {
  max-height: 95px; // sm 放大后副露行需要更多高度
}

// ── 左/右家竖排窄列模式 ────────────────────────────────────────
// 核心原理（配合 MahjongTile rotate prop）：
//   Tile rotate 模式 DOM 是横牌 (w=51, h=34) + transform rotate(±90°) → 视觉竖牌 (34×51)
//   SeatPanel vertical → row 改 column（**不 reverse**），DOM 纵向排横牌
//   DOM 顺序 dark → meld → river → 视觉顺序"远离中心→靠近中心" ✓ 不重叠
//   → DOM 层面 panel 宽 ≈ 51px （放得下 .mj__side 24% ≈ 200px）
//   → 视觉层面 rotate 后变成高>宽的竖条窄列，牌面朝中心方向
//
// ⚠️ 为什么用 column 不用 column-reverse？
//   DOM row 顺序：head→meta→dark→meld→river→revealed
//   正确麻将桌左家（面右朝中心）布局：
//     最远 ← dark(手牌) → meld(副露) → river(弃牌) → 最近
//   column-reverse 会把 dark 推到 river 下面（更靠近中心）→ 手牌压弃牌河，重叠！
//   column 保留 DOM 自然顺序，正好 = 远离→靠近 ✓
// ────────────────────────────────────────────────────────────────
.mj-seat--vertical {
  flex-direction: column; // column：保留 DOM 自然顺序 = 从远离中心到靠近中心
  gap: 3px;
  max-width: 60px; // DOM row 宽 ≈ 51px，加 padding 撑到 55px
  min-width: 55px;
  padding: 4px 2px;
  align-items: center;
  border-radius: $ftl-radius-sm;
}
// 窄面板放不下昵称/金币/meta badge，左/右家的头像/昵称已经在牌桌 Avatar 区显示
.mj-seat--vertical .mj-seat__head,
.mj-seat--vertical .mj-seat__meta,
.mj-seat--vertical .mj-seat__balance {
  display: none;
}
// 只保留 cardCount badge（DOM 层最小信息）
.mj-seat--vertical .mj-seat__count {
  font-size: 10px;
  text-align: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.9);
}
// row 改纵向列：**不 reverse**，保留 DOM tile 顺序 = 先出的牌在上，后出的在下
.mj-seat--vertical .mj-seat__row {
  flex-direction: column; // column：tile[0]（最早出/最旧）在上，tile[last]（最新）在下
  align-items: center;
  gap: 0; // overlap 用 margin 自己算
  max-height: none;
  flex-wrap: nowrap;
  overflow: visible;
}
// overlap 从 margin-bottom 改 margin-top：column 里 tile[1] 在 tile[0] 下方，
// margin-top: -16px → tile[1] 向上重叠 tile[0] 16px → 视觉后牌压前牌 ✓
.mj-seat--vertical .mj-seat__row--dark :deep(.mj-tile),
.mj-seat--vertical .mj-seat__row--revealed :deep(.mj-tile) {
  margin-left: 0;
  margin-top: -16px;
}
.mj-seat--vertical .mj-seat__row--dark :deep(.mj-tile:first-child),
.mj-seat--vertical .mj-seat__row--revealed :deep(.mj-tile:first-child) {
  margin-top: 0;
}
// 弃牌河：同 overlap — 最新弃牌（tile[last]）在最下面，margin-top 让它向上重叠前一张
.mj-seat--vertical .mj-seat__row--river :deep(.mj-tile) {
  margin-left: 0;
  margin-top: -16px;
}
.mj-seat--vertical .mj-seat__row--river :deep(.mj-tile:first-child) {
  margin-top: 0;
}
.mj-seat--vertical .mj-seat__row--river {
  border-top: none; // 竖排不需要顶部分隔线
  padding-top: 0;
}
// 副露：label 隐藏（窄 55px 放不下 label + Meld）
// 用 Meld 内部 3 张 tile 直接纵向堆叠 + cap 杠盖来表达碰/杠
.mj-seat--vertical .mj-seat__meld-label {
  display: none;
}
// 副露容器内部只有 Meld，不再有 label，简化为纯纵向容器
.mj-seat--vertical .mj-seat__meld {
  flex-direction: column; // 和外层 column 方向一致
  margin-right: 0;
  gap: 0;
}
// 副露组之间的垂直间距（副露 row 本身有 gap: 4px，这里保持）
.mj-seat--vertical .mj-seat__row:not(.mj-seat__row--river) {
  gap: 4px;
}
.mj-seat--vertical .mj-seat__overflow {
  align-self: center;
  font-size: 9px;
  padding: 1px 3px;
  margin-left: 0;
  // column 里 order: 0 = DOM 顺序 → overflow 徽标在 row 底部（最靠近中心一侧）
  // 这正好是溢出提示应该出现的位置（靠近桌面中心的方向）
}
.mj-seat--vertical .mj-seat__overflow--river {
  margin-top: 4px;
}
// 弃牌渐隐遮罩：竖排不适用，隐藏
.mj-seat--vertical .mj-river__mask {
  display: none;
}
</style>
