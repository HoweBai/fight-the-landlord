<script setup lang="ts">
/**
 * 连接状态浮层（客户端优化项 2）。**只挂在牌桌**（`table.vue`）：
 *
 *  - `reconnecting`：顶部一条不阻断操作的提示条（socket.io 自动重连进行中），
 *    带上 Manager 报告的尝试次数；
 *  - `dead`：全屏遮罩 + 居中卡片，阻断一切牌桌操作（链路已死，点什么都送不出去）。
 *
 * 终态有三种死因（`ConnectionState.deadReason`），标题/正文/动作策略统一由
 * `net/connection-copy.ts#connectionDeadCopy` 决定（**单一真源**，本组件只呈现）：
 *  - `give_up`：自动重连 `RECONNECT_GIVE_UP_ATTEMPTS` 次（现 22，退避窗口 ≈ 6 分钟）
 *    仍失败 → 给「重新连接」；
 *  - `server_rejected`：服务端终止性踢线。
 *    · `11003` 封禁：**不给重试**（再连也必被拒），给「重新登录」+「返回大厅」；文案与
 *      登录路径同源（`copy.ts` 的 K1 全串），不在这里另造；
 *    · `10006` 并发上限：用户可能已在别处关掉窗口 → **给重试**；
 *    · `10008` 端闸（客户端接入片）：软开关，管理端可能已重新打开 → **给重试**；
 *      文案 = `copy.ts` 的 §0 全串（与 NoticeStack 内置 connection-dead 项同口径）；
 *    · `10007` 上游不可用：临时故障 → **给重试**（文案本身就说「稍后重试」）；
 *    · 无码（空闲踢线等）：**给重试**；所有 `server_rejected` 都额外给「重新登录」出口。
 *  - `session_expired`：access token 过期且 refresh token 也失效（10004 判死），
 *    只给「重新登录」出口（`relogin` 事件），不给重试。
 *
 * ⚠️ 本组件是哑组件：状态靠 props，动作品味只发 `retry` / `back` / `relogin` 三个事件，
 * 不自己碰 session、不导航、不调网络。
 *
 * 稳定锚点（测试用，勿改名）：`.connection-overlay`（根）、
 * `.connection-overlay__toast` / `__attempt` / `__scrim` / `__panel` /
 * `__title` / `__message` / `__retry` / `__back` / `__relogin`。
 */
import { computed } from "vue";
import type { ConnectionState } from "../net/socket";
import { connectionDeadCopy } from "../net/connection-copy";
import type { ConnectionCopy } from "../net/connection-copy";

const props = defineProps<{ state: ConnectionState }>();

const emit = defineEmits<{ (e: "retry"): void; (e: "back"): void; (e: "relogin"): void }>();

const isDead = computed(() => props.state.phase === "dead");

/**
 * 终态的标题/正文/动作策略**全部来自 `net/connection-copy.ts`（单一真源）**。
 * 本组件不再持有任何逐码策略：NoticeStack.vue 的内置死态项（大厅 + 玩法页顶部提示）与
 * `socket.ts` 的踢线文案共用同一份 copy —— 改口径只改那一处，这里零同步义务。
 */
const copy = computed<ConnectionCopy | null>(() =>
  props.state.phase === "dead" ? connectionDeadCopy(props.state) : null,
);

/** session_expired 终态：只给「重新登录」出口，不给重试、不给返回大厅。 */
const isSessionExpired = computed(() => props.state.deadReason === "session_expired");
const canRetry = computed(() => copy.value?.canRetry ?? false);
/** 其余死因（服务端主动踢线）：额外给「重新登录」出口。 */
const canRelogin = computed(() => copy.value?.canRelogin ?? false);

/** 终态标题。 */
const title = computed(() => copy.value?.title ?? "连接已断开");

/** 终态正文。 */
const message = computed(() => copy.value?.message ?? "");
</script>

<template>
  <view class="connection-overlay">
    <!--
      重连中：顶部细条，**不阻断**牌桌（自动重连大概率几秒内恢复，
      没必要锁死操作；动作在断链期间本就有串行队列/缓冲兜底）。
    -->
    <view v-if="!isDead" class="connection-overlay__toast">
      <text class="connection-overlay__toast-text">
        网络波动，正在重新连接<template v-if="state.attempt > 0">
          （第 {{ state.attempt }} 次）</template
        >…
      </text>
    </view>

    <!-- 终态：遮罩 + 卡片，阻断牌桌，等用户做决定。 -->
    <view v-else class="connection-overlay__scrim">
      <view class="connection-overlay__panel">
        <text class="connection-overlay__title">{{ title }}</text>
        <text class="connection-overlay__message">{{ message }}</text>
        <view class="connection-overlay__actions">
          <template v-if="isSessionExpired">
            <button
              type="button"
              class="btn btn--primary connection-overlay__relogin"
              @click="emit('relogin')"
            >
              重新登录
            </button>
          </template>
          <template v-else>
            <button
              v-if="canRetry"
              type="button"
              class="btn btn--primary connection-overlay__retry"
              @click="emit('retry')"
            >
              重新连接
            </button>
            <button
              v-if="canRelogin"
              type="button"
              class="btn connection-overlay__relogin"
              @click="emit('relogin')"
            >
              重新登录
            </button>
            <button
              type="button"
              class="btn connection-overlay__back"
              @click="emit('back')"
            >
              返回大厅
            </button>
          </template>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 视觉自持（同 Settlement.vue 的规约）：颜色/间距/字号/圆角全走 `$ftl-*` 令牌，
 * 零硬编码 hex。死态遮罩 z-index 高过 MoreMenu（10）与结算层（1/2）——
 * 链路已死时牌桌上任何操作都送不出去，它必须在最上层拦住。
 */
.connection-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}

/* 重连提示条：视觉对齐 NoticeStack `.notice--warn`（warn 档位用金色描边 + 深色玻璃底）。 */
.connection-overlay__toast {
  position: absolute;
  top: $ftl-space-2;
  left: 50%;
  transform: translateX(-50%);
  box-sizing: border-box;
  max-width: calc(100% - #{$ftl-space-8});
  padding: $ftl-space-3 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-gold;
  border-radius: $ftl-radius-md;
  background: rgb(0 0 0 / 62%);
  pointer-events: none;
}
.connection-overlay__toast-text {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  line-height: 1.4;
  white-space: nowrap;
}

/* 终态遮罩：接管全部指针，压暗牌桌。 */
.connection-overlay__scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $ftl-space-6;
  background: rgb(0 0 0 / 55%);
  pointer-events: auto;
}
.connection-overlay__panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: $ftl-settlement-w;
  max-width: 100%;
  padding: $ftl-space-7 $ftl-space-7 $ftl-space-6;
  border-radius: $ftl-radius-md;
  background: $ftl-color-surface;
  box-shadow: 0 $ftl-space-3 $ftl-space-7 rgb(0 0 0 / 35%);
}
.connection-overlay__title {
  color: $ftl-color-text;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1.3;
}
.connection-overlay__message {
  margin-top: $ftl-space-4;
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
  line-height: 1.6;
  text-align: center;
}
.connection-overlay__actions {
  display: flex;
  gap: $ftl-space-4;
  width: 100%;
  margin-top: $ftl-space-6;
}
.connection-overlay__actions .btn {
  flex: 1 1 0;
}
/* 原生 button 必须在本组件自持观感（同 Settlement.vue 的机械闸规约）。 */
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
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
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
</style>
