/**
 * 货币片 C2（单测半边；规格 §2.10 / 设计 §3 **逐字**）：三表迁移的形状。
 *
 * ⚠️ **本仓单测不用真 DB**（不引入数据库依赖）—— 强度靠「执行**真迁移类** + 逐列/逐索引
 * **完整定义**断言」补齐，风格逐字照 `packages/user-service/test/migration.test.ts` 先例：
 *  - `up()` **恰三条**语句（`toEqual` 逐条）：多建一张表 / 少建一张都当场红；
 *  - 每张表逐列完整定义（`varchar(36) NOT NULL` 这一级），并**反向**核对列数
 *    （不得悄悄多出一列）；
 *  - `down()` 恰三条 DROP、**逆序**（flows → ops → accounts）；
 *  - 选项层：`migrationsTableName = 'migrations_currency'`（⚙️9，与 user/config 共库的
 *    迁移表互不搅乱）+ `synchronize: false` + `migrationsRun: true`。
 *
 * ⚠️ 「`migrations_currency` 表里恰 1 行」的**真读**载体是 conformance `slice-17`（T10
 * exec mysql）—— 本文件没有 DB，答案只有「迁移已注册且形状正确」（判据不钉平台现象）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { currencyDatabaseOptions } from '../src/database.config';
import { Currency1789600000000 } from '../src/migrations/1789600000000-Currency';
import { BurnOnOp1792022400000 } from '../src/migrations/1792022400000-BurnOnOp';
import { EntryFeeSkips1792108800000 } from '../src/migrations/1792108800000-EntryFeeSkips';
import { CardCounterEntitlements1795900000000 } from '../src/migrations/CardCounterEntitlements1795900000000';

const SRC_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** 记录 SQL 的假 QueryRunner（先例：user-service `migration.test.ts`）。 */
function recordingRunner() {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => {
      statements.push(sql);
      return undefined;
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

describe('货币片 C2：Currency 迁移建出 currency_accounts / currency_ops / currency_flows 三表（规格 §2.10 逐字）', () => {
  it('① `src/migrations/` 下存在类名匹配 /^Currency\\d+$/ 的迁移，且时间戳为 1789600000000', () => {
    // 从源码提取导出类名（不钉文件路径：改名/挪文件而类名不变时，这条照样有判别力）。
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 Currency<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Currency\d+$/)]),
    );
    const cls = names.find((name) => /^Currency\d+$/.test(name));
    if (cls === undefined) throw new Error('上一行已断言 —— 本断言不得静默变绿');
    // 编号是**语义**（规格写死 1789600000000）：同库三服务迁移表虽各一份，但这条编号
    // 是设计/手册的引用锚点（`1789600000000-Currency`），改了必须有人主动改这里。
    expect(cls).toBe('Currency1789600000000');
  });

  it('② 选项层：迁移表独立（migrations_currency）+ synchronize 关闭 + migrationsRun 开启', () => {
    const options = currencyDatabaseOptions();

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(true);
    // ⚙️9：与 user-service（默认 `migrations`）/ config-service（`migrations_config`）**共库**
    // ⇒ 第三份独立迁移表；这条错了类型系统与单测都看不见，只有真库里两张迁移表互相搅乱时才爆。
    expect(options.migrationsTableName).toBe('migrations_currency');
    const migrations = options.migrations;
    expect(Array.isArray(migrations), 'migrations 必须是列表形态（MixedList 的数组分支）').toBe(true);
    if (!Array.isArray(migrations)) throw new Error('unreachable: 上一行已断言');
    expect(String(migrations[0])).toMatch(/migrations[/\\]\*\.js$/);
  });

  it('③ up()：恰三条 CREATE TABLE IF NOT EXISTS（accounts → ops → flows）—— 列/索引/charset 逐字对齐（§2.10）', async () => {
    const { runner, statements } = recordingRunner();

    await new Currency1789600000000().up(runner);

    // 恰三条（`toHaveLength`）：多建一表/多塞种子 = 当场红。
    expect(statements).toHaveLength(3);
    const [accountsSql, opsSql, flowsSql] = statements as [string, string, string];

    // ── currency_accounts（4 列）─────────────────────────────────────────
    // 现有库形态下容器启动可重跑（`migrationsRun`）⇒ 必须 IF NOT EXISTS。
    expect(accountsSql).toContain('CREATE TABLE IF NOT EXISTS `currency_accounts`');
    for (const column of [
      '`owner_id` varchar(36) NOT NULL',
      "`owner_type` varchar(8) NOT NULL DEFAULT 'user'",
      '`balance` int NOT NULL DEFAULT 0',
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    ]) {
      expect(accountsSql, `currency_accounts 缺少列定义 ${column}`).toContain(column);
    }
    // PK = owner_id（一人一行；幂等重建/对账都按它取行）
    expect(accountsSql).toContain('PRIMARY KEY (`owner_id`)');
    expect(accountsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 4（不得悄悄多出一列）
    expect(
      accountsSql.match(/`\w+` (varchar|int|datetime)(\(\d+\))? NOT NULL/g),
      'currency_accounts 列数不等于 4',
    ).toHaveLength(4);
    // 反向：不得有 UPDATE 语义的额外索引/键（只有 PK 一个键）
    expect(accountsSql.match(/(PRIMARY KEY|UNIQUE KEY|KEY) `?\w*`? ?\(/g)).toHaveLength(1);

    // ── currency_ops（9 列）─────────────────────────────────────────────
    expect(opsSql).toContain('CREATE TABLE IF NOT EXISTS `currency_ops`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`action_id` varchar(128) NOT NULL',
      '`request_hash` char(64) NOT NULL',
      '`source` varchar(32) NOT NULL',
      '`actor` varchar(64) NULL',
      '`reason` varchar(255) NULL',
      '`ref_id` varchar(128) NULL',
      '`trace_id` varchar(64) NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(opsSql, `currency_ops 缺少列定义 ${column}`).toContain(column);
    }
    expect(opsSql).toContain('PRIMARY KEY (`id`)');
    // 幂等锚的最终硬闸（§2.3 步骤 1：重放/并发撞键都命中它）
    expect(opsSql).toContain('UNIQUE KEY `uk_action_id` (`action_id`)');
    expect(opsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 9（NOT NULL 6 + 可空 3）
    expect(
      opsSql.match(/`\w+` (bigint|varchar|char|datetime)(\(\d+\))? (NOT NULL|NULL)/g),
      'currency_ops 列数不等于 9',
    ).toHaveLength(9);

    // ── currency_flows（7 列）───────────────────────────────────────────
    expect(flowsSql).toContain('CREATE TABLE IF NOT EXISTS `currency_flows`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`op_id` bigint NOT NULL',
      '`owner_id` varchar(36) NOT NULL',
      "`owner_type` varchar(8) NOT NULL DEFAULT 'user'",
      '`delta` int NOT NULL',
      '`balance_after` int NOT NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(flowsSql, `currency_flows 缺少列定义 ${column}`).toContain(column);
    }
    expect(flowsSql).toContain('PRIMARY KEY (`id`)');
    // 两索引各有主：按人回查（幂等重建/管理面 recentFlows）/ 按 op 回查（重放重建 + 对账 JOIN）
    expect(flowsSql).toContain('KEY `idx_flow_owner` (`owner_id`, `id`)');
    expect(flowsSql).toContain('KEY `idx_flow_op` (`op_id`)');
    expect(flowsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 7（全部 NOT NULL）
    expect(
      flowsSql.match(/`\w+` (bigint|varchar|int|datetime)(\(\d+\))? NOT NULL/g),
      'currency_flows 列数不等于 7',
    ).toHaveLength(7);
  });

  it('③′ up() 顺序：accounts（无外键依赖）先建、flows（指向 ops）最后 —— 依序三条', async () => {
    const { runner, statements } = recordingRunner();
    await new Currency1789600000000().up(runner);
    const tables = statements.map((sql) => /`(currency_\w+)`/.exec(sql)?.[1]);
    expect(tables).toEqual(['currency_accounts', 'currency_ops', 'currency_flows']);
  });

  it('④ down()：恰三条 DROP、逆序（flows → ops → accounts）—— up 的镜像', async () => {
    const { runner, statements } = recordingRunner();
    await new Currency1789600000000().down(runner);
    // 逐字三条（`toEqual` 而不是 `toContain`）：多删/错序任何一处都当场红。
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS `currency_flows`',
      'DROP TABLE IF EXISTS `currency_ops`',
      'DROP TABLE IF EXISTS `currency_accounts`',
    ]);
  });

  it('⑤ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new Currency1789600000000();
    expect(migration.name).toBe('Currency1789600000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

describe('结算销毁上账（本片 T2）：BurnOnOp 迁移 —— 两列 + 一索引（设计 §2.1 逐字）', () => {
  it('① 类名存在且为 BurnOnOp1792022400000；且不落 /^Currency\\d+$/ 模式（readdir 抢位防线）', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names).toContain('BurnOnOp1792022400000');
    const currencyCls = names.find((name) => /^Currency\d+$/.test(name));
    expect(currencyCls).toBe('Currency1789600000000');
  });

  it('② up() 恰一条 ALTER（列/索引逐字）；down() 恰一条、逆序', async () => {
    const { runner, statements } = recordingRunner();
    await new BurnOnOp1792022400000().up(runner);
    expect(statements).toEqual([
      'ALTER TABLE `currency_ops` ' +
        'ADD COLUMN `burned_residue` int NULL DEFAULT NULL, ' +
        'ADD COLUMN `burned_rake` int NULL DEFAULT NULL, ' +
        'ADD KEY `idx_ops_source_created` (`source`, `created_at`)',
    ]);
    const second = recordingRunner();
    await new BurnOnOp1792022400000().down(second.runner);
    expect(second.statements).toEqual([
      'ALTER TABLE `currency_ops` ' +
        'DROP KEY `idx_ops_source_created`, ' +
        'DROP COLUMN `burned_rake`, ' +
        'DROP COLUMN `burned_residue`',
    ]);
  });
});

describe('台费片 T3：EntryFeeSkips 迁移 —— 免单表（规格 §2.4b DDL 逐字）', () => {
  it('① 类名存在且为 EntryFeeSkips1792108800000；且不落 /^Currency\\d+$/ 模式（readdir 抢位防线）', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names).toContain('EntryFeeSkips1792108800000');
    const currencyCls = names.find((name) => /^Currency\d+$/.test(name));
    expect(currencyCls).toBe('Currency1789600000000');
  });

  it('② up() 恰一条 CREATE TABLE（DDL 全文相等：列/唯一键/两索引/ENGINE 收尾）；down() 恰一条 DROP', async () => {
    const EXPECTED_UP = [
      'CREATE TABLE IF NOT EXISTS `currency_entry_fee_skips` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`seat` int NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`fee_amount` int NOT NULL, ' +
        '`reason` varchar(32) NOT NULL, ' +
        '`trace_id` varchar(64) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_skips_room_owner` (`room_code`, `owner_id`), ' +
        'KEY `idx_skips_created` (`created_at`), ' +
        'KEY `idx_skips_room` (`room_code`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    ];
    const { runner, statements } = recordingRunner();
    await new EntryFeeSkips1792108800000().up(runner);
    expect(statements).toEqual(EXPECTED_UP);
    const second = recordingRunner();
    await new EntryFeeSkips1792108800000().down(second.runner);
    expect(second.statements).toEqual(['DROP TABLE IF EXISTS `currency_entry_fee_skips`']);
  });
});

describe('记牌器收费片 T5：CardCounterEntitlements 迁移 —— 三表（规格 §2.4a DDL 逐字）', () => {
  it('① 类名存在且不落 /^Currency\\d+$/（readdir 抢位防线）', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names).toContain('CardCounterEntitlements1795900000000');
    expect(names.filter((name) => /^Currency\d+$/.test(name))).toEqual(['Currency1789600000000']);
  });

  it('② up() 恰三条 CREATE TABLE（DDL 全文相等）；down() 恰三条 DROP（逆序）', async () => {    const EXPECTED_UP = [
      'CREATE TABLE IF NOT EXISTS `card_counter_entitlements` (' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`credits` int NOT NULL DEFAULT 0, ' +
        '`pass_expires_at` datetime(3) NULL, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`owner_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      'CREATE TABLE IF NOT EXISTS `card_counter_purchases` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`action_id` varchar(128) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`kind` varchar(16) NOT NULL, ' +
        '`hours` int NULL, ' +
        '`credits` int NULL, ' +
        '`price` int NOT NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_cc_purchase_action` (`action_id`), ' +
        'KEY `idx_cc_purchase_owner` (`owner_id`, `id`), ' +
        'KEY `idx_cc_purchase_created` (`created_at`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      'CREATE TABLE IF NOT EXISTS `card_counter_consumptions` (' +
        '`id` bigint NOT NULL AUTO_INCREMENT, ' +
        '`room_code` varchar(16) NOT NULL, ' +
        '`owner_id` varchar(36) NOT NULL, ' +
        '`seat` int NULL, ' +
        '`kind` varchar(16) NOT NULL, ' +
        '`expires_at` datetime(3) NULL, ' +
        '`trace_id` varchar(64) NULL, ' +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `uk_cc_consume_room_owner` (`room_code`, `owner_id`), ' +
        'KEY `idx_cc_consume_owner` (`owner_id`, `id`), ' +
        'KEY `idx_cc_consume_created` (`created_at`, `kind`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    ];
    const { runner, statements } = recordingRunner();
    await new CardCounterEntitlements1795900000000().up(runner);
    expect(statements).toEqual(EXPECTED_UP);

    const down = recordingRunner();
    await new CardCounterEntitlements1795900000000().down(down.runner);
    expect(down.statements).toEqual([
      'DROP TABLE IF EXISTS `card_counter_consumptions`',
      'DROP TABLE IF EXISTS `card_counter_purchases`',
      'DROP TABLE IF EXISTS `card_counter_entitlements`',
    ]);
  });

  it('③ 时间戳 1795900000000 全仓唯一（C6 明文）', () => {
    const packagesDir = join(SRC_DIR, '..', '..');
    const hits: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795900000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['currency-service/CardCounterEntitlements1795900000000']);
  });
});
