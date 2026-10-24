/**
 * vitest 全局 setup（Task 3 起）：装 `uni` 全局替身。
 *
 * `src/**` 现在通过 `uni.getStorageSync` / `uni.setStorageSync` / `uni.reLaunch`
 * 与宿主打交道（三端统一），jsdom 里没有 `uni` ⇒ 必须先装替身，
 * 否则生产代码会走「宿主没有存储」的降级分支，用例比真实实现更宽松。
 *
 * 替身的忠实度论证、以及与真实 uni 的已知差异：见 `test/helpers/uni-stub.ts` 顶部。
 * ⚠️ 它只补**宿主能力**，不改 `src/**` 的行为。
 */
import { beforeEach } from 'vitest';
import { installUniStub } from './helpers/uni-stub';
import { __setSettlementRevealDelayForTest } from '../src/composables/settlementRevealDelay';
import { __resetSettlementRevealArrivalsForTest } from '../src/composables/useSettlementReveal';

installUniStub();

/**
 * 结算延迟的测试默认值：既有结算用例全部按「settlement 到达即出现」断言；
 * 延迟行为由 `settlement-reveal.test.ts` 显式 `__reset` 到生产默认值后单独覆盖。
 */
beforeEach(() => {
  __setSettlementRevealDelayForTest(0);
  __resetSettlementRevealArrivalsForTest();
});
