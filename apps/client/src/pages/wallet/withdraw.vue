<script setup lang="ts">
/**
 * 提现子页（2026-10-23 钱包拆分 §4.4）：第 8 页，钱包页「提现」入口 `navigateTo` 压栈。
 *
 * ## 结构（底分卡语言，不拥挤）
 *
 *  返回 + 标题 → 数据卡网格（可提额度 / 当日剩余；`summary=null` 显「—」，不回落 0）
 *  → 提现面板（大号输入 + 等高按钮）→ 说明卡网格（门槛 / 单笔 / 单日；`null` 整卡不渲染）。
 *
 * ## 提交（逻辑自钱包页原样搬移）
 *
 *  五项本地预检只是**预检**（服务端锁内校验是唯一权威）；再认证开关开 ⇒ 先弹密码框
 *  → `POST /auth/reauth` → 带 `X-Reauth-Ticket` 提交。失败文案取服务端 `message` 逐字。
 *  成功 ⇒ 刷新共享摘要（余额/可提/日剩余）+ 置 `walletRecordsStale` —— 提现列表在
 *  钱包页，由它消费标记后重取（子页不拉列表；`navigateBack` 不重挂/可能重挂两种模型都成立）。
 *
 * ## 纪律
 *
 *  - 样式只用 `$ftl-*` 令牌；禁 SCSS `@use`。
 *  - 遮罩类交互若日后加入：**不得用 `@click.self`**（uni-app H5 结构性不可用）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { PayWithdrawStatus } from '@fight-the-landlord/protocol';
import { useAuthStore } from '../../stores/auth';
import { useGameStore } from '../../stores/game';
import * as pay from '../../net/pay';
import { reauth } from '../../net/rest';
import { dispatchRestFailure } from '../../net/errors';
import { playerMessage } from '../../net/copy';
import { reportError } from '../../observability/reporter';
import { stopGameSession } from '../../composables/useGameSession';
import { usePageNotices } from '../../composables/usePageNotices';
import { useWalletSummary } from '../../composables/useWalletSummary';
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

const { summary, summaryError, loadSummary } = useWalletSummary({
  setError: (text, retry) => setError('summary', text, retry),
  dismiss: () => notices.dismiss('summary'),
});

/**
 * 共享错误是单一真源：**任一页**取数成功都会清空 `walletSummaryError` ⇒ 本页 static 行与
 * sticky 项一起退场；反过来，后台页失败时本页也要给出「重试」出口（同 id 幂等）。
 */
watch(summaryError, (text) => {
  if (text === '') {
    notices.dismiss('summary');
    return;
  }
  setError('summary', text, () => void loadSummary());
});

onMounted(() => {
  // 开关关（含未知）不取数：守卫态没有可展示的表单。
  if (store.withdrawEnabled) void loadSummary();
});

/** 提现状态映射（§4 逐字；与钱包页记录行同源）。 */
const WITHDRAW_STATUS_LABEL: Record<PayWithdrawStatus, string> = {
  holding: '提交中',
  pending: '审核中',
  approved: '已通过',
  paid: '已打款',
  rolling_back: '退回中',
  rejected: '已驳回',
  timeout_rolled_back: '已超时退回',
  failed: '已失败',
};

const withdrawInput = ref('');
const withdrawBusy = ref(false);
const withdrawResult = ref<{ withdrawNo: string; status: PayWithdrawStatus } | null>(null);

/** 占位 = 门槛（§4 逐字）；门槛未知 ⇒ 一句通用提示（不编一个数）。 */
const withdrawPlaceholder = computed(() =>
  store.withdrawMinCoins === null ? '输入提现金币数' : String(store.withdrawMinCoins),
);

/**
 * 提交前校验（§4 逐字五项：整数、≥min、≤max、≤当日可申、≤可提）。
 * 未知的量（`null`）**不检查**——服务端锁内校验仍是唯一权威（预检不越权、不撒谎）。
 * 入参按 `string | number` 收：uni `<input>` 交回字符串，H5 原生面可能归一成数字。
 */
function validateWithdrawCoins(
  raw: string | number,
): { ok: true; coins: number } | { ok: false; message: string } {
  const text = String(raw).trim();
  if (text === '' || !/^\d+$/.test(text)) return { ok: false, message: '请输入整数金币数' };
  const coins = Number(text);
  if (!Number.isSafeInteger(coins) || coins <= 0) return { ok: false, message: '请输入正整数金币数' };
  const min = store.withdrawMinCoins;
  if (min !== null && coins < min) return { ok: false, message: `不能低于门槛 ${min} 金币` };
  const max = store.withdrawMaxCoinsPerOrder;
  if (max !== null && coins > max) return { ok: false, message: `不能超过单笔上限 ${max} 金币` };
  const remaining = summary.value === null ? null : summary.value.dailyWithdrawRemainingCoins;
  if (remaining !== null && coins > remaining) {
    return { ok: false, message: `不能超过当日剩余可申额度 ${remaining} 金币` };
  }
  const cap = summary.value === null ? null : summary.value.withdrawable;
  if (cap !== null && coins > cap) return { ok: false, message: `不能超过可提额度 ${cap} 金币` };
  return { ok: true, coins };
}

