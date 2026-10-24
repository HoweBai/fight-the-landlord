import { onScopeDispose, ref, watch } from 'vue';
import { useGameStore } from '../stores/game';
import { getSettlementRevealDelayMs } from './settlementRevealDelay';

/**
 * settlement 对象 → 首次到达时间。WeakMap 跨页面卸载存活（同一 JS 运行时），
 * 重进页面时据此计算剩余延迟，而不是重新计满。
 */
let arrivals = new WeakMap<object, number>();

/** 仅供测试：清空到达时间缓存（WeakMap 无法 clear，直接换新实例）。 */
export function __resetSettlementRevealArrivalsForTest(): void {
  arrivals = new WeakMap();
}

/**
 * 终局结算延迟揭示：settlement 到达后先让牌桌停留（默认 2000ms），
 * 到点后 `revealed=true`，宿主据此渲染遮罩与结算面板。
 *
 * - 同一 settlement 对象重进页面 ⇒ 按首次到达时间计算剩余；
 * - 已揭示后重复 settlement 对象 ⇒ 保持可见（不重新隐藏）；
 * - settlement 置 null（换局/销毁会话）⇒ 清表并复位。
 */
export function useSettlementReveal() {
  const store = useGameStore();
  const revealed = ref(false);
  const receivedAt = ref<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  watch(
    () => store.settlement,
    (settlement) => {
      if (!settlement) {
        clear();
        revealed.value = false;
        receivedAt.value = null;
        return;
      }
      let t0 = arrivals.get(settlement);
      if (t0 === undefined) {
        t0 = Date.now();
        arrivals.set(settlement, t0);
      }
      receivedAt.value = t0;
      if (revealed.value) return;
      const remaining = Math.max(0, getSettlementRevealDelayMs() - (Date.now() - t0));
      clear();
      if (remaining <= 0) {
        revealed.value = true;
        return;
      }
      timer = setTimeout(() => {
        revealed.value = true;
        timer = null;
      }, remaining);
    },
    { immediate: true },
  );

  onScopeDispose(clear);
  return { revealed, receivedAt };
}
