import type { Counter, Gauge } from 'prom-client';
import { isGameType, type GameType } from '@fight-the-landlord/protocol';

/** 指标边界的玩法归一：合法值原样；缺省/空串/未知一律斗地主（有界标签）。 */
export function normalizeGameType(value: unknown): GameType {
  return isGameType(value) ? value : 'doudizhu';
}

export function gameLabel(value: unknown): { game_type: GameType } {
  return { game_type: normalizeGameType(value) };
}

/** 强制带 game_type 的 counter.inc；调用方无法覆盖归一后的 game_type。 */
export function incGame<T extends string>(
  counter: Counter<T>,
  gameType: unknown,
  amount = 1,
  labels: Partial<Record<T, string | number>> = {},
): void {
  const values = { ...labels, game_type: normalizeGameType(gameType) };
  (counter as Counter<string>).inc(values, amount);
}

/** 强制带 game_type 的 gauge.set。 */
export function setGame<T extends string>(
  gauge: Gauge<T>,
  gameType: unknown,
  value: number,
): void {
  const values = { game_type: normalizeGameType(gameType) };
  (gauge as Gauge<string>).set(values, value);
}
