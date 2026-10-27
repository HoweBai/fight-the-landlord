<script setup lang="ts">
/**
 * 座位（➌ 座位几何）。
 *
 * 2026-10-11 第五轮布局调整（zt1–zt5 用户裁决，照欢乐斗地主实机截图）：
 *  - **对手 = zt5 浮动组**：zt4 纵列 + 剩余牌数字牌**左右布局**，牌体垂直**贴头像下缘**、
 *    水平**压进圆边 10px 骑在角上**（左对手落**右下**角、右对手经 `mirror` 翻**左下**角；
 *    三次走查规格：牌底 30×41、数字 24px 独立角标档）；
 *    zt4 纵列 = zt2（zt1 头像+头像环 / 昵称上下排）→ zt3（货币图标 + 数量），
 *    三层宽度统一锁成头像宽；昵称超长省略号，货币过长缩写万/亿；
 *    地主徽挂在头像**朝中央的上角**（左座右上角、右座左上角）；右座由 `mirror` 整体镜像；
 *  - 「我」= 底栏分件（第六轮拆件；第七轮用户调位）：`part="avatar"` 头像在**左下角**
 *    （地主徽挂头像**左上角**），`part="meta"` 昵称 / 金币紧贴头像**右侧**、与头像下缘
 *    对齐（像坐在头像左下角）；HUD 无底色浮在右下角；无钟、无剩牌数字牌。
 *    两个实例由 `table.vue` 摆放（CSS 在 `.table__me-foot/info`），默认 `part="all"` 仍是整组横排。
 *
 * 倒计时钟、「不出」与叫抢回显**均不在本组件**（2026-10-11 用户裁决）：
 *  - 对手迷你钟抽成 `TurnTimer.vue`，挂在 `table.vue` 的对手出牌/状态列；
 *  - 对手的「不出」挂在同一出牌/状态列（`.table__play-pass`）；
 *  - 对手的叫抢回显同挂出牌/状态列（`.table__play-bid-echo`，第五轮从 zt5 下方迁入）；
 *  - 我的「不出」挂在动作行原按钮位（`.table__my-pass`）。
 *
 * 渲染的全部内容都来自**服务端裁剪视图**经 `table.vue` 传下来的 props：
 *  - 昵称 / 座位号 / 剩几张：展示；
 *  - 「谁是地主」：`PlayerView.landlordSeat`（§6.4 的唯一来源），本组件只做「是/不是」的展示；
 *  - 「轮到谁」：`PlayerView.currentPlayer`（出牌期）或 `bidPhase.currentBidder`（叫抢期）——
 *    由 `table.vue` 归一化后以 `isActive` 传入，本组件**不做任何推断**（§12 哑终端）；
 *  - ② 金币场：余额（`balance`）——**有值 ⇒ 渲染金币位；无值 ⇒ 渲染免费场底分占位或不渲染**
 *    （2026-10 C 方案：免费场不再空着 —— 显示底分占位让用户知道不是 bug）。
 *  - 挂机治理（C28）：「托管中」徽标（`trustee`）——**唯一来源** `PlayerView.trustees[seat]`
 *    （由页面防御读 `trustees?.[i] ?? false` 后传入；缺字段 ⇒ `false`，探针注入的残缺视图
 *    照常渲染）。文案是常量字面量「托管中」（规格 §0 钉子）。
 *
 * ⚠️ **R727（片②）：对手的剩余手牌是「数字徽章」**（参考图同款卡片形数字牌 13 / 17），
 * 不是一叠牌背；张数仍来自服务端 `cardCounts[seat]`。本组件**不渲染任何 `.card`**，
 * 牌背（`Card.faceDown`）只由底牌位使用。
 */
import { computed } from "vue";
import { tableAsset } from "../asset";

