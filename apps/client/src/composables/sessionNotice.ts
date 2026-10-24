/**
 * 会话提示控制器（Task 2）：source / sticky / TTL 的唯一落点。
 *
 * 规则（规格「提示收敛与浮层化」）：
 *  - TTL：info 3s / warn 6s / error 8s；`sticky: true` 不自动消失（链路类提示）；
 *  - 每条新值递增 generation 并取消旧 timer —— 旧 timer 绝不会回写/清掉新值；
 *  - `clearAction()` 只清 `source: 'action'`（玩家重开匹配）；`dispose()` 清一切。
 */
import { ref, type Ref } from 'vue';
import type { SessionNotice } from '../net/session';

export interface SessionNoticeController {
  notice: Ref<SessionNotice | null>;
  set(next: SessionNotice | null): void;
  clearAction(): void;
  dispose(): void;
}

export function createSessionNoticeController(): SessionNoticeController {
  const notice = ref<SessionNotice | null>(null) as Ref<SessionNotice | null>;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function set(next: SessionNotice | null): void {
    generation += 1;
    cancelTimer();
    notice.value = next;
    if (next === null || next.sticky === true) return;
    const ttl = next.level === 'info' ? 3000 : next.level === 'warn' ? 6000 : 8000;
    const current = generation;
    timer = setTimeout(() => {
      if (current !== generation) return;
      notice.value = null;
      timer = null;
    }, ttl);
  }

  function clearAction(): void {
    if (notice.value?.source === 'action') set(null);
  }

  function dispose(): void {
    generation += 1;
    cancelTimer();
    notice.value = null;
  }

  return { notice, set, clearAction, dispose };
}
