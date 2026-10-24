<script setup lang="ts">
/**
 * 一张牌。
 *
 * **牌面有两条路径，互斥**（R696 / R693）：
 *  ① **有素材**：渲染 `static/cards/` 的真卡图（含花色），`src` 由 `(r, s)` 查 `manifest.json`；
 *  ② **素材缺失**：回落**文本牌面** —— 角标点数 + 中央点数，内容来自 `protocol.toDisplay()`。
 *     兜底**不是第二套视觉**，只是同一张牌的降级画法（R693：避免白屏）。
 *
 * ⚠️ **无论哪条路径，牌面文字都只能来自 `protocol.toDisplay()`**
 * （§12.2 F10：前端不得自制点数映射）。映射表给的是**文件名**，不是文字。
 * 另：`aria-label` 也是 `toDisplay` 的结果 —— 那是 F10 在「有素材」这条路径上的落点
 * （文本层不渲染了，但「牌面文字从哪来」这件事仍然可判）。
 *
 * 这里没有、也永远不该有：牌型判定、大小比较、点数映射。
 *
 * ➍ 历史口径（R655）：DouZero 编码曾是 rank-only，所以只画点数不画花色。
 * R696 之后 `s` 已随协议下发 ⇒ 花色由**图片**承载，`toDisplay` 仍然只给点数。
 */
import { computed } from "vue";
import { toDisplay } from "@fight-the-landlord/protocol";
import { tableAsset } from "../asset";
import manifest from "../pages/table/static/cards/manifest.json";

defineOptions({ name: "Card" });

/**
 * 牌面映射表（R702）：**数据文件**，键 `{s}-{r}`、值 = `static/cards/` 下的文件名。
 *
 * ⚠️ 这是**资源名 ↔ 展示图片**的映射，**不是**「点数 → 牌面文字」的自制映射 ——
 * 后者由 `protocol.toDisplay()` 唯一提供，`source-boundary` 有闸（spec §6.2 R702 明文）。
 * 本组件从这份表里只取**文件名**，一个字符都不渲染成文字。
 *
 *  ⚠️ 这里用 **`import`** 而不是 URL 引用 —— 两者不是一回事：
 *  · `import` ⇒ Vite 把 JSON 当**模块**打进 JS 包（编译期就查得出键错、无运行期请求）；
 *  · 运行期 URL ⇒ uni 的拷贝插件把图片**原样复制**到分包 static 目录，运行期由宿主去取。
 * 牌面**图片**必须走后者（图不能进 JS 包）；这张**表**走前者。
 *
 * `resolveJsonModule` 已在 `tsconfig.base.json` 打开，所以 JSON import 能通过 `vue-tsc`。
 */
const FACE_MANIFEST = manifest as Record<string, string>;

const props = withDefaults(
  defineProps<{
    /** DouZero 编码（协议层编码；本组件只把它交给 toDisplay 与映射表）。 */
    value: number;
    /**
     * R696 的花色：0♠ 1♥ 2♣ 3♦ 4王。
     *
     * ⚠️ 默认 **4 = 王** —— 缺省时在映射表里**查不到**（王的键只有 `4-20`/`4-30`，
     * 而占位调用点传的是 `value: 0`），于是走文本兜底分支。
     * 这个默认值是**刻意**的：宁可回落文本，也不要静默画错一张牌面。
     */
    suit?: number;
    selected?: boolean;
    disabled?: boolean;
    /** 牌面档位。`normal` = 手牌（155×202）· `mid` = 出牌区（90×117）· `small` = 底牌（40×52）。片② / R731。 */
    size?: "normal" | "mid" | "small";
    /**
     * 牌背（➌「牌背扇」的依赖，➏ 的底牌位共用同一份实现）。
     *
     * 牌背是「看不见的牌」：**不渲染任何文字、不渲染 `data-value`、`disabled`、点击不 emit**。
     * 它只是牌张数的可视化（张数来自服务端 `cardCounts`），不含任何规则判断。
     */
    faceDown?: boolean;
  }>(),
  {
    suit: 4,
    selected: false,
    disabled: false,
    size: "normal",
    faceDown: false,
  },
);

const emit = defineEmits<{ (e: "toggle", value: number): void }>();

/**
 * ⚠️ 牌背**不调 `toDisplay`**：它的 `value` 只是占位（座位几何没有牌值可给），
 * 而「一张看不见的牌」也不该有牌面字符。牌面的点数映射永远只走 `protocol.toDisplay`（F10）。
 */
