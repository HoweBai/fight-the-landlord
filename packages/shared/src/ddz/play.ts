import type { Card } from '@fight-the-landlord/protocol';
import { GameSession } from './types';
import { GameState } from './types';
import { Rank } from '../card/card';
import { parseHand, canBeat, HandType, type BeatTarget } from '../rule/rule';
import { findSmallestBeatingCards } from '../rule/autoplay';

// ⚠️ 本文件原有的 `douzeroIntToCard()` 已删除（R695/R696）：
// 它存在的唯一理由是「DouZero 编码不区分花色，所以要**编造**一个花色」。
// 牌形状改成 `{r, s}` 之后，手牌与上一手牌**本来就是** `Card[]`，
// 没有任何 int 需要适配 —— 留着它只能编造花色，而那会被 R697 的身份精确摘除拒掉。
// 同理删除的还有 `cardToInt`（在 `./game`）与 `toInternalRank` / `RANK_2` 等
// 旧编码的转换符号（在 `@fight-the-landlord/protocol`）。

export function handlePlayCards(session: GameSession, playerId: string, cards: Card[]): GameSession {
  const playerIdx = session.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }
  if (session.state !== GameState.Playing) {
    throw new Error('Game is not in playing state');
  }
  if (playerIdx !== session.currentPlayer) {
    throw new Error('Not your turn');
  }

  /**
   * R697：按身份**精确摘除** —— 逐个在行动者手里找 `(r, s)` **完全相等**的牌并移除；
   * 任一找不到即拒。
   *
   * ⚠️ **不得退化成「按点数摘」**（旧实现是 `handRanks.indexOf(int)`）。按点数摘会让两种
   * 本质不同的输入无法区分：送两张同点数不同花色（合法）与送两张**完全相同**的牌
   * （手里只有一张，**本应被拒**）—— 两者在点数口径下都「找得到两张」。
   *
   * ⚠️ 文案**必须保留 `not in hand`**：`rule-error.mapping.ts` 的
   * `/not in hand/i → ILLEGAL_ACTION` 是这张表的一行，而 `rule-error-mapping.test.ts`
   * 的覆盖闸要求每一处 `throw` 都有映射。改掉这句会同时打红两处。
   */
  const hand = [...session.players[playerIdx]!.hand];
  for (const card of cards) {
    const idx = hand.findIndex(h => h.r === card.r && h.s === card.s);
    if (idx === -1) {
      throw new Error(`Card ${card.r}-${card.s} not in hand`);
    }
    hand.splice(idx, 1);
  }

  // 判定（R158 的「进入判定前一律还原为内部 Rank」在 R695 之后**不再需要**：
  // 全系统只有 DouZero 一套编码，`cards` 拿来即可判定）
  const playedHand = parseHand(cards);

  /**
   * R203/C6：**非法牌型的拒绝责任在调用方**（玩法 §4.3 ⇒ `13006`）。
   *
   * `parseHand` 现在返回类型化的 `HandType.Invalid` 而不再抛错（那让
   * `rule/autoplay.ts` 的 Invalid 分支从此成为**活代码**），
   * 因此这里必须**显式**拒绝，否则非法牌型会一路走到 `canBeat` 并被判成
   * 「压不过上一手」——错误码与文案都会错（§11.1 逐因映射）。
   *
   * ⚠️ **文案逐字保持** `不支持的牌型: …`：N2 的覆盖闸与 `SPEC_ROWS` 规格闸都靠它
   * 映射到 `13006 INVALID_CARDS`，改一个字两张闸同时变红。
   */
  if (playedHand.type === HandType.Invalid) {
    // R696：`cards` 是 `Card[]` ⇒ 报点数，别让它 stringify 成 `[object Object]`
    throw new Error(`不支持的牌型: ${cards.map((c) => c.r).join(',')}`);
  }

  // Validate against last played hand（R157：**只**读持久化字段，禁止重新解析 cards 反推）
  if (session.lastPlayedHand && session.lastPlayerIdx !== playerIdx) {
    const last: BeatTarget = session.lastPlayedHand;
    if (!canBeat(playedHand, last)) {
      throw new Error('Invalid move - cannot beat last hand');
    }
  }

  /**
   * 出牌后的手牌 —— **就是上面那次精确摘除的结果**（`hand`），不重新摘一遍。
   *
   * ⚠️ **这里曾经有第二个摘除循环**，写的是 `newHand.indexOf(card)`：
   * `Card` 是对象，`indexOf` 做的是**引用相等**，而调用方传进来的 `cards`
   * 通常是**新构造**的对象 ⇒ 恒返回 `-1` ⇒ **牌从来没被摘掉**：
   * 手牌不减、胜负不判、终局视图不发。
   *
   * `indexOf` 用在 `Card[]` 上是**合法的 TypeScript** —— `tsc` 不报、既有闸不报，
   * 只有行为判据（`game.service.test.ts` 的 N17 终局视图）能抓。
   * 两个循环合成一个，这个形态就**结构上不可能**再出现。
   */
  const players = session.players.map((p, idx) =>
    idx === playerIdx ? { ...p, hand } : p
  );

  // Update phase stats
  const isBomb = playedHand.type === HandType.Bomb || playedHand.type === HandType.Rocket;
  const newPlayPhase = {
    ...session.playPhase,
    bombCount: session.playPhase.bombCount + (isBomb ? 1 : 0),
    landlordPlays: session.players[playerIdx].isLandlord ? session.playPhase.landlordPlays + 1 : session.playPhase.landlordPlays,
    farmerPlays: !session.players[playerIdx].isLandlord ? session.playPhase.farmerPlays + 1 : session.playPhase.farmerPlays,
    consecutivePasses: 0,
  };

  const next: GameSession = {
    ...session,
    players,
    lastPlayedHand: {
      cards,
      type: playedHand.type,
      keyRank: playedHand.keyRank,
      length: playedHand.length,
    },
    lastPlayerIdx: playerIdx,
    currentPlayer: (playerIdx + 1) % 3,
    playPhase: newPlayPhase,
    version: session.version + 1,
    // §3.2：**每次**状态转移都追加一条（`cards` 为打出的牌，DouZero 编码）。
    // 这是 `actionLog` 的**唯一**写入点之一（另一处是 `handlePass`）。⚠️ 永不出站。
    actionLog: [
      ...(session.actionLog ?? []),
      { version: session.version + 1, seat: playerIdx, cards: [...cards], kind: 'play' as const },
    ],
  };
  assertPlayInvariants(next);
  return next;
}

