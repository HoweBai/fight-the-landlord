/**
 * `currency.withdrawable.get` 的行为面 —— 支付片 T4（规格 §2.2 契约 / §2.2.1 公式与演算表**逐行**）。
 *
 * ─── 覆盖 ────────────────────────────────────────────────────────────────
 *  ①–⑤ = 规格 §2.2.1 演算表逐行（充值/救助/净输/净赢/退款）；⑥–⑧ = clamp 边界
 *  （cap_raw 负 ⇒ 0；`admin_adjust` 负扣减 ⇒ `min(balance)` 兜底；不入 6 源集合的来源只影响余额）；
 *  六源全集合（refund_rollback / withdraw_hold / withdraw_rollback 的往返）；
 *  `cap ≤ balance` 不变式全表逐例；无账户 ⇒ {0,0} 且不建行不写缓存；
 *  读取面（balance = `currency.get` 同源读：缓存优先/读穿；cap_raw = 单条 JOIN 聚合，
 *  参数 = [ownerId, ...6 源（规格次序）]，SQL 由假库**全文相等**识别）；
 *  校验矩阵（ProtocolError 中文 + 零 IO）；系统级故障/驱动回执畸形 ⇒ **抛**（响应无信封通道，
 *  调用方按纪律 fail-closed）；接收侧接线（pattern 逐字 / 直透平形状 / AppModule 注册面）。
 *
 * ─── 夹具 ────────────────────────────────────────────────────────────────
 *  - **假 DB**（`helpers/fake-currency-db.ts`）：余额单行读 + **cap_raw 聚合**（全文相等识别）；
 *  - **假 Redis**：真存储（balance 读穿写缓存）+ 调用序记录；
 *  - `GetService` 用真实现（withdrawable 的 balance 就是**它**读出来的 —— 同源读的判据面）。
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import {
  ProtocolError,
  RPC_PATTERNS,
  type CurrencyWithdrawableGetRequest,
} from '@fight-the-landlord/protocol';
import { GetService } from '../src/apply/get.service';
import { WithdrawableService } from '../src/currency/withdrawable.service';
import { WithdrawableRpcController } from '../src/rpc/withdrawable.rpc.controller';
import { AppModule } from '../src/app.module';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** Nest 内部的 pattern 元数据键（`@nestjs/microservices/constants` 的 `PATTERN_METADATA`）。 */
const PATTERN_METADATA = 'microservices:pattern';

const OWNER = 'u-withdraw';
/** 余额缓存键（⚙️4 逐字）。 */
const BALANCE_CACHE_KEY = `currency:balance:${OWNER}`;

/**
 * 规格 §2.2.1 的 6 源集合（**测试侧独立持有的字面量** —— 参数次序判据，不从实现导入）。
 */
const SPEC_SOURCES = [
  'recharge',
  'game_settle',
  'refund_hold',
  'refund_rollback',
  'withdraw_hold',
  'withdraw_rollback',
] as const;

interface SeedFlow {
  source: string;
  delta: number;
}

interface CalcRow {
  n: string;
  name: string;
  /** 场景终态余额（与 flows 的自然和一致；⑥/⑦ 例外是「余额被排除源/净输改变」的语义点）。 */
  balance: number;
  flows: SeedFlow[];
  cap: number;
  note: string;
}

/**
 * 演算表：①–⑤ = 规格 §2.2.1 逐行；⑥–⑧ = 边界（clamp 负、min 兜底、排除源）。
 * 每行种一个「已提交的 op+flow 组合」+ 终态余额行。
 */