const face = computed(() => (props.faceDown ? "" : toDisplay(props.value)));
/** 仅用于样式（红色/王），不参与任何规则判断。 */
const tone = computed(() =>
  face.value.includes("大") ? "red" : face.value === "2" ? "red" : "black",
);

/**
 * F3：双字符面值（`10` / 小王 / 大王）在 `$ftl-card-w-small`（96px，可用 88px）里放不下单档字号
 * ⇒ 模板给它挂 `.card--wide`，角标与中央点数**一起**降到 `$ftl-font-card-small` 档。
 *
 * 纯**排版分类**（只看 `toDisplay` 结果的字符数），不含任何规则判断；牌背（`face === ''`）不命中。
 */
const wide = computed(() => face.value.length > 1);

/**
 * 牌面图的 URL。三条来源，**一条查不到就回落**（R693：不白屏）：
 *
 *  · **牌背**（`faceDown`）→ `manifest.back`（`CardBack.png`）。
 *    ⚠️ 这一段是 **2026-09-21 补的**：之前 `faceDown` 直接返回空串 ⇒ 牌背**一直是
 *    CSS 斜纹画的**，而 `CardBack.png` 早已入库、进了 manifest、还被预算闸断言「存在」——
 *    但**没有任何地方渲染它**（预算闸只断言文件**在**，不断言文件**被用**）。
 *  · **牌面** → `{s}-{r}` 查表；
 *  · **查不到**（花色未登记 / 素材未入库）→ 空串 ⇒ 走文本兜底。
 *
 * ⚠️ 路径是**绝对路径** `/static/...`：`static/` 被 uni 的 `uniCopyPlugin` 原样复制到
 * 产物根、完全不走 Vite 的 asset 管线（不哈希、不内联）—— 已实测三处（H5 dev / H5 发行 /
 * App），见 `static/ASSETS.md` 的 spike 结果表。
 */
const faceSrc = computed(() => {
  const file = props.faceDown
    ? FACE_MANIFEST.back
    : FACE_MANIFEST[`${props.suit}-${props.value}`];
  // 牌面素材随**牌桌分包**走（项 6）：物理在 `src/pages/table/static/cards/`，
  // 产物 `/pages/table/static/cards/...`，不占微信主包。
  return file ? tableAsset(`cards/${file}`) : "";
});

/** 牌背不可点（即使宿主忘了传 `disabled`，也不会 emit 出一次「选中」）。 */
function onClick() {
  if (props.faceDown) return;
  emit("toggle", props.value);
}
</script>

<template>
  <button
    type="button"
    class="card"
    :class="[
      `card--${size}`,
      `card--${tone}`,
      {
        'card--selected': selected,
        'card--disabled': disabled,
        'card--back': faceDown,
        'card--wide': wide,
      },
    ]"
    :disabled="disabled || faceDown"
    :aria-pressed="faceDown ? undefined : selected"
    :aria-label="faceDown ? undefined : face"
    :data-value="faceDown ? undefined : value"
    @click="onClick"
  >
    <!--
      牌面 / 牌背图（R696）。**两条路径互斥** —— 有素材就**不**渲染文本层，
      否则同一张牌会有两份牌面来源（谁是「真源」就说不清了）。

      ⚠️ 牌背（`faceDown`）现在也走这张图（`CardBack.png`）。图上**没有**任何文字与
      `data-value`（两者都由 `v-if="!faceDown"` / 根节点的 `:data-value` 保证）。
      ✅ 图加载失败时它是个空元素 ⇒ 底下的 `.card--back` CSS 斜纹会**自动透出来** ——
      这就是牌背的兜底，不需要额外分支。
    -->
    <image
      v-if="faceSrc"
      class="card__face"
      :src="faceSrc"
      mode="scaleToFill"
    />
    <!-- 兜底（R693）：**牌面**素材缺失时回落文本牌面，避免白屏。**不是第二套视觉**。 -->
    <template v-else-if="!faceDown">
      <text class="card__corner">{{ face }}</text>
      <text class="card__center">{{ face }}</text>
    </template>
  </button>
</template>

<style scoped lang="scss">
/**
 * 两档尺寸由 `size` prop 决定（`.card--normal` / `.card--small`）。
 * 牌桌需要更紧凑的牌宽时，由**容器**用自己的 `:deep(.card)` 覆盖 —— `Card` 自己不猜上下文。
 */
