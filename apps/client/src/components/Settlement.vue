<script setup lang="ts">
/**
 * 结算面板（玩法 §8.5 / 主规格 §6.3 的 `game.settlement` 载荷）。
 *
 * ⚠️ 本组件**一个数都不算**（§12.1 F01/F02/F10、M09）：
 *  - 倍数、底分、分差全部**原样**渲染服务端下发的字段；
 *  - 唯一的本地映射是 `spring` / `winner` 的**展示文案**（枚举 → 中文），
 *    这是枚举到文案的翻译，**不是**规则判断（谁赢、赢了怎么算都在服务端）；
 *  - 不得出现任何牌型/倍数/胜负推导，也不得出现底分字面量
 *    （`test/source-boundary.test.ts` 会机械扫描 `src/**`）。
 *
 * ⚠️ **R658**：`SettlementResult` **没有炸弹字段**（`playPhase.bombCount` 是过程值）
 * ⇒ 明细**只列载荷里真有的字段**（底分 / 倍数 / 春天），**不显示炸弹数**，也**不给乘积**
 *（`底分 与 倍数` 各自原样列出即可；`100 · 4` 这种「乘出来」的 400 是前端自算，红线）。
 *
 * `emit('again')` / `emit('back')` 只表达「用户点的是哪个按钮」：真正的动作在页面/大厅
 *（`table.vue` 写一次性意向 + 回大厅；`room.match` 仍只有大厅一处实现）。
 *
 * 稳定 class（R188，测试锚点，**不得**改名）：
 * `.table__settlement` / `.settlement__multiplier`
 * / `.settlement__base-score`
 * / `.settlement__landlord-delta` / `.settlement__farmer-delta`。
 *
 * ➑ 新增锚点：`.settlement__headline`（**我的输赢 + 我的分差**；`mySeat` 缺失时回退胜方文案）
 * · `.settlement__table` / `.settlement__row`（三家各一行）· `.settlement__formula`（载荷构成明细）
 * · `.settlement__actions`
 * / `.settlement__again`（主）/ `.settlement__lobby`（次）。
 *
 * 走查修复（调试信息退场）：早期的 `胜方：landlord` / `春天：…` 两个英文枚举 wd-tag、
 * 「地主座位：N / 农民座位：…」原始字段行已**删除** —— 胜方是给人看的结论（标题），
 * 谁是地主/农民在下面三行的角色徽章里，`spring==='none'` 时公式行不提春天。
 *
 * ② 金币场新增锚点：`.settlement__gold`（金币列格 —— 三态：值 /「结算中…」/「—」；
 * **免费场整列不存在**，§14）。
 */
import { computed } from 'vue';
import type { DdzSettlementResult } from '@fight-the-landlord/protocol';
import { useGameStore } from '../stores/game';
import { GOLD_FREEZE_MS, useGoldColumnFreeze } from '../composables/useGoldColumnFreeze';
import Panel from './Panel.vue';

const props = defineProps<{
  settlement: DdzSettlementResult;
  /** settlement 到达时刻（毫秒时间戳）；缺省 ⇒ 从本组件挂载起算满 5s。 */
  settlementReceivedAt?: number;
}>();

const emit = defineEmits<{ (e: 'again'): void; (e: 'back'): void }>();

const store = useGameStore();

/** 春天三态的展示文案。键集**必须**与契约的联合类型逐字对齐（少一个键就渲染出 undefined）。 */
const SPRING_LABEL: Record<DdzSettlementResult['spring'], string> = {
  none: '无',
  spring: '春天',
  'anti-spring': '反春天',
};

/**
 * 胜方文案：`winner` 是服务端给的枚举（`landlord` / `farmer`）⇒ 只做枚举→中文。
 *
 * 用途：`mySeat` 缺失（没有房间信息、无法个性化）时的**标题回退**；
 * `mySeat` 在场时标题讲「你赢/输了多少」（见 `mySeatResult`）。
 *
 * ⚠️ 这**不是**胜负推导：本组件不比较任何分数、不看座位、不算倍数 —— 键集同样必须与契约对齐。
 */