const props = withDefaults(
  defineProps<{
    /** 座位号（服务端坐标：0/1/2）。展示与 `key` 用，不参与判断。 */
    seat: number;
    /** 昵称（由页面按座位号生成；本组件不猜）。 */
    name: string;
    /** 该座位**还剩几张牌**（服务端 `PlayerView.cardCounts[seat]`）。 */
    cardCount: number;
    /** 是否地主（唯一来源 `PlayerView.landlordSeat`）。 */
    isLandlord: boolean;
    /** 是否当前行动者（由页面按阶段归一化后传入）。 */
    isActive: boolean;
    /**
     * ② 金币场（§2.3 / D7）：该座位的钱包余额（服务端 `RoomPlayer.balance` 经页面传入）。
     * 数字 ⇒ 渲染金币位（暖色）；缺省 / `null` ⇒ 渲染免费场底分占位（冷色，若 baseScore > 0）
     *   或不渲染（baseScore 也没传）。**自动分流**，无需额外模式 prop —— 向后兼容原行为。
     */
    balance?: number | null;
    /**
     * 免费场底分（2026-10 C 方案）：当 balance 为 null 时，若 baseScore > 0 则渲染
     * 「分 X」占位，让用户知道这是免费场、不是 bug。缺省 0 ⇒ 不渲染。
     */
    baseScore?: number;
    /**
     * 挂机治理（C28）：该座位是否**托管中**（唯一来源 `PlayerView.trustees[seat]`，
     * 页面已做缺字段兜底 `?? false`）。`true` ⇒ 昵称行下方挂「托管中」徽标；缺省不渲染。
     * ⚠️ 本组件不推断「为什么托管」、不区分手动/自动（那是服务端治理层的事）。
     */
    trustee?: boolean;
    size?: "opponent" | "me";
    /**
     * 右座镜像（2026-10-10 仿欢乐斗地主布局）：对手组整体右对齐 —— 头像贴右角、
     * 信息行反过来（数字牌在信息块**左**侧）、地主徽挂头像**左**上角。
     * ⚠️ 纯展示方位，由页面按自己在中段的摆位传入；本组件不推断「谁在右边」。
     */
    mirror?: boolean;
    /**
     * 分件渲染（**仅「我」档生效**，2026-10-11 第六轮：头像与昵称/金币在底栏分到
     * 左右两组）：
     *  - `all`（默认）：头像 + 昵称 + 金币，对手档也恒走这一档（对手不拆）；
     *  - `avatar`：只渲染头像槽（圆框/图/环/地主徽），昵称金币不画；
     *  - `meta`：只渲染昵称 + 金币，头像槽不画。
     * 约定与 `PlayerChip.vue` 的 `part` 同款；同一座位允许挂两个实例各取一件。
     */
    part?: "all" | "avatar" | "meta";
  }>(),
  {
    balance: null,
    baseScore: 0,
    trustee: false,
    size: "opponent",
    mirror: false,
    part: "all",
  },
);

/**
 * 头像位里的**兜底字块**（昵称末字）。
 *
 * §6.4 起头像走素材图（牌桌分包 `pages/table/static/av/`）—— 这个字块降为**兜底**：图片没加载出来时
 * 头像位仍然有东西可看（R693 同精神：不白屏）。它**不是**第二套头像设计。
 */
const initial = computed(() => props.name.slice(-1) || "?");

/**
 * 地主 / 农民两张头像（牌桌分包 `pages/table/static/av/`，项 6）。
 *
 * 纯展示：分支依据是 `isLandlord`，而它**只**来自服务端 `PlayerView.landlordSeat`（§6.4）
 * ⇒ 本组件不推断、不补默认。
 *
 * 版本 query 统一走 `tableAsset()`（dev no-cache / 生产 ?v=版本，见 src/asset.ts），
 * 不再手工 bump `?v=`。
 */
const avatarSrc = computed(() =>
  props.isLandlord
    ? tableAsset("av/Landlord.png")
    : tableAsset("av/Farmer.png"),
);

/**
 * 报单 / 报双（剩 1–2 张）的数字牌预警档（纯展示）。数据是服务端 `cardCounts`，零规则。
 * ⚠️ 只作用在对手的数字牌上（「我」不渲染数字牌）。
 */
const tileWarn = computed(() => props.cardCount > 0 && props.cardCount <= 2);

/**
 * 货币数量的**展示缩写**（zt3，2026-10-11 第五轮用户裁决）：纯展示层换算，不改服务端值 ——
 *  · ≥ 1 亿 ⇒ `x.x亿`；≥ 10 万 ⇒ `x.x万`（最多一位小数，去尾零）；
 *  · 10 万以下（含 `12345` 这类五位数）**原样显示** —— `player-chip` 契约钉死 12345 不缩写，
 *    且五位数在 zt3 的头像等宽胶囊里放得下；只有「过长」才换算。
 * 万档四舍五入若进位到 10000 万（如 99,999,999）⇒ 改挂亿档，避免穿出「10000万」。
 */
