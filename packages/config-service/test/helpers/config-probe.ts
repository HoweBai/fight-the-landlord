import 'reflect-metadata';
import { Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'net';
import type { DataSource } from 'typeorm';
import { vi } from 'vitest';
import {
  ADMIN_ENABLED_SQL,
  ADMIN_FIND_ACCOUNT_SQL,
  ADMIN_TOUCH_LOGIN_SQL,
  AdminAuthService,
} from '../../src/config/admin-auth.service';
import { LOGIN_EVENT_INSERT_SQL, LoginEventsService } from '../../src/admin/login-events.service';
import {
  CONFIG_CHANGES_INSERT_SQL,
  CONFIG_LOCK_SQL,
} from '../../src/admin/admin-changes.service';
import { AdminController } from '../../src/config/admin.controller';
import { ClientConfigController } from '../../src/config/client-config.controller';
import { PlatformConfigService } from '../../src/config/platform-config.service';

/**
 * T3 的测试夹具（**形态照** `test/platform-config.service.test.ts` —— 同一包的既有假库）。
 *
 * 与那份的差异（刻意的，写在这里防误读）：
 *  - **不建模行锁/并发**：T3 的用例是接口面语义（HTTP 状态码 / 信封 / 四态），
 *    并发与 version 单调由 `platform-config.service.test.ts` 的同键并发用例承担
 *    （两处都在手，砍锁是「夹具不比用例复杂」的取舍，不是遗忘）；
 *  - 五十一键种子值**逐字** = 各键的种子迁移（`1789200000000-PlatformConfig.ts` 九键 +
 *    `1789500000000-RecordRetention.ts` 第 10 键 + `1789700000000-SignupGrant.ts` 第 11 键 +
 *    `1789800000000-GoldRoom.ts` 第 12–17 键 + `1790000001000-RiskConfigSeed.ts` 风控第 18–25 键 +
 *    `1791000001000-PayConfigSeed.ts` 支付第 26–34 键 + `1794000000000-IntervalConfigSeed.ts` 节奏/清理第 35–40 键 +
 *    `1795100000000-AdReliefAdpidSeed.ts` 广告片第 41 键（旧台费第 42 键的历史种子 `1795200000000` 保留可追溯） +
 *    `1795300000000-ClientAccessGateSeed.ts` 客户端接入片第 43/44 键 +
 *    `1795400000000-BotFillConfigSeed.ts` 机器人补位开关片第 45–47 键 +
 *    `1795500000000-RiskWithdrawReAuthSeed.ts` 提现再认证片第 48 键 +
 *    `1795600000000-RiskDeviceBindingSeed.ts` 设备绑定片第 49 键 +
 *    `1795700000000-CardCounterSeed.ts` 记牌器第 50 键 +
 *    `CardCounterPrices1795800000000.ts` 记牌器收费第 51/52 键；
 *    阶段 2 迁移 `1796000000000-RemoveEntryFeePercents.ts` 在最后删除旧台费行）
 *    = `platform-config.service.test.ts` 的 `SEED`（同一事实的既有副本）。
 *
 * 用途：让 `*.test.ts` 以「真 controller + 真 PlatformConfigService + 假库」跑**真 Nest 管线**
 * （形态照 `user-service/test/internal-token.test.ts` 的接线探针）：guard / 异常过滤器 /
 * `@HttpCode` / globalPrefix 都是真行为 —— 状态码不是手写的。
 *
 * ⚠️ 探针**不挂** `createInternalTokenMiddleware()`：那是服务间边界（网关在每一跳注入），
 * 有独立的栈级判据；本夹具只覆盖 T3 的三接口面。
 *
 * ③ T3（2026-10-05 登录改版）起追加第二套假库 `FakeAdminDb`（admin_accounts / admin_login_events
 * 两条表）并把 `startHttpProbe` 第二参改为该假库：管理登录面（§2.3）的用例借此走真管线，
 * 其余消费者（client-config / config.validation）缺省空库即可。
 *
 * 支付配置管理化 T2（2026-10-06）起追加第三套假库 `FakePayChannelDb`（`pay_channel_config` 单表，
 * 渠道凭据第二键空间；T4 首度行使——写事务「锁→ODKU→留痕」与读路径 LIST/DELETE 全经它的分发）。
 *
 * 通知通道管理化 T2（2026-10-07）起追加第四套假库 `FakeNotifyChannelDb`（`notify_channel_config` 单表，
 * 通知凭据第三键空间；T5 首度行使——写事务「锁→ODKU→留痕」与读路径 LIST/DELETE 全经它的分发）。
 *
 * 广告片 T7（2026-10-12）起追加第五套假库 `FakeAdChannelDb`（`ad_channel_config` 单表，广告回调密钥
 * 第四键空间；T7 首度行使——本包 RPC 接收侧用例）。**唯一真源**：T6 曾以 `test/ad-channel.probe.ts`
 * 自含同构副本落位（其简报 Task/文件与本文件落点互斥的权宜），T7 按控制者裁定单向并轨——副本已删，
 * T6 两测（`ad-channel.service/controller.test.ts`）的 import 改指本文件。
 */

/* ------------------------------------------------------------------ *
 * 假库（Row / Em / Repo）
 * ------------------------------------------------------------------ */

export interface FakeRow {
  value: unknown;
  version: number;
  updatedAt: unknown;
  updatedBy: string;
}

/** 事务内的 EntityManager 替身：服务用 `query`（③ T4：锁定读 + 留痕写）/ `update` / `insert` / `findOne`。 */
class FakeEm {
  constructor(private readonly db: FakePlatformDb) {}

  /** 裸 SQL 两条（③ T4）：锁定读（无行 ⇒ 空集）与 config_changes 留痕写。 */
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql === CONFIG_LOCK_SQL) {
      const row = this.db.rows.get(String(params[0]));
      return row ? [{ value: row.value, version: row.version }] : [];
    }
    if (sql === CONFIG_CHANGES_INSERT_SQL) {
      const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
      this.db.changes.push({
        key,
        oldValue: oldValue === null ? null : JSON.parse(oldValue),
        newValue: JSON.parse(newValue),
        actor,
      });
      return { insertId: this.db.changes.length };
    }
    throw new Error(`FakeEm: 未识别的 SQL：${sql}`);
  }

  async update(
    _entity: unknown,
    where: { key: string },
    patch: Record<string, unknown>,
  ): Promise<{ affected: number }> {
    this.db.updateCalls += 1;
    const row = this.db.rows.get(where.key);
    if (!row) return { affected: 0 };
    for (const [field, v] of Object.entries(patch)) {
      const target = row as unknown as Record<string, unknown>;
      if (typeof v === 'function') {
        // 函数值 = SQL 表达式：`version + 1`（相对自增）与 `NOW(3)` 是本服务仅有的两种。
        if (field === 'version') row.version += 1;
        else target[field] = (v as () => unknown)();
      } else {
        target[field] = v;
      }
    }
    return { affected: 1 };
  }

  async insert(_entity: unknown, values: Record<string, unknown> & { key: string }): Promise<unknown> {
    this.db.insertCalls += 1;
    if (this.db.rows.has(values.key)) throw new Error(`Duplicate entry '${values.key}'`);
    this.db.rows.set(values.key, {
      value: values.value,
      version: Number(values.version),
      updatedAt: 'now',
      updatedBy: values.updatedBy as string,
    });
    return { identifiers: [{ key: values.key }] };
  }

  async findOne(_entity: unknown, opts: { where: { key: string } }): Promise<FakeRow | null> {
    const row = this.db.rows.get(opts.where.key);
    return row ? { ...row } : null;
  }
}

