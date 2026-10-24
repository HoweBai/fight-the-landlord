/**
 * 跑得快规则配置的**契约类型**（spec §4.7/§5.6）。
 *
 * ⚠️ 类型在 protocol（客户端 hint / robot-service 共用）；默认值与校验在
 * `shared/src/pdk/rules.ts`。视图字段名必须叫 `pdkRules`，不得叫 `rules`
 * （`FORBIDDEN_OUTBOUND_KEYS` 含 `rules`，见 spec §4.5.1）。
 */
export const PDK_AIRPLANE_WINGS = ['pairs', 'singles', 'both'] as const;
export type PdkAirplaneWings = (typeof PDK_AIRPLANE_WINGS)[number];

export interface PdkRulesConfig {
  /** 裸三张是否可出。 */
  bareTrioEnabled: boolean;
  /** 三带二是否可出（文章默认不做）。 */
  trioWithPairEnabled: boolean;
  /** 不带翅膀的飞机是否可出。 */
  bareAirplaneEnabled: boolean;
  /** 四带二是否可出。 */
  fourWithTwoEnabled: boolean;
  /** 四带二的两张带牌是否可以同点成对。 */
  fourWithTwoPairKickerAllowed: boolean;
  /** 飞机翅膀类型。 */
  airplaneWings: PdkAirplaneWings;
  /** 每个裸四张炸弹是否使全场倍数 ×2。 */
  bombMultiplierEnabled: boolean;
  /** 至少一名输家一张未出时是否 ×2。 */
  guanMultiplierEnabled: boolean;
  /** 两名（或以上）输家都一张未出时是否再 ×2。 */
  springMultiplierEnabled: boolean;
  /** 全场倍数上限（1..1024）。 */
  multiplierCap: number;
  /** 剩 1 张未赢的输家是否付 0。 */
  baobenEnabled: boolean;
}
