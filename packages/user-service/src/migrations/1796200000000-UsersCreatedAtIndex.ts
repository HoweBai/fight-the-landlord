import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 玩家管理页（2026-10-22）：`users(createdAt)` 索引 —— 列表按注册时间筛选/排序与新增统计。
 * 初始迁移只有 PRIMARY KEY 与 phone 唯一键，本迁移补齐创建时间索引。
 */
export class UsersCreatedAtIndex1796200000000 implements MigrationInterface {
  name = 'UsersCreatedAtIndex1796200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX `idx_users_created_at` ON `users` (`createdAt`)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `idx_users_created_at` ON `users`');
  }
}
