<script setup lang="ts">
/**
 * 玩家信息条（**共用件**）：头像 + 昵称 + 余额。
 *
 * ⚠️ **为什么抽出来**：大厅顶栏与开始游戏页左下是**同一件事**，而「同一个渲染写两遍会
 * 各自过期」——这是 `SessionNotice.vue`（R751）抽出来的同一条理由。
 *
 * ⚠️ **它必须是哑的**：只渲染 `name` / `balance` 两个 prop，**不自己取数**、不判断登录态、
 * 更不判断「这是不是金币场」——那样会把场次判断变成第二处实现。
 * 这样宿主要不要请求余额、失败了怎么提示、什么时候该显真值，都留在页面那一层（单一职责）。
 *
 * ⚠️ **`class` 由宿主传**（`.lobby__player` / `.game__player`）：本组件不持有布局
 * ——与 `SessionNotice.vue` 同一条约定。默认观感（头像圆环、字色）在下面自持。
 *
 * ⚠️ **余额的显隐语义（② 金币场 §14 / D7）**：
 *  - `balance` 是**数字** ⇒ 显示这个数（金币场真值）；
 *  - 缺省 / `null` ⇒ 「**—**」（未知 = 不编数字；免费场/好友房形态不变）。
 *  「免费场恒 —」**不是**本组件判断的：宿主的金币场实例才是给值的那一个
 *  （牌桌上由服务端决定下不下发，见 `Seat.vue` 同款）。
 *
 * ⚠️ 头像是**静态兜底图** `default.png`（D13 的 `resources/UI/` 授权范围内，片① 已入库）：
 * 服务端今天**不下发**头像 URL，所以没有「按用户取头像」这回事（不造数据源）。
 * 走 `<image src="/static/ui/…">` 而不是 `$ftl-art-*` 槽 —— 与登录页样板的
 * `logo.png` 同形；槽的接通留给片③（见计划的「明确不做」）。
 *
 * ⚠️ **`part`（支付片 T14）**：大厅顶栏把「身份」（头像+昵称 ⇒ 打开玩家菜单）与
 * 「钱包」（金币视图 ⇒ 进钱包页，规格 §4 的 `wallet-entry`）拆成**两个并列按钮** ——
 * uni-app H5 里把一个可点区域嵌进另一个 `<button>` 内不可靠（`$nne` 归一化的教训），
 * 所以两件事必须是**兄弟**节点。拆的是**宿主结构**，不是渲染 —— 两个部件仍从本组件
 * 唯一一处渲染，不给第二个组件/页面留副本（抽件理由见上）。
 */
withDefaults(
  defineProps<{ name?: string; balance?: number | null; part?: 'all' | 'identity' | 'coin' }>(),
  { name: '', balance: null, part: 'all' },
);
</script>

<template>
  <view class="chip">
    <!--
      ⚠️ **本注释必须在根元素内部**（放在根元素之前会让本组件变多根：
      宿主的 class / `@vue/test-utils` 的 `classes()` 都会静默失效）。
      `part`（支付片 T14）只决定**渲染哪几个部件**：identity = 头像+昵称、coin = 金币视图、
      all（缺省）= 两者（牌桌与既有调用点一字不改）。
    -->
    <image v-if="part !== 'coin'" class="chip__avatar" src="/static/ui/default.png" mode="aspectFit" />
    <text v-if="part !== 'coin'" class="chip__name">{{ name }}</text>
    <view v-if="part !== 'identity'" class="chip__coin">
      <image class="chip__coin-icon" src="/static/ui/dou.png" mode="aspectFit" />
      <!-- ② 金币场：数字就是服务端下发的真值；缺省/`null` ⇒ 「—」（不编数字）。 -->
      <text class="chip__currency">{{ balance ?? '—' }}</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义**）——
 * 令牌是全局的，改一个值会同时改掉四个页面。
 */
.chip {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
  min-width: 0;
}
/**
 * 头像：圆形。参考图里头像外面有一圈白环（`$ftl-art-avatar-ring` 那个槽还没素材）
 * ⇒ 这里用 `$ftl-hairline` 实线描边当兜底，**不是**第二套头像设计（R693：不白屏）。
 *
 * ⚠️ **尺寸用 `$ftl-control-h-sm`（56px）而不是 `$ftl-size-avatar`（98px）**：后者是
 * **牌桌座位**的头像位（参考图实测 φ98）；顶栏只有 `$ftl-bar-h`（64px）高，
 * 塞 98px 会把整条顶栏撑变形。56px 与顶栏的按钮同高，视觉上是一条线。
 * ⚠️ 这个数是**观感类取值** ⇒ 最终由真浏览器截图并排定（本仓对观感的既有纪律：
 * 不写机械判据），要改就改这一个数。
 */
.chip__avatar {
  flex: 0 0 auto;
  width: $ftl-control-h-sm;
  height: $ftl-control-h-sm;
  border: $ftl-hairline solid $ftl-color-on-primary;
  border-radius: $ftl-radius-pill;
  background: $ftl-color-surface;
}
.chip__name {
  overflow: hidden;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip__coin {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-2;
}
.chip__coin-icon {
  width: $ftl-font-lg;
  height: $ftl-font-lg;
}
/** 货币占位（D12）：弱化到「看得出是个空槽」。 */
.chip__currency {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
</style>
