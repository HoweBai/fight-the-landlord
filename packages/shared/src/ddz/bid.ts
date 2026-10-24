import { GameState, GameSession } from './types';
import { compareCards, dealCards } from './game';

/**
 * 叫抢倍数上限（玩法 §3.1）。
 *
 * **必须显式写出上限**：它是「**一轮最多 4 次声称**」这一前提的机械表达
 * （片① R2 起允许**一次**反抢 ⇒ 决策数上界 4；反抢那一抢**同样 ×2**、每次声称**无条件**
 * `min(m * 2, 8)`，但**任何路径都不越过 8**）。数值 **8 不变** ⇒ `bidMultiplier ∈ {1, 2, 4, 8}`。
 * 将来若允许**多轮**反抢（>1 次），第一个要改的就是这里。⚠️ 清洗轮订正（2026-09-30）：原句「第 4 次因 cap 不再加分」有误（只对「前 3 拍已 3 次声称」成立），结论不变。
 */
export const BID_MULTIPLIER_CAP = 8;

/**
 * 协议 ③ 的**唯一**派生实现（`view.builder` 直接用它，**不得**各自实现一份）。
 *
 * 依据是「本轮**是否已有人声称**」（`landlordCandidate`），**不是** `grabActions`：
 * 第一家「不叫」之后第二家仍然是**叫地主**（本轮还没有人声称），而
 * `grabActions === 0` 会让第二家被错报成「抢」。
 *
 * ⚠️ 这是**本仓一轮制**（片① R2 起：每名玩家至多决策两次 —— 首次叫者可被派发一次反抢）
 * 下的语义映射，不是普适规则。
 */
export function bidKindOf(
  phase: Pick<GameSession['bidPhase'], 'landlordCandidate'>,
): 'call' | 'rob' {
  return phase.landlordCandidate === -1 ? 'call' : 'rob';
}

/**
 * `random` 是**可注入的随机源**（照 `createSession` / `BotPlayer.random` 的既有范式）：
 * 它决定 ① 第 3 次流局时随机指定的地主、② 流局重发后的起始座位（片① R1）。
 * 默认 `Math.random` ⇒ 生产行为不变；测试传常量函数获得确定性
 * （⚠️ 一次调用**恒消费 0 或 1 个**随机数 —— 收口判据的两个分支互斥且各自 `return`）。
 *
 * 🔴 `random` 的**值域契约是 `[0, 1)`**：上面两处都直接 `Math.floor(random() * 3)`
 * （与 `createSession` 同款公式），**无 clamp、无报错** —— 传 `() => 1` 会**静默**
 * 给出座位 3（越界 ⇒ 房间停摆，只在日志留痕）。
 */
export function handleBid(
  session: GameSession,
  playerId: string,
  bid: boolean,
  random: () => number = Math.random,
): GameSession {
  const playerIdx = session.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }
  if (session.state !== GameState.Bidding) {
    throw new Error('Game is not in bidding state');
  }
  if (playerIdx !== session.bidPhase.currentBidder) {
    throw new Error('Not your turn to bid');
  }

  const newPhase = { ...session.bidPhase };
  /**
   * 协议 ⑦：**就地**算出这次决策的措辞依据（`kind` 按**决策那一刻**的
   * `landlordCandidate` 算，而不是事后回推）—— 回推会让「第一家不叫、第二家叫」
   * 错报成「抢」。
   */
  const decisionKind = bidKindOf(session.bidPhase);
  // 玩法 §3.1：**每完成一次决策都 +1**（「抢」与「不抢」都计入）—— 这是判定轮次结束的唯一计数器。
  newPhase.grabActions++;

  if (bid) {
    // landlordCaller 是历史字段（保留形状）；landlordCandidate 才是「谁是地主」的真源。
    newPhase.landlordCaller = playerIdx;
    newPhase.landlordCandidate = playerIdx;
    // 片① R2（规格 §2）：`firstCaller` 只记**第一条**声称 —— 「反抢权」的判据是
    // `landlordCandidate !== firstCaller`（§4.1），该判据靠「只记第一次」才成立。
    if (newPhase.firstCaller === -1) newPhase.firstCaller = playerIdx;
    newPhase.bidMultiplier = Math.min(newPhase.bidMultiplier * 2, BID_MULTIPLIER_CAP);
  } else {
    newPhase.bidPasses++;
  }

  // 唯一的 currentBidder **推进点**：`(playerIdx + 1) % 3` 只出现在这里 —— 反抢帧（①）
  // 显式赋值为 `firstCaller`、流局重发由 `resetBidding` **覆盖**，两者都不经过它。
  // ⚠️ R104 的「`resetBidding` 覆盖为 0」已由片① R1 作废（重发改为重摇，见 `resetBidding`）。
  newPhase.currentBidder = (playerIdx + 1) % 3;

  newPhase.decisions = [...(session.bidPhase.decisions ?? []), {
    seat: playerIdx,
    kind: decisionKind,
    grab: bid,
  }];

  /**
   * 片① R2 ①：**派发反抢**（本轮一次性）。见规格 §4.2。
   *
   * 触发条件 = 「走满 3 次决策」**且**「≥2 人声称」（后者由
   * `landlordCandidate !== firstCaller` 一个比较表达：全不叫时两者都是 -1 相等，
   * 单人声称时两者相等；≥2 人时末位与首位必不同）。
   *
   * 🔴 **行动者必须显式赋值**，**不得**复用上一行的 `(playerIdx + 1) % 3`：
   * 3 次决策恰好走完一个座位循环 ⇒ 那个公式**恒等于「首个决策者」**，而它**不是**
   * 「首个声称者」（#4 的不叫/叫/叫 即反例）。而 `handleBid` 只校验
   * `playerIdx === currentBidder` ⇒ 指错人时**规则违规静默通过、连错误码都没有**。
   */
  if (
    !newPhase.antiRobGranted &&
    newPhase.grabActions === 3 &&
    newPhase.landlordCandidate !== newPhase.firstCaller
  ) {
    newPhase.antiRobGranted = true;
    newPhase.currentBidder = newPhase.firstCaller;
    return { ...session, bidPhase: newPhase, version: session.version + 1 };
  }

  /**
   * 片① R2 ②：**收口**。
   *
   * 🔴 判据必须对**决策计数单调**（`antiRobGranted ? 4 : 3`）—— 若写成
   * `grabActions >= 3 && landlordCandidate !== firstCaller`，反抢者一「不抢」
   * 该条件仍为真 ⇒ 行动者被反复指回同一人 ⇒ **叫抢永不结束**。
   */
  if (newPhase.grabActions >= (newPhase.antiRobGranted ? 4 : 3)) {
    if (newPhase.landlordCandidate !== -1) {
      return finalizeBidding({ ...session, bidPhase: newPhase }, newPhase.landlordCandidate);
    }
    // 三家全不抢 → 流局（此处 `antiRobGranted` 必为 false：全不叫 ⇒ 两人都是 -1 ⇒ 不派发）
    newPhase.redealCount++;
    if (newPhase.redealCount >= 3) {
      // 第 3 次流局不再重发，随机指定一名地主（倍数已归位为 1）
      const randomIdx = Math.floor(random() * 3);
      return finalizeBidding({ ...session, bidPhase: newPhase }, randomIdx);
    }
    return resetBidding({ ...session, bidPhase: newPhase }, random);
  }

  return { ...session, bidPhase: newPhase, version: session.version + 1 };
}

