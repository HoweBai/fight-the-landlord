/**
 * 错误码与客户端处置。
 *
 * 错误码为 5 位数字、按服务分段，定义见 docs/design.md §11。
 * 禁止新增字符串错误码；旧字符串码只允许出现在 §11.4 的别名表里。
 *
 * `ErrCode` 的取值集合必须与 §11.2 的表格完全一致——
 * `test/errors.test.ts` 用一张硬编码的 SPEC_CODES 表机械校验这一点，
 * 防的是「代码悄悄漂移」。改任一侧都必须同 PR 改另一侧。
 */

export enum ErrCode {
  OK = 0,

  // 1xxxx 通用
  BAD_PARAM = 10001,
  UNAUTHENTICATED = 10002,
  FORBIDDEN = 10003,
  TOKEN_EXPIRED = 10004,
  TOKEN_INVALID = 10005,
  RATE_LIMITED = 10006,
  UPSTREAM_UNAVAILABLE = 10007,
  /** 客户端接入片：本端已被管理端暂停（整端准入闸；软开关，非安全边界）。 */
  CLIENT_DISABLED = 10008,

  // 11xxx 用户
  PHONE_TAKEN = 11001,
  BAD_CREDENTIALS = 11002,
  USER_BANNED = 11003,
  USER_NOT_FOUND = 11004,
  /** 账号已绑定其他设备（设备绑定安全功能：登录/WS 握手与已绑定设备不一致；403）。 */
  DEVICE_MISMATCH = 11005,

  // 12xxx 房间 / 匹配
  ROOM_NOT_FOUND = 12001,
  ROOM_FULL = 12002,
  NOT_YOUR_TURN = 12003,
  NOT_IN_ROOM = 12004,
  KICK_FORBIDDEN = 12005,
  FRIEND_ROOM_FAILED = 12006,
  MATCH_TIMEOUT = 12007,
  ROOM_ALREADY_STARTED = 12008,
  ALREADY_IN_QUEUE = 12009,
  /** ② 金币场：场次开关关闭时 `room.match` 拒绝（好友房仍走既有 12006）。 */
  ROOM_MODE_DISABLED = 12010,
  /** 本片：在局/在房者请求 `room.match` 的守卫拒绝（设计 §3.3）。 */
  ALREADY_IN_GAME = 12011,
  /** 多玩法片：玩法未开放 / 人数不支持 / 客户端与房间玩法不符（由 room-service 产出）。 */
  GAME_UNAVAILABLE = 12012,

  // 13xxx 游戏
  ILLEGAL_ACTION = 13001,
  VERSION_CONFLICT = 13004,
  GAME_OVER = 13005,
  INVALID_CARDS = 13006,
  ACTION_TIMEOUT = 13007,
  BOT_DECISION_TIMEOUT = 13008,
  GAME_NOT_STARTED = 13009,
  RECONNECT_RECORD_MISSING = 13010,

  // 14xxx 货币（货币核心片启用 14001/14002；② 金币场启用 14003/14004；§11.2）
  /** 余额不足（`currency.apply` 整批回滚）。 */
  E_INSUFFICIENT_FUNDS = 14001,
  /** actionId 冲突（同 id 不同载荷——「同 id 不同内容」永远是人祸，不静默）。 */
  E_ACTION_CONFLICT = 14002,
  /** 金币不足入场门槛（仅金币场、仅匹配路径；消息含所需金额）。 */
  E_ENTRY_THRESHOLD = 14003,
  /** 救助不可用（开关关闭 / 余额充足 / 判定不过——② 金币场 D10 两文案）。 */
  E_RELIEF_UNAVAILABLE = 14004,
  /** 记牌器收费片：未开放（总开关关 / 商品价 0；无配置快照走 10007）。 */
  E_CARD_COUNTER_UNAVAILABLE = 14008,
  /** 记牌器收费片：玩家确认价与服务端当前价不一致（刷新后重试）。 */
  E_CARD_COUNTER_PRICE_CHANGED = 14009,
  /** 记牌器收费片：同一 requestId 被不同 kind/hours 复用（换新请求号）。 */
  E_CARD_COUNTER_REQUEST_CONFLICT = 14010,

