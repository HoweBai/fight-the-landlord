<script setup lang="ts">
/**
 * 牌桌 HUD 状态条（➐ / spec §5-➐ + R654）。
 *
 * 只渲染 `PlayerView` 里**真有**的三个数字，一律**原样**展示、不做任何换算：
 *  - `倍数`：`bidPhase.bidMultiplier`（服务端给的那个数字本身）
 *  - `炸弹`：`playPhase.bombCount` —— 这是**炸弹个数**，不是倍数
 *  - `房间`：`store.roomCode`（弱化的次级信息）
 *
 * ⚠️ **R654（协议⑥ 起按实况订正）**：本组件只渲染 HUD 位置上该有的三个数字。
 * `baseScore` 在协议⑥ 之后**已经**进了 `PlayerView`，但它的显示位是**中央**
 *（`table.vue` 的 `.table__scene-base`）—— HUD **不重复放它**
 *（`table-hud.test.ts` 的「不得含『底分』」+ R659 的旧形态扫描钉住）；
 * 「我的分」仍不在 `PlayerView` 里（只在 `SettlementResult`）。
 *
 * ⚠️ **§1.1 哑终端**：倍数怎么涨（含炸弹带来的那部分）是**服务端的规则**；
 * 本组件只把收到的数字打印出来 —— 把炸弹个数折成倍数、或对倍数做运算一律越线
 *（spec §5-➐ 验收判据写死的红线，`table-bid-ui.test.ts` 的 R659 源码闸 + `table-hud.test.ts` 的正对照）。
 *
 * ⚠️ **R661 缺字段容错**：真浏览器探针 `seedFinishedGame` 注入的视图**没有** `playPhase`
 *（`bidPhase` 的形状也与常规不同）⇒ 三个 prop 都按「可能缺」处理，缺值渲染「—」；
 * HUD 自身是**常驻骨架**，**不因缺字段而整块消失**，也不抛错。
 *
 * 本组件**不放按钮**，因此不需要 `@include ftl-btn`；样式全部自持（见 `<style>`，➏ 评审 F1 的回归教训：
 * 父组件的 scoped 规则进不到子组件模板内部）。
 */
withDefaults(
  defineProps<{
    /** 服务端 `bidPhase.bidMultiplier` 的**原样**值；缺字段 ⇒ `null` ⇒ 显示「—」。 */
    multiplier?: number | null;
    /** 服务端 `playPhase.bombCount` —— **炸弹个数**，不是倍数；缺字段 ⇒ `null` ⇒ 显示「—」。 */
    bombCount?: number | null;
    /** `store.roomCode`（弱化展示）；未知 ⇒ `null` ⇒ 显示「—」。 */
    roomCode?: string | null;
  }>(),
  { multiplier: null, bombCount: null, roomCode: null },
);
</script>

<template>
  <view class="table__hud">
    <!--
      ⚠️ **本注释必须在根元素内部**（F1 评审 Important）：**模板注释**放在根元素**之前**
      会让 SFC 变成**多根**组件（编译产物 `_createElementBlock(_Fragment, null, [_createCommentVNode(…), …])`），
      于是 `@vue/test-utils` 的 `wrapper.classes()` / `attributes()` **静默**返回 `[]` / `{}`
      （`$el` 落在 fragment 锚点上）、父组件再挂 `class` 会走 fragment-attrs 警告路径。
      由 `table-hud.test.ts` 的「单根闸」钉住。

      下面一行三项（倍数 / 炸弹 / 房间）。每个数字一个**稳定 class**（`.hud__item--*`）：
      判据可以落在具体的那个数字上，而不是整块文本 —— 免得断言不知不觉落在房间码上。
      三项的读数都直接来自 prop（prop 由页面从服务端视图取出），组件内零运算。

      ⚠️ `.hud__label` 与 `.hud__value` 之间的那个**空格是判据的一部分**：
      `.hud__item` 的文本必须是「倍数 1」这种「标签 空格 数值」的形态。
      空格用 **`{{ ' ' }}` 显式插值**：裸空格在换行时会被 Vue 的 whitespace: 'condense'
      吃掉（断言静默变成「倍数1」），且保存时的 Prettier 会把两个 text 折行 —— 插值两者都免疫，
      **不要把它改回裸空格**。
    -->
    <view class="hud__item hud__item--multiplier">
      <text class="hud__label">倍数</text>{{ " "
      }}<text class="hud__value">{{ multiplier ?? "—" }}</text>
    </view>
    <view class="hud__item hud__item--bomb">
      <text class="hud__label">炸弹</text>{{ " "
      }}<text class="hud__value">{{ bombCount ?? "—" }}</text>
    </view>
    <view class="hud__item hud__item--room">
      <text class="hud__label">房间</text>{{ " "
      }}<text class="hud__value">{{ roomCode ?? "—" }}</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * HUD 条几何：一行三项、左对齐、随宽度换行。
 *
 * 全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌（不得就地硬编码 hex）；
 * 三端一套：只用 `flex` 排版，没有 `position: absolute`、没有 `transition` 依赖。
 *
 * 「顶栏收成状态条」通过**弱化**实现（本项目符号语言）：HUD 比顶栏更克制 ——
 * 标签用更小的字号 + 次级文字色，房间码**整项**降级（它是次级信息）。
 */
/**
 * HUD 行（2026-10-11 第七轮用户裁决）：**去掉整条胶囊底板**（旧 `bottom-bar.png`
 * 九宫格 + `$ftl-color-surface-muted` 白底色兜底一并删除）——三项数字直接以浅字
 * 浮在牌桌底纹上，与左下角昵称件同一语言。
 *
 * ⚠️ **模板一个字不改** —— `.hud__item--room` 的文本被 `table-hud.test.ts:211` 断言为 `房间 R1`，
 * 且 `.hud__label` 与 `.hud__value` **之间的那个空格是判据的一部分**（见组件头注释）。
 * ⚠️ 它在页面上与「头像 + 昵称组」**同一行**（`.table__me-foot`，右下角）——
 * 拆成两行会吃掉中段 58px（真浏览器实测）。
 * ⚠️ 文字仍是深底浅字配色（白 / 70% 白 / 60% 白）：牌桌底纹是深色，去底后可读；
 * 若将来换到浅底，这三项颜色要一起重算。
 */
.table__hud {
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  gap: $ftl-space-6;
  align-items: center;
}
.hud__item {
  display: flex;
  gap: $ftl-space-2;
  align-items: center;
}
/* A′ 档：底纹是深蓝胶囊（深色底）⇒ 标签/数值全部走深底浅字（旧令牌是为浅底备的，压深蓝上读不出来）。 */
.hud__label {
  color: rgba($ftl-color-on-primary, 0.7);
  font-size: $ftl-font-xs;
  line-height: 1.4;
}
.hud__value {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.hud__item--room .hud__value {
  color: rgba($ftl-color-on-primary, 0.6);
  font-size: $ftl-font-xs;
}
</style>