export function handlePass(session: GameSession, playerId: string): GameSession {
  const playerIdx = session.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }
  if (session.state !== GameState.Playing) {
    throw new Error('Game is not in playing state');
  }
  if (playerIdx !== session.currentPlayer) {
    throw new Error('Not your turn');
  }
  // §6.2-2（C18）：首出（无人出过牌）时**任何人**都不能过牌。
  // 第 2、3 条缺一不可：只有第 3 条时，开局 lastPlayerIdx === -1 会让约束对所有人失效，
  // 一旦两家过牌就会写出 currentPlayer = lastPlayerIdx = -1 ⇒ 对局永久卡死（实测形态）。
  if (session.lastPlayedHand === null) {
    throw new Error('Cannot pass on the opening lead');
  }
  // §6.2-3：最后出牌者不能过牌（修好不变式 1 之后这是**冗余的纵深防御**，不得删除）。
  if (session.lastPlayerIdx === playerIdx) {
    throw new Error('Cannot pass when you last played');
  }

  const newConsecutivePasses = session.playPhase.consecutivePasses + 1;

  // §3.2：过牌同样是一次状态转移，`kind: 'pass'` 且 `cards` 为空
  const passEntry = { version: session.version + 1, seat: playerIdx, cards: [], kind: 'pass' as const };

  // If 2 consecutive passes, current player gets turn again
  if (newConsecutivePasses >= 2) {
    const next: GameSession = {
      ...session,
      lastPlayedHand: null,
      // Keep lastPlayerIdx as the player who last played a hand (not the passer)
      currentPlayer: session.lastPlayerIdx,
      playPhase: { ...session.playPhase, consecutivePasses: 0 },
      version: session.version + 1,
      actionLog: [...(session.actionLog ?? []), passEntry],
    };
    assertPlayInvariants(next);
    return next;
  }

  const next: GameSession = {
    ...session,
    currentPlayer: (playerIdx + 1) % 3,
    playPhase: { ...session.playPhase, consecutivePasses: newConsecutivePasses },
    version: session.version + 1,
    actionLog: [...(session.actionLog ?? []), passEntry],
  };
  assertPlayInvariants(next);
  return next;
}

// Check if player has won (no cards left)
export function checkWinCondition(session: GameSession): 'landlord' | 'farmer' | null {
  const landlord = session.players.find(p => p.isLandlord);
  const farmers = session.players.filter(p => !p.isLandlord);

  if (landlord?.hand.length === 0) return 'landlord';
  // §7：农民是团队 —— **任一**农民出完牌即农民方获胜（C16；旧实现写成了 every）。
  if (farmers.some(p => p.hand.length === 0)) return 'farmer';
  return null;
}