/** 内存假库（`platform-config.service.test.ts` 的 FakeDb 去掉锁建模后的形态）。 */
export class FakePlatformDb {
  readonly rows = new Map<string, FakeRow>();
  /** ③ T4 起：`config_changes` 留痕行（写入参数按 mysql2 形态往返：JSON 串进、解析值出）。 */
  readonly changes: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> = [];
  updateCalls = 0;
  insertCalls = 0;

  transaction<T>(cb: (em: FakeEm) => Promise<T>): Promise<T> {
    return cb(new FakeEm(this));
  }
}

/** 五十一键种子（值逐字 = 迁移种子；`platform-config.service.test.ts` 有同一份副本）。 */
const SEED: ReadonlyArray<readonly [string, unknown]> = [
  ['robot.skillDistribution', { beginner: 0.15, intermediate: 0.35, advanced: 0.5 }],
  ['robot.ruleFallback', true],
  ['robot.modelBySkill', { beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' }],
  ['robot.reclaimIntervalMs', 60000],
  ['room.matchScanIntervalMs', 5000],
  ['room.autostartIntervalMs', 5000],
  ['room.reapIntervalMs', 60000],
  ['room.friendRoomEnabled', false],
  [
    'game.baseScoreLevels',
    [
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
      { name: '竞技场', baseScore: 480 },
      { name: '豪侠场', baseScore: 1200 },
    ],
  ],
  ['record.retentionDays', 365],
  ['currency.signupGrant', 0],
  ['room.freeRoomEnabled', true],
  ['room.goldRoomEnabled', true],
  ['currency.entryMultiplier', 10],
  ['currency.rakePercent', 0],
  ['currency.reliefEnabled', false],
  ['currency.reliefAmount', 200],
  // 风控片 T1（第 18–25 键；来自 `1790000001000-RiskConfigSeed.ts`）
  ['risk.predicate.sameDevice', false],
  ['risk.predicate.sameIp', false],
  ['risk.winRateThreshold', 0.8],
  ['risk.minGames', 100],
  ['risk.deviceLimit', 3],
  ['risk.deviceWindowDays', 30],
  ['risk.autoThrottle', true],
  ['risk.deviceRetentionDays', 365],
  // 支付片 T5（第 26–34 键；来自 `1791000001000-PayConfigSeed.ts`，规格 §2.5 九键逐字表）
  ['pay.rechargeEnabled', false],
  ['pay.withdrawEnabled', false],
  ['pay.coinPerYuan', 100],
  ['pay.rechargePackages', [6, 30, 68, 128, 328]],
  ['pay.withdrawMinCoins', 1000],
  ['pay.withdrawMaxCoinsPerOrder', 50000],
  ['pay.withdrawDailyMaxCoins', 100000],
  ['pay.orderExpireMinutes', 30],
  ['pay.withdrawTimeoutMinutes', 4320],
  // 节奏/清理片 T2（第 35–40 键；来自 `1794000000000-IntervalConfigSeed.ts`，规格 ⚙️1 六键逐字表）
  ['pay.scanIntervalMs', 60000],
  ['pay.reconcileIntervalMs', 86400000],
  ['currency.reconcileIntervalMs', 3600000],
  ['risk.scanIntervalMs', 3600000],
  ['risk.devicesCleanupIntervalMs', 3600000],
  ['record.cleanupIntervalMs', 3600000],
  // 广告片 T2（第 41 键；来自 `1795100000000-AdReliefAdpidSeed.ts`，JSON 字面量 '""' ⇒ 空串 = 未配置）
  ['ad.reliefAdpid', ''],
  // 客户端接入片 T2（第 43/44 键；来自 `1795300000000-ClientAccessGateSeed.ts`，双 true = 暗上线全开）
  ['client.appEnabled', true],
  ['client.h5Enabled', true],
  // 机器人补位开关片（第 45–47 键；来自 `1795400000000-BotFillConfigSeed.ts`；双开关 true = 暗上线）
  ['room.freeBotFillEnabled', true],
  ['room.goldBotFillEnabled', true],
  ['room.matchNoBotMaxWaitMs', 300000],
  // 提现再认证片（第 48 键；来自 `1795500000000-RiskWithdrawReAuthSeed.ts`；false = 暗上线）
  ['risk.withdrawReAuthEnabled', false],
  // 设备绑定片（第 49 键；来自 `1795600000000-RiskDeviceBindingSeed.ts`，false = 暗上线）
  ['risk.deviceBindingEnabled', false],
  // 记牌器片（第 50 键；来自 `1795700000000-CardCounterSeed.ts`，true = 保持现状）
  ['game.cardCounterEnabled', true],
  // 记牌器收费片（第 51/52 键；来自 `CardCounterPrices1795800000000`，10/100 = 首发价）
  ['game.cardCounterPricePerGameCoins', 10],
  ['game.cardCounterPricePerHourCoins', 100],
  // 多玩法（Task 5.1；来自 `MultiGameConfigSeed1796300000000`；值 = DEFAULT_PDK_RULES / 文档默认表）
  [
    'game.levels.paodekuai',
    [
      { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
      { name: '标准场', baseScore: 80, entryFeePercent: 0 },
      { name: '竞技场', baseScore: 480, entryFeePercent: 0 },
      { name: '豪侠场', baseScore: 1200, entryFeePercent: 0 },
    ],
  ],
  ['game.paodekuai.enabled', false],
  ['game.paodekuai.nonThreePlayerEnabled', false],
  ['game.paodekuai.bareTrioEnabled', true],
  ['game.paodekuai.trioWithPairEnabled', false],
  ['game.paodekuai.bareAirplaneEnabled', false],
  ['game.paodekuai.fourWithTwoEnabled', true],
  ['game.paodekuai.fourWithTwoPairKickerAllowed', false],
  ['game.paodekuai.airplaneWings', 'pairs'],
  ['game.paodekuai.bombMultiplierEnabled', true],
  ['game.paodekuai.guanMultiplierEnabled', true],
  ['game.paodekuai.springMultiplierEnabled', true],
  ['game.paodekuai.multiplierCap', 64],
  ['game.paodekuai.baobenEnabled', true],
  // 配置平行化（2026-10-24；来自 `SplitGameConfig1796500000000`）
  ['game.doudizhu.freeRoomEnabled', true],
  ['game.doudizhu.goldRoomEnabled', true],
  ['game.doudizhu.friendRoomEnabled', false],
  ['game.doudizhu.freeBotFillEnabled', true],
  ['game.doudizhu.goldBotFillEnabled', true],
  ['game.doudizhu.rakePercent', 0],
  ['game.doudizhu.entryMultiplier', 10],
  ['game.levels.doudizhu', [
    { name: '休闲场', baseScore: 15 },
    { name: '标准场', baseScore: 80 },
    { name: '竞技场', baseScore: 480 },
    { name: '豪侠场', baseScore: 1200 },
  ]],
  ['game.doudizhu.cardCounterEnabled', true],
  ['game.doudizhu.cardCounterPricePerGameCoins', 10],
  ['game.doudizhu.cardCounterPricePerHourCoins', 100],
  ['game.doudizhu.robot.skillDistribution', { beginner: 0.15, intermediate: 0.35, advanced: 0.5 }],
  ['game.doudizhu.robot.ruleFallback', true],
  ['game.doudizhu.robot.modelBySkill', { beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' }],
  ['game.doudizhu.risk.winRateThreshold', 0.8],
  ['game.doudizhu.risk.minGames', 100],
  ['game.paodekuai.freeRoomEnabled', true],
  ['game.paodekuai.goldRoomEnabled', false],
  ['game.paodekuai.friendRoomEnabled', false],
  ['game.paodekuai.freeBotFillEnabled', true],
  ['game.paodekuai.goldBotFillEnabled', true],
  ['game.paodekuai.rakePercent', 0],
  ['game.paodekuai.entryMultiplier', 10],
  ['currency.reliefThresholdCoins', 150],
];

export function seedDb(): FakePlatformDb {
  const db = new FakePlatformDb();
  for (const [key, value] of SEED) {
    db.rows.set(key, { value, version: 1, updatedAt: 'seed', updatedBy: 'seed' });
  }
  return db;
}

function makeRepo(db: FakePlatformDb) {
  const find = vi.fn(async () => [...db.rows.entries()].map(([key, r]) => ({ key, ...r })));
  const findOne = vi.fn(async (opts: { where: { key: string } }) => {
    const r = db.rows.get(opts.where.key);
    return r ? { key: opts.where.key, ...r } : null;
  });
  const transaction = <T>(cb: (em: unknown) => Promise<T>): Promise<T> => db.transaction(cb as (em: FakeEm) => Promise<T>);
  return { find, findOne, manager: { transaction } };
}

/** 真 `PlatformConfigService` + 假库 + 假 redis（`publish` 用 spy，成败可控）。 */
export function makeService(db: FakePlatformDb) {
  const repo = makeRepo(db);
  const publish = vi.fn(async () => 1);
  const svc = new PlatformConfigService(repo as never, { publish } as never);
  return { svc, db, repo, publish };
}

/* ------------------------------------------------------------------ *
 * 管理账号/登录事件的假库（③ T3：登录面）
 * ------------------------------------------------------------------ */

export interface FakeAdminAccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
}

export interface FakeLoginEventRow {
  username: string;
  account_id: number | null;
  ip: string | null;
  success: number;
}

export interface RecordedAdminQuery {
  sql: string;
  params: unknown[];
}

/**
 * 登录面的内存假库：只认识被测源码导出的四条 SQL 常量
 * （`ADMIN_ENABLED_SQL` / `ADMIN_FIND_ACCOUNT_SQL` / `ADMIN_TOUCH_LOGIN_SQL` / `LOGIN_EVENT_INSERT_SQL`
 * —— 实现改 SQL 文案时这里**当场红**，防「假库与真 SQL 各说各话」）。
 *
 * ⚠️ 不建模行锁/并发（同 `FakePlatformDb` 的取舍）；登录路径本来就没有锁定读。
 */
export class FakeAdminDb {
  readonly accounts: FakeAdminAccountRow[] = [];
  readonly events: FakeLoginEventRow[] = [];
  readonly queries: RecordedAdminQuery[] = [];
  private nextId = 1;

  /** 直插一行（测试造数；`password_hash` 缺省为占位串——只在走真 verify 的用例里传真哈希）。 */
  addAccount(over: Partial<FakeAdminAccountRow> & { username: string }): FakeAdminAccountRow {
    const row: FakeAdminAccountRow = {
      id: this.nextId++,
      password_hash: 'seeded-placeholder-hash',
      role: 'viewer',
      status: 'active',
      created_at: new Date('2026-10-05T00:00:00.000Z'),
      last_login_at: null,
      ...over,
    };
    this.accounts.push(row);
    return row;
  }

  /** 只清事件与查询记录（账号保留——用例间的造数不重复搭台）。 */
  resetLogs(): void {
    this.events.length = 0;
    this.queries.length = 0;
  }

  readonly dataSource = {
    query: (sql: string, params?: unknown[]): Promise<unknown> => this.exec(sql, params ?? []),
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === ADMIN_ENABLED_SQL) {
      // 真 MySQL 对 `SELECT 1 …` 回一行；这里只按「有无行」判定启用谓词
      return this.accounts.length > 0 ? [{ ok: 1 }] : [];
    }
    if (sql === ADMIN_FIND_ACCOUNT_SQL) {
      const row = this.accounts.find((a) => a.username === params[0]);
      return row
        ? [
            {
              id: row.id,
              username: row.username,
              password_hash: row.password_hash,
              role: row.role,
              status: row.status,
            },
          ]
        : [];
    }
    if (sql === ADMIN_TOUCH_LOGIN_SQL) {
      const row = this.accounts.find((a) => a.id === Number(params[0]));
      if (!row) return { affected: 0 };
      row.last_login_at = new Date('2026-10-05T12:00:00.000Z');
      return { affected: 1 };
    }
    if (sql === LOGIN_EVENT_INSERT_SQL) {
      const [username, account_id, ip, success] = params as [
        string,
        number | null,
        string | null,
        number,
      ];
      this.events.push({ username, account_id, ip, success });
      return { insertId: this.events.length };
    }
    throw new Error(`FakeAdminDb: 未识别的 SQL：${sql}`);
  }
}

/* ------------------------------------------------------------------ *
 * 支付渠道键空间的假库（支付配置管理化 T2：`pay_channel_config`；T4–T6 消费）
 * ------------------------------------------------------------------ */

/**
 * 规格 §2.2 四条 SQL 常量的**测试侧逐字誊写**（形态照 `user-service/test/risk-devices.test.ts`
 * 的 `SPEC_DEVICE_UPSERT_SQL`）：T2 时实现常量还不存在（落点在 T4 `src/pay-channel/pay-channel.service.ts`），
 * 假库的 SQL 分发只认这四份文本 —— T4 落地后由其用例补「实现常量 === 本誊写」的**全文互钉**断言
 * （实现一漂移：互钉先红；即便漏钉，假库分发的未识别 SQL 也会让行为用例当场红）。
 */
export const SPEC_PAY_CHANNEL_LOCK_SQL =
  'SELECT value_enc, fingerprint FROM pay_channel_config WHERE `key`=? FOR UPDATE';
export const SPEC_PAY_CHANNEL_UPSERT_SQL =
  'INSERT INTO pay_channel_config (`key`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)';
export const SPEC_PAY_CHANNEL_LIST_SQL =
  'SELECT `key`, value_enc, fingerprint, updated_at, updated_by FROM pay_channel_config';
export const SPEC_PAY_CHANNEL_DELETE_SQL =
  'DELETE FROM pay_channel_config WHERE `key`=?';

/** 一行渠道凭据（`updated_at` 恒为 Date —— mysql2 对 `datetime(3)` 的返回形态）。 */
export interface FakePayChannelRow {
  value_enc: string;
  fingerprint: string;
  updated_at: Date;
  updated_by: string;
}

/** 事务内 EM 替身（T4 的 `dataSource.transaction(em => …)` 消费；`em.query` 与 `dataSource.query` 同分发）。 */
export interface FakePayChannelEm {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * 支付渠道单表的假库（T2 交付物；T4 首度行使）。
 *
 * 被建模的库行为（承重语义）：
 *  - **UPSERT（ODKU）**：无行 ⇒ 插入；有行 ⇒ 覆盖 value_enc / fingerprint / updated_by / updated_at
 *    （唯一键 = `key` 主键，行数恒 ≤ 行键数）；
 *  - **锁定读按既有形态处理**（同 `FakeEm` / `FakeAdminDb` 的取舍）：`FOR UPDATE` **不建模真锁**，
 *    只做 SELECT 语义（有行 ⇒ 恰 `[value_enc, fingerprint]` 单行，无行 ⇒ 空集）——并发语义留给
 *    T4 的「1213 重试注入」用例（规格 §5.1-3：假库不建模锁）；
 *  - **留痕写**（`CONFIG_CHANGES_INSERT_SQL`，T4 写事务序③同事务）：按 mysql2 形态往返
 *    （JSON 串进、解析值出），落 `changes`。
 *
 * 只认识五条 SQL 全文（§2.2 四条 + 既有留痕写）；未识别 ⇒ 抛 —— 防「假库与真 SQL 各说各话」。
 */
export class FakePayChannelDb {
  readonly rows = new Map<string, FakePayChannelRow>();
  /** 留痕行（`config_changes` 同族形状；T4 的审计断言直查此处，不经被测系统）。 */
  readonly changes: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> = [];
  /** 全部语句的观测面（次序 / 参数 / 条数）。 */
  readonly queries: RecordedAdminQuery[] = [];
  /** 仿真 `NOW(3)` 的代面（照 risk-devices `FakeDb.now` 先例）：UPSERT 的 `updated_at` 取写入当刻值；
   *  用例可重设以钉时刻（默认 = 构造时刻）。 */
  now: Date = new Date();

  /** 直插一行（测试造数；真路径一律经 UPSERT —— T4 的「已配置 / 坏密文」前置用）。 */
  addRow(key: string, over: Partial<FakePayChannelRow> = {}): FakePayChannelRow {
    const row: FakePayChannelRow = {
      value_enc: 'v1:seeded',
      fingerprint: '000000000000',
      updated_at: this.now,
      updated_by: 'seed',
      ...over,
    };
    this.rows.set(key, row);
    return row;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
    transaction: <T>(cb: (em: FakePayChannelEm) => Promise<T>): Promise<T> =>
      cb({ query: (sql: string, params: unknown[] = []) => this.exec(sql, params) }),
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === SPEC_PAY_CHANNEL_LOCK_SQL) {
      const row = this.rows.get(String(params[0]));
      return row ? [{ value_enc: row.value_enc, fingerprint: row.fingerprint }] : [];
    }
    if (sql === SPEC_PAY_CHANNEL_UPSERT_SQL) {
      const [key, value_enc, fingerprint, updated_by] = params as [string, string, string, string];
      const isNew = !this.rows.has(key);
      this.rows.set(key, { value_enc, fingerprint, updated_at: this.now, updated_by });
      // mysql2 形态：affectedRows = 1（插入）/ 2（ODKU 覆盖）——两份都无消费点，如实建模备查。
      return { affectedRows: isNew ? 1 : 2, insertId: 0 };
    }
    if (sql === SPEC_PAY_CHANNEL_LIST_SQL) {
      // W1-1 硬化（评审波 1）：真库 LIST 无 ORDER BY、InnoDB 典型按 `key` 返回 ⇒ 假库照此**按 key 排序**。
      // 目的：若将来有人删掉 service 侧的显式 ⚙️1 排序，输出序会随种子插入序变化 ⇒ 本假库（key 序）
      // 与服务输出（映射 `PAY_CHANNEL_KEYS`）不再同源 ⇒ 顺序断言当场红，而非静默通过。
      return [...this.rows.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, r]) => ({ key, ...r }));
    }
    if (sql === SPEC_PAY_CHANNEL_DELETE_SQL) {
      const existed = this.rows.delete(String(params[0]));
      return { affectedRows: existed ? 1 : 0 };
    }
    if (sql === CONFIG_CHANGES_INSERT_SQL) {
      const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
      this.changes.push({
        key,
        oldValue: oldValue === null ? null : JSON.parse(oldValue),
        newValue: JSON.parse(newValue),
        actor,
      });
      return { insertId: this.changes.length };
    }
    throw new Error(`FakePayChannelDb: 未识别的 SQL：${sql}`);
  }
}

/* ------------------------------------------------------------------ *
 * 通知通道键空间的假库（通知通道管理化 T2：`notify_channel_config`；T5 消费）
 * ------------------------------------------------------------------ */

/**
 * 规格 §2.2 四条 SQL 常量的**测试侧逐字誊写**（形态照 `SPEC_PAY_CHANNEL_*` 一族，逐字同构
 * 仅表名替换——规格 §2.2 末行）：T2 时实现常量还不存在（落点在 T5
 * `src/notify-channel/notify-channel.service.ts`），假库的 SQL 分发只认这四份文本 ——
 * T5 落地后由其用例补「实现常量 === 本誊写」的**全文互钉**断言（实现一漂移：互钉先红；
 * 即便漏钉，假库分发的未识别 SQL 也会让行为用例当场红）。
 */
export const SPEC_NOTIFY_CHANNEL_LOCK_SQL =
  'SELECT value_enc, fingerprint FROM notify_channel_config WHERE `key`=? FOR UPDATE';
export const SPEC_NOTIFY_CHANNEL_UPSERT_SQL =
  'INSERT INTO notify_channel_config (`key`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)';
export const SPEC_NOTIFY_CHANNEL_LIST_SQL =
  'SELECT `key`, value_enc, fingerprint, updated_at, updated_by FROM notify_channel_config';
export const SPEC_NOTIFY_CHANNEL_DELETE_SQL =
  'DELETE FROM notify_channel_config WHERE `key`=?';

/** 一行通知凭据（`updated_at` 恒为 Date —— mysql2 对 `datetime(3)` 的返回形态）。 */
export interface FakeNotifyChannelRow {
  value_enc: string;
  fingerprint: string;
  updated_at: Date;
  updated_by: string;
}

/** 事务内 EM 替身（T5 的 `dataSource.transaction(em => …)` 消费；`em.query` 与 `dataSource.query` 同分发）。 */
export interface FakeNotifyChannelEm {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * 通知通道单表的假库（T2 交付物；T5 首度行使）——**逐字同构 `FakePayChannelDb`**（仅表名替换）。
 *
 * 被建模的库行为（承重语义）：
 *  - **UPSERT（ODKU）**：无行 ⇒ 插入；有行 ⇒ 覆盖 value_enc / fingerprint / updated_by / updated_at
 *    （唯一键 = `key` 主键，行数恒 ≤ 行键数）；
 *  - **锁定读按既有形态处理**（同 `FakeEm` / `FakeAdminDb` 的取舍）：`FOR UPDATE` **不建模真锁**，
 *    只做 SELECT 语义（有行 ⇒ 恰 `[value_enc, fingerprint]` 单行，无行 ⇒ 空集）——并发语义留给
 *    T5 的「1213 重试注入」用例（规格 §5.1-3：假库不建模锁）；
 *  - **留痕写**（`CONFIG_CHANGES_INSERT_SQL`，T5 写事务序③同事务）：按 mysql2 形态往返
 *    （JSON 串进、解析值出），落 `changes`。
 *
 * 只认识五条 SQL 全文（§2.2 四条 + 既有留痕写）；未识别 ⇒ 抛 —— 防「假库与真 SQL 各说各话」。
 */
export class FakeNotifyChannelDb {
  readonly rows = new Map<string, FakeNotifyChannelRow>();
  /** 留痕行（`config_changes` 同族形状；T5 的审计断言直查此处，不经被测系统）。 */
  readonly changes: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> = [];
  /** 全部语句的观测面（次序 / 参数 / 条数）。 */
  readonly queries: RecordedAdminQuery[] = [];
  /** 仿真 `NOW(3)` 的代面（照 risk-devices `FakeDb.now` 先例）：UPSERT 的 `updated_at` 取写入当刻值；
   *  用例可重设以钉时刻（默认 = 构造时刻）。 */
  now: Date = new Date();

  /** 直插一行（测试造数；真路径一律经 UPSERT —— T5 的「已配置 / 坏密文」前置用）。 */
  addRow(key: string, over: Partial<FakeNotifyChannelRow> = {}): FakeNotifyChannelRow {
    const row: FakeNotifyChannelRow = {
      value_enc: 'v1:seeded',
      fingerprint: '000000000000',
      updated_at: this.now,
      updated_by: 'seed',
      ...over,
    };
    this.rows.set(key, row);
    return row;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
    transaction: <T>(cb: (em: FakeNotifyChannelEm) => Promise<T>): Promise<T> =>
      cb({ query: (sql: string, params: unknown[] = []) => this.exec(sql, params) }),
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === SPEC_NOTIFY_CHANNEL_LOCK_SQL) {
      const row = this.rows.get(String(params[0]));
      return row ? [{ value_enc: row.value_enc, fingerprint: row.fingerprint }] : [];
    }
    if (sql === SPEC_NOTIFY_CHANNEL_UPSERT_SQL) {
      const [key, value_enc, fingerprint, updated_by] = params as [string, string, string, string];
      const isNew = !this.rows.has(key);
      this.rows.set(key, { value_enc, fingerprint, updated_at: this.now, updated_by });
      // mysql2 形态：affectedRows = 1（插入）/ 2（ODKU 覆盖）——两份都无消费点，如实建模备查。
      return { affectedRows: isNew ? 1 : 2, insertId: 0 };
    }
    if (sql === SPEC_NOTIFY_CHANNEL_LIST_SQL) {
      // W1-1 硬化（支付片评审波 1；本族逐字同构照抄）：真库 LIST 无 ORDER BY、InnoDB 典型按 `key`
      // 返回 ⇒ 假库照此**按 key 排序**。目的：若将来有人删掉 service 侧的显式 ⚙️1 排序，输出序
      // 会随种子插入序变化 ⇒ 本假库（key 序）与服务输出（映射 `NOTIFY_CHANNEL_KEYS`）不再同源
      // ⇒ 顺序断言当场红，而非静默通过。
      return [...this.rows.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, r]) => ({ key, ...r }));
    }
    if (sql === SPEC_NOTIFY_CHANNEL_DELETE_SQL) {
      const existed = this.rows.delete(String(params[0]));
      return { affectedRows: existed ? 1 : 0 };
    }
    if (sql === CONFIG_CHANGES_INSERT_SQL) {
      const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
      this.changes.push({
        key,
        oldValue: oldValue === null ? null : JSON.parse(oldValue),
        newValue: JSON.parse(newValue),
        actor,
      });
      return { insertId: this.changes.length };
    }
    throw new Error(`FakeNotifyChannelDb: 未识别的 SQL：${sql}`);
  }
}