.card {
  box-sizing: border-box;
  /*
   * ⚠️ **`margin: 0` 是布局正确性的一部分，不是装饰**：H5 上 `<button>` 编译成
   * `uni-button`，宿主基样式带 `margin-left/right: auto`。手牌宿主的 `.card + .card`
   * 只覆盖 `margin-left`（负重叠），`margin-right: auto` 会把行内**剩余空间均摊到
   * 每张牌之间** —— 牌越少摊得越开，间距随张数变化（用户反馈的「牌被拉伸」根因）。
   * 大厅/玩法/登录页的按钮都踩过同一个坑。
   */
  margin: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 $ftl-card-w;
  width: $ftl-card-w;
  height: $ftl-card-h;
  padding: 0;
  /*
   * 2026-10-11 第八轮（用户裁决「手牌有白边，去除」）：**不再画容器边框** ——
   * 素材最外圈自带 1px #d2d2d2 灰轮廓线，旧实现再叠 2px #c8c8c8 border，蓝底上是双层灰圈。
   * 改由牌面图出血裁切线（见 `.card__face` 的 `$ftl-card-face-bleed`），白底仅留作
   * 素材角透明/图缺失/文本兜底时的衬底。`overflow: hidden` 让出血部分按本框圆角裁切。
   */
  border: none;
  border-radius: $ftl-radius-sm;
  overflow: hidden;
  /*
   * 常驻**柔和投影**（第八轮，参考欢乐斗地主实机）：去描边后牌与牌靠阴影分层 ——
   * 扇形重叠时后一张的左缘影落在前一张净露区形成分界暗线，底缘影把牌浮在桌布上。
   * 外阴影画在 border-box 外，不受本元素 `overflow: hidden` 裁切。小档见 `.card--small`。
   */
  box-shadow: $ftl-shadow-card;
  /*
   * 🔴 **uni-app 坑**：H5 上 `<button>` 编译成 `UNI-BUTTON`，宿主默认给 `::after` 挂
   * 0.67px rgba(0,0,0,.2) 边框（普通边框之外的第二道框）——去 border 后它浮现在牌缘，
   * 扇形里就是牌间细灰竖线。必须显式置空（uni 官方同款改法）。
   */
  &::after {
    border: none;
  }
  background: $ftl-color-surface;
  font-size: $ftl-font-card;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition: transform 0.08s ease;
}
/**
 * **中档**（片② / R731 新增）：出牌区专用。
 * 参考图实测出牌组高 170 原图 px → 画布 117；`90 / 117 = 0.769` 贴住源图比例。
 * ⚠️ 它是 `Hand.vue` 的**默认档**（`PlayArea` 不传 `size`）⇒ 别把默认值改回 `small`。
 */
.card--mid {
  flex-basis: $ftl-card-mid-w;
  width: $ftl-card-mid-w;
  height: $ftl-card-mid-h;
  font-size: $ftl-font-card-small;
}
.card--small {
  flex-basis: $ftl-card-w-small;
  width: $ftl-card-w-small;
  height: $ftl-card-h-small;
  font-size: $ftl-font-card-small;
  /* 牌小阴影同步减半（底牌簇再由 BottomCards 放大尺寸，投影仍用本小档，观感一致）。 */
  box-shadow: $ftl-shadow-card-sm;
}
.card--red {
  color: $ftl-color-danger;
}
.card--black {
  color: $ftl-color-text;
}
/**
 * 选中态 = **抬升 + 描边**（不是变色）。
 *
 * ⚠️ **刻意不加 `z-index`**（2026-10-10 用户裁决）：扇形重叠里牌按 DOM 顺序绘制，
 * 后一张本来就压着前一张的右缘。一旦给选中牌 `z-index: 1`，它会跳到**后一张牌
 * 之上**，把邻牌左上角的点数角标盖住 —— 这就是「抬起时遮挡其它牌」。
 * 不加 z-index ⇒ 绘制顺序不变 ⇒ 抬起的牌遮住的区域与平放时**逐像素相同**：
 * 后一张仍压在它右缘（与普通扇形一致），它本身靠左的点数角标完全可见，
 * 配合 24px 上移 + 蓝框 + 投影，选中态依然明确。
 */
.card--selected {
  transform: translateY(-$ftl-card-lift);
  /*
   * 抬起 24px ⇒ 阴影三层：保留桌面牌影（牌间分界不断）+ 蓝色描环（选中指示，替代旧 border）
   * + 蓝色软投影（浮得更高）。外阴影不受本元素 `overflow: hidden` 影响。
   */
  box-shadow:
    $ftl-shadow-card,
    0 0 0 3px $ftl-color-primary,
    $ftl-shadow-primary;
}
/**
 * 非交互牌（出牌区 / 底牌 / 牌背）仍走原生 `disabled` 拦点击，但**不做透明度惩罚**：
 * 它们是「信息」而不是「点不动的控件」——走查实测 `opacity: .6` 会让他人打出的牌和
 * 亮出的底牌整体泛白（P2-18）。禁用只靠原生 `disabled` + `faceDown` 守卫，视觉不降级。
 */
