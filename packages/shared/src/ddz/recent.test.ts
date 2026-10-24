import { describe, it, expect } from 'vitest';
import { handlePlayCards, handlePass } from './play';
import { dealCards, createSession } from './game';
// ⚠️ `GameState` 在 `./types`（`game.ts` 不 re-export 它；计划原文从 './game' 取值 = 运行期 undefined）
import { GameState, type GameSession } from './types';
import type { Card } from '@fight-the-landlord/protocol';
import { projectRecentActions, RECENT_ACTIONS_WINDOW } from './recent';

const c = (r: number): Card => ({ r, s: 0 });

/** 让三家进入出牌阶段（座位 0 当地主）：直接构造一个 playing 会话。 */
function playingSession(): GameSession {
  const s = dealCards(createSession('ROOM1', ['u0', 'u1', 'u2']));
  return {
    ...s,
    state: GameState.Playing,
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    actionLog: [],
    /**
     * ⚠️ **发牌是随机的**（`shuffleDeck` 用 `Math.random`），而下面的用例按**具体牌值**出牌
     *（`c(3)` / `c(4)` / `c(5)`）—— 照 `dealCards` 的随机手牌跑，只有「恰好拿到 `3♠`」时才过
     *（≈ 17/54）。判据必须**确定性**，所以这里把三家手牌钉死：
     * u0 出 3；u1 出 4（不变量②里还要出 5）；u2 只过牌。
     */
    players: [
      { ...s.players[0]!, hand: [c(3), c(7)] },
      { ...s.players[1]!, hand: [c(4), c(5), c(8)] },
      { ...s.players[2]!, hand: [c(6), c(9)] },
    ],
  };
}

describe('projectRecentActions（协议 ④ / 上位 §4.4）', () => {
  /**
   * 🔴 **用户逐字确认的那三行**（上位 §4.4）—— 逐字变成用例：
   *   `A出3 → [3]` · `B出4 → [3,4]` · `C不出 → [4, 不出]`
   */
  it('用户逐字确认的语义：A出3 → [3] · B出4 → [3,4] · C不出 → [4, 不出]', () => {
    let s = playingSession();

    s = handlePlayCards(s, 'u0', [c(3)]);
    expect(projectRecentActions(s)).toEqual([{ seat: 0, cards: [c(3)] }]);

    s = handlePlayCards(s, 'u1', [c(4)]);
    expect(projectRecentActions(s)).toEqual([
      { seat: 0, cards: [c(3)] },
      { seat: 1, cards: [c(4)] },
    ]);

    s = handlePass(s, 'u2');
    expect(projectRecentActions(s)).toEqual([
      { seat: 1, cards: [c(4)] },
      { seat: 2, cards: null }, // 「不出」也占一手，且是显式的 null
    ]);
  });

  it('窗口恒 ≤ 2，且是**最后两条**动作（旧的被挤掉）', () => {
    let s = playingSession();
    s = handlePlayCards(s, 'u0', [c(3)]);
    s = handlePlayCards(s, 'u1', [c(4)]);
    s = handlePlayCards(s, 'u2', [c(6)]);
    const w = projectRecentActions(s);
    expect(w).toHaveLength(RECENT_ACTIONS_WINDOW);
    expect(w.map((a) => a.seat)).toEqual([1, 2]);
  });

  /** 不变式①：窗口两项**都是 null** ⟺ 上一次动作是使一墩结束的那次过牌。 */
  it('不变式①：两家连续过牌后窗口全是 null（一墩结束）', () => {
    let s = playingSession();
    s = handlePlayCards(s, 'u0', [c(3)]);
    s = handlePass(s, 'u1');
    s = handlePass(s, 'u2'); // 第二家过牌 ⇒ 一墩结束
    expect(projectRecentActions(s)).toEqual([
      { seat: 1, cards: null },
      { seat: 2, cards: null },
    ]);
    expect(s.lastPlayedHand).toBeNull();
  });

  /**
   * 🔴 不变式②（**真浏览器探针的依赖项**）：
   *   「窗口里有非 null」 ⟺ `lastPlayedHand !== null`
   *
   * 它是一条**导出性质**、不是规格条文 ⇒ 一旦不成立，探针的 `canPass` 会**静默走错分支**
   * （表现为 30 秒超时，而不是红）。所以必须在这里钉死。
   */
  it('不变式②：窗口里有非 null ⟺ lastPlayedHand !== null（穷举一局的每个中间态）', () => {
    const steps: Array<(s: ReturnType<typeof playingSession>) => ReturnType<typeof playingSession>> = [
      (s) => handlePlayCards(s, 'u0', [c(3)]),
      (s) => handlePlayCards(s, 'u1', [c(4)]),
      (s) => handlePass(s, 'u2'),
      (s) => handlePass(s, 'u0'), // 两家连续过牌 ⇒ 一墩结束
      (s) => handlePlayCards(s, 'u1', [c(5)]), // 墩首（lastPlayerIdx === 1）
      (s) => handlePass(s, 'u2'),
    ];
    let s = playingSession();
    const check1 = () => {
      const hasNonNull = projectRecentActions(s).some((a) => a.cards !== null);
      expect(hasNonNull, `v${s.version}：窗口非空 ⟺ lastPlayedHand 非空`).toBe(s.lastPlayedHand !== null);
    };
    check1(); // 开局：两边都「空」
    for (const step of steps) {
      s = step(s);
      check1();
    }
  });
});