/* ------------------------------------------------------------------ *
 * 广告回调密钥键空间的假库（广告片 T7 并轨：`ad_channel_config`；T6 两测 + T7 接收侧消费）
 * ------------------------------------------------------------------ */

/**
 * 规格 §2.3 四条 SQL 常量的**测试侧逐字誊写**（形态照 `SPEC_PAY_CHANNEL_*` / `SPEC_NOTIFY_CHANNEL_*`
 * 一族，逐字同构仅表名替换）：**T7 起本文件为唯一真源**——T6 的 `test/ad-channel.probe.ts` 自含
 * 同构副本随 T7 单向并轨删除（双份并存被 T6 报告登记为待处置，不得留到终态）。实现常量早已落地
 * （T6 `src/ad-channel/ad-channel.service.ts`），其 service 用例的「实现常量 === 本誊写」**全文互钉**
 * 断言迁指本文件（实现一漂移：互钉先红；即便漏钉，假库分发的未识别 SQL 也会让行为用例当场红）。
 */
export const SPEC_AD_CHANNEL_LOCK_SQL =
  'SELECT value_enc, fingerprint FROM ad_channel_config WHERE `key`=? FOR UPDATE';
export const SPEC_AD_CHANNEL_UPSERT_SQL =
  'INSERT INTO ad_channel_config (`key`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)';
