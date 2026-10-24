﻿<script setup lang="ts">
/**
 * 叫抢面板（➏ / spec §5-➏ + R657 **改形态**（协议③）+ R647）。
 *
 * 内容只有两件：两个动作按钮（叫/抢 与 不叫/不抢），中间留槽给页面塞中央倒计时钟。
 *（2026-10-11 第五轮走查：「当前倍数 N」展示位应用户裁决删除；倍数仍由 HUD / 顶栏徽章展示。）
 *
 * 🔴 **R657 改形态（协议③）**：文案**只能从服务端的 `bidPhase.kind` 派生**。本组件
 * **不得**由 `grabActions` / `landlordCandidate` 反推「现在是叫还是抢」——那是把规则搬进前端
 *（§1.1 明令禁止，§12 订正 4）。R657 的形态因此从「文案恒定（字面「抢」/「不抢」）」
 * 改成「**文案只能从 `kind` 派生**」，判据两处（**正例与反例都要有** —— 只有反例的话
 * 写个常量也能过）：
 *  · `table-bid-stage.test.ts`：同一 `kind` 下计数怎么变都不动 + `kind` 一变文案就变；
 *  · `table-bid-bottom.test.ts` 的 R657 组（同形）。
 * ⚠️ 残缺视图（探针注入、没有 `bidPhase.kind`）由**页面**兜底成 `'call'` ——
 * 那是**展示缺省**、不是规则判断；本组件拿到的恒是两值之一（键集与联合类型逐字对齐）。
 *
 * 禁用依据**不来**自本组件：页面把 `busy` 的结果传进 `disabled`。
 * ⚠️ **2026-10-13 真机走查起：本面板只在轮到我时被页面渲染**（非我轮次按钮整个不渲染，
 * 与出牌相位同款纪律）——「是不是我的轮次」这个展示门控在页面层（`table.vue` 的
 * `v-if="store.isBidding && store.isMyTurn"`），`disabled` 因此只剩 `busy`；
 * `store.actorSeat` 在叫抢期取 `bidPhase.currentBidder`（R107/§9.1）——那是 store 的事，
 * 本组件（以及页面）**不得**另起一套本地判断（R647 保锚）。
 *
 * 两个按钮带**稳定 class**（`.table__bid-grab` / `.table__bid-pass`）且必须是原生 `<button>`：
 * 真浏览器探针走 `el.click()`、契约测试按 class 断言（R107/R647）。改名会让用例静默失配。
 */
defineProps<{
  /** 是否禁用两个动作按钮。由页面算好（`busy`；本面板只在轮到我时被渲染）。 */
  disabled: boolean;
  /**
   * 协议③：当前行动者该用哪套措辞。**唯一来源是服务端**（`bidPhase.kind`）——
   * 本组件**不得**由 `grabActions` / `landlordCandidate` 反推（R657 改形态后的红线）。
   */
  kind: "call" | "rob";
}>();

/**
 * 措辞表（枚举 → 文案，**不是**规则判断）。
 * ⚠️ 键集必须与契约的联合类型逐字对齐（少一个键就渲染出 `undefined`）。
 */
const GRAB_LABEL: Record<"call" | "rob", string> = {
  call: "叫地主",
  rob: "抢地主",
};
const PASS_LABEL: Record<"call" | "rob", string> = {
  call: "不叫",
  rob: "不抢",
};

const emit = defineEmits<{ (e: "grab"): void; (e: "pass"): void }>();
</script>

<template>
  <view class="table__bid-panel">
    <button
      type="button"
      class="btn btn--primary table__bid-grab"
      :disabled="disabled"
      @click="emit('grab')"
    >
      {{ GRAB_LABEL[kind] }}
    </button>
    <!--
      两按钮之间的槽（2026-10-10 仿欢乐斗地主布局）：**我的回合**时页面把中央倒计时钟
      塞在这里（叫地主 [8s] 不叫）；不传槽位时整行与旧形态完全一致。
      ⚠️ 槽只负责「摆位」，钟的秒数/阈值全在页面（唯一 `useCountdown`，§9.6）。
    -->
    <slot />
    <button
      type="button"
      class="btn table__bid-pass"
      :disabled="disabled"
      @click="emit('pass')"
    >
      {{ PASS_LABEL[kind] }}
    </button>
  </view>
</template>

