/**
 * `PlatformConfigService`（规格 §2.1 的 version 语义 / C12 / C13 单测半边 / C5 半边）。
 *
 * ⚠️ **射程**：这是**单测** —— 数据层是**内存假库**（原参照的 `user-service/test/base-score-levels.test.ts`
 * 已随片⑦ T13 退役；此处自含——事务/行锁语义**本身就是被判据**，桩不能是「只记调用」的空壳）。
 *
 * 假库实现两条与 InnoDB 对应的语义（`FakeDb`/`FakeEm` 上各有一条注释说明「不建模」的部分）：
 *  ① **单条语句原子**：一次 `update`/`insert` 调用要么整体生效、要么整体不生效；
 *  ② **写锁跨语句持有到事务结束**：第一个写某 `key` 的事务锁住该键，其余事务的同键写入
 *     **挂起等待**（同键并发被串行化 —— 正确实现依赖它把 `version` 拿到严格 +2；
 *     「先读后写绝对版本」的错实现会被本文件的并发用例当场抓住）。
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ProtocolError } from '@fight-the-landlord/protocol';
import {
  CONFIG_CHANGED_CHANNEL,
  PlatformConfigService,
} from '../src/config/platform-config.service';
import {
  CONFIG_CHANGES_INSERT_SQL,
  CONFIG_LOCK_SQL,
} from '../src/admin/admin-changes.service';

/* ------------------------------------------------------------------ *
 * 假库（FakeDb / FakeEm）
 * ------------------------------------------------------------------ */

/** 一条内存行（形状 = platform_config 的一行；`updatedAt` 不参与断言、原样收下）。 */
interface FakeRow {
  value: unknown;
  version: number;
  updatedAt: unknown;
  updatedBy: string;
}

interface LockEntry {
  promise: Promise<void>;
  release: () => void;
}

/** 一条 config_changes 留痕行（假库把写入参数按 mysql2 形态往返：JSON 串进、解析值出）。 */
interface FakeChangeRecord {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  actor: string;
}

/**
 * 内存假库。
 *
 * ⚠️ **有意不建模**（防止下一个人当它是 InnoDB）：
 *  - 并发首建的**另一种交错**（两个 UPDATE 都 affected=0、随后 INSERT 撞唯一键）在
 *    写锁串行化下不会自然发生 —— 该路径由用例 ③′ 以**脚本化替身**单独覆盖；
 *  - 不加锁的 SELECT 读到的永远是当前值（不检查锁持有者）—— 正确实现的读都发生在
 *    **自己持锁之后**，不受影响。
 */
class FakeDb {
  readonly rows = new Map<string, FakeRow>();
  readonly changes: FakeChangeRecord[] = [];
  /** 事务内语句执行序（'lock' / 'update' / 'insert' / 'find' / 'change'）——用于钉「锁定读在最前、留痕在最后」。 */
  readonly ops: string[] = [];
  updateCalls = 0;
  insertCalls = 0;

  private readonly locks = new Map<string, LockEntry>();

  async transaction<T>(cb: (em: FakeEm) => Promise<T>): Promise<T> {
    const held = new Map<string, LockEntry>();
    try {
      return await cb(new FakeEm(this, held));
    } finally {
      // 事务结束 ⇒ 释放全部持有的行锁（InnoDB 的提交/回滚等价物）。
      for (const [key, mine] of held) {
        if (this.locks.get(key) === mine) this.locks.delete(key);
        mine.release();
      }
    }
  }

  /** 单键写锁：同键写入串行化；唤醒后**重查**（多个等待者只有一个能拿到）。 */
  async acquire(key: string, held: Map<string, LockEntry>): Promise<void> {
    if (held.has(key)) return; // 同一事务重复写同键：已持有
    while (this.locks.has(key)) {
      await this.locks.get(key)!.promise;
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine: LockEntry = { promise, release };
    this.locks.set(key, mine);
    held.set(key, mine);
  }
}

/** 事务内的 EntityManager 替身：服务用 `query`（锁定读/留痕写）/ `update` / `insert` / `findOne`。 */
class FakeEm {
  constructor(
    private readonly db: FakeDb,
    private readonly held: Map<string, LockEntry>,
  ) {}

