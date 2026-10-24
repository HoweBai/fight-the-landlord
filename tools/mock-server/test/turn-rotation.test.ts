/**
 * 一墩结束后的轮转（玩法 §6.2-5：`currentPlayer` 回到**最后出牌者**）。
 *
 * 为什么单独立一条（2026-09-28 评审修复的判别力自证）：协议 ④（`33c2e5f`）曾把 `pass()` 里的
 * 「最后出牌者」改从 `recentActions` 窗口反推 —— 该写法**恒**退化：触发一墩结束的
 * `passCount[seat] >= 2`（同一家连过两次，其间**不可能**有出牌）保证窗口 2 个槽全是「不出」
 * ⇒ 反推结果恒为 -1 ⇒ 每一次一墩结束时都退化为「停在本家」，与旧行为（出牌权交回最后出牌者）
 * **恒不同**。本用例按真实轮转（座位 0 出牌 → 三家各过一次 → 第一家第二次过 ⇒ 一墩结束）
 * 钉住「出牌权回到座位 0」——旧窗口反推写法在这条用例下给 1（= 本家）。
 */
import { describe, expect, it } from 'vitest';
import { ScriptedGame } from '../src/scripted-game';

/** 座位 0 是 mock 固定的地主；底牌并入后手里有 `3♠`（出一张即可，不判牌型）。 */
function startedGame(): ScriptedGame {
  const game = new ScriptedGame(['p0', 'p1', 'p2']);
  game.deal();
  game.bid(0, true); // 座位 0 抢 ⇒ 地主、底牌并入 ⇒ 20 张、state=playing
  return game;
}

describe('mock 轮转：一墩结束 ⇒ 出牌权回到**最后出牌者**（玩法 §6.2-5）', () => {
  it('座位 0 出牌、三家各过一墩后第一家第二次过 ⇒ 一墩结束，出牌权回座位 0', () => {
    const game = startedGame();
    game.play(0, [{ r: 3, s: 0 }]); // 单张 3；此后窗口里只剩「不出」
    expect(game.getCurrentSeat()).toBe(1);

    game.pass(1); // 1 过 ⇒ 2
    game.pass(2); // 2 过 ⇒ 0
    game.pass(0); // 0 过 ⇒ 1
    expect(game.getCurrentSeat(), '同一家还没连过两次 ⇒ 一墩未结束').toBe(1);

    const afterTrick = game.pass(1); // 1 第二次过 ⇒ 一墩结束

    // 判别点：此刻窗口 2 槽**全是「不出」**（从窗口反推必给 -1）。
    expect(afterTrick.currentSeat, '出牌权回到最后出牌者（座位 0）').toBe(0);
    expect(game.getCurrentSeat()).toBe(0);
    // 窗口**保持不动**（仍是出站投影）：最后两条 = 座位 0 / 座位 1 的两次「不出」。
    expect(afterTrick.seatViews[2]!.recentActions).toEqual([
      { seat: 0, cards: null },
      { seat: 1, cards: null },
    ]);
  });
});
