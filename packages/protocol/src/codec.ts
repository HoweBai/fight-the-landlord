/**
 * 牌值编码的唯一真源。
 *
 * **全系统只有一套编码：DouZero**（R695）。`2` 在所有层都是 `17`。
 *
 * 历史上存在第二套「内部 Rank」（`2` = 15）与两个转换函数
 * `toInternalRank()` / `toDouZero()`——它们正是 C19「同点数的 2 互相压过」
 * 那个缺陷的成因（待出牌把 DouZero 当 `Rank`、待跟牌却还原成 `Rank2`）。
 * R695 之后，**没有「还原」这一步可以忘**。
 *
 * 大小序与玩法 §1.2 同构：`3 < 4 < … < 14 < 17 < 20 < 30`
 * （顺子判定只发生在 3–14 区间，该区间新旧编码完全相同）。
 *
 * 禁止在任何其它位置重复实现本映射——历史上它曾分散在三处，
 * 直接导致过两次「修复卡牌值映射bug」的提交。
 */

/** DouZero 编码里的 2 —— **全系统唯一的 2** */
export const DOUZERO_2 = 17;
/** 小王 */
export const RANK_BLACK_JOKER = 20;
/** 大王 */
export const RANK_RED_JOKER = 30;

/** DouZero 编码 → 牌面文字（前端展示用，不含任何规则判断） */
export function toDisplay(douzeroInt: number): string {
  if (douzeroInt === RANK_BLACK_JOKER) return '小王';
  if (douzeroInt === RANK_RED_JOKER) return '大王';
  if (douzeroInt === DOUZERO_2) return '2';
  if (douzeroInt === 14) return 'A';
  if (douzeroInt === 13) return 'K';
  if (douzeroInt === 12) return 'Q';
  if (douzeroInt === 11) return 'J';
  return String(douzeroInt);
}

/** 花色 → 符号（0♠ 1♥ 2♣ 3♦ 4王）。**只做展示**，不含任何规则判断。 */
export function suitSymbol(s: number): string {
  return ['♠', '♥', '♣', '♦', ''][s] ?? '';
}

/**
 * 牌的显示颜色。**只做展示**。
 *
 * ⚠️ 参数是**整张牌**而不是 `s`：两张王的 `s` **都是 4**，光看花色分不出大小王，
 * 必须读 `r`（小王 20 黑 / 大王 30 红）。
 */
export function colorOf(card: { r: number; s: number }): 'red' | 'black' {
  if (card.r === RANK_RED_JOKER) return 'red';
  if (card.r === RANK_BLACK_JOKER) return 'black';
  return card.s === 1 || card.s === 3 ? 'red' : 'black';
}

/** 校验一个整数是否为合法的 DouZero 牌值 */
export function isValidDouZeroCard(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  if (v >= 3 && v <= 14) return true;
  return v === DOUZERO_2 || v === RANK_BLACK_JOKER || v === RANK_RED_JOKER;
}
