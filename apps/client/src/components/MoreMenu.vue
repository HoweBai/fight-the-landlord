﻿<script setup lang="ts">
/**
 * 二级弹层（D16 / 片③ spec §3.1 的「右」段）：入口**收在这里**。
 *
 * ## 按钮状态（A 档第①片起；挂机治理片 C27/C29 · 2026-10-18 顶栏化）
 *
 *  - **记牌器**：记牌器片起入口已移到顶栏左侧（`.table__counter`），不再属于本弹层；
 *  - **托管**：挂机治理片起已翻活，**2026-10-18 用户裁决移到顶栏右侧**（`.table__trustee`，
 *    在「更多」左边）—— 不再属于本弹层（一键可达，不藏在二级弹层里）；
 *  - **背包**：仍是 `disabled` 占位（功能需要协议或另立片）。
 *    本仓明文忌讳「造一排点了没反应的活按钮」（`table.vue` 的既有注释逐字）；
 *  - **设置**：已翻活 —— 点开本组件内部的设置区（音乐 / 音效 / 震动开关 + 音量）。
 *
 * ⚠️ **本组件是哑的**：不读 store、不发请求、不知道牌局状态 —— 开合由**宿主**控制，
 * 设置值也由**宿主**（牌桌）从音频/触感层取好后以 props 喂入，变更一律 emit 上去。
 * 宿主（`table.vue`）用 `v-if` 挂载它 ⇒ **关着的时候整棵子树不在 DOM 里** ——
 * 那正是「收进弹层」这条裁决的**可证伪语义**（判据 `test/more-menu.test.ts` ①）。
 * 🔴 **不要在组件内部再加一层 `v-show` 做整层开合**：那是「CSS 藏着、DOM 里还在」，
 * 会把上面那条性质**悄悄改成一句空话**（同一个文件的那个用例就是它的反面）。
 * （设置**区**在已挂载面板内部的展开/收起用 `v-if` 局部状态，不触碰上面这条红线。）
 *
 * 🔴 **本组件没有 `open` prop**（B4 遗留 Minor 1，控制者裁决 2026-09-29）：它此前声明了
 * `open: boolean` 但**全文件无一处消费**（纯装饰）。**不许**改成「组件内部消费」
 * （`v-if="open"` 之类）：那会让宿主换成 `v-show` 时**被内层闸挡住** ⇒ **恰好废掉**
 * 上面那条红线判据（「关着 ⇒ 不在 DOM」）的判别力。**宿主 `v-if` 必须是唯一的闸。**
 *
 * ⚠️ `close_btn.png` 走 `<image src="/static/ui/close_btn.png">`（与登录页的 `logo.png` 同形：
 * 图标类素材**不走** `$ftl-art-*` 槽位，那是装饰件的「CSS 兜底 + 可选贴图」槽 ——
 * 判据 `test/art-slots.test.ts` 的「用了槽位的组件不得再硬编码 `url('/static/ui/')`」）。
 *
 * ⚠️ **按钮样式必须在本组件里自持**：`scoped` 样式只作用于「本组件模板 + 子组件根节点」，
 * 宿主的 `.btn[data-v-<table>]` 进不来 ⇒ 不写这里，三端产物里这一排会丢
 * min-height/padding/border/圆角/`:disabled` 透明度（机械闸：`table-bid-bottom.test.ts`
 * 的「渲染 `class="btn"` 的组件必须自己 `@include ftl-btn`」）。
 */
import { computed, ref } from "vue";

/**
 * 设置区的当前值由宿主喂入（组件不直接读音频/触感模块 —— 保持「哑组件」，
 * 单测可以纯 props 驱动，宿主也可以在一处持久化）。
 */
const props = withDefaults(
  defineProps<{
    musicOn?: boolean;
    sfxOn?: boolean;
    hapticsOn?: boolean;
    volume?: number;
  }>(),
  { musicOn: true, sfxOn: true, hapticsOn: true, volume: 1 },
);

/**
 * 组件只 `emit('close')`，宿主决定随后挂不挂载；设置变更同样全部上抛，
 * **不在组件内落存储**（持久化是宿主接线音频/触感层的事）。
 */
const emit = defineEmits<{
  (e: "close"): void;
  (e: "music", on: boolean): void;
  (e: "sfx", on: boolean): void;
  (e: "haptics", on: boolean): void;
  (e: "volume", value: number): void;
}>();

/** 设置区在**已挂载面板内部**的展开态（纯局部 UI 状态，与弹层整层开合的红线无关）。 */
const settingsOpen = ref(false);

