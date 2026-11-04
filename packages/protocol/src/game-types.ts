/**
 * 玩法 id 的**叶子真源**（审查 P2-5）。
 *
 * 为什么单独成文件：`game.ts` 以**值**导入 `validate.ts` 的 `ProtocolError`；
 * 若 `validate.ts` 反向导入 `game.ts` 的 `GAME_TYPES` 就成运行时环（CJS 下
 * 顶层 `const` 会拿到未初始化值）。本文件**零 import**，两个方向都能安全引用。
 *
 * 新增玩法只改这里 + `GAME_META`（`Record<GameType, GameMeta>` 会强制补元数据）；
 * `validate.ts` 自动跟随，不会再出现“validate 拒绝新玩法”的双真源漂移。
 */
export const GAME_TYPES = ['doudizhu', 'paodekuai', 'mahjong'] as const;

export type GameType = (typeof GAME_TYPES)[number];

export const DEFAULT_GAME_TYPE: GameType = 'doudizhu';

export function isGameType(value: unknown): value is GameType {
  return typeof value === 'string' && (GAME_TYPES as readonly string[]).includes(value);
}