  /**
   * 裸 SQL 两条（③ T4：`set()` 的锁定读 + 留痕写）。锁定读**先取该键的写锁**——
   * 与 InnoDB 的 `FOR UPDATE` 语义对应：并发写被串行化到读之后的整段事务。
   */
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql === CONFIG_LOCK_SQL) {
      const key = String(params[0]);
      await this.db.acquire(key, this.held);
      this.db.ops.push('lock');
      const row = this.db.rows.get(key);
      return row ? [{ value: row.value, version: row.version }] : [];
    }
    if (sql === CONFIG_CHANGES_INSERT_SQL) {
      const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
      this.db.ops.push('change');
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
    this.db.ops.push('update');
    await this.db.acquire(where.key, this.held);
    const row = this.db.rows.get(where.key);
    if (!row) return { affected: 0 };
    for (const [field, v] of Object.entries(patch)) {
      const target = row as unknown as Record<string, unknown>;
      if (typeof v === 'function') {
        // 函数值 = SQL 表达式：只有 `version + 1` 这类**相对自增**会被这样表达
        // （绝对写是普通数字）。这是「行锁 + 相对自增 ⇒ 并发不丢版本」的关键性质。
        if (field === 'version') row.version += 1;
        else target[field] = (v as () => unknown)();
      } else {
        target[field] = v;
      }
    }
    return { affected: 1 };
  }

  async insert(
    _entity: unknown,
    values: Record<string, unknown> & { key: string },
  ): Promise<{ identifiers: unknown[] }> {
    this.db.insertCalls += 1;
    this.db.ops.push('insert');
    await this.db.acquire(values.key, this.held);
    if (this.db.rows.has(values.key)) throw duplicateKeyError(values.key);
    const at = values.updatedAt;
    this.db.rows.set(values.key, {
      value: values.value,
      version: Number(values.version),
      updatedAt: typeof at === 'function' ? (at as () => unknown)() : at,
      updatedBy: values.updatedBy as string,
    });
    return { identifiers: [{ key: values.key }] };
  }

  async findOne(_entity: unknown, opts: { where: { key: string } }): Promise<FakeRow | null> {
    this.db.ops.push('find');
    const row = this.db.rows.get(opts.where.key);
    return row ? { ...row } : null;
  }
}