/** 音量档位：0.25 一档（宿主持久化的仍是 0–1 连续值，这里只决定步进按钮的可用性）。 */
const VOLUME_STEP = 0.25;
const volumePct = computed(() => `${Math.round(props.volume * 100)}%`);
const minusDisabled = computed(() => props.volume <= VOLUME_STEP + 1e-9);
const plusDisabled = computed(() => props.volume >= 1 - 1e-9);

function stepVolume(delta: number): void {
  if (delta < 0 && minusDisabled.value) return;
  if (delta > 0 && plusDisabled.value) return;
  const next = Math.max(
    VOLUME_STEP,
    Math.min(1, Math.round((props.volume + delta) * 100) / 100),
  );
  if (next !== props.volume) emit("volume", next);
}
</script>

<template>
  <view class="table__more-mask" @click="emit('close')">
    <!--
      🔴 **遮罩关闭不得用 `.self`**（真浏览器实测定性 + 根因定位，2026-09-29 修复轮②）：
      uni-app H5 跑的是补丁运行时 `@dcloudio/uni-h5-vue`，事件经 `$nne` 归一化 ——
      `createNativeEvent` 把 `target` 与 `currentTarget` **各自**过一遍 `normalizeTarget()`，
      而后者**每次调用新建一个 facade 对象** ⇒ 即使两次指向同一元素**引用也不相等** ⇒
      Vue 的 `.self` 守卫（`e.target !== e.currentTarget`）**恒真** ⇒ **handler 恒被吞**。
      （真栈直证：原生层 `rawSame: true`；handler 实收的归一化事件 `normalizedSame: false`。）
      ⇒ 本处改用「**裸 `click`** + 面板根 `@click.stop`」：`.stop` 的 `e.stopPropagation()`
      经 `wrapperEvent` 透传到原生事件、在该管线里可用；jsdom（stock vue）两种写法都过，
      **单测遮蔽不到这条差异** —— 真浏览器取证见修复轮报告。
      ⚠️ 全仓**只此一处**曾用 `click.self`（2026-09-29 修复轮 grep 复核）。
      ⚠️ **本注释与下面两段都必须在根元素之内**（模板注释放在根元素之前会让 SFC 变成多根 —
      单根闸 `table-hud.test.ts` 盯着；`Settlement.vue` 真的栽过一次）。
    -->
    <!--
      ⚠️ **本注释必须在根元素内部**：**模板注释**放在根元素**之前**会让 SFC 变成**多根**，
      `@vue/test-utils` 的 `classes()` 于是**静默**返回 `[]`（`table-hud.test.ts` 的单根闸盯着；
      `Settlement.vue` 真的栽过一次）。⇒ 本文件的两段注释都在根元素**之内**。
    -->
    <view class="table__more-panel" @click.stop>
      <view class="table__more-head">
        <text class="table__more-title">更多</text>
        <image
          class="table__more-close"
          src="/static/ui/close_btn.png"
          mode="aspectFit"
          @click="emit('close')"
        />
      </view>

      <!-- 入口：设置已翻活；只剩「背包」是 disabled 占位（功能另立片）。记牌器在顶栏左侧、托管在顶栏右侧（更多左边）。 -->
      <view class="table__more-grid">
        <button type="button" class="btn btn--small table__art-btn" disabled>
          背包
        </button>
        <button
          type="button"
          class="btn btn--small table__art-btn table__art-btn--live"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        >
          设置
        </button>
      </view>

      <!-- 设置区：开关与音量都是**受控**的（值来自 props，变更 emit 给宿主落盘） -->
      <view v-if="settingsOpen" class="table__more-settings">
        <view class="table__set-row">
          <text class="table__set-label">音乐</text>
          <button
            type="button"
            class="table__switch"
            :class="{ 'table__switch--on': musicOn }"
            role="switch"
            :aria-checked="musicOn"
            :aria-label="musicOn ? '音乐：开' : '音乐：关'"
            @click="emit('music', !musicOn)"
          >
            <text class="table__switch-text">{{ musicOn ? "开" : "关" }}</text>
          </button>
        </view>
        <view class="table__set-row">
          <text class="table__set-label">音效</text>
          <button
            type="button"
            class="table__switch"
            :class="{ 'table__switch--on': sfxOn }"
            role="switch"
            :aria-checked="sfxOn"
            :aria-label="sfxOn ? '音效：开' : '音效：关'"
            @click="emit('sfx', !sfxOn)"
          >
            <text class="table__switch-text">{{ sfxOn ? "开" : "关" }}</text>
          </button>
        </view>
        <view class="table__set-row">
          <text class="table__set-label">震动</text>
          <button
            type="button"
            class="table__switch"
            :class="{ 'table__switch--on': hapticsOn }"
            role="switch"
            :aria-checked="hapticsOn"
            :aria-label="hapticsOn ? '震动：开' : '震动：关'"
            @click="emit('haptics', !hapticsOn)"
          >
            <text class="table__switch-text">{{
              hapticsOn ? "开" : "关"
            }}</text>
          </button>
        </view>
        <view class="table__set-row">
          <text class="table__set-label">音量</text>
          <view class="table__vol">
            <button
              type="button"
              class="btn btn--small table__vol-btn"
              :disabled="minusDisabled"
              aria-label="减小音量"
              @click="stepVolume(-0.25)"
            >
              －
            </button>
            <text class="table__vol-value" aria-live="polite">{{
              volumePct
            }}</text>
            <button
              type="button"
              class="btn btn--small table__vol-btn"
              :disabled="plusDisabled"
              aria-label="增大音量"
              @click="stepVolume(0.25)"
            >
              ＋
            </button>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 全屏遮罩 + 居中面板（视觉语言照上位 §5.2.1 的面板语言，形态与 `game.vue` 的好友房弹层同族）。
 *
 * ⚠️ `position: absolute` 的定位基准是**宿主**的 `.table`（它仍是 `position: relative` ——
 * 当初为动作条浮层加的，**片③ 浮层已搬进中央**；本弹层与结算遮罩（`.table__scrim`）
 * 是那条声明留下的消费者，别顺手删）；`z-index: 10` 高过结算遮罩（`.table__scrim` 的 1），
 * 弹层永远浮在最上层。
 * ⚠️ 遮罩是**深蓝阶**的 62%（`$ftl-color-night-deep`），面板才是 `rgba($ftl-color-night, .62)`
 * —— 两者用**不同**的档，这是 §5.2.1 的既有层次（与 `game.vue` 逐字一致）。
 */
