<script setup lang="ts">
/**
 * 横屏舞台（2026-10-11 起**全出血自适应**；前身 spec §2.2 / R710–R713 的固定 1334×750
 * 画布 + contain 居中模型，超宽屏两侧留底纹边——已废弃）。
 *
 * 结构（**底纹只在最外层铺一次** —— 铺两层会因缩放比不同而错位，R713）：
 *
 *   .stage   position:fixed; inset:0; padding:安全区; overflow:hidden
 *            background = 兜底色（CSS 纯色）+ **底纹层**（<image class="stage__backdrop"
 *            mode="aspectFill">，绝对定位垫底；页面声明的那张，默认 bg.png）
 *     ├─ 竖屏 ⇒ 旋转提示层
 *     └─ .canvas  设计尺寸 = 安全区 ÷ k（宽恒 ≥1334、高恒 ≥750），transform: scale(k)
 *                 ⇒ 缩放后**恰好铺满安全框**，任意宽高比零留边（见 useLandscapeCanvas）
 *
 * 🔴 **底纹为什么是 `<image>` 垫底层而不是内联 `background-image`**（2026-10-13 发布包
 * 素材修复，真机+模拟器截图实证）：
 *   · App **发布态**页面走 `file://`，元素**内联样式**里的绝对 `url('/static/ui/bg.png')`
 *     （以及 `/pages/table/static/…`）会解析到**文件系统根** ⇒ 底纹 404，页面只剩兜底色
 *     （登录页/玩法页/牌桌页整片近白）；基座 dev-run（http 本地服务）与 H5 因此**从未暴露**；
 *   · `<image>` 组件按绝对本地路径加载是**发布包实测可用**的形态（卡面 /pages/…、头像 /static/…
 *     同族皆正常）——底纹换用它，两条路径族都落进已验证面。
 *   · `mode="aspectFill"` ≡ 原 `background-size: cover` + `center`（等比裁切、居中）。
 *
 * ⚠️ **`position: fixed` 在这里成立的两个实测前提**（spec 回核 #22）：
 *   ① 被 transform 捕获的是 fixed 的**祖先链** —— `.stage` 自身无 transform；
 *   ② 页面壳 `uni-page-wrapper` 是 `position: relative` —— **relative 不捕获 fixed**。
 *
 * ⚠️ **metrics 是同步算的**：`setup()` 里就算出来 ⇒ 首帧即正确，无 FOUC、无初始隐藏。
 *    「初始隐藏 + 兜底」那版修法**已被推翻**（它让 JS 一失败就永久白屏）。
 *    视口事件接线（含 H5 旋转后复读用的定时器）全部在 `useLandscapeViewport` composable 里 ——
 *    组件区「不新造时钟」纪律要求组件自身零定时器。
 */
import { computed } from "vue";
import {
  CANVAS_H,
  CANVAS_W,
  isPortrait,
  layoutMetrics,
} from "../composables/useLandscapeCanvas";
import { useLandscapeViewport } from "../composables/useLandscapeViewport";
import { assetUrl, tableAsset } from "../asset";

defineOptions({ name: "LandscapeStage" });

/**
 * 宿主读取失败时的保守兜底：k=0.5 + 最小设计尺寸（手机上一定放得下、且不产生 0 尺寸）。
 * ⚠️ **内容可能被裁，但不会白屏** —— 这是失败模式的全部要求（R693 同族）。
 */
const FALLBACK_METRICS = { scale: 0.5, width: CANVAS_W, height: CANVAS_H };

/**
 * 视口信号由 composable 统一供给：uni resize（全端）+ H5 原生信号与旋转后稳定复读，
 * 且带读数消毒 / last-good —— iOS 旋转瞬态的垃圾读数不会再把画布缩没（2026-10-15 修复）。
 */
const viewport = useLandscapeViewport();

const metrics = computed(() => {
  const { w, h, insets } = viewport.value;
  if (!(w > 0 && h > 0)) return FALLBACK_METRICS; // 宿主能力缺失 ⇒ 保守兜底
  const m = layoutMetrics(w, h, insets);
  return m.scale > 0 ? m : FALLBACK_METRICS;
});

/** 竖屏 ⇒ 只显示旋转提示（App 锁横屏后基本不会为真，H5 会）。 */
const portrait = computed(() => {
  const { w, h } = viewport.value;
  return w > 0 && h > 0 ? isPortrait(w, h) : false;
});

/**
 * 每页可选底纹（spec §5.4 的**机制**部分）。
 *
 * ⚠️ **「底纹只铺一层」这条性质一个字没变**（R713）—— 变的只是「哪张图」：
 * 由**页面显式声明**（prop），而不是舞台自己去查页面身份。
 * 舞台若按 `auth.page` 查表，就等于把「页面身份」这一份知识复制进一个纯布局组件
 * （第二个真源 —— 加第四个页面时两处都要改，漏一处是**静默**的）。
 *
 * ⚠️ **本表是底纹图的唯一清单** ⇒ R713 的判据锚在它上面
 * （`landscape-canvas.test.ts` ⑤ 那条）：主包图必须在 `src/static/ui/` 里存在，
 * 牌桌分包图必须在 `src/pages/table/static/ui/` 里存在。
 */
