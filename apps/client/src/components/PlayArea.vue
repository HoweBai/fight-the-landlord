<script setup lang="ts">
/**
 * 出牌区（➎ 桌面区的**历史窗口里的一格**）。
 *
 * ⚠️ **R656（协议 ④ 后订正）**：契约里**不再有** `lastPlayedHand` / `lastPlayerIdx` ——
 * 出站的是一个窗口 2 的 `recentActions`（「不出」是显式的 `cards: null`）。**Task B2 起**
 * 本组件是**每侧一个实例**（一页最多两处并存），由宿主 `table.vue` 按 `actionOf(seat)` 派发。
 * 「三家同时出牌」仍做不到（窗口也不含各家历史，要更大的协议改动，§1.7：不在本批）。
 *
 * ⚠️ **走查修复：本组件只渲染「真有牌」的一手。** 宿主只在 `action.cards` 非 null 时挂载；
 * `cards: null`（「不出」）不再渲染黑药丸（旧 `.table__pass-note` 实测压住中央动作按钮），
 * 改挂到出牌/状态带上：对手的 `.table__play-pass`（出牌/状态列）、我的 `.table__my-pass`
 *（动作行原按钮位），两处都由 `table.vue` 渲染；空窗口**不挂任何出牌槽**，
 * 中央的「（无）」占位整条删除。挂载本组件即代表「这一格有一手牌」。
 *
 * 组件零规则判定：收到的全是页面算好的展示数据（牌值数组）。
 *
 * ⚠️ **2026-10-11 第八轮用户裁决：删除归属标签**（原「玩家1 出 / 玩家2 出 / 我 出」）——
 * 牌摆在哪一侧本身就表明了是谁出的，标签冗余。`ownerSeat` / `ownerLabel` 两个 prop 随之一并删除。
 */
import { computed } from "vue";
import Hand from "./Hand.vue";
import type { Card } from "@fight-the-landlord/protocol";

const props = defineProps<{
  /**
   * 这一格要显示的牌（页面从 `recentActions` 窗口那一项原样取来）。
   * 类型上保留 `null`（单根挂载闸等装配点会传 `null`）：`null` 时根节点仍在、内部为空，
   * 正常对局中宿主只在**非 null**（真有一手牌）时才挂本组件。
   */
  cards: readonly Card[] | null;
  /**
   * 纯展示镜像（2026-10-10）：挂在**右家槽**时为 `true` —— 牌扇锚到列右侧，
   * 张数多时向**中央**方向溢出。⚠️ 不能拿座位号推断（座位随庄家轮换，右侧玩家未必是 2 座，
   * 与 `Seat.vue` 的 `mirror` 同一手法），必须由宿主显式传入。
   */
  mirror?: boolean;
}>();

/** 非空视图：`cards === null` 归一为空数组（根节点照渲染，只是里面没牌）。 */
const playedCards = computed<readonly Card[]>(() => props.cards ?? []);
</script>

<template>
  <view
    class="table__play-area"
    :class="{ 'table__play-area--mirror': mirror }"
  >
    <view class="table__played">
      <!-- §8：出牌入场（错峰由 `Hand` 统一持有） -->
      <Hand v-if="playedCards.length > 0" :cards="playedCards" enter="played" />
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 出牌区几何。全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌（不得就地硬编码）。
 * 三端一套：只用 `flex` 排版，没有 `position: absolute`、没有 `transition` 依赖。
 *
 * ⚠️ **片②（R726）：本组件会被摆在「出牌者那一侧」**（左家摆左、右家摆右、我摆我上方），
 * 由宿主 `table.vue` 决定。**本组件仍然不知道自己在哪一侧** —— 那是排版的职责，
 * 组件只渲染数据（§12 哑终端：不做位置推断）。
 *
 * 2026-10-10（用户裁决，仿欢乐斗地主）：出牌区的牌也要**像手牌一样紧凑叠放、不要散开** ——
 * `.table__played` 从 `wrap + 8px gap 并排` 改成 `nowrap + 负 margin 扇形`，重叠量走
 * `$ftl-card-overlap-mid`（mid 牌 90 宽 ⇒ pitch 34，净露率与手牌同口径 38.1%）。
 */
.table__play-area {
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  gap: $ftl-space-2;
  align-items: flex-start;
  min-width: 0;
}
/* 右家槽：牌扇锚在槽右侧（贴着右家头像），张数多时向**中央**方向溢出；文字也靠右。 */
.table__play-area--mirror {
  align-items: flex-end;
}
.table__played {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
}
/* Hand 自带 `gap`（4px）与 wrap：出牌扇形必须归零 gap、锁单行（与手牌区同款手法）。 */
.table__played :deep(.hand) {
  flex-wrap: nowrap;
  column-gap: 0;
}
/* R671：重叠只能用负 `margin-left`（负 `gap` 非法，浏览器与小程序都会丢弃）。 */
.table__played :deep(.card + .card) {
  margin-left: -$ftl-card-overlap-mid;
}
</style>
