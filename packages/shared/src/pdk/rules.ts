/**
 * 跑得快规则配置的**默认值与校验唯一实现**（spec §4.7.1 / §5.6）。
 *
 * 类型在 protocol；本文件只做默认值合并与严格校验，供：
 *  - room-service 从配置中心组装 `PdkRulesConfig` 快照；
 *  - shared/game-service 的测试构造合法配置；
 *  - 管理面/配置写入的边界校验。
 */
import {
  PDK_AIRPLANE_WINGS,
  ProtocolError,
  type PdkAirplaneWings,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';

export const DEFAULT_PDK_RULES: Readonly<PdkRulesConfig> = Object.freeze({
  bareTrioEnabled: true,
  trioWithPairEnabled: false,
  bareAirplaneEnabled: false,
  fourWithTwoEnabled: true,
  fourWithTwoPairKickerAllowed: false,
  airplaneWings: 'pairs',
  bombMultiplierEnabled: true,
  guanMultiplierEnabled: true,
  springMultiplierEnabled: true,
  multiplierCap: 64,
  baobenEnabled: true,
});

const BOOLEAN_KEYS = [
  'bareTrioEnabled',
  'trioWithPairEnabled',
  'bareAirplaneEnabled',
  'fourWithTwoEnabled',
  'fourWithTwoPairKickerAllowed',
  'bombMultiplierEnabled',
  'guanMultiplierEnabled',
  'springMultiplierEnabled',
  'baobenEnabled',
] as const satisfies ReadonlyArray<keyof PdkRulesConfig>;

const ALL_KEYS = new Set<string>([...BOOLEAN_KEYS, 'airplaneWings', 'multiplierCap']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 合并默认值并严格校验。
 *
 * - `undefined` / `null` ⇒ `DEFAULT_PDK_RULES` 的副本（旧配置缺段）；
 * - 对象可只给部分键（缺省用默认值）；**未知键 ⇒ 抛错**（防拼写漂移）；
 * - boolean 必须严格 boolean；`airplaneWings` 必须枚举；`multiplierCap` 必须 1..1024 整数。
 */
export function parsePdkRules(input: unknown): PdkRulesConfig {
  if (input === undefined || input === null) return { ...DEFAULT_PDK_RULES };
  if (!isObj(input)) {
    throw new ProtocolError('pdkRules must be an object');
  }

  for (const key of Object.keys(input)) {
    if (!ALL_KEYS.has(key)) {
      throw new ProtocolError(`pdkRules contains unknown key "${key}"`);
    }
  }

  const out: PdkRulesConfig = { ...DEFAULT_PDK_RULES };
  for (const key of BOOLEAN_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ProtocolError(`pdkRules.${key} must be a boolean, got ${JSON.stringify(value)}`);
    }
    out[key] = value;
  }

  const wings = input.airplaneWings;
  if (wings !== undefined) {
    if (
      typeof wings !== 'string' ||
      !(PDK_AIRPLANE_WINGS as readonly string[]).includes(wings)
    ) {
      throw new ProtocolError(
        `pdkRules.airplaneWings must be one of ${PDK_AIRPLANE_WINGS.join(' | ')}, got ${JSON.stringify(wings)}`,
      );
    }
    out.airplaneWings = wings as PdkAirplaneWings;
  }

  const cap = input.multiplierCap;
  if (cap !== undefined) {
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 1024) {
      throw new ProtocolError(
        `pdkRules.multiplierCap must be an integer in 1..1024, got ${JSON.stringify(cap)}`,
      );
    }
    out.multiplierCap = cap;
  }

  return out;
}
