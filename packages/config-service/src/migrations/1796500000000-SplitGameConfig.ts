import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 配置平行化（2026-10-24）：把平台级/斗地主专属键复制到 `game.doudizhu.*`，
 * 并种下跑得快 7 键与平台级救助绝对门槛。
 *
 * 设计：`docs/superpowers/specs/2026-10-24-multi-game-per-game-config-design.md` §5.2。
 *
 * - **旧键不删、不改**：只读回退 + 回滚回填依赖它们；
 * - JS 驱动复制（SELECT → INSERT IGNORE）：可测试、可在迁移时现算救助门槛；
 * - `value` 统一 `JSON.stringify` 后写入 json 列（字符串/布尔/对象都按 JSON 字面量落库）；
 * - `INSERT IGNORE` 可重跑：新键已存在则不覆盖；
 * - `down()` 只删本迁移新增的 24 键。
 */

/** 旧键 → 斗地主新键 + 旧行缺失时的兜底默认值（逐字 = 旧种子）。 */
export const SPLIT_CONFIG_PAIRS: ReadonlyArray<
  readonly [oldKey: string, newKey: string, fallback: unknown]
> = [
  ['room.freeRoomEnabled', 'game.doudizhu.freeRoomEnabled', true],
  ['room.goldRoomEnabled', 'game.doudizhu.goldRoomEnabled', true],
  ['room.friendRoomEnabled', 'game.doudizhu.friendRoomEnabled', false],
  ['room.freeBotFillEnabled', 'game.doudizhu.freeBotFillEnabled', true],
  ['room.goldBotFillEnabled', 'game.doudizhu.goldBotFillEnabled', true],
  ['currency.rakePercent', 'game.doudizhu.rakePercent', 0],
  ['currency.entryMultiplier', 'game.doudizhu.entryMultiplier', 10],
  [
    'game.baseScoreLevels',
    'game.levels.doudizhu',
    [
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
      { name: '竞技场', baseScore: 480 },
      { name: '豪侠场', baseScore: 1200 },
    ],
  ],
  ['game.cardCounterEnabled', 'game.doudizhu.cardCounterEnabled', true],
  ['game.cardCounterPricePerGameCoins', 'game.doudizhu.cardCounterPricePerGameCoins', 10],
  ['game.cardCounterPricePerHourCoins', 'game.doudizhu.cardCounterPricePerHourCoins', 100],
  [
    'robot.skillDistribution',
    'game.doudizhu.robot.skillDistribution',
    { beginner: 0.15, intermediate: 0.35, advanced: 0.5 },
  ],
  ['robot.ruleFallback', 'game.doudizhu.robot.ruleFallback', true],
  [
    'robot.modelBySkill',
    'game.doudizhu.robot.modelBySkill',
    { beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' },
  ],
  ['risk.winRateThreshold', 'game.doudizhu.risk.winRateThreshold', 0.8],
  ['risk.minGames', 'game.doudizhu.risk.minGames', 100],
];

/** 跑得快新键种子（保守灰度：免费开、金币关、好友房关、补位开、抽水 0、门槛 10）。 */
export const SPLIT_PDK_SEEDS: ReadonlyArray<readonly [key: string, value: unknown]> = [
  ['game.paodekuai.freeRoomEnabled', true],
  ['game.paodekuai.goldRoomEnabled', false],
  ['game.paodekuai.friendRoomEnabled', false],
  ['game.paodekuai.freeBotFillEnabled', true],
  ['game.paodekuai.goldBotFillEnabled', true],
  ['game.paodekuai.rakePercent', 0],
  ['game.paodekuai.entryMultiplier', 10],
];

export const RELIEF_THRESHOLD_KEY = 'currency.reliefThresholdCoins';
export const RELIEF_THRESHOLD_FALLBACK = 150;

type SqlRow = { key: string; value: unknown; version: number };

/**
 * 迁移时现算救助门槛：`MIN(斗地主档位 baseScore) × 斗地主 entryMultiplier`。
 * 旧键缺失/非法 ⇒ 15 × 10 = 150（正常种子）。
 */
export function computeReliefThreshold(levels: unknown, multiplier: unknown): number {
  const m =
    typeof multiplier === 'number' &&
    Number.isInteger(multiplier) &&
    multiplier >= 1 &&
    multiplier <= 100
      ? multiplier
      : 10;
  if (Array.isArray(levels)) {
    const scores = levels
      .map((item) =>
        item !== null && typeof item === 'object' && 'baseScore' in item
          ? (item as { baseScore?: unknown }).baseScore
          : undefined,
      )
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
    if (scores.length > 0) return Math.min(...scores) * m;
  }
  return 15 * m;
}

/** mysql2 对 json 列可能返回字符串；统一还原成 JS 值后再 stringify 回写。 */
function normalizeDbJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function insertIgnore(
  runner: QueryRunner,
  key: string,
  value: unknown,
  version: number,
): Promise<void> {
  await runner.query(
    'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?)',
    [key, JSON.stringify(value), version, 'seed'],
  );
}

export class SplitGameConfig1796500000000 implements MigrationInterface {
  name = 'SplitGameConfig1796500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const oldKeys = SPLIT_CONFIG_PAIRS.map(([oldKey]) => oldKey);
    const placeholders = oldKeys.map(() => '?').join(', ');
    const rows = (await queryRunner.query(
      `SELECT \`key\`, \`value\`, \`version\` FROM \`platform_config\` WHERE \`key\` IN (${placeholders})`,
      oldKeys,
    )) as SqlRow[];
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // 新键版本起点 = 当前**全表**全局 MAX（至少 1）：否则 PDK/救援新键从 1 起写，
    // 在任一旧键版本更高的库里永远推不动全局 `version`（客户端/观测据此判断配置是否变化）。
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | null }>;
    const globalMax = Math.max(1, Number(maxRows[0]?.maxVersion ?? 0));

    for (const [oldKey, newKey, fallback] of SPLIT_CONFIG_PAIRS) {
      const row = byKey.get(oldKey);
      await insertIgnore(
        queryRunner,
        newKey,
        row === undefined ? fallback : normalizeDbJson(row.value),
        Math.max(globalMax, row?.version ?? 1),
      );
    }

    const relief = computeReliefThreshold(
      normalizeDbJson(byKey.get('game.baseScoreLevels')?.value),
      normalizeDbJson(byKey.get('currency.entryMultiplier')?.value),
    );
    await insertIgnore(queryRunner, RELIEF_THRESHOLD_KEY, relief, globalMax);

    for (const [key, value] of SPLIT_PDK_SEEDS) {
      await insertIgnore(queryRunner, key, value, globalMax);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const newKeys = SPLIT_CONFIG_PAIRS.map(([, newKey]) => newKey);
    newKeys.push(RELIEF_THRESHOLD_KEY, ...SPLIT_PDK_SEEDS.map(([key]) => key));
    const placeholders = newKeys.map(() => '?').join(', ');
    await queryRunner.query(
      `DELETE FROM \`platform_config\` WHERE \`key\` IN (${placeholders})`,
      newKeys,
    );
  }
}