.table__more-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($ftl-color-night-deep, 0.62);
}
/** 面板：半透明底 + hairline 描边 + 大圆角（§5.2.1 的面板语言）。 */
.table__more-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  /* 面板宽与 `game.vue` 的好友房面板同档（640）—— 同一个视觉语汇下同类面板同宽 */
  width: 640px;
  max-width: 100%;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.table__more-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.table__more-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 关闭（图标）：容器取**小号控件高**（与 `.btn--small` 同档，拇指可点）。 */
.table__more-close {
  flex: 0 0 auto;
  width: $ftl-control-h-sm;
  height: $ftl-control-h-sm;
}
/** 入口 2×2 网格（等宽；grid 子项默认拉伸，不需要再写 width）。 */
.table__more-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $ftl-space-5;
}
/**
 * 占位按钮（R728）：弹层内仅剩「背包」是 `disabled`，用降透明度让它一眼可辨「还没接」。
 * ⚠️ 这一段随入口按钮**从 `table.vue` 搬来**（`scoped` 不跨组件：留在原处等于没有样式）。
 */
.table__art-btn {
  opacity: 0.5;
}
/** 已翻活的入口（设置）：恢复不透明，与占位按钮形成可辨差异。 */
.table__art-btn--live {
  opacity: 1;
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
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 2px 0 rgba(255, 255, 255, 0.06);
}
.btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}

/** 设置区：与网格之间留出层级间距，内部每行一组「标签 + 控件」。 */
.table__more-settings {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  padding: $ftl-space-4 $ftl-space-5;
  border-top: $ftl-hairline solid rgba($ftl-color-on-primary, 0.18);
}
.table__set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-height: $ftl-control-h-sm;
}
.table__set-label {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
}
/** 开关：胶囊形，关=深色描边、开=主色填充（无新增动效，避免与 reduced-motion 纪律冲突）。 */
.table__switch {
  flex: 0 0 auto;
  min-width: 92px;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-5;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.45);
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-deep, 0.5);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
}
.table__switch--on {
  border-color: $ftl-color-primary;
  background: $ftl-color-primary;
  color: $ftl-color-on-primary;
}
.table__vol {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
}
.table__vol-btn {
  min-width: $ftl-control-h-sm;
  padding: 0 $ftl-space-4;
}
.table__vol-value {
  min-width: 72px;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  text-align: center;
}
</style>