const WINNER_LABEL: Record<DdzSettlementResult['winner'], string> = {
  landlord: '地主胜',
  farmer: '农民胜',
};

/**
 * 金币列是否**存在**（② §14：免费场不加列）。
 *
 * 判据 = **服务端下发过座位余额**：`game.balances` 到了，或 join/state 的 `players[].balance`
 * 到过 —— 二者**只有金币场**会发生（免费场/好友房服务端永不下发余额，D7 不可区分性红线）。
 * ⇒ 「免费场不加列」靠的是「根本没有值」，**不靠**本组件判断场次（它也不知道场次）。
 */
const showGold = computed(
  () => store.settlementBalances !== null || Object.keys(store.seatBalances).length > 0,
);

/**
 * 5s 定格窗口（§14 的第二/三态）：计时器住在 composable 里（牌桌区「不新造时钟」的
 * 机械闸扫 `src/components/**`，本组件正在其中 —— 见 `useGoldColumnFreeze` 的头注释）。
 *
 * ⚠️ 结算延迟片：面板比 settlement 晚 2s 挂载，但**契约仍是从 settlement 到达起算的
 * 绝对 5s** ⇒ 用剩余时间起表，不把兜底拖成 7s。缺省（直接挂载/旧测试）保持满 5s。
 */
const goldFreezeDelayMs =
  props.settlementReceivedAt === undefined
    ? GOLD_FREEZE_MS
    : Math.min(
        GOLD_FREEZE_MS,
        Math.max(0, GOLD_FREEZE_MS - (Date.now() - props.settlementReceivedAt)),
      );

const goldFrozen = useGoldColumnFreeze({
  active: showGold,
  arrived: computed(() => store.settlementBalances !== null),
  delayMs: goldFreezeDelayMs,
});

/**
 * 一行的「金币」格（三态，§14）：
 *  - `game.balances` 到达 ⇒ 该座的值（原样展示，不换算）；
 *  - 未达且未超时 ⇒ 「结算中…」；
 *  - 未达且已过 5s ⇒ 「—」（定格；迟到的消息到达后仍会切成真值 —— 值优先于「—」）。
 */
function goldCell(seat: number): string {
  const balances = store.settlementBalances;
  if (balances !== null) {
    const value = balances[seat];
    return value === undefined ? '—' : String(value);
  }
  return goldFrozen.value ? '—' : '结算中…';
}

/**
 * 「这一行是不是我」—— **身份映射，不是结果推导**（片② R737）。
 *
 * `mySeat` 与行的座位号**都是服务端下发的**（前者来自 `room.matched`，后者来自结算载荷），
 * 本函数只把它们对上 —— 与 `table.vue` 的 `store.landlordSeat === store.mySeat`（`isLandlord`）
 * **同一类**。它回答的是「哪一行是我」，**不是**「我赢没赢」。
 *
 * ⚠️ **本组件仍然不推导胜负**：标题用服务端的 `winner` 枚举，一个字都不算。
 * ⚠️ `mySeat` 为 `null`（没有房间信息）时**恒 false** —— 宁可一行都不高亮，
 * 也不要高亮错行（那是在展示**错误**信息）。判据见 `table-settlement-ui` 的正反两面。
 */
function isMyRow(seat: number): boolean {
  const mine = store.mySeat;
  return mine !== null && mine === seat;
}

/**
 * 行名（与 `table.vue` 的 `nameOf()` **逐字同款**）：我自己 = 「我」，其余 = 「玩家N」。
 *
 * 走查修复：旧版行名是「座位 N」—— 那是载荷字段的调试腔；`PlayerView` / `SettlementResult`
 * 都没有昵称字段（R738），而座位号已经体现在角色归属与「我」行高亮里，这里说「玩家几」即可。
 */
function nameOf(seat: number): string {
  if (seat === store.mySeat) return '我';
  return store.seatNicknames[seat] || `玩家${seat}`;
}

