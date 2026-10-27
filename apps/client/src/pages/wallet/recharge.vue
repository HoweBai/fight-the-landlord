<script setup lang="ts">
/**
 * 充值子页（2026-10-23 钱包拆分 §4.3）：第 7 页，钱包页「充值」入口 `navigateTo` 压栈。
 *
 * ## 结构
 *
 *  返回 + 标题 → 面板（当前余额 / 档位卡网格）。档位卡用**底分卡语言**：
 *  描边卡 + 两行文案 + 网格等宽等高；`coinPerYuan` 未知时只有金额一行，
 *  靠 `min-height` 兜底保证同排卡不出现「一长一短」。内容区 `scroll-view`：
 *  `rechargePackages` 是配置中心值，超出画布不得被裁。
 *
 * ## 下单（逻辑自钱包页原样搬移）
 *
 *  点卡 ⇒ `pay.createPayOrder` ⇒ `pay.jumpToCashier(payUrl)`；`creating` 期间全禁用。
 *  失败面走 `dispatchRestFailure` + `playerMessage`；降级引导是 sticky `pay-hint`，
 *  下次下单开始即收。钩子 `pay-package-{yuan}`（规格 §4 逐字）。
 *
 * ## 开关语义
 *
 *  `rechargeEnabled === false` ⇒ 只显示「充值暂未开放」静态行（直链兜底；
 *  未知配置按 false 处理 = C19 语义）。
 *
 * ## 纪律
 *
 *  - 遮罩类交互若日后加入：**不得用 `@click.self`**（uni-app H5 结构性不可用）。
 *  - 样式只用 `$ftl-*` 令牌；禁 SCSS `@use`。
 */
import { ref } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { useGameStore } from '../../stores/game';
import * as pay from '../../net/pay';
import { dispatchRestFailure } from '../../net/errors';
import { playerMessage } from '../../net/copy';
import { reportError } from '../../observability/reporter';
import { stopGameSession } from '../../composables/useGameSession';
import { usePageNotices } from '../../composables/usePageNotices';
import LandscapeStage from '../../components/LandscapeStage.vue';
import NoticeStack from '../../components/NoticeStack.vue';

const auth = useAuthStore();
const store = useGameStore();
const notices = usePageNotices();
const { items: noticeItems } = notices;

/** 本页错误面：带重试 ⇒ sticky + critical；无重试 ⇒ 8s 自消。 */
function setError(id: string, text: string, retry?: () => void): void {
  notices.setNotice(id, text, {
    level: 'error',
    durationMs: retry ? 0 : 8000,
    priority: retry ? 'critical' : 'normal',
    dismissible: true,
    actions: retry ? [{ label: '重试', onClick: retry }] : undefined,
  });
}

const creating = ref(false);

/** 档位金币数；比率未知 ⇒ `null`（模板据此不渲染第二行，不编一个数）。 */
function coinsOf(yuan: number): number | null {
  return store.coinPerYuan === null ? null : yuan * store.coinPerYuan;
}

/**
 * 点档位 ⇒ 下单 ⇒ 跳收银台（失败/降级处置见文件头；`replay` 与禁用位的
 * 「先放行再处置」理由沿用钱包页原注释）。
 */
async function onBuyPackage(packageYuan: number, replayed = false) {
  if (creating.value) return;
  creating.value = true;
  notices.dismiss('recharge');
  notices.dismiss('pay-hint');
  let res;
  try {
    res = await pay.createPayOrder(packageYuan);
  } catch (e) {
    setError('recharge', '下单失败，请稍后重试');
    reportError('wallet.createPayOrder', e);
    return;
  } finally {
    // ⚠️ 先放行再处置：禁用位只罩「请求在途」，否则 replay 分支会被入口守卫静默吃掉。
    creating.value = false;
  }
  if (res.code === 0) {
    const data = res.data;
    if (!data?.payUrl) {
      setError('recharge', '下单失败，请稍后重试');
      return;
    }
    if (!pay.jumpToCashier(data.payUrl)) {
      notices.setNotice('pay-hint', pay.PAY_BROWSER_HINT, {
        level: 'info',
        durationMs: 0,
        priority: 'critical',
      });
    }
    return;
  }
  await dispatchRestFailure(res, {
    toast: (report) => {
      setError(
        'recharge',
        playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
      );
    },
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
    },
    replay: () => (replayed ? Promise.resolve() : onBuyPackage(packageYuan, true)),
  });
}

