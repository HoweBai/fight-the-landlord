/**
 * 应用前后台可见性（客户端优化项 1；项 9 的发版检查复用同一信号）。
 *
 * 两条通道并存，互为兜底：
 *  - `uni.onAppShow/onAppHide`：App / 小程序 / H5 桥接层统一信号；
 *  - H5 的 `document.visibilitychange`：页签切换、最小化、部分浏览器切后台时
 *    uni 桥接不保证派发，用浏览器原生信号补齐。
 *
 * 两条通道可能对同一次切换**都**派发（H5 上常见），因此统一走边沿判定：
 * 同值重复到达直接忽略，回前台回调只在 false→true 时触发一次。
 *
 * 分层：
 *  - `startAppVisibility()` 不依赖 Vue 生命周期，可在入口（main.ts）直接用；
 *  - `useAppVisibility()` 是组件层薄封装，卸载时自动注销。
 */
import { onUnmounted, ref, type Ref } from 'vue';

export interface VisibilityController {
  /** 当前是否处于前台/可见。初值 true：App 冷启动本就在前台。 */
  readonly visible: Ref<boolean>;
  /**
   * 注册回前台回调（false→true 边沿）。返回注销函数。
   * 组件里也可以直接 `watch(visible, ...)`，用本方法可免去首帧与边沿判断。
   */
  onShow(cb: () => void): () => void;
  /**
   * 注册切后台回调（true→false 边沿）。返回注销函数。
   * 与 onShow 对称。典型用途：暂停前台才需要跑的定时器。
   */
  onHide(cb: () => void): () => void;
  /** 注销全部监听（组件封装自动调用，入口手动管理时自行持有）。 */
  stop(): void;
}

export function startAppVisibility(): VisibilityController {
  const visible = ref(true);
  const showListeners = new Set<() => void>();
  const hideListeners = new Set<() => void>();
  let lastVisible = true;

  function applyVisibility(next: boolean): void {
    // 边沿判定：同值忽略（双轨重复派发），在 false→true 时通知 onShow，true→false 时通知 onHide。
    if (next === lastVisible) return;
    const wasVisible = lastVisible;
    lastVisible = next;
    visible.value = next;
    if (wasVisible && !next) {
      for (const cb of hideListeners) cb();
    } else if (!wasVisible && next) {
      for (const cb of showListeners) cb();
    }
  }

  const handleAppShow = (): void => applyVisibility(true);
  const handleAppHide = (): void => applyVisibility(false);
  const handleDocument = (): void => {
    /**
     * ⚠️ `typeof document` 守卫仿 transport.ts 中 window 守卫的先例：
     * 小程序 service 层无 document，直接访问在小程序构建的静态分析/运行时都会出问题。
     */
    if (typeof document === 'undefined') return;
    applyVisibility(!document.hidden);
  };

  // uni API 必须直接成员调用（uni-api-access 闸）。
  uni.onAppShow(handleAppShow);
  uni.onAppHide(handleAppHide);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleDocument);
  }

  return {
    visible,
    onShow(cb) {
      showListeners.add(cb);
      return () => {
        showListeners.delete(cb);
      };
    },
    onHide(cb) {
      hideListeners.add(cb);
      return () => {
        hideListeners.delete(cb);
      };
    },
    stop() {
      uni.offAppShow(handleAppShow);
      uni.offAppHide(handleAppHide);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleDocument);
      }
      showListeners.clear();
      hideListeners.clear();
    },
  };
}

/** 组件层封装：setup 期立即注册，组件卸载自动注销。 */
export function useAppVisibility(): VisibilityController {
  const controller = startAppVisibility();
  onUnmounted(() => controller.stop());
  return controller;
}
