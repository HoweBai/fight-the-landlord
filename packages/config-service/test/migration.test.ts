/**
 * `platform_config` 迁移（规格 §2.1 建表 DDL + §2.2 九键种子；记录片 T1 起
 * 第 10 键 `record.retentionDays` 由追加的种子迁移种下；货币核心 T2 起
 * 第 11 键 `currency.signupGrant` 再由追加的种子迁移种下；② 金币场 T3 起
 * 第 12–17 键由 `1789800000000-GoldRoom.ts` 种下；风控片 T1 起
 * 第 18–25 键由 `1790000001000-RiskConfigSeed.ts` 种下；支付片 T5 起
 * 第 26–34 键由 `1791000001000-PayConfigSeed.ts` 种下；支付配置管理化 T2 起
 * 渠道第二键空间表 `pay_channel_config`（**无种子**）由 `1792000000000-PayChannelConfig.ts` 建表；
 * 通知通道管理化 T2 起 通知凭据第三键空间表 `notify_channel_config`（**无种子**）
 * 由 `1793000000000-NotifyChannelConfig.ts` 建表；节奏/清理片 T2 起
 * 第 35–40 键由 `1794000000000-IntervalConfigSeed.ts` 种下；广告片 T2 起
 * 第 41 键 `ad.reliefAdpid`（空串 = 未配置；string JSON 字面量首例）
 * 由 `1795100000000-AdReliefAdpidSeed.ts` 种下；广告片 T5 起 广告渠道第四键空间表
 * `ad_channel_config`（**无种子**）由 `1795000000000-AdChannelConfig.ts` 建表；台费片 T2 起
 * 第 42 键 `currency.entryFeePercents`（4 行 ×0 = 暗上线）
 * 由 `1795200000000-EntryFeePercentsSeed.ts` 种下；客户端接入片 T2 起
 * 第 43/44 键 `client.appEnabled` / `client.h5Enabled`（双 true = 暗上线全开）
 * 由 `1795300000000-ClientAccessGateSeed.ts` 种下；机器人补位开关片起
 * 第 45–47 键（双开关 true = 暗上线 + 无机器人等待上限 300000ms）
 * 由 `1795400000000-BotFillConfigSeed.ts` 种下；提现再认证片起
 * 第 48 键 `risk.withdrawReAuthEnabled`（false = 暗上线）
 * 由 `1795500000000-RiskWithdrawReAuthSeed.ts` 种下；设备绑定片起
 * 第 49 键 `risk.deviceBindingEnabled`（false = 暗上线）
 * 由 `1795600000000-RiskDeviceBindingSeed.ts` 种下；记牌器片起
 * 第 50 键 `game.cardCounterEnabled`（true = 保持现状）
 * 由 `1795700000000-CardCounterSeed.ts` 种下）与库选项。
 *
 * ⚠️ **形状逐字照 `user-service/test/migration.test.ts`**（本文件不用真 DB）：拿**真实迁移类**
 * 的 `up()` 对着记录 SQL 的假 QueryRunner 跑，断言的是**完整列定义 / 完整 INSERT 值**，
 * 不是 `toContain('key')` 那种弱断言。真库证据另有容器级验证（T2 Step 4：
 * 真镜像对真 MySQL 跑 `migrationsRun` ⇒ `SELECT \`key\`,version FROM platform_config` 九行）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { configDatabaseOptions, migrationsGlob } from '../src/database.config';
import { PlatformConfig1789200000000 } from '../src/migrations/1789200000000-PlatformConfig';
import { RecordRetention1789500000000 } from '../src/migrations/1789500000000-RecordRetention';
import { SignupGrant1789700000000 } from '../src/migrations/1789700000000-SignupGrant';
import { GoldRoom1789800000000 } from '../src/migrations/1789800000000-GoldRoom';
import { AdminRbac1789900000000 } from '../src/migrations/1789900000000-AdminRbac';
import { RiskConfigSeed1790000001000 } from '../src/migrations/1790000001000-RiskConfigSeed';
import { PayConfigSeed1791000001000 } from '../src/migrations/1791000001000-PayConfigSeed';
import { PayChannelConfig1792000000000 } from '../src/migrations/1792000000000-PayChannelConfig';
import { NotifyChannelConfig1793000000000 } from '../src/migrations/1793000000000-NotifyChannelConfig';
import { IntervalConfigSeed1794000000000 } from '../src/migrations/1794000000000-IntervalConfigSeed';
import { AdChannelConfig1795000000000 } from '../src/migrations/1795000000000-AdChannelConfig';
import { AdReliefAdpidSeed1795100000000 } from '../src/migrations/1795100000000-AdReliefAdpidSeed';
import { EntryFeePercentsSeed1795200000000 } from '../src/migrations/1795200000000-EntryFeePercentsSeed';
import { ClientAccessGateSeed1795300000000 } from '../src/migrations/1795300000000-ClientAccessGateSeed';
import { BotFillConfigSeed1795400000000 } from '../src/migrations/1795400000000-BotFillConfigSeed';
import { RiskWithdrawReAuthSeed1795500000000 } from '../src/migrations/1795500000000-RiskWithdrawReAuthSeed';
import { RiskDeviceBindingSeed1795600000000 } from '../src/migrations/1795600000000-RiskDeviceBindingSeed';
import { CardCounterSeed1795700000000 } from '../src/migrations/1795700000000-CardCounterSeed';
import { CardCounterPrices1795800000000 } from '../src/migrations/CardCounterPrices1795800000000';
import { MultiGameConfigSeed1796400000000 } from '../src/migrations/1796400000000-MultiGameConfigSeed';
import {
  SplitGameConfig1796500000000,
  RELIEF_THRESHOLD_KEY,
  SPLIT_CONFIG_PAIRS,
  SPLIT_PDK_SEEDS,
  computeReliefThreshold,
} from '../src/migrations/1796500000000-SplitGameConfig';
import { RemoveEntryFeePercents1796000000000 } from '../src/migrations/1796000000000-RemoveEntryFeePercents';
import { CONFIG_CHANGES_INSERT_SQL } from '../src/admin/admin-changes.service';
import {
  FakeNotifyChannelDb,
  FakePayChannelDb,
  SPEC_NOTIFY_CHANNEL_DELETE_SQL,
  SPEC_NOTIFY_CHANNEL_LIST_SQL,
  SPEC_NOTIFY_CHANNEL_LOCK_SQL,
  SPEC_NOTIFY_CHANNEL_UPSERT_SQL,
  SPEC_PAY_CHANNEL_DELETE_SQL,
  SPEC_PAY_CHANNEL_LIST_SQL,
  SPEC_PAY_CHANNEL_LOCK_SQL,
  SPEC_PAY_CHANNEL_UPSERT_SQL,
} from './helpers/config-probe';

const MIGRATIONS_DIR = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'src',
  'migrations',
);

/** 记录 SQL 的假 QueryRunner（与 user-service 同形）。 */
function fakeRunner(statements: string[]): QueryRunner {
  return {
    query: async (sql: string) => {
      statements.push(sql);
      return undefined;
    },
  } as unknown as QueryRunner;
}

/** 断言用：把多行 SQL 折成单空格形态，免去对换行/缩进的脆断言。 */
const flatten = (sql: string): string => sql.replace(/\s+/g, ' ');

/** §2.2 九键种子（**属 `1789200000000` 那个迁移**；第 10 键见下方记录片种子用例）。 */
const EXPECTED_SEED: ReadonlyArray<readonly [string, string]> = [
  ['robot.skillDistribution', '{"beginner":0.15,"intermediate":0.35,"advanced":0.5}'],
  ['robot.ruleFallback', 'true'],
  [
    'robot.modelBySkill',
    '{"beginner":"sl","intermediate":"douzero_WP","advanced":"douzero_ADP"}',
  ],
  ['robot.reclaimIntervalMs', '60000'],
  ['room.matchScanIntervalMs', '5000'],
  ['room.autostartIntervalMs', '5000'],
  ['room.reapIntervalMs', '60000'],
  ['room.friendRoomEnabled', 'false'],
  [
    'game.baseScoreLevels',
    '[{"name":"休闲场","baseScore":15},{"name":"标准场","baseScore":80},' +
      '{"name":"竞技场","baseScore":480},{"name":"豪侠场","baseScore":1200}]',
  ],
];

