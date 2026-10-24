/**
 * `useWalletSummary`（2026-10-23 钱包拆分 §4.5）。
 *
 * 判别力：
 *  · 成功 ⇒ 共享摘要 / `walletBalance` 更新 + 本页 sticky 项退场；
 *  · 信封非 0 / `data=null` / fetch 拒绝 ⇒ 同一失败处置，旧摘要保留；
 *  · **乱序**：先发的慢响应晚到 ⇒ `applyWalletSummary` 返回 false 的一发不动 notices。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';
import {
  WALLET_SUMMARY_FALLBACK,
  useWalletSummary,
} from '../src/composables/useWalletSummary';

const ok = (data: unknown) => ({ code: 0, data });
const err = (code: number, message: string) => ({ code, message, data: null });
const summaryData = (balance: number) => ({
  balance,
  withdrawable: balance - 40,
  dailyWithdrawRemainingCoins: 5000,
});

function fakeResponse(body: unknown): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function harness() {
  const setError = vi.fn();
  const dismiss = vi.fn();
  const api = useWalletSummary({ setError, dismiss });
  return { api, setError, dismiss };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWalletSummary', () => {
  it('成功 ⇒ 写共享摘要与 walletBalance，并收掉本页 sticky 项', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(ok(summaryData(4200)))));
    const { api, setError, dismiss } = harness();

    await api.loadSummary();

    expect(useGameStore().walletSummary).toEqual(summaryData(4200));
    expect(useGameStore().walletBalance).toBe(4200);
    expect(api.summaryError.value).toBe('');
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it('信封非 0 ⇒ setError(文案 + 重试)，旧摘要保留', async () => {
    const store = useGameStore();
    store.applyWalletSummary(summaryData(300), store.beginWalletSummaryRequest());
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(err(10007, '上游不可用'))));
    const { api, setError, dismiss } = harness();

    await api.loadSummary();

    expect(setError).toHaveBeenCalledTimes(1);
    const [text, retry] = setError.mock.calls[0]!;
    expect(text).toBeTruthy();
    expect(text).toBe(api.summaryError.value);
    expect(typeof retry).toBe('function');
    expect(store.walletSummary, '失败不擦旧摘要').toEqual(summaryData(300));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('code=0 但 data=null ⇒ 走失败处置（不得静默当成功），旧摘要保留', async () => {
    const store = useGameStore();
    store.applyWalletSummary(summaryData(300), store.beginWalletSummaryRequest());
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(ok(null))));
    const { api, setError, dismiss } = harness();

    await api.loadSummary();

    expect(setError).toHaveBeenCalledWith(WALLET_SUMMARY_FALLBACK, expect.any(Function));
    expect(dismiss).not.toHaveBeenCalled();
    expect(store.walletSummary?.balance, '空响应不得擦掉旧摘要').toBe(300);
  });

  it('fetch 拒绝 ⇒ 同一失败文案 + 不抛 unhandled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { api, setError } = harness();

    await expect(api.loadSummary()).resolves.toBeUndefined();

    expect(setError).toHaveBeenCalledWith(WALLET_SUMMARY_FALLBACK, expect.any(Function));
  });

  it('乱序：慢响应晚到不覆盖新响应，且不动 notices', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => resolvers.push(resolve))),
    );
    const { api, dismiss, setError } = harness();

    const first = api.loadSummary();
    const second = api.loadSummary();
    expect(resolvers).toHaveLength(2);

    // 后发先到
    resolvers[1]!(fakeResponse(ok(summaryData(200))));
    await second;
    // 先发晚到
    resolvers[0]!(fakeResponse(ok(summaryData(100))));
    await first;

    expect(useGameStore().walletSummary?.balance).toBe(200);
    expect(useGameStore().walletBalance).toBe(200);
    expect(dismiss, '只有生效的那一发才 dismiss').toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });
});
