/**
 * 跑得快 runtime（Task 4.1 / spec §4.3）。
 *
 * 与 DdzRuntime 同构：本类只把 `shared/pdk/*` 纯函数与 pdk 视图/记录投影接到
 * `GameRuntime` 接口上，**不重写任何规则**（牌型/比较/结算全在 shared/protocol）。
 *
 * 关键口径：
 *  - `create`：`parsePdkRules` 合并默认值后作为**本局快照**（D19）；机器人内部字段按座位；
 *  - `applyAction`：`game.bid` ⇒ 13001（跑得快没有叫抢；spec §5.8）；
 *  - `onTimeout` / `autoAction`：与超时/托管/bot 共用 `shared/pdk/autoplay`；
 *  - `buildView`：`unusedCards`/`lastPlayedHand`/他人手牌永不出站；
 *  - `buildRecord`：16/12 张手牌、`playedCount`、2 人局 `unusedCards`、无底牌。
 */
import {
  GAME_META,
  encodeCards,
  encodeHand,
  type GameType,
  type GameView,
  type SettlementResult,
} from '@fight-the-landlord/protocol';
import {
  buildPdkFeatures,
  chooseLeadPdk,
  createPdkSession,
  findSmallestBeatingPdk,
  finishPdk,
  handlePdkPass,
  handlePdkPlay,
  handlePdkTimeout,
  isPdkFinished,
  parsePdkRules,
  settlePdk,
  turnDurationFor,
  type GameAction,
  type GovernanceDurations,
  type PdkSession,
} from '@fight-the-landlord/shared';
import type {
  CreateGameInput,
  GameRobotInput,
  GameRuntime,
  PdkRecordEnvelope,
  RuntimeCtx,
  Transition,
} from '../runtime';
import { buildAllPdkViews, buildPdkPlayerView } from './view';

/** 跑得快没有叫抢：收到 `game.bid` 必须给 13001（spec §5.8）。 */
const BID_REJECTED = 'paodekuai does not support game.bid';

