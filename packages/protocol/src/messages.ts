/**
 * 消息契约。清单来自 docs/design.md §6.3。
 *
 * **没有 `seq` 字段**（§6.2）：请求关联由 socket.io 的 ack 回调承担，
 * 去重与顺序由 `baseVersion` 的 CAS 承担，`reqId` 仅用于日志追踪。
 *
 * 这份清单本身就是契约。增删消息属于**破坏性变更**，必须两端同一个 PR。
 */

import type { Card, GameView, RoomPlayer, RoomInfo } from './views';
import type { SettlementResult } from './settlement';
import type { GameType } from './game';

/**
 * 每个请求都携带的元信息。**线格式里这些字段是平铺在请求体里的**（§6.2）：
 *
 * ```ts
 * socket.timeout(5000).emit(type, { reqId, baseVersion, timestamp, payload }, (err, res) => ...)
 * ```
 *
 * `type` **由 socket.io 的事件名承载，请求体不重复它**。
 * 校验器 `validateClientMessage(type, body)` 负责把扁平体组装成逻辑格式。
 *
 * `baseVersion` 只在 `game.bid` / `game.play` / `game.pass` 上有意义
 * （见 `CAS_MESSAGES`），其余请求传 `0`。
 */
export interface RequestMeta {
  /** UUID，仅用于日志追踪，**不参与任何判定** */
  reqId: string;
  /** 客户端所依据的状态版本。服务端据此做 CAS。 */
  baseVersion: number;
  /** 客户端毫秒时间戳。服务端校验 |clientTs - serverTs| < 5000ms（M01）。 */
  timestamp: number;
}

/** 请求的线格式（socket.io 的 emit 载荷） */
export interface ClientRequestWire<P = unknown> extends RequestMeta {
  payload: P;
}

/** C→S 请求的逻辑格式，共 11 条 */
export type ClientMessage =
  | { type: 'room.match'; meta: RequestMeta; payload: { mode: 'random' | 'practice' | 'gold'; baseScore: number; deviceId?: string; gameType?: GameType; playerCount?: number } }
  | { type: 'room.unmatch'; meta: RequestMeta; payload: Record<string, never> }
  /**
   * 机器人补位开关片：补机器人关闭时，玩家在 `match.wait_prompt` 弹窗上点「延长匹配时间」
   * ⇒ 通知服务端本次再等一个补位窗口（票**留在原队列**、排队位置不变）。无载荷：
   * 服务端按连接身份与 `match:meta` 定位票；票已不在（已开局/超时/取消）⇒ 幂等 no-op。
   */
  | { type: 'room.match.extend'; meta: RequestMeta; payload: Record<string, never> }
  | { type: 'room.join'; meta: RequestMeta; payload: { roomCode: string; gameType?: GameType } }
  | { type: 'room.leave'; meta: RequestMeta; payload: { roomCode: string } }
  | { type: 'game.bid'; meta: RequestMeta; payload: { grab: boolean } }
  | { type: 'game.play'; meta: RequestMeta; payload: { cards: Card[] } }
  | { type: 'game.pass'; meta: RequestMeta; payload: Record<string, never> }
  | { type: 'game.reconnect'; meta: RequestMeta; payload: { lastVersion?: number } }
  /** 重新拉取当前裁剪快照。**这是 §6.5 中 13004 的唯一恢复通道**，
   *  与 `game.reconnect`（断线恢复，含记录查找）语义不同，故独立成一条。 */
  | { type: 'game.resync'; meta: RequestMeta; payload: Record<string, never> }
  /**
   * 挂机治理：托管开关（manual via —— `via` 由 room-service 转发时补齐，不在客户端载荷里）。
   * `on: true` = 托管，`false` = 解除；幂等（目标值 = 现值 ⇒ 服务端完全 no-op）。
   * `on` 非严格 boolean（含字符串 `'false'`）⇒ 校验器 `ProtocolError` ⇒ `10001`。
   */
  | { type: 'game.trustee'; meta: RequestMeta; payload: { on: boolean } };

export type ClientMessageType = ClientMessage['type'];

