import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';
import type { QueryRunner } from 'typeorm';
import { migrationsGlob, userDatabaseOptions } from '../src/database.config';
import { InitialUsers1789000000000 } from '../src/migrations/1789000000000-InitialUsers';
import { BaseScoreLevels1789100000000 } from '../src/migrations/1789100000000-BaseScoreLevels';
import { DropBaseScoreLevels1789300000000 } from '../src/migrations/1789300000000-DropBaseScoreLevels';
import { GameRecords1789400000000 } from '../src/migrations/1789400000000-GameRecords';
import { RiskControl1790000000000 } from '../src/migrations/1790000000000-RiskControl';
import { DeviceBinding1790100000000 } from '../src/migrations/1790100000000-DeviceBinding';
import { UsersCreatedAtIndex1796200000000 } from '../src/migrations/1796200000000-UsersCreatedAtIndex';
import { PdkRecords1796300000000 } from '../src/migrations/1796300000000-PdkRecords';

/**
 * E7（§10.3：「`synchronize: true` **仅限开发环境**；MVP 上线前须改为显式迁移脚本」）。
 *
 * ⚠️ 判据分三层，**缺一不可**（只断言「配置项是 false」不够 —— 那是「改了个字面量」）：
 *  ① 选项层：**有效**选项里 `synchronize === false`、`migrationsRun === true`、
 *     `migrations` 指向 `migrations/*.js`（不是正则匹配某一段文本 —— 判据不钉实现形态）；
 *  ② 源码机械层：`packages/user-service/src/**` 里不得**再出现** `synchronize: true`
 *     （防止有人把它改回来，同时给出探针判别力自证）；
 *  ③ **迁移真的会建表**：拿真实迁移类的 `up()` 对着记录 SQL 的假 QueryRunner 跑，
 *     断言的是**完整列定义**（`varchar(36) NOT NULL` 这一级），不是 `toContain('id')`
 *     那种「`passwordHash` 里也有 id 吗」级别的弱断言。
 *
 * 「关了**仍然可用**」的最终证据是**容器级**的：`docker compose restart user-service`
 * 之后 healthy + `SHOW COLUMNS FROM users` 仍是 7 行（见本片汇报的实测原文）。
 */
const SRC_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * 探针：源码里是否**开着** synchronize（判据本身要能被自证有判别力）。
 *
 * ⚠️ **必须先剥注释**（唯一真源 = `@fight-the-landlord/test-utils`，台账 N46 收敛）：
 * `database.config.ts` 与迁移文件里都**引用**了 `synchronize: true` 这几个字
 * （§10.3 的原文、以及「此前靠 synchronize: true 建的」），不过滤的话闸会在**文档**上红
 * —— 那是假红，而假红的处置通常是「把判据改弱/删掉」，正好把判别力一起删掉
 * （本项目最贵的一类事故）。
 */

const hasSynchronizeTrue = (text: string): boolean =>
  /synchronize\s*:\s*true/.test(stripComments(text));

