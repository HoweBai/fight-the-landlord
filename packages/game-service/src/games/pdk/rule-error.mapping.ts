/**
 * 跑得快规则错误映射（Task 4.1 / spec §5.8）。
 *
 * 映射表本身是**全仓唯一**的 `game/rule-error.mapping.ts`（错误码是契约级、按文本分类）；
 * 本文件提供 runtime 侧的稳定入口（与 `games/ddz/rule-error.mapping` 同形），
 * 不复制第二份表 —— 覆盖闸（`rule-error-mapping.test.ts`）扫的是那一份。
 */
export { RULE_ERROR_MAPPINGS, classifyRuleError } from '../../game/rule-error.mapping';
export type { RuleErrorMapping } from '../../game/rule-error.mapping';