/**
 * 标题区的「我这一局」：**两份服务端事实的对账**，不做任何规则判断（与 `useTableSound`
 * 判定「我赢没赢」的写法同款：`(winner === 'landlord') === iAmLandlord`）。
 *
 *  - `delta`：我的座位 = 地主座就取 `landlordScoreChange`，否则取 `farmerScoreChange` ——
 *    两个数都是载荷原文，这里只回答「**哪一个数是我的**」（身份映射，与 `isMyRow()` 同类）；
 *  - `won`：胜方枚举（服务端结论）与我的身份（我的座位号是否 = 地主座）对上 ⇒
 *    我在不在胜方那一侧。不比较分数正负、不看倍数。
 *
 * `mySeat === null`（没有房间信息）⇒ 返回 `null`，标题回退为不带人称的胜方文案 ——
 * 宁可不个性化，也不要把输赢安错人。
 */
const mySeatResult = computed<{ won: boolean; delta: number } | null>(() => {
  const mine = store.mySeat;
  if (mine === null) return null;
  const iAmLandlord = mine === props.settlement.landlordSeat;
  return {
    delta: iAmLandlord
      ? props.settlement.landlordScoreChange
      : props.settlement.farmerScoreChange,
    won: props.settlement.winner === 'landlord' ? iAmLandlord : !iAmLandlord,
  };
});
</script>

