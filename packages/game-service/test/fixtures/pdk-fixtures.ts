/**
 * 跑得快 game-service 测试夹具（Task 4.2）。
 *
 * `fullGameDeck()` 是一副**确定性 48 张**牌堆：
 *  - seat0 持红桃 3（首出者）+ 3..A 的 12 张顺子 + 三张 4 + 红桃 2；
 *  - 余下 32 张里**没有 4、没有任何四条**（座位 1/2 既压不过 A 高顺子、也没有炸弹）。
 * 因此「12 张顺子 → 三张 4 → 单张 2」是一条可复现的完整出牌序列。
 */
import type { Card } from '@fight-the-landlord/protocol';
import { createPdkDeck } from '@fight-the-landlord/shared';

export const card = (r: number, s: number): Card => ({ r, s });
export const keyOf = (c: Card): string => `${c.r},${c.s}`;

export function fullGameDeck(): Card[] {
  const seat0: Card[] = [
    card(3, 1), // 红桃 3（首出者）
    card(4, 2),
    card(5, 2),
    card(6, 2),
    card(7, 2),
    card(8, 2),
    card(9, 2),
    card(10, 2),
    card(11, 2),
    card(12, 2),
    card(13, 2),
    card(14, 2), // 3..A 的 12 张顺子
    card(4, 1),
    card(4, 3),
    card(4, 0), // 三张 4
    card(17, 1), // 红桃 2（唯一的一张 2）
  ];
  const used = new Set(seat0.map(keyOf));
  const rest = createPdkDeck().filter((c) => !used.has(keyOf(c)));
  if (seat0.length !== 16 || rest.length !== 32) throw new Error('fixture deck must be 48 cards');
  return [...seat0, ...rest];
}

/** 3 人 pdk 玩家 DTO（seat0 人类；需要机器人座位时用 `over.robotSeats`）。 */
export function pdkPlayers(
  robotSeats: readonly number[] = [],
): Array<{
  id: string;
  seat: number;
  isRobot: boolean;
  botId?: string;
  skillLevel?: 'beginner';
  thinkingSpeed?: number;
}> {
  return [0, 1, 2].map((seat) => {
    const isRobot = robotSeats.includes(seat);
    return {
      id: `p${seat}`,
      seat,
      isRobot,
      ...(isRobot
        ? { botId: `bot-${seat}`, skillLevel: 'beginner' as const, thinkingSpeed: 1200 }
        : {}),
    };
  });
}