export const SPEC_AD_CHANNEL_LIST_SQL =
  'SELECT `key`, value_enc, fingerprint, updated_at, updated_by FROM ad_channel_config';
export const SPEC_AD_CHANNEL_DELETE_SQL =
  'DELETE FROM ad_channel_config WHERE `key`=?';

/** 一行广告回调密钥（`updated_at` 恒为 Date —— mysql2 对 `datetime(3)` 的返回形态）。 */
export interface FakeAdChannelRow {
  value_enc: string;
  fingerprint: string;
  updated_at: Date;
  updated_by: string;
}

/** 事务内 EM 替身（`dataSource.transaction(em => …)` 消费；`em.query` 与 `dataSource.query` 同分发）。 */
export interface FakeAdChannelEm {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * 广告回调密钥单表的假库（T6 落位、**T7 并轨入本文件为唯一真源**）——**逐字同构 `FakePayChannelDb` /
 * `FakeNotifyChannelDb`**（仅表名替换）。
 *
 * 被建模的库行为（承重语义）：
 *  - **UPSERT（ODKU）**：无行 ⇒ 插入；有行 ⇒ 覆盖 value_enc / fingerprint / updated_by / updated_at
 *    （唯一键 = `key` 主键，行数恒 ≤ 行键数）；
 *  - **锁定读按既有形态处理**（同 `FakeEm` / `FakeAdminDb` 的取舍）：`FOR UPDATE` **不建模真锁**，
 *    只做 SELECT 语义（有行 ⇒ 恰 `[value_enc, fingerprint]` 单行，无行 ⇒ 空集）——并发语义留给
 *    「1213 重试注入」用例（规格 §5.1-3：假库不建模锁）；
 *  - **留痕写**（`CONFIG_CHANGES_INSERT_SQL`，写事务序③同事务）：按 mysql2 形态往返
 *    （JSON 串进、解析值出），落 `changes`。
 *
 * 只认识五条 SQL 全文（§2.3 四条 + 既有留痕写）；未识别 ⇒ 抛 —— 防「假库与真 SQL 各说各话」。
 */
export class FakeAdChannelDb {
  readonly rows = new Map<string, FakeAdChannelRow>();
  /** 留痕行（`config_changes` 同族形状；审计断言直查此处，不经被测系统）。 */
  readonly changes: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> = [];
  /** 全部语句的观测面（次序 / 参数 / 条数）。 */
  readonly queries: RecordedAdminQuery[] = [];
  /** 仿真 `NOW(3)` 的代面（照 risk-devices `FakeDb.now` 先例）：UPSERT 的 `updated_at` 取写入当刻值；
   *  用例可重设以钉时刻（默认 = 构造时刻）。 */
  now: Date = new Date();