function compactBalance(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  /** 除档后保留至多一位小数并去尾零（1.0 → "1"，1.2 → "1.2"）。 */
  const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);
  if (abs >= 100_000_000) return `${sign}${oneDecimal(abs / 100_000_000)}亿`;
  if (abs >= 100_000) {
    const wan = Math.round((abs / 10_000) * 10) / 10;
    if (wan >= 10_000) return `${sign}${oneDecimal(abs / 100_000_000)}亿`;
    return `${sign}${wan}万`;
  }
  return String(value);
}
const balanceText = computed(() => compactBalance(props.balance));
</script>

<template>
  <view
    class="seat"
    :class="[
      `seat--${size}`,
      { 'seat--active': isActive, 'seat--right': mirror },
    ]"
  >
    <!--
      ============ 对手：zt5 浮动组（zt4 等宽纵列 + 底部数字牌，无底板，照欢乐斗地主） ============
    -->
    <template v-if="size === 'opponent'">
      <!--
        ============ zt5：zt4 纵列 + 剩余牌数字牌左右布局，数字牌**贴底** ============
        左对手：纵列在左、数字牌在头像组**右下**角；
        右对手（`.seat--right`）经 `row-reverse`：数字牌在头像组**左下**角。
      -->
      <view class="seat__stack">
        <!--
          ============ zt4：头像(zt1)/昵称/货币三层纵列，宽度统一锁成头像宽 ============
        -->
        <view class="seat__column">
          <!--
            zt2：zt1（头像 + 头像环为一整体，地主徽挂头像朝中央的上角）+ 昵称，上下布局。
            昵称宽度 = zt1：过长只留前面几个字 + 省略号。
          -->
          <view class="seat__id">
            <!-- 头像框（圆框裁切，图满铺）+ 头像环（压框边，不被裁）+ 挂角徽/角标同槽。 -->
            <view class="seat__avatar-slot">
              <view class="seat__avatar">
                <text class="seat__avatar-initial">{{ initial }}</text>
                <!-- aspectFill：人物图铺满圆框，超出圆框的部分被 `.seat__avatar` 裁掉。 -->
                <image
                  class="seat__avatar-img"
                  :src="avatarSrc"
                  mode="aspectFill"
                />
              </view>
              <!--
              头像环：与圆框同心、等大，正好压在框边上。必须在 `.seat__avatar` **外面**——
              那个容器 overflow:hidden 会把探出圆边的外环裁掉；槽不裁切，外圈完整。
            -->
              <view class="seat__avatar-ring" />
              <!--
                地主徽挂头像**朝中央的上角**：左座右上角、`.seat--right` 翻到左上角。
                ⚠️ `isLandlord` 只来自服务端 `PlayerView.landlordSeat`（§6.4）：不推断、不补默认。
                ⚠️ class 名 `.seat__badge` **不变**（`table-seat-geometry` 的 §6.4 用例按它判断地主座位）。
              -->
              <view v-if="isLandlord" class="seat__badge" />
            </view>
            <view class="seat__name">
              <text>{{ name }}</text>
            </view>
            <!--
              挂机治理（C28）：托管中徽标。数据只来自服务端 `PlayerView.trustees[seat]`
              （页面防御读 `trustees?.[i] ?? false`）；文案是常量字面量「托管中」。
            -->
            <text v-if="trustee" class="seat__trustee">托管中</text>
          </view>

          <!--
            zt3：货币图标 + 数量为一整体，宽度同 zt1；数量过长（≥10万/≥1亿）换算万/亿。
            2026-10 C 方案：有 balance → 金币位（暖色）；无 balance 但有 baseScore → 底分位（冷色）；
            两者都没 → 不渲染（向后兼容旧的 balance === null 退场行为）。
          -->
          <view v-if="balance !== null" class="seat__coin">
            <view class="seat__coin-icon" />
            <text class="seat__coin-value">{{ balanceText }}</text>
          </view>
          <view v-else-if="baseScore > 0" class="seat__score">
            <view class="seat__score-icon">分</view>
            <text class="seat__score-value">底分 {{ baseScore }}</text>
          </view>
        </view>

        <!--
          张数数字牌（R727）：对手剩牌的**唯一**展示。数字 = 服务端 cardCounts。
          与纵列左右排、垂直中心对齐昵称行：左座在昵称右侧，`.seat--right` 反转后在昵称左侧。
        -->
        <view
          class="seat__count-tile"
          :class="{ 'seat__count-tile--warn': tileWarn }"
        >
          <text class="seat__count-tile-num">{{ cardCount }}</text>
        </view>
      </view>
    </template>

    <!--
      ============ 我：底栏（第六轮起头像与信息**分件**，由 table.vue 摆成左右两组） ============
      · part="avatar" 只画头像槽；part="meta" 只画昵称+金币；all 两件都画（默认/测试直挂用）。
    -->
    <template v-else>
      <view v-if="part !== 'meta'" class="seat__avatar-slot">
        <view class="seat__avatar">
          <text class="seat__avatar-initial">{{ initial }}</text>
          <image class="seat__avatar-img" :src="avatarSrc" mode="aspectFill" />
        </view>
        <!-- 头像环压框边（必须在裁切容器外，否则探出圆边的外环被裁）。 -->
        <view class="seat__avatar-ring" />
        <!-- 我的地主徽挂头像**左上角**（用户 2026-10-11 裁决，参考图 5）。 -->
        <view v-if="isLandlord" class="seat__badge" />
      </view>
      <template v-if="part !== 'avatar'">
        <view class="seat__name">
          <text>{{ name }}</text>
        </view>
        <!-- 挂机治理（C28）：托管中徽标（同对手档；数据只来自 `PlayerView.trustees`）。 -->
        <text v-if="trustee" class="seat__trustee">托管中</text>
        <view v-if="balance !== null" class="seat__coin">
          <view class="seat__coin-icon" />
          <text class="seat__coin-value">{{ balanceText }}</text>
        </view>
        <view v-else-if="baseScore > 0" class="seat__score">
          <view class="seat__score-icon">分</view>
          <text class="seat__score-value">底分 {{ baseScore }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style scoped lang="scss">
@import "../styles/animations.scss";

/**
 * 座位几何（2026-10-11 起严格照欢乐斗地主）。全部尺寸/颜色取 `src/uni.scss` 的 `$ftl-*` 令牌。
 * 两档由 `size` 决定：`.seat--opponent`（对手：zt5 无底板浮动组，`mirror` 镜像右座）
 * · `.seat--me`（我：底栏横排信息行）。
 */
.seat {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
}
.seat--opponent {
  align-items: flex-start;
  /* 叫抢回显在出牌/状态列、钟在出牌列 ⇒ 根下只剩 zt5 横排一个孩子。 */
  gap: $ftl-space-6;
}
/** 右座整体镜像：纵列右对齐、zt5 横排反转（数字牌到头像组左下）、地主徽挂头像左上角。 */
.seat--opponent.seat--right {
  align-items: flex-end;
}
.seat--me {
  flex: none;
  flex-direction: row;
  gap: $ftl-space-4;
  align-items: center;
}
/**
 * 轮次强指示（无底板时代）：头像发光环（`$ftl-shadow-primary-ring`）。
 * ⚠️ 它**只**表示「服务端说这个人是当前行动者」，不含任何「他能不能出」的判断。
 */
.seat--active .seat__avatar {
  box-shadow: $ftl-shadow-primary-ring;
}
/**
 * 头像槽：圆框头像、头像环、挂角地主徽/数字角标的共同定位基准。槽本身**不裁切**
 *（不能给 `overflow: hidden` —— 环的外圈与徽都要压到圆外），头像裁切由 `.seat__avatar` 自己做。
 */
.seat__avatar-slot {
  position: relative;
  flex: 0 0 auto;
  width: $ftl-size-avatar;
  height: $ftl-size-avatar;
}
.seat__avatar-slot .seat__avatar {
  width: 100%;
  height: 100%;
}
/**
 * 头像位（§6.4）= **圆形头像框**：`overflow: hidden` + `border-radius: 50%` 把人物图裁进圆框，
 * 超出圆框的部分一律不显示。**兜底字块在图片下层**（图没加载出来时仍有东西可看，R693）。
 */
.seat__avatar {
  box-sizing: border-box;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $ftl-size-avatar;
  height: $ftl-size-avatar;
  border-radius: $ftl-radius-pill;
  background: $ftl-color-primary-soft;
  color: $ftl-color-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  overflow: hidden;
}
/** 兜底字块（在图片**下层**）。 */
.seat__avatar-initial {
  line-height: 1;
}
/**
 * 头像图：绝对铺满。
 * ⚠️ 两张源图都是竖版人物图（`Landlord` 198×272 / `Farmer` 206×256）⇒ `mode="aspectFill"`
 * 等比放大铺满方框、上下超出部分交给圆框裁掉（不变形；2026-10-11 用户裁决：图要填满头像框）。
 */
.seat__avatar-img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
/**
 * zt5（2026-10-11 第五轮二次走查）：zt4 纵列 + 剩余牌数字牌**左右布局**。
 * 数字牌垂直中心对齐**昵称行中心**（margin 见 `.seat__count-tile`；同日走查用户裁决
 * 从「贴头像下缘」改为「与昵称水平」）⇒ 左对手数字牌落在昵称**右侧**；
 * 右座经 `row-reverse` 落在昵称**左侧**。
 */
.seat__stack {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  /* 间距由数字牌自身的负 margin 接管（要**压**在头像角上，不能留缝）。 */
  gap: 0;
}
.seat--right .seat__stack {
  flex-direction: row-reverse;
}
/**
 * zt4：头像(zt1)/昵称/货币三层纵列，宽度锁死 = 头像宽（`$ftl-size-avatar`）
 * ⇒ 三层等宽，整列不随昵称长短或数字位数伸缩。
 */
.seat__column {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: $ftl-space-3;
  width: $ftl-size-avatar;
  min-width: 0;
}
/**
 * zt2：zt1（头像 + 头像环）+ 昵称上下成组，组宽 = zt1；昵称居中。
 */
.seat__id {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 头像下缘到昵称：照参考图的紧凑一档。 */
  gap: $ftl-space-3;
  width: 100%;
  min-width: 0;
}
/**
 * 昵称：浮在蓝色牌桌上 ⇒ 白字 + 深描边（手法同 `.table__scene-name`，偏移 2px）。
 * 「我」的昵称 2026-10-11 第七轮起也**直接浮在牌桌底纹上**（白色信息底板此前已删、
 * HUD 胶囊底同轮去除 ⇒ 周边再无浅色区）⇒ me 档同样用白字，只把四向硬描边换成柔和投影
 *（与对手昵称同款，深底上可读且不糊字）。
 */
.seat__name {
  display: flex;
  flex-wrap: nowrap;
  gap: $ftl-space-2;
  align-items: center;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  white-space: nowrap;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.seat--me .seat__name {
  text-shadow: 0 2px 4px rgba($ftl-color-night-deep, 0.6);
}
/**
 * 对手昵称（zt2）：宽度锁成头像宽、居中；过长只留前几个字 + 省略号。
 * 白字只带**柔和投影**（实机没有四向硬描边，2px 四向描边在 26 号字上过重）。
 * ⚠️ 覆盖基类的 `display: flex` —— text-overflow 省略号要求块容器。
 */
.seat--opponent .seat__name {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  text-shadow: 0 2px 4px rgba($ftl-color-night-deep, 0.6);
}
/**
 * 「托管中」徽标（挂机治理 C28）：昵称行下方的小胶囊，深底 + 暖金字。
 * 对手档宽锁头像宽、居中；我档跟在昵称右侧（`.seat--me` 是横排）。
 * ⚠️ 不新增动效（与 reduced-motion 纪律同款）；文案是常量「托管中」，不在 CSS 里换字。
 */
.seat__trustee {
  flex: 0 0 auto;
  padding: 0 $ftl-space-3;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-deep, 0.75);
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xs;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}
/**
 * 地主徽章（片② / spec §3.5 素材槽；A′ 档接通竖牌素材）。
 * 2026-10-11 起**挂头像角**（不再跟昵称挤一行）：
 *  · 对手左座 = 头像右上角（朝中央），右座翻左上角；
 *  · 我 = 头像左上角（用户裁决）。
 * 三座**同档 40×70**（2026-10-11 第四轮走查参考图：对手徽实占头像约 40% 宽 / 72% 高，
 * 小档 32×56 明显偏小；小档令牌保留但暂无消费方）。
 * ⚠️ `.seat__badge` class 名不变（`table-seat-geometry` 的 §6.4 用例按它定位地主座位）。
 */
.seat__badge {
  box-sizing: border-box;
  position: absolute;
  top: -$ftl-space-5;
  left: -$ftl-space-5;
  z-index: 1;
  flex: 0 0 auto;
  width: $ftl-size-landlord-badge-w;
  height: $ftl-size-landlord-badge-h;
  background-image: $ftl-art-landlord-badge;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
/** 对手左座：徽挂右上角（朝中央，同大档 40×70）；右座翻左上角。 */
.seat--opponent .seat__badge {
  top: -$ftl-space-5;
  left: auto;
  right: -$ftl-space-5;
}
.seat--opponent.seat--right .seat__badge {
  left: -$ftl-space-5;
  right: auto;
}
/**
 * 头像环（片② / spec §3.5 素材槽）：**骑在头像框边上** —— 渲染层比圆框各大 8px
 *（对手 110 → 118、我 88 → 96）、同心居中 ⇒ 素材环带约一半在框外、一半压框边，
 * 不再吃进头像内部。定位基准是不裁切的 `.seat__avatar-slot`
 *（环的外圈探出圆边，放在 `.seat__avatar` 里会被 overflow:hidden 裁掉）。
 * 素材几何要求见 uni.scss `$ftl-art-avatar-ring` 处的出图规格（256 画布：外缘⌀252/内缘⌀226）。
 * ⚠️ 这一条**必须**用 `background-image: $ftl-art-avatar-ring;` 的写法（**不包 `url()`**）：
 * 令牌缺省是 `none`，而 `url(none)` 是非法值、整条声明会被静默丢弃（见 `uni.scss` 的说明）。
 */
.seat__avatar-ring {
  position: absolute;
  top: -4px;
  left: -4px;
  z-index: 1;
  box-sizing: border-box;
  width: calc(100% + 8px);
  height: calc(100% + 8px);
  border-radius: $ftl-radius-pill;
  background-image: $ftl-art-avatar-ring;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  pointer-events: none;
}
/**
 * 货币位（R717 → ② 金币场转真值）：金币场显服务端下发的该座余额，其余整块不渲染。
 * 金色取自强调色令牌（参考图的金币是暖色）；图标本身是素材槽，无图时只有文字。
 */
.seat__coin {
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  color: $ftl-color-accent;
}
/**
 * 货币图标（素材槽）：**现在无图** ⇒ `background-image: none`（合法），这一格是空的，
 * 观感由旁边的数值承担。素材到位时只改 `uni.scss` 里那一行，本组件一行不动。
 */
.seat__coin-icon {
  flex: 0 0 auto;
  width: $ftl-font-md;
  height: $ftl-font-md;
  background-image: $ftl-art-coin;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.seat__coin-value {
  font-size: $ftl-font-xs;
  font-weight: 600;
  white-space: nowrap;
}
/**
 * 对手档金币行（zt3，2026-10-11 第五轮）：**深海军蓝胶囊底 + 金黄粗字**，
 * 宽度锁成头像宽（与 zt1/昵称层等宽），图标 + 数值居中；纵向左右座不再需要方位覆盖。
 * 五位数原值在 26 号字 + 6px 侧留白内放得下；六位数起展示层已缩写成万/亿。
 * 「我」那一行直接浮在牌桌底纹上，用基类的无底色暖色（橙金）档。
 */
.seat--opponent .seat__coin {
  width: 100%;
  justify-content: center;
  gap: $ftl-space-2;
  padding: 2px 6px;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.55);
  color: $ftl-color-gold-light;
}
.seat--opponent .seat__coin-icon {
  width: $ftl-font-md;
  height: $ftl-font-md;
}
.seat--opponent .seat__coin-value {
  font-size: $ftl-font-sm;
  font-weight: 700;
  /* 兜底：极端长串不撑破等宽胶囊（正常路径由万/亿缩写兜住）。 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/**
 * 免费场底分位（2026-10 C 方案）：与金币位**同结构、冷色区分** —— 灰蓝调图标 + 中性白字，
 * 让用户一眼看出这是免费场、不是「金币余额加载失败」。
 */
.seat__score {
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  color: rgba($ftl-color-on-primary, 0.9);
}
.seat__score-icon {
  flex: 0 0 auto;
  width: $ftl-font-md;
  height: $ftl-font-md;
  /* 简洁的 CSS 图标：一个扁平的「分」字小标签（冷灰色，不用金币素材槽）。 */
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: rgba($ftl-color-on-primary, 0.8);
  /* 用一个微小的 CSS 绘制：圆形灰色小底上放"分"字 */
  background: rgba($ftl-color-night-deep, 0.5);
  border-radius: $ftl-radius-pill;
}
.seat__score-value {
  font-size: $ftl-font-xs;
  font-weight: 500;
  white-space: nowrap;
}
/** 对手档底分行：与对手金币位同结构但更弱化（浅底 + 中性字）。 */
.seat--opponent .seat__score {
  width: 100%;
  justify-content: center;
  gap: $ftl-space-2;
  padding: 2px 6px;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
  color: rgba($ftl-color-on-primary, 0.9);
}
.seat--opponent .seat__score-icon {
  width: $ftl-font-sm;
  height: $ftl-font-sm;
  font-size: 9px;
}
.seat--opponent .seat__score-value {
  font-size: $ftl-font-xs;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/**
 * 张数数字徽标（R727；2026-10-11 走查用户裁决「放大并与昵称水平」，同日再裁决
 * 「去掉 CSS 边框和兜底底色、保留 count-tile.png 素材」，素材换暖橙）：zt5 横排里
 * 与 zt4 纵列**左右布局**，垂直方向徽标中心对齐昵称行中心（margin 用头像/间距/
 * 昵称字号令牌算）；左座徽标在昵称右侧；右座横排 row-reverse 后在昵称左侧。
 *
 * 牌身就是素材 `$ftl-art-count-tile`（`count-tile.png`，**冷蓝**果冻玻璃 + 银白边；
 * 2026-10-12 起常态冷色融入蓝台面，暖橙旧图移作 `--warn` 预警专用牌身），
 * CSS **不**叠 border（素材自带牌身边，叠了是双框）、也不设兜底 background-color；
 * 圆角只取 2px 做裁切兜底（素材自带烘焙圆角，过大的 border-radius 会削掉玻璃边）。
 * 尺寸走独立令牌 `$ftl-size-count-tile-w/h`（36×49）。
 */
.seat__count-tile {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  /*
   * 牌的**垂直中心对齐昵称行中心**（2026-10-11 用户裁决「数字牌下移、和昵称水平」）。
   * 昵称行中心 = 头像高 + 头像/昵称间距 + 昵称行高/2；牌顶 = 该中心 − 牌高/2。
   * 代入令牌：110 + 6 + (26 − 49)/2 = 104.5px。
   */
  margin-top: calc(
    #{$ftl-size-avatar} + #{$ftl-space-3} +
      (#{$ftl-font-sm} - #{$ftl-size-count-tile-h}) / 2
  );
  /* 徽标盒子 36×49（兼作与昵称垂直居中的定位基准）。 */
  min-width: $ftl-size-count-tile-w;
  height: $ftl-size-count-tile-h;
  padding: 0;
  /* 无 CSS 描边、无兜底底色：牌身完全由 count-tile.png 承载（避免素材边 + CSS 边双框）。 */
  border: none;
  /* 素材自带烘焙圆角（36px 盒上映射约 2px），只留同样大小的裁切兜底，不削亮橙边。 */
  border-radius: 2px;
  background-image: $ftl-art-count-tile;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  color: $ftl-color-on-primary;
}
/* 右座：横排反转后徽标在纵列（昵称）左侧。 */
.seat--opponent.seat--right .seat__count-tile {
  margin-left: 0;
}
.seat__count-tile-num {
  /* 独立角标档 $ftl-font-count-tile(28)：2026-10-11 用户裁决放大（历档 24 → 28）。 */
  font-size: $ftl-font-count-tile;
  font-weight: 700;
  line-height: 1;
  /* 白字在牌身高光区对比卡线，叠一道中性暗投影兜底（冷蓝/暖橙两张牌身上都成立）。
     R714：禁裸 1px（缩放后消失）⇒ 偏移走 2px。 */
  text-shadow: 0 2px 2px rgba(0, 12, 40, 0.5);
}
/**
 * 报单 / 报双预警（§6.5-2 迁移）：剩 1–2 张时牌身切**暖橙预警专用素材**
 * `$ftl-art-count-tile-warn` + 红色光晕，数字保持白字
 * （2026-10-12 起常态冷蓝、预警暖橙；更早的 hue-rotate 滤镜方案同日废止）。
 * 数据现成（服务端 `cardCounts`），零协议改动；音效报单报双在 `useTableSound` 里，不受影响。
 */
.seat__count-tile--warn {
  background-image: $ftl-art-count-tile-warn;
  filter: drop-shadow(0 0 4px $ftl-color-danger-on-dark);
}
</style>