<template>
  <Panel class="table__settlement anim-settlement-in" variant="blue">
    <!--
      ⚠️ **本注释必须在根元素内部**（R681）：**模板注释**放在根元素**之前**会让 SFC 变成
      **多根**组件（编译产物 `_createElementBlock(_Fragment, …)`），于是 `@vue/test-utils` 的
      `wrapper.classes()` **静默**返回 `[]`、父组件再挂 `class` 还会走 fragment-attrs 警告路径。
      已由 `table-hud.test.ts` 的「单根闸」钉住（`Settlement` 就在那张 `it.each` 清单里）。

      ⚠️ **U3（2026-09-21）执行期自证**：把根元素从 `wd-card` 换成 `Panel` 时，
      我**正是**把一段解释写在 `<Panel>` **之前** ⇒ 这条闸当场红了（`expected [] to include
      'table__settlement'`）。说明这条判据**有判别力**，不是摆设 —— 注释因此挪回根内部。

      `Panel` 是单根 `view`，自定义 class 照常**落到根上**（与 `wd-card` 时的行为一致），
      所以 `.table__settlement` 这个稳定锚点仍然有效。
    -->
    <view class="settlement__head">
      <!--
        绶带标题带（片③ 阶段 B）：`$ftl-art-settlement-ribbon` 是**装饰槽**，
        文字仍由 DOM 渲染（素材不画字 —— art brief §0 的总则：
        「素材只做底 / 框 / 图标，一个字都不要画」，实测 `jujsidai.png` 是纯绶带、无字）。
        ⚠️ 槽位令牌挂**本组件**（不是 `Panel.vue` —— 那条「用了槽位就不得硬编码
        `/static/ui/`」的规则按**文件**生效，`Panel.vue` 里有 `panel-*.png`）。
      -->
      <view class="settlement__ribbon">
        <text class="settlement__title">结算</text>
      </view>
    </view>

    <!--
      标题（走查修复）：结算面板的首读信息是「**我**赢/输了、差多少分」⇒ 直接说人话；
      旧版那两个调试期 wd-tag（`胜方：landlord` 裸枚举、`春天：无`）已删 ——
      胜方结论由本句承载，春天只在真有春天时进下方公式行，`mySeat` 缺失则回退胜方文案。
      ⚠️ `delta` 是载荷原文**逐字**插值（`777` / `-388.5`），本组件不加正负号、不做算术。
    -->
    <text class="settlement__headline">
      <template v-if="mySeatResult !== null">
        {{ mySeatResult.won ? '你赢了' : '你输了' }} {{ mySeatResult.delta }}
      </template>
      <template v-else>{{ WINNER_LABEL[settlement.winner] }}</template>
    </text>

    <wd-divider />

    <!--
      四列表格（片② spec §4.2 / R737）。列 = 昵称（含角色徽章）/ 底分 / 倍数 / 分差。

      ⚠️ **三行的底分与倍数同值**：`SettlementResult` 只有一个 `baseScore` 与一个 `multiplier`
      （参考图三行不同是因为它每家有独立的「加倍」）⇒ **这是载荷的如实反映，不是缺陷**（R739）。
      **不得**「修」它 —— 把它变成每行不同 = 前端自算，那是 §12.2 的红线。
      ⚠️ **当前玩家整行高亮**（`.settlement__row--me`）是**身份映射**：
      `mySeat`（服务端下发的座位号）与行的座位号对上，与 `table.vue` 的 `isLandlord` 同一类。
      **不是**结果推导 —— 标题用的仍是服务端 `winner` 枚举，本组件一个数都不算（R737）。
      ⚠️ 「昵称」列显示 `nameOf()`：我 = 「我」，其余 = 「玩家N」（与牌桌 `table.vue` 同款）。
      `PlayerView` / `SettlementResult` **都没有昵称字段**（R738），不假装它是昵称，也不再用
      调试腔的「座位 N」。
    -->
    <view class="settlement__table">
      <view class="settlement__tr settlement__tr--head">
        <text class="settlement__th settlement__th--name">昵称</text>
        <text class="settlement__th settlement__th--base">底分</text>
        <text class="settlement__th settlement__th--multi">倍数</text>
        <text class="settlement__th settlement__th--delta">分差</text>
        <!-- ② 金币列（§14）：只有「服务端下发过余额」的局才有这一格（免费场不加列）。 -->
        <text v-if="showGold" class="settlement__th settlement__th--gold">金币</text>
      </view>

      <view
        class="settlement__row settlement__row--landlord"
        :class="{ 'settlement__row--me': isMyRow(settlement.landlordSeat) }"
      >
        <view class="settlement__row-name-wrap">
          <text class="settlement__row-name">{{ nameOf(settlement.landlordSeat) }}</text>
          <view class="settlement__badge-landlord" />
        </view>
        <text class="settlement__base-score">{{ settlement.baseScore }}</text>
        <text class="settlement__multiplier">{{ settlement.multiplier }}</text>
        <text
          class="settlement__landlord-delta"
          :class="settlement.landlordScoreChange >= 0 ? 'settlement__delta--pos' : 'settlement__delta--neg'"
          >{{ settlement.landlordScoreChange }}</text
        >
        <text v-if="showGold" class="settlement__gold">{{ goldCell(settlement.landlordSeat) }}</text>
      </view>

      <view
        v-for="seat in settlement.farmerSeats"
        :key="seat"
        class="settlement__row settlement__row--farmer"
        :class="{ 'settlement__row--me': isMyRow(seat) }"
      >
        <view class="settlement__row-name-wrap">
          <text class="settlement__row-name">{{ nameOf(seat) }}</text>
        </view>
        <text class="settlement__base-score">{{ settlement.baseScore }}</text>
        <text class="settlement__multiplier">{{ settlement.multiplier }}</text>
        <text
          class="settlement__farmer-delta"
          :class="settlement.farmerScoreChange >= 0 ? 'settlement__delta--pos' : 'settlement__delta--neg'"
          >{{ settlement.farmerScoreChange }}</text
        >
        <text v-if="showGold" class="settlement__gold">{{ goldCell(seat) }}</text>
      </view>
    </view>

    <!--
      构成明细（R658）：**只列载荷字段**，不给乘积 —— 「底分 与 倍数 各是多少」是服务端的事实，
      「底分乘倍数是多少」是服务端的算法，本组件不参与。
      走查修复：`spring === 'none'`（这局没有春天）时**整段不提春天** —— 「春天 无」是自说自话。
    -->
    <text class="settlement__formula">
      底分 {{ settlement.baseScore }} · 倍数 {{ settlement.multiplier }}<template
        v-if="settlement.spring !== 'none'"
      > · 春天 {{ SPRING_LABEL[settlement.spring] }}</template>
    </text>

    <view class="settlement__actions">
      <button
        type="button"
        class="btn btn--primary settlement__again"
        @click="emit('again')"
      >
        再来一局
      </button>
      <button type="button" class="btn settlement__lobby" @click="emit('back')">返回大厅</button>
    </view>
  </Panel>
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
@import '../styles/animations.scss';

