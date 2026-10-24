/**
 * 钱包摘要取数（2026-10-23 钱包拆分 §4.5）。
 *
 * **状态在 `game` store**（钱包页 / 提现页共享一份）——本组合式只负责：
 *  · 发请求 → 用 `beginWalletSummaryRequest()` 的世代号写入（乱序慢响应被拦）；
 *  · 把失败原因交给**当前页**的 `NoticeStack`（`setError` / `dismiss` 由页面注入）。
 *
 * `summaryError` 从 store 派生（单一真源）：任一页取数成功，两页的失败态同时退场。
 *
 * ⚠️ 本组合式不持定时器、不注册生命周期 ⇒ 可在页面 `setup()` 之外直接调用（单测同款）。
 */
import { computed, type ComputedRef } from 'vue';
import * as pay from '../net/pay';
import { dispatchRestFailure } from '../net/errors';
import { playerMessage } from '../net/copy';
import { reportError } from '../observability/reporter';
import { stopGameSession } from './useGameSession';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';

export interface WalletSummaryView {
  balance: number;
  withdrawable: number;
  dailyWithdrawRemainingCoins: number;
}

/** 摘要取不到时的固定文案（与钱包页静态失败行同源）。 */
export const WALLET_SUMMARY_FALLBACK = '钱包信息加载失败，请稍后重试';

export interface UseWalletSummary {
  /** 共享摘要（store 派生；`null` = 还没取到）。 */
  summary: ComputedRef<WalletSummaryView | null>;
  /** 共享失败文案（store 派生；成功时由 store 清空）。 */
  summaryError: ComputedRef<string>;
  loadSummary: (replayed?: boolean) => Promise<void>;
}

export function useWalletSummary(opts: {
  /** 页面错误面（sticky + 重试）。 */
  setError: (text: string, retry?: () => void) => void;
  /** 成功时收掉本页的 sticky `summary` 项。 */
  dismiss: () => void;
}): UseWalletSummary {
  const auth = useAuthStore();
  const store = useGameStore();
  const summary = computed(() => store.walletSummary);
  const summaryError = computed(() => store.walletSummaryError);

  async function loadSummary(replayed = false): Promise<void> {
    const seq = store.beginWalletSummaryRequest();
    /** 只有**生效**的那一发才动本页 notices（被更新的响应超越 ⇒ 静默）。 */
    const fail = (text: string): void => {
      if (!store.setWalletSummaryError(text, seq)) return;
      opts.setError(text, () => void loadSummary());
    };

    try {
      const res = await pay.fetchPayWalletSummary();
      if (res.code === 0) {
        const data = res.data;
        // 信封成功但 data 为空 = 失败（不得静默当成「摘要 = 空」）。
        if (!data) {
          fail(WALLET_SUMMARY_FALLBACK);
          return;
        }
        const applied = store.applyWalletSummary(
          {
            balance: data.balance,
            withdrawable: data.withdrawable,
            dailyWithdrawRemainingCoins: data.dailyWithdrawRemainingCoins,
          },
          seq,
        );
        if (applied) opts.dismiss();
        return;
      }
      await dispatchRestFailure(res, {
        toast: (report) => {
          fail(
            playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
          );
        },
        signOutLocally: (report) => {
          stopGameSession();
          auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
        },
        replay: () => (replayed ? Promise.resolve() : loadSummary(true)),
      });
    } catch (e) {
      // H5 上 fetch 的拒绝会抛出 ⇒ 与信封失败同一处置；原始异常只进上报链。
      fail(WALLET_SUMMARY_FALLBACK);
      reportError('wallet.loadSummary', e);
    }
  }

  return { summary, summaryError, loadSummary };
}
