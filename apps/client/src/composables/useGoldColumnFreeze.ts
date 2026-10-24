/**
 * 结算页金币列的 **5s 定格窗口**（② 金币场 §14 逐字：`game.balances` 未达 5s ⇒ 定格「—」，
 * **不得永久停在「结算中…」**）。
 *
 * ## 🔴 为什么是 composable，而不是 `Settlement.vue` 里的 `setTimeout`
 *
 * 牌桌区（`src/components/**` + `src/pages/table/**`）有一条**既有的机械闸**：
 * 「牌桌区不得新造时钟（§9.6）」（`animations.test.ts` 的第三条 + `table-bid-ui` 的 R675，
 * 扫 `setTimeout`/`setInterval`）——`Settlement.vue` **正在那个扫描面里**。
 * 计时器的**既定住处**是本目录：`useCountdown`（牌桌唯一的另一个计时器）就在这里，
 * `useLandscapeCanvas` 的头注释也记着「候选修法『超时兜底』不可用」这条前科。
 *
 * ⚠️ 本计时器**不是**规则时钟（§9.6 要消灭的那种）：它不参与任何超时判定，只决定
 * 「这条展示消息还等不等」——到点做的事是把格子从「结算中…」换成「—」，没有任何语义后果。
 *
 * ## 语义（三态的第二、三态）
 *
 *  - `arrived` 为真（`game.balances` 到达）⇒ **永不定格**（并撤表）——值永远优先于「—」：
 *    迟到的消息也是服务端真值（例如 outbox 补偿后的重发），「定格」消灭的是**永久
 *    『结算中…』**，不是拒绝迟到数据；
 *  - `active`（列已存在）∧ `!arrived` ⇒ 起表，`delayMs`（默认 5000）后 `frozen = true`；
 *  - 组件卸载 ⇒ 撤表（不许留下常驻定时器）。
 */
import { onUnmounted, ref, watch, type Ref } from 'vue';

/** 定格窗口（② §14 逐字：5s）。 */
export const GOLD_FREEZE_MS = 5000;

export interface GoldColumnFreezeOptions {
  /** 列是否**存在**（免费场根本没有列 ⇒ 不起表）。 */
  active: Ref<boolean>;
  /** `game.balances` 是否**已到达**。 */
  arrived: Ref<boolean>;
  /** 定格窗口（毫秒）；缺省 5000。 */
  delayMs?: number;
}

/**
 * 返回 `frozen`：到点前为 `false`（格子显示「结算中…」），到点后恒 `true`（显示「—」）。
 * **必须**在组件的 `setup` 同步调用（内部用 `onUnmounted` 撤表）。
 */
export function useGoldColumnFreeze(options: GoldColumnFreezeOptions): Ref<boolean> {
  const frozen = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 起表（幂等）：只有「列在、消息没到、还没定过格、表还没起」才真的起。 */
  const arm = (): void => {
    if (timer !== null || frozen.value) return;
    if (!options.active.value || options.arrived.value) return;
    timer = setTimeout(() => {
      timer = null;
      frozen.value = true;
    }, options.delayMs ?? GOLD_FREEZE_MS);
  };

  watch([options.active, options.arrived], ([, arrived]) => {
    if (arrived) {
      // 消息到了：表不需要了（已定格的也不回退 —— 格子的取值以 `arrived` 为先，见 `goldCell`）
      cancel();
      return;
    }
    // 列可能**后于**组件挂载才出现（例如结算后迟到的 state_update 带了余额）⇒ 到那一刻才起表
    arm();
  });

  // `watch` 默认不是 immediate ⇒ 挂载当场起一次表（「面板挂载时列已在、消息未到」是主路径）。
  arm();
  onUnmounted(cancel);

  return frozen;
}