<style scoped lang="scss">
/**
 * 面板负责**排布**（三件横排、两个按钮等宽撑满面板的剩余宽度）。
 *
 * ⚠️ **按钮的 `.btn` 样式必须写在**这里**（评审 F1 的回归根因）**：`scoped` 样式只作用于
 * 「本组件自己的模板 + 子组件的**根节点**」——`table.vue` 的 `.btn { @include ftl-btn }` /
 * `.btn--primary` / `.table__actions .btn` 编译成 `.btn[data-v-<table 的 scope>]`，
 * 而这里的按钮只带 **BidPanel 自己的** scope id ⇒ 一条都命中不了。抽组件时若照抄
 * 「样式由父级给」的假设，三端产物里「抢」会丢主色、两个按钮会丢 min-height/padding/
 * border/border-radius/font-size/`:disabled` 透明度与等宽 —— 所以本组件**自持**一份，
 * 与页面里其余 `.btn`（`table.vue`、`lobby.vue`、`login.vue`）取自**同一个**全局 mixin 与令牌。
 * 全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌，没有 px/hex，`line-height` 无单位。
 */
.table__bid-panel {
  display: flex;
  /**
   * ⚠️ **不能写成 `flex: 1 1 0`**（片② 走查实测的第二处同族回归）。
   *
   * 本面板是 `.table__actions` 的子项。**片③ 起动作区搬进了 `.table__center`、不再是浮层**，
   * 但它的宽度**仍由内容决定**（居中的 column flex 里它是 fit-content，不是拉伸的）
   * ⇒ 行内没有富余空间。`flex-basis: 0` 会让**本面板自己的宽度塌成 0**，它的子元素
   * （两个按钮）**溢出到盒子外**，视觉上叠在一起。
   * ⇒ `flex: 1 1 auto`：basis = 内容宽 ⇒ 面板至少装得下自己的内容。
   */
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: $ftl-space-4;
  align-items: center;
}
.table__bid-panel .btn {
  /**
   * ⚠️ **不能写成 `flex: 1 1 0`**（片② 走查实测的回归）。
   *
   * 动作区（`table.vue` 的 `.table__actions`；**片③ 起在 `.table__center` 里，不再是浮层**）
   * 的宽度**由内容决定** ⇒ 行内**没有富余空间**。而 `flex-basis: 0` 的按钮在那种情况下会缩到
   * **内容最小值**，中文又能逐字断行 ⇒ 「不抢」被压成**一个字宽、两个字竖着叠**（截图可见）。
   *
   * ⇒ `flex: 1 1 auto`（basis = 内容宽）+ `white-space: nowrap`（最小内容宽 = 整条文案）
   * —— 有空间就长、没空间也**至少横着放得下整条文案**。不写死 `min-width` 的魔数。
   */
  flex: 1 1 auto;
  white-space: nowrap;
}
.btn {
  @include ftl-btn;
  /* 2026-10 UI 重设计：次按钮（默认态）改成冷灰弱化风格 */
  border-color: rgba(160, 170, 190, 0.5);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(120, 130, 150, 0.35), rgba(80, 90, 110, 0.5));
  color: rgba($ftl-color-on-primary, 0.7);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 2px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  transition: transform 0.1s, box-shadow 0.1s, border-color 0.15s;
  /* 覆盖 ftl-btn 里的 btn2.png 贴图 —— 我们有自己的渐变兜底 */
  background-image: none;
  &:hover {
    border-color: rgba(180, 190, 210, 0.7);
    color: rgba($ftl-color-on-primary, 0.85);
  }
  &:active {
    transform: translateY(2px);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
  }
}
.btn--primary {
  border-color: $ftl-color-gold-deep;
  /* ⚠️ 这一行必须是 `background: **简写**` —— `table-bid-bottom.test.ts` 的
     「主按钮必须自持主色」闸按**字面**匹配（写成 `background-image:` 匹配不上）。 */
  background: $ftl-color-gold;
  /* 🔴 **贴图两行已删**（片③ 阶段 B / §5.2.1 逐字：「**不带贴图** —— 原处的
     `background-image: url($ftl-btn-plate-primary)` / `background-size` **必须一并删掉**
     （留着会盖住金色）」）。 */
  color: $ftl-color-on-primary;
  /* 2026-10 UI 重设计：拟物化立体阴影 */
  border-radius: $ftl-radius-md;
  box-shadow:
    0 6px 0 $ftl-color-gold-deep,
    0 8px 20px rgb(255 152 0 / 0.45),
    inset 0 2px 0 rgb(255 255 255 / 0.6),
    inset 0 -2px 0 rgb(0 0 0 / 0.1);
  transition: transform 0.1s, box-shadow 0.1s;
  /* 覆盖 ftl-btn 的 btn2.png 贴图 —— 金色渐变兜底已由 background 简写提供 */
  background-image: none;
  &:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 0 $ftl-color-gold-deep,
      0 12px 28px rgb(255 152 0 / 0.55),
      inset 0 2px 0 rgb(255 255 255 / 0.6);
  }
  &:active {
    transform: translateY(4px);
    box-shadow:
      0 2px 0 $ftl-color-gold-deep,
      0 4px 10px rgb(255 152 0 / 0.3),
      inset 0 3px 8px rgb(0 0 0 / 0.2);
  }
}
.btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}
</style>
