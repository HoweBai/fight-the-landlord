import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 设备绑定片：单账号设备绑定表（安全功能；开关 = 第 49 键 `risk.deviceBindingEnabled`，
 * 默认关）。
 *
 * - `user_device_bindings`：账号 → **唯一**绑定设备（1:1；与风控三表里的 `user_devices`
 *   （1:N 设备历史链，仅事后扫描用）**语义分离**——不要把两表混用）。
 *   - `PRIMARY KEY (user_id)`：一账号一行；首绑靠 `INSERT IGNORE` 认第一台，竞态由 PK 裁决；
 *   - `idx_device`（按设备反查绑定账号，管理面/诊断面）。
 * - 绑定真相在本表；Redis `risk:binding:{userId}` 是给网关 WS 握手读的**写透缓存**（无 TTL），
 *   键缺/Redis 故障 ⇒ 网关 fail-open，REST 登录闸仍以本表为准。
 *
 * ⚠️ **形状逐字照 `1790000000000-RiskControl`**：类名 `<Name><timestamp>`、`name` 属性与
 * 类名一致、`CREATE TABLE IF NOT EXISTS`、每列一行式拼接、collation 与既有五表逐字一致
 * （进 JOIN 的 `user_id` 与 `users.id` 必须同口径）。
 * ⚠️ **down 是 up 的镜像**：DROP `user_device_bindings`（解绑不级联任何他表）。
 */
export class DeviceBinding1790100000000 implements MigrationInterface {
  name = 'DeviceBinding1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `user_device_bindings` (' +
        '`user_id` varchar(64) NOT NULL, ' +
        '`device_id` varchar(64) NOT NULL, -- 绑定设备指纹（客户端 UUID 原文；玩家面永不出站）\n' +
        '`bound_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`user_id`), ' +
        'KEY `idx_device` (`device_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `user_device_bindings`');
  }
}