/**
 * 视觉层。class 名一个都没改（R188 的稳定锚点 + `test/table-settlement-ui.test.ts`）。
 *
 * ⚠️ 样式**全部自持**（➏ 评审 F1 的教训）：`scoped` 只作用于「本组件自己的模板 + 子组件的
 * 根节点」，父组件（`table.vue`）的 `.btn` / `.settlement__*` 规则**进不到**这里。
 * ⇒ 本组件模板里出现的 class，**没有一个**靠外部文件上样式，但下面并非「一条 class 一条规则」：
 *   · 两个按钮的 `.btn` / `.btn--primary`（含 `:disabled`）由本块**逐条**定义；
 *   · `.settlement__again` / `.settlement__lobby` 由 `.settlement__actions .btn` **联合选择器**覆盖
 *     （它们不需要、也没有各自的独立规则）；
 *   · `.settlement__landlord-delta` / `.settlement__farmer-delta`
 *     二者共用 `.settlement__grid` 的排版（文本框不需要各自的规则）；
 *   · 其余 class 都在下面有逐条规则。
 *
 * 颜色/间距/字号/圆角全取 `src/uni.scss` 的 `$ftl-*` 令牌（零硬编码 hex、零新增令牌）；
 * 描边走 `$ftl-hairline`（在 `ftl-btn` mixin 里），`line-height` 都是无单位数值。
 */
/**
 * 结算面板 = **居中浮层**（片② 走查实测订正，两次）。
 *
 * ⚠️ 初稿把它当成 `.table__me` 之后的**行内块** —— 真浏览器里那会把四列表格挤出画布、
 * 第一行就贴到底边被裁掉。
 * ⚠️ **第二稿用 `left: 50% + transform: translate(-50%,-50%)` 也不行**：本组件的
 * `anim-settlement-in` 带 `animation-fill-mode: both`，动画会**一直持有最终的 `transform`**
 * ⇒ 我的 translate 被覆盖，面板跑到右下角去了。
 * ⇒ 用**不依赖 transform** 的居中法：`inset: 0` + `margin: auto` + 确定宽高。
 *
 * 参考图二的形态是「牌桌被压暗 + 面板居中浮在上面」⇒ 遮罩由宿主 `table.vue`
 * 的 `.table__scrim` 提供（两者由同一个 `store.settlement` 驱动）。
 */