  /** 直插一行（测试造数；真路径一律经 UPSERT —— 「已配置 / 坏密文」前置用）。 */
  addRow(key: string, over: Partial<FakeAdChannelRow> = {}): FakeAdChannelRow {
    const row: FakeAdChannelRow = {
      value_enc: 'v1:seeded',
      fingerprint: '000000000000',
      updated_at: this.now,
      updated_by: 'seed',
      ...over,
    };
    this.rows.set(key, row);
    return row;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
    transaction: <T>(cb: (em: FakeAdChannelEm) => Promise<T>): Promise<T> =>
      cb({ query: (sql: string, params: unknown[] = []) => this.exec(sql, params) }),
  };

  private async exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql === SPEC_AD_CHANNEL_LOCK_SQL) {
      const row = this.rows.get(String(params[0]));
      return row ? [{ value_enc: row.value_enc, fingerprint: row.fingerprint }] : [];
    }
    if (sql === SPEC_AD_CHANNEL_UPSERT_SQL) {
      const [key, value_enc, fingerprint, updated_by] = params as [string, string, string, string];
      const isNew = !this.rows.has(key);
      this.rows.set(key, { value_enc, fingerprint, updated_at: this.now, updated_by });
      // mysql2 形态：affectedRows = 1（插入）/ 2（ODKU 覆盖）——两份都无消费点，如实建模备查。
      return { affectedRows: isNew ? 1 : 2, insertId: 0 };
    }
    if (sql === SPEC_AD_CHANNEL_LIST_SQL) {
      // W1-1 硬化（支付片评审波 1；本族逐字同构照抄）：真库 LIST 无 ORDER BY、InnoDB 典型按 `key`
      // 返回 ⇒ 假库照此**按 key 排序**。目的：若将来有人删掉 service 侧的显式 ⚙️1 排序，输出序
      // 会随种子插入序变化 ⇒ 本假库（key 序）与服务输出（映射 `AD_CHANNEL_KEYS`）不再同源
      // ⇒ 顺序断言当场红，而非静默通过。
      return [...this.rows.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, r]) => ({ key, ...r }));
    }
    if (sql === SPEC_AD_CHANNEL_DELETE_SQL) {
      const existed = this.rows.delete(String(params[0]));
      return { affectedRows: existed ? 1 : 0 };
    }
    if (sql === CONFIG_CHANGES_INSERT_SQL) {
      const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
      this.changes.push({
        key,
        oldValue: oldValue === null ? null : JSON.parse(oldValue),
        newValue: JSON.parse(newValue),
        actor,
      });
      return { insertId: this.changes.length };
    }
    throw new Error(`FakeAdChannelDb: 未识别的 SQL：${sql}`);
  }
}

