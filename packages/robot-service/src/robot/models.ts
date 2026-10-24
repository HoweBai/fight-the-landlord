// packages/robot-service/src/robot/models.ts
import type { SkillLevel } from '@fight-the-landlord/protocol';

/** douzero 侧的模型目录名（逐字，见 `douzero/models/<model>/`）。 */
export type DouZeroModel = 'sl' | 'douzero_WP' | 'douzero_ADP';

/** §9.3 三档 = 三个模型（片② D2，用户裁决 5）。 */
export const MODEL_BY_SKILL: Record<SkillLevel, DouZeroModel> = {
  beginner: 'sl',
  intermediate: 'douzero_WP',
  advanced: 'douzero_ADP',
};