const CALC_TABLE: CalcRow[] = [
  {
    n: '①',
    name: '充值 600，未动',
    balance: 600,
    flows: [{ source: 'recharge', delta: 600 }],
    cap: 600,
    note: '正常',
  },
  {
    n: '②',
    name: '充值 600 + 救助 200，未动',
    balance: 800,
    flows: [
      { source: 'recharge', delta: 600 },
      { source: 'relief_grant', delta: 200 },
    ],
    cap: 600,
    note: '救助沉淀，不可离场',
  },
  {
    n: '③',
    name: '充值 600 + 救助 200，净输 150',
    balance: 650,
    flows: [
      { source: 'recharge', delta: 600 },
      { source: 'relief_grant', delta: 200 },
      { source: 'game_settle', delta: -150 },
    ],
    cap: 450,
    note: '输先垫白来的钱，额度按净额收缩',
  },
  {
    n: '④',
    name: '无充值 + 救助 200，净赢 300',
    balance: 500,
    flows: [
      { source: 'relief_grant', delta: 200 },
      { source: 'game_settle', delta: 300 },
    ],
    cap: 300,
    note: '赢取可提（机器人局=池钱 ⇒ 设计 §14 R5）',
  },
  {
    n: '⑤',
    name: '充值 600，已退 600',
    balance: 0,
    flows: [
      { source: 'recharge', delta: 600 },
      { source: 'refund_hold', delta: -600 },
    ],
    cap: 0,
    note: '冻结/回滚按自然符号计入',
  },
  {
    n: '⑥',
    name: 'clamp：充值 100 + 净输 300 + 救助 400（cap_raw −200）',
    balance: 200,
    flows: [
      { source: 'recharge', delta: 100 },
      { source: 'game_settle', delta: -300 },
      { source: 'relief_grant', delta: 400 },
    ],
    cap: 0,
    note: 'cap_raw 负 ⇒ 0',
  },
  {
    n: '⑦',
    name: 'clamp：充值 600 + admin_adjust −500（cap_raw 600 > 余额 100）',
    balance: 100,
    flows: [
      { source: 'recharge', delta: 600 },
      { source: 'admin_adjust', delta: -500 },
    ],
    cap: 100,
    note: 'min(balance) 兜底 ⇒ cap = balance',
  },
  {
    n: '⑧',
    name: '不入集：signup_grant 1000 单独',
    balance: 1000,
    flows: [{ source: 'signup_grant', delta: 1000 }],
    cap: 0,
    note: '赠送不可离场（只影响余额，不上调与不下调额度）',
  },
];

/** 种一个演算表场景：余额行 + 各源一笔「已提交」op/flow。 */
function seed(db: FakeCurrencyDb, row: Pick<CalcRow, 'n' | 'balance' | 'flows'>): void {
  db.seedAccount(OWNER, 'user', row.balance);
  row.flows.forEach((flow, i) => {
    db.seedCommittedOp(
      { actionId: `t4:${row.n}:${i}`, requestHash: `h-${row.n}-${i}`, source: flow.source },
      [{ ownerId: OWNER, delta: flow.delta, balanceAfter: row.balance }],
    );
  });
}