/* ------------------------------------------------------------------ *
 * 真 Nest 管线的 HTTP 探针
 * ------------------------------------------------------------------ */

@Module({})
class HttpProbeModule {
  /** 用 useValue 注入**实例**（假库在测试侧持有；`give: 真 controller`）。 */
  static wiring(
    svc: PlatformConfigService,
    auth: AdminAuthService,
    events: LoginEventsService,
  ): DynamicModule {
    return {
      module: HttpProbeModule,
      controllers: [AdminController, ClientConfigController],
      providers: [
        { provide: PlatformConfigService, useValue: svc },
        { provide: AdminAuthService, useValue: auth },
        { provide: LoginEventsService, useValue: events },
      ],
    };
  }
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export interface HttpProbe {
  url: string;
  /** 具名实例：用例可 spy（如 `signToken`）——③ T3 起登录面消费。 */
  auth: AdminAuthService;
  /** 登录面的假库引用（事件/查询断言直查，不经 HTTP——不用被测系统证明被测系统）。 */
  adminDb: FakeAdminDb;
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  putJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

/**
 * 起一个真 Nest HTTP 应用（真 controller + 真 guard + 真异常过滤器 + globalPrefix `api`）。
 *
 * ⚠️ 与 `src/main.ts` 相同的是：`ValidationPipe({whitelist, transform})` + `setGlobalPrefix('api')`；
 * 不做的是：internal-token 中间件与 TCP 微服务（见文件头）。
 *
 * ③ T3 起第二个参数从 `AdminAuthService` 实例改为**登录面假库**（`adminDb`，缺省 = 空库）：
 * auth 与 login-events 两服务都从它的 `dataSource` 构造，实例挂回返回值的 `auth` 上供 spy。
 * 传入**非空**库 = 管理面启用态（登录可成功）；缺省空库 = 零账号（登录 404）。
 */
export async function startHttpProbe(
  svc: PlatformConfigService,
  adminDb: FakeAdminDb = new FakeAdminDb(),
): Promise<HttpProbe> {
  const auth = new AdminAuthService(adminDb.dataSource as unknown as DataSource);
  const events = new LoginEventsService(adminDb.dataSource as unknown as DataSource);
  const app: INestApplication = await NestFactory.create(
    HttpProbeModule.wiring(svc, auth, events),
    {
      logger: false,
    },
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  return {
    url,
    auth,
    adminDb,
    get: (path, headers) => request('GET', path, undefined, headers),
    postJson: (path, body, headers) => request('POST', path, body, headers),
    putJson: (path, body, headers) => request('PUT', path, body, headers),
    close: async () => {
      await app.close();
    },
  };
}
