import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ② 金币场（⚙️1）T3：第 12–17 个配置键的种子迁移（规格 §1.1 六键逐字表）——
 * `room.freeRoomEnabled=true` / `room.goldRoomEnabled=true` / `currency.entryMultiplier=10`
 * / `currency.rakePercent=0` / `currency.reliefEnabled=false` / `currency.reliefAmount=200`。
 *
 * ⚠️ **2026-10-04 用户裁决**：金币场默认开（原默认关/暗上线）—— 本迁移种子的
 * `room.goldRoomEnabled` 随之翻转为 `true`；既要的一致性面（getter 缺省/管理面兜底/
 * 客户端缺键语义/测试夹具）同步翻转。免费场开关维持默认开、救助开关维持默认关。
 *
 * ⚠️ **形状逐字照 `1789700000000-SignupGrant.ts`**（其自身照 `1789500000000-RecordRetention.ts`）：
 * 类名 `<Name><时间戳>`、`name` 属性与类名一致、SQL 用反引号标识符。
 *
 * ⚠️ **只 INSERT 这六个新键**（一条语句、六个 VALUE 元组，照 `1789200000000-PlatformConfig.ts`
 * 九键种子的一语句多行形态）：迁移只跑一次（记录在**独立**的 `migrations_config` 表），
 * 既有 11 行属于前三个迁移 —— 四者按时间戳顺序执行（`1789800000000` 最晚，
 * 保持「同一库内时间戳单调」的习惯）。
 *
 * 种子值的语义（规格 §1.1；2026-10-04 用户裁决修订）：
 *  - `room.freeRoomEnabled=true`——免费场**保持现状开**（新增开关不是为了关它）；
 *  - `room.goldRoomEnabled=true`——金币场**默认开**（原「暗上线 = 默认关」经用户
 *    2026-10-04 裁决翻转为默认开；要关随时在管理面关）；
 *  - `currency.entryMultiplier=10`——门槛 = 底分 × 10（休闲场 15 ⇒ 150）；
 *  - `currency.rakePercent=0`——零和起点（>0 才从赢家所得扣、系统回收）；
 *  - `currency.reliefEnabled=false` / `currency.reliefAmount=200`——救助默认关（金额 200
 *    在最低档门槛 150 之上；0 不可，停发用开关）。
 */
export class GoldRoom1789800000000 implements MigrationInterface {
  name = 'GoldRoom1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里的 `true`/`10` 是 JSON 字面量（不是字符串），
    // 与 `parseConfigValue(key, …)` 的严格 boolean / int 口径一致。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('room.freeRoomEnabled', 'true', 1, NOW(3), 'seed'), " +
        "('room.goldRoomEnabled', 'true', 1, NOW(3), 'seed'), " +
        "('currency.entryMultiplier', '10', 1, NOW(3), 'seed'), " +
        "('currency.rakePercent', '0', 1, NOW(3), 'seed'), " +
        "('currency.reliefEnabled', 'false', 1, NOW(3), 'seed'), " +
        "('currency.reliefAmount', '200', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作 = 让本迁移种下的六行退场（值可能已被管理面改过；down 的语义是「第 12–17 键退场」）。
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN ' +
        "('room.freeRoomEnabled', 'room.goldRoomEnabled', 'currency.entryMultiplier', " +
        "'currency.rakePercent', 'currency.reliefEnabled', 'currency.reliefAmount')",
    );
  }
}