describe('currency.withdrawable.get（支付片 T4；规格 §2.2.1 公式逐字）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let getService: GetService;
  let service: WithdrawableService;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    getService = new GetService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    service = new WithdrawableService(getService, db.dataSource as unknown as DataSource);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── 演算表逐行（`it` 由表格逐行生成 = 「逐行」的机械表达）────────────────

  for (const row of CALC_TABLE) {
    it(`${row.n} ${row.name} ⇒ cap=${row.cap}（${row.note}）`, async () => {
      seed(db, row);

      const res = await service.get({ ownerId: OWNER });

      expect(res).toEqual({ cap: row.cap, balance: row.balance });
      expect(res.cap).toBeLessThanOrEqual(res.balance); // min 结构不变式（逐例）
      expect(res.cap).toBeGreaterThanOrEqual(0);
    });
  }

  it('六源全集合 · 提现冻结→回滚往返：半程 cap 0（钱冻结中），回滚落账后恢复 600', async () => {
    // 半程：recharge 600 + withdraw_hold −600（已确认落账 ⇒ 余额 0）。
    db.seedAccount(OWNER, 'user', 0);
    db.seedCommittedOp({ actionId: 't4:wd:0', requestHash: 'h-wd-0', source: 'recharge' }, [
      { ownerId: OWNER, delta: 600, balanceAfter: 600 },
    ]);
    db.seedCommittedOp({ actionId: 't4:wd:1', requestHash: 'h-wd-1', source: 'withdraw_hold' }, [
      { ownerId: OWNER, delta: -600, balanceAfter: 0 },
    ]);

    const half = await service.get({ ownerId: OWNER });
    expect(half).toEqual({ cap: 0, balance: 0 });
    expect(half.cap).toBeLessThanOrEqual(half.balance);

    // 回滚落账（withdraw_rollback +600）⇒ 余额 600、额度恢复。缓存键由 apply 写穿/对账自愈
    // 维系，本用例手动同步（缓存语义归 get.test，这里只测 withdrawable 的取数）。
    db.seedCommittedOp({ actionId: 't4:wd:2', requestHash: 'h-wd-2', source: 'withdraw_rollback' }, [
      { ownerId: OWNER, delta: 600, balanceAfter: 600 },
    ]);
    db.seedAccount(OWNER, 'user', 600);
    redis.store.delete(BALANCE_CACHE_KEY);

    const back = await service.get({ ownerId: OWNER });
    expect(back).toEqual({ cap: 600, balance: 600 });
  });

  it('六源全集合 · 退款失败回滚：recharge +600 / refund_hold −600 / refund_rollback +600 ⇒ cap 600', async () => {
    seed(db, {
      n: '⑨',
      balance: 600,
      flows: [
        { source: 'recharge', delta: 600 },
        { source: 'refund_hold', delta: -600 },
        { source: 'refund_rollback', delta: 600 },
      ],
    });

    await expect(service.get({ ownerId: OWNER })).resolves.toEqual({ cap: 600, balance: 600 });
  });

  it('无账户 ⇒ {cap:0, balance:0}；不建行、不写缓存（读路径纪律，同 currency.get）', async () => {
    const res = await service.get({ ownerId: 'ghost-x' });

    expect(res).toEqual({ cap: 0, balance: 0 });
    expect(db.accounts.size).toBe(0); // 读路径绝不 INSERT
    expect(redis.store.size).toBe(0); // exists=false 不写缓存（自造对账漂移）
    // 两条读都真的发出（问过库、只是没有）：先 balance（同源读）→ 后 cap_raw。
    expect(db.directQueries.map((q) => (q.sql.startsWith('SELECT `balance`') ? 'balance' : 'cap_raw'))).toEqual([
      'balance',
      'cap_raw',
    ]);
  });

  it('不变式 `cap ≤ balance`：全表演算逐例（+ cap ≥ 0）', async () => {
    for (const row of CALC_TABLE) {
      const freshDb = new FakeCurrencyDb();
      const freshRedis = new FakeRedis();
      const svc = new WithdrawableService(
        new GetService(freshDb.dataSource as unknown as DataSource, freshRedis as unknown as Redis),
        freshDb.dataSource as unknown as DataSource,
      );
      seed(freshDb, row);

      const res = await svc.get({ ownerId: OWNER });
      expect(res.cap, `${row.n} ${row.name}`).toBeLessThanOrEqual(res.balance);
      expect(res.cap, `${row.n} ${row.name}`).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── 读取面（同源读 + cap_raw SQL 形状/参数）──────────────────────────────

  it('读取面：balance = `currency.get` 同源读（miss 回源 + 读穿写缓存）；cap_raw = 单条聚合，参数 = [ownerId, ...6 源（规格次序）]', async () => {
    seed(db, CALC_TABLE[0]!); // ① 充值 600

    await service.get({ ownerId: OWNER });

    // 恰两条直读、顺序固定：先余额（GetService 的读穿）→ 后 cap_raw。
    expect(db.directQueries).toHaveLength(2);
    const [balanceQ, capQ] = db.directQueries;
    expect(balanceQ!.sql).toBe('SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?');
    expect(balanceQ!.params).toEqual([OWNER]);
    // cap_raw 的 SQL 形状由假库**全文相等**识别（漂移一个字符 ⇒ reject ⇒ 本用例红）；
    // 参数次序钉规格（ownerId + 6 源**按 §2.2.1 集合的次序**）。
    expect(capQ!.params).toEqual([OWNER, ...SPEC_SOURCES]);
    // 读穿写缓存：余额与 currency.get **同源**（同一份缓存/回源逻辑）。
    expect(redis.store.get(BALANCE_CACHE_KEY)).toBe('600');
    // 读路径不建行（只有种子那一行）。
    expect(db.accounts.size).toBe(1);
  });

  it('balance 同源读的缓存面：缓存命中 ⇒ 余额不回源（只发 cap_raw 一条）', async () => {
    seed(db, CALC_TABLE[0]!);
    redis.store.set(BALANCE_CACHE_KEY, '600'); // 命中（值故意=库值；命中语义由 get.test 全列覆盖）

    const res = await service.get({ ownerId: OWNER });

    expect(res).toEqual({ cap: 600, balance: 600 });
    expect(db.directQueries).toHaveLength(1); // 只剩 cap_raw
    expect(db.directQueries[0]!.params).toEqual([OWNER, ...SPEC_SOURCES]);
  });

  // ─── 校验（先于任何 IO）───────────────────────────────────────────────────

  it('校验矩阵：非对象/数组/缺字段/空串/超长/非法字符/非字符串 ⇒ ProtocolError 中文原因，且零 IO', async () => {
    const bads: unknown[] = [
      null,
      [],
      {},
      { ownerId: undefined },
      { ownerId: '' },
      { ownerId: 'a'.repeat(37) },
      { ownerId: 'bad id!' },
      { ownerId: 42 },
      { ownerId: '用户' },
    ];
    for (const bad of bads) {
      await expect(service.get(bad), JSON.stringify(bad)).rejects.toThrow(ProtocolError);
      await expect(service.get(bad), JSON.stringify(bad)).rejects.toThrow(/[一-鿿]/);
    }
    expect(db.directQueries).toEqual([]);
    expect(redis.calls).toEqual([]);
  });

  it('36 字符上界放行 + 合法字符集（[A-Za-z0-9_-]）全放行（正对照，防「一律拒」的假绿）', async () => {
    const okIds = ['a'.repeat(36), 'A_b-c9', '0'];
    for (const ownerId of okIds) {
      await expect(service.get({ ownerId })).resolves.toEqual({ cap: 0, balance: 0 });
    }
    // 发送侧经 `{ ownerId, ...metaFromTrace() }` 展开附加 meta（R1104 先例）——额外键不拒。
    await expect(service.get({ ownerId: OWNER, meta: { traceId: 't-4' } })).resolves.toEqual({
      cap: 0,
      balance: 0,
    });
    expect(db.directQueries.length).toBeGreaterThan(0); // 真走到读取面（不是被校验拦下）
  });

  // ─── 错误姿态（响应无信封通道 ⇒ 一律抛；调用方 fail-closed）────────────────

  it('系统级故障：cap_raw 聚合读失败 ⇒ 抛（RPC 失败 ⇒ 调用方按 §2.2.1 纪律 fail-closed 拒）', async () => {
    seed(db, CALC_TABLE[0]!);
    redis.store.set(BALANCE_CACHE_KEY, '600'); // 缓存命中 ⇒ 只让 cap_raw 那条失败
    db.directFailuresRemaining = 1;

    await expect(service.get({ ownerId: OWNER })).rejects.toThrow(/db down/);
  });

  it('驱动回执畸形 ⇒ 抛（不静默编造钱数）：cap_raw 非安全整数（NaN/小数）/ 聚合空行', async () => {
    redis.store.set(BALANCE_CACHE_KEY, '600');
    const stub = (rows: unknown) =>
      new WithdrawableService(getService, { query: async () => rows } as unknown as DataSource);

    await expect(stub([{ total: 'not-a-number' }]).get({ ownerId: OWNER })).rejects.toThrow(/不是安全整数/);
    await expect(stub([{ total: 1.5 }]).get({ ownerId: OWNER })).rejects.toThrow(/不是安全整数/);
    await expect(stub([]).get({ ownerId: OWNER })).rejects.toThrow(/空行/);
  });

  it('（防御）balance 读被 currency.get 拒 ⇒ 抛不吞（两处 ownerId 规则若漂移，响亮现形）', async () => {
    const rejecting = {
      get: async () => ({ ok: false, code: 10001, message: '规则漂移（仿真）' }),
    } as unknown as GetService;
    const svc = new WithdrawableService(rejecting, db.dataSource as unknown as DataSource);

    await expect(svc.get({ ownerId: OWNER })).rejects.toThrow(/规则漂移/);
  });
});

describe('WithdrawableRpcController（接收侧接线：pattern 逐字 / 直透平形状 / AppModule 注册面）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let service: WithdrawableService;
  let ctrl: WithdrawableRpcController;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    const getService = new GetService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    service = new WithdrawableService(getService, db.dataSource as unknown as DataSource);
    ctrl = new WithdrawableRpcController(service);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('pattern 名逐字来自 RPC_PATTERNS（不是手写字面量 —— R70：pattern 写错时替身不会失败）', () => {
    const patterns = Reflect.getMetadata(
      PATTERN_METADATA,
      WithdrawableRpcController.prototype.withdrawable,
    ) as string[] | undefined;

    // 正对照：元数据真的读到了，否则下面两条是空测。
    expect(patterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(patterns).toEqual([RPC_PATTERNS.currencyWithdrawableGet]);
    expect(RPC_PATTERNS.currencyWithdrawableGet).toBe('currency.withdrawable.get');
  });

  it('直透：成功 = 平形状 {cap,balance}（**不是** RpcResult 信封）；失败 ⇒ 抛 RpcException，**原文过线** + error 日志', async () => {
    seed(db, CALC_TABLE[0]!); // ① 充值 600

    const ok = await ctrl.withdrawable({ ownerId: OWNER });

    expect(ok).toEqual({ cap: 600, balance: 600 });
    expect('ok' in ok).toBe(false); // 平形状：§2.2 逐字的 {cap, balance}

    // 失败姿态：抛 `RpcException(message)` —— 裸抛会被 Nest 折成恒定的 "Internal server error"
    // （`base-rpc-exception-filter` 的 UNKNOWN_EXCEPTION_MESSAGE），真原因丢；翻装后中文原因过线。
    const bad = () =>
      ctrl.withdrawable({ ownerId: 'bad id!' } as unknown as CurrencyWithdrawableGetRequest);
    await expect(bad()).rejects.toThrow(RpcException);
    await expect(bad()).rejects.toThrow(/ownerId 必须是/);
    expect(errorSpy).toHaveBeenCalled(); // 响亮不静默
  });

  it('注册面（T6 教训）：AppModule.controllers 含 `WithdrawableRpcController`、providers 含 `WithdrawableService`', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];

    expect(controllers).toContain(WithdrawableRpcController);
    expect(providers).toContain(WithdrawableService);
  });
});