describe('E7：§10.3 —— synchronize 关闭 + 显式 initial migration + migrationsRun', () => {
  it('① 有效选项：synchronize=false、migrationsRun=true、migrations 指向 dist/migrations/*.js', () => {
    const options = userDatabaseOptions();

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(true);
    expect(options.migrations).toEqual([migrationsGlob()]);
    // `MixedList<T> = T[] | { [key: number]: T; length: number }`（TypeORM 允许两种形态）
    // ⇒ 先**收窄**成数组，再把首项当字符串断言；这同时钉住「我们给的是**列表**形态」
    //   （若有人把 `migrations` 改成单值形态，本判据会当场红，而不是静默变成空断言）。
    const migrations = options.migrations;
    expect(Array.isArray(migrations), 'migrations 必须是列表形态（MixedList 的数组分支）').toBe(true);
    if (!Array.isArray(migrations)) throw new Error('unreachable: 上一行已断言');
    expect(String(migrations[0])).toMatch(/migrations[/\\]\*\.js$/);
    // 表结构**不再**由实体推导 ⇒ 迁移必须**真的存在**（否则新库建不出表）
    expect(options.entities === undefined || options.autoLoadEntities === true).toBe(true);
  });

  it('② 源码机械闸：packages/user-service/src 里不得再出现 `synchronize: true`', () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => hasSynchronizeTrue(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(SRC_DIR.length));
    expect(offenders, `这些文件仍开着 synchronize: ${offenders.join(',')}`).toEqual([]);
  });

  it('②′ 探针判别力：把 `synchronize: true` 写回去必须被抓住，`false`/注释不得误伤', () => {
    expect(hasSynchronizeTrue('      synchronize: true,')).toBe(true);
    expect(hasSynchronizeTrue('synchronize:true')).toBe(true);
    expect(hasSynchronizeTrue('      synchronize: false,')).toBe(false);
    expect(hasSynchronizeTrue('migrationsRun: true')).toBe(false);
    // ⚠️ N46：收敛前的无守卫副本会把这一行截成 `const u = "http:` ⇒ 本判据**看不见它**
    //    （台账 N46 逐字登记过的假阴性）。真源带 `:` 守卫 ⇒ URL 后面的真违规必须命中。
    expect(hasSynchronizeTrue('const u = "http://x"; synchronize: true')).toBe(true);
    // **注释不是违规**（本文件的兄弟文件里就引用了 §10.3 的原文）
    expect(hasSynchronizeTrue('// §10.3 的原文：`synchronize: true` 仅限开发环境')).toBe(false);
    expect(hasSynchronizeTrue('/* 旧实现是 synchronize: true */')).toBe(false);
  });

  it('③ initial migration 用 `CREATE TABLE IF NOT EXISTS` 建出**逐字对齐**现有 users 表的 7 列', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
        return undefined;
      },
    } as unknown as QueryRunner;

    await new InitialUsers1789000000000().up(fakeRunner);
    const sql = statements.join('\n');

    // 现有表已经存在 ⇒ 没有 IF NOT EXISTS 的话 `migrationsRun` 会在容器启动时炸
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `users`');
    // 逐列**完整定义**（与 `SHOW CREATE TABLE` 实测读数逐字对齐）
    for (const column of [
      '`id` varchar(36) NOT NULL',
      '`phone` varchar(20) NOT NULL',
      '`passwordHash` varchar(255) NOT NULL',
      '`nickname` varchar(50) NULL',
      '`avatar` varchar(255) NULL',
      "`status` varchar(10) NOT NULL DEFAULT 'active'",
      '`createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)',
    ]) {
      expect(sql, `迁移里缺少列定义 ${column}`).toContain(column);
    }
    expect(sql).toContain('PRIMARY KEY (`id`)');
    expect(sql).toContain('UNIQUE KEY `IDX_a000cca60bcf04454e72769949` (`phone`)');
    // 反向：不得悄悄多出一列（列数 = 7）
    expect(sql.match(/`(id|phone|passwordHash|nickname|avatar|status|createdAt)` (varchar|datetime)/g))
      .toHaveLength(7);
  });

  it('③′ 迁移类满足 TypeORM 的形状（name/up/down），且 down 是它的逆操作', async () => {
    const migration = new InitialUsers1789000000000();
    expect(migration.name).toBe('InitialUsers1789000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;
    await migration.down(fakeRunner);
    expect(statements.join('\n')).toContain('DROP TABLE IF EXISTS `users`');
  });
});

/**
 * §2.2：底分档位表迁移（`BaseScoreLevels<时间戳>`）。
 *
 * ⚠️ **形状逐字照本文件既有用例**（③/③′）：拿**真实迁移类**的 `up()` 对着记录 SQL 的
 * 假 QueryRunner 跑，断言的是**完整列定义 / 完整 INSERT 值**，不是 `toContain('name')`
 * 那种弱断言。本文件**不用真 DB**（brief 里「真跑迁移后 SELECT 四行」的假设不成立）
 * ⇒ 不引入数据库依赖，强度靠「执行真类 + 逐值断言」补齐。
 */
