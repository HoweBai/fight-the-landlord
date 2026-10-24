/**
 * 倒计时。
 *
 * ⚠️ 时间基准**只能**来自服务端的 `turnDeadlineAt` / `timeoutMs`（§12.2 F06：
 * 禁止用本地时间判断游戏规则）。本 composable 只做「把服务端给的截止时刻换算成
 * 还剩多少毫秒用于显示」，到 0 也只是**显示**为 0——不等号判定、超时行为都在服务端。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';

export interface CountdownOptions {
  /** 服务端下发的毫秒级截止时刻（epoch ms）。 */
  deadlineAt: Ref<number | null> | (() => number | null);
  /** 每次状态转移后重置计时（例如新版本快照到达）。 */
  version?: Ref<number> | (() => number);
  intervalMs?: number;
}

export function useCountdown(options: CountdownOptions) {
  const remainingMs = ref(0);
  const now = ref(Date.now());
  const interval = options.intervalMs ?? 250;
  let timer: ReturnType<typeof setInterval> | null = null;

  const readDeadline = () =>
    typeof options.deadlineAt === 'function' ? options.deadlineAt() : options.deadlineAt.value;
  const readVersion = () =>
    options.version ? (typeof options.version === 'function' ? options.version() : options.version.value) : 0;

  function tick() {
    now.value = Date.now();
    const deadline = readDeadline();
    remainingMs.value = deadline === null ? 0 : Math.max(0, deadline - now.value);
  }

  function start() {
    stop();
    tick();
    timer = setInterval(tick, interval);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  watch(
    () => [readDeadline(), readVersion()],
    () => {
      tick();
    },
  );

  onBeforeUnmount(stop);

  return {
    remainingMs,
    seconds: computed(() => Math.ceil(remainingMs.value / 1000)),
    expired: computed(() => remainingMs.value <= 0),
    start,
    stop,
  };
}
