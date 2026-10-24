/**
 * mock 结算载荷的**规格对齐**判据（切片 10 / R192）。
 *
 * 为什么单独立一条：`tools/mock-server` 是结算的**第二真源**（前端联调与
 * `apps/client/test/mock-e2e.test.ts` 都照着它写），而它此前把倍数写成
 * `bombCount + 1`（加法、且整条丢掉叫抢倍数）。第二条真源错着，前端就会
 * 照着错的数写用例 —— 这正是切片 10 里 C1 的镜像缺陷。
 *
 * ⚠️ 夹具必须让 `bombCount = 2`：`bombCount = 1` 时加法（`1 + 1 = 2`）与
 * 乘法（`2 × 2^1 = 4`）**碰巧**不同，但旧实现丢掉 `bidMultiplier` 之后
 * `bombCount = 0` 也会被误判 —— 只有 `bombCount = 2` 这一条同时钉住
 * 「炸弹是乘法因子」与「叫抢倍数不能丢」（旧实现给 3，新实现给 8）。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import { ScriptedGame } from '../src/scripted-game';

/**
 * 按「每个点数从花色 0 起依次取用」造牌。
 *
 * ⚠️ **必须跨调用累积**，不能每次重置：`ScriptedGame` 的手牌里每个点数都有全部四张
 * （`fullDeck()` 是每个 `r` push `s = 0..3`），而这些用例会把同一花色的四张
 * **拆到好几手**里打完（`[5,5,5]` 之后还有 `[5]`）。若每次调用都从 `s = 0` 重新开始，
 * 第二手就会重复送已经打出去的那张 ⇒ 被精确摘除拒掉。
 */
function dealer() {
  const used = new Map<number, number>();
  return (...ranks: number[]): Card[] =>
    ranks.map((r) => {
      const s = used.get(r) ?? 0;
      used.set(r, s + 1);
      return { r, s };
    });
}

/** 座位 0 是 mock 固定的地主；底牌 `[3,3,3]` 并入后手里是 `[3×4, 4×4, 5×4, 6×4, 7×4]`。 */
function startedGame(): ScriptedGame {
  const game = new ScriptedGame(['p0', 'p1', 'p2']);
  game.deal();
  game.bid(0, true); // 座位 0 抢 ⇒ 地主、底牌并入 ⇒ 20 张、state=playing
  return game;
}

describe('mock 结算（玩法 §8.2/§8.4/§8.5）', () => {
  it('倍数 = bidMultiplier × 2^bombCount（炸弹是**乘法**因子，R192）', () => {
    const game = startedGame();
    const c = dealer();
    game.play(0, c(3, 3, 3, 3)); // 炸弹 1
    const afterSecondBomb = game.play(0, c(4, 4, 4, 4)); // 炸弹 2
    expect(afterSecondBomb.settled).toBeNull(); // 还剩 [5×4, 6×4, 7×4] ⇒ 未结束

    // 剩下的 12 张用**每一手都 <4 张**的方式打完 ⇒ 不再累加炸弹数
    let last = afterSecondBomb;
    for (const chunk of [
      [5, 5, 5],
      [6, 6, 6],
      [7, 7, 7],
      [5, 6, 7],
    ]) {
      last = game.play(0, c(...chunk));
    }

    expect(last.settled).not.toBeNull();
    const settlement = last.settled!;
    expect(settlement.multiplier).toBe(8); // 2(叫抢) × 2^2(两炸) × 1(无春天)；旧实现给 3
    expect(settlement.spring).toBe('none'); // mock 不统计地主/农民出牌手数 ⇒ 不承担春天
    expect(Object.keys(settlement).sort()).toEqual(
      [
        'baseScore',
        'farmerScoreChange',
        'farmerSeats',
        'landlordScoreChange',
        'landlordSeat',
        'multiplier',
        'roomCode',
        'spring',
        'winner',
      ].sort(),
    );
  });

  it('分数变动按 §8.4 且守恒（地主胜：±单家得失 ×2 / ∓单家得失）', () => {
    const game = startedGame();
    const c = dealer();
    game.play(0, c(3, 3, 3, 3)); // 炸弹 1（此后每一手都 <4 张）
    let last = game.play(0, c(4));
    for (const chunk of [
      [5, 5, 5],
      [5],
      [6, 6, 6],
      [6],
      [7],
      [7],
      [7],
      [4, 4, 4],
      [7],
    ]) {
      last = game.play(0, c(...chunk));
    }
    const s = last.settled!;
    expect(s.winner).toBe('landlord');
    expect(s.multiplier).toBe(4); // 2 × 2^1
    expect(s.landlordScoreChange).toBe(s.baseScore * s.multiplier * 2);
    expect(s.farmerScoreChange).toBe(-s.baseScore * s.multiplier);
    expect(s.landlordScoreChange + s.farmerScoreChange * s.farmerSeats.length).toBe(0);
  });
});