/**
 * 提交提现申请。成功 ⇒ 浮层成功项（6s）+ 静态状态行 + 刷新共享摘要 + 置记录失效标记。
 *
 * ⚠️ `replay` 刻意 **no-op**（再认证语境）——自动重放会重复弹密码校验，玩家重新提交更诚实。
 */
async function onSubmitWithdraw(replayed = false) {
  if (withdrawBusy.value) return;
  const check = validateWithdrawCoins(withdrawInput.value);
  if (!check.ok) {
    setError('withdraw', check.message);
    return;
  }

  /**
   * P1-5：忙碌位从**弹出密码框之前**开始罩 —— 密码框未决期间按钮仍可点，旧实现
   * 会弹两次密码框、发两次 reauth、最终提交两笔。
   *
   * `finally` 只负责复位；ack 处置放在 try 之后（`replay` 会回调本函数，入口守卫
   * 需要此时 busy 已放行，否则重放被静默吃掉）。
   */
  withdrawBusy.value = true;
  let res: Awaited<ReturnType<typeof pay.applyPayWithdrawal>>;
  try {
    // 敏感操作再认证（开关开才走）。
    let reauthTicket: string | undefined;
    if (store.withdrawReAuthEnabled) {
      const password = await askPassword('请输入登录密码以验证身份');
      if (password === null) return; // 用户取消
      let reRes: Awaited<ReturnType<typeof reauth>>;
      try {
        reRes = await reauth(password);
      } catch (e) {
        // P1-5：网络异常（fetch reject）与 11002 的响应分支同一可见出口 ——
        // 旧实现没人接这个异常（无提示、busy 也不复位）。
        setError('withdraw', '密码验证失败，请稍后重试');
        reportError('wallet.reauth', e);
        return;
      }
      if (reRes.code !== 0) {
        await dispatchRestFailure(reRes, {
          toast: (report) => {
            setError(
              'withdraw',
              playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
            );
          },
          signOutLocally: (report) => {
            stopGameSession();
            auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
          },
          replay: async () => {
            // reauth 不自动重放：避免重复密码校验；提示用户重新提交（TOAST/BACK_TO_LOBBY 已处置）。
          },
        });
        return;
      }
      reauthTicket = reRes.data?.ticket;
      if (!reauthTicket) {
        setError('withdraw', '密码验证失败，请稍后重试');
        return;
      }
    }

    notices.dismiss('withdraw');
    notices.dismiss('withdraw-result');
    withdrawResult.value = null;
    try {
      res = await pay.applyPayWithdrawal(check.coins, reauthTicket);
    } catch (e) {
      setError('withdraw', '提现申请失败，请稍后重试');
      reportError('wallet.applyPayWithdrawal', e);
      return;
    }
  } finally {
    // ⚠️ 先放行再处置：忙碌位只罩「请求在途」，否则 replay 分支会被入口守卫静默吃掉。
    withdrawBusy.value = false;
  }
  if (res.code === 0) {
    const data = res.data;
    if (!data) {
      setError('withdraw', '提现申请失败，请稍后重试');
      return;
    }
    withdrawResult.value = { withdrawNo: data.withdrawNo, status: data.status };
    notices.setNotice(
      'withdraw-result',
      `申请已提交：${WITHDRAW_STATUS_LABEL[data.status]}（${data.withdrawNo}）`,
      { level: 'success', durationMs: 6000 },
    );
    withdrawInput.value = '';
    store.walletRecordsStale = true;
    void loadSummary();
    return;
  }
  await dispatchRestFailure(res, {
    toast: (report) => {
      // 15003/15004/15005（含「有处理中申请，请稍后重试」「服务暂时不可用，请稍后重试」
      // 两个变体）是 message-first 码：文案由服务端给，逐字展示（§2.8）。
      setError(
        'withdraw',
        playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
      );
    },
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
    },
    replay: () => (replayed ? Promise.resolve() : onSubmitWithdraw(true)),
  });
}

/**
 * uni.showModal 的密码输入扩展（uni-app alpha 支持 `editable` + `inputType`）。
 * 返回用户输入的密码串，或 null = 用户取消。
 */
