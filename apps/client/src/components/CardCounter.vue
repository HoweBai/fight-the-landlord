<script setup lang="ts">
/**
 * 记牌器横条：顶栏左侧的 15 列白色格子卡片。
 *
 * **显示语义**（照欢乐斗地主，从大到小）：
 *  - 15 列顺序：大王、小王、2、A、K、Q、J、10、9、8、7、6、5、4、3；
 *  - 每列只显示「点数 + 外面剩余张数」——`总数 − 我手牌 − 已打出`；
 *  - **绝牌**（剩余 0）灰色；**满牌**（剩余 4）红色；其它橙色。
 *
 * ⚠️ **底牌（bottomCards）不减**：它在地主手里，属于「外面」。
 * ⚠️ **纯显示 + 算术**：不做任何规则判断（source-boundary ⑤ 闸）。
 */
import { computed } from "vue";
import { toDisplay } from "@fight-the-landlord/protocol";
import { useGameStore } from "../stores/game";
import {
  usePlayedCards,
  computeRemaining,
  countByRank,
} from "../composables/usePlayedCards";

/** 展示顺序：参考欢乐斗地主，从大到小（DouZero：30/20 王、17=2、14=A…3）。 */
const DISPLAY_RANK_ORDER: readonly number[] = [
  30, 20, 17, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
];

const store = useGameStore();
const tracker = usePlayedCards();

/** 15 列的展示数据。 */
const columns = computed(() => {
  // 读 `tracker.size` 建立响应式依赖（played 是普通 Set，自身不触发重算；
  // size getter 内部读 tick ref ⇒ 牌面变化时本 computed 重跑）。
  void tracker.size;
  const hand = store.hand;
  const handCounts = countByRank(hand);
  const remaining = computeRemaining(hand, tracker.played);
  return DISPLAY_RANK_ORDER.map((r) => {
    const inHand = handCounts.get(r) ?? 0;
    const remain = remaining.get(r) ?? 0;
    /** remain 颜色类：0=灰（绝牌），4=红（满牌），其它=橙。 */
    const remainColor =
      remain === 0 ? "zero" : remain >= 4 ? "full" : "normal";
    return {
      rank: r,
      label: toDisplay(r),
      remain,
      remainColor,
      /** 绝牌：外面一张都不剩（我手里也没有 + 已全部打出）。 */
      gone: remain === 0 && inHand === 0,
    };
  });
});
</script>

<template>
  <view class="counter" role="region" aria-label="记牌器">
    <view
      v-for="col in columns"
      :key="col.rank"
      class="counter__col"
      :class="{ 'counter__col--gone': col.gone }"
    >
      <text class="counter__rank">{{ col.label }}</text>
      <text
        class="counter__remain"
        :class="`counter__remain--${col.remainColor}`"
        >{{ col.remain }}</text
      >
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 记牌器：白底 15 格卡片条，嵌在顶栏左侧。
 *
 * 🔴 关于硬编码 px：
 *  - `min-width: 32px` 是列宽下限（15 列总宽 ≈ 480，必须精确才能塞进顶栏）；
 *  - `gap: 2px` 是列内 rank/remain 的行距（太小会挤，太大散）；
 *  - `padding: 4px` 是卡片内边距（$ftl-space-2=4px 可替代，已用令牌）；
 *  - 列分隔线用 `$ftl-hairline`（2px），横向分隔线同理。
 *  - rank/remain 字号统一用 `$ftl-font-sm`（26px），设计令牌已对齐。
 */
.counter {
  display: inline-flex;
  align-items: stretch;
  gap: 0;
  padding: $ftl-space-2;
  background: $ftl-color-surface;
  border-radius: $ftl-radius-md;
  box-shadow: 0 2px 6px rgba($ftl-color-night-deep, 0.15);
}
.counter__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 32px;
  padding: $ftl-space-2 $ftl-space-2;
  line-height: 1;
}
/** 列之间的竖分隔线。 */
.counter__col + .counter__col {
  border-left: $ftl-hairline solid rgba($ftl-color-night-deep, 0.12);
}
.counter__rank {
  color: $ftl-color-night-deep;
  font-size: $ftl-font-sm;
  font-weight: 700;
  line-height: 1.1;
  white-space: nowrap;
  padding-bottom: 3px;
  border-bottom: $ftl-hairline solid rgba($ftl-color-night-deep, 0.18);
}
.counter__remain {
  font-size: $ftl-font-sm;
  font-weight: 700;
  line-height: 1.1;
}
/** remain 颜色：0=灰（绝牌），4=红（满牌），其它=橙。 */
.counter__remain--zero {
  color: $ftl-color-text-secondary;
}
.counter__remain--full {
  color: $ftl-color-danger;
}
.counter__remain--normal {
  color: $ftl-color-accent;
}
</style>