/**
 * 地主确定 → 进入出牌阶段（玩法 §3.4 的 9 条在**同一次状态转移**里完成）。
 *
 * R101：底牌并入地主手牌**就在这里**，它是唯一真源；game-service 的
 * `view.builder` 与 robot-service 的 `bot.player` 的两处补偿**必须同时删除**，
 * 否则地主/机器人视角会变成 23 张。
 */
function finalizeBidding(session: GameSession, landlordIdx: number): GameSession {
  const players = session.players.map((p, idx) => {
    if (idx !== landlordIdx) return { ...p, isLandlord: false };
    // §3.4-2：`landlord.hand = sort([...landlord.hand, ...bottomCards])`（DouZero 编码）
    return {
      ...p,
      isLandlord: true,
      hand: [...p.hand, ...session.bottomCards].sort(compareCards),
    };
  });

  return {
    ...session,
    players,
    state: GameState.Playing,
    currentPlayer: landlordIdx,
    lastPlayerIdx: -1, // §3.4-7：地主首出不受跟牌约束
    lastPlayedHand: null,
    bidPhase: {
      // §3.4-3 / R105：两条路径（有人抢 / 随机指定）都必须把 candidate 落定 ——
      // 它是「谁是地主」的唯一来源，客户端与机器人都只能读它。
      ...session.bidPhase,
      landlordCandidate: landlordIdx,
    },
    // §3.4-5：bottomCards **保留不清空**（可见性裁剪依赖它）
    version: session.version + 1, // §3.4-8
    // §3.2/R205：新一局从**空的** `actionLog` 开始（叫抢阶段没有任何出牌）
    actionLog: [],
  };
}

/**
 * 流局（玩法 §3.3）：**必须重新洗牌发牌**，而不是沿用原手牌重开叫抢。
 *
 * R102：发牌的唯一实现是 `game.ts` 的 `dealCards()`，这里**复用**它，
 * 绝不重新实现洗牌/发牌（那会立刻产生第二个真相源）。
 * `dealCards` 负责：洗牌、17/17/17、3 张底牌、`state = bidding`、`version + 1`。
 *
 * 🔴 **R104 已由片① R1 作废**：流局后**不再回到座位 0**，起始座位与 `createSession`
 * 一样由注入的 `random` 摇定。这里是**覆盖**而非推进这一点不变。
 */
function resetBidding(session: GameSession, random: () => number): GameSession {
  const redealt = dealCards(session);
  return {
    ...redealt,
    // §3.2/R205：流局重新发牌 ⇒ 上一轮的出牌历史**必须清空**（`dealCards` 会原样带过来）
    actionLog: [],
    bidPhase: {
      // 片① R1：流局重发是**新的一轮** ⇒ 起始座位**重新摇**（不再一律回座位 0 —— R104 作废）
      currentBidder: Math.floor(random() * 3),
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      // redealCount 跨轮累计（玩法 §3.2 要点 3）
      redealCount: session.bidPhase.redealCount,
      // §3.3：流局重发是**新的一轮** ⇒ 上一轮的决策记录必须清空
      decisions: [],
      // 片①：两个新字段同为「新的一轮」的状态 ⇒ 与 decisions 一起重置
      firstCaller: -1,
      antiRobGranted: false,
    },
  };
}