  // 15xxx 支付（支付片 T1 启用 15001–15009；设计 §8 + 规格 ⚙️9）
  /** 渠道调用失败（下单/查询不可用；可重试提示）。 */
  PAY_CHANNEL_ERROR = 15001,
  /** 订单不存在或非本人。 */
  PAY_ORDER_NOT_FOUND = 15002,
  /** 提现不可用（开关关/在途已有/低于门槛，message 区分）。 */
  PAY_WITHDRAW_UNAVAILABLE = 15003,
  /** 超单笔/单日限额。 */
  PAY_WITHDRAW_LIMIT = 15004,
  /** 可离场额度不足（P3 分池面）。 */
  PAY_WITHDRAWABLE_INSUFFICIENT = 15005,
  /** 退款不可退（状态/在途/已退/超可退，message 区分）。 */
  PAY_REFUND_UNAVAILABLE = 15006,
  /** 回调验签失败（服务端内部面，不出客户端；日志+指标；**不作响应码**——见 RESERVED_CODES）。 */
  PAY_NOTIFY_VERIFY_FAILED = 15007,
  /** 充值未开放（开关关；提现开关关走 15003 既有语义）。 */
  PAY_DISABLED = 15008,
  /** 管理写面源态冲突（HTTP 409；message 含当前态与合法动作）。 */
  PAY_STATE_CONFLICT = 15009,
}

/**
 * 客户端对每个错误码的处置。前端**必须**按此表分支，不得自行发明。
 * 这是「哑终端」原则在错误处理上的体现（docs/design.md §12）。
 */
export enum ClientAction {
  /** 静默忽略（幂等重复或本状态已过期） */
  IGNORE = 'ignore',
  /** 重新拉取当前裁剪快照，再由用户重新操作（§6.5 对 13004 的唯一处置） */
  REFRESH_SNAPSHOT = 'refresh_snapshot',
  /** 主动重连（仅用于快照类 version 回退，M08） */
  RECONNECT = 'reconnect',
  /** 提示用户，停留在当前页面 */
  TOAST = 'toast',
  /** 提示用户并返回大厅 */
  BACK_TO_LOBBY = 'back_to_lobby',
}

