import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * E7（§10.3）：`users` 表的**初始迁移**。
 *
 * ⚠️ 列定义**逐字对齐实测的现有表**（`SHOW COLUMNS FROM fight_the_landlord.users`
 * / `SHOW CREATE TABLE`，2026-09-15 现场读数）：
 *
 * ```
 * id           varchar(36)   NO   PRI   NULL
 * phone        varchar(20)   NO   UNI   NULL
 * passwordHash varchar(255)  NO         NULL
 * nickname     varchar(50)   YES        NULL
 * avatar       varchar(255)  YES        NULL
 * status       varchar(10)   NO         active
 * createdAt    datetime(6)   NO         CURRENT_TIMESTAMP(6)
 * ```
 *
 * ⚠️ **必须 `CREATE TABLE IF NOT EXISTS`**：现有库里这张表**已经存在**
 * （此前靠 `synchronize: true` 建的），首跑只会写 `migrations` 表 —— 没有它，
 * 容器启动时 `migrationsRun` 会直接失败，服务起不来。
 *
 * 唯一索引名 `IDX_a000cca60bcf04454e72769949` 是 TypeORM 对 `phone` 唯一列生成的
 * 名字（现场 `SHOW CREATE TABLE` 读数），照抄是为了「新库」与「现有库」形状一致。
 */
export class InitialUsers1789000000000 implements MigrationInterface {
  name = 'InitialUsers1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `users` (' +
        '`id` varchar(36) NOT NULL, ' +
        '`phone` varchar(20) NOT NULL, ' +
        '`passwordHash` varchar(255) NOT NULL, ' +
        '`nickname` varchar(50) NULL, ' +
        '`avatar` varchar(255) NULL, ' +
        "`status` varchar(10) NOT NULL DEFAULT 'active', " +
        '`createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `IDX_a000cca60bcf04454e72769949` (`phone`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `users`');
  }
}