.card--disabled {
  cursor: default;
}
/**
 * 牌面图（R696）。铺满牌框 —— 牌框比例已按源图 80×104 定档（见 `$ftl-card-w/h`），
 * 所以 `mode="scaleToFill"` 的拉伸量可忽略（0.4%）。
 *
 * 2026-10-11 第八轮去白边：图按 `$ftl-card-face-bleed`（1.03）放大出血，把素材最外圈那圈
 * 1px #d2d2d2 灰轮廓线推出父框裁切线（父框 `overflow: hidden` + 圆角负责裁切，本元素不再
 * 自己圆角）。牌背图走同一规则（边缘浅青高光一并裁净）。
 */
.card__face {
  width: 100%;
  height: 100%;
  transform: scale($ftl-card-face-bleed);
}
/**
 * ⚠️ **以下到本文件末尾的牌面排版规则（`.card__corner` / `.card__center` / `.card--wide`
 * / `.card--red` / `.card--black`）只服务「素材缺失」的兜底分支**（R693）。
 *
 * 有素材时它们不渲染 —— 但**不删除**：兜底路径要靠它们把牌画得像一张牌，
 * 而且 `.card--wide` 的**分类**判据（`card-hand-interaction` 的 F3）仍然有效。
 */
/** 角标点数（左上角）：比中央点数小一档；单行不折行（`.card--wide` 命中时更容易撑破牌宽）。 */
.card__corner {
  position: absolute;
  top: $ftl-space-2;
  left: $ftl-space-2;
  font-size: $ftl-font-card-corner;
  line-height: 1;
  white-space: nowrap;
}
/** 中央点数：尺寸随 `size` 两档（`.card--normal` / `.card--small`）。 */
.card__center {
  font-size: $ftl-font-card;
  line-height: 1;
}
.card--small .card__center {
  font-size: $ftl-font-card-small;
}
/**
 * 双字符面值（F3）：`10` / `小王` / `大王` —— 牌宽只有 `$ftl-card-w-small`（96px，可用 88px），
 * 48px 的角标与 80px 的中央点数都会折行/溢出（角标还会与中央相压）。
 * 命中时**两处一起**降到 `$ftl-font-card-small` 档（单字符面值保持原档，观感不变）。
 */
.card--wide .card__corner,
.card--wide .card__center {
  font-size: $ftl-font-card-small;
}
/** 两处文字都不吃点击 —— 命中的永远是牌本身。 */
.card__corner,
.card__center {
  pointer-events: none;
}
/**
 * 牌背（`faceDown`）的**兜底底色 + 纹样**。
 *
 * ⚠️ **2026-09-21 起它不是牌背的主视觉** —— 主视觉是 `CardBack.png`（`faceSrc` 在
 * `faceDown` 时返回 `manifest.back`），覆盖在上面。本规则只在**那张图没加载出来**时可见
 * （`<image>` 加载失败是空元素 ⇒ 底下的纹样自动透出来）。
 *
 * 保留它的理由正是这个兜底：删了它，图一旦缺失牌背就是**一片空白**（R693：不白屏）。
 *
 * 颜色只取 `$ftl-color-card-back` / `$ftl-color-card-back-line` 两个令牌（不得就地硬编码）；
 * 尺寸复用 `.card--small` 的牌宽高 ⇒ **本仓只有这一份牌背样式**（➏ 的底牌位共用同一份）。
 */
.card--back {
  /* 容器 border 已删（第八轮）；这里只留**图缺失时**的斜纹衬底与内框，图正常时被牌背图完全盖住。
     牌背恒为 small 档 ⇒ 外影用 $ftl-shadow-card-sm（本条 box-shadow 会覆盖基类，必须显式带回）。 */
  background-color: $ftl-color-card-back;
  background-image: repeating-linear-gradient(
    45deg,
    $ftl-color-card-back 0,
    $ftl-color-card-back 6px,
    $ftl-color-card-back-line 6px,
    $ftl-color-card-back-line 8px
  );
  box-shadow:
    $ftl-shadow-card-sm,
    inset 0 0 0 4px $ftl-color-card-back-line;
  cursor: default;
}
</style>
