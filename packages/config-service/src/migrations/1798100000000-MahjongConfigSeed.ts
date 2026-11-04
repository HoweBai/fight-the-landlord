import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_CHENGDU_RULES } from '@fight-the-landlord/protocol';

/**
 * 四川麻将（2026-10-28）：11 键种子。
 * - 暗上线：enabled/free/gold/friend/botFill/sbrGold 全部 false；
 * - 规则 JSON = protocol `DEFAULT_CHENGDU_RULES`（单一真源）；
 * - 档位与其它玩法同四档，台费 0。
 */
export class MahjongConfigSeed1798100000000 implements MigrationInterface {
  name = 'MahjongConfigSeed1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rules = JSON.stringify(DEFAULT_CHENGDU_RULES);
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('game.levels.mahjong', '[{"name":"休闲场","baseScore":15,"entryFeePercent":0},{"name":"标准场","baseScore":80,"entryFeePercent":0},{"name":"竞技场","baseScore":480,"entryFeePercent":0},{"name":"豪侠场","baseScore":1200,"entryFeePercent":0}]', 1, NOW(3), 'seed'),` +
        "('game.mahjong.enabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.freeRoomEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.goldRoomEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.friendRoomEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.freeBotFillEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.goldBotFillEnabled', 'false', 1, NOW(3), 'seed')," +
        "('game.mahjong.entryMultiplier', '10', 1, NOW(3), 'seed')," +
        "('game.mahjong.rakePercent', '0', 1, NOW(3), 'seed')," +
        "('game.mahjong.sbrGoldEnabled', 'false', 1, NOW(3), 'seed')," +
        `('game.mahjong.rules', '${rules}', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of [
      'game.levels.mahjong',
      'game.mahjong.enabled',
      'game.mahjong.freeRoomEnabled',
      'game.mahjong.goldRoomEnabled',
      'game.mahjong.friendRoomEnabled',
      'game.mahjong.freeBotFillEnabled',
      'game.mahjong.goldBotFillEnabled',
      'game.mahjong.entryMultiplier',
      'game.mahjong.rakePercent',
      'game.mahjong.sbrGoldEnabled',
      'game.mahjong.rules',
    ]) {
      await queryRunner.query(`DELETE FROM \`platform_config\` WHERE \`key\` = '${key}'`);
    }
  }
}