describe('platform_config 迁移与配置中心库选项（规格 §2.1/§2.2）', () => {
  it('① 有效选项：synchronize=false、migrationsRun=true、migrations 指向 dist/migrations/*.js', () => {
    const options = configDatabaseOptions();

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(true);
    expect(options.migrations).toEqual([migrationsGlob()]);
    // `MixedList<T> = T[] | { [key: number]: T; length: number }` ⇒ 收窄成数组再断（同 user-service）
    const migrations = options.migrations;
    expect(Array.isArray(migrations), 'migrations 必须是列表形态').toBe(true);
    if (!Array.isArray(migrations)) throw new Error('unreachable: 上一行已断言');
    expect(String(migrations[0])).toMatch(/migrations[/\\]\*\.js$/);
    expect(options.entities === undefined || options.autoLoadEntities === true).toBe(true);
  });

  it('② 🔴 迁移表独立：migrationsTableName 必须是 migrations_config（与 user-service 共库）', () => {
    // 共库时若沿用默认 `migrations` 表，两个服务会互相把对方的记录当「未知已执行」
    // —— 轻则报表已存在，重则把对方的 up() 当自己的跑。这条是本任务的**基石判据**。
    expect(configDatabaseOptions().migrationsTableName).toBe('migrations_config');
  });

  it('③ `src/migrations/` 下存在类名匹配 /^PlatformConfig\\d+$/ 的迁移', () => {
    const names = readdirSync(MIGRATIONS_DIR).flatMap((file) =>
      [...readFileSync(join(MIGRATIONS_DIR, file), 'utf-8').matchAll(/export class (\w+)/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(names, `src/migrations/ 里没有 PlatformConfig<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^PlatformConfig\d+$/)]),
    );
  });

  it('④ up()：建表 + 九键种子 —— 五列完整定义/PK/charset/INSERT 值逐字（规格 §2.1/§2.2）', async () => {
    const statements: string[] = [];
    await new PlatformConfig1789200000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    // 现有库形态下容器启动可重跑（`migrationsRun`）
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `platform_config`');
    // 逐列**完整定义**（spec §2.1 五列）
    for (const column of [
      '`key` varchar(64) NOT NULL',
      '`value` json NOT NULL',
      '`version` bigint NOT NULL DEFAULT 1',
      '`updated_at` datetime(3) NOT NULL',
      '`updated_by` varchar(64) NOT NULL',
    ]) {
      expect(sql, `迁移里缺少列定义 ${column}`).toContain(column);
    }
    expect(sql).toContain('PRIMARY KEY (`key`)');
    expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：不得悄悄多出一列（列数 = 5）
    expect(
      sql.match(/`(key|value|version|updated_at|updated_by)` (varchar|json|bigint|datetime)/g),
    ).toHaveLength(5);

    // 九键种子：每行逐字（值/version=1/updated_by='seed'），且逐行都在
    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    for (const [key, value] of EXPECTED_SEED) {
      expect(sql, `种子缺少/写错了 ${key}`).toContain(`('${key}', '${value}', 1, NOW(3), 'seed')`);
    }
    // 反向：不得悄悄多塞一行（VALUES 元组数 = 9）
    expect(sql.match(/\('(?:robot|room|game)\.[A-Za-z]+',/g)).toHaveLength(9);
    // 🔴 裁决 8：好友房开关种子必须是 false（fresh 态 = 默认关的证据链起点）
    expect(sql).toContain("('room.friendRoomEnabled', 'false', 1, NOW(3), 'seed')");
  });

  it('⑤ 迁移类满足 TypeORM 的形状（name/up/down），down 是它的逆操作', async () => {
    const migration = new PlatformConfig1789200000000();
    expect(migration.name).toBe('PlatformConfig1789200000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    expect(statements.join('\n')).toContain('DROP TABLE IF EXISTS `platform_config`');
  });
});

describe('记录片第 10 键种子迁移（记录片规格 §2.4：record.retentionDays = 365）', () => {
  it('⑥ up()：恰一行 INSERT —— record.retentionDays=365、version=1、updated_by=seed（值字面量逐字）', async () => {
    const statements: string[] = [];
    await new RecordRetention1789500000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain("('record.retentionDays', '365', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键（INSERT 恰一条、VALUES 元组恰一个）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('(?:robot|room|game|record)\.[A-Za-z]+',/g)).toHaveLength(1);
  });

  it('⑥′ 形状（name/up/down）；down = 删该行（第 10 键退场）', async () => {
    const migration = new RecordRetention1789500000000();
    expect(migration.name).toBe('RecordRetention1789500000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    expect(flatten(statements.join('\n'))).toContain(
      "DELETE FROM `platform_config` WHERE `key` = 'record.retentionDays'",
    );
  });

  it('⑥″ 两个迁移的时间戳单调：RecordRetention 晚于 PlatformConfig（同库内按序执行的前提）', () => {
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(new RecordRetention1789500000000())).toBeGreaterThan(
      ts(new PlatformConfig1789200000000()),
    );
  });
});

describe('货币核心第 11 键种子迁移（货币核心规格 §2.8：currency.signupGrant = 0）', () => {
  it('⑦ up()：恰一行 INSERT —— currency.signupGrant=0、version=1、updated_by=seed（值字面量逐字）', async () => {
    const statements: string[] = [];
    await new SignupGrant1789700000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain("('currency.signupGrant', '0', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键（INSERT 恰一条、VALUES 元组恰一个）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('(?:robot|room|game|record|currency)\.[A-Za-z]+',/g)).toHaveLength(1);
  });

  it('⑦′ 形状（name/up/down）；down = 删该行（第 11 键退场）', async () => {
    const migration = new SignupGrant1789700000000();
    expect(migration.name).toBe('SignupGrant1789700000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    expect(flatten(statements.join('\n'))).toContain(
      "DELETE FROM `platform_config` WHERE `key` = 'currency.signupGrant'",
    );
  });

  it('⑦″ 三个迁移的时间戳单调：SignupGrant 晚于 RecordRetention 晚于 PlatformConfig（同库内按序执行的前提）', () => {
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(new SignupGrant1789700000000())).toBeGreaterThan(
      ts(new RecordRetention1789500000000()),
    );
  });
});

describe('② 金币场第 12–17 键种子迁移（② 金币场规格 §1.1：六值逐字）', () => {
  it('⑧ up()：恰一条 INSERT、六个 VALUE 元组 —— 六键值字面量逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new GoldRoom1789800000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 六键逐字（规格 §1.1 种子列；`'true'`/`'10'` 是 JSON 字面量，不是字符串值）——
    // `room.goldRoomEnabled` 经 2026-10-04 用户裁决翻为 'true'（原 'false' 暗上线）
    expect(sql).toContain("('room.freeRoomEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql).toContain("('room.goldRoomEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql).toContain("('currency.entryMultiplier', '10', 1, NOW(3), 'seed')");
    expect(sql).toContain("('currency.rakePercent', '0', 1, NOW(3), 'seed')");
    expect(sql).toContain("('currency.reliefEnabled', 'false', 1, NOW(3), 'seed')");
    expect(sql).toContain("('currency.reliefAmount', '200', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键 —— INSERT 恰一条、VALUES 元组恰六个（且都落在 room./currency.）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('(?:room|currency)\.[A-Za-z]+',/g)).toHaveLength(6);
    expect(sql.match(/\('(?:robot|game|record)\./g)).toBeNull();
  });

  it('⑧′ 形状（name/up/down）；down = 删该六行（第 12–17 键退场），IN 名单恰六键', async () => {
    const migration = new GoldRoom1789800000000();
    expect(migration.name).toBe('GoldRoom1789800000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain('DELETE FROM `platform_config` WHERE `key` IN');
    for (const key of [
      'room.freeRoomEnabled',
      'room.goldRoomEnabled',
      'currency.entryMultiplier',
      'currency.rakePercent',
      'currency.reliefEnabled',
      'currency.reliefAmount',
    ]) {
      expect(sql, `down 未覆盖 ${key}`).toContain(`'${key}'`);
    }
    // 反向：恰六键（防顺手多删）
    expect(sql.match(/'(?:room|currency)\.[A-Za-z]+'/g)).toHaveLength(6);
  });

  it('⑧″ 四个迁移的时间戳单调：GoldRoom 晚于 SignupGrant（同库内按序执行的前提）', () => {
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(new GoldRoom1789800000000())).toBeGreaterThan(
      ts(new SignupGrant1789700000000()),
    );
  });
});

/** 仓库根（`packages/config-service/test/` 往上三层）。 */
const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)), '..', '..');

describe('③ T2 管理员四表迁移（规格 §2.2 = 设计 §3 DDL 逐字；判据 C1）', () => {
  /**
   * 四表 DDL 的**全文**（flatten 后逐字）—— 不是 `toContain('username')` 那种弱断言：
   * 一条语句与期望串**全文相等**，列顺序/类型/NULL 性/DEFAULT/索引/引擎/字符集改一个字符就红。
   */
  const EXPECTED_UP = [
    'CREATE TABLE IF NOT EXISTS `admin_accounts` ( ' +
      '`id` bigint NOT NULL AUTO_INCREMENT, ' +
      '`username` varchar(32) NOT NULL, ' +
      '`password_hash` varchar(255) NOT NULL, ' +
      '`role` varchar(16) NOT NULL, ' +
      "`status` varchar(10) NOT NULL DEFAULT 'active', " +
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
      '`last_login_at` datetime(3) NULL, ' +
      'PRIMARY KEY (`id`), ' +
      'UNIQUE KEY `uk_admin_username` (`username`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'CREATE TABLE IF NOT EXISTS `admin_login_events` ( ' +
      '`id` bigint NOT NULL AUTO_INCREMENT, ' +
      '`username` varchar(32) NOT NULL, ' +
      '`account_id` bigint NULL, ' +
      '`ip` varchar(64) NULL, ' +
      '`success` tinyint(1) NOT NULL, ' +
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      'PRIMARY KEY (`id`), ' +
      'KEY `idx_login_events_created` (`created_at`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'CREATE TABLE IF NOT EXISTS `config_changes` ( ' +
      '`id` bigint NOT NULL AUTO_INCREMENT, ' +
      '`key` varchar(64) NOT NULL, ' +
      '`old_value` json NULL, ' +
      '`new_value` json NOT NULL, ' +
      '`actor` varchar(32) NOT NULL, ' +
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      'PRIMARY KEY (`id`), ' +
      'KEY `idx_config_changes_key` (`key`, `id`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'CREATE TABLE IF NOT EXISTS `admin_account_changes` ( ' +
      '`id` bigint NOT NULL AUTO_INCREMENT, ' +
      '`target_id` bigint NOT NULL, ' +
      '`username` varchar(32) NOT NULL, ' +
      '`action` varchar(16) NOT NULL, ' +
      '`detail` json NULL, ' +
      '`actor` varchar(32) NOT NULL, ' +
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      'PRIMARY KEY (`id`), ' +
      'KEY `idx_account_changes_target` (`target_id`, `id`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  ];

  it('⑨ up()：恰四条 CREATE TABLE，逐表全文逐字（列/主键/唯一键/索引/引擎字符集）', async () => {
    const statements: string[] = [];
    await new AdminRbac1789900000000().up(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual(EXPECTED_UP);
  });

  it('⑨′ down()：逆序 DROP 四表（admin_account_changes → config_changes → admin_login_events → admin_accounts）', async () => {
    const statements: string[] = [];
    await new AdminRbac1789900000000().down(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual([
      'DROP TABLE IF EXISTS `admin_account_changes`',
      'DROP TABLE IF EXISTS `config_changes`',
      'DROP TABLE IF EXISTS `admin_login_events`',
      'DROP TABLE IF EXISTS `admin_accounts`',
    ]);
  });

  it('⑨″ 形状（name/up/down）；迁移号 1789900000000 晚于 GoldRoom 且全仓（含其它服务）唯一', () => {
    const migration = new AdminRbac1789900000000();
    expect(migration.name).toBe('AdminRbac1789900000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = GoldRoom 1789800000000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new GoldRoom1789800000000()));

    // 全仓唯一：所有服务 `src/migrations/` 里含该时间戳的导出类**恰好一个**
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1789900000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/AdminRbac1789900000000']);
  });
});

describe('风控片第 18–25 键种子迁移（风控规格 §2.1-3：八值逐字）', () => {
  it('⑩ up()：恰一条 INSERT、八个 VALUE 元组 —— 八键值字面量逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new RiskConfigSeed1790000001000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 八键逐字（规格 §2.1-3 种子列；`'false'`/`'0.8'`/`'100'` 是 JSON 字面量，不是字符串值）
    expect(sql).toContain("('risk.predicate.sameDevice', 'false', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.predicate.sameIp', 'false', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.winRateThreshold', '0.8', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.minGames', '100', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.deviceLimit', '3', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.deviceWindowDays', '30', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.autoThrottle', 'true', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.deviceRetentionDays', '365', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键 —— INSERT 恰一条、VALUES 元组恰八个（且都落在 risk.）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('risk\.[A-Za-z.]+',/g)).toHaveLength(8);
    expect(sql.match(/\('(?:robot|room|game|record|currency)\./g)).toBeNull();
  });

  it('⑩′ 形状（name/up/down）；down = 删该八行（第 18–25 键退场），IN 名单恰八键', async () => {
    const migration = new RiskConfigSeed1790000001000();
    expect(migration.name).toBe('RiskConfigSeed1790000001000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain('DELETE FROM `platform_config` WHERE `key` IN');
    for (const key of [
      'risk.predicate.sameDevice',
      'risk.predicate.sameIp',
      'risk.winRateThreshold',
      'risk.minGames',
      'risk.deviceLimit',
      'risk.deviceWindowDays',
      'risk.autoThrottle',
      'risk.deviceRetentionDays',
    ]) {
      expect(sql, `down 未覆盖 ${key}`).toContain(`'${key}'`);
    }
    // 反向：恰八键（防顺手多删）
    expect(sql.match(/'risk\.[A-Za-z.]+'/g)).toHaveLength(8);
  });

  it('⑩″ 五个迁移的时间戳单调：RiskConfigSeed 晚于 GoldRoom（同库内按序执行的前提）', () => {
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(new RiskConfigSeed1790000001000())).toBeGreaterThan(
      ts(new GoldRoom1789800000000()),
    );
    // 真正承重的一跳：按时间戳执行时「前一个」是 AdminRbac（1789900000000，GoldRoom 之后、
    // 本迁移之前）—— 不晚于它则「按序执行」的链条断在这一跳。
    expect(ts(new RiskConfigSeed1790000001000())).toBeGreaterThan(
      ts(new AdminRbac1789900000000()),
    );
  });
});

describe('支付片第 26–34 键种子迁移（支付规格 §2.5：九值逐字）', () => {
  it('⑪ up()：恰一条 INSERT、九个 VALUE 元组 —— 九键值字面量逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new PayConfigSeed1791000001000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 九键逐字（规格 §2.5 种子列；`'false'`/`'100'`/`'[6,30,68,128,328]'` 是 JSON 字面量，不是字符串值）
    expect(sql).toContain("('pay.rechargeEnabled', 'false', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.withdrawEnabled', 'false', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.coinPerYuan', '100', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.rechargePackages', '[6,30,68,128,328]', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.withdrawMinCoins', '1000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.withdrawMaxCoinsPerOrder', '50000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.withdrawDailyMaxCoins', '100000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.orderExpireMinutes', '30', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.withdrawTimeoutMinutes', '4320', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键 —— INSERT 恰一条、VALUES 元组恰九个（且都落在 pay.）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('pay\.[A-Za-z]+',/g)).toHaveLength(9);
    expect(sql.match(/\('(?:robot|room|game|record|currency|risk)\./g)).toBeNull();
  });

  it('⑪′ 形状（name/up/down）；down = 删该九行（第 26–34 键退场），IN 名单恰九键', async () => {
    const migration = new PayConfigSeed1791000001000();
    expect(migration.name).toBe('PayConfigSeed1791000001000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain('DELETE FROM `platform_config` WHERE `key` IN');
    for (const key of [
      'pay.rechargeEnabled',
      'pay.withdrawEnabled',
      'pay.coinPerYuan',
      'pay.rechargePackages',
      'pay.withdrawMinCoins',
      'pay.withdrawMaxCoinsPerOrder',
      'pay.withdrawDailyMaxCoins',
      'pay.orderExpireMinutes',
      'pay.withdrawTimeoutMinutes',
    ]) {
      expect(sql, `down 未覆盖 ${key}`).toContain(`'${key}'`);
    }
    // 反向：恰九键（防顺手多删）
    expect(sql.match(/'pay\.[A-Za-z]+'/g)).toHaveLength(9);
  });

  it('⑪″ 六个迁移的时间戳单调：PayConfigSeed 晚于 RiskConfigSeed（同库内按序执行的前提）', () => {
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(new PayConfigSeed1791000001000())).toBeGreaterThan(
      ts(new RiskConfigSeed1790000001000()),
    );
  });
});

describe('支付配置管理化 T2：渠道表迁移 + 假库扩表（规格 §2.2 DDL 逐字；无种子）', () => {
  /**
   * §2.2 DDL 的**全文**（flatten 后逐字；照 ⑨ 的形态）—— 一条语句与期望串**全文相等**，
   * 列顺序/类型/NULL 性/DEFAULT/主键/引擎字符集改一个字符就红。
   */
  const EXPECTED_UP = [
    'CREATE TABLE IF NOT EXISTS `pay_channel_config` ( ' +
      '`key` varchar(64) NOT NULL, ' +
      '`value_enc` text NOT NULL, ' +
      '`fingerprint` char(12) NOT NULL, ' +
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      '`updated_by` varchar(64) NOT NULL, ' +
      'PRIMARY KEY (`key`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  ];

  it('⑫ up()：恰一条 CREATE TABLE、逐字全文相等；**无种子**（反向：无任何 INSERT）', async () => {
    const statements: string[] = [];
    await new PayChannelConfig1792000000000().up(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual(EXPECTED_UP);
    // 出厂 = 未配置（规格 §2.2「无种子」）：up() 不得顺手种任何行
    expect(statements.join('\n')).not.toContain('INSERT');
  });

  it('⑫′ down()：DROP TABLE IF EXISTS `pay_channel_config`（恰一条）', async () => {
    const statements: string[] = [];
    await new PayChannelConfig1792000000000().down(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual([
      'DROP TABLE IF EXISTS `pay_channel_config`',
    ]);
  });

  it('⑫″ 形状（name/up/down）；迁移号 1792000000000 晚于 PayConfigSeed 且全仓唯一', () => {
    const migration = new PayChannelConfig1792000000000();
    expect(migration.name).toBe('PayChannelConfig1792000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = PayConfigSeed 1791000001000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new PayConfigSeed1791000001000()));

    // 全仓唯一（照 ⑨″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1792000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/PayChannelConfig1792000000000']);
  });

  it('⑫‴ 假库 smoke（T4 首度行使前的往返预演）：锁读 → ODKU 写入 → 回读/LIST → 留痕 → DELETE 幂等', async () => {
    const db = new FakePayChannelDb();
    db.now = new Date('2026-10-06T00:00:00.000Z');

    // 无行 ⇒ 空集（锁定读按既有形态：不建模真锁，只做 SELECT 语义）
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_LOCK_SQL, ['pay.channel.appId'])).toEqual([]);

    // T4 写事务三段（锁 → ODKU upsert → 留痕）同走 transaction(em) 分发
    await db.dataSource.transaction(async (em) => {
      await em.query(SPEC_PAY_CHANNEL_LOCK_SQL, ['pay.channel.appId']);
      await em.query(SPEC_PAY_CHANNEL_UPSERT_SQL, [
        'pay.channel.appId',
        'v1:AAAA',
        'aabbccddeeff',
        'root',
      ]);
      await em.query(CONFIG_CHANGES_INSERT_SQL, [
        'pay.channel.appId',
        null,
        JSON.stringify('9021'),
        'root',
      ]);
    });
    expect(db.rows.get('pay.channel.appId')).toEqual({
      value_enc: 'v1:AAAA',
      fingerprint: 'aabbccddeeff',
      updated_at: db.now,
      updated_by: 'root',
    });

    // 往返（SELECT）：恰 [value_enc, fingerprint] 两列（与 §2.2 锁定读列单一致）
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_LOCK_SQL, ['pay.channel.appId'])).toEqual([
      { value_enc: 'v1:AAAA', fingerprint: 'aabbccddeeff' },
    ]);

    // ODKU 覆盖分支：同键再写 ⇒ 仍一行、四列被覆盖（updated_at 取当刻代面）
    db.now = new Date('2026-10-06T00:00:01.000Z');
    expect(
      await db.dataSource.query(SPEC_PAY_CHANNEL_UPSERT_SQL, [
        'pay.channel.appId',
        'v1:BBBB',
        '112233445566',
        'ops',
      ]),
    ).toEqual({ affectedRows: 2, insertId: 0 });
    expect(db.rows.size).toBe(1);
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_LIST_SQL)).toEqual([
      {
        key: 'pay.channel.appId',
        value_enc: 'v1:BBBB',
        fingerprint: '112233445566',
        updated_at: db.now,
        updated_by: 'ops',
      },
    ]);

    // 留痕按 mysql2 形态往返（JSON 串进、解析值出）
    expect(db.changes).toEqual([
      { key: 'pay.channel.appId', oldValue: null, newValue: '9021', actor: 'root' },
    ]);

    // DELETE：命中 ⇒ affectedRows 1 且行消失；再删 ⇒ 0（幂等 —— clear() 的 T4 语义面）
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_DELETE_SQL, ['pay.channel.appId'])).toEqual({
      affectedRows: 1,
    });
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_LOCK_SQL, ['pay.channel.appId'])).toEqual([]);
    expect(await db.dataSource.query(SPEC_PAY_CHANNEL_DELETE_SQL, ['pay.channel.appId'])).toEqual({
      affectedRows: 0,
    });
  });
});

describe('通知通道管理化 T2：通知凭据表迁移 + 假库扩表（规格 §2.2 DDL 逐字；无种子）', () => {
  /**
   * §2.2 DDL 的**全文**（flatten 后逐字；照 ⑫ 的形态）—— 一条语句与期望串**全文相等**，
   * 列顺序/类型/NULL 性/DEFAULT/主键/引擎字符集改一个字符就红。
   */
  const EXPECTED_UP = [
    'CREATE TABLE IF NOT EXISTS `notify_channel_config` ( ' +
      '`key` varchar(64) NOT NULL, ' +
      '`value_enc` text NOT NULL, ' +
      '`fingerprint` char(12) NOT NULL, ' +
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      '`updated_by` varchar(64) NOT NULL, ' +
      'PRIMARY KEY (`key`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  ];

  it('⑬ up()：恰一条 CREATE TABLE、逐字全文相等；**无种子**（反向：无任何 INSERT）', async () => {
    const statements: string[] = [];
    await new NotifyChannelConfig1793000000000().up(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual(EXPECTED_UP);
    // 出厂 = 未配置（规格 §2.2「无种子」）：up() 不得顺手种任何行
    expect(statements.join('\n')).not.toContain('INSERT');
  });

  it('⑬′ down()：DROP TABLE IF EXISTS `notify_channel_config`（恰一条）', async () => {
    const statements: string[] = [];
    await new NotifyChannelConfig1793000000000().down(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual([
      'DROP TABLE IF EXISTS `notify_channel_config`',
    ]);
  });

  it('⑬″ 形状（name/up/down）；迁移号 1793000000000 晚于 PayChannelConfig 且全仓唯一', () => {
    const migration = new NotifyChannelConfig1793000000000();
    expect(migration.name).toBe('NotifyChannelConfig1793000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = PayChannelConfig 1792000000000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new PayChannelConfig1792000000000()));

    // 全仓唯一（照 ⑫″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1793000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/NotifyChannelConfig1793000000000']);
  });

  it('⑬‴ 假库 smoke（T5 首度行使前的往返预演）：锁读 → ODKU 写入 → 回读/LIST → 留痕 → DELETE 幂等', async () => {
    const db = new FakeNotifyChannelDb();
    db.now = new Date('2026-10-07T00:00:00.000Z');

    // 无行 ⇒ 空集（锁定读按既有形态：不建模真锁，只做 SELECT 语义）
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_LOCK_SQL, ['notify.smtp.pass'])).toEqual(
      [],
    );

    // T5 写事务三段（锁 → ODKU upsert → 留痕）同走 transaction(em) 分发
    await db.dataSource.transaction(async (em) => {
      await em.query(SPEC_NOTIFY_CHANNEL_LOCK_SQL, ['notify.smtp.pass']);
      await em.query(SPEC_NOTIFY_CHANNEL_UPSERT_SQL, [
        'notify.smtp.pass',
        'v1:AAAA',
        'aabbccddeeff',
        'root',
      ]);
      await em.query(CONFIG_CHANGES_INSERT_SQL, [
        'notify.smtp.pass',
        null,
        // 密键留痕 = §3.1 的 redacted 形态（值不外泄）——同时行使「非字符串 JSON 值」往返
        JSON.stringify({ redacted: true, fingerprint: 'aabbccddeeff' }),
        'root',
      ]);
    });
    expect(db.rows.get('notify.smtp.pass')).toEqual({
      value_enc: 'v1:AAAA',
      fingerprint: 'aabbccddeeff',
      updated_at: db.now,
      updated_by: 'root',
    });

    // 往返（SELECT）：恰 [value_enc, fingerprint] 两列（与 §2.2 锁定读列单一致）
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_LOCK_SQL, ['notify.smtp.pass'])).toEqual([
      { value_enc: 'v1:AAAA', fingerprint: 'aabbccddeeff' },
    ]);

    // ODKU 覆盖分支：同键再写 ⇒ 仍一行、四列被覆盖（updated_at 取当刻代面）
    db.now = new Date('2026-10-07T00:00:01.000Z');
    expect(
      await db.dataSource.query(SPEC_NOTIFY_CHANNEL_UPSERT_SQL, [
        'notify.smtp.pass',
        'v1:BBBB',
        '112233445566',
        'ops',
      ]),
    ).toEqual({ affectedRows: 2, insertId: 0 });
    expect(db.rows.size).toBe(1);
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_LIST_SQL)).toEqual([
      {
        key: 'notify.smtp.pass',
        value_enc: 'v1:BBBB',
        fingerprint: '112233445566',
        updated_at: db.now,
        updated_by: 'ops',
      },
    ]);

    // 留痕按 mysql2 形态往返（JSON 串进、解析值出）
    expect(db.changes).toEqual([
      {
        key: 'notify.smtp.pass',
        oldValue: null,
        newValue: { redacted: true, fingerprint: 'aabbccddeeff' },
        actor: 'root',
      },
    ]);

    // DELETE：命中 ⇒ affectedRows 1 且行消失；再删 ⇒ 0（幂等 —— clear() 的 T5 语义面）
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_DELETE_SQL, ['notify.smtp.pass'])).toEqual(
      {
        affectedRows: 1,
      },
    );
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_LOCK_SQL, ['notify.smtp.pass'])).toEqual(
      [],
    );
    expect(await db.dataSource.query(SPEC_NOTIFY_CHANNEL_DELETE_SQL, ['notify.smtp.pass'])).toEqual(
      {
        affectedRows: 0,
      },
    );
  });
});

describe('IntervalConfigSeed1794000000000：第 35–40 键种子迁移', () => {
  it('⑭ up()：恰一条 INSERT、六个 VALUE 元组 —— 六键值字面量逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new IntervalConfigSeed1794000000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 六键逐字（规格 ⚙️1 种子列；`'60000'`/`'3600000'` 是 JSON 字面量，不是字符串值）
    expect(sql).toContain("('pay.scanIntervalMs', '60000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('pay.reconcileIntervalMs', '86400000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('currency.reconcileIntervalMs', '3600000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.scanIntervalMs', '3600000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('risk.devicesCleanupIntervalMs', '3600000', 1, NOW(3), 'seed')");
    expect(sql).toContain("('record.cleanupIntervalMs', '3600000', 1, NOW(3), 'seed')");
    // 反向：不得在种子迁移里顺手塞别的键 —— INSERT 恰一条、VALUES 元组恰六个（且都落在本片四族）
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('(?:pay|currency|risk|record)\.[A-Za-z]+',/g)).toHaveLength(6);
    expect(sql.match(/\('(?:robot|room|game)\./g)).toBeNull();
    // 行数恰 6：六条元组恰六次以 `NOW(3), 'seed')` 收尾
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(6);
  });

  it('⑭′ 形状（name/up/down）；down = 删该六行（第 35–40 键退场），IN 名单恰六键', async () => {
    const migration = new IntervalConfigSeed1794000000000();
    expect(migration.name).toBe('IntervalConfigSeed1794000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain('DELETE FROM `platform_config` WHERE `key` IN');
    for (const key of [
      'pay.scanIntervalMs',
      'pay.reconcileIntervalMs',
      'currency.reconcileIntervalMs',
      'risk.scanIntervalMs',
      'risk.devicesCleanupIntervalMs',
      'record.cleanupIntervalMs',
    ]) {
      expect(sql, `down 未覆盖 ${key}`).toContain(`'${key}'`);
    }
    // 反向：恰六键（防顺手多删）
    expect(sql.match(/'(?:pay|currency|risk|record)\.[A-Za-z]+'/g)).toHaveLength(6);
  });

  it('⑭″ 形状（name/up/down）；迁移号 1794000000000 晚于 NotifyChannelConfig 且全仓唯一', () => {
    const migration = new IntervalConfigSeed1794000000000();
    expect(migration.name).toBe('IntervalConfigSeed1794000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = NotifyChannelConfig 1793000000000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new NotifyChannelConfig1793000000000()));

    // 全仓唯一（照 ⑬″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1794000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/IntervalConfigSeed1794000000000']);
  });
});

describe('AdReliefAdpidSeed1795100000000：第 41 键种子迁移（string JSON 字面量首例）', () => {
  it('⑮ up()：恰一条 INSERT、一个 VALUE 元组 —— ad.reliefAdpid 值 `""` 逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new AdReliefAdpidSeed1795100000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 第 41 键逐字（规格 ⚙️：`'""'` 是 JSON **string** 字面量 —— 空串（不是空值/null），
    // 数值先例 `'60000'` 会误导；空串语义 = 未配置 ⇒ 救助入口不渲染，暗上线）。
    expect(sql).toContain(`('ad.reliefAdpid', '""', 1, NOW(3), 'seed')`);
    expect(sql).toContain(`'""'`);
    // 反向：不得在种子迁移里顺手塞别的键 —— INSERT 恰一条、ad 族元组恰一个、外族零命中
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('ad\.[A-Za-z]+',/g)).toHaveLength(1);
    expect(sql.match(/\('(?:robot|room|game|pay|currency|risk|record|notify)\./g)).toBeNull();
    // 行数恰 1：唯一元组以 `NOW(3), 'seed')` 收尾
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑮′ 形状（name/up/down）；down = 删该行（第 41 键退场），单键精确匹配', async () => {
    const migration = new AdReliefAdpidSeed1795100000000();
    expect(migration.name).toBe('AdReliefAdpidSeed1795100000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    await migration.down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    // 单行删除（单元组 ⇒ 单键 = 形态，不用 IN 名单）
    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'ad.reliefAdpid'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    // 反向：只点这一键（防顺手多删）
    expect(sql.match(/'(?:robot|room|game|pay|currency|risk|record|notify|ad)\./g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑮″ 形状（name/up/down）；迁移号 1795100000000 晚于 IntervalConfigSeed 且全仓唯一', () => {
    const migration = new AdReliefAdpidSeed1795100000000();
    expect(migration.name).toBe('AdReliefAdpidSeed1795100000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一种子迁移 = IntervalConfigSeed 1794000000000；
    // 1795000000000 表迁移（T5）号段在前、本键种子随后）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new IntervalConfigSeed1794000000000()));

    // 全仓唯一（照 ⑭″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795100000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/AdReliefAdpidSeed1795100000000']);
  });
});

describe('广告片 T5：`ad_channel_config` 表迁移（DDL 逐字照通知片；无种子）', () => {
  /**
   * §2.3 DDL 的**全文**（flatten 后逐字；照 ⑬ 的形态）—— 一条语句与期望串**全文相等**，
   * 列顺序/类型/NULL 性/DEFAULT/主键/引擎字符集改一个字符就红；与通知片先例仅表名不同。
   */
  const EXPECTED_UP = [
    'CREATE TABLE IF NOT EXISTS `ad_channel_config` ( ' +
      '`key` varchar(64) NOT NULL, ' +
      '`value_enc` text NOT NULL, ' +
      '`fingerprint` char(12) NOT NULL, ' +
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      '`updated_by` varchar(64) NOT NULL, ' +
      'PRIMARY KEY (`key`) ' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  ];

  it('⑯ up()：恰一条 CREATE TABLE、逐字全文相等；**无种子**（反向：无任何 INSERT）', async () => {
    const statements: string[] = [];
    await new AdChannelConfig1795000000000().up(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual(EXPECTED_UP);
    // 出厂 = 未配置（规格 §2.3「无种子」）：up() 不得顺手种任何行
    expect(statements.join('\n')).not.toContain('INSERT');
  });

  it('⑯′ down()：DROP TABLE IF EXISTS `ad_channel_config`（恰一条）', async () => {
    const statements: string[] = [];
    await new AdChannelConfig1795000000000().down(fakeRunner(statements));

    expect(statements.map((s) => flatten(s).trim())).toEqual([
      'DROP TABLE IF EXISTS `ad_channel_config`',
    ]);
  });

  it('⑯″ 形状（name/up/down）；迁移号 1795000000000 晚于 IntervalConfigSeed 且全仓唯一', () => {
    const migration = new AdChannelConfig1795000000000();
    expect(migration.name).toBe('AdChannelConfig1795000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = IntervalConfigSeed 1794000000000；
    // 号段落在 1795100000000 第 41 键种子之前 —— 见 ⑮″ 注释之钉序）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new IntervalConfigSeed1794000000000()));
    expect(ts(migration)).toBeLessThan(ts(new AdReliefAdpidSeed1795100000000()));

    // 全仓唯一（照 ⑮″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/AdChannelConfig1795000000000']);
  });
});

describe('EntryFeePercentsSeed1795200000000：第 42 键种子迁移（4 行 ×0 —— 暗上线）', () => {
  it('⑰ up()：恰一条 INSERT、一个 VALUE 元组 —— 值 JSON 数组逐字（键序 baseScore→percent）、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new EntryFeePercentsSeed1795200000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 第 42 键逐字：4 行 × percent 0（与档位表同形；空表也合法但出厂形 = 4 行，管理页即刻可见）。
    expect(sql).toContain(
      `('currency.entryFeePercents', '[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]', 1, NOW(3), 'seed')`,
    );
    // 反向：不得顺手塞别的键 —— INSERT 恰一条、currency 族元组恰一个、外族零命中。
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('currency\.[A-Za-z]+',/g)).toHaveLength(1);
    expect(sql.match(/\('(?:robot|room|game|pay|risk|record|notify|ad)\./g)).toBeNull();
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑰′ down()：删该行（第 42 键退场），单键精确匹配', async () => {
    const statements: string[] = [];
    await new EntryFeePercentsSeed1795200000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'currency.entryFeePercents'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql.match(/'(?:robot|room|game|pay|risk|record|notify|ad|currency)\./g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑰″ 形状（name/up/down）；迁移号 1795200000000 晚于 AdReliefAdpidSeed 且全仓唯一', () => {
    const migration = new EntryFeePercentsSeed1795200000000();
    expect(migration.name).toBe('EntryFeePercentsSeed1795200000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new AdReliefAdpidSeed1795100000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795200000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/EntryFeePercentsSeed1795200000000']);
  });
});

describe('ClientAccessGateSeed1795300000000：第 43/44 键种子迁移（双 `true` —— 暗上线 = 全开）', () => {
  it('⑱ up()：恰一条 INSERT、两个 VALUE 元组 —— 两键值 `true` 逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new ClientAccessGateSeed1795300000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 第 43/44 键逐字：`'true'` 是 JSON 字面量（严格 boolean 族种子先例，同 `robot.ruleFallback`）；
    // 双 true = 暗上线全开（行为与今天逐字节一致，整端准入闸要显式关才咬）。
    expect(sql).toContain("('client.appEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql).toContain("('client.h5Enabled', 'true', 1, NOW(3), 'seed')");
    // 反向：不得顺手塞别的键 —— INSERT 恰一条、client 族元组恰两个、外族零命中。
    // ⚠️ 段模式须容数字（`h5Enabled` 的段以字母开头、体内含数字——`[A-Za-z]+` 会漏半个键）。
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('client\.[A-Za-z][A-Za-z0-9]*',/g)).toHaveLength(2);
    expect(sql.match(/\('(?:robot|room|game|pay|risk|record|notify|ad|currency)\./g)).toBeNull();
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(2);
    expect(statements).toHaveLength(1);
  });

  it('⑱′ down()：删该两行（第 43/44 键退场），IN 名单恰两键', async () => {
    const statements: string[] = [];
    await new ClientAccessGateSeed1795300000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain('DELETE FROM `platform_config` WHERE `key` IN');
    for (const key of ['client.appEnabled', 'client.h5Enabled']) {
      expect(sql, `down 未覆盖 ${key}`).toContain(`'${key}'`);
    }
    // 反向：恰两键（防顺手多删）
    expect(sql.match(/'(?:robot|room|game|pay|risk|record|notify|ad|currency|client)\./g)).toHaveLength(2);
    expect(statements).toHaveLength(1);
  });

  it('⑱″ 形状（name/up/down）；迁移号 1795300000000 晚于 EntryFeePercentsSeed 且全仓唯一', () => {
    const migration = new ClientAccessGateSeed1795300000000();
    expect(migration.name).toBe('ClientAccessGateSeed1795300000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = EntryFeePercentsSeed 1795200000000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new EntryFeePercentsSeed1795200000000()));

    // 全仓唯一（照 ⑰″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795300000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/ClientAccessGateSeed1795300000000']);
  });
});

// ⚠️ 合并期新增：本片（机器人补位开关）与「客户端接入片」在各自分支上**撞了同一个时间戳
// 1795300000000** ⇒ 合并裁决 = 主线保留 1795300000000，本片让位改 **1795400000000**。
// 下面这块由 `feature/daily-rescue` 带来，随改号同步（类名 / name / 扫描常量 / 断言文案）。
describe('BotFillConfigSeed1795400000000：第 45–47 键种子迁移（双开关 true + 上限 300000 —— 暗上线）', () => {
  it('⑱ up()：恰一条 INSERT、三个 VALUE 元组 —— JSON 字面量逐字、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new BotFillConfigSeed1795400000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 第 45/46 键：严格 boolean 种子 true（暗上线 = 现状补机器人）。
    expect(sql).toContain("('room.freeBotFillEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql).toContain("('room.goldBotFillEnabled', 'true', 1, NOW(3), 'seed')");
    // 第 47 键：无机器人等待上限 300000ms=5 分钟（int JSON 字面量，不带引号）。
    expect(sql).toContain("('room.matchNoBotMaxWaitMs', '300000', 1, NOW(3), 'seed')");
    // 反向：不得顺手塞别的键 —— INSERT 恰一条、room 族元组恰三个、外族零命中。
    expect(sql.match(/INSERT IGNORE INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/INSERT INTO `platform_config`/g)).toBeNull();
    expect(sql.match(/\('room\.[A-Za-z]+',/g)).toHaveLength(3);
    expect(sql.match(/\('(?:robot|game|pay|risk|record|notify|ad|currency)\./g)).toBeNull();
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(3);
    expect(statements).toHaveLength(1);
  });

  it('⑱′ down()：一次 DELETE 精确清掉这三键', async () => {
    const statements: string[] = [];
    await new BotFillConfigSeed1795400000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      "DELETE FROM `platform_config` WHERE `key` IN " +
        "('room.freeBotFillEnabled', 'room.goldBotFillEnabled', 'room.matchNoBotMaxWaitMs')",
    );
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑱″ 形状（name/up/down）；迁移号 1795400000000 晚于 EntryFeePercentsSeed 且全仓唯一', () => {
    const migration = new BotFillConfigSeed1795400000000();
    expect(migration.name).toBe('BotFillConfigSeed1795400000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    // 时间戳单调：同库内按序执行的前提（前一迁移 = ClientAccessGateSeed 1795300000000）
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new ClientAccessGateSeed1795300000000()));

    // 全仓唯一（照 ⑰″ 的扫描形态）：所有服务 `src/migrations/` 里含该时间戳的导出类恰好一个
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795400000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/BotFillConfigSeed1795400000000']);
  });
});

// ⚠️ 合并期新增：本片（设备绑定）与「客户端接入片」在各自分支上**撞了同一个时间戳
// 1795300000000** ⇒ 合并裁决 = 主线保留 1795300000000，本片让位改 **1795600000000**。
// 下面这块由 `feature/device-binding` 带来，随改号同步（类名 / name / 扫描常量 / 断言文案 / 前驱迁移）。
describe('RiskDeviceBindingSeed1795600000000：第 49 键种子迁移（严格 boolean false —— 暗上线）', () => {
  it('⑱ up()：恰一条 INSERT、一个 VALUE 元组 —— 值 JSON boolean 字面量 false、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new RiskDeviceBindingSeed1795600000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    // 第 49 键逐字：json 列里是裸 false（不是字符串 'false'——严格 boolean 口径）。
    expect(sql).toContain(
      "('risk.deviceBindingEnabled', 'false', 1, NOW(3), 'seed')",
    );
    // 反向：不得顺手塞别的键 —— INSERT 恰一条、risk 族元组恰一个、外族零命中。
    expect(sql.match(/INSERT IGNORE INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/INSERT INTO `platform_config`/g)).toBeNull();
    expect(sql.match(/\('risk\.[A-Za-z.]+',/g)).toHaveLength(1);
    expect(sql.match(/\('(?:robot|room|game|pay|record|notify|ad|currency)\./g)).toBeNull();
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑱′ down()：删该行（第 49 键退场），单键精确匹配', async () => {
    const statements: string[] = [];
    await new RiskDeviceBindingSeed1795600000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'risk.deviceBindingEnabled'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql.match(/'(?:robot|room|game|pay|risk|record|notify|ad|currency)\./g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑱″ 形状（name/up/down）；迁移号 1795600000000 晚于 RiskWithdrawReAuthSeed 且全仓唯一', () => {
    const migration = new RiskDeviceBindingSeed1795600000000();
    expect(migration.name).toBe('RiskDeviceBindingSeed1795600000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new RiskWithdrawReAuthSeed1795500000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795600000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/RiskDeviceBindingSeed1795600000000']);
  });
});

describe('CardCounterSeed1795700000000：第 50 键种子迁移（严格 boolean true —— 保持现状）', () => {
  it('⑲ up()：恰一条 INSERT、单 VALUE、json true、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new CardCounterSeed1795700000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain("('game.cardCounterEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('game\.[A-Za-z.]+',/g)).toHaveLength(1);
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑲′ down()：删该行，单键精确匹配', async () => {
    const statements: string[] = [];
    await new CardCounterSeed1795700000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterEnabled'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql.match(/'(?:robot|room|game|pay|risk|record|notify|ad|currency)\./g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('⑲″ 形状（name/up/down）；迁移号 1795700000000 晚于 RiskDeviceBindingSeed 且全仓唯一', () => {
    const migration = new CardCounterSeed1795700000000();
    expect(migration.name).toBe('CardCounterSeed1795700000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new RiskDeviceBindingSeed1795600000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795700000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/CardCounterSeed1795700000000']);
  });
});

describe('CardCounterPrices1795800000000：第 51/52 键种子迁移（10/100 金币）', () => {
  it('up()：恰一条 INSERT IGNORE、两 VALUE、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new CardCounterPrices1795800000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain("('game.cardCounterPricePerGameCoins', '10', 1, NOW(3), 'seed')");
    expect(sql).toContain("('game.cardCounterPricePerHourCoins', '100', 1, NOW(3), 'seed')");
    expect(sql.match(/INSERT IGNORE INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('game\.[A-Za-z.]+',/g)).toHaveLength(2);
    expect(statements).toHaveLength(1);
  });

  it('down()：删两键（各一次）', async () => {
    const statements: string[] = [];
    await new CardCounterPrices1795800000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterPricePerGameCoins'");
    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterPricePerHourCoins'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(2);
    expect(statements).toHaveLength(2);
  });

  it('形状（name/up/down）；迁移号 1795800000000 晚于 CardCounterSeed 且全仓唯一', () => {
    const migration = new CardCounterPrices1795800000000();
    expect(migration.name).toBe('CardCounterPrices1795800000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new CardCounterSeed1795700000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795800000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/CardCounterPrices1795800000000']);
  });
});

describe('RemoveEntryFeePercents1796000000000：阶段 2 删除旧第 42 键行', () => {
  it('up()：恰一条 DELETE，单键精确匹配', async () => {
    const statements: string[] = [];
    await new RemoveEntryFeePercents1796000000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'currency.entryFeePercents'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql.match(/'(?:robot|room|game|pay|risk|record|notify|ad|client)\./g)).toBeNull();
    expect(statements).toHaveLength(1);
  });

  it('down()：恰一条 INSERT IGNORE，历史四档×0 逐字', async () => {
    const statements: string[] = [];
    await new RemoveEntryFeePercents1796000000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain(
      `('currency.entryFeePercents', '[{"baseScore":15,"percent":0},{"baseScore":80,"percent":0},{"baseScore":480,"percent":0},{"baseScore":1200,"percent":0}]', 1, NOW(3), 'seed')`,
    );
    expect(sql.match(/INSERT IGNORE INTO `platform_config`/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('形状（name/up/down）；迁移号 1796000000000 晚于 CardCounterPrices 且全仓唯一', () => {
    const migration = new RemoveEntryFeePercents1796000000000();
    expect(migration.name).toBe('RemoveEntryFeePercents1796000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new CardCounterPrices1795800000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1796000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/RemoveEntryFeePercents1796000000000']);
  });
});

/**
 * Task 5.1（spec §4.7.1）：跑得快 14 键种子。
 *
 * 判据：恰一条 `INSERT IGNORE`、14 个 VALUE（档位/两开关/11 个规则与计分键），
 * 每条值 = `shared/src/pdk/rules.ts` 的默认值 / 文档默认表；`down` 逐键删除。
 */
describe('MultiGameConfigSeed1796400000000：跑得快 14 键种子', () => {
  it('up()：恰一条 INSERT IGNORE、14 个 VALUE、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new MultiGameConfigSeed1796400000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql).toContain(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql.match(/INSERT IGNORE INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('game\.(?:levels\.)?paodekuai[A-Za-z.]*',/g)).toHaveLength(14);
    expect(statements).toHaveLength(1);

    // 档位表：与斗地主同四档、台费 0（spec §4.7.1）
    expect(sql).toContain(
      `('game.levels.paodekuai', '[{"name":"休闲场","baseScore":15,"entryFeePercent":0},{"name":"标准场","baseScore":80,"entryFeePercent":0},{"name":"竞技场","baseScore":480,"entryFeePercent":0},{"name":"豪侠场","baseScore":1200,"entryFeePercent":0}]', 1, NOW(3), 'seed')`,
    );
    // 开关与规则默认值（与 DEFAULT_PDK_RULES 逐字一致）
    for (const tuple of [
      "('game.paodekuai.enabled', 'false', 1, NOW(3), 'seed')",
      "('game.paodekuai.nonThreePlayerEnabled', 'false', 1, NOW(3), 'seed')",
      "('game.paodekuai.bareTrioEnabled', 'true', 1, NOW(3), 'seed')",
      "('game.paodekuai.trioWithPairEnabled', 'false', 1, NOW(3), 'seed')",
      "('game.paodekuai.bareAirplaneEnabled', 'false', 1, NOW(3), 'seed')",
      "('game.paodekuai.fourWithTwoEnabled', 'true', 1, NOW(3), 'seed')",
      "('game.paodekuai.fourWithTwoPairKickerAllowed', 'false', 1, NOW(3), 'seed')",
      `('game.paodekuai.airplaneWings', '"pairs"', 1, NOW(3), 'seed')`,
      "('game.paodekuai.bombMultiplierEnabled', 'true', 1, NOW(3), 'seed')",
      "('game.paodekuai.guanMultiplierEnabled', 'true', 1, NOW(3), 'seed')",
      "('game.paodekuai.springMultiplierEnabled', 'true', 1, NOW(3), 'seed')",
      "('game.paodekuai.multiplierCap', '64', 1, NOW(3), 'seed')",
      "('game.paodekuai.baobenEnabled', 'true', 1, NOW(3), 'seed')",
    ]) {
      expect(sql, `缺少/写错了 ${tuple}`).toContain(tuple);
    }
  });

  it('down()：逐键删除 14 次（不碰斗地主键）', async () => {
    const statements: string[] = [];
    await new MultiGameConfigSeed1796400000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));

    expect(sql.match(/DELETE FROM/g)).toHaveLength(14);
    expect(sql).not.toContain("'game.baseScoreLevels'");
    expect(statements).toHaveLength(14);
  });

  it('形状（name/up/down）；迁移号 1796400000000 晚于 RemoveEntryFeePercents 且全仓唯一', () => {
    const migration = new MultiGameConfigSeed1796400000000();
    expect(migration.name).toBe('MultiGameConfigSeed1796400000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new RemoveEntryFeePercents1796000000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1796400000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/MultiGameConfigSeed1796400000000']);
  });
});

/**
 * 配置平行化（2026-10-24 / spec §5.2）：JS 驱动复制 + 跑得快种子 + 救助门槛现算。
 * 用内存假库真正执行 `up()` 语义（INSERT IGNORE 幂等），不是只记 SQL 字符串。
 */
describe('SplitGameConfig1796500000000：配置平行化迁移', () => {
  class SplitFakeRunner {
    readonly rows = new Map<string, { value: unknown; version: number }>();
    readonly sqls: string[] = [];

    async query(sql: string, params: unknown[] = []): Promise<unknown> {
      this.sqls.push(sql);
      if (sql.startsWith('SELECT MAX')) {
        return [{ maxVersion: Math.max(0, ...[...this.rows.values()].map((r) => r.version)) }];
      }
      if (sql.startsWith('SELECT')) {
        const keys = params as string[];
        return [...this.rows.entries()]
          .filter(([key]) => keys.includes(key))
          .map(([key, row]) => ({ key, value: row.value, version: row.version }));
      }
      if (sql.startsWith('INSERT IGNORE')) {
        const [key, valueJson, version] = params as [string, string, number];
        if (this.rows.has(key)) return undefined;
        this.rows.set(key, { value: JSON.parse(valueJson), version });
        return undefined;
      }
      if (sql.startsWith('DELETE')) {
        for (const key of params as string[]) this.rows.delete(key);
        return undefined;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  }

  const asRunner = (db: SplitFakeRunner): QueryRunner =>
    db as unknown as QueryRunner;

  function seeded(): SplitFakeRunner {
    const db = new SplitFakeRunner();
    // 故意全部用「非默认值」，证明复制而不是重新种子。
    db.rows.set('room.freeRoomEnabled', { value: false, version: 7 });
    db.rows.set('room.goldRoomEnabled', { value: false, version: 7 });
    db.rows.set('room.friendRoomEnabled', { value: true, version: 7 });
    db.rows.set('room.freeBotFillEnabled', { value: false, version: 7 });
    db.rows.set('room.goldBotFillEnabled', { value: false, version: 7 });
    db.rows.set('currency.rakePercent', { value: 7, version: 7 });
    db.rows.set('currency.entryMultiplier', { value: 20, version: 7 });
    db.rows.set('game.baseScoreLevels', {
      value: [
        { name: '小', baseScore: 1 },
        { name: '大', baseScore: 80 },
      ],
      version: 7,
    });
    db.rows.set('game.cardCounterEnabled', { value: false, version: 7 });
    db.rows.set('game.cardCounterPricePerGameCoins', { value: 5, version: 7 });
    db.rows.set('game.cardCounterPricePerHourCoins', { value: 50, version: 7 });
    db.rows.set('robot.skillDistribution', {
      value: { beginner: 0.5, intermediate: 0.5, advanced: 0 },
      version: 7,
    });
    db.rows.set('robot.ruleFallback', { value: false, version: 7 });
    db.rows.set('robot.modelBySkill', {
      value: { beginner: 'douzero_ADP', intermediate: 'sl', advanced: 'sl' },
      version: 7,
    });
    db.rows.set('risk.winRateThreshold', { value: 0.9, version: 7 });
    db.rows.set('risk.minGames', { value: 50, version: 7 });
    return db;
  }

  it('up()：16 个旧值/版本逐字复制；旧行不动；PDK 跑保守种子；救助门槛现算', async () => {
    const db = seeded();
    await new SplitGameConfig1796500000000().up(asRunner(db));

    for (const [oldKey, newKey] of SPLIT_CONFIG_PAIRS) {
      expect(db.rows.get(newKey), newKey).toEqual(db.rows.get(oldKey));
      expect(db.rows.get(oldKey), oldKey).toEqual(seeded().rows.get(oldKey));
    }
    for (const [key, value] of SPLIT_PDK_SEEDS) {
      expect(db.rows.get(key), key).toEqual({ value, version: 7 });
    }
    // 1 × 20 = 20（不是硬编码 150）
    expect(db.rows.get(RELIEF_THRESHOLD_KEY)).toEqual({ value: 20, version: 7 });
  });

  it('up() 幂等：第二次执行不改任何新键', async () => {
    const db = seeded();
    const migration = new SplitGameConfig1796500000000();
    await migration.up(asRunner(db));
    const snapshot = new Map([...db.rows.entries()].map(([k, v]) => [k, { ...v }]));
    await migration.up(asRunner(db));
    expect(new Map([...db.rows.entries()].map(([k, v]) => [k, { ...v }]))).toEqual(snapshot);
  });

  it('预置新键（值与旧值不同）⇒ up() 保留，不覆盖运营已改的值', async () => {
    const db = seeded();
    db.rows.set('game.doudizhu.friendRoomEnabled', { value: true, version: 9 });
    await new SplitGameConfig1796500000000().up(asRunner(db));
    expect(db.rows.get('game.doudizhu.friendRoomEnabled')).toEqual({ value: true, version: 9 });
    // 未预置的新键仍按旧值复制
    expect(db.rows.get('game.doudizhu.freeRoomEnabled')).toEqual({ value: false, version: 9 });
  });

  it('旧行缺失：新键用 spec §4.3 兜底默认；不因缺失而漏种', async () => {
    const db = new SplitFakeRunner();
    await new SplitGameConfig1796500000000().up(asRunner(db));
    expect(db.rows.get('game.doudizhu.freeRoomEnabled')).toEqual({ value: true, version: 1 });
    expect(db.rows.get('game.doudizhu.friendRoomEnabled')).toEqual({ value: false, version: 1 });
    expect(db.rows.get('game.levels.doudizhu')?.value).toEqual([
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
      { name: '竞技场', baseScore: 480 },
      { name: '豪侠场', baseScore: 1200 },
    ]);
    expect(db.rows.get(RELIEF_THRESHOLD_KEY)).toEqual({ value: 150, version: 1 });
  });

  it('down()：删除本迁移新增的 24 键，旧键全部保留', async () => {
    const db = seeded();
    const before = new Map(db.rows);
    const migration = new SplitGameConfig1796500000000();
    await migration.up(asRunner(db));
    await migration.down(asRunner(db));

    expect(SPLIT_CONFIG_PAIRS.length + SPLIT_PDK_SEEDS.length + 1).toBe(24);
    for (const [oldKey] of SPLIT_CONFIG_PAIRS) {
      expect(db.rows.get(oldKey), oldKey).toEqual(before.get(oldKey));
    }
    for (const [, newKey] of SPLIT_CONFIG_PAIRS) expect(db.rows.has(newKey), newKey).toBe(false);
    for (const [key] of SPLIT_PDK_SEEDS) expect(db.rows.has(key), key).toBe(false);
    expect(db.rows.has(RELIEF_THRESHOLD_KEY)).toBe(false);
  });

  it('computeReliefThreshold：mysql2 返回 JSON 字符串形态也能正确现算', async () => {
    const db = new SplitFakeRunner();
    db.rows.set('game.baseScoreLevels', {
      value: '[{"name":"小","baseScore":5},{"name":"大","baseScore":80}]',
      version: 3,
    });
    db.rows.set('currency.entryMultiplier', { value: '20', version: 3 });
    await new SplitGameConfig1796500000000().up(asRunner(db));
    expect(db.rows.get(RELIEF_THRESHOLD_KEY)).toEqual({ value: 100, version: 3 });
  });

  it('computeReliefThreshold：MIN × 倍率；缺/坏值回落 15 × 10', () => {
    expect(
      computeReliefThreshold([{ name: 'A', baseScore: 80 }, { name: 'B', baseScore: 1 }], 20),
    ).toBe(20);
    expect(computeReliefThreshold(undefined, undefined)).toBe(150);
    expect(computeReliefThreshold([], 20)).toBe(300);
    expect(computeReliefThreshold([{ name: 'A', baseScore: 15 }], '20')).toBe(150);
  });

  it('形状（name/up/down）；迁移号 1796500000000 晚于多玩法种子且全仓唯一', () => {
    const migration = new SplitGameConfig1796500000000();
    expect(migration.name).toBe('SplitGameConfig1796500000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new MultiGameConfigSeed1796400000000()));

    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1796500000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/SplitGameConfig1796500000000']);
  });
});