/** TypeORM 的 `QueryFailedError`（底下的 mysql2 错误带 `ER_DUP_ENTRY` / `errno 1062`）。 */
function duplicateKeyError(key: string): Error {
  const err = new Error(`Duplicate entry '${key}' for key 'PRIMARY'`) as Error & {
    driverError?: unknown;
    code?: string;
  };
  err.name = 'QueryFailedError';
  err.code = 'ER_DUP_ENTRY';
  err.driverError = Object.assign(new Error('Duplicate entry'), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
  return err;
}

/* ------------------------------------------------------------------ *
 * 夹具与种子
 * ------------------------------------------------------------------ */

/** §2.2 + 记录片 + 货币核心 + ② 金币场 + 风控片 + 支付片 + 节奏/清理片 + 广告片 + 客户端接入片 + 机器人补位开关片 + 设备绑定片 + 记牌器片 + 多玩法/平行化 + 跑得快风控一百键种子（值逐字 = 迁移种子；第 10 键 `record.retentionDays`
 *  来自记录片种子迁移、第 11 键 `currency.signupGrant` 来自货币核心种子迁移、第 12–17 键来自
 *  `1789800000000-GoldRoom.ts`、风控第 18–25 键来自 `1790000001000-RiskConfigSeed.ts`、
 *  支付第 26–34 键来自 `1791000001000-PayConfigSeed.ts`、节奏/清理第 35–40 键来自 `1794000000000-IntervalConfigSeed.ts`、
 *  广告片第 41 键来自 `1795100000000-AdReliefAdpidSeed.ts`、台费片第 42 键来自 `1795200000000-EntryFeePercentsSeed.ts`、
 *  客户端接入片第 43/44 键来自 `1795300000000-ClientAccessGateSeed.ts`、机器人补位开关片第 45–47 键来自
 *  `1795400000000-BotFillConfigSeed.ts`、提现再认证片第 48 键来自 `1795500000000-RiskWithdrawReAuthSeed.ts`、
 *  设备绑定片第 49 键来自 `1795600000000-RiskDeviceBindingSeed.ts`；顺序随意，list() 不承诺顺序）。 */
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
  ['currency.signupGrant', 0], // 货币核心第 11 键：种子 0（默认不赠送）
  ['room.freeRoomEnabled', true], // 金币场第 12 键：免费场保持现状开
  ['room.goldRoomEnabled', true], // 金币场第 13 键：默认开（2026-10-04 用户裁决；原默认关/暗上线）
  ['currency.entryMultiplier', 10], // 金币场第 14 键：门槛 = 底分 × 10
  ['currency.rakePercent', 0], // 金币场第 15 键：零和起点
  ['currency.reliefEnabled', false], // 金币场第 16 键：救助默认关
  ['currency.reliefAmount', 200], // 金币场第 17 键：200 > 最低档门槛 150
  // 风控片 T1（第 18–25 键；来自 1790000001000-RiskConfigSeed.ts）
  ['risk.predicate.sameDevice', false], // 谓词默认关
  ['risk.predicate.sameIp', false], // 谓词默认关
  ['risk.winRateThreshold', 0.8], // 胜率线（K5）
  ['risk.minGames', 100], // 最少局数
  ['risk.deviceLimit', 3], // 单设备关联账号上限
  ['risk.deviceWindowDays', 30], // 设备扫描窗口天数
  ['risk.autoThrottle', true], // 命中自动限流
  ['risk.deviceRetentionDays', 365], // 设备记录保留天数
  // 支付片 T5（第 26–34 键；来自 1791000001000-PayConfigSeed.ts，规格 §2.5 九键逐字表）
  ['pay.rechargeEnabled', false], // 暗上线（只挡新建单）
  ['pay.withdrawEnabled', false], // 暗上线（只挡新建）
  ['pay.coinPerYuan', 100], // 1 元 = 100 金币（下单快照）
  ['pay.rechargePackages', [6, 30, 68, 128, 328]], // 档位（元）
  ['pay.withdrawMinCoins', 1000], // 提现门槛
  ['pay.withdrawMaxCoinsPerOrder', 50000], // 单笔上限（=500 元）
  ['pay.withdrawDailyMaxCoins', 100000], // 单日/人上限（=1000 元）
  ['pay.orderExpireMinutes', 30], // 订单有效期
  ['pay.withdrawTimeoutMinutes', 4320], // 超时回滚 72h（测试注入用 1）
  // 节奏/清理片 T2（第 35–40 键；来自 1794000000000-IntervalConfigSeed.ts，规格 ⚙️1 六键逐字表）
  ['pay.scanIntervalMs', 60000], // 支付扫描周期 60s（八条补偿循环统一节奏）
  ['pay.reconcileIntervalMs', 86400000], // 支付日自检 24h（入账勾稽 + 锚勾稽）
  ['currency.reconcileIntervalMs', 3600000], // 货币对账周期 1h
  ['risk.scanIntervalMs', 3600000], // 风控扫描周期 1h
  ['risk.devicesCleanupIntervalMs', 3600000], // 风控设备记录清理周期 1h
  ['record.cleanupIntervalMs', 3600000], // 对局记录保留期清理周期 1h
  // 广告片 T2（第 41 键；来自 1795100000000-AdReliefAdpidSeed.ts，值 '""' ⇒ 空串——string 种子首例）
  ['ad.reliefAdpid', ''], // 空串 = 未配置（暗上线：救助入口不渲染）
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
  ['risk.deviceBindingEnabled', false], // 单账号设备绑定总开关（登录 + WS 握手双闸）
  // 记牌器片（第 50 键；来自 `1795700000000-CardCounterSeed.ts`，true = 保持现状）
  ['game.cardCounterEnabled', true],
  // 记牌器收费片（第 51/52 键；来自 `CardCounterPrices1795800000000`，10/100 = 首发价）
  ['game.cardCounterPricePerGameCoins', 10],
  ['game.cardCounterPricePerHourCoins', 100],
  // 多玩法（Task 5.1；来自 `MultiGameConfigSeed1796400000000`；值 = DEFAULT_PDK_RULES / 文档默认表）
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
  ['game.paodekuai.twoPlayerEnabled', false],
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
  ['game.doudizhu.enabled', true],
  // 配置平行化（2026-10-24；来自 `SplitGameConfig1796600000000`）
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
  // 跑得快风控（2026-10-25；来自 `PdkRiskConfigSeed1796700000000`）
  ['game.paodekuai.risk.winRateThreshold', 0.8],
  ['game.paodekuai.risk.minGames', 100],
  // 跑得快按人数风控 + 自动限流（2026-10-26；来自 `PdkRiskPlayerCountSeed1796900000000`）
  ['game.paodekuai.risk.player2.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player2.minGames', 100],
  ['game.paodekuai.risk.player3.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player3.minGames', 100],
  ['game.paodekuai.risk.player4.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player4.minGames', 100],
  ['game.paodekuai.risk.autoThrottleScore', 50],
  ['currency.reliefThresholdCoins', 150],

];