export const CLIENT_ACTION: Record<ErrCode, ClientAction> = {
  [ErrCode.OK]: ClientAction.IGNORE,
  [ErrCode.BAD_PARAM]: ClientAction.TOAST,
  [ErrCode.UNAUTHENTICATED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.FORBIDDEN]: ClientAction.TOAST,
  [ErrCode.TOKEN_EXPIRED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.TOKEN_INVALID]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.RATE_LIMITED]: ClientAction.TOAST,
  [ErrCode.UPSTREAM_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.CLIENT_DISABLED]: ClientAction.TOAST,
  [ErrCode.PHONE_TAKEN]: ClientAction.TOAST,
  [ErrCode.BAD_CREDENTIALS]: ClientAction.TOAST,
  [ErrCode.USER_BANNED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.USER_NOT_FOUND]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.DEVICE_MISMATCH]: ClientAction.TOAST,
  [ErrCode.ROOM_NOT_FOUND]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.ROOM_FULL]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.NOT_YOUR_TURN]: ClientAction.IGNORE,
  [ErrCode.NOT_IN_ROOM]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.KICK_FORBIDDEN]: ClientAction.TOAST,
  [ErrCode.FRIEND_ROOM_FAILED]: ClientAction.TOAST,
  [ErrCode.MATCH_TIMEOUT]: ClientAction.TOAST,
  [ErrCode.ROOM_ALREADY_STARTED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.ALREADY_IN_QUEUE]: ClientAction.IGNORE,
  [ErrCode.ROOM_MODE_DISABLED]: ClientAction.TOAST,
  [ErrCode.ALREADY_IN_GAME]: ClientAction.TOAST,
  [ErrCode.GAME_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.ILLEGAL_ACTION]: ClientAction.TOAST,
  /** §6.5：13004 的唯一处置是就地刷新快照；**禁止**升级为断线重连 */
  [ErrCode.VERSION_CONFLICT]: ClientAction.REFRESH_SNAPSHOT,
  [ErrCode.GAME_OVER]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.INVALID_CARDS]: ClientAction.TOAST,
  [ErrCode.ACTION_TIMEOUT]: ClientAction.REFRESH_SNAPSHOT,
  /** 内部事件码，不作为响应返回客户端 */
  [ErrCode.BOT_DECISION_TIMEOUT]: ClientAction.IGNORE,
  [ErrCode.GAME_NOT_STARTED]: ClientAction.REFRESH_SNAPSHOT,
  [ErrCode.RECONNECT_RECORD_MISSING]: ClientAction.BACK_TO_LOBBY,
  /** 货币核心（⚙️11）+ 金币场（⚙️10）：14001–14004 映射**既有** TOAST（文案走 `message`），不新增枚举值。 */
  [ErrCode.E_INSUFFICIENT_FUNDS]: ClientAction.TOAST,
  [ErrCode.E_ACTION_CONFLICT]: ClientAction.TOAST,
  [ErrCode.E_ENTRY_THRESHOLD]: ClientAction.TOAST,
  [ErrCode.E_RELIEF_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.E_CARD_COUNTER_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.E_CARD_COUNTER_PRICE_CHANGED]: ClientAction.TOAST,
  [ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT]: ClientAction.TOAST,
  /** 支付片（⚙️9）：15001–15006、15008、15009 → 既有 TOAST（文案走 `message`）；**15007 → IGNORE**（服务端内部面，且入 `RESERVED_CODES`）。 */
  [ErrCode.PAY_CHANNEL_ERROR]: ClientAction.TOAST,
  [ErrCode.PAY_ORDER_NOT_FOUND]: ClientAction.TOAST,
  [ErrCode.PAY_WITHDRAW_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.PAY_WITHDRAW_LIMIT]: ClientAction.TOAST,
  [ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]: ClientAction.TOAST,
  [ErrCode.PAY_REFUND_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.PAY_NOTIFY_VERIFY_FAILED]: ClientAction.IGNORE,
  [ErrCode.PAY_DISABLED]: ClientAction.TOAST,
  [ErrCode.PAY_STATE_CONFLICT]: ClientAction.TOAST,
};

/** 该错误码是否属于「可安全重试/忽略」的类别 */
export function isBenign(code: ErrCode): boolean {
  return CLIENT_ACTION[code] === ClientAction.IGNORE;
}

/**
 * **保留不用**的错误码。它们存在于表中以保持编号连续与对外兼容，
 * 但**当前没有任何触发路径**——服务端不会返回它们。
 *
 * 用途：让「保留」这件事变成机器可校验的，而不是只写在文档的一句注释里。
 * `test/errors.test.ts` 会断言这个集合与规格一致。
 */
export const RESERVED_CODES: readonly ErrCode[] = [
  /** 超出操作时间限制。玩法 §9 规定超时是服务端内部自动行为，不向客户端返回错误码。 */
  ErrCode.ACTION_TIMEOUT,
  /** 机器人决策超时。内部事件码，由 game-service 记日志与指标，不作为响应码。 */
  ErrCode.BOT_DECISION_TIMEOUT,
  /** 回调验签失败。内部事件码，由 payment-service 记日志与指标（`payment_notify_total{result="bad_sign"}`），不作为响应码。 */
  ErrCode.PAY_NOTIFY_VERIFY_FAILED,
] as const;

/** 该错误码是否为内部/保留码（不应出现在任何客户端可见的响应里） */
export function isReserved(code: ErrCode): boolean {
  return RESERVED_CODES.includes(code);
}