const BACKDROPS = {
  default: assetUrl("/static/ui/bg.png"),
  /**
   * 牌桌专用底纹（2026-10-12 换图：旧 `Common_BG4_2x.png` 退役删除 ——
   * 不删旧图（236 KiB）`ui/` 目录会破 1536 KiB 预算闸）。
   * 项 6 分包：底纹只在牌桌用 ⇒ 随牌桌分包走（`tableAsset`），不占微信主包。
   * 版本 query 统一走 `tableAsset()`（dev no-cache / 生产 ?v=版本），不再手工 bump。
   */
  table: tableAsset("ui/bg_table.png"),
} as const;

const props = withDefaults(
  defineProps<{ backdrop?: keyof typeof BACKDROPS }>(),
  {
    backdrop: "default",
  },
);

/**
 * 底纹层的 `src`（模板里 `<image class="stage__backdrop">` 的 `:src`）—— 全仓**唯一**
 * 铺底纹的地方；页面与舞台的类样式里没有任何图路径（判据：`landscape-canvas.test.ts` R713）。
 *
 * ⚠️ `?? BACKDROPS.default` 不是死代码：类型系统挡得住**字面量**写错，挡不住
 * 「名字从数据里来」（`:backdrop="cfg.backdrop"`）。缺图时退到一张**确定存在**的图，
 * 而不是铺成空 src 的空白（R693 同族：拿不到素材不许白屏）。
 */
const backdropImage = computed(
  () => BACKDROPS[props.backdrop] ?? BACKDROPS.default,
);

/**
 * 安全区用 `padding` 吃掉，让画布在**安全框内**居中（spec 回核 #12）。
 *
 * 不这么做的话，横屏常见的**不对称**安全区（刘海在一侧：left 44 / right 0）
 * 会让画布在全视口居中时两边各让 (44+0)/2 = 22px < 44px ⇒ **画布左边压进刘海**。
 *
 * ⚠️ **底纹不在这里**（2026-10-13 起）：它是模板里 `<image class="stage__backdrop">`
 * 垫底层（file:// 下内联绝对 url 不加载，见组件头注释）；本样式只负责安全区 padding。
 */
const stageStyle = computed(() => {
  const { insets } = viewport.value;
  return {
    paddingTop: `${insets.top}px`,
    paddingRight: `${insets.right}px`,
    paddingBottom: `${insets.bottom}px`,
    paddingLeft: `${insets.left}px`,
  };
});

const canvasStyle = computed(() => ({
  // 设计尺寸随安全区宽高比变化（layoutMetrics 保证 ≥1334×750）；缩放后严丝合缝铺满安全框。
  width: `${metrics.value.width}px`,
  height: `${metrics.value.height}px`,
  transform: `scale(${metrics.value.scale})`,
}));
</script>

<template>
  <view class="stage" :style="stageStyle">
    <!--
      底纹层（2026-10-13 起）：**`<image>` 垫底层**，替代原先的内联 `background-image`——
      发布包 file:// 下内联样式里的绝对 url() 解析到文件系统根 ⇒ 底纹 404（组件头注释有全文）。
      ⚠️ 必须**留在 `.stage` 里的第一个位置**：它与 .canvas / 旋转层同为定位层，DOM 序决定
      绘制层级（谁在后谁在上）；挪到 canvas 之后会把整页盖住。
    -->
    <image class="stage__backdrop" :src="backdropImage" mode="aspectFill" />
    <!--
      全局暗化遮罩（UI 优化步骤①，2026-10-27）：压暗画布基底、提升 UI 面板对比度。
      放在底纹层之上、画布内容之下 —— 底纹仍可见但不再"亮"，面板的 0.62 透明叠加后
      实际效果接近 0.85+，整体观感从"雾蒙蒙"变成"有实体感"。
      ⚠️ pointer-events: none —— 不拦截任何点击事件（穿透给画布内的 UI）。
      顶部/底部稍暗（安全区边缘）、中部稍亮（UI 内容集中区），径向渐变聚焦中心。
    -->
    <view class="stage__scrim" />
    <view v-if="portrait" class="stage__rotate">
      <text class="stage__rotate-title">请旋转设备</text>
      <text class="stage__rotate-hint">本游戏以横屏游玩</text>
    </view>
    <view v-else class="canvas" :style="canvasStyle">
      <slot />
      <!--
        overlay 具名槽（Task 3 · 提示收敛）：页面把 `<NoticeStack>` 投到这里，浮层跟着
        画布一起缩放 ⇒ `NoticeItem` 的尺寸可以按设计像素写。**槽必须在 `.canvas` 内**：
        放到 `.stage` 下会脱离 `transform: scale(k)`，同一份 CSS 在真机上大小对不上。
      -->
      <view class="stage__overlay">
        <slot name="overlay" />
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 全视口舞台。
 * ⚠️ `overflow: hidden` **常驻**（不只在失败路径）—— 整页不滚动（spec §2.2）。
 */
.stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  /**
   * 🔴 **只能用 `center`，禁止 `safe center`（2026-10-15 安卓 Chrome 事故复盘）**：
   * flex 排版发生在 `transform` **之前** —— `.canvas` 的布局盒是未缩放的**设计尺寸**
   * （典型手机 1626×750），舞台内容盒是安全区（典型 852×393），布局盒在构造上
   * **必然溢出**容器；`transform: scale(k)` 之后视觉盒才恰好铺满。
   * `safe center`（Chromium 115+ 生效，Safari/Firefox 至今不识别会被丢弃）按
   * **布局盒**检测到溢出 ⇒ 退化为 `start` ⇒ 布局盒锚到 (0,0)，而
   * `transform-origin: center` 仍围绕布局盒中心缩放 ⇒ 视觉画布整体偏到右下角、
   * 左上只剩底纹、右下内容被裁（实测：视口 852×393 时画布视觉原点跑到 (387,179)）。
   * 这正是「iPhone Safari 验证正常、换安卓 Chrome / DevTools 设备就只显示一部分」
   * 的根因。普通 `center` 让布局盒负偏移居中，scale 后视觉盒严丝合缝铺满安全框
   * （同一视口实测视觉原点 (0,0)）。
   * 读数陈旧的失败模式由 `sanitizeViewport` + last-good + 旋转/回前台复读收敛负责，
   * 不再依赖 CSS `safe`（机械判据见 landscape-canvas.test.ts）。
   */
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 兜底色（底纹层的图不加载时的最坏形态；路径不在这里——见组件头注释与 R713 判据）。 */
  background-color: $ftl-color-table-center;
}
/**
 * 底纹层（2026-10-13 起；前身是 `.stage` 的内联 `background-image`，形态变迁理由见组件头注释）：
 * 绝对定位铺满整块舞台（含安全区 padding，与原 `background-clip` 行为一致），
 * `mode="aspectFill"` ≡ 原 `background-size: cover` + `center`。
 * ⚠️ z 序：与 `.canvas`（自带 `position: relative`）、`.stage__rotate`（本文件加了
 *    `position: relative`）同处定位层，**DOM 序**决定绘制层级 —— 本层必须排在最前。
 */
.stage__backdrop {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
/**
 * 全局暗化遮罩（UI 优化步骤①，2026-10-27）。
 * DOM 序在 `.stage__backdrop` 之后、`.canvas` / `.stage__rotate` 之前 ——
 * z 序严格：底纹 → 遮罩 → 内容。
 *
 * 渐变策略：径向渐变聚焦中心（UI 内容主要在舞台中央），边缘压暗让"舞台"有边界感。
 * 叠加一层上下微渐变：顶部/底部安全区额外加深一点（那里没有内容、加深不影响可读性）。
 *
 * 强度设计：中心 `rgba(night, 0.32)` → 边缘 `rgba(night-deep, 0.58)`。
 * 面板 `rgba(night, 0.62)` + 遮罩中心 `rgba(night, 0.32)` 叠加 → 基底底色已是 night 色阶、
 * 面板再盖一层 0.62 的 night，实际观感接近"实色深蓝面板"，底纹不再明显透穿。
 */
.stage__scrim {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  background:
    radial-gradient(
      ellipse 85% 70% at 50% 50%,
      rgba($ftl-color-night, 0.32) 0%,
      rgba($ftl-color-night-deep, 0.58) 100%
    ),
    linear-gradient(
      180deg,
      rgba($ftl-color-night-deep, 0.18),
      transparent 20%,
      transparent 80%,
      rgba($ftl-color-night-deep, 0.18)
    );
}
/** 竖屏提示层。⚠️ `position: relative` 是给底纹层让位的 z 序要求（见上）。 */
.stage__rotate {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-6;
  align-items: center;
  justify-content: center;
}
/**
 * 画布：**全出血自适应** —— 设计尺寸由内联 style 按 `layoutMetrics` 给出（宽 ≥1334、高 ≥750），
 * 缩放由 `transform: scale(k)` 承担，缩放后恰好铺满安全框（不再需要 margin:auto / 居中留边）。
 * 内部六页的根块全部 `width/height: 100%`，自动吃满整张画布。
 * （外层 `.stage` 仍保留 flex 居中 —— 那是竖屏旋转提示层的排版基准，画布尺寸精确时无偏移。）
 */
.canvas {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  transform-origin: center center;
}
/**
 * 浮层槽（Task 3 · 提示收敛）：铺满画布、**不参与点击**（穿透给页面；条目自己
 * `pointer-events: auto`）。z-index 15 与 `NoticeStack` 根同级、在画布内成层 ——
 * 页面里更高的层（结算弹窗等）由各自的迁移任务按需调整。
 */
.stage__overlay {
  position: absolute;
  inset: 0;
  z-index: 15;
  pointer-events: none;
}
.stage__rotate-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xl;
  font-weight: 700;
}
.stage__rotate-hint {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
}
</style>
