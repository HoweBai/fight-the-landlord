/**
 * 规则函数已迁至 `@fight-the-landlord/protocol`（2026-10-12，客户端出牌提示项 ⑤ 裁决）。
 *
 * 这里**只做重导出**，保持后端既有 `import { parseHand } from '@fight-the-landlord/shared'`
 * 与深路径 `import ... from '../rule/rule'` 不失效。
 *
 * 类型差异：`ParsedHand.keyRank` / `HandAnalysis.counts` 的点数类型从 `Rank`（枚举）
 * 放宽为 `number`（DouZero 编码）。`Rank` 枚举值本身就是这些数字 ⇒ 赋值兼容，
 * 既有调用点无需改动。
 */
export {
  HandType,
  handTypeNames,
  type ParsedHand,
  type HandAnalysis,
  type BeatTarget,
  isContinuous,
  analyzeCards,
  parseHand,
  canBeat,
} from '@fight-the-landlord/protocol';
