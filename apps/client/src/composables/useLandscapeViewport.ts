/**
 * 横屏舞台的**视口信号源**（2026-10-15 真机缺陷修复）。
 *
 * ## 为什么不能只靠 `uni.onWindowResize`
 *
 * iOS Safari 旋转 / 工具栏收放期间会派发**携带瞬态垃圾读数的 resize**
 * （实测：`innerHeight=80` + 竖屏残留 `env(safe-area-inset-*)`，可用高只剩 1px），
 * 而且最后一个 resize 可能**就是这个垃圾帧，之后再无纠正事件**。
 * `uni-h5` 自己的 `orientationchange` 监听只刷 rem、不派发 `ON_RESIZE`。
 * 旧实现照单全收 ⇒ `scale=1/750` ⇒ 画布塌成 1px，只剩底纹（登录 UI「消失」）。
 *
 * ## 两道防线
 *
 *  1. **读数消毒 + last-good**（纯逻辑在 `useLandscapeCanvas`）：瞬态读数不可用 ⇒
 *     保留上一个好读数，画布绝不塌缩；
 *  2. **H5 多信号 + 稳定复读**（本文件）：除 uni resize 外，H5 额外监听
 *     原生 `resize` / `orientationchange` / `visualViewport.resize`，
 *     每次事件后在双 rAF 与 120/400/900ms 复读 —— 即使宿主再无事件，
 *     也能在旋转动画结束后自行拿到稳定值。
 *
 * **定时器只允许放在 composable**（牌桌区「不新造时钟」纪律，
 * `animations.test.ts` 扫 `src/components/**`，组件里不得出现 setTimeout）。
 *
 * App / 小程序端：`typeof window` 守卫全部跳过，行为与旧实现逐字一致（仅 uni resize）。
 */
import { onUnmounted, ref, type Ref } from 'vue';
import {
  keepLastGoodViewport,
  readViewport,
  type Viewport,
} from './useLandscapeCanvas';

const ZERO_VIEWPORT: Viewport = {
  w: 0,
  h: 0,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** 旋转动画（iOS 约 0.3s）结束后的复读档位；900ms 兜住工具栏二次收放。 */
const SETTLE_DELAYS_MS = [120, 400, 900] as const;

/** 组件 setup 期调用；返回可直接驱动 `LandscapeStage` 的视口 ref，卸载自动注销。 */
export function useLandscapeViewport(): Ref<Viewport> {
  const viewport = ref<Viewport>(keepLastGoodViewport(ZERO_VIEWPORT, readViewport()));

  function ingest(): void {
    viewport.value = keepLastGoodViewport(viewport.value, readViewport());
  }

  // uni API 必须直接成员调用（uni-api-access 闸）；App / 小程序 / H5 统一通道。
  uni.onWindowResize(ingest);
  /**
   * ➕ 合入自 master 的 2026-10-13「跨设备裁剪」修复意图：窗口尺寸变更存在**漏发
   * resize** 的窗口态（MuMu `wm size` 热切换实测；前台往返即自愈，shots/24/25 留档）
   * ——回前台时补一次 ingest 即可自愈；ingest 幂等、读数没变时零副作用。
   */
  uni.onAppShow(ingest);

  let stopH5: (() => void) | null = null;
  /**
   * H5 原生接缝（仿 `useAppVisibility` 的 `typeof window` 守卫）：
   * 小程序 service 层 / App 无 window，整块静态跳过。
   */
  if (typeof window !== 'undefined') {
    const timers: number[] = [];
    const rafs = new Set<number>();
    const hasRaf = typeof window.requestAnimationFrame === 'function';

    function readSoon(): void {
      if (hasRaf) {
        const id1 = window.requestAnimationFrame(() => {
          rafs.delete(id1);
          ingest();
          const id2 = window.requestAnimationFrame(() => {
            rafs.delete(id2);
            ingest();
          });
          rafs.add(id2);
        });
        rafs.add(id1);
      }
      for (const delay of SETTLE_DELAYS_MS) {
        timers.push(window.setTimeout(ingest, delay));
      }
    }

    function onNativeResize(): void {
      // 立即吃一次（uni-h5 的 resize 有 50ms debounce，原生通道更早），随后稳定复读。
      ingest();
      readSoon();
    }

    const onOrientationChange = (): void => readSoon();
    const visual = window.visualViewport ?? null;

    window.addEventListener('resize', onNativeResize);
    window.addEventListener('orientationchange', onOrientationChange);
    visual?.addEventListener('resize', onNativeResize);
    // 冷启动首帧可能正赶上旋转动画：安排一轮复读自愈。
    readSoon();

    stopH5 = () => {
      window.removeEventListener('resize', onNativeResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      visual?.removeEventListener('resize', onNativeResize);
      for (const id of timers) window.clearTimeout(id);
      for (const id of rafs) window.cancelAnimationFrame(id);
      timers.length = 0;
      rafs.clear();
    };
  }

  onUnmounted(() => {
    uni.offWindowResize(ingest);
    uni.offAppShow(ingest);
    stopH5?.();
  });

  return viewport;
}