describe('§2.2：档位表迁移建出 base_score_levels 并塞入缺省四档', () => {
  it('④ `src/migrations/` 下存在类名匹配 /^BaseScoreLevels\\d+$/ 的迁移', () => {
    // 从源码提取导出类名（不钉文件路径：改名/挪文件而类名不变时，这条照样有判别力）。
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 BaseScoreLevels<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^BaseScoreLevels\d+$/)]),
    );
  });

  it('④′ up()：建表 + 四档种子 —— 列定义/UNIQUE/charset/INSERT 值逐字对齐（规格 §2.2）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new BaseScoreLevels1789100000000().up(fakeRunner);
    const sql = statements.join('\n');

    // 与 initial migration 同一条理由：现有库形态下容器启动可重跑（R248 的 `migrationsRun`）
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `base_score_levels`');
    // 逐列**完整定义**（不是 toContain('name')）
    for (const column of [
      '`id` int NOT NULL AUTO_INCREMENT',
      '`name` varchar(32) NOT NULL',
      '`base_score` int NOT NULL',
      '`sort_order` int NOT NULL',
      '`enabled` tinyint(1) NOT NULL DEFAULT 1',
    ]) {
      expect(sql, `迁移里缺少列定义 ${column}`).toContain(column);
    }
    expect(sql).toContain('PRIMARY KEY (`id`)');
    // 底分唯一（规格 §2.2 的 UNIQUE KEY）
    expect(sql).toContain('UNIQUE KEY `IDX_base_score_levels_base_score` (`base_score`)');
    // 场次名是中文 ⇒ charset/排序规则必须与 initial migration **逐字一致**
    expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');

    // 缺省四档（规格 §2.2 逐字：休闲场 15 / 标准场 80 / 竞技场 480 / 豪侠场 1200）——
    // 底分、sort_order、enabled 三列都钉住（只钉名字的话把 80 写成 800 也能过）。
    expect(sql).toContain(
      'INSERT INTO `base_score_levels` (`name`, `base_score`, `sort_order`, `enabled`) VALUES',
    );
    for (const row of [
      /\('休闲场',\s*15,\s*1,\s*1\)/,
      /\('标准场',\s*80,\s*2,\s*1\)/,
      /\('竞技场',\s*480,\s*3,\s*1\)/,
      /\('豪侠场',\s*1200,\s*4,\s*1\)/,
    ]) {
      expect(sql, `缺省档位里缺少/写错了 ${row}`).toMatch(row);
    }
    // 反向：不得悄悄多塞一行（VALUES 元组数 = 4）
    expect(sql.match(/\(\s*'[^']*',\s*\d+,\s*\d+,\s*\d+\s*\)/g)).toHaveLength(4);
  });

  it('④″ 迁移类满足 TypeORM 的形状（name/up/down），down 是它的逆操作', async () => {
    const migration = new BaseScoreLevels1789100000000();
    expect(migration.name).toMatch(/^BaseScoreLevels\d+$/);
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;
    await migration.down(fakeRunner);
    expect(statements.join('\n')).toContain('DROP TABLE IF EXISTS `base_score_levels`');
  });
});

/**
 * 台账 N47（2026-10-02 债务清理批）：遗留表 `base_score_levels` 的**删除迁移**。
 *
 * ⚠️ 风格逐字照本文件既有用例（真迁移类 + 记录 SQL 的假 QueryRunner + 完整列定义断言）——
 * 唯一的差别是断言方向：`up()` 发 DROP，`down()` **重建结构**（是逆操作，不是第二个 DROP）。
 * 历史迁移 `1789100000000-BaseScoreLevels.ts` **刻意保留**（历史可重放：建表 → 删表 → 终态无表），
 * 所以上面 ④ 那组用例原样还是绿的 —— 两组一起才钉住「重放终态」。
 */