/** 返回钱包页（子页是压栈形态；全局 `navigationStyle: custom` ⇒ 没有原生返回键）。 */
function onBack() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <LandscapeStage>
    <!--
      ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
      `classes()` 静默返回 `[]`（单根闸盯着全部页面）。
    -->
    <view class="wallet-recharge">
      <view class="wallet-recharge__bar">
        <button type="button" class="btn btn--small wallet-recharge__back" @click="onBack">
          返回
        </button>
        <text class="wallet-recharge__title">充值</text>
      </view>

      <scroll-view class="wallet-recharge__body" scroll-y>
        <view v-if="!store.rechargeEnabled" class="wallet-recharge__panel">
          <text class="wallet-recharge__muted">充值暂未开放</text>
        </view>
        <view v-else class="wallet-recharge__panel">
          <text class="wallet-recharge__section-title">选择充值档位</text>
          <!-- 当前余额：取不到就不显示（不显 0）。 -->
          <text v-if="store.walletBalance !== null" class="wallet-recharge__balance">
            当前余额 {{ store.walletBalance }} 金币
          </text>
          <view v-if="store.rechargePackages.length > 0" class="wallet-recharge__packages">
            <button
              v-for="yuan in store.rechargePackages"
              :key="yuan"
              type="button"
              class="wallet-recharge__package"
              :class="`pay-package-${yuan}`"
              :disabled="creating"
              @click="onBuyPackage(yuan)"
            >
              <text class="wallet-recharge__price">{{ yuan }} 元</text>
              <text v-if="coinsOf(yuan) !== null" class="wallet-recharge__coins">
                {{ coinsOf(yuan) }} 金币
              </text>
            </button>
          </view>
          <text v-else class="wallet-recharge__muted">暂无充值档位</text>
        </view>
      </scroll-view>
    </view>

    <template #overlay>
      <NoticeStack :items="noticeItems" surface="wallet" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/** 页面骨架与钱包页同族：bar + 可滚动内容区。 */
.wallet-recharge {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.wallet-recharge__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 返回：次按钮语言。⚠️ 选择器必须带 `.wallet-recharge` 前缀（`.btn` mixin 在本文件末尾，
 * 同特指度下后者胜——`history.vue` / `wallet.vue` 记着同款产物实测）。
 */
.wallet-recharge .wallet-recharge__back {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.wallet-recharge__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
.wallet-recharge__body {
  flex: 1 1 auto;
  min-height: 0;
}
/** 半透明深蓝面板（§5.2.1；与钱包页面板同族）。 */
.wallet-recharge__panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.85);
}
.wallet-recharge__section-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}
.wallet-recharge__balance {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/**
 * 档位卡网格：`auto-fit` 保证窄画布换行、宽画布对齐（不横向溢出——底分卡
 * 2026-10-13 事故的同款纪律）。最小宽 220：最紧画布（设计宽 1334 − 页 padding 2×16 −
 * 面板 padding 2×16 = 可用 1270）内 5 张一行放得下（5×220 + 4×8 = 1132）。
 */
.wallet-recharge__packages {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: $ftl-space-4;
}
/**
 * 档位卡（底分卡语言）：竖排、左对齐、描边卡；逐项重置 `uni-button` 宿主默认样式
 * （`margin-left/right:auto` 会破坏网格对齐、`color:#000`/不继承字体会改排版）。
 *
 * ⚠️ **等高**：`coinPerYuan` 未知时只有一行文案 ⇒ 用两行满配 min-height 兜底
 * （上下 padding + 金额行 + gap + 金币行），否则同排卡的描边框一长一短。
 * 判据在 `wallet-recharge.test.ts` 的源码级规则体断言。
 */
.wallet-recharge__package {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-3;
  width: 100%;
  min-height: $ftl-space-5 * 2 + $ftl-font-lg * 1.2 + $ftl-space-3 + $ftl-font-sm * 1.2;
  margin: 0;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.9);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  &:hover {
    border-color: $ftl-color-gold-deep;
    color: $ftl-color-gold-light;
  }
  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}
.wallet-recharge__price {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
.wallet-recharge__coins {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.2;
}
/** 中性状态字（空档位 / 暂未开放）——不是错误。 */
.wallet-recharge__muted {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 本页原生 `<button class="btn …">` 的观感自持（与 wallet/history 同款两条）。 */
.btn {
  @include ftl-btn;
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
</style>
