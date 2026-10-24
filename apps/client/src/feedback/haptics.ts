/**
 * 震动反馈（触感层）。
 *
 * 与 `audio/` 同族的「宿主能力薄封装」：
 *  1. **`uni.xxx()` 必须是直接成员调用**（闸：`test/uni-api-access.test.ts`），
 *     不得把 `uni` 读进变量；
 *  2. **绝不抛**：宿主不支持 / 用户关闭系统震动时静默降级（与音频层同一纪律，
 *     真浏览器探针零容忍 console error）；
 *  3. **开关持久化**：走 uni 存储，未命中按「开」处理（与音频偏好同形）。
 *
 * ⚠️ 档位映射受**跨端能力**约束：`uni.vibrateShort` 的入参在 @dcloudio/types 里没有
 * `type` 字段（各端也不统一）⇒ `light`/`medium` 都走短震（~15ms），**`heavy` 走
 * `vibrateLong`**（~400ms，用于「被拒」这类需要明显警示的时刻）。
 * ⚠️ H5 / 旧 webview 可能不提供震动 API ⇒ 存在性判定后再调。
 */

const KEY_ENABLED = 'ftl.haptics.enabled';

/** 宿主是否提供 `uni` 全局（存在性判定，**不**把 `uni` 读进变量）。 */
function hasUni(): boolean {
  return typeof uni !== 'undefined';
}

/** 震动档位。语义对应手感，不对应任何游戏规则。 */
export type HapticKind = 'light' | 'medium' | 'heavy';

let enabled = true;

/** 从宿主存储读回开关（页面挂载时调一次；缺省 = 开）。 */
export function loadHapticsPrefs(): void {
  if (!hasUni()) return;
  try {
    enabled = uni.getStorageSync(KEY_ENABLED) !== '0';
  } catch {
    // 读不到就用默认（开）
  }
}

export function isHapticsEnabled(): boolean {
  return enabled;
}

export function setHapticsEnabled(next: boolean): void {
  enabled = next;
  if (!hasUni()) return;
  try {
    uni.setStorageSync(KEY_ENABLED, next ? '1' : '0');
  } catch {
    // 持久化失败不影响内存态
  }
}

/**
 * 震一下。任何情况下都不抛。
 *
 * ⚠️ **直接成员调用** `uni.vibrateShort(...)`（H5 发行注入的前提，见 `uni-api-access` 闸）。
 * ⚠️ 故意不缓存函数引用（`const v = uni.vibrateShort` 同样会逃过注入改写）。
 */
export function haptic(kind: HapticKind = 'light'): void {
  if (!enabled || !hasUni()) return;
  try {
    // ⚠️ 直接成员调用（H5 发行注入前提，见 `uni-api-access` 闸）；
    // 故意不缓存函数引用（`const v = uni.vibrateShort` 同样逃过注入改写）。
    if (kind === 'heavy') {
      uni.vibrateLong({});
    } else {
      uni.vibrateShort({});
    }
  } catch {
    // 宿主不支持 / 系统层面拒绝 ⇒ 静默降级
  }
}
