/**
 * 页面级提示控制器（Task 3 · 提示收敛基座）：`NoticeStack` 的**本地项**来源。
 *
 * 分工（规格 D2）：服务端错误码只走 session notice（`composables/sessionNotice.ts`），
 * REST/本地条件走页面自己的 `notices` —— 本模块管后者。一个页面一个实例（页面 `setup` 里建），
 * 渲染统一交给 `components/NoticeStack.vue`（挂在 `LandscapeStage` 的 `overlay` 槽）。
 *
 * ## 生命周期规则（与规格 TTL 表逐条对应）
 *
 *  - **TTL**：info/success 3s · warn 6s · error 8s；显式 `durationMs` 覆盖；
 *    `durationMs: 0` ⇒ sticky（永不自动消失，用于加载失败/需要玩家处置的提示）；
 *  - **同 id 替换**：新值覆盖旧值，旧计时器取消并按新级别重新计时（`setNotice` 就是这个语义）；
 *  - **同文案去重**：`level + text` 相同、且**双方都没有动作**时才去重（带动作的提示是
 *    可操作出口，不能被一条同文案的普通提示吞掉）；去重时重置在位项的计时器；
 *  - **容量**：普通项最多 5 条，超出的淘汰**最旧**一条；`priority: 'critical'` 永不淘汰；
 *  - **卸载**：`show` 变 no-op、全部计时器清掉 —— 组件都销毁了，提示不该再改任何状态。
 *
 * ⚠️ **零全局状态**：每个页面持有自己的实例（`items` 是组件级 `ref`），不引单例 ——
 *    页面之间不共享提示，`NoticeStack` 也不替页面做去重（合并 session 项是 Stack 的事，Task 4）。
 */
import { onUnmounted, ref, type Ref } from 'vue';

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

/** 浮层所在页面（`data-surface` 锚点；迁移任务用它做页面级走查/样式适配）。 */
export type NoticeSurface = 'login' | 'lobby' | 'game' | 'table' | 'wallet' | 'history';

export interface NoticeAction {
  label: string;
  kind?: 'primary' | 'secondary';
  /** 允许函数形态：动作可用性随页面状态变化（如「重试」在请求中置灰）。 */
  disabled?: boolean | (() => boolean);
  onClick: () => void;
}

export interface NoticeItem {
  id: string;
  level: NoticeLevel;
  text: string;
  durationMs?: number;
  actions?: NoticeAction[];
  priority?: 'critical' | 'normal';
  /** 缺省：无动作项可关闭，有动作项不可关闭（`NoticeStack` 的 `dismissible()` 同款规则）。 */
  dismissible?: boolean;
}

export interface PageNotices {
  items: Ref<NoticeItem[]>;
  show(item: NoticeItem): void;
  dismiss(id: string): void;
  clear(): void;
  /**
   * 「状态位」式提示：同 id 反复喂文本，空文案 = 移除。
   * `options` 是**部分**覆盖（`level` 缺省 `info`）—— 调用方最常写 `setNotice('load', msg)`。
   */
  setNotice(id: string, text: string, options?: Partial<Omit<NoticeItem, 'id' | 'text'>>): void;
}

const DEFAULT_DURATION: Record<NoticeLevel, number> = {
  info: 3000,
  success: 3000,
  warn: 6000,
  error: 8000,
};
const MAX_NORMAL = 5;

export function usePageNotices(): PageNotices {
  const items = ref<NoticeItem[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function remove(id: string): void {
    items.value = items.value.filter((item) => item.id !== id);
  }

  function schedule(item: NoticeItem): void {
    const duration = item.durationMs ?? DEFAULT_DURATION[item.level];
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      timers.delete(item.id);
      remove(item.id);
    }, duration);
    timers.set(item.id, timer);
  }

  function show(item: NoticeItem): void {
    if (disposed) return;
    const existing = items.value.find((entry) => entry.id === item.id);
    if (existing !== undefined) {
      clearTimer(item.id);
      items.value = items.value.map((entry) => (entry.id === item.id ? item : entry));
      schedule(item);
      return;
    }
    /**
     * 去重要求**双方都无动作**：带动作的提示是玩家唯一的操作出口（如「重试」），
     * 被一条同文案的普通提示吞掉会让出口消失。
     */
    const duplicate = items.value.find(
      (entry) =>
        entry.level === item.level &&
        entry.text === item.text &&
        (entry.actions?.length ?? 0) === 0 &&
        (item.actions?.length ?? 0) === 0,
    );
    if (duplicate !== undefined) {
      clearTimer(duplicate.id);
      schedule(duplicate);
      return;
    }
    // 新项在前（`NoticeStack` 按数组序渲染，最新的离状态条最近）。
    let next = [item, ...items.value];
    const normal = next.filter((entry) => entry.priority !== 'critical');
    if (normal.length > MAX_NORMAL) {
      const oldest = normal[normal.length - 1]!;
      clearTimer(oldest.id);
      next = next.filter((entry) => entry.id !== oldest.id);
    }
    items.value = next;
    schedule(item);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    remove(id);
  }

  function clear(): void {
    for (const id of [...timers.keys()]) clearTimer(id);
    items.value = [];
  }

  /**
   * 「状态位」式提示：同 id 反复喂文本。页面接线最常用这个形态
   * （`notices.setNotice('load', errorText, { level: 'error', durationMs: 0 })`），
   * 空文案 = 该状态已消失 ⇒ 移除。`level` 缺省 `info`（只关心文案的接线不必重复写级别）。
   */
  function setNotice(
    id: string,
    text: string,
    options: Partial<Omit<NoticeItem, 'id' | 'text'>> = {},
  ): void {
    if (text === '') {
      dismiss(id);
      return;
    }
    show({ ...options, id, text, level: options.level ?? 'info' });
  }

  onUnmounted(() => {
    disposed = true;
    clear();
  });

  return { items, show, dismiss, clear, setNotice };
}
