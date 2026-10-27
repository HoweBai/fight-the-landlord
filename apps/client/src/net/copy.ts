/**
 * 面向玩家的**统一文案表**（玩家提示收敛与浮层化 · Task 1）。
 *
 * 三张表 + 一条取值链（`playerMessage`）：
 *  - `FIXED_COPY`：**固定文案**（服务端 message 不参与；同步/限流/牌局结论等）。
 *  - `FALLBACK_COPY`：**message-first**（服务端 message 可用则优先，空则落本表兜底）。
 *  - `IGNORE_WITH_COPY`：处置 = IGNORE 但仍有一句提示的码（如 12003）。
 *
 * 分区不变量（`copy-coverage.test.ts` 机械校验）：
 *  - `IGNORED` 由协议 `CLIENT_ACTION` 派生（处置 = IGNORE 的全部码）；
 *  - 其余每个码**恰好**落在 `FIXED` 或 `MESSAGE_FIRST` 之一（不得重叠、不得遗漏）。
 *
 * 未知码：中性化（「操作未成功，请稍后重试」），**不再把码带给玩家**；
 * 排查靠 `net/errors.ts` 的 `reportUnknownCode`（每会话每码只报一次）。
 * diag 构建（VITE_PLAYER_DIAG=1）才在中性文案后附 code。
 *
 * ⚠️ 本模块是**纯查表**：只 import protocol；不做规则判定、不 import store/页面。
 */
import { CLIENT_ACTION, ClientAction, ErrCode, RESERVED_CODES } from '@fight-the-landlord/protocol';

export type CopyContext = 'auth' | 'action' | 'rest' | 'warning';

export interface PlayerMessageOptions {
  context: CopyContext;
  label?: string;
  serverMessage?: string;
}

const FIXED_COPY: Partial<Record<number, string>> = {
  [ErrCode.UNAUTHENTICATED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_EXPIRED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_INVALID]: '登录状态已失效，请重新登录',
  [ErrCode.RATE_LIMITED]: '操作太频繁，请稍后再试',
  [ErrCode.UPSTREAM_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
  [ErrCode.CLIENT_DISABLED]: '当前客户端已暂停服务，请稍后再试或更换客户端',
  [ErrCode.USER_BANNED]: '该账号已被封禁，如有异议请联系客服',
  [ErrCode.ROOM_NOT_FOUND]: '房间不存在',
  [ErrCode.ROOM_FULL]: '房间已满',
  [ErrCode.NOT_IN_ROOM]: '你不在这个房间里',
  [ErrCode.KICK_FORBIDDEN]: '没有权限进行该操作',
  [ErrCode.FRIEND_ROOM_FAILED]: '好友房创建/加入失败，请稍后重试',
  [ErrCode.MATCH_TIMEOUT]: '当前无匹配的玩家',
  [ErrCode.ROOM_ALREADY_STARTED]: '房间已经开始，无法加入',
  [ErrCode.ALREADY_IN_GAME]: '你还有未结束的对局或房间',
  [ErrCode.ILLEGAL_ACTION]: '服务端判定这手牌不合法，换一手再试',
  [ErrCode.VERSION_CONFLICT]: '牌局状态有更新，正在同步…',
  [ErrCode.GAME_OVER]: '本局已经结束',
  [ErrCode.INVALID_CARDS]: '选中的牌无法组成合法牌型（服务端判定）',
  [ErrCode.ACTION_TIMEOUT]: '这一步超时了，已由服务端处理',
  [ErrCode.GAME_NOT_STARTED]: '本局还没开始',
  [ErrCode.RECONNECT_RECORD_MISSING]: '没有可恢复的对局',
};

const FALLBACK_COPY: Partial<Record<number, string>> = {
  [ErrCode.BAD_PARAM]: '请检查填写的内容',
  [ErrCode.FORBIDDEN]: '没有权限进行该操作',
  [ErrCode.PHONE_TAKEN]: '这个手机号已经注册过了，直接登录吧',
  [ErrCode.BAD_CREDENTIALS]: '手机号或密码不正确',
  [ErrCode.USER_NOT_FOUND]: '该账号不存在，请先注册',
  [ErrCode.DEVICE_MISMATCH]: '账号已绑定其他设备，如需在本机使用请联系管理员解绑',
  [ErrCode.AGENT_INVITE_INVALID]: '邀请码无效，请确认后重试',
  [ErrCode.AGENT_FROZEN]: '当前账号已被暂停，请联系管理员',
  [ErrCode.ROOM_MODE_DISABLED]: '该场次暂未开放',
  /** 12012 改为 message-first：服务端的「玩法未开放 / 暂不支持该人数」都直接可见。 */
  [ErrCode.GAME_UNAVAILABLE]: '这个玩法暂未开放，请稍后再试',
  [ErrCode.E_INSUFFICIENT_FUNDS]: '操作未成功，请稍后重试',
  [ErrCode.E_ACTION_CONFLICT]: '操作未成功，请稍后重试',
  [ErrCode.E_ENTRY_THRESHOLD]: '金币不足，无法进入该场次',
  [ErrCode.E_RELIEF_UNAVAILABLE]: '救助暂不可用，请稍后重试',
  [ErrCode.E_CARD_COUNTER_UNAVAILABLE]: '记牌器暂未开放',
  [ErrCode.E_CARD_COUNTER_PRICE_CHANGED]: '价格已更新，请重新确认后购买',
  [ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT]: '请求号冲突，请重新购买',
  [ErrCode.AGENT_SETTLEMENT_MIN]: '暂未达到结算条件',
  [ErrCode.AGENT_SETTLEMENT_PENDING]: '已有待处理的结算单，请稍后再试',
  [ErrCode.AGENT_SETTLEMENT_STATE]: '结算状态已变化，请刷新后重试',
  [ErrCode.AGENT_RATE_INVALID]: '分成比例或层级设置不合法',
  [ErrCode.PAY_CHANNEL_ERROR]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_ORDER_NOT_FOUND]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAW_UNAVAILABLE]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAW_LIMIT]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_REFUND_UNAVAILABLE]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_DISABLED]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_STATE_CONFLICT]: '支付暂时不可用，请稍后重试',
};

