/**
 * 一张牌的身份指纹：单副牌下 `(r,s)` 唯一（王的 s=4，r=20/30）。
 *
 * 手牌稳定 key、记牌器、手牌变更检测共用这一处，避免三份 `${r}-${s}` 漂移。
 */
export function cardKey(card: { r: number; s: number }): string {
  return `${card.r}-${card.s}`;
}
