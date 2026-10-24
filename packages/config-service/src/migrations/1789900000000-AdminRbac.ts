import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ③ 财务后台 + RBAC + 审计（T2）：四张管理面小表（规格 §2.2 = 设计 §3 DDL **逐字**）
 * —— `admin_accounts` / `admin_login_events` / `config_changes` / `admin_account_changes`
 * （与 config-service 同库 `fight_the_landlord`）。
 *
 * ⚠️ **形状逐字照 `1789800000000-GoldRoom.ts` / `1789200000000-PlatformConfig.ts`**：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符、
 * `CREATE TABLE IF NOT EXISTS`（既有库形态下容器启动可重跑，`migrationsRun: true`）。
 *
 * ⚠️ **时间戳 `1789900000000`** 是顺延既有序列的下一个空号（1789200000000 /
 * 1789500000000 / 1789700000000 / 1789800000000 已占用；全仓唯一由
 * `test/migration.test.ts` ⑨″ 钉住）。四表**无种子**（空表 = 管理面关闭态，
 * 唯一入口是 T3 的 bootstrap/hatch）。
 *
 * ⚠️ **本迁移只建表**：`config_changes` / `admin_login_events` 的写口在 T3/T4；
 * 本任务只写 `admin_account_changes`（账号写面留痕）。
 *
 * 时间列一律 `datetime(3)`（UTC，⚙️1）；wire 出站一律 epoch ms（服务层 `toEpochMs`）。
 */
export class AdminRbac1789900000000 implements MigrationInterface {
  name = 'AdminRbac1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 管理员账号（唯一的身份来源；删除不提供，只有停用——审计完整性）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `admin_accounts` (' +
        ' `id` bigint NOT NULL AUTO_INCREMENT,' +
        ' `username` varchar(32) NOT NULL,' + // 入库即小写；规则 ^[a-z0-9][a-z0-9._-]{2,31}$
        ' `password_hash` varchar(255) NOT NULL,' + // scrypt 格式串（D5）
        ' `role` varchar(16) NOT NULL,' + // super_admin | finance | operator | viewer
        " `status` varchar(10) NOT NULL DEFAULT 'active'," + // active | disabled
        ' `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        ' `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        ' `last_login_at` datetime(3) NULL,' +
        ' PRIMARY KEY (`id`),' +
        ' UNIQUE KEY `uk_admin_username` (`username`)' +
        ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );

    // 2) 登录事件（成功 + 失败；量级受网关限流约束——5 次/5 分钟/IP 封顶）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `admin_login_events` (' +
        ' `id` bigint NOT NULL AUTO_INCREMENT,' +
        ' `username` varchar(32) NOT NULL,' + // 尝试的用户名（小写归一；未知账号也记）
        ' `account_id` bigint NULL,' + // 账号存在时回填；未知账号 NULL
        ' `ip` varchar(64) NULL,' + // 网关注入的可信客户端 IP；缺头 ⇒ NULL，不伪造
        ' `success` tinyint(1) NOT NULL,' +
        ' `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        ' PRIMARY KEY (`id`),' +
        ' KEY `idx_login_events_created` (`created_at`)' +
        ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );

    // 3) 配置变更历史（M0.4：时刻 + 旧值→新值 + 改动人）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `config_changes` (' +
        ' `id` bigint NOT NULL AUTO_INCREMENT,' +
        ' `key` varchar(64) NOT NULL,' +
        ' `old_value` json NULL,' + // 首建（该键此前不存在）⇒ NULL
        ' `new_value` json NOT NULL,' +
        ' `actor` varchar(32) NOT NULL,' + // 操作者用户名
        ' `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        ' PRIMARY KEY (`id`),' +
        ' KEY `idx_config_changes_key` (`key`, `id`)' +
        ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );

    // 4) 账号变更历史（建号/改角色/停用启用/重置口令——与账号写**同事务**落行）
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `admin_account_changes` (' +
        ' `id` bigint NOT NULL AUTO_INCREMENT,' +
        ' `target_id` bigint NOT NULL,' + // 被操作账号
        ' `username` varchar(32) NOT NULL,' + // 冗余快照（账号不可删，无需防悬空，仅为查询展示）
        ' `action` varchar(16) NOT NULL,' + // create | role | disable | enable | password_reset
        ' `detail` json NULL,' + // 如 {"from":"viewer","to":"finance"}；password_reset 只记发生不记值
        ' `actor` varchar(32) NOT NULL,' + // 操作者用户名
        ' `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        ' PRIMARY KEY (`id`),' +
        ' KEY `idx_account_changes_target` (`target_id`, `id`)' +
        ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序 DROP（与 up() 的建立序相反）
    await queryRunner.query('DROP TABLE IF EXISTS `admin_account_changes`');
    await queryRunner.query('DROP TABLE IF EXISTS `config_changes`');
    await queryRunner.query('DROP TABLE IF EXISTS `admin_login_events`');
    await queryRunner.query('DROP TABLE IF EXISTS `admin_accounts`');
  }
}