/**
 * 玩法 §6.3 的状态不变式 1–3，在**每次状态转移之后、返回之前**校验（R160）。
 *
 * 第 4 条（某玩家手牌为 0 ⇒ 对局已结束）**刻意不在这里**：手牌归零的那一瞬间
 * `state` 仍是 `playing`，置 `ended` 由 game-service 的 `finishTransition` 在同一次
 * 转移里完成 —— 在这里断言它必然误报。
 */
export function assertPlayInvariants(session: GameSession): void {
  if (session.lastPlayedHand !== null && session.currentPlayer === session.lastPlayerIdx) {
    throw new Error(
      'invariant violated: lastPlayedHand !== null requires currentPlayer !== lastPlayerIdx',
    );
  }
  if (!Number.isInteger(session.currentPlayer) || session.currentPlayer < 0 || session.currentPlayer > 2) {
    throw new Error(`invariant violated: currentPlayer must be 0/1/2, got ${String(session.currentPlayer)}`);
  }
  if (session.lastPlayedHand === null && session.playPhase.consecutivePasses !== 0) {
    throw new Error('invariant violated: lastPlayedHand === null requires consecutivePasses === 0');
  }
}

/**
 * 玩法 §9.1「出牌阶段超时」的**逐字四步**实现（C5 收口，R204 修正版）。
 *
 * 规格原文（`docs/games/doudizhu.md` §9.1）：
 * ```
 * 若 lastPlayedHand !== null（跟牌）:
 *     ① 尝试同牌型、同 length 的【最小】可压牌（带牌取手中点数最小的合法组合）
 *     ② 若 last 不是王炸：再尝试【最小】炸弹
 *     ③ 若 last 不是王炸：再尝试王炸
 *     ④ 均无 → 过牌
 * 否则（首出）: 打出【手牌中点数最小的单张】
 * ```
 *
 * ①②③ **就是** `rule/autoplay.ts` 的 `findSmallestBeatingCards()`（Task 1 的唯一实现）：
 * 它先同型最小可压、再更大的炸弹、再王炸，且面对王炸返回 `null`。这里**不得**再写第二份。
 * ⇒ 「能过牌就过牌」是**白送回合的旧行为**，本函数不再有这条捷径。
 *
 * ⚠️ 跟牌分支里 `handlePass` 一定合法：§6.3 不变式 1 保证
 * 「`lastPlayedHand !== null` ⇒ `currentPlayer !== lastPlayerIdx`」，而行动者就是
 * `currentPlayer`（game-service 的 `onTurnTimeout` 按座位取人）⇒ 不会踩到
 * `Cannot pass when you last played`。
 *
 * ⚠️ 进出判定一律还原为内部 Rank（R158）：手牌是 DouZero 编码，引擎吃 `Card`。
 */
export function handlePlayTimeout(session: GameSession, playerId: string): GameSession {
  const playerIdx = session.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }

  const hand = session.players[playerIdx]!.hand;
  if (hand.length === 0) {
    // 不可能状态（手牌为 0 时对局应当已结束）：**必须抛错**，让 game.service 的 catch
    // 记 error + 重挂计时器，而不是静默吞掉（R106）。
    throw new Error(`Player ${playerId} has no card to play`);
  }

  // 超时路径直接在**真手牌**上选牌 ⇒ 天然带真花色，**不转换、不回填**（spec §4 的 ②）
  const engineHand = hand;

  // 跟牌（§9.1 ①②③④）：目标就是持久化的上一手牌（只有 `type`/`keyRank`/`length`，
  // 因此引擎的入参类型放宽为 `ParsedHand | BeatTarget` —— 超时路径拿不到别人的 `cards`）。
  if (session.lastPlayedHand !== null) {
    const beating = findSmallestBeatingCards(engineHand, session.lastPlayedHand);
    // 有解（同型最小可压 / 最小炸弹 / 王炸）⇒ 采用；④ 均无 ⇒ 过牌
    if (beating && beating.length > 0) {
      return handlePlayCards(session, playerId, beating);
    }
    return handlePass(session, playerId);
  }

  // 首出（`lastPlayedHand === null`）：`HandType.Invalid` 目标 ⇒ 手牌中**点数最小**的单张
  // （引擎 Invalid 分支的语义正是「首出 / 一墩回到自己」，E4/R202-3）。
  const smallest = findSmallestBeatingCards(engineHand, {
    type: HandType.Invalid,
    keyRank: 0 as Rank,
    length: 0,
  });
  if (!smallest || smallest.length === 0) {
    // 手牌非空 ⇒ 引擎必然有解（最小单张）。走到这里说明引擎与「手牌非空」不一致，
    // 属于内部前置被打破：抛错让 game.service 走 R106 的 catch（记 error + 重挂）。
    throw new Error(`Player ${playerId} has no card to play`);
  }
  return handlePlayCards(session, playerId, smallest);
}
