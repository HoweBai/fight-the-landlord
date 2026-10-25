<script setup lang="ts">
/**
 * 9-slice 面板（spec §6.4 / 用户裁决 U3）。
 *
 * 素材：`static/ui/panel-{blue,orange}.png`（126×126）。
 *
 * **实现形态选定：`border-image`**（规格要求「选定一种并写进计划」，不留悬空）。
 * 选它而不选「`<image>` + 绝对定位」的理由：单元素、零额外 DOM、**不引入定位上下文**
 * —— 后者会与 `.table__me .card` 那类父级穿透规则抢 `position`。
 *
 * ⚠️ **四个 9-slice 参数缺一不可**，缺了就**静默**退化成「一张被拉伸的图」（不报错）：
 *   · `border-image-slice`（无单位 = **源图像素**；126px 的圆角约 24px）
 *   · `border-width`（**渲染尺寸**，走 `$ftl-panel-slice` 令牌 —— px）
 *   · `border-image-repeat`
 *   · `border-image-source`（由 `border-image` 简写提供）
 *
 * ⚠️ **兜底**（R693 同精神）：底图缺失时 `border-image` 不渲染，只剩一圈 24rpx 的
 * **透明**边框 —— 所以 `.panel` 自带实色底，退化成一个**素面板**而不是一个空洞。
 *
 * ⚠️ **观感**（圆角有没有被切坏、中间有没有被压扁）**只能**由真浏览器 / App 走查证明
 * —— jsdom 不注入 CSS，单测里看不到。**不要**为它造假判据（spec §9.2-7）。
 */
defineOptions({ name: 'Panel' });

withDefaults(defineProps<{ variant?: 'blue' | 'orange' }>(), { variant: 'blue' });
</script>

<template>
  <view class="panel" :class="`panel--${variant}`">
    <slot />
  </view>
</template>

<style scoped lang="scss">
.panel {
  box-sizing: border-box;
  /* 切片宽度 = 源图圆角所占的像素（源图是 126px 的方图）；渲染尺寸用令牌（rpx）。 */
  border: $ftl-panel-slice solid transparent;
  padding: $ftl-space-4;
  /* 2026-10 UI 重设计：深蓝玻璃态面板底（替代原来的白底兜底）。
     border-image（9-slice 贴图）继续画边框 —— 闸 panel.test.ts 钉死了它必须存在。
     两层叠加：border-image 画边框纹理，background/box-shadow 画玻璃感底。
     ⚠️ 闸 panel.test.ts 钉死 background 必须是 $ftl-color- 令牌开头 —— 用兜底深蓝令牌 +
     background-image 渐变叠加实现玻璃质感。 */
  background: $ftl-color-night-deep;
  background-image:
    linear-gradient(145deg, rgba(25, 55, 109, 0.92), rgba(13, 35, 69, 0.96)),
    ftl-theme-url($ftl-btn-theme-panel);
  background-size: 100% 100%, 100% 100%;
  background-repeat: no-repeat, no-repeat;
  color: $ftl-color-on-primary;
  /*
    border-radius 必须等于源图圆角 = border-width = slice（全是 24px）。
    三个量对齐后，border-image 的圆角贴图被 CSS 圆角精准匹配，
    贴图透明区 = 元素裁剪外的区域 → 没有缝隙、没有外界黑边。
  */
  border-radius: $ftl-panel-slice;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.5),
    inset 0 2px 0 rgba(255, 215, 0, 0.15),
    inset 0 -2px 0 rgba(0, 0, 0, 0.3);
  /* 🔴 不能加 backdrop-filter：它采样面板外部像素（scrim 黑遮罩），
     会把黑色揉进 border-image 圆角的透明区 → 可见黑边。 */
}
.panel--blue {
  border-image: url('/static/ui/panel-blue.png') 24 fill stretch;
}
.panel--orange {
  border-image: url('/static/ui/panel-orange.png') 24 fill stretch;
}
</style>