describe('N47：删除遗留表 base_score_levels（up=DROP / down=重建结构）', () => {
  it('⑤ `src/migrations/` 下存在类名匹配 /^DropBaseScoreLevels\\d+$/ 的迁移，且时间戳晚于建表迁移', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 DropBaseScoreLevels<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^DropBaseScoreLevels\d+$/)]),
    );
    // ⚠️ 顺序是**语义**，不是形式：TypeORM 按时间戳升序重放 —— 若删除排在建表之前，
    // 新库的终态会是「表还在」（先 DROP 后 CREATE）⇒ 本批的目标根本没达成。
    const timestampOf = (prefix: string): number => {
      const cls = names.find((name) => name.startsWith(prefix));
      if (cls === undefined) throw new Error(`找不到 ${prefix} 迁移类 —— 本断言不得静默变绿`);
      return Number(cls.replace(/\D/g, ''));
    };
    expect(timestampOf('DropBaseScoreLevels')).toBeGreaterThan(timestampOf('BaseScoreLevels'));
  });

  it('⑤′ up()：只发 `DROP TABLE IF EXISTS base_score_levels`（不得顺手删别的表）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new DropBaseScoreLevels1789300000000().up(fakeRunner);
    // 恰好一条语句（`toEqual` 而不是 `toContain`）：多删任何一张表都会当场红。
    expect(statements).toEqual(['DROP TABLE IF EXISTS `base_score_levels`']);
  });

  it('⑤″ down()：重建表结构 —— 列定义/UNIQUE/charset 逐字对齐原建表迁移', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new DropBaseScoreLevels1789300000000().down(fakeRunner);
    const sql = statements.join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `base_score_levels`');
    // 逐列**完整定义**（与 ④′ 同一份清单 —— 回滚后的表必须与原迁移逐字同形）
    for (const column of [
      '`id` int NOT NULL AUTO_INCREMENT',
      '`name` varchar(32) NOT NULL',
      '`base_score` int NOT NULL',
      '`sort_order` int NOT NULL',
      '`enabled` tinyint(1) NOT NULL DEFAULT 1',
    ]) {
      expect(sql, `回滚建表里缺少列定义 ${column}`).toContain(column);
    }
    expect(sql).toContain('PRIMARY KEY (`id`)');
    expect(sql).toContain('UNIQUE KEY `IDX_base_score_levels_base_score` (`base_score`)');
    expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：回滚**不回填**四档种子（空表即可 —— 缺省四档的真源已是 platform_config）
    expect(sql).not.toContain('INSERT INTO');
  });

  it('⑤‴ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new DropBaseScoreLevels1789300000000();
    expect(migration.name).toBe('DropBaseScoreLevels1789300000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

/**
 * 记录片 T4/C11（规格 §2.6 / 设计 D3 逐字）：对局记录两表迁移。
 *
 * ⚠️ 风格逐字照本文件既有用例（真迁移类 + 记录 SQL 的假 QueryRunner + **完整列定义**断言，
 * 不是 `toContain('id')` 那种弱断言）。强化的两处：
 *  - `up()` **恰两条**语句（`toEqual`）：多建一张表 / 多塞种子都当场红；
 *  - 列数**反向**核对：不得悄悄多出一列。
 */
describe('记录片：GameRecords 迁移建出 game_records / game_record_players 两表（规格 §2.6 逐字）', () => {
  it('⑥ `src/migrations/` 下存在类名匹配 /^GameRecords\\d+$/ 的迁移，且时间戳晚于既有全部迁移', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 GameRecords<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^GameRecords\d+$/)]),
    );
    // ⚠️ 顺序是**语义**（TypeORM 按时间戳升序重放）：新表迁移若排到既有删除迁移之前，
    // 重放终态仍然对，但「迁移史」会与实际部署序不符（本库终态 = 三个迁移之后）。
    const timestampOf = (prefix: string): number => {
      const cls = names.find((name) => name.startsWith(prefix) && /^\w+\d+$/.test(name));
      if (cls === undefined) throw new Error(`找不到 ${prefix} 迁移类 —— 本断言不得静默变绿`);
      return Number(cls.replace(/\D/g, ''));
    };
    expect(timestampOf('GameRecords')).toBeGreaterThan(timestampOf('DropBaseScoreLevels'));
  });

  it('⑥′ up()：恰两条 CREATE TABLE IF NOT EXISTS —— 两表列定义/唯一键/三索引/charset 逐字对齐（设计 D3）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new GameRecords1789400000000().up(fakeRunner);

    // 恰两条（`toEqual` 逐字比较条数）：多建一表/多塞种子当场红。
    expect(statements).toHaveLength(2);
    const recordsSql = statements[0]!;
    const playersSql = statements[1]!;

    // ── game_records（15 列）──────────────────────────────────────────
    // 与 initial migration 同一条理由：现有库形态下容器启动可重跑（R248 的 `migrationsRun`）
    expect(recordsSql).toContain('CREATE TABLE IF NOT EXISTS `game_records`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`room_code` varchar(16) NOT NULL',
      '`game_version` int NOT NULL',
      '`mode` varchar(16) NOT NULL',
      '`base_score` int NOT NULL',
      '`winner` varchar(8) NOT NULL',
      '`landlord_seat` tinyint NOT NULL',
      '`multiplier` int NOT NULL',
      '`spring` varchar(16) NOT NULL',
      '`landlord_score_change` int NOT NULL',
      '`farmer_score_change` int NOT NULL',
      '`bottom_cards` char(6) NOT NULL',
      '`started_at` datetime(3) NOT NULL',
      '`ended_at` datetime(3) NOT NULL',
      '`created_at` datetime(3) NOT NULL',
    ]) {
      expect(recordsSql, `game_records 缺少列定义 ${column}`).toContain(column);
    }
    expect(recordsSql).toContain('PRIMARY KEY (`id`)');
    // 幂等唯一键（设计 D3 逐字）：(room_code, game_version)
    expect(recordsSql).toContain('UNIQUE KEY `uk_room_version` (`room_code`, `game_version`)');
    // 清理/keyset 用索引
    expect(recordsSql).toContain('KEY `idx_ended_at` (`ended_at`)');
    expect(recordsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 15（不得悄悄多出一列）
    expect(
      recordsSql.match(/\`\w+\` (bigint|varchar|int|tinyint|char|datetime)(\(\d+\))? NOT NULL/g),
      'game_records 列数不等于 15',
    ).toHaveLength(15);

    // ── game_record_players（13 列）───────────────────────────────────
    expect(playersSql).toContain('CREATE TABLE IF NOT EXISTS `game_record_players`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`record_id` bigint NOT NULL',
      '`seat` tinyint NOT NULL',
      '`user_id` varchar(64) NULL',
      '`is_robot` tinyint(1) NOT NULL',
      '`robot_id` varchar(64) NULL',
      '`nickname` varchar(50) NULL',
      '`role` varchar(8) NOT NULL',
      '`score_change` int NOT NULL',
      '`won` tinyint(1) NOT NULL',
      '`hand` char(34) NOT NULL',
      '`money_delta` int NULL',
      '`ended_at` datetime(3) NOT NULL',
    ]) {
      expect(playersSql, `game_record_players 缺少列定义 ${column}`).toContain(column);
    }
    expect(playersSql).toContain('PRIMARY KEY (`id`)');
    // 三索引（设计 D3 逐字：纯 ended_at 范围 + 按用户 keyset + 按记录回查）
    expect(playersSql).toContain('KEY `idx_user_ended` (`user_id`, `ended_at`)');
    expect(playersSql).toContain('KEY `idx_ended_at` (`ended_at`)');
    expect(playersSql).toContain('KEY `idx_record` (`record_id`)');
    expect(playersSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 13（NOT NULL 12 + 可空 2……逐字符清点见下）
    // ⚠️ 计数会数到 NOT NULL 与 NULL 两类；用「列名紧跟类型」全量正则再数一次。
    expect(
      playersSql.match(/\`\w+\` (bigint|varchar|int|tinyint|char|datetime)(\(\d+(, ?\d+)?\))? (NOT NULL|NULL)/g),
      'game_record_players 列数不等于 13',
    ).toHaveLength(13);
  });

  it('⑥″ down()：恰两条 DROP、玩家表先删（逆操作 = 迁移的镜像）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new GameRecords1789400000000().down(fakeRunner);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS `game_record_players`',
      'DROP TABLE IF EXISTS `game_records`',
    ]);
  });

  it('⑥‴ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new GameRecords1789400000000();
    expect(migration.name).toBe('GameRecords1789400000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

/**
 * 风控片 T4 / C20（规格 §2.2 逐字 / ⚙️1 迁移号写死）：风控三表迁移
 * `1790000000000-RiskControl`。
 *
 * ⚠️ 风格逐字照本文件既有用例（真迁移类 + 记录 SQL 的假 QueryRunner + **完整列定义**断言）。
 * 强化两处：
 *  - `up()` **恰三条**语句（`toEqual` 级条数断言）：多建一表 / 多塞种子都当场红；
 *  - 列数**反向**核对：不得悄悄多出一列；`risk_actions.action` 的 DDL 注释须**含 `reopen`**
 *    （系统专用动作——漏了它「动作全集」的登记就少一档，T6 的 5 值管理集要以它为全集）。
 */
describe('风控片：RiskControl 迁移建出 user_devices / risk_reviews / risk_actions 三表（规格 §2.2 逐字）', () => {
  it('⑦ `src/migrations/` 下存在类名匹配 /^RiskControl\\d+$/ 的迁移，时间戳 = 1790000000000（⚙️1 写死）且晚于既有全部迁移', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names, `src/migrations/ 里没有 RiskControl<时间戳>：${names.join(', ')}`).toEqual(
      expect.arrayContaining([expect.stringMatching(/^RiskControl\d+$/)]),
    );
    // ⚠️ 顺序是**语义**（TypeORM 按时间戳升序重放）：三表必须在既有全部迁移之后。
    const timestampOf = (prefix: string): number => {
      const cls = names.find((name) => name.startsWith(prefix) && /^\w+\d+$/.test(name));
      if (cls === undefined) throw new Error(`找不到 ${prefix} 迁移类 —— 本断言不得静默变绿`);
      return Number(cls.replace(/\D/g, ''));
    };
    expect(timestampOf('RiskControl')).toBe(1790000000000); // ⚙️1：写死，不得另选
    expect(timestampOf('RiskControl')).toBeGreaterThan(timestampOf('GameRecords'));
  });

  it('⑦′ up()：恰三条 CREATE TABLE IF NOT EXISTS —— 三表列定义/唯一键/四索引/charset 逐字对齐（规格 §2.2）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new RiskControl1790000000000().up(fakeRunner);

    // 恰三条（`toEqual` 级条数断言）：多建一表/多塞种子当场红。
    expect(statements).toHaveLength(3);
    const [devicesSql, reviewsSql, actionsSql] = statements as [string, string, string];

    // ── user_devices（5 列）────────────────────────────────────────────
    expect(devicesSql).toContain('CREATE TABLE IF NOT EXISTS `user_devices`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`user_id` varchar(64) NOT NULL',
      '`device_id` varchar(64) NOT NULL',
      '`first_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(devicesSql, `user_devices 缺少列定义 ${column}`).toContain(column);
    }
    expect(devicesSql).toContain('PRIMARY KEY (`id`)');
    // 幂等硬闸（⚙️11 的 `uk(user_id,device_id)`）+ 两个查询面索引。
    expect(devicesSql).toContain('UNIQUE KEY `uk_user_device` (`user_id`,`device_id`)');
    expect(devicesSql).toContain('KEY `idx_device` (`device_id`)');
    expect(devicesSql).toContain('KEY `idx_last_seen` (`last_seen_at`)');
    expect(devicesSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 反向：列数 = 5（不得悄悄多出一列）。
    expect(
      devicesSql.match(/\`\w+\` (bigint|varchar|int|json|datetime)(\(\d+\))? (NOT NULL|NULL)/g),
      'user_devices 列数不等于 5',
    ).toHaveLength(5);

    // ── risk_reviews（9 列）────────────────────────────────────────────
    expect(reviewsSql).toContain('CREATE TABLE IF NOT EXISTS `risk_reviews`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`user_id` varchar(64) NOT NULL',
      '`score` int NOT NULL',
      '`reasons` json NOT NULL',
      "`status` varchar(12) NOT NULL DEFAULT 'open'",
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
      '`handled_by` varchar(32) NULL',
      '`handled_at` datetime(3) NULL',
    ]) {
      expect(reviewsSql, `risk_reviews 缺少列定义 ${column}`).toContain(column);
    }
    expect(reviewsSql).toContain('PRIMARY KEY (`id`)');
    expect(reviewsSql).toContain('KEY `idx_status_id` (`status`,`id`)');
    expect(reviewsSql).toContain('KEY `idx_user_id` (`user_id`,`id`)');
    expect(reviewsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(
      reviewsSql.match(/\`\w+\` (bigint|varchar|int|json|datetime)(\(\d+\))? (NOT NULL|NULL)/g),
      'risk_reviews 列数不等于 9',
    ).toHaveLength(9);

    // ── risk_actions（8 列）────────────────────────────────────────────
    expect(actionsSql).toContain('CREATE TABLE IF NOT EXISTS `risk_actions`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`user_id` varchar(64) NOT NULL',
      '`action` varchar(16) NOT NULL',
      '`actor` varchar(32) NOT NULL',
      '`reason` varchar(200) NULL',
      '`review_id` bigint NULL',
      '`detail` json NULL',
      '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(actionsSql, `risk_actions 缺少列定义 ${column}`).toContain(column);
    }
    expect(actionsSql).toContain('PRIMARY KEY (`id`)');
    expect(actionsSql).toContain('KEY `idx_user_created` (`user_id`,`id`)');
    expect(actionsSql).toContain('KEY `idx_created` (`created_at`)');
    expect(actionsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    // 🔴 动作全集的 DDL 注释**含 reopen**（系统专用的复活动作——T6 的 5 值管理集以它为全集）
    // 与 **device_unbind**（设备绑定片第八值：管理面人工解绑审计）。
    expect(actionsSql, 'risk_actions.action 注释必须列出动作全集（含 reopen/device_unbind）').toContain(
      '-- auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen|device_unbind',
    );
    expect(
      actionsSql.match(/\`\w+\` (bigint|varchar|int|json|datetime)(\(\d+\))? (NOT NULL|NULL)/g),
      'risk_actions 列数不等于 8',
    ).toHaveLength(8);
  });

  it('⑦″ down()：恰三条 DROP、逆序（risk_actions → risk_reviews → user_devices）', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new RiskControl1790000000000().down(fakeRunner);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS `risk_actions`',
      'DROP TABLE IF EXISTS `risk_reviews`',
      'DROP TABLE IF EXISTS `user_devices`',
    ]);
  });

  it('⑦‴ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new RiskControl1790000000000();
    expect(migration.name).toBe('RiskControl1790000000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

/**
 * 设备绑定片：`1790100000000-DeviceBinding` 建出账号 1:1 绑定表
 * `user_device_bindings`（风控三表的 `user_devices` 是 1:N 历史链，两表语义分离）。
 */
describe('设备绑定片：DeviceBinding 迁移建出 user_device_bindings 表', () => {
  it('⑧ `src/migrations/` 下存在 DeviceBinding<时间戳>，时间戳 = 1790100000000 且晚于 RiskControl', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names).toEqual(
      expect.arrayContaining([expect.stringMatching(/^DeviceBinding\d+$/)]),
    );
    const timestampOf = (prefix: string): number => {
      const cls = names.find((name) => name.startsWith(prefix) && /^\w+\d+$/.test(name));
      if (cls === undefined) throw new Error(`找不到 ${prefix} 迁移类 —— 本断言不得静默变绿`);
      return Number(cls.replace(/\D/g, ''));
    };
    expect(timestampOf('DeviceBinding')).toBe(1790100000000);
    expect(timestampOf('DeviceBinding')).toBeGreaterThan(timestampOf('RiskControl'));
  });

  it('⑧′ up()：恰一条 CREATE TABLE IF NOT EXISTS —— 3 列/PK(user_id)/idx_device/charset 逐字对齐', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new DeviceBinding1790100000000().up(fakeRunner);

    expect(statements).toHaveLength(1);
    const sql = statements[0]!;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `user_device_bindings`');
    for (const column of [
      '`user_id` varchar(64) NOT NULL',
      '`device_id` varchar(64) NOT NULL',
      '`bound_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    ]) {
      expect(sql, `user_device_bindings 缺少列定义 ${column}`).toContain(column);
    }
    expect(sql).toContain('PRIMARY KEY (`user_id`)');
    // 一账号一行（首绑 INSERT IGNORE 认第一台）；按设备反查面。
    expect(sql).not.toContain('UNIQUE KEY `uk_user_device`'); // 与 user_devices 的 1:N 链区分
    expect(sql).toContain('KEY `idx_device` (`device_id`)');
    expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(
      sql.match(/\`\w+\` (bigint|varchar|int|json|datetime)(\(\d+\))? (NOT NULL|NULL)/g),
      'user_device_bindings 列数不等于 3',
    ).toHaveLength(3);
  });

  it('⑧″ down()：恰一条 DROP user_device_bindings', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new DeviceBinding1790100000000().down(fakeRunner);
    expect(statements).toEqual(['DROP TABLE IF EXISTS `user_device_bindings`']);
  });

  it('⑧‴ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new DeviceBinding1790100000000();
    expect(migration.name).toBe('DeviceBinding1790100000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

/**
 * user-service CLI 数据源**单导出纪律** —— 风控片 T4 的**真库 revert 演练实测**（首轮
 * `migration:revert` 当场失败）抓到：typeorm 0.3.31 的 `CommandUtils.loadDataSource`
 * 把模块里每个 `isDataSource` 导出都收进清单（**不去重**），双导出（`export const
 * AppDataSource` + `export default AppDataSource`）会让 CLI 恒抛
 * 「must contain only one export of DataSource instance」。
 *
 * 修复 = 删 `export default`（与 config-service 的 ③ T2 修复逐字同款）。本探针把这条
 * 纪律机械化：源码（剥注释后）不得再有 `export default`——回归时当场红，而不是等到
 * 下一次真栈 revert 演练才炸。
 */
describe('user-service CLI 数据源单导出纪律（T4 revert 演练实测补遗）', () => {
  it('src/data-source.ts 剥注释后不得出现 `export default`（双导出 ⇒ migration:run/revert 恒失败）', () => {
    const source = readFileSync(join(SRC_DIR, 'data-source.ts'), 'utf-8');
    expect(
      stripComments(source),
      '`export default` 会让 TypeORM CLI 收集到 2 个 DataSource 导出 ⇒ migration:run/revert 恒失败',
    ).not.toMatch(/export\s+default/);
  });

  it('探针判别力：双导出的源码形态必须被抓住（防判据写成恒真）', () => {
    const dual = 'export const AppDataSource = new DataSource({});\nexport default AppDataSource;\n';
    expect(stripComments(dual)).toMatch(/export\s+default/);
  });
});


describe('玩家管理页：UsersCreatedAtIndex 迁移（2026-10-22）', () => {
  it('up 建 users(createdAt) 索引，down 删除', async () => {
    const statements: string[] = [];
    const runner = { query: async (sql: string) => { statements.push(sql); } } as unknown as QueryRunner;
    await new UsersCreatedAtIndex1796200000000().up(runner);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/CREATE INDEX.*idx_users_created_at.*users.*createdAt/i);

    statements.length = 0;
    await new UsersCreatedAtIndex1796200000000().down(runner);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/DROP INDEX.*idx_users_created_at/i);
  });
});

/**
 * Task 4.0（spec §4.9.1 / D11）：跑得快记录**单独建表**迁移。
 *
 * 风格与 ⑥ 同款：真迁移类 + 假 QueryRunner + 完整列定义/索引断言；`up()` 恰两条语句、
 * `down()` 恰两条 DROP 且子表先删。斗地主两表**零迁移**（本迁移不碰它们）。
 */
describe('跑得快记录：PdkRecords 迁移建出 game_records_pdk / game_record_players_pdk（spec §4.9.1）', () => {
  it('⑨ `src/migrations/` 下存在 PdkRecords<时间戳>，且晚于既有全部迁移', () => {
    const names = walk(join(SRC_DIR, 'migrations')).flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/export class (\w+)/g)].map((m) => m[1]!),
    );
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/^PdkRecords\d+$/)]));
    const timestampOf = (prefix: string): number => {
      const cls = names.find((name) => name.startsWith(prefix) && /^\w+\d+$/.test(name));
      if (cls === undefined) throw new Error(`找不到 ${prefix} 迁移类 —— 本断言不得静默变绿`);
      return Number(cls.replace(/\D/g, ''));
    };
    expect(timestampOf('PdkRecords')).toBeGreaterThan(timestampOf('UsersCreatedAtIndex'));
  });

  it('⑨′ up()：恰两条 CREATE TABLE IF NOT EXISTS —— 两表列定义/唯一键/索引/charset 逐字对齐', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new PdkRecords1796300000000().up(fakeRunner);

    expect(statements).toHaveLength(2);
    const [recordsSql, playersSql] = statements as [string, string];

    // ── game_records_pdk（18 列）───────────────────────────────────────
    expect(recordsSql).toContain('CREATE TABLE IF NOT EXISTS `game_records_pdk`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`room_code` varchar(16) NOT NULL',
      '`game_version` int NOT NULL',
      '`mode` varchar(16) NOT NULL',
      '`player_count` tinyint NOT NULL',
      '`base_score` int NOT NULL',
      '`winner_seat` tinyint NOT NULL',
      '`remaining` json NOT NULL',
      '`multiplier` int NOT NULL',
      '`bomb_count` int NOT NULL',
      '`guan` tinyint(1) NOT NULL',
      '`spring` tinyint(1) NOT NULL',
      '`baoben_seats` json NOT NULL',
      '`score_changes` json NOT NULL',
      '`unused_cards` varchar(32) NULL',
      '`started_at` bigint NOT NULL',
      '`ended_at` bigint NOT NULL',
      '`created_at` timestamp DEFAULT CURRENT_TIMESTAMP',
    ]) {
      expect(recordsSql, `game_records_pdk 缺少列定义 ${column}`).toContain(column);
    }
    expect(recordsSql).toContain('PRIMARY KEY (`id`)');
    expect(recordsSql).toContain('UNIQUE KEY `uk_pdk_room_version` (`room_code`, `game_version`)');
    expect(recordsSql).toContain('KEY `idx_pdk_ended_at` (`ended_at`)');
    expect(recordsSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(
      recordsSql.match(/\`\w+\` (bigint|varchar|int|tinyint|json|timestamp)(\(\d+\))? (NOT NULL|NULL)/g),
      'game_records_pdk 列数不等于 17（created_at 无 NULL 子句，单列核对）',
    ).toHaveLength(17);

    // ── game_record_players_pdk（11 列）────────────────────────────────
    expect(playersSql).toContain('CREATE TABLE IF NOT EXISTS `game_record_players_pdk`');
    for (const column of [
      '`id` bigint NOT NULL AUTO_INCREMENT',
      '`record_id` bigint NOT NULL',
      '`seat` tinyint NOT NULL',
      '`user_id` varchar(36) NULL',
      '`is_robot` tinyint(1) NOT NULL',
      '`robot_id` varchar(64) NULL',
      '`nickname` varchar(64) NULL',
      '`hand` varchar(34) NOT NULL',
      '`played_count` smallint NOT NULL',
      '`money_delta` int NULL',
      '`ended_at` bigint NOT NULL',
    ]) {
      expect(playersSql, `game_record_players_pdk 缺少列定义 ${column}`).toContain(column);
    }
    expect(playersSql).toContain('PRIMARY KEY (`id`)');
    expect(playersSql).toContain('UNIQUE KEY `uk_pdk_record_seat` (`record_id`, `seat`)');
    expect(playersSql).toContain('KEY `idx_pdk_user` (`user_id`)');
    expect(playersSql).toContain('KEY `idx_pdk_ended_at` (`ended_at`)');
    expect(playersSql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(
      playersSql.match(/\`\w+\` (bigint|varchar|int|tinyint|smallint|json)(\(\d+\))? (NOT NULL|NULL)/g),
      'game_record_players_pdk 列数不等于 11',
    ).toHaveLength(11);
  });

  it('⑨″ down()：恰两条 DROP、玩家表先删；不碰斗地主表', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as QueryRunner;

    await new PdkRecords1796300000000().down(fakeRunner);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS `game_record_players_pdk`',
      'DROP TABLE IF EXISTS `game_records_pdk`',
    ]);
  });

  it('⑨‴ 迁移类满足 TypeORM 的形状（name/up/down）', () => {
    const migration = new PdkRecords1796300000000();
    expect(migration.name).toBe('PdkRecords1796300000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
