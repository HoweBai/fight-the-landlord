import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 多玩法（Task 5.1 / spec §4.7.1）：跑得快 **14 键**种子。
 *
 * - `game.levels.paodekuai`：与斗地主同四档（休闲 15 / 标准 80 / 竞技 480 / 豪侠 1200），
 *   台费默认 0；**斗地主档位继续用旧 `game.baseScoreLevels`（不迁移、不双写）**；
 * - 总开关 `enabled=false`（暗上线）、`nonThreePlayerEnabled=false`（生产只开 3 人）；
 * - 11 个规则/计分键的默认值与 `shared/src/pdk/rules.ts` 的 `DEFAULT_PDK_RULES`
 *   及 `docs/games/paodekuai.md` §7.1 默认表逐字一致（doc-sync 测试对账）。
 *
 * ⚠️ `value` 是 json 列：单引号里是 JSON 字面量（boolean/number/string/数组）；
 * `airplaneWings` 是 JSON 字符串 `"pairs"`（不是裸 pairs）。
 * ⚠️ `INSERT IGNORE`：现有库/重放可重跑（同既有种子迁移）。
 */
export class MultiGameConfigSeed1796400000000 implements MigrationInterface {
  name = 'MultiGameConfigSeed1796400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('game.levels.paodekuai', '[{"name":"休闲场","baseScore":15,"entryFeePercent":0},{"name":"标准场","baseScore":80,"entryFeePercent":0},{"name":"竞技场","baseScore":480,"entryFeePercent":0},{"name":"豪侠场","baseScore":1200,"entryFeePercent":0}]', 1, NOW(3), 'seed'),` +
        "('game.paodekuai.enabled', 'false', 1, NOW(3), 'seed')," +
        "('game.paodekuai.nonThreePlayerEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.paodekuai.bareTrioEnabled', 'true', 1, NOW(3), 'seed')," +
        "('game.paodekuai.trioWithPairEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.paodekuai.bareAirplaneEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.paodekuai.fourWithTwoEnabled', 'true', 1, NOW(3), 'seed')," +
        "('game.paodekuai.fourWithTwoPairKickerAllowed', 'false', 1, NOW(3), 'seed')," +
        `('game.paodekuai.airplaneWings', '"pairs"', 1, NOW(3), 'seed'),` +
        "('game.paodekuai.bombMultiplierEnabled', 'true', 1, NOW(3), 'seed')," +
        "('game.paodekuai.guanMultiplierEnabled', 'true', 1, NOW(3), 'seed')," +
        "('game.paodekuai.springMultiplierEnabled', 'true', 1, NOW(3), 'seed')," +
        "('game.paodekuai.multiplierCap', '64', 1, NOW(3), 'seed')," +
        "('game.paodekuai.baobenEnabled', 'true', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of [
      'game.levels.paodekuai',
      'game.paodekuai.enabled',
      'game.paodekuai.nonThreePlayerEnabled',
      'game.paodekuai.bareTrioEnabled',
      'game.paodekuai.trioWithPairEnabled',
      'game.paodekuai.bareAirplaneEnabled',
      'game.paodekuai.fourWithTwoEnabled',
      'game.paodekuai.fourWithTwoPairKickerAllowed',
      'game.paodekuai.airplaneWings',
      'game.paodekuai.bombMultiplierEnabled',
      'game.paodekuai.guanMultiplierEnabled',
      'game.paodekuai.springMultiplierEnabled',
      'game.paodekuai.multiplierCap',
      'game.paodekuai.baobenEnabled',
    ]) {
      await queryRunner.query(`DELETE FROM \`platform_config\` WHERE \`key\` = '${key}'`);
    }
  }
}
