/**
 * 连接死态的**文案与动作策略单一真源**（Task 4）。
 *
 * 三个呈现面共用本模块，任何人改口径只改这里：
 *  - `ConnectionOverlay.vue`（牌桌全屏遮罩）；
 *  - `NoticeStack.vue` 的内置死态项（`connection-dead`，大厅 + 玩法页顶部提示）；
 *  - `socket.ts` 的服务端踢线文案（`connectionKickMessage`）。
 *
 * 口径：
 *  - `give_up`：自动重连 `RECONNECT_GIVE_UP_ATTEMPTS` 次仍失败 → **可重试**；
 *  - `server_rejected` + 无码：服务端主动踢线且没给原因（最常见是 30min 空闲踢线，
 *    也可能是握手拒绝的 `system.error` 没来得及刷出）⇒ **可重试**；
 *  - `server_rejected` + `10006` 并发上限：用户可能已在别处关掉窗口 → **可重试**；
 *    文案是「同一网络…」的完整玩家话术（不向玩家输出 IP/§5.4 内部术语）；
 *  - `server_rejected` + `10008` 端闸：软开关（管理端可能已重新打开）→ **可重试**；
 *  - `server_rejected` + `10007` 上游不可用：临时故障、文案本身就说「稍后重试」→ **可重试**；
 *  - `server_rejected` + `11003` 封禁：再连也必被拒 → **不可重试**，文案与登录路径同源；
 *  - `server_rejected` 其余码：不给重试；握手拒绝类码用登录同源的友好文案；
 *  - **服务端主动踢线一律给「重新登录」出口**（2026-10-23 用户裁决）：重连后若再次
 *    被拒，玩家至少能回登录页重新登录；
 *  - `session_expired`：access+refresh 双双失效 → **只能重登**（`canRelogin`）。
 *
 * ⚠️ 本模块是**纯查表**：只 import protocol 与 `copy.ts`；`ConnectionState` 是类型导入
 *（不进运行期依赖，避免与 `socket.ts` 形成运行期循环）。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import type { ConnectionState } from './socket';
import { authErrorMessage } from './copy';

export interface ConnectionCopy {
  title: string;
  message: string;
  canRetry: boolean;
  canRelogin: boolean;
}

/** 10006 并发上限的完整玩家话术（死态三面 + socket 踢线共用，逐字一致）。 */
const RATE_LIMITED_MESSAGE = '同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。';

/**
 * 终态（`phase === 'dead'`）的标题/正文/动作策略。
 *
 * `canRetry`：give-up / 无码踢线（空闲踢线可恢复）/ 10006 并发上限 / 10008 端闸 /
 * 10007 上游临时不可用；
 * `canRelogin`：`session_expired` 与**所有** `server_rejected`（再次被拒时的登录出口）。
 */
export function connectionDeadCopy(state: ConnectionState): ConnectionCopy {
  const rejected = state.deadReason === 'server_rejected';
  const canRetry =
    state.deadReason === 'give_up' ||
    (rejected &&
      (state.deadCode === null ||
        state.deadCode === ErrCode.RATE_LIMITED ||
        state.deadCode === ErrCode.CLIENT_DISABLED ||
        state.deadCode === ErrCode.UPSTREAM_UNAVAILABLE));
  const canRelogin = state.deadReason === 'session_expired' || rejected;

  if (state.deadReason === 'session_expired') {
    return {
      title: '登录已过期',
      message: authErrorMessage(ErrCode.TOKEN_EXPIRED, '操作'),
      canRetry: false,
      canRelogin: true,
    };
  }
  if (rejected) {
    const title = '连接被终止';
    if (state.deadCode === ErrCode.USER_BANNED) {
      // 与登录路径同源（copy.ts 的 K1 全串）——不在连接层另造封禁文案。
      return { title, message: authErrorMessage(ErrCode.USER_BANNED, '操作'), canRetry, canRelogin };
    }
    if (state.deadCode === ErrCode.RATE_LIMITED) {
      return { title, message: RATE_LIMITED_MESSAGE, canRetry, canRelogin };
    }
    if (state.deadCode === ErrCode.CLIENT_DISABLED) {
      // 与登录 toast 同源（copy.ts 的 §0 全串）——四面同串。
      return { title, message: authErrorMessage(ErrCode.CLIENT_DISABLED, '连接'), canRetry, canRelogin };
    }
    /**
     * 握手拒绝的其余「可解释」码：用登录路径同源的友好文案（10002/10004/10005
     * 都是「登录状态已失效，请重新登录」，10007 是「服务暂时不可用」，11005 是设备绑定）。
     * 无码 / 未知码才落到中性兜底。
     */
    if (
      state.deadCode === ErrCode.UNAUTHENTICATED ||
      state.deadCode === ErrCode.TOKEN_EXPIRED ||
      state.deadCode === ErrCode.TOKEN_INVALID ||
      state.deadCode === ErrCode.UPSTREAM_UNAVAILABLE ||
      state.deadCode === ErrCode.DEVICE_MISMATCH
    ) {
      return { title, message: authErrorMessage(state.deadCode, '连接'), canRetry, canRelogin };
    }
    return { title, message: '服务端主动断开了连接。', canRetry, canRelogin };
  }
  return {
    title: '连接已断开',
    message: '多次自动重连仍未成功，请检查网络后手动重试。',
    canRetry,
    canRelogin,
  };
}

/**
 * 服务端踢线（`io server disconnect`）的**玩家文案**（R166/N15）。
 *
 * - 11003 / 10008：与登录路径、死态组件**同源**（`copy.ts`）；
 * - 10006：与死态组件同一句并发上限话术（`RATE_LIMITED_MESSAGE`）；
 * - 其余：中性兜底（无码 = 服务端主动断开；有码 = 断开后请重连）。
 */
export function connectionKickMessage(code: number | null): string {
  if (code === ErrCode.USER_BANNED) return authErrorMessage(ErrCode.USER_BANNED, '操作');
  if (code === ErrCode.CLIENT_DISABLED) return authErrorMessage(ErrCode.CLIENT_DISABLED, '连接');
  if (code === ErrCode.RATE_LIMITED) {
    return RATE_LIMITED_MESSAGE;
  }
  return code === null ? '服务端主动断开了连接。' : '连接已被服务端断开，请重新连接。';
}
