// packages/robot-service/src/robot/config.ts
import type { SkillLevel } from '@fight-the-landlord/protocol';
import { MODEL_BY_SKILL } from './models';

/** 三档（§9.3；`parseSkillDistribution` 与默认表共用同一份名单）。 */
export const SKILL_LEVELS: readonly SkillLevel[] = ['beginner', 'intermediate', 'advanced'];

/** 片② D3 的默认比例（用户裁决 10）——片⑦ 起也是 `robot.skillDistribution` 的代码默认值（=种子）。 */
export const DEFAULT_SKILL_DISTRIBUTION = 'beginner=0.15,intermediate=0.35,advanced=0.5';

/**
 * 解析「`beginner=15,intermediate=35,advanced=50`」形态的权重串 ⇒ 有序对 + **归一化**。
 *
 * 片⑦ E1（design D3）：**env 解析已退役**（旧 `ROBOT_SKILL_DISTRIBUTION` 不再被读）——
 * 本函数作为**纯函数**保留：`config-cache.service.ts` 的 `skillDistribution()` 在快照
 * 缺失/形状非法时用它解析上面的默认串。`'15,35,50'` 的归一化语义**逐字保留**
 *（规格 §2.2 的校验口径：各 ≥ 0、合计 > 0 ⇒ 写入侧归一化落库）。
 */
export function parseSkillDistribution(
  raw?: string,
): ReadonlyArray<readonly [SkillLevel, number]> {
  const text = raw ?? DEFAULT_SKILL_DISTRIBUTION;
  if (text.trim() === '') throw new Error('skill distribution is empty');
  const out = new Map<SkillLevel, number>();
  for (const part of text.split(',')) {
    const [name, weightText] = part.split('=');
    const level = SKILL_LEVELS.find((l) => l === name?.trim());
    if (!level) throw new Error(`skill distribution: unknown level "${name ?? part}"`);
    if (out.has(level)) throw new Error(`skill distribution: duplicate level "${level}"`);
    const weight = Number(weightText);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`skill distribution: bad weight for "${level}"`);
    }
    out.set(level, weight);
  }
  for (const level of SKILL_LEVELS) {
    if (!out.has(level)) throw new Error(`skill distribution: missing level "${level}"`);
  }
  const total = [...out.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('skill distribution: all weights are zero');
  return SKILL_LEVELS.map((l) => [l, out.get(l)! / total] as const);
}

/**
 * 片⑦ E1/D3（design §D3 的「保留代码默认值（=种子）并导出」）：机器人四键的
 * **代码默认值** —— 快照缺失 / 键缺失 / 值形状非法时，`config-cache.service.ts` 的
 * 四个 getter 一律取这里的值（「拿不到就取默认」的**唯一代码落点**）。
 *
 * ⚠️ 与规格 §2.2 的种子、config-service 迁移种子、以及 `docs/` 的键表**逐键同值**；
 * 键名即 `platform_config` 的 key（本表的键名同时是 J29 闸认的「定义点」文本 ——
 * 开关的读取只许发生在定义点（本文件 + `config-cache.service.ts`）与合法消费者
 *（`douzero.health.ts` 的探测门禁），见 `no-switch-in-decision.gate.test.ts`）。
 */
export const ROBOT_CONFIG_DEFAULTS = {
  'game.doudizhu.robot.skillDistribution': DEFAULT_SKILL_DISTRIBUTION,
  'game.doudizhu.robot.ruleFallback': true,
  'game.doudizhu.robot.modelBySkill': MODEL_BY_SKILL,
  'robot.reclaimIntervalMs': 60_000,
} as const;
