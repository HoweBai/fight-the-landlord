<script setup lang="ts">
/**
 * 行动倒计时钟（2026-10-11 牌桌第三轮布局调整）。
 *
 * 历史：这只钟原本挂在 `Seat.vue` 的头像角上；用户裁决「对手的倒计时应该在出牌区域
 *（参考欢乐斗地主）」⇒ 从座位抽出为独立哑组件，由 `table.vue` 挂在左右对手的
 * 出牌/状态列（`.table__play-col`）里，与对手打出的牌、「不出」同处一条固定出牌带。
 * 尺寸历档：52×54 迷你档 → 2026-10-11 用户裁决「和我的倒计时钟一样大」⇒ **88×92**
 *（与 `table.vue` 的 `.table__clock` 同尺寸、同字号档位、同金字描边），迷你档令牌已删。
 *
 * 渲染内容全部是页面算好的**数字/布尔** props，本组件零规则：
 *  - `active`：服务端说现在是不是这个人行动（出牌期 `currentPlayer` / 叫抢期
 *    `bidPhase.currentBidder`，由 `table.vue` 经 `store.actorSeat` 归一化）；
 *  - `seconds`：页面唯一 `useCountdown` 的读数
 *    （§9.6：本组件**不得新造时钟** —— 没有 `new Date()`、没有定时器）。
 *
 * 2026-10-11 用户裁决删除钟面进度条：`remainingMs` / `totalMs` props、填充比例
 * computed 与 `.turn-timer__track/__fill` 一并移除（秒数仍是唯一读数）。
 */
import { computed } from "vue";

const props = defineProps<{
  /** 是否当前行动者（页面归一化后传入）；false ⇒ 整只钟不渲染。 */
  active: boolean;
  /** 剩余秒数（页面唯一的 useCountdown）。 */
  seconds: number;
}>();

/**
 * 倒计时紧迫态（A 档，纯展示）：行动中且秒数进入末 5 秒（1–5）。
 * 0 秒不挂：末拍闪红没有信息量（钟通常随轮次切换被摘除）。
 */
const urgent = computed(
  () => props.active && props.seconds > 0 && props.seconds <= 5,
);
</script>

<template>
  <!--
    行动者的倒计时钟：挂在对手出牌/状态列里（靠头像一侧），只有秒数、无进度条。
    ⚠️ `v-if` 而不是 `v-show`：终局/非行动者必须**一只钟都没有**（既有判据）。
  -->
  <view
    v-if="active"
    class="turn-timer"
    :class="{ 'turn-timer--urgent': urgent, 'anim-urgent-pulse': urgent }"
  >
    <text
      class="turn-timer__value"
      :class="{
        'turn-timer__value--urgent': urgent,
        'turn-timer__value--digits-2': seconds >= 10 && seconds <= 99,
        'turn-timer__value--digits-3': seconds >= 100,
      }"
      >{{ seconds }}s</text
    >
  </view>
</template>

<style scoped lang="scss">
@import "../styles/animations.scss";

/**
 * 对手的倒计时钟（合形闹钟 countdown.png；铃铛/脚伸出圆外 ⇒ 容器不裁切）。
 * 2026-10-11 起与「我」的 `.table__clock` **同规格**：88×92 + 同金字档位。
 * 全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌。
 */
.turn-timer {
  box-sizing: border-box;
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: $ftl-size-clock-w;
  height: $ftl-size-clock-h;
  background-image: $ftl-art-countdown;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
/**
 * 秒数写在灰玻璃钟面上，档位与中央 `.table__clock-value` 完全一致：
 * 个位 xl(40)；两位 md(28)（~44.5 宽贴入内径 ~45.8）；三位 compact(18)。
 * 亮金字 + 四向 2px 深色硬描边（§5.2.1 定稿手法）。
 */
.turn-timer__value {
  display: block;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.turn-timer__value--digits-2 {
  font-size: $ftl-font-md;
}
.turn-timer__value--digits-3 {
  font-size: $ftl-font-clock-compact;
}
/** 末 5 秒紧迫态（A 档）：整钟危险色光晕 + 数字危险色 + 循环脉动（降级媒体查询自动停）。 */
.turn-timer--urgent {
  filter: drop-shadow(0 0 6px $ftl-color-danger-on-dark);
}
.turn-timer__value--urgent {
  color: $ftl-color-danger-on-dark;
}
</style>
