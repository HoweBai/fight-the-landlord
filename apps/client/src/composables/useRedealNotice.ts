/**
 * 重新发牌的可感知化（2026-10-22 片）：把服务端 `bidPhase.redealCount` 的**递增**
 * 译成「横幅可见 + 手牌重放入场」两个展示位。
 *
 * ## 这里没有任何规则判定（哑终端）
 *
 * 是否重发、第几次、第 3 次是否改走随机地主 —— 全部由服务端视图决定
 * （`packages/shared/src/ddz/bid.ts` 的 `handleBid`）。本文件只做「数字变了 → 开/关
 * 一个展示位」这一件事，不推、不算、不猜。
 *
 * ## 计时器为什么在这里
 *
 * 牌桌区组件（`src/components/**` 与 `src/pages/table/**`）不得新造时钟
 * （`test/animations.test.ts` 的机械闸 + `table-bid-ui.test.ts` 的 TIMER_TRACES）。
 * 本文件与 `useCountdown` / `useSettlementReveal` 同族：**展示态的短生命周期计时器**
 * 放在 composables 层。横幅的视觉淡出由 CSS 生命周期 keyframes 负责，这个计时器只是
 * **兜底卸载**（`prefers-reduced-motion` 下动画不跑时，横幅也必须 2 秒后消失）。
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { useGameStore } from '../stores/game';

/**
 * 横幅停留时长。与 `styles/animations.scss` 的 `--ftl-redeal-ms` 兜底值**必须相等**
 * —— `animations.test.ts` 有跨文件单一真源闸。
 */
export const REDEAL_BANNER_MS = 2000;

export function useRedealNotice(): {
  /** 横幅是否可见 */
  visible: Ref<boolean>;
  /** 真重发次数（本地表现用）；同时作为 `Hand` 的 key */
  epoch: Ref<number>;
} {
  const store = useGameStore();
  const visible = ref(false);
  const epoch = ref(0);
  /** 上一个已处置的 `redealCount`；`null` = 还没有可用的视图（首版基线待定）。 */
  let baseline: number | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHide(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hide(): void {
    clearHide();
    visible.value = false;
  }

  watch(
    () => store.ddzBidPhase?.redealCount ?? null,
    (count) => {
      if (count === null) {
        // 会话/房间销毁：基线、横幅、动画世代全部归零。
        baseline = null;
        hide();
        epoch.value = 0;
        return;
      }
      if (baseline === null) {
        // 首版视图（进房 / 重进页面 / reset 后首个视图）只做基线，不补播历史重发。
        // ⚠️ 同一页面存活期间的重连不适用这一支：view 未被清空 ⇒ baseline 还在，
        //     resync 视图的 count 升高会走下面的递增分支（那是真实发生过的重发）。
        baseline = count;
        return;
      }
      if (count < baseline) {
        // 新的一局（redealCount 回落）：清表现，下一局首发回到普通发牌动画。
        baseline = count;
        hide();
        epoch.value = 0;
        return;
      }
      if (count === baseline) return;
      baseline = count;
      // 第 3 次流局：服务端不再重发，同版视图 state 已变 playing 并随机指定地主。
      if (!store.isBidding) return;
      epoch.value += 1;
      visible.value = true;
      clearHide();
      hideTimer = setTimeout(() => {
        visible.value = false;
        hideTimer = null;
      }, REDEAL_BANNER_MS);
    },
    { immediate: true },
  );

  // 横幅只属于叫抢期：state 一变（出牌/结束/视图消失）立即收掉，不等计时器。
  // 典型场景：机器人在 2 秒内又走到第 3 次流局（不再重发、直接定地主）。
  watch(
    () => store.view?.state ?? null,
    (state) => {
      if (state !== 'bidding') hide();
    },
  );

  onScopeDispose(clearHide);

  return { visible, epoch };
}
