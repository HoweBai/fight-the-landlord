/**
 * 结算类型联合（多玩法片）。
 *
 * - 斗地主：`DdzSettlementResult` **旧 9 键不变**（不加 gameType/scoreChanges）。
 * - 跑得快：`PdkSettlementResult`（SettlementVector + 剩余张数/倍数/关牌/春天/保本）。
 * - 判别：`isPdkSettlementResult()`（`'gameType' in r && r.gameType === 'paodekuai'`）。
 */
import type { DdzSettlementResult } from './views';
import type { PdkSettlementResult } from './pdk/types';

export type SettlementResult = DdzSettlementResult | PdkSettlementResult;

export function isPdkSettlementResult(r: SettlementResult): r is PdkSettlementResult {
  return 'gameType' in r && r.gameType === 'paodekuai';
}