/** S→C 推送，共 12 条。全部携带 `version`。 */
export type ServerMessage =
  | { type: 'room.matched'; version: number; payload: { roomCode: string; seat: number; gameType?: GameType; playerCount?: number } }
  | {
      type: 'room.state_update';
      version: number;
      payload: { status: RoomInfo['status']; players: RoomPlayer[]; gameType?: GameType; playerCount?: number };
    }
  /**
   * 机器人补位开关片：补机器人关闭且缺人越过补位窗口时，服务端发给在等玩家的**友好提示**
   *（票仍在队列里继续等真人，不终止匹配）。玩家可回 `room.match.extend` 再等一个窗口，
   * 或发 `room.unmatch` + `room.match` 重新匹配；总等待上限到点改发 `system.error(12007)`。
   * 房间/匹配级消息（与 `room.matched` 同）：不参与对局版本判定，`version` 恒为 0。
   */
  | { type: 'match.wait_prompt'; version: number; payload: { message: string } }
  | { type: 'game.deal'; version: number; payload: GameView }
  | { type: 'game.current_turn'; version: number; payload: { seat: number; timeoutMs: number } }
  | { type: 'game.state_update'; version: number; payload: GameView }
  | {
      type: 'game.finished';
      version: number;
      payload:
        | { winner: 'landlord' | 'farmer' }
        | { gameType: 'paodekuai'; winnerSeats: number[] };
    }
  | { type: 'game.settlement'; version: number; payload: SettlementResult }
  /**
   * ② 金币场（⚙️2）：结算时刻三座余额（**恰 3 条、座位升序**），仅在金币场房内广播。
   * `version` = `game.ended` 事件信封的 version（与 `game.settlement` 同值）；
   * `balance` = 该座 owner 结算时刻的钱包余额（客户端只做展示——余额 chip 以后续拉取/推送为准）。
   */
  | {
      type: 'game.balances';
      version: number;
      payload: {
        balances: { seat: number; balance: number }[];
        gameType?: GameType;
        playerCount?: number;
      };
    }
  /**
   * 记牌器收费片：本局记牌器是否开通（**按玩家定向**；房间级消息，`version` 恒 0）。
   * `active` 由服务端计算（总开关/场次/权益消费结果），客户端只按它渲染入口与横条。
   * `source` = 本次消费来源（包时/单局卡/无权益/未知态），仅供展示与排查。
   */
  | {
      type: 'game.card_counter';
      version: number;
      payload: {
        roomCode: string;
        active: boolean;
        source?: 'pass' | 'credit' | 'none' | 'unknown';
      };
    }
  | { type: 'system.error'; version: number; payload: { code: number; message: string } }
  | { type: 'system.warning'; version: number; payload: { code: number; message: string } };

export type ServerMessageType = ServerMessage['type'];

export const CLIENT_MESSAGE_TYPES: readonly ClientMessageType[] = [
  'room.match',
  'room.unmatch',
  'room.match.extend',
  'room.join',
  'room.leave',
  'game.bid',
  'game.play',
  'game.pass',
  'game.reconnect',
  'game.resync',
  'game.trustee',
] as const;

export const SERVER_MESSAGE_TYPES: readonly ServerMessageType[] = [
  'room.matched',
  'room.state_update',
  'match.wait_prompt',
  'game.deal',
  'game.current_turn',
  'game.state_update',
  'game.finished',
  'game.settlement',
  'game.balances',
  'game.card_counter',
  'system.error',
  'system.warning',
] as const;

/**
 * 参与 `baseVersion` CAS 的请求（§6.5 的适用范围表）。
 * 其余请求必须传 `baseVersion: 0`。
 */
export const CAS_MESSAGES: readonly ClientMessageType[] = ['game.bid', 'game.play', 'game.pass'] as const;

/** 视为「快照类」的 S→C 消息：按 `version` 做新旧判定，回退时重连（§6.2 / M08）。 */
export const SNAPSHOT_MESSAGES: readonly ServerMessageType[] = [
  'game.deal',
  'game.state_update',
] as const;

/** 视为「事件类」的 S→C 消息：不按 `version` 丢弃，按事件类型幂等（§6.2）。 */
export const EVENT_MESSAGES: readonly ServerMessageType[] = [
  'game.current_turn',
  'game.finished',
  'game.settlement',
  /** ② 金币场：`version` 与 `game.settlement` 同值、同一局至多一条有效凭据 ⇒ 事件类。 */
  'game.balances',
  'system.error',
  'system.warning',
] as const;

/** 房间/匹配级消息：不参与对局版本判定，也不需要裁剪。 */
export const ROOM_MESSAGES: readonly ServerMessageType[] = [
  'room.matched',
  'room.state_update',
  'match.wait_prompt',
  /** 记牌器收费片：房间级状态（按玩家定向、version 恒 0、不参与对局版本判定）。 */
  'game.card_counter',
] as const;
