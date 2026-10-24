// packages/game-service/src/game/view.builder.ts
import {
  validateOutbound,
  type PlayerView,
  type ServerMessage,
} from '@fight-the-landlord/protocol';
// R472：`GameSession` 的形状（含必填的 `turnDeadlineAt`）唯一定义在 shared，
// 旧的 game-service 模块增强 `./game.types` 已整体删除。
import { GameState, bidKindOf, projectRecentActions, type GameSession } from '@fight-the-landlord/shared';

/**
 * 一回合的时长（玩法 §9.2：各阶段 30s）。
 */
export const TURN_TIMEOUT_MS = 30_000;

/** 三家座位号。 */
export const SEATS: readonly [0, 1, 2] = [0, 1, 2];

/**
 * 在 `GameSession.players` 中按身份定位座位；找不到返回 -1（§5.3 身份映射）。
 *
 * 多玩法（S4）：只依赖 `id` ⇒ 参数放宽为结构类型，ddz 的 `GamePlayer[]` 与
 * pdk 的 `PdkPlayer[]` 共用同一实现（全仓仍只有这一处座位解析）。
 */
export function findSeatByUserId(
  session: { players: ReadonlyArray<{ id: string }> },
  userId: string,
): number {
  return session.players.findIndex((p) => p.id === userId);
}

/**
 * `PlayerView.seat` 的范围守卫。
 *
 * 这不是形式主义：`cardCounts[seat]` 必须存在，否则下游会读到 `undefined`
 * 而裁剪校验只看到 `NaN`——越界座位必须当场拒绝，不能靠巧合。
 */
function assertSeat(seat: number): void {
  if (!Number.isInteger(seat) || seat < 0 || seat > 2) {
    throw new Error(`seat must be 0, 1 or 2, got ${String(seat)}`);
  }
}

/**
 * 把服务端内部 `GameSession` 裁剪成**接收者视角**的 `PlayerView`（§6.4）。
 *
 * 这是唯一的出站对局类型来源。裁剪规则：
 *  - 只有接收者自己的 `hand` 是明文；
 *  - 他人手牌只以 `cardCounts[seat]` 的张数形式出现；
 *  - `actionLog` / `isRobot` / `botId` / `skillLevel` / `thinkingSpeed` 一律不出现（`validateOutbound` 机械保证）；
 *  - 底牌在叫抢阶段恒为 `null`，`playing` 之后三家皆可见（§6.4 表）。
 *
 * 返回值已通过 `validateOutbound` 的包装消息校验 —— 契约违规在服务端当场抛错，
 * 而不是变成客户端上一个莫名其妙的 UI 故障。
 */
export function buildPlayerView(session: GameSession, seat: number): PlayerView {
  assertSeat(seat);

  const players = session.players;
  const bottomCardsVisible = session.state !== GameState.Bidding && session.state !== GameState.Init;
  const landlord = players.find((p) => p.isLandlord && p.seat >= 0 && p.seat <= 2);

  const candidate = session.bidPhase?.landlordCandidate ?? -1;
  const landlordSeat =
    landlord !== undefined
      ? landlord.seat
      : candidate >= 0 && candidate <= 2
        ? candidate
        : null;

  // ⚠️ 这里**不得**并入底牌（R101）：底牌由 `shared/ddz/bid.ts` 的 `finalizeBidding()`
  // 在状态转移里并进地主手牌，是唯一真源。此处若再并入，地主会拿到 23 张；
  // `protocol/src/validate.ts` 的 `hand.length === cardCounts[seat]` 会被**人为**满足，掩盖真实张数。
  // 播放阶段 `bottomCards` 仍然照发（§6.4：三家皆可见），但它是「展示用副本」，不是手牌来源。
  const hand = players[seat]?.hand ?? [];
  const cardCounts: [number, number, number] = [
    players[0]?.hand.length ?? 0,
    players[1]?.hand.length ?? 0,
    players[2]?.hand.length ?? 0,
  ];
  // 挂机治理 T3（规格 C5 / C23 的 view 半边）：按座位的托管态（徽标数据面）。
  // ⚠️ 这是 `trustees` 的**唯一生产写入点**。机器人判定按 `botIds` 的**座位下标**
  // （⛔ 不按 `p.id` —— 那是对外 displayId，与内部 botId 恒不相等）；机器人座位恒 false。
  const trustees = session.players.map((p, i) =>
    session.botIds?.[i] !== undefined ? false : p.trustee === true,
  ) as [boolean, boolean, boolean];

  const view: PlayerView = {
    roomCode: session.roomCode,
    version: session.version,
    state: session.state,
    baseScore: session.baseScore,
    seat,
    hand,
    cardCounts,
    trustees,
    bottomCards: bottomCardsVisible ? session.bottomCards : null,
    landlordSeat,
    currentPlayer: session.currentPlayer,
    // ⚠️ **这里不再是原样透传**（协议 ④ 起）：`recentActions` 是 `actionLog` 的**投影**
    // （`shared/ddz/recent.ts` 是唯一实现）。规则的跟牌目标仍由服务端内部的
    // `session.lastPlayedHand` 持有，**不出站**。
    recentActions: projectRecentActions(session),
    // R472：`turnDeadlineAt` 在 §3.2 / shared 里是**必填**数字 ⇒ 原样透传
    // （此前是可选的模块增强，才需要 `?? 0` 兜底）。
    turnDeadlineAt: session.turnDeadlineAt,
    bidPhase: {
      currentBidder: session.bidPhase?.currentBidder ?? 0,
      bidMultiplier: session.bidPhase?.bidMultiplier ?? 1,
      landlordCandidate: session.bidPhase?.landlordCandidate ?? -1,
      grabActions: session.bidPhase?.grabActions ?? 0,
      redealCount: session.bidPhase?.redealCount ?? 0,
      // 协议 ③：kind 是**派生**出来的（一处实现：shared 的 bidKindOf）
      kind: bidKindOf(session.bidPhase ?? { landlordCandidate: -1 }),
      // 协议 ⑦：原样透传（内部形状就是契约形状）
      decisions: session.bidPhase?.decisions ?? [],
    },
    playPhase: { bombCount: session.playPhase?.bombCount ?? 0 },
  };

  if (session.winner) view.winner = session.winner;

  // 机械地拦住越界出站（§6.4 / §4.2）。消息类型只是为了复用契约校验器。
  validateOutbound({ type: 'game.state_update', version: view.version, payload: view });
  return view;
}

/** 为三家各生成一份裁剪视图（§4.4：room-service 只按 seat 投递，不做业务判断）。 */
export function buildAllSeatViews(session: GameSession): PlayerView[] {
  return SEATS.map((seat) => buildPlayerView(session, seat));
}

/** 出站前的最后一道闸门：任何 S→C 消息都必须先过契约校验。 */
export function outbound<T extends ServerMessage['type']>(
  type: T,
  version: number,
  payload: unknown,
): ServerMessage {
  return validateOutbound({ type, version, payload });
}

/** 计算本回合的剩余时长，供 `game.current_turn` 使用（§6.3）。 */
export function remainingTurnMs(session: GameSession, now = Date.now()): number {
  const deadline = session.turnDeadlineAt;
  if (!deadline) return TURN_TIMEOUT_MS;
  return Math.max(0, deadline - now);
}