/**
 * `seed` 的确定性随机源（mulberry32；仅内部测试钩子，`game.start` 已在入口门控）。
 * 同 seed ⇒ 同洗牌/同首出兜底；生产走 `Math.random`。
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class PdkRuntime implements GameRuntime<PdkSession> {
  readonly gameType: GameType = 'paodekuai';
  readonly meta = GAME_META.paodekuai;

  create(input: CreateGameInput): PdkSession {
    if (input.gameType !== 'paodekuai') {
      throw new Error(`PdkRuntime.create requires gameType=paodekuai, got ${input.gameType}`);
    }
    const playerCount = input.playerCount;
    if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
      throw new Error(`pdk requires playerCount 2 | 3 | 4, got ${String(playerCount)}`);
    }
    // 规则快照：合并默认值 + 严格校验（未知键/非法枚举 ⇒ ProtocolError，不静默降级）。
    const rules = parsePdkRules(input.rules);
    const ordered = [...input.players].sort((a, b) => a.seat - b.seat);
    const session = createPdkSession({
      roomCode: input.roomCode,
      playerCount,
      baseScore: input.baseScore,
      rules,
      players: ordered.map((p) => ({ id: p.id, seat: p.seat, isBot: p.isRobot })),
      // 测试钩子：seed ⇒ 确定性随机源（同 seed 同手牌）；否则用注入的 `random`。
      random: input.seed === undefined ? input.random : seededRandom(input.seed),
      testDeck: input.testDeck,
    });
    // 机器人内部字段（永不出站；与 ddz 同口径，按座位索引）。
    session.botIds = ordered.map((p) => (p.isRobot ? p.botId : undefined));
    session.botSkillLevels = ordered.map((p) => (p.isRobot ? p.skillLevel : undefined));
    session.botThinkingSpeeds = ordered.map((p) => (p.isRobot ? p.thinkingSpeed : undefined));
    return session;
  }

  applyAction(
    session: PdkSession,
    action: GameAction,
    ctx: RuntimeCtx,
  ): Transition<PdkSession> {
    const player = session.players.find((p) => p.seat === ctx.actorSeat);
    if (!player) throw new Error(`Player at seat ${ctx.actorSeat} not found`);
    if (action.kind === 'bid') throw new Error(BID_REJECTED);

    const updated =
      action.kind === 'play'
        ? handlePdkPlay(session, player.id, action.cards)
        : handlePdkPass(session, player.id);
    return { session: updated, ended: isPdkFinished(updated) };
  }

  onTimeout(session: PdkSession, _ctx: RuntimeCtx): Transition<PdkSession> {
    // `handlePdkTimeout` 以 `session.currentPlayer` 为准，并使用本局规则快照。
    const updated = handlePdkTimeout(session);
    return { session: updated, ended: isPdkFinished(updated) };
  }

  isFinished(session: PdkSession): boolean {
    return isPdkFinished(session);
  }

  finish(session: PdkSession, now: number): PdkSession {
    return finishPdk(session, now);
  }

  settle(session: PdkSession): SettlementResult {
    return settlePdk(session);
  }

  buildView(session: PdkSession, seat: number): GameView {
    return buildPdkPlayerView(session, seat);
  }

  buildAllViews(session: PdkSession): GameView[] {
    return buildAllPdkViews(session);
  }

  buildRobotInput(session: PdkSession, seat: number): GameRobotInput {
    return {
      view: buildPdkPlayerView(session, seat),
      features: buildPdkFeatures(session, seat),
    };
  }

  buildRecord(session: PdkSession): PdkRecordEnvelope | undefined {
    const initialHands = session.initialHands;
    if (!initialHands) return undefined;
    try {
      const perSeat = session.playerCount === 4 ? 12 : 16;
      return {
        startedAt: session.createdAt,
        seats: [...session.players]
          .sort((a, b) => a.seat - b.seat)
          .map((p) => {
            const hand = initialHands[p.seat];
            if (!hand) throw new Error(`pdk session is missing an initial hand at seat ${p.seat}`);
            return {
              seat: p.seat,
              playerId: p.id,
              hand: encodeHand(hand, perSeat),
              playedCount: p.playedCount,
            };
          }),
        // 2 人局扣牌：仅审计（D43），客户端任何接口都不返回。
        ...(session.unusedCards ? { unusedCards: encodeCards(session.unusedCards, 16) } : {}),
        gameType: 'paodekuai',
        playerCount: session.playerCount,
      };
    } catch {
      // 与 ddz 同口径：记录面绝不因编码失败阻断终局发布。
      return undefined;
    }
  }

  currentActor(session: PdkSession): number {
    return session.currentPlayer;
  }

  timerPhase(_session: PdkSession): 'bid' | 'play' {
    return 'play';
  }

  turnDuration(session: PdkSession, seat: number, policy: GovernanceDurations): number {
    const player = session.players.find((p) => p.seat === seat);
    if (!player) throw new Error(`Player at seat ${seat} not found`);
    return turnDurationFor(player, policy);
  }

  autoAction(session: PdkSession, seat: number): GameAction {
    const player = session.players.find((p) => p.seat === seat);
    if (!player) throw new Error(`Player at seat ${seat} not found`);
    // 首出（或自己就是最后出牌者）⇒ 必须出牌；跟牌 ⇒ 最小可压，无解则过。
    const mustLead = session.lastPlayedHand === null || session.lastPlayerIdx === seat;
    if (!mustLead) {
      const beating = findSmallestBeatingPdk(player.hand, session.lastPlayedHand!, session.rules);
      return beating !== null && beating.length > 0
        ? { kind: 'play', cards: beating }
        : { kind: 'pass' };
    }
    const lead = chooseLeadPdk(player.hand, session.rules);
    if (lead.length === 0) throw new Error(`Player ${player.id} has no card to play`);
    return { kind: 'play', cards: lead };
  }
}

/** 导出给测试/诊断：`game.bid` 的拒绝文案（映射表按文本分类）。 */
export const PDK_BID_REJECTED_MESSAGE = BID_REJECTED;
