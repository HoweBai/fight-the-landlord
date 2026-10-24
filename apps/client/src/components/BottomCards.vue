<script setup lang="ts">
/**
 * 底牌位（➏ / spec §5-➏）。
 *
 * 「什么时候翻开」**不是**前端的判断：`bottomCards === null` 就是服务端说「还看不见」
 *（叫抢期恒为 `null`，地主确定后才下发牌值，§6.4）⇒ `null` 渲染 3 张**牌背** + 一块「底牌」标签，
 * 非 `null` 就用 `Hand` 渲染那几张牌面。前端只跟随服务端，既不猜时机、也不改张数。
 *
 * 牌背复用 `Card.vue` 的 `faceDown`（➌ 的座位牌背扇与这里是**同一份**实现）：
 * 牌背不渲染文字、**不渲染 `data-value`** ⇒ 底牌位在叫抢期**零牌面泄漏**。
 */
import Hand from "./Hand.vue";
import Card from "./Card.vue";
/** 别名：本文件另有一个 `Card`（`./Card.vue` 组件），类型不能同名。 */
import type { Card as ProtocolCard } from "@fight-the-landlord/protocol";

withDefaults(
  defineProps<{
    /** `PlayerView.bottomCards`（原样传入）；`null` = 还未翻开（叫抢期）。 */
    cards: readonly ProtocolCard[] | null;
  }>(),
  { cards: null },
);

/** 叫抢期固定 3 张牌背：底牌张数是**服务端契约**（三家 17/17/17 + 底牌 3），不是规则推导。 */
const HIDDEN_BACK_COUNT = 3;
const hiddenBacks = Array.from(
  { length: HIDDEN_BACK_COUNT },
  (_, index) => index,
);
</script>

<template>
  <view class="table__bottom-slot">
    <!--
      未翻开（`cards === null`）：3 张牌背 + 一块「底牌」标签（走查修复：旧文案
      「叫抢阶段不可见」是把阶段规则念给玩家听，信息冗余；这里只标这是什么牌）。
      牌背的 `:value="0"` 只是占位（`Card` 的 `value` 是必填 prop），`faceDown` 下它**不参与渲染**：
      牌背既无文字也**不带** `data-value` ⇒ 不可见的牌值一个都不进 DOM。
    -->
    <view v-if="cards === null" class="table__bottom table__bottom--hidden">
      <Card
        v-for="back in hiddenBacks"
        :key="`bottom-back-${back}`"
        :value="0"
        face-down
        size="small"
      />
      <text class="table__muted">底牌</text>
    </view>
    <!--
      已翻开：渲染服务端下发的牌面（`.card[data-value]` 即契约测试/探针的观测点）。
      §8：翻牌动效挂在**容器**上（整排一起翻），所以 `Hand` 传 `enter="none"` —— 否则
      每张牌还会各自做一次发牌错峰，两种动画会叠加。

      ⚠️ **`size="small"` + 本组件就地放大到 54×70**（片② / R731 / 2026-10-11
      用户裁决「抢地主后底牌重叠展示、适当大一点」，同日再裁决等比例扩大到宽 54）：
      样式段把 `.card--small` 的 50×65 覆盖为 `$ftl-card-bottom-w/h`（54×70，同比例
      0.771 ≈ 源图 0.769），相邻牌重叠 `$ftl-card-bottom-overlap`（25）扇形 ——
      牌背与翻开标同一个尺寸，翻转前后不跳。
      ⚠️ `table-bid-bottom` 的牌背判据断言的是 `.card--back` 的**数量**（3 张 / 翻开后 0 张），
      与尺寸无关 ⇒ 放大不影响它。
    -->
    <view v-else class="table__bottom anim-reveal-in">
      <Hand :cards="cards" size="small" enter="none" />
    </view>
  </view>
</template>

<style scoped lang="scss">
/*
 * §8 动效。
 * ⚠️ 必须用 `@import` 而**不能**用 `@use`：uni-app 会把 `src/uni.scss` 的**全部内容**
 * 前置到每一个 scss 块（见 uni.scss 顶部注释），而它里面有一个 `@mixin` ——
 * Sass 要求 `@use` 出现在**任何规则之前** ⇒ 组件里写 `@use` 会**构建失败**：
 *   `[sass] @use rules must be written before any other rules.`（实测）
 * `@import` 没有这个位置约束。（Dart Sass 会提示 @import 已弃用，但它仍是本仓唯一可用的形态。）
 */
@import "../styles/animations.scss";

/**
 * 底牌位几何。全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌（不得就地硬编码 hex）。
 * 三端一套：只用 `flex` 排版，没有 `position: absolute`、没有 `transition` 依赖。
 */
.table__bottom-slot {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
}
/**
 * 底牌簇（牌背 3 张 / 翻开后 3 张牌面）：恒单行**重叠扇形**（2026-10-11 用户裁决）。
 * 🔴 `gap` 必须归零再用负 `margin-left` 重叠（R671：负 gap 非法）——否则 flex gap 会
 * 吃掉一部分重叠量；「底牌」标签与牌的间距改由标签自己的 `margin-left` 承担。
 */
.table__bottom {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
}
/**
 * 叫抢期底牌（3 张牌背 + "底牌"文字）：
 * "底牌"文字用 absolute 脱离 flex 流 —— 让 BottomCards 盒子宽度 = 只有 3 张牌背，
 * 这样父级 `.table__bar-center` 的 transform(-50%,-50%) 居中的就是纯 3 张牌的中心，
 * 与翻开后 3 张牌面的中心对齐。如果 "底牌"文字在 flex 流里，BottomCards 盒子
 * 会被撑宽 → center 居中的是 3 张牌+文字的中间，用户视觉上看到 3 张牌偏了。
 */
.table__bottom--hidden {
  position: relative;
}
.table__bottom--hidden .table__muted {
  position: absolute;
  left: 100%;
  margin-left: $ftl-space-3;
  top: 50%;
  transform: translateY(-50%);
}
/**
 * 牌背是本组件直接渲染的 `Card`、牌面在 `Hand` 里 —— 两簇都经 `:deep` 收到
 * 54×70（覆盖 `Card.vue` `.card--small` 的 50×65），相邻牌负 margin 重叠 25。
 */
.table__bottom :deep(.card) {
  flex: 0 0 auto;
  width: $ftl-card-bottom-w;
  height: $ftl-card-bottom-h;
}
.table__bottom :deep(.card + .card) {
  margin-left: -$ftl-card-bottom-overlap;
}
/** 翻开簇里的 `Hand`：归零自带 gap、锁单行（与出牌扇形同款手法）。 */
.table__bottom :deep(.hand) {
  flex-wrap: nowrap;
  column-gap: 0;
}
.table__muted {
  margin-left: $ftl-space-4;
  color: $ftl-color-text-disabled;
  font-size: $ftl-font-sm;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