.table__settlement {
  display: block;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2;
  width: $ftl-settlement-w;
  max-width: calc(100% - #{$ftl-space-6});
  height: fit-content;
  max-height: calc(100% - #{$ftl-space-6});
  margin: auto;
  overflow-y: auto;
}
.settlement__head {
  display: flex;
  align-items: center;
  justify-content: center;
}
.settlement__title {
  font-size: $ftl-font-lg;
  font-weight: 600;
  /* 9-slice 拱形素材的红色视觉中心高于 border-box 几何中心 ⇒ 上移 8px 补偿 */
  position: relative;
  top: -8px;
}
/**
 * 绶带标题带（片③ 阶段 B）：素材**只做底**，文字（「结算」）仍由 DOM 画在它上面。
 *
 * 🔴 **9-slice（`border-image`）—— 2026-09-29 用户裁决**：素材 666×115、容器宽随文字变，
 * 整图拉伸（原形态 `background-size: 100% 100%`）会把两端**卷曲翼横向压扁** ⇒ 改成九宫格。
 * 形态照 `Panel.vue` 的 `$ftl-panel-slice` 先例（`border-image` + `fill` + `stretch`）。
 *
 * ⚠️ **源图像素与渲染尺寸是两个量**（`Panel.vue` 注释逐字记着这个坑）：
 *   · 简写里 `36 225 27 221` = **源图像素**的切片（量自 `jujsidai.png` 的结构边界 ——
 *     上 36 = 拱顶落到满宽处 · 右 225 / 左 221 = 拱顶平段 x 221..440 的起止 · 下 27 = 中央带底沿）；
 *   · `border-width` 里的令牌与 `16px` / `12px` = **渲染尺寸**（≈ 源图像素 × 0.444 = 51/115）。
 *   改一个不改另一个会切坏拱顶与卷曲翼（判据：`table-settlement-ui.test.ts` 的 9-slice 用例）。
 *
 * 🔴 **横向与纵向的缩放比本来就不是一个数**（B6 评审 Minor 2 补记，2026-09-29）：
 *   `border-image … stretch` 把**四角**按「`border-width` ÷ 切片」缩放（纵向 16/36 = 12/27 ≈ **0.444**，
 *   横向左右都取 98），而**中段**（拱顶平段 + 带身）两向都被拉到**剩下的那个盒子**：
 *     · 横向 ← 容器宽随**文字宽度**变（「结算」两字 ⇒ 98+98+「结算」+两侧 padding = 324）；
 *     · 纵向 ← **中段高度由内容决定**（`padding 4 + 标题行高 43 + padding 4` = **51**），
 *       ⇒ 中段纵向缩放 = 51 ÷ **源图中段 52**（= 115 − 36 − 27） = **≈ 0.98**，与四角的 0.444 **不同**。
 *   ⇒ 头带与两翼上段相对源图被**纵向放大 ~2.2 倍**（0.98 ÷ 0.444）——**这是设计如此、不是 bug**：
 *     源图按 115 高整图设计，而这里的容器高**跟着字走**。
 *   ⚠️ **改 `border-width` / 令牌 / 字号 / 上下 padding 会同时改掉上面三个数** ⇒ 拱顶平段与带身的
 *     高度比例会跟着变（改前先看这条，并重跑 `table-settlement-ui` 的 9-slice 用例 + 截图）。
 *     反方向也一样：**换素材**时新图的「拱顶平段」必须在纵向 0.98 的拉伸下仍不变形。
 *   ⚠️ 横向**必须**用 `border-width` **长写**（`border` 简写只吃**一个**宽度 ——
 *     写 `border: 16px 98px …` 整条声明会被**静默丢弃**，`border-image` 就整个不画；实测踩过）。
 *   ⚠️ `border-style: solid` 不能省：style 为 none 时 border 区宽为 0 ⇒ `border-image` 不画。
 *
 * ⚠️ **`background-clip: padding-box` 不能省**：素材的拱顶两侧/翼边是**透明**的，
 * 默认 `border-box` 会让兜底橙底从那些透明处透出来（素材周围一圈橙块）—— 实测截图证明过。
 *
 * ⚠️ **兜底**（R693：素材缺失不许白屏）：`background-color: $ftl-color-accent` 仍在 ——
 * 图裂时退化成一块橙底白字的素色带（不是空洞）。
 * ⚠️ **白字是刻意的**（B5 时补的）：绶带红底 + 兜底橙底都是深色档 ⇒ 白字两态都可读（§5.2.1）。
 */
.settlement__ribbon {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $ftl-space-2 $ftl-space-9;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-accent;
  background-clip: padding-box;
  /* 9-slice：源图走槽位令牌（连 url() 一起存，见 uni.scss 本段开头）；四个参数缺一不可。 */
  border-style: solid;
  border-color: transparent;
  /* 渲染尺寸：横向走令牌；纵向 16px/12px = 源图 36/27 × 0.444。 */
  border-width: 16px $ftl-ribbon-slice-x 12px $ftl-ribbon-slice-x;
  border-image: $ftl-art-settlement-ribbon 36 225 27 221 fill stretch;
  color: $ftl-color-on-primary;
}
/**
 * 标题：整块结算里**唯一**的强强调（强调色 = 本项目的「重点」符号）。
 * 走查修复后它讲的是「你赢/输了 + 我的分差」⇒ 字号从 xl 提到 **xxl**、居中，
 * 成为面板的视觉主体；数字是载荷原文插值，不做任何加工。
 */
.settlement__headline {
  display: block;
  margin: $ftl-space-5 0;
  color: $ftl-color-accent;
  font-size: $ftl-font-xxl;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}
/** 四列表格（片② R737）：面板横贯（参考图二 x 154..1170 画布宽）。 */
.settlement__table {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: $ftl-settlement-w;
  margin: $ftl-space-5 auto;
}
.settlement__tr--head {
  display: flex;
  align-items: center;
  padding: $ftl-space-3 $ftl-space-5;
  border-radius: $ftl-radius-sm $ftl-radius-sm 0 0;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: $ftl-hairline solid rgba(255, 255, 255, 0.15);
}
/** 表头：**标签住在这里**（参考图二的形态 —— 格子里只写裸值）。 */
.settlement__th {
  flex: 1 1 0;
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: $ftl-font-sm;
  font-weight: 600;
}
/* 每列 th 与 cell 共享 text-align，保证表头与内容逐列对齐 */
.settlement__th--name,
.settlement__row-name-wrap {
  text-align: left;
}
.settlement__th--base,
.settlement__base-score {
  text-align: center;
}
.settlement__th--multi,
.settlement__multiplier {
  text-align: center;
}
.settlement__th--delta,
.settlement__landlord-delta,
.settlement__farmer-delta {
  text-align: center;
}
.settlement__th--gold,
.settlement__gold {
  text-align: right;
}
/**
 * 走查修复：地主/农民两行**统一中性衬底**（旧版地主绿底、农民红底 —— 红绿天然读作
 * 「赢/输」，但底色只标角色、与胜负无关：两个农民共用红底而他们可能正是赢家，纯误导）。
 * 角色归属由行末 `.settlement__row-role` 徽章承担；胜负只看标题与分差正负。
 */
.settlement__row {
  box-sizing: border-box;
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-5;
  background: rgba(255, 255, 255, 0.06);
  border-bottom: $ftl-hairline solid rgba(255, 255, 255, 0.08);
}
.settlement__row:last-child {
  border-bottom: none;
  border-radius: 0 0 $ftl-radius-sm $ftl-radius-sm;
}
.settlement__row:first-of-type {
  border-radius: 0;
}
.settlement__row--landlord {
}
.settlement__row--farmer {
}
/**
 * **当前玩家整行高亮**（片② R737）：身份映射（`mySeat` vs 行的座位号），不是结果推导。
 * 深色面板上用半透金底 + 金边。
 */
.settlement__row--me {
  background: rgba($ftl-color-gold, 0.12);
  box-shadow: inset 0 0 0 $ftl-hairline $ftl-color-gold-deep;
}
/* 四列等宽（昵称 / 底分 / 倍数 / 分差）+ ② 金币列（`settlement__gold`，仅金币场渲染） */
.settlement__row-name-wrap,
.settlement__base-score,
.settlement__multiplier,
.settlement__landlord-delta,
.settlement__farmer-delta,
.settlement__gold {
  flex: 1 1 0;
  font-size: $ftl-font-md;
}
.settlement__row-name-wrap {
  position: relative;
  display: block;
  color: $ftl-color-on-primary;
}
/** 金币列与数字格同权重（深色面板上跟底分/倍数用浅色）。 */
.settlement__base-score,
.settlement__multiplier,
.settlement__gold {
  color: $ftl-color-on-primary;
  font-weight: 600;
}
/** 分差正负分色：正金负红 */
.settlement__landlord-delta,
.settlement__farmer-delta {
  font-weight: 600;
}
.settlement__delta--pos {
  color: $ftl-color-gold;
}
.settlement__delta--neg {
  color: $ftl-color-danger;
}
/** 地主徽章：复用牌桌 landlord-badge.png 竖牌素材，浮动在昵称单元格右上角 */
.settlement__badge-landlord {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 30px;
  background-image: $ftl-art-landlord-badge;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.settlement__formula {
  display: block;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-5;
  border-radius: $ftl-radius-sm;
  background: $ftl-color-info-bg;
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.settlement__actions {
  display: flex;
  gap: $ftl-space-4;
  margin-top: $ftl-space-5;
}
.settlement__actions .btn {
  flex: 1 1 0;
}
/**
 * 两个动作按钮是本组件模板里的**原生** `<button class="btn …">` ⇒ 它们必须在这里自持
 * `.btn` 的观感（复用全局 mixin）与主色；`table-bid-bottom.test.ts` 有机械闸钉这一点。
 * 主操作**只有** `.settlement__again` 一个（`.settlement__lobby` 是次操作）。
 */
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
