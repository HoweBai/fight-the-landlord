// packages/game-service/src/game/rule-error.mapping.ts
import { ErrCode } from '@fight-the-landlord/protocol';

export interface RuleErrorMapping {
  /** 匹配规则引擎抛出的**原始文本**（§11.4 的别名表：规则引擎抛字符串，偏差 E5）。 */
  readonly pattern: RegExp;
  readonly code: ErrCode;
  /** 这条映射的规格依据（给评审与机械闸读；机械闸见 test/rule-error-mapping.test.ts）。 */
  readonly basis: string;
}

/**
 * 规则引擎错误 → 契约错误码的**唯一**映射表（N2 的「映射可枚举」）。
 *
 * **顺序即优先级**：越权/阶段判定必须排在牌型判定之前（§5.3），否则会把
 * 「不在你的回合」误判成「出牌不合法」。
 *
 * ⚠️ 每一行都有 `docs/games/doudizhu.md` §11.1 的逐因依据；新增 `throw` 时
 * **必须**在这里同步加一行，否则 `rule-error-mapping.test.ts` 的覆盖闸会红。
 * ⚠️ 规则源自 2026-10-12（项 ⑤）起有**两处**：`shared/src/{ddz,rule}` 与
 * `protocol/src/rule.ts`（牌型规则迁入 protocol）—— 覆盖闸两处都扫（2026-10-13 补）。
 * ⚠️ 别把「不是牌型错误」的文本写宽：`/not in hand/i` 与 `/cannot beat/i` 的方向
 * 在 N16 里被纠正过（前者 13001、后者 13006），改宽会一次性打回两条。
 */
export const RULE_ERROR_MAPPINGS: readonly RuleErrorMapping[] = [
  { pattern: /not your turn/i, code: ErrCode.NOT_YOUR_TURN, basis: '§5.3 / §11.1（含 Not your turn to bid）' },
  { pattern: /player .* not found/i, code: ErrCode.NOT_IN_ROOM, basis: '§5.3 身份映射' },
  {
    pattern: /not in playing state|not in bidding state|not started/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '§11.1 阶段不符（state !== bidding 时收到 game.bid 等）',
  },
  { pattern: /cannot pass on the opening lead/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-2 首出过牌' },
  { pattern: /cannot pass when you last played/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-3 最后出牌者过牌' },
  { pattern: /has no card to play/i, code: ErrCode.ILLEGAL_ACTION, basis: '§9.1 兜底（不可能状态）' },
  { pattern: /not in hand/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.1-2 / §11.1 牌不在手中（N16）' },
  { pattern: /cannot beat/i, code: ErrCode.INVALID_CARDS, basis: '§6.1-3 / §11.1 压不过上一手（N16）' },
  { pattern: /不能出空牌/i, code: ErrCode.INVALID_CARDS, basis: '§4.3 非法牌组' },
  { pattern: /不支持的牌型/i, code: ErrCode.INVALID_CARDS, basis: '§4.3 / §11.1 牌型非法' },
  { pattern: /invalid douzero card/i, code: ErrCode.INVALID_CARDS, basis: '防御：牌值不在 DouZero 值域（当前不可达）' },
  { pattern: /game not finished/i, code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算前必须已有胜负（不可达）' },
  // 2026-10-21：底分改为由 game.start 显式写入（createSession 省略时是 0 哨兵）。
  // settleGame 的正整数守卫是最后一道网——触发说明会话底分被写坏，正常对局不可达。
  { pattern: /invalid baseScore/i, code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算底分必须是正整数（0 哨兵/坏值，不可达）' },
  // 切片 10（C26/N1）在 `settle.ts` 新增的 `throw new Error('No landlord in session')`：
  // 与上一条同族——都是**内部前置**，正常对局不可达（地主在叫抢结束时必被写入）。
  // 覆盖闸（N2/R164）要求每一处新增 `throw` 都有人负责，故同步登记。
  { pattern: /no landlord in session/i, code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算前必须有地主（不可达）' },
  // §6.3 不变式（R160）在 `play.ts` 里有多条变体（当前 3 条），它们都是**内部防御**：
  // 一旦触发说明规则引擎自己的状态转移写坏了，对外只能按「操作非法」处置。
  // 刻意用一条**宽** pattern 覆盖全部变体：否则每加一条不变式都要同步加一行映射，
  // 覆盖闸就从「新增 throw 要有人负责」退化成「改注释也要改表」的噪音。
  {
    pattern: /invariant violated/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '§6.3 状态不变式 1–3（内部防御，触发即规则引擎自身写坏了状态）',
  },
  // ── 跑得快（Task 4.1 / spec §5.8）───────────────────────────────────
  // 跑得快没有叫抢：`PdkRuntime.applyAction` 收到 `game.bid` 时抛这条（13001）。
  {
    pattern: /paodekuai does not support game\.bid/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: 'spec §5.8 跑得快收到 game.bid ⇒ ILLEGAL_ACTION (13001)',
  },
  // 牌型解析失败（`parsePdkHand` 返回 Invalid 后由 play.ts 抛出）。
  { pattern: /invalid pdk hand/i, code: ErrCode.INVALID_CARDS, basis: 'spec §5.5 牌型非法' },
  // 以下都是**内部前置/投影不变式**：正常对局不可达，触发即会话形状被写坏。
  {
    pattern: /pdk settlement requires exactly|pdk settlement missing player/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部前置：结算前必须已结束、恰一名赢家、座位齐全（不可达）',
  },
  {
    pattern: /pdk session /i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部投影前置：pdk 会话形状写坏（不可达）',
  },
  {
    pattern: /seat .* is out of range/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部投影前置：座位越界（不可达）',
  },
];

/**
 * 规则引擎抛的是字符串（偏差 E5），这里是**唯一**的映射实现（§11.2）。
 * 未识别的错误按「操作非法」处理，而不是悄悄变成 500。
 */
export function classifyRuleError(err: unknown): ErrCode {
  const message = err instanceof Error ? err.message : String(err);
  for (const mapping of RULE_ERROR_MAPPINGS) {
    if (mapping.pattern.test(message)) return mapping.code;
  }
  return ErrCode.ILLEGAL_ACTION;
}
