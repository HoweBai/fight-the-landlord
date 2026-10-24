/**
 * 错误码 → 客户端处置的执行器（docs/design.md §11 / §6.5 / §12）。
 *
 * 原则：**处置只能来自 `CLIENT_ACTION` 表**，前端不得自行发明。
 * 本文件只做「查表 + 分派」，不判断「这个错误严不严重」——那是契约的事。
 *
 * 特别钉死一条：`13004` 的唯一处置是 `REFRESH_SNAPSHOT`（就地刷新快照），
 * **既不要求也不允许**升级为断线重连；重连只用于快照类消息 version 回退（M08）。
 */
import { CLIENT_ACTION, ClientAction, ErrCode } from '@fight-the-landlord/protocol';
import { reportError } from '../observability/reporter';

const reportedUnknownCodes = new Set<number>();

export function reportUnknownCode(code: number, context: 'action' | 'rest'): void {
  if (reportedUnknownCodes.has(code)) return;
  reportedUnknownCodes.add(code);
  reportError('notice.unknown_code', new Error(`unknown error code ${code}`), { code, context });
}

export function resetUnknownCodeReports(): void {
  reportedUnknownCodes.clear();
}

export interface ClientActionReport {
  code: number;
  /** 表中登记的处置；未知码为安全兜底 `TOAST`。 */
  action: ClientAction;
  /** 该码是否在契约表内。 */
  known: boolean;
  message?: string;
  /** 请求类错误时，触发该处置的请求类型（仅用于日志）。 */
  requestType?: string;
  /** 上报来源：`action`（用户动作的 ack / 重放）或 `system`（服务端推送）。 */
  source?: 'action' | 'system';
}

/** 每种处置对应的执行动作。由页面/app 层实现（弹提示、跳转、拉快照）。 */
export interface ClientActionHandlers {
  ignore: (report: ClientActionReport) => void;
  refreshSnapshot: (report: ClientActionReport) => void;
  reconnect: (report: ClientActionReport) => void;
  toast: (report: ClientActionReport) => void;
  backToLobby: (report: ClientActionReport) => void;
}

export type ClientActionExecutor = (
  code: number,
  message?: string,
  source?: 'action' | 'system',
) => ClientActionReport;

export interface AckLike {
  code: number;
  message?: string;
  data?: unknown;
}

export interface ClassifiedAck {
  ok: boolean;
  code: number;
  action: ClientAction;
  /** 服务端的人类可读说明；**仅供调试/展示**（§6.2：不得据此分支）。 */
  message?: string;
}

/**
 * 归类一个 ack。
 *
 * `message` 是「人类可读说明，**仅供调试**，客户端不得据此分支」（§6.2），
 * 因此这里**只**看 `code`。
 */
export function classifyAck(ack: AckLike): ClassifiedAck {
  const known = isKnownCode(ack.code);
  return {
    ok: ack.code === ErrCode.OK,
    code: ack.code,
    action: known ? CLIENT_ACTION[ack.code as ErrCode] : ClientAction.TOAST,
    message: ack.message,
  };
}

export function isKnownCode(code: number): boolean {
  return Object.prototype.hasOwnProperty.call(CLIENT_ACTION, code);
}

/**
 * 生成一个「查表 + 分派」的执行器。
 *
 * 未知码**不得静默吞掉**：兜底为 `TOAST`（用户至少知道出了事，日志也留了痕）。
 */
export function dispatchErrorCode(handlers: ClientActionHandlers): ClientActionExecutor {
  return (code: number, message?: string, source = 'action'): ClientActionReport => {
    const known = isKnownCode(code);
    const action = known ? CLIENT_ACTION[code as ErrCode] : ClientAction.TOAST;
    if (!known) reportUnknownCode(code, 'action');
    const report: ClientActionReport = { code, action, known, message, source };
    switch (action) {
      case ClientAction.IGNORE:
        handlers.ignore(report);
        break;
      case ClientAction.REFRESH_SNAPSHOT:
        handlers.refreshSnapshot(report);
        break;
      case ClientAction.RECONNECT:
        handlers.reconnect(report);
        break;
      case ClientAction.BACK_TO_LOBBY:
        handlers.backToLobby(report);
        break;
      case ClientAction.TOAST:
      default:
        handlers.toast(report);
        break;
    }
    return report;
  };
}

/** 只实现部分处置的便捷构造（未提供的处置默认空实现）。 */
export function createActionExecutor(
  handlers: Partial<ClientActionHandlers>,
): ClientActionExecutor {
  const noop = () => {};
  return dispatchErrorCode({
    ignore: handlers.ignore ?? noop,
    refreshSnapshot: handlers.refreshSnapshot ?? noop,
    reconnect: handlers.reconnect ?? noop,
    toast: handlers.toast ?? noop,
    backToLobby: handlers.backToLobby ?? noop,
  });
}

/**
 * REST 消费点共用的「错误码 → 处置」分派（R34）。
 *
 * 与 WS 的差别**只在执行层面**，不涉及「某码对应什么处置」——映射一律由
 * `classifyAck`（即 `CLIENT_ACTION` 表）给出，本函数只执行表里写好的动作：
 *  - `BACK_TO_LOBBY`（`10002` 未登录 / `10005` 签名无效）：令牌已不可用 →
 *    只清本地会话 + 回登录页，**不得**再调服务端登出（它同样会返回这两个码，必然也失败）；
 *  - `REFRESH_SNAPSHOT` / `RECONNECT`：REST 语境下没有对局快照可刷 →
 *    重放当前请求一次（**由调用方保证最多一次**，不得循环）；
 *  - `TOAST` → 提示；`IGNORE` → 什么都不做。
 */
export interface RestFailureHandlers {
  /** 提示用户。`report.message` 是服务端的人类可读说明，可能为空。 */
  toast: (report: ClientActionReport) => void;
  /** 令牌不可用：清本地会话 + 回登录页。**不得**调服务端登出。 */
  signOutLocally: (report: ClientActionReport) => void;
  /** 重放当前请求一次（实现方负责「最多一次」）。 */
  replay: () => Promise<unknown>;
}

export async function dispatchRestFailure(
  ack: AckLike,
  handlers: RestFailureHandlers,
): Promise<ClientActionReport> {
  const classified = classifyAck(ack);
  if (!isKnownCode(classified.code)) reportUnknownCode(classified.code, 'rest');
  const report: ClientActionReport = {
    code: classified.code,
    action: classified.action,
    known: isKnownCode(classified.code),
    message: classified.message,
  };

  switch (classified.action) {
    case ClientAction.BACK_TO_LOBBY:
      handlers.signOutLocally(report);
      break;
    case ClientAction.REFRESH_SNAPSHOT:
    case ClientAction.RECONNECT:
      await handlers.replay();
      break;
    case ClientAction.IGNORE:
      break;
    case ClientAction.TOAST:
    default:
      handlers.toast(report);
      break;
  }
  return report;
}