const IGNORE_WITH_COPY: Partial<Record<number, string>> = {
  [ErrCode.NOT_YOUR_TURN]: '现在还没轮到你',
};

const ALL_CODES = Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number');

export const IGNORED_CODES = new Set<number>(
  ALL_CODES.filter((code) => CLIENT_ACTION[code] === ClientAction.IGNORE),
);
export const FIXED_CODES = new Set<number>(Object.keys(FIXED_COPY).map(Number));
export const MESSAGE_FIRST_CODES = new Set<number>(Object.keys(FALLBACK_COPY).map(Number));
export const IGNORE_WITH_COPY_CODES = new Set<number>(Object.keys(IGNORE_WITH_COPY).map(Number));

export const COPY_SETS = {
  IGNORED: IGNORED_CODES,
  FIXED: FIXED_CODES,
  MESSAGE_FIRST: MESSAGE_FIRST_CODES,
  IGNORE_WITH_COPY: IGNORE_WITH_COPY_CODES,
  RESERVED: new Set<number>([...RESERVED_CODES]),
};

export function isPlayerDiag(): boolean {
  return import.meta.env.VITE_PLAYER_DIAG === '1';
}

function neutral(code: number): string {
  const base = '操作未成功，请稍后重试';
  return isPlayerDiag() ? `${base}（code=${code}）` : base;
}

function fallbackFor(code: number, context: CopyContext): string {
  if (code === ErrCode.BAD_PARAM) {
    return context === 'action' ? '请检查操作内容' : '请检查填写的内容';
  }
  return FALLBACK_COPY[code] ?? neutral(code);
}

export function playerMessage(code: number, opts: PlayerMessageOptions): string {
  if (code === ErrCode.OK) return '';
  if (opts.context === 'warning') {
    return opts.serverMessage || '请注意，牌局状态有变化';
  }
  if (MESSAGE_FIRST_CODES.has(code)) {
    return opts.serverMessage || fallbackFor(code, opts.context);
  }
  const fixed = FIXED_COPY[code];
  if (fixed) return fixed;
  if (IGNORED_CODES.has(code)) return '';
  return neutral(code);
}

export function authErrorMessage(code: number, _label: string): string {
  return playerMessage(code, { context: 'auth' });
}

export function actionErrorMessage(code: number): string {
  if (code === ErrCode.OK) return '';
  return playerMessage(code, { context: 'action' });
}

export function actionCopyFor(code: number): string | null {
  return FIXED_COPY[code] ?? IGNORE_WITH_COPY[code] ?? null;
}