function askPassword(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      editable: true,
      inputType: 'password',
      placeholderText: '请输入登录密码',
      success: (res) => {
        if (res.confirm) resolve(res.content ?? '');
        else resolve(null);
      },
      fail: () => resolve(null),
    });
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
    <view class="wallet-withdraw">
      <view class="wallet-withdraw__bar">
        <button type="button" class="btn btn--small wallet-withdraw__back" @click="onBack">
          返回
        </button>
        <text class="wallet-withdraw__title">提现</text>
      </view>

      <scroll-view class="wallet-withdraw__body" scroll-y>
        <view v-if="!store.withdrawEnabled" class="wallet-withdraw__panel">
          <text class="wallet-withdraw__muted">提现暂未开放</text>
        </view>
        <template v-else>
          <!-- 数据卡：可提额度 / 当日剩余；未取到显「—」，禁止回落 0。 -->
          <view class="wallet-withdraw__stats">
            <view class="wallet-withdraw__stat">
              <text class="wallet-withdraw__stat-label">可提额度</text>
              <text class="wallet-withdraw__stat-value">
                {{ summary === null ? '—' : summary.withdrawable }}
              </text>
            </view>
            <view class="wallet-withdraw__stat">
              <text class="wallet-withdraw__stat-label">当日剩余</text>
              <text class="wallet-withdraw__stat-value">
                {{ summary === null ? '—' : summary.dailyWithdrawRemainingCoins }}
              </text>
            </view>
          </view>

          <view class="wallet-withdraw__panel">
            <text class="wallet-withdraw__section-title">提现金额</text>
            <view class="wallet-withdraw__row">
              <input
                v-model="withdrawInput"
                class="wallet-withdraw__input withdraw-input"
                type="number"
                :placeholder="withdrawPlaceholder"
              />
              <button
                type="button"
                class="btn btn--primary wallet-withdraw__submit withdraw-submit"
                :disabled="withdrawBusy"
                @click="onSubmitWithdraw()"
              >
                申请提现
              </button>
            </view>

            <!-- 说明卡：门槛 / 单笔 / 单日；服务端没给就不渲染这一张（不编数）。 -->
            <view class="wallet-withdraw__limits">
              <view v-if="store.withdrawMinCoins !== null" class="wallet-withdraw__limit">
                <text class="wallet-withdraw__limit-label">门槛</text>
                <text class="wallet-withdraw__limit-value">{{ store.withdrawMinCoins }} 金币</text>
              </view>
              <view v-if="store.withdrawMaxCoinsPerOrder !== null" class="wallet-withdraw__limit">
                <text class="wallet-withdraw__limit-label">单笔上限</text>
                <text class="wallet-withdraw__limit-value">
                  {{ store.withdrawMaxCoinsPerOrder }} 金币
                </text>
              </view>
              <view v-if="store.withdrawDailyMaxCoins !== null" class="wallet-withdraw__limit">
                <text class="wallet-withdraw__limit-label">单日上限</text>
                <text class="wallet-withdraw__limit-value">
                  {{ store.withdrawDailyMaxCoins }} 金币
                </text>
              </view>
            </view>

            <text v-if="summaryError" class="wallet-withdraw__failure">钱包信息暂不可用</text>
            <!-- 提交成功的**静态**状态行：浮层成功项 6s 自消，这里留状态位。 -->
            <text v-if="withdrawResult" class="wallet-withdraw__result">
              申请已提交：{{ WITHDRAW_STATUS_LABEL[withdrawResult.status] }}（{{
                withdrawResult.withdrawNo
              }}）
            </text>
          </view>
        </template>
      </scroll-view>
    </view>

    <template #overlay>
      <NoticeStack :items="noticeItems" surface="wallet" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/** 页面骨架与充值子页同族：bar + 可滚动内容区。 */
.wallet-withdraw {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.wallet-withdraw__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 返回：次按钮语言。⚠️ 选择器必须带 `.wallet-withdraw` 前缀（`.btn` mixin 在本文件末尾，
 * 同特指度下后者胜）。
 */
.wallet-withdraw .wallet-withdraw__back {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.wallet-withdraw__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
.wallet-withdraw__body {
  flex: 1 1 auto;
  min-height: 0;
}
/**
 * 数据卡/说明卡网格：`auto-fit` 在窄画布换行、宽画布对齐（不横向溢出）。
 */
.wallet-withdraw__stats,
.wallet-withdraw__limits {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: $ftl-space-4;
}
.wallet-withdraw__stats {
  margin-bottom: $ftl-space-4;
}
/** 数据卡（底分卡语言；不可点 ⇒ `<view>`）。 */
.wallet-withdraw__stat {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-2;
  min-height: $ftl-control-h;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night, 0.85);
}
.wallet-withdraw__stat-label {
  color: rgba($ftl-color-on-primary, 0.7);
  font-size: $ftl-font-xs;
  line-height: 1.2;
}
.wallet-withdraw__stat-value {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 半透明深蓝面板（§5.2.1）。 */
.wallet-withdraw__panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.85);
}
.wallet-withdraw__section-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}
.wallet-withdraw__row {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
}
/** 输入与按钮**等高**（旧页 56 vs 88 的不齐是本次走查点之一）。 */
.wallet-withdraw__input {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: $ftl-control-h;
  padding: 0 $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
}
.wallet-withdraw .wallet-withdraw__submit {
  flex: 0 0 auto;
  min-height: $ftl-control-h;
  margin: 0;
}
/** 说明卡：小号数据卡语言（标签 + 值一行放不下时换行）。 */
.wallet-withdraw__limit {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-2;
  padding: $ftl-space-4 $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
}
.wallet-withdraw__limit-label {
  color: rgba($ftl-color-on-primary, 0.7);
  font-size: $ftl-font-xs;
  line-height: 1.2;
}
.wallet-withdraw__limit-value {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
.wallet-withdraw__failure {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.wallet-withdraw__result {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.wallet-withdraw__muted {
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