const FRIEND_KEY = 'game.doudizhu.friendRoomEnabled';

function seed(db: FakeDb): void {
  for (const [key, value] of SEED) {
    db.rows.set(key, { value, version: 1, updatedAt: 'seed', updatedBy: 'seed' });
  }
}

function createRedisDouble() {
  return { publish: vi.fn(async () => 1) };
}

function makeRepo(db: FakeDb) {
  const find = vi.fn(async () => [...db.rows.entries()].map(([key, r]) => ({ key, ...r })));
  const findOne = vi.fn(async (opts: { where: { key: string } }) => {
    const r = db.rows.get(opts.where.key);
    return r ? { key: opts.where.key, ...r } : null;
  });
  const transaction = <T>(cb: (em: unknown) => Promise<T>): Promise<T> =>
    db.transaction(cb as (em: FakeEm) => Promise<T>);
  return { find, findOne, manager: { transaction } };
}

function makeService(db: FakeDb) {
  const repo = makeRepo(db);
  const redis = createRedisDouble();
  const svc = new PlatformConfigService(repo as never, redis as never);
  return { svc, db, repo, redis };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('PlatformConfigService（规格 §2.1 / A6）', () => {
  it('① list() 首查命中一百键：{key,value,version}、version 全 1、值逐字 = §2.2；且**每次查库不缓存**', async () => {
    const { svc, db, repo } = makeService(new FakeDb());
    seed(db);

    const rows = await svc.list();

    expect(rows).toHaveLength(100);
    // SEED 与 CONFIG_KEYS 同步为 100 键（含跑得快 2 人闸、风控两键与按人数/自动限流 7 键）。
    expect(rows.map((r) => r.key).sort()).toEqual(SEED.map(([key]) => key).sort());
    for (const r of rows) {
      expect(r.version).toBe(1);
      expect(r).toHaveProperty('value');
    }
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    expect(byKey.get('room.friendRoomEnabled')).toBe(false); // 裁决 8：默认关
    expect(byKey.get('robot.skillDistribution')).toEqual({
      beginner: 0.15,
      intermediate: 0.35,
      advanced: 0.5,
    });
    expect(byKey.get('game.baseScoreLevels')).toEqual(SEED[8]![1]);
    expect(byKey.get('record.retentionDays')).toBe(365); // 记录片第 10 键：种子 365
    expect(byKey.get('currency.signupGrant')).toBe(0); // 货币核心第 11 键：种子 0（默认不赠送）
    // 金币场第 12–17 键：种子值逐字（§1.1 表）
    expect(byKey.get('room.freeRoomEnabled')).toBe(true); // 免费场保持现状开
    expect(byKey.get('room.goldRoomEnabled')).toBe(true); // 默认开（2026-10-04 用户裁决）
    expect(byKey.get('currency.entryMultiplier')).toBe(10);
    expect(byKey.get('currency.rakePercent')).toBe(0);
    expect(byKey.get('currency.reliefEnabled')).toBe(false);
    expect(byKey.get('currency.reliefAmount')).toBe(200);
    // 风控第 18–25 键：种子值逐字（§2.1-3 表）
    expect(byKey.get('risk.predicate.sameDevice')).toBe(false);
    expect(byKey.get('risk.predicate.sameIp')).toBe(false);
    expect(byKey.get('risk.winRateThreshold')).toBe(0.8);
    expect(byKey.get('risk.minGames')).toBe(100);
    expect(byKey.get('risk.deviceLimit')).toBe(3);
    expect(byKey.get('risk.deviceWindowDays')).toBe(30);
    expect(byKey.get('risk.autoThrottle')).toBe(true);
    expect(byKey.get('risk.deviceRetentionDays')).toBe(365);
    // 支付第 26–34 键：种子值逐字（§2.5 表）
    expect(byKey.get('pay.rechargeEnabled')).toBe(false); // 暗上线
    expect(byKey.get('pay.withdrawEnabled')).toBe(false); // 暗上线
    expect(byKey.get('pay.coinPerYuan')).toBe(100);
    expect(byKey.get('pay.rechargePackages')).toEqual([6, 30, 68, 128, 328]);
    expect(byKey.get('pay.withdrawMinCoins')).toBe(1000);
    expect(byKey.get('pay.withdrawMaxCoinsPerOrder')).toBe(50000);
    expect(byKey.get('pay.withdrawDailyMaxCoins')).toBe(100000);
    expect(byKey.get('pay.orderExpireMinutes')).toBe(30);
    expect(byKey.get('pay.withdrawTimeoutMinutes')).toBe(4320);
    // 节奏/清理第 35–40 键：种子值逐字（规格 ⚙️1 表）
    expect(byKey.get('pay.scanIntervalMs')).toBe(60000); // 支付扫描周期 60s
    expect(byKey.get('pay.reconcileIntervalMs')).toBe(86400000); // 支付日自检 24h
    expect(byKey.get('currency.reconcileIntervalMs')).toBe(3600000); // 货币对账周期 1h
    expect(byKey.get('risk.scanIntervalMs')).toBe(3600000); // 风控扫描周期 1h
    expect(byKey.get('risk.devicesCleanupIntervalMs')).toBe(3600000); // 风控设备记录清理周期 1h
    expect(byKey.get('record.cleanupIntervalMs')).toBe(3600000); // 对局记录保留期清理周期 1h
    // 广告片第 41 键：种子值逐字（空串 = 未配置；string 种子首例）
    expect(byKey.get('ad.reliefAdpid')).toBe('');

    // 不缓存：两次调用 ⇒ 两次查库（否则「后台改了要生效」会变成「改了要重启」）
    await svc.list();
    expect(repo.find).toHaveBeenCalledTimes(2);
  });

  it('①′ get(key)：命中 ⇒ {value,version}；缺失 ⇒ null', async () => {
    const { svc, db } = makeService(new FakeDb());
    seed(db);

    await expect(svc.get(FRIEND_KEY)).resolves.toEqual({ value: false, version: 1 });
    await expect(svc.get('robot.ruleFallback')).resolves.toEqual({ value: true, version: 1 });
  });

  it('② set() 首写：先锁定读（无行 ⇒ old=NULL）再 UPDATE（affected=0）再 INSERT 自 version 1 + 留痕行；updated_by 落库；publish 恰一次', async () => {
    const { svc, db, redis } = makeService(new FakeDb());

    const res = await svc.set(FRIEND_KEY, true, 'admin:alice');

    expect(res).toEqual({ version: 1, announced: true });
    expect(db.updateCalls).toBe(1); // 先试 UPDATE（首建应不命中）
    expect(db.insertCalls).toBe(1); // 再 INSERT
    expect(db.rows.get(FRIEND_KEY)).toMatchObject({
      value: true,
      version: 1,
      updatedBy: 'admin:alice', // `updated_by = actor`（§2.6）
    });
    // 留痕首建态：oldValue = NULL（行此前不存在）、newValue = 归一后值、actor = updatedBy
    expect(db.changes).toEqual([
      { key: FRIEND_KEY, oldValue: null, newValue: true, actor: 'admin:alice' },
    ]);
    // 语句序逐字（§2.6）：① 锁定读 → ② 更新/插入 → ③ 留痕
    expect(db.ops).toEqual(['lock', 'update', 'insert', 'change']);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledWith(
      CONFIG_CHANGED_CHANNEL,
      JSON.stringify({ keys: [FRIEND_KEY] }),
    );

    // list 可见新值
    const rows = await svc.list();
    expect(rows.find((r) => r.key === FRIEND_KEY)).toMatchObject({ value: true, version: 1 });
  });

  it('②′ set() 既有行：留痕行 {oldValue=旧值, newValue=归一值, actor}；锁定读在 UPDATE 之前', async () => {
    const { svc, db } = makeService(new FakeDb());
    seed(db);

    await svc.set(FRIEND_KEY, true, 'operator.bob');

    expect(db.changes).toEqual([
      { key: FRIEND_KEY, oldValue: false, newValue: true, actor: 'operator.bob' }, // 旧值 = 种子 false
    ]);
    expect(db.rows.get(FRIEND_KEY)).toMatchObject({ value: true, version: 2, updatedBy: 'operator.bob' });
    expect(db.ops).toEqual(['lock', 'update', 'find', 'change']); // 锁定读先于 UPDATE，留痕在事务尾
  });

  it('②″ 锁定读 SQL 常量全文逐字（单测按全文相等钉，照 reconcile 先例；v1.1.6：key 反引号——MySQL 保留字）', () => {
    expect(CONFIG_LOCK_SQL).toBe(
      'SELECT value, version FROM platform_config WHERE `key`=? FOR UPDATE',
    );
    // 同族：留痕 INSERT 的 `key` 列同为保留字，同样必须反引号（假库按常量身份分派、测不出解析错——
    // 真栈回归（report §6）是这条的实弹；此处钉字面防再漂移）
    expect(CONFIG_CHANGES_INSERT_SQL).toBe(
      'INSERT INTO config_changes (`key`, old_value, new_value, actor) VALUES (?, ?, ?, ?)',
    );
  });

  it('③ 并发首建同键：两次 set 都成功、version 严格递增（1 → 2）、只落一行', async () => {
    const { svc, db } = makeService(new FakeDb());

    const [a, b] = await Promise.all([
      svc.set(FRIEND_KEY, true, 'admin:a'),
      svc.set(FRIEND_KEY, false, 'admin:b'),
    ]);

    expect([a.announced, b.announced]).toEqual([true, true]);
    expect([a.version, b.version].sort((x, y) => x - y)).toEqual([1, 2]);
    const row = db.rows.get(FRIEND_KEY)!;
    expect(row.version).toBe(2);
    expect(db.rows.size).toBe(1);
    // 终值 = 拿到版本 2 的那次的值（无撕裂：版本与值同一次写入）
    const pairs = [
      { value: true, version: a.version },
      { value: false, version: b.version },
    ];
    expect(row.value).toBe(pairs.find((p) => p.version === row.version)!.value);
    // 留痕链自洽（§2.6；两行按提交序）：null→v1 值、v1 值→v2 值、末行 newValue = 行终值
    expect(db.changes).toHaveLength(2);
    expect(db.changes[0]!.oldValue).toBeNull();
    expect(db.changes[1]!.oldValue).toEqual(db.changes[0]!.newValue);
    expect(db.changes[1]!.newValue).toBe(row.value);
    expect([db.changes[0]!.actor, db.changes[1]!.actor].sort()).toEqual(['admin:a', 'admin:b']);
  });

  it('③′ 并发首建的另一种交错（UPDATE=0 + INSERT 撞唯一键）⇒ 重试一次 UPDATE（唯一键冲突兜底）+ 留痕仍落一行', async () => {
    // 脚本化替身：精确复刻「对手抢先 INSERT」后的可见序列。
    const recordedChanges: FakeChangeRecord[] = [];
    const em = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql === CONFIG_LOCK_SQL) return []; // 交错读：锁定读时两边的行都还不可见
        if (sql === CONFIG_CHANGES_INSERT_SQL) {
          const [key, oldValue, newValue, actor] = params as [string, string | null, string, string];
          recordedChanges.push({
            key,
            oldValue: oldValue === null ? null : JSON.parse(oldValue),
            newValue: JSON.parse(newValue),
            actor,
          });
          return { insertId: recordedChanges.length };
        }
        throw new Error(`未识别的 SQL：${sql}`);
      }),
      update: vi
        .fn()
        .mockResolvedValueOnce({ affected: 0 }) // 首个 UPDATE：键尚不存在
        .mockResolvedValueOnce({ affected: 1 }), // 冲突重试的 UPDATE：对手已插入 ⇒ 命中
      insert: vi.fn().mockRejectedValueOnce(duplicateKeyError(FRIEND_KEY)),
      findOne: vi.fn().mockResolvedValue({ key: FRIEND_KEY, value: true, version: 2 }),
    };
    const repo = {
      manager: { transaction: (cb: (e: unknown) => Promise<unknown>) => cb(em) },
      find: vi.fn(),
      findOne: vi.fn(),
    };
    const redis = createRedisDouble();
    const svc = new PlatformConfigService(repo as never, redis as never);

    await expect(svc.set(FRIEND_KEY, true, 'admin:a')).resolves.toEqual({
      version: 2,
      announced: true,
    });
    expect(em.insert).toHaveBeenCalledTimes(1);
    expect(em.update).toHaveBeenCalledTimes(2); // 首 UPDATE + 冲突重试
    expect(em.query).toHaveBeenCalledWith(CONFIG_LOCK_SQL, [FRIEND_KEY]);
    // 交错路径的留痕：读时无行 ⇒ oldValue NULL（下一行的链修补是 slice-19 的真库判据，S7）
    expect(recordedChanges).toEqual([
      { key: FRIEND_KEY, oldValue: null, newValue: true, actor: 'admin:a' },
    ]);
  });

  it('④ 同键并发两写（Promise.all）：version = v0+2、终值 = 较高版本的那次（C13 单测半边）', async () => {
    const { svc, db, redis } = makeService(new FakeDb());
    seed(db);
    const v0 = db.rows.get(FRIEND_KEY)!.version;

    const [a, b] = await Promise.all([
      svc.set(FRIEND_KEY, true, 'admin:a'),
      svc.set(FRIEND_KEY, false, 'admin:b'),
    ]);

    expect([a.announced, b.announced]).toEqual([true, true]);
    expect([a.version, b.version].sort((x, y) => x - y)).toEqual([v0 + 1, v0 + 2]);
    const row = db.rows.get(FRIEND_KEY)!;
    expect(row.version).toBe(v0 + 2);
    // 无撕裂：终值必须来自「版本 = 终版本」的那一次写入
    const pairs = [
      { value: true, version: a.version },
      { value: false, version: b.version },
    ];
    expect(row.value).toBe(pairs.find((p) => p.version === row.version)!.value);
    // 留痕链自洽：首行 oldValue = 种子值，逐行 old == 前行 new，末行 new == 行终值
    expect(db.changes).toHaveLength(2);
    expect(db.changes[0]!.oldValue).toBe(false); // 种子值
    expect(db.changes[1]!.oldValue).toEqual(db.changes[0]!.newValue);
    expect(db.changes[1]!.newValue).toBe(row.value);
    // 两次写各自成功 ⇒ 各自广播（消费侧靠它立刻重载）
    expect(redis.publish).toHaveBeenCalledTimes(2);
  });

  it('⑤ publish 抛错 ⇒ {announced:false} + WARN 日志；值**已落库**（C12：写不因发布失败回滚）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, db, redis } = makeService(new FakeDb());
    seed(db);
    redis.publish.mockRejectedValueOnce(new Error('redis down'));

    const res = await svc.set(FRIEND_KEY, true, 'admin:a');

    expect(res).toEqual({ version: 2, announced: false });
    expect(db.rows.get(FRIEND_KEY)).toMatchObject({ value: true, version: 2 });
    expect(db.changes).toHaveLength(1); // 留痕随写事务已落库（发布失败不回滚写）
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish failed'));
  });

  it('⑥ 未知键 / 非法值 ⇒ ProtocolError 且**不落任何行**（C5 半边：校验在落库之前；含留痕与锁定读）', async () => {
    const { svc, db, redis } = makeService(new FakeDb());
    seed(db);

    await expect(svc.set('nope.key' as never, 1, 'admin:a')).rejects.toThrow(ProtocolError);
    await expect(svc.set(FRIEND_KEY, 'true' as never, 'admin:a')).rejects.toThrow(ProtocolError);

    // 判别力：事务都没开（连锁定读都没有）、四十四行原样、无留痕、无广播
    expect(db.updateCalls).toBe(0);
    expect(db.insertCalls).toBe(0);
    expect(db.ops).toEqual([]);
    expect(db.changes).toEqual([]);
    expect(db.rows.get(FRIEND_KEY)).toMatchObject({ value: false, version: 1 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('⑦ 归一化落库：份额 15/35/50 ⇒ 存占比 0.15/0.35/0.5（§2.2 口径）', async () => {
    const { svc, db } = makeService(new FakeDb());

    await svc.set(
      'game.doudizhu.robot.skillDistribution',
      { beginner: 15, intermediate: 35, advanced: 50 },
      'admin:a',
    );

    expect(db.rows.get('game.doudizhu.robot.skillDistribution')!.value).toEqual({
      beginner: 0.15,
      intermediate: 0.35,
      advanced: 0.5,
    });
  });

  it('⑧ 客户端接入两键（第 43/44 键）写面：true↔false 双向写成功、version 递增、留痕 key/old/new/actor（C4 三子性质；种子首验收）', async () => {
    const { svc, db } = makeService(new FakeDb());
    seed(db);

    // 种子 = 双 true（暗上线全开）；每键各走一遍「关（true→false）→ 开（false→true）」双向
    for (const key of ['client.appEnabled', 'client.h5Enabled'] as const) {
      expect(db.rows.get(key)).toMatchObject({ value: true, version: 1 });

      await expect(svc.set(key, false, 'operator.cli')).resolves.toEqual({
        version: 2,
        announced: true,
      });
      await expect(svc.set(key, true, 'operator.cli')).resolves.toEqual({
        version: 3,
        announced: true,
      });

      // 终态：值/version/updated_by 同一次状态变化（version 递增 1→2→3，相对自增不丢版本）
      expect(db.rows.get(key)).toMatchObject({ value: true, version: 3, updatedBy: 'operator.cli' });
    }

    // 留痕（同事务，§2.6）：四行、old/new 链与 actor 逐字（FakeEm 按 mysql2 形态往返：JSON 串进、解析值出）
    expect(db.changes).toEqual([
      { key: 'client.appEnabled', oldValue: true, newValue: false, actor: 'operator.cli' },
      { key: 'client.appEnabled', oldValue: false, newValue: true, actor: 'operator.cli' },
      { key: 'client.h5Enabled', oldValue: true, newValue: false, actor: 'operator.cli' },
      { key: 'client.h5Enabled', oldValue: false, newValue: true, actor: 'operator.cli' },
    ]);
  });

  it('⑧′ 客户端接入两键：非 bool（字符串 true / 数字 1 / null）⇒ ProtocolError 且不落任何行（⇒ HTTP 面 400 语义）', async () => {
    const { svc, db, redis } = makeService(new FakeDb());
    seed(db);

    for (const key of ['client.appEnabled', 'client.h5Enabled'] as const) {
      await expect(svc.set(key, 'true' as never, 'admin:a')).rejects.toThrow(ProtocolError);
      await expect(svc.set(key, 1 as never, 'admin:a')).rejects.toThrow(ProtocolError);
      await expect(svc.set(key, null as never, 'admin:a')).rejects.toThrow(ProtocolError);
    }

    // 判别力：事务都没开（连锁定读都没有）、两行原样（值 + version）、无留痕、无广播
    expect(db.updateCalls).toBe(0);
    expect(db.insertCalls).toBe(0);
    expect(db.ops).toEqual([]);
    expect(db.changes).toEqual([]);
    expect(db.rows.get('client.appEnabled')).toMatchObject({ value: true, version: 1 });
    expect(db.rows.get('client.h5Enabled')).toMatchObject({ value: true, version: 1 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  /**
   * 2026-10-21（台费并入档位表）：
   *  - D13：旧形态档位表（全部条目缺 entryFeePercent）在 parse 之前拒绝，
   *    否则旧 admin 页面保存会静默清零费率。（阶段 2 已删除旧费率键与其 D14 守卫。）
   */
  it('D13：档位表全部条目缺 entryFeePercent（旧形态）⇒ 拒绝且先于 parse（零库操作）', async () => {
    const { svc, db } = makeService(new FakeDb());
    seed(db);

    // 刻意用「重复 baseScore」：若守卫在 parse 之后，会先报「唯一」而不是 entryFeePercent
    await expect(
      svc.set(
        'game.levels.doudizhu',
        [
          { name: 'A', baseScore: 15 },
          { name: 'B', baseScore: 15 },
        ],
        'admin:a',
      ),
    ).rejects.toThrow(/entryFeePercent/);

    expect(db.ops).toEqual([]);
    expect(db.updateCalls).toBe(0);
    expect(db.insertCalls).toBe(0);
    expect(db.changes).toEqual([]);
  });

  it('D13 正半边：任一条目带 entryFeePercent ⇒ 落库；缺字段条目保持缺省（读回不含自有属性）', async () => {
    const { svc, db } = makeService(new FakeDb());
    seed(db);
    const levels = [
      { name: 'A', baseScore: 15, entryFeePercent: 10 },
      { name: 'B', baseScore: 80 },
    ];

    await expect(svc.set('game.levels.doudizhu', levels, 'admin:a')).resolves.toMatchObject({
      version: 2,
    });
    const got = await svc.get('game.levels.doudizhu');
    // 严格相等：缺字段条目不得多出 `entryFeePercent: undefined` 自有属性
    expect(got?.value).toStrictEqual(levels);
  });

  it('配置平行化：旧平台键写入一律 ProtocolError（已废弃）且零库操作', async () => {
    const { svc, db, redis } = makeService(new FakeDb());
    seed(db);

    for (const key of [
      'room.friendRoomEnabled',
      'room.freeRoomEnabled',
      'currency.entryMultiplier',
      'game.baseScoreLevels',
      'robot.skillDistribution',
      'risk.winRateThreshold',
    ] as const) {
      await expect(svc.set(key, true, 'admin:a'), key).rejects.toThrow(/已废弃/);
    }

    expect(db.ops).toEqual([]);
    expect(db.updateCalls).toBe(0);
    expect(db.insertCalls).toBe(0);
    expect(db.changes).toEqual([]);
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
