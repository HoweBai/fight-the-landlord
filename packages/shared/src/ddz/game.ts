import type { Card } from '@fight-the-landlord/protocol';
import { createDeck, shuffleDeck } from '../card/card';
import { GameState, GameSession, GamePlayer } from './types';

/**
 * 建立会话。`random` 是**可注入的随机源**（照 `BotPlayer.random` 的既有范式），
 * 默认 `Math.random` ⇒ 生产行为不变，测试可传常量函数获得确定性。
 *
 * 🔴 2026-10-21 起**不再有代码缺省底分**：`baseScore` 由唯一生产调用方
 * `game-service` 的 `game.start` 显式传入（room-service 从档位表推导）。
 * 省略时留 `0` 哨兵 —— 出站视图校验（`validateOutbound`，要求 > 0）与
 * `settleGame` 的正整数守卫会把它变成响亮失败，绝不会静默按 0 结算。
 *
 * 🔴 `random` 的**值域契约是 `[0, 1)`**：起始座位直接由 `Math.floor(random() * 3)`
 * 取（`handleBid` 的摇座位/摇地主用的是同一个公式），**无 clamp、无报错** ——
 * 传 `() => 1` 会**静默**给出座位 3（越界 ⇒ 房间停摆，只在日志留痕）。
 *
 * ⚠️ 片① R1：它决定**叫抢的起始座位**（不再是写死的 0）。`dealCards` 会**保留**
 * 这个值（它只重置 `bidPhase` 之外的东西；见 `dealCards` 的实现），所以在这里摇一次即可。
 */
export function createSession(
  roomCode: string,
  playerIds: string[],
  random: () => number = Math.random,
  baseScore = 0,
): GameSession {
  const players: GamePlayer[] = playerIds.map((id, seat) => ({
    id,
    seat,
    hand: [],
    isLandlord: false,
    isBot: false,
    isOffline: false,
    // 挂机治理量初始值（r1 阻断 2）：新会话同样必须显式初始化，
    // 不能只靠「旧会话迁移」兜底（缺字段会让 timeoutCount+1 = NaN）。
    timeoutCount: 0,
    trustee: false,
  }));

  return {
    roomCode,
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore,
    state: GameState.Init,
    players,
    bottomCards: [],
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    version: 0,
    actionLog: [],
    bidPhase: {
      currentBidder: Math.floor(random() * 3),
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      redealCount: 0,
      decisions: [],
      firstCaller: -1,
      antiRobGranted: false,
    },
    playPhase: {
      bombCount: 0,
      landlordPlays: 0,
      farmerPlays: 0,
      consecutivePasses: 0,
    },
    // §3.2 / R472：`turnDeadlineAt` 是**必填**的毫秒时间戳。本构造函数产出的是
    // `state = init` 的空会话（尚无回合）⇒ 占位 0；真正的截止时刻由 game-service
    // 在 `game.start`（以及每次**回合**转移）按行动者治理档写入（挂机治理片起；
    // 治理态变更不算回合转移）。
    turnDeadlineAt: 0,
    createdAt: Date.now(),
    finishedAt: null,
  };
}

/**
 * 手牌的规范排序：先点数（DouZero 编码，`2` = 17 天然排在 A 之后），再花色。
 *
 * **唯一实现** —— `bid.ts` 的「底牌并入地主手牌」（R101）共用它，
 * 两处各写一份比较器会产生两套顺序，而顺序是会进 `PlayerView.hand` 的。
 */
export const compareCards = (a: Card, b: Card): number => a.r - b.r || a.s - b.s;

export function dealCards(session: GameSession): GameSession {
  const deck = createDeck();
  shuffleDeck(deck);

  // 花色**真实地**进入系统：`createDeck()` 产出的每张牌都带自己的 `s`，
  // 这里**不转换、不编造**（R696 之前这里要把 Card 压成 int，花色即在此丢失）。
  const bottomCards: Card[] = deck.slice(0, 3);
  const hands: Card[][] = [[], [], []];

  for (let i = 0; i < 17; i++) {
    hands[0]!.push(deck[i + 3]!);
    hands[1]!.push(deck[i + 20]!);
    hands[2]!.push(deck[i + 37]!);
  }

  const players = session.players.map((player, idx) => ({
    ...player,
    hand: [...hands[idx]!].sort(compareCards),
  }));

  return {
    ...session,
    bottomCards,
    players,
    // 记录片 T2：发牌快照（冻结副本）——在 `players` 的**排序之后**切片写入
    //（types.ts `GameSession.initialHands`），与 `players[].hand` 不共享数组引用
    //（后续出牌 `splice` 摘除 / 底牌并入后的重排序都改不到它）。
    // 流局重发（bid.ts:185）会再次调用本函数 ⇒ 快照自然被**覆盖**为新发牌。
    initialHands: players.map((p) => [...p.hand]),
    state: GameState.Bidding,
    version: session.version + 1,
  };
}
