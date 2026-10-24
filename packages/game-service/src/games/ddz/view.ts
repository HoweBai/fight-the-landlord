/**
 * 斗地主视图投影（S1 迁移占位）：实现在既有 `game/view.builder.ts`。
 * 本文件只做 re-export，保证 runtime 侧有稳定的 `games/ddz/view` 入口。
 */
export {
  SEATS,
  TURN_TIMEOUT_MS,
  buildAllSeatViews,
  buildPlayerView,
  findSeatByUserId,
  outbound,
  remainingTurnMs,
} from '../../game/view.builder';
